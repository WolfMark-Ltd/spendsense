"""Model News: local catalogue diffs, opt-in central feed, personalised impact.

Tests drive the wished-for ``wolfmark_ledger.news`` API; each helper fails
with "not implemented" until the module exists (RED), then the behaviour
assertions take over (GREEN).
"""
from __future__ import annotations

import importlib
import importlib.util
import io
import json
import os
import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from unittest import mock

from wolfmark_ledger import membership as mem
from wolfmark_ledger import store
from wolfmark_ledger.pricing import Catalogue, Rate, Tier

NOW = 1798765432.0  # fixed clock for stable observed_at values


def news_module():
    spec = importlib.util.find_spec("wolfmark_ledger.news")
    assert spec is not None, "news module has not been implemented"
    return importlib.import_module("wolfmark_ledger.news")


def book(rows, source="fixture cache", as_of="2026-11-01T00:00:00+00:00"):
    providers: dict[str, dict[str, Rate]] = {}
    for provider, model, rate in rows:
        providers.setdefault(provider, {})[model] = rate
    return Catalogue(providers, source, "test", as_of, "1")


def plans_doc(plans, sources=()):
    return {"catalogue_version": "test", "generated_at": "2026-11-01T00:00:00Z",
            "plans": plans, "sources": list(sources)}


def plan(plan_id, family="demo", amount=10.0, currency="USD", source="demo-source",
         windows=("monthly-credits",)):
    return {"id": plan_id, "provider_family": family, "name": f"{family} {plan_id}",
            "price": {"amount": amount, "currency": currency, "period": "month"},
            "entitlements": {"windows": list(windows)},
            "verification": {"source_id": source}}


class NewsTestCase(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory(dir=os.environ.get("TMPDIR"))
        self.addCleanup(self.scratch.cleanup)
        self.data = Path(self.scratch.name) / "plugin-data"
        self.events = Path(self.scratch.name) / "usage.db"
        self.home = Path(self.scratch.name) / "hermes-home"

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


# ------------------------------------------------------------------ local

class LocalSnapshotTests(NewsTestCase):
    def test_first_snapshot_establishes_baseline_not_news(self):
        news = news_module()
        result = news.refresh_local(data_dir=self.data, catalogue=book([
            ("acme", "alpha", Rate(1.0, 2.0))]),
            plans_doc=plans_doc([plan("demo.basic")]), now=NOW)
        self.assertTrue(result["baseline"])
        self.assertEqual(result["items"], [])
        self.assertTrue((self.data / "news-snapshot.json").exists())
        self.assertTrue((self.data / "news-local.json").exists())

    def test_new_model_detected_with_rates_and_listing_disclaimer(self):
        news = news_module()
        first = book([("acme", "alpha", Rate(1.0, 2.0))])
        news.refresh_local(data_dir=self.data, catalogue=first,
                           plans_doc=plans_doc([]), now=NOW)
        second = book([("acme", "alpha", Rate(1.0, 2.0)),
                       ("acme", "beta", Rate(0.5, 1.5, 0.05, 0.1))])
        result = news.refresh_local(data_dir=self.data, catalogue=second,
                                    plans_doc=plans_doc([]), now=NOW + 10)
        self.assertFalse(result["baseline"])
        self.assertEqual(len(result["items"]), 1)
        item = result["items"][0]
        self.assertEqual(item["category"], "new_model")
        self.assertEqual(item["provider"], "acme")
        self.assertEqual(item["model"], "beta")
        self.assertEqual(item["origin"], "local")
        self.assertIsNone(item["previous"])
        self.assertEqual(item["current"]["input"], 0.5)
        self.assertIn("not confirmed available", item["conditions"])
        self.assertIn("beta", item["summary"])

    def test_new_provider_grouped_into_single_item(self):
        news = news_module()
        news.refresh_local(data_dir=self.data, catalogue=book([
            ("acme", "alpha", Rate(1.0, 2.0))]),
            plans_doc=plans_doc([]), now=NOW)
        result = news.refresh_local(data_dir=self.data, catalogue=book([
            ("acme", "alpha", Rate(1.0, 2.0)),
            ("fresh", "one", Rate(1.0, 1.0)),
            ("fresh", "two", Rate(2.0, 2.0))]),
            plans_doc=plans_doc([]), now=NOW + 10)
        provider_items = [i for i in result["items"] if i["provider"] == "fresh"]
        self.assertEqual(len(provider_items), 1)
        self.assertEqual(provider_items[0]["category"], "new_model")
        self.assertIn("2", provider_items[0]["summary"])

    def test_removed_models_reported_in_meta_not_as_news(self):
        news = news_module()
        news.refresh_local(data_dir=self.data, catalogue=book([
            ("acme", "alpha", Rate(1.0, 2.0)),
            ("acme", "gone", Rate(1.0, 2.0))]),
            plans_doc=plans_doc([]), now=NOW)
        result = news.refresh_local(data_dir=self.data, catalogue=book([
            ("acme", "alpha", Rate(1.0, 2.0))]),
            plans_doc=plans_doc([]), now=NOW + 10)
        self.assertEqual(result["items"], [])
        self.assertEqual(result["removed_model_count"], 1)
        self.assertEqual(result["removed_models"], [{"provider": "acme", "model": "gone"}])

    def test_price_reduction_and_increase_direction(self):
        news = news_module()
        news.refresh_local(data_dir=self.data, catalogue=book([
            ("acme", "down", Rate(3.0, 15.0)),
            ("acme", "up", Rate(1.0, 2.0))]),
            plans_doc=plans_doc([]), now=NOW)
        result = news.refresh_local(data_dir=self.data, catalogue=book([
            ("acme", "down", Rate(2.0, 10.0)),
            ("acme", "up", Rate(1.5, 2.0))]),
            plans_doc=plans_doc([]), now=NOW + 10)
        by_model = {item["model"]: item for item in result["items"]}
        self.assertEqual(by_model["down"]["category"], "price_reduction")
        self.assertEqual(by_model["down"]["previous"]["input"], 3.0)
        self.assertEqual(by_model["down"]["current"]["input"], 2.0)
        self.assertEqual(by_model["up"]["category"], "price_increase")

    def test_tier_only_change_is_detected(self):
        news = news_module()
        news.refresh_local(data_dir=self.data, catalogue=book([
            ("acme", "tiered", Rate(1.0, 2.0))]),
            plans_doc=plans_doc([]), now=NOW)
        result = news.refresh_local(data_dir=self.data, catalogue=book([
            ("acme", "tiered", Rate(1.0, 2.0, tiers=(Tier(200_000, 2.0, 4.0),)))]),
            plans_doc=plans_doc([]), now=NOW + 10)
        self.assertEqual(len(result["items"]), 1)
        self.assertIn(result["items"][0]["category"], ("price_reduction", "price_increase"))
        self.assertIn("Tiered", result["items"][0]["conditions"])

    def test_repeat_refresh_without_changes_adds_no_duplicates(self):
        news = news_module()
        first = book([("acme", "alpha", Rate(1.0, 2.0))])
        news.refresh_local(data_dir=self.data, catalogue=first,
                           plans_doc=plans_doc([]), now=NOW)
        second = book([("acme", "alpha", Rate(1.0, 2.0)),
                       ("acme", "beta", Rate(0.5, 1.5))])
        once = news.refresh_local(data_dir=self.data, catalogue=second,
                                  plans_doc=plans_doc([]), now=NOW + 10)
        twice = news.refresh_local(data_dir=self.data, catalogue=second,
                                   plans_doc=plans_doc([]), now=NOW + 20)
        self.assertEqual(len(once["items"]), 1)
        self.assertEqual([i["id"] for i in twice["items"]],
                         [i["id"] for i in once["items"]])

    def test_source_switch_to_fallback_emits_no_model_news(self):
        news = news_module()
        cache = book([("acme", "alpha", Rate(1.0, 2.0))],
                     source="models.dev cache (models_dev_cache.json)")
        news.refresh_local(data_dir=self.data, catalogue=cache,
                           plans_doc=plans_doc([]), now=NOW)
        bundled = book([("acme", "alpha", Rate(9.0, 9.0)),
                        ("acme", "beta", Rate(1.0, 1.0))],
                       source="bundled models.dev snapshot")
        result = news.refresh_local(data_dir=self.data, catalogue=bundled,
                                    plans_doc=plans_doc([]), now=NOW + 10)
        self.assertEqual(result["items"], [])
        self.assertEqual(result["removed_model_count"], 0)

    def test_return_to_cache_rebaselines_quietly(self):
        news = news_module()
        cache = book([("acme", "alpha", Rate(1.0, 2.0))],
                     source="models.dev cache (models_dev_cache.json)")
        bundled = book([("acme", "alpha", Rate(9.0, 9.0))],
                       source="bundled models.dev snapshot")
        news.refresh_local(data_dir=self.data, catalogue=cache,
                           plans_doc=plans_doc([]), now=NOW)
        news.refresh_local(data_dir=self.data, catalogue=bundled,
                           plans_doc=plans_doc([]), now=NOW + 10)
        result = news.refresh_local(data_dir=self.data, catalogue=cache,
                                    plans_doc=plans_doc([]), now=NOW + 20)
        self.assertEqual(result["items"], [])

    def test_plans_still_diff_across_source_switch(self):
        news = news_module()
        cache = book([("acme", "alpha", Rate(1.0, 2.0))],
                     source="models.dev cache (models_dev_cache.json)")
        news.refresh_local(data_dir=self.data, catalogue=cache,
                           plans_doc=plans_doc([plan("demo.basic", amount=10.0)]),
                           now=NOW)
        bundled = book([("acme", "alpha", Rate(9.0, 9.0))],
                       source="bundled models.dev snapshot")
        result = news.refresh_local(
            data_dir=self.data, catalogue=bundled, now=NOW + 10,
            plans_doc=plans_doc([plan("demo.basic", amount=12.0)]))
        self.assertEqual(len(result["items"]), 1)
        self.assertEqual(result["items"][0]["category"], "subscription")

    def test_stored_items_survive_reload(self):
        news = news_module()
        news.refresh_local(data_dir=self.data,
                           catalogue=book([("acme", "alpha", Rate(1.0, 2.0))]),
                           plans_doc=plans_doc([]), now=NOW)
        news.refresh_local(data_dir=self.data,
                           catalogue=book([("acme", "alpha", Rate(9.0, 9.0))]),
                           plans_doc=plans_doc([]), now=NOW + 10)
        reloaded = news.load_items(news.items_path(self.data))
        self.assertTrue(reloaded["loaded"])
        self.assertEqual(len(reloaded["items"]), 1)
        self.assertEqual(reloaded["items"][0]["category"], "price_increase")


class PlanCatalogueTests(NewsTestCase):
    def test_new_plan_fee_change_and_terms_change(self):
        news = news_module()
        news.refresh_local(data_dir=self.data, catalogue=book([]),
                           plans_doc=plans_doc([plan("demo.basic", amount=10.0)]),
                           now=NOW)
        result = news.refresh_local(
            data_dir=self.data, catalogue=book([]), now=NOW + 10,
            plans_doc=plans_doc([
                plan("demo.basic", amount=12.0),
                plan("demo.pro", amount=30.0),
            ], sources=[{"id": "demo-source", "url": "https://example.com/pricing"}]))
        by_id = {item["summary"]: item for item in result["items"]}
        self.assertEqual(len(result["items"]), 2)
        fee_item = next(item for item in result["items"] if "demo.basic" in item["summary"]
                        or "basic" in item["summary"])
        self.assertEqual(fee_item["category"], "subscription")
        self.assertIn("10", fee_item["summary"])
        self.assertIn("12", fee_item["summary"])
        self.assertEqual(fee_item["source_url"], "https://example.com/pricing")
        new_item = next(item for item in result["items"] if item is not fee_item)
        self.assertIn("pro", new_item["summary"])

    def test_allowance_terms_change_without_fee_change(self):
        news = news_module()
        news.refresh_local(data_dir=self.data, catalogue=book([]),
                           plans_doc=plans_doc([plan("demo.basic", windows=("a",))]),
                           now=NOW)
        result = news.refresh_local(
            data_dir=self.data, catalogue=book([]), now=NOW + 10,
            plans_doc=plans_doc([plan("demo.basic", windows=("a", "b"))]))
        self.assertEqual(len(result["items"]), 1)
        self.assertIn("allowance", result["items"][0]["summary"].lower())

    def test_removed_plan_counted_not_listed(self):
        news = news_module()
        news.refresh_local(data_dir=self.data, catalogue=book([]),
                           plans_doc=plans_doc([plan("demo.basic"), plan("demo.old")]),
                           now=NOW)
        result = news.refresh_local(data_dir=self.data, catalogue=book([]),
                                    plans_doc=plans_doc([plan("demo.basic")]),
                                    now=NOW + 10)
        self.assertEqual(result["items"], [])
        self.assertEqual(result["removed_plan_count"], 1)

    def test_repeated_allowance_changes_each_reported(self):
        news = news_module()
        news.refresh_local(data_dir=self.data, catalogue=book([]),
                           plans_doc=plans_doc([plan("demo.basic", windows=("a",))]),
                           now=NOW)
        news.refresh_local(data_dir=self.data, catalogue=book([]), now=NOW + 10,
                           plans_doc=plans_doc([plan("demo.basic", windows=("a", "b"))]))
        result = news.refresh_local(data_dir=self.data, catalogue=book([]), now=NOW + 20,
                                    plans_doc=plans_doc([plan("demo.basic", windows=("a", "b", "c"))]))
        self.assertEqual(len(result["items"]), 2)
        self.assertEqual(len({item["id"] for item in result["items"]}), 2)

    def test_upgrade_from_raw_snapshot_reports_no_false_plan_news(self):
        news = news_module()
        catalogue_path = (Path(__file__).resolve().parents[1]
                          / "catalogue" / "plans.json")
        raw = json.loads(catalogue_path.read_text(encoding="utf-8-sig"))
        # Actual pre-PR24 snapshot shape: the raw doc straight into the
        # table, with no normalisation stamp.
        legacy = news.snapshot_catalogue(book([]), raw)
        legacy.pop("plans_normalised", None)
        target = news.snapshot_path(self.data)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(legacy), encoding="utf-8")
        news.save_settings(False, news.settings_path(self.data))
        result = news.refresh_local(data_dir=self.data, catalogue=book([]))
        self.assertFalse(result["baseline"])
        self.assertEqual(result["items"], [])
        stored = json.loads(target.read_text(encoding="utf-8"))
        self.assertTrue(stored.get("plans_normalised"))
        # Migration is idempotent and preserves genuine changes.
        migrated = news._migrate_snapshot_plans(legacy["plans"])
        self.assertEqual(news._migrate_snapshot_plans(migrated), migrated)
        changed = json.loads(json.dumps(mem.load_plan_catalogue(raw)))
        priced = next(p for p in changed["plans"]
                      if p["price"]["amount"] is not None)
        priced["price"]["amount"] += 1
        items, _ = news.diff_snapshots(
            {"providers": {}, "plans": migrated},
            {"providers": {}, "plans": news._plans_table(changed)},
            observed_at="2026-11-04T00:00:00Z", plans_doc=changed)
        self.assertEqual(len(items), 1)
        self.assertIn("fee", items[0]["summary"])

    def plan_with_terms(self, plan_id, entitlements, amount=10.0, **extra):
        plan = {"id": plan_id, "provider_family": "demo",
                "name": f"demo {plan_id}",
                "price": {"amount": amount, "currency": "USD",
                          "period": "month"},
                "entitlements": entitlements,
                "verification": {"source_id": "demo-source"}}
        plan.update(extra)
        return plan

    def test_verification_only_touch_emits_no_news(self):
        # F139: re-verifying a plan (checked_at/notes) changes no allowance,
        # price or feature, so it must not mint a subscription update.
        news = news_module()
        catalogue_path = (Path(__file__).resolve().parents[1]
                          / "catalogue" / "plans.json")
        raw = json.loads(catalogue_path.read_text(encoding="utf-8-sig"))
        before = mem.load_plan_catalogue(raw)
        touched = json.loads(json.dumps(raw))
        target = next(p for p in touched["plans"]
                      if p["id"] == "alibaba-coding-plan.standard")
        target["entitlements"]["verification"]["checked_at"] = "2026-11-20"
        target["entitlements"]["verification"]["notes"] = "reworded notes"
        after = mem.load_plan_catalogue(touched)
        old_table = news._plans_table(before)
        new_table = news._plans_table(after)
        self.assertNotEqual(old_table["alibaba-coding-plan.standard"]["terms"],
                            new_table["alibaba-coding-plan.standard"]["terms"])
        items, _ = news.diff_snapshots(
            {"providers": {}, "plans": old_table},
            {"providers": {}, "plans": new_table},
            observed_at="2026-11-20T00:00:00Z", plans_doc=after)
        self.assertEqual(items, [])

    def test_repeated_metadata_touches_mint_no_updates(self):
        # F139: equivalent metadata-only touches repeat as nothing at all.
        news = news_module()
        first = {"windows": [{"id": "w", "limit": "percent"}],
                 "verification": {"checked_at": "2026-11-01"}}
        news.refresh_local(data_dir=self.data, catalogue=book([]),
                           plans_doc=plans_doc(
                               [self.plan_with_terms("demo.basic", first)]),
                           now=NOW)
        for day in ("2026-11-02", "2026-11-03"):
            terms = {"windows": [{"id": "w", "limit": "percent"}],
                     "verification": {"checked_at": day}}
            result = news.refresh_local(
                data_dir=self.data, catalogue=book([]), now=NOW + 10,
                plans_doc=plans_doc([self.plan_with_terms("demo.basic",
                                                           terms)]))
            self.assertEqual(result["items"], [])

    def test_window_prose_reword_emits_no_news(self):
        # F139: label/detail prose is display text; the structural allowance
        # beneath it is unchanged.
        news = news_module()
        old = {"windows": [{"id": "w", "limit": "percent",
                            "label": "Current week", "detail": "Weekly cap."}]}
        new = {"windows": [{"id": "w", "limit": "percent",
                            "label": "This week", "detail": "Cap each week."}]}
        news.refresh_local(data_dir=self.data, catalogue=book([]),
                           plans_doc=plans_doc(
                               [self.plan_with_terms("demo.basic", old)]),
                           now=NOW)
        result = news.refresh_local(
            data_dir=self.data, catalogue=book([]), now=NOW + 10,
            plans_doc=plans_doc([self.plan_with_terms("demo.basic", new)]))
        self.assertEqual(result["items"], [])

    def test_price_representation_only_change_emits_no_news(self):
        # F139: 10 vs 10.0 is one fee in two spellings, not a fee change.
        news = news_module()
        news.refresh_local(data_dir=self.data, catalogue=book([]),
                           plans_doc=plans_doc([plan("demo.basic", amount=10)]),
                           now=NOW)
        result = news.refresh_local(
            data_dir=self.data, catalogue=book([]), now=NOW + 10,
            plans_doc=plans_doc([plan("demo.basic", amount=10.0)]))
        self.assertEqual(result["items"], [])

    def test_window_limit_change_reports_field_with_before_after(self):
        # F139: fee unchanged, so the summary names the changed field and
        # both values instead of a generic allowances note.
        news = news_module()
        old = {"windows": [{"id": "current-week", "limit": "percent"}]}
        new = {"windows": [{"id": "current-week", "limit": "credit_value_usd",
                            "amount": 20.0, "currency": "USD"}]}
        news.refresh_local(data_dir=self.data, catalogue=book([]),
                           plans_doc=plans_doc(
                               [self.plan_with_terms("demo.basic", old)]),
                           now=NOW)
        result = news.refresh_local(
            data_dir=self.data, catalogue=book([]), now=NOW + 10,
            plans_doc=plans_doc([self.plan_with_terms("demo.basic", new)]))
        self.assertEqual(len(result["items"]), 1)
        item = result["items"][0]
        self.assertEqual(item["category"], "subscription")
        self.assertIn("'current-week' limit", item["summary"])
        self.assertIn("percent → credit_value_usd", item["summary"])
        params = item["summary_params"]
        self.assertFalse(params["fee_changed"])
        self.assertTrue(params["terms_changed"])
        limit = next(change for change in params["field_changes"]
                     if change["label"] == "'current-week' limit")
        self.assertEqual(limit["kind"], "changed")
        self.assertEqual(limit["field"], "allowance")
        self.assertEqual(limit["before"], "percent")
        self.assertEqual(limit["after"], "credit_value_usd")

    def test_window_added_and_removed_name_the_window(self):
        news = news_module()
        news.refresh_local(data_dir=self.data, catalogue=book([]),
                           plans_doc=plans_doc([plan("demo.basic",
                                                     windows=("a",))]),
                           now=NOW)
        result = news.refresh_local(
            data_dir=self.data, catalogue=book([]), now=NOW + 10,
            plans_doc=plans_doc([plan("demo.basic", windows=("a", "b"))]))
        self.assertEqual(len(result["items"]), 1)
        added = result["items"][0]["summary_params"]["field_changes"]
        self.assertEqual(len(added), 1)
        self.assertEqual(added[0]["kind"], "added")
        self.assertEqual(added[0]["label"], "'b'")
        self.assertIn("allowance window 'b' added",
                      result["items"][0]["summary"])
        result = news.refresh_local(
            data_dir=self.data, catalogue=book([]), now=NOW + 20,
            plans_doc=plans_doc([plan("demo.basic", windows=("a",))]))
        self.assertEqual(len(result["items"]), 2)
        removed = result["items"][0]["summary_params"]["field_changes"]
        self.assertEqual(removed[0]["kind"], "removed")
        self.assertEqual(removed[0]["label"], "'b'")

    def test_model_availability_change_is_reported(self):
        news = news_module()
        old = {"models": {}}
        new = {"models": {"opus": {"scope": "model", "window": "opus-week"}}}
        news.refresh_local(data_dir=self.data, catalogue=book([]),
                           plans_doc=plans_doc(
                               [self.plan_with_terms("demo.basic", old)]),
                           now=NOW)
        result = news.refresh_local(
            data_dir=self.data, catalogue=book([]), now=NOW + 10,
            plans_doc=plans_doc([self.plan_with_terms("demo.basic", new)]))
        self.assertEqual(len(result["items"]), 1)
        (change,) = result["items"][0]["summary_params"]["field_changes"]
        self.assertEqual((change["kind"], change["field"]), ("added", "model"))
        self.assertIn("model availability 'opus' added",
                      result["items"][0]["summary"])

    def test_reset_policy_change_carries_before_after(self):
        news = news_module()
        old = {"reset_policy": {"type": "rolling_windows"}}
        new = {"reset_policy": {"type": "calendar_month"}}
        news.refresh_local(data_dir=self.data, catalogue=book([]),
                           plans_doc=plans_doc(
                               [self.plan_with_terms("demo.basic", old)]),
                           now=NOW)
        result = news.refresh_local(
            data_dir=self.data, catalogue=book([]), now=NOW + 10,
            plans_doc=plans_doc([self.plan_with_terms("demo.basic", new)]))
        self.assertEqual(len(result["items"]), 1)
        (change,) = result["items"][0]["summary_params"]["field_changes"]
        self.assertEqual(change["field"], "reset_policy")
        self.assertEqual(change["before"], "rolling_windows")
        self.assertEqual(change["after"], "calendar_month")

    def test_profile_change_is_reported_when_both_sides_carry_it(self):
        news = news_module()
        old = self.plan_with_terms("demo.basic", {},
                                   billing_arrangement="recurring_subscription",
                                   kind="subscription")
        new = self.plan_with_terms("demo.basic", {},
                                   billing_arrangement="prepaid_metered_wallet",
                                   kind="subscription")
        news.refresh_local(data_dir=self.data, catalogue=book([]),
                           plans_doc=plans_doc([old]), now=NOW)
        result = news.refresh_local(
            data_dir=self.data, catalogue=book([]), now=NOW + 10,
            plans_doc=plans_doc([new]))
        self.assertEqual(len(result["items"]), 1)
        (change,) = result["items"][0]["summary_params"]["field_changes"]
        self.assertEqual((change["field"], change["label"]),
                         ("profile", "billing arrangement"))
        self.assertIn("billing arrangement", result["items"][0]["summary"])

    def test_consecutive_profile_only_changes_each_reported(self):
        # Review: profile values join the event identity, so successive
        # profile-only transitions cannot collapse onto one id and lose
        # the later update to the retry guard.
        news = news_module()
        terms = {"windows": ["monthly-credits"]}
        news.refresh_local(
            data_dir=self.data, catalogue=book([]), now=NOW,
            plans_doc=plans_doc([self.plan_with_terms(
                "demo.basic", terms, kind="subscription",
                billing_arrangement="recurring_subscription",
                seat_pricing={"usual_minimum": 1})]))
        result = news.refresh_local(
            data_dir=self.data, catalogue=book([]), now=NOW + 10,
            plans_doc=plans_doc([self.plan_with_terms(
                "demo.basic", terms, kind="subscription",
                billing_arrangement="recurring_subscription",
                seat_pricing={"usual_minimum": 2})]))
        self.assertEqual(len(result["items"]), 1)
        result = news.refresh_local(
            data_dir=self.data, catalogue=book([]), now=NOW + 20,
            plans_doc=plans_doc([self.plan_with_terms(
                "demo.basic", terms, kind="subscription",
                billing_arrangement="recurring_subscription",
                seat_pricing={"usual_minimum": 3})]))
        self.assertEqual(len(result["items"]), 2)
        self.assertEqual(len({item["id"] for item in result["items"]}), 2)

    def test_duplicate_window_ids_report_values_not_vacuous_count(self):
        # Review: unpairable ids with matching counts must show the structural
        # before/after values, never a vacuous N → N.
        news = news_module()
        old = {"windows": [{"id": "w", "amount": 1}, {"id": "w", "amount": 2}]}
        new = {"windows": [{"id": "w", "amount": 1}, {"id": "w", "amount": 3}]}
        news.refresh_local(data_dir=self.data, catalogue=book([]),
                           plans_doc=plans_doc(
                               [self.plan_with_terms("demo.basic", old)]),
                           now=NOW)
        result = news.refresh_local(
            data_dir=self.data, catalogue=book([]), now=NOW + 10,
            plans_doc=plans_doc([self.plan_with_terms("demo.basic", new)]))
        self.assertEqual(len(result["items"]), 1)
        (change,) = result["items"][0]["summary_params"]["field_changes"]
        self.assertEqual(change["field"], "allowance")
        self.assertIn('"amount": 2', change["before"])
        self.assertIn('"amount": 3', change["after"])
        self.assertNotIn("2 → 2", result["items"][0]["summary"])

    def test_id_less_windows_fall_back_to_an_honest_count(self):
        news = news_module()
        old = {"windows": [{"limit": "percent"}]}
        new = {"windows": [{"limit": "percent"}, {"limit": "requests"}]}
        news.refresh_local(data_dir=self.data, catalogue=book([]),
                           plans_doc=plans_doc(
                               [self.plan_with_terms("demo.basic", old)]),
                           now=NOW)
        result = news.refresh_local(
            data_dir=self.data, catalogue=book([]), now=NOW + 10,
            plans_doc=plans_doc([self.plan_with_terms("demo.basic", new)]))
        self.assertEqual(len(result["items"]), 1)
        (change,) = result["items"][0]["summary_params"]["field_changes"]
        self.assertEqual((change["before"], change["after"]), ("1", "2"))
        self.assertIn("allowance window count: 1 → 2",
                      result["items"][0]["summary"])
        self.assertNotIn("window window", result["items"][0]["summary"])

    def test_profile_skipped_when_snapshot_predates_the_keys(self):
        # F139: pre-upgrade snapshots lack profile keys; the upgrade refresh
        # must not report their appearance as news.
        news = news_module()
        news.refresh_local(data_dir=self.data, catalogue=book([]),
                           plans_doc=plans_doc([plan("demo.basic")]), now=NOW)
        target = news.snapshot_path(self.data)
        snapshot = json.loads(target.read_text(encoding="utf-8"))
        for row in snapshot["plans"].values():
            for key in ("kind", "billing_arrangement", "seat_pricing",
                        "access", "model_restrictions"):
                row.pop(key, None)
        target.write_text(json.dumps(snapshot), encoding="utf-8")
        richer = self.plan_with_terms(
            "demo.basic", {"windows": ["monthly-credits"]},
            kind="subscription", billing_arrangement="recurring_subscription",
            seat_pricing={"prices": {"month": {"amount": 25.0}}},
            access={"cli": True}, model_restrictions=["m"])
        result = news.refresh_local(
            data_dir=self.data, catalogue=book([]), now=NOW + 10,
            plans_doc=plans_doc([richer]))
        self.assertEqual(result["items"], [])


# ------------------------------------------------------------------ settings

class SettingsTests(NewsTestCase):
    def test_live_updates_off_by_default(self):
        news = news_module()
        settings = news.load_settings(news.settings_path(self.data))
        self.assertFalse(settings["live_updates"])

    def test_corrupt_settings_fail_closed_to_off(self):
        news = news_module()
        target = news.settings_path(self.data)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text("{not json")
        self.assertFalse(news.load_settings(target)["live_updates"])
        target.write_text(json.dumps({"live_updates": "yes"}))
        self.assertFalse(news.load_settings(target)["live_updates"])

    def test_settings_roundtrip(self):
        news = news_module()
        self.assertTrue(news.save_settings(True, news.settings_path(self.data))["live_updates"])
        self.assertTrue(news.load_settings(news.settings_path(self.data))["live_updates"])
        self.assertFalse(news.save_settings(False, news.settings_path(self.data))["live_updates"])
        self.assertFalse(news.load_settings(news.settings_path(self.data))["live_updates"])

    def test_settings_reject_non_boolean(self):
        news = news_module()
        with self.assertRaises(ValueError):
            news.save_settings("yes", news.settings_path(self.data))


# ------------------------------------------------------------------ central

def feed_item(item_id="c-1", category="price_reduction", provider="acme",
              model="alpha", **overrides):
    item = {"id": item_id, "category": category, "provider": provider,
            "model": model, "summary": f"{model} got cheaper.",
            "previous": {"input": 3.0, "output": 15.0, "cache_read": 0.3,
                         "cache_write": 3.75},
            "current": {"input": 2.0, "output": 10.0, "cache_read": 0.2,
                        "cache_write": 2.5},
            "observed_at": "2026-11-02T00:00:00+00:00", "effective_at": "",
            "source_url": "https://example.com/pricing",
            "confidence": "verified", "provenance": "models.dev",
            "conditions": ""}
    item.update(overrides)
    return item


def feed_doc(items):
    return {"version": 1, "generated_at": "2026-11-02T00:00:00+00:00",
            "items": items}


class FeedValidationTests(NewsTestCase):
    def test_valid_feed_passes(self):
        news = news_module()
        feed, problems = news.validate_feed(feed_doc([feed_item()]))
        self.assertIsNotNone(feed)
        self.assertEqual(problems, [])
        self.assertEqual(feed["items"][0]["origin"], "central")

    def test_bad_items_dropped_with_reasons(self):
        news = news_module()
        feed, problems = news.validate_feed(feed_doc([
            feed_item("good"),
            feed_item("bad-category", category="rumour"),
            feed_item("bad-url", source_url="ftp://example.com/x"),
            feed_item("no-rates", category="price_increase", previous=None,
                      current=None),
            feed_item("good"),  # duplicate id
            "not-an-object",
        ]))
        self.assertIsNotNone(feed)
        self.assertEqual([item["id"] for item in feed["items"]], ["good"])
        self.assertGreaterEqual(len(problems), 5)

    def test_wrong_version_rejected(self):
        news = news_module()
        feed, _ = news.validate_feed({"version": 99, "items": []})
        self.assertIsNone(feed)
        feed, _ = news.validate_feed(["not", "an", "object"])
        self.assertIsNone(feed)

    def test_feed_truncated_to_cap(self):
        news = news_module()
        feed, problems = news.validate_feed(feed_doc(
            [feed_item(f"c-{n}") for n in range(news.FEED_MAX_ITEMS + 5)]))
        self.assertIsNotNone(feed)
        self.assertEqual(len(feed["items"]), news.FEED_MAX_ITEMS)
        self.assertTrue(any("truncated" in problem for problem in problems))

    def test_client_truncation_keeps_newest(self):
        news = news_module()
        entries = [feed_item(f"c-{n:03d}",
                             observed_at=f"2026-01-{n // 24 + 1:02d}T{n % 24:02d}:00:00+00:00")
                   for n in range(news.FEED_MAX_ITEMS + 5)]
        feed, _ = news.validate_feed(feed_doc(entries))
        kept = {item["id"] for item in feed["items"]}
        self.assertEqual(len(kept), news.FEED_MAX_ITEMS)
        self.assertIn("c-204", kept)
        self.assertNotIn("c-000", kept)

    def test_truncation_prefers_subscriptions_and_preferred_providers(self):
        # F138: at the cap, subscriptions and eligible providers survive
        # ahead of the unsupported long tail, however new it is.
        news = news_module()
        subs = [feed_item(f"s-{n}", category="subscription", provider="demo",
                          model="", previous=None, current=None,
                          observed_at="2026-01-01T00:00:00+00:00")
                for n in range(5)]
        native = [feed_item(f"n-{n}", provider="openai",
                            observed_at="2026-02-01T00:00:00+00:00")
                  for n in range(5)]
        rest = [feed_item(f"u-{n:03d}", provider="uberllm",
                          observed_at=f"2026-03-{(n % 27) + 1:02d}"
                                      f"T{n % 24:02d}:00:00+00:00")
                for n in range(news.FEED_MAX_ITEMS)]
        feed, problems = news.validate_feed(
            feed_doc(subs + native + rest),
            prefer=set(news.NATIVE_FEED_PROVIDERS))
        self.assertIsNotNone(feed)
        kept = {item["id"] for item in feed["items"]}
        self.assertEqual(len(kept), news.FEED_MAX_ITEMS)
        for n in range(5):
            self.assertIn(f"s-{n}", kept)
            self.assertIn(f"n-{n}", kept)
        self.assertTrue(any("truncated" in problem for problem in problems))
        stamps = [item["observed_at"] for item in feed["items"]]
        self.assertEqual(stamps, sorted(stamps, reverse=True))

    def test_non_finite_feed_rates_rejected(self):
        news = news_module()
        bad = feed_item("bad-inf", current={"input": float("inf"), "output": 1.0,
                                            "cache_read": None, "cache_write": None})
        feed, problems = news.validate_feed(feed_doc([feed_item("good"), bad]))
        self.assertEqual([item["id"] for item in feed["items"]], ["good"])
        self.assertTrue(problems)

    def test_has_tiers_flag_survives_validation(self):
        news = news_module()
        entry = feed_item("tiered")
        entry["has_tiers"] = True
        feed, problems = news.validate_feed(feed_doc([entry]))
        self.assertEqual(problems, [])
        self.assertTrue(feed["items"][0]["has_tiers"])


class CentralFetchTests(NewsTestCase):
    def fake_response(self, payload):
        body = json.dumps(payload).encode("utf-8")
        response = mock.MagicMock()
        response.read.return_value = body
        response.__enter__.return_value = response
        response.__exit__.return_value = False
        return response

    def test_disabled_makes_no_request(self):
        news = news_module()
        with mock.patch.object(news, "urlopen") as opener:
            result = news.fetch_central(data_dir=self.data, now=NOW)
        opener.assert_not_called()
        self.assertEqual(result["state"], "disabled")

    def test_request_carries_no_user_data(self):
        news = news_module()
        news.save_settings(True, news.settings_path(self.data))
        seen = {}

        def opener(request, timeout=None):
            seen["url"] = request.full_url
            seen["headers"] = {key.lower(): value
                               for key, value in request.header_items()}
            return self.fake_response(feed_doc([feed_item()]))

        with mock.patch.object(news, "urlopen", side_effect=opener):
            result = news.fetch_central(data_dir=self.data, now=NOW)
        self.assertEqual(result["state"], "ok")
        self.assertEqual(seen["url"], news.FEED_URL)
        self.assertTrue(seen["url"].startswith("https://"))
        self.assertNotIn("?", seen["url"])
        # Header names are protocol constants; values must carry no user data.
        joined = (seen["url"] + " " + " ".join(seen["headers"].values())).lower()
        for banned in ("user=", "account", "credential", "usage",
                       "subscription", "token="):
            self.assertNotIn(banned, joined)
        self.assertEqual(set(seen["headers"]), {"accept", "user-agent"})

    def test_fetch_prefers_configured_custom_providers_at_cap(self):
        # F138: intake keeps this profile's eligible updates when the cap
        # binds, even when the unsupported flood is newer.
        news = news_module()
        news.save_settings(True, news.settings_path(self.data))
        self.write_auth({"groq": [{"token": "secret"}]})
        groq = [feed_item(f"g-{n}", provider="groq",
                          observed_at="2026-01-01T00:00:00+00:00")
                for n in range(5)]
        rest = [feed_item(f"u-{n:03d}", provider="uberllm",
                          observed_at=f"2026-03-{(n % 27) + 1:02d}"
                                      f"T{n % 24:02d}:00:00+00:00")
                for n in range(news.FEED_MAX_ITEMS + 5)]
        with mock.patch.object(news, "urlopen",
                               return_value=self.fake_response(
                                   feed_doc(groq + rest))):
            result = news.fetch_central(data_dir=self.data, home=self.home,
                                        now=NOW)
        self.assertEqual(result["state"], "ok")
        kept = {item["id"] for item in result["feed"]["items"]}
        self.assertEqual(len(kept), news.FEED_MAX_ITEMS)
        for n in range(5):
            self.assertIn(f"g-{n}", kept)

    def test_successful_fetch_cached(self):
        news = news_module()
        news.save_settings(True, news.settings_path(self.data))
        with mock.patch.object(news, "urlopen",
                               return_value=self.fake_response(feed_doc([feed_item()]))):
            first = news.fetch_central(data_dir=self.data, now=NOW)
        self.assertEqual(first["state"], "ok")
        self.assertTrue((self.data / "news-feed-cache.json").exists())
        with mock.patch.object(news, "urlopen") as opener:
            second = news.fetch_central(data_dir=self.data, now=NOW + 60)
        opener.assert_not_called()
        self.assertEqual(second["state"], "ok")

    def test_oversize_response_rejected(self):
        news = news_module()
        news.save_settings(True, news.settings_path(self.data))
        big = mock.MagicMock()
        big.read.return_value = b"x" * (news.FEED_MAX_BYTES + 1)
        big.__enter__.return_value = big
        big.__exit__.return_value = False
        with mock.patch.object(news, "urlopen", return_value=big):
            result = news.fetch_central(data_dir=self.data, now=NOW)
        self.assertEqual(result["state"], "error")
        self.assertIsNone(result["feed"])

    def test_offline_keeps_cache_and_reports_error(self):
        news = news_module()
        news.save_settings(True, news.settings_path(self.data))
        with mock.patch.object(news, "urlopen",
                               return_value=self.fake_response(feed_doc([feed_item()]))):
            news.fetch_central(data_dir=self.data, now=NOW)
        with mock.patch.object(news, "urlopen", side_effect=OSError("offline")):
            result = news.fetch_central(data_dir=self.data, now=NOW + news.FEED_CACHE_SECONDS + 1,
                                        force=True)
        self.assertEqual(result["state"], "stale")
        self.assertIsNotNone(result["feed"])
        self.assertIn("unavailable", result["error"])

    def test_offline_without_cache_is_error_not_crash(self):
        news = news_module()
        news.save_settings(True, news.settings_path(self.data))
        with mock.patch.object(news, "urlopen", side_effect=OSError("offline")):
            result = news.fetch_central(data_dir=self.data, now=NOW)
        self.assertEqual(result["state"], "error")
        self.assertIsNone(result["feed"])


# ------------------------------------------------------------------ ranking

class RankingTests(NewsTestCase):
    def test_for_you_prefers_configured_providers_and_used_models(self):
        # F138: usage annotates a configured provider, but usage alone never
        # qualifies a now-unconfigured one — evidence without membership.
        news = news_module()
        self.write_auth({"commandcode": [{"token": "secret"}],
                         "openrouter": [{"token": "secret"}]})
        self.create_events([
            {"provider": "openrouter", "model": "acme/alpha",
             "input_tokens": 100, "output_tokens": 50},
            {"provider": "uberllm", "model": "beta",
             "input_tokens": 100, "output_tokens": 50},
        ])
        items = [
            {"id": "a", "origin": "local", "category": "new_model",
             "provider": "commandcode", "model": "other",
             "observed_at": "2026-11-02T00:00:00+00:00"},
            {"id": "b", "origin": "local", "category": "price_reduction",
             "provider": "openrouter", "model": "acme/alpha",
             "observed_at": "2026-11-02T00:00:00+00:00"},
            {"id": "c", "origin": "local", "category": "new_model",
             "provider": "stranger", "model": "zzz",
             "observed_at": "2026-11-02T00:00:00+00:00"},
            {"id": "d", "origin": "local", "category": "price_reduction",
             "provider": "uberllm", "model": "beta",
             "observed_at": "2026-11-02T00:00:00+00:00"},
        ]
        evidence = news.usage_summary(self.events, days=90, now=NOW)
        ranked = news.rank_items(items, usage=evidence,
                                 tokens=news.configured_tokens(self.home))
        by_id = {item["id"]: item for item in ranked}
        self.assertTrue(by_id["a"]["for_you"])
        self.assertTrue(by_id["a"]["configured_provider"])
        self.assertTrue(by_id["b"]["for_you"])
        self.assertEqual(by_id["b"]["related_routes"], ["openrouter"])
        self.assertFalse(by_id["c"]["for_you"])
        self.assertEqual(by_id["c"]["related_routes"], [])
        self.assertFalse(by_id["d"]["for_you"])
        self.assertEqual(by_id["d"]["related_routes"], ["uberllm"])
        self.assertTrue(by_id["d"]["last_used_at"])

    def test_ranking_without_usage_or_credentials_marks_nothing(self):
        news = news_module()
        ranked = news.rank_items(
            [{"id": "a", "origin": "local", "category": "new_model",
              "provider": "acme", "model": "alpha",
              "observed_at": "2026-11-02T00:00:00+00:00"}],
            usage={}, tokens=set())
        self.assertFalse(ranked[0]["for_you"])

    def test_emptied_credential_slot_marks_nothing_for_you(self):
        # F138: an emptied pool entry is residue, not a configured provider.
        news = news_module()
        self.write_auth({"copilot": [], "huggingface": [{"token": "secret"}]})
        ranked = news.rank_items(
            [{"id": "a", "origin": "local", "category": "new_model",
              "provider": "github-copilot", "model": "copilot-x",
              "observed_at": "2026-11-02T00:00:00+00:00"},
             {"id": "b", "origin": "local", "category": "new_model",
              "provider": "huggingface", "model": "acme/alpha",
              "observed_at": "2026-11-02T00:00:00+00:00"}],
            usage={}, tokens=news.configured_tokens(self.home))
        by_id = {item["id"]: item for item in ranked}
        self.assertFalse(by_id["a"]["for_you"])
        self.assertFalse(by_id["a"]["configured_provider"])
        self.assertTrue(by_id["b"]["for_you"])
        self.assertTrue(by_id["b"]["configured_provider"])


# ------------------------------------------------------------------ impact

class ImpactTests(NewsTestCase):
    def item(self, **overrides):
        item = {"id": "x", "category": "price_reduction", "provider": "acme",
                "model": "alpha",
                "previous": {"input": 3.0, "output": 15.0, "cache_read": 0.3,
                             "cache_write": None},
                "current": {"input": 1.5, "output": 7.5, "cache_read": 0.15,
                            "cache_write": None}}
        item.update(overrides)
        return item

    def test_full_estimate_from_input_output_and_cache(self):
        news = news_module()
        tokens = {"input": 1_000_000, "output": 100_000, "cache_read": 2_000_000,
                  "cache_write": 0, "calls": 4}
        result = news.estimate_impact(self.item(), tokens)
        self.assertEqual(result["basis"], "full")
        self.assertAlmostEqual(result["old_usd"], 3.0 + 1.5 + 0.6)
        self.assertAlmostEqual(result["new_usd"], 1.5 + 0.75 + 0.3)
        self.assertAlmostEqual(result["delta_usd"], result["new_usd"] - result["old_usd"])
        self.assertEqual(result["window_days"], news.IMPACT_DAYS)

    def test_unpriced_cache_tokens_make_partial_estimate(self):
        news = news_module()
        tokens = {"input": 1_000_000, "output": 0, "cache_read": 0,
                  "cache_write": 500_000, "calls": 2}
        result = news.estimate_impact(self.item(), tokens)
        self.assertEqual(result["basis"], "partial")
        self.assertIn("cache", result["reason"])
        self.assertAlmostEqual(result["old_usd"], 3.0)

    def test_one_sided_cache_rate_excluded_from_both_totals(self):
        news = news_module()
        item = self.item(
            previous={"input": 2.0, "output": 4.0, "cache_read": None, "cache_write": None},
            current={"input": 2.0, "output": 4.0, "cache_read": 0.2, "cache_write": None})
        tokens = {"input": 1_000_000, "output": 0, "cache_read": 1_000_000,
                  "cache_write": 0, "calls": 3}
        result = news.estimate_impact(item, tokens)
        self.assertEqual(result["basis"], "partial")
        self.assertAlmostEqual(result["old_usd"], result["new_usd"])
        self.assertAlmostEqual(result["delta_usd"], 0.0)

    def test_tiered_price_change_is_partial(self):
        news = news_module()
        item = self.item(has_tiers=True)
        tokens = {"input": 1_000_000, "output": 100_000, "cache_read": 0,
                  "cache_write": 0, "calls": 4}
        result = news.estimate_impact(item, tokens)
        self.assertEqual(result["basis"], "partial")
        self.assertIn("tier", result["reason"])

    def test_no_usage_is_unavailable(self):
        news = news_module()
        result = news.estimate_impact(self.item(), {"input": 0, "output": 0,
                                                    "cache_read": 0, "cache_write": 0})
        self.assertEqual(result["basis"], "unavailable")

    def test_missing_rates_are_unavailable(self):
        news = news_module()
        result = news.estimate_impact(self.item(previous=None, current=None),
                                      {"input": 100, "output": 100,
                                       "cache_read": 0, "cache_write": 0})
        self.assertEqual(result["basis"], "unavailable")

    def test_impacts_computed_only_for_matching_used_models(self):
        news = news_module()
        self.create_events([
            {"provider": "acme", "model": "alpha", "input_tokens": 1_000_000,
             "output_tokens": 0},
            {"provider": "other", "model": "zzz", "input_tokens": 5,
             "output_tokens": 5, "ts": NOW - news.IMPACT_DAYS * 86_400 - 10},
        ])
        usage = news.usage_summary(self.events, days=news.IMPACT_DAYS, now=NOW)
        impacts = news.compute_impacts(
            [self.item(), self.item(id="unsubscribed", provider="ghost")], usage)
        self.assertIn("x", impacts)
        self.assertNotIn("unsubscribed", impacts)
        self.assertEqual(impacts["x"]["basis"], "full")


# ------------------------------------------------------------------ payloads

class PayloadTests(NewsTestCase):
    def test_news_payload_is_read_only(self):
        news = news_module()
        payload = news.news_payload(data_dir=self.data, event_db=self.events,
                                    home=self.home, now=NOW)
        self.assertTrue(payload["ok"])
        self.assertFalse(payload["settings"]["live_updates"])
        self.assertEqual(payload["local"]["items"], [])
        self.assertTrue(payload["local"]["baseline"])
        self.assertEqual(payload["central"]["state"], "disabled")
        self.assertFalse((self.data / "news-snapshot.json").exists())
        self.assertFalse((self.data / "news-local.json").exists())

    def test_refresh_payload_combines_local_and_cached_central(self):
        news = news_module()
        news.refresh_local(data_dir=self.data,
                           catalogue=book([("acme", "alpha", Rate(3.0, 15.0))]),
                           plans_doc=plans_doc([]), now=NOW)
        news.save_settings(True, news.settings_path(self.data))
        with mock.patch.object(news, "urlopen",
                               return_value=self.fake(feed_doc([feed_item("c-9")]))):
            payload = news.refresh_payload(
                data_dir=self.data, event_db=self.events, home=self.home,
                catalogue=book([("acme", "alpha", Rate(2.0, 10.0))]),
                plans_doc=plans_doc([]), now=NOW + 10)
        self.assertFalse(payload["local"]["baseline"])
        self.assertEqual(len(payload["local"]["items"]), 1)
        self.assertEqual(payload["central"]["state"], "ok")
        self.assertEqual([i["id"] for i in payload["central"]["items"]], ["c-9"])

    def fake(self, payload):
        body = json.dumps(payload).encode("utf-8")
        response = mock.MagicMock()
        response.read.return_value = body
        response.__enter__.return_value = response
        response.__exit__.return_value = False
        return response

    def test_disabled_hides_cached_central_items(self):
        news = news_module()
        news.refresh_local(data_dir=self.data,
                           catalogue=book([("acme", "alpha", Rate(1.0, 2.0))]),
                           plans_doc=plans_doc([]), now=NOW)
        news.save_settings(True, news.settings_path(self.data))
        with mock.patch.object(news, "urlopen",
                               return_value=self.fake(feed_doc([feed_item("c-1")]))):
            news.refresh_payload(data_dir=self.data, event_db=self.events,
                                 home=self.home,
                                 catalogue=book([("acme", "alpha", Rate(1.0, 2.0))]),
                                 plans_doc=plans_doc([]), now=NOW + 10)
        news.save_settings(False, news.settings_path(self.data))
        payload = news.news_payload(data_dir=self.data, event_db=self.events,
                                    home=self.home, now=NOW + 20)
        self.assertEqual(payload["central"]["state"], "disabled_cached")
        self.assertEqual(payload["central"]["items"], [])
        self.assertTrue(payload["central"]["fetched_at"])

    def test_refresh_payload_never_fetches_when_disabled(self):
        news = news_module()
        with mock.patch.object(news, "urlopen") as opener:
            payload = news.refresh_payload(
                data_dir=self.data, event_db=self.events, home=self.home,
                catalogue=book([("acme", "alpha", Rate(1.0, 2.0))]),
                plans_doc=plans_doc([]), now=NOW)
        opener.assert_not_called()
        self.assertTrue(payload["local"]["baseline"])
        self.assertEqual(payload["central"]["state"], "disabled")


# ------------------------------------------------------------------ eligibility

class EligibilityTests(NewsTestCase):
    """F138: All Updates shows Hermes-native providers and subscription
    items — nothing else. For You is scoped by configuration instead, so a
    configured custom route can be personal without being native."""

    def test_native_providers_need_no_configuration(self):
        news = news_module()
        for provider in ("openai", "anthropic", "google", "google-vertex",
                         "amazon-bedrock", "azure", "moonshotai", "zai",
                         "z-ai", "minimax", "deepseek", "xai", "alibaba",
                         "openrouter", "nous", "huggingface", "github-copilot",
                         "commandcode", "opencode", "opencode-go",
                         "opencode-zen", "kilocode", "ollama-cloud", "arcee",
                         "lmstudio", "nvidia", "xiaomi", "stepfun"):
            self.assertTrue(news.provider_eligible(provider), provider)

    def test_router_identity_stays_distinct_from_direct_providers(self):
        # A model available through OpenRouter belongs under OpenRouter: the
        # router spelling never normalises to a direct provider, and a
        # non-native vendor is not eligible by association with it.
        news = news_module()
        self.assertEqual(news._provider_keys("openrouter"), {"openrouter"})
        self.assertTrue(news.provider_eligible("openrouter"))
        self.assertTrue(news.item_eligible(
            {"category": "price_reduction", "provider": "openrouter",
             "model": "acme/alpha"}))
        self.assertFalse(news.provider_eligible("acme"))

    def test_unsupported_providers_excluded_even_when_configured(self):
        # A configured custom/plugin route does not satisfy the native-only
        # All Updates rule; it surfaces in For You instead.
        news = news_module()
        self.assertFalse(news.provider_eligible("uberllm"))
        self.assertFalse(news.provider_eligible("groq"))
        self.assertFalse(news.item_eligible(
            {"category": "new_model", "provider": "uberllm", "model": "x"}))
        self.assertFalse(news.item_eligible(
            {"category": "new_model", "provider": "groq", "model": "x"}))

    def test_alias_spellings_resolve_to_the_same_eligibility(self):
        news = news_module()
        # Config-side and curated spellings canonicalise onto feed spellings.
        self.assertTrue(news.provider_eligible("openai-codex"))
        self.assertTrue(news.provider_eligible("github-copilot"))
        self.assertTrue(news.provider_eligible("openai"))

    def test_subscription_items_are_always_eligible(self):
        news = news_module()
        self.assertTrue(news.item_eligible(
            {"category": "subscription", "provider": "cline-pass",
             "model": ""}))
        self.assertFalse(news.item_eligible(
            {"category": "new_model", "provider": "cline-pass",
             "model": "x"}))

    def test_payload_flags_eligibility_and_reports_excluded(self):
        news = news_module()
        news.refresh_local(
            data_dir=self.data,
            catalogue=book([("openai", "alpha", Rate(3.0, 15.0)),
                            ("uberllm", "beta", Rate(3.0, 15.0))]),
            plans_doc=plans_doc([]), now=NOW)
        news.refresh_local(
            data_dir=self.data,
            catalogue=book([("openai", "alpha", Rate(2.0, 10.0)),
                            ("uberllm", "beta", Rate(2.0, 10.0))]),
            plans_doc=plans_doc([]), now=NOW + 10)
        payload = news.news_payload(data_dir=self.data, event_db=self.events,
                                    home=self.home, now=NOW + 10)
        # The payload keeps every event; scopes filter on the flag.
        by_provider = {item["provider"]: item
                       for item in payload["local"]["items"]}
        self.assertEqual(sorted(by_provider), ["openai", "uberllm"])
        self.assertTrue(by_provider["openai"]["eligible"])
        self.assertFalse(by_provider["uberllm"]["eligible"])
        self.assertEqual(payload["unsupported_excluded"]["local"], 1)
        self.assertEqual(payload["unsupported_excluded"]["central"], 0)
        self.assertEqual(payload["unsupported_excluded"]["providers"],
                         ["uberllm"])

    def test_payload_configured_custom_is_personal_but_not_native(self):
        # F138: a configured custom route is For You material (configured)
        # without qualifying for All Updates (not native).
        news = news_module()
        self.write_auth({"groq": [{"token": "secret"}]})
        news.refresh_local(
            data_dir=self.data,
            catalogue=book([("groq", "alpha", Rate(3.0, 15.0))]),
            plans_doc=plans_doc([]), now=NOW)
        news.refresh_local(
            data_dir=self.data,
            catalogue=book([("groq", "alpha", Rate(2.0, 10.0))]),
            plans_doc=plans_doc([]), now=NOW + 10)
        payload = news.news_payload(data_dir=self.data, event_db=self.events,
                                    home=self.home, now=NOW + 10)
        self.assertEqual(len(payload["local"]["items"]), 1)
        item = payload["local"]["items"][0]
        self.assertFalse(item["eligible"])
        self.assertTrue(item["for_you"])
        self.assertEqual(payload["unsupported_excluded"]["local"], 1)
        self.assertEqual(payload["for_you_count"], 1)


class CodesTests(NewsTestCase):
    """PR28: stable message codes sit alongside the English strings."""

    def test_local_templates_emit_summary_codes(self):
        news = news_module()
        old = {"providers": {"acme": {"down": {"input": 3.0, "output": 15.0}}}}
        new = {"providers": {
            "acme": {"down": {"input": 2.0, "output": 10.0},
                     "beta": {"input": 0.5, "output": 1.0}},
            "fresh": {"one": {"input": 1.0, "output": 1.0}}}}
        items, _ = news.diff_snapshots(old, new, observed_at="2026-11-05T00:00:00Z")
        by_code = {item["summary_code"]: item for item in items}
        self.assertEqual(by_code["news_sum_new_provider"]["summary_params"],
                         {"provider": "fresh", "count": 1})
        model = by_code["news_sum_new_model"]
        self.assertEqual(model["summary_params"]["model"], "beta")
        self.assertIn("input", model["summary_params"])
        price = by_code["news_sum_price_change"]
        self.assertEqual(price["category"], "price_reduction")
        # English strings keep their exact historical wording.
        self.assertEqual(by_code["news_sum_new_provider"]["summary"],
                         "fresh is newly listed with 1 priced model(s).")
        self.assertIn("reduced to", price["summary"])

    def test_plan_templates_emit_summary_codes(self):
        news = news_module()
        old = {"providers": {}, "plans": {
            "p1": {"name": "Plus", "family": "acme",
                   "price": {"amount": 20, "currency": "USD", "period": "month"}}}}
        new = {"providers": {}, "plans": {
            "p1": {"name": "Plus", "family": "acme",
                   "price": {"amount": 25, "currency": "USD", "period": "month"}},
            "p2": {"name": "Team", "family": "acme",
                   "price": {"amount": 40, "currency": "USD", "period": "month"}}}}
        items, _ = news.diff_snapshots(old, new, observed_at="2026-11-05T00:00:00Z")
        by_code = {item["summary_code"]: item for item in items}
        self.assertEqual(by_code["news_sum_new_plan"]["summary_params"]["plan"], "Team")
        change = by_code["news_sum_plan_change"]["summary_params"]
        self.assertEqual(change["plan"], "Plus")
        self.assertNotEqual(change["fee_before"], change["fee_after"])
        self.assertTrue(change["fee_changed"])
        self.assertIn("terms_changed", change)

    def test_fee_changed_survives_fee_text_rounding(self):
        news = news_module()
        before = {"amount": 1000000, "currency": "VND", "period": "month"}
        after = {"amount": 1000001, "currency": "VND", "period": "month"}
        self.assertEqual(news._fee_text(before), news._fee_text(after))
        old = {"providers": {}, "plans": {
            "p1": {"name": "Plus", "family": "acme", "price": before}}}
        new = {"providers": {}, "plans": {
            "p1": {"name": "Plus", "family": "acme", "price": after}}}
        items, _ = news.diff_snapshots(old, new, observed_at="2026-11-05T00:00:00Z")
        self.assertEqual(len(items), 1)
        params = items[0]["summary_params"]
        self.assertTrue(params["fee_changed"])
        self.assertFalse(params["terms_changed"])
        self.assertIn("fee VND", items[0]["summary"])

    def test_impact_reasons_emit_codes(self):
        news = news_module()
        item = {"id": "x", "category": "price_reduction", "has_tiers": True,
                "previous": {"input": 3.0, "output": 15.0},
                "current": {"input": 1.5, "output": 7.5}}
        tokens = {"input": 1_000_000, "output": 100_000, "cache_read": 0,
                  "cache_write": 0, "calls": 4}
        result = news.estimate_impact(item, tokens)
        self.assertEqual(result["basis"], "partial")
        self.assertEqual(result["reason_codes"], ["news_impact_tiered_rates"])
        empty = news.estimate_impact(item, {"input": 0, "output": 0,
                                            "cache_read": 0, "cache_write": 0})
        self.assertEqual(empty["reason_codes"], ["news_impact_no_usage"])
        norates = news.estimate_impact({**item, "previous": None, "current": None}, tokens)
        self.assertEqual(norates["reason_codes"], ["news_impact_no_rates"])

    def test_feed_codes_pass_through_validation(self):
        news = news_module()
        raw = {"version": 1, "generated_at": "2026-11-05T00:00:00Z", "items": [{
            "id": "c1", "category": "new_model", "provider": "acme", "model": "beta",
            "summary": "curator wording stays", "observed_at": "2026-11-05T00:00:00Z",
            "source_url": "https://example.com/pricing",
            "summary_code": "news_sum_new_model_feed",
            "summary_params": {"model": "beta", "provider": "acme"},
            "conditions": "note", "conditions_code": "news_cond_listing_any_account",
        }]}
        doc, errors = news.validate_feed(raw)
        self.assertEqual(errors, [])
        item = doc["items"][0]
        self.assertEqual(item["summary"], "curator wording stays")
        self.assertEqual(item["summary_code"], "news_sum_new_model_feed")
        self.assertEqual(item["summary_params"], {"model": "beta", "provider": "acme"})
        self.assertEqual(item["conditions_code"], "news_cond_listing_any_account")


if __name__ == "__main__":
    unittest.main()
