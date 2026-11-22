import pathlib
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from test_guard import test_guard


class GuardTests(unittest.TestCase):
    def test_worktree_contention_release_and_recovery_after_abrupt_exit(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            lock = root / 'guard'
            worktree = root / 'second-worktree'
            worktree.mkdir()
            shutil.copy(ROOT / 'scripts' / 'test_guard.py', worktree)
            code = ('import os,sys; from test_guard import test_guard; '
                    'guard=test_guard(sys.argv[1]); guard.__enter__(); os._exit(19)')
            command = [sys.executable, '-c', code, str(lock)]
            with test_guard(lock):
                result = subprocess.run(command, cwd=worktree, capture_output=True, text=True, timeout=5)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('already running', result.stderr)
            result = subprocess.run(command, cwd=worktree, capture_output=True, text=True, timeout=5)
            self.assertEqual(result.returncode, 19, result.stderr)
            self.assertTrue((lock / 'owner.json').exists())
            with test_guard(lock):
                result = subprocess.run(command, cwd=worktree, capture_output=True, text=True, timeout=5)
                self.assertIn('already running', result.stderr)
