// Run: node --test test/
//
// Model News helper regressions through the same stub loader the other
// suites use (no React needed).
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'

// --- stub loader for the pure helpers --------------------------------------
const src = readFileSync(new URL('../desktop/plugin.js', import.meta.url), 'utf8')
const stub = `
const atom = v => { let s = v; return { get: () => s, set: n => { s = n }, listen: () => () => {} } }
const gatewayActivationEpoch = () => 1
const computed = (stores, cb) => {
  const list = Array.isArray(stores) ? stores : [stores]
  return { get: () => cb(...list.map(s => s.get())), listen: () => () => {} }
}
const noop = () => null
const Badge = noop, Button = noop, Codicon = noop, SegmentedControl = noop, Tip = noop
const cn = (...a) => a.filter(Boolean).join(' ')
const host = { state: { focusedSessionId: { get: () => null, listen: () => () => {} }, focusedStoredSessionId: { get: () => null, listen: () => () => {} }, profile: { get: () => '' }, focusedSessionProfile: { get: () => '' } }, notify() {}, navigate() {}, request: async () => null }
const useEffect = noop
const useRef = initial => ({ current: initial })
const queryClient = { fetchQuery: async q => q.queryFn(), getQueryData: () => null }
const usePluginI18n = noop, useQuery = noop, useValue = noop
const jsx = noop, jsxs = noop
`
const stubBody = src
  .replace(/import \{[^}]*\} from '@hermes\/plugin-sdk'\n/, stub)
  .replace(/import \{[^}]*\} from 'react'\n/, '')
  .replace(/import \{ jsx, jsxs \} from 'react\/jsx-runtime'\n/, '')
globalThis.window = { location: { hash: '' }, addEventListener() {}, removeEventListener() {} }
const stubDir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'tcm-nw-'))
const stubFile = join(stubDir, 'plugin.mjs')
writeFileSync(stubFile, stubBody)
const S = (await import(pathToFileURL(stubFile).href)).__test

const t = (key, ...args) => `${key}(${args.join('|')})`
const item = (id, category, forYou) => ({ id, category, for_you: forYou })

test('LEDGER_TABS contains Model News before Settings', () => {
  const ids = S.LEDGER_TABS.map(([id]) => id)
  assert.ok(ids.includes('news'))
  assert.ok(ids.indexOf('news') < ids.indexOf('settings'))
  assert.equal(S.LEDGER_TABS.find(([id]) => id === 'news')[1], 'Model News')
})

test('newsQuery keys by identity and refreshes through the backend', async () => {
  const id = S.membershipIdentityNow()
  const query = S.newsQuery(id)
  assert.deepEqual(query.queryKey, ['spend-sense', 'model-news', id])
  assert.notDeepEqual(S.newsQuery('other').queryKey, query.queryKey)
  assert.equal(query.retry, false)
  S.setRest(async (path, options) => {
    assert.equal(path, '/news/refresh')
    assert.equal(options?.method, 'POST')
    return { ok: true, settings: { live_updates: false }, local: { items: [] }, central: {} }
  })
  try {
    const data = await query.queryFn()
    assert.equal(data.ok, true)
    assert.equal(data.identity, id)
  } finally {
    S.setRest(null)
  }
})

test('newsQuery fails closed without a backend bridge', async () => {
  S.setRest(null)
  await assert.rejects(() => S.newsQuery(S.membershipIdentityNow()).queryFn(), /backend bridge/)
})

test('newsSettingsQuery reads settings without refreshing', async () => {
  const id = S.membershipIdentityNow()
  const query = S.newsSettingsQuery(id)
  assert.deepEqual(query.queryKey, ['spend-sense', 'news-settings', id])
  assert.equal(query.retry, false)
  S.setRest(async path => {
    assert.equal(path, '/news')
    return { ok: true, settings: { live_updates: true }, central: { state: 'ok' } }
  })
  try {
    const data = await query.queryFn()
    assert.equal(data.settings.live_updates, true)
  } finally {
    S.setRest(null)
  }
})

test('newsFilter scopes For You and categories', () => {
  const items = [
    item('a', 'new_model', true),
    item('b', 'price_reduction', true),
    item('c', 'price_reduction', false),
    item('d', 'subscription', false),
  ]
  assert.deepEqual(S.newsFilter(items, 'foryou', 'all').map(i => i.id), ['a', 'b'])
  assert.deepEqual(S.newsFilter(items, 'all', 'price_reduction').map(i => i.id), ['b', 'c'])
  assert.deepEqual(S.newsFilter(items, 'foryou', 'subscription').map(i => i.id), [])
  assert.deepEqual(S.newsFilter(items, 'all', 'all').map(i => i.id), ['a', 'b', 'c', 'd'])
  assert.deepEqual(S.newsFilter(null, 'all', 'all'), [])
})

test('newsCategoryLabel covers every category', () => {
  assert.equal(S.newsCategoryLabel('new_model', t), 'newsCatNewModels()')
  assert.equal(S.newsCategoryLabel('price_reduction', t), 'newsCatReductions()')
  assert.equal(S.newsCategoryLabel('price_increase', t), 'newsCatIncreases()')
  assert.equal(S.newsCategoryLabel('subscription', t), 'newsCatSubscription()')
})

test('newsImpactText labels API-equivalent estimates, never savings', () => {
  assert.equal(S.newsImpactText(null, t), null)
  assert.equal(
    S.newsImpactText({ basis: 'full', delta_usd: -1.234, window_days: 30 }, t),
    'newsImpactFull(−$1.23|30)')
  assert.equal(
    S.newsImpactText({ basis: 'partial', delta_usd: 0.5, window_days: 30,
      reason: 'cache rates unavailable for comparison; cache tokens excluded' }, t),
    'newsImpactPartial($0.500|30|newsCaveatCache())')
  assert.equal(
    S.newsImpactText({ basis: 'partial', delta_usd: 0, window_days: 30,
      reason: 'tiered pricing applies; base rates compared' }, t),
    'newsImpactPartial($0.00|30|newsCaveatTiers())')
  assert.equal(
    S.newsImpactText({ basis: 'partial', delta_usd: 0.5, window_days: 30,
      reason: 'cache rates unavailable for comparison; cache tokens excluded; tiered pricing applies; base rates compared' }, t),
    'newsImpactPartial($0.500|30|newsCaveatCache(); newsCaveatTiers())')
  assert.equal(
    S.newsImpactText({ basis: 'partial', delta_usd: 0.5, window_days: 30,
      reason: 'some future caveat' }, t),
    'newsImpactPartial($0.500|30|some future caveat)')
  assert.equal(
    S.newsImpactText({ basis: 'unavailable', reason: 'rate comparison unavailable' }, t),
    'newsImpactUnavailable(rate comparison unavailable)')
})

test('newsCentralAlert surfaces stale and first-fetch errors', () => {
  assert.equal(S.newsCentralAlert({ state: 'ok' }, t), null)
  assert.equal(S.newsCentralAlert({ state: 'disabled' }, t), null)
  assert.equal(S.newsCentralAlert({ state: 'stale', error: 'boom' }, t), 'boom')
  assert.equal(S.newsCentralAlert({ state: 'error', error: 'boom' }, t), 'boom')
  assert.equal(S.newsCentralAlert({ state: 'error', error: '' }, t), 'newsCentralStale()')
  assert.equal(S.newsCentralAlert(null, t), null)
})

test('newsAgeDays and newsFreshLabel describe freshness honestly', () => {
  const now = Date.parse('2026-11-03T12:00:00Z')
  assert.equal(S.newsAgeDays('2026-11-03T00:00:00+00:00', now), 0)
  assert.equal(S.newsAgeDays('2026-11-01T12:00:00Z', now), 2)
  assert.equal(S.newsAgeDays('', now), null)
  assert.equal(S.newsAgeDays('not-a-date', now), null)
  assert.equal(S.newsFreshLabel(0, t), 'newsFreshToday()')
  assert.equal(S.newsFreshLabel(3, t), 'newsFreshDays(3)')
  assert.equal(S.newsFreshLabel(null, t), 'newsFreshUnknown()')
})

test('newsIsRelevant prefers read-time relevance, keeps the stored flag', () => {
  assert.equal(S.newsIsRelevant({ relevance: { relevant: true }, for_you: false }), true)
  assert.equal(S.newsIsRelevant({ relevance: { relevant: false }, for_you: true }), false)
  assert.equal(S.newsIsRelevant({ for_you: true }), true)
  assert.equal(S.newsIsRelevant({ for_you: false }), false)
  assert.equal(S.newsIsRelevant({}), false)
  assert.equal(S.newsIsRelevant(null), false)
})

test('newsFilter honours read-time relevance for the For You scope', () => {
  const items = [
    { id: 'a', category: 'new_model', for_you: false, relevance: { relevant: true, reasons: ['used_model'] } },
    { id: 'b', category: 'new_model', for_you: true, relevance: { relevant: false, reasons: [] } },
    { id: 'c', category: 'new_model', for_you: true },
  ]
  assert.deepEqual(S.newsFilter(items, 'foryou', 'all').map(i => i.id), ['a', 'c'])
  assert.deepEqual(S.newsFilter(items, 'all', 'all').map(i => i.id), ['a', 'b', 'c'])
})

test('newsHasSignals mirrors the backend signal check', () => {
  assert.equal(S.newsHasSignals(null), false)
  assert.equal(S.newsHasSignals({}), false)
  assert.equal(S.newsHasSignals({ configured_families: [] }), false)
  assert.equal(S.newsHasSignals({ used_models: ['gpt-x'] }), true)
  assert.equal(S.newsHasSignals({ configured_families: ['openai'] }), true)
})

test('newsRelevanceReasons localises truthful reasons in display order', () => {
  assert.deepEqual(S.NEWS_RELEVANCE_ORDER,
    ['configured_provider', 'used_provider', 'used_model', 'selected_plan_family'])
  const item = { for_you: true, relevance: { relevant: true,
    reasons: ['selected_plan_family', 'used_model', 'unknown_future_code'] } }
  // The fuzzy used_model code renders the neutral "Related update", never a
  // claim that this exact model was used.
  assert.deepEqual(S.newsRelevanceReasons(item, t),
    ['newsReasonSelectedPlan()', 'newsReasonRelated()'])
  assert.equal(S.newsRelevanceText(item, t),
    'newsReasonSelectedPlan() · newsReasonRelated()')
  assert.deepEqual(S.newsRelevanceReasons({ for_you: true }, t), [])
  assert.equal(S.newsRelevanceText({ for_you: true }, t), null)
  assert.deepEqual(S.newsRelevanceReasons({ for_you: false }, t), [])
})

test('a valid last_used_at earns Used recently; malformed or old ones do not', () => {
  const NOW = Date.parse('2026-11-05T00:00:00Z')
  const base = { for_you: true, relevance: { relevant: true, reasons: ['configured_provider'] } }
  const fresh = { ...base, last_used_at: '2026-11-04T00:00:00Z' }
  assert.deepEqual(S.newsRelevanceReasons(fresh, t, NOW),
    ['newsReasonUsedRecently()', 'newsReasonConfigured()'])
  assert.equal(S.newsRelevanceText(fresh, t, NOW), 'newsReasonUsedRecently() · newsReasonConfigured()')
  for (const last_used_at of ['not-a-date', '2027-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '']) {
    assert.deepEqual(S.newsRelevanceReasons({ ...base, last_used_at }, t, NOW),
      ['newsReasonConfigured()'], `no Used recently for ${last_used_at || 'an empty value'}`)
  }
})

test('newsEmptyText mirrors backend empty states, with a legacy fallback', () => {
  const signals = { configured_families: ['openai'] }
  const newsy = [{ id: 'a', category: 'new_model', relevance: { relevant: true, reasons: [] } }]
  const other = [{ id: 'b', category: 'price_reduction', relevance: { relevant: false, reasons: [] } }]
  assert.equal(S.newsEmptyText({ items: newsy, scope: 'foryou', category: 'all', baseline: false, signals }, t), null)
  assert.equal(S.newsEmptyText({ items: [], scope: 'foryou', category: 'all', baseline: true, signals }, t), 'newsEmptyBaseline()')
  assert.equal(S.newsEmptyText({ items: [], scope: 'all', category: 'all', baseline: false, signals }, t), 'newsEmptyNoChanges()')
  assert.equal(S.newsEmptyText({ items: other, scope: 'foryou', category: 'all', baseline: false, signals }, t), 'newsEmptyNoMatches()')
  assert.equal(S.newsEmptyText({ items: other, scope: 'foryou', category: 'all', baseline: false, signals: {} }, t), 'newsEmptyNoConfig()')
  assert.equal(S.newsEmptyText({ items: newsy, scope: 'foryou', category: 'subscription', baseline: false, signals }, t), 'newsEmptyCategory()')
  assert.equal(S.newsEmptyText({ items: [], scope: 'foryou', category: 'all', baseline: false, signals: null }, t), 'newsEmptyForYou()')
  assert.equal(S.newsEmptyText({ items: [], scope: 'all', category: 'all', baseline: false, signals: null }, t), 'newsEmptyAll()')
  assert.equal(S.newsEmptyText({ items: newsy, scope: 'all', category: 'subscription', baseline: false, signals: null }, t), 'newsEmptyCategory()')
})

test('new news labels exist in English and Chinese', () => {
  const keys = ['newsEmptyBaseline', 'newsEmptyNoChanges', 'newsEmptyNoMatches',
    'newsEmptyNoConfig', 'newsWhyRelevant', 'newsReasonConfigured',
    'newsReasonUsedProvider', 'newsReasonUsedRecently', 'newsReasonRelated',
    'newsReasonSelectedPlan']
  for (const [locale, table] of Object.entries(S.I18N)) {
    for (const key of keys) assert.ok(table[key] !== undefined, `${locale} is missing ${key}`)
  }
  assert.equal(S.I18N.en.newsWhyRelevant('x'), 'For you because it x.')
  assert.ok(String(S.I18N.zh.newsWhyRelevant('x')).includes('x'))
  // The neutral reason labels in both locales, per the hook contract.
  assert.equal(S.I18N.en.newsReasonUsedRecently, 'Used recently')
  assert.equal(S.I18N.en.newsReasonRelated, 'Related update')
  assert.equal(S.I18N.en.newsReasonConfigured, 'Configured provider')
  assert.equal(S.I18N.en.newsReasonSelectedPlan, 'Selected plan')
  assert.equal(S.I18N.en.newsReasonUsedProvider, 'Provider you use')
  assert.ok(S.I18N.zh.newsReasonRelated.includes('相关'))
})

// --- PR28: backend summary/conditions/impact codes ---------------------------
const enT = (key, ...args) => {
  const entry = S.I18N.en[key]
  return typeof entry === 'function' ? entry(...args) : entry ?? key
}
const zhT = (key, ...args) => {
  const entry = S.I18N.zh[key]
  return typeof entry === 'function' ? entry(...args) : entry ?? key
}

test('news summaries render backend-identical English from codes', () => {
  const cases = [
    [{ summary_code: 'news_sum_new_provider', summary_params: { provider: 'Acme', count: 3 },
       summary: 'Acme is newly listed with 3 priced model(s).' },
     'Acme is newly listed with 3 priced model(s).'],
    [{ summary_code: 'news_sum_new_model', summary_params: { model: 'm1', provider: 'Acme', input: '$1.00', output: '$2.00' },
       summary: 'm1 newly listed under Acme at $1.00/$2.00 per MTok in/out.' },
     'm1 newly listed under Acme at $1.00/$2.00 per MTok in/out.'],
    [{ category: 'price_reduction', summary_code: 'news_sum_price_change',
       summary_params: { model: 'm1', provider: 'Acme', input: '$1.00', output: '$2.00' },
       summary: 'm1 (Acme) reduced to $1.00/$2.00 per MTok in/out.' },
     'm1 (Acme) reduced to $1.00/$2.00 per MTok in/out.'],
    [{ category: 'price_increase', summary_code: 'news_sum_price_change',
       summary_params: { model: 'm1', provider: 'Acme', input: '$1.00', output: '$2.00' },
       summary: 'm1 (Acme) changed to $1.00/$2.00 per MTok in/out.' },
     'm1 (Acme) changed to $1.00/$2.00 per MTok in/out.'],
    [{ summary_code: 'news_sum_new_plan', summary_params: { plan: 'Plus', fee: '$20/mo' },
       summary: 'New plan listed: Plus ($20/mo).' },
     'New plan listed: Plus ($20/mo).'],
    [{ summary_code: 'news_sum_plan_change',
       summary_params: { plan: 'Plus', fee_before: '$20/mo', fee_after: '$25/mo', terms_changed: true },
       summary: 'Plus: fee $20/mo → $25/mo; allowances/terms changed.' },
     'Plus: fee $20/mo → $25/mo; allowances/terms changed.'],
    [{ summary_code: 'news_sum_plan_change',
       summary_params: { plan: 'Plus', fee_before: '$20/mo', fee_after: '$20/mo', terms_changed: true },
       summary: 'Plus: allowances/terms changed.' },
     'Plus: allowances/terms changed.'],
    [{ summary_code: 'news_sum_new_provider_feed', summary_params: { provider: 'Acme', count: 2 },
       summary: 'Acme newly listed on models.dev with 2 priced model(s).' },
     'Acme newly listed on models.dev with 2 priced model(s).'],
    [{ summary_code: 'news_sum_new_model_feed', summary_params: { model: 'm1', provider: 'Acme' },
       summary: 'm1 newly listed under Acme on models.dev.' },
     'm1 newly listed under Acme on models.dev.'],
    [{ summary_code: 'news_sum_price_change_feed', summary_params: { model: 'm1', provider: 'Acme' },
       summary: 'm1 (Acme) list price changed on models.dev.' },
     'm1 (Acme) list price changed on models.dev.'],
  ]
  for (const [item, expected] of cases) {
    assert.equal(S.newsSummaryText(item, enT), expected, item.summary_code)
    assert.equal(S.newsSummaryText(item, enT), item.summary, `${item.summary_code} matches stored English`)
  }
})

test('plan changes use the fee_changed flag, never an empty clause', () => {
  // Formatted fees can compare equal while the prices differ ({number:g}).
  const rounded = { summary_code: 'news_sum_plan_change',
    summary_params: { plan: 'Plus', fee_before: 'VND 1e+06', fee_after: 'VND 1e+06',
      fee_changed: true, terms_changed: false },
    summary: 'Plus: fee VND 1e+06 → VND 1e+06.' }
  assert.equal(S.newsSummaryText(rounded, enT), 'Plus: fee VND 1e+06 → VND 1e+06.')
  // Legacy items without the flag keep the string comparison.
  const legacy = { summary_code: 'news_sum_plan_change',
    summary_params: { plan: 'Plus', fee_before: '$20/mo', fee_after: '$25/mo', terms_changed: false },
    summary: 'Plus: fee $20/mo → $25/mo.' }
  assert.equal(S.newsSummaryText(legacy, enT), 'Plus: fee $20/mo → $25/mo.')
  // Nothing to say: fall back to the stored summary instead of "Plan: .".
  const empty = { summary_code: 'news_sum_plan_change',
    summary_params: { plan: 'Plus', fee_before: '$20/mo', fee_after: '$20/mo',
      fee_changed: false, terms_changed: false },
    summary: 'Plus: fee $20/mo → $20/mo.' }
  assert.equal(S.newsSummaryText(empty, enT), 'Plus: fee $20/mo → $20/mo.')
})

test('news summaries fall back to the raw summary', () => {
  assert.equal(S.newsSummaryText({ summary: 'curator free text' }, enT), 'curator free text')
  assert.equal(S.newsSummaryText({ summary: 'old', summary_code: 'news_sum_future' }, enT), 'old')
  assert.equal(S.newsSummaryText({ summary: 'partial', summary_code: 'news_sum_new_model',
    summary_params: { model: 'm1' } }, enT), 'partial')
  assert.equal(S.newsSummaryText(null, enT), '')
})

test('news summaries translate to Chinese and keep proper names', () => {
  const item = { summary_code: 'news_sum_new_model_feed', summary_params: { model: 'Claude Haiku', provider: 'Anthropic' },
    summary: 'Claude Haiku newly listed under Anthropic on models.dev.' }
  const out = S.newsSummaryText(item, zhT)
  assert.ok(out.includes('Claude Haiku') && out.includes('Anthropic') && out.includes('models.dev'))
  assert.ok(!out.includes('newly listed'))
  const price = { category: 'price_reduction', summary_code: 'news_sum_price_change',
    summary_params: { model: 'm1', provider: 'Acme', input: '$1.00', output: '$2.00' }, summary: 'x' }
  assert.ok(S.newsSummaryText(price, zhT).includes('降至'))
})

test('news conditions render from codes with fallback', () => {
  assert.equal(S.newsConditionsText({ conditions_code: 'news_cond_listing_accounts', conditions: 'x' }, enT),
    'Catalogue listing only; not confirmed available on your accounts.')
  assert.equal(S.newsConditionsText({ conditions_code: 'news_cond_tiers_changed', conditions: 'x' }, enT),
    'Tiered/context pricing changed; base rates compared.')
  assert.equal(S.newsConditionsText({ conditions_code: 'news_cond_listing_any_account', conditions: 'x' }, enT),
    'Catalogue listing only; not confirmed available on any account.')
  assert.equal(S.newsConditionsText({ conditions: 'custom curator note' }, enT), 'custom curator note')
  assert.equal(S.newsConditionsText({ conditions_code: 'news_cond_future', conditions: 'kept' }, enT), 'kept')
  const zh = S.newsConditionsText({ conditions_code: 'news_cond_listing_accounts', conditions: 'x' }, zhT)
  assert.ok(!zh.includes('Catalogue listing only') && zh.length > 0)
})

test('impact reasons render from reason codes with legacy fallback', () => {
  const unavailable = { basis: 'unavailable', reason: 'no recent usage of this model',
    reason_codes: ['news_impact_no_usage'] }
  assert.equal(S.newsImpactText(unavailable, enT),
    'Personal estimate unavailable: no recent usage of this model.')
  assert.ok(S.newsImpactText(unavailable, zhT).includes('该模型近期无用量'))
  const partial = { basis: 'partial', delta_usd: -1.5, window_days: 30,
    reason: 'cache rates unavailable for comparison; cache tokens excluded; tiered pricing applies; base rates compared',
    reason_codes: ['news_impact_cache_excluded', 'news_impact_tiered_rates'] }
  assert.equal(S.newsImpactReasonText(partial, enT), partial.reason)
  assert.ok(!/[a-zA-Z]{4,}/.test(S.newsImpactReasonText(partial, zhT).replace(/Token/g, '')))
  // Legacy items without codes keep the substring translation path.
  const legacy = { basis: 'partial', delta_usd: -1.5, window_days: 30, reason: partial.reason }
  assert.equal(S.newsImpactReasonText(legacy, enT), partial.reason)
  assert.ok(S.newsImpactReasonText(legacy, zhT).includes('缓存'))
  // An unknown code keeps the whole raw reason rather than dropping it.
  const mixed = { basis: 'unavailable', reason: 'raw kept', reason_codes: ['news_impact_future'] }
  assert.equal(S.newsImpactReasonText(mixed, enT), 'raw kept')
})
