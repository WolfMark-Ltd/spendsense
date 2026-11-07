from __future__ import annotations

import json
import os
import tempfile
from contextlib import ExitStack
from pathlib import Path

from . import billing, budgets
from . import membership_store


def _replace_bytes(path: Path, value: bytes) -> None:
    """Durably flush a temporary file before atomically replacing one reset target."""
    path.parent.mkdir(parents=True, exist_ok=True)
    handle = tempfile.NamedTemporaryFile("wb", dir=path.parent, delete=False, suffix=".tmp")
    try:
        handle.write(value)
        handle.flush()
        os.fsync(handle.fileno())
        handle.close()
        os.replace(handle.name, path)
        budgets._sync_parent_directory(path.parent)
    finally:
        if not handle.closed:
            handle.close()
        if os.path.exists(handle.name):
            os.unlink(handle.name)


def reset_user_data(membership_path: Path | str | None = None,
                    billing_path: Path | str | None = None) -> dict:
    """Reset profile user data with rollback if a replacement fails."""
    members = Path(membership_path) if membership_path else membership_store.store_path()
    profiles = Path(billing_path) if billing_path else billing.profiles_path()
    seats = membership_store.seat_store_path(members)
    budget_path = profiles.with_name('budgets.json')
    targets = [members, profiles, seats, budget_path]
    locks = {members: membership_store._locked, profiles: billing._locked, budget_path: budgets.locked}
    ordered = sorted(locks.items(), key=lambda item: str(item[0]))
    with ExitStack() as stack:
        for path, lock in ordered:
            stack.enter_context(lock(path))
        membership = membership_store.load_store(members, strict=True)
        billing_doc = billing._load_profiles(profiles, strict=True)
        membership_store.load_seat_store(members)
        budgets.load(budget_path)
        replacements = {
            budget_path: json.dumps({'version': 1, 'budgets': [], 'dismissals': {}}).encode('utf-8'),
            members: json.dumps({"version": membership_store.STORE_VERSION, "accounts": []},
                                indent=2, sort_keys=True).encode("utf-8"),
            profiles: json.dumps({"version": billing_doc.get("version", 1), "profiles": []},
                                 indent=2, sort_keys=True).encode("utf-8"),
            seats: json.dumps({"version": membership_store.SEAT_STORE_VERSION, "accounts": {}},
                              indent=2, sort_keys=True).encode("utf-8"),
        }
        original = {path: path.read_bytes() if path.exists() else None for path in targets}
        replaced: list[Path] = []
        try:
            for path in targets:
                replaced.append(path)
                _replace_bytes(path, replacements[path])
        except OSError:
            rollback_errors: list[tuple[Path, OSError]] = []
            for path in reversed(replaced):
                try:
                    before = original[path]
                    if before is None:
                        path.unlink(missing_ok=True)
                    else:
                        _replace_bytes(path, before)
                except OSError as rollback_error:
                    rollback_errors.append((path, rollback_error))
            if rollback_errors:
                failed_paths = ", ".join(path.name for path, _ in rollback_errors)
                raise OSError(
                    f"user data reset failed and rollback could not be confirmed for: {failed_paths}"
                ) from rollback_errors[0][1]
            raise
    return {"memberships_cleared": True, "seat_history_cleared": True, "advanced_rules_cleared": True, "budgets_cleared": True}
