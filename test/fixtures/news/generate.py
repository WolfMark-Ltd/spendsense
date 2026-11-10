#!/usr/bin/env python3
"""Generate the WP11 Model News verification fixtures (synthetic data only).

Every item in ``realistic.json`` is produced by the real backend functions in
``wolfmark_ledger.news`` / ``wolfmark_ledger.monitoring``:

* local items come from ``diff_snapshots`` over two synthetic catalogue
  snapshots (the same pure diff a live refresh runs);
* central items come from ``validate_feed`` over a synthetic feed document
  (the same strict schema check ``fetch_central`` applies);
* ``for_you`` flags, ``related_routes`` and relevance come from
  ``rank_items`` and ``personalise_items`` with synthetic usage/signals;
* impacts come from ``compute_impacts`` priced against the synthetic usage.

Nothing here touches the network, the user's machine state, or real data:
model IDs, prices and URLs are invented. Run from the repo root:

    python3 test/fixtures/news/generate.py

Writes ``realistic.json`` and ``variants.json`` next to this script.
"""
from __future__ import annotations

import copy
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))

from wolfmark_ledger import news as news_mod  # noqa: E402
from wolfmark_ledger.monitoring import personalise_payload  # noqa: E402

OUT = Path(__file__).resolve().parent

# Fixed timestamps so committed fixtures are deterministic. Dates are
# synthetic; the "N day(s) ago" freshness label drifts as real time passes,
# which no assertion depends on.
OBSERVED = "2026-11-10T09:15:00Z"      # local catalogue diff moment
FETCHED = "2026-11-10T06:40:00Z"       # central feed cache moment
STALE_FETCHED = "2026-11-07T03:12:00Z"  # cache moment for the stale variant
CATALOGUE_AS_OF = "2026-11-09"


def rate(i, o, cr=None, cw=None, tiers=None):
    """Catalogue rate row in the shape ``diff_snapshots`` compares."""
    row = {"input": i, "output": o, "cache_read": cr, "cache_write": cw}
    if tiers is not None:
        row["tiers"] = tiers
    return row


def tier(threshold, i, o, cw):
    return {"threshold": threshold, "input": i, "output": o,
            "cache_read": None, "cache_write": cw}


# ------------------------------------------------- synthetic catalogue snapshots
# Two snapshots of the same models.dev-style cache, one refresh apart. Model
# IDs are invented but shaped like real ones; near-identical pairs
# (gpt-5.6-sol / gpt-5.6-sol-pro, dated vs undated sonnet) exist so an
# over-eager normaliser would wrongly merge them.

OLD_TIERS = [tier(200_000, 4.00, 20.00, 2.00)]
NEW_TIERS = [tier(200_000, 4.80, 24.00, 2.40)]

OLD_PROVIDERS = {
    "openai": {"gpt-5.6-sol": rate(2.50, 10.00, 0.25, 2.50)},
    "anthropic": {"claude-sonnet-4-5": rate(1.20, 6.00, None, None)},
    "moonshotai": {"kimi-k2.5": rate(0.60, 2.50, 0.06, 0.60)},
    "xai": {"grok-5-fast": rate(0.20, 1.20, None, None)},
    "openrouter": {"anthropic/claude-opus-4.1": rate(5.00, 25.00, None, 3.00, OLD_TIERS)},
    "cohere": {"command-r7b-12-2024": rate(0.15, 0.60, None, None)},
    # Existing listings so the gpt-5.6-sol / sonnet additions below are
    # reported as new MODEL items on these providers, not just new providers.
    "azure-openai": {"azure-gpt-5.3": rate(1.50, 6.00, 0.15, 1.50)},
    "github-copilot": {"copilot-gpt-5.3": rate(2.10, 10.50, 0.21, 2.10)},
    "amazon-bedrock": {"claude-3-5-haiku": rate(0.80, 4.00, 0.08, 0.80)},
    # Present on both sides so the gemini cut is a local model-level event.
    "google": {"gemini-3-flash": rate(0.50, 2.00, 0.05, None)},
    # Present on both sides so deepseek-v4 is a local model-level event.
    "deepseek": {"deepseek-v3.2": rate(0.28, 1.10, 0.03, 0.28)},
    # Identity-variant provider: usage records "M1" while the item model is
    # "m1" (case-only difference), plus an exact-match control "x2" (a real
    # price transition so the exact usage match prices an impact).
    "fixturelabs": {"fixturelabs-m0": rate(0.40, 1.60, None, None),
                    "x2": rate(0.50, 2.00, None, None)},
}

NEW_PROVIDERS = {
    "openai": {
        "gpt-5.6-sol": rate(1.25, 5.00, 0.125, 1.25),
        "gpt-5.6-sol-pro": rate(3.00, 15.00, 0.375, 3.75),
    },
    "azure-openai": {
        "azure-gpt-5.3": rate(1.50, 6.00, 0.15, 1.50),
        "gpt-5.6-sol": rate(1.40, 5.60, 0.14, 1.40),
    },
    "github-copilot": {
        "copilot-gpt-5.3": rate(2.10, 10.50, 0.21, 2.10),
        "gpt-5.6-sol": rate(2.00, 10.00, None, None),
    },
    "anthropic": {"claude-sonnet-4-5": rate(0.90, 4.50, None, None)},
    "moonshotai": {"kimi-k2.5": rate(0.45, 1.90, 0.045, 0.475)},
    "xai": {"grok-5-fast": rate(0.30, 1.80, None, None)},
    "openrouter": {"anthropic/claude-opus-4.1": rate(6.00, 30.00, None, 3.60, NEW_TIERS)},
    "amazon-bedrock": {
        "claude-3-5-haiku": rate(0.80, 4.00, 0.08, 0.80),
        "claude-sonnet-4-5-20250929": rate(1.80, 9.00, None, None),
    },
    "google": {"gemini-3-flash": rate(0.30, 1.20, 0.03, None)},
    "deepseek": {
        "deepseek-v3.2": rate(0.28, 1.10, 0.03, 0.28),
        "deepseek-v4": rate(0.28, 1.15, 0.028, 0.28),
    },
    "fixturelabs": {
        "fixturelabs-m0": rate(0.40, 1.60, None, None),
        "m1": rate(0.20, 0.80, None, None),
        "x2": rate(0.40, 1.60, None, None),
        # Recency-timestamp variants: four listings whose hand-written
        # last_used_at can never earn recency wording (older than 30 days,
        # malformed, in the future, empty). None has an exact usage row, so
        # none may carry a numeric personal estimate either.
        "ts-old90day": rate(0.35, 1.40, None, None),
        "ts-malformed": rate(0.22, 0.90, None, None),
        "ts-future": rate(0.18, 0.75, None, None),
        "ts-empty": rate(0.12, 0.50, None, None),
    },
    # Genuinely new provider: exercises the provider-level listing summary.
    "perplexity": {
        "sonar-pro": rate(1.00, 3.00, 0.10, 1.00),
        "sonar-reasoning": rate(2.00, 8.00, None, None),
    },
}

# ------------------------------------------------- synthetic plan catalogue
# Shape consumed by ``_plans_table``; the fee change and the terms change on
# claude-max-20x plus the new gemini plan are all deliberate.

PLANS_DOC_OLD = {
    "plans": [
        {
            "id": "claude-max-20x", "provider_family": "anthropic",
            "name": "Claude Max 20x",
            "price": {"amount": 100, "currency": "USD", "period": "month"},
            "entitlements": {"usage_window": "5h session", "messages": "unlimited"},
            "verification": {"source_id": "src-anthropic-plans"},
        },
    ],
    "sources": [
        {"id": "src-anthropic-plans",
         "url": "https://announcements.spend-sense.example/plans/claude-max-20x"},
        {"id": "src-google-plans",
         "url": "https://announcements.spend-sense.example/plans/gemini-code-assist-pro"},
    ],
}

PLANS_DOC_NEW = {
    "plans": [
        {
            "id": "claude-max-20x", "provider_family": "anthropic",
            "name": "Claude Max 20x",
            "price": {"amount": 200, "currency": "USD", "period": "month"},
            "entitlements": {"usage_window": "1h session", "messages": "unlimited"},
            "verification": {"source_id": "src-anthropic-plans"},
        },
        {
            "id": "gemini-code-assist-pro", "provider_family": "google",
            "name": "Gemini Code Assist Pro",
            "price": {"amount": 19, "currency": "USD", "period": "month"},
            "entitlements": {"usage_window": "monthly quota", "messages": "unlimited"},
            "verification": {"source_id": "src-google-plans"},
        },
    ],
    "sources": PLANS_DOC_OLD["sources"],
}


def snapshot(providers, plans_doc, captured_at):
    """Snapshot shape produced by ``snapshot_catalogue`` (plans via the real table)."""
    return {
        "version": news_mod.NEWS_VERSION,
        "catalogue_source": "models.dev cache (synthetic fixture)",
        "catalogue_as_of": CATALOGUE_AS_OF,
        "providers": providers,
        "plans": news_mod._plans_table(plans_doc),
        "plans_normalised": True,
        "captured_at": captured_at,
    }


# ------------------------------------------------- synthetic central feed
# Shape ``validate_feed`` accepts; every entry carries a source URL as the
# real feed requires. All IDs, hosts and announcements are invented.

def feed_entry(item_id, category, provider, model, observed, url, *,
               summary_code, previous=None, current=None, effective="",
               confidence="curated", conditions="", conditions_code="",
               has_tiers=False):
    return {
        "id": item_id, "category": category, "provider": provider, "model": model,
        "summary": "",  # filled from the same summary codes the backend emits
        "summary_code": summary_code,
        "summary_params": {"model": model, "provider": provider} if model
        else {"provider": provider},
        "previous": previous, "current": current, "has_tiers": has_tiers,
        "observed_at": observed, "effective_at": effective,
        "source_url": url, "confidence": confidence,
        "provenance": "SpendSense announcements",
        "conditions": conditions, "conditions_code": conditions_code,
    }


FEED_ITEMS = [
    # The same kimi price cut the local diff also found (duplicate event).
    # The LOCAL twin is hand-equalised below (same nonempty effective_at and
    # source_url), which is the explicit same-event proof the final merger
    # requires; without it the pair would stay two events.
    feed_entry(
        "central-2026-11-07-moonshotai-kimi-k2-5-rate-cut", "price_reduction",
        "moonshotai", "kimi-k2.5", "2026-11-07T08:40:00Z",
        "https://announcements.spend-sense.example/feed/moonshotai-kimi-k2-5-rate-cut",
        summary_code="news_sum_price_change_feed", effective="2026-11-07",
        previous=rate(0.60, 2.50, 0.06, 0.60), current=rate(0.45, 1.90, 0.045, 0.475)),
    # claude-opus thinking variant, newly listed on the announcements feed.
    feed_entry(
        "central-2026-11-09-anthropic-claude-opus-4-1-20250805-thinking", "new_model",
        "anthropic", "claude-opus-4-1-20250805-thinking", "2026-11-09T16:05:00Z",
        "https://announcements.spend-sense.example/feed/claude-opus-4-1-20250805-thinking",
        summary_code="news_sum_new_model_feed", effective="2026-11-09",
        current=rate(4.50, 22.50, 0.45, 4.50), confidence="verified"),
    # Namespaced IDs must render verbatim, never stripped or merged.
    feed_entry(
        "central-2026-11-09-openrouter-anthropic-claude-sonnet-4-5", "new_model",
        "openrouter", "openrouter/anthropic/claude-sonnet-4.5", "2026-11-09T21:30:00Z",
        "https://announcements.spend-sense.example/feed/openrouter-claude-sonnet-4-5",
        summary_code="news_sum_new_model_feed", effective="2026-11-08",
        current=rate(0.90, 4.50, 0.09, 0.90)),
    feed_entry(
        "central-2026-11-09-deepinfra-deepseek-v4-pro", "new_model",
        "deepinfra", "deepseek-ai/deepseek-v4-pro", "2026-11-09T18:00:00Z",
        "https://announcements.spend-sense.example/feed/deepseek-v4-pro",
        summary_code="news_sum_new_model_feed", effective="2026-11-09",
        current=rate(0.27, 1.10, None, None)),
    # Near-duplicate control, cross-origin: the LOCAL diff found the same
    # gemini cut (observed_at hand-equalised below) with a conflicting
    # nonempty source_url — proof is impossible, so both stay distinct events.
    feed_entry(
        "central-2026-11-10-google-gemini-3-flash-cut-0843", "price_reduction",
        "google", "gemini-3-flash", "2026-11-10T07:59:50Z",
        "https://announcements.spend-sense.example/feed/gemini-3-flash-cut-b",
        summary_code="news_sum_price_change_feed",
        previous=rate(0.50, 2.00, 0.05, None), current=rate(0.30, 1.20, 0.03, None)),
    # Same-event variant: identical transition observed at the SAME instant as
    # the local diff, effective dates empty, source URL only on the central
    # side (absent URL never conflicts) → the two merge into one event.
    feed_entry(
        "central-2026-11-10-deepseek-deepseek-v4-listing", "new_model",
        "deepseek", "deepseek-v4", OBSERVED,
        "https://announcements.spend-sense.example/feed/deepseek-v4-listing",
        summary_code="news_sum_new_model_feed",
        current=rate(0.28, 1.15, 0.028, 0.28)),
    # Repeated identical before→after transition with a different source and
    # effective date: distinct events, must never be merged. Both sides are
    # central, so this is also the same-origin control (same-origin items with
    # different ids never merge, by construction).
    feed_entry(
        "central-2026-11-06-mistral-large-3-pricing-update", "price_increase",
        "mistral", "mistral-large-3", "2026-11-06T12:00:00Z",
        "https://announcements.spend-sense.example/feed/mistral-large-3-pricing-update",
        summary_code="news_sum_price_change_feed", effective="2026-11-01",
        previous=rate(2.50, 7.50, None, None), current=rate(3.00, 9.00, None, None)),
    feed_entry(
        "central-2026-11-06-mistral-large-3-pricing-update-2", "price_increase",
        "mistral", "mistral-large-3", "2026-11-06T12:00:30Z",
        "https://announcements.spend-sense.example/feed/mistral-large-3-pricing-update-2",
        summary_code="news_sum_price_change_feed", effective="2026-11-05",
        previous=rate(2.50, 7.50, None, None), current=rate(3.00, 9.00, None, None)),
]

# English summaries for the feed entries, mirroring news_feed.py wording so
# the raw ``summary`` fallback reads plausibly if codes are dropped.
FEED_SUMMARIES = {
    "central-2026-11-07-moonshotai-kimi-k2-5-rate-cut":
        "kimi-k2.5 (moonshotai) list price changed on models.dev.",
    "central-2026-11-09-anthropic-claude-opus-4-1-20250805-thinking":
        "claude-opus-4-1-20250805-thinking newly listed under anthropic on models.dev.",
    "central-2026-11-09-openrouter-anthropic-claude-sonnet-4-5":
        "openrouter/anthropic/claude-sonnet-4.5 newly listed under openrouter on models.dev.",
    "central-2026-11-09-deepinfra-deepseek-v4-pro":
        "deepseek-ai/deepseek-v4-pro newly listed under deepinfra on models.dev.",
    "central-2026-11-10-google-gemini-3-flash-cut-0843":
        "gemini-3-flash (google) list price changed on models.dev.",
    "central-2026-11-10-deepseek-deepseek-v4-listing":
        "deepseek-v4 newly listed under deepseek on models.dev.",
    "central-2026-11-06-mistral-large-3-pricing-update":
        "mistral-large-3 (mistral) list price changed on models.dev.",
    "central-2026-11-06-mistral-large-3-pricing-update-2":
        "mistral-large-3 (mistral) list price changed on models.dev.",
}
for entry in FEED_ITEMS:
    entry["summary"] = FEED_SUMMARIES[entry["id"]]

# ------------------------------------------------- synthetic local signals/usage
# Signals mirror monitoring.local_signals for a machine with one anthropic and
# one openai credential, recorded usage on two routes, and a selected plan.
SIGNALS = {
    "configured_families": ["anthropic", "openai"],
    "used_providers": ["anthropic", "openai-codex", "fixturelabs"],
    "used_models": [
        {"provider": "anthropic", "model": "claude-sonnet-4-5"},
        {"provider": "openai-codex", "model": "gpt-5.6-sol"},
        # Case-only identity variant: usage recorded as "M1", item model "m1".
        {"provider": "fixturelabs", "model": "M1"},
        # Exact-match control for the identity variant.
        {"provider": "fixturelabs", "model": "x2"},
    ],
    "plan_ids": ["claude-max-20x"],
    "plan_families": ["anthropic"],
}

EMPTY_SIGNALS = {key: [] for key in SIGNALS}

# Token buckets as usage_summary would return them, keyed by (route, model).
# last_ts is the newest successful call per row (final news._last_used_at
# derives an item's last_used_at from the exact (provider, model) row only).
USAGE = {
    ("openai-codex", "gpt-5.6-sol"): {
        "input": 900_000, "output": 60_000, "cache_read": 4_000_000,
        "cache_write": 120_000, "calls": 214, "last_ts": 1_793_800_000.0,
    },
    ("anthropic", "claude-sonnet-4-5"): {
        "input": 1_200_000, "output": 80_000, "cache_read": 3_500_000,
        "cache_write": 0, "calls": 189, "last_ts": 1_793_700_000.0,
    },
    # Case-only recording: "M1" never equals the item model "m1" exactly, so
    # no impact may be priced from it and no honest last_used_at exists.
    ("fixturelabs", "M1"): {
        "input": 10_000, "output": 1_000, "cache_read": 0, "cache_write": 0,
        "calls": 3, "last_ts": 1_793_600_000.0,
    },
    # Exact-match control row for "x2".
    ("fixturelabs", "x2"): {
        "input": 50_000, "output": 5_000, "cache_read": 0, "cache_write": 0,
        "calls": 12, "last_ts": 1_793_760_000.0,
    },
}


def build_local_items():
    old_snap = snapshot(OLD_PROVIDERS, PLANS_DOC_OLD, "2026-11-06T09:00:00Z")
    new_snap = snapshot(NEW_PROVIDERS, PLANS_DOC_NEW, OBSERVED)
    items, meta = news_mod.diff_snapshots(old_snap, new_snap, observed_at=OBSERVED,
                                          plans_doc=PLANS_DOC_NEW)
    assert items, "synthetic catalogue diff produced no items"
    return items, meta


def build_central_items():
    feed, problems = news_mod.validate_feed(
        {"version": 1, "generated_at": FETCHED, "items": FEED_ITEMS})
    assert feed and not problems, f"synthetic feed rejected: {problems}"
    return feed["items"]


# Hand-written recency evidence (see README.md): the exact-match control's
# in-window stamp and the four recency-rejection variants. ``rank_items``
# derives ``last_used_at`` from the exact (provider, model) usage row and
# would clobber these values, so they are (re-)applied AFTER ranking, on
# every payload that carries the fixturelabs items (realistic, stale and
# nosignals — partial holds no fixturelabs item and empty holds no items).
# The pre-ranking assignments in main() stay: they only pin the key's
# serialisation position (the committed fixtures carry ``last_used_at``
# between ``conditions_code`` and ``for_you``); the values below are the
# authoritative evidence.
SYNTHETIC_LAST_USED_AT = {
    "x2": "2026-11-09T18:30:00Z",
    "ts-old90day": "2026-08-01T12:00:00Z",
    "ts-malformed": "not-a-timestamp",
    "ts-future": "2027-06-01T00:00:00Z",
    "ts-empty": "",
}


def apply_synthetic_last_used(payload):
    for item in payload["local"]["items"] + payload["central"]["items"]:
        stamp = SYNTHETIC_LAST_USED_AT.get(item.get("model"))
        if stamp is not None:
            item["last_used_at"] = stamp


def base_payload(local_items, central_items, *, live=True, central_state="fresh",
                 fetched_at=FETCHED, central_error="", impacts=None,
                 signals=SIGNALS, usage=USAGE, tokens=("anthropic", "openai")):
    combined = news_mod.rank_items([*local_items, *central_items],
                                   usage=usage, tokens=set(tokens))
    combined.sort(key=lambda item: (str(item.get("observed_at") or ""),
                                    str(item.get("id") or "")), reverse=True)
    payload = {
        "ok": True,
        "settings": {"live_updates": live},
        "catalogue": {"source": "models.dev cache (synthetic fixture)",
                      "as_of": CATALOGUE_AS_OF, "snapshot_at": OBSERVED},
        "providers_configured": sorted(tokens),
        "impact_window_days": news_mod.IMPACT_DAYS,
        "local": {"items": [item for item in combined if item.get("origin") == "local"],
                  "baseline": False, "store_error": "", "snapshot_at": OBSERVED,
                  "removed_models": [], "removed_model_count": 0,
                  "removed_plan_count": 0},
        "central": {"state": central_state, "items":
                    [item for item in combined if item.get("origin") == "central"],
                    "fetched_at": fetched_at, "error": central_error},
        "for_you_count": sum(1 for item in combined if item.get("for_you")),
        "impacts": impacts if impacts is not None
        else news_mod.compute_impacts(combined, usage),
    }
    return personalise_payload(payload, signals=signals)


def relevant_items(payload):
    return payload["local"]["items"] + payload["central"]["items"]


def main():
    local_items, meta = build_local_items()
    central_items = build_central_items()

    # --- hand-written fields the worktree diff cannot generate (documented in
    # --- README.md). Everything else stays backend-generated.

    # Proven same-event pair: the local kimi twin carries the SAME nonempty
    # effective_at and source_url as the central entry — the explicit proof
    # the final merger (newsSameEventProof) requires to fuse them.
    central_kimi = next(item for item in central_items if item["model"] == "kimi-k2.5")
    local_kimi = next(item for item in local_items if item["model"] == "kimi-k2.5")
    local_kimi["effective_at"] = central_kimi["effective_at"]      # 2026-11-07
    local_kimi["source_url"] = central_kimi["source_url"]

    # Cross-origin source-url conflict control: the local gemini cut keeps a
    # conflicting nonempty source_url and its observed_at is hand-equalised to
    # the central twin's instant — with identical transitions and empty
    # effective dates, ONLY the conflicting URLs keep the two events distinct.
    central_cut = next(item for item in central_items if item["model"] == "gemini-3-flash")
    local_cut = next(item for item in local_items if item["model"] == "gemini-3-flash")
    local_cut["observed_at"] = central_cut["observed_at"]          # 07:59:50Z
    local_cut["source_url"] = ("https://announcements.spend-sense.example"
                               "/feed/gemini-3-flash-cut-a")

    # Friendly display name, exactly as the final backend copies it from the
    # catalogue entry (model_name); the exact ID must still render beside it.
    next(item for item in local_items if item["model"] == "gpt-5.6-sol-pro")[
        "model_name"] = "GPT-5.6 Sol Pro"

    # In-window last_used_at for the exact-match control (the final backend
    # derives this from the newest exact (provider, model) usage row). The
    # case-only "m1" item deliberately gets NO last_used_at: its recorded
    # usage is "M1", which is pricing-case-equal but never usage evidence.
    # Assigned here only to pin the key's serialisation position; rank_items
    # overwrites the value, so SYNTHETIC_LAST_USED_AT is re-applied after
    # ranking (apply_synthetic_last_used).
    next(item for item in local_items if item["model"] == "x2")[
        "last_used_at"] = "2026-11-09T18:30:00Z"

    # Recency-timestamp variants on the same provider. Every value below is
    # one the final recency rules must REJECT: a valid timestamp older than
    # the 30-day window (the UI may say "Used before", never "recently"), a
    # malformed string, a future date and an empty string. The older item's
    # observed_at is also moved past the 30-day window so the All Updates day
    # filter has something to drop. The last_used_at values are re-applied
    # after ranking (see SYNTHETIC_LAST_USED_AT); the observed_at override
    # survives ranking and also fixes the item's sort position.
    ts_old = next(item for item in local_items if item["model"] == "ts-old90day")
    ts_old["observed_at"] = "2026-10-05T09:15:00Z"   # ~36 days before 2026-11-10
    ts_old["last_used_at"] = "2026-08-01T12:00:00Z"  # valid but ~101 days old
    next(item for item in local_items if item["model"] == "ts-malformed")[
        "last_used_at"] = "not-a-timestamp"
    next(item for item in local_items if item["model"] == "ts-future")[
        "last_used_at"] = "2027-06-01T00:00:00Z"
    next(item for item in local_items if item["model"] == "ts-empty")[
        "last_used_at"] = ""

    # Root-level tier fields (the final contract reads tiers_detail plus
    # tiers_before/tiers_after at the item root): the openrouter opus increase
    # declares its tier rows KNOWN, so the UI must render one comparable tier
    # chip and list each row in Details — never average or fabricate rows.
    opus = next(item for item in local_items if item["model"] == "anthropic/claude-opus-4.1")
    opus["tiers_detail"] = "known"
    opus["tiers_before"] = [{"type": "standard", "size": 200000, "input": 4.00,
                             "output": 20.00, "cache_read": None, "cache_write": 2.00}]
    opus["tiers_after"] = [{"type": "standard", "size": 200000, "input": 4.80,
                            "output": 24.00, "cache_read": None, "cache_write": 2.40}]

    # Official-verification block on the local kimi twin (the merge keeps the
    # local item's fields). The source note is plain text by contract — the
    # UI must never turn it into a link.
    local_kimi["official"] = {
        "verified_at": "2026-11-07T08:40:00Z",
        "source_note": "vendor announcement page (synthetic fixture note)",
        "windows": [],
    }

    realistic = base_payload(local_items, central_items)
    apply_synthetic_last_used(realistic)
    realistic["local"].update({
        "removed_models": meta["removed_models"],
        "removed_model_count": meta["removed_model_count"],
        "removed_plan_count": meta["removed_plan_count"],
    })
    relevant = [item["id"] for item in
                realistic["local"]["items"] + realistic["central"]["items"]
                if item.get("relevance", {}).get("relevant")]
    # For You rank flag under the final exact-pair semantics: EXPLICIT
    # expected membership, reasoned from the fixture's own evidence and NOT
    # read back from rank_items. An item is for_you when its provider is a
    # configured token family (anthropic, openai), its provider carries
    # recorded usage (openai via the openai-codex route, anthropic,
    # fixturelabs), or the exact (provider, model) pair has a usage row.
    # An earlier committed revision of the JSON marked the azure-openai and
    # github-copilot listings of gpt-5.6-sol for_you under the older
    # last-segment semantics; both have no matching used or configured
    # provider and read-time relevance=false with empty reasons, so the
    # final ranking excludes exactly those two and the payload count is 11.
    EXPECTED_FOR_YOU = {
        ("openai", "gpt-5.6-sol"), ("openai", "gpt-5.6-sol-pro"),
        ("anthropic", "claude-sonnet-4-5"),
        ("anthropic", ""),                       # claude-max-20x plan item
        ("fixturelabs", "m1"), ("fixturelabs", "x2"),
        ("fixturelabs", "ts-old90day"), ("fixturelabs", "ts-malformed"),
        ("fixturelabs", "ts-future"), ("fixturelabs", "ts-empty"),
        ("anthropic", "claude-opus-4-1-20250805-thinking"),      # central
    }
    marked = {(item["provider"], item.get("model") or "")
              for item in relevant_items(realistic) if item.get("for_you")}
    assert marked == EXPECTED_FOR_YOU, sorted(marked ^ EXPECTED_FOR_YOU)
    assert realistic["for_you_count"] == 11, realistic["for_you_count"]
    assert len(relevant) == 11, relevant
    assert len(realistic["local"]["items"]) == 20
    assert len(realistic["central"]["items"]) == 8
    # The two excluded cross-provider listings: never for_you, never relevant.
    for item in relevant_items(realistic):
        if item["provider"] in ("azure-openai", "github-copilot") \
                and item["model"] == "gpt-5.6-sol":
            assert not item["for_you"], item["id"]
            assert item["relevance"]["relevant"] is False, item["relevance"]
            assert item["relevance"]["reasons"] == [], item["relevance"]
    # Case-only identity variant: the backend emits used_model for the m1 item
    # (match_relevance lowercases) but no impact may exist for it, while the
    # exact-match control x2 is priced.
    m1 = next(item for item in relevant_items(realistic) if item["model"] == "m1")
    x2 = next(item for item in relevant_items(realistic) if item["model"] == "x2")
    assert "used_model" in m1["relevance"]["reasons"], m1["relevance"]
    assert "used_model" in x2["relevance"]["reasons"], x2["relevance"]
    assert m1.get("last_used_at", "") == "", m1
    assert x2.get("last_used_at") == "2026-11-09T18:30:00Z", x2
    assert not any(key.startswith("local-") and "m1" in key for key in realistic["impacts"]), \
        sorted(realistic["impacts"])
    assert any(key.startswith("local-") and "x2" in key for key in realistic["impacts"]), \
        sorted(realistic["impacts"])
    # Recency-timestamp variants: relevant (so the UI renders their reasons)
    # but never priceable — no exact usage row means no numeric estimate.
    for model, stamp in (("ts-old90day", "2026-08-01T12:00:00Z"),
                         ("ts-malformed", "not-a-timestamp"),
                         ("ts-future", "2027-06-01T00:00:00Z"),
                         ("ts-empty", "")):
        ts_item = next(item for item in relevant_items(realistic) if item["model"] == model)
        assert ts_item.get("last_used_at") == stamp, ts_item
        assert "used_provider" in ts_item["relevance"]["reasons"], ts_item["relevance"]
        assert not any("ts-" in key for key in realistic["impacts"]), sorted(realistic["impacts"])
    # Root tier fields and the official note landed on their items.
    opus = next(item for item in relevant_items(realistic)
                if item["model"] == "anthropic/claude-opus-4.1")
    assert opus["tiers_detail"] == "known" and opus["tiers_before"] and opus["tiers_after"], opus
    kimi_local_item = next(item for item in relevant_items(realistic) if item["model"] == "kimi-k2.5"
                           and item["origin"] == "local")
    assert kimi_local_item["official"]["source_note"], kimi_local_item
    print("for-you items:", *relevant, sep="\n  ")
    print("impacts:", {key: round(value["delta_usd"], 4)
                       for key, value in realistic["impacts"].items()})

    by_id = {item["id"]: item for item in local_items + central_items}

    empty = base_payload([], [])
    empty["local"].update({
        "removed_models": [], "removed_model_count": 0, "removed_plan_count": 0})

    # Partial (Live Updates off): the local store alone, central disabled.
    partial_ids = [item["id"] for item in local_items
                   if item["provider"] in ("openai", "anthropic")]
    partial_items = [copy.deepcopy(by_id[i]) for i in partial_ids]
    partial = base_payload(partial_items, [], live=False, central_state="disabled",
                           fetched_at="", impacts={
                               key: value for key, value in realistic["impacts"].items()
                               if key in set(partial_ids)})

    stale = base_payload(local_items, central_items, central_state="stale",
                         fetched_at=STALE_FETCHED,
                         central_error="central feed unavailable (URLError)")
    apply_synthetic_last_used(stale)

    nosignals = base_payload(local_items, central_items, signals=EMPTY_SIGNALS,
                             usage={}, tokens=())
    apply_synthetic_last_used(nosignals)
    assert nosignals["for_you_count"] == 0
    assert nosignals["impacts"] == {}

    error = {"ok": False,
             "detail": "Synthetic refresh failure (verification fixture): "
                       "the news service is unreachable."}

    (OUT / "realistic.json").write_text(
        json.dumps(realistic, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    (OUT / "variants.json").write_text(
        json.dumps({"empty": empty, "partial": partial, "stale": stale,
                    "nosignals": nosignals, "error": error},
                   indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"wrote {OUT/'realistic.json'} ({len(realistic['local']['items'])} local, "
          f"{len(realistic['central']['items'])} central items)")
    print(f"wrote {OUT/'variants.json'} (empty, partial, stale, nosignals, error)")


if __name__ == "__main__":
    main()
