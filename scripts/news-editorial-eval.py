#!/usr/bin/env python3
"""Read-only evaluation harness for the Model News editorial layer.

Compares what a client shows today (every event, newest first) with what the
shared briefing would show, and emits the one-pass editorial prompt so a
curation trial can be measured rather than assumed. Nothing here writes to a
feed, a service or a catalogue.

    # What changed for a reader, and how much the briefing costs in bytes
    python3 scripts/news-editorial-eval.py feed.json

    # The exact story set a single curated pass would be given
    python3 scripts/news-editorial-eval.py feed.json --prompt

``feed.json`` is any published feed document (``/feed/v1/news.json``). The
script is offline: pass a file, never a URL, so a trial sends nothing and adds
no request to the public totals.
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from wolfmark_ledger import news_briefing  # noqa: E402

#: Bare metrics for a cost estimate; labelled as estimates because no tokeniser
#: is vendored here. Four characters per token is the usual English rule.
CHARS_PER_TOKEN = 4


def load(path: Path) -> dict:
    doc = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(doc, dict) or not isinstance(doc.get("items"), list):
        raise SystemExit(f"{path}: not a feed document")
    return doc


def baseline(items: list[dict]) -> dict:
    """What the client renders with no editorial layer: every event."""
    categories = Counter(str(item.get("category") or "") for item in items)
    provider_noise = sum(1 for item in items
                         if item.get("category") == "new_model" and not item.get("model"))
    return {
        "cards": len(items),
        "providers": len({str(item.get("provider") or "") for item in items}),
        "categories": dict(categories),
        "provider_only_listings": provider_noise,
        "distinct_headlines": len({str(item.get("summary") or "") for item in items}),
    }


def report(doc: dict) -> None:
    items = doc["items"]
    base = baseline(items)
    briefing = news_briefing.build_briefing(
        items, generated_at=str(doc.get("generated_at") or ""))
    headlined = [entry for section in briefing["sections"] for entry in section["entries"]]

    print(f"generated_at      {doc.get('generated_at')}")
    print(f"window            {briefing['all_updates']['oldest']} → "
          f"{briefing['all_updates']['newest']}")
    print(f"events            {base['cards']} across {base['providers']} providers")
    print(f"provider-only     {base['provider_only_listings']} "
          f"({base['provider_only_listings'] * 100 // max(1, base['cards'])}%)")
    print(f"categories        {base['categories']}")
    print(f"headlined         {len(headlined)} entries in "
          f"{len(briefing['sections'])} sections")
    print(f"counts            "
          f"{ {k: v for k, v in briefing['counts'].items() if v} }")
    for reason in briefing["unsupported"]:
        print(f"unsupported       {reason['id']}: {reason['reason_code']}")
    print(f"payload           items {len(json.dumps(items))} B, "
          f"briefing {len(json.dumps(briefing))} B")

    print("\n--- headline sections")
    for section in briefing["sections"]:
        if not section["entries"]:
            continue
        print(f"\n[{section['id']}] {section['total']} entry/entries")
        for entry in section["entries"]:
            print(f"  - {entry['headline']}")
            for variant in entry.get("variants", [])[1:4]:
                print(f"      · {variant['headline']}")


def prompt(doc: dict) -> None:
    """Emit the bounded one-pass curation prompt with the real story set."""
    briefing = news_briefing.build_briefing(
        doc["items"], generated_at=str(doc.get("generated_at") or ""))
    stories = []
    for section in briefing["sections"]:
        for entry in section["entries"]:
            stories.append({
                "id": entry["event_ids"][0] if entry["event_ids"] else entry["model"],
                "section": section["id"],
                "event_type": entry["event_type"],
                "provider": entry["provider"],
                "model": entry["model"],
                "family": entry["family_label"],
                "rates": entry["headline_params"],
                "observed_at": entry["observed_at"],
                "source_url": entry["source_url"],
                "confidence": entry["confidence"],
            })
    body = {
        "role": "editor",
        "constraints": [
            "Rewrite each story as one headline of at most 90 characters.",
            "Use only the provider, model, rates and dates supplied.",
            "Never infer a launch, retirement or plan entitlement.",
            "Never invent a blended percentage or an exchange rate.",
            "Return JSON: [{id, headline}] and nothing else.",
        ],
        "stories": stories,
    }
    text = json.dumps(body, indent=1)
    print(text)
    print(f"\n# stories: {len(stories)}")
    print(f"# prompt characters: {len(text)}")
    print(f"# estimated input tokens at {CHARS_PER_TOKEN} chars/token: "
          f"{len(text) // CHARS_PER_TOKEN}")


def main() -> None:
    parser = argparse.ArgumentParser(description=(__doc__ or "news editorial eval").splitlines()[0])
    parser.add_argument("feed", type=Path, help="published feed JSON (offline file)")
    parser.add_argument("--prompt", action="store_true",
                        help="emit the one-pass editorial prompt instead of the report")
    args = parser.parse_args()
    doc = load(args.feed)
    prompt(doc) if args.prompt else report(doc)


if __name__ == "__main__":
    main()
