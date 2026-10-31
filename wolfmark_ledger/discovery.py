"""Provider and account discovery for the membership layer.

Two sources, in this order:

1. **Hermes-native configuration** — the credential pool in ``auth.json``. Only
   the file is parsed in memory, including any credential values it contains.
   Only provider slot names and counts are used; credentials are not returned or logged.
2. **Hermes-native account usage** — ``hermes usage --provider <slug> --json``,
   the same interface the CLI exposes. A provider without a credential, without
   an endpoint or with a failed fetch exits non-zero; that is a state
   (``unavailable``), not an exception.

Nothing here polls. Every call is made on behalf of an explicit user action, is
cached briefly so a burst of clicks resolves to one subprocess, and degrades to
"slot present, usage unknown" rather than inventing a reading.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import time
from pathlib import Path
from typing import Any, Iterable, Mapping, Optional

from . import membership as mem

#: Families whose account usage Hermes itself can report. Used only to decide
#: whether asking is worth a subprocess; an unknown family is still asked, once.
NATIVE_FAMILIES = ("openai-codex", "anthropic", "openrouter", "nous", "opencode-zen")

#: Provider aliases that resolve to one canonical family. Mirrors how Hermes
#: registers `-chat` / `-claude` wire variants of the same endpoint.
PROVIDER_ALIASES = {
    "commandcode-chat": "commandcode",
    "commandcode-claude": "commandcode-anthropic",
}

#: Connector credentials that are not inference providers.
CONNECTOR_SLOTS = ("photon", "photon_project", "photon_user")

_CACHE: dict[str, tuple[float, Any]] = {}
CACHE_SECONDS = 60.0


def hermes_home(home: Optional[Path | str] = None) -> Path:
    if home:
        return Path(home)
    try:
        from hermes_constants import get_hermes_home

        return Path(get_hermes_home())
    except Exception:
        return Path(os.environ.get("HERMES_HOME") or Path.home() / ".hermes")


def canonical_provider(name: str) -> str:
    key = str(name or "").strip().lower()
    return PROVIDER_ALIASES.get(key, key)


def credential_slots(home: Optional[Path | str] = None) -> dict[str, dict[str, Any]]:
    """Credential **presence** per provider family.

    Returns ``{family: {"slots": n, "route_slugs": [...]}}``. The credential
    entries themselves are never read past their count: a slot is proof that
    something is configured, not proof of entitlement or of inference.
    """
    target = hermes_home(home) / "auth.json"
    try:
        data = json.loads(target.read_text())
    except (OSError, ValueError):
        return {}
    pool = data.get("credential_pool") or {}
    if not isinstance(pool, dict):
        return {}
    out: dict[str, dict[str, Any]] = {}
    for raw, entries in pool.items():
        slug = str(raw).strip().lower()
        if not slug or slug in CONNECTOR_SLOTS:
            continue
        family = canonical_provider(slug)
        block = out.setdefault(family, {"slots": 0, "route_slugs": []})
        try:
            block["slots"] += len(entries or [])
        except TypeError:
            block["slots"] += 1
        if slug not in block["route_slugs"]:
            block["route_slugs"].append(slug)
    return out


def _hermes_binary() -> Optional[str]:
    found = shutil.which("hermes")
    if found:
        return found
    candidate = hermes_home() / "hermes-agent" / "hermes"
    return str(candidate) if Path(candidate).exists() else None


#: Per-provider budget for one ``hermes usage`` read. The Desktop transport gives
#: an ``ctx.rest`` call 15 s, so a probe that ran longer would surface as a
#: transport timeout and read like a missing route. Eight seconds leaves room for
#: the rest of the request and is reported as "unavailable", not "missing".
PROBE_TIMEOUT = 8.0


def native_snapshot(provider: str, *, home: Optional[Path | str] = None,
                    timeout: float = PROBE_TIMEOUT, cache_seconds: float = CACHE_SECONDS) -> dict[str, Any]:
    """One bounded ``hermes usage`` read for ``provider``.

    Returns ``{"state": "ok"|"unavailable"|"unsupported"|"error", "snapshot",
    "reason"}``. The snapshot is normalised to the shape ``native_usage``
    expects (``resets_at`` → ``reset_at``).
    """
    binary = _hermes_binary()
    if not binary:
        return {"state": "unsupported", "snapshot": None, "reason": "the hermes CLI is not on PATH"}
    # Keyed by the resolved home as well as the provider: two profiles share a
    # process, and a cache hit across homes reports the wrong account's usage.
    key = f"usage:{hermes_home(home)}:{provider}"
    now = time.time()
    cached = _CACHE.get(key)
    if cached and now - cached[0] < cache_seconds:
        return cached[1]
    env = {**os.environ, "HERMES_HOME": str(hermes_home(home)), "NO_COLOR": "1"}
    try:
        proc = subprocess.run([binary, "usage", "--provider", provider, "--json"],
                              capture_output=True, text=True, timeout=timeout, env=env)
    except (OSError, subprocess.SubprocessError) as exc:
        result = {"state": "error", "snapshot": None, "reason": f"usage read failed: {type(exc).__name__}"}
        _CACHE[key] = (now, result)
        return result
    body = (proc.stdout or "").strip()
    if proc.returncode != 0 or not body.startswith("{"):
        reason = "no credential configured, no usage endpoint, or the fetch failed"
        result = {"state": "unavailable", "snapshot": None, "reason": reason}
        _CACHE[key] = (now, result)
        return result
    try:
        snapshot = json.loads(body)
    except ValueError:
        result = {"state": "error", "snapshot": None, "reason": "usage output was not JSON"}
        _CACHE[key] = (now, result)
        return result
    for window in snapshot.get("windows") or []:
        if isinstance(window, dict) and "reset_at" not in window and "resets_at" in window:
            window["reset_at"] = window["resets_at"]
    result = {"state": "ok", "snapshot": snapshot, "reason": ""}
    _CACHE[key] = (now, result)
    return result


def _slot_only(family: str, slots: Mapping[str, Any], catalogue: Mapping[str, Any] | None,
               *, now: Optional[float] = None) -> dict[str, Any]:
    """An account we can see but cannot read usage for."""
    plans = mem.plans_for_family(catalogue, family)
    return {
        "id": mem.account_key(family, None),
        "family": family,
        "label": family,
        "route_slugs": list(slots.get("route_slugs") or [family]),
        "credential_present": True,
        "identity": None,
        "identity_source": "provider_default_slot",
        "discovered_at": mem._iso(mem._now(now)),
        "plan_id": None,
        "plan_hint": None,
        "fee_overrides": [],
        "manual_exhaustions": [],
        "advanced": {"model_mapping": {}, "rate_override": {}},
        "catalogue_plans": len(plans),
        "usage_source": "none",
    }


def probe_providers(providers: Iterable[str], *, home: Optional[Path | str] = None,
                    budget_seconds: float = 10.0) -> dict[str, dict[str, Any]]:
    """Bound the whole Desktop request and retain per-provider partial results."""
    deadline = time.monotonic() + budget_seconds
    results = {}
    for provider in providers:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            results[provider] = {"state": "unavailable", "snapshot": None,
                                 "reason": "discovery time budget exhausted"}
        else:
            results[provider] = native_snapshot(provider, home=home,
                                                 timeout=min(PROBE_TIMEOUT, remaining))
    return results


def discover(catalogue: Mapping[str, Any] | None, *, include_native: bool = True,
             home: Optional[Path | str] = None, now: Optional[float] = None,
             providers: Optional[Iterable[str]] = None) -> dict[str, Any]:
    """Build the discovered-account list plus the reasons some accounts are thin.

    ``include_native`` asks Hermes for account usage where Hermes supports it.
    It is off by default at the API boundary: a discovery call is a user action,
    and a caller that only wants the slot inventory should not trigger network
    reads.
    """
    slots = credential_slots(home)
    wanted = {canonical_provider(p) for p in providers} if providers else None
    accounts: list[dict[str, Any]] = []
    notes: list[str] = []

    families = [family for family in sorted(slots) if wanted is None or family in wanted]
    probes = probe_providers(families, home=home) if include_native else {}
    snapshots: dict[str, Any] = {}
    for family in families:
        snapshot = None
        usage_source = "none"
        if include_native:
            probe = probes[family]
            if probe["state"] == "ok" and probe["snapshot"]:
                snapshot = probe["snapshot"]
                usage_source = str(snapshot.get("source") or "usage_api")
                if usage_source not in mem.USAGE_SOURCES:
                    usage_source = "usage_api"
            elif probe["state"] == "unavailable":
                notes.append(f"{family}: Hermes reported no account usage ({probe['reason']}).")
            elif probe["state"] == "error":
                notes.append(f"{family}: account usage could not be read ({probe['reason']}).")
        if snapshot:
            account = mem.member_from_native(snapshot, label=snapshot.get("title") or family,
                                             route_slugs=slots[family]["route_slugs"], discovered_at=now)
            account["usage_source"] = usage_source
        else:
            account = _slot_only(family, slots[family], catalogue, now=now)
        snapshots[family] = snapshot
        account["catalogue_plans"] = len(mem.plans_for_family(catalogue, family))
        accounts.append(account)

    catalogued = {str(p.get("provider_family")) for p in (catalogue or {}).get("plans") or []}
    matched = {mem.PLAN_FAMILY_ALIASES.get(family, family) for family in slots}
    absent = sorted(catalogued - matched)
    return {
        "accounts": accounts,
        "slots": {f: {"slots": v["slots"], "route_slugs": v["route_slugs"]} for f, v in slots.items()},
        "catalogued_without_credential": absent,
        "notes": notes,
        "native_probe": bool(include_native),
        "snapshots": snapshots,
    }
