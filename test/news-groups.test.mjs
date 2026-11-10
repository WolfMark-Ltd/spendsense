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
  // Missing detail counts as unknown too.
  assert.equal(S.newsTierComparison(evt({ has_tiers: true })).reason, 'tier_type_unknown')
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
    'tier_type_unknown', 'legacy nested tiers arrays are never read')
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
  // Even with an out-of-window last_used_at the fuzzy code stays neutral.
  const stale = evt({ id: 'sx', model: 'a/x', relevance: { relevant: true, reasons: ['used_model'] },
    last_used_at: '2026-01-01T00:00:00Z' })
  assert.deepEqual(S.newsItemReasonCodes(stale, NOW), ['used_model'])
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
