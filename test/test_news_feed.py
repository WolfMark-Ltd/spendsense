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
        current = models([("acme", "alpha", {"input": 2.0, "output": 10.0})])
        doc, problems = feed.build_feed(
            current, None,
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

    def test_unparseable_previous_is_an_input_error(self):
        feed = feed_module()
        current = models([("acme", "alpha", {"input": 2.0, "output": 10.0})])
        doc, problems = feed.build_feed(current, {"error": "upstream envelope"},
                                        {"announcements": []}, observed_at=self.OBSERVED)
        self.assertTrue(problems)
        self.assertEqual(doc["items"], [])

    def test_unparseable_current_is_an_input_error(self):
        feed = feed_module()
        previous = models([("acme", "alpha", {"input": 3.0, "output": 15.0})])
        doc, problems = feed.build_feed({"error": "upstream envelope"}, previous,
                                        {"announcements": []}, observed_at=self.OBSERVED)
        self.assertTrue(problems)
        self.assertEqual(doc["items"], [])

    def test_omitted_previous_stays_first_run(self):
        feed = feed_module()
        current = models([("acme", "alpha", {"input": 2.0, "output": 10.0})])
        doc, problems = feed.build_feed(current, None, {"announcements": []},
                                        observed_at=self.OBSERVED)
        self.assertEqual(problems, [])
        self.assertEqual(doc["items"], [])

    def test_cache_only_cut_is_a_reduction(self):
        feed = feed_module()
        previous = models([("acme", "alpha", {"input": 3.0, "output": 15.0,
                                              "cache_read": 0.3})])
        current = models([("acme", "alpha", {"input": 3.0, "output": 15.0,
                                             "cache_read": 0.1})])
        doc, problems = feed.build_feed(current, previous, {"announcements": []},
                                        observed_at=self.OBSERVED)
        self.assertEqual(problems, [])
        self.assertEqual(doc["items"][0]["category"], "price_reduction")

    def test_curated_price_change_needs_both_rate_blocks(self):
        feed = feed_module()
        current = models([("acme", "alpha", {"input": 2.0, "output": 10.0})])
        doc, problems = feed.build_feed(
            current, None,
            {"announcements": [{"provider": "acme", "category": "price_reduction",
                                "summary": "Cheaper, allegedly.",
                                "source_url": "https://example.com/pricing",
                                "current": {"input": 1.0, "output": 2.0}}]},
            observed_at=self.OBSERVED)
        self.assertEqual(doc["items"], [])
        self.assertTrue(any("previous and current" in problem for problem in problems))

    def test_non_finite_curated_rates_rejected(self):
        feed = feed_module()
        current = models([("acme", "alpha", {"input": 2.0, "output": 10.0})])
        doc, problems = feed.build_feed(
            current, None,
            {"announcements": [
                {"provider": "acme", "summary": "NaN rate.",
                 "source_url": "https://example.com/a",
                 "current": {"input": float("nan"), "output": 2.0}},
                {"provider": "acme", "summary": "Infinite rate.",
                 "source_url": "https://example.com/b",
                 "current": {"input": 1.0, "output": float("inf")}},
            ]},
            observed_at=self.OBSERVED)
        self.assertEqual(doc["items"], [])
        self.assertEqual(len(problems), 2)

    def test_truncation_keeps_newest_and_all_curated(self):
        feed = feed_module()
        previous = models([("acme", "seed", {"input": 1.0, "output": 1.0})])
        rows = [("acme", "seed", {"input": 1.0, "output": 1.0})]
        rows += [(f"prov-{n:03d}", "m", {"input": 1.0, "output": 1.0})
                 for n in range(205)]
        curated = {"announcements": [
            {"provider": "acme", "summary": f"Note {n}.",
             "source_url": "https://example.com/pricing",
             "observed_at": "2020-01-01T00:00:00+00:00"}
            for n in range(3)]}
        doc, problems = feed.build_feed(models(rows), previous, curated,
                                        observed_at=self.OBSERVED)
        self.assertEqual(problems, [])
        self.assertEqual(len(doc["items"]), feed.FEED_MAX_ITEMS)
        ids = [item["id"] for item in doc["items"]]
        self.assertEqual(len([i for i in ids if i.startswith("sub-")]), 3)
        self.assertEqual(doc.get("truncated"), {"model_items_dropped": 8})


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

    def test_schema_allows_null_rate_blocks(self):
        schema = json.loads((ROOT / "news-feed" / "schema.json").read_text())
        props = schema["properties"]["items"]["items"]["properties"]
        for key in ("previous", "current"):
            variants = props[key].get("anyOf", [])
            self.assertIn({"type": "null"}, variants,
                          f"schema must accept null {key} blocks")
            self.assertIn({"$ref": "#/$defs/rateBlock"}, variants)

    def test_schema_requires_price_change_blocks(self):
        schema = json.loads((ROOT / "news-feed" / "schema.json").read_text())
        rules = schema["properties"]["items"]["items"]["allOf"]
        price_rule = next(rule for rule in rules
                          if "price_reduction" in json.dumps(rule.get("if", {})))
        then = price_rule["then"]
        self.assertEqual(sorted(then["required"]), ["current", "previous"])
        for key in ("previous", "current"):
            self.assertEqual(then["properties"][key], {"$ref": "#/$defs/rateBlock"})

    def test_generated_feed_with_truncation_note_still_validates(self):
        from wolfmark_ledger import news

        feed = feed_module()
        previous = models([("acme", "seed", {"input": 1.0, "output": 1.0})])
        rows = [("acme", "seed", {"input": 1.0, "output": 1.0})]
        rows += [(f"prov-{n:03d}", "m", {"input": 1.0, "output": 1.0})
                 for n in range(205)]
        doc, problems = feed.build_feed(models(rows), previous,
                                        {"announcements": []},
                                        observed_at="2026-11-03T00:00:00+00:00")
        self.assertEqual(problems, [])
        validated, check_problems = news.validate_feed(doc)
        self.assertIsNotNone(validated, check_problems)
        self.assertEqual(check_problems, [])


if __name__ == "__main__":
    unittest.main()
