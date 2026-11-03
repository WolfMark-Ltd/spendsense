"""Feed country aggregation: temp count lines into daily totals.

Drives ``wolfmark_ledger.feed_counts``: date-stamped anonymous lines are
rotated aside, folded by their own dates, and discarded.
"""
from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path

from wolfmark_ledger import feed_counts as counts


def noop_reopen():
    return None


class AggregateTests(unittest.TestCase):
    def test_counts_successful_get_by_country_and_day(self):
        totals = counts.aggregate_lines([
            "2026-11-02 GET 200 US\n",
            "2026-11-02 GET 200 US\n",
            "2026-11-02 GET 200 GB\n",
            "2026-11-02 GET 200 Unknown\n",
            "2026-11-03 GET 200 GB\n",
        ])
        self.assertEqual(totals, {"2026-11-02": {"US": 2, "GB": 1, "Unknown": 1},
                                  "2026-11-03": {"GB": 1}})

    def test_ignores_monitoring_errors_and_garbage(self):
        totals = counts.aggregate_lines([
            "2026-11-02 HEAD 200 US\n",  # monitoring checks use HEAD
            "2026-11-02 GET 404 US\n",
            "2026-11-02 GET 405 GB\n",
            "2026-11-02 GET 200 us\n",   # not a country code
            "2026-11-02 GET 200 U1\n",
            "not a count line\n",
            "\n",
            "2026-11-02 GET 200 US extra tokens\n",
            "1.2.3.4 GET 200 US\n",      # an IP must never parse
            "2026-11-02T03:04:05 GET 200 US\n",  # full timestamps rejected
            "2026-13-99 GET 200 US\n",   # impossible date
        ])
        self.assertEqual(totals, {})

    def test_merge_adds_into_existing_days(self):
        existing = {"2026-11-02": {"US": 5}}
        merged = counts.merge_totals(existing, {"2026-11-02": {"US": 2, "GB": 1},
                                                "2026-11-03": {"GB": 1}})
        self.assertEqual(merged, {"2026-11-02": {"US": 7, "GB": 1},
                                  "2026-11-03": {"GB": 1}})

    def scratch(self):
        tmp = tempfile.TemporaryDirectory(dir=os.environ.get("TMPDIR"))
        self.addCleanup(tmp.cleanup)
        return Path(tmp.name)

    def test_run_rotates_folds_and_discards(self):
        root = self.scratch()
        tmp, totals = root / "count.tmp.log", root / "country-daily.json"
        tmp.write_text("2026-11-02 GET 200 US\n2026-11-03 GET 200 GB\n")
        summary = counts.run(tmp, totals, noop_reopen)
        self.assertEqual(summary, {"2026-11-02": {"US": 1}, "2026-11-03": {"GB": 1}})
        self.assertEqual(json.loads(totals.read_text()), summary)
        self.assertFalse((tmp.parent / "count.tmp.log.1").exists())
        self.assertFalse(tmp.exists())  # nginx recreates it on reopen

    def test_run_folds_leftover_rotated_log_first(self):
        root = self.scratch()
        tmp, totals = root / "count.tmp.log", root / "country-daily.json"
        (tmp.parent / "count.tmp.log.1").write_text("2026-11-01 GET 200 GB\n")
        tmp.write_text("2026-11-02 GET 200 US\n")
        summary = counts.run(tmp, totals, noop_reopen)
        self.assertEqual(summary, {"2026-11-01": {"GB": 1}, "2026-11-02": {"US": 1}})

    def test_run_failure_keeps_rotated_log_for_retry(self):
        root = self.scratch()
        tmp, totals = root / "count.tmp.log", root / "country-daily.json"
        tmp.write_text("2026-11-02 GET 200 US\n")
        totals.write_text("{corrupt", encoding="utf-8")
        with self.assertRaises(counts.CountsError):
            counts.run(tmp, totals, noop_reopen)
        rotated = tmp.parent / "count.tmp.log.1"
        self.assertIn("GET 200 US", rotated.read_text())
        totals.write_text("{}", encoding="utf-8")
        summary = counts.run(tmp, totals, noop_reopen)
        self.assertEqual(summary, {"2026-11-02": {"US": 1}})

    def test_run_reopen_failure_keeps_everything(self):
        root = self.scratch()
        tmp, totals = root / "count.tmp.log", root / "country-daily.json"
        tmp.write_text("2026-11-02 GET 200 US\n")

        def failing_reopen():
            raise OSError("nginx away")

        with self.assertRaises(counts.CountsError):
            counts.run(tmp, totals, failing_reopen)
        self.assertIn("GET 200 US", (tmp.parent / "count.tmp.log.1").read_text())
        summary = counts.run(tmp, totals, noop_reopen)
        self.assertEqual(summary, {"2026-11-02": {"US": 1}})

    def test_main_aggregates_and_reports(self):
        root = self.scratch()
        tmp, totals = root / "count.tmp.log", root / "country-daily.json"
        tmp.write_text("2026-11-02 GET 200 US\n")
        self.assertEqual(counts.main(["--counts", str(tmp), "--totals", str(totals),
                                      "--no-reopen"]), 0)
        self.assertEqual(json.loads(totals.read_text()), {"2026-11-02": {"US": 1}})


if __name__ == "__main__":
    unittest.main()
