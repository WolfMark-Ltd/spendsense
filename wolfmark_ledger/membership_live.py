"""Optional central membership-plan catalogue ("Spend Sense Live Updates").

Mirrors the Model News central-feed discipline from :mod:`wolfmark_ledger.news`
one level down: the bundled ``catalogue/plans.json`` is always the default,
and nothing here touches the network unless the user opts into Live Updates.
When enabled, one unauthenticated HTTPS GET fetches the public, versioned
plans feed (no user data sent); the parsed catalogue is validated with the
same loader as the bundled file, cached atomically on disk, and served in
place of the bundled copy. Any fetch or validation failure keeps the
previous cache and is reported in the payload — personal fees, selected
plans and stored memberships are never altered by this module.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping, Optional
from urllib.request import Request, urlopen

from . import membership as mem
from . import news as news_mod
from .filelock import locked as _locked
# The cache helpers live in wolfmark_ledger.news so the two feeds share one
# atomic read/write discipline rather than a copy that could drift.
from .news import _atomic_write_json, _now_iso, _read_json, _resolve

log = logging.getLogger(__name__)

PLANS_FEED_VERSION = 1
FEED_URL = "https://spendsense.wolfmark.co.uk/feed/v1/plans.json"
FEED_TIMEOUT = 10.0
FEED_MAX_BYTES = 256 * 1024
FEED_CACHE_SECONDS = 6 * 3600
FEED_MAX_ITEMS = 200
CACHE_NAME = "plans-feed-cache.json"


def cache_path(data_dir: Optional[Path | str] = None) -> Path:
    """Location of the cached central plans catalogue."""
    return _resolve(CACHE_NAME, data_dir)


def validate_feed(raw: Any) -> tuple[Optional[dict[str, Any]], list[str]]:
    """Validate a downloaded plans feed.

    Returns ``(book, problems)`` where ``book`` is a validated plan
    catalogue in the same shape :func:`membership.load_plan_catalogue`
    returns, or ``None`` when the feed is unusable.
    """
    if not isinstance(raw, dict):
        return None, ["plans feed is not an object"]
    if raw.get("version") != PLANS_FEED_VERSION:
        return None, [f"plans feed needs version {PLANS_FEED_VERSION}"]
    plans = raw.get("plans")
    if not isinstance(plans, list):
        return None, ["plans feed has no plans list"]
    problems: list[str] = []
    if len(plans) > FEED_MAX_ITEMS:
        problems.append(f"plans feed truncated to {FEED_MAX_ITEMS} plans")
        raw = {**raw, "plans": plans[:FEED_MAX_ITEMS]}
    try:
        book = mem.load_plan_catalogue(raw)
    except mem.CatalogueError as exc:
        return None, [f"plans feed catalogue invalid: {exc}"]
    return book, problems


def parse_catalogue_version(value: Any) -> Optional[tuple[int, int, int, int]]:
    """Ordering key for a ``YYYY-MM-DD.N`` catalogue version.

    Returns ``(year, month, day, counter)``, or ``None`` when the value
    is not a strict calendar version. Anything unparseable is
    uncomparable: callers fail open (keep the existing behaviour) and
    never guess an order.
    """
    text = str(value or "").strip()
    head, dot, tail = text.rpartition(".")
    if not dot or not tail.isdigit():
        return None
    try:
        day = datetime.strptime(head, "%Y-%m-%d")
    except ValueError:
        return None
    return (day.year, day.month, day.day, int(tail))


def compare_catalogue_versions(first: Any, second: Any) -> Optional[int]:
    """Three-way catalogue order: -1, 0 or 1.

    Returns ``None`` when either side does not parse: unknown means
    unknown, and the caller decides the safe default.
    """
    left = parse_catalogue_version(first)
    right = parse_catalogue_version(second)
    if left is None or right is None:
        return None
    return (left > right) - (left < right)


def central_is_stale(central_book: Optional[Mapping[str, Any]],
                     bundled_book: Optional[Mapping[str, Any]]) -> bool:
    """True only when the central copy is proven older than bundled.

    Missing books, missing versions and unparseable versions all answer
    False: the safeguard holds a live copy back only on proof, and every
    other case keeps the long-standing selection behaviour.
    """
    central = central_book.get("catalogue_version") \
        if isinstance(central_book, Mapping) else None
    bundled = bundled_book.get("catalogue_version") \
        if isinstance(bundled_book, Mapping) else None
    return compare_catalogue_versions(central, bundled) == -1


def load_cache(path: Optional[Path | str] = None) -> dict[str, Any]:
    """Read the cached central plans catalogue. Never raises."""
    target = Path(path) if path else cache_path()
    cached, cache_error = _read_json(target)
    if cached is None:
        return {"book": None, "fetched_at": "", "state": "never",
                "error": cache_error}
    book = cached.get("book")
    if book is not None and not isinstance(book, dict):
        return {"book": None, "fetched_at": "", "state": "never",
                "error": f"unreadable: {target.name}"}
    return {"book": book, "fetched_at": str(cached.get("fetched_at") or ""),
            "state": str(cached.get("state") or "never"),
            "error": str(cached.get("error") or "")}


def fetch_central(*, data_dir: Optional[Path | str] = None,
                 settings: Optional[Mapping[str, Any]] = None,
                 now: Optional[float] = None,
                 force: bool = False) -> dict[str, Any]:
    """Fetch the central plans feed when Live Updates is on and due.

    Sends an unauthenticated GET with static headers only: no user IDs,
    accounts, credentials, model lists, usage or tracking tokens. Returns
    ``{"book", "fetched_at", "state", "error"}`` with the same state
    vocabulary as the news central fetch: ``ok``, ``stale``, ``error``,
    ``disabled`` or ``disabled_cached``. Any failure keeps the previous
    cache and reports the error; the bundled catalogue is unaffected.
    When another refresh lands newer data mid-flight, a failed fetch
    adopts that cache instead of overwriting it with its older copy.
    """
    import time as _time

    moment = now if now is not None else _time.time()
    enabled = (settings if isinstance(settings, Mapping) else
               news_mod.load_settings(news_mod.settings_path(data_dir))
               ).get("live_updates") is True
    target = cache_path(data_dir)
    cached = load_cache(target)
    if not enabled:
        if isinstance(cached.get("book"), dict) and cached["book"]:
            return {"book": cached["book"], "fetched_at": cached["fetched_at"],
                    "state": "disabled_cached", "error": ""}
        return {"book": None, "fetched_at": "", "state": "disabled", "error": ""}
    if not force and cached.get("book") and cached.get("fetched_at"):
        try:
            age = moment - datetime.fromisoformat(
                cached["fetched_at"]).timestamp()
        except (TypeError, ValueError):
            age = FEED_CACHE_SECONDS + 1
        if 0 <= age < FEED_CACHE_SECONDS:
            return {"book": cached["book"], "fetched_at": cached["fetched_at"],
                    "state": "ok", "error": ""}
    request = Request(FEED_URL, headers={"Accept": "application/json",
                                         "User-Agent": "SpendSense-Plans"})
    fetched_ok = True
    try:
        with urlopen(request, timeout=FEED_TIMEOUT) as response:  # noqa: S310 - fixed https host
            body = response.read(FEED_MAX_BYTES + 1)
        if len(body) > FEED_MAX_BYTES:
            raise ValueError("feed exceeds the size cap")
        book, problems = validate_feed(json.loads(body.decode("utf-8-sig")))
        if book is None:
            raise ValueError("; ".join(problems) or "invalid feed")
        previous = cached.get("book")
        if (isinstance(previous, dict) and previous.get("plans")
                and compare_catalogue_versions(
                    book.get("catalogue_version"),
                    previous.get("catalogue_version")) == -1):
            # The feed regressed (a stale publish after a newer one): keep
            # the newest known-good copy instead of caching older data.
            # fetched_at stays put: this data was not adopted now.
            payload = {"version": PLANS_FEED_VERSION,
                       "fetched_at": cached.get("fetched_at") or "",
                       "state": "ok", "error": "", "book": previous}
        else:
            payload = {"version": PLANS_FEED_VERSION,
                       "fetched_at": _now_iso(moment),
                       "state": "ok", "error": "; ".join(problems),
                       "book": book}
    except Exception as exc:  # noqa: BLE001 - any fetch failure keeps bundled plans working
        fetched_ok = False
        log.warning("spend-sense: plans feed fetch failed: %s", exc)
        payload = {"version": PLANS_FEED_VERSION,
                   "fetched_at": cached.get("fetched_at") or "",
                   "state": "stale" if cached.get("book") else "error",
                   "error": f"central catalogue unavailable ({type(exc).__name__})",
                   "book": cached.get("book")}
    with _locked(target):
        if not fetched_ok:
            current = load_cache(target)
            if (current.get("fetched_at") or "") != (cached.get("fetched_at") or "") \
                    and current.get("fetched_at"):
                # Only a success moves fetched_at, so a different stamp
                # means newer data landed mid-flight: keep it.
                return {"book": current["book"],
                        "fetched_at": current["fetched_at"],
                        "state": current["state"], "error": current["error"]}
        _atomic_write_json(target, payload)
    return {"book": payload["book"], "fetched_at": payload["fetched_at"],
            "state": payload["state"], "error": payload["error"]}
