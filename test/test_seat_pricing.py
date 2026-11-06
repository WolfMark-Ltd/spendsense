"""Per-seat fees retain the published price, declared fee and history separately."""
import copy
import json
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

from wolfmark_ledger import economics as E, membership as M, membership_api as API, membership_live, membership_store, plans_feed

PLAN = 'openai-codex.chatgpt-business-premium'
NOW = '2026-11-06T12:00:00Z'


def revision(quantity, period='month', at=NOW):
    return {'id': at, 'plan_id': PLAN, 'quantity': quantity, 'period': period, 'effective_from': at}


def account(**changes):
    return {'id': 'a', 'family': 'openai-codex', 'plan_id': PLAN,
            'fee_overrides': [], 'manual_exhaustions': [], **changes}


class SeatPricingTests(unittest.TestCase):
    def setUp(self):
        self.book = API.load_plans()

    def fee(self, member, at='2026-11-07T00:00:00Z', book=None):
        return M.resolve_fee(member, book or self.book, at)

    def test_quantities_and_periods(self):
        for count in (1, 2, 3):
            for period, unit in [('month', 125), ('year', 1200)]:
                with self.subTest(count=count, period=period):
                    result = self.fee(account(seat_revisions=[revision(count, period)]))
                    self.assertEqual(result['published']['amount'], 125)
                    self.assertEqual(result['calculated']['unit_amount'], unit)
                    self.assertEqual(result['calculated']['amount'], unit * count)
                    self.assertEqual(result['effective']['amount'], unit * count)
                    self.assertEqual(result['effective']['period'], period)
                    self.assertEqual(result['effective']['currency'], 'USD')

    def test_missing_and_cleared_quantity_preserve_existing_fee(self):
        self.assertEqual(self.fee(account())['effective']['amount'], 125)
        member = account(seat_revisions=[revision(3), revision(None, at='2026-11-07T00:00:00Z')])
        self.assertEqual(self.fee(member, '2026-11-06T13:00:00Z')['effective']['amount'], 375)
        self.assertIsNone(self.fee(member)['calculated'])
        self.assertEqual(self.fee(member)['effective']['amount'], 125)
        self.assertEqual(self.fee(member, '2026-11-05T00:00:00Z')['effective']['amount'], 125)

    def test_override_remains_total_and_comparison_is_separate(self):
        override = {'id': 'mine', 'amount': 330, 'currency': 'USD', 'period': 'month'}
        result = self.fee(account(seat_revisions=[revision(3)], fee_overrides=[override]))
        self.assertEqual(result['effective']['amount'], 330)
        self.assertEqual(result['calculated']['amount'], 375)
        self.assertEqual(result['basis'], 'declared')
        self.assertEqual(result['override']['revision_id'], 'mine')

    def test_flat_prepaid_and_payg_do_not_multiply(self):
        for changes in ({'plan_id': 'openai-codex.chatgpt-plus'},
                        {'billing_arrangement': 'prepaid'}, {'api_only': True}):
            result = self.fee(account(seat_revisions=[revision(3)], **changes))
            self.assertIsNone(result['calculated'])
            self.assertNotEqual(result['effective']['amount'], 375)

    def test_unknown_and_provisional_are_not_calculated(self):
        for mutate in ('unknown', 'provisional', 'missing_metadata'):
            book = copy.deepcopy(self.book)
            plan = M.plan_index(book)[PLAN]
            if mutate == 'unknown':
                plan['seat_pricing']['prices']['month']['amount'] = None
            elif mutate == 'provisional':
                plan['verification']['status'] = 'provisional'
            else:
                plan['seat_pricing'] = None
            result = self.fee(account(seat_revisions=[revision(3)]), book=book)
            self.assertIsNone(result['calculated'])
            self.assertIsNone(result['effective']['amount'])

    def test_validation_and_account_card(self):
        for quantity in (0, -1, 1.5, True, '3', 10**100):
            self.assertTrue(M.seat_revision_errors([revision(quantity)]))
        member = account(seat_revisions=[revision(3)])
        self.assertFalse(M.seat_revision_errors(member['seat_revisions']))
        card = API.account_card(member, self.book, at='2026-11-07T00:00:00Z')
        self.assertEqual(card['fee']['effective']['amount'], 375)
        self.assertEqual(API._document(card), account())

    def test_summary_uses_effective_total_and_preserves_override(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'memberships.json'
            for overrides, expected in [([], 375), ([{'id': 'actual', 'amount': 330,
                                                      'currency': 'USD', 'period': 'month'}], 330)]:
                member = account(fee_overrides=overrides)
                saved = membership_store.save_account(member, path)['account']
                current = membership_store.load_with_seats(path)['accounts'][0]
                membership_store.append_seat_revision('a', revision(3), if_rev=saved['rev'],
                                                       if_seat_rev=current['seat_rev'], path=path)
                summary = API.fee_summary_payload(path=path, catalogue=self.book,
                                                  at='2026-11-07T00:00:00Z')
                self.assertEqual(summary['totals_by_currency_period']['USD/month'], expected)
                path.unlink()
                membership_store.seat_store_path(path).unlink()

    def test_reporting_window_splits_at_quantity_revision(self):
        member = account(seat_revisions=[revision(3)])
        start = datetime(2026, 11, 6, 0, tzinfo=timezone.utc).timestamp()
        end = datetime(2026, 11, 7, 0, tzinfo=timezone.utc).timestamp()
        native, usd, _, gap = E._split_window_expenditure(member, self.book, {}, start, end, 1)
        self.assertAlmostEqual(native, (125 + 375) / 2 / E.MEAN_MONTH_DAYS, places=5)
        self.assertEqual(native, usd)
        self.assertFalse(gap)

    def test_feed_round_trip_keeps_seat_prices(self):
        raw = json.loads(API.plans_path().read_text())
        feed, problems = plans_feed.build_feed(raw)
        self.assertEqual(problems, [])
        book, problems = membership_live.validate_feed(feed)
        self.assertEqual(problems, [])
        self.assertEqual(self.fee(account(seat_revisions=[revision(3, 'year')]), book=book)
                         ['effective']['amount'], 3600)

    def test_annual_seat_price_changes_block_catalogue_promotion(self):
        updated = copy.deepcopy(self.book)
        M.plan_index(updated)[PLAN]['seat_pricing']['prices']['year']['amount'] = 1320
        report = M.diff_catalogues(self.book, updated)
        self.assertIn(f'{PLAN}:seat_pricing', report['blocking'])
        self.assertFalse(M.promotion_plan(report)['promotable'])


if __name__ == '__main__':
    unittest.main()
