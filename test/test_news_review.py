"""WP11 review pins for Model News: raw-tier event identity, deterministic
recurrence retry, honest neutral rate code, and stale-cache tier safety.

Companion to test_news_data.py. Each B-numbered class pins one review
finding:

- B1: a raw tier ``type`` change must produce a distinct event id per
  transition (context→long_context→context stores two items); legacy
  base-rate transitions keep the exact pre-fix id.
- B2: recurrence suffixes must derive from the compared snapshot's
  ``captured_at`` (deterministic across a crash/retry) and stored items,
  including legacy ``-r<hash>`` recurrences, are never rewritten.
- B3: a base-field presence change (None↔number) with tiers unchanged is
  ``news_rate_changed``, never ``news_rate_tiers_only``.
- B4 (expected RED at the time of writing, not yet fixed): when the raw
  cache file changes underneath a catalogue book whose parse is stale
  (same size, restored mtime), captured tier detail must be treated as
  unknown rather than presented as known-from-a-different-version.
- B5: contract pins for the tiers_unknown/tiers_detail semantics that
  must keep working (expected GREEN).
"""
from __future__ import annotations

import hashlib
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from wolfmark_ledger import pricing
from wolfmark_ledger.pricing import Catalogue, Rate, Tier

NOW = 1798765432.0  # fixed clock for stable observed_at values


def news_module():
    import importlib
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


def tier_row(**overrides):
    row = {"type": "context", "size": 200001, "input": 2.0, "output": 4.0,
           "cache_read": None, "cache_write": None}
    row.update(overrides)
    return row


def raw_doc(tier_type="context", tier_input=2.0, base_input=1.0):
    """Raw models.dev doc for acme/m: untiered unless tier_type is given."""
    cost = {"input": base_input, "output": 2.0}
    if tier_type is not None:
        cost["tiers"] = [{"input": tier_input, "output": 4.0,
                          "tier": {"type": tier_type, "size": 200001}}]
    return {"data": {"acme": {"models": {"m": {"name": "M", "cost": cost}}}}}


class NewsReviewTestCase(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory(dir=os.environ.get("TMPDIR"))
        self.addCleanup(self.scratch.cleanup)
        self.data = Path(self.scratch.name) / "plugin-data"
        # Pin the derived cache path away from any real machine state.
        env = mock.patch.dict(os.environ,
                              {"HERMES_MODELS_DEV_CACHE":
                               str(Path(self.scratch.name) / "absent-cache.json")})
        env.start()
        self.addCleanup(env.stop)

    def refresh(self, catalogue, now=NOW, **kwargs):
        return news_module().refresh_local(data_dir=self.data, catalogue=catalogue,
                                           plans_doc=plans_doc(), now=now, **kwargs)

    def stored_items(self):
        target = self.data / "news-local.json"
        return json.loads(target.read_text())["items"]

    def snapshot(self):
        return json.loads((self.data / "news-snapshot.json").read_text())


# ------------------------------------------------------------------ B1

class B1RawTierIdentityTests(NewsReviewTestCase):
    def test_b1_raw_tier_type_round_trip_stores_both_transitions(self):
        news = news_module()
        base = book([("acme", "m", Rate(1.0, 2.0, tiers=(Tier(200_001, 2.0, 4.0),)))])
        self.refresh(base, raw_doc=raw_doc("context"))
        self.refresh(base, now=NOW + 3600, raw_doc=raw_doc("long_context"))
        result = self.refresh(base, now=NOW + 7200, raw_doc=raw_doc("context"))
        changes = [item for item in self.stored_items()
                   if item["category"].startswith("price_")]
        self.assertEqual(len(changes), 2)  # RED at 0d30a7e: second is dropped
        self.assertNotEqual(changes[0]["id"], changes[1]["id"])
        after_types = [item["tiers_after"][0]["type"] for item in changes
                       if item.get("tiers_after")]
        self.assertIn("long_context", after_types)
        self.assertEqual(len(result["items"]), len(self.stored_items()))

    def test_b1_legacy_base_change_keeps_pre_fix_id(self):
        news = news_module()
        self.refresh(book([("acme", "m", Rate(1.0, 2.0))]), raw_doc=raw_doc())
        result = self.refresh(book([("acme", "m", Rate(0.5, 2.0))]),
                              now=NOW + 3600, raw_doc=raw_doc())
        self.assertEqual(len(result["items"]), 1)
        # Byte-identical to the pre-fix formula:
        # _stable_id("price_reduction", "acme", "m" + old_sig + new_sig) with
        # sig = json.dumps({"r": _slim(entry), "t": entry["tiers"]}, sort_keys).
        self.assertEqual(result["items"][0]["id"],
                         "local-price-reduction-acme-m--r-----cache-read---null"
                         "---cache-write-b8f4d45cd8")

    def test_b1_legacy_base_change_new_raw_unreadable_keeps_pre_fix_id(self):
        news = news_module()
        self.refresh(book([("acme", "m", Rate(1.0, 2.0))]), raw_doc=raw_doc())
        result = self.refresh(book([("acme", "m", Rate(0.5, 2.0))]),
                              now=NOW + 3600,
                              raw_cache_path=Path(self.scratch.name) / "missing.json")
        self.assertEqual(len(result["items"]), 1)
        self.assertEqual(result["items"][0]["id"],
                         "local-price-reduction-acme-m--r-----cache-read---null"
                         "---cache-write-b8f4d45cd8")


# ------------------------------------------------------------------ B2

class B2RecurrenceRetryTests(NewsReviewTestCase):
    def setUp(self):
        super().setUp()
        self.A = book([("acme", "m", Rate(1.0, 2.0))])
        self.B = book([("acme", "m", Rate(3.0, 4.0))])
        self.snapshot_file = self.data / "news-snapshot.json"
        self.items_file = self.data / "news-local.json"

    def test_b2_crash_retry_does_not_duplicate_and_is_deterministic(self):
        news = news_module()
        self.refresh(self.A, now=NOW)                    # baseline, captured t0
        self.refresh(self.B, now=NOW + 3600)             # A→B emits up
        self.refresh(self.A, now=NOW + 7200)             # B→A emits down
        pre_crash_snapshot = self.snapshot_file.read_text()
        prev_captured = str(self.snapshot()["captured_at"])
        self.refresh(self.B, now=NOW + 10800)            # A→B recurrence written
        base_up = news._stable_id(
            "price_increase", "acme",
            "m" + json.dumps(
                {"r": {"input": 1.0, "output": 2.0, "cache_read": None,
                       "cache_write": None}, "t": []}, sort_keys=True)
            + json.dumps(
                {"r": {"input": 3.0, "output": 4.0, "cache_read": None,
                       "cache_write": None}, "t": []}, sort_keys=True))
        expected_recurrence = f"{base_up}-r" \
            + hashlib.sha1(prev_captured.encode("utf-8")).hexdigest()[:6]
        ids_after_recurrence = [item["id"] for item in self.stored_items()]
        self.assertIn(expected_recurrence, ids_after_recurrence)
        # Crash: items written, snapshot rolled back to the pre-recurrence one.
        self.snapshot_file.write_text(pre_crash_snapshot)
        result = self.refresh(self.B, now=NOW + 14400)   # same compared snapshot
        self.assertEqual([item["id"] for item in self.stored_items()],
                         ids_after_recurrence)          # RED: duplicate created
        self.assertEqual(len(result["items"]), len(ids_after_recurrence))

    def test_b2_stored_items_retained_byte_for_byte(self):
        news = news_module()
        legacy_recurrence = "local-kept-1111111111-r0a1b2c"
        seeded = [
            {"id": "local-kept-1111111111", "origin": "local", "category": "subscription",
             "provider": "demo", "model": "", "summary": "kept", "observed_at": "kept-ts",
             "note": {"nested": [1, 2, 3]}},
            {"id": legacy_recurrence, "origin": "local", "category": "price_increase",
             "provider": "acme", "model": "m", "summary": "kept recurrence",
             "observed_at": "kept-ts", "previous": {"input": 1.0}},
        ]
        self.items_file.parent.mkdir(parents=True, exist_ok=True)
        self.items_file.write_text(json.dumps(
            {"version": news.NEWS_VERSION, "items": seeded}))
        self.refresh(self.A, now=NOW)
        self.refresh(self.B, now=NOW + 3600)
        self.refresh(self.A, now=NOW + 7200)
        self.refresh(self.B, now=NOW + 10800)  # recurrence path exercised
        stored = self.stored_items()
        for seed in seeded:
            matches = [item for item in stored if item["id"] == seed["id"]]
            self.assertEqual(len(matches), 1, seed["id"])
            self.assertEqual(json.dumps(matches[0], sort_keys=True),
                             json.dumps(seed, sort_keys=True))


# ------------------------------------------------------------------ B3

class B3RateCodeTests(NewsReviewTestCase):
    def diff_one(self, old_rate, new_rate):
        news = news_module()
        self._case = getattr(self, "_case", 0) + 1
        data = self.data / f"case-{self._case}"  # isolated store per case
        news.refresh_local(data_dir=data, catalogue=book([("acme", "m", old_rate)]),
                           plans_doc=plans_doc(), now=NOW, raw_doc=raw_doc(None))
        result = news.refresh_local(
            data_dir=data, catalogue=book([("acme", "m", new_rate)]),
            plans_doc=plans_doc(), now=NOW + 3600, raw_doc=raw_doc(None))
        self.assertEqual(len(result["items"]), 1)
        return result["items"][0]

    def test_b3_cache_read_appears_is_news_rate_changed(self):
        item = self.diff_one(Rate(1.0, 2.0), Rate(1.0, 2.0, 0.3))
        self.assertEqual(item["rate_change_code"], "news_rate_changed")
        self.assertEqual(item["category"], "price_increase")

    def test_b3_cache_read_disappears_is_news_rate_changed(self):
        item = self.diff_one(Rate(1.0, 2.0, 0.3), Rate(1.0, 2.0))
        self.assertEqual(item["rate_change_code"], "news_rate_changed")
        # Note: rate_direction still defaults the removal to price_increase;
        # only the code contract is pinned here.

    def test_b3_tier_change_with_equal_base_stays_tiers_only(self):
        item = self.diff_one(Rate(1.0, 2.0, tiers=(Tier(200_000, 2.0, 4.0),)),
                             Rate(1.0, 2.0, tiers=(Tier(200_000, 2.5, 4.0),)))
        self.assertEqual(item["rate_change_code"], "news_rate_tiers_only")
        self.assertEqual(item["category"], "price_increase")

    def test_b3_down_up_mixed_unchanged(self):
        self.assertEqual(self.diff_one(Rate(3.0, 15.0), Rate(2.0, 10.0))
                         ["rate_change_code"], "news_rate_down")
        self.assertEqual(self.diff_one(Rate(1.0, 2.0, 0.1, 0.2),
                                       Rate(1.0, 2.0, 0.1, 0.5))
                         ["rate_change_code"], "news_rate_up")
        self.assertEqual(self.diff_one(Rate(3.0, 15.0, 0.3, 3.0),
                                       Rate(2.0, 14.0, 0.3, 4.5))
                         ["rate_change_code"], "news_rate_mixed")


# ------------------------------------------------------------------ B4
# Expected RED at the time of writing: the stale-cache tier-safety behaviour
# below is NOT yet implemented. These tests document the required behaviour
# and are marked @unittest.expectedFailure in the commit until fixed.

class B4StaleCacheTierSafetyTests(NewsReviewTestCase):
    """When the raw cache file changes underneath a book parsed from it and
    size/mtime are spoofed back, pricing.load_catalogue serves the stale book
    while capture_raw_rows re-reads the fresh file. Tier detail from the
    fresh read cannot be trusted against the stale book, so it must be
    reported as unknown (tiers_raw None / tiers_detail "unknown") while the
    model name is still surfaced."""

    TIERED_V1 = {
        "data": {"acme": {"models": {
            "m": {"name": "M", "cost": {"input": 1.0, "output": 2.0, "tiers": [
                {"input": 2.0, "output": 4.0,
                 "tier": {"type": "context", "size": 200001}}]}}}}},
        "pad": "x" * 512,  # head-room so the v2 payload is never larger
    }

    def _write_spoofed(self, target: Path, v2: dict) -> None:
        v1_text = json.dumps(self.TIERED_V1)
        stat = target.stat()
        v2_text = json.dumps(v2)
        self.assertLessEqual(len(v2_text), len(v1_text))
        if len(v2_text) < len(v1_text):
            v2_text = v2_text[:-1] + " " * (len(v1_text) - len(v2_text)) + "}"
        target.write_text(v2_text, encoding="utf-8")
        os.utime(target, ns=(stat.st_atime_ns, stat.st_mtime_ns))

    # B4 is RED-only in this commit: the stale-cache tier-safety behaviour is
    # not yet implemented (capture_raw_rows still serves fresh-file tiers
    # against a stale book); these stay until the fix lands.
    @unittest.expectedFailure
    def test_b4a_base_rate_change_yields_unknown_tiers(self):
        news = news_module()
        target = Path(self.scratch.name) / "spoofed-cache.json"
        target.write_text(json.dumps(self.TIERED_V1), encoding="utf-8")
        stale_book = pricing.load_catalogue(target)
        self.refresh(stale_book, raw_cache_path=target)
        v2 = json.loads(json.dumps(self.TIERED_V1))
        v2["data"]["acme"]["models"]["m"]["cost"]["input"] = 1.5
        self._write_spoofed(target, v2)
        rows = news.capture_raw_rows(stale_book, raw_path=target)
        self.assertEqual(rows[("acme", "m")]["name"], "M")
        self.assertIsNone(rows[("acme", "m")]["tiers_raw"])  # RED: v2 list
        self.refresh(stale_book, now=NOW + 3600, raw_cache_path=target)
        row = self.snapshot()["providers"]["acme"]["m"]
        self.assertIsNone(row["tiers_raw"])                  # RED: v2 list
        self.assertEqual(row["name"], "M")
        for item in self.stored_items():
            if item["model"] == "m" and item["category"].startswith("price_"):
                self.assertEqual(item["tiers_detail"], "unknown")  # RED: known
                if item.get("tiers_after") is not None:
                    self.assertIsNone(item["tiers_after"])

    @unittest.expectedFailure
    def test_b4b_tier_rate_change_yields_unknown_tiers(self):
        news = news_module()
        target = Path(self.scratch.name) / "spoofed-cache.json"
        target.write_text(json.dumps(self.TIERED_V1), encoding="utf-8")
        stale_book = pricing.load_catalogue(target)
        self.refresh(stale_book, raw_cache_path=target)
        v2 = json.loads(json.dumps(self.TIERED_V1))
        v2["data"]["acme"]["models"]["m"]["cost"]["tiers"][0]["input"] = 2.5
        self._write_spoofed(target, v2)
        rows = news.capture_raw_rows(stale_book, raw_path=target)
        self.assertEqual(rows[("acme", "m")]["name"], "M")
        self.assertIsNone(rows[("acme", "m")]["tiers_raw"])  # RED: v2 list

    def test_b4c_unchanged_file_yields_known_exact_tiers(self):
        news = news_module()
        target = Path(self.scratch.name) / "steady-cache.json"
        target.write_text(json.dumps(self.TIERED_V1), encoding="utf-8")
        stale_book = pricing.load_catalogue(target)
        self.refresh(stale_book, raw_cache_path=target)
        rows = news.capture_raw_rows(stale_book, raw_path=target)
        self.assertEqual(rows[("acme", "m")],
                         {"name": "M", "tiers_raw": [tier_row()]})
        changed_book = book([("acme", "m",
                              Rate(0.9, 2.0, tiers=(Tier(200_001, 2.0, 4.0),)))],
                            source=stale_book.source, as_of=stale_book.as_of)
        result = self.refresh(changed_book, now=NOW + 3600, raw_cache_path=target)
        item = result["items"][0]
        self.assertEqual(item["tiers_detail"], "known")
        self.assertEqual(item["tiers_before"], [tier_row()])
        self.assertEqual(item["tiers_after"], [tier_row()])


# ------------------------------------------------------------------ B5

class B5TierContractPins(NewsReviewTestCase):
    def test_b5_untiered_change_reports_known_empty_lists(self):
        self.refresh(book([("acme", "m", Rate(1.0, 2.0))]), raw_doc=raw_doc(None))
        result = self.refresh(book([("acme", "m", Rate(0.8, 2.0))]),
                              now=NOW + 3600, raw_doc=raw_doc(None))
        item = result["items"][0]
        self.assertEqual(item["tiers_before"], [])
        self.assertEqual(item["tiers_after"], [])
        self.assertEqual(item["tiers_detail"], "known")

    def test_b5_new_side_raw_unreadable_reports_unknown(self):
        self.refresh(book([("acme", "m",
                            Rate(1.0, 2.0, tiers=(Tier(200_001, 2.0, 4.0),)))]),
                     raw_doc=raw_doc())
        result = self.refresh(book([("acme", "m",
                                     Rate(0.8, 2.0,
                                          tiers=(Tier(200_001, 2.0, 4.0),)))]),
                              now=NOW + 3600,
                              raw_cache_path=Path(self.scratch.name) / "missing.json")
        item = result["items"][0]
        self.assertEqual(item["tiers_before"], [tier_row()])
        self.assertIsNone(item["tiers_after"])
        self.assertEqual(item["tiers_detail"], "unknown")

    def test_b5_new_model_untiered_reports_known(self):
        doc = {"data": {"acme": {"models": {
            "m": {"name": "M", "cost": {"input": 1.0, "output": 2.0}},
            "beta": {"name": "Beta", "cost": {"input": 0.5, "output": 1.5}}}}}}
        self.refresh(book([("acme", "m", Rate(1.0, 2.0))]), raw_doc=doc)
        result = self.refresh(book([("acme", "m", Rate(1.0, 2.0)),
                                    ("acme", "beta", Rate(0.5, 1.5))]),
                              now=NOW + 3600, raw_doc=doc)
        new_items = [item for item in result["items"] if item["model"] == "beta"]
        self.assertEqual(len(new_items), 1)
        self.assertEqual(new_items[0]["category"], "new_model")
        self.assertEqual(new_items[0]["tiers_after"], [])
        self.assertEqual(new_items[0]["tiers_detail"], "known")


if __name__ == "__main__":
    unittest.main()
