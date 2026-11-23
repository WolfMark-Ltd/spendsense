"""Usage-store lifecycle: erasure, time-based retention and file permissions.

WP36/F122/F123. The captured ledger can be erased in-product with an exact
confirmation; retention is enforced by time (not only by insert count); and
the store files stay owner-only on POSIX.
"""
from __future__ import annotations

import os
import sqlite3
import stat
import tempfile
import time
import unittest
from pathlib import Path

from wolfmark_ledger import store


def _record(event_id: str, ts: float, tokens: int = 100) -> dict:
    return {
        "event_id": event_id, "ts": ts, "started_at": ts - 1, "ended_at": ts,
        "session_id": "s1", "task_id": "t1", "turn_id": "turn1",
        "platform": "desktop", "model": "m", "provider": "p",
        "api_mode": "chat_completions", "aux_task": "", "streaming": 0,
        "outcome": "ok", "api_call_count": 1, "input_tokens": tokens,
        "output_tokens": 0, "cache_read_tokens": 0, "cache_write_tokens": 0,
        "reasoning_tokens": 0, "prompt_tokens": tokens, "total_tokens": tokens,
        "error_type": "", "status_code": None, "recorded_at": time.time(),
    }


class StoreLifecycleCase(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.db = self.dir / "usage.db"
        self.addCleanup(self.tmp.cleanup)
        self.addCleanup(self._reset_writer)

    def _reset_writer(self) -> None:
        try:
            if store._WRITER is not None:
                store._WRITER.close()
        except Exception:
            pass
        store._WRITER = None
        store._WRITER_PATH = None
        store._INSERTS_SINCE_PRUNE = 0

    def _calls(self) -> int:
        conn = sqlite3.connect(self.db)
        try:
            return int(conn.execute("SELECT COUNT(*) FROM calls").fetchone()[0])
        finally:
            conn.close()


class EraseTests(StoreLifecycleCase):
    def test_erase_removes_db_sidecars_and_baseline(self) -> None:
        now = time.time()
        store.record(_record("e1", now), path=self.db)
        store.record(_record("e2", now), path=self.db)
        self.assertTrue(self.db.exists())
        result = store.erase_ledger(path=self.db)
        self.assertEqual(result["calls_deleted"], 2)
        self.assertIn("usage.db", result["removed"])
        self.assertFalse(self.db.exists())
        leftovers = [p.name for p in self.dir.iterdir()
                      if p.name.startswith("usage.db")]
        self.assertEqual(leftovers, [], "no WAL/SHM/journal residue may survive")

    def test_erase_is_idempotent_on_a_missing_store(self) -> None:
        result = store.erase_ledger(path=self.db)
        self.assertEqual(result, {"calls_deleted": 0, "removed": []})

    def test_store_works_again_after_erasure(self) -> None:
        now = time.time()
        state = self.dir / "state.db"
        conn = sqlite3.connect(state)
        conn.execute("CREATE TABLE session_model_usage (input_tokens INTEGER, output_tokens INTEGER,"
                     " cache_read_tokens INTEGER, cache_write_tokens INTEGER, task TEXT)")
        conn.execute("INSERT INTO session_model_usage VALUES (10, 5, 0, 0, '')")
        conn.commit()
        conn.close()
        store.record(_record("e1", now), path=self.db)
        store.erase_ledger(path=self.db)
        store.record(_record("e2", now), path=self.db, state_db_path=state)
        self.assertEqual(self._calls(), 1)
        conn = store.connect_reader(self.db)
        self.assertIsNotNone(conn)
        assert conn is not None
        try:
            base = conn.execute("SELECT * FROM baseline WHERE id=1").fetchone()
        finally:
            conn.close()
        self.assertIsNotNone(base, "the baseline is recaptured after erasure")

    def test_erase_never_touches_neighbouring_files(self) -> None:
        now = time.time()
        store.record(_record("e1", now), path=self.db)
        keeper = self.dir / "memberships.json"
        keeper.write_text("{}")
        store.erase_ledger(path=self.db)
        self.assertTrue(keeper.exists())


class RetentionTests(StoreLifecycleCase):
    def test_one_new_call_prunes_rows_past_retention(self) -> None:
        # F122: no 500-insert wait. Rows that aged past retention while the
        # install was idle are pruned by the very next write.
        now = time.time()
        old = now - (store.RETENTION_DAYS + 10) * 86_400
        store.bootstrap(path=self.db)
        conn = sqlite3.connect(self.db)
        conn.execute(
            "INSERT INTO calls (event_id, ts, outcome, recorded_at) VALUES (?, ?, ?, ?)",
            ("old", old, "ok", old))
        conn.commit()
        conn.close()
        self.assertEqual(self._calls(), 1)
        store.record(_record("new", now), path=self.db)
        conn = sqlite3.connect(self.db)
        try:
            ids = [row[0] for row in conn.execute("SELECT event_id FROM calls").fetchall()]
        finally:
            conn.close()
        self.assertEqual(ids, ["new"])

    def test_fresh_rows_survive_a_new_insert(self) -> None:
        now = time.time()
        store.record(_record("recent", now - 3600), path=self.db)
        store.record(_record("new", now), path=self.db)
        self.assertEqual(self._calls(), 2)


@unittest.skipIf(os.name == "nt", "POSIX permission bits only")
class PermissionTests(StoreLifecycleCase):
    def test_store_files_and_dir_are_owner_only(self) -> None:
        store.record(_record("e1", time.time()), path=self.db)
        mode = stat.S_IMODE(os.stat(self.db).st_mode)
        self.assertEqual(oct(mode), "0o600", f"usage.db must be 0600, got {oct(mode)}")
        dir_mode = stat.S_IMODE(os.stat(self.dir).st_mode)
        self.assertEqual(oct(dir_mode), "0o700", f"store dir must be 0700, got {oct(dir_mode)}")

    def test_legacy_world_readable_store_is_healed(self) -> None:
        store.record(_record("e1", time.time()), path=self.db)
        os.chmod(self.db, 0o644)
        store.record(_record("e2", time.time()), path=self.db)
        mode = stat.S_IMODE(os.stat(self.db).st_mode)
        self.assertEqual(oct(mode), "0o600", f"a 0644 store must heal to 0600, got {oct(mode)}")


if __name__ == "__main__":
    unittest.main()
