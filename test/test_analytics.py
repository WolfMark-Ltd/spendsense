"""Read-only analytics contract, using isolated SQLite fixtures only."""
from __future__ import annotations

import importlib
import importlib.util
import os
import sqlite3
import tempfile
import time
import unittest
from contextlib import closing, contextmanager
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo
from pathlib import Path

from wolfmark_ledger import store
from wolfmark_ledger.pricing import Catalogue, Rate, Tier

NOW = datetime(2026, 10, 29, 12, tzinfo=timezone.utc).timestamp()


@contextmanager
def local_zone(name):
    previous = os.environ.get("TZ")
    os.environ["TZ"] = name
    time.tzset()
    try:
        yield
    finally:
        if previous is None:
            os.environ.pop("TZ", None)
        else:
            os.environ["TZ"] = previous
        time.tzset()


class AnalyticsTests(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory(dir=os.environ.get("TMPDIR"))
        self.addCleanup(self.scratch.cleanup)
        self.events = Path(self.scratch.name) / "usage.db"
        self.state = Path(self.scratch.name) / "state.db"
        self.book = Catalogue({"test": {"m": Rate(2, 4, .5, 3)}}, "fixture", "test", "", "1")

    def report(self, **kwargs):
        self.assertIsNotNone(importlib.util.find_spec("wolfmark_ledger.analytics"),
                             "analytics module has not been implemented")
        build = importlib.import_module("wolfmark_ledger.analytics").build_analytics_report
        return build(self.events, state_db_path=self.state, now=kwargs.pop("now", NOW),
                     catalogue=self.book, **kwargs)

    def create_events(self, rows=()):
        with closing(sqlite3.connect(self.events)) as conn, conn:
            conn.executescript(store._SCHEMA)
            for index, row in enumerate(rows):
                values = {"event_id": f"event-{index}", "ts": NOW - 1,
                          "model": "m", "provider": "test", "platform": "desktop",
                          "outcome": "ok", "recorded_at": NOW, **row}
                columns = list(values)
                conn.execute(f"INSERT INTO calls ({','.join(columns)}) VALUES "
                             f"({','.join('?' for _ in columns)})", list(values.values()))

    def create_sessions(self, rows=()):
        with closing(sqlite3.connect(self.state)) as conn, conn:
            conn.execute("CREATE TABLE IF NOT EXISTS sessions ("
                         "id TEXT PRIMARY KEY, source TEXT DEFAULT '', model TEXT DEFAULT '', "
                         "parent_session_id TEXT, model_config TEXT, started_at REAL)")
            for row in rows:
                values = {"id": "", "source": "desktop", "model": "", "parent_session_id": None,
                          "model_config": None, "started_at": NOW, **row}
                columns = list(values)
                conn.execute(f"INSERT OR REPLACE INTO sessions ({','.join(columns)}) VALUES "
                             f"({','.join('?' for _ in columns)})", list(values.values()))

    def test_scope_attribution_separates_direct_subagent_auxiliary_and_unattributed(self):
        self.create_sessions([
            {"id": "parent-a"},
            {"id": "child-a1", "parent_session_id": "parent-a"},
            {"id": "child-a2", "parent_session_id": "parent-a"},
        ])
        self.create_events([
            {"session_id": "parent-a", "input_tokens": 100, "cache_read_tokens": 900},
            {"session_id": "parent-a", "input_tokens": 50, "aux_task": "compression"},
            {"session_id": "child-a1", "input_tokens": 200, "cache_read_tokens": 800},
            {"session_id": "child-a2", "input_tokens": 300, "cache_read_tokens": 700},
            {"session_id": "", "input_tokens": 40},
            {"session_id": "not-in-sessions", "input_tokens": 10},
        ])
        report = self.report(days=1)
        scope = {row["scope"]: row for row in report["by_scope"]}
        self.assertEqual(scope["direct"]["calls"], 1)
        self.assertEqual(scope["auxiliary"]["calls"], 1)
        self.assertEqual(scope["subagent"]["calls"], 2)
        self.assertEqual(scope["unattributed"]["calls"], 2, "unknown sessions must never be discarded")
        self.assertEqual(sum(row["tokens"] for row in scope.values()), report["totals"]["tokens"])
        self.assertEqual(sum(row["calls"] for row in scope.values()), report["totals"]["calls"])
        attribution = report["attribution"]
        self.assertEqual(attribution["child_sessions"], 2)
        self.assertEqual(attribution["unattributed_calls"], 2)
        self.assertEqual(attribution["cycles"], 0)

    def test_nested_delegation_rolls_up_to_its_operation_root_without_double_counting(self):
        self.create_sessions([
            {"id": "root"},
            {"id": "child", "parent_session_id": "root"},
            {"id": "grandchild", "parent_session_id": "child"},
            {"id": "other"},
        ])
        self.create_events([
            {"session_id": "root", "input_tokens": 10},
            {"session_id": "child", "input_tokens": 20},
            {"session_id": "grandchild", "input_tokens": 30},
            {"session_id": "other", "input_tokens": 40},
        ])
        report = self.report(days=1, parent="root")
        self.assertEqual(report["totals"]["calls"], 3, "nested child belongs to the same operation")
        self.assertEqual(report["totals"]["input_tokens"], 60)
        scope = {row["scope"]: row for row in report["by_scope"]}
        self.assertEqual(scope["direct"]["calls"], 1)
        self.assertEqual(scope["subagent"]["calls"], 2, "grandchild is delegated work, not direct")
        self.assertEqual(report["attribution"]["operation_root"], "root")
        self.assertEqual(sum(row["calls"] for row in scope.values()), report["totals"]["calls"])

    def test_parent_and_scope_filters_are_exact_and_never_invent_attribution(self):
        self.create_sessions([
            {"id": "root"},
            {"id": "child", "parent_session_id": "root"},
            {"id": "other-root"},
        ])
        self.create_events([
            {"session_id": "root", "input_tokens": 10},
            {"session_id": "child", "input_tokens": 20},
            {"session_id": "other-root", "input_tokens": 40},
            {"session_id": "", "input_tokens": 5},
        ])
        direct = self.report(days=1, parent="root", scope="direct")
        self.assertEqual(direct["totals"]["input_tokens"], 10)
        sub = self.report(days=1, parent="root", scope="subagent")
        self.assertEqual(sub["totals"]["input_tokens"], 20)
        combined = self.report(days=1, parent="root")
        self.assertEqual(combined["totals"]["input_tokens"], 30)
        self.assertEqual(combined["filters"]["parent"], "root")
        all_scope = self.report(days=1)
        self.assertIsNone(all_scope["filters"]["parent"])
        self.assertEqual(all_scope["totals"]["input_tokens"], 75)

    def test_attribution_survives_missing_state_sessions_table(self):
        self.create_events([{"session_id": "unknown", "input_tokens": 12}])
        report = self.report(days=1)
        self.assertEqual(report["totals"]["calls"], 1)
        self.assertEqual([row["scope"] for row in report["by_scope"]], ["unattributed"])
        self.assertEqual(report["attribution"]["child_sessions"], 0)

    def test_local_display_timestamps_follow_each_bucket_offset(self):
        with local_zone("Europe/London"):
            now = datetime(2026, 7, 9, 12, tzinfo=ZoneInfo("Europe/London")).timestamp()
            report = self.report(days=1, now=now)
            self.assertEqual(report["window"].get("since_local"), "2026-07-09T00:00:00+01:00")
            self.assertEqual(report["window"]["until_local"], "2026-07-09T12:00:00+01:00")
            self.assertEqual(report["trend"]["buckets"][0]["ts_local"], "2026-07-09T00:00:00+01:00")
            self.assertEqual(report["trend"]["buckets"][0]["ts"], "2026-07-08T23:00:00+00:00")

    def test_empty_missing_store_has_complete_contract_without_creating_files(self):
        report = self.report(days=1)
        self.assertEqual(set(report), {"ok", "window", "filters", "options", "totals",
                                     "by_model", "by_route", "by_scope", "attribution", "pricing_source", "valuation",
                                     "pricing_coverage", "billing",
                                     "trend", "economics", "recording", "notes"})
        self.assertTrue(report["ok"])
        self.assertEqual(report["window"]["kind"], "timestamped_calls")
        self.assertEqual(report["filters"], dict.fromkeys(
            ("model", "provider", "surface", "task", "parent", "scope")))
        self.assertEqual(report["options"], {"models": [], "providers": [], "surfaces": [], "tasks": [],
                                             "scopes": ["direct", "subagent", "auxiliary", "unattributed"],
                                             "operations": []})
        self.assertEqual(report["by_scope"], [])
        self.assertEqual(report["attribution"]["child_sessions"], 0)
        self.assertEqual(report["attribution"]["unattributed_calls"], 0)
        self.assertEqual(report["totals"]["calls"], 0)
        self.assertEqual(report["totals"]["tokens"], 0)
        self.assertIsNone(report["totals"]["cache_hit_rate"])
        self.assertEqual(report["totals"]["economics"], report["economics"])
        self.assertEqual(report["recording"], {"since": "", "last": "", "calls": 0})
        self.assertEqual(report["trend"]["granularity"], "hour")
        self.assertGreater(len(report["trend"]["buckets"]), 0)
        self.assertTrue(all(b["calls"] == 0 for b in report["trend"]["buckets"]))
        self.assertFalse(self.events.exists())
        self.assertFalse(self.state.exists())

    def test_timestamped_totals_groups_options_and_billing_classification(self):
        self.create_events([
            {"input_tokens": 100, "output_tokens": 10, "cache_read_tokens": 20,
             "reasoning_tokens": 6, "ts": NOW - 3600},
            {"input_tokens": 5, "provider": "unknown", "aux_task": "title",
             "platform": "telegram"},
            {"input_tokens": 7, "outcome": "error"},
            {"input_tokens": 9, "outcome": "missing_usage"},
            {"input_tokens": 10000, "ts": NOW + 1},
        ])
        with closing(sqlite3.connect(self.state)) as conn, conn:
            conn.execute("CREATE TABLE session_model_usage (billing_provider TEXT, model TEXT, "
                         "cost_status TEXT, actual_cost_usd REAL, estimated_cost_usd REAL, last_seen REAL)")
            conn.execute("INSERT INTO session_model_usage VALUES ('test','m','included',0,0,?)", (NOW,))
        report = self.report(days=1)
        totals = report["totals"]
        self.assertEqual(totals["calls"], 4)
        self.assertEqual(totals["tokens"], 151)
        self.assertEqual(totals.get("reasoning_tokens"), 6, "reasoning remains a subset of output, not added to tokens")
        self.assertEqual(sum(row["reasoning_tokens"] for row in report["by_model"]), 6)
        self.assertEqual(totals["priced_tokens"], 130)
        self.assertEqual(totals["unpriced_tokens"], 21)
        self.assertAlmostEqual(totals["list_usd"], .00025)
        self.assertIsNone(totals["billed_usd"])
        self.assertFalse(totals["billed_complete"])
        self.assertEqual(totals["billing_mix"], {"included": 3, "unknown": 1})
        self.assertEqual(len(report["by_model"]), 2)
        included = next(row for row in report["by_route"] if row["provider"] == "test")
        self.assertEqual(included["billed_usd"], 0)
        self.assertTrue(included["billed_complete"])
        self.assertEqual(sum(b["tokens"] for b in report["trend"]["buckets"]), totals["tokens"])
        self.assertEqual(report["options"], {
            "models": [{"model": "m", "provider": "test"}, {"model": "m", "provider": "unknown"}],
            "providers": ["test", "unknown"], "surfaces": ["desktop", "telegram"],
            "tasks": ["main", "title"],
            "scopes": ["direct", "subagent", "auxiliary", "unattributed"],
            "operations": [],
        })
        self.assertEqual(report["recording"]["calls"], 5)
        self.assertEqual(report["recording"]["since"], datetime.fromtimestamp(NOW - 3600, timezone.utc).isoformat())
        self.assertTrue(any("error" in note.lower() for note in report["notes"]))

    def test_cache_hit_rate_is_weighted_prompt_only_with_unknown_zero_provenance(self):
        self.create_events([
            {"input_tokens": 10, "cache_read_tokens": 90, "output_tokens": 9000},
            {"input_tokens": 800, "cache_read_tokens": 100, "cache_write_tokens": 100},
            {"input_tokens": 5000, "output_tokens": 100},
            {"outcome": "missing_usage"},
        ])
        report = self.report(days=1)
        totals = report["totals"]
        self.assertIsNotNone(totals["cache_hit_rate"], "positive cache buckets establish known provenance")
        self.assertAlmostEqual(totals["cache_hit_rate"], 190 / 1100, places=6)
        self.assertEqual(totals["cache_known_calls"], 2)
        self.assertEqual(totals["cache_unknown_calls"], 2)
        self.assertEqual(totals["cache_coverage"], .5)
        for grouped in [report["by_model"][0], report["by_route"][0],
                        next(b for b in report["trend"]["buckets"] if b["calls"])]:
            self.assertEqual(grouped["cache_hit_rate"], totals["cache_hit_rate"])
            self.assertEqual(grouped["cache_known_calls"], 2)
        self.assertTrue(any("all-zero" in note.lower() and "unknown" in note.lower()
                            for note in report["notes"]))

    def test_economics_uses_whole_known_calls_and_preserves_negative_savings(self):
        self.create_events([
            {"input_tokens": 100, "cache_read_tokens": 200, "output_tokens": 10},
            {"input_tokens": 100, "cache_write_tokens": 1000, "output_tokens": 10},
            {"input_tokens": 100, "output_tokens": 10},
            {"input_tokens": 100, "cache_read_tokens": 50, "outcome": "error"},
            {"input_tokens": 100, "cache_read_tokens": 50, "outcome": "missing_usage"},
        ])
        report = self.report(days=1)
        econ = report["economics"]
        self.assertEqual(econ["covered_calls"], 2)
        self.assertEqual(econ["excluded_calls"], 3)
        self.assertEqual(econ["covered_tokens"], 1420)
        uncached = ((100 + 200) * 2 + 10 * 4 + (100 + 1000) * 2 + 10 * 4) / 1_000_000
        cached = (100 * 2 + 200 * .5 + 10 * 4 + 100 * 2 + 1000 * 3 + 10 * 4) / 1_000_000
        self.assertEqual(econ["uncached_usd"], round(uncached, 6))
        self.assertEqual(econ["cached_usd"], round(cached, 6))
        self.assertEqual(econ["savings_usd"], round(uncached - cached, 6))
        self.assertLess(econ["savings_usd"], 0, "cache-write premiums must not be clamped")
        self.assertAlmostEqual(econ["coverage"], 1420 / report["totals"]["tokens"], places=6)
        self.assertEqual(report["totals"]["economics"], econ)
        self.assertEqual(report["by_model"][0]["economics"], econ)
        self.assertEqual(next(b for b in report["trend"]["buckets"] if b["calls"])["economics"], econ)

    def test_economics_excludes_required_price_gaps_without_changing_list_fallback(self):
        self.book = Catalogue({"test": {
            "no-read": Rate(2, 4, None, 3), "no-write": Rate(2, 4, .5, None),
            "no-output": Rate(2, None, .5, 3),
        }}, "fixture", "test", "", "1")
        self.create_events([
            {"model": "no-read", "input_tokens": 100, "cache_read_tokens": 200},
            {"model": "no-write", "input_tokens": 100, "cache_write_tokens": 200},
            {"model": "no-output", "cache_read_tokens": 200, "output_tokens": 100},
            {"model": "missing", "cache_read_tokens": 200},
        ])
        report = self.report(days=1)
        econ = report["economics"]
        self.assertEqual(econ["excluded_calls"], 4)
        self.assertEqual(econ["covered_calls"], 0)
        self.assertIsNone(econ["cached_usd"])
        self.assertIsNone(econ["uncached_usd"])
        self.assertIsNone(econ["savings_usd"])
        self.assertEqual(report["totals"]["priced_tokens"], 600)
        self.assertEqual(report["totals"]["unpriced_tokens"], 500)
        self.assertGreater(report["totals"]["list_usd"], 0)
        self.assertEqual(report["totals"].get("fallback_calls"), 2)
        by_model = {row["model"]: row for row in report["by_model"]}
        self.assertEqual(by_model["no-read"]["fallback_calls"], 1)
        self.assertEqual(by_model["missing"]["fallback_calls"], 0)
        self.assertEqual(sum(b["fallback_calls"] for b in report["trend"]["buckets"]), 2)
        self.assertTrue(any("fallback" in note.lower() for note in report["notes"]))
        self.assertTrue(any("missing_cache_read_rate" in note for note in report["notes"]))
        self.assertTrue(any("missing_cache_write_rate" in note for note in report["notes"]))

    def test_economics_applies_tiers_per_call_to_all_buckets_even_when_rates_decrease(self):
        self.book = Catalogue({"test": {"m": Rate(2, 4, .5, 3, (
            Tier(100, 6, 8, 1, 9), Tier(200, 1, 2, 0, 0),
        ))}}, "fixture", "test", "", "1")
        self.create_events([
            {"input_tokens": 50, "cache_read_tokens": 50, "output_tokens": 10},
            {"input_tokens": 50, "cache_read_tokens": 51, "output_tokens": 10},
            {"input_tokens": 100, "cache_read_tokens": 101, "output_tokens": 10},
        ])
        econ = self.report(days=1)["economics"]
        expected_uncached = (100 * 2 + 10 * 4 + 101 * 6 + 10 * 8 + 201 * 1 + 10 * 2) / 1_000_000
        expected_cached = (50 * 2 + 50 * .5 + 10 * 4 + 50 * 6 + 51 * 1 + 10 * 8
                           + 100 * 1 + 101 * 0 + 10 * 2) / 1_000_000
        self.assertEqual(econ["uncached_usd"], round(expected_uncached, 6))
        self.assertEqual(econ["cached_usd"], round(expected_cached, 6))
        self.assertEqual(econ["savings_usd"], round(expected_uncached - expected_cached, 6))
        self.assertEqual(econ["covered_calls"], 3)

    def test_exact_and_filters_apply_to_every_aggregate_but_not_window_options(self):
        self.book = Catalogue({"test": {"m": Rate(2, 4, .5, 3), "m-extra": Rate(2, 4, .5, 3)},
                               "other": {"m": Rate(2, 4, .5, 3)}}, "fixture", "test", "", "1")
        self.create_events([
            {"input_tokens": 10, "cache_read_tokens": 20, "aux_task": "title"},
            {"input_tokens": 30, "cache_read_tokens": 40, "aux_task": "title", "model": "m-extra"},
            {"input_tokens": 50, "cache_read_tokens": 60, "aux_task": "title", "provider": "other"},
            {"input_tokens": 70, "cache_read_tokens": 80, "aux_task": "title", "platform": "telegram"},
            {"input_tokens": 90, "cache_read_tokens": 100, "aux_task": "review"},
            {"model": "outside", "ts": NOW + 1},
        ])
        unfiltered = self.report(days=1)
        combined = {"model": "m", "provider": "test", "surface": "desktop", "task": "title"}
        for filters, expected_calls in [({k: v}, 4) for k, v in combined.items()] + [(combined, 1)]:
            with self.subTest(filters=filters):
                report = self.report(days=1, **filters)
                self.assertEqual(report["totals"]["calls"], expected_calls)
                self.assertEqual(report["economics"]["covered_calls"], expected_calls)
                self.assertEqual(report["options"], unfiltered["options"])
                self.assertEqual(report["recording"], unfiltered["recording"])
                for grouping in [report["by_model"], report["by_route"], report["trend"]["buckets"]]:
                    self.assertEqual(sum(g["calls"] for g in grouping), expected_calls)
                    self.assertEqual(sum(g["tokens"] for g in grouping), report["totals"]["tokens"])
                    self.assertEqual(sum(g["economics"]["covered_tokens"] for g in grouping),
                                     report["economics"]["covered_tokens"])
        selected = self.report(days=1, **combined)
        self.assertEqual({k: v for k, v in selected["filters"].items() if k in combined}, combined)
        self.assertIsNone(selected["filters"]["parent"])
        self.assertIsNone(selected["filters"]["scope"])
        self.assertEqual(selected["totals"]["tokens"], 30)
        self.assertEqual(selected["by_model"][0]["model"], "m")
        for filters in [{"model": "M"}, {"provider": "TEST"}, {"task": "tit"},
                        {"surface": "desktop' OR 1=1 --"}, {"model": ""}]:
            with self.subTest(no_match=filters):
                report = self.report(days=1, **filters)
                self.assertEqual(report["totals"]["calls"], 0)
                self.assertEqual(report["economics"]["covered_calls"], 0)
                self.assertEqual(report["by_model"], [])
                self.assertEqual(report["by_route"], [])
                self.assertTrue(all(b["calls"] == 0 for b in report["trend"]["buckets"]))

    def test_daily_buckets_follow_real_local_midnights_across_dst(self):
        zone = ZoneInfo("Europe/London")
        now = datetime(2026, 10, 26, 12, tzinfo=zone).timestamp()
        starts = [datetime(2026, 10, day, tzinfo=zone).timestamp() for day in (24, 25, 26)]
        self.create_events([
            {"ts": starts[0] - .001, "input_tokens": 10000},
            {"ts": starts[0], "input_tokens": 1},
            {"ts": starts[1] - .001, "input_tokens": 2},
            {"ts": starts[1], "input_tokens": 4},
            {"ts": starts[2] - .001, "input_tokens": 8},
            {"ts": starts[2], "input_tokens": 16},
            {"ts": now, "input_tokens": 10000},
        ])
        with local_zone("Europe/London"):
            report = self.report(days=3, now=now)
        self.assertEqual(report["window"]["since"], datetime.fromtimestamp(starts[0], timezone.utc).isoformat())
        self.assertEqual(report["trend"]["granularity"], "day")
        buckets = report["trend"]["buckets"]
        self.assertEqual([datetime.fromisoformat(b["ts"]).timestamp() for b in buckets], starts)
        self.assertEqual([b["tokens"] for b in buckets], [3, 12, 16])
        self.assertEqual(report["totals"]["tokens"], 31)
        self.assertEqual(report["totals"]["calls"], 5)

    def test_hourly_utc_timestamps_are_unambiguous_at_dst_folds_and_gaps(self):
        zone = ZoneInfo("Europe/London")
        for month, day in ((10, 25), (3, 29)):
            with self.subTest(month=month):
                now = datetime(2026, month, day, 12, tzinfo=timezone.utc).timestamp()
                since = datetime(2026, month, day, tzinfo=zone).timestamp()
                with local_zone("Europe/London"):
                    report = self.report(days=1, now=now)
                timestamps = [datetime.fromisoformat(b["ts"]).timestamp() for b in report["trend"]["buckets"]]
                self.assertEqual(timestamps, list(range(int(since), int(now), 3600)))
                self.assertTrue(all(datetime.fromisoformat(b["ts"]).utcoffset() == timedelta(0)
                                    for b in report["trend"]["buckets"]))
                self.assertEqual(len(timestamps), len(set(timestamps)))

    def test_half_open_hour_boundaries_zero_fill_and_empty_midnight_window(self):
        with local_zone("UTC"):
            midnight = datetime(2026, 10, 29, tzinfo=timezone.utc).timestamp()
            self.create_events([
                {"ts": midnight - .001, "input_tokens": 10000},
                {"ts": midnight, "input_tokens": 1},
                {"ts": midnight + 3600 - .001, "input_tokens": 2},
                {"ts": midnight + 3600, "input_tokens": 4},
                {"ts": NOW - .001, "input_tokens": 8},
                {"ts": NOW, "input_tokens": 10000},
            ])
            report = self.report(days=1)
            buckets = report["trend"]["buckets"]
            self.assertEqual(len(buckets), 12)
            self.assertEqual([b["tokens"] for b in buckets], [3, 4] + [0] * 9 + [8])
            self.assertEqual(report["totals"]["calls"], 4)
            empty = self.report(days=1, now=midnight)
            self.assertEqual(empty["totals"]["calls"], 0)
            self.assertEqual(empty["trend"]["buckets"], [])
            daily = self.report(days=7)
            self.assertEqual(len(daily["trend"]["buckets"]), 7)
            self.assertEqual(daily["trend"]["granularity"], "day")

    def test_existing_databases_are_opened_read_only_without_file_or_schema_changes(self):
        from unittest.mock import patch
        self.create_events([{"input_tokens": 10, "cache_read_tokens": 20}])
        with closing(sqlite3.connect(self.state)) as conn, conn:
            conn.execute("CREATE TABLE untouched (value TEXT)")
            conn.execute("CREATE TABLE session_model_usage (billing_provider TEXT, model TEXT, "
                         "cost_status TEXT, actual_cost_usd REAL, estimated_cost_usd REAL, last_seen REAL)")
        original_connect = sqlite3.connect
        opened = []
        def readonly_connect(target, *args, **kwargs):
            self.assertIsInstance(target, str)
            self.assertIn("mode=ro", target)
            self.assertTrue(kwargs.get("uri"))
            opened.append(target)
            return original_connect(target, *args, **kwargs)
        before = {p.name: (p.read_bytes(), p.stat().st_mtime_ns) for p in Path(self.scratch.name).iterdir()}
        with patch("sqlite3.connect", side_effect=readonly_connect):
            report = self.report(days=1)
        after = {p.name: (p.read_bytes(), p.stat().st_mtime_ns) for p in Path(self.scratch.name).iterdir()}
        self.assertEqual(report["totals"]["calls"], 1)
        # One call store plus two independent read-only state.db readers
        # (billing classification and the delegation graph).
        self.assertEqual(len(opened), 3)
        self.assertEqual(after, before)

    def test_response_size_depends_on_groups_and_buckets_not_raw_call_count(self):
        import json
        self.create_events([{"input_tokens": 10, "cache_read_tokens": 20}])
        small = json.dumps(self.report(days=30))
        with closing(sqlite3.connect(self.events)) as conn, conn:
            conn.executemany(
                "INSERT INTO calls (event_id,ts,model,provider,platform,outcome,input_tokens,"
                "cache_read_tokens,session_id,recorded_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
                [(f"private-event-{i}", NOW - 1, "m", "test", "desktop", "ok", 10, 20,
                  f"private-session-{i}", NOW) for i in range(5000)],
            )
        report = self.report(days=30)
        large = json.dumps(report)
        self.assertEqual(report["totals"]["calls"], 5001)
        self.assertLess(len(large) - len(small), 2000)
        self.assertNotIn("private-event", large)
        self.assertNotIn("private-session", large)
        self.assertNotIn("event_id", large)
        self.assertEqual(len(report["by_model"]), 1)
        self.assertEqual(len(report["trend"]["buckets"]), 30)


if __name__ == "__main__":
    unittest.main()
