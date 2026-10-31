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
}

#: Families with no verified subscription price. commandcode left this set on
#: 2026-10-30 and ollama-cloud/huggingface/kilocode left it on 2026-10-31, each
#: when the vendor's own page was read and cited. The credits arrangements stay:
#: they publish a balance model, not a monthly price.
PLACEHOLDER_ONLY = {
    "xai-oauth", "opencode-zen",
    "minimax-coding-plan", "kimi-code-plan-global", "alibaba-coding-plan",
    "tencent-coding-plan", "volcengine-coding-plan", "cline-pass",
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
        self.assertEqual(len(self.plans), 47)
        self.assertEqual(len(verified), 32)
        self.assertEqual(len(provisional), 3)
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


if __name__ == "__main__":
    unittest.main()
