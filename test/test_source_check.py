"""Tests for the daily source checker. All offline: no network access."""

import io
import json
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from wolfmark_ledger import membership as M
from wolfmark_ledger import source_check as C

ROOT = Path(__file__).resolve().parent.parent
CATALOGUE = ROOT / "catalogue"
FIX = ROOT / "test" / "fixtures" / "catalogue"


def _combined_offline(target: Path) -> Path:
    """Merge every clean fixture set into one offline directory."""
    sources = target / "sources"
    sources.mkdir(parents=True, exist_ok=True)
    for name in ("baseline", "ollama", "huggingface", "kilocode"):
        for path in (FIX / name / "sources").iterdir():
            shutil.copy(path, sources / path.name)
    return target


class SourceCheckTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name) / "catalogue"
        shutil.copytree(CATALOGUE, self.dir,
                        ignore=shutil.ignore_patterns("revisions", "history", "__pycache__"))
        self.offline = _combined_offline(Path(self.tmp.name) / "offline")

    def tearDown(self):
        self.tmp.cleanup()

    def test_a_price_change_against_the_baseline_is_reported(self):
        report = C.check(self.dir, offline_dir=FIX / "demo-change",
                         source_ids=["opencode-go-plan"])
        keys = {c["key"] for c in report["changes"]}
        self.assertIn("price_changed:opencode-go.go", keys)
        change = next(c for c in report["changes"]
                      if c["key"] == "price_changed:opencode-go.go")
        self.assertEqual(change["materiality"], "material")
        self.assertIn("price_changed:opencode-go.go", report["blocking"])
        self.assertTrue(report["requires_owner"])
        self.assertIn("opencode-go-plan", report["candidates"])

    def test_matching_sources_are_silent(self):
        report = C.check(self.dir, offline_dir=self.offline,
                         families=["opencode-go", "commandcode"])
        self.assertEqual(report["changes"], [])
        self.assertEqual(report["blocking"], [])
        self.assertFalse(report["requires_owner"])
        self.assertEqual(report["candidates"], {})
        statuses = {e["source_id"]: e["status"] for e in report["sources"]}
        self.assertEqual(statuses, {"commandcode-pricing": "unchanged",
                                    "opencode-go-plan": "unchanged"})

    def test_a_within_page_conflict_is_surfaced_without_a_price_change(self):
        report = C.check(self.dir, offline_dir=self.offline,
                         source_ids=["commandcode-pricing"])
        entry = next(e for e in report["sources"]
                     if e["source_id"] == "commandcode-pricing")
        self.assertEqual(entry["status"], "unchanged")
        self.assertEqual(entry["changes"], [])
        [conflict] = entry["conflicts"]
        self.assertEqual(conflict["plan_id"], "commandcode.go")
        self.assertEqual(conflict["field"], "rolling_windows")
        self.assertEqual(report["blocking"], [])
        self.assertFalse(report["requires_owner"])
        self.assertIn("conflicts within live sources:", C._summary(report))

    def test_a_first_run_is_silent_and_offers_candidates(self):
        shutil.rmtree(self.dir / "baselines")
        report = C.check(self.dir, offline_dir=self.offline,
                         families=["opencode-go", "commandcode"])
        self.assertEqual(report["changes"], [])
        self.assertEqual(report["blocking"], [])
        self.assertFalse(report["requires_owner"])
        self.assertEqual(set(report["candidates"]),
                         {"commandcode-pricing", "opencode-go-plan"})
        # The checker must not create baselines on its own.
        self.assertFalse((self.dir / "baselines").exists())

    def test_unreviewed_changes_neither_update_baselines_nor_vanish(self):
        before = {p.name: p.read_bytes()
                  for p in sorted((self.dir / "baselines").glob("*.json"))}
        first = C.check(self.dir, offline_dir=FIX / "demo-change",
                        source_ids=["opencode-go-plan"])
        second = C.check(self.dir, offline_dir=FIX / "demo-change",
                         source_ids=["opencode-go-plan"])
        after = {p.name: p.read_bytes()
                 for p in sorted((self.dir / "baselines").glob("*.json"))}
        self.assertEqual(after, before, "a report must never rewrite a baseline")
        keys = {c["key"] for c in second["changes"]}
        self.assertIn("price_changed:opencode-go.go", keys)
        self.assertEqual({c["key"] for c in first["changes"]}, keys)

    def test_an_unreadable_source_carries_prior_diffs_forward(self):
        prior = C.check(self.dir, offline_dir=FIX / "demo-change",
                        source_ids=["opencode-go-plan"])
        empty = Path(self.tmp.name) / "empty" / "sources"
        empty.mkdir(parents=True)
        carried = C.check(self.dir, offline_dir=empty.parent,
                          source_ids=["opencode-go-plan"], prior=prior)
        keys = {c["key"] for c in carried["changes"]}
        self.assertIn("price_changed:opencode-go.go", keys)
        kept = next(c for c in carried["changes"]
                    if c["key"] == "price_changed:opencode-go.go")
        self.assertTrue(kept["carried_forward"])
        # Without a prior report the checker cannot invent the old diff.
        fresh = C.check(self.dir, offline_dir=empty.parent,
                        source_ids=["opencode-go-plan"])
        self.assertNotIn("price_changed:opencode-go.go",
                         {c["key"] for c in fresh["changes"]})

    def test_a_resolved_change_is_not_carried_forward(self):
        prior = C.check(self.dir, offline_dir=FIX / "demo-change",
                        source_ids=["opencode-go-plan"])
        report = C.check(self.dir, offline_dir=self.offline,
                         source_ids=["opencode-go-plan"], prior=prior)
        self.assertEqual(report["changes"], [])

    def test_a_committed_candidate_is_loud_not_trusted(self):
        path = self.dir / "baselines" / "opencode-go-plan.json"
        doc = json.loads(path.read_text(encoding="utf-8"))
        doc["status"] = "candidate"
        path.write_text(json.dumps(doc), encoding="utf-8")
        report = C.check(self.dir, offline_dir=self.offline,
                         source_ids=["opencode-go-plan"])
        entry = next(e for e in report["sources"]
                     if e["source_id"] == "opencode-go-plan")
        self.assertEqual(entry["status"], "baseline_error")
        self.assertTrue(report["requires_owner"])
        self.assertTrue(report["errors"])

    def test_a_corrupt_baseline_is_loud_not_silent(self):
        path = self.dir / "baselines" / "opencode-go-plan.json"
        path.write_text("{not json", encoding="utf-8")
        report = C.check(self.dir, offline_dir=self.offline,
                         source_ids=["opencode-go-plan"])
        entry = next(e for e in report["sources"]
                     if e["source_id"] == "opencode-go-plan")
        self.assertEqual(entry["status"], "baseline_error")
        self.assertTrue(report["requires_owner"])

    def test_no_network_access_is_used_with_fixtures(self):
        with mock.patch("urllib.request.urlopen",
                        side_effect=AssertionError("network used")):
            report = C.check(self.dir, offline_dir=self.offline)
        self.assertTrue(report["sources"])
        self.assertTrue(report["offline"])

    def test_console_output_survives_a_narrow_windows_encoding(self):
        class Cp1252Console(io.StringIO):
            encoding = "cp1252"

            def write(self, text):
                text.encode(self.encoding)  # raise like the real console
                return super().write(text)

        out = Path(self.tmp.name) / "report" / "report.json"
        console = Cp1252Console()
        with mock.patch("sys.stdout", console):
            code = C.main(["--catalogue-dir", str(self.dir),
                           "--fixtures", str(FIX / "demo-change"),
                           "--sources", "opencode-go-plan",
                           "--out", str(out), "--no-candidates"])
        self.assertEqual(code, 0)
        printed = console.getvalue()
        printed.encode("cp1252")  # must not raise
        self.assertIn("->", printed)
        self.assertNotIn("\u2192", printed)
        kept = json.loads(out.read_text(encoding="utf-8"))
        summaries = " ".join(c.get("summary", "") for c in kept["changes"])
        self.assertIn("\u2192", summaries)  # report data keeps full Unicode

    def test_an_unreadable_source_reports_no_fresh_changes(self):
        empty = Path(self.tmp.name) / "empty" / "sources"
        empty.mkdir(parents=True)
        report = C.check(self.dir, offline_dir=empty.parent,
                         source_ids=["opencode-go-plan"])
        entry = next(e for e in report["sources"]
                     if e["source_id"] == "opencode-go-plan")
        self.assertFalse(entry["usable"])
        self.assertEqual(entry["changes"], [])
        self.assertEqual(report["changes"], [])
        self.assertIn("unreadable", entry["note"])
        self.assertFalse(report["requires_owner"])

    def test_an_incomplete_observation_keeps_prior_rows_for_unseen_plans(self):
        baseline = {
            "catalogue_version": "test-1",
            "plans": [
                {"id": "fam.seen", "name": "Seen", "kind": "subscription",
                 "provider_family": "fam",
                 "price": {"amount": 10, "currency": "USD", "period": "month"},
                 "verification": {"status": "verified", "source_id": "fam-src"}},
                {"id": "fam.unseen", "name": "Unseen", "kind": "subscription",
                 "provider_family": "fam",
                 "price": {"amount": 20, "currency": "USD", "period": "month"},
                 "verification": {"status": "verified", "source_id": "fam-src"}},
            ],
        }
        source = {"id": "fam-src", "family": "fam", "adapter": "manual"}
        observation = {"retrieved_at": "2026-11-03T00:00:00Z", "sha256": "abc",
                       "complete": False, "usable": True,
                       "plans": [{"id": "fam.seen", "name": "Seen",
                                  "price": {"amount": 10, "currency": "USD",
                                            "period": "month"}}]}
        candidate = C.candidate_from_observation(observation, source,
                                                 prior=baseline)
        rows = {row["id"]: row for row in candidate["plans"]}
        self.assertEqual(set(rows), {"fam.seen", "fam.unseen"})
        self.assertEqual(rows["fam.unseen"]["price"]["amount"], 20)
        self.assertFalse(candidate["complete"])

    def test_candidates_apply_reported_verification_transitions(self):
        # The committed baseline already accepts Team as verified; rewind the
        # temp copy to the pre-acceptance state so the mechanism is exercised
        # deterministically instead of depending on the live catalogue.
        path = self.dir / "baselines" / "ollama-pricing.json"
        doc = json.loads(path.read_text(encoding="utf-8"))
        for row in doc["plans"]:
            if row["id"] == "ollama-cloud.team":
                row["verification"]["status"] = "provisional"
        path.write_text(json.dumps(doc), encoding="utf-8")
        report = C.check(self.dir, offline_dir=self.offline,
                         families=["ollama-cloud"])
        keys = {c["key"] for c in report["changes"]}
        self.assertIn("verification_changed:ollama-cloud.team", keys)
        candidate = report["candidates"]["ollama-pricing"]
        team = next(row for row in candidate["plans"]
                    if row["id"] == "ollama-cloud.team")
        self.assertEqual(team["verification"]["status"], "verified")
        self.assertEqual(team["verification"]["source_id"], "ollama-pricing")

    def test_an_accepted_verification_is_not_reported_again(self):
        # Team was promoted to verified in the 2026-11-04.1 review: a clean
        # read against the committed baseline must stay silent about it.
        report = C.check(self.dir, offline_dir=self.offline,
                         families=["ollama-cloud"])
        keys = {c["key"] for c in report["changes"]}
        self.assertNotIn("verification_changed:ollama-cloud.team", keys)

    def test_the_checker_writes_nothing_into_the_catalogue(self):
        before = {}
        for path in sorted(self.dir.rglob("*")):
            if path.is_file():
                before[path.relative_to(self.dir)] = path.read_bytes()
        out = Path(self.tmp.name) / "report" / "report.json"
        code = C.main(["--catalogue-dir", str(self.dir),
                       "--fixtures", str(self.offline), "--out", str(out)])
        self.assertEqual(code, 0)
        self.assertTrue(out.exists())
        after = {}
        for path in sorted(self.dir.rglob("*")):
            if path.is_file():
                after[path.relative_to(self.dir)] = path.read_bytes()
        self.assertEqual(after, before)


class CommittedBaselineTests(unittest.TestCase):
    """The shipped baselines pin the approved catalogue, nothing else."""

    def test_every_parsed_source_has_a_reviewed_baseline(self):
        catalogue = M.load_plan_catalogue(CATALOGUE / "plans.json")
        register = json.loads((CATALOGUE / "sources.json").read_text(encoding="utf-8"))
        parsed = [s for s in register["sources"] if s.get("parsed")]
        self.assertTrue(parsed)
        for source in parsed:
            path = CATALOGUE / "baselines" / f"{source['id']}.json"
            self.assertTrue(path.exists(), f"missing baseline for {source['id']}")
            doc = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(C.validate_baseline(doc, source), [])
            expected = [p for p in catalogue["plans"]
                        if p.get("provider_family") == source.get("family")]
            self.assertEqual(len(doc["plans"]), len(expected), source["id"])
            for pinned, row in zip(doc["plans"], expected):
                self.assertEqual(pinned["id"], row["id"])
                self.assertEqual(pinned.get("price"), row.get("price"), row["id"])
            self.assertEqual(doc["catalogue_version"],
                             catalogue["catalogue_version"], source["id"])


if __name__ == "__main__":
    unittest.main()
