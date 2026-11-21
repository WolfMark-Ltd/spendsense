"""WP42 provenance contract: tri-state flags, population scope, signed savings bounds.

Fixtures only; no live store, no network, no state.db writes.
"""
from __future__ import annotations

import os
import re
import sqlite3
import tempfile
import unittest
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

from wolfmark_ledger import aggregate, analytics, collector, store
from wolfmark_ledger.pricing import Catalogue, Rate, Tier

NOW = datetime(2026, 11, 21, 12, tzinfo=timezone.utc).timestamp()

PREMIUM = Rate(2, 10, .1, 2.5)          # write costs more than input
DISCOUNT = Rate(2, 10, .1, 1.0)         # write costs less than input
DISCOUNT2 = Rate(2, 10, .1, 1.5)        # a different discount
AT_INPUT = Rate(2, 10, .1, 2.0)         # write priced at input
FREE_WRITE = Rate(2, 10, .1, 0.0)       # writes recorded but never charged
NO_WRITE_PRICE = Rate(2, 10, .1, None)  # write price unknown
TIER_SUPPLIES_WRITE = Rate(2, 10, .1, None,
                           tiers=(Tier(100, 1, 5, .05, 1.5),))
TIERED = Rate(2, 10, .1, 2.5, tiers=(Tier(272000, 4, 15, .2, 5),))


class ProvenanceContractTests(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory(dir=os.environ.get("TMPDIR"))
        self.addCleanup(self.scratch.cleanup)
        self.events = Path(self.scratch.name) / "usage.db"
        self.state = Path(self.scratch.name) / "state.db"
        self.book = Catalogue(
            {"premium": {"m": PREMIUM}, "discount": {"m": DISCOUNT},
             "discount2": {"m": DISCOUNT2},
             "atinput": {"m": AT_INPUT}, "noprice": {"m": NO_WRITE_PRICE},
             "freewrite": {"m": FREE_WRITE}, "tiered": {"m": TIERED},
             "tierwrite": {"m": TIER_SUPPLIES_WRITE}},
            "fixture", "test", "2026-11-21", "1")

    def tearDown(self):
        # Close and release the module-level writer so Windows can delete the
        # temp dir; a surviving connection keeps usage.db locked.
        if store._WRITER is not None:
            try:
                store._WRITER.close()
            except Exception:  # noqa: BLE001 - cleanup must not mask the test result
                pass
        store._WRITER = None
        store._WRITER_PATH = None

    # -- fixtures ---------------------------------------------------------
    def create_events(self, rows=()):
        with closing(sqlite3.connect(self.events)) as conn, conn:
            conn.executescript(store._SCHEMA)
            for index, row in enumerate(rows):
                values = {"event_id": f"event-{index}", "ts": NOW - 60,
                          "session_id": "s1", "model": "m", "provider": "premium",
                          "platform": "desktop", "outcome": "ok", "recorded_at": NOW,
                          **row}
                columns = list(values)
                conn.execute(f"INSERT INTO calls ({','.join(columns)}) VALUES "
                             f"({','.join('?' for _ in columns)})", list(values.values()))

    def summary(self, **kwargs):
        return analytics.build_session_summary(
            self.events, state_db_path=self.state, catalogue=self.book,
            now=NOW, **kwargs)

    # -- 1. flag semantics ------------------------------------------------
    def test_effective_reported_true_with_zero_is_reported(self):
        self.assertTrue(analytics._reported(True, 0))

    def test_effective_reported_false_stays_false(self):
        self.assertFalse(analytics._reported(False, 0))
        self.assertFalse(analytics._reported(False, 5_000),
                         "an explicit false must never be overridden by a value")

    def test_effective_reported_null_falls_back_to_value(self):
        self.assertFalse(analytics._reported(None, 0))
        self.assertTrue(analytics._reported(None, 12))

    # -- 2. storage migration --------------------------------------------
    def test_migration_adds_columns_once_without_backfill(self):
        legacy_schema = (store._SCHEMA.split("CREATE TABLE IF NOT EXISTS baseline")[0]
                         .replace("    cache_read_reported  INTEGER,\n", "")
                         .replace("    cache_write_reported INTEGER,\n", "")
                         .replace("    call_class           TEXT\n", "")
                         .replace(",\n);", "\n);"))
        with closing(sqlite3.connect(self.events)) as conn, conn:
            conn.executescript(legacy_schema)
            conn.execute("INSERT INTO calls (event_id, ts, outcome, recorded_at) "
                         "VALUES ('old', 1, 'ok', 1)")
        for _ in range(2):  # idempotent
            with closing(sqlite3.connect(self.events)) as conn, conn:
                store._ensure_schema(conn)
        with closing(sqlite3.connect(self.events)) as conn:
            columns = {row[1] for row in conn.execute('PRAGMA table_info("calls")')}
            self.assertTrue({"cache_read_reported", "cache_write_reported",
                             "call_class"} <= columns)
            row = conn.execute("SELECT cache_read_reported, cache_write_reported, "
                               "call_class FROM calls WHERE event_id='old'").fetchone()
        self.assertEqual(row, (None, None, None), "old rows must stay unrecorded")

    # -- 3. collector classification -------------------------------------
    def test_collector_classifies_main_auxiliary_and_unlabelled(self):
        base = {"session_id": "s1", "task_id": "t", "turn_id": "u",
                "api_call_count": 1, "model": "m", "provider": "premium"}
        self.assertEqual(collector._call_class("main", dict(base)), None)
        self.assertEqual(collector._call_class("main", {**base, "aux_task": ""}), "main")
        self.assertEqual(collector._call_class("main", {**base, "aux_task": "background_review"}),
                         "auxiliary")
        self.assertEqual(collector._call_class("aux", {**base, "aux_task": "title"}),
                         "auxiliary")

    def test_collector_keeps_absent_flags_unrecorded(self):
        record = collector._base_record("main", {
            "session_id": "s1", "task_id": "t", "turn_id": "u", "api_call_count": 1,
            "model": "m", "provider": "premium",
            "usage": {"input_tokens": 10, "output_tokens": 2, "cache_read_tokens": 0,
                      "cache_write_tokens": 0, "prompt_tokens": 10, "total_tokens": 12},
        })
        self.assertIsNone(record["cache_write_reported"])
        self.assertEqual(record["cache_write_tokens"], 0)

    def test_collector_preserves_explicit_false_and_zero(self):
        record = collector._base_record("main", {
            "session_id": "s1", "task_id": "t", "turn_id": "u", "api_call_count": 1,
            "model": "m", "provider": "premium", "aux_task": "",
            "usage": {"input_tokens": 10, "output_tokens": 2, "cache_read_tokens": 0,
                      "cache_write_tokens": 0, "cache_read_reported": True,
                      "cache_write_reported": False, "prompt_tokens": 10,
                      "total_tokens": 12},
        })
        self.assertEqual(record["cache_read_reported"], 1)
        self.assertEqual(record["cache_write_reported"], 0)
        self.assertEqual(record["call_class"], "main")

    def test_store_round_trips_the_tri_state(self):
        record = collector._base_record("main", {
            "session_id": "s1", "task_id": "t", "turn_id": "u", "api_call_count": 1,
            "model": "m", "provider": "premium", "aux_task": "title",
            "usage": {"input_tokens": 10, "output_tokens": 2, "cache_read_tokens": 0,
                      "cache_write_tokens": 0, "cache_read_reported": True,
                      "prompt_tokens": 10, "total_tokens": 12},
        })
        store.record(record, path=self.events)
        with closing(sqlite3.connect(self.events)) as conn:
            row = conn.execute("SELECT cache_read_reported, cache_write_reported, "
                               "call_class FROM calls").fetchone()
        self.assertEqual(row, (1, None, "auxiliary"))

    # -- 4. population scope ---------------------------------------------
    def test_summary_refuses_main_without_classification(self):
        self.create_events([{"input_tokens": 100, "cache_read_tokens": 900},
                            {"input_tokens": 50, "cache_read_tokens": 950}])
        out = self.summary(session_id="s1", population="main")
        self.assertFalse(out["population"]["satisfied"])
        self.assertFalse(out["population"]["separable"])
        self.assertEqual(out["population"]["unclassified_calls"], 2)
        self.assertIsNone(out["totals"])
        self.assertIsNone(out["valuation"])
        self.assertEqual(out["alternate"]["totals"]["calls"], 2)
        self.assertEqual(out["notes"][0]["code"], "population_not_recorded")

    def test_summary_filters_main_when_classified(self):
        self.create_events([
            {"input_tokens": 100, "cache_read_tokens": 900, "call_class": "main"},
            {"input_tokens": 200, "cache_read_tokens": 800, "call_class": "main"},
            {"input_tokens": 300, "cache_read_tokens": 700, "call_class": "main"},
            {"input_tokens": 400, "cache_read_tokens": 600, "call_class": "auxiliary",
             "aux_task": "background_review"},
        ])
        main = self.summary(session_id="s1", population="main")
        self.assertTrue(main["population"]["satisfied"])
        self.assertEqual(main["population"]["main_calls"], 3)
        self.assertEqual(main["population"]["auxiliary_calls"], 1)
        self.assertEqual(main["totals"]["calls"], 3)
        self.assertEqual(main["totals"]["input_tokens"], 600)
        every = self.summary(session_id="s1", population="all")
        self.assertEqual(every["totals"]["calls"], 4)

    # -- 5. signed savings bounds ----------------------------------------
    def test_savings_bound_follows_signed_write_premium(self):
        cases = {"premium": ("upper_bound", 0.5), "discount": ("lower_bound", -1.0),
                 "atinput": ("exact", None), "noprice": ("indeterminate", None)}
        for route, (expected, premium) in cases.items():
            with self.subTest(route=route):
                self.create_events([{"provider": route, "input_tokens": 1_000,
                                     "cache_read_tokens": 9_000, "output_tokens": 100}])
                valuation = self.summary(session_id="s1")["valuation"]
                self.assertEqual(valuation["savings_basis"], expected)
                self.assertEqual(valuation["write_premium_usd_per_mtok"], premium)
                os.remove(self.events)

    def test_reported_zero_write_is_exact(self):
        self.create_events([{"input_tokens": 1_000, "cache_read_tokens": 9_000,
                             "output_tokens": 100, "cache_write_reported": 1}])
        valuation = self.summary(session_id="s1")["valuation"]
        totals = self.summary(session_id="s1")["totals"]
        self.assertEqual(valuation["savings_basis"], "exact")
        self.assertIsNone(totals["cache_write_state_reason"])

    def test_absent_write_is_unknown_not_zero(self):
        self.create_events([{"input_tokens": 1_000, "cache_read_tokens": 9_000,
                             "cache_write_reported": 0}])
        totals = self.summary(session_id="s1")["totals"]
        self.assertEqual(totals["cache_write_state"], "unknown")
        self.assertEqual(totals["cache_write_state_reason"], "provider_does_not_report")

    def test_null_write_is_unrecorded(self):
        self.create_events([{"input_tokens": 1_000, "cache_read_tokens": 9_000}])
        totals = self.summary(session_id="s1")["totals"]
        self.assertEqual(totals["cache_write_state"], "unknown")
        self.assertEqual(totals["cache_write_state_reason"], "not_recorded_by_build")

    # -- 6. monetary completeness vs price band --------------------------
    def test_api_equivalent_is_qualified_when_writes_unreported(self):
        self.create_events([{"input_tokens": 1_000, "cache_read_tokens": 9_000,
                             "output_tokens": 100}])
        valuation = self.summary(session_id="s1")["valuation"]
        self.assertEqual(valuation["api_equivalent_basis"], "lower_bound")
        self.assertEqual(valuation["api_equivalent_bound_reason"], "write_not_reported")
        self.assertIsNotNone(valuation["api_equivalent_usd"])

    def test_at_input_write_qualifies_cost_not_savings(self):
        self.create_events([{"provider": "atinput", "input_tokens": 1_000,
                             "cache_read_tokens": 9_000, "output_tokens": 100}])
        valuation = self.summary(session_id="s1")["valuation"]
        self.assertEqual(valuation["savings_basis"], "exact")
        self.assertEqual(valuation["api_equivalent_basis"], "lower_bound",
                         "unrecorded writes priced at input cannot change savings "
                         "but can still raise the cost")

    def test_zero_priced_write_leaves_cost_exact(self):
        self.create_events([{"provider": "freewrite", "input_tokens": 1_000,
                             "cache_read_tokens": 9_000, "output_tokens": 100}])
        valuation = self.summary(session_id="s1")["valuation"]
        self.assertEqual(valuation["api_equivalent_basis"], "exact")
        self.assertEqual(valuation["savings_basis"], "lower_bound")

    def test_mixed_discount_cards_stay_write_driven(self):
        # Two unknown-write calls on different discount cards give no single
        # premium, but the cause is still the missing write counter.
        self.create_events([
            {"provider": "discount", "input_tokens": 1_000,
             "cache_read_tokens": 9_000, "output_tokens": 100},
            {"provider": "discount2", "input_tokens": 1_000,
             "cache_read_tokens": 9_000, "output_tokens": 100},
        ])
        valuation = self.summary(session_id="s1")["valuation"]
        self.assertEqual(valuation["savings_basis"], "lower_bound")
        self.assertEqual(valuation["savings_bound_reason"], "write_not_reported")
        self.assertIsNone(valuation["write_premium_usd_per_mtok"])

    def test_tier_supplied_write_price_is_not_defaulted(self):
        # The base card has no write price; the crossed tier publishes one, so
        # a reported write is fully priced and the cost is exact.
        self.create_events([{"provider": "tierwrite", "input_tokens": 1_000,
                             "output_tokens": 100, "cache_write_reported": 1}])
        valuation = self.summary(session_id="s1")["valuation"]
        self.assertEqual(valuation["api_equivalent_basis"], "exact")
        self.assertIsNone(valuation["api_equivalent_bound_reason"])

    def test_unknown_read_with_proven_write_is_a_lower_bound(self):
        self.create_events([{"input_tokens": 1_000, "cache_read_tokens": 0,
                             "cache_write_tokens": 500, "cache_write_reported": 1,
                             "output_tokens": 100}])
        valuation = self.summary(session_id="s1")["valuation"]
        self.assertEqual(valuation["savings_basis"], "lower_bound")
        self.assertEqual(valuation["savings_bound_reason"], "read_not_reported")

    def test_excluded_call_still_qualifies_the_cost(self):
        # All-zero legacy cache row: excluded from savings, but its unpriced
        # write term still means the API-equivalent total is a lower bound.
        self.create_events([{"input_tokens": 1_000, "output_tokens": 100},
                            {"input_tokens": 1_000, "cache_read_tokens": 9_000,
                             "output_tokens": 100}])
        out = self.summary(session_id="s1")
        self.assertEqual(out["valuation"]["covered_calls"], 1)
        self.assertEqual(out["valuation"]["api_equivalent_basis"], "lower_bound")
        self.assertEqual(out["valuation"]["api_equivalent_bound_reason"],
                         "write_not_reported")

    def test_decreasing_tier_uses_the_effective_price(self):
        cheap = Rate(2, 10, .1, 2.5, tiers=(Tier(100, 1, 5, .05, 1.25),))
        self.book = Catalogue({"cheap": {"m": cheap}}, "fixture", "test", "2026-11-21", "1")
        self.create_events([{"provider": "cheap", "input_tokens": 1_000,
                             "output_tokens": 0}])
        out = self.summary(session_id="s1")
        self.assertEqual(out["provenance"]["tiers"]["applied"], {"base": 0, "tiered": 1})
        self.assertAlmostEqual(out["valuation"]["api_equivalent_usd"], 1_000 * 1 / 1e6,
                               places=9)

    def test_api_equivalent_is_exact_when_writes_reported(self):
        self.create_events([{"input_tokens": 1_000, "cache_read_tokens": 9_000,
                             "output_tokens": 100, "cache_write_reported": 1}])
        valuation = self.summary(session_id="s1")["valuation"]
        self.assertEqual(valuation["api_equivalent_basis"], "exact")
        self.assertIsNone(valuation["api_equivalent_bound_reason"])

    def test_known_band_does_not_imply_complete_monetary_evidence(self):
        self.create_events([{"provider": "tiered", "input_tokens": 1_000,
                             "cache_read_tokens": 9_000, "output_tokens": 100}])
        out = self.summary(session_id="s1")
        self.assertEqual(out["provenance"]["tiers"]["thresholds"], [272000])
        self.assertEqual(out["valuation"]["api_equivalent_basis"], "lower_bound")

    # -- 7. whole-request tier band --------------------------------------
    def test_tier_band_is_whole_request(self):
        self.create_events([
            {"provider": "tiered", "input_tokens": 271_999, "output_tokens": 1},
            {"provider": "tiered", "input_tokens": 272_001, "output_tokens": 1},
        ])
        out = self.summary(session_id="s1")
        self.assertEqual(out["provenance"]["tiers"]["applied"], {"base": 1, "tiered": 1})
        # 271,999 x 2 + 272,001 x 4, plus output at base/long rates.
        self.assertAlmostEqual(out["valuation"]["api_equivalent_usd"],
                               (271_999 * 2 + 1 * 10 + 272_001 * 4 + 1 * 15) / 1e6, places=9)

    # -- 8. empty and legacy ---------------------------------------------
    def test_empty_session_is_zero_calls_with_null_money(self):
        out = self.summary(session_id="absent")
        self.assertTrue(out["population"]["satisfied"])
        self.assertEqual(out["totals"]["calls"], 0)
        self.assertIsNone(out["valuation"]["api_equivalent_usd"])
        self.assertIsNone(out["valuation"]["savings_usd"])
        self.assertEqual(out["notes"], [{"code": "no_calls"}])

    def test_legacy_positive_read_is_self_evidencing(self):
        self.create_events([{"input_tokens": 1_000, "cache_read_tokens": 9_000},
                            {"input_tokens": 10_000, "cache_read_tokens": 0}])
        out = self.summary(session_id="s1")
        self.assertEqual(out["totals"]["cache_read_state"], "partial")
        self.assertEqual(out["valuation"]["covered_calls"], 1)
        self.assertGreater(out["valuation"]["savings_usd"], 0)

    # -- 9. surface contracts --------------------------------------------
    def test_rates_exposes_tiers_and_flat(self):
        from dashboard import plugin_api
        with mock.patch.object(plugin_api, "load_catalogue", return_value=self.book):
            tiered = plugin_api.rates(provider="tiered", model="m", at=None)
            flat = plugin_api.rates(provider="premium", model="m", at=None)
        self.assertTrue(tiered["rate"]["has_tiers"])
        self.assertFalse(tiered["rate"]["flat"])
        self.assertEqual(tiered["rate"]["tier_semantics"], "whole_request")
        self.assertEqual(tiered["rate"]["tiers"][0]["threshold"], 272000)
        self.assertTrue(flat["rate"]["flat"])
        self.assertEqual(flat["rate"]["tiers"], [])

    def test_ledger_keeps_legacy_savings_field_and_adds_gross_alias(self):
        row = {"billing_provider": "premium", "model": "m", "input_tokens": 1_000,
               "cache_read_tokens": 9_000, "cache_write_tokens": 0,
               "output_tokens": 100, "reasoning_tokens": 0, "api_call_count": 1,
               "session_id": "s1", "surface": "desktop", "task": "main"}
        out = aggregate._row_result(row, self.book, "list")
        info = out["pricing"]
        self.assertIn("cache_savings_usd", info)
        self.assertEqual(info["cache_savings_kind"], "gross_read_discount")
        self.assertEqual(info["gross_cache_read_savings_usd"], info["cache_savings_usd"])
        self.assertIsNotNone(info["cache_savings_usd"])

    def test_analytics_reports_states_and_hit_rate_basis(self):
        self.create_events([{"input_tokens": 1_000, "cache_read_tokens": 9_000},
                            {"input_tokens": 500, "cache_read_tokens": 0,
                             "cache_write_reported": 1}])
        report = analytics.build_analytics_report(self.events, state_db_path=self.state,
                                                 now=NOW, catalogue=self.book, days=1)
        totals = report["totals"]
        self.assertIn("cache_read_state", totals)
        self.assertEqual(totals["cache_read_state"], "partial")
        self.assertEqual(totals["cache_hit_rate_basis"], "reported_calls")
        self.assertIn("savings_basis", totals["economics"])

    def test_api_contract_is_four(self):
        from dashboard import plugin_api
        self.assertEqual(plugin_api.API_CONTRACT, 4)


if __name__ == "__main__":
    unittest.main()
