from __future__ import annotations

import json
import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from unittest.mock import patch

from wolfmark_ledger import economics, membership, membership_api, membership_store, store
from wolfmark_ledger.pricing import Catalogue, Rate

try:
    from dashboard import plugin_api
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
except ImportError:
    FastAPI = None


AT = "2026-11-10T12:00:00Z"
SHARED_FROM = "2026-09-01T00:00:00Z"


def account(account_id: str, family: str, route_slugs: list[str], *, plan_id: str | None = None,
            arrangement: str = "subscription", identity: str | None = None,
            fee_overrides: list[dict] | None = None) -> dict:
    return {
        "id": account_id, "family": family, "label": account_id,
        "identity": identity, "route_slugs": route_slugs,
        "credential_present": True, "billing_arrangement": arrangement,
        "api_only": False, "plan_id": plan_id,
        "fee_overrides": list(fee_overrides or []), "manual_exhaustions": [],
    }


class EntitlementStoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.directory = Path(self.tmp.name)
        self.path = self.directory / "memberships.json"
        self.book = membership_api.load_plans()

    def save(self, row: dict) -> dict:
        return membership_store.save_account(row, self.path)["account"]

    def card(self, account_id: str, *, at: str = AT) -> dict:
        payload = membership_api.accounts_payload(
            path=self.path, catalogue=self.book, data_dir=self.directory, at=at)
        return next(row for row in payload["accounts"] if row["id"] == account_id)

    def arrange(self, account_id: str, arrangement: str, owner_id: str | None = None,
                *, at: str = AT) -> dict:
        current = self.card(account_id, at=at)
        return membership_store.set_account_arrangement(
            account_id, arrangement, if_rev=current["rev"],
            if_route_rev=current["route_entitlement_rev"], owner_account_id=owner_id,
            path=self.path, catalogue=self.book, at=at)

    def test_one_paid_entitlement_serves_multiple_routes_and_fee_is_counted_once(self):
        owner = self.save(account("commandcode:default", "commandcode", ["commandcode"],
                                  plan_id="commandcode.pro", identity="cc-account"))
        anthropic = self.save(account("anthropic:default", "anthropic", ["anthropic"],
                                      plan_id="anthropic.claude-pro", identity="anthropic-account"))
        openai = self.save(account("openai-codex:default", "openai-codex", ["openai-codex"],
                                  plan_id="openai-codex.chatgpt-plus", identity="openai-account"))

        self.arrange(anthropic["id"], "included", owner["id"], at=SHARED_FROM)
        self.arrange(openai["id"], "included", owner["id"], at=SHARED_FROM)

        payload = membership_api.accounts_payload(
            path=self.path, catalogue=self.book, data_dir=self.directory, at=AT)
        cards = {row["id"]: row for row in payload["accounts"]}
        self.assertEqual(cards[anthropic["id"]]["effective_arrangement"], "included")
        self.assertEqual(cards[openai["id"]]["effective_arrangement"], "included")
        self.assertEqual(cards[anthropic["id"]]["entitlement_owner_id"], owner["id"])
        self.assertEqual(cards[openai["id"]]["entitlement_owner_id"], owner["id"])
        self.assertEqual(cards[anthropic["id"]]["fee"]["effective"]["amount"], None)
        self.assertEqual(cards[openai["id"]]["fee"]["effective"]["amount"], None)

        fees = membership_api.fee_summary_payload(
            path=self.path, catalogue=self.book, data_dir=self.directory, at=AT)
        self.assertEqual([entry["account_id"] for entry in fees["fees"]], [owner["id"]])
        self.assertEqual(fees["totals_by_currency_period"], {"USD/month": 20.0})
        self.assertEqual(payload["entitlement_store"]["version"], membership_store.ENTITLEMENT_STORE_VERSION)

    def test_two_independent_paid_accounts_keep_two_fees(self):
        first = self.save(account("commandcode:personal", "commandcode", ["commandcode-personal"],
                                  plan_id="commandcode.pro", identity="personal"))
        second = self.save(account("commandcode:work", "commandcode", ["commandcode-work"],
                                   plan_id="commandcode.pro", identity="work"))
        fees = membership_api.fee_summary_payload(
            path=self.path, catalogue=self.book, data_dir=self.directory, at=AT)
        self.assertEqual({entry["account_id"] for entry in fees["fees"]}, {first["id"], second["id"]})
        self.assertEqual(fees["totals_by_currency_period"], {"USD/month": 40.0})

    def test_declared_recurring_fee_can_confirm_planless_owner(self):
        owner = self.save(account(
            "commandcode:declared", "commandcode", ["commandcode-declared"],
            identity="declared", fee_overrides=[{"id": "fee", "amount": 18,
                "currency": "GBP", "period": "month"}]))
        source = self.save(account("anthropic:source", "anthropic", ["anthropic-source"],
                                   plan_id="anthropic.claude-pro", identity="source"))
        self.arrange(source["id"], "included", owner["id"])
        self.assertEqual(self.card(source["id"])["entitlement_owner_id"], owner["id"])
        no_fee = self.save(account("commandcode:unknown", "commandcode", ["commandcode-unknown"],
                                   identity="unknown"))
        with self.assertRaisesRegex(ValueError, "confirmed paid subscription"):
            self.arrange(source["id"], "included", no_fee["id"])

    def test_billing_states_remain_distinct_and_free_tier_is_not_a_paid_entitlement(self):
        owner = self.save(account("commandcode:paid", "commandcode", ["commandcode-paid"],
                                  plan_id="commandcode.pro", identity="paid"))
        unknown = self.save(account("anthropic:unknown", "anthropic", ["anthropic-unknown"],
                                     plan_id="anthropic.claude-pro", arrangement="unconfirmed"))
        no_plan = self.save(account("anthropic:none", "anthropic", ["anthropic-none"],
                                    arrangement="unconfirmed"))
        prepaid = self.save(account("anthropic:wallet", "anthropic", ["anthropic-wallet"],
                                    plan_id="anthropic.claude-pro"))
        metered = self.save(account("openai-codex:api", "openai-codex", ["openai-codex-api"],
                                    plan_id="openai-codex.chatgpt-plus"))
        free = self.save(account("openai-codex:free", "openai-codex", ["openai-codex-free"],
                                 plan_id="openai-codex.chatgpt-free",
                                 fee_overrides=[{"id": "old-paid-fee", "amount": 20,
                                                 "currency": "USD", "period": "month"}]))

        self.arrange(no_plan["id"], "no_plan")
        self.arrange(prepaid["id"], "prepaid")
        self.arrange(metered["id"], "api_only")
        cards = {row["id"]: row for row in membership_api.accounts_payload(
            path=self.path, catalogue=self.book, data_dir=self.directory, at=AT)["accounts"]}

        self.assertEqual(cards[unknown["id"]]["effective_arrangement"], "unconfirmed")
        self.assertIsNone(cards[unknown["id"]]["fee"]["effective"]["amount"])
        self.assertEqual(cards[no_plan["id"]]["effective_arrangement"], "no_plan")
        self.assertIsNone(cards[no_plan["id"]]["fee"]["effective"]["amount"])
        self.assertEqual(cards[prepaid["id"]]["effective_arrangement"], "prepaid")
        self.assertIsNone(cards[prepaid["id"]]["fee"]["effective"]["amount"])
        self.assertEqual(cards[metered["id"]]["effective_arrangement"], "api_only")
        self.assertIsNone(cards[metered["id"]]["fee"]["effective"]["amount"])
        self.assertEqual(cards[free["id"]]["effective_arrangement"], "free_tier")
        self.assertEqual(cards[free["id"]]["fee"]["effective"]["amount"], 0)
        self.assertFalse(membership_store._paid_entitlement(free, self.book, AT))
        fee_ids = {entry["account_id"] for entry in membership_api.fee_summary_payload(
            path=self.path, catalogue=self.book, data_dir=self.directory, at=AT)["fees"]}
        self.assertEqual(fee_ids, {owner["id"], free["id"]})
        with self.assertRaisesRegex(ValueError, "confirmed paid subscription"):
            self.arrange(unknown["id"], "included", free["id"])
        self.assertNotEqual(owner["id"], no_plan["id"])

    def test_invalid_owners_duplicate_claims_and_stale_revision_are_rejected(self):
        owner = self.save(account("commandcode:paid", "commandcode", ["commandcode-paid"],
                                  plan_id="commandcode.pro", identity="paid"))
        source = self.save(account("anthropic:source", "anthropic", ["anthropic-source"],
                                    plan_id="anthropic.claude-pro", identity="source"))
        with self.assertRaisesRegex(ValueError, "cannot own its own"):
            self.arrange(source["id"], "included", source["id"])
        with self.assertRaisesRegex(ValueError, "does not exist"):
            self.arrange(source["id"], "included", "missing:account")

        duplicate = self.save(account("anthropic:duplicate", "anthropic", ["anthropic-source"],
                                      plan_id="anthropic.claude-pro", identity="duplicate"))
        with self.assertRaisesRegex(ValueError, "ambiguous"):
            self.arrange(source["id"], "included", owner["id"])
        membership_store.delete_account(duplicate["id"], self.path)

        current = self.card(source["id"])
        with self.assertRaises(membership_store.MembershipConflict):
            membership_store.set_account_arrangement(
                source["id"], "included", owner_account_id=owner["id"], if_rev="stale",
                if_route_rev=current["route_entitlement_rev"], path=self.path,
                catalogue=self.book, at=AT)

    def test_missing_owner_and_changed_source_identity_make_relationship_invalid(self):
        owner = self.save(account("commandcode:paid", "commandcode", ["commandcode-paid"],
                                  plan_id="commandcode.pro", identity="paid"))
        source = self.save(account("anthropic:source", "anthropic", ["anthropic-source"],
                                    plan_id="anthropic.claude-pro", identity="source"))
        self.arrange(source["id"], "included", owner["id"], at=SHARED_FROM)
        membership_store.delete_account(owner["id"], self.path)
        stale = self.card(source["id"])
        self.assertEqual(stale["effective_arrangement"], "invalid")
        self.assertIsNone(stale["fee"]["effective"]["amount"])
        self.assertEqual(membership_api.fee_summary_payload(
            path=self.path, catalogue=self.book, data_dir=self.directory, at=AT)["fees"], [])

        restored_owner = self.save(account("commandcode:paid", "commandcode", ["commandcode-paid"],
                                           plan_id="commandcode.pro", identity="paid"))
        self.assertEqual(restored_owner["id"], owner["id"])
        linked = self.card(source["id"])
        changed = {**membership_store.accounts_by_id(self.path)[source["id"]], "identity": "new-source"}
        membership_store.save_account(changed, self.path, if_rev=linked["rev"])
        self.assertEqual(self.card(source["id"])["effective_arrangement"], "invalid")

    def test_legacy_case_variants_can_be_explicitly_linked_and_store_is_profile_scoped(self):
        owner = self.save(account("commandcode:paid", "commandcode", ["commandcode-paid"],
                                  plan_id="commandcode.pro", identity="paid"))
        source = self.save(account("anthropic:legacy", "anthropic", ["Anthropic"],
                                    plan_id="anthropic.claude-pro", identity="legacy"))
        other_path = self.directory / "other" / "memberships.json"
        other = membership_store.save_account(
            account("commandcode:other", "commandcode", ["commandcode-other"],
                    plan_id="commandcode.pro", identity="other"), other_path)["account"]
        other_entitlements = membership_store.entitlement_store_path(other_path)
        self.assertFalse(other_entitlements.exists())

        self.arrange(source["id"], "included", owner["id"], at=SHARED_FROM)
        stored = membership_store.load_entitlement_store(self.path)
        self.assertIn("anthropic", stored["routes"])
        self.assertEqual(membership_store.load_entitlement_store(other_path), {"version": 1, "routes": {}})
        self.assertEqual(self.card(source["id"], at=AT)["effective_arrangement"], "included")
        self.assertTrue(other["rev"])

    def test_arrangement_write_rolls_back_membership_if_sidecar_write_fails(self):
        owner = self.save(account("commandcode:paid", "commandcode", ["commandcode-paid"],
                                  plan_id="commandcode.pro", identity="paid"))
        source = self.save(account("anthropic:source", "anthropic", ["anthropic-source"],
                                    plan_id="anthropic.claude-pro", identity="source"))
        before_membership = self.path.read_bytes()
        route_path = membership_store.entitlement_store_path(self.path)
        self.assertFalse(route_path.exists())
        with patch.object(membership_store, "_write_entitlement_store", side_effect=OSError("fixture write failure")):
            with self.assertRaisesRegex(OSError, "fixture write failure"):
                self.arrange(source["id"], "included", owner["id"])
        self.assertEqual(self.path.read_bytes(), before_membership)
        self.assertFalse(route_path.exists())
        self.assertEqual(membership_store.load_entitlement_store(self.path), {"version": 1, "routes": {}})

    def test_arrangement_write_rolls_back_sidecar_if_post_replace_confirmation_fails(self):
        owner = self.save(account("commandcode:paid", "commandcode", ["commandcode-paid"],
                                  plan_id="commandcode.pro", identity="paid"))
        source = self.save(account("anthropic:source", "anthropic", ["anthropic-source"],
                                    plan_id="anthropic.claude-pro", identity="source"))
        before_membership = self.path.read_bytes()
        route_path = membership_store.entitlement_store_path(self.path)
        write = membership_store._write_entitlement_store

        def write_then_fail(routes, target):
            write(routes, target)
            raise OSError("fixture post-replace confirmation failure")

        with patch.object(membership_store, "_write_entitlement_store", side_effect=write_then_fail):
            with self.assertRaisesRegex(OSError, "fixture post-replace confirmation failure"):
                self.arrange(source["id"], "included", owner["id"])
        self.assertEqual(self.path.read_bytes(), before_membership)
        self.assertFalse(route_path.exists())
        self.assertEqual(membership_store.load_entitlement_store(self.path), {"version": 1, "routes": {}})

    @unittest.skipUnless(FastAPI is not None, "FastAPI/httpx not installed")
    def test_http_arrangement_endpoint_requires_explicit_owner_and_saves_relationship(self):
        owner = self.save(account("commandcode:paid", "commandcode", ["commandcode-paid"],
                                  plan_id="commandcode.pro", identity="paid"))
        source = self.save(account("anthropic:source", "anthropic", ["anthropic-source"],
                                    plan_id="anthropic.claude-pro", identity="source"))
        current = self.card(source["id"])
        app = FastAPI()
        app.include_router(plugin_api.router, prefix="/api/plugins/spend-sense")
        body = {"arrangement": "included", "owner_account_id": owner["id"],
                "rev": current["rev"], "route_rev": current["route_entitlement_rev"]}
        with patch.object(membership_store, "store_path", return_value=self.path), \
                patch.object(membership_api, "active_catalogue", return_value=(self.book, "bundled")), \
                TestClient(app) as client:
            response = client.put(
                f"/api/plugins/spend-sense/membership/accounts/{source['id']}/arrangement", json=body)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["route_entitlement_rev"], self.card(source["id"])["route_entitlement_rev"])


class SharedRouteEconomicsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.directory = Path(self.tmp.name)
        self.path = self.directory / "memberships.json"
        self.book = membership_api.load_plans()

    def save(self, row: dict) -> dict:
        return membership_store.save_account(row, self.path)["account"]

    def arrange(self, account_id: str, arrangement: str, owner_id: str | None = None,
                *, at: str = AT) -> dict:
        payload = membership_api.accounts_payload(
            path=self.path, catalogue=self.book, data_dir=self.directory, at=at)
        current = next(row for row in payload["accounts"] if row["id"] == account_id)
        return membership_store.set_account_arrangement(
            account_id, arrangement, if_rev=current["rev"],
            if_route_rev=current["route_entitlement_rev"], owner_account_id=owner_id,
            path=self.path, catalogue=self.book, at=at)

    def test_exactly_linked_route_usage_moves_once_and_unknown_routes_stay_unattributed(self):
        owner = self.save(account("commandcode:paid", "commandcode", ["commandcode"],
                                  plan_id="commandcode.pro", identity="paid"))
        anthropic = self.save(account("anthropic:shared", "anthropic", ["route-anthropic"],
                                      plan_id="anthropic.claude-pro", identity="anthropic"))
        openai = self.save(account("openai-codex:shared", "openai-codex", ["route-openai"],
                                   plan_id="openai-codex.chatgpt-plus", identity="openai"))
        self.arrange(anthropic["id"], "included", owner["id"], at=SHARED_FROM)
        self.arrange(openai["id"], "included", owner["id"], at=SHARED_FROM)

        event_db = self.directory / "usage.db"
        with closing(sqlite3.connect(event_db)) as connection, connection:
            connection.executescript(store._SCHEMA)
            rows = [
                {"event_id": "old-anchor", "ts": membership._epoch("2026-01-01T00:00:00Z"),
                 "model": "m", "provider": "route-anthropic", "platform": "desktop",
                 "outcome": "ok", "recorded_at": 1, "input_tokens": 1},
                {"event_id": "shared-a", "ts": membership._epoch("2026-11-09T00:00:00Z"),
                 "model": "m", "provider": "route-anthropic", "platform": "desktop",
                 "outcome": "ok", "recorded_at": 2, "input_tokens": 1_000_000},
                {"event_id": "shared-b", "ts": membership._epoch("2026-11-09T00:00:00Z"),
                 "model": "m", "provider": "route-openai", "platform": "desktop",
                 "outcome": "ok", "recorded_at": 3, "input_tokens": 1_000_000},
                {"event_id": "unknown", "ts": membership._epoch("2026-11-09T00:00:00Z"),
                 "model": "m", "provider": "unmapped-route", "platform": "desktop",
                 "outcome": "ok", "recorded_at": 4, "input_tokens": 1_000_000},
            ]
            for row in rows:
                columns = list(row)
                connection.execute(
                    f"INSERT INTO calls ({','.join(columns)}) VALUES ({','.join('?' for _ in columns)})",
                    list(row.values()))

        rates = Catalogue(
            {"route-anthropic": {"m": Rate(2, 4, .5, 3)},
             "route-openai": {"m": Rate(2, 4, .5, 3)},
             "unmapped-route": {"m": Rate(2, 4, .5, 3)}},
            "fixture", "test", "", "1")
        result = economics.build_economics_report(
            now=membership._epoch(AT), days=30, trend_months=0,
            event_db_path=event_db, state_db_path=self.directory / "state.db",
            membership_path=self.path, fx_file=self.directory / "fx.json",
            catalogue=rates, plans=self.book, profiles_path=self.directory / "billing-profiles.json")
        subscription = {row["account_id"]: row for row in result["accounts"]}
        others = {row["account_id"]: row for row in result["non_subscription_accounts"]}
        self.assertEqual(subscription[owner["id"]]["usage"]["list_usd"], 4.0)
        self.assertCountEqual(subscription[owner["id"]]["included_routes"],
                              ["route-anthropic", "route-openai"])
        self.assertEqual(subscription[owner["id"]]["monthly_equivalent"],
                         {"amount": 20.0, "currency": "USD"})
        self.assertEqual(others[anthropic["id"]]["arrangement"], "included")
        self.assertEqual(others[openai["id"]]["arrangement"], "included")
        self.assertEqual(others[anthropic["id"]]["usage"]["tokens"], 0)
        self.assertEqual(others[openai["id"]]["usage"]["tokens"], 0)
        self.assertEqual(result["unattributed"]["routes"], ["unmapped-route"])
        self.assertEqual(result["headline"]["fees_monthly_by_currency"],
                         [{"currency": "USD", "amount": 20.0}])

    def test_mid_window_relationship_does_not_assign_usage_to_the_owner(self):
        owner = self.save(account("commandcode:paid", "commandcode", ["commandcode"],
                                  plan_id="commandcode.pro", identity="paid"))
        source = self.save(account("anthropic:shared", "anthropic", ["route-anthropic"],
                                    plan_id="anthropic.claude-pro", identity="anthropic"))
        self.arrange(source["id"], "included", owner["id"], at="2026-11-10T06:00:00Z")
        event_db = self.directory / "usage.db"
        with closing(sqlite3.connect(event_db)) as connection, connection:
            connection.executescript(store._SCHEMA)
            rows = [
                {"event_id": "old-anchor", "ts": membership._epoch("2026-01-01T00:00:00Z"),
                 "model": "m", "provider": "route-anthropic", "platform": "desktop",
                 "outcome": "ok", "recorded_at": 1, "input_tokens": 1},
                {"event_id": "pre-link", "ts": membership._epoch("2026-11-09T00:00:00Z"),
                 "model": "m", "provider": "route-anthropic", "platform": "desktop",
                 "outcome": "ok", "recorded_at": 2, "input_tokens": 1_000_000},
            ]
            for row in rows:
                columns = list(row)
                connection.execute(
                    f"INSERT INTO calls ({','.join(columns)}) VALUES ({','.join('?' for _ in columns)})",
                    list(row.values()))
        rates = Catalogue({"route-anthropic": {"m": Rate(2, 4, .5, 3)}}, "fixture", "test", "", "1")
        result = economics.build_economics_report(
            now=membership._epoch(AT), days=30, trend_months=0,
            event_db_path=event_db, state_db_path=self.directory / "state.db",
            membership_path=self.path, fx_file=self.directory / "fx.json",
            catalogue=rates, plans=self.book, profiles_path=self.directory / "billing-profiles.json")
        owner_row = next(row for row in result["accounts"] if row["account_id"] == owner["id"])
        source_row = next(row for row in result["non_subscription_accounts"]
                          if row["account_id"] == source["id"])
        self.assertEqual(owner_row["usage"]["tokens"], 0)
        self.assertEqual(owner_row["status"], "partial")
        self.assertIn("confirmed during this reporting window", " ".join(owner_row["notes"]))
        self.assertEqual(source_row["usage"]["tokens"], 1_000_000)


if __name__ == "__main__":
    unittest.main()
