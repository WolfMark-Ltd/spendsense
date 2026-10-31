"""Backend slice: membership store, discovery and the composition payload.

These tests exercise the wired path, not the design model: a discovered account
is persisted, an owner's plan and fee survive a re-discovery, native Hermes
readings prefill quota, and a manual mark is created, shown and cleared through
the same functions the HTTP routes call.
"""
from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

from wolfmark_ledger import discovery, membership as M
from wolfmark_ledger import membership_api as api
from wolfmark_ledger import membership_store as store

ROOT = Path(__file__).resolve().parents[1]


def native_payload(provider="openai-codex", plan="Plus", used=24.0):
    return {
        "provider": provider,
        "source": "usage_api",
        "title": "Account limits",
        "plan": plan,
        "fetched_at": "2026-10-30T04:02:05+00:00",
        "windows": [
            {"label": "Session", "used_percent": 0.0, "resets_at": "2026-10-30T05:18:25+00:00", "detail": None},
            {"label": "Weekly", "used_percent": used, "resets_at": "2026-11-04T14:16:38+00:00", "detail": None},
        ],
        "details": ["You have 1 reset banked"],
        "unavailable_reason": None,
    }


class TempStore(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.store = self.dir / "memberships.json"
        self.home = self.dir / "hermes"
        self.home.mkdir()
        (self.home / "auth.json").write_text(json.dumps({
            "credential_pool": {
                "openai-codex": [{"label": "device_code"}],
                "commandcode": [{"label": "COMMANDCODE_API_KEY"}],
                "commandcode-chat": [{"label": "COMMANDCODE_API_KEY"}],
                "commandcode-claude": [{"label": "COMMANDCODE_API_KEY"}],
                "photon": [{"label": "photon"}],
            }
        }))
        self.catalogue = api.load_plans()

    def tearDown(self):
        self.tmp.cleanup()


class StoreContract(TempStore):
    def test_editing_an_existing_membership_requires_a_revision(self):
        account = M.member_from_native(native_payload())
        saved = store.save_account(account, self.store)
        with self.assertRaises(store.MembershipConflict):
            store.save_account(account, self.store)
        with self.assertRaises(store.MembershipConflict):
            store.save_account({**account, "label": "x"}, self.store, if_rev="stale")
        ok = store.save_account({**account, "label": "x"}, self.store, if_rev=saved["account"]["rev"])
        self.assertEqual(ok["account"]["label"], "x")

    def test_fee_summary_uses_memberships_by_currency_and_period(self):
        goat = {**M.member_from_native(native_payload("commandcode")),
                "plan_id": "commandcode.goat"}
        plus = {**M.member_from_native(native_payload("openai-codex")),
                "plan_id": "openai-codex.chatgpt-plus"}
        store.save_account(goat, self.store)
        store.save_account(plus, self.store)
        summary = api.fee_summary_payload(path=self.store, catalogue=self.catalogue,
                                          at="2026-10-30T12:00:00Z")
        self.assertEqual(summary["totals_by_currency_period"], {"USD/month": 30.0})
        self.assertEqual(len(summary["fees"]), 2)
        self.assertEqual({item["basis"] for item in summary["fees"]}, {"catalogue"})
        self.assertTrue(all(isinstance(item["allowances"], list) for item in summary["fees"]))
        self.assertTrue(all(item["published"]["plan_id"] == item["plan_id"] for item in summary["fees"]))

    def test_corrupt_membership_store_fails_closed_for_fee_summary(self):
        self.store.write_text('{"version":1,"accounts":null}')
        with self.assertRaises(store.StoreUnreadable):
            api.fee_summary_payload(path=self.store, catalogue=self.catalogue)

    def test_user_plan_stays_account_scoped_and_survives_catalogue_updates(self):
        account = M.member_from_native(native_payload("openai-codex"))
        custom_id = f"custom:{account['id']}"
        custom = {
            "id": custom_id, "name": "Workday plan",
            "price": {"amount": 14, "currency": "USD", "period": "month"},
            "billing_cycle": {"anchor_day": 7, "period": "month"},
            "allowances": [{"id": "session", "label": "Five-hour window",
                            "kind": "rolling", "duration_minutes": 300,
                            "scope": "account"}],
            "model_restrictions": ["provider/model-a"],
            "effective_from": "2026-10-01", "effective_to": None,
        }
        document = {**account, "plan_id": custom_id, "custom_plan": custom}
        store.save_account(document, self.store)
        card = api.accounts_payload(path=self.store, catalogue=self.catalogue,
                                    at="2026-10-30T12:00:00Z")["accounts"][0]
        self.assertEqual(card["plan"]["source"], "user_defined")
        self.assertEqual(card["plan"]["name"], "Workday plan")
        self.assertEqual(card["fee"]["basis"], "custom")
        self.assertEqual(card["fee"]["effective"]["amount"], 14)
        self.assertEqual(card["quota"]["windows"][0]["id"], "session")
        self.assertEqual(card["plan"]["model_restrictions"], ["provider/model-a"])
        self.assertTrue(any(p["id"] == custom_id for p in card["plan_choices"]))

    def test_custom_plan_rejects_secret_or_cross_account_fields(self):
        account = M.member_from_native(native_payload("openai-codex"))
        custom_id = f"custom:{account['id']}"
        invalid = {**account, "plan_id": custom_id,
                   "custom_plan": {"id": custom_id, "name": "Bad", "api_key": "never"}}
        with self.assertRaises(ValueError) as ctx:
            store.save_account(invalid, self.store)
        self.assertIn("unknown custom plan fields", str(ctx.exception))

    def test_unknown_fields_are_rejected_rather_than_stored(self):
        account = {**M.member_from_native(native_payload()), "secrets": "nope"}
        with self.assertRaises(ValueError) as ctx:
            store.save_account(account, self.store)
        self.assertIn("unknown fields", str(ctx.exception))
        self.assertFalse(self.store.exists())

    def test_two_accounts_saved_concurrently_do_not_lose_each_other(self):
        a = M.member_from_native(native_payload("openai-codex"))
        b = M.member_from_native(native_payload("anthropic", plan="Pro"))
        results: list[Exception] = []

        def save(account):
            try:
                store.save_account(account, self.store)
            except Exception as exc:  # pragma: no cover - surfaced below
                results.append(exc)

        threads = [threading.Thread(target=save, args=(acc,)) for acc in (a, b)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(results, [])
        self.assertEqual(len(store.load_store(self.store)["accounts"]), 2)

    def test_a_corrupt_store_reports_the_error_instead_of_claiming_empty(self):
        self.store.write_text("{not json")
        data = store.load_store(self.store)
        self.assertFalse(data["loaded"])
        self.assertIn("unreadable", data["error"])


class DiscoveryContract(TempStore):
    def test_aliases_collapse_and_connectors_are_not_providers(self):
        slots = discovery.credential_slots(self.home)
        self.assertEqual(set(slots), {"openai-codex", "commandcode", "commandcode-anthropic"})
        self.assertEqual(sorted(slots["commandcode"]["route_slugs"]), ["commandcode", "commandcode-chat"])
        self.assertNotIn("photon", slots)

    def test_discovery_never_carries_a_credential_value(self):
        (self.home / "auth.json").write_text(json.dumps({
            "credential_pool": {"openai-codex": [{"label": "device_code", "account": "acct-123",
                                                  "access_token": "SUPER-SECRET-TOKEN"}]}}))
        found = discovery.discover(self.catalogue, include_native=False, home=self.home)
        blob = json.dumps(found)
        self.assertNotIn("SUPER-SECRET-TOKEN", blob)
        self.assertNotIn("acct-123", blob)
        self.assertEqual(found["accounts"][0]["family"], "openai-codex")

    def test_slot_only_accounts_are_marked_without_a_usage_source(self):
        found = discovery.discover(self.catalogue, include_native=False, home=self.home)
        block = next(a for a in found["accounts"] if a["family"] == "commandcode")
        self.assertEqual(block["usage_source"], "none")
        self.assertIsNone(block["plan_hint"])
        self.assertGreater(block["catalogue_plans"], 0)

    def test_native_snapshot_normalises_resets_at(self):
        proc = mock.Mock(returncode=0, stdout=json.dumps(native_payload()), stderr="")
        with mock.patch.object(discovery, "_hermes_binary", return_value="/usr/bin/hermes"), \
             mock.patch.object(discovery.subprocess, "run", return_value=proc):
            probe = discovery.native_snapshot("openai-codex", home=self.home, cache_seconds=0)
        self.assertEqual(probe["state"], "ok")
        self.assertEqual(probe["snapshot"]["windows"][1]["reset_at"], "2026-11-04T14:16:38+00:00")

    def test_a_provider_without_usage_is_a_state_not_an_error(self):
        proc = mock.Mock(returncode=1, stdout="", stderr="")
        with mock.patch.object(discovery, "_hermes_binary", return_value="/usr/bin/hermes"), \
             mock.patch.object(discovery.subprocess, "run", return_value=proc):
            probe = discovery.native_snapshot("commandcode", home=self.home, cache_seconds=0)
        self.assertEqual(probe["state"], "unavailable")
        self.assertIsNone(probe["snapshot"])

    def test_a_missing_cli_is_unsupported_not_unavailable(self):
        with mock.patch.object(discovery, "_hermes_binary", return_value=None):
            probe = discovery.native_snapshot("openai-codex", home=self.home, cache_seconds=0)
        self.assertEqual(probe["state"], "unsupported")


class PrefillContract(TempStore):
    def _discover_with_native(self):
        proc = mock.Mock(returncode=0, stdout=json.dumps(native_payload()), stderr="")

        def fake_run(cmd, **kwargs):
            return proc if "openai-codex" in cmd else mock.Mock(returncode=1, stdout="", stderr="")

        with mock.patch.object(discovery, "_hermes_binary", return_value="/usr/bin/hermes"), \
             mock.patch.object(discovery.subprocess, "run", side_effect=fake_run):
            return api.discover_payload(include_native=True, path=self.store, home=self.home,
                                        catalogue=self.catalogue)

    def test_codex_prefill_supplies_plan_hint_and_percentage_windows(self):
        payload = self._discover_with_native()
        codex = next(a for a in payload["accounts"] if a["family"] == "openai-codex")
        self.assertEqual(codex["plan_hint"], "Plus")
        self.assertEqual(codex["usage_source"], "usage_api")
        self.assertIsNone(codex["plan_id"], "a proposal must not auto-select a catalogue plan")
        self.assertEqual(codex["plan_proposal"]["confidence"], "alias")
        self.assertTrue(codex["plan_proposal"]["requires_confirmation"])
        labels = {w["id"]: w for w in codex["quota"]["windows"]}
        self.assertEqual(labels["weekly"]["used_percent"], 24.0)
        self.assertEqual(labels["weekly"]["basis"], ["provider_reported"])
        # No plan chosen yet, so there is no fee basis to show — never $0.00.
        self.assertEqual(codex["fee"]["basis"], "no_plan")

    def test_discovery_probes_each_provider_once_per_request(self):
        calls = []

        def counting_probe(providers, *, home=None, budget_seconds=10.0):
            providers = list(providers)
            calls.append(providers)
            return {p: {"state": "ok", "snapshot": native_payload(), "reason": ""}
                    for p in providers}

        with mock.patch.object(discovery, "probe_providers", side_effect=counting_probe):
            payload = api.discover_payload(include_native=True, path=self.store, home=self.home,
                                           catalogue=self.catalogue)
        self.assertEqual(len(calls), 1, calls)
        codex = next(a for a in payload["accounts"] if a["family"] == "openai-codex")
        self.assertTrue(codex["quota"]["windows"], "native quota rows are preserved")

    def test_saved_family_absent_from_credentials_is_not_probed_again(self):
        ghost = {**M.member_from_native(native_payload()), "family": "ghostfam", "id": "ghostfam:default"}
        store.save_account(ghost, self.store)
        calls = []

        def counting_probe(providers, *, home=None, budget_seconds=10.0):
            providers = list(providers)
            calls.append(providers)
            return {p: {"state": "ok", "snapshot": native_payload(), "reason": ""}
                    for p in providers}

        with mock.patch.object(discovery, "probe_providers", side_effect=counting_probe):
            payload = api.discover_payload(include_native=True, path=self.store, home=self.home,
                                           catalogue=self.catalogue)
        self.assertEqual(len(calls), 1, calls)
        self.assertNotIn("ghostfam", calls[0])
        self.assertIn("ghostfam", {a["family"] for a in payload["accounts"]})

    def test_rediscovery_flags_a_changed_provider_plan_without_applying_it(self):
        payload = self._discover_with_native()
        codex = next(a for a in payload["accounts"] if a["family"] == "openai-codex")
        api.save_payload(codex["id"], {**codex, "plan_id": "openai-codex.chatgpt-plus"}, path=self.store)
        discovery._CACHE.clear()  # the 60s usage cache would replay the Plus snapshot
        proc = mock.Mock(returncode=0, stdout=json.dumps(native_payload(plan="Pro")), stderr="")

        def fake_run(cmd, **kwargs):
            return proc if "openai-codex" in cmd else mock.Mock(returncode=1, stdout="", stderr="")

        with mock.patch.object(discovery, "_hermes_binary", return_value="/usr/bin/hermes"), \
             mock.patch.object(discovery.subprocess, "run", side_effect=fake_run):
            again = api.discover_payload(include_native=True, path=self.store, home=self.home,
                                         catalogue=self.catalogue)
        codex2 = next(a for a in again["accounts"] if a["family"] == "openai-codex")
        self.assertEqual(codex2["plan_id"], "openai-codex.chatgpt-plus", "never auto-apply a new plan")
        flag = codex2["plan_reconfirmation"]
        self.assertTrue(flag["required"])
        self.assertIsNone(flag["suggested_plan_id"], "tiered Pro label names no single plan")
        self.assertEqual(flag["reported_label"], "Pro")

    def test_prefill_does_not_change_the_fee_until_the_plan_is_confirmed(self):
        payload = self._discover_with_native()
        codex = next(a for a in payload["accounts"] if a["family"] == "openai-codex")
        self.assertIsNone(codex["fee"]["effective"]["amount"])

    def test_rediscovery_preserves_the_owner_choice_and_override(self):
        payload = self._discover_with_native()
        codex = next(a for a in payload["accounts"] if a["family"] == "openai-codex")
        chosen = {**codex,
                  "plan_id": "openai-codex.chatgpt-plus",
                  "fee_overrides": [{"id": "o1", "amount": 17.0, "currency": "GBP", "period": "month",
                                     "reason": "discount", "effective_from": "2026-01-01T00:00:00Z",
                                     "recorded_at": "2026-10-30T00:00:00Z"}]}
        api.save_payload(chosen["id"], chosen, path=self.store)
        again = self._discover_with_native()
        codex2 = next(a for a in again["accounts"] if a["family"] == "openai-codex")
        self.assertEqual(codex2["plan_id"], "openai-codex.chatgpt-plus")
        self.assertEqual(len(codex2["fee_overrides"]), 1)
        self.assertEqual(codex2["fee"]["basis"], "declared")
        self.assertFalse(codex2["fee"]["currency_comparable"])


class ManualQuotaContract(TempStore):
    def _persist(self):
        payload = api.discover_payload(include_native=False, path=self.store, home=self.home,
                                       catalogue=self.catalogue)
        block = next(a for a in payload["accounts"] if a["family"] == "commandcode")
        saved = api.save_payload(block["id"], {**block, "plan_id": "commandcode.goat"}, path=self.store)
        return saved["account"]

    def test_declare_and_clear_keep_the_audit_trail(self):
        account = self._persist()
        declared = api.declare_payload(account["id"], {"scope_id": "weekly", "label": "Weekly",
                                                       "note": "hit the wall"}, path=self.store)
        entry_id = declared["entry"]["id"]
        payload = api.accounts_payload(path=self.store, catalogue=self.catalogue)
        card = next(a for a in payload["accounts"] if a["family"] == "commandcode")
        weekly = next(w for w in card["quota"]["windows"] if w["id"] == "weekly")
        self.assertEqual(weekly["state"], "manual")
        self.assertEqual(weekly["used_percent"], 100.0)
        self.assertEqual(weekly["used_percent_from"], "manual")
        self.assertIn("manual", weekly["basis"])

        api.clear_payload(account["id"], entry_id, path=self.store)
        payload = api.accounts_payload(path=self.store, catalogue=self.catalogue)
        card = next(a for a in payload["accounts"] if a["family"] == "commandcode")
        self.assertFalse(card["quota"]["account_exhausted"])
        history = card["manual_exhaustions"][0]
        self.assertEqual(history["state"], "cleared")
        self.assertEqual(history["history"][0]["action"], "cleared")

    def test_a_model_scoped_mark_never_marks_the_account_exhausted(self):
        account = self._persist()
        api.declare_payload(account["id"], {"scope_kind": "model", "scope_id": "opus",
                                            "label": "Opus week"}, path=self.store)
        payload = api.accounts_payload(path=self.store, catalogue=self.catalogue)
        card = next(a for a in payload["accounts"] if a["family"] == "commandcode")
        self.assertFalse(card["quota"]["account_exhausted"])
        self.assertEqual(len(card["quota"]["model_exhausted"]), 1)

    def test_a_discovered_account_can_be_saved_again(self):
        # Discovery writes catalogue_plans and usage_source; the validator must
        # accept them or every later write on that account 422s.
        account = self._persist()
        self.assertIn("usage_source", account)
        self.assertIn("catalogue_plans", account)
        api.declare_payload(account["id"], {"scope_id": "account", "scope_kind": "account"}, path=self.store)

    def test_an_account_wide_mark_counts_as_exhausted(self):
        account = self._persist()
        api.declare_payload(account["id"],
                            {"scope_id": "account", "scope_kind": "account", "label": "Account"},
                            path=self.store)
        payload = api.accounts_payload(path=self.store, catalogue=self.catalogue)
        card = next(a for a in payload["accounts"] if a["family"] == "commandcode")
        self.assertTrue(card["quota"]["account_exhausted"])
        row = next(w for w in card["quota"]["windows"] if w["id"] == "account")
        self.assertEqual(row["scope"], "account")
        self.assertEqual(row["used_percent_from"], "manual")

    def test_an_unknown_usage_source_is_rejected(self):
        account = self._persist()
        with self.assertRaises(ValueError) as ctx:
            store.save_account({**account, "usage_source": "probably"}, self.store,
                               if_rev=account.get("rev"))
        self.assertIn("usage_source", str(ctx.exception))

    def test_declaring_on_an_unknown_account_is_a_lookup_miss(self):
        with self.assertRaises(KeyError):
            api.declare_payload("nobody:default", {"scope_id": "weekly"}, path=self.store)

    def test_a_passed_reset_instant_clears_the_mark_on_read(self):
        account = self._persist()
        api.declare_payload(account["id"], {"scope_id": "weekly", "reset_at": "2020-01-01T00:00:00Z"},
                            path=self.store)
        payload = api.accounts_payload(path=self.store, catalogue=self.catalogue)
        card = next(a for a in payload["accounts"] if a["family"] == "commandcode")
        self.assertFalse(card["quota"]["account_exhausted"])
        weekly = next(w for w in card["quota"]["windows"] if w["id"] == "weekly")
        self.assertEqual(weekly["state"], "no_data")


class PlansEndpointContract(TempStore):
    def test_totals_match_the_catalogue_and_every_source_resolves(self):
        payload = api.plans_payload()
        totals = payload["totals"]
        self.assertEqual(totals["plans"], len(payload_family_plans(payload)))
        self.assertEqual(totals["verified"] + totals["provisional"] + totals["placeholders"], totals["plans"])
        sources = {s["id"] for s in payload["sources"]}
        for family in payload["families"]:
            for plan in family["plans"]:
                self.assertIn(plan["verification"]["source_id"], sources)

    def test_served_vocabulary_matches_the_model(self):
        # The pane renders its selects from this list; a drift here is a 422 on
        # save, so it is pinned on both sides of the boundary.
        payload = api.plans_payload()
        self.assertEqual(payload["vocabulary"]["override_reasons"], list(M.OVERRIDE_REASONS))
        self.assertEqual(payload["vocabulary"]["currencies"], list(M.CURRENCIES))
        self.assertEqual(payload["vocabulary"]["periods"], list(M.PERIODS))

    def test_commandcode_plans_are_verified_with_credit_windows(self):
        payload = api.plans_payload()
        cc = next(f for f in payload["families"] if f["family"] == "commandcode")
        verified = [p for p in cc["plans"] if p["verification"]["status"] == "verified"]
        self.assertGreaterEqual(len(verified), 7)
        goat = next(p for p in cc["plans"] if p["id"] == "commandcode.goat")
        self.assertEqual(goat["price"]["amount"], 10.0)
        windows = {w["id"]: w for w in goat["entitlements"]["windows"]}
        self.assertEqual(windows["weekly"]["amount"], 50.0)
        self.assertEqual(windows["weekly"]["limit"], "credit_value_usd")
        self.assertEqual(windows["monthly-credit"]["amount"], 100.0)
        self.assertEqual(windows["monthly-credit"]["kind"], "billing_cycle")
        self.assertTrue(goat["access"]["provider_api"])

    def test_custom_plan_rejects_malformed_allowances_and_dates(self):
        account = M.member_from_native(native_payload("openai-codex"))
        custom_id = f"custom:{account['id']}"
        for plan in (
            {"id": custom_id, "name": "Bad", "allowances": None},
            {"id": custom_id, "name": "Bad", "allowances": [{"label": "x", "kind": "mystery"}]},
            {"id": custom_id, "name": "Bad", "effective_from": "not-a-date"},
            {"id": custom_id, "name": "Bad", "model_restrictions": "model-a"},
        ):
            with self.subTest(plan=plan), self.assertRaises(ValueError):
                store.save_account({**account, "plan_id": custom_id, "custom_plan": plan}, self.store)


def payload_family_plans(payload):
    return [plan for family in payload["families"] for plan in family["plans"]]


if __name__ == "__main__":
    unittest.main()
