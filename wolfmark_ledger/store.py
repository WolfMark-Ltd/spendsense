"""Plugin-owned per-call usage store.

The collector writes one row per provider attempt into
``<hermes home>/plugin-data/wolfmark-cost-ledger/usage.db`` using Hermes'
supported ``plugin_db`` helper (WAL, profile-scoped, survives plugin updates).
The dashboard opens the same file read-only.

Only accounting metadata is stored: identifiers, route/model, token buckets,
outcome and timestamps. No prompts, responses, credentials or request bodies.
"""

from __future__ import annotations

import os
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any, Optional

try:
    from .db import default_db_path
except ImportError:  # isolated capability probe loads store as top-level
    from db import default_db_path  # type: ignore

PLUGIN_NAME = "wolfmark-cost-ledger"
DB_FILENAME = "usage.db"
RETENTION_DAYS = 180
PRUNE_EVERY = 500

_SCHEMA = """
CREATE TABLE IF NOT EXISTS calls (
    event_id            TEXT PRIMARY KEY,
    ts                  REAL NOT NULL,
    started_at          REAL,
    ended_at            REAL,
    session_id          TEXT NOT NULL DEFAULT '',
    task_id             TEXT NOT NULL DEFAULT '',
    turn_id             TEXT NOT NULL DEFAULT '',
    platform            TEXT NOT NULL DEFAULT '',
    model               TEXT NOT NULL DEFAULT '',
    provider            TEXT NOT NULL DEFAULT '',
    api_mode            TEXT NOT NULL DEFAULT '',
    aux_task            TEXT NOT NULL DEFAULT '',
    streaming           INTEGER NOT NULL DEFAULT 0,
    outcome             TEXT NOT NULL,
    api_call_count      INTEGER NOT NULL DEFAULT 0,
    input_tokens        INTEGER NOT NULL DEFAULT 0,
    output_tokens       INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens   INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens  INTEGER NOT NULL DEFAULT 0,
    reasoning_tokens    INTEGER NOT NULL DEFAULT 0,
    prompt_tokens       INTEGER NOT NULL DEFAULT 0,
    total_tokens        INTEGER NOT NULL DEFAULT 0,
    error_type          TEXT NOT NULL DEFAULT '',
    status_code         INTEGER,
    recorded_at         REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS calls_ts ON calls(ts);
CREATE INDEX IF NOT EXISTS calls_session ON calls(session_id, ts);

CREATE TABLE IF NOT EXISTS baseline (
    id            INTEGER PRIMARY KEY CHECK (id = 1),
    captured_at   REAL NOT NULL,
    total_tokens  INTEGER NOT NULL,
    main_tokens   INTEGER NOT NULL,
    aux_tokens    INTEGER NOT NULL
);
"""

_WRITE_LOCK = threading.Lock()
_WRITER: Optional[sqlite3.Connection] = None
_WRITER_PATH: Optional[str] = None
_INSERTS_SINCE_PRUNE = 0


def event_db_path() -> Path:
    """Profile-scoped plugin data path, following Hermes' storage convention."""
    try:
        from plugins.plugin_storage import plugin_data_dir

        return plugin_data_dir(PLUGIN_NAME) / DB_FILENAME
    except Exception:
        # Never fall back to a fixed ~/.hermes path: that would write the launch
        # profile's data into the wrong profile when HERMES_HOME is set.
        try:
            from hermes_constants import get_hermes_home

            base = Path(get_hermes_home())
        except Exception:
            base = Path(os.environ.get("HERMES_HOME") or Path.home() / ".hermes")
        return base / "plugin-data" / PLUGIN_NAME / DB_FILENAME


def _ensure_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(_SCHEMA)
    conn.commit()


def connect_writer(path: Optional[Path | str] = None) -> sqlite3.Connection:
    """Shared writer connection. Caller must hold ``_WRITE_LOCK`` for writes."""
    global _WRITER, _WRITER_PATH
    target = Path(path) if path else event_db_path()
    key = str(target)
    if _WRITER is not None and _WRITER_PATH == key:
        return _WRITER

    if _WRITER is not None:
        try:
            _WRITER.close()
        except Exception:
            pass
        _WRITER = None
        _WRITER_PATH = None

    conn: Optional[sqlite3.Connection] = None
    if path is None:
        try:
            from plugins.plugin_storage import plugin_db

            conn = plugin_db(PLUGIN_NAME, DB_FILENAME)
        except Exception:
            conn = None
    if conn is None:
        target.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(target, timeout=5.0, check_same_thread=False)
        conn.execute("PRAGMA journal_mode=WAL")
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout=5000")
    _ensure_schema(conn)
    _WRITER, _WRITER_PATH = conn, key
    return conn


def connect_reader(path: Optional[Path | str] = None) -> Optional[sqlite3.Connection]:
    """Read-only connection, or None when the collector has never run."""
    target = Path(path) if path else event_db_path()
    if not target.exists():
        return None
    try:
        conn = sqlite3.connect(f"file:{target}?mode=ro", uri=True, timeout=5)
    except sqlite3.Error:
        return None
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA query_only=ON")
    conn.execute("PRAGMA busy_timeout=5000")
    return conn


def capture_baseline(conn: sqlite3.Connection, state_db_path: Optional[Path | str] = None) -> Optional[dict[str, Any]]:
    """Record the cumulative state.db token total once, for later reconciliation."""
    row = conn.execute("SELECT * FROM baseline WHERE id=1").fetchone()
    if row is not None:
        return dict(row)

    state_path = Path(state_db_path) if state_db_path else default_db_path()
    if not state_path.exists():
        return None
    try:
        state = sqlite3.connect(f"file:{state_path}?mode=ro", uri=True, timeout=5)
        total, main, aux = state.execute(
            """
            SELECT COALESCE(SUM(input_tokens+output_tokens+cache_read_tokens+cache_write_tokens), 0),
                   COALESCE(SUM(CASE WHEN task='' THEN
                       input_tokens+output_tokens+cache_read_tokens+cache_write_tokens ELSE 0 END), 0),
                   COALESCE(SUM(CASE WHEN task!='' THEN
                       input_tokens+output_tokens+cache_read_tokens+cache_write_tokens ELSE 0 END), 0)
              FROM session_model_usage
            """
        ).fetchone()
        state.close()
    except sqlite3.Error:
        return None

    conn.execute(
        "INSERT OR IGNORE INTO baseline(id, captured_at, total_tokens, main_tokens, aux_tokens) "
        "VALUES (1, ?, ?, ?, ?)",
        (time.time(), int(total or 0), int(main or 0), int(aux or 0)),
    )
    conn.commit()
    row = conn.execute("SELECT * FROM baseline WHERE id=1").fetchone()
    return dict(row) if row else None


def bootstrap(state_db_path: Optional[Path | str] = None, path: Optional[Path | str] = None) -> None:
    """Create the schema and capture the baseline. Safe to call repeatedly."""
    with _WRITE_LOCK:
        conn = connect_writer(path)
        capture_baseline(conn, state_db_path)


def _prune_locked(conn: sqlite3.Connection, now: Optional[float] = None) -> int:
    cutoff = (now or time.time()) - RETENTION_DAYS * 86_400
    cur = conn.execute("DELETE FROM calls WHERE ts < ?", (cutoff,))
    conn.commit()
    return int(cur.rowcount or 0)


def prune(conn: sqlite3.Connection, *, now: Optional[float] = None) -> int:
    with _WRITE_LOCK:
        return _prune_locked(conn, now)


def record(record: dict[str, Any], path: Optional[Path | str] = None,
           state_db_path: Optional[Path | str] = None) -> bool:
    """Insert one call. Duplicate event ids are ignored; a later good row upgrades a gap."""
    global _INSERTS_SINCE_PRUNE
    with _WRITE_LOCK:
        conn = connect_writer(path)
        if conn.execute("SELECT 1 FROM baseline WHERE id=1").fetchone() is None:
            capture_baseline(conn, state_db_path)
        cur = conn.execute(
            """
            INSERT OR IGNORE INTO calls (
                event_id, ts, started_at, ended_at, session_id, task_id, turn_id,
                platform, model, provider, api_mode, aux_task, streaming, outcome,
                api_call_count, input_tokens, output_tokens, cache_read_tokens,
                cache_write_tokens, reasoning_tokens, prompt_tokens, total_tokens,
                error_type, status_code, recorded_at
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            """,
            (
                record["event_id"], record["ts"], record.get("started_at"),
                record.get("ended_at"), record.get("session_id", ""),
                record.get("task_id", ""), record.get("turn_id", ""),
                record.get("platform", ""), record.get("model", ""),
                record.get("provider", ""), record.get("api_mode", ""),
                record.get("aux_task", ""), int(bool(record.get("streaming"))),
                record.get("outcome", "ok"), int(record.get("api_call_count") or 0),
                int(record.get("input_tokens") or 0), int(record.get("output_tokens") or 0),
                int(record.get("cache_read_tokens") or 0), int(record.get("cache_write_tokens") or 0),
                int(record.get("reasoning_tokens") or 0), int(record.get("prompt_tokens") or 0),
                int(record.get("total_tokens") or 0), record.get("error_type", ""),
                record.get("status_code"), record.get("recorded_at", time.time()),
            ),
        )
        inserted = cur.rowcount > 0
        conn.commit()

        if not inserted and record.get("outcome") == "ok" and int(record.get("total_tokens") or 0) > 0:
            # A duplicate callback may carry the final usage after an earlier
            # missing-usage/error attempt with the same request id.
            conn.execute(
                """
                UPDATE calls SET
                    ts=?, started_at=?, ended_at=?, session_id=?, task_id=?, turn_id=?,
                    platform=?, model=?, provider=?, api_mode=?, aux_task=?, streaming=?,
                    outcome=?, api_call_count=?,
                    input_tokens=?, output_tokens=?, cache_read_tokens=?,
                    cache_write_tokens=?, reasoning_tokens=?, prompt_tokens=?,
                    total_tokens=?, error_type='', status_code=NULL, recorded_at=?
                 WHERE event_id=? AND outcome!='ok'
                """,
                (
                    record["ts"], record.get("started_at"), record.get("ended_at"),
                    record.get("session_id", ""), record.get("task_id", ""),
                    record.get("turn_id", ""), record.get("platform", ""),
                    record.get("model", ""), record.get("provider", ""),
                    record.get("api_mode", ""), record.get("aux_task", ""),
                    int(bool(record.get("streaming"))),
                    record.get("outcome", "ok"), int(record.get("api_call_count") or 0),
                    int(record.get("input_tokens") or 0), int(record.get("output_tokens") or 0),
                    int(record.get("cache_read_tokens") or 0), int(record.get("cache_write_tokens") or 0),
                    int(record.get("reasoning_tokens") or 0), int(record.get("prompt_tokens") or 0),
                    int(record.get("total_tokens") or 0), record.get("recorded_at", time.time()),
                    record["event_id"],
                ),
            )
            conn.commit()

        _INSERTS_SINCE_PRUNE += 1
        if _INSERTS_SINCE_PRUNE >= PRUNE_EVERY:
            _INSERTS_SINCE_PRUNE = 0
            _prune_locked(conn)
        return inserted


def query_calls(conn: sqlite3.Connection, *, since: float, until: float) -> list[dict[str, Any]]:
    rows = conn.execute(
        "SELECT * FROM calls WHERE ts >= ? AND ts < ? ORDER BY ts ASC",
        (since, until),
    ).fetchall()
    return [dict(row) for row in rows]


def recording_info(conn: Optional[sqlite3.Connection]) -> dict[str, Any]:
    if conn is None:
        return {"calls": 0, "since": None, "last": None, "baseline_at": None}
    row = conn.execute(
        "SELECT COUNT(*) AS calls, MIN(ts) AS since, MAX(ts) AS last FROM calls"
    ).fetchone()
    base = conn.execute("SELECT captured_at FROM baseline WHERE id=1").fetchone()
    return {
        "calls": int(row["calls"] or 0),
        "since": row["since"],
        "last": row["last"],
        "baseline_at": base["captured_at"] if base else None,
    }


def reconciliation(conn: Optional[sqlite3.Connection],
                   state_db_path: Optional[Path | str] = None) -> dict[str, Any]:
    """Compare state.db's growth since baseline with captured call tokens.

    This is a diagnostic only. Period costs come from call rows; the baseline
    is never added to them.
    """
    empty = {
        "status": "no_baseline",
        "baseline_at": None,
        "baseline_tokens": None,
        "current_tokens": None,
        "delta_tokens": None,
        "captured_tokens": None,
        "gap_tokens": None,
        "captured_ratio": None,
        "captured_calls": None,
    }
    if conn is None:
        return empty
    base = conn.execute("SELECT * FROM baseline WHERE id=1").fetchone()
    if base is None:
        return empty

    state_path = Path(state_db_path) if state_db_path else default_db_path()
    if not state_path.exists():
        return {**empty, "status": "state_db_unavailable",
                "baseline_at": base["captured_at"], "baseline_tokens": int(base["total_tokens"])}
    try:
        state = sqlite3.connect(f"file:{state_path}?mode=ro", uri=True, timeout=5)
        current = state.execute(
            "SELECT COALESCE(SUM(input_tokens+output_tokens+cache_read_tokens+cache_write_tokens), 0) "
            "FROM session_model_usage"
        ).fetchone()[0]
        state.close()
    except sqlite3.Error:
        return {**empty, "status": "state_db_unavailable",
                "baseline_at": base["captured_at"], "baseline_tokens": int(base["total_tokens"])}

    captured_row = conn.execute(
        "SELECT COUNT(*) AS calls, COALESCE(SUM(total_tokens),0) AS tokens "
        "FROM calls WHERE recorded_at >= ?",
        # The first callback can be recorded a moment before the baseline
        # insert completes; a 2s tolerance keeps that first call in the count.
        (base["captured_at"] - 2.0,),
    ).fetchone()
    delta = int(current or 0) - int(base["total_tokens"] or 0)
    captured = int(captured_row["tokens"] or 0)
    gap = delta - captured
    status = "ok" if gap == 0 else "gap" if gap > 0 else "overcount" if captured > delta else "store_pruned"
    return {
        "status": status,
        "baseline_at": base["captured_at"],
        "baseline_tokens": int(base["total_tokens"]),
        "current_tokens": int(current or 0),
        "delta_tokens": delta,
        "captured_tokens": captured,
        "gap_tokens": gap,
        "captured_ratio": round(captured / delta, 4) if delta > 0 else None,
        "captured_calls": int(captured_row["calls"] or 0),
    }
