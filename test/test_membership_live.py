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
from wolfmark_ledger import news as news_mod

NOW = 1798765432.0  # fixed clock for stable fetched_at values


def plan(plan_id, family="demo", amount=10.0, status="verified"):
    return {"id": plan_id, "provider_family": family,
            "name": f"{family} {plan_id}",
            "price": {"amount": amount, "currency": "USD",
                      "period": "month"},
            "verification": {"status": status}}


def feed_doc(plans, version=1):
    return {"version": version, "catalogue_version": "2026-10-31.1",
            "generated_at": "2026-10-31T00:00:00Z",
            "plans": plans, "sources": []}


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


if __name__ == "__main__":
    unittest.main()
