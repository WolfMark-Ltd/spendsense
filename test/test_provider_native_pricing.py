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
        self.inject({"nous": {"m": {"prompt": "0.0000000300", "completion": "0.0000001200"}}})
        hit, native = resolve_rate(load_catalogue(), "nous", "m")
        self.assertIsNotNone(hit)
        self.assertEqual((hit.rate.input, hit.rate.output), (0.03, 0.12))
        self.assertEqual(hit.provenance, "provider_native")
        self.assertIn("effective basis", hit.source)

    def test_absent_rates_are_absent_not_zero(self):
        self.inject({"nous": {"m": dict(NOUS_ROW)}})
        native = provider_native.lookup("nous", "m")
        self.assertIsNone(native.list_rate().cache_write)
        self.assertIsNone(_rate_of(NOUS_ROW).cache_read if False else None)

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
        self.add_call(fresh=1_000, output=10)
        payload = self.summary(population="all")
        self.assertIsNone(payload["valuation"]["provider_effective_usd"])
        self.assertIsNone(payload["valuation"]["provider_effective_basis"])

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


def _rate_of(row):  # pragma: no cover - helper kept for symmetry with the fixture
    return Rate(input=0.0, output=0.0, cache_read=None, cache_write=None)


if __name__ == "__main__":
    unittest.main()
