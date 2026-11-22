"""Host-local advisory lock for managed SpendSense test invocations.

The lock file is intentionally never unlinked: unlinking an advisory lock file
can create two independently locked inodes. The OS releases the lock on close.
"""
import contextlib
import errno
import json
import os
import pathlib
import socket
import stat

if os.name == 'nt':
    import msvcrt
else:
    import fcntl


class GuardBusy(RuntimeError):
    pass


def lock_directory():
    if os.name == 'nt':
        return pathlib.Path(os.environ['LOCALAPPDATA']) / 'SpendSenseTestGuard'
    return pathlib.Path('/tmp') / f'spendsense-test-guard-{os.getuid()}'


@contextlib.contextmanager
def test_guard(directory=None):
    directory = pathlib.Path(directory) if directory else lock_directory()
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = directory.lstat()
    if not stat.S_ISDIR(info.st_mode) or (os.name != 'nt' and
            (info.st_uid != os.getuid() or info.st_mode & 0o077)):
        raise RuntimeError(f'unsafe test guard directory: {directory}')
    path = directory / 'execution.lock'
    flags = os.O_RDWR | os.O_CREAT | getattr(os, 'O_NOFOLLOW', 0)
    fd = os.open(path, flags, 0o600)
    try:
        try:
            if os.name == 'nt':
                msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
            else:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as error:
            if error.errno not in (errno.EACCES, errno.EAGAIN, errno.EDEADLK):
                raise
            try:
                owner = (directory / 'owner.json').read_text(encoding='utf-8')
            except OSError:
                owner = 'initialising'
            raise GuardBusy(f'managed SpendSense tests already running (owner: {owner})') from error
        (directory / 'owner.json').write_text(json.dumps({
            'pid': os.getpid(), 'host': socket.gethostname(), 'cwd': os.getcwd(),
        }), encoding='utf-8')
        yield directory
    finally:
        os.close(fd)
