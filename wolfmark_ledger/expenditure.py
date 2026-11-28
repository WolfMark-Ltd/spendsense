"""One shared billing-aware expenditure calculation.

Expenditure is money spent on inference — a different question from the
undiscounted API-equivalent valuation, which stays an independent measure.

Precedence for one call:

1. Subscription-included usage: no additional inference expenditure ($0) —
   the membership already paid for it.
2. A reported provider debit, when one is recorded.
3. The provider's applicable effective rates (its own billed rates —
   purchased API credits are real expenditure as they are consumed).
4. The verified applicable catalogue rate (a catalogue-priced provider's
   public API price).
5. No basis at all — the call stays unmeasured, never fabricated as zero.

A genuinely free promotional tier is distinguished from purchased credits
by its own explicit zero rates in the provider's rows: a $0.00 expenditure
there is a measured zero, while purchased credits bill at their discounted
effective rates. An account with no configured billing profile is never
assumed metered for cash-impact purposes — its expenditure is an estimate
carrying its basis, and its incremental cash stays unknown.
"""
from __future__ import annotations

from typing import Any, Mapping, Optional

#: Outcomes recorded for an attempt that produced no usable response.
FAILED_OUTCOMES = frozenset({"failed", "error", "call_failed"})


def zero_usage(failed: bool, tokens: int) -> bool:
    """Whether an attempt failed without consuming anything.

    Such an attempt owes nothing: there is no usage whose price could be
    missing, so it is a measured zero rather than an unvalued call. Missing
    usage is deliberately excluded — a successful request whose counters
    never arrived may still have been billed.

    One predicate for every consumer: the aggregate (which publishes the
    per-call figure) and the billing classifier (which composes the metered
    total) must agree on which calls a figure covers.
    """
    return bool(failed) and not int(tokens or 0)


def zero_usage_row(row: Mapping[str, Any]) -> bool:
    """The same rule for an aggregated row, which carries its outcome."""
    failed = bool(row.get("_failure")) or str(row.get("outcome") or "") in FAILED_OUTCOMES
    return zero_usage(failed, row.get("_tokens") or 0)


def call_expenditure(*, billing_class: str = "unknown", reported_usd: Optional[float] = None,
                     native_effective_usd: Optional[float] = None,
                     catalogue_usd: Optional[float] = None) -> tuple[Optional[float], str]:
    """One billing-aware expenditure result for a call: ``(usd, basis)``."""
    if billing_class == "included":
        return 0.0, "included"
    if reported_usd is not None:
        return reported_usd, "reported"
    if native_effective_usd is not None:
        return native_effective_usd, "effective"
    if catalogue_usd is not None:
        return catalogue_usd, "catalogue"
    return None, "unpriced"
