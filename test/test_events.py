"""Timestamped collector, period accounting and reconciliation tests."""

from __future__ import annotations

import os
import sqlite3
import tempfile
import threading
import time
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

from wolfmark_ledger import store
from wolfmark_ledger.aggregate import build_ledger_report
from wolfmark_ledger import collector

NOW = datetime(2026, 10, 29, 12, 0).astimezone().timestamp()


def _record(event_id: str, ts: float, *, provider: str = "commandcode",
            model: str = "deepseek/deepseek-v4.1-flash", input_tokens: int = 0,
            output_tokens: int = 0, cache_read: int = 0, cache_write: int = 0,
            aux_task: str = "", platform: str = "desktop", outcome: str = "ok") -> dict:
    return {
        "event_id": event_id,
        "ts": ts,
        "started_at": ts - 1,
        "ended_at": ts,
        "session_id": "s1",
        "task_id": "t1",
        "turn_id": "turn1",
        "platform": platform,
        "model": model,
        "provider": provider,
        "api_mode": "chat_completions",
        "aux_task": aux_task,
        "streaming": 0,
        "outcome": outcome,
        "api_call_count": 1,
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "cache_read_tokens": cache_read,
        "cache_write_tokens": cache_write,
        "reasoning_tokens": 0,
        "prompt_tokens": input_tokens + cache_read + cache_write,
        "total_tokens": input_tokens + output_tokens + cache_read + cache_write,
        "error_type": "",
        "status_code": None,
        "recorded_at": time.time(),
    }


class EventLedgerCase(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.state_db = self.dir / "state.db"
        self.event_db = self.dir / "usage.db"
        conn = sqlite3.connect(self.state_db)
        conn.executescript(
            """
            CREATE TABLE sessions (
                id TEXT PRIMARY KEY, source TEXT, title TEXT,
                started_at REAL, profile_name TEXT
            );
            CREATE TABLE session_model_usage (
                session_id TEXT NOT NULL, model TEXT NOT NULL,
                billing_provider TEXT NOT NULL DEFAULT '',
                billing_base_url TEXT NOT NULL DEFAULT '',
                billing_mode TEXT NOT NULL DEFAULT '',
                task TEXT NOT NULL DEFAULT '',
                api_call_count INTEGER NOT NULL DEFAULT 0,
                input_tokens INTEGER NOT NULL DEFAULT 0,
                output_tokens INTEGER NOT NULL DEFAULT 0,
                cache_read_tokens INTEGER NOT NULL DEFAULT 0,
                cache_write_tokens INTEGER NOT NULL DEFAULT 0,
                reasoning_tokens INTEGER NOT NULL DEFAULT 0,
                estimated_cost_usd REAL NOT NULL DEFAULT 0,
                actual_cost_usd REAL NOT NULL DEFAULT 0,
                cost_status TEXT, cost_source TEXT,
                first_seen REAL, last_seen REAL,
                PRIMARY KEY (session_id, model, billing_provider,
                             billing_base_url, billing_mode, task)
            );
            """
        )
        conn.execute("INSERT INTO sessions VALUES ('s1','desktop','main',?, 'default')",
                     (NOW - 20 * 86400,))
        conn.execute("INSERT INTO sessions VALUES ('s2','desktop','codex',?, 'default')",
                     (NOW - 2 * 86400,))
        conn.execute(
            "INSERT INTO session_model_usage VALUES "
            "('s1','deepseek/deepseek-v4.1-flash','commandcode','','chat_completions',"
            "'',10,1000000,0,0,0,0,0,0,'unknown','none',?,?)",
            (NOW - 20 * 86400, NOW - 10 * 86400),
        )
        conn.execute(
            "INSERT INTO session_model_usage VALUES "
            "('s2','gpt-6.1-sol','openai-codex','','codex_responses',"
            "'',1,0,0,0,0,0,0,0,'included','none',?,?)",
            (NOW - 2 * 86400, NOW - 86400),
        )
        conn.commit()
        conn.close()
        # Baseline is captured at install time in production; tests mirror that
        # so reconciliation compares events recorded after the baseline.
        store.bootstrap(self.state_db, self.event_db)

    def tearDown(self) -> None:
        store._WRITER = None
        store._WRITER_PATH = None
        self.tmp.cleanup()

    def put(self, record: dict) -> None:
        store.record(record, path=self.event_db, state_db_path=self.state_db)

    def report(self, days: int = 30):
        return build_ledger_report(days=days, now=NOW, state_db_path=self.state_db,
                                   event_db_path=self.event_db)

    def bump_state(self, delta: int) -> None:
        conn = sqlite3.connect(self.state_db)
        conn.execute(
            "UPDATE session_model_usage SET input_tokens = input_tokens + ? "
            "WHERE session_id='s1' AND billing_provider='commandcode'",
            (delta,),
        )
        conn.commit()
        conn.close()


class RollingWindowTests(EventLedgerCase):
    def test_period_prices_each_call_at_its_window_time(self):
        from wolfmark_ledger.aggregate import build_event_period
        from wolfmark_ledger.pricing import Catalogue, Rate
        peak=(None, 540, 1020, 0.30, 1.20, 0.006, None)
        book=Catalogue({"cc":{"m":Rate(0.15,0.60,0.003)}}, "f", "t", "", "1",
                       official={("cc","m"):(Rate(0.15,0.60,0.003),"2026-10-29",(peak,))})
        at=datetime(2026,10,29,12,tzinfo=timezone.utc).timestamp()
        self.put(_record("peak",at,provider="cc",model="m",input_tokens=1000000))
        result=build_event_period(self.event_db, days=2, catalogue=book, now=at+3600)
        self.assertAlmostEqual(result["totals"]["list_usd"],0.30)

    def test_period_uses_only_events_inside_the_window(self):
        self.put(_record("old", NOW - 10 * 86400, input_tokens=1000))
        self.put(_record("week", NOW - 2 * 86400, input_tokens=2000))
        self.put(_record("today", NOW - 3600, input_tokens=3000))

        today = self.report(1)
        week = self.report(7)
        month = self.report(30)

        self.assertEqual(today["totals"]["tokens"], 3000)
        self.assertEqual(week["totals"]["tokens"], 5000)
        self.assertEqual(month["totals"]["tokens"], 6000)
        # The cumulative baseline is separate and never added to the period.
        self.assertEqual(today["baseline"]["totals"]["tokens"], 1_000_000)
        self.assertNotEqual(today["totals"]["tokens"], today["baseline"]["totals"]["tokens"])

    def test_auxiliary_task_is_part_of_the_period(self):
        self.put(_record("aux", NOW - 1800, aux_task="compression", input_tokens=500))
        report = self.report(1)
        tasks = {row["name"]: row for row in report["by_task"]}
        self.assertEqual(tasks["compression"]["tokens"], 500)

    def test_window_starts_at_local_midnight(self):
        local = datetime.fromtimestamp(NOW).astimezone()
        midnight = local.replace(hour=0, minute=0, second=0, microsecond=0)
        self.put(_record("before", midnight.timestamp() - 1, input_tokens=100))
        self.put(_record("after", midnight.timestamp() + 1, input_tokens=200))
        report = build_ledger_report(days=1, now=NOW, state_db_path=self.state_db,
                                     event_db_path=self.event_db)
        self.assertEqual(report["totals"]["tokens"], 200)
        self.assertEqual(report["window"]["since"],
                         midnight.astimezone(timezone.utc).isoformat())


class DuplicateAndGapTests(EventLedgerCase):
    def _collector_call(self, payload: dict) -> None:
        with patch.object(store, "event_db_path", return_value=self.event_db), \
             patch.object(store, "default_db_path", return_value=self.state_db):
            collector._post_api_request(**payload)

    def test_duplicate_callback_records_once(self):
        payload = {
            "api_request_id": "req-1",
            "session_id": "s1",
            "platform": "desktop",
            "model": "deepseek/deepseek-v4.1-flash",
            "provider": "commandcode",
            "api_mode": "chat_completions",
            "api_call_count": 1,
            "started_at": NOW - 2,
            "ended_at": NOW - 1,
            "usage": {
                "input_tokens": 1200, "output_tokens": 100,
                "cache_read_tokens": 300, "cache_write_tokens": 0,
                "reasoning_tokens": 0, "prompt_tokens": 1500, "total_tokens": 1600,
            },
        }
        self._collector_call(payload)
        self._collector_call(payload)
        report = self.report(1)
        self.assertEqual(report["events"]["calls"], 1)
        self.assertEqual(report["totals"]["tokens"], 1600)

    def test_record_drops_rather_than_blocks_on_lock_contention(self):
        store._WRITE_LOCK.acquire()
        try:
            outcome: dict[str, bool] = {}

            def attempt() -> None:
                try:
                    self.put(_record("drop-1", NOW))
                except store.WriteContended:
                    outcome["dropped"] = True

            worker = threading.Thread(target=attempt)
            worker.start()
            worker.join(timeout=10)
            alive = worker.is_alive()
        finally:
            store._WRITE_LOCK.release()
        worker.join(timeout=10)
        self.assertFalse(alive, "record() blocked on a contended lock")
        self.assertTrue(outcome.get("dropped"), "contention must raise WriteContended")

    def test_streaming_call_is_recorded_with_usage(self):
        self._collector_call({
            "api_request_id": "req-stream", "session_id": "s1", "platform": "desktop",
            "model": "deepseek/deepseek-v4.1-flash", "provider": "commandcode",
            "streaming": True, "first_chunk_at": NOW - 1.5,
            "started_at": NOW - 2, "ended_at": NOW - 1,
            "usage": {
                "input_tokens": 800, "output_tokens": 40,
                "cache_read_tokens": 0, "cache_write_tokens": 0,
                "reasoning_tokens": 0, "prompt_tokens": 800, "total_tokens": 840,
            },
        })
        report = self.report(1)
        self.assertEqual(report["events"]["streaming"], 1)
        self.assertEqual(report["events"]["calls"], 1)
        self.assertEqual(report["totals"]["tokens"], 840)

    def test_retry_error_then_success_upgrades_one_logical_call(self):
        with patch.object(store, "event_db_path", return_value=self.event_db), \
             patch.object(store, "default_db_path", return_value=self.state_db):
            collector._api_request_error(
                api_request_id="req-retry", session_id="s1", platform="desktop",
                model="deepseek/deepseek-v4.1-flash", provider="commandcode",
                started_at=NOW - 3, ended_at=NOW - 2, error_type="RateLimitError",
                status_code=429, retry_count=0, error={"type": "RateLimitError"},
            )
        self._collector_call({
            "api_request_id": "req-retry", "session_id": "s1", "platform": "desktop",
            "model": "deepseek/deepseek-v4.1-flash", "provider": "commandcode",
            "started_at": NOW - 2, "ended_at": NOW - 1,
            "usage": {
                "input_tokens": 900, "output_tokens": 100,
                "cache_read_tokens": 0, "cache_write_tokens": 0,
                "reasoning_tokens": 0, "prompt_tokens": 900, "total_tokens": 1000,
            },
        })
        report = self.report(1)
        self.assertEqual(report["events"]["calls"], 1)
        self.assertEqual(report["events"]["failures"], 0)
        self.assertEqual(report["totals"]["tokens"], 1000)

    def test_fallback_success_replaces_the_failed_route(self):
        with patch.object(store, "event_db_path", return_value=self.event_db), \
             patch.object(store, "default_db_path", return_value=self.state_db):
            collector._api_request_error(
                api_request_id="req-fallback", session_id="s1", platform="desktop",
                model="primary/model", provider="primary-route",
                started_at=NOW - 3, ended_at=NOW - 2, error_type="ConnectionError",
                status_code=502, error={"type": "ConnectionError"},
            )
        self._collector_call({
            "api_request_id": "req-fallback", "session_id": "s1", "platform": "desktop",
            "model": "deepseek/deepseek-v4.1-flash", "provider": "commandcode",
            "started_at": NOW - 2, "ended_at": NOW - 1,
            "usage": {
                "input_tokens": 1_000_000, "output_tokens": 0,
                "cache_read_tokens": 0, "cache_write_tokens": 0,
                "reasoning_tokens": 0, "prompt_tokens": 1_000_000, "total_tokens": 1_000_000,
            },
        })
        report = self.report(1)
        self.assertEqual(report["events"]["calls"], 1)
        self.assertEqual([row["name"] for row in report["by_route"]], ["commandcode"])
        self.assertAlmostEqual(report["by_route"][0]["list_usd"], 0.15, places=6)

    def test_missing_usage_and_error_are_gaps_not_zero_cost(self):
        self._collector_call({
            "api_request_id": "req-missing", "session_id": "s1", "platform": "desktop",
            "model": "deepseek/deepseek-v4.1-flash", "provider": "commandcode",
            "started_at": NOW - 2, "ended_at": NOW - 1, "usage": None,
        })
        with patch.object(store, "event_db_path", return_value=self.event_db), \
             patch.object(store, "default_db_path", return_value=self.state_db):
            collector._api_request_error(
                api_request_id="req-error", session_id="s1", platform="desktop",
                model="deepseek/deepseek-v4.1-flash", provider="commandcode",
                started_at=NOW - 2, ended_at=NOW - 1, error_type="TimeoutError",
                status_code=504, error={"type": "TimeoutError", "message": "timed out"},
            )
        report = self.report(1)
        self.assertEqual(report["events"]["calls"], 2)
        self.assertEqual(report["events"]["missing_usage"], 1)
        self.assertEqual(report["events"]["failures"], 1)
        self.assertEqual(report["totals"]["tokens"], 0)
        self.assertIsNone(report["totals"]["billed_usd"])
        self.assertIsNone(report["totals"]["basis_usd"])


class PerCallTierTests(EventLedgerCase):
    def test_tier_is_applied_per_call_not_to_the_average(self):
        # 300k prompt is above Grok's 200k tier; 100k is below. Combined average
        # is exactly 200k, so an average heuristic would miss the tier entirely.
        self.put(_record("above", NOW - 7200, provider="xai-oauth", model="grok-4.7",
                         input_tokens=300_000))
        self.put(_record("below", NOW - 3600, provider="xai-oauth", model="grok-4.7",
                         input_tokens=100_000))
        report = self.report(1)
        route = next(r for r in report["by_route"] if r["name"] == "xai-oauth")
        self.assertAlmostEqual(route["list_usd"], 1.4, places=6)
        self.assertAlmostEqual(route["list_usd_upper"], 1.4, places=6)
        self.assertEqual(route["tier_possible_tokens"], 300_000)
        self.assertEqual(report["tier_mode"], "per_call")


class BillingClassificationTests(EventLedgerCase):
    def test_unknown_route_is_not_confirmed_zero(self):
        self.put(_record("codex", NOW - 3600, provider="openai-codex",
                         model="gpt-6.1-sol", input_tokens=1_000_000))
        self.put(_record("cc", NOW - 1800, provider="commandcode",
                         model="deepseek/deepseek-v4.1-flash", input_tokens=1_000_000))
        report = self.report(1)
        routes = {r["name"]: r for r in report["by_route"]}
        self.assertEqual(routes["openai-codex"]["billed_usd"], 0.0)
        self.assertEqual(routes["openai-codex"]["billing_mix"]["included"], 1)
        self.assertIsNone(routes["commandcode"]["billed_usd"])
        self.assertIsNone(routes["commandcode"]["billing_mix"].get("included"))
        self.assertIsNone(report["totals"]["billed_usd"])
        self.assertFalse(report["totals"]["billed_complete"])

    def test_basis_modes_do_not_invent_a_per_call_actual(self):
        self.put(_record("codex", NOW - 3600, provider="openai-codex",
                         model="gpt-6.1-sol", input_tokens=1_000_000))
        self.put(_record("cc", NOW - 1800, provider="commandcode",
                         model="deepseek/deepseek-v4.1-flash", input_tokens=1_000_000))
        billed = build_ledger_report(days=1, basis="billed", now=NOW,
                                     state_db_path=self.state_db, event_db_path=self.event_db)
        listed = build_ledger_report(days=1, basis="list", now=NOW,
                                     state_db_path=self.state_db, event_db_path=self.event_db)
        self.assertIsNone(billed["totals"]["basis_usd"])
        self.assertFalse(billed["totals"]["basis_complete"])
        self.assertGreater(listed["totals"]["basis_usd"], 0)
        self.assertEqual(listed["totals"]["basis_usd"], listed["totals"]["list_usd"])

    def test_all_included_is_confirmed_zero(self):
        self.put(_record("codex", NOW - 3600, provider="openai-codex",
                         model="gpt-6.1-sol", input_tokens=1_000_000))
        report = self.report(1)
        self.assertEqual(report["totals"]["billed_usd"], 0.0)
        self.assertTrue(report["totals"]["billed_complete"])


class CollectorPrivacyTests(unittest.TestCase):
    def test_error_messages_are_not_saved_as_error_types(self):
        from wolfmark_ledger.collector import _base_record
        record = _base_record("main", {"error_type": "sensitive user content or credential"})
        self.assertEqual(record["error_type"], "other")
        self.assertNotIn("sensitive", str(record))
        self.assertEqual(_base_record("main", {"error_type": "RateLimitError"})["error_type"], "RateLimitError")


class ReconciliationTests(EventLedgerCase):
    def test_reconciliation_uses_state_growth_and_survives_restart(self):
        self.put(_record("one", NOW - 3600, input_tokens=1000))
        self.bump_state(1000)

        report = self.report(1)
        self.assertEqual(report["reconciliation"]["delta_tokens"], 1000)
        self.assertEqual(report["reconciliation"]["captured_tokens"], 1000)
        self.assertEqual(report["reconciliation"]["gap_tokens"], 0)
        self.assertEqual(report["reconciliation"]["status"], "ok")

        # Reopen the cached connection: a process restart must not lose rows or
        # the baseline.
        if store._WRITER is not None:
            store._WRITER.close()
        store._WRITER = None
        store._WRITER_PATH = None
        again = self.report(1)
        self.assertEqual(again["totals"]["tokens"], 1000)
        self.assertEqual(again["reconciliation"]["captured_tokens"], 1000)

    def test_reconciliation_reports_a_gap(self):
        self.put(_record("one", NOW - 3600, input_tokens=1000))
        self.bump_state(1200)
        report = self.report(1)
        self.assertEqual(report["reconciliation"]["delta_tokens"], 1200)
        self.assertEqual(report["reconciliation"]["captured_tokens"], 1000)
        self.assertEqual(report["reconciliation"]["gap_tokens"], 200)
        self.assertEqual(report["reconciliation"]["status"], "gap")


class StorePathTests(EventLedgerCase):
    def test_event_db_path_follows_hermes_home(self):
        with patch.dict(os.environ, {"HERMES_HOME": str(self.dir)}):
            self.assertTrue(str(store.event_db_path()).startswith(str(self.dir)))


class BaselineTests(EventLedgerCase):
    def test_no_events_means_empty_period_and_full_baseline(self):
        report = self.report(30)
        self.assertEqual(report["totals"]["tokens"], 0)
        self.assertEqual(report["totals"]["status"], "empty")
        self.assertEqual(report["baseline"]["totals"]["tokens"], 1_000_000)
        self.assertEqual(report["baseline"]["kind"], "cumulative_historical_estimate")
        self.assertEqual(report["baseline"]["tier_mode"], "average_estimate")


if __name__ == "__main__":
    unittest.main()
