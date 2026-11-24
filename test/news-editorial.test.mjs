// Run: node --test --test-force-exit test/*.test.mjs
//
// WP22 Model News editorial layer — the deterministic briefing behind the
// headline surface. Pure helpers only: no React, no network, no user data.
//
// The parity block compares the Desktop port against the answer the Python
// builder recorded in test/fixtures/news/editorial-golden.json (regenerate with
// `python3 scripts/news-editorial-golden.py`). Both implementations must agree
// on every fact a headline prints; only `family_label` is presentation.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'

// --- stub loader for the pure helpers (same pattern as test/news.test.mjs) ---
const src = readFileSync(new URL('../desktop/plugin.js', import.meta.url), 'utf8')
const stub = `
const atom = v => { let s = v; return { get: () => s, set: n => { s = n }, listen: () => () => {} } }
const gatewayActivationEpoch = () => 1
const computed = (stores, cb) => ({ get: () => cb(), listen: () => () => {} })
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
const stubDir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'wm-news-editorial-'))
const stubFile = join(stubDir, 'plugin.mjs')
writeFileSync(stubFile, stubBody)
const S = (await import(pathToFileURL(stubFile).href)).__test

const REALISTIC = JSON.parse(readFileSync(
  new URL('./fixtures/news/realistic.json', import.meta.url), 'utf8'))
const GOLDEN = JSON.parse(readFileSync(
  new URL('./fixtures/news/editorial-golden.json', import.meta.url), 'utf8'))
const ITEMS = [...REALISTIC.local.items, ...REALISTIC.central.items]
const GENERATED_AT = REALISTIC.central.fetched_at

const item = overrides => ({
  id: 'md-1', category: 'price_reduction', provider: 'acme', model: 'acme-1',
  observed_at: '2026-11-10T00:00:00Z', source_url: 'https://models.dev',
  confidence: 'observed', previous: {}, current: {}, ...overrides,
})

// --- identity -----------------------------------------------------------------

test('a namespace, separators and a presentation suffix never split a family', () => {
  assert.equal(S.newsModelFamily('deepseek/deepseek-v4.1-flash'), 'deepseek-v4.1-flash')
  assert.equal(S.newsModelFamily('deepseek-v4.1-flash'), 'deepseek-v4.1-flash')
  assert.equal(S.newsModelFamily('openrouter/anthropic/claude-sonnet-4.5'), 'claude-sonnet-4.5')
  assert.equal(S.newsModelFamily('google/gemma-4-26b-a4b-it:thinking'), 'gemma-4-26b-a4b-it')
  assert.equal(S.newsModelFamily('gemma 4 26b a4b it_flex'), 'gemma-4-26b-a4b-it')
  assert.equal(S.newsModelFamily(''), '')
  assert.equal(S.newsModelFamily(null), '')
})

test('distinct versions keep distinct families', () => {
  assert.notEqual(S.newsModelFamily('kimi-k3'), S.newsModelFamily('kimi-k3.1-pro'))
  assert.notEqual(S.newsModelFamily('claude-sonnet-4-5'), S.newsModelFamily('claude-sonnet-4-5-20250929'))
})

test('family labels use vendor casing, including a welded version', () => {
  assert.equal(S.newsFamilyLabel(S.newsModelFamily('deepseek/deepseek-v4.1-flash')),
    'DeepSeek V4.1 Flash')
  assert.equal(S.newsFamilyLabel('qwen3.5-9b'), 'Qwen3.5 9B')
  assert.equal(S.newsFamilyLabel('glm-5.3-flash'), 'GLM 5.3 Flash')
  assert.equal(S.newsFamilyLabel('kimi-k3'), 'Kimi K3')
})

test('a preview signal needs the provider label, not a substring', () => {
  assert.equal(S.newsPreviewSignal('tencent/hy4-preview'), true)
  assert.equal(S.newsPreviewSignal('model-x', 'Foo Preview'), true)
  assert.equal(S.newsPreviewSignal('claude-sonnet-5'), false)
  assert.equal(S.newsPreviewSignal('previousthing'), false)
})

// --- rate comparison ----------------------------------------------------------

test('each rate type is compared separately and mixed directions survive', () => {
  const comparison = S.newsEditorialComparison(
    { input: 1, output: 4, cache_read: 0.1 },
    { input: 0.5, output: 6, cache_read: 0.1 })
  assert.equal(comparison.direction, 'mixed')
  assert.equal(comparison.rates.input.pct, -50)
  assert.equal(comparison.rates.output.pct, 50)
  assert.equal(comparison.rates.cache_read.pct, 0)
  // The dominant rate is the rate that moves most in USD per 1M tokens: the
  // output move (+2.0) beats the input cut (-0.5), which is what a buyer feels.
  assert.equal(comparison.dominant, 'output')
  assert.equal(comparison.max_abs_delta, 2)
  assert.deepEqual(comparison.comparable, ['input', 'output', 'cache_read'])
})

test('a zero baseline yields a delta and no percentage', () => {
  const comparison = S.newsEditorialComparison({ input: 0 }, { input: 0.25 })
  assert.equal(comparison.rates.input.pct, null)
  assert.equal(comparison.rates.input.delta, 0.25)
  assert.equal(comparison.incomparable.input, 'news_ev_zero_baseline')
  assert.equal(comparison.direction, 'up')
})

test('a missing side is incomparable, never a fabricated move', () => {
  const comparison = S.newsEditorialComparison(null, { input: 1 })
  assert.equal(comparison.direction, 'unknown')
  assert.deepEqual(comparison.rates, {})
  assert.equal(comparison.incomparable.input, 'news_ev_side_missing')
  assert.equal(comparison.max_abs_delta, null)
})

test('a negative or non-finite rate is absent, not zero', () => {
  const comparison = S.newsEditorialComparison({ input: -1, output: 2 }, { input: 1, output: 3 })
  assert.equal(comparison.rates.input, undefined)
  assert.equal(comparison.incomparable.input, 'news_ev_rate_absent')
  assert.equal(comparison.rates.output.pct, 50)
})

// --- taxonomy -----------------------------------------------------------------

test('a model-less catalogue entry is a provider listing, never a launch', () => {
  assert.equal(S.newsEditorialEventType(item({ category: 'new_model', model: '' })),
    'provider_listed')
  assert.equal(S.newsEditorialEventType(item({ category: 'new_model', model: 'acme-1' })),
    'new_to_catalogue')
  const entry = S.newsEditorialEntry(item({
    category: 'new_model', model: 'acme-1', first_seen_at: '2026-11-09T00:00:00Z',
    current: { input: 1, output: 2 },
  }))
  assert.equal(entry.headline_code, 'news_head_new_to_catalogue')
  assert.doesNotMatch(entry.headline, /launch/)
})

test('only a verified or curated note may say a model launched', () => {
  for (const confidence of ['verified', 'curated']) {
    const entry = S.newsEditorialEntry(item({
      category: 'new_model', model: 'acme-1', confidence,
      first_seen_at: '2026-11-09T00:00:00Z', current: { input: 1 },
    }))
    assert.equal(entry.headline_code, 'news_head_launched')
  }
  assert.equal(S.newsEditorialEntry(item({
    category: 'new_model', model: 'acme-1', confidence: 'observed',
    current: { input: 1 },
  })).headline_code, 'news_head_new_to_catalogue')
})

test('a price change is re-read from its own rates, so mixed is not one-way', () => {
  assert.equal(S.newsEditorialEventType(item({
    category: 'price_increase',
    previous: { input: 2, output: 2 }, current: { input: 1, output: 4 },
  })), 'price_mixed')
  assert.equal(S.newsEditorialEventType(item({
    category: 'price_reduction',
    previous: { input: 2, output: 2 }, current: { input: 1, output: 4 },
  })), 'price_mixed')
  assert.equal(S.newsEditorialEventType(item({
    category: 'price_increase',
    previous: { input: 1 }, current: { input: 2 },
  })), 'price_increase')
})

test('an explicit publisher event type wins over the legacy category', () => {
  assert.equal(S.newsEditorialEventType(item({
    category: 'price_increase', event_type: 'removed_from_provider',
  })), 'removed_from_provider')
  assert.equal(S.newsEditorialEventType(item({ category: 'price_increase', event_type: 'nonsense' })),
    'price_increase')
  assert.equal(S.newsEditorialEventType(item({ category: 'weird' })), 'unknown')
})

test('a subscription item is a new plan or a plan change', () => {
  assert.equal(S.newsEditorialEventType(item({
    category: 'subscription', summary_code: 'news_sum_new_plan',
  })), 'new_plan')
  assert.equal(S.newsEditorialEventType(item({
    category: 'subscription', summary_code: 'news_sum_plan_change',
  })), 'plan_change')
})

// --- briefing -----------------------------------------------------------------

test('the briefing carries the published section contract and one headline each', () => {
  const briefing = S.newsBuildBriefing(ITEMS, { generatedAt: GENERATED_AT })
  assert.equal(briefing.version, 1)
  const ids = briefing.sections.map(section => section.id)
  assert.deepEqual(ids, ['biggest_reductions', 'biggest_increases', 'mixed_price_changes',
    'new_models', 'newly_available', 'removals', 'subscriptions', 'preview_models'])
  for (const section of briefing.sections) {
    assert.ok(section.total >= section.entries.length, `${section.id} total bounds its rows`)
    for (const entry of section.entries) {
      assert.ok(entry.headline_code, `${section.id} entry carries a message code`)
      assert.ok(entry.headline, `${section.id} entry carries an English fallback`)
      assert.ok(entry.provider, `${section.id} entry names a provider`)
    }
  }
  assert.equal(briefing.counts.events, ITEMS.length)
})

test('removals are never fabricated without absence history', () => {
  const briefing = S.newsBuildBriefing(ITEMS, { generatedAt: GENERATED_AT })
  assert.equal(briefing.sections.find(section => section.id === 'removals').entries.length, 0)
  assert.deepEqual(briefing.unsupported.find(item => item.id === 'removals'),
    { id: 'removals', reason_code: 'news_unsupported_no_absence_history' })
  // Claiming tracking without any confirmed record is still not evidence.
  const tracked = S.newsBuildBriefing(ITEMS, { generatedAt: GENERATED_AT, removalTracking: true })
  assert.equal(tracked.sections.find(section => section.id === 'removals').entries.length, 0)
  assert.equal(tracked.unsupported.some(item => item.id === 'removals'), false)
})

test('an unsupported section is named, not silently empty', () => {
  const noPlans = ITEMS.filter(entry => entry.category !== 'subscription')
  const briefing = S.newsBuildBriefing(noPlans, { generatedAt: GENERATED_AT })
  assert.deepEqual(briefing.unsupported.find(item => item.id === 'subscriptions'),
    { id: 'subscriptions', reason_code: 'news_unsupported_no_plan_events' })
  const withPlans = S.newsBuildBriefing(ITEMS, { generatedAt: GENERATED_AT })
  assert.equal(withPlans.unsupported.some(item => item.id === 'subscriptions'), false)
})

test('the materiality floor demotes noise without dropping it from All Updates', () => {
  const belowFloor = item({
    id: 'md-below', previous: { input: 1.01 }, current: { input: 1 },
  })
  const qualifies = item({ id: 'md-up', previous: { input: 1 }, current: { input: 2 } })
  const briefing = S.newsBuildBriefing([belowFloor, qualifies], { generatedAt: GENERATED_AT })
  assert.equal(briefing.counts.events, 2)
  assert.equal(briefing.counts.price_reduction, 1)
  assert.equal(briefing.counts.price_increase, 1)
  const reductions = briefing.sections.find(section => section.id === 'biggest_reductions')
  assert.equal(reductions.total, 0, 'a 1% move is not a headline')
  assert.equal(briefing.sections.find(section => section.id === 'biggest_increases').total, 1)
  // Every supplied event stays countable, headlined or not.
  assert.equal(briefing.all_updates.total, 2)
})

test('a family group keeps every provider row under one banner', () => {
  const briefing = S.newsBuildBriefing([
    item({ id: 'md-a', provider: 'alpha', model: 'z-ai/glm-5.3-flash',
      previous: { input: 1 }, current: { input: 0.5 } }),
    item({ id: 'md-b', provider: 'beta', model: 'glm-5.3-flash',
      previous: { input: 2 }, current: { input: 0.5 } }),
  ], { generatedAt: GENERATED_AT })
  const section = briefing.sections.find(entry => entry.id === 'biggest_reductions')
  assert.equal(section.total, 1, 'one family, not two stories')
  const [group] = section.entries
  assert.equal(group.headline_code, 'news_head_group')
  assert.equal(group.family_event_count, 2)
  assert.deepEqual(group.providers, ['alpha', 'beta'])
  assert.deepEqual(group.event_ids.sort(), ['md-a', 'md-b'])
  assert.equal(group.variants.length, 2)
  for (const variant of group.variants) {
    assert.ok(variant.headline_code, 'each variant stays localisable')
    assert.ok(variant.event_ids.length, 'each variant keeps its own event link')
  }
})

test('a family group collapses byte-identical rows into one observed count', () => {
  // UAT: one transition re-observed (recurrence plus central echo) rendered
  // three identical rows. Same displayed row collapses; every id survives;
  // a genuinely different transition stays its own row.
  const same = (id, observed_at) => S.newsEditorialEntry(item({ id, provider: 'openrouter',
    model: 'z-ai/glm-5.3-flash', observed_at,
    previous: { input: 0.15, output: 0.5 }, current: { input: 0.0399, output: 0.0784 } }))
  const other = S.newsEditorialEntry(item({ id: 'md-other', provider: 'openrouter',
    model: 'z-ai/glm-5.3-flash', observed_at: '2026-11-23T00:00:00Z',
    previous: { input: 0.15, output: 0.5 }, current: { input: 0.12, output: 0.38 } }))
  const entries = [same('md-1', '2026-11-22T10:40:00Z'), other,
    same('md-2', '2026-11-22T21:08:00Z'), same('md-3', '2026-11-22T22:29:00Z')]
  const [group] = S.newsEditorialGroup(entries)
  assert.equal(group.family_event_count, 4, 'the banner still counts every member')
  assert.deepEqual(group.event_ids.sort(), ['md-1', 'md-2', 'md-3', 'md-other'])
  assert.equal(group.variants.length, 2, 'identical rows collapse, the distinct transition stays')
  const collapsed = group.variants.find(variant => variant.observed_count === 3)
  const distinct = group.variants.find(variant => variant.observed_count === undefined)
  assert.ok(collapsed && distinct, 'one collapsed row and one lone row')
  assert.equal(collapsed.observed_count, 3)
  assert.deepEqual(collapsed.event_ids.sort(), ['md-1', 'md-2', 'md-3'])
  assert.equal(collapsed.observed_at, '2026-11-22T22:29:00Z', 'the collapsed row carries the newest date')
  assert.equal(distinct.observed_count, undefined, 'a lone row carries no count')
  assert.equal(distinct.event_ids.length, 1)
})

test('a collapsed variant row names its observed count in both languages', () => {
  for (const locale of ['en', 'zh']) {
    const t = (key, ...args) => {
      const entry = S.I18N[locale][key]
      return typeof entry === 'function' ? entry(...args) : entry ?? key
    }
    assert.equal(S.newsVariantObservedSuffix({ observed_count: 3 }, t),
      locale === 'en' ? ' — observed 3 times' : ' — 已观察 3 次')
    assert.equal(S.newsVariantObservedSuffix({}, t), null, 'a lone row carries no suffix')
    assert.equal(S.newsVariantObservedSuffix({ observed_count: 1 }, t), null)
    assert.equal(S.newsVariantObservedSuffix({ observed_count: 2.9 }, t),
      locale === 'en' ? ' — observed 2 times' : ' — 已观察 2 次',
      'a fractional count floors instead of printing decimals')
    assert.equal(S.newsVariantObservedSuffix({ observed_count: 'x' }, t), null)
  }
})

test('members with conflicting source URLs never collapse away evidence', () => {
  // Same displayed row, but two non-empty source URLs that differ are
  // distinct observations (the merge layer's own rule): each keeps its
  // own row and evidence link. A missing URL never conflicts.
  const same = (id, source_url) => S.newsEditorialEntry(item({ id, provider: 'acme',
    model: 'acme-1', source_url,
    previous: { input: 10 }, current: { input: 5 } }))
  const clashing = S.newsEditorialGroup([
    same('md-u1', 'https://example.com/a'), same('md-u2', 'https://example.com/b')])
  assert.equal(clashing[0].variants.length, 2, 'conflicting URLs stay separate')
  assert.ok(clashing[0].variants.every(variant => variant.observed_count === undefined))
  const missing = S.newsEditorialGroup([
    same('md-u3', 'https://example.com/a'), same('md-u4', '')])
  assert.equal(missing[0].variants.length, 1, 'a missing URL collapses')
  assert.equal(missing[0].variants[0].observed_count, 2)
})

test('the collapse key mirrors exactly what the row renders', () => {
  const keyOf = overrides => S.newsEditorialRowKey(S.newsEditorialEntry(item({
    id: 'md-k', provider: 'acme', model: 'acme-1',
    previous: { input: 10 }, current: { input: 5 }, ...overrides })))
  assert.equal(keyOf({ observed_at: '2026-11-01T00:00:00Z' }),
    keyOf({ observed_at: '2026-11-02T00:00:00Z' }), 'stamps never split rows')
  const launched = confidence => S.newsEditorialRowKey(S.newsEditorialEntry(item({
    id: 'md-L', category: 'new_model', provider: 'acme', model: 'acme-9',
    confidence, first_seen_at: '2026-11-03T00:00:00Z' })))
  assert.equal(launched('verified'), launched('curated'),
    'launch confidence is unrendered, so it never splits rows')
  assert.notEqual(keyOf({}), keyOf({ previous: { input: 10 }, current: { input: 6 } }),
    'a different move keeps its own row')
})

test('mixed rows collapse when only unrendered percentages differ', () => {
  // The mixed row names raised/cut rates, never their percentages: two
  // members with the same rate lists but different pcts render identically.
  const mixed = (id, observed_at, after) => S.newsEditorialEntry(item({ id,
    provider: 'openrouter', model: 'z-ai/glm-5.3-flash', observed_at,
    previous: { input: 0.15, output: 0.5, cache_read: 0.03 }, current: after }))
  const [group] = S.newsEditorialGroup([
    mixed('md-x', '2026-11-24T05:46:00Z', { input: 0.77, output: 2.5, cache_read: 0.02 }),
    mixed('md-y', '2026-11-24T07:41:00Z', { input: 0.73, output: 2.4, cache_read: 0.02 }),
  ])
  assert.equal(group.variants.length, 1)
  assert.equal(group.variants[0].observed_count, 2)
  assert.deepEqual(group.variants[0].event_ids.sort(), ['md-x', 'md-y'])
})

test('For You splits unrelated providers out of a matched model group', () => {
  const relevant = item({ id: 'md-a', provider: 'alpha', model: 'glm-5.3-flash' })
  relevant.relevance = { relevant: true, reasons: ['configured_provider'] }
  const unrelated = item({ id: 'md-b', provider: 'beta', model: 'glm-5.3-flash' })
  const grouped = S.newsGroupModels([relevant, unrelated])
  const [group] = grouped.groups
  const focused = S.newsFocusGroup(group)
  assert.deepEqual(focused.focusOffers.map(offer => offer.provider), ['alpha'])
  assert.deepEqual(focused.otherOffers.map(offer => offer.provider), ['beta'])
  // Nothing is deleted: the group still carries every offer for the archive.
  assert.equal(focused.offers.length, 2)
})

test('For You keeps a group intact when no offer or every offer matched', () => {
  const one = item({ id: 'md-a', provider: 'alpha', model: 'glm-5.3-flash' })
  const two = item({ id: 'md-b', provider: 'beta', model: 'glm-5.3-flash' })
  const [none] = S.newsGroupModels([one, two]).groups
  const unfocused = S.newsFocusGroup(none)
  assert.deepEqual(unfocused.focusOffers.map(offer => offer.provider).sort(), ['alpha', 'beta'])
  assert.deepEqual(unfocused.otherOffers, [])
  one.relevance = { relevant: true, reasons: ['used_provider'] }
  two.relevance = { relevant: true, reasons: ['used_provider'] }
  const [both] = S.newsGroupModels([one, two]).groups
  const complete = S.newsFocusGroup(both)
  assert.equal(complete.otherOffers.length, 0)
})

test('the local briefing counts merged events, never raw records', () => {
  const localCentral = JSON.parse(readFileSync(
    new URL('./fixtures/news/payload-local-central.json', import.meta.url), 'utf8'))
  const records = [...localCentral.local.items, ...localCentral.central.items]
  const grouped = S.newsGroupModels(records)
  const archiveEvents = grouped.entries.reduce((count, entry) => entry.kind === 'group'
    ? count + entry.offers.reduce((sum, offer) => sum + offer.events.length, 0) : count + 1, 0)
  const mergedItems = S.newsBriefingItems(grouped, records)
  // One event per change: the archive's own merge (exact id, or a local/central
  // pair with an explicit same-event proof) decides what is one change.
  assert.equal(mergedItems.length, archiveEvents)
  assert.ok(mergedItems.length < records.length,
    'the fixture really does carry the same change from both origins')
  const raw = S.newsBuildBriefing(records, { generatedAt: GENERATED_AT })
  const merged = S.newsBuildBriefing(mergedItems, { generatedAt: GENERATED_AT })
  assert.equal(raw.counts.events, records.length, 'raw records would inflate the count')
  assert.equal(merged.counts.events, archiveEvents)
  for (const section of merged.sections) {
    for (const entry of section.entries) {
      assert.equal(new Set(entry.event_ids).size, entry.event_ids.length,
        `${section.id} never repeats an event id`)
      for (const id of entry.event_ids) {
        assert.ok(mergedItems.some(item => item.id === id),
          `every headlined id joins back to a supplied event: ${id}`)
      }
    }
  }
  // A group with two providers keeps one row per provider and no duplicate id.
  const increase = merged.sections.find(section => section.id === 'biggest_increases')
  for (const entry of increase.entries) {
    assert.equal(new Set(entry.providers).size, entry.providers.length)
  }
})

test('a missing grouped archive falls back to the supplied items', () => {
  for (const grouped of [null, undefined, {}, { entries: [] }]) {
    assert.deepEqual(S.newsBriefingItems(grouped, ITEMS), ITEMS)
  }
})

test('a price event with no comparable rate is never headlined', () => {
  // An old input rate against a new output rate measures nothing: both sides
  // must publish the same rate type before a move can be claimed.
  const unmeasured = item({
    id: 'md-unmeasured', category: 'price_increase',
    previous: { input: 2 }, current: { output: 4 },
  })
  const briefing = S.newsBuildBriefing([unmeasured], { generatedAt: GENERATED_AT })
  assert.equal(briefing.counts.events, 1, 'the event is still counted')
  assert.equal(briefing.counts.price_increase, 1, 'its category is unchanged')
  assert.equal(briefing.sections.find(section => section.id === 'biggest_increases').total, 0,
    'nothing is ranked without a measured move')
  // The zero-baseline exception still works: a real move from $0 is a headline
  // on its dollar delta alone.
  const fromZero = item({
    id: 'md-zero', category: 'price_increase',
    previous: { input: 0 }, current: { input: 0.25 },
  })
  const ranked = S.newsBuildBriefing([fromZero], { generatedAt: GENERATED_AT })
  assert.equal(ranked.sections.find(section => section.id === 'biggest_increases').total, 1)
})

test('a preview listing appears in exactly one headline section', () => {
  const preview = item({
    id: 'md-preview', category: 'new_model', provider: 'acme',
    model: 'acme-x-preview', current: { input: 1, output: 2 },
  })
  const briefing = S.newsBuildBriefing([preview], { generatedAt: GENERATED_AT })
  const hits = briefing.sections
    .filter(section => section.entries.some(entry => entry.event_ids.includes('md-preview')))
    .map(section => section.id)
  assert.deepEqual(hits, ['preview_models'], 'one story, one section')
})

test('a published briefing whose sections all fail validation falls back locally', () => {
  const broken = { version: 1, sections: [null, { id: '' }, 'nonsense'] }
  const chosen = S.newsBriefingFor({ fetched_at: GENERATED_AT, briefing: broken }, ITEMS)
  assert.equal(chosen.source, 'local')
  assert.ok(chosen.sections.length > 0, 'the local headlines still render')
  // F138: a published briefing with no personal entry also falls back —
  // recognised-but-empty no longer wins on its own.
  const quiet = { version: 1, sections: [{ id: 'biggest_reductions', total: 0, entries: [] }] }
  const fallback = S.newsBriefingFor({ fetched_at: GENERATED_AT, briefing: quiet }, ITEMS)
  assert.equal(fallback.source, 'local')
  assert.ok(fallback.sections.length > 0, 'the local headlines still render')
})

test('a published evidence link is only kept when it is an http(s) URL', () => {
  const entry = {
    headline: 'acme no longer lists alpha', provider: 'acme', model: 'alpha',
    event_ids: ['rm-1'],
  }
  const safe = S.newsSanitiseBriefing({ version: 1, sections: [{ id: 'removals',
    entries: [{ ...entry, source_url: 'https://models.dev/removals/1' }] }] })
  assert.equal(safe.sections[0].entries[0].source_url, 'https://models.dev/removals/1')
  for (const hostile of ['javascript:alert(1)', 'data:text/html,<b>x</b>', 'not a url']) {
    const unsafe = S.newsSanitiseBriefing({ version: 1, sections: [{ id: 'removals',
      entries: [{ ...entry, source_url: hostile }] }] })
    assert.equal(unsafe.sections[0].entries[0].source_url, '',
      `an unusable evidence link is dropped: ${hostile}`)
  }
})

test('an unusable price parameter falls back to the published headline', () => {
  const en = (key, ...args) => {
    const value = S.I18N.en[key]
    return typeof value === 'function' ? value(...args) : value ?? key
  }
  const base = {
    event_type: 'price_reduction',
    headline_code: 'news_head_single_rate',
    headline_params: { provider: 'acme', model: 'm1', rate: 'news_rate_input' },
    headline: 'acme cuts m1 input ($1 → $0.5 per 1M tokens)',
  }
  for (const params of [{ pct: '', direction: 'down' }, { pct: 50 }, { pct: null, direction: 'down' },
    { pct: 50, direction: 'sideways' }]) {
    const text = S.newsHeadlineText({ ...base, headline_params: { ...base.headline_params, ...params } }, en)
    assert.equal(text, base.headline, `falls back for ${JSON.stringify(params)}`)
  }
  // The valid shape still renders the template with its exact values.
  const rendered = S.newsHeadlineText({ ...base, headline_params: { ...base.headline_params,
    pct: -50, direction: 'down', before: '$1', after: '$0.5' } }, en)
  assert.match(rendered, /cuts M1 input by 50\.0% \(\$1 → \$0\.5/)
})

test('the removal window rejects a record dated after publication', () => {
  const end = '2026-11-10T12:00:00Z'
  assert.equal(S.newsWithinWindow('2026-11-09T00:00:00Z', end, 90), true, 'inside the window')
  assert.equal(S.newsWithinWindow('2026-11-11T00:00:00Z', end, 90), false, 'after publication')
  assert.equal(S.newsWithinWindow('2026-01-01T00:00:00Z', end, 90), false, 'before the cutoff')
  // Undated evidence is kept, never dropped over its format.
  assert.equal(S.newsWithinWindow('', end, 90), true)
  assert.equal(S.newsWithinWindow('not-a-date', end, 90), true)
})

// --- briefing source selection ------------------------------------------------

test('a published briefing wins; a malformed one is ignored, never fatal', () => {
  const published = {
    version: 1, generated_at: GENERATED_AT,
    sections: [{ id: 'biggest_reductions', total: 1, entries: [{
      event_type: 'price_reduction', headline_code: 'news_head_single_rate',
      headline: 'Published headline', provider: 'alpha', model: 'glm-5.3-flash',
      headline_params: { provider: 'alpha', model: 'glm-5.3-flash',
        rate: 'news_rate_input', pct: -50, before: '$1', after: '$0.5', direction: 'down' },
      event_ids: ['md-a'], personal: true,
    }] }],
    counts: { events: 1 }, unsupported: [],
  }
  const chosen = S.newsBriefingFor({ fetched_at: GENERATED_AT, briefing: published }, ITEMS)
  assert.equal(chosen.source, 'published')
  assert.equal(chosen.sections[0].entries[0].headline, 'Published headline')
  // F138: without personal flags the published document cannot be filtered
  // reliably, so the local briefing wins instead of unrelated headlines.
  const unflagged = structuredClone(published)
  delete unflagged.sections[0].entries[0].personal
  assert.equal(S.newsBriefingFor({ fetched_at: GENERATED_AT, briefing: unflagged }, ITEMS).source, 'local')
  for (const broken of [null, {}, { version: 2, sections: [] }, { version: 1, sections: 'x' }]) {
    const fallback = S.newsBriefingFor({ fetched_at: GENERATED_AT, briefing: broken }, ITEMS)
    assert.equal(fallback.source, 'local')
    assert.ok(fallback.sections.length > 0)
  }
  // A malformed entry is dropped without taking the archive down with it.
  const partial = S.newsSanitiseBriefing({
    version: 1,
    sections: [{ id: 'biggest_reductions', entries: [{ headline: '', provider: 'alpha' }, null] }],
  })
  assert.deepEqual(partial.sections[0].entries, [])
  // A collapsed variant keeps its observed count through sanitising.
  const counted = S.newsSanitiseBriefing({ version: 1, sections: [{ id: 'biggest_reductions',
    entries: [{ headline: 'ok', provider: 'acme',
      variants: [{ headline: 'row', provider: 'acme', observed_count: 3 }] }] }] })
  assert.equal(counted.sections[0].entries[0].variants[0].observed_count, 3)
})

test('a published briefing shows personal headlines only', () => {
  // F138: non-personal entries drop out of recognised sections; counts and
  // unrecognised sections still describe the publication. A document with
  // nothing personal, or an entry without a flag, is unusable and falls
  // back to the local briefing.
  const entry = (headline, personal) => ({ headline, provider: 'acme', personal })
  const briefing = {
    version: 1,
    sections: [
      { id: 'biggest_reductions', total: 2, entries: [entry('mine', true), entry('theirs', false)] },
      { id: 'future_section', total: 1, entries: [entry('future', false)] },
    ],
    counts: { events: 3 },
  }
  const filtered = S.newsFilterBriefingPersonal(briefing)
  assert.deepEqual(filtered.sections[0].entries.map(row => row.headline), ['mine'])
  assert.equal(filtered.sections[0].total, 2, 'totals still describe the publication')
  assert.equal(filtered.sections[1].entries.length, 1, 'unrecognised sections pass through')
  assert.deepEqual(filtered.counts, { events: 3 })
  const nonePersonal = S.newsFilterBriefingPersonal({ version: 1,
    sections: [{ id: 'biggest_reductions', total: 1, entries: [entry('theirs', false)] }] })
  assert.equal(nonePersonal, null)
  const unflagged = S.newsFilterBriefingPersonal({ version: 1,
    sections: [{ id: 'biggest_reductions', total: 1,
      entries: [{ headline: 'mine', provider: 'acme' }] }] })
  assert.equal(unflagged, null)
})

test('a category filter keeps only the sections it can honestly describe', () => {
  const briefing = S.newsBuildBriefing(ITEMS, { generatedAt: GENERATED_AT })
  assert.equal(S.newsBriefingForCategory(briefing, 'all'), briefing)
  const increases = S.newsBriefingForCategory(briefing, 'price_increase')
  assert.deepEqual(increases.sections.map(section => section.id), ['biggest_increases'])
  const models = S.newsBriefingForCategory(briefing, 'new_model')
  assert.deepEqual(models.sections.map(section => section.id),
    ['new_models', 'newly_available', 'preview_models'])
  // A removal or a mixed move has no honest v1 category: it is shown under
  // "all" only, never under a filter that claims to describe it.
  for (const category of ['price_reduction', 'price_increase', 'new_model', 'subscription']) {
    const ids = S.newsBriefingForCategory(briefing, category).sections.map(section => section.id)
    assert.ok(!ids.includes('removals'), `${category} never claims removals`)
    assert.ok(!ids.includes('mixed_price_changes'), `${category} never claims mixed moves`)
  }
})

// --- Python parity ------------------------------------------------------------

test('the Desktop briefing agrees with the Python builder fact for fact', () => {
  const briefing = S.newsBuildBriefing(ITEMS, { generatedAt: GENERATED_AT })
  assert.deepEqual(briefing.unsupported, GOLDEN.unsupported)
  assert.deepEqual(briefing.all_updates, GOLDEN.all_updates)
  for (const [key, value] of Object.entries(GOLDEN.counts)) {
    assert.equal(briefing.counts[key], value, `count ${key} matches the Python builder`)
  }
  const goldenSections = new Map(GOLDEN.sections.map(section => [section.id, section]))
  for (const section of briefing.sections) {
    const expected = goldenSections.get(section.id)
    assert.ok(expected, `Python publishes section ${section.id}`)
    assert.equal(section.total, expected.total, `${section.id} total matches`)
    assert.equal(section.entries.length, expected.entries.length, `${section.id} row count matches`)
    section.entries.forEach((entry, index) => {
      const want = expected.entries[index]
      const label = `${section.id}[${index}]`
      assert.equal(entry.event_type, want.event_type, `${label} event type`)
      assert.equal(entry.headline_code, want.headline_code, `${label} headline code`)
      assert.deepEqual(entry.headline_params, want.headline_params, `${label} headline params`)
      assert.equal(entry.model_family, want.model_family, `${label} family identity`)
      assert.equal(entry.provider, want.provider, `${label} provider`)
      assert.equal(entry.confidence, want.confidence, `${label} confidence`)
      assert.deepEqual(entry.event_ids, want.event_ids, `${label} event links`)
      for (const key of ['max_abs_pct', 'dominant_pct', 'max_abs_delta', 'rate', 'zero_baseline']) {
        assert.deepEqual(entry.magnitude[key], want.magnitude[key], `${label} magnitude.${key}`)
      }
      assert.equal(entry.variants.length, want.variants.length, `${label} variant count`)
      entry.variants.forEach((variant, variantIndex) => {
        const expectedVariant = want.variants[variantIndex]
        assert.equal(variant.headline_code, expectedVariant.headline_code,
          `${label} variant ${variantIndex} code`)
        assert.deepEqual(variant.headline_params, expectedVariant.headline_params,
          `${label} variant ${variantIndex} params`)
        assert.deepEqual(variant.event_ids, expectedVariant.event_ids,
          `${label} variant ${variantIndex} links`)
        // A variant is a different provider's record: its own evidence must
        // travel, never the family head's.
        for (const key of ['observed_at', 'source_url', 'provenance', 'confidence']) {
          assert.equal(variant[key], expectedVariant[key],
            `${label} variant ${variantIndex} ${key}`)
        }
      })
    })
  }
})

// --- localisation -------------------------------------------------------------

test('every editorial message exists in both locales', () => {
  const keys = ['newsBriefingTitle', 'newsBriefingNote', 'newsBriefingLocal',
    'newsBriefingPublished', 'newsSectionKept',
    'newsStoryDetails', 'newsStoryEvents', 'newsArchiveSearchNote',
    'newsUnsupportedNoPlanEvents', 'newsUnsupportedNoRemovals',
    'newsHeadVerbCut', 'newsHeadVerbRaise', 'newsHeadNoRate',
    'newsRateNameInput', 'newsRateNameOutput', 'newsRateNameCacheRead',
    'newsRateNameCacheWrite', 'newsConfidenceObserved', 'newsConfidenceVerified',
    'newsConfidenceCurated', 'newsStoryOpenInArchive', 'newsOtherProvidersNote',
    'newsStoryNoHeadline', 'newsKindCut', 'newsKindRise', 'newsKindNew',
    'newsKindAvailable', 'newsKindRemoved', 'newsKindDelisted', 'newsKindPlan',
    'newsKindPreview', 'newsKindMixed', 'newsKindOther',
    ...Object.values(S.NEWS_HEADLINE_KEYS),
    'newsSectionMore', 'newsOtherProviders',
    ...S.NEWS_EDITORIAL_SECTIONS.map(([, key]) => key)]
  for (const [locale, table] of Object.entries(S.I18N)) {
    for (const key of keys) {
      assert.ok(table[key] !== undefined, `${locale} is missing ${key}`)
    }
  }
})

test('headlines localise from codes and keep the verified numbers verbatim', () => {
  const en = (key, ...args) => {
    const entry = S.I18N.en[key]
    return typeof entry === 'function' ? entry(...args) : entry ?? key
  }
  const zh = (key, ...args) => {
    const entry = S.I18N.zh[key]
    return typeof entry === 'function' ? entry(...args) : entry ?? key
  }
  const entry = {
    event_type: 'price_reduction',
    headline_code: 'news_head_single_rate',
    headline_params: { provider: 'kilo', model: 'google/gemma-4-31b-it',
      rate: 'news_rate_output', pct: -54.7, before: '$0.34', after: '$0.154', direction: 'down' },
    provider: 'kilo', model: 'google/gemma-4-31b-it',
  }
  const english = S.newsHeadlineText(entry, en)
  assert.match(english, /kilo cuts Gemma 4 31b It output by 54\.7% \(\$0\.34 → \$0\.154/)
  const chinese = S.newsHeadlineText(entry, zh)
  assert.match(chinese, /输出价格/)
  assert.match(chinese, /54\.7%/)
  assert.ok(chinese.includes('$0.34') && chinese.includes('$0.154'),
    'exact before/after values survive localisation')
  // An unknown code falls back to the publisher's verified English sentence.
  assert.equal(S.newsHeadlineText({ headline: 'Published sentence', headline_code: 'news_head_unknown' }, en),
    'Published sentence')
  assert.equal(S.newsHeadlineText({}, en), 'No verified headline for this event.')
})

// --- review round 3: instants, rate text, both floors -------------------------

test('an offsetless observation is read as UTC, exactly as the publisher reads it', () => {
  assert.equal(S.newsInstant('2026-11-10T11:30:00'), Date.parse('2026-11-10T11:30:00Z'))
  assert.equal(S.newsInstant('2026-11-10 11:30:00'), Date.parse('2026-11-10T11:30:00Z'))
  assert.equal(S.newsInstant('2026-11-10T11:30:00Z'), Date.parse('2026-11-10T11:30:00Z'))
  assert.equal(S.newsInstant('2026-11-10T11:30:00+02:00'), Date.parse('2026-11-10T09:30:00Z'))
  assert.equal(S.newsInstant(''), null)
  assert.equal(S.newsInstant('not-a-date'), null)
})

test('a host west of UTC still judges the window by UTC instants', () => {
  const original = process.env.TZ
  process.env.TZ = 'America/New_York'
  try {
    // The host really did change what a bare Date.parse would do with it…
    assert.notEqual(Date.parse('2026-11-10T11:30:00'), Date.parse('2026-11-10T11:30:00Z'))
    // …so an observation an hour BEFORE publication stays inside the window,
    // rather than being rejected as future because the host read it as 16:30Z.
    assert.equal(S.newsWithinWindow('2026-11-10T11:30:00', '2026-11-10T12:00:00Z', 90), true)
    assert.equal(S.newsWithinWindow('2026-11-10T13:30:00', '2026-11-10T12:00:00Z', 90), false,
      'a genuinely future observation is still rejected')
  } finally {
    if (original === undefined) delete process.env.TZ
    else process.env.TZ = original
  }
})

test('a positive rate is never printed as free', () => {
  assert.equal(S.newsRateText(0), '$0', 'an actual zero stays $0')
  assert.equal(S.newsRateText(0.00000025), '$0.00000025')
  assert.equal(S.newsRateText(1.25), '$1.25')
  assert.equal(S.newsRateText(0.0001), '$0.0001')
  assert.equal(S.newsRateText(null), '—')
})

test('a mixed headline needs both directions measured, not merely categorised', () => {
  const onlyUp = item({ id: 'mx-1', event_type: 'price_mixed',
    previous: { input: 1 }, current: { input: 2 } })
  const briefing = S.newsBuildBriefing([onlyUp], { generatedAt: '2026-11-10T00:00:00Z' })
  assert.equal(briefing.sections.find(s => s.id === 'mixed_price_changes').total, 0,
    'nothing fell, so nothing is mixed')
  assert.equal(briefing.counts.price_mixed, 1, 'the event is still counted')
  const bothWays = item({ id: 'mx-2', event_type: 'price_mixed',
    previous: { input: 1, output: 10 }, current: { input: 2, output: 5 } })
  assert.equal(S.newsBuildBriefing([bothWays],
    { generatedAt: '2026-11-10T00:00:00Z' }).sections
    .find(s => s.id === 'mixed_price_changes').total, 1)
})

test('both floors apply: a huge percentage on a sub-cent rate is never headlined', () => {
  const tiny = item({ id: 'mz-1', event_type: 'price_increase',
    previous: { cache_read: 0.0001 }, current: { cache_read: 0.00195 } })
  const briefing = S.newsBuildBriefing([tiny], { generatedAt: '2026-11-10T00:00:00Z' })
  assert.equal(briefing.sections.find(s => s.id === 'biggest_increases').total, 0,
    '1 850% of a sub-cent rate is not news')
  assert.equal(briefing.counts.price_increase, 1, 'but it is still counted, never hidden')
  const real = item({ id: 'mz-2', event_type: 'price_increase',
    previous: { input: 1 }, current: { input: 3 } })
  assert.equal(S.newsBuildBriefing([real], { generatedAt: '2026-11-10T00:00:00Z' }).sections
    .find(s => s.id === 'biggest_increases').total, 1)
})

test('removal groups order by the instant, not by the text of the stamp', () => {
  const earlier = item({ id: 'rm-1', event_type: 'removed_from_provider', provider: 'acme',
    model: 'acme-old', observed_at: '2026-11-09T23:30:00Z' })
  // Textually "2026-11-10T00:30:00+02:00" sorts last, but it is 22:30Z — older.
  const older = item({ id: 'rm-2', event_type: 'removed_from_provider', provider: 'acme',
    model: 'acme-older', observed_at: '2026-11-10T00:30:00+02:00' })
  const rows = S.newsBuildBriefing([older, earlier],
    { generatedAt: '2026-11-10T12:00:00Z' }).sections.find(s => s.id === 'removals').entries
  assert.deepEqual(rows.map(row => row.model), ['acme-old', 'acme-older'])
})

// --- direction, zero baseline and group date (round-5 review) -----------------

test('direction comes from the published values, not the rounded delta', () => {
  const down = item({ id: 'ur-1', category: 'price_reduction',
    previous: { input: 1.0000004, output: 2 }, current: { input: 1.0000001, output: 2 } })
  const comparison = S.newsEditorialComparison(down.previous, down.current)
  assert.ok(Math.abs(comparison.rates.input.delta) === 0,
    `the displayed delta rounds to zero (${comparison.rates.input.delta})`)
  assert.equal(comparison.direction, 'down',
    'the published values still decide the direction')
  assert.equal(S.newsEditorialEventType(down), 'price_reduction')
  // Opposite sub-micro moves are a real mixed change, not a flat one.
  const mixed = item({ id: 'ur-2', category: 'price_reduction',
    previous: { input: 1.0000004, output: 2.0000001 },
    current: { input: 1.0000001, output: 2.0000004 } })
  assert.equal(S.newsEditorialComparison(mixed.previous, mixed.current).direction, 'mixed')
  assert.equal(S.newsEditorialEventType(mixed), 'price_mixed')
})

test('a price class the rates do not move in is counted, never headlined', () => {
  const flat = item({ id: 'ur-3', category: 'price_reduction',
    previous: { input: 1, output: 2 }, current: { input: 1, output: 2 } })
  const briefing = S.newsBuildBriefing([flat], { generatedAt: '2026-11-10T00:00:00Z' })
  assert.equal(briefing.counts.price_reduction, 1)
  assert.equal(briefing.sections.find(s => s.id === 'biggest_reductions').total, 0,
    'a category alone never headlined a move')
  assert.equal(briefing.counts.events, 1, 'the event stays in the archive')
})

test('a zero-baseline move must agree with its declared class', () => {
  const rise = item({ id: 'ur-4', event_type: 'price_increase',
    previous: { input: 0 }, current: { input: 0.5 } })
  assert.equal(S.newsBuildBriefing([rise], { generatedAt: '2026-11-10T00:00:00Z' })
    .sections.find(s => s.id === 'biggest_increases').total, 1,
  'a zero-baseline increase is preserved')
  const claimedCut = item({ id: 'ur-5', event_type: 'price_reduction',
    previous: { input: 0 }, current: { input: 0.5 } })
  const briefing = S.newsBuildBriefing([claimedCut], { generatedAt: '2026-11-10T00:00:00Z' })
  assert.equal(briefing.sections.find(s => s.id === 'biggest_reductions').total, 0,
    'a rise can never be headlined as a cut')
  assert.equal(briefing.counts.price_reduction, 1, 'the rejected event is still counted')
})

test('a group carries the newest date among its members', () => {
  const head = item({ id: 'ur-6', model: 'acme-x', provider: 'acme',
    previous: { input: 10 }, current: { input: 5 }, observed_at: '2026-11-01T00:00:00Z' })
  const fresher = item({ id: 'ur-7', model: 'acme-x:thinking', provider: 'zeta',
    previous: { input: 10 }, current: { input: 6 }, observed_at: '2026-11-09T00:00:00Z' })
  const [group] = S.newsEditorialGroup([S.newsEditorialEntry(head), S.newsEditorialEntry(fresher)])
  assert.equal(group.model_family, 'acme-x')
  assert.equal(group.observed_at, '2026-11-09T00:00:00Z',
    "the group date is its newest member, not the head's")
  const undated = item({ id: 'ur-8', model: 'beta-y', provider: 'acme',
    previous: { input: 10 }, current: { input: 5 }, observed_at: '' })
  const dated = item({ id: 'ur-9', model: 'beta-y:flex', provider: 'zeta',
    previous: { input: 10 }, current: { input: 5 }, observed_at: '2026-11-02T00:00:00Z' })
  assert.equal(S.newsEditorialGroup([S.newsEditorialEntry(undated),
    S.newsEditorialEntry(dated)])[0].observed_at, '2026-11-02T00:00:00Z',
  'an undated member never wins the group date')
})

test('a removal family orders by its newest member', () => {
  const older = item({ id: 'ur-10', event_type: 'removed_from_provider',
    provider: 'acme', model: 'acme-a', observed_at: '2026-11-01T00:00:00Z' })
  const newer = item({ id: 'ur-11', event_type: 'removed_from_provider',
    provider: 'acme', model: 'acme-a:thinking', observed_at: '2026-11-09T00:00:00Z' })
  const other = item({ id: 'ur-12', event_type: 'removed_from_provider',
    provider: 'zeta', model: 'zeta-b', observed_at: '2026-11-05T00:00:00Z' })
  const rows = S.newsBuildBriefing([older, newer, other],
    { generatedAt: '2026-11-10T12:00:00Z' }).sections.find(s => s.id === 'removals').entries
  assert.deepEqual(rows.map(row => row.model_family), ['acme-a', 'zeta-b'],
    'the family sorts on its freshest member, not its head')
})

test('a published briefing needs at least one section this client renders', () => {
  const items = [item({ id: 'us-1', category: 'price_reduction',
    previous: { input: 2 }, current: { input: 1 } })]
  const unknownOnly = {
    fetched_at: '2026-11-10T00:00:00Z',
    briefing: { version: 1, generated_at: '2026-11-10T00:00:00Z', unsupported: [],
      sections: [{ id: 'future_section', total: 1, entries: [{
        event_type: 'price_reduction', headline_code: 'news_head_single_rate',
        headline: 'someone cut something', provider: 'acme',
        observed_at: '2026-11-09T00:00:00Z',
      }] }] },
  }
  const local = S.newsBriefingFor(unknownOnly, items)
  assert.equal(local.source, 'local',
    'a published document with no renderable section does not win')
  assert.ok(local.sections.some(section => section.id === 'biggest_reductions'
    && section.entries.length), 'the archive still produces local headlines')

  // F138: a recognised section with no personal entry no longer wins on
  // its own — the local briefing answers instead.
  const recognisedEmpty = {
    fetched_at: '2026-11-10T00:00:00Z',
    briefing: { version: 1, sections: [{ id: 'removals', total: 0, entries: [] }] },
  }
  const fallback = S.newsBriefingFor(recognisedEmpty, items)
  assert.equal(fallback.source, 'local')
  assert.ok(fallback.sections.some(section => section.id === 'biggest_reductions'
    && section.entries.length), 'the archive still produces local headlines')
})
