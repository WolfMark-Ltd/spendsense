"""Model News editorial layer: deterministic briefing, identity and honesty.

Every assertion here is about *not* inventing news: a percentage that cannot be
computed is never printed, a launch is never claimed from a catalogue listing,
and presentation grouping never merges two model versions.
"""
from __future__ import annotations

import json
import unittest

from wolfmark_ledger import news_briefing as nb

OBSERVED = "2026-11-15T00:00:00+00:00"


def price_item(provider, model, previous, current, *, item_id=None, **extra):
    item = {
        "id": item_id or f"md-{provider}-{model}",
        "category": "price_reduction", "provider": provider, "model": model,
        "summary": "", "observed_at": OBSERVED, "effective_at": "",
        "source_url": "https://models.dev", "confidence": "observed",
        "provenance": "models.dev", "previous": previous, "current": current,
    }
    item.update(extra)
    return item


class RateDeltaTests(unittest.TestCase):
    def test_single_rate_move_reports_exact_percentage(self):
        deltas = nb.rate_deltas({"input": 4.0, "output": 16.0},
                                {"input": 2.0, "output": 16.0})
        self.assertEqual(deltas["direction"], "down")
        self.assertEqual(deltas["rates"]["input"]["pct"], -50.0)
        self.assertEqual(deltas["dominant"], "input")
        self.assertEqual(deltas["max_abs_pct"], 50.0)

    def test_mixed_directions_are_not_flattened(self):
        deltas = nb.rate_deltas({"input": 0.15, "output": 1.2},
                                {"input": 0.044, "output": 2.0})
        self.assertEqual(deltas["direction"], "mixed")
        self.assertLess(deltas["rates"]["input"]["pct"], 0)
        self.assertGreater(deltas["rates"]["output"]["pct"], 0)

    def test_zero_baseline_has_a_delta_but_no_percentage(self):
        deltas = nb.rate_deltas({"input": 0.0, "output": 1.0},
                                {"input": 0.2, "output": 1.0})
        self.assertIsNone(deltas["rates"]["input"]["pct"])
        self.assertEqual(deltas["rates"]["input"]["delta"], 0.2)
        self.assertEqual(deltas["incomparable"]["input"], "news_ev_zero_baseline")
        self.assertEqual(deltas["direction"], "up")

    def test_absent_rate_on_one_side_is_incomparable_not_zero(self):
        deltas = nb.rate_deltas({"input": 1.0, "output": 2.0, "cache_read": None},
                                {"input": 1.0, "output": 2.0, "cache_read": 0.1})
        self.assertNotIn("cache_read", deltas["rates"])
        self.assertIn("cache_read", deltas["incomparable"])

    def test_missing_blocks_report_unknown_direction(self):
        deltas = nb.rate_deltas(None, None)
        self.assertEqual(deltas["direction"], "unknown")
        self.assertEqual(deltas["rates"], {})

    def test_identical_rates_are_flat(self):
        deltas = nb.rate_deltas({"input": 1.0, "output": 2.0},
                                {"input": 1.0, "output": 2.0})
        self.assertEqual(deltas["direction"], "flat")
        # Both sides are published, so 0% is a measurement — not an absence.
        self.assertEqual(deltas["max_abs_pct"], 0.0)


class IdentityTests(unittest.TestCase):
    def test_namespace_is_dropped_but_version_is_kept(self):
        self.assertEqual(nb.model_family("moonshotai/kimi-k3"), "kimi-k3")
        self.assertEqual(nb.model_family("deepseek/deepseek-v4.1-flash"),
                         "deepseek-v4.1-flash")

    def test_distinct_versions_stay_distinct(self):
        self.assertNotEqual(nb.model_family("kimi-k3"), nb.model_family("kimi-k3.1-pro"))

    def test_presentation_variant_shares_the_family(self):
        self.assertEqual(nb.model_family("google/gemma-4-26b-a4b-it:thinking"),
                         nb.model_family("google/gemma-4-26b-a4b-it"))

    def test_empty_model_has_no_family(self):
        self.assertEqual(nb.model_family(""), "")
        self.assertEqual(nb.model_family(None), "")

    def test_family_label_is_readable(self):
        self.assertEqual(nb.family_label(nb.model_family("deepseek/deepseek-v4.1-flash")),
                         "DeepSeek V4.1 Flash")

    def test_preview_signal_needs_a_provider_label(self):
        self.assertTrue(nb.preview_signal("tencent/hy4-preview"))
        self.assertTrue(nb.preview_signal("model-x", "Foo Preview"))
        self.assertFalse(nb.preview_signal("claude-sonnet-5"))
        self.assertFalse(nb.preview_signal("previousthing"))


class ClassificationTests(unittest.TestCase):
    def test_provider_listing_is_not_a_model_event(self):
        item = {"id": "md-1", "category": "new_model", "provider": "acme", "model": ""}
        self.assertEqual(nb.classify_event(item), "provider_listed")

    def test_new_model_without_evidence_is_not_a_launch(self):
        item = {"id": "md-1", "category": "new_model", "provider": "acme", "model": "alpha"}
        self.assertEqual(nb.classify_event(item), "new_to_catalogue")

    def test_explicit_event_type_wins(self):
        item = {"id": "md-1", "category": "new_model", "provider": "acme",
                "model": "alpha", "event_type": "newly_available"}
        self.assertEqual(nb.classify_event(item), "newly_available")

    def test_price_category_is_refined_from_its_own_rates(self):
        item = price_item("acme", "alpha", {"input": 0.15, "output": 1.2},
                          {"input": 0.044, "output": 2.0})
        item["category"] = "price_increase"
        self.assertEqual(nb.classify_event(item), "price_mixed")

    def test_subscription_events_are_plan_events(self):
        base = {"id": "sub-1", "category": "subscription", "provider": "acme"}
        self.assertEqual(nb.classify_event({**base, "summary_code": "news_sum_new_plan"}),
                         "new_plan")
        self.assertEqual(nb.classify_event(base), "plan_change")


class BriefingTests(unittest.TestCase):
    def build(self, items, **kwargs):
        return nb.build_briefing(items, generated_at=OBSERVED, **kwargs)

    def section(self, briefing, name):
        return next(s for s in briefing["sections"] if s["id"] == name)

    def test_biggest_changes_are_split_and_ranked(self):
        items = [
            price_item("acme", "big-cut", {"input": 10.0, "output": 10.0},
                       {"input": 2.0, "output": 2.0}),
            price_item("acme", "small-cut", {"input": 10.0, "output": 10.0},
                       {"input": 9.9, "output": 9.9}),
            price_item("acme", "rise", {"input": 2.0, "output": 2.0},
                       {"input": 4.0, "output": 4.0}),
        ]
        briefing = self.build(items)
        reductions = self.section(briefing, "biggest_reductions")
        increases = self.section(briefing, "biggest_increases")
        self.assertEqual(reductions["entries"][0]["model"], "big-cut")
        self.assertEqual([entry["model"] for entry in reductions["entries"]], ["big-cut"])
        self.assertEqual([entry["model"] for entry in increases["entries"]], ["rise"])
        self.assertEqual(briefing["counts"]["price_reduction"], 2,
                         "a below-threshold change is still counted")

    def test_headline_never_prints_a_percentage_against_zero(self):
        items = [price_item("acme", "alpha", {"input": 0.0, "output": 1.0},
                            {"input": 0.5, "output": 1.0})]
        entry = self.section(self.build(items), "biggest_increases")["entries"][0]
        self.assertEqual(entry["headline_code"], "news_head_from_zero")
        self.assertNotIn("%", entry["headline"])
        self.assertIn("no meaningful percentage", entry["headline"])

    def test_headline_names_the_materially_largest_rate(self):
        items = [price_item("acme", "alpha",
                            {"input": 1.0, "output": 10.0, "cache_read": 0.001},
                            {"input": 1.2, "output": 20.0, "cache_read": 0.02})]
        entry = self.section(self.build(items), "biggest_increases")["entries"][0]
        self.assertEqual(entry["magnitude"]["rate"], "output")
        self.assertIn("output", entry["headline"])
        self.assertIn("100%", entry["headline"])

    def test_mixed_change_gets_its_own_section_and_both_directions(self):
        item = price_item("acme", "alpha", {"input": 4.0, "output": 1.0},
                          {"input": 2.0, "output": 3.0})
        entry = self.section(self.build([item]), "mixed_price_changes")["entries"][0]
        self.assertEqual(entry["event_type"], "price_mixed")
        self.assertIn("both directions", entry["headline"])
        self.assertIn("input", entry["headline"])
        self.assertIn("output", entry["headline"])

    def test_family_banner_groups_variants_without_merging_identity(self):
        items = [
            price_item("p1", "vendor/kimi-k3", {"input": 3.0, "output": 15.0},
                       {"input": 2.0, "output": 10.0}),
            price_item("p2", "kimi-k3", {"input": 3.0, "output": 15.0},
                       {"input": 2.25, "output": 11.25}),
        ]
        group = self.section(self.build(items), "biggest_reductions")["entries"][0]
        self.assertEqual(group["headline_code"], "news_head_group")
        self.assertEqual(group["family_event_count"], 2)
        self.assertEqual(sorted(row["model"] for row in group["variants"]),
                         ["kimi-k3", "vendor/kimi-k3"],
                         "exact model ids survive grouping")
        self.assertEqual(len(group["event_ids"]), 2)

    def test_without_history_removals_are_reported_unsupported(self):
        briefing = self.build([])
        reasons = {entry["id"]: entry["reason_code"] for entry in briefing["unsupported"]}
        self.assertEqual(reasons["removals"], "news_unsupported_no_absence_history")
        self.assertEqual(reasons["subscriptions"], "news_unsupported_no_plan_events")

    def test_confirmed_removal_becomes_a_headline(self):
        removals = [{"provider": "acme", "model": "alpha", "removed_at": OBSERVED,
                     "consecutive": 2, "source_url": "https://models.dev"}]
        entry = self.section(self.build([], removals=removals), "removals")["entries"][0]
        self.assertEqual(entry["event_type"], "removed_from_provider")
        self.assertIn("no longer lists alpha", entry["headline"])
        self.assertIn("2 catalogue observations", entry["headline"])

    def test_provider_delisting_is_a_single_event(self):
        removals = [{"provider": "acme", "model": "", "removed_at": OBSERVED,
                     "consecutive": 2}]
        entry = self.section(self.build([], removals=removals), "removals")["entries"][0]
        self.assertEqual(entry["event_type"], "provider_delisted")

    def test_provider_listings_never_reach_a_headline(self):
        item = {"id": "md-prov", "category": "new_model", "provider": "obscure",
                "model": "", "summary": "obscure newly listed.",
                "observed_at": OBSERVED, "source_url": "https://models.dev"}
        briefing = self.build([item])
        headlined = {entry["event_type"] for section in briefing["sections"]
                     for entry in section["entries"]}
        self.assertNotIn("provider_listed", headlined)
        self.assertEqual(briefing["counts"]["provider_listed"], 1)

    def test_preview_section_only_covers_new_observations(self):
        new_preview = {"id": "md-p1", "category": "new_model", "provider": "acme",
                       "model": "alpha-preview", "summary": "", "observed_at": OBSERVED,
                       "source_url": "https://models.dev"}
        price_preview = price_item("acme", "alpha-preview",
                                   {"input": 2.0, "output": 2.0},
                                   {"input": 1.0, "output": 1.0})
        briefing = self.build([new_preview, price_preview])
        preview = self.section(briefing, "preview_models")
        self.assertEqual([entry["model"] for entry in preview["entries"]],
                         ["alpha-preview"])
        self.assertEqual(len(preview["entries"][0]["variants"]), 1,
                         "the price change on a known preview model is not a discovery")
        self.assertEqual(preview["entries"][0]["headline_code"],
                         "news_head_preview_observed")

    def test_new_entry_claims_no_launch_without_verified_confidence(self):
        item = {"id": "md-n1", "category": "new_model", "provider": "acme",
                "model": "delta", "summary": "", "observed_at": OBSERVED,
                "source_url": "https://models.dev", "confidence": "observed",
                "first_seen_at": "2026-11-01T00:00:00+00:00"}
        entry = self.section(self.build([item]), "new_models")["entries"][0]
        self.assertEqual(entry["headline_code"], "news_head_new_to_catalogue")
        self.assertNotIn("launches", entry["headline"])
        self.assertIn("2026-11-01", entry["headline"])

    def test_unobserved_new_entry_states_it_claims_no_launch(self):
        item = {"id": "md-n2", "category": "new_model", "provider": "acme",
                "model": "delta", "summary": "", "observed_at": OBSERVED,
                "source_url": "https://models.dev", "confidence": "observed"}
        entry = self.section(self.build([item]), "new_models")["entries"][0]
        self.assertIn("no launch claim", entry["headline"])

    def test_verified_entry_may_say_launched(self):
        item = {"id": "sub-1", "category": "new_model", "provider": "acme",
                "model": "omega", "summary": "", "observed_at": OBSERVED,
                "source_url": "https://acme.example/news",
                "confidence": "verified", "event_type": "new_to_catalogue"}
        entry = self.section(self.build([item]), "new_models")["entries"][0]
        self.assertEqual(entry["headline_code"], "news_head_launched")

    def test_briefing_is_deterministic(self):
        items = [price_item(f"p{n}", f"m{n}", {"input": 2.0, "output": 2.0},
                            {"input": 1.0, "output": 1.0}) for n in range(6)]
        self.assertEqual(json.dumps(self.build(items)), json.dumps(self.build(items)))

    def test_all_updates_count_is_the_archive_not_the_headlines(self):
        items = [price_item(f"p{n}", f"m{n}", {"input": 10.0, "output": 10.0},
                            {"input": 9.9, "output": 9.9}) for n in range(12)]
        briefing = self.build(items)
        self.assertEqual(briefing["all_updates"]["total"], 12)
        self.assertEqual(briefing["counts"]["headlined"], 0)


class SanitiseTests(unittest.TestCase):
    def test_rejects_unknown_version_and_non_objects(self):
        self.assertIsNone(nb.sanitise_briefing({"version": 2, "sections": []}))
        self.assertIsNone(nb.sanitise_briefing([]))
        self.assertIsNone(nb.sanitise_briefing({"version": 1, "sections": "nope"}))

    def test_drops_unusable_entries_and_bounds_sections(self):
        raw = {"version": 1, "generated_at": OBSERVED, "sections": [
            {"id": f"s{n}", "title_code": "t", "entries": [
                {"provider": "acme", "headline": "ok", "score": 1},
                {"provider": "", "headline": "no provider"},
                "not an object",
            ]} for n in range(40)]}
        cleaned = nb.sanitise_briefing(raw)
        self.assertEqual(len(cleaned["sections"]), nb._MAX_SECTIONS)
        self.assertEqual([entry["headline"] for entry in cleaned["sections"][0]["entries"]],
                         ["ok"])

    def test_truncates_oversized_text(self):
        raw = {"version": 1, "sections": [{"id": "s", "entries": [
            {"provider": "acme", "headline": "x" * 5000}]}]}
        cleaned = nb.sanitise_briefing(raw)
        self.assertEqual(len(cleaned["sections"][0]["entries"][0]["headline"]),
                         nb._MAX_TEXT)

    def test_keeps_a_valid_briefing_intact(self):
        briefing = nb.build_briefing(
            [price_item("acme", "alpha", {"input": 4.0, "output": 4.0},
                        {"input": 2.0, "output": 2.0})],
            generated_at=OBSERVED)
        cleaned = nb.sanitise_briefing(json.loads(json.dumps(briefing)))
        self.assertEqual([len(section["entries"]) for section in cleaned["sections"]],
                         [len(section["entries"]) for section in briefing["sections"]])
        self.assertEqual(cleaned["sections"][0]["entries"][0]["headline"],
                         briefing["sections"][0]["entries"][0]["headline"])


if __name__ == "__main__":
    unittest.main()
