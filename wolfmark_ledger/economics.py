"""Subscription economics: recurring fees vs API-equivalent usage value.

Compares what subscriptions cost (normalised to monthly equivalents) against
the API-equivalent value of recorded usage attributed to those subscriptions'
accounts. The headline figure is an *estimated value comparison*, never a cash
saving: API-equivalent value is a theoretical public price, not an invoice.

Model rules (each has a regression test):

1. Monthly-equivalent normalisation: a monthly fee counts in full, a quarterly
   fee contributes one third, an annual fee one twelfth, and a weekly fee is
   annualised at 52 weeks per year (``52 / 12`` per month, documented in
   :data:`WEEKS_PER_YEAR`).
2. Currencies are never combined without an explicit, dated, user-supplied FX
   rate. Converted totals always cite the rate, its date and its source.
3. Usage is attributed to accounts only through route evidence. A route served
   by exactly one account's ``route_slugs`` attributes to it; a route claimed
   by two accounts is ambiguous and reported separately; a route nobody claims
   is unattributed. Ambiguous and unattributed usage is never double-counted
   and never silently assigned.
4. API Only, prepaid and unconfirmed accounts are not subscriptions. Their
   usage is shown for context but never enters the headline comparison, so an
   API-only route cannot manufacture a subscription saving.
5. Unknown prices and missing usage are not zero. Unpriced tokens mark the
   affected comparison partial, with the priced coverage stated.
6. Fees resolve at a point in time (overrides carry effective dates), so the
   monthly trend prices each month with the fee that was in force then.
7. Renewal dates come from the billing-cycle anchor and the fee period. An
   annual or quarterly renewal also needs an anniversary month, taken from the
   owner's price start date when one is recorded; otherwise the amount is shown
   with the date honestly unknown.
8. The headline comparison covers one time window: subscription spending is
   allocated pro-rata to the reporting window (see :data:`MEAN_MONTH_DAYS`)
   and compared against usage recorded in that same window. Monthly
   equivalents stay visible alongside as the recurring-spending figure.
"""

from __future__ import annotations

import calendar
import json
import math
import os
import tempfile
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Mapping, Optional

from . import membership as mem
from . import membership_store as mstore
from . import store as ustore
from .aggregate import _event_result
from .analytics import build_analytics_report
from .pricing import Catalogue, load_catalogue

#: Weekly fees are annualised at 52 weeks per year, so one week of fee is
#: ``52 / 12`` of a monthly equivalent. A year is not exactly 52 weeks, but
#: weekly subscription prices are marketed per week and this keeps the
#: conversion stable and explainable; the factor is surfaced in the report.
WEEKS_PER_YEAR = 52
WEEKLY_MONTHLY_FACTOR = WEEKS_PER_YEAR / 12

#: Monthly-equivalent divisor per fee period. Weekly uses the annualised
#: factor above instead of a divisor.
PERIOD_DIVISORS = {"month": 1.0, "quarter": 3.0, "year": 12.0}

#: Mean Gregorian month in days. Windowed subscription expenditure is a
#: monthly equivalent multiplied by (window days / MEAN_MONTH_DAYS), so the
#: comparison always covers the same time window as the recorded usage.
MEAN_MONTH_DAYS = 365.2425 / 12


def allocate_to_window(monthly: Any, window_days: Any) -> Optional[float]:
    """Allocate a monthly-equivalent fee pro-rata to the reporting window.

    Returns ``None`` for unknown inputs or a non-positive window — an
    unallocatable fee is not a zero fee.
    """
    if isinstance(monthly, bool) or not isinstance(monthly, (int, float)):
        return None
    if isinstance(window_days, bool) or not isinstance(window_days, (int, float)):
        return None
    if not math.isfinite(monthly) or not math.isfinite(window_days):
        return None
    if window_days <= 0:
        return None
    return float(monthly) * float(window_days) / MEAN_MONTH_DAYS


def _split_window_expenditure(account: Mapping[str, Any], plans: Mapping[str, Any],
                              fx_by_currency: Mapping[str, Mapping[str, Any]],
                              window_since: float, window_until: float,
                              window_days: float) -> tuple | None:
    """Allocate spending across a window that spans a fee revision.

    Splits the window at override/custom-plan effective dates and allocates
    each part at the fee in force then, instead of applying today's fee
    throughout. Returns ``None`` when no revision boundary falls inside the
    window (the caller keeps its single-fee computation untouched);
    otherwise ``(native_amount, usd_amount, notes, gap)`` where ``gap`` is
    true when allocation is impossible — an unpriced part or a mid-window
    currency change — as distinct from an unknown window length.
    """
    if not window_days:
        return None
    revisions = [o for o in (account.get("fee_overrides") or []) if isinstance(o, dict)]
    custom = account.get("custom_plan")
    candidates = revisions + ([custom] if isinstance(custom, dict) else [])
    splits = set()
    for rev in candidates:
        for key in ("effective_from", "effective_to"):
            ts = mem._epoch(rev.get(key))
            if ts is not None and window_since < ts < window_until:
                splits.add(ts)
    if not splits:
        return None
    points = [window_since] + sorted(splits) + [window_until]
    total = window_until - window_since
    native_total = 0.0
    usd_total: float | None = 0.0
    native_currency = None
    first_key = None
    changed = False
    used_rates: dict[str, Mapping[str, Any]] = {}
    for start, end in zip(points, points[1:]):
        fee = mem.resolve_fee(account, plans, (start + end) / 2)
        effective = fee.get("effective") or {}
        monthly = monthly_equivalent(effective.get("amount"), effective.get("period"))
        currency = str(effective.get("currency") or "").upper() or None
        if monthly is None or currency is None:
            return None, None, ["The fee changed within the window and one part has "
                                "no known fee, so spending cannot be allocated."], True
        if native_currency is None:
            native_currency = currency
            first_key = (monthly, currency, effective.get("period"))
        elif currency != native_currency:
            return None, None, ["The fee currency changed within the window, so "
                                "spending cannot be allocated to it."], True
        if (monthly, currency, effective.get("period")) != first_key:
            changed = True
        share = window_days * (end - start) / total
        part = allocate_to_window(monthly, share)
        if part is None:
            return None, None, ["The fee changed within the window and one part has "
                                "no known fee, so spending cannot be allocated."], True
        native_total += part
        if currency == "USD":
            seg_usd: float | None = monthly
        else:
            rate = fx_by_currency.get(currency)
            if rate is None:
                seg_usd = None
            else:
                used_rates[currency] = rate
                seg_usd = round(monthly * rate["usd_per_unit"], 6)
        if seg_usd is None or usd_total is None:
            usd_total = None
        else:
            usd_part = allocate_to_window(seg_usd, share)
            usd_total = usd_total + usd_part if usd_part is not None else None
    notes = []
    if changed:
        days = ", ".join(datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%d")
                         for ts in sorted(splits))
        notes.append(f"Fee changed within the window (revisions effective {days}); "
                     "each part is allocated at the fee in force then.")
    for rate in used_rates.values():
        notes.append(f"Fee converted to USD using {fx_citation(rate)}.")
    return (round(native_total, 6),
            round(usd_total, 6) if usd_total is not None else None, notes, False)

#: Arrangements that count as subscriptions in the headline comparison. A
#: free-tier plan is a subscription with a real $0 fee; api_only, prepaid and
#: unconfirmed accounts are shown separately and never enter the difference.
SUBSCRIPTION_ARRANGEMENTS = ("subscription",)

FX_FILENAME = "fx-rates.json"


# ---------------------------------------------------------------------------
# Monthly-equivalent normalisation
# ---------------------------------------------------------------------------

def monthly_equivalent(amount: Any, period: Any) -> Optional[float]:
    """Normalise one recurring fee to its monthly equivalent.

    Returns ``None`` for a missing amount or an unknown period — never zero,
    because an unknown fee is not a free one.
    """
    if isinstance(amount, bool) or not isinstance(amount, (int, float)):
        return None
    if not math.isfinite(amount):
        return None
    key = str(period or "").strip().lower()
    if key == "week":
        return float(amount) * WEEKLY_MONTHLY_FACTOR
    divisor = PERIOD_DIVISORS.get(key)
    if divisor is None:
        return None
    return float(amount) / divisor


def monthly_factor_note() -> str:
    return (f"Monthly fees count in full; quarterly fees contribute one third; "
            f"annual fees one twelfth; weekly fees are annualised at "
            f"{WEEKS_PER_YEAR} weeks per year (x{WEEKLY_MONTHLY_FACTOR:.4f}).")


# ---------------------------------------------------------------------------
# Renewal dates: allocated cost vs actual cash
# ---------------------------------------------------------------------------

def _anchor_in(year: int, month: int, day: int) -> datetime:
    last = calendar.monthrange(year, month)[1]
    return datetime(year, month, min(max(1, day), last), tzinfo=timezone.utc)


def _step_month(year: int, month: int, step: int) -> tuple[int, int]:
    total = (year * 12 + (month - 1)) + step
    return total // 12, total % 12 + 1


def next_renewal(*, period: str, anchor_day: int = 1,
                 anniversary: Any = None, at: Any = None) -> dict[str, Any]:
    """The next actual cash payment date for a recurring fee.

    ``anniversary`` is the month a quarterly/annual cycle counts from (the
    owner's price start date). A monthly fee needs only the anchor day; longer
    periods without a known anniversary return the amount with ``date: None``
    rather than guessing a month.
    """
    moment = float(mem._now(at))
    now_dt = datetime.fromtimestamp(moment, timezone.utc)
    key = str(period or "").strip().lower()
    day = max(1, min(int(anchor_day or 1), 31))

    if key == "month":
        candidate = _anchor_in(now_dt.year, now_dt.month, day)
        if candidate.timestamp() <= moment:
            year, month = _step_month(now_dt.year, now_dt.month, 1)
            candidate = _anchor_in(year, month, day)
        return {"date": candidate.isoformat().replace("+00:00", "Z"),
                "date_known": True, "basis": "anchor_day",
                "note": f"Monthly renewal on day {candidate.day}."}

    if key == "week":
        start = mem._epoch(anniversary)
        if start is None:
            return {"date": None, "date_known": False, "basis": "unknown",
                    "note": "Weekly renewal: the weekday is not recorded, so the next date is unknown."}
        weekday = datetime.fromtimestamp(start, timezone.utc).weekday()
        days_ahead = (weekday - now_dt.weekday()) % 7
        candidate = (now_dt.replace(hour=0, minute=0, second=0, microsecond=0)
                     + timedelta(days=days_ahead if days_ahead else 7))
        return {"date": candidate.isoformat().replace("+00:00", "Z"),
                "date_known": True, "basis": "anniversary_weekday",
                "note": "Weekly renewal weekday inferred from the recorded price start date."}

    if key in ("quarter", "year"):
        start = mem._epoch(anniversary)
        if start is None:
            label = "Quarterly" if key == "quarter" else "Annual"
            return {"date": None, "date_known": False, "basis": "unknown",
                    "note": f"{label} renewal: no price start date is recorded, "
                            "so the renewal month is unknown."}
        step = 3 if key == "quarter" else 12
        origin = datetime.fromtimestamp(start, timezone.utc)
        year, month = origin.year, origin.month
        # Advance whole periods until the anchor is in the future.
        for _ in range(400):
            candidate = _anchor_in(year, month, day)
            if candidate.timestamp() > moment:
                return {"date": candidate.isoformat().replace("+00:00", "Z"),
                        "date_known": True, "basis": "anniversary",
                        "note": ("Renewal month inferred from the recorded price start date; "
                                 "confirm it against the provider's receipt.")}
            year, month = _step_month(year, month, step)
        return {"date": None, "date_known": False, "basis": "unknown",
                "note": "Renewal is too far in the future to schedule."}

    return {"date": None, "date_known": False, "basis": "unknown",
            "note": f"Unsupported fee period: {period or 'none'}."}


# ---------------------------------------------------------------------------
# Route -> account attribution
# ---------------------------------------------------------------------------

def attribute_routes(accounts: list[Mapping[str, Any]],
                     routes: list[str]) -> dict[str, Any]:
    """Attribute each observed route to at most one account.

    Evidence levels, strongest first:

    ``route``   the route slug appears in exactly one account's
                ``route_slugs`` (discovery evidence).
    ``family``  the route names a family that holds exactly one account and
                no account claims the route directly. Labelled, because a
                second credential for that family would make it ambiguous.
    ``ambiguous`` two or more accounts claim the route: reported separately,
                attributed to nobody, counted once.
    ``unattributed`` no account claims the route and the family is unknown
                or holds several accounts.
    """
    claims: dict[str, list[str]] = {}
    families: dict[str, list[str]] = {}
    for account in accounts:
        aid = str(account.get("id") or "")
        family = str(account.get("family") or "").strip().lower()
        if family:
            families.setdefault(family, []).append(aid)
        for slug in account.get("route_slugs") or []:
            key = str(slug or "").strip().lower()
            if key:
                claims.setdefault(key, []).append(aid)

    by_account: dict[str, dict[str, Any]] = {}
    ambiguous: dict[str, list[str]] = {}
    unattributed: list[str] = []
    for route in routes:
        key = str(route or "").strip().lower()
        if not key or key == "(unattributed)":
            if route not in unattributed:
                unattributed.append(route)
            continue
        direct = claims.get(key, [])
        if len(direct) >= 2:
            ambiguous[route] = list(direct)
            continue
        if len(direct) == 1:
            entry = by_account.setdefault(direct[0], {"routes": [], "basis": "route"})
            entry["routes"].append({"route": route, "basis": "route"})
            continue
        holders = families.get(key, [])
        if len(holders) == 1:
            entry = by_account.setdefault(holders[0], {"routes": [], "basis": "family"})
            entry["routes"].append({"route": route, "basis": "family"})
            continue
        if route not in unattributed:
            unattributed.append(route)

    for entry in by_account.values():
        seen: dict[str, str] = {}
        for item in entry["routes"]:
            # Direct evidence wins when a route somehow carries both.
            if item["route"] not in seen or item["basis"] == "route":
                seen[item["route"]] = item["basis"]
        entry["routes"] = [{"route": name, "basis": seen[name]} for name in sorted(seen)]
        bases = {item["basis"] for item in entry["routes"]}
        entry["basis"] = next(iter(bases)) if len(bases) == 1 else "mixed"
    return {"by_account": by_account, "ambiguous": ambiguous,
            "unattributed": sorted(unattributed)}


def attribution_note(basis: str) -> str:
    return {
        "route": "Usage matched by the account's recorded route slugs.",
        "family": ("Usage matched by provider family: this is the only account "
                   "for that family. Confirm the route belongs to this subscription."),
        "mixed": ("Usage matched by a mix of route and family evidence; "
                  "see the route list."),
    }.get(basis, "")


# ---------------------------------------------------------------------------
# User-supplied FX rates (the only conversion source)
# ---------------------------------------------------------------------------

def fx_path(data_dir: Path | str | None = None) -> Path:
    """Location of the FX file, next to the membership store."""
    if data_dir:
        return Path(data_dir) / FX_FILENAME
    return mstore.store_path().parent / FX_FILENAME


def fx_validation_errors(entries: Any) -> list[str]:
    """Field-level validation with short human messages."""
    errors: list[str] = []
    if not isinstance(entries, list):
        return ["rates must be a list"]
    seen: set[str] = set()
    for entry in entries:
        if not isinstance(entry, dict):
            errors.append("each rate must be an object")
            continue
        currency = str(entry.get("currency") or "").strip().upper()
        if currency not in mem.CURRENCIES:
            errors.append(f"unsupported currency: {currency or 'none'}")
        if currency in seen:
            errors.append(f"duplicate rate for {currency}")
        seen.add(currency)
        rate = entry.get("usd_per_unit")
        if isinstance(rate, bool) or not isinstance(rate, (int, float)) \
                or not math.isfinite(rate) or rate <= 0:
            errors.append(f"{currency or 'rate'}: usd_per_unit must be a positive number")
        if mem._epoch(entry.get("as_of")) is None:
            errors.append(f"{currency or 'rate'}: as_of must be a valid date")
        source = str(entry.get("source") or "").strip()
        if not source:
            errors.append(f"{currency or 'rate'}: source is required")
        elif len(source) > 120:
            errors.append(f"{currency or 'rate'}: source must be 120 characters or fewer")
    return errors


def load_fx(path: Path | str | None = None) -> dict[str, Any]:
    """Read the FX file. A missing file is simply "no rates"."""
    target = Path(path) if path else fx_path()
    empty = {"rates": [], "loaded": False, "error": "", "path": str(target)}
    if not target.exists():
        return empty
    try:
        data = json.loads(target.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError) as exc:
        return {**empty, "error": f"fx rates unreadable: {type(exc).__name__}"}
    if not isinstance(data, dict) or not isinstance(data.get("rates"), list):
        return {**empty, "error": "fx rates unreadable: the document must hold a rates list"}
    errors = fx_validation_errors(data["rates"])
    if errors:
        return {**empty, "error": "fx rates unreadable: " + "; ".join(errors[:3])}
    rates = [{"currency": str(r["currency"]).strip().upper(),
              "usd_per_unit": float(r["usd_per_unit"]),
              "as_of": r["as_of"], "source": str(r["source"]).strip()}
             for r in data["rates"]]
    return {"rates": rates, "loaded": True, "error": "", "path": str(target)}


def save_fx(entries: list[dict[str, Any]], path: Path | str | None = None) -> dict[str, Any]:
    """Replace the whole FX document atomically. Raises ValueError when invalid."""
    errors = fx_validation_errors(entries)
    if errors:
        raise ValueError("; ".join(errors))
    target = Path(path) if path else fx_path()
    payload = {"version": 1, "rates": [
        {"currency": str(e["currency"]).strip().upper(),
         "usd_per_unit": float(e["usd_per_unit"]),
         "as_of": e["as_of"], "source": str(e["source"]).strip()}
        for e in entries]}
    target.parent.mkdir(parents=True, exist_ok=True)
    handle = tempfile.NamedTemporaryFile("w", dir=target.parent, delete=False, suffix=".tmp")
    try:
        json.dump(payload, handle, indent=2, sort_keys=True)
        handle.flush()
        os.fsync(handle.fileno())
        handle.close()
        os.replace(handle.name, target)
    finally:
        if not handle.closed:
            handle.close()
    return {"rates": payload["rates"], "path": str(target)}


def fx_citation(rate: Mapping[str, Any]) -> str:
    return (f"{rate['currency']} at {rate['usd_per_unit']} USD per unit, "
            f"dated {rate['as_of']} ({rate['source']})")


# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------

def _fee_confidence(fee: Mapping[str, Any]) -> str:
    basis = fee.get("basis")
    if basis == "declared":
        return "declared"
    if basis == "custom":
        return "user_defined"
    if basis == "catalogue":
        status = ((fee.get("published") or {}).get("verification") or {}).get("status")
        return str(status or "unverified")
    return "unknown"


def _plan_for(account: Mapping[str, Any], plans: Mapping[str, Any]) -> Optional[dict[str, Any]]:
    plan_id = str(account.get("plan_id") or "").strip()
    if not plan_id:
        return None
    custom = mem.custom_plan_view(account)
    if custom and custom.get("id") == plan_id:
        return custom
    return mem.plan_index(plans).get(plan_id)


def _renewal_for(account: Mapping[str, Any], fee: Mapping[str, Any],
                 plan: Mapping[str, Any] | None, at: float) -> dict[str, Any]:
    effective = fee.get("effective") or {}
    period = str(effective.get("period") or "")
    cycle = effective.get("billing_cycle") or {}
    anchor = cycle.get("anchor_day")
    override = fee.get("override") or {}
    anniversary = override.get("effective_from")
    if anniversary is None and plan and plan.get("source") == "user_defined":
        anniversary = (plan.get("effective") or {}).get("effective_from")
    if anchor is None and anniversary is not None and period in ("quarter", "year", "week"):
        # No explicit cycle day: a longer period renews on its anniversary
        # (day or weekday), not on the 1st.
        start = mem._epoch(anniversary)
        if start is not None:
            anchor = datetime.fromtimestamp(start, timezone.utc).day
    anchor = anchor or 1
    renewal = next_renewal(period=period, anchor_day=anchor, anniversary=anniversary, at=at)
    return {"amount": effective.get("amount"), "currency": effective.get("currency"),
            "period": period or None, "anchor_day": anchor, **renewal}


def _sum_usage(entries: list[Mapping[str, Any]]) -> dict[str, Any]:
    tokens = sum(int(e.get("tokens") or 0) for e in entries)
    calls = sum(int(e.get("calls") or 0) for e in entries)
    priced = sum(int(e.get("priced_tokens") or 0) for e in entries)
    unpriced = sum(int(e.get("unpriced_tokens") or 0) for e in entries)
    values = [e.get("list_usd") for e in entries if e.get("list_usd") is not None]
    total = round(sum(values), 6) if values else None
    if not tokens and total is None:
        total = 0.0
    return {"list_usd": total, "tokens": tokens, "calls": calls,
            "priced_tokens": priced, "unpriced_tokens": unpriced,
            "coverage": round(priced / tokens, 6) if tokens else None}


def _month_bounds(now_dt: datetime, back: int) -> tuple[datetime, datetime]:
    year, month = _step_month(now_dt.year, now_dt.month, -back)
    start = datetime(year, month, 1, tzinfo=timezone.utc)
    end_year, end_month = _step_month(year, month, 1)
    return start, datetime(end_year, end_month, 1, tzinfo=timezone.utc)


def build_economics_report(
    *, days: int = 30, trend_months: int = 6, now: float | None = None,
    event_db_path: Path | str | None = None,
    state_db_path: Path | str | None = None,
    membership_path: Path | str | None = None,
    fx_file: Path | str | None = None,
    catalogue: Catalogue | None = None,
    plans: Mapping[str, Any] | None = None,
    profiles_path: Path | str | None = None,
) -> dict[str, Any]:
    """Subscription fees vs attributed API-equivalent usage for one window.

    All figures are derived read-only from the call store, the membership
    store and the catalogues. Nothing is written and nothing is converted
    without an explicit user-supplied FX rate.
    """
    moment = time.time() if now is None else float(now)
    days = max(1, min(int(days), 365))
    trend_months = max(0, min(int(trend_months), 6))
    book = catalogue if catalogue is not None else load_catalogue()
    if plans is None:
        from .membership_api import load_plans
        plans = load_plans()

    stored = mstore.load_store(membership_path)
    if stored.get("error"):
        raise mstore.StoreUnreadable(str(stored["error"]))
    accounts = stored.get("accounts", [])

    fx_doc = load_fx(fx_file)
    fx_by_currency = {r["currency"]: r for r in fx_doc.get("rates", [])}

    analytics = build_analytics_report(
        event_db_path, state_db_path=state_db_path, days=days, now=moment,
        catalogue=book, pricing_mode="strict", profiles_path=profiles_path)
    by_route = {str(r.get("provider") or ""): r for r in analytics.get("by_route", [])}
    mapping = attribute_routes(accounts, sorted(by_route))

    recording = analytics.get("recording") or {}
    window = analytics.get("window") or {}
    recording_since = mem._epoch(recording.get("since"))
    window_since = mem._epoch(window.get("since"))
    window_until = mem._epoch(window.get("until"))
    recording_covers_window = bool(
        recording_since is not None and window_since is not None
        and recording_since <= window_since)
    if window_since is not None and window_until is not None and window_until > window_since:
        window_days: float | None = round((window_until - window_since) / 86400, 6)
    else:
        window_days = None

    subscription_rows: list[dict[str, Any]] = []
    other_rows: list[dict[str, Any]] = []
    for account in accounts:
        aid = str(account.get("id") or "")
        arrangement = mem.billing_arrangement(account)
        plan = _plan_for(account, plans)
        fee = mem.resolve_fee(account, plans, moment)
        routes = mapping["by_account"].get(aid, {"routes": [], "basis": "route"})
        usage = _sum_usage([by_route[item["route"]] for item in routes["routes"]
                            if item["route"] in by_route])
        if arrangement not in SUBSCRIPTION_ARRANGEMENTS:
            other_rows.append({
                "account_id": aid, "label": account.get("label") or account.get("family"),
                "family": account.get("family"), "arrangement": arrangement,
                "plan_name": (plan or {}).get("name"),
                "usage": usage, "attribution": {**routes, "note": attribution_note(routes["basis"])},
                "difference_usd": None,
                "explanation": {
                    "api_only": "API Only: pay-as-you-go usage with no subscription to compare against.",
                    "prepaid": ("Prepaid credits: compare this usage against top-ups and wallet "
                                "balances, not against a recurring fee."),
                    "unconfirmed": ("Billing arrangement not confirmed: confirm whether this "
                                    "account is a subscription before comparing."),
                }.get(arrangement, "Not a subscription; excluded from the comparison."),
            })
            continue

        effective = fee.get("effective") or {}
        monthly = monthly_equivalent(effective.get("amount"), effective.get("period"))
        currency = str(effective.get("currency") or "").upper() or None
        renewal = _renewal_for(account, fee, plan, moment)
        notes: list[str] = []
        for line in fee.get("notes") or []:
            notes.append(str(line))

        rate = fx_by_currency.get(currency or "")
        fee_usd = None
        if monthly is not None and currency == "USD":
            fee_usd = monthly
        elif monthly is not None and rate is not None:
            fee_usd = round(monthly * rate["usd_per_unit"], 6)
            notes.append(f"Fee converted to USD using {fx_citation(rate)}.")
        window_gap = False
        if window_since is not None and window_until is not None and window_days is not None:
            split = _split_window_expenditure(account, plans, fx_by_currency,
                                              window_since, window_until, window_days)
        else:
            split = None
        if split is None:
            window_fee = allocate_to_window(monthly, window_days)
            window_fee = round(window_fee, 6) if window_fee is not None else None
            window_usd = allocate_to_window(fee_usd, window_days)
            window_usd = round(window_usd, 6) if window_usd is not None else None
        else:
            window_fee, window_usd, split_notes, window_gap = split
            # The current-fee conversion above may cite the same rate the
            # split segments used; identical citations appear only once.
            notes.extend(n for n in split_notes if n not in notes)

        usage_value = usage["list_usd"]
        difference = None
        if window_usd is not None and usage_value is not None:
            difference = round(usage_value - window_usd, 6)

        if monthly is None:
            status = "unavailable"
            notes.append("No fee is set for this subscription, so no comparison is possible.")
        elif window_gap:
            # The split allocator already explained itself in notes.
            status = "unavailable"
        elif window_fee is None:
            status = "unavailable"
            notes.append("The reporting window length is unknown, so spending cannot be "
                         "allocated to it for comparison.")
        elif usage_value is None:
            status = "unavailable"
            notes.append("Attributed usage has no published price, so no comparison is possible.")
        elif currency != "USD" and rate is None:
            status = "unavailable"
            notes.append(f"Fee is in {currency} and usage is valued in USD with no FX rate: "
                         "add a dated rate to compare.")
        elif (usage.get("unpriced_tokens") or 0) > 0:
            # The exact count, not the rounded ratio: coverage rounds to six
            # decimals, so a large account with one unpriced token reads 1.0.
            status = "partial"
            share = usage["coverage"] * 100 if usage["coverage"] is not None else 0.0
            if share < 100:
                notes.append(f"Only {share:.1f}% of attributed tokens are priced; "
                             "the value is a lower bound.")
            else:
                notes.append("Nearly all attributed tokens are priced; "
                             "the value is a lower bound.")
        elif not recording_covers_window:
            status = "partial"
            notes.append("Recording started inside this window, so usage is incomplete.")
        elif routes["basis"] in ("family", "mixed"):
            status = "partial"
            notes.append(attribution_note(routes["basis"]))
        else:
            status = "ok"
        if usage["tokens"] == 0 and monthly is not None and status == "ok":
            notes.append("No usage was observed for this subscription in this window.")

        subscription_rows.append({
            "account_id": aid, "label": account.get("label") or account.get("family"),
            "family": account.get("family"), "arrangement": arrangement,
            "plan_id": account.get("plan_id"), "plan_name": (plan or {}).get("name"),
            "fee": {"amount": effective.get("amount"), "currency": effective.get("currency"),
                    "period": effective.get("period"), "basis": fee.get("basis"),
                    "confidence": _fee_confidence(fee)},
            "monthly_equivalent": {"amount": monthly, "currency": currency},
            "monthly_equivalent_usd": fee_usd,
            "window_expenditure": {"amount": window_fee, "currency": currency},
            "window_expenditure_usd": window_usd,
            "fx": rate,
            "renewal": renewal,
            "usage": usage, "usage_basis": "API-equivalent list value (strict catalogue pricing)",
            "attribution": {**routes, "note": attribution_note(routes["basis"])},
            "difference_usd": difference,
            "status": status, "notes": notes,
        })

    subscription_rows.sort(key=lambda r: (r["family"] or "", r["label"] or ""))
    other_rows.sort(key=lambda r: (r["family"] or "", r["label"] or ""))

    # Per-currency groups: fees in one currency compare only with each other.
    groups: list[dict[str, Any]] = []
    by_currency: dict[str, list[dict[str, Any]]] = {}
    for row in subscription_rows:
        currency = (row["monthly_equivalent"] or {}).get("currency") or "unknown"
        by_currency.setdefault(currency, []).append(row)
    for currency in sorted(by_currency):
        rows = by_currency[currency]
        known = [r for r in rows if (r["monthly_equivalent"] or {}).get("amount") is not None]
        unknown = [r["account_id"] for r in rows if r not in known]
        fees = round(sum(r["monthly_equivalent"]["amount"] for r in known), 6)
        window_known = [r for r in known
                        if (r["window_expenditure"] or {}).get("amount") is not None]
        window_fees = round(sum(r["window_expenditure"]["amount"] for r in window_known), 6) \
            if len(window_known) == len(known) else None
        group_usage = [r["usage"]["list_usd"] for r in rows]
        if any(v is None for v in group_usage):
            usage_total = None
        else:
            usage_total = round(sum(group_usage), 6)
        rate = fx_by_currency.get(currency)
        differences = [r["difference_usd"] for r in known]
        if unknown or any(d is None for d in differences):
            difference: float | None = None
        else:
            difference = round(sum(differences), 6)  # type: ignore[arg-type]
        if currency == "unknown":
            status, note = "unavailable", "Fee currency is unknown."
        elif unknown:
            status, note = "unavailable", (f"{len(unknown)} subscription(s) have no fee; "
                                           "the group cannot be compared.")
        elif difference is None and currency != "USD" and rate is None:
            status, note = "unavailable", ("Fees are in {0} with no FX rate; add a dated rate "
                                           "to compare against USD-valued usage.").format(currency)
        elif difference is None:
            status, note = "unavailable", "Usage or fees are missing for this group."
        elif any(r["status"] == "partial" for r in known):
            status, note = "partial", "At least one account comparison is partial; see the rows."
        else:
            status, note = "ok", ""
        groups.append({
            "currency": currency, "monthly_fees": fees, "window_fees": window_fees,
            "fee_accounts": len(known),
            "unknown_fee_accounts": unknown, "usage_usd": usage_total,
            "difference_usd": difference, "converted": bool(rate) and currency != "USD",
            "fx": rate, "status": status, "notes": [note] if note else [],
        })

    headline_fees = [{"currency": g["currency"], "amount": g["monthly_fees"]}
                     for g in groups if g["currency"] != "unknown"]
    headline_window = [{"currency": g["currency"], "amount": g["window_fees"]}
                       for g in groups
                       if g["currency"] != "unknown" and g["window_fees"] is not None]
    headline_values = [r["usage"]["list_usd"] for r in subscription_rows]
    if not subscription_rows or any(v is None for v in headline_values):
        headline_usage = None
    else:
        headline_usage = round(sum(headline_values), 6)
    comparable = [r for r in subscription_rows
                  if (r["monthly_equivalent"] or {}).get("amount") is not None]
    unpriced = len(subscription_rows) - len(comparable)
    if not comparable:
        headline_status = "unavailable"
        headline_difference = None
        headline_notes = ["No subscription has a known fee; declare fees in Memberships."]
    elif unpriced:
        # An unknown fee is not a zero fee: the headline withholds the
        # combined difference rather than comparing a subset silently.
        headline_status = "unavailable"
        headline_difference = None
        headline_notes = [f"{unpriced} subscription(s) have no fee; "
                          "the headline cannot be compared."]
    elif any(r["difference_usd"] is None for r in comparable):
        headline_status = "unavailable"
        headline_difference = None
        headline_notes = ["At least one subscription cannot be compared "
                          "(missing price, coverage or FX rate); see the rows."]
    else:
        headline_difference = round(sum(r["difference_usd"] for r in comparable), 6)  # type: ignore[misc]
        if any(r["status"] == "partial" for r in comparable) or not recording_covers_window:
            headline_status = "partial"
            headline_notes = ["Estimated value comparison; at least one input is partial."]
        else:
            headline_status = "ok"
            headline_notes = ["Estimated value comparison of recorded usage against fees."]
    if fx_doc.get("error"):
        headline_notes.append(f"FX rates could not be read ({fx_doc['error']}); no conversion applied.")

    unattributed_usage = _sum_usage([by_route[r] for r in mapping["unattributed"] if r in by_route])
    ambiguous_usage = _sum_usage([by_route[r] for r in mapping["ambiguous"] if r in by_route])
    attributed_tokens = sum(r["usage"]["tokens"] for r in subscription_rows + other_rows)
    total_tokens = (analytics.get("totals") or {}).get("tokens") or 0

    trend = _build_trend(accounts, plans, book, moment, trend_months,
                         recording_since, event_db_path, fx_by_currency)

    return {
        "ok": True,
        "window": {**window, "kind": "timestamped_calls"},
        "window_days": window_days,
        "fees_basis": monthly_factor_note(),
        "headline": {
            "status": headline_status,
            "fees_monthly_by_currency": headline_fees,
            "fees_window_by_currency": headline_window,
            "usage_usd": headline_usage,
            "difference_usd": headline_difference,
            "difference_label": ("Estimated value comparison over the same window "
                                 "(API-equivalent value minus fees)"),
            "notes": headline_notes,
        },
        "groups": groups,
        "accounts": subscription_rows,
        "non_subscription_accounts": other_rows,
        "unattributed": {"routes": mapping["unattributed"], "usage": unattributed_usage,
                         "note": ("Usage on routes no account claims. Attribute it by confirming "
                                  "the route's account in Memberships.")},
        "ambiguous": {"routes": [{"route": route, "accounts": aids}
                                 for route, aids in sorted(mapping["ambiguous"].items())],
                      "usage": ambiguous_usage,
                      "note": ("Usage on routes claimed by more than one account. It is counted "
                               "once here and attributed to nobody.")},
        "trend": trend,
        "coverage": {
            "recording_since": recording.get("since"),
            "recording_covers_window": recording_covers_window,
            "pricing": analytics.get("pricing_coverage"),
            "attribution": {
                "attributed_tokens": attributed_tokens,
                "unattributed_tokens": unattributed_usage["tokens"],
                "ambiguous_tokens": ambiguous_usage["tokens"],
                "attributed_ratio": round(attributed_tokens / total_tokens, 6) if total_tokens else None,
            },
        },
        "fx": {"rates": fx_doc.get("rates", []), "error": fx_doc.get("error") or ""},
        "notes": [
            "Monthly equivalents normalise recurring fees to one month; actual cash payments follow the renewal schedule.",
            "API-equivalent value is a theoretical public price for recorded usage, not an invoice or a cash saving.",
            ("Subscription spending is allocated pro-rata to the reporting window above "
             f"({MEAN_MONTH_DAYS:.2f} days per mean month), so expenditure and usage cover "
             "the same time window. The monthly trend aligns both to calendar months."),
        ],
    }


def _build_trend(accounts: list[Mapping[str, Any]], plans: Mapping[str, Any],
                 book: Catalogue, moment: float, trend_months: int,
                 recording_since: float | None,
                 event_db_path: Path | str | None,
                 fx_by_currency: Mapping[str, Mapping[str, Any]]) -> dict[str, Any]:
    """Per-calendar-month fees vs usage, with partial-month flags.

    Attribution is rebuilt from the routes observed across the whole trend
    window: a route used in September but silent since still backs its
    September usage, independently of the headline's trailing window.
    """
    now_dt = datetime.fromtimestamp(moment, timezone.utc)
    months: list[dict[str, Any]] = []
    for back in range(trend_months):
        start_dt, end_dt = _month_bounds(now_dt, back)
        months.append({"month": start_dt.strftime("%Y-%m"),
                       "start": start_dt.isoformat().replace("+00:00", "Z"),
                       "end": end_dt.isoformat().replace("+00:00", "Z"),
                       "start_ts": start_dt.timestamp(), "end_ts": end_dt.timestamp()})
    months.reverse()

    usage_by_month: dict[str, dict[str, dict[str, Any]]] = {m["month"]: {} for m in months}
    if months:
        conn = ustore.connect_reader(event_db_path)
        try:
            rows = ustore.query_calls(conn, since=months[0]["start_ts"], until=moment) \
                if conn is not None else []
        finally:
            if conn is not None:
                conn.close()
        for raw in rows:
            priced = _event_result(raw, book, "list", {"exact": {}}, at=raw.get("ts"))
            month = datetime.fromtimestamp(raw["ts"], timezone.utc).strftime("%Y-%m")
            bucket = usage_by_month.get(month)
            if bucket is None:
                continue
            route = priced["provider"]
            entry = bucket.setdefault(route, {"list_usd": 0.0, "has_value": False, "tokens": 0,
                                              "calls": 0, "priced_tokens": 0, "unpriced_tokens": 0})
            entry["tokens"] += priced["_tokens"]
            entry["calls"] += 1
            if priced["list_usd"] is not None:
                entry["list_usd"] += priced["list_usd"]
                entry["has_value"] = True
                entry["priced_tokens"] += priced["_tokens"]
            else:
                entry["unpriced_tokens"] += priced["_tokens"]

    observed_routes = sorted({route for bucket in usage_by_month.values() for route in bucket})
    trend_mapping = attribute_routes(accounts, observed_routes)
    account_routes = {aid: [item["route"] for item in entry.get("routes", [])]
                      for aid, entry in trend_mapping["by_account"].items()}
    entries = []
    excluded_before_recording = 0
    for spec in months:
        midpoint = (spec["start_ts"] + spec["end_ts"]) / 2
        if recording_since is not None and spec["end_ts"] <= recording_since:
            excluded_before_recording += 1
            continue
        recording_partial = bool(recording_since is not None
                                 and spec["start_ts"] < recording_since < spec["end_ts"])
        in_progress = spec["start_ts"] <= moment < spec["end_ts"]
        fees_by_currency: dict[str, float] = {}
        unknown_fees = 0
        for account in accounts:
            if mem.billing_arrangement(account) not in SUBSCRIPTION_ARRANGEMENTS:
                continue
            fee = mem.resolve_fee(account, plans, midpoint)
            effective = fee.get("effective") or {}
            monthly = monthly_equivalent(effective.get("amount"), effective.get("period"))
            currency = str(effective.get("currency") or "").upper() or None
            if monthly is None or currency is None:
                unknown_fees += 1
                continue
            fees_by_currency[currency] = round(fees_by_currency.get(currency, 0.0) + monthly, 6)
        bucket = usage_by_month.get(spec["month"], {})
        usage_total = 0.0
        usage_calls = 0
        priced_tokens = 0
        total_tokens = 0
        has_unpriced = False
        for aid, routes in account_routes.items():
            account = next((a for a in accounts if str(a.get("id")) == aid), None)
            if account is None or mem.billing_arrangement(account) not in SUBSCRIPTION_ARRANGEMENTS:
                continue
            for route in routes:
                entry = bucket.get(route)
                if entry is None:
                    continue
                if entry["has_value"]:
                    usage_total += entry["list_usd"]
                if entry["unpriced_tokens"]:
                    has_unpriced = True
                usage_calls += entry["calls"]
                priced_tokens += entry["priced_tokens"]
                total_tokens += entry["tokens"]
        coverage = round(priced_tokens / total_tokens, 6) if total_tokens else None
        if total_tokens and not priced_tokens:
            # Observed but entirely unpriced: unknown value, never zero.
            usage_value: float | None = None
        else:
            usage_value = round(usage_total, 6)
        mixed_pricing = bool(total_tokens and priced_tokens and has_unpriced)
        if not fees_by_currency and not total_tokens and not unknown_fees:
            continue
        # A historical month converts only with a rate dated inside it; a
        # current-month rate must not rewrite what an earlier month was worth.
        # fees_usd is the converted fee total behind difference_usd, so the
        # client never has to sum mixed currencies itself.
        difference = None
        fees_usd: float | None = None
        difference_note = ""
        if unknown_fees:
            difference_note = f"{unknown_fees} subscription(s) have no fee for this month."
        elif usage_value is None:
            difference_note = "Usage in this month has no published price."
        elif len(fees_by_currency) == 1 and "USD" in fees_by_currency:
            fees_usd = fees_by_currency["USD"]
            difference = round(usage_value - fees_usd, 6)
        elif fees_by_currency:
            convertible = True
            converted = 0.0
            for currency, amount in fees_by_currency.items():
                if currency == "USD":
                    converted += amount
                    continue
                rate = fx_by_currency.get(currency)
                as_of = mem._epoch((rate or {}).get("as_of"))
                if rate is None or as_of is None \
                        or not (spec["start_ts"] <= as_of < spec["end_ts"]):
                    convertible = False
                    break
                converted += amount * rate["usd_per_unit"]
            if convertible:
                fees_usd = round(converted, 6)
                difference = round(usage_value - fees_usd, 6)
            else:
                difference_note = "Non-USD fees with no FX rate dated in this month."
        if difference is not None and mixed_pricing:
            difference_note = (f"Only {coverage * 100:.1f}% of this month's usage is priced; "
                               "the value is a lower bound.")
        entries.append({
            "month": spec["month"], "start": spec["start"], "end": spec["end"],
            "in_progress": in_progress, "recording_partial": recording_partial,
            "partial": mixed_pricing,
            "fees_by_currency": [{"currency": c, "amount": a}
                                 for c, a in sorted(fees_by_currency.items())],
            "fees_usd": fees_usd,
            "unknown_fee_accounts": unknown_fees,
            "usage_usd": usage_value, "usage_calls": usage_calls,
            "usage_coverage": coverage, "has_unpriced_usage": has_unpriced,
            "difference_usd": difference, "difference_note": difference_note,
        })
    return {"months": entries, "excluded_before_recording": excluded_before_recording,
            "note": ("Each month pairs the fee in force at mid-month with usage recorded "
                     "in that calendar month.")}
