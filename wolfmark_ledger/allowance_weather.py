"""Allowance weather: pace and runway for known allowances.

Shows whether subscription allowances, credits and prepaid caps are being
consumed faster than the cycle they must last. Facts, provider readings and
estimates are kept apart:

* cycle position comes from billing-cycle date maths (always known);
* provider-reported percentages come from Hermes quota readings;
* consumption pace and projected exhaustion are computed ONLY for
  USD-denominated advanced cost rules, where the rule itself defines the
  valuation basis (its own rate override or catalogue list value).
  Provider credit pools are priced opaquely by the provider, so local
  API-equivalent value is never presented as their consumption.

Model rules (each has a regression test):

1. A rule pool's consumption is valued by :func:`billing.classify` under that
   rule, never re-derived here. Advanced-rule USD limits match that basis by
   construction; provider credit pools do not, so they show declared limits,
   provider readings and cycle position only — never a local used figure.
2. Ahead/behind compares two known numbers (consumed share vs elapsed share).
   A projected exhaustion date additionally needs an observed rate, so only
   rule pools with reliable coverage get one; provider windows never do.
3. A forecast needs every one of: recording started no later than the cycle
   start, reconciliation clean (no missed calls), at least one elapsed day,
   complete valuation of matched rows, and observed consumption above zero.
   Anything less yields an unavailable state with the reason stated.
   Incomplete recording coverage additionally withholds reassuring verdicts
   (behind/on-track) and exact remaining figures: observed consumption is
   then a lower bound, so only ahead/exhausted verdicts survive.
4. An old usage event alone proves nothing about continuity: without a
   baseline at or before the cycle start the forecast is unavailable.
5. Per-model limits and shared pools consume disjoint row sets, matching
   :func:`billing.classify` overage semantics. Prepaid wallets without a cap
   show observed spend only; the wallet balance is unknown and never guessed.
6. Manual exhaustion marks and provider conflicts flow through untouched: an
   active manual mark reads exhausted, a contradicted mark reads unknown.
7. Rule pools attach to the account that unambiguously serves the rule's
   route (see :func:`economics.attribute_routes`). Ambiguous or unclaimed
   routes stay unlinked and are never double-counted.
"""

from __future__ import annotations

import math
import time
from datetime import datetime, timezone
from typing import Any, Mapping, Optional

from . import billing
from . import economics
from . import membership as mem
from . import membership_api as members
from . import store as ustore
from .aggregate import _event_result, route_billing_status
from .pricing import Catalogue, load_catalogue

#: Consumed-vs-elapsed band that still counts as on track (fraction points).
PACE_TOLERANCE = 0.10

#: A pace needs at least a day of cycle behind it; anything less is noise.
MIN_FORECAST_ELAPSED_DAYS = 1.0

#: Kinds :func:`billing.classify` ignores as legacy membership copies.
LEGACY_KINDS = frozenset({"subscription_included", "subscription_credits", "free"})

VERDICTS = ("ahead", "on_track", "behind", "exhausted", "unknown")

#: Worst first: the rollup leads with the most attention-worthy state.
_ROLLUP_ORDER = {"exhausted": 0, "ahead": 1, "behind": 2, "on_track": 3, "unknown": 4}


def verdict(consumed: Any, elapsed: Any, *, lower_bound: bool = False) -> str:
    """Ahead/behind/on-track from two known shares, or ``"unknown"``.

    ``consumed`` is the share of the allowance gone, ``elapsed`` the share of
    its cycle gone. Non-numeric input is unknown, never zero. When ``consumed``
    is a lower bound (unvalued rows exist), only one-sided verdicts survive:
    observed exhaustion or an observed lead still hold for the true figure,
    while behind/on-track would need the missing rows to stay missing.
    """
    if (isinstance(consumed, bool) or not isinstance(consumed, (int, float))
            or not math.isfinite(consumed)):
        return "unknown"
    if (isinstance(elapsed, bool) or not isinstance(elapsed, (int, float))
            or not math.isfinite(elapsed)):
        return "unknown"
    if consumed >= 1.0:
        return "exhausted"
    gap = float(consumed) - float(elapsed)
    if gap > PACE_TOLERANCE:
        return "ahead"
    if lower_bound:
        return "unknown"
    if gap < -PACE_TOLERANCE:
        return "behind"
    return "on_track"


def _span(start_ts: float, end_ts: float, moment: float) -> dict[str, Any]:
    """Elapsed/remaining day counts for a UTC cycle span."""
    total_days = max(0.0, (end_ts - start_ts) / 86400.0)
    elapsed_days = min(max(0.0, (moment - start_ts) / 86400.0), total_days) if total_days else 0.0
    remaining_days = max(0.0, (end_ts - moment) / 86400.0)
    elapsed_fraction = round(elapsed_days / total_days, 6) if total_days else 0.0
    return {
        "elapsed_days": round(elapsed_days, 6),
        "total_days": round(total_days, 6),
        "days_remaining": round(remaining_days, 6),
        "days_remaining_display": max(0, math.ceil(remaining_days - 1e-9)),
        "elapsed_fraction": elapsed_fraction,
    }


def _cycle_span(cycle: Mapping[str, Any], moment: float) -> dict[str, Any]:
    start = mem._epoch(cycle.get("start")) or moment
    end = mem._epoch(cycle.get("end")) or moment
    return {
        "start": cycle.get("start"),
        "end": cycle.get("end"),
        "anchor_day": cycle.get("anchor_day"),
        **_span(start, end, moment),
        "start_ts": start,
        "end_ts": end,
    }


def _month_span(moment: float) -> dict[str, Any]:
    now_dt = datetime.fromtimestamp(moment, timezone.utc)
    start_dt, end_dt = economics._month_bounds(now_dt, 0)
    return {
        "start": start_dt.isoformat().replace("+00:00", "Z"),
        "end": end_dt.isoformat().replace("+00:00", "Z"),
        **_span(start_dt.timestamp(), end_dt.timestamp(), moment),
        "start_ts": start_dt.timestamp(),
        "end_ts": end_dt.timestamp(),
    }


def _profile_in_cycle(profile: Mapping[str, Any], start_ts: float, end_ts: float) -> bool:
    """Whether the rule's effective dates overlap the cycle at all."""
    start = mem._epoch(profile.get("effective_from"))
    end = mem._epoch(profile.get("effective_to"))
    if start is not None and start >= end_ts:
        return False
    if end is not None and end <= start_ts:
        return False
    return True


def _pool_consumption(rows: list[dict[str, Any]], profile: Mapping[str, Any],
                      scope: str = "profiles") -> dict[str, Any]:
    """Value pre-windowed rows under one rule via :func:`billing.classify`.

    The caller owns windowing (the report's cycle) and attribution (effective
    dates honoured per row); ``classify`` only values. Copies carry no
    ``last_seen`` so its wall-clock cycle check cannot second-guess the
    report window, and the singleton rule document keeps selection exact.
    """
    if scope == "defaults":
        solo: dict[str, Any] = {"profiles": [], "defaults": dict(profile)}
    else:
        solo = {"profiles": [dict(profile)], "defaults": {}}
    copies = [{**row, "last_seen": None} for row in rows]
    result = billing.classify(copies, solo)
    return {
        "used_usd": result.get("metered_usd", 0.0) or 0.0,
        "unvalued_tokens": result.get("unclassified_tokens", 0),
        "unvalued_calls": result.get("unclassified_calls", 0),
        "calls": sum(1 for row in rows),
    }


def _forecast(pool: dict[str, Any], *, baseline_at: Optional[float],
              recon: Mapping[str, Any], start_ts: float) -> dict[str, Any]:
    """Pace and projected exhaustion, or the reason they are unavailable."""
    notes: list[str] = []
    limit = pool.get("limit_usd")
    used = pool.get("used_usd", 0.0)
    elapsed_days = pool.get("elapsed_days", 0.0)
    if limit is None:
        return {"pace_usd_per_day": None, "projected_exhaustion": None,
                "forecast_status": "not_applicable", "notes": notes}
    if not pool.get("valued_complete"):
        notes.append("Some usage in this cycle has no value under this rule, "
                     "so the consumed figure is a lower bound and no forecast is made.")
        return {"pace_usd_per_day": None, "projected_exhaustion": None,
                "forecast_status": "unavailable", "notes": notes}
    if baseline_at is None or baseline_at > start_ts:
        notes.append("Recording started inside this cycle (or its start is unknown), "
                     "so the observed pace does not cover the whole cycle.")
        return {"pace_usd_per_day": None, "projected_exhaustion": None,
                "forecast_status": "unavailable", "notes": notes}
    status = recon.get("status")
    if status != "ok":
        if status == "gap":
            notes.append(f"About {recon.get('gap_tokens')} tokens since recording began "
                         "were missed, so the observed pace is unreliable.")
        elif status == "overcount":
            notes.append("More usage was captured than the backend reports, so the "
                         "observed pace may double-count.")
        elif status == "no_baseline":
            notes.append("No recording baseline exists, so coverage cannot be verified.")
        else:
            notes.append("Backend state is unavailable, so coverage cannot be verified "
                         "and no forecast is made.")
        return {"pace_usd_per_day": None, "projected_exhaustion": None,
                "forecast_status": "unavailable", "notes": notes}
    if elapsed_days < MIN_FORECAST_ELAPSED_DAYS:
        notes.append("The cycle started less than a day ago; too early for a pace.")
        return {"pace_usd_per_day": None, "projected_exhaustion": None,
                "forecast_status": "unavailable", "notes": notes}
    if not used or used <= 0:
        notes.append("No consumption observed in this cycle yet.")
        return {"pace_usd_per_day": None, "projected_exhaustion": None,
                "forecast_status": "unavailable", "notes": notes}
    if limit <= 0:
        notes.append("This allowance is zero, so any consumption exhausts it.")
        return {"pace_usd_per_day": round(used / elapsed_days, 6),
                "projected_exhaustion": None, "forecast_status": "unavailable",
                "notes": notes}
    pace = used / elapsed_days
    projected = start_ts + (limit / pace) * 86400.0
    notes.append("Linear projection from observed consumption; usage outside Hermes "
                 "would bring exhaustion sooner.")
    return {"pace_usd_per_day": round(pace, 6),
            "projected_exhaustion": mem._iso(projected),
            "forecast_status": "ok", "notes": notes}


def _pool_row(*, profile: Mapping[str, Any], scope: str, pool: str, label: str,
              rows: list[dict[str, Any]], limit_usd: Optional[float],
              cycle: dict[str, Any], span: dict[str, Any],
              baseline_at: Optional[float], recon: Mapping[str, Any]) -> dict[str, Any]:
    consumption = _pool_consumption(rows, profile, scope)
    used = round(consumption["used_usd"], 6)
    complete = not consumption["unvalued_tokens"] and not consumption["unvalued_calls"]
    # Pricing every recorded call does not account for missing calls: a pool
    # is only reliable when recording also covered the whole cycle cleanly.
    coverage_ok = (baseline_at is not None and baseline_at <= span["start_ts"]
                   and recon.get("status") == "ok")
    reliable = complete and coverage_ok
    if limit_usd is not None and limit_usd > 0 and reliable:
        consumed_fraction: Optional[float] = round(used / limit_usd, 6)
        remaining: Optional[float] = round(limit_usd - used, 6)
    elif limit_usd is not None and limit_usd <= 0:
        consumed_fraction = 1.0 if used > 0 else 0.0
        remaining = round(limit_usd - used, 6) if reliable else None
    elif limit_usd is not None:
        consumed_fraction = round(used / limit_usd, 6) if limit_usd > 0 else None
        remaining = None
    else:
        consumed_fraction = None
        remaining = None
    entry = {
        "profile_id": profile.get("id"),
        "label": label,
        "provider": profile.get("provider"),
        "scope": scope,
        "pool": pool,
        "kind": profile.get("kind"),
        "cycle": {k: cycle[k] for k in ("start", "end")},
        **{k: span[k] for k in ("elapsed_days", "total_days", "days_remaining",
                                "days_remaining_display", "elapsed_fraction")},
        "limit_usd": limit_usd,
        "used_usd": used,
        "remaining_usd": remaining,
        "consumed_fraction": consumed_fraction,
        "calls": consumption["calls"],
        "valued_complete": complete,
        "lower_bound": not reliable,
        "coverage": {
            "baseline_at": mem._iso(baseline_at),
            "baseline_covers_cycle": (baseline_at is not None
                                      and baseline_at <= span["start_ts"]),
            "reconciliation_status": recon.get("status"),
            "gap_tokens": recon.get("gap_tokens"),
        },
    }
    if not coverage_ok:
        notes = ["Recording coverage for this cycle is incomplete, so consumption "
                 "may be understated: reassuring verdicts and exact remaining "
                 "figures are withheld."]
    else:
        notes = []
    if limit_usd is None:
        entry["verdict"] = "unknown"
        entry["verdict_basis"] = "none"
        notes.append("Prepaid wallet: observed spend only — the wallet balance is "
                     "unknown because top-ups are not tracked.")
    else:
        entry["verdict"] = verdict(consumed_fraction, span["elapsed_fraction"],
                                   lower_bound=not reliable)
        entry["verdict_basis"] = ("observed_vs_calendar_lower_bound" if not reliable
                                  else "observed_vs_calendar")
        if not complete:
            notes.append(f"{consumption['unvalued_tokens']} tokens "
                         f"({consumption['unvalued_calls']} calls) in this cycle have no "
                         "value under this rule; the consumed figure is a lower bound.")
        if limit_usd <= 0:
            notes.append("This allowance is zero.")
    forecast = _forecast({**entry, "elapsed_days": span["elapsed_days"]},
                         baseline_at=baseline_at, recon=recon,
                         start_ts=span["start_ts"])
    entry["pace_usd_per_day"] = forecast["pace_usd_per_day"]
    entry["projected_exhaustion"] = forecast["projected_exhaustion"]
    entry["forecast_status"] = forecast["forecast_status"]
    entry["notes"] = [*notes, *forecast["notes"]]
    return entry


def _candidate_rules(profiles_doc: Mapping[str, Any]) -> tuple[list[dict[str, Any]], int]:
    """Rules with something to watch, plus the legacy-arrangement count."""
    rules: list[dict[str, Any]] = []
    legacy = 0
    seen: set[str] = set()
    for profile in profiles_doc.get("profiles") or []:
        if not isinstance(profile, dict):
            continue
        if profile.get("kind") in LEGACY_KINDS:
            legacy += 1
            continue
        pid = str(profile.get("id") or "")
        if not pid or pid in seen:
            continue
        seen.add(pid)
        allowances = profile.get("allowances") if isinstance(profile.get("allowances"), dict) else {}
        if allowances or profile.get("allowance_usd") is not None or profile.get("kind") == "prepaid":
            rules.append({**profile, "_scope": "profiles"})
    defaults = profiles_doc.get("defaults") or {}
    if isinstance(defaults, dict):
        if defaults.get("kind") in LEGACY_KINDS:
            legacy += 1
        elif defaults.get("kind") in billing.KINDS:
            allowances = defaults.get("allowances") if isinstance(defaults.get("allowances"), dict) else {}
            if allowances or defaults.get("allowance_usd") is not None:
                rules.append({**defaults, "id": defaults.get("id") or "defaults",
                              "provider": defaults.get("provider") or "(default)",
                              "_scope": "defaults"})
    return rules, legacy


def _window_limit_text(window_def: Mapping[str, Any] | None) -> dict[str, Any]:
    window_def = window_def or {}
    amount = window_def.get("amount")
    currency = window_def.get("currency")
    limit = window_def.get("limit")
    if isinstance(amount, (int, float)) and not isinstance(amount, bool):
        if currency:
            return {"kind": "amount", "amount": float(amount), "currency": currency,
                    "text": f"{amount} {currency}"}
        if limit == "credits":
            return {"kind": "credits", "amount": float(amount), "currency": None,
                    "text": f"{amount} credits"}
        return {"kind": "amount", "amount": float(amount), "currency": None,
                "text": str(amount)}
    if limit == "percent":
        return {"kind": "percent", "amount": None, "currency": None,
                "text": "percentage of provider limit"}
    if limit in ("credit_value_usd", "usd") and amount is None:
        return {"kind": "unknown", "amount": None, "currency": currency,
                "text": "credit limit unpublished"}
    if limit == "credits":
        return {"kind": "unknown", "amount": None, "currency": None,
                "text": "credit limit unpublished"}
    return {"kind": "unknown", "amount": None, "currency": None, "text": "limit unknown"}


def _window_entry(*, row: Mapping[str, Any], window_def: Mapping[str, Any] | None,
                  account_cycle: dict[str, Any], moment: float,
                  provider_age_seconds: Any = None) -> dict[str, Any]:
    kind = str((window_def or {}).get("kind") or "unknown")
    notes: list[str] = []
    if kind == "billing_cycle":
        cycle: Optional[dict[str, Any]] = account_cycle
        cycle_basis = "membership_cycle"
    elif kind in ("monthly", "monthly_credit"):
        cycle = _month_span(moment)
        cycle_basis = "calendar_month"
        notes.append("This allowance follows calendar months.")
    elif kind == "rolling":
        cycle = None
        cycle_basis = "none"
        duration = (window_def or {}).get("duration_minutes")
        if isinstance(duration, (int, float)):
            notes.append(f"Rolling window of {duration} minutes; its position is unknown, "
                         "so no pace verdict is made.")
        else:
            notes.append("Rolling window with unknown duration; no pace verdict is made.")
    else:
        cycle = None
        cycle_basis = "none"
        notes.append("No usable cycle is known for this allowance; no pace verdict is made.")
    bases = row.get("basis") or []
    used = row.get("used_percent")
    # A manual mark on a window the provider never quantified synthesises
    # 100% while retaining the provider basis; that is the owner's claim,
    # never provider evidence.
    provider_percent = (float(used) if "provider_reported" in bases
                        and row.get("used_percent_from") != "manual"
                        and isinstance(used, (int, float)) else None)
    manual = row.get("manual") if isinstance(row.get("manual"), dict) else None
    manual_status = (manual or {}).get("status")
    provider_reset = row.get("reset_at")
    provider_days = None
    if provider_reset:
        reset_ts = mem._epoch(provider_reset)
        if reset_ts is not None:
            provider_days = round(max(0.0, (reset_ts - moment) / 86400.0), 6)
    if row.get("conflict"):
        state = "unknown"
        basis = "conflicted"
        notes.append("Provider data disagrees with the manual mark; neither is trusted "
                     "for a verdict.")
    elif manual_status in ("active", "reconfirm_due"):
        state = "exhausted"
        basis = "manual"
        notes.append("Manually marked exhausted; never presented as provider-confirmed.")
        if provider_percent is not None:
            notes.append(f"The provider last reported {provider_percent:.0f}% used.")
    elif provider_percent is not None and provider_percent >= mem.EXHAUSTED_PERCENT:
        state = "exhausted"
        basis = "provider_reported"
    elif provider_percent is not None and cycle is not None:
        state = verdict(provider_percent / 100.0, cycle["elapsed_fraction"])
        basis = "provider_vs_calendar"
        notes.append("Verdict compares the provider-reported share with the elapsed "
                     "share of the cycle.")
        if row.get("state") == "stale":
            notes.append("The provider reading is stale; treat the verdict with caution.")
    elif provider_percent is not None:
        state = "unknown"
        basis = "provider_only"
        notes.append("Provider-reported share only; without a cycle position no "
                     "verdict is made.")
    else:
        state = "unknown"
        basis = "none"
        if kind in ("billing_cycle", "monthly", "monthly_credit"):
            notes.append("No provider reading and no manual mark; local usage is not "
                         "the provider's consumption, so no used figure is shown.")
    if manual_status == "reconfirm_due" and not row.get("conflict"):
        notes.append("Manual mark falls due for reconfirmation.")
    return {
        "id": row.get("id"),
        "label": row.get("label") or row.get("id"),
        "kind": kind,
        "scope": row.get("scope") or "account",
        "declared": _window_limit_text(window_def),
        "duration_minutes": (window_def or {}).get("duration_minutes"),
        "cycle": ({k: cycle[k] for k in ("start", "end", "elapsed_days", "total_days",
                                         "days_remaining", "days_remaining_display",
                                         "elapsed_fraction")} if cycle else None),
        "cycle_basis": cycle_basis,
        "provider": ({"used_percent": provider_percent, "reset_at": provider_reset,
                      "reset_in_days": provider_days, "state": row.get("state"),
                      "age_seconds": provider_age_seconds}
                     if provider_percent is not None else None),
        "manual": ({"status": manual_status,
                    "reconfirm_due_at": (manual or {}).get("reconfirm_due_at")}
                   if manual else None),
        "conflict": bool(row.get("conflict")),
        "verdict": state,
        "verdict_basis": basis,
        "projection": None,
        "notes": notes,
    }


def _rollup(states: list[str]) -> dict[str, str]:
    worst = min(states, key=lambda s: _ROLLUP_ORDER.get(s, 4)) if states else "unknown"
    return {"state": worst}


def build_weather_report(
    *, now: float | None = None,
    event_db_path=None, state_db_path=None, membership_path=None,
    plans: Mapping[str, Any] | None = None,
    profiles_path=None, catalogue: Catalogue | None = None,
    native: bool = False, native_snapshots: Mapping[str, Any] | None = None,
    home=None,
) -> dict[str, Any]:
    """Allowance weather for every stored account.

    Read-only across the call store, membership store and catalogues. Provider
    readings appear only when supplied (tests) or explicitly probed (``native``
    users the same Hermes read the memberships view uses).
    """
    moment = time.time() if now is None else float(now)
    if plans is None:
        plans = members.load_plans()
    cards = members.accounts_payload(
        native=native, path=membership_path, catalogue=plans, home=home, at=moment,
        native_snapshots=native_snapshots)["accounts"]
    profiles_doc = billing.load_profiles(profiles_path)
    rules, legacy_ignored = _candidate_rules(profiles_doc)
    book = catalogue if catalogue is not None else load_catalogue()

    conn = ustore.connect_reader(event_db_path)
    try:
        recording = ustore.recording_info(conn)
        recon = ustore.reconciliation(conn, state_db_path)
    finally:
        if conn is not None:
            conn.close()
    baseline_at = recording.get("baseline_at")
    baseline_at = float(baseline_at) if isinstance(baseline_at, (int, float)) else None

    statuses = route_billing_status(state_db_path)

    # One attribution pass links rules to accounts by route, exactly like the
    # economics usage attribution: unambiguous claims link, the rest stay out.
    mapping = economics.attribute_routes(
        cards, sorted({str(p.get("provider") or "") for p in rules if p.get("provider")}))
    owner_of: dict[str, str] = {}
    for aid, entry in mapping["by_account"].items():
        for item in entry.get("routes", []):
            owner_of.setdefault(str(item["route"]), str(aid))
    ambiguous = {str(route) for route in mapping.get("ambiguous", {})}

    # Price each rule's current cycle once; pools then split disjoint row sets.
    priced_cycles: dict[str, dict[str, Any]] = {}
    reader = ustore.connect_reader(event_db_path)
    try:
        for profile in rules:
            pid = str(profile.get("id"))
            if pid in priced_cycles:
                continue
            bounds = billing.cycle_bounds(profile, moment)
            start_ts = mem._epoch(bounds["start"]) or moment
            end_ts = mem._epoch(bounds["end"]) or moment
            span = {"start": bounds["start"], "end": bounds["end"],
                    **_span(start_ts, end_ts, moment),
                    "start_ts": start_ts, "end_ts": end_ts}
            raw = ustore.query_calls(reader, since=start_ts, until=end_ts) \
                if reader is not None else []
            priced = [_event_result(row, book, "list", statuses, at=row.get("ts"))
                      for row in raw]
            priced_cycles[pid] = {"profile": profile, "span": span, "rows": priced}
    finally:
        if reader is not None:
            reader.close()

    def pools_for(profile: Mapping[str, Any]) -> tuple[list[dict[str, Any]], list[str]]:
        pid = str(profile.get("id"))
        scope = str(profile.get("_scope") or "profiles")
        cached = priced_cycles[pid]
        span = cached["span"]
        notes: list[str] = []
        if not _profile_in_cycle(profile, span["start_ts"], span["end_ts"]):
            return [], [f"Rule {pid} is not in force in this cycle."]
        allowances = profile.get("allowances") \
            if isinstance(profile.get("allowances"), dict) else {}
        matched: list[dict[str, Any]] = []
        for row in cached["rows"]:
            selected, _ = billing.select(profiles_doc, row.get("provider", ""),
                                         row.get("model", ""),
                                         when=mem._epoch(row.get("last_seen")))
            if selected is not None and str(selected.get("id")) == pid:
                matched.append(row)
        out: list[dict[str, Any]] = []
        base_label = str(profile.get("label") or pid)
        for model, limit in sorted(allowances.items()):
            limit_value = float(limit) if isinstance(limit, (int, float)) else None
            model_rows = [row for row in matched if str(row.get("model")) == str(model)]
            out.append(_pool_row(profile=profile, scope=scope,
                                 pool=f"model:{model}", label=f"{base_label} · {model}",
                                 rows=model_rows, limit_usd=limit_value,
                                 cycle=cached["span"], span=span,
                                 baseline_at=baseline_at, recon=recon))
        shared_limit = profile.get("allowance_usd")
        if shared_limit is not None:
            shared_limit = float(shared_limit) \
                if isinstance(shared_limit, (int, float)) else None
            shared_rows = [row for row in matched
                           if str(row.get("model")) not in allowances]
            out.append(_pool_row(profile=profile, scope=scope, pool="shared",
                                 label=f"{base_label} · shared",
                                 rows=shared_rows, limit_usd=shared_limit,
                                 cycle=cached["span"], span=span,
                                 baseline_at=baseline_at, recon=recon))
        elif profile.get("kind") == "prepaid" and not allowances:
            out.append(_pool_row(profile=profile, scope=scope, pool="prepaid_spend",
                                 label=f"{base_label} · spend",
                                 rows=matched, limit_usd=None,
                                 cycle=cached["span"], span=span,
                                 baseline_at=baseline_at, recon=recon))
        return out, notes

    linked: dict[str, list[dict[str, Any]]] = {str(c.get("id")): [] for c in cards}
    unlinked: list[dict[str, Any]] = []
    deferred_notes: dict[str, list[str]] = {str(c.get("id")): [] for c in cards}
    for profile in rules:
        provider = str(profile.get("provider") or "")
        entries, skip_notes = pools_for(profile)
        if provider in ambiguous:
            for entry in entries:
                entry["notes"].append("This rule's route is claimed by more than one "
                                      "account; it is shown here once and linked to none.")
            unlinked.extend(entries)
            continue
        owner = owner_of.get(provider)
        if owner is None or owner not in linked:
            for entry in entries:
                entry["notes"].append("No account claims this rule's route; confirm the "
                                      "route's account in Memberships to link it.")
            unlinked.extend(entries)
            continue
        if skip_notes:
            deferred_notes[owner].extend(skip_notes)
        linked[owner].extend(entries)

    accounts_out: list[dict[str, Any]] = []
    for card in cards:
        aid = str(card.get("id"))
        account_cycle = _cycle_span(card.get("cycle") or {}, moment)
        window_defs = {str(w.get("id")): w
                       for w in ((card.get("plan") or {}).get("entitlements") or {}).get("windows", [])
                       if isinstance(w, dict)}
        quota = card.get("quota") or {}
        windows = [_window_entry(row=row, window_def=window_defs.get(str(row.get("id"))),
                                 account_cycle=account_cycle, moment=moment,
                                 provider_age_seconds=quota.get("age_seconds"))
                   for row in quota.get("windows", [])]
        states = [w["verdict"] for w in windows]
        states.extend(entry["verdict"] for entry in linked[aid])
        accounts_out.append({
            "account_id": aid,
            "label": card.get("label") or card.get("family"),
            "family": card.get("family"),
            "arrangement": card.get("effective_arrangement"),
            "cycle": {k: account_cycle[k] for k in ("start", "end", "anchor_day",
                                                    "elapsed_days", "total_days",
                                                    "days_remaining",
                                                    "days_remaining_display",
                                                    "elapsed_fraction")},
            "cycle_source": (card.get("cycle") or {}).get("source"),
            "rollup": _rollup(states),
            "windows": windows,
            "rules": sorted(linked[aid], key=lambda e: str(e.get("label"))),
            "notes": deferred_notes[aid],
        })
    accounts_out.sort(key=lambda a: (str(a.get("family") or ""), str(a.get("label") or "")))

    notes = [
        "Cycle position is calendar maths; provider shares are Hermes readings; "
        "pace and projected exhaustion cover only USD cost rules, where the rule "
        "defines the valuation.",
        "Local usage never stands in for provider consumption: provider pools show "
        "declared limits and readings, never a locally computed used figure.",
        "A forecast needs recording from the cycle start, clean reconciliation, a "
        "day elapsed, complete valuation and observed consumption.",
    ]
    if profiles_doc.get("error"):
        notes.append(f"Cost rules could not be read ({profiles_doc['error']}); "
                     "rule pace is unavailable.")
    if legacy_ignored:
        notes.append(f"{legacy_ignored} legacy subscription arrangement(s) are managed "
                     "in Memberships and excluded from rule pace.")

    return {
        "ok": True,
        "generated_at": mem._iso(moment),
        "native_probe": bool(native or native_snapshots is not None),
        "coverage": {
            "recording_since": mem._iso(recording.get("since")),
            "recording_last": mem._iso(recording.get("last")),
            "recorded_calls": recording.get("calls"),
            "baseline_at": mem._iso(baseline_at),
            "reconciliation": recon,
        },
        "accounts": accounts_out,
        "unlinked_rules": sorted(unlinked, key=lambda e: str(e.get("label"))),
        "rules_error": profiles_doc.get("error") or "",
        "legacy_ignored": legacy_ignored,
        "notes": notes,
    }
