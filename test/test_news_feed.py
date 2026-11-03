"""Central feed generator: deterministic models.dev diffs plus curated notes.

Drives the wished-for ``wolfmark_ledger.news_feed`` API; helpers fail with
"not implemented" until the module exists (RED), then behaviour takes over.
"""
from __future__ import annotations

import importlib
import importlib.util
import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def feed_module():
    spec = importlib.util.find_spec("wolfmark_ledger.news_feed")
    assert spec is not None, "news_feed module has not been implemented"
    return importlib.import_module("wolfmark_ledger.news_feed")


def models(entries):
    providers: dict[str, dict] = {}
    for provider, model, cost in entries:
        providers.setdefault(provider, {"models": {}})["models"][model] = {"cost": cost}
    return providers


class BuildFeedTests(unittest.TestCase):
    OBSERVED = "2026-11-03T00:00:00+00:00"

    def test_new_model_and_price_changes_detected(self):
        feed = feed_module()
        previous = models([("acme", "alpha", {"input": 3.0, "output": 15.0}),
                           ("acme", "beta", {"input": 1.0, "output": 2.0})])
        current = models([("acme", "alpha", {"input": 2.0, "output": 10.0}),
                          ("acme", "beta", {"input": 1.0, "output": 2.0}),
                          ("acme", "gamma", {"input": 0.5, "output": 1.0})])
        doc, problems = feed.build_feed(current, previous, {"announcements": []},
                                        observed_at=self.OBSERVED)
        self.assertEqual(problems, [])
        by_model = {item["model"]: item for item in doc["items"]}
        self.assertEqual(by_model["alpha"]["category"], "price_reduction")
        self.assertEqual(by_model["alpha"]["previous"]["input"], 3.0)
        self.assertEqual(by_model["alpha"]["current"]["input"], 2.0)
        self.assertEqual(by_model["alpha"]["provenance"], "models.dev")
        self.assertEqual(by_model["alpha"]["observed_at"], self.OBSERVED)
        self.assertEqual(by_model["gamma"]["category"], "new_model")
        self.assertNotIn("beta", by_model)

    def test_output_is_deterministic(self):
        feed = feed_module()
        previous = models([("acme", "alpha", {"input": 3.0, "output": 15.0})])
        current = models([("acme", "alpha", {"input": 2.0, "output": 10.0}),
                          ("zeta", "one", {"input": 1.0, "output": 1.0}),
                          ("acme", "gamma", {"input": 0.5, "output": 1.0})])
        first, _ = feed.build_feed(current, previous, {"announcements": []},
                                   observed_at=self.OBSERVED)
        second, _ = feed.build_feed(current, previous, {"announcements": []},
                                    observed_at=self.OBSERVED)
        self.assertEqual(json.dumps(first, sort_keys=True), json.dumps(second, sort_keys=True))
        self.assertEqual([item["id"] for item in first["items"]],
                         [item["id"] for item in second["items"]])

    def test_generated_feed_passes_plugin_validation(self):
        from wolfmark_ledger import news

        feed = feed_module()
        doc, _ = feed.build_feed(
            models([("acme", "alpha", {"input": 2.0, "output": 10.0})]),
            models([("acme", "alpha", {"input": 3.0, "output": 15.0})]),
            {"announcements": [{"provider": "acme", "category": "subscription",
                                "summary": "Acme Pro rises to USD 25/month.",
                                "source_url": "https://example.com/pricing",
                                "effective_at": "2026-12-01"}]},
            observed_at=self.OBSERVED)
        validated, problems = news.validate_feed(doc)
        self.assertIsNotNone(validated, problems)
        self.assertEqual(problems, [])

    def test_curated_entries_need_https_evidence(self):
        feed = feed_module()
        doc, problems = feed.build_feed(
            models([]), models([]),
            {"announcements": [
                {"provider": "acme", "summary": "No source given."},
                {"provider": "acme", "summary": "Bad scheme.",
                 "source_url": "ftp://example.com/x"},
                {"provider": "acme", "summary": "Good note.",
                 "source_url": "https://example.com/pricing"},
            ]},
            observed_at=self.OBSERVED)
        self.assertEqual(len(problems), 2)
        self.assertEqual([item["summary"] for item in doc["items"]], ["Good note."])

    def test_empty_diff_yields_empty_items(self):
        feed = feed_module()
        snapshot = models([("acme", "alpha", {"input": 1.0, "output": 2.0})])
        doc, problems = feed.build_feed(snapshot, snapshot, {"announcements": []},
                                        observed_at=self.OBSERVED)
        self.assertEqual(problems, [])
        self.assertEqual(doc["items"], [])
        self.assertEqual(doc["version"], 1)


class SampleFixtureTests(unittest.TestCase):
    def test_sample_fixture_validates(self):
        from wolfmark_ledger import news

        fixture = ROOT / "news-feed" / "fixtures" / "sample-feed.json"
        self.assertTrue(fixture.exists(), "sample fixture is part of the PR")
        validated, problems = news.validate_feed(json.loads(fixture.read_text()))
        self.assertIsNotNone(validated, problems)
        self.assertEqual(problems, [])

    def test_schema_file_exists_and_matches_validator(self):
        schema_path = ROOT / "news-feed" / "schema.json"
        self.assertTrue(schema_path.exists(), "schema ships in the PR")
        schema = json.loads(schema_path.read_text())
        self.assertIn("price_reduction", json.dumps(schema))
        self.assertIn("subscription", json.dumps(schema))


if __name__ == "__main__":
    unittest.main()
