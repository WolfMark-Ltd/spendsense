"""Evidence-only monthly budget calculations, with local calendar boundaries.

Estimated usage value reuses strict per-call catalogue pricing. The current
collector supplies token accounting, not per-call charges; its adapter leaves
actual metered amounts unknown. ``evaluate`` also
accepts explicit charge evidence for deterministic validation and a future
provider-confirmed charge adapter; catalogue prices never fill that field.
"""
from __future__ import annotations

import calendar
import math
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

from . import budgets, economics, membership, store
from .aggregate import _event_result
from .db import LedgerUnavailable
from .pricing import load_catalogue

RANK = {'normal': 0, 'info': 1, 'warning': 2, 'exceeded': 3}


def cycle_bounds(budget: dict, now: float) -> dict:
    zone = ZoneInfo(budget['timezone'])
    moment = datetime.fromtimestamp(now, zone)

    def anchor(year, month):
        return datetime(year, month, min(budget['cycle_day'], calendar.monthrange(year, month)[1]), tzinfo=zone)

    start = anchor(moment.year, moment.month)
    if moment < start:
        start = anchor(moment.year - 1, 12) if moment.month == 1 else anchor(moment.year, moment.month - 1)
    end = anchor(start.year + 1, 1) if start.month == 12 else anchor(start.year, start.month + 1)
    return {'id': start.isoformat(), 'start': start.isoformat(), 'end': end.isoformat(),
            'since': start.timestamp(), 'until': end.timestamp(), 'timezone': budget['timezone']}


def _amount(row):
    value = row.get('actual_metered_usd')
    if row.get('measurement') != 'actual_metered' or type(value) not in (int, float):
        return None
    try:
        return value if math.isfinite(value) and value >= 0 else None
    except OverflowError:
        return None


def _matches(row, budget):
    return ((budget['scope'] == 'total' or row.get('provider') == budget.get('provider'))
            and (budget['scope'] != 'model_route' or row.get('model') == budget.get('model')))


def evaluate(budget: dict, rows: list[dict], *, now: float, observed_since: float | None,
             ledger_available: bool = True, fx: dict | None = None) -> dict:
    """Calculate one limit; unknown evidence is never zero or an invoice.

    Forecasts require 3 active days and 100% charge AND price coverage in their
    sample. Burn averages include inactive observed days, never just active days.
    Each budget selects actual metered OR API-equivalent value, never both.
    """
    cycle = cycle_bounds(budget, now)
    zone = ZoneInfo(budget['timezone'])
    current = datetime.fromtimestamp(now, zone)
    selected = []
    seen = set()
    for row in rows:
        if not _matches(row, budget) or row['ts'] > now:
            continue
        # One recorded physical attempt, even if an adapter repeats it.
        event_id = row.get('event_id')
        if event_id and event_id in seen:
            continue
        if event_id:
            seen.add(event_id)
        selected.append(row)
    cycle_rows = [r for r in selected if cycle['since'] <= r['ts'] < cycle['until']]
    estimated = budget['measurement'] == 'api_equivalent'
    def measured(row):
        if estimated:
            value = row.get('list_usd')
            return value if type(value) in (int, float) and math.isfinite(value) and value >= 0 and row.get('outcome') == 'ok' else None
        return _amount(row)
    charges = [measured(r) for r in cycle_rows]
    known = [v for v in charges if v is not None]
    complete = bool(ledger_available and observed_since is not None and observed_since <= cycle['since']
                    and len(known) == len(cycle_rows))
    conversion = 1.0 if budget['currency'] == 'USD' else None
    citation = None
    if conversion is None and fx and not fx.get('error'):
        rate = next((r for r in fx.get('rates', []) if r['currency'] == budget['currency']), None)
        rate_at = membership._epoch(rate['as_of']) if rate else None
        if rate and rate_at is not None and math.isfinite(rate_at) and rate_at <= now:
            candidate = 1.0 / rate['usd_per_unit']
            if math.isfinite(candidate) and math.isfinite(sum(known) * candidate):
                conversion = candidate
                citation = {k: rate[k] for k in ('currency', 'usd_per_unit', 'as_of', 'source')}
    spend = round(sum(known) * conversion, 6) if conversion is not None and (known or complete) else None
    state = budgets.level(spend, budget)
    if not complete and state == 'normal':
        state = 'unavailable'
    result = {'id': budget['id'], 'budget': budget, 'budget_rev': budgets.revision(budget),
              'cycle': cycle, 'measurement': budget['measurement'], 'spend': spend,
              'remaining': round(budget['amount'] - spend, 6) if spend is not None and complete else None,
              'percentage': spend / budget['amount'] * 100 if spend is not None else None,
              'complete': complete, 'level': state, 'fx': citation,
              'coverage': {'calls': len(cycle_rows), 'measured_calls': len(known),
                           'measurement_coverage': len(known) / len(cycle_rows) if cycle_rows else None,
                           'observed_since': observed_since, 'cycle_observed': bool(observed_since is not None and observed_since <= cycle['since']),
                           'priced_calls': sum(r.get('list_usd') is not None for r in cycle_rows)},
              'forecast': {'available': False, 'reason': 'ledger_unavailable', 'burn_7': None,
                           'burn_30': None, 'projected': None, 'breach_date': None,
                           'days_remaining': None, 'trend': None, 'samples': {}}}
    forecast = result['forecast']
    if not budget['enabled']:
        forecast['reason'] = 'disabled'
        return result
    if not ledger_available:
        return result
    if observed_since is None:
        forecast['reason'] = 'insufficient_days'
        return result
    if conversion is None:
        forecast['reason'] = 'currency_unavailable'
        return result
    for days in (7, 30):
        # Resolve midnight in the named zone; DST changes elapsed seconds but
        # never removes or duplicates a calendar day in a daily average.
        first_day = current.date() - timedelta(days=days - 1)
        midnight = datetime.combine(first_day, datetime.min.time(), zone).timestamp()
        start = max(midnight, observed_since)
        sample = [r for r in selected if start <= r['ts'] <= now]
        active = len({datetime.fromtimestamp(r['ts'], zone).date() for r in sample})
        priced = sum(r.get('list_usd') is not None and r.get('outcome') == 'ok' for r in sample)
        actual = [measured(r) for r in sample]
        metered = sum(v is not None for v in actual)
        # Fractional local calendar day avoids treating a partial first/today
        # as a full day. UTC timestamp subtraction alone miscounts DST days.
        def calendar_position(ts):
            dt = datetime.fromtimestamp(ts, zone)
            return dt.date().toordinal() + (dt.hour * 3600 + dt.minute * 60 + dt.second) / 86400
        span = max(0, calendar_position(now) - calendar_position(start))
        samples = {'calls': len(sample), 'active_days': active, 'observed_days': round(span, 4),
                   'measured_calls': metered, 'priced_calls': priced,
                   'priced_coverage': priced / len(sample) if sample else 0,
                   'measurement_coverage': metered / len(sample) if sample else 0,
                   'since': datetime.fromtimestamp(start, zone).isoformat()}
        forecast['samples'][str(days)] = samples
        if active >= 3 and sample and priced == metered == len(sample) and span > 0:
            forecast[f'burn_{days}'] = sum(actual) * conversion / span
    sample = forecast['samples']['30']
    if sample['active_days'] < 3:
        forecast['reason'] = 'insufficient_days'
    elif sample['measurement_coverage'] < 1:
        forecast['reason'] = 'incomplete_pricing' if estimated else 'metered_unavailable'
    elif sample['priced_coverage'] < 1:
        forecast['reason'] = 'incomplete_pricing'
    elif not complete:
        forecast['reason'] = 'incomplete_cycle'
    elif forecast['burn_30'] is None:
        forecast['reason'] = 'insufficient_days'
    else:
        burn = forecast['burn_30']
        end = datetime.fromisoformat(cycle['end'])
        remaining_days = max(0, (end.date() - current.date()).days
                             - (current.hour * 3600 + current.minute * 60 + current.second) / 86400)
        forecast.update(available=True, reason=None,
                        projected=round(spend + burn * remaining_days, 6))
        if burn > 0:
            runway = max(0, budget['amount'] - spend) / burn
            forecast['days_remaining'] = round(runway, 2)
            # Date-only prediction intentionally avoids spurious time precision.
            if runway < remaining_days:
                forecast['breach_date'] = (current + timedelta(days=runway)).date().isoformat()
        elif spend >= budget['amount']:
            forecast['breach_date'] = current.date().isoformat()
        if forecast['burn_7'] is not None and burn > 0:
            ratio = forecast['burn_7'] / burn
            forecast['trend'] = 'accelerating' if ratio > 1.1 else 'slowing' if ratio < .9 else 'steady'
    # Explain missing actual evidence first, even for sparse histories.
    if cycle_rows and not known:
        forecast['reason'] = 'incomplete_pricing' if estimated else 'metered_unavailable'
    return result


def build_report(*, path: Path | str | None = None, event_db_path=None, now=None,
                 catalogue=None, fx_path=None) -> dict:
    now = time.time() if now is None else now
    doc = budgets.load(path)
    monthly = [b for b in doc['budgets'] if b['scope'] != 'session']
    if not monthly:
        return {'ok': True, **doc, 'statuses': [],
                'generated_at': datetime.fromtimestamp(now, timezone.utc).isoformat(),
                'charge_evidence_supported': False}
    rows = []
    observed_since = None
    available = False
    try:
        conn = store.connect_reader(event_db_path)
        try:
            if conn is not None:
                info = store.recording_info(conn)
                # A baseline is observation evidence; first usage is only a
                # lower bound when an older store has no baseline.
                observed_since = info['baseline_at'] or info['since']
                starts = [cycle_bounds(b, now)['since'] for b in monthly]
                since = min(starts + [now - 32 * 86400])
                raw = store.query_calls(conn, since=since, until=now)
                book = catalogue if catalogue is not None else load_catalogue()
                for item in raw:
                    priced = _event_result(item, book, 'list', {'exact': {}}, at=item['ts'])
                    pricing = priced.get('pricing') or {}
                    # General analytics may display an input-rate fallback;
                    # a guardrail must not treat that guess as measured value.
                    explicit = not (pricing.get('cache_read_defaulted') or pricing.get('cache_write_defaulted'))
                    rows.append({**item, 'list_usd': priced['list_usd'] if explicit else None,
                                 'actual_metered_usd': None, 'measurement': 'unknown'})
                available = True
        finally:
            if conn is not None:
                conn.close()
    except LedgerUnavailable:
        pass
    fx = economics.load_fx(fx_path) if any(b['currency'] != 'USD' for b in monthly) else None
    results = [evaluate(b, rows, now=now, observed_since=observed_since,
                        ledger_available=available, fx=fx) for b in monthly]
    for result in results:
        dismissal = doc['dismissals'].get(result['id'], {})
        result['dismissed'] = (dismissal.get('cycle') == result['cycle']['id']
                               and dismissal.get('budget_rev') == result['budget_rev']
                               and RANK.get(dismissal.get('level'), -1) >= RANK.get(result['level'], 99))
    return {'ok': True, **doc, 'statuses': results, 'generated_at': datetime.fromtimestamp(now, timezone.utc).isoformat(),
            'charge_evidence_supported': False}
