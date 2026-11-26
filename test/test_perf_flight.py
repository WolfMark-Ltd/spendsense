"""Bounded in-flight deduplication: sharing, isolation, recovery.

Deterministic concurrency tests: leaders block on events while the test
waits (with a hard deadline that fails loudly) for exact waiter attachment
via ``waiter_count`` — no sleeps, no flakes.
"""
from __future__ import annotations

import os
import threading
import time
import unittest
from datetime import datetime, timezone

from wolfmark_ledger.singleflight import (
    REPORT_FLIGHT, SingleFlight, analytics_key, budgets_key, economics_key,
    freeze, session_key,
)


def _wait_for(predicate, timeout=10.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.005)
    return predicate()


class SingleFlightTests(unittest.TestCase):
    def test_identical_concurrent_calls_share_one_computation(self):
        flight = SingleFlight()
        release = threading.Event()
        calls = []
        results = {}
        errors = {}

        def slow():
            calls.append(1)
            self.assertTrue(release.wait(timeout=10), "leader released")
            return {"ok": True, "n": 42}

        def worker(i):
            try:
                results[i] = flight.run("k", slow)
            except Exception as exc:  # pragma: no cover - fails below
                errors[i] = exc

        threads = [threading.Thread(target=worker, args=(i,)) for i in range(5)]
        for t in threads:
            t.start()
        self.assertTrue(_wait_for(lambda: flight.waiter_count("k") == 4),
                        "all followers attached")
        release.set()
        for t in threads:
            t.join(timeout=10)
        self.assertEqual(errors, {})
        self.assertEqual(len(calls), 1)
        self.assertTrue(all(r == {"ok": True, "n": 42} for r in results.values()))
        self.assertEqual(flight.inflight_count(), 0)

    def test_distinct_keys_compute_separately(self):
        flight = SingleFlight()
        calls = []
        release = threading.Event()

        def slow(tag):
            calls.append(tag)
            self.assertTrue(release.wait(timeout=10))
            return tag

        out = {}
        t1 = threading.Thread(target=lambda: out.update(a=flight.run("a", lambda: slow("a"))))
        t2 = threading.Thread(target=lambda: out.update(b=flight.run("b", lambda: slow("b"))))
        t1.start()
        t2.start()
        self.assertTrue(_wait_for(lambda: flight.inflight_count() == 2))
        release.set()
        t1.join(timeout=10)
        t2.join(timeout=10)
        self.assertEqual(sorted(calls), ["a", "b"])
        self.assertEqual(out, {"a": "a", "b": "b"})
        self.assertEqual(flight.inflight_count(), 0)

    def test_failure_shared_then_next_call_retries_fresh(self):
        flight = SingleFlight()
        release = threading.Event()
        attempts = []
        errors = {}
        gate = threading.Event()

        def flaky():
            attempts.append(1)
            n = len(attempts)
            if n == 1:
                gate.set()
                self.assertTrue(release.wait(timeout=10))
                raise RuntimeError("sentinel-boom")
            return "recovered"

        def worker(i):
            try:
                flight.run("k", flaky)
            except RuntimeError as exc:
                errors[i] = str(exc)

        threads = [threading.Thread(target=worker, args=(i,)) for i in range(3)]
        for t in threads:
            t.start()
        self.assertTrue(gate.wait(timeout=10))
        self.assertTrue(_wait_for(lambda: flight.waiter_count("k") == 2))
        release.set()
        for t in threads:
            t.join(timeout=10)
        self.assertEqual(errors, {0: "sentinel-boom", 1: "sentinel-boom", 2: "sentinel-boom"})
        self.assertEqual(flight.inflight_count(), 0)
        # Failures are never cached: the next identical call recomputes.
        self.assertEqual(flight.run("k", flaky), "recovered")
        self.assertEqual(len(attempts), 2)

    def test_sequential_calls_never_share_across_time(self):
        flight = SingleFlight()
        calls = []

        def fn():
            calls.append(1)
            return {"v": len(calls)}

        first = flight.run("k", fn)
        second = flight.run("k", fn)
        self.assertEqual(len(calls), 2)
        self.assertEqual((first["v"], second["v"]), (1, 2))

    def test_abandoned_waiter_leaves_no_residue(self):
        flight = SingleFlight()
        release = threading.Event()

        def slow():
            self.assertTrue(release.wait(timeout=10))
            return "done"

        results = {}
        leader = threading.Thread(target=lambda: results.update(lead=flight.run("k", slow)))
        follower = threading.Thread(target=lambda: results.update(fol=flight.run("k", slow)))
        leader.start()
        self.assertTrue(_wait_for(lambda: flight.inflight_count() == 1))
        follower.start()
        self.assertTrue(_wait_for(lambda: flight.waiter_count("k") == 1))
        # "Disconnect" the follower: drop interest with a join timeout while
        # the leader is still computing. The follower thread keeps waiting
        # (sync waiters cannot be cancelled) and must still get the result.
        follower.join(timeout=0.2)
        self.assertTrue(follower.is_alive())
        release.set()
        leader.join(timeout=10)
        follower.join(timeout=10)
        self.assertEqual(results, {"lead": "done", "fol": "done"})
        self.assertEqual(flight.inflight_count(), 0)

    def test_max_entries_fails_open(self):
        flight = SingleFlight(max_entries=1)
        release = threading.Event()
        entered = threading.Event()

        def slow(tag):
            if tag == "leader":
                entered.set()
            self.assertTrue(release.wait(timeout=10))
            return tag

        t1 = threading.Thread(target=lambda: flight.run("a", lambda: slow("leader")))
        t1.start()
        self.assertTrue(entered.wait(timeout=10))
        # Table full: a distinct key computes directly instead of queueing.
        self.assertEqual(flight.run("b", lambda: "direct"), "direct")
        release.set()
        t1.join(timeout=10)
        self.assertEqual(flight.inflight_count(), 0)


class FlightKeyTests(unittest.TestCase):
    NOW = datetime(2026, 10, 29, 12, tzinfo=timezone.utc).timestamp()

    def test_same_window_requests_share_a_key(self):
        a = analytics_key(days=30, model=None, provider=None, surface=None,
                          task=None, parent=None, scope=None,
                          pricing_mode="strict", presentation="both",
                          arrangements=None, now=self.NOW,
                          event_db="/tmp/e.db", state_db="/tmp/s.db",
                          profiles_path=None)
        b = analytics_key(days=30, model=None, provider=None, surface=None,
                          task=None, parent=None, scope=None,
                          pricing_mode="strict", presentation="both",
                          arrangements=None, now=self.NOW + 25,
                          event_db="/tmp/e.db", state_db="/tmp/s.db",
                          profiles_path=None)
        self.assertEqual(a, b)

    def test_distinct_params_split_keys(self):
        base = dict(days=30, model=None, provider=None, surface=None,
                    task=None, parent=None, scope=None, pricing_mode="strict",
                    presentation="both", arrangements=None, now=self.NOW,
                    event_db="/tmp/e.db", state_db="/tmp/s.db", profiles_path=None)
        key0 = analytics_key(**base)
        for field, value in (("days", 7), ("model", "m"), ("provider", "p"),
                             ("pricing_mode", "approximate"),
                             ("presentation", "spend"),
                             ("arrangements", {"routes": {}}),
                             ("event_db", "/tmp/other.db"),
                             ("state_db", "/tmp/other-state.db")):
            with self.subTest(field=field):
                other = dict(base)
                other[field] = value
                self.assertNotEqual(analytics_key(**other), key0)

    def test_midnight_boundary_splits_analytics_windows(self):
        if os.name != "posix":
            raise unittest.SkipTest("requires TZ support")
        previous = os.environ.get("TZ")
        os.environ["TZ"] = "America/New_York"
        time.tzset()
        try:
            # 2026-10-29 23:59:50 -> 2026-10-30 00:00:10 local: same instant
            # neighbourhood, different local-calendar windows.
            before = datetime(2026, 10, 29, 23, 59, 50).timestamp()
            after = datetime(2026, 10, 30, 0, 0, 10).timestamp()
            a = analytics_key(days=7, model=None, provider=None, surface=None,
                              task=None, parent=None, scope=None,
                              pricing_mode="strict", presentation="both",
                              arrangements=None, now=before,
                              event_db="/tmp/e.db", state_db="/tmp/s.db",
                              profiles_path=None)
            b = analytics_key(days=7, model=None, provider=None, surface=None,
                              task=None, parent=None, scope=None,
                              pricing_mode="strict", presentation="both",
                              arrangements=None, now=after,
                              event_db="/tmp/e.db", state_db="/tmp/s.db",
                              profiles_path=None)
            self.assertNotEqual(a, b)
        finally:
            if previous is None:
                os.environ.pop("TZ", None)
            else:
                os.environ["TZ"] = previous
            time.tzset()

    def test_economics_key_tracks_window_and_params(self):
        base = dict(days=30, trend_months=6, arrangements=None, now=self.NOW,
                    event_db="/tmp/e.db", state_db="/tmp/s.db",
                    membership_path=None, fx_file=None, plans=None,
                    profiles_path=None, data_dir=None)
        key0 = economics_key(**base)
        same = economics_key(**{**base, "now": self.NOW + 40})
        self.assertEqual(key0, same)
        for field, value in (("days", 7), ("trend_months", 3),
                             ("arrangements", {"routes": {}}),
                             ("event_db", "/tmp/other.db")):
            with self.subTest(field=field):
                other = dict(base)
                other[field] = value
                self.assertNotEqual(economics_key(**other), key0)

    def test_budgets_key_tracks_cycles_and_doc(self):
        import tempfile
        from wolfmark_ledger import budgets as B

        with tempfile.TemporaryDirectory() as tmp:
            path = f"{tmp}/budgets.json"
            doc = B.mutate("total", if_rev=B.load(path)["rev"],
                           budget={"id": "total", "label": "v",
                                   "scope": "total", "amount": 100.0,
                                   "currency": "USD", "cycle_day": 1,
                                   "timezone": "UTC", "enabled": True,
                                   "thresholds": [50, 80, 100],
                                   "provider": "", "model": "",
                                   "measurement": "api_equivalent"},
                           path=path)
            a = budgets_key(arrangements=None, now=self.NOW,
                            event_db="/tmp/e.db", state_db="/tmp/s.db",
                            budgets_path=path)
            b = budgets_key(arrangements=None, now=self.NOW + 40,
                            event_db="/tmp/e.db", state_db="/tmp/s.db",
                            budgets_path=path)
            self.assertEqual(a, b)
            # A budget edit between two concurrent requests splits them.
            B.mutate("total", if_rev=doc["rev"],
                     budget={"id": "total", "label": "v2",
                             "scope": "total", "amount": 200.0,
                             "currency": "USD", "cycle_day": 1,
                             "timezone": "UTC", "enabled": True,
                             "thresholds": [50, 80, 100],
                             "provider": "", "model": "",
                             "measurement": "api_equivalent"},
                     path=path)
            c = budgets_key(arrangements=None, now=self.NOW + 40,
                            event_db="/tmp/e.db", state_db="/tmp/s.db",
                            budgets_path=path)
            self.assertNotEqual(a, c)

    def test_session_key_has_no_time_component(self):
        a = session_key(session_id="s1", population="all", provider=None,
                        model=None, pricing="strict", arrangements=None,
                        event_db="/tmp/e.db", state_db="/tmp/s.db")
        b = session_key(session_id="s2", population="all", provider=None,
                        model=None, pricing="strict", arrangements=None,
                        event_db="/tmp/e.db", state_db="/tmp/s.db")
        c = session_key(session_id="s1", population="main", provider=None,
                        model=None, pricing="strict", arrangements=None,
                        event_db="/tmp/e.db", state_db="/tmp/s.db")
        self.assertNotEqual(a, b)
        self.assertNotEqual(a, c)

    def test_freeze_is_order_insensitive(self):
        self.assertEqual(freeze({"b": 1, "a": [1, 2]}), freeze({"a": [1, 2], "b": 1}))

    def test_global_flight_starts_empty(self):
        self.assertEqual(REPORT_FLIGHT.inflight_count(), 0)
        REPORT_FLIGHT.reset_for_tests()


try:
    from fastapi.testclient import TestClient  # noqa: F401
    from dashboard import plugin_api

    _HAS_API = True
except Exception:  # pragma: no cover - depends on the test interpreter
    _HAS_API = False


@unittest.skipUnless(_HAS_API, "FastAPI not installed in this interpreter")
class EndpointFlightTests(unittest.TestCase):
    def test_concurrent_identical_analytics_share_one_build(self):
        from unittest.mock import patch

        release = threading.Event()
        calls = []
        started = threading.Event()

        def slow_build(**kwargs):
            calls.append(1)
            started.set()
            self.assertTrue(release.wait(timeout=10))
            return {"ok": True, "window_days": kwargs.get("days")}

        def call():
            return plugin_api.analytics(days=30)

        with patch.object(plugin_api, "build_analytics_report",
                          side_effect=slow_build), \
             patch.object(plugin_api.members, "route_arrangements_payload",
                          return_value=None):
            threads = [threading.Thread(target=call) for _ in range(4)]
            for t in threads:
                t.start()
            self.assertTrue(started.wait(timeout=10))
            self.assertTrue(
                _wait_for(lambda: REPORT_FLIGHT.inflight_count() == 1))
            # All followers must attach before release: find the live key.
            self.assertTrue(_wait_for(
                lambda: sum(REPORT_FLIGHT.waiter_count(k)
                            for k in list(REPORT_FLIGHT._inflight)) == 3),
                "followers attached")
            release.set()
            for t in threads:
                t.join(timeout=10)
        self.assertEqual(len(calls), 1)
        self.assertEqual(REPORT_FLIGHT.inflight_count(), 0)

    def test_sequential_endpoint_calls_recompute(self):
        from unittest.mock import patch

        calls = []
        with patch.object(plugin_api, "build_analytics_report",
                          side_effect=lambda **k: calls.append(1) or {"ok": True}), \
             patch.object(plugin_api.members, "route_arrangements_payload",
                          return_value=None):
            plugin_api.analytics(days=7)
            plugin_api.analytics(days=7)
        # Same window, but sequential: no cross-time sharing, ever.
        self.assertEqual(len(calls), 2)
