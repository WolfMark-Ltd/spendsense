"""Spend Sense backend API.

Mounted by Hermes at ``/api/plugins/spend-sense/`` through the
supported dashboard plugin mechanism (``dashboard/manifest.json`` -> ``api``).
The dashboard's own authentication gate covers these routes; this module adds
no second credential.

Analytics reads Hermes state and the call store read-only. Membership and billing
endpoints can write plugin-owned user data; the collector writes the call store.
Model News is local-first: the snapshot diff never touches the network. Only the
opt-in "Spend Sense Live Updates" setting allows one unauthenticated HTTPS GET
each of the public news and membership-plan feeds, with no user data sent;
see ``wolfmark_ledger.news`` and ``wolfmark_ledger.membership_live``.
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
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
from wolfmark_ledger import allowance_weather  # noqa: E402
from wolfmark_ledger import billing  # noqa: E402
from wolfmark_ledger import digest  # noqa: E402
from wolfmark_ledger import economics  # noqa: E402
from wolfmark_ledger import budgets, forecast  # noqa: E402
from wolfmark_ledger import user_data  # noqa: E402
from wolfmark_ledger import membership_api as members  # noqa: E402
from wolfmark_ledger import monitoring, news as news_mod  # noqa: E402
from wolfmark_ledger.membership import CatalogueError  # noqa: E402
from wolfmark_ledger.membership_store import (EntitlementStoreDurabilityError, MembershipConflict,
                                              SeatStoreDurabilityError, StoreUnreadable)  # noqa: E402

log = logging.getLogger(__name__)

router = APIRouter()

VERSION = "0.6.0"

#: Pairing level between the two halves of one release. Every build in this
#: line ships the same ``VERSION`` string, so that string cannot tell two builds
#: apart; this integer is what a Desktop bundle can act on. Bump it in the same
#: commit as any backend change the UI relies on, and raise
#: ``REQUIRED_BACKEND_CONTRACT`` in ``desktop/plugin.js`` to match.
API_CONTRACT = 3

_REVISION_RE = re.compile(r"^[0-9a-f]{40}$")

#: ``((path, mtime_ns, size), digest)`` of a Desktop half already hashed by :func:`_desktop_bundle_sha256`.
_desktop_digest: tuple[tuple[str, int, int], str] | None = None


def _read_optional_text(path: Path) -> str:
    """Text of *path*, or ``''``. Health must stay total, so every read is optional."""
    try:
        return path.read_text(encoding="utf-8-sig", errors="replace")
    except OSError:
        return ""


def _git_head_revision(root: Path) -> str | None:
    """The checked-out commit, read from Git's own files rather than a subprocess.

    ``hermes plugins install`` leaves a detached checkout, so ``.git/HEAD``
    usually holds the SHA itself. A branch checkout names a ref, which may be a
    loose file or a line in ``packed-refs``.
    """
    git = root / ".git"
    head = _read_optional_text(git / "HEAD").strip()
    if not head:
        return None
    if head.startswith("ref:"):
        ref = head[4:].strip()
        revision = _read_optional_text(git / ref).strip()
        if not revision:
            for line in _read_optional_text(git / "packed-refs").splitlines():
                parts = line.strip().split()
                if len(parts) == 2 and parts[1] == ref:
                    revision = parts[0]
                    break
    else:
        revision = head
    return revision if _REVISION_RE.match(revision) else None


def _installer_revision(root: Path) -> str | None:
    """The revision an installer recorded, for a tree that carries no ``.git``."""
    try:
        catalog = json.loads((root / ".hermes-catalog.json").read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        catalog = None
    if isinstance(catalog, dict):
        recorded = catalog.get("sha")
        if isinstance(recorded, str) and _REVISION_RE.match(recorded):
            return recorded
    try:
        registry = json.loads((root.parent / ".install-metadata.json").read_text(encoding="utf-8-sig"))
        recorded = (registry.get(root.name) or {}).get("revision")
    except (OSError, ValueError, AttributeError):
        return None
    return recorded if isinstance(recorded, str) and _REVISION_RE.match(recorded) else None


def _desktop_bundle_sha256(root: Path) -> str | None:
    """SHA-256 of the Desktop half this release ships.

    The Desktop app cannot hash its own bundle, so a pair is only provable across
    hosts if one half publishes the other's digest. This is the digest of
    ``desktop/plugin.js`` in *this* tree: the bundle the same commit released.

    Health is polled, so the digest is cached against the file's own stat: an
    install replaced in place changes the key and is re-read.
    """
    global _desktop_digest
    path = root / "desktop" / "plugin.js"
    try:
        entry = path.stat()
    except OSError:
        return None
    key = (str(path), entry.st_mtime_ns, entry.st_size)
    if _desktop_digest is None or _desktop_digest[0] != key:
        try:
            _desktop_digest = (key, hashlib.sha256(path.read_bytes()).hexdigest())
        except OSError:
            return None
    return _desktop_digest[1]


def _build_identity() -> dict[str, Any]:
    """Identity of the installed pair, for ``/health``. Never raises."""
    return {
        "contract": API_CONTRACT,
        "revision": _git_head_revision(_ROOT) or _installer_revision(_ROOT),
        "desktop_sha256": _desktop_bundle_sha256(_ROOT),
    }


def _exists_for_health(path: Path) -> bool:
    """Presence check that keeps health's never-raises contract."""
    try:
        return path.exists()
    except OSError:
        return False


@router.get("/health")
def health() -> dict[str, Any]:
    """Cheap liveness/readiness probe. Never raises.

    ``build`` carries the identity a Desktop bundle needs to tell whether it is
    paired with a backend from the same release: the contract level, the
    revision this tree was checked out at, and the digest of the Desktop half
    the same commit shipped. All three are optional and never raise.
    """
    db = default_db_path()
    event_db = store.event_db_path()
    catalogue = load_catalogue()
    db_present = _exists_for_health(db)
    event_db_present = _exists_for_health(event_db)
    return {
        "ok": db_present or event_db_present,
        "version": VERSION,
        "build": _build_identity(),
        "db_present": db_present,
        "event_db_present": event_db_present,
        "event_db_status": _event_db_status(event_db),
        "rate_card": catalogue.meta(),
    }


def _event_db_status(event_db: Path) -> str:
    """Usability of the usage store: missing, ready, or unreadable.

    Presence alone cannot distinguish an empty-but-valid store from a
    corrupt one, so reporting endpoints need this to explain zero usage
    honestly. Read-only: the probe opens, validates and closes.
    """
    try:
        event_db.stat()
    except (FileNotFoundError, NotADirectoryError):
        return "missing"
    except OSError:
        return "unreadable"
    try:
        conn = store.connect_reader(event_db)
    except LedgerUnavailable:
        return "unreadable"
    except Exception:  # noqa: BLE001 - health must never raise
        log.error("spend-sense: usage store probe failed")
        return "unreadable"
    if conn is None:  # pragma: no cover - raced deletion between exists() and open
        return "missing"
    try:
        return "ready"
    finally:
        conn.close()


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
            "has_tiers": bool(hit.rate.tiers),
            "provenance": hit.provenance, "source": hit.source,
            "provisional": list(getattr(hit, "provisional", ())),
        }
    return payload


@router.get("/news")
def news(scope: str = "foryou", category: str = "all") -> dict[str, Any]:
    """Stored local news plus the cached central feed. Read-only; no network."""
    try:
        payload = news_mod.news_payload()
        return monitoring.personalise_payload(
            payload, scope=scope, category=category)
    except Exception as exc:  # noqa: BLE001 - report errors must not expose internal details
        log.error("spend-sense: news payload failed")
        raise HTTPException(status_code=500, detail="news unavailable") from exc


@router.post("/news/refresh")
def news_refresh(body: dict[str, Any] | None = None) -> dict[str, Any]:
    """User-triggered refresh: local snapshot diff, then the central fetch if due.

    The local diff never touches the network. The central feed is fetched only
    when "Spend Sense Live Updates" is enabled and the cache is stale; any
    fetch failure keeps the previous cache and is reported in the payload.
    The local diff is throttled to one check per interval unless the body
    passes ``{"force": true}`` for an explicit user refresh.
    """
    options = body or {}
    try:
        payload = news_mod.refresh_payload(
            throttle=bool(options.get("throttled", True)),
            force=bool(options.get("force", False)))
        return monitoring.personalise_payload(payload)
    except Exception as exc:  # noqa: BLE001 - report errors must not expose internal details
        log.error("spend-sense: news refresh failed")
        raise HTTPException(status_code=500, detail="news refresh failed") from exc


@router.put("/news/settings")
def news_settings(body: dict[str, Any]) -> dict[str, Any]:
    """Opt the profile into or out of Spend Sense Live Updates (default off)."""
    try:
        result = news_mod.save_settings(body.get("live_updates"))
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return {"ok": True, **result}


@router.get("/membership/plans")
def membership_plans() -> dict[str, Any]:
    """The sourced plan catalogue, grouped by provider family.

    Read-only; no network. Serves the bundled catalogue, or the cached
    central catalogue when Live Updates is enabled and one is cached.
    """
    try:
        return members.plans_payload()
    except CatalogueError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@router.post("/membership/plans/refresh")
def membership_plans_refresh() -> dict[str, Any]:
    """User-triggered plans refresh: central catalogue fetch if due.

    The central plans feed is fetched only when "Spend Sense Live
    Updates" is enabled and the cache is stale; any fetch failure keeps
    the previous cache and is reported in the payload. Stored
    memberships, fees and selections are never altered.
    """
    try:
        return members.refresh_plans_payload()
    except CatalogueError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001 - report errors must not expose internal details
        log.error("spend-sense: plans refresh failed")
        raise HTTPException(status_code=500, detail="plans refresh failed") from exc


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
    except MembershipConflict as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except SeatStoreDurabilityError as exc:
        raise HTTPException(status_code=503, detail="seat_write_uncertain: reload membership data before retrying") from exc
    except Exception as exc:  # noqa: BLE001 - discovery must fail closed, never 500 with internals
        log.error("spend-sense: discovery failed")
        raise HTTPException(status_code=500, detail="discovery failed") from exc


@router.put("/membership/accounts/{account_id}")
def membership_save(account_id: str, account: dict[str, Any],
                    if_rev: str | None = Query(None)) -> dict[str, Any]:
    """Save an existing membership using its revision token."""
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
    except SeatStoreDurabilityError as exc:
        raise HTTPException(status_code=503, detail="seat_write_uncertain: reload membership data before retrying") from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.put("/membership/accounts/{account_id}/arrangement")
def membership_arrangement_save(account_id: str, body: dict[str, Any]) -> dict[str, Any]:
    try:
        return members.save_arrangement_payload(account_id, body)
    except StoreUnreadable as exc:
        raise _store_unreadable(exc) from exc
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="no such membership in this store") from exc
    except MembershipConflict as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except EntitlementStoreDurabilityError as exc:
        raise HTTPException(status_code=503, detail="entitlement_write_uncertain: reload membership data before retrying") from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.delete("/membership/accounts/{account_id}")
def membership_delete(account_id: str) -> dict[str, Any]:
    """Delete a membership and its associated seat history."""
    try:
        return members.delete_payload(account_id)
    except StoreUnreadable as exc:
        raise _store_unreadable(exc) from exc
    except SeatStoreDurabilityError as exc:
        raise HTTPException(status_code=503, detail="seat_write_uncertain: reload membership data before retrying") from exc


@router.put("/membership/accounts/{account_id}/seats")
def membership_seats_save(account_id: str, body: dict[str, Any]) -> dict[str, Any]:
    """Append a seat revision after checking account and seat revisions."""
    try:
        return members.save_seat_payload(account_id, body)
    except StoreUnreadable as exc:
        raise _store_unreadable(exc) from exc
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="no such membership") from exc
    except MembershipConflict as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except SeatStoreDurabilityError as exc:
        raise HTTPException(status_code=503, detail="seat_write_uncertain: reload membership data before retrying") from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


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


@router.get("/economics/summary")
def economics_summary(
    days: int = Query(30, ge=1, le=365, description="Trailing usage window in days"),
    trend_months: int = Query(6, ge=0, le=6, description="Calendar months of fee-vs-usage trend"),
) -> dict[str, Any]:
    """Subscription fees vs attributed API-equivalent usage.

    Read-only: fees resolve from the membership store and plans catalogue,
    usage from the timestamped call store. Currencies are never combined
    without an explicit user-supplied FX rate.
    """
    try:
        return economics.build_economics_report(days=days, trend_months=trend_months)
    except StoreUnreadable as exc:
        raise _store_unreadable(exc) from exc
    except CatalogueError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except LedgerUnavailable as exc:
        raise HTTPException(status_code=503, detail="economics call store unavailable") from exc
    except Exception as exc:  # noqa: BLE001 - report errors must not expose internal details
        log.error("spend-sense: economics report failed")
        raise HTTPException(status_code=500, detail="economics report failed") from exc


@router.get("/allowance/weather")
def allowance_weather_report(
    native: bool = Query(False, description="Read account usage through Hermes"),
) -> dict[str, Any]:
    """Allowance pace and runway for every stored account.

    Read-only: cycle position from billing-cycle maths, provider readings when
    probed, and pace forecasts only for USD cost rules with reliable coverage.
    ``native=true`` asks Hermes for its own account reading, like the
    memberships view; it is off by default so a plain render never triggers
    a provider call.
    """
    try:
        return allowance_weather.build_weather_report(native=native)
    except StoreUnreadable as exc:
        raise _store_unreadable(exc) from exc
    except CatalogueError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except LedgerUnavailable as exc:
        raise HTTPException(status_code=503, detail="allowance call store unavailable") from exc
    except Exception as exc:  # noqa: BLE001 - report errors must not expose internal details
        log.error("spend-sense: allowance weather failed")
        raise HTTPException(status_code=500, detail="allowance weather failed") from exc


@router.get("/reports/digest")
def digest_report(
    days: int = Query(30, description="Trailing window in days: 7 or 30"),
    lang: str = Query("en", pattern="^(en|zh)$", description="Report language"),
) -> dict[str, Any]:
    """A readable Markdown digest assembled from existing reports.

    Read-only: usage, value, spending, fees and allowance figures are
    transmitted from the analytics, economics and weather builders. Only
    stored data is reported; provider readings are never probed.
    """
    if days not in (7, 30):
        raise HTTPException(status_code=400, detail="days must be 7 or 30")
    try:
        return digest.build_digest(days=days, lang=lang)
    except StoreUnreadable as exc:
        raise _store_unreadable(exc) from exc
    except CatalogueError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except LedgerUnavailable as exc:
        raise HTTPException(status_code=503, detail="digest call store unavailable") from exc
    except Exception as exc:  # noqa: BLE001 - report errors must not expose internal details
        log.error("spend-sense: digest failed")
        raise HTTPException(status_code=500, detail="digest failed") from exc


@router.get("/membership/fx")
def fx_rates() -> dict[str, Any]:
    """User-supplied FX rates: the only conversion source economics uses."""
    doc = economics.load_fx()
    if doc.get("error"):
        raise HTTPException(status_code=503, detail=doc["error"])
    return {"ok": True, **doc}


@router.put("/membership/fx")
def fx_save(body: dict[str, Any]) -> dict[str, Any]:
    """Replace the whole FX document. Every rate needs a date and a source."""
    try:
        result = economics.save_fx(body.get("rates", []))
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return {"ok": True, **result}


@router.get("/billing/summary")
def billing_summary(days: int = Query(30, ge=1, le=365)) -> dict[str, Any]:
    """Billing evidence, pricing provenance and coverage; no charts."""
    span = days
    for profile in billing.load_profiles().get("profiles", []):
        if profile.get("billing_cycle"):
            span = max(span, 32)
    try:
        report = build_analytics_report(days=span)
    except LedgerUnavailable as exc:
        raise HTTPException(status_code=503, detail="billing call store unavailable") from exc
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
    """Clear plugin-entered settings only after explicit recovery confirmation."""
    if body.get("confirm") != "RESET_USER_ENTERED_DATA":
        raise HTTPException(status_code=400, detail="explicit confirmation is required")
    try:
        result = user_data.reset_user_data()
    except (StoreUnreadable, billing.ProfileStoreUnreadable, budgets.BudgetStoreUnreadable) as exc:
        raise HTTPException(status_code=503, detail=f"store_unreadable: {exc}") from exc
    except OSError as exc:
        raise HTTPException(
            status_code=503,
            detail="reset_uncertain: reload and verify user data before retrying",
        ) from exc
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


# Advisory only: none of these routes can interrupt provider calls.
def _budget_call(operation):
    """Translate budget errors into API statuses without leaking storage details."""
    try:
        return operation()
    except budgets.BudgetConflict as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except budgets.BudgetStoreUnreadable as exc:
        raise HTTPException(status_code=503, detail='budget_store_unreadable') from exc
    except budgets.BudgetStoreDurabilityError as exc:
        raise HTTPException(status_code=503,
                            detail='budget_write_uncertain: reload budget settings before retrying') from exc
    except KeyError as exc:
        raise HTTPException(status_code=404, detail='budget_not_found') from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except OSError as exc:
        raise HTTPException(status_code=503, detail='budget_store_unavailable') from exc
    except Exception as exc:
        log.error('spend-sense: budget operation failed')
        raise HTTPException(status_code=500, detail='budget_operation_failed') from exc


@router.get('/budgets')
def budget_list():
    """Return local budget configuration and its concurrency revision."""
    return _budget_call(lambda: {'ok': True, **budgets.load()})


@router.get('/budgets/status')
@router.get('/forecast')
def budget_status():
    """Return monthly statuses, forecasts and explicit evidence refusal states."""
    return _budget_call(forecast.build_report)


@router.put('/budgets/{budget_id}')
def budget_save(budget_id: str, body: dict[str, Any], if_rev: str = Query(...)):
    """Create or replace one budget only at the supplied store revision."""
    return _budget_call(lambda: {'ok': True, **budgets.mutate(budget_id, budget=body, if_rev=if_rev)})


@router.delete('/budgets/{budget_id}')
def budget_delete(budget_id: str, if_rev: str = Query(...)):
    """Remove one budget only if the caller holds the current revision."""
    return _budget_call(lambda: {'ok': True, **budgets.mutate(budget_id, if_rev=if_rev)})


@router.post('/budgets/{budget_id}/dismiss')
def budget_dismiss(budget_id: str, body: dict[str, Any], if_rev: str = Query(...)):
    """Persist a cycle-scoped local alert dismissal with revision protection."""
    def dismiss():
        """Validate the current monthly cycle before storing its dismissal."""
        import time
        doc = budgets.load()
        budget = next((b for b in doc['budgets'] if b['id'] == budget_id), None)
        if budget is None:
            raise KeyError(budget_id)
        if budget['scope'] == 'session' or body.get('cycle') != forecast.cycle_bounds(budget, time.time())['id']:
            raise ValueError('dismissal must refer to the current monthly cycle')
        return {'ok': True, **budgets.mutate(budget_id, if_rev=if_rev, dismissal=body)}
    return _budget_call(dismiss)
