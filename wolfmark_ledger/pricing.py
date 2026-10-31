"""Provider-aware price book for the ledger.

Rates come from the models.dev catalogue Hermes already caches on disk
(``~/.hermes/models_dev_cache.json``), with a bundled snapshot as the offline
fallback. Resolution is deliberately strict:

* an explicit route alias (``xai-oauth`` -> ``xai``, ``openai-codex`` ->
  ``openai``) may map a route to the provider whose list price it serves;
* otherwise the route provider's own catalogue row must contain the model;
* there is **no** cross-provider fallback. An unknown route is unpriced, never
  silently priced with another provider's card.
"""

from __future__ import annotations

import json
import math
import os
import threading
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

M = 1_000_000

# Provenance vocabulary. ``models_dev_route`` is the PRIMARY basis: an exact
# provider/model/variant row in Hermes's models.dev catalogue. ``official_verified``
# means a rate additionally checked against the provider's own documentation.
PROVENANCES = ("official_verified", "models_dev_route", "third_party", "approximate", "unpriced")

# Hermes billing-route slugs -> models.dev provider ids. Only explicit,
# documented equivalences belong here. A route that is not listed is looked up
# under its own slug and, if absent, stays unpriced.
PROVIDER_ALIASES: dict[str, str] = {
    "anthropic": "anthropic",
    "claude": "anthropic",
    "claude-code": "anthropic",
    "openai": "openai",
    "openai-api": "openai",
    "openai-codex": "openai",
    "codex": "openai",
    "xai": "xai",
    "grok": "xai",
    "xai-oauth": "xai",
    "google": "google",
    "gemini": "google",
    "google-gemini": "google",
    "google-ai-studio": "google",
    "vertex": "google-vertex",
    "vertex-ai": "google-vertex",
    "google-vertex": "google-vertex",
    "bedrock": "amazon-bedrock",
    "amazon-bedrock": "amazon-bedrock",
    "azure": "azure",
    "github-copilot": "github-copilot",
    "copilot": "github-copilot",
    "copilot-acp": "github-copilot",
    "kimi": "moonshotai",
    "moonshot": "moonshotai",
    "moonshot-ai": "moonshotai",
    "moonshotai": "moonshotai",
    "z-ai": "z-ai",
    "zhipu": "z-ai",
    "minimax": "minimax",
    "minimax-cn": "minimax",
    "deepseek": "deepseek",
    "mistral": "mistral",
    "groq": "groq",
    "togetherai": "togetherai",
    "cerebras": "cerebras",
    "fireworks": "fireworks-ai",
    "fireworks-ai": "fireworks-ai",
    "deepinfra": "deepinfra",
    "perplexity": "perplexity",
    "alibaba": "alibaba",
    "openrouter": "openrouter",
    "nous": "nous",
    "commandcode": "commandcode",
    "opencode": "opencode",
}

_HERE = Path(__file__).resolve().parent
_REPO_ROOT = _HERE.parent
_BUNDLED = _REPO_ROOT / "catalogue" / "rates.json"
_CATALOGUE_CACHE: dict[tuple[str, float, int], Catalogue] = {}
_CATALOGUE_LOCK = threading.Lock()


@dataclass(frozen=True)
class Tier:
    threshold: int
    input: Optional[float] = None
    output: Optional[float] = None
    cache_read: Optional[float] = None
    cache_write: Optional[float] = None


@dataclass(frozen=True)
class Rate:
    input: Optional[float]
    output: Optional[float]
    cache_read: Optional[float] = None
    cache_write: Optional[float] = None
    tiers: tuple[Tier, ...] = ()

    def has_base_price(self) -> bool:
        return self.input is not None or self.output is not None


@dataclass(frozen=True)
class Lookup:
    provider: str          # canonical catalogue provider
    route_provider: str    # what Hermes recorded
    model: str
    rate: Rate
    alias_used: bool
    confidence: str        # "aggregator" | "bundled"
    source: str
    provenance: str = "models_dev_route"
    provisional: tuple = ()  # official_verified | models_dev_route | third_party | approximate



@dataclass(frozen=True)
class Priced:
    usd: Optional[float]          # conservative: base rates for every token
    usd_upper: Optional[float]    # upper bound: tier rates where a tier may apply
    tier_possible: bool
    cache_read_defaulted: bool
    cache_write_defaulted: bool
    cache_savings: Optional[float]
    reason: str


@dataclass(frozen=True)
class Catalogue:
    providers: dict[str, dict[str, Rate]]
    source: str
    confidence: str
    as_of: str
    version: str
    # (provider, model) -> (rate, verified_at) checked against official docs.
    official: dict[tuple[str, str], tuple[Rate, str, tuple]] = field(default_factory=dict)

    def lookup(self, route_provider: str, model: str, *,
               allow_third_party: bool = False,
               allow_approximate: bool = False,
               at: Optional[float] = None) -> Optional[Lookup]:
        """Resolve a rate for the SERVING route, with explicit provenance.

        Order: the route's own catalogue row, then (opt-in) OpenRouter's exact
        row for the same model, then (opt-in) another provider's equivalent.
        A foreign hit is never reported as the route's own price.
        """
        route = (route_provider or "").strip()
        if not model or not route:
            return None
        canonical = PROVIDER_ALIASES.get(route.lower(), route.lower())

        def hit(provider_id: str, provenance: str) -> Optional[Lookup]:
            models = self.providers.get(provider_id)
            if not models:
                return None
            for candidate in (model, model.split("/")[-1]):
                rate = models.get(candidate)
                if rate is not None and rate.has_base_price():
                    return Lookup(
                        provider=provider_id,
                        route_provider=route,
                        model=candidate,
                        rate=rate,
                        alias_used=provider_id != route.lower(),
                        confidence=self.confidence,
                        source=self.source,
                        provenance=provenance,
                    )
            return None

        for candidate in (model, model.split("/")[-1]):
            overlay = self.official.get((canonical, candidate))
            if overlay:
                rate, verified_at, windows = overlay
                rate = _windowed_rate(rate, windows, at)
                provisional = ("cache_read",) if (windows and at is not None
                                                   and _window_active(windows, at)) else ()
                return Lookup(provider=canonical, route_provider=route, model=candidate,
                              rate=rate, alias_used=canonical != route.lower(),
                              confidence=self.confidence,
                              source=f"{self.source} + official check {verified_at}",
                              provenance="official_verified",
                              **({"provisional": provisional} if 'provisional' in dir() else {}))
        exact = hit(canonical, "models_dev_route")
        if exact:
            return exact
        if allow_third_party and canonical != "openrouter":
            third = hit("openrouter", "third_party")
            if third:
                return third
        if allow_approximate:
            for provider_id in sorted(self.providers):
                if provider_id in (canonical, "openrouter"):
                    continue
                other = hit(provider_id, "approximate")
                if other:
                    return other
        return None

    def meta(self) -> dict[str, Any]:
        models = sum(len(v) for v in self.providers.values())
        return {
            "provenance_levels": list(PROVENANCES),
            "official_checks": len(self.official),
            "source": self.source,
            "confidence": self.confidence,
            "as_of": self.as_of,
            "version": self.version,
            "providers": len(self.providers),
            "models": models,
        }


def _num(value: Any) -> Optional[float]:
    if isinstance(value, bool) or value is None:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) and number >= 0 else None


def _tier_from_dict(raw: dict[str, Any]) -> Optional[Tier]:
    if not isinstance(raw, dict):
        return None
    tier = raw.get("tier") if isinstance(raw.get("tier"), dict) else {}
    threshold = _num(tier.get("size") if tier else raw.get("threshold"))
    if not threshold:
        return None
    return Tier(
        threshold=int(threshold),
        input=_num(raw.get("input")),
        output=_num(raw.get("output")),
        cache_read=_num(raw.get("cache_read")),
        cache_write=_num(raw.get("cache_write")),
    )


def _rate_from_cost(cost: Any) -> Optional[Rate]:
    """Normalise a models.dev ``cost`` block into a Rate.

    Both input and output must be present. A partially specified row is not a
    usable price: pricing an output-only model at zero input would understate
    every prompt. Rows with ``{}`` (images, videos, embeddings without text
    pricing) are ignored.
    """
    if not isinstance(cost, dict):
        return None
    inp = _num(cost.get("input"))
    out = _num(cost.get("output"))
    if inp is None or out is None:
        return None

    tiers: list[Tier] = []
    for raw in cost.get("tiers") or []:
        tier = _tier_from_dict(raw)
        if tier:
            tiers.append(tier)

    over = cost.get("context_over_200k")
    if not tiers and isinstance(over, dict):
        tiers.append(
            Tier(
                threshold=200_000,
                input=_num(over.get("input")),
                output=_num(over.get("output")),
                cache_read=_num(over.get("cache_read")),
                cache_write=_num(over.get("cache_write")),
            )
        )

    tiers.sort(key=lambda t: t.threshold)
    return Rate(
        input=inp,
        output=out,
        cache_read=_num(cost.get("cache_read")),
        cache_write=_num(cost.get("cache_write")),
        tiers=tuple(tiers),
    )


def _window_active(windows: tuple, at: Optional[float]) -> bool:
    if at is None:
        return False
    moment = datetime.fromtimestamp(float(at), timezone.utc)
    minute = moment.hour * 60 + moment.minute
    for days, start, end, *_ in windows:
        if days and moment.weekday() not in days:
            continue
        inside = start <= minute < end if start <= end else (minute >= start or minute < end)
        if inside:
            return True
    return False


def _windowed_rate(rate: Rate, windows: tuple, at: Optional[float]) -> Rate:
    """Apply a provider's published peak/off-peak window for the call's own time.

    Windows are (start_minute, end_minute, input, output, cache_read, cache_write)
    in the overlay's declared UTC offset. With no timestamp, or no matching window,
    the base rate stands — never a guessed tariff.
    """
    if not windows or at is None:
        return rate
    try:
        moment = datetime.fromtimestamp(float(at), timezone.utc)
    except (TypeError, ValueError, OSError, OverflowError):
        return rate
    minute = moment.hour * 60 + moment.minute
    weekday = moment.weekday()  # Monday = 0, matching published Mon-Fri windows
    for days, start, end, inp, out, cr, cw in windows:
        if days and weekday not in days:
            continue
        inside = start <= minute < end if start <= end else (minute >= start or minute < end)
        if not inside:
            continue
        return Rate(
            input=inp if inp is not None else rate.input,
            output=out if out is not None else rate.output,
            cache_read=cr if cr is not None else rate.cache_read,
            cache_write=cw if cw is not None else rate.cache_write,
            tiers=rate.tiers,
        )
    return rate


def load_official(path: Optional[Path] = None) -> dict[tuple[str, str], tuple[Rate, str]]:
    """Selectively verified rates, checked against a provider's own documentation.

    Empty by default. This is an editorial overlay for important rates, gaps and
    conditions the catalogue cannot express — not a second data pipeline.
    """
    target = Path(path) if path else _REPO_ROOT / "catalogue" / "official-verified.json"
    if not target.exists():
        return {}
    try:
        raw = json.loads(target.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    out: dict[tuple[str, str], tuple[Rate, str]] = {}
    for row in raw.get("verified") or []:
        if not isinstance(row, dict):
            continue
        provider = str(row.get("provider") or "").lower().strip()
        model = str(row.get("model") or "").strip()
        if not provider or not model:
            continue
        try:
            rate = Rate(input=float(row["input"]), output=float(row["output"]),
                        cache_read=float(row["cache_read"]) if row.get("cache_read") is not None else None,
                        cache_write=float(row["cache_write"]) if row.get("cache_write") is not None else None)
        except (KeyError, TypeError, ValueError):
            continue
        windows = []
        for window in row.get("windows") or []:
            try:
                start = int(window["start_minute"]); end = int(window["end_minute"])
            except (KeyError, TypeError, ValueError):
                continue
            days = window.get("days")
            days = frozenset(int(d) for d in days) if isinstance(days, list) and days else None
            def opt(key):
                value = window.get(key)
                return float(value) if isinstance(value, (int, float)) else None
            windows.append((days, start, end, opt("input"), opt("output"),
                            opt("cache_read"), opt("cache_write")))
        out[(provider, model)] = (rate, str(row.get("verified_at") or ""), tuple(windows))
    return out


def _parse_catalogue(raw: Any, *, source: str, confidence: str, as_of: str, version: str,
                     official: Optional[dict] = None) -> Optional[Catalogue]:
    if not isinstance(raw, dict):
        return None
    providers_raw = raw.get("providers")
    if not isinstance(providers_raw, dict):
        # models.dev cache shape: {"data": {provider: {"models": {...}}}}
        data = raw.get("data", raw)
        if not isinstance(data, dict):
            return None
        providers_raw = data

    providers: dict[str, dict[str, Rate]] = {}
    for provider, entry in providers_raw.items():
        if not isinstance(provider, str) or not isinstance(entry, dict):
            continue
        models_raw = entry.get("models")
        if not isinstance(models_raw, dict):
            # bundled shape: provider -> {model: {cost...}} or {model: rate...}
            models_raw = entry
        models: dict[str, Rate] = {}
        for model, model_entry in models_raw.items():
            if not isinstance(model, str) or not isinstance(model_entry, dict):
                continue
            cost = model_entry.get("cost")
            if cost is None and any(k in model_entry for k in ("input", "output")):
                cost = model_entry
            rate = _rate_from_cost(cost)
            if rate is not None:
                models[model] = rate
        if models:
            providers[provider] = models

    if not providers:
        return None
    return Catalogue(
        providers=providers,
        source=source,
        confidence=confidence,
        as_of=as_of,
        version=version,
        official=official or {},
    )


def _iso_mtime(path: Path) -> str:
    try:
        return datetime.fromtimestamp(path.stat().st_mtime, timezone.utc).isoformat()
    except OSError:
        return ""


def _load_json(path: Path) -> Any:
    with path.open(encoding="utf-8-sig") as handle:
        return json.load(handle)


def _default_cache_path() -> Path:
    """Active Hermes home's models.dev cache (profile-aware when available)."""
    try:
        from hermes_constants import get_hermes_home  # type: ignore

        return Path(get_hermes_home()) / "models_dev_cache.json"
    except Exception:
        return Path.home() / ".hermes" / "models_dev_cache.json"


def load_catalogue(models_dev_cache: Optional[Path] = None) -> Catalogue:
    """Load the freshest available price book.

    Order: Hermes' models.dev cache (authoritative, refreshed by Hermes), then
    the bundled snapshot. The cache is 5-6 MB and read once per request; the
    report is small, so this stays comfortably sub-second.
    """
    cache_path = Path(
        models_dev_cache
        or os.environ.get("HERMES_MODELS_DEV_CACHE")
        or _default_cache_path()
    )
    if cache_path.exists():
        try:
            stat = cache_path.stat()
        except OSError:
            stat = None
        key = (str(cache_path), stat.st_mtime, stat.st_size) if stat else None
        if key:
            with _CATALOGUE_LOCK:
                cached = _CATALOGUE_CACHE.get(key)
            if cached is not None:
                return cached
        official = load_official()
        try:
            catalogue = _parse_catalogue(
                _load_json(cache_path),
                source=f"models.dev cache ({cache_path.name})",
                confidence="aggregator",
                as_of=_iso_mtime(cache_path),
                version="models.dev",
                official=official,
            )
            if catalogue:
                if key:
                    with _CATALOGUE_LOCK:
                        _CATALOGUE_CACHE.clear()
                        _CATALOGUE_CACHE[key] = catalogue
                return catalogue
        except (OSError, ValueError):
            pass

    if _BUNDLED.exists():
        try:
            catalogue = _parse_catalogue(
                _load_json(_BUNDLED),
                source="bundled models.dev snapshot",
                confidence="bundled",
                as_of=str(json.loads(_BUNDLED.read_text(encoding="utf-8")).get("generated_at") or ""),
                version=str(json.loads(_BUNDLED.read_text(encoding="utf-8")).get("version") or "bundled"),
                official=load_official(),
            )
            if catalogue:
                return catalogue
        except (OSError, ValueError):
            pass

    return Catalogue(providers={}, source="none", confidence="none", as_of="", version="none",
                     official=load_official())


def _effective_rate(rate: Rate, avg_prompt: float) -> tuple[Rate, bool]:
    """Apply whole-request context tiers (models.dev semantics).

    Per-call prompt sizes are not stored, so the caller passes the average
    prompt size of the row. This is a heuristic; the report labels it.
    """
    if not rate.tiers or avg_prompt <= 0:
        return rate, False
    applicable = [t for t in rate.tiers if avg_prompt > t.threshold]
    if not applicable:
        return rate, False
    tier = max(applicable, key=lambda t: t.threshold)
    return (
        Rate(
            input=tier.input if tier.input is not None else rate.input,
            output=tier.output if tier.output is not None else rate.output,
            cache_read=tier.cache_read if tier.cache_read is not None else rate.cache_read,
            cache_write=tier.cache_write if tier.cache_write is not None else rate.cache_write,
            tiers=(),
        ),
        True,
    )


def _amount(rate: Rate, input_tokens: int, output_tokens: int,
            cache_read_tokens: int, cache_write_tokens: int) -> tuple[float, float]:
    """Return (USD, cache savings) at one rate row."""
    in_rate = rate.input if rate.input is not None else 0.0
    out_rate = rate.output if rate.output is not None else 0.0
    cache_read_rate = rate.cache_read if rate.cache_read is not None else in_rate
    cache_write_rate = rate.cache_write if rate.cache_write is not None else in_rate
    usd = (
        input_tokens * in_rate
        + cache_read_tokens * cache_read_rate
        + cache_write_tokens * cache_write_rate
        + output_tokens * out_rate
    ) / M
    savings = cache_read_tokens * max(0.0, in_rate - cache_read_rate) / M
    return usd, savings


def price(
    rate: Rate,
    *,
    input_tokens: int = 0,
    output_tokens: int = 0,
    cache_read_tokens: int = 0,
    cache_write_tokens: int = 0,
    calls: int = 0,
) -> Priced:
    """Price one usage row, returning a base and an upper bound.

    Context tiers apply per request in the vendor's price book, but Hermes
    stores one aggregate per session/model. With only the average prompt size
    we cannot know how many calls crossed the threshold. Rather than guess:

    * ``usd`` uses base rates for every token (a conservative lower bound);
    * ``usd_upper`` uses the tier for every token when the average suggests the
      threshold was crossed (an upper bound);
    * ``tier_possible`` tells the caller the two differ, so the UI can show
      "from $X (up to $Y)" instead of a false point estimate.
    """
    input_tokens = max(0, int(input_tokens or 0))
    output_tokens = max(0, int(output_tokens or 0))
    cache_read_tokens = max(0, int(cache_read_tokens or 0))
    cache_write_tokens = max(0, int(cache_write_tokens or 0))
    prompt_tokens = input_tokens + cache_read_tokens + cache_write_tokens
    # No call count means no defensible per-call average; stay at base rates.
    avg_prompt = prompt_tokens / calls if calls and calls > 0 else 0.0

    if rate.input is None or rate.output is None:
        return Priced(None, None, False, False, False, None, "no_base_rate")

    tiered, tier_possible = _effective_rate(rate, avg_prompt)
    base_usd, savings = _amount(rate, input_tokens, output_tokens,
                                cache_read_tokens, cache_write_tokens)
    upper_usd = (_amount(tiered, input_tokens, output_tokens,
                         cache_read_tokens, cache_write_tokens)[0]
                 if tier_possible else base_usd)

    cache_read_defaulted = cache_read_tokens > 0 and rate.cache_read is None
    cache_write_defaulted = cache_write_tokens > 0 and rate.cache_write is None

    return Priced(
        usd=round(base_usd, 6),
        usd_upper=round(max(base_usd, upper_usd), 6),
        tier_possible=tier_possible and upper_usd > base_usd,
        cache_read_defaulted=cache_read_defaulted,
        cache_write_defaulted=cache_write_defaulted,
        cache_savings=round(savings, 6),
        reason="ok",
    )
