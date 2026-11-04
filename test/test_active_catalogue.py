"""The active plan catalogue flows into economics, digest, allowance and news.

When Live Updates is on and a central feed is cached, views that take no
explicit catalogue must read that active book instead of the bundled
snapshot. Explicit catalogues still win, completed history months stay
pinned to recorded rates, and personal fee overrides still beat every
catalogue. Every comparison below uses scratch data directories, never the
operator's real plugin data.
"""
from __future__ import annotations

import json
import os
import sqlite3
import tempfile
import unittest
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path

from wolfmark_ledger import allowance_weather
from wolfmark_ledger import digest as D
from wolfmark_ledger import economics as E
from wolfmark_ledger import membership as M
from wolfmark_ledger import membership_live as live
from wolfmark_ledger import monitoring
from wolfmark_ledger import news
from wolfmark_ledger import store
from wolfmark_ledger.pricing import Catalogue, Rate

NOW = datetime(2026, 10, 31, 12, tzinfo=timezone.utc).timestamp()
DAY = 86400

LIVE_WINDOW = {"id": "live-credit", "label": "Live credit",
               "kind": "monthly_credit", "amount": 50, "limit": "credits"}


def live_plan(plan_id="test.plus", family="test", amount=40.0, windows=()):
    """One raw feed plan, in pre-validation feed shape."""
    return {"id": plan_id, "provider_family": family,
            "name": f"{family.title()} {plan_id.split('.')[-1].title()}",
            "price": {"amount": amount, "currency": "USD", "period": "month"},
            "entitlements": {"windows": list(windows)},
            "verification": {"source_id": "fixture-live"}}


def write_live_book(data_dir, plans, version="live-test.1"):
    """Cache a validated live book and switch Live Updates on there."""
    data_dir = Path(data_dir)
    data_dir.mkdir(parents=True, exist_ok=True)
    feed = {"catalogue_version": version,
            "generated_at": "2026-10-31T00:00:00Z",
            "plans": list(plans), "sources": []}
    book = M.load_plan_catalogue(feed)
    target = live.cache_path(data_dir)
    target.write_text(json.dumps({"book": book, "fetched_at": feed["generated_at"],
                                  "state": "ok", "error": ""}))
    news.save_settings(True, news.settings_path(data_dir))
    return book


def account(aid, family, **kw):
    base = {"id": aid, "family": family, "label": aid,
            "route_slugs": [family], "credential_present": True,
            "billing_arrangement": "subscription",
            "plan_id": None, "fee_overrides": [], "manual_exhaustions": []}
    base.update(kw)
    return base


def book_for(*providers):
    providers_map = {family: {"m": Rate(2, 4, .5, 3)} for family in providers}
    return Catalogue(providers_map, "fixture", "test", "", "1")


class ActiveCatalogueCase(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory(dir=os.environ.get("TMPDIR"))
        self.addCleanup(self.scratch.cleanup)
        self.dir = Path(self.scratch.name)
        self.events = self.dir / "usage.db"
        self.state = self.dir / "state.db"
        self.memberships = self.dir / "memberships.json"
        self.profiles = self.dir / "billing-profiles.json"
        self.live_dir = self.dir / "live-data"
        self.plain_dir = self.dir / "plain-data"
        self.plain_dir.mkdir(parents=True, exist_ok=True)

    def create_events(self, rows=()):
        with closing(sqlite3.connect(self.events)) as conn, conn:
            conn.executescript(store._SCHEMA)
            for index, row in enumerate(rows):
                values = {"event_id": f"event-{index}", "ts": NOW - 3 * DAY,
                          "model": "m", "provider": "test", "platform": "desktop",
                          "outcome": "ok", "input_tokens": 0, "output_tokens": 0,
                          "recorded_at": None, **row}
                if values["recorded_at"] is None:
                    values["recorded_at"] = values["ts"]
                values["total_tokens"] = (values["input_tokens"]
                                          + values["output_tokens"])
                columns = list(values)
                conn.execute(f"INSERT INTO calls ({','.join(columns)}) VALUES "
                             f"({','.join('?' for _ in columns)})",
                             list(values.values()))

    def create_state(self, total):
        with closing(sqlite3.connect(self.state)) as conn, conn:
            conn.executescript(
                "CREATE TABLE session_model_usage (input_tokens INTEGER,"
                " output_tokens INTEGER, cache_read_tokens INTEGER,"
                " cache_write_tokens INTEGER);"
                f"INSERT INTO session_model_usage VALUES ({total}, 0, 0, 0);")

    def write_store(self, accounts):
        self.memberships.write_text(json.dumps({"version": 1, "accounts": accounts}))

    def write_profiles(self, profiles=()):
        self.profiles.write_text(json.dumps(
            {"version": 1, "profiles": list(profiles), "defaults": {}}))


class EconomicsActiveCatalogueTests(ActiveCatalogueCase):
    def report(self, **kwargs):
        params = {"now": NOW, "days": 7, "event_db_path": self.events,
                  "state_db_path": self.state, "membership_path": self.memberships,
                  "profiles_path": self.profiles, "catalogue": book_for("test")}
        params.update(kwargs)
        return E.build_economics_report(**params)

    def test_current_fees_follow_live_catalogue(self):
        self.write_store([account("a", "test", plan_id="test.plus")])
        self.write_profiles()
        self.create_events([{"input_tokens": 100}])
        write_live_book(self.live_dir, [live_plan()])
        result = self.report(plans=None, data_dir=self.live_dir)
        row = next(r for r in result["accounts"] if r["account_id"] == "a")
        self.assertEqual(row["monthly_equivalent"]["amount"], 40.0)
        # The bundled catalogue knows no test.plus, so the same report
        # without a live cache leaves the fee unknown.
        bundled = self.report(plans=None, data_dir=self.plain_dir)
        brow = next(r for r in bundled["accounts"] if r["account_id"] == "a")
        self.assertIsNone(brow["monthly_equivalent"]["amount"])

    def test_explicit_catalogue_still_wins(self):
        self.write_store([account("a", "test", plan_id="test.plus")])
        self.write_profiles()
        self.create_events([{"input_tokens": 100}])
        write_live_book(self.live_dir, [live_plan()])
        explicit = M.load_plan_catalogue(
            {"catalogue_version": "explicit.1",
             "plans": [live_plan(amount=99.0)]})
        result = self.report(plans=explicit, data_dir=self.live_dir)
        row = next(r for r in result["accounts"] if r["account_id"] == "a")
        self.assertEqual(row["monthly_equivalent"]["amount"], 99.0)

    def test_personal_override_beats_live_catalogue(self):
        self.write_store([account(
            "a", "test", plan_id="test.plus",
            fee_overrides=[{"id": "r-owner", "amount": 5.0,
                             "currency": "USD", "period": "month"}])])
        self.write_profiles()
        self.create_events([{"input_tokens": 100}])
        write_live_book(self.live_dir, [live_plan()])
        result = self.report(plans=None, data_dir=self.live_dir)
        row = next(r for r in result["accounts"] if r["account_id"] == "a")
        self.assertEqual(row["monthly_equivalent"]["amount"], 5.0)


class EconomicsHistoryPinningTests(ActiveCatalogueCase):
    def test_completed_months_keep_recorded_rates(self):
        # The bundled catalogue lists anthropic.claude-pro at $20; the live
        # feed reprices it to $30. July is over, so it keeps the recorded
        # $20; August is in progress, so it reads the live $30.
        august = datetime(2026, 8, 15, 12, tzinfo=timezone.utc).timestamp()
        july = datetime(2026, 7, 20, 12, tzinfo=timezone.utc).timestamp()
        self.write_store([account("a", "anthropic",
                                  plan_id="anthropic.claude-pro")])
        self.write_profiles()
        self.create_events([
            {"ts": july, "recorded_at": july, "provider": "anthropic",
             "input_tokens": 1_000, "event_id": "july"},
            {"ts": august - DAY, "recorded_at": august - DAY,
             "provider": "anthropic", "input_tokens": 1_000,
             "event_id": "august"},
        ])
        write_live_book(self.live_dir, [live_plan("anthropic.claude-pro",
                                                  "anthropic", 30.0)])
        result = E.build_economics_report(
            now=august, days=30, trend_months=2, event_db_path=self.events,
            state_db_path=self.state, membership_path=self.memberships,
            profiles_path=self.profiles, catalogue=book_for("anthropic"),
            plans=None, data_dir=self.live_dir)
        months = {m["month"]: m for m in result["trend"]["months"]}
        self.assertFalse(months["2026-07"]["in_progress"])
        self.assertEqual(months["2026-07"]["fees_by_currency"],
                         [{"currency": "USD", "amount": 20.0}])
        self.assertTrue(months["2026-08"]["in_progress"])
        self.assertEqual(months["2026-08"]["fees_by_currency"],
                         [{"currency": "USD", "amount": 30.0}])
        row = next(r for r in result["accounts"] if r["account_id"] == "a")
        self.assertEqual(row["monthly_equivalent"]["amount"], 30.0)


class DigestActiveCatalogueTests(ActiveCatalogueCase):
    def report(self, **kwargs):
        params = {"now": NOW, "days": 7, "lang": "en",
                  "event_db_path": self.events, "state_db_path": self.state,
                  "membership_path": self.memberships,
                  "profiles_path": self.profiles, "catalogue": book_for("test")}
        params.update(kwargs)
        return D.build_digest(**params)

    def fee_line_value(self, result):
        fees = next(s for s in result["sections"] if s["id"] == "fees")
        line = next(line for line in fees["lines"]
                    if line["label"].startswith("Fees in window"))
        return line["label"], line["value"]

    def test_digest_fees_follow_live_catalogue(self):
        self.write_store([account("test:default", "test", plan_id="test.plus")])
        self.write_profiles()
        self.create_events([{"input_tokens": 1_000_000, "ts": NOW - DAY}])
        self.create_state(1_000_000)
        live_book = write_live_book(self.live_dir, [live_plan()])
        label, value = self.fee_line_value(
            self.report(plans=None, data_dir=self.live_dir))
        explicit_label, explicit_value = self.fee_line_value(
            self.report(plans=live_book, data_dir=self.plain_dir))
        self.assertEqual((label, value), (explicit_label, explicit_value))
        bundled_label, bundled_value = self.fee_line_value(
            self.report(plans=None, data_dir=self.plain_dir))
        self.assertNotEqual((label, value), (bundled_label, bundled_value))


class AllowanceWeatherActiveCatalogueTests(ActiveCatalogueCase):
    def report(self, **kwargs):
        params = {"now": NOW, "event_db_path": self.events,
                  "state_db_path": self.state,
                  "membership_path": self.memberships,
                  "profiles_path": self.profiles,
                  "catalogue": book_for("test")}
        params.update(kwargs)
        return allowance_weather.build_weather_report(**params)

    def test_live_plan_windows_appear(self):
        self.write_store([account("a", "test", plan_id="test.plus")])
        self.write_profiles()
        self.create_events([])
        write_live_book(self.live_dir, [live_plan(windows=[LIVE_WINDOW])])
        result = self.report(plans=None, data_dir=self.live_dir)
        entry = next(a for a in result["accounts"] if a["account_id"] == "a")
        windows = {w["id"]: w for w in entry["windows"]}
        self.assertIn("live-credit", windows)
        self.assertEqual(windows["live-credit"]["declared"]["text"],
                         "50.0 credits")
        bundled = self.report(plans=None, data_dir=self.plain_dir)
        bentry = next(a for a in bundled["accounts"]
                      if a["account_id"] == "a")
        self.assertEqual(bentry["windows"], [])


class NewsActiveCatalogueTests(ActiveCatalogueCase):
    def catalogue(self):
        return Catalogue({}, "fixture", "test", "", "1")

    def baseline(self, plans):
        doc = {"catalogue_version": "test", "generated_at": "2026-11-01T00:00:00Z",
               "plans": plans, "sources": []}
        first = news.refresh_local(data_dir=self.live_dir,
                                   catalogue=self.catalogue(),
                                   plans_doc=doc, now=NOW)
        self.assertTrue(first["baseline"])
        return doc

    def test_new_live_plan_is_announced(self):
        self.baseline([live_plan("doc.a", "demo", 10.0)])
        write_live_book(self.live_dir, [live_plan("doc.a", "demo", 10.0),
                                        live_plan()])
        result = news.refresh_local(data_dir=self.live_dir,
                                    catalogue=self.catalogue(), now=NOW)
        self.assertFalse(result["baseline"])
        summaries = [item.get("summary", "") for item in result["items"]]
        self.assertTrue(any("Test Plus" in summary for summary in summaries),
                        summaries)

    def test_explicit_plans_doc_still_wins(self):
        doc = self.baseline([live_plan("doc.a", "demo", 10.0)])
        write_live_book(self.live_dir, [live_plan("doc.a", "demo", 10.0),
                                        live_plan()])
        result = news.refresh_local(data_dir=self.live_dir,
                                    catalogue=self.catalogue(),
                                    plans_doc=doc, now=NOW)
        summaries = [item.get("summary", "") for item in result["items"]]
        self.assertFalse(any("Test Plus" in summary for summary in summaries),
                         summaries)


class MonitoringActiveCatalogueTests(ActiveCatalogueCase):
    def test_plan_families_follow_live_catalogue(self):
        self.write_store([account("a", "test", plan_id="test.plus")])
        write_live_book(self.live_dir, [live_plan()])
        result = monitoring.local_signals(store_path=self.memberships,
                                          data_dir=self.live_dir,
                                          home=self.dir / "hermes-home",
                                          event_db=self.events)
        self.assertEqual(result["plan_ids"], ["test.plus"])
        self.assertEqual(result["plan_families"], ["test"])
        bundled = monitoring.local_signals(store_path=self.memberships,
                                           data_dir=self.plain_dir,
                                           home=self.dir / "hermes-home",
                                           event_db=self.events)
        self.assertEqual(bundled["plan_ids"], ["test.plus"])
        self.assertEqual(bundled["plan_families"], [])

    def test_explicit_catalogue_still_wins(self):
        self.write_store([account("a", "test", plan_id="test.plus")])
        write_live_book(self.live_dir, [live_plan()])
        explicit = {"catalogue_version": "explicit.1",
                    "plans": [{"id": "test.plus", "provider_family": "explicit"}]}
        result = monitoring.local_signals(store_path=self.memberships,
                                          plans_catalogue=explicit,
                                          data_dir=self.live_dir,
                                          home=self.dir / "hermes-home",
                                          event_db=self.events)
        self.assertEqual(result["plan_families"], ["explicit"])


if __name__ == "__main__":
    unittest.main()
