"""Pricing provenance tiers and coverage — deterministic, no network."""
from __future__ import annotations

import tempfile
import unittest
from contextlib import closing
from pathlib import Path
import sqlite3
import os

from wolfmark_ledger import store
from wolfmark_ledger.analytics import build_analytics_report
from wolfmark_ledger.pricing import Catalogue, Rate

NOW = 1_793_300_000.0


class ProvenanceTests(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory(dir=os.environ.get("TMPDIR"))
        self.addCleanup(self.scratch.cleanup)
        self.events = Path(self.scratch.name) / "usage.db"
        self.state = Path(self.scratch.name) / "state.db"
        self.book = Catalogue({
            "commandcode": {"m": Rate(0.15, 0.6, 0.003)},
            "openrouter": {"m": Rate(0.30, 1.2, 0.006), "solo": Rate(9, 9, 9)},
            "anthropic": {"other": Rate(3, 15, 0.3)},
        }, "fixture", "test", "", "1")

    def events_for(self, rows):
        with closing(sqlite3.connect(self.events)) as conn, conn:
            conn.executescript(store._SCHEMA)
            for i, row in enumerate(rows):
                values = {"event_id": f"e{i}", "ts": NOW - 1, "model": "m", "provider": "commandcode",
                          "platform": "desktop", "outcome": "ok", "recorded_at": NOW, "input_tokens": 10,
                          **row}
                cols = list(values)
                conn.execute(f"INSERT INTO calls ({','.join(cols)}) VALUES ({','.join('?' for _ in cols)})",
                             list(values.values()))

    def report(self, mode):
        return build_analytics_report(self.events, state_db_path=self.state, days=1, now=NOW,
                                      catalogue=self.book, pricing_mode=mode)

    def test_exact_route_is_verified_and_never_borrows(self):
        self.events_for([{}])
        report = self.report("strict")
        self.assertEqual(report["pricing_coverage"]["models_dev_route_tokens"], 10)
        self.assertEqual(report["pricing_coverage"]["estimated_tokens"], 0)
        self.assertEqual(report["by_model"][0]["pricing_provenance"], "models_dev_route")

    def test_strict_leaves_unknown_route_unpriced(self):
        self.events_for([{"provider": "openai"}])
        report = self.report("strict")
        self.assertEqual(report["pricing_coverage"]["unpriced_tokens"], 10)
        self.assertEqual(report["totals"]["unpriced_tokens"], 10)

    def test_third_party_uses_openrouter_exact_and_labels_it(self):
        self.events_for([{"provider": "openai"}])  # 'm' only exists under commandcode/openrouter
        report = self.report("third_party")
        self.assertEqual(report["pricing_coverage"]["estimated_tokens"], 10)
        self.assertEqual(report["pricing_coverage"]["models_dev_route_tokens"], 0)
        self.assertEqual(report["by_model"][0]["pricing_provenance"], "third_party")
        self.assertAlmostEqual(report["totals"]["list_usd"], 10 * 0.30 / 1_000_000)

    def test_approximate_is_last_resort_and_distinct(self):
        self.events_for([{"provider": "openai", "model": "other"}])  # only anthropic has it
        strict = self.report("strict")
        self.assertEqual(strict["pricing_coverage"]["unpriced_tokens"], 10)
        approx = self.report("approximate")
        self.assertEqual(approx["by_model"][0]["pricing_provenance"], "approximate",
                         "only an opt-in cross-provider equivalent, never the sibling variant")
        self.assertEqual(approx["pricing_coverage"]["estimated_tokens"], 10)

    def test_coverage_ratios_use_tokens_not_rows(self):
        self.events_for([{"input_tokens": 90}, {"provider": "openai", "input_tokens": 10}])
        report = self.report("third_party")
        cov = report["pricing_coverage"]
        self.assertEqual(cov["models_dev_route_tokens"], 90)
        self.assertEqual(cov["estimated_tokens"], 10)
        self.assertAlmostEqual(cov["models_dev_ratio"], 0.9, places=6)
        self.assertAlmostEqual(cov["coverage"], 1.0, places=6)

    def test_official_overlay_wins_and_is_marked(self):
        from wolfmark_ledger.pricing import load_official
        overlay = load_official(Path(self.scratch.name) / "official.json") if False else {}
        self.book = Catalogue({"commandcode": {"m": Rate(0.15, 0.6, 0.003)}},
                              "fixture", "test", "", "1",
                              official={("commandcode", "m"): (Rate(0.2, 0.8, 0.004), "2026-10-29", ())})
        self.events_for([{}])
        report = self.report("strict")
        self.assertEqual(report["pricing_coverage"]["official_verified_tokens"], 10)
        self.assertEqual(report["pricing_coverage"]["models_dev_route_tokens"], 0)
        self.assertEqual(report["by_model"][0]["pricing_provenance"], "official_verified")

    def test_a_different_variant_is_not_substituted(self):
        self.book = Catalogue({
            "commandcode": {"deepseek-v4-flash": Rate(0.15, 0.6, 0.003)},
            "anthropic": {"deepseek-v4.1-flash": Rate(2, 8, 0.2)},
        }, "fixture", "test", "", "1")
        self.events_for([{"model": "deepseek-v4.1-flash"}])
        strict = self.report("strict")
        self.assertEqual(strict["pricing_coverage"]["unpriced_tokens"], 10,
                         "a sibling variant must not stand in for the requested one")
        approx = self.report("approximate")
        self.assertEqual(approx["by_model"][0]["pricing_provenance"], "approximate",
                         "only an opt-in cross-provider equivalent, never the sibling variant")


if __name__ == "__main__":
    unittest.main()


class PeakOffPeakTests(unittest.TestCase):
    def test_window_rate_follows_the_call_timestamp(self):
        from wolfmark_ledger.pricing import Catalogue, Rate
        from datetime import datetime, timezone
        peak = (None, 540, 1020, 0.30, 1.20, 0.006, None)      # 09:00-17:00 UTC
        book = Catalogue({"cc": {"m": Rate(0.15, 0.60, 0.003)}}, "f", "t", "", "1",
                         official={("cc", "m"): (Rate(0.15, 0.60, 0.003), "2026-10-29", (peak,))})
        off = datetime(2026, 10, 29, 2, tzinfo=timezone.utc).timestamp()
        on = datetime(2026, 10, 29, 12, tzinfo=timezone.utc).timestamp()
        self.assertEqual(book.lookup("cc", "m", at=on).rate.input, 0.30)
        self.assertEqual(book.lookup("cc", "m", at=off).rate.input, 0.15)
        self.assertEqual(book.lookup("cc", "m").rate.input, 0.15, "no timestamp means the base rate")
