"""Read-only, timestamped-call analytics. Never derives periods from state totals."""
from __future__ import annotations

import json
import sqlite3
import time
from bisect import bisect_right
from collections import Counter
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from . import billing, store
from .aggregate import Acc, _event_result, _iso, _local_window, route_billing_status
from .db import default_db_path
from .pricing import (Catalogue, Rate, _effective_rate, load_catalogue,
                      reaches_unapplied_tier)

SCOPES = ("direct", "subagent", "auxiliary", "unattributed")

#: Pricing-gap reasons a user-configured custom rate can resolve (WP48).
#: The route identity exists but the catalogue lacks rates. Failed, missing
#: and unrecorded-provider usage can only be reviewed, never priced by the
#: user; unknown reasons stay on the review path.
PRICING_FIXABLE_MISS_REASONS = frozenset({
    "model_not_in_catalogue", "provider_not_in_catalogue",
    "price_evidence_missing", "missing_base_rate", "tier_rate_unavailable",
    "cache_rate_unavailable", "missing_cache_rate", "missing_cache_read_rate",
    "missing_cache_write_rate",
})
_MAX_ANCESTRY = 32

_TOTAL_FIELDS = (
    "tokens", "calls", "input_tokens", "output_tokens", "cache_read_tokens",
    "cache_write_tokens", "reasoning_tokens", "list_usd", "priced_tokens", "unpriced_tokens",
    "priced_calls", "unpriced_calls", "coverage", "billed_usd", "billed_complete", "billing_mix",
)


def _reported(flag: bool | None, value: int) -> bool:
    """A counter is proven when the flag says so, or when a null flag meets a positive value."""
    if flag is not None:
        return flag
    return value > 0


class _MetricProvenance:
    """Three-state provenance over the calls a metric was computed from."""

    __slots__ = ("total", "reported", "absent", "unrecorded")

    def __init__(self) -> None:
        self.total = 0
        self.reported = 0
        self.absent = 0
        self.unrecorded = 0

    def add(self, flag: bool | None, value: int) -> None:
        self.total += 1
        if _reported(flag, value):
            self.reported += 1
        elif flag is False:
            self.absent += 1
        else:
            self.unrecorded += 1

    def state(self, recorded_total: int) -> tuple[str, str | None]:
        if not self.total:
            return "unknown", "no_calls"
        if self.reported == self.total:
            return "reported", None
        if self.reported:
            return "partial", "mixed"
        if recorded_total > 0:
            # A positive total that the flags call absent is contradictory; keep
            # the evidence and refuse the clean state rather than pick a side.
            return "partial", "mixed"
        if self.absent and not self.unrecorded:
            return "unknown", "provider_does_not_report"
        if self.unrecorded and not self.absent:
            return "unknown", "not_recorded_by_build"
        return "unknown", "mixed"


def _indeterminate_reason(causes: dict[str, set[str]]) -> str:
    """Why a savings bound could not be established at all."""
    drivers = causes.get("indeterminate", set())
    if "tier" in drivers:
        return "context_tier_unknown"
    if drivers == {"read"}:
        return "read_rate_missing"
    return "write_rate_missing"


def _savings_basis(bounds: set[str], premiums: set[float],
                   causes: dict[str, set[str]], covered: int
                   ) -> tuple[str | None, str | None, float | None]:
    """Aggregate the card-signed bounds of the covered calls.

    The reason is read from *which counter* is unproven, not from whether the
    premiums happen to match: two calls with unknown writes on different
    discount cards produce no single premium but are still write-driven.
    """
    if not covered:
        return None, None, None
    if not bounds:
        return "exact", None, None
    if "indeterminate" in bounds:
        return "indeterminate", _indeterminate_reason(causes), None
    premium = next(iter(premiums)) if len(premiums) == 1 else None
    if bounds == {"upper"}:
        reason = "write_not_reported" if "write" in causes.get("upper", set()) \
            else "read_not_reported"
        return "upper_bound", reason, premium
    if bounds == {"lower"}:
        drivers = causes.get("lower", set())
        if drivers == {"write"}:
            reason = "write_not_reported"
        elif drivers == {"read"}:
            reason = "read_not_reported"
        else:
            reason = "read_and_write_not_reported"
        return "lower_bound", reason, premium
    return "indeterminate", "mixed_read_write_evidence", None


def _savings_directions(rate: Rate, *, read_known: bool, write_known: bool
                        ) -> list[tuple[str, str]]:
    """How unproven cache terms could move net savings, and which counter does it.

    Unknown writes add ``write_rate − input_rate`` per unreported write; unknown
    reads add ``input_rate − cache_read_rate`` per unreported read. A direction
    of ``lower`` means the figure can only rise once the counter is known.
    With several retention prices, every option must agree on the direction.
    """
    directions: list[tuple[str, str]] = []
    input_rate = rate.input
    if input_rate is None:
        return [("indeterminate", "write")]
    if not write_known:
        write_rates = [value for _, value in rate.cache_write_rates]
        if not write_rates:
            write_rates = [rate.cache_write] if rate.cache_write is not None else []
        if not write_rates:
            return [("indeterminate", "write")]
        premiums = [float(value) - float(input_rate) for value in write_rates]
        if any(premium > 0 for premium in premiums):
            directions.append(("upper", "write"))
        if any(premium < 0 for premium in premiums):
            directions.append(("lower", "write"))
    if not read_known:
        read_rate = rate.cache_read
        if read_rate is None:
            return [("indeterminate", "read")]
        discount = float(input_rate) - float(read_rate)
        if discount < 0:
            directions.append(("upper", "read"))
        elif discount > 0:
            directions.append(("lower", "read"))
    return directions


def _call_economics(row: dict[str, Any], book: Catalogue, *,
                    allow_third_party: bool = False,
                    allow_approximate: bool = False
                    ) -> tuple[dict[str, Any] | None, str]:
    """Strict comparison on the same complete, known-cache call population.

    Returns ``(economics, "")`` where ``economics`` carries the counterfactual,
    the set of directions in which unproven read/write terms could move net
    savings (``savings``), and the signed write premium when writes are
    unproven on a priced card. Cost completeness is a separate per-call fact
    (``_cost_bound``), because calls excluded from this comparison still
    contribute to the API-equivalent total.
    """
    if row["_failure"]:
        return None, "call_failed"
    if row["_missing"]:
        return None, "usage_missing"
    if row.get("_provider") in (None, "", "(unattributed)"):
        return None, "provider_unidentified"
    if row.get("_model") in (None, "", "(unknown)"):
        return None, "model_unidentified"
    read_known = _reported(row.get("_cache_read_reported"), row["_cache_read"])
    write_known = _reported(row.get("_cache_write_reported"), row["_cache_write"])
    if not read_known and not write_known:
        return None, "cache_provenance_unknown"
    lookup = book.lookup(row["provider"], row["model"], allow_third_party=allow_third_party,
                         allow_approximate=allow_approximate,
                         at=row.get("last_seen"))
    if lookup is None:
        if row.get("pricing_miss") == "provider_not_in_catalogue":
            return None, "provider_price_catalogue_missing"
        return None, "price_evidence_missing"
    prompt = row["_input"] + row["_cache_read"] + row["_cache_write"]
    rate, _ = _effective_rate(lookup.rate, prompt)
    if rate.input is None or rate.output is None:
        return None, "tier_rate_unavailable" if lookup.rate.tiers else "missing_base_rate"
    if row["_cache_read"] and rate.cache_read is None:
        return None, "missing_cache_read_rate"
    if row["_cache_write"] and rate.cache_write is None:
        # The write term cannot be priced, so this call stays out of the net
        # comparison and out of coverage — but its read discount does not
        # depend on the write price. Keep that one term (the published
        # definition covers calls with a proven read counter and a published
        # read price) and let the caller record the net gap as before.
        #
        # An unproven read counter contributes no value but still carries the
        # direction its own card implies, exactly as the fully priced path
        # below does. Without it a batch holding one proven-read call and one
        # unreported-read call would publish their sum as ``exact`` when the
        # unreported reads could only add to it.
        benefit: float | None = None
        read_direction: str | None = None
        if read_known:
            # A positive read with no published price was refused above, so a
            # missing read price here means the proven counter is zero.
            benefit = (0.0 if rate.cache_read is None else
                       row["_cache_read"]
                       * (float(rate.input) - float(rate.cache_read)) / 1_000_000)
        elif rate.cache_read is None:
            read_direction = "unknown"
        elif float(rate.cache_read) == float(rate.input):
            benefit = 0.0  # an unrecorded read priced at input adds nothing
        else:
            read_direction = ("lower" if float(rate.cache_read) < float(rate.input)
                              else "upper")
        return {"uncached": None, "cached": None,
                "savings_low": 0.0, "savings_high": 0.0,
                "retention_range": False, "savings": [], "premium": None,
                "read_benefit": benefit,
                "read_benefit_direction": read_direction}, "missing_cache_write_rate"
    uncached = (prompt * rate.input + row["_output"] * rate.output) / 1_000_000
    cached = (row["_input"] * rate.input + row["_output"] * rate.output
              + row["_cache_read"] * (rate.cache_read or 0)
              + row["_cache_write"] * (rate.cache_write or 0)) / 1_000_000
    base_savings = uncached - cached
    low = high = base_savings
    retention_range = False
    write_options = sorted({float(value) for _, value in rate.cache_write_rates})
    scalar_write = float(rate.cache_write) if rate.cache_write is not None else None
    # Positive, measured writes whose retention is not recorded span every
    # published retention price. Unknown write counts never get a finite range:
    # there is no evidence to bound how many tokens were written.
    if write_known and row["_cache_write"] > 0 and len(write_options) > 1 \
            and scalar_write is not None:
        delta_low = row["_cache_write"] * (write_options[0] - scalar_write) / 1_000_000
        delta_high = row["_cache_write"] * (write_options[-1] - scalar_write) / 1_000_000
        high = base_savings - delta_low   # cheapest retention saves the most
        low = base_savings - delta_high
        retention_range = True
    premium = None
    if not write_known:
        options = write_options or ([scalar_write] if scalar_write is not None else [])
        premiums = {round(value - float(rate.input), 6) for value in options}
        premium = next(iter(premiums)) if len(premiums) == 1 else None
    directions = _savings_directions(rate, read_known=read_known,
                                     write_known=write_known)
    if not (read_known and write_known) and reaches_unapplied_tier(lookup.rate, prompt):
        # The unrecorded counter can add tokens, and entering a higher band
        # reprices the whole request, so a direction taken at the recorded band
        # is not a defensible bound on the true value. Use the catalogue rate:
        # ``rate`` has its tiers stripped once a band is selected.
        directions = [("indeterminate", "tier")]
    # The measured read benefit: the discount on the tokens the provider proved
    # it served from cache. It is a separate question from net savings — it
    # never contains the write term — so it survives a missing write counter or
    # an unpublished write price, which is exactly where net savings cannot be
    # established. A call whose read counter is unproven contributes nothing
    # and carries the direction its own card implies.
    read_benefit: float | None = None
    read_direction: str | None = None
    if read_known:
        if rate.cache_read is None:
            # Positive reads with no published price are refused above; a call
            # with no reads contributes zero whatever the price would be.
            read_benefit = 0.0 if not row["_cache_read"] else None
            if read_benefit is None:
                read_direction = "unknown"
        else:
            read_benefit = (row["_cache_read"]
                            * (float(rate.input) - float(rate.cache_read)) / 1_000_000)
    elif rate.cache_read is None:
        read_direction = "unknown"
    elif float(rate.cache_read) == float(rate.input):
        read_benefit = 0.0  # an unrecorded read priced at input adds nothing
    else:
        read_direction = "lower" if float(rate.cache_read) < float(rate.input) else "upper"
    return {"uncached": uncached, "cached": cached,
            "savings_low": low, "savings_high": high,
            "retention_range": retention_range,
            "savings": directions,
            "premium": premium,
            "read_benefit": read_benefit,
            "read_benefit_direction": read_direction}, ""


class _AnalyticsAcc:
    def __init__(self):
        self.accounting = Acc()
        self.cache_known_calls = 0
        self.fallback_calls = 0
        self.known_prompt_tokens = 0
        self.total_prompt_tokens = 0
        self.known_read_tokens = 0
        self.known_write_tokens = 0
        self.uncached_usd = 0.0
        self.cached_usd = 0.0
        self.read_benefit_usd = 0.0
        self.read_benefit_calls = 0
        self.read_benefit_tokens = 0
        self.read_benefit_directions: set[str] = set()
        self.savings_low_usd = 0.0
        self.savings_high_usd = 0.0
        self.retention_calls = 0
        self.api_high_usd = 0.0
        self.priced_calls = 0
        self.covered_tokens = 0
        self.covered_calls = 0
        self.tiered_calls = 0
        self.excluded_tokens = 0
        self.read_prov = _MetricProvenance()
        self.write_prov = _MetricProvenance()
        self.bounds: set[str] = set()
        self.bound_causes: dict[str, set[str]] = {}
        self.cost_bounds: set[str] = set()
        self.cost_causes: set[str] = set()
        self.premiums: set[float] = set()
        self.economics_gaps: Counter[str] = Counter()
        self.pricing_gaps: Counter[str] = Counter()

    def add(self, row: dict[str, Any]) -> None:
        pricing = row.get("pricing") or {}
        if row["list_usd"] is not None and (pricing.get("cache_read_defaulted") or pricing.get("cache_write_defaulted")):
            self.fallback_calls += 1
        prompt = row["_input"] + row["_cache_read"] + row["_cache_write"]
        if row.get("_tier_selected"):
            self.tiered_calls += 1
        # Provenance covers every recorded call, not only the priced ones: a
        # call excluded from economics still proves (or fails to prove) that its
        # cache fields were reported.
        self.read_prov.add(row.get("_cache_read_reported"), row["_cache_read"])
        self.write_prov.add(row.get("_cache_write_reported"), row["_cache_write"])
        self.known_write_tokens += row["_cache_write"]
        economics = row["_economics"]
        if economics is None or economics.get("uncached") is None:
            # A partially priced call: the net comparison is impossible (the
            # gap below records why), but a proven read keeps its discount.
            if economics is not None:
                benefit = economics.get("read_benefit")
                if benefit is None:
                    self.read_benefit_directions.add(
                        economics.get("read_benefit_direction") or "unknown")
                else:
                    self.read_benefit_usd += benefit
                    self.read_benefit_calls += 1
                    self.read_benefit_tokens += row["_cache_read"]
            self.economics_gaps[row["_economics_gap"]] += 1
            self.excluded_tokens += prompt
        else:
            self.uncached_usd += economics["uncached"]
            self.cached_usd += economics["cached"]
            self.savings_low_usd += economics["savings_low"]
            self.savings_high_usd += economics["savings_high"]
            if economics["retention_range"]:
                self.retention_calls += 1
            self.covered_tokens += row["_tokens"]
            self.covered_calls += 1
            for direction, cause in economics["savings"]:
                self.bounds.add(direction)
                self.bound_causes.setdefault(direction, set()).add(cause)
            if economics["premium"] is not None:
                self.premiums.add(economics["premium"])
            benefit = economics.get("read_benefit")
            if benefit is None:
                self.read_benefit_directions.add(
                    economics.get("read_benefit_direction") or "unknown")
            else:
                self.read_benefit_usd += benefit
                self.read_benefit_calls += 1
                self.read_benefit_tokens += row["_cache_read"]
        # Cost completeness covers every priced call, including those excluded
        # from the savings comparison above.
        for bound in row.get("_cost_bounds") or ():
            if bound != "exact":
                self.cost_bounds.add(bound)
        self.cost_causes.update(row.get("_cost_causes") or ())
        list_usd = row.get("list_usd")
        if list_usd is not None:
            self.priced_calls += 1
        high = row.get("_cost_high")
        if high is None:
            high = row.get("effective_usd")
        if high is not None:
            self.api_high_usd += float(high)
        elif list_usd is not None:
            self.api_high_usd += float(list_usd)
        if row.get("list_usd") is None:
            self.pricing_gaps[row.get("pricing_miss") or "price_evidence_missing"] += 1
        self.total_prompt_tokens += prompt
        if not row["_failure"] and not row["_missing"] and _reported(
                row.get("_cache_read_reported"), row["_cache_read"]):
            self.cache_known_calls += 1
            self.known_prompt_tokens += prompt
            self.known_read_tokens += row["_cache_read"]
        value_usd = (row.get("_cost_low") if row.get("_retention_range")
                     else row.get("effective_usd"))
        self.accounting.add(row, value_usd if value_usd is not None else row["list_usd"],
                            row["list_usd_upper"],
                            row["billed_usd"], row["billed_kind"],
                            row["basis_usd"], row["basis_kind"])

    def as_dict(self) -> dict[str, Any]:
        base = self.accounting.as_dict()
        read_state, read_reason = self.read_prov.state(self.known_read_tokens)
        write_state, write_reason = self.write_prov.state(self.known_write_tokens)
        basis, bound_reason, premium = _savings_basis(
            self.bounds, self.premiums, self.bound_causes, self.covered_calls)
        low = round(self.savings_low_usd, 6) if self.covered_calls else None
        high = round(self.savings_high_usd, 6) if self.covered_calls else None
        savings_usd = low
        savings_usd_high = None
        if not self.covered_calls:
            savings_basis, savings_reason = None, None
        elif self.retention_calls:
            # A retention range is only two-sided when every counter that
            # affects savings is proven. An unproven counter widens one side,
            # so that endpoint must not be published as a bound.
            if "indeterminate" in self.bounds:
                savings_basis, savings_reason, savings_usd = (
                    "indeterminate", _indeterminate_reason(self.bound_causes), None)
            elif {"upper", "lower"} <= self.bounds:
                savings_basis, savings_reason, savings_usd = (
                    "indeterminate", "mixed_read_write_evidence", None)
            elif "upper" in self.bounds:
                savings_basis, savings_reason, savings_usd = (
                    "upper_bound", "retention_and_counter_uncertainty", high)
            elif "lower" in self.bounds:
                savings_basis, savings_reason, savings_usd = (
                    "lower_bound", "retention_and_counter_uncertainty", low)
            else:
                savings_basis, savings_reason = "range", "retention_unknown"
                savings_usd_high = high
        else:
            savings_basis, savings_reason = basis, bound_reason
            # An indeterminate basis is not a bound: the true value can move in
            # either direction, so the recorded-counter arithmetic must not be
            # published as a figure. Withhold it for every indeterminate cause
            # (reachable context tier, missing read price, missing write price,
            # mixed directions), matching what a reader is told by the basis.
            if savings_basis is None or savings_basis == "indeterminate":
                savings_usd = None
        if base["unpriced_tokens"]:
            api_basis, api_reason, api_high = "incomplete", "unpriced_tokens", None
        elif "incomplete" in self.cost_bounds:
            api_basis = "incomplete"
            if "tier" in self.cost_causes:
                api_reason = "context_tier_unknown"
            else:
                api_reason = ("write_rate_missing" if "write" in self.cost_causes
                              else "read_rate_missing")
            api_high = None
        elif "lower" in self.cost_bounds:
            api_basis = "lower_bound"
            api_reason = ("read_and_write_not_reported"
                          if {"read", "write"} <= self.cost_causes
                          else "read_not_reported" if "read" in self.cost_causes
                          else "write_not_reported")
            api_high = None
        elif "range" in self.cost_bounds:
            api_basis, api_reason = "range", "retention_unknown"
            api_high = round(self.api_high_usd, 6)
        else:
            api_basis, api_reason, api_high = "exact", None, None
        hit_rate = (round(self.known_read_tokens / self.known_prompt_tokens, 6)
                    if self.known_prompt_tokens else None)
        every_call_proven = (read_state == "reported"
                             and self.cache_known_calls == base["calls"])
        # A measured subtotal is not a blank: the benefit keeps the value of the
        # calls whose read counter is proven, and the basis says whether
        # anything is missing from it. An unproven read counter only adds value
        # when the card discounts reads, so the direction follows the card.
        if not self.covered_calls and not self.read_benefit_calls \
                and not self.read_benefit_directions:
            read_benefit_basis, read_benefit_usd = None, None
        elif not self.read_benefit_directions:
            read_benefit_basis, read_benefit_usd = "exact", round(self.read_benefit_usd, 6)
        elif self.read_benefit_directions == {"lower"}:
            read_benefit_basis, read_benefit_usd = "lower_bound", round(self.read_benefit_usd, 6)
        elif self.read_benefit_directions == {"upper"}:
            read_benefit_basis, read_benefit_usd = "upper_bound", round(self.read_benefit_usd, 6)
        else:
            # A missing read price or conflicting directions leave the true
            # total unknowable, so the figure is withheld (contract: an
            # indeterminate basis is not a bound).
            read_benefit_basis, read_benefit_usd = "indeterminate", None
        return {**{key: base[key] for key in _TOTAL_FIELDS},
                "pricing_provenance": base.get("pricing_provenance", "unpriced"),
                "pricing_mix": base.get("pricing_mix", {}),
                "pricing_gaps": dict(self.pricing_gaps),
                "fallback_calls": self.fallback_calls,
                "cache_hit_rate": hit_rate,
                "cache_hit_rate_all": hit_rate if every_call_proven else None,
                "cache_hit_rate_basis": "all_calls" if every_call_proven else "reported_calls",
                "cache_known_calls": self.cache_known_calls,
                "cache_unknown_calls": base["calls"] - self.cache_known_calls,
                "cache_coverage": round(self.cache_known_calls / base["calls"], 6) if base["calls"] else 0.0,
                "cache_prompt_coverage": (round(self.known_prompt_tokens / self.total_prompt_tokens, 6)
                                          if self.total_prompt_tokens else None),
                "cache_covered_prompt_tokens": self.known_prompt_tokens,
                "cache_total_prompt_tokens": self.total_prompt_tokens,
                "cache_read_state": read_state,
                "cache_read_state_reason": read_reason,
                "cache_write_state": write_state,
                "cache_write_state_reason": write_reason,
                "tiered_calls": self.tiered_calls,
                "economics": {
                    "uncached_usd": round(self.uncached_usd, 6) if self.covered_calls else None,
                    "cached_usd": round(self.cached_usd, 6) if self.covered_calls else None,
                    # The read term on its own. It answers a different question
                    # from `savings_usd` and stays measurable where a net saving
                    # cannot be established.
                    "read_benefit_usd": read_benefit_usd,
                    "read_benefit_basis": read_benefit_basis,
                    "read_benefit_calls": self.read_benefit_calls,
                    "read_benefit_tokens": self.read_benefit_tokens,
                    "savings_usd": savings_usd,
                    "savings_usd_high": savings_usd_high,
                    "savings_basis": savings_basis,
                    "savings_bound_reason": savings_reason,
                    "retention_unknown_calls": self.retention_calls,
                    "write_premium_usd_per_mtok": premium,
                    "api_equivalent_basis": api_basis,
                    "api_equivalent_bound_reason": api_reason,
                    "api_equivalent_usd_high": api_high,
                    "covered_tokens": self.covered_tokens,
                    "coverage": round(self.covered_tokens / base["tokens"], 6) if base["tokens"] else 0.0,
                    "covered_calls": self.covered_calls,
                    "excluded_calls": base["calls"] - self.covered_calls,
                    "excluded_tokens": self.excluded_tokens,
                    "gap_reasons": dict(self.economics_gaps),
                }}


def _session_graph(state_db_path: Path | str | None) -> dict[str, Any]:
    """Read-only parent/child map from Hermes' own sessions table.

    Child sessions are reliable here: ``parent_session_id`` is set, and the
    ``_delegate_from`` creation marker covers older children that inherit the
    parent's source. No prompt content is read.
    """
    path = Path(state_db_path) if state_db_path else default_db_path()
    graph: dict[str, Any] = {"child_of": {}, "known": set(), "cycles": 0}
    if not path.exists():
        return graph
    try:
        conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=5)
        try:
            rows = conn.execute(
                "SELECT id, parent_session_id, model_config FROM sessions"
            ).fetchall()
        finally:
            conn.close()
    except sqlite3.Error:
        return graph

    for session_id, parent_id, model_config in rows:
        sid = str(session_id or "")
        if not sid:
            continue
        graph["known"].add(sid)
        parent = str(parent_id or "")
        if not parent and model_config:
            try:
                marker = json.loads(model_config).get("_delegate_from") if isinstance(model_config, str) else None
            except (TypeError, ValueError):
                marker = None
            parent = str(marker or "")
        if parent and parent != sid:
            graph["child_of"][sid] = parent
    graph["cycles"] = _cycle_count(graph["child_of"])
    return graph


def _cycle_count(child_of: dict[str, str]) -> int:
    seen_bad: set[str] = set()
    total = 0
    for start in child_of:
        trail: list[str] = []
        node = start
        while node in child_of and len(trail) < _MAX_ANCESTRY:
            if node in trail:
                break
            trail.append(node)
            node = child_of[node]
        else:
            continue
        if node in trail and node not in seen_bad:
            seen_bad.add(node)
            total += 1
    return total


def _root_of(session_id: str, child_of: dict[str, str]) -> str:
    """Topmost known ancestor; a cycle stops at the first repeat."""
    node = session_id
    seen: set[str] = set()
    for _ in range(_MAX_ANCESTRY):
        parent = child_of.get(node)
        if not parent or parent in seen:
            break
        seen.add(node)
        node = parent
    return node


def _scope_of(session_id: str, task: str, child_of: dict[str, str], known: set[str]) -> str:
    """Delegation scope. A child's auxiliary work still counts as delegated inference."""
    if session_id and session_id in child_of:
        return "subagent"
    if task and task != "main":
        return "auxiliary"
    if session_id and session_id in known:
        return "direct"
    return "unattributed"


def _custom_fixable(rows: list[dict[str, Any]], profiles: dict[str, Any]) -> tuple[int, int]:
    """Unpriced tokens/calls a custom rate could still price (WP48).

    A row counts when the catalogue cannot price it for a fixable reason
    AND no custom rule already matches its route. Saving the matching
    custom rate clears exactly this remainder, so a fix action gated on
    it can never nag after the fix.
    """
    tokens = calls = 0
    for row in rows:
        if row.get("list_usd") is not None:
            continue
        miss = row.get("pricing_miss") or "price_evidence_missing"
        if miss not in PRICING_FIXABLE_MISS_REASONS:
            continue
        if billing.custom_rates_for(profiles, row.get("provider", ""),
                                    row.get("model", "")) is not None:
            continue
        tokens += int(row.get("_tokens") or 0)
        calls += int(row.get("_calls") or 0)
    return tokens, calls


def build_analytics_report(
    event_db_path: Path | str | None = None, *,
    state_db_path: Path | str | None = None,
    days: int = 30, now: float | None = None, catalogue: Catalogue | None = None,
    model: str | None = None, provider: str | None = None,
    surface: str | None = None, task: str | None = None,
    parent: str | None = None, scope: str | None = None,
    pricing_mode: str = "strict", presentation: str = "both",
    profiles_path: Path | str | None = None,
) -> dict[str, Any]:
    """Aggregate only recorded calls in the local-calendar, half-open window."""
    now = time.time() if now is None else now
    days = max(1, min(int(days), 365))
    since, until, zone = _local_window(days, now)
    # Resolve each local midnight separately so DST offsets remain correct.
    local_start = datetime.fromtimestamp(now).replace(hour=0, minute=0, second=0, microsecond=0)
    local_start -= timedelta(days=days - 1)
    granularity = "hour" if days == 1 else "day"
    starts: list[float] = []
    if days == 1:
        cursor = since
        while cursor < until:
            starts.append(cursor)
            cursor += 3600
    else:
        day_cursor = local_start
        while day_cursor.timestamp() < until:
            starts.append(day_cursor.timestamp())
            day_cursor += timedelta(days=1)
    bucket_accs = {ts: _AnalyticsAcc() for ts in starts}

    prev_since = since - (until - since)
    conn = store.connect_reader(event_db_path)
    try:
        rows = store.query_calls(conn, since=since, until=until) if conn is not None else []
        prev_rows = store.query_calls(conn, since=prev_since, until=since) if conn is not None else []
        recording = store.recording_info(conn)
    finally:
        if conn is not None:
            conn.close()
    mode = pricing_mode if pricing_mode in ("strict", "third_party", "approximate") else "strict"
    allow_third_party = mode in ("third_party", "approximate")
    allow_approximate = mode == "approximate"
    book = catalogue if catalogue is not None else load_catalogue()
    statuses = route_billing_status(state_db_path)
    total_acc = _AnalyticsAcc()
    models: dict[tuple[str, str], _AnalyticsAcc] = {}
    routes: dict[str, _AnalyticsAcc] = {}
    option_models: set[tuple[str, str]] = set()
    surfaces: set[str] = set()
    tasks: set[str] = set()
    filters = {"model": model, "provider": provider, "surface": surface, "task": task}
    graph = _session_graph(state_db_path)
    child_of: dict[str, str] = graph["child_of"]
    known: set[str] = graph["known"]
    scope_accs: dict[str, _AnalyticsAcc] = {}
    results_kept: list[dict] = []
    operations: Counter = Counter()
    unattributed_calls = 0
    for raw in rows:
        row = _event_result(raw, book, "list", statuses,
                            allow_third_party=allow_third_party,
                            allow_approximate=allow_approximate, at=raw.get("ts"))
        option_models.add((row["model"], row["provider"]))
        surfaces.add(row["surface"])
        tasks.add(row["task"])
        session_id = row["_session_id"]
        row_scope = _scope_of(session_id, row["_task"], child_of, known)
        row["_scope"] = row_scope
        row["_root"] = _root_of(session_id, child_of) if session_id else ""
        if any(value is not None and row[key] != value for key, value in filters.items()):
            continue
        if parent and row["_root"] != parent:
            continue
        if scope and row_scope != scope:
            continue
        row["_economics"], row["_economics_gap"] = _call_economics(
            row, book, allow_third_party=allow_third_party, allow_approximate=allow_approximate)
        results_kept.append(row)
        total_acc.add(row)
        scope_accs.setdefault(row_scope, _AnalyticsAcc()).add(row)
        if row_scope == "unattributed":
            unattributed_calls += 1
        if row_scope == "subagent" and row["_root"]:
            operations[row["_root"]] += 1
        models.setdefault((row["model"], row["provider"]), _AnalyticsAcc()).add(row)
        routes.setdefault(row["provider"], _AnalyticsAcc()).add(row)
        bucket_ts = starts[bisect_right(starts, raw["ts"]) - 1]
        bucket_accs[bucket_ts].add(row)
    totals = total_acc.as_dict()
    # Previous equal-length window, same filters: only totals, for deltas.
    # It is a comparison baseline, never added to the current window.
    prev_acc = _AnalyticsAcc()
    for raw in prev_rows:
        prow = _event_result(raw, book, "list", statuses,
                             allow_third_party=allow_third_party,
                             allow_approximate=allow_approximate, at=raw.get("ts"))
        prow_scope = _scope_of(prow["_session_id"], prow["_task"], child_of, known)
        prow["_scope"] = prow_scope
        prow["_root"] = _root_of(prow["_session_id"], child_of) if prow["_session_id"] else ""
        if any(value is not None and prow[key] != value for key, value in filters.items()):
            continue
        if parent and prow["_root"] != parent:
            continue
        if scope and prow_scope != scope:
            continue
        prow["_economics"], prow["_economics_gap"] = _call_economics(
            prow, book, allow_third_party=allow_third_party, allow_approximate=allow_approximate)
        prev_acc.add(prow)
    prev_totals = prev_acc.as_dict()

    def _delta(key: str) -> float | None:
        before, now_value = prev_totals.get(key), totals.get(key)
        if not isinstance(before, (int, float)) or not before or not isinstance(now_value, (int, float)):
            return None
        return round((now_value - before) / before, 6)

    # A comparison is only fair when the whole previous window was observed:
    # it must start inside retention and after recording began (baseline_at
    # marks observation start; an old store without one is judged on
    # retention alone rather than hiding the comparison).
    observed_since = max(now - store.RETENTION_DAYS * 86_400, recording.get("baseline_at") or 0)
    previous_observed = prev_since >= observed_since
    comparable = bool(prev_totals.get("calls")) and previous_observed
    previous_reason = (None if comparable else
                       "no_previous_calls" if not prev_totals.get("calls") and previous_observed
                       else "insufficient_history")
    deltas = {"list_usd": _delta("list_usd"), "tokens": _delta("tokens"),
              "calls": _delta("calls")} if comparable else {"list_usd": None, "tokens": None, "calls": None}
    previous = {
        "window": {"since": _iso(prev_since), "until": _iso(since), "days": days},
        "totals": prev_totals,
        "deltas": deltas,
        "comparable": comparable,
        "reason": previous_reason,
    }
    coverage: dict[str, int] = {}
    for row in results_kept:
        key = (row.get("pricing_provenance") or "unpriced") if row.get("list_usd") is not None else "unpriced"
        coverage[key] = coverage.get(key, 0) + (row.get("_tokens") or 0)
    covered = sum(coverage.values()) or 0
    official = coverage.get("official_verified", 0)
    route = coverage.get("models_dev_route", 0)
    estimated = coverage.get("third_party", 0) + coverage.get("approximate", 0)
    unpriced = coverage.get("unpriced", 0)
    pricing_coverage = {
        "tokens_by_provenance": coverage,
        "official_verified_tokens": official,
        "models_dev_route_tokens": route,
        "estimated_tokens": estimated,
        "unpriced_tokens": unpriced,
        "priced_calls": totals.get("priced_calls", 0),
        "unpriced_calls": totals.get("unpriced_calls", 0),
        "call_coverage": (round(totals["priced_calls"] / totals["calls"], 6)
                          if totals.get("calls") else None),
        "official_ratio": round(official / covered, 6) if covered else 0.0,
        "models_dev_ratio": round(route / covered, 6) if covered else 0.0,
        "estimated_ratio": round(estimated / covered, 6) if covered else 0.0,
        "unpriced_ratio": round(unpriced / covered, 6) if covered else 0.0,
        "coverage": round((covered - unpriced) / covered, 6) if covered else 0.0,
        "mode": mode,
        "official_ratio_scope": "token-weighted across observed calls in this window, not coverage of the provider catalogue",
        "note": ("models.dev exact provider/model/variant match is the primary published "
                 "API-equivalent basis. official_verified marks rates additionally checked "
                 "against the provider's own documentation; estimated covers the opt-in "
                 "third-party and cross-provider tiers. None of these is an invoice."),
    }
    billing_profiles = billing.load_profiles(profiles_path)
    billing_report = billing.classify(results_kept, billing_profiles, presentation)
    fixable_tokens, fixable_calls = _custom_fixable(results_kept, billing_profiles)
    totals["custom_fixable_tokens"] = fixable_tokens
    totals["custom_fixable_calls"] = fixable_calls
    buckets = [{"ts": _iso(ts), "ts_local": datetime.fromtimestamp(ts).astimezone().isoformat(),
                **acc.as_dict()} for ts, acc in bucket_accs.items()]
    by_scope = [{"scope": name, **scope_accs[name].as_dict()}
                for name in SCOPES if name in scope_accs]
    return {
        "ok": True,
        "window": {"since": _iso(since), "until": _iso(until), "days": days,
                   "since_local": datetime.fromtimestamp(since).astimezone().isoformat(),
                   "until_local": datetime.fromtimestamp(until).astimezone().isoformat(),
                   "timezone": zone, "kind": "timestamped_calls"},
        "filters": {**filters, "parent": parent, "scope": scope},
        "attribution": {
            "method": "state.db sessions.parent_session_id (read-only), _delegate_from fallback",
            "child_sessions": len(child_of),
            "known_sessions": len(known),
            "unattributed_calls": unattributed_calls,
            "cycles": graph["cycles"],
            "operation_root": parent or None,
            "complete": unattributed_calls == 0 and graph["cycles"] == 0,
        },
        "by_scope": by_scope,
        "pricing_coverage": pricing_coverage,
        "valuation": {
            "settled_calls": sum(1 for r in results_kept if r.get("settled_usd") is not None),
            "estimated_calls": sum(1 for r in results_kept if r.get("settled_usd") is None),
            "note": ("settled_usd is the valuation captured with the call; list_usd is a "
                     "recalculated API-equivalent for the same tokens and may differ after a "
                     "catalogue change. They are never treated as the same number."),
        },
        "billing": billing_report,
        "pricing_source": {
            "source": book.source, "version": book.version, "as_of": book.as_of,
            "official_checks": len(getattr(book, "official", {}) or {}),
            "age_seconds": None,
            "stale": bool(book.confidence == "bundled"),
        },
        "options": {
            "models": [{"model": name, "provider": route} for name, route in sorted(option_models)],
            "providers": sorted({route for _, route in option_models}),
            "surfaces": sorted(surfaces), "tasks": sorted(tasks),
            "scopes": list(SCOPES),
            "operations": [{"parent": root, "subagent_calls": count}
                           for root, count in operations.most_common(25)],
        },
        "totals": totals,
        "previous": previous,
        "by_model": [{"model": name, "provider": route, **acc.as_dict()}
                     for (name, route), acc in sorted(models.items())],
        "by_route": [{"provider": route, **acc.as_dict()} for route, acc in sorted(routes.items())],
        "trend": {"granularity": granularity, "buckets": buckets},
        "economics": totals["economics"],
        "recording": {"since": _iso(recording["since"]), "last": _iso(recording["last"]),
                      "calls": recording["calls"]},
        "notes": [
            "Only timestamped calls in [since, until) are counted; no historical usage is inferred. Buckets follow local calendar boundaries and carry explicit UTC timestamps, including across DST.",
            "Options describe the unfiltered selected window; recording describes all retained calls, independent of filters. The collector retains calls for 180 days, so longer windows may be incomplete.",
            "Prices use the current catalogue, not historical invoices. Economics applies whole-context tiers per call, including tiers that decrease rates; list_usd preserves existing accounting tier/fallback semantics.",
            "Calls with provider errors or missing usage keep their tokens but are unpriced.",
            "Cache provenance is three-state: a reported flag wins, and only a null flag falls back to a positive value. Calls with no proven cache field are excluded from economics; the prompt-only cache-hit denominator counts calls with a proven read; cache_coverage is that count / all calls; cache_prompt_coverage uses prompt tokens. A null write with a zero value is unreported, never a measured zero.",
            "List USD preserves the existing accounting fallback for absent cache rates; strict economics excludes calls requiring those missing prices instead of treating the fallback as savings.",
            "Economics compares hypothetical uncached and cached list costs for the same covered calls, including output and cache-write premiums; savings may be negative. Coverage is covered tokens / all selected tokens. The savings basis follows the card's signed write premium, so an unreported write counter can make the value an upper bound, a lower bound, exact, or indeterminate. An unreported counter that could still enter a higher context tier makes the bound indeterminate, because crossing the threshold reprices the whole request.",
            "Billing mix is the latest route/model classification, not a per-call invoice. Only included routes have known $0 marginal billing.",
            "Previous totals cover the equal-length window immediately before this one under the same filters, for comparison only; deltas are omitted when that window has no recorded calls and it may predate recording.",
            *[f"Economics excluded {count} calls: {reason}."
              for reason, count in sorted(total_acc.economics_gaps.items())],
        ],
        # Machine-readable codes aligned by index with "notes". The English
        # strings above stay byte-identical for API compatibility; localised
        # clients render from these codes and fall back to "notes".
        "note_codes": [
            {"code": "ov_note_window", "params": {}},
            {"code": "ov_note_options", "params": {}},
            {"code": "ov_note_prices", "params": {}},
            {"code": "ov_note_errors", "params": {}},
            {"code": "ov_note_cache", "params": {}},
            {"code": "ov_note_fallback", "params": {}},
            {"code": "ov_note_economics", "params": {}},
            {"code": "ov_note_billing", "params": {}},
            {"code": "ov_note_previous", "params": {}},
            *[{"code": "ov_note_gap", "params": {"count": count, "reason": reason}}
              for reason, count in sorted(total_acc.economics_gaps.items())],
        ],
    }


def build_session_summary(
    event_db_path: Path | str | None = None, *,
    session_id: str,
    population: str = "all",
    provider: str | None = None,
    model: str | None = None,
    state_db_path: Path | str | None = None,
    catalogue: Catalogue | None = None,
    pricing_mode: str = "strict",
    now: float | None = None,
) -> dict[str, Any]:
    """One session's canonical figures, with an explicit population scope.

    ``population`` is ``main``, ``auxiliary`` or ``all``. A scope narrower than
    ``all`` is only served when every row carries a ``call_class``: an older
    store cannot distinguish a main-loop call from background work, so the
    request is refused rather than widened. No split is ever inferred from
    ``state.db``.
    """
    now = time.time() if now is None else now
    if population not in ("main", "auxiliary", "all"):
        raise ValueError("population must be main, auxiliary or all")
    conn = store.connect_reader(event_db_path)
    try:
        rows = [] if conn is None else [dict(row) for row in conn.execute(
            "SELECT * FROM calls WHERE session_id = ? ORDER BY ts ASC",
            (str(session_id),)).fetchall()]
    except sqlite3.Error as exc:
        raise store.LedgerUnavailable(f"could not query session calls: {exc}") from exc
    finally:
        if conn is not None:
            conn.close()
    if provider:
        rows = [r for r in rows if str(r.get("provider") or "") == provider]
    if model:
        rows = [r for r in rows if str(r.get("model") or "") == model]

    classes = [str(r.get("call_class") or "").strip() for r in rows]
    separable = all(c in ("main", "auxiliary") for c in classes)
    counts = {
        "main_calls": sum(1 for c in classes if c == "main") if separable else None,
        "auxiliary_calls": sum(1 for c in classes if c == "auxiliary") if separable else None,
        "unclassified_calls": (0 if separable else
                               sum(1 for c in classes if c not in ("main", "auxiliary"))),
    }
    refused = population != "all" and not separable

    mode = pricing_mode if pricing_mode in ("strict", "third_party", "approximate") else "strict"
    book = catalogue if catalogue is not None else load_catalogue()
    statuses = route_billing_status(state_db_path)

    def block(selected: list[dict[str, Any]]) -> dict[str, Any]:
        acc = _AnalyticsAcc()
        for raw in selected:
            row = _event_result(raw, book, "list", statuses,
                                allow_third_party=mode in ("third_party", "approximate"),
                                allow_approximate=mode == "approximate",
                                at=raw.get("ts"))
            row["_economics"], row["_economics_gap"] = _call_economics(
                row, book, allow_third_party=mode in ("third_party", "approximate"),
                allow_approximate=mode == "approximate")
            acc.add(row)
        totals_raw = acc.as_dict()
        economics = totals_raw["economics"]
        ints = lambda key: sum(int(r.get(key) or 0) for r in selected)
        def _row_prompt(r: dict[str, Any]) -> int:
            recorded = int(r.get("prompt_tokens") or 0)
            if recorded:
                return recorded
            return (int(r.get("input_tokens") or 0) + int(r.get("cache_read_tokens") or 0)
                    + int(r.get("cache_write_tokens") or 0))
        prompt_total = sum(_row_prompt(r) for r in selected)
        unpriced_tokens = totals_raw["unpriced_tokens"]
        thresholds: set[int] = set()
        for route, name in {(str(r.get("provider") or ""), str(r.get("model") or "")) for r in selected}:
            hit = book.lookup(route, name, allow_third_party=mode in ("third_party", "approximate"),
                              allow_approximate=mode == "approximate")
            if hit is not None:
                thresholds.update(int(tier.threshold) for tier in hit.rate.tiers)
        # Monetary completeness is not the same fact as a known price band.
        api_basis = economics["api_equivalent_basis"]
        api_reason = economics["api_equivalent_bound_reason"]
        return {
            "totals": {
                "calls": len(selected),
                "input_tokens": ints("input_tokens"),
                "output_tokens": ints("output_tokens"),
                "cache_read_tokens": ints("cache_read_tokens"),
                "cache_write_tokens": ints("cache_write_tokens"),
                "cache_read_state": totals_raw["cache_read_state"],
                "cache_read_state_reason": totals_raw["cache_read_state_reason"],
                "cache_write_state": totals_raw["cache_write_state"],
                "cache_write_state_reason": totals_raw["cache_write_state_reason"],
                "prompt_tokens": prompt_total,
                "reasoning_tokens": ints("reasoning_tokens"),
                "unpriced_tokens": unpriced_tokens,
            },
            "provenance": {
                "cache_read": totals_raw["cache_read_state"],
                "cache_write": totals_raw["cache_write_state"],
                "tiers": {
                    "thresholds": sorted(thresholds),
                    "semantics": "whole_request" if thresholds else None,
                    "applied": {"base": len(selected) - acc.tiered_calls,
                                "tiered": acc.tiered_calls},
                },
            },
            "valuation": {
                "api_equivalent_usd": totals_raw["list_usd"] if totals_raw["priced_tokens"] else None,
                "api_equivalent_usd_high": economics["api_equivalent_usd_high"],
                "api_equivalent_basis": api_basis,
                "api_equivalent_bound_reason": api_reason,
                "uncached_usd": economics["uncached_usd"],
                "cached_usd": economics["cached_usd"],
                "read_benefit_usd": economics["read_benefit_usd"],
                "read_benefit_basis": economics["read_benefit_basis"],
                "read_benefit_calls": economics["read_benefit_calls"],
                "read_benefit_tokens": economics["read_benefit_tokens"],
                "savings_usd": economics["savings_usd"],
                "savings_usd_high": economics["savings_usd_high"],
                "savings_basis": economics["savings_basis"],
                "savings_bound_reason": economics["savings_bound_reason"],
                "retention_unknown_calls": economics["retention_unknown_calls"],
                "write_premium_usd_per_mtok": economics["write_premium_usd_per_mtok"],
                "covered_calls": economics["covered_calls"],
                "excluded_calls": economics["excluded_calls"],
                "excluded_tokens": economics["excluded_tokens"],
                "gap_reasons": economics["gap_reasons"],
                "cache_hit_rate": totals_raw["cache_hit_rate"],
                "cache_hit_rate_all": totals_raw["cache_hit_rate_all"],
                "cache_hit_rate_basis": totals_raw["cache_hit_rate_basis"],
            },
        }

    stamps = [float(r["ts"]) for r in rows if isinstance(r.get("ts"), (int, float))]
    window = {"since": _iso(min(stamps)) if stamps else None,
              "until": _iso(max(stamps) + 0.001) if stamps else None,
              "kind": "session_rows"}
    scope_rows = rows if population == "all" else [r for r in rows
                                                  if str(r.get("call_class") or "") == population]
    payload: dict[str, Any] = {
        "ok": True,
        "session_id": str(session_id),
        "provider": provider,
        "model": model,
        "as_of": _iso(now),
        "window": window,
        "population": {
            "requested": population,
            "satisfied": not refused,
            "separable": separable,
            **counts,
            "reason": None if separable else "population_not_recorded",
        },
        "notes": [],
    }
    if refused:
        payload["totals"] = None
        payload["provenance"] = None
        payload["valuation"] = None
        payload["method"] = {
            "engine": "analytics._call_economics",
            "version": 1,
            "priced_at": "call_capture_time",
            "cache_denominator": "calls_with_proven_cache_fields",
            "savings_definition": "sum(uncached - cached) over covered calls",
            "read_benefit_definition": "sum(cache_read * (input - cache_read_rate)) over calls "
                                       "with a proven read counter and a published read price; never "
                                       "includes the write term",
        }
        payload["alternate"] = {"scope": "all_calls", **block(rows)}
        payload["notes"] = [{"code": "population_not_recorded", "calls": len(rows)}]
        return payload
    payload.update(block(scope_rows))
    payload["method"] = {
        "engine": "analytics._call_economics",
        "version": 1,
        "priced_at": "call_capture_time",
        "cache_denominator": "calls_with_proven_cache_fields",
        "savings_definition": "sum(uncached - cached) over covered calls",
        "read_benefit_definition": "sum(cache_read * (input - cache_read_rate)) over calls "
                                   "with a proven read counter and a published read price; never "
                                   "includes the write term",
    }
    notes: list[dict[str, Any]] = []
    if not scope_rows:
        notes.append({"code": "no_calls"})
    if scope_rows and payload["provenance"]["cache_write"] != "reported":
        notes.append({"code": "cache_write_unreported", "calls": len(scope_rows)})
    payload["notes"] = notes
    return payload