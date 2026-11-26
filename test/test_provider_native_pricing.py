"""Provider-native pricing: the Nous UAT regression and its general contract.

Fixtures are sanitised derivatives of the 25 November 2026 provider evidence
(35 billed requests, a 37-call session): no account identifiers, no live
network. The resolver is injected, so the suite never touches ``hermes_cli``.
"""
from __future__ import annotations

import sqlite3
import tempfile
import time
import unittest
from decimal import Decimal
from contextlib import closing
from pathlib import Path

from wolfmark_ledger import analytics, provider_native, store
from wolfmark_ledger.pricing import Catalogue, Rate, load_catalogue, resolve_rate

NOW = 1_764_000_000.0

# The provider's own row for the dated variant (per-token strings, as Hermes'
# resolver returns them), verified against the portal's list price and a
# provider usage export on 2026-11-25.
NOUS_ROW = {
    "prompt": "0.0000000300",           # $0.03 / 1M effective
    "completion": "0.0000001200",       # $0.12 / 1M effective
    "input_cache_read": "0.0000000006",  # $0.0006 / 1M effective
    "original": {
        "prompt": "0.0000001500",          # $0.15 / 1M list
        "completion": "0.0000006000",      # $0.60 / 1M list
        "input_cache_read": "0.0000000030",  # $0.003 / 1M list
    },
    "name": "DeepSeek: DeepSeek V4.1 Flash 1017",
}
NOUS_EFFECTIVE = (0.03, 0.12, 0.0006)
NOUS_LIST = (0.15, 0.60, 0.003)
# $/MTok Decimal tuples for the provider-CSV reconciliation fixtures.
NOUS_LIST_D = (Decimal("0.15"), Decimal("0.6"), Decimal("0.003"))
NOUS_EFF = (Decimal("0.03"), Decimal("0.12"), Decimal("0.0006"))
M = Decimal(1_000_000)

# Provider export totals (35 billed requests, session 2026-11-25).
CSV_INPUT_TOKENS = 1_781_183
CSV_CACHE_READ_TOKENS = 1_676_672
CSV_FRESH_TOKENS = CSV_INPUT_TOKENS - CSV_CACHE_READ_TOKENS  # 104,511
CSV_OUTPUT_TOKENS = 20_722
CSV_DEBIT_USD = 0.0066279732
# The one billed request SpendSense never recorded.
MISSING_FRESH_TOKENS = 40_943
MISSING_OUTPUT_TOKENS = 255
# The 34 recorded nous calls + 3 commandcode aux calls.
STORE_FRESH_TOKENS = CSV_FRESH_TOKENS - MISSING_FRESH_TOKENS      # 63,568
STORE_OUTPUT_TOKENS = CSV_OUTPUT_TOKENS - MISSING_OUTPUT_TOKENS   # 20,467
AUX_LIST_USD = 0.000224            # 3 aux calls at the commandcode minimax card
RECORDED_LIST_USD = 0.026845       # recorded nous calls at list rates
RECORDED_EFFECTIVE_USD = 0.005369  # recorded nous calls at effective rates
FULL_LIST_USD = 0.033140           # whole population at list (rounded)
FULL_EFFECTIVE_USD = CSV_DEBIT_USD  # whole population at effective rates


def _fake_resolver(rows_by_provider):
    def resolver(provider, *, force_refresh=False, cached_only=False, base_url=""):
        return dict(rows_by_provider.get(provider) or {})
    return resolver


class ProviderNativeTestCase(unittest.TestCase):
    def setUp(self):
        provider_native.reset_for_tests()
        self.scratch = tempfile.TemporaryDirectory()
        self.addCleanup(self.scratch.cleanup)
        self.addCleanup(provider_native.reset_for_tests)
        self.events = Path(self.scratch.name) / "usage.db"
        self.state = Path(self.scratch.name) / "state.db"
        with closing(sqlite3.connect(self.events)) as conn, conn:
            conn.executescript(store._SCHEMA)

    # -- fixtures ---------------------------------------------------------
    def inject(self, rows_by_provider):
        provider_native._resolver = lambda: _fake_resolver(rows_by_provider)  # type: ignore[assignment]

    def add_call(self, *, provider="nous", model="deepseek/deepseek-v4.1-flash-1017",
                 fresh=1_000, cache_read=0, output=10, event_id=None, **extra):
        values = {"event_id": event_id or f"event-{time.time_ns()}",
                  "ts": NOW - 60, "session_id": "s1", "model": model,
                  "provider": provider, "platform": "desktop", "outcome": "ok",
                  "recorded_at": NOW,
                  "input_tokens": fresh, "cache_read_tokens": cache_read,
                  "cache_write_tokens": 0, "output_tokens": output,
                  "prompt_tokens": fresh + cache_read,
                  "total_tokens": fresh + cache_read + output,
                  **extra}
        with closing(sqlite3.connect(self.events)) as conn, conn:
            columns = list(values)
            conn.execute(f"INSERT INTO calls ({','.join(columns)}) VALUES "
                         f"({','.join('?' for _ in columns)})", list(values.values()))

    def summary(self, **kwargs):
        kwargs.setdefault("session_id", "s1")
        return analytics.build_session_summary(
            self.events, state_db_path=self.state, catalogue=load_catalogue(),
            now=NOW, **kwargs)

    # -- 1. rate parsing and bases ---------------------------------------
    def test_effective_and_list_bases_come_from_the_provider_row(self):
        self.inject({"nous": {"deepseek/deepseek-v4.1-flash-1017": dict(NOUS_ROW)}})
        native = provider_native.lookup("nous", "deepseek/deepseek-v4.1-flash-1017")
        self.assertIsNotNone(native)
        self.assertEqual((native.input, native.output, native.cache_read), NOUS_EFFECTIVE)
        self.assertEqual((native.list_input, native.list_output, native.list_cache_read),
                         NOUS_LIST)
        listed = native.list_rate()
        self.assertEqual((listed.input, listed.output, listed.cache_read), NOUS_LIST)

    def test_row_without_original_falls_back_to_effective_for_the_list_hit(self):
        # A row with no "original" may back the standard list valuation only
        # for sources whose native rows are verifiably standard public API
        # prices (openrouter/ai-gateway/fireworks/deepinfra). Nous is
        # credential-scoped with an account-wide credits discount, so its
        # effective-only row must never stand in for the list basis.
        self.inject({"nous": {"m": {"prompt": "0.0000000300", "completion": "0.0000001200"}},
                     "openrouter": {"m": {"prompt": "0.0000000300", "completion": "0.0000001200"}}})
        nous_hit, nous_native = resolve_rate(load_catalogue(), "nous", "m")
        self.assertIsNone(nous_hit,
                          "a credential-scoped effective-only row is not list evidence")
        self.assertIsNotNone(nous_native)
        if nous_native is not None:  # pragma: no cover - narrows for the type checker
            self.assertEqual(nous_native.provider, "nous")
        or_hit, _ = resolve_rate(load_catalogue(), "openrouter", "m")
        self.assertIsNotNone(or_hit)
        if or_hit is not None:  # pragma: no cover - narrows for the type checker
            self.assertEqual((or_hit.rate.input, or_hit.rate.output), (0.03, 0.12))
            self.assertEqual(or_hit.provenance, "provider_native")
            self.assertIn("openrouter", or_hit.source)
            self.assertIn("standard public rates", or_hit.source)
            self.assertIn("effective basis", or_hit.source)

    def test_absent_rates_are_absent_not_zero(self):
        self.inject({"nous": {"m": dict(NOUS_ROW)}})
        native = provider_native.lookup("nous", "m")
        self.assertIsNotNone(native)
        if native is None:  # pragma: no cover - narrows for the type checker
            return
        self.assertIsNone(native.list_rate().cache_write)

    def test_incomplete_and_invalid_rows_never_price(self):
        # A missing base side is not a free rate; a negative or non-finite
        # value is broken metadata, and a present-but-invalid cache-read rate
        # rejects the row rather than inventing a zero.
        self.inject({"nous": {
            "half": {"prompt": "0.0000000300"},
            "negative": {"prompt": "-0.0000000300", "completion": "0.0000001200"},
            "nan": {"prompt": "NaN", "completion": "0.0000001200"},
            "inf": {"prompt": "Infinity", "completion": "0.0000001200"},
            "badread": {"prompt": "0.0000000300", "completion": "0.0000001200",
                        "input_cache_read": "-0.0000000006"},
            "free": {"prompt": "0", "completion": "0.0000001200",
                     "input_cache_read": "0"},
        }})
        for model in ("half", "negative", "nan", "inf", "badread"):
            self.assertIsNone(provider_native.lookup("nous", model), model)
        free = provider_native.lookup("nous", "free")
        self.assertIsNotNone(free)
        if free is None:  # pragma: no cover - narrows for the type checker
            return
        self.assertEqual((free.input, free.output, free.cache_read), (0.0, 0.12, 0.0))

    def test_transient_resolver_failure_retries_after_the_window(self):
        calls = {"n": 0}

        def flaky(provider, *, force_refresh=False, cached_only=False):
            calls["n"] += 1
            if calls["n"] == 1:
                raise OSError("temporary failure")
            return {"m": dict(NOUS_ROW)}

        provider_native._resolver = lambda: flaky  # type: ignore[assignment]
        self.assertIsNone(provider_native.lookup("nous", "m"),
                          "a raised fetch must not price the window")
        # The failure is not cached as permanent: the very next window (the
        # test rewinds the marker) resolves the row.
        with provider_native._lock:
            provider_native._last_fetch_attempt.clear()
        native = provider_native.lookup("nous", "m")
        self.assertIsNotNone(native)

    def test_empty_catalog_from_a_served_provider_is_not_permanent(self):
        self.inject({"nous": {}})
        self.assertIsNone(provider_native.lookup("nous", "m"))
        # Still retryable: no _missing_provider verdict for a served provider.
        self.assertNotIn("nous", provider_native._missing_provider)

    def test_unknown_fetcher_verdict_is_retryable_not_permanent(self):
        # When the fetcher check itself cannot decide (the Hermes internals
        # could not be imported, normalisation raised), the provider must NOT
        # be cached as permanently unsupported: an unknown status retries.
        self.inject({})  # a fake resolver, so the fetcher check is skipped
        provider_native._resolver = provider_native._real_resolver  # real path
        provider_native.reset_for_tests()
        with provider_native._lock:
            provider_native._missing_provider.clear()
        real = provider_native._has_native_fetcher
        provider_native._has_native_fetcher = lambda key: None  # type: ignore[method-assign]
        try:
            self.assertIsNone(provider_native.lookup("nous", "m"))
            self.assertNotIn("nous", provider_native._missing_provider,
                             "an unknown verdict must never cache absence")
            provider_native._has_native_fetcher = lambda key: False  # type: ignore[method-assign]
            provider_native._missing_provider.clear()
            self.assertIsNone(provider_native.lookup("nous", "m"))
            self.assertIn("nous", provider_native._missing_provider,
                          "a definitive no-fetcher verdict is permanent")
        finally:
            provider_native._has_native_fetcher = real  # type: ignore[method-assign]

    # -- 2. explicit model identity ---------------------------------------
    def test_exact_dated_variant_matches_exactly(self):
        self.inject({"nous": {"deepseek/deepseek-v4.1-flash-1017": dict(NOUS_ROW)}})
        native = provider_native.lookup("nous", "deepseek/deepseek-v4.1-flash-1017")
        self.assertIsNotNone(native)
        self.assertEqual(native.model, "deepseek/deepseek-v4.1-flash-1017")

    def test_bare_suffix_falls_back_but_namespace_is_not_invented(self):
        self.inject({"nous": {"deepseek-v4.1-flash-1017": dict(NOUS_ROW)}})
        self.assertIsNotNone(provider_native.lookup("nous", "deepseek/deepseek-v4.1-flash-1017"))
        self.assertIsNone(provider_native.lookup("nous", "deepseek/deepseek-v9.9"))

    def test_no_cross_provider_borrow(self):
        self.inject({"nous": {"m": dict(NOUS_ROW)}})
        self.assertIsNone(provider_native.lookup("openai", "m"))

    # -- 3. precedence -----------------------------------------------------
    def test_catalogue_card_wins_over_native(self):
        card = Rate(input=0.9, output=4.5, cache_read=0.09, cache_write=None)
        book = Catalogue({"nous": {"other": card}}, "fixture", "test", "2026-11-25", "1")
        self.inject({"nous": {"m": dict(NOUS_ROW)}})
        hit, native = resolve_rate(book, "nous", "other")
        self.assertEqual(hit.rate.input, 0.9)
        self.assertEqual(hit.provenance, "models_dev_route")
        self.assertIsNone(native)

    def test_native_fills_only_a_gap(self):
        card = Rate(input=0.9, output=4.5, cache_read=0.09, cache_write=None)
        book = Catalogue({"nous": {"other": card}}, "fixture", "test", "2026-11-25", "1")
        self.inject({"nous": {"m": dict(NOUS_ROW)}})
        hit, native = resolve_rate(book, "nous", "m")
        self.assertIsNotNone(hit)
        self.assertEqual((hit.rate.input, hit.rate.output), NOUS_LIST[:2])
        self.assertEqual(hit.rate.cache_read, NOUS_LIST[2])
        self.assertEqual(hit.provenance, "provider_native")
        self.assertEqual((native.input, native.output, native.cache_read), NOUS_EFFECTIVE)

    def test_unresolvable_route_stays_unpriced(self):
        book = load_catalogue()
        self.inject({})  # resolver present, provider unknown to it
        hit, native = resolve_rate(book, "nous", "deepseek/deepseek-v4.1-flash-1017")
        self.assertIsNone(hit)
        self.assertIsNone(native)

    def test_native_rates_beat_an_opted_in_foreign_borrow(self):
        # With third-party pricing enabled, a foreign catalogue card for the
        # same model must not displace the provider's own row: the borrow
        # applies only when the strict catalogue AND native pricing both miss.
        book = Catalogue({"openrouter": {"m": Rate(input=0.075, output=0.3,
                                                   cache_read=0.0015, cache_write=None),
                                         "other-model": Rate(input=0.075, output=0.3,
                                                             cache_read=0.0015, cache_write=None)}},
                         "fixture", "test", "2026-11-25", "1")
        self.inject({"nous": {"m": dict(NOUS_ROW)}})
        hit, native = resolve_rate(book, "nous", "m",
                                   allow_third_party=True, allow_approximate=False)
        self.assertIsNotNone(hit)
        self.assertEqual(hit.provenance, "provider_native")
        self.assertEqual((hit.rate.input, hit.rate.output, hit.rate.cache_read), NOUS_LIST)
        self.assertIsNotNone(native)
        # The borrow still rescues a route with no native row at all.
        hit2, native2 = resolve_rate(book, "nous", "other-model",
                                     allow_third_party=True, allow_approximate=False)
        self.assertIsNotNone(hit2)
        self.assertEqual(hit2.provenance, "third_party")
        self.assertIsNone(native2)

    # -- 4. graceful degradation ------------------------------------------
    def test_missing_host_resolver_degrades_to_the_old_behaviour(self):
        # Simulate the process state _resolver() itself sets when the host app
        # is absent: the import failed, the resolver is None, nothing changes.
        provider_native._resolver = lambda: None  # type: ignore[assignment]
        provider_native._import_failed = True
        self.assertTrue(provider_native.unavailable())
        self.assertIsNone(provider_native.lookup("nous", "deepseek/deepseek-v4.1-flash-1017"))
        hit, native = resolve_rate(load_catalogue(), "nous", "deepseek/deepseek-v4.1-flash-1017")
        self.assertIsNone(hit)
        self.assertIsNone(native)

    # -- 5. session integration -------------------------------------------
    def test_session_is_priced_at_list_with_a_separate_effective_estimate(self):
        self.inject({"nous": {"deepseek/deepseek-v4.1-flash-1017": dict(NOUS_ROW)}})
        self.add_call(fresh=50_000, cache_read=1_000_000, output=500)
        payload = self.summary(population="all")
        valuation = payload["valuation"]
        self.assertEqual(valuation["api_equivalent_usd"], 0.0108)
        self.assertEqual(valuation["read_benefit_usd"], 0.147)
        self.assertEqual(valuation["provider_effective_usd"], 0.00216)
        self.assertEqual(valuation["provider_effective_basis"], "exact")
        self.assertEqual(valuation["provider_effective_calls"], 1)
        self.assertNotIn("provider_price_catalogue_missing", valuation["gap_reasons"])
        # The net comparison is untouched: the write counter is unproven and
        # the provider publishes no write price, so savings stay withheld.
        self.assertIsNone(valuation["savings_usd"])
        self.assertEqual(valuation["savings_bound_reason"], "write_rate_missing")

    def test_effective_estimate_is_partial_with_named_coverage(self):
        self.inject({"nous": {"deepseek/deepseek-v4.1-flash-1017": dict(NOUS_ROW)}})
        self.add_call(fresh=50_000, cache_read=1_000_000, output=500)
        self.add_call(provider="otherco", model="m2", fresh=10, output=1)
        payload = self.summary(population="all")
        valuation = payload["valuation"]
        self.assertEqual(valuation["provider_effective_basis"], "partial")
        self.assertEqual(valuation["provider_effective_calls"], 1)
        self.assertEqual(valuation["provider_effective_tokens"], 1_050_500)

    def test_no_native_rates_publish_no_effective_figure(self):
        self.inject({})  # a resolver with no rows for this provider
        self.add_call(fresh=1_000, output=10)
        payload = self.summary(population="all")
        self.assertIsNone(payload["valuation"]["provider_effective_usd"])
        self.assertIsNone(payload["valuation"]["provider_effective_basis"])

    def test_unpriced_read_leaves_the_call_out_of_the_effective_estimate(self):
        # A provider row without input_cache_read: reads are real tokens with
        # no published rate, so the call cannot be a covered effective-cost
        # population — a guessed cache rate would look exact.
        self.inject({"nous": {"m": {"prompt": "0.0000000300",
                                    "completion": "0.0000001200"}}})
        self.add_call(provider="nous", model="m", fresh=1_000, cache_read=500, output=10)
        payload = self.summary(population="all")
        valuation = payload["valuation"]
        self.assertIsNone(valuation["provider_effective_usd"])
        self.assertIsNone(valuation["provider_effective_basis"])
        self.assertEqual(valuation["provider_effective_calls"], 0)

    def test_positive_cache_writes_are_never_an_effective_estimate(self):
        # Native rows publish no write price: a call with recorded writes is
        # excluded from the measured estimate rather than priced at the input
        # rate by a substitution.
        self.inject({"nous": {"deepseek/deepseek-v4.1-flash-1017": dict(NOUS_ROW)}})
        self.add_call(fresh=1_000, cache_read=500, cache_write_tokens=300, output=10)
        payload = self.summary(population="all")
        valuation = payload["valuation"]
        self.assertIsNone(valuation["provider_effective_usd"])
        self.assertIsNone(valuation["provider_effective_basis"])

    def test_effective_basis_demands_call_coverage_not_only_tokens(self):
        # One covered call plus one missing-usage call with zero recorded
        # tokens: token equality alone would claim exact over a population of
        # two, so the basis must demand call coverage too.
        self.inject({"nous": {"deepseek/deepseek-v4.1-flash-1017": dict(NOUS_ROW)}})
        self.add_call(fresh=1_000, output=10)
        self.add_call(fresh=0, cache_read=0, output=0, outcome="missing_usage")
        payload = self.summary(population="all")
        self.assertEqual(payload["valuation"]["provider_effective_basis"], "partial")

    # -- 6. the Nous UAT reconciliation (sanitised) ------------------------
    def test_nous_csv_reconciles_to_the_token_and_the_tenth_decimal(self):
        from decimal import Decimal
        M = Decimal(1_000_000)
        # The provider's own published strings, scaled from per-token to $/MTok.
        d_eff = [Decimal(NOUS_ROW["prompt"]) * M,
                 Decimal(NOUS_ROW["completion"]) * M,
                 Decimal(NOUS_ROW["input_cache_read"]) * M]
        original = NOUS_ROW["original"]
        d_list = [Decimal(original["prompt"]) * M,
                  Decimal(original["completion"]) * M,
                  Decimal(original["input_cache_read"]) * M]
        # Token populations: the provider's input includes cached input.
        self.assertEqual(STORE_FRESH_TOKENS + MISSING_FRESH_TOKENS, CSV_FRESH_TOKENS)
        self.assertEqual(CSV_FRESH_TOKENS + CSV_CACHE_READ_TOKENS, CSV_INPUT_TOKENS)
        self.assertEqual(STORE_OUTPUT_TOKENS + MISSING_OUTPUT_TOKENS, CSV_OUTPUT_TOKENS)
        # Effective (billed) rates reproduce the debit exactly.
        debit = ((Decimal(CSV_FRESH_TOKENS) * d_eff[0]
                  + Decimal(CSV_CACHE_READ_TOKENS) * d_eff[2]
                  + Decimal(CSV_OUTPUT_TOKENS) * d_eff[1]) / M)
        self.assertEqual(debit, Decimal("0.0066279732"))
        # The standard list valuation is a different, larger figure.
        listed = ((Decimal(CSV_FRESH_TOKENS) * d_list[0]
                   + Decimal(CSV_CACHE_READ_TOKENS) * d_list[2]
                   + Decimal(CSV_OUTPUT_TOKENS) * d_list[1]) / M)
        self.assertEqual(listed, Decimal("0.033139866"))
        # Accounted separately: the billed request SpendSense never recorded.
        missing_effective = ((Decimal(MISSING_FRESH_TOKENS) * d_eff[0]
                              + Decimal(MISSING_OUTPUT_TOKENS) * d_eff[1]) / M)
        self.assertEqual(missing_effective, Decimal("0.00125889"))
        self.assertEqual(Decimal("0.033139866") - Decimal("0.026845416"),
                         Decimal("0.006294450"))

    def test_recorded_population_values_through_the_real_path(self):
        self.inject({"nous": {"deepseek/deepseek-v4.1-flash-1017": dict(NOUS_ROW)}})
        self.add_call(fresh=STORE_FRESH_TOKENS, cache_read=CSV_CACHE_READ_TOKENS,
                      output=STORE_OUTPUT_TOKENS)
        payload = self.summary(population="all")
        valuation = payload["valuation"]
        self.assertEqual(valuation["api_equivalent_usd"], RECORDED_LIST_USD)
        self.assertEqual(valuation["provider_effective_usd"], RECORDED_EFFECTIVE_USD)
        self.assertEqual(valuation["provider_effective_basis"], "exact")
        # The unrecorded request is the difference to the provider evidence.
        self.assertNotEqual(valuation["provider_effective_usd"], CSV_DEBIT_USD)
        self.assertAlmostEqual(CSV_DEBIT_USD - valuation["provider_effective_usd"],
                               0.00125889, delta=1e-6)

    # -- 7. other routes are untouched -------------------------------------
    def test_priced_routes_keep_their_catalogue_valuation(self):
        self.inject({"nous": {"deepseek/deepseek-v4.1-flash-1017": dict(NOUS_ROW)}})
        self.add_call(provider="commandcode", model="deepseek/deepseek-v4.1-flash",
                      fresh=10_000, cache_read=400_000, output=2_000)
        payload = self.summary(population="all")
        valuation = payload["valuation"]
        # commandcode's catalogue card (0.15/0.6/0.003): unchanged by native wiring.
        self.assertEqual(valuation["api_equivalent_usd"], 0.0039)
        # commandcode has no native pricing source: no effective estimate.
        self.assertEqual(valuation["provider_effective_calls"], 0)
        self.assertIsNone(valuation["provider_effective_usd"])


if __name__ == "__main__":
    unittest.main()


class NousCreditsDayFixture(unittest.TestCase):
    """The full 25 November Nous credits export, three key rows.

    Independent provider evidence: every key row reconciles Decimal-exactly
    at the effective (credits) rates, while the list valuation is a larger
    comparative figure — money spent is never the undiscounted list price.
    """

    DAY_ROWS = (
        # (requests, input incl cache, output, cache_read, debit USD)
        (64, 9_244_240, 71_002, 8_773_760, Decimal("0.027898896")),
        (28, 3_130_995, 39_390, 2_999_040, Decimal("0.010484874")),
        (35, 1_781_183, 20_722, 1_676_672, Decimal("0.0066279732")),
    )
    DAY_DEBIT = Decimal("0.0450117432")

    def test_every_key_row_reconciles_at_effective_rates(self):
        total = Decimal(0)
        for requests, inp, out, read, debit in self.DAY_ROWS:
            fresh = inp - read
            self.assertGreaterEqual(fresh, 0)
            effective = ((Decimal(fresh) * NOUS_EFF[0] + Decimal(read) * NOUS_EFF[2]
                          + Decimal(out) * NOUS_EFF[1]) / M)
            self.assertEqual(effective, debit, f"row {requests} requests")
            listed = ((Decimal(fresh) * NOUS_LIST_D[0] + Decimal(read) * NOUS_LIST_D[2]
                       + Decimal(out) * NOUS_LIST_D[1]) / M)
            self.assertGreater(listed, debit)
            total += debit
        self.assertEqual(total, self.DAY_DEBIT)

    def test_list_valuation_is_never_the_money_spent(self):
        fresh = sum(inp - read for _, inp, _, read, _ in self.DAY_ROWS)
        out = sum(out for _, _, out, _, _ in self.DAY_ROWS)
        read = sum(read for *_, read, _ in self.DAY_ROWS)
        listed = ((Decimal(fresh) * NOUS_LIST_D[0] + Decimal(read) * NOUS_LIST_D[2]
                   + Decimal(out) * NOUS_LIST_D[1]) / M)
        self.assertEqual(listed, Decimal("0.225058716"))
        self.assertGreater(listed, self.DAY_DEBIT)


class CommandCodeCatalogueCoverage(ProviderNativeTestCase):
    """Command Code's own published model page prices, via the official overlay.

    Command Code publishes muse-ember on its model page ($0.10/M input,
    $0.50/M output, cache reads $0.004/M; cache-write pricing not published)
    but the models.dev commandcode listing omitted the model. The overlay
    carries only Command Code's own published rates — no borrowed provider
    rates, no invented cache-write price.
    """

    def test_muse_ember_prices_from_the_official_overlay(self):
        self.inject({"commandcode": {}})
        hit, _native = resolve_rate(load_catalogue(), "commandcode", "meta/muse-ember")
        self.assertIsNotNone(hit)
        if hit is not None:  # pragma: no cover - narrows for the type checker
            self.assertEqual(hit.provenance, "official_verified")
            self.assertEqual((hit.rate.input, hit.rate.output, hit.rate.cache_read),
                             (0.10, 0.50, 0.004))
            self.assertIsNone(hit.rate.cache_write,
                              "cache-write pricing is not published — never asserted")

    def test_no_borrowed_rates_for_unpublished_cache_writes(self):
        # The models.dev openrouter row for the same model carries a cache
        # write price; the commandcode route must not inherit it.
        self.inject({"commandcode": {}})
        hit, _native = resolve_rate(load_catalogue(), "commandcode", "meta/muse-ember")
        if hit is not None:  # pragma: no cover - narrows for the type checker
            self.assertEqual(hit.rate.cache_write, None)
            self.assertNotIn("openrouter", (hit.source or "").lower())

    def test_aggregate_list_valuation_falls_back_to_the_native_original(self):
        # models.dev dropped the `nous` section, so the server catalogue
        # misses the route entirely; the provider's own `original` block
        # still evidences the undiscounted list price (the #119 gate).
        from wolfmark_ledger.aggregate import _event_result
        from wolfmark_ledger.pricing import Catalogue as _Catalogue
        self.inject({"nous": {"deepseek/deepseek-v4.1-flash-1017": dict(NOUS_ROW)}})
        empty_book = _Catalogue({}, "empty", "test", "", "1")
        row = {"provider": "nous", "model": "deepseek/deepseek-v4.1-flash-1017",
               "input_tokens": 50_000, "cache_read_tokens": 1_000_000,
               "cache_write_tokens": 0, "output_tokens": 500,
               "ts": NOW, "outcome": "ok"}
        result = _event_result(row, empty_book, "hybrid", {}, at=row["ts"])
        # 50k fresh + 1M cached read + 500 output at the original list rates.
        expected = 50_000 / 1e6 * 0.15 + 1_000_000 / 1e6 * 0.003 + 500 / 1e6 * 0.6
        self.assertAlmostEqual(result["list_usd"], round(expected, 6), places=6)
        self.assertEqual(result["pricing_miss"], "")
        # Expenditure keeps the effective basis, distinct from the list.
        self.assertAlmostEqual(result["expenditure_usd"],
                               round(50_000 / 1e6 * 0.03 + 1_000_000 / 1e6 * 0.0006
                                     + 500 / 1e6 * 0.12, 6), places=6)

    def test_native_row_without_original_never_backs_the_list(self):
        # The #119 gate: an original-less row prices the effective basis only.
        from wolfmark_ledger.aggregate import _event_result
        from wolfmark_ledger.pricing import Catalogue as _Catalogue
        row_data = {"prompt": "0.0000000300", "completion": "0.0000001200",
                    "input_cache_read": "0.0000000006"}
        self.inject({"nous": {"deepseek/deepseek-v4.1-flash-1017": dict(row_data)}})
        empty_book = _Catalogue({}, "empty", "test", "", "1")
        row = {"provider": "nous", "model": "deepseek/deepseek-v4.1-flash-1017",
               "input_tokens": 1_000, "cache_read_tokens": 0,
               "cache_write_tokens": 0, "output_tokens": 10,
               "ts": NOW, "outcome": "ok"}
        result = _event_result(row, empty_book, "hybrid", {}, at=row["ts"])
        self.assertIsNone(result["list_usd"])
        self.assertEqual(result["pricing_miss"], "provider_not_in_catalogue")
        self.assertIsNotNone(result["expenditure_usd"],
                             "the effective basis still prices the call")
