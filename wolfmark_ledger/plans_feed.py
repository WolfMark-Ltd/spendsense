from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Mapping

from . import membership as mem
from .membership_live import FEED_MAX_ITEMS, PLANS_FEED_VERSION, validate_feed


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
