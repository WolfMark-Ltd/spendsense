import asyncio
import os
import pathlib
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from test_process import RunFailed, group_state, supervise


class SupervisorTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = pathlib.Path(temp.name)
        self.journal = self.root / 'active-run'
        self.cancelled = asyncio.Event()

    async def run_code(self, code, **options):
        return await supervise([sys.executable, '-c', code], cwd=self.root,
                               journal=self.journal, cancelled=self.cancelled, **options)

    async def test_timeout_and_verified_cleanup(self):
        with self.assertRaisesRegex(RunFailed, 'timed out.*cleanup verified'):
            await self.run_code('import time; time.sleep(5)', timeout=0.25)
        self.assertFalse(self.journal.exists())

    async def test_cancelled_before_start(self):
        self.cancelled.set()
        with self.assertRaisesRegex(RunFailed, 'cancelled before launch'):
            await self.run_code('raise AssertionError("worker launched")')
        self.assertFalse(self.journal.exists())

    async def test_cancellation_during_startup_never_releases_worker(self):
        create_process = asyncio.create_subprocess_exec

        async def cancel_during_spawn(*args, **kwargs):
            worker = await create_process(*args, **kwargs)
            self.cancelled.set()
            return worker

        with patch('test_process.asyncio.create_subprocess_exec', side_effect=cancel_during_spawn):
            with self.assertRaisesRegex(RunFailed, 'cancelled.*cleanup verified'):
                await self.run_code('import pathlib; pathlib.Path("launched").touch()')
        self.assertFalse((self.root / 'launched').exists())
        self.assertFalse(self.journal.exists())

    async def test_cancellation_during_execution(self):
        task = asyncio.create_task(self.run_code(
            'import pathlib,time; pathlib.Path("ready").touch(); time.sleep(8)', timeout=5))
        await self.wait_ready()
        self.cancelled.set()
        with self.assertRaisesRegex(RunFailed, 'cancelled.*cleanup verified'):
            await task
        self.assertFalse(self.journal.exists())

    async def wait_ready(self):
        async def poll():
            while not (self.root / 'ready').exists():
                await asyncio.sleep(0.02)
        await asyncio.wait_for(poll(), timeout=4)

    @unittest.skipIf(os.name == 'nt', 'POSIX signals')
    async def test_ignores_term_and_requires_kill(self):
        task = asyncio.create_task(self.run_code(
            'import signal,pathlib,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); '
            'pathlib.Path("ready").touch(); time.sleep(8)', timeout=5, grace=0.1))
        await self.wait_ready()
        self.cancelled.set()
        with self.assertRaisesRegex(RunFailed, 'cancelled.*verified after SIGKILL'):
            await task

    async def test_worker_exits_with_descendant_alive(self):
        with self.assertRaisesRegex(RunFailed, 'left live descendants.*cleanup verified'):
            await self.run_code(
                'import subprocess,sys; subprocess.Popen([sys.executable,"-c","import time; time.sleep(8)"])',
                timeout=5)
        self.assertFalse(self.journal.exists())

    @unittest.skipIf(os.name == 'nt', 'POSIX browser process groups')
    async def test_registered_group_outlives_worker_and_is_terminated(self):
        node = shutil.which(os.environ.get('SPENDSENSE_NODE', 'node'))
        if node is None:
            self.skipTest('Node is required for the detached Chromium gate control')
        uri = (ROOT / 'test' / 'chromium-lifecycle.mjs').as_uri()
        code = f"""
import {{ spawnRegisteredGroup }} from {uri!r}
import {{ writeFileSync }} from 'node:fs'
const child = spawnRegisteredGroup(process.execPath, ['-e', 'setTimeout(() => {{}}, 8000)'],
  {{ detached: true, stdio: ['ignore', 'ignore', 'ignore'] }})
writeFileSync('group', String(child.pid))
child.stdin.on('finish', () => process.exit(0))
"""
        with self.assertRaisesRegex(RunFailed, 'left live descendants.*cleanup verified'):
            await supervise([node, '--input-type=module', '-e', code], cwd=self.root,
                            journal=self.journal, cancelled=self.cancelled, timeout=5)
        self.assertFalse(group_state(int((self.root / 'group').read_text())))

    @unittest.skipIf(os.name == 'nt', 'POSIX launch gate')
    async def test_gate_does_not_launch_without_permission(self):
        worker = await asyncio.create_subprocess_exec(
            sys.executable, str(ROOT / 'scripts' / 'test_process.py'), '--gate',
            sys.executable, '-c', 'import pathlib; pathlib.Path("launched").touch()',
            cwd=self.root, stdin=asyncio.subprocess.PIPE)
        worker.stdin.close()
        self.assertEqual(await asyncio.wait_for(worker.wait(), timeout=4), 125)
        self.assertFalse((self.root / 'launched').exists())

    @unittest.skipIf(os.name == 'nt', 'POSIX verification injection')
    async def test_cleanup_failure_keeps_journal(self):
        with patch('test_process.settle_groups', side_effect=OSError('verification denied')):
            with self.assertRaisesRegex(RunFailed, 'cleanup unverified: verification denied'):
                await self.run_code('pass')
        self.assertTrue(self.journal.exists())
