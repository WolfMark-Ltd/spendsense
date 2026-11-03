"""Local monitoring integration: sources, throttled checks, relevance, empty states."""
from __future__ import annotations

import json
import os
import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path

from wolfmark_ledger import monitoring, store
from wolfmark_ledger.pricing import Catalogue, Rate

NOW = 1798765432.0


def book(rows, source="fixture cache", as_of="2026-11-01T00:00:00+00:00"):
    providers: dict[str, dict[str, Rate]] = {}
    for provider, model, rate in rows:
        providers.setdefault(provider, {})[model] = rate
    return Catalogue(providers, source, "test", as_of, "1")


def plans_doc(plans, sources=()):
    return {"catalogue_version": "test", "generated_at": "2026-11-01T00:00:00Z",
            "plans": plans, "sources": list(sources)}


def plan(plan_id, family="demo", amount=10.0):
    return {"id": plan_id, "provider_family": family, "name": f"{family} {plan_id}",
            "price": {"amount": amount, "currency": "USD", "period": "month"},
            "entitlements": {"windows": ["monthly-credits"]},
            "verification": {"source_id": "demo-source"}}


class MonitoringTestCase(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory(dir=os.environ.get("TMPDIR"))
        self.addCleanup(self.scratch.cleanup)
        self.data = Path(self.scratch.name) / "plugin-data"
        self.events = Path(self.scratch.name) / "usage.db"
        self.home = Path(self.scratch.name) / "hermes-home"
        self.store_file = Path(self.scratch.name) / "memberships.json"

    def create_events(self, rows=()):
        with closing(sqlite3.connect(self.events)) as conn, conn:
            conn.executescript(store._SCHEMA)
            for index, row in enumerate(rows):
                values = {"event_id": f"event-{index}", "ts": NOW - 100,
                          "model": "m", "provider": "test", "outcome": "ok",
                          "recorded_at": NOW, **row}
                columns = list(values)
                conn.execute(f"INSERT INTO calls ({','.join(columns)}) VALUES "
                             f"({','.join('?' for _ in columns)})", list(values.values()))

    def write_auth(self, pool):
        self.home.mkdir(parents=True, exist_ok=True)
        (self.home / "auth.json").write_text(json.dumps({"credential_pool": pool}))

    def write_store(self, accounts):
        self.store_file.write_text(json.dumps({"version": 1, "accounts": accounts}))


class SourceTests(MonitoringTestCase):
    def test_each_kind_has_label_and_explanation(self):
        for kind in monitoring.SOURCE_KINDS:
            described = monitoring.describe_source(kind)
            self.assertEqual(described["kind"], kind)
            self.assertTrue(described["label"])
            self.assertTrue(described["explanation"])

    def test_observed_recorded_usage_never_remaining_use(self):
        described = monitoring.describe_source(monitoring.OBSERVED_USAGE)
        self.assertIn("actually used", described["explanation"])
        self.assertIn("never what remains", described["explanation"])

    def test_provider_allowance_is_live_and_never_stored(self):
        described = monitoring.describe_source(monitoring.PROVIDER_ALLOWANCE)
        self.assertIn("never stored", described["explanation"])
        self.assertIn("never confused with observed spend", described["explanation"])

    def test_public_plan_info_is_reference_not_measurement(self):
        described = monitoring.describe_source(monitoring.PUBLIC_PLAN_INFO)
        self.assertIn("reference", described["explanation"])
        self.assertIn("not a measurement of remaining use", described["explanation"])

    def test_unknown_kind_is_labelled_not_crash(self):
        described = monitoring.describe_source("nope")
        self.assertEqual(described["label"], "Unknown source")
        self.assertTrue(described["explanation"])


class ThrottleTests(MonitoringTestCase):
    def test_first_check_runs_and_establishes_baseline(self):
        result = monitoring.maybe_refresh_local(
            data_dir=self.data, catalogue=book([("acme", "alpha", Rate(1.0, 2.0))]),
            plans_doc=plans_doc([plan("demo.basic")]), now=NOW)
        self.assertTrue(result["checked"])
        self.assertEqual(result["reason"], "no_baseline")
        self.assertTrue(result["result"]["baseline"])
        self.assertEqual(result["checked_at"], NOW)

    def test_second_check_within_interval_is_skipped(self):
        args = dict(data_dir=self.data,
                    catalogue=book([("acme", "alpha", Rate(1.0, 2.0))]),
                    plans_doc=plans_doc([]))
        monitoring.maybe_refresh_local(now=NOW, **args)
        skipped = monitoring.maybe_refresh_local(now=NOW + 60, **args)
        self.assertFalse(skipped["checked"])
        self.assertEqual(skipped["reason"], "fresh")
        self.assertIsNone(skipped["result"])
        self.assertEqual(skipped["checked_at"], NOW)

    def test_check_runs_again_after_interval(self):
        args = dict(data_dir=self.data,
                    catalogue=book([("acme", "alpha", Rate(1.0, 2.0))]),
                    plans_doc=plans_doc([]))
        monitoring.maybe_refresh_local(now=NOW, **args)
        rerun = monitoring.maybe_refresh_local(
            now=NOW + monitoring.LOCAL_CHECK_INTERVAL_SECONDS, **args)
        self.assertTrue(rerun["checked"])
        self.assertEqual(rerun["reason"], "due")

    def test_forced_refresh_bypasses_throttle(self):
        args = dict(data_dir=self.data,
                    catalogue=book([("acme", "alpha", Rate(1.0, 2.0))]),
                    plans_doc=plans_doc([]))
        monitoring.maybe_refresh_local(now=NOW, **args)
        forced = monitoring.maybe_refresh_local(now=NOW + 1, force=True, **args)
        self.assertTrue(forced["checked"])
        self.assertEqual(forced["reason"], "forced")

    def test_local_check_due_without_baseline(self):
        self.assertTrue(monitoring.local_check_due(data_dir=self.data, now=NOW))


class SignalsTests(MonitoringTestCase):
    def test_empty_config_yields_empty_signals(self):
        signals = monitoring.local_signals(home=self.home, event_db=self.events,
                                           store_path=self.store_file,
                                           plans_catalogue={"plans": []}, now=NOW)
        self.assertEqual(signals, {"configured_families": [], "used_providers": [],
                                   "used_models": [], "plan_ids": [], "plan_families": []})
        self.assertFalse(monitoring.has_signals(signals))
        self.assertFalse(monitoring.has_signals(None))

    def test_populated_stores_yield_signals(self):
        self.write_auth({"anthropic": [{"id": "one"}]})
        self.create_events([{"provider": "anthropic", "model": "claude-sonnet"}])
        self.write_store([{"id": "a1", "family": "demo", "plan_id": "demo.basic"}])
        signals = monitoring.local_signals(
            home=self.home, event_db=self.events, store_path=self.store_file,
            plans_catalogue=plans_doc([plan("demo.basic")]), now=NOW)
        self.assertEqual(signals["configured_families"], ["anthropic"])
        self.assertEqual(signals["used_providers"], ["anthropic"])
        self.assertEqual(signals["used_models"],
                         [{"provider": "anthropic", "model": "claude-sonnet"}])
        self.assertEqual(signals["plan_ids"], ["demo.basic"])
        self.assertEqual(signals["plan_families"], ["demo"])
        self.assertTrue(monitoring.has_signals(signals))


class RelevanceTests(MonitoringTestCase):
    def test_configured_provider_matches(self):
        match = monitoring.match_relevance(
            {"provider": "Anthropic", "model": "other"},
            {"configured_families": ["anthropic"]})
        self.assertTrue(match["relevant"])
        self.assertEqual(match["reasons"], ["configured_provider"])

    def test_used_model_matches_with_provider_reason(self):
        match = monitoring.match_relevance(
            {"provider": "acme", "model": "Beta"},
            {"used_providers": ["acme"],
             "used_models": [{"provider": "acme", "model": "beta"}]})
        self.assertTrue(match["relevant"])
        self.assertEqual(match["reasons"], ["used_provider", "used_model"])

    def test_selected_plan_family_matches(self):
        match = monitoring.match_relevance(
            {"provider": "demo", "model": ""}, {"plan_families": ["demo"]})
        self.assertTrue(match["relevant"])
        self.assertEqual(match["reasons"], ["selected_plan_family"])

    def test_unrelated_item_has_no_reasons(self):
        match = monitoring.match_relevance(
            {"provider": "stranger", "model": "x"},
            {"configured_families": ["anthropic"], "used_providers": ["anthropic"],
             "used_models": [{"provider": "anthropic", "model": "m"}],
             "plan_families": ["demo"]})
        self.assertEqual(match, {"relevant": False, "reasons": []})

    def test_item_without_provider_never_matches(self):
        match = monitoring.match_relevance(
            {"provider": "", "model": "beta"},
            {"used_models": [{"provider": "acme", "model": "beta"}]})
        self.assertEqual(match, {"relevant": False, "reasons": []})

    def test_personalise_items_annotates_copies(self):
        items = [{"id": "1", "provider": "acme", "model": "beta"}]
        personalised = monitoring.personalise_items(
            items, {"used_providers": ["acme"],
                    "used_models": [{"provider": "acme", "model": "beta"}]})
        self.assertNotIn("relevance", items[0])
        self.assertEqual(personalised[0]["relevance"],
                         {"relevant": True, "reasons": ["used_provider", "used_model"]})


class EmptyStateTests(MonitoringTestCase):
    def test_baseline_state(self):
        state = monitoring.empty_state(items=[], baseline=True)
        self.assertEqual(state["state"], "baseline")
        self.assertIn("First snapshot", state["message"])

    def test_no_changes_when_catalogues_quiet(self):
        state = monitoring.empty_state(items=[], scope="all")
        self.assertEqual(state["state"], "no_changes")
        self.assertIn("unchanged since the last check", state["message"])

    def test_no_config_when_nothing_to_match(self):
        items = [{"id": "1", "provider": "acme",
                  "relevance": {"relevant": False, "reasons": []}}]
        state = monitoring.empty_state(items=items, signals={"configured_families": []})
        self.assertEqual(state["state"], "no_config")
        self.assertIn("personalise", state["message"])

    def test_no_matches_when_signals_exist_but_news_is_unrelated(self):
        items = [{"id": "1", "provider": "acme",
                  "relevance": {"relevant": False, "reasons": []}}]
        state = monitoring.empty_state(items=items, signals={"plan_ids": ["demo.basic"]})
        self.assertEqual(state["state"], "no_matches")
        self.assertIn("none of it mentions", state["message"])

    def test_category_empty(self):
        items = [{"id": "1", "category": "subscription",
                  "relevance": {"relevant": True, "reasons": ["used_provider"]}}]
        state = monitoring.empty_state(items=items, scope="all", category="new_model")
        self.assertEqual(state["state"], "category_empty")

    def test_has_news_carries_no_message(self):
        items = [{"id": "1", "relevance": {"relevant": True, "reasons": ["used_provider"]}}]
        state = monitoring.empty_state(items=items)
        self.assertEqual(state, {"state": "has_news", "message": ""})

    def test_for_you_falls_back_to_stored_flag(self):
        items = [{"id": "1", "for_you": True}]
        state = monitoring.empty_state(items=items)
        self.assertEqual(state["state"], "has_news")


class NewsViewTests(MonitoringTestCase):
    def test_view_composes_payload_relevance_and_empty_state(self):
        self.write_auth({"acme": [{"id": "one"}]})
        self.create_events([{"provider": "acme", "model": "beta"}])
        monitoring.maybe_refresh_local(
            data_dir=self.data, catalogue=book([("acme", "alpha", Rate(1.0, 2.0))]),
            plans_doc=plans_doc([]), now=NOW)
        monitoring.maybe_refresh_local(
            data_dir=self.data,
            catalogue=book([("acme", "alpha", Rate(1.0, 2.0)),
                            ("acme", "beta", Rate(0.5, 1.5))]),
            plans_doc=plans_doc([]), now=NOW + monitoring.LOCAL_CHECK_INTERVAL_SECONDS)
        view = monitoring.news_view(data_dir=self.data, event_db=self.events,
                                    home=self.home, store_path=self.store_file,
                                    plans_catalogue={"plans": []}, now=NOW + 10_000)
        self.assertTrue(view["ok"])
        self.assertEqual(len(view["items"]), 1)
        self.assertEqual(view["items"][0]["relevance"]["reasons"],
                         ["configured_provider", "used_provider", "used_model"])
        self.assertEqual(view["empty"], {"state": "has_news", "message": ""})
        self.assertEqual(set(view["sources"]), set(monitoring.SOURCE_KINDS))

    def test_view_is_read_only(self):
        before = {path.name for path in self.data.glob("*")} if self.data.exists() else set()
        monitoring.news_view(data_dir=self.data, event_db=self.events,
                             home=self.home, store_path=self.store_file,
                             plans_catalogue={"plans": []}, now=NOW)
        after = {path.name for path in self.data.glob("*")} if self.data.exists() else set()
        self.assertEqual(before, after)
        self.assertFalse(self.data.exists())


if __name__ == "__main__":
    unittest.main()
