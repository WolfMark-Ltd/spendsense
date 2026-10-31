"""Aggregate Hermes usage into a provider-aware cost report.

One row of ``session_model_usage`` is one accounting bucket. The report sums
those buckets; it never adds the ``sessions`` totals on top, so main-loop and
auxiliary work cannot be double-counted.
"""

from __future__ import annotations

import sqlite3
import time
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Optional

from . import store
from .db import default_db_path, fetch_usage_rows
from .pricing import PROVIDER_ALIASES, Catalogue, load_catalogue, price


BASIS_MODES = ("billed", "list", "hybrid")
MAX_UNPRICED = 25
MAX_SESSIONS = 25


def _num(value: Any) -> Optional[float]:
    if value is None or isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if number >= 0 else None


def _int(value: Any) -> int:
    try:
        return max(0, int(value or 0))
    except (TypeError, ValueError):
        return 0


def _iso(epoch: Optional[float]) -> str:
    if not epoch:
        return ""
    try:
        return datetime.fromtimestamp(float(epoch), timezone.utc).isoformat()
    except (OverflowError, OSError, ValueError):
        return ""


def _billed(row: dict[str, Any]) -> tuple[Optional[float], str]:
    """What a provider actually recorded as charged, and how it knows.

    ``actual_cost_usd`` defaults to 0 in SQLite, so the status is the
    authority. A missing status falls back to a non-zero amount (legacy rows).
    """
    status = str(row.get("cost_status") or "").strip().lower()
    estimated = _num(row.get("estimated_cost_usd"))
    actual = _num(row.get("actual_cost_usd"))

    if status == "actual":
        return (actual if actual is not None else 0.0), "actual"
    if status == "estimated":
        return (estimated if estimated is not None else 0.0), "estimated"
    if status == "included":
        return 0.0, "included"
    if actual not in (None, 0.0):
        return actual, "actual"
    if estimated not in (None, 0.0):
        return estimated, "estimated"
    return None, "unknown"


def _basis_amount(mode: str, billed: Optional[float], kind: str, list_usd: Optional[float]) -> tuple[Optional[float], str]:
    if mode == "billed":
        return billed, kind if billed is not None else "unknown"
    if mode == "list":
        return list_usd, "list" if list_usd is not None else "unpriced"
    # hybrid: real charges stay real; subscription-included and unknown routes
    # are valued at list price so membership usage is visible.
    if kind in ("actual", "estimated"):
        return billed, kind
    if list_usd is not None:
        return list_usd, "list"
    return None, "unpriced"


def _miss_reason(catalogue: Catalogue, provider: str, model: str) -> str:
    route = (provider or "").strip()
    if not route:
        return "provider_not_recorded"
    canonical = PROVIDER_ALIASES.get(route.lower(), route.lower())
    if canonical not in catalogue.providers:
        return "provider_not_in_catalogue"
    return "model_not_in_catalogue"


@dataclass
class Acc:
    input: int = 0
    output: int = 0
    cache_read: int = 0
    cache_write: int = 0
    reasoning: int = 0
    calls: int = 0
    rows: int = 0
    billed: float = 0.0
    billed_rows: int = 0
    list: float = 0.0
    list_upper: float = 0.0
    priced_tokens: int = 0
    unpriced_tokens: int = 0
    tier_tokens: int = 0
    basis: float = 0.0
    basis_rows: int = 0
    kinds: Counter = field(default_factory=Counter)
    basis_kinds: Counter = field(default_factory=Counter)
    billing_tokens: Counter = field(default_factory=Counter)
    provenance_tokens: Counter = field(default_factory=Counter)
    failures: int = 0
    missing: int = 0
    sessions: set[str] = field(default_factory=set)
    models: set[str] = field(default_factory=set)

    @property
    def tokens(self) -> int:
        return self.input + self.output + self.cache_read + self.cache_write

    def add(self, row: dict[str, Any], list_usd: Optional[float], list_upper: Optional[float],
            billed: Optional[float], billed_kind: str, basis_usd: Optional[float],
            basis_kind: str) -> None:
        self.input += row["_input"]
        self.output += row["_output"]
        self.cache_read += row["_cache_read"]
        self.cache_write += row["_cache_write"]
        self.reasoning += row["_reasoning"]
        self.calls += row["_calls"]
        self.rows += 1
        self.kinds[billed_kind] += 1
        self.basis_kinds[basis_kind] += 1
        self.billing_tokens[billed_kind] += row["_tokens"]
        self.provenance_tokens[str(row.get("pricing_provenance") or "unpriced")] += row["_tokens"]
        if row.get("_failure"):
            self.failures += 1
        if row.get("_missing"):
            self.missing += 1
        if row["_session_id"]:
            self.sessions.add(row["_session_id"])
        if row["_model"]:
            self.models.add(f"{row['_provider']}/{row['_model']}")

        if list_usd is None:
            self.unpriced_tokens += row["_tokens"]
        else:
            self.priced_tokens += row["_tokens"]
            self.list += list_usd
            self.list_upper += list_upper if list_upper is not None else list_usd
            if row.get("_tier_applied"):
                self.tier_tokens += row["_tokens"]

        if billed is not None:
            self.billed += billed
            self.billed_rows += 1

        if basis_usd is not None:
            self.basis += basis_usd
            self.basis_rows += 1

    def as_dict(self) -> dict[str, Any]:
        tokens = self.tokens
        coverage = (self.priced_tokens / tokens) if tokens else 0.0
        if not tokens:
            status = "empty"
        elif self.unpriced_tokens == 0:
            status = "complete"
        elif self.priced_tokens == 0:
            status = "unpriced"
        else:
            status = "partial"
        return {
            "input_tokens": self.input,
            "output_tokens": self.output,
            "cache_read_tokens": self.cache_read,
            "cache_write_tokens": self.cache_write,
            "reasoning_tokens": self.reasoning,
            "tokens": tokens,
            "calls": self.calls,
            "rows": self.rows,
            "billed_usd": round(self.billed, 6) if (self.rows > 0 and self.billed_rows == self.rows) else None,
            "billed_complete": self.rows > 0 and self.billed_rows == self.rows,
            "list_usd": round(self.list, 6) if self.priced_tokens or tokens == 0 else None,
            "list_usd_upper": round(self.list_upper, 6) if (self.priced_tokens or tokens == 0) else None,
            "tier_possible_tokens": self.tier_tokens,
            "basis_usd": round(self.basis, 6) if (self.rows > 0 and self.basis_rows == self.rows) else None,
            "basis_complete": self.basis_rows == self.rows,
            "priced_tokens": self.priced_tokens,
            "unpriced_tokens": self.unpriced_tokens,
            "coverage": round(coverage, 6),
            "status": status,
            "basis_mix": dict(self.basis_kinds),
            "billing_mix": dict(self.kinds),
            "billing_tokens": dict(self.billing_tokens),
            "pricing_mix": dict(self.provenance_tokens),
            "pricing_provenance": (next(iter(self.provenance_tokens)) if len(self.provenance_tokens) == 1
                                   else "mixed" if self.provenance_tokens else "unpriced"),
            "failures": self.failures,
            "missing_usage": self.missing,
            "sessions": len(self.sessions),
            "models": sorted(self.models),
        }


def _row_result(row: dict[str, Any], catalogue: Catalogue, mode: str) -> dict[str, Any]:
    provider = str(row.get("billing_provider") or "").strip()
    model = str(row.get("model") or "").strip()
    task = str(row.get("task") or "").strip() or "main"
    surface = str(row.get("surface") or "").strip() or "(unknown)"

    input_tokens = _int(row.get("input_tokens"))
    output_tokens = _int(row.get("output_tokens"))
    cache_read = _int(row.get("cache_read_tokens"))
    cache_write = _int(row.get("cache_write_tokens"))
    reasoning = _int(row.get("reasoning_tokens"))
    calls = _int(row.get("api_call_count"))
    tokens = input_tokens + output_tokens + cache_read + cache_write

    lookup = catalogue.lookup(provider, model)
    provenance = getattr(lookup, "provenance", "provider_catalogue") if lookup else "unpriced"
    list_usd: Optional[float] = None
    list_upper: Optional[float] = None
    rate_info: Optional[dict[str, Any]] = None
    tier_possible = False
    miss = ""
    if lookup:
        priced = price(
            lookup.rate,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            cache_read_tokens=cache_read,
            cache_write_tokens=cache_write,
            calls=calls,
        )
        list_usd = priced.usd
        list_upper = priced.usd_upper
        tier_possible = priced.tier_possible
        rate_info = {
            "provider": lookup.provider,
            "model": lookup.model,
            "source": lookup.source,
            "confidence": lookup.confidence,
            "alias": lookup.alias_used,
            "tier_possible": priced.tier_possible,
            "cache_read_defaulted": priced.cache_read_defaulted,
            "cache_write_defaulted": priced.cache_write_defaulted,
            "cache_savings_usd": priced.cache_savings,
        }
        if list_usd is None:
            miss = priced.reason
    else:
        miss = _miss_reason(catalogue, provider, model)

    billed_usd, billed_kind = _billed(row)
    basis_usd, basis_kind = _basis_amount(mode, billed_usd, billed_kind, list_usd)

    return {
        "_session_id": str(row.get("session_id") or ""),
        "_title": str(row.get("title") or ""),
        "_surface": surface,
        "_profile": str(row.get("profile") or ""),
        "_started_at": row.get("started_at"),
        "_provider": provider or "(unattributed)",
        "_model": model or "(unknown)",
        "_task": task,
        "_input": input_tokens,
        "_output": output_tokens,
        "_cache_read": cache_read,
        "_cache_write": cache_write,
        "_reasoning": reasoning,
        "_calls": calls,
        "_tokens": tokens,
        "_tier_applied": tier_possible,
        "_failure": False,
        "_missing": False,
        "_billing_class": billed_kind,
        "model": model or "(unknown)",
        "provider": provider or "(unattributed)",
        "task": task,
        "surface": surface,
        "billed_usd": billed_usd,
        "billed_kind": billed_kind,
        "list_usd": list_usd,
        "list_usd_upper": list_upper,
        "tier_possible": tier_possible,
        "basis_usd": basis_usd,
        "basis_kind": basis_kind,
        "priced": list_usd is not None,
        "pricing_provenance": provenance,
        "unpriced_tokens": 0 if list_usd is not None else tokens,
        "pricing": rate_info,
        "pricing_miss": miss,
        "first_seen": row.get("first_seen"),
        "last_seen": row.get("last_seen"),
    }


def _group(rows: list[dict[str, Any]], key_fn) -> list[dict[str, Any]]:
    groups: dict[str, tuple[dict[str, Any], Acc]] = {}
    for row in rows:
        key, label, extra = key_fn(row)
        if key not in groups:
            groups[key] = ({"name": label, **extra}, Acc())
        _, acc = groups[key]
        acc.add(
            row,
            row["list_usd"],
            row["list_usd_upper"],
            row["billed_usd"],
            row["billed_kind"],
            row["basis_usd"],
            row["basis_kind"],
        )
    out = []
    for _, (meta, acc) in groups.items():
        out.append({**meta, **acc.as_dict()})
    out.sort(key=lambda item: (item.get("basis_usd") is None, -(item.get("basis_usd") or 0), -item["tokens"]))
    return out


def _session_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    groups: dict[str, tuple[dict[str, Any], Acc]] = {}
    for row in rows:
        sid = row["_session_id"]
        if not sid:
            continue
        if sid not in groups:
            groups[sid] = (
                {
                    "session_id": sid,
                    "title": row["_title"],
                    "surface": row["_surface"],
                    "profile": row["_profile"],
                    "started_at": row["_started_at"],
                },
                Acc(),
            )
        _, acc = groups[sid]
        acc.add(
            row,
            row["list_usd"],
            row["list_usd_upper"],
            row["billed_usd"],
            row["billed_kind"],
            row["basis_usd"],
            row["basis_kind"],
        )
    out = []
    for _, (meta, acc) in groups.items():
        out.append({**meta, **acc.as_dict()})
    out.sort(key=lambda item: (item.get("basis_usd") is None, -(item.get("basis_usd") or 0)))
    return out[:MAX_SESSIONS]


def _unpriced(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    groups: dict[tuple[str, str, str], dict[str, Any]] = {}
    for row in rows:
        if row["priced"] or row["_tokens"] <= 0:
            continue
        key = (row["_provider"], row["_model"], row["pricing_miss"] or "unpriced")
        item = groups.setdefault(
            key,
            {
                "provider": row["_provider"],
                "model": row["_model"],
                "reason": row["pricing_miss"] or "unpriced",
                "tokens": 0,
                "calls": 0,
                "tasks": set(),
            },
        )
        item["tokens"] += row["_tokens"]
        item["calls"] += row["_calls"]
        item["tasks"].add(row["_task"])
    out = sorted(groups.values(), key=lambda item: -item["tokens"])[:MAX_UNPRICED]
    for item in out:
        item["tasks"] = sorted(item["tasks"])
    return out


def build_report(
    db_path: Path | str | None = None,
    *,
    days: Optional[int] = 30,
    basis: str = "hybrid",
    now: Optional[float] = None,
    catalogue: Optional[Catalogue] = None,
) -> dict[str, Any]:
    """Build the cumulative baseline report for the active profile."""
    mode = basis if basis in BASIS_MODES else "hybrid"
    book = catalogue or load_catalogue()
    rows, since, until = fetch_usage_rows(db_path, days=days, now=now)
    results = [_row_result(row, book, mode) for row in rows]

    totals = Acc()
    for row in results:
        totals.add(
            row,
            row["list_usd"],
            row["list_usd_upper"],
            row["billed_usd"],
            row["billed_kind"],
            row["basis_usd"],
            row["basis_kind"],
        )

    by_route = _group(
        results,
        lambda row: (
            row["_provider"],
            row["_provider"],
            {"provider": row["_provider"]},
        ),
    )
    by_model = _group(
        results,
        lambda row: (
            f"{row['_provider']}\x00{row['_model']}",
            row["_model"],
            {"provider": row["_provider"], "model": row["_model"]},
        ),
    )
    by_task = _group(results, lambda row: (row["_task"], row["_task"], {}))
    by_surface = _group(results, lambda row: (row["_surface"], row["_surface"], {}))

    return {
        "ok": True,
        "window": {
            "days": int(days) if days is not None else None,
            "since": _iso(since),
            "until": _iso(until),
            "basis": mode,
            "timezone": "UTC",
        },
        "rate_card": book.meta(),
        "totals": totals.as_dict(),
        "by_route": by_route,
        "by_model": by_model,
        "by_task": by_task,
        "by_surface": by_surface,
        "recent_sessions": _session_rows(results),
        "unpriced": _unpriced(results),
        "limits": [
            "Rates are the current models.dev snapshot, not the rate that applied at call time; past totals can change when a price changes.",
            "Context-tier pricing uses average prompt tokens per call. Per-call prompt sizes are not stored, so tiered rows are approximate.",
            "Rows whose provider or model has no catalogue rate are counted as unpriced tokens; they are never priced with another provider's card.",
            "Only the active profile's state.db is read. Other profiles are separate stores.",
            "Usage is filtered by last activity; a session spanning the window boundary is counted once, on the side of the boundary where it last ran.",
            "Billed figures are what Hermes recorded (actual/estimated/included), not an invoice. Subscription plans have no per-token invoice.",
        ],
    }


# ---------------------------------------------------------------------------
# Timestamped per-call period report
# ---------------------------------------------------------------------------

def _local_window(days: int, now: float) -> tuple[float, float, str]:
    """Local-calendar window ending at ``now``; Today means local midnight."""
    local = datetime.fromtimestamp(now)
    midnight = local.replace(hour=0, minute=0, second=0, microsecond=0)
    since = midnight - timedelta(days=max(0, int(days) - 1))
    return since.timestamp(), now, datetime.fromtimestamp(now).astimezone().tzname() or "local"


def _status_from_row(status: Any, actual: Any, estimated: Any) -> str:
    value = str(status or "").strip().lower()
    if value in ("actual", "estimated", "included"):
        return value
    if _num(actual) not in (None, 0.0):
        return "actual"
    if _num(estimated) not in (None, 0.0):
        return "estimated"
    return "unknown"


def route_billing_status(state_db_path: Path | str | None = None) -> dict[str, dict]:
    """Latest recorded cost status per route/model, for classifying call rows.

    The collector has no per-call invoice, so this maps a call to the route's
    billing class. It deliberately does not allocate a session's actual cost to
    individual calls.
    """
    path = Path(state_db_path) if state_db_path else default_db_path()
    if not path.exists():
        return {"exact": {}}
    try:
        conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=5)
        rows = conn.execute(
            """
            SELECT billing_provider, model, cost_status, actual_cost_usd, estimated_cost_usd
              FROM (
                SELECT billing_provider, model, cost_status,
                       actual_cost_usd, estimated_cost_usd,
                       ROW_NUMBER() OVER (
                         PARTITION BY billing_provider, model
                         ORDER BY COALESCE(last_seen, 0) DESC
                       ) AS rn
                  FROM session_model_usage
              )
             WHERE rn = 1
            """
        ).fetchall()
        conn.close()
    except sqlite3.Error:
        return {"exact": {}}

    exact: dict[tuple[str, str], str] = {}
    for provider, model, status, actual, estimated in rows:
        exact[(str(provider or ""), str(model or ""))] = _status_from_row(status, actual, estimated)
    return {"exact": exact}


def _billing_class(statuses: dict[str, dict], provider: str, model: str) -> str:
    # Exact route/model only: an unknown new model must not inherit a sibling's
    # billing class and appear as confirmed $0.
    return statuses.get("exact", {}).get((provider, model)) or "unknown"


def _event_result(row: dict[str, Any], catalogue: Catalogue, mode: str,
                  statuses: dict[str, dict], *, allow_third_party: bool = False,
                  allow_approximate: bool = False, at: float | None = None) -> dict[str, Any]:
    provider = str(row.get("provider") or "").strip()
    model = str(row.get("model") or "").strip()
    task = str(row.get("aux_task") or "").strip() or "main"
    surface = str(row.get("platform") or "").strip() or "(unknown)"
    outcome = str(row.get("outcome") or "ok")
    failure = outcome == "error"
    missing = outcome == "missing_usage"

    input_tokens = _int(row.get("input_tokens"))
    output_tokens = _int(row.get("output_tokens"))
    cache_read = _int(row.get("cache_read_tokens"))
    cache_write = _int(row.get("cache_write_tokens"))
    reasoning = _int(row.get("reasoning_tokens"))
    tokens = input_tokens + output_tokens + cache_read + cache_write

    lookup = catalogue.lookup(provider, model, allow_third_party=allow_third_party,
                              allow_approximate=allow_approximate, at=at)
    provenance = getattr(lookup, "provenance", "provider_catalogue") if lookup else "unpriced"
    priced = (
        price(
            lookup.rate,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            cache_read_tokens=cache_read,
            cache_write_tokens=cache_write,
            calls=1,
        )
        if lookup else None
    )
    # Each event is one call, so the tiered amount is exact; use the
    # upper branch of price(), not the conservative cumulative base.
    list_usd = priced.usd_upper if priced and not failure and not missing else None
    if priced and list_usd is None:
        miss = priced.reason
    elif not lookup:
        miss = _miss_reason(catalogue, provider, model)
    else:
        miss = ""
    if failure:
        miss = "call_failed"
    elif missing:
        miss = "usage_missing"

    billing_class = _billing_class(statuses, provider, model)
    billed_usd = 0.0 if billing_class == "included" else None
    if mode == "billed":
        basis_usd = 0.0 if billing_class == "included" else None
    else:
        basis_usd = list_usd
    basis_kind = ("billed" if mode == "billed" else "list") if basis_usd is not None else "unpriced"
    tier_applied = bool(priced and priced.tier_possible and list_usd is not None)

    return {
        "_session_id": str(row.get("session_id") or ""),
        "_title": "",
        "_surface": surface,
        "_profile": "",
        "_started_at": row.get("started_at"),
        "_provider": provider or "(unattributed)",
        "_model": model or "(unknown)",
        "_task": task,
        "_input": input_tokens,
        "_output": output_tokens,
        "_cache_read": cache_read,
        "_cache_write": cache_write,
        "_reasoning": reasoning,
        "_calls": 1,
        "_tokens": tokens,
        "_tier_applied": tier_applied,
        "_failure": failure,
        "_missing": missing,
        "_billing_class": billing_class,
        "event_id": row.get("event_id"),
        "model": model or "(unknown)",
        "provider": provider or "(unattributed)",
        "task": task,
        "surface": surface,
        "outcome": outcome,
        "streaming": bool(row.get("streaming")),
        "billing_class": billing_class,
        "billed_usd": billed_usd,
        "billed_kind": billing_class,
        "list_usd": list_usd,
        "list_usd_upper": list_usd,
        "tier_possible": tier_applied,
        "basis_usd": basis_usd,
        "basis_kind": basis_kind,
        "priced": list_usd is not None,
        "pricing_provenance": provenance,
        "unpriced_tokens": 0 if list_usd is not None else tokens,
        "pricing": {
            "provider": lookup.provider if lookup else None,
            "model": lookup.model if lookup else None,
            "source": lookup.source if lookup else None,
            "confidence": lookup.confidence if lookup else None,
            "alias": lookup.alias_used if lookup else None,
            "tier_applied": tier_applied,
            "cache_read_defaulted": bool(priced.cache_read_defaulted) if priced else False,
            "cache_write_defaulted": bool(priced.cache_write_defaulted) if priced else False,
            "provenance": provenance,
        } if lookup else None,
        "pricing_miss": miss,
        "first_seen": row.get("started_at"),
        "last_seen": row.get("ts"),
    }


def build_event_period(
    event_db_path: Path | str | None = None,
    *,
    days: int = 30,
    basis: str = "hybrid",
    catalogue: Optional[Catalogue] = None,
    statuses: Optional[dict[str, dict]] = None,
    now: Optional[float] = None,
) -> dict[str, Any]:
    """Period report built exclusively from timestamped call rows."""
    mode = basis if basis in BASIS_MODES else "hybrid"
    book = catalogue or load_catalogue()
    now = time.time() if now is None else now
    days = max(1, min(int(days), 365))
    since, until, tz = _local_window(days, now)

    conn = store.connect_reader(event_db_path)
    rows = store.query_calls(conn, since=since, until=until) if conn else []
    recording = store.recording_info(conn)
    if conn is not None:
        conn.close()

    statuses = statuses or {}
    results = [_event_result(row, book, mode, statuses, at=row.get("ts")) for row in rows]

    totals = Acc()
    for row in results:
        totals.add(
            row,
            row["list_usd"],
            row["list_usd_upper"],
            row["billed_usd"],
            row["billed_kind"],
            row["basis_usd"],
            row["basis_kind"],
        )

    by_route = _group(results, lambda row: (row["_provider"], row["_provider"],
                                            {"provider": row["_provider"]}))
    by_model = _group(results, lambda row: (
        f"{row['_provider']}\x00{row['_model']}",
        row["_model"],
        {"provider": row["_provider"], "model": row["_model"]},
    ))
    by_task = _group(results, lambda row: (row["_task"], row["_task"], {}))
    by_surface = _group(results, lambda row: (row["_surface"], row["_surface"], {}))

    return {
        "ok": True,
        "window": {
            "days": days,
            "since": _iso(since),
            "until": _iso(until),
            "basis": mode,
            "timezone": tz,
            "kind": "timestamped_calls",
            "recording_since": _iso(recording["since"]),
        },
        "rate_card": book.meta(),
        "tier_mode": "per_call",
        "totals": totals.as_dict(),
        "by_route": by_route,
        "by_model": by_model,
        "by_task": by_task,
        "by_surface": by_surface,
        "recent_sessions": _session_rows(results),
        "unpriced": _unpriced(results),
        "events": {
            "calls": len(results),
            "failures": sum(1 for row in results if row["outcome"] == "error"),
            "missing_usage": sum(1 for row in results if row["outcome"] == "missing_usage"),
            "streaming": sum(1 for row in results if row["streaming"]),
        },
        "recording": {
            "calls": recording["calls"],
            "since": _iso(recording["since"]),
            "last": _iso(recording["last"]),
            "baseline_at": _iso(recording["baseline_at"]),
        },
        "limits": [
            "Period figures are timestamped per-call records collected since the plugin was enabled; usage before installation is not in this window.",
            "The historical baseline below is cumulative state.db data, not period usage. It is shown separately and never added to these totals.",
            "These per-call figures apply context tiers exactly for each call; no average-prompt heuristic is used here.",
            "Billed is a route classification, not a per-call invoice. Only subscription-included routes show a confirmed $0 marginal charge; actual/estimated charges are recorded at session level and are not allocated to individual calls.",
            "Calls with missing usage or provider errors are counted as gaps, not priced.",
            "Call rows are retained for 180 days. Reconciliation compares captured tokens with state.db growth since the baseline.",
        ],
    }


def build_ledger_report(
    *,
    days: int = 30,
    basis: str = "hybrid",
    state_db_path: Path | str | None = None,
    event_db_path: Path | str | None = None,
    now: Optional[float] = None,
) -> dict[str, Any]:
    """All Hermes report: timestamped period + separate historical baseline."""
    from .db import LedgerUnavailable

    now = time.time() if now is None else now
    book = load_catalogue()
    # Read-only: the collector owns schema creation and the baseline. The API
    # must not create or mutate the plugin store.
    statuses = route_billing_status(state_db_path)
    period = build_event_period(
        event_db_path, days=days, basis=basis, catalogue=book, statuses=statuses, now=now
    )

    try:
        baseline = build_report(
            state_db_path, days=None, basis=basis, now=now, catalogue=book
        )
        baseline["kind"] = "cumulative_historical_estimate"
        baseline["tier_mode"] = "average_estimate"
        baseline["note"] = (
            "Cumulative state.db totals, not period usage. Context tiers use an "
            "average-prompt estimate because per-call prompt sizes are not stored."
        )
    except LedgerUnavailable as exc:
        baseline = {
            "ok": False,
            "kind": "cumulative_historical_estimate",
            "error": str(exc),
            "totals": None,
        }

    conn = store.connect_reader(event_db_path)
    recon = store.reconciliation(conn, state_db_path)
    recording = store.recording_info(conn)
    if conn is not None:
        conn.close()
    if isinstance(recon.get("baseline_at"), (int, float)):
        recon["baseline_at"] = _iso(recon["baseline_at"])

    period["baseline"] = baseline
    period["reconciliation"] = recon
    period["recording"] = {
        "calls": recording["calls"],
        "since": _iso(recording["since"]),
        "last": _iso(recording["last"]),
        "baseline_at": _iso(recording["baseline_at"]),
    }
    period["window"]["recording_since"] = _iso(recording["since"])
    return period
