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

    def test_tiny_move_is_still_a_direction(self):
        # $2 -> $1 down, $100 -> $100.01 up: the rise rounds to 0.0%, but the
        # event is mixed and must not be reported as a one-way cut.
        deltas = nb.rate_deltas({"input": 2.0, "output": 100.0},
                                {"input": 1.0, "output": 100.01})
        self.assertEqual(deltas["direction"], "mixed")
        self.assertEqual(deltas["rates"]["output"]["pct"], 0.0)
        item = price_item("acme", "alpha", {"input": 2.0, "output": 100.0},
                          {"input": 1.0, "output": 100.01})
        self.assertEqual(nb.classify_event(item), "price_mixed")

    def test_direction_survives_a_delta_that_rounds_to_zero(self):
        # A move smaller than half a micro-dollar rounds away at six decimals.
        # The published rates still differ, so the direction must not vanish.
        deltas = nb.rate_deltas({"input": 1.0000004, "output": 2.0},
                                {"input": 1.0000001, "output": 2.0})
        self.assertEqual(deltas["rates"]["input"]["delta"], 0.0)
        self.assertEqual(deltas["direction"], "down")
        mixed = nb.rate_deltas({"input": 1.0000004, "output": 2.0000001},
                               {"input": 1.0000001, "output": 2.0000004})
        self.assertEqual(mixed["direction"], "mixed",
                         "opposite sub-micro moves are a real mixed change")

    def test_mixed_move_with_a_zero_baseline_reports_no_percentage(self):
        item = price_item("acme", "alpha", {"input": 0.0, "output": 2.0},
                          {"input": 1.0, "output": 1.0})
        entry = nb._entry(item)
        self.assertEqual(entry["event_type"], "price_mixed")
        self.assertIsNone(entry["headline_params"]["raised_pct"],
                          "an undefined percentage must not render as 0%")
        self.assertIn("$0", entry["headline_params"]["raised_values"])
        self.assertIn("$1", entry["headline_params"]["raised_values"])
        self.assertNotIn("0%", entry["headline"])

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

    def test_family_label_keeps_a_welded_version_in_vendor_casing(self):
        # `qwen3.5` is one token; uppercasing the whole token would print
        # `QWEN3.5`, which is not how the vendor writes it. The brand prefix
        # decides the casing and the version stays exactly as published.
        self.assertEqual(nb.family_label(nb.model_family("qwen3.5-9b")), "Qwen3.5 9B")
        self.assertEqual(nb.family_label(nb.model_family("glm-5.3-flash")), "GLM 5.3 Flash")
        self.assertEqual(nb.family_label(nb.model_family("kimi-k3")), "Kimi K3")

    def test_preview_signal_needs_a_provider_label(self):
        self.assertTrue(nb.preview_signal("tencent/hy4-preview"))
        self.assertTrue(nb.preview_signal("model-x", "Foo Preview"))
        self.assertFalse(nb.preview_signal("claude-sonnet-5"))
        self.assertFalse(nb.preview_signal("previousthing"))


class RemovalWindowTests(unittest.TestCase):
    """The removal window compares instants, so both ends must be comparable.

    ``generated_at`` and a stored ``removed_at`` can arrive with different
    timezone discipline — a publisher may write a naive ISO stamp while the
    history sidecar carries an explicit offset. Normalising only one side turned
    a dated removal into a TypeError, which is a crash in the publication path.
    """

    def brief(self, generated_at, removed_at):
        removals = [{"provider": "acme", "model": "alpha", "removed_at": removed_at,
                     "consecutive": 2}]
        return nb.build_briefing([], generated_at=generated_at, removals=removals,
                                 removal_tracking=True)

    def removal_models(self, briefing):
        section = next(row for row in briefing["sections"] if row["id"] == "removals")
        return [entry["model"] for entry in section["entries"]]

    def test_a_naive_generated_at_can_still_judge_an_aware_removal(self):
        briefing = self.brief("2026-11-10T12:00:00", "2026-11-09T00:00:00Z")
        self.assertEqual(self.removal_models(briefing), ["alpha"])

    def test_an_aware_generated_at_can_still_judge_a_naive_removal(self):
        briefing = self.brief("2026-11-10T12:00:00+00:00", "2026-11-09T00:00:00")
        self.assertEqual(self.removal_models(briefing), ["alpha"])

    def test_two_naive_stamps_are_compared_in_utc(self):
        briefing = self.brief("2026-11-10T12:00:00", "2026-11-09T00:00:00")
        self.assertEqual(self.removal_models(briefing), ["alpha"])

    def test_a_naive_generated_at_still_rejects_a_future_removal(self):
        for generated_at, removed_at in (
            ("2026-11-10T12:00:00", "2026-11-11T00:00:00Z"),
            ("2026-11-10T12:00:00+00:00", "2026-11-11T00:00:00"),
            ("2026-11-10T12:00:00", "2026-11-11T00:00:00"),
        ):
            briefing = self.brief(generated_at, removed_at)
            self.assertEqual(self.removal_models(briefing), [],
                             f"a record observed after publication is not news: {generated_at}")

    def test_an_undated_removal_is_still_kept(self):
        for generated_at in ("2026-11-10T12:00:00", "2026-11-10T12:00:00+00:00"):
            briefing = self.brief(generated_at, "")
            self.assertEqual(self.removal_models(briefing), ["alpha"],
                             "a format is not grounds to drop a confirmed removal")


class MaterialityTests(unittest.TestCase):
    def test_a_price_event_with_no_comparable_rate_is_never_headlined(self):
        item = {"id": "md-1", "provider": "acme", "model": "m1",
                "category": "price_increase",
                "previous": {"input": 2.0}, "current": {"output": 4.0},
                "observed_at": "2026-11-10T00:00:00Z"}
        briefing = nb.build_briefing([item], generated_at="2026-11-10T12:00:00Z")
        section = {row["id"]: row for row in briefing["sections"]}["biggest_increases"]
        self.assertEqual(section["total"], 0)
        self.assertEqual(briefing["counts"]["events"], 1)
        self.assertEqual(briefing["counts"]["price_increase"], 1)

    def test_a_move_from_zero_is_judged_on_its_dollar_delta(self):
        item = {"id": "md-2", "provider": "acme", "model": "m1",
                "category": "price_increase",
                "previous": {"input": 0.0}, "current": {"input": 0.25},
                "observed_at": "2026-11-10T00:00:00Z"}
        briefing = nb.build_briefing([item], generated_at="2026-11-10T12:00:00Z")
        section = {row["id"]: row for row in briefing["sections"]}["biggest_increases"]
        self.assertEqual(section["total"], 1)

    def test_a_preview_listing_appears_in_one_section_only(self):
        item = {"id": "md-3", "provider": "acme", "model": "acme-x-preview",
                "category": "new_model", "current": {"input": 1.0, "output": 2.0},
                "observed_at": "2026-11-10T00:00:00Z"}
        briefing = nb.build_briefing([item], generated_at="2026-11-10T12:00:00Z")
        hits = [section["id"] for section in briefing["sections"]
                if any("md-3" in entry.get("event_ids", []) for entry in section["entries"])]
        self.assertEqual(hits, ["preview_models"])

    def test_the_removal_window_rejects_a_record_dated_after_publication(self):
        self.assertTrue(nb._within_window("2026-11-09T00:00:00Z", "2026-11-10T12:00:00Z", 90))
        self.assertFalse(nb._within_window("2026-11-11T00:00:00Z", "2026-11-10T12:00:00Z", 90))
        self.assertFalse(nb._within_window("2026-01-01T00:00:00Z", "2026-11-10T12:00:00Z", 90))
        # Undated evidence is kept: a format is not grounds to drop a record.
        self.assertTrue(nb._within_window("", "2026-11-10T12:00:00Z", 90))


    def test_a_huge_percentage_on_a_sub_cent_rate_is_counted_never_headlined(self):
        item = {"id": "md-9", "provider": "acme", "model": "m1",
                "category": "price_increase",
                "previous": {"cache_read": 0.0001}, "current": {"cache_read": 0.00195},
                "observed_at": "2026-11-10T00:00:00Z"}
        briefing = nb.build_briefing([item], generated_at="2026-11-10T12:00:00Z")
        section = {row["id"]: row for row in briefing["sections"]}["biggest_increases"]
        self.assertEqual(section["total"], 0,
                         "1 850% of a sub-cent rate must not outrank a real change")
        self.assertEqual(briefing["counts"]["price_increase"], 1,
                         "it is still counted, never hidden")

    def test_a_real_move_past_both_floors_is_headlined(self):
        item = {"id": "md-10", "provider": "acme", "model": "m1",
                "category": "price_increase",
                "previous": {"input": 1.0}, "current": {"input": 3.0},
                "observed_at": "2026-11-10T00:00:00Z"}
        briefing = nb.build_briefing([item], generated_at="2026-11-10T12:00:00Z")
        section = {row["id"]: row for row in briefing["sections"]}["biggest_increases"]
        self.assertEqual(section["total"], 1)

    def test_a_mixed_headline_needs_both_directions_measured(self):
        only_up = {"id": "md-11", "provider": "acme", "model": "m1",
                   "event_type": "price_mixed",
                   "previous": {"input": 1.0}, "current": {"input": 2.0},
                   "observed_at": "2026-11-10T00:00:00Z"}
        briefing = nb.build_briefing([only_up], generated_at="2026-11-10T12:00:00Z")
        section = {row["id"]: row for row in briefing["sections"]}["mixed_price_changes"]
        self.assertEqual(section["total"], 0, "nothing fell, so nothing is mixed")
        self.assertEqual(briefing["counts"]["price_mixed"], 1)
        both_ways = {"id": "md-12", "provider": "acme", "model": "m2",
                     "event_type": "price_mixed",
                     "previous": {"input": 1.0, "output": 10.0},
                     "current": {"input": 2.0, "output": 5.0},
                     "observed_at": "2026-11-10T00:00:00Z"}
        briefing = nb.build_briefing([both_ways], generated_at="2026-11-10T12:00:00Z")
        section = {row["id"]: row for row in briefing["sections"]}["mixed_price_changes"]
        self.assertEqual(section["total"], 1)

    def test_a_positive_rate_is_never_rendered_as_free(self):
        self.assertEqual(nb._rate_text(0), "$0")
        self.assertEqual(nb._rate_text(0.00000025), "$0.00000025")
        self.assertEqual(nb._rate_text(1.25), "$1.25")
        self.assertEqual(nb._rate_text(None), "—")

    def test_removal_groups_order_by_instant_not_by_stamp_text(self):
        removals = [
            {"provider": "acme", "model": "acme-older", "consecutive": 2,
             "removed_at": "2026-11-10T00:30:00+02:00"},
            {"provider": "acme", "model": "acme-old", "consecutive": 2,
             "removed_at": "2026-11-09T23:30:00Z"},
        ]
        briefing = nb.build_briefing([], generated_at="2026-11-10T12:00:00Z",
                                     removals=removals, removal_tracking=True)
        section = {row["id"]: row for row in briefing["sections"]}["removals"]
        self.assertEqual([entry["model"] for entry in section["entries"]],
                         ["acme-old", "acme-older"])

    def test_an_unmeasured_price_category_is_counted_never_headlined(self):
        # The category claims a cut; the rates show no measurable move, so no
        # section may repeat the claim. The event is still counted.
        item = price_item("acme", "alpha", {"input": 1.0, "output": 2.0},
                          {"input": 1.0, "output": 2.0})
        briefing = nb.build_briefing([item], generated_at=OBSERVED)
        self.assertEqual(briefing["counts"]["price_reduction"], 1)
        self.assertEqual({row["id"]: row for row in briefing["sections"]}
                         ["biggest_reductions"]["total"], 0)
        self.assertEqual(briefing["counts"]["events"], 1,
                         "the event stays part of the supplied archive")

    def test_a_zero_baseline_move_must_agree_with_its_class(self):
        # A published event may assert its own type. A rise from zero is an
        # increase and stays one; the same rise claimed as a reduction is
        # rejected by the direction predicate, not headlined as a cut.
        rise = price_item("acme", "alpha", {"input": 0.0}, {"input": 0.5},
                          event_type="price_increase")
        rise_sections = {row["id"]: row for row in nb.build_briefing(
            [rise], generated_at=OBSERVED)["sections"]}
        self.assertEqual(rise_sections["biggest_increases"]["total"], 1,
                         "a zero-baseline increase is preserved")
        claimed_cut = price_item("acme", "alpha", {"input": 0.0}, {"input": 0.5},
                                 event_type="price_reduction")
        briefing = nb.build_briefing([claimed_cut], generated_at=OBSERVED)
        self.assertEqual({row["id"]: row for row in briefing["sections"]}
                         ["biggest_reductions"]["total"], 0)
        self.assertEqual(briefing["counts"]["price_reduction"], 1,
                         "the rejected event is still counted")

    def test_a_group_carries_the_newest_member_date(self):
        head = price_item("acme", "acme-x", {"input": 10.0}, {"input": 5.0},
                          observed_at="2026-11-01T00:00:00Z")
        fresher = price_item("zeta", "acme-x:thinking", {"input": 10.0},
                             {"input": 6.0}, observed_at="2026-11-09T00:00:00Z")
        group = nb.build_briefing([head, fresher],
                                  generated_at=OBSERVED)["sections"][0]["entries"][0]
        self.assertEqual(group["model_family"], "acme-x")
        self.assertEqual(group["observed_at"], "2026-11-09T00:00:00Z",
                         "the group date is its newest member, not the head's")
        undated = price_item("acme", "beta-y", {"input": 10.0}, {"input": 5.0},
                             observed_at="")
        dated = price_item("zeta", "beta-y:flex", {"input": 10.0}, {"input": 5.0},
                           observed_at="2026-11-02T00:00:00Z")
        self.assertEqual(nb.build_briefing([undated, dated], generated_at=OBSERVED)
                         ["sections"][0]["entries"][0]["observed_at"],
                         "2026-11-02T00:00:00Z",
                         "an undated member never wins the group date")

    def test_a_removal_family_orders_by_its_newest_member(self):
        older = price_item("acme", "acme-a", {"input": 1.0}, {"input": 1.0},
                           observed_at="2026-11-01T00:00:00Z",
                           event_type="removed_from_provider")
        newer = price_item("acme", "acme-a:thinking", {"input": 1.0}, {"input": 1.0},
                           observed_at="2026-11-09T00:00:00Z",
                           event_type="removed_from_provider")
        other = price_item("zeta", "zeta-b", {"input": 1.0}, {"input": 1.0},
                           observed_at="2026-11-05T00:00:00Z",
                           event_type="removed_from_provider")
        section = {row["id"]: row for row in nb.build_briefing(
            [older, newer, other], generated_at=OBSERVED)["sections"]}
        self.assertEqual([entry["model_family"] for entry in section["removals"]["entries"]],
                         ["acme-a", "zeta-b"],
                         "the family sorts on its freshest member, not its head")


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

    def test_a_zero_baseline_increase_stays_an_increase(self):
        item = price_item("acme", "alpha", {"input": 0.0}, {"input": 0.5})
        item["category"] = "price_increase"
        self.assertEqual(nb.classify_event(item), "price_increase")

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

    def test_tier_only_change_is_not_a_zero_percent_price_move(self):
        item = price_item("acme", "alpha", {"input": 2.0, "output": 4.0},
                          {"input": 2.0, "output": 4.0})
        item["has_tiers"] = True
        entry = nb._entry(item)
        self.assertEqual(entry["headline_code"], "news_head_tiers_changed")
        self.assertNotIn("%", entry["headline"])
        self.assertEqual(nb.build_briefing([item])["counts"]["headlined"], 0)

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

    def test_identical_rows_collapse_into_one_observed_count(self):
        # UAT: one transition re-observed (recurrence plus central echo)
        # rendered three identical rows. Same displayed row collapses with
        # every id surviving; a distinct transition stays its own row.
        same = lambda item_id, observed: price_item(
            "openrouter", "z-ai/glm-5.3-flash",
            {"input": 0.15, "output": 0.5}, {"input": 0.0399, "output": 0.0784},
            item_id=item_id, observed_at=observed)
        items = [same("md-1", "2026-11-22T10:40:00+00:00"),
                 price_item("openrouter", "z-ai/glm-5.3-flash",
                            {"input": 0.15, "output": 0.5},
                            {"input": 0.12, "output": 0.38},
                            item_id="md-other",
                            observed_at="2026-11-23T00:00:00+00:00"),
                 same("md-2", "2026-11-22T21:08:00+00:00"),
                 same("md-3", "2026-11-22T22:29:00+00:00")]
        group = self.section(self.build(items), "biggest_reductions")["entries"][0]
        self.assertEqual(group["family_event_count"], 4)
        self.assertEqual(sorted(group["event_ids"]),
                         ["md-1", "md-2", "md-3", "md-other"])
        self.assertEqual(len(group["variants"]), 2)
        collapsed = next(v for v in group["variants"]
                         if v.get("observed_count") == 3)
        self.assertEqual(sorted(collapsed["event_ids"]), ["md-1", "md-2", "md-3"])
        self.assertEqual(collapsed["observed_at"], "2026-11-22T22:29:00+00:00")
        lone = next(v for v in group["variants"] if "observed_count" not in v)
        self.assertEqual(lone["event_ids"], ["md-other"])

    def test_conflicting_source_urls_stay_separate(self):
        # Same displayed row, but two non-empty source URLs that differ are
        # distinct observations: each keeps its own row and evidence link.
        # A missing URL never conflicts.
        def same(item_id, source_url):
            return price_item(
                "acme", "acme-1", {"input": 10.0}, {"input": 5.0},
                item_id=item_id, source_url=source_url)
        clashing = self.section(self.build([
            same("md-u1", "https://example.com/a"),
            same("md-u2", "https://example.com/b"),
        ]), "biggest_reductions")["entries"][0]
        self.assertEqual(len(clashing["variants"]), 2)
        self.assertTrue(all("observed_count" not in v for v in clashing["variants"]))
        missing = self.section(self.build([
            same("md-u3", "https://example.com/a"),
            same("md-u4", ""),
        ]), "biggest_reductions")["entries"][0]
        (collapsed,) = missing["variants"]
        self.assertEqual(collapsed["observed_count"], 2)

    def test_collapse_key_ignores_unrendered_params(self):
        base = dict(provider="acme", model="acme-1", event_type="price_reduction",
                    headline_code="news_head_single_rate", headline="row",
                    headline_params={"provider": "acme", "pct": -50.0,
                                     "direction": "down"})
        stamp = dict(base, headline_params={**base["headline_params"],
                                            "observed_at": "2026-11-02"})
        self.assertEqual(nb._row_key(base), nb._row_key(stamp))
        confident = dict(base, headline_params={**base["headline_params"],
                                                "confidence": "verified"})
        self.assertEqual(nb._row_key(base), nb._row_key(confident))
        moved = dict(base, headline_params={**base["headline_params"], "pct": -40.0})
        self.assertNotEqual(nb._row_key(base), nb._row_key(moved))

    def test_mixed_rows_collapse_when_only_percentages_differ(self):
        # The mixed row names raised/cut rates, never their percentages.
        def mixed(item_id, observed, after):
            return price_item(
                "openrouter", "z-ai/glm-5.3-flash",
                {"input": 0.15, "output": 0.5, "cache_read": 0.03}, after,
                item_id=item_id, observed_at=observed)
        items = [mixed("md-x", "2026-11-24T05:46:00+00:00",
                       {"input": 0.77, "output": 2.5, "cache_read": 0.02}),
                 mixed("md-y", "2026-11-24T07:41:00+00:00",
                       {"input": 0.73, "output": 2.4, "cache_read": 0.02})]
        group = self.section(self.build(items), "mixed_price_changes")["entries"][0]
        (variant,) = group["variants"]
        self.assertEqual(variant["observed_count"], 2)
        self.assertEqual(sorted(variant["event_ids"]), ["md-x", "md-y"])

    def test_grouped_rows_stay_localisable(self):
        items = [
            price_item("p1", "kimi-k3", {"input": 3.0, "output": 15.0},
                       {"input": 2.0, "output": 10.0}),
            price_item("p2", "kimi-k3", {"input": 3.0, "output": 15.0},
                       {"input": 2.4, "output": 12.0}),
        ]
        group = self.section(self.build(items), "biggest_reductions")["entries"][0]
        self.assertEqual(group["headline_code"], "news_head_group")
        for variant in group["variants"]:
            self.assertIn("headline_code", variant,
                          "a provider row must be translatable, not English-only")
            self.assertIn("headline_params", variant)
            self.assertIn(variant["headline_code"],
                          {"news_head_single_rate", "news_head_all_rates"})

    def test_a_large_family_keeps_every_event_link(self):
        items = [price_item(f"p{n:02d}", "kimi-k3", {"input": 3.0, "output": 15.0},
                            {"input": 2.0, "output": 10.0}) for n in range(13)]
        group = self.section(self.build(items), "biggest_reductions")["entries"][0]
        self.assertEqual(len(group["event_ids"]), 13,
                         "links are cheap; the banner count and the links must agree")
        self.assertEqual(group["family_event_count"], 13)
        self.assertEqual(len(group["variants"]), nb._MAX_VARIANTS,
                         "only the rendered rows are capped")

    def test_without_history_removals_are_reported_unsupported(self):
        briefing = self.build([])
        reasons = {entry["id"]: entry["reason_code"] for entry in briefing["unsupported"]}
        self.assertEqual(reasons["removals"], "news_unsupported_no_absence_history")
        self.assertEqual(reasons["subscriptions"], "news_unsupported_no_plan_events")

    def test_old_removals_do_not_crowd_out_a_new_one(self):
        old = [{"provider": f"p{n}", "model": f"m{n}",
                "removed_at": "2026-01-01T00:00:00+00:00", "consecutive": 2}
               for n in range(12)]
        fresh = {"provider": "acme", "model": "beta",
                 "removed_at": "2026-11-14T00:00:00+00:00", "consecutive": 2}
        briefing = nb.build_briefing([], generated_at=OBSERVED,
                                     removals=[*old, fresh], removal_tracking=True)
        section = self.section(briefing, "removals")
        self.assertEqual([entry["model"] for entry in section["entries"]], ["beta"],
                         "a fresh removal is not pushed out by stale records")
        self.assertEqual(section["total"], 1, "stale records leave the news window")

    def test_working_removal_detection_is_not_reported_as_unavailable(self):
        briefing = nb.build_briefing([], generated_at=OBSERVED,
                                     removals=[], removal_tracking=True)
        reasons = {entry["id"] for entry in briefing["unsupported"]}
        self.assertNotIn("removals", reasons,
                         "an empty section on working detection is not a limitation")
        self.assertEqual(briefing["counts"]["removed_from_provider"], 0)

    def test_removals_are_counted_with_their_headlines(self):
        removals = [{"provider": "acme", "model": "alpha", "removed_at": OBSERVED,
                     "consecutive": 2},
                    {"provider": "gone", "model": "", "removed_at": OBSERVED,
                     "consecutive": 2}]
        briefing = nb.build_briefing([], generated_at=OBSERVED, removals=removals,
                                     removal_tracking=True)
        self.assertEqual(briefing["counts"]["removed_from_provider"], 1)
        self.assertEqual(briefing["counts"]["provider_delisted"], 1)
        self.assertEqual(self.section(briefing, "removals")["total"], 2)

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

    def test_non_finite_numbers_dropped_from_entries_and_maps(self):
        # F120: a buggy feed can smuggle NaN/Infinity through entry numbers,
        # scalar maps and their list members. All are dropped; the entry stays.
        raw = {"version": 1, "sections": [{"id": "s", "entries": [{
            "provider": "acme", "headline": "ok", "score": float("nan"),
            "family_event_count": float("inf"),
            "headline_params": {"pct": float("nan"), "note": "kept"},
            "magnitude": {"max_abs_pct": float("inf")},
        }]}],
            "counts": {"headlined": float("nan"), "total": 1},
            "all_updates": {"totals": [1, float("inf")]},
        }
        cleaned = nb.sanitise_briefing(raw)
        (entry,) = cleaned["sections"][0]["entries"]
        self.assertNotIn("score", entry)
        self.assertNotIn("family_event_count", entry)
        self.assertEqual(entry["headline_params"], {"note": "kept"})
        self.assertNotIn("magnitude", entry)
        self.assertEqual(cleaned["counts"], {"total": 1})
        self.assertEqual(cleaned["all_updates"], {"totals": [1]})

    def test_observed_count_survives_sanitising(self):
        raw = {"version": 1, "sections": [{"id": "s", "entries": [{
            "provider": "acme", "headline": "ok",
            "variants": [{"provider": "acme", "headline": "row",
                          "observed_count": 3}]}]}]}
        cleaned = nb.sanitise_briefing(raw)
        (variant,) = cleaned["sections"][0]["entries"][0]["variants"]
        self.assertEqual(variant["observed_count"], 3)

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
