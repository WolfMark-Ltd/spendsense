"""Staged catalogue revisions: diff, review, approve, activate, roll back.

The active catalogue is ``catalogue/plans.json``. A *revision* is a document
under ``catalogue/revisions/`` holding what was observed, what would change and
who decided. Activation is the only function that writes the active file, and it
refuses unless the revision passed validation and every blocking change carries a
recorded decision.

Personal fee overrides live in ``memberships.json`` and are never read or written
here, so a catalogue refresh cannot reprice an account even by accident.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Mapping, Optional

from . import catalogue_sources as sources_mod
from . import membership as mem

REVISIONS_DIR = "revisions"
HISTORY_DIR = "history"

#: Materiality by change kind. Anything except cosmetic blocks activation until
#: the owner decides.
MATERIALITY = {
    "price_changed": "material",
    "currency_changed": "material",
    "period_changed": "material",
    "allowance_changed": "material",
    "window_changed": "material",
    "restrictions_changed": "material",
    "access_changed": "material",
    "plan_removed": "material",
    "retired": "material",
    "plan_added": "review",
    "verification_changed": "review",
    "name_changed": "cosmetic",
    "notes_changed": "cosmetic",
}


#: Fields a correction may touch, with the class of change each represents.
#: A correction is an authored change with cited evidence, used where no parser
#: can produce the observation (a plan reclassified, a source that cannot price).
CORRECTION_FIELDS = {
    "kind": "material",
    "billing_arrangement": "material",
    "name": "cosmetic",
    "source_id": "material",
    "verification_note": "review",
    "price": "material",
    "access": "material",
    "model_restrictions": "material",
}


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:12]


# ---------------------------------------------------------------------------
# Diff
# ---------------------------------------------------------------------------

def _money(value: Any) -> Optional[float]:
    if value is None or isinstance(value, bool):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _change(plan_id: str, family: str, action: str, *, before: Any = None, after: Any = None,
            evidence: Mapping[str, Any] | None = None, summary: str = "", materiality: Optional[str] = None) -> dict:
    return {
        "key": f"{action}:{plan_id}",
        "plan_id": plan_id,
        "family": family,
        "action": action,
        "materiality": materiality or MATERIALITY.get(action, "review"),
        "before": before,
        "after": after,
        "evidence": dict(evidence or {}),
        "summary": summary,
    }


def _name(value: Any) -> str:
    return str(value or "").replace("×", "x").strip().lower()


def _price_text(price: Mapping[str, Any] | None) -> str:
    price = price or {}
    amount = price.get("amount")
    if amount is None:
        return "no published price"
    currency = price.get("currency") or "USD"
    period = price.get("period") or "month"
    return f"{amount:g} {currency}/{period}"


def compare_family(observed: Mapping[str, Any], catalogue: Mapping[str, Any]) -> list[dict[str, Any]]:
    """Changes for one family between an observation and the approved catalogue."""
    family = str(observed.get("family") or "")
    evidence = {"source_id": observed.get("source_id"), "url": observed.get("url"),
                "retrieved_at": observed.get("retrieved_at"), "sha256": observed.get("sha256")}
    approved = {p["id"]: p for p in (catalogue.get("plans") or []) if p.get("provider_family") == family}
    seen: set[str] = set()
    t = seen
    changes: list[dict[str, Any]] = []

    for row in observed.get("plans") or []:
        pid = str(row.get("id") or "")
        if not pid:
            continue
        seen.add(pid)
        current = approved.get(pid)
        observed_price = {k: (row.get("price") or {}).get(k) for k in ("amount", "currency", "period")}
        if current is None:
            changes.append(_change(pid, family, "plan_added",
                                   after={"name": row.get("name"), "price": observed_price},
                                   evidence=evidence,
                                   summary=f"New plan {row.get('name')} at {_price_text(observed_price)}"))
            continue
        current_price = {k: (current.get("price") or {}).get(k) for k in ("amount", "currency", "period")}
        if _money(observed_price["amount"]) != _money(current_price["amount"]):
            changes.append(_change(pid, family, "price_changed", before=current_price, after=observed_price,
                                   evidence=evidence,
                                   summary=f"{current.get('name')}: {_price_text(current_price)} → "
                                           f"{_price_text(observed_price)}"))
        for field, action in (("currency", "currency_changed"), ("period", "period_changed")):
            if observed_price[field] != current_price[field] and _money(observed_price["amount"]) is not None:
                changes.append(_change(pid, family, action, before=current_price.get(field),
                                       after=observed_price.get(field), evidence=evidence,
                                       summary=f"{current.get('name')}: {field} {current_price.get(field)} → "
                                               f"{observed_price.get(field)}"))
        # "Max 10×" and "Max 10x" are the same plan; only a real rename is cosmetic news.
        status = str((current.get("verification") or {}).get("status"))
        corroborated = (not observed.get("provisional") and _money(observed_price["amount"]) is not None
                        and _money(observed_price["amount"]) == _money(current_price["amount"])
                        and observed_price["currency"] == current_price["currency"]
                        and observed_price["period"] == current_price["period"])
        if corroborated and status in ("provisional", "unverified"):
            # The page now states the price we already hold, so the record can
            # move from provisional to verified — with today's evidence.
            t.add(f"verification_changed:{pid}")
            changes.append(_change(
                pid, family, "verification_changed",
                before={"status": status, "checked_at": (current.get("verification") or {}).get("checked_at")},
                after={"status": "verified",
                       "checked_at": str((observed.get("retrieved_at") or ""))[:10] or None,
                       "source_id": observed.get("source_id")},
                evidence=evidence,
                summary=f"{current.get('name')}: {status} → verified from {observed.get('source_id')}",
                materiality="review"))

        if row.get("name") and _name(row["name"]) != _name(current.get("name")):
            changes.append(_change(pid, family, "name_changed", before=current.get("name"), after=row["name"],
                                   evidence=evidence,
                                   summary=f"Plan renamed: {current.get('name')} → {row['name']}",
                                   materiality="cosmetic"))

    custom_quoted = {str(x) for x in (observed.get("custom_quote_plans") or [])}
    for pid, plan in sorted(approved.items()):
        if pid in seen:
            continue
        if str((plan.get("verification") or {}).get("status")) == "retired":
            continue
        if pid in custom_quoted:
            # Sold by quote, so the table can never list it. Recorded as a source
            # property by observe(), not re-reported as a change on every run.
            continue
        ambiguous = not observed.get("complete")
        changes.append(_change(
            pid, family, "plan_removed",
            before={"name": plan.get("name"), "price": plan.get("price")},
            evidence=evidence,
            summary=(f"{plan.get('name')} is absent from {observed.get('source_id')}"
                     + (" — that source does not enumerate the whole family, so this may be incomplete"
                        if ambiguous else "")),
            materiality="ambiguous" if ambiguous else "material"))

    if observed.get("provisional"):
        for change in changes:
            if change["materiality"] in ("material", "review"):
                change["materiality"] = "ambiguous"
                change["summary"] += " (source marked provisional in the register)"
    return changes


def diff_report(observations: Iterable[Mapping[str, Any]], catalogue: Mapping[str, Any]) -> dict[str, Any]:
    changes: list[dict[str, Any]] = []
    for observed in observations:
        changes.extend(compare_family(observed, catalogue))
    changes.sort(key=lambda c: (c["family"], c["plan_id"], c["action"]))
    counts = {"material": 0, "ambiguous": 0, "review": 0, "cosmetic": 0}
    for change in changes:
        counts[change["materiality"]] = counts.get(change["materiality"], 0) + 1
    blocking = [c["key"] for c in changes if c["materiality"] in ("material", "ambiguous")]
    return {"changes": changes, "counts": counts, "blocking": blocking,
            "requires_owner": bool(blocking)}


# ---------------------------------------------------------------------------
# Candidate construction
# ---------------------------------------------------------------------------

def build_candidate(catalogue: Mapping[str, Any], observations: Iterable[Mapping[str, Any]],
                    report: Mapping[str, Any], decisions: Mapping[str, str],
                    *, version: str) -> dict[str, Any]:
    """Apply accepted changes to a copy of the catalogue.

    A rejected (or undecided) material change keeps the approved value: the
    candidate is assembled from decisions, not from whatever the page said.
    """
    plans = {p["id"]: json.loads(json.dumps(p)) for p in catalogue.get("plans") or []}
    families = {str(o.get("family")): o for o in observations}
    accepted = {k for k, v in (decisions or {}).items() if str(v).lower() == "accept"}
    price_checks: dict[str, dict[str, Any]] = {}
    changes_by_plan: dict[str, list[dict[str, Any]]] = {}
    for item in report.get("changes") or []:
        changes_by_plan.setdefault(str(item.get("plan_id")), []).append(item)

    for change in report.get("changes") or []:
        pid = change["plan_id"]
        action = change["action"]
        if change["materiality"] in ("material", "ambiguous") and change["key"] not in accepted:
            continue
        if change["materiality"] in ("cosmetic", "review") and str((decisions or {}).get(change["key"], "accept")).lower() == "reject":
            continue
        evidence_source = (change.get("evidence") or {}).get("source_id")
        if action == "plan_removed":
            plans.pop(pid, None)
        elif action == "plan_added":
            observed = next((r for r in families.get(change["family"], {}).get("plans") or []
                             if r.get("id") == pid), None)
            if observed:
                plans[pid] = {
                    "id": pid, "provider_family": change["family"], "route_slugs": [change["family"]],
                    "name": observed.get("name") or pid, "kind": "subscription",
                    "price": observed.get("price") or {"amount": None, "currency": None, "period": "month"},
                    "billing_cycle": {"anchor_day": None, "period": (observed.get("price") or {}).get("period") or "month"},
                    "entitlements": {"verification": {"status": "unverified", "source_id": evidence_source,
                                                      "checked_at": None,
                                                      "notes": "Added by a catalogue revision; entitlements not yet captured."},
                                     "windows": [], "models": {}, "reset_policy": {}},
                    "verification": {"status": "unverified", "checked_at": None, "source_id": evidence_source,
                                     "notes": "Added by a catalogue revision; review the price before verifying."},
                    "access": {"cli": None, "provider_api": None},
                    "effective_from": None, "effective_to": None, "model_restrictions": [],
                    "notes": "New plan observed by the catalogue check.",
                }
        elif action.endswith("_changed") and pid in plans and action not in ("price_changed", "currency_changed", "period_changed"):
            row = plans[pid]
            field = action[:-len("_changed")]
            if field == "kind":
                row["kind"] = change.get("after")
            elif field == "billing_arrangement":
                row["billing_arrangement"] = change.get("after")
            elif field == "name":
                row["name"] = change.get("after")
            elif field == "source_id":
                row["verification"] = {**row.get("verification", {}), "source_id": change.get("after"),
                                       "checked_at": None,
                                       # The old verification was against the old page.
                                       "status": "unverified"}
            elif field == "verification":
                row["verification"] = {**(row.get("verification") or {}),
                                       **(change.get("after") or {})}
            elif field == "verification_note":
                row["verification"] = {**row.get("verification", {}), "notes": change.get("after")}
            elif field in ("access", "model_restrictions"):
                row[field] = change.get("after")
        elif pid in plans:
            row = plans[pid]
            if action == "price_changed":
                after = change.get("after") or {}
                price = {**(row.get("price") or {}), "amount": after.get("amount")}
                before = change.get("before") or {}
                authored = bool(change.get("authored")) or (
                    isinstance(before, dict)
                    and _money(before.get("amount")) is None
                    and _money(after.get("amount")) is None)
                if authored or _money(after.get("amount")) is not None:
                    separate_actions = {item.get("action") for item in changes_by_plan.get(pid, [])}
                    for field, field_action in (("currency", "currency_changed"), ("period", "period_changed")):
                        if field_action not in separate_actions and field in after:
                            price[field] = after[field]
                row["price"] = price
                price_checks[pid] = change
            elif action in ("currency_changed", "period_changed"):
                field = "currency" if action == "currency_changed" else "period"
                row["price"] = {**(row.get("price") or {}), field: change.get("after")}
                price_checks.setdefault(pid, change)
            elif action == "name_changed":
                row["name"] = change.get("after") or row["name"]

    for pid, change in price_checks.items():
        row = plans.get(pid)
        if row is None:
            continue
        observation = families.get(str(change.get("family")))
        observed_row = next((item for item in (observation or {}).get("plans") or []
                             if item.get("id") == pid), None)
        observed_price = observed_row.get("price") if observed_row else None
        corroborated = (observed_price is not None and not (observation or {}).get("provisional")
                        and _money(observed_price.get("amount")) is not None
                        and all(row["price"].get(field) == observed_price.get(field)
                                for field in ("amount", "currency", "period")))
        evidence_source = ((change.get("evidence") or {}).get("source_id")
                           or (observation or {}).get("source_id"))
        checked_at = str((observation or {}).get("retrieved_at") or
                         (change.get("evidence") or {}).get("retrieved_at") or "")[:10]
        row["verification"] = {**(row.get("verification") or {}),
                                "status": "verified" if corroborated else "unverified",
                                "checked_at": checked_at if corroborated else None,
                                "source_id": evidence_source,
                                "notes": (f"Price matches the accepted evidence from {evidence_source}."
                                          if corroborated else
                                          "Accepted price terms remain unverified; confirm the complete price.")}

    candidate = json.loads(json.dumps(catalogue))
    candidate["plans"] = sorted(plans.values(), key=lambda p: p["id"])
    candidate["catalogue_version"] = version
    candidate["generated_at"] = now_iso()
    candidate.setdefault("notes", [])
    candidate["notes"] = [*candidate["notes"],
                          f"{version}: staged by catalogue-maintain; {len(accepted)} accepted change(s)."]
    return candidate


# ---------------------------------------------------------------------------
# Revision store
# ---------------------------------------------------------------------------

def revisions_dir(catalogue_dir: Path | str) -> Path:
    return Path(catalogue_dir) / REVISIONS_DIR


def history_dir(catalogue_dir: Path | str) -> Path:
    return Path(catalogue_dir) / HISTORY_DIR


def list_revisions(catalogue_dir: Path | str) -> list[dict[str, Any]]:
    out = []
    for path in sorted(revisions_dir(catalogue_dir).glob("rev-*.json")):
        try:
            out.append(json.loads(path.read_text()))
        except (OSError, ValueError):
            continue
    return sorted(out, key=lambda r: str(r.get("created_at")), reverse=True)


def load_revision(catalogue_dir: Path | str, revision_id: str) -> dict[str, Any]:
    path = revisions_dir(catalogue_dir) / f"{revision_id}.json"
    if not path.exists():
        raise KeyError(revision_id)
    return json.loads(path.read_text())


def _write_json(path: Path, payload: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    handle = tempfile.NamedTemporaryFile("w", dir=path.parent, delete=False, suffix=".tmp")
    try:
        json.dump(payload, handle, indent=2, sort_keys=True)
        handle.flush()
        os.fsync(handle.fileno())
        handle.close()
        os.replace(handle.name, path)
    finally:
        if not handle.closed:
            handle.close()


def correction_report(catalogue: Mapping[str, Any], corrections: list[dict[str, Any]]) -> dict[str, Any]:
    """Diff authored corrections against the approved catalogue."""
    plans = {p["id"]: p for p in catalogue.get("plans") or []}
    changes = []
    for correction in corrections:
        plan_id = str(correction.get("plan_id") or "")
        field = str(correction.get("field") or "")
        if field not in CORRECTION_FIELDS:
            raise ValueError(f"{plan_id}: unknown correction field {field!r}")
        plan = plans.get(plan_id)
        if plan is None:
            raise ValueError(f"correction targets unknown plan {plan_id!r}")
        if not str(correction.get("why") or "").strip():
            raise ValueError(f"{plan_id}.{field}: a correction needs a reason")
        before = _field_value(plan, field)
        after = correction.get("value")
        if before == after:
            continue
        evidence = dict(correction.get("evidence") or {})
        if not evidence.get("source_id"):
            evidence["source_id"] = (plan.get("verification") or {}).get("source_id")
        authored_change = _change(
            plan_id, str(plan.get("provider_family")), f"{field}_changed",
            before=before, after=after, evidence=evidence,
            summary=f"{plan.get('name') or plan_id}: {field} {before!r} → {after!r} — {correction['why']}",
            materiality=CORRECTION_FIELDS[field])
        authored_change["authored"] = True
        changes.append(authored_change)
    changes.sort(key=lambda c: (c["family"], c["plan_id"], c["action"]))
    counts = {"material": 0, "ambiguous": 0, "review": 0, "cosmetic": 0}
    for change in changes:
        counts[change["materiality"]] = counts.get(change["materiality"], 0) + 1
    blocking = [c["key"] for c in changes if c["materiality"] in ("material", "ambiguous")]
    return {"changes": changes, "counts": counts, "blocking": blocking,
            "requires_owner": bool(blocking)}


def _field_value(plan: Mapping[str, Any], field: str) -> Any:
    if field == "kind":
        return plan.get("kind")
    if field == "billing_arrangement":
        return plan.get("billing_arrangement")
    if field == "name":
        return plan.get("name")
    if field == "source_id":
        return (plan.get("verification") or {}).get("source_id")
    if field == "verification_note":
        return (plan.get("verification") or {}).get("notes") or ""
    if field == "price":
        return {k: (plan.get("price") or {}).get(k) for k in ("amount", "currency", "period")}
    return plan.get(field)


def stage(catalogue_dir: Path | str, catalogue: Mapping[str, Any], observations: list[dict[str, Any]],
          snapshots: list[dict[str, Any]], *, note: str = "", version: Optional[str] = None,
          corrections: Optional[list[dict[str, Any]]] = None) -> dict[str, Any]:
    """Write a staged revision. Never touches the active catalogue."""
    corrections = list(corrections or [])
    if corrections:
        authored = correction_report(catalogue, corrections)
        observed = diff_report(observations, catalogue)
        merged = {c["key"]: c for c in observed["changes"]}
        merged.update({c["key"]: c for c in authored["changes"]})
        changes = sorted(merged.values(), key=lambda c: (c["family"], c["plan_id"], c["action"]))
        counts = {"material": 0, "ambiguous": 0, "review": 0, "cosmetic": 0}
        for change in changes:
            counts[change["materiality"]] = counts.get(change["materiality"], 0) + 1
        report = {"changes": changes, "counts": counts,
                  "blocking": [c["key"] for c in changes if c["materiality"] in ("material", "ambiguous")],
                  "requires_owner": any(c["materiality"] in ("material", "ambiguous") for c in changes)}
    else:
        report = diff_report(observations, catalogue)
    base_version = str(catalogue.get("catalogue_version") or "")
    next_version = version or next_catalogue_version(base_version, catalogue_dir)
    revision_id = f"rev-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}-{_sha(json.dumps(report['changes'], sort_keys=True, default=str))}"
    revision = {
        "revision_id": revision_id,
        "created_at": now_iso(),
        "status": "staged",
        "note": note,
        "base_version": base_version,
        "proposed_version": next_version,
        "sources": [{k: s.get(k) for k in ("source_id", "url", "retrieved_at", "http_status", "status", "sha256")}
                    for s in snapshots],
        "observations": observations,
        "corrections": corrections,
        "diff": report,
        "decisions": {},
        "approvals": [],
        "applied_version": None,
        "history": [],
    }
    _write_json(revisions_dir(catalogue_dir) / f"{revision_id}.json", revision)
    return revision


def _version_key(version: str) -> tuple[str, int]:
    head, _, tail = str(version).rpartition(".")
    if head and tail.isdigit():
        return (head, int(tail))
    return (str(version), 0)


def _bump_version(version: str) -> str:
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    if not version:
        return f"{today}.1"
    head, _, tail = str(version).rpartition(".")
    if head and tail.isdigit():
        return f"{head}.{int(tail) + 1}"
    return f"{today}.1"


def next_catalogue_version(version: str, catalogue_dir: Any = None,
                           archived_versions: Optional[Iterable[str]] = None) -> str:
    """Bump the trailing counter: 2026-10-30.3 → 2026-10-30.4, else today.1.

    Archived versions under ``history/`` count too: if the highest archived
    version exceeds the active one, advance past it instead of reusing a
    version that already has a history file.
    """
    archived: list[str] = []
    if archived_versions:
        archived.extend(str(v) for v in archived_versions)
    if catalogue_dir is not None:
        if isinstance(catalogue_dir, (list, tuple, set)):
            archived.extend(str(v) for v in catalogue_dir)
        else:
            try:
                hist = history_dir(catalogue_dir)
                if hist.is_dir():
                    for path in hist.glob("plans-*.json"):
                        archived.append(path.name)
            except Exception:
                pass
    cleaned: list[str] = []
    for entry in archived:
        name = str(entry).rsplit("/", 1)[-1]
        if name.endswith(".json"):
            name = name[:-len(".json")]
        if name.startswith("plans-"):
            name = name[len("plans-"):]
        if name and name != "unknown":
            cleaned.append(name)
    if cleaned:
        highest = max(cleaned, key=_version_key)
        if not version or _version_key(highest) > _version_key(version):
            return _bump_version(highest)
    return _bump_version(version)


# ---------------------------------------------------------------------------
# Validate / review / approve
# ---------------------------------------------------------------------------

def validate(revision: Mapping[str, Any], catalogue: Mapping[str, Any],
             decisions: Mapping[str, str] | None = None) -> list[str]:
    """Everything that must hold before a revision may be activated."""
    problems: list[str] = []
    decisions = {str(k): str(v).lower() for k, v in (decisions if decisions is not None
                                                     else revision.get("decisions") or {}).items()}
    report = revision.get("diff") or {}
    for key in report.get("blocking") or []:
        verdict = decisions.get(key)
        if verdict not in ("accept", "reject"):
            problems.append(f"{key}: no decision recorded (accept or reject)")
    if str(revision.get("status")) not in ("staged", "approved"):
        problems.append(f"revision status is {revision.get('status')!r}")
    usable = [o for o in revision.get("observations") or [] if o.get("usable")]
    if not revision.get("observations") and not revision.get("corrections"):
        problems.append("no observations were captured")
    elif not usable and not revision.get("corrections"):
        problems.append("no source produced a usable observation")
    for change in report.get("changes") or []:
        if not (change.get("evidence") or {}).get("source_id"):
            problems.append(f"{change['key']}: change has no source evidence")
    try:
        candidate = build_candidate(catalogue, revision.get("observations") or [], report,
                                    decisions, version=str(revision.get("proposed_version")))
        loaded = mem.load_plan_catalogue(candidate)
    except mem.CatalogueError as exc:
        problems.append(f"candidate catalogue is invalid: {exc}")
        loaded = None
    if loaded:
        ids = {p["id"] for p in loaded["plans"]}
        active_ids = {p["id"] for p in (catalogue.get("plans") or [])}
        for pid in active_ids - ids:
            plan = next(p for p in catalogue["plans"] if p["id"] == pid)
            if str((plan.get("verification") or {}).get("status")) != "retired":
                key = f"plan_removed:{pid}"
                if decisions.get(key) != "accept":
                    problems.append(f"{pid}: removed by the candidate without an accepted removal")
        for pid in ids - active_ids:
            key = f"plan_added:{pid}"
            if decisions.get(key) == "reject":
                problems.append(f"{pid}: added by the candidate despite a rejected addition")
        if loaded["catalogue_version"] == catalogue.get("catalogue_version"):
            problems.append("candidate version equals the active version")
    return problems


def review(revision: Mapping[str, Any]) -> dict[str, Any]:
    """Human-readable review payload: what changes, what it costs to be wrong."""
    report = revision.get("diff") or {}
    changes = []
    for change in report.get("changes") or []:
        changes.append({
            "key": change["key"],
            "family": change["family"],
            "plan_id": change["plan_id"],
            "action": change["action"],
            "materiality": change["materiality"],
            "summary": change["summary"],
            "before": change.get("before"),
            "after": change.get("after"),
            "evidence": change.get("evidence"),
            "decided": (revision.get("decisions") or {}).get(change["key"]),
        })
    return {
        "revision_id": revision.get("revision_id"),
        "status": revision.get("status"),
        "base_version": revision.get("base_version"),
        "proposed_version": revision.get("proposed_version"),
        "counts": report.get("counts") or {},
        "blocking": report.get("blocking") or [],
        "changes": changes,
        "sources": revision.get("sources") or [],
        "decisions": revision.get("decisions") or {},
        "approvals": revision.get("approvals") or [],
        "requires_owner": bool(report.get("blocking")),
        "note": ("Every blocking change needs accept or reject before activation."
                 if report.get("blocking") else "Nothing blocking: only additions or cosmetic changes."),
    }


def approve(catalogue_dir: Path | str, revision_id: str, decisions: Mapping[str, str], *,
            by: str, note: str = "", catalogue: Optional[Mapping[str, Any]] = None) -> dict[str, Any]:
    """Record decisions and, if nothing blocks, mark the revision approved."""
    revision = load_revision(catalogue_dir, revision_id)
    clean = {str(k): str(v).lower() for k, v in decisions.items() if str(v).lower() in ("accept", "reject")}
    unknown = sorted(set(clean) - {c["key"] for c in (revision.get("diff") or {}).get("changes") or []})
    if unknown:
        raise ValueError("unknown change keys: " + ", ".join(unknown))
    if not str(by or "").strip():
        raise ValueError("an approval needs a named approver")
    revision = {**revision,
                "decisions": {**(revision.get("decisions") or {}), **clean},
                "history": [*(revision.get("history") or []),
                            {"action": "decided", "at": now_iso(), "by": by,
                             "decisions": clean, "note": note}]}
    blocking = (revision.get("diff") or {}).get("blocking") or []
    outstanding = [k for k in blocking if revision["decisions"].get(k) not in ("accept", "reject")]
    revision["status"] = "approved" if not outstanding else "staged"
    revision["approvals"] = [*(revision.get("approvals") or []),
                             {"by": by, "at": now_iso(), "note": note,
                              "complete": not outstanding, "outstanding": outstanding}]
    active = catalogue if catalogue is not None else _load_active(catalogue_dir)
    problems = validate(revision, active)
    revision["validation"] = {"ok": not problems, "problems": problems}
    _write_json(revisions_dir(catalogue_dir) / f"{revision_id}.json", revision)
    return revision


# ---------------------------------------------------------------------------
# Activate / roll back
# ---------------------------------------------------------------------------

def _load_active(catalogue_dir: Path | str) -> dict[str, Any]:
    return mem.load_plan_catalogue(Path(catalogue_dir) / "plans.json")


def activate(catalogue_dir: Path | str, revision_id: str, *, by: str, dry_run: bool = False,
             catalogue: Optional[Mapping[str, Any]] = None) -> dict[str, Any]:
    """Promote a revision to the active catalogue.

    Refuses unless the revision validated cleanly and every blocking change has a
    decision. Archives the outgoing catalogue under ``history/`` first.
    """
    revision = load_revision(catalogue_dir, revision_id)
    active = catalogue if catalogue is not None else _load_active(catalogue_dir)
    problems = validate(revision, active)
    if problems:
        raise ValueError("revision cannot be activated: " + "; ".join(problems[:6]))
    if str(revision.get("status")) not in ("approved", "staged"):
        raise ValueError(f"revision status is {revision.get('status')!r}")
    candidate = build_candidate(active, revision.get("observations") or [], revision.get("diff") or {},
                                revision.get("decisions") or {},
                                version=str(revision.get("proposed_version")))
    mem.load_plan_catalogue(candidate)  # last gate: the loader accepts it
    result = {"revision_id": revision_id, "from_version": active.get("catalogue_version"),
              "to_version": candidate.get("catalogue_version"),
              "changes": len((revision.get("diff") or {}).get("changes") or []),
              "dry_run": bool(dry_run), "activated": False}
    if dry_run:
        result["candidate"] = candidate
        return result
    target = Path(catalogue_dir) / "plans.json"
    archive = history_dir(catalogue_dir) / f"plans-{active.get('catalogue_version') or 'unknown'}.json"
    if archive.exists():
        try:
            existing_archive = json.loads(archive.read_text())
        except (OSError, ValueError):
            existing_archive = None
        if existing_archive != dict(active):
            raise ValueError(
                f"history archive already exists with different content: {archive.name}")
    _write_json(archive, active)
    _write_json(target, candidate)
    revision = {**revision, "status": "activated", "applied_version": candidate.get("catalogue_version"),
                "activated_at": now_iso(), "activated_by": by,
                "history": [*(revision.get("history") or []),
                            {"action": "activated", "at": now_iso(), "by": by,
                             "version": candidate.get("catalogue_version")}]}
    _write_json(revisions_dir(catalogue_dir) / f"{revision_id}.json", revision)
    result.update({"activated": True, "archive": str(archive)})
    return result


def rollback(catalogue_dir: Path | str, version: str, *, by: str, dry_run: bool = False,
             reason: str = "") -> dict[str, Any]:
    """Restore an archived catalogue version as the active one."""
    source = history_dir(catalogue_dir) / f"plans-{version}.json"
    if not source.exists():
        raise KeyError(f"no archived catalogue for version {version}")
    restored = mem.load_plan_catalogue(source)
    current = _load_active(catalogue_dir)
    record = {
        "revision_id": f"rev-rollback-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}",
        "created_at": now_iso(), "status": "rollback", "note": reason or f"restore {version}",
        "base_version": current.get("catalogue_version"), "proposed_version": restored.get("catalogue_version"),
        "sources": [], "observations": [], "diff": {"changes": [], "counts": {}, "blocking": []},
        "decisions": {}, "approvals": [{"by": by, "at": now_iso(), "note": reason, "complete": True,
                                        "outstanding": []}],
        "applied_version": None, "history": [{"action": "rollback", "at": now_iso(), "by": by,
                                              "from": current.get("catalogue_version"), "to": version}],
    }
    result = {"from_version": current.get("catalogue_version"), "to_version": restored.get("catalogue_version"),
              "dry_run": bool(dry_run), "rolled_back": False, "revision_id": record["revision_id"]}
    if dry_run:
        return result
    target = Path(catalogue_dir) / "plans.json"
    archive = history_dir(catalogue_dir) / f"plans-{current.get('catalogue_version') or 'unknown'}.json"
    _write_json(archive, current)
    _write_json(target, restored)
    record["applied_version"] = restored.get("catalogue_version")
    _write_json(revisions_dir(catalogue_dir) / f"{record['revision_id']}.json", record)
    result["rolled_back"] = True
    return result


def status(catalogue_dir: Path | str) -> dict[str, Any]:
    active = _load_active(catalogue_dir)
    revisions = list_revisions(catalogue_dir)
    archived = sorted(p.name for p in history_dir(catalogue_dir).glob("plans-*.json"))
    return {
        "active_version": active.get("catalogue_version"),
        "plans": len(active.get("plans") or []),
        "families": len({p["provider_family"] for p in active.get("plans") or []}),
        "archived": archived,
        "revisions": [{"revision_id": r.get("revision_id"), "status": r.get("status"),
                       "created_at": r.get("created_at"),
                       "changes": len((r.get("diff") or {}).get("changes") or []),
                       "blocking": len((r.get("diff") or {}).get("blocking") or [])}
                      for r in revisions],
    }
