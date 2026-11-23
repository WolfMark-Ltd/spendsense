"""The native usage probe: bounded, cache-safe per home, and never a silent zero.

Two defects from the integration review live here. The cache was keyed by
provider alone, so a second Hermes home reused the first home's snapshot; and the
per-provider budget was longer than the Desktop transport allows, so a slow probe
looked like a missing route.
"""
from __future__ import annotations

import json
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

    def test_a_malformed_family_fails_its_probe_not_the_page(self) -> None:
        # F127: an embedded NUL (or any control byte) makes subprocess raise
        # ValueError. The probe reports an error for that family instead of
        # 500ing the whole refresh, and no subprocess is attempted.
        with mock.patch.object(discovery, "_hermes_binary",
                               return_value="/usr/bin/hermes"), \
             mock.patch.object(discovery.subprocess, "run") as run:
            result = discovery.native_snapshot("owe\x00d", home=self.homes[0])
        run.assert_not_called()
        self.assertEqual(result["state"], "error")
        self.assertIn("invalid provider family", result["reason"])
        with mock.patch.object(discovery, "_hermes_binary",
                               return_value="/usr/bin/hermes"), \
             mock.patch.object(discovery.subprocess, "run",
                               side_effect=ValueError("embedded null byte")) as run:
            result = discovery.native_snapshot("plain", home=self.homes[0])
        self.assertEqual(result["state"], "error")
        self.assertIn("ValueError", result["reason"])

    def test_a_missing_credential_is_unavailable_not_zero(self) -> None:
        def fake(*args, **kwargs):
            return subprocess.CompletedProcess(args[0], 1, "", "not configured")
        with mock.patch.object(discovery, "_hermes_binary", return_value="/usr/bin/hermes"), \
             mock.patch.object(discovery.subprocess, "run", side_effect=fake):
            result = discovery.native_snapshot("p", home=self.homes[0])
        self.assertEqual(result["state"], "unavailable")
        self.assertIsNone(result["snapshot"])


class MultiSlotDiscoveryTest(unittest.TestCase):
    """F119: several credentials and no identity is ambiguity, not accounts.

    One family with two credential slots and an anonymous Hermes reading
    yields one default-slot account — never two invented per-slot accounts —
    and the discovery notes must say the reading cannot be attributed.
    """

    def setUp(self) -> None:
        discovery._CACHE.clear()
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name)
        (self.home / "auth.json").write_text(json.dumps({
            "credential_pool": {"anthropic": [{"label": "work"}, {"label": "personal"}]}
        }))
        self.addCleanup(self.tmp.cleanup)
        self.addCleanup(discovery._CACHE.clear)

    def test_two_slots_and_no_identity_is_flagged_not_split(self) -> None:
        snapshot = {"provider": "anthropic", "source": "oauth_usage_api",
                    "title": "Account limits", "plan": None,
                    "fetched_at": "2026-11-18T12:00:00+00:00",
                    "windows": [{"label": "Opus week", "used_percent": 100.0,
                                 "resets_at": "2026-11-25T00:00:00+00:00", "detail": None}],
                    "details": [], "unavailable_reason": None}
        with mock.patch.object(discovery, "native_snapshot",
                               return_value={"state": "ok", "snapshot": snapshot, "reason": ""}):
            out = discovery.discover({}, include_native=True, home=self.home)
        self.assertEqual([a["id"] for a in out["accounts"]], ["anthropic:default"])
        self.assertIsNone(out["accounts"][0]["identity"])
        self.assertEqual(out["accounts"][0]["identity_source"], "provider_default_slot")
        self.assertTrue(any("2" in note and "credential" in note for note in out["notes"]),
                        f"multi-slot ambiguity must be named: {out['notes']}")


if __name__ == "__main__":
    unittest.main()
