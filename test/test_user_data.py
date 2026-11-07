from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from wolfmark_ledger import billing, budgets, membership_store, user_data


class UserDataResetTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        base = Path(self.directory.name)
        self.memberships = base / "memberships.json"
        self.profiles = base / "billing-profiles.json"
        self.ledger = base / "usage.db"
        self.memberships.write_text(json.dumps({"version": 1, "accounts": []}))
        self.profiles.write_text(json.dumps({"version": 1, "profiles": []}))
        self.ledger.write_bytes(b"ledger sentinel")

    def tearDown(self):
        self.directory.cleanup()

    def paths(self):
        return (patch.object(membership_store, "store_path", return_value=self.memberships),
                patch.object(billing, "profiles_path", return_value=self.profiles))

    def test_reset_clears_only_plugin_user_data(self):
        self.memberships.write_text(json.dumps({"version": 1, "accounts": [
            {"id": "cc:default", "family": "commandcode", "label": "CommandCode"}
        ]}))
        self.profiles.write_text(json.dumps({"version": 1, "profiles": [
            {"id": "wallet", "provider": "commandcode", "kind": "prepaid"}
        ]}))
        with self.paths()[0], self.paths()[1]:
            result = user_data.reset_user_data()
        self.assertTrue(result["memberships_cleared"])
        self.assertEqual(json.loads(self.memberships.read_text())["accounts"], [])
        self.assertEqual(json.loads(self.profiles.read_text())["profiles"], [])
        self.assertEqual(self.ledger.read_bytes(), b"ledger sentinel")

    def test_corrupt_memberships_abort_before_any_store_is_changed(self):
        membership_bytes = b'{"version":1,"accounts":false}'
        billing_bytes = self.profiles.read_bytes()
        self.memberships.write_bytes(membership_bytes)
        with self.paths()[0], self.paths()[1], self.assertRaises(membership_store.StoreUnreadable):
            user_data.reset_user_data()
        self.assertEqual(self.memberships.read_bytes(), membership_bytes)
        self.assertEqual(self.profiles.read_bytes(), billing_bytes)

    def test_corrupt_advanced_rules_abort_before_memberships_are_changed(self):
        membership_bytes = self.memberships.read_bytes()
        billing_bytes = b'{"profiles":[false]}'
        self.profiles.write_bytes(billing_bytes)
        with self.paths()[0], self.paths()[1], self.assertRaises(billing.ProfileStoreUnreadable):
            user_data.reset_user_data()
        self.assertEqual(self.memberships.read_bytes(), membership_bytes)
        self.assertEqual(self.profiles.read_bytes(), billing_bytes)

    def test_reset_includes_budgets_and_preserves_usage(self):
        target = self.profiles.with_name('budgets.json')
        target.write_text(json.dumps({'version': 1, 'budgets': [], 'dismissals': {}}))
        with self.paths()[0], self.paths()[1]:
            result = user_data.reset_user_data()
        self.assertTrue(result['budgets_cleared'])
        self.assertEqual(budgets.load(target)['budgets'], [])
        self.assertEqual(self.ledger.read_bytes(), b'ledger sentinel')

    def test_corrupt_budget_aborts_reset_before_any_replacement(self):
        """Keep every store intact when the budget document cannot be understood."""
        target = self.profiles.with_name('budgets.json')
        target.write_bytes(b'{corrupt-budget')
        before = {p: p.read_bytes() for p in (self.memberships, self.profiles, target)}
        with self.paths()[0], self.paths()[1], self.assertRaises(budgets.BudgetStoreUnreadable):
            user_data.reset_user_data()
        self.assertEqual({p: p.read_bytes() for p in before}, before)

    def test_budget_replace_failure_rolls_back_all_stores(self):
        """Restore prior bytes and remove the seat file created by the failed reset."""
        target = self.profiles.with_name('budgets.json')
        target.write_text(json.dumps({'version': 1, 'budgets': [], 'dismissals': {}}))
        seats = membership_store.seat_store_path(self.memberships)
        self.assertFalse(seats.exists())
        before = {p: p.read_bytes() for p in (self.memberships, self.profiles, target)}
        self.fail_budget_reset(target)
        self.assertEqual({p: p.read_bytes() for p in before}, before)
        self.assertFalse(seats.exists())
        self.assertEqual(self.ledger.read_bytes(), b'ledger sentinel')

    def test_budget_replace_failure_restores_existing_seat_history_bytes(self):
        """Roll back populated seat history byte for byte alongside the other stores."""
        target = self.profiles.with_name('budgets.json')
        target.write_text(json.dumps({'version': 1, 'budgets': [], 'dismissals': {}}))
        seats = membership_store.seat_store_path(self.memberships)
        seats.write_text(json.dumps({'version': 1, 'accounts': {'fixture': {
            'family': 'openai-codex', 'identity': 'synthetic-account', 'revisions': [{
                'id': 'first', 'plan_id': 'openai-codex.chatgpt-business-premium',
                'quantity': 3, 'period': 'month', 'effective_from': '2026-11-01T00:00:00Z'}]}}}, indent=4) + '\n')
        membership_store.load_seat_store(self.memberships)
        before = {p: p.read_bytes() for p in (self.memberships, self.profiles, seats, target)}
        self.fail_budget_reset(target)
        self.assertEqual({p: p.read_bytes() for p in before}, before)
        self.assertEqual(self.ledger.read_bytes(), b'ledger sentinel')

    def fail_budget_reset(self, target):
        """Fail at the final reset replacement after the seat file has been replaced."""
        replace = user_data._replace_bytes
        def fail_budget(path, value):
            """Inject a failure only at the budget replacement step of the reset."""
            if path == target:
                raise OSError('fixture replacement failure')
            replace(path, value)
        with self.paths()[0], self.paths()[1], patch.object(user_data, '_replace_bytes', side_effect=fail_budget):
            with self.assertRaisesRegex(OSError, 'fixture replacement failure'):
                user_data.reset_user_data()


if __name__ == "__main__":
    unittest.main()
