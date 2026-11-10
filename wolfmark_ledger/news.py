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
from . import membership as mem
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


def _cache_filename(source: Any) -> str:
    """Filename embedded in a "models.dev cache (<file>)" source string."""
    text = str(source or "")
    if not _is_cache_source(text):
        return ""
    start, end = text.find("("), text.rfind(")")
    if start == -1 or end <= start:
        return ""
    return text[start + 1:end].strip()


def _raw_tiers(raw_row: Mapping[str, Any]) -> list[dict[str, Any]]:
    """Copy a raw model row's tier blocks exactly, or [] when it has none.

    Raw tiers keep ``type``/``size`` next to the rates; pricing's Tier drops
    the type, so this is the only place the tariff kind survives. The legacy
    ``context_over_200k`` key becomes one row, mirroring the pricing reader.
    """
    cost = raw_row.get("cost")
    if cost is None and any(key in raw_row for key in ("input", "output")):
        cost = raw_row
    if not isinstance(cost, dict):
        return []
    rows: list[dict[str, Any]] = []
    for tier in cost.get("tiers") or []:
        if not isinstance(tier, dict):
            continue
        nested = tier.get("tier") if isinstance(tier.get("tier"), dict) else {}
        rows.append({
            "type": nested["type"] if "type" in nested else tier.get("type"),
            "size": nested["size"] if "size" in nested else tier.get("size"),
            "input": tier.get("input"),
            "output": tier.get("output"),
            "cache_read": tier.get("cache_read"),
            "cache_write": tier.get("cache_write"),
        })
    over = cost.get("context_over_200k")
    if not rows and isinstance(over, dict):
        rows.append({"type": "context_over_200k", "size": None,
                     "input": over.get("input"), "output": over.get("output"),
                     "cache_read": over.get("cache_read"),
                     "cache_write": over.get("cache_write")})
    return rows


def capture_raw_rows(book: Catalogue, *, raw_doc: Any = None,
                     raw_path: Optional[Path | str] = None,
                     ) -> Optional[dict[tuple[str, str], dict[str, Any]]]:
    """Read-only raw models.dev rows for the catalogue just snapshotted.

    Returns ``{(provider, model): {"name", "tiers_raw"}}`` for the rows in
    ``book.providers``, reading the same source file the book was built from
    at most once. Any unreadable, unparseable or mismatched source returns
    None: raw detail is then unknown and never guessed.

    Tier detail is only served when it is numerically coherent with the book:
    on a file read, every raw row must re-normalise (via pricing's own
    parser) to the very Rate the book holds, and the file stat must be
    unchanged across the read; otherwise every row is returned with
    ``tiers_raw`` None (name kept) so tier detail reads as unknown. Rows
    injected via ``raw_doc`` (tests) bypass the coherence check so a
    deliberately divergent injected source keeps working. Residual: a
    replacement whose base and normalised tier numbers are all identical but
    whose raw tier type/name differs cannot be detected — numeric coherence
    and a stable capture are checked, source version identity is not proven.
    """
    from .pricing import _rate_from_cost

    if not _is_cache_source(book.source):
        return None
    check_coherence = False
    if raw_doc is not None:
        doc = raw_doc
        captured_stably = True
    else:
        target = Path(raw_path) if raw_path else None
        if target is None:
            filename = _cache_filename(book.source)
            if not filename:
                return None
            from .pricing import _default_cache_path
            candidate = Path(os.environ.get("HERMES_MODELS_DEV_CACHE")
                             or _default_cache_path())
            if candidate.name != filename:
                return None
            target = candidate
        try:
            before = target.stat()
        except OSError:
            return None
        try:
            doc = json.loads(target.read_text(encoding="utf-8-sig"))
        except (OSError, ValueError):
            return None
        try:
            after = target.stat()
        except OSError:
            return None
        captured_stably = (before.st_mtime_ns, before.st_size, before.st_ino) \
            == (after.st_mtime_ns, after.st_size, after.st_ino)
        check_coherence = True
    if not isinstance(doc, dict):
        return None
    data = doc.get("data") if isinstance(doc.get("data"), dict) else doc
    if not isinstance(data, dict):
        return None
    rows: dict[tuple[str, str], dict[str, Any]] = {}
    consistent = captured_stably
    for provider, models in (book.providers or {}).items():
        entry = data.get(str(provider))
        model_rows = entry.get("models") if isinstance(entry, dict) else None
        if not isinstance(model_rows, dict):
            continue
        for model in (models or {}):
            raw_row = model_rows.get(str(model))
            if not isinstance(raw_row, dict):
                continue
            name = raw_row.get("name")
            if check_coherence:
                try:
                    # Mirror pricing._parse_catalogue's cost-block selection.
                    cost = raw_row.get("cost")
                    if cost is None and any(key in raw_row for key in ("input", "output")):
                        cost = raw_row
                    normalised = _rate_from_cost(cost)
                except Exception:
                    consistent = False
                    normalised = None
                if normalised is None or normalised != models.get(model):
                    consistent = False
            rows[(str(provider), str(model))] = {
                "name": name if isinstance(name, str) else "",
                "tiers_raw": _raw_tiers(raw_row),
            }
    if not consistent:
        # The raw detail cannot be tied to the book it will be compared
        # against; downgrade to unknown instead of guessing.
        return {key: {"name": row["name"], "tiers_raw": None}
                for key, row in rows.items()}
    return rows


def _official_rows(path: Optional[Path | str] = None) -> dict[tuple[str, str], dict[str, Any]]:
    """Editorial verification notes, read-only, keyed by exact (provider, model)."""
    target = Path(path) if path else \
        Path(__file__).resolve().parent.parent / "catalogue" / "official-verified.json"
    try:
        raw = json.loads(target.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        return {}
    if not isinstance(raw, dict):
        return {}
    out: dict[tuple[str, str], dict[str, Any]] = {}
    for row in raw.get("verified") or []:
        if not isinstance(row, dict):
            continue
        provider = str(row.get("provider") or "").strip().lower()
        model = str(row.get("model") or "").strip()
        if not provider or not model:
            continue
        windows: list[dict[str, Any]] = []
        for window in row.get("windows") or []:
            if not isinstance(window, dict) or "start_minute" not in window \
                    or "end_minute" not in window:
                continue
            days = window.get("days")
            windows.append({
                "days": list(days) if isinstance(days, list) else None,
                "start_minute": window.get("start_minute"),
                "end_minute": window.get("end_minute"),
                "input": window.get("input"),
                "output": window.get("output"),
                "cache_read": window.get("cache_read"),
                "cache_write": window.get("cache_write"),
            })
        out[(provider, model)] = {
            "verified_at": str(row.get("verified_at") or ""),
            "source_note": str(row.get("source_url") or ""),
            "windows": windows,
        }
    return out


def _official_for(official: Optional[Mapping[tuple[str, str], Mapping[str, Any]]],
                  provider: str, model: str) -> Optional[dict[str, Any]]:
    row = (official or {}).get((str(provider or "").strip().lower(), str(model or "").strip()))
    if not isinstance(row, Mapping):
        return None
    return {"verified_at": row.get("verified_at"), "source_note": row.get("source_note"),
            "windows": [dict(window) for window in row.get("windows") or []]}


def snapshot_catalogue(book: Catalogue, plans_doc: Optional[Mapping[str, Any]],
                       raw_rows: Optional[Mapping[tuple[str, str], Mapping[str, Any]]] = None,
                       ) -> dict[str, Any]:
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
            raw = (raw_rows or {}).get((str(provider), str(model)))
            name = raw.get("name") if isinstance(raw, Mapping) else None
            tiers_raw = raw.get("tiers_raw") if isinstance(raw, Mapping) else None
            rows[model]["name"] = name if isinstance(name, str) else ""
            rows[model]["tiers_raw"] = tiers_raw if isinstance(tiers_raw, list) else None
        if rows:
            providers[str(provider)] = rows
    return {
        "version": NEWS_VERSION,
        "raw_tiers_v": 1,
        "catalogue_source": book.source,
        "catalogue_as_of": book.as_of,
        "providers": providers,
        "plans": _plans_table(plans_doc or {}),
        "plans_normalised": True,
    }


def _migrate_snapshot_plans(old_plans: Mapping[str, Any]) -> dict[str, Any]:
    """Normalise pre-shared-catalogue snapshot plan rows for comparison.

    Snapshots written before the shared active catalogue stored raw plan
    terms; the loader now adds defaults (window amount/currency/detail,
    float amounts, upper-case currencies), so a raw-vs-normalised diff
    reports the representation change as news. Migrating the stored side
    through the same normalisation drops that noise while genuine fee
    and entitlement changes still compare unequal. Idempotent:
    already-normalised rows migrate to themselves. Rows that fail to
    parse or validate are kept as-is so a corrupt snapshot can never
    break a refresh.
    """
    migrated: dict[str, Any] = {}
    for plan_id, row in old_plans.items():
        if not isinstance(row, dict):
            migrated[plan_id] = row
            continue
        try:
            terms = json.loads(row.get("terms") or "null")
            if not isinstance(terms, dict):
                raise ValueError("stored terms are not an object")
            price = mem.normalise_price(row.get("price"), str(plan_id))
            entitlements = mem.normalise_entitlements(terms)
        except (ValueError, TypeError, mem.CatalogueError):
            migrated[plan_id] = row
            continue
        migrated[plan_id] = {
            **row,
            "price": price,
            "terms": json.dumps(entitlements, sort_keys=True, default=str),
        }
    return migrated


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


def _raw_tiers_changed(old: Mapping[str, Any], new: Mapping[str, Any]) -> bool:
    """Raw tier difference; only countable when BOTH sides were captured."""
    old_raw, new_raw = old.get("tiers_raw"), new.get("tiers_raw")
    if not isinstance(old_raw, list) or not isinstance(new_raw, list):
        return False
    return old_raw != new_raw


def _rate_change_code(old: Mapping[str, Any], new: Mapping[str, Any],
                      tiers_changed: bool) -> str:
    """Honest per-field classification of a local rate change.

    Unlike ``rate_direction`` this looks at every base field, so a tiers-only
    change is never presented as an increase. A base-field presence change
    (None↔number) moves no comparable number pair, so with tiers unchanged it
    is reported as ``news_rate_changed`` rather than misattributed to tiers.
    """
    fell = rose = False
    for key in ("input", "output", "cache_read", "cache_write"):
        old_value, new_value = old.get(key), new.get(key)
        if not isinstance(old_value, (int, float)) or not isinstance(new_value, (int, float)):
            continue
        if new_value < old_value:
            fell = True
        elif new_value > old_value:
            rose = True
    if fell and rose:
        return "news_rate_mixed"
    if fell:
        return "news_rate_down"
    if rose:
        return "news_rate_up"
    if tiers_changed:
        return "news_rate_tiers_only"
    return "news_rate_changed"


def diff_snapshots(old: Mapping[str, Any], new: Mapping[str, Any], *,
                   observed_at: str, plans_doc: Optional[Mapping[str, Any]] = None,
                   official: Optional[Mapping[tuple[str, str], Mapping[str, Any]]] = None,
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
            "summary_code": "news_sum_new_provider",
            "summary_params": {"provider": str(provider), "count": len(models)},
            "previous": None, "current": None,
            "observed_at": observed_at, "effective_at": "",
            "source_url": "", "confidence": "observed",
            "provenance": "Hermes models.dev cache",
            "conditions": "Catalogue listing only; not confirmed available on your accounts.",
            "conditions_code": "news_cond_listing_accounts",
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
            item = {
                "id": _stable_id("new-model", str(provider), str(model)),
                "origin": "local", "category": "new_model",
                "provider": str(provider), "model": str(model),
                "summary": (f"{model} newly listed under {provider} at "
                            f"{_money(entry.get('input'))}/{_money(entry.get('output'))} per MTok in/out."),
                "summary_code": "news_sum_new_model",
                "summary_params": {"model": str(model), "provider": str(provider),
                                   "input": _money(entry.get('input')),
                                   "output": _money(entry.get('output'))},
                "previous": None, "current": _slim(entry),
                "model_name": entry.get("name") if isinstance(entry.get("name"), str) else "",
                "tiers_detail": "known" if isinstance(entry.get("tiers_raw"), list) else "unknown",
                "tiers_after": entry.get("tiers_raw") if isinstance(entry.get("tiers_raw"), list) else None,
                "observed_at": observed_at, "effective_at": "",
                "source_url": "", "confidence": "observed",
                "provenance": "Hermes models.dev cache",
                "conditions": "Catalogue listing only; not confirmed available on your accounts.",
                "conditions_code": "news_cond_listing_accounts",
            }
            verified = _official_for(official, str(provider), str(model))
            if verified is not None:
                item["official"] = verified
            items.append(item)
        for model in sorted(set(before) - set(after)):
            removed_models.append({"provider": str(provider), "model": str(model)})
        for model in sorted(set(before) & set(after)):
            old_entry, new_entry = before[model], after[model]
            if not isinstance(old_entry, dict) or not isinstance(new_entry, dict):
                continue
            tiers_changed = _tiers_changed(old_entry, new_entry) \
                or _raw_tiers_changed(old_entry, new_entry)
            if _slim(old_entry) == _slim(new_entry) and not tiers_changed:
                continue
            category = rate_direction(old_entry, new_entry)
            old_sig = json.dumps({"r": _slim(old_entry), "t": old_entry.get("tiers") or []}, sort_keys=True)
            new_sig = json.dumps({"r": _slim(new_entry), "t": new_entry.get("tiers") or []}, sort_keys=True)
            conditions = "Tiered/context pricing changed; base rates compared." \
                if tiers_changed else ""
            old_raw = old_entry.get("tiers_raw") if isinstance(old_entry.get("tiers_raw"), list) else None
            new_raw = new_entry.get("tiers_raw") if isinstance(new_entry.get("tiers_raw"), list) else None
            # A raw tier change (e.g. the tariff kind) is a real transition
            # even when the normalised tiers are identical; without raw
            # material in the id the reverse transition collapses onto the
            # same id and is dropped as an already-known observation. Raw
            # material joins the id only for such raw-only transitions: when
            # the normalised tiers or base rates moved, the legacy signature
            # already distinguishes the transition and existing ids stay.
            raw_only = _raw_tiers_changed(old_entry, new_entry) \
                and _slim(old_entry) == _slim(new_entry) \
                and not _tiers_changed(old_entry, new_entry)
            raw_material = json.dumps([old_raw, new_raw], sort_keys=True) \
                if raw_only else ""
            model_name = new_entry.get("name")
            verb = "reduced to" if category == "price_reduction" else "changed to"
            item = {
                "id": _stable_id(category, str(provider),
                                 str(model) + old_sig + new_sig + raw_material),
                "origin": "local", "category": category,
                "provider": str(provider), "model": str(model),
                "summary": (f"{model} ({provider}) {verb} "
                            f"{_money(new_entry.get('input'))}/{_money(new_entry.get('output'))} per MTok in/out."),
                "summary_code": "news_sum_price_change",
                "summary_params": {"model": str(model), "provider": str(provider),
                                   "input": _money(new_entry.get('input')),
                                   "output": _money(new_entry.get('output'))},
                "previous": _slim(old_entry), "current": _slim(new_entry),
                "has_tiers": bool(old_entry.get("tiers") or new_entry.get("tiers")),
                "model_name": model_name if isinstance(model_name, str) else "",
                "tiers_detail": "known" if old_raw is not None and new_raw is not None else "unknown",
                "tiers_before": old_raw,
                "tiers_after": new_raw,
                "rate_change_code": _rate_change_code(old_entry, new_entry, tiers_changed),
                "observed_at": observed_at, "effective_at": "",
                "source_url": "", "confidence": "observed",
                "provenance": "Hermes models.dev cache",
                "conditions": conditions,
                "conditions_code": "news_cond_tiers_changed" if conditions else "",
            }
            verified = _official_for(official, str(provider), str(model))
            if verified is not None:
                item["official"] = verified
            items.append(item)

    # Plan catalogue: fees and allowance terms change with catalogue updates.
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
            "summary_code": "news_sum_new_plan",
            "summary_params": {"plan": str(plan.get('name') or plan_id),
                               "fee": _fee_text(plan.get('price') or {})},
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
            "summary_code": "news_sum_plan_change",
            "summary_params": {"plan": str(after.get('name') or plan_id),
                               "fee_before": _fee_text(before.get('price') or {}),
                               "fee_after": _fee_text(after.get('price') or {}),
                               "fee_changed": fee_before != fee_after,
                               "terms_changed": bool(terms_changed)},
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


def _observed_before(observed_at: Any, captured_at: str) -> bool:
    """True when a stored observed_at is strictly earlier than captured_at."""
    try:
        return datetime.fromisoformat(str(observed_at)) < datetime.fromisoformat(captured_at)
    except (TypeError, ValueError):
        return False


def refresh_local(*, data_dir: Optional[Path | str] = None,
                  catalogue: Optional[Catalogue] = None,
                  plans_doc: Optional[Mapping[str, Any]] = None,
                  now: Optional[float] = None,
                  raw_doc: Any = None,
                  raw_cache_path: Optional[Path | str] = None,
                  official_path: Optional[Path | str] = None) -> dict[str, Any]:
    """Snapshot the catalogues and persist newly detected local news.

    The first snapshot only establishes the baseline. Never touches the
    network; safe to call on every News page view. ``raw_doc``/``raw_cache_path``
    inject the raw models.dev source for tests; otherwise it is resolved from
    the catalogue source. Raw and official reads are read-only.
    """
    from .pricing import load_catalogue

    snapshot_target = snapshot_path(data_dir)
    items_target = items_path(data_dir)
    book = catalogue if catalogue is not None else load_catalogue()
    if plans_doc is not None:
        plans = dict(plans_doc)
    else:
        from .membership_api import active_catalogue
        plans, _plans_source = active_catalogue(data_dir=data_dir)
        plans = dict(plans)
    observed_at = _now_iso(now)
    raw_rows = capture_raw_rows(book, raw_doc=raw_doc, raw_path=raw_cache_path)
    official_rows = _official_rows(official_path)
    fresh = snapshot_catalogue(book, plans, raw_rows=raw_rows)
    fresh["captured_at"] = observed_at

    ordered = sorted([snapshot_target, items_target], key=str)
    with ExitStack() as stack:
        for target in ordered:
            stack.enter_context(_locked(target))
        previous, _ = _read_json(snapshot_target)
        stored = load_items(items_target)
        if isinstance(previous, dict) and isinstance(previous.get("plans"), dict) \
                and not previous.get("plans_normalised"):
            # Pre-shared-catalogue snapshots stored raw plan terms; migrate
            # them so the upgrade itself is not reported as news. Runs once:
            # the fresh snapshot stored below carries the stamp.
            previous = {**previous, "plans": _migrate_snapshot_plans(previous["plans"])}
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
        found, meta = diff_snapshots(compare_old, fresh, observed_at=observed_at,
                                     plans_doc=plans, official=official_rows)
        stored_by_id = {str(item.get("id")): item for item in stored["items"]
                        if isinstance(item, dict) and item.get("id")}
        known = set(stored_by_id)
        merged = list(stored["items"])
        prev_captured = str(previous.get("captured_at") or "")
        for item in found:
            item_id = str(item.get("id"))
            if item_id not in known:
                known.add(item_id)
                merged.append(item)
                continue
            # The id is already stored. If the stored observation predates the
            # snapshot this diff ran against, the transition genuinely
            # recurred (A→B, B→A, A→B) and earns a recurrence id; a re-emit
            # against a snapshot the stored item postdates is the same
            # observation (e.g. a crash between the two writes) and is dropped.
            if not prev_captured \
                    or not _observed_before(stored_by_id[item_id].get("observed_at"),
                                            prev_captured):
                continue
            # The suffix derives from the compared snapshot, not the fresh
            # observation: a retried refresh against the same snapshot
            # (crash between the two writes) computes the same recurrence id
            # and is skipped below instead of stacking duplicates.
            recurrence_id = f"{item_id}-r" \
                + hashlib.sha1(prev_captured.encode("utf-8")).hexdigest()[:6]
            if recurrence_id in known:
                continue
            known.add(recurrence_id)
            merged.append({**item, "id": recurrence_id})
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
        raw_params = entry.get("summary_params")
        params: dict[str, Any] = {}
        if isinstance(raw_params, dict):
            for key, value in list(raw_params.items())[:16]:
                if value is None or isinstance(value, (str, int, float, bool)):
                    params[str(key)[:64]] = value[:256] if isinstance(value, str) else value
        items.append({
            "id": item_id, "origin": "central", "category": category,
            "provider": provider, "model": _valid_text(entry.get("model"), 256),
            "summary": summary,
            "summary_code": _valid_text(entry.get("summary_code"), 64),
            "summary_params": params,
            "previous": _valid_rate_block(previous) if previous is not None else None,
            "current": _valid_rate_block(current) if current is not None else None,
            "has_tiers": entry.get("has_tiers") is True,
            "observed_at": observed_at,
            "effective_at": _valid_text(entry.get("effective_at"), 64),
            "source_url": source_url, "confidence": confidence,
            "provenance": _valid_text(entry.get("provenance"), 256) or "SpendSense central feed",
            "conditions": _valid_text(entry.get("conditions"), 500),
            "conditions_code": _valid_text(entry.get("conditions_code"), 64),
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
                  now: Optional[float] = None) -> dict[tuple[str, str], dict[str, Any]]:
    """Read-only token sums per (recorded route, model) over a trailing window.

    ``last_ts`` (MAX(ts)) is additive evidence; existing callers that total
    only the token buckets are unaffected.
    """
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
                "COUNT(*), COALESCE(MAX(ts),0) FROM calls WHERE ts >= ? AND ts < ? AND outcome = 'ok' "
                "GROUP BY provider, model",
                (since, moment),
            ).fetchall()
        except Exception:  # noqa: BLE001 - a sparse store has no usable rows
            return {}
    finally:
        conn.close()
    out: dict[tuple[str, str], dict[str, Any]] = {}
    for provider, model, prompt, completion, read, write, calls, last_ts in rows:
        out[(str(provider or ""), str(model or ""))] = {
            "input": int(prompt or 0), "output": int(completion or 0),
            "cache_read": int(read or 0), "cache_write": int(write or 0),
            "calls": int(calls or 0), "last_ts": float(last_ts or 0),
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
    """Exact model identity only.

    A shared last path segment is pricing convenience, not evidence of the
    same model: "claude-haiku-4-5" and "anthropic/claude-haiku-4-5" are
    different ids, as are "openai/gpt-x" and "azure/gpt-x".
    """
    return bool(recorded) and bool(item_model) and recorded == item_model


def _usage_for_item(item: Mapping[str, Any],
                    usage: Mapping[tuple[str, str], dict[str, int]]) -> dict[str, int]:
    """Token totals for one item: canonical route provider, then exact model.

    Provider-only items (no model) keep the provider-wide totals; model items
    sum only rows that recorded the item's model id exactly.
    """
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


def _last_used_at(item: Mapping[str, Any],
                  usage: Mapping[tuple[str, str], Mapping[str, Any]]) -> str:
    """ISO timestamp of the newest exact (provider, model) usage row.

    Exact recorded model only: a last-segment match is pricing convenience,
    not evidence this item's model ran. Empty when there is nothing honest
    to report.
    """
    provider = str(item.get("provider") or "").lower()
    model = str(item.get("model") or "")
    if not provider or not model:
        return ""
    best: Optional[float] = None
    for (route, recorded), buckets in usage.items():
        if canonical_route_provider(route) != provider or recorded != model:
            continue
        last_ts = buckets.get("last_ts") if isinstance(buckets, Mapping) else None
        if isinstance(last_ts, (int, float)) and (best is None or last_ts > best):
            best = float(last_ts)
    return _now_iso(best) if best is not None else ""


def rank_items(items: list[dict[str, Any]], *,
               usage: Optional[Mapping[tuple[str, str], dict[str, int]]] = None,
               tokens: Optional[set[str]] = None) -> list[dict[str, Any]]:
    """Annotate news with For You evidence. Never promises account access.

    Model evidence is the exact (provider, model) pair: a model recorded
    under another provider, or a shared last path segment, never sets
    ``for_you`` or ``related_routes`` on its own. Provider-used and
    configured-provider signals stay provider-level.
    """
    usage = usage if usage is not None else {}
    tokens = tokens if tokens is not None else set()
    used_providers = {canonical_route_provider(route) for route, _ in usage}
    ranked: list[dict[str, Any]] = []
    for item in items:
        provider = str(item.get("provider") or "").lower()
        model = str(item.get("model") or "")
        related = sorted({route for (route, recorded) in usage
                          if canonical_route_provider(route) == provider
                          and (not model or _models_match(recorded, model))})[:5]
        configured = bool(provider) and provider in tokens
        model_used = bool(model) and any(
            canonical_route_provider(route) == provider and recorded == model
            for (route, recorded) in usage)
        for_you = bool(provider) and (
            provider in used_providers or provider in tokens or model_used)
        ranked.append({**item, "for_you": for_you, "configured_provider": configured,
                       "related_routes": related,
                       "last_used_at": _last_used_at(item, usage)})
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
        return {"basis": "unavailable", "reason": "no recent usage of this model",
                "reason_codes": ["news_impact_no_usage"]}
    if not isinstance(previous, Mapping) or not isinstance(current, Mapping):
        return {"basis": "unavailable", "reason": "rate comparison unavailable",
                "reason_codes": ["news_impact_no_rates"]}
    old_usd, old_complete = _cost(tokens, previous, current)
    new_usd, new_complete = _cost(tokens, current, previous)
    if old_usd is None or new_usd is None:
        return {"basis": "unavailable", "reason": "rate comparison unavailable",
                "reason_codes": ["news_impact_no_rates"]}
    caveats = []
    caveat_codes = []
    if not (old_complete and new_complete):
        caveats.append("cache rates unavailable for comparison; cache tokens excluded")
        caveat_codes.append("news_impact_cache_excluded")
    if item.get("has_tiers") is True:
        caveats.append("tiered pricing applies; base rates compared")
        caveat_codes.append("news_impact_tiered_rates")
    return {
        "basis": "full" if not caveats else "partial",
        "reason": "; ".join(caveats),
        "reason_codes": caveat_codes,
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
                    fetch: bool = True,
                    throttle: bool = False,
                    force: bool = False) -> dict[str, Any]:
    """User-triggered refresh: local snapshot diff, then the central fetch if due.

    With ``throttle`` the local diff runs through the monitoring throttle,
    so page-view refreshes diff at most once per interval and a skipped
    check reports ``local_refresh`` with reason ``fresh`` instead of
    re-diffing. ``force`` bypasses the throttle for explicit refreshes.
    """
    local_refresh: Optional[dict[str, Any]] = None
    if throttle:
        # Deferred: monitoring imports this module, so a top-level import
        # would be circular.
        from wolfmark_ledger import monitoring

        check = monitoring.maybe_refresh_local(
            data_dir=data_dir, catalogue=catalogue, plans_doc=plans_doc,
            now=now, force=force)
        local_refresh = {"checked": check["checked"], "reason": check["reason"],
                         "checked_at": check["checked_at"]}
        if check["checked"] and isinstance(check["result"], dict):
            local = check["result"]
        else:
            snapshot, _ = _read_json(snapshot_path(data_dir))
            local = {"baseline": snapshot is None,
                     "snapshot_at": (snapshot or {}).get("captured_at", ""),
                     "removed_models": [], "removed_model_count": 0,
                     "removed_plan_count": 0}
    else:
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
    if local_refresh is not None:
        payload["local_refresh"] = local_refresh
    return payload
