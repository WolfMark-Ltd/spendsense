"""HTTP budget contract with a synthetic profile and no network.

Skipped when FastAPI/httpx are not installed, like the other API suites.
"""
import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from unittest.mock import patch
from wolfmark_ledger import budgets
from wolfmark_ledger.pricing import Catalogue, Rate
from test_budgets import budget, NOW, START

plugin_api = None
FastAPI = None
TestClient = None
try:
    from fastapi import FastAPI  # type: ignore[no-redef]
    from fastapi.testclient import TestClient  # type: ignore[no-redef]

    from dashboard import plugin_api  # type: ignore[no-redef]
except ImportError:  # pragma: no cover - depends on the test interpreter
    # dashboard.plugin_api raises ModuleNotFoundError (an ImportError) when
    # FastAPI is absent; any other import failure propagates instead of
    # silently skipping the suite.
    pass


@unittest.skipUnless(FastAPI is not None and TestClient is not None,
                     "FastAPI/httpx not installed in this interpreter")
class BudgetApiTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.path = Path(tmp.name) / 'budgets.json'
        self.addCleanup(patch.stopall)
        patch.object(budgets, 'store_path', return_value=self.path).start()
        patch.object(plugin_api.store, 'event_db_path', return_value=Path(tmp.name)/'absent.db').start()
        app = FastAPI()
        app.include_router(plugin_api.router)
        self.client = TestClient(app)
        self.addCleanup(self.client.close)

    def test_crud_validation_and_revision_conflicts(self):
        doc = self.client.get('/budgets').json()
        self.assertEqual(self.client.put('/budgets/x', json=budget(id='x')).status_code, 422)
        self.assertEqual(self.client.put('/budgets/x', params={'if_rev': doc['rev']}, json=budget(id='x', amount=-2)).status_code, 422)
        first = self.client.put('/budgets/x', params={'if_rev': doc['rev']}, json=budget(id='x'))
        self.assertEqual(first.status_code, 200)
        self.assertEqual(self.client.put('/budgets/x', params={'if_rev': doc['rev']}, json=budget(id='x', amount=90)).status_code, 409)
        saved = self.client.put('/budgets/x', params={'if_rev': first.json()['rev']}, json=budget(id='x', amount=90))
        self.assertEqual(saved.status_code, 200)
        self.assertEqual(self.client.delete('/budgets/x', params={'if_rev': first.json()['rev']}).status_code, 409)
        self.assertEqual(self.client.delete('/budgets/x', params={'if_rev': saved.json()['rev']}).status_code, 200)
        self.assertEqual(self.client.get('/budgets').json()['budgets'], [])

    def test_corrupt_store_is_503_with_no_private_error_detail_or_rewrite(self):
        self.path.write_text('{private-sentinel')
        self.assertEqual(self.client.get('/budgets').status_code, 503)
        result = self.client.put('/budgets/x', params={'if_rev': 'old'}, json=budget(id='x'))
        self.assertEqual(result.status_code, 503)
        self.assertNotIn('private-sentinel', result.text)
        self.assertEqual(self.path.read_text(), '{private-sentinel')

    def test_directory_sync_failure_reports_uncertain_write_and_keeps_replacement_readable(self):
        """Tell clients to reload when rename succeeded but its directory sync failed."""
        doc = self.client.get('/budgets').json()
        with patch.object(budgets, '_sync_parent_directory', side_effect=OSError('fixture directory sync failure')):
            response = self.client.put('/budgets/x', params={'if_rev': doc['rev']}, json=budget(id='x'))
        self.assertEqual(response.status_code, 503)
        self.assertIn('budget_write_uncertain', response.json()['detail'])
        persisted = self.client.get('/budgets').json()
        self.assertEqual(persisted['budgets'][0]['id'], 'x')

    def test_status_and_forecast_return_clear_unavailable_not_zero(self):
        """Require both status aliases to preserve unknown spend when the ledger is absent."""
        doc = self.client.get('/budgets').json()
        self.client.put('/budgets/x', params={'if_rev': doc['rev']}, json=budget(id='x'))
        for path in ['/budgets/status', '/forecast']:
            response = self.client.get(path)
            self.assertEqual(response.status_code, 200)
            status = response.json()['statuses'][0]
            self.assertIsNone(status['spend'])
            self.assertEqual(status['forecast']['reason'], 'ledger_unavailable')

    def test_dismissal_is_cycle_and_budget_revision_scoped(self):
        doc = self.client.get('/budgets').json()
        self.client.put('/budgets/x', params={'if_rev': doc['rev']}, json=budget(id='x'))
        status = self.client.get('/budgets/status').json()
        item = status['statuses'][0]
        body = {'cycle': item['cycle']['id'], 'budget_rev': item['budget_rev'], 'level': 'warning'}
        response = self.client.post('/budgets/x/dismiss', params={'if_rev': status['rev']}, json=body)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.client.post('/budgets/x/dismiss', params={'if_rev': status['rev']}, json=body).status_code, 409)
        self.assertEqual(self.client.post('/budgets/x/dismiss', params={'if_rev': response.json()['rev']}, json={**body, 'cycle': 'old-cycle'}).status_code, 422)

    def test_populated_status_and_forecast_serialize_warning_and_dismissal(self):
        """Read real SQLite usage through both HTTP aliases and persist a warning dismissal."""
        events = self.path.with_name('usage.db')
        with closing(sqlite3.connect(events)) as conn, conn:
            conn.executescript(plugin_api.store._SCHEMA)
            conn.execute('INSERT INTO baseline VALUES (1, ?, 0, 0, 0)', (START,))
            for i in range(4):
                conn.execute('INSERT INTO calls(event_id, ts, model, provider, outcome, input_tokens, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
                             (str(i), START + (i + 1) * 86400, 'm', 'fixture', 'ok', 1000000, NOW))
        book = Catalogue({'fixture': {'m': Rate(2, 4, .5, 3)}}, 'fixture', 'test', '', '1')
        with patch.object(plugin_api.store, 'event_db_path', return_value=events), \
                patch.object(plugin_api.forecast, 'load_catalogue', return_value=book), \
                patch('time.time', return_value=NOW):
            doc = self.client.get('/budgets').json()
            saved = self.client.put('/budgets/x', params={'if_rev': doc['rev']}, json=budget(id='x', amount=10))
            self.assertEqual(saved.status_code, 200)
            for path in ('/budgets/status', '/forecast'):
                response = self.client.get(path)
                self.assertEqual(response.status_code, 200)
                report = response.json()
                item = report['statuses'][0]
                self.assertEqual(item['spend'], 8)
                self.assertEqual(item['level'], 'warning')
                self.assertEqual(item['measurement'], 'api_equivalent')
                self.assertTrue(item['forecast']['available'])
                self.assertFalse(item['dismissed'])
            body = {'cycle': item['cycle']['id'], 'budget_rev': item['budget_rev'], 'level': item['level']}
            dismissed = self.client.post('/budgets/x/dismiss', params={'if_rev': report['rev']}, json=body)
            self.assertEqual(dismissed.status_code, 200)
            response = self.client.get('/budgets/status')
            self.assertEqual(response.status_code, 200)
            item = response.json()['statuses'][0]
            self.assertTrue(item['dismissed'])
            self.assertEqual(item['spend'], 8)
            self.assertEqual(item['level'], 'warning')
