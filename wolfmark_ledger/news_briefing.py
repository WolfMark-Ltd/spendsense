"""Deterministic editorial layer for Model News.

Curation happens **once**, globally, over the shared verified event list: the
same briefing is published to every client and then filtered or ranked locally
for For You using that profile's configured providers, plans and recent model
usage. Nothing here performs per-user analysis or inference.

Three rules shape this module:

* **No invented facts.** Every entry is derived from fields the feed already
  carries (provider, exact model id, previous/current rates, observed_at,
  source_url, confidence). A percentage is only printed when both sides of a
  comparable rate are published and the baseline is non-zero.
* **A category is not a lifecycle.** ``category`` stays the v1 compatibility
  field (``new_model``, ``price_reduction``, ``price_increase``,
  ``subscription``). ``event_type`` is the editorial taxonomy and is allowed to
  disagree with it: a rate change that cuts one rate and raises another is
  ``price_mixed`` even though its v1 category is whichever direction the
  input+output total took.
* **Presentation grouping never merges identity.** Model families group
  headlines for scanning; each variant keeps its exact provider and model id,
  and events are never fused or averaged.

Everything in this module is pure: no I/O, no network, no clock reads.
"""

from __future__ import annotations

import math
import re
from datetime import datetime, timedelta, timezone
from typing import Any, Iterable, Mapping, Optional

BRIEFING_VERSION = 1

#: Rate keys in a feed ``rateBlock``, in a stable presentation order.
RATE_KEYS = ("input", "output", "cache_read", "cache_write")

#: Message codes for the four comparable rate types.
RATE_CODE = {
    "input": "news_rate_input",
    "output": "news_rate_output",
    "cache_read": "news_rate_cache_read",
    "cache_write": "news_rate_cache_write",
}

#: Editorial taxonomy. ``category`` remains the v1 field; this is richer.
EVENT_TYPES = (
    "price_reduction",
    "price_increase",
    "price_mixed",
    "new_to_catalogue",
    "newly_available",
    "provider_listed",
    "removed_from_provider",
    "provider_delisted",
    "new_plan",
    "plan_change",
    "unknown",
)

#: How long a confirmed removal keeps appearing in the briefing. History keeps
#: the record; the headline surface only shows recent news.
REMOVAL_WINDOW_DAYS = 90

#: Event types that belong in the removals section, from either source.
REMOVAL_EVENT_TYPES = ("removed_from_provider", "provider_delisted")

#: Signals that annotate an event without replacing its event type.
SIGNAL_PREVIEW = "preview"

#: A ranked "biggest change" section only accepts an event whose dominant rate
#: moves by at least this percentage. Everything below it stays in All Updates
#: and is counted, never headlined. Owner sign-off pending (WP22).
MIN_ABS_PCT = 2.0

#: …and whose materially largest rate moves by at least this many USD per 1M
#: tokens. Both floors apply, so a 1 850% move on a sub-cent cache rate cannot
#: outrank a real input-price change. Owner sign-off pending (WP22).
MIN_ABS_DELTA = 0.005

#: Cap per section and on the total number of briefing entries.
SECTION_LIMIT = 8
MAX_ENTRIES = 400

_PREVIEW = re.compile(
    r"(?:^|[\s\-_/:.])(preview|experimental|exp|alpha|beta|stealth|anonymous|"
    r"anon|unreleased|internal|canary)(?:$|[\s\-_/:.]|\d)",
    re.IGNORECASE,
)

_SEPARATOR = re.compile(r"[\s_]+")
_COLON = re.compile(r":+")

#: Cosmetic brand casing. Labels are display-only and never feed identity.
_BRAND = {
    "ai": "AI", "glm": "GLM", "gpt": "GPT", "hy": "HY", "llm": "LLM",
    "mimo": "MiMo", "oss": "OSS", "phi": "Phi",
    "claude": "Claude", "deepseek": "DeepSeek", "gemini": "Gemini",
    "gemma": "Gemma", "grok": "Grok", "kimi": "Kimi", "llama": "Llama",
    "minimax": "MiniMax", "nemotron": "Nemotron", "openai": "OpenAI",
    "qwen": "Qwen", "sonnet": "Sonnet", "opus": "Opus", "haiku": "Haiku",
    "flash": "Flash", "fast": "Fast", "preview": "Preview", "pro": "Pro",
    "nano": "Nano", "mini": "Mini", "coder": "Coder", "max": "Max",
}

#: Suffixes that name a presentation variant of one model, not a new model.
_VARIANT_SUFFIXES = frozenset({"thinking", "flex", "fast", "standard", "default"})

#: Event weight for ranking. Editorial defaults, not measured truth.
_EVENT_WEIGHT = {
    "price_reduction": 3.0,
    "price_increase": 3.2,
    "price_mixed": 3.4,
    "new_to_catalogue": 2.2,
    "newly_available": 1.4,
    "provider_listed": 0.4,
    "removed_from_provider": 3.6,
    "provider_delisted": 2.4,
    "new_plan": 2.8,
    "plan_change": 3.0,
    "unknown": 0.5,
}


# ------------------------------------------------------------------ identity

def model_family(model: Any) -> str:
    """Presentation family for a model id, or ``""`` when there is none.

    A leading ``vendor/`` namespace is dropped, separators are normalised and
    a known presentation-variant suffix is removed. Distinct versions stay
    distinct: ``kimi-k3`` and ``kimi-k3.1-pro`` are different families, while
    ``gemma-4-26b-a4b-it`` and ``gemma-4-26b-a4b-it:thinking`` share one.
    """
    text = str(model or "").strip().lower()
    if not text:
        return ""
    if "/" in text:
        text = text.rsplit("/", 1)[1]
    text = _COLON.sub("-", _SEPARATOR.sub("-", text))
    parts = [part for part in text.split("-") if part]
    while len(parts) > 1 and parts[-1] in _VARIANT_SUFFIXES:
        parts.pop()
    return "-".join(parts)


def family_label(family: str) -> str:
    """Human-readable label for a family key. Display only."""
    words = [word for word in str(family or "").split("-") if word]
    out = []
    for word in words:
        known = _BRAND.get(word)
        if known:
            out.append(known)
            continue
        # A brand welded to its version (``qwen3.5``, ``glm5``) keeps the brand
        # casing and the version as published; uppercasing the whole token
        # would print ``QWEN3.5``, which is not how the vendor writes it.
        head = re.match(r"[a-z]+", word)
        prefix = head.group(0) if head else ""
        if prefix and prefix != word and prefix in _BRAND:
            out.append(_BRAND[prefix] + word[len(prefix):])
            continue
        if any(char.isdigit() for char in word):
            out.append(word.upper())
        else:
            out.append(word[:1].upper() + word[1:])
    return " ".join(out)


def preview_signal(model: Any, model_name: Any = "") -> bool:
    """True when the listing itself labels the model as preview/beta/stealth.

    Evidence only: the pattern must appear in the provider-published id or
    name. Nothing is inferred about an unnamed or obfuscated model.
    """
    for value in (model, model_name):
        text = str(value or "").strip()
        if text and _PREVIEW.search(text):
            return True
    return False


# -------------------------------------------------------------------- rates

def _rate(value: Any) -> Optional[float]:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    number = float(value)
    if not math.isfinite(number) or number < 0:
        return None
    return number


def _pct(before: float, after: float) -> Optional[float]:
    if before <= 0:
        return None
    return round((after - before) / before * 100.0, 1)


def rate_deltas(previous: Any, current: Any) -> dict[str, Any]:
    """Per-rate-type comparison of two rate blocks.

    Returns ``{"rates": {...}, "direction", "comparable", "incomparable",
    "max_abs_pct", "dominant"}``. A rate type is comparable only when both
    sides publish a finite non-negative number; a zero baseline yields a delta
    but no percentage, because a percentage against zero is not a measurement.
    """
    incomparable: dict[str, str] = {}
    rates: dict[str, dict[str, Any]] = {}
    have_previous = isinstance(previous, Mapping)
    have_current = isinstance(current, Mapping)
    for key in RATE_KEYS:
        before = _rate(previous.get(key)) if have_previous else None
        after = _rate(current.get(key)) if have_current else None
        if before is None or after is None:
            reason = ("news_ev_side_missing" if not (have_previous and have_current)
                      else "news_ev_rate_absent")
            incomparable[key] = reason
            continue
        rates[key] = {
            "before": before,
            "after": after,
            "delta": round(after - before, 6),
            "pct": _pct(before, after),
        }
        if rates[key]["pct"] is None and not (before == 0 and after == 0):
            incomparable[key] = "news_ev_zero_baseline"

    def _signed(row: Mapping[str, Any]) -> float:
        """Direction of one rate move, from the published values themselves.

        A zero baseline has no percentage but its delta still has a sign, and a
        change too small to survive one-decimal rounding is still a change in
        direction: only the *displayed* percentage is rounded.
        """
        return float(row["delta"])

    moved_down = [key for key, row in rates.items()
                  if row["before"] != row["after"] and _signed(row) < 0]
    moved_up = [key for key, row in rates.items()
                if row["before"] != row["after"] and _signed(row) > 0]
    if moved_down and moved_up:
        direction = "mixed"
    elif not (have_previous and have_current):
        direction = "unknown"
    elif moved_down:
        direction = "down"
    elif moved_up:
        direction = "up"
    else:
        direction = "flat"

    comparable = [key for key, row in rates.items() if row["pct"] is not None]
    # Dominant rate = the one that moves most in USD per 1M tokens, so a
    # headline names the change a buyer would actually feel. Percentage
    # ranking stays separate because it is unit-free across rate types.
    dominant, best_delta = "", -1.0
    for key in RATE_KEYS:
        row = rates.get(key)
        if not row:
            continue
        value = abs(row["delta"])
        if value > best_delta:
            dominant, best_delta = key, value
    best_pct = None
    for key in RATE_KEYS:
        row = rates.get(key)
        if not row or row["pct"] is None:
            continue
        value = abs(row["pct"])
        if best_pct is None or value > best_pct:
            best_pct = value
    return {
        "rates": rates,
        "direction": direction,
        "comparable": comparable,
        "incomparable": incomparable,
        "max_abs_pct": best_pct,
        "max_abs_delta": None if dominant == "" else round(best_delta, 6),
        "dominant": dominant,
        "dominant_pct": rates[dominant]["pct"] if dominant else None,
    }


def _rate_text(value: Optional[float]) -> str:
    """Render one rate without ever turning a positive value into ``$0``.

    Six decimals is the normal reading. A sub-micro rate (a per-token figure
    carried through unchanged, say) would round to zero at that precision, and
    a headline that says a rate became free when it only became very small is a
    false claim, so precision is extended until a significant digit survives.
    """
    if value is None:
        return "—"
    if value == 0:
        return "$0"
    for places in (6, 12):
        text = f"{value:.{places}f}".rstrip("0").rstrip(".")
        if text and float(text) != 0.0:
            return f"${text}"
    return f"${value:.2e}"


# ----------------------------------------------------------------- taxonomy

def classify_event(item: Mapping[str, Any]) -> str:
    """Editorial event type for one feed item.

    An explicit ``event_type`` from the publisher wins. Otherwise the v1
    ``category`` is refined: ``new_model`` becomes ``provider_listed`` (no
    model identity) or ``new_to_catalogue`` (identity, no launch claim), and a
    price change is re-read from its own rate blocks so a mixed move is not
    reported as a one-way change.
    """
    explicit = str(item.get("event_type") or "").strip()
    if explicit in EVENT_TYPES:
        return explicit
    category = str(item.get("category") or "").strip()
    if category == "new_model":
        return "new_to_catalogue" if str(item.get("model") or "").strip() else "provider_listed"
    if category in ("price_reduction", "price_increase"):
        direction = rate_deltas(item.get("previous"), item.get("current"))["direction"]
        if direction == "mixed":
            return "price_mixed"
        if direction == "down":
            return "price_reduction"
        if direction == "up":
            return "price_increase"
        return category
    if category == "subscription":
        summary_code = str(item.get("summary_code") or "").strip()
        return "new_plan" if summary_code == "news_sum_new_plan" else "plan_change"
    return "unknown"


def _signals(item: Mapping[str, Any]) -> list[str]:
    raw = item.get("signals")
    signals = [str(value) for value in raw] if isinstance(raw, (list, tuple)) else []
    if SIGNAL_PREVIEW not in signals and preview_signal(
            item.get("model"), item.get("model_name")):
        signals.append(SIGNAL_PREVIEW)
    return sorted(set(signals))


def score(item: Mapping[str, Any], *, providers: int = 1) -> float:
    """Deterministic editorial rank for one entry.

    Weight (event kind) × log-scaled magnitude × a small corroboration bonus
    for a change visible at several providers. Not a measured importance.
    """
    event_type = classify_event(item)
    deltas = rate_deltas(item.get("previous"), item.get("current"))
    # The dominant rate's own percentage: the same number a headline prints, so
    # "biggest" and the headline never disagree.
    pct = deltas["dominant_pct"] if deltas["dominant_pct"] is not None \
        else (deltas["max_abs_pct"] or 0.0)
    weight = _EVENT_WEIGHT.get(event_type, _EVENT_WEIGHT["unknown"])
    corroboration = 1.0 + 0.05 * max(0, min(providers, 6) - 1)
    return round(weight * (1.0 + math.log1p(abs(pct))) * corroboration, 3)


# ---------------------------------------------------------------- headlines

def _headline(item: Mapping[str, Any], event_type: str,
              signals: Iterable[str] = ()) -> dict[str, Any]:
    """Concise deterministic headline for one event.

    Returns ``{"code", "params", "text"}``. ``text`` is the English rendering
    of the same facts the code and params carry, so a localised client can
    reproduce it without parsing prose.
    """
    provider = str(item.get("provider") or "").strip()
    model = str(item.get("model") or "").strip()
    deltas = rate_deltas(item.get("previous"), item.get("current"))
    rates = deltas["rates"]
    dominant = deltas["dominant"]

    if (SIGNAL_PREVIEW in set(signals) and event_type in ("new_to_catalogue", "newly_available")):
        return {
            "code": "news_head_preview_observed",
            "params": {"provider": provider, "model": model,
                       "observed_at": str(item.get("observed_at") or "")},
            "text": (f"Preview-labelled model {model} observed at {provider} "
                     f"(no vendor or launch identity inferred)"),
        }

    if event_type in ("price_reduction", "price_increase") and dominant:
        row = rates[dominant]
        verb = "cuts" if event_type == "price_reduction" else "raises"
        if all(entry_row["delta"] == 0 for entry_row in rates.values()):
            # Base rates unchanged: the event is a tier/context-pricing change,
            # which no percentage on a base rate could describe honestly.
            return {
                "code": "news_head_tiers_changed",
                "params": {"provider": provider, "model": model},
                "text": (f"{provider} changes {model} tier/context pricing "
                         f"(base rates unchanged)"),
            }
        if row["pct"] is None:
            return {
                "code": "news_head_from_zero",
                "params": {"provider": provider, "model": model,
                           "rate": RATE_CODE[dominant], "after": _rate_text(row["after"])},
                "text": (f"{provider} now lists {model} {dominant} at "
                         f"{_rate_text(row['after'])} per 1M tokens "
                         f"(previously $0; no meaningful percentage)"),
            }
        moved = [key for key in RATE_KEYS if key in rates
                 and rates[key]["pct"] is not None and rates[key]["before"] != rates[key]["after"]]
        same_direction = bool(moved) and all(
            (rates[key]["pct"] or 0) < 0 if event_type == "price_reduction"
            else (rates[key]["pct"] or 0) > 0 for key in moved)
        same_size = same_direction and len({rates[key]["pct"] for key in moved}) == 1
        if len(moved) > 1 and same_size:
            return {
                "code": "news_head_all_rates",
                "params": {"provider": provider, "model": model, "pct": row["pct"],
                           "rates": [RATE_CODE[key] for key in moved]},
                "text": (f"{provider} {verb} {model} prices by {abs(row['pct']):g}% "
                         f"({', '.join(moved)})"),
            }
        return {
            "code": "news_head_single_rate",
            "params": {"provider": provider, "model": model, "rate": RATE_CODE[dominant],
                       "pct": row["pct"], "before": _rate_text(row["before"]),
                       "after": _rate_text(row["after"]),
                       "also_moved": [RATE_CODE[key] for key in moved if key != dominant],
                       "direction": "down" if row["pct"] < 0 else "up"},
            "text": (f"{provider} {verb} {model} {dominant} by {abs(row['pct']):g}% "
                     f"({_rate_text(row['before'])} → {_rate_text(row['after'])} per 1M tokens)"),
        }
    if event_type == "price_mixed":
        def _up(key: str) -> bool:
            row = rates[key]
            return row["delta"] > 0

        up = [key for key in RATE_KEYS if key in rates
              and rates[key]["before"] != rates[key]["after"] and _up(key)]
        down = [key for key in RATE_KEYS if key in rates
                and rates[key]["before"] != rates[key]["after"] and not _up(key)]

        def _largest_pct(keys: list[str]) -> Optional[float]:
            values = [abs(rates[key]["pct"]) for key in keys
                      if rates[key]["pct"] is not None]
            return max(values) if values else None

        def _values_text(keys: list[str]) -> str:
            """Exact values for rates whose percentage is undefined."""
            return "; ".join(f"{key} {_rate_text(rates[key]['before'])} → "
                             f"{_rate_text(rates[key]['after'])}"
                             for key in keys if rates[key]["pct"] is None)

        # A rate with a zero baseline has no percentage, so its exact values are
        # carried instead of a false 0%.
        return {
            "code": "news_head_mixed",
            "params": {"provider": provider, "model": model,
                       "raised": [RATE_CODE[key] for key in up],
                       "cut": [RATE_CODE[key] for key in down],
                       "raised_pct": _largest_pct(up),
                       "cut_pct": _largest_pct(down),
                       "raised_values": _values_text(up),
                       "cut_values": _values_text(down)},
            "text": (f"{provider} changes {model} in both directions "
                     f"({', '.join(up) or 'no rate'} raised, {', '.join(down) or 'no rate'} cut)"),
        }
    if event_type == "newly_available":
        # The published list is capped at the schema's width, so the item also
        # carries the true total; prefer it and fall back for older items.
        count = item.get("other_provider_count")
        if not isinstance(count, int) or isinstance(count, bool):
            others = item.get("other_providers")
            count = len(others) if isinstance(others, (list, tuple)) else 0
        return {
            "code": "news_head_newly_available",
            "params": {"provider": provider, "model": model, "others": count},
            "text": (f"{provider} now also lists {model}"
                     + (f" (already listed by {count} other provider(s))" if count else "")),
        }
    if event_type == "new_to_catalogue":
        first_seen = str(item.get("first_seen_at") or "").strip()
        confidence = str(item.get("confidence") or "observed").strip()
        if confidence in ("verified", "curated"):
            return {
                "code": "news_head_launched",
                "params": {"provider": provider, "model": model,
                           "first_seen": first_seen, "confidence": confidence},
                "text": (f"{provider} launches {model}"
                         + (f" (first observed {first_seen[:10]})" if first_seen else "")),
            }
        return {
            "code": "news_head_new_to_catalogue",
            "params": {"provider": provider, "model": model, "first_seen": first_seen,
                       "confidence": confidence},
            "text": (f"{provider} starts listing {model}"
                     + (f" (first observed {first_seen[:10]})" if first_seen
                        else " (new catalogue entry; no launch claim)")),
        }
    if event_type == "provider_listed":
        return {
            "code": "news_head_provider_listed",
            "params": {"provider": provider},
            "text": f"{provider} newly appears in the catalogue",
        }
    if event_type == "removed_from_provider":
        observations = item.get("confirmations")
        return {
            "code": "news_head_removed_from_provider",
            "params": {"provider": provider, "model": model,
                       "observations": observations if isinstance(observations, int) else 0},
            "text": (f"{provider} no longer lists {model}"
                     + (f" (confirmed across {observations} catalogue observations)"
                        if isinstance(observations, int) and observations else "")),
        }
    if event_type == "provider_delisted":
        observations = item.get("confirmations")
        return {
            "code": "news_head_provider_delisted",
            "params": {"provider": provider,
                       "observations": observations if isinstance(observations, int) else 0},
            "text": (f"{provider} no longer appears in the catalogue"
                     + (f" (confirmed across {observations} observations)"
                        if isinstance(observations, int) and observations else "")),
        }
    if event_type in ("new_plan", "plan_change"):
        summary = str(item.get("summary") or "").strip()
        return {
            "code": "news_head_plan_change",
            "params": {"provider": provider, "summary": summary},
            "text": summary[:200],
        }
    summary = str(item.get("summary") or "").strip()
    return {
        "code": "news_head_unclassified",
        "params": {"provider": provider, "model": model, "summary": summary[:200]},
        "text": summary[:200] or f"{provider} {model}".strip(),
    }


def _entry(item: Mapping[str, Any], *, providers: int = 1) -> dict[str, Any]:
    event_type = classify_event(item)
    deltas = rate_deltas(item.get("previous"), item.get("current"))
    family = model_family(item.get("model"))
    signals = _signals(item)
    headline = _headline(item, event_type, signals)
    entry = {
        "event_type": event_type,
        "headline_code": headline["code"],
        "headline_params": headline["params"],
        "headline": headline["text"],
        "provider": str(item.get("provider") or ""),
        "model": str(item.get("model") or ""),
        "model_family": family,
        "family_label": family_label(family),
        "observed_at": str(item.get("observed_at") or ""),
        "source_url": str(item.get("source_url") or ""),
        "confidence": str(item.get("confidence") or "observed"),
        "event_ids": [str(item.get("id") or "")] if item.get("id") else [],
        "providers": [str(item.get("provider") or "")],
        "magnitude": {
            "max_abs_pct": deltas["max_abs_pct"],
            "dominant_pct": deltas["dominant_pct"],
            "max_abs_delta": deltas["max_abs_delta"],
            "rate": deltas["dominant"],
            # The measured direction travel: "mixed" only when one rate fell and
            # another rose, so a headline can never claim both from a category.
            "direction": deltas["direction"],
            "comparable_rates": len(deltas["comparable"]),
            # A zero-baseline move has no percentage, so it can only be judged
            # material by its absolute delta.
            "zero_baseline": bool(
                deltas["dominant"]
                and deltas["rates"][deltas["dominant"]]["pct"] is None),
        },
        "score": score(item, providers=providers),
    }
    # A signal only travels when it says something the event type does not.
    if signals:
        entry["signals"] = signals
    return entry


# ---------------------------------------------------------------- grouping

_VARIANT_FIELDS = ("event_type", "headline_code", "headline_params", "headline",
                   "provider", "model", "observed_at", "event_ids")


def _variant(entry: Mapping[str, Any]) -> dict[str, Any]:
    """Compact per-provider row inside a family group.

    The group row already carries the family label and its own banner, so a
    variant keeps what a provider row has to show — its message code and
    parameters, identity and event link — never a full copy of the entry, which
    would double the published payload. The code and parameters matter: a
    grouped row must stay localisable.
    """
    row = {key: entry[key] for key in _VARIANT_FIELDS if key in entry}
    magnitude = entry.get("magnitude")
    if isinstance(magnitude, Mapping):
        row["magnitude"] = {"rate": magnitude.get("rate"),
                            "max_abs_pct": magnitude.get("max_abs_pct")}
    return row


def _group(entries: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Group entries under their model family without merging identity.

    One grouped row per family; ``variants`` keeps every exact provider/model
    event, so no tier, version or provider detail is lost.
    """
    buckets: dict[str, list[dict[str, Any]]] = {}
    loose: list[dict[str, Any]] = []
    for entry in entries:
        family = entry["model_family"]
        if family:
            buckets.setdefault(family, []).append(entry)
        else:
            loose.append(entry)
    grouped: list[dict[str, Any]] = []
    for family, members in buckets.items():
        members.sort(key=lambda row: (-row["score"], row["provider"], row["model"],
                                      tuple(row["event_ids"])))
        head = members[0]
        providers = sorted({row["provider"] for row in members})
        entry = {
            **head,
            "family_event_count": len(members),
            "providers": providers,
            "event_ids": [event_id for row in members for event_id in row["event_ids"]],
            "score": max(row["score"] for row in members),
            "variants": [_variant(row) for row in members[:_MAX_VARIANTS]],
        }
        if len(members) > 1:
            label = head["family_label"] or head["model"]
            where = (f"at {providers[0]}" if len(providers) == 1
                     else f"across {len(providers)} providers")
            entry["headline_code"] = "news_head_group"
            entry["headline_params"] = {"family": label,
                                        "providers": len(providers), "events": len(members)}
            entry["headline"] = f"{label}: {len(members)} changes {where}"
        grouped.append(entry)
    for entry in loose:
        grouped.append({**entry, "family_event_count": 1, "variants": [_variant(entry)]})
    grouped.sort(key=lambda row: (-row["score"], row["model_family"] or row["provider"],
                                  row["provider"], row["model"],
                                  tuple(row["event_ids"])))
    return grouped


def _section(section_id: str, entries: list[dict[str, Any]],
             *, limit: int) -> dict[str, Any]:
    grouped = _group(entries)
    total = len(grouped)
    return {
        "id": section_id,
        "title_code": f"news_section_{section_id}",
        "total": total,
        "entries": grouped[:limit],
    }


def _utc(moment: datetime) -> datetime:
    """Return ``moment`` in UTC, reading a timezone-less stamp as UTC.

    Publishers are inconsistent about offsets — ``generated_at`` may be naive
    while a stored record carries ``Z``, or the other way round. Comparing two
    instants requires one discipline on both sides, so every parsed stamp goes
    through this before any comparison.
    """
    if moment.tzinfo is None:
        return moment.replace(tzinfo=timezone.utc)
    return moment.astimezone(timezone.utc)


def _instant(stamp: object) -> Optional[datetime]:
    """Parsed UTC instant of one ISO stamp, or ``None`` when unreadable."""
    text = str(stamp or "").strip()
    if not text:
        return None
    try:
        return _utc(datetime.fromisoformat(text))
    except ValueError:
        return None


def _within_window(stamp: str, generated_at: str, window_days: int) -> bool:
    """True when ``stamp`` is inside the news window ending at ``generated_at``.

    Both ends are enforced when the end is usable: a record observed *after*
    publication cannot be news. An unparseable or absent stamp is kept:
    dropping evidence because of a format is worse than showing an undated
    record.
    """
    # Normalised before deriving the cutoff, so both bounds share one timezone
    # discipline whatever the caller wrote.
    end = _instant(generated_at)
    if end is None:
        return True
    cutoff = end - timedelta(days=max(0, window_days))
    moment = _instant(stamp)
    if moment is None:
        return True
    if moment > end:
        return False
    return moment >= cutoff


def _recent_removals(removals: Iterable[Mapping[str, Any]], generated_at: str,
                     window_days: int) -> list[dict[str, Any]]:
    """Confirmed removal records as item-shaped entries, newest first.

    A confirmed record stays in history indefinitely; only recent ones belong in
    a news section, so the window is applied here and the order is by date
    rather than by score.
    """
    entries: list[dict[str, Any]] = []
    for record in removals:
        if not isinstance(record, Mapping):
            continue
        provider = str(record.get("provider") or "").strip()
        model = str(record.get("model") or "").strip()
        removed_at = str(record.get("removed_at") or "")
        if not provider or not _within_window(removed_at, generated_at, window_days):
            continue
        entries.append({
            "id": f"rm-{provider}-{model}".strip("-"),
            # No v1 category: a removal has no honest value in the four-value
            # enum, which is why removals live in the briefing only.
            "event_type": "removed_from_provider" if model else "provider_delisted",
            "provider": provider,
            "model": model,
            "summary": "",
            "observed_at": removed_at,
            "effective_at": "",
            "source_url": str(record.get("source_url") or ""),
            "confidence": str(record.get("confidence") or "observed"),
            "provenance": str(record.get("provenance") or ""),
            "confirmations": record.get("consecutive"),
        })
    entries.sort(key=lambda row: (row["observed_at"], row["provider"], row["model"]),
                 reverse=True)
    return entries


# ----------------------------------------------------------------- briefing

def build_briefing(items: Iterable[Mapping[str, Any]], *,
                   generated_at: str = "",
                   removals: Iterable[Mapping[str, Any]] = (),
                   removal_tracking: bool = False,
                   removal_window_days: int = REMOVAL_WINDOW_DAYS,
                   min_abs_pct: float = MIN_ABS_PCT,
                   min_abs_delta: float = MIN_ABS_DELTA,
                   section_limit: int = SECTION_LIMIT,
                   max_entries: int = MAX_ENTRIES) -> dict[str, Any]:
    """Build the shared editorial briefing from verified events.

    ``items`` is the complete event list (local + central or central only);
    ``removals`` are absence-confirmed records supplied by the publisher's
    history. ``removal_tracking`` says whether the publisher can detect
    removals at all: without it no removal is claimed and the briefing says so
    in ``unsupported`` instead of guessing.
    """
    entries = [
        _entry(item, providers=1)
        for item in items
        if isinstance(item, Mapping) and str(item.get("id") or "").strip()
    ]
    for entry in entries:
        others = entry["headline_params"].get("others")
        if isinstance(others, int) and others:
            entry["score"] = round(entry["score"] * (1.0 + 0.05 * min(others, 6)), 3)

    # Bound the editorial pass without misreporting the archive: the cap trims
    # what is ranked, never the count of events supplied.
    supplied = len(entries)
    if max_entries and supplied > max_entries:
        entries.sort(key=lambda row: (-row["score"], row["provider"], row["model"],
                                      tuple(row["event_ids"])))
        entries = entries[:max_entries]

    counts = {name: 0 for name in EVENT_TYPES}
    for entry in entries:
        counts[entry["event_type"]] = counts.get(entry["event_type"], 0) + 1

    def material(entry: Mapping[str, Any]) -> bool:
        """A ranked price headline needs a MEASURED move of real size.

        Both floors apply to a percentage move: the relative change must clear
        ``min_abs_pct`` AND the largest rate must move by at least
        ``min_abs_delta`` USD per 1M tokens. Without the second floor a 1 850%
        move on a sub-cent cache rate outranks a real input-price change, which
        is exactly what the absolute floor exists to prevent. A move from a zero
        baseline has no percentage, so its dollar delta carries the whole test.
        A ``price_mixed`` claim additionally needs both directions to have been
        measured on the rates themselves — a category alone never proves it. A
        price event whose two sides share no comparable rate has measured
        nothing and is never headlined, however it was categorised.
        """
        magnitude = entry["magnitude"]
        delta = magnitude.get("max_abs_delta")
        delta_ok = delta is not None and delta >= min_abs_delta
        event_type = entry["event_type"]
        if event_type in ("price_reduction", "price_increase"):
            if magnitude.get("zero_baseline") is True:
                return delta_ok
            pct = magnitude.get("dominant_pct")
            if pct is None or abs(pct) < min_abs_pct:
                return False
            if not delta_ok:
                return False
            return pct < 0 if event_type == "price_reduction" else pct > 0
        if event_type == "price_mixed":
            if magnitude.get("direction") != "mixed":
                return False
            pct = magnitude.get("max_abs_pct")
            return pct is not None and abs(pct) >= min_abs_pct and delta_ok
        return True

    def ranked(event_type: str) -> list[dict[str, Any]]:
        return [entry for entry in entries
                if entry["event_type"] == event_type and material(entry)]

    reductions = _group(ranked("price_reduction"))
    increases = _group(ranked("price_increase"))
    mixed = _group(ranked("price_mixed"))

    # Removals come from two sources: absence records the publisher confirmed,
    # and operator notes that assert a removal directly. A note supersedes an
    # inferred record for the same identity rather than appearing beside it.
    curated_removals = [entry for entry in entries
                        if entry["event_type"] in REMOVAL_EVENT_TYPES
                        and _within_window(entry["observed_at"], generated_at,
                                           removal_window_days)]
    removal_entries = list(curated_removals)
    claimed = {(entry["provider"], entry["model"]) for entry in removal_entries}
    for record in _recent_removals(removals, generated_at, removal_window_days):
        entry = _entry(record)
        identity = (entry["provider"], entry["model"])
        if identity in claimed:
            continue
        claimed.add(identity)
        removal_entries.append(entry)
        counts[entry["event_type"]] = counts.get(entry["event_type"], 0) + 1
    removal_groups = _group(removal_entries)

    # Removals are the one section where "newest" beats "biggest": a confirmed
    # record never expires from history, so a fixed widening sort would let old
    # removals push a fresh one out of the section forever. The order is by PARSED
    # instant — text collation puts "…T00:30:00+02:00" ahead of "…T23:30:00Z"
    # although it happened an hour earlier — with the identity as tie-breaker and
    # an undated record last, exactly as the Desktop builder orders it.
    def _removal_order(row: Mapping[str, Any]) -> tuple[Any, ...]:
        when = _instant(row.get("observed_at"))
        if when is None:
            return (1, 0.0, row["provider"], row["model"])
        return (0, -when.timestamp(), row["provider"], row["model"])

    removal_groups.sort(key=_removal_order)

    sections = [
        {"id": "biggest_reductions", "title_code": "news_section_biggest_reductions",
         "total": len(reductions), "entries": reductions[:section_limit]},
        {"id": "biggest_increases", "title_code": "news_section_biggest_increases",
         "total": len(increases), "entries": increases[:section_limit]},
        {"id": "mixed_price_changes", "title_code": "news_section_mixed_price_changes",
         "total": len(mixed), "entries": mixed[:section_limit]},
        # A preview-labelled listing is a discovery, so it belongs to the
        # preview section only — never there and in the regular listing
        # sections as well.
        _section("new_models",
                 [entry for entry in entries
                  if entry["event_type"] == "new_to_catalogue"
                  and SIGNAL_PREVIEW not in entry.get("signals", ())],
                 limit=section_limit),
        _section("newly_available",
                 [entry for entry in entries
                  if entry["event_type"] == "newly_available"
                  and SIGNAL_PREVIEW not in entry.get("signals", ())],
                 limit=section_limit),
        {"id": "removals", "title_code": "news_section_removals",
         "total": len(removal_groups), "entries": removal_groups[:section_limit]},
        _section("subscriptions",
                 [entry for entry in entries
                  if entry["event_type"] in ("new_plan", "plan_change")],
                 limit=section_limit),
        # A preview signal is a discovery signal: a price change on an already
        # known preview model is that model's price news, not a new discovery.
        _section("preview_models",
                 [entry for entry in entries
                  if SIGNAL_PREVIEW in entry.get("signals", ())
                  and entry["event_type"] in ("new_to_catalogue", "newly_available")],
                 limit=section_limit),
    ]

    unsupported: list[dict[str, str]] = []
    if not removal_tracking and not curated_removals:
        # Distinguish "we cannot detect removals" from "we can and confirmed
        # none", and from "an operator published one directly": only the first
        # is a limitation worth telling the reader about.
        unsupported.append({
            "id": "removals",
            "reason_code": "news_unsupported_no_absence_history",
        })
    if not counts.get("new_plan") and not counts.get("plan_change"):
        unsupported.append({
            "id": "subscriptions",
            "reason_code": "news_unsupported_no_plan_events",
        })

    oldest = min((entry["observed_at"] for entry in entries if entry["observed_at"]),
                 default="")
    newest = max((entry["observed_at"] for entry in entries if entry["observed_at"]),
                 default="")
    return {
        "version": BRIEFING_VERSION,
        "generated_at": generated_at,
        "thresholds": {"min_abs_pct": min_abs_pct, "min_abs_delta": min_abs_delta,
                       "section_limit": section_limit,
                       "removal_window_days": removal_window_days},
        "sections": sections,
        "counts": counts | {
            "events": len(entries),
            "headlined": sum(len(section["entries"]) for section in sections),
        },
        "unsupported": unsupported,
        "all_updates": {"total": supplied, "oldest": oldest, "newest": newest},
        "limits": {"entries": max_entries, "truncated": supplied > len(entries)},
    }



# ------------------------------------------------------------- client trust

_MAX_SECTIONS = 12
_MAX_SECTION_ENTRIES = 40
#: Variant rows rendered under one family banner. The banner's own
#: ``family_event_count`` reports the true total.
_MAX_VARIANTS = 12
#: Event/provider links kept per entry. Larger than the variant cap: a link is
#: cheap and a dropped one is a lost join back to All Updates.
_MAX_LINKS = 64
_MAX_TEXT = 500

_ENTRY_TEXT = ("event_type", "headline_code", "headline", "provider", "model",
               "model_family", "family_label", "observed_at", "effective_at",
               "source_url", "confidence", "provenance")
_ENTRY_NUMBER = ("score", "family_event_count")


def _text(value: Any, limit: int = _MAX_TEXT) -> str:
    return value.strip()[:limit] if isinstance(value, str) else ""


def _scalar_map(value: Any, limit: int = 16) -> dict[str, Any]:
    out: dict[str, Any] = {}
    if not isinstance(value, Mapping):
        return out
    for key, item in list(value.items())[:limit]:
        if isinstance(item, bool) or isinstance(item, (int, float)):
            out[str(key)[:64]] = item
        elif isinstance(item, str):
            out[str(key)[:64]] = item[:_MAX_TEXT]
        elif isinstance(item, list) and len(item) <= limit:
            out[str(key)[:64]] = [sub[:64] if isinstance(sub, str) else sub
                                  for sub in item if isinstance(sub, (str, int, float))]
    return out


def _sanitise_entry(raw: Any, depth: int = 0) -> Optional[dict[str, Any]]:
    if not isinstance(raw, Mapping):
        return None
    entry: dict[str, Any] = {key: _text(raw.get(key)) for key in _ENTRY_TEXT}
    if not entry["headline"] or not entry["provider"]:
        return None
    for key in _ENTRY_NUMBER:
        value = raw.get(key)
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            entry[key] = value
    for key, limit in (("headline_params", 16), ("magnitude", 8), ("rate_change", 8)):
        mapped = _scalar_map(raw.get(key), limit)
        if mapped:
            entry[key] = mapped
    for key in ("signals", "event_ids", "providers"):
        value = raw.get(key)
        if isinstance(value, list):
            links = [item[:128] for item in value[:_MAX_LINKS] if isinstance(item, str)]
            if links:
                entry[key] = links
    variants = raw.get("variants")
    if isinstance(variants, list) and depth < 2:
        cleaned = [_sanitise_entry(item, depth + 1) for item in variants[:_MAX_VARIANTS]]
        entry["variants"] = [item for item in cleaned if item]
    return entry


def sanitise_briefing(raw: Any) -> Optional[dict[str, Any]]:
    """Client-side trust boundary for a fetched briefing block.

    A remote briefing is display data, so it is bounded and type-checked rather
    than schema-checked in full. Anything malformed is dropped silently: the
    event archive must keep working even when the editorial layer regresses.
    """
    if not isinstance(raw, Mapping) or raw.get("version") != BRIEFING_VERSION:
        return None
    sections = raw.get("sections")
    if not isinstance(sections, list):
        return None
    cleaned_sections: list[dict[str, Any]] = []
    for section in sections[:_MAX_SECTIONS]:
        if not isinstance(section, Mapping):
            continue
        section_id = _text(section.get("id"), 64)
        if not section_id:
            continue
        entries = section.get("entries")
        rows = [_sanitise_entry(entry) for entry in entries[:_MAX_SECTION_ENTRIES]] \
            if isinstance(entries, list) else []
        total = section.get("total")
        cleaned_sections.append({
            "id": section_id,
            "title_code": _text(section.get("title_code"), 64),
            "total": total if isinstance(total, int) and not isinstance(total, bool) else len(rows),
            "entries": [row for row in rows if row],
        })
    raw_unsupported = raw.get("unsupported")
    unsupported = [
        {"id": _text(item.get("id"), 64), "reason_code": _text(item.get("reason_code"), 64)}
        for item in (raw_unsupported if isinstance(raw_unsupported, list) else [])[:_MAX_SECTIONS]
        if isinstance(item, Mapping)
    ]
    return {
        "version": BRIEFING_VERSION,
        "generated_at": _text(raw.get("generated_at"), 64),
        "sections": cleaned_sections,
        "counts": _scalar_map(raw.get("counts"), 24),
        "unsupported": unsupported,
        "all_updates": _scalar_map(raw.get("all_updates"), 8),
    }
