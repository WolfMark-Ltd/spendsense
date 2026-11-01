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
        self.assertIn("Spend Sense", result["title"])
        self.assertIn("7", result["period"]["label"])
        self.assertRegex(result["filename"], r"^spend-sense-digest-2026-10-31-7d-en\.md$")
        self.assertFalse(result["empty"])
        self.assertEqual([s["id"] for s in result["sections"]],
                         ["usage", "models", "providers", "value", "spending",
                          "fees", "allowances", "changes", "coverage", "methodology"])
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
        self.assertIn("Current cycle", allowance_window)
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
        self.assertNotIn("changes", [s["id"] for s in result["sections"]])

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
        self.assertTrue(any("incomplete" in note.lower() for note in usage["notes"]))

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
        self.assertTrue(any("partial" in note.lower() for note in usage["notes"]))

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


class DigestLocalisationTests(DigestCase):
    def test_zh_report_carries_the_same_figures(self):
        self.standard_fixture()
        result = self.report(lang="zh")
        self.assertEqual(result["lang"], "zh")
        self.assertRegex(result["filename"], r"-zh\.md$")
        self.assertRegex(result["title"], r"[\u4e00-\u9fff]")
        for section in result["sections"]:
            self.assertRegex(section["heading"], r"[\u4e00-\u9fff]", section["id"])
        self.assertIn("$5.00", result["markdown"])
        self.assertIn("test:default", result["markdown"])

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
        for sid in ("models", "providers"):
            notes = " ".join(self.section(result, sid)["notes"])
            self.assertIn("incomplete", notes.lower(), sid)
            self.assertNotIn("No ", notes, sid)

    def test_covered_empty_window_keeps_genuine_spending_zero(self):
        self.write_store([account("test:default", "test", plan_id="test.plus")])
        self.write_profiles([])
        self.create_events([], baseline_at=NOW - 40 * DAY)
        self.create_state(0)
        result = self.report()
        spending = self.section(result, "spending")
        values = self.values_text(spending)
        self.assertNotIn("—", values)
        self.assertIn("$0.00", values)

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
        self.assertEqual(by_label["Metered (allowance) spending"], "≥$2.00")
        # One call has no price at all: extra cash is unknown, never $0.00.
        self.assertEqual(by_label["Extra cash (incremental) spending"], "—")
        self.assertIn("Unvalued usage", by_label)
        notes = " ".join(spending["notes"])
        self.assertIn("lower bound", notes.lower())

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
        self.assertEqual(by_label["Metered (allowance) spending"], "$2.00")

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


if __name__ == "__main__":
    unittest.main()
