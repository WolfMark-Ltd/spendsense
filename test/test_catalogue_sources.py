"""Source parsing, currency handling and the ambiguity safety rules.

The governing rule: a page that cannot be read must produce *nothing*, never a
plausible number. Every negative case here asserts that no plan is removed and
no price is changed when the evidence is not solid.
"""
from __future__ import annotations

import json
import shutil
import tempfile
import unittest
from pathlib import Path

from wolfmark_ledger import catalogue_money as CM
from wolfmark_ledger import catalogue_revisions as R
from wolfmark_ledger import catalogue_sources as S
from wolfmark_ledger import membership as M

ROOT = Path(__file__).resolve().parents[1]
FIX = ROOT / "test" / "fixtures" / "catalogue"
CATALOGUE = ROOT / "catalogue"


def body(path: Path) -> str:
    return path.read_text(encoding="utf-8")


class MoneyTests(unittest.TestCase):
    def test_symbols_map_to_their_currency(self):
        self.assertEqual(CM.money("$20 / mo")["currency"], "USD")
        self.assertEqual(CM.money("US$ 1,234.50")["amount"], 1234.5)
        self.assertEqual(CM.money("£9.99")["currency"], "GBP")
        self.assertEqual(CM.money("€49")["currency"], "EUR")
        self.assertEqual(CM.money("CN¥ 68 /month")["currency"], "CNY")
        self.assertEqual(CM.money("RMB99")["currency"], "CNY")

    def test_a_bare_yen_is_ambiguous_and_never_guessed(self):
        found = CM.money("¥ 99/user/month")
        self.assertEqual(found["amount"], 99.0)
        self.assertIsNone(found["currency"])
        self.assertEqual(found["ambiguous_currency"], "¥")

    def test_nothing_is_converted(self):
        # The same digits in three currencies must stay three distinguishable
        # amounts: conversion belongs to display, not to storage.
        usd, cny, gbp = CM.money("$100"), CM.money("CN¥100"), CM.money("£100")
        self.assertEqual({usd["amount"], cny["amount"], gbp["amount"]}, {100.0})
        self.assertEqual({usd["currency"], cny["currency"], gbp["currency"]}, {"USD", "CNY", "GBP"})

    def test_no_price_means_no_price(self):
        self.assertIsNone(CM.money("Custom"))
        self.assertIsNone(CM.money("Contact us"))
        self.assertIsNone(CM.money(""))

    def test_text_of_skips_script_bodies(self):
        html = "<div>Pro <script>var a = '<div>'; if (1 < 2) {}</script> $20 / mo</div>"
        text = CM.text_of(html)
        self.assertIn("Pro", text)
        self.assertIn("$20 / mo", text)
        self.assertNotIn("var a", text)

    def test_a_stray_angle_bracket_does_not_swallow_the_page(self):
        text = CM.text_of("<p>Team</p><script>if (a<b) {}</script><p>$500 / mo</p>")
        self.assertIn("Team", text)
        self.assertIn("$500 / mo", text)


class OllamaParserTests(unittest.TestCase):
    def setUp(self):
        self.example = body(FIX / "ollama" / "sources" / "ollama-pricing.html")

    def test_reads_three_card_prices_from_synthetic_page(self):
        result = S.parse_ollama(self.example)
        self.assertTrue(result["complete"])
        prices = {p["id"]: (p["price"]["amount"], p["price"]["currency"]) for p in result["plans"]}
        self.assertEqual(prices, {"ollama-cloud.pro": (20.0, "USD"),
                                  "ollama-cloud.max": (100.0, "USD"),
                                  "ollama-cloud.team": (500.0, "USD")})

    def test_a_redesigned_page_yields_nothing_and_says_why(self):
        result = S.parse_ollama(body(FIX / "safety" / "sources" / "ollama-pricing.html"))
        self.assertFalse(result["complete"])
        self.assertEqual(result["plans"], [])
        self.assertIn("card anchors not found", result["note"])
        self.assertTrue(result["signals"], "unparsed price signals must be reported to a human")

    def test_a_price_change_is_still_read(self):
        # The anchor is the sentence, not the amount, so a new number still parses.
        changed = self.example.replace("$100", "$120", 1)
        result = S.parse_ollama(changed)
        self.assertTrue(result["complete"])
        max_plan = next(p for p in result["plans"] if p["id"] == "ollama-cloud.max")
        self.assertEqual(max_plan["price"]["amount"], 120.0)


class HuggingFaceParserTests(unittest.TestCase):
    def setUp(self):
        self.example = body(FIX / "huggingface" / "sources" / "huggingface-pricing.txt")

    def test_reads_pro_team_and_enterprise(self):
        result = S.parse_huggingface(self.example)
        self.assertTrue(result["complete"])
        rows = {p["id"]: p["price"] for p in result["plans"]}
        self.assertEqual(rows["huggingface.pro"]["amount"], 9.0)
        self.assertEqual(rows["huggingface.pro"].get("per_unit"), None)
        self.assertEqual(rows["huggingface.team"]["amount"], 20.0)
        self.assertEqual(rows["huggingface.team"]["per_unit"], "user")
        self.assertEqual(rows["huggingface.enterprise"]["amount"], 50.0)

    def test_cny_prices_are_preserved_not_converted(self):
        result = S.parse_huggingface(body(FIX / "safety" / "sources" / "huggingface-pricing.txt"))
        rows = {p["id"]: p["price"] for p in result["plans"]}
        self.assertEqual(rows["huggingface.pro"]["currency"], "CNY")
        self.assertEqual(rows["huggingface.pro"]["amount"], 68.0)
        self.assertEqual(rows["huggingface.team"]["currency"], "CNY")

    def test_a_missing_card_makes_the_whole_page_unproven(self):
        partial = self.example.split("Enterprise")[0]
        result = S.parse_huggingface(partial)
        self.assertFalse(result["complete"])
        self.assertIn("Enterprise", result["note"])


class KilocodeParserTests(unittest.TestCase):
    def setUp(self):
        self.example = body(FIX / "kilocode" / "sources" / "kilocode-pricing.html")

    def test_reads_the_platform_plan_row(self):
        result = S.parse_kilocode(self.example)
        self.assertTrue(result["complete"])
        teams = next(p for p in result["plans"] if p["id"] == "kilocode.teams")
        self.assertEqual(teams["price"]["amount"], 15.0)
        self.assertEqual(teams["price"]["per_unit"], "user")
        # The free platform tier is not a subscription and must not appear.
        self.assertNotIn("kilocode.individual", {p["id"] for p in result["plans"]})

    def test_a_custom_quoted_tier_is_noted_not_catalogued(self):
        result = S.parse_kilocode(self.example)
        self.assertIn("Sold by quote", result["note"])
        self.assertNotIn("kilocode.enterprise", {p["id"] for p in result["plans"]})

    def test_an_ambiguous_currency_is_recorded_as_unresolved(self):
        result = S.parse_kilocode(body(FIX / "safety" / "sources" / "kilocode-pricing.html"))
        teams = next(p for p in result["plans"] if p["id"] == "kilocode.teams")
        self.assertEqual(teams["price"]["amount"], 99.0)
        self.assertIsNone(teams["price"]["currency"])
        self.assertEqual(teams["price"]["ambiguous_currency"], "¥")

    def test_no_table_means_no_plans(self):
        result = S.parse_kilocode("<html><body><h1>Pricing</h1></body></html>")
        self.assertEqual(result["plans"], [])
        self.assertFalse(result["complete"])


class AmbiguitySafetyTests(unittest.TestCase):
    """An unreadable source must never remove a plan or move a price."""

    def setUp(self):
        self.catalogue = M.load_plan_catalogue(CATALOGUE / "plans.json")

    def _observe(self, source: dict, fixture: Path) -> dict:
        snapshot = {"source_id": source["id"], "url": source.get("url"), "status": "fixture",
                    "retrieved_at": "2026-10-30T00:00:00Z", "http_status": 200,
                    "sha256": "0" * 64, "body": fixture.read_text(encoding="utf-8")}
        return S.observe(snapshot, source)

    def test_a_page_the_parser_cannot_read_proposes_nothing_material(self):
        source = {"id": "ollama-pricing", "family": "ollama-cloud", "adapter": "ollama_pricing",
                  "complete": True, "status": "fetched", "url": "https://ollama.com/pricing"}
        observation = self._observe(source, FIX / "safety" / "sources" / "ollama-pricing.html")
        self.assertFalse(observation["usable"])
        report = R.diff_report([observation], self.catalogue)
        self.assertEqual([c for c in report["changes"] if c["materiality"] == "material"], [])
        self.assertTrue(all(c["materiality"] == "ambiguous" for c in report["changes"]))

    def test_a_partial_read_downgrades_removals_to_ambiguous(self):
        source = {"id": "huggingface-pricing", "family": "huggingface",
                  "adapter": "huggingface_pricing", "complete": True,
                  "status": "fetched", "url": "https://huggingface.co/pricing"}
        partial = (FIX / "huggingface" / "sources" / "huggingface-pricing.txt")
        text = partial.read_text(encoding="utf-8").split("Enterprise")[0]
        tmp = self._tmp(text)
        observation = self._observe(source, tmp)
        self.assertFalse(observation["complete"])
        report = R.diff_report([observation], self.catalogue)
        self.assertTrue(all(c["materiality"] != "material" for c in report["changes"]))

    def test_a_card_parser_cannot_prove_a_removal(self):
        # Card anchors identify a price, not the absence of a plan: if the Team
        # card stops being readable, the honest verdict is "I cannot tell".
        source = {"id": "ollama-pricing", "family": "ollama-cloud", "adapter": "ollama_pricing",
                  "complete": True, "status": "fetched", "url": "https://ollama.com/pricing"}
        text = body(FIX / "ollama" / "sources" / "ollama-pricing.html")
        observation = self._observe(source, self._tmp(text.replace(
            "For teams scaling with open models", "Gone")))
        self.assertFalse(observation["complete"])
        report = R.diff_report([observation], self.catalogue)
        removal = [c for c in report["changes"] if c["plan_id"] == "ollama-cloud.team"]
        self.assertTrue(removal)
        self.assertEqual(removal[0]["materiality"], "ambiguous")

    def test_a_shape_only_parser_can_prove_a_removal(self):
        # CommandCode's parser requires a table, not each named plan, so a missing
        # row is real evidence. The enumerative parsers (Ollama, Hugging Face,
        # Kilo) cannot make that claim and are expected to stay ambiguous.
        source = {"id": "commandcode-pricing", "family": "commandcode",
                  "adapter": "commandcode_pricing", "complete": True, "status": "fetched",
                  "url": "https://commandcode.ai/docs/resources/pricing-limits"}
        observation = self._observe(source, FIX / "demo-reject" / "sources" / "commandcode-pricing.txt")
        self.assertTrue(observation["complete"])
        report = R.diff_report([observation], self.catalogue)
        removal = [c for c in report["changes"] if c["plan_id"] == "commandcode.team-pro"]
        self.assertTrue(removal)
        self.assertEqual(removal[0]["materiality"], "material")

    def test_an_emptied_table_cell_is_ambiguous_not_a_removal(self):
        source = {"id": "kilocode-pricing", "family": "kilocode", "adapter": "kilocode_pricing",
                  "complete": True, "status": "fetched", "url": "https://kilocode.ai/pricing"}
        text = body(FIX / "kilocode" / "sources" / "kilocode-pricing.html")
        observation = self._observe(source, self._tmp(text.replace("$15/user/month", "")))
        self.assertFalse(observation["complete"])
        report = R.diff_report([observation], self.catalogue)
        self.assertTrue(all(c["materiality"] != "material" for c in report["changes"]))

    def _tmp(self, text: str) -> Path:
        handle = tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False, dir=ROOT / ".livecheck"
                                             if (ROOT / ".livecheck").exists() else None)
        handle.write(text)
        handle.close()
        self.addCleanup(lambda: Path(handle.name).unlink(missing_ok=True))
        return Path(handle.name)


class RegisterTests(unittest.TestCase):
    def setUp(self):
        self.doc = json.loads((CATALOGUE / "plans.json").read_text())
        self.register = json.loads((CATALOGUE / "sources.json").read_text())

    def test_every_citation_resolves(self):
        rows = {r["id"]: r for r in self.register["sources"]}
        cited = set()
        for plan in self.doc["plans"]:
            for sid in (plan["verification"].get("source_id"),
                        (plan["entitlements"].get("verification") or {}).get("source_id")):
                if sid:
                    cited.add(sid)
        self.assertEqual(cited - set(rows), set(), "uncited source would be uncheckable")

    def test_evidence_kinds_are_from_the_closed_set(self):
        for row in self.register["sources"]:
            self.assertIn(row["evidence_kind"], S_KINDS := ("price_page", "token_price_page",
                                                           "product_page", "docs_only",
                                                           "balance_api", "aggregator",
                                                           "cannot_price"), row["id"])

    def test_a_registered_source_is_not_a_parser(self):
        parsed = {r["id"] for r in self.register["sources"] if r["parsed"]}
        self.assertEqual(parsed, {"opencode-go-plan", "commandcode-pricing", "ollama-pricing",
                                  "huggingface-pricing", "kilocode-pricing"})
        for row in self.register["sources"]:
            self.assertEqual(row["parsed"], row["adapter"] != "manual", row["id"])

    def test_no_timestamp_claims_the_future(self):
        from datetime import datetime, timezone
        now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        for row in self.register["sources"]:
            stamp = row.get("retrieved_at")
            if stamp:
                self.assertLessEqual(str(stamp), now, f"{row['id']} claims a future retrieval")

    def test_the_catalogue_version_is_not_in_the_future(self):
        from datetime import datetime, timezone
        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        version = str(self.doc["catalogue_version"])
        self.assertLessEqual(version.split(".")[0], today,
                             "a catalogue version must not claim a day that has not happened")

    def test_aliases_point_at_a_registered_canonical_source(self):
        ids = {r["id"] for r in self.register["sources"]}
        for row in self.register["sources"]:
            if row.get("alias_of"):
                self.assertIn(row["alias_of"], ids, row["id"])


class CorrectionTests(unittest.TestCase):
    """The corrections are split by intent, so no unrelated change can ride along."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name) / "catalogue"
        shutil.copytree(CATALOGUE, self.dir,
                        ignore=shutil.ignore_patterns("revisions", "history", "__pycache__"))
        self.active = M.load_plan_catalogue(self.dir / "plans.json")
        self.umans = json.loads(
            (self.dir / "corrections" / "2026-10-30-umans-wallet.json").read_text())["corrections"]
        self.notes = json.loads(
            (self.dir / "corrections" / "2026-10-30-evidence-notes.json").read_text())["corrections"]

    def tearDown(self):
        self.tmp.cleanup()

    def test_umans_becomes_a_prepaid_wallet(self):
        report = R.correction_report(self.active, self.umans)
        keys = {c["key"] for c in report["changes"]}
        self.assertEqual(keys, {"billing_arrangement_changed:umans-ai-coding-plan.standard",
                                "kind_changed:umans-ai-coding-plan.standard",
                                "name_changed:umans-ai-coding-plan.standard"})
        self.assertEqual(sorted(report["blocking"]),
                         ["billing_arrangement_changed:umans-ai-coding-plan.standard",
                          "kind_changed:umans-ai-coding-plan.standard"])

    def test_the_notes_file_changes_nothing_financial(self):
        report = R.correction_report(self.active, self.notes)
        self.assertEqual(report["blocking"], [])
        for change in report["changes"]:
            self.assertEqual(change["action"], "verification_note_changed")
            self.assertEqual(change["materiality"], "review")

    def test_alibaba_keeps_its_coding_plan_identity(self):
        # Rejected on 30 October: Coding Plan, Token Plan and pay-as-you-go are
        # separate arrangements. The note may change; the identity may not.
        for correction in self.umans + self.notes:
            if correction["plan_id"] != "alibaba-coding-plan.standard":
                continue
            self.assertNotEqual(correction["field"], "kind")
            self.assertNotEqual(correction["field"], "name")
            self.assertNotEqual(correction["field"], "billing_arrangement")
        plan = next(p for p in self.active["plans"] if p["id"] == "alibaba-coding-plan.standard")
        self.assertEqual(plan["kind"], "subscription")
        self.assertEqual(plan["name"], "Alibaba Coding Plan")
        self.assertEqual(plan["billing_arrangement"], "recurring_subscription")

    def test_no_correction_sets_a_price(self):
        for correction in self.umans + self.notes:
            self.assertNotEqual(correction["field"], "price",
                                "the placeholder review must not invent a price")

    def test_staging_leaves_the_active_catalogue_untouched(self):
        before = (self.dir / "plans.json").read_bytes()
        revision = R.stage(self.dir, self.active, [], [], note="umans review",
                           corrections=self.umans)
        self.assertEqual((self.dir / "plans.json").read_bytes(), before)
        self.assertEqual(revision["status"], "staged")
        self.assertTrue(revision["corrections"])

    def test_activation_requires_a_decision_on_the_reclassification(self):
        revision = R.stage(self.dir, self.active, [], [], corrections=self.umans)
        problems = R.validate(revision, self.active)
        self.assertTrue(any("no decision recorded" in p for p in problems))
        with self.assertRaises(ValueError):
            R.activate(self.dir, revision["revision_id"], by="reviewer", catalogue=self.active)

    def test_accepted_and_rejected_corrections_are_applied_independently(self):
        revision = R.stage(self.dir, self.active, [], [], corrections=self.umans)
        R.approve(self.dir, revision["revision_id"], {
            "billing_arrangement_changed:umans-ai-coding-plan.standard": "accept",
            "kind_changed:umans-ai-coding-plan.standard": "accept",
            "name_changed:umans-ai-coding-plan.standard": "reject",
        }, by="reviewer", catalogue=self.active)
        R.activate(self.dir, revision["revision_id"], by="reviewer", catalogue=self.active)
        updated = M.load_plan_catalogue(self.dir / "plans.json")
        umans = next(p for p in updated["plans"] if p["id"] == "umans-ai-coding-plan.standard")
        self.assertEqual(umans["billing_arrangement"], "prepaid_metered_wallet")
        self.assertEqual(umans["kind"], "prepaid")
        self.assertEqual(umans["name"], "Umans Coding Plan", "a rejected rename keeps the value")

    def test_a_source_change_invalidates_the_old_verification(self):
        correction = {"plan_id": "commandcode.team-pro", "field": "source_id",
                      "value": "commandcode-go",
                      "why": "re-point the price claim at the plan page",
                      "evidence": {"source_id": "commandcode-go"}}
        revision = R.stage(self.dir, self.active, [], [], corrections=[correction])
        R.approve(self.dir, revision["revision_id"],
                  {c["key"]: "accept" for c in revision["diff"]["changes"]}, by="reviewer",
                  catalogue=self.active)
        R.activate(self.dir, revision["revision_id"], by="reviewer", catalogue=self.active)
        updated = M.load_plan_catalogue(self.dir / "plans.json")
        plan = next(p for p in updated["plans"] if p["id"] == "commandcode.team-pro")
        self.assertEqual(plan["verification"]["source_id"], "commandcode-go")
        self.assertEqual(plan["verification"]["status"], "unverified")

    def test_an_unknown_field_or_plan_is_refused(self):
        with self.assertRaises(ValueError):
            R.correction_report(self.active, [{"plan_id": "opencode-go.go", "field": "colour",
                                               "value": "blue", "why": "test"}])
        with self.assertRaises(ValueError):
            R.correction_report(self.active, [{"plan_id": "nope", "field": "kind",
                                               "value": "prepaid", "why": "test"}])

    def test_a_correction_without_a_reason_is_refused(self):
        with self.assertRaises(ValueError):
            R.correction_report(self.active, [{"plan_id": "opencode-go.go", "field": "kind",
                                               "value": "prepaid", "why": ""}])


class BillingArrangementTests(unittest.TestCase):
    def setUp(self):
        self.doc = json.loads((CATALOGUE / "plans.json").read_text())

    def test_every_plan_states_an_arrangement(self):
        loaded = M.load_plan_catalogue(self.doc)
        for plan in loaded["plans"]:
            self.assertIn(plan["billing_arrangement"], M.BILLING_ARRANGEMENTS, plan["id"])

    def test_the_three_arrangements_are_distinguishable(self):
        loaded = M.load_plan_catalogue(self.doc)
        seen = {p["billing_arrangement"] for p in loaded["plans"]}
        self.assertEqual(seen, {"recurring_subscription", "recurring_credit_allowance",
                                "prepaid_metered_wallet", "free_tier"})
        credits = next(p for p in loaded["plans"] if p["id"] == "nous.portal")
        self.assertEqual(credits["billing_arrangement"], "recurring_credit_allowance")
        wallet = next(p for p in loaded["plans"] if p["id"] == "opencode-zen.zen")
        self.assertEqual(wallet["billing_arrangement"], "prepaid_metered_wallet")
        plain = next(p for p in loaded["plans"] if p["id"] == "openai-codex.chatgpt-plus")
        self.assertEqual(plain["billing_arrangement"], "recurring_subscription")

    def test_commandcode_credit_subscriptions_are_classified_as_allowance_plans(self):
        loaded = M.load_plan_catalogue(self.doc)
        goat = next(p for p in loaded["plans"] if p["id"] == "commandcode.goat")
        self.assertEqual(goat["billing_arrangement"], "recurring_credit_allowance")
        self.assertTrue(goat["entitlements"]["windows"], "it does publish allowance windows")

    def test_a_wallet_cannot_claim_a_recurring_price(self):
        doc = json.loads((CATALOGUE / "plans.json").read_text())
        for plan in doc["plans"]:
            if plan["id"] == "opencode-zen.zen":
                plan["price"] = {"amount": 20.0, "currency": "USD", "period": "month"}
        with self.assertRaises(M.CatalogueError):
            M.load_plan_catalogue(doc)

    def test_an_unknown_arrangement_is_refused(self):
        doc = json.loads((CATALOGUE / "plans.json").read_text())
        doc["plans"][0]["billing_arrangement"] = "per_seat_vibes"
        with self.assertRaises(M.CatalogueError):
            M.load_plan_catalogue(doc)


class CurrencyStorageTests(unittest.TestCase):
    def test_the_catalogue_accepts_cny_without_converting(self):
        doc = json.loads((CATALOGUE / "plans.json").read_text())
        for plan in doc["plans"]:
            if plan["id"] == "umans-ai-coding-plan.standard":
                plan["price"] = {"amount": 68.0, "currency": "CNY", "period": "month"}
        loaded = M.load_plan_catalogue(doc)
        plan = next(p for p in loaded["plans"] if p["id"] == "umans-ai-coding-plan.standard")
        self.assertEqual(plan["price"]["currency"], "CNY")
        self.assertEqual(plan["price"]["amount"], 68.0)

    def test_a_fee_in_cny_stays_in_cny(self):
        account = {
            "id": "alibaba-coding-plan:default", "family": "alibaba-coding-plan", "label": "AI Token Plan",
            "route_slugs": ["alibaba-coding-plan"], "credential_present": False, "identity": None,
            "identity_source": "provider_default_slot", "discovered_at": "2026-10-30T00:00:00Z",
            "plan_id": "alibaba-coding-plan.standard", "plan_hint": None,
            "fee_overrides": [{"id": "o1", "amount": 199.0, "currency": "CNY", "period": "month",
                               "reason": "custom", "effective_from": "2026-01-01T00:00:00Z",
                               "recorded_at": "2026-10-30T00:00:00Z"}],
            "manual_exhaustions": [], "advanced": {"model_mapping": {}, "rate_override": {}},
        }
        catalogue = M.load_plan_catalogue(CATALOGUE / "plans.json")
        fee = M.resolve_fee(account, catalogue)
        self.assertEqual(fee["effective"]["currency"], "CNY")
        self.assertEqual(fee["effective"]["amount"], 199.0)


if __name__ == "__main__":
    unittest.main()
