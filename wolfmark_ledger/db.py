"""Read-only access to Hermes' usage database.

The gateway owns ``state.db``; this module only ever opens it with SQLite's
``mode=ro`` URI and ``PRAGMA query_only``. It never creates, migrates or
repairs anything, and it never reads message content.
"""

from __future__ import annotations

import sqlite3
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Optional


class LedgerUnavailable(RuntimeError):
    """The usage database cannot be read (missing, locked, or unsupported schema)."""


# Columns we rely on. ``profile_name``/``title`` are additive; the core usage
# columns are required. Kept explicit so a future Hermes schema change fails
# loudly instead of silently producing wrong totals.
_USAGE_COLUMNS = {
    "session_id",
    "model",
    "billing_provider",
    "billing_base_url",
    "billing_mode",
    "task",
    "input_tokens",
    "output_tokens",
    "cache_read_tokens",
    "cache_write_tokens",
    "reasoning_tokens",
    "api_call_count",
    "estimated_cost_usd",
    "actual_cost_usd",
    "cost_status",
    "cost_source",
    "first_seen",
    "last_seen",
}
_SESSION_COLUMNS = {"id", "source", "started_at", "title", "profile_name"}


def default_db_path() -> Path:
    """Active profile's ``state.db``.

    ``get_hermes_home()`` is imported lazily: it exists inside the gateway but
    not in a bare unit-test environment.
    """
    try:
        from hermes_constants import get_hermes_home  # type: ignore

        return Path(get_hermes_home()) / "state.db"
    except Exception:
        return Path.home() / ".hermes" / "state.db"


def _columns(conn: sqlite3.Connection, table: str) -> set[str]:
    return {str(row[1]) for row in conn.execute(f"PRAGMA table_info({table})")}


def _check_schema(conn: sqlite3.Connection) -> None:
    usage_cols = _columns(conn, "session_model_usage")
    session_cols = _columns(conn, "sessions")
    if not usage_cols or not session_cols:
        raise LedgerUnavailable(
            "state.db has no session_model_usage/sessions tables; "
            "this Hermes version is not supported"
        )
    missing_usage = _USAGE_COLUMNS - usage_cols
    missing_sessions = _SESSION_COLUMNS - session_cols
    if missing_usage or missing_sessions:
        raise LedgerUnavailable(
            "state.db schema is missing required columns: "
            + ", ".join(sorted(missing_usage | missing_sessions))
        )


def connect_readonly(path: Path | str) -> sqlite3.Connection:
    path = Path(path)
    if not path.exists():
        raise LedgerUnavailable(f"usage database not found: {path}")
    try:
        conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=5)
    except sqlite3.Error as exc:
        raise LedgerUnavailable(f"could not open usage database read-only: {exc}") from exc
    conn.row_factory = sqlite3.Row
    try:
        conn.execute("PRAGMA query_only=ON")
        conn.execute("PRAGMA busy_timeout=5000")
        _check_schema(conn)
    except sqlite3.Error as exc:
        conn.close()
        raise LedgerUnavailable(f"could not read usage database: {exc}") from exc
    return conn


def fetch_usage_rows(
    db_path: Path | str | None = None,
    *,
    days: Optional[int] = 30,
    now: Optional[float] = None,
) -> tuple[list[dict[str, Any]], float, float]:
    """Return usage rows whose last activity falls inside the window.

    ``days=None`` means all recorded history (used only for the clearly
    labelled historical baseline). A numeric window is still a cumulative-row
    filter; it is not period-accurate. Period figures come from the collector's
    per-call store, never from this function.
    """
    path = Path(db_path) if db_path else default_db_path()
    now = time.time() if now is None else now
    since = 0.0 if days is None else now - max(1, min(int(days), 365)) * 86_400

    conn = connect_readonly(path)
    try:
        rows = conn.execute(
            """
            SELECT u.session_id,
                   u.model,
                   u.billing_provider,
                   u.billing_base_url,
                   u.billing_mode,
                   u.task,
                   u.input_tokens,
                   u.output_tokens,
                   u.cache_read_tokens,
                   u.cache_write_tokens,
                   u.reasoning_tokens,
                   u.api_call_count,
                   u.estimated_cost_usd,
                   u.actual_cost_usd,
                   u.cost_status,
                   u.cost_source,
                   u.first_seen,
                   u.last_seen,
                   s.source AS surface,
                   s.title AS title,
                   s.started_at AS started_at,
                   s.profile_name AS profile
              FROM session_model_usage AS u
              LEFT JOIN sessions AS s ON s.id = u.session_id
             WHERE COALESCE(u.last_seen, u.first_seen, s.started_at, 0) >= ?
             ORDER BY COALESCE(u.last_seen, u.first_seen, s.started_at, 0) DESC
            """,
            (since,),
        ).fetchall()
    except sqlite3.Error as exc:
        raise LedgerUnavailable(f"could not query usage rows: {exc}") from exc
    finally:
        conn.close()

    return [dict(row) for row in rows], since, now


def iter_rows(rows: Iterable[dict[str, Any]]) -> Iterable[dict[str, Any]]:
    """Small indirection that keeps callers testable over plain dicts."""
    return rows
