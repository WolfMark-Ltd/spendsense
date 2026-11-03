"""Central Model News feed generator (operator tooling).

Deterministic: the same ``--current`` / ``--previous`` models.dev snapshots,
curated announcements and ``--observed-at`` always produce byte-identical
output. Compares priced catalogue rows only — no usage, no accounts — and
transcribes curated subscription notes verbatim after strict validation.

Nothing is invented: a curated entry is published exactly as written, with
its source URL, and the generator refuses entries without https evidence.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Mapping, Optional

from .news import CATEGORIES, CONFIDENCES, FEED_MAX_ITEMS, rate_direction, validate_feed
from .pricing import _parse_catalogue

MODELS_DEV_URL = "https://models.dev"


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


def _model_id(observed: str, category: str, provider: str, model: str,
              old: str, new: str) -> str:
    digest = hashlib.sha1("|".join([observed, category, provider, model, old, new])
                          .encode("utf-8")).hexdigest()[:12]
    return f"md-{digest}"


def _slim(entry: Mapping[str, Any]) -> dict[str, Any]:
    return {"input": entry.get("input"), "output": entry.get("output"),
            "cache_read": entry.get("cache_read"), "cache_write": entry.get("cache_write")}


def _model_diff(previous: Mapping[str, dict[str, dict[str, Any]]],
                current: Mapping[str, dict[str, dict[str, Any]]],
                observed_at: str) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    for provider in sorted(set(current) - set(previous)):
        models = current[provider]
        items.append({
            "id": _model_id(observed_at, "new_model", provider, "", "", str(len(models))),
            "category": "new_model", "provider": provider, "model": "",
            "summary": f"{provider} newly listed on models.dev with {len(models)} priced model(s).",
            "previous": None, "current": None,
            "observed_at": observed_at, "effective_at": "",
            "source_url": MODELS_DEV_URL, "confidence": "observed",
            "provenance": "models.dev",
            "conditions": "Catalogue listing only; not confirmed available on any account.",
        })
    for provider in sorted(set(current) & set(previous)):
        before, after = previous[provider], current[provider]
        for model in sorted(set(after) - set(before)):
            entry = after[model]
            items.append({
                "id": _model_id(observed_at, "new_model", provider, model, "", _sig(entry)),
                "category": "new_model", "provider": provider, "model": model,
                "summary": f"{model} newly listed under {provider} on models.dev.",
                "previous": None, "current": _slim(entry),
                "observed_at": observed_at, "effective_at": "",
                "source_url": MODELS_DEV_URL, "confidence": "observed",
                "provenance": "models.dev",
                "conditions": "Catalogue listing only; not confirmed available on any account.",
            })
        for model in sorted(set(before) & set(after)):
            old_entry, new_entry = before[model], after[model]
            if _sig(old_entry) == _sig(new_entry):
                continue
            category = rate_direction(old_entry, new_entry)
            old_sig, new_sig = _sig(old_entry), _sig(new_entry)
            tier_note = "Tiered/context pricing changed; base rates compared." \
                if old_entry.get("tiers") != new_entry.get("tiers") else ""
            items.append({
                "id": _model_id(observed_at, category, provider, model, old_sig, new_sig),
                "category": category, "provider": provider, "model": model,
                "summary": f"{model} ({provider}) list price changed on models.dev.",
                "previous": _slim(old_entry), "current": _slim(new_entry),
                "has_tiers": bool(old_entry.get("tiers") or new_entry.get("tiers")),
                "observed_at": observed_at, "effective_at": "",
                "source_url": MODELS_DEV_URL, "confidence": "observed",
                "provenance": "models.dev",
                "conditions": tier_note,
            })
    return items


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


def _curated(entries: Any, observed_at: str) -> tuple[list[dict[str, Any]], list[str]]:
    items: list[dict[str, Any]] = []
    problems: list[str] = []
    if not isinstance(entries, list):
        return items, ["curated announcements entry is not a list"]
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
        digest = hashlib.sha1("|".join([provider, str(entry.get("model") or ""),
                                        summary, source_url]).encode("utf-8")).hexdigest()[:12]
        items.append({
            "id": f"sub-{digest}",
            "category": category, "provider": provider,
            "model": str(entry.get("model") or "").strip()[:256],
            "summary": summary[:500],
            "previous": _rate_block(previous) if previous is not None else None,
            "current": _rate_block(current) if current is not None else None,
            "observed_at": str(entry.get("observed_at") or observed_at).strip()[:64],
            "effective_at": str(entry.get("effective_at") or "").strip()[:64],
            "source_url": source_url[:500], "confidence": confidence,
            "provenance": str(entry.get("provenance") or "Spend Sense curation").strip()[:256],
            "conditions": str(entry.get("conditions") or "").strip()[:500],
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
    if validated is None:
        return [], ["prior feed invalid: " + "; ".join(prior_problems)]
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


def build_feed(current: Any, previous: Any, curated_doc: Any, *,
               observed_at: str, prior_feed: Any = None,
               retain_days: int = 90) -> tuple[dict[str, Any], list[str]]:
    """Diff two models.dev snapshots and merge validated curated notes.

    ``prior_feed`` carries the last published feed's recent items forward so
    history survives across runs; items older than ``retain_days`` expire.
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
            cur_table = _table(current)
        except ValueError as exc:
            problems.append(f"current snapshot: {exc}")
            cur_table = None
        if prev_table is not None and cur_table is not None:
            model_items = _model_diff(prev_table, cur_table, observed_at)
    announcements = curated_doc.get("announcements", []) if isinstance(curated_doc, dict) else None
    curated_items, curated_problems = _curated(announcements, observed_at)
    problems.extend(curated_problems)
    if prior_feed is not None:
        fresh_ids = {item["id"] for item in model_items} | {item["id"] for item in curated_items}
        carried, carry_problems = _carried_items(prior_feed, fresh_ids, observed_at, retain_days)
        problems.extend(carry_problems)
        for item in carried:
            if item["id"].startswith("sub-"):
                curated_items.append(item)
            else:
                model_items.append(item)
    if len(curated_items) > FEED_MAX_ITEMS:
        problems.append(f"curated announcements exceed the {FEED_MAX_ITEMS}-item feed limit")
        curated_items = []
    model_items.sort(key=_sort_key, reverse=True)
    curated_items.sort(key=_sort_key, reverse=True)
    room = FEED_MAX_ITEMS - len(curated_items)
    kept_models = model_items[:room]
    dropped = len(model_items) - len(kept_models)
    items = sorted(kept_models + curated_items, key=_sort_key, reverse=True)
    doc: dict[str, Any] = {"version": 1, "generated_at": observed_at, "items": items}
    if dropped:
        doc["truncated"] = {"model_items_dropped": dropped}
    return doc, problems


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Build the public Model News feed.")
    parser.add_argument("--current", type=Path, required=True,
                        help="Current models.dev api.json snapshot")
    parser.add_argument("--previous", type=Path,
                        help="Previous snapshot; omit on the first run (no model diff)")
    parser.add_argument("--curated", type=Path, required=True,
                        help="Curated announcements JSON")
    parser.add_argument("--observed-at", default="",
                        help="Observation timestamp (default: now, UTC)")
    parser.add_argument("--prior-feed", type=Path,
                        help="Last published feed; recent items carry forward")
    parser.add_argument("--retain-days", type=int, default=90,
                        help="Prior items older than this expire (default: 90)")
    parser.add_argument("--out", type=Path, required=True, help="Feed JSON to write")
    args = parser.parse_args(argv)
    try:
        current = json.loads(args.current.read_text(encoding="utf-8-sig"))
        previous = json.loads(args.previous.read_text(encoding="utf-8-sig")) if args.previous else None
        curated_doc = json.loads(args.curated.read_text(encoding="utf-8-sig"))
        prior_feed = json.loads(args.prior_feed.read_text(encoding="utf-8-sig")) \
            if args.prior_feed else None
    except (OSError, ValueError) as exc:
        print(f"news-feed: cannot read inputs: {exc}", file=sys.stderr)
        return 1
    observed_at = args.observed_at or datetime.now(timezone.utc).isoformat()
    doc, problems = build_feed(current, previous, curated_doc, observed_at=observed_at,
                               prior_feed=prior_feed, retain_days=args.retain_days)
    if problems:
        for problem in problems:
            print(f"news-feed: {problem}", file=sys.stderr)
        return 1
    args.out.write_text(json.dumps(doc, indent=2, sort_keys=True, allow_nan=False) + "\n",
                             encoding="utf-8")
    print(f"wrote {args.out}: {len(doc['items'])} items")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
