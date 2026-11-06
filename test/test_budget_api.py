"""HTTP budget contract with a synthetic profile and no network."""
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from fastapi import FastAPI
from fastapi.testclient import TestClient
from dashboard import plugin_api
from wolfmark_ledger import budgets
from test_budgets import budget


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

    def test_status_and_forecast_return_clear_unavailable_not_zero(self):
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
