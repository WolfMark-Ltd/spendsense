#!/usr/bin/env python3
"""Compare the bundled rate snapshot with the current models.dev catalogue.

Outputs a reviewable report (markdown + JSON). Never edits the snapshot.
Exit 1 with --fail-on-change, for CI to open a review.
"""
from __future__ import annotations

import argparse, json, sys, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from wolfmark_ledger.pricing import _parse_catalogue  # noqa: E402

def load(target: Path | None, url: str | None, timeout: float = 20):
    if target:
        return json.loads(target.read_text(encoding="utf-8-sig"))
    req = urllib.request.Request(url, headers={"User-Agent": "wolfmark-cost-ledger-drift"})
    with urllib.request.urlopen(req, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))

def table(cat):
    if cat is None:
        return {}
    return {p: {m: (r.input, r.output, r.cache_read, r.cache_write) for m, r in models.items()}
            for p, models in cat.providers.items()}

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cache", type=Path)
    ap.add_argument("--url", default="https://models.dev/api.json")
    ap.add_argument("--bundled", type=Path, default=ROOT / "catalogue" / "rates.json")
    ap.add_argument("--out", type=Path, default=ROOT / "pricing-drift.md")
    ap.add_argument("--fail-on-change", action="store_true")
    args = ap.parse_args()

    current = _parse_catalogue(load(args.cache, None if args.cache else args.url),
                               source="live", confidence="aggregator", as_of="", version="live")
    bundled = _parse_catalogue(json.loads(args.bundled.read_text(encoding="utf-8")),
                               source="bundled", confidence="bundled", as_of="", version="bundled")
    now, old = table(current), table(bundled)
    added_p = sorted(set(now) - set(old)); removed_p = sorted(set(old) - set(now))
    added_m, removed_m, changed = [], [], []
    for provider in sorted(set(now) & set(old)):
        for model in sorted(set(now[provider]) - set(old[provider])):
            added_m.append((provider, model))
        for model in sorted(set(old[provider]) - set(now[provider])):
            removed_m.append((provider, model))
        for model in sorted(set(now[provider]) & set(old[provider])):
            if now[provider][model] != old[provider][model]:
                changed.append((provider, model, old[provider][model], now[provider][model]))

    lines = ["# Pricing drift — bundled snapshot vs live models.dev", "",
             f"Providers: +{len(added_p)} / -{len(removed_p)} · Models: +{len(added_m)} / -{len(removed_m)} · "
             f"Rate changes: {len(changed)}", ""]
    if added_p: lines += ["## New providers", *[f"- `{p}`" for p in added_p], ""]
    if removed_p: lines += ["## Removed providers", *[f"- `{p}`" for p in removed_p], ""]
    if added_m: lines += ["## New models", *[f"- `{p}/{m}`" for p, m in added_m[:200]], ""]
    if removed_m: lines += ["## Removed models", *[f"- `{p}/{m}`" for p, m in removed_m[:200]], ""]
    if changed:
        lines += ["## Rate changes", "| Provider | Model | Bundled in/out/cr/cw | Live |", "|---|---|---|---|"]
        for p, m, before, after in changed[:300]:
            lines.append(f"| `{p}` | `{m}` | {before} | {after} |")
    args.out.write_text("\n".join(lines) + "\n")
    args.out.with_suffix(".json").write_text(json.dumps(
        {"added_providers": added_p, "removed_providers": removed_p,
         "added_models": added_m[:500], "removed_models": removed_m[:500],
         "rate_changes": [{"provider": p, "model": m, "bundled": b, "live": a} for p, m, b, a in changed[:500]],
         "counts": {"providers": len(now), "models": sum(len(v) for v in now.values())}}, indent=2) + "\n")
    print(f"wrote {args.out}: +{len(added_m)} models, -{len(removed_m)}, {len(changed)} rate changes")
    return 1 if args.fail_on_change and (added_p or removed_p or added_m or removed_m or changed) else 0

if __name__ == "__main__":
    raise SystemExit(main())
