#!/usr/bin/env python3
"""Rebuild catalogue/sources.json from the citations the catalogue already carries.

Every source id cited by a plan must appear here, with what kind of evidence it
actually is. A registered source is **not** a working parser: ``adapter`` names a
parser or says ``manual``, and ``parsed`` mirrors that, so "I added the URL"
cannot be mistaken for "the check now covers it".

Run once per catalogue change; it is idempotent.

    python3 scripts/register-sources.py [--write]
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[1]
CATALOGUE = ROOT / "catalogue"

#: Evidence kind per source. The vocabulary is closed so a check can reason about
#: what a source can and cannot establish.
#:   price_page       — states subscription prices; can verify a plan price
#:   token_price_page — states per-token rates only; cannot verify a subscription
#:   product_page     — describes the product; may or may not show a price
#:   docs_only        — API/technical documentation
#:   balance_api      — reports a balance or credits; never a subscription price
#:   aggregator       — third-party catalogue, not the vendor
#:   cannot_price     — the page cannot price the plan (login wall, portal)
KINDS = ("price_page", "token_price_page", "product_page", "docs_only",
         "balance_api", "aggregator", "cannot_price")

KIND = {
    "alibaba-coding-plan": "price_page",
    "anthropic-claude-pricing": "price_page",
    "cline-pricing": "price_page",
    "commandcode-go": "product_page",
    "commandcode-goat-plan": "product_page",
    "commandcode-pricing": "price_page",
    "commandcode-provider-api": "docs_only",
    "github-copilot-plans": "price_page",
    "huggingface-pricing": "price_page",
    "kilocode-pricing": "price_page",
    "kimi-coding-plan": "docs_only",
    "minimax-coding-plan": "product_page",
    "minimax-m-plan": "docs_only",
    "models-dev-catalogue": "aggregator",
    "moonshot-coding-plan": "docs_only",
    "nous-portal": "cannot_price",
    "nous-portal-pricing": "price_page",
    "ollama-cloud-pricing": "price_page",
    "ollama-pricing": "price_page",
    "openai-business-help": "price_page",
    "openai-chatgpt-pricing": "price_page",
    "opencode-console-models": "docs_only",
    "opencode-go-plan": "price_page",
    "openrouter-credits-api": "balance_api",
    "tencent-coding-plan": "price_page",
    "umans-ai": "token_price_page",
    "volcengine-coding-plan": "docs_only",
    "x-subscription-pricing": "price_page",
    "xai-grok-pricing": "product_page",
    "xai-supergrok": "product_page",
    "zai-coding-plan": "price_page",
}

#: The five sources a parser actually reads, and the family it covers.
ADAPTER = {
    "opencode-go-plan": ("opencode_go", "opencode-go", True),
    "commandcode-pricing": ("commandcode_pricing", "commandcode", True),
    "ollama-pricing": ("ollama_pricing", "ollama-cloud", True),
    "huggingface-pricing": ("huggingface_pricing", "huggingface", False),
    "kilocode-pricing": ("kilocode_pricing", "kilocode", True),
}

#: Plans a source sells by quote, so the table can never list them. Recorded on
#: the source so an absent row is not read as a removal.
#: Empty: the live table lists Enterprise at "from $5,000/mo", which the parser
#: records as a floor rather than a price.
CUSTOM_QUOTE: dict[str, list[str]] = {}

#: Duplicate URLs kept as separate ids because plans cite them separately. The
#: canonical id carries the parser; the alias records why it has none.
#: nous-portal-pricing is no longer an alias: it cites the public Portal price
#: table, a different page from the login-gated portal row.
ALIAS = {
    "ollama-cloud-pricing": ("ollama-pricing", "same page; the parser lives on ollama-pricing"),
    "minimax-coding-plan": ("minimax-m-plan", "canonical docs under /m-plan/; no price on any fetchable page"),
    "moonshot-coding-plan": ("kimi-coding-plan", "same API pricing page as Kimi"),
    "xai-grok-pricing": ("xai-supergrok", "same consumer product page"),
}

#: Manual sources whose page enumerates the whole family. Parsed sources get
#: this from ADAPTER; manual rows need it stated here instead.
COMPLETE = frozenset({"alibaba-coding-plan", "tencent-coding-plan"})

FAMILY_HINTS = {
    "anthropic-claude-pricing": "anthropic",
    "github-copilot-plans": "github-copilot",
    "openai-chatgpt-pricing": "openai-codex",
    "openrouter-credits-api": "openrouter",
    "zai-coding-plan": "zai-coding-plan",
    "models-dev-catalogue": None,
    "opencode-console-models": "opencode-zen",
    "opencode-go-plan": "opencode-go",
    "commandcode-pricing": "commandcode",
    "commandcode-go": "commandcode",
    "commandcode-provider-api": "commandcode",
    "ollama-pricing": "ollama-cloud",
    "ollama-cloud-pricing": "ollama-cloud",
    "huggingface-pricing": "huggingface",
    "kilocode-pricing": "kilocode",
    "cline-pricing": "cline-pass",
    "kimi-coding-plan": "kimi-code-plan-global",
    "moonshot-coding-plan": "kimi-code-plan-global",
    "minimax-coding-plan": "minimax-coding-plan",
    "minimax-m-plan": "minimax-coding-plan",
    "alibaba-coding-plan": "alibaba-coding-plan",
    "tencent-coding-plan": "tencent-coding-plan",
    "volcengine-coding-plan": "volcengine-coding-plan",
    "umans-ai": "umans-ai-coding-plan",
    "nous-portal": "nous",
    "nous-portal-pricing": "nous",
    "xai-supergrok": "xai-oauth",
    "xai-grok-pricing": "xai-oauth",
    "openai-business-help": "openai-codex",
    "x-subscription-pricing": "x-subscription",
    "commandcode-goat-plan": "commandcode",
}

#: Retrieval records we can stand behind: either read live in this pass, or
#: explicitly unknown. Nothing claims a timestamp it does not have.
LIVE = {
    "ollama-pricing": {"retrieved_at": "2026-11-04T04:20:20Z", "http_status": 200,
                       "fetched_url": "https://ollama.com/pricing"},
    "huggingface-pricing": {"retrieved_at": "2026-10-30T12:22:52Z", "http_status": 200,
                            "fetched_url": "https://huggingface.co/pricing"},
    "kilocode-pricing": {"retrieved_at": "2026-10-30T12:22:53Z", "http_status": 200,
                         "fetched_url": "https://kilocode.ai/pricing"},
    "volcengine-coding-plan": {"fetched_url": "https://docs.volcengine.com/docs/ark?lang=zh"},
}

#: Curated register notes. Rows without an entry inherit the embedded fetch
#: notes from plans.json; alias rows get the "Alias of ..." suffix appended.
NOTES = {
    "models-dev-catalogue": "Third-party catalogue. Useful for model metadata, never authority for a vendor's price.",
    "kimi-coding-plan": "API token pricing. States outright that inference is pay-as-you-go with no "
                        "subscription plan, so it cannot verify a Kimi Code plan. Re-read 4 Nov 2026.",
    "umans-ai": "Publishes per-token rates for open models; the page sells a top-up wallet "
                "('Pay per token'), with no subscription, seat or quota window. Reclassified to a "
                "prepaid wallet in catalogue 2026-11-04.3.",
    "nous-portal": "Login-gated portal. A balance can be read through Hermes; a price cannot.",
    "nous-portal-pricing": "Public Portal lists current individual subscription prices (Free $0, Plus $20, "
                           "Super $100, Ultra $200); API-key usage is separately metered. Legacy plans may "
                           "differ. Re-confirmed 4 Nov 2026.",
    "openrouter-credits-api": "Credits endpoint. Reports a balance, never a plan price. A direct fetch "
                              "returns 401 without credentials.",
    "xai-supergrok": "Consumer product page advertises SuperGrok with no price; the public table at "
                     "x.ai/pricing names Plus/Premium/Super/Ultra tiers but no SuperGrok tier, and the API "
                     "route is billed separately.",
    "xai-grok-pricing": "SuperGrok is sold through an account page; a public price table exists at "
                        "x.ai/pricing but names no SuperGrok tier.",
    "alibaba-coding-plan": "Coding Plan docs price Pro at $50/month with request quotas; Lite discontinued. "
                           "Coding Plan, Token Plan and pay-as-you-go are separate arrangements.",
    "anthropic-claude-pricing": "Max $100 (5x Pro); Ultra $200 (10x Pro weekly, no 5-hour limit, $200 API "
                                "credits); the Ultra checkout slug is still max_20x.",
    "commandcode-pricing": "Plan table: prices, credit pools and rolling windows. Its Go row lists $2/$5, "
                           "while the same page FAQ says $3/$6. Enterprise is sold by quote. Conflict "
                           "re-confirmed 4 Nov 2026.",
    "commandcode-go": "Go plan page describes per-model monthly credits for new subscribers from 28 September "
                      "2026 within a shared $10 pool, states $3/$6 rolling windows, and says Go is the only "
                      "plan without API access. Re-read 4 Nov 2026.",
    "commandcode-goat-plan": "GOAT plan page confirms Provider API access is metered against GOAT credits, "
                             "and states up to $20 per 5 hours, $50 per 7 days, and $100 per month. "
                             "Re-read 4 Nov 2026.",
    "commandcode-provider-api": "The Provider API page describes $15/month plus a $1.01 processing fee and "
                                "identifies Provider as a separate pay-as-you-go plan.",
    "github-copilot-plans": "Free (2,000 completions), Pro $10 ($15 credits), Pro+ $39 ($70), Max $100 ($200). "
                            "Re-confirmed 4 Nov 2026.",
    "minimax-coding-plan": "Documented URL 404s (confirmed 4 Nov 2026); MiniMax markets an 'M Plan' instead.",
    "minimax-m-plan": "M Plan intro: individual subscription with Go/Explore/Build tiers (1x/3x/7.5x), usable "
                      "in coding tools via MiniMax Code or an M Plan API key. No price on any fetchable page; "
                      "checkout is a JS shell.",
    "openai-business-help": "Help Centre Business pricing: Standard $25/$20 and Premium $125/$100 per user per "
                            "month (monthly/annual monthly figures); usual 2-seat minimum; both seats include "
                            "Codex. Corroborated by the Business billing guide.",
    "openai-chatgpt-pricing": "Plan list and feature matrix render server-side; the per-plan price is injected "
                              "client-side, so figures were confirmed from two independent secondary trackers. "
                              "Re-checked 4 Nov 2026: Business Standard/Premium seats and a $100 tier are "
                              "unpriced in static HTML.",
    "tencent-coding-plan": "Token Plan Personal Edition (Singapore): Lite $7, Standard $17, Pro $51, Max $103/month "
                           "with monthly credit pools. Four tier plans verified; the generic entry is kept "
                           "unpriced for existing selections.",
    "volcengine-coding-plan": "Ark docs list an Agent/Coding Plan subscription section but publish no Coding Plan "
                              "price; pricing is console-gated.",
    "x-subscription-pricing": "X Subscription docs pricing: five individual tiers, per-seat Teams, custom "
                              "Enterprise. Usage pools refresh weekly; API usage bills separately. Existing "
                              "SuperGrok plans continue; no tier equivalence. Corroborated by x.ai/pricing.",
    "opencode-go-plan": "Separate subscription route from OpenCode Zen, with its own plans.",
}


def build(plans_doc: dict) -> dict:
    cited: dict[str, set[str]] = {}
    for plan in plans_doc["plans"]:
        for sid in (plan["verification"].get("source_id"),
                    (plan["entitlements"].get("verification") or {}).get("source_id")):
            if sid:
                cited.setdefault(str(sid), set()).add(plan["id"])

    rows = []
    for source in plans_doc["sources"]:
        sid = source["id"]
        adapter, family, complete = ADAPTER.get(sid, ("manual", None, False))
        alias = ALIAS.get(sid)
        live = LIVE.get(sid, {})
        status = source.get("status") or "not_fetched"
        retrieved = live.get("retrieved_at") or source.get("retrieved_at")
        if retrieved and str(retrieved) > datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"):
            # A future timestamp cannot be evidence of a completed retrieval.
            retrieved = None
        row = {
            "id": sid,
            "family": family or FAMILY_HINTS.get(sid),
            "url": source["url"],
            "fetched_url": live.get("fetched_url") or source["url"],
            "status": status,
            "retrieved_at": retrieved,
            "http_status": live.get("http_status", source.get("http_status")),
            "evidence_kind": KIND.get(sid, "product_page"),
            "adapter": adapter,
            "parsed": adapter != "manual",
            "complete": bool(complete) or sid in COMPLETE,
            "cited_by": sorted(cited.get(sid, set())),
            "notes": NOTES.get(sid, source.get("notes", "")),
        }
        if CUSTOM_QUOTE.get(sid):
            row["custom_quote_plans"] = list(CUSTOM_QUOTE[sid])
        if alias:
            row["alias_of"] = alias[0]
            row["notes"] = f"{row['notes']} Alias of {alias[0]}: {alias[1]}.".strip()
        if row["evidence_kind"] not in KINDS:
            raise SystemExit(f"{sid}: unknown evidence kind {row['evidence_kind']!r}")
        rows.append(row)

    rows.sort(key=lambda r: r["id"])
    return {
        "version": 2,
        "generated_at": "2026-11-04T10:59:31Z",
        "notes": [
            "One row per source the catalogue cites. A row is evidence provenance, not coverage: "
            "'parsed' is true only where an adapter exists.",
            "evidence_kind is closed: price_page, token_price_page, product_page, docs_only, "
            "balance_api, aggregator, cannot_price.",
            "'complete' means the page enumerates the whole family, so a missing plan is evidence "
            "of removal; otherwise a missing plan is ambiguous.",
            "retrieved_at is null when the page was not read in this pass. It is never back-dated "
            "or forward-dated to look tidier.",
        ],
        "sources": rows,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--write", action="store_true", help="write catalogue/sources.json")
    args = parser.parse_args()
    plans_doc = json.loads((CATALOGUE / "plans.json").read_text())
    register = build(plans_doc)
    rows = register["sources"]
    cited = set()
    for plan in plans_doc["plans"]:
        for sid in (plan["verification"].get("source_id"),
                    (plan["entitlements"].get("verification") or {}).get("source_id")):
            if sid:
                cited.add(str(sid))
    print(f"{len(rows)} sources · {sum(1 for r in rows if r['parsed'])} parsed · "
          f"{sum(1 for r in rows if r['cited_by'])} cited by plans")
    from collections import Counter
    print("kinds:", dict(Counter(r["evidence_kind"] for r in rows)))
    missing = cited - {r["id"] for r in rows}
    if missing:
        print("ERROR unresolved citations:", sorted(missing))
        return 1
    if args.write:
        (CATALOGUE / "sources.json").write_text(
            json.dumps(register, indent=2, sort_keys=True, ensure_ascii=False) + "\n")
        print("written catalogue/sources.json")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
