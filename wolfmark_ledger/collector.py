"""Observer-only per-call collector.

Registers three Hermes observer hooks and writes minimal accounting metadata to
the plugin-owned SQLite store. Every callback is fail-open: an error is logged
at debug level and the agent continues.

No prompt, response, request body, header or credential is read or stored.
"""

from __future__ import annotations

import hashlib
import logging
import time
import uuid
from typing import Any

try:
    from . import store
except ImportError:  # isolated capability probe loads collector as top-level
    import store  # type: ignore

log = logging.getLogger(__name__)

_HOOKS = ("post_api_request", "post_auxiliary_call", "api_request_error")


def install(ctx: Any) -> None:
    """Register the hooks. Missing support or a storage error never blocks Hermes."""
    register = getattr(ctx, "register_hook", None)
    if not callable(register):
        log.debug("spend-sense: ctx.register_hook unavailable; collector disabled")
        return
    # Capture the cumulative baseline before hooks can record events, so
    # reconciliation compares like with like. One small read; failure is
    # non-fatal.
    try:
        store.bootstrap()
    except Exception:
        log.debug("spend-sense: baseline bootstrap failed")
    for name in _HOOKS:
        try:
            register(name, _HANDLERS[name])
        except Exception:
            log.warning("spend-sense: could not register %s; continuing", name)


def _text(value: Any, limit: int = 160) -> str:
    if value is None:
        return ""
    out = str(value)
    return out[:limit]


def _int(value: Any) -> int:
    try:
        return max(0, int(value or 0))
    except (TypeError, ValueError):
        return 0


def _usage_tokens(usage: Any) -> dict[str, int]:
    if not isinstance(usage, dict):
        usage = {}
    input_tokens = _int(usage.get("input_tokens"))
    output_tokens = _int(usage.get("output_tokens"))
    cache_read = _int(usage.get("cache_read_tokens"))
    cache_write = _int(usage.get("cache_write_tokens"))
    reasoning = _int(usage.get("reasoning_tokens"))
    prompt = _int(usage.get("prompt_tokens")) or (input_tokens + cache_read + cache_write)
    total = _int(usage.get("total_tokens")) or (prompt + output_tokens)
    return {
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "cache_read_tokens": cache_read,
        "cache_write_tokens": cache_write,
        "reasoning_tokens": reasoning,
        "prompt_tokens": prompt,
        "total_tokens": total,
    }


def _usage_provenance(usage: Any) -> dict[str, int | None]:
    """Presence flags the hook supplied. Absent keys mean "not recorded"."""
    if not isinstance(usage, dict):
        return {"cache_read_reported": None, "cache_write_reported": None}
    return {
        "cache_read_reported": store.tri_flag(usage.get("cache_read_reported")),
        "cache_write_reported": store.tri_flag(usage.get("cache_write_reported")),
    }


def _call_class(kind: str, kwargs: dict[str, Any]) -> str | None:
    """``main``/``auxiliary`` when the producer proves it, else ``None``.

    ``post_auxiliary_call`` is auxiliary by construction. For the main-loop
    hook, an empty ``aux_task`` counts as main **only when the key is present**:
    its presence is the producer's promise that every non-main path labels
    itself. A build that does not send the key leaves the row unclassified.
    """
    if kind == "aux":
        return "auxiliary"
    if "aux_task" not in kwargs:
        return None
    return "auxiliary" if _text(kwargs.get("aux_task"), 64) else "main"


def _event_id(kind: str, kwargs: dict[str, Any]) -> str:
    raw_id = _text(kwargs.get("api_request_id"), 200)
    if raw_id:
        return f"{kind}:{raw_id}"
    parts = [
        kind,
        _text(kwargs.get("session_id"), 128),
        _text(kwargs.get("task_id"), 128),
        _text(kwargs.get("turn_id"), 128),
        _text(kwargs.get("api_call_count"), 32),
        _text(kwargs.get("started_at"), 32),
        _text(kwargs.get("ended_at"), 32),
        _text(kwargs.get("model"), 160),
        _text(kwargs.get("provider"), 80),
        _text(kwargs.get("aux_task"), 64),
    ]
    material = "|".join(parts)
    if not any(parts[1:]):
        return f"{kind}:fallback:{uuid.uuid4().hex}"
    return f"{kind}:fallback:{hashlib.sha256(material.encode('utf-8')).hexdigest()[:32]}"


# Only standard classifications are retained; untrusted error text can contain
# provider messages, credentials or user content and must not enter the ledger.
_SAFE_ERROR_TYPES = frozenset({
    "RateLimitError", "ConnectionError", "TimeoutError", "APIConnectionError",
    "APITimeoutError", "APIError", "APIStatusError", "AuthenticationError",
    "PermissionDeniedError", "BadRequestError", "InternalServerError",
    "ContentPolicyBlocked", "InvalidAPIResponse", "plugin_block",
})


def _safe_error_type(value: Any) -> str:
    if value is None or value == "":
        return ""
    return value if isinstance(value, str) and value in _SAFE_ERROR_TYPES else "other"


def _base_record(kind: str, kwargs: dict[str, Any]) -> dict[str, Any]:
    usage = _usage_tokens(kwargs.get("usage"))
    started = kwargs.get("started_at")
    ended = kwargs.get("ended_at")
    ts = ended if isinstance(ended, (int, float)) else started if isinstance(started, (int, float)) else time.time()
    error = kwargs.get("error")
    error_type = kwargs.get("error_type")
    if not error_type and isinstance(error, dict):
        error_type = error.get("type")
    status = kwargs.get("status_code")
    try:
        status = int(status) if status is not None else None
    except (TypeError, ValueError):
        status = None
    return {
        "event_id": _event_id(kind, kwargs),
        "ts": float(ts),
        "started_at": float(started) if isinstance(started, (int, float)) else None,
        "ended_at": float(ended) if isinstance(ended, (int, float)) else None,
        "session_id": _text(kwargs.get("session_id"), 128),
        "task_id": _text(kwargs.get("task_id"), 128),
        "turn_id": _text(kwargs.get("turn_id"), 128),
        "platform": _text(kwargs.get("platform"), 64),
        "model": _text(kwargs.get("model"), 160),
        "provider": _text(kwargs.get("provider"), 80),
        # Served-model provenance (F130). Pricing still follows the requested
        # model: relays can report snapshot ids the catalogue does not know,
        # and no substitution mispricing is proven. The column exists so a
        # future comparison can measure substitution if it ever matters.
        "response_model": _text(kwargs.get("response_model"), 160) or None,
        "api_mode": _text(kwargs.get("api_mode"), 40),
        "aux_task": _text(kwargs.get("aux_task"), 64),
        "streaming": bool(kwargs.get("streaming") or kwargs.get("first_chunk_at")),
        "api_call_count": _int(kwargs.get("api_call_count")),
        "error_type": _safe_error_type(error_type),
        "status_code": status,
        "recorded_at": time.time(),
        "call_class": _call_class(kind, kwargs),
        **usage,
        **_usage_provenance(kwargs.get("usage")),
    }


def _advisor_records(parent: dict[str, Any], kwargs: dict[str, Any]) -> list[dict[str, Any]]:
    """Per-slot MoA advisor rows for one hook call (F129).

    Hermes folds advisor fan-out spend into its own counters but hands the
    plugin aggregator-only usage; the per-advisor breakdown arrives
    separately as ``moa_references``. Each slot with a usable route and
    non-zero tokens becomes its own row (same turn, its own provider and
    model) so catalogue pricing attributes the spend instead of dropping
    it. Advisor text (``output``) is never stored. Slots without a route
    or without tokens are skipped: they carry no measurable spend.
    """
    refs = kwargs.get("moa_references")
    if not isinstance(refs, list) or not refs:
        return []
    rows: list[dict[str, Any]] = []
    for index, ref in enumerate(refs):
        if not isinstance(ref, dict):
            continue
        model = _text(ref.get("model"), 160)
        provider = _text(ref.get("provider"), 80)
        usage = _usage_tokens(ref.get("usage"))
        if not model or not provider or not any(usage.values()):
            continue
        rows.append({
            "event_id": f"{parent['event_id']}:moa:{index}",
            "ts": parent["ts"],
            "started_at": parent.get("started_at"),
            "ended_at": parent.get("ended_at"),
            "session_id": parent.get("session_id", ""),
            "task_id": parent.get("task_id", ""),
            "turn_id": parent.get("turn_id", ""),
            "platform": parent.get("platform", ""),
            "model": model,
            "provider": provider,
            "response_model": None,
            "api_mode": "",
            "aux_task": "",
            "streaming": False,
            "outcome": "ok",
            "api_call_count": 1,
            "error_type": "",
            "status_code": None,
            "recorded_at": time.time(),
            "call_class": parent.get("call_class"),
            **usage,
            **_usage_provenance(ref.get("usage")),
        })
    return rows


def _record_advisors(parent: dict[str, Any], kwargs: dict[str, Any], hook: str) -> None:
    for row in _advisor_records(parent, kwargs):
        try:
            store.record(row)
        except Exception:
            log.debug("spend-sense: %s advisor record failed", hook)


def _post_api_request(**kwargs: Any) -> None:
    try:
        record = _base_record("main", kwargs)
        record["outcome"] = "ok" if record["total_tokens"] > 0 else "missing_usage"
        store.record(record)
        _record_advisors(record, kwargs, "post_api_request")
    except Exception:
        log.debug("spend-sense: post_api_request record failed")


def _post_auxiliary_call(**kwargs: Any) -> None:
    try:
        record = _base_record("aux", kwargs)
        if kwargs.get("error"):
            record["outcome"] = "error"
        elif record["total_tokens"] > 0:
            record["outcome"] = "ok"
        else:
            record["outcome"] = "missing_usage"
        store.record(record)
        _record_advisors(record, kwargs, "post_auxiliary_call")
    except Exception:
        log.debug("spend-sense: post_auxiliary_call record failed")


def _api_request_error(**kwargs: Any) -> None:
    try:
        record = _base_record("main", kwargs)
        record["outcome"] = "error"
        # Preserve any usage the provider reported for the failed attempt; the
        # report counts it as unpriced rather than pretending it was free.
        store.record(record)
    except Exception:
        log.debug("spend-sense: api_request_error record failed")


_HANDLERS = {
    "post_api_request": _post_api_request,
    "post_auxiliary_call": _post_auxiliary_call,
    "api_request_error": _api_request_error,
}
