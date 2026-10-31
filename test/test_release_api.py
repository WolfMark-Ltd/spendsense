"""Release-contract regression: object bodies save, string bodies are rejected."""
import importlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

api = None
FastAPI = None  # type: ignore
TestClient = None  # type: ignore
try:
    from fastapi import FastAPI  # type: ignore[no-redef]
    from fastapi.testclient import TestClient  # type: ignore[no-redef]
except Exception:  # pragma: no cover - depends on the test interpreter
    FastAPI = None  # type: ignore
    TestClient = None  # type: ignore

if FastAPI is not None and TestClient is not None:
    import dashboard.plugin_api as api  # type: ignore[no-redef]

from wolfmark_ledger import billing


@unittest.skipUnless(FastAPI is not None and TestClient is not None,
                     "FastAPI/httpx not installed in this interpreter")
class BillingSaveContract(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()) / "billing-profiles.json"
        self.patch = mock.patch.object(billing, "profiles_path", return_value=self.tmp)
        self.patch.start()
        self.addCleanup(self.patch.stop)
        importlib.reload(api)
        app = FastAPI()
        app.include_router(api.router, prefix="/api/plugins/wolfmark-cost-ledger")
        self.client = TestClient(app)
        self.url = "/api/plugins/wolfmark-cost-ledger/billing/profiles/goat"

    def test_object_body_is_accepted(self):
        response = self.client.put(self.url, json={"provider": "commandcode", "kind": "prepaid"})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["profiles"][0]["id"], "goat")

    def test_json_string_body_is_rejected_like_the_live_defect(self):
        double_encoded = json.dumps(json.dumps({"provider": "commandcode", "kind": "api"}))
        response = self.client.put(self.url, content=double_encoded,
                                   headers={"Content-Type": "application/json"})
        self.assertEqual(response.status_code, 422, response.text)

    def test_stale_revision_returns_409_and_validation_422(self):
        first = self.client.put(self.url, json={"provider": "commandcode", "kind": "api"})
        self.assertEqual(first.status_code, 200)
        stale = self.client.put(self.url, json={"provider": "commandcode", "kind": "api"})
        self.assertEqual(stale.status_code, 409, stale.text)
        invalid = self.client.put("/api/plugins/wolfmark-cost-ledger/billing/profiles/bad",
                                  json={"provider": "commandcode", "kind": "nonsense"})
        self.assertEqual(invalid.status_code, 422)


@unittest.skipUnless(FastAPI is not None and TestClient is not None,
                     "FastAPI/httpx not installed in this interpreter")
class MembershipBillingSummaryContract(unittest.TestCase):
    def setUp(self):
        app = FastAPI()
        app.include_router(api.router, prefix="/api/plugins/wolfmark-cost-ledger")
        self.client = TestClient(app)
        self.addCleanup(self.client.close)

    def test_summary_uses_membership_fees_and_excludes_legacy_subscription_copies(self):
        profile_rows = [{"id": "old-subscription", "kind": "subscription_included",
                         "billing_cycle": {"period": "month"}}]
        membership_fees = {
            "catalogue_version": "fixture",
            "fees": [{"account_id": "commandcode:default", "amount": 10,
                      "currency": "USD", "period": "month", "basis": "catalogue"},
                     {"account_id": "openai-codex:default", "amount": 20,
                      "currency": "USD", "period": "month", "basis": "catalogue"}],
            "totals_by_currency_period": {"USD/month": 30.0},
        }
        seen = {}

        def report(*, days):
            seen["days"] = days
            return {"window": {"days": days}, "billing": {
                "subscription_fees_usd": 999.0,
                "fees_by_profile": {"old-subscription": 999.0},
                "legacy_membership_arrangements_ignored": 1,
                "evidence": {"subscription_fee": {"usd": 999.0}},
            }}

        with mock.patch.object(api.billing, "load_profiles",
                               return_value={"profiles": profile_rows, "loaded": True}), \
             mock.patch.object(api, "build_analytics_report", side_effect=report), \
             mock.patch.object(api.members, "fee_summary_payload", return_value=membership_fees):
            response = self.client.get("/api/plugins/wolfmark-cost-ledger/billing/summary")

        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertEqual(seen["days"], 32)
        self.assertEqual(body["billing"]["subscription_fees_usd"], 30.0)
        self.assertEqual(body["billing"]["fees_by_profile"], {})
        self.assertEqual(body["billing"]["membership_fees"], membership_fees)
        self.assertEqual(body["billing"]["legacy_membership_arrangements_ignored"], 1)
        self.assertEqual(body["billing"]["evidence"]["subscription_fee"]["usd"], 30.0)
        self.assertIn("Memberships is the only subscription-fee source",
                      body["billing"]["evidence"]["subscription_fee"]["source"])


if __name__ == "__main__":
    unittest.main()
