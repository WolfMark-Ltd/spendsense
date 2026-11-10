// Run: node --test test/
// Focused regressions for WP06 — net cache savings reliability.
//
// The figure is the measured part of a conversation: a derived cache-write on a
// route with no published write price must not void it, an uncovered cold start
// must not hide it, and a route that genuinely cannot be priced must say why.
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
const useRef = initial => ({ current: initial })
const queryClient = { fetchQuery: async q => q.queryFn(), getQueryData: () => null }
const usePluginI18n = noop, useQuery = noop, useValue = noop
const jsx = noop, jsxs = noop
`
const body = src
  .replace(/import \{[^}]*\} from '@hermes\/plugin-sdk'\n/, stub)
  .replace(/import \{[^}]*\} from 'react'\n/, '')
  .replace(/import \{ jsx, jsxs \} from 'react\/jsx-runtime'\n/, '')
globalThis.window = { location: { hash: '' }, addEventListener() {}, removeEventListener() {} }
const dir = mkdtempSync(join(tmpdir(), 'wm-wp06-'))
const file = join(dir, 'plugin.mjs')
writeFileSync(file, body)
const T = (await import(pathToFileURL(file).href)).__test

const NOW = new Date(2026, 10, 10, 1, 0).getTime()
// commandcode/deepseek-v4.1-flash: verified input and cache-read price, no
// published cache-write price. `tiers: []` keeps the input band known.
const payload = {
  model: 'deepseek/deepseek-v4.1-flash', provider: 'commandcode',
  providers: [{ slug: 'commandcode', pricing: {
    'deepseek/deepseek-v4.1-flash': { input: '0.15', output: '0.6', cache: '0.003', tiers: [] }
  } }]
}
const frame = (over = {}) => ({
  model: 'deepseek/deepseek-v4.1-flash', input: 4000, prompt: 4000, output: 100, calls: 1, ...over
})
const fold = (led, usage, t = NOW) => T.applyUsage(led, {
  now: t, sessionId: 's', storedId: 'conv', provider: 'commandcode', payload, usage
})

test('an exact cache-write with no published write price stays unvalued', () => {
  const rates = { input: 2, output: 4, cache: .5, write: null, inputKnown: true, outputKnown: true, cacheKnown: true }
  assert.equal(T.cacheSavings(200, rates, 1000), null, 'a provider-reported write needs its price')
})

test('a derived cache-write is valued at the input rate when no write price is published', () => {
  const rates = { input: 2, output: 4, cache: .5, write: null, inputKnown: true, outputKnown: true, cacheKnown: true }
  const value = T.cacheSavings(200, rates, 1000, true)
  assert.equal(value, (200 * (2 - .5)) / 1e6, 'the read discount is the only term; the write premium is omitted')
  const published = T.cacheSavings(200, { ...rates, write: 3 }, 1000, true)
  assert.equal(published, -.0007, 'a published write price still carries its premium')
})

test('a published write price wins even for a derived write', () => {
  const rates = { input: 2, output: 4, cache: .5, write: 3, inputKnown: true, outputKnown: true, cacheKnown: true }
  assert.equal(T.cacheSavings(200, rates, 1000, true), -.0007)
})

test('a cold start no longer voids the conversation’s measured saving', () => {
  let led = T.emptyLedger()
  led = fold(led, frame())
  led = fold(led, frame({ input: 5000, prompt: 60000, output: 200, calls: 2, cache_hit_pct: 90 }), NOW + 1)
  led = fold(led, frame({ input: 5200, prompt: 120000, output: 300, calls: 3, cache_hit_pct: 95 }), NOW + 2)
  const hist = led.sessions.conv
  const prompt = T.tokensOf(hist)
  const state = T.savingsState(hist, T.resolveRates({ model: hist.model, provider: 'commandcode', payload, remembered: {} }).rates)
  assert.ok(hist.netSavings > 0, `measured saving accumulates: ${hist.netSavings}`)
  assert.ok(hist.netSavingsPrompt > 0 && hist.netSavingsPrompt < prompt,
    `covered ${hist.netSavingsPrompt} of ${prompt} — the cold start is uncovered, not zero`)
  assert.equal(state.value, hist.netSavings, 'the figure is shown')
  assert.equal(state.partial, true, 'and marked partial')
  assert.ok(state.coverage > 0 && state.coverage < 1)
  assert.equal(state.reason, null)
})

test('a fully estimated conversation is priced rather than blank', () => {
  let led = T.emptyLedger()
  led = fold(led, frame({ input: 5000, prompt: 60000, output: 200, calls: 1, cache_hit_pct: 90 }))
  led = fold(led, frame({ input: 5200, prompt: 120000, output: 300, calls: 2, cache_hit_pct: 95 }), NOW + 1)
  const hist = led.sessions.conv
  const state = T.savingsState(hist, T.resolveRates({ model: hist.model, provider: 'commandcode', payload, remembered: {} }).rates)
  assert.ok(state.value > 0, `saving: ${state.value}`)
  assert.equal(state.partial, false)
  assert.equal(state.coverage, 1)
  assert.equal(hist.cacheEstimated, true, 'the figure is still an estimate')
})

test('the totals keep the measured part and its coverage', () => {
  let led = T.emptyLedger()
  led = fold(led, frame())
  led = fold(led, frame({ input: 5000, prompt: 60000, output: 200, calls: 2, cache_hit_pct: 90 }), NOW + 1)
  led = fold(led, frame({ input: 5200, prompt: 120000, output: 300, calls: 3, cache_hit_pct: 95 }), NOW + 2)
  const { totals } = T.summarize(led, () => true, null)
  const state = T.savingsState(totals, null)
  assert.ok(state.value > 0, 'a partial range still reports its measured saving')
  assert.equal(state.partial, true)
  assert.ok(state.coverage > 0 && state.coverage < 1)
})

test('a route with no price names the reason instead of a figure', () => {
  const bucket = { input: 100, output: 10, cacheRead: 50, cacheWrite: 0, netSavingsPrompt: 0, netSavings: 0 }
  const none = T.savingsState(bucket, null)
  assert.equal(none.value, null)
  assert.equal(none.reason, 'no_rate')
  const noCache = T.savingsState({ input: 100, output: 10, cacheRead: 0, cacheWrite: 0,
    netSavingsPrompt: 0, netSavings: 0 }, null)
  assert.equal(noCache.reason, 'no_cache', 'no cache evidence is named, not priced as zero')
  const tiered = T.savingsState(bucket, { input: 2, output: 4, cache: .5, write: null,
    inputKnown: false, outputKnown: true, cacheKnown: true, usageTierKnown: false })
  assert.equal(tiered.value, null)
  assert.equal(tiered.reason, 'tiered')
  const noCachePrice = T.savingsState(bucket, { input: 2, output: 4, cache: null, write: null,
    inputKnown: true, outputKnown: true, cacheKnown: false })
  assert.equal(noCachePrice.reason, 'no_cache_rate')
})

test('a provider-reported write with no price is still named, never zero', () => {
  const bucket = { input: 100, output: 10, cacheRead: 50, cacheWrite: 20, netSavingsPrompt: 170, netSavings: 0.1, cacheExactPrompt: 170 }
  const state = T.savingsState(bucket, { input: 2, output: 4, cache: .5, write: null,
    inputKnown: true, outputKnown: true, cacheKnown: true })
  assert.equal(state.value, 0.1, 'an accumulated exact figure is still shown')
  // The gap reason only matters when there is no figure; the strict rule still
  // refuses to value a reported write.
  assert.equal(T.liveSavings(bucket, { input: 2, output: 4, cache: .5, write: null,
    inputKnown: true, outputKnown: true, cacheKnown: true }), null)
})

test('a bundled table rate carries the evidence its row publishes', () => {
  const rates = T.resolveRates({ model: 'deepseek/deepseek-v4.1-flash', provider: 'commandcode',
    payload: null, remembered: {} }).rates
  assert.equal(rates.inputKnown, true, 'a flat table row has a known input band')
  assert.equal(rates.cacheKnown, true, 'and a verified cache-read price')
  assert.equal(rates.write, null, 'but no cache-write price')
  assert.ok(T.cacheSavings(1_000_000, rates, 0) > 0,
    'so a saving is computable when the backend card is unavailable')
})

test('a provider-reported zero write needs no write price', () => {
  // Zero writes are a measurement, not an unknown price: no premium exists to
  // value, so the read discount is the whole saving.
  const rates = { input: 2, output: 4, cache: .5, write: null,
    inputKnown: true, outputKnown: true, cacheKnown: true }
  assert.equal(T.cacheSavings(200, rates, 0), (200 * (2 - .5)) / 1e6)
})

test('a derived write leaves the saving equal to the cost difference it claims', () => {
  // The pane shows a cost and a saving side by side. With no published write
  // price both charge the write at the input rate, so the saving is exactly
  // uncached-prompt cost minus cached-prompt cost on the shown card. That is
  // internal coherence, not accuracy against an unpublished premium — the
  // direction of that error is pinned in the next test.
  const rates = { input: 2, output: 4, cache: .5, write: null,
    inputKnown: true, outputKnown: true, cacheKnown: true }
  const input = 100, read = 200, write = 1000
  const prompt = input + read + write
  const uncached = T.costOf({ input: prompt, output: 0, cacheRead: 0, cacheWrite: 0 }, rates).total
  const cached = T.costOf({ input, output: 0, cacheRead: read, cacheWrite: write }, rates).total
  const claimed = T.cacheSavings(read, rates, write, true)
  assert.ok(Math.abs((uncached - cached) - claimed) < 1e-12,
    `cost difference ${uncached - cached} vs claimed ${claimed}`)

  // A published write price is carried through identically on both sides, so a
  // real premium (or discount) is never replaced by the zero-premium rule.
  for (const published of [3, 1]) {
    const card = { ...rates, write: published }
    const u = T.costOf({ input: prompt, output: 0, cacheRead: 0, cacheWrite: 0 }, card).total
    const c = T.costOf({ input, output: 0, cacheRead: read, cacheWrite: write }, card).total
    assert.ok(Math.abs((u - c) - T.cacheSavings(read, card, write, true)) < 1e-12,
      `published write ${published} stays consistent`)
  }
})

test('the input-rate fallback overstates an unpublished write premium', () => {
  // Direction, pinned so the reasoning cannot be reversed again: substituting
  // the input rate omits a cost, so a real premium makes the claimed saving
  // too high and a real discount makes it too low. Only the card's own rate is
  // exact, and the fallback is warranted by zero recorded writes, never by a
  // general claim that a missing price cannot overstate.
  const card = { input: 2, output: 4, cache: .5, write: null,
    inputKnown: true, outputKnown: true, cacheKnown: true }
  const read = 200, write = 1000
  const fallback = T.cacheSavings(read, card, write, true)
  const truth = writeRate => read * (2 - .5) / 1e6 + write * (2 - writeRate) / 1e6
  assert.ok(fallback > truth(2.5), 'an omitted write premium overstates the saving')
  assert.ok(fallback < truth(1.5), 'an omitted write discount understates it')
  assert.equal(fallback, truth(2), 'it is exact only at the input rate')
})

test('a published write discount is applied, never flattened to input', () => {
  const rates = { input: 2, output: 4, cache: .5, write: 1,
    inputKnown: true, outputKnown: true, cacheKnown: true }
  assert.equal(T.cacheSavings(200, rates, 1000, true), (200 * 1.5 + 1000 * 1) / 1e6)
})

test('a net cache loss keeps its sign in the state every surface reads', () => {
  // Greptile P1: `num` clamps at zero for token counts, so a negative net
  // saving must not pass through it. A write premium larger than the read
  // discount is a real loss, not an unavailable figure.
  const rates = { input: 2, output: 4, cache: .5, write: 3,
    inputKnown: true, outputKnown: true, cacheKnown: true }
  const bucket = { input: 100, output: 10, cacheRead: 200, cacheWrite: 1000,
    netSavingsPrompt: 1300, netSavings: -0.0007 }
  const state = T.savingsState(bucket, rates)
  assert.equal(state.value, -0.0007)
  assert.equal(state.partial, false, 'full coverage is not partial')
  assert.equal(state.reason, null, 'a measured loss is not an unavailable figure')
  assert.ok(T.fmtUsd(state.value).startsWith('−'), 'formatted with a minus, never zeroed')
  // The full signed range survives; only an absent amount is null.
  assert.equal(T.savingsState({ ...bucket, netSavings: 0 }, rates).value, 0, 'a measured zero is zero')
  assert.equal(T.savingsState({ ...bucket, netSavings: 0.42 }, rates).value, 0.42, 'positives are unchanged')
  assert.equal(T.savingsState({ ...bucket, netSavings: null }, rates).value, null, 'absence stays null')
  assert.equal(T.savingsState({ ...bucket, netSavings: undefined }, rates).value, null, 'missing stays null')
})

test('a loss survives the ledger fold and the range totals', () => {
  // write 3 > input 2, so 1000 write tokens at a 0.0007 loss outweigh the
  // 200-token read discount.
  const payload = { model: 'm', provider: 'p', providers: [{ slug: 'p', pricing: {
    m: { input: '2', output: '4', cache: '.5', cache_write: '3', tiers: [] }
  } }] }
  const led = T.applyUsage(T.emptyLedger(), { now: NOW, sessionId: 's', storedId: 'conv', provider: 'p', payload,
    usage: { model: 'm', input: 100, prompt: 1300, output: 10, cache_read: 200, cache_write: 1000, calls: 1 } })
  const hist = led.sessions.conv
  assert.equal(hist.netSavings, -0.0007)
  assert.equal(T.savingsState(hist, null).value, -0.0007, 'the conversation keeps the loss')

  const { rows, totals } = T.summarize(led, () => true, null)
  assert.equal(totals.netSavings, -0.0007)
  assert.equal(T.savingsState(totals, null).value, -0.0007, 'the totals line keeps the loss')
  assert.equal(T.savingsState(rows[0], null).value, -0.0007, 'the ledger row keeps the loss')
  assert.ok(T.fmtUsd(T.savingsState(rows[0], null).value).startsWith('−'))
})

test('negative amounts format with a minus at every magnitude', () => {
  assert.equal(T.fmtUsd(-1.2), '−$1.20')
  assert.equal(T.fmtUsd(-42), '−$42.00')
  assert.equal(T.fmtUsd(-0.0007), '−$0.0007')
  assert.equal(T.fmtUsd(0), '$0.00', 'zero stays a plain zero')
  assert.equal(T.fmtUsd(null), '—', 'absence stays absent')
})

test('the gauge note names an unavailable figure and never claims exactness', () => {
  const t = (key, ...args) => (args.length ? `${key}:${args.join(',')}` : key)
  const missing = T.savedNote(t, { saved: null, savedReason: 'tiered' }, false)
  assert.match(missing, /savedNotEstablished/)
  assert.match(missing, /savedReasonTiered/)
  assert.doesNotMatch(missing, /exactLabel|estimatedLabel/)
  const partial = T.savedNote(t, { saved: 1.2, savedPartial: true, savedCoverage: 0.4612 }, true)
  assert.match(partial, /savedPartialNote:46/)
  const exact = T.savedNote(t, { saved: 1.2, savedPartial: false, savedCoverage: 1 }, false)
  assert.equal(exact, 'exactLabel')
})
