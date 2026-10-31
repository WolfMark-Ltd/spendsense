"""Subscription economics: fee normalisation, attribution and comparison.

Uses isolated SQLite fixtures and synthetic membership stores only. Prices
come from a fixture catalogue, so every expected value below is hand-derived:
Rate(2, 4, .5, 3) prices one million input tokens at exactly $2.00.
"""
from __future__ import annotations

import json
import os
import sqlite3
import tempfile
import unittest
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path

from wolfmark_ledger import economics as E
from wolfmark_ledger import membership as M
from wolfmark_ledger import membership_store as mstore
from wolfmark_ledger import store
from wolfmark_ledger.pricing import Catalogue, Rate

NOW = datetime(2026, 10, 31, 12, tzinfo=timezone.utc).timestamp()


def plans_doc(*plans):
    return M.load_plan_catalogue({"catalogue_version": "test.1", "plans": list(plans)})


PLANS = plans_doc(
    {"id": "test.plus", "provider_family": "test", "name": "Test Plus",
     "price": {"amount": 20.0, "currency": "USD", "period": "month"}},
    {"id": "other.team", "provider_family": "other", "name": "Other Team",
     "price": {"amount": 240.0, "currency": "USD", "period": "year"}},
)


def account(aid, family, **kw):
    base = {"id": aid, "family": family, "label": aid,
            "route_slugs": [family], "credential_present": True,
            "billing_arrangement": "subscription",
            "plan_id": None, "fee_overrides": [], "manual_exhaustions": []}
    base.update(kw)
    return base


def override(amount, currency="USD", period="month", **kw):
    entry = {"id": f"r-{amount}-{period}", "amount": amount,
             "currency": currency, "period": period}
    entry.update(kw)
    return entry


class EconomicsCase(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory(dir=os.environ.get("TMPDIR"))
        self.addCleanup(self.scratch.cleanup)
        self.dir = Path(self.scratch.name)
        self.events = self.dir / "usage.db"
        self.state = self.dir / "state.db"
        self.memberships = self.dir / "memberships.json"
        self.fx = self.dir / "fx-rates.json"
        self.profiles = self.dir / "billing-profiles.json"
        self.book = Catalogue({"test": {"m": Rate(2, 4, .5, 3)},
                               "other": {"m": Rate(2, 4, .5, 3)}},
                              "fixture", "test", "", "1")

    def create_events(self, rows=()):
        with closing(sqlite3.connect(self.events)) as conn, conn:
            conn.executescript(store._SCHEMA)
            for index, row in enumerate(rows):
                values = {"event_id": f"event-{index}", "ts": NOW - 1,
                          "model": "m", "provider": "test", "platform": "desktop",
                          "outcome": "ok", "recorded_at": NOW, **row}
                columns = list(values)
                conn.execute(f"INSERT INTO calls ({','.join(columns)}) VALUES "
                             f"({','.join('?' for _ in columns)})", list(values.values()))

    def write_store(self, accounts):
        self.memberships.write_text(json.dumps({"version": 1, "accounts": accounts}))

    def report(self, **kwargs):
        return E.build_economics_report(
            now=kwargs.pop("now", NOW), event_db_path=self.events,
            state_db_path=self.state, membership_path=self.memberships,
            fx_file=self.fx, catalogue=self.book, plans=kwargs.pop("plans", PLANS),
            profiles_path=self.profiles, **kwargs)

    def anchor_coverage(self):
        # A long-past call proves the window was fully observed without
        # landing in the trend query range.
        self.create_events([{"event_id": "anchor", "ts": NOW - 200 * 86400,
                             "input_tokens": 10}])

    def windowed(self, monthly, result):
        # Window-allocated expenditure behind every same-window difference.
        return round(monthly * result["window_days"] / E.MEAN_MONTH_DAYS, 6)


class NormalisationTests(unittest.TestCase):
    def test_monthly_fee_counts_in_full(self):
        self.assertEqual(E.monthly_equivalent(20, "month"), 20.0)

    def test_annual_fee_contributes_one_twelfth(self):
        self.assertAlmostEqual(E.monthly_equivalent(240, "year"), 20.0)

    def test_quarterly_fee_contributes_one_third(self):
        self.assertAlmostEqual(E.monthly_equivalent(60, "quarter"), 20.0)

    def test_weekly_fee_uses_documented_annualised_factor(self):
        self.assertAlmostEqual(E.monthly_equivalent(5, "week"), 5 * 52 / 12)
        self.assertIn("52", E.monthly_factor_note())

    def test_unknown_period_is_not_zero(self):
        self.assertIsNone(E.monthly_equivalent(20, "fortnight"))
        self.assertIsNone(E.monthly_equivalent(20, None))

    def test_missing_amount_is_not_zero(self):
        self.assertIsNone(E.monthly_equivalent(None, "month"))
        self.assertIsNone(E.monthly_equivalent("20", "month"))
        self.assertIsNone(E.monthly_equivalent(True, "month"))


class RenewalTests(unittest.TestCase):
    def test_monthly_renewal_is_the_next_anchor_day(self):
        at = datetime(2026, 10, 15, 12, tzinfo=timezone.utc).timestamp()
        renewal = E.next_renewal(period="month", anchor_day=12, at=at)
        self.assertTrue(renewal["date_known"])
        self.assertEqual(renewal["date"], "2026-11-12T00:00:00Z")

    def test_monthly_anchor_clamps_to_month_length(self):
        at = datetime(2026, 2, 10, 12, tzinfo=timezone.utc).timestamp()
        renewal = E.next_renewal(period="month", anchor_day=31, at=at)
        self.assertEqual(renewal["date"], "2026-02-28T00:00:00Z")

    def test_annual_renewal_uses_the_anniversary_month(self):
        at = datetime(2026, 10, 31, 12, tzinfo=timezone.utc).timestamp()
        renewal = E.next_renewal(period="year", anchor_day=15,
                                 anniversary="2026-01-15T00:00:00Z", at=at)
        self.assertEqual(renewal["date"], "2027-01-15T00:00:00Z")

    def test_annual_renewal_without_anniversary_has_unknown_date(self):
        renewal = E.next_renewal(period="year", anchor_day=15, at=NOW)
        self.assertIsNone(renewal["date"])
        self.assertFalse(renewal["date_known"])

    def test_quarterly_renewal_steps_three_months(self):
        at = datetime(2026, 10, 31, 12, tzinfo=timezone.utc).timestamp()
        renewal = E.next_renewal(period="quarter", anchor_day=1,
                                 anniversary="2026-01-01T00:00:00Z", at=at)
        self.assertEqual(renewal["date"], "2027-01-01T00:00:00Z")

    def test_weekly_renewal_without_weekday_has_unknown_date(self):
        renewal = E.next_renewal(period="week", at=NOW)
        self.assertIsNone(renewal["date"])

    def test_weekly_renewal_uses_the_anniversary_weekday(self):
        # 2026-01-05 was a Monday; the next Monday after Sat 2026-10-31 is Nov 2.
        renewal = E.next_renewal(period="week", anniversary="2026-01-05T00:00:00Z", at=NOW)
        self.assertEqual(renewal["date"], "2026-11-02T00:00:00Z")

    def test_unsupported_period_has_unknown_date(self):
        renewal = E.next_renewal(period="fortnight", at=NOW)
        self.assertIsNone(renewal["date"])


class AttributionTests(unittest.TestCase):
    def test_exact_route_slug_attributes(self):
        mapping = E.attribute_routes([account("a", "test")], ["test"])
        self.assertEqual(mapping["by_account"]["a"]["basis"], "route")
        self.assertEqual(mapping["by_account"]["a"]["routes"],
                         [{"route": "test", "basis": "route"}])
        self.assertEqual(mapping["unattributed"], [])

    def test_route_claimed_twice_is_ambiguous_and_counted_once(self):
        first = account("a1", "test")
        second = account("a2", "test")
        mapping = E.attribute_routes([first, second], ["test"])
        self.assertEqual(mapping["by_account"], {})
        self.assertEqual(mapping["ambiguous"], {"test": ["a1", "a2"]})

    def test_unclaimed_route_in_multi_account_family_is_unattributed(self):
        first = account("a1", "test", route_slugs=["other-route"])
        second = account("a2", "test", route_slugs=["third-route"])
        mapping = E.attribute_routes([first, second], ["test"])
        self.assertEqual(mapping["by_account"], {})
        self.assertEqual(mapping["unattributed"], ["test"])

    def test_single_account_family_is_a_labelled_fallback(self):
        solo = account("solo", "test", route_slugs=["wire-variant"])
        mapping = E.attribute_routes([solo], ["test"])
        self.assertEqual(mapping["by_account"]["solo"]["basis"], "family")
        self.assertIn("only account", E.attribution_note("family"))

    def test_unknown_route_is_unattributed(self):
        mapping = E.attribute_routes([account("a", "test")], ["mystery"])
        self.assertEqual(mapping["by_account"], {})
        self.assertEqual(mapping["unattributed"], ["mystery"])

    def test_attribution_is_case_insensitive(self):
        mapping = E.attribute_routes([account("a", "test", route_slugs=["Test"])], ["TEST"])
        self.assertIn("a", mapping["by_account"])


class ComparisonTests(EconomicsCase):
    def test_happy_path_compares_fee_against_attributed_usage(self):
        self.anchor_coverage()
        self.write_store([account("a", "test", plan_id="test.plus")])
        self.create_events([{"ts": NOW - 100, "input_tokens": 1_000_000}])
        result = self.report(days=30, trend_months=0)
        headline = result["headline"]
        self.assertEqual(headline["status"], "ok")
        self.assertEqual(headline["fees_monthly_by_currency"],
                         [{"currency": "USD", "amount": 20.0}])
        self.assertEqual(headline["usage_usd"], 2.0)
        # Same-window comparison: $2 of usage against ~30 days of the $20 fee.
        expected = round(2.0 - self.windowed(20.0, result), 6)
        self.assertAlmostEqual(headline["difference_usd"], expected)
        self.assertGreater(headline["difference_usd"], -18.0)
        self.assertIn("Estimated value comparison", headline["difference_label"])
        row = result["accounts"][0]
        self.assertEqual(row["status"], "ok")
        self.assertEqual(row["monthly_equivalent"], {"amount": 20.0, "currency": "USD"})
        self.assertAlmostEqual(row["window_expenditure"]["amount"],
                               self.windowed(20.0, result))
        self.assertAlmostEqual(row["difference_usd"], expected)

    def test_window_allocation_scales_fees_to_the_reporting_window(self):
        self.assertAlmostEqual(E.allocate_to_window(20.0, E.MEAN_MONTH_DAYS), 20.0)
        self.assertAlmostEqual(E.allocate_to_window(20.0, E.MEAN_MONTH_DAYS / 2), 10.0)
        self.assertIsNone(E.allocate_to_window(None, 30.0))
        self.assertIsNone(E.allocate_to_window(20.0, None))
        self.assertIsNone(E.allocate_to_window(20.0, 0))
        self.assertIsNone(E.allocate_to_window(20.0, -5))
        self.assertIsNone(E.allocate_to_window(True, 30.0))

    def test_short_window_compares_days_of_fees_not_a_whole_month(self):
        self.anchor_coverage()
        self.write_store([account("a", "test", plan_id="test.plus")])
        self.create_events([{"ts": NOW - 100, "input_tokens": 1_000_000}])
        result = self.report(days=7, trend_months=0)
        # About a quarter of the $20 fee falls in a 7-day window; a whole
        # month of fees here would understate the comparison by ~$15.
        self.assertLess(result["window_days"], 8.0)
        expected = round(2.0 - self.windowed(20.0, result), 6)
        self.assertAlmostEqual(result["headline"]["difference_usd"], expected)
        self.assertGreater(result["headline"]["difference_usd"], -10.0)
        window_fees = result["headline"]["fees_window_by_currency"]
        self.assertEqual(len(window_fees), 1)
        self.assertAlmostEqual(window_fees[0]["amount"], self.windowed(20.0, result))
        # Monthly equivalents stay visible alongside the windowed figure.
        self.assertEqual(result["headline"]["fees_monthly_by_currency"],
                         [{"currency": "USD", "amount": 20.0}])

    def test_annual_fee_allocates_one_twelfth_but_renews_in_full(self):
        self.anchor_coverage()
        self.write_store([account("a", "other", plan_id="other.team",
                                  fee_overrides=[override(240, "USD", "year",
                                                          effective_from="2026-01-15T00:00:00Z")])])
        self.create_events([{"ts": NOW - 100, "provider": "other",
                             "input_tokens": 1_000_000}])
        result = self.report(days=30, trend_months=0)
        row = result["accounts"][0]
        self.assertAlmostEqual(row["monthly_equivalent"]["amount"], 20.0)
        self.assertEqual(row["renewal"]["amount"], 240.0)
        self.assertEqual(row["renewal"]["date"], "2027-01-15T00:00:00Z")
        self.assertAlmostEqual(row["difference_usd"],
                               round(2.0 - self.windowed(20.0, result), 6))

    def test_missing_fee_is_unavailable_not_zero(self):
        self.anchor_coverage()
        self.write_store([account("a", "test", plan_id="test.plus",
                                  fee_overrides=[],
                                  billing_arrangement="subscription")])
        bare = plans_doc({"id": "test.plus", "provider_family": "test",
                          "name": "Test Plus",
                          "price": {"amount": None, "currency": None, "period": "month"}})
        self.create_events([{"ts": NOW - 100, "input_tokens": 1_000_000}])
        result = self.report(days=30, trend_months=0, plans=bare)
        row = result["accounts"][0]
        self.assertEqual(row["status"], "unavailable")
        self.assertIsNone(row["monthly_equivalent"]["amount"])
        self.assertIsNone(row["difference_usd"])
        self.assertEqual(row["usage"]["list_usd"], 2.0)
        self.assertEqual(result["headline"]["status"], "unavailable")
        self.assertIsNone(result["headline"]["difference_usd"])

    def test_headline_withholds_difference_when_any_fee_unknown(self):
        # One priced subscription plus one without a fee: the headline must
        # not present a complete-looking comparison over a silent subset.
        self.anchor_coverage()
        bare = plans_doc(
            {"id": "test.plus", "provider_family": "test", "name": "Test Plus",
             "price": {"amount": 20.0, "currency": "USD", "period": "month"}},
            {"id": "other.mystery", "provider_family": "other", "name": "Mystery",
             "price": {"amount": None, "currency": None, "period": "month"}})
        self.write_store([account("a", "test", plan_id="test.plus"),
                          account("b", "other", plan_id="other.mystery")])
        self.create_events([{"ts": NOW - 100, "input_tokens": 1_000_000},
                            {"ts": NOW - 90, "provider": "other",
                             "input_tokens": 1_000_000}])
        result = self.report(days=30, trend_months=0, plans=bare)
        headline = result["headline"]
        self.assertEqual(headline["status"], "unavailable")
        self.assertIsNone(headline["difference_usd"])
        self.assertTrue(any("1 subscription(s) have no fee" in note
                            for note in headline["notes"]))
        # Observed usage is still reported; only the comparison is withheld.
        self.assertEqual(headline["usage_usd"], 4.0)

    def test_api_only_usage_cannot_manufacture_a_saving(self):
        self.anchor_coverage()
        self.write_store([account("a", "test", api_only=True,
                                  billing_arrangement="subscription",
                                  plan_id="test.plus")])
        self.create_events([{"ts": NOW - 100, "input_tokens": 10_000_000}])
        result = self.report(days=30, trend_months=0)
        self.assertEqual(result["accounts"], [])
        self.assertEqual(len(result["non_subscription_accounts"]), 1)
        other = result["non_subscription_accounts"][0]
        self.assertEqual(other["arrangement"], "api_only")
        self.assertEqual(other["usage"]["list_usd"], 20.0)
        self.assertIsNone(other["difference_usd"])
        self.assertEqual(result["headline"]["status"], "unavailable")

    def test_prepaid_and_unconfirmed_accounts_are_excluded(self):
        self.anchor_coverage()
        self.write_store([
            account("p", "test", billing_arrangement="prepaid"),
            account("u", "other", billing_arrangement="unconfirmed"),
        ])
        self.create_events([{"ts": NOW - 100, "input_tokens": 1_000_000},
                            {"ts": NOW - 90, "provider": "other",
                             "input_tokens": 1_000_000}])
        result = self.report(days=30, trend_months=0)
        self.assertEqual(result["accounts"], [])
        by_id = {r["account_id"]: r for r in result["non_subscription_accounts"]}
        self.assertEqual(by_id["p"]["usage"]["list_usd"], 2.0)
        self.assertIn("top-ups", by_id["p"]["explanation"])
        self.assertIn("not confirmed", by_id["u"]["explanation"])
        self.assertEqual(result["headline"]["status"], "unavailable")

    def test_usage_attributes_to_the_owning_account_only(self):
        self.anchor_coverage()
        self.write_store([
            account("a", "test", plan_id="test.plus"),
            account("b", "other", plan_id="other.team",
                    fee_overrides=[override(120, "USD", "year")]),
        ])
        self.create_events([{"ts": NOW - 100, "input_tokens": 1_000_000},
                            {"ts": NOW - 90, "provider": "other",
                             "input_tokens": 2_000_000}])
        result = self.report(days=30, trend_months=0)
        by_id = {r["account_id"]: r for r in result["accounts"]}
        self.assertEqual(by_id["a"]["usage"]["list_usd"], 2.0)
        self.assertEqual(by_id["b"]["usage"]["list_usd"], 4.0)
        self.assertAlmostEqual(by_id["a"]["difference_usd"],
                               round(2.0 - self.windowed(20.0, result), 6))
        # $120/yr is $10/mo against $4 of usage, both windowed.
        self.assertAlmostEqual(by_id["b"]["difference_usd"],
                               round(4.0 - self.windowed(10.0, result), 6))
        self.assertAlmostEqual(result["headline"]["difference_usd"],
                               round(6.0 - self.windowed(30.0, result), 6))
        coverage = result["coverage"]["attribution"]
        self.assertEqual(coverage["unattributed_tokens"], 0)
        self.assertEqual(coverage["ambiguous_tokens"], 0)

    def test_ambiguous_usage_is_counted_once_and_attributed_to_nobody(self):
        self.anchor_coverage()
        self.write_store([
            account("a1", "test", plan_id="test.plus"),
            account("a2", "test", plan_id="test.plus"),
        ])
        self.create_events([{"ts": NOW - 100, "input_tokens": 1_000_000}])
        result = self.report(days=30, trend_months=0)
        self.assertEqual(result["ambiguous"]["usage"]["tokens"], 1_000_000)
        self.assertEqual(result["ambiguous"]["usage"]["list_usd"], 2.0)
        for row in result["accounts"]:
            self.assertEqual(row["usage"]["tokens"], 0)
            self.assertAlmostEqual(row["difference_usd"],
                                   round(-self.windowed(20.0, result), 6))
        # Both fees stand, but the $2 of usage backs neither of them.
        self.assertAlmostEqual(result["headline"]["difference_usd"],
                               round(-self.windowed(40.0, result), 6))
        self.assertEqual(result["coverage"]["attribution"]["ambiguous_tokens"], 1_000_000)

    def test_unattributed_usage_is_reported_separately(self):
        self.anchor_coverage()
        self.write_store([account("a", "test", plan_id="test.plus")])
        self.create_events([{"ts": NOW - 100, "input_tokens": 1_000_000},
                            {"ts": NOW - 90, "provider": "mystery", "model": "m",
                             "input_tokens": 500_000}])
        result = self.report(days=30, trend_months=0)
        self.assertEqual(result["unattributed"]["routes"], ["mystery"])
        self.assertEqual(result["unattributed"]["usage"]["tokens"], 500_000)
        self.assertEqual(result["accounts"][0]["usage"]["tokens"], 1_000_000)
        coverage = result["coverage"]["attribution"]
        self.assertEqual(coverage["attributed_tokens"]
                         + coverage["unattributed_tokens"]
                         + coverage["ambiguous_tokens"], 1_500_000)

    def test_unpriced_usage_marks_the_comparison_partial(self):
        self.anchor_coverage()
        self.write_store([account("a", "test", plan_id="test.plus")])
        self.create_events([{"ts": NOW - 100, "input_tokens": 1_000_000},
                            {"ts": NOW - 90, "model": "unknown-model",
                             "input_tokens": 1_000_000}])
        result = self.report(days=30, trend_months=0)
        row = result["accounts"][0]
        self.assertEqual(row["status"], "partial")
        self.assertEqual(row["usage"]["coverage"], 0.5)
        self.assertAlmostEqual(row["difference_usd"],
                               round(2.0 - self.windowed(20.0, result), 6))
        self.assertTrue(any("lower bound" in note for note in row["notes"]))
        self.assertEqual(result["headline"]["status"], "partial")

    def test_fully_unpriced_usage_is_unavailable(self):
        self.anchor_coverage()
        self.write_store([account("a", "test", plan_id="test.plus")])
        self.create_events([{"ts": NOW - 100, "model": "unknown-model",
                             "input_tokens": 1_000_000}])
        result = self.report(days=30, trend_months=0)
        row = result["accounts"][0]
        self.assertEqual(row["status"], "unavailable")
        self.assertIsNone(row["difference_usd"])
        self.assertIsNone(result["headline"]["difference_usd"])

    def test_partial_recording_window_marks_comparisons_partial(self):
        self.write_store([account("a", "test", plan_id="test.plus")])
        self.create_events([{"ts": NOW - 100, "input_tokens": 1_000_000}])
        result = self.report(days=30, trend_months=0)
        self.assertFalse(result["coverage"]["recording_covers_window"])
        self.assertEqual(result["accounts"][0]["status"], "partial")
        self.assertEqual(result["headline"]["status"], "partial")

    def test_zero_observed_usage_with_full_coverage_is_a_real_zero(self):
        # The anchor is outside the window, so nothing is observed in it.
        self.anchor_coverage()
        self.write_store([account("a", "test", plan_id="test.plus")])
        result = self.report(days=30, trend_months=0)
        row = result["accounts"][0]
        self.assertEqual(row["usage"]["list_usd"], 0.0)
        self.assertAlmostEqual(row["difference_usd"],
                               round(-self.windowed(20.0, result), 6))
        self.assertEqual(row["status"], "ok")

    def test_family_basis_attribution_is_partial(self):
        self.anchor_coverage()
        self.write_store([account("solo", "test", plan_id="test.plus",
                                  route_slugs=["wire-variant"])])
        self.create_events([{"ts": NOW - 100, "input_tokens": 1_000_000}])
        result = self.report(days=30, trend_months=0)
        row = result["accounts"][0]
        self.assertEqual(row["attribution"]["basis"], "family")
        self.assertEqual(row["status"], "partial")
        self.assertAlmostEqual(row["difference_usd"],
                               round(2.0 - self.windowed(20.0, result), 6))

    def test_free_tier_zero_fee_is_real(self):
        self.anchor_coverage()
        free = plans_doc({"id": "test.free", "provider_family": "test",
                          "name": "Test Free", "kind": "free",
                          "price": {"amount": 0.0, "currency": "USD", "period": "month"}})
        self.write_store([account("a", "test", plan_id="test.free")])
        self.create_events([{"ts": NOW - 100, "input_tokens": 1_000_000}])
        result = self.report(days=30, trend_months=0, plans=free)
        row = result["accounts"][0]
        self.assertEqual(row["monthly_equivalent"], {"amount": 0.0, "currency": "USD"})
        self.assertEqual(row["difference_usd"], 2.0)
        self.assertEqual(row["status"], "ok")

    def test_corrupt_membership_store_raises(self):
        self.memberships.write_text("{not json")
        with self.assertRaises(mstore.StoreUnreadable):
            self.report(days=30, trend_months=0)


class CurrencyTests(EconomicsCase):
    def two_currency_store(self):
        self.anchor_coverage()
        self.write_store([
            account("usd", "test", plan_id="test.plus"),
            account("gbp", "other",
                    fee_overrides=[override(51, "GBP", "year",
                                            effective_from="2026-03-01T00:00:00Z")]),
        ])
        self.create_events([{"ts": NOW - 100, "input_tokens": 1_000_000},
                            {"ts": NOW - 90, "provider": "other",
                             "input_tokens": 500_000}])

    def test_currencies_are_never_combined_without_fx(self):
        self.two_currency_store()
        result = self.report(days=30, trend_months=0)
        headline = result["headline"]
        self.assertEqual(headline["fees_monthly_by_currency"],
                         [{"currency": "GBP", "amount": 4.25},
                          {"currency": "USD", "amount": 20.0}])
        # The USD subscription compares; the GBP one cannot; the headline
        # refuses to invent a combined difference.
        by_id = {r["account_id"]: r for r in result["accounts"]}
        self.assertAlmostEqual(by_id["usd"]["difference_usd"],
                               round(2.0 - self.windowed(20.0, result), 6))
        self.assertIsNone(by_id["gbp"]["difference_usd"])
        self.assertEqual(by_id["gbp"]["status"], "unavailable")
        self.assertIsNone(headline["difference_usd"])
        self.assertEqual(headline["status"], "unavailable")
        groups = {g["currency"]: g for g in result["groups"]}
        self.assertAlmostEqual(groups["USD"]["difference_usd"],
                               round(2.0 - self.windowed(20.0, result), 6))
        self.assertIsNone(groups["GBP"]["difference_usd"])

    def test_explicit_fx_rate_enables_a_cited_conversion(self):
        self.two_currency_store()
        E.save_fx([{"currency": "GBP", "usd_per_unit": 1.25,
                    "as_of": "2026-10-31", "source": "Bank of England spot"}],
                  self.fx)
        result = self.report(days=30, trend_months=0)
        by_id = {r["account_id"]: r for r in result["accounts"]}
        # GBP 4.25/mo at 1.25 is $5.3125/mo against $1.00 of usage.
        self.assertAlmostEqual(by_id["gbp"]["monthly_equivalent_usd"], 5.3125)
        self.assertAlmostEqual(by_id["gbp"]["difference_usd"],
                               round(1.0 - self.windowed(5.3125, result), 6))
        self.assertTrue(any("Bank of England" in note for note in by_id["gbp"]["notes"]))
        headline = result["headline"]
        self.assertAlmostEqual(headline["difference_usd"],
                               round(3.0 - self.windowed(25.3125, result), 6))
        self.assertEqual(headline["status"], "ok")
        groups = {g["currency"]: g for g in result["groups"]}
        self.assertTrue(groups["GBP"]["converted"])

    def test_corrupt_fx_file_disables_conversion_without_hiding_the_report(self):
        self.two_currency_store()
        self.fx.write_text("{not json")
        result = self.report(days=30, trend_months=0)
        by_id = {r["account_id"]: r for r in result["accounts"]}
        self.assertIsNone(by_id["gbp"]["difference_usd"])
        self.assertAlmostEqual(by_id["usd"]["difference_usd"],
                               round(2.0 - self.windowed(20.0, result), 6))
        self.assertTrue(any("FX rates could not be read" in note
                            for note in result["headline"]["notes"]))


class FxStoreTests(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory(dir=os.environ.get("TMPDIR"))
        self.addCleanup(self.scratch.cleanup)
        self.path = Path(self.scratch.name) / "fx-rates.json"

    def test_missing_file_is_no_rates(self):
        doc = E.load_fx(self.path)
        self.assertEqual(doc["rates"], [])
        self.assertEqual(doc["error"], "")

    def test_round_trip(self):
        E.save_fx([{"currency": "gbp", "usd_per_unit": 1.25,
                    "as_of": "2026-10-31", "source": "Example Bank"}], self.path)
        doc = E.load_fx(self.path)
        self.assertEqual(doc["rates"], [{"currency": "GBP", "usd_per_unit": 1.25,
                                         "as_of": "2026-10-31", "source": "Example Bank"}])

    def test_validation_rejects_bad_rates(self):
        self.assertTrue(E.fx_validation_errors("nope"))
        self.assertTrue(E.fx_validation_errors([{"currency": "XX", "usd_per_unit": 1,
                                                 "as_of": "2026-10-31", "source": "x"}]))
        self.assertTrue(E.fx_validation_errors([{"currency": "GBP", "usd_per_unit": 0,
                                                 "as_of": "2026-10-31", "source": "x"}]))
        self.assertTrue(E.fx_validation_errors([{"currency": "GBP", "usd_per_unit": 1.2,
                                                 "as_of": "never", "source": "x"}]))
        self.assertTrue(E.fx_validation_errors([{"currency": "GBP", "usd_per_unit": 1.2,
                                                 "as_of": "2026-10-31", "source": ""}]))
        self.assertTrue(E.fx_validation_errors([
            {"currency": "GBP", "usd_per_unit": 1.2, "as_of": "2026-10-31", "source": "x"},
            {"currency": "GBP", "usd_per_unit": 1.3, "as_of": "2026-10-31", "source": "x"}]))
        with self.assertRaises(ValueError):
            E.save_fx([{"currency": "GBP", "usd_per_unit": -1,
                        "as_of": "2026-10-31", "source": "x"}], self.path)


class TrendTests(EconomicsCase):
    def test_months_pair_mid_month_fees_with_calendar_month_usage(self):
        self.anchor_coverage()
        self.write_store([account("a", "test", plan_id="test.plus")])
        october = datetime(2026, 10, 15, 12, tzinfo=timezone.utc).timestamp()
        september = datetime(2026, 9, 15, 12, tzinfo=timezone.utc).timestamp()
        self.create_events([{"ts": october, "input_tokens": 1_000_000},
                            {"ts": september, "input_tokens": 2_000_000}])
        result = self.report(days=30, trend_months=3)
        months = {m["month"]: m for m in result["trend"]["months"]}
        self.assertEqual(months["2026-10"]["usage_usd"], 2.0)
        self.assertEqual(months["2026-10"]["difference_usd"], -18.0)
        self.assertTrue(months["2026-10"]["in_progress"])
        self.assertEqual(months["2026-09"]["usage_usd"], 4.0)
        self.assertEqual(months["2026-09"]["difference_usd"], -16.0)
        self.assertFalse(months["2026-09"]["in_progress"])
        self.assertEqual(months["2026-09"]["fees_by_currency"],
                         [{"currency": "USD", "amount": 20.0}])

    def test_fee_change_mid_history_resolves_per_month(self):
        self.anchor_coverage()
        self.write_store([account(
            "a", "test", plan_id="test.plus",
            fee_overrides=[
                override(10, "USD", "month", effective_from="2026-09-01T00:00:00Z",
                         effective_to="2026-10-01T00:00:00Z", id="r-sep"),
                override(30, "USD", "month", effective_from="2026-10-01T00:00:00Z",
                         id="r-oct"),
            ])])
        self.create_events([])
        result = self.report(days=30, trend_months=2)
        months = {m["month"]: m for m in result["trend"]["months"]}
        self.assertEqual(months["2026-09"]["fees_by_currency"],
                         [{"currency": "USD", "amount": 10.0}])
        self.assertEqual(months["2026-10"]["fees_by_currency"],
                         [{"currency": "USD", "amount": 30.0}])

    def test_months_before_recording_are_excluded_not_zeroed(self):
        fresh = datetime(2026, 10, 15, 12, tzinfo=timezone.utc).timestamp()
        self.create_events([{"ts": fresh, "input_tokens": 1_000_000}])
        self.write_store([account("a", "test", plan_id="test.plus")])
        result = self.report(days=30, trend_months=6)
        months = {m["month"]: m for m in result["trend"]["months"]}
        self.assertNotIn("2026-09", months)
        self.assertIn("2026-10", months)
        self.assertGreaterEqual(result["trend"]["excluded_before_recording"], 1)

    def test_trend_attributes_routes_from_the_full_history(self):
        # A route used in September but silent since still backs September.
        self.anchor_coverage()
        self.write_store([account("a", "test", plan_id="test.plus")])
        september = datetime(2026, 9, 15, 12, tzinfo=timezone.utc).timestamp()
        self.create_events([{"ts": september, "input_tokens": 1_000_000}])
        result = self.report(days=7, trend_months=2)
        months = {m["month"]: m for m in result["trend"]["months"]}
        self.assertEqual(months["2026-09"]["usage_usd"], 2.0)
        self.assertEqual(months["2026-09"]["usage_calls"], 1)
        self.assertEqual(months["2026-09"]["difference_usd"], -18.0)
        self.assertEqual(result["trend"]["excluded_before_recording"], 0)

    def test_trend_withholds_difference_when_month_fully_unpriced(self):
        self.anchor_coverage()
        self.write_store([account("a", "test", plan_id="test.plus")])
        october = datetime(2026, 10, 15, 12, tzinfo=timezone.utc).timestamp()
        self.create_events([{"ts": october, "model": "unknown-model",
                             "input_tokens": 1_000_000}])
        result = self.report(days=30, trend_months=1)
        (entry,) = result["trend"]["months"]
        self.assertEqual(entry["month"], "2026-10")
        self.assertIsNone(entry["usage_usd"])
        self.assertIsNone(entry["difference_usd"])
        self.assertIsNone(entry["fees_usd"])
        self.assertIn("no published price", entry["difference_note"])
        self.assertTrue(entry["has_unpriced_usage"])

    def test_trend_labels_mixed_pricing_month_partial(self):
        self.anchor_coverage()
        self.write_store([account("a", "test", plan_id="test.plus")])
        october = datetime(2026, 10, 15, 12, tzinfo=timezone.utc).timestamp()
        self.create_events([{"ts": october, "input_tokens": 1_000_000},
                            {"ts": october, "model": "unknown-model",
                             "input_tokens": 1_000_000}])
        result = self.report(days=30, trend_months=1)
        (entry,) = result["trend"]["months"]
        self.assertEqual(entry["usage_usd"], 2.0)
        self.assertEqual(entry["usage_coverage"], 0.5)
        self.assertTrue(entry["partial"])
        self.assertEqual(entry["difference_usd"], -18.0)
        self.assertIn("lower bound", entry["difference_note"])

    def test_trend_reports_the_converted_fee_total_behind_the_bars(self):
        self.anchor_coverage()
        self.write_store([account("gbp", "test",
                                  fee_overrides=[override(51, "GBP", "year")])])
        october = datetime(2026, 10, 15, 12, tzinfo=timezone.utc).timestamp()
        self.create_events([{"ts": october, "input_tokens": 1_000_000}])
        E.save_fx([{"currency": "GBP", "usd_per_unit": 1.25,
                    "as_of": "2026-10-10", "source": "Example Bank"}], self.fx)
        result = self.report(days=30, trend_months=1)
        (entry,) = result["trend"]["months"]
        # GBP 4.25/mo at 1.25 converts to $5.3125/mo; the client must not
        # re-derive or re-sum this from per-currency amounts.
        self.assertAlmostEqual(entry["fees_usd"], 5.3125)
        self.assertAlmostEqual(entry["difference_usd"], 2.0 - 5.3125)

    def test_trend_applies_only_fx_rates_dated_in_the_month(self):
        self.anchor_coverage()
        self.write_store([account("gbp", "test",
                                  fee_overrides=[override(51, "GBP", "year")])])
        october = datetime(2026, 10, 15, 12, tzinfo=timezone.utc).timestamp()
        september = datetime(2026, 9, 15, 12, tzinfo=timezone.utc).timestamp()
        self.create_events([{"ts": october, "input_tokens": 1_000_000},
                            {"ts": september, "input_tokens": 1_000_000}])
        E.save_fx([{"currency": "GBP", "usd_per_unit": 1.25,
                    "as_of": "2026-10-10", "source": "Example Bank"}], self.fx)
        result = self.report(days=30, trend_months=2)
        months = {m["month"]: m for m in result["trend"]["months"]}
        self.assertIsNotNone(months["2026-10"]["difference_usd"])
        self.assertIsNone(months["2026-09"]["difference_usd"])
        self.assertIn("no FX rate dated in this month",
                      months["2026-09"]["difference_note"])

    def test_trend_disabled_returns_no_months(self):
        self.anchor_coverage()
        self.write_store([account("a", "test", plan_id="test.plus")])
        result = self.report(days=30, trend_months=0)
        self.assertEqual(result["trend"]["months"], [])


try:
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from dashboard import plugin_api
    from unittest.mock import patch
except Exception:  # pragma: no cover - depends on the test interpreter
    FastAPI = None  # type: ignore
    TestClient = None  # type: ignore


@unittest.skipUnless(FastAPI is not None and TestClient is not None,
                     "FastAPI/httpx not installed in this interpreter")
class EconomicsApiTests(unittest.TestCase):
    def setUp(self) -> None:
        app = FastAPI()
        app.include_router(plugin_api.router, prefix="/api/plugins/spend-sense")
        self.client = TestClient(app)
        self.addCleanup(self.client.close)

    def test_summary_returns_report_shape(self):
        fixture = {"ok": True, "headline": {"status": "ok"}}
        with patch.object(plugin_api.economics, "build_economics_report",
                          return_value=fixture) as builder:
            response = self.client.get("/api/plugins/spend-sense/economics/summary",
                                       params={"days": 30, "trend_months": 3})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["headline"]["status"], "ok")
        builder.assert_called_once_with(days=30, trend_months=3)

    def test_summary_failure_hides_exception_details(self):
        with patch.object(plugin_api.economics, "build_economics_report",
                          side_effect=RuntimeError("private sentinel")):
            response = self.client.get("/api/plugins/spend-sense/economics/summary")
        self.assertEqual(response.status_code, 500)
        self.assertNotIn("private sentinel", response.text)

    def test_summary_maps_store_errors(self):
        from wolfmark_ledger.membership import CatalogueError
        from wolfmark_ledger.membership_store import StoreUnreadable
        with patch.object(plugin_api.economics, "build_economics_report",
                          side_effect=StoreUnreadable("broken")):
            response = self.client.get("/api/plugins/spend-sense/economics/summary")
        self.assertEqual(response.status_code, 503)
        with patch.object(plugin_api.economics, "build_economics_report",
                          side_effect=CatalogueError("bad catalogue")):
            response = self.client.get("/api/plugins/spend-sense/economics/summary")
        self.assertEqual(response.status_code, 503)

    def test_fx_round_trip_through_the_api(self):
        doc = {"rates": [{"currency": "GBP", "usd_per_unit": 1.25,
                          "as_of": "2026-10-31", "source": "Example Bank"}],
               "loaded": True, "error": "", "path": "/tmp/fx.json"}
        with patch.object(plugin_api.economics, "load_fx", return_value=doc):
            response = self.client.get("/api/plugins/spend-sense/membership/fx")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["rates"][0]["currency"], "GBP")
        with patch.object(plugin_api.economics, "save_fx",
                          return_value={"rates": doc["rates"], "path": "/tmp/fx.json"}) as saver:
            response = self.client.put("/api/plugins/spend-sense/membership/fx",
                                       json={"rates": doc["rates"]})
        self.assertEqual(response.status_code, 200)
        saver.assert_called_once_with(doc["rates"])

    def test_fx_save_rejects_invalid_rates(self):
        with patch.object(plugin_api.economics, "save_fx",
                          side_effect=ValueError("unsupported currency: XX")):
            response = self.client.put("/api/plugins/spend-sense/membership/fx",
                                       json={"rates": [{"currency": "XX"}]})
        self.assertEqual(response.status_code, 422)


if __name__ == "__main__":
    unittest.main()
