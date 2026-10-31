#!/usr/bin/env python3
"""Catalogue coverage audit for the membership redesign.

Reports, per subscription-capable provider family, how many plans the catalogue
carries and how well each is priced — and keeps that distinct from a *working
integration*.

Three different things are reported separately, because a catalogue row is none
of the others:

* **Entry** — a plan identity with price, cycle and entitlements.
* **Verified price** — a non-null amount, ``verification.status == "verified"``,
  plus ``checked_at`` and ``source_id``.
* **Integration** — discovery of the account, a selected plan, an effective fee,
  a quota source, a persisted membership and an endpoint the pane reads.

Prints a Markdown table; ``--check`` asserts the invariants and exits non-zero on
violation. ``--json`` emits the same rows for a test to pin. No network, no
credentials, no writes.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from wolfmark_ledger import membership as M  # noqa: E402

#: Hermes 0.22.5 native account-usage support, from `agent/account_usage.py`
#: (`_USAGE_FETCHERS`) plus the Nous portal credits path and the OpenCode Zen
#: provider hook. Verified against the installed build on 2026-10-30:
#: `hermes usage --provider openai-codex --json` returns plan + 5h/7d windows;
#: `--provider openrouter` returns a credits balance and key quota;
#: `--provider commandcode` exits non-zero (no fetcher, no endpoint).
NATIVE = {
    "openai-codex": "yes — plan, 5h/weekly windows, identity",
    "anthropic": "yes — 5h/7d + model-scoped windows",
    "openrouter": "partial — credits balance, key quota (not a subscription)",
    "nous": "partial — portal credits gauge",
    "opencode-zen": "unverified — provider hook exists, unexercised",
    "opencode-go": "unverified — subscription route, usage endpoint not exercised",
    "commandcode": "none — confirmed 2026-10-30 (no usage endpoint)",
    "github-copilot": "none — credits only, no windows",
}

#: Every family the audit covers, in architecture order. Group 9 is the
#: coding-plan cohort: catalogue-only until a credential exists on a host.
EXPECTED = [
    ("1", "openai-codex"),
    ("2", "anthropic"),
    ("3", "commandcode"),
    ("4", "xai-oauth"),
    ("5", "github-copilot"),
    ("6", "nous"),
    ("7", "openrouter"),
    ("8", "opencode-zen"),
    ("8", "opencode-go"),
    ("9", "zai-coding-plan"),
    ("9", "minimax-coding-plan"),
    ("9", "kimi-code-plan-global"),
    ("9", "alibaba-coding-plan"),
    ("9", "tencent-coding-plan"),
    ("9", "volcengine-coding-plan"),
    ("9", "cline-pass"),
    ("9", "umans-ai-coding-plan"),
    ("9", "ollama-cloud"),
    ("9", "huggingface"),
    ("9", "kilocode"),
]

#: What the shipped slice actually wires, per family. Updated by hand when an
#: adapter lands — a catalogue row never implies one.
SLICE = {
    "openai-codex": "discovery, plan, fee, native quota, manual quota",
    "anthropic": "discovery, plan, fee, native quota¹, manual quota",
    "openrouter": "discovery, fee, manual quota (credits, not a plan)",
    "nous": "discovery, fee, manual quota (credits, not a plan)",
    "opencode-zen": "discovery, plan, fee, manual quota (hook unexercised)",
    "opencode-go": "discovery, plan, fee, manual quota (catalogue-only here)",
}
DEFAULT_SLICE = "discovery, plan, fee, manual quota"


#: Evidence kinds that can establish a subscription price. A verified price
#: resting on documentation or a balance endpoint is a provenance defect.
PRICE_KINDS = {"price_page"}
BALANCE_KINDS = {"balance_api", "token_price_page"}


def audit(catalogue: dict) -> tuple[list[dict], list[str]]:
    by_family: dict[str, dict] = {}
    problems: list[str] = []
    families = {p["provider_family"] for p in catalogue["plans"]}
    source_ids = {str(s.get("id")) for s in catalogue.get("sources") or [] if isinstance(s, dict)}
    register = {}
    register_path = Path(ROOT) / "catalogue" / "sources.json"
    if register_path.exists():
        register = {str(s.get("id")): s for s in
                    (json.loads(register_path.read_text()).get("sources") or []) if isinstance(s, dict)}

    for group, family in EXPECTED:
        if family not in families:
            problems.append(f"{family} is listed in the audit but absent from the catalogue")
            continue
        plans = [p for p in catalogue["plans"] if p["provider_family"] == family]
        verified = [p for p in plans if p["price"]["amount"] is not None
                    and p["verification"]["status"] == "verified"]
        provisional = [p for p in plans if p["price"]["amount"] is not None
                       and p["verification"]["status"] == "provisional"]
        placeholders = [p for p in plans if p["price"]["amount"] is None]
        for plan in verified:
            if not plan["verification"].get("checked_at") or not plan["verification"].get("source_id"):
                problems.append(f"{plan['id']} claims a verified price without a check date or source")
        for plan in plans:
            if not plan["route_slugs"]:
                problems.append(f"{plan['id']} has no route slugs, so discovery cannot match it")
        # A placeholder-only *subscription* family must not smuggle a verified
        # entitlement. Credits/prepaid arrangements legitimately have no default
        # fee while their balance reporting is verified.
        subscription_only = all(p["kind"] == "subscription" for p in plans)
        if not verified and subscription_only and any(
                (p["entitlements"].get("verification") or {}).get("status") == "verified" for p in plans):
            problems.append(f"{family} carries a verified entitlement on an unverified price")
        for plan in plans:
            source = (plan["verification"].get("source_id")
                      or (plan["entitlements"].get("verification") or {}).get("source_id"))
            if source and source not in source_ids:
                problems.append(f"{plan['id']} cites unknown source {source!r}")
            kind = (register.get(source) or {}).get("evidence_kind")
            if kind and plan["price"]["amount"] is not None and plan["verification"]["status"] == "verified":
                if plan["kind"] == "subscription" and kind not in PRICE_KINDS:
                    problems.append(f"{plan['id']} claims a verified subscription price from a "
                                    f"{kind} source ({source})")
                if plan["kind"] != "subscription" and kind not in (PRICE_KINDS | BALANCE_KINDS):
                    problems.append(f"{plan['id']} claims a verified price from a {kind} source ({source})")
        if verified:
            verdict = "verified prices" if not placeholders else "verified, with placeholders"
        elif provisional:
            verdict = "provisional only"
        else:
            verdict = "placeholders only"
        windows = sum(1 for p in plans if p["entitlements"]["windows"])
        by_family[family] = {
            "group": group,
            "family": family,
            "plans": len(plans),
            "verified": len(verified),
            "provisional": len(provisional),
            "placeholders": len(placeholders),
            "native": NATIVE.get(family, "none"),
            "verdict": verdict,
            "kinds": sorted({p["kind"] for p in plans}),
            "windows": windows,
            "slice": SLICE.get(family, DEFAULT_SLICE),
            # The readiness chain, in architecture order. "endpoint" and
            # "persisted" are slice-wide, so they are counted once.
            "chain": [bool(plans), bool(verified), windows > 0,
                      bool(NATIVE.get(family, "").startswith(("yes", "partial")))],
        }

    unknown = families - {f for _, f in EXPECTED}
    for family in sorted(unknown):
        problems.append(f"{family} is in the catalogue but not in the audit list")
    return [by_family[f] for _, f in EXPECTED if f in by_family], problems


def render(rows: list[dict]) -> str:
    out = ["| Group | Family | Plans | Verified | Provisional | Placeholder | Windows | Hermes native usage | Catalogue verdict |",
           "|---|---|---:|---:|---:|---:|---:|---|---|"]
    for r in rows:
        out.append(f"| {r['group']} | `{r['family']}` | {r['plans']} | {r['verified']} | "
                   f"{r['provisional']} | {r['placeholders']} | {r['windows']} | {r['native']} | {r['verdict']} |")
    total = sum(r["plans"] for r in rows)
    out.append("")
    out.append(f"Totals: {total} plans across {len(rows)} families · "
               f"{sum(r['verified'] for r in rows)} verified prices · "
               f"{sum(r['provisional'] for r in rows)} provisional · "
               f"{sum(r['placeholders'] for r in rows)} placeholders.")
    native = sum(1 for r in rows if r["native"].startswith(("yes", "partial")))
    out.append(f"Hermes-native usage available for {native} of {len(rows)} families; "
               f"the rest are catalogue-only or manual.")
    return "\n".join(out)


def main() -> int:
    catalogue = M.load_plan_catalogue(ROOT / "catalogue" / "plans.json")
    rows, problems = audit(catalogue)
    if "--json" in sys.argv:
        print(json.dumps({"catalogue_version": catalogue.get("catalogue_version"),
                          "rows": rows, "problems": problems}, indent=2))
    else:
        print(render(rows))
    if "--check" in sys.argv:
        if problems:
            print("\nFAIL")
            for problem in problems:
                print(" -", problem)
            return 1
        print("\nPASS — families, sources and placeholders are consistent")
    return 0


if __name__ == "__main__":
    sys.exit(main())
