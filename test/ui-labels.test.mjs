// Run: node --test test/
//
// Presentation regressions for the Token & Cost pane (0.2.4-ui-1):
// a missing `src_backend` translation rendered the raw key beside the price, the
// totals heading said "This session" while showing a conversation bucket, and the
// ≈ marker was applied to the exact input counter while the derived cache rows
// carried no `derived` tag at all.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'

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
const body = src
  .replace(/import \{[^}]*\} from '@hermes\/plugin-sdk'\n/, stub)
  .replace(/import \{ useEffect \} from 'react'\n/, '')
  .replace(/import \{ jsx, jsxs \} from 'react\/jsx-runtime'\n/, '')
globalThis.window = { location: { hash: '' }, addEventListener() {}, removeEventListener() {} }
const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'tcm-ui-'))
const file = join(dir, 'plugin.mjs')
writeFileSync(file, body)
const T = (await import(pathToFileURL(file).href)).__test

/** The host returns the key itself when a translation is missing. */
const rawT = (key, ...args) => {
  const entry = T.I18N.en[key]
  if (typeof entry === 'function') return entry(...args)
  return entry == null ? key : entry
}
const en = T.I18N.en
const zh = T.I18N.zh

const bucket = (over = {}) => ({
  input: 328_500, output: 57_100, cacheRead: 1_000_000, cacheWrite: 0,
  calls: 57, pricedTokens: 6_255_600, unpricedTokens: 0, cacheEstimated: true, ...over
})

test('cache coverage lines follow the chosen language', () => {
  const translator = language => (key, ...args) => {
    const entry = T.I18N[language][key]
    return typeof entry === 'function' ? entry(...args) : entry ?? key
  }
  const data = { input: 100, cacheRead: 100, cacheWrite: 0,
    cacheExactPrompt: 100, cacheEstimatedPrompt: 50 }
  assert.equal(T.cacheCoverageLine(translator('en'), .75, data),
    '75% of prompt tokens covered · 50% exact · 25% estimated')
  assert.equal(T.cacheCoverageLine(translator('zh'), .75, data),
    '提示词令牌覆盖率 75% · 精确 50% · 估算 25%')
  assert.equal(translator('zh')('cacheCoverageRange', 75), '缓存数据覆盖提示词令牌的 75%')
  for (const language of ['en', 'zh']) {
    for (const key of ['cacheCoverageUnavailable', 'cacheCoverageBasis', 'weightedCacheHit']) {
      assert.notEqual(translator(language)(key), key, `${language} has ${key}`)
    }
  }
})

test('every pricing-source fallback has a human label, never the raw key', () => {
  for (const origin of Object.keys(T.SOURCE_FALLBACKS)) {
    const label = T.sourceLabel(rawT, origin, null, false)
    assert.ok(label && !label.startsWith('src_'), `${origin} -> ${label}`)
    assert.notEqual(label, `src_${origin}`)
    // The English dictionary must own the string so it can be translated.
    assert.ok(en[`src_${origin}`], `missing en key src_${origin}`)
  }
})

test('backend rates read as an estimate, not a provider charge', () => {
  const label = T.sourceLabel(rawT, 'backend', null, false)
  assert.equal(label, 'Hermes backend estimate')
  assert.doesNotMatch(label, /reported|billed|invoice|charged/i)
  assert.equal(zh.src_backend, 'WolfMark 后端估算')
})

test('an unknown future origin is humanised rather than printed', () => {
  assert.equal(T.sourceFallback('route_card'), 'route card (estimate)')
  assert.equal(T.sourceLabel(rawT, 'route_card', null, false), 'route card (estimate)')
  assert.doesNotMatch(T.sourceLabel(rawT, 'route_card', null, false), /src_/)
})

test('a missing translation falls back to the human label, not the key', () => {
  const emptyT = key => key
  assert.equal(T.sourceLabel(emptyT, 'gateway', null, false), 'gateway-reported')
  assert.equal(T.sourceLabel(emptyT, 'backend', null, false), 'Hermes backend estimate')
  // Borrowed-rate warnings still go through the dictionary's function entries.
  assert.match(T.sourceLabel(rawT, 'foreign', 'zai', false), /borrowed from zai/)
})

test('the totals heading follows the bucket scope', () => {
  assert.equal(T.scopeTotalsTitle(rawT, true), 'Conversation totals')
  assert.equal(T.scopeTotalsTitle(rawT, false), 'This run’s totals')
  assert.equal(zh.scopeTotalsConversation, '对话总计')
  // "This session" must no longer label an all-runs conversation bucket.
  const b = bucket()
  const rows = T.tokenRows(rawT, b, false, null)
  assert.ok(rows.every(r => r.label !== 'This session'))
})

test('only derived cache fields carry ≈ and the derived tag', () => {
  const rows = T.tokenRows(rawT, bucket(), false, null)
  const byKey = Object.fromEntries(rows.map(r => [r.key, r]))
  assert.equal(byKey.i.value, '328.5k', 'exact input counter, unrounded by ≈')
  assert.doesNotMatch(byKey.i.value, /≈/)
  assert.equal(byKey.cr.value.startsWith('≈'), true)
  assert.match(byKey.cr.label, / · derived$/)
  assert.match(byKey.tt.label, /incl\. derived cache$/)
  assert.equal(byKey.tt.value.startsWith('≈'), true, 'the total carries an estimated cache component')
  assert.doesNotMatch(byKey.c.label, /≈/)
})

test('exact provider cache fields are shown without an estimate marker', () => {
  const rows = T.tokenRows(rawT, bucket({ cacheEstimated: false }), false, null)
  const byKey = Object.fromEntries(rows.map(r => [r.key, r]))
  assert.ok(rows.every(r => !r.value.includes('≈')))
  assert.doesNotMatch(byKey.cr.label, /derived/)
  assert.doesNotMatch(byKey.tt.label, /derived/)
})

test('a reconstructed cache write never reads as confirmed usage', () => {
  const rows = T.tokenRows(rawT, bucket({ cacheRead: 0, cacheWrite: 216_795 }), false, null)
  const cw = rows.find(r => r.key === 'cw')
  assert.ok(cw.value.startsWith('≈'))
  assert.match(cw.label, /derived/)
})

test('context is shown only when the gateway supplies it', () => {
  const withCtx = T.tokenRows(rawT, bucket(), true, { context_percent: 42, context_used: 84_000, context_max: 200_000 })
  assert.equal(withCtx.find(r => r.key === 'ctx').value, '42% · 84.0k/200.0k')
  assert.equal(T.tokenRows(rawT, bucket(), false, null).find(r => r.key === 'ctx'), undefined)
})

test('the rates note explains the differing estimate without claiming a charge', () => {
  assert.match(en.ratesNote, /not the provider’s invoice/i)
  assert.match(en.ratesNote, /peak|off-peak/i)
  assert.match(en.ratesNote, /different estimate/i)
  assert.ok(zh.ratesNote && !zh.ratesNote.startsWith('ratesNote'))
})

const RATES = { input: 0.15, output: 0.6, cache: 0.003, inputKnown: true, outputKnown: true, cacheKnown: true }

test('cache savings reconcile with the displayed rate card', () => {
  // Synthetic token counts keep the savings calculation reproducible.
  const live = T.liveSavings({ cacheRead: 1_000_000 }, RATES)
  const turn = T.liveSavings({ cacheRead: 2_000_000 }, RATES)
  assert.ok(Math.abs(live - 0.147) < 1e-6, String(live))
  assert.ok(Math.abs(turn - 0.294) < 1e-6, String(turn))
  for (const [read, value] of [[1_000_000, live], [2_000_000, turn]]) {
    assert.equal(value, (read * (RATES.input - RATES.cache)) / 1e6)
  }
})

test('savings ignore a stored value accumulated at other rates', () => {
  // hist.saved is recorded at whatever card applied then; beside a different
  // current card it would contradict the rates shown under it.
  const bucket = { cacheRead: 1_000_000, saved: 0.094 }
  assert.ok(Math.abs(T.liveSavings(bucket, RATES) - 0.147) < 1e-6)
  assert.equal(T.liveSavings(bucket, null), null)
  assert.equal(T.liveSavings(null, RATES), null)
})

test('savings are labelled as theoretical, not cash', () => {
  assert.match(en.cacheTitle, /cache/i)
  assert.equal(en.savedTotal, 'Net cache savings')
  // The wording must not imply a provider credit or recorded billing.
  assert.doesNotMatch(en.savedTotal, /refund|credit|billed|cash/i)
  // The compact label leans on its tooltip for the methodology.
  assert.match(en.savingsInfo, /theoretical/i)
  assert.match(en.savingsInfo, /not a credit or refund/i)
  assert.ok(zh.savingsInfo && !zh.savingsInfo.startsWith('savingsInfo'))
})

test('composition shares split the prompt into fresh, read and write', () => {
  const shares = T.compositionShares({ input: 100, cacheRead: 300, cacheWrite: 100, output: 50 })
  assert.equal(shares.prompt, 500)
  assert.equal(shares.output, 50)
  assert.ok(Math.abs(shares.freshFrac - 0.2) < 1e-9)
  assert.ok(Math.abs(shares.readFrac - 0.6) < 1e-9)
  assert.ok(Math.abs(shares.writeFrac - 0.2) < 1e-9)
  assert.ok(Math.abs(shares.freshFrac + shares.readFrac + shares.writeFrac - 1) < 1e-9)
})

test('composition shares stay zero without prompt tokens', () => {
  for (const bucket of [null, undefined, {}, { input: 0, output: 9 }]) {
    const shares = T.compositionShares(bucket)
    assert.equal(shares.prompt, 0)
    assert.equal(shares.freshFrac, 0)
    assert.equal(shares.readFrac, 0)
    assert.equal(shares.writeFrac, 0)
  }
})

const stableLive = over => ({
  bucket: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, calls: 1 },
  cacheHitPct: 0, cost: 0.001, costSource: 'bundled', model: 'm', provider: 'p',
  rates: { input: 1, output: 2, cache: 0.5 }, usage: { input: 100 }, ...over
})

test('a live reading wins and is cached for its session', () => {
  const live = stableLive()
  const merged = T.mergeStableLive(null, live, 's1')
  assert.equal(merged.stale, false)
  assert.equal(merged.view, live)
  assert.equal(merged.cache.key, 's1')
  assert.equal(merged.cache.snapshot.cost, 0.001)
})

test('a transient gap shows the same-session reading as stale', () => {
  const first = T.mergeStableLive(null, stableLive(), 's1')
  const gap = T.mergeStableLive(first.cache, { ...stableLive(), bucket: null, usage: null }, 's1')
  assert.equal(gap.stale, true)
  assert.equal(gap.view.cost, 0.001)
  assert.equal(gap.view.model, 'm')
  assert.equal(gap.cache, first.cache)
})

test('a returning stream replaces the stale reading', () => {
  const first = T.mergeStableLive(null, stableLive(), 's1')
  const gap = T.mergeStableLive(first.cache, { ...stableLive(), bucket: null }, 's1')
  const back = T.mergeStableLive(gap.cache, stableLive({ cost: 0.002 }), 's1')
  assert.equal(back.stale, false)
  assert.equal(back.view.cost, 0.002)
  assert.equal(back.cache.snapshot.cost, 0.002)
})

test('a session switch never shows the previous reading', () => {
  const first = T.mergeStableLive(null, stableLive(), 's1')
  const switched = T.mergeStableLive(first.cache, { ...stableLive(), bucket: null, usage: null }, 's2')
  assert.equal(switched.stale, false)
  assert.equal(switched.view.bucket, null)
  assert.equal(switched.cache, null)
})

test('an empty session with no history stays empty', () => {
  const merged = T.mergeStableLive(null, { ...stableLive(), bucket: null, usage: null }, 's9')
  assert.equal(merged.stale, false)
  assert.equal(merged.view.bucket, null)
  assert.equal(merged.cache, null)
})

test('meter presence distinguishes live, recorded, updating and empty', () => {
  assert.equal(T.meterPresence(stableLive(), true), 'updating')
  assert.equal(T.meterPresence(stableLive(), false), 'live')
  assert.equal(T.meterPresence({ ...stableLive(), usage: null }, false), 'recorded')
  assert.equal(T.meterPresence({ ...stableLive(), usage: null, bucket: null }, false), 'empty')
  assert.equal(T.meterPresence(null, false), 'empty')
})

test('every sidebar string exists in English and Chinese', () => {
  const keys = ['meterLive', 'meterRecorded', 'meterUpdating', 'apiEquivalent', 'costSourceInfo',
    'totalTokens', 'promptMix', 'cacheFresh', 'cacheMethodInfo', 'exactLabel', 'estimatedLabel',
    'infoLabel', 'coverageLabel', 'savingsInfo']
  for (const key of keys) {
    assert.ok(en[key] && en[key] !== key, `en has ${key}`)
    assert.ok(zh[key] && zh[key] !== key, `zh has ${key}`)
  }
  assert.equal(typeof en.sinceDate, 'function')
  assert.equal(typeof zh.sinceDate, 'function')
  assert.equal(typeof en.partialShort, 'function')
  assert.equal(typeof zh.partialShort, 'function')
  assert.match(en.sinceDate('2026-10-31'), /2026-10-31/)
  assert.doesNotMatch(en.costSourceInfo, /invoice(?! may differ)/)
  assert.match(en.costSourceInfo, /may differ/)
})

test('the meter stylesheet keeps popovers, ring and reduced-motion support', () => {
  assert.match(T.METER_CSS, /wm-info-pop/)
  assert.match(T.METER_CSS, /wm-info-pop-wide/)
  assert.match(T.METER_CSS, /wm-ring-value/)
  assert.match(T.METER_CSS, /wm-mix-fill/)
  assert.match(T.METER_CSS, /prefers-reduced-motion/)
  assert.match(T.METER_CSS, /wm-stale/)
})

test('the pane root class cannot collide with the analytics cache bar', () => {
  // .wm-meter is the analytics cache bar; the pane stylesheet is global
  // while the pane is mounted, so it must not style that class.
  assert.match(T.METER_CSS, /\.wm-pane\{/)
  assert.doesNotMatch(T.METER_CSS, /\.wm-meter[\s{]/)
})
