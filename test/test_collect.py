"""Collector pipeline tests: locking and concurrent-run safety.

Runs the real ``news-feed/collect.sh`` in a scratch tree. POSIX + sh + curl
only; skipped elsewhere (including Windows CI).
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
COLLECT = ROOT / "news-feed" / "collect.sh"

HAVE_SHELL = os.name == "posix" and shutil.which("sh") and shutil.which("curl")


@unittest.skipUnless(HAVE_SHELL, "POSIX sh + curl required")
class CollectLockTests(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory(dir=os.environ.get("TMPDIR"))
        self.addCleanup(self.scratch.cleanup)
        self.home = Path(self.scratch.name)
        (self.home / "state").mkdir()
        (self.home / "state" / "curated.json").write_text('{"announcements": []}')
        v1 = {"acme": {"models": {"alpha": {"cost": {"input": 3.0, "output": 15.0}}}}}
        v2 = {"acme": {"models": {"alpha": {"cost": {"input": 2.0, "output": 10.0}}}}}
        (self.home / "v1.json").write_text(json.dumps(v1))
        (self.home / "v2.json").write_text(json.dumps(v2))
        (self.home / "state" / "models-prev.json").write_text(json.dumps(v1))
        self.env = {**os.environ,
                    "FEED_ROOT": str(self.home),
                    "FEED_WEBROOT": str(self.home / "www"),
                    "FEED_PYTHON": sys.executable,
                    "FEED_MIN_BYTES": "10",
                    "MODELS_DEV_URL": (self.home / "v2.json").as_uri()}

    def run_collect(self):
        return subprocess.run(["sh", str(COLLECT)], env=self.env,
                              capture_output=True, text=True, timeout=120)

    def test_run_refuses_when_lock_held(self):
        (self.home / "state" / "collect.lock").mkdir()
        try:
            result = self.run_collect()
        finally:
            (self.home / "state" / "collect.lock").rmdir()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("lock", result.stderr)
        self.assertFalse((self.home / "www" / "feed" / "v1" / "news.json").exists())

    def test_concurrent_runs_leave_a_valid_feed(self):
        results = []

        def target():
            results.append(self.run_collect())

        threads = [threading.Thread(target=target) for _ in range(2)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        detail = "\n".join(f"rc={r.returncode} stderr={r.stderr.strip()}" for r in results)
        self.assertEqual(sorted(r.returncode for r in results), [0, 1], msg=detail)
        loser = next(r for r in results if r.returncode != 0)
        self.assertIn("lock", loser.stderr)
        live = self.home / "www" / "feed" / "v1" / "news.json"
        feed = json.loads(live.read_text())
        self.assertEqual(feed["version"], 1)
        self.assertTrue(feed["items"])
        self.assertFalse((self.home / "state" / "collect.lock").exists())

    def test_run_tolerates_spaces_in_paths(self):
        root = self.home / "with space" / "root"
        (root / "state").mkdir(parents=True)
        shutil.copy(self.home / "state" / "curated.json", root / "state" / "curated.json")
        shutil.copy(self.home / "state" / "models-prev.json", root / "state" / "models-prev.json")
        env = {**self.env,
               "FEED_ROOT": str(root),
               "FEED_WEBROOT": str(root / "www")}
        result = subprocess.run(["sh", str(COLLECT)], env=env,
                                capture_output=True, text=True, timeout=120)
        self.assertEqual(result.returncode, 0, msg=result.stderr)
        live = root / "www" / "feed" / "v1" / "news.json"
        feed = json.loads(live.read_text())
        self.assertEqual(feed["version"], 1)
        self.assertTrue(feed["items"])


if __name__ == "__main__":
    unittest.main()
