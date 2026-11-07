"""Budget persistence, evidence and calendar contracts; temporary data only."""
import json
import multiprocessing
import sqlite3
import tempfile
import unittest
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch
from zoneinfo import ZoneInfo

from wolfmark_ledger import budgets as B, forecast as F, store
from wolfmark_ledger.pricing import Catalogue, Rate

NOW = datetime(2026, 11, 10, 12, tzinfo=timezone.utc).timestamp()
START = datetime(2026, 11, 1, tzinfo=timezone.utc).timestamp()


def budget(**kwargs):
    return {'id': 'total', 'label': 'Monthly value', 'scope': 'total', 'amount': 100.,
            'currency': 'USD', 'enabled': True, 'thresholds': [50, 80, 100], 'cycle_day': 1,
            'timezone': 'UTC', 'measurement': 'api_equivalent', 'provider': '', 'model': '', **kwargs}


def rows(amount=10, count=4):
    """Create distinct synthetic attempts with separate catalogue and actual values."""
    return [{'event_id': str(i), 'ts': START + (i + 1) * 86400, 'provider': 'fixture', 'model': 'm',
             'list_usd': amount, 'outcome': 'ok', 'actual_metered_usd': amount / 2,
             'measurement': 'actual_metered'} for i in range(count)]


def process_save(path, rev, identity):
    """Attempt a cross-process revision-checked write and report its outcome."""
    try:
        B.mutate(identity, if_rev=rev, budget=budget(id=identity), path=path)
        return 'saved'
    except B.BudgetConflict:
        return 'conflict'


class BudgetStoreTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.path = Path(tmp.name) / 'budgets.json'

    def save(self, value=None, rev=None):
        """Save one fixture against either an explicit or freshly loaded revision."""
        value = value or budget()
        return B.mutate(value['id'], budget=value, if_rev=rev or B.load(self.path)['rev'], path=self.path)

    def test_create_edit_delete_revision_contract(self):
        original = B.load(self.path)
        saved = self.save()
        self.assertNotEqual(original['rev'], saved['rev'])
        with self.assertRaises(B.BudgetConflict):
            self.save(budget(amount=70), original['rev'])
        edited = self.save(budget(amount=70), saved['rev'])
        self.assertEqual(edited['budgets'][0]['amount'], 70)
        with self.assertRaises(B.BudgetConflict):
            B.mutate('total', if_rev='', path=self.path)
        removed = B.mutate('total', if_rev=edited['rev'], path=self.path)
        self.assertEqual(removed['budgets'], [])
        with self.assertRaises(KeyError):
            B.mutate('absent', if_rev=removed['rev'], path=self.path)

    def test_two_processes_with_same_revision_cannot_lose_updates(self):
        rev = B.load(self.path)['rev']
        ctx = multiprocessing.get_context('spawn')
        with ctx.Pool(2) as pool:
            results = pool.starmap(process_save, [(self.path, rev, 'a'), (self.path, rev, 'b')])
        self.assertCountEqual(results, ['saved', 'conflict'])
        self.assertEqual(len(B.load(self.path)['budgets']), 1)

    def test_failed_replace_preserves_original_and_cleans_tempfile(self):
        saved = self.save()
        before = self.path.read_bytes()
        with patch.object(B.os, 'replace', side_effect=OSError('fixture')):
            with self.assertRaises(OSError):
                self.save(budget(amount=70), saved['rev'])
        self.assertEqual(self.path.read_bytes(), before)
        self.assertEqual(list(self.path.parent.glob('*.tmp')), [])

    def test_close_failure_during_write_cleanup_still_removes_tempfile(self):
        """Remove temporary budget data even when closing after a write error fails."""
        saved = self.save()
        before = self.path.read_bytes()
        handle = tempfile.NamedTemporaryFile('w', dir=self.path.parent, delete=False, suffix='.tmp')
        close = handle.close
        self.addCleanup(close)

        def fail_close():
            """Close the real fixture portably, then report an injected close failure."""
            close()
            raise OSError('fixture close failure')

        with patch.object(B.tempfile, 'NamedTemporaryFile', return_value=handle), \
                patch.object(B.json, 'dump', side_effect=OSError('fixture write failure')), \
                patch.object(handle, 'close', side_effect=fail_close):
            with self.assertRaisesRegex(OSError, 'fixture close failure'):
                self.save(budget(amount=70), saved['rev'])
        self.assertEqual(self.path.read_bytes(), before)
        self.assertEqual(list(self.path.parent.glob('*.tmp')), [])

    def test_corrupt_documents_fail_closed_without_rewriting(self):
        """Reject damaged documents on read and write while preserving their original bytes."""
        for bad in ['{', 'null', '[]', '{"version":2,"budgets":[],"dismissals":{}}',
                    '{"version":1,"budgets":[{}],"dismissals":{}}',
                    '{"version":1,"budgets":[],"dismissals":{"x":{}}}']:
            self.path.write_text(bad)
            with self.assertRaises(B.BudgetStoreUnreadable):
                B.load(self.path)
            with self.assertRaises(B.BudgetStoreUnreadable):
                self.save()
            self.assertEqual(self.path.read_text(), bad)

    def test_validation_rejects_invalid_and_cross_metric_configuration(self):
        """Reject invalid settings and allow the supported combinations of scope and metric."""
        for changes in [{'amount': True}, {'amount': float('nan')}, {'amount': -1}, {'amount': 0},
                        {'thresholds': [80, 50, 100]}, {'thresholds': [50, 80, 101]},
                        {'enabled': 'true'}, {'thresholds': [50, 10**1000, 100]}, {'timezone': 'Not/AZone'}, {'cycle_day': 32},
                        {'scope': 'model_route'}, {'scope': 'total', 'provider': 'x'},
                        {'scope': 'session', 'measurement': 'actual_metered'},
                        {'scope': 'session', 'currency': 'GBP'}, {'currency': 'usd'}, {'unexpected': 2}]:
            with self.subTest(changes=changes):
                with self.assertRaises(ValueError):
                    self.save(budget(**changes))
        for scope, extra in [('total', {}), ('provider', {'provider': 'x'}),
                             ('model_route', {'provider': 'x', 'model': 'm'}), ('session', {})]:
            for metric in ['api_equivalent', 'actual_metered'] if scope != 'session' else ['api_equivalent']:
                self.assertEqual(B.validation_errors(budget(scope=scope, measurement=metric, **extra)), [])

    def test_dismissals_survive_restart_and_edits_clear_them(self):
        saved = self.save()
        entry = {'cycle': F.cycle_bounds(budget(), NOW)['id'], 'budget_rev': B.revision(budget()), 'level': 'warning'}
        dismissed = B.mutate('total', if_rev=saved['rev'], dismissal=entry, path=self.path)
        self.assertEqual(B.load(self.path)['dismissals']['total'], entry)
        edited = self.save(budget(amount=80), dismissed['rev'])
        self.assertEqual(edited['dismissals'], {})


class ForecastTests(unittest.TestCase):
    def evaluate(self, b=None, evidence=None, **kwargs):
        """Evaluate fixture evidence with a known cycle observation window."""
        return F.evaluate(b or budget(), evidence if evidence is not None else rows(), now=kwargs.pop('now', NOW),
                          observed_since=kwargs.pop('observed_since', START), **kwargs)

    def test_exact_50_80_100_transitions_and_disabled(self):
        """Exercise exact threshold boundaries and the disabled guardrail state."""
        for spend, expected in [(49.99, 'normal'), (50, 'info'), (79.99, 'info'), (80, 'warning'), (100, 'exceeded')]:
            self.assertEqual(self.evaluate(evidence=rows(spend, 1))['level'], expected)
        self.assertEqual(self.evaluate(budget(enabled=False))['level'], 'disabled')
        self.assertEqual(self.evaluate(budget(enabled=False))['forecast']['reason'], 'disabled')

    def test_metrics_never_mix_and_subscription_fee_fields_are_ignored(self):
        """Keep catalogue value, actual charges, subscription fees and allowances separate."""
        evidence = rows(20)
        for row in evidence:
            row.update(subscription_fee_usd=1000, allowance_usd=1000, estimated_cost_usd=9000)
        estimate = self.evaluate(evidence=evidence)
        actual = self.evaluate(budget(measurement='actual_metered'), evidence)
        self.assertEqual(estimate['spend'], 80)
        self.assertEqual(actual['spend'], 40)
        self.assertEqual(actual['measurement'], 'actual_metered')
        for row in evidence:
            row['measurement'] = 'estimated'
        actual = self.evaluate(budget(measurement='actual_metered'), evidence)
        self.assertIsNone(actual['spend'])
        self.assertEqual(actual['level'], 'unavailable')

    def test_partial_subtotal_can_prove_warning_but_never_within_limit(self):
        """Allow proved subtotal warnings while refusing complete balances and forecasts."""
        evidence = rows(30, 4)
        evidence[0]['list_usd'] = None
        report = self.evaluate(evidence=evidence)
        self.assertEqual(report['spend'], 90)
        self.assertEqual(report['level'], 'warning')
        self.assertFalse(report['complete'])
        self.assertIsNone(report['remaining'])
        self.assertFalse(report['forecast']['available'])
        self.assertEqual(report['forecast']['reason'], 'incomplete_pricing')
        self.assertEqual(self.evaluate(evidence=[{**r, 'list_usd': 1 if i else None} for i, r in enumerate(evidence)])['level'], 'unavailable')

    def test_failed_or_missing_usage_is_not_free_or_priced(self):
        """Exclude failed attempts and missing usage instead of counting them as free."""
        for outcome in ['error', 'missing_usage']:
            evidence = rows()
            evidence[0]['outcome'] = outcome
            report = self.evaluate(evidence=evidence)
            self.assertFalse(report['forecast']['available'])
            self.assertEqual(report['spend'], 30)

    def test_three_active_days_required_not_three_calls(self):
        """Require activity on distinct days rather than a minimum count of calls."""
        evidence = rows(count=3)
        for row in evidence:
            row['ts'] = START + 86400
        report = self.evaluate(evidence=evidence)
        self.assertEqual(report['forecast']['reason'], 'insufficient_days')
        self.assertIsNone(report['forecast']['burn_30'])
        self.assertTrue(self.evaluate(evidence=rows(count=3))['forecast']['available'])

    def test_projection_runway_trend_and_samples(self):
        result = self.evaluate()
        f = result['forecast']
        self.assertTrue(f['available'])
        self.assertEqual(result['remaining'], 60)
        self.assertEqual(f['samples']['30']['active_days'], 4)
        self.assertEqual(f['samples']['30']['calls'], 4)
        self.assertAlmostEqual(f['burn_30'], 40 / 9.5)
        self.assertAlmostEqual(f['projected'], 40 + (40 / 9.5) * 20.5, places=5)
        self.assertEqual(f['days_remaining'], 14.25)
        self.assertIsNotNone(f['breach_date'])

    def test_forecasts_refuse_unavailable_currency_ledger_and_partial_cycle(self):
        self.assertEqual(self.evaluate(ledger_available=False)['forecast']['reason'], 'ledger_unavailable')
        self.assertEqual(self.evaluate(budget(currency='GBP'))['forecast']['reason'], 'currency_unavailable')
        self.assertEqual(self.evaluate(observed_since=START + 10)['forecast']['reason'], 'incomplete_cycle')
        self.assertEqual(self.evaluate(observed_since=None)['forecast']['reason'], 'insufficient_days')

    def test_user_supplied_fx_is_cited_and_future_rates_are_refused(self):
        rate = {'currency': 'GBP', 'usd_per_unit': 2, 'as_of': '2026-11-01', 'source': 'fixture'}
        result = self.evaluate(budget(currency='GBP'), fx={'rates': [rate]})
        self.assertEqual(result['spend'], 20)
        self.assertEqual(result['fx'], rate)
        self.assertEqual(self.evaluate(budget(currency='GBP'), fx={'rates': [{**rate, 'as_of': '2027-01-01'}]})['forecast']['reason'], 'currency_unavailable')

    def test_provider_model_route_filters_and_duplicate_attempts(self):
        evidence = rows(10) + [{**rows(80, 1)[0], 'event_id': 'other', 'provider': 'other'}]
        evidence.append(evidence[0])
        b = budget(scope='model_route', provider='fixture', model='m')
        self.assertEqual(self.evaluate(b, evidence)['spend'], 40)
        self.assertEqual(self.evaluate(budget(scope='provider', provider='other'), evidence)['spend'], 80)

    def test_cycle_half_open_boundary_leap_year_and_day31_clamping(self):
        b = budget(cycle_day=31)
        at = datetime(2028, 2, 29, tzinfo=timezone.utc).timestamp()
        bounds = F.cycle_bounds(b, at)
        self.assertEqual(bounds['start'][:10], '2028-02-29')
        self.assertEqual(bounds['end'][:10], '2028-03-31')
        before = F.cycle_bounds(b, at - .001)
        self.assertEqual(before['start'][:10], '2028-01-31')
        self.assertEqual(before['until'], bounds['since'])
        december = F.cycle_bounds(budget(), datetime(2026, 12, 31, tzinfo=timezone.utc).timestamp())
        self.assertEqual(december['end'][:10], '2027-01-01')
        evidence = [{'event_id': 'previous', 'ts': START - .001, 'list_usd': 999, 'outcome': 'ok'}, *rows(10, 1)]
        self.assertEqual(self.evaluate(evidence=evidence)['spend'], 10)

    def test_DST_boundaries_use_named_zone_not_fixed_seconds(self):
        """Keep calendar cycles and sample days correct across DST offset changes."""
        b = budget(timezone='Europe/London')
        spring = F.cycle_bounds(b, datetime(2026, 3, 20, tzinfo=timezone.utc).timestamp())
        autumn = F.cycle_bounds(b, datetime(2026, 10, 20, tzinfo=timezone.utc).timestamp())
        self.assertEqual(spring['until'] - spring['since'], 31 * 86400 - 3600)
        self.assertEqual(autumn['until'] - autumn['since'], 31 * 86400 + 3600)
        spring_now = datetime(2026, 3, 31, 12, tzinfo=ZoneInfo('Europe/London')).timestamp()
        evidence = [{**r, 'ts': datetime(2026, 3, i + 27, 12, tzinfo=ZoneInfo('Europe/London')).timestamp()} for i, r in enumerate(rows(10, 3))]
        report = F.evaluate(b, evidence, now=spring_now, observed_since=spring['since'])
        self.assertTrue(report['forecast']['available'])
        self.assertEqual(report['forecast']['samples']['30']['active_days'], 3)


    def test_burn_trend_has_accelerating_slowing_and_steady_states(self):
        """Classify supported burn-rate comparisons without predicting an unwarranted breach."""
        now = datetime(2026, 11, 20, 12, tzinfo=timezone.utc).timestamp()
        evidence = [{'event_id': str(i), 'ts': START + i * 86400 + 3600,
                     'provider': 'fixture', 'model': 'm', 'list_usd': 1,
                     'outcome': 'ok'} for i in range(20)]
        steady = self.evaluate(budget(amount=1000), evidence, now=now)
        self.assertEqual(steady['forecast']['trend'], 'steady')
        for mode, amount in [('accelerating', 5), ('slowing', .1)]:
            changed = [{**r, 'list_usd': amount if r['ts'] >= START + 13 * 86400 else 1} for r in evidence]
            self.assertEqual(self.evaluate(budget(amount=1000), changed, now=now)['forecast']['trend'], mode)
        self.assertIsNone(steady['forecast']['breach_date'])

    def test_breach_date_accounts_for_time_of_day(self):
        now = datetime(2026, 11, 10, 20, tzinfo=timezone.utc).timestamp()
        evidence = rows()
        # Half a day of runway at 20:00 crosses into the next date.
        rate = 40 / (9 + 20 / 24)
        result = self.evaluate(budget(amount=40 + rate / 2), evidence, now=now)
        self.assertEqual(result['forecast']['breach_date'], '2026-11-11')

    def test_real_store_adapter_prices_estimates_and_refuses_actual_charges(self):
        """Exercise real SQLite evidence, dismissals and refusal of unrecorded charges."""
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'budgets.json'
            events = Path(tmp) / 'usage.db'
            b = budget(amount=10)
            doc = B.mutate('total', if_rev=B.load(path)['rev'], budget=b, path=path)
            B.mutate('actual', if_rev=doc['rev'], budget=budget(id='actual', measurement='actual_metered'), path=path)
            with closing(sqlite3.connect(events)) as conn, conn:
                conn.executescript(store._SCHEMA)
                conn.execute('INSERT INTO baseline VALUES (1, ?, 0, 0, 0)', (START,))
                for i in range(4):
                    conn.execute('INSERT INTO calls(event_id, ts, model, provider, outcome, input_tokens, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
                                 (str(i), START + (i + 1) * 86400, 'm', 'fixture', 'ok', 1000000, NOW))
            book = Catalogue({'fixture': {'m': Rate(2, 4, .5, 3)}}, 'fixture', 'test', '', '1')
            report = F.build_report(path=path, event_db_path=events, now=NOW, catalogue=book, fx_path=Path(tmp)/'fx.json')
            est, actual = report['statuses']
            self.assertEqual(est['spend'], 8)
            self.assertEqual(est['level'], 'warning')
            self.assertTrue(est['forecast']['available'])
            self.assertIsNone(actual['spend'])
            self.assertEqual(actual['forecast']['reason'], 'metered_unavailable')
            B.mutate('total', if_rev=report['rev'], dismissal={'cycle': est['cycle']['id'], 'budget_rev': est['budget_rev'], 'level': 'warning'}, path=path)
            self.assertTrue(F.build_report(path=path, event_db_path=events, now=NOW, catalogue=book)['statuses'][0]['dismissed'])
            # A higher threshold is a new alert; a cycle reset is a new alert.
            with closing(sqlite3.connect(events)) as conn, conn:
                conn.execute('UPDATE calls SET input_tokens=2000000')
            self.assertFalse(F.build_report(path=path, event_db_path=events, now=NOW, catalogue=book)['statuses'][0]['dismissed'])
            events.write_bytes(b'corrupt ledger')
            refused = F.build_report(path=path, event_db_path=events, now=NOW, catalogue=book)
            self.assertEqual(refused['statuses'][0]['forecast']['reason'], 'ledger_unavailable')


class ReviewReportRegressions(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.path = Path(tmp.name) / 'budgets.json'
        self.events = Path(tmp.name) / 'usage.db'

    def test_no_monthly_limits_never_open_or_price_the_ledger(self):
        """Return empty monthly statuses without reader, pricing or FX work."""
        for configured in [[], [budget(id='session', scope='session')]]:
            doc = {'version': 1, 'budgets': configured, 'dismissals': {}, 'rev': 'fixture'}
            with self.subTest(configured=configured), patch.object(B, 'load', return_value=doc), \
                    patch.object(store, 'connect_reader') as reader, \
                    patch.object(F, 'load_catalogue') as catalogue, \
                    patch.object(F, '_per_call_value') as price, \
                    patch.object(F.economics, 'load_fx') as fx:
                reader.return_value = None
                result = F.build_report(now=NOW)
                self.assertEqual(result['statuses'], [])
                self.assertEqual(result['budgets'], configured)
                self.assertEqual(result['rev'], 'fixture')
                reader.assert_not_called()
                catalogue.assert_not_called()
                price.assert_not_called()
                fx.assert_not_called()

    def test_readable_empty_ledger_is_insufficient_days_not_unavailable(self):
        B.mutate('total', if_rev=B.load(self.path)['rev'], budget=budget(), path=self.path)
        with closing(sqlite3.connect(self.events)) as conn:
            conn.executescript(store._SCHEMA)
        report = F.build_report(path=self.path, event_db_path=self.events, now=NOW)
        status = report['statuses'][0]
        self.assertEqual(status['forecast']['reason'], 'insufficient_days')
        self.assertIsNone(status['spend'])
        self.assertIsNone(status['forecast']['projected'])
        self.assertEqual(status['coverage']['calls'], 0)

    def test_price_cache_reuses_only_unchanged_calls_and_catalogue_data(self):
        """Cache repeat status pricing while retaining disabled-row coverage and invalidating changes."""
        disabled = budget(amount=10, enabled=False)
        B.mutate('total', if_rev=B.load(self.path)['rev'], budget=disabled, path=self.path)
        with closing(sqlite3.connect(self.events)) as conn, conn:
            conn.executescript(store._SCHEMA)
            conn.execute('INSERT INTO baseline VALUES (1, ?, 0, 0, 0)', (START,))
            for i in range(4):
                conn.execute('INSERT INTO calls(event_id, ts, model, provider, outcome, input_tokens, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
                             (f'cache-{i}', START + (i + 1) * 86400, 'm', 'cache-fixture', 'ok', 1000000, NOW))
        book = Catalogue({'cache-fixture': {'m': Rate(2, 4, .5, 3)}}, 'fixture', 'test', '', '1')
        with patch.object(F, '_per_call_value', wraps=F._per_call_value) as price_call:
            first = F.build_report(path=self.path, event_db_path=self.events, now=NOW, catalogue=book)['statuses'][0]
            self.assertEqual((first['spend'], first['coverage']['calls'], first['coverage']['measured_calls'], first['level']),
                             (8, 4, 4, 'disabled'))
            F.build_report(path=self.path, event_db_path=self.events, now=NOW, catalogue=book)
            self.assertEqual(price_call.call_count, 4)

            with closing(sqlite3.connect(self.events)) as conn, conn:
                conn.execute("UPDATE calls SET input_tokens=2000000 WHERE event_id='cache-0'")
            changed_call = F.build_report(path=self.path, event_db_path=self.events, now=NOW, catalogue=book)['statuses'][0]
            self.assertEqual(price_call.call_count, 5)
            self.assertEqual(changed_call['spend'], 10)
            self.assertEqual(changed_call['coverage']['measured_calls'], 4)

            book.providers['cache-fixture']['m'] = Rate(4, 8, .5, 3)
            changed_catalogue = F.build_report(path=self.path, event_db_path=self.events, now=NOW, catalogue=book)['statuses'][0]
            self.assertEqual(price_call.call_count, 9)
            self.assertEqual(changed_catalogue['spend'], 20)
            self.assertEqual(changed_catalogue['coverage']['calls'], 4)
            self.assertEqual(changed_catalogue['coverage']['measured_calls'], 4)

    def test_monthly_guardrails_do_not_treat_cache_fallbacks_as_complete_prices(self):
        """Reject guessed cache prices while accepting documented zero cache prices."""
        B.mutate('total', if_rev=B.load(self.path)['rev'], budget=budget(amount=1), path=self.path)
        with closing(sqlite3.connect(self.events)) as conn, conn:
            conn.executescript(store._SCHEMA)
            conn.execute('INSERT INTO baseline VALUES (1, ?, 0, 0, 0)', (START,))
            for i in range(3):
                conn.execute('INSERT INTO calls(event_id, ts, model, provider, outcome, input_tokens, cache_read_tokens, cache_write_tokens, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
                             (str(i), START + (i + 1) * 86400, 'm', 'fixture', 'ok', 10, 1000000, 1000000, NOW))
        for read, write in [(None, 2), (.1, None)]:
            book = Catalogue({'fixture': {'m': Rate(1, 1, read, write)}}, 'fixture', 'test', '', '1')
            result = F.build_report(path=self.path, event_db_path=self.events, now=NOW, catalogue=book)['statuses'][0]
            self.assertIsNone(result['spend'])
            self.assertEqual(result['level'], 'unavailable')
            self.assertFalse(result['forecast']['available'])
            self.assertEqual(result['forecast']['reason'], 'incomplete_pricing')
        # Explicit zero is a real price, not missing information.
        book = Catalogue({'fixture': {'m': Rate(1, 1, 0, 0)}}, 'fixture', 'test', '', '1')
        result = F.build_report(path=self.path, event_db_path=self.events, now=NOW, catalogue=book)['statuses'][0]
        self.assertTrue(result['forecast']['available'])
        self.assertTrue(result['complete'])

    def test_invalid_persisted_fx_rates_are_refused_by_the_report_loader(self):
        """Pass invalid persisted FX through the production loader and refuse conversion."""
        B.mutate('total', if_rev=B.load(self.path)['rev'], budget=budget(currency='GBP'), path=self.path)
        with closing(sqlite3.connect(self.events)) as conn, conn:
            conn.executescript(store._SCHEMA)
            conn.execute('INSERT INTO baseline VALUES (1, ?, 0, 0, 0)', (START,))
            for i in range(3):
                conn.execute('INSERT INTO calls(event_id, ts, model, provider, outcome, input_tokens, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
                             (str(i), START + (i + 1) * 86400, 'm', 'fixture', 'ok', 100000, NOW))
        path = self.path.with_name('fx.json')
        book = Catalogue({'fixture': {'m': Rate(1, 1)}}, 'fixture', 'test', '', '1')
        for value in [0, -1, float('nan'), None]:
            rate = {'currency': 'GBP', 'as_of': '2026-11-01', 'source': 'synthetic'}
            if value is not None:
                rate['usd_per_unit'] = value
            path.write_text(json.dumps({'rates': [rate]}))
            with self.subTest(value=value):
                result = F.build_report(path=self.path, event_db_path=self.events, now=NOW,
                                        catalogue=book, fx_path=path)['statuses'][0]
                self.assertEqual(result['forecast']['reason'], 'currency_unavailable')
                self.assertIsNone(result['spend'])
                self.assertIsNone(result['forecast']['projected'])


class PerCallTierForecastRegressions(unittest.TestCase):
    """One SQLite row is a physical call, not a cumulative session average."""
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.path = Path(tmp.name) / 'budgets.json'
        self.events = Path(tmp.name) / 'usage.db'
        B.mutate('total', if_rev=B.load(self.path)['rev'], budget=budget(amount=2), path=self.path)

    def report(self, rate, *, input_tokens=300000, output_tokens=0,
               cache_read_tokens=0, cache_write_tokens=0, **overrides):
        """Record three physical calls and compare budget valuation with legacy analytics."""
        from wolfmark_ledger.aggregate import _event_result
        book = Catalogue({'fixture': {'m': rate}}, 'fixture', 'test', '', '1')
        with closing(sqlite3.connect(self.events)) as conn, conn:
            conn.executescript(store._SCHEMA)
            conn.execute('DELETE FROM calls')
            conn.execute('INSERT OR REPLACE INTO baseline VALUES (1, ?, 0, 0, 0)', (START,))
            for i in range(3):
                prompt = input_tokens + cache_read_tokens + cache_write_tokens
                row = {'event_id': str(i), 'ts': START + (i + 1) * 86400,
                       'model': 'm', 'provider': 'fixture', 'outcome': 'ok',
                       'input_tokens': input_tokens, 'output_tokens': output_tokens,
                       'cache_read_tokens': cache_read_tokens, 'cache_write_tokens': cache_write_tokens,
                       'prompt_tokens': prompt, 'total_tokens': prompt + output_tokens,
                       # This field is the request ordinal, not a call cardinality.
                       'api_call_count': 40 + i, 'recorded_at': NOW, **overrides}
                columns = list(row)
                conn.execute(f"INSERT INTO calls ({','.join(columns)}) VALUES ({','.join('?' for _ in columns)})", list(row.values()))
        legacy = _event_result(row, book, 'list', {'exact': {}}, at=row['ts'])
        result = F.build_report(path=self.path, event_db_path=self.events, now=NOW, catalogue=book)
        return result['statuses'][0], legacy

    def test_discounted_tier_cannot_trigger_a_warning_from_the_higher_base_price(self):
        from wolfmark_ledger.pricing import Tier
        rate = Rate(10, 20, tiers=(Tier(200000, input=1, output=2),))
        result, legacy = self.report(rate)
        self.assertAlmostEqual(result['spend'], .9)
        self.assertEqual(result['level'], 'normal')
        self.assertTrue(result['complete'])
        self.assertTrue(result['forecast']['available'])
        self.assertEqual(legacy['list_usd'], 3, 'shared analytics keeps its existing upper-bound behaviour')

    def test_cache_prices_supplied_only_by_the_applicable_tier_are_measured(self):
        from wolfmark_ledger.pricing import Tier
        rate = Rate(10, 20, tiers=(Tier(200000, input=1, output=2, cache_read=.1, cache_write=2),))
        result, legacy = self.report(rate, input_tokens=100000, output_tokens=10000,
                                     cache_read_tokens=100000, cache_write_tokens=100000)
        self.assertIsNotNone(result['spend'])
        self.assertAlmostEqual(result['spend'], .99)
        self.assertEqual(result['coverage']['measured_calls'], 3)
        self.assertTrue(result['complete'])
        self.assertTrue(result['forecast']['available'])
        self.assertTrue(legacy['pricing']['cache_read_defaulted'])
        self.assertTrue(legacy['pricing']['cache_write_defaulted'])

    def test_explicit_tier_cache_zeroes_are_supported_without_a_fallback(self):
        from wolfmark_ledger.pricing import Tier
        rate = Rate(10, 20, tiers=(Tier(200000, input=1, output=2, cache_read=0, cache_write=0),))
        result, _ = self.report(rate, input_tokens=100000, cache_read_tokens=100000, cache_write_tokens=100000)
        self.assertIsNotNone(result['spend'])
        self.assertAlmostEqual(result['spend'], .3)
        self.assertTrue(result['forecast']['available'])

    def test_tier_selection_respects_the_strict_boundary_and_inherited_base_prices(self):
        from wolfmark_ledger.pricing import Tier
        rate = Rate(10, 20, .5, 3, tiers=(Tier(200000, input=1, output=2),))
        at_boundary, _ = self.report(rate, input_tokens=200000)
        above_boundary, _ = self.report(rate, input_tokens=200001)
        inherited, _ = self.report(rate, input_tokens=100000, cache_read_tokens=100000, cache_write_tokens=100000)
        self.assertEqual(at_boundary['spend'], 6)
        self.assertAlmostEqual(above_boundary['spend'], .600003)
        self.assertAlmostEqual(inherited['spend'], 1.35)
        self.assertTrue(inherited['complete'])

    def test_a_non_applicable_tier_cannot_supply_missing_cache_prices(self):
        from wolfmark_ledger.pricing import Tier
        rate = Rate(10, 20, tiers=(Tier(500000, input=1, output=2, cache_read=.1, cache_write=2),))
        result, _ = self.report(rate, input_tokens=100000, cache_read_tokens=100000, cache_write_tokens=100000)
        self.assertIsNone(result['spend'])
        self.assertFalse(result['complete'])
        self.assertEqual(result['forecast']['reason'], 'incomplete_pricing')

    def test_one_missing_effective_cache_price_keeps_the_call_unpriced(self):
        """Keep a call incomplete if either used cache stream lacks an effective price."""
        from wolfmark_ledger.pricing import Tier
        for read, write in [(None, 2), (.1, None)]:
            rate = Rate(10, 20, tiers=(Tier(200000, input=1, output=2, cache_read=read, cache_write=write),))
            result, _ = self.report(rate, input_tokens=100000, cache_read_tokens=100000, cache_write_tokens=100000)
            self.assertIsNone(result['spend'])
            self.assertEqual(result['forecast']['reason'], 'incomplete_pricing')

    def test_inconsistent_recorded_prompt_or_total_cannot_select_a_discounted_tier(self):
        """Refuse tier selection when reported totals contradict the recorded buckets."""
        from wolfmark_ledger.pricing import Tier
        rate = Rate(10, 20, tiers=(Tier(200000, input=1, output=2),))
        for evidence in [{'prompt_tokens': 400000}, {'total_tokens': 400000}]:
            result, _ = self.report(rate, **evidence)
            self.assertIsNone(result['spend'])
            self.assertFalse(result['complete'])
            self.assertIsNone(result['forecast']['projected'])
            self.assertEqual(result['forecast']['reason'], 'incomplete_pricing')


class StatusReadWorkRegressions(unittest.TestCase):
    """Status pricing must classify outcomes before doing catalogue work."""

    def item(self, outcome):
        """Return a synthetic complete call above a discounted tier boundary."""
        return {'provider': 'fixture', 'model': 'm', 'ts': NOW, 'outcome': outcome,
                'input_tokens': 300000, 'output_tokens': 0,
                'cache_read_tokens': 0, 'cache_write_tokens': 0}

    def test_failed_and_missing_usage_calls_never_touch_lookup_or_pricing(self):
        """Reject known failure outcomes before touching an unavailable price book."""
        from unittest.mock import Mock
        for outcome in ('error', 'missing_usage'):
            book = Mock()
            book.lookup.side_effect = AssertionError('rejected calls must not query prices')
            with self.subTest(outcome=outcome), patch.object(F, 'price') as pricer:
                self.assertIsNone(F._per_call_value(self.item(outcome), book))
                book.lookup.assert_not_called()
                pricer.assert_not_called()

    def test_other_outcomes_keep_their_value_with_one_lookup_and_one_price(self):
        """Preserve the former outcome normalisation while removing duplicate work."""
        from unittest.mock import Mock
        from wolfmark_ledger.pricing import Tier
        catalogue = Catalogue({'fixture': {'m': Rate(10, 20, tiers=(Tier(200000, input=1, output=2),))}},
                              'fixture', 'test', '', '1')
        for outcome in ('ok', None, '', 'custom'):
            book = Mock()
            book.lookup.side_effect = catalogue.lookup
            with self.subTest(outcome=outcome), patch.object(F, 'price', wraps=F.price) as pricer:
                self.assertEqual(F._per_call_value(self.item(outcome), book), .3)
                book.lookup.assert_called_once_with('fixture', 'm', at=NOW)
                self.assertEqual(pricer.call_count, 1)
