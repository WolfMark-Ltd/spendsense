"""Model News personalisation: relevance reasons, empty states, throttled refresh."""
from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path

from wolfmark_ledger import monitoring, news
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


def item(item_id, provider, origin, model="", category="pricing", for_you=False):
    return {"id": item_id, "provider": provider, "model": model,
            "origin": origin, "category": category, "for_you": for_you,
            "observed_at": "2026-11-01T00:00:00+00:00"}


def payload(local_items=(), central_items=(), baseline=False, for_you_count=0):
    return {"ok": True, "settings": {"live_updates": False},
            "local": {"items": list(local_items), "baseline": baseline},
            "central": {"state": "ok", "items": list(central_items)},
            "for_you_count": for_you_count, "impacts": {}}


class PersonalisePayloadTests(unittest.TestCase):
    def test_items_gain_relevance_reasons_per_origin(self):
        local_item = item("l1", "Anthropic", "local", for_you=True)
        central_item = item("c1", "stranger", "central")
        signals = {"configured_families": ["anthropic"], "used_providers": [],
                   "used_models": [], "plan_families": []}
        out = monitoring.personalise_payload(
            payload([local_item], [central_item], for_you_count=1),
            signals=signals)
        self.assertEqual(out["local"]["items"][0]["relevance"],
                         {"relevant": True, "reasons": ["configured_provider"]})
        self.assertEqual(out["central"]["items"][0]["relevance"],
                         {"relevant": False, "reasons": []})
        self.assertEqual(out["local"]["items"][0]["origin"], "local")
        self.assertEqual(out["central"]["items"][0]["origin"], "central")

    def test_stored_for_you_flags_and_count_are_untouched(self):
        local_item = item("l1", "stranger", "local", for_you=True)
        out = monitoring.personalise_payload(
            payload([local_item], [], for_you_count=1),
            signals={"configured_families": ["anthropic"]})
        self.assertTrue(out["local"]["items"][0]["for_you"])
        self.assertEqual(out["for_you_count"], 1)
        self.assertFalse(out["local"]["items"][0]["relevance"]["relevant"])

    def test_for_you_reflects_usage_and_plans_canonically(self):
        used = item("l1", "openai", "local", model="gpt-x")
        planned = item("c1", "demo", "central")
        signals = {"configured_families": [],
                   "used_providers": ["openai-codex"],
                   "used_models": [{"provider": "openai-codex", "model": "gpt-x"}],
                   "plan_families": ["demo"]}
        out = monitoring.personalise_payload(
            payload([used], [planned]), signals=signals)
        self.assertEqual(out["local"]["items"][0]["relevance"]["reasons"],
                         ["used_provider", "used_model"])
        self.assertEqual(out["central"]["items"][0]["relevance"]["reasons"],
                         ["selected_plan_family"])

    def test_all_updates_survives_zero_config(self):
        central_item = item("c1", "stranger", "central")
        out = monitoring.personalise_payload(
            payload([], [central_item]), scope="all",
            signals={"configured_families": [], "used_providers": [],
                     "used_models": [], "plan_families": []})
        self.assertEqual(len(out["central"]["items"]), 1)
        self.assertEqual(out["central"]["items"][0]["id"], "c1")
        self.assertEqual(out["central"]["items"][0]["relevance"],
                         {"relevant": False, "reasons": []})
        self.assertEqual(out["empty"]["state"], "has_news")

    def test_empty_state_follows_scope_and_category(self):
        priced = item("l1", "acme", "local", category="pricing")
        out = monitoring.personalise_payload(
            payload([priced], []), scope="foryou", category="plans",
            signals={"configured_families": ["acme"]})
        self.assertEqual(out["empty"]["state"], "category_empty")
        out = monitoring.personalise_payload(
            payload([priced], []), scope="foryou", category="all",
            signals={"configured_families": [], "used_providers": [],
                     "used_models": [], "plan_families": []})
        self.assertEqual(out["empty"]["state"], "no_config")

    def test_personalise_payload_writes_no_files(self):
        with tempfile.TemporaryDirectory(dir=os.environ.get("TMPDIR")) as scratch:
            data = Path(scratch) / "plugin-data"
            monitoring.personalise_payload(
                payload([item("l1", "acme", "local")], []),
                signals={"configured_families": ["acme"]})
            self.assertFalse(data.exists())


class ThrottledRefreshTests(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory(dir=os.environ.get("TMPDIR"))
        self.addCleanup(self.scratch.cleanup)
        self.data = Path(self.scratch.name) / "plugin-data"
        self.events = Path(self.scratch.name) / "usage.db"
        self.home = Path(self.scratch.name) / "hermes-home"
        self.args = dict(data_dir=self.data, event_db=self.events, home=self.home,
                         catalogue=book([("acme", "alpha", Rate(1.0, 2.0))]),
                         plans_doc=plans_doc([plan("demo.basic")]), fetch=False)

    def test_second_throttled_refresh_is_skipped(self):
        first = news.refresh_payload(now=NOW, throttle=True, **self.args)
        self.assertTrue(first["local"]["baseline"])
        self.assertEqual(first["local_refresh"]["reason"], "no_baseline")
        second = news.refresh_payload(now=NOW + 60, throttle=True, **self.args)
        self.assertEqual(second["local_refresh"],
                         {"checked": False, "reason": "fresh",
                          "checked_at": NOW})
        self.assertFalse(second["local"]["baseline"])

    def test_forced_refresh_bypasses_throttle(self):
        news.refresh_payload(now=NOW, throttle=True, **self.args)
        forced = news.refresh_payload(now=NOW + 60, throttle=True, force=True,
                                      **self.args)
        self.assertTrue(forced["local_refresh"]["checked"])
        self.assertEqual(forced["local_refresh"]["reason"], "forced")

    def test_unthrottled_refresh_preserves_always_diff(self):
        first = news.refresh_payload(now=NOW, **self.args)
        second = news.refresh_payload(now=NOW + 60, **self.args)
        self.assertNotIn("local_refresh", first)
        self.assertNotIn("local_refresh", second)
        self.assertFalse(second["local"]["baseline"])


if __name__ == "__main__":
    unittest.main()
