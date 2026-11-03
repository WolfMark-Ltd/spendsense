"""Feed country aggregation: temp count lines into daily totals.

Drives the wished-for ``wolfmark_ledger.feed_counts`` API; helpers fail with
"not implemented" until the module exists (RED), then behaviour takes over.
"""
from __future__ import annotations

import importlib
import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path


def counts_module():
    spec = importlib.util.find_spec("wolfmark_ledger.feed_counts")
    assert spec is not None, "feed_counts module has not been implemented"
    return importlib.import_module("wolfmark_ledger.feed_counts")


class AggregateTests(unittest.TestCase):
    def test_counts_successful_get_by_country(self):
        counts = counts_module()
        totals = counts.aggregate_lines([
            "GET 200 US\n",
            "GET 200 US\n",
            "GET 200 GB\n",
            "GET 200 Unknown\n",
        ])
        self.assertEqual(totals, {"US": 2, "GB": 1, "Unknown": 1})

    def test_ignores_monitoring_errors_and_garbage(self):
        counts = counts_module()
        totals = counts.aggregate_lines([
            "HEAD 200 US\n",      # monitoring checks use HEAD
            "GET 404 US\n",
            "GET 405 GB\n",
            "GET 200 us\n",       # not a country code
            "GET 200 U1\n",
            "not a count line\n",
            "\n",
            "GET 200 US extra tokens here\n",
            "1.2.3.4 GET 200 US\n",  # an IP must never parse
        ])
        self.assertEqual(totals, {})

    def test_merge_adds_into_existing_date(self):
        counts = counts_module()
        existing = {"2026-11-02": {"US": 5}}
        merged = counts.merge_totals(existing, "2026-11-02", {"US": 2, "GB": 1})
        self.assertEqual(merged, {"2026-11-02": {"US": 7, "GB": 1}})
        self.assertEqual(counts.merge_totals({}, "2026-11-03", {"GB": 1}),
                         {"2026-11-03": {"GB": 1}})

    def test_run_writes_totals_and_discards_temp_lines(self):
        counts = counts_module()
        with tempfile.TemporaryDirectory(dir=os.environ.get("TMPDIR")) as scratch:
            tmp = Path(scratch) / "count.tmp.log"
            totals = Path(scratch) / "country-daily.json"
            tmp.write_text("GET 200 US\nGET 200 GB\n", encoding="utf-8")
            summary = counts.run(tmp, totals, "2026-11-02")
            self.assertEqual(summary, {"US": 1, "GB": 1})
            self.assertEqual(json.loads(totals.read_text()),
                             {"2026-11-02": {"US": 1, "GB": 1}})
            self.assertEqual(tmp.read_text(), "")

    def test_run_failure_quarantines_temp_without_counting(self):
        counts = counts_module()
        with tempfile.TemporaryDirectory(dir=os.environ.get("TMPDIR")) as scratch:
            tmp = Path(scratch) / "count.tmp.log"
            totals = Path(scratch) / "country-daily.json"
            tmp.write_text("GET 200 US\n", encoding="utf-8")
            totals.write_text("{corrupt", encoding="utf-8")
            with self.assertRaises(counts.CountsError):
                counts.run(tmp, totals, "2026-11-02")
            leftovers = [p for p in Path(scratch).glob("count.tmp.log.*")
                         if p.name != "count.tmp.log"]
            self.assertEqual(len(leftovers), 1)
            self.assertIn("GET 200 US", leftovers[0].read_text())


if __name__ == "__main__":
    unittest.main()
