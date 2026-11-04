"""Model News scenario regressions: zero-config, offline, stale feed, identity, multi-provider.

End-to-end coverage for the wired News experience through the public
read paths (``news_payload``/``refresh_payload`` plus
``monitoring.news_view``/``personalise_payload``), reusing the scratch-dir
and fixture patterns from the focused news and monitoring suites.
"""
from __future__ import annotations

import json
import os
import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from unittest import mock

from wolfmark_ledger import monitoring, news, store
from wolfmark_ledger.pricing import Catalogue, Rate

NOW = 1798765432.0  # fixed clock for stable observed_at values


def book(rows, source="fixture cache", as_of="2026-11-01T00:00:00+00:00"):
    providers: dict[str, dict[str, Rate]] = {}
    for provider, model, rate in rows:
        providers.setdefault(provider, {})[model] = rate
    return Catalogue(providers, source, "test", as_of, "1")


def plans_doc(plans, sources=()):
    return {"catalogue_version": "test", "generated_at": "2026-11-01T00:00:00Z",
            "plans": plans, "sources": list(sources)}


def plan(plan_id, family="demo", amount=10.0):
    return {"id": plan_id, "provider_family": family, "name": f"{family} {plan_id}",
            "price": {"amount": amount, "currency": "USD", "period": "month"},
            "entitlements": {"windows": ["monthly-credits"]},
            "verification": {"source_id": "demo-source"}}


def feed_item(item_id="c-1", category="price_reduction", provider="acme",
              model="alpha", **overrides):
    item = {"id": item_id, "category": category, "provider": provider,
            "model": model, "summary": f"{model} got cheaper.",
            "previous": {"input": 3.0, "output": 15.0, "cache_read": 0.3,
                         "cache_write": 3.75},
            "current": {"input": 2.0, "output": 10.0, "cache_read": 0.2,
                        "cache_write": 2.5},
            "observed_at": "2026-11-02T00:00:00+00:00", "effective_at": "",
            "source_url": "https://example.com/pricing",
            "confidence": "verified", "provenance": "models.dev",
            "conditions": ""}
    item.update(overrides)
    return item


def feed_doc(items):
    return {"version": 1, "generated_at": "2026-11-02T00:00:00+00:00",
            "items": items}


class ScenarioTestCase(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory(dir=os.environ.get("TMPDIR"))
        self.addCleanup(self.scratch.cleanup)
        self.data = Path(self.scratch.name) / "plugin-data"
        self.events = Path(self.scratch.name) / "usage.db"
        self.home = Path(self.scratch.name) / "hermes-home"
        self.store_file = Path(self.scratch.name) / "memberships.json"

    def create_events(self, rows=(), target=None):
        db = Path(target) if target else self.events
        with closing(sqlite3.connect(db)) as conn, conn:
            conn.executescript(store._SCHEMA)
            for index, row in enumerate(rows):
                values = {"event_id": f"event-{index}", "ts": NOW - 100,
                          "model": "m", "provider": "test", "outcome": "ok",
                          "recorded_at": NOW, **row}
                columns = list(values)
                conn.execute(f"INSERT INTO calls ({','.join(columns)}) VALUES "
                             f"({','.join('?' for _ in columns)})", list(values.values()))

    def write_auth(self, pool, home=None):
        target = Path(home) if home else self.home
        target.mkdir(parents=True, exist_ok=True)
        (target / "auth.json").write_text(json.dumps({"credential_pool": pool}))

    def write_store(self, accounts, target=None):
        path = Path(target) if target else self.store_file
        path.write_text(json.dumps({"version": 1, "accounts": accounts}))

    def fake_response(self, payload):
        body = json.dumps(payload).encode("utf-8")
        response = mock.MagicMock()
        response.read.return_value = body
        response.__enter__.return_value = response
        response.__exit__.return_value = False
        return response

    def seed_local_news(self, data_dir, before, after):
        """Baseline one catalogue, then diff a changed one; returns stored items."""
        news.refresh_local(data_dir=data_dir, catalogue=before,
                           plans_doc=plans_doc([]), now=NOW)
        result = news.refresh_local(data_dir=data_dir, catalogue=after,
                                    plans_doc=plans_doc([]), now=NOW + 10)
        self.assertFalse(result["baseline"])
        self.assertTrue(result["items"])
        return result["items"]


# ------------------------------------------------------------------ zero-config

class ZeroConfigScenarioTests(ScenarioTestCase):
    """No accounts, memberships, or usage: All Updates works, For You is honest."""

    def test_all_updates_lists_news_while_for_you_reports_no_config(self):
        self.seed_local_news(
            self.data,
            book([("acme", "alpha", Rate(3.0, 15.0))]),
            book([("acme", "alpha", Rate(2.0, 10.0))]))
        base = dict(data_dir=self.data, event_db=self.events, home=self.home,
                    store_path=self.store_file, plans_catalogue={"plans": []},
                    now=NOW)
        everything = monitoring.news_view(scope="all", **base)
        self.assertTrue(everything["ok"])
        self.assertTrue(everything["items"])
        self.assertEqual(everything["empty"]["state"], "has_news")
        self.assertFalse(monitoring.has_signals(everything["signals"]))

        for_you = monitoring.news_view(**base)
        self.assertEqual(for_you["empty"]["state"], "no_config")
        self.assertIn("provider", for_you["empty"]["message"])
        self.assertEqual(for_you["for_you_count"], 0)
        for item in for_you["items"]:
            self.assertFalse(item["relevance"]["relevant"])
            self.assertEqual(item["relevance"]["reasons"], [])


# ------------------------------------------------------------------ offline

class OfflineScenarioTests(ScenarioTestCase):
    """No network: stored news serves and no fetch is ever attempted."""

    def seed(self):
        return self.seed_local_news(
            self.data,
            book([("acme", "alpha", Rate(3.0, 15.0))]),
            book([("acme", "alpha", Rate(2.0, 10.0))]))

    def test_read_and_refresh_paths_make_no_requests(self):
        seeded = self.seed()
        with mock.patch.object(news, "urlopen",
                               side_effect=AssertionError("network touched")) as opener:
            payload = news.news_payload(data_dir=self.data, event_db=self.events,
                                        home=self.home, now=NOW)
            refreshed = news.refresh_payload(
                data_dir=self.data, event_db=self.events, home=self.home,
                catalogue=book([("acme", "alpha", Rate(2.0, 10.0))]),
                plans_doc=plans_doc([]), now=NOW + 20)
        opener.assert_not_called()
        self.assertTrue(payload["ok"])
        self.assertFalse(payload["settings"]["live_updates"])
        self.assertEqual(payload["central"]["state"], "disabled")
        self.assertEqual([item["id"] for item in payload["local"]["items"]],
                         [item["id"] for item in seeded])
        self.assertEqual(refreshed["central"]["state"], "disabled")
        self.assertTrue(refreshed["local"]["items"])

    def test_personalised_dashboard_view_serves_offline(self):
        self.seed()
        with mock.patch.object(news, "urlopen",
                               side_effect=AssertionError("network touched")):
            payload = news.news_payload(data_dir=self.data, event_db=self.events,
                                        home=self.home, now=NOW)
            signals = monitoring.local_signals(
                home=self.home, event_db=self.events,
                store_path=self.store_file,
                plans_catalogue=plans_doc([]), now=NOW)
            personalised = monitoring.personalise_payload(payload, signals=signals)
        self.assertTrue(personalised["local"]["items"])
        self.assertEqual(personalised["empty"]["state"], "no_config")


# ------------------------------------------------------------------ stale feed

class StaleFeedScenarioTests(ScenarioTestCase):
    """An expired cache with a failed refetch: stale is surfaced, data is kept."""

    def test_expired_cache_failure_keeps_previous_items(self):
        news.save_settings(True, news.settings_path(self.data))
        with mock.patch.object(news, "urlopen",
                               return_value=self.fake_response(
                                   feed_doc([feed_item("c-9")]))):
            first = news.fetch_central(data_dir=self.data, now=NOW)
        self.assertEqual(first["state"], "ok")
        cache_file = self.data / "news-feed-cache.json"
        self.assertTrue(cache_file.exists())

        stale_moment = NOW + news.FEED_CACHE_SECONDS + 1
        with mock.patch.object(news, "urlopen", side_effect=OSError("offline")):
            payload = news.refresh_payload(
                data_dir=self.data, event_db=self.events, home=self.home,
                catalogue=book([("acme", "alpha", Rate(1.0, 2.0))]),
                plans_doc=plans_doc([]), now=stale_moment)
        self.assertEqual(payload["central"]["state"], "stale")
        self.assertEqual([item["id"] for item in payload["central"]["items"]],
                         ["c-9"])
        self.assertIn("unavailable", payload["central"]["error"])
        # The previous feed survives on disk; local news is unaffected.
        cached = news.load_cache(news.cache_path(self.data))
        self.assertEqual([item["id"] for item in cached["feed"]["items"]],
                         ["c-9"])
        self.assertTrue(payload["local"]["baseline"])


# ------------------------------------------------------------------ identity

class IdentitySwitchingTests(ScenarioTestCase):
    """Two identities: relevance and caches stay isolated per identity."""

    def identity(self, name):
        root = Path(self.scratch.name) / name
        return {"data": root / "plugin-data", "events": root / "usage.db",
                "home": root / "hermes-home",
                "store": root / "memberships.json"}

    def test_signals_and_relevance_follow_the_active_identity(self):
        primary = self.identity("primary")
        guest = self.identity("guest")
        self.write_auth({"anthropic": [{"id": "one"}]}, home=primary["home"])
        self.create_events([{"provider": "anthropic", "model": "claude-sonnet"}],
                           target=primary["events"])
        self.write_store([{"id": "a1", "family": "demo",
                           "plan_id": "demo.basic"}], target=primary["store"])
        catalogue = plans_doc([plan("demo.basic")])
        primary_signals = monitoring.local_signals(
            home=primary["home"], event_db=primary["events"],
            store_path=primary["store"], plans_catalogue=catalogue, now=NOW)
        guest_signals = monitoring.local_signals(
            home=guest["home"], event_db=guest["events"],
            store_path=guest["store"], plans_catalogue=catalogue, now=NOW)
        self.assertEqual(primary_signals["configured_families"], ["anthropic"])
        self.assertEqual(primary_signals["plan_families"], ["demo"])
        self.assertFalse(monitoring.has_signals(guest_signals))

        item = {"provider": "anthropic", "model": "claude-sonnet"}
        self.assertTrue(
            monitoring.match_relevance(item, primary_signals)["relevant"])
        self.assertFalse(
            monitoring.match_relevance(item, guest_signals)["relevant"])

    def test_stored_items_and_feed_cache_do_not_leak_across_identities(self):
        primary = self.identity("primary")
        guest = self.identity("guest")
        before = book([("anthropic", "claude-old", Rate(1.0, 2.0))])
        after = book([("anthropic", "claude-old", Rate(1.0, 2.0)),
                      ("anthropic", "claude-new", Rate(1.0, 2.0))])
        self.seed_local_news(primary["data"], before, after)
        self.seed_local_news(guest["data"], before, after)
        self.write_auth({"anthropic": [{"id": "one"}]}, home=primary["home"])

        primary_view = monitoring.news_view(
            data_dir=primary["data"], event_db=primary["events"],
            home=primary["home"], store_path=primary["store"],
            plans_catalogue={"plans": []}, now=NOW)
        guest_view = monitoring.news_view(
            data_dir=guest["data"], event_db=guest["events"],
            home=guest["home"], store_path=guest["store"],
            plans_catalogue={"plans": []}, now=NOW)
        self.assertEqual(primary_view["for_you_count"], 1)
        self.assertEqual(guest_view["for_you_count"], 0)
        self.assertEqual(guest_view["empty"]["state"], "no_config")

        news.save_settings(True, news.settings_path(primary["data"]))
        with mock.patch.object(news, "urlopen",
                               return_value=self.fake_response(
                                   feed_doc([feed_item("c-9")]))):
            fetched = news.fetch_central(data_dir=primary["data"], now=NOW)
        self.assertEqual(fetched["state"], "ok")
        self.assertIsNone(news.load_cache(news.cache_path(guest["data"]))["feed"])
        guest_payload = news.news_payload(data_dir=guest["data"],
                                          event_db=guest["events"],
                                          home=guest["home"], now=NOW)
        self.assertEqual(guest_payload["central"]["items"], [])


# ------------------------------------------------------------------ multi-provider

class MultiProviderScenarioTests(ScenarioTestCase):
    """Mixed signals: every item carries its own correct reasons."""

    def test_each_item_explains_its_own_relevance(self):
        self.write_auth({"anthropic": [{"id": "one"}]})
        self.create_events([{"provider": "openai-codex", "model": "gpt-x",
                             "input_tokens": 100, "output_tokens": 50}])
        self.write_store([{"id": "a1", "family": "demo",
                           "plan_id": "demo.basic"}])
        self.seed_local_news(
            self.data,
            book([("anthropic", "claude-old", Rate(1.0, 2.0))]),
            book([("anthropic", "claude-old", Rate(1.0, 2.0)),
                  ("anthropic", "claude-new", Rate(1.0, 2.0))]))
        news.save_settings(True, news.settings_path(self.data))
        central = feed_doc([
            feed_item("c-openai", provider="openai", model="gpt-x"),
            feed_item("c-demo", category="subscription", provider="demo",
                      model="", previous=None, current=None),
            feed_item("c-stranger", provider="stranger", model="zzz"),
        ])
        with mock.patch.object(news, "urlopen",
                               return_value=self.fake_response(central)):
            fetched = news.fetch_central(data_dir=self.data, now=NOW)
        self.assertEqual(fetched["state"], "ok")

        view = monitoring.news_view(
            data_dir=self.data, event_db=self.events, home=self.home,
            store_path=self.store_file,
            plans_catalogue=plans_doc([plan("demo.basic")]), now=NOW)
        by_id = {item["id"]: item for item in view["items"]}
        local_ids = [item["id"] for item in view["items"]
                     if item.get("origin") == "local"]
        self.assertEqual(len(local_ids), 1)
        self.assertEqual(by_id[local_ids[0]]["relevance"],
                         {"relevant": True,
                          "reasons": ["configured_provider"]})
        self.assertEqual(by_id["c-openai"]["relevance"],
                         {"relevant": True,
                          "reasons": ["used_provider", "used_model"]})
        self.assertEqual(by_id["c-demo"]["relevance"],
                         {"relevant": True,
                          "reasons": ["selected_plan_family"]})
        self.assertEqual(by_id["c-stranger"]["relevance"],
                         {"relevant": False, "reasons": []})
        self.assertEqual(view["for_you_count"], 3)
        self.assertEqual(view["empty"]["state"], "has_news")


if __name__ == "__main__":
    unittest.main()
