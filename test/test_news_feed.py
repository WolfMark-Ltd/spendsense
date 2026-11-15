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

    def test_items_carry_summary_and_conditions_codes(self):
        # PR28: feed items carry codes; English strings keep exact wording.
        feed = feed_module()
        previous = models([("acme", "alpha", {"input": 3.0, "output": 15.0})])
        current = models([("acme", "alpha", {"input": 2.0, "output": 10.0}),
                          ("acme", "gamma", {"input": 0.5, "output": 1.0}),
                          ("zeta", "one", {"input": 1.0, "output": 1.0})])
        doc, problems = feed.build_feed(current, previous, {"announcements": []},
                                        observed_at=self.OBSERVED)
        self.assertEqual(problems, [])
        by_model = {item["model"]: item for item in doc["items"]}
        self.assertEqual(by_model["gamma"]["summary_code"], "news_sum_new_model_feed")
        self.assertEqual(by_model["gamma"]["summary_params"],
                         {"model": "gamma", "provider": "acme"})
        self.assertEqual(by_model["gamma"]["conditions_code"], "news_cond_listing_any_account")
        self.assertEqual(by_model["alpha"]["summary_code"], "news_sum_price_change_feed")
        self.assertEqual(by_model["alpha"]["summary"],
                         "alpha (acme) list price changed on models.dev.")
        providers = [item for item in doc["items"] if item["model"] == ""]
        self.assertEqual(providers[0]["summary_code"], "news_sum_new_provider_feed")
        self.assertEqual(providers[0]["summary_params"], {"provider": "zeta", "count": 1})

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

    def test_curated_md_prefix_ids_rejected(self):
        feed = feed_module()
        snapshot = models([("acme", "alpha", {"input": 2.0, "output": 10.0})])
        doc, problems = feed.build_feed(
            snapshot, None,
            {"announcements": [{"id": "md-sneaky", "provider": "acme",
                                "summary": "Tries the model prefix.",
                                "source_url": "https://example.com/pricing"}]},
            observed_at=self.OBSERVED)
        self.assertTrue(any("reserved" in problem for problem in problems))
        self.assertEqual(doc["items"], [])

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

    def test_briefing_is_a_property_so_it_is_actually_validated(self):
        schema = json.loads((ROOT / "news-feed" / "schema.json").read_text())
        self.assertIn("briefing", schema["properties"],
                      "a sibling of `properties` is an unknown keyword and never applies")
        keywords = {"$schema", "$id", "title", "description", "type", "required",
                    "additionalProperties", "properties", "allOf", "$defs"}
        self.assertEqual(sorted(set(schema) - keywords), [])

    def test_generated_feed_matches_the_published_schema(self):
        try:
            import jsonschema
        except ImportError:  # pragma: no cover - optional dev dependency
            self.skipTest("jsonschema is not installed")
        feed = feed_module()
        previous = models([("acme", "alpha", {"input": 4.0, "output": 8.0})])
        current = models([("acme", "alpha", {"input": 2.0, "output": 4.0}),
                          ("zeta", "one", {"input": 1.0, "output": 1.0})])
        doc, problems = feed.build_feed(current, previous, {"announcements": []},
                                        observed_at="2026-11-03T00:00:00+00:00")
        self.assertEqual(problems, [])
        schema = json.loads((ROOT / "news-feed" / "schema.json").read_text())
        jsonschema.validate(doc, schema)

    def test_a_malformed_briefing_is_rejected_by_the_schema(self):
        try:
            import jsonschema
        except ImportError:  # pragma: no cover - optional dev dependency
            self.skipTest("jsonschema is not installed")
        schema = json.loads((ROOT / "news-feed" / "schema.json").read_text())
        bad = {"version": 1, "generated_at": "2026-11-03T00:00:00+00:00", "items": [],
               "briefing": {"version": 1, "sections": "not a list"}}
        with self.assertRaises(jsonschema.ValidationError):
            jsonschema.validate(bad, schema)

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


class HistoryAndEditorialTests(unittest.TestCase):
    """Catalogue history: first-seen evidence, absence-confirmed removals."""

    OBSERVED = "2026-11-03T00:00:00+00:00"
    LATER = "2026-11-04T00:00:00+00:00"
    LATEST = "2026-11-05T00:00:00+00:00"

    def test_new_model_at_one_provider_is_a_catalogue_entry(self):
        feed = feed_module()
        previous = models([("acme", "seed", {"input": 1.0, "output": 1.0})])
        current = models([("acme", "seed", {"input": 1.0, "output": 1.0}),
                          ("acme", "gamma", {"input": 1.0, "output": 1.0})])
        doc, _ = feed.build_feed(current, previous, {"announcements": []},
                                 observed_at=self.OBSERVED)
        item = next(i for i in doc["items"] if i["model"] == "gamma")
        self.assertEqual(item["event_type"], "new_to_catalogue")
        self.assertEqual(item["other_providers"], [])

    def test_model_already_listed_elsewhere_is_newly_available(self):
        feed = feed_module()
        previous = models([("acme", "seed", {"input": 1.0, "output": 1.0})])
        current = models([
            ("acme", "seed", {"input": 1.0, "output": 1.0}),
            ("zeta", "shared-model", {"input": 1.0, "output": 1.0}),
            ("acme", "shared-model", {"input": 1.2, "output": 1.2}),
        ])
        doc, _ = feed.build_feed(current, previous, {"announcements": []},
                                 observed_at=self.OBSERVED)
        item = next(i for i in doc["items"] if i["provider"] == "acme"
                    and i["model"] == "shared-model")
        self.assertEqual(item["event_type"], "newly_available")
        self.assertEqual(item["other_providers"], ["zeta"])

    def test_history_records_first_seen_across_observations(self):
        feed = feed_module()
        first = models([("acme", "alpha", {"input": 1.0, "output": 1.0})])
        state, removals = feed.update_history(None, first, observed_at=self.OBSERVED)
        self.assertEqual(removals, [])
        self.assertEqual(state["observations"], 1)
        self.assertEqual(state["model_first_seen"]["alpha"], self.OBSERVED)

        second = models([("acme", "alpha", {"input": 1.0, "output": 1.0}),
                         ("acme", "alpha", {"input": 1.0, "output": 1.0})])
        state2, _ = feed.update_history(state, second, observed_at=self.LATER)
        self.assertEqual(state2["observations"], 2)
        self.assertEqual(state2["model_first_seen"]["alpha"], self.OBSERVED,
                         "a first sighting is not rewritten by a later run")

    def test_one_missing_observation_is_not_a_removal(self):
        feed = feed_module()
        with_model = models([("acme", "alpha", {"input": 1.0, "output": 1.0}),
                             ("acme", "beta", {"input": 1.0, "output": 1.0})])
        state, _ = feed.update_history(None, with_model, observed_at=self.OBSERVED)

        without = models([("acme", "alpha", {"input": 1.0, "output": 1.0})])
        state, removals = feed.update_history(state, without, observed_at=self.LATER)
        self.assertEqual(removals, [], "a single absence is a catalogue wobble")
        self.assertEqual(state["missing"]["acme"]["beta"]["count"], 1)

        state, removals = feed.update_history(state, without, observed_at=self.LATEST)
        self.assertEqual(len(removals), 1)
        self.assertEqual(removals[0]["model"], "beta")
        self.assertEqual(removals[0]["removed_at"], self.LATEST)
        self.assertEqual(removals[0]["missing_since"], self.LATER)
        self.assertEqual(removals[0]["consecutive"], 2)

        # The date stays put: a confirmed removal is not re-announced every run.
        state, removals = feed.update_history(state, without, observed_at="2026-11-06T00:00:00+00:00")
        self.assertEqual(removals[0]["removed_at"], self.LATEST)

    def test_reappearance_clears_a_removal(self):
        feed = feed_module()
        both = models([("acme", "alpha", {"input": 1.0, "output": 1.0}),
                       ("acme", "beta", {"input": 1.0, "output": 1.0})])
        state, _ = feed.update_history(None, both, observed_at=self.OBSERVED)
        only_alpha = models([("acme", "alpha", {"input": 1.0, "output": 1.0})])
        for stamp in (self.LATER, self.LATEST):
            state, removals = feed.update_history(state, only_alpha, observed_at=stamp)
        self.assertEqual(len(removals), 1)
        state, removals = feed.update_history(state, both, observed_at="2026-11-06T00:00:00+00:00")
        self.assertEqual(removals, [], "a returning model retracts its removal")
        self.assertNotIn("beta", state["missing"].get("acme", {}))

    def test_a_vanished_provider_is_one_delisting_not_mass_removals(self):
        feed = feed_module()
        crowded = models([("acme", "alpha", {"input": 1.0, "output": 1.0}),
                          ("gone", "one", {"input": 1.0, "output": 1.0}),
                          ("gone", "two", {"input": 1.0, "output": 1.0})])
        state, _ = feed.update_history(None, crowded, observed_at=self.OBSERVED)
        fewer = models([("acme", "alpha", {"input": 1.0, "output": 1.0})])
        state, removals = feed.update_history(state, fewer, observed_at=self.LATER)
        self.assertEqual(removals, [])
        state, removals = feed.update_history(state, fewer, observed_at=self.LATEST)
        self.assertEqual([record["provider"] for record in removals], ["gone"])
        self.assertEqual(removals[0]["model"], "")
        self.assertEqual(state["removed"]["gone\u001f"]["model"], "")

    def test_history_is_bounded_without_inventing_removals(self):
        feed = feed_module()
        state, _ = feed.update_history(
            None, models([("acme", "a", {"input": 1.0, "output": 1.0})]),
            observed_at=self.OBSERVED, max_records=1)
        state, _ = feed.update_history(
            state,
            models([("acme", "a", {"input": 1.0, "output": 1.0}),
                    ("acme", "b", {"input": 1.0, "output": 1.0})]),
            observed_at=self.LATER, max_records=1)
        self.assertEqual(sum(len(rows) for rows in state["first_seen"].values()), 1,
                         "history stays bounded")
        self.assertIn("b", state["first_seen"].get("acme", {}),
                      "the newest first-seen record is the one kept")
        self.assertEqual(state["removed"], {},
                         "pruned history never fabricates a removal")

    def test_long_model_ids_survive_a_history_round_trip(self):
        feed = feed_module()
        prefix = "vendor/model-" + "x" * 70
        long_id = prefix + "-alpha"
        sibling = prefix + "-beta"
        both = models([("acme", long_id, {"input": 1.0, "output": 1.0}),
                       ("acme", sibling, {"input": 1.0, "output": 1.0})])
        state, _ = feed.update_history(None, both, observed_at=self.OBSERVED)
        without = models([("acme", "unrelated", {"input": 1.0, "output": 1.0})])
        for stamp in (self.LATER, self.LATEST):
            state, removals = feed.update_history(state, without, observed_at=stamp)
        self.assertEqual(sorted(record["model"] for record in removals),
                         sorted([long_id, sibling]))
        # A record that survives another publication is re-read from the
        # sidecar: that round trip is where a timestamp-sized cap would shorten
        # the id and merge two siblings.
        state, removals = feed.update_history(
            state, without, observed_at="2026-11-06T00:00:00+00:00")
        self.assertEqual(sorted(record["model"] for record in removals),
                         sorted([long_id, sibling]),
                         "model identity survives the sidecar round trip")
        for record in removals:
            self.assertGreater(len(record["model"]), 64)
        doc, _ = feed.build_feed(without, both, {"announcements": []},
                                 observed_at=self.LATEST, history=state)
        section = next(s for s in doc["briefing"]["sections"] if s["id"] == "removals")
        headlined = {entry["model"] for entry in section["entries"]}
        self.assertEqual(headlined, {long_id, sibling},
                         "two ids sharing a 64-character prefix stay distinguishable")

    def test_curated_removal_note_reaches_the_removals_section(self):
        feed = feed_module()
        snapshot = models([("acme", "alpha", {"input": 1.0, "output": 1.0})])
        curated = {"announcements": [{
            "id": "op-removal-one", "provider": "acme", "model": "alpha",
            "event_type": "removed_from_provider", "confidence": "verified",
            "summary": "Acme has withdrawn alpha.",
            "source_url": "https://acme.example/changelog",
        }]}
        doc, problems = feed.build_feed(snapshot, snapshot, curated,
                                        observed_at=self.OBSERVED)
        self.assertEqual(problems, [])
        section = next(s for s in doc["briefing"]["sections"] if s["id"] == "removals")
        self.assertEqual(section["total"], 1,
                         "an operator's removal note must produce a headline")
        self.assertEqual(section["entries"][0]["model"], "alpha")
        self.assertIn("no longer lists alpha", section["entries"][0]["headline"])
        self.assertEqual(doc["briefing"]["counts"]["removed_from_provider"], 1)
        self.assertNotIn("removals",
                         {entry["id"] for entry in doc["briefing"]["unsupported"]},
                         "a published removal is not a missing capability")

    def test_curated_removal_supersedes_the_inferred_record(self):
        feed = feed_module()
        both = models([("acme", "alpha", {"input": 1.0, "output": 1.0}),
                       ("acme", "beta", {"input": 1.0, "output": 1.0})])
        state, _ = feed.update_history(None, both, observed_at=self.OBSERVED)
        only_alpha = models([("acme", "alpha", {"input": 1.0, "output": 1.0})])
        for stamp in (self.LATER, self.LATEST):
            state, _ = feed.update_history(state, only_alpha, observed_at=stamp)
        curated = {"announcements": [{
            "id": "op-removal-two", "provider": "acme", "model": "beta",
            "event_type": "removed_from_provider", "confidence": "verified",
            "summary": "Acme has withdrawn beta.",
            "source_url": "https://acme.example/changelog",
        }]}
        doc, _ = feed.build_feed(only_alpha, both, curated,
                                 observed_at=self.LATEST, history=state)
        section = next(s for s in doc["briefing"]["sections"] if s["id"] == "removals")
        self.assertEqual(section["total"], 1, "the same removal is not reported twice")
        entry = section["entries"][0]
        self.assertEqual(entry["event_type"], "removed_from_provider")
        self.assertEqual(entry["confidence"], "verified",
                         "the operator's note wins over the inferred record")
        self.assertEqual(entry["source_url"], "https://acme.example/changelog")

    def test_retried_observation_never_confirms_a_removal(self):
        feed = feed_module()
        both = models([("acme", "alpha", {"input": 1.0, "output": 1.0}),
                       ("acme", "beta", {"input": 1.0, "output": 1.0})])
        state, _ = feed.update_history(None, both, observed_at=self.OBSERVED)
        without = models([("acme", "alpha", {"input": 1.0, "output": 1.0})])
        state, removals = feed.update_history(state, without, observed_at=self.LATER)
        self.assertEqual(removals, [])
        self.assertEqual(state["missing"]["acme"]["beta"]["count"], 1)

        # A publisher retry with the same observation must not advance the
        # absence streak: one real missing observation is not two.
        state, removals = feed.update_history(state, without, observed_at=self.LATER)
        self.assertEqual(removals, [], "a retry cannot manufacture a removal")
        self.assertEqual(state["missing"]["acme"]["beta"]["count"], 1)
        self.assertEqual(state["observations"], 2, "a retry is not an observation")

        # Only a genuinely new observation confirms it.
        state, removals = feed.update_history(state, without, observed_at=self.LATEST)
        self.assertEqual([record["model"] for record in removals], ["beta"])

    def test_retried_provider_absence_never_confirms_a_delisting(self):
        feed = feed_module()
        crowded = models([("acme", "alpha", {"input": 1.0, "output": 1.0}),
                          ("gone", "one", {"input": 1.0, "output": 1.0})])
        state, _ = feed.update_history(None, crowded, observed_at=self.OBSERVED)
        fewer = models([("acme", "alpha", {"input": 1.0, "output": 1.0})])
        state, removals = feed.update_history(state, fewer, observed_at=self.LATER)
        state, removals = feed.update_history(state, fewer, observed_at=self.LATER)
        self.assertEqual(removals, [], "a retry cannot delist a provider")
        self.assertEqual(state["provider_absent"]["gone"]["count"], 1)

    def test_corrupt_history_degrades_instead_of_failing(self):
        feed = feed_module()
        current = models([("acme", "alpha", {"input": 1.0, "output": 1.0})])
        state, removals = feed.update_history({"version": 99, "first_seen": "junk"},
                                              current, observed_at=self.OBSERVED)
        self.assertEqual(removals, [])
        self.assertEqual(state["observations"], 1)

    def test_malformed_nested_history_degrades_instead_of_failing(self):
        feed = feed_module()
        current = models([("acme", "alpha", {"input": 1.0, "output": 1.0}),
                          ("acme", "beta", {"input": 1.0, "output": 1.0})])
        corrupt = {
            "version": 1,
            "observations": "many",
            "last_observed_at": ["nope"],
            "first_seen": {"acme": "junk", "broken": None, "ok": {"alpha": "2026-01-01T00:00:00+00:00"}},
            "model_first_seen": {"alpha": 7},
            "missing": {"acme": "junk", "ok": {"alpha": {"count": "two", "since": 5}}},
            "removed": {"acme\u001fgamma": "junk"},
            "provider_absent": {"gone": "junk", "other": {"count": True}},
        }
        state, removals = feed.update_history(corrupt, current,
                                              observed_at=self.OBSERVED)
        self.assertEqual(removals, [], "unvalidated records never become removals")
        self.assertEqual(state["observations"], 1, "a bad counter restarts at zero")
        self.assertEqual(sorted(state["first_seen"]), ["acme", "ok"],
                         "a malformed provider row is dropped; the live one is rebuilt")
        self.assertEqual(state["first_seen"]["ok"], {"alpha": "2026-01-01T00:00:00+00:00"})
        self.assertEqual(sorted(state["first_seen"]["acme"]), ["alpha", "beta"])
        self.assertEqual(state["missing"], {})
        self.assertEqual(state["removed"], {})
        # "ok" claimed a provider the snapshot no longer has: it is a genuine
        # absence, counted once, not a crash and not a removal.
        self.assertEqual(sorted(state["provider_absent"]), ["ok"])
        self.assertEqual(state["provider_absent"]["ok"]["count"], 1)
        self.assertNotIn("gone", state["provider_absent"],
                         "a malformed counter is discarded, not trusted")

    def test_provider_delisting_replaces_its_model_removals(self):
        feed = feed_module()
        crowded = models([("acme", "alpha", {"input": 1.0, "output": 1.0}),
                          ("gone", "one", {"input": 1.0, "output": 1.0})])
        state, _ = feed.update_history(None, crowded, observed_at=self.OBSERVED)
        # The model goes first, then the whole provider.
        without_model = models([("acme", "alpha", {"input": 1.0, "output": 1.0}),
                                ("gone", "two", {"input": 1.0, "output": 1.0})])
        for stamp in (self.LATER, self.LATEST):
            state, _ = feed.update_history(state, without_model, observed_at=stamp)
        self.assertIn("gone\u001fone", state["removed"])
        gone = models([("acme", "alpha", {"input": 1.0, "output": 1.0})])
        for stamp in ("2026-11-06T00:00:00+00:00", "2026-11-07T00:00:00+00:00"):
            state, removals = feed.update_history(state, gone, observed_at=stamp)
        providers = [record["provider"] for record in removals]
        self.assertEqual(providers.count("gone"), 1,
                         "one delisting, not a delisting plus its old model removals")
        self.assertNotIn("gone\u001fone", state["removed"])
        self.assertEqual([record["model"] for record in removals
                          if record["provider"] == "gone"], [""])

    def test_carried_provider_listings_are_dropped_first(self):
        feed = feed_module()
        previous = models([("acme", "seed", {"input": 1.0, "output": 1.0})])
        rows = [("acme", "seed", {"input": 1.0, "output": 1.0})]
        rows += [(f"prov-{n:03d}", "m", {"input": 1.0, "output": 1.0})
                 for n in range(150)]
        first, _ = feed.build_feed(models(rows), previous, {"announcements": []},
                                   observed_at="2026-11-01T00:00:00+00:00")
        # Strip event_type to emulate items carried from a published feed that
        # predates the field, then overflow the cap.
        carried = {"version": 1, "generated_at": first["generated_at"],
                   "items": [{k: v for k, v in item.items() if k != "event_type"}
                             for item in first["items"]]}
        rows2 = [("acme", "seed", {"input": 1.0, "output": 1.0})]
        rows2 += [(f"newprov-{n:03d}", "m", {"input": 1.0, "output": 1.0})
                  for n in range(120)]
        rows2 += [("acme", f"fresh-{n:03d}", {"input": 1.0, "output": 1.0})
                  for n in range(5)]
        doc, problems = feed.build_feed(models(rows2), previous,
                                        {"announcements": []},
                                        observed_at=self.OBSERVED,
                                        prior_feed=carried)
        self.assertEqual(problems, [])
        fresh = [item for item in doc["items"]
                 if str(item.get("model") or "").startswith("fresh-")]
        self.assertEqual(len(fresh), 5, "specific events survive the cap")

    def test_derivable_item_metadata_yields_to_the_byte_budget(self):
        from unittest import mock

        feed = feed_module()
        previous = models([("acme", f"m{n}", {"input": 10.0, "output": 10.0})
                           for n in range(6)])
        current = models([("acme", f"m{n}", {"input": 5.0, "output": 5.0})
                          for n in range(6)])
        with mock.patch.object(feed, "FEED_SOFT_BYTES", 10 ** 9):
            roomy, _ = feed.build_feed(current, previous, {"announcements": []},
                                       observed_at=self.OBSERVED)
        self.assertTrue(all("change" in item for item in roomy["items"]))
        with mock.patch.object(feed, "FEED_SOFT_BYTES", 1):
            tight, problems = feed.build_feed(current, previous, {"announcements": []},
                                              observed_at=self.OBSERVED)
        self.assertEqual(problems, [])
        self.assertEqual(len(tight["items"]), len(roomy["items"]),
                         "the archive is never reduced to fit the budget")
        self.assertTrue(all("change" not in item for item in tight["items"]),
                        "derivable metadata is what gets dropped")
        self.assertNotIn("briefing", tight, "no editorial room at all")

    def test_curated_entry_may_declare_its_event_type(self):
        feed = feed_module()
        previous = models([("acme", "seed", {"input": 1.0, "output": 1.0})])
        curated = {"announcements": [
            {"provider": "acme", "summary": "Acme launches a plan.",
             "source_url": "https://acme.example/news",
             "confidence": "verified", "event_type": "new_plan"},
            {"provider": "acme", "summary": "Bad type.", "event_type": "invented",
             "source_url": "https://acme.example/news"},
        ]}
        doc, problems = feed.build_feed(previous, previous, curated,
                                        observed_at=self.OBSERVED)
        self.assertTrue(any("unknown event_type" in problem for problem in problems))
        kept = [item for item in doc["items"] if item["id"].startswith("sub-")
                or item.get("event_type") == "new_plan"]
        self.assertEqual(len(kept), 1)
        self.assertEqual(kept[0]["event_type"], "new_plan")
        section = next(s for s in doc["briefing"]["sections"] if s["id"] == "subscriptions")
        self.assertEqual(section["total"], 1)

    def test_briefing_is_published_and_validates_on_the_client(self):
        from wolfmark_ledger import news

        feed = feed_module()
        previous = models([("acme", "alpha", {"input": 10.0, "output": 10.0})])
        current = models([("acme", "alpha", {"input": 2.0, "output": 2.0})])
        doc, problems = feed.build_feed(current, previous, {"announcements": []},
                                        observed_at=self.OBSERVED)
        self.assertEqual(problems, [])
        self.assertIn("briefing", doc)
        self.assertEqual(doc["briefing"]["all_updates"]["total"], 1)
        validated, check_problems = news.validate_feed(doc)
        self.assertEqual(check_problems, [])
        self.assertEqual(validated["briefing"]["sections"][0]["entries"][0]["headline"],
                         doc["briefing"]["sections"][0]["entries"][0]["headline"])

    def test_removals_reach_the_briefing_only_through_history(self):
        feed = feed_module()
        both = models([("acme", "alpha", {"input": 1.0, "output": 1.0}),
                       ("acme", "beta", {"input": 1.0, "output": 1.0})])
        state, _ = feed.update_history(None, both, observed_at=self.OBSERVED)
        only_alpha = models([("acme", "alpha", {"input": 1.0, "output": 1.0})])
        for stamp in (self.LATER, self.LATEST):
            state, _ = feed.update_history(state, only_alpha, observed_at=stamp)

        without = feed.build_feed(only_alpha, both, {"announcements": []},
                                  observed_at=self.LATEST)
        reasons = {entry["id"] for entry in without[0]["briefing"]["unsupported"]}
        self.assertIn("removals", reasons)

        with_history = feed.build_feed(only_alpha, both, {"announcements": []},
                                       observed_at=self.LATEST, history=state)
        section = next(s for s in with_history[0]["briefing"]["sections"]
                       if s["id"] == "removals")
        self.assertEqual(section["total"], 1)
        self.assertEqual(section["entries"][0]["model"], "beta")

    def test_truncation_drops_provider_listings_before_model_events(self):
        feed = feed_module()
        previous = models([("acme", "seed", {"input": 1.0, "output": 1.0})])
        rows = [("acme", "seed", {"input": 1.0, "output": 1.0})]
        rows += [(f"prov-{n:03d}", "m", {"input": 1.0, "output": 1.0})
                 for n in range(198)]
        rows += [("acme", f"new-{n:03d}", {"input": 1.0, "output": 1.0})
                 for n in range(10)]
        doc, problems = feed.build_feed(models(rows), previous, {"announcements": []},
                                        observed_at=self.OBSERVED)
        self.assertEqual(problems, [])
        self.assertLessEqual(len(doc["items"]), feed.FEED_MAX_ITEMS)
        kept = [item for item in doc["items"] if item.get("provider") == "acme"
                and item.get("model", "").startswith("new-")]
        self.assertEqual(len(kept), 10, "specific model events survive the cap")

    def test_briefing_is_trimmed_rather_than_overflowing_the_feed(self):
        from unittest import mock

        feed = feed_module()
        previous = models([("acme", "seed", {"input": 1.0, "output": 1.0})])
        current = models(
            [("acme", "seed", {"input": 1.0, "output": 1.0})]
            + [("acme", f"model-{n:03d}", {"input": 1.0, "output": 1.0})
               for n in range(30)])
        doc, _ = feed.build_feed(current, previous, {"announcements": []},
                                 observed_at=self.OBSERVED)
        items = doc["items"]
        skeleton = {"version": 1, "items": items}
        # The function measures the document it is handed, without a briefing.
        base = len(json.dumps(skeleton, separators=(",", ":")))
        full = feed.news_briefing.build_briefing(items, generated_at=self.OBSERVED)
        full_bytes = len(json.dumps(full, separators=(",", ":")))

        with mock.patch.object(feed, "FEED_SOFT_BYTES", base + full_bytes - 1):
            trimmed = feed._fitted_briefing(skeleton, items, self.OBSERVED, [])
        self.assertIsNotNone(trimmed)
        self.assertLess(trimmed["thresholds"]["section_limit"],
                        full["thresholds"]["section_limit"],
                        "the ladder reduces section size before dropping anything")

        with mock.patch.object(feed, "FEED_SOFT_BYTES", base):
            self.assertIsNone(feed._fitted_briefing(skeleton, items, self.OBSERVED, []),
                              "no room at all means no briefing, never a smaller archive")


if __name__ == "__main__":
    unittest.main()
