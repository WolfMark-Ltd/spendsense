#!/usr/bin/env python3
"""Regenerate the FALLBACK_RATES table inlined in desktop/plugin.js.

Source: ~/.hermes/models_dev_cache.json (the models.dev catalog Hermes already
keeps on disk). Run after switching to a provider whose model is missing:

    python3 scripts/gen-rates.py

The desktop plugin loader rejects relative imports, so the table cannot live in
its own module — this script rewrites the `const FALLBACK_RATES = ...` literal
in place.
"""
import argparse
import json
import math
import os
import re
import sys

PLUGIN = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "desktop", "plugin.js")
CACHE = os.path.expanduser("~/.hermes/models_dev_cache.json")

# Providers worth shipping. models.dev has 200+; most are resellers whose rows
# would triple the file for models nobody here routes to.
KEEP = None  # every provider in the catalog; exact rates first


def build(catalog):
    """Build compact rates while retaining explicit cache prices and tier evidence."""
    out = {}
    providers = sorted(catalog) if KEEP is None else KEEP
    for provider in providers:
        entry = catalog.get(provider)
        if not entry:
            continue
        models = {}
        for model_id, model in (entry.get("models") or {}).items():
            cost = model.get("cost") or {}
            inp, outp = cost.get("input"), cost.get("output")
            if inp is None or outp is None:
                continue
            inp = float(inp)
            outp = float(outp)
            if not all(math.isfinite(value) and value >= 0 for value in (inp, outp)):
                continue
            # Keep explicit zero prices, missing cache prices and unresolved
            # context tiers distinct. Bits: flat tier evidence / read / write.
            def known(value):
                """Recognise explicit finite, non-negative prices, including zero."""
                return type(value) in (int, float) and math.isfinite(value) and value >= 0
            cache, write = cost.get("cache_read"), cost.get("cache_write")
            flags = int(not cost.get("tiers") and not cost.get("context_over_200k"))
            flags |= 2 if known(cache) else 0
            flags |= 4 if known(write) else 0
            row = [inp, outp, float(cache) if known(cache) else inp,
                   float(write) if known(write) else None, flags]
            models[str(model_id).lower()] = row
        if models:
            out[provider] = models
    return out


def main():
    """Regenerate the inline rate table from the selected catalogue or Hermes cache."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--catalogue', default=CACHE, help='explicit offline catalogue, or the Hermes cache')
    args = parser.parse_args()
    source_path = args.catalogue
    if not os.path.exists(source_path):
        sys.exit(f"missing {source_path} — run Hermes once so it fetches models.dev")
    catalog = json.load(open(source_path))
    catalog = catalog.get("data", catalog.get("providers", catalog))
    table = build(catalog)
    literal = json.dumps(table, sort_keys=True, separators=(",", ":"))

    source = open(PLUGIN).read()
    pattern = re.compile(r"(const FALLBACK_RATES = /\* @generated \*/ )(\{.*?\})\n", re.S)
    if not pattern.search(source):
        sys.exit("could not find the FALLBACK_RATES literal in plugin.js")
    source = pattern.sub(lambda m: m.group(1) + literal + "\n", source, count=1)
    open(PLUGIN, "w").write(source)

    print(f"wrote FALLBACK_RATES in desktop/plugin.js: {sum(len(v) for v in table.values())} models "
          f"across {len(table)} providers ({len(literal)} bytes)")


if __name__ == "__main__":
    main()
