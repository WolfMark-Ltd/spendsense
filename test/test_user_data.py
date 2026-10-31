from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from wolfmark_ledger import billing, membership_store, user_data


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


if __name__ == "__main__":
    unittest.main()
