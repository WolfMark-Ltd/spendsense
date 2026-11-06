#!/usr/bin/env python3
"""Export an unmerged PR test store to a separate recovery bundle; never edit the source."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from wolfmark_ledger import membership as mem, membership_store as store  # noqa: E402


def convert(raw):
    if (not isinstance(raw, dict) or set(raw) != {'version', 'accounts'}
            or type(raw['version']) is not int or raw['version'] != store.STORE_VERSION
            or not isinstance(raw['accounts'], list)):
        raise ValueError('invalid membership document')
    accounts, entries = [], {}
    for original in raw['accounts']:
        if not isinstance(original, dict):
            raise ValueError('invalid membership record')
        account = dict(original)
        has_seats = 'seat_revisions' in account
        revisions = account.pop('seat_revisions', [])
        if mem.seat_revision_errors(revisions):
            raise ValueError('invalid seat history')
        if has_seats:
            if account.get('identity') is not None and not isinstance(account['identity'], str):
                raise ValueError('invalid membership identity')
            account['rev'] = store.account_revision(account)
            if revisions:
                entries[account.get('id')] = {'family': account.get('family'),
                                              'identity': account.get('identity'),
                                              'revisions': revisions}
        accounts.append(account)
    if store._records_errors(accounts):
        raise ValueError('invalid membership record')
    return {'membership_store': {'version': store.STORE_VERSION, 'accounts': accounts},
            'seat_history': {'version': store.SEAT_STORE_VERSION, 'accounts': entries}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path, help='backed-up memberships.json from the earlier PR test build')
    parser.add_argument('output', type=Path, help='new recovery JSON file; must not already exist')
    args = parser.parse_args()
    try:
        result = convert(json.loads(args.source.read_text(encoding='utf-8')))
        payload = json.dumps(result, indent=2, sort_keys=True, allow_nan=False) + '\n'
        with args.output.open('x', encoding='utf-8') as target:
            target.write(payload)
    except (OSError, ValueError, TypeError, OverflowError) as exc:
        print(f'recovery export failed: {type(exc).__name__}', file=sys.stderr)
        return 1
    print('Recovery bundle created; the original file was not changed.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
