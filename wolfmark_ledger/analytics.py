"""Read-only, timestamped-call analytics. Never derives periods from state totals."""
from __future__ import annotations

import json
import sqlite3
import time
from bisect import bisect_right
from collections import Counter
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from . import billing, store
from .aggregate import Acc, _event_result, _iso, _local_window, route_billing_status
from .db import default_db_path
from .pricing import Catalogue, _effective_rate, load_catalogue

SCOPES = ("direct", "subagent", "auxiliary", "unattributed")
_MAX_ANCESTRY = 32

_TOTAL_FIELDS = (
    "tokens", "calls", "input_tokens", "output_tokens", "cache_read_tokens",
    "cache_write_tokens", "reasoning_tokens", "list_usd", "priced_tokens", "unpriced_tokens",
    "coverage", "billed_usd", "billed_complete", "billing_mix",
)


def _call_economics(row: dict[str, Any], book: Catalogue, *,
                    allow_third_party: bool = False,
                    allow_approximate: bool = False) -> tuple[tuple[float, float] | None, str]:
    """Strict comparison on the same complete, known-cache call population."""
    if row["_failure"]:
        return None, "call_failed"
    if row["_missing"]:
        return None, "usage_missing"
    if not (row["_cache_read"] or row["_cache_write"]):
        return None, "cache_provenance_unknown"
    lookup = book.lookup(row["provider"], row["model"], allow_third_party=allow_third_party,
                         allow_approximate=allow_approximate,
                         at=row.get("last_seen"))
    if lookup is None:
        return None, "rate_unavailable"
    prompt = row["_input"] + row["_cache_read"] + row["_cache_write"]
    rate, _ = _effective_rate(lookup.rate, prompt)
    if rate.input is None or rate.output is None:
        return None, "missing_base_rate"
    if row["_cache_read"] and rate.cache_read is None:
        return None, "missing_cache_read_rate"
    if row["_cache_write"] and rate.cache_write is None:
        return None, "missing_cache_write_rate"
    uncached = (prompt * rate.input + row["_output"] * rate.output) / 1_000_000
    cached = (row["_input"] * rate.input + row["_output"] * rate.output
              + row["_cache_read"] * (rate.cache_read or 0)
              + row["_cache_write"] * (rate.cache_write or 0)) / 1_000_000
    return (uncached, cached), ""


class _AnalyticsAcc:
    def __init__(self):
        self.accounting = Acc()
        self.cache_known_calls = 0
        self.fallback_calls = 0
        self.known_prompt_tokens = 0
        self.total_prompt_tokens = 0
        self.known_read_tokens = 0
        self.uncached_usd = 0.0
        self.cached_usd = 0.0
        self.covered_tokens = 0
        self.covered_calls = 0
        self.economics_gaps: Counter[str] = Counter()

    def add(self, row: dict[str, Any]) -> None:
        pricing = row.get("pricing") or {}
        if row["list_usd"] is not None and (pricing.get("cache_read_defaulted") or pricing.get("cache_write_defaulted")):
            self.fallback_calls += 1
        economics = row["_economics"]
        if economics is None:
            self.economics_gaps[row["_economics_gap"]] += 1
        else:
            self.uncached_usd += economics[0]
            self.cached_usd += economics[1]
            self.covered_tokens += row["_tokens"]
            self.covered_calls += 1
        self.total_prompt_tokens += row["_input"] + row["_cache_read"] + row["_cache_write"]
        if not row["_failure"] and not row["_missing"] and (row["_cache_read"] > 0 or row["_cache_write"] > 0):
            self.cache_known_calls += 1
            self.known_prompt_tokens += row["_input"] + row["_cache_read"] + row["_cache_write"]
            self.known_read_tokens += row["_cache_read"]
        self.accounting.add(row, row["list_usd"], row["list_usd_upper"],
                            row["billed_usd"], row["billed_kind"],
                            row["basis_usd"], row["basis_kind"])

    def as_dict(self) -> dict[str, Any]:
        base = self.accounting.as_dict()
        return {**{key: base[key] for key in _TOTAL_FIELDS},
                "pricing_provenance": base.get("pricing_provenance", "unpriced"),
                "pricing_mix": base.get("pricing_mix", {}),
                "fallback_calls": self.fallback_calls,
                "cache_hit_rate": (round(self.known_read_tokens / self.known_prompt_tokens, 6)
                                   if self.known_prompt_tokens else None),
                "cache_known_calls": self.cache_known_calls,
                "cache_unknown_calls": base["calls"] - self.cache_known_calls,
                "cache_coverage": round(self.cache_known_calls / base["calls"], 6) if base["calls"] else 0.0,
                "cache_prompt_coverage": (round(self.known_prompt_tokens / self.total_prompt_tokens, 6)
                                          if self.total_prompt_tokens else None),
                "cache_covered_prompt_tokens": self.known_prompt_tokens,
                "cache_total_prompt_tokens": self.total_prompt_tokens,
                "economics": {
                    "uncached_usd": round(self.uncached_usd, 6) if self.covered_calls else None,
                    "cached_usd": round(self.cached_usd, 6) if self.covered_calls else None,
                    "savings_usd": round(self.uncached_usd - self.cached_usd, 6) if self.covered_calls else None,
                    "covered_tokens": self.covered_tokens,
                    "coverage": round(self.covered_tokens / base["tokens"], 6) if base["tokens"] else 0.0,
                    "covered_calls": self.covered_calls,
                    "excluded_calls": base["calls"] - self.covered_calls,
                }}


def _session_graph(state_db_path: Path | str | None) -> dict[str, Any]:
    """Read-only parent/child map from Hermes' own sessions table.

    Child sessions are reliable here: ``parent_session_id`` is set, and the
    ``_delegate_from`` creation marker covers older children that inherit the
    parent's source. No prompt content is read.
    """
    path = Path(state_db_path) if state_db_path else default_db_path()
    graph: dict[str, Any] = {"child_of": {}, "known": set(), "cycles": 0}
    if not path.exists():
        return graph
    try:
        conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=5)
        try:
            rows = conn.execute(
                "SELECT id, parent_session_id, model_config FROM sessions"
            ).fetchall()
        finally:
            conn.close()
    except sqlite3.Error:
        return graph

    for session_id, parent_id, model_config in rows:
        sid = str(session_id or "")
        if not sid:
            continue
        graph["known"].add(sid)
        parent = str(parent_id or "")
        if not parent and model_config:
            try:
                marker = json.loads(model_config).get("_delegate_from") if isinstance(model_config, str) else None
            except (TypeError, ValueError):
                marker = None
            parent = str(marker or "")
        if parent and parent != sid:
            graph["child_of"][sid] = parent
    graph["cycles"] = _cycle_count(graph["child_of"])
    return graph


def _cycle_count(child_of: dict[str, str]) -> int:
    seen_bad: set[str] = set()
    total = 0
    for start in child_of:
        trail: list[str] = []
        node = start
        while node in child_of and len(trail) < _MAX_ANCESTRY:
            if node in trail:
                break
            trail.append(node)
            node = child_of[node]
        else:
            continue
        if node in trail and node not in seen_bad:
            seen_bad.add(node)
            total += 1
    return total


def _root_of(session_id: str, child_of: dict[str, str]) -> str:
    """Topmost known ancestor; a cycle stops at the first repeat."""
    node = session_id
    seen: set[str] = set()
    for _ in range(_MAX_ANCESTRY):
        parent = child_of.get(node)
        if not parent or parent in seen:
            break
        seen.add(node)
        node = parent
    return node


def _scope_of(session_id: str, task: str, child_of: dict[str, str], known: set[str]) -> str:
    """Delegation scope. A child's auxiliary work still counts as delegated inference."""
    if session_id and session_id in child_of:
        return "subagent"
    if task and task != "main":
        return "auxiliary"
    if session_id and session_id in known:
        return "direct"
    return "unattributed"


def build_analytics_report(
    event_db_path: Path | str | None = None, *,
    state_db_path: Path | str | None = None,
    days: int = 30, now: float | None = None, catalogue: Catalogue | None = None,
    model: str | None = None, provider: str | None = None,
    surface: str | None = None, task: str | None = None,
    parent: str | None = None, scope: str | None = None,
    pricing_mode: str = "strict", presentation: str = "both",
    profiles_path: Path | str | None = None,
) -> dict[str, Any]:
    """Aggregate only recorded calls in the local-calendar, half-open window."""
    now = time.time() if now is None else now
    days = max(1, min(int(days), 365))
    since, until, zone = _local_window(days, now)
    # Resolve each local midnight separately so DST offsets remain correct.
    local_start = datetime.fromtimestamp(now).replace(hour=0, minute=0, second=0, microsecond=0)
    local_start -= timedelta(days=days - 1)
    granularity = "hour" if days == 1 else "day"
    starts: list[float] = []
    if days == 1:
        cursor = since
        while cursor < until:
            starts.append(cursor)
            cursor += 3600
    else:
        day_cursor = local_start
        while day_cursor.timestamp() < until:
            starts.append(day_cursor.timestamp())
            day_cursor += timedelta(days=1)
    bucket_accs = {ts: _AnalyticsAcc() for ts in starts}

    prev_since = since - (until - since)
    conn = store.connect_reader(event_db_path)
    try:
        rows = store.query_calls(conn, since=since, until=until) if conn is not None else []
        prev_rows = store.query_calls(conn, since=prev_since, until=since) if conn is not None else []
        recording = store.recording_info(conn)
    finally:
        if conn is not None:
            conn.close()
    mode = pricing_mode if pricing_mode in ("strict", "third_party", "approximate") else "strict"
    allow_third_party = mode in ("third_party", "approximate")
    allow_approximate = mode == "approximate"
    book = catalogue if catalogue is not None else load_catalogue()
    statuses = route_billing_status(state_db_path)
    total_acc = _AnalyticsAcc()
    models: dict[tuple[str, str], _AnalyticsAcc] = {}
    routes: dict[str, _AnalyticsAcc] = {}
    option_models: set[tuple[str, str]] = set()
    surfaces: set[str] = set()
    tasks: set[str] = set()
    filters = {"model": model, "provider": provider, "surface": surface, "task": task}
    graph = _session_graph(state_db_path)
    child_of: dict[str, str] = graph["child_of"]
    known: set[str] = graph["known"]
    scope_accs: dict[str, _AnalyticsAcc] = {}
    results_kept: list[dict] = []
    operations: Counter = Counter()
    unattributed_calls = 0
    for raw in rows:
        row = _event_result(raw, book, "list", statuses,
                            allow_third_party=allow_third_party,
                            allow_approximate=allow_approximate, at=raw.get("ts"))
        option_models.add((row["model"], row["provider"]))
        surfaces.add(row["surface"])
        tasks.add(row["task"])
        session_id = row["_session_id"]
        row_scope = _scope_of(session_id, row["_task"], child_of, known)
        row["_scope"] = row_scope
        row["_root"] = _root_of(session_id, child_of) if session_id else ""
        if any(value is not None and row[key] != value for key, value in filters.items()):
            continue
        if parent and row["_root"] != parent:
            continue
        if scope and row_scope != scope:
            continue
        row["_economics"], row["_economics_gap"] = _call_economics(
            row, book, allow_third_party=allow_third_party, allow_approximate=allow_approximate)
        results_kept.append(row)
        total_acc.add(row)
        scope_accs.setdefault(row_scope, _AnalyticsAcc()).add(row)
        if row_scope == "unattributed":
            unattributed_calls += 1
        if row_scope == "subagent" and row["_root"]:
            operations[row["_root"]] += 1
        models.setdefault((row["model"], row["provider"]), _AnalyticsAcc()).add(row)
        routes.setdefault(row["provider"], _AnalyticsAcc()).add(row)
        bucket_ts = starts[bisect_right(starts, raw["ts"]) - 1]
        bucket_accs[bucket_ts].add(row)
    totals = total_acc.as_dict()
    # Previous equal-length window, same filters: only totals, for deltas.
    # It is a comparison baseline, never added to the current window.
    prev_acc = _AnalyticsAcc()
    for raw in prev_rows:
        prow = _event_result(raw, book, "list", statuses,
                             allow_third_party=allow_third_party,
                             allow_approximate=allow_approximate, at=raw.get("ts"))
        prow_scope = _scope_of(prow["_session_id"], prow["_task"], child_of, known)
        prow["_scope"] = prow_scope
        prow["_root"] = _root_of(prow["_session_id"], child_of) if prow["_session_id"] else ""
        if any(value is not None and prow[key] != value for key, value in filters.items()):
            continue
        if parent and prow["_root"] != parent:
            continue
        if scope and prow_scope != scope:
            continue
        prow["_economics"], prow["_economics_gap"] = _call_economics(
            prow, book, allow_third_party=allow_third_party, allow_approximate=allow_approximate)
        prev_acc.add(prow)
    prev_totals = prev_acc.as_dict()

    def _delta(key: str) -> float | None:
        before, now_value = prev_totals.get(key), totals.get(key)
        if not isinstance(before, (int, float)) or not before or not isinstance(now_value, (int, float)):
            return None
        return round((now_value - before) / before, 6)

    # A comparison is only fair when the whole previous window was observed:
    # it must start inside retention and after recording began (baseline_at
    # marks observation start; an old store without one is judged on
    # retention alone rather than hiding the comparison).
    observed_since = max(now - store.RETENTION_DAYS * 86_400, recording.get("baseline_at") or 0)
    comparable = bool(prev_totals.get("calls")) and prev_since >= observed_since
    deltas = {"list_usd": _delta("list_usd"), "tokens": _delta("tokens"),
              "calls": _delta("calls")} if comparable else {"list_usd": None, "tokens": None, "calls": None}
    previous = {
        "window": {"since": _iso(prev_since), "until": _iso(since), "days": days},
        "totals": prev_totals,
        "deltas": deltas,
        "comparable": comparable,
    }
    coverage: dict[str, int] = {}
    for row in results_kept:
        key = (row.get("pricing_provenance") or "unpriced") if row.get("list_usd") is not None else "unpriced"
        coverage[key] = coverage.get(key, 0) + (row.get("_tokens") or 0)
    covered = sum(coverage.values()) or 0
    official = coverage.get("official_verified", 0)
    route = coverage.get("models_dev_route", 0)
    estimated = coverage.get("third_party", 0) + coverage.get("approximate", 0)
    unpriced = coverage.get("unpriced", 0)
    pricing_coverage = {
        "tokens_by_provenance": coverage,
        "official_verified_tokens": official,
        "models_dev_route_tokens": route,
        "estimated_tokens": estimated,
        "unpriced_tokens": unpriced,
        "official_ratio": round(official / covered, 6) if covered else 0.0,
        "models_dev_ratio": round(route / covered, 6) if covered else 0.0,
        "estimated_ratio": round(estimated / covered, 6) if covered else 0.0,
        "unpriced_ratio": round(unpriced / covered, 6) if covered else 0.0,
        "coverage": round((covered - unpriced) / covered, 6) if covered else 0.0,
        "mode": mode,
        "official_ratio_scope": "token-weighted across observed calls in this window, not coverage of the provider catalogue",
        "note": ("models.dev exact provider/model/variant match is the primary published "
                 "API-equivalent basis. official_verified marks rates additionally checked "
                 "against the provider's own documentation; estimated covers the opt-in "
                 "third-party and cross-provider tiers. None of these is an invoice."),
    }
    billing_report = billing.classify(results_kept, billing.load_profiles(profiles_path), presentation)
    buckets = [{"ts": _iso(ts), "ts_local": datetime.fromtimestamp(ts).astimezone().isoformat(),
                **acc.as_dict()} for ts, acc in bucket_accs.items()]
    by_scope = [{"scope": name, **scope_accs[name].as_dict()}
                for name in SCOPES if name in scope_accs]
    return {
        "ok": True,
        "window": {"since": _iso(since), "until": _iso(until), "days": days,
                   "since_local": datetime.fromtimestamp(since).astimezone().isoformat(),
                   "until_local": datetime.fromtimestamp(until).astimezone().isoformat(),
                   "timezone": zone, "kind": "timestamped_calls"},
        "filters": {**filters, "parent": parent, "scope": scope},
        "attribution": {
            "method": "state.db sessions.parent_session_id (read-only), _delegate_from fallback",
            "child_sessions": len(child_of),
            "known_sessions": len(known),
            "unattributed_calls": unattributed_calls,
            "cycles": graph["cycles"],
            "operation_root": parent or None,
            "complete": unattributed_calls == 0 and graph["cycles"] == 0,
        },
        "by_scope": by_scope,
        "pricing_coverage": pricing_coverage,
        "valuation": {
            "settled_calls": sum(1 for r in results_kept if r.get("settled_usd") is not None),
            "estimated_calls": sum(1 for r in results_kept if r.get("settled_usd") is None),
            "note": ("settled_usd is the valuation captured with the call; list_usd is a "
                     "recalculated API-equivalent for the same tokens and may differ after a "
                     "catalogue change. They are never treated as the same number."),
        },
        "billing": billing_report,
        "pricing_source": {
            "source": book.source, "version": book.version, "as_of": book.as_of,
            "official_checks": len(getattr(book, "official", {}) or {}),
            "age_seconds": None,
            "stale": bool(book.confidence == "bundled"),
        },
        "options": {
            "models": [{"model": name, "provider": route} for name, route in sorted(option_models)],
            "providers": sorted({route for _, route in option_models}),
            "surfaces": sorted(surfaces), "tasks": sorted(tasks),
            "scopes": list(SCOPES),
            "operations": [{"parent": root, "subagent_calls": count}
                           for root, count in operations.most_common(25)],
        },
        "totals": totals,
        "previous": previous,
        "by_model": [{"model": name, "provider": route, **acc.as_dict()}
                     for (name, route), acc in sorted(models.items())],
        "by_route": [{"provider": route, **acc.as_dict()} for route, acc in sorted(routes.items())],
        "trend": {"granularity": granularity, "buckets": buckets},
        "economics": totals["economics"],
        "recording": {"since": _iso(recording["since"]), "last": _iso(recording["last"]),
                      "calls": recording["calls"]},
        "notes": [
            "Only timestamped calls in [since, until) are counted; no historical usage is inferred. Buckets follow local calendar boundaries and carry explicit UTC timestamps, including across DST.",
            "Options describe the unfiltered selected window; recording describes all retained calls, independent of filters. The collector retains calls for 180 days, so longer windows may be incomplete.",
            "Prices use the current catalogue, not historical invoices. Economics applies whole-context tiers per call, including tiers that decrease rates; list_usd preserves existing accounting tier/fallback semantics.",
            "Calls with provider errors or missing usage keep their tokens but are unpriced.",
            "Cache provenance is unknown for all-zero read/write buckets: old rows cannot distinguish missing fields from true zero. Only positive read/write calls enter the prompt-only cache-hit denominator; cache_coverage is known calls / all calls; cache_prompt_coverage uses prompt tokens.",
            "List USD preserves the existing accounting fallback for absent cache rates; strict economics excludes calls requiring those missing prices instead of treating the fallback as savings.",
            "Economics compares hypothetical uncached and cached list costs for the same covered calls, including output and cache-write premiums; savings may be negative. Coverage is covered tokens / all selected tokens.",
            "Billing mix is the latest route/model classification, not a per-call invoice. Only included routes have known $0 marginal billing.",
            "Previous totals cover the equal-length window immediately before this one under the same filters, for comparison only; deltas are omitted when that window has no recorded calls and it may predate recording.",
            *[f"Economics excluded {count} calls: {reason}."
              for reason, count in sorted(total_acc.economics_gaps.items())],
        ],
    }
