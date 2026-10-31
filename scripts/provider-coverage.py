#!/usr/bin/env python3
"""Emit PROVIDER-COVERAGE.md from the installed pricing catalogue."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from wolfmark_ledger.pricing import load_catalogue

def main():
    c = load_catalogue()
    rows, totals = [], {"models": 0, "cache_read": 0, "cache_write": 0, "tiers": 0}
    for provider in sorted(c.providers):
        models = c.providers[provider]
        read = sum(1 for r in models.values() if r.cache_read is not None)
        write = sum(1 for r in models.values() if r.cache_write is not None)
        tiers = sum(1 for r in models.values() if r.tiers)
        totals["models"] += len(models); totals["cache_read"] += read
        totals["cache_write"] += write; totals["tiers"] += tiers
        rows.append((provider, len(models), read, write, tiers))
    out = ["# Provider pricing coverage", "",
           f"Source: **{c.source}** · verified/as-of: `{c.as_of or 'unknown'}` · "
           f"providers: **{len(rows)}** · models: **{totals['models']}**", "",
           "`provider_catalogue` means the serving route's own row. Any row missing a",
           "rate for a provider is resolved only by the opt-in tiers (third_party →",
           "approximate) and is labelled as such; it is never presented as verified.", "",
           "| Provider | Models | Cache-read rate | Cache-write rate | Context tiers |",
           "|---|---:|---:|---:|---:|"]
    out += [f"| `{p}` | {n} | {r} | {w} | {t} |" for p, n, r, w, t in rows]
    out += ["", f"Totals: {totals['models']} models, {totals['cache_read']} with a cache-read rate, "
                f"{totals['cache_write']} with a cache-write rate, {totals['tiers']} tiered.", "",
            "Providers absent from this catalogue fall back to the labelled tiers above, or",
            "report `unpriced`. There is no undocumented scraping and no credential access."]
    Path(__file__).resolve().parent.parent.joinpath("PROVIDER-COVERAGE.md").write_text("\n".join(out) + "\n")
    print(f"wrote PROVIDER-COVERAGE.md: {len(rows)} providers, {totals['models']} models")

if __name__ == "__main__":
    main()
