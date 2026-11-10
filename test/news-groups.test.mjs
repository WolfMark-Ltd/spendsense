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
  const tier = over => ({ type: '<=200K', size: 200000, input: 1, output: 2, cache_read: null, cache_write: null, ...over })
  // Known detail, both root arrays present, same type+size keys -> comparable.
  const known = evt({ has_tiers: true, tiers_detail: 'known',
    tiers_before: [tier()], tiers_after: [tier({ input: 0.5 })] })
  const cmp = S.newsTierComparison(known)
  assert.equal(cmp.status, 'match')
  assert.equal(cmp.reason, null)
  assert.equal(cmp.dir, 'down')
  assert.equal(cmp.rows.length, 1)
  assert.deepEqual(cmp.rows[0].deltas.map(d => d.key), ['input', 'output'],
    'all-null fields on both sides are omitted, like base-rate deltas')
  assert.equal(cmp.rows[0].deltas.find(d => d.key === 'input').pct, -50)
  // Unknown detail -> never compared, whatever the arrays hold.
  const unknown = S.newsTierComparison(evt({ has_tiers: true, tiers_detail: 'unknown',
    tiers_before: [tier()], tiers_after: [tier()] }))
  assert.equal(unknown.status, 'unknown')
  assert.equal(unknown.reason, 'tier_type_unknown')
  assert.deepEqual(unknown.rows, [])
  // Missing detail with no captured arrays -> unavailable, not a type guess.
  assert.equal(S.newsTierComparison(evt({ has_tiers: true })).reason, 'tier_unavailable')
  // Known detail but a missing array -> unavailable, never fabricated rows.
  assert.equal(S.newsTierComparison(evt({ has_tiers: true, tiers_detail: 'known', tiers_after: [tier()] })).reason,
    'tier_unavailable')
  assert.equal(S.newsTierComparison(evt({ has_tiers: true, tiers_detail: 'known' })).status, 'unavailable')
  // Key-set mismatch (type+size per row) -> tier_mismatch, no row-level deltas.
  const mismatch = S.newsTierComparison(evt({ has_tiers: true, tiers_detail: 'known',
    tiers_before: [tier()], tiers_after: [tier({ type: '<=1M', size: 1000000 })] }))
  assert.equal(mismatch.reason, 'tier_mismatch')
  assert.deepEqual(mismatch.rows, [])
  // A row without a known type is tier_type_unknown even under 'known'.
  assert.equal(S.newsTierComparison(evt({ has_tiers: true, tiers_detail: 'known',
    tiers_before: [{ size: 200000, input: 1 }], tiers_after: [tier()] })).reason, 'tier_type_unknown')
  // No tier signal at all stays out of the way.
  assert.equal(S.newsTierComparison(evt()).status, 'none')
  assert.equal(S.newsTierComparison(evt({ previous: { tiers: [tier()] }, current: { tiers: [tier()] }, has_tiers: true })).reason,
    'tier_unavailable', 'legacy nested tiers arrays are never read')
  // Same keys but equal rates -> comparable and unchanged.
  const same = S.newsTierComparison(evt({ has_tiers: true, tiers_detail: 'known',
    tiers_before: [tier()], tiers_after: [tier()] }))
  assert.equal(same.dir, 'same')
  // Mixed tier movement has no single direction.
  const mixed = S.newsTierComparison(evt({ has_tiers: true, tiers_detail: 'known',
    tiers_before: [tier(), tier({ type: '<=1M', size: 1000000, input: 2 })],
    tiers_after: [tier({ input: 0.5 }), tier({ type: '<=1M', size: 1000000, input: 4 })] }))
  assert.equal(mixed.status, 'match')
  assert.equal(mixed.dir, 'na')
  assert.equal(mixed.reason, null)
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

test('For You ranks by exact recency, strong reasons, materiality, recency, id', () => {
  const mk = (id, relevant, reasons, pct, observed, lastUsed = '') => ({
    kind: 'group', model: id, model_name: '', offers: [{
      provider: 'P', model: id,
      latest: evt({ id: `${id}-e`, relevance: { relevant, reasons }, last_used_at: lastUsed }),
      history: [], events: [], deltas: [{ key: 'input', pct }], news_class: 'reduction',
    }], offer_classes: ['reduction'], latest: evt({ id: `${id}-e`, observed_at: observed }),
    observed_at: observed, sort_id: id,
  })
  const NOW_RANK = Date.parse('2026-11-05T00:00:00Z')
  const groups = [
    // Used 2 days ago: beats every non-recent group, newest last_used first.
    mk('recent-old', true, ['used_model'], -50, '2026-11-04', '2026-11-01T00:00:00Z'),
    mk('recent-new', true, [], -5, '2026-11-04', '2026-11-03T00:00:00Z'),
    // Strong backend signals, no exact recency.
    mk('plan-pick', true, ['selected_plan_family'], -50, '2026-11-04'),
    mk('configured', true, ['configured_provider'], -50, '2026-11-04'),
    // Only the fuzzy used_model signal: no strong reason, no recency claim.
    mk('used-small', true, ['used_model'], -5, '2026-11-04'),
    mk('used-big', true, ['used_provider'], -40, '2026-11-01'),
    mk('irrelevant', false, [], -90, '2026-11-04'),
  ]
  const ranked = S.newsRankForYou(groups, NOW_RANK)
  assert.deepEqual(ranked.map(g => g.model),
    ['recent-new', 'recent-old', 'configured', 'plan-pick', 'used-big', 'used-small'],
    'exact recency first, then strong reasons, then material change')
  assert.ok(!ranked.some(g => g.model === 'irrelevant'), 'only relevant groups enter For You')
  assert.equal(S.NEWS_FOR_YOU_LIMIT, 5)
  assert.equal(S.NEWS_FOR_YOU_INITIAL, 5)
})

test('last_used_at is recent only when valid, past and within 30 days', () => {
  const NOW = Date.parse('2026-11-05T00:00:00Z')
  const day = 86_400_000
  assert.equal(S.newsUsedRecently({ last_used_at: '2026-11-04T00:00:00Z' }, NOW), true)
  assert.equal(S.newsUsedRecently({ last_used_at: '2026-10-06T00:00:00Z' }, NOW), true, '29 days is recent')
  assert.equal(S.newsUsedRecently({ last_used_at: '2026-10-05T23:59:59Z' }, NOW), false, 'older than 30 days')
  assert.equal(S.newsUsedRecently({ last_used_at: '2026-11-06T00:00:00Z' }, NOW), false, 'the future is not recent')
  assert.equal(S.newsUsedRecently({ last_used_at: 'not-a-date' }, NOW), false, 'malformed')
  assert.equal(S.newsUsedRecently({ last_used_at: '' }, NOW), false, 'empty')
  assert.equal(S.newsUsedRecently({ last_used_at: 42 }, NOW), false, 'not a string')
  assert.equal(S.newsUsedRecently({}, NOW), false)
  assert.equal(S.newsUsedRecently(null, NOW), false)
  assert.equal(S.newsLastUsedMs({ last_used_at: '2026-11-04T00:00:00Z' }, NOW), Date.parse('2026-11-04T00:00:00Z'))
  assert.equal(S.newsLastUsedMs({ last_used_at: '2026-11-06T00:00:00Z' }, NOW), null)
})

test('a fuzzy used_model reason never claims the model was used recently', () => {
  const NOW = Date.parse('2026-11-05T00:00:00Z')
  // Same suffix "x" for provider a and b: the loose legacy match must not
  // manufacture "Used recently" for either.
  const a = evt({ id: 'ax', model: 'a/x', relevance: { relevant: true, reasons: ['used_model'] } })
  const b = evt({ id: 'bx', model: 'b/x', relevance: { relevant: true, reasons: ['used_model'] } })
  for (const item of [a, b]) {
    assert.deepEqual(S.newsItemReasonCodes(item, NOW), ['used_model'])
    assert.deepEqual(S.newsRelevanceReasons(item, t, NOW), ['newsReasonRelated()'])
    assert.equal(S.newsRelevanceText(item, t, NOW), 'newsReasonRelated()')
  }
  // Even with an out-of-window last_used_at the fuzzy code stays neutral —
  // the old use is reported truthfully as "Used before", never as recency.
  const stale = evt({ id: 'sx', model: 'a/x', relevance: { relevant: true, reasons: ['used_model'] },
    last_used_at: '2026-01-01T00:00:00Z' })
  assert.deepEqual(S.newsItemReasonCodes(stale, NOW), ['used_before', 'used_model'])
  // A valid recent last_used_at earns "Used recently" alongside the codes.
  const fresh = evt({ id: 'fx', model: 'a/x', relevance: { relevant: true, reasons: ['used_model'] },
    last_used_at: '2026-11-04T00:00:00Z' })
  assert.deepEqual(S.newsItemReasonCodes(fresh, NOW), ['used_recently', 'used_model'])
  assert.deepEqual(S.newsRelevanceReasons(fresh, t, NOW),
    ['newsReasonUsedRecently()', 'newsReasonRelated()'])
  // Group reasons inherit the same truthfulness.
  const group = { offers: [{ latest: a }] }
  assert.deepEqual(S.newsGroupReasons(group, t, NOW), ['newsReasonRelated()'])
})

test('reasons never claim model use or access', () => {
  const NOW = Date.parse('2026-11-05T00:00:00Z')
  const enT = (key, ...args) => {
    const entry = S.I18N.en[key]
    return typeof entry === 'function' ? entry(...args) : entry ?? key
  }
  const codes = ['configured_provider', 'selected_plan_family', 'used_provider']
  const item = evt({ relevance: { relevant: true, reasons: codes } })
  const labels = S.newsGroupReasons({ offers: [{ latest: item }] }, enT, NOW)
  assert.deepEqual(labels, ['Configured provider', 'Selected plan', 'Provider you use'])
  for (const label of labels) {
    assert.ok(!/used this model|you used|Used recently|access/i.test(label), label)
  }
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

// --- WP11 corrections: dedupe proof, coded classes, exports ------------------

/** Two items with an identical transition, built from the standard fixture. */
const twin = (over = {}) => evt(over)

test('a local and a central item merge only with an explicit same-event proof', () => {
  // (i) identical transition + (ii) exactly equal observed_at -> merge.
  const merged = S.newsGroupModels([
    twin({ id: 'l1', origin: 'local', observed_at: '2026-11-03T00:00:00Z' }),
    twin({ id: 'c1', origin: 'central', observed_at: '2026-11-03T00:00:00Z' }),
  ]).groups[0].offers[0]
  assert.equal(merged.events.length, 1, 'one merged event')
  assert.deepEqual(merged.events[0].merged_sources.map(s => s.id), ['l1', 'c1'])
  assert.deepEqual(merged.history, [])
  assert.equal(merged.latest.id, 'l1', 'the local item is the primary')

  // (ii) equal effective_at + equal non-empty source_url merges even when the
  // observations differ.
  const viaSource = S.newsGroupModels([
    twin({ id: 'l2', origin: 'local', observed_at: '2026-11-03T00:00:00Z',
      effective_at: '2026-11-05T00:00:00Z', source_url: 'https://example.com/a' }),
    twin({ id: 'c2', origin: 'central', observed_at: '2026-11-04T00:00:00Z',
      effective_at: '2026-11-05T00:00:00Z', source_url: 'https://example.com/a' }),
  ]).groups[0].offers[0]
  assert.equal(viaSource.events.length, 1)
  assert.equal(viaSource.events[0].observed_at, '2026-11-04T00:00:00Z',
    'a merged event is observed at the newest of its sources')

  // An explicit common event link field merges too.
  const viaLink = S.newsGroupModels([
    twin({ id: 'l3', origin: 'local', observed_at: '2026-11-03T00:00:00Z', event_id: 'ev-9' }),
    twin({ id: 'c3', origin: 'central', observed_at: '2026-11-04T00:00:00Z', event_id: 'ev-9' }),
  ]).groups[0].offers[0]
  assert.equal(viaLink.events.length, 1)
  assert.deepEqual(viaLink.events[0].merged_sources.map(s => s.id), ['l3', 'c3'])
})

test('without proof, same transitions stay distinct events', () => {
  // Identical transition, different observed_at, no shared url/effective pair.
  const offer = S.newsGroupModels([
    twin({ id: 'l1', origin: 'local', observed_at: '2026-11-03T00:00:00Z',
      effective_at: '2026-11-03T00:00:00Z', source_url: 'https://example.com/a' }),
    twin({ id: 'c1', origin: 'central', observed_at: '2026-11-03T06:00:00Z' }),
  ]).groups[0].offers[0]
  assert.equal(offer.events.length, 2, 'no proof, no merge — even 6h apart')
  assert.deepEqual(offer.events.map(e => e.id), ['c1', 'l1'])
  assert.equal(offer.latest.id, 'c1', 'the newest event drives the offer')
  assert.deepEqual(offer.history.map(e => e.id), ['l1'], 'the older event is History only')
})

test('repeats under 48h and A→B→A→B recurrences stay separate events', () => {
  // A repeat 2h later with the same transition: no proof -> separate. The
  // central item carries a different source, so the effective_at+source_url
  // proof does not fire either.
  const repeat = S.newsGroupModels([
    twin({ id: 'l1', origin: 'local', observed_at: '2026-11-03T00:00:00Z' }),
    twin({ id: 'c1', origin: 'central', observed_at: '2026-11-03T02:00:00Z', source_url: 'https://example.com/other' }),
  ]).groups[0].offers[0]
  assert.equal(repeat.events.length, 2, 'a gap under 48h is not proof')

  // A→B→A→B recurrence with different dates and no shared evidence: every
  // event stays its own.
  const up = { current: { input: 6.0, output: 30.0, cache_read: 0.6, cache_write: 7.0 } }
  const items = [
    twin({ id: 'e1', observed_at: '2026-11-01T00:00:00Z', source_url: '' }),
    twin({ id: 'e2', observed_at: '2026-11-02T00:00:00Z', source_url: '', ...up }),
    twin({ id: 'e3', observed_at: '2026-11-03T00:00:00Z', source_url: '' }),
    twin({ id: 'e4', observed_at: '2026-11-04T00:00:00Z', source_url: '', ...up }),
  ]
  const offer = S.newsGroupModels(items).groups[0].offers[0]
  assert.deepEqual(offer.events.map(e => e.id), ['e4', 'e3', 'e2', 'e1'])
  assert.equal(offer.latest.id, 'e4', 'the latest event drives the class')
})

test('merging never happens within one origin and is strictly 1:1', () => {
  // Two local items, identical transition and identical observed_at: no merge.
  const locals = S.newsGroupModels([
    twin({ id: 'l1', origin: 'local', observed_at: '2026-11-03T00:00:00Z' }),
    twin({ id: 'l2', origin: 'local', observed_at: '2026-11-03T00:00:00Z' }),
  ]).groups[0].offers[0]
  assert.equal(locals.events.length, 2)
  // Two centrals likewise.
  const centrals = S.newsGroupModels([
    twin({ id: 'c1', origin: 'central', observed_at: '2026-11-03T00:00:00Z' }),
    twin({ id: 'c2', origin: 'central', observed_at: '2026-11-03T00:00:00Z' }),
  ]).groups[0].offers[0]
  assert.equal(centrals.events.length, 2)
  // One local, two provably identical centrals: exactly one merges.
  const oneOfTwo = S.newsGroupModels([
    twin({ id: 'l1', origin: 'local', observed_at: '2026-11-03T00:00:00Z' }),
    twin({ id: 'c1', origin: 'central', observed_at: '2026-11-03T00:00:00Z' }),
    twin({ id: 'c2', origin: 'central', observed_at: '2026-11-03T00:00:00Z' }),
  ]).groups[0].offers[0]
  assert.equal(oneOfTwo.events.length, 2, '1:1 pairing: only one central merges')
  const mergedEvent = oneOfTwo.events.find(e => Array.isArray(e.merged_sources))
  assert.deepEqual(mergedEvent.merged_sources.map(s => s.id), ['l1', 'c1'])
  assert.deepEqual(oneOfTwo.events.filter(e => !e.merged_sources).map(e => e.id), ['c2'])
  // A different transition never merges, whatever the proof says.
  const other = S.newsGroupModels([
    twin({ id: 'l1', origin: 'local', observed_at: '2026-11-03T00:00:00Z' }),
    twin({ id: 'c1', origin: 'central', observed_at: '2026-11-03T00:00:00Z',
      current: { input: 3.0, output: 25.0, cache_read: 0.5, cache_write: 6.25 } }),
  ]).groups[0].offers[0]
  assert.equal(other.events.length, 2, 'a different rate transition is a different event')
})

test('rate_change_code drives the class; contradicting fields stay neutral', () => {
  assert.equal(S.newsOfferClass(evt({ rate_change_code: 'news_rate_down' })), 'reduction')
  assert.equal(S.newsOfferClass(evt({ category: 'price_increase',
    current: { input: 6.0, output: 30.0, cache_read: 0.6, cache_write: 7.0 },
    rate_change_code: 'news_rate_up' })), 'increase')
  assert.equal(S.newsOfferClass(evt({ rate_change_code: 'news_rate_mixed',
    current: { input: 6.0, output: 20.0, cache_read: 0.4, cache_write: 6.25 } })), 'mixed')
  const flatRates = { current: { input: 5.0, output: 25.0, cache_read: 0.5, cache_write: 6.25 } }
  assert.equal(S.newsOfferClass(evt({ has_tiers: true, ...flatRates, rate_change_code: 'news_rate_tiers_only' })), 'tiers_only')
  // The legacy category never drives the class: price_increase + down code is
  // a reduction, and a tiers-only change may carry price_increase.
  assert.equal(S.newsOfferClass(evt({ category: 'price_increase', rate_change_code: 'news_rate_down' })), 'reduction')
  assert.equal(S.newsOfferClass(evt({ category: 'price_increase', has_tiers: true, ...flatRates,
    rate_change_code: 'news_rate_tiers_only' })), 'tiers_only')
  const genuinelyMixed = { current: { input: 6.0, output: 20.0, cache_read: 0.4, cache_write: 6.25 } }
  assert.equal(S.newsOfferClass(evt({ category: 'price_reduction', rate_change_code: 'news_rate_mixed', ...genuinelyMixed })), 'mixed')
  // The code contradicted by the comparable fields keeps a neutral class; the
  // per-field deltas still report the actual values.
  const contradicted = evt({ rate_change_code: 'news_rate_down',
    current: { input: 6.0, output: 30.0, cache_read: 0.6, cache_write: 7.0 } })
  assert.equal(S.newsOfferClass(contradicted), null, 'down code vs rising fields -> neutral')
  const deltas = S.newsEventDeltas(contradicted)
  assert.ok(deltas.fields.every(field => field.pct > 0), 'the chips still show the real values')
  // Agreeing code and fields keep the coded class.
  assert.equal(S.newsOfferClass(evt({ rate_change_code: 'news_rate_down' })), 'reduction')
  // A code with no comparable fields at all still applies.
  assert.equal(S.newsOfferClass(evt({
    previous: { input: null, output: null, cache_read: null, cache_write: null },
    rate_change_code: 'news_rate_up' })), 'increase')
})

test('newsGroupModels returns plans and listings alongside groups and cards', () => {
  const { groups, cards, plans, listings, entries } = S.newsGroupModels([
    evt({ id: 'g1' }),
    evt({ id: 'p1', model: '', category: 'subscription', observed_at: '2026-11-02T00:00:00Z' }),
    evt({ id: 'n1', model: '', category: 'new_model', observed_at: '2026-11-01T00:00:00Z' }),
  ])
  assert.equal(groups.length, 1)
  assert.deepEqual(plans.map(item => item.id), ['p1'])
  assert.deepEqual(listings.map(item => item.id), ['n1'])
  assert.deepEqual(cards.map(item => item.id), ['p1', 'n1'])
  assert.equal(entries.length, 3)
})

test('newsOfferEvents, newsPage and newsSearchFilter exist with their contracts', () => {
  const { groups, entries } = S.newsGroupModels([
    evt({ id: 'g1' }), evt({ id: 'g0', observed_at: '2026-11-01T00:00:00Z' }),
  ])
  assert.deepEqual(S.newsOfferEvents(groups[0].offers[0]).map(e => e.id), ['g1', 'g0'])
  assert.deepEqual(S.newsOfferEvents(null), [])
  assert.deepEqual(S.newsOfferEvents({ latest: evt({ id: 'solo' }) }).map(e => e.id), ['solo'])
  const page = S.newsPage(['a', 'b', 'c'], 2)
  assert.deepEqual(page.visible, ['a', 'b'])
  assert.equal(page.remaining, 1)
  assert.equal(S.newsPage(['a'], 10).remaining, 0)
  assert.equal(S.newsSearchFilter(entries, { query: 'ANTHROPIC', nowMs: NOW }).length, 1)
  assert.equal(S.newsSearchFilter(entries, { query: 'nomatch', nowMs: NOW }).length, 0)
  assert.equal(S.newsSearchFilter(entries, { query: '', nowMs: NOW }).length, 1)
})

test('newsFieldDeltas aliases newsEventDeltas', () => {
  assert.equal(S.newsFieldDeltas, S.newsEventDeltas)
  const item = evt()
  assert.deepEqual(S.newsFieldDeltas(item).fields, S.newsEventDeltas(item).fields)
})

test('the transition key requires known tiers to count, and proof needs explicit fields', () => {
  assert.equal(S.newsTransitionKey(evt()), S.newsTransitionKey(evt()), 'stable')
  assert.notEqual(S.newsTransitionKey(evt()), S.newsTransitionKey(evt({ current: { input: 9, output: 25.0, cache_read: 0.5, cache_write: 6.25 } })))
  // Tiers only participate when tiers_detail is 'known'.
  const withTiers = over => evt({ has_tiers: true, tiers_before: [{ type: 'a', size: 1 }], ...over })
  assert.equal(S.newsTransitionKey(withTiers()), S.newsTransitionKey(withTiers({ tiers_after: [{ type: 'b', size: 2 }] })),
    'unknown tier detail keeps the key transition-identical')
  assert.notEqual(S.newsTransitionKey(withTiers({ tiers_detail: 'known' })),
    S.newsTransitionKey(withTiers({ tiers_detail: 'known', tiers_after: [{ type: 'b', size: 2 }] })),
    'known tiers with different rows are a different transition')
  // Proof: nothing implicit — nearby time alone is not proof (the two items
  // here carry different sources, so no other proof fires either).
  assert.equal(S.newsSameEventProof(evt({ observed_at: '2026-11-03T00:00:00Z', source_url: 'https://a' }),
    evt({ observed_at: '2026-11-03T00:00:02Z', source_url: 'https://b' })), false)
  assert.equal(S.newsSameEventProof(evt({ observed_at: '2026-11-03T00:00:00Z' }),
    evt({ observed_at: '2026-11-03T00:00:00Z' })), true)
  assert.equal(S.newsSameEventProof(evt({ effective_at: '2026-11-05T00:00:00Z', source_url: 'https://x' }),
    evt({ effective_at: '2026-11-05T00:00:00Z', source_url: 'https://x' })), true)
  assert.equal(S.newsSameEventProof(
    evt({ effective_at: '2026-11-05T00:00:00Z', source_url: '', observed_at: '2026-11-03T00:00:00Z' }),
    evt({ effective_at: '2026-11-05T00:00:00Z', source_url: '', observed_at: '2026-11-04T00:00:00Z' })), false,
    'effective_at alone is not proof')
  assert.equal(S.newsSameEventProof(evt({ event_id: 'k' }), evt({ event_id: 'k' })), true)
  assert.equal(S.newsSameEventProof(
    evt({ observed_at: '2026-11-03T00:00:00Z', source_url: '', effective_at: '' }),
    evt({ observed_at: '2026-11-04T00:00:00Z', source_url: '', effective_at: '' })), false,
    'empty link fields prove nothing on their own')
  assert.equal(S.newsSameEventProof(null, evt()), false)
})

test('every verifier export exists with the required values', () => {
  for (const name of ['NewsPage', 'NewsCard', 'NewsRateTable', 'NEWS_CSS', 'NEWS_CATEGORIES',
    'newsFilter', 'newsIsRelevant', 'newsRelevanceReasons', 'newsEmptyText', 'newsImpactText',
    'newsSummaryText', 'newsGroupModels', 'newsOfferEvents', 'newsFieldDeltas', 'newsTierComparison',
    'newsOfferClass', 'newsRankForYou', 'newsSearchFilter', 'newsPage', 'NewsModelGroup',
    'NewsOfferRow', '$newsShowAll', '$newsSearch', '$newsDays', '$newsShown', '$newsExpanded',
    '$newsScope', '$newsCategory', '$newsLiveState', 'newsGroupReasons', 'newsItemReasons',
    'newsEntryMatchesSearch', 'newsFilterEntries', 'newsGroupImpactText', 'newsFmtPct',
    'newsClassLabel', 'newsClearFilters', 'newsToggleDetails', 'NewsScopeTabs']) {
    assert.ok(S[name] !== undefined, `__test.${name} exists`)
  }
  assert.equal(S.NEWS_PAGE_SIZE, 10)
  assert.equal(S.NEWS_FOR_YOU_INITIAL, 5)
  const grouped = S.newsGroupModels([evt({ id: 'g1' })])
  for (const key of ['groups', 'plans', 'listings']) assert.ok(Array.isArray(grouped[key]), key)
})

test('observed-at proof needs matching effective_at and non-conflicting URLs', () => {
  const NOW = '2026-11-03T00:00:00Z'
  // Equal observed, equal effective (both empty), one URL missing: proof.
  assert.equal(S.newsSameEventProof(
    evt({ observed_at: NOW, effective_at: '', source_url: '' }),
    evt({ observed_at: NOW, effective_at: '', source_url: 'https://models.dev' })), true,
    'a missing URL does not conflict with a present one')
  // Conflicting non-empty URLs: no proof even with equal observed_at.
  assert.equal(S.newsSameEventProof(
    evt({ observed_at: NOW, effective_at: '', source_url: 'https://a' }),
    evt({ observed_at: NOW, effective_at: '', source_url: 'https://b' })), false)
  // Conflicting effective dates: no proof.
  assert.equal(S.newsSameEventProof(
    evt({ observed_at: NOW, effective_at: '2026-11-05T00:00:00Z', source_url: '' }),
    evt({ observed_at: NOW, effective_at: '2026-11-06T00:00:00Z', source_url: '' })), false)
})

test('an exact same stored ID dedupes to one event with all evidence kept', () => {
  // The same stored id from both origins collapses to one event, and BOTH
  // original records stay reachable as evidence — a later same-id occurrence
  // with a different origin, URL, provenance or timestamps is never dropped.
  const local = evt({ id: 'md-shared', origin: 'local',
    observed_at: '2026-11-03T00:00:00Z',
    effective_at: '2026-11-05T00:00:00Z', source_url: 'https://example.com/local',
    provenance: 'Hermes local scan' })
  const central = evt({ id: 'md-shared', origin: 'central',
    observed_at: '2026-11-04T00:00:00Z',
    effective_at: '2026-11-06T00:00:00Z', source_url: 'https://example.com/central',
    provenance: 'models.dev central feed' })
  const originals = structuredClone([local, central])
  Object.freeze(local)
  Object.freeze(central)
  const { groups } = S.newsGroupModels([local, central])
  const offer = groups[0].offers[0]
  assert.equal(offer.events.length, 1, 'one event for one stored id')
  assert.equal(offer.latest.id, 'md-shared')
  // The event's own fields stay the untouched first occurrence.
  assert.equal(offer.latest.effective_at, '2026-11-05T00:00:00Z', 'effective_at is kept, not overwritten')
  assert.equal(offer.latest.source_url, 'https://example.com/local')
  assert.equal(offer.latest.observed_at, '2026-11-03T00:00:00Z')
  assert.equal(offer.latest.origin, 'local')
  assert.equal(offer.latest.provenance, 'Hermes local scan')
  // Both original records are retained, by identity, in arrival order.
  assert.deepEqual(offer.latest.merged_sources, [local, central],
    'every original record is retained as evidence, originals unchanged')
  assert.deepEqual(offer.history, [])
  // The incoming payload objects themselves are never mutated.
  assert.equal(central.effective_at, '2026-11-06T00:00:00Z')
  assert.equal(central.source_url, 'https://example.com/central')
  assert.ok(!('merged_sources' in central), 'no evidence field is written back into the payload')
  // The real grouping entry point (not only newsMergeEvents) keeps the
  // evidence through ordering and enrichment.
  assert.equal(offer.events[0].merged_sources.length, 2)
  assert.equal(offer.events[0].merged_sources[0], local)
  assert.equal(offer.events[0].merged_sources[1], central)
  assert.deepEqual([local, central], originals, 'both frozen input records stay unchanged')
})

const TIERS_BEFORE = [{ type: 'context', size: 200000, input: 2.0, output: 10.0, cache_read: 0.2 }]
const TIERS_AFTER = [{ type: 'context', size: 200000, input: 1.6, output: 8.0, cache_read: 0.2 }]

test('a proven merged event demoted to History keeps every original record', () => {
  // Intermediate state first: local l1 and central c1 (different ids, equal
  // observed_at, known tiers on both sides) are merged as the offer latest.
  const l1 = evt({ id: 'l1', origin: 'local', observed_at: '2026-11-03T00:00:00Z',
    effective_at: '2026-11-05T00:00:00Z', source_url: 'https://example.com/local-scan',
    provenance: 'Hermes local scan', tiers_detail: 'known',
    tiers_before: TIERS_BEFORE, tiers_after: TIERS_AFTER })
  const c1 = evt({ id: 'c1', origin: 'central', observed_at: '2026-11-03T00:00:00Z',
    effective_at: '2026-11-05T00:00:00Z', source_url: 'https://example.com/local-scan',
    provenance: 'models.dev central feed', tiers_detail: 'known',
    tiers_before: TIERS_BEFORE, tiers_after: TIERS_AFTER })
  const before = S.newsGroupModels([l1, c1]).groups[0].offers[0]
  assert.equal(before.events.length, 1)
  assert.deepEqual(before.latest.merged_sources, [l1, c1])
  assert.equal(before.latest.tiers_detail, 'known')

  // A newer event for the same offer demotes the merged event to History.
  const l2 = evt({ id: 'l2', origin: 'local', observed_at: '2026-11-05T00:00:00Z',
    current: { input: 6.0, output: 30.0, cache_read: 0.6, cache_write: 7.0 } })
  const offer = S.newsGroupModels([l1, c1, l2]).groups[0].offers[0]
  assert.equal(offer.events.length, 2, 'the newer event does not inflate the count')
  assert.equal(offer.latest.id, 'l2')
  assert.deepEqual(offer.history.map(event => event.id), ['l1'])
  const merged = offer.history[0]
  assert.deepEqual(merged.merged_sources, [l1, c1],
    'both original records survive the demotion, by identity')
  assert.equal(merged.observed_at, '2026-11-03T00:00:00Z')
  assert.equal(merged.effective_at, '2026-11-05T00:00:00Z')
  assert.equal(merged.source_url, 'https://example.com/local-scan')
  assert.equal(merged.provenance, 'Hermes local scan')
  assert.equal(merged.tiers_detail, 'known')
  assert.deepEqual(merged.tiers_before, TIERS_BEFORE, 'raw tier blocks stay exact')
  assert.deepEqual(merged.tiers_after, TIERS_AFTER)
  assert.deepEqual(merged.previous, l1.previous, 'was/now rates stay exact')
  assert.deepEqual(merged.current, l1.current)
  // All three payload objects stay untouched.
  for (const original of [l1, c1, l2]) assert.ok(!('merged_sources' in original))
})

test('a same-id wrapper still merges 1:1 with a different-id partner', () => {
  // l1 and its same-id central copy collapse into one event; that event then
  // still merges with the differently-id c2 under the ordinary proof (a
  // shared event_id, which also tolerates the two differing URLs) — the
  // evidence list stays flat and keeps all three original records.
  const l1 = evt({ id: 'l1', origin: 'local', observed_at: '2026-11-03T00:00:00Z',
    event_id: 'ev-9' })
  const sameIdCentral = evt({ id: 'l1', origin: 'central',
    observed_at: '2026-11-04T00:00:00Z', source_url: 'https://example.com/central',
    event_id: 'ev-9' })
  const c2 = evt({ id: 'c2', origin: 'central', observed_at: '2026-11-03T00:00:00Z',
    source_url: 'https://example.com/central-mirror', event_id: 'ev-9' })
  const offer = S.newsGroupModels([l1, sameIdCentral, c2]).groups[0].offers[0]
  assert.equal(offer.events.length, 1, 'one event, three original records')
  assert.deepEqual(offer.latest.merged_sources, [l1, sameIdCentral, c2])
  assert.equal(offer.latest.id, 'l1')
  assert.equal(offer.latest.observed_at, '2026-11-03T00:00:00Z',
    'the merge is observed at the newest of the merged pair')
})

test('a central same-id wrapper retains every record when merged with a local partner', () => {
  const local = evt({ id: 'local', origin: 'local', source_url: 'https://example.com/pricing',
    effective_at: '2026-11-05T00:00:00Z' })
  const central = evt({ ...local, id: 'central', origin: 'central' })
  const copy = evt({ ...central, provenance: 'central second observation',
    observed_at: '2026-11-04T12:34:56Z' })
  const originals = structuredClone([central, copy, local])
  const offer = S.newsGroupModels([central, copy, local]).groups[0].offers[0]
  assert.equal(offer.events.length, 1)
  assert.deepEqual(offer.latest.merged_sources, [local, central, copy], 'flat evidence on both sides')
  assert.deepEqual([central, copy, local], originals, 'neither wrapper mutates incoming records')
})

// --- WP11 fixture tests: the real generated payloads -------------------------

const readFixture = name => JSON.parse(
  readFileSync(new URL(`../test/fixtures/news/${name}`, import.meta.url), 'utf8'))

test('payload-local-central: every model pair merges under the proof rules', () => {
  const payload = readFixture('payload-local-central.json')
  const combined = [...payload.local.items, ...payload.central.items]
  const { groups, plans, listings, entries } = S.newsGroupModels(combined)
  // Seven exact model identities, one merged offer event each.
  assert.deepEqual(groups.map(g => g.model).sort(), [
    'anthropic/claude-haiku-4-5', 'claude-haiku-4-5', 'claude-haiku-4-5-20251001',
    'claude-opus-4', 'claude-sonnet-4', 'glm-large', 'text-plain',
  ].sort())
  for (const group of groups) {
    assert.equal(group.offers.length, 1, `${group.model}: one provider offer`)
    const offer = group.offers[0]
    assert.equal(offer.events.length, 1, `${group.model}: local+central merged`)
    assert.equal(offer.latest.merged_sources.length, 2)
    assert.equal(offer.latest.merged_sources[0].origin, 'local')
    assert.equal(offer.latest.merged_sources[1].origin, 'central')
    assert.deepEqual(offer.history, [])
  }
  // The sonnet pair merged on equal observed_at with a missing local URL.
  const sonnet = groups.find(g => g.model === 'claude-sonnet-4')
  assert.deepEqual(sonnet.offers[0].latest.merged_sources.map(s => s.id),
    ['local-price-reduction-anthropic-claude-sonnet-4--r-----cache-read---0-3--2ea96cf7f1',
      'md-cca3c3148481'])
  assert.equal(sonnet.model_name, 'Claude Sonnet 4')
  // Cards stay unmerged by origin: plans and provider listings.
  assert.equal(plans.length, 1)
  assert.equal(listings.length, 2)
  assert.equal(entries.length, 10)
})

test('payload-local-central: coded classes and honest per-field chips', () => {
  const payload = readFixture('payload-local-central.json')
  const { groups } = S.newsGroupModels([...payload.local.items, ...payload.central.items])
  const classOf = model => groups.find(g => g.model === model).offers[0].news_class
  // rate_change_code news_rate_mixed agreed by the comparable fields.
  assert.equal(classOf('claude-sonnet-4'), 'mixed')
  // news_rate_tiers_only with unchanged base rates and a comparable tier row.
  assert.equal(classOf('glm-large'), 'tiers_only')
  assert.equal(classOf('claude-opus-4'), 'increase')
  for (const model of ['text-plain', 'anthropic/claude-haiku-4-5', 'claude-haiku-4-5',
    'claude-haiku-4-5-20251001']) {
    assert.equal(classOf(model), 'new_listing')
  }
  // glm-large tiers: known detail, matching keys, per-row deltas kept.
  const glm = groups.find(g => g.model === 'glm-large').offers[0]
  assert.equal(glm.tierStatus, 'match')
  assert.equal(glm.tierDir, 'down')
  assert.equal(glm.tierRows.length, 1)
  assert.equal(glm.tierRows[0].type, 'context')
  // The backend impact of the merged sonnet event is keyed by its primary id.
  const impact = payload.impacts[sonnetId()]
  assert.equal(impact.basis, 'full')
  function sonnetId() {
    return 'local-price-reduction-anthropic-claude-sonnet-4--r-----cache-read---0-3--2ea96cf7f1'
  }
})

test('payload-local-central: For You ranks by exact recency then materiality', () => {
  const payload = readFixture('payload-local-central.json')
  const { groups } = S.newsGroupModels([...payload.local.items, ...payload.central.items])
  const nowMs = Date.parse('2027-01-01T06:00:00Z')
  const ranked = S.newsRankForYou(groups, nowMs)
  assert.deepEqual(ranked.map(g => g.model), [
    'claude-sonnet-4',            // used 00:08:52 — the newest exact use
    'anthropic/claude-haiku-4-5', // used 00:07:12
    'claude-haiku-4-5',           // used 00:03:52
    'claude-opus-4',              // no recency; strong configured_provider; +20% materiality
    'claude-haiku-4-5-20251001',  // no recency; strong reason; no comparable change
  ])
  // for_you false booleans stay out of For You entirely.
  assert.ok(!ranked.some(g => g.model === 'glm-large' || g.model === 'text-plain'))
})

test('payload-unknown-recurrence: recurrence stays separate; the newest drives the class', () => {
  const payload = readFixture('payload-unknown-recurrence.json')
  const { groups } = S.newsGroupModels([...payload.local.items, ...payload.central.items])
  assert.deepEqual(groups.map(g => g.model).sort(), ['m1', 'm2', 'm4'])
  const m1 = groups.find(g => g.model === 'm1').offers[0]
  // Up, down, up (local, hourly) and the central up an hour later: no proof
  // anywhere (observed differ, effective_at empty), so four separate events.
  assert.equal(m1.events.length, 4)
  assert.ok(m1.events.every(event => !Array.isArray(event.merged_sources)))
  assert.deepEqual(m1.events.map(event => event.observed_at), [
    '2027-01-01T05:03:52+00:00', '2027-01-01T04:03:52+00:00',
    '2027-01-01T03:03:52+00:00', '2027-01-01T02:03:52+00:00',
  ])
  // The newest event (the central one) drives the class: a plain rise, the
  // legacy category of the older events never leaks in.
  assert.equal(m1.latest.id, 'md-c312c6eae578')
  assert.equal(m1.news_class, 'increase')
  assert.deepEqual(m1.history.map(event => event.id), [
    'local-price-increase-acme-m1--r-----cache-read---null---cache-writ-eb62304d22-rf2ea95',
    'local-price-reduction-acme-m1--r-----cache-read---null---cache-writ-8f80b1eeda',
    'local-price-increase-acme-m1--r-----cache-read---null---cache-writ-eb62304d22',
  ])
  // m2 and m4 share the same observation, so their central counterparts merge.
  const m2 = groups.find(g => g.model === 'm2').offers[0]
  assert.equal(m2.events.length, 1)
  assert.deepEqual(m2.latest.merged_sources.map(s => s.origin), ['local', 'central'])
  assert.equal(m2.news_class, 'reduction')
  const m4 = groups.find(g => g.model === 'm4').offers[0]
  assert.equal(m4.events.length, 1)
  assert.equal(m4.news_class, 'new_listing')
  // Every item in this payload is for_you false: For You is empty.
  assert.deepEqual(S.newsRankForYou(groups, Date.parse('2027-01-01T06:00:00Z')), [])
})

test('payload-unknown-recurrence: unknown tiers degrade to the unavailable caveat', () => {
  const payload = readFixture('payload-unknown-recurrence.json')
  const { groups } = S.newsGroupModels([...payload.local.items, ...payload.central.items])
  const m2 = groups.find(g => g.model === 'm2').offers[0]
  assert.equal(m2.tierStatus, 'unavailable')
  assert.equal(m2.tierReason, 'tier_unavailable')
  assert.deepEqual(m2.tierRows, [], 'no fabricated rows')
  // The merged m2 event keeps the local item's model_name "" — the exact ID
  // stands alone; same for m4.
  assert.equal(groups.find(g => g.model === 'm2').model_name, '')
  assert.equal(groups.find(g => g.model === 'm4').model_name, '')
})

test('case-variant legacy used_model matches never claim model use', () => {
  const NOW = Date.parse('2027-01-01T06:00:00Z')
  // acme/M1 locally, m1 centrally: the loose legacy match must not become a
  // use claim for either, with no exact last_used_at present.
  const upper = evt({ id: 'u1', model: 'acme/M1', provider: 'acme',
    relevance: { relevant: true, reasons: ['used_model'] } })
  const lower = evt({ id: 'u2', model: 'm1', provider: 'acme',
    relevance: { relevant: true, reasons: ['used_model'] } })
  for (const item of [upper, lower]) {
    assert.equal(S.newsUsedRecently(item, NOW), false, 'no exact last_used_at, no recency')
    assert.deepEqual(S.newsItemReasonCodes(item, NOW), ['used_model'])
    assert.deepEqual(S.newsRelevanceReasons(item, t, NOW), ['newsReasonRelated()'])
  }
  const group = { offers: [{ latest: upper }, { latest: lower }] }
  assert.deepEqual(S.newsGroupReasons(group, t, NOW), ['newsReasonRelated()'])
})

test('exact last_used_at 31-90 days old says Used before; 30 days says Used recently', () => {
  const NOW = Date.parse('2027-01-01T06:00:00Z')
  const reasonsOf = last_used_at => S.newsItemReasonCodes(
    evt({ relevance: { relevant: true, reasons: [] }, last_used_at }), NOW)
  assert.deepEqual(reasonsOf('2027-01-01T00:00:00Z')[0], 'used_recently')
  assert.deepEqual(reasonsOf('2026-12-03T00:00:00Z')[0], 'used_recently', '29 days')
  assert.deepEqual(reasonsOf('2026-12-02T00:00:00Z')[0], 'used_before', '30 days + a moment')
  assert.deepEqual(reasonsOf('2026-10-05T00:00:00Z')[0], 'used_before', '88 days')
  // Malformed, future or empty values earn neither wording.
  for (const bad of ['not-a-date', '2027-06-01T00:00:00Z', '']) {
    assert.ok(!reasonsOf(bad).includes('used_recently'), bad)
    assert.ok(!reasonsOf(bad).includes('used_before'), bad)
  }
  // The truthful non-recent label exists in both locales and never claims recency.
  assert.equal(S.I18N.en.newsReasonUsedBefore, 'Used before')
  assert.ok(S.I18N.zh.newsReasonUsedBefore.includes('之前'))
  const enT = (key, ...args) => {
    const entry = S.I18N.en[key]
    return typeof entry === 'function' ? entry(...args) : entry ?? key
  }
  assert.deepEqual(S.newsRelevanceReasons(
    evt({ relevance: { relevant: true, reasons: [] }, last_used_at: '2026-10-05T00:00:00Z' }), enT, NOW),
    ['Used before'])
})
