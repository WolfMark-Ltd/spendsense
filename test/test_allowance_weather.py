"""Allowance weather: pace, runway and forecast gating.

Uses isolated SQLite fixtures and synthetic stores only. Prices come from a
fixture catalogue: Rate(2, 4, .5, 3) prices one million input tokens at
exactly $2.00, so every expected value below is hand-derived.
"""
from __future__ import annotations

import json
import os
import sqlite3
import tempfile
import unittest
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path

from wolfmark_ledger import allowance_weather as W
from wolfmark_ledger import membership as M
from wolfmark_ledger import membership_store as mstore
from wolfmark_ledger import store
from wolfmark_ledger.pricing import Catalogue, Rate

NOW = datetime(2026, 10, 31, 12, tzinfo=timezone.utc).timestamp()
MID = datetime(2026, 10, 15, 12, tzinfo=timezone.utc).timestamp()


def plans_doc(*plans):
    return M.load_plan_catalogue({"catalogue_version": "test.1", "plans": list(plans)})


def credit_window(**kw):
    base = {"id": "monthly-credit", "label": "Monthly credit", "kind": "billing_cycle",
            "limit": "credit_value_usd", "amount": 100.0, "currency": "USD",
            "scope": "account"}
    base.update(kw)
    return base


PLANS = plans_doc(
    {"id": "test.plus", "provider_family": "test", "name": "Test Plus",
     "price": {"amount": 20.0, "currency": "USD", "period": "month"},
     "entitlements": {"windows": [credit_window()]}},
)


def account(aid, family, **kw):
    base = {"id": aid, "family": family, "label": aid,
            "route_slugs": [family], "credential_present": True,
            "billing_arrangement": "subscription",
            "plan_id": None, "fee_overrides": [], "manual_exhaustions": []}
    base.update(kw)
    return base


def snapshot(*windows, fetched_ago=60, now=NOW):
    return {"provider": "test", "fetched_at": now - fetched_ago,
            "windows": [dict(w) for w in windows], "source": "usage_api"}


def provider_window(label, used, **kw):
    base = {"label": label, "used_percent": used, "scope": "account"}
    base.update(kw)
    return base


def manual_mark(window_id, label, declared_at, **kw):
    base = {"id": f"manual-{window_id}", "scope": {"kind": "window", "id": window_id,
                                                   "label": label},
            "declared_at": declared_at, "basis": "manual", "state": "active"}
    base.update(kw)
    return base


class WeatherCase(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory(dir=os.environ.get("TMPDIR"))
        self.addCleanup(self.scratch.cleanup)
        self.dir = Path(self.scratch.name)
        self.events = self.dir / "usage.db"
        self.state = self.dir / "state.db"
        self.memberships = self.dir / "memberships.json"
        self.profiles = self.dir / "billing-profiles.json"
        self.book = Catalogue({"test": {"m": Rate(2, 4, .5, 3),
                                        "n": Rate(2, 4, .5, 3)},
                               "other": {"m": Rate(2, 4, .5, 3)}},
                              "fixture", "test", "", "1")

    def create_events(self, rows=(), baseline_at=None, baseline_total=0):
        with closing(sqlite3.connect(self.events)) as conn, conn:
            conn.executescript(store._SCHEMA)
            for index, row in enumerate(rows):
                values = {"event_id": f"event-{index}", "ts": NOW - 10 * 86400,
                          "model": "m", "provider": "test", "platform": "desktop",
                          "outcome": "ok", "input_tokens": 0, "output_tokens": 0,
                          "recorded_at": None, **row}
                if values["recorded_at"] is None:
                    values["recorded_at"] = values["ts"]
                values["total_tokens"] = (values["input_tokens"] + values["output_tokens"]
                                          + values.get("cache_read_tokens", 0)
                                          + values.get("cache_write_tokens", 0))
                columns = list(values)
                conn.execute(f"INSERT INTO calls ({','.join(columns)}) VALUES "
                             f"({','.join('?' for _ in columns)})", list(values.values()))
            if baseline_at is not None:
                conn.execute("INSERT INTO baseline (id, captured_at, total_tokens,"
                             " main_tokens, aux_tokens) VALUES (1, ?, ?, 0, 0)",
                             (baseline_at, baseline_total))

    def create_state(self, total):
        with closing(sqlite3.connect(self.state)) as conn, conn:
            conn.executescript(
                "CREATE TABLE session_model_usage (input_tokens INTEGER,"
                " output_tokens INTEGER, cache_read_tokens INTEGER,"
                " cache_write_tokens INTEGER);"
                f"INSERT INTO session_model_usage VALUES ({total}, 0, 0, 0);")

    def write_store(self, accounts):
        self.memberships.write_text(json.dumps({"version": 1, "accounts": accounts}))

    def write_profiles(self, profiles, defaults=None):
        self.profiles.write_text(json.dumps(
            {"version": 1, "profiles": profiles, "defaults": defaults or {}}))

    def report(self, **kwargs):
        return W.build_weather_report(
            now=kwargs.pop("now", NOW), event_db_path=self.events,
            state_db_path=self.state, membership_path=self.memberships,
            plans=kwargs.pop("plans", PLANS), profiles_path=self.profiles,
            catalogue=self.book, **kwargs)

    def account_entry(self, result, aid="test:default"):
        return next(a for a in result["accounts"] if a["account_id"] == aid)

    def clean_coverage(self, total_tokens, now=NOW):
        """Baseline before October with state growth exactly matching calls."""
        self.create_events(baseline_at=now - 40 * 86400, baseline_total=0)
        self.create_state(total_tokens)


class VerdictTests(unittest.TestCase):
    def test_table(self):
        self.assertEqual(W.verdict(0.9, 0.5), "ahead")
        self.assertEqual(W.verdict(0.5, 0.5), "on_track")
        self.assertEqual(W.verdict(0.1, 0.5), "behind")
        self.assertEqual(W.verdict(1.0, 0.2), "exhausted")
        self.assertEqual(W.verdict(1.4, 0.9), "exhausted")

    def test_tolerance_band_edges(self):
        # Exactly ten points either way still counts as on track.
        self.assertEqual(W.verdict(0.6, 0.5), "on_track")
        self.assertEqual(W.verdict(0.4, 0.5), "on_track")
        self.assertEqual(W.verdict(0.61, 0.5), "ahead")
        self.assertEqual(W.verdict(0.39, 0.5), "behind")

    def test_unknown_inputs_are_unknown_never_zero(self):
        for consumed, elapsed in [(None, 0.5), (0.5, None), (None, None),
                                  ("0.5", 0.5), (0.5, "0.5"), (True, 0.5),
                                  (float("nan"), 0.5), (0.5, float("inf"))]:
            with self.subTest(consumed=consumed, elapsed=elapsed):
                self.assertEqual(W.verdict(consumed, elapsed), "unknown")

    def test_lower_bound_keeps_only_one_sided_verdicts(self):
        # Observed exhaustion or an observed lead still hold for the true
        # figure; behind and on-track would need the missing rows to stay so.
        self.assertEqual(W.verdict(1.2, 0.5, lower_bound=True), "exhausted")
        self.assertEqual(W.verdict(0.9, 0.5, lower_bound=True), "ahead")
        self.assertEqual(W.verdict(0.5, 0.5, lower_bound=True), "unknown")
        self.assertEqual(W.verdict(0.1, 0.5, lower_bound=True), "unknown")


class SpanTests(unittest.TestCase):
    def test_remaining_display_rounds_up(self):
        span = W._span(1000.0, 1000.0 + 31 * 86400, 1000.0 + 30.5 * 86400)
        self.assertEqual(span["elapsed_days"], 30.5)
        self.assertEqual(span["days_remaining"], 0.5)
        self.assertEqual(span["days_remaining_display"], 1)
        self.assertEqual(span["elapsed_fraction"], round(30.5 / 31, 6))

    def test_nothing_elapsed_before_the_start(self):
        span = W._span(2000.0, 2000.0 + 10 * 86400, 1000.0)
        self.assertEqual(span["elapsed_days"], 0.0)
        self.assertEqual(span["elapsed_fraction"], 0.0)

    def test_cycle_span_keeps_the_anchor(self):
        out = W._cycle_span({"start": "2026-10-01T00:00:00Z",
                             "end": "2026-11-01T00:00:00Z", "anchor_day": 15}, NOW)
        self.assertEqual(out["anchor_day"], 15)
        self.assertEqual(out["elapsed_days"], 30.5)


class PoolWeatherTests(WeatherCase):
    def test_shared_pool_full_weather(self):
        self.write_store([account("test:default", "test", plan_id="test.plus")])
        self.write_profiles([{"id": "cap", "provider": "test", "kind": "api",
                              "allowance_usd": 10.0, "billing_cycle": {"day": 1}}])
        self.create_events([{"input_tokens": 1_000_000} for _ in range(3)],
                           baseline_at=NOW - 40 * 86400)
        self.create_state(3_000_000)
        pool = self.account_entry(self.report())["rules"][0]
        # $6 of $10 with 30.5 of 31 days gone: behind pace, linear runway out.
        self.assertEqual(pool["profile_id"], "cap")
        self.assertEqual(pool["pool"], "shared")
        self.assertEqual(pool["used_usd"], 6.0)
        self.assertEqual(pool["limit_usd"], 10.0)
        self.assertEqual(pool["remaining_usd"], 4.0)
        self.assertEqual(pool["consumed_fraction"], 0.6)
        self.assertTrue(pool["valued_complete"])
        self.assertFalse(pool["lower_bound"])
        self.assertEqual(pool["verdict"], "behind")
        self.assertEqual(pool["verdict_basis"], "observed_vs_calendar")
        self.assertEqual(pool["pace_usd_per_day"], round(6.0 / 30.5, 6))
        self.assertEqual(pool["projected_exhaustion"], "2026-11-20T20:00:00Z")
        self.assertEqual(pool["forecast_status"], "ok")
        self.assertTrue(pool["coverage"]["baseline_covers_cycle"])
        self.assertEqual(pool["coverage"]["reconciliation_status"], "ok")

    def test_plan_window_carries_no_local_used_figure(self):
        self.write_store([account("test:default", "test", plan_id="test.plus")])
        self.write_profiles([{"id": "cap", "provider": "test", "kind": "api",
                              "allowance_usd": 10.0, "billing_cycle": {"day": 1}}])
        self.create_events([{"input_tokens": 1_000_000}],
                           baseline_at=NOW - 40 * 86400)
        self.create_state(1_000_000)
        window = self.account_entry(self.report())["windows"][0]
        self.assertEqual(window["declared"],
                         {"kind": "amount", "amount": 100.0, "currency": "USD",
                          "text": "100.0 USD"})
        self.assertEqual(window["cycle_basis"], "membership_cycle")
        self.assertEqual(window["verdict"], "unknown")
        self.assertIsNone(window["projection"])
        self.assertNotIn("used_usd", window)
        self.assertNotIn("pace_usd_per_day", window)
        self.assertTrue(any("not the provider's consumption" in note
                            for note in window["notes"]))

    def test_model_and_shared_pools_split_disjoint_rows(self):
        self.write_store([account("test:default", "test", plan_id="test.plus")])
        self.write_profiles([{"id": "cap", "provider": "test", "kind": "api",
                              "allowances": {"m": 5.0}, "allowance_usd": 20.0,
                              "billing_cycle": {"day": 1}}])
        self.create_events([{"model": "m", "input_tokens": 2_000_000},
                            {"model": "n", "input_tokens": 3_000_000}],
                           baseline_at=NOW - 40 * 86400)
        self.create_state(5_000_000)
        pools = {p["pool"]: p for p in self.account_entry(self.report())["rules"]}
        self.assertEqual(set(pools), {"model:m", "shared"})
        self.assertEqual(pools["model:m"]["used_usd"], 4.0)
        self.assertEqual(pools["model:m"]["consumed_fraction"], 0.8)
        self.assertEqual(pools["shared"]["used_usd"], 6.0)
        self.assertEqual(pools["shared"]["consumed_fraction"], 0.3)

    def test_unpriced_rows_make_consumption_a_lower_bound(self):
        self.write_store([account("test:default", "test", plan_id="test.plus")])
        self.write_profiles([{"id": "cap", "provider": "test", "kind": "api",
                              "allowance_usd": 10.0, "billing_cycle": {"day": 1}}])
        self.create_events([{"model": "m", "input_tokens": 2_000_000},
                            {"model": "mystery", "input_tokens": 1_000_000}],
                           baseline_at=NOW - 40 * 86400)
        self.create_state(3_000_000)
        pool = self.account_entry(self.report())["rules"][0]
        self.assertEqual(pool["used_usd"], 4.0)
        self.assertTrue(pool["lower_bound"])
        self.assertFalse(pool["valued_complete"])
        self.assertIsNone(pool["remaining_usd"])
        self.assertEqual(pool["verdict"], "unknown")
        self.assertIsNone(pool["pace_usd_per_day"])
        self.assertIsNone(pool["projected_exhaustion"])
        self.assertEqual(pool["forecast_status"], "unavailable")
        self.assertTrue(any("lower bound" in note for note in pool["notes"]))

    def test_lower_bound_ahead_survives_missing_values(self):
        self.write_store([account("test:default", "test", plan_id="test.plus")])
        self.write_profiles([{"id": "cap", "provider": "test", "kind": "api",
                              "allowance_usd": 10.0, "billing_cycle": {"day": 1}}])
        self.create_events([{"model": "m", "input_tokens": 4_750_000,
                             "ts": MID - 86400},
                            {"model": "mystery", "input_tokens": 1_000_000,
                             "ts": MID - 86400}],
                           baseline_at=NOW - 40 * 86400)
        self.create_state(5_750_000)
        pool = self.account_entry(self.report(now=MID))["rules"][0]
        # $9.50 observed of $10 with less than half the cycle gone.
        self.assertEqual(pool["verdict"], "ahead")
        self.assertTrue(pool["lower_bound"])
        self.assertEqual(pool["forecast_status"], "unavailable")

    def test_exhausted_pool_keeps_pace_and_a_past_projection(self):
        self.write_store([account("test:default", "test", plan_id="test.plus")])
        self.write_profiles([{"id": "cap", "provider": "test", "kind": "api",
                              "allowance_usd": 5.0, "billing_cycle": {"day": 1}}])
        self.create_events([{"input_tokens": 1_000_000} for _ in range(3)],
                           baseline_at=NOW - 40 * 86400)
        self.create_state(3_000_000)
        pool = self.account_entry(self.report())["rules"][0]
        self.assertEqual(pool["verdict"], "exhausted")
        self.assertEqual(pool["remaining_usd"], -1.0)
        self.assertEqual(pool["forecast_status"], "ok")
        self.assertEqual(pool["projected_exhaustion"], "2026-10-26T10:00:00Z")

    def test_reconciliation_gap_withholds_the_forecast(self):
        self.write_store([account("test:default", "test", plan_id="test.plus")])
        self.write_profiles([{"id": "cap", "provider": "test", "kind": "api",
                              "allowance_usd": 10.0, "billing_cycle": {"day": 1}}])
        self.create_events([{"input_tokens": 1_000_000} for _ in range(3)],
                           baseline_at=NOW - 40 * 86400)
        self.create_state(5_000_000)
        pool = self.account_entry(self.report())["rules"][0]
        self.assertEqual(pool["verdict"], "behind")
        self.assertEqual(pool["forecast_status"], "unavailable")
        self.assertIsNone(pool["projected_exhaustion"])
        self.assertTrue(any("missed" in note for note in pool["notes"]))

    def test_missing_baseline_withholds_the_forecast(self):
        self.write_store([account("test:default", "test", plan_id="test.plus")])
        self.write_profiles([{"id": "cap", "provider": "test", "kind": "api",
                              "allowance_usd": 10.0, "billing_cycle": {"day": 1}}])
        self.create_events([{"input_tokens": 1_000_000}])
        self.create_state(1_000_000)
        pool = self.account_entry(self.report())["rules"][0]
        self.assertEqual(pool["forecast_status"], "unavailable")
        self.assertTrue(any("Recording started inside" in note for note in pool["notes"]))

    def test_baseline_inside_the_cycle_withholds_the_forecast(self):
        self.write_store([account("test:default", "test", plan_id="test.plus")])
        self.write_profiles([{"id": "cap", "provider": "test", "kind": "api",
                              "allowance_usd": 10.0, "billing_cycle": {"day": 1}}])
        self.create_events([{"input_tokens": 1_000_000}],
                           baseline_at=NOW - 5 * 86400)
        self.create_state(1_000_000)
        pool = self.account_entry(self.report())["rules"][0]
        self.assertFalse(pool["coverage"]["baseline_covers_cycle"])
        self.assertEqual(pool["forecast_status"], "unavailable")

    def test_missing_state_database_withholds_the_forecast(self):
        self.write_store([account("test:default", "test", plan_id="test.plus")])
        self.write_profiles([{"id": "cap", "provider": "test", "kind": "api",
                              "allowance_usd": 10.0, "billing_cycle": {"day": 1}}])
        self.create_events([{"input_tokens": 1_000_000}],
                           baseline_at=NOW - 40 * 86400)
        pool = self.account_entry(self.report())["rules"][0]
        self.assertEqual(pool["coverage"]["reconciliation_status"], "state_db_unavailable")
        self.assertEqual(pool["forecast_status"], "unavailable")
        self.assertTrue(any("unavailable" in note for note in pool["notes"]))

    def test_first_day_gives_a_verdict_but_no_pace(self):
        dawn = datetime(2026, 10, 1, 12, tzinfo=timezone.utc).timestamp()
        self.write_store([account("test:default", "test", plan_id="test.plus")])
        self.write_profiles([{"id": "cap", "provider": "test", "kind": "api",
                              "allowance_usd": 10.0, "billing_cycle": {"day": 1}}])
        self.create_events([{"input_tokens": 1_000_000, "ts": dawn - 6 * 3600}],
                           baseline_at=dawn - 40 * 86400)
        self.create_state(1_000_000)
        pool = self.account_entry(self.report(now=dawn))["rules"][0]
        self.assertEqual(pool["elapsed_days"], 0.5)
        self.assertEqual(pool["verdict"], "ahead")
        self.assertIsNone(pool["pace_usd_per_day"])
        self.assertEqual(pool["forecast_status"], "unavailable")
        self.assertTrue(any("less than a day" in note for note in pool["notes"]))

    def test_zero_usage_has_no_pace(self):
        self.write_store([account("test:default", "test", plan_id="test.plus")])
        self.write_profiles([{"id": "cap", "provider": "test", "kind": "api",
                              "allowance_usd": 10.0, "billing_cycle": {"day": 1}}])
        self.create_events([], baseline_at=NOW - 40 * 86400)
        self.create_state(0)
        pool = self.account_entry(self.report())["rules"][0]
        self.assertEqual(pool["used_usd"], 0.0)
        self.assertEqual(pool["verdict"], "behind")
        self.assertIsNone(pool["pace_usd_per_day"])
        self.assertEqual(pool["forecast_status"], "unavailable")
        self.assertTrue(any("No consumption observed" in note for note in pool["notes"]))

    def test_prepaid_without_cap_shows_spend_only(self):
        self.write_store([account("test:default", "test", plan_id="test.plus")])
        self.write_profiles([{"id": "wallet", "provider": "test", "kind": "prepaid",
                              "billing_cycle": {"day": 1}}])
        self.create_events([{"input_tokens": 1_000_000} for _ in range(3)],
                           baseline_at=NOW - 40 * 86400)
        self.create_state(3_000_000)
        pool = self.account_entry(self.report())["rules"][0]
        self.assertEqual(pool["pool"], "prepaid_spend")
        self.assertIsNone(pool["limit_usd"])
        self.assertEqual(pool["used_usd"], 6.0)
        self.assertEqual(pool["verdict"], "unknown")
        self.assertEqual(pool["forecast_status"], "not_applicable")
        self.assertTrue(any("balance is unknown" in note for note in pool["notes"]))

    def test_prepaid_with_cap_gets_full_weather(self):
        self.write_store([account("test:default", "test", plan_id="test.plus")])
        self.write_profiles([{"id": "wallet", "provider": "test", "kind": "prepaid",
                              "allowance_usd": 10.0, "billing_cycle": {"day": 1}}])
        self.create_events([{"input_tokens": 1_000_000} for _ in range(3)],
                           baseline_at=NOW - 40 * 86400)
        self.create_state(3_000_000)
        pool = self.account_entry(self.report())["rules"][0]
        self.assertEqual(pool["pool"], "shared")
        self.assertEqual(pool["used_usd"], 6.0)
        self.assertEqual(pool["forecast_status"], "ok")

    def test_custom_rate_override_sets_the_pool_basis(self):
        self.write_store([account("test:default", "test", plan_id="test.plus")])
        self.write_profiles([{"id": "deal", "provider": "test", "kind": "custom",
                              "rate_override": {"input": 10.0, "output": 10.0},
                              "allowance_usd": 50.0, "billing_cycle": {"day": 1}}])
        self.create_events([{"input_tokens": 1_000_000}],
                           baseline_at=NOW - 40 * 86400)
        self.create_state(1_000_000)
        pool = self.account_entry(self.report())["rules"][0]
        self.assertEqual(pool["used_usd"], 10.0)
        self.assertEqual(pool["consumed_fraction"], 0.2)

    def test_rule_outside_its_effective_dates_is_skipped(self):
        self.write_store([account("test:default", "test", plan_id="test.plus")])
        self.write_profiles([
            {"id": "old", "provider": "test", "kind": "api", "allowance_usd": 10.0,
             "effective_to": "2026-09-15T00:00:00Z", "billing_cycle": {"day": 1}},
            {"id": "future", "provider": "test", "kind": "api", "allowance_usd": 10.0,
             "effective_from": "2026-11-05T00:00:00Z", "billing_cycle": {"day": 1}},
        ])
        self.create_events([], baseline_at=NOW - 40 * 86400)
        self.create_state(0)
        entry = self.account_entry(self.report())
        self.assertEqual(entry["rules"], [])
        self.assertEqual(len(entry["notes"]), 2)
        self.assertTrue(all("not in force" in note for note in entry["notes"]))


class WindowWeatherTests(WeatherCase):
    def test_provider_share_ahead_of_calendar(self):
        self.write_store([account("test:default", "test", plan_id="test.plus")])
        self.write_profiles([])
        snap = snapshot(provider_window("Monthly credit", 80.0,
                                        reset_at="2026-11-01T00:00:00Z"),
                        now=MID)
        window = self.account_entry(
            self.report(now=MID, native_snapshots={"test": snap}))["windows"][0]
        self.assertEqual(window["provider"]["used_percent"], 80.0)
        self.assertEqual(window["provider"]["reset_in_days"], 16.5)
        self.assertEqual(window["verdict"], "ahead")
        self.assertEqual(window["verdict_basis"], "provider_vs_calendar")
        self.assertIsNone(window["projection"])
        self.assertTrue(any("provider-reported share" in note for note in window["notes"]))

    def test_provider_share_behind_calendar(self):
        self.write_store([account("test:default", "test", plan_id="test.plus")])
        self.write_profiles([])
        snap = snapshot(provider_window("Monthly credit", 62.0,
                                        reset_at="2026-11-01T00:00:00Z"))
        window = self.account_entry(
            self.report(native_snapshots={"test": snap}))["windows"][0]
        self.assertEqual(window["verdict"], "behind")

    def test_provider_exhaustion_is_exhausted(self):
        self.write_store([account("test:default", "test", plan_id="test.plus")])
        self.write_profiles([])
        snap = snapshot(provider_window("Monthly credit", 100.0))
        window = self.account_entry(
            self.report(native_snapshots={"test": snap}))["windows"][0]
        self.assertEqual(window["verdict"], "exhausted")
        self.assertEqual(window["verdict_basis"], "provider_reported")

    def test_stale_reading_carries_a_caution(self):
        self.write_store([account("test:default", "test", plan_id="test.plus")])
        self.write_profiles([])
        snap = snapshot(provider_window("Monthly credit", 80.0), fetched_ago=7200,
                        now=MID)
        window = self.account_entry(
            self.report(now=MID, native_snapshots={"test": snap}))["windows"][0]
        self.assertEqual(window["provider"]["state"], "stale")
        self.assertEqual(window["verdict"], "ahead")
        self.assertTrue(any("stale" in note for note in window["notes"]))

    def test_rolling_window_gets_no_calendar_verdict(self):
        plans = plans_doc(
            {"id": "test.plus", "provider_family": "test", "name": "Test Plus",
             "price": {"amount": 20.0, "currency": "USD", "period": "month"},
             "entitlements": {"windows": [credit_window(
                 id="current-week", label="Current week", kind="rolling",
                 limit="percent", amount=None, currency=None,
                 duration_minutes=10080, scope="account")]}})
        self.write_store([account("test:default", "test", plan_id="test.plus")])
        self.write_profiles([])
        snap = snapshot(provider_window("Current week", 50.0))
        window = self.account_entry(
            self.report(plans=plans, native_snapshots={"test": snap}))["windows"][0]
        self.assertEqual(window["kind"], "rolling")
        self.assertIsNone(window["cycle"])
        self.assertEqual(window["verdict"], "unknown")
        self.assertEqual(window["verdict_basis"], "provider_only")
        self.assertEqual(window["declared"]["kind"], "percent")

    def test_manual_mark_reads_exhausted(self):
        mark = manual_mark("monthly-credit", "Monthly credit", "2026-10-31T10:00:00Z")
        self.write_store([account("test:default", "test", plan_id="test.plus",
                                  manual_exhaustions=[mark])])
        self.write_profiles([])
        window = self.account_entry(self.report())["windows"][0]
        self.assertEqual(window["verdict"], "exhausted")
        self.assertEqual(window["verdict_basis"], "manual")
        self.assertEqual(window["manual"]["status"], "active")
        self.assertTrue(any("never presented as provider-confirmed" in note
                            for note in window["notes"]))

    def test_contradicted_mark_reads_unknown(self):
        mark = manual_mark("monthly-credit", "Monthly credit", "2026-10-31T10:00:00Z")
        self.write_store([account("test:default", "test", plan_id="test.plus",
                                  manual_exhaustions=[mark])])
        self.write_profiles([])
        snap = snapshot(provider_window("Monthly credit", 20.0))
        window = self.account_entry(
            self.report(native_snapshots={"test": snap}))["windows"][0]
        self.assertTrue(window["conflict"])
        self.assertEqual(window["verdict"], "unknown")
        self.assertEqual(window["verdict_basis"], "conflicted")

    def test_manual_mark_outranks_a_stale_provider_share(self):
        mark = manual_mark("monthly-credit", "Monthly credit", "2026-10-31T10:00:00Z")
        self.write_store([account("test:default", "test", plan_id="test.plus",
                                  manual_exhaustions=[mark])])
        self.write_profiles([])
        snap = snapshot(provider_window("Monthly credit", 60.0), fetched_ago=7200)
        window = self.account_entry(
            self.report(native_snapshots={"test": snap}))["windows"][0]
        self.assertFalse(window["conflict"])
        self.assertEqual(window["verdict"], "exhausted")
        self.assertEqual(window["verdict_basis"], "manual")
        self.assertEqual(window["provider"]["used_percent"], 60.0)

    def test_monthly_allowance_follows_calendar_months(self):
        plans = plans_doc(
            {"id": "test.plus", "provider_family": "test", "name": "Test Plus",
             "price": {"amount": 20.0, "currency": "USD", "period": "month"},
             "entitlements": {"windows": [credit_window(kind="monthly")]}})
        # A mid-month billing anchor must not move the calendar-month window.
        self.write_store([account("test:default", "test", plan_id="test.plus",
                                  billing_cycle={"anchor_day": 15})])
        self.write_profiles([])
        entry = self.account_entry(self.report(plans=plans))
        window = entry["windows"][0]
        self.assertEqual(window["cycle_basis"], "calendar_month")
        self.assertEqual(window["cycle"]["start"], "2026-10-01T00:00:00Z")
        self.assertEqual(window["cycle"]["end"], "2026-11-01T00:00:00Z")
        self.assertEqual(entry["cycle"]["start"], "2026-10-15T00:00:00Z")

    def test_credit_count_and_unknown_limits_are_labelled(self):
        plans = plans_doc(
            {"id": "test.plus", "provider_family": "test", "name": "Test Plus",
             "price": {"amount": 20.0, "currency": "USD", "period": "month"},
             "entitlements": {"windows": [
                 credit_window(id="weekly", label="Weekly", kind="rolling",
                               limit="credits", amount=60000.0, currency=None,
                               duration_minutes=10080),
                 credit_window(id="quota", label="Quota", kind="credits",
                               limit="usd", amount=None, currency=None)]}})
        self.write_store([account("test:default", "test", plan_id="test.plus")])
        self.write_profiles([])
        windows = {w["id"]: w for w in self.account_entry(
            self.report(plans=plans))["windows"]}
        self.assertEqual(windows["weekly"]["declared"]["kind"], "credits")
        self.assertEqual(windows["weekly"]["declared"]["amount"], 60000.0)
        self.assertEqual(windows["quota"]["declared"]["kind"], "unknown")
        self.assertEqual(windows["quota"]["verdict"], "unknown")


class AttributionTests(WeatherCase):
    def test_ambiguous_route_stays_unlinked(self):
        self.write_store([account("test:a", "test"), account("test:b", "test")])
        self.write_profiles([{"id": "cap", "provider": "test", "kind": "api",
                              "allowance_usd": 10.0, "billing_cycle": {"day": 1}}])
        self.create_events([{"input_tokens": 1_000_000}],
                           baseline_at=NOW - 40 * 86400)
        self.create_state(1_000_000)
        result = self.report()
        for entry in result["accounts"]:
            self.assertEqual(entry["rules"], [])
        self.assertEqual(len(result["unlinked_rules"]), 1)
        pool = result["unlinked_rules"][0]
        self.assertEqual(pool["used_usd"], 2.0)
        self.assertTrue(any("more than one account" in note for note in pool["notes"]))

    def test_unclaimed_route_stays_unlinked(self):
        self.write_store([account("test:default", "test", plan_id="test.plus")])
        self.write_profiles([{"id": "ghost", "provider": "ghost", "kind": "api",
                              "allowance_usd": 10.0, "billing_cycle": {"day": 1}}])
        self.create_events([], baseline_at=NOW - 40 * 86400)
        self.create_state(0)
        result = self.report()
        self.assertEqual(result["accounts"][0]["rules"], [])
        self.assertEqual(len(result["unlinked_rules"]), 1)
        self.assertTrue(any("No account claims" in note
                            for note in result["unlinked_rules"][0]["notes"]))

    def test_legacy_arrangements_are_counted_not_shown(self):
        self.write_store([account("test:default", "test", plan_id="test.plus")])
        self.write_profiles([{"id": "old", "provider": "test",
                              "kind": "subscription_included"}])
        self.create_events([], baseline_at=NOW - 40 * 86400)
        self.create_state(0)
        result = self.report()
        self.assertEqual(result["legacy_ignored"], 1)
        self.assertEqual(result["accounts"][0]["rules"], [])
        self.assertEqual(result["unlinked_rules"], [])

    def test_global_default_rule_is_reported_unlinked(self):
        self.write_store([account("test:default", "test", plan_id="test.plus")])
        self.write_profiles([], defaults={"kind": "api", "allowance_usd": 50.0})
        self.create_events([{"provider": "other", "input_tokens": 1_000_000}],
                           baseline_at=NOW - 40 * 86400)
        self.create_state(1_000_000)
        result = self.report()
        self.assertEqual(result["accounts"][0]["rules"], [])
        self.assertEqual(len(result["unlinked_rules"]), 1)
        pool = result["unlinked_rules"][0]
        self.assertEqual(pool["scope"], "defaults")
        self.assertEqual(pool["used_usd"], 2.0)


class ReportShapeTests(WeatherCase):
    def test_empty_store_is_an_empty_report(self):
        result = self.report()
        self.assertTrue(result["ok"])
        self.assertEqual(result["accounts"], [])
        self.assertEqual(result["generated_at"], "2026-10-31T12:00:00Z")
        self.assertFalse(result["native_probe"])
        self.assertIn("coverage", result)
        self.assertTrue(any("never stands in" in note for note in result["notes"]))

    def test_missing_databases_do_not_fail(self):
        self.write_store([account("test:default", "test", plan_id="test.plus")])
        self.write_profiles([{"id": "cap", "provider": "test", "kind": "api",
                              "allowance_usd": 10.0, "billing_cycle": {"day": 1}}])
        entry = self.account_entry(self.report())
        pool = entry["rules"][0]
        self.assertEqual(pool["used_usd"], 0.0)
        self.assertEqual(pool["forecast_status"], "unavailable")
        self.assertEqual(entry["cycle"]["elapsed_days"], 30.5)

    def test_unreadable_profiles_keep_membership_weather(self):
        self.write_store([account("test:default", "test", plan_id="test.plus")])
        self.profiles.write_text("{not json")
        entry = self.account_entry(self.report())
        self.assertEqual(entry["rules"], [])
        self.assertEqual(len(entry["windows"]), 1)
        self.assertNotEqual(self.report()["rules_error"], "")

    def test_unreadable_store_raises(self):
        self.memberships.write_text("{not json")
        with self.assertRaises(mstore.StoreUnreadable):
            self.report()

    def test_rollup_leads_with_the_worst_state(self):
        mark = manual_mark("monthly-credit", "Monthly credit", "2026-10-31T10:00:00Z")
        self.write_store([
            account("test:calm", "test", plan_id="test.plus"),
            account("test:hot", "other-test", plan_id=None,
                    route_slugs=["other-test"], manual_exhaustions=[mark]),
        ])
        self.write_profiles([{"id": "cap", "provider": "test", "kind": "api",
                              "allowance_usd": 10.0, "billing_cycle": {"day": 1}}])
        self.create_events([{"input_tokens": 1_000_000}],
                           baseline_at=NOW - 40 * 86400)
        self.create_state(1_000_000)
        result = self.report()
        by_id = {a["account_id"]: a for a in result["accounts"]}
        # Behind pace on the rule, unknown provider window: behind leads.
        self.assertEqual(by_id["test:calm"]["rollup"], {"state": "behind"})
        # Manual exhaustion outranks everything on its card.
        self.assertEqual(by_id["test:hot"]["rollup"], {"state": "exhausted"})

    def test_accounts_sort_by_family_then_label(self):
        self.write_store([account("z:one", "zebra"), account("a:one", "apple")])
        self.write_profiles([])
        result = self.report()
        self.assertEqual([a["family"] for a in result["accounts"]],
                         ["apple", "zebra"])


if __name__ == "__main__":
    unittest.main()
