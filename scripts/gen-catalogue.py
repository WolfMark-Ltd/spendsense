#!/usr/bin/env python3
"""Regenerate the bundled offline price snapshot.

Source: Hermes' models.dev cache (``~/.hermes/models_dev_cache.json``), the same
catalogue Hermes refreshes for model metadata. The bundled file is a fallback
for a fresh install or a missing cache; at runtime the live cache wins.

Usage:
    python3 scripts/gen-catalogue.py
    python3 scripts/gen-catalogue.py --input /path/to/models_dev_cache.json
"""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUT = ROOT / "catalogue" / "rates.json"

# Providers worth shipping: the routes Hermes users actually bill through.
# Deliberately excludes resellers and duplicate gateways whose rows would only
# bloat the fallback. Adding one is a one-line change.
KEEP = [
    "commandcode", "xai", "openai", "opencode", "deepseek", "anthropic",
    "google", "google-vertex", "amazon-bedrock", "azure", "github-copilot",
    "openrouter", "nous", "moonshotai", "z-ai", "meta", "minimax", "mistral",
    "groq", "togetherai", "cerebras", "fireworks-ai", "deepinfra",
    "perplexity", "alibaba", "xiaomi",
]


def _num(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if number >= 0 else None


def _rate(cost: Any) -> dict[str, Any] | None:
    if not isinstance(cost, dict):
        return None
    inp, out = _num(cost.get("input")), _num(cost.get("output"))
    if inp is None or out is None:
        return None
    rate: dict[str, Any] = {"input": inp, "output": out}
    for key in ("cache_read", "cache_write"):
        value = _num(cost.get(key))
        if value is not None:
            rate[key] = value
    tiers = cost.get("tiers")
    if isinstance(tiers, list) and tiers:
        rate["tiers"] = tiers
    elif isinstance(cost.get("context_over_200k"), dict):
        rate["context_over_200k"] = cost["context_over_200k"]
    return rate


def build(catalog: dict[str, Any]) -> dict[str, Any]:
    data = catalog.get("data", catalog)
    providers: dict[str, dict[str, Any]] = {}
    for provider in KEEP:
        entry = data.get(provider)
        if not isinstance(entry, dict):
            continue
        models = entry.get("models")
        if not isinstance(models, dict):
            continue
        rows: dict[str, Any] = {}
        for model_id, model in models.items():
            if not isinstance(model, dict):
                continue
            rate = _rate(model.get("cost"))
            if rate:
                rows[str(model_id)] = rate
        if rows:
            providers[provider] = rows
    now = datetime.now(timezone.utc)
    return {
        "version": f"models.dev-{now:%Y-%m-%d}",
        "generated_at": now.isoformat(),
        "source": "models.dev via Hermes cache",
        "providers": providers,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path,
                        default=Path.home() / ".hermes" / "models_dev_cache.json")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUT)
    args = parser.parse_args()

    if not args.input.exists():
        raise SystemExit(f"models.dev cache not found: {args.input}")
    catalog = json.loads(args.input.read_text(encoding="utf-8-sig"))
    out = build(catalog)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(out, indent=1, sort_keys=True) + "\n", encoding="utf-8")
    models = sum(len(v) for v in out["providers"].values())
    print(f"wrote {args.output} — {len(out['providers'])} providers, {models} models, "
          f"{args.output.stat().st_size / 1024:.0f} KiB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
