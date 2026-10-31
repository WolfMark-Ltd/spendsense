"""Composition layer for the membership endpoints.

Keeps the FastAPI module thin and lets the whole payload be tested without a
server. Everything here is read-only except the three write paths, which go
through :mod:`wolfmark_ledger.membership_store` (validated, locked, revisioned).

The four numbers a card shows are never summed: subscription fee, provider
account usage, observed inference and theoretical API-equivalent value.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Mapping, Optional

from . import discovery
from . import membership as mem
from . import membership_store as store

CATALOGUE_PATH = Path(__file__).resolve().parent.parent / "catalogue" / "plans.json"


def plans_path() -> Path:
    return CATALOGUE_PATH


def load_plans(path: Optional[Path | str] = None) -> dict[str, Any]:
    return mem.load_plan_catalogue(Path(path) if path else plans_path())


def _plan_for(account: Mapping[str, Any], catalogue: Mapping[str, Any]) -> Optional[dict[str, Any]]:
    plan_id = str(account.get("plan_id") or "").strip()
    if not plan_id:
        return None
    return mem.plan_index(catalogue).get(plan_id)


def account_card(account: Mapping[str, Any], catalogue: Mapping[str, Any],
                 snapshot: Optional[Mapping[str, Any]] = None, *, at: Any = None) -> dict[str, Any]:
    """One account, with its plan, effective fee and quota rows resolved."""
    custom = mem.custom_plan_view(account)
    selected_id = str(account.get("plan_id") or "")
    plan = custom if custom and custom.get("id") == selected_id else _plan_for(account, catalogue)
    native = mem.native_usage(snapshot, account, at=at)
    fee = mem.resolve_fee(account, catalogue, at=at)
    quota = mem.quota_view(account, native, plan, at=at)
    eligible, excluded = mem.selectable_plans(catalogue, str(account.get("family") or ""), requires_api=True)
    if custom:
        eligible = [*eligible, custom]
    reconfirmation = mem.plan_reconfirmation(account, catalogue, snapshot)
    proposal = mem.propose_plan(snapshot, catalogue, str(account.get("family") or ""))
    blocked = {p["id"] for p in excluded}
    if proposal and proposal.get("plan_id") in blocked:
        # Never propose a plan the route cannot use: Go is a real plan, but it
        # carries no Provider API access.
        proposal = {**proposal, "plan_id": None, "confidence": "blocked", "blocked_plan_id": proposal["plan_id"],
                    "reason": "the suggested plan does not cover this route"}
    return {
        **dict(account),
        "plan": plan,
        "fee": fee,
        "quota": quota,
        "plan_proposal": proposal,
        "plan_reconfirmation": reconfirmation,
        # The pane renders these directly, so eligibility is decided once, here.
        "plan_choices": eligible,
        "excluded_plans": [{"id": p["id"], "name": p.get("name"), "reasons": p["eligibility"]["reasons"]}
                           for p in excluded],
        "cycle": mem.cycle_bounds(account, plan, at=at),
        "native_state": native.get("state"),
    }


def accounts_payload(*, native: bool = False, path: Optional[Path | str] = None,
                     catalogue: Optional[Mapping[str, Any]] = None,
                     home: Optional[Path | str] = None, at: Any = None,
                     native_snapshots: Optional[Mapping[str, Any]] = None) -> dict[str, Any]:
    """Stored accounts with quota. ``native`` uses Hermes' own readings."""
    book = catalogue or load_plans()
    data = store.load_store(path)
    if data.get("error"):
        # A corrupt store is not "no memberships": say so, and let the caller
        # surface a read error instead of an empty, confident list.
        raise store.StoreUnreadable(str(data["error"]))
    snapshots: dict[str, Any] = {}
    if native_snapshots is not None:
        snapshots = {str(family): snapshot
                     for family, snapshot in dict(native_snapshots).items()}
    notes: list[str] = []
    if native and native_snapshots is None:
        families = list(dict.fromkeys(str(account.get("family") or "")
                                      for account in data.get("accounts", []) if account.get("family")))
        for family, probe in discovery.probe_providers(families, home=home).items():
            snapshots[family] = probe.get("snapshot")
            if probe["state"] == "unavailable":
                notes.append(f"{family}: Hermes reported no account usage.")
            elif probe["state"] == "error":
                notes.append(f"{family}: usage read failed ({probe['reason']}).")
    cards = [account_card(a, book, snapshots.get(str(a.get("family") or "")), at=at)
             for a in data.get("accounts", [])]
    return {
        "ok": True,
        "catalogue_version": book.get("catalogue_version"),
        "accounts": cards,
        "store": {"loaded": data.get("loaded"), "error": data.get("error") or "", "path": data.get("path")},
        "native_probe": bool(native),
        "notes": notes,
    }


def fee_summary_payload(*, path: Optional[Path | str] = None,
                        catalogue: Optional[Mapping[str, Any]] = None,
                        at: Any = None) -> dict[str, Any]:
    book = catalogue or load_plans()
    data = store.load_store(path)
    if data.get("error"):
        raise store.StoreUnreadable(str(data["error"]))
    entries = []
    totals: dict[str, float] = {}
    for account in data.get("accounts", []):
        card = account_card(account, book, at=at)
        fee = card.get("fee") or {}
        effective = fee.get("effective") or {}
        amount = effective.get("amount")
        if amount is None:
            continue
        currency = str(effective.get("currency") or "").upper()
        period = str(effective.get("period") or "month")
        if not currency:
            continue
        key = f"{currency}/{period}"
        totals[key] = round(totals.get(key, 0.0) + float(amount), 6)
        entries.append({
            "account_id": account.get("id"),
            "label": account.get("label") or account.get("family"),
            "family": account.get("family"),
            "plan_id": account.get("plan_id"),
            "plan_name": (card.get("plan") or {}).get("name"),
            "amount": float(amount),
            "currency": currency,
            "period": period,
            "basis": fee.get("basis"),
            "source": (effective.get("source") or "none"),
            "allowances": [
                {"id": window.get("id"), "label": window.get("label"),
                 "kind": window.get("kind"), "duration_minutes": window.get("duration_minutes"),
                 "amount": window.get("amount"), "currency": window.get("currency"),
                 "limit": window.get("limit")}
                for window in ((card.get("plan") or {}).get("entitlements") or {}).get("windows", [])
                if isinstance(window, dict)
            ],
            "model_restrictions": ((card.get("plan") or {}).get("entitlements") or {}).get("models") or {},
            "effective_from": ((card.get("plan") or {}).get("effective") or {}).get("effective_from"),
            "effective_to": ((card.get("plan") or {}).get("effective") or {}).get("effective_to"),
            "published": fee.get("published"),
            "provenance": fee.get("provenance") or [],
        })
    return {
        "catalogue_version": book.get("catalogue_version"),
        "fees": entries,
        "totals": [{"currency": key.split("/", 1)[0],
                    "period": key.split("/", 1)[1], "amount": value}
                   for key, value in sorted(totals.items())],
        "totals_by_currency_period": totals,
    }


def plans_payload(catalogue: Optional[Mapping[str, Any]] = None) -> dict[str, Any]:
    book = catalogue or load_plans()
    families: dict[str, dict[str, Any]] = {}
    for plan in book.get("plans", []):
        family = str(plan.get("provider_family"))
        block = families.setdefault(family, {"family": family, "plans": []})
        block["plans"].append(plan)
    return {
        "ok": True,
        "catalogue_version": book.get("catalogue_version"),
        "generated_at": book.get("generated_at"),
        "sources": book.get("sources") or [],
        "families": [families[k] for k in sorted(families)],
        # The values PUT/POST accept. The pane renders from this rather than
        # hard-coding a list that can drift from the model and 422 on save.
        "vocabulary": {
            "override_reasons": list(mem.OVERRIDE_REASONS),
            "currencies": list(mem.CURRENCIES),
            "periods": list(mem.PERIODS),
            "window_scopes": list(mem.WINDOW_SCOPES),
        },
        "totals": {
            "plans": len(book.get("plans") or []),
            "families": len(families),
            "verified": sum(1 for p in book.get("plans") or []
                            if p["price"]["amount"] is not None and p["verification"]["status"] == "verified"),
            "provisional": sum(1 for p in book.get("plans") or []
                               if p["price"]["amount"] is not None and p["verification"]["status"] == "provisional"),
            "placeholders": sum(1 for p in book.get("plans") or [] if p["price"]["amount"] is None),
        },
    }


def discover_payload(*, include_native: bool = False, path: Optional[Path | str] = None,
                     catalogue: Optional[Mapping[str, Any]] = None,
                     home: Optional[Path | str] = None) -> dict[str, Any]:
    """Find configured accounts and merge them into the store."""
    book = catalogue or load_plans()
    found = discovery.discover(book, include_native=include_native, home=home)
    merged = store.upsert_discovered(found["accounts"], path)
    shared_snapshots = (found or {}).get("snapshots") if include_native else None
    payload = accounts_payload(native=include_native, path=path, catalogue=book, home=home,
                               native_snapshots=shared_snapshots)
    payload.update({
        "discovered": len(found["accounts"]),
        "added": merged.get("added", []),
        "updated": merged.get("updated", []),
        "slots": found.get("slots") or {},
        "catalogued_without_credential": found.get("catalogued_without_credential") or [],
        "notes": [*found.get("notes", []), *payload.get("notes", [])],
    })
    return payload


#: Fields the account card *derives* at read time. A client that echoes back the
#: object it was given must not fail validation, but it also must not be able to
#: persist a computed value — so these are stripped, and anything else unknown is
#: still rejected.
DERIVED_FIELDS = frozenset({
    "plan", "fee", "quota", "cycle", "plan_proposal", "plan_reconfirmation", "native_state", "rev",
    # Route-eligibility lists are computed from the catalogue per request, so a
    # card posted back unchanged must not try to persist them.
    "plan_choices", "excluded_plans",
})
# `usage_source` and `catalogue_plans` are written by discovery and re-validated
# on the next save, so they are part of the document rather than derived.


def _document(account: Mapping[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in dict(account).items() if k not in DERIVED_FIELDS}


def save_payload(account_id: str, body: Mapping[str, Any], *, if_rev: Optional[str] = None,
                 path: Optional[Path | str] = None) -> dict[str, Any]:
    """Update an account that this store already knows about.

    ``must_exist`` is deliberate: accounts arrive through discovery, so a PUT for
    an unknown id is either a stale card from another gateway or a mistake. Either
    way it must not create a record here — it raises ``KeyError`` (→ 404).
    """
    payload = {**_document(body), "id": account_id}
    result = store.save_account(payload, path, if_rev=if_rev or (body or {}).get("rev"),
                                must_exist=True)
    return {"ok": True, "account": result["account"], "accounts": result["accounts"]}


def delete_payload(account_id: str, *, path: Optional[Path | str] = None) -> dict[str, Any]:
    return {"ok": True, **store.delete_account(account_id, path)}


def _load_account(account_id: str, path: Optional[Path | str]) -> dict[str, Any]:
    # strict: a corrupt store must raise, not look like "this account is missing".
    data = store.load_store(path, strict=True)
    account = next((a for a in data.get("accounts", []) if str(a.get("id")) == str(account_id)), None)
    if account is None:
        raise KeyError(account_id)
    return account


def declare_payload(account_id: str, body: Mapping[str, Any], *,
                    path: Optional[Path | str] = None) -> dict[str, Any]:
    """Add a manual exhaustion mark to an account and persist it."""
    account = _load_account(account_id, path)
    entry = mem.declare_exhausted(
        account,
        scope_id=str(body.get("scope_id") or body.get("window") or ""),
        scope_kind=str(body.get("scope_kind") or "window"),
        label=body.get("label"),
        reset_at=body.get("reset_at"),
        note=str(body.get("note") or ""),
    )
    updated = {**account, "manual_exhaustions": [*(account.get("manual_exhaustions") or []), entry]}
    result = store.save_account(updated, path, if_rev=account.get("rev"))
    return {"ok": True, "entry": entry, "account": result["account"]}


def clear_payload(account_id: str, entry_id: str, *, reason: str = "user",
                  path: Optional[Path | str] = None) -> dict[str, Any]:
    account = _load_account(account_id, path)
    entries = account.get("manual_exhaustions") or []
    if not any(str(e.get("id")) == entry_id for e in entries if isinstance(e, dict)):
        raise KeyError(entry_id)
    cleared = [mem.clear_exhaustion(e, reason=reason) if str(e.get("id")) == entry_id else e
               for e in entries if isinstance(e, dict)]
    updated = {**account, "manual_exhaustions": cleared}
    result = store.save_account(updated, path, if_rev=account.get("rev"))
    return {"ok": True, "account": result["account"]}
