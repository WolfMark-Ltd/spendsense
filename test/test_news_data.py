"""Model News data-correctness additions: raw tier capture, honest rate
classification, recurrence detection and exact-model recency.

Companion to test_news.py. Covers the additive local-item fields
(``model_name``, ``tiers_detail``, ``tiers_before``/``tiers_after``,
``official``, ``rate_change_code``), the raw-capture helper, the snapshot
``raw_tiers_v`` stamp, the A→B→A→B recurrence fix, and ``last_used_at``.
"""
from __future__ import annotations

import importlib.util
import json
import os
import re
import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from unittest import mock

from wolfmark_ledger import store
from wolfmark_ledger.pricing import Catalogue, Rate, Tier

NOW = 1798765432.0  # fixed clock for stable observed_at values
FIXTURES = Path(__file__).resolve().parent / "fixtures" / "news"
# Recurrence ids: base id plus "-r" and a 6-char digest (base ids end in a
# 10-char hex digest with no "-r" before it).
RECURRENCE_ID = re.compile(r"-r[0-9a-f]{6}$")


def news_module():
    spec = importlib.util.find_spec("wolfmark_ledger.news")
    assert spec is not None, "news module has not been implemented"
    return importlib.import_module("wolfmark_ledger.news")


def book(rows, source="models.dev cache (models_dev_cache.json)",
         as_of="2026-11-01T00:00:00+00:00"):
    providers: dict[str, dict[str, Rate]] = {}
    for provider, model, rate in rows:
        providers.setdefault(provider, {})[model] = rate
    return Catalogue(providers, source, "test", as_of, "1")


def plans_doc(plans=()):
    return {"catalogue_version": "test", "generated_at": "2026-11-01T00:00:00Z",
            "plans": list(plans), "sources": []}


def plan(plan_id, amount=10.0):
    return {"id": plan_id, "provider_family": "demo", "name": f"demo {plan_id}",
            "price": {"amount": amount, "currency": "USD", "period": "month"},
            "entitlements": {"windows": ["monthly-credits"]},
            "verification": {"source_id": "demo-source"}}


RAW_DOC = {
    "data": {
        "acme": {"models": {
            "alpha": {"name": "Alpha Model",
                      "cost": {"input": 1.0, "output": 2.0,
                               "cache_read": 0.1, "cache_write": 0.2}},
            "tiered": {"name": "Tiered Model",
                       "cost": {"input": 1.0, "output": 2.0, "tiers": [
                           {"input": 2.0, "output": 4.0,
                            "tier": {"type": "context", "size": 200001}}]}},
            "legacy": {"name": "Legacy Model",
                       "cost": {"input": 1.0, "output": 3.0,
                                "context_over_200k": {"input": 2.0, "output": 6.0}}},
            "unnamed": {"cost": {"input": 0.5, "output": 1.0}},
        }},
        "other": {"models": {"x": {"name": "X", "cost": {"input": 1.0, "output": 1.0}}}},
    }
}


def raw_with_type(tier_type):
    """RAW_DOC with the tiered model's tier type swapped; rates unchanged."""
    doc = json.loads(json.dumps(RAW_DOC))
    doc["data"]["acme"]["models"]["tiered"]["cost"]["tiers"][0]["tier"]["type"] = tier_type
    return doc


def tier_row(**overrides):
    row = {"type": "context", "size": 200001, "input": 2.0, "output": 4.0,
           "cache_read": None, "cache_write": None}
    row.update(overrides)
    return row


class NewsDataTestCase(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory(dir=os.environ.get("TMPDIR"))
        self.addCleanup(self.scratch.cleanup)
        self.data = Path(self.scratch.name) / "plugin-data"
        self.events = Path(self.scratch.name) / "usage.db"
        self.home = Path(self.scratch.name) / "hermes-home"
        # Pin the derived cache path away from any real machine state: the
        # name mismatch makes un-injected raw capture deterministically None.
        env = mock.patch.dict(os.environ,
                              {"HERMES_MODELS_DEV_CACHE":
                               str(Path(self.scratch.name) / "absent-cache.json")})
        env.start()
        self.addCleanup(env.stop)

    def refresh(self, catalogue, now=NOW, **kwargs):
        return news_module().refresh_local(data_dir=self.data, catalogue=catalogue,
                                           plans_doc=plans_doc(), now=now, **kwargs)

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


# ------------------------------------------------------------------ raw capture

class RawCaptureTests(NewsDataTestCase):
    def test_missing_file_returns_none(self):
        news = news_module()
        result = news.capture_raw_rows(
            book([("acme", "alpha", Rate(1.0, 2.0))]),
            raw_path=Path(self.scratch.name) / "missing.json")
        self.assertIsNone(result)

    def test_unparseable_file_returns_none(self):
        news = news_module()
        target = Path(self.scratch.name) / "bad.json"
        target.write_text("{oops", encoding="utf-8")
        self.assertIsNone(news.capture_raw_rows(
            book([("acme", "alpha", Rate(1.0, 2.0))]), raw_path=target))

    def test_non_object_doc_returns_none(self):
        news = news_module()
        self.assertIsNone(news.capture_raw_rows(
            book([("acme", "alpha", Rate(1.0, 2.0))]), raw_doc=["nope"]))

    def test_bundled_source_is_mismatch_even_with_injected_doc(self):
        news = news_module()
        bundled = book([("acme", "alpha", Rate(1.0, 2.0))],
                       source="bundled models.dev snapshot")
        self.assertIsNone(news.capture_raw_rows(bundled, raw_doc=RAW_DOC))

    def test_source_filename_mismatch_returns_none(self):
        news = news_module()
        mismatched = book([("acme", "alpha", Rate(1.0, 2.0))],
                          source="models.dev cache (other-cache.json)")
        self.assertIsNone(news.capture_raw_rows(mismatched))

    def test_rows_copied_exactly(self):
        news = news_module()
        rows = news.capture_raw_rows(
            book([("acme", "alpha", Rate(1.0, 2.0)),
                  ("acme", "tiered", Rate(1.0, 2.0, tiers=(Tier(200_001, 2.0, 4.0),))),
                  ("acme", "legacy", Rate(1.0, 3.0)),
                  ("acme", "unnamed", Rate(0.5, 1.0)),
                  ("acme", "ghost", Rate(0.9, 0.9))]),
            raw_doc=RAW_DOC)
        self.assertEqual(rows, {
            ("acme", "alpha"): {"name": "Alpha Model", "tiers_raw": []},
            ("acme", "tiered"): {"name": "Tiered Model", "tiers_raw": [tier_row()]},
            ("acme", "legacy"): {"name": "Legacy Model", "tiers_raw": [
                {"type": "context_over_200k", "size": None, "input": 2.0,
                 "output": 6.0, "cache_read": None, "cache_write": None}]},
            ("acme", "unnamed"): {"name": "", "tiers_raw": []},
        })

    def test_snapshot_rows_always_carry_raw_fields(self):
        news = news_module()
        self.refresh(book([("acme", "alpha", Rate(1.0, 2.0))]), raw_doc=RAW_DOC)
        snapshot = json.loads((self.data / "news-snapshot.json").read_text())
        row = snapshot["providers"]["acme"]["alpha"]
        self.assertEqual(row["name"], "Alpha Model")
        self.assertEqual(row["tiers_raw"], [])
        self.assertEqual(snapshot["raw_tiers_v"], 1)

    def test_snapshot_rows_unknown_without_raw(self):
        news = news_module()
        self.refresh(book([("acme", "alpha", Rate(1.0, 2.0))]))
        snapshot = json.loads((self.data / "news-snapshot.json").read_text())
        row = snapshot["providers"]["acme"]["alpha"]
        self.assertEqual(row["name"], "")
        self.assertIsNone(row["tiers_raw"])
        self.assertEqual(snapshot["raw_tiers_v"], 1)

    def test_upgrade_from_pristine_snapshot_reports_nothing(self):
        news = news_module()
        same = book([("acme", "alpha", Rate(1.0, 2.0)),
                     ("acme", "tiered", Rate(1.0, 2.0, tiers=(Tier(200_001, 2.0, 4.0),)))])
        self.refresh(same, raw_doc=RAW_DOC)
        snapshot = json.loads((self.data / "news-snapshot.json").read_text())
        for models in snapshot["providers"].values():
            for row in models.values():
                row.pop("name", None)
                row.pop("tiers_raw", None)
        snapshot.pop("raw_tiers_v", None)
        (self.data / "news-snapshot.json").write_text(json.dumps(snapshot))
        result = self.refresh(same, now=NOW + 3600, raw_doc=RAW_DOC)
        self.assertEqual(result["items"], [])


# ------------------------------------------------------------------ tier raws

class TierRawChangeTests(NewsDataTestCase):
    def setUp(self):
        super().setUp()
        self.base = book([("acme", "alpha", Rate(1.0, 2.0)),
                          ("acme", "tiered", Rate(1.0, 2.0, tiers=(Tier(200_001, 2.0, 4.0),)))])

    def test_tier_type_change_detected_when_both_sides_raw(self):
        news = news_module()
        self.refresh(self.base, raw_doc=RAW_DOC)
        result = self.refresh(self.base, now=NOW + 3600, raw_doc=raw_with_type("long_context"))
        self.assertEqual(len(result["items"]), 1)
        item = result["items"][0]
        self.assertEqual(item["model"], "tiered")
        self.assertEqual(item["category"], "price_increase")  # unchanged classification
        self.assertEqual(item["rate_change_code"], "news_rate_tiers_only")
        self.assertEqual(item["conditions_code"], "news_cond_tiers_changed")
        self.assertEqual(item["tiers_detail"], "known")
        self.assertEqual(item["tiers_before"], [tier_row()])
        self.assertEqual(item["tiers_after"], [tier_row(type="long_context")])

    def test_tier_type_change_ignored_when_old_side_unknown(self):
        news = news_module()
        self.refresh(self.base)  # no raw: old tiers_raw unknown
        result = self.refresh(self.base, now=NOW + 3600, raw_doc=raw_with_type("long_context"))
        self.assertEqual(result["items"], [])

    def test_tier_type_change_ignored_when_new_side_unknown(self):
        news = news_module()
        self.refresh(self.base, raw_doc=RAW_DOC)
        result = self.refresh(self.base, now=NOW + 3600)  # raw unreadable now
        self.assertEqual(result["items"], [])

    def test_field_change_still_classified_by_fields_despite_raw_change(self):
        news = news_module()
        self.refresh(self.base, raw_doc=RAW_DOC)
        dropped = book([("acme", "alpha", Rate(0.5, 2.0)),
                        ("acme", "tiered", Rate(1.0, 2.0, tiers=(Tier(200_001, 2.0, 4.0),)))])
        result = self.refresh(dropped, now=NOW + 3600, raw_doc=raw_with_type("long_context"))
        by_model = {item["model"]: item for item in result["items"]}
        self.assertEqual(by_model["alpha"]["rate_change_code"], "news_rate_down")
        self.assertEqual(by_model["tiered"]["rate_change_code"], "news_rate_tiers_only")


# ------------------------------------------------------------------ item fields

class ItemFieldTests(NewsDataTestCase):
    def test_model_name_from_raw_on_new_model(self):
        news = news_module()
        self.refresh(book([("acme", "alpha", Rate(1.0, 2.0))]), raw_doc=RAW_DOC)
        doc = json.loads(json.dumps(RAW_DOC))
        doc["data"]["acme"]["models"]["beta"] = {"name": "Beta Model",
                                                 "cost": {"input": 0.5, "output": 1.5}}
        result = self.refresh(book([("acme", "alpha", Rate(1.0, 2.0)),
                                    ("acme", "beta", Rate(0.5, 1.5))]),
                              now=NOW + 3600, raw_doc=doc)
        self.assertEqual(result["items"][0]["model_name"], "Beta Model")

    def test_model_name_empty_when_absent_from_raw(self):
        news = news_module()
        self.refresh(book([("acme", "alpha", Rate(1.0, 2.0))]), raw_doc=RAW_DOC)
        result = self.refresh(book([("acme", "alpha", Rate(1.0, 2.0)),
                                    ("acme", "beta", Rate(0.5, 1.5))]),
                              now=NOW + 3600, raw_doc=RAW_DOC)
        self.assertEqual(result["items"][0]["model_name"], "")
        self.assertEqual(result["items"][0]["tiers_detail"], "unknown")

    def test_model_name_empty_for_bundled_source(self):
        news = news_module()
        self.refresh(book([("acme", "alpha", Rate(1.0, 2.0))],
                          source="bundled models.dev snapshot"))
        result = self.refresh(book([("acme", "alpha", Rate(1.0, 2.0)),
                                    ("acme", "beta", Rate(0.5, 1.5))],
                                   source="bundled models.dev snapshot"),
                              now=NOW + 3600)
        self.assertEqual(result["items"][0]["model_name"], "")
        self.assertEqual(result["items"][0]["tiers_detail"], "unknown")

    def test_price_change_carries_tier_detail_and_code(self):
        news = news_module()
        self.refresh(book([("acme", "alpha", Rate(1.0, 2.0, 0.1, 0.2))]), raw_doc=RAW_DOC)
        result = self.refresh(book([("acme", "alpha", Rate(0.8, 2.0, 0.1, 0.2))]),
                              now=NOW + 3600, raw_doc=RAW_DOC)
        item = result["items"][0]
        self.assertEqual(item["model_name"], "Alpha Model")
        self.assertEqual(item["tiers_detail"], "known")
        self.assertEqual(item["tiers_before"], [])
        self.assertEqual(item["tiers_after"], [])
        self.assertEqual(item["rate_change_code"], "news_rate_down")
        self.assertEqual(item["source_url"], "")

    def test_tiers_unknown_when_raw_unreadable(self):
        news = news_module()
        self.refresh(book([("acme", "alpha", Rate(1.0, 2.0))]), raw_doc=RAW_DOC)
        result = self.refresh(book([("acme", "alpha", Rate(0.5, 2.0))]),
                              now=NOW + 3600,
                              raw_cache_path=Path(self.scratch.name) / "missing.json")
        item = result["items"][0]
        self.assertEqual(item["tiers_detail"], "unknown")
        self.assertEqual(item["tiers_before"], [])  # old side was captured
        self.assertIsNone(item["tiers_after"])  # new raw unreadable
        self.assertEqual(item["model_name"], "")

    def test_official_exact_match_with_windows(self):
        news = news_module()
        self.refresh(book([("anthropic", "sonnet", Rate(3.0, 15.0))]), raw_doc=RAW_DOC)
        doc = json.loads(json.dumps(RAW_DOC))
        doc["data"]["anthropic"] = {"models": {
            "sonnet": {"name": "Sonnet", "cost": {"input": 3.0, "output": 15.0}},
            "claude-haiku-4-5": {"name": "Claude Haiku 4.5",
                                 "cost": {"input": 1.0, "output": 5.0}},
            "claude-haiku-4-5-20251001": {"name": "Claude Haiku 4.5 (2025-10-01)",
                                          "cost": {"input": 1.0, "output": 5.0}},
        }}
        result = self.refresh(book([("anthropic", "sonnet", Rate(3.0, 15.0)),
                                    ("anthropic", "claude-haiku-4-5", Rate(1.0, 5.0)),
                                    ("anthropic", "claude-haiku-4-5-20251001", Rate(1.0, 5.0))]),
                              now=NOW + 3600, raw_doc=doc,
                              official_path=FIXTURES / "official-verified.json")
        by_model = {item["model"]: item for item in result["items"]}
        official = by_model["claude-haiku-4-5"]["official"]
        self.assertEqual(official["verified_at"], "2026-01-02")
        self.assertEqual(official["source_note"],
                         "Anthropic pricing page, Haiku 4.5 row (peak window checked 2026-01)")
        self.assertEqual(official["windows"], [{
            "days": [0, 1, 2, 3, 4], "start_minute": 480, "end_minute": 1020,
            "input": 1.25, "output": 6.25, "cache_read": None, "cache_write": None}])
        self.assertNotIn("official", by_model["claude-haiku-4-5-20251001"])
        self.assertEqual(by_model["claude-haiku-4-5"]["source_url"], "")
        self.assertEqual(by_model["claude-haiku-4-5-20251001"]["source_url"], "")

    def test_official_on_price_change_exact_match(self):
        news = news_module()
        doc = json.loads(json.dumps(RAW_DOC))
        doc["data"]["anthropic"] = {"models": {
            "claude-sonnet-4": {"name": "Claude Sonnet 4",
                                "cost": {"input": 3.0, "output": 15.0}}}}
        self.refresh(book([("anthropic", "claude-sonnet-4", Rate(3.0, 15.0))]),
                     raw_doc=doc)
        result = self.refresh(book([("anthropic", "claude-sonnet-4", Rate(2.0, 14.0))]),
                              now=NOW + 3600, raw_doc=doc,
                              official_path=FIXTURES / "official-verified.json")
        item = result["items"][0]
        self.assertEqual(item["official"]["source_note"],
                         "Anthropic pricing page, Sonnet 4 row")
        self.assertEqual(item["official"]["windows"], [])

    def test_no_official_without_exact_match(self):
        news = news_module()
        self.refresh(book([("acme", "alpha", Rate(1.0, 2.0))]), raw_doc=RAW_DOC)
        result = self.refresh(book([("acme", "alpha", Rate(1.0, 2.0)),
                                    ("acme", "beta", Rate(0.5, 1.5))]),
                              now=NOW + 3600, raw_doc=RAW_DOC,
                              official_path=FIXTURES / "official-verified.json")
        self.assertNotIn("official", result["items"][0])


# ------------------------------------------------------------------ rate codes

class RateChangeCodeTests(NewsDataTestCase):
    def diff_one(self, old_rate, new_rate, *, old_tiers=(), new_tiers=()):
        news = news_module()
        old_doc = {"data": {"acme": {"models": {"m": {"name": "M", "cost": {
            "input": old_rate.input, "output": old_rate.output}}}}}}
        self.refresh(book([("acme", "m", old_rate)]), raw_doc=old_doc)
        result = self.refresh(book([("acme", "m", new_rate)]), now=NOW + 3600,
                              raw_doc=old_doc)
        self.assertEqual(len(result["items"]), 1)
        return result["items"][0]

    def test_cache_write_only_rise_is_up_not_tiers(self):
        item = self.diff_one(Rate(1.0, 2.0, 0.1, 0.2), Rate(1.0, 2.0, 0.1, 0.5))
        self.assertEqual(item["rate_change_code"], "news_rate_up")
        self.assertEqual(item["category"], "price_increase")

    def test_mixed_move(self):
        item = self.diff_one(Rate(3.0, 15.0, 0.3, 3.0), Rate(2.0, 14.0, 0.3, 4.5))
        self.assertEqual(item["rate_change_code"], "news_rate_mixed")
        self.assertEqual(item["category"], "price_reduction")

    def test_plain_reduction(self):
        item = self.diff_one(Rate(3.0, 15.0), Rate(2.0, 10.0))
        self.assertEqual(item["rate_change_code"], "news_rate_down")

    def test_tiers_only_change(self):
        item = self.diff_one(Rate(1.0, 2.0, tiers=(Tier(200_000, 2.0, 4.0),)),
                             Rate(1.0, 2.0, tiers=(Tier(200_000, 2.5, 4.0),)))
        self.assertEqual(item["rate_change_code"], "news_rate_tiers_only")
        self.assertEqual(item["category"], "price_increase")


# ------------------------------------------------------------------ recurrence

class RecurrenceTests(NewsDataTestCase):
    def setUp(self):
        super().setUp()
        self.A = book([("acme", "m", Rate(1.0, 2.0))])
        self.B = book([("acme", "m", Rate(3.0, 4.0))])
        self.snapshot_file = self.data / "news-snapshot.json"
        self.items_file = self.data / "news-local.json"

    def stored_ids(self):
        return [item["id"] for item in
                json.loads(self.items_file.read_text())["items"]]

    def alternating(self, gap):
        self.refresh(self.A, now=NOW)
        self.refresh(self.B, now=NOW + gap)
        self.refresh(self.A, now=NOW + 2 * gap)
        self.refresh(self.B, now=NOW + 3 * gap)

    def test_alternating_transition_within_hours(self):
        self.alternating(3600)
        items = json.loads(self.items_file.read_text())["items"]
        self.assertEqual(len(items), 3)
        ups = [item for item in items if item["category"] == "price_increase"]
        self.assertEqual(len(ups), 2)
        self.assertNotEqual(ups[0]["id"], ups[1]["id"])
        # Exactly one recurrence id: base id plus "-r" and a 6-char digest.
        recurrence = [item for item in items if RECURRENCE_ID.search(item["id"])]
        self.assertEqual(len(recurrence), 1)
        self.assertIn(recurrence[0]["category"], "price_increase")
        downs = [item for item in items if item["category"] == "price_reduction"]
        self.assertEqual(len(downs), 1)

    def test_alternating_transition_over_days(self):
        self.alternating(86_400)
        self.assertEqual(len(self.stored_ids()), 3)

    def test_recurrence_items_keep_original_fields(self):
        self.alternating(3600)
        items = json.loads(self.items_file.read_text())["items"]
        recurrence = [item for item in items if RECURRENCE_ID.search(item["id"])]
        self.assertEqual(len(recurrence), 1)
        original_id = recurrence[0]["id"].rsplit("-r", 1)[0]
        base = [item for item in items if item["id"] == original_id]
        self.assertEqual(len(base), 1)
        self.assertEqual(recurrence[0]["provider"], base[0]["provider"])
        self.assertEqual(recurrence[0]["model"], base[0]["model"])
        self.assertEqual(recurrence[0]["previous"], base[0]["previous"])
        self.assertEqual(recurrence[0]["current"], base[0]["current"])

    def test_crash_reemit_does_not_duplicate(self):
        self.refresh(self.A, now=NOW)
        before = self.snapshot_file.read_text()
        self.refresh(self.B, now=NOW + 3600)
        ids_after_first_emit = self.stored_ids()
        # Simulate the crash: items written, snapshot rolled back.
        self.snapshot_file.write_text(before)
        self.refresh(self.B, now=NOW + 7200)
        self.assertEqual(self.stored_ids(), ids_after_first_emit)

    def test_missing_captured_at_skips_reemit(self):
        self.refresh(self.A, now=NOW)
        self.refresh(self.B, now=NOW + 3600)
        snapshot = json.loads(self.snapshot_file.read_text())
        snapshot.pop("captured_at", None)
        self.snapshot_file.write_text(json.dumps(snapshot))
        self.refresh(self.B, now=NOW + 7200)
        self.assertEqual(len(self.stored_ids()), 1)

    def test_unchanged_refresh_adds_nothing(self):
        self.refresh(self.A, now=NOW)
        self.refresh(self.B, now=NOW + 3600)
        for step in (2, 3):
            self.refresh(self.B, now=NOW + step * 3600)
        self.assertEqual(len(self.stored_ids()), 1)


# ------------------------------------------------------------------ recency

class RecencyTests(NewsDataTestCase):
    def test_usage_summary_includes_last_ts_and_totals(self):
        news = news_module()
        self.create_events([
            {"ts": NOW - 100, "provider": "anthropic", "model": "m1",
             "input_tokens": 10, "output_tokens": 20},
            {"ts": NOW - 50, "provider": "anthropic", "model": "m1",
             "input_tokens": 1, "output_tokens": 2},
        ])
        usage = news.usage_summary(self.events, now=NOW)
        self.assertEqual(usage[("anthropic", "m1")]["input"], 11)
        self.assertEqual(usage[("anthropic", "m1")]["last_ts"], NOW - 50)

    def test_usage_for_item_totals_ignore_last_ts(self):
        news = news_module()
        self.create_events([
            {"ts": NOW - 100, "provider": "anthropic", "model": "m1",
             "input_tokens": 10, "output_tokens": 20},
        ])
        usage = news.usage_summary(self.events, now=NOW)
        totals = news._usage_for_item({"provider": "anthropic", "model": "m1"}, usage)
        self.assertEqual(totals, {"input": 10, "output": 20, "cache_read": 0,
                                  "cache_write": 0, "calls": 1})

    def test_last_used_at_exact_match_only(self):
        news = news_module()
        usage = {
            ("anthropic", "claude-haiku-4-5"): {"last_ts": 100.5},
            ("anthropic", "haiku-4-5"): {"last_ts": 999.0},
            ("openrouter", "claude-haiku-4-5"): {"last_ts": 50.0},
            ("anthropic", "claude-haiku-4-5-20251001"): {"last_ts": 7.0},
        }
        ranked = news.rank_items([
            {"provider": "anthropic", "model": "claude-haiku-4-5"},
            {"provider": "anthropic", "model": ""},
            {"provider": "quiet", "model": "claude-haiku-4-5"},
        ], usage=usage, tokens=set())
        self.assertEqual(ranked[0]["last_used_at"], news._now_iso(100.5))
        self.assertEqual(ranked[1]["last_used_at"], "")
        self.assertEqual(ranked[2]["last_used_at"], "")

    def test_last_used_at_namespaced_item_needs_exact_recorded_model(self):
        news = news_module()
        usage = {
            ("openrouter", "claude-haiku-4-5"): {"last_ts": 42.0},
            ("openrouter", "anthropic/claude-haiku-4-5"): {"last_ts": 7.0},
        }
        ranked = news.rank_items(
            [{"provider": "openrouter", "model": "anthropic/claude-haiku-4-5"}],
            usage=usage, tokens=set())
        self.assertEqual(ranked[0]["last_used_at"], news._now_iso(7.0))

    def test_last_used_takes_maximum(self):
        news = news_module()
        self.create_events([
            {"ts": NOW - 500, "provider": "anthropic", "model": "m1"},
            {"ts": NOW - 50, "provider": "anthropic", "model": "m1"},
        ])
        usage = news.usage_summary(self.events, days=30, now=NOW)
        ranked = news.rank_items([{"provider": "anthropic", "model": "m1"}],
                                 usage=usage, tokens=set())
        self.assertEqual(ranked[0]["last_used_at"], news._now_iso(NOW - 50))


# ------------------------------------------------------------------ compatibility

class CompatTests(NewsDataTestCase):
    def sample_scenario(self, **kwargs):
        news = news_module()
        first = book([("acme", "alpha", Rate(3.0, 15.0, 0.3, 3.0)),
                      ("acme", "tiered", Rate(1.0, 2.0)),
                      ("acme", "flat", Rate(0.5, 1.5, tiers=(Tier(200_000, 2.0, 4.0),)))])
        self.refresh(first, now=NOW, **kwargs)
        second = book([("acme", "alpha", Rate(2.0, 12.0, 0.3, 3.0)),
                       ("acme", "tiered", Rate(1.0, 2.0, tiers=(Tier(200_000, 2.0, 4.0),))),
                       ("acme", "flat", Rate(0.5, 1.5, tiers=(Tier(200_000, 2.5, 4.0),))),
                       ("acme", "beta", Rate(0.5, 1.5, 0.05, 0.1)),
                       ("fresh", "one", Rate(1.0, 1.0))])
        return self.refresh(second, now=NOW + 3600, **kwargs)

    PRISTINE = [
        ("local-price-reduction-acme-alpha--r-----cache-read---0-3---cache-wr-bf0caea292",
         "price_reduction", "news_sum_price_change"),
        ("local-new-model-acme-beta-6adfcf9c69", "new_model", "news_sum_new_model"),
        ("local-price-increase-acme-flat--r-----cache-read---null---cache-wr-9238d1c712",
         "price_increase", "news_sum_price_change"),
        ("local-price-increase-acme-tiered--r-----cache-read---null---cache--279d6f810d",
         "price_increase", "news_sum_price_change"),
        ("local-new-provider-fresh-1-7f4f7a6979", "new_model", "news_sum_new_provider"),
    ]

    def test_sample_diff_ids_and_core_fields_unchanged(self):
        items = self.sample_scenario()["items"]
        observed = sorted((item["id"], item["category"], item["summary_code"])
                          for item in items)
        self.assertEqual(observed, sorted(self.PRISTINE))
        by_id = {item["id"]: item for item in items}
        alpha = by_id[self.PRISTINE[0][0]]
        self.assertEqual(alpha["previous"],
                         {"input": 3.0, "output": 15.0, "cache_read": 0.3,
                          "cache_write": 3.0})
        self.assertEqual(alpha["current"],
                         {"input": 2.0, "output": 12.0, "cache_read": 0.3,
                          "cache_write": 3.0})
        self.assertEqual(alpha["summary"], "alpha (acme) reduced to $2/$12 per MTok in/out.")

    def test_sample_diff_ids_unchanged_with_raw_capture(self):
        items = self.sample_scenario(raw_doc=RAW_DOC)["items"]
        self.assertEqual(sorted((item["id"], item["category"], item["summary_code"])
                                for item in items), sorted(self.PRISTINE))
        alpha = [item for item in items if item["model"] == "alpha"][0]
        self.assertEqual(alpha["model_name"], "Alpha Model")
        self.assertEqual(alpha["previous"],
                         {"input": 3.0, "output": 15.0, "cache_read": 0.3,
                          "cache_write": 3.0})


# ------------------------------------------------------------------ fixtures

class FixtureTests(NewsDataTestCase):
    @staticmethod
    def load_regenerator():
        spec = importlib.util.spec_from_file_location(
            "regenerate_payload", FIXTURES / "regenerate_payload.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_regen_script_reproduces_committed_fixtures(self):
        module = self.load_regenerator()
        for name in ("payload-local-central.json", "payload-unknown-recurrence.json"):
            output = Path(self.scratch.name) / f"regenerated-{name}"
            module.build_payload(output) if name == "payload-local-central.json" \
                else module.build_unknown_recurrence_payload(output)
            committed = (FIXTURES / name).read_text()
            self.assertEqual(output.read_text(), committed, name)

    def test_fixture_covers_unknown_and_recurrence_scenarios(self):
        payload = json.loads(
            (FIXTURES / "payload-unknown-recurrence.json").read_text())
        local = payload["local"]["items"]
        self.assertEqual(len(local), 5)
        recurrence = [item for item in local if RECURRENCE_ID.search(item["id"])]
        self.assertEqual(len(recurrence), 1)
        original = [item for item in local
                    if item["id"] == recurrence[0]["id"].rsplit("-r", 1)[0]]
        self.assertEqual(len(original), 1)
        self.assertEqual(recurrence[0]["category"], "price_increase")
        self.assertEqual(original[0]["category"], "price_increase")
        self.assertEqual(recurrence[0]["previous"], original[0]["previous"])
        reverse = [item for item in local if item["category"] == "price_reduction"
                   and item["model"] == "m1"]
        self.assertEqual(len(reverse), 1)
        unknown_price = [item for item in local
                         if item["model"] == "m2" and "previous" in item]
        self.assertEqual(unknown_price[0]["tiers_detail"], "unknown")
        self.assertIsNone(unknown_price[0]["tiers_before"])
        self.assertEqual(unknown_price[0]["model_name"], "")
        unknown_new = [item for item in local if item["model"] == "m4"]
        self.assertEqual(unknown_new[0]["tiers_detail"], "unknown")
        self.assertIsNone(unknown_new[0]["tiers_after"])
        self.assertEqual(unknown_new[0]["model_name"], "")
        # A central md- item for the same m2 transition; both kept separate.
        central = payload["central"]["items"]
        matching = [item for item in central if item["id"].startswith("md-")
                    and item["provider"] == "acme" and item["model"] == "m2"]
        self.assertEqual(len(matching), 1)
        self.assertEqual(matching[0]["category"], unknown_price[0]["category"])
        self.assertEqual(matching[0]["effective_at"], "")
        self.assertEqual(unknown_price[0]["effective_at"], "")
        self.assertNotEqual(matching[0]["id"], unknown_price[0]["id"])

    def test_fixture_covers_required_scenarios(self):
        payload = json.loads((FIXTURES / "payload-local-central.json").read_text())
        local = payload["local"]["items"]
        models = {(item["provider"], item["model"]) for item in local}
        self.assertIn(("anthropic", "claude-haiku-4-5"), models)
        self.assertIn(("anthropic", "claude-haiku-4-5-20251001"), models)
        self.assertIn(("openrouter", "anthropic/claude-haiku-4-5"), models)
        self.assertIn(("zhipu", ""), models)  # grouped new-provider item
        self.assertIn(("demo", ""), models)  # subscription item
        plain = [item for item in local if item["model"] == "text-plain"]
        self.assertEqual(plain[0]["current"]["cache_read"], None)
        self.assertEqual(plain[0]["current"]["cache_write"], None)
        tiered = [item for item in local if item["model"] == "glm-large"]
        self.assertTrue(tiered[0]["tiers_after"])
        self.assertEqual(tiered[0]["rate_change_code"], "news_rate_tiers_only")
        by_pair = {}
        for item in local + payload["central"]["items"]:
            if item["model"]:
                by_pair.setdefault((item["provider"], item["model"], item["category"]),
                                   []).append(item["origin"])
        origins = by_pair[("anthropic", "claude-sonnet-4", "price_reduction")]
        self.assertEqual(sorted(origins), ["central", "local"])
        self.assertTrue(all(item["source_url"].startswith("https://")
                            for item in payload["central"]["items"]))
        haiku = [item for item in local if item["model"] == "claude-haiku-4-5"][0]
        self.assertEqual(haiku["model_name"], "Claude Haiku 4.5")
        self.assertIn("official", haiku)
        self.assertTrue(haiku["last_used_at"])


# ------------------------------------------------------------------ identity

class ExactModelIdentityTests(NewsDataTestCase):
    def impact_item(self, **overrides):
        item = {"id": "x", "category": "price_reduction", "provider": "acme",
                "model": "alpha",
                "previous": {"input": 3.0, "output": 15.0, "cache_read": 0.3,
                             "cache_write": None},
                "current": {"input": 1.5, "output": 7.5, "cache_read": 0.15,
                            "cache_write": None}}
        item.update(overrides)
        return item

    def used(self, route, model, **tokens):
        return {(route, model): {"input": 1_000_000, "output": 0,
                                 "cache_read": 0, "cache_write": 0,
                                 "calls": 1, "last_ts": NOW - 60, **tokens}}

    def test_bare_vs_namespaced_matches_nothing(self):
        news = news_module()
        usage = self.used("anthropic", "claude-haiku-4-5")
        for model in ("anthropic/claude-haiku-4-5",):
            impacts = news.compute_impacts(
                [self.impact_item(provider="anthropic", model=model)], usage)
            self.assertEqual(impacts, {}, model)
        ranked = news.rank_items(
            [self.impact_item(provider="anthropic",
                              model="anthropic/claude-haiku-4-5")],
            usage=usage, tokens=set())
        self.assertEqual(ranked[0]["related_routes"], [])
        self.assertEqual(ranked[0]["last_used_at"], "")

    def test_namespaced_recorded_vs_bare_item_matches_nothing(self):
        news = news_module()
        usage = self.used("anthropic", "anthropic/claude-haiku-4-5")
        impacts = news.compute_impacts(
            [self.impact_item(provider="anthropic", model="claude-haiku-4-5")],
            usage)
        self.assertEqual(impacts, {})
        ranked = news.rank_items(
            [self.impact_item(provider="anthropic", model="claude-haiku-4-5")],
            usage=usage, tokens=set())
        self.assertEqual(ranked[0]["related_routes"], [])

    def test_cross_namespace_same_suffix_matches_nothing(self):
        news = news_module()
        usage = self.used("acme", "openai/gpt-x")
        impacts = news.compute_impacts(
            [self.impact_item(provider="acme", model="azure/gpt-x")], usage)
        self.assertEqual(impacts, {})
        ranked = news.rank_items(
            [self.impact_item(provider="acme", model="azure/gpt-x")],
            usage=usage, tokens=set())
        self.assertEqual(ranked[0]["related_routes"], [])
        # Provider-used still applies; the model must not add evidence.
        self.assertTrue(ranked[0]["for_you"])

    def test_suffix_match_never_sets_for_you(self):
        news = news_module()
        usage = self.used("openai", "openai/gpt-x")
        ranked = news.rank_items(
            [self.impact_item(provider="azure", model="azure/gpt-x")],
            usage=usage, tokens=set())
        self.assertFalse(ranked[0]["for_you"])
        self.assertEqual(ranked[0]["related_routes"], [])

    def test_provider_only_items_keep_provider_wide_totals(self):
        news = news_module()
        usage = {**self.used("acme", "alpha", input=100),
                 **self.used("acme", "beta", input=200)}
        totals = news._usage_for_item(
            {"provider": "acme", "model": ""}, usage)
        self.assertEqual(totals["input"], 300)

    def test_exact_match_drives_impact_and_routes(self):
        news = news_module()
        usage = self.used("acme", "alpha")
        impacts = news.compute_impacts([self.impact_item()], usage)
        self.assertIn("x", impacts)
        self.assertEqual(impacts["x"]["old_usd"], 3.0)
        self.assertEqual(impacts["x"]["new_usd"], 1.5)
        ranked = news.rank_items([self.impact_item()], usage=usage, tokens=set())
        self.assertEqual(ranked[0]["related_routes"], ["acme"])
        self.assertTrue(ranked[0]["for_you"])
        self.assertEqual(ranked[0]["last_used_at"], news._now_iso(NOW - 60))

    def test_different_suffix_matches_nothing(self):
        news = news_module()
        usage = self.used("acme", "alpha")
        impacts = news.compute_impacts(
            [self.impact_item(model="beta")], usage)
        self.assertEqual(impacts, {})
        ranked = news.rank_items([self.impact_item(model="beta")],
                                 usage=usage, tokens=set())
        self.assertEqual(ranked[0]["related_routes"], [])
        # Provider-used remains; the differing model adds nothing.
        self.assertTrue(ranked[0]["for_you"])


    def test_model_used_under_other_provider_is_not_for_you(self):
        news = news_module()
        usage = self.used("alpha", "shared-model")
        item = self.impact_item(provider="beta", model="shared-model")
        ranked = news.rank_items([item], usage=usage, tokens=set())
        self.assertFalse(ranked[0]["for_you"])
        self.assertFalse(ranked[0]["configured_provider"])
        self.assertEqual(ranked[0]["related_routes"], [])
        self.assertEqual(ranked[0]["last_used_at"], "")
        self.assertEqual(news.compute_impacts([item], usage), {})

    def test_exact_pair_sets_for_you(self):
        news = news_module()
        usage = self.used("alpha", "shared-model")
        ranked = news.rank_items(
            [self.impact_item(provider="alpha", model="shared-model")],
            usage=usage, tokens=set())
        self.assertTrue(ranked[0]["for_you"])
        self.assertEqual(ranked[0]["related_routes"], ["alpha"])

    def test_configured_provider_sets_for_you_without_model_use(self):
        news = news_module()
        usage = self.used("alpha", "shared-model")
        ranked = news.rank_items(
            [self.impact_item(provider="beta", model="shared-model")],
            usage=usage, tokens={"beta"})
        self.assertTrue(ranked[0]["for_you"])
        self.assertTrue(ranked[0]["configured_provider"])

    def test_personalised_payload_gives_no_model_reason_cross_provider(self):
        monitoring = importlib.import_module("wolfmark_ledger.monitoring")
        signals = {"configured_families": [], "used_providers": ["alpha"],
                   "used_models": [{"provider": "alpha", "model": "shared-model"}],
                   "plan_families": []}
        stranger = {"id": "s", "provider": "beta", "model": "shared-model"}
        own = {"id": "o", "provider": "alpha", "model": "shared-model"}
        personalised = monitoring.personalise_items([stranger, own], signals)
        by_id = {item["id"]: item for item in personalised}
        self.assertEqual(by_id["s"]["relevance"], {"relevant": False, "reasons": []})
        # Positive control: the exact pair earns used_model (plus used_provider,
        # since that provider was used at all).
        self.assertEqual(by_id["o"]["relevance"],
                         {"relevant": True, "reasons": ["used_provider", "used_model"]})


if __name__ == "__main__":
    unittest.main()
