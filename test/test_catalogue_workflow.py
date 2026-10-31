"""Catalogue maintenance workflow: sources, diff, staging, approval, rollback.

Everything runs offline against fixtures — no provider is contacted and the real
catalogue is copied into a temporary directory before anything writes to it.
"""
from __future__ import annotations

import json
import shutil
import tempfile
import unittest
from pathlib import Path

from wolfmark_ledger import catalogue_revisions as R
from wolfmark_ledger import catalogue_sources as S
from wolfmark_ledger import membership as M
from wolfmark_ledger import membership_store as store

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / "test" / "fixtures" / "catalogue"


class CatalogueCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.catalogue_dir = self.dir / "catalogue"
        shutil.copytree(ROOT / "catalogue", self.catalogue_dir,
                        ignore=shutil.ignore_patterns("revisions", "history", "__pycache__"))
        self.register = S.load_sources(self.catalogue_dir / "sources.json")
        self.active = M.load_plan_catalogue(self.catalogue_dir / "plans.json")

    def tearDown(self):
        self.tmp.cleanup()

    # -- helpers ---------------------------------------------------------
    def observe(self, fixture: str) -> tuple[list[dict], list[dict]]:
        """Read the sources this fixture set actually provides.

        The demo fixtures cover the CommandCode and OpenCode Go tables; a source
        with no capture here is not part of the comparison.
        """
        snapshots, observations = [], []
        base = FIXTURES / fixture / "sources"
        for source in self.register["sources"]:
            if not source.get("parsed"):
                continue
            if not any((base / f"{source['id']}{ext}").exists() for ext in (".txt", ".html")):
                continue
            snapshot = S.fetch(source, offline_dir=FIXTURES / fixture)
            snapshots.append(snapshot)
            observations.append(S.observe(snapshot, source))
        return snapshots, observations

    def stage(self, fixture: str, **kwargs):
        snapshots, observations = self.observe(fixture)
        return R.stage(self.catalogue_dir, self.active, observations, snapshots, **kwargs)

    def plan(self, catalogue, plan_id):
        return next(p for p in catalogue["plans"] if p["id"] == plan_id)


class SourceParsing(CatalogueCase):
    def test_a_fixture_snapshot_records_what_was_read(self):
        snapshots, observations = self.observe("baseline")
        self.assertEqual(len(snapshots), 2, "the two fixture-backed sources")
        for snapshot in snapshots:
            self.assertEqual(snapshot["status"], "fixture")
            self.assertEqual(snapshot["http_status"], 200)
            self.assertRegex(snapshot["sha256"], r"^[0-9a-f]{64}$")
        go = next(o for o in observations if o["family"] == "opencode-go")
        self.assertTrue(go["usable"])
        self.assertEqual({p["id"] for p in go["plans"]},
                         {"opencode-go.go", "opencode-go.go-plus", "opencode-go.go-teams"})
        self.assertEqual(next(p for p in go["plans"] if p["id"] == "opencode-go.go")["price"]["amount"], 10.0)

    def test_a_missing_fixture_is_unusable_not_empty(self):
        snapshot = S.fetch({"id": "nope", "url": "https://example.invalid"}, offline_dir=FIXTURES / "baseline")
        self.assertEqual(snapshot["status"], "missing_fixture")
        observation = S.observe(snapshot, {"id": "nope", "family": "x", "adapter": "opencode_go"})
        self.assertFalse(observation["usable"])
        self.assertIn("source not read", observation["notes"][0])

    def test_a_page_without_a_parser_is_reported_for_manual_review(self):
        snapshot = {"status": "fixture", "body": "| a | b |", "retrieved_at": "x", "http_status": 200, "sha256": "s"}
        observation = S.observe(snapshot, {"id": "huggingface-pricing", "family": "huggingface", "adapter": "manual"})
        self.assertFalse(observation["usable"])
        self.assertIn("review by hand", observation["notes"][0])

    def test_a_not_fetched_source_is_skipped_without_inventing_a_value(self):
        snapshot = S.fetch({"id": "xai-supergrok", "url": "https://x.ai/grok", "status": "not_fetched"})
        self.assertEqual(snapshot["status"], "not_fetched")
        self.assertIsNone(snapshot["sha256"])
        self.assertEqual(snapshot["body"], "")


class Diffing(CatalogueCase):
    def test_the_approved_catalogue_matches_its_own_sources(self):
        _, observations = self.observe("baseline")
        report = R.diff_report(observations, self.active)
        self.assertEqual(report["changes"], [])
        self.assertEqual(report["blocking"], [])

    def test_a_price_change_is_material_and_blocks_activation(self):
        _, observations = self.observe("demo-change")
        report = R.diff_report(observations, self.active)
        keys = [c["key"] for c in report["changes"]]
        self.assertIn("price_changed:opencode-go.go", keys)
        change = next(c for c in report["changes"] if c["key"] == "price_changed:opencode-go.go")
        self.assertEqual(change["materiality"], "material")
        self.assertEqual(change["before"]["amount"], 10.0)
        self.assertEqual(change["after"]["amount"], 12.0)
        self.assertIn("price_changed:opencode-go.go", report["blocking"])
        self.assertTrue(report["requires_owner"])
        self.assertEqual(change["evidence"]["source_id"], "opencode-go-plan")

    def test_a_plan_missing_from_a_complete_source_is_a_material_removal(self):
        _, observations = self.observe("demo-reject")
        self.assertTrue(next(o for o in observations if o["family"] == "commandcode")["complete"])
        report = R.diff_report(observations, self.active)
        removal = next(c for c in report["changes"] if c["key"] == "plan_removed:commandcode.team-pro")
        self.assertEqual(removal["materiality"], "material")

    def test_a_plan_missing_from_an_incomplete_source_is_ambiguous(self):
        _, observations = self.observe("baseline")
        for observation in observations:
            observation["complete"] = False
        report = R.diff_report([{**observations[0], "plans": []}], self.active)
        self.assertTrue(report["changes"])
        self.assertTrue(all(c["materiality"] == "ambiguous" for c in report["changes"]))
        self.assertIn("may be incomplete", report["changes"][0]["summary"])

    def test_a_retired_plan_is_not_reported_as_removed(self):
        _, observations = self.observe("baseline")
        cline = next(p for p in self.active["plans"] if p["id"] == "cline-pass.standard")
        self.assertEqual(cline["verification"]["status"], "retired")
        families = {o["family"] for o in observations}
        self.assertNotIn("cline-pass", families)
        keys = [c["key"] for c in R.diff_report(observations, self.active)["changes"]]
        self.assertNotIn("plan_removed:cline-pass.standard", keys)


class StagingAndApproval(CatalogueCase):
    def test_staging_writes_a_revision_and_leaves_the_active_catalogue_alone(self):
        before = (self.catalogue_dir / "plans.json").read_bytes()
        revision = self.stage("demo-change", note="october review")
        self.assertEqual(revision["status"], "staged")
        self.assertEqual(revision["base_version"], "2026-10-30.5")
        self.assertEqual(revision["proposed_version"], "2026-10-30.6")
        self.assertTrue((self.catalogue_dir / "revisions" / f"{revision['revision_id']}.json").exists())
        self.assertEqual((self.catalogue_dir / "plans.json").read_bytes(), before,
                         "staging must not touch the active catalogue")

    def test_validation_blocks_until_every_material_change_is_decided(self):
        revision = self.stage("demo-change")
        problems = R.validate(revision, self.active)
        self.assertTrue(any("no decision recorded" in p for p in problems))
        approved = R.approve(self.catalogue_dir, revision["revision_id"],
                             {"price_changed:opencode-go.go": "accept",
                              "price_changed:opencode-go.go-plus": "accept"},
                             by="reviewer", catalogue=self.active)
        self.assertEqual(approved["status"], "approved")
        self.assertTrue(approved["validation"]["ok"], approved["validation"]["problems"])
        self.assertEqual(approved["approvals"][0]["by"], "reviewer")

    def test_an_unrelated_decision_key_is_refused(self):
        revision = self.stage("demo-change")
        with self.assertRaises(ValueError):
            R.approve(self.catalogue_dir, revision["revision_id"], {"price_changed:nope": "accept"},
                      by="reviewer", catalogue=self.active)

    def test_an_approval_needs_a_named_approver(self):
        revision = self.stage("demo-change")
        with self.assertRaises(ValueError):
            R.approve(self.catalogue_dir, revision["revision_id"], {}, by="", catalogue=self.active)

    def test_activation_refuses_while_a_material_change_is_undecided(self):
        revision = self.stage("demo-change")
        with self.assertRaises(ValueError) as ctx:
            R.activate(self.catalogue_dir, revision["revision_id"], by="reviewer", catalogue=self.active)
        self.assertIn("no decision recorded", str(ctx.exception))


class Activation(CatalogueCase):
    def _approve(self, fixture, decisions, note=""):
        revision = self.stage(fixture, note=note)
        return R.approve(self.catalogue_dir, revision["revision_id"], decisions, by="reviewer",
                         catalogue=self.active)

    def test_activation_applies_accepted_changes_and_keeps_rejected_ones(self):
        revision = self._approve("demo-change", {"price_changed:opencode-go.go": "accept",
                                                 "price_changed:opencode-go.go-plus": "reject"})
        result = R.activate(self.catalogue_dir, revision["revision_id"], by="reviewer", catalogue=self.active)
        self.assertTrue(result["activated"])
        self.assertEqual(result["to_version"], "2026-10-30.6")
        updated = M.load_plan_catalogue(self.catalogue_dir / "plans.json")
        self.assertEqual(self.plan(updated, "opencode-go.go")["price"]["amount"], 12.0)
        self.assertEqual(self.plan(updated, "opencode-go.go-plus")["price"]["amount"], 40.0,
                         "a rejected change keeps the approved value")
        self.assertEqual(self.plan(updated, "opencode-go.go")["verification"]["source_id"], "opencode-go-plan")

    def test_activation_archives_the_outgoing_version(self):
        revision = self._approve("demo-change", {"price_changed:opencode-go.go": "accept",
                                                 "price_changed:opencode-go.go-plus": "accept"})
        R.activate(self.catalogue_dir, revision["revision_id"], by="reviewer", catalogue=self.active)
        archived = list((self.catalogue_dir / "history").glob("plans-*.json"))
        self.assertEqual(len(archived), 1)
        restored = M.load_plan_catalogue(archived[0])
        self.assertEqual(restored["catalogue_version"], "2026-10-30.5")
        self.assertEqual(self.plan(restored, "opencode-go.go")["price"]["amount"], 10.0)

    def test_a_dry_run_changes_nothing(self):
        revision = self._approve("demo-change", {"price_changed:opencode-go.go": "accept",
                                                 "price_changed:opencode-go.go-plus": "accept"})
        before = (self.catalogue_dir / "plans.json").read_bytes()
        result = R.activate(self.catalogue_dir, revision["revision_id"], by="reviewer", dry_run=True,
                            catalogue=self.active)
        self.assertFalse(result["activated"])
        self.assertIn("candidate", result)
        self.assertEqual((self.catalogue_dir / "plans.json").read_bytes(), before)

    def test_rollback_restores_the_archive(self):
        revision = self._approve("demo-change", {"price_changed:opencode-go.go": "accept",
                                                 "price_changed:opencode-go.go-plus": "accept"})
        R.activate(self.catalogue_dir, revision["revision_id"], by="reviewer", catalogue=self.active)
        rolled = M.load_plan_catalogue(self.catalogue_dir / "plans.json")
        self.assertEqual(self.plan(rolled, "opencode-go.go")["price"]["amount"], 12.0)
        result = R.rollback(self.catalogue_dir, "2026-10-30.5", by="reviewer", reason="revert the trial price")
        self.assertTrue(result["rolled_back"])
        back = M.load_plan_catalogue(self.catalogue_dir / "plans.json")
        self.assertEqual(back["catalogue_version"], "2026-10-30.5")
        self.assertEqual(self.plan(back, "opencode-go.go")["price"]["amount"], 10.0)
        record = R.load_revision(self.catalogue_dir, result["revision_id"])
        self.assertEqual(record["status"], "rollback")
        self.assertEqual(record["history"][0]["reason"] if "reason" in record["history"][0] else
                         record["history"][0]["action"], "rollback")

    def test_a_rollback_to_a_missing_version_is_a_lookup_miss(self):
        with self.assertRaises(KeyError):
            R.rollback(self.catalogue_dir, "1999-01-01.1", by="reviewer")

    def test_rollback_refuses_to_overwrite_a_conflicting_archive(self):
        revision = self._approve("demo-change", {"price_changed:opencode-go.go": "accept",
                                                 "price_changed:opencode-go.go-plus": "accept"})
        R.activate(self.catalogue_dir, revision["revision_id"], by="reviewer", catalogue=self.active)
        planted = dict(M.load_plan_catalogue(self.catalogue_dir / "plans.json"))
        planted["plans"] = [{**p, "price": {**p["price"], "amount": 999.0}}
                            if p["id"] == "opencode-go.go" else p for p in planted["plans"]]
        archive = self.catalogue_dir / "history" / "plans-2026-10-30.6.json"
        archive.write_text(json.dumps(planted, indent=2, sort_keys=True))
        before_active = (self.catalogue_dir / "plans.json").read_bytes()
        before_archive = archive.read_bytes()
        with self.assertRaises(ValueError):
            R.rollback(self.catalogue_dir, "2026-10-30.5", by="reviewer")
        self.assertEqual((self.catalogue_dir / "plans.json").read_bytes(), before_active)
        self.assertEqual(archive.read_bytes(), before_archive)

    def test_rollback_reuses_an_identical_archive(self):
        revision = self._approve("demo-change", {"price_changed:opencode-go.go": "accept",
                                                 "price_changed:opencode-go.go-plus": "accept"})
        R.activate(self.catalogue_dir, revision["revision_id"], by="reviewer", catalogue=self.active)
        current = dict(M.load_plan_catalogue(self.catalogue_dir / "plans.json"))
        (self.catalogue_dir / "history" / "plans-2026-10-30.6.json").write_text(
            json.dumps(current, indent=2, sort_keys=True))
        result = R.rollback(self.catalogue_dir, "2026-10-30.5", by="reviewer")
        self.assertTrue(result["rolled_back"])

    def test_personal_fee_overrides_survive_activation_and_rollback(self):
        memberships = self.dir / "memberships.json"
        account = {
            "id": "opencode-go:default", "family": "opencode-go", "label": "Go",
            "route_slugs": ["opencode-go"], "credential_present": True, "identity": None,
            "identity_source": "provider_default_slot", "discovered_at": "2026-10-30T00:00:00Z",
            "plan_id": "opencode-go.go", "plan_hint": "Go", "fee_overrides": [
                {"id": "o1", "amount": 8.5, "currency": "GBP", "period": "month", "reason": "discount",
                 "effective_from": "2026-01-01T00:00:00Z", "recorded_at": "2026-10-30T00:00:00Z"}],
            "manual_exhaustions": [], "advanced": {"model_mapping": {}, "rate_override": {}},
        }
        store.save_account(account, memberships)
        before = memberships.read_bytes()
        revision = self._approve("demo-change", {"price_changed:opencode-go.go": "accept",
                                                 "price_changed:opencode-go.go-plus": "accept"})
        R.activate(self.catalogue_dir, revision["revision_id"], by="reviewer", catalogue=self.active)
        R.rollback(self.catalogue_dir, "2026-10-30.5", by="reviewer")
        self.assertEqual(memberships.read_bytes(), before,
                         "a catalogue change must never rewrite a personal fee override")
        fee = M.resolve_fee(store.accounts_by_id(memberships)["opencode-go:default"],
                            M.load_plan_catalogue(self.catalogue_dir / "plans.json"))
        self.assertEqual(fee["basis"], "declared")
        self.assertEqual(fee["effective"]["amount"], 8.5)


class RouteEligibility(CatalogueCase):
    def test_commandcode_go_is_catalogue_only_for_the_api_route(self):
        eligible, excluded = M.selectable_plans(self.active, "commandcode", requires_api=True)
        self.assertNotIn("commandcode.go", {p["id"] for p in eligible})
        self.assertIn("commandcode.go", {p["id"] for p in excluded})
        verdict = excluded[0]["eligibility"] if excluded[0]["id"] == "commandcode.go" else \
            next(p for p in excluded if p["id"] == "commandcode.go")["eligibility"]
        self.assertFalse(verdict["eligible"])
        self.assertIn("no Provider API access", verdict["reasons"][0])

    def test_goat_provider_api_access_is_confirmed_from_the_dedicated_plan_page(self):
        eligible, _ = M.selectable_plans(self.active, "commandcode", requires_api=True)
        goat = next(p for p in eligible if p["id"] == "commandcode.goat")
        self.assertTrue(goat["eligibility"]["eligible"])
        self.assertNotIn("unstated", goat["eligibility"])
        self.assertTrue(goat["access"]["provider_api"])

    def test_opencode_go_and_zen_are_separate_families(self):
        go = [p for p in self.active["plans"] if p["provider_family"] == "opencode-go"]
        zen = [p for p in self.active["plans"] if p["provider_family"] == "opencode-zen"]
        self.assertEqual({p["id"] for p in go}, {"opencode-go.go", "opencode-go.go-plus", "opencode-go.go-teams"})
        self.assertEqual([p["id"] for p in zen], ["opencode-zen.zen"])
        self.assertEqual(zen[0]["kind"], "prepaid")
        self.assertIsNone(zen[0]["price"]["amount"])
        self.assertIn("not OpenCode Go coverage", zen[0]["notes"])
        for plan in go:
            self.assertEqual(plan["price"]["currency"], "USD")
            self.assertEqual(plan["verification"]["status"], "verified")

    def test_go_plus_is_not_an_alias_of_go(self):
        plans = M.plan_index(self.active)
        self.assertNotEqual(plans["opencode-go.go"]["price"]["amount"],
                            plans["opencode-go.go-plus"]["price"]["amount"])
        self.assertEqual(plans["opencode-go.go-plus"]["price"]["amount"], 40.0)

    def test_a_retired_plan_is_never_selectable(self):
        eligible, excluded = M.selectable_plans(self.active, "cline-pass", requires_api=True)
        self.assertEqual(eligible, [])
        self.assertEqual(excluded[0]["eligibility"]["reasons"][0][:7], "retired")


if __name__ == "__main__":
    unittest.main()
