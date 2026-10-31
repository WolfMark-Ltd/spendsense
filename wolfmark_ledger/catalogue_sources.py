"""Source register, fetchers and parsers for catalogue maintenance.

A *source* is a URL we trust for one family's commercial terms. A *snapshot* is
what that URL returned at a moment. An *observation* is the normalised plan set
parsed out of a snapshot. Only observations are compared with the approved
catalogue — never a model's memory of a price.

Fetching is deliberately boring and offline-capable: the same parser runs against
a saved fixture in tests and against a live response in a manual check. Nothing
here schedules itself.
"""

from __future__ import annotations

import hashlib
import json
import re
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping, Optional

from .catalogue_money import (MONEY_TOKEN, amounts_in, html_rows, money, slug, table_by_headers,
                              text_of)

ROOT = Path(__file__).resolve().parent.parent
SOURCES_PATH = ROOT / "catalogue" / "sources.json"

USER_AGENT = "WolfMarkCatalogueCheck/1.0 (+https://wolfmark.co.uk)"
FETCH_TIMEOUT = 20.0


# ---------------------------------------------------------------------------
# Register
# ---------------------------------------------------------------------------

def sources_path(path: Optional[Path | str] = None) -> Path:
    return Path(path) if path else SOURCES_PATH


def load_sources(path: Optional[Path | str] = None) -> dict[str, Any]:
    target = sources_path(path)
    if not target.exists():
        return {"version": 1, "sources": [], "error": f"no source register at {target}"}
    try:
        data = json.loads(target.read_text())
    except (OSError, ValueError) as exc:
        return {"version": 1, "sources": [], "error": f"source register unreadable: {type(exc).__name__}"}
    rows = [s for s in (data.get("sources") or []) if isinstance(s, dict) and s.get("id")]
    return {"version": int(data.get("version") or 1), "sources": rows, "error": ""}


def sources_for(family: str, register: Mapping[str, Any] | None = None) -> list[dict[str, Any]]:
    fam = str(family or "").strip().lower()
    return [s for s in (register or load_sources()).get("sources", []) if str(s.get("family")) == fam]


# ---------------------------------------------------------------------------
# Fetch
# ---------------------------------------------------------------------------

def fetch(source: Mapping[str, Any], *, offline_dir: Optional[Path | str] = None) -> dict[str, Any]:
    """Return a snapshot for one source.

    ``offline_dir`` reads ``<source id>.<ext>`` instead of the network, which is
    how tests and the demonstration run. A fetch failure is data: it becomes a
    snapshot with ``status: "error"``, never an exception the caller must guess at.
    """
    sid = str(source.get("id"))
    now = datetime.now(timezone.utc).isoformat()
    if offline_dir:
        root = Path(offline_dir)
        bases = [root, root / "sources"]
        for base in bases:
            for suffix in (".txt", ".html", ".json", ".md"):
                candidate = base / f"{sid}{suffix}"
                if not candidate.exists():
                    continue
                body = candidate.read_text(encoding="utf-8")
                return {"source_id": sid, "url": source.get("url"),
                        "retrieved_at": source.get("retrieved_at") or now,
                        "http_status": 200, "status": "fixture", "sha256": _sha(body), "body": body}
        return {"source_id": sid, "url": source.get("url"), "retrieved_at": now, "http_status": None,
                "status": "missing_fixture", "sha256": None, "body": ""}
    if str(source.get("status")) == "not_fetched":
        return {"source_id": sid, "url": source.get("url"), "retrieved_at": None, "http_status": None,
                "status": "not_fetched", "sha256": None, "body": ""}
    request = urllib.request.Request(str(source.get("url")), headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(request, timeout=FETCH_TIMEOUT) as response:
            raw = response.read()
            body = raw.decode("utf-8", errors="replace")
            return {"source_id": sid, "url": source.get("url"), "retrieved_at": now,
                    "http_status": getattr(response, "status", 200), "status": "fetched",
                    "sha256": _sha(body), "body": body}
    except (urllib.error.URLError, OSError, ValueError) as exc:
        return {"source_id": sid, "url": source.get("url"), "retrieved_at": now, "http_status": None,
                "status": "error", "sha256": None, "body": "", "error": f"{type(exc).__name__}: {exc}"}


def _sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


# ---------------------------------------------------------------------------
# Parsers
# ---------------------------------------------------------------------------

def _table_rows(body: str) -> list[list[str]]:
    """Cells of every table row, Markdown pipes or HTML ``<tr>``.

    Vendor pages come in both shapes: the docs sites serve HTML tables, while a
    text extraction of the same page is a pipe table. One parser reads both, so
    the fixture and the live fetch exercise the same code path.
    """
    rows = []
    for line in body.splitlines():
        stripped = line.strip()
        if not stripped.startswith("|") or stripped.count("|") < 3:
            continue
        cells = [c.strip() for c in stripped.strip("|").split("|")]
        if all(set(c) <= set("-: ") and c for c in cells):
            continue
        rows.append(cells)
    if rows:
        return rows
    return html_rows(body)


def _money(text: str) -> Optional[float]:
    found = money(text)
    return found["amount"] if found else None


def _slug(text: str) -> str:
    return slug(text)


def _price(fragment: str, *, period: str = "month", per_unit: Optional[str] = None) -> Optional[dict[str, Any]]:
    found = money(fragment)
    if not found:
        return None
    price = {"amount": found["amount"], "currency": found.get("currency", "USD"), "period": period}
    if found.get("ambiguous_currency"):
        # A bare ¥ is used for both JPY and CNY. Record the amount, refuse the
        # currency: a caller must not compare this to a recorded CNY price.
        price["currency"] = None
        price["ambiguous_currency"] = found["ambiguous_currency"]
    if per_unit:
        price["per_unit"] = per_unit
    return price


def _is_floor(cell: str) -> bool:
    """True for cells that state a minimum rather than a price ("$5,000+")."""
    return "+" in str(cell or "") or str(cell or "").strip().lower().startswith("from ")


def _row(plan_id: str, name: str, price: Optional[dict[str, Any]], **extra: Any) -> dict[str, Any]:
    row = {"id": plan_id, "name": name, "price": price or {"amount": None, "currency": None,
                                                          "period": "month"}}
    row.update(extra)
    return row


def _signals(text: str, assigned: set[str]) -> list[str]:
    """Price-shaped strings the parser did not account for.

    Reported to a human when the strict anchors fail, so a redesigned page shows
    up as "unparsed movement" rather than as silence.
    """
    seen, out = set(), []
    for value in amounts_in(text):
        if value in seen or value in assigned:
            continue
        seen.add(value)
        out.append(value)
    return out[:8]


def _plan_table_rows(body: str) -> list[list[str]]:
    """Rows of the first table whose header begins with a "Plan" cell.

    A pricing page carries several tables (model rates, credit limits). Only the
    plan table describes plans, so parsing stops at the next header row.
    """
    rows = _table_rows(body)
    out: list[list[str]] = []
    in_plan_table = False
    for row in rows:
        header = bool(row) and row[0].strip().lower() in ("plan", "plans")
        if header:
            # A page can carry several plan tables (individual, team). Every one
            # of them describes plans, so all are read; a header row is not.
            in_plan_table = True
            continue
        if in_plan_table:
            out.append(row)
    return out


def parse_opencode_go(body: str) -> dict[str, Any]:
    """OpenCode Go plan table: | **Go** | **$10/month** | … |"""
    plans = []
    for cells in _plan_table_rows(body):
        name = cells[0].replace("*", "").strip()
        if name.lower() not in {"go", "go plus", "go teams"}:
            continue
        price = _price(cells[1] if len(cells) > 1 else "")
        if not price:
            continue
        plans.append(_row(f"opencode-go.{_slug(name)}", name, price,
                          per_member="member" in " ".join(cells).lower(),
                          summary=cells[2] if len(cells) > 2 else ""))
    return {"family": "opencode-go", "plans": plans,
            "complete": bool(plans), "note": "Parsed from the Go plan table."}


def parse_commandcode(body: str) -> dict[str, Any]:
    """CommandCode pricing table: | Go | $1 | $10 | ~9K requests | … |"""
    known = {"go", "goat", "pro", "provider", "max 10×", "max 10x", "max 20×", "max 20x",
             "team pro", "enterprise"}
    plans = []
    for cells in _plan_table_rows(body):
        name = cells[0].replace("*", "").strip()
        if name.lower() not in known:
            continue
        cell = cells[1] if len(cells) > 1 else ""
        if _is_floor(cell):
            # "from $5,000" is a floor, not a monthly price. Recording 5000 would
            # make a quote look like a fixed fee.
            plans.append(_row(f"commandcode.{_slug(name)}", name, None,
                              price_floor=cell.strip(),
                              summary=cells[3] if len(cells) > 3 else ""))
            continue
        plans.append(_row(f"commandcode.{_slug(name)}", name, _price(cell),
                          monthly_credits_hint=cells[2] if len(cells) > 2 else "",
                          summary=cells[3] if len(cells) > 3 else ""))
    # A page may repeat a plan in a second table (limits, model access). The
    # first description of a plan wins.
    seen: set[str] = set()
    plans = [row for row in plans if not (row["id"] in seen or seen.add(row["id"]))]
    return {"family": "commandcode", "plans": plans, "complete": bool(plans),
            "note": "Parsed from the pricing table; a custom price stays None."}


# --- Ollama -----------------------------------------------------------------
# The page no longer uses a plan table: prices sit in cards and the tab control
# repeats a neighbouring plan's price. Anchors are therefore copied phrases that
# do not contain the amount, so a price change is still detected.
_OLLAMA = {
    "pro": ("Pro", rf"({MONEY_TOKEN})\s*/\s*mo\.?\s*or\s*{MONEY_TOKEN}\s*/\s*yr"),
    "max": ("Max", rf"({MONEY_TOKEN})\s*/\s*mo\.?\s*For power users"),
    "team": ("Team", rf"({MONEY_TOKEN})\s*/\s*mo\.?\s*For teams scaling"),
}


def parse_ollama(body: str) -> dict[str, Any]:
    text = text_of(body)
    plans, missing, assigned = [], [], set()
    for key, (name, pattern) in _OLLAMA.items():
        match = re.search(pattern, text)
        if not match:
            missing.append(name)
            continue
        assigned.add(match.group(1).replace(" ", ""))
        plans.append(_row(f"ollama-cloud.{key}", name, _price(match.group(1))))
    return {
        "family": "ollama-cloud",
        "plans": plans,
        # A card we cannot read means the page changed shape, so absence of a
        # plan proves nothing.
        "complete": not missing,
        "signals": _signals(text, assigned) if missing else [],
        "note": (f"card anchors not found for {', '.join(missing)}" if missing
                 else "Parsed the Pro, Max and Team card prices."),
    }


# --- Hugging Face -----------------------------------------------------------
_HF_CARDS = {
    "pro": ("PRO", rf"PRO\s+Account.{{0,200}}?({MONEY_TOKEN})\s*/\s*month(?!\s*per user)", None),
    "team": ("Team", rf"Team.{{0,220}}?({MONEY_TOKEN})\s*/\s*month\s*per user", "user"),
    "enterprise": ("Enterprise",
                   rf"Enterprise.{{0,240}}?({MONEY_TOKEN})\s*/\s*month\s*per user", "user"),
}


def parse_huggingface(body: str) -> dict[str, Any]:
    text = text_of(body)
    plans, missing, assigned = [], [], set()
    for key, (name, pattern, unit) in _HF_CARDS.items():
        match = re.search(pattern, text)
        if not match:
            missing.append(name)
            continue
        assigned.add(match.group(1).replace(" ", ""))
        plans.append(_row(f"huggingface.{key}", name, _price(match.group(1), per_unit=unit)))
    return {
        "family": "huggingface",
        "plans": plans,
        "complete": not missing,
        "signals": _signals(text, assigned) if missing else [],
        "note": (f"card anchors not found for {', '.join(missing)}" if missing
                 else "Parsed the PRO, Team and Enterprise card prices."),
    }


# --- Kilo Code --------------------------------------------------------------
def parse_kilocode(body: str) -> dict[str, Any]:
    rows = table_by_headers(body, ["Individual", "Teams", "Enterprise"])
    header = rows[0] if rows else []
    platform = next((r for r in rows if r and r[0].strip().lower().startswith("platform plan")), None)
    if not platform:
        return {"family": "kilocode", "plans": [], "complete": False,
                "signals": _signals(text_of(body), set()),
                "note": "the platform-plan row was not found"}
    plans, quoted = [], []
    for index, label in enumerate(header[1:], start=1):
        if index >= len(platform):
            continue
        cell = platform[index]
        key = _slug(label)
        if not cell or cell.strip().lower() in ("custom", "contact us", "—", "-"):
            # Sold by quote. Cataloguing a placeholder for every "contact us"
            # tier would inflate the unpriced count without telling anyone
            # anything, so the tier is named in the note instead.
            quoted.append(label)
            continue
        unit = "user" if "user" in cell.lower() else None
        price = _price(cell, per_unit=unit)
        if price and price["amount"] == 0:
            # A free platform tier is not a subscription to track.
            continue
        plans.append(_row(f"kilocode.{key}", label, price))
    note = "Parsed the platform-plan row; inference stays at provider rates."
    if quoted:
        note += f" Sold by quote, not catalogued: {', '.join(quoted)}."
    return {"family": "kilocode", "plans": plans, "complete": bool(plans), "note": note}


ADAPTERS: dict[str, Callable[[str], dict[str, Any]]] = {
    "opencode_go": parse_opencode_go,
    "commandcode_pricing": parse_commandcode,
    "ollama_pricing": parse_ollama,
    "huggingface_pricing": parse_huggingface,
    "kilocode_pricing": parse_kilocode,
}


def observe(snapshot: Mapping[str, Any], source: Mapping[str, Any]) -> dict[str, Any]:
    """Turn a snapshot into observations, or explain why we cannot."""
    sid = str(source.get("id"))
    state = str(snapshot.get("status"))
    base = {"source_id": sid, "url": source.get("url"), "retrieved_at": snapshot.get("retrieved_at"),
            "http_status": snapshot.get("http_status"), "snapshot_status": state,
            "sha256": snapshot.get("sha256"), "family": source.get("family"), "complete": False,
            "plans": [], "notes": []}
    if state not in ("fetched", "fixture"):
        base["notes"].append(f"source not read ({state})")
        base["usable"] = False
        return base
    adapter_name = str(source.get("adapter") or "")
    adapter = ADAPTERS.get(adapter_name)
    if adapter is None:
        # A page we can fetch but cannot parse reliably is a manual-review item,
        # not an excuse to guess at values.
        base["notes"].append(f"no parser for adapter {adapter_name!r}; review by hand")
        base["usable"] = False
        return base
    parsed = adapter(str(snapshot.get("body") or ""))
    complete = bool(source.get("complete")) and bool(parsed.get("complete"))
    base.update({"plans": parsed.get("plans") or [], "complete": complete,
                 "note": parsed.get("note") or "",
                 "custom_quote_plans": [str(x) for x in (source.get("custom_quote_plans") or [])]})
    base["usable"] = bool(base["plans"])
    if base["custom_quote_plans"]:
        base["notes"].append("custom-quoted plans are not in the table: "
                             + ", ".join(base["custom_quote_plans"]))
    if str(source.get("status")) != "fetched":
        base["notes"].append(f"register marks this source {source.get('status')!r}; values are provisional")
        base["provisional"] = True
    return base
