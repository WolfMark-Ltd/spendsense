// Run: node --test test/
//
// Allowance weather helper regressions through the same stub loader the
// other suites use (no React needed). Rendered-section tests live in
// test/weather-render.test.mjs, which must stay a separate file: tests
// registered after the harness's late top-level await are silently dropped
// by the runner when both loaders share one module.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'

// --- part 1: stub loader for the pure helpers ------------------------------
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
const queryClient = { fetchQuery: async q => q.queryFn(), getQueryData: () => null }
const usePluginI18n = noop, useQuery = noop, useValue = noop
const jsx = noop, jsxs = noop
`
const stubBody = src
  .replace(/import \{[^}]*\} from '@hermes\/plugin-sdk'\n/, stub)
  .replace(/import \{ useEffect \} from 'react'\n/, '')
  .replace(/import \{ jsx, jsxs \} from 'react\/jsx-runtime'\n/, '')
globalThis.window = { location: { hash: '' }, addEventListener() {}, removeEventListener() {} }
const stubDir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'tcm-wx-'))
const stubFile = join(stubDir, 'plugin.mjs')
writeFileSync(stubFile, stubBody)
const S = (await import(pathToFileURL(stubFile).href)).__test
const en = (key, ...args) => {
  const entry = S.I18N.en[key]
  return typeof entry === 'function' ? entry(...args) : entry ?? key
}

test('wxVerdictLabel covers every backend verdict', () => {
  assert.equal(S.wxVerdictLabel(en, 'ahead'), 'Ahead of pace')
  assert.equal(S.wxVerdictLabel(en, 'on_track'), 'On track')
  assert.equal(S.wxVerdictLabel(en, 'behind'), 'Behind pace')
  assert.equal(S.wxVerdictLabel(en, 'exhausted'), 'Exhausted')
  assert.equal(S.wxVerdictLabel(en, 'unknown'), 'Unknown')
  assert.equal(S.wxVerdictLabel(en, 'bogus'), 'Unknown')
  assert.equal(S.wxVerdictLabel(en, null), 'Unknown')
})

test('wxLimitLabel renders structured limits, never a raw key', () => {
  assert.equal(S.wxLimitLabel(en, { kind: 'amount', amount: 100, currency: 'USD' }), '$100.00 allowance')
  assert.equal(S.wxLimitLabel(en, { kind: 'amount', amount: 5, currency: null }), '5 allowance')
  assert.equal(S.wxLimitLabel(en, { kind: 'credits', amount: 60000 }), '60000 credits')
  assert.equal(S.wxLimitLabel(en, { kind: 'percent' }), 'share of provider limit')
  assert.equal(S.wxLimitLabel(en, { kind: 'unknown' }), 'Limit unknown')
  assert.equal(S.wxLimitLabel(en, null), 'Limit unknown')
  assert.equal(S.wxLimitLabel(en, { kind: 'amount', amount: 'bogus', currency: 'USD' }), 'Limit unknown')
})

test('wxCycleSummary never reports a missing cycle as zero', () => {
  assert.equal(S.wxCycleSummary(en, { days_remaining_display: 12, elapsed_fraction: 0.62 }),
    '12 days left in cycle · 62% of cycle elapsed')
  assert.equal(S.wxCycleSummary(en, { days_remaining_display: 1, elapsed_fraction: 0.01 }),
    '1 day left in cycle · 1% of cycle elapsed')
  assert.equal(S.wxCycleSummary(en, { days_remaining_display: 0, elapsed_fraction: 1 }), '0 days left in cycle · 100% of cycle elapsed')
  assert.equal(S.wxCycleSummary(en, null), 'No cycle position')
  assert.equal(S.wxCycleSummary(en, {}), 'No cycle position')
  assert.equal(S.wxCycleSummary(en, { days_remaining_display: 5 }), '5 days left in cycle')
})

test('wxWindowRow keeps readings distinct from verdicts', () => {
  const line = S.wxWindowRow(en, {
    id: 'w', label: 'Monthly credit', verdict: 'ahead',
    declared: { kind: 'amount', amount: 100, currency: 'USD' },
    provider: { used_percent: 80, state: 'live', reset_at: '2026-11-01T00:00:00Z' },
    manual: null,
  })
  assert.equal(line, 'Monthly credit: $100.00 allowance · Provider reports 80% used · Provider reset 2026-11-01 · Ahead of pace')
})

test('wxWindowRow flags stale readings and manual marks', () => {
  const stale = S.wxWindowRow(en, {
    id: 'w', label: 'Monthly credit', verdict: 'behind',
    declared: { kind: 'percent' },
    provider: { used_percent: 62, state: 'stale', reset_at: null },
    manual: null,
  })
  assert.match(stale, /Provider reading is stale/)
  const manual = S.wxWindowRow(en, {
    id: 'w', label: 'Monthly credit', verdict: 'exhausted',
    declared: { kind: 'amount', amount: 100, currency: 'USD' },
    provider: null, manual: { status: 'active' },
  })
  assert.match(manual, /You reported this exhausted/)
  assert.match(manual, /Exhausted/)
  assert.doesNotMatch(manual, /Provider reports/)
})

test('wxRuleRow shows pace, projection and lower-bound caveats', () => {
  const line = S.wxRuleRow(en, {
    label: 'cap · shared', used_usd: 6, limit_usd: 10, consumed_fraction: 0.6,
    lower_bound: false, pace_usd_per_day: 0.196721, projected_exhaustion: '2026-11-20T20:00:00Z',
    forecast_status: 'ok', verdict: 'behind',
  })
  assert.equal(line, 'cap · shared: $6.00 of $10.00 used · 60% · $0.20/day · At this pace, exhausted around 2026-11-20 · Behind pace')
  const partial = S.wxRuleRow(en, {
    label: 'cap · shared', used_usd: 4, limit_usd: 10, consumed_fraction: 0.4,
    lower_bound: true, pace_usd_per_day: null, projected_exhaustion: null,
    forecast_status: 'unavailable', verdict: 'unknown',
  })
  assert.match(partial, /lower bound/)
  assert.match(partial, /No forecast — see details/)
  assert.doesNotMatch(partial, /At this pace/)
})

test('wxRuleRow without a limit shows spend only', () => {
  assert.equal(S.wxRuleRow(en, { label: 'wallet · spend', used_usd: 6, limit_usd: null, verdict: 'unknown' }),
    'wallet · spend: $6.00 observed spend')
  assert.doesNotMatch(S.wxRuleRow(en, { label: 'w', used_usd: 1, limit_usd: null }), /used · /)
})

test('weatherQuery keys by identity and native flag', () => {
  assert.deepEqual(S.weatherQuery('id-a', false).queryKey.slice(0, 3), ['spend-sense', 'allowance-weather', 'id-a'])
  assert.equal(S.weatherQuery('id-a', true).queryKey[3], 'native')
  assert.equal(S.weatherQuery('id-a', false).queryKey[3], 'stored')
  assert.notEqual(S.weatherQuery('id-a', false).queryKey[2], S.weatherQuery('id-b', false).queryKey[2])
})

test('needsAttention flags weather pace without duplicating quota flags', () => {
  const account = { id: 'a', label: 'A', quota: {}, fee: {} }
  const byId = new Map([['a', {
    windows: [{ label: 'Monthly credit', verdict: 'ahead' }, { label: 'Weekly', verdict: 'exhausted' }],
    rules: [{ label: 'cap · shared', used_usd: 11, verdict: 'exhausted' }],
  }]])
  const items = S.needsAttention([account], byId)
  const texts = items.map(item => item.text)
  assert.ok(texts.includes('Monthly credit: ahead of pace.'))
  assert.ok(texts.includes('cap · shared: reached its allowance.'))
  // Window exhaustion stays with the quota flags; the weather map adds no second line for it.
  assert.ok(!texts.some(text => text.startsWith('Weekly:')))
  // Without weather the same account raises nothing new.
  assert.deepEqual(S.needsAttention([{ ...account, plan_id: 'p', fee: { basis: 'declared' } }]), [])
})

test('needsAttention keeps weather warnings for every arrangement', () => {
  const weather = new Map([
    ['prepaid', { windows: [], rules: [{ label: 'wallet · cap', used_usd: 11, verdict: 'exhausted' }] }],
    ['api', { windows: [{ label: 'Monthly credit', verdict: 'ahead' }], rules: [] }],
    ['new', { windows: [], rules: [{ label: 'cap · shared', used_usd: 9, verdict: 'ahead' }] }],
  ])
  const items = S.needsAttention([
    { id: 'prepaid', label: 'P', quota: {}, effective_arrangement: 'prepaid' },
    { id: 'api', label: 'A', quota: {}, effective_arrangement: 'api_only' },
    { id: 'new', label: 'N', quota: {}, effective_arrangement: 'unconfirmed' },
  ], weather)
  const texts = items.map(item => item.text)
  assert.ok(texts.includes('wallet · cap: reached its allowance.'))
  assert.ok(texts.includes('Monthly credit: ahead of pace.'))
  assert.ok(texts.includes('cap · shared: ahead of pace.'))
  assert.ok(texts.includes('Billing arrangement not confirmed.'))
})
