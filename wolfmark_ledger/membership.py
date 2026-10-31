"""Account-first membership model: plans, fee overrides, quota evidence.

Design-phase reference implementation for the membership redesign. It is pure
logic and file parsing — no provider calls, no credentials, no routes, no
storage writes. The installed plugin keeps using ``wolfmark_ledger.billing``;
this module fixes the semantics the redesigned UI and the future
``/memberships`` endpoints must obey, so the rules can be tested before any of
them are wired up.

Vocabulary
----------
account      A discovered login for one provider family. Two credentials for
             different accounts are never merged; two credentials for the same
             account dedupe onto one identity.
membership   The owner's statement of what an account costs and which plan it
             is on: a catalogue plan reference plus zero or more fee overrides.
plan         A published subscription product in ``catalogue/plans.json``:
             price, billing cycle, usage windows, model limits, reset policy,
             each with its own verification status and sources.
override     An account-scoped revision of price, currency, cycle or effective
             date. It never edits the catalogue and a catalogue refresh never
             edits it.
exhaustion   A manual claim that a window or a model is used up. Always
             ``basis="manual"``, never presented as provider-confirmed.
evidence     Four separate things that are never summed:
             provider-reported account usage, Hermes-observed inference usage,
             manually declared exhaustion, API-equivalent value.

Rules enforced here (each has a regression test):

1. ``resolve_fee`` always returns the published catalogue price *and* the
   active override, with source labels. A refresh cannot replace an override
   because they live in different documents and the resolver never writes.
2. An override with a different currency is not silently converted.
3. Native usage is displayed only when its account identity matches the
   membership; a ``model``-scoped window never marks the account exhausted.
4. A manual exhaustion clears itself only when it carries a reset instant that
   has passed. Without one it falls due for reconfirmation instead.
5. Fresh provider data that contradicts a manual mark raises a warning; it does
   not silently clear the mark.
6. ``diff_catalogues`` reports changes and never applies them; material or
   ambiguous changes block promotion until a decision is recorded.

Storage shape (documented, not written here)::

    {"version": 1,
     "accounts": [
       {"id": "openai-codex:codex:acct_1:user_9", "family": "openai-codex",
        "label": "ChatGPT — work", "route_slugs": ["openai-codex"],
        "credential_present": true, "identity": "codex:acct_1:user_9",
        "discovered_at": "...", "plan_id": "openai-codex.chatgpt-plus",
        "fee_overrides": [...], "billing_cycle": {"anchor_day": 12, "period": "month"},
        "manual_exhaustions": [...], "advanced": {"model_mapping": {},
        "rate_override": {}}}}]}
"""

from __future__ import annotations

import calendar
import hashlib
import json
import math
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Mapping, Optional

# ---------------------------------------------------------------------------
# Constants and tunables
# ---------------------------------------------------------------------------

#: Mirrors ``agent.account_usage_cache.SNAPSHOT_STALE_AFTER_S``: a snapshot older
#: than this is reported as ``stale`` instead of a confident live reading.
NATIVE_STALE_SECONDS = 15 * 60.0

#: A window at or above this percentage counts as exhausted.
EXHAUSTED_PERCENT = 100.0

#: A provider reading below this contradicts a manual "exhausted" claim.
CONTRADICTION_PERCENT = 95.0

#: Fallback reconfirmation interval when the plan cannot give a window duration.
RECONFIRM_AFTER_HOURS = 24.0

#: Minimum reconfirmation interval, so a short rolling window is not nagging.
MIN_RECONFIRM_AFTER_HOURS = 6.0

FEE_BASES = ("declared", "catalogue", "unpriced", "no_plan")
OVERRIDE_REASONS = (
    "discount",
    "legacy_pricing",
    "promotion",
    "regional",
    "catalogue_behind",
    "annual_prepay",
    "other",
)
WINDOW_SCOPES = ("account", "model")
#: What a manual mark may cover. `window` is a named quota window; `account`
#: means the whole login, which is the only option for a provider that publishes
#: no windows at all (CommandCode, OpenRouter credits).
MANUAL_SCOPES = ("account", "window", "model")
#: Where an account's quota reading came from.
USAGE_SOURCES = ("none", "usage_api", "credits_api", "portal", "provider_hook")
CURRENCIES = ("USD", "GBP", "EUR", "AUD", "CAD", "JPY", "CNY", "CHF", "SEK", "PLN", "INR")

#: How a vendor bills. Three arrangements behave differently and must not be
#: conflated: a recurring fee with nothing attached, a recurring fee that grants
#: a usage allowance, and a wallet that is topped up and drawn down.
#:   recurring_subscription     — fixed recurring fee, usage metered separately
#:   recurring_credit_allowance — recurring fee that includes a credit/usage pool
#:   prepaid_metered_wallet     — no recurring fee; balance drawn down per token
BILLING_ARRANGEMENTS = ("recurring_subscription", "recurring_credit_allowance",
                        "prepaid_metered_wallet", "free_tier")

#: Default arrangement implied by the legacy ``kind``, so an older record still
#: loads. New records should state the arrangement explicitly.
_ARRANGEMENT_BY_KIND = {
    "subscription": "recurring_subscription",
    "credits": "recurring_credit_allowance",
    "prepaid": "prepaid_metered_wallet",
    # A free tier carries no billing relationship at all: no fee, no wallet.
    "free": "free_tier",
}
PERIODS = ("month", "year", "quarter", "week")

#: Materiality of a catalogue change. ``review`` blocks automatic adoption.
CHANGE_KINDS = {
    "price": "material",
    "currency": "material",
    "period": "material",
    "billing_cycle": "material",
    "window_added": "material",
    "window_removed": "material",
    "window_changed": "material",
    "model_limits": "material",
    "reset_policy": "material",
    "plan_added": "review",
    "plan_removed": "material",
    "verification": "review",
    "name": "cosmetic",
    "notes": "cosmetic",
    "source": "cosmetic",
}


class CatalogueError(ValueError):
    """The plan catalogue is not usable; callers must show a load error."""


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------

def _epoch(value: Any) -> Optional[float]:
    """Parse an epoch, a naive/aware ISO stamp or ``None``. Never guesses."""
    if value in (None, ""):
        return None
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return float(value)
    text = str(value).strip()
    if not text:
        return None
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.timestamp()


def _iso(moment: Optional[float]) -> Optional[str]:
    if moment is None:
        return None
    return datetime.fromtimestamp(float(moment), timezone.utc).isoformat().replace("+00:00", "Z")


def _now(at: Any = None) -> float:
    parsed = _epoch(at)
    return time.time() if parsed is None else parsed


def _slug(text: Any) -> str:
    cleaned = "".join(ch.lower() if ch.isalnum() else "-" for ch in str(text or "").strip())
    while "--" in cleaned:
        cleaned = cleaned.replace("--", "-")
    return cleaned.strip("-")


def _money(amount: Any) -> Optional[float]:
    if isinstance(amount, bool) or not isinstance(amount, (int, float)):
        return None
    return float(amount)


def _cycle(anchor_day: Any, period: Any) -> Optional[dict[str, Any]]:
    day = None
    if isinstance(anchor_day, int) and not isinstance(anchor_day, bool) and 1 <= anchor_day <= 31:
        day = anchor_day
    cycle_period = str(period or "").strip().lower() or None
    if cycle_period is not None and cycle_period not in PERIODS:
        cycle_period = None
    if day is None and cycle_period is None:
        return None
    return {"anchor_day": day, "period": cycle_period}


# ---------------------------------------------------------------------------
# Plan catalogue
# ---------------------------------------------------------------------------

def load_plan_catalogue(source: Mapping[str, Any] | str | Path | None = None) -> dict[str, Any]:
    """Load and validate a versioned plan catalogue.

    Accepts a mapping (tests, callers that already parsed the file) or a path.
    Raises :class:`CatalogueError` with a human sentence — never a Pydantic dump
    — so the pane can render it directly.
    """
    if source is None:
        raise CatalogueError("no plan catalogue supplied")
    if isinstance(source, (str, Path)):
        path = Path(source)
        if not path.exists():
            raise CatalogueError("plan catalogue is missing")
        try:
            raw = json.loads(path.read_text(encoding="utf-8-sig"))
        except (OSError, ValueError) as exc:
            raise CatalogueError(f"plan catalogue could not be read: {exc}") from exc
    else:
        raw = dict(source)

    if not isinstance(raw, dict):
        raise CatalogueError("plan catalogue root must be an object")
    version = str(raw.get("catalogue_version") or "").strip()
    if not version:
        raise CatalogueError("plan catalogue needs a catalogue_version")
    plans = raw.get("plans")
    if not isinstance(plans, list) or not plans:
        raise CatalogueError("plan catalogue needs a non-empty plans list")

    seen: set[str] = set()
    out: list[dict[str, Any]] = []
    for entry in plans:
        if not isinstance(entry, dict):
            raise CatalogueError("every plan must be an object")
        plan_id = str(entry.get("id") or "").strip()
        if not plan_id:
            raise CatalogueError("every plan needs an id")
        if plan_id in seen:
            raise CatalogueError(f"duplicate plan id: {plan_id}")
        seen.add(plan_id)
        family = str(entry.get("provider_family") or "").strip()
        if not family:
            raise CatalogueError(f"plan {plan_id} needs provider_family")
        price_raw = entry.get("price")
        price: dict[str, Any] = price_raw if isinstance(price_raw, dict) else {}
        amount = _money(price.get("amount"))
        currency = str(price.get("currency") or "").strip().upper() or None
        if amount is not None and currency not in CURRENCIES:
            raise CatalogueError(f"plan {plan_id} has an unsupported currency")
        if amount is not None and amount < 0:
            raise CatalogueError(f"plan {plan_id} has a negative price")
        period = str(price.get("period") or "month").strip().lower()
        if period not in PERIODS:
            raise CatalogueError(f"plan {plan_id} has an unsupported price period")
        verification_raw = entry.get("verification")
        verification: dict[str, Any] = verification_raw if isinstance(verification_raw, dict) else {}
        status = str(verification.get("status") or "unverified").strip().lower()
        if status not in ("verified", "provisional", "unverified", "retired"):
            raise CatalogueError(f"plan {plan_id} has an unknown verification status")
        entitlements_raw = entry.get("entitlements")
        entitlements: dict[str, Any] = entitlements_raw if isinstance(entitlements_raw, dict) else {}
        windows_raw = entitlements.get("windows")
        windows: list[Any] = windows_raw if isinstance(windows_raw, list) else []
        normalised_windows = []
        for window in windows:
            if not isinstance(window, dict):
                continue
            wid = _slug(window.get("id") or window.get("label") or "")
            if not wid:
                continue
            normalised_windows.append({
                "id": wid,
                "label": str(window.get("label") or wid.replace("-", " ").title()),
                "kind": str(window.get("kind") or "rolling"),
                "duration_minutes": (int(window["duration_minutes"])
                                     if isinstance(window.get("duration_minutes"), (int, float)) else None),
                "limit": window.get("limit"),
                "scope": str(window.get("scope") or "account"),
                # A credit-value window carries an amount, not a percentage. Kept
                # so the pane can say "$20 of credit, not 20% used".
                "amount": (float(window["amount"])
                           if isinstance(window.get("amount"), (int, float))
                           and not isinstance(window.get("amount"), bool) else None),
                "currency": str(window.get("currency") or "").upper() or None,
                "detail": str(window.get("detail") or ""),
            })
        normalised_windows.sort(key=lambda w: w["id"])
        models_raw = entitlements.get("models")
        policy_raw = entitlements.get("reset_policy")
        entitlement_verification_raw = entitlements.get("verification")
        kind = str(entry.get("kind") or "subscription").strip().lower()
        arrangement = str(entry.get("billing_arrangement") or "").strip().lower() or \
            _ARRANGEMENT_BY_KIND.get(kind, "")
        arrangement_check = str(entry.get("billing_arrangement") or "").strip().lower() or \
            _ARRANGEMENT_BY_KIND.get(kind, "")
        if arrangement_check and arrangement_check not in BILLING_ARRANGEMENTS:
            raise CatalogueError(f"plan {plan_id} has an unknown billing arrangement")
        if arrangement_check == "prepaid_metered_wallet" and amount is not None \
                and str(price.get("period") or "month").strip().lower() in ("month", "year"):
            # A wallet is drawn down, not billed on a cycle: a recurring amount
            # here would be a subscription wearing the wrong label.
            raise CatalogueError(f"plan {plan_id} is a prepaid wallet with a recurring price")
        out.append({
            "id": plan_id,
            "provider_family": family,
            "route_slugs": [str(s) for s in (entry.get("route_slugs") or []) if str(s).strip()],
            "name": str(entry.get("name") or plan_id),
            "kind": kind,
            "billing_arrangement": arrangement,
            "price": {"amount": amount, "currency": currency, "period": period},
            "billing_cycle": _cycle((entry.get("billing_cycle") or {}).get("anchor_day"),
                                    (entry.get("billing_cycle") or {}).get("period") or period),
            "entitlements": {
                "windows": normalised_windows,
                "models": models_raw if isinstance(models_raw, dict) else {},
                "reset_policy": policy_raw if isinstance(policy_raw, dict) else {},
                "verification": (entitlement_verification_raw
                                 if isinstance(entitlement_verification_raw, dict) else {}),
            },
            "verification": {
                "status": status,
                "checked_at": verification.get("checked_at"),
                "source_id": verification.get("source_id"),
                "notes": str(verification.get("notes") or ""),
            },
            # A plan can be real and still not cover a route: CommandCode's $1 Go
            # plan is CLI-only, so a Hermes route pointed at the Provider API must
            # not offer it. None means "the vendor does not say".
            "access": _access(entry.get("access")),
            "effective_from": entry.get("effective_from"),
            "effective_to": entry.get("effective_to"),
            "model_restrictions": [str(m) for m in (entry.get("model_restrictions") or []) if str(m).strip()],
            "notes": str(entry.get("notes") or ""),
        })

    sources_raw = raw.get("sources")
    sources: list[Any] = sources_raw if isinstance(sources_raw, list) else []
    return {
        "catalogue_version": version,
        "generated_at": raw.get("generated_at"),
        "sources": [s for s in sources if isinstance(s, dict)],
        "plans": sorted(out, key=lambda p: p["id"]),
    }


ACCESS_KEYS = ("cli", "provider_api")
ACCESS_VALUES = (True, False, None)


def _access(raw: Any) -> dict[str, Optional[bool]]:
    """Normalise a plan's route access. Unknown is ``None``, never assumed."""
    source = raw if isinstance(raw, Mapping) else {}
    return {key: (source.get(key) if source.get(key) in ACCESS_VALUES else None) for key in ACCESS_KEYS}


def plan_eligibility(plan: Mapping[str, Any], *, requires_api: bool = True) -> dict[str, Any]:
    """Whether a plan can serve the route we are configuring, and why not.

    Three states, deliberately distinct: eligible, ineligible, and unstated. A
    provider that does not publish which plans cover its API is *unstated*, not
    ineligible — but the reason is still shown so the owner can decide.
    """
    status = str((plan or {}).get("verification", {}).get("status") or "")
    if status == "retired":
        return {"eligible": False, "reasons": ["retired: the provider no longer sells this plan"]}
    access = _access((plan or {}).get("access"))
    flag = access.get("provider_api") if requires_api else access.get("cli")
    label = "Provider API" if requires_api else "CLI"
    if flag is False:
        return {"eligible": False, "reasons": [f"no {label} access for this plan"]}
    if flag is None:
        return {"eligible": True, "unstated": True,
                "reasons": [f"the provider does not state whether this plan covers the {label}"]}
    return {"eligible": True, "reasons": []}


def selectable_plans(catalogue: Mapping[str, Any] | None, family: str, *,
                     requires_api: bool = True) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """(eligible, excluded) plans for a family, each with its eligibility verdict."""
    eligible, excluded = [], []
    for plan in plans_for_family(catalogue, family):
        verdict = plan_eligibility(plan, requires_api=requires_api)
        row = {**plan, "eligibility": verdict}
        (eligible if verdict["eligible"] else excluded).append(row)
    return eligible, excluded


def plan_index(catalogue: Mapping[str, Any] | None) -> dict[str, dict[str, Any]]:
    return {p["id"]: p for p in (catalogue or {}).get("plans", [])}


def plans_for_family(catalogue: Mapping[str, Any] | None, family: str) -> list[dict[str, Any]]:
    slug = str(family or "").strip().lower()
    return [p for p in (catalogue or {}).get("plans", []) if p["provider_family"] == slug]


# ---------------------------------------------------------------------------
# Fee resolution: published catalogue value + account override
# ---------------------------------------------------------------------------

def _override_active(override: Mapping[str, Any], at: float) -> bool:
    start = _epoch(override.get("effective_from"))
    end = _epoch(override.get("effective_to"))
    if start is not None and at < start:
        return False
    if end is not None and at >= end:
        return False
    return True


def override_rank(override: Mapping[str, Any]) -> tuple[float, float, str]:
    """Ordering for concurrent revisions: latest effective_from, then recorded."""
    return (
        _epoch(override.get("effective_from")) or 0.0,
        _epoch(override.get("recorded_at")) or 0.0,
        str(override.get("id") or ""),
    )


def active_override(membership: Mapping[str, Any], at: Any = None) -> Optional[dict[str, Any]]:
    """The override revision that applies at ``at`` (latest one wins).

    Historical dates still resolve to the revision that was in force then, so a
    later correction never rewrites what an earlier month was billed at.
    """
    moment = _now(at)
    revisions = [o for o in (membership.get("fee_overrides") or []) if isinstance(o, dict)]
    live = [o for o in revisions if _override_active(o, moment)]
    if not live:
        return None
    return max(live, key=override_rank)


def custom_plan_view(membership: Mapping[str, Any]) -> Optional[dict[str, Any]]:
    raw = membership.get("custom_plan")
    if not isinstance(raw, dict) or not str(raw.get("id") or ""):
        return None
    windows = []
    for item in raw.get("allowances") or []:
        if not isinstance(item, dict):
            continue
        wid = _slug(item.get("id") or item.get("label") or "")
        if not wid:
            continue
        windows.append({
            "id": wid,
            "label": str(item.get("label") or wid.replace("-", " ").title()),
            "kind": str(item.get("kind") or "rolling"),
            "duration_minutes": item.get("duration_minutes"),
            "limit": item.get("limit"),
            "scope": str(item.get("scope") or "account"),
            "amount": item.get("amount"),
            "currency": str(item.get("currency") or "").upper() or None,
            "detail": "User-defined entitlement; provider usage remains unreported unless Hermes supplies it.",
        })
    price = raw.get("price") if isinstance(raw.get("price"), dict) else {}
    cycle = raw.get("billing_cycle") if isinstance(raw.get("billing_cycle"), dict) else {}
    restrictions = raw.get("model_restrictions") or []
    return {
        "id": str(raw["id"]),
        "provider_family": str(membership.get("family") or ""),
        "route_slugs": list(membership.get("route_slugs") or []),
        "name": str(raw.get("name") or "User-defined plan"),
        "kind": "subscription",
        "billing_arrangement": "recurring_credit_allowance" if windows else "recurring_subscription",
        "price": {"amount": price.get("amount"), "currency": price.get("currency"),
                  "period": price.get("period") or "month"},
        "billing_cycle": _cycle(cycle.get("anchor_day"), cycle.get("period") or price.get("period") or "month"),
        "entitlements": {"windows": windows, "models": {"allowed": list(restrictions)},
                         "reset_policy": {}, "verification": {"status": "user_defined"}},
        "model_restrictions": list(restrictions),
        "verification": {"status": "user_defined", "notes": "Entered by the account owner."},
        "source": "user_defined",
        "effective": {"effective_from": raw.get("effective_from"),
                      "effective_to": raw.get("effective_to")},
    }


def resolve_fee(membership: Mapping[str, Any], catalogue: Mapping[str, Any] | None,
                at: Any = None) -> dict[str, Any]:
    """Resolve the fee an account should be shown and charged at ``at``.

    Returns ``published`` (what the catalogue says), ``override`` (the owner's
    active revision, or ``None``), ``effective`` (what applies) and a
    ``provenance`` list naming every source consulted. Nothing is written; a
    catalogue refresh cannot replace an override because only the override
    document holds one.
    """
    moment = _now(at)
    plan_id = str(membership.get("plan_id") or "").strip()
    custom = custom_plan_view(membership)
    plan = custom if custom and custom.get("id") == plan_id else plan_index(catalogue).get(plan_id)
    plan_active = True
    if plan and plan.get("source") == "user_defined":
        start = _epoch((plan.get("effective") or {}).get("effective_from"))
        end = _epoch((plan.get("effective") or {}).get("effective_to"))
        plan_active = not ((start is not None and moment < start) or (end is not None and moment >= end))

    published: Optional[dict[str, Any]] = None
    if plan:
        price = plan.get("price") or {}
        published = {
            "amount": price.get("amount") if plan_active else None,
            "currency": price.get("currency"),
            "period": price.get("period"),
            "plan_id": plan["id"],
            "plan_name": plan.get("name"),
            "catalogue_version": (catalogue or {}).get("catalogue_version"),
            "verification": plan.get("verification"),
            "billing_cycle": plan.get("billing_cycle"),
            "source": plan.get("source") or "catalogue",
            "effective": plan.get("effective"),
        }

    override = active_override(membership, moment)
    override_view: Optional[dict[str, Any]] = None
    if override:
        override_view = {
            "amount": _money(override.get("amount")),
            "currency": (str(override.get("currency")).upper()
                         if override.get("currency") else None),
            "period": override.get("period"),
            "billing_cycle": _cycle((override.get("billing_cycle") or {}).get("anchor_day"),
                                    (override.get("billing_cycle") or {}).get("period")),
            "effective_from": override.get("effective_from"),
            "effective_to": override.get("effective_to"),
            "reason": override.get("reason"),
            "note": str(override.get("note") or ""),
            "recorded_at": override.get("recorded_at"),
            "revision_id": override.get("id"),
            "revision_count": len([o for o in (membership.get("fee_overrides") or [])
                                   if isinstance(o, dict)]),
        }

    notes: list[str] = []
    if plan_id and plan is None:
        notes.append("The selected plan is not in this catalogue version; "
                     "your own price is kept and the catalogue price is unavailable.")
    if override_view and published is None:
        notes.append("Price comes from your override; no catalogue price is linked.")

    if override_view and override_view.get("amount") is not None:
        basis = "declared"
        effective = {k: override_view[k] for k in ("amount", "currency", "period", "billing_cycle")}
        effective["source"] = "account_override"
    elif published and published.get("amount") is not None:
        basis = "custom" if published.get("source") == "user_defined" else "catalogue"
        effective = {
            "amount": published["amount"],
            "currency": published["currency"],
            "period": published["period"],
            "billing_cycle": published.get("billing_cycle"),
            "source": published.get("source") or "catalogue",
        }
    elif plan_id:
        basis = "unpriced"
        effective = {"amount": None, "currency": None, "period": None,
                     "billing_cycle": None, "source": "none"}
        notes.append("No published price and no override: the fee is unknown, not zero.")
    else:
        basis = "no_plan"
        effective = {"amount": None, "currency": None, "period": None,
                     "billing_cycle": None, "source": "none"}
        notes.append("No plan selected for this account.")

    comparable = True
    if (override_view and override_view.get("amount") is not None
            and published and published.get("amount") is not None):
        comparable = (override_view.get("currency") == published.get("currency"))
        if not comparable:
            notes.append(
                f"Catalogue price is {published.get('amount')} {published.get('currency')}; "
                f"your price is {override_view.get('amount')} {override_view.get('currency')}. "
                "They are different currencies and are not converted here."
            )
        if str(override_view.get("reason") or "") == "catalogue_behind":
            notes.append("You have marked the catalogue as behind the provider for this account.")

    provenance = []
    if published is not None:
        provenance.append({"source": published.get("source") or "catalogue", "plan_id": published["plan_id"],
                           "catalogue_version": published.get("catalogue_version"),
                           "effective": published.get("effective"),
                           "verification": (published.get("verification") or {}).get("status")})
    if override_view is not None:
        provenance.append({"source": "account_override", "revision_id": override_view["revision_id"],
                           "effective_from": override_view["effective_from"],
                           "reason": override_view["reason"]})
    if not provenance:
        provenance.append({"source": "none", "reason": basis})

    return {
        "basis": basis,
        "published": published,
        "override": override_view,
        "effective": effective,
        "currency_comparable": comparable,
        "provenance": provenance,
        "notes": notes,
        "at": _iso(moment),
    }


def active_financial_rules(membership: Mapping[str, Any], catalogue: Mapping[str, Any] | None,
                           at: Any = None) -> dict[str, Any]:
    """The financial inputs an active account actually uses, for change checks.

    A catalogue promotion must not alter this dict unless the owner accepted the
    change; tests compare it before and after a diff to prove nothing leaked.
    """
    fee = resolve_fee(membership, catalogue, at)
    plan_id = str(membership.get("plan_id") or "").strip()
    plan = plan_index(catalogue).get(plan_id) or {}
    entitlements = plan.get("entitlements") or {}
    cycle = fee["effective"].get("billing_cycle") or plan.get("billing_cycle")
    return {
        "plan_id": plan_id or None,
        "fee": {"amount": fee["effective"].get("amount"),
                "currency": fee["effective"].get("currency"),
                "period": fee["effective"].get("period"),
                "source": fee["effective"].get("source")},
        "billing_cycle": cycle,
        "windows": [{"id": w["id"], "duration_minutes": w["duration_minutes"], "scope": w["scope"]}
                    for w in entitlements.get("windows", [])],
        "reset_policy": entitlements.get("reset_policy") or {},
    }


# ---------------------------------------------------------------------------
# Accounts and discovery
# ---------------------------------------------------------------------------

def account_key(family: str, identity: Optional[str]) -> str:
    """Stable account key. Different identities never share a key.

    ``identity=None`` means the platform cannot tell accounts apart (Hermes'
    "legacy slot"); it gets the ``default`` slot rather than borrowing another
    account's readings.
    """
    fam = str(family or "").strip().lower()
    ident = str(identity or "").strip()
    return f"{fam}:{ident or 'default'}"


def member_from_native(snapshot: Mapping[str, Any], *, label: Optional[str] = None,
                       route_slugs: Optional[Iterable[str]] = None,
                       discovered_at: Any = None) -> dict[str, Any]:
    """Build a discovered account stub from a Hermes account-usage snapshot."""
    provider = str(snapshot.get("provider") or "").strip().lower()
    identity = snapshot.get("identity")
    return {
        "id": account_key(provider, identity),
        "family": provider,
        "label": str(label or (snapshot.get("plan") or provider or "Account")),
        "route_slugs": [str(s) for s in (route_slugs or [provider]) if str(s).strip()],
        "credential_present": True,
        "identity": identity,
        "identity_source": "native" if identity else "provider_default_slot",
        "discovered_at": _iso(_now(discovered_at)),
        "plan_id": None,
        "plan_hint": snapshot.get("plan"),
        "fee_overrides": [],
        "manual_exhaustions": [],
        "advanced": {"model_mapping": {}, "rate_override": {}},
    }


def member_from_billing_profile(profile: Mapping[str, Any], *, family: Optional[str] = None,
                                discovered_at: Any = None) -> dict[str, Any]:
    """Migrate one legacy ``billing-profiles.json`` entry.

    The declared fee becomes an override revision (never a catalogue value), the
    cycle day is preserved, and no plan is guessed: an unrecognised arrangement
    must stay visibly unrecognised.
    """
    provider = str(profile.get("provider") or "").strip().lower()
    fam = str(family or provider).strip().lower()
    cycle_raw = profile.get("billing_cycle")
    cycle: dict[str, Any] = cycle_raw if isinstance(cycle_raw, dict) else {}
    overrides = []
    fee = _money(profile.get("monthly_fee_usd"))
    if fee is not None:
        overrides.append({
            "id": "migrated-fee",
            "amount": fee,
            "currency": str(profile.get("currency") or "USD").upper(),
            "period": "month",
            "billing_cycle": _cycle(cycle.get("day"), cycle.get("period") or "month"),
            "effective_from": profile.get("effective_from"),
            "effective_to": profile.get("effective_to"),
            "reason": "legacy_pricing",
            "note": "Migrated from a billing profile; the fee was user-declared.",
            "recorded_at": _iso(_now(discovered_at)),
        })
    return {
        "id": account_key(fam, profile.get("account")),
        "family": fam,
        "label": str(profile.get("label") or provider or "Account"),
        "route_slugs": [provider],
        "credential_present": True,
        "identity": profile.get("account"),
        "identity_source": "billing_profile" if profile.get("account") else "provider_default_slot",
        "discovered_at": _iso(_now(discovered_at)),
        "plan_id": None,
        "plan_hint": None,
        "fee_overrides": overrides,
        "manual_exhaustions": [],
        "advanced": {"model_mapping": {}, "rate_override": dict(profile.get("rate_override") or {})},
        "migrated_from": {"profile_id": profile.get("id"), "kind": profile.get("kind")},
    }


# ---------------------------------------------------------------------------
# Native account usage (Hermes-reported)
# ---------------------------------------------------------------------------

def _window_id(label: Any) -> str:
    return _slug(label) or "window"


def native_usage(snapshot: Mapping[str, Any] | None, membership: Mapping[str, Any] | None = None,
                 at: Any = None) -> dict[str, Any]:
    """Normalise a Hermes ``usage`` snapshot for one account.

    State precedence: ``identity_mismatch`` (wrong account) → ``unavailable``
    (Hermes said why) → ``absent`` (no snapshot) → ``stale`` → ``live``. A
    mismatch is never downgraded: merging two accounts' usage would fabricate a
    quota reading.
    """
    moment = _now(at)
    if not snapshot:
        return {"state": "absent", "windows": [], "details": [], "identity": None,
                "age_seconds": None, "source": None, "plan_hint": None, "notes": []}

    identity = snapshot.get("identity")
    expected = (membership or {}).get("identity")
    notes: list[str] = []
    if expected and identity and str(identity) != str(expected):
        return {"state": "identity_mismatch", "windows": [], "details": [], "identity": identity,
                "age_seconds": None, "source": snapshot.get("source"), "plan_hint": snapshot.get("plan"),
                "notes": ["Hermes reported usage for a different account; it is not applied here."]}

    fetched = _epoch(snapshot.get("fetched_at"))
    age = None if fetched is None else max(0.0, moment - fetched)

    reason = str(snapshot.get("unavailable_reason") or "").strip()
    windows = []
    for raw in snapshot.get("windows") or []:
        if not isinstance(raw, dict):
            continue
        raw_scope = str(raw.get("scope") or "").strip().lower()
        scope_assumed = raw_scope not in WINDOW_SCOPES
        scope = raw_scope if raw_scope in WINDOW_SCOPES else "account"
        used = raw.get("used_percent")
        reset_raw = raw.get("reset_at")
        if isinstance(reset_raw, datetime):
            reset_value = reset_raw.isoformat().replace("+00:00", "Z")
        else:
            reset_value = reset_raw
        windows.append({
            "id": _window_id(raw.get("label")),
            "label": str(raw.get("label") or "Window"),
            "used_percent": float(used) if isinstance(used, (int, float)) else None,
            "reset_at": reset_value,
            "detail": raw.get("detail"),
            "scope": scope,
            "scope_assumed": scope_assumed,
            "basis": "provider_reported",
            "source": snapshot.get("source"),
            "fetched_at": snapshot.get("fetched_at"),
        })

    if reason:
        state = "unavailable"
    elif age is None:
        state = "stale"
        notes.append("Hermes did not report when this reading was fetched; it is not shown as live.")
    elif age > NATIVE_STALE_SECONDS:
        state = "stale"
        notes.append("Hermes has not refreshed this reading recently; it may have recovered.")
    else:
        state = "live"

    return {
        "state": state,
        "windows": windows,
        "details": [str(d) for d in (snapshot.get("details") or [])],
        "identity": identity,
        "identity_source": "native" if identity else "provider_default_slot",
        "age_seconds": age,
        "source": snapshot.get("source"),
        "plan_hint": snapshot.get("plan"),
        "unavailable_reason": reason or None,
        "notes": notes,
    }


def account_exhausted(view: Mapping[str, Any]) -> bool:
    """True only when an ``account``-scoped window is used up.

    A model-scoped window (Anthropic's Opus/Sonnet weekly limits) can never make
    the whole login count as exhausted.
    """
    for window in (view or {}).get("windows") or []:
        if window.get("scope") != "account":
            continue
        used = window.get("used_percent")
        if isinstance(used, (int, float)) and used >= EXHAUSTED_PERCENT:
            return True
    return False


def model_exhausted(view: Mapping[str, Any]) -> list[str]:
    """Model-scoped windows that are used up, e.g. ``["Opus week"]``."""
    out = []
    for window in (view or {}).get("windows") or []:
        if window.get("scope") != "model":
            continue
        used = window.get("used_percent")
        if isinstance(used, (int, float)) and used >= EXHAUSTED_PERCENT:
            out.append(window.get("label") or window.get("id"))
    return out


def propose_plan(snapshot: Mapping[str, Any] | None, catalogue: Mapping[str, Any] | None,
                 family: str) -> Optional[dict[str, Any]]:
    """Suggest a catalogue plan from the provider's own plan label.

    A proposal only — the caller must ask. A provider plan string can be a
    marketing label, renamed between releases, or shared by two products, and a
    wrong match silently changes which published price and windows apply.
    """
    label = _slug((snapshot or {}).get("plan"))
    if not label:
        return None
    candidates = plans_for_family(catalogue, family)
    exact = [p for p in candidates if _slug(p["id"].split(".")[-1]) == label]
    if exact:
        return {"plan_id": exact[0]["id"], "confidence": "exact", "label": (snapshot or {}).get("plan"),
                "requires_confirmation": True,
                "candidates": [p["id"] for p in exact]}
    alias = [p for p in candidates if label in _slug(p["name"]) or _slug(p["name"]) in label]
    if len(alias) == 1:
        return {"plan_id": alias[0]["id"], "confidence": "alias", "label": (snapshot or {}).get("plan"),
                "requires_confirmation": True, "candidates": [p["id"] for p in alias]}
    return {"plan_id": None, "confidence": "none", "label": (snapshot or {}).get("plan"),
            "requires_confirmation": True, "candidates": [p["id"] for p in candidates]}


# ---------------------------------------------------------------------------
# Manual quota exhaustion
# ---------------------------------------------------------------------------

def declare_exhausted(membership: Mapping[str, Any], *, scope_id: str, scope_kind: str = "window",
                      label: Optional[str] = None, reset_at: Any = None, note: str = "",
                      declared_at: Any = None) -> dict[str, Any]:
    """Create a manual exhaustion entry (never applied to the provider's record)."""
    kind = str(scope_kind or "window").strip().lower()
    if kind not in MANUAL_SCOPES:
        raise ValueError("scope kind must be one of: " + ", ".join(MANUAL_SCOPES))
    sid = _slug(scope_id)
    if not sid:
        raise ValueError("scope id is required")
    moment = _now(declared_at)
    ident = hashlib.sha1(f"{membership.get('id')}|{kind}|{sid}|{moment}".encode()).hexdigest()[:12]
    return {
        "id": f"manual-{ident}",
        "account_id": membership.get("id"),
        "scope": {"kind": kind, "id": sid, "label": str(label or sid.replace("-", " ").title())},
        "declared_at": _iso(moment),
        "reset_at": _iso(_epoch(reset_at)) if reset_at else None,
        "note": str(note or ""),
        "basis": "manual",
        "state": "active",
        "history": [],
    }


def _matching_provider_window(scope: Mapping[str, Any], provider_windows: Iterable[Mapping[str, Any]]):
    sid = str((scope or {}).get("id") or "")
    kind = str((scope or {}).get("kind") or "window")
    if kind == "model":
        for window in provider_windows or []:
            if window.get("scope") != "model":
                continue
            if sid and sid in _slug(window.get("id") or window.get("label")):
                return window
            if sid and sid in _slug(window.get("label")):
                return window
        return None
    for window in provider_windows or []:
        if _slug(window.get("id")) == sid or _slug(window.get("label")) == sid:
            return window
    return None


def _reconfirm_hours(scope: Mapping[str, Any], plan: Mapping[str, Any] | None) -> float:
    sid = str((scope or {}).get("id") or "")
    for window in ((plan or {}).get("entitlements") or {}).get("windows") or []:
        if _slug(window.get("id")) != sid:
            continue
        minutes = window.get("duration_minutes")
        if isinstance(minutes, (int, float)) and minutes > 0:
            return max(MIN_RECONFIRM_AFTER_HOURS, float(minutes) / 60.0)
    return RECONFIRM_AFTER_HOURS


def evaluate_exhaustion(entry: Mapping[str, Any], *, provider_windows: Optional[Iterable[Mapping[str, Any]]] = None,
                        plan: Mapping[str, Any] | None = None, provider_state: str = "absent",
                        at: Any = None) -> dict[str, Any]:
    """Decide what a manual exhaustion should show right now.

    Statuses: ``active`` (still believed), ``expired`` (a known reset instant has
    passed → auto-cleared), ``reconfirm_due`` (no reliable boundary, so ask),
    ``contradicted`` (fresh provider data disagrees), ``cleared`` (user cleared).

    Only a reset instant that has actually elapsed clears a mark automatically.
    A rolling window's start is unknown, so a duration never implies a boundary.
    """
    moment = _now(at)
    scope = entry.get("scope") or {}
    declared = _epoch(entry.get("declared_at"))
    reset = _epoch(entry.get("reset_at"))
    base = {
        "id": entry.get("id"),
        "scope": scope,
        "declared_at": entry.get("declared_at"),
        "reset_at": entry.get("reset_at"),
        "note": entry.get("note"),
        "basis": "manual",
    }

    if str(entry.get("state")) == "cleared" or entry.get("cleared_at"):
        return {**base, "status": "cleared", "auto_clear": False,
                "cleared_at": entry.get("cleared_at"),
                "cleared_reason": entry.get("cleared_reason"),
                "provider_conflict": None, "reconfirm_due_at": None}

    if reset is not None and moment >= reset:
        cleared_at = _iso(reset)
        return {**base, "status": "expired", "auto_clear": True, "cleared_at": cleared_at,
                "cleared_reason": "auto_reset", "provider_conflict": None,
                "reconfirm_due_at": None,
                "note_for_ui": "Cleared automatically: its reset time has passed."}

    window = _matching_provider_window(scope, provider_windows or [])
    conflict = None
    if window and provider_state == "live":
        used = window.get("used_percent")
        if isinstance(used, (int, float)) and used < CONTRADICTION_PERCENT:
            conflict = {
                "provider_used_percent": float(used),
                "provider_window": window.get("label"),
                "provider_reset_at": window.get("reset_at"),
                "say": f"The provider reports {used:.0f}% used for {window.get('label')}, "
                       "so this manual mark may be out of date.",
            }
            return {**base, "status": "contradicted", "auto_clear": False,
                    "cleared_at": None, "cleared_reason": None,
                    "provider_conflict": conflict, "reconfirm_due_at": None}

    if reset is not None:
        return {**base, "status": "active", "auto_clear": False, "cleared_at": None,
                "cleared_reason": None, "provider_conflict": conflict,
                "reconfirm_due_at": None,
                "expires_in_seconds": max(0.0, reset - moment)}

    hours = _reconfirm_hours(scope, plan)
    due = (declared or moment) + hours * 3600.0
    if moment >= due:
        return {**base, "status": "reconfirm_due", "auto_clear": False, "cleared_at": None,
                "cleared_reason": None, "provider_conflict": conflict,
                "reconfirm_due_at": _iso(due),
                "note_for_ui": "No reliable reset time. Please confirm or clear this mark."}
    return {**base, "status": "active", "auto_clear": False, "cleared_at": None,
            "cleared_reason": None, "provider_conflict": conflict,
            "reconfirm_due_at": _iso(due), "expires_in_seconds": max(0.0, due - moment)}


def clear_exhaustion(entry: Mapping[str, Any], *, reason: str = "user", at: Any = None) -> dict[str, Any]:
    """Clear a manual mark, keeping the entry for the audit trail."""
    moment = _now(at)
    return {
        **dict(entry),
        "state": "cleared",
        "cleared_at": _iso(moment),
        "cleared_reason": str(reason or "user"),
        "history": [*(entry.get("history") or []),
                    {"action": "cleared", "at": _iso(moment), "reason": str(reason or "user")}],
    }


def reconfirm_exhaustion(entry: Mapping[str, Any], *, at: Any = None, reset_at: Any = None) -> dict[str, Any]:
    """Record a reconfirmation, optionally with a newly known reset instant."""
    moment = _now(at)
    updated = dict(entry)
    updated["declared_at"] = _iso(moment)
    updated["history"] = [*(entry.get("history") or []),
                          {"action": "reconfirmed", "at": _iso(moment)}]
    if reset_at is not None:
        updated["reset_at"] = _iso(_epoch(reset_at))
    return updated


# ---------------------------------------------------------------------------
# Quota view: provider + manual, plus windows nobody reported
# ---------------------------------------------------------------------------

def quota_view(membership: Mapping[str, Any], native: Mapping[str, Any] | None,
               plan: Mapping[str, Any] | None = None, at: Any = None) -> dict[str, Any]:
    """Merge provider readings and manual marks for one account.

    Every row keeps its own basis. A provider reading is never overwritten by a
    manual mark and vice versa; a window with neither is shown as ``no_data``
    rather than as zero used.
    """
    moment = _now(at)
    view = native or {"state": "absent", "windows": []}
    rows: dict[str, dict[str, Any]] = {}
    auto_cleared: list[str] = []

    for window in view.get("windows") or []:
        rows[window["id"]] = {
            "id": window["id"],
            "label": window.get("label"),
            "scope": window.get("scope", "account"),
            "used_percent": window.get("used_percent"),
            "reset_at": window.get("reset_at"),
            "state": "live" if view.get("state") == "live" else "stale",
            "basis": ["provider_reported"],
            "source": view.get("source"),
            "detail": window.get("detail"),
            "manual": None,
            "conflict": False,
        }

    for entry in membership.get("manual_exhaustions") or []:
        if not isinstance(entry, dict):
            continue
        scope = entry.get("scope") or {}
        sid = str(scope.get("id") or "")
        evaluated = evaluate_exhaustion(entry, provider_windows=view.get("windows") or [],
                                        plan=plan, provider_state=view.get("state", "absent"), at=moment)
        if evaluated["status"] == "cleared":
            continue
        if evaluated["status"] == "expired":
            # A known reset instant has passed: the mark is auto-cleared. It stays
            # in the document for the audit trail but must not render as a live
            # manual row — say so instead of letting it disappear silently.
            auto_cleared.append(scope.get("label") or sid)
            continue
        row = rows.get(sid)
        if row is None:
            row = {
                "id": sid,
                "label": scope.get("label") or sid,
                "scope": scope.get("kind") or "window",
                "used_percent": (100.0 if evaluated["status"] == "active" else None),
                "used_percent_from": ("manual" if evaluated["status"] == "active" else None),
                "reset_at": entry.get("reset_at"),
                "state": "manual",
                "basis": ["manual"],
                "source": "you",
                "detail": entry.get("note"),
                "manual": evaluated,
                "conflict": False,
            }
            rows[sid] = row
        else:
            row["basis"] = [*row["basis"], "manual"]
            row["manual"] = evaluated
            row["conflict"] = evaluated["status"] == "contradicted"
            row["state"] = "manual" if evaluated["status"] in ("active", "reconfirm_due") else row["state"]
            if row.get("used_percent") is None and evaluated["status"] == "active":
                row["used_percent"] = 100.0
                row["used_percent_from"] = "manual"

    for window in ((plan or {}).get("entitlements") or {}).get("windows") or []:
        wid = str(window.get("id") or "")
        if not wid or wid in rows:
            continue
        rows[wid] = {
            "id": wid,
            "label": window.get("label") or wid,
            "scope": window.get("scope", "account"),
            "used_percent": None,
            "reset_at": None,
            "state": "no_data",
            "basis": ["none"],
            "source": None,
            "detail": "No provider reporting for this window.",
            "manual": None,
            "conflict": False,
        }

    ordered = sorted(rows.values(), key=lambda r: (0 if r["scope"] == "account" else 1, r["id"]))
    notes = list(view.get("notes") or [])
    if auto_cleared:
        notes.append("Cleared automatically because their reset time passed: " + ", ".join(auto_cleared) + ".")
    return {
        "provider_state": view.get("state", "absent"),
        "provider_source": view.get("source"),
        "age_seconds": view.get("age_seconds"),
        "plan_hint": view.get("plan_hint"),
        "windows": ordered,
        "account_exhausted": account_exhausted({"windows": ordered}),
        "model_exhausted": model_exhausted({"windows": ordered}),
        "has_provider_reporting": bool(view.get("windows")),
        "conflicts": [r["id"] for r in ordered if r.get("conflict")],
        "auto_cleared": auto_cleared,
        "notes": notes,
    }


# ---------------------------------------------------------------------------
# Evidence bundle: four types, never summed
# ---------------------------------------------------------------------------

def evidence_bundle(*, native: Mapping[str, Any] | None, observed: Mapping[str, Any] | None,
                    manual_entries: Iterable[Mapping[str, Any]] = (),
                    api_equivalent: Mapping[str, Any] | None = None,
                    fee: Mapping[str, Any] | None = None,
                    at: Any = None) -> dict[str, Any]:
    """Assemble the four evidence types with their own labels and units.

    ``provider_account_usage`` is the provider's own account reading (percent of
    a limit). ``observed_inference`` is what Hermes and WolfMark saw this
    profile do (tokens, calls). ``manual_exhaustion`` is the owner's statement.
    ``api_equivalent_value`` is a theoretical catalogue price for those tokens.
    They answer different questions and have different units; nothing here adds
    them together.
    """
    moment = _now(at)
    manual = [e for e in manual_entries if isinstance(e, dict)]
    manual_states = [evaluate_exhaustion(e, at=moment) for e in manual]
    fee = fee or {}

    return {
        "as_of": _iso(moment),
        "summable": False,
        "provider_account_usage": {
            "kind": "provider_reported",
            "basis": "confirmed" if (native or {}).get("state") == "live" else (native or {}).get("state", "absent"),
            "source": (native or {}).get("source"),
            "fetched_at": None if native is None else native.get("fetched_at"),
            "age_seconds": (native or {}).get("age_seconds"),
            "identity": (native or {}).get("identity"),
            "unit": "percent_of_limit",
            "windows": [
                {"id": w.get("id"), "label": w.get("label"), "scope": w.get("scope"),
                 "used_percent": w.get("used_percent"), "reset_at": w.get("reset_at")}
                for w in (native or {}).get("windows") or []
            ],
            "not_money": "A quota percentage is a limit, not a charge.",
        },
        "observed_inference": {
            "kind": "observed",
            "basis": "observed",
            "source": "hermes state.db / wolfmark collector",
            "unit": "tokens_and_calls",
            "window": (observed or {}).get("window"),
            "tokens": (observed or {}).get("tokens") or {},
            "calls": (observed or {}).get("calls"),
            "note": "What this profile did, not what the provider billed.",
        },
        "manual_exhaustion": {
            "kind": "manual",
            "basis": "manual",
            "source": "you",
            "unit": "claim",
            "entries": manual_states,
            "note": "Never presented as provider-confirmed; cleared only on a known reset "
                    "instant, otherwise reconfirmed.",
        },
        "api_equivalent_value": {
            "kind": "estimated",
            "basis": (api_equivalent or {}).get("basis", "estimated"),
            "source": "catalogue / official overlay",
            "unit": "USD",
            "usd": (api_equivalent or {}).get("usd"),
            "coverage": (api_equivalent or {}).get("coverage"),
            "note": "A theoretical public price for the same calls, not an invoice.",
        },
        "membership_fee": {
            "kind": "declared" if fee.get("basis") == "declared" else (fee.get("basis") or "no_plan"),
            "basis": "profile",
            "source": "account override" if fee.get("basis") == "declared" else "plan catalogue",
            "amount": (fee.get("effective") or {}).get("amount"),
            "currency": (fee.get("effective") or {}).get("currency"),
            "period": (fee.get("effective") or {}).get("period"),
            "published": fee.get("published"),
            "note": "A recurring fee, counted once per cycle — not per call.",
        },
    }


# ---------------------------------------------------------------------------
# Catalogue maintenance: propose, never publish
# ---------------------------------------------------------------------------

def _window_map(plan: Mapping[str, Any]) -> dict[str, dict[str, Any]]:
    return {w["id"]: w for w in ((plan.get("entitlements") or {}).get("windows") or [])}


def diff_catalogues(old: Mapping[str, Any] | None, new: Mapping[str, Any] | None) -> dict[str, Any]:
    """Classify every change between two catalogue versions.

    Returns a report with ``applied: False``. Material and ambiguous changes
    block promotion until a reviewer records a decision, so a scheduled check can
    never move an active financial rule on its own.
    """
    old_index, new_index = plan_index(old), plan_index(new)
    changes: list[dict[str, Any]] = []

    def add(plan_id: str, field: str, before: Any, after: Any, *, kind: str,
            ambiguous: bool = False) -> None:
        materiality = CHANGE_KINDS.get(kind, "review")
        if ambiguous:
            materiality = "ambiguous"
        action = "auto_note" if materiality == "cosmetic" else "review"
        changes.append({
            "key": f"{plan_id}:{field}",
            "plan_id": plan_id,
            "field": field,
            "kind": kind,
            "materiality": materiality,
            "action": action,
            "before": before,
            "after": after,
        })

    for plan_id in sorted(set(old_index) | set(new_index)):
        before, after = old_index.get(plan_id), new_index.get(plan_id)
        if before is None and after is not None:
            add(plan_id, "plan", None, after.get("name"), kind="plan_added",
                ambiguous=(after.get("verification") or {}).get("status") != "verified")
            continue
        if after is None:
            if before is not None:
                add(plan_id, "plan", before.get("name"), None, kind="plan_removed")
            continue
        if before is None:
            continue

        ambiguous = (after.get("verification") or {}).get("status") != "verified"
        for field in ("amount", "currency", "period"):
            if (before.get("price") or {}).get(field) != (after.get("price") or {}).get(field):
                add(plan_id, f"price.{field}", (before.get("price") or {}).get(field),
                    (after.get("price") or {}).get(field), kind=field if field != "amount" else "price",
                    ambiguous=ambiguous)
        if (before.get("billing_cycle") or {}) != (after.get("billing_cycle") or {}):
            add(plan_id, "billing_cycle", before.get("billing_cycle"), after.get("billing_cycle"),
                kind="billing_cycle", ambiguous=ambiguous)

        old_windows, new_windows = _window_map(before), _window_map(after)
        for wid in sorted(set(old_windows) | set(new_windows)):
            if wid not in old_windows:
                add(plan_id, f"window.{wid}", None, new_windows[wid], kind="window_added",
                    ambiguous=ambiguous)
            elif wid not in new_windows:
                add(plan_id, f"window.{wid}", old_windows[wid], None, kind="window_removed")
            elif old_windows[wid] != new_windows[wid]:
                add(plan_id, f"window.{wid}", old_windows[wid], new_windows[wid],
                    kind="window_changed", ambiguous=ambiguous)

        old_models = (before.get("entitlements") or {}).get("models") or {}
        new_models = (after.get("entitlements") or {}).get("models") or {}
        if old_models != new_models:
            add(plan_id, "entitlements.models", old_models, new_models, kind="model_limits",
                ambiguous=ambiguous)

        old_policy = (before.get("entitlements") or {}).get("reset_policy") or {}
        new_policy = (after.get("entitlements") or {}).get("reset_policy") or {}
        if old_policy != new_policy:
            add(plan_id, "entitlements.reset_policy", old_policy, new_policy,
                kind="reset_policy", ambiguous=ambiguous)

        old_entitlement_verification = (before.get("entitlements") or {}).get("verification") or {}
        new_entitlement_verification = (after.get("entitlements") or {}).get("verification") or {}
        if (old_entitlement_verification.get("status")
                != new_entitlement_verification.get("status")):
            add(plan_id, "entitlements.verification", old_entitlement_verification,
                new_entitlement_verification, kind="verification")

        if (before.get("verification") or {}).get("status") != (after.get("verification") or {}).get("status"):
            add(plan_id, "verification.status", (before.get("verification") or {}).get("status"),
                (after.get("verification") or {}).get("status"), kind="verification")
        if before.get("name") != after.get("name"):
            add(plan_id, "name", before.get("name"), after.get("name"), kind="name")
        if before.get("notes") != after.get("notes"):
            add(plan_id, "notes", before.get("notes"), after.get("notes"), kind="notes")

    material = [c for c in changes if c["materiality"] in ("material", "ambiguous")]
    blocking = [c["key"] for c in material]
    return {
        "from_version": (old or {}).get("catalogue_version"),
        "to_version": (new or {}).get("catalogue_version"),
        "changes": changes,
        "counts": {
            "material": len([c for c in changes if c["materiality"] == "material"]),
            "ambiguous": len([c for c in changes if c["materiality"] == "ambiguous"]),
            "cosmetic": len([c for c in changes if c["materiality"] == "cosmetic"]),
        },
        "blocking": blocking,
        "auto_note": [c["key"] for c in changes if c["action"] == "auto_note"],
        "applied": False,
        "requires_owner": True,
        "note": "Nothing here has been applied. Material and ambiguous changes need a "
                "recorded decision before the catalogue version is promoted.",
    }


def promotion_plan(report: Mapping[str, Any], decisions: Mapping[str, str] | None = None) -> dict[str, Any]:
    """Turn review decisions into a promotion decision (still no writes).

    Every blocking change needs ``accept`` or ``reject``. Rejected material
    changes keep the previous published value, so promotion of the parts that
    were accepted still cannot silently reprice an account.
    """
    decisions = {str(k): str(v).lower() for k, v in (decisions or {}).items()}
    accepted, rejected, pending = [], [], []
    for key in (report or {}).get("blocking") or []:
        decision = decisions.get(key)
        if decision == "accept":
            accepted.append(key)
        elif decision == "reject":
            rejected.append(key)
        else:
            pending.append(key)
    return {
        "promotable": not pending,
        "accepted": accepted,
        "rejected": rejected,
        "pending": pending,
        "requires_owner": True,
        "note": ("All blocking changes decided; the catalogue version may be promoted by a "
                 "reviewed commit." if not pending else
                 "Promotion blocked until every material or ambiguous change is decided."),
    }


# ---------------------------------------------------------------------------
# Membership validation (shared by the future PUT endpoint)
# ---------------------------------------------------------------------------

MEMBERSHIP_FIELDS = {
    "id", "family", "label", "route_slugs", "credential_present", "identity",
    "identity_source", "discovered_at", "plan_id", "plan_hint", "fee_overrides",
    "billing_cycle", "manual_exhaustions", "advanced", "migrated_from", "custom_plan",
    # Written by discovery, so they must survive validation on the next save.
    "catalogue_plans", "usage_source",
}


def validation_errors(membership: Mapping[str, Any]) -> list[str]:
    """Field-level validation with short human messages."""
    errors: list[str] = []
    if not isinstance(membership, dict):
        return ["membership must be an object"]
    unknown = set(membership) - MEMBERSHIP_FIELDS
    if unknown:
        errors.append("unknown fields: " + ", ".join(sorted(unknown)))
    if not str(membership.get("family") or "").strip():
        errors.append("family is required")
    if not str(membership.get("id") or "").strip():
        errors.append("id is required")
    custom_plan = membership.get("custom_plan")
    if custom_plan is not None:
        if not isinstance(custom_plan, dict):
            errors.append("custom plan must be an object")
        else:
            allowed_plan = {"id", "name", "price", "billing_cycle", "allowances",
                            "model_restrictions", "effective_from", "effective_to"}
            unknown_plan = set(custom_plan) - allowed_plan
            if unknown_plan:
                errors.append("unknown custom plan fields: " + ", ".join(sorted(unknown_plan)))
            plan_id = str(custom_plan.get("id") or "")
            if plan_id != f"custom:{membership.get('id')}":
                errors.append("custom plan must belong to this account")
            name = str(custom_plan.get("name") or "").strip()
            if not name or len(name) > 80:
                errors.append("custom plan name is required and must be 80 characters or fewer")
            price = custom_plan.get("price", {})
            if not isinstance(price, dict):
                errors.append("custom plan price must be an object")
            else:
                amount = price.get("amount")
                currency = str(price.get("currency") or "").upper()
                period = str(price.get("period") or "month")
                if amount is not None and (isinstance(amount, bool) or not isinstance(amount, (int, float)) or
                                           not math.isfinite(amount) or amount < 0):
                    errors.append("custom plan fee must be a non-negative number")
                if currency and currency not in CURRENCIES:
                    errors.append("custom plan fee currency is not supported")
                if amount is not None and currency not in CURRENCIES:
                    errors.append("custom plan fee needs a supported currency")
                if period not in PERIODS:
                    errors.append("custom plan period must be one of: " + ", ".join(PERIODS))
            plan_cycle = custom_plan.get("billing_cycle", {})
            if not isinstance(plan_cycle, dict):
                errors.append("custom plan billing cycle must be an object")
            else:
                anchor = plan_cycle.get("anchor_day")
                if anchor is not None and (not isinstance(anchor, int) or isinstance(anchor, bool) or not 1 <= anchor <= 31):
                    errors.append("custom plan billing cycle day must be between 1 and 31")
            allowances = custom_plan.get("allowances", [])
            if not isinstance(allowances, list):
                errors.append("custom plan allowances must be a list")
            else:
                for window in allowances:
                    if not isinstance(window, dict):
                        errors.append("each custom allowance must be an object")
                        continue
                    window_allowed = {"id", "label", "kind", "duration_minutes", "limit", "scope", "amount", "currency"}
                    extra = set(window) - window_allowed
                    if extra:
                        errors.append("unknown custom allowance fields: " + ", ".join(sorted(extra)))
                    if not str(window.get("label") or window.get("id") or "").strip():
                        errors.append("custom allowance needs a name")
                    if str(window.get("kind") or "rolling") not in {"rolling", "billing_cycle", "monthly_credit"}:
                        errors.append("custom allowance kind must be rolling, billing_cycle or monthly_credit")
                    duration = window.get("duration_minutes")
                    if duration is not None and (isinstance(duration, bool) or not isinstance(duration, int) or duration <= 0):
                        errors.append("allowance duration must be a positive number of minutes")
                    window_amount = window.get("amount")
                    if window_amount is not None and (isinstance(window_amount, bool) or
                            not isinstance(window_amount, (int, float)) or not math.isfinite(window_amount) or window_amount < 0):
                        errors.append("allowance amount must be a non-negative number")
                    window_currency = str(window.get("currency") or "").upper()
                    if window_currency and window_currency not in CURRENCIES:
                        errors.append("allowance currency is not supported")
                    if window_amount is not None and window_currency not in CURRENCIES:
                        errors.append("allowance amount needs a supported currency")
                    if str(window.get("scope") or "account") not in WINDOW_SCOPES:
                        errors.append("custom allowance scope must be account or model")
            restrictions = custom_plan.get("model_restrictions", [])
            if not isinstance(restrictions, list) or any(not isinstance(value, str) or not value.strip() for value in restrictions):
                errors.append("model restrictions must be a list of model names")
            for field in ("effective_from", "effective_to"):
                value = custom_plan.get(field)
                if value not in (None, "") and _epoch(value) is None:
                    errors.append(f"custom plan {field.replace('_', ' ')} must be a valid date or timestamp")
            start, end = _epoch(custom_plan.get("effective_from")), _epoch(custom_plan.get("effective_to"))
            if start is not None and end is not None and end <= start:
                errors.append("custom plan end date must be after its start date")
    for override in membership.get("fee_overrides") or []:
        if not isinstance(override, dict):
            errors.append("each fee override must be an object")
            continue
        amount = override.get("amount")
        if amount is not None and (isinstance(amount, bool) or not isinstance(amount, (int, float))):
            errors.append("override amount must be a number")
        currency = str(override.get("currency") or "").upper()
        if currency and currency not in CURRENCIES:
            errors.append(f"unsupported currency: {currency}")
        if amount is not None and not currency:
            errors.append("an override amount needs a currency")
        reason = str(override.get("reason") or "")
        if reason and reason not in OVERRIDE_REASONS:
            errors.append("override reason must be one of: " + ", ".join(OVERRIDE_REASONS))
        cycle = override.get("billing_cycle") or {}
        day = cycle.get("anchor_day")
        if day is not None and (not isinstance(day, int) or isinstance(day, bool) or not 1 <= day <= 31):
            errors.append("billing cycle day must be between 1 and 31")
        start, end = _epoch(override.get("effective_from")), _epoch(override.get("effective_to"))
        if start and end and end <= start:
            errors.append("override effective_to must be after effective_from")
    cycle = membership.get("billing_cycle") or {}
    day = cycle.get("anchor_day")
    if day is not None and (not isinstance(day, int) or isinstance(day, bool) or not 1 <= day <= 31):
        errors.append("billing cycle day must be between 1 and 31")
    source = str(membership.get("usage_source") or "none")
    if source not in USAGE_SOURCES:
        errors.append("usage_source must be one of: " + ", ".join(USAGE_SOURCES))
    plans = membership.get("catalogue_plans")
    if plans is not None and (isinstance(plans, bool) or not isinstance(plans, int) or plans < 0):
        errors.append("catalogue_plans must be a non-negative integer")
    return errors


def cycle_bounds(membership: Mapping[str, Any], plan: Mapping[str, Any] | None = None,
                 at: Any = None) -> dict[str, Any]:
    """Calendar bounds of the membership's billing cycle (UTC, anchor day).

    Precedence: the membership's own cycle, then the plan's, then day 1. The
    anchor is clamped to the month length, so a day-31 cycle works in February.
    """
    moment = _now(at)
    anchor = (membership.get("billing_cycle") or {})
    active = active_override(membership, moment)
    override_cycle = (active or {}).get("billing_cycle") or {}
    plan_cycle = ((plan or {}).get("billing_cycle") or {})
    day = (override_cycle.get("anchor_day") or anchor.get("anchor_day")
           or plan_cycle.get("anchor_day") or 1)
    source = ("account_override" if override_cycle.get("anchor_day")
              else "account" if anchor.get("anchor_day") else "catalogue")
    day = max(1, min(int(day), 31))
    now_dt = datetime.fromtimestamp(moment, timezone.utc)

    def clamp(year: int, month: int) -> datetime:
        return datetime(year, month, min(day, calendar.monthrange(year, month)[1]), tzinfo=timezone.utc)

    start = clamp(now_dt.year, now_dt.month)
    if now_dt < start:
        start = clamp(now_dt.year - 1, 12) if now_dt.month == 1 else clamp(now_dt.year, now_dt.month - 1)
    end = clamp(start.year + 1, 1) if start.month == 12 else clamp(start.year, start.month + 1)
    return {"start": start.isoformat().replace("+00:00", "Z"),
            "end": end.isoformat().replace("+00:00", "Z"),
            "anchor_day": day, "source": source}
