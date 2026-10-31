"""Spend Sense backend API.

Mounted by Hermes at ``/api/plugins/spend-sense/`` through the
supported dashboard plugin mechanism (``dashboard/manifest.json`` -> ``api``).
The dashboard's own authentication gate covers these routes; this module adds
no second credential and no network access.

Analytics reads Hermes state and the call store read-only. Membership and billing
endpoints can write plugin-owned user data; the collector writes the call store.
"""

from __future__ import annotations

import logging
import sys
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Query

# The plugin root is not on sys.path when Hermes imports this file by path.
_ROOT = Path(__file__).resolve().parent.parent
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from wolfmark_ledger import LedgerUnavailable, build_ledger_report, default_db_path, load_catalogue  # noqa: E402
from wolfmark_ledger import store  # noqa: E402
from wolfmark_ledger.analytics import build_analytics_report  # noqa: E402
from wolfmark_ledger import billing  # noqa: E402
from wolfmark_ledger import user_data  # noqa: E402
from wolfmark_ledger import membership_api as members  # noqa: E402
from wolfmark_ledger.membership import CatalogueError  # noqa: E402
from wolfmark_ledger.membership_store import MembershipConflict, StoreUnreadable  # noqa: E402

log = logging.getLogger(__name__)

router = APIRouter()

VERSION = "0.5.0"


@router.get("/health")
def health() -> dict[str, Any]:
    """Cheap liveness/readiness probe. Never raises."""
    db = default_db_path()
    event_db = store.event_db_path()
    catalogue = load_catalogue()
    return {
        "ok": db.exists() or event_db.exists(),
        "version": VERSION,
        "db_present": db.exists(),
        "event_db_present": event_db.exists(),
        "rate_card": catalogue.meta(),
    }


@router.get("/analytics")
def analytics(
    days: int = Query(30, ge=1, le=365, description="Local-calendar window in days"),
    model: str | None = Query(None, description="Exact recorded model"),
    provider: str | None = Query(None, description="Exact recorded billing route"),
    surface: str | None = Query(None, description="Exact recorded surface"),
    task: str | None = Query(None, description="Exact recorded task; main for main-loop calls"),
    parent: str | None = Query(None, description="Operation root session id: parent plus delegated descendants"),
    scope: str | None = Query(None, pattern="^(direct|subagent|auxiliary|unattributed)$",
                              description="Delegation scope, derived read-only from state.db"),
    pricing: str = Query("strict", pattern="^(strict|third_party|approximate)$",
                         description="strict = serving route only; third_party = OpenRouter exact; approximate = cross-provider estimate"),
    presentation: str = Query("both", pattern="^(both|spend|api|accounting)$",
                              description="Which financial measures the dashboard leads with"),
) -> dict[str, Any]:
    """Aggregated timestamped calls only; filters are exact and combined with AND."""
    try:
        return build_analytics_report(days=days, model=model, provider=provider,
                                      surface=surface, task=task,
                                      parent=parent or None, scope=scope or None,
                                      pricing_mode=pricing, presentation=presentation)
    except LedgerUnavailable as exc:
        raise HTTPException(status_code=503, detail="analytics call store unavailable") from exc
    except Exception as exc:  # noqa: BLE001 - report errors must not expose internal details
        log.error("spend-sense: analytics report failed")
        raise HTTPException(status_code=500, detail="analytics report failed") from exc


@router.get("/ledger")
def ledger(
    days: int = Query(30, ge=1, le=365, description="Rolling window in days"),
    basis: str = Query("hybrid", pattern="^(billed|list|hybrid)$",
                       description="billed = recorded charges; list = API-equivalent; hybrid = both"),
) -> dict[str, Any]:
    """Timestamped period report plus the separate cumulative baseline.

    ``totals`` and ``by_*`` cover only calls recorded since installation. The
    all-time ``baseline`` is never added to them; ``reconciliation`` shows how
    captured tokens compare with state.db growth.
    """
    try:
        return build_ledger_report(days=days, basis=basis)
    except LedgerUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001 - a read-only report must fail closed
        log.error("spend-sense: report failed")
        raise HTTPException(status_code=500, detail="ledger report failed") from exc


@router.get("/rates")
def rates(provider: str | None = Query(None), model: str | None = Query(None),
          at: float | None = Query(None, description="Unix time; selects peak/off-peak window")) -> dict[str, Any]:
    """Resolved rate plus catalogue freshness. Read-only; no network."""
    import time as _time
    book = load_catalogue()
    meta = book.meta()
    age = None
    if book.as_of:
        try:
            from datetime import datetime
            age = max(0, int(_time.time() - datetime.fromisoformat(book.as_of).timestamp()))
        except (TypeError, ValueError):
            age = None
    payload: dict[str, Any] = {
        "ok": True,
        "catalogue": {**meta, "as_of": book.as_of, "age_seconds": age,
                      "stale": bool(age is not None and age > 24 * 3600),
                      "verified_at": max((v[1] for v in book.official.values()), default="")},
        "fallback": {"bundled": True, "note": "Desktop uses its bundled snapshot if this endpoint is unavailable"},
    }
    if provider and model:
        hit = book.lookup(provider, model, at=at)
        payload["rate"] = None if not hit else {
            "provider": hit.provider, "model": hit.model, "route_provider": hit.route_provider,
            "input": hit.rate.input, "output": hit.rate.output,
            "cache_read": hit.rate.cache_read, "cache_write": hit.rate.cache_write,
            "provenance": hit.provenance, "source": hit.source,
            "provisional": list(getattr(hit, "provisional", ())),
        }
    return payload


@router.get("/membership/plans")
def membership_plans() -> dict[str, Any]:
    """The sourced plan catalogue, grouped by provider family."""
    try:
        return members.plans_payload()
    except CatalogueError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


def _store_unreadable(exc: StoreUnreadable) -> HTTPException:
    """503 with a machine-readable prefix; the pane turns it into a storage notice."""
    return HTTPException(status_code=503, detail=f"store_unreadable: {exc}")


@router.get("/membership/accounts")
def membership_accounts(native: bool = Query(False, description="Read account usage through Hermes")):
    """Stored memberships with plan, effective fee and merge-free quota rows.

    ``native=true`` asks Hermes for its own account reading. It is off by
    default so a plain render never triggers a provider call.
    """
    try:
        return members.accounts_payload(native=native)
    except StoreUnreadable as exc:
        raise _store_unreadable(exc) from exc
    except CatalogueError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@router.post("/membership/discover")
def membership_discover(native: bool = Query(False, description="Also read account usage through Hermes")):
    """Find configured accounts and merge them into the store."""
    try:
        return members.discover_payload(include_native=native)
    except StoreUnreadable as exc:
        raise _store_unreadable(exc) from exc
    except CatalogueError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001 - discovery must fail closed, never 500 with internals
        log.error("spend-sense: discovery failed")
        raise HTTPException(status_code=500, detail="discovery failed") from exc


@router.put("/membership/accounts/{account_id}")
def membership_save(account_id: str, account: dict[str, Any],
                    if_rev: str | None = Query(None)) -> dict[str, Any]:
    try:
        return members.save_payload(account_id, account, if_rev=if_rev)
    except StoreUnreadable as exc:
        raise _store_unreadable(exc) from exc
    except KeyError as exc:
        # Unknown here means "not in this store", which is what a stale card from
        # another gateway looks like. Never create it implicitly.
        raise HTTPException(status_code=404, detail="no such membership in this store") from exc
    except MembershipConflict as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.delete("/membership/accounts/{account_id}")
def membership_delete(account_id: str) -> dict[str, Any]:
    try:
        return members.delete_payload(account_id)
    except StoreUnreadable as exc:
        raise _store_unreadable(exc) from exc


@router.post("/membership/accounts/{account_id}/exhaustion")
def membership_declare(account_id: str, body: dict[str, Any]) -> dict[str, Any]:
    """Record a manual exhaustion mark. Never presented as provider-confirmed."""
    try:
        return members.declare_payload(account_id, body)
    except StoreUnreadable as exc:
        raise _store_unreadable(exc) from exc
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="no such membership") from exc
    except MembershipConflict as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.delete("/membership/accounts/{account_id}/exhaustion/{entry_id}")
def membership_clear(account_id: str, entry_id: str) -> dict[str, Any]:
    try:
        return members.clear_payload(account_id, entry_id)
    except StoreUnreadable as exc:
        raise _store_unreadable(exc) from exc
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="no such mark") from exc
    except MembershipConflict as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.get("/billing/summary")
def billing_summary(days: int = Query(30, ge=1, le=365)) -> dict[str, Any]:
    """Billing evidence, pricing provenance and coverage; no charts."""
    span = days
    for profile in billing.load_profiles().get("profiles", []):
        if profile.get("billing_cycle"):
            span = max(span, 32)
    report = build_analytics_report(days=span)
    try:
        membership_fees = members.fee_summary_payload()
    except StoreUnreadable as exc:
        raise _store_unreadable(exc) from exc
    billing_report = dict(report.get("billing") or {})
    usd_month = membership_fees.get("totals_by_currency_period", {}).get("USD/month")
    billing_report["subscription_fees_usd"] = usd_month
    billing_report["fees_by_profile"] = {}
    billing_report["membership_fees"] = membership_fees
    billing_report["legacy_membership_arrangements_ignored"] = int(
        billing_report.get("legacy_membership_arrangements_ignored") or 0
    )
    evidence = dict(billing_report.get("evidence") or {})
    evidence["subscription_fee"] = {
        "usd": usd_month,
        "basis": "membership_catalogue_or_declared" if membership_fees.get("fees") else "none",
        "source": "Memberships is the only subscription-fee source; legacy arrangement copies are excluded",
    }
    billing_report["evidence"] = evidence
    return {"ok": True, "window": report.get("window"), "billing": billing_report,
            "scope": {"window_days": span, "cycle_basis": "Memberships fee period and account cycle"},
            "pricing_source": report.get("pricing_source"),
            "pricing_coverage": report.get("pricing_coverage"),
            "totals": report.get("totals")}


@router.get("/billing/profiles")
def billing_profiles() -> dict[str, Any]:
    data = billing.load_profiles()
    return {"ok": True, "profiles": data.get("profiles", []),
            "error": data.get("error") or "", "loaded": bool(data.get("loaded"))}


@router.post("/settings/reset-user-data")
def reset_user_data(body: dict[str, Any]) -> dict[str, Any]:
    if body.get("confirm") != "RESET_USER_ENTERED_DATA":
        raise HTTPException(status_code=400, detail="explicit confirmation is required")
    try:
        result = user_data.reset_user_data()
    except (StoreUnreadable, billing.ProfileStoreUnreadable) as exc:
        raise HTTPException(status_code=503, detail=f"store_unreadable: {exc}") from exc
    return {"ok": True, **result,
            "retained": ["captured usage ledger", "Hermes profile data", "provider credentials", "catalogue"]}


@router.put("/billing/profiles/{profile_id}")
def billing_save(profile_id: str, profile: dict[str, Any],
                 if_rev: str | None = Query(None)) -> dict[str, Any]:
    profile = {**profile, "id": profile_id}
    try:
        result = billing.save_profile(profile, if_rev=if_rev or profile.get("rev"))
    except billing.ProfileConflict as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except billing.ProfileStoreUnreadable as exc:
        raise HTTPException(status_code=503, detail=f"store_unreadable: {exc}") from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return {"ok": True, "profiles": result["profiles"]}


@router.delete("/billing/profiles/{profile_id}")
def billing_delete(profile_id: str) -> dict[str, Any]:
    try:
        return {"ok": True, **billing.delete_profile(profile_id)}
    except billing.ProfileStoreUnreadable as exc:
        raise HTTPException(status_code=503, detail=f"store_unreadable: {exc}") from exc
