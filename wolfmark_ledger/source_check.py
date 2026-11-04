"""Daily source checker: live catalogue sources against reviewed baselines.

The active catalogue is edited only through the staged revision flow in
``catalogue_revisions``. This module answers a narrower question, once a day in
CI: do the live, parseable sources still say what the reviewed baselines say?

Each parseable source has one committed baseline at
``catalogue/baselines/<source-id>.json``. A baseline is a reviewed snapshot: it
is derived from the approved active catalogue and changes only in a reviewed
commit by an operator. The checker itself never writes into the catalogue
directory. It writes one candidate report (JSON) plus zero or more candidate
baselines, both outside the catalogue tree, for a human to review.

Semantics, in order of safety:

* First run (no baseline file): silent. No changes are reported and nothing
  blocks; a candidate baseline is offered for review when the live source is
  readable.
* Unreviewed changes never become accepted baselines: the checker has no write
  path into ``catalogue/baselines/``, and a committed file whose status is not
  ``reviewed`` is reported as a baseline error, never trusted.
* Unreviewed changes never vanish: the diff is recomputed against the
  unchanged baseline on every run, so an unacknowledged change reappears until
  a reviewed commit accepts it. When a prior report is supplied and a source
  that previously differed is now unreadable, its last-known changes are
  carried forward, marked ``carried_forward``, rather than silently dropped.
* Change detection reuses the existing machinery: ``catalogue_sources`` for
  fetch/observe and ``catalogue_revisions.compare_family`` for the diff, with
  the baseline standing in for the catalogue slice.

Standard library only.
"""

from __future__ import annotations

import argparse
import copy
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

from wolfmark_ledger import catalogue_revisions as R
from wolfmark_ledger import catalogue_sources as S
from wolfmark_ledger import membership as M

BASELINES_DIR_NAME = "baselines"
REVIEWED = "reviewed"
CANDIDATE = "candidate"

# Baseline plan rows keep exactly the fields the diff reads.
BASELINE_PLAN_FIELDS = ("id", "name", "kind", "provider_family", "price",
                        "verification", "billing_arrangement")
BLOCKING_MATERIALITY = ("material", "ambiguous")


def _utcnow() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def baselines_dir(catalogue_dir) -> Path:
    return Path(catalogue_dir) / BASELINES_DIR_NAME


def baseline_path(catalogue_dir, source_id: str) -> Path:
    return baselines_dir(catalogue_dir) / f"{source_id}.json"


def _trim_plan(row: dict) -> dict:
    return {key: copy.deepcopy(row.get(key)) for key in BASELINE_PLAN_FIELDS
            if key in row}


def build_baseline(source: dict, catalogue: dict, *, derived_at=None) -> dict:
    """Build the reviewed baseline for one source from the active catalogue.

    The baseline pins the catalogue's family slice plus provenance. It is a
    pure function of committed files, so generation is reproducible.
    """
    family = source.get("family")
    plans = [_trim_plan(row) for row in catalogue.get("plans", [])
             if row.get("provider_family") == family]
    return {
        "source_id": source.get("id"),
        "family": family,
        "adapter": source.get("adapter"),
        "status": REVIEWED,
        "catalogue_version": catalogue.get("catalogue_version"),
        "derived_at": derived_at or _utcnow(),
        "source_retrieved_at": source.get("retrieved_at"),
        "complete": bool(source.get("complete")),
        "plans": plans,
        "note": ("Reviewed baseline: family slice of catalogue/plans.json. "
                 "Changes only in a reviewed commit."),
    }


def validate_baseline(doc, source: dict) -> list:
    """Return problems with a committed baseline; empty means trustworthy."""
    problems = []
    if not isinstance(doc, dict):
        return ["baseline is not a JSON object"]
    if doc.get("status") != REVIEWED:
        problems.append("baseline status is %r, not %r: an unreviewed "
                        "snapshot must never be trusted" % (doc.get("status"), REVIEWED))
    if doc.get("source_id") != source.get("id"):
        problems.append("baseline source_id %r does not match %r"
                        % (doc.get("source_id"), source.get("id")))
    if doc.get("family") != source.get("family"):
        problems.append("baseline family %r does not match %r"
                        % (doc.get("family"), source.get("family")))
    if not isinstance(doc.get("plans"), list):
        problems.append("baseline plans is not a list")
    return problems


def load_baseline(catalogue_dir, source: dict):
    """Return ``(baseline, problems)``; ``(None, [])`` when no file exists."""
    path = baseline_path(catalogue_dir, source.get("id"))
    if not path.exists():
        return None, []
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        return None, [f"baseline {path.name} is unreadable: {exc}"]
    return doc, validate_baseline(doc, source)


def candidate_from_observation(observation: dict, source: dict, prior=None,
                             transitions=None) -> dict:
    """Propose a baseline from a live observation, for review only.

    Prices and the plan set come from the live page; review metadata (kind,
    verification) carries over from the prior baseline for plans that keep
    their id, so accepting a price move cannot silently reset review state.
    Brand-new plans start provisional. ``transitions`` maps plan ids to the
    verification records the reported changes propose, so accepting a
    candidate acknowledges verification upgrades instead of repeating them.
    When the observation is incomplete, prior rows for unobserved ids are
    kept: a partial page cannot establish a removal.
    """
    sid = source.get("id")
    prior_rows = {}
    if isinstance(prior, dict):
        prior_rows = {row.get("id"): row for row in prior.get("plans", [])
                      if isinstance(row, dict)}
    upgrades = transitions if isinstance(transitions, dict) else {}
    plans = []
    seen = set()
    for plan in observation.get("plans", []):
        row = {"id": plan.get("id"), "name": plan.get("name"),
               "provider_family": source.get("family"),
               "price": copy.deepcopy(plan.get("price"))}
        seen.add(plan.get("id"))
        old = prior_rows.get(plan.get("id"), {})
        if "kind" in old:
            row["kind"] = old["kind"]
        if "billing_arrangement" in old:
            row["billing_arrangement"] = old["billing_arrangement"]
        if plan.get("id") in upgrades:
            row["verification"] = copy.deepcopy(upgrades[plan.get("id")])
        else:
            row["verification"] = copy.deepcopy(
                old.get("verification") or {"status": "provisional", "source_id": sid})
        plans.append(row)
    if not observation.get("complete"):
        for pid, old in prior_rows.items():
            if pid not in seen and isinstance(old, dict):
                plans.append(copy.deepcopy(old))
    return {
        "source_id": sid,
        "family": source.get("family"),
        "adapter": source.get("adapter"),
        "status": CANDIDATE,
        "captured_at": observation.get("retrieved_at"),
        "sha256": observation.get("sha256"),
        "complete": bool(observation.get("complete")),
        "supersedes_catalogue_version": (prior or {}).get("catalogue_version"),
        "plans": plans,
        "note": ("Candidate baseline from a live read. Promote only by a "
                 "reviewed commit that sets status to %r." % REVIEWED),
    }


def _checked_sources(register: dict, families=None, source_ids=None) -> list:
    wanted_families = set(families or [])
    wanted_ids = set(source_ids or [])
    rows = []
    for source in register.get("sources", []):
        if not source.get("parsed"):
            continue
        if wanted_families and source.get("family") not in wanted_families:
            continue
        if wanted_ids and source.get("id") not in wanted_ids:
            continue
        rows.append(source)
    return rows


def _carry_forward(prior: dict, fresh_keys: set, unusable_ids: set) -> list:
    """Re-list prior changes the fresh run can neither confirm nor refute.

    A prior change is carried only when its source was checked and is now
    unreadable. A change whose source reads cleanly and no longer differs has
    genuinely resolved and is dropped.
    """
    if not isinstance(prior, dict):
        return []
    carried = []
    for change in prior.get("changes", []):
        if not isinstance(change, dict) or change.get("key") in fresh_keys:
            continue
        sid = (change.get("evidence") or {}).get("source_id")
        if sid not in unusable_ids:
            continue
        keep = copy.deepcopy(change)
        keep["carried_forward"] = True
        keep["carried_reason"] = ("live source unreadable this run; last "
                                  "known from the prior report")
        carried.append(keep)
    return carried


def check(catalogue_dir, *, offline_dir=None, families=None, source_ids=None,
          prior=None, generated_at=None) -> dict:
    """Compare live sources against committed baselines. Read-only."""
    catalogue_dir = Path(catalogue_dir)
    catalogue = M.load_plan_catalogue(catalogue_dir / "plans.json")
    register = json.loads((catalogue_dir / "sources.json").read_text(encoding="utf-8"))
    sources = _checked_sources(register, families, source_ids)

    entries = []
    fresh = []
    candidates = {}
    errors = []
    unusable_ids = set()
    for source in sources:
        sid = source.get("id")
        snapshot = S.fetch(source, offline_dir=offline_dir)
        observation = S.observe(snapshot, source)
        baseline, problems = load_baseline(catalogue_dir, source)
        if not observation.get("usable"):
            unusable_ids.add(sid)

        entry = {
            "source_id": sid,
            "family": source.get("family"),
            "adapter": source.get("adapter"),
            "status": "unchanged",
            "usable": bool(observation.get("usable")),
            "complete": bool(observation.get("complete")),
            "snapshot_status": snapshot.get("status"),
            "plans_observed": len(observation.get("plans", [])),
            "plans_baselined": None,
            "baseline_catalogue_version": None,
            "baseline_stale": False,
            "changes": [],
            "conflicts": [dict(item) for item in observation.get("conflicts", [])],
            "candidate": False,
            "note": "",
        }

        if problems:
            entry["status"] = "baseline_error"
            entry["note"] = "; ".join(problems)
            errors.append(f"{sid}: {entry['note']}")
        elif baseline is None:
            entry["status"] = "first_run"
            if observation.get("usable"):
                candidates[sid] = candidate_from_observation(observation, source)
                entry["candidate"] = True
                entry["note"] = "no baseline yet; candidate offered for review"
            else:
                entry["note"] = ("no baseline yet and the live source is "
                                 f"unreadable ({snapshot.get('status')})")
        else:
            entry["plans_baselined"] = len(baseline.get("plans", []))
            entry["baseline_catalogue_version"] = baseline.get("catalogue_version")
            entry["baseline_stale"] = (baseline.get("catalogue_version")
                                       != catalogue.get("catalogue_version"))
            changes = []
            if observation.get("usable"):
                pseudo = {"plans": baseline.get("plans", [])}
                changes = R.compare_family(observation, pseudo)
                entry["changes"] = [c["key"] for c in changes]
                fresh.extend(changes)
            else:
                entry["note"] = ("live source unreadable; fresh comparison "
                                 f"skipped ({snapshot.get('status')})")
            if changes:
                entry["status"] = "changed"
                upgrades = {c["plan_id"]: c["after"] for c in changes
                            if c.get("action") == "verification_changed"
                            and isinstance(c.get("after"), dict)}
                candidates[sid] = candidate_from_observation(
                    observation, source, prior=baseline,
                    transitions=upgrades)
                entry["candidate"] = True
                entry["note"] = ("%d change(s); candidate offered for "
                                 "review" % len(changes))
            elif observation.get("usable"):
                entry["note"] = "matches the reviewed baseline"
        entries.append(entry)

    fresh_keys = {c["key"] for c in fresh}
    carried = _carry_forward(prior, fresh_keys, unusable_ids)
    changes = fresh + carried
    blocking = sorted({c["key"] for c in changes
                       if c.get("materiality") in BLOCKING_MATERIALITY})
    counts = {"material": 0, "ambiguous": 0, "review": 0, "cosmetic": 0,
              "carried_forward": len(carried)}
    for change in changes:
        if change.get("materiality") in counts:
            counts[change["materiality"]] += 1
    return {
        "generated_at": generated_at or _utcnow(),
        "catalogue_version": catalogue.get("catalogue_version"),
        "offline": offline_dir is not None,
        "families": sorted({e["family"] for e in entries}),
        "sources": entries,
        "changes": changes,
        "counts": counts,
        "blocking": blocking,
        "requires_owner": bool(blocking or errors),
        "errors": errors,
        "candidates": candidates,
    }


def write_report(report: dict, out_path) -> Path:
    out = Path(out_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return out


def write_candidates(report: dict, candidates_dir) -> list:
    """Write each candidate baseline as a reviewable file. Returns paths."""
    written = []
    if not report.get("candidates"):
        return written
    target = Path(candidates_dir)
    target.mkdir(parents=True, exist_ok=True)
    for sid in sorted(report["candidates"]):
        path = target / f"{sid}.json"
        path.write_text(json.dumps(report["candidates"][sid], indent=2, sort_keys=True)
                        + "\n", encoding="utf-8")
        written.append(path)
    return written


def _summary(report: dict) -> str:
    lines = [f"source check {report['generated_at']} "
             f"(catalogue {report['catalogue_version']}"
             f"{', fixtures' if report['offline'] else ''})"]
    for entry in report["sources"]:
        lines.append(f"  {entry['source_id']}: {entry['status']} -- {entry['note']}")
    if report["errors"]:
        lines.append("errors:")
        lines.extend(f"  - {error}" for error in report["errors"])
    if report["changes"]:
        lines.append("changes:")
        for change in report["changes"]:
            carried = " [carried forward]" if change.get("carried_forward") else ""
            lines.append(f"  - [{change['materiality']}] {change['key']}{carried}")
            lines.append(f"    {change['summary']}")
    else:
        lines.append("no changes against the reviewed baselines")
    conflicts = [(entry["source_id"], conflict)
                 for entry in report["sources"]
                 for conflict in entry.get("conflicts", [])]
    if conflicts:
        lines.append("conflicts within live sources:")
        for sid, conflict in conflicts:
            lines.append(f"  - {sid} {conflict.get('plan_id')}: {conflict.get('note')}")
    if report["blocking"]:
        lines.append("blocking: " + ", ".join(report["blocking"]))
    lines.append("owner review required" if report["requires_owner"]
                 else "no owner review required")
    return "\n".join(lines)


def _console_text(text: str) -> str:
    """Render report text for the terminal without breaking narrow encodings.

    The JSON report always keeps full Unicode; only console output is
    downgraded, so a cp1252 Windows console cannot fail the run.
    """
    encoding = getattr(sys.stdout, "encoding", None) or "utf-8"
    try:
        text.encode(encoding)
    except (UnicodeEncodeError, LookupError):
        return text.replace("\u2192", "->").encode(encoding, "replace").decode(encoding)
    return text


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        description="Diff live catalogue sources against reviewed baselines.")
    parser.add_argument("--catalogue-dir", default=None)
    parser.add_argument("--fixtures", default=None,
                        help="offline fixtures directory (no network)")
    parser.add_argument("--family", action="append", default=None)
    parser.add_argument("--sources", default=None,
                        help="comma-separated source ids to check")
    parser.add_argument("--prior", default=None,
                        help="prior candidate report, to carry forward diffs")
    parser.add_argument("--out", default=None, help="write the report JSON here")
    parser.add_argument("--candidates-dir", default=None)
    parser.add_argument("--no-candidates", action="store_true")
    args = parser.parse_args(argv)

    root = Path(__file__).resolve().parent.parent
    catalogue_dir = Path(args.catalogue_dir) if args.catalogue_dir else root / "catalogue"
    try:
        prior = None
        if args.prior:
            prior = json.loads(Path(args.prior).read_text(encoding="utf-8"))
        report = check(
            catalogue_dir,
            offline_dir=Path(args.fixtures) if args.fixtures else None,
            families=args.family,
            source_ids=args.sources.split(",") if args.sources else None,
            prior=prior,
        )
        if args.out:
            out = write_report(report, args.out)
            if not args.no_candidates:
                where = (Path(args.candidates_dir) if args.candidates_dir
                         else out.parent / "candidates")
                write_candidates(report, where)
    except (OSError, ValueError) as exc:
        print(f"source-check: {exc}", file=sys.stderr)
        return 2
    print(_console_text(_summary(report)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
