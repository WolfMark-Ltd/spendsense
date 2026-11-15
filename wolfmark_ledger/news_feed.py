from __future__ import annotations

import hashlib
import json
import math
import re
from datetime import datetime, timedelta, timezone
from typing import Any, Mapping, Optional

from .news import CATEGORIES, CONFIDENCES, FEED_MAX_ITEMS, rate_direction, validate_feed
from . import news_briefing
from .pricing import _parse_catalogue

MODELS_DEV_URL = "https://models.dev"

#: Consecutive catalogue observations without a model before its absence counts
#: as a removal. One missing entry is a catalogue wobble, not a retirement.
REMOVAL_CONFIRMATIONS = 2

#: Bound on persisted history records so the sidecar stays small.
MAX_HISTORY_RECORDS = 6000

#: Soft ceiling for the published document. The client refuses a feed over
#: 256 KiB, so the editorial layer is trimmed — never the event archive — when
#: the two together would approach that cap.
FEED_SOFT_BYTES = 200 * 1024

HISTORY_VERSION = 1


def _table(raw: Any) -> dict[str, dict[str, dict[str, Any]]]:
    catalogue = _parse_catalogue(raw, source="models.dev", confidence="aggregator",
                                 as_of="", version="models.dev")
    if catalogue is None or not catalogue.providers:
        raise ValueError("snapshot has no priced providers")
    table: dict[str, dict[str, dict[str, Any]]] = {}
    for provider, models in catalogue.providers.items():
        rows: dict[str, dict[str, Any]] = {}
        for model, rate in models.items():
            rows[model] = {
                "input": rate.input, "output": rate.output,
                "cache_read": rate.cache_read, "cache_write": rate.cache_write,
                "tiers": [[tier.threshold, tier.input, tier.output,
                           tier.cache_read, tier.cache_write] for tier in rate.tiers],
            }
        table[provider] = rows
    return table


def _sig(entry: Mapping[str, Any]) -> str:
    return json.dumps(entry, sort_keys=True)


def _model_id(category: str, provider: str, model: str, old: str, new: str) -> str:
    # Stable across runs by design: the same diff re-emitted after a partial
    # failure must carry the same id, so carry-forward dedupes instead of
    # duplicating. Observation dates stay on the item, not in the id.
    digest = hashlib.sha1("|".join([category, provider, model, old, new])
                          .encode("utf-8")).hexdigest()[:12]
    return f"md-{digest}"


def _slim(entry: Mapping[str, Any]) -> dict[str, Any]:
    return {"input": entry.get("input"), "output": entry.get("output"),
            "cache_read": entry.get("cache_read"), "cache_write": entry.get("cache_write")}


def _other_providers(current: Mapping[str, dict[str, dict[str, Any]]],
                     provider: str, model: str) -> list[str]:
    """Providers other than ``provider`` that list ``model`` in this observation.

    Evidence for "now also available" against a launch: a model id already
    published elsewhere is an existing model newly listed here.
    """
    return sorted(name for name, rows in current.items()
                  if name != provider and model in rows)


def _first_seen(history: Optional[Mapping[str, Any]], provider: str,
                model: str, observed_at: str) -> str:
    """Earliest observation of this model, from history when it exists.

    Without history the honest answer is this observation: the feed may only
    claim what it has observed.
    """
    if not isinstance(history, Mapping):
        return observed_at
    by_model = history.get("model_first_seen")
    if isinstance(by_model, Mapping):
        stored = by_model.get(model) or by_model.get(model.split("/")[-1])
        if isinstance(stored, str) and stored:
            return stored
    by_provider = history.get("first_seen")
    if isinstance(by_provider, Mapping):
        rows = by_provider.get(provider)
        if isinstance(rows, Mapping):
            stored = rows.get(model)
            if isinstance(stored, str) and stored:
                return stored
    return observed_at


def _model_diff(previous: Mapping[str, dict[str, dict[str, Any]]],
                current: Mapping[str, dict[str, dict[str, Any]]],
                observed_at: str,
                history: Optional[Mapping[str, Any]] = None) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    for provider in sorted(set(current) - set(previous)):
        models = current[provider]
        items.append({
            "id": _model_id("new_model", provider, "", "", str(len(models))),
            "category": "new_model", "provider": provider, "model": "",
            "event_type": "provider_listed",
            "summary": f"{provider} newly listed on models.dev with {len(models)} priced model(s).",
            "summary_code": "news_sum_new_provider_feed",
            "summary_params": {"provider": str(provider), "count": len(models)},
            "previous": None, "current": None,
            "observed_at": observed_at, "effective_at": "",
            "source_url": MODELS_DEV_URL, "confidence": "observed",
            "provenance": "models.dev",
            "conditions": "Catalogue listing only; not confirmed available on any account.",
            "conditions_code": "news_cond_listing_any_account",
        })
    for provider in sorted(set(current) & set(previous)):
        before, after = previous[provider], current[provider]
        for model in sorted(set(after) - set(before)):
            entry = after[model]
            others = _other_providers(current, provider, model)
            first_seen = _first_seen(history, provider, model, observed_at)
            event_type = "newly_available" if others else "new_to_catalogue"
            item = {
                "id": _model_id("new_model", provider, model, "", _sig(entry)),
                "category": "new_model", "provider": provider, "model": model,
                "event_type": event_type,
                "summary": f"{model} newly listed under {provider} on models.dev.",
                "summary_code": "news_sum_new_model_feed",
                "summary_params": {"model": str(model), "provider": str(provider)},
                "previous": None, "current": _slim(entry),
                "observed_at": observed_at, "effective_at": "",
                "source_url": MODELS_DEV_URL, "confidence": "observed",
                "provenance": "models.dev",
                "conditions": "Catalogue listing only; not confirmed available on any account.",
                "conditions_code": "news_cond_listing_any_account",
                "other_providers": others,
                "first_seen_at": first_seen,
            }
            signals = ([news_briefing.SIGNAL_PREVIEW]
                       if news_briefing.preview_signal(model) else [])
            if signals:
                item["signals"] = signals
            items.append(item)
        for model in sorted(set(before) & set(after)):
            old_entry, new_entry = before[model], after[model]
            if _sig(old_entry) == _sig(new_entry):
                continue
            category = rate_direction(old_entry, new_entry)
            old_sig, new_sig = _sig(old_entry), _sig(new_entry)
            tier_note = "Tiered/context pricing changed; base rates compared." \
                if old_entry.get("tiers") != new_entry.get("tiers") else ""
            change = news_briefing.rate_deltas(_slim(old_entry), _slim(new_entry))
            # The v1 category keeps its input+output-total semantics for older
            # clients; event_type reports what each rate type actually did, so a
            # change that cuts one rate and raises another is not flattened.
            if change["direction"] == "mixed":
                event_type = "price_mixed"
            elif change["direction"] == "down":
                event_type = "price_reduction"
            elif change["direction"] == "up":
                event_type = "price_increase"
            else:
                event_type = category
            items.append({
                "id": _model_id(category, provider, model, old_sig, new_sig),
                "category": category, "provider": provider, "model": model,
                "event_type": event_type,
                "summary": f"{model} ({provider}) list price changed on models.dev.",
                "summary_code": "news_sum_price_change_feed",
                "summary_params": {"model": str(model), "provider": str(provider)},
                "previous": _slim(old_entry), "current": _slim(new_entry),
                "has_tiers": bool(old_entry.get("tiers") or new_entry.get("tiers")),
                "observed_at": observed_at, "effective_at": "",
                "source_url": MODELS_DEV_URL, "confidence": "observed",
                "provenance": "models.dev",
                "conditions": tier_note,
                "conditions_code": "news_cond_tiers_changed" if tier_note else "",
                "change": {"direction": change["direction"],
                           "dominant": change["dominant"],
                           "max_abs_pct": change["max_abs_pct"],
                           "max_abs_delta": change["max_abs_delta"],
                           "rates": change["rates"],
                           "incomparable": change["incomparable"]},
            })
    return items


def _empty_history() -> dict[str, Any]:
    return {
        "version": HISTORY_VERSION,
        "observations": 0,
        "last_observed_at": "",
        "first_seen": {},
        "model_first_seen": {},
        "missing": {},
        "removed": {},
        "provider_absent": {},
    }


def _stamp_text(value: Any) -> str:
    """An ISO timestamp, truncated to the feed's timestamp width."""
    return value.strip()[:64] if isinstance(value, str) else ""


#: Supported widths for the identity fields a removal record carries. These
#: follow the published schema, not the timestamp width: shortening a model id
#: would rename the model in a headline and collide two ids that share a prefix.
MAX_PROVIDER_CHARS = 128
MAX_MODEL_CHARS = 256
MAX_URL_CHARS = 500
MAX_PROVENANCE_CHARS = 256
MAX_CONFIDENCE_CHARS = 32


def _identity(value: Any, limit: int) -> str:
    return value.strip()[:limit] if isinstance(value, str) else ""


def _count(value: Any) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else 0


def _coerced_history(prior: Any) -> dict[str, Any]:
    """Copy a stored history, validating every nested record.

    A corrupt, foreign or partially written sidecar must degrade to "no
    history" (no removal claims) rather than fail the publishing run, and it
    must never leave a half-shaped value that explodes on the next observation.
    Each field is rebuilt from validated pieces; anything unrecognised is
    dropped.
    """
    state = _empty_history()
    if not isinstance(prior, Mapping) or prior.get("version") != HISTORY_VERSION:
        return state

    raw = prior.get("first_seen")
    if isinstance(raw, Mapping):
        for provider, rows in raw.items():
            if not isinstance(rows, Mapping):
                continue
            cleaned = {str(model): _stamp_text(stamp) for model, stamp in rows.items()
                       if _stamp_text(stamp)}
            if cleaned:
                state["first_seen"][str(provider)] = cleaned

    raw = prior.get("model_first_seen")
    if isinstance(raw, Mapping):
        state["model_first_seen"] = {str(model): _stamp_text(stamp)
                                     for model, stamp in raw.items()
                                     if _stamp_text(stamp)}

    raw = prior.get("missing")
    if isinstance(raw, Mapping):
        for provider, rows in raw.items():
            if not isinstance(rows, Mapping):
                continue
            cleaned = {str(model): {"count": _count(entry.get("count")),
                                    "since": _stamp_text(entry.get("since"))}
                       for model, entry in rows.items()
                       if isinstance(entry, Mapping) and _count(entry.get("count"))}
            if cleaned:
                state["missing"][str(provider)] = cleaned

    raw = prior.get("removed")
    if isinstance(raw, Mapping):
        for key, record in raw.items():
            if not isinstance(record, Mapping):
                continue
            provider = _identity(record.get("provider"), MAX_PROVIDER_CHARS)
            removed_at = _stamp_text(record.get("removed_at"))
            if not provider or not removed_at:
                continue
            state["removed"][str(key)] = {
                "provider": provider,
                "model": _identity(record.get("model"), MAX_MODEL_CHARS),
                "removed_at": removed_at,
                "missing_since": _stamp_text(record.get("missing_since")),
                "consecutive": _count(record.get("consecutive")),
                "last_present_at": _stamp_text(record.get("last_present_at")),
                "source_url": _identity(record.get("source_url"), MAX_URL_CHARS),
                "provenance": _identity(record.get("provenance"), MAX_PROVENANCE_CHARS),
                "confidence": (_identity(record.get("confidence"), MAX_CONFIDENCE_CHARS)
                               or "observed"),
            }

    raw = prior.get("provider_absent")
    if isinstance(raw, Mapping):
        for provider, entry in raw.items():
            if not isinstance(entry, Mapping) or not _count(entry.get("count")):
                continue
            state["provider_absent"][str(provider)] = {
                "count": _count(entry.get("count")),
                "since": _stamp_text(entry.get("since")),
            }

    value = prior.get("observations")
    if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
        state["observations"] = value
    state["last_observed_at"] = _stamp_text(prior.get("last_observed_at"))
    return state


def _prune(records: Mapping[str, Any], limit: int) -> dict[str, Any]:
    if len(records) <= limit:
        return dict(records)

    def _stamp(pair: tuple[str, Any]) -> str:
        value = pair[1]
        return str(value.get("removed_at") or value.get("since") or "") \
            if isinstance(value, Mapping) else str(value or "")

    kept = sorted(records.items(), key=_stamp, reverse=True)[:limit]
    return dict(kept)


def _prune_nested(by_provider: Mapping[str, Any], limit: int,
                  stamp: str) -> dict[str, Any]:
    """Bound a ``{provider: {model: record}}`` map by its oldest records.

    ``record`` is either an ISO date (``first_seen``) or a mapping holding the
    date under ``stamp`` (``missing``). Dropping the oldest first-seen evidence
    only costs the "first observed …" phrasing for a very old model; it never
    creates a removal, because absence is judged against ``first_seen`` itself.
    """
    total = sum(len(rows) for rows in by_provider.values()
                if isinstance(rows, Mapping))
    if total <= limit:
        return dict(by_provider)
    flat: list[tuple[str, str, Any]] = []
    for provider, rows in by_provider.items():
        if not isinstance(rows, Mapping):
            continue
        for model, record in rows.items():
            value = record.get(stamp) if isinstance(record, Mapping) else record
            flat.append((provider, str(model), (str(value or ""), record)))
    flat.sort(key=lambda row: row[2][0], reverse=True)
    out: dict[str, Any] = {}
    for provider, model, (_stamp, record) in flat[:limit]:
        out.setdefault(provider, {})[model] = record
    return out


def _record_key(provider: str, model: str = "") -> str:
    """Flat key for a removal record: provider and model stay separable."""
    return f"{provider}\u001f{model}"


def update_history(prior: Any, current: Any, *, observed_at: str,
                   removal_after: int = REMOVAL_CONFIRMATIONS,
                   max_records: int = MAX_HISTORY_RECORDS,
                   ) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Advance catalogue history and return confirmed removals.

    A model is reported removed only when it was present in a previous
    observation and then absent from ``removal_after`` consecutive observations
    of a provider that is itself still listed. When the whole provider vanishes
    it is reported once as a provider delisting, never as hundreds of model
    removals. Reappearance clears the record, so a catalogue wobble corrects
    itself on the next run.

    A repeated call with the same ``observed_at`` is a publisher retry, not a
    new observation: it re-derives the state without advancing any absence
    counter, so one real missing observation can never become two and confirm a
    removal on its own.

    Returns ``(state, removals)``; ``state`` is JSON-serialisable and belongs in
    a publisher-side sidecar, not in the public feed.
    """
    table = _table(current)
    state = _coerced_history(prior)
    last = state.get("last_observed_at")
    replay = isinstance(last, str) and last != "" and last == observed_at
    step = 0 if replay else 1
    state["observations"] += step
    state["last_observed_at"] = observed_at
    first_seen = state["first_seen"]
    model_first = state["model_first_seen"]
    missing = state["missing"]
    removed = state["removed"]
    provider_absent = state["provider_absent"]
    cutoff = max(0, int(removal_after))

    for provider, models in table.items():
        rows = first_seen.setdefault(provider, {})
        for model in models:
            rows.setdefault(model, observed_at)
            model_first.setdefault(str(model).split("/")[-1], observed_at)
        provider_absent.pop(provider, None)
        removed.pop(_record_key(provider), None)

    for provider, rows in list(first_seen.items()):
        if provider not in table:
            entry = provider_absent.setdefault(provider, {"count": 0, "since": observed_at})
            entry["count"] = int(entry.get("count") or 0) + step
            key = _record_key(provider)
            if entry["count"] >= cutoff and key not in removed:
                # One delisting replaces any earlier per-model removals for this
                # provider: keeping both would show the same disappearance twice.
                prefix = f"{provider}\u001f"
                for stale in [name for name in removed
                              if name.startswith(prefix) and name != key]:
                    removed.pop(stale, None)
                removed[key] = {
                    "provider": provider, "model": "",
                    "removed_at": observed_at, "missing_since": entry.get("since", ""),
                    "consecutive": entry["count"], "last_present_at": "",
                    "source_url": MODELS_DEV_URL, "provenance": "models.dev",
                    "confidence": "observed",
                }
            continue
        present = table[provider]
        for model in list(rows):
            if model in present:
                missing.get(provider, {}).pop(model, None)
                removed.pop(_record_key(provider, model), None)
                continue
            entry = missing.setdefault(provider, {}).setdefault(
                model, {"count": 0, "since": observed_at})
            entry["count"] = int(entry.get("count") or 0) + step
            key = _record_key(provider, model)
            if entry["count"] >= cutoff and key not in removed:
                removed[key] = {
                    "provider": provider, "model": model,
                    "removed_at": observed_at, "missing_since": entry.get("since", ""),
                    "consecutive": entry["count"],
                    "last_present_at": str(rows.get(model) or ""),
                    "source_url": MODELS_DEV_URL, "provenance": "models.dev",
                    "confidence": "observed",
                }

    state["first_seen"] = _prune_nested(first_seen, max_records, "first_seen")
    state["model_first_seen"] = _prune(dict(model_first), max_records)
    state["missing"] = _prune_nested(missing, max_records, "since")
    state["removed"] = _prune(removed, max_records)
    return state, history_removals(state)


def history_removals(history: Any) -> list[dict[str, Any]]:
    """Confirmed removal records from a history state, newest first."""
    if not isinstance(history, Mapping):
        return []
    records = history.get("removed")
    if not isinstance(records, Mapping):
        return []
    out = [record for record in records.values() if isinstance(record, Mapping)]
    out.sort(key=lambda record: (str(record.get("removed_at") or ""),
                                 str(record.get("provider") or ""),
                                 str(record.get("model") or "")), reverse=True)
    return [dict(record) for record in out]


def _rate_block(value: Any) -> Optional[dict[str, Any]]:
    if not isinstance(value, dict):
        return None
    out: dict[str, Any] = {}
    for key in ("input", "output", "cache_read", "cache_write"):
        raw = value.get(key)
        if raw is None:
            out[key] = None
        elif isinstance(raw, bool) or not isinstance(raw, (int, float)):
            return None
        elif not math.isfinite(raw) or raw < 0:
            return None
        else:
            out[key] = float(raw)
    if out["input"] is None or out["output"] is None:
        return None
    return out


_STABLE_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,63}")


def _curated(entries: Any, observed_at: str) -> tuple[list[dict[str, Any]], list[str]]:
    items: list[dict[str, Any]] = []
    problems: list[str] = []
    if not isinstance(entries, list):
        return items, ["curated announcements entry is not a list"]
    seen: set[str] = set()
    for position, entry in enumerate(entries):
        where = f"curated announcement {position}"
        if not isinstance(entry, dict):
            problems.append(f"{where}: not an object")
            continue
        provider = str(entry.get("provider") or "").strip()
        summary = str(entry.get("summary") or "").strip()
        source_url = str(entry.get("source_url") or "").strip()
        if not provider or not summary or not source_url:
            problems.append(f"{where}: provider, summary and source_url are required")
            continue
        if not source_url.startswith("https://"):
            problems.append(f"{where}: source_url must be https")
            continue
        category = entry.get("category") or "subscription"
        if category not in CATEGORIES:
            problems.append(f"{where}: unknown category")
            continue
        previous = entry.get("previous")
        current = entry.get("current")
        if previous is not None and _rate_block(previous) is None:
            problems.append(f"{where}: invalid previous rates")
            continue
        if current is not None and _rate_block(current) is None:
            problems.append(f"{where}: invalid current rates")
            continue
        if category in ("price_reduction", "price_increase") and (previous is None or current is None):
            problems.append(f"{where}: price changes need previous and current rates")
            continue
        confidence = entry.get("confidence") or "curated"
        if confidence not in CONFIDENCES:
            problems.append(f"{where}: unknown confidence")
            continue
        event_type = entry.get("event_type")
        if event_type is not None:
            if not isinstance(event_type, str) or event_type not in news_briefing.EVENT_TYPES:
                problems.append(f"{where}: unknown event_type")
                continue
        raw_id = entry.get("id")
        if raw_id is None:
            digest = hashlib.sha1("|".join([provider, str(entry.get("model") or ""),
                                            summary, source_url]).encode("utf-8")).hexdigest()[:12]
            item_id = f"sub-{digest}"
        else:
            item_id = str(raw_id).strip()
            if not _STABLE_ID.fullmatch(item_id):
                problems.append(f"{where}: id must be 1-64 letters, digits, . _ : -")
                continue
            if item_id.startswith("md-"):
                problems.append(f"{where}: id prefix 'md-' is reserved for model items")
                continue
        if item_id in seen:
            problems.append(f"{where}: duplicate curated id {item_id}")
            continue
        seen.add(item_id)
        items.append({
            "id": item_id,
            "category": category, "provider": provider,
            "model": str(entry.get("model") or "").strip()[:256],
            "summary": summary[:500],
            "previous": _rate_block(previous) if previous is not None else None,
            "current": _rate_block(current) if current is not None else None,
            "observed_at": str(entry.get("observed_at") or observed_at).strip()[:64],
            "effective_at": str(entry.get("effective_at") or "").strip()[:64],
            "source_url": source_url[:500], "confidence": confidence,
            "provenance": str(entry.get("provenance") or "SpendSense curation").strip()[:256],
            "conditions": str(entry.get("conditions") or "").strip()[:500],
            # An operator-curated note is the only place a launch, a removal or
            # a new plan can be claimed with verified/curated confidence.
            **({"event_type": event_type} if event_type else {}),
        })
    return items, problems


def _sort_key(item: Mapping[str, Any]) -> tuple[str, str, str, str, str]:
    return (str(item.get("observed_at") or ""), str(item.get("provider") or ""),
            str(item.get("model") or ""), str(item.get("category") or ""),
            str(item.get("id") or ""))


def _carried_items(prior_feed: Any, fresh_ids: set[str], observed_at: str,
                   retain_days: int) -> tuple[list[dict[str, Any]], list[str]]:
    """Prior published items still within the retention window.

    The prior feed is re-validated with the same client rules; anything
    invalid fails the run rather than republishing bad data. Carried items
    split into curated and model groups by this generator's own id scheme.
    """
    validated, prior_problems = validate_feed(prior_feed)
    if validated is None or prior_problems:
        detail = "; ".join(prior_problems) or "unreadable"
        return [], [f"prior feed invalid: {detail}"]
    try:
        now = datetime.fromisoformat(observed_at)
    except ValueError:
        now = datetime.now(timezone.utc)
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    cutoff = now - timedelta(days=max(0, retain_days))
    carried: list[dict[str, Any]] = []
    for item in validated["items"]:
        if item["id"] in fresh_ids:
            continue
        try:
            seen = datetime.fromisoformat(item["observed_at"])
        except ValueError:
            continue
        if seen.tzinfo is None:
            seen = seen.replace(tzinfo=timezone.utc)
        if seen < cutoff:
            continue
        carried.append(item)
    return carried, []


def _is_generic_listing(item: Mapping[str, Any]) -> bool:
    """True for a "provider newly listed" line, however old it is.

    Items carried from an older feed have no ``event_type``, so the shape is
    checked too: a ``new_model`` with no model id names no model and is still
    catalogue bookkeeping.
    """
    event_type = str(item.get("event_type") or "")
    if event_type:
        return event_type == "provider_listed"
    return (str(item.get("category") or "") == "new_model"
            and not str(item.get("model") or "").strip())


def _document_bytes(items: list[dict[str, Any]]) -> int:
    return len(json.dumps({"version": 1, "items": items}, separators=(",", ":")))


def _bounded_items(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Drop derivable per-item metadata when the archive alone is too big.

    ``change`` is recomputable from ``previous``/``current`` and is the first
    thing a size squeeze costs; the enrichment fields follow. Events are never
    dropped here — a feed that silently loses catalogue changes is worse than
    one whose client can recompute a percentage.
    """
    if _document_bytes(items) <= FEED_SOFT_BYTES:
        return items
    thinner = [{key: value for key, value in item.items() if key != "change"}
               for item in items]
    if _document_bytes(thinner) <= FEED_SOFT_BYTES:
        return thinner
    return [{key: value for key, value in item.items()
             if key not in ("change", "other_providers", "first_seen_at")}
            for item in thinner]


def build_feed(current: Any, previous: Any, curated_doc: Any, *,
               observed_at: str, prior_feed: Any = None,
               retain_days: int = 90,
               history: Any = None) -> tuple[dict[str, Any], list[str]]:
    """Diff two models.dev snapshots and merge validated curated notes.

    ``prior_feed`` carries the last published feed's recent items forward so
    history survives across runs; items older than ``retain_days`` expire.

    ``history`` is the publisher-side catalogue history from
    :func:`update_history`. Supplying it adds evidence (first-seen dates,
    cross-provider availability, confirmed removals); omitting it keeps every
    event and simply claims less — no removal or retirement is ever inferred
    without it.
    """
    problems: list[str] = []
    model_items: list[dict[str, Any]] = []
    if previous is None:
        try:
            _table(current)
        except ValueError as exc:
            problems.append(f"current snapshot: {exc}")
    else:
        try:
            prev_table = _table(previous)
        except ValueError as exc:
            problems.append(f"previous snapshot: {exc}")
            prev_table = None
        try:
            cur_table: Optional[dict[str, dict[str, dict[str, Any]]]] = _table(current)
        except ValueError as exc:
            problems.append(f"current snapshot: {exc}")
            cur_table = None
        if prev_table is not None and cur_table is not None:
            model_items = _model_diff(prev_table, cur_table, observed_at,
                                      history=history)
    announcements = curated_doc.get("announcements", []) if isinstance(curated_doc, dict) else None
    curated_items, curated_problems = _curated(announcements, observed_at)
    problems.extend(curated_problems)
    raw_withdraw = curated_doc.get("withdraw", []) if isinstance(curated_doc, dict) else []
    withdrawn: set[str] = set()
    if raw_withdraw is None:
        pass
    elif not isinstance(raw_withdraw, list) or any(not isinstance(x, str) for x in raw_withdraw):
        problems.append("curated withdraw entry must be a list of ids")
    else:
        withdrawn = set(raw_withdraw)
    if prior_feed is not None:
        fresh_ids = {item["id"] for item in model_items} | {item["id"] for item in curated_items}
        carried, carry_problems = _carried_items(prior_feed, fresh_ids, observed_at, retain_days)
        problems.extend(carry_problems)
        for item in carried:
            if item["id"] in withdrawn:
                continue  # explicit withdrawal beats carry-forward
            if item["id"].startswith("md-"):
                model_items.append(item)
            else:
                # Curated notes (sub- hashes and operator stable ids) keep
                # their reserved capacity; unknown ids fail that safe way too.
                curated_items.append(item)
    if len(curated_items) > FEED_MAX_ITEMS:
        problems.append(f"curated announcements exceed the {FEED_MAX_ITEMS}-item feed limit")
        curated_items = []
    model_items.sort(key=_sort_key, reverse=True)
    curated_items.sort(key=_sort_key, reverse=True)
    room = max(0, FEED_MAX_ITEMS - len(curated_items))
    if len(model_items) > room:
        # Generic "provider newly listed" lines are the lowest-value events in
        # the feed: they name no model and describe catalogue bookkeeping. Drop
        # them before any event with a model identity, so the cap costs the
        # archive as little as possible.
        generic = [item for item in model_items if _is_generic_listing(item)]
        specific = [item for item in model_items if not _is_generic_listing(item)]
        kept_models = specific[:room]
        if len(kept_models) < room:
            kept_models.extend(generic[:room - len(kept_models)])
        kept_models.sort(key=_sort_key, reverse=True)
    else:
        kept_models = model_items[:room]
    dropped = len(model_items) - len(kept_models)
    items = _bounded_items(sorted(kept_models + curated_items, key=_sort_key, reverse=True))
    doc: dict[str, Any] = {"version": 1, "generated_at": observed_at, "items": items}
    if dropped:
        doc["truncated"] = {"model_items_dropped": dropped}
    doc["briefing"] = _fitted_briefing(doc, items, observed_at,
                                       history_removals(history),
                                       removal_tracking=history is not None)
    if doc["briefing"] is None:
        del doc["briefing"]
    return doc, problems


def _fitted_briefing(doc: Mapping[str, Any], items: list[dict[str, Any]],
                     observed_at: str, removals: list[dict[str, Any]],
                     *, removal_tracking: bool = False,
                     ) -> Optional[dict[str, Any]]:
    """Briefing trimmed to the document's byte budget, or ``None``.

    The archive is never shrunk to make room for editorial text: the briefing
    is rebuilt with fewer rows per section and finally dropped.
    """
    space = max(0, FEED_SOFT_BYTES - len(json.dumps(doc, separators=(",", ":"))))
    for limit in (news_briefing.SECTION_LIMIT, 4, 2):
        briefing = news_briefing.build_briefing(
            items, generated_at=observed_at, removals=removals,
            removal_tracking=removal_tracking, section_limit=limit)
        if len(json.dumps(briefing, separators=(",", ":"))) <= space:
            return briefing
    return None
