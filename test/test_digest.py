"""Local digest: a readable report from existing calculations only.

Uses isolated SQLite fixtures and synthetic stores. The digest transmits
figures from the analytics, economics, membership and weather builders; the
tests below pin faithful transmission, explicit uncertainty, window labels,
Markdown escaping and localisation — never new accounting.
"""
from __future__ import annotations

import json
import os
import re
import sqlite3
import tempfile
import time
import unittest
from contextlib import closing, contextmanager
from datetime import datetime, timezone
from pathlib import Path

from wolfmark_ledger import analytics
from wolfmark_ledger import billing
from wolfmark_ledger import digest as D
from wolfmark_ledger import economics
from wolfmark_ledger import membership as M
from wolfmark_ledger import membership_store as mstore
from wolfmark_ledger import store
from wolfmark_ledger.pricing import Catalogue, Rate

NOW = datetime(2026, 10, 31, 12, tzinfo=timezone.utc).timestamp()
DAY = 86400


def plans_doc(*plans):
    return M.load_plan_catalogue({"catalogue_version": "test.1", "plans": list(plans)})


PLANS = plans_doc(
    {"id": "test.plus", "provider_family": "test", "name": "Test Plus",
     "price": {"amount": 20.0, "currency": "USD", "period": "month"},
     "entitlements": {"windows": [{
         "id": "monthly-credit", "label": "Monthly credit", "kind": "billing_cycle",
         "limit": "credit_value_usd", "amount": 100.0, "currency": "USD",
         "scope": "account"}]}},
)


def account(aid, family, **kw):
    base = {"id": aid, "family": family, "label": aid,
            "route_slugs": [family], "credential_present": True,
            "billing_arrangement": "subscription",
            "plan_id": None, "fee_overrides": [], "manual_exhaustions": []}
    base.update(kw)
    return base


@contextmanager
def timezone(name):
    previous = os.environ.get("TZ")
    os.environ["TZ"] = name
    time.tzset()
    try:
        yield
    finally:
        if previous is None:
            os.environ.pop("TZ", None)
        else:
            os.environ["TZ"] = previous
        time.tzset()


class DigestCase(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory(dir=os.environ.get("TMPDIR"))
        self.addCleanup(self.scratch.cleanup)
        self.dir = Path(self.scratch.name)
        self.events = self.dir / "usage.db"
        self.state = self.dir / "state.db"
        self.memberships = self.dir / "memberships.json"
        self.profiles = self.dir / "billing-profiles.json"
        self.book = Catalogue({"test": {"m": Rate(2, 4, .5, 3),
                                        "n": Rate(2, 4, .5, 3),
                                        "weird|model": Rate(2, 4, .5, 3)}},
                              "fixture", "test", "", "1")

    def create_events(self, rows=(), baseline_at=None, baseline_total=0):
        with closing(sqlite3.connect(self.events)) as conn, conn:
            conn.executescript(store._SCHEMA)
            for index, row in enumerate(rows):
                values = {"event_id": f"event-{index}", "ts": NOW - 3 * DAY,
                          "model": "m", "provider": "test", "platform": "desktop",
                          "outcome": "ok", "input_tokens": 0, "output_tokens": 0,
                          "recorded_at": None, **row}
                if values["recorded_at"] is None:
                    values["recorded_at"] = values["ts"]
                values["total_tokens"] = (values["input_tokens"] + values["output_tokens"]
                                          + values.get("cache_read_tokens", 0)
                                          + values.get("cache_write_tokens", 0))
                columns = list(values)
                conn.execute(f"INSERT INTO calls ({','.join(columns)}) VALUES "
                             f"({','.join('?' for _ in columns)})", list(values.values()))
            if baseline_at is not None:
                conn.execute("INSERT INTO baseline (id, captured_at, total_tokens,"
                             " main_tokens, aux_tokens) VALUES (1, ?, ?, 0, 0)",
                             (baseline_at, baseline_total))

    def create_state(self, total):
        with closing(sqlite3.connect(self.state)) as conn, conn:
            conn.executescript(
                "CREATE TABLE session_model_usage (input_tokens INTEGER,"
                " output_tokens INTEGER, cache_read_tokens INTEGER,"
                " cache_write_tokens INTEGER);"
                f"INSERT INTO session_model_usage VALUES ({total}, 0, 0, 0);")

    def write_store(self, accounts):
        self.memberships.write_text(json.dumps({"version": 1, "accounts": accounts}))

    def write_profiles(self, profiles, defaults=None):
        self.profiles.write_text(json.dumps(
            {"version": 1, "profiles": profiles, "defaults": defaults or {}}))

    def standard_fixture(self):
        """Three window calls ($5.00) plus one previous-window call ($2.00)."""
        self.write_store([account("test:default", "test", plan_id="test.plus")])
        self.write_profiles([{"id": "cap", "provider": "test", "kind": "api",
                              "allowance_usd": 10.0, "billing_cycle": {"day": 1}}])
        self.create_events([
            {"model": "m", "input_tokens": 1_000_000, "ts": NOW - 1 * DAY},
            {"model": "m", "input_tokens": 1_000_000, "ts": NOW - 3 * DAY},
            {"model": "n", "input_tokens": 500_000, "ts": NOW - 5 * DAY},
            {"model": "m", "input_tokens": 1_000_000, "ts": NOW - 10 * DAY},
        ], baseline_at=NOW - 40 * DAY)
        self.create_state(3_500_000)

    def report(self, **kwargs):
        params = {"now": NOW, "days": 7, "lang": "en",
                  "event_db_path": self.events, "state_db_path": self.state,
                  "membership_path": self.memberships, "plans": PLANS,
                  "profiles_path": self.profiles, "catalogue": self.book}
        params.update(kwargs)
        return D.build_digest(**params)

    def section(self, result, sid):
        return next(s for s in result["sections"] if s["id"] == sid)


class DigestShapeTests(DigestCase):
    def test_metadata_shape_and_order(self):
        self.standard_fixture()
        result = self.report()
        self.assertTrue(result["ok"])
        self.assertEqual(result["days"], 7)
        self.assertEqual(result["lang"], "en")
        self.assertEqual(result["generated_at"], "2026-10-31T12:00:00Z")
        self.assertIn("SpendSense", result["title"])
        self.assertIn("7", result["period"]["label"])
        self.assertRegex(result["filename"], r"^spend-sense-digest-2026-10-31-7d-en\.md$")
        self.assertFalse(result["empty"])
        self.assertEqual([s["id"] for s in result["sections"]],
                         ["report_coverage", "usage", "models", "providers",
                          "value", "spending", "fees", "allowances", "changes",
                          "coverage", "methodology"])
        for section in result["sections"]:
            self.assertTrue(section["heading"], section["id"])
            if section["id"] == "methodology":
                self.assertEqual(section["window"], "")
            else:
                self.assertTrue(section["window"], section["id"])
            self.assertIn(section["kind"], ("lines", "table", "notes"))

    def test_usage_figures_match_analytics(self):
        self.standard_fixture()
        result = self.report()
        expected = analytics.build_analytics_report(
            self.events, state_db_path=self.state, days=7, now=NOW,
            catalogue=self.book, profiles_path=self.profiles)
        usage = self.section(result, "usage")
        by_label = {line["label"]: line["value"] for line in usage["lines"]}
        totals = expected["totals"]
        self.assertEqual(by_label["Calls"], str(totals["calls"]))
        self.assertIn("$5.00", " ".join(by_label.values()))
        self.assertEqual(usage["window"], result["period"]["label"])

    def test_top_models_order_and_escaping(self):
        self.standard_fixture()
        with closing(sqlite3.connect(self.events)) as conn, conn:
            conn.execute("INSERT INTO calls (event_id, ts, model, provider, outcome,"
                         " input_tokens, total_tokens, recorded_at)"
                         " VALUES ('nasty', ?, 'weird|model', 'test', 'ok', 1000000, 1000000, ?)",
                         (NOW - 2 * DAY, NOW - 2 * DAY))
        result = self.report()
        models = self.section(result, "models")
        names = [row[0] for row in models["rows"]]
        # Ordered by API-equivalent value, highest first; m ($4) before n ($1).
        self.assertEqual(names[0], "m")
        # Sections carry raw values (React escapes the preview); only the
        # Markdown renderer escapes structure characters.
        self.assertIn("weird|model", names)
        self.assertIn("weird\\|model", result["markdown"])
        self.assertEqual(models["heading"], "Top models by priced API-equivalent subtotal")

    def test_cost_figures_are_kept_separate(self):
        self.standard_fixture()
        result = self.report()
        markdown = result["markdown"]
        for section_id in ("value", "spending", "fees"):
            self.assertIn(self.section(result, section_id)["heading"], markdown)
        self.assertNotRegex(markdown, re.compile(r"grand total", re.IGNORECASE))
        self.assertNotRegex(markdown, re.compile(r"\byou save\b|\bcould save\b|\brecommend", re.IGNORECASE))

    def test_window_labels_distinguish_periods(self):
        self.standard_fixture()
        result = self.report()
        usage_window = self.section(result, "usage")["window"]
        allowance_window = self.section(result, "allowances")["window"]
        self.assertIn("Last 7 days", usage_window)
        self.assertIn("Current allowance cycle", allowance_window)
        self.assertNotEqual(usage_window, allowance_window)

    def test_sections_and_markdown_agree(self):
        self.standard_fixture()
        result = self.report()
        markdown = result["markdown"]
        for section in result["sections"]:
            self.assertIn(section["heading"], markdown)
            for line in section.get("lines", []):
                self.assertIn(line["value"], markdown)
            for row in section.get("rows", []):
                for cell in row:
                    self.assertIn(D._escape(cell), markdown)


class DigestContentTests(DigestCase):
    def test_previous_comparison_when_comparable(self):
        self.standard_fixture()
        result = self.report()
        changes = self.section(result, "changes")
        text = " ".join(f"{line['label']} {line['value']}" for line in changes["lines"])
        # Builder deltas are relative change; the digest shows them with the
        # previous absolute for context ($5 vs $2, 3 vs 1 calls).
        self.assertIn("+150.0% (was $2.00)", text)
        self.assertIn("+200.0% (was 1)", text)

    def test_previous_omitted_when_incomparable(self):
        self.write_store([account("test:default", "test", plan_id="test.plus")])
        self.write_profiles([])
        self.create_events([{"input_tokens": 1_000_000}],
                           baseline_at=NOW - 40 * DAY)
        self.create_state(1_000_000)
        result = self.report()
        changes = self.section(result, "changes")
        # No comparable history: one compact note, not a table of dashes.
        self.assertEqual(changes["kind"], "notes")
        self.assertEqual(changes["lines"], [])
        self.assertEqual(len(changes["notes"]), 1)
        self.assertTrue(any("No calls were recorded in the previous" in note
                            for note in changes["notes"]))

    def test_insufficient_previous_history_has_a_distinct_reason(self):
        self.write_store([account("test:default", "test", plan_id="test.plus")])
        self.write_profiles([])
        self.create_events([{"input_tokens": 1_000_000}], baseline_at=NOW - 10 * DAY)
        self.create_state(1_000_000)
        changes = self.section(self.report(), "changes")
        self.assertEqual(changes["kind"], "notes")
        self.assertEqual(changes["lines"], [])
        self.assertEqual(len(changes["notes"]), 1)
        self.assertTrue(any("Not enough earlier history to compare yet" in note for note in changes["notes"]))

    def test_genuine_zero_when_recording_covers_an_empty_window(self):
        self.write_store([account("test:default", "test", plan_id="test.plus")])
        self.write_profiles([])
        self.create_events([], baseline_at=NOW - 40 * DAY)
        self.create_state(0)
        result = self.report()
        self.assertTrue(result["empty"])
        usage = self.section(result, "usage")
        values = " ".join(line["value"] for line in usage["lines"])
        self.assertIn("0", values)
        self.assertNotIn("—", values)
        self.assertTrue(any("No calls recorded" in note for note in usage["notes"]))

    def test_unknown_when_recording_starts_inside_the_window(self):
        self.write_store([account("test:default", "test", plan_id="test.plus")])
        self.write_profiles([])
        self.create_events([], baseline_at=NOW - 2 * DAY)
        self.create_state(0)
        result = self.report()
        usage = self.section(result, "usage")
        values = " ".join(line["value"] for line in usage["lines"])
        self.assertIn("—", values)
        summary = self.section(result, "report_coverage")
        self.assertTrue(any("incomplete" in note.lower() for note in summary["notes"]))

    def test_observed_figures_flagged_partial_on_late_baseline(self):
        self.write_store([account("test:default", "test", plan_id="test.plus")])
        self.write_profiles([])
        self.create_events([{"input_tokens": 1_000_000}],
                           baseline_at=NOW - 2 * DAY)
        self.create_state(1_000_000)
        result = self.report()
        usage = self.section(result, "usage")
        values = " ".join(f"{line['label']} {line['value']}" for line in usage["lines"])
        self.assertIn("$2.00", values)
        summary = self.section(result, "report_coverage")
        by_label = {line["label"]: line["value"] for line in summary["lines"]}
        self.assertIn("Partial", by_label["Window coverage"])

    def test_missing_store_raises(self):
        self.memberships.write_text("{not json")
        with self.assertRaises(mstore.StoreUnreadable):
            self.report()

    def test_allowance_section_is_compact_and_current(self):
        self.standard_fixture()
        result = self.report()
        allowances = self.section(result, "allowances")
        self.assertTrue(allowances["rows"])
        text = " ".join(" ".join(row) for row in allowances["rows"])
        self.assertIn("test:default", text)
        self.assertEqual(allowances["columns"][1], "Calculated cycle end")
        notes = " ".join(allowances["notes"])
        self.assertIn("not provider-confirmed reset times", notes)
        self.assertIn("do not include provider usage readings or query providers", notes)
        self.assertIn("Check Memberships for provider readings", notes)
        self.assertIn("locally recorded usage under configured cost rules", notes)

    def test_allowance_unknown_reasons_are_grouped_by_cause(self):
        accounts = [
            {"account_id": "a", "label": "A", "cycle": {}, "rollup": {"state": "unknown"},
             "windows": [{"verdict": "unknown", "verdict_basis": "none"}]},
            {"account_id": "b", "label": "B", "cycle": {}, "rollup": {"state": "unknown"},
             "windows": [{"verdict": "unknown", "verdict_basis": "none"}]},
            {"account_id": "c", "label": "C", "cycle": {}, "rollup": {"state": "unknown"},
             "windows": [{"verdict": "unknown", "verdict_basis": "provider_only"}]},
            {"account_id": "d", "label": "D", "cycle": {}, "rollup": {"state": "unknown"},
             "windows": [{"verdict": "unknown", "verdict_basis": "conflicted"}]},
            {"account_id": "e", "label": "E", "cycle": {}, "rollup": {"state": "unknown"},
             "windows": [], "rules": []},
            {"account_id": "f", "label": "F", "cycle": {}, "rollup": {"state": "unknown"},
             "windows": [{"verdict": "unknown", "verdict_basis": "none",
                          "cycle_basis": "none"}]},
            {"account_id": "g", "label": "G", "cycle": {}, "rollup": {"state": "unknown"},
             "windows": [], "rules": [{"verdict": "unknown", "verdict_basis": "none",
                                         "pool": "shared"}]},
        ]
        section = D._allowances_section(D.STRINGS["en"], "Current allowance cycle, as of 2026-10-31",
                                        accounts)
        notes = " ".join(section["notes"])
        self.assertIn("2 account(s)", notes)
        self.assertIn("no usable cycle position", notes)
        self.assertIn("readings conflict", notes)
        self.assertIn("No configured allowance window", notes)
        self.assertIn("no usable cycle position is available", notes)
        self.assertIn("allowance limit is unavailable or unusable", notes)

        translated = D._allowances_section(
            D.STRINGS["zh"], "当前额度周期（截至 2026-10-31）", accounts)
        translated_notes = " ".join(translated["notes"])
        self.assertIn("没有服务商读数或手动标记", translated_notes)
        self.assertIn("服务商读数与手动标记冲突", translated_notes)
        self.assertIn("没有可用的周期位置", translated_notes)
        self.assertIn("额度上限不可用或无效", translated_notes)
        self.assertIn("报告摘要不包含服务商用量读数，也不会查询服务商", translated_notes)


class DigestLocalisationTests(DigestCase):
    def test_zh_report_carries_the_same_figures(self):
        self.standard_fixture()
        result = self.report(lang="zh")
        self.assertEqual(result["lang"], "zh")
        self.assertRegex(result["filename"], r"-zh\.md$")
        self.assertRegex(result["title"], r"[\u4e00-\u9fff]")
        for section in result["sections"]:
            self.assertRegex(section["heading"], r"[\u4e00-\u9fff]", section["id"])
        self.assertEqual(self.section(result, "models")["heading"], "按已定价 API 等值小计排名的模型")
        self.assertIn("$5.00", result["markdown"])
        self.assertIn("test:default", result["markdown"])

    def test_seven_and_thirty_day_reports_keep_en_zh_ux_copy(self):
        self.standard_fixture()
        for days in (7, 30):
            for lang in ("en", "zh"):
                with self.subTest(days=days, lang=lang):
                    result = self.report(days=days, lang=lang)
                    models = self.section(result, "models")
                    allowances = self.section(result, "allowances")
                    methodology = " ".join(self.section(result, "methodology")["notes"])
                    self.assertIn(str(days), result["period"]["label"])
                    self.assertIn("API-equivalent subtotal" if lang == "en" else "API 等值小计",
                                  models["heading"])
                    allowance_notes = " ".join(allowances["notes"])
                    if lang == "en":
                        self.assertIn("not provider-confirmed reset times", allowance_notes)
                        self.assertIn("do not include provider usage readings", allowance_notes)
                        self.assertIn("current-cycle values calculated under configured cost rules", methodology)
                    else:
                        self.assertIn("并非服务商确认的重置时间", allowance_notes)
                        self.assertIn("不包含服务商用量读数", allowance_notes)
                        self.assertIn("当前周期内按配置费用规则计算", methodology)

    def test_unknown_lang_falls_back_to_english(self):
        self.standard_fixture()
        result = self.report(lang="fr")
        self.assertEqual(result["lang"], "en")

    @unittest.skipUnless(hasattr(time, "tzset"), "requires POSIX time zones")
    def test_dst_boundary_builds_and_matches_analytics(self):
        self.standard_fixture()
        with timezone("Europe/London"):
            result = self.report()
            expected = analytics.build_analytics_report(
                self.events, state_db_path=self.state, days=7, now=NOW,
                catalogue=self.book, profiles_path=self.profiles)
        usage = self.section(result, "usage")
        by_label = {line["label"]: line["value"] for line in usage["lines"]}
        self.assertEqual(by_label["Calls"], str(expected["totals"]["calls"]))
        self.assertIn("Last 7 days", usage["window"])


class DigestReviewFixesTests(DigestCase):
    """PR8 review: unknown stays unknown, scopes are honest, exports escape."""

    def values_text(self, section):
        return " ".join(line["value"] for line in section["lines"])

    def test_unobserved_window_withholds_every_figure(self):
        self.write_store([account("test:default", "test", plan_id="test.plus")])
        self.write_profiles([])
        self.create_events([], baseline_at=NOW - 2 * DAY)
        self.create_state(0)
        result = self.report()
        for sid in ("value", "spending"):
            values = self.values_text(self.section(result, sid))
            self.assertNotIn("$0.00", values, sid)
            self.assertIn("—", values, sid)
        summary = " ".join(self.section(result, "report_coverage")["notes"])
        self.assertIn("incomplete", summary.lower())
        for sid in ("models", "providers"):
            notes = " ".join(self.section(result, sid)["notes"])
            self.assertNotIn("No ", notes, sid)

    def test_covered_empty_window_keeps_genuine_spending_zero(self):
        self.write_store([account("test:default", "test", plan_id="test.plus")])
        self.write_profiles([])
        self.create_events([], baseline_at=NOW - 40 * DAY)
        self.create_state(0)
        result = self.report()
        spending = self.section(result, "spending")
        by_label = {line["label"]: line["value"] for line in spending["lines"]}
        self.assertEqual(by_label["Metered usage value (all cost rules)"], "$0.00")
        self.assertEqual(by_label["Extra cash (incremental) spending"], "$0.00")
        self.assertEqual(by_label["Credits consumed"], "$0.00")
        self.assertEqual(by_label["Provider-reported charges"], "—")

    def test_spending_scope_follows_billing_exclusions(self):
        self.standard_fixture()
        expected = analytics.build_analytics_report(
            self.events, state_db_path=self.state, days=7, now=NOW,
            catalogue=self.book, profiles_path=self.profiles)
        excluded = (expected.get("billing") or {}).get("excluded_out_of_cycle") or 0
        result = self.report()
        spending = self.section(result, "spending")
        if excluded:
            self.assertEqual(spending["window"], "Current billing cycles")
            notes = " ".join(spending["notes"])
            self.assertIn(str(excluded), notes)
            self.assertIn("excluded from spending", notes)
        else:
            self.assertEqual(spending["window"], result["period"]["label"])

    def test_excluded_scope_wording(self):
        billing = {"metered_usd": 1.0, "excluded_out_of_cycle": 2,
                   "unclassified_tokens": 0, "unclassified_calls": 0,
                   "evidence": {"incremental_cash": {"usd": 0.0},
                                "credits_consumed": {"usd": None}}}
        section = D._spending_section(D.STRINGS["en"], "Last 7 days", billing, True, 5)
        self.assertEqual(section["window"], "Current billing cycles")
        self.assertTrue(any("2 calls outside current billing cycles" in note
                            for note in section["notes"]))

    def test_cash_lines_distinguish_zero_unknown_and_lower_bound(self):
        self.standard_fixture()
        result = self.report()
        spending = self.section(result, "spending")
        by_label = {line["label"]: line["value"] for line in spending["lines"]}
        # No overage matched any rule: extra cash is known zero, not unknown.
        self.assertEqual(by_label["Extra cash (incremental) spending"], "$0.00")
        # No credit rule matched: consumption cannot be stated at all.
        self.assertEqual(by_label["Credits consumed"], "—")
        self.assertTrue(any("credit rule" in note for note in spending["notes"]))

    def test_unvalued_calls_make_spending_a_lower_bound(self):
        self.write_store([account("test:default", "test", plan_id="test.plus")])
        self.write_profiles([])
        self.create_events([
            {"model": "m", "input_tokens": 1_000_000, "ts": NOW - 1 * DAY},
            {"model": "zzz", "input_tokens": 500_000, "ts": NOW - 2 * DAY},
        ], baseline_at=NOW - 40 * DAY)
        self.create_state(1_500_000)
        result = self.report()
        spending = self.section(result, "spending")
        by_label = {line["label"]: line["value"] for line in spending["lines"]}
        self.assertEqual(by_label["Metered usage value (all cost rules)"], "≥$2.00")
        # One call has no price at all: extra cash is unknown, never $0.00.
        self.assertEqual(by_label["Extra cash (incremental) spending"], "—")
        self.assertEqual(by_label["Unclassified calls"], "1")
        # The ≥ marker stays on the metered line, but its explanation lives
        # once in the coverage summary; spending keeps the billing reasons.
        summary = self.section(result, "report_coverage")
        self.assertIn("lower bounds", " ".join(summary["notes"]).lower())

    def test_unclassified_calls_do_not_claim_that_pricing_is_missing(self):
        billing = {
            "metered_usd": 2.0, "excluded_out_of_cycle": 0,
            "unclassified_tokens": 0, "unclassified_calls": 10,
            "evidence": {
                "provider_reported": {"usd": None, "basis": "none", "calls": 0},
                "incremental_cash": {"usd": None, "basis": "unknown"},
                "credits_consumed": {"usd": None},
            },
        }
        section = D._spending_section(D.STRINGS["en"], "Last 7 days", billing, True, 10)
        notes = " ".join(section["notes"]).lower()
        self.assertIn("record does not say whether no rule matched", notes)
        self.assertNotIn("no matching billing rule", notes)
        self.assertNotIn("a billing rule matched", notes)
        self.assertNotIn("some usage is unpriced", notes)
        self.assertIn("10 call(s) are unclassified", notes)
        self.assertEqual(
            next(line["value"] for line in section["lines"]
                 if line["label"] == "Metered usage value (all cost rules)"), "≥$2.00")
        self.assertEqual(
            next(line["value"] for line in section["lines"]
                 if line["label"] == "Provider-reported charges"), "—")
        self.assertTrue(any("Actual provider charges are incomplete" in note
                            for note in section["notes"]))

    def test_matching_billing_rule_without_price_or_charge_has_specific_explanation(self):
        row = {
            "provider": "test", "model": "m", "list_usd": None,
            "_provider_cost_usd": None, "_tokens": 50, "last_seen": NOW - 1,
            "_input": 50, "_output": 0, "_cache_read": 0, "_cache_write": 0,
            "_failure": False, "_missing": False, "outcome": "ok",
        }
        for lang, matched_text, evidence_text in (
            ("en", "a billing rule matched", "price or provider charge evidence"),
            ("zh", "匹配了计费规则", "价格或服务商费用记录证据"),
        ):
            matched = billing.classify([row], {
                "profiles": [{"id": "api", "provider": "test", "kind": "api"}],
                "defaults": {}, "loaded": True})
            section = D._spending_section(D.STRINGS[lang], "Last 7 days", matched, True, 1)
            notes = " ".join(section["notes"]).lower()
            self.assertIn(matched_text, notes)
            self.assertIn(evidence_text, notes)
            if lang == "en":
                self.assertNotIn("no matching billing rule", notes)

        unmatched = billing.classify([row], {"profiles": [], "defaults": {}, "loaded": True})
        notes = " ".join(D._spending_section(
            D.STRINGS["en"], "Last 7 days", unmatched, True, 1)["notes"]).lower()
        self.assertIn("no matching billing rule", notes)
        self.assertNotIn("a billing rule matched", notes)

    def test_zh_incomplete_calls_uses_token_terminology(self):
        section = D._report_coverage_section(
            D.STRINGS["zh"], "最近 7 天", covers=True, calls=1,
            totals={"unpriced_calls": 1, "unpriced_tokens": 0},
            billing={}, recording_since=None)
        notes = " ".join(section["notes"])
        self.assertIn("未定价 token", notes)
        self.assertNotIn("未定价令牌", notes)

    def test_provider_reported_charge_keeps_its_own_basis_and_currency_line(self):
        billing = {
            "metered_usd": 2.0, "excluded_out_of_cycle": 0,
            "unclassified_tokens": 0, "unclassified_calls": 0,
            "evidence": {
                "provider_reported": {"usd": 3.25, "basis": "confirmed", "calls": 1},
                "incremental_cash": {"usd": 2.0, "basis": "inferred"},
                "credits_consumed": {"usd": 1.0},
            },
        }
        section = D._spending_section(D.STRINGS["en"], "Last 7 days", billing, True, 1)
        by_label = {line["label"]: line["value"] for line in section["lines"]}
        self.assertEqual(by_label["Provider-reported charges"], "$3.25")
        self.assertEqual(by_label["Metered usage value (all cost rules)"], "$2.00")
        self.assertEqual(by_label["Extra cash (incremental) spending"], "$2.00")
        self.assertEqual(by_label["Credits consumed"], "$1.00")

    def test_partial_provider_charge_subtotal_names_confirmed_call_coverage(self):
        billing = {
            "metered_usd": 0.0, "excluded_out_of_cycle": 0,
            "unclassified_tokens": 0, "unclassified_calls": 0,
            "evidence": {
                "provider_reported": {"usd": 3.25, "basis": "confirmed", "calls": 1},
                "incremental_cash": {"usd": 0.0, "basis": "inferred"},
                "credits_consumed": {"usd": 0.0},
            },
        }
        for language, expected in (
                ("en", "(1 of 2 recorded calls confirmed)"),
                ("zh", "（2 次已记录调用中有 1 次已确认）")):
            section = D._spending_section(D.STRINGS[language], "Last 7 days", billing, False, 2)
            by_label = {line["label"]: line["value"] for line in section["lines"]}
            self.assertIn(expected, by_label[D.STRINGS[language]["label_provider_charges"]])
            self.assertEqual(by_label[D.STRINGS[language]["label_metered"]], D.STRINGS[language]["unknown"])
            self.assertEqual(by_label[D.STRINGS[language]["label_incremental"]], D.STRINGS[language]["unknown"])
            self.assertEqual(by_label[D.STRINGS[language]["label_credits"]], D.STRINGS[language]["unknown"])

    def test_incomplete_recording_qualifies_usage_and_ranked_api_subtotals(self):
        totals = {"calls": 2, "tokens": 100, "list_usd": 2.0, "unpriced_tokens": 0,
                  "unpriced_calls": 0, "input_tokens": 100, "output_tokens": 0,
                  "cache_read_tokens": 0, "cache_write_tokens": 0}
        usage = D._usage_section(D.STRINGS["en"], "Last 7 days", totals, False, 2)
        usage_value = next(line["value"] for line in usage["lines"]
                           if line["label"] == D.STRINGS["en"]["label_api_value"])
        self.assertTrue(usage_value.startswith("≥"))
        ranked = D._ranked_table(
            D.STRINGS["en"], "models", "Models", "Last 7 days", [],
            [{"name": "m", "calls": 2, "tokens": 100, "list_usd": 2.0,
              "unpriced_tokens": 0, "unpriced_calls": 0}], "empty", False, 2)
        self.assertTrue(ranked["rows"][0][-1].startswith("≥"))
        value = D._value_section(D.STRINGS["en"], "Last 7 days", totals,
                                 {"coverage": 1.0, "unpriced_tokens": 0}, False, 2)
        api_value = next(line["value"] for line in value["lines"]
                         if line["label"] == D.STRINGS["en"]["label_api_value"])
        self.assertTrue(api_value.startswith("≥"))

    def test_zero_token_price_gap_makes_the_attributed_comparison_partial(self):
        partial = D._attributed_pricing_partial([{"usage": {
            "unpriced_tokens": 0, "unpriced_calls": 1}}])
        self.assertTrue(partial)
        section = D._fees_section(D.STRINGS["en"], "Last 7 days", {
            "fees_monthly_by_currency": [], "fees_window_by_currency": [],
            "usage_usd": 2.0, "difference_usd": 1.0, "status": "partial",
        }, True, 2, partial)
        usage_value = next(line["value"] for line in section["lines"]
                           if line["label"] == D.STRINGS["en"]["label_usage_value"])
        self.assertTrue(usage_value.startswith("≥"))

    def test_value_comparison_withheld_when_current_window_partly_priced(self):
        self.standard_fixture()
        with closing(sqlite3.connect(self.events)) as conn, conn:
            conn.execute("INSERT INTO calls (event_id, ts, model, provider, outcome,"
                         " input_tokens, total_tokens, recorded_at)"
                         " VALUES ('unpriced', ?, 'zzz', 'test', 'ok', 500000, 500000, ?)",
                         (NOW - 2 * DAY, NOW - 2 * DAY))
        result = self.report()
        changes = self.section(result, "changes")
        text = " ".join(f"{line['label']} {line['value']}" for line in changes["lines"])
        self.assertNotIn("+150.0%", text)
        value_line = next(line["value"] for line in changes["lines"]
                          if line["label"] == "API-equivalent value")
        self.assertTrue(value_line.startswith("—"), value_line)
        # Token and call counts still compare: they need no prices.
        self.assertRegex(text, r"Calls [+-]")
        self.assertRegex(text, r"Tokens [+-]")
        self.assertTrue(any("pricing" in note.lower() for note in changes["notes"]))

    def test_value_comparison_withheld_when_previous_window_partly_priced(self):
        self.write_store([account("test:default", "test", plan_id="test.plus")])
        self.write_profiles([{"id": "cap", "provider": "test", "kind": "api",
                              "allowance_usd": 10.0, "billing_cycle": {"day": 1}}])
        self.create_events([
            {"model": "m", "input_tokens": 1_000_000, "ts": NOW - 1 * DAY},
            {"model": "m", "input_tokens": 1_000_000, "ts": NOW - 3 * DAY},
            {"model": "n", "input_tokens": 500_000, "ts": NOW - 5 * DAY},
            {"model": "zzz", "input_tokens": 1_000_000, "ts": NOW - 10 * DAY},
            {"model": "m", "input_tokens": 1_000_000, "ts": NOW - 11 * DAY},
        ], baseline_at=NOW - 40 * DAY)
        self.create_state(4_500_000)
        result = self.report()
        changes = self.section(result, "changes")
        text = " ".join(f"{line['label']} {line['value']}" for line in changes["lines"])
        value_line = next(line["value"] for line in changes["lines"]
                          if line["label"] == "API-equivalent value")
        self.assertTrue(value_line.startswith("—"), value_line)
        # The previous window mixes priced and unpriced calls: its subtotal
        # is a lower bound, never an exact figure.
        self.assertIn("(was ≥$2.00)", value_line)
        self.assertRegex(text, r"Calls [+-]")

    def test_unknown_cash_basis_withholds_the_zero(self):
        self.write_store([account("test:default", "test", plan_id="test.plus")])
        self.write_profiles([{"id": "mystery", "provider": "test", "kind": "unknown"}])
        self.create_events([
            {"model": "m", "input_tokens": 1_000_000, "ts": NOW - 1 * DAY},
        ], baseline_at=NOW - 40 * DAY)
        self.create_state(1_000_000)
        result = self.report()
        spending = self.section(result, "spending")
        by_label = {line["label"]: line["value"] for line in spending["lines"]}
        # The call is priced and classified, yet its arrangement is unknown:
        # a zero incremental subtotal is not a known zero.
        self.assertEqual(by_label["Extra cash (incremental) spending"], "—")
        self.assertTrue(any("matching cost rule" in note for note in spending["notes"]))
        # Metered value is unaffected: the catalogue priced the call.
        self.assertEqual(by_label["Metered usage value (all cost rules)"], "$2.00")

    def test_unknown_cash_basis_marks_a_positive_subtotal_a_lower_bound(self):
        billing = {"metered_usd": 5.0, "excluded_out_of_cycle": 0,
                   "unclassified_tokens": 0, "unclassified_calls": 0,
                   "evidence": {"incremental_cash": {"usd": 1.5, "basis": "unknown"},
                                "credits_consumed": {"usd": None}}}
        section = D._spending_section(D.STRINGS["en"], "Last 7 days", billing, True, 5)
        by_label = {line["label"]: line["value"] for line in section["lines"]}
        self.assertEqual(by_label["Extra cash (incremental) spending"], "≥$1.50")
        self.assertTrue(any("matching cost rule" in note for note in section["notes"]))

    def test_markdown_escapes_formatting_and_html_in_names(self):
        nasty = "a<b>*c_`d`[e]~f|g"
        self.write_store([account("test:default", "test", plan_id="test.plus")])
        self.write_profiles([])
        self.create_events([{"model": nasty, "input_tokens": 1_000_000}],
                           baseline_at=NOW - 40 * DAY)
        self.create_state(1_000_000)
        result = self.report()
        models = self.section(result, "models")
        # Sections keep the raw name for the React preview; the export escapes.
        self.assertIn(nasty, [row[0] for row in models["rows"]])
        self.assertIn(D._escape(nasty), result["markdown"])
        self.assertNotIn(nasty, result["markdown"])
        self.assertNotIn("<b>", result["markdown"])

    def test_zh_report_localises_the_new_caveats(self):
        self.standard_fixture()
        with closing(sqlite3.connect(self.events)) as conn, conn:
            conn.execute("INSERT INTO calls (event_id, ts, model, provider, outcome,"
                         " input_tokens, total_tokens, recorded_at)"
                         " VALUES ('unpriced', ?, 'zzz', 'test', 'ok', 500000, 500000, ?)",
                         (NOW - 2 * DAY, NOW - 2 * DAY))
        result = self.report(lang="zh")
        changes = self.section(result, "changes")
        self.assertTrue(any("定价" in note for note in changes["notes"]),
                        changes["notes"])
        spending = self.section(result, "spending")
        for note in spending["notes"]:
            self.assertRegex(note, r"[\u4e00-\u9fff]", note)


class DigestFeesCoverageTests(DigestCase):
    """The fees section respects coverage like every other usage section."""

    def test_fees_withhold_usage_when_window_unobserved(self):
        self.write_store([account("test:default", "test", plan_id="test.plus")])
        self.write_profiles([])
        self.create_events([], baseline_at=NOW - 2 * DAY)
        self.create_state(0)
        result = self.report()
        fees = self.section(result, "fees")
        by_label = {line["label"]: line["value"] for line in fees["lines"]}
        self.assertEqual(by_label["Estimated API value attributed to memberships"], "—")
        self.assertEqual(
            by_label["Estimated value comparison (API-equivalent minus fees)"], "—")
        # The declared fee is known independently of usage coverage.
        fee_line = next(line["value"] for line in fees["lines"] if "USD" in line["label"])
        self.assertNotEqual(fee_line, "—")
        summary = self.section(result, "report_coverage")
        self.assertTrue(any("usage cannot be stated" in note for note in summary["notes"]),
                        summary["notes"])

    def test_fees_keep_genuine_zero_when_covered_empty(self):
        self.write_store([account("test:default", "test", plan_id="test.plus")])
        self.write_profiles([])
        self.create_events([], baseline_at=NOW - 40 * DAY)
        self.create_state(0)
        result = self.report()
        fees = self.section(result, "fees")
        by_label = {line["label"]: line["value"] for line in fees["lines"]}
        self.assertEqual(by_label["Estimated API value attributed to memberships"], "$0.00")
        for value in by_label.values():
            self.assertNotIn("≥", value, value)
        self.assertTrue(any("No calls were recorded" in note for note in fees["notes"]))
        spending = self.section(result, "spending")
        provider_line = next(line for line in spending["lines"]
                             if line["label"] == "Provider-reported charges")
        self.assertEqual(provider_line["value"], "—")

    def test_report_keeps_known_monthly_fee_when_window_allocation_is_unavailable(self):
        plans = plans_doc(
            {"id": "test.unknown-history", "provider_family": "test", "name": "Test Plus",
             "price": {"amount": None, "currency": "USD", "period": "month"}},
        )
        self.write_store([account(
            "test:default", "test", plan_id="test.unknown-history",
            fee_overrides=[{"id": "current", "amount": 30.0, "currency": "USD",
                            "period": "month",
                            "effective_from": datetime.fromtimestamp(
                                NOW - 3 * DAY).strftime("%Y-%m-%dT%H:%M:%SZ")}])])
        self.write_profiles([])
        self.create_events([{"input_tokens": 1_000_000}], baseline_at=NOW - 40 * DAY)
        self.create_state(1_000_000)
        result = self.report(plans=plans)
        fees = self.section(result, "fees")
        by_label = {line["label"]: line["value"] for line in fees["lines"]}
        self.assertEqual(by_label["Known monthly fees (USD)"], "$30.00/mo")
        self.assertEqual(by_label["Fees in window (USD)"], "—")
        notes = " ".join(fees["notes"]).lower()
        self.assertIn("historical fee evidence", notes)
        self.assertNotIn("estimated effective date", notes)

    def test_fees_keep_each_currency_when_one_window_allocation_is_missing(self):
        headline = {
            "fees_monthly_by_currency": [
                {"currency": "GBP", "amount": 0.95},
                {"currency": "USD", "amount": 30.0},
            ],
            "fees_window_by_currency": [{"currency": "GBP", "amount": 0.22}],
            "usage_usd": None, "difference_usd": None, "status": "unavailable",
        }
        groups = [
            {"currency": "GBP", "fee_complete": True, "window_fee_complete": True},
            {"currency": "USD", "fee_complete": True, "window_fee_complete": False,
             "unallocated_window_accounts": ["usd-account"]},
        ]
        section = D._fees_section(D.STRINGS["en"], "Last 7 days", headline, True, 1,
                                  False, groups)
        by_label = {line["label"]: line["value"] for line in section["lines"]}
        self.assertEqual(by_label["Known monthly fees (GBP)"], "£0.95/mo")
        self.assertEqual(by_label["Fees in window (GBP)"], "£0.22")
        self.assertEqual(by_label["Known monthly fees (USD)"], "$30.00/mo")
        self.assertEqual(by_label["Fees in window (USD)"], "—")
        self.assertTrue(any("historical fee evidence" in note for note in section["notes"]))

    def test_fees_exact_when_fully_priced_and_covered(self):
        self.standard_fixture()
        result = self.report()
        fees = self.section(result, "fees")
        text = " ".join(f"{line['label']} {line['value']}" for line in fees["lines"])
        self.assertIn("Estimated API value attributed to memberships $5.00", text)
        self.assertNotIn("≥", text)

    def test_fees_lower_bound_when_attributed_scope_partly_priced(self):
        self.standard_fixture()
        with closing(sqlite3.connect(self.events)) as conn, conn:
            conn.execute("INSERT INTO calls (event_id, ts, model, provider, outcome,"
                         " input_tokens, total_tokens, recorded_at)"
                         " VALUES ('unpriced', ?, 'zzz', 'test', 'ok', 500000, 500000, ?)",
                         (NOW - 2 * DAY, NOW - 2 * DAY))
        result = self.report()
        fees = self.section(result, "fees")
        by_label = {line["label"]: line["value"] for line in fees["lines"]}
        self.assertEqual(by_label["Estimated API value attributed to memberships"], "≥$5.00")
        self.assertTrue(
            by_label["Estimated value comparison (API-equivalent minus fees)"].startswith("≥"),
            by_label)
        # The ≥ markers stay on the comparison lines, but their explanation
        # lives once in the coverage summary.
        summary = self.section(result, "report_coverage")
        self.assertTrue(any("lower bounds" in note.lower() for note in summary["notes"]),
                        summary["notes"])

    def test_fees_lower_bound_when_partly_observed(self):
        self.write_store([account("test:default", "test", plan_id="test.plus")])
        self.write_profiles([])
        self.create_events([{"input_tokens": 1_000_000}],
                           baseline_at=NOW - 2 * DAY)
        self.create_state(1_000_000)
        result = self.report()
        fees = self.section(result, "fees")
        by_label = {line["label"]: line["value"] for line in fees["lines"]}
        self.assertEqual(by_label["Estimated API value attributed to memberships"], "≥$2.00")
        # The bound comes from the recording gap, not missing prices: the
        # coverage summary states it, so the fees section stays silent.
        self.assertFalse(any("lower bound" in note.lower() for note in fees["notes"]),
                         fees["notes"])
        summary = self.section(result, "report_coverage")
        by_summary = {line["label"]: line["value"] for line in summary["lines"]}
        self.assertIn("Partial", by_summary["Window coverage"])

    def test_fees_bound_survives_rounded_coverage(self):
        self.write_store([account("test:default", "test", plan_id="test.plus")])
        self.write_profiles([])
        self.create_events([
            {"model": "m", "input_tokens": 3_000_000, "ts": NOW - 1 * DAY},
            {"model": "zzz", "input_tokens": 1, "ts": NOW - 2 * DAY},
        ], baseline_at=NOW - 40 * DAY)
        self.create_state(3_000_001)
        econ = economics.build_economics_report(
            days=7, trend_months=0, now=NOW, event_db_path=self.events,
            state_db_path=self.state, membership_path=self.memberships,
            plans=PLANS, profiles_path=self.profiles, catalogue=self.book)
        row = next(r for r in econ["accounts"] if r["account_id"] == "test:default")
        self.assertEqual(row["usage"]["coverage"], 1.0)
        self.assertEqual(row["usage"]["unpriced_tokens"], 1)
        self.assertEqual(row["status"], "partial")
        result = self.report()
        fees = self.section(result, "fees")
        by_label = {line["label"]: line["value"] for line in fees["lines"]}
        self.assertEqual(by_label["Estimated API value attributed to memberships"], "≥$6.00")

    def test_fees_unknown_is_localised(self):
        self.write_store([account("test:default", "test", plan_id="test.plus")])
        self.write_profiles([])
        self.create_events([], baseline_at=NOW - 2 * DAY)
        self.create_state(0)
        result = self.report(lang="zh")
        fees = self.section(result, "fees")
        by_label = {line["label"]: line["value"] for line in fees["lines"]}
        self.assertEqual(by_label["归因至会员的估计 API 价值"], "—")
        summary = self.section(result, "report_coverage")
        self.assertTrue(any("无法给出用量" in note for note in summary["notes"]),
                        summary["notes"])


class DigestCoverageSummaryTests(DigestCase):
    """WP21: window-wide caveats are stated once, up front."""

    def partial_fixture(self):
        """One priced call plus one zero-token call without price evidence,
        recorded after a baseline inside the window."""
        self.write_store([account("test:default", "test", plan_id="test.plus")])
        self.write_profiles([])
        self.create_events([
            {"model": "m", "input_tokens": 1_000_000, "ts": NOW - 1 * DAY},
            {"model": "zzz", "input_tokens": 0, "output_tokens": 0,
             "ts": NOW - 2 * DAY},
        ], baseline_at=NOW - 2 * DAY)
        self.create_state(1_000_000)

    def test_summary_leads_and_states_partial_coverage(self):
        self.partial_fixture()
        result = self.report()
        self.assertEqual(result["sections"][0]["id"], "report_coverage")
        summary = self.section(result, "report_coverage")
        self.assertEqual(summary["heading"], "Report coverage")
        by_label = {line["label"]: line["value"] for line in summary["lines"]}
        self.assertIn("Partial", by_label["Window coverage"])
        self.assertEqual(by_label["Recording since"], "2026-10-29")
        self.assertEqual(by_label["Unpriced tokens"], "0")
        expected = analytics.build_analytics_report(
            self.events, state_db_path=self.state, days=7, now=NOW,
            catalogue=self.book, profiles_path=self.profiles)
        unclassified = (expected.get("billing") or {}).get("unclassified_calls") or 0
        self.assertEqual(by_label["Unclassified calls"], str(unclassified))
        notes = " ".join(summary["notes"])
        self.assertIn("1 call(s) lack complete usage or price evidence", notes)
        self.assertIn("lower bounds", notes)
        self.assertIn("valuations", notes)
        self.assertIn("confirmed per-call records", notes)

    def test_window_wide_caveats_appear_once_in_markdown(self):
        self.partial_fixture()
        result = self.report()
        markdown = result["markdown"]
        self.assertEqual(markdown.count("recording started inside this window"), 1)
        self.assertEqual(markdown.count(
            "an unpriced token count of zero does not make their value zero"), 1)
        self.assertEqual(markdown.count(result["period"]["label"]), 1)
        # Sections covering something else keep their own window line.
        self.assertIn("Current allowance cycle", markdown)

    def test_complete_window_confirms_no_gaps(self):
        self.standard_fixture()
        result = self.report()
        summary = self.section(result, "report_coverage")
        by_label = {line["label"]: line["value"] for line in summary["lines"]}
        self.assertEqual(by_label["Window coverage"], "Complete")
        notes = " ".join(summary["notes"])
        self.assertIn("every recorded call is priced and classified", notes)
        self.assertNotIn("lower bounds", notes.lower())

    def test_unobserved_window_states_unknown_once(self):
        self.write_store([account("test:default", "test", plan_id="test.plus")])
        self.write_profiles([])
        self.create_events([], baseline_at=NOW - 2 * DAY)
        self.create_state(0)
        result = self.report()
        summary = self.section(result, "report_coverage")
        by_label = {line["label"]: line["value"] for line in summary["lines"]}
        self.assertEqual(by_label["Window coverage"],
                         D.STRINGS["en"]["coverage_unobserved"])
        self.assertEqual(by_label["Unpriced tokens"], "—")
        self.assertEqual(by_label["Unclassified calls"], "—")
        notes = " ".join(summary["notes"])
        self.assertIn("usage cannot be stated", notes)
        self.assertNotIn("lower bounds", notes.lower())

    def test_unclassified_calls_force_a_lower_bound_note(self):
        section = D._report_coverage_section(
            D.STRINGS["en"], "Last 7 days", covers=True, calls=3,
            totals={"unpriced_calls": 0, "unpriced_tokens": 0},
            billing={"unclassified_calls": 2, "unclassified_tokens": 0},
            recording_since=None)
        by_label = {line["label"]: line["value"] for line in section["lines"]}
        self.assertEqual(by_label["Window coverage"], "Complete")
        self.assertEqual(by_label["Unclassified calls"], "2")
        notes = " ".join(section["notes"])
        self.assertIn("lower bounds", notes)
        self.assertNotIn("priced and classified", notes)

    def test_summary_money_legend_in_both_languages(self):
        self.standard_fixture()
        for lang, estimated, confirmed in (
            ("en", "not cash charged", "saved declarations"),
            ("zh", "不是账单", "已保存的声明"),
        ):
            summary = self.section(self.report(lang=lang), "report_coverage")
            notes = " ".join(summary["notes"])
            self.assertIn(estimated, notes, lang)
            self.assertIn(confirmed, notes, lang)

    def test_string_parity_between_languages(self):
        self.assertEqual(set(D.STRINGS["en"]), set(D.STRINGS["zh"]))

    def test_mixed_usage_explains_lower_bounds_once(self):
        self.write_store([account("test:default", "test", plan_id="test.plus")])
        self.write_profiles([{"id": "cap", "provider": "test", "kind": "api",
                              "allowance_usd": 10.0, "billing_cycle": {"day": 1}}])
        self.create_events([
            {"model": "m", "input_tokens": 1_000_000, "ts": NOW - 1 * DAY},
            {"model": "zzz", "input_tokens": 500_000, "ts": NOW - 2 * DAY},
        ], baseline_at=NOW - 40 * DAY)
        self.create_state(1_500_000)
        result = self.report()
        markdown = result["markdown"]
        # The ≥ markers stay on the affected values, but the generic
        # explanation appears exactly once, in the coverage summary.
        self.assertIn("≥", markdown)
        self.assertEqual(markdown.count("lower bounds"), 1)
        self.assertNotIn("some usage is unpriced", markdown)
        for sid in ("usage", "models", "providers", "value", "spending", "fees"):
            notes = " ".join(self.section(result, sid)["notes"]).lower()
            self.assertNotIn("lower bound", notes, sid)

    def test_unknown_billing_kind_withholds_the_complete_claim(self):
        # Priced call, full recording coverage, but no matching cost rule:
        # the call lands in the unknown billing kind without raising the
        # unclassified counters.
        self.write_store([account("test:default", "test", plan_id="test.plus")])
        self.write_profiles([])
        self.create_events([{"model": "m", "input_tokens": 1_000_000}],
                           baseline_at=NOW - 40 * DAY)
        self.create_state(1_000_000)
        result = self.report()
        summary = self.section(result, "report_coverage")
        notes = " ".join(summary["notes"])
        self.assertIn("1 call(s) have no matching cost rule", notes)
        self.assertNotIn("priced and classified", notes)
        # No value shows ≥ here (extra cash reads unknown), so no ≥ legend.
        self.assertNotIn("lower bounds", notes.lower())

    def test_unknown_billing_arrangement_is_named_as_a_second_cause(self):
        # Priced call matching a profile whose arrangement itself is
        # unknown: a rule matched, so "no matching cost rule" alone would
        # misstate the cause.
        self.write_store([account("test:default", "test", plan_id="test.plus")])
        self.write_profiles([{"id": "mystery", "provider": "test",
                              "kind": "unknown"}])
        self.create_events([{"model": "m", "input_tokens": 1_000_000}],
                           baseline_at=NOW - 40 * DAY)
        self.create_state(1_000_000)
        result = self.report()
        summary = self.section(result, "report_coverage")
        notes = " ".join(summary["notes"])
        self.assertIn("1 call(s) have no matching cost rule or an unknown "
                      "billing arrangement", notes)
        self.assertNotIn("priced and classified", notes)
        zh = D._report_coverage_section(
            D.STRINGS["zh"], "最近 7 天", covers=True, calls=1,
            totals={"unpriced_calls": 0, "unpriced_tokens": 0},
            billing={"unclassified_calls": 0, "unclassified_tokens": 0,
                     "by_kind": {"unknown": {"calls": 1, "tokens": 10}},
                     "evidence": {"incremental_cash": {"usd": None,
                                                      "basis": "unknown"}}},
            recording_since=None)
        self.assertIn("计费方式未知", " ".join(zh["notes"]))

    def test_unknown_billing_kind_with_positive_cash_marks_a_bound(self):
        section = D._report_coverage_section(
            D.STRINGS["en"], "Last 7 days", covers=True, calls=3,
            totals={"unpriced_calls": 0, "unpriced_tokens": 0},
            billing={"unclassified_calls": 0, "unclassified_tokens": 0,
                     "by_kind": {"unknown": {"calls": 2, "tokens": 10}},
                     "evidence": {"incremental_cash": {"usd": 1.5,
                                                      "basis": "unknown"}}},
            recording_since=None)
        notes = " ".join(section["notes"])
        self.assertIn("2 call(s) have no matching cost rule", notes)
        self.assertIn("lower bounds", notes)
        self.assertNotIn("priced and classified", notes)

    def test_fees_section_reports_whether_subtotals_show_a_bound(self):
        headline = {
            "fees_monthly_by_currency": [{"currency": "USD", "amount": 20.0}],
            "fees_window_by_currency": [{"currency": "USD", "amount": 4.65}],
            "usage_usd": None, "difference_usd": None, "status": "unavailable",
        }
        groups = [{"currency": "USD", "fee_complete": False,
                   "window_fee_complete": True,
                   "unknown_fee_accounts": ["other"]}]
        section = D._fees_section(D.STRINGS["en"], "Last 7 days", headline,
                                 True, 1, False, groups)
        by_label = {line["label"]: line["value"] for line in section["lines"]}
        self.assertTrue(by_label["Known monthly fees (USD)"].startswith("≥"))
        self.assertTrue(section["fee_lower_bound"])
        complete = D._fees_section(
            D.STRINGS["en"], "Last 7 days", headline, True, 1, False,
            [{"currency": "USD", "fee_complete": True,
              "window_fee_complete": True}])
        self.assertFalse(complete["fee_lower_bound"])

    def test_fee_bound_gets_a_legend_despite_clean_usage(self):
        section = D._report_coverage_section(
            D.STRINGS["en"], "Last 7 days", covers=True, calls=3,
            totals={"unpriced_calls": 0, "unpriced_tokens": 0},
            billing={"unclassified_calls": 0, "unclassified_tokens": 0},
            recording_since=None, fee_lower_bound=True)
        notes = " ".join(section["notes"])
        self.assertIn("exclude unknown amounts", notes)
        self.assertNotIn("lower bounds", notes.lower())
        # The completeness claim is about recorded calls, which are clean.
        self.assertIn("priced and classified", notes)

    def test_clean_usage_with_unknown_fee_reports_both_states(self):
        plans = plans_doc(
            {"id": "test.plus", "provider_family": "test", "name": "Test Plus",
             "price": {"amount": 20.0, "currency": "USD", "period": "month"}},
            {"id": "test.mystery", "provider_family": "test", "name": "Mystery",
             "price": {"amount": None, "currency": "USD", "period": "month"}},
        )
        self.write_store([
            account("test:known", "test", plan_id="test.plus"),
            account("test:mystery", "test", plan_id="test.mystery"),
        ])
        self.write_profiles([{"id": "cap", "provider": "test", "kind": "api",
                              "allowance_usd": 10.0, "billing_cycle": {"day": 1}}])
        self.create_events([{"model": "m", "input_tokens": 1_000_000}],
                           baseline_at=NOW - 40 * DAY)
        self.create_state(1_000_000)
        result = self.report(plans=plans)
        fees = self.section(result, "fees")
        by_label = {line["label"]: line["value"] for line in fees["lines"]}
        self.assertTrue(by_label["Known monthly fees (USD)"].startswith("≥"))
        summary = self.section(result, "report_coverage")
        notes = " ".join(summary["notes"])
        self.assertIn("exclude unknown amounts", notes)
        self.assertIn("priced and classified", notes)

    def test_allowance_all_unknown_gets_a_single_lead_note(self):
        accounts = [
            {"account_id": "a", "label": "A", "cycle": {},
             "rollup": {"state": "unknown"},
             "windows": [{"verdict": "unknown", "verdict_basis": "none"}]},
            {"account_id": "b", "label": "B", "cycle": {},
             "rollup": {"state": "unknown"},
             "windows": [{"verdict": "unknown", "verdict_basis": "none"}]},
        ]
        section = D._allowances_section(D.STRINGS["en"], "cycle", accounts)
        notes = " ".join(section["notes"])
        self.assertIn("No usable allowance evidence is available for any of the 2 account(s)",
                      notes)
        # Notes lead the table in both Markdown and the preview when every
        # row is Unknown, so the explanation stays position-neutral.
        self.assertIn("in this table", notes)
        self.assertNotIn("below", notes)
        mixed = list(accounts) + [{"account_id": "c", "label": "C", "cycle": {},
                                   "rollup": {"state": "on_track"}, "windows": []}]
        mixed_notes = " ".join(D._allowances_section(
            D.STRINGS["en"], "cycle", mixed)["notes"])
        self.assertNotIn("No usable allowance evidence", mixed_notes)

    def test_coverage_section_keeps_attribution_without_recording_since(self):
        self.standard_fixture()
        result = self.report()
        coverage = self.section(result, "coverage")
        self.assertEqual(coverage["heading"], "Attribution and reconciliation")
        labels = [line["label"] for line in coverage["lines"]]
        self.assertNotIn("Recording since", labels)
        self.assertIn("Attributed tokens", labels)


class Wp21ReportsClarityTests(DigestCase):
    """WP21 Wave C: honest financial labels, caveats stated once, actionable
    allowances and compact history states. Figures are transmitted unchanged;
    only the words around them move."""

    def priced_fixture(self):
        """Two priced calls ($4.00) under a pay-as-you-go cost rule, with no
        billing-cycle scope so the calls stay inside spending whatever the
        wall clock says."""
        self.write_store([account("test:default", "test", plan_id="test.plus")])
        self.write_profiles([{"id": "payg", "provider": "test", "kind": "api"}])
        self.create_events([
            {"model": "m", "input_tokens": 1_000_000, "ts": NOW - 1 * DAY},
            {"model": "m", "input_tokens": 1_000_000, "ts": NOW - 3 * DAY},
        ], baseline_at=NOW - 40 * DAY)
        self.create_state(2_000_000)

    # -- F47: metered total vs membership-attributed value ----------------------

    def test_metered_total_names_all_cost_rules(self):
        self.priced_fixture()
        result = self.report()
        spending = self.section(result, "spending")
        by_label = {line["label"]: line["value"] for line in spending["lines"]}
        self.assertEqual(by_label["Metered usage value (all cost rules)"],
                         "$4.00")
        self.assertNotIn("Metered (allowance) spending", result["markdown"])

    def test_metered_total_spans_non_membership_kinds(self):
        # api, prepaid and custom cost rules all feed metered_usd, so the
        # total must never be presented as membership-attributed usage.
        self.write_store([account("test:default", "test", plan_id="test.plus")])
        self.write_profiles([
            {"id": "payg", "provider": "test", "model": "m", "kind": "api"},
            {"id": "wallet", "provider": "test", "model": "n",
             "kind": "prepaid"},
            {"id": "deal", "provider": "test", "model": "weird|model",
             "kind": "custom",
             "rate_override": {"input": 2.0, "output": 4.0}},
        ])
        self.create_events([
            {"model": "m", "input_tokens": 1_000_000, "ts": NOW - 1 * DAY},
            {"model": "n", "input_tokens": 1_000_000, "ts": NOW - 2 * DAY},
            {"model": "weird|model", "input_tokens": 1_000_000,
             "ts": NOW - 3 * DAY},
        ], baseline_at=NOW - 40 * DAY)
        self.create_state(3_000_000)
        result = self.report()
        spending = self.section(result, "spending")
        by_label = {line["label"]: line["value"] for line in spending["lines"]}
        self.assertEqual(by_label["Metered usage value (all cost rules)"],
                         "$6.00")

    def test_membership_value_comes_from_subscription_attribution(self):
        self.standard_fixture()
        result = self.report()
        fees = self.section(result, "fees")
        by_label = {line["label"]: line["value"] for line in fees["lines"]}
        # Same transmitted figure as before, under the owner-approved label.
        self.assertEqual(by_label["Estimated API value attributed to memberships"],
                         "$5.00")
        notes = " ".join(fees["notes"])
        self.assertIn("What this usage would cost at API rates", notes)
        self.assertIn("not a bill, and not cash saved", notes)
        self.assertIn("attributed to subscriptions by route", notes)
        self.assertIn("overage beyond included allowances is not split out",
                      notes)
        self.assertNotIn("Attributed usage value", result["markdown"])

    def test_membership_value_withheld_without_a_subscription(self):
        # Pay-as-you-go usage still meters, but nothing is membership-attributed.
        store_account = account("test:default", "test", plan_id=None)
        store_account["api_only"] = True
        self.write_store([store_account])
        self.write_profiles([{"id": "payg", "provider": "test", "kind": "api"}])
        self.create_events([{"model": "m", "input_tokens": 1_000_000}],
                           baseline_at=NOW - 40 * DAY)
        self.create_state(1_000_000)
        result = self.report()
        fees = self.section(result, "fees")
        by_label = {line["label"]: line["value"] for line in fees["lines"]}
        self.assertEqual(by_label["Estimated API value attributed to memberships"],
                         "—")
        spending = self.section(result, "spending")
        metered = {line["label"]: line["value"]
                   for line in spending["lines"]}
        self.assertEqual(metered["Metered usage value (all cost rules)"],
                         "$2.00")

    def test_membership_labels_in_chinese(self):
        self.standard_fixture()
        result = self.report(lang="zh")
        fees = self.section(result, "fees")
        by_label = {line["label"]: line["value"] for line in fees["lines"]}
        self.assertEqual(by_label["归因至会员的估计 API 价值"], "$5.00")
        spending = self.section(result, "spending")
        metered = {line["label"]: line["value"]
                   for line in spending["lines"]}
        self.assertIn("计量用量价值（全部费用规则）", metered)

    def test_legend_names_the_revised_metered_label(self):
        self.priced_fixture()
        result = self.report()
        summary = self.section(result, "report_coverage")
        notes = " ".join(summary["notes"])
        self.assertIn("metered usage value", notes)
        self.assertNotIn("allowance) spending", result["markdown"])

    # -- F43: each caveat is stated once -------------------------------------

    def test_value_section_keeps_no_theory_note(self):
        self.priced_fixture()
        result = self.report()
        self.assertEqual(result["markdown"].count("theoretical public price"),
                         0)
        self.assertEqual(result["markdown"].count("not invoices"), 1)

    def test_fees_section_keeps_no_declaration_note(self):
        self.priced_fixture()
        result = self.report()
        fees = self.section(result, "fees")
        self.assertNotIn("not confirmed payments", " ".join(fees["notes"]))
        self.assertEqual(result["markdown"].count("not confirmed payments"), 1)

    def test_spending_section_keeps_no_generic_basis_note(self):
        self.priced_fixture()
        result = self.report()
        self.assertEqual(result["markdown"].count(
            "figures follow your cost rules"), 0)

    def test_methodology_remains_the_complete_reference(self):
        self.priced_fixture()
        result = self.report()
        method = self.section(result, "methodology")
        notes = " ".join(method["notes"])
        self.assertIn("generated locally", notes)
        self.assertIn("trailing window", notes)
        self.assertIn("not what you paid", notes)
        self.assertIn("never zero", notes)

    # -- F46: actionable allowances ------------------------------------------

    def allowance_entry(self, aid, **kw):
        entry = {"account_id": aid, "label": aid, "cycle": {},
                 "rollup": {"state": "unknown"}, "windows": [], "rules": []}
        entry.update(kw)
        return entry

    def test_allowance_rows_carry_account_actions(self):
        accounts = [
            self.allowance_entry(
                "reading", windows=[{"verdict": "unknown",
                                      "verdict_basis": "none"}]),
            self.allowance_entry(
                "cycle", windows=[{"verdict": "unknown",
                                    "verdict_basis": "provider_only"}]),
            self.allowance_entry(
                "position", windows=[{"verdict": "unknown",
                                       "verdict_basis": "observed",
                                       "cycle_basis": "none"}]),
            self.allowance_entry(
                "conflict", windows=[{"verdict": "unknown",
                                       "verdict_basis": "conflicted"}]),
            self.allowance_entry(
                "prepaid", rules=[{"verdict": "unknown", "pool": "prepaid_spend",
                                    "verdict_basis": "none"}]),
            self.allowance_entry("bare"),
            self.allowance_entry(
                "limit", rules=[{"verdict": "unknown", "pool": "allowance_usd",
                                  "verdict_basis": "none"}]),
            self.allowance_entry(
                "other", rules=[{"verdict": "unknown", "pool": "allowance_usd",
                                  "verdict_basis": "mystery"}]),
            {"account_id": "known", "label": "known", "cycle": {},
             "rollup": {"state": "on_track"}, "windows": [], "rules": []},
        ]
        section = D._allowances_section(D.STRINGS["en"], "cycle", accounts)
        meta = {row["account_id"]: row for row in section["row_meta"]}
        self.assertEqual(
            [meta[aid]["link"] for aid in
             ("reading", "cycle", "position", "conflict", "prepaid", "bare",
              "limit", "other", "known")],
            ["memberships", None, None, "memberships", None, "settings",
             "settings", "memberships", None])
        for aid in ("reading", "cycle", "position", "conflict", "prepaid",
                    "bare", "limit", "other"):
            self.assertTrue(meta[aid]["why"], aid)
        self.assertIsNone(meta["known"]["why"])
        # Markdown rows stay plain portable text; actions ride alongside.
        self.assertEqual(len(section["rows"]), len(section["row_meta"]))

    def test_all_unknown_allowances_lead_with_the_explanation(self):
        accounts = [
            self.allowance_entry(
                "a", windows=[{"verdict": "unknown",
                                "verdict_basis": "none"}]),
            self.allowance_entry(
                "b", windows=[{"verdict": "unknown",
                                "verdict_basis": "none"}]),
        ]
        section = D._allowances_section(D.STRINGS["en"], "cycle", accounts)
        self.assertTrue(section["notes_first"])
        markdown = D._render_markdown("t", "period", "generated", [section])
        self.assertLess(markdown.index("every status in this table"),
                        markdown.index("| Account |"))
        mixed = list(accounts) + [{"account_id": "c", "label": "c", "cycle": {},
                                   "rollup": {"state": "on_track"},
                                   "windows": []}]
        self.assertFalse(D._allowances_section(
            D.STRINGS["en"], "cycle", mixed).get("notes_first", False))

    def test_unusable_limit_points_at_settings_rules(self):
        section = D._allowances_section(
            D.STRINGS["en"], "cycle",
            [self.allowance_entry(
                "limit", rules=[{"verdict": "unknown", "pool": "allowance_usd",
                                  "verdict_basis": "none"}])])
        notes = " ".join(section["notes"])
        self.assertIn("Settings", notes)
        self.assertNotIn("in Costs", notes)

    def test_no_reading_suggests_a_membership_mark(self):
        section = D._allowances_section(
            D.STRINGS["en"], "cycle",
            [self.allowance_entry(
                "reading", windows=[{"verdict": "unknown",
                                      "verdict_basis": "none"}])])
        notes = " ".join(section["notes"])
        self.assertIn("manual mark can be saved in Memberships", notes)

    def test_conflict_suggests_membership_resolution(self):
        section = D._allowances_section(
            D.STRINGS["en"], "cycle",
            [self.allowance_entry(
                "conflict", windows=[{"verdict": "unknown",
                                       "verdict_basis": "conflicted"}])])
        notes = " ".join(section["notes"])
        self.assertIn("Resolve it in Memberships", notes)

    def test_markdown_keeps_per_account_reasons_and_fixes(self):
        accounts = [
            self.allowance_entry(
                "reading", windows=[{"verdict": "unknown",
                                      "verdict_basis": "none"}]),
            self.allowance_entry(
                "limit", rules=[{"verdict": "unknown", "pool": "allowance_usd",
                                  "verdict_basis": "none"}]),
            self.allowance_entry(
                "prepaid", rules=[{"verdict": "unknown",
                                    "pool": "prepaid_spend",
                                    "verdict_basis": "none"}]),
            {"account_id": "known", "label": "known", "cycle": {},
             "rollup": {"state": "on_track"}, "windows": [], "rules": []},
        ]
        section = D._allowances_section(D.STRINGS["en"], "cycle", accounts)
        markdown = D._render_markdown("t", "period", "generated", [section])
        self.assertIn("| reading |", markdown)
        self.assertIn("Unknown — No provider reading or manual mark "
                      "(fix in Memberships)", markdown)
        self.assertIn("Unknown — Allowance limit unavailable or unusable "
                      "(fix in Settings → Advanced billing rules)", markdown)
        self.assertIn("Unknown — Prepaid top-ups are not tracked", markdown)
        self.assertNotIn("Prepaid top-ups are not tracked (fix", markdown)
        # The preview keeps the short shared rows; enrichment is export-only.
        self.assertEqual(section["rows"][0][-1], "Unknown")
        self.assertIn("On track", section["rows"][3][-1])
        zh = D._allowances_section(
            D.STRINGS["zh"], "cycle", accounts[:1])
        zh_markdown = D._render_markdown("t", "period", "generated", [zh])
        self.assertIn("未知 — 没有服务商读数或手动标记 (在“会员”中处理)",
                      zh_markdown)

    def test_provider_limitations_carry_no_fix(self):
        section = D._allowances_section(
            D.STRINGS["en"], "cycle",
            [self.allowance_entry(
                "cycle", windows=[{"verdict": "unknown",
                                    "verdict_basis": "provider_only"}]),
             self.allowance_entry(
                "prepaid", rules=[{"verdict": "unknown",
                                    "pool": "prepaid_spend",
                                    "verdict_basis": "none"}])])
        self.assertEqual([row["link"] for row in section["row_meta"]],
                         [None, None])
        notes = " ".join(section["notes"])
        self.assertNotIn("can be saved", notes)
        self.assertNotIn("Resolve it", notes)
        self.assertNotIn("Settings", notes)

    def test_allowance_guidance_in_chinese(self):
        section = D._allowances_section(
            D.STRINGS["zh"], "cycle",
            [self.allowance_entry(
                "reading", windows=[{"verdict": "unknown",
                                      "verdict_basis": "none"}])])
        meta = section["row_meta"][0]
        self.assertEqual(meta["link"], "memberships")
        self.assertIn("手动标记", meta["why"])
        notes = " ".join(section["notes"])
        self.assertIn("会员", notes)

    def test_billing_rule_notes_point_at_settings_rules(self):
        billing = {
            "metered_usd": 2.0, "excluded_out_of_cycle": 0,
            "unclassified_tokens": 0, "unclassified_calls": 2,
            "unclassified_missing_rule_calls": 1,
            "evidence": {
                "provider_reported": {"usd": None, "basis": "none", "calls": 0},
                "incremental_cash": {"usd": None, "basis": "unknown"},
                "credits_consumed": {"usd": None},
            },
        }
        for lang, pointer in (("en", "Settings → Advanced billing rules"),
                              ("zh", "设置 → 高级计费规则")):
            section = D._spending_section(D.STRINGS[lang], "window", billing,
                                          True, 2)
            notes = " ".join(section["notes"])
            self.assertIn(pointer, notes, lang)
            self.assertNotIn("in Costs", notes, lang)

    # -- F87: compact history states -----------------------------------------

    def test_insufficient_history_note_is_compact(self):
        section = D._changes_section(
            D.STRINGS["en"], "Last 7 days", 7,
            {"comparable": False, "reason": "insufficient_history"}, {})
        self.assertEqual(section["kind"], "notes")
        self.assertEqual(len(section["notes"]), 1)
        self.assertTrue(section["notes"][0].startswith(
            "Not enough earlier history to compare yet"))
        zh = D._changes_section(
            D.STRINGS["zh"], "最近 7 天", 7,
            {"comparable": False, "reason": "insufficient_history"}, {})
        self.assertTrue(zh["notes"][0].startswith("更早的历史记录不足"))


class Wp21FxAndConfidenceTests(DigestCase):
    """WP21 follow-up: FX conversion provenance (F106) and no-observed-use
    comparison qualifications (F107). Figures stay transmitted; the report
    states the conversion basis and refuses conclusive losses."""

    def write_fx(self, rates):
        path = self.dir / "fx-rates.json"
        path.write_text(json.dumps({"version": 1, "rates": rates}))
        return path

    def gbp_plans(self):
        return plans_doc(
            {"id": "test.plus", "provider_family": "test", "name": "Test Plus",
             "price": {"amount": 20.0, "currency": "USD", "period": "month"}},
            {"id": "other.plus", "provider_family": "other", "name": "Other Plus",
             "price": {"amount": 40.0, "currency": "GBP", "period": "month"}},
        )

    def two_provider_book(self):
        return Catalogue({"test": {"m": Rate(2, 4, .5, 3)},
                          "other": {"m": Rate(2, 4, .5, 3)}},
                         "fixture", "test", "", "1")

    # -- F106: FX conversion provenance -------------------------------------

    def test_mixed_currency_discloses_the_fx_basis(self):
        fx = self.write_fx([{"currency": "GBP", "usd_per_unit": 1.25,
                             "as_of": "2026-10-29", "source": "ECB"}])
        self.write_store([
            account("test:default", "test", plan_id="test.plus",
                    route_slugs=["test"]),
            account("other:default", "other", plan_id="other.plus",
                    route_slugs=["other"]),
        ])
        self.write_profiles([])
        self.create_events([
            {"provider": "test", "model": "m", "input_tokens": 1_000_000,
             "ts": NOW - 1 * DAY},
            {"provider": "other", "model": "m", "input_tokens": 1_000_000,
             "ts": NOW - 2 * DAY},
        ], baseline_at=NOW - 40 * DAY)
        self.create_state(2_000_000)
        result = self.report(plans=self.gbp_plans(), catalogue=self.two_provider_book(),
                             fx_file=fx)
        fees = self.section(result, "fees")
        notes = " ".join(fees["notes"])
        self.assertIn("Fees in GBP were converted at 1.25 USD per GBP, "
                      "dated 2026-10-29 (ECB).", notes)
        self.assertNotIn("USD were converted", notes)
        self.assertNotIn("predates this reporting window", notes)
        by_label = {line["label"]: line["value"] for line in fees["lines"]}
        self.assertNotEqual(
            by_label["Estimated value comparison (API-equivalent minus fees)"],
            "—")
        self.assertIn("dated 2026-10-29 (ECB)", result["markdown"])

    def test_stale_rate_warns_instead_of_silently_converting(self):
        fx = self.write_fx([{"currency": "GBP", "usd_per_unit": 1.25,
                             "as_of": "2026-09-01", "source": "ECB"}])
        self.write_store([account("other:default", "other",
                                  plan_id="other.plus",
                                  route_slugs=["other"])])
        self.write_profiles([])
        self.create_events([
            {"provider": "other", "model": "m", "input_tokens": 1_000_000,
             "ts": NOW - 1 * DAY},
        ], baseline_at=NOW - 40 * DAY)
        self.create_state(1_000_000)
        result = self.report(plans=self.gbp_plans(), catalogue=self.two_provider_book(),
                             fx_file=fx)
        notes = " ".join(self.section(result, "fees")["notes"])
        self.assertIn("dated 2026-09-01 (ECB)", notes)
        self.assertIn("The GBP rate above predates this reporting window; "
                      "updating it would change the comparison.", notes)

    def test_missing_rate_withholds_the_comparison(self):
        self.write_store([account("other:default", "other",
                                  plan_id="other.plus",
                                  route_slugs=["other"])])
        self.write_profiles([])
        self.create_events([
            {"provider": "other", "model": "m", "input_tokens": 1_000_000,
             "ts": NOW - 1 * DAY},
        ], baseline_at=NOW - 40 * DAY)
        self.create_state(1_000_000)
        result = self.report(plans=self.gbp_plans(), catalogue=self.two_provider_book())
        fees = self.section(result, "fees")
        by_label = {line["label"]: line["value"] for line in fees["lines"]}
        self.assertEqual(
            by_label["Estimated value comparison (API-equivalent minus fees)"],
            "—")
        self.assertNotIn("were converted",
                         " ".join(fees["notes"]))

    def test_fx_disclosure_in_chinese(self):
        fx = self.write_fx([{"currency": "GBP", "usd_per_unit": 1.25,
                             "as_of": "2026-09-01", "source": "ECB"}])
        self.write_store([account("other:default", "other",
                                  plan_id="other.plus",
                                  route_slugs=["other"])])
        self.write_profiles([])
        self.create_events([
            {"provider": "other", "model": "m", "input_tokens": 1_000_000,
             "ts": NOW - 1 * DAY},
        ], baseline_at=NOW - 40 * DAY)
        self.create_state(1_000_000)
        result = self.report(plans=self.gbp_plans(), catalogue=self.two_provider_book(),
                             fx_file=fx, lang="zh")
        notes = " ".join(self.section(result, "fees")["notes"])
        self.assertIn("GBP 费用按每 GBP 1.25 美元折算，日期为 2026-09-01"
                      "（来源：ECB）。", notes)
        self.assertIn("GBP 汇率早于本报告周期；更新汇率会改变对比结果。",
                      notes)

    def test_unparsable_rate_date_discloses_without_warning(self):
        headline = {
            "fees_monthly_by_currency": [{"currency": "GBP", "amount": 40.0}],
            "fees_window_by_currency": [{"currency": "GBP", "amount": 9.33}],
            "usage_usd": 2.0, "difference_usd": -9.0, "status": "ok",
        }
        groups = [{"currency": "GBP", "fee_complete": True,
                   "window_fee_complete": True, "converted": True,
                   "fx": {"currency": "GBP", "usd_per_unit": 1.25,
                          "as_of": "not-a-date", "source": "ECB"}}]
        section = D._fees_section(D.STRINGS["en"], "Last 7 days", headline,
                                 True, 1, False, groups)
        notes = " ".join(section["notes"])
        self.assertIn("dated not-a-date (ECB)", notes)
        self.assertNotIn("predates this reporting window", notes)

    # -- F107: no-observed-use qualifications -------------------------------

    def test_complete_zero_use_scopes_the_estimate(self):
        self.write_store([account("test:default", "test", plan_id="test.plus")])
        self.write_profiles([])
        self.create_events([], baseline_at=NOW - 40 * DAY)
        self.create_state(0)
        result = self.report()
        fees = self.section(result, "fees")
        notes = " ".join(fees["notes"])
        self.assertIn("Account test:default: no usage was attributed to this account in the "
                      "fully observed window", notes)
        self.assertIn("not a confirmed loss", notes)
        by_label = {line["label"]: line["value"] for line in fees["lines"]}
        self.assertEqual(by_label["Known monthly fees (USD)"], "$20.00/mo")
        self.assertTrue(
            by_label["Estimated value comparison (API-equivalent minus fees)"]
            .startswith("-$"))
        self.assertIn("fully observed window", result["markdown"])

    def test_partial_zero_use_stays_conditional(self):
        self.write_store([account("test:default", "test", plan_id="test.plus")])
        self.write_profiles([])
        self.create_events([], baseline_at=NOW - 2 * DAY)
        self.create_state(0)
        result = self.report()
        notes = " ".join(self.section(result, "fees")["notes"])
        self.assertIn("Account test:default: no usage was attributed to this account, but "
                      "recording does not cover the full window", notes)
        self.assertIn("may be unrecorded rather than unused", notes)
        self.assertIn("treat the comparison as conditional", notes)

    def test_zero_use_note_names_only_the_unused_account(self):
        self.write_store([
            account("test:used", "test", plan_id="test.plus",
                    route_slugs=["test"]),
            account("other:idle", "other", plan_id="other.plus",
                    route_slugs=["other"]),
        ])
        self.write_profiles([])
        self.create_events([
            {"provider": "test", "model": "m", "input_tokens": 1_000_000,
             "ts": NOW - 1 * DAY},
        ], baseline_at=NOW - 40 * DAY)
        self.create_state(1_000_000)
        result = self.report(plans=self.gbp_plans(), catalogue=self.two_provider_book())
        notes = " ".join(self.section(result, "fees")["notes"])
        self.assertIn("Account other:idle: no usage was attributed", notes)
        self.assertNotIn("Account test:used: no usage", notes)

    def test_ambiguous_route_zero_use_names_attribution(self):
        # Both accounts claim the same route, so its recorded usage is
        # attributed to nobody: each account observes zero calls.
        self.write_store([
            account("test:a", "test", plan_id="test.plus",
                    route_slugs=["test"]),
            account("test:b", "test", plan_id="test.plus",
                    route_slugs=["test"]),
        ])
        self.write_profiles([])
        self.create_events([
            {"provider": "test", "model": "m", "input_tokens": 1_000_000,
             "ts": NOW - 1 * DAY},
        ], baseline_at=NOW - 40 * DAY)
        self.create_state(1_000_000)
        result = self.report()
        fees_notes = " ".join(self.section(result, "fees")["notes"])
        self.assertIn("Account test:a: no usage was attributed to this "
                      "account", fees_notes)
        self.assertIn("Account test:b: no usage was attributed to this "
                      "account", fees_notes)
        coverage_notes = " ".join(self.section(result, "coverage")["notes"])
        self.assertIn("claimed by more than one account", coverage_notes)

    def test_unknown_fee_zero_use_carries_no_charge_note(self):
        plans = plans_doc(
            {"id": "test.mystery", "provider_family": "test",
             "name": "Mystery",
             "price": {"amount": None, "currency": "USD",
                       "period": "month"}},
        )
        self.write_store([account("test:mystery", "test",
                                  plan_id="test.mystery")])
        self.write_profiles([])
        self.create_events([], baseline_at=NOW - 40 * DAY)
        self.create_state(0)
        result = self.report(plans=plans)
        notes = " ".join(self.section(result, "fees")["notes"])
        self.assertNotIn("Account test:mystery: no usage", notes)
        self.assertIn("fee(s) are unknown", notes)

    def test_theoretical_zero_use_qualifies_the_export(self):
        # F116: a paid zero-use account with unattributed usage elsewhere
        # keeps its figures but the export withholds a value verdict.
        self.write_store([account("test:default", "test", plan_id="test.plus")])
        self.write_profiles([])
        self.create_events([
            {"input_tokens": 10, "ts": NOW - 40 * DAY},
            {"provider": "mystery", "model": "m", "input_tokens": 500_000,
             "ts": NOW - 3 * DAY},
        ], baseline_at=NOW - 40 * DAY)
        self.create_state(0)
        result = self.report()
        notes = " ".join(self.section(result, "fees")["notes"])
        self.assertIn("treat the comparison as theoretical on observed usage",
                      notes)
        self.assertIn("theoretical", result["markdown"])

    def test_aged_fx_rate_qualifies_the_export(self):
        # F117: an over-30-day rate still converts, but the export marks
        # the converted comparison indicative.
        fx = self.write_fx([{"currency": "GBP", "usd_per_unit": 1.25,
                             "as_of": "2026-09-01",
                             "source": "Bank of England spot"}])
        self.write_store([
            account("test:default", "test", plan_id="test.plus",
                    route_slugs=["test"]),
            account("other:default", "other", plan_id="other.plus",
                    route_slugs=["other"]),
        ])
        self.write_profiles([])
        self.create_events([
            {"provider": "test", "model": "m", "input_tokens": 10,
             "ts": NOW - 40 * DAY},
            {"provider": "test", "model": "m", "input_tokens": 1_000_000,
             "ts": NOW - 1 * DAY},
            {"provider": "other", "model": "m", "input_tokens": 1_000_000,
             "ts": NOW - 2 * DAY},
        ], baseline_at=NOW - 40 * DAY)
        self.create_state(2_000_000)
        result = self.report(plans=self.gbp_plans(),
                             catalogue=self.two_provider_book(), fx_file=fx)
        notes = " ".join(self.section(result, "fees")["notes"])
        self.assertIn("treat the converted comparison as indicative", notes)

    def test_partial_report_keeps_the_aged_fx_warning(self):
        # F117: a partial report with an aged rate carries both the generic
        # approximate note and the specific indicative warning.
        fx = self.write_fx([{"currency": "GBP", "usd_per_unit": 1.25,
                             "as_of": "2026-09-01",
                             "source": "Bank of England spot"}])
        self.write_store([
            account("test:default", "test", plan_id="test.plus",
                    route_slugs=["test"]),
            account("other:default", "other", plan_id="other.plus",
                    route_slugs=["other"]),
        ])
        self.write_profiles([])
        self.create_events([
            {"provider": "test", "model": "m", "input_tokens": 1_000_000,
             "ts": NOW - 1 * DAY},
            {"provider": "other", "model": "m", "input_tokens": 1_000_000,
             "ts": NOW - 2 * DAY},
        ], baseline_at=NOW - 40 * DAY)
        self.create_state(2_000_000)
        result = self.report(plans=self.gbp_plans(),
                             catalogue=self.two_provider_book(), fx_file=fx)
        notes = " ".join(self.section(result, "fees")["notes"])
        self.assertIn("treat the comparison as approximate", notes)
        self.assertIn("treat the converted comparison as indicative", notes)

    def test_zero_use_notes_in_chinese(self):
        self.write_store([account("test:default", "test", plan_id="test.plus")])
        self.write_profiles([])
        self.create_events([], baseline_at=NOW - 40 * DAY)
        self.create_state(0)
        result = self.report(lang="zh")
        notes = " ".join(self.section(result, "fees")["notes"])
        self.assertIn("test:default", notes)
        self.assertIn("完整覆盖的周期内没有用量归因至本账号", notes)
        self.assertIn("并非已确认的损失", notes)

    # -- Unallocatable window fees -----------------------------------------

    def revised_fee_plans(self):
        return plans_doc(
            {"id": "test.rev", "provider_family": "test", "name": "Rev",
             "price": {"amount": None, "currency": "USD",
                       "period": "month"}},
        )

    def revised_fee_account(self):
        return account(
            "test:rev", "test", plan_id="test.rev",
            fee_overrides=[{
                "id": "current", "amount": 30.0, "currency": "USD",
                "period": "month",
                "effective_from": datetime.fromtimestamp(
                    NOW - 3 * DAY).strftime("%Y-%m-%dT%H:%M:%SZ")}])

    def test_unallocated_window_fee_explains_missing_history(self):
        self.write_store([self.revised_fee_account()])
        self.write_profiles([])
        self.create_events([], baseline_at=NOW - 40 * DAY)
        self.create_state(0)
        result = self.report(plans=self.revised_fee_plans())
        fees = self.section(result, "fees")
        notes = " ".join(fees["notes"])
        self.assertIn("Account test:rev: no usage was attributed to this account in the "
                      "fully observed window", notes)
        self.assertIn("Its $30.00/mo fee is known but cannot be allocated "
                      "to this window because historical fee evidence is "
                      "missing", notes)
        self.assertIn("it enters neither the window fee total nor the "
                      "comparison", notes)
        self.assertNotIn("counts against $0 observed value", notes)
        by_label = {line["label"]: line["value"] for line in fees["lines"]}
        self.assertEqual(by_label["Known monthly fees (USD)"], "$30.00/mo")
        self.assertEqual(by_label["Fees in window (USD)"], "—")
        self.assertIn("cannot be allocated to this window", result["markdown"])

    def test_unallocated_window_fee_stays_conditional_when_partial(self):
        self.write_store([self.revised_fee_account()])
        self.write_profiles([])
        self.create_events([], baseline_at=NOW - 2 * DAY)
        self.create_state(0)
        result = self.report(plans=self.revised_fee_plans())
        notes = " ".join(self.section(result, "fees")["notes"])
        self.assertIn("may be unrecorded rather than unused", notes)
        self.assertIn("Its $30.00/mo fee is known but cannot be allocated "
                      "to this window", notes)
        self.assertNotIn("counts against $0 observed value", notes)

    def test_unallocated_window_fee_in_chinese(self):
        self.write_store([self.revised_fee_account()])
        self.write_profiles([])
        self.create_events([], baseline_at=NOW - 40 * DAY)
        self.create_state(0)
        result = self.report(plans=self.revised_fee_plans(), lang="zh")
        notes = " ".join(self.section(result, "fees")["notes"])
        self.assertIn("其 $30.00/mo 费用已知，但因历史费用证据缺失而无法分配"
                      "至本周期", notes)
        self.assertIn("既不计入周期费用小计，也不进入对比", notes)

    def test_allocated_window_fee_keeps_the_counted_against_note(self):
        self.write_store([account("test:default", "test", plan_id="test.plus")])
        self.write_profiles([])
        self.create_events([], baseline_at=NOW - 40 * DAY)
        self.create_state(0)
        result = self.report()
        notes = " ".join(self.section(result, "fees")["notes"])
        self.assertIn("counts against $0 observed value", notes)
        self.assertIn("contributing -$", notes)
        self.assertNotIn("cannot be allocated to this window", notes)
        section = D._changes_section(
            D.STRINGS["en"], "Last 7 days", 7,
            {"comparable": False, "reason": "insufficient_history"}, {})
        self.assertEqual(section["kind"], "notes")
        self.assertEqual(len(section["notes"]), 1)
        self.assertTrue(section["notes"][0].startswith(
            "Not enough earlier history to compare yet"))
        zh = D._changes_section(
            D.STRINGS["zh"], "最近 7 天", 7,
            {"comparable": False, "reason": "insufficient_history"}, {})
        self.assertTrue(zh["notes"][0].startswith("更早的历史记录不足"))


if __name__ == "__main__":
    unittest.main()
