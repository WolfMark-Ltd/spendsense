// Run: node --test --test-force-exit test/*.test.mjs
// Focused regressions for WP06 — net cache savings reliability.
//
// The local fallback keeps unavailable cache-write prices unknown and labels
// rounded splits as estimates; the backend session summary remains authoritative.
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
const pricedPayload = {
  ...payload,
  providers: payload.providers.map(row => ({ ...row,
    pricing: { ...row.pricing, 'deepseek/deepseek-v4.1-flash': {
      ...row.pricing['deepseek/deepseek-v4.1-flash'], cache_write: '0.15'
    } }
  }))
}
const frame = (over = {}) => ({
  model: 'deepseek/deepseek-v4.1-flash', input: 4000, prompt: 4000, output: 100, calls: 1, ...over
})
const fold = (led, usage, t = NOW, priceBook = payload) => T.applyUsage(led, {
  now: t, sessionId: 's', storedId: 'conv', provider: 'commandcode', payload: priceBook, usage
})

test('an exact cache-write with no published write price stays unvalued', () => {
  const rates = { input: 2, output: 4, cache: .5, write: null, inputKnown: true, outputKnown: true, cacheKnown: true }
  assert.equal(T.cacheSavings(200, rates, 1000), null, 'a provider-reported write needs its price')
})

test('a derived cache-write with no published write price stays unavailable', () => {
  const rates = { input: 2, output: 4, cache: .5, write: null, inputKnown: true, outputKnown: true, cacheKnown: true }
  assert.equal(T.cacheSavings(200, rates, 1000, true), null,
    'a derived write is not assigned the input price')
  const published = T.cacheSavings(200, { ...rates, write: 3 }, 1000, true)
  assert.equal(published, -.0007, 'a published write price still carries its premium')
})

test('a published write price wins even for a derived write', () => {
  const rates = { input: 2, output: 4, cache: .5, write: 3, inputKnown: true, outputKnown: true, cacheKnown: true }
  assert.equal(T.cacheSavings(200, rates, 1000, true), -.0007)
})

test('a cold start no longer voids the conversation’s measured saving', () => {
  let led = T.emptyLedger()
  led = fold(led, frame(), NOW, pricedPayload)
  led = fold(led, frame({ input: 5000, prompt: 60000, output: 200, calls: 2, cache_hit_pct: 90 }), NOW + 1, pricedPayload)
  // Keep the cumulative derived write counter monotonic so its delta is
  // classifiable; a rising rounded hit percentage can make the residual write
  // estimate fall, in which case the cache split must remain unknown.
  led = fold(led, frame({ input: 5200, prompt: 120000, output: 300, calls: 3, cache_hit_pct: 90 }), NOW + 2, pricedPayload)
  const hist = led.sessions.conv
  const prompt = T.tokensOf(hist)
  const state = T.savingsState(hist, T.resolveRates({ model: hist.model, provider: 'commandcode', payload: pricedPayload, remembered: {} }).rates)
  assert.ok(hist.netSavingsRangePrompt > 0 && hist.netSavingsRangePrompt < prompt,
    `covered ${hist.netSavingsRangePrompt} of ${prompt} — the cold start is uncovered, not zero`)
  assert.ok(state.range && state.range.min > 0, 'rounded derived counters produce a qualified range')
  assert.equal(state.value, null, 'uncertain derived counters are not collapsed to a scalar')
  assert.equal(state.partial, true, 'and marked partial')
  assert.ok(state.coverage > 0 && state.coverage < 1)
  assert.equal(state.reason, null)
})

test('a fully estimated conversation is priced rather than blank', () => {
  let led = T.emptyLedger()
  led = fold(led, frame({ input: 5000, prompt: 60000, output: 200, calls: 1, cache_hit_pct: 90 }), NOW, pricedPayload)
  led = fold(led, frame({ input: 5200, prompt: 120000, output: 300, calls: 2, cache_hit_pct: 90 }), NOW + 1, pricedPayload)
  const hist = led.sessions.conv
  const state = T.savingsState(hist, T.resolveRates({ model: hist.model, provider: 'commandcode', payload: pricedPayload, remembered: {} }).rates)
  assert.ok(state.range?.min > 0, `saving range: ${JSON.stringify(state.range)}`)
  assert.equal(state.partial, false)
  assert.equal(state.coverage, 1)
  assert.equal(hist.cacheEstimated, true, 'the figure is still an estimate')
})

test('the totals keep the measured part and its coverage', () => {
  let led = T.emptyLedger()
  led = fold(led, frame(), NOW, pricedPayload)
  led = fold(led, frame({ input: 5000, prompt: 60000, output: 200, calls: 2, cache_hit_pct: 90 }), NOW + 1, pricedPayload)
  led = fold(led, frame({ input: 5200, prompt: 120000, output: 300, calls: 3, cache_hit_pct: 90 }), NOW + 2, pricedPayload)
  const { totals } = T.summarize(led, () => true, null)
  const state = T.savingsState(totals, null)
  assert.ok(state.range?.min > 0, 'a partial range still reports its measured saving range')
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
  assert.equal(tiered.reason, 'context_tier_unknown')
  const noCachePrice = T.savingsState(bucket, { input: 2, output: 4, cache: null, write: null,
    inputKnown: true, outputKnown: true, cacheKnown: false })
  assert.equal(noCachePrice.reason, 'no_cache_rate')
})

test('rounded zero reads retain possible read discounts and require every uncertain stream price', () => {
  const rates = { input: 3, output: 4, cache: .3, write: 3.75,
    inputKnown: true, outputKnown: true, cacheKnown: true, writeKnown: true }
  const bounds = T.cacheSavingsBounds(0, rates, 1000,
    { cacheCounterUncertainty: { readWriteTokens: 9 } })
  const possibleNineReads = (9 * (rates.input - rates.cache) + 991 * (rates.input - rates.write)) / 1e6
  assert.ok(bounds.min <= possibleNineReads && possibleNineReads <= bounds.max,
    `the possible nine-read result ${possibleNineReads} is inside ${JSON.stringify(bounds)}`)
  assert.equal(T.cacheSavingsBounds(0, { ...rates, cacheKnown: false }, 1000,
    { cacheCounterUncertainty: { readWriteTokens: 9 } }), null,
  'a possible read cannot be priced without the cache-read rate')
  assert.equal(T.cacheSavingsBounds(0, { ...rates, write: null, writeKnown: false }, 1000,
    { cacheCounterUncertainty: { readWriteTokens: 9 } }), null,
  'a possible write cannot be priced without its write rate')
  assert.equal(T.cacheSavingsBounds(0, { ...rates, cacheKnown: false }, 0).min, 0,
    'an exactly reported zero read with no uncertainty remains a true zero')
})

test('an indeterminate session summary names unknown cache evidence after pricing gaps', () => {
  const envelope = gaps => ({ identity: 'identity-a', sessionId: 'session-a', payload: {
    ok: true, session_id: 'session-a',
    population: { requested: 'all', satisfied: true, separable: false },
    totals: { calls: 1, cache_read_state: 'unknown', cache_write_state: 'unknown' },
    valuation: { savings_basis: 'indeterminate', covered_calls: 0, excluded_calls: 1,
      gap_reasons: gaps }
  } })
  assert.equal(T.sessionSavingsState(envelope({ cache_evidence_unknown: 1 }), 'session-a', 'identity-a').reason,
    'cache_evidence_unknown')
  assert.equal(T.sessionSavingsState(envelope({ cache_evidence_unknown: 1, missing_cache_read_rate: 1 }),
    'session-a', 'identity-a').reason, 'no_cache_rate', 'pricing gaps retain precedence')
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

test('a derived write reconciles when a published write price is available', () => {
  const rates = { input: 2, output: 4, cache: .5, write: null,
    inputKnown: true, outputKnown: true, cacheKnown: true }
  const input = 100, read = 200, write = 1000
  const prompt = input + read + write
  assert.equal(T.cacheSavings(read, rates, write, true), null)

  for (const published of [3, 1]) {
    const card = { ...rates, write: published }
    const u = T.costOf({ input: prompt, output: 0, cacheRead: 0, cacheWrite: 0 }, card).total
    const c = T.costOf({ input, output: 0, cacheRead: read, cacheWrite: write }, card).total
    assert.ok(Math.abs((u - c) - T.cacheSavings(read, card, write, true)) < 1e-12)
  }
})

test('a missing derived-write price never falls back to the input rate', () => {
  const card = { input: 2, output: 4, cache: .5, write: null,
    inputKnown: true, outputKnown: true, cacheKnown: true }
  const read = 200, write = 1000
  assert.equal(T.cacheSavings(read, card, write, true), null)
  assert.equal(T.cacheSavings(read, { ...card, write: 2.5 }, write, true), -.0002)
  assert.equal(T.cacheSavings(read, { ...card, write: 1.5 }, write, true), .0008)
})

test('a published write discount is applied, never flattened to input', () => {
  const rates = { input: 2, output: 4, cache: .5, write: 1,
    inputKnown: true, outputKnown: true, cacheKnown: true }
  assert.equal(T.cacheSavings(200, rates, 1000, true), (200 * 1.5 + 1000 * 1) / 1e6)
})

test('cache savings reconcile independently for partial, negative, zero and unknown states', () => {
  const rates = { input: 2, output: 4, cache: .5, write: 3 }
  const expectedByIndependentPrices = ({ input, read, write, output }, card = rates) => {
    const prompt = input + read + write
    const uncachedCost = (prompt * card.input + output * card.output) / 1e6
    const cachedCost = (input * card.input + read * card.cache + write * card.write + output * card.output) / 1e6
    return uncachedCost - cachedCost
  }
  const foldScenario = (name, card, frames) => {
    const model = `test/cache-savings-${name}`
    const provider = 'test-cache-provider'
    const scenarioPayload = card ? { model, provider, providers: [{ slug: provider, pricing: {
      [model]: { input: String(card.input), output: String(card.output), cache: String(card.cache),
        cache_write: card.write == null ? undefined : String(card.write), tiers: [] }
    } }] } : null
    let led = T.emptyLedger()
    frames.forEach((usage, index) => {
      led = T.applyUsage(led, { now: NOW + index, payload: scenarioPayload, provider,
        sessionId: `${name}-runtime-${index}`, storedId: `${name}-conversation`,
        usage: { model, ...usage } })
    })
    return led.sessions[`${name}-conversation`]
  }

  const partialTokens = { input: 100, read: 200, write: 0, output: 40 }
  const partialExpected = expectedByIndependentPrices(partialTokens)
  const partialBucket = foldScenario('partial', rates, [
    { input: 1000, prompt: 1100, output: 0, calls: 1 },
    { input: 300, prompt: 300, output: 40, calls: 1, cache_read: 200, cache_write: 0, cache_write_reported: true },
  ])
  const partial = T.savingsState(partialBucket, rates)
  assert.ok(Math.abs(partialExpected - .0003) < 1e-12, 'the independent card-price calculation includes only the measured read discount')
  assert.ok(Math.abs(partialBucket.netSavings - partialExpected) < 1e-12, 'the ledger fold matches the independent calculation')
  assert.equal(partialBucket.netSavingsPrompt, 300, 'only the known split contributes to priced savings')
  assert.ok(Math.abs(partial.value - partialExpected) < 1e-12, 'the measured subtotal matches the independent calculation')
  assert.equal(partial.coverage, 300 / 1400, 'coverage uses priced-savings prompt tokens over the full prompt')
  assert.equal(partial.partial, true, 'uncovered prompt tokens remain visibly partial')

  const negativeTokens = { input: 100, read: 200, write: 1000, output: 10 }
  const negativeExpected = expectedByIndependentPrices(negativeTokens)
  const negativeBucket = foldScenario('negative', rates, [{
    input: 1300, prompt: 1300, output: 10, calls: 1,
    cache_read: negativeTokens.read, cache_write: negativeTokens.write,
  }])
  const negative = T.savingsState(negativeBucket, rates)
  assert.ok(Math.abs(negativeExpected + .0007) < 1e-12, 'the write premium outweighs the read discount')
  assert.ok(Math.abs(negativeBucket.netSavings - negativeExpected) < 1e-12,
    'the ledger fold retains the independently derived cache-write loss')
  assert.ok(Math.abs(negative.value - negativeExpected) < 1e-12)
  assert.equal(negative.partial, false)

  const zeroRates = { ...rates, cache: rates.input, write: rates.input }
  const zeroExpected = expectedByIndependentPrices({ input: 100, read: 200, write: 0, output: 10 }, zeroRates)
  const zeroBucket = foldScenario('zero', zeroRates, [{
    input: 300, prompt: 300, output: 10, calls: 1, cache_read: 200, cache_write: 0,
    cache_write_reported: true,
  }])
  const measuredZero = T.savingsState(zeroBucket, zeroRates)
  assert.equal(zeroExpected, 0, 'equal cache and input prices produce a measured zero')
  assert.equal(zeroBucket.netSavings, zeroExpected, 'the ledger fold records the independently calculated zero')
  assert.equal(measuredZero.coverage, 1)
  assert.equal(measuredZero.value, 0, 'known zero remains a figure rather than becoming unavailable')

  const unknownBucket = foldScenario('unknown', null, [{
    input: 150, prompt: 150, output: 10, calls: 1, cache_read: 50, cache_write: 0,
  }])
  const unknown = T.savingsState(unknownBucket, null)
  assert.equal(unknown.value, null, 'an unknown subtotal is not presented as $0')
  assert.equal(unknown.coverage, 0, 'unknown pricing has no covered prompt tokens')
  assert.equal(unknown.reason, 'no_rate', 'the missing price remains named')
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

const gpt62SolRates = () => ({
  input: 2, output: 10, cache: .1, write: 2.5,
  inputKnown: false, outputKnown: true, cacheKnown: true, writeKnown: true,
  hasTiers: true, tierDetailsKnown: true,
  cacheWriteRates: [{ retention: '30m', rate: 2.5 }, { retention: '12h', rate: 5 }],
  tiers: [{ threshold: 272000, inclusive: false, input: 4, output: 15, cache: .2, write: 5,
    cacheWriteRates: [{ retention: '30m', rate: 5 }, { retention: '12h', rate: 10 }] }]
})

test('GPT-6.2 Sol applies the short and long context boundary per request', () => {
  const rates = gpt62SolRates()
  const short = T.cacheSavingsBounds(1_000_000, rates, 0, { contextPrompt: 272000 })
  const long = T.cacheSavingsBounds(1_000_000, rates, 0, { contextPrompt: 272001 })
  const mixed = T.cacheSavingsBounds(1_000_000, rates, 1_000_000)
  assert.ok(Math.abs(mixed.min - (-2.2)) < 1e-12)
  assert.ok(Math.abs(mixed.max - 2.8) < 1e-12)
  assert.deepEqual(short, { min: 1.9, max: 1.9, exact: true }, 'exactly 272,000 tokens stays short')
  assert.deepEqual(long, { min: 3.8, max: 3.8, exact: true }, 'the long tier starts above 272,000')
})

test('backend rate resolution preserves GPT-6.2 Sol tiers and write retentions', async () => {
  const provider = 'f141-backend-provider'
  const model = 'gpt-6.2-sol'
  const rates = gpt62SolRates()
  T.setRest(async () => ({ rate: {
    input: rates.input, output: rates.output, cache_read: rates.cache, cache_write: rates.write,
    cache_write_rates: rates.cacheWriteRates.map(row => ({ retention: row.retention, rate: row.rate })),
    has_tiers: true,
    tiers: rates.tiers.map(row => ({ threshold: row.threshold, inclusive: row.inclusive, input: row.input, output: row.output,
      cache_read: row.cache, cache_write: row.write,
      cache_write_rates: row.cacheWriteRates.map(option => ({ retention: option.retention, rate: option.rate })) }))
  } }))
  try {
    await T.ensureBackendRate(provider, model)
    const resolved = T.resolveRates({ model, provider })
    assert.equal(resolved.origin, 'backend')
    assert.deepEqual(T.cacheSavingsBounds(1_000_000, resolved.rates, 0,
      { contextPrompt: 272_000 }), { min: 1.9, max: 1.9, exact: true })
    assert.deepEqual(T.cacheSavingsBounds(1_000_000, resolved.rates, 0,
      { contextPrompt: 272_001 }), { min: 3.8, max: 3.8, exact: true })
    assert.deepEqual(resolved.rates.tiers[0].cacheWriteRates,
      [{ retention: '30m', rate: 5 }, { retention: '12h', rate: 10 }])
  } finally {
    T.setRest(null)
  }
})

test('mixed GPT-6.2 Sol calls use each request tier and retain the write-retention range', () => {
  const model = 'gpt-6.2-sol'
  const provider = 'openai'
  const payload = { model, provider, providers: [{ slug: provider, pricing: { [model]: {
    input: '2', output: '10', cache: '.1', cache_write: '2.5',
    cache_write_rates: [{ retention: '30m', rate: 2.5 }, { retention: '12h', rate: 5 }],
    tiers: [{ threshold: 272000, inclusive: false, input: 4, output: 15, cache_read: .2, cache_write: 5,
      cache_write_rates: [{ retention: '30m', rate: 5 }, { retention: '12h', rate: 10 }] }]
  } } }] }
  let led = T.emptyLedger()
  led = T.applyUsage(led, { now: NOW, sessionId: 'gpt62', storedId: 'gpt62-conversation', provider, payload,
    usage: { model, input: 100000, prompt: 272000, output: 100, calls: 1, cache_read: 162000, cache_write: 10000 } })
  led = T.applyUsage(led, { now: NOW + 1, sessionId: 'gpt62', storedId: 'gpt62-conversation', provider, payload,
    usage: { model, input: 202001, prompt: 544001, output: 200, calls: 2, cache_read: 322000, cache_write: 20000 } })

  const history = led.sessions['gpt62-conversation']
  const state = T.savingsState(history, T.resolveRates({ model, provider, payload, remembered: {} }).rates)
  assert.equal(history.netSavingsPrompt, 0, 'retention uncertainty is never forced into an exact subtotal')
  assert.equal(history.netSavingsRangePrompt, 544001)
  assert.ok(Math.abs(state.range.min - .8258) < 1e-12)
  assert.ok(Math.abs(state.range.max - .9008) < 1e-12)
  assert.equal(state.coverage, 1)
})

test('missing tier cache prices and write prices remain unavailable', () => {
  const rates = gpt62SolRates()
  assert.equal(T.cacheSavingsBounds(1000, { ...rates, cacheKnown: false }, 0,
    { contextPrompt: 100000 }), null, 'an absent cache-read rate is not a zero')
  const noWrite = { ...rates, write: null, writeKnown: false, cacheWriteRates: [],
    tiers: rates.tiers.map(tier => ({ ...tier, write: null, cacheWriteRates: [] })) }
  assert.equal(T.cacheSavingsBounds(0, noWrite, 1000,
    { contextPrompt: 100000, derivedWrite: true }), null,
  'tiered derived writes cannot use the flat input-rate fallback')
  assert.equal(T.savingsGapReason({ cacheRead: 0, cacheWrite: 1000, cacheSource: 'estimated' }, noWrite), 'no_write_rate')
})

test('rounded cumulative cache splits use both snapshots when widening the range', () => {
  const model = 'gpt-6.2-sol'
  const provider = 'openai'
  const payload = { model, provider, providers: [{ slug: provider, pricing: { [model]: {
    input: '2', output: '10', cache: '.1', cache_write: '2.5',
    cache_write_rates: [{ retention: '30m', rate: 2.5 }, { retention: '12h', rate: 5 }],
    tiers: [{ threshold: 272000, inclusive: false, input: 4, output: 15, cache_read: .2, cache_write: 5,
      cache_write_rates: [{ retention: '30m', rate: 5 }, { retention: '12h', rate: 10 }] }]
  } } }] }
  let led = T.emptyLedger()
  const fold = (usage, now) => { led = T.applyUsage(led, { now, sessionId: 'rounding', storedId: 'rounding-conversation',
    provider, payload, usage: { model, output: 0, ...usage } }) }
  fold({ input: 50000, prompt: 100000, calls: 1, cache_hit_pct: 20 }, NOW)
  fold({ input: 100000, prompt: 200000, calls: 2, cache_hit_pct: 20 }, NOW + 1)

  const history = led.sessions['rounding-conversation']
  const state = T.savingsState(history, T.resolveRates({ model, provider, payload, remembered: {} }).rates)
  const rateOnly = T.cacheSavingsBounds(60000, gpt62SolRates(), 60000,
    { contextPrompt: 100000, derivedWrite: true })
  const totalUncertaintyTokens = 500.5 + 1000.5 + 500.5
  const rateSpread = 1.9 - (2 - 5)
  const expectedWidth = rateOnly.max - rateOnly.min + 2 * totalUncertaintyTokens * rateSpread / 1e6
  assert.ok(state.range)
  assert.ok(Math.abs((state.range.max - state.range.min) - expectedWidth) < 1e-12,
    'the second cumulative reading contributes its own rounding error and the prior snapshot error')
})

test('new tiered pricing does not rewrite historical savings when the conversation grows', () => {
  const model = 'gpt-6.2-sol'
  const provider = 'openai'
  const payload = { model, provider, providers: [{ slug: provider, pricing: { [model]: {
    input: '2', output: '10', cache: '.1', cache_write: '2.5',
    cache_write_rates: [{ retention: '30m', rate: 2.5 }, { retention: '12h', rate: 5 }],
    tiers: [{ threshold: 272000, inclusive: false, input: 4, output: 15, cache_read: .2, cache_write: 5,
      cache_write_rates: [{ retention: '30m', rate: 5 }, { retention: '12h', rate: 10 }] }]
  } } }] }
  let led = T.applyUsage(T.emptyLedger(), { now: NOW, sessionId: 'history', storedId: 'history-conversation',
    provider, payload, usage: { model, input: 80000, prompt: 200000, output: 0, calls: 1,
      cache_read: 100000, cache_write: 20000 } })
  const rates = T.resolveRates({ model, provider, payload, remembered: {} }).rates
  for (const key of Object.keys(led.days[Object.keys(led.days)[0]])) {
    const bucket = led.days[Object.keys(led.days)[0]][key]
    bucket.netSavings = 0
    bucket.netSavingsPrompt = 0
    bucket.netSavingsMin = 0
    bucket.netSavingsMax = 0
    bucket.netSavingsRangePrompt = 0
  }
  led.sessions['history-conversation'].netSavings = 0
  led.sessions['history-conversation'].netSavingsPrompt = 0
  led.sessions['history-conversation'].netSavingsMin = 0
  led.sessions['history-conversation'].netSavingsMax = 0
  led.sessions['history-conversation'].netSavingsRangePrompt = 0
  const displayedBefore = T.savingsState(led.sessions['history-conversation'], rates)
  assert.equal(displayedBefore.value, null, 'historical savings stay unavailable when no value was recorded')

  led = T.applyUsage(led, { now: NOW + 1, sessionId: 'history', storedId: 'history-conversation',
    provider, payload, usage: { model, input: 240001, prompt: 500001, output: 100, calls: 2,
      cache_read: 210000, cache_write: 50000 } })
  const state = T.savingsState(led.sessions['history-conversation'], rates)
  assert.equal(led.sessions['history-conversation'].netSavingsRangePrompt, 300001,
    'only newly observed prompt tokens receive the current request-level range')
  assert.ok(Math.abs(state.coverage - 300001 / 500001) < 1e-12)
  assert.equal(state.partial, true)
  assert.ok(state.range.min < state.range.max)
})

test('derived cache writes include published premiums and rounded-counter uncertainty', () => {
  const model = 'gpt-6.2-sol'
  const provider = 'openai'
  const payload = { model, provider, providers: [{ slug: provider, pricing: { [model]: {
    input: '2', output: '10', cache: '.1', cache_write: '2.5',
    cache_write_rates: [{ retention: '30m', rate: 2.5 }, { retention: '12h', rate: 5 }],
    tiers: [{ threshold: 272000, inclusive: false, input: 4, output: 15, cache_read: .2, cache_write: 5,
      cache_write_rates: [{ retention: '30m', rate: 5 }, { retention: '12h', rate: 10 }] }]
  } } }] }
  const led = T.applyUsage(T.emptyLedger(), { now: NOW, sessionId: 'derived-gpt62', storedId: 'derived-conversation', provider, payload,
    usage: { model, input: 10000, prompt: 200000, output: 500, calls: 1, cache_hit_pct: 80 } })
  const history = led.sessions['derived-conversation']
  const rates = T.resolveRates({ model, provider, payload, remembered: {} }).rates
  const state = T.savingsState(history, rates)
  assert.equal(T.derivedWrites(history), true)
  assert.equal(history.cacheWrite, 30000)
  assert.ok(state.range.min < state.range.max, 'retention and rounded split uncertainty stay visible')
  assert.ok(state.range.min < .214 && state.range.max > .289,
    'both published write premiums affect the outer range')
  assert.match(T.savedDisplay((key, ...args) => typeof T.I18N.en[key] === 'function'
    ? T.I18N.en[key](...args) : T.I18N.en[key], { savedRange: state.range, savedEstimated: state.estimated }), /^≈/)
})

test('cache-savings ranges have distinct English and Chinese labels', () => {
  const en = (key, ...args) => typeof T.I18N.en[key] === 'function' ? T.I18N.en[key](...args) : T.I18N.en[key]
  const zh = (key, ...args) => typeof T.I18N.zh[key] === 'function' ? T.I18N.zh[key](...args) : T.I18N.zh[key]
  const view = { savedRange: { min: -.1, max: .2 } }
  assert.equal(T.savedDisplay(en, view), '≈−$0.100 to $0.200')
  assert.equal(T.savedDisplay(zh, view), '≈−$0.100 至 $0.200')
  assert.match(T.savedNote(en, view, true), /cache-write retention/)
  assert.match(T.savedNote(zh, view, true), /缓存写入保留时长/)
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

test('an unclassified prompt residual stays unknown when no cache counters are reported', () => {
  const bucket = T.readUsage({ input: 100, prompt: 150, output: 10, calls: 1 })
  assert.equal(bucket.cacheRead, 0)
  assert.equal(bucket.cacheWrite, 0)
  assert.equal(bucket.cacheUnknown, 50)
  assert.equal(bucket.cacheReadEvidence, 'unknown')
  assert.equal(bucket.cacheWriteEvidence, 'unknown')
  assert.equal(T.tokensOf(bucket), 160)
  assert.equal(T.cacheCoverage(bucket), null, 'unknown evidence is not a measured 0%')
})

test('a rounded cache hit percentage labels reads estimated and writes derived', () => {
  const bucket = T.readUsage({ input: 100, prompt: 150, output: 10, calls: 1, cache_hit_pct: 20 })
  assert.equal(bucket.cacheRead, 30)
  assert.equal(bucket.cacheWrite, 20)
  assert.equal(bucket.cacheReadEvidence, 'estimated')
  assert.equal(bucket.cacheWriteEvidence, 'derived')
  assert.equal(T.localCacheEvidence(bucket).write, 'derived')
})

test('a provider-reported cache zero remains distinct from missing counters', () => {
  const reportedZero = T.readUsage({ input: 100, prompt: 100, output: 10, calls: 1,
    cache_read: 0, cache_write: 0, cache_read_reported: true, cache_write_reported: true })
  const unknown = T.readUsage({ input: 100, prompt: 100, output: 10, calls: 1 })
  assert.equal(reportedZero.cacheReadEvidence, 'reported')
  assert.equal(reportedZero.cacheWriteEvidence, 'reported')
  assert.equal(T.cacheCoverage(reportedZero), 1)
  assert.equal(T.hitPctOf(reportedZero), 0)
  assert.equal(unknown.cacheReadEvidence, 'unknown')
  assert.equal(unknown.cacheWriteEvidence, 'unknown')
  assert.equal(T.cacheCoverage(unknown), null)
  assert.equal(T.hitPctOf(unknown), null)
})

test('an inclusive xAI tier switches at its published threshold', () => {
  const rates = { input: 1, output: 1, cache: .2, write: 1,
    inputKnown: false, outputKnown: true, cacheKnown: true, writeKnown: true,
    hasTiers: true, tierDetailsKnown: true,
    tiers: [{ threshold: 100, inclusive: true, input: 2, output: 2, cache: .5, write: 2 }] }
  assert.deepEqual(T.cacheSavingsBounds(100, rates, 0, { contextPrompt: 99 }),
    { min: .00008, max: .00008, exact: true })
  assert.deepEqual(T.cacheSavingsBounds(100, rates, 0, { contextPrompt: 100 }),
    { min: .00015, max: .00015, exact: true })
  assert.deepEqual(T.cacheSavingsBounds(100, rates, 0, { contextPrompt: 101 }),
    { min: .00015, max: .00015, exact: true })
})

const provenMainEnvelope = (valuation = {}, totals = {}, population = {}) => ({
  identity: 'profile-a', sessionId: 'session-a',
  payload: {
    ok: true, session_id: 'session-a',
    population: { requested: 'all', satisfied: true, separable: false, ...population },
    totals: { calls: 2, input_tokens: 100, output_tokens: 20, prompt_tokens: 300,
      cache_read_tokens: 200, cache_write_tokens: 0,
      cache_read_state: 'reported', cache_write_state: 'reported', ...totals },
    valuation: { savings_usd: 0, savings_usd_high: null, savings_basis: 'exact',
      coverage: 1, covered_calls: 2, excluded_calls: 0, api_equivalent_usd: 0,
      api_equivalent_basis: 'exact', cache_hit_rate: 0, cache_hit_rate_basis: 'all_calls', ...valuation }
  }
})

test('the session summary preserves exact zero, negative savings and retention ranges', () => {
  const exactZero = T.sessionSavingsState(provenMainEnvelope(), 'session-a', 'profile-a')
  assert.equal(exactZero.available, true)
  assert.equal(exactZero.value, 0)
  assert.equal(exactZero.coverage, 1)
  assert.equal(exactZero.valuation.cache_hit_rate, 0)

  const negative = T.sessionSavingsState(provenMainEnvelope({ savings_usd: -.125 }),
    'session-a', 'profile-a')
  assert.equal(negative.value, -.125)

  const costBound = T.sessionSavingsState(provenMainEnvelope({ savings_usd: -.125,
    api_equivalent_bound_reason: 'context_tier_unknown' }), 'session-a', 'profile-a')
  assert.equal(costBound.available, true,
    'API-equivalent cost uncertainty does not overwrite the separate cache-savings basis')
  assert.equal(costBound.value, -.125)

  const range = T.sessionSavingsState(provenMainEnvelope({ savings_usd: -.1,
    savings_usd_high: .05, savings_basis: 'range', coverage: .5,
    covered_calls: 1, excluded_calls: 1 }), 'session-a', 'profile-a')
  assert.deepEqual(range.range, { min: -.1, max: .05 })
  assert.equal(range.partial, true)
})

test('signed backend upper and lower bounds remain qualified', () => {
  const upper = T.sessionSavingsState(provenMainEnvelope({ savings_usd: -.2,
    savings_basis: 'upper_bound', coverage: .5, covered_calls: 1, excluded_calls: 1 }),
  'session-a', 'profile-a')
  assert.equal(upper.kind, 'upper')
  assert.equal(upper.value, -.2)
  assert.equal(upper.partial, true)

  const lower = T.sessionSavingsState(provenMainEnvelope({ savings_usd: .2,
    savings_basis: 'lower_bound' }), 'session-a', 'profile-a')
  assert.equal(lower.kind, 'lower')
  assert.equal(lower.value, .2)
})

test('refused, stale, tier-unknown and unpriced summaries never consume all-call alternates', () => {
  const refused = provenMainEnvelope({}, {}, { satisfied: false, separable: false })
  refused.payload.alternate = { scope: 'all_calls', valuation: { savings_usd: 999999 } }
  const refusedState = T.sessionSavingsState(refused, 'session-a', 'profile-a')
  assert.equal(refusedState.scopeProven, false)
  assert.equal(refusedState.available, false)
  assert.equal(refusedState.reason, 'population_not_proven')
  assert.equal(T.backendSummaryBucket(refusedState), null)

  const stale = T.sessionSavingsState(provenMainEnvelope(), 'session-b', 'profile-a')
  assert.equal(stale.reason, 'summary_stale')

  const tierUnknown = T.sessionSavingsState(provenMainEnvelope({ savings_usd: 0,
    savings_basis: 'exact', savings_bound_reason: 'context_tier_unknown' }),
  'session-a', 'profile-a')
  assert.equal(tierUnknown.available, false)
  assert.equal(tierUnknown.reason, 'context_tier_unknown')
  const unavailableTierRate = T.sessionSavingsState(provenMainEnvelope({ savings_usd: null,
    savings_basis: null, covered_calls: 0, excluded_calls: 1,
    gap_reasons: { tier_rate_unavailable: 1 } }, { calls: 1 }), 'session-a', 'profile-a')
  assert.equal(unavailableTierRate.available, false)
  assert.equal(unavailableTierRate.reason, 'context_tier_unknown')

  const unpriced = T.sessionSavingsState(provenMainEnvelope({ savings_usd: null,
    savings_basis: null, covered_calls: 0, excluded_calls: 1,
    gap_reasons: { price_evidence_missing: 1 } }, { calls: 1 }), 'session-a', 'profile-a')
  assert.equal(unpriced.available, false)
  assert.equal(unpriced.reason, 'unpriced_route')

  const partialUnpriced = T.sessionSavingsState(provenMainEnvelope({ savings_usd: -.025,
    savings_basis: 'exact', coverage: .5, covered_calls: 1, excluded_calls: 1,
    gap_reasons: { price_evidence_missing: 1 } }, { calls: 2 }), 'session-a', 'profile-a')
  assert.equal(partialUnpriced.available, true, 'known calls remain useful as a qualified subtotal')
  assert.equal(partialUnpriced.kind, 'value')
  assert.equal(partialUnpriced.value, -.025)
  assert.equal(partialUnpriced.partial, true)
  assert.equal(partialUnpriced.excludedCalls, 1)
  const t = (key, ...args) => typeof T.I18N.en[key] === 'function'
    ? T.I18N.en[key](...args) : T.I18N.en[key]
  const note = T.savedNote(t, {
    ...partialUnpriced, saved: partialUnpriced.value, savedSource: 'backend_summary',
    savedEvidence: { read: 'reported', write: 'reported' },
    savedCoverage: partialUnpriced.coverage, savedPartial: true, cacheHitRateBasis: 'reported_calls'
  }, false)
  assert.match(note, /1 call\(s\) excluded from this subtotal/)
})

test('historical ledger summaries retain reported, partial, derived and unknown provenance', () => {
  const day = '2026-11-10'
  const base = { input: 100, output: 0, calls: 1, cost: 0, profile: '', provider: 'p',
    legacy: false, sources: {}, cacheRead: 10, cacheWrite: 0 }
  const ledger = { days: { [day]: {
    exact: { ...base, model: 'exact', cacheExactPrompt: 110 },
    derived: { ...base, model: 'derived', cacheEstimated: true, cacheEstimatedPrompt: 110, cacheRead: 5, cacheWrite: 5 },
    unknown: { ...base, model: 'unknown', cacheEstimated: true, cacheRead: 0, cacheWrite: 10 },
    partial: { ...base, model: 'partial', cacheExactPrompt: 55, cacheEstimatedPrompt: 55, cacheRead: 8, cacheWrite: 2 }
  } } }
  const { rows } = T.summarize(ledger, () => true, null)
  const byModel = Object.fromEntries(rows.map(row => [row.model, row]))
  assert.deepEqual(T.localCacheEvidence(byModel.exact), { read: 'reported', write: 'reported' })
  assert.deepEqual(T.localCacheEvidence(byModel.derived), { read: 'estimated', write: 'derived' })
  assert.deepEqual(T.localCacheEvidence(byModel.unknown), { read: 'unknown', write: 'derived' })
  assert.deepEqual(T.localCacheEvidence(byModel.partial), { read: 'partial', write: 'partial' })
})
