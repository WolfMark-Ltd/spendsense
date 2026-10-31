"""The native usage probe: bounded, cache-safe per home, and never a silent zero.

Two defects from the integration review live here. The cache was keyed by
provider alone, so a second Hermes home reused the first home's snapshot; and the
per-provider budget was longer than the Desktop transport allows, so a slow probe
looked like a missing route.
"""
from __future__ import annotations

import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from wolfmark_ledger import discovery


class ProbeBudgetTest(unittest.TestCase):
    def test_the_budget_fits_inside_the_transport_timeout(self) -> None:
        # ctx.rest gives a call 15 s; a probe must fail as "unavailable" before that.
        self.assertLess(discovery.PROBE_TIMEOUT, 15.0)
        self.assertGreaterEqual(discovery.PROBE_TIMEOUT, 4.0)


class ProbeCacheTest(unittest.TestCase):
    def setUp(self) -> None:
        discovery._CACHE.clear()
        self.homes = [Path(tempfile.mkdtemp()), Path(tempfile.mkdtemp())]

    def tearDown(self) -> None:
        discovery._CACHE.clear()

    def _run(self, home: Path, payload: str = '{"provider": "p", "windows": []}', calls=None):
        def fake(*args, **kwargs):
            if calls is not None:
                calls.append(kwargs.get("env", {}).get("HERMES_HOME"))
            return subprocess.CompletedProcess(args[0], 0, payload, "")
        with mock.patch.object(discovery, "_hermes_binary", return_value="/usr/bin/hermes"), \
             mock.patch.object(discovery.subprocess, "run", side_effect=fake):
            return discovery.native_snapshot("p", home=home)

    def test_the_same_home_is_cached(self) -> None:
        calls: list[str] = []
        self._run(self.homes[0], calls=calls)
        self._run(self.homes[0], calls=calls)
        self.assertEqual(len(calls), 1, "a repeat read of one home is served from cache")

    def test_a_second_home_does_not_reuse_the_first_home_snapshot(self) -> None:
        calls: list[str] = []
        first = self._run(self.homes[0], payload='{"provider": "p", "title": "home A"}', calls=calls)
        second = self._run(self.homes[1], payload='{"provider": "p", "title": "home B"}', calls=calls)
        self.assertEqual(len(calls), 2, "each home is read once, not served from the other")
        self.assertEqual(first["snapshot"]["title"], "home A")
        self.assertEqual(second["snapshot"]["title"], "home B")
        self.assertNotEqual(calls[0], calls[1])

    def test_a_timeout_is_reported_not_raised(self) -> None:
        with mock.patch.object(discovery, "_hermes_binary", return_value="/usr/bin/hermes"), \
             mock.patch.object(discovery.subprocess, "run",
                               side_effect=subprocess.TimeoutExpired(cmd="hermes", timeout=8)):
            result = discovery.native_snapshot("p", home=self.homes[0])
        self.assertEqual(result["state"], "error")
        self.assertIn("TimeoutExpired", result["reason"])
        self.assertIsNone(result["snapshot"])

    def test_a_missing_credential_is_unavailable_not_zero(self) -> None:
        def fake(*args, **kwargs):
            return subprocess.CompletedProcess(args[0], 1, "", "not configured")
        with mock.patch.object(discovery, "_hermes_binary", return_value="/usr/bin/hermes"), \
             mock.patch.object(discovery.subprocess, "run", side_effect=fake):
            result = discovery.native_snapshot("p", home=self.homes[0])
        self.assertEqual(result["state"], "unavailable")
        self.assertIsNone(result["snapshot"])


if __name__ == "__main__":
    unittest.main()
