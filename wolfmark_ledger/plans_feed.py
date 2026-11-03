"""Central membership-plan feed generator (operator tooling).

Builds the public, versioned plans feed served at ``FEED_URL`` from the
approved ``catalogue/plans.json``. Only current plans are published:
``retired`` plans are withheld (the desktop pane already marks any stored
membership on a retired plan for reconfirmation), while ``verified``,
``provisional`` and ``unverified`` plans ship with their verification
state intact so the pane keeps showing exactly what operators approved.

The generator output always passes :func:`membership_live.validate_feed`;
run the ``plans-feed`` wrapper after editing the catalogue and publish
the result alongside the news feed.
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping, Optional

from . import membership as mem
from .membership_live import FEED_MAX_BYTES, FEED_MAX_ITEMS, PLANS_FEED_VERSION, validate_feed

CATALOGUE_PATH = Path(__file__).resolve().parent.parent / "catalogue" / "plans.json"


def build_feed(catalogue: Mapping[str, Any], *, generated_at: str = "",
               max_items: int = FEED_MAX_ITEMS) -> tuple[dict[str, Any], list[str]]:
    """Build the publishable plans feed. Returns ``(doc, problems)``.

    ``problems`` is non-empty when the catalogue is invalid, the plan
    list exceeds the feed limit, or the built document fails client
    validation; callers must not publish then.
    """
    try:
        book = mem.load_plan_catalogue(catalogue)
    except mem.CatalogueError as exc:
        return {}, [f"plan catalogue invalid: {exc}"]
    current = [plan for plan in book["plans"]
               if plan["verification"]["status"] != "retired"]
    problems: list[str] = []
    if len(current) > max_items:
        problems.append(
            f"{len(current)} current plans exceed the {max_items}-plan feed limit")
        current = current[:max_items]
    doc: dict[str, Any] = {
        "version": PLANS_FEED_VERSION,
        "catalogue_version": book["catalogue_version"],
        "generated_at": generated_at or datetime.now(timezone.utc).isoformat(),
        "plans": current,
        "sources": book["sources"],
    }
    _, check = validate_feed(doc)
    problems.extend(f"generated feed failed validation: {entry}" for entry in check)
    return doc, problems


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        description="Build the public membership-plan feed.")
    parser.add_argument("--catalogue", type=Path, default=CATALOGUE_PATH,
                        help="Approved plan catalogue (default: catalogue/plans.json)")
    parser.add_argument("--generated-at", default="",
                        help="Generation timestamp (default: now, UTC)")
    parser.add_argument("--max-items", type=int, default=FEED_MAX_ITEMS,
                        help=f"Plan limit (default: {FEED_MAX_ITEMS})")
    parser.add_argument("--out", type=Path, required=True, help="Feed JSON to write")
    args = parser.parse_args(argv)
    try:
        catalogue = json.loads(args.catalogue.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError) as exc:
        print(f"plans-feed: cannot read catalogue: {exc}", file=sys.stderr)
        return 1
    doc, problems = build_feed(catalogue, generated_at=args.generated_at,
                               max_items=args.max_items)
    if problems:
        for problem in problems:
            print(f"plans-feed: {problem}", file=sys.stderr)
        return 1
    text = json.dumps(doc, indent=2, sort_keys=True, allow_nan=False) + "\n"
    if len(text.encode("utf-8")) > FEED_MAX_BYTES:
        print(f"plans-feed: feed exceeds the {FEED_MAX_BYTES}-byte client limit",
              file=sys.stderr)
        return 1
    args.out.write_text(text, encoding="utf-8")
    print(f"wrote {args.out}: {len(doc['plans'])} plans "
          f"(catalogue {doc['catalogue_version']})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
