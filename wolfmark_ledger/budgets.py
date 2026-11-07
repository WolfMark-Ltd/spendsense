"""Local advisory limits. Actual charges and API-equivalent limits never mix.

A separate versioned document preserves downgrade compatibility. Every mutation
uses the shared process lock, a whole-document revision and an atomic replacement.
Unreadable existing documents are never repaired or overwritten implicitly.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import re
import tempfile
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from . import billing, membership
from .filelock import locked

DEFAULT_THRESHOLDS = [50, 80, 100]
MAX_BUDGETS = 100


def _finite(value):
    """Accept finite numbers while rejecting booleans and overflowing integers."""
    try:
        return type(value) in (int, float) and math.isfinite(value)
    except OverflowError:
        return False


class BudgetConflict(ValueError):
    pass


class BudgetStoreUnreadable(RuntimeError):
    pass


def store_path() -> Path:
    """Locate guardrails beside the active profile’s billing configuration."""
    return billing.profiles_path().with_name('budgets.json')


def revision(doc: dict) -> str:
    """Hash canonical configuration without its transport revision token."""
    return hashlib.sha256(json.dumps({k: v for k, v in doc.items() if k != 'rev'},
                                    sort_keys=True, separators=(',', ':'), allow_nan=False).encode()).hexdigest()[:16]


def validation_errors(budget: Any) -> list[str]:
    """Check scope, metric, amount, thresholds and cycle settings without writing."""
    if not isinstance(budget, dict):
        return ['budget must be an object']
    allowed = {'id', 'label', 'scope', 'provider', 'model', 'amount', 'currency', 'enabled',
               'thresholds', 'cycle_day', 'timezone', 'measurement'}
    errors = []
    if set(budget) - allowed:
        errors.append('unknown budget fields')
    if not isinstance(budget.get('id'), str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,80}', budget['id']):
        errors.append('invalid budget id')
    if not isinstance(budget.get('label'), str) or not 1 <= len(budget['label'].strip()) <= 120:
        errors.append('label must contain 1 to 120 characters')
    if not isinstance(budget.get('amount'), (int, float)) or isinstance(budget.get('amount'), bool):
        errors.append('amount must be a finite positive number')
    else:
        try:
            if not math.isfinite(budget['amount']) or not 0.000001 <= budget['amount'] <= 1e12:
                errors.append('amount must be between 0.000001 and 1000000000000')
        except OverflowError:
            errors.append('amount is too large')
    if not isinstance(budget.get('currency'), str) or budget['currency'] not in membership.CURRENCIES:
        errors.append('currency must be a supported uppercase ISO code')
    if type(budget.get('enabled')) is not bool:
        errors.append('enabled must be boolean')
    thresholds = budget.get('thresholds')
    if (not isinstance(thresholds, list) or len(thresholds) != 3
            or any(not _finite(v) for v in thresholds)
            or not 0 < thresholds[0] < thresholds[1] < thresholds[2] == 100):
        errors.append('thresholds must increase: informational, warning, 100')
    scope = budget.get('scope')
    if scope not in ('total', 'provider', 'model_route', 'session'):
        errors.append('invalid budget scope')
    for field in ('provider', 'model'):
        value = budget.get(field, '')
        if not isinstance(value, str) or len(value) > 200 or value != value.strip():
            errors.append(f'invalid {field}')
    if scope in ('provider', 'model_route') and not budget.get('provider'):
        errors.append('provider is required')
    if scope == 'model_route' and not budget.get('model'):
        errors.append('model is required')
    if scope in ('total', 'session') and (budget.get('provider') or budget.get('model')):
        errors.append('total and session limits cannot have route filters')
    if scope == 'provider' and budget.get('model'):
        errors.append('provider limits cannot have a model filter')
    if budget.get('measurement') not in ('actual_metered', 'api_equivalent') or (scope == 'session' and budget.get('measurement') != 'api_equivalent'):
        errors.append('measurement does not match scope')
    if scope == 'session' and budget.get('currency') != 'USD':
        errors.append('session API-equivalent limits use USD')
    if type(budget.get('cycle_day')) is not int or not 1 <= budget['cycle_day'] <= 31:
        errors.append('cycle_day must be an integer from 1 to 31')
    try:
        ZoneInfo(budget.get('timezone', ''))
    except (ZoneInfoNotFoundError, ValueError, TypeError):
        errors.append('timezone must be an IANA timezone')
    return errors


def load(path: Path | str | None = None) -> dict:
    """Read validated configuration; distinguish an absent store from a corrupt one."""
    target = Path(path) if path is not None else store_path()
    try:
        doc = json.loads(target.read_text(encoding='utf-8-sig'))
        if (not isinstance(doc, dict) or set(doc) != {'version', 'budgets', 'dismissals'}
                or type(doc['version']) is not int or doc['version'] != 1
                or not isinstance(doc['budgets'], list) or len(doc['budgets']) > MAX_BUDGETS
                or not isinstance(doc['dismissals'], dict)):
            raise ValueError('invalid document')
        ids = []
        for item in doc['budgets']:
            if validation_errors(item):
                raise ValueError('invalid budget')
            ids.append(item['id'])
        if len(set(ids)) != len(ids):
            raise ValueError('duplicate id')
        for key, entry in doc['dismissals'].items():
            if (key not in ids or not isinstance(entry, dict) or set(entry) != {'cycle', 'budget_rev', 'level'}
                    or not isinstance(entry['cycle'], str) or len(entry['cycle']) > 120
                    or not isinstance(entry['budget_rev'], str)
                    or entry['level'] not in ('info', 'warning', 'exceeded')):
                raise ValueError('invalid dismissal')
    except FileNotFoundError:
        doc = {'version': 1, 'budgets': [], 'dismissals': {}}
    except (OSError, ValueError, TypeError, KeyError, OverflowError) as exc:
        raise BudgetStoreUnreadable('budget store unreadable') from exc
    return {**doc, 'rev': revision(doc)}


def _write(doc: dict, target: Path) -> dict:
    """Fsync temporary JSON and atomically replace a validated budget document."""
    data = {k: v for k, v in doc.items() if k != 'rev'}
    handle = tempfile.NamedTemporaryFile('w', dir=target.parent, delete=False, suffix='.tmp', encoding='utf-8')
    try:
        json.dump(data, handle, indent=2, sort_keys=True, allow_nan=False)
        handle.flush()
        os.fsync(handle.fileno())
        handle.close()
        os.replace(handle.name, target)
    finally:
        try:
            if not handle.closed:
                handle.close()
        finally:
            if os.path.exists(handle.name):
                os.unlink(handle.name)
    return {**data, 'rev': revision(data)}


def mutate(budget_id: str, *, if_rev: str, budget: dict | None = None,
           dismissal: dict | None = None, path: Path | str | None = None) -> dict:
    """Apply a save, deletion or dismissal under the store lock and revision check."""
    target = Path(path) if path is not None else store_path()
    with locked(target):
        doc = load(target)
        if not if_rev or if_rev != doc['rev']:
            raise BudgetConflict('conflict: budgets changed; reload before saving')
        found = next((b for b in doc['budgets'] if b['id'] == budget_id), None)
        if dismissal is not None:
            if found is None:
                raise KeyError(budget_id)
            if (set(dismissal) != {'cycle', 'budget_rev', 'level'}
                    or dismissal.get('budget_rev') != revision(found)
                    or not isinstance(dismissal.get('cycle'), str) or len(dismissal['cycle']) > 120
                    or dismissal.get('level') not in ('info', 'warning', 'exceeded')):
                raise ValueError('invalid dismissal')
            doc['dismissals'][budget_id] = dismissal
        elif budget is not None:
            budget = {**budget, 'id': budget_id}
            errors = validation_errors(budget)
            if errors:
                raise ValueError('; '.join(errors))
            if found is None and len(doc['budgets']) >= MAX_BUDGETS:
                raise ValueError('too many budgets')
            doc['budgets'] = [budget if b['id'] == budget_id else b for b in doc['budgets']]
            if found is None:
                doc['budgets'].append(budget)
            doc['dismissals'].pop(budget_id, None)
        else:
            if found is None:
                raise KeyError(budget_id)
            doc['budgets'] = [b for b in doc['budgets'] if b['id'] != budget_id]
            doc['dismissals'].pop(budget_id, None)
        return _write(doc, target)


def level(amount: float | None, budget: dict) -> str:
    """Classify a limit without interpreting an unavailable amount as zero."""
    if not budget['enabled']:
        return 'disabled'
    if amount is None:
        return 'unavailable'
    pct = amount / budget['amount'] * 100
    for name, threshold in reversed(list(zip(('info', 'warning', 'exceeded'), budget['thresholds']))):
        if pct >= threshold:
            return name
    return 'normal'
