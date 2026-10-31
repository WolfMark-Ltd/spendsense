#!/usr/bin/env python3
"""Catalogue maintenance: check sources, stage a revision, review, approve, activate.

Nothing here schedules itself, and no command except ``activate``/``rollback``
writes the active catalogue. Personal fee overrides live in ``memberships.json``
and are never read or written by this tool.

    # Compare the approved catalogue with what the sources currently say
    python3 scripts/catalogue-maintain.py --fixtures test/fixtures/catalogue/demo-change check

    # Stage it (writes catalogue/revisions/<id>.json, active file untouched)
    python3 scripts/catalogue-maintain.py --fixtures … stage --note "October price review"

    # Read the diff, then decide every blocking change
    python3 scripts/catalogue-maintain.py review rev-…
    python3 scripts/catalogue-maintain.py approve rev-… --by mark \
        --accept price_changed:opencode-go.go --reject plan_removed:commandcode.team-pro

    # Promote, or roll back a version
    python3 scripts/catalogue-maintain.py activate rev-… --by mark [--dry-run]
    python3 scripts/catalogue-maintain.py rollback 2026-10-30.3 --by mark [--dry-run]

Without ``--fixtures`` the sources are fetched over the network; a source the
register marks ``not_fetched`` is skipped and reported, never guessed at.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from wolfmark_ledger import catalogue_revisions as revisions  # noqa: E402
from wolfmark_ledger import catalogue_sources as sources  # noqa: E402
from wolfmark_ledger import membership as mem  # noqa: E402


def _catalogue_dir(args) -> Path:
    return Path(args.catalogue_dir) if args.catalogue_dir else ROOT / "catalogue"


def _observe(args) -> tuple[list[dict], list[dict], dict]:
    register = sources.load_sources(Path(args.sources) if args.sources else None)
    snapshots, observations = [], []
    for source in register.get("sources", []):
        if args.family and str(source.get("family")) != args.family:
            continue
        if str(source.get("adapter")) == "manual":
            continue
        snapshot = sources.fetch(source, offline_dir=args.fixtures)
        snapshots.append(snapshot)
        observations.append(sources.observe(snapshot, source))
    return snapshots, observations, register


def _print_diff(report: dict) -> None:
    counts = report.get("counts") or {}
    print(f"{len(report.get('changes') or [])} change(s): "
          f"{counts.get('material', 0)} material, {counts.get('ambiguous', 0)} ambiguous, "
          f"{counts.get('review', 0)} review, {counts.get('cosmetic', 0)} cosmetic")
    for change in report.get("changes") or []:
        mark = {"material": "!", "ambiguous": "?", "review": "+", "cosmetic": "·"}.get(change["materiality"], "-")
        print(f"  [{mark}] {change['key']:<48} {change['summary']}")
    if report.get("blocking"):
        print(f"\n{len(report['blocking'])} blocking change(s) need a recorded decision:")
        for key in report["blocking"]:
            print(f"  - {key}")
    else:
        print("\nNothing blocking: only additions or cosmetic changes.")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--catalogue-dir", help="catalogue directory (default: ./catalogue)")
    parser.add_argument("--fixtures", help="read source snapshots from this directory instead of the network")
    parser.add_argument("--sources", help="path to sources.json")
    parser.add_argument("--family", help="restrict the check to one family")
    parser.add_argument("--json", action="store_true", help="machine-readable output")
    sub = parser.add_subparsers(dest="command", required=True)

    check_p = sub.add_parser("check", help="fetch, observe and diff; writes nothing")
    check_p.add_argument("--out", help="also write the JSON payload to this path (used by the timer)")
    stage_p = sub.add_parser("stage", help="write a staged revision; active catalogue untouched")
    stage_p.add_argument("--note", default="")
    stage_p.add_argument("--corrections", help="JSON file of authored corrections "
                                              "(catalogue/corrections/*.json)")
    stage_p.add_argument("--with-observations", action="store_true",
                         help="with --corrections, also include the live source diff")
    stage_p.add_argument("--version", help="proposed version (default: next counter)")
    sub.add_parser("status", help="active version, revisions and archives")

    review_p = sub.add_parser("review", help="print a revision's diff")
    review_p.add_argument("revision_id")

    validate_p = sub.add_parser("validate", help="run the activation checks")
    validate_p.add_argument("revision_id")

    approve_p = sub.add_parser("approve", help="record decisions for a revision")
    approve_p.add_argument("revision_id")
    approve_p.add_argument("--by", required=True)
    approve_p.add_argument("--accept", action="append", default=[], metavar="KEY")
    approve_p.add_argument("--reject", action="append", default=[], metavar="KEY")
    approve_p.add_argument("--note", default="")

    activate_p = sub.add_parser("activate", help="promote an approved revision")
    activate_p.add_argument("revision_id")
    activate_p.add_argument("--by", required=True)
    activate_p.add_argument("--dry-run", action="store_true")

    rollback_p = sub.add_parser("rollback", help="restore an archived version")
    rollback_p.add_argument("version")
    rollback_p.add_argument("--by", required=True)
    rollback_p.add_argument("--reason", default="")
    rollback_p.add_argument("--dry-run", action="store_true")

    args = parser.parse_args(argv)
    cdir = _catalogue_dir(args)
    active = mem.load_plan_catalogue(cdir / "plans.json")

    if args.command == "check":
        snapshots, observations, register = _observe(args)
        report = revisions.diff_report(observations, active)
        payload = {"active_version": active.get("catalogue_version"),
                   "sources_read": len(snapshots), "observations": observations, "diff": report,
                   "register_error": register.get("error", "")}
        if args.out:
            target = Path(args.out)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(json.dumps(payload, indent=2, default=str) + "\n")
        if args.json:
            print(json.dumps(payload, indent=2, default=str))
        else:
            print(f"active catalogue {active.get('catalogue_version')} · "
                  f"{len(snapshots)} source(s) read from "
                  f"{'fixtures ' + args.fixtures if args.fixtures else 'the network'}\n")
            for observed in observations:
                state = "usable" if observed.get("usable") else "not usable"
                print(f"  {observed.get('source_id')}: {len(observed.get('plans') or [])} plan(s), {state}")
                for note in observed.get("notes") or []:
                    print(f"    · {note}")
            print()
            _print_diff(report)
        return 0

    if args.command == "stage":
        corrections = []
        if args.corrections and not args.with_observations:
            # A corrections revision is about authored judgments; the source
            # observations belong in their own revision so each is reviewable.
            snapshots, observations = [], []
        else:
            snapshots, observations, _ = _observe(args)
        if args.corrections:
            payload = json.loads(Path(args.corrections).read_text())
            corrections = list(payload.get("corrections") or [])
        if not any(o.get("usable") for o in observations) and not corrections:
            print("No usable observation and no corrections: nothing to stage.", file=sys.stderr)
            return 2
        revision = revisions.stage(cdir, active, observations, snapshots, note=args.note,
                                   version=args.version, corrections=corrections)
        if args.json:
            print(json.dumps(revisions.review(revision), indent=2, default=str))
        else:
            print(f"staged {revision['revision_id']} "
                  f"({revision['base_version']} → {revision['proposed_version']}); active catalogue unchanged\n")
            _print_diff(revision["diff"])
        return 0

    if args.command == "status":
        print(json.dumps(revisions.status(cdir), indent=2, default=str))
        return 0

    if args.command == "review":
        revision = revisions.load_revision(cdir, args.revision_id)
        payload = revisions.review(revision)
        if args.json:
            print(json.dumps(payload, indent=2, default=str))
            return 0
        print(f"{payload['revision_id']} · {payload['status']} · "
              f"{payload['base_version']} → {payload['proposed_version']}")
        print(f"{len(payload['changes'])} change(s): " +
              ", ".join(f"{k}={v}" for k, v in (payload.get('counts') or {}).items()))
        for change in payload["changes"]:
            decided = f" [{change['decided']}]" if change.get("decided") else ""
            print(f"  [{change['materiality']}] {change['key']}{decided}\n      {change['summary']}")
            if change.get("evidence"):
                print(f"      evidence: {change['evidence'].get('source_id')} "
                      f"{change['evidence'].get('url')}")
        print("\n" + payload["note"])
        return 0

    if args.command == "validate":
        revision = revisions.load_revision(cdir, args.revision_id)
        problems = revisions.validate(revision, active)
        print("PASS — revision can be activated" if not problems else "FAIL")
        for problem in problems:
            print(" -", problem)
        return 0 if not problems else 1

    if args.command == "approve":
        decisions = {key: "accept" for key in args.accept}
        decisions.update({key: "reject" for key in args.reject})
        try:
            revision = revisions.approve(cdir, args.revision_id, decisions, by=args.by, note=args.note,
                                         catalogue=active)
        except ValueError as exc:
            print(f"cannot record decisions: {exc}", file=sys.stderr)
            return 2
        if args.json:
            print(json.dumps(revisions.review(revision), indent=2, default=str))
            return 0
        print(f"{revision['revision_id']} is {revision['status']}")
        for entry in revision.get("approvals") or []:
            print(f"  {entry['by']} at {entry['at']}"
                  + ("" if entry["complete"] else f" — still outstanding: {', '.join(entry['outstanding'])}"))
        if revision.get("validation") and not revision["validation"]["ok"]:
            print("\nvalidation problems:")
            for problem in revision["validation"]["problems"]:
                print(" -", problem)
            return 1
        print("\nvalidated: activate when ready.")
        return 0

    if args.command == "activate":
        try:
            result = revisions.activate(cdir, args.revision_id, by=args.by, dry_run=args.dry_run,
                                        catalogue=active)
        except (ValueError, KeyError) as exc:
            print(f"cannot activate: {exc}", file=sys.stderr)
            return 2
        verb = "would activate" if args.dry_run else "activated"
        print(f"{verb} {result['revision_id']}: {result['from_version']} → {result['to_version']} "
              f"({result['changes']} change(s))")
        if result.get("archive"):
            print(f"previous catalogue archived at {result['archive']}")
        return 0

    if args.command == "rollback":
        try:
            result = revisions.rollback(cdir, args.version, by=args.by, dry_run=args.dry_run,
                                        reason=args.reason)
        except KeyError as exc:
            print(str(exc), file=sys.stderr)
            return 2
        verb = "would roll back" if args.dry_run else "rolled back"
        print(f"{verb}: {result['from_version']} → {result['to_version']} (revision {result['revision_id']})")
        return 0

    return 2


if __name__ == "__main__":
    raise SystemExit(main())
