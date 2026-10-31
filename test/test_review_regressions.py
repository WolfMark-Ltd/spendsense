"""Regression checks use temporary stores and synthetic provider results only."""
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from wolfmark_ledger import billing, discovery, membership_store
from wolfmark_ledger import catalogue_revisions as revisions


class StoreSafety(unittest.TestCase):
    def test_bad_updates_and_discovery_never_replace_memberships(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'memberships.json'
            item = {'id':'example:default','family':'example','route_slugs':['example']}
            saved = membership_store.save_account(item, path)['account']
            before = path.read_bytes()
            for patch_value in ({'fee_overrides':[{}]}, {'manual_exhaustions':[{}]},
                                {'fee_overrides':{}}, {'billing_cycle':'bad'}):
                with self.subTest(patch_value=patch_value), self.assertRaises(ValueError):
                    membership_store.save_account({**saved, **patch_value}, path, if_rev=saved['rev'])
                self.assertEqual(path.read_bytes(), before)
                self.assertTrue(membership_store.load_store(path, strict=True)['accounts'])
            with self.assertRaises(ValueError):
                membership_store.upsert_discovered([{'id':'other','family':'example','fee_overrides':[{}]}], path)
            self.assertEqual(path.read_bytes(), before)

    def test_billing_bad_records_do_not_corrupt_existing_store(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'billing.json'
            billing.save_profile({'id':'a','provider':'example','kind':'api'},path)
            before = path.read_bytes()
            for bad in ({'id':'b','kind':'api'}, {'id':'b','provider':'x','kind':'api','rate_override':'bad'},
                        {'id':'b','provider':'x','kind':'api','billing_cycle':[]},
                        {'id':'b','provider':'x','kind':'api','allowances':{'m':None}},
                        {'id':'b','provider':'x','kind':'api','allowances':{'m':'abc'}},
                        {'id':'b','provider':'x','kind':'api','allowances':{'m':[1]}},
                        {'id':'b','provider':'x','kind':'api','allowances':{'m':float('nan')}},
                        {'id':'b','provider':'x','kind':'api','allowances':{'m':-1}}):
                with self.subTest(bad=bad), self.assertRaises(ValueError): billing.save_profile(bad,path)
                self.assertEqual(before,path.read_bytes())
                billing._load_profiles(path,strict=True)

    def test_invalid_saved_allowances_fail_closed_without_breaking_classification(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'billing.json'
            path.write_text(json.dumps({'profiles':[{'id':'bad','provider':'x','kind':'prepaid',
                                                     'allowances':{'m':None},'overage_paid':True}]}))
            loaded = billing.load_profiles(path)
            self.assertEqual(loaded['profiles'], [])
            self.assertIn('invalid allowance values', loaded['error'])
            report = billing.classify([{'provider':'x','model':'m','list_usd':1,'_tokens':1}], loaded)
            self.assertEqual(report['api_equivalent_usd'], 1)

    def test_native_source_is_normalised_before_storing(self):
        slots = {'anthropic':{'slots':1,'route_slugs':['anthropic']}}
        snapshot = {'source':'oauth_usage_api','provider':'anthropic','windows':[]}
        with patch.object(discovery,'credential_slots',return_value=slots), patch.object(discovery,'probe_providers',return_value={'anthropic':{'state':'ok','snapshot':snapshot}}):
            result = discovery.discover({},include_native=True)
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'memberships.json'
            membership_store.upsert_discovered(result['accounts'],path)
            self.assertEqual(membership_store.load_store(path,strict=True)['accounts'][0]['usage_source'],'usage_api')


class PricingSafety(unittest.TestCase):
    def test_custom_rate_prices_unlisted_model(self):
        rows=[{'provider':'example','model':'m','list_usd':None,'_tokens':1000000,'_input':1000000,'_output':0,'_cache_read':0,'_cache_write':0}]
        profiles={'profiles':[{'id':'p','provider':'example','kind':'custom','rate_override':{'input':2,'output':4}}]}
        result=billing.classify(rows,profiles)
        self.assertEqual(result['api_equivalent_usd'],2)
        self.assertEqual(result['unclassified_calls'],0)

    def test_scalar_allowance_is_shared_across_models(self):
        rows=[{'provider':'example','model':m,'list_usd':v,'_tokens':1} for m,v in [('a',7),('b',8)]]
        profiles={'profiles':[{'id':'p','provider':'example','kind':'prepaid','allowance_usd':10,'overage_paid':True}]}
        self.assertEqual(billing.classify(rows,profiles)['incremental_usd'],5)

    def test_zero_and_unlisted_model_allowances_count_as_prepaid_overage(self):
        rows=[{'provider':'example','model':model,'list_usd':value,'_tokens':1}
              for model,value in [('m',2),('unlisted',3)]]
        profiles={'profiles':[{'id':'p','provider':'example','kind':'prepaid',
                               'allowances':{'m':0},'overage_paid':True}]}
        self.assertEqual(billing.classify(rows,profiles)['incremental_usd'],5)

    def test_zero_allowance_on_api_profile_is_not_double_counted(self):
        rows=[{'provider':'example','model':'m','list_usd':2,'_tokens':1}]
        profiles={'profiles':[{'id':'p','provider':'example','kind':'api',
                               'allowances':{'m':0},'overage_paid':True}]}
        self.assertEqual(billing.classify(rows,profiles)['incremental_usd'],2)

    def test_custom_rates_do_not_price_failed_or_missing_usage_calls(self):
        profiles={'profiles':[{'id':'p','provider':'example','kind':'custom',
                               'rate_override':{'input':2,'output':4}}]}
        for flags in ({'_failure':True,'outcome':'failed'},
                      {'_missing':True,'outcome':'missing_usage'}):
            with self.subTest(flags=flags):
                row={'provider':'example','model':'m','list_usd':None,'_provider_cost_usd':None,
                     '_tokens':1000000,'_input':1000000,'_output':0,'_cache_read':0,'_cache_write':0,
                     **flags}
                result=billing.classify([row],profiles)
                self.assertIsNone(result['api_equivalent_usd'])
                self.assertEqual(result['incremental_usd'],0)
                self.assertEqual(result['unclassified_tokens'],1000000)

    def test_iterator_provider_total_does_not_consume_rows_twice(self):
        row={'provider':'x','model':'m','list_usd':1,'_provider_cost_usd':2,'_tokens':1}
        result=billing.classify(iter([row]),{'profiles':[]})
        self.assertEqual(result['provider_reported_usd'],2)

    def test_each_price_field_follows_its_own_decision(self):
        base={'plans':[{'id':'p','price':{'amount':10,'currency':'USD','period':'month'}}]}
        changes=[{'plan_id':'p','family':'x','materiality':'material','key':'amount','action':'price_changed',
                  'after':{'amount':20,'currency':'GBP','period':'year'}},
                 {'plan_id':'p','family':'x','materiality':'material','key':'currency','action':'currency_changed','after':'GBP'},
                 {'plan_id':'p','family':'x','materiality':'material','key':'period','action':'period_changed','after':'year'}]
        for decisions,expected in [({'amount':'accept','currency':'reject','period':'reject'},{'amount':20,'currency':'USD','period':'month'}),
                                   ({'amount':'reject','currency':'accept','period':'accept'},{'amount':10,'currency':'GBP','period':'year'})]:
            with self.subTest(decisions=decisions):
                result=revisions.build_candidate(base,[],{'changes':changes},decisions,version='test')
                self.assertEqual(result['plans'][0]['price'],expected)
                self.assertEqual(result['plans'][0]['verification']['status'],'unverified')

    def test_authored_price_correction_applies_the_full_price_and_stays_unverified(self):
        base={'plans':[{'id':'p','provider_family':'x','price':{'amount':10,'currency':'USD','period':'month'},
                        'verification':{'status':'verified','source_id':'old'}}]}
        report=revisions.correction_report(base,[{'plan_id':'p','field':'price',
            'value':{'amount':12,'currency':'GBP','period':'year'},'why':'correct the catalogue',
            'evidence':{'source_id':'pricing-page'}}])
        candidate=revisions.build_candidate(base,[],report,{'price_changed:p':'accept'},version='test')
        self.assertEqual(candidate['plans'][0]['price'],{'amount':12,'currency':'GBP','period':'year'})
        self.assertEqual(candidate['plans'][0]['verification']['status'],'unverified')

    def test_matched_price_verification_does_not_require_complete_family(self):
        base={'plans':[{'id':'p','provider_family':'x','name':'Plan',
                        'price':{'amount':10,'currency':'USD','period':'month'},
                        'verification':{'status':'unverified','source_id':'old'}}]}
        observation={'family':'x','source_id':'source','complete':False,'provisional':False,
                     'plans':[{'id':'p','name':'Plan','price':{'amount':10,'currency':'USD','period':'month'}}]}
        report=revisions.diff_report([observation],base)
        self.assertIn('verification_changed:p',[item['key'] for item in report['changes']])

    def test_same_amount_with_changed_terms_does_not_verify_the_old_price(self):
        base={'plans':[{'id':'p','provider_family':'x','name':'Plan',
                        'price':{'amount':10,'currency':'USD','period':'month'},
                        'verification':{'status':'unverified','source_id':'old'}}]}
        observation={'family':'x','source_id':'source','complete':True,'provisional':False,
                     'plans':[{'id':'p','name':'Plan','price':{'amount':10,'currency':'GBP','period':'year'}}]}
        report=revisions.diff_report([observation],base)
        self.assertNotIn('verification_changed:p',[item['key'] for item in report['changes']])

    def test_provisional_price_evidence_never_verifies_a_price(self):
        base={'plans':[{'id':'p','provider_family':'x','name':'Plan',
                        'price':{'amount':10,'currency':'USD','period':'month'},
                        'verification':{'status':'unverified','source_id':'old'}}]}
        same={'family':'x','source_id':'source','complete':True,'provisional':True,
              'plans':[{'id':'p','name':'Plan','price':{'amount':10,'currency':'USD','period':'month'}}]}
        report=revisions.diff_report([same],base)
        self.assertNotIn('verification_changed:p',[item['key'] for item in report['changes']])
        changed={**same,'plans':[{'id':'p','name':'Plan','price':{'amount':12,'currency':'GBP','period':'year'}}]}
        report=revisions.diff_report([changed],base)
        decisions={item['key']:'accept' for item in report['changes']}
        candidate=revisions.build_candidate(base,[changed],report,decisions,version='test')
        self.assertEqual(candidate['plans'][0]['price'],{'amount':12,'currency':'GBP','period':'year'})
        self.assertEqual(candidate['plans'][0]['verification']['status'],'unverified')

    def test_accepted_observed_currency_and_period_update_verification_as_a_unit(self):
        base={'plans':[{'id':'p','provider_family':'x','name':'Plan',
                        'price':{'amount':10,'currency':'USD','period':'month'},
                        'verification':{'status':'verified','source_id':'old'}}]}
        observation={'family':'x','source_id':'source','retrieved_at':'2026-10-31T00:00:00Z',
                     'complete':False,'plans':[{'id':'p','name':'Plan',
                     'price':{'amount':10,'currency':'GBP','period':'year'}}]}
        report=revisions.diff_report([observation],base)
        decisions={item['key']:'accept' for item in report['changes']}
        candidate=revisions.build_candidate(base,[observation],report,decisions,version='test')
        self.assertEqual(candidate['plans'][0]['price'],{'amount':10,'currency':'GBP','period':'year'})
        self.assertEqual(candidate['plans'][0]['verification']['status'],'verified')

    def test_unlimited_paid_profile_is_not_double_charged(self):
        row={'provider':'x','model':'m','list_usd':15,'_tokens':1}
        result=billing.classify([row],{'profiles':[{'id':'p','provider':'x','kind':'api','overage_paid':True}]})
        self.assertEqual(result['incremental_usd'],15)


class ProbeBudget(unittest.TestCase):
    def test_exhausted_budget_keeps_partial_results(self):
        ticks=iter([0,0,8,11])
        seen=[]
        def probe(provider, **kwargs):
            seen.append((provider,kwargs['timeout']))
            return {'state':'ok','snapshot':{'source':'usage_api'}}
        with patch.object(discovery.time,'monotonic',side_effect=lambda:next(ticks)), patch.object(discovery,'native_snapshot',side_effect=probe):
            result=discovery.probe_providers(['a','b','c'],budget_seconds=10)
        self.assertEqual(seen,[('a',8.0),('b',2)])
        self.assertEqual(result['a']['state'],'ok')
        self.assertEqual(result['c']['state'],'unavailable')


class TimeWindows(unittest.TestCase):
    def test_overnight_rate_window_is_marked_active(self):
        from datetime import datetime, timezone
        from wolfmark_ledger.pricing import _window_active
        at=datetime(2026,1,1,23,tzinfo=timezone.utc).timestamp()
        self.assertTrue(_window_active(((None,22*60,6*60,1,1,1,1),),at))
        self.assertFalse(_window_active(((None,8*60,9*60,1,1,1,1),),at))

    @unittest.skipUnless(hasattr(__import__('time'), 'tzset'), 'requires POSIX time zones')
    def test_local_window_crosses_dst_with_historical_offset(self):
        import os, time
        from datetime import datetime
        from wolfmark_ledger.aggregate import _local_window
        previous=os.environ.get('TZ')
        try:
            os.environ['TZ']='Europe/London';time.tzset()
            now=datetime(2026,3,31,12).timestamp()
            since,_,_=_local_window(4,now)
            self.assertEqual(datetime.fromtimestamp(since),datetime(2026,3,28))
        finally:
            if previous is None: os.environ.pop('TZ',None)
            else: os.environ['TZ']=previous
            time.tzset()
