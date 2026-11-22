"""Bounded supervision of the process groups created by a managed test run."""
import asyncio
import os
import pathlib
import shutil
import signal
import sys
import tempfile
import time


class RunFailed(RuntimeError):
    pass


def group_state(group):
    try:
        os.killpg(group, 0)
    except ProcessLookupError:
        return False
    # A zombie cannot consume CPU or spawn descendants. Linux can leave orphans
    # unreaped in containers, even after a successful group kill.
    if sys.platform.startswith('linux'):
        for entry in pathlib.Path('/proc').iterdir():
            if not entry.name.isdecimal():
                continue
            try:
                fields = (entry / 'stat').read_bytes().rsplit(b')', 1)[1].split()
            except (FileNotFoundError, ProcessLookupError):
                continue
            if int(fields[2]) == group and fields[0] not in (b'Z', b'X'):
                return True
        return False
    return True


def registry_groups(registry):
    def entries():
        try:
            return list(registry.iterdir())
        except FileNotFoundError:
            # A nested supervisor can retire its registry after verification.
            return []

    def group_id(name):
        if not (name.isascii() and name.isdecimal() and int(name) > 1):
            raise RuntimeError(f'invalid process ownership record: {name}')
        return int(name)

    # Observe the worker before enumerating the records it can publish. If
    # it is still live we will rescan; otherwise those records are final.
    live = set()
    for marker in entries():
        if marker.name.startswith('worker-'):
            group = group_id(marker.name.removeprefix('worker-'))
            if group_state(group):
                live.add(group)
    for marker in entries():
        if marker.name.startswith('worker-'):
            continue
        if marker.name.startswith('processes-'):
            live.update(registry_groups(marker))
        else:
            group = group_id(marker.name)
            if group_state(group):
                live.add(group)
    return live


def live_groups(root, registry):
    live = {root} if group_state(root) else set()
    return sorted(live | registry_groups(registry))


async def settle_groups(root, registry, grace, natural_exit=False):
    groups = live_groups(root, registry)
    if groups and natural_exit:
        deadline = time.monotonic() + 0.5
        while groups and time.monotonic() < deadline:
            await asyncio.sleep(0.05)
            groups = live_groups(root, registry)
    if not groups:
        return 'verified', False
    for sig, wait in ((signal.SIGTERM, grace), (signal.SIGKILL, 3)):
        deadline = time.monotonic() + wait
        signalled = set()
        while groups:
            # Rescan and signal any groups registered during cancellation.
            for group in groups:
                if group in signalled or not group_state(group):
                    continue
                try:
                    os.killpg(group, sig)
                    signalled.add(group)
                except ProcessLookupError:
                    pass
            await asyncio.sleep(0.05)
            groups = live_groups(root, registry)
            if not groups:
                return f'verified after {sig.name}', True
            if time.monotonic() >= deadline:
                break
    raise RuntimeError(f'live owned process groups: {groups}')


async def supervise(command, *, cwd, journal, cancelled, timeout=300, grace=2, capture=False):
    if cancelled.is_set():
        raise RunFailed('cancelled before launch')
    started = time.monotonic()
    windows = os.name == 'nt'
    # Publish nested registries before spawning anything. Their owners may
    # die before cleanup, so the parent must be able to find every group.
    inherited = os.environ.get('SPENDSENSE_TEST_REGISTRY') if not windows else None
    registry = pathlib.Path(tempfile.mkdtemp(prefix='processes-', dir=inherited or journal.parent))
    journal.write_text(str(registry), encoding='utf-8')
    env = dict(os.environ, SPENDSENSE_TEST_REGISTRY=str(registry),
               SPENDSENSE_TEST_PYTHON=sys.executable)
    job = None
    # Capture only the inventory query. File-backed output cannot keep asyncio's
    # child wait open when an orphan inherits a pipe.
    with tempfile.TemporaryFile() if capture else open(os.devnull, 'rb') as output:
        child = None
        reason = None
        cleanup = 'no process launched'
        leaked = False
        try:
            if windows:
                from test_windows_job import Job
                job = Job()
            args = [sys.executable, __file__, '--gate', *command]
            child = await asyncio.create_subprocess_exec(
                *args, cwd=cwd, env=env, start_new_session=not windows,
                stdin=asyncio.subprocess.PIPE,
                stdout=output if capture else None,
            )
            (registry / f'worker-{child.pid}').touch(exist_ok=False)
            if job:
                job.assign(child.pid)
            await asyncio.sleep(0)
            if not cancelled.is_set():
                child.stdin.write(b'1')
            child.stdin.close()
            done = asyncio.create_task(child.wait())
            stop = asyncio.create_task(cancelled.wait())
            try:
                await asyncio.wait({done, stop}, timeout=max(0, timeout - (time.monotonic() - started)),
                                   return_when=asyncio.FIRST_COMPLETED)
                if cancelled.is_set():
                    reason = 'cancelled'
                elif not done.done():
                    reason = f'timed out after {timeout:g}s'
            finally:
                stop.cancel()
                done.cancel()
        except Exception as error:
            reason = f'launch or execution error: {error}'
        finally:
            try:
                if child is not None:
                    child.stdin.close()
                    if job:
                        # An assignment failure leaves only the gated bootstrap.
                        if not job.assigned and child.returncode is None:
                            try:
                                child.kill()
                            except ProcessLookupError:
                                pass
                        cleanup, leaked = await job.settle(natural_exit=not reason)
                    else:
                        # Rescan detached groups after observing the worker group.
                        cleanup, leaked = await settle_groups(child.pid, registry, grace, natural_exit=not reason)
                    await asyncio.wait_for(child.wait(), timeout=3)
                shutil.rmtree(registry)
                journal.unlink()
            except Exception as error:
                raise RunFailed(f'{command[-1]} ({time.monotonic() - started:.2f}s, exit '
                                f'{getattr(child, "returncode", None)}): {reason or "execution ended"}; '
                                f'cleanup unverified: {error}; inspect {journal}') from error
            finally:
                if job:
                    job.close()
        if reason or child.returncode or leaked or cancelled.is_set():
            raise RunFailed(f'{command[-1]} ({time.monotonic() - started:.2f}s, exit {getattr(child, "returncode", None)}): '
                            f'{reason or ("cancelled" if cancelled.is_set() else "test failed or left live descendants")}; cleanup {cleanup}')
        if capture:
            output.seek(0)
            data = output.read(65537)
            if len(data) > 65536:
                raise RunFailed('test inventory exceeded 64 KiB')
            return data


if __name__ == '__main__' and sys.argv[1:2] == ['--gate']:
    if sys.stdin.buffer.read(1) != b'1':
        sys.exit(125)
    if os.name == 'nt':
        import subprocess
        sys.exit(subprocess.call(sys.argv[2:], stdin=subprocess.DEVNULL))
    os.execvp(sys.argv[2], sys.argv[2:])
