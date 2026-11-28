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

    def test_api_plan_counts_effective_rates_as_spend(self):
        loaded = self.profiles({"profiles": [{"id": "payg", "provider": "nous", "kind": "api"}]})
        rows = [row(provider="nous", model="deepseek/x", value=0.193,
                    native_effective_usd=0.039)]
        report = billing.classify(rows, loaded)
        self.assertAlmostEqual(report["incremental_usd"], 0.039)
        self.assertAlmostEqual(report["credits_consumed_usd"], 0.0)

    def test_custom_override_replaces_the_catalogue_value(self):
        loaded = self.profiles({"profiles": [
            {"id": "contract", "provider": "commandcode", "kind": "custom",
             "rate_override": {"input": 1, "output": 2}}]})
        report = billing.classify([row(value=99, _input=1_000_000, _output=1_000_000)], loaded)
        self.assertAlmostEqual(report["api_equivalent_usd"], 3.0)
        self.assertEqual(report["evidence"]["api_equivalent"]["source"], "configured custom rate overrides")

    def test_unpriced_rows_are_reported_not_dropped(self):
        loaded = self.profiles({"profiles": []})
        report = billing.classify([row(value=None, tokens=50)], loaded)
        self.assertEqual(report["unclassified_tokens"], 50)
        self.assertEqual(report["unclassified_calls"], 1)
        self.assertEqual(report["unclassified_missing_rule_calls"], 1)
        self.assertEqual(report["unclassified_missing_evidence_calls"], 0)
        self.assertIsNone(report["api_equivalent_usd"])
        self.assertEqual(report["evidence"]["api_equivalent"]["basis"], "unpriced")

    def test_matching_rule_with_no_price_or_charge_is_not_a_missing_rule(self):
        loaded = self.profiles({"profiles": [
            {"id": "api", "provider": "commandcode", "kind": "api"}]})
        report = billing.classify([row(value=None, tokens=50)], loaded)
        self.assertEqual(report["unclassified_calls"], 1)
        self.assertEqual(report["unclassified_missing_rule_calls"], 0)
        self.assertEqual(report["unclassified_missing_evidence_calls"], 1)

    def test_presentation_is_echoed_and_invalid_falls_back(self):
        self.assertEqual(billing.classify([], {}, "spend")["presentation"], "spend")
        self.assertEqual(billing.classify([], {}, "nonsense")["presentation"], "both")

    def test_billing_basis_exact_for_complete_catalogue_rows(self):
        loaded = self.profiles({"profiles": [
            {"id": "payg", "provider": "commandcode", "kind": "api"}]})
        report = billing.classify([row(value=1.5), row(value=2.5)], loaded)
        evidence = report["evidence"]["api_equivalent"]
        self.assertEqual((evidence["billing_basis"], evidence["billing_bound_reason"]),
                         ("exact", None))

    def test_billing_basis_lower_bound_from_catalogue_row_bounds(self):
        loaded = self.profiles({"profiles": [
            {"id": "payg", "provider": "commandcode", "kind": "api"}]})
        report = billing.classify(
            [row(value=1.5, _cost_bounds=("lower",), _cost_causes=("write",))],
            loaded)
        evidence = report["evidence"]["api_equivalent"]
        self.assertEqual((evidence["billing_basis"], evidence["billing_bound_reason"]),
                         ("lower_bound", "write_not_reported"))

    def test_billing_basis_exact_for_complete_custom_override(self):
        # Review case: an unlisted model with known token counts and
        # configured rates is exact under its own rates, whatever the
        # catalogue basis says about the same rows.
        loaded = self.profiles({"profiles": [
            {"id": "contract", "provider": "commandcode", "kind": "custom",
             "rate_override": {"input": 1, "output": 2}}]})
        report = billing.classify([row(value=None, _input=1_000_000, _output=1_000_000,
                                       _cache_read_reported=True, _cache_write_reported=True)],
                                  loaded)
        evidence = report["evidence"]["api_equivalent"]
        self.assertEqual(evidence["source"], "configured custom rate overrides")
        self.assertEqual((evidence["billing_basis"], evidence["billing_bound_reason"]),
                         ("exact", None))

    def test_billing_basis_lower_bound_for_override_with_unproven_write(self):
        loaded = self.profiles({"profiles": [
            {"id": "contract", "provider": "commandcode", "kind": "custom",
             "rate_override": {"input": 1, "output": 2}}]})
        report = billing.classify([row(value=None, _input=1_000_000, _output=1_000_000,
                                       _cache_read_reported=True,
                                       _cache_write_reported=False)],
                                  loaded)
        evidence = report["evidence"]["api_equivalent"]
        self.assertEqual((evidence["billing_basis"], evidence["billing_bound_reason"]),
                         ("lower_bound", "write_not_reported"))

    def test_billing_basis_ignores_cycle_excluded_rows(self):
        # Review case: an excluded call's missing counters must not bound
        # the displayed subtotal, which sums only in-cycle rows.
        import time
        now = time.time()
        loaded = self.profiles({"profiles": [
            {"id": "cycle", "provider": "commandcode", "kind": "api",
             "billing_cycle": {"day": 1}}]})
        report = billing.classify([
            row(value=1.5, when=now),
            row(value=99.0, when=now - 60 * 86400,
                _cost_bounds=("lower",), _cost_causes=("write",)),
        ], loaded)
        self.assertEqual(report["excluded_out_of_cycle"], 1)
        self.assertAlmostEqual(report["api_equivalent_usd"], 1.5)
        evidence = report["evidence"]["api_equivalent"]
        self.assertEqual((evidence["billing_basis"], evidence["billing_bound_reason"]),
                         ("exact", None))

    def test_billing_basis_incomplete_with_unpriced_tokens(self):
        loaded = self.profiles({"profiles": [
            {"id": "payg", "provider": "commandcode", "kind": "api"}]})
        report = billing.classify([row(value=1.5), row(value=None, tokens=50)], loaded)
        evidence = report["evidence"]["api_equivalent"]
        self.assertEqual((evidence["billing_basis"], evidence["billing_bound_reason"]),
                         ("incomplete", "unpriced_tokens"))

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

    def test_api_equivalent_coverage_uses_the_same_rows_as_its_priced_subtotal(self):
        loaded = self.profiles({"profiles": []})
        rows = [
            row(value=0.5, tokens=100, _provider_cost_usd=0.25),
            row(value=None, tokens=50, _provider_cost_usd=0.10),
            row(value=None, tokens=25, _provider_cost_usd=None),
        ]
        report = billing.classify(rows, loaded)

        self.assertAlmostEqual(report["api_equivalent_usd"], 0.5,
                               msg="coverage metadata does not change the priced API-equivalent subtotal")
        self.assertEqual(report["evidence"]["api_equivalent"]["pricing_coverage"], {
            "priced_tokens": 100, "unpriced_tokens": 75,
            "priced_calls": 1, "unpriced_calls": 2,
            "scope": "same rows used for api_equivalent_usd",
        })

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




class MeteredBasisTests(unittest.TestCase):
    """Applicable metered expenditure: effective provider rates first.

    A free or promotional credits plan is a metered API account, not a
    subscription: without a provider-reported debit, its metered cost is the
    estimate at the provider's own billed (effective) rates — never the
    undiscounted list price. Subscription-included routes keep the list
    API-equivalent as the value the membership received.
    """

    def profiles(self, data):
        handle = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False)
        json.dump(data, handle)
        handle.close()
        self.addCleanup(lambda: os.unlink(handle.name))
        return billing.load_profiles(Path(handle.name))

    def test_metered_uses_effective_rates_not_list(self):
        # The `free` profile kind is a legacy membership copy (Memberships
        # owns subscription arrangements); credits accounts are `prepaid`.
        loaded = self.profiles({"profiles": [{"id": "nous", "provider": "nous", "kind": "prepaid"}]})
        rows = [row(provider="nous", model="deepseek/x", value=0.193,
                    native_effective_usd=0.039)]
        report = billing.classify(rows, loaded)
        self.assertAlmostEqual(report["by_kind"]["prepaid"]["metered_usd"], 0.039)
        self.assertAlmostEqual(report["metered_usd"], 0.039)
        # The list API-equivalent is untouched: it stays the comparator.
        self.assertAlmostEqual(report["by_kind"]["prepaid"]["api_equivalent_usd"], 0.193)

    def test_legacy_free_profile_still_meters_effective_as_unknown(self):
        # A free credits plan is a metered API account, not a subscription:
        # with the legacy kind ignored, the route is unclassified — and an
        # unclassified route is still metered at the applicable rates.
        rows = [row(provider="nous", model="deepseek/x", value=0.193,
                    native_effective_usd=0.039)]
        report = billing.classify(rows, self.profiles({}))
        self.assertAlmostEqual(report["by_kind"]["unknown"]["metered_usd"], 0.039)
        self.assertAlmostEqual(report["api_equivalent_usd"], 0.193)

    def test_unclassified_routes_are_metered_effective_too(self):
        rows = [row(provider="nous", model="deepseek/x", value=0.193,
                    native_effective_usd=0.039)]
        report = billing.classify(rows, self.profiles({}))
        self.assertAlmostEqual(report["by_kind"]["unknown"]["metered_usd"], 0.039)
        self.assertAlmostEqual(report["api_equivalent_usd"], 0.193)

    def test_metered_falls_back_to_list_without_effective_rates(self):
        # Catalogue-priced providers publish no separate effective rates: their
        # public catalogue price IS the applicable rate, so the metered figure
        # is unchanged.
        rows = [row(provider="commandcode", model="deepseek/y", value=0.5)]
        report = billing.classify(rows, self.profiles({}))
        self.assertAlmostEqual(report["by_kind"]["unknown"]["metered_usd"], 0.5)

    def test_provider_reported_evidence_wins_over_the_estimate(self):
        # A real provider-reported debit is the strongest evidence for the
        # metered figure; the effective-rate estimate is only the fallback.
        loaded = self.profiles({"profiles": [{"id": "nous", "provider": "nous", "kind": "prepaid"}]})
        rows = [row(provider="nous", model="deepseek/x", value=0.193,
                    native_effective_usd=0.039, _provider_cost_usd=0.045)]
        report = billing.classify(rows, loaded)
        self.assertAlmostEqual(report["by_kind"]["prepaid"]["metered_usd"], 0.045)

    def test_custom_rule_without_override_meters_the_effective_rate(self):
        # A saved custom rule that omits rate_override must not measure a
        # known positive cost as zero: the applicable effective rate applies.
        loaded = self.profiles({"profiles": [{"id": "r", "provider": "nous", "kind": "custom"}]})
        rows = [row(provider="nous", model="deepseek/x", value=None,
                    native_effective_usd=0.039)]
        report = billing.classify(rows, loaded)
        self.assertAlmostEqual(report["by_kind"]["custom"]["metered_usd"], 0.039)

    def test_custom_override_still_wins_over_the_effective_estimate(self):
        loaded = self.profiles({"profiles": [{"id": "r", "provider": "nous", "kind": "custom",
                                              "rate_override": {"input": 0.9, "output": 4.5}}]})
        rows = [row(provider="nous", model="deepseek/x", value=0.193,
                    native_effective_usd=0.039, _tokens=1_000_000, _input=1_000_000)]
        report = billing.classify(rows, loaded)
        # The explicit user rate (0.9/MTok input) replaces both the list and
        # the provider estimate for this route.
        self.assertAlmostEqual(report["by_kind"]["custom"]["metered_usd"], 0.9)
        self.assertAlmostEqual(report["by_kind"]["custom"]["api_equivalent_usd"], 0.9)


class SharedExpenditureFixture(unittest.TestCase):
    """The agreed billing-model regression fixture.

    One population, three billing models, one shared expenditure result:

    - Subscription-included usage: $10 list, $0 expenditure.
    - Nous credits: $0.30 list, $0.06 expenditure (applicable effective
      rates — purchased credits are real expenditure as consumed).
    - OpenRouter: $0.50 list, $0.50 expenditure (its public catalogue rate
      IS the applicable price).

    Expected combined totals: API-equivalent value $10.80; API expenditure
    $0.56. Adding another provider never changes the pricing basis of
    previously recorded calls: the figure is composed per call.
    """

    def profiles(self, data):
        handle = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False)
        json.dump(data, handle)
        handle.close()
        self.addCleanup(lambda: os.unlink(handle.name))
        return billing.load_profiles(Path(handle.name))

    def test_agreed_fixture_totals(self):
        # The codex route carries a membership-resolved 'included' arrangement
        # (the authoritative classification source), so its usage is exempt.
        rows = [
            # Subscription-included: priced at list by the route card, no
            # native effective rates — expenditure $0.
            row(provider="codex", model="gpt/x", value=10.0, tokens=10_000_000),
            # Nous credits: native effective rates apply ($0.06), list $0.30.
            row(provider="nous", model="deepseek/x", value=0.30, tokens=1_000_000,
                native_effective_usd=0.06),
            # OpenRouter: catalogue price IS the applicable price.
            row(provider="openrouter", model="or/x", value=0.50, tokens=1_000_000),
        ]
        report = billing.classify(rows, self.profiles({}),
                                  route_arrangements={"codex": "included"})
        self.assertAlmostEqual(report["api_equivalent_usd"], 10.80, places=6)
        self.assertAlmostEqual(report["metered_usd"], 0.56, places=6)
        # The included allowance value stays visible as credits consumed,
        # never as expenditure.
        self.assertAlmostEqual(report["credits_consumed_usd"], 10.0, places=6)
        self.assertAlmostEqual(report["incremental_usd"], 0.0, places=6)

    def test_adding_a_provider_never_rebases_recorded_calls(self):
        loaded = self.profiles({})
        nous = row(provider="nous", model="deepseek/x", value=0.30, tokens=1_000_000,
                   native_effective_usd=0.06)
        before = billing.classify([nous], loaded)
        after = billing.classify([nous, row(provider="openrouter", model="or/x",
                                            value=0.50, tokens=1_000_000)], loaded)
        self.assertAlmostEqual(before["by_kind"]["unknown"]["metered_usd"], 0.06, places=6)
        self.assertAlmostEqual(after["by_kind"]["unknown"]["metered_usd"], 0.56, places=6)
        # The nous call's own expenditure is unchanged: composition is per call.
        self.assertAlmostEqual(after["metered_usd"] - before["metered_usd"], 0.50, places=6)

    def test_classify_consumes_the_shared_row_expenditure(self):
        # One accounting path: when rows carry the expenditure the aggregate
        # already computed, classification consumes that figure instead of
        # recomputing from the list/legacy legs. An included row priced by a
        # catalogue card with a retention range stays a measured zero even
        # though the classification sees no arrangement of its own.
        rows = [row(provider="commandcode", model="claude/x", value=0.528,
                    tokens=1_000_000, expenditure_usd=0.0,
                    expenditure_basis="included")]
        report = billing.classify(rows, self.profiles({}))
        self.assertAlmostEqual(report["metered_usd"], 0.0, places=6)
        self.assertAlmostEqual(report["api_equivalent_usd"], 0.528, places=6)
        # The same row without the included class meters the row's own
        # figure — never the legacy list leg.
        rows = [row(provider="nous", model="deepseek/x", value=0.30,
                    tokens=1_000_000, expenditure_usd=0.06,
                    expenditure_basis="exact")]
        report = billing.classify(rows, self.profiles({}))
        self.assertAlmostEqual(report["metered_usd"], 0.06, places=6)

    def test_suffixed_route_slug_matches_only_its_model_family(self):
        # A wire-family slug (commandcode-anthropic) claims only the models
        # of that family — never the provider's other routes.
        from wolfmark_ledger.membership_api import route_matches
        self.assertTrue(route_matches("nous", "nous", "deepseek/x"))
        self.assertTrue(route_matches("commandcode-anthropic", "commandcode",
                                      "claude/fable-5"))
        self.assertTrue(route_matches("commandcode-anthropic", "commandcode",
                                      "claude-fable-5"))
        # Other families of the same provider are NOT governed by the slug.
        self.assertFalse(route_matches("commandcode-anthropic", "commandcode",
                                       "deepseek/deepseek-v4.1"))
        self.assertFalse(route_matches("commandcode-anthropic", "commandcode",
                                       "z-ai/glm-5"))
        # An unknown family suffix claims nothing.
        self.assertFalse(route_matches("commandcode-mystery", "commandcode",
                                       "claude/fable-5"))

    def test_family_slug_classification_zeroes_only_family_models(self):
        # commandcode-anthropic included: claude models measure zero, the
        # provider's other models stay metered at their applicable rates.
        rows = [
            row(provider="commandcode", model="claude/fable-5", value=1.0,
                tokens=1_000_000, expenditure_usd=0.02, expenditure_basis="exact"),
            row(provider="commandcode", model="deepseek/deepseek-v4.1", value=1.0,
                tokens=1_000_000, expenditure_usd=0.02, expenditure_basis="exact"),
        ]
        report = billing.classify(rows, self.profiles({}),
                                  route_arrangements={"commandcode-anthropic": "included"})
        self.assertAlmostEqual(report["metered_usd"], 0.02, places=6)
        self.assertAlmostEqual(report["api_equivalent_usd"], 2.0, places=6)

    def test_arrangement_map_keys_are_normalised(self):
        from wolfmark_ledger.membership_api import route_arrangements_payload
        # The lookup is lowercase on both sides; an uppercase map key still
        # classifies the route.
        rows = [row(provider="openrouter", model="or/x", value=0.5,
                    tokens=1_000_000, expenditure_usd=0.5,
                    expenditure_basis="exact")]
        report = billing.classify(rows, self.profiles({}),
                                  route_arrangements={"OpenRouter": "included"})
        self.assertAlmostEqual(report["metered_usd"], 0.0, places=6)

    def test_a_failed_call_with_no_usage_is_a_measured_zero(self):
        # A rate-limited attempt consumed nothing, so nothing about it is
        # unvalued: it must not keep the whole figure qualified as a lower
        # bound. A failed call that DID consume tokens stays unvalued until a
        # price exists, and so does a successful request whose counters never
        # arrived — missing usage is unknown consumption, never a measured
        # zero.
        failed = row(provider="opencode-zen", model="free/x", tokens=0,
                     outcome="error")
        failed["list_usd"] = None
        report = billing.classify([failed], self.profiles({}))
        self.assertEqual(report["metered_calls"], 1)
        self.assertAlmostEqual(report["metered_usd"], 0.0, places=6)
        self.assertEqual(report["unclassified_calls"], 0)
        partial = row(provider="opencode-zen", model="free/x", tokens=500,
                      outcome="error")
        partial["list_usd"] = None
        report = billing.classify([partial], self.profiles({}))
        self.assertEqual(report["unclassified_calls"], 1)
        self.assertEqual(report["metered_calls"], 0)
        missing = row(provider="opencode-zen", model="free/x", tokens=0,
                      outcome="missing_usage", _missing=True)
        missing["list_usd"] = None
        report = billing.classify([missing], self.profiles({}))
        self.assertEqual(report["unclassified_calls"], 1)
        self.assertEqual(report["metered_calls"], 0)

    def test_analytics_and_billing_agree_on_the_same_rows(self):
        # One accounting path, pinned by execution: the same recorded calls
        # through the analytics pipeline (aggregate → totals) and through
        # billing.classify produce the same expenditure figure.
        import time
        from contextlib import closing
        import sqlite3
        from unittest.mock import patch
        from wolfmark_ledger import store
        from wolfmark_ledger.analytics import build_analytics_report
        from wolfmark_ledger.pricing import Catalogue, Rate
        with tempfile.TemporaryDirectory(dir=os.environ.get("TMPDIR")) as scratch:
            events = Path(scratch) / "usage.db"
            with closing(sqlite3.connect(events)) as conn, conn:
                conn.executescript(store._SCHEMA)
                ts = time.time() - 1
                conn.executemany(
                    "INSERT INTO calls (event_id,ts,model,provider,platform,aux_task,"
                    "outcome,input_tokens,cache_read_tokens,recorded_at) "
                    "VALUES (?,?,?,?,?,?,?,?,?,?)",
                    [("a", ts, "deepseek/x", "nous", "desktop", "", "ok", 100, 200, 1),
                     ("b", ts, "or/x", "openrouter", "desktop", "", "ok", 300, 0, 1)],
                )
            book = Catalogue({"nous": {"deepseek/x": Rate(2, 4, .5, 3)},
                              "openrouter": {"or/x": Rate(1, 2, .5, 3)}},
                             "fixture", "test", "", "1")
            with patch.object(store, "event_db_path", return_value=events), \
                 patch.object(store, "default_db_path", return_value=Path(scratch) / "none.db"):
                report = build_analytics_report(days=30, catalogue=book,
                                                profiles_path=Path("/nonexistent/profiles.json"))
            rows = None
            with closing(sqlite3.connect(events)) as conn:
                conn.row_factory = sqlite3.Row
                rows = store.query_calls(conn, since=0, until=time.time() + 60)
            from wolfmark_ledger.aggregate import _event_result
            enriched = [_event_result(r, book, "hybrid", {}, at=r.get("ts")) for r in rows]
            billing_report = billing.classify(enriched, self.profiles({}))
            analytics_exp = report["totals"].get("api_expenditure_usd")
            self.assertIsNotNone(analytics_exp)
            self.assertAlmostEqual(billing_report["metered_usd"], analytics_exp, places=6)


if __name__ == "__main__":
    unittest.main()
