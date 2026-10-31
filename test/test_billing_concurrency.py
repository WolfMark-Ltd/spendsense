import json, os, sys, tempfile, threading, unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from wolfmark_ledger import billing


class ConcurrentProfileSaves(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.path = Path(self.dir) / "billing-profiles.json"
        billing.save_profile({"id": "seed", "kind": "api", "provider": "commandcode"}, self.path)

    def test_two_profiles_saved_concurrently_both_survive(self):
        errors = []
        def write(pid):
            try:
                billing.save_profile({"id": pid, "kind": "api", "provider": "commandcode", "label": pid}, self.path)
            except Exception as exc:  # noqa: BLE001
                errors.append(exc)
        threads = [threading.Thread(target=write, args=(f"p{i}",)) for i in range(8)]
        for t in threads: t.start()
        for t in threads: t.join()
        self.assertEqual(errors, [])
        ids = {p["id"] for p in billing.load_profiles(self.path)["profiles"]}
        self.assertEqual(ids, {"seed"} | {f"p{i}" for i in range(8)})

    def test_lock_file_does_not_leak_into_profiles(self):
        billing.save_profile({"id": "x", "kind": "api", "provider": "commandcode"}, self.path)
        self.assertTrue(self.path.exists())
        self.assertNotIn("lock", json.dumps(billing.load_profiles(self.path)))


class RouteSelection(unittest.TestCase):
    def profiles(self, *profiles):
        return {"profiles": list(profiles)}

    def test_goat_and_payg_on_one_provider_resolve_by_model(self):
        goat = {"id": "goat", "provider": "commandcode", "kind": "subscription_credits",
                "model": "deepseek/deepseek-v4.1-flash", "effective_from": "2026-10-01"}
        payg = {"id": "payg", "provider": "commandcode", "kind": "api", "effective_from": "2026-09-01"}
        chosen, source = billing.select(self.profiles(goat, payg), "commandcode",
                                         "deepseek/deepseek-v4.1-flash", None)
        self.assertEqual((chosen["id"], source), ("goat", "route"))
        chosen, _ = billing.select(self.profiles(goat, payg), "commandcode", "glm-5.3-flash", None)
        self.assertEqual(chosen["id"], "payg")

    def test_effective_dates_decide_between_two_provider_plans(self):
        old = {"id": "old", "provider": "commandcode", "kind": "api", "effective_from": "2026-01-01"}
        new = {"id": "new", "provider": "commandcode", "kind": "api", "effective_from": "2026-10-15"}
        chosen, _ = billing.select(self.profiles(old, new), "commandcode", "m", None)
        self.assertEqual(chosen["id"], "new", "the latest effective plan wins deterministically")

    def test_custom_override_is_editable_and_revisioned(self):
        path = Path(tempfile.mkdtemp()) / "p.json"
        created = billing.save_profile({"id": "custom", "kind": "custom",
                                        "rate_override": {"input": 1.0, "output": 2.0,
                                                          "cache_read": 0.1,
                                                          "effective_from": "2026-10-01"}}, path)
        self.assertEqual(created["profiles"][0]["rate_override"]["input"], 1.0)


class CorrectionRegressions(unittest.TestCase):
    def test_foreign_model_never_borrows_a_scoped_plan(self):
        goat = {"id": "goat", "provider": "commandcode", "kind": "subscription_credits",
                "model": "deepseek/deepseek-v4.1-flash"}
        profile, source = billing.select({"profiles": [goat]}, "commandcode", "glm-5.3-flash", None)
        self.assertIsNone(profile)
        self.assertEqual(source, "unknown")

    def test_defaults_still_apply_when_no_route_matches(self):
        data = {"profiles": [{"id": "goat", "provider": "commandcode", "kind": "subscription_credits",
                              "model": "deepseek/deepseek-v4.1-flash"}],
                "defaults": {"kind": "api", "id": "fallback"}}
        profile, source = billing.select(data, "commandcode", "glm-5.3-flash", None)
        self.assertEqual((profile["id"], source), ("fallback", "defaults"))

    def test_absence_is_none_and_true_zero_is_confirmed(self):
        profiles = {"profiles": [{"id": "goat", "provider": "commandcode", "kind": "subscription_credits"}]}
        absent = billing.classify([{"provider": "commandcode", "model": "m", "list_usd": 1.0,
                                    "_tokens": 5, "_input": 0, "_output": 0, "_cache_read": 0,
                                    "_cache_write": 0, "last_seen": None}], profiles)
        self.assertIsNone(absent["evidence"]["provider_reported"]["usd"])
        self.assertEqual(absent["evidence"]["provider_reported"]["basis"], "none")
        zero = billing.classify([{"provider": "commandcode", "model": "m", "list_usd": 1.0,
                                  "_provider_cost_usd": 0.0, "_tokens": 5, "_input": 0, "_output": 0,
                                  "_cache_read": 0, "_cache_write": 0, "last_seen": None}], profiles)
        self.assertEqual(zero["evidence"]["provider_reported"]["usd"], 0.0)
        self.assertEqual(zero["evidence"]["provider_reported"]["basis"], "confirmed")
        self.assertEqual(zero["evidence"]["provider_reported"]["calls"], 1)

    def test_rows_outside_the_cycle_are_excluded(self):
        import datetime as dt
        profiles = {"profiles": [{"id": "wallet", "provider": "commandcode", "kind": "prepaid",
                                  "billing_cycle": {"day": 15}}]}
        inside = dt.datetime(2026, 10, 20, tzinfo=dt.timezone.utc).timestamp()
        before = dt.datetime(2026, 9, 1, tzinfo=dt.timezone.utc).timestamp()
        rows = [{"provider": "commandcode", "model": "m", "list_usd": 1.0, "_tokens": 5, "call_id": "a",
                 "_input": 0, "_output": 0, "_cache_read": 0, "_cache_write": 0, "last_seen": inside},
                {"provider": "commandcode", "model": "m", "list_usd": 1.0, "_tokens": 5, "call_id": "b",
                 "_input": 0, "_output": 0, "_cache_read": 0, "_cache_write": 0, "last_seen": before}]
        report = billing.classify(rows, profiles)
        self.assertEqual(report["excluded_out_of_cycle"], 1)
        self.assertAlmostEqual(report["metered_usd"], 1.0)


class CycleBoundaryRegressions(unittest.TestCase):
    def bounds(self, day, when):
        import datetime as dt
        at = dt.datetime.fromisoformat(when).replace(tzinfo=dt.timezone.utc).timestamp()
        return billing.cycle_bounds({"billing_cycle": {"day": day}}, at)

    def test_ten_november_is_inside_the_15_oct_to_15_nov_cycle(self):
        b = self.bounds(15, "2026-11-10T12:00:00")
        self.assertEqual(b["start"], "2026-10-15T00:00:00+00:00")
        self.assertEqual(b["end"], "2026-11-15T00:00:00+00:00")

    def test_renewal_day_belongs_to_the_new_cycle(self):
        b = self.bounds(15, "2026-11-15T00:00:01")
        self.assertEqual(b["start"], "2026-11-15T00:00:00+00:00")
        self.assertEqual(b["end"], "2026-12-15T00:00:00+00:00")

    def test_month_end_anchor_clamps_into_february(self):
        b = self.bounds(31, "2027-02-10T00:00:00")
        self.assertEqual(b["start"], "2027-01-31T00:00:00+00:00")
        self.assertEqual(b["end"], "2027-02-28T00:00:00+00:00")

    def test_leap_february_anchor(self):
        b = self.bounds(31, "2028-02-10T00:00:00")
        self.assertEqual(b["end"], "2028-02-29T00:00:00+00:00")

    def test_year_end_cycle_crosses_into_january(self):
        b = self.bounds(15, "2026-12-20T00:00:00")
        self.assertEqual(b["start"], "2026-12-15T00:00:00+00:00")
        self.assertEqual(b["end"], "2027-01-15T00:00:00+00:00")


class EvidenceConsistencyRegressions(unittest.TestCase):
    def profiles(self, data):
        import tempfile, os, json
        h = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False)
        json.dump(data, h); h.close()
        self.addCleanup(lambda: os.unlink(h.name))
        return billing.load_profiles(Path(h.name))

    def test_incremental_evidence_matches_the_cumulative_total(self):
        loaded = self.profiles({"profiles": [{"id": "g", "provider": "c", "kind": "prepaid",
            "allowances": {"m": 0.10}, "overage_paid": True}]})
        report = billing.classify([{"provider": "c", "model": "m", "list_usd": 0.30, "_tokens": 5,
            "call_id": "a", "_input": 0, "_output": 0, "_cache_read": 0, "_cache_write": 0, "last_seen": None}], loaded)
        self.assertAlmostEqual(report["incremental_usd"], 0.20)
        self.assertAlmostEqual(report["evidence"]["incremental_cash"]["usd"], 0.20)
        self.assertEqual(report["evidence"]["incremental_cash"]["basis"], "inferred")

    def test_provider_cost_without_catalogue_rate_leaves_api_unpriced(self):
        loaded = self.profiles({"profiles": []})
        report = billing.classify([{"provider": "c", "model": "m", "list_usd": None,
            "_provider_cost_usd": 0.42, "_tokens": 5, "call_id": "a", "_input": 0, "_output": 0,
            "_cache_read": 0, "_cache_write": 0, "last_seen": None}], loaded)
        self.assertIsNone(report["api_equivalent_usd"])
        self.assertEqual(report["evidence"]["api_equivalent"]["basis"], "unpriced")
        self.assertAlmostEqual(report["evidence"]["provider_reported"]["usd"], 0.42)
        self.assertEqual(report["evidence"]["provider_reported"]["basis"], "confirmed")

    def test_legacy_membership_fee_is_not_inferred_from_advanced_rules(self):
        loaded = self.profiles({"profiles": [{"id": "g", "provider": "c", "kind": "subscription_credits",
            "monthly_fee_usd": 10, "effective_from": "2020-01-01"}]})
        report = billing.classify([], loaded)
        self.assertEqual(report["subscription_fees_usd"], 0.0)
        self.assertEqual(report["evidence"]["subscription_fee"]["basis"], "none")
        self.assertEqual(report["legacy_membership_arrangements_ignored"], 1)
        self.assertIsNone(report["evidence"]["provider_reported"]["usd"])


class MixedArrangementRegressions(unittest.TestCase):
    def profiles(self, data):
        import tempfile, os, json
        h = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False)
        json.dump(data, h); h.close()
        self.addCleanup(lambda: os.unlink(h.name))
        return billing.load_profiles(Path(h.name))

    def row(self, provider, model, value, cid):
        return {"provider": provider, "model": model, "list_usd": value, "_tokens": 10, "call_id": cid,
                "_input": 0, "_output": 0, "_cache_read": 0, "_cache_write": 0, "last_seen": None}

    def mixed(self):
        return self.profiles({"profiles": [
            {"id": "payg", "provider": "direct", "kind": "api"},
            {"id": "sub", "provider": "member", "kind": "subscription_credits",
             "allowances": {"m": 0.10}, "overage_paid": True}]})

    def test_payg_spending_is_not_replaced_by_subscription_overage(self):
        report = billing.classify([self.row("direct", "m", 2.00, "a"),
                                   self.row("member", "m", 0.30, "b")], self.mixed())
        self.assertAlmostEqual(report["incremental_usd"], 2.00)
        self.assertAlmostEqual(report["evidence"]["incremental_cash"]["usd"], 2.00)
        self.assertAlmostEqual(report["api_equivalent_usd"], 2.30)
        self.assertEqual(report["by_kind"]["unknown"]["calls"], 1)

    def test_payg_usage_is_not_membership_credit(self):
        report = billing.classify([self.row("direct", "m", 2.00, "a")], self.mixed())
        self.assertEqual(report["credits_consumed_usd"], 0.0)
        self.assertIsNone(report["evidence"]["credits_consumed"]["usd"])

    def test_unknown_plan_does_not_become_cash(self):
        loaded = self.profiles({"profiles": [{"id": "u", "provider": "x", "kind": "unknown"}]})
        report = billing.classify([self.row("x", "m", 1.00, "a")], loaded)
        self.assertEqual(report["incremental_usd"], 0.0)
        self.assertEqual(report["evidence"]["incremental_cash"]["basis"], "unknown")
        self.assertEqual(report["credits_consumed_usd"], 0.0)

    def test_legacy_free_arrangement_is_retired_from_advanced_rules(self):
        self.assertIn("managed in Memberships", " ".join(billing.validation_errors({"id": "f", "kind": "free"})))
        loaded = self.profiles({"profiles": [{"id": "f", "provider": "x", "kind": "free"}]})
        report = billing.classify([self.row("x", "m", 1.00, "a")], loaded)
        self.assertEqual(report["incremental_usd"], 0.0)
        self.assertEqual(report["legacy_membership_arrangements_ignored"], 1)
        self.assertEqual(report["by_kind"]["unknown"]["calls"], 1)

    def test_stale_revision_raises_a_conflict_not_a_validation_error(self):
        import tempfile
        path = Path(tempfile.mkdtemp()) / "p.json"
        billing.save_profile({"id": "g", "provider": "x", "kind": "api"}, path)
        with self.assertRaises(billing.ProfileConflict):
            billing.save_profile({"id": "g", "provider": "x", "kind": "api"}, path, if_rev="stale")
        with self.assertRaises(ValueError):
            billing.save_profile({"id": "bad", "kind": "nonsense", "provider": "x"}, path)


class SaveEndpointStatus(unittest.TestCase):
    def test_conflict_is_409_and_validation_is_422(self):
        import os, tempfile, importlib
        from fastapi import HTTPException
        home = tempfile.mkdtemp()
        old = os.environ.get("HERMES_HOME")
        os.environ["HERMES_HOME"] = home
        try:
            import dashboard.plugin_api as api
            importlib.reload(api)
            api.billing_save("g", {"provider": "x", "kind": "api"}, if_rev=None)
            with self.assertRaises(HTTPException) as conflict:
                api.billing_save("g", {"provider": "x", "kind": "api"}, if_rev="stale")
            self.assertEqual(conflict.exception.status_code, 409)
            with self.assertRaises(HTTPException) as invalid:
                api.billing_save("bad", {"provider": "x", "kind": "nonsense"}, if_rev=None)
            self.assertEqual(invalid.exception.status_code, 422)
        finally:
            if old is None: os.environ.pop("HERMES_HOME", None)
            else: os.environ["HERMES_HOME"] = old
