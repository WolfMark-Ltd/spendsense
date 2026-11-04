"""Catalogue coverage invariants behind MEMBERSHIP-COVERAGE-AUDIT.md.

These pin the audit's shape: which families exist, which prices are actually
verified, and which families must stay marked as placeholders. When a price is
newly captured, update the audit and these counts together — a silent change
would let the audit overstate coverage.
"""
from __future__ import annotations

import unittest
from pathlib import Path

from wolfmark_ledger import membership as M

ROOT = Path(__file__).resolve().parents[1]
CATALOGUE = ROOT / "catalogue" / "plans.json"

#: Families the audit covers: the discoverable routes in this profile plus the
#: coding-plan families that are catalogue-only until a credential exists.
#: opencode-go is a separate route from opencode-zen: a subscription with its own
#: plans, not the metered relay.
EXPECTED_FAMILIES = {
    "openai-codex", "anthropic", "commandcode", "xai-oauth", "github-copilot",
    "nous", "openrouter", "opencode-zen", "opencode-go", "zai-coding-plan",
    "minimax-coding-plan", "kimi-code-plan-global", "alibaba-coding-plan",
    "tencent-coding-plan", "volcengine-coding-plan", "cline-pass",
    "umans-ai-coding-plan", "ollama-cloud", "huggingface", "kilocode",
    "x-subscription",  # Current X tiers; legacy SuperGrok stays under xai-oauth.
}

#: Families with no verified subscription price. commandcode left this set on
#: 2026-10-30 and ollama-cloud/huggingface/kilocode left it on 2026-10-31, each
#: when the vendor's own page was read and cited. alibaba-coding-plan left it
#: on 2026-11-04 when the Coding Plan docs priced Pro at $50/month, and
#: tencent-coding-plan left it the same day when the Token Plan split into
#: four priced tiers. The credits arrangements stay: they publish a balance
#: model, not a monthly price.
PLACEHOLDER_ONLY = {
    "xai-oauth", "opencode-zen",
    "minimax-coding-plan", "kimi-code-plan-global",
    "volcengine-coding-plan", "cline-pass",
    "umans-ai-coding-plan",
}


class CoverageAuditTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.catalogue = M.load_plan_catalogue(CATALOGUE)
        cls.plans = cls.catalogue["plans"]

    def test_every_audited_family_has_a_plan(self):
        families = {p["provider_family"] for p in self.plans}
        self.assertEqual(families, EXPECTED_FAMILIES)

    def test_totals_match_the_audit(self):
        verified = [p for p in self.plans if p["price"]["amount"] is not None
                    and p["verification"]["status"] == "verified"]
        provisional = [p for p in self.plans if p["price"]["amount"] is not None
                       and p["verification"]["status"] == "provisional"]
        placeholders = [p for p in self.plans if p["price"]["amount"] is None]
        # Pinned deliberately: a newly verified price must move these numbers and
        # scripts/plan-coverage.py's table together.
        self.assertEqual(len(self.plans), 59)
        self.assertEqual(len(verified), 46)
        self.assertEqual(len(provisional), 1)
        self.assertEqual(len(placeholders), 12)

    def test_verified_price_needs_a_source_and_a_date(self):
        for plan in self.plans:
            if plan["price"]["amount"] is None:
                continue
            if plan["verification"]["status"] != "verified":
                continue
            self.assertTrue(plan["verification"].get("checked_at"), plan["id"])
            self.assertTrue(plan["verification"].get("source_id"), plan["id"])

    def test_every_priced_plan_names_its_currency(self):
        for plan in self.plans:
            if plan["price"]["amount"] is None:
                continue
            self.assertIn(plan["price"]["currency"], M.CURRENCIES, plan["id"])

    def test_placeholder_families_claim_no_verified_price(self):
        for family in PLACEHOLDER_ONLY:
            verified = [p for p in self.plans
                        if p["provider_family"] == family
                        and p["price"]["amount"] is not None
                        and p["verification"]["status"] == "verified"]
            self.assertEqual(verified, [], f"{family} is placeholder-only in the audit")

    def test_plans_are_discoverable_by_route_slug(self):
        for plan in self.plans:
            self.assertTrue(plan["route_slugs"], plan["id"])

    def test_catalogue_has_no_unlisted_family(self):
        listed = {p["provider_family"] for p in self.plans}
        self.assertFalse(listed - EXPECTED_FAMILIES)

    def test_native_usage_families_are_present(self):
        # Hermes 0.22.5 ships built-in fetchers for exactly these three.
        families = {p["provider_family"] for p in self.plans}
        for family in ("openai-codex", "anthropic", "openrouter"):
            self.assertIn(family, families)


class IdentitySplitTests(unittest.TestCase):
    """Tier splits keep the legacy entry and never reuse its identity."""

    @classmethod
    def setUpClass(cls):
        cls.catalogue = M.load_plan_catalogue(CATALOGUE)
        cls.by_id = {p["id"]: p for p in cls.catalogue["plans"]}

    def test_tencent_split_keeps_the_generic_entry_unpriced(self):
        generic = self.by_id["tencent-coding-plan.standard"]
        self.assertIsNone(generic["price"]["amount"])
        self.assertEqual(generic["verification"]["status"], "unverified")
        tiers = {pid: self.by_id[pid] for pid in (
            "tencent-coding-plan.token-lite",
            "tencent-coding-plan.token-standard",
            "tencent-coding-plan.token-pro",
            "tencent-coding-plan.token-max")}
        self.assertEqual(
            {p["price"]["amount"] for p in tiers.values()},
            {7.0, 17.0, 51.0, 103.0})
        for pid, plan in tiers.items():
            self.assertEqual(plan["provider_family"], "tencent-coding-plan", pid)
            self.assertEqual(plan["verification"]["status"], "verified", pid)
            self.assertEqual(plan["route_slugs"], ["tencent-coding-plan"], pid)
            self.assertEqual(len(plan["entitlements"]["windows"]), 1, pid)

    def test_x_subscription_is_separate_from_legacy_supergrok(self):
        legacy = self.by_id["xai-oauth.supergrok"]
        self.assertEqual(legacy["provider_family"], "xai-oauth")
        self.assertEqual(legacy["route_slugs"], ["xai-oauth"])
        self.assertIsNone(legacy["price"]["amount"])
        self.assertEqual(legacy["verification"]["status"], "unverified")
        current = [p for p in self.catalogue["plans"]
                   if p["provider_family"] == "x-subscription"]
        self.assertEqual(len(current), 7)
        for plan in current:
            self.assertEqual(plan["route_slugs"], ["x-subscription"], plan["id"])
            self.assertNotEqual(plan["id"], "xai-oauth.supergrok")
        priced = {p["id"]: p["price"]["amount"] for p in current
                  if p["price"]["amount"] is not None}
        self.assertEqual(priced, {
            "x-subscription.free": 0.0,
            "x-subscription.plus": 8.0,
            "x-subscription.premium": 30.0,
            "x-subscription.super": 100.0,
            "x-subscription.ultra": 200.0,
            "x-subscription.teams": 30.0,
        })

    def test_business_standard_was_renamed_not_replaced(self):
        standard = self.by_id["openai-codex.chatgpt-business"]
        self.assertEqual(standard["name"], "ChatGPT Business Standard")
        self.assertEqual(standard["verification"]["status"], "verified")
        premium = self.by_id["openai-codex.chatgpt-business-premium"]
        self.assertEqual(premium["price"]["amount"], 125.0)
        self.assertEqual(premium["verification"]["status"], "verified")
        self.assertEqual(premium["provider_family"], "openai-codex")

    def test_umans_is_a_prepaid_wallet_without_a_price(self):
        umans = self.by_id["umans-ai-coding-plan.standard"]
        self.assertEqual(umans["kind"], "prepaid")
        self.assertEqual(umans["billing_arrangement"], "prepaid_metered_wallet")
        self.assertIsNone(umans["price"]["amount"])
        self.assertEqual(umans["verification"]["status"], "unverified")


if __name__ == "__main__":
    unittest.main()
