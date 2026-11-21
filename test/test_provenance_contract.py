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

from wolfmark_ledger import aggregate, analytics, collector, pricing, store
from wolfmark_ledger.pricing import Catalogue, Rate, Tier, load_catalogue

NOW = datetime(2026, 11, 21, 12, tzinfo=timezone.utc).timestamp()

PREMIUM = Rate(2, 10, .1, 2.5)          # write costs more than input
DISCOUNT = Rate(2, 10, .1, 1.0)         # write costs less than input
DISCOUNT2 = Rate(2, 10, .1, 1.5)        # a different discount
AT_INPUT = Rate(2, 10, .1, 2.0)         # write priced at input
FREE_WRITE = Rate(2, 10, .1, 0.0)       # writes recorded but never charged
NO_WRITE_PRICE = Rate(2, 10, .1, None)  # write price unknown
NO_READ_PRICE = Rate(2, 10, None, 2.5)  # cached-read price unknown
TIER_SUPPLIES_WRITE = Rate(2, 10, .1, None,
                           tiers=(Tier(100, 1, 5, .05, 1.5),))
RETENTION = Rate(2, 10, .1, 2.5,
                 cache_write_rates=(("30m", 2.5), ("12h", 5.0)))
INVERTED = Rate(2, 10, 3.0, 2.5,
                cache_write_rates=(("30m", 2.5), ("12h", 5.0)))
NAMED_TIER = Rate(2, 10, .1, 2.5, tiers=(
    Tier(100, None, None, None, None,
         cache_write_rates=(("30m", 1.0), ("12h", 2.0))),))
TIERED = Rate(2, 10, .1, 2.5, tiers=(Tier(272000, 4, 15, .2, 5),))
INCLUSIVE = Rate(2, 10, .1, 2.5,
                 tiers=(Tier(100, 4, 15, .2, 5, inclusive=True),))
MULTI_TIERED = Rate(2, 10, .1, 2.5,
                    tiers=(Tier(100, 6, 20, .2, 5), Tier(200, 4, 15, .2, 10)))
XAI_INCLUSIVE = Rate(2, 6, .5, 2.5,
                     tiers=(Tier(200000, 4, 12, 1.0, 5.0, inclusive=True),))
RETENTION_WIDE = Rate(2, 10, .1, 2.5,
                      cache_write_rates=(("30m", 2.0), ("12h", 5.0)))
FREE_OPTION = Rate(2, 10, .1, 0.0,
                   cache_write_rates=(("30m", 0.0), ("12h", 5.0)))
ALL_FREE_OPTIONS = Rate(2, 10, .1, 0.0,
                        cache_write_rates=(("30m", 0.0), ("12h", 0.0)))
CHEAPER_BAND = Rate(2, 10, .1, 2.5, tiers=(Tier(272000, 1, 8, .05, 2.0),))
FINE = Rate(0.4, 1, None, None)


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
             "noread": {"m": NO_READ_PRICE},
             "freewrite": {"m": FREE_WRITE}, "tiered": {"m": TIERED},
             "inclusive": {"m": INCLUSIVE}, "multitier": {"m": MULTI_TIERED},
             "xaiincl": {"m": XAI_INCLUSIVE}, "retwide": {"m": RETENTION_WIDE},
             "freeopt": {"m": FREE_OPTION}, "allfree": {"m": ALL_FREE_OPTIONS},
             "cheaperband": {"m": CHEAPER_BAND}, "fine": {"m": FINE},
             "tierwrite": {"m": TIER_SUPPLIES_WRITE},
             "retention": {"m": RETENTION}, "inverted": {"m": INVERTED},
             "namedtier": {"m": NAMED_TIER}},
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
                             "output_tokens": 100, "cache_write_reported": 1,
                             "cache_read_reported": 1}])
        valuation = self.summary(session_id="s1")["valuation"]
        self.assertEqual(valuation["api_equivalent_basis"], "exact")
        self.assertIsNone(valuation["api_equivalent_bound_reason"])

    def test_unproven_read_qualifies_cost(self):
        self.create_events([{"input_tokens": 1_000, "cache_write_reported": 1}])
        out = self.summary(session_id="s1")
        self.assertEqual(out["valuation"]["savings_basis"], "lower_bound")
        self.assertEqual(out["valuation"]["savings_bound_reason"], "read_not_reported")
        self.assertEqual(out["valuation"]["api_equivalent_basis"], "lower_bound")
        self.assertEqual(out["valuation"]["api_equivalent_bound_reason"],
                         "read_not_reported")
        self.assertIsNone(out["valuation"]["api_equivalent_usd_high"])

    def test_unreported_reads_without_a_price_name_the_read_counter(self):
        self.create_events([{"provider": "noread", "input_tokens": 1_000,
                             "cache_write_reported": 1}])
        valuation = self.summary(session_id="s1")["valuation"]
        self.assertEqual(valuation["savings_basis"], "indeterminate")
        self.assertEqual(valuation["savings_bound_reason"], "read_rate_missing")

    def test_positive_reported_read_without_a_price_is_not_exact(self):
        self.create_events([{"provider": "noread", "cache_read_tokens": 1_000,
                             "cache_read_reported": 1, "cache_write_reported": 1}])
        valuation = self.summary(session_id="s1")["valuation"]
        self.assertEqual(valuation["api_equivalent_basis"], "incomplete")
        self.assertEqual(valuation["api_equivalent_bound_reason"], "read_rate_missing")
        self.assertIsNone(valuation["api_equivalent_usd_high"])

    def test_positive_reported_write_without_a_price_is_not_exact(self):
        self.create_events([{"provider": "noprice", "cache_write_tokens": 5_000,
                             "cache_read_reported": 1, "cache_write_reported": 1}])
        valuation = self.summary(session_id="s1")["valuation"]
        self.assertEqual(valuation["api_equivalent_basis"], "incomplete")
        self.assertEqual(valuation["api_equivalent_bound_reason"], "write_rate_missing")

    def test_explicit_zero_counters_do_not_require_a_price(self):
        self.create_events([{"provider": "noprice", "input_tokens": 1_000,
                             "cache_read_reported": 1, "cache_write_reported": 1}])
        valuation = self.summary(session_id="s1")["valuation"]
        self.assertEqual(valuation["api_equivalent_basis"], "exact")
        self.assertAlmostEqual(valuation["api_equivalent_usd"], 0.002, places=6)

    def test_unreported_writes_near_a_context_tier_are_indeterminate(self):
        self.create_events([{"provider": "tiered", "input_tokens": 271_999,
                             "cache_read_reported": 1}])
        valuation = self.summary(session_id="s1")["valuation"]
        self.assertEqual(valuation["savings_basis"], "indeterminate")
        self.assertEqual(valuation["savings_bound_reason"], "context_tier_unknown")
        self.assertIsNone(valuation["savings_usd"])

    def test_unreported_writes_above_every_tier_keep_the_direction(self):
        self.create_events([{"provider": "tiered", "input_tokens": 272_001,
                             "cache_read_reported": 1}])
        valuation = self.summary(session_id="s1")["valuation"]
        self.assertEqual(valuation["savings_basis"], "upper_bound")
        self.assertEqual(valuation["savings_bound_reason"], "write_not_reported")
        self.assertAlmostEqual(valuation["savings_usd"], 0.0, places=6)

    def test_inclusive_tier_is_reachable_up_to_its_threshold(self):
        self.create_events([{"provider": "inclusive", "input_tokens": 99,
                             "cache_read_reported": 1}])
        self.assertEqual(self.summary(session_id="s1")["valuation"]["savings_basis"],
                         "indeterminate")
        os.remove(self.events)
        self.create_events([{"provider": "inclusive", "input_tokens": 100,
                             "cache_read_reported": 1}])
        self.assertEqual(self.summary(session_id="s1")["valuation"]["savings_basis"],
                         "upper_bound")

    def test_named_retention_option_charges_an_unreported_write(self):
        # Scalar write price is zero, but a named retention option is not:
        # unreported writes could still add cost, so the subtotal is a bound.
        self.create_events([{"provider": "freeopt", "input_tokens": 1_000,
                             "cache_read_reported": 1}])
        valuation = self.summary(session_id="s1")["valuation"]
        self.assertEqual(valuation["api_equivalent_basis"], "lower_bound")
        self.assertEqual(valuation["api_equivalent_bound_reason"], "write_not_reported")

    def test_all_free_options_keep_an_unreported_write_exact(self):
        self.create_events([{"provider": "allfree", "input_tokens": 1_000,
                             "cache_read_reported": 1}])
        valuation = self.summary(session_id="s1")["valuation"]
        self.assertEqual(valuation["api_equivalent_basis"], "exact")

    def test_reachable_cheaper_band_makes_cost_incomplete(self):
        # The 272K band is cheaper for the recorded tokens, so an unreported
        # write crossing it could lower the true cost below the recorded band.
        self.create_events([{"provider": "cheaperband", "input_tokens": 271_999,
                             "cache_read_reported": 1}])
        valuation = self.summary(session_id="s1")["valuation"]
        self.assertEqual(valuation["api_equivalent_basis"], "incomplete")
        self.assertEqual(valuation["api_equivalent_bound_reason"], "context_tier_unknown")

    def test_retention_lower_endpoint_uses_the_cheapest_option(self):
        self.create_events([{"provider": "retwide", "input_tokens": 1_000,
                             "cache_write_tokens": 100_000, "cache_write_reported": 1,
                             "cache_read_reported": 1}])
        valuation = self.summary(session_id="s1")["valuation"]
        self.assertEqual(valuation["api_equivalent_basis"], "range")
        self.assertAlmostEqual(valuation["api_equivalent_usd"], 0.202, places=9)
        self.assertAlmostEqual(valuation["api_equivalent_usd_high"], 0.502, places=9)

    def test_session_totals_keep_sub_micro_precision(self):
        # 4e-7 per row: per-call rounding would discard both; the sum rounds to 1e-6.
        rows = [{"provider": "fine", "input_tokens": 1,
                 "cache_read_reported": 1, "cache_write_reported": 1} for _ in range(2)]
        self.create_events(rows)
        valuation = self.summary(session_id="s1")["valuation"]
        self.assertAlmostEqual(valuation["api_equivalent_usd"], 0.000001, places=12)

    def test_prompt_tokens_fall_back_per_row(self):
        self.create_events([
            {"provider": "premium", "prompt_tokens": 500, "input_tokens": 1_000,
             "cache_read_reported": 1, "cache_write_reported": 1},
            {"provider": "premium", "input_tokens": 100,
             "cache_read_reported": 1, "cache_write_reported": 1},
        ])
        self.assertEqual(self.summary(session_id="s1")["totals"]["prompt_tokens"], 600)

    def test_reachability_uses_the_catalogue_rate_across_multiple_tiers(self):
        # Prompt 150 crosses the 100 band, so the effective rate has its
        # tiers stripped; the 200 band is still reachable and must be seen on
        # the catalogue rate or the bound would be falsely directional.
        self.create_events([{"provider": "multitier", "input_tokens": 150,
                             "cache_read_reported": 1}])
        valuation = self.summary(session_id="s1")["valuation"]
        self.assertEqual(valuation["savings_basis"], "indeterminate")
        self.assertEqual(valuation["savings_bound_reason"], "context_tier_unknown")

    def test_exclusive_threshold_is_reachable_at_the_boundary(self):
        self.create_events([{"provider": "tiered", "input_tokens": 272_000,
                             "cache_read_reported": 1}])
        self.assertEqual(self.summary(session_id="s1")["valuation"]["savings_basis"],
                         "indeterminate")
        os.remove(self.events)
        self.create_events([{"provider": "tiered", "input_tokens": 272_001,
                             "cache_read_reported": 1}])
        self.assertEqual(self.summary(session_id="s1")["valuation"]["savings_basis"],
                         "upper_bound")

    def test_inclusive_threshold_stops_being_reachable_once_applied(self):
        for prompt, expected in ((199_999, "indeterminate"),
                                 (200_000, "upper_bound"),
                                 (200_001, "upper_bound")):
            if self.events.exists():
                os.remove(self.events)
            self.create_events([{"provider": "xaiincl", "input_tokens": prompt,
                                 "cache_read_reported": 1}])
            self.assertEqual(
                self.summary(session_id="s1")["valuation"]["savings_basis"],
                expected, f"prompt {prompt}")

    def test_reported_counters_at_a_reachable_boundary_stay_exact(self):
        self.create_events([{"provider": "tiered", "input_tokens": 272_000,
                             "cache_read_reported": 1, "cache_write_reported": 1}])
        valuation = self.summary(session_id="s1")["valuation"]
        self.assertEqual(valuation["savings_basis"], "exact")
        self.assertAlmostEqual(valuation["savings_usd"], 0.0, places=6)

    def test_known_counters_ignore_tier_reachability(self):
        self.create_events([{"provider": "tiered", "input_tokens": 271_999,
                             "cache_read_reported": 1, "cache_write_reported": 1}])
        valuation = self.summary(session_id="s1")["valuation"]
        self.assertEqual(valuation["savings_basis"], "exact")
        self.assertAlmostEqual(valuation["savings_usd"], 0.0, places=6)

    def test_retention_range_with_unproven_read_is_one_sided(self):
        self.create_events([{"provider": "retention", "cache_write_tokens": 100_000,
                             "cache_write_reported": 1}])
        valuation = self.summary(session_id="s1")["valuation"]
        self.assertEqual(valuation["savings_basis"], "lower_bound")
        self.assertEqual(valuation["savings_bound_reason"],
                         "retention_and_counter_uncertainty")
        self.assertAlmostEqual(valuation["savings_usd"], -0.3, places=6)
        self.assertIsNone(valuation["savings_usd_high"])
        self.assertIsNone(valuation["api_equivalent_usd_high"])

    def test_retention_range_with_upper_read_direction_publishes_the_upper(self):
        self.create_events([{"provider": "inverted", "cache_write_tokens": 100_000,
                             "cache_write_reported": 1}])
        valuation = self.summary(session_id="s1")["valuation"]
        self.assertEqual(valuation["savings_basis"], "upper_bound")
        self.assertAlmostEqual(valuation["savings_usd"], -0.05, places=6)
        self.assertIsNone(valuation["savings_usd_high"])

    def test_mixed_range_and_lower_bound_total_is_one_sided(self):
        self.create_events([
            {"provider": "retention", "input_tokens": 1_000,
             "cache_write_tokens": 100_000, "cache_write_reported": 1,
             "cache_read_reported": 1},
            {"provider": "discount", "input_tokens": 1_000,
             "cache_read_tokens": 9_000},
        ])
        out = self.summary(session_id="s1")
        self.assertEqual(out["valuation"]["api_equivalent_basis"], "lower_bound")
        self.assertIsNone(out["valuation"]["api_equivalent_usd_high"])
        self.assertEqual(out["valuation"]["savings_basis"], "lower_bound")
        self.assertEqual(out["valuation"]["savings_bound_reason"],
                         "retention_and_counter_uncertainty")

    def test_named_only_tier_uses_one_of_its_prices(self):
        rate, selected = pricing._effective_rate(NAMED_TIER, 1_000)
        self.assertTrue(selected)
        self.assertEqual(rate.cache_write, 1.0)
        self.assertEqual(dict(rate.cache_write_rates), {"30m": 1.0, "12h": 2.0})
        self.create_events([{"provider": "namedtier", "cache_write_tokens": 1_000,
                             "cache_write_reported": 1, "cache_read_reported": 1}])
        valuation = self.summary(session_id="s1")["valuation"]
        self.assertEqual(valuation["savings_basis"], "range")
        self.assertAlmostEqual(valuation["savings_usd"], 0.0, places=9)
        self.assertAlmostEqual(valuation["savings_usd_high"], 0.001, places=9)

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
                         "read_and_write_not_reported")
        self.assertIsNone(out["valuation"]["api_equivalent_usd_high"])

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


class OfficialRateRowTests(unittest.TestCase):
    """GPT-6.2 Sol: official tiers, retention alternatives, alias scope."""

    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory(dir=os.environ.get("TMPDIR"))
        self.addCleanup(self.scratch.cleanup)
        self.events = Path(self.scratch.name) / "usage.db"
        self.state = Path(self.scratch.name) / "state.db"
        self.book = load_catalogue()
        self.addCleanup(self._release_writer)

    @staticmethod
    def _release_writer():
        if store._WRITER is not None:
            try:
                store._WRITER.close()
            except Exception:  # noqa: BLE001
                pass
        store._WRITER = None
        store._WRITER_PATH = None

    def create_events(self, rows):
        with closing(sqlite3.connect(self.events)) as conn, conn:
            conn.executescript(store._SCHEMA)
            for index, row in enumerate(rows):
                values = {"event_id": f"official-{index}", "ts": NOW - 60,
                          "session_id": "sol", "model": "gpt-6.2-sol",
                          "provider": "openai-codex", "outcome": "ok",
                          "recorded_at": NOW, **row}
                columns = list(values)
                conn.execute(f"INSERT INTO calls ({','.join(columns)}) VALUES "
                             f"({','.join('?' for _ in columns)})", list(values.values()))

    def summary(self, **kwargs):
        return analytics.build_session_summary(
            self.events, state_db_path=self.state, catalogue=self.book,
            now=NOW, **kwargs)

    def test_official_row_loads_tiers_and_retention(self):
        hit = self.book.lookup("openai-codex", "gpt-6.2-sol")
        assert hit is not None
        self.assertEqual(hit.provenance, "official_verified")
        self.assertTrue(hit.alias_used)
        self.assertEqual((hit.rate.input, hit.rate.output, hit.rate.cache_read,
                          hit.rate.cache_write), (2.0, 10.0, 0.1, 2.5))
        self.assertEqual(dict(hit.rate.cache_write_rates), {"30m": 2.5, "12h": 5.0})
        self.assertEqual([(t.threshold, t.input, t.output, t.cache_read, t.cache_write)
                          for t in hit.rate.tiers], [(272000, 4.0, 15.0, 0.2, 5.0)])
        self.assertEqual(dict(hit.rate.tiers[0].cache_write_rates),
                         {"30m": 5.0, "12h": 10.0})

    def test_context_boundary_is_strictly_above_272k(self):
        self.create_events([{"input_tokens": 272_000, "output_tokens": 0}])
        at_limit = self.summary(session_id="sol")
        self.assertEqual(at_limit["provenance"]["tiers"]["applied"], {"base": 1, "tiered": 0})
        self.assertAlmostEqual(at_limit["valuation"]["api_equivalent_usd"],
                               272_000 * 2.0 / 1e6, places=9)
        os.remove(self.events)
        self.create_events([{"input_tokens": 272_001, "output_tokens": 0}])
        above = self.summary(session_id="sol")
        self.assertEqual(above["provenance"]["tiers"]["applied"], {"base": 0, "tiered": 1})
        self.assertAlmostEqual(above["valuation"]["api_equivalent_usd"],
                               272_001 * 4.0 / 1e6, places=9)

    def test_both_retentions_at_both_bands(self):
        # Base band: prompt 100,000; base rates apply.
        self.create_events([{"cache_write_tokens": 100_000, "cache_write_reported": 1,
                             "cache_read_reported": 1}])
        base = self.summary(session_id="sol")["valuation"]
        self.assertEqual(base["savings_basis"], "range")
        self.assertEqual(base["savings_bound_reason"], "retention_unknown")
        self.assertAlmostEqual(base["savings_usd"], -0.3, places=6)   # 12h: $5/M
        self.assertAlmostEqual(base["savings_usd_high"], -0.05, places=6)  # 30m: $2.5/M
        os.remove(self.events)
        # Long band: 300k input + 100k write = 400k prompt; tier rates apply.
        self.create_events([{"input_tokens": 300_000, "cache_write_tokens": 100_000,
                             "cache_write_reported": 1, "cache_read_reported": 1}])
        long = self.summary(session_id="sol")["valuation"]
        self.assertEqual(long["savings_basis"], "range")
        self.assertAlmostEqual(long["savings_usd"], -0.6, places=6)    # 12h: $10/M
        self.assertAlmostEqual(long["savings_usd_high"], -0.1, places=6)  # 30m: $5/M

    def test_positive_writes_with_unknown_retention_are_never_exact(self):
        self.create_events([{"cache_write_tokens": 100_000, "cache_write_reported": 1,
                             "cache_read_reported": 1}])
        out = self.summary(session_id="sol")
        self.assertEqual(out["valuation"]["retention_unknown_calls"], 1)
        self.assertEqual(out["valuation"]["savings_basis"], "range")
        self.assertEqual(out["valuation"]["api_equivalent_basis"], "range")
        self.assertEqual(out["valuation"]["api_equivalent_bound_reason"],
                         "retention_unknown")
        self.assertLess(out["valuation"]["api_equivalent_usd"],
                        out["valuation"]["api_equivalent_usd_high"])

    def test_explicit_zero_writes_are_exact(self):
        self.create_events([{"input_tokens": 1_000, "output_tokens": 100,
                             "cache_write_reported": 1, "cache_read_reported": 1}])
        valuation = self.summary(session_id="sol")["valuation"]
        self.assertEqual(valuation["savings_basis"], "exact")
        self.assertEqual(valuation["api_equivalent_basis"], "exact")
        self.assertAlmostEqual(valuation["savings_usd"], 0.0, places=9)
        self.assertEqual(valuation["retention_unknown_calls"], 0)

    def test_unreported_writes_stay_directional_without_a_range(self):
        # Above every published band, so an unrecorded write cannot change the
        # applicable tier; the direction is defensible and stays one-sided.
        self.create_events([{"input_tokens": 300_000, "cache_read_tokens": 9_000}])
        valuation = self.summary(session_id="sol")["valuation"]
        self.assertEqual(valuation["savings_basis"], "upper_bound")
        self.assertIsNone(valuation["savings_usd_high"],
                          "an unknown write count must not manufacture a range")
        self.assertEqual(valuation["retention_unknown_calls"], 0)
        self.assertEqual(valuation["api_equivalent_basis"], "lower_bound")

    def test_negative_savings_are_not_clamped(self):
        self.create_events([{"cache_write_tokens": 100_000,
                             "cache_write_reported": 1, "cache_read_reported": 1}])
        self.assertLess(self.summary(session_id="sol")["valuation"]["savings_usd"], 0)

    def test_partial_pricing_leaves_the_total_incomplete(self):
        self.create_events([{"input_tokens": 1_000, "cache_read_tokens": 9_000},
                            {"provider": "mystery", "model": "unpriced",
                             "input_tokens": 500}])
        valuation = self.summary(session_id="sol")["valuation"]
        self.assertEqual(valuation["api_equivalent_basis"], "incomplete")
        self.assertEqual(valuation["api_equivalent_bound_reason"], "unpriced_tokens")
        self.assertEqual(valuation["covered_calls"], 1)
        self.assertEqual(valuation["excluded_calls"], 1)

    def test_context_buckets_are_summed_not_duplicated(self):
        # Three disjoint buckets, each below the threshold; only their sum crosses it.
        self.create_events([{"input_tokens": 100_000, "cache_read_tokens": 100_000,
                             "cache_write_tokens": 100_000, "cache_write_reported": 1}])
        out = self.summary(session_id="sol")
        self.assertEqual(out["totals"]["prompt_tokens"], 300_000)
        self.assertEqual(out["provenance"]["tiers"]["applied"], {"base": 0, "tiered": 1})

    def test_alias_prices_the_route_but_never_claims_a_bill(self):
        self.create_events([{"input_tokens": 1_000, "output_tokens": 100}])
        row = {"input_tokens": 1_000, "output_tokens": 100, "provider": "openai-codex",
               "model": "gpt-6.2-sol", "outcome": "ok", "ts": NOW, "session_id": "sol"}
        result = aggregate._event_result(row, self.book, "list", {}, at=NOW)
        self.assertIsNotNone(result["list_usd"])
        self.assertEqual(result["billing_class"], "unknown")
        self.assertIsNone(result["billed_usd"])
        self.assertEqual(result["pricing"]["provenance"], "official_verified")

    def test_rates_endpoint_keeps_contract_four_shape(self):
        from dashboard import plugin_api
        payload = plugin_api.rates(provider="openai-codex", model="gpt-6.2-sol", at=None)
        rate = payload["rate"]
        self.assertTrue(rate["has_tiers"])
        self.assertFalse(rate["flat"])
        self.assertEqual(rate["tier_semantics"], "whole_request")
        self.assertEqual([item["retention"] for item in rate["cache_write_rates"]],
                         ["30m", "12h"])
        self.assertEqual(rate["tiers"][0]["threshold"], 272000)
        self.assertFalse(rate["tiers"][0]["inclusive"])
        self.assertEqual([item["retention"] for item in rate["tiers"][0]["cache_write_rates"]],
                         ["30m", "12h"])
        for key in ("input", "output", "cache_read", "cache_write", "provenance"):
            self.assertIn(key, rate)


class CrossProviderPricingTests(unittest.TestCase):
    """Official OpenAI, Anthropic and xAI rows; Gemini's unsupported storage."""

    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory(dir=os.environ.get("TMPDIR"))
        self.addCleanup(self.scratch.cleanup)
        self.events = Path(self.scratch.name) / "usage.db"
        self.state = Path(self.scratch.name) / "state.db"
        self.book = load_catalogue()
        self.addCleanup(OfficialRateRowTests._release_writer)

    def create_events(self, rows):
        with closing(sqlite3.connect(self.events)) as conn, conn:
            conn.executescript(store._SCHEMA)
            for index, row in enumerate(rows):
                values = {"event_id": f"cross-{index}", "ts": NOW - 60,
                          "session_id": "cross", "outcome": "ok",
                          "recorded_at": NOW, **row}
                columns = list(values)
                conn.execute(f"INSERT INTO calls ({','.join(columns)}) VALUES "
                             f"({','.join('?' for _ in columns)})", list(values.values()))

    def summary(self, **kwargs):
        return analytics.build_session_summary(
            self.events, state_db_path=self.state, catalogue=self.book,
            now=NOW, **kwargs)

    def test_openai_astra_rows_parse_tiers_and_retentions(self):
        astra = self.book.lookup("openai", "gpt-6.2-astra")
        assert astra is not None
        self.assertEqual((astra.rate.input, astra.rate.output, astra.rate.cache_read,
                          astra.rate.cache_write), (8.0, 40.0, 0.4, 10.0))
        self.assertEqual(dict(astra.rate.cache_write_rates), {"30m": 10.0, "12h": 20.0})
        self.assertEqual([(t.threshold, t.input, t.output, t.cache_read, t.cache_write)
                          for t in astra.rate.tiers], [(272000, 16.0, 60.0, 0.8, 20.0)])
        old = self.book.lookup("openai", "gpt-6-astra")
        assert old is not None
        self.assertEqual(old.rate.cache_write_rates, ())
        self.assertEqual([(t.input, t.output, t.cache_write) for t in old.rate.tiers],
                         [(20.0, 75.0, 25.0)])

    def test_astra_boundary_is_strictly_above_272k(self):
        self.create_events([{"provider": "openai", "model": "gpt-6.2-astra",
                             "input_tokens": 272_000}])
        self.assertAlmostEqual(self.summary(session_id="cross")["valuation"]["api_equivalent_usd"],
                               272_000 * 8.0 / 1e6, places=9)
        os.remove(self.events)
        self.create_events([{"provider": "openai", "model": "gpt-6.2-astra",
                             "input_tokens": 272_001}])
        self.assertAlmostEqual(self.summary(session_id="cross")["valuation"]["api_equivalent_usd"],
                               272_001 * 16.0 / 1e6, places=9)

    def test_openai_tier_boundary_is_reachable_up_to_272k(self):
        for prompt, expected in ((271_999, "indeterminate"),
                                 (272_000, "indeterminate"),
                                 (272_001, "upper_bound")):
            if self.events.exists():
                os.remove(self.events)
            self.create_events([{"provider": "openai", "model": "gpt-6.2-astra",
                                 "input_tokens": prompt, "cache_read_reported": 1}])
            valuation = self.summary(session_id="cross")["valuation"]
            self.assertEqual(valuation["savings_basis"], expected, f"prompt {prompt}")
            if expected == "indeterminate":
                self.assertIsNone(valuation["savings_usd"], f"prompt {prompt}")

    def test_reachability_helper_respects_both_threshold_rules(self):
        from wolfmark_ledger.pricing import reaches_unapplied_tier
        self.assertTrue(reaches_unapplied_tier(TIERED, 272_000))
        self.assertFalse(reaches_unapplied_tier(TIERED, 272_001))
        self.assertTrue(reaches_unapplied_tier(INCLUSIVE, 99))
        self.assertFalse(reaches_unapplied_tier(INCLUSIVE, 100))
        self.assertTrue(reaches_unapplied_tier(INCLUSIVE, 0))

    def test_anthropic_retention_range_and_rates(self):
        hit = self.book.lookup("anthropic", "claude-sonnet-5")
        assert hit is not None
        self.assertEqual(dict(hit.rate.cache_write_rates), {"5m": 2.5, "1h": 4.0})
        self.create_events([{"provider": "anthropic", "model": "claude-sonnet-5",
                             "input_tokens": 1_000, "cache_write_tokens": 10_000,
                             "cache_write_reported": 1, "cache_read_reported": 1}])
        valuation = self.summary(session_id="cross")["valuation"]
        self.assertEqual(valuation["savings_basis"], "range")
        self.assertAlmostEqual(valuation["savings_usd"], -0.02, places=6)      # 1h
        self.assertAlmostEqual(valuation["savings_usd_high"], -0.005, places=6)  # 5m

    def test_anthropic_haiku_tier_boundary(self):
        self.create_events([{"provider": "anthropic", "model": "claude-haiku-5-5",
                             "input_tokens": 100_000}])
        self.assertAlmostEqual(self.summary(session_id="cross")["valuation"]["api_equivalent_usd"],
                               100_000 * 0.1 / 1e6, places=6)
        os.remove(self.events)
        self.create_events([{"provider": "anthropic", "model": "claude-haiku-5-5",
                             "input_tokens": 100_001}])
        self.assertAlmostEqual(self.summary(session_id="cross")["valuation"]["api_equivalent_usd"],
                               100_001 * 0.5 / 1e6, places=6)

    def test_xai_tier_is_inclusive_at_200k(self):
        self.create_events([{"provider": "xai", "model": "grok-4.7",
                             "input_tokens": 199_999}])
        self.assertAlmostEqual(self.summary(session_id="cross")["valuation"]["api_equivalent_usd"],
                               199_999 * 2.0 / 1e6, places=9)
        os.remove(self.events)
        self.create_events([{"provider": "xai", "model": "grok-4.7",
                             "input_tokens": 200_000}])
        self.assertAlmostEqual(self.summary(session_id="cross")["valuation"]["api_equivalent_usd"],
                               200_000 * 4.0 / 1e6, places=9)

    def test_xai_cached_input_uses_the_long_context_rate(self):
        self.create_events([{"provider": "xai", "model": "grok-4.7",
                             "input_tokens": 199_000, "cache_read_tokens": 1_000}])
        self.assertAlmostEqual(self.summary(session_id="cross")["valuation"]["api_equivalent_usd"],
                               (199_000 * 4.0 + 1_000 * 1.0) / 1e6, places=9)

    def test_gemini_reads_price_but_storage_and_writes_do_not(self):
        self.create_events([{"provider": "google", "model": "gemini-4-argon",
                             "input_tokens": 1_000, "cache_read_tokens": 5_000}])
        valuation = self.summary(session_id="cross")["valuation"]
        self.assertAlmostEqual(valuation["api_equivalent_usd"],
                               (1_000 * 2.0 + 5_000 * 0.1) / 1e6, places=9)
        # Gemini publishes no cache-write price, and cache storage is billed
        # per token-hour. Neither is modelled, so the total must not be exact.
        self.assertEqual(valuation["api_equivalent_basis"], "incomplete")
        self.assertEqual(valuation["api_equivalent_bound_reason"], "write_rate_missing")

    def test_unknown_model_fails_safe(self):
        self.create_events([{"provider": "nobody", "model": "no-such-model",
                             "input_tokens": 1_000}])
        valuation = self.summary(session_id="cross")["valuation"]
        self.assertIsNone(valuation["api_equivalent_usd"])
        self.assertEqual(valuation["api_equivalent_basis"], "incomplete")

    def test_rates_expose_inclusive_for_both_threshold_rules(self):
        from dashboard import plugin_api
        exclusive = plugin_api.rates(provider="openai", model="gpt-6.2-astra", at=None)["rate"]
        inclusive = plugin_api.rates(provider="xai", model="grok-4.7", at=None)["rate"]
        self.assertIs(exclusive["tiers"][0]["inclusive"], False)
        self.assertIs(inclusive["tiers"][0]["inclusive"], True)
        expected_keys = {"threshold", "inclusive", "input", "output",
                         "cache_read", "cache_write", "cache_write_rates"}
        for tier in exclusive["tiers"] + inclusive["tiers"]:
            self.assertEqual(set(tier), expected_keys)

    def test_anthropic_rates_endpoint_keeps_both_retentions(self):
        from dashboard import plugin_api
        payload = plugin_api.rates(provider="anthropic", model="claude-sonnet-5", at=None)
        rate = payload["rate"]
        self.assertEqual([item["retention"] for item in rate["cache_write_rates"]],
                         ["5m", "1h"])
        self.assertEqual(rate["provenance"], "official_verified")


if __name__ == "__main__":
    unittest.main()
