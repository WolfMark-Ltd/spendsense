"""Persisted membership documents (account-first).

One account per file entry in ``memberships.json`` under the plugin's data
directory. A membership is *not* a billing profile: it records which plan an
account holds, the owner's fee overrides and manual exhaustion marks. It never
holds a credential, and it never stores a resolved price — that is computed at
read time from the catalogue so a catalogue refresh cannot silently rewrite a
past month.

Writes mirror ``billing.py``: an exclusive file lock around the whole
read-modify-write, an ``os.replace`` swap, and a revision hash so a stale edit is
rejected with 409 rather than overwriting a newer one.
"""

from __future__ import annotations

import errno
import hashlib
import json
import os
import tempfile
import uuid
from pathlib import Path
from typing import Any, Iterable, Mapping, Optional

from . import membership as mem
from .filelock import locked as _locked

STORE_NAME = "memberships.json"
STORE_VERSION = 1
SEAT_STORE_NAME = "membership-seats.json"
SEAT_STORE_VERSION = 1
ENTITLEMENT_STORE_NAME = "membership-entitlements.json"
ENTITLEMENT_STORE_VERSION = 1
ROUTE_ARRANGEMENTS = ("subscription", "prepaid", "api_only", "unconfirmed", "no_plan", "included")


def entitlement_store_path(path: Optional[Path | str] = None) -> Path:
    """Return the entitlement sidecar path beside this profile's membership store."""
    target = Path(path) if path else store_path()
    return target.with_name(ENTITLEMENT_STORE_NAME)


def _route_history_errors(history: Any) -> list[str]:
    """Return validation errors for persisted route-arrangement revisions."""
    errors: list[str] = []
    if not isinstance(history, list):
        return ["route arrangement history must be a list"]
    ids: set[str] = set()
    for item in history:
        if not isinstance(item, dict):
            errors.append("each route arrangement revision must be an object")
            continue
        if set(item) != {"id", "arrangement", "owner_account_id", "owner_family", "owner_identity", "effective_from"}:
            errors.append("route arrangement revision has unexpected fields")
            continue
        stamp = mem._epoch(item.get("effective_from")) if isinstance(item.get("effective_from"), str) else None
        if (not isinstance(item.get("id"), str) or not item["id"].strip()
                or item["id"] in ids or stamp is None):
            errors.append("route arrangement revision needs a unique id and valid effective time")
        if item.get("arrangement") not in ROUTE_ARRANGEMENTS:
            errors.append("route arrangement is invalid")
        if item.get("arrangement") == "included":
            if (not isinstance(item.get("owner_account_id"), str) or not item["owner_account_id"].strip()
                    or not isinstance(item.get("owner_family"), str) or not item["owner_family"].strip()
                    or (item.get("owner_identity") is not None and not isinstance(item.get("owner_identity"), str))):
                errors.append("included route needs a valid owning account")
        elif any(item.get(key) is not None for key in ("owner_account_id", "owner_family", "owner_identity")):
            errors.append("only an included route may have an owning account")
        if isinstance(item.get("id"), str):
            ids.add(item["id"])
    return errors


def load_entitlement_store(path: Optional[Path | str] = None) -> dict[str, Any]:
    """Load and validate a profile's route history, defaulting a missing file to empty."""
    target = entitlement_store_path(path)
    try:
        doc = json.loads(target.read_text(encoding="utf-8"))
        if (not isinstance(doc, dict) or set(doc) != {"version", "routes"}
                or type(doc["version"]) is not int or doc["version"] != ENTITLEMENT_STORE_VERSION
                or not isinstance(doc["routes"], dict)):
            raise ValueError("invalid document")
        for route, entry in doc["routes"].items():
            if (not isinstance(route, str) or not route.strip() or route != route.strip().lower()
                    or not isinstance(entry, dict)
                    or set(entry) != {"account_id", "family", "identity", "baseline_arrangement", "history"}
                    or not isinstance(entry["account_id"], str) or not entry["account_id"].strip()
                    or not isinstance(entry["family"], str) or not entry["family"].strip()
                    or (entry["identity"] is not None and not isinstance(entry["identity"], str))
                    or entry["baseline_arrangement"] not in ("subscription", "prepaid", "api_only", "unconfirmed")
                    or _route_history_errors(entry["history"])):
                raise ValueError("invalid route history")
        return doc
    except FileNotFoundError:
        return {"version": ENTITLEMENT_STORE_VERSION, "routes": {}}
    except (OSError, ValueError, TypeError, KeyError, AttributeError, OverflowError) as exc:
        raise StoreUnreadable("membership entitlement store unreadable") from exc


def entitlement_revision(routes: Mapping[str, Any], slugs: Iterable[str]) -> str:
    """Hash selected route records for arrangement-write concurrency checks."""
    keys = sorted({str(slug).strip().lower() for slug in slugs if str(slug).strip()})
    entry = {slug: routes.get(slug) for slug in keys}
    return hashlib.sha256(json.dumps(entry, sort_keys=True, separators=(",", ":")).encode()).hexdigest()[:12]


def _write_entitlement_store(routes: Mapping[str, Any], target: Path) -> None:
    """Atomically persist validated route history beside the membership file."""
    sidecar = entitlement_store_path(target)
    sidecar.parent.mkdir(parents=True, exist_ok=True)
    document = {"version": ENTITLEMENT_STORE_VERSION, "routes": dict(routes)}
    for route, entry in document["routes"].items():
        if (not isinstance(route, str) or not route.strip() or route != route.strip().lower()
                or not isinstance(entry, dict)
                or set(entry) != {"account_id", "family", "identity", "baseline_arrangement", "history"}
                or entry["baseline_arrangement"] not in ("subscription", "prepaid", "api_only", "unconfirmed")
                or _route_history_errors(entry.get("history"))):
            raise ValueError("invalid route entitlement document")
    handle = tempfile.NamedTemporaryFile("w", dir=sidecar.parent, delete=False, suffix=".tmp", encoding="utf-8")
    try:
        json.dump(document, handle, indent=2, sort_keys=True, allow_nan=False)
        handle.flush()
        os.fsync(handle.fileno())
        handle.close()
        os.replace(handle.name, sidecar)
        try:
            _sync_seat_directory(sidecar.parent)
        except OSError as exc:
            raise EntitlementStoreDurabilityError("membership entitlements were replaced but durability could not be confirmed") from exc
    finally:
        if not handle.closed:
            handle.close()
        if os.path.exists(handle.name):
            os.unlink(handle.name)


class EntitlementStoreDurabilityError(OSError):
    """Signal that a membership or entitlement write could not be durably confirmed."""

    pass


def _route_revision_at(entry: Mapping[str, Any], at: Any = None) -> dict[str, Any]:
    """Resolve the latest route-arrangement revision effective at a given time."""
    moment = mem._now(at)
    revisions = [(index, item) for index, item in enumerate(entry.get("history") or [])
                 if mem._epoch(item.get("effective_from")) is not None
                 and mem._epoch(item.get("effective_from")) <= moment]
    if not revisions:
        return {"arrangement": entry.get("baseline_arrangement"), "effective_from": None,
                "owner_account_id": None, "owner_family": None, "owner_identity": None,
                "id": None, "baseline": True}
    return dict(max(revisions, key=lambda pair: (mem._epoch(pair[1]["effective_from"]), pair[0]))[1])


def _paid_entitlement(account: Mapping[str, Any], catalogue: Mapping[str, Any] | None,
                      at: Any = None, *, effective_arrangement: str | None = None) -> bool:
    """Check that a subscription arrangement carries a paid plan or positive fee."""
    arrangement = (effective_arrangement if effective_arrangement is not None
                   else mem.billing_arrangement(account))
    if arrangement != "subscription":
        return False
    plan_id = str(account.get("plan_id") or "").strip()
    custom = mem.custom_plan_view(account)
    plan = custom if custom and custom.get("id") == plan_id else mem.plan_index(catalogue).get(plan_id)
    if plan and plan.get("billing_arrangement") == "free_tier":
        return False
    override = mem.active_override(account, mem._now(at))
    if override and isinstance(override.get("amount"), (int, float)) and not isinstance(override.get("amount"), bool):
        if override["amount"] > 0:
            return True
    if not plan:
        return False
    if plan.get("source") == "user_defined":
        amount = (plan.get("price") or {}).get("amount")
        return isinstance(amount, (int, float)) and not isinstance(amount, bool) and amount > 0
    return plan.get("billing_arrangement") in {"recurring_subscription", "recurring_credit_allowance"}


def _raw_route_state(account: Mapping[str, Any], route_store: Mapping[str, Any], at: Any = None) -> dict[str, Any]:
    """Read an account's route states at a time without validating included owners."""
    slugs = [str(slug).strip().lower() for slug in account.get("route_slugs") or [] if str(slug).strip()]
    if not slugs:
        return {"arrangement": mem.billing_arrangement(account), "effective_from": None,
                "routes": [], "status": "unconfigured", "owner_account_id": None}
    states = []
    for slug in slugs:
        entry = (route_store.get("routes") or {}).get(slug)
        if entry is None:
            states.append({"route": slug, "arrangement": mem.billing_arrangement(account),
                           "effective_from": None, "status": "base", "owner_account_id": None})
            continue
        if (entry.get("account_id") != account.get("id") or entry.get("family") != account.get("family")
                or entry.get("identity") != account.get("identity")):
            states.append({"route": slug, "arrangement": "invalid", "effective_from": None,
                           "status": "stale", "owner_account_id": None})
            continue
        current = _route_revision_at(entry, at)
        states.append({"route": slug, **current, "status": "history"})
    return {"routes": states}


def _route_claims(accounts: Iterable[Mapping[str, Any]]) -> dict[str, list[str]]:
    """Map each normalized configured route slug to the accounts claiming it."""
    claims: dict[str, list[str]] = {}
    for account in accounts:
        account_id = str(account.get("id") or "")
        for route in account.get("route_slugs") or []:
            slug = str(route or "").strip().lower()
            if slug:
                claims.setdefault(slug, []).append(account_id)
    return claims


def _owner_valid(source: Mapping[str, Any], revision: Mapping[str, Any], accounts: Mapping[str, Mapping[str, Any]],
                 route_store: Mapping[str, Any], catalogue: Mapping[str, Any] | None,
                 claims: Mapping[str, list[str]], at: Any = None) -> tuple[bool, Mapping[str, Any] | None, str]:
    """Validate an included-route owner against identity, effective state and paid-plan evidence."""
    owner_id = str(revision.get("owner_account_id") or "")
    if not owner_id or owner_id == str(source.get("id") or ""):
        return False, None, "self_or_missing_owner"
    owner = accounts.get(owner_id)
    if owner is None:
        return False, None, "owner_missing"
    if owner.get("family") != revision.get("owner_family") or owner.get("identity") != revision.get("owner_identity"):
        return False, None, "owner_identity_changed"
    owner_state = _raw_route_state(owner, route_store, at)
    owner_routes = owner_state.get("routes") or []
    owner_arrangements = {item.get("arrangement") for item in owner_routes}
    if owner_arrangements and owner_arrangements != {"subscription"}:
        return False, owner, "owner_relationship_invalid"
    effective_arrangement = (next(iter(owner_arrangements)) if owner_arrangements
                             else mem.billing_arrangement(owner))
    if not _paid_entitlement(owner, catalogue, at,
                             effective_arrangement=effective_arrangement):
        return False, owner, "owner_not_paid_subscription"
    return True, owner, ""


def resolve_route_entitlements(accounts: list[Mapping[str, Any]], route_store: Mapping[str, Any],
                               catalogue: Mapping[str, Any] | None = None, at: Any = None) -> dict[str, Any]:
    """Resolve route billing states and validate included owners at one effective time."""
    indexed = {str(account.get("id") or ""): account for account in accounts}
    claims = _route_claims(accounts)
    resolved_accounts: dict[str, dict[str, Any]] = {}
    included_by_route: dict[str, dict[str, Any]] = {}
    moment = mem._now(at)
    for account_id, account in indexed.items():
        raw = _raw_route_state(account, route_store, at)
        route_states: list[dict[str, Any]] = []
        for item in raw.get("routes") or []:
            route = str(item.get("route") or "")
            arrangement = str(item.get("arrangement") or "unconfirmed")
            if item.get("status") == "stale":
                route_states.append({**item, "arrangement": "invalid", "status": "stale"})
                continue
            latest = max((mem._epoch(row.get("effective_from")) or 0 for row in
                          ((route_store.get("routes") or {}).get(route, {}).get("history") or [])), default=0)
            current = at is None or moment >= latest
            if arrangement in {"included", "no_plan"}:
                expected_legacy = (account.get("api_only") is not True
                                   and account.get("billing_arrangement") == "unconfirmed")
            elif arrangement == "api_only":
                expected_legacy = account.get("api_only") is True
            else:
                expected_legacy = mem.billing_arrangement(account) == arrangement
            if current and not expected_legacy:
                route_states.append({**item, "arrangement": "invalid", "status": "stale"})
                continue
            if arrangement in {"included", "no_plan"}:
                if claims.get(route, []) != [account_id]:
                    route_states.append({**item, "arrangement": "invalid", "status": "stale"})
                    continue
            if arrangement == "included":
                valid, owner, reason = _owner_valid(account, item, indexed, route_store, catalogue, claims, at)
                if not valid:
                    route_states.append({**item, "arrangement": "invalid", "status": "stale",
                                         "relationship_error": reason,
                                         "owner_label": ((owner or {}).get("label") if owner else None)})
                    continue
                included_by_route[route] = {"route": route, "account_id": account_id,
                                            "owner_account_id": str(owner.get("id")),
                                            "effective_from": item.get("effective_from"),
                                            "status": "valid"}
                route_states.append({**item, "arrangement": "included", "status": "valid",
                                     "owner_label": owner.get("label") or owner.get("family")})
                continue
            route_states.append({**item, "status": item.get("status") or "base"})
        arrangements = {str(item.get("arrangement") or "unconfirmed") for item in route_states}
        if any(item.get("status") == "stale" for item in route_states):
            effective = "invalid"
            relationship_status = "stale"
        elif len(arrangements) > 1:
            effective = "mixed"
            relationship_status = "mixed"
        elif arrangements:
            effective = next(iter(arrangements))
            relationship_status = "valid" if effective == "included" else "confirmed"
        else:
            effective = mem.billing_arrangement(account)
            relationship_status = "unconfigured"
        owners = {item.get("owner_account_id") for item in route_states if item.get("arrangement") == "included"
                  and item.get("status") == "valid"}
        owner_id = next(iter(owners)) if len(owners) == 1 else None
        route_rev = entitlement_revision(route_store.get("routes") or {}, account.get("route_slugs") or [])
        resolved_accounts[account_id] = {
            **dict(account),
            "route_entitlements": route_states,
            "route_entitlement_rev": route_rev,
            "route_arrangement": effective,
            "route_relationship_status": relationship_status,
            "entitlement_owner_id": owner_id,
            "entitlement_owner": dict(indexed[owner_id]) if owner_id in indexed else None,
        }
    return {"accounts": [resolved_accounts[str(a.get("id") or "")] for a in accounts],
            "by_account": resolved_accounts, "included_by_route": included_by_route,
            "claims": claims}


def account_route_arrangement(account: Mapping[str, Any], route_store: Mapping[str, Any],
                               at: Any = None) -> str:
    """Return an account's common effective route arrangement, or mixed/invalid."""
    raw = _raw_route_state(account, route_store, at)
    states = raw.get("routes") or []
    if any(item.get("arrangement") == "invalid" for item in states):
        return "invalid"
    arrangements = {str(item.get("arrangement") or "unconfirmed") for item in states}
    return next(iter(arrangements)) if len(arrangements) == 1 else "mixed" if arrangements else mem.billing_arrangement(account)


def set_account_arrangement(account_id: str, arrangement: str, *, if_rev: str,
                            if_route_rev: str, owner_account_id: str | None = None,
                            path: Optional[Path | str] = None,
                            catalogue: Mapping[str, Any] | None = None,
                            at: Any = None) -> dict[str, Any]:
    """Validate and atomically record an arrangement for each configured route."""
    if arrangement not in ROUTE_ARRANGEMENTS:
        raise ValueError("billing arrangement is invalid")
    if arrangement == "included" and not owner_account_id:
        raise ValueError("included route needs an owning subscription")
    if arrangement != "included" and owner_account_id is not None:
        raise ValueError("only an included route may have an owning subscription")
    target = Path(path) if path else store_path()
    with _locked(target):
        data = load_store(target, strict=True)
        seats = load_seat_store(target)
        routes_doc = load_entitlement_store(target)
        accounts = list(data["accounts"])
        account = next((a for a in accounts if str(a.get("id")) == str(account_id)), None)
        if account is None:
            raise KeyError(account_id)
        if not if_rev or if_rev != str(account.get("rev") or ""):
            raise MembershipConflict("conflict: this membership changed; reload before saving billing arrangement")
        slugs = [str(slug).strip().lower() for slug in account.get("route_slugs") or [] if str(slug).strip()]
        if not slugs or len(slugs) != len(set(slugs)):
            raise ValueError("account needs distinct configured routes before assigning billing")
        routes = routes_doc["routes"]
        if not if_route_rev or if_route_rev != entitlement_revision(routes, slugs):
            raise MembershipConflict("conflict: route ownership changed; reload before saving billing arrangement")
        for account_id_in_store, seat_entry in seats["accounts"].items():
            account_for_seat = next((a for a in accounts if a.get("id") == account_id_in_store), None)
            if account_for_seat and not _seat_matches(seat_entry, account_for_seat):
                raise StoreUnreadable("seat history does not match the membership identity")
        claims = _route_claims(accounts)
        if any(claims.get(slug, []) != [str(account_id)] for slug in slugs):
            raise ValueError("route ownership is ambiguous; resolve duplicate route claims first")
        owner = None
        if arrangement == "included":
            owner = next((a for a in accounts if str(a.get("id")) == str(owner_account_id)), None)
            if owner is None:
                raise ValueError("owning subscription does not exist")
            if str(owner_account_id) == str(account_id):
                raise ValueError("an account cannot own its own included route")
            owner_route_state = account_route_arrangement(owner, routes_doc, at)
            if owner_route_state in {"included", "no_plan", "invalid", "mixed"}:
                raise ValueError("owning subscription must be an independent subscription account")
            if not _paid_entitlement(owner, catalogue, at):
                raise ValueError("owning account needs a confirmed paid subscription")
        updated_account = dict(account)
        if arrangement in {"included", "no_plan"}:
            updated_account["api_only"] = False
            updated_account["billing_arrangement"] = "unconfirmed"
        elif arrangement == "api_only":
            updated_account["api_only"] = True
        else:
            updated_account["api_only"] = False
            updated_account["billing_arrangement"] = arrangement
        updated_account["rev"] = account_revision(updated_account)
        position = next(i for i, row in enumerate(accounts) if str(row.get("id")) == str(account_id))
        accounts[position] = updated_account
        route_store = dict(routes)
        stamp = mem._iso(mem._now(at))
        for slug in slugs:
            previous = route_store.get(slug)
            matches = (previous is not None and previous.get("account_id") == account_id
                       and previous.get("family") == account.get("family")
                       and previous.get("identity") == account.get("identity"))
            baseline = (previous.get("baseline_arrangement") if matches
                        else mem.billing_arrangement(account))
            history = list(previous.get("history") or []) if matches else []
            revision = {"id": uuid.uuid4().hex, "arrangement": arrangement,
                        "owner_account_id": str(owner["id"]) if owner else None,
                        "owner_family": owner.get("family") if owner else None,
                        "owner_identity": owner.get("identity") if owner else None,
                        "effective_from": stamp}
            history.append(revision)
            route_store[slug] = {"account_id": str(account_id), "family": str(account.get("family") or ""),
                                 "identity": account.get("identity"), "baseline_arrangement": baseline,
                                 "history": history}
        member_before = target.read_bytes() if target.exists() else None
        route_path = entitlement_store_path(target)
        routes_before = route_path.read_bytes() if route_path.exists() else None
        try:
            _write(accounts, target)
            _write_entitlement_store(route_store, target)
        except Exception:
            rollback_errors = []
            for file_path, contents in ((target, member_before), (route_path, routes_before)):
                try:
                    _restore_bytes(file_path, contents)
                except Exception as restore_exc:
                    rollback_errors.append(restore_exc)
            if rollback_errors:
                raise EntitlementStoreDurabilityError("billing arrangement save failed and rollback could not be confirmed") from rollback_errors[0]
            raise
        return {"account": updated_account, "accounts": accounts,
                "route_entitlement_rev": entitlement_revision(route_store, slugs)}


def _restore_bytes(path: Path, value: bytes | None) -> None:
    """Restore a previous file snapshot atomically, or remove a newly created file."""
    if value is None:
        path.unlink(missing_ok=True)
        if path.parent.exists():
            _sync_seat_directory(path.parent)
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    handle = tempfile.NamedTemporaryFile("wb", dir=path.parent, delete=False, suffix=".tmp")
    try:
        handle.write(value)
        handle.flush()
        os.fsync(handle.fileno())
        handle.close()
        os.replace(handle.name, path)
        _sync_seat_directory(path.parent)
    finally:
        if not handle.closed:
            handle.close()
        if os.path.exists(handle.name):
            os.unlink(handle.name)


def seat_store_path(path: Optional[Path | str] = None) -> Path:
    """Find the seat-history file beside the membership store."""
    target = Path(path) if path else store_path()
    return target.with_name(SEAT_STORE_NAME)


def load_seat_store(path: Optional[Path | str] = None) -> dict[str, Any]:
    """Read and validate seat history, rejecting damaged or unsupported data."""
    target = seat_store_path(path)
    try:
        doc = json.loads(target.read_text(encoding="utf-8"))
        if (not isinstance(doc, dict) or set(doc) != {"version", "accounts"}
                or type(doc["version"]) is not int or doc["version"] != SEAT_STORE_VERSION
                or not isinstance(doc["accounts"], dict)):
            raise ValueError("invalid document")
        for account_id, entry in doc["accounts"].items():
            if (not isinstance(account_id, str) or not account_id.strip()
                    or not isinstance(entry, dict) or set(entry) != {"family", "identity", "revisions"}
                    or not isinstance(entry["family"], str) or not entry["family"].strip()
                    or (entry["identity"] is not None and not isinstance(entry["identity"], str))
                    or mem.seat_revision_errors(entry["revisions"])):
                raise ValueError("invalid account history")
        return doc
    except FileNotFoundError:
        return {"version": SEAT_STORE_VERSION, "accounts": {}}
    except (OSError, ValueError, TypeError, KeyError, AttributeError, OverflowError) as exc:
        raise StoreUnreadable("seat history store unreadable") from exc


def seat_revision_hash(entry: Mapping[str, Any] | None) -> str:
    """Hash one account’s seat history for optimistic concurrency checks."""
    return hashlib.sha256(json.dumps(entry, sort_keys=True, separators=(",", ":")).encode()).hexdigest()[:12]


def _seat_matches(entry: Mapping[str, Any], account: Mapping[str, Any]) -> bool:
    """Match the account family and reject conflicting known identities."""
    left, right = entry["identity"], account.get("identity")
    return entry["family"] == account["family"] and (left in (None, "") or right in (None, "") or left == right)


class SeatStoreDurabilityError(OSError):
    """The replacement happened, but its directory could not be synced."""


def _sync_seat_directory(directory: Path) -> None:
    """Sync the sidecar directory when supported, propagating I/O failures."""
    if os.name == "nt":
        return
    try:
        fd = os.open(directory, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    except OSError as exc:
        if exc.errno in {errno.EINVAL, errno.ENOSYS, errno.ENOTSUP, errno.EOPNOTSUPP}:
            return
        raise
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _write_seat_store(seats: Mapping[str, Any], target: Path) -> None:
    """Atomically replace the seat sidecar and sync its directory."""
    sidecar = seat_store_path(target)
    handle = tempfile.NamedTemporaryFile("w", dir=sidecar.parent, delete=False, suffix=".tmp", encoding="utf-8")
    try:
        json.dump(seats, handle, indent=2, sort_keys=True, allow_nan=False)
        handle.flush()
        os.fsync(handle.fileno())
        handle.close()
        os.replace(handle.name, sidecar)
        try:
            _sync_seat_directory(sidecar.parent)
        except OSError as exc:
            raise SeatStoreDurabilityError("seat history was replaced but its durability could not be confirmed") from exc
    finally:
        if not handle.closed:
            handle.close()
        if os.path.exists(handle.name):
            os.unlink(handle.name)


def load_with_seats(path: Optional[Path | str] = None) -> dict[str, Any]:
    """Read a consistent membership and seat-history snapshot under one lock."""
    target = Path(path) if path else store_path()
    with _locked(target):
        data = load_store(target, strict=True)
        seats = load_seat_store(target)
        entitlements = load_entitlement_store(target)
        accounts = []
        for account in data["accounts"]:
            entry = seats["accounts"].get(account["id"])
            if entry is not None and not _seat_matches(entry, account):
                raise StoreUnreadable("seat history does not match the membership identity")
            accounts.append({**account, "seat_revisions": list(entry["revisions"]) if entry else [],
                             "seat_rev": seat_revision_hash(entry)})
        return {**data, "accounts": accounts, "seat_store": seats, "entitlement_store": entitlements,
                "membership_store": {"version": data["version"], "accounts": data["accounts"]}}


def append_seat_revision(account_id: str, revision: Mapping[str, Any], *, if_rev: str,
                         if_seat_rev: str, path: Optional[Path | str] = None) -> dict[str, Any]:
    """Append a seat revision only when both revision tokens match."""
    target = Path(path) if path else store_path()
    errors = mem.seat_revision_errors([revision])
    if errors:
        raise ValueError("; ".join(errors))
    with _locked(target):
        accounts = load_store(target, strict=True)["accounts"]
        load_entitlement_store(target)
        account = next((a for a in accounts if a["id"] == account_id), None)
        if account is None:
            raise KeyError(account_id)
        if account.get("identity") is not None and not isinstance(account["identity"], str):
            raise StoreUnreadable("membership identity cannot be associated with seat history")
        seats = load_seat_store(target)
        previous = seats["accounts"].get(account_id)
        if previous is not None and not _seat_matches(previous, account):
            raise StoreUnreadable("seat history does not match the membership identity")
        if not if_rev or if_rev != str(account.get("rev") or ""):
            raise MembershipConflict("conflict: membership changed; reload before saving seats")
        if not if_seat_rev or if_seat_rev != seat_revision_hash(previous):
            raise MembershipConflict("conflict: seat history changed; reload before saving seats")
        if revision.get("plan_id") != account.get("plan_id"):
            raise MembershipConflict("conflict: selected plan changed; reload before saving seats")
        if revision.get("quantity") is not None and mem.billing_arrangement(account) != "subscription":
            raise ValueError("seat quantity requires a subscription")
        revisions = list(previous["revisions"]) if previous else []
        if any(item["id"] == revision["id"] for item in revisions):
            raise ValueError("duplicate seat revision id")
        entry = {"family": account["family"], "identity": account.get("identity") or (previous or {}).get("identity"),
                 "revisions": [*revisions, dict(revision)]}
        seats["accounts"][account_id] = entry
        _write_seat_store(seats, target)
        return {"seat_rev": seat_revision_hash(entry)}


def store_path(data_dir: Optional[Path | str] = None) -> Path:
    """Location of the membership store, honouring an explicit data directory."""
    if data_dir:
        return Path(data_dir) / STORE_NAME
    try:
        from plugins.plugin_storage import plugin_data_dir

        return plugin_data_dir("spend-sense") / STORE_NAME
    except Exception:
        pass
    try:
        from hermes_constants import get_hermes_home

        base = Path(get_hermes_home())
    except Exception:  # pragma: no cover - fallback for a bare checkout
        base = Path(os.environ.get("HERMES_HOME") or Path.home() / ".hermes")
    return Path(base) / "plugin-data" / "spend-sense" / STORE_NAME


class MembershipConflict(ValueError):
    """A stale revision; the caller must reload before retrying."""


class StoreUnreadable(RuntimeError):
    """An existing membership store could not be parsed.

    Raised only on the write path: a reader may report the damage, but nothing
    may overwrite it. A genuinely absent file is still a new, empty store —
    the distinction is "exists but cannot be understood", not "empty"."""


def _corrupt(reason: str) -> str:
    return f"membership store unreadable: {reason}"


def account_revision(account: Mapping[str, Any]) -> str:
    body = {k: v for k, v in account.items() if k != "rev"}
    return hashlib.sha256(json.dumps(body, sort_keys=True, default=str).encode()).hexdigest()[:12]


def _records_errors(raw: list[dict[str, Any]]) -> list[str]:
    """Enforce the same record contract before reading or replacing a store."""
    try:
        ids = [account.get("id") for account in raw]
        malformed_fields = any(
            any(key in account and (not isinstance(account[key], list) or
                any(not isinstance(item, dict) for item in account[key]))
                for key in ("fee_overrides", "manual_exhaustions"))
            or ("route_slugs" in account and (not isinstance(account["route_slugs"], list) or
                any(not isinstance(item, str) for item in account["route_slugs"])))
            or any(key in account and account[key] is not None and not isinstance(account[key], dict)
                   for key in ("billing_cycle", "advanced"))
            or any(not isinstance(item.get("scope"), dict) for item in account.get("manual_exhaustions", [])
                   if isinstance(item, dict))
            or any(not isinstance(item.get("id"), str) or not item["id"].strip()
                   for item in account.get("fee_overrides", []) if isinstance(item, dict))
            or any(not isinstance(item.get("id"), str) or not item["id"].strip()
                   or not isinstance((item.get("scope") or {}).get("id"), str)
                   or not (item.get("scope") or {}).get("id", "").strip()
                   for item in account.get("manual_exhaustions", []) if isinstance(item, dict))
            for account in raw
        )
        invalid_records = any(
            mem.validation_errors({k: v for k, v in account.items() if k != "rev"})
            for account in raw
        ) or malformed_fields or any(
            not isinstance(account.get("family"), str) or not account["family"].strip()
            for account in raw
        ) or any(not isinstance(value, str) or not value.strip() for value in ids) or len(set(ids)) != len(ids)
    except (TypeError, ValueError, AttributeError):
        invalid_records = True
    return ["incomplete account record"] if invalid_records else []


def load_store(path: Optional[Path | str] = None, *, strict: bool = False) -> dict[str, Any]:
    """Read the store.

    A **missing** file is a new, empty store. An **existing** file that cannot be
    parsed is damage: ``strict=False`` reports it in ``error`` for readers,
    ``strict=True`` raises :class:`StoreUnreadable` so a writer cannot mistake it
    for "no memberships" and replace the owner's data with a fresh document.
    """
    target = Path(path) if path else store_path()
    if not target.exists():
        return {"version": STORE_VERSION, "accounts": [], "loaded": False, "error": "", "path": str(target)}
    try:
        data = json.loads(target.read_text())
    except (OSError, ValueError) as exc:
        reason = _corrupt(type(exc).__name__)
        if strict:
            raise StoreUnreadable(reason) from exc
        return {"version": STORE_VERSION, "accounts": [], "loaded": False,
                "error": reason, "path": str(target)}
    if not isinstance(data, dict):
        reason = _corrupt("the document is not an object")
        if strict:
            raise StoreUnreadable(reason)
        return {"version": STORE_VERSION, "accounts": [], "loaded": False, "error": reason,
                "path": str(target)}
    # Validate the stored structure *before* applying any default. `data.get(
    # "accounts") or []` collapsed `null`, `false`, `0`, `""` and `{}` into an
    # empty list, so a malformed file passed the check that exists to catch it
    # and the next write replaced it. A key that is present but not a list is
    # damage; only a genuinely absent file is an empty store.
    if "accounts" not in data:
        reason = _corrupt("the document has no accounts entry")
        if strict:
            raise StoreUnreadable(reason)
        return {"version": STORE_VERSION, "accounts": [], "loaded": False, "error": reason,
                "path": str(target)}
    raw = data["accounts"]
    if not isinstance(raw, list) or any(not isinstance(a, dict) for a in raw):
        reason = _corrupt("the accounts entry is not a list of records")
        if strict:
            raise StoreUnreadable(reason)
        return {"version": STORE_VERSION, "accounts": [], "loaded": False, "error": reason,
                "path": str(target)}
    version = data.get("version")
    if isinstance(version, bool) or not isinstance(version, int):
        reason = _corrupt("the version entry is not a number")
        if strict:
            raise StoreUnreadable(reason)
        return {"version": STORE_VERSION, "accounts": [], "loaded": False, "error": reason,
                "path": str(target)}
    invalid_records = bool(_records_errors(raw))
    if version != STORE_VERSION or invalid_records:
        reason = _corrupt("unsupported version or incomplete account record")
        if strict:
            raise StoreUnreadable(reason)
        return {"version": STORE_VERSION, "accounts": [], "loaded": False, "error": reason,
                "path": str(target)}
    return {"version": version, "accounts": list(raw), "loaded": True, "error": "",
            "path": str(target)}


def accounts_by_id(path: Optional[Path | str] = None) -> dict[str, dict[str, Any]]:
    return {str(a.get("id")): a for a in load_store(path).get("accounts", [])}


def _write(accounts: Iterable[Mapping[str, Any]], target: Path) -> None:
    records = list(accounts)
    errors = _records_errors(records)
    if errors:
        raise ValueError("; ".join(errors))
    payload = {"version": STORE_VERSION, "accounts": records}
    target.parent.mkdir(parents=True, exist_ok=True)
    handle = tempfile.NamedTemporaryFile("w", dir=target.parent, delete=False, suffix=".tmp")
    try:
        json.dump(payload, handle, indent=2, sort_keys=True, default=str)
        handle.flush()
        os.fsync(handle.fileno())
        handle.close()
        os.replace(handle.name, target)
    finally:
        if not handle.closed:
            handle.close()


def save_account(account: Mapping[str, Any], path: Optional[Path | str] = None,
                 if_rev: Optional[str] = None, must_exist: bool = False) -> dict[str, Any]:
    """Validate and persist one membership atomically.

    ``if_rev`` is required when the account already exists, and must match the
    stored revision. Unknown fields are rejected so a UI typo cannot accumulate
    silently in the store.
    """
    # ``rev`` is storage-managed: recomputed on every write, never accepted from
    # the document. Stripping it here lets a stored record round-trip through
    # validation instead of failing as an unknown field.
    document = {k: v for k, v in dict(account).items() if k != "rev"}
    try:
        errors = mem.validation_errors(document)
    except (TypeError, ValueError, AttributeError):
        errors = ["incomplete account record"]
    errors += _records_errors([document])
    if errors:
        raise ValueError("; ".join(errors))
    account = document
    target = Path(path) if path else store_path()
    with _locked(target):
        # strict: an unreadable store raises here, so the write never happens.
        data = load_store(target, strict=True)
        seats = load_seat_store(target)
        load_entitlement_store(target)
        accounts = data.get("accounts", [])
        existing = next((a for a in accounts if str(a.get("id")) == str(account.get("id"))), None)
        seat_entry = seats["accounts"].get(str(account.get("id")))
        if seat_entry is not None and account.get("identity") is not None and not isinstance(account["identity"], str):
            raise ValueError("membership identity must be a string or empty")
        if seat_entry is not None and existing is not None and not _seat_matches(seat_entry, existing):
            raise StoreUnreadable("seat history does not match the membership identity")
        if seat_entry is not None and not _seat_matches(seat_entry, account):
            raise MembershipConflict("conflict: membership identity does not match its seat history")
        if (seat_entry is not None and existing is not None and existing.get("identity") not in (None, "")
                and account.get("identity") != existing.get("identity")):
            raise MembershipConflict("conflict: membership identity does not match its seat history")
        if existing is None and must_exist:
            # Accounts are created by discovery, not by a PUT. Refusing an unknown
            # id also means a stale card from another gateway cannot create a
            # record here just by being clicked.
            raise KeyError(str(account.get("id")))
        if existing is not None:
            if if_rev is None:
                raise MembershipConflict("conflict: editing an existing membership requires if_rev")
            if if_rev != str(existing.get("rev") or ""):
                raise MembershipConflict("conflict: this membership changed since you loaded it; reload before saving")
            position = next(i for i, a in enumerate(accounts)
                            if str(a.get("id")) == str(account.get("id")))
        bound_identity = (seat_entry is not None and seat_entry["identity"] in (None, "")
                          and account.get("identity") not in (None, ""))
        if bound_identity:
            seats["accounts"][str(account["id"])] = {**seat_entry, "identity": account["identity"]}
            _write_seat_store(seats, target)
        record = {**dict(account), "rev": account_revision(account)}
        if existing is not None:
            # Replace in place: remove-and-append reordered the cards on
            # every edit, moving the saved membership to the end.
            accounts[position] = record
        else:
            accounts.append(record)
        try:
            _write(accounts, target)
        except OSError as exc:
            if bound_identity:
                raise SeatStoreDurabilityError("seat identity was bound but membership save failed") from exc
            raise
        return {"accounts": accounts, "account": record, "path": str(target)}


def delete_account(account_id: str, path: Optional[Path | str] = None) -> dict[str, Any]:
    """Remove an account and its seat history, rolling back failed writes."""
    target = Path(path) if path else store_path()
    with _locked(target):
        data = load_store(target, strict=True)
        seats = load_seat_store(target)
        load_entitlement_store(target)
        before = data.get("accounts", [])
        accounts = [a for a in before if str(a.get("id")) != str(account_id)]
        removed = len(before) != len(accounts)
        seat_accounts = seats["accounts"]
        has_seats = str(account_id) in seat_accounts
        if removed:
            _write(accounts, target)
        if has_seats:
            updated = {**seats, "accounts": {k: v for k, v in seat_accounts.items() if k != str(account_id)}}
            try:
                _write_seat_store(updated, target)
            except Exception as exc:
                rollback_error = None
                if isinstance(exc, SeatStoreDurabilityError):
                    try:
                        _write_seat_store(seats, target)
                    except Exception as restore_exc:
                        rollback_error = restore_exc
                if removed:
                    try:
                        _write(before, target)
                    except Exception as restore_exc:
                        rollback_error = rollback_error or restore_exc
                if rollback_error is not None:
                    raise SeatStoreDurabilityError("account deletion failed and rollback could not be confirmed") from rollback_error
                raise
        return {"accounts": accounts, "removed": removed}



def upsert_discovered(discovered: Iterable[Mapping[str, Any]],
                      path: Optional[Path | str] = None) -> dict[str, Any]:
    """Merge freshly discovered accounts into the store without losing state.

    A discovered account only ever *adds* evidence: credential presence, the
    plan hint and the identity. It must never clear an owner's plan choice, a
    fee override or a manual exhaustion mark, so an existing record wins on
    every field the owner set.
    """
    target = Path(path) if path else store_path()
    with _locked(target):
        # Discovery writes too: refusing an unreadable store here stops a corrupt
        # file being replaced by whatever the credential slots happen to say.
        data = load_store(target, strict=True)
        seats = load_seat_store(target)
        load_entitlement_store(target)
        accounts = list(data.get("accounts", []))
        index = {str(a.get("id")): i for i, a in enumerate(accounts)}
        added, updated = [], []
        for found in discovered:
            key = str(found.get("id"))
            if not key:
                continue
            if key not in index:
                record = {**dict(found), "rev": account_revision(found)}
                accounts.append(record)
                index[key] = len(accounts) - 1
                added.append(key)
                continue
            current = accounts[index[key]]
            slugs = set(current.get("route_slugs") or []) | set(found.get("route_slugs") or [])
            merged = {**current,
                      "credential_present": bool(found.get("credential_present")),
                      "plan_hint": found.get("plan_hint") or current.get("plan_hint"),
                      "route_slugs": sorted(slugs),
                      "identity": current.get("identity") or found.get("identity"),
                      "identity_source": (current.get("identity_source")
                                          if current.get("identity")
                                          else found.get("identity_source")),
                      "discovered_at": found.get("discovered_at") or current.get("discovered_at")}
            if merged != current:
                merged["rev"] = account_revision(merged)
                accounts[index[key]] = merged
                updated.append(key)
        if added or updated:
            errors = _records_errors(accounts)
            if errors:
                raise ValueError("; ".join(errors))
            needs_binding = False
            for account in accounts:
                entry = seats["accounts"].get(str(account.get("id")))
                if entry is not None and account.get("identity") is not None and not isinstance(account["identity"], str):
                    raise ValueError("membership identity must be a string or empty")
                if entry is not None and not _seat_matches(entry, account):
                    raise MembershipConflict("conflict: discovered identity does not match its seat history")
                if (entry is not None and entry["identity"] in (None, "")
                        and account.get("identity") not in (None, "")):
                    seats["accounts"][str(account["id"])] = {**entry, "identity": account["identity"]}
                    needs_binding = True
            if needs_binding:
                _write_seat_store(seats, target)
            try:
                _write(accounts, target)
            except OSError as exc:
                if needs_binding:
                    raise SeatStoreDurabilityError("seat identity was bound but membership discovery failed") from exc
                raise
        return {"accounts": accounts, "added": added, "updated": updated, "path": str(target)}
