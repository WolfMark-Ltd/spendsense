"""RateMemo correctness: memoised pricing equals direct resolution.

Deterministic (no wall-clock thresholds): same inputs through the memo and
through the unmemoised path must produce equal results, distinct inputs must
never share results, and resolver call counts must collapse to the number of
distinct route shapes. Uses isolated fixtures only.
"""
from __future__ import annotations

import unittest
from datetime import datetime, timezone

from wolfmark_ledger import provider_native
from wolfmark_ledger.pricing import (
    Catalogue, Rate, RateMemo, Tier, resolve_rate,
)


def _book():
    book = Catalogue(
        {"test": {"m0": Rate(2.0, 4.0, 0.5, 3.0,
                             tiers=(Tier(threshold=100000, input=1.5),),
                             cache_write_rates=(("30m", 3.0), ("12h", 5.0))),
                  "m1": Rate(2.0, 4.0, 0.5, 3.0)},
         "other": {"m2": Rate(1.0, 2.0)}},
        "fixture", "test", "", "1")
    # Official overlay WITH weekday windows on test/m0 (Mon-Fri 09:00-17:00).
    book.official[("test", "m0")] = (
        Rate(2.0, 4.0, 0.5, 3.0), "2026-10-01",
        (((0, 1, 2, 3, 4), 540, 1020, 3.0, 5.0, 0.75, 3.5),))
    return book


ROWS = {
    "nouslike": {"n0": {"prompt": "0.0000015", "completion": "0.000006",
                        "input_cache_read": "0.0000002"}},
}


def _use_fake_resolver(test):
    def fake_resolver(provider, *, force_refresh=False, cached_only=False, base_url=""):
        test.resolver_calls.append(provider)
        return dict(ROWS.get(provider) or {})
    test.resolver_calls = []
    provider_native.reset_for_tests()
    provider_native._resolver = lambda: fake_resolver
    test.addCleanup(provider_native.reset_for_tests)


def _ts(y, m, d, hh, mm):
    return datetime(y, m, d, hh, mm, tzinfo=timezone.utc).timestamp()


class RateMemoTests(unittest.TestCase):
    def setUp(self):
        _use_fake_resolver(self)
        self.book = _book()

    def test_memo_matches_direct_across_routes_flags_and_times(self):
        memo = RateMemo(self.book)
        # A Monday 10:00 (inside the test/m0 window), a Sunday 10:00
        # (outside: weekend), a Monday 08:00 (outside: off-peak) and None.
        stamps = [_ts(2026, 10, 26, 10, 0), _ts(2026, 11, 1, 10, 0),
                  _ts(2026, 10, 26, 8, 0), None]
        routes = [("test", "m0"), ("test", "m1"), ("other", "m2"),
                  ("nouslike", "n0"), ("ghost", "g0"), ("", ""),
                  (" TEST ", "m1"), ("test", "org/m1")]
        for flags in ({}, {"allow_third_party": True},
                      {"allow_approximate": True}):
            for provider, model in routes:
                for at in stamps:
                    with self.subTest(provider=provider, model=model, at=at, **flags):
                        want = resolve_rate(self.book, provider, model, at=at,
                                            native_fetch=True, **flags)
                        got = memo.resolve(provider, model, at=at,
                                           native_fetch=True, **flags)
                        self.assertEqual(got[0], want[0])
                        self.assertEqual(
                            None if got[1] is None else
                            {k: v for k, v in got[1].__dict__.items() if k != "as_of"},
                            None if want[1] is None else
                            {k: v for k, v in want[1].__dict__.items() if k != "as_of"})
                        # Native leg matches too (as_of frozen by design).
                        want_n = provider_native.lookup(provider, model, allow_fetch=True)
                        got_n = memo.native(provider, model, allow_fetch=True)
                        self.assertEqual(
                            None if got_n is None else
                            {k: v for k, v in got_n.__dict__.items() if k != "as_of"},
                            None if want_n is None else
                            {k: v for k, v in want_n.__dict__.items() if k != "as_of"})

    def test_windowed_route_prices_each_event_at_its_own_time(self):
        memo = RateMemo(self.book)
        peak, _ = memo.resolve("test", "m0", at=_ts(2026, 10, 26, 10, 0))
        off, _ = memo.resolve("test", "m0", at=_ts(2026, 10, 26, 8, 0))
        weekend, _ = memo.resolve("test", "m0", at=_ts(2026, 11, 1, 10, 0))
        self.assertEqual(peak.rate.input, 3.0)
        self.assertEqual(peak.provisional, ("cache_read",))
        self.assertEqual(off.rate.input, 2.0)
        self.assertEqual(off.provisional, ())
        self.assertEqual(weekend.rate.input, 2.0)

    def test_distinct_inputs_never_share_results(self):
        memo = RateMemo(self.book)
        # ghost/m0: strict misses (ghost has no card) but approximate can
        # borrow test/m0.
        strict, _ = memo.resolve("ghost", "m0")
        approx, _ = memo.resolve("ghost", "m0", allow_approximate=True)
        self.assertIsNone(strict)
        self.assertIsNotNone(approx)
        self.assertEqual(approx.provenance, "approximate")
        # An approximate borrow must not leak into the strict entry or
        # vice versa: re-resolving strict still misses.
        strict2, _ = memo.resolve("ghost", "m0")
        self.assertIsNone(strict2)

    def test_unparsable_at_calls_through_like_legacy(self):
        memo = RateMemo(self.book)
        # A windowed route with garbage `at` raises from the tariff check
        # on the legacy path; the memo must raise identically, not memoise.
        with self.assertRaises((TypeError, ValueError)):
            memo.resolve("test", "m0", at="not-a-timestamp")
        with self.assertRaises((TypeError, ValueError)):
            resolve_rate(self.book, "test", "m0", at="not-a-timestamp")
        # A non-windowed route ignores `at` either way.
        hit, _ = memo.resolve("test", "m1", at="not-a-timestamp")
        self.assertIsNotNone(hit)

    def test_resolver_call_counts_collapse_to_distinct_routes(self):
        memo = RateMemo(self.book)
        events = [("test", "m0", _ts(2026, 10, 26, h, m))
                  for h in range(24) for m in (0, 30)]
        events += [("other", "m2", _ts(2026, 10, 26, 12, 0))] * 50
        for provider, model, at in events:
            memo.resolve(provider, model, at=at)
            memo.native(provider, model)
        # One provider fetch per distinct natively-supported route; the
        # catalogue-only routes never touch the resolver at all.
        self.assertLessEqual(len(self.resolver_calls), 2)
        self.assertEqual(len(memo._resolve_cache), 2)
        self.assertEqual(len(memo._native_cache), 2)

    def test_catalogue_mismatch_is_refused_loudly(self):
        from wolfmark_ledger.aggregate import _event_result
        other = Catalogue({"x": {"y": Rate(1, 1)}}, "other", "test", "", "1")
        memo = RateMemo(other)
        row = {"provider": "test", "model": "m0", "ts": _ts(2026, 10, 26, 12, 0)}
        with self.assertRaises(ValueError):
            _event_result(row, self.book, "list", {}, rate_memo=memo)

    def test_expired_memo_calls_through(self):
        memo = RateMemo(self.book, max_age_s=-1.0)  # already expired
        before = len(self.resolver_calls)
        memo.resolve("nouslike", "n0", at=_ts(2026, 10, 26, 12, 0))
        memo.resolve("nouslike", "n0", at=_ts(2026, 10, 26, 12, 0))
        self.assertEqual(memo._resolve_cache, {})
        # Each call went to the live resolver (2 fetches for 2 events).
        self.assertEqual(len(self.resolver_calls) - before, 2)

    def test_plain_lookup_never_touches_native_rows(self):
        memo = RateMemo(self.book)
        before = len(self.resolver_calls)
        hit = memo.lookup("other", "m2", at=_ts(2026, 10, 26, 12, 0))
        self.assertIsNotNone(hit)
        self.assertEqual(len(self.resolver_calls) - before, 0)
        # Windowed plain lookups still price per event time.
        peak = memo.lookup("test", "m0", at=_ts(2026, 10, 26, 10, 0))
        off = memo.lookup("test", "m0", at=_ts(2026, 10, 26, 8, 0))
        self.assertEqual(peak.rate.input, 3.0)
        self.assertEqual(off.rate.input, 2.0)

    def test_as_of_freezes_per_report(self):
        memo = RateMemo(self.book, as_of="2026-10-29T12:00:00Z")
        n1 = memo.native("nouslike", "n0")
        n2 = memo.native("nouslike", "n0")
        self.assertEqual(n1.as_of, "2026-10-29T12:00:00Z")
        self.assertIs(n1, n2)
