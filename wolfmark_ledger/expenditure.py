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

from typing import Optional


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
