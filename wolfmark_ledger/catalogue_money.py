"""Currency-aware money parsing and the HTML text helpers the parsers share.

Vendors print prices in their own currency. Nothing here converts: a CNY price
stays CNY, an ambiguous symbol becomes an unrecorded currency rather than a
guessed one, and a parser that cannot read a page returns no plans instead of a
plausible-looking one.
"""

from __future__ import annotations

import re
from html.parser import HTMLParser
from typing import Any, Optional

#: Symbol → currency. Only unambiguous symbols are mapped. A bare ¥ is used for
#: both JPY and CNY, so it is deliberately absent: see ``_money``.
SYMBOLS = {
    "$": "USD", "US$": "USD", "USD": "USD",
    "£": "GBP", "GBP": "GBP",
    "€": "EUR", "EUR": "EUR",
    "CN¥": "CNY", "RMB": "CNY",
    "A$": "AUD", "C$": "CAD", "CHF": "CHF", "₹": "INR",
}

_YEN = "¥"

#: Regex source for one price token, shared by the card parsers so a page that
#: prices in yuan is read the same way as one that prices in dollars.
MONEY_TOKEN = r"(?<![A-Za-z])(?:US\$|CN¥|RMB|A\$|C\$|CHF|USD|GBP|EUR|₹|\$|£|€|¥)\s?[0-9][0-9,]*(?:\.[0-9]+)?"

#: ``$1,234.56`` / ``US$20`` / ``CN¥ 49`` / ``£9.99`` / ``RMB99``
_MONEY = re.compile(
    r"(?<![A-Za-z])(US\$|CN¥|RMB|A\$|C\$|CHF|USD|GBP|EUR|₹|\$|£|€)\s?"
    r"([0-9][0-9,]*(?:\.[0-9]+)?)"
)
_YEN_RE = re.compile(r"(" + _YEN + r")\s?([0-9][0-9,]*(?:\.[0-9]+)?)")
_BARE = re.compile(r"(?<![A-Za-z0-9])([0-9][0-9,]*(?:\.[0-9]+)?)")

_TAG = re.compile(r"<[^>]+>")
_WS = re.compile(r"\s+")


class _Text(HTMLParser):
    """Visible text of a fragment. Script and style bodies are skipped, and a
    stray ``<`` in inline JavaScript cannot swallow the rest of the page."""

    SKIP = {"script", "style"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.skipping = False

    def handle_starttag(self, tag, attrs):
        if str(tag).lower() in self.SKIP:
            self.skipping = True

    def handle_endtag(self, tag):
        if str(tag).lower() in self.SKIP:
            self.skipping = False

    def handle_data(self, data):
        if not self.skipping:
            self.parts.append(data)


def text_of(html: str) -> str:
    """Visible text of a fragment, whitespace collapsed."""
    raw = str(html or "")
    parser = _Text()
    try:
        parser.feed(raw)
        parser.close()
        text = " ".join(parser.parts)
    except Exception:  # malformed markup is data, not a crash
        text = ""
    if not text.strip():
        # A fragment that begins inside a <script> never leaves it. Fall back to
        # a blunt strip rather than returning nothing.
        text = _TAG.sub(" ", raw)
    return _WS.sub(" ", text).strip()


def money(text: str) -> Optional[dict[str, Any]]:
    """First price in ``text`` as ``{amount, currency}``.

    ``currency`` is ``None`` when the page prints a symbol that means more than
    one currency (a bare ``¥``). The caller must treat that as "amount known,
    currency unresolved" and refuse to compare it with a recorded price, rather
    than assuming the most convenient currency.
    """
    raw = str(text or "")
    match = _MONEY.search(raw)
    if match:
        symbol, digits = match.group(1), match.group(2)
        return {"amount": _amount(digits), "currency": SYMBOLS.get(symbol, symbol)}
    yen = _YEN_RE.search(raw)
    if yen:
        return {"amount": _amount(yen.group(2)), "currency": None, "ambiguous_currency": "¥"}
    return None


def _amount(digits: str) -> float:
    return float(str(digits).replace(",", ""))


def amounts_in(text: str) -> list[str]:
    """Price-shaped strings, for reporting unparsed movement to a human."""
    raw = str(text or "")
    found = [_MONEY_PREFIXED(m) for m in _MONEY.finditer(raw)]
    found += [_YEN_PREFIXED(m) for m in _YEN_RE.finditer(raw)]
    return [f for f in found if f]


def _MONEY_PREFIXED(match: re.Match[str]) -> str:
    return f"{match.group(1)}{match.group(2)}"


def _YEN_PREFIXED(match: re.Match[str]) -> str:
    return f"{match.group(1)}{match.group(2)}"


def html_rows(html: str) -> list[list[str]]:
    """Cell text of every ``<tr>`` in the fragment."""
    rows: list[list[str]] = []
    for row in re.findall(r"<tr[^>]*>(.*?)</tr>", str(html or ""), re.S | re.I):
        cells = [text_of(c) for c in re.findall(r"<t[dh][^>]*>(.*?)</t[dh]>", row, re.S | re.I)]
        if cells:
            rows.append(cells)
    return rows


def table_by_headers(html: str, headers: list[str]) -> list[list[str]]:
    """Rows of the first table whose header cell set contains every header."""
    for row in html_rows(html):
        joined = " ".join(c.lower() for c in row)
        if all(h.lower() in joined for h in headers):
            rows = [row]
            # Collect the rows that follow this header until the table ends.
            start = str(html or "").find("<tr")
            all_rows = html_rows(html)
            index = all_rows.index(row)
            return all_rows[index:]
    return []


def slug(text: str) -> str:
    """Vendor label → catalogue id fragment ("Max 10×" → "max-10x")."""
    return re.sub(r"[^a-z0-9]+", "-", str(text).strip().lower().replace("×", "x")).strip("-")
