"""Upgrade/downgrade tests use the unmodified 0.6.0 base-commit implementation."""
import json
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

from test.fixtures.legacy_060 import membership as legacy_membership
from test.fixtures.legacy_060 import membership_store as legacy_store
from wolfmark_ledger import membership as mem, membership_api as api, membership_store as store, user_data
try:
    from dashboard import plugin_api
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
except ImportError:
    FastAPI = None

PLAN = 'openai-codex.chatgpt-business-premium'


def revision(ident, quantity, when, period='month'):
    return {'id': ident, 'plan_id': PLAN, 'quantity': quantity, 'period': period, 'effective_from': when}


class SeatStorageCompatibilityTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / 'memberships.json'
        self.billing = Path(self.tmp.name) / 'billing-profiles.json'
        self.original = {'id': 'openai-codex:default', 'family': 'openai-codex', 'identity': 'test-account',
                         'plan_id': PLAN, 'route_slugs': ['openai-codex'], 'manual_exhaustions': [],
                         'fee_overrides': [{'id': 'my-fee', 'amount': 330, 'currency': 'USD',
                                            'period': 'month', 'effective_from': '2026-11-08T00:00:00Z'}]}
        self.saved = legacy_store.save_account(self.original, self.path)['account']
        self.billing.write_text('{"version":1,"profiles":[]}')
        self.book = api.load_plans()

    def append(self, quantity, date, ident):
        current = store.load_with_seats(self.path)['accounts'][0]
        return store.append_seat_revision(self.original['id'], revision(ident, quantity, date),
                                          if_rev=current['rev'], if_seat_rev=current['seat_rev'], path=self.path)

    def test_upgrade_downgrade_reupgrade_uses_real_060_store(self):
        before = self.path.read_bytes()
        self.append(2, '2026-11-05T00:00:00Z', 'two')
        self.append(3, '2026-11-06T00:00:00Z', 'three')
        self.assertEqual(self.path.read_bytes(), before)
        old = legacy_store.load_store(self.path, strict=True)['accounts'][0]
        self.assertFalse(legacy_membership.validation_errors({k: v for k, v in old.items() if k != 'rev'}))
        self.assertNotIn('seat_revisions', old)
        old = legacy_store.save_account({**old, 'label': 'Edited in 0.6.0'}, self.path, if_rev=old['rev'])['account']
        upgraded = store.load_with_seats(self.path)['accounts'][0]
        self.assertEqual(upgraded['label'], 'Edited in 0.6.0')
        self.assertEqual(upgraded['fee_overrides'], self.original['fee_overrides'])
        self.assertEqual([r['quantity'] for r in upgraded['seat_revisions']], [2, 3])
        self.assertEqual(mem.resolve_fee(upgraded, self.book, '2026-11-05T12:00:00Z')['effective']['amount'], 250)
        self.assertEqual(mem.resolve_fee(upgraded, self.book, '2026-11-07T00:00:00Z')['effective']['amount'], 375)
        self.assertEqual(mem.resolve_fee(upgraded, self.book, '2026-11-09T00:00:00Z')['effective']['amount'], 330)
        self.assertEqual(mem.resolve_fee(upgraded, self.book, '2026-11-09T00:00:00Z')['calculated']['amount'], 375)

    def test_ordinary_save_strips_echoed_seats_and_preserves_history(self):
        self.append(3, '2026-11-06T00:00:00Z', 'three')
        card = api.accounts_payload(path=self.path, catalogue=self.book)['accounts'][0]
        seat_before = store.seat_store_path(self.path).read_bytes()
        api.save_payload(card['id'], {**card, 'label': 'renamed', 'seat_revisions': []}, path=self.path)
        self.assertEqual(store.seat_store_path(self.path).read_bytes(), seat_before)
        self.assertNotIn('seat_revisions', legacy_store.load_store(self.path, strict=True)['accounts'][0])
        self.assertEqual(len(store.load_with_seats(self.path)['accounts'][0]['seat_revisions']), 1)

    def test_both_membership_and_seat_revisions_are_checked(self):
        card = store.load_with_seats(self.path)['accounts'][0]
        self.append(2, '2026-11-05T00:00:00Z', 'two')
        with self.assertRaises(store.MembershipConflict):
            store.append_seat_revision(card['id'], revision('three', 3, '2026-11-06T00:00:00Z'),
                                       if_rev=card['rev'], if_seat_rev=card['seat_rev'], path=self.path)
        latest = store.load_with_seats(self.path)['accounts'][0]
        legacy_store.save_account({**self.saved, 'label': 'new'}, self.path, if_rev=self.saved['rev'])
        with self.assertRaises(store.MembershipConflict):
            store.append_seat_revision(card['id'], revision('three', 3, '2026-11-06T00:00:00Z'),
                                       if_rev=latest['rev'], if_seat_rev=latest['seat_rev'], path=self.path)
        self.assertEqual(len(store.load_seat_store(self.path)['accounts'][card['id']]['revisions']), 1)

    def test_concurrent_seat_edits_do_not_overwrite_one_another(self):
        card = store.load_with_seats(self.path)['accounts'][0]
        barrier = threading.Barrier(2)
        def update(quantity):
            barrier.wait()
            try:
                store.append_seat_revision(card['id'], revision(str(quantity), quantity, '2026-11-06T00:00:00Z'),
                                           if_rev=card['rev'], if_seat_rev=card['seat_rev'], path=self.path)
                return 'saved'
            except store.MembershipConflict:
                return 'conflict'
        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(update, (2, 3)))
        self.assertCountEqual(results, ['saved', 'conflict'])
        self.assertEqual(len(store.load_with_seats(self.path)['accounts'][0]['seat_revisions']), 1)

    def test_corrupt_sidecar_fails_closed_for_read_write_and_reset(self):
        sidecar = store.seat_store_path(self.path)
        sidecar.write_bytes(b'{"version":1,"accounts":false}')
        old_members = self.path.read_bytes()
        old_billing = self.billing.read_bytes()
        with self.assertRaises(store.StoreUnreadable):
            api.accounts_payload(path=self.path, catalogue=self.book)
        with self.assertRaises(store.StoreUnreadable):
            store.append_seat_revision(self.original['id'], revision('x', 2, '2026-11-05T00:00:00Z'),
                                       if_rev=self.saved['rev'], if_seat_rev='bad', path=self.path)
        with self.assertRaises(store.StoreUnreadable):
            store.save_account({**self.saved, 'label': 'changed'}, self.path, if_rev=self.saved['rev'])
        with self.assertRaises(store.StoreUnreadable):
            user_data.reset_user_data(self.path, self.billing)
        self.assertEqual(self.path.read_bytes(), old_members)
        self.assertEqual(self.billing.read_bytes(), old_billing)
        self.assertEqual(sidecar.read_bytes(), b'{"version":1,"accounts":false}')

    def test_unreadable_sidecar_is_not_treated_as_missing(self):
        sidecar = store.seat_store_path(self.path)
        sidecar.write_text('{}')
        read_text = Path.read_text
        def read(path, *args, **kwargs):
            if path == sidecar:
                raise PermissionError('not readable')
            return read_text(path, *args, **kwargs)
        with patch.object(Path, 'read_text', read):
            with self.assertRaises(store.StoreUnreadable):
                store.load_with_seats(self.path)

    def test_atomic_failure_does_not_replace_existing_history(self):
        self.append(2, '2026-11-05T00:00:00Z', 'two')
        card = store.load_with_seats(self.path)['accounts'][0]
        sidecar = store.seat_store_path(self.path)
        before = sidecar.read_bytes()
        with patch.object(store.os, 'replace', side_effect=OSError('failed')):
            with self.assertRaises(OSError):
                store.append_seat_revision(card['id'], revision('three', 3, '2026-11-06T00:00:00Z'),
                                           if_rev=card['rev'], if_seat_rev=card['seat_rev'], path=self.path)
        self.assertEqual(sidecar.read_bytes(), before)
        self.assertEqual(len(store.load_with_seats(self.path)['accounts'][0]['seat_revisions']), 1)

    def test_backup_and_reset_include_full_seat_store(self):
        self.append(3, '2026-11-06T00:00:00Z', 'three')
        exported = api.accounts_payload(path=self.path, catalogue=self.book)
        self.assertEqual(exported['seat_store'], store.load_seat_store(self.path))
        self.assertEqual(exported['membership_store']['accounts'][0], self.saved)
        self.assertTrue(user_data.reset_user_data(self.path, self.billing)['seat_history_cleared'])
        self.assertEqual(store.load_seat_store(self.path)['accounts'], {})
        self.path.write_text(json.dumps(exported['membership_store']))
        store.seat_store_path(self.path).write_text(json.dumps(exported['seat_store']))
        self.assertEqual(store.load_with_seats(self.path)['accounts'][0]['seat_revisions'][0]['quantity'], 3)

    def test_mismatched_identity_fails_closed(self):
        self.append(2, '2026-11-05T00:00:00Z', 'two')
        with self.assertRaises(store.MembershipConflict):
            store.save_account({**self.saved, 'identity': 'different-account'}, self.path, if_rev=self.saved['rev'])
        legacy_store.save_account({**self.saved, 'identity': 'different-account'}, self.path, if_rev=self.saved['rev'])
        with self.assertRaises(store.StoreUnreadable):
            store.load_with_seats(self.path)

    def test_profile_isolation(self):
        other = Path(self.tmp.name) / 'other-profile' / 'memberships.json'
        legacy_store.save_account(self.original, other)
        self.append(2, '2026-11-05T00:00:00Z', 'two')
        self.assertEqual(store.load_with_seats(other)['accounts'][0]['seat_revisions'], [])
        self.assertFalse(store.seat_store_path(other).exists())

    def test_reset_rolls_back_when_seat_file_cannot_be_replaced(self):
        self.append(2, '2026-11-05T00:00:00Z', 'two')
        paths = [self.path, self.billing, store.seat_store_path(self.path)]
        before = [path.read_bytes() for path in paths]
        replace = user_data._replace_bytes
        def fail_seats(path, contents):
            if path == paths[2]:
                raise OSError('seat replacement failed')
            return replace(path, contents)
        with patch.object(user_data, '_replace_bytes', side_effect=fail_seats):
            with self.assertRaises(OSError):
                user_data.reset_user_data(self.path, self.billing)
        self.assertEqual([path.read_bytes() for path in paths], before)

    @unittest.skipUnless(FastAPI is not None, 'FastAPI/httpx not installed')
    def test_http_updates_are_separate_and_stale_edits_conflict(self):
        app = FastAPI()
        app.include_router(plugin_api.router, prefix='/api/plugins/spend-sense')
        with patch.object(store, 'store_path', return_value=self.path), \
                patch.object(api, 'active_catalogue', return_value=(self.book, 'bundled')), TestClient(app) as client:
            root = '/api/plugins/spend-sense/membership/accounts'
            response = client.get(root)
            self.assertEqual(response.status_code, 200)
            card = response.json()['accounts'][0]
            request = {'revision': revision('r1', 3, '2026-11-06T00:00:00Z'),
                       'rev': card['rev'], 'seat_rev': card['seat_rev']}
            url = root + '/openai-codex:default/seats'
            self.assertEqual(client.put(url, json=request).status_code, 200)
            self.assertEqual(client.put(url, json=request).status_code, 409)
            flat_request = {**request, 'revision': {**request['revision'], 'plan_id': 'openai-codex.chatgpt-plus'}}
            self.assertEqual(client.put(url, json=flat_request).status_code, 422)
            raw = legacy_store.load_store(self.path, strict=True)['accounts'][0]
            self.assertNotIn('seat_revisions', raw)
            self.assertEqual(len(client.get(root).json()['accounts'][0]['seat_revisions']), 1)
            store.seat_store_path(self.path).write_bytes(b'{broken')
            self.assertEqual(client.get(root).status_code, 503)
            self.assertEqual(client.put(url, json=request).status_code, 503)


if __name__ == '__main__':
    unittest.main()
