from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

plugin_api = None
FastAPI = None  # type: ignore
TestClient = None  # type: ignore
try:
    from fastapi import FastAPI  # type: ignore[no-redef]
    from fastapi.testclient import TestClient  # type: ignore[no-redef]

    from dashboard import plugin_api  # type: ignore[no-redef]
except Exception:  # pragma: no cover - depends on the test interpreter
    FastAPI = None  # type: ignore
    TestClient = None  # type: ignore
    plugin_api = None

from wolfmark_ledger import billing, membership_store


@unittest.skipUnless(FastAPI is not None and TestClient is not None,
                     "FastAPI/httpx not installed in this interpreter")
class UserDataResetApiTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        base = Path(self.directory.name)
        self.memberships = base / "memberships.json"
        self.profiles = base / "billing-profiles.json"
        self.ledger = base / "usage.db"
        self.memberships.write_text(json.dumps({"version": 1, "accounts": [
            {"id": "commandcode:default", "family": "commandcode", "label": "CommandCode", "plan_id": None}
        ]}))
        self.profiles.write_text(json.dumps({"version": 1, "profiles": [
            {"id": "wallet", "provider": "commandcode", "kind": "prepaid"}
        ]}))
        self.ledger.write_bytes(b"captured ledger is retained")
        app = FastAPI()
        app.include_router(plugin_api.router, prefix="/api/plugins/wolfmark-cost-ledger")
        self.client = TestClient(app)
        self.addCleanup(self.client.close)
        self.addCleanup(self.directory.cleanup)

    def patches(self):
        return (patch.object(membership_store, "store_path", return_value=self.memberships),
                patch.object(billing, "profiles_path", return_value=self.profiles))

    def test_confirmation_is_required_before_reset(self):
        before_memberships = self.memberships.read_bytes()
        before_profiles = self.profiles.read_bytes()
        with self.patches()[0], self.patches()[1]:
            response = self.client.post("/api/plugins/wolfmark-cost-ledger/settings/reset-user-data",
                                        json={"confirm": "no"})
        self.assertEqual(response.status_code, 400)
        self.assertEqual(self.memberships.read_bytes(), before_memberships)
        self.assertEqual(self.profiles.read_bytes(), before_profiles)

    def test_reset_clears_only_memberships_and_advanced_rules(self):
        with self.patches()[0], self.patches()[1]:
            response = self.client.post("/api/plugins/wolfmark-cost-ledger/settings/reset-user-data",
                                        json={"confirm": "RESET_USER_ENTERED_DATA"})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(json.loads(self.memberships.read_text())["accounts"], [])
        self.assertEqual(json.loads(self.profiles.read_text())["profiles"], [])
        self.assertEqual(self.ledger.read_bytes(), b"captured ledger is retained")
        self.assertIn("provider credentials", response.json()["retained"])

    def test_corrupt_storage_returns_503_without_changing_either_store(self):
        bad = b'{"version":1,"accounts":null}'
        self.memberships.write_bytes(bad)
        before_profiles = self.profiles.read_bytes()
        with self.patches()[0], self.patches()[1]:
            response = self.client.post("/api/plugins/wolfmark-cost-ledger/settings/reset-user-data",
                                        json={"confirm": "RESET_USER_ENTERED_DATA"})
        self.assertEqual(response.status_code, 503, response.text)
        self.assertEqual(self.memberships.read_bytes(), bad)
        self.assertEqual(self.profiles.read_bytes(), before_profiles)


if __name__ == "__main__":
    unittest.main()
