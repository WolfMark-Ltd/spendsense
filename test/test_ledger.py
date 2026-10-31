"""Tests for the read-only ledger backend.

Run with either interpreter:

    python3 -m unittest discover -s test -p 'test_*.py' -v

The fixture builds a tiny but schema-real state.db, so the SQL path is
exercised, not mocked.
"""

from __future__ import annotations

import sqlite3
import tempfile
import time
import unittest
from pathlib import Path

from wolfmark_ledger.aggregate import build_report
from wolfmark_ledger.pricing import Catalogue, Rate, Tier, load_catalogue


def _rate(inp: float, out: float, cache: float | None = None,
          cache_write: float | None = None, tiers: tuple[Tier, ...] = ()) -> Rate:
    return Rate(input=inp, output=out, cache_read=cache, cache_write=cache_write, tiers=tiers)


CATALOGUE = Catalogue(
    providers={
        "commandcode": {
            "deepseek/deepseek-v4.1-flash": _rate(0.15, 0.60, 0.003),
        },
        "xai": {
            "grok-4.7": _rate(2.0, 6.0, 0.5, tiers=(Tier(200_000, 4.0, 12.0, 1.0),)),
        },
        "openai": {
            "gpt-6.1-sol": _rate(2.0, 10.0, 0.1, 2.5,
                                 tiers=(Tier(272_000, 4.0, 15.0, 0.2, 5.0),)),
            "gpt-6-luna": _rate(0.1, 0.5, 0.01),
        },
    },
    source="fixture",
    confidence="bundled",
    as_of="2026-10-29T00:00:00+00:00",
    version="fixture",
)


class LedgerTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.db = Path(self.tmp.name) / "state.db"
        conn = sqlite3.connect(self.db)
        conn.executescript(
            """
            CREATE TABLE sessions (
                id TEXT PRIMARY KEY,
                source TEXT,
                title TEXT,
                started_at REAL,
                profile_name TEXT
            );
            CREATE TABLE session_model_usage (
                session_id TEXT NOT NULL,
                model TEXT NOT NULL,
                billing_provider TEXT NOT NULL DEFAULT '',
                billing_base_url TEXT NOT NULL DEFAULT '',
                billing_mode TEXT NOT NULL DEFAULT '',
                task TEXT NOT NULL DEFAULT '',
                api_call_count INTEGER NOT NULL DEFAULT 0,
                input_tokens INTEGER NOT NULL DEFAULT 0,
                output_tokens INTEGER NOT NULL DEFAULT 0,
                cache_read_tokens INTEGER NOT NULL DEFAULT 0,
                cache_write_tokens INTEGER NOT NULL DEFAULT 0,
                reasoning_tokens INTEGER NOT NULL DEFAULT 0,
                estimated_cost_usd REAL NOT NULL DEFAULT 0,
                actual_cost_usd REAL NOT NULL DEFAULT 0,
                cost_status TEXT,
                cost_source TEXT,
                first_seen REAL,
                last_seen REAL,
                PRIMARY KEY (session_id, model, billing_provider, billing_base_url, billing_mode, task)
            );
            """
        )
        self.now = time.time()
        conn.execute(
            "INSERT INTO sessions(id, source, title, started_at, profile_name) VALUES (?,?,?,?,?)",
            ("s1", "desktop", "A session", self.now - 600, "default"),
        )
        conn.execute(
            "INSERT INTO sessions(id, source, title, started_at, profile_name) VALUES (?,?,?,?,?)",
            ("s2", "cron", "Nightly", self.now - 900, "default"),
        )
        conn.commit()
        conn.close()

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def insert(self, **kw) -> None:
        row = {
            "session_id": "s1",
            "model": "deepseek/deepseek-v4.1-flash",
            "billing_provider": "commandcode",
            "billing_base_url": "",
            "billing_mode": "chat_completions",
            "task": "",
            "api_call_count": 1,
            "input_tokens": 0,
            "output_tokens": 0,
            "cache_read_tokens": 0,
            "cache_write_tokens": 0,
            "reasoning_tokens": 0,
            "estimated_cost_usd": 0.0,
            "actual_cost_usd": 0.0,
            "cost_status": "unknown",
            "cost_source": "none",
            "first_seen": self.now - 600,
            "last_seen": self.now - 300,
        }
        row.update(kw)
        conn = sqlite3.connect(self.db)
        conn.execute(
            "INSERT OR REPLACE INTO session_model_usage VALUES "
            "(:session_id,:model,:billing_provider,:billing_base_url,:billing_mode,:task,"
            ":api_call_count,:input_tokens,:output_tokens,:cache_read_tokens,:cache_write_tokens,"
            ":reasoning_tokens,:estimated_cost_usd,:actual_cost_usd,:cost_status,:cost_source,"
            ":first_seen,:last_seen)",
            row,
        )
        conn.commit()
        conn.close()

    def report(self, days: int = 30, basis: str = "hybrid"):
        return build_report(self.db, days=days, basis=basis, now=self.now, catalogue=CATALOGUE)


class PricingResolutionTests(LedgerTestCase):
    def test_route_aliases_are_explicit(self):
        self.assertIsNotNone(CATALOGUE.lookup("xai-oauth", "grok-4.7"))
        self.assertIsNotNone(CATALOGUE.lookup("openai-codex", "gpt-6.1-sol"))
        self.assertIsNotNone(CATALOGUE.lookup("codex", "gpt-6-luna"))
        self.assertIsNotNone(CATALOGUE.lookup("commandcode", "deepseek/deepseek-v4.1-flash"))

    def test_unknown_provider_is_not_priced_from_another_catalogue(self):
        # The model exists under openai, but the route is unknown. It must stay
        # unpriced rather than borrow OpenAI's card.
        self.assertIsNone(CATALOGUE.lookup("mystery", "gpt-6.1-sol"))

    def test_unknown_model_is_unpriced(self):
        self.assertIsNone(CATALOGUE.lookup("commandcode", "not-a-model"))

    def test_route_does_not_borrow_for_a_missing_model(self):
        # commandcode exists; gpt-6.1-sol exists under openai. No borrowing.
        self.assertIsNone(CATALOGUE.lookup("commandcode", "gpt-6.1-sol"))


class CostArithmeticTests(LedgerTestCase):
    def test_commandcode_uses_its_own_rate_not_openrouter(self):
        self.insert(input_tokens=1_000_000, cache_read_tokens=1_000_000,
                    output_tokens=1_000_000, api_call_count=10)
        report = self.report()
        route = next(r for r in report["by_route"] if r["name"] == "commandcode")
        # 0.15 + 0.003 + 0.60 = 0.753 (not OpenRouter's 0.30/0.006/1.20)
        self.assertAlmostEqual(route["list_usd"], 0.753, places=6)
        self.assertEqual(route["tier_possible_tokens"], 0)

    def test_tier_gives_a_lower_bound_and_upper_bound(self):
        self.insert(session_id="s2", billing_provider="xai-oauth", model="grok-4.7",
                    input_tokens=1_000_000, cache_read_tokens=1_000_000,
                    output_tokens=1_000_000, api_call_count=1)
        report = self.report()
        route = next(r for r in report["by_route"] if r["name"] == "xai-oauth")
        self.assertAlmostEqual(route["list_usd"], 8.5, places=6)
        self.assertAlmostEqual(route["list_usd_upper"], 17.0, places=6)
        self.assertGreater(route["tier_possible_tokens"], 0)

    def test_missing_call_count_does_not_apply_a_tier(self):
        self.insert(session_id="s2", billing_provider="xai-oauth", model="grok-4.7",
                    input_tokens=1_000_000, cache_read_tokens=1_000_000,
                    output_tokens=1_000_000, api_call_count=0)
        report = self.report()
        route = next(r for r in report["by_route"] if r["name"] == "xai-oauth")
        self.assertAlmostEqual(route["list_usd"], 8.5, places=6)
        self.assertEqual(route["list_usd_upper"], route["list_usd"])
        self.assertEqual(route["tier_possible_tokens"], 0)

    def test_cache_write_uses_catalogue_rate_when_present(self):
        self.insert(billing_provider="openai-codex", model="gpt-6.1-sol",
                    cache_write_tokens=1_000_000, api_call_count=10)
        report = self.report()
        route = next(r for r in report["by_route"] if r["name"] == "openai-codex")
        self.assertAlmostEqual(route["list_usd"], 2.5, places=6)

    def test_cache_write_defaults_to_input_and_is_flagged(self):
        self.insert(billing_provider="commandcode", model="deepseek/deepseek-v4.1-flash",
                    cache_write_tokens=1_000_000, api_call_count=10)
        report = self.report()
        route = next(r for r in report["by_route"] if r["name"] == "commandcode")
        self.assertAlmostEqual(route["list_usd"], 0.15, places=6)
        self.assertTrue(route["status"] in ("complete", "partial"))


class BasisAndBilledTests(LedgerTestCase):
    def test_included_subscription_is_zero_billed_but_list_valued(self):
        self.insert(billing_provider="openai-codex", model="gpt-6.1-sol",
                    input_tokens=1_000_000, cache_read_tokens=1_000_000,
                    output_tokens=1_000_000, api_call_count=10,
                    cost_status="included", estimated_cost_usd=0.0, actual_cost_usd=0.0)
        report = self.report()
        route = next(r for r in report["by_route"] if r["name"] == "openai-codex")
        self.assertEqual(route["billed_usd"], 0.0)
        self.assertAlmostEqual(route["list_usd"], 12.1, places=6)
        self.assertAlmostEqual(route["basis_usd"], 12.1, places=6)
        self.assertEqual(route["billing_mix"]["included"], 1)
        self.assertEqual(route["basis_mix"]["list"], 1)

    def test_actual_charge_wins_in_hybrid(self):
        self.insert(billing_provider="commandcode", model="deepseek/deepseek-v4.1-flash",
                    input_tokens=1_000_000, api_call_count=10,
                    cost_status="actual", actual_cost_usd=0.5)
        report = self.report()
        route = next(r for r in report["by_route"] if r["name"] == "commandcode")
        self.assertEqual(route["billed_usd"], 0.5)
        self.assertAlmostEqual(route["list_usd"], 0.15, places=6)
        self.assertEqual(route["basis_usd"], 0.5)

    def test_billed_mode_keeps_unknown_as_unknown(self):
        self.insert(input_tokens=1_000_000, api_call_count=10)
        report = self.report(basis="billed")
        route = next(r for r in report["by_route"] if r["name"] == "commandcode")
        self.assertIsNone(route["billed_usd"])
        self.assertIsNone(route["basis_usd"])
        self.assertEqual(route["basis_mix"]["unknown"], 1)

    def test_list_mode_ignores_a_recorded_charge(self):
        self.insert(billing_provider="commandcode", model="deepseek/deepseek-v4.1-flash",
                    input_tokens=1_000_000, api_call_count=10,
                    cost_status="actual", actual_cost_usd=99.0)
        report = self.report(basis="list")
        route = next(r for r in report["by_route"] if r["name"] == "commandcode")
        self.assertAlmostEqual(route["basis_usd"], 0.15, places=6)


class AggregationTests(LedgerTestCase):
    def test_no_double_count_and_group_totals_reconcile(self):
        self.insert(input_tokens=1_000_000, cache_read_tokens=1_000_000,
                    output_tokens=1_000_000, api_call_count=10)
        self.insert(session_id="s2", billing_provider="openai-codex", model="gpt-6.1-sol",
                    task="background_review", input_tokens=2_000_000, output_tokens=100_000,
                    cost_status="included", api_call_count=10)
        report = self.report()
        totals = report["totals"]
        for key in ("by_route", "by_model", "by_task", "by_surface"):
            self.assertAlmostEqual(
                sum((r["basis_usd"] or 0) for r in report[key]), totals["basis_usd"], places=6
            )
        # Tokens equal the raw SQL sum: one row accounted once.
        conn = sqlite3.connect(self.db)
        sql_tokens = conn.execute(
            "SELECT SUM(input_tokens+cache_read_tokens+cache_write_tokens+output_tokens) "
            "FROM session_model_usage"
        ).fetchone()[0]
        conn.close()
        self.assertEqual(totals["tokens"], sql_tokens)

    def test_auxiliary_task_is_included(self):
        self.insert(session_id="s2", billing_provider="openai-codex", model="gpt-6.1-sol",
                    task="background_review", input_tokens=2_000_000,
                    cost_status="included", api_call_count=10)
        report = self.report()
        task = next(r for r in report["by_task"] if r["name"] == "background_review")
        self.assertGreater(task["tokens"], 0)
        self.assertGreater(task["list_usd"], 0)

    def test_unattributed_usage_is_unpriced_not_guessed(self):
        self.insert(billing_provider="", model="gpt-6-luna",
                    input_tokens=1_000_000, api_call_count=10)
        report = self.report()
        route = next(r for r in report["by_route"] if r["name"] == "(unattributed)")
        self.assertIsNone(route["list_usd"])
        self.assertEqual(route["status"], "unpriced")
        self.assertEqual(report["unpriced"][0]["reason"], "provider_not_recorded")

    def test_surface_split(self):
        self.insert(input_tokens=1_000_000, api_call_count=10)
        self.insert(session_id="s2", input_tokens=1_000_000, api_call_count=10)
        report = self.report()
        names = {r["name"] for r in report["by_surface"]}
        self.assertIn("desktop", names)
        self.assertIn("cron", names)


if __name__ == "__main__":
    unittest.main()
