"""Central membership-plan feed generator: current plans only, validated.

The published feed withholds retired plans, keeps the verification state
of every current plan, refuses invalid catalogues, and always passes the
same client validation the desktop pane uses.
"""
from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from wolfmark_ledger import plans_feed
from wolfmark_ledger import membership_live as live

ROOT = Path(__file__).resolve().parents[1]


def plan(plan_id, status="verified"):
    return {"id": plan_id, "provider_family": "demo",
            "name": f"demo {plan_id}",
            "price": {"amount": 10.0, "currency": "USD",
                      "period": "month"},
            "verification": {"status": status}}


def catalogue(plans):
    return {"catalogue_version": "test-1",
            "generated_at": "2026-11-01T00:00:00Z",
            "plans": plans, "sources": []}


class BuildFeedTests(unittest.TestCase):
    def test_retired_plans_withheld(self):
        doc, problems = plans_feed.build_feed(catalogue(
            [plan("keep-verified", "verified"),
             plan("keep-prov", "provisional"),
             plan("keep-unver", "unverified"),
             plan("gone", "retired")]))
        self.assertEqual(problems, [])
        self.assertEqual(doc["version"], live.PLANS_FEED_VERSION)
        self.assertEqual(doc["catalogue_version"], "test-1")
        self.assertEqual(sorted(entry["id"] for entry in doc["plans"]),
                         ["keep-prov", "keep-unver", "keep-verified"])

    def test_invalid_catalogue_returns_problems(self):
        doc, problems = plans_feed.build_feed(
            catalogue([plan("dup"), plan("dup")]))
        self.assertEqual(doc, {})
        self.assertTrue(problems)

    def test_over_limit_truncated_with_problems(self):
        plans = [plan(f"p-{index:03d}") for index in range(205)]
        doc, problems = plans_feed.build_feed(catalogue(plans))
        self.assertEqual(len(doc["plans"]), live.FEED_MAX_ITEMS)
        self.assertTrue(any("feed limit" in entry for entry in problems))

    def test_generated_feed_passes_client_validation(self):
        doc, problems = plans_feed.build_feed(catalogue([plan("a")]))
        self.assertEqual(problems, [])
        book, check = live.validate_feed(json.loads(json.dumps(doc)))
        self.assertEqual(check, [])
        self.assertEqual(book["plans"][0]["id"], "a")

    def test_real_catalogue_builds_clean_feed(self):
        raw = json.loads((ROOT / "catalogue" / "plans.json").read_text(
            encoding="utf-8-sig"))
        doc, problems = plans_feed.build_feed(
            raw, generated_at="2026-11-01T00:00:00Z")
        self.assertEqual(problems, [])
        statuses = {entry["verification"]["status"]
                    for entry in doc["plans"]}
        self.assertNotIn("retired", statuses)
        self.assertTrue({"verified", "provisional", "unverified"} & statuses)
        book, check = live.validate_feed(json.loads(json.dumps(doc)))
        self.assertEqual(check, [])
        self.assertEqual(len(book["plans"]), len(doc["plans"]))


class MainTests(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory(
            dir=os.environ.get("TMPDIR"))
        self.addCleanup(self.scratch.cleanup)
        self.out = Path(self.scratch.name) / "plans.json"

    def write_catalogue(self, data):
        path = Path(self.scratch.name) / "plans-input.json"
        path.write_text(json.dumps(data), encoding="utf-8")
        return path

    def test_main_writes_feed(self):
        source = self.write_catalogue(catalogue([plan("a")]))
        code = plans_feed.main(["--catalogue", str(source),
                                "--generated-at", "2026-11-01T00:00:00Z",
                                "--out", str(self.out)])
        self.assertEqual(code, 0)
        doc = json.loads(self.out.read_text(encoding="utf-8"))
        self.assertEqual(doc["plans"][0]["id"], "a")
        self.assertEqual(doc["generated_at"], "2026-11-01T00:00:00Z")

    def test_main_refuses_invalid_catalogue(self):
        source = self.write_catalogue(catalogue([plan("dup"), plan("dup")]))
        with mock.patch("sys.stderr"):
            code = plans_feed.main(["--catalogue", str(source),
                                    "--out", str(self.out)])
        self.assertEqual(code, 1)
        self.assertFalse(self.out.exists())

    def test_main_refuses_missing_catalogue(self):
        missing = Path(self.scratch.name) / "absent.json"
        with mock.patch("sys.stderr"):
            code = plans_feed.main(["--catalogue", str(missing),
                                    "--out", str(self.out)])
        self.assertEqual(code, 1)
        self.assertFalse(self.out.exists())

    def test_main_enforces_byte_cap(self):
        source = self.write_catalogue(catalogue([plan("a")]))
        with mock.patch.object(plans_feed, "FEED_MAX_BYTES", 10), \
                mock.patch("sys.stderr"):
            code = plans_feed.main(["--catalogue", str(source),
                                    "--out", str(self.out)])
        self.assertEqual(code, 1)
        self.assertFalse(self.out.exists())


if __name__ == "__main__":
    unittest.main()
