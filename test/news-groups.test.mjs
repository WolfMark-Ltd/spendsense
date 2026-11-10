// Run: node --test test/
//
// WP11 model-first grouping: pure helpers over the existing flat /news item
// shape (local + central items, impacts, settings). No new payload contract —
// grouping, deltas, classes, ranking and filtering all happen in the client.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'

// --- stub loader for the pure helpers (same shape as test/news.test.mjs) ----
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
const stubDir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'tcm-nw11-'))
const stubFile = join(stubDir, 'plugin.mjs')
writeFileSync(stubFile, stubBody)
const S = (await import(pathToFileURL(stubFile).href)).__test

const t = (key, ...args) => `${key}(${args.join('|')})`

/** A realistic flat /news item, matching the documented payload fields. */
const evt = (over = {}) => ({
  id: 'n1', origin: 'local', category: 'price_reduction',
  provider: 'Anthropic', model: 'claude-sonnet-4-5-20250929',
  summary_code: 'news_sum_price_change',
  summary_params: { model: 'claude-sonnet-4-5-20250929', provider: 'Anthropic', input: '$4.00', output: '$25.00' },
  previous: { input: 5.0, output: 25.0, cache_read: 0.5, cache_write: 6.25 },
  current: { input: 4.0, output: 25.0, cache_read: 0.4, cache_write: 6.25 },
  has_tiers: false,
  conditions: '', conditions_code: '',
  observed_at: '2026-11-03T00:00:00Z', effective_at: '2026-11-03T00:00:00Z',
  source_url: 'https://example.com/pricing', provenance: 'Hermes models.dev cache',
  confidence: 'observed', related_routes: ['acme/claude-sonnet-4-5'],
  relevance: { relevant: false, reasons: [] },
  ...over,
})

const NOW = Date.parse('2026-11-05T00:00:00Z')

test('grouping keeps every identity separate: dated, alias, namespaced', () => {
  const items = [
    evt({ id: 'a1', model: 'claude-sonnet-4-5-20250929' }),
    evt({ id: 'a2', model: 'claude-sonnet-4-5' }),
    evt({ id: 'a3', model: 'openrouter/anthropic/claude-sonnet-4.5' }),
  ]
  const { groups, cards } = S.newsGroupModels(items)
  assert.deepEqual(groups.map(g => g.model).sort(),
    ['claude-sonnet-4-5', 'claude-sonnet-4-5-20250929', 'openrouter/anthropic/claude-sonnet-4.5'])
  assert.equal(cards.length, 0)
})

test('a multi-provider model is one group with one offer per exact provider', () => {
  const items = [
    evt({ id: 'm1', provider: 'Anthropic' }),
    evt({ id: 'm2', provider: 'Bedrock', observed_at: '2026-11-04T00:00:00Z' }),
    evt({ id: 'm3', provider: 'Anthropic', observed_at: '2026-11-01T00:00:00Z' }),
  ]
  const { groups } = S.newsGroupModels(items)
  assert.equal(groups.length, 1)
  const [group] = groups
  assert.deepEqual(group.offers.map(o => o.provider), ['Bedrock', 'Anthropic'])
  assert.equal(group.offers[0].latest.id, 'm2')
  assert.equal(group.offers[1].latest.id, 'm1')
  assert.deepEqual(group.offers[1].history.map(e => e.id), ['m3'])
  assert.deepEqual(group.offer_classes, ['reduction'])
})

test('events dedupe by exact id and sort newest first', () => {
  const items = [
    evt({ id: 'dup', observed_at: '2026-11-01T00:00:00Z' }),
    evt({ id: 'dup', observed_at: '2026-11-01T00:00:00Z' }),
    evt({ id: 'new', observed_at: '2026-11-04T00:00:00Z' }),
  ]
  const { groups } = S.newsGroupModels(items)
  const offer = groups[0].offers[0]
  assert.deepEqual(offer.events.map(e => e.id), ['new', 'dup'])
  assert.equal(offer.latest.id, 'new')
  assert.deepEqual(offer.history.map(e => e.id), ['dup'])
})

test('empty-model items are never grouped: plans and listings stay cards', () => {
  const items = [
    evt({ id: 'plan1', model: '', category: 'subscription', provider: 'Acme',
      summary_code: 'news_sum_new_plan', summary_params: { plan: 'Pro', fee: '$20/mo' } }),
    evt({ id: 'list1', model: '', category: 'new_model', provider: 'FreshAI' }),
    evt({ id: 'm1' }),
  ]
  const { groups, cards, entries } = S.newsGroupModels(items)
  assert.equal(groups.length, 1)
  assert.deepEqual(cards.map(c => c.id).sort(), ['list1', 'plan1'])
  assert.equal(entries.length, 3)
  assert.deepEqual(entries.map(e => e.kind).sort(), ['card', 'card', 'group'])
})

test('grouping preserves the original items untouched', () => {
  const items = [evt({ id: 'k1' }), evt({ id: 'k2', model: '' })]
  const before = JSON.stringify(items)
  S.newsGroupModels(items)
  assert.equal(JSON.stringify(items), before)
})

test('latest event drives current, previous and deltas; older events never fill gaps', () => {
  const items = [
    evt({ id: 'old', observed_at: '2026-11-01T00:00:00Z',
      previous: { input: 5.0, output: 25.0, cache_read: 0.5, cache_write: 6.25 },
      current: { input: 4.5, output: 20.0, cache_read: 0.45, cache_write: 6.0 } }),
    evt({ id: 'new', observed_at: '2026-11-03T00:00:00Z',
      previous: { input: 4.5, output: null, cache_read: 0.45, cache_write: 6.0 },
      current: { input: 4.0, output: 25.0, cache_read: 0.4, cache_write: null } }),
  ]
  const { groups } = S.newsGroupModels(items)
  const offer = groups[0].offers[0]
  const byKey = Object.fromEntries(offer.deltas.map(d => [d.key, d]))
  // The newest event's missing output stays missing (no previous rate) and
  // its missing cache_write stays missing (no new rate); the older event's
  // rates must not fill either gap.
  assert.equal(byKey.output.reason, 'missing_before')
  assert.equal(byKey.output.pct, null)
  assert.equal(byKey.cache_write.reason, 'missing_after')
  assert.equal(byKey.input.pct, (4.0 - 4.5) / 4.5 * 100)
  assert.equal(offer.latest.id, 'new')
  assert.deepEqual(offer.history.map(e => e.id), ['old'])
})

test('per-field comparability: zero before, missing before/after, real pct', () => {
  assert.deepEqual(S.newsFieldDelta(0, 2), { pct: null, reason: 'zero_before' })
  assert.deepEqual(S.newsFieldDelta(null, 2), { pct: null, reason: 'missing_before' })
  assert.deepEqual(S.newsFieldDelta(2, null), { pct: null, reason: 'missing_after' })
  assert.deepEqual(S.newsFieldDelta(5, 4).pct, -20)
  assert.deepEqual(S.newsFieldDelta(4, 5).pct, 25)
  assert.deepEqual(S.newsFieldDelta(5, 5).pct, 0)
  assert.equal(S.newsFieldDelta('x', 2).reason, 'missing_before')
})

test('new_model events carry no deltas and classify as new_listing', () => {
  const item = evt({ id: 'nm', category: 'new_model', previous: null,
    current: { input: 3, output: 15, cache_read: null, cache_write: null } })
  const { fields, newListing } = S.newsEventDeltas(item)
  assert.deepEqual(fields, [])
  assert.equal(newListing, true)
  assert.equal(S.newsOfferClass(item), 'new_listing')
})

test('tier rows must match exactly to compare; tiers never average', () => {
  const tiersA = [{ type: '<=200K', size: 200000, input: 1, output: 2 }]
  const tiersB = [{ threshold: '<=200K', size: 200000, input: 1, output: 2 }]
  assert.equal(S.newsTierStatus({ tiers: tiersA }, { tiers: tiersB }, true), 'match')
  assert.equal(S.newsTierStatus({ tiers: tiersA }, { tiers: [{ type: '<=200K', size: 200000, input: 1, output: 3 }] }, true), 'changed')
  assert.equal(S.newsTierStatus({}, {}, true), 'changed')
  assert.equal(S.newsTierStatus({}, {}, false), 'none')
})

test('offer classes: reduction, increase, mixed, tiers_only, null', () => {
  assert.equal(S.newsOfferClass(evt({ current: { input: 4.0, output: 20.0, cache_read: 0.4, cache_write: 5.0 } })), 'reduction')
  assert.equal(S.newsOfferClass(evt({ category: 'price_increase',
    current: { input: 6.0, output: 30.0, cache_read: 0.6, cache_write: 7.0 } })), 'increase')
  assert.equal(S.newsOfferClass(evt({ current: { input: 6.0, output: 20.0, cache_read: 0.4, cache_write: 6.25 } })), 'mixed')
  // Base rates flat but tiers changed -> tiers_only.
  const tiersOnly = evt({ has_tiers: true, current: { input: 5.0, output: 25.0, cache_read: 0.5, cache_write: 6.25 } })
  assert.equal(S.newsOfferClass(tiersOnly), 'tiers_only')
  // Unusable newest comparison (no comparable rates) -> null class, never
  // rebuilt from an older event.
  assert.equal(S.newsOfferClass(evt({
    previous: { input: null, output: null, cache_read: null, cache_write: null },
    current: { input: 4.0, output: 25.0, cache_read: 0.4, cache_write: 6.25 } })), null)
  assert.equal(S.newsOfferClass(evt({
    previous: { input: 0, output: 25.0 }, current: { input: 4.0, output: 25.0 } })), null)
})

test('category filter is semantic at offer level and keeps sibling offers', () => {
  const items = [
    evt({ id: 'r1', provider: 'Anthropic' }),
    evt({ id: 'u1', provider: 'Bedrock', category: 'price_increase', observed_at: '2026-11-04T00:00:00Z',
      current: { input: 6.0, output: 30.0, cache_read: 0.6, cache_write: 7.0 } }),
  ]
  const { groups, entries } = S.newsGroupModels(items)
  assert.equal(groups.length, 1)
  const reduction = S.newsFilterEntries(entries, { category: 'price_reduction', nowMs: NOW })
  assert.equal(reduction.length, 1)
  assert.deepEqual(reduction[0].matchedOffers, [1], 'only the qualifying offer row is marked')
  assert.equal(reduction[0].offers.length, 2, 'sibling offers stay visible')
  const increase = S.newsFilterEntries(entries, { category: 'price_increase', nowMs: NOW })
  assert.deepEqual(increase[0].matchedOffers, [0], 'Bedrock row qualifies under Increases')
  const sub = S.newsFilterEntries(
    [...entries, { kind: 'card', item: evt({ id: 'p1', model: '', category: 'subscription' }), observed_at: '', sort_id: 'p1' }],
    { category: 'subscription', nowMs: NOW })
  assert.equal(sub.length, 1)
  assert.equal(sub[0].kind, 'card')
  assert.equal(S.newsFilterEntries(entries, { category: 'subscription', nowMs: NOW }).length, 0,
    'grouped token-rate models never match the subscription filter')
})

test('For You ranks relevant groups by backend reasons, material change, recency', () => {
  const mk = (id, relevant, reasons, pct, observed) => ({
    kind: 'group', model: id, model_name: '', offers: [{
      provider: 'P', model: id,
      latest: evt({ id: `${id}-e`, relevance: { relevant, reasons } }),
      history: [], events: [], deltas: [{ key: 'input', pct }], news_class: 'reduction',
    }], offer_classes: ['reduction'], latest: evt({ id: `${id}-e`, observed_at: observed }),
    observed_at: observed, sort_id: id,
  })
  const groups = [
    mk('plan-pick', true, ['selected_plan_family'], -50, '2026-11-04'),
    mk('configured', true, ['configured_provider'], -50, '2026-11-04'),
    mk('used-small', true, ['used_model'], -5, '2026-11-04'),
    mk('used-big', true, ['used_provider'], -40, '2026-11-01'),
    mk('irrelevant', false, [], -90, '2026-11-04'),
  ]
  const ranked = S.newsRankGroups(groups)
  assert.deepEqual(ranked.map(g => g.model),
    ['used-big', 'used-small', 'configured', 'plan-pick'],
    'used first, material change breaks the tie, then recency')
  assert.ok(!ranked.some(g => g.model === 'irrelevant'), 'only relevant groups enter For You')
  assert.equal(S.NEWS_FOR_YOU_LIMIT, 5)
})

test('For You reasons show only what the backend supplied', () => {
  const group = { offers: [{ latest: evt({ relevance: { relevant: true, reasons: ['used_model'] } }) }] }
  assert.deepEqual(S.newsGroupReasons(group, t), ['newsReasonUsedModel()'])
  assert.deepEqual(S.newsGroupReasons({ offers: [{ latest: evt() }] }, t), [])
})

test('search matches model id, model_name, provider and routes, case-insensitively', () => {
  const entry = S.newsGroupModels([
    evt({ id: 's1', model_name: 'Claude Sonnet 4.5', related_routes: ['acme/claude-sonnet-4-5'] }),
  ]).entries[0]
  assert.equal(S.newsEntryMatchesSearch(entry, 'CLAUDE-SONNET'), true)
  assert.equal(S.newsEntryMatchesSearch(entry, 'sonnet 4.5'), true, 'friendly name matches')
  assert.equal(S.newsEntryMatchesSearch(entry, 'anthropic'), true)
  assert.equal(S.newsEntryMatchesSearch(entry, 'ACME/'), true)
  assert.equal(S.newsEntryMatchesSearch(entry, 'gemini'), false)
  assert.equal(S.newsEntryMatchesSearch(entry, ''), true)
})

test('date filter windows on observed_at; undated entries only show under All', () => {
  const entries = [
    { kind: 'card', item: evt({ id: 'fresh', observed_at: '2026-11-03T00:00:00Z' }), observed_at: '2026-11-03T00:00:00Z', sort_id: 'fresh' },
    { kind: 'card', item: evt({ id: 'old', observed_at: '2026-10-01T00:00:00Z' }), observed_at: '2026-10-01T00:00:00Z', sort_id: 'old' },
    { kind: 'card', item: evt({ id: 'nodate', observed_at: '' }), observed_at: '', sort_id: 'nodate' },
  ]
  assert.deepEqual(S.newsFilterEntries(entries, { days: 7, nowMs: NOW }).map(e => e.item.id), ['fresh'])
  assert.deepEqual(S.newsFilterEntries(entries, { days: 90, nowMs: NOW }).map(e => e.item.id), ['fresh', 'old'])
  assert.equal(S.newsFilterEntries(entries, { days: null, nowMs: NOW }).length, 3)
})

test('load-more page size is 10 and the remaining count follows from it', () => {
  assert.equal(S.NEWS_PAGE_SIZE, 10)
  const entries = Array.from({ length: 12 }, (_, i) => ({
    kind: 'card', item: evt({ id: `e${i}` }), observed_at: '', sort_id: `e${i}`,
  }))
  const visible = entries.slice(0, S.NEWS_PAGE_SIZE)
  assert.equal(visible.length, 10)
  assert.equal(entries.length - visible.length, 2)
})

test('model_name is the newest supplied name; absent means the exact ID stands alone', () => {
  const { groups } = S.newsGroupModels([
    evt({ id: 'n1', model_name: 'Claude Sonnet 4.5' }),
    evt({ id: 'n2', provider: 'Bedrock', model_name: '', observed_at: '2026-11-04T00:00:00Z' }),
    evt({ id: 'n3', model: 'bare-model' }),
  ])
  const named = groups.find(g => g.model === 'claude-sonnet-4-5-20250929')
  assert.equal(named.model_name, 'Claude Sonnet 4.5')
  const bare = groups.find(g => g.model === 'bare-model')
  assert.equal(bare.model_name, '', 'no name is synthesized from the ID')
})

test('group impact wording stays hypothetical and API-equivalent', () => {
  const enT = (key, ...args) => {
    const entry = S.I18N.en[key]
    return typeof entry === 'function' ? entry(...args) : entry ?? key
  }
  const full = S.newsGroupImpactText({ basis: 'full', delta_usd: -3.10, window_days: 30 }, enT)
  assert.match(full, /Hypothetical API-equivalent/)
  assert.match(full, /not a bill or guaranteed saving/)
  assert.doesNotMatch(full, /save|charged|billed/)
  const partial = S.newsGroupImpactText({ basis: 'partial', delta_usd: 1.2, window_days: 30,
    reason: 'cache rates unavailable for comparison; cache tokens excluded' }, enT)
  assert.match(partial, /Partial hypothetical API-equivalent/)
  assert.doesNotMatch(partial, /save|charged|billed/)
  assert.equal(S.newsGroupImpactText(null, enT), null)
  const zh = S.I18N.zh.newsImpactGroupFull('−$3.10', S.I18N.zh.newsImpactLower, 30)
  assert.ok(zh.includes('−$3.10') && zh.includes('并非账单'), 'zh impact wording is translated')
  assert.doesNotMatch(zh, /save|charged|billed/)
})

test('every WP11 key exists in English and Chinese with the same shape', () => {
  const keys = ['newsFieldInput', 'newsFieldOutput', 'newsFieldCacheRead', 'newsFieldCacheWrite',
    'newsClassNewListing', 'newsClassReduction', 'newsClassIncrease', 'newsClassMixed',
    'newsClassTiersOnly', 'newsClassNotComparable', 'newsDirDown', 'newsDirUp', 'newsDirFlat',
    'newsDirNew', 'newsChipNotComparable', 'newsChipUnchanged', 'newsNoPrev', 'newsNoAfter',
    'newsZeroBefore', 'newsScopeLabel', 'newsCountGroups', 'newsCountEvents', 'newsCountEntries',
    'newsSearchLabel', 'newsSearchPlaceholder', 'newsDateLabel', 'newsDays7', 'newsDays30',
    'newsDays90', 'newsDaysAll', 'newsLoadMore', 'newsClearFilters', 'newsNoResults', 'newsShowAll',
    'newsFilterMatch', 'newsImpactGroupFull', 'newsImpactGroupPartial', 'newsImpactLower',
    'newsImpactHigher', 'newsImpactUnchanged', 'newsHistory', 'newsItemLabel']
  for (const key of keys) {
    assert.ok(S.I18N.en[key] !== undefined, `en has ${key}`)
    assert.ok(S.I18N.zh[key] !== undefined, `zh has ${key}`)
    assert.equal(typeof S.I18N.zh[key], typeof S.I18N.en[key], `${key} has the same shape`)
  }
  assert.equal(S.I18N.en.newsCountGroups(1), '1 group')
  assert.equal(S.I18N.en.newsCountGroups(2), '2 groups')
  assert.match(S.I18N.zh.newsCountGroups(2), /2/)
  assert.match(S.I18N.zh.newsShowAll(8), /8/)
  assert.doesNotMatch(S.I18N.en.newsImpactGroupFull('−$3.10', 'lower', 30), /save|charged|billed/)
})
