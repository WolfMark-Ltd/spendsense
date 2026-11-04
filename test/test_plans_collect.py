"""Plans collector pipeline tests: publication status vs run logging.

Runs the real ``plans-feed/collect.sh`` in a scratch tree. POSIX + sh
only; skipped elsewhere (including Windows CI).
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
COLLECT = ROOT / "plans-feed" / "collect.sh"

HAVE_SHELL = os.name == "posix" and shutil.which("sh")


@unittest.skipUnless(HAVE_SHELL, "POSIX sh required")
class PlansCollectTests(unittest.TestCase):
    def setUp(self):
        scratch = tempfile.TemporaryDirectory(dir=os.environ.get("TMPDIR"))
        self.addCleanup(scratch.cleanup)
        self.home = Path(scratch.name)
        (self.home / "state").mkdir()
        self.env = {**os.environ,
                    "FEED_ROOT": str(self.home),
                    "FEED_WEBROOT": str(self.home / "www"),
                    "FEED_PYTHON": sys.executable}

    def run_collect(self, env=None):
        return subprocess.run(["sh", str(COLLECT)], env=env or self.env,
                              capture_output=True, text=True, timeout=180)

    def test_post_publication_log_failure_keeps_exit_zero(self):
        (self.home / "state" / "plans-collect.log").mkdir()
        result = self.run_collect()
        self.assertEqual(result.returncode, 0, msg=result.stderr)
        live = self.home / "www" / "feed" / "v1" / "plans.json"
        self.assertEqual(json.loads(live.read_text())["version"], 1)
        self.assertIn("run log", result.stderr)


if __name__ == "__main__":
    unittest.main()
