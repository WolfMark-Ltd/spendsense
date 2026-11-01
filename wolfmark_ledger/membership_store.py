"""Persisted membership documents (account-first).

One account per file entry in ``memberships.json`` under the plugin's data
directory. A membership is *not* a billing profile: it records which plan an
account holds, the owner's fee overrides and manual exhaustion marks. It never
holds a credential, and it never stores a resolved price — that is computed at
read time from the catalogue so a catalogue refresh cannot silently rewrite a
past month.

Writes mirror ``billing.py``: an exclusive ``flock`` around the whole
read-modify-write, an ``os.replace`` swap, and a revision hash so a stale edit is
rejected with 409 rather than overwriting a newer one.
"""

from __future__ import annotations

import hashlib
import json
import os
import tempfile
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterable, Mapping, Optional

from . import membership as mem

STORE_NAME = "memberships.json"
STORE_VERSION = 1


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


@contextmanager
def _locked(target: Path):
    import fcntl

    target.parent.mkdir(parents=True, exist_ok=True)
    handle = open(target.with_suffix(target.suffix + ".lock"), "a+")
    try:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        yield handle
    finally:
        fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        handle.close()


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
        accounts = data.get("accounts", [])
        existing = next((a for a in accounts if str(a.get("id")) == str(account.get("id"))), None)
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
        record = {**dict(account), "rev": account_revision(account)}
        if existing is not None:
            # Replace in place: remove-and-append reordered the cards on
            # every edit, moving the saved membership to the end.
            accounts[position] = record
        else:
            accounts.append(record)
        _write(accounts, target)
        return {"accounts": accounts, "account": record, "path": str(target)}


def delete_account(account_id: str, path: Optional[Path | str] = None) -> dict[str, Any]:
    target = Path(path) if path else store_path()
    with _locked(target):
        data = load_store(target, strict=True)
        before = data.get("accounts", [])
        accounts = [a for a in before if str(a.get("id")) != str(account_id)]
        _write(accounts, target)
        return {"accounts": accounts, "removed": len(before) != len(accounts)}



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
            _write(accounts, target)
        return {"accounts": accounts, "added": added, "updated": updated, "path": str(target)}
