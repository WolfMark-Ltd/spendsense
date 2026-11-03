"""Daily country aggregation for feed request counts (operator tooling).

Nginx writes temporary per-request lines of exactly ``METHOD STATUS COUNTRY``
(no IPs, timestamps, user agents or cookies) to a temp log. This module folds
those lines into daily country totals, then discards the temp records. Only
successful GETs count; monitoring checks use HEAD and are excluded.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import tempfile
from datetime import date, timedelta
from pathlib import Path
from typing import Any, Iterable, Optional

_LINE = re.compile(r"^(GET|HEAD) ([1-5][0-9]{2}) ([A-Z]{2}|Unknown)$")


class CountsError(RuntimeError):
    """Aggregation failed; temp records were quarantined, never counted twice."""


def parse_line(line: str) -> Optional[tuple[str, str, str]]:
    """Parse one temp count line. Anything else-shaped is ignored."""
    match = _LINE.match(line.strip())
    if not match:
        return None
    return match.group(1), match.group(2), match.group(3)


def aggregate_lines(lines: Iterable[str]) -> dict[str, int]:
    """Count successful GETs by country. Unknown is a first-class category."""
    totals: dict[str, int] = {}
    for line in lines:
        parsed = parse_line(line)
        if parsed is None:
            continue
        method, status, country = parsed
        if method != "GET" or not status.startswith("2"):
            continue
        totals[country] = totals.get(country, 0) + 1
    return totals


def merge_totals(existing: dict[str, dict[str, int]], day: str,
                 counts: dict[str, int]) -> dict[str, dict[str, int]]:
    merged = {key: dict(value) for key, value in existing.items()}
    bucket = merged.setdefault(day, {})
    for country, count in counts.items():
        bucket[country] = bucket.get(country, 0) + count
    return merged


def _quarantine(temp_log: Path) -> Path:
    import time as _time

    aside = temp_log.with_name(f"{temp_log.name}.failed-{int(_time.time())}")
    os.replace(temp_log, aside)
    return aside


def run(temp_log: Path, totals_path: Path, day: str) -> dict[str, int]:
    """Aggregate one temp log into the daily totals file, then discard it.

    On any totals failure the temp log is moved aside uncounted (never
    truncated, never counted twice) and CountsError is raised.
    """
    try:
        lines = temp_log.read_text(encoding="utf-8").splitlines()
    except OSError as exc:
        raise CountsError(f"cannot read temp log: {exc}") from exc
    counts = aggregate_lines(lines)
    try:
        if totals_path.exists():
            raw = json.loads(totals_path.read_text(encoding="utf-8"))
            if not isinstance(raw, dict):
                raise ValueError("totals file is not an object")
            existing = {str(day_key): {str(code): int(number)
                                       for code, number in (rows or {}).items()}
                        for day_key, rows in raw.items() if isinstance(rows, dict)}
        else:
            existing = {}
    except (OSError, ValueError) as exc:
        aside = _quarantine(temp_log)
        raise CountsError(f"totals unreadable, temp log kept at {aside.name}: {exc}") from exc
    merged = merge_totals(existing, day, counts)
    totals_path.parent.mkdir(parents=True, exist_ok=True)
    handle = tempfile.NamedTemporaryFile("w", dir=totals_path.parent, delete=False,
                                         suffix=".tmp", encoding="utf-8")
    try:
        json.dump(merged, handle, indent=2, sort_keys=True)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
        handle.close()
        os.replace(handle.name, totals_path)
    finally:
        if not handle.closed:
            handle.close()
        if os.path.exists(handle.name):
            os.unlink(handle.name)
    temp_log.write_text("", encoding="utf-8")
    return counts


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Aggregate feed country counts.")
    parser.add_argument("--counts", type=Path, required=True, help="Temp count log")
    parser.add_argument("--totals", type=Path, required=True, help="Daily totals JSON")
    parser.add_argument("--date", default="",
                        help="Day key (default: yesterday, server-local)")
    args = parser.parse_args(argv)
    day = args.date or (date.today() - timedelta(days=1)).isoformat()
    try:
        counts = run(args.counts, args.totals, day)
    except CountsError as exc:
        print(f"feed-counts: {exc}", file=sys.stderr)
        return 1
    total = sum(counts.values())
    print(f"date={day} countries={len(counts)} requests={total}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
