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

test('newsRelevanceReasons localises reasons in backend order', () => {
  assert.deepEqual(S.NEWS_RELEVANCE_ORDER,
    ['configured_provider', 'used_provider', 'used_model', 'selected_plan_family'])
  const item = { for_you: true, relevance: { relevant: true,
    reasons: ['selected_plan_family', 'used_model', 'unknown_future_code'] } }
  assert.deepEqual(S.newsRelevanceReasons(item, t),
    ['newsReasonUsedModel()', 'newsReasonSelectedPlan()'])
  assert.equal(S.newsRelevanceText(item, t),
    'newsWhyRelevant(newsReasonUsedModel() · newsReasonSelectedPlan())')
  assert.deepEqual(S.newsRelevanceReasons({ for_you: true }, t), [])
  assert.equal(S.newsRelevanceText({ for_you: true }, t), null)
  assert.deepEqual(S.newsRelevanceReasons({ for_you: false }, t), [])
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
    'newsReasonUsedProvider', 'newsReasonUsedModel', 'newsReasonSelectedPlan']
  for (const [locale, table] of Object.entries(S.I18N)) {
    for (const key of keys) assert.ok(table[key] !== undefined, `${locale} is missing ${key}`)
  }
  assert.equal(S.I18N.en.newsWhyRelevant('x'), 'For you because it x.')
  assert.ok(String(S.I18N.zh.newsWhyRelevant('x')).includes('x'))
})
