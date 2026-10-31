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
        log.debug("wolfmark-cost-ledger: ctx.register_hook unavailable; collector disabled")
        return
    # Capture the cumulative baseline before hooks can record events, so
    # reconciliation compares like with like. One small read; failure is
    # non-fatal.
    try:
        store.bootstrap()
    except Exception:
        log.debug("wolfmark-cost-ledger: baseline bootstrap failed")
    for name in _HOOKS:
        try:
            register(name, _HANDLERS[name])
        except Exception:
            log.warning("wolfmark-cost-ledger: could not register %s; continuing", name)


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
        "api_mode": _text(kwargs.get("api_mode"), 40),
        "aux_task": _text(kwargs.get("aux_task"), 64),
        "streaming": bool(kwargs.get("streaming") or kwargs.get("first_chunk_at")),
        "api_call_count": _int(kwargs.get("api_call_count")),
        "error_type": _safe_error_type(error_type),
        "status_code": status,
        "recorded_at": time.time(),
        **usage,
    }


def _post_api_request(**kwargs: Any) -> None:
    try:
        record = _base_record("main", kwargs)
        record["outcome"] = "ok" if record["total_tokens"] > 0 else "missing_usage"
        store.record(record)
    except Exception:
        log.debug("wolfmark-cost-ledger: post_api_request record failed")


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
    except Exception:
        log.debug("wolfmark-cost-ledger: post_auxiliary_call record failed")


def _api_request_error(**kwargs: Any) -> None:
    try:
        record = _base_record("main", kwargs)
        record["outcome"] = "error"
        # Preserve any usage the provider reported for the failed attempt; the
        # report counts it as unpriced rather than pretending it was free.
        store.record(record)
    except Exception:
        log.debug("wolfmark-cost-ledger: api_request_error record failed")


_HANDLERS = {
    "post_api_request": _post_api_request,
    "post_auxiliary_call": _post_auxiliary_call,
    "api_request_error": _api_request_error,
}
