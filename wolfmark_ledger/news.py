"""Model News: local catalogue-change detection and optional central updates.

Two origins, one schema:

* **local** — diffs of the Hermes models.dev cache (via
  :func:`wolfmark_ledger.pricing.load_catalogue`, the supported read path)
  plus diffs of the bundled membership plan catalogue. The first snapshot
  is a baseline and produces no news. Nothing here touches the network.
* **central** — a public, curated Spend Sense feed fetched over HTTPS only
  when the profile opts in with "Spend Sense Live Updates". No user data
  is sent; see :func:`fetch_central`.

All state lives in profile-scoped plugin storage next to the other JSON
stores (``news-snapshot.json``, ``news-local.json``, ``news-settings.json``,
``news-feed-cache.json``). Writes use the shared cross-process file lock
and atomic replace, mirroring ``billing.py``.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import tempfile
from contextlib import ExitStack
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping, Optional
from urllib.request import Request, urlopen

from . import discovery
from . import store as usage_store
from .filelock import locked as _locked
from .pricing import PROVIDER_ALIASES, Catalogue

NEWS_VERSION = 1

CATEGORIES = ("new_model", "price_reduction", "price_increase", "subscription")
CONFIDENCES = ("observed", "verified", "curated")

#: Fixed public endpoint for the optional central feed. Documented in
#: news-feed/README.md; not yet deployed. This URL never receives user data:
#: the fetch is an unauthenticated GET with static headers and no query string.
FEED_URL = "https://spendsense.wolfmark.co.uk/feed/v1/news.json"
FEED_TIMEOUT = 10.0
FEED_MAX_BYTES = 256 * 1024
FEED_CACHE_SECONDS = 6 * 3600
FEED_MAX_ITEMS = 200

#: Stored local items are capped; newest win. A catalogue resync can produce
#: a burst, but history older than this is not actionable news.
MAX_STORED_ITEMS = 500
#: Token-usage window behind personalised impact estimates.
IMPACT_DAYS = 30
#: Usage window behind "used model" evidence for For You ranking.
EVIDENCE_DAYS = 90

SNAPSHOT_NAME = "news-snapshot.json"
ITEMS_NAME = "news-local.json"
SETTINGS_NAME = "news-settings.json"
CACHE_NAME = "news-feed-cache.json"


# ------------------------------------------------------------------ paths

def _plugin_data_dir() -> Path:
    try:
        from plugins.plugin_storage import plugin_data_dir

        return plugin_data_dir("spend-sense")
    except Exception:
        pass
    try:
        from hermes_constants import get_hermes_home

        base = Path(get_hermes_home())
    except Exception:
        base = Path(os.environ.get("HERMES_HOME") or Path.home() / ".hermes")
    return base / "plugin-data" / "spend-sense"


def _resolve(name: str, data_dir: Optional[Path | str] = None) -> Path:
    if data_dir:
        return Path(data_dir) / name
    return _plugin_data_dir() / name


def snapshot_path(data_dir: Optional[Path | str] = None) -> Path:
    return _resolve(SNAPSHOT_NAME, data_dir)


def items_path(data_dir: Optional[Path | str] = None) -> Path:
    return _resolve(ITEMS_NAME, data_dir)


def settings_path(data_dir: Optional[Path | str] = None) -> Path:
    return _resolve(SETTINGS_NAME, data_dir)


def cache_path(data_dir: Optional[Path | str] = None) -> Path:
    return _resolve(CACHE_NAME, data_dir)


def plans_catalogue_path() -> Path:
    return Path(__file__).resolve().parent.parent / "catalogue" / "plans.json"


# ------------------------------------------------------------------ json io

def _read_json(target: Path) -> tuple[Optional[dict[str, Any]], str]:
    if not target.exists():
        return None, ""
    try:
        raw = json.loads(target.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        return None, f"unreadable: {target.name}"
    if not isinstance(raw, dict):
        return None, f"unreadable: {target.name} is not an object"
    return raw, ""


def _atomic_write_json(target: Path, payload: Mapping[str, Any]) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    handle = tempfile.NamedTemporaryFile("w", dir=target.parent, delete=False,
                                         suffix=".tmp", encoding="utf-8")
    try:
        json.dump(payload, handle, indent=2, sort_keys=True, default=str)
        handle.flush()
        os.fsync(handle.fileno())
        handle.close()
        os.replace(handle.name, target)
    finally:
        if not handle.closed:
            handle.close()
        if os.path.exists(handle.name):
            os.unlink(handle.name)


def _now_iso(now: Optional[float] = None) -> str:
    import time as _time

    moment = now if now is not None else _time.time()
    return datetime.fromtimestamp(moment, timezone.utc).isoformat()


# ------------------------------------------------------------------ settings

def load_settings(path: Optional[Path | str] = None) -> dict[str, Any]:
    """Live-updates opt-in. Missing, corrupt or unknown content means OFF."""
    target = Path(path) if path else settings_path()
    raw, error = _read_json(target)
    if raw is None:
        return {"live_updates": False, "loaded": False, "error": error}
    enabled = raw.get("live_updates") is True and raw.get("version", 1) == 1
    return {"live_updates": enabled, "loaded": True, "error": ""}


def save_settings(live_updates: bool, path: Optional[Path | str] = None) -> dict[str, Any]:
    if not isinstance(live_updates, bool):
        raise ValueError("live_updates must be true or false")
    target = Path(path) if path else settings_path()
    with _locked(target):
        _atomic_write_json(target, {"version": NEWS_VERSION, "live_updates": live_updates})
    return {"live_updates": live_updates}


# ------------------------------------------------------------------ snapshot

def _tier_sig(tiers: Any) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for tier in tiers or ():
        threshold = getattr(tier, "threshold", None)
        if threshold is None and isinstance(tier, dict):
            threshold = tier.get("threshold")
        if threshold is None:
            continue

        def pick(name: str) -> Any:
            value = getattr(tier, name, None) if not isinstance(tier, dict) else tier.get(name)
            return value if isinstance(value, (int, float)) else None

        out.append({"threshold": threshold, "input": pick("input"),
                    "output": pick("output"), "cache_read": pick("cache_read"),
                    "cache_write": pick("cache_write")})
    out.sort(key=lambda row: (row["threshold"] if isinstance(row["threshold"], (int, float)) else 0))
    return out


def _rate_entry(rate: Any) -> dict[str, Any]:
    def pick(name: str) -> Any:
        value = getattr(rate, name, None)
        return value if isinstance(value, (int, float)) else None

    return {"input": pick("input"), "output": pick("output"),
            "cache_read": pick("cache_read"), "cache_write": pick("cache_write"),
            "tiers": _tier_sig(getattr(rate, "tiers", ()))}


def _plans_table(doc: Mapping[str, Any]) -> dict[str, dict[str, Any]]:
    table: dict[str, dict[str, Any]] = {}
    plans = doc.get("plans") if isinstance(doc, Mapping) else None
    if not isinstance(plans, list):
        return table
    for plan in plans:
        if not isinstance(plan, dict):
            continue
        plan_id = str(plan.get("id") or "").strip()
        if not plan_id:
            continue
        price = plan.get("price") if isinstance(plan.get("price"), dict) else {}
        verification = plan.get("verification") if isinstance(plan.get("verification"), dict) else {}
        table[plan_id] = {
            "family": str(plan.get("provider_family") or ""),
            "name": str(plan.get("name") or plan_id),
            "price": {"amount": price.get("amount"), "currency": price.get("currency"),
                      "period": price.get("period")},
            "terms": json.dumps(plan.get("entitlements"), sort_keys=True, default=str),
            "source_id": str(verification.get("source_id") or ""),
        }
    return table


def _source_urls(doc: Mapping[str, Any]) -> dict[str, str]:
    urls: dict[str, str] = {}
    sources = doc.get("sources") if isinstance(doc, Mapping) else None
    if isinstance(sources, list):
        for row in sources:
            if isinstance(row, dict) and row.get("id") and row.get("url"):
                urls[str(row["id"])] = str(row["url"])
    return urls


def snapshot_catalogue(book: Catalogue, plans_doc: Optional[Mapping[str, Any]]) -> dict[str, Any]:
    """Capture the priced catalogue rows plus plan fees/terms for later diffing."""
    providers: dict[str, dict[str, dict[str, Any]]] = {}
    for provider, models in (book.providers or {}).items():
        rows: dict[str, dict[str, Any]] = {}
        for model, rate in (models or {}).items():
            if not isinstance(model, str) or rate is None:
                continue
            if getattr(rate, "input", None) is None or getattr(rate, "output", None) is None:
                continue
            rows[model] = _rate_entry(rate)
        if rows:
            providers[str(provider)] = rows
    return {
        "version": NEWS_VERSION,
        "catalogue_source": book.source,
        "catalogue_as_of": book.as_of,
        "providers": providers,
        "plans": _plans_table(plans_doc or {}),
    }


def load_plans_doc(path: Optional[Path] = None) -> dict[str, Any]:
    target = Path(path) if path else plans_catalogue_path()
    try:
        raw = json.loads(target.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        return {}
    return raw if isinstance(raw, dict) else {}


# ------------------------------------------------------------------ diff

def _stable_id(*parts: str) -> str:
    digest = hashlib.sha1("|".join(parts).encode("utf-8")).hexdigest()[:10]
    slug = "-".join("".join(ch if ch.isalnum() else "-" for ch in part)[:40]
                    for part in parts[:3])
    return f"local-{slug}-{digest}"


def _money(value: Any) -> str:
    if value is None:
        return "—"
    try:
        number = float(value)
    except (TypeError, ValueError):
        return "—"
    text = f"{number:.4f}".rstrip("0").rstrip(".")
    return f"${text}" if text else "$0"


def _fee_text(price: Mapping[str, Any]) -> str:
    amount, currency, period = price.get("amount"), price.get("currency"), price.get("period")
    if amount is None:
        return "fee unpublished"
    try:
        number = float(amount)
    except (TypeError, ValueError):
        return "fee unpublished"
    per = f"/{period}" if period else ""
    if currency:
        return f"{currency} {number:g}{per}"
    return f"${number:g}{per}"


def rate_direction(old: Mapping[str, Any], new: Mapping[str, Any]) -> str:
    """Classify a rate change from base input+output totals, then any movement.

    Shared with the central feed generator so local and central news agree.
    """
    try:
        before = float(old["input"]) + float(old["output"])
        after = float(new["input"]) + float(new["output"])
    except (KeyError, TypeError, ValueError):
        before = after = 0.0
    if after < before:
        return "price_reduction"
    if after > before:
        return "price_increase"
    for key in ("input", "output", "cache_read", "cache_write"):
        old_value, new_value = old.get(key), new.get(key)
        if isinstance(old_value, (int, float)) and isinstance(new_value, (int, float)):
            if new_value < old_value:
                return "price_reduction"
    return "price_increase"


def _slim(entry: Mapping[str, Any]) -> dict[str, Any]:
    return {"input": entry.get("input"), "output": entry.get("output"),
            "cache_read": entry.get("cache_read"), "cache_write": entry.get("cache_write")}


def _tiers_changed(old: Mapping[str, Any], new: Mapping[str, Any]) -> bool:
    return json.dumps(old.get("tiers") or [], sort_keys=True) != json.dumps(new.get("tiers") or [], sort_keys=True)


def diff_snapshots(old: Mapping[str, Any], new: Mapping[str, Any], *,
                   observed_at: str, plans_doc: Optional[Mapping[str, Any]] = None
                   ) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Pure diff: catalogue rows and plan terms. Returns (items, meta)."""
    items: list[dict[str, Any]] = []
    removed_models: list[dict[str, str]] = []
    old_providers = old.get("providers") if isinstance(old.get("providers"), dict) else {}
    new_providers = new.get("providers") if isinstance(new.get("providers"), dict) else {}
    old_providers = old_providers or {}
    new_providers = new_providers or {}

    for provider in sorted(set(new_providers) - set(old_providers)):
        models = new_providers.get(provider) or {}
        if not isinstance(models, dict) or not models:
            continue
        items.append({
            "id": _stable_id("new-provider", str(provider), str(len(models))),
            "origin": "local", "category": "new_model",
            "provider": str(provider), "model": "",
            "summary": f"{provider} is newly listed with {len(models)} priced model(s).",
            "previous": None, "current": None,
            "observed_at": observed_at, "effective_at": "",
            "source_url": "", "confidence": "observed",
            "provenance": "Hermes models.dev cache",
            "conditions": "Catalogue listing only; not confirmed available on your accounts.",
        })
    for provider in sorted(set(old_providers) - set(new_providers)):
        for model in sorted((old_providers.get(provider) or {})):
            removed_models.append({"provider": str(provider), "model": str(model)})
    for provider in sorted(set(old_providers) & set(new_providers)):
        before, after = old_providers[provider] or {}, new_providers[provider] or {}
        if not isinstance(before, dict) or not isinstance(after, dict):
            continue
        for model in sorted(set(after) - set(before)):
            entry = after[model]
            if not isinstance(entry, dict):
                continue
            items.append({
                "id": _stable_id("new-model", str(provider), str(model)),
                "origin": "local", "category": "new_model",
                "provider": str(provider), "model": str(model),
                "summary": (f"{model} newly listed under {provider} at "
                            f"{_money(entry.get('input'))}/{_money(entry.get('output'))} per MTok in/out."),
                "previous": None, "current": _slim(entry),
                "observed_at": observed_at, "effective_at": "",
                "source_url": "", "confidence": "observed",
                "provenance": "Hermes models.dev cache",
                "conditions": "Catalogue listing only; not confirmed available on your accounts.",
            })
        for model in sorted(set(before) - set(after)):
            removed_models.append({"provider": str(provider), "model": str(model)})
        for model in sorted(set(before) & set(after)):
            old_entry, new_entry = before[model], after[model]
            if not isinstance(old_entry, dict) or not isinstance(new_entry, dict):
                continue
            if _slim(old_entry) == _slim(new_entry) and not _tiers_changed(old_entry, new_entry):
                continue
            category = rate_direction(old_entry, new_entry)
            old_sig = json.dumps({"r": _slim(old_entry), "t": old_entry.get("tiers") or []}, sort_keys=True)
            new_sig = json.dumps({"r": _slim(new_entry), "t": new_entry.get("tiers") or []}, sort_keys=True)
            conditions = "Tiered/context pricing changed; base rates compared." \
                if _tiers_changed(old_entry, new_entry) else ""
            verb = "reduced to" if category == "price_reduction" else "changed to"
            items.append({
                "id": _stable_id(category, str(provider), str(model) + old_sig + new_sig),
                "origin": "local", "category": category,
                "provider": str(provider), "model": str(model),
                "summary": (f"{model} ({provider}) {verb} "
                            f"{_money(new_entry.get('input'))}/{_money(new_entry.get('output'))} per MTok in/out."),
                "previous": _slim(old_entry), "current": _slim(new_entry),
                "has_tiers": bool(old_entry.get("tiers") or new_entry.get("tiers")),
                "observed_at": observed_at, "effective_at": "",
                "source_url": "", "confidence": "observed",
                "provenance": "Hermes models.dev cache",
                "conditions": conditions,
            })

    # Bundled plan catalogue: fees and allowance terms change with plugin updates.
    old_plans = old.get("plans") if isinstance(old.get("plans"), dict) else {}
    new_plans = new.get("plans") if isinstance(new.get("plans"), dict) else {}
    old_plans, new_plans = old_plans or {}, new_plans or {}
    urls = _source_urls(plans_doc or {})
    removed_plans = 0
    for plan_id in sorted(set(new_plans) - set(old_plans)):
        plan = new_plans[plan_id]
        if not isinstance(plan, dict):
            continue
        items.append({
            "id": _stable_id("new-plan", str(plan_id), json.dumps(plan.get("price"), sort_keys=True, default=str)),
            "origin": "local", "category": "subscription",
            "provider": str(plan.get("family") or ""), "model": "",
            "summary": f"New plan listed: {plan.get('name') or plan_id} ({_fee_text(plan.get('price') or {})}).",
            "previous": None, "current": None,
            "observed_at": observed_at, "effective_at": "",
            "source_url": urls.get(str(plan.get("source_id") or ""), ""),
            "confidence": "observed", "provenance": "bundled membership catalogue",
            "conditions": "",
        })
    for _plan_id in sorted(set(old_plans) - set(new_plans)):
        removed_plans += 1
    for plan_id in sorted(set(old_plans) & set(new_plans)):
        before, after = old_plans[plan_id], new_plans[plan_id]
        if not isinstance(before, dict) or not isinstance(after, dict):
            continue
        fee_before = json.dumps(before.get("price"), sort_keys=True, default=str)
        fee_after = json.dumps(after.get("price"), sort_keys=True, default=str)
        terms_changed = before.get("terms") != after.get("terms")
        if fee_before == fee_after and not terms_changed:
            continue
        bits = []
        if fee_before != fee_after:
            bits.append(f"fee {_fee_text(before.get('price') or {})} → {_fee_text(after.get('price') or {})}")
        if terms_changed:
            bits.append("allowances/terms changed")
        items.append({
            "id": _stable_id("plan-change", str(plan_id), fee_before, fee_after,
                             str(before.get("terms")), str(after.get("terms"))),
            "origin": "local", "category": "subscription",
            "provider": str(after.get("family") or before.get("family") or ""), "model": "",
            "summary": f"{after.get('name') or plan_id}: {'; '.join(bits)}.",
            "previous": None, "current": None,
            "observed_at": observed_at, "effective_at": "",
            "source_url": urls.get(str(after.get("source_id") or before.get("source_id") or ""), ""),
            "confidence": "observed", "provenance": "bundled membership catalogue",
            "conditions": "",
        })

    items.sort(key=lambda item: (item["observed_at"], item["provider"], item["model"], item["category"]))
    meta = {"removed_models": removed_models[:100], "removed_model_count": len(removed_models),
            "removed_plan_count": removed_plans}
    return items, meta


def _is_cache_source(source: Any) -> bool:
    return str(source or "").startswith("models.dev cache")


def load_items(path: Optional[Path | str] = None) -> dict[str, Any]:
    target = Path(path) if path else items_path()
    raw, error = _read_json(target)
    if raw is None:
        return {"items": [], "loaded": False, "error": error}
    items = raw.get("items")
    if not isinstance(items, list):
        return {"items": [], "loaded": False, "error": f"unreadable: {target.name}"}
    kept = [item for item in items if isinstance(item, dict) and item.get("id")]
    return {"items": kept, "loaded": True, "error": ""}


def refresh_local(*, data_dir: Optional[Path | str] = None,
                  catalogue: Optional[Catalogue] = None,
                  plans_doc: Optional[Mapping[str, Any]] = None,
                  now: Optional[float] = None) -> dict[str, Any]:
    """Snapshot the catalogues and persist newly detected local news.

    The first snapshot only establishes the baseline. Never touches the
    network; safe to call on every News page view.
    """
    from .pricing import load_catalogue

    snapshot_target = snapshot_path(data_dir)
    items_target = items_path(data_dir)
    book = catalogue if catalogue is not None else load_catalogue()
    plans = dict(plans_doc) if plans_doc is not None else load_plans_doc()
    observed_at = _now_iso(now)
    fresh = snapshot_catalogue(book, plans)
    fresh["captured_at"] = observed_at

    ordered = sorted([snapshot_target, items_target], key=str)
    with ExitStack() as stack:
        for target in ordered:
            stack.enter_context(_locked(target))
        previous, _ = _read_json(snapshot_target)
        stored = load_items(items_target)
        if previous is None:
            _atomic_write_json(snapshot_target, fresh)
            if not stored["loaded"]:
                _atomic_write_json(items_target, {"version": NEWS_VERSION, "items": []})
            return {"items": stored["items"], "baseline": True, "snapshot_at": observed_at,
                    "catalogue": {"source": book.source, "as_of": book.as_of},
                    "removed_models": [], "removed_model_count": 0, "removed_plan_count": 0}
        prev_source = previous.get("catalogue_source")
        if prev_source != fresh["catalogue_source"]:
            # Catalogue rows are comparable only within one source. A fallback
            # load (bundled snapshot, or nothing usable) keeps the last good
            # rows instead of reporting the source gap as news; a return to
            # the cache re-baselines quietly. Plan terms always compare.
            if not _is_cache_source(fresh["catalogue_source"]) and previous.get("providers"):
                fresh["providers"] = previous.get("providers") or {}
                fresh["catalogue_source"] = prev_source
                fresh["catalogue_as_of"] = previous.get("catalogue_as_of", "")
            compare_old: Mapping[str, Any] = {**previous, "providers": fresh["providers"]}
        else:
            compare_old = previous
        found, meta = diff_snapshots(compare_old, fresh, observed_at=observed_at, plans_doc=plans)
        known = {str(item.get("id")) for item in stored["items"] if isinstance(item, dict)}
        merged = list(stored["items"])
        for item in found:
            if str(item.get("id")) not in known:
                known.add(str(item.get("id")))
                merged.append(item)
        merged.sort(key=lambda item: str(item.get("observed_at") or ""), reverse=True)
        merged = merged[:MAX_STORED_ITEMS]
        _atomic_write_json(items_target, {"version": NEWS_VERSION, "items": merged})
        _atomic_write_json(snapshot_target, fresh)
        return {"items": merged, "baseline": False, "snapshot_at": observed_at,
                "catalogue": {"source": book.source, "as_of": book.as_of}, **meta}


# ------------------------------------------------------------------ central feed

def _valid_rate_block(value: Any) -> Optional[dict[str, Any]]:
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


def _valid_text(value: Any, limit: int) -> str:
    if not isinstance(value, str):
        return ""
    text = value.strip()
    return text[:limit]


def validate_feed(raw: Any) -> tuple[Optional[dict[str, Any]], list[str]]:
    """Strict schema check for a fetched central feed. Drops bad items."""
    errors: list[str] = []
    if not isinstance(raw, dict):
        return None, ["feed is not an object"]
    if raw.get("version") != 1:
        return None, ["unsupported feed version"]
    generated_at = _valid_text(raw.get("generated_at"), 64)
    entries = raw.get("items")
    if not isinstance(entries, list):
        return None, ["feed items entry is not a list"]
    seen: set[str] = set()
    items: list[dict[str, Any]] = []
    for position, entry in enumerate(entries):
        where = f"item {position}"
        if not isinstance(entry, dict):
            errors.append(f"{where}: not an object")
            continue
        item_id = _valid_text(entry.get("id"), 128)
        if not item_id or item_id in seen:
            errors.append(f"{where}: missing or duplicate id")
            continue
        category = entry.get("category")
        if category not in CATEGORIES:
            errors.append(f"{where}: unknown category")
            continue
        provider = _valid_text(entry.get("provider"), 128)
        summary = _valid_text(entry.get("summary"), 500)
        observed_at = _valid_text(entry.get("observed_at"), 64)
        source_url = _valid_text(entry.get("source_url"), 500)
        if not provider or not summary or not observed_at or not source_url:
            errors.append(f"{where}: missing provider, summary, observed_at or source_url")
            continue
        if not (source_url.startswith("https://") or source_url.startswith("http://")):
            errors.append(f"{where}: source_url is not http(s)")
            continue
        previous = entry.get("previous")
        current = entry.get("current")
        if previous is not None and _valid_rate_block(previous) is None:
            errors.append(f"{where}: invalid previous rates")
            continue
        if current is not None and _valid_rate_block(current) is None:
            errors.append(f"{where}: invalid current rates")
            continue
        if category in ("price_reduction", "price_increase") and (previous is None or current is None):
            errors.append(f"{where}: price changes need previous and current rates")
            continue
        confidence = entry.get("confidence") or "curated"
        if confidence not in CONFIDENCES:
            errors.append(f"{where}: unknown confidence")
            continue
        seen.add(item_id)
        items.append({
            "id": item_id, "origin": "central", "category": category,
            "provider": provider, "model": _valid_text(entry.get("model"), 256),
            "summary": summary,
            "previous": _valid_rate_block(previous) if previous is not None else None,
            "current": _valid_rate_block(current) if current is not None else None,
            "has_tiers": entry.get("has_tiers") is True,
            "observed_at": observed_at,
            "effective_at": _valid_text(entry.get("effective_at"), 64),
            "source_url": source_url, "confidence": confidence,
            "provenance": _valid_text(entry.get("provenance"), 256) or "Spend Sense central feed",
            "conditions": _valid_text(entry.get("conditions"), 500),
        })
    items.sort(key=lambda item: (item["observed_at"], item["provider"], item["model"]), reverse=True)
    if len(items) > FEED_MAX_ITEMS:
        del items[FEED_MAX_ITEMS:]
        errors.append(f"feed truncated to {FEED_MAX_ITEMS} items")
    return {"version": 1, "generated_at": generated_at, "items": items}, errors


def load_cache(path: Optional[Path | str] = None) -> dict[str, Any]:
    target = Path(path) if path else cache_path()
    raw, error = _read_json(target)
    if raw is None:
        return {"feed": None, "fetched_at": "", "state": "never", "error": error}
    feed = raw.get("feed")
    if feed is not None and not isinstance(feed, dict):
        return {"feed": None, "fetched_at": "", "state": "never",
                "error": f"unreadable: {target.name}"}
    return {"feed": feed, "fetched_at": str(raw.get("fetched_at") or ""),
            "state": str(raw.get("state") or "never"), "error": str(raw.get("error") or "")}


def fetch_central(*, data_dir: Optional[Path | str] = None,
                  settings: Optional[Mapping[str, Any]] = None,
                  now: Optional[float] = None,
                  force: bool = False) -> dict[str, Any]:
    """Fetch the public feed when opted in, honouring the cache interval.

    Sends an unauthenticated GET with static headers only: no user IDs,
    accounts, credentials, model lists, usage or tracking tokens. Any
    failure keeps the previous cache and reports the error; local news is
    unaffected. On a remote Hermes host, that host makes the request.
    """
    import time as _time

    moment = now if now is not None else _time.time()
    enabled = (settings or load_settings(_resolve(SETTINGS_NAME, data_dir))).get("live_updates") is True
    target = cache_path(data_dir)
    cached = load_cache(target)
    if not enabled:
        return {"feed": cached["feed"], "fetched_at": cached["fetched_at"],
                "state": "disabled", "error": ""}
    if not force and cached["feed"] and cached["fetched_at"]:
        try:
            age = moment - datetime.fromisoformat(cached["fetched_at"]).timestamp()
        except (TypeError, ValueError):
            age = FEED_CACHE_SECONDS + 1
        if 0 <= age < FEED_CACHE_SECONDS:
            return {"feed": cached["feed"], "fetched_at": cached["fetched_at"],
                    "state": "ok", "error": ""}
    request = Request(FEED_URL, headers={"Accept": "application/json",
                                         "User-Agent": "SpendSense-News"})
    try:
        with urlopen(request, timeout=FEED_TIMEOUT) as response:  # noqa: S310 - fixed https host
            body = response.read(FEED_MAX_BYTES + 1)
        if len(body) > FEED_MAX_BYTES:
            raise ValueError("feed exceeds the size cap")
        feed, problems = validate_feed(json.loads(body.decode("utf-8-sig")))
        if feed is None:
            raise ValueError("; ".join(problems) or "invalid feed")
        payload = {"version": NEWS_VERSION, "fetched_at": _now_iso(moment),
                   "state": "ok", "error": "; ".join(problems), "feed": feed}
    except Exception as exc:  # noqa: BLE001 - any fetch failure keeps local news working
        payload = {"version": NEWS_VERSION, "fetched_at": cached["fetched_at"],
                   "state": "stale" if cached["feed"] else "error",
                   "error": f"central feed unavailable ({type(exc).__name__})",
                   "feed": cached["feed"]}
    with _locked(target):
        _atomic_write_json(target, payload)
    return {"feed": payload["feed"], "fetched_at": payload["fetched_at"],
            "state": payload["state"], "error": payload["error"]}


# ------------------------------------------------------------------ evidence

def canonical_route_provider(route: str) -> str:
    return PROVIDER_ALIASES.get(str(route or "").strip().lower(), str(route or "").strip().lower())


def usage_summary(event_db: Optional[Path | str] = None, *, days: int = IMPACT_DAYS,
                  now: Optional[float] = None) -> dict[tuple[str, str], dict[str, int]]:
    """Read-only token sums per (recorded route, model) over a trailing window."""
    import time as _time

    moment = now if now is not None else _time.time()
    since = moment - max(1, days) * 86_400
    try:
        conn = usage_store.connect_reader(event_db)
    except Exception:  # noqa: BLE001 - unreadable usage means no personalisation, not a failure
        return {}
    if conn is None:
        return {}
    try:
        try:
            rows = conn.execute(
                "SELECT provider, model, "
                "COALESCE(SUM(input_tokens),0), COALESCE(SUM(output_tokens),0), "
                "COALESCE(SUM(cache_read_tokens),0), COALESCE(SUM(cache_write_tokens),0), "
                "COUNT(*) FROM calls WHERE ts >= ? AND ts < ? AND outcome = 'ok' "
                "GROUP BY provider, model",
                (since, moment),
            ).fetchall()
        except Exception:  # noqa: BLE001 - a sparse store has no usable rows
            return {}
    finally:
        conn.close()
    out: dict[tuple[str, str], dict[str, int]] = {}
    for provider, model, prompt, completion, read, write, calls in rows:
        out[(str(provider or ""), str(model or ""))] = {
            "input": int(prompt or 0), "output": int(completion or 0),
            "cache_read": int(read or 0), "cache_write": int(write or 0),
            "calls": int(calls or 0),
        }
    return out


def configured_tokens(home: Optional[Path | str] = None) -> set[str]:
    """Provider identity tokens from Hermes credential slots (presence only)."""
    tokens: set[str] = set()
    try:
        slots = discovery.credential_slots(home)
    except Exception:  # noqa: BLE001 - discovery failure means no ranking signal
        return tokens
    for family, block in slots.items():
        tokens.add(str(family).lower())
        tokens.add(discovery.canonical_provider(family))
        tokens.add(canonical_route_provider(family))
        routes = block.get("route_slugs") if isinstance(block, dict) else None
        for slug in routes or []:
            tokens.add(str(slug).lower())
            tokens.add(canonical_route_provider(str(slug)))
    return {token for token in tokens if token}


def _models_match(recorded: str, item_model: str) -> bool:
    if not recorded or not item_model:
        return False
    if recorded == item_model:
        return True
    return recorded.split("/")[-1] == item_model.split("/")[-1]


def _usage_for_item(item: Mapping[str, Any],
                    usage: Mapping[tuple[str, str], dict[str, int]]) -> dict[str, int]:
    provider = str(item.get("provider") or "").lower()
    model = str(item.get("model") or "")
    total = {"input": 0, "output": 0, "cache_read": 0, "cache_write": 0, "calls": 0}
    for (route, recorded_model), buckets in usage.items():
        if canonical_route_provider(route) != provider:
            continue
        if model and not _models_match(recorded_model, model):
            continue
        for key in total:
            total[key] += buckets.get(key, 0)
    return total


def rank_items(items: list[dict[str, Any]], *,
               usage: Optional[Mapping[tuple[str, str], dict[str, int]]] = None,
               tokens: Optional[set[str]] = None) -> list[dict[str, Any]]:
    """Annotate news with For You evidence. Never promises account access."""
    usage = usage if usage is not None else {}
    tokens = tokens if tokens is not None else set()
    used_providers = {canonical_route_provider(route) for route, _ in usage}
    used_models = {model for _, model in usage} | {model.split("/")[-1] for _, model in usage}
    ranked: list[dict[str, Any]] = []
    for item in items:
        provider = str(item.get("provider") or "").lower()
        model = str(item.get("model") or "")
        related = sorted({route for (route, recorded) in usage
                          if canonical_route_provider(route) == provider
                          and (not model or _models_match(recorded, model))})[:5]
        configured = bool(provider) and provider in tokens
        for_you = bool(provider) and (
            provider in used_providers or provider in tokens
            or (model and (model in used_models or model.split("/")[-1] in used_models)))
        ranked.append({**item, "for_you": for_you, "configured_provider": configured,
                       "related_routes": related})
    return ranked


# ------------------------------------------------------------------ impact

def _cost(tokens: Mapping[str, int], rates: Mapping[str, Any],
          other_rates: Mapping[str, Any]) -> tuple[Optional[float], bool]:
    """Price the token buckets priced on BOTH sides of a comparison.

    Returns (usd, complete). A used cache bucket with no rate on either side
    is excluded from both totals and marks the comparison incomplete, so the
    delta never compares different buckets.
    """
    try:
        total = (tokens.get("input", 0) * float(rates["input"])
                 + tokens.get("output", 0) * float(rates["output"])) / 1_000_000
    except (KeyError, TypeError, ValueError):
        return None, False
    complete = True
    for key in ("cache_read", "cache_write"):
        count = tokens.get(key, 0)
        if not count:
            continue
        rate, other = rates.get(key), other_rates.get(key)
        if rate is None or other is None:
            complete = False
            continue
        try:
            total += count * float(rate) / 1_000_000
        except (TypeError, ValueError):
            return None, False
    return total, complete


def estimate_impact(item: Mapping[str, Any], tokens: Mapping[str, int]) -> dict[str, Any]:
    """API-equivalent cost difference over recent usage. Local only.

    Values compare published rates against the user's own token buckets;
    they are NOT savings on fixed subscriptions.
    """
    previous, current = item.get("previous"), item.get("current")
    if sum(tokens.get(key, 0) for key in ("input", "output", "cache_read", "cache_write")) <= 0:
        return {"basis": "unavailable", "reason": "no recent usage of this model"}
    if not isinstance(previous, Mapping) or not isinstance(current, Mapping):
        return {"basis": "unavailable", "reason": "rate comparison unavailable"}
    old_usd, old_complete = _cost(tokens, previous, current)
    new_usd, new_complete = _cost(tokens, current, previous)
    if old_usd is None or new_usd is None:
        return {"basis": "unavailable", "reason": "rate comparison unavailable"}
    caveats = []
    if not (old_complete and new_complete):
        caveats.append("cache rates unavailable for comparison; cache tokens excluded")
    if item.get("has_tiers") is True:
        caveats.append("tiered pricing applies; base rates compared")
    return {
        "basis": "full" if not caveats else "partial",
        "reason": "; ".join(caveats),
        "window_days": IMPACT_DAYS,
        "tokens": {key: int(tokens.get(key, 0)) for key in ("input", "output", "cache_read", "cache_write")},
        "calls": int(tokens.get("calls", 0)),
        "old_usd": old_usd, "new_usd": new_usd, "delta_usd": new_usd - old_usd,
    }


def compute_impacts(items: list[Mapping[str, Any]],
                    usage: Mapping[tuple[str, str], dict[str, int]]) -> dict[str, dict[str, Any]]:
    impacts: dict[str, dict[str, Any]] = {}
    for item in items:
        if item.get("category") not in ("price_reduction", "price_increase"):
            continue
        if not isinstance(item.get("previous"), Mapping) or not isinstance(item.get("current"), Mapping):
            continue
        tokens = _usage_for_item(item, usage)
        if sum(tokens.values()) <= 0:
            continue
        impacts[str(item.get("id"))] = estimate_impact(item, tokens)
    return impacts


# ------------------------------------------------------------------ payloads

def news_payload(*, data_dir: Optional[Path | str] = None,
                 event_db: Optional[Path | str] = None,
                 home: Optional[Path | str] = None,
                 now: Optional[float] = None) -> dict[str, Any]:
    """Read-only combined view: stored local news plus the cached central feed."""
    stored = load_items(items_path(data_dir))
    settings = load_settings(settings_path(data_dir))
    cached = load_cache(cache_path(data_dir))
    snapshot, _ = _read_json(snapshot_path(data_dir))
    try:
        slots = discovery.credential_slots(home)
        providers_configured = sorted(slots)
    except Exception:  # noqa: BLE001 - ranking degrades, the news stays
        providers_configured = []
    recent = usage_summary(event_db, days=IMPACT_DAYS, now=now)
    evidence = usage_summary(event_db, days=EVIDENCE_DAYS, now=now)
    local_items = [item for item in stored["items"] if isinstance(item, dict)]
    central_items: list[dict[str, Any]] = []
    # Disabled means local-only: a retained cache speeds re-enabling but is
    # never surfaced, so the off state shows exactly what it claims.
    if settings["live_updates"] and isinstance(cached["feed"], dict) \
            and isinstance(cached["feed"].get("items"), list):
        central_items = [item for item in cached["feed"]["items"] if isinstance(item, dict)]
    combined = rank_items([*local_items, *central_items], usage=evidence,
                          tokens=configured_tokens(home))
    combined.sort(key=lambda item: (str(item.get("observed_at") or ""), str(item.get("id") or "")),
                  reverse=True)
    return {
        "ok": True,
        "settings": {"live_updates": settings["live_updates"]},
        "catalogue": {"source": (snapshot or {}).get("catalogue_source", ""),
                      "as_of": (snapshot or {}).get("catalogue_as_of", ""),
                      "snapshot_at": (snapshot or {}).get("captured_at", "")},
        "local": {"items": [item for item in combined if item.get("origin") == "local"],
                  "baseline": snapshot is None,
                  "store_error": stored["error"]},
        "central": {"state": cached["state"] if settings["live_updates"]
                    else ("disabled" if not cached["feed"] else "disabled_cached"),
                    "items": [item for item in combined if item.get("origin") == "central"],
                    "fetched_at": cached["fetched_at"], "error": cached["error"]},
        "for_you_count": sum(1 for item in combined if item.get("for_you")),
        "providers_configured": providers_configured,
        "impacts": compute_impacts(combined, recent),
        "impact_window_days": IMPACT_DAYS,
    }


def refresh_payload(*, data_dir: Optional[Path | str] = None,
                    event_db: Optional[Path | str] = None,
                    home: Optional[Path | str] = None,
                    catalogue: Optional[Catalogue] = None,
                    plans_doc: Optional[Mapping[str, Any]] = None,
                    now: Optional[float] = None,
                    fetch: bool = True) -> dict[str, Any]:
    """User-triggered refresh: local snapshot diff, then the central fetch if due."""
    local = refresh_local(data_dir=data_dir, catalogue=catalogue,
                          plans_doc=plans_doc, now=now)
    if fetch:
        fetch_central(data_dir=data_dir, now=now)
    payload = news_payload(data_dir=data_dir, event_db=event_db, home=home, now=now)
    payload["local"]["baseline"] = local["baseline"]
    payload["local"]["snapshot_at"] = local["snapshot_at"]
    payload["local"]["removed_models"] = local.get("removed_models", [])
    payload["local"]["removed_model_count"] = local.get("removed_model_count", 0)
    payload["local"]["removed_plan_count"] = local.get("removed_plan_count", 0)
    return payload
