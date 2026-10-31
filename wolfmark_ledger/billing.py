"""User-defined billing profiles and cost presentation.

A route's *accounting* is separate from its *price*. Hermes reports a billing
status per route (actual / estimated / included / unknown); this module layers a
user's own arrangement on top — subscription, credits, prepaid, free tier or a
custom contract — without touching the recorded call evidence.

Profiles live in ``billing-profiles.json`` under the plugin's data directory, so
they survive upgrades and never enter ``state.db``. No credentials are stored.

Shape::

    {
      "defaults": {"kind": "api"},
      "profiles": [
        {"id": "codex", "provider": "openai-codex", "kind": "subscription_included",
         "monthly_fee_usd": 20, "effective_from": "2026-10-01"},
        {"id": "cc", "provider": "commandcode", "kind": "subscription_credits",
         "monthly_fee_usd": 15, "included_credit_usd": 15,
         "count_credits_as_spend": false},
        {"id": "cc-sonnet", "provider": "commandcode", "model": "claude-sonnet-5",
         "kind": "custom", "rate_override": {"input": 0.9, "output": 4.5}}
      ]
    }
"""

from __future__ import annotations

from contextlib import contextmanager

import json
import math
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Optional

PRESENTATIONS = ("both", "spend", "api", "accounting")
_CREDIT_KINDS = {"subscription_credits", "prepaid", "free"}


def _nonnegative_number(value: Any) -> bool:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    try:
        return math.isfinite(value) and value >= 0
    except OverflowError:
        return False


def _normalise_legacy_allowances(profile: dict[str, Any]) -> None:
    allowances = profile.get("allowances")
    if not isinstance(allowances, dict):
        return
    for model, value in list(allowances.items()):
        if not isinstance(value, str):
            continue
        try:
            parsed = float(value)
        except (TypeError, ValueError, OverflowError):
            continue
        if _nonnegative_number(parsed):
            allowances[model] = parsed


def _allowance_errors(value: Any) -> list[str]:
    if value is None:
        return []
    if not isinstance(value, dict):
        return ["allowances must map model ids to finite non-negative numbers"]
    if any(not isinstance(model, str) or not model.strip() for model in value):
        return ["allowance model ids must be non-empty strings"]
    if any(not _nonnegative_number(amount) for amount in value.values()):
        return ["allowance values must be finite non-negative numbers"]
    return []


def profiles_path(data_dir: Optional[Path | str] = None) -> Path:
    if data_dir:
        return Path(data_dir) / "billing-profiles.json"
    try:
        from plugins.plugin_storage import plugin_data_dir

        return plugin_data_dir("wolfmark-cost-ledger") / "billing-profiles.json"
    except Exception:
        pass
    try:
        from hermes_constants import get_hermes_home

        base = Path(get_hermes_home())
    except Exception:
        import os

        base = Path(os.environ.get("HERMES_HOME") or Path.home() / ".hermes")
    return base / "plugin-data" / "wolfmark-cost-ledger" / "billing-profiles.json"


def load_profiles(path: Optional[Path | str] = None) -> dict[str, Any]:
    return _load_profiles(path, strict=False)


class ProfileStoreUnreadable(RuntimeError):
    pass
def _load_profiles(path: Optional[Path | str] = None, *, strict: bool) -> dict[str, Any]:
    target = Path(path) if path else profiles_path()
    empty = {"profiles": [], "defaults": {}, "loaded": False, "error": ""}
    if not target.exists():
        return empty
    try:
        raw = json.loads(target.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError) as exc:
        reason = f"billing profile store unreadable: {type(exc).__name__}"
        if strict:
            raise ProfileStoreUnreadable(reason) from exc
        return {**empty, "error": reason}

    # Older releases accepted string values inside the allowance mapping.
    # Normalise compatible values in memory before strict validation, without
    # rewriting the user's file during a read. New writes remain numeric-only.
    if isinstance(raw, dict):
        stored_profiles = raw.get("profiles")
        if isinstance(stored_profiles, list):
            for profile in stored_profiles:
                if isinstance(profile, dict):
                    _normalise_legacy_allowances(profile)
        defaults = raw.get("defaults")
        if isinstance(defaults, dict):
            _normalise_legacy_allowances(defaults)

    reason = ""
    if not isinstance(raw, dict):
        reason = "root must be an object"
    elif "profiles" not in raw or not isinstance(raw.get("profiles"), list):
        reason = "profiles must be a list"
    elif "defaults" in raw and not isinstance(raw["defaults"], dict):
        reason = "defaults must be an object"
    elif "version" in raw and (isinstance(raw["version"], bool) or raw["version"] != 1):
        reason = "version must be an integer"
    else:
        for profile in raw["profiles"]:
            if (not isinstance(profile, dict) or not str(profile.get("id") or "").strip()
                    or not str(profile.get("provider") or "").strip()
                    or str(profile.get("kind") or "") not in KINDS):
                reason = "profiles contains an incomplete record"
                break
            if any(key in profile and profile[key] is not None and not isinstance(profile[key], dict)
                   for key in ("allowances", "billing_cycle", "rate_override")):
                reason = "profiles contains malformed nested settings"
                break
            if _allowance_errors(profile.get("allowances")):
                reason = "profiles contains invalid allowance values"
                break
        if not reason:
            defaults = raw.get("defaults") or {}
            if isinstance(defaults, dict):
                if _allowance_errors(defaults.get("allowances")):
                    reason = "defaults contains invalid allowance values"
                elif (defaults.get("allowance_usd") is not None
                      and not _nonnegative_number(defaults.get("allowance_usd"))):
                    reason = "defaults contains an invalid allowance_usd value"
    if reason:
        message = f"billing profile store unreadable: {reason}"
        if strict:
            raise ProfileStoreUnreadable(message)
        return {**empty, "error": message}

    profiles = list(raw["profiles"])
    defaults = raw.get("defaults") or {}
    return {"profiles": profiles, "defaults": defaults, "version": raw.get("version", 1),
            "loaded": True, "error": ""}


def _epoch(value: Any) -> Optional[float]:
    if value in (None, ""):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def _active(profile: dict[str, Any], when: Optional[float]) -> bool:
    start, end = _epoch(profile.get("effective_from")), _epoch(profile.get("effective_to"))
    if when is None:
        return True
    if start is not None and when < start:
        return False
    if end is not None and when > end:
        return False
    return True


def select(profiles: dict[str, Any], provider: str, model: str,
           when: Optional[float] = None) -> tuple[Optional[dict[str, Any]], str]:
    """Precedence: route+model, then provider, then defaults, then Hermes status.

    Returns ``(profile, source)`` where source is one of route / provider /
    defaults / hermes / unknown.
    """
    route = str(provider or "")
    candidates = [p for p in profiles.get("profiles") or [] if str(p.get("provider")) == route]
    candidates = [p for p in candidates if _active(p, when)]
    def specificity(profile):
        exact_model = 1 if profile.get("model") and str(profile["model"]) == str(model) else 0
        account = 1 if profile.get("account") and str(profile["account"]) == str((profiles.get("row_account") or "")) else 0
        eff = _epoch(profile.get("effective_from")) or 0.0
        return (exact_model, account, eff, str(profile.get("id") or ""))

    # A model-specific arrangement always beats a provider-wide one; ties are
    # broken by the most recent effective date and then by id, so two plans on
    # the same provider can never resolve by dictionary order.
    ranked = sorted(candidates, key=specificity, reverse=True)
    for profile in ranked:
        if profile.get("model") and str(profile["model"]) == str(model):
            return profile, "route"
    # A provider-wide arrangement still applies to models it does not name.
    for profile in ranked:
        if not profile.get("model"):
            return profile, "provider"
    # A plan scoped to another model must never price this one; fall through to
    # any global defaults instead.

    defaults = profiles.get("defaults") or {}
    if defaults.get("kind") in KINDS:
        return {**defaults, "id": defaults.get("id") or "defaults"}, "defaults"
    return None, "unknown"


def _rate_override(profile: dict[str, Any], row: dict[str, Any]) -> Optional[float]:
    override = profile.get("rate_override") if isinstance(profile.get("rate_override"), dict) else None
    if not override:
        return None

    def num(key: str) -> Optional[float]:
        value = override.get(key)
        return float(value) if isinstance(value, (int, float)) else None

    inp, out = num("input"), num("output")
    if inp is None or out is None:
        return None
    cache_in = num("cache_read")
    cache_in = inp if cache_in is None else cache_in
    cache_write = num("cache_write")
    cache_write = inp if cache_write is None else cache_write
    tokens = row.get("_tokens") or 0
    return (
        row.get("_input", 0) * inp
        + row.get("_output", 0) * out
        + row.get("_cache_read", 0) * cache_in
        + row.get("_cache_write", 0) * cache_write
    ) / 1_000_000 if tokens else None


def _cumulative_overage(usage_by_rule, profiles):
    total = 0.0
    rules = [("profiles", profile) for profile in profiles.get("profiles") or []]
    defaults = profiles.get("defaults")
    if isinstance(defaults, dict) and defaults.get("kind") in KINDS:
        rules.append(("defaults", {**defaults, "id": defaults.get("id") or "defaults"}))

    for scope, profile in rules:
        if not profile.get("overage_paid"):
            continue
        rule_id = str(profile.get("id") or ("defaults" if scope == "defaults" else ""))
        model_limits = profile.get("allowances") or {}
        shared_limit = profile.get("allowance_usd")
        has_shared_limit = shared_limit is not None
        shared = 0.0
        for (usage_scope, pid, model), used in usage_by_rule.items():
            if usage_scope != scope or pid != rule_id:
                continue
            if model in model_limits:
                total += max(0.0, used - float(model_limits[model]))
            elif has_shared_limit:
                shared += used
            elif profile.get("kind") == "prepaid":
                total += used
        if has_shared_limit:
            total += max(0.0, shared - float(shared_limit))
    return total


def _allowance_report(usage_by_model, allowance_meta, profiles):
    """Cumulative, per-model allowances over the billing cycle.

    A per-model limit is never treated as an unrestricted shared pool, and an
    overage is inferred from the profile, not confirmed by the provider.
    """
    out = {}
    for profile_id, allowances in allowance_meta.items():
        profile = next((p for p in profiles if str(p.get("id")) == profile_id), None) or {}
        bounds = cycle_bounds(profile, None)
        rows = {}
        for (pid, model), used in usage_by_model.items():
            if pid != profile_id:
                continue
            allowance = float(allowances.get(model) or 0.0)
            overage = max(0.0, used - allowance) if profile.get("overage_paid") else 0.0
            rows[model] = {"allowance_usd": allowance, "used_usd": round(used, 6),
                           "overage_usd": round(overage, 6), "basis": "inferred",
                           "shared_pool": False}
        out[profile_id] = {"models": rows, "cycle": bounds, "basis": "inferred"}
    return out


def classify(rows: Iterable[dict[str, Any]], profiles: dict[str, Any],
             presentation: str = "both") -> dict[str, Any]:
    """Split API-equivalent value from metered, incremental and fee figures."""
    mode = presentation if presentation in PRESENTATIONS else "both"
    legacy_profiles = list((profiles or {}).get("profiles") or [])
    ignored_legacy = [p for p in legacy_profiles if p.get("kind") in {
        "subscription_included", "subscription_credits", "free"
    }]
    profiles = {
        **(profiles or {}),
        "profiles": [p for p in legacy_profiles if p not in ignored_legacy],
        "defaults": (profiles or {}).get("defaults") or {},
    }
    if profiles["defaults"].get("kind") in {"subscription_included", "subscription_credits", "free"}:
        profiles["defaults"] = {}
    by_kind: dict[str, dict[str, float]] = {}
    fees: dict[str, float] = {}
    unclassified_tokens = 0
    unclassified_calls = 0
    applied: dict[str, int] = {}
    total_api = metered = incremental = credits = 0.0
    confirmed_total = 0.0
    confirmed_calls = 0
    api_priced = 0
    unknown_seen = False
    seen_calls: set[str] = set()
    _defaults = profiles.get("defaults") or {}
    profile_configured = bool(profiles.get("profiles")) or (
        isinstance(_defaults, dict) and _defaults.get("kind") in KINDS)
    excluded_out_of_cycle = 0
    usage_by_model: dict[tuple[str, str], float] = {}
    usage_by_rule: dict[tuple[str, str, str], float] = {}
    allowance_meta: dict[str, dict] = {}

    for row in rows:
        cid = row.get("call_id") or row.get("id")
        if cid:
            if cid in seen_calls:
                continue
            seen_calls.add(cid)
        value = row.get("list_usd")
        provider_cost = row.get("_provider_cost_usd")
        when = _epoch(row.get("last_seen"))
        profile, source = select(profiles, row.get("provider", ""), row.get("model", ""), when)
        if profile and profile.get("billing_cycle") and when is not None:
            bounds = cycle_bounds(profile, None)  # the current cycle, not the row's own month
            start = _epoch(bounds["start"]); end = _epoch(bounds["end"])
            if start is not None and end is not None and not (start <= when < end):
                excluded_out_of_cycle += 1
                continue
        ineligible_call = (row.get("_failure") or row.get("_missing")
                           or row.get("outcome") in {"failed", "error", "call_failed",
                                                      "missing_usage", "usage_missing"})
        override = (_rate_override(profile, row)
                    if profile and profile.get("kind") == "custom" and not ineligible_call else None)
        if value is None and provider_cost is None and override is None:
            unclassified_tokens += row.get("_tokens") or 0
            unclassified_calls += 1
            continue
        # Provider-reported use value is evidence in its own right, even when the
        # published catalogue cannot price the row.
        metered_evidence = float(provider_cost) if isinstance(provider_cost, (int, float)) else None
        api = float(override) if override is not None else (float(value) if value is not None else None)
        api_arith = 0.0 if api is None else float(api)
        if api is not None:
            api_priced += 1
        kind = (profile or {}).get("kind") or "unknown"
        if kind not in KINDS:
            kind = "unknown"
        # Credits/included plans consume allowance; they are not extra cash.
        allowance = 0.0
        if profile:
            allowances = profile.get("allowances") if isinstance(profile.get("allowances"), dict) else {}
            if row.get("model") in allowances and isinstance(allowances[row["model"]], (int, float)):
                allowance = float(allowances[row["model"]])
            elif isinstance(profile.get("allowance_usd"), (int, float)):
                allowance = float(profile["allowance_usd"])
        if metered_evidence is not None:
            # Metered usage value is the provider's own figure; API-equivalent
            # stays a separate theoretical number (when the catalogue has one).
            confirmed_total += metered_evidence
            confirmed_calls += 1
            metered_row = metered_evidence
            credit_row = metered_evidence if kind in _CREDIT_KINDS or kind == "subscription_included" else 0.0
            if kind == "unknown":
                unknown_seen = True
                incremental_row = 0.0
            else:
                billable = max(0.0, metered_evidence - allowance)
                incremental_row = billable if (kind == "api" or (profile or {}).get("overage_paid")) else 0.0
        elif kind in ("subscription_included", "free"):
            metered_row, incremental_row, credit_row = api_arith, 0.0, api_arith
        elif kind in _CREDIT_KINDS:
            metered_row, incremental_row, credit_row = api_arith, 0.0, api_arith
            if (profile or {}).get("count_credits_as_spend"):
                incremental_row = 0.0  # explicit user view; reported separately
        elif kind == "custom":
            metered_row, incremental_row, credit_row = api_arith, api_arith, 0.0
        else:
            metered_row, credit_row = api_arith, 0.0
            if kind == "unknown":
                unknown_seen = True
                incremental_row = 0.0
            else:
                incremental_row = api_arith

        model_allowances = (profile or {}).get("allowances")
        model_allowances = model_allowances if isinstance(model_allowances, dict) else {}
        cumulative_scope = bool(profile and profile.get("overage_paid") and (
            profile.get("kind") == "prepaid" or row.get("model") in model_allowances
            or profile.get("allowance_usd") is not None))
        if cumulative_scope:
            incremental_row = 0.0  # cumulative over the cycle, applied after the loop
        key = (str(profile.get("id") if profile else "none"), str(row.get("model")))
        usage_by_model[key] = usage_by_model.get(key, 0.0) + (metered_row or 0.0)
        if profile:
            rule_scope = "defaults" if source == "defaults" else "profiles"
            rule_id = str(profile.get("id") or ("defaults" if rule_scope == "defaults" else ""))
            rule_key = (rule_scope, rule_id, str(row.get("model")))
            usage_by_rule[rule_key] = usage_by_rule.get(rule_key, 0.0) + (metered_row or 0.0)
        if profile and isinstance(profile.get("allowances"), dict):
            allowance_meta[str(profile.get("id"))] = profile["allowances"]
        total_api += api_arith
        metered += metered_row
        incremental += incremental_row
        credits += credit_row
        bucket = by_kind.setdefault(kind, {"api_equivalent_usd": 0.0, "metered_usd": 0.0,
                                           "incremental_usd": 0.0, "credits_usd": 0.0,
                                           "tokens": 0, "calls": 0})
        bucket["api_equivalent_usd"] += api_arith
        bucket["metered_usd"] += metered_row
        bucket["incremental_usd"] += incremental_row
        bucket["credits_usd"] += credit_row
        bucket["tokens"] += row.get("_tokens") or 0
        bucket["calls"] += 1
        label = f"{source}:{(profile or {}).get('id', 'hermes')}"
        applied[label] = applied.get(label, 0) + 1


    final_incremental = round(incremental + _cumulative_overage(usage_by_rule, profiles), 6)
    final_api = round(total_api, 6) if api_priced else None

    for bucket in by_kind.values():
        for key in ("api_equivalent_usd", "metered_usd", "incremental_usd", "credits_usd"):
            bucket[key] = round(bucket[key], 6)

    return {
        "presentation": mode,
        "profiles_loaded": bool(profiles.get("loaded")),
        "profiles_error": profiles.get("error") or "",
        "api_equivalent_usd": final_api,
        "metered_usd": round(metered, 6),
        "incremental_usd": final_incremental,
        "credits_consumed_usd": round(credits, 6),
        "subscription_fees_usd": round(sum(fees.values()), 6),
        "fees_by_profile": {k: round(v, 2) for k, v in sorted(fees.items())},
        "legacy_membership_arrangements_ignored": len(ignored_legacy),
        "by_kind": by_kind,
        "applied": applied,
        "unclassified_tokens": unclassified_tokens,
        "unclassified_calls": unclassified_calls,
        "excluded_out_of_cycle": excluded_out_of_cycle,
        "cycle_basis": "per-profile billing cycle, not the reporting window",
        "allowances": _allowance_report(usage_by_model, allowance_meta, profiles.get("profiles") or []),
        "evidence": {
            "provider_reported": {"usd": round(confirmed_total, 6) if confirmed_calls else None,
                                  "basis": "confirmed" if confirmed_calls else "none",
                                  "calls": confirmed_calls,
                                  "source": "provider request history" if confirmed_calls
                                            else "no provider-reported charge recorded for these calls"},
            "api_equivalent": {"usd": final_api,
                               "basis": "estimated" if final_api is not None else "unpriced",
                               "source": "published catalogue / official overlay" if final_api is not None
                                         else "no published rate for these calls"},
            "credits_consumed": {"usd": round(credits, 6) if profile_configured and credits else None,
                                 "basis": "inferred" if credits else "none",
                                 "source": "profile membership assumption, not provider-confirmed deduction"},
            "incremental_cash": {"usd": final_incremental if profile_configured else None,
                                 "basis": ("inferred" if final_incremental else
                                           ("unknown" if unknown_seen else "none")),
                                 "source": "profile allowance/overage assumption, not provider-confirmed"},
            "subscription_fee": {"usd": round(sum(fees.values()), 6) if fees else None,
                                 "basis": "profile" if fees else "none",
                                 "source": "user-declared membership"},
        },
        "provider_reported_usd": round(confirmed_total, 6),
        "notes": [
            "API-equivalent is a theoretical public price, not an invoice.",
            "Metered value is allowance consumed; incremental is extra cash beyond it.",
            "Subscription fees come from Memberships; legacy billing-profile copies are excluded.",
            "Credits marked count_credits_as_spend are a user view, not a provider charge.",
        ],
    }


def cycle_bounds(profile: dict | None, at: float | None) -> dict:
    """Monthly cycle anchored on the profile's billing day (UTC).

    The anchor is clamped to the month length, so a day-31 cycle still works in
    February. The previous boundary is that anchor in the previous calendar
    month — never "the first of this month", which skipped a whole cycle.
    """
    import calendar, datetime as _dt
    profile = profile or {}
    cfg = profile.get("billing_cycle") if isinstance(profile.get("billing_cycle"), dict) else {}
    day = max(1, min(int(cfg.get("day") or 1), 31))
    moment = _dt.datetime.fromtimestamp(at, _dt.timezone.utc) if at else _dt.datetime.now(_dt.timezone.utc)

    def anchor(year: int, month: int) -> _dt.datetime:
        last = calendar.monthrange(year, month)[1]
        return _dt.datetime(year, month, min(day, last), tzinfo=_dt.timezone.utc)

    start = anchor(moment.year, moment.month)
    if moment < start:
        start = anchor(moment.year - 1, 12) if moment.month == 1 else anchor(moment.year, moment.month - 1)
    nxt = anchor(start.year + 1, 1) if start.month == 12 else anchor(start.year, start.month + 1)
    return {"start": start.isoformat(), "end": nxt.isoformat(), "basis": "profile"}


PROFILE_FIELDS = {"id", "provider", "model", "kind", "monthly_fee_usd", "allowances",
                  "allowance_usd", "overage_paid", "count_credits_as_spend", "currency",
                  "effective_from", "effective_to", "billing_cycle", "rate_override", "label", "account"}
KINDS = ("subscription_included", "subscription_credits", "prepaid", "api", "custom", "free", "unknown")


def validation_errors(profile: dict) -> list[str]:
    errors = []
    if not isinstance(profile, dict):
        return ["profile must be an object"]
    unknown = set(profile) - PROFILE_FIELDS
    if unknown:
        errors.append(f"unknown fields: {', '.join(sorted(unknown))}")
    if not str(profile.get("id") or "").strip():
        errors.append("id is required")
    if not str(profile.get("provider") or "").strip():
        errors.append("provider is required")
    for key in ("billing_cycle", "rate_override"):
        if key in profile and profile[key] is not None and not isinstance(profile[key], dict):
            errors.append(f"{key} must be an object")
    if str(profile.get("kind") or "") not in KINDS:
        errors.append(f"kind must be one of: {', '.join(KINDS)}")
    if str(profile.get("kind") or "") in {"subscription_included", "subscription_credits", "free"}:
        errors.append("subscription and free-tier plans are managed in Memberships")
    for key in ("monthly_fee_usd", "allowance_usd"):
        if profile.get(key) is not None and not _nonnegative_number(profile[key]):
            errors.append(f"{key} must be a finite non-negative number")
    errors.extend(_allowance_errors(profile.get("allowances")))
    for key in ("effective_from", "effective_to"):
        value = profile.get(key)
        if value is not None and not isinstance(value, str):
            errors.append(f"{key} must be an ISO date string")
    if profile.get("kind") == "unknown" and profile.get("monthly_fee_usd"):
        errors.append("an unknown arrangement cannot assert a fee")
    return errors


class ProfileConflict(ValueError):
    """A stale revision; the caller must reload before retrying."""


def profile_revision(profile: dict) -> str:
    import hashlib, json
    body = {k: v for k, v in profile.items() if k != 'rev'}
    return hashlib.sha256(json.dumps(body, sort_keys=True).encode()).hexdigest()[:12]


@contextmanager
def _locked(target: Path):
    """Exclusive advisory lock around the whole read-modify-write cycle."""
    import fcntl
    target.parent.mkdir(parents=True, exist_ok=True)
    handle = open(target.with_suffix(target.suffix + ".lock"), "a+")
    try:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        yield handle
    finally:
        fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        handle.close()


def save_profile(profile: dict, path: Path | None = None, if_rev: str | None = None) -> dict:
    """Validate and persist one profile atomically. Never touches recorded usage.

    The whole read-modify-write runs under an exclusive lock, so two profiles
    saved concurrently cannot lose each other's update.
    """
    import json, os, tempfile
    document = {key: value for key, value in profile.items() if key != "rev"}
    errors = validation_errors(document)
    if errors:
        raise ValueError("; ".join(errors))
    target = Path(path) if path else profiles_path()
    with _locked(target):
        return _save_locked(document, target, if_rev)


def _save_locked(profile: dict, target: Path, if_rev: str | None) -> dict:
    import json, os, tempfile
    data = _load_profiles(target, strict=True)
    profiles = data.get("profiles", [])
    existing = next((p for p in profiles if str(p.get("id")) == str(profile["id"])), None)
    if existing is not None:
        if if_rev is None:
            raise ProfileConflict("conflict: editing an existing profile requires if_rev")
        if if_rev != (existing.get("rev") or ""):
            raise ProfileConflict("conflict: this profile changed since you loaded it; reload before saving")
        profiles = [p for p in profiles if str(p.get("id")) != str(profile["id"])]
    profile = {**profile, "rev": profile_revision(profile)}
    profiles.append(profile)
    payload = {"version": data.get("version", 1), "profiles": profiles, "defaults": data.get("defaults") or {}}
    target.parent.mkdir(parents=True, exist_ok=True)
    handle = tempfile.NamedTemporaryFile("w", dir=target.parent, delete=False, suffix=".tmp")
    try:
        json.dump(payload, handle, indent=2, sort_keys=True)
        handle.flush(); os.fsync(handle.fileno()); handle.close()
        os.replace(handle.name, target)
    finally:
        if not handle.closed:
            handle.close()
    return {"profiles": profiles, "path": str(target)}


def delete_profile(profile_id: str, path: Path | None = None) -> dict:
    import json, os, tempfile
    target = Path(path) if path else profiles_path()
    with _locked(target):
        return _delete_locked(profile_id, target)


def _delete_locked(profile_id: str, target: Path) -> dict:
    import json, os, tempfile
    data = _load_profiles(target, strict=True)
    profiles = [p for p in data.get("profiles", []) if str(p.get("id")) != str(profile_id)]
    payload = {"version": data.get("version", 1), "profiles": profiles, "defaults": data.get("defaults") or {}}
    handle = tempfile.NamedTemporaryFile("w", dir=target.parent, delete=False, suffix=".tmp")
    try:
        json.dump(payload, handle, indent=2, sort_keys=True)
        handle.flush(); os.fsync(handle.fileno()); handle.close()
        os.replace(handle.name, target)
    finally:
        if not handle.closed:
            handle.close()
    return {"profiles": profiles, "removed": len(data.get("profiles", [])) != len(profiles)}
