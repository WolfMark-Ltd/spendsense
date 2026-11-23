"""The native usage probe: bounded, cache-safe per home, and never a silent zero.

Two defects from the integration review live here. The cache was keyed by
provider alone, so a second Hermes home reused the first home's snapshot; and the
per-provider budget was longer than the Desktop transport allows, so a slow probe
looked like a missing route.

WP47 adds capability-aware probing: families Hermes cannot read usage for
(no fetcher, no provider-hook override) are reported unsupported without
spending a subprocess, instead of timing out or failing one by one.
"""
from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import types
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


class UsageSupportTest(unittest.TestCase):
    """WP47/F143: probe only families Hermes can actually read usage for.

    The running Hermes' own fetcher registry (plus provider-hook overrides)
    decides eligibility — never a hardcoded list, and never a guess. When
    Hermes cannot be introspected the verdict is unknown and probes run as
    before.
    """

    def setUp(self) -> None:
        discovery._CACHE.clear()
        discovery._SUPPORT_CACHE.clear()
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name)
        self.addCleanup(self.tmp.cleanup)
        self.addCleanup(discovery._CACHE.clear)
        self.addCleanup(discovery._SUPPORT_CACHE.clear)
        self._modules = []

    def tearDown(self) -> None:
        for name in self._modules:
            sys.modules.pop(name, None)

    def stub_hermes(self, fetchers, hooks=()):
        """Install stub agent/providers modules; None fetchers means no registry."""
        agent = types.ModuleType("agent")
        account_usage = types.ModuleType("agent.account_usage")
        if fetchers is not None:
            account_usage._USAGE_FETCHERS = {slug: (lambda *a: None) for slug in fetchers}
        providers = types.ModuleType("providers")
        base = types.ModuleType("providers.base")

        class ProviderProfile:
            def fetch_account_usage(self, **kwargs):
                return None

        class HookedProfile(ProviderProfile):
            def fetch_account_usage(self, **kwargs):
                return {"hooked": True}

        base.ProviderProfile = ProviderProfile
        hooked = set(hooks)

        def get_provider_profile(slug):
            if slug in hooked:
                return HookedProfile()
            if slug == "plain":
                return ProviderProfile()
            return None

        providers.get_provider_profile = get_provider_profile
        sys.modules["agent"] = agent
        sys.modules["agent.account_usage"] = account_usage
        sys.modules["providers"] = providers
        sys.modules["providers.base"] = base
        self._modules.extend(["agent", "agent.account_usage", "providers", "providers.base"])

    def test_fetcher_slugs_are_supported(self) -> None:
        self.stub_hermes({"openai-codex", "anthropic", "openrouter"})
        self.assertEqual(discovery.usage_support("openai-codex"), "supported")
        self.assertEqual(discovery.usage_support("OpenRouter"), "supported")

    def test_hook_overrides_are_supported(self) -> None:
        self.stub_hermes({"openai-codex"}, hooks={"gateway-x"})
        self.assertEqual(discovery.usage_support("gateway-x"), "supported")

    def test_plain_profiles_and_unknown_slugs_are_unsupported(self) -> None:
        self.stub_hermes({"openai-codex"}, hooks={"gateway-x"})
        self.assertEqual(discovery.usage_support("plain"), "unsupported")
        self.assertEqual(discovery.usage_support("commandcode-anthropic"), "unsupported")

    def test_unreadable_hermes_is_unknown_not_unsupported(self) -> None:
        # Blocked imports (None entries fail the import even where a real
        # Hermes is installed): capability is unknown, so probes run exactly
        # as before instead of going quiet.
        blocked = {"agent": None, "agent.account_usage": None,
                   "providers": None, "providers.base": None}
        with mock.patch.dict(sys.modules, blocked):
            self.assertEqual(discovery.usage_support("openai-codex"), "unknown")
        self.stub_hermes(None)
        discovery._SUPPORT_CACHE.clear()
        self.assertEqual(discovery.usage_support("openai-codex"), "unknown")

    def test_unsupported_families_are_reported_without_a_subprocess(self) -> None:
        self.stub_hermes({"openai-codex"})
        with mock.patch.object(discovery, "_hermes_binary", return_value="/usr/bin/hermes"), \
             mock.patch.object(discovery.subprocess, "run") as run:
            result = discovery.native_snapshot("commandcode-anthropic", home=self.home)
        run.assert_not_called()
        self.assertEqual(result["state"], "unsupported")
        self.assertIn("no usage endpoint", result["reason"])
        self.assertIsNone(result["snapshot"])

    def test_supported_families_still_probe(self) -> None:
        self.stub_hermes({"openai-codex"})
        calls: list = []

        def fake(*args, **kwargs):
            calls.append(args[0])
            return subprocess.CompletedProcess(args[0], 0, '{"provider": "openai-codex"}', "")

        with mock.patch.object(discovery, "_hermes_binary", return_value="/usr/bin/hermes"), \
             mock.patch.object(discovery.subprocess, "run", side_effect=fake):
            result = discovery.native_snapshot("openai-codex", home=self.home)
        self.assertEqual(len(calls), 1)
        self.assertEqual(result["state"], "ok")

    def test_unknown_capability_still_probes(self) -> None:
        calls: list = []

        def fake(*args, **kwargs):
            calls.append(args[0])
            return subprocess.CompletedProcess(args[0], 1, "", "nope")

        with mock.patch.object(discovery, "_hermes_binary", return_value="/usr/bin/hermes"), \
             mock.patch.object(discovery.subprocess, "run", side_effect=fake):
            result = discovery.native_snapshot("mystery", home=self.home)
        self.assertEqual(len(calls), 1, "unknown capability must not skip the probe")
        self.assertEqual(result["state"], "unavailable")

    def test_discover_names_unsupported_families_quietly(self) -> None:
        self.stub_hermes({"openai-codex"})
        (self.home / "auth.json").write_text(json.dumps({
            "credential_pool": {"openai-codex": [{"label": "a"}],
                                "commandcode-anthropic": [{"label": "b"}]}
        }))
        with mock.patch.object(discovery, "_hermes_binary", return_value="/usr/bin/hermes"), \
             mock.patch.object(discovery.subprocess, "run",
                               return_value=subprocess.CompletedProcess(
                                   [], 0, '{"provider": "openai-codex", "windows": []}', "")) as run:
            out = discovery.discover({}, include_native=True, home=self.home)
        self.assertEqual(run.call_count, 1, "only the supported family is probed")
        states = {a["family"]: a.get("usage_source") for a in out["accounts"]}
        self.assertEqual(states["commandcode-anthropic"], "none")
        self.assertTrue(any("commandcode-anthropic" in note and "no usage endpoint" in note
                            for note in out["notes"]),
                        f"unsupported families are named, not errored: {out['notes']}")
        self.assertFalse(any("TimeoutExpired" in note or "could not be read" in note
                             for note in out["notes"]),
                         f"no spurious failure diagnostics: {out['notes']}")

    def test_an_exhausted_budget_reports_without_probing(self) -> None:
        with mock.patch.object(discovery.subprocess, "run") as run:
            out = discovery.probe_providers(["a", "b"], home=self.home, budget_seconds=0)
        run.assert_not_called()
        self.assertEqual(out["a"]["state"], "unavailable")
        self.assertIn("budget", out["a"]["reason"])

    def test_unsupported_families_report_true_state_after_budget_gone(self) -> None:
        # Capability is checked before the budget: an unsupported family
        # costs no subprocess, so it must not inherit a budget-exhaustion
        # misdiagnosis from earlier slow reads.
        self.stub_hermes({"openai-codex"})
        with mock.patch.object(discovery, "_hermes_binary", return_value="/usr/bin/hermes"), \
             mock.patch.object(discovery.subprocess, "run") as run:
            out = discovery.probe_providers(["commandcode-anthropic"], home=self.home,
                                            budget_seconds=0)
        run.assert_not_called()
        self.assertEqual(out["commandcode-anthropic"]["state"], "unsupported")


if __name__ == "__main__":
    unittest.main()
