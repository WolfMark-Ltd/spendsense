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
from . import membership_live as live
from . import membership_store as store
from . import news as news_mod

CATALOGUE_PATH = Path(__file__).resolve().parent.parent / "catalogue" / "plans.json"


def plans_path() -> Path:
    return CATALOGUE_PATH


def load_plans(path: Optional[Path | str] = None) -> dict[str, Any]:
    return mem.load_plan_catalogue(Path(path) if path else plans_path())


def _select_book(catalogue, settings: Mapping[str, Any],
                 central: Mapping[str, Any]) -> tuple[dict[str, Any], str]:
    """One catalogue-selection rule for every read path.

    An explicitly supplied catalogue always wins. Otherwise the validated
    live catalogue is used when Live Updates is enabled and cached —
    unless it is proven older than the bundled copy, in which case the
    bundled catalogue is served so Live Updates can never downgrade the
    plans. Returns ``(book, source)``.
    """
    if catalogue is not None:
        return catalogue, "bundled"
    book = central.get("book")
    if (settings.get("live_updates") is True and isinstance(book, dict)
            and book.get("plans")):
        try:
            bundled = load_plans()
        except Exception:
            # A broken bundled file must not take Live Updates down with
            # it: serve the validated live copy, as before the guard.
            return book, "live"
        if live.central_is_stale(book, bundled):
            return bundled, "bundled"
        return book, "live"
    return load_plans(), "bundled"


def _live_held_back(settings: Mapping[str, Any],
                    central: Mapping[str, Any]) -> bool:
    """Whether the staleness guard held a live copy back for this read."""
    book = central.get("book")
    if not (settings.get("live_updates") is True
            and isinstance(book, dict) and book.get("plans")):
        return False
    try:
        return live.central_is_stale(book, load_plans())
    except Exception:
        return False


def active_catalogue(catalogue: Optional[Mapping[str, Any]] = None, *,
                     data_dir: Optional[Path | str] = None) -> tuple[dict[str, Any], str]:
    """The catalogue account cards, fees and plan choices resolve against.

    Explicit catalogue wins; else the validated live catalogue when Live
    Updates is enabled and cached, unless it is proven older than the
    bundled copy; else the bundled catalogue. Corrupt or missing settings
    and caches fall back to bundled, never raise.
    """
    settings = news_mod.load_settings(news_mod.settings_path(data_dir))
    central = live.load_cache(live.cache_path(data_dir))
    return _select_book(catalogue, settings, central)


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
    arrangement = mem.billing_arrangement(account)
    quota = mem.quota_view(account, native, plan if arrangement == "subscription" else None, at=at)
    family = str(account.get("family") or "")
    # Nous Portal OAuth uses its Hermes subscription; separate API keys use
    # metered credits. An account slot does not establish which credential it has.
    eligible, excluded = mem.selectable_plans(catalogue, family, requires_api=family != "nous")
    if custom:
        eligible = [*eligible, custom]
    # One snapshot serves a whole family: plan guidance must not read another
    # account's label. native_usage already made the identity call above.
    plan_snapshot = None if native.get("state") == "identity_mismatch" else snapshot
    reconfirmation = mem.plan_reconfirmation(account, catalogue, plan_snapshot)
    proposal = mem.propose_plan(plan_snapshot, catalogue, str(account.get("family") or ""))
    blocked = {p["id"] for p in excluded}
    if proposal and proposal.get("plan_id") in blocked:
        # Never propose a plan the route cannot use: Go is a real plan, but it
        # carries no Provider API access.
        proposal = {**proposal, "plan_id": None, "confidence": "blocked", "blocked_plan_id": proposal["plan_id"],
                    "reason": "the suggested plan does not cover this route"}
    return {
        **dict(account),
        "plan": plan if arrangement == "subscription" else None,
        "effective_arrangement": arrangement,
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
                     data_dir: Optional[Path | str] = None,
                     native_snapshots: Optional[Mapping[str, Any]] = None) -> dict[str, Any]:
    """Stored accounts with quota. ``native`` uses Hermes' own readings."""
    book, _source = active_catalogue(catalogue or None, data_dir=data_dir)
    data = store.load_with_seats(path)
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
        "membership_store": data["membership_store"],
        "seat_store": data["seat_store"],
        "store": {"loaded": data.get("loaded"), "error": data.get("error") or "", "path": data.get("path")},
        "native_probe": bool(native),
        "notes": notes,
    }


def fee_summary_payload(*, path: Optional[Path | str] = None,
                        catalogue: Optional[Mapping[str, Any]] = None,
                        data_dir: Optional[Path | str] = None,
                        at: Any = None) -> dict[str, Any]:
    """Summarise effective membership fees by currency and billing period."""
    book, _source = active_catalogue(catalogue or None, data_dir=data_dir)
    data = store.load_with_seats(path)
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


def plans_payload(catalogue: Optional[Mapping[str, Any]] = None, *,
                  data_dir: Optional[Path | str] = None) -> dict[str, Any]:
    """The sourced plan catalogue, grouped by provider family.

    An explicitly supplied catalogue is always served. Otherwise the
    bundled ``catalogue/plans.json`` is the default; when Live Updates is
    enabled and a validated central catalogue is cached, that copy is
    served instead — unless it is proven older than the bundled copy, in
    which case the bundled copy is served and ``central.held_back`` is
    true. The ``source`` and ``central`` fields say which copy this is
    and how fresh the central one is.
    """
    settings = news_mod.load_settings(news_mod.settings_path(data_dir))
    central = live.load_cache(live.cache_path(data_dir))
    central_book = central.get("book")
    book, source = _select_book(catalogue, settings, central)
    families: dict[str, dict[str, Any]] = {}
    for plan in book.get("plans", []):
        family = str(plan.get("provider_family"))
        block = families.setdefault(family, {"family": family, "plans": []})
        block["plans"].append(plan)
    central_version = central_book.get("catalogue_version") \
        if isinstance(central_book, dict) else None
    central_state = central.get("state")
    if settings.get("live_updates") is not True:
        central_state = "disabled_cached" if central_book else "disabled"
    return {
        "ok": True,
        "source": source,
        "catalogue_version": book.get("catalogue_version"),
        "generated_at": book.get("generated_at"),
        "sources": book.get("sources") or [],
        "central": {
            "state": central_state,
            "fetched_at": central.get("fetched_at") or "",
            "error": central.get("error") or "",
            "catalogue_version": central_version,
            # An explicitly supplied catalogue wins by caller choice, not
            # by the staleness guard: only report a holdback when the
            # selection actually weighed the live copy against bundled.
            "held_back": catalogue is None and _live_held_back(settings, central),
        },
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


def refresh_plans_payload(*, data_dir: Optional[Path | str] = None,
                          now: Optional[float] = None,
                          fetch: bool = True) -> dict[str, Any]:
    """User-triggered plans refresh: central fetch if due, then the payload.

    The central feed is fetched only when "Spend Sense Live Updates" is
    enabled and the cache is stale; any fetch failure keeps the previous
    cache and is reported in the payload. Stored memberships, fees and
    selections are never altered. Pass ``fetch=False`` for a read-only
    re-render of the currently cached state.
    """
    if fetch:
        live.fetch_central(data_dir=data_dir, now=now)
    return plans_payload(data_dir=data_dir)


def discover_payload(*, include_native: bool = False, path: Optional[Path | str] = None,
                     catalogue: Optional[Mapping[str, Any]] = None,
                     home: Optional[Path | str] = None,
                     data_dir: Optional[Path | str] = None) -> dict[str, Any]:
    """Find configured accounts and merge them into the store."""
    book, _source = active_catalogue(catalogue or None, data_dir=data_dir)
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
    "plan", "fee", "quota", "cycle", "effective_arrangement", "plan_proposal", "plan_reconfirmation", "native_state", "rev",
    # Route-eligibility lists are computed from the catalogue per request, so a
    # card posted back unchanged must not try to persist them.
    "plan_choices", "excluded_plans", "seat_revisions", "seat_rev",
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


def save_seat_payload(account_id: str, body: Mapping[str, Any], *,
                      path: Optional[Path | str] = None) -> dict[str, Any]:
    """Validate a seat update and append it to the profile sidecar."""
    if set(body) != {"revision", "rev", "seat_rev"} or not isinstance(body.get("revision"), dict):
        raise ValueError("seat update needs a revision and both revision tokens")
    revision = body["revision"]
    errors = mem.seat_revision_errors([revision])
    if errors:
        raise ValueError("; ".join(errors))
    if revision.get("quantity") is not None:
        book, _ = active_catalogue()
        plan = mem.plan_index(book).get(revision.get("plan_id"))
        if (not plan or plan.get("billing_arrangement") != "recurring_subscription"
                or not isinstance(plan.get("seat_pricing"), dict)):
            raise ValueError("seat quantity requires a per-seat subscription plan")
    return {"ok": True, **store.append_seat_revision(
        account_id, revision, if_rev=body.get("rev"), if_seat_rev=body.get("seat_rev"), path=path)}


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
