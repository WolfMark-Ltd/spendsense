"""Billing-profile precedence, credits and presentation."""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
import os

from wolfmark_ledger import billing


def row(provider="commandcode", model="m", value=1.0, tokens=1000, when=None, **kw):
    base = {"provider": provider, "model": model, "list_usd": value, "_tokens": tokens,
            "_input": 0, "_output": 0, "_cache_read": 0, "_cache_write": 0, "last_seen": when}
    base.update(kw)
    return base


class BillingTests(unittest.TestCase):
    def profiles(self, data):
        handle = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False)
        json.dump(data, handle)
        handle.close()
        self.addCleanup(lambda: os.unlink(handle.name))
        return billing.load_profiles(Path(handle.name))

    def test_precedence_route_then_provider_then_defaults_then_unknown(self):
        loaded = self.profiles({"defaults": {"kind": "api"}, "profiles": [
            {"id": "p", "provider": "commandcode", "kind": "subscription_included"},
            {"id": "r", "provider": "commandcode", "model": "m", "kind": "subscription_credits"},
        ]})
        self.assertEqual(billing.select(loaded, "commandcode", "m")[1], "route")
        self.assertEqual(billing.select(loaded, "commandcode", "other")[1], "provider")
        self.assertEqual(billing.select(loaded, "nous", "x")[1], "defaults")
        empty = billing.load_profiles(Path("/nonexistent/profiles.json"))
        self.assertEqual(billing.select(empty, "nous", "x")[1], "unknown")

    def test_effective_dates_exclude_earlier_usage(self):
        loaded = self.profiles({"profiles": [
            {"id": "sub", "provider": "commandcode", "kind": "subscription_included",
             "effective_from": "2026-10-01T00:00:00+00:00"}]})
        from datetime import datetime, timezone
        before = datetime(2026, 9, 15, tzinfo=timezone.utc).timestamp()
        after = datetime(2026, 10, 15, tzinfo=timezone.utc).timestamp()
        self.assertEqual(billing.select(loaded, "commandcode", "m", before)[1], "unknown")
        self.assertEqual(billing.select(loaded, "commandcode", "m", after)[1], "provider")
        report = billing.classify([row(when=before), row(when=after)], loaded)
        self.assertEqual(report["by_kind"]["unknown"]["calls"], 2)
        self.assertEqual(report["legacy_membership_arrangements_ignored"], 1)

    def test_included_subscription_is_not_extra_cash(self):
        loaded = self.profiles({"profiles": [
            {"id": "codex", "provider": "commandcode", "kind": "subscription_included",
             "monthly_fee_usd": 20}]})
        report = billing.classify([row(value=2.0), row(value=3.0)], loaded)
        self.assertAlmostEqual(report["api_equivalent_usd"], 5.0)
        self.assertAlmostEqual(report["incremental_usd"], 0.0)
        self.assertAlmostEqual(report["credits_consumed_usd"], 0.0)
        self.assertEqual(report["subscription_fees_usd"], 0.0)
        self.assertEqual(report["legacy_membership_arrangements_ignored"], 1)
        self.assertEqual(report["by_kind"]["unknown"]["calls"], 2)

    def test_api_plan_counts_every_call_as_spend(self):
        loaded = self.profiles({"profiles": [{"id": "payg", "provider": "commandcode", "kind": "api"}]})
        report = billing.classify([row(value=1.5), row(value=2.5)], loaded)
        self.assertAlmostEqual(report["incremental_usd"], 4.0)
        self.assertAlmostEqual(report["credits_consumed_usd"], 0.0)

    def test_custom_override_replaces_the_catalogue_value(self):
        loaded = self.profiles({"profiles": [
            {"id": "contract", "provider": "commandcode", "kind": "custom",
             "rate_override": {"input": 1, "output": 2}}]})
        report = billing.classify([row(value=99, _input=1_000_000, _output=1_000_000)], loaded)
        self.assertAlmostEqual(report["api_equivalent_usd"], 3.0)

    def test_unpriced_rows_are_reported_not_dropped(self):
        loaded = self.profiles({"profiles": []})
        report = billing.classify([row(value=None, tokens=50)], loaded)
        self.assertEqual(report["unclassified_tokens"], 50)
        self.assertEqual(report["unclassified_calls"], 1)
        self.assertIsNone(report["api_equivalent_usd"])
        self.assertEqual(report["evidence"]["api_equivalent"]["basis"], "unpriced")

    def test_presentation_is_echoed_and_invalid_falls_back(self):
        self.assertEqual(billing.classify([], {}, "spend")["presentation"], "spend")
        self.assertEqual(billing.classify([], {}, "nonsense")["presentation"], "both")

    def test_legacy_subscription_kinds_cannot_be_saved_as_advanced_rules(self):
        errors = billing.validation_errors({"id": "plus", "provider": "openai-codex",
                                            "kind": "subscription_included"})
        self.assertTrue(any("managed in Memberships" in item for item in errors))

    def test_corrupt_profile_store_is_not_partially_read(self):
        handle = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False)
        json.dump({"profiles": [
            {"id": "valid", "provider": "openai", "kind": "api"},
            {"id": "broken", "provider": "", "kind": "api"},
        ]}, handle)
        handle.close()
        self.addCleanup(lambda: os.unlink(handle.name))
        loaded = billing.load_profiles(Path(handle.name))
        self.assertEqual(loaded["profiles"], [])
        self.assertFalse(loaded["loaded"])
        self.assertIn("unreadable", loaded["error"])

    def test_profile_write_and_delete_fail_closed_on_malformed_existing_store(self):
        path = Path(tempfile.mktemp(suffix=".json"))
        original = '{"profiles": [{"id": "valid", "provider": "openai", "kind": "api"}, 4]}'
        path.write_text(original)
        self.addCleanup(lambda: path.unlink(missing_ok=True))
        profile = {"id": "next", "provider": "openai", "kind": "api"}
        with self.assertRaises(billing.ProfileStoreUnreadable):
            billing.save_profile(profile, path)
        with self.assertRaises(billing.ProfileStoreUnreadable):
            billing.delete_profile("valid", path)
        self.assertEqual(path.read_text(), original)

    def test_advanced_profile_revision_is_accepted_and_preserved_on_edit(self):
        path = Path(tempfile.mktemp(suffix=".json"))
        self.addCleanup(lambda: path.unlink(missing_ok=True))
        saved = billing.save_profile({"id": "rule", "provider": "openai", "kind": "prepaid"}, path)
        current = saved["profiles"][0]
        changed = billing.save_profile({**current, "label": "Wallet"}, path, if_rev=current["rev"])
        self.assertEqual(changed["profiles"][0]["label"], "Wallet")




class CommandCodeGoatReconciliation(unittest.TestCase):
    """Synthetic example: credit consumption is not extra cash."""

    def profiles(self, data):
        handle = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False)
        json.dump(data, handle)
        handle.close()
        self.addCleanup(lambda: os.unlink(handle.name))
        return billing.load_profiles(Path(handle.name))

    def setUp(self):
        self.fixture = {"membership": {"monthly_fee_usd": 10}, "provider_history_sample": {"provider_reported_usd": 0.25, "input_tokens": 100, "output_tokens": 20}, "billing_month": {"usage_limits_pct": {"five_hour": 1, "weekly": 2, "monthly": 3}}}
        self.sample = self.fixture["provider_history_sample"]

    def test_provider_reported_value_is_metered_evidence_not_cash(self):
        loaded = self.profiles({"profiles": [{
            "id": "goat", "provider": "commandcode", "kind": "prepaid",
            "monthly_fee_usd": self.fixture["membership"]["monthly_fee_usd"],
            "count_credits_as_spend": False}]})
        row = {"provider": "commandcode", "model": "deepseek/deepseek-v4.1-flash",
               "list_usd": None, "_provider_cost_usd": self.sample["provider_reported_usd"],
               "_tokens": self.sample["input_tokens"] + self.sample["output_tokens"],
               "_input": 0, "_output": 0, "_cache_read": 0, "_cache_write": 0, "last_seen": None}
        report = billing.classify([row], loaded)
        self.assertAlmostEqual(report["provider_reported_usd"], 0.25)
        self.assertAlmostEqual(report["metered_usd"], 0.25)
        self.assertAlmostEqual(report["incremental_usd"], 0.0, msg="credits are not extra cash")
        self.assertAlmostEqual(report["credits_consumed_usd"], 0.25)
        self.assertEqual(report["subscription_fees_usd"], 0.0)
        self.assertEqual(report["by_kind"]["prepaid"]["calls"], 1)

    def test_api_equivalent_stays_separate_from_provider_value(self):
        loaded = self.profiles({"profiles": [{"id": "goat", "provider": "commandcode",
                                              "kind": "subscription_credits"}]})
        row = {"provider": "commandcode", "model": "m", "list_usd": 0.5,
               "_provider_cost_usd": 0.25, "_tokens": 100, "_input": 0, "_output": 0,
               "_cache_read": 0, "_cache_write": 0, "last_seen": None}
        report = billing.classify([row], loaded)
        self.assertAlmostEqual(report["api_equivalent_usd"], 0.5)
        self.assertAlmostEqual(report["metered_usd"], 0.25, msg="metered uses the provider figure")

    def test_usage_limits_are_not_treated_as_money(self):
        limits = self.fixture["billing_month"]["usage_limits_pct"]
        loaded = self.profiles({"profiles": []})
        report = billing.classify([], loaded)
        self.assertNotIn("monthly", report)
        self.assertEqual(sorted(limits), ["five_hour", "monthly", "weekly"])


class EvidenceBasisTests(unittest.TestCase):
    def profiles(self, data):
        handle = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False)
        json.dump(data, handle); handle.close()
        self.addCleanup(lambda: os.unlink(handle.name))
        return billing.load_profiles(Path(handle.name))

    def test_only_provider_reported_value_is_confirmed(self):
        loaded = self.profiles({"profiles": [{"id": "wallet", "provider": "commandcode",
                                              "kind": "prepaid", "monthly_fee_usd": 10}]})
        report = billing.classify([{"provider": "commandcode", "model": "m", "list_usd": 0.5,
                                    "_provider_cost_usd": 0.25, "_tokens": 10, "_input": 0,
                                    "_output": 0, "_cache_read": 0, "_cache_write": 0,
                                    "last_seen": None}], loaded)
        ev = report["evidence"]
        self.assertEqual(ev["provider_reported"]["basis"], "confirmed")
        self.assertEqual(ev["credits_consumed"]["basis"], "inferred")
        self.assertEqual(ev["subscription_fee"]["basis"], "none")
        self.assertEqual(ev["api_equivalent"]["basis"], "estimated")

    def test_per_model_allowance_and_overage(self):
        loaded = self.profiles({"profiles": [{
            "id": "wallet", "provider": "commandcode", "kind": "prepaid",
            "allowances": {"deepseek/deepseek-v4.1-flash": 0.10},
            "overage_paid": True}]})
        row = {"provider": "commandcode", "model": "deepseek/deepseek-v4.1-flash",
               "list_usd": 0.30, "_tokens": 10, "_input": 0, "_output": 0,
               "_cache_read": 0, "_cache_write": 0, "last_seen": None}
        report = billing.classify([row], loaded)
        self.assertAlmostEqual(report["incremental_usd"], 0.20, msg="only the overage is extra cash")


if __name__ == "__main__":
    unittest.main()
