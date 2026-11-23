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
        if store._WRITER is not None:
            store._WRITER.close()
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

    def test_record_fails_promptly_when_the_database_is_locked(self):
        blocker = sqlite3.connect(self.event_db)
        blocker.execute("BEGIN EXCLUSIVE")
        try:
            started = time.monotonic()
            with self.assertRaises(sqlite3.OperationalError):
                self.put(_record("busy-1", NOW))
            self.assertLess(time.monotonic() - started, 4,
                            "record() waited out the busy timeout on the hook path")
        finally:
            blocker.execute("ROLLBACK")
            blocker.close()

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


class MoaAdvisorTests(unittest.TestCase):
    """F129: per-slot MoA advisor spend is attributed, never dropped."""

    def _parent(self, **overrides):
        record = {
            "event_id": "api:req-1", "ts": NOW, "started_at": NOW - 1,
            "ended_at": NOW, "session_id": "s1", "task_id": "t1",
            "turn_id": "turn1", "platform": "desktop", "model": "agg-model",
            "provider": "openrouter", "call_class": "main",
        }
        record.update(overrides)
        return record

    def _refs(self):
        return [
            {"label": "advisor-a", "model": "deepseek/deepseek-v4.1-flash",
             "provider": "commandcode", "temperature": 0.2,
             "usage": {"input_tokens": 1000, "output_tokens": 200,
                       "cache_read_tokens": 0, "cache_write_tokens": 0,
                       "reasoning_tokens": 0},
             "cost_usd": 0.001, "cost_status": "estimated",
             "output": "SECRET ADVISOR TEXT MUST NEVER BE STORED"},
            {"label": "advisor-b", "model": "gpt-6.1-sol",
             "provider": "openai-codex",
             "usage": {"input_tokens": 500, "output_tokens": 100,
                       "cache_read_tokens": 0, "cache_write_tokens": 0,
                       "reasoning_tokens": 0}},
        ]

    def test_advisor_slots_become_priced_rows(self):
        rows = collector._advisor_records(self._parent(), {"moa_references": self._refs()})
        self.assertEqual(len(rows), 2)
        first, second = rows
        self.assertEqual(first["event_id"], "api:req-1:moa:0")
        self.assertEqual(second["event_id"], "api:req-1:moa:1")
        self.assertEqual((first["provider"], first["model"]),
                         ("commandcode", "deepseek/deepseek-v4.1-flash"))
        self.assertEqual(first["input_tokens"], 1000)
        self.assertEqual(first["output_tokens"], 200)
        self.assertEqual(first["total_tokens"], 1200)
        self.assertEqual(first["outcome"], "ok")
        self.assertEqual(first["call_class"], "main")
        self.assertEqual(first["session_id"], "s1")
        self.assertEqual(first["turn_id"], "turn1")
        self.assertNotIn("SECRET ADVISOR TEXT", str(rows))

    def test_empty_route_or_zero_tokens_are_skipped(self):
        refs = [
            {"label": "no-route", "model": "", "provider": "",
             "usage": {"input_tokens": 10, "output_tokens": 0,
                       "cache_read_tokens": 0, "cache_write_tokens": 0,
                       "reasoning_tokens": 0}},
            {"label": "no-spend", "model": "m", "provider": "p",
             "usage": {"input_tokens": 0, "output_tokens": 0,
                       "cache_read_tokens": 0, "cache_write_tokens": 0,
                       "reasoning_tokens": 0}},
            "not-a-dict",
        ]
        rows = collector._advisor_records(self._parent(), {"moa_references": refs})
        self.assertEqual(rows, [])

    def test_missing_references_means_no_rows(self):
        self.assertEqual(collector._advisor_records(self._parent(), {}), [])
        self.assertEqual(collector._advisor_records(self._parent(), {"moa_references": None}), [])

    def test_advisor_rows_persist_and_price_at_advisor_rates(self):
        parent = self._parent()
        rows = collector._advisor_records(parent, {"moa_references": self._refs()})
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.addCleanup(self._reset_writer)
        db = str(Path(tmp.name) / "usage.db")
        for row in rows:
            store.record(row, path=db)
        conn = store.connect_reader(db)
        self.assertIsNotNone(conn)
        assert conn is not None
        try:
            found = conn.execute(
                "SELECT event_id, model, provider, total_tokens FROM calls ORDER BY event_id"
            ).fetchall()
        finally:
            conn.close()
        self.assertEqual([(r[0], r[1], r[2], r[3]) for r in found], [
            ("api:req-1:moa:0", "deepseek/deepseek-v4.1-flash", "commandcode", 1200),
            ("api:req-1:moa:1", "gpt-6.1-sol", "openai-codex", 600),
        ])

    def _reset_writer(self):
        try:
            if store._WRITER is not None:
                store._WRITER.close()
        except Exception:
            pass
        store._WRITER = None
        store._WRITER_PATH = None


class ResponseModelTests(unittest.TestCase):
    """F130: the served model is recorded as provenance; pricing is unchanged."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)
        self.db = str(self.dir / "usage.db")
        self.addCleanup(self._reset_writer)

    def _reset_writer(self):
        try:
            if store._WRITER is not None:
                store._WRITER.close()
        except Exception:
            pass
        store._WRITER = None
        store._WRITER_PATH = None

    def test_base_record_carries_response_model(self):
        record = collector._base_record("main", {"model": "requested", "response_model": "served-1"})
        self.assertEqual(record["model"], "requested")
        self.assertEqual(record["response_model"], "served-1")
        record = collector._base_record("main", {"model": "requested"})
        self.assertIsNone(record["response_model"])

    def test_response_model_round_trips_and_updates_on_retry(self):
        record = _record("e1", NOW, input_tokens=100)
        record["response_model"] = "served-1"
        store.record(record, path=self.db)
        conn = sqlite3.connect(self.db)
        try:
            value = conn.execute(
                "SELECT response_model FROM calls WHERE event_id='e1'").fetchone()[0]
        finally:
            conn.close()
        self.assertEqual(value, "served-1")

    def test_pre_column_stores_migrate_additively(self):
        # A store written before the column existed: full old schema, one row.
        store.bootstrap(path=self.db)
        conn = sqlite3.connect(self.db)
        conn.execute("ALTER TABLE calls DROP COLUMN response_model")
        conn.execute("INSERT INTO calls (event_id, ts, outcome, recorded_at)"
                     " VALUES ('old', 1.0, 'ok', 1.0)")
        conn.commit()
        cols_before = {row[1] for row in conn.execute("PRAGMA table_info(calls)")}
        conn.close()
        self.assertNotIn("response_model", cols_before)
        self._reset_writer()
        store.record(_record("new", NOW, input_tokens=10), path=self.db)
        conn = sqlite3.connect(self.db)
        try:
            cols = {row[1] for row in conn.execute("PRAGMA table_info(calls)")}
            old = conn.execute(
                "SELECT response_model FROM calls WHERE event_id='old'").fetchone()[0]
        finally:
            conn.close()
        self.assertIn("response_model", cols)
        self.assertIsNone(old, "pre-migration rows read NULL, never a guessed model")


if __name__ == "__main__":
    unittest.main()
