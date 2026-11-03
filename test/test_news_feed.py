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

    def test_prior_feed_items_carried_within_window(self):
        feed = feed_module()
        previous = models([("acme", "alpha", {"input": 3.0, "output": 15.0})])
        week1, _ = feed.build_feed(
            models([("acme", "alpha", {"input": 2.0, "output": 10.0})]),
            previous, {"announcements": []},
            observed_at="2026-11-03T00:00:00+00:00")
        self.assertEqual(len(week1["items"]), 1)
        week2, problems = feed.build_feed(
            models([("acme", "alpha", {"input": 2.0, "output": 10.0}),
                    ("acme", "beta", {"input": 1.0, "output": 1.0})]),
            models([("acme", "alpha", {"input": 2.0, "output": 10.0})]),
            {"announcements": []},
            observed_at="2026-11-10T00:00:00+00:00",
            prior_feed=week1, retain_days=90)
        self.assertEqual(problems, [])
        self.assertEqual(len(week2["items"]), 2)

    def test_prior_items_expire_after_retain_window(self):
        feed = feed_module()
        old = {"version": 1, "generated_at": "2026-01-01T00:00:00+00:00",
               "items": [{"id": "md-old", "category": "price_reduction",
                          "provider": "acme", "model": "alpha",
                          "summary": "Old news.",
                          "previous": {"input": 3.0, "output": 15.0,
                                       "cache_read": None, "cache_write": None},
                          "current": {"input": 2.0, "output": 10.0,
                                      "cache_read": None, "cache_write": None},
                          "observed_at": "2026-01-01T00:00:00+00:00",
                          "effective_at": "",
                          "source_url": "https://models.dev",
                          "confidence": "observed", "provenance": "models.dev",
                          "conditions": ""}]}
        snapshot = models([("acme", "alpha", {"input": 2.0, "output": 10.0})])
        doc, problems = feed.build_feed(
            snapshot, snapshot, {"announcements": []},
            observed_at="2026-11-03T00:00:00+00:00",
            prior_feed=old, retain_days=90)
        self.assertEqual(problems, [])
        self.assertEqual(doc["items"], [])

    def test_fresh_items_replace_carried_duplicates(self):
        feed = feed_module()
        announcement = {"provider": "acme", "summary": "Standing note.",
                        "source_url": "https://example.com/pricing"}
        snapshot = models([("acme", "alpha", {"input": 2.0, "output": 10.0})])
        first, _ = feed.build_feed(snapshot, None, {"announcements": [announcement]},
                                   observed_at="2026-11-03T00:00:00+00:00")
        self.assertEqual(len(first["items"]), 1)
        second, problems = feed.build_feed(snapshot, snapshot,
                                           {"announcements": [announcement]},
                                           observed_at="2026-11-10T00:00:00+00:00",
                                           prior_feed=first, retain_days=90)
        self.assertEqual(problems, [])
        self.assertEqual(len(second["items"]), 1)
        self.assertEqual(second["items"][0]["observed_at"], "2026-11-10T00:00:00+00:00")

    def test_invalid_prior_feed_is_an_error(self):
        feed = feed_module()
        snapshot = models([("acme", "alpha", {"input": 2.0, "output": 10.0})])
        doc, problems = feed.build_feed(
            snapshot, snapshot, {"announcements": []},
            observed_at=self.OBSERVED,
            prior_feed={"version": 99, "items": []}, retain_days=90)
        self.assertTrue(problems)
        self.assertEqual(doc["items"], [])

    def test_partly_invalid_prior_feed_is_rejected(self):
        feed = feed_module()
        good = {"id": "md-abc", "category": "new_model", "provider": "acme",
                "model": "alpha", "summary": "Listed.",
                "previous": None, "current": {"input": 1.0, "output": 2.0,
                                              "cache_read": None, "cache_write": None},
                "observed_at": "2026-11-01T00:00:00+00:00", "effective_at": "",
                "source_url": "https://models.dev", "confidence": "observed",
                "provenance": "models.dev", "conditions": ""}
        prior = {"version": 1, "generated_at": "2026-11-01T00:00:00+00:00",
                 "items": [good, {"bogus": "entry"}]}
        snapshot = models([("acme", "alpha", {"input": 2.0, "output": 10.0})])
        doc, problems = feed.build_feed(
            snapshot, snapshot, {"announcements": []},
            observed_at=self.OBSERVED, prior_feed=prior, retain_days=90)
        self.assertTrue(any("prior feed invalid" in problem for problem in problems))
        self.assertEqual(doc["items"], [])

    def test_model_diff_ids_stable_across_runs(self):
        feed = feed_module()
        previous = models([("acme", "alpha", {"input": 3.0, "output": 15.0})])
        current = models([("acme", "alpha", {"input": 2.0, "output": 10.0}),
                          ("acme", "beta", {"input": 1.0, "output": 1.0})])
        first, _ = feed.build_feed(current, previous, {"announcements": []},
                                   observed_at="2026-11-03T00:00:00+00:00")
        second, _ = feed.build_feed(current, previous, {"announcements": []},
                                    observed_at="2026-11-10T00:00:00+00:00")
        self.assertEqual([i["id"] for i in first["items"]],
                         [i["id"] for i in second["items"]])

    def test_curated_stable_id_survives_correction(self):
        feed = feed_module()
        snapshot = models([("acme", "alpha", {"input": 2.0, "output": 10.0})])
        first, problems = feed.build_feed(
            snapshot, None,
            {"announcements": [{"id": "acme-note-1", "provider": "acme",
                                "summary": "First wording.",
                                "source_url": "https://example.com/pricing"}]},
            observed_at="2026-11-03T00:00:00+00:00")
        self.assertEqual(problems, [])
        self.assertEqual(first["items"][0]["id"], "acme-note-1")
        second, problems = feed.build_feed(
            snapshot, snapshot,
            {"announcements": [{"id": "acme-note-1", "provider": "acme",
                                "summary": "Corrected wording.",
                                "source_url": "https://example.com/pricing"}]},
            observed_at="2026-11-10T00:00:00+00:00",
            prior_feed=first, retain_days=90)
        self.assertEqual(problems, [])
        self.assertEqual(len(second["items"]), 1)
        self.assertEqual(second["items"][0]["id"], "acme-note-1")
        self.assertEqual(second["items"][0]["summary"], "Corrected wording.")

    def test_curated_bad_and_duplicate_ids_rejected(self):
        feed = feed_module()
        snapshot = models([("acme", "alpha", {"input": 2.0, "output": 10.0})])
        _, problems = feed.build_feed(
            snapshot, None,
            {"announcements": [{"id": "has spaces", "provider": "acme",
                                "summary": "Bad id.",
                                "source_url": "https://example.com/pricing"}]},
            observed_at=self.OBSERVED)
        self.assertTrue(problems)
        _, problems = feed.build_feed(
            snapshot, None,
            {"announcements": [
                {"id": "dup", "provider": "acme", "summary": "One.",
                 "source_url": "https://example.com/a"},
                {"id": "dup", "provider": "acme", "summary": "Two.",
                 "source_url": "https://example.com/b"}]},
            observed_at=self.OBSERVED)
        self.assertTrue(any("duplicate" in problem for problem in problems))

    def test_withdraw_removes_carried_announcement(self):
        feed = feed_module()
        snapshot = models([("acme", "alpha", {"input": 2.0, "output": 10.0})])
        first, _ = feed.build_feed(
            snapshot, None,
            {"announcements": [
                {"id": "keep-me", "provider": "acme", "summary": "Stays.",
                 "source_url": "https://example.com/a"},
                {"id": "drop-me", "provider": "acme", "summary": "Goes.",
                 "source_url": "https://example.com/b"}]},
            observed_at="2026-11-03T00:00:00+00:00")
        self.assertEqual(len(first["items"]), 2)
        second, problems = feed.build_feed(
            snapshot, snapshot, {"announcements": [], "withdraw": ["drop-me"]},
            observed_at="2026-11-10T00:00:00+00:00",
            prior_feed=first, retain_days=90)
        self.assertEqual(problems, [])
        self.assertEqual([i["id"] for i in second["items"]], ["keep-me"])

    def test_withdraw_must_be_a_list_of_ids(self):
        feed = feed_module()
        snapshot = models([("acme", "alpha", {"input": 2.0, "output": 10.0})])
        _, problems = feed.build_feed(snapshot, snapshot,
                                      {"announcements": [], "withdraw": "drop-me"},
                                      observed_at=self.OBSERVED)
        self.assertTrue(problems)

    def test_carried_curated_survive_truncation(self):
        feed = feed_module()
        previous = models([("acme", "seed", {"input": 1.0, "output": 1.0})])
        first, _ = feed.build_feed(
            previous, None,
            {"announcements": [
                {"provider": "acme", "summary": f"Note {n}.",
                 "source_url": "https://example.com/pricing",
                 "observed_at": "2026-10-01T00:00:00+00:00"}
                for n in range(3)]},
            observed_at="2026-10-01T00:00:00+00:00")
        rows = [("acme", "seed", {"input": 1.0, "output": 1.0})]
        rows += [(f"prov-{n:03d}", "m", {"input": 1.0, "output": 1.0})
                 for n in range(205)]
        doc, problems = feed.build_feed(models(rows), previous,
                                        {"announcements": []},
                                        observed_at=self.OBSERVED,
                                        prior_feed=first, retain_days=90)
        self.assertEqual(problems, [])
        self.assertEqual(len(doc["items"]), feed.FEED_MAX_ITEMS)
        ids = [item["id"] for item in doc["items"]]
        self.assertEqual(len([i for i in ids if i.startswith("sub-")]), 3)

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
