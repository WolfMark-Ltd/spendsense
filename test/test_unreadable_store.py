"""Unreadable usage-store handling.

A missing events database is a valid empty state (no calls recorded yet).
An existing but unreadable one must fail clearly via LedgerUnavailable and
never surface as zero usage. Failed reads must not modify the file.
"""

from __future__ import annotations

import sqlite3
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from wolfmark_ledger import store
from wolfmark_ledger.db import LedgerUnavailable

NOW = time.time()


def _healthy_db(path: Path) -> None:
    store.bootstrap(None, path)
    store.record({"event_id": "e1", "ts": NOW - 100, "model": "m",
                  "provider": "p", "total_tokens": 10}, path)


def _partial_schema_db(path: Path) -> None:
    """Both tables present, but calls lacks the reader columns, with one row.

    Without column validation this passes the table check and the report
    builders treat the missing token columns as zero: misleading data from
    a store that is actually incomplete.
    """
    conn = sqlite3.connect(path)
    conn.execute("CREATE TABLE calls (event_id TEXT PRIMARY KEY, ts REAL)")
    conn.execute(
        "CREATE TABLE baseline (id INTEGER PRIMARY KEY CHECK (id = 1),"
        " captured_at REAL NOT NULL, total_tokens INTEGER NOT NULL,"
        " main_tokens INTEGER NOT NULL, aux_tokens INTEGER NOT NULL)"
    )
    conn.execute("INSERT INTO calls (event_id, ts) VALUES ('e1', ?)", (NOW - 100,))
    conn.commit()
    conn.close()


class ConnectReaderTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)

    def tearDown(self) -> None:
        if store._WRITER is not None:
            try:
                store._WRITER.close()
            except Exception:
                pass
        store._WRITER = None
        store._WRITER_PATH = None
        self.tmp.cleanup()

    def test_missing_database_is_valid_empty_state(self) -> None:
        missing = self.dir / "usage.db"
        self.assertIsNone(store.connect_reader(missing))
        self.assertEqual(store.recording_info(None)["calls"], 0)

    def test_healthy_database_reads(self) -> None:
        target = self.dir / "usage.db"
        _healthy_db(target)
        conn = store.connect_reader(target)
        self.assertIsNotNone(conn)
        try:
            rows = store.query_calls(conn, since=0.0, until=NOW + 1)
        finally:
            conn.close()
        self.assertEqual(len(rows), 1)

    def test_garbage_file_raises_ledger_unavailable(self) -> None:
        target = self.dir / "usage.db"
        target.write_bytes(b"\x00\x01not-a-sqlite-file" * 64)
        with self.assertRaises(LedgerUnavailable):
            store.connect_reader(target)

    def test_zero_byte_file_raises_ledger_unavailable(self) -> None:
        target = self.dir / "usage.db"
        target.write_bytes(b"")
        with self.assertRaises(LedgerUnavailable):
            store.connect_reader(target)

    def test_sqlite_without_calls_table_raises_ledger_unavailable(self) -> None:
        target = self.dir / "usage.db"
        conn = sqlite3.connect(target)
        conn.execute("CREATE TABLE other (id INTEGER PRIMARY KEY)")
        conn.commit()
        conn.close()
        with self.assertRaises(LedgerUnavailable):
            store.connect_reader(target)

    def test_partial_store_missing_baseline_raises_ledger_unavailable(self) -> None:
        target = self.dir / "usage.db"
        conn = sqlite3.connect(target)
        conn.execute("CREATE TABLE calls (event_id TEXT PRIMARY KEY, ts REAL)")
        conn.commit()
        conn.close()
        with self.assertRaises(LedgerUnavailable):
            store.connect_reader(target)

    def test_partial_schema_missing_calls_columns_raises(self) -> None:
        target = self.dir / "usage.db"
        _partial_schema_db(target)
        with self.assertRaises(LedgerUnavailable) as ctx:
            store.connect_reader(target)
        self.assertIn("calls table is missing required columns", str(ctx.exception))
        self.assertIn("total_tokens", str(ctx.exception))

    def test_partial_schema_missing_baseline_columns_raises(self) -> None:
        target = self.dir / "usage.db"
        store.bootstrap(None, target)
        if store._WRITER is not None:
            store._WRITER.close()
        store._WRITER = None
        store._WRITER_PATH = None
        sabotage = sqlite3.connect(target)
        sabotage.execute("ALTER TABLE baseline DROP COLUMN total_tokens")
        sabotage.commit()
        sabotage.close()
        with self.assertRaises(LedgerUnavailable) as ctx:
            store.connect_reader(target)
        self.assertIn("baseline table is missing required columns", str(ctx.exception))

    def test_column_check_leaves_file_untouched(self) -> None:
        target = self.dir / "usage.db"
        _partial_schema_db(target)
        before = target.read_bytes()
        with self.assertRaises(LedgerUnavailable):
            store.connect_reader(target)
        self.assertEqual(target.read_bytes(), before)
        self.assertEqual(sorted(p.name for p in self.dir.iterdir()), ["usage.db"])

    def test_extra_columns_are_tolerated(self) -> None:
        target = self.dir / "usage.db"
        _healthy_db(target)
        if store._WRITER is not None:
            store._WRITER.close()
        store._WRITER = None
        store._WRITER_PATH = None
        extra = sqlite3.connect(target)
        extra.execute("ALTER TABLE calls ADD COLUMN future_col TEXT")
        extra.commit()
        extra.close()
        conn = store.connect_reader(target)
        self.assertIsNotNone(conn)
        try:
            rows = store.query_calls(conn, since=0.0, until=NOW + 1)
        finally:
            conn.close()
        self.assertEqual(len(rows), 1)

    def test_inaccessible_parent_raises_ledger_unavailable(self) -> None:
        vault = self.dir / "vault"
        vault.mkdir()
        target = vault / "usage.db"
        target.write_bytes(b"\x00\x01not-a-sqlite-file" * 64)
        vault.chmod(0o000)
        try:
            with self.assertRaises(LedgerUnavailable):
                store.connect_reader(target)
        finally:
            vault.chmod(0o700)

    def test_failed_open_leaves_file_untouched(self) -> None:
        target = self.dir / "usage.db"
        payload = b"\x00\x01not-a-sqlite-file" * 64
        target.write_bytes(payload)
        with self.assertRaises(LedgerUnavailable):
            store.connect_reader(target)
        self.assertEqual(target.read_bytes(), payload)
        self.assertEqual(sorted(p.name for p in self.dir.iterdir()), ["usage.db"])

    def test_query_failure_raises_ledger_unavailable(self) -> None:
        target = self.dir / "usage.db"
        _healthy_db(target)
        conn = store.connect_reader(target)
        self.assertIsNotNone(conn)
        try:
            sabotage = sqlite3.connect(target)
            sabotage.execute("DROP TABLE calls")
            sabotage.commit()
            sabotage.close()
            with self.assertRaises(LedgerUnavailable):
                store.query_calls(conn, since=0.0, until=NOW + 1)
        finally:
            conn.close()


class BuilderTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.state_db = self.dir / "state.db"

    def tearDown(self) -> None:
        if store._WRITER is not None:
            try:
                store._WRITER.close()
            except Exception:
                pass
        store._WRITER = None
        store._WRITER_PATH = None
        self.tmp.cleanup()

    def _garbage(self) -> Path:
        target = self.dir / "usage.db"
        target.write_bytes(b"\x00\x01not-a-sqlite-file" * 64)
        return target

    def test_analytics_missing_store_reports_empty(self) -> None:
        from wolfmark_ledger.analytics import build_analytics_report
        report = build_analytics_report(event_db_path=self.dir / "usage.db",
                                        state_db_path=self.state_db, days=7, now=NOW)
        self.assertEqual(report["totals"]["calls"], 0)

    def test_analytics_unreadable_store_raises(self) -> None:
        from wolfmark_ledger.analytics import build_analytics_report
        with self.assertRaises(LedgerUnavailable):
            build_analytics_report(event_db_path=self._garbage(),
                                   state_db_path=self.state_db, days=7, now=NOW)

    def test_ledger_unreadable_store_raises(self) -> None:
        from wolfmark_ledger.aggregate import build_ledger_report
        with self.assertRaises(LedgerUnavailable):
            build_ledger_report(event_db_path=self._garbage(),
                                state_db_path=self.state_db, days=7, now=NOW)

    def test_economics_unreadable_store_raises(self) -> None:
        from wolfmark_ledger.economics import build_economics_report
        with self.assertRaises(LedgerUnavailable):
            build_economics_report(event_db_path=self._garbage(),
                                   state_db_path=self.state_db, days=7, now=NOW)

    def test_analytics_partial_schema_raises_not_zeros(self) -> None:
        from wolfmark_ledger.analytics import build_analytics_report
        target = self.dir / "usage.db"
        _partial_schema_db(target)
        with self.assertRaises(LedgerUnavailable):
            build_analytics_report(event_db_path=target,
                                   state_db_path=self.state_db, days=7, now=NOW)


try:
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
except Exception:  # pragma: no cover - depends on the test interpreter
    FastAPI = None  # type: ignore
    TestClient = None  # type: ignore
if FastAPI is not None:
    # Imported outside the optional-dependency guard so a broken dashboard
    # errors loudly instead of masking itself as a dependency skip.
    from dashboard import plugin_api


@unittest.skipUnless(FastAPI is not None and TestClient is not None,
                     "FastAPI/httpx not installed in this interpreter")
class UnreadableStoreApiTests(unittest.TestCase):
    def setUp(self) -> None:
        app = FastAPI()
        app.include_router(plugin_api.router, prefix="/api/plugins/spend-sense")
        self.client = TestClient(app)
        self.addCleanup(self.client.close)
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)

    def _garbage(self) -> Path:
        target = self.dir / "usage.db"
        target.write_bytes(b"\x00\x01not-a-sqlite-file" * 64)
        return target

    def _healthy(self) -> Path:
        target = self.dir / "usage.db"
        _healthy_db(target)
        if store._WRITER is not None:
            try:
                store._WRITER.close()
            except Exception:
                pass
        store._WRITER = None
        store._WRITER_PATH = None
        return target

    def test_health_missing_store_is_empty_not_broken(self) -> None:
        with patch.object(store, "event_db_path", return_value=self.dir / "usage.db"):
            response = self.client.get("/api/plugins/spend-sense/health")
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertFalse(body["event_db_present"])
        self.assertEqual(body["event_db_status"], "missing")

    def test_health_healthy_store_is_ready(self) -> None:
        target = self._healthy()
        with patch.object(store, "event_db_path", return_value=target):
            response = self.client.get("/api/plugins/spend-sense/health")
        body = response.json()
        self.assertTrue(body["event_db_present"])
        self.assertEqual(body["event_db_status"], "ready")

    def test_health_unreadable_store_is_reported(self) -> None:
        target = self._garbage()
        with patch.object(store, "event_db_path", return_value=target):
            response = self.client.get("/api/plugins/spend-sense/health")
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertTrue(body["event_db_present"])
        self.assertEqual(body["event_db_status"], "unreadable")

    def test_analytics_endpoint_unreadable_is_503(self) -> None:
        target = self._garbage()
        with patch.object(store, "event_db_path", return_value=target):
            response = self.client.get("/api/plugins/spend-sense/analytics", params={"days": 7})
        self.assertEqual(response.status_code, 503)

    def test_digest_endpoint_unreadable_is_503(self) -> None:
        target = self._garbage()
        with patch.object(store, "event_db_path", return_value=target):
            response = self.client.get("/api/plugins/spend-sense/reports/digest",
                                       params={"days": 7, "lang": "en"})
        self.assertEqual(response.status_code, 503)

    def test_weather_endpoint_unreadable_is_503(self) -> None:
        target = self._garbage()
        with patch.object(store, "event_db_path", return_value=target):
            response = self.client.get("/api/plugins/spend-sense/allowance/weather")
        self.assertEqual(response.status_code, 503)

    def test_billing_endpoint_unreadable_is_503_with_fixed_detail(self) -> None:
        target = self._garbage()
        with patch.object(store, "event_db_path", return_value=target):
            response = self.client.get("/api/plugins/spend-sense/billing/summary",
                                       params={"days": 7})
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json()["detail"], "billing call store unavailable")

    def test_health_inaccessible_store_never_raises(self) -> None:
        vault = self.dir / "vault"
        vault.mkdir()
        target = vault / "usage.db"
        target.write_bytes(b"\x00\x01not-a-sqlite-file" * 64)
        vault.chmod(0o000)
        try:
            with patch.object(store, "event_db_path", return_value=target):
                response = self.client.get("/api/plugins/spend-sense/health")
        finally:
            vault.chmod(0o700)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["event_db_status"], "unreadable")

    def test_health_partial_store_is_unreadable_not_ready(self) -> None:
        target = self.dir / "usage.db"
        conn = sqlite3.connect(target)
        conn.execute("CREATE TABLE calls (event_id TEXT PRIMARY KEY, ts REAL)")
        conn.commit()
        conn.close()
        with patch.object(store, "event_db_path", return_value=target):
            response = self.client.get("/api/plugins/spend-sense/health")
        body = response.json()
        self.assertTrue(body["event_db_present"])
        self.assertEqual(body["event_db_status"], "unreadable")

    def test_health_partial_schema_is_unreadable_not_ready(self) -> None:
        target = self.dir / "usage.db"
        _partial_schema_db(target)
        with patch.object(store, "event_db_path", return_value=target):
            response = self.client.get("/api/plugins/spend-sense/health")
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertTrue(body["event_db_present"])
        self.assertEqual(body["event_db_status"], "unreadable")

    def test_billing_endpoint_partial_schema_is_503_with_fixed_detail(self) -> None:
        target = self.dir / "usage.db"
        _partial_schema_db(target)
        with patch.object(store, "event_db_path", return_value=target):
            response = self.client.get("/api/plugins/spend-sense/billing/summary",
                                       params={"days": 7})
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json()["detail"], "billing call store unavailable")


if __name__ == "__main__":
    unittest.main()
