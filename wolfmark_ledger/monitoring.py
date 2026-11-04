"""Local monitoring integration: throttled checks, relevance, empty states.

This module grounds Model News and membership displays in three distinct
data kinds, computed locally from stores this machine already owns:

* :data:`OBSERVED_USAGE` — spend and tokens Hermes recorded here. It shows
  what was actually used, never what remains.
* :data:`PROVIDER_ALLOWANCE` — quota windows a ``hermes usage`` probe reads
  from the provider at view time. Live, never stored, and never confused
  with observed spend.
* :data:`PUBLIC_PLAN_INFO` — advertised plan terms from the bundled or
  centrally fetched membership catalogue. A reference for what a plan
  includes, not a measurement of remaining use.

There is deliberately no scheduler here: no cron, no polling loops, no
background agents. :func:`maybe_refresh_local` runs a local catalogue diff
at most once per :data:`LOCAL_CHECK_INTERVAL_SECONDS`, and only when the
host calls it from an explicit user action or page view. Everything else is
a pure, read-only derivation. No user data leaves the machine.
"""

from __future__ import annotations

import json
import os
import tempfile
import time
from pathlib import Path
from typing import Any, Mapping, Optional

from . import discovery
from . import membership_api
from . import membership_store
from . import news
from .membership import PLAN_FAMILY_ALIASES, plan_index

# ------------------------------------------------- observed vs reported vs public

#: Spend/tokens recorded by the local Hermes ledger.
OBSERVED_USAGE = "observed_usage"
#: Quota windows reported live by the provider (``hermes usage`` probe).
PROVIDER_ALLOWANCE = "provider_allowance"
#: Advertised terms from the membership plan catalogue.
PUBLIC_PLAN_INFO = "public_plan_info"

SOURCE_KINDS = (OBSERVED_USAGE, PROVIDER_ALLOWANCE, PUBLIC_PLAN_INFO)

SOURCE_LABELS = {
    OBSERVED_USAGE: "Observed usage",
    PROVIDER_ALLOWANCE: "Provider-reported allowance",
    PUBLIC_PLAN_INFO: "Public plan information",
}

SOURCE_EXPLANATIONS = {
    OBSERVED_USAGE: (
        "Spend recorded by Hermes on this machine. It shows what was "
        "actually used, never what remains."
    ),
    PROVIDER_ALLOWANCE: (
        "Quota windows reported live by the provider. Read at view time, "
        "never stored, and never confused with observed spend."
    ),
    PUBLIC_PLAN_INFO: (
        "Advertised plan terms from the membership catalogue. A reference "
        "for what a plan includes, not a measurement of remaining use."
    ),
}


def describe_source(kind: str) -> dict[str, str]:
    """User-facing label and explanation for one source kind."""
    key = str(kind or "")
    if key in SOURCE_LABELS:
        return {"kind": key, "label": SOURCE_LABELS[key],
                "explanation": SOURCE_EXPLANATIONS[key]}
    return {"kind": key, "label": "Unknown source",
            "explanation": "This figure did not come from a recognised local source."}


# ------------------------------------------------- throttled local checks

#: Minimum gap between automatic local catalogue diffs (15 minutes). An
#: explicit user refresh bypasses the throttle with ``force=True``.
LOCAL_CHECK_INTERVAL_SECONDS = 900

MONITORING_STATE_NAME = "monitoring-state.json"


def state_path(data_dir: Optional[Path | str] = None) -> Path:
    """Profile-scoped path of the advisory monitoring state file."""
    if data_dir:
        return Path(data_dir) / MONITORING_STATE_NAME
    return news.snapshot_path(None).parent / MONITORING_STATE_NAME


def load_monitoring_state(data_dir: Optional[Path | str] = None) -> dict[str, Any]:
    """Read the last automatic local-check timestamp, if any."""
    target = state_path(data_dir)
    if not target.exists():
        return {"last_local_check": None, "error": ""}
    try:
        raw = json.loads(target.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        return {"last_local_check": None, "error": f"unreadable: {target.name}"}
    if not isinstance(raw, dict):
        return {"last_local_check": None, "error": f"unreadable: {target.name} is not an object"}
    stamp = raw.get("last_local_check")
    if stamp is None:
        return {"last_local_check": None, "error": ""}
    try:
        return {"last_local_check": float(stamp), "error": ""}
    except (TypeError, ValueError):
        return {"last_local_check": None, "error": f"unreadable: {target.name} has no usable timestamp"}


def _record_check(data_dir: Optional[Path | str], moment: float) -> None:
    target = state_path(data_dir)
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=str(target.parent), prefix=target.name, suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump({"last_local_check": moment}, handle)
            os.replace(tmp, target)
        except BaseException:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise
    except OSError:
        # Advisory state only: a failed write means the next view checks
        # again, which is safe because local diffs never touch the network.
        pass


def local_check_due(data_dir: Optional[Path | str] = None,
                     now: Optional[float] = None,
                     interval: float = LOCAL_CHECK_INTERVAL_SECONDS) -> bool:
    """Whether an automatic local catalogue diff is due.

    True when no baseline snapshot exists yet, when no check has been
    recorded, or when the last recorded check is older than ``interval``.
    """
    if not news.snapshot_path(data_dir).exists():
        return True
    moment = now if now is not None else time.time()
    last = load_monitoring_state(data_dir).get("last_local_check")
    if last is None:
        return True
    return moment - last >= interval


def maybe_refresh_local(*, data_dir: Optional[Path | str] = None,
                        catalogue: Any = None,
                        plans_doc: Optional[Mapping[str, Any]] = None,
                        now: Optional[float] = None,
                        force: bool = False,
                        interval: float = LOCAL_CHECK_INTERVAL_SECONDS) -> dict[str, Any]:
    """Run :func:`news.refresh_local` only when the throttle allows it.

    Returns ``{"checked", "reason", "checked_at", "result"}``. ``reason`` is
    one of ``forced`` (explicit user refresh), ``no_baseline`` (first ever
    check), ``due`` (interval elapsed), or ``fresh`` (skipped; ``result`` is
    None and ``checked_at`` is the previous check time, if known).
    """
    moment = now if now is not None else time.time()
    if not force:
        if news.snapshot_path(data_dir).exists():
            last = load_monitoring_state(data_dir).get("last_local_check")
            if last is not None and moment - last < interval:
                return {"checked": False, "reason": "fresh",
                        "checked_at": last, "result": None}
            reason = "no_check_recorded" if last is None else "due"
        else:
            reason = "no_baseline"
    else:
        reason = "forced"
    result = news.refresh_local(data_dir=data_dir, catalogue=catalogue,
                                plans_doc=plans_doc, now=moment)
    _record_check(data_dir, moment)
    return {"checked": True, "reason": reason, "checked_at": moment, "result": result}


# ------------------------------------------------- local relevance signals

def _usage_pairs(event_db: Optional[Path | str],
                 now: Optional[float]) -> set[tuple[str, str]]:
    try:
        usage = news.usage_summary(event_db, days=news.EVIDENCE_DAYS, now=now)
    except Exception:  # noqa: BLE001 - unreadable usage means no personalisation, not a failure
        return set()
    if not isinstance(usage, dict):
        return set()
    pairs: set[tuple[str, str]] = set()
    for key in usage:
        if isinstance(key, (tuple, list)) and len(key) == 2:
            pairs.add((str(key[0] or ""), str(key[1] or "")))
    return pairs


def local_signals(*, home: Optional[Path | str] = None,
                  event_db: Optional[Path | str] = None,
                  store_path: Optional[Path | str] = None,
                  plans_catalogue: Optional[Mapping[str, Any]] = None,
                  data_dir: Optional[Path | str] = None,
                  now: Optional[float] = None) -> dict[str, Any]:
    """Everything on this machine a news item can be relevant to.

    Combines configured credential families, recorded (provider, model)
    usage, and membership plan selections. Each source degrades to empty
    when its store is missing or unreadable; an empty config is a normal
    state, not an error.
    """
    try:
        slots = discovery.credential_slots(home)
    except Exception:  # noqa: BLE001 - ranking degrades, the news stays
        slots = {}
    configured = sorted(str(family) for family in slots) if isinstance(slots, dict) else []

    pairs = _usage_pairs(event_db, now)
    used_providers = sorted({provider for provider, _ in pairs if provider})
    used_models = [{"provider": provider, "model": model}
                   for provider, model in sorted(pairs) if provider or model]

    try:
        accounts = membership_store.load_store(store_path).get("accounts", [])
    except Exception:  # noqa: BLE001 - an unreadable store means no plan signals
        accounts = []
    if not isinstance(accounts, list):
        accounts = []
    plan_ids = sorted({str(account.get("plan_id") or "")
                       for account in accounts if isinstance(account, dict)} - {""})

    if plans_catalogue is None:
        try:
            plans_catalogue, _plans_source = membership_api.active_catalogue(
                data_dir=data_dir)
        except Exception:  # noqa: BLE001 - without a catalogue, plan ids carry no family
            plans_catalogue = {}
    try:
        index = plan_index(plans_catalogue)
    except Exception:  # noqa: BLE001 - a malformed catalogue means no plan families
        index = {}
    plan_families = sorted({str(index[plan_id].get("provider_family") or "")
                            for plan_id in plan_ids
                            if isinstance(index.get(plan_id), dict)} - {""})

    return {"configured_families": configured,
            "used_providers": used_providers,
            "used_models": used_models,
            "plan_ids": plan_ids,
            "plan_families": plan_families}


def has_signals(signals: Optional[Mapping[str, Any]]) -> bool:
    """Whether the machine knows anything a news item could match."""
    if not isinstance(signals, Mapping):
        return False
    for key in ("configured_families", "used_providers", "used_models",
                "plan_ids", "plan_families"):
        if signals.get(key):
            return True
    return False


# ------------------------------------------------- provider/model/plan matching

#: Stable relevance reason codes, in display order.
RELEVANCE_REASONS = ("configured_provider", "used_provider",
                     "used_model", "selected_plan_family")


def _normalise_family(value: str) -> str:
    lowered = str(value or "").strip().lower()
    return PLAN_FAMILY_ALIASES.get(lowered, lowered)


def match_relevance(item: Optional[Mapping[str, Any]],
                    signals: Optional[Mapping[str, Any]]) -> dict[str, Any]:
    """Explain why one news item is (or is not) relevant locally.

    Returns ``{"relevant", "reasons"}``; ``reasons`` holds stable codes from
    :data:`RELEVANCE_REASONS`. Provider comparison reuses the news route
    matching (:func:`news.canonical_route_provider`) so recorded routes
    such as ``openai-codex`` match catalogue providers such as ``openai``,
    exactly as For You ranking does. Matching uses only the local
    signals — never the network.
    """
    entry = item if isinstance(item, Mapping) else {}
    provided = signals if isinstance(signals, Mapping) else {}
    provider = str(entry.get("provider") or "").strip()
    model = str(entry.get("model") or "").strip()
    if not provider:
        return {"relevant": False, "reasons": []}
    family = _normalise_family(provider)
    route = news.canonical_route_provider(provider)
    reasons: list[str] = []
    configured = {_normalise_family(family_name)
                  for family_name in provided.get("configured_families", [])}
    configured |= {news.canonical_route_provider(family_name)
                   for family_name in provided.get("configured_families", [])}
    if family in configured or route in configured:
        reasons.append("configured_provider")
    used_providers = {news.canonical_route_provider(str(name or ""))
                      for name in provided.get("used_providers", [])}
    if route in used_providers:
        reasons.append("used_provider")
    if model:
        pairs = {(news.canonical_route_provider(str(pair.get("provider") or "")),
                  str(pair.get("model") or "").strip().lower())
                 for pair in provided.get("used_models", [])
                 if isinstance(pair, Mapping)}
        if (route, model.lower()) in pairs:
            reasons.append("used_model")
    planned = {_normalise_family(family_name)
               for family_name in provided.get("plan_families", [])}
    planned |= {news.canonical_route_provider(family_name)
                for family_name in provided.get("plan_families", [])}
    if family in planned or route in planned:
        reasons.append("selected_plan_family")
    return {"relevant": bool(reasons), "reasons": reasons}


def personalise_items(items: list[Mapping[str, Any]],
                      signals: Optional[Mapping[str, Any]]) -> list[dict[str, Any]]:
    """Return copies of ``items`` annotated with local ``relevance``.

    The input items are never mutated. Relevance is computed on this
    machine from :func:`local_signals`.
    """
    personalised: list[dict[str, Any]] = []
    for item in items or []:
        if not isinstance(item, Mapping):
            continue
        copy = dict(item)
        copy["relevance"] = match_relevance(item, signals)
        personalised.append(copy)
    return personalised


# ------------------------------------------------- accurate empty states

#: Stable empty-state codes returned by :func:`empty_state`.
EMPTY_STATES = ("has_news", "baseline", "no_changes", "no_config",
                "no_matches", "category_empty")


def _is_relevant(item: Mapping[str, Any]) -> bool:
    relevance = item.get("relevance")
    if isinstance(relevance, Mapping):
        return bool(relevance.get("relevant"))
    return bool(item.get("for_you"))


def empty_state(*, items: Optional[list[Mapping[str, Any]]] = None,
                scope: str = "foryou",
                category: str = "all",
                baseline: bool = False,
                signals: Optional[Mapping[str, Any]] = None) -> dict[str, str]:
    """Describe what an empty news list actually means.

    Returns ``{"state", "message"}``; ``message`` is empty when ``state`` is
    ``has_news``. ``items`` should be the personalised combined list: items
    annotated by :func:`personalise_items`, falling back to the stored
    ``for_you`` flag for items without a ``relevance`` entry.
    """
    pool = [item for item in items or [] if isinstance(item, Mapping)]
    if scope == "foryou":
        pool = [item for item in pool if _is_relevant(item)]
    if category != "all":
        pool = [item for item in pool if str(item.get("category") or "") == category]
    if pool:
        return {"state": "has_news", "message": ""}
    if baseline and not items:
        return {"state": "baseline",
                "message": "First snapshot recorded. Later catalogue changes "
                           "will appear here as news."}
    if category != "all":
        return {"state": "category_empty",
                "message": "Nothing in this category yet."}
    if scope == "foryou" and items:
        if has_signals(signals):
            return {"state": "no_matches",
                    "message": "There is news, but none of it mentions your "
                               "configured providers, recorded usage, or "
                               "selected plans."}
        return {"state": "no_config",
                "message": "Nothing to personalise yet: no providers are "
                           "configured, no usage is recorded, and no plans "
                           "are selected. For-you news appears once "
                           "SpendSense knows what you use."}
    return {"state": "no_changes",
            "message": "Catalogues unchanged since the last check. New "
                       "models, prices, and plans will appear here."}


# ------------------------------------------------- read-only combined view

def news_view(*, data_dir: Optional[Path | str] = None,
              event_db: Optional[Path | str] = None,
              home: Optional[Path | str] = None,
              store_path: Optional[Path | str] = None,
              plans_catalogue: Optional[Mapping[str, Any]] = None,
              scope: str = "foryou",
              category: str = "all",
              now: Optional[float] = None) -> dict[str, Any]:
    """One read-only call for the News view: payload, relevance, empty state.

    Combines the stored local news and cached central feed with local
    signals, per-item relevance reasons, and the accurate empty-state
    descriptor for the requested scope. Writes nothing and fetches nothing.
    """
    payload = news.news_payload(data_dir=data_dir, event_db=event_db,
                                home=home, now=now)
    signals = local_signals(home=home, event_db=event_db,
                            store_path=store_path,
                            plans_catalogue=plans_catalogue,
                            data_dir=data_dir, now=now)
    combined = [*(payload.get("local", {}) or {}).get("items", []),
                *(payload.get("central", {}) or {}).get("items", [])]
    personalised = personalise_items(combined, signals)
    state = empty_state(items=personalised, scope=scope, category=category,
                        baseline=bool((payload.get("local", {}) or {}).get("baseline")),
                        signals=signals)
    return {"ok": True, "items": personalised, "signals": signals,
            "empty": state, "settings": payload.get("settings", {}),
            "catalogue": payload.get("catalogue", {}),
            "for_you_count": sum(1 for item in personalised
                                 if _is_relevant(item)),
            "sources": {kind: describe_source(kind) for kind in SOURCE_KINDS}}


def personalise_payload(payload: dict[str, Any], *,
                        scope: str = "foryou",
                        category: str = "all",
                        signals: Optional[Mapping[str, Any]] = None,
                        home: Optional[Path | str] = None,
                        event_db: Optional[Path | str] = None,
                        store_path: Optional[Path | str] = None,
                        plans_catalogue: Optional[Mapping[str, Any]] = None,
                        data_dir: Optional[Path | str] = None,
                        now: Optional[float] = None) -> dict[str, Any]:
    """Annotate a news API payload with relevance reasons and an empty state.

    Additive only: each item in ``local``/``central`` gains a ``relevance``
    entry, and the payload gains ``signals``, ``sources`` and ``empty``.
    Stored ``for_you`` flags and ``for_you_count`` are left untouched as the
    ranking source of truth. Reads config and usage for signals; writes
    nothing and fetches nothing, so ``GET``-side enrichment stays read-only.
    """
    if signals is None:
        signals = local_signals(home=home, event_db=event_db,
                                store_path=store_path,
                                plans_catalogue=plans_catalogue,
                                data_dir=data_dir, now=now)
    local = payload.get("local", {}) or {}
    central = payload.get("central", {}) or {}
    combined = [*(local.get("items", []) or []),
                *(central.get("items", []) or [])]
    personalised = personalise_items(combined, signals)
    if isinstance(local, dict):
        local["items"] = [item for item in personalised
                          if item.get("origin") == "local"]
    if isinstance(central, dict):
        central["items"] = [item for item in personalised
                            if item.get("origin") == "central"]
    payload["signals"] = signals
    payload["sources"] = {kind: describe_source(kind) for kind in SOURCE_KINDS}
    payload["empty"] = empty_state(
        items=personalised, scope=scope, category=category,
        baseline=bool(local.get("baseline")) if isinstance(local, dict) else False,
        signals=signals)
    return payload
