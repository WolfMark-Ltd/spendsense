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
from pathlib import Path
from typing import Any, Iterable, Mapping, Optional

from . import membership as mem
from .filelock import locked as _locked

STORE_NAME = "memberships.json"
STORE_VERSION = 1
SEAT_STORE_NAME = "membership-seats.json"
SEAT_STORE_VERSION = 1


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
        accounts = []
        for account in data["accounts"]:
            entry = seats["accounts"].get(account["id"])
            if entry is not None and not _seat_matches(entry, account):
                raise StoreUnreadable("seat history does not match the membership identity")
            accounts.append({**account, "seat_revisions": list(entry["revisions"]) if entry else [],
                             "seat_rev": seat_revision_hash(entry)})
        return {**data, "accounts": accounts, "seat_store": seats,
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
