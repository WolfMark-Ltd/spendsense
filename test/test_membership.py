"""Membership redesign semantics: fees, native prefill, manual exhaustion, catalogue review.

These are design-phase contract tests: they pin the rules the account-first
redesign must obey before any of it is wired into routes or the desktop pane.
"""
from __future__ import annotations

import copy
import json
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from wolfmark_ledger import membership as M

ROOT = Path(__file__).resolve().parents[1]
CATALOGUE_PATH = ROOT / "catalogue" / "plans.json"


def iso(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


NOW = datetime(2026, 10, 30, 12, 0, tzinfo=timezone.utc)


def catalogue():
    return M.load_plan_catalogue(CATALOGUE_PATH)


def plan_entry(plan_id="demo.plan", *, family="demo", amount=10.0, currency="USD",
               period="month", status="verified", windows=None, name="Demo plan",
               policy=None, models=None, notes=""):
    return {
        "id": plan_id,
        "provider_family": family,
        "route_slugs": [family],
        "name": name,
        "kind": "subscription",
        "price": {"amount": amount, "currency": currency, "period": period},
        "billing_cycle": {"anchor_day": None, "period": period},
        "entitlements": {
            "verification": {"status": status, "checked_at": None},
            "windows": windows or [],
            "models": models or {},
            "reset_policy": policy or {"type": "rolling_windows"},
        },
        "verification": {"status": status, "checked_at": None, "source_id": "test", "notes": notes},
    }


def mini_catalogue(version="v1", plans=None):
    return M.load_plan_catalogue({
        "catalogue_version": version,
        "plans": plans if plans is not None else [plan_entry()],
    })


def codex_snapshot(**kw):
    base = {
        "provider": "openai-codex",
        "source": "usage_api",
        "fetched_at": iso(NOW - timedelta(minutes=2)),
        "title": "Account limits",
        "plan": "Plus",
        "identity": "codex:acct_1:user_9",
        "windows": [
            {"label": "Session", "used_percent": 42.0,
             "reset_at": iso(NOW + timedelta(hours=2)), "scope": "account"},
            {"label": "Weekly", "used_percent": 78.0,
             "reset_at": iso(NOW + timedelta(days=3)), "scope": "account"},
        ],
        "details": ["You have 1 reset banked - use /usage reset to activate"],
        "unavailable_reason": None,
    }
    base.update(kw)
    return base


def anthropic_snapshot(**kw):
    base = {
        "provider": "anthropic",
        "source": "oauth_usage_api",
        "fetched_at": iso(NOW - timedelta(minutes=1)),
        "plan": None,
        "identity": None,
        "windows": [
            {"label": "Current session", "used_percent": 12.0, "reset_at": iso(NOW + timedelta(hours=3)), "scope": "account"},
            {"label": "Current week", "used_percent": 31.0, "reset_at": iso(NOW + timedelta(days=4)), "scope": "account"},
            {"label": "Opus week", "used_percent": 100.0, "reset_at": iso(NOW + timedelta(days=4)), "scope": "model"},
            {"label": "Sonnet week", "used_percent": 20.0, "reset_at": iso(NOW + timedelta(days=4)), "scope": "model"},
        ],
        "details": [],
        "unavailable_reason": None,
    }
    base.update(kw)
    return base


def membership(plan_id="openai-codex.chatgpt-plus", **kw):
    base = {
        "id": M.account_key("openai-codex", "codex:acct_1:user_9"),
        "family": "openai-codex",
        "label": "ChatGPT — work",
        "route_slugs": ["openai-codex"],
        "credential_present": True,
        "identity": "codex:acct_1:user_9",
        "identity_source": "native",
        "plan_id": plan_id,
        "fee_overrides": [],
        "manual_exhaustions": [],
        "advanced": {"model_mapping": {}, "rate_override": {}},
    }
    base.update(kw)
    return base


def override(amount=16.0, currency="GBP", reason="legacy_pricing",
             effective_from="2026-10-01T00:00:00Z", effective_to=None, revision="r1", **kw):
    base = {
        "id": revision,
        "amount": amount,
        "currency": currency,
        "period": "month",
        "billing_cycle": {"anchor_day": 12, "period": "month"},
        "effective_from": effective_from,
        "effective_to": effective_to,
        "reason": reason,
        "note": "",
        "recorded_at": "2026-10-01T09:00:00Z",
    }
    base.update(kw)
    return base


class CatalogueLoadingTests(unittest.TestCase):
    def test_seed_catalogue_loads_with_families_and_kinds(self):
        catalogue_data = catalogue()
        self.assertEqual(catalogue_data["catalogue_version"], "2026-10-30.5")
        families = {p["provider_family"] for p in catalogue_data["plans"]}
        for expected in ("openai-codex", "anthropic", "commandcode", "xai-oauth",
                         "github-copilot", "nous", "openrouter", "zai-coding-plan"):
            self.assertIn(expected, families)
        kinds = {p["kind"] for p in catalogue_data["plans"]}
        self.assertTrue({"subscription", "credits", "prepaid", "free"} <= kinds)
        self.assertGreaterEqual(len(catalogue_data["plans"]), 20)

    def test_unpriced_plan_keeps_null_amount(self):
        # xai-oauth.supergrok is deliberately unpriced: the purchase flow is behind
        # a login. If a future pass prices it, this test must fail loudly rather
        # than silently keep testing a different row.
        plan = M.plan_index(catalogue())["xai-oauth.supergrok"]
        self.assertIsNone(plan["price"]["amount"])
        self.assertEqual(plan["verification"]["status"], "unverified")

    def test_verified_free_plan_is_a_genuine_zero(self):
        plan = M.plan_index(catalogue())["openai-codex.chatgpt-free"]
        self.assertEqual(plan["price"]["amount"], 0.0)
        self.assertEqual(plan["verification"]["status"], "verified")

    def test_entitlement_windows_keep_scope(self):
        plans = M.plan_index(catalogue())
        windows = {w["id"]: w for w in plans["anthropic.claude-pro"]["entitlements"]["windows"]}
        self.assertEqual(windows["opus-week"]["scope"], "model")
        self.assertEqual(windows["current-session"]["scope"], "account")

    def test_rejects_missing_version(self):
        with self.assertRaises(M.CatalogueError):
            M.load_plan_catalogue({"plans": [plan_entry()]})

    def test_rejects_duplicate_plan_ids(self):
        with self.assertRaises(M.CatalogueError):
            M.load_plan_catalogue({"catalogue_version": "v1",
                                   "plans": [plan_entry(), plan_entry()]})

    def test_rejects_bad_currency_and_negative_price(self):
        with self.assertRaises(M.CatalogueError):
            mini_catalogue(plans=[plan_entry(currency="XYZ")])
        with self.assertRaises(M.CatalogueError):
            mini_catalogue(plans=[plan_entry(amount=-1.0)])

    def test_missing_plan_needs_family(self):
        entry = plan_entry()
        entry["provider_family"] = ""
        with self.assertRaises(M.CatalogueError):
            mini_catalogue(plans=[entry])


class FeeResolutionTests(unittest.TestCase):
    def test_catalogue_only_fee(self):
        result = M.resolve_fee(membership(), catalogue(), at=NOW)
        self.assertEqual(result["basis"], "catalogue")
        self.assertEqual(result["effective"]["amount"], 20.0)
        self.assertEqual(result["effective"]["currency"], "USD")
        self.assertIsNone(result["override"])
        self.assertEqual(result["provenance"][0]["source"], "catalogue")

    def test_override_wins_and_published_is_preserved(self):
        result = M.resolve_fee(membership(fee_overrides=[override()]), catalogue(), at=NOW)
        self.assertEqual(result["basis"], "declared")
        self.assertEqual(result["effective"]["amount"], 16.0)
        self.assertEqual(result["effective"]["currency"], "GBP")
        self.assertEqual(result["published"]["amount"], 20.0)
        self.assertEqual(result["published"]["currency"], "USD")
        self.assertEqual(result["override"]["revision_id"], "r1")
        self.assertEqual([p["source"] for p in result["provenance"]],
                         ["catalogue", "account_override"])

    def test_currency_difference_is_not_converted(self):
        result = M.resolve_fee(membership(fee_overrides=[override()]), catalogue(), at=NOW)
        self.assertFalse(result["currency_comparable"])
        self.assertTrue(any("not converted" in note for note in result["notes"]))

    def test_catalogue_refresh_cannot_replace_override(self):
        before = M.resolve_fee(membership(fee_overrides=[override()]), catalogue(), at=NOW)
        refreshed_plans = copy.deepcopy(catalogue()["plans"])
        for plan in refreshed_plans:
            if plan["id"] == "openai-codex.chatgpt-plus":
                plan["price"] = {"amount": 25.0, "currency": "USD", "period": "month"}
        refreshed = M.load_plan_catalogue({"catalogue_version": "2026-11-30.1",
                                           "plans": refreshed_plans})
        after = M.resolve_fee(membership(fee_overrides=[override()]), refreshed, at=NOW)
        self.assertEqual(after["published"]["amount"], 25.0)
        self.assertEqual(after["effective"]["amount"], 16.0)
        self.assertEqual(after["basis"], "declared")

    def test_override_with_future_start_is_not_applied_yet(self):
        future = override(effective_from="2026-12-01T00:00:00Z")
        result = M.resolve_fee(membership(fee_overrides=[future]), catalogue(), at=NOW)
        self.assertEqual(result["basis"], "catalogue")
        self.assertIsNone(result["override"])

    def test_latest_effective_revision_wins_regardless_of_list_order(self):
        older = override(amount=18.0, revision="r1", effective_from="2026-08-01T00:00:00Z")
        newer = override(amount=15.0, revision="r2", effective_from="2026-10-01T00:00:00Z")
        for revisions in ([older, newer], [newer, older]):
            result = M.resolve_fee(membership(fee_overrides=revisions), catalogue(), at=NOW)
            self.assertEqual(result["effective"]["amount"], 15.0)
            self.assertEqual(result["override"]["revision_count"], 2)

    def test_history_resolves_to_the_revision_in_force_then(self):
        older = override(amount=18.0, revision="r1", effective_from="2026-08-01T00:00:00Z",
                         effective_to="2026-10-01T00:00:00Z")
        newer = override(amount=15.0, revision="r2", effective_from="2026-10-01T00:00:00Z")
        pair = [older, newer]
        september = M.resolve_fee(membership(fee_overrides=pair), catalogue(),
                                  at=datetime(2026, 9, 15, tzinfo=timezone.utc))
        october = M.resolve_fee(membership(fee_overrides=pair), catalogue(), at=NOW)
        self.assertEqual(september["effective"]["amount"], 18.0)
        self.assertEqual(october["effective"]["amount"], 15.0)

    def test_override_survives_plan_removed_from_catalogue(self):
        result = M.resolve_fee(membership(plan_id="vendor.retired",
                                          fee_overrides=[override()]), catalogue(), at=NOW)
        self.assertIsNone(result["published"])
        self.assertEqual(result["effective"]["amount"], 16.0)
        self.assertTrue(any("not in this catalogue" in note for note in result["notes"]))

    def test_no_plan_and_unpriced_plan_are_distinct_states(self):
        no_plan = M.resolve_fee(membership(plan_id=None), catalogue(), at=NOW)
        unpriced = M.resolve_fee(membership(plan_id="xai-oauth.supergrok"),
                                 catalogue(), at=NOW)
        self.assertEqual(no_plan["basis"], "no_plan")
        self.assertEqual(unpriced["basis"], "unpriced")
        self.assertIsNone(no_plan["effective"]["amount"])
        self.assertIsNone(unpriced["effective"]["amount"])

    def test_override_wins_even_when_plan_is_unpriced(self):
        result = M.resolve_fee(membership(plan_id="tencent-coding-plan.standard",
                                          fee_overrides=[override(amount=10.0, currency="USD")]),
                               catalogue(), at=NOW)
        self.assertEqual(result["basis"], "declared")
        self.assertEqual(result["effective"]["amount"], 10.0)
        self.assertIsNone(result["published"]["amount"])

    def test_billing_cycle_override_reaches_effective_rules(self):
        rules = M.active_financial_rules(membership(fee_overrides=[override()]),
                                         catalogue(), at=NOW)
        self.assertEqual(rules["billing_cycle"]["anchor_day"], 12)
        bounds = M.cycle_bounds(membership(fee_overrides=[override()]),
                                M.plan_index(catalogue())["openai-codex.chatgpt-plus"], at=NOW)
        self.assertEqual(bounds["start"], "2026-10-12T00:00:00Z")
        self.assertEqual(bounds["end"], "2026-11-12T00:00:00Z")

    def test_active_rules_are_stable_across_refresh_with_override(self):
        original = catalogue()
        refreshed_plans = copy.deepcopy(original["plans"])
        for plan in refreshed_plans:
            if plan["id"] == "openai-codex.chatgpt-plus":
                plan["price"] = {"amount": 25.0, "currency": "USD", "period": "month"}
        refreshed = M.load_plan_catalogue({"catalogue_version": "2026-11-30.1",
                                           "plans": refreshed_plans})
        with_override = membership(fee_overrides=[override()])
        self.assertEqual(M.active_financial_rules(with_override, original, at=NOW),
                         M.active_financial_rules(with_override, refreshed, at=NOW))
        without_override = membership()
        self.assertNotEqual(M.active_financial_rules(without_override, original, at=NOW),
                            M.active_financial_rules(without_override, refreshed, at=NOW))

    def test_validation_rejects_bad_override_fields(self):
        bad = membership(fee_overrides=[override(currency="XYZ", amount=10.0)])
        self.assertTrue(any("currency" in e for e in M.validation_errors(bad)))
        bad_day = membership(fee_overrides=[override(billing_cycle={"anchor_day": 40})])
        self.assertTrue(any("between 1 and 31" in e for e in M.validation_errors(bad_day)))
        unknown = membership(nonsense=True)
        self.assertTrue(any("unknown fields" in e for e in M.validation_errors(unknown)))
        good = membership(fee_overrides=[override()])
        self.assertEqual(M.validation_errors(good), [])

    def test_override_amount_requires_a_currency(self):
        bad = membership(fee_overrides=[override(currency=None)])
        self.assertTrue(any("needs a currency" in e for e in M.validation_errors(bad)))


class NativePrefillTests(unittest.TestCase):
    def test_codex_snapshot_is_live_with_account_scoped_windows(self):
        view = M.native_usage(codex_snapshot(), membership(), at=NOW)
        self.assertEqual(view["state"], "live")
        self.assertEqual(view["identity"], "codex:acct_1:user_9")
        self.assertEqual([w["id"] for w in view["windows"]], ["session", "weekly"])
        self.assertTrue(all(w["scope"] == "account" for w in view["windows"]))
        self.assertTrue(all(w["basis"] == "provider_reported" for w in view["windows"]))
        self.assertEqual(view["windows"][0]["used_percent"], 42.0)
        self.assertEqual(view["plan_hint"], "Plus")

    def test_stale_snapshot_is_labelled_not_confident(self):
        stale = codex_snapshot(fetched_at=iso(NOW - timedelta(minutes=40)))
        view = M.native_usage(stale, membership(), at=NOW)
        self.assertEqual(view["state"], "stale")
        self.assertEqual(view["windows"][0]["used_percent"], 42.0)
        self.assertTrue(any("not refreshed" in note for note in view["notes"]))

    def test_missing_fetch_time_is_stale(self):
        view = M.native_usage(codex_snapshot(fetched_at=None), membership(), at=NOW)
        self.assertEqual(view["state"], "stale")

    def test_unavailable_reason_becomes_first_class_state(self):
        view = M.native_usage(codex_snapshot(windows=[], unavailable_reason="no credential configured"),
                              membership(), at=NOW)
        self.assertEqual(view["state"], "unavailable")
        self.assertEqual(view["unavailable_reason"], "no credential configured")
        self.assertEqual(view["windows"], [])

    def test_identity_mismatch_never_merges_accounts(self):
        other = membership(identity="codex:acct_2:user_9")
        view = M.native_usage(codex_snapshot(), other, at=NOW)
        self.assertEqual(view["state"], "identity_mismatch")
        self.assertEqual(view["windows"], [])
        self.assertTrue(view["notes"])

    def test_model_scoped_exhaustion_is_not_account_exhaustion(self):
        view = M.native_usage(anthropic_snapshot(), membership(family="anthropic", plan_id="anthropic.claude-pro"),
                              at=NOW)
        self.assertFalse(M.account_exhausted(view))
        self.assertEqual(M.model_exhausted(view), ["Opus week"])
        self.assertEqual([w["scope"] for w in view["windows"]],
                         ["account", "account", "model", "model"])

    def test_account_window_exhaustion_is_reported(self):
        view = M.native_usage(anthropic_snapshot(windows=[
            {"label": "Current week", "used_percent": 100.0, "scope": "account"},
            {"label": "Opus week", "used_percent": 100.0, "scope": "model"},
        ]), membership(family="anthropic", plan_id="anthropic.claude-pro"), at=NOW)
        self.assertTrue(M.account_exhausted(view))

    def test_missing_scope_defaults_to_account_and_is_flagged(self):
        snapshot = codex_snapshot(windows=[{"label": "Session", "used_percent": 5.0}])
        view = M.native_usage(snapshot, membership(), at=NOW)
        self.assertEqual(view["windows"][0]["scope"], "account")
        self.assertTrue(view["windows"][0]["scope_assumed"])

    def test_absent_snapshot_is_a_state_not_an_error(self):
        view = M.native_usage(None, membership(), at=NOW)
        self.assertEqual(view["state"], "absent")

    def test_plan_proposal_requires_confirmation(self):
        proposal = M.propose_plan(codex_snapshot(), catalogue(), "openai-codex")
        self.assertEqual(proposal["plan_id"], "openai-codex.chatgpt-plus")
        self.assertTrue(proposal["requires_confirmation"])

    def test_saved_plan_that_provider_no_longer_reports_needs_reconfirmation(self):
        flag = M.plan_reconfirmation(membership(), catalogue(), codex_snapshot(plan="Pro"))
        self.assertTrue(flag["required"])
        self.assertEqual(flag["saved_plan_id"], "openai-codex.chatgpt-plus")
        # "Pro" names two tiered plans, so no single plan is suggested.
        self.assertIsNone(flag["suggested_plan_id"])
        self.assertEqual(flag["reported_label"], "Pro")
        go = M.plan_reconfirmation(membership(), catalogue(), codex_snapshot(plan="Go"))
        self.assertEqual(go["suggested_plan_id"], "openai-codex.chatgpt-go")

    def test_matching_unknown_and_custom_plans_are_not_flagged(self):
        self.assertIsNone(M.plan_reconfirmation(membership(), catalogue(), codex_snapshot(plan="Plus")))
        self.assertIsNone(M.plan_reconfirmation(membership(), catalogue(), codex_snapshot(plan="Enterprise Ultra")))
        stored_hint = membership(plan_hint="Pro")
        self.assertTrue(M.plan_reconfirmation(stored_hint, catalogue())["required"])
        account = membership()
        custom = {"id": f"custom:{account['id']}", "name": "Mine",
                  "price": {"amount": 9, "currency": "USD", "period": "month"}}
        account = {**account, "plan_id": custom["id"], "custom_plan": custom}
        self.assertIsNone(M.plan_reconfirmation(account, catalogue(), codex_snapshot(plan="Pro")))

    def test_unknown_plan_label_proposes_nothing(self):
        proposal = M.propose_plan(codex_snapshot(plan="Enterprise Ultra"), catalogue(), "openai-codex")
        self.assertEqual(proposal["confidence"], "none")
        self.assertIsNone(proposal["plan_id"])

    def test_account_keys_never_collide_across_identities(self):
        a = M.member_from_native(codex_snapshot())
        b = M.member_from_native(codex_snapshot(identity="codex:acct_2:user_9"))
        c = M.member_from_native(codex_snapshot())
        self.assertNotEqual(a["id"], b["id"])
        self.assertEqual(a["id"], c["id"])
        self.assertTrue(a["id"].startswith("openai-codex:"))

    def test_snapshots_without_identity_use_the_default_slot(self):
        member = M.member_from_native(anthropic_snapshot())
        self.assertEqual(member["id"], "anthropic:default")
        self.assertEqual(member["identity_source"], "provider_default_slot")


class ManualExhaustionTests(unittest.TestCase):
    def entry(self, **kw):
        args = {"scope_id": "session", "label": "5-hour session", "declared_at": NOW}
        args.update(kw)
        return M.declare_exhausted(membership(), **args)

    def test_declaring_is_manual_basis_and_never_provider_confirmed(self):
        entry = self.entry(note="Hit the limit in the CLI")
        self.assertEqual(entry["basis"], "manual")
        self.assertEqual(entry["state"], "active")
        self.assertEqual(entry["scope"]["id"], "session")
        self.assertEqual(entry["note"], "Hit the limit in the CLI")

    def test_known_future_reset_stays_active(self):
        entry = self.entry(reset_at=NOW + timedelta(hours=2))
        state = M.evaluate_exhaustion(entry, at=NOW + timedelta(minutes=30))
        self.assertEqual(state["status"], "active")
        self.assertFalse(state["auto_clear"])
        self.assertGreater(state["expires_in_seconds"], 0)

    def test_passed_reset_auto_clears(self):
        entry = self.entry(reset_at=NOW + timedelta(hours=2))
        state = M.evaluate_exhaustion(entry, at=NOW + timedelta(hours=3))
        self.assertEqual(state["status"], "expired")
        self.assertTrue(state["auto_clear"])
        self.assertEqual(state["cleared_reason"], "auto_reset")

    def test_unknown_reset_requests_reconfirmation_instead_of_clearing(self):
        entry = self.entry()
        early = M.evaluate_exhaustion(entry, at=NOW + timedelta(hours=1))
        late = M.evaluate_exhaustion(entry, at=NOW + timedelta(hours=25))
        self.assertEqual(early["status"], "active")
        self.assertFalse(early["auto_clear"])
        self.assertEqual(late["status"], "reconfirm_due")
        self.assertFalse(late["auto_clear"])

    def test_window_duration_sets_a_shorter_reconfirmation(self):
        plan = M.plan_index(catalogue())["openai-codex.chatgpt-plus"]
        entry = self.entry()
        state = M.evaluate_exhaustion(entry, plan=plan, at=NOW + timedelta(hours=7))
        self.assertEqual(state["status"], "reconfirm_due")
        self.assertEqual(M._reconfirm_hours(entry["scope"], plan), 6.0)

    def test_fresh_provider_disagreement_raises_a_warning(self):
        entry = self.entry(reset_at=NOW + timedelta(hours=2))
        live = M.native_usage(codex_snapshot(), membership(), at=NOW)
        state = M.evaluate_exhaustion(entry, provider_windows=live["windows"],
                                      provider_state="live", at=NOW)
        self.assertEqual(state["status"], "contradicted")
        self.assertFalse(state["auto_clear"])
        self.assertEqual(state["provider_conflict"]["provider_used_percent"], 42.0)

    def test_provider_agreement_keeps_the_mark(self):
        entry = self.entry()
        saturated = [{"id": "session", "label": "Session", "used_percent": 99.0, "scope": "account"}]
        state = M.evaluate_exhaustion(entry, provider_windows=saturated,
                                      provider_state="live", at=NOW)
        self.assertEqual(state["status"], "active")
        self.assertIsNone(state["provider_conflict"])

    def test_stale_provider_data_does_not_contradict(self):
        entry = self.entry()
        live = M.native_usage(codex_snapshot(), membership(), at=NOW)
        state = M.evaluate_exhaustion(entry, provider_windows=live["windows"],
                                      provider_state="stale", at=NOW)
        self.assertEqual(state["status"], "active")

    def test_passed_reset_beats_a_contradiction(self):
        entry = self.entry(reset_at=NOW + timedelta(hours=1))
        live = M.native_usage(codex_snapshot(), membership(), at=NOW)
        state = M.evaluate_exhaustion(entry, provider_windows=live["windows"],
                                      provider_state="live", at=NOW + timedelta(hours=2))
        self.assertEqual(state["status"], "expired")

    def test_clearing_keeps_an_audit_trail(self):
        entry = self.entry(reset_at=NOW + timedelta(hours=2))
        cleared = M.clear_exhaustion(entry, at=NOW + timedelta(minutes=5))
        self.assertEqual(cleared["state"], "cleared")
        self.assertEqual(cleared["cleared_reason"], "user")
        self.assertEqual(cleared["history"][-1]["action"], "cleared")
        self.assertEqual(M.evaluate_exhaustion(cleared, at=NOW)["status"], "cleared")

    def test_reconfirmation_extends_the_claim_and_can_add_a_reset(self):
        entry = self.entry()
        updated = M.reconfirm_exhaustion(entry, at=NOW + timedelta(hours=26),
                                        reset_at=NOW + timedelta(hours=30))
        self.assertEqual(updated["history"][-1]["action"], "reconfirmed")
        self.assertEqual(updated["reset_at"], iso(NOW + timedelta(hours=30)))
        state = M.evaluate_exhaustion(updated, at=NOW + timedelta(hours=26))
        self.assertEqual(state["status"], "active")

    def test_manual_mark_cannot_be_model_scoped_into_account_exhaustion(self):
        member = membership(family="anthropic", plan_id="anthropic.claude-pro",
                            identity=None, id="anthropic:default")
        member["manual_exhaustions"] = [M.declare_exhausted(
            member, scope_id="opus-week", scope_kind="model", label="Opus week",
            declared_at=NOW, reset_at=NOW + timedelta(days=1))]
        view = M.quota_view(member, None, M.plan_index(catalogue())["anthropic.claude-pro"], at=NOW)
        row = next(r for r in view["windows"] if r["id"] == "opus-week")
        self.assertEqual(row["scope"], "model")
        self.assertEqual(row["state"], "manual")
        self.assertFalse(view["account_exhausted"])


class QuotaViewTests(unittest.TestCase):
    def test_provider_reading_and_manual_mark_coexist(self):
        member = membership()
        member["manual_exhaustions"] = [M.declare_exhausted(member, scope_id="session",
                                                            declared_at=NOW,
                                                            reset_at=NOW + timedelta(hours=2))]
        view = M.quota_view(member, M.native_usage(codex_snapshot(), member, at=NOW),
                            M.plan_index(catalogue())["openai-codex.chatgpt-plus"], at=NOW)
        session = next(r for r in view["windows"] if r["id"] == "session")
        self.assertEqual(session["basis"], ["provider_reported", "manual"])
        self.assertEqual(session["used_percent"], 42.0)
        self.assertTrue(session["conflict"])
        self.assertEqual(view["conflicts"], ["session"])

    def test_windows_without_any_report_are_no_data(self):
        member = membership(family="commandcode", plan_id="commandcode.goat",
                            identity=None, id="commandcode:default")
        view = M.quota_view(member, M.native_usage(None, member, at=NOW),
                            M.plan_index(catalogue())["commandcode.goat"], at=NOW)
        states = {r["id"]: r["state"] for r in view["windows"]}
        self.assertEqual(states["five-hour"], "no_data")
        self.assertIsNone(next(r for r in view["windows"] if r["id"] == "five-hour")["used_percent"])
        self.assertFalse(view["has_provider_reporting"])

    def test_manual_only_window_is_labelled_manual(self):
        member = membership(family="commandcode", plan_id="commandcode.goat", id="commandcode:default")
        member["manual_exhaustions"] = [M.declare_exhausted(member, scope_id="five-hour",
                                                            label="5-hour credits", declared_at=NOW,
                                                            reset_at=NOW + timedelta(hours=2))]
        view = M.quota_view(member, None, M.plan_index(catalogue())["commandcode.goat"], at=NOW)
        row = next(r for r in view["windows"] if r["id"] == "five-hour")
        self.assertEqual(row["state"], "manual")
        self.assertEqual(row["basis"], ["manual"])
        self.assertEqual(row["used_percent_from"], "manual")


class EvidenceTests(unittest.TestCase):
    def test_four_evidence_types_stay_separate(self):
        member = membership(fee_overrides=[override()])
        native = M.native_usage(codex_snapshot(), member, at=NOW)
        bundle = M.evidence_bundle(
            native=native,
            observed={"window": {"start": "2026-10-23", "end": "2026-10-30"},
                      "tokens": {"input": 1000, "output": 200}, "calls": 7},
            manual_entries=[M.declare_exhausted(member, scope_id="weekly", declared_at=NOW)],
            api_equivalent={"usd": 4.25, "coverage": {"priced_tokens": 1200, "total_tokens": 1200}},
            fee=M.resolve_fee(member, catalogue(), at=NOW),
            at=NOW,
        )
        self.assertFalse(bundle["summable"])
        self.assertEqual(bundle["provider_account_usage"]["kind"], "provider_reported")
        self.assertEqual(bundle["provider_account_usage"]["basis"], "confirmed")
        self.assertEqual(bundle["observed_inference"]["kind"], "observed")
        self.assertEqual(bundle["manual_exhaustion"]["kind"], "manual")
        self.assertEqual(bundle["api_equivalent_value"]["kind"], "estimated")
        self.assertEqual(bundle["api_equivalent_value"]["usd"], 4.25)
        for window in bundle["provider_account_usage"]["windows"]:
            self.assertNotIn("usd", window)
            self.assertEqual(bundle["provider_account_usage"]["unit"], "percent_of_limit")
        self.assertEqual(bundle["membership_fee"]["amount"], 16.0)
        self.assertEqual(bundle["membership_fee"]["currency"], "GBP")

    def test_stale_provider_usage_is_not_labelled_confirmed(self):
        stale = M.native_usage(codex_snapshot(fetched_at=iso(NOW - timedelta(hours=1))),
                               membership(), at=NOW)
        bundle = M.evidence_bundle(native=stale, observed=None, at=NOW)
        self.assertEqual(bundle["provider_account_usage"]["basis"], "stale")


class CatalogueMaintenanceTests(unittest.TestCase):
    def base(self, **kw):
        return mini_catalogue("v1", [plan_entry(**kw)])

    def test_identical_versions_produce_no_changes(self):
        report = M.diff_catalogues(self.base(), mini_catalogue("v1"))
        self.assertEqual(report["changes"], [])
        self.assertFalse(report["applied"])
        self.assertEqual(report["blocking"], [])

    def test_verified_price_change_is_material_and_blocking(self):
        report = M.diff_catalogues(self.base(), mini_catalogue("v2", [plan_entry(amount=12.0)]))
        change = next(c for c in report["changes"] if c["field"] == "price.amount")
        self.assertEqual(change["materiality"], "material")
        self.assertEqual(change["action"], "review")
        self.assertEqual(report["blocking"], ["demo.plan:price.amount"])
        self.assertFalse(report["applied"])

    def test_change_on_unverified_plan_is_ambiguous(self):
        old = self.base(status="unverified")
        new = mini_catalogue("v2", [plan_entry(amount=12.0, status="unverified")])
        report = M.diff_catalogues(old, new)
        self.assertEqual(report["counts"]["ambiguous"], 1)
        self.assertTrue(report["requires_owner"])

    def test_entitlement_and_policy_changes_are_material(self):
        old = self.base(windows=[{"id": "session", "label": "Session", "duration_minutes": 300}])
        new = mini_catalogue("v2", [plan_entry(windows=[
            {"id": "session", "label": "Session", "duration_minutes": 600}],
            policy={"type": "calendar_period"})])
        report = M.diff_catalogues(old, new)
        kinds = {c["kind"] for c in report["changes"]}
        self.assertIn("window_changed", kinds)
        self.assertIn("reset_policy", kinds)
        self.assertEqual(report["counts"]["material"], 2)

    def test_cosmetic_changes_are_auto_noted_not_blocking(self):
        new = mini_catalogue("v2", [plan_entry(name="Demo plan (renamed)")])
        report = M.diff_catalogues(self.base(), new)
        self.assertEqual(report["blocking"], [])
        self.assertEqual(report["auto_note"], ["demo.plan:name"])

    def test_plan_added_and_removed_are_reviewed(self):
        removed = M.diff_catalogues(self.base(), mini_catalogue("v2", [plan_entry(plan_id="demo.other")]))
        self.assertIn("plan_removed", {c["kind"] for c in removed["changes"]})
        added = M.diff_catalogues(self.base(), mini_catalogue("v2", [
            plan_entry(), plan_entry(plan_id="demo.new", amount=5.0)]))
        added_change = next(c for c in added["changes"] if c["kind"] == "plan_added")
        self.assertEqual(added_change["materiality"], "review")

    def test_promotion_needs_every_blocking_change_decided(self):
        report = M.diff_catalogues(self.base(), mini_catalogue("v2", [plan_entry(amount=12.0)]))
        pending = M.promotion_plan(report, {})
        self.assertFalse(pending["promotable"])
        self.assertEqual(pending["pending"], ["demo.plan:price.amount"])
        accepted = M.promotion_plan(report, {"demo.plan:price.amount": "accept"})
        self.assertTrue(accepted["promotable"])
        rejected = M.promotion_plan(report, {"demo.plan:price.amount": "reject"})
        self.assertTrue(rejected["promotable"])
        self.assertEqual(rejected["rejected"], ["demo.plan:price.amount"])

    def test_diff_never_mutates_its_inputs(self):
        old, new = self.base(), mini_catalogue("v2", [plan_entry(amount=12.0)])
        old_copy, new_copy = copy.deepcopy(old), copy.deepcopy(new)
        M.diff_catalogues(old, new)
        self.assertEqual(old, old_copy)
        self.assertEqual(new, new_copy)

    def test_diff_report_does_not_change_active_rules(self):
        member = membership(plan_id="demo.plan")
        old, new = self.base(), mini_catalogue("v2", [plan_entry(amount=12.0)])
        before = M.active_financial_rules(member, old, at=NOW)
        M.diff_catalogues(old, new)
        self.assertEqual(before, M.active_financial_rules(member, old, at=NOW))
        self.assertNotEqual(before["fee"]["amount"],
                            M.active_financial_rules(member, new, at=NOW)["fee"]["amount"])


class MigrationTests(unittest.TestCase):
    def test_billing_profile_fee_becomes_an_override_not_a_catalogue_value(self):
        member = M.member_from_billing_profile({
            "id": "cc", "provider": "commandcode", "kind": "subscription_credits",
            "monthly_fee_usd": 15, "billing_cycle": {"day": 20},
            "effective_from": "2026-10-01", "label": "CommandCode GOAT",
            "rate_override": {"input": 0.9, "output": 4.5},
        })
        self.assertIsNone(member["plan_id"])
        self.assertEqual(len(member["fee_overrides"]), 1)
        fee = member["fee_overrides"][0]
        self.assertEqual(fee["amount"], 15.0)
        self.assertEqual(fee["reason"], "legacy_pricing")
        self.assertEqual(fee["billing_cycle"]["anchor_day"], 20)
        self.assertEqual(member["advanced"]["rate_override"], {"input": 0.9, "output": 4.5})
        resolved = M.resolve_fee(member, catalogue(), at=NOW)
        self.assertEqual(resolved["basis"], "declared")
        self.assertIsNone(resolved["published"])

    def test_migration_preserves_no_plan_rather_than_guessing_one(self):
        member = M.member_from_billing_profile({"id": "x", "provider": "commandcode",
                                                "kind": "subscription_included",
                                                "monthly_fee_usd": 10})
        self.assertIsNone(member["plan_id"])
        self.assertEqual(member["fee_overrides"][0]["amount"], 10.0)


if __name__ == "__main__":
    unittest.main()
