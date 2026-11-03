"""Daily country aggregation for feed request counts (operator tooling).

Nginx writes temporary per-request lines of exactly
``DATE METHOD STATUS COUNTRY`` (date only, never a full timestamp; no IPs,
user agents, cookies or identifiers) to a temp log. This module rotates that
log aside, asks Nginx to reopen its logs, folds the rotated lines into daily
country totals keyed by each line's own date, then deletes the rotated file.
Only successful GETs count; monitoring checks use HEAD and are excluded.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
from datetime import date
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping, Optional

_LINE = re.compile(r"^([0-9]{4}-[0-9]{2}-[0-9]{2}) (GET|HEAD) ([1-5][0-9]{2}) ([A-Z]{2}|Unknown)$")


class CountsError(RuntimeError):
    """Aggregation failed; uncounted lines were left aside for retry."""


def parse_line(line: str) -> Optional[tuple[str, str, str, str]]:
    """Parse one temp count line. Anything else-shaped is ignored."""
    match = _LINE.match(line.strip())
    if not match:
        return None
    day, method, status, country = match.groups()
    try:
        date.fromisoformat(day)
    except ValueError:
        return None
    return day, method, status, country


def aggregate_lines(lines: Iterable[str]) -> dict[str, dict[str, int]]:
    """Count successful GETs by day and country. Unknown is first-class."""
    totals: dict[str, dict[str, int]] = {}
    for line in lines:
        parsed = parse_line(line)
        if parsed is None:
            continue
        day, method, status, country = parsed
        if method != "GET" or not status.startswith("2"):
            continue
        bucket = totals.setdefault(day, {})
        bucket[country] = bucket.get(country, 0) + 1
    return totals


def merge_totals(existing: Mapping[str, Mapping[str, int]],
                 counts: Mapping[str, Mapping[str, int]]) -> dict[str, dict[str, int]]:
    merged = {day: dict(bucket) for day, bucket in existing.items()}
    for day, bucket in counts.items():
        target = merged.setdefault(day, {})
        for country, count in bucket.items():
            target[country] = target.get(country, 0) + count
    return merged


def _read_lines(path: Path) -> list[str]:
    try:
        return path.read_text(encoding="utf-8").splitlines()
    except OSError as exc:
        raise CountsError(f"cannot read {path.name}: {exc}") from exc


def _load_totals(totals_path: Path) -> dict[str, dict[str, int]]:
    if not totals_path.exists():
        return {}
    try:
        raw = json.loads(totals_path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise CountsError(f"totals unreadable: {exc}") from exc
    if not isinstance(raw, dict):
        raise CountsError("totals file is not an object")
    existing: dict[str, dict[str, int]] = {}
    for day, bucket in raw.items():
        if not isinstance(bucket, dict):
            raise CountsError("totals file has a malformed day")
        try:
            existing[str(day)] = {str(code): int(number) for code, number in bucket.items()}
        except (TypeError, ValueError) as exc:
            raise CountsError(f"totals file has malformed counts: {exc}") from exc
    return existing


def _write_totals(totals_path: Path, merged: Mapping[str, Mapping[str, int]]) -> None:
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
    except OSError as exc:
        raise CountsError(f"cannot write totals: {exc}") from exc
    finally:
        if not handle.closed:
            handle.close()
        if os.path.exists(handle.name):
            os.unlink(handle.name)


def _append_all(target: Path, lines: list[str]) -> None:
    """Append lines atomically; a short write rolls back, never half-dupes."""
    if not lines:
        return
    blob = "".join(line + "\n" for line in lines).encode("utf-8")
    fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)
    try:
        before = os.fstat(fd).st_size
        written = os.write(fd, blob)
        if written != len(blob):
            os.ftruncate(fd, before)
            raise CountsError("could not stage leftover lines")
    finally:
        os.close(fd)


def run(temp_log: Path, totals_path: Path, reopener: Callable[[], None]) -> dict[str, dict[str, int]]:
    """Rotate the temp log aside, fold it by line date, discard it.

    Any leftover rotated log from an interrupted run is folded first, so a
    retry never loses lines. Anything that fails before the totals write
    leaves the rotated file in place for the next run; only a crash between
    the totals write and the final delete can double-count, which is why
    these stay approximate counts.
    """
    rotated = temp_log.with_name(temp_log.name + ".1")
    backlog = _read_lines(rotated) if rotated.exists() else []
    if backlog:
        _append_all(temp_log, backlog)
        rotated.unlink()
    if not temp_log.exists():
        temp_log.write_text("", encoding="utf-8")
    os.replace(temp_log, rotated)
    try:
        reopener()
    except Exception as exc:  # noqa: BLE001 - any reopen failure must fail the run
        raise CountsError(f"log reopen failed: {exc}") from exc
    counts = aggregate_lines(_read_lines(rotated))
    existing = _load_totals(totals_path)
    _write_totals(totals_path, merge_totals(existing, counts))
    rotated.unlink()
    return counts


def _nginx_reopen() -> None:
    subprocess.run(["nginx", "-s", "reopen"], check=True, capture_output=True)


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Aggregate feed country counts.")
    parser.add_argument("--counts", type=Path, required=True, help="Temp count log")
    parser.add_argument("--totals", type=Path, required=True, help="Daily totals JSON")
    parser.add_argument("--no-reopen", action="store_true",
                        help="Skip the log reopen (local validation only)")
    args = parser.parse_args(argv)
    try:
        counts = run(args.counts, args.totals,
                     (lambda: None) if args.no_reopen else _nginx_reopen)
    except CountsError as exc:
        print(f"feed-counts: {exc}", file=sys.stderr)
        return 1
    days = len(counts)
    countries = len({code for bucket in counts.values() for code in bucket})
    total = sum(sum(bucket.values()) for bucket in counts.values())
    print(f"days={days} countries={countries} requests={total}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
