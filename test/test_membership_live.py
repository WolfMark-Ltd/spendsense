"""Optional central membership-plan catalogue: fetch, cache and validate.

Mirrors the Model News central-fetch discipline: nothing touches the
network unless Live Updates is on, the request carries static headers
only, oversize or invalid feeds are rejected, and any failure keeps the
previous cache and is reported in the payload.
"""
from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from wolfmark_ledger import membership as mem
from wolfmark_ledger import membership_api as api
from wolfmark_ledger import membership_live as live
from wolfmark_ledger import membership_store as store
from wolfmark_ledger import news as news_mod

NOW = 1798765432.0  # fixed clock for stable fetched_at values


def plan(plan_id, family="demo", amount=10.0, status="verified"):
    return {"id": plan_id, "provider_family": family,
            "name": f"{family} {plan_id}",
            "price": {"amount": amount, "currency": "USD",
                      "period": "month"},
            "verification": {"status": status}}


def feed_doc(plans, version=1, catalogue_version="2026-10-31.1"):
    return {"version": version, "catalogue_version": catalogue_version,
            "generated_at": "2026-10-31T00:00:00Z",
            "plans": plans, "sources": []}


def newer_than_bundled():
    """A live version one revision ahead of the real bundled catalogue."""
    from wolfmark_ledger.catalogue_revisions import next_catalogue_version

    return next_catalogue_version(api.load_plans()["catalogue_version"])


def book_of(catalogue):
    return mem.load_plan_catalogue(catalogue)


class LiveTestCase(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory(
            dir=os.environ.get("TMPDIR"))
        self.addCleanup(self.scratch.cleanup)
        self.data = Path(self.scratch.name) / "plugin-data"

    def fake_response(self, payload):
        body = json.dumps(payload).encode("utf-8")
        response = mock.MagicMock()
        response.read.return_value = body
        response.__enter__.return_value = response
        response.__exit__.return_value = False
        return response

    def enable(self):
        news_mod.save_settings(True, news_mod.settings_path(self.data))

    def write_cache(self, book, fetched_at="2026-11-01T00:00:00+00:00",
                    state="ok", error=""):
        target = live.cache_path(self.data)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps({"version": live.PLANS_FEED_VERSION,
                                      "fetched_at": fetched_at,
                                      "state": state, "error": error,
                                      "book": book}),
                          encoding="utf-8")


class ValidateFeedTests(LiveTestCase):
    def test_valid_feed_passes(self):
        book, problems = live.validate_feed(feed_doc([plan("a")]))
        self.assertEqual(problems, [])
        self.assertEqual(book["catalogue_version"], "2026-10-31.1")
        self.assertEqual(book["plans"][0]["id"], "a")

    def test_non_object_rejected(self):
        book, problems = live.validate_feed([1, 2])
        self.assertIsNone(book)
        self.assertTrue(problems)

    def test_wrong_version_rejected(self):
        book, problems = live.validate_feed(feed_doc([plan("a")], version=2))
        self.assertIsNone(book)
        self.assertTrue(problems)

    def test_missing_plans_rejected(self):
        doc = feed_doc([plan("a")])
        del doc["plans"]
        book, problems = live.validate_feed(doc)
        self.assertIsNone(book)
        self.assertTrue(problems)

    def test_invalid_catalogue_rejected(self):
        book, problems = live.validate_feed(
            feed_doc([plan("dup"), plan("dup")]))
        self.assertIsNone(book)
        self.assertTrue(any("duplicate" in entry for entry in problems))

    def test_over_limit_truncated_with_note(self):
        plans = [plan(f"p-{index:03d}") for index in range(205)]
        book, problems = live.validate_feed(feed_doc(plans))
        self.assertEqual(len(book["plans"]), live.FEED_MAX_ITEMS)
        self.assertTrue(problems)


class LoadCacheTests(LiveTestCase):
    def test_cache_path_defaults_without_data_dir(self):
        self.assertEqual(live.cache_path().name, live.CACHE_NAME)

    def test_cache_path_joins_data_dir(self):
        self.assertEqual(live.cache_path(self.data),
                         self.data / live.CACHE_NAME)

    def test_missing_cache_is_never(self):
        cached = live.load_cache(live.cache_path(self.data))
        self.assertEqual(cached["state"], "never")
        self.assertIsNone(cached["book"])
        self.assertEqual(cached["fetched_at"], "")

    def test_corrupt_cache_is_never_and_never_raises(self):
        target = live.cache_path(self.data)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text("{nope", encoding="utf-8")
        cached = live.load_cache(target)
        self.assertEqual(cached["state"], "never")
        self.assertIsNone(cached["book"])

    def test_valid_cache_reads_back(self):
        book = book_of(feed_doc([plan("a")]))
        self.write_cache(book)
        cached = live.load_cache(live.cache_path(self.data))
        self.assertEqual(cached["state"], "ok")
        self.assertEqual(cached["book"]["plans"][0]["id"], "a")


class CentralFetchTests(LiveTestCase):
    def test_disabled_makes_no_request(self):
        with mock.patch.object(live, "urlopen") as opener:
            result = live.fetch_central(data_dir=self.data, now=NOW)
        opener.assert_not_called()
        self.assertEqual(result["state"], "disabled")
        self.assertIsNone(result["book"])

    def test_disabled_serves_cache_without_request(self):
        book = book_of(feed_doc([plan("a")]))
        self.write_cache(book)
        with mock.patch.object(live, "urlopen") as opener:
            result = live.fetch_central(data_dir=self.data, now=NOW)
        opener.assert_not_called()
        self.assertEqual(result["state"], "disabled_cached")
        self.assertEqual(result["book"]["plans"][0]["id"], "a")

    def test_request_carries_no_user_data(self):
        self.enable()
        seen = {}

        def opener(request, timeout=None):
            seen["url"] = request.full_url
            seen["headers"] = {key.lower(): value
                               for key, value in request.header_items()}
            return self.fake_response(feed_doc([plan("a")]))

        with mock.patch.object(live, "urlopen", side_effect=opener):
            result = live.fetch_central(data_dir=self.data, now=NOW)
        self.assertEqual(result["state"], "ok")
        self.assertEqual(seen["url"], live.FEED_URL)
        self.assertTrue(seen["url"].startswith("https://"))
        self.assertNotIn("?", seen["url"])
        joined = (seen["url"] + " " +
                  " ".join(seen["headers"].values())).lower()
        for banned in ("user=", "account", "credential", "usage",
                       "subscription", "token="):
            self.assertNotIn(banned, joined)
        self.assertEqual(set(seen["headers"]), {"accept", "user-agent"})

    def test_successful_fetch_cached(self):
        self.enable()
        with mock.patch.object(live, "urlopen", return_value=self.fake_response(
                feed_doc([plan("a")]))):
            first = live.fetch_central(data_dir=self.data, now=NOW)
        self.assertEqual(first["state"], "ok")
        self.assertTrue((self.data / live.CACHE_NAME).exists())
        with mock.patch.object(live, "urlopen") as opener:
            second = live.fetch_central(data_dir=self.data, now=NOW + 60)
        opener.assert_not_called()
        self.assertEqual(second["state"], "ok")
        self.assertEqual(second["book"]["plans"][0]["id"], "a")

    def test_stale_cache_refetches(self):
        self.enable()
        old = book_of(feed_doc([plan("old")]))
        self.write_cache(old, fetched_at="2026-10-01T00:00:00+00:00")
        with mock.patch.object(live, "urlopen", return_value=self.fake_response(
                feed_doc([plan("new")]))):
            result = live.fetch_central(data_dir=self.data, now=NOW)
        self.assertEqual(result["state"], "ok")
        self.assertEqual(result["book"]["plans"][0]["id"], "new")

    def test_failed_fetch_keeps_a_newer_cache_written_mid_flight(self):
        self.enable()
        old = book_of(feed_doc([plan("old")]))
        self.write_cache(old, fetched_at="2026-10-01T00:00:00+00:00")
        newer = book_of(feed_doc([plan("newer")]))

        def overlap(request, timeout=None):
            # Another refresh succeeds while this request is in flight.
            self.write_cache(newer, fetched_at="2026-11-03T00:00:00+00:00")
            raise OSError("network down")

        with mock.patch.object(live, "urlopen", side_effect=overlap):
            result = live.fetch_central(data_dir=self.data, now=NOW)
        self.assertEqual(result["book"]["plans"][0]["id"], "newer")
        kept = live.load_cache(live.cache_path(self.data))
        self.assertEqual(kept["book"]["plans"][0]["id"], "newer")
        self.assertEqual(kept["fetched_at"], "2026-11-03T00:00:00+00:00")

    def test_force_bypasses_fresh_cache(self):
        from datetime import datetime, timezone

        self.enable()
        old = book_of(feed_doc([plan("old")]))
        fresh = datetime.fromtimestamp(NOW - 60, timezone.utc).isoformat()
        self.write_cache(old, fetched_at=fresh)
        with mock.patch.object(live, "urlopen", return_value=self.fake_response(
                feed_doc([plan("new")]))):
            result = live.fetch_central(data_dir=self.data, now=NOW,
                                        force=True)
        self.assertEqual(result["state"], "ok")
        self.assertEqual(result["book"]["plans"][0]["id"], "new")

    def test_oversize_response_rejected_and_cache_kept(self):
        self.enable()
        old = book_of(feed_doc([plan("old")]))
        self.write_cache(old, fetched_at="2026-10-01T00:00:00+00:00")
        response = mock.MagicMock()
        response.read.return_value = b"x" * (live.FEED_MAX_BYTES + 1)
        response.__enter__.return_value = response
        response.__exit__.return_value = False
        with mock.patch.object(live, "urlopen", return_value=response):
            result = live.fetch_central(data_dir=self.data, now=NOW)
        self.assertEqual(result["state"], "stale")
        self.assertEqual(result["book"]["plans"][0]["id"], "old")
        self.assertIn("central catalogue unavailable", result["error"])

    def test_oversize_without_cache_is_error(self):
        self.enable()
        response = mock.MagicMock()
        response.read.return_value = b"x" * (live.FEED_MAX_BYTES + 1)
        response.__enter__.return_value = response
        response.__exit__.return_value = False
        with mock.patch.object(live, "urlopen", return_value=response):
            result = live.fetch_central(data_dir=self.data, now=NOW)
        self.assertEqual(result["state"], "error")
        self.assertIsNone(result["book"])

    def test_invalid_feed_rejected_and_cache_kept(self):
        self.enable()
        old = book_of(feed_doc([plan("old")]))
        self.write_cache(old, fetched_at="2026-10-01T00:00:00+00:00")
        with mock.patch.object(live, "urlopen", return_value=self.fake_response(
                {"version": 1, "plans": "nope"})):
            result = live.fetch_central(data_dir=self.data, now=NOW)
        self.assertEqual(result["state"], "stale")
        self.assertEqual(result["book"]["plans"][0]["id"], "old")

    def test_network_failure_keeps_cache(self):
        self.enable()
        old = book_of(feed_doc([plan("old")]))
        self.write_cache(old, fetched_at="2026-10-01T00:00:00+00:00")
        with mock.patch.object(live, "urlopen",
                               side_effect=OSError("offline")):
            result = live.fetch_central(data_dir=self.data, now=NOW)
        self.assertEqual(result["state"], "stale")
        self.assertEqual(result["book"]["plans"][0]["id"], "old")
        self.assertIn("OSError", result["error"])

    def test_network_failure_without_cache_is_error(self):
        self.enable()
        with mock.patch.object(live, "urlopen",
                               side_effect=OSError("offline")):
            result = live.fetch_central(data_dir=self.data, now=NOW)
        self.assertEqual(result["state"], "error")
        self.assertIsNone(result["book"])


class PlansPayloadTests(LiveTestCase):
    def test_default_is_bundled_and_disabled(self):
        payload = api.plans_payload(data_dir=self.data)
        self.assertEqual(payload["source"], "bundled")
        self.assertEqual(payload["central"]["state"], "disabled")
        self.assertGreater(payload["totals"]["plans"], 0)

    def test_enabled_without_cache_is_never(self):
        self.enable()
        payload = api.plans_payload(data_dir=self.data)
        self.assertEqual(payload["source"], "bundled")
        self.assertEqual(payload["central"]["state"], "never")

    def test_live_cache_served_when_enabled(self):
        self.enable()
        book = book_of({"catalogue_version": "live-1",
                        "generated_at": "2026-11-01T00:00:00Z",
                        "plans": [plan("live-plan", family="live")],
                        "sources": []})
        self.write_cache(book)
        payload = api.plans_payload(data_dir=self.data)
        self.assertEqual(payload["source"], "live")
        self.assertEqual(payload["catalogue_version"], "live-1")
        self.assertEqual(payload["totals"]["plans"], 1)
        self.assertEqual(payload["central"]["state"], "ok")
        self.assertEqual(payload["central"]["catalogue_version"], "live-1")

    def test_explicit_catalogue_always_wins(self):
        self.enable()
        book = book_of(feed_doc([plan("live-plan", family="live")]))
        self.write_cache(book)
        mine = book_of({"catalogue_version": "mine",
                        "generated_at": "2026-11-01T00:00:00Z",
                        "plans": [plan("mine", family="mine")],
                        "sources": []})
        payload = api.plans_payload(mine, data_dir=self.data)
        self.assertEqual(payload["source"], "bundled")
        self.assertEqual(payload["catalogue_version"], "mine")
        self.assertEqual(payload["families"][0]["family"], "mine")

    def test_live_cache_ignored_when_disabled(self):
        book = book_of(feed_doc([plan("live-plan", family="live")]))
        self.write_cache(book)
        payload = api.plans_payload(data_dir=self.data)
        self.assertEqual(payload["source"], "bundled")
        self.assertEqual(payload["central"]["state"], "disabled_cached")

    def test_refresh_without_fetch_makes_no_request(self):
        self.enable()
        with mock.patch.object(live, "urlopen") as opener:
            payload = api.refresh_plans_payload(data_dir=self.data,
                                                now=NOW, fetch=False)
        opener.assert_not_called()
        self.assertEqual(payload["source"], "bundled")
        self.assertEqual(payload["central"]["state"], "never")

    def test_refresh_fetches_then_serves_live(self):
        self.enable()
        with mock.patch.object(live, "urlopen", return_value=self.fake_response(
                {"version": 1, "catalogue_version": "live-2",
                 "generated_at": "2026-11-01T00:00:00Z",
                 "plans": [plan("live-plan", family="live")],
                 "sources": []})):
            payload = api.refresh_plans_payload(data_dir=self.data, now=NOW)
        self.assertEqual(payload["source"], "live")
        self.assertEqual(payload["catalogue_version"], "live-2")
        self.assertEqual(payload["central"]["state"], "ok")

    def test_refresh_failure_keeps_bundled(self):
        self.enable()
        with mock.patch.object(live, "urlopen",
                               side_effect=OSError("offline")):
            payload = api.refresh_plans_payload(data_dir=self.data, now=NOW)
        self.assertEqual(payload["source"], "bundled")
        self.assertEqual(payload["central"]["state"], "error")
        self.assertTrue(payload["central"]["error"])


class ActiveCatalogueTests(LiveTestCase):
    def live_book(self, plans):
        # These tests pin enabled-and-cached selection, not the staleness
        # rule: the cached copy stays ahead of the bundled catalogue so the
        # newer-wins safeguard below does not hold it back.
        return book_of(feed_doc(plans,
                                catalogue_version=newer_than_bundled()))

    def save_member(self, family, plan_id, **extra):
        account = {**mem.member_from_native({"provider": family}),
                   "plan_id": plan_id, **extra}
        store_path = Path(self.scratch.name) / "memberships.json"
        store.save_account(account, store_path)
        return store_path

    def test_live_catalogue_served_when_enabled_and_cached(self):
        self.enable()
        self.write_cache(self.live_book(
            [plan("live-plan", family="live", amount=99.0)]))
        book, source = api.active_catalogue(data_dir=self.data)
        self.assertEqual(source, "live")
        self.assertEqual(book["plans"][0]["id"], "live-plan")
        self.assertEqual(book["plans"][0]["price"]["amount"], 99.0)

    def test_bundled_fallback_when_disabled(self):
        self.write_cache(self.live_book([plan("live-plan", family="live")]))
        book, source = api.active_catalogue(data_dir=self.data)
        self.assertEqual(source, "bundled")
        self.assertNotIn("live-plan", {p["id"] for p in book["plans"]})
        self.assertEqual(book["catalogue_version"],
                         api.load_plans()["catalogue_version"])

    def test_bundled_fallback_without_cache(self):
        self.enable()
        book, source = api.active_catalogue(data_dir=self.data)
        self.assertEqual(source, "bundled")
        self.assertEqual(book["catalogue_version"],
                         api.load_plans()["catalogue_version"])

    def test_explicit_catalogue_wins(self):
        self.enable()
        self.write_cache(self.live_book([plan("live-plan", family="live")]))
        explicit = book_of(feed_doc([plan("own-plan", family="own")]))
        book, source = api.active_catalogue(explicit, data_dir=self.data)
        self.assertIs(book, explicit)
        self.assertEqual(source, "bundled")

    def test_corrupt_cache_falls_back_to_bundled(self):
        self.enable()
        target = live.cache_path(self.data)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text("{not json", encoding="utf-8")
        book, source = api.active_catalogue(data_dir=self.data)
        self.assertEqual(source, "bundled")
        self.assertNotIn("live-plan", {p["id"] for p in book["plans"]})

    def test_account_cards_resolve_against_live_catalogue(self):
        self.enable()
        self.write_cache(self.live_book(
            [plan("live-plan", family="live", amount=99.0)]))
        store_path = self.save_member("live", "live-plan")
        cards = api.accounts_payload(
            path=store_path, data_dir=self.data)["accounts"]
        self.assertEqual(len(cards), 1)
        self.assertEqual(cards[0]["plan"]["price"]["amount"], 99.0)
        self.assertIn("live-plan",
                      [p["id"] for p in cards[0]["plan_choices"]])
        self.assertEqual(cards[0]["fee"]["published"]["amount"], 99.0)

    def test_fee_summary_uses_live_prices(self):
        self.enable()
        self.write_cache(self.live_book(
            [plan("live-plan", family="live", amount=99.0)]))
        store_path = self.save_member("live", "live-plan")
        summary = api.fee_summary_payload(path=store_path, data_dir=self.data,
                                          at="2026-11-03T12:00:00Z")
        self.assertEqual(summary["totals_by_currency_period"],
                         {"USD/month": 99.0})
        self.assertEqual(summary["fees"][0]["published"]["amount"], 99.0)

    def test_personal_fee_override_survives_live_catalogue(self):
        self.enable()
        self.write_cache(self.live_book(
            [plan("live-plan", family="live", amount=99.0)]))
        store_path = self.save_member(
            "live", "live-plan",
            fee_overrides=[{"id": "mine", "amount": 15, "currency": "GBP",
                            "period": "month", "reason": "legacy_pricing"}])
        cards = api.accounts_payload(
            path=store_path, data_dir=self.data)["accounts"]
        self.assertEqual(cards[0]["fee"]["effective"]["amount"], 15)
        self.assertEqual(cards[0]["fee"]["effective"]["currency"], "GBP")
        self.assertEqual(cards[0]["fee"]["published"]["amount"], 99.0)

    def test_unknown_plan_id_keeps_own_price(self):
        self.enable()
        self.write_cache(self.live_book(
            [plan("live-plan", family="live", amount=99.0)]))
        store_path = self.save_member("live", "ghost-plan")
        cards = api.accounts_payload(
            path=store_path, data_dir=self.data)["accounts"]
        self.assertIsNone(cards[0]["plan"])
        self.assertIsNone(cards[0]["fee"]["published"])


class CatalogueVersionTests(unittest.TestCase):
    def test_parse_valid_version(self):
        self.assertEqual(live.parse_catalogue_version("2026-10-31.1"),
                         (2026, 10, 31, 1))
        self.assertEqual(live.parse_catalogue_version(" 2026-11-04.12 "),
                         (2026, 11, 4, 12))

    def test_parse_rejects_anything_not_date_then_counter(self):
        for value in ("", "  ", None, 7, "live-1", "mine",
                      "2026-11-04", "2026-11-04.x", "2026-13-01.1",
                      "2026-11-40.1", "11-04-2026.1", "2026-11-04.1.2"):
            self.assertIsNone(live.parse_catalogue_version(value),
                              f"must not parse: {value!r}")

    def test_compare_orders_by_date_then_counter(self):
        compare = live.compare_catalogue_versions
        self.assertEqual(compare("2026-10-31.1", "2026-11-04.3"), -1)
        self.assertEqual(compare("2026-11-04.3", "2026-10-31.1"), 1)
        self.assertEqual(compare("2026-11-04.3", "2026-11-04.3"), 0)
        self.assertEqual(compare("2026-11-04.9", "2026-11-05.1"), -1)
        self.assertEqual(compare("2026-11-04.3", "2026-11-04.12"), -1)

    def test_compare_is_unknown_when_either_side_does_not_parse(self):
        compare = live.compare_catalogue_versions
        self.assertIsNone(compare("live-1", "2026-11-04.3"))
        self.assertIsNone(compare("2026-10-31.1", "dev"))
        self.assertIsNone(compare(None, None))

    def test_central_is_stale_only_when_proven_older(self):
        stale = live.central_is_stale
        older = {"catalogue_version": "2026-10-31.1"}
        same = {"catalogue_version": "2026-11-04.3"}
        newer = {"catalogue_version": "2026-11-05.1"}
        bundled = {"catalogue_version": "2026-11-04.3"}
        self.assertTrue(stale(older, bundled))
        self.assertFalse(stale(same, bundled))
        self.assertFalse(stale(newer, bundled))
        self.assertFalse(stale({"catalogue_version": "live-1"}, bundled))
        self.assertFalse(stale(older, {"catalogue_version": "dev"}))
        self.assertFalse(stale({}, bundled))
        self.assertFalse(stale(older, None))


class StaleLiveHoldbackTests(LiveTestCase):
    """Newer-wins: a stale live copy never replaces the bundled catalogue."""

    BUNDLED_VERSION = "2026-11-04.3"

    def bundled(self):
        return book_of({"catalogue_version": self.BUNDLED_VERSION,
                        "generated_at": "2026-11-04T00:00:00Z",
                        "plans": [plan("bundled-plan", family="bundled",
                                       amount=25.0)],
                        "sources": []})

    def cached(self, version):
        return book_of(feed_doc([plan("live-plan", family="live",
                                      amount=99.0)],
                                catalogue_version=version))

    def select(self, cached_version):
        self.enable()
        self.write_cache(self.cached(cached_version))
        with mock.patch.object(api, "load_plans",
                               return_value=self.bundled()):
            return api.active_catalogue(data_dir=self.data)

    def test_older_live_catalogue_held_back_to_bundled(self):
        book, source = self.select("2026-10-31.1")
        self.assertEqual(source, "bundled")
        self.assertEqual(book["catalogue_version"], self.BUNDLED_VERSION)
        self.assertNotIn("live-plan", {p["id"] for p in book["plans"]})

    def test_equal_live_catalogue_served(self):
        book, source = self.select(self.BUNDLED_VERSION)
        self.assertEqual(source, "live")
        self.assertEqual(book["plans"][0]["id"], "live-plan")

    def test_newer_live_catalogue_served(self):
        book, source = self.select("2026-11-05.1")
        self.assertEqual(source, "live")
        self.assertEqual(book["plans"][0]["id"], "live-plan")

    def test_unparseable_live_version_served_fail_open(self):
        book, source = self.select("live-1")
        self.assertEqual(source, "live")
        self.assertEqual(book["plans"][0]["id"], "live-plan")

    def test_unparseable_bundled_version_serves_live_fail_open(self):
        self.enable()
        self.write_cache(self.cached("2026-10-31.1"))
        dev = book_of({"catalogue_version": "dev",
                       "generated_at": "2026-11-04T00:00:00Z",
                       "plans": [plan("bundled-plan", family="bundled")],
                       "sources": []})
        with mock.patch.object(api, "load_plans", return_value=dev):
            book, source = api.active_catalogue(data_dir=self.data)
        self.assertEqual(source, "live")

    def test_corrupt_bundled_file_still_serves_live(self):
        self.enable()
        self.write_cache(self.cached("2026-10-31.1"))
        with mock.patch.object(api, "load_plans",
                               side_effect=mem.CatalogueError("broken")):
            book, source = api.active_catalogue(data_dir=self.data)
        self.assertEqual(source, "live")
        self.assertEqual(book["plans"][0]["id"], "live-plan")

    def test_account_cards_resolve_against_bundled_when_held_back(self):
        self.enable()
        self.write_cache(self.cached("2026-10-31.1"))
        store_path = Path(self.scratch.name) / "memberships.json"
        account = {**mem.member_from_native({"provider": "bundled"}),
                   "plan_id": "bundled-plan"}
        store.save_account(account, store_path)
        with mock.patch.object(api, "load_plans",
                               return_value=self.bundled()):
            cards = api.accounts_payload(
                path=store_path, data_dir=self.data)["accounts"]
        self.assertEqual(cards[0]["fee"]["published"]["amount"], 25.0)

    def test_personal_fee_override_survives_holdback(self):
        self.enable()
        self.write_cache(self.cached("2026-10-31.1"))
        store_path = Path(self.scratch.name) / "memberships.json"
        account = {**mem.member_from_native({"provider": "bundled"}),
                   "plan_id": "bundled-plan",
                   "fee_overrides": [{"id": "mine", "amount": 15,
                                      "currency": "GBP", "period": "month",
                                      "reason": "legacy_pricing"}]}
        store.save_account(account, store_path)
        before = json.loads(store_path.read_text(encoding="utf-8"))
        with mock.patch.object(api, "load_plans",
                               return_value=self.bundled()):
            cards = api.accounts_payload(
                path=store_path, data_dir=self.data)["accounts"]
        self.assertEqual(cards[0]["fee"]["effective"]["amount"], 15)
        self.assertEqual(cards[0]["fee"]["effective"]["currency"], "GBP")
        self.assertEqual(json.loads(store_path.read_text(encoding="utf-8")),
                         before)

    def test_held_back_flag_reported_in_plans_payload(self):
        self.enable()
        self.write_cache(self.cached("2026-10-31.1"))
        with mock.patch.object(api, "load_plans",
                               return_value=self.bundled()):
            payload = api.plans_payload(data_dir=self.data)
        self.assertEqual(payload["source"], "bundled")
        self.assertTrue(payload["central"]["held_back"])
        self.assertEqual(payload["central"]["catalogue_version"],
                         "2026-10-31.1")

    def test_held_back_flag_false_when_live_served(self):
        self.enable()
        self.write_cache(self.cached("2026-11-05.1"))
        with mock.patch.object(api, "load_plans",
                               return_value=self.bundled()):
            payload = api.plans_payload(data_dir=self.data)
        self.assertEqual(payload["source"], "live")
        self.assertFalse(payload["central"]["held_back"])

    def test_held_back_flag_false_when_disabled(self):
        self.write_cache(self.cached("2026-10-31.1"))
        with mock.patch.object(api, "load_plans",
                               return_value=self.bundled()):
            payload = api.plans_payload(data_dir=self.data)
        self.assertEqual(payload["source"], "bundled")
        self.assertFalse(payload["central"]["held_back"])

    def test_refresh_with_older_feed_serves_bundled(self):
        self.enable()
        with mock.patch.object(
                live, "urlopen",
                return_value=self.fake_response(feed_doc(
                    [plan("live-plan", family="live")]))):
            with mock.patch.object(api, "load_plans",
                                   return_value=self.bundled()):
                payload = api.refresh_plans_payload(data_dir=self.data,
                                                    now=NOW)
        self.assertEqual(payload["source"], "bundled")
        self.assertTrue(payload["central"]["held_back"])
        self.assertEqual(payload["central"]["state"], "ok")

    def test_fetch_regression_keeps_newer_cache(self):
        self.enable()
        self.write_cache(self.cached("2026-11-05.1"),
                         fetched_at="2026-11-04T00:00:00+00:00")
        with mock.patch.object(
                live, "urlopen",
                return_value=self.fake_response(feed_doc(
                    [plan("older-plan", family="live")]))):
            result = live.fetch_central(data_dir=self.data, now=NOW,
                                        force=True)
        self.assertEqual(result["state"], "ok")
        self.assertEqual(result["book"]["plans"][0]["id"], "live-plan")
        self.assertEqual(result["book"]["catalogue_version"], "2026-11-05.1")
        self.assertEqual(result["fetched_at"], "2026-11-04T00:00:00+00:00")
        kept = live.load_cache(live.cache_path(self.data))
        self.assertEqual(kept["book"]["plans"][0]["id"], "live-plan")

    def test_fetch_newer_replaces_older_cache(self):
        self.enable()
        self.write_cache(self.cached("2026-10-31.1"),
                         fetched_at="2026-10-01T00:00:00+00:00")
        with mock.patch.object(
                live, "urlopen",
                return_value=self.fake_response(feed_doc(
                    [plan("newer-plan", family="live")],
                    catalogue_version="2026-11-05.1"))):
            result = live.fetch_central(data_dir=self.data, now=NOW,
                                        force=True)
        self.assertEqual(result["state"], "ok")
        self.assertEqual(result["book"]["plans"][0]["id"], "newer-plan")
        self.assertEqual(result["book"]["catalogue_version"], "2026-11-05.1")

    def test_fetch_equal_version_refreshes_cache(self):
        self.enable()
        self.write_cache(self.cached("2026-10-31.1"),
                         fetched_at="2026-10-01T00:00:00+00:00")
        with mock.patch.object(
                live, "urlopen",
                return_value=self.fake_response(feed_doc(
                    [plan("same-plan", family="live")]))):
            result = live.fetch_central(data_dir=self.data, now=NOW,
                                        force=True)
        self.assertEqual(result["state"], "ok")
        self.assertEqual(result["book"]["plans"][0]["id"], "same-plan")


if __name__ == "__main__":
    unittest.main()
