// Run: node --test --test-force-exit test/*.test.mjs
// Loads desktop/plugin.js with the host SDK and React stubbed out, then
// exercises the pure accounting internals exported as `__test`.
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
const host = { state: { focusedSessionId: { get: () => null, listen: () => () => {} }, focusedStoredSessionId: { get: () => null, listen: () => () => {} }, profile: { get: () => '' }, focusedSessionProfile: { get: () => '' } }, notify() {}, navigate(p) { globalThis.__nav.push(p); globalThis.window.location.hash = '#' + p }, request: async () => null }
const useEffect = noop
const useRef = initial => ({ current: initial })
const queryClient = { fetchQuery: async q => q.queryFn(), getQueryData: () => null }
const usePluginI18n = () => (key, ...args) => {
  const entry = I18N.en[key]
  return typeof entry === 'function' ? entry(...args) : entry ?? key
}
const useQuery = () => ({})
const useValue = store => store?.get?.()
const jsx = (type, props, key) => ({ type, props: props || {}, key })
const jsxs = jsx
`
const body = src
  .replace(/import \{[^}]*\} from '@hermes\/plugin-sdk'\n/, stub)
  .replace(/import \{[^}]*\} from 'react'\n/, '')
  .replace(/import \{ jsx, jsxs \} from 'react\/jsx-runtime'\n/, '')
globalThis.__nav = []
globalThis.window = { location: { hash: '' }, addEventListener() {}, removeEventListener() {} }
const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'tcm-'))
const file = join(dir, 'plugin.mjs')
writeFileSync(file, body)
const mod = await import(pathToFileURL(file).href)
const { __test: T } = mod
const plugin = mod.default
const findElement = (node, matches) => {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement(child, matches)
      if (found) return found
    }
    return null
  }
  if (!node || typeof node !== 'object') return null
  if (matches(node)) return node
  return findElement(node.props?.children, matches)
}

const NOW = new Date(2026, 9, 21, 12).getTime()
const coverageLedger = bucket => {
  const day = T.dayKey(NOW)
  const key = JSON.stringify(['work', 'provider-x', 'model-x', 0])
  const saved = {
    cacheRead: 0, cacheWrite: 0, calls: 2, cost: 0.0105, input: 1000, legacy: false,
    model: 'model-x', output: 500, pricedTokens: 1500, profile: 'work', provider: 'provider-x',
    saved: 0, sources: { live: 1500 }, unpricedTokens: 0, ...bucket
  }
  return {
    ...T.emptyLedger(),
    days: { [day]: { [key]: saved } },
    sessions: { conversation: { ...saved, firstAt: NOW, lastAt: NOW } }
  }
}
const copilotPayload = rates => ({
  model: 'claude-opus-5',
  provider: 'github-copilot',
  providers: [
    { slug: 'nous', pricing: { 'claude-opus-5': { input: '$9', output: '$9', cache: '$9' } } },
    { slug: 'github-copilot', pricing: rates ? { 'claude-opus-5': rates } : {} }
  ]
})

test('readUsage: hit% present — gap split into reads + writes, input not reduced twice', () => {
  const u = T.readUsage({ input: 100, prompt: 150, cache_hit_pct: 20, output: 10 })
  assert.equal(u.input, 100)
  assert.equal(u.cacheRead, 30)
  assert.equal(u.cacheWrite, 20)
  assert.equal(u.input + u.cacheRead + u.cacheWrite, 150)
  assert.equal(u.cacheEstimated, true)
})

test('readUsage: no hit% — gap remains an uncertain split', () => {
  const u = T.readUsage({ input: 100, prompt: 150, output: 1 })
  assert.deepEqual([u.input, u.cacheRead, u.cacheWrite, u.cacheUnknown, u.cacheEstimated],
    [100, 0, 0, 50, false])
  assert.equal(u.cacheReadEvidence, 'unknown')
  assert.equal(u.cacheWriteEvidence, 'unknown')
})

test('readUsage: raw cache fields win and are exact', () => {
  const u = T.readUsage({ input: 100, prompt: 160, cache_read: 40, cache_write: 20, cache_hit_pct: 99 })
  assert.deepEqual([u.input, u.cacheRead, u.cacheWrite, u.cacheEstimated], [100, 40, 20, false])
})

test('readUsage: input fell back to prompt — split by hit%', () => {
  const u = T.readUsage({ input: 200, prompt: 200, cache_hit_pct: 50 })
  assert.deepEqual([u.input, u.cacheRead, u.cacheWrite, u.cacheUnknown], [0, 100, 0, 100])
  assert.equal(u.cacheEstimated, true)
})

test('readUsage: plain usage, junk hit%', () => {
  const u = T.readUsage({ input: 10, output: 5, cache_hit_pct: 'x' })
  assert.deepEqual([u.input, u.output, u.cacheRead, u.cacheWrite], [10, 5, 0, 0])
})

test('cache provenance separates explicit evidence, estimates and ambiguous zeroes', () => {
  const ambiguous = T.readUsage({ input: 100, prompt: 100, cache_read: 0, cache_write: 0 })
  assert.equal(ambiguous.cacheSource, 'unknown')
  assert.equal(T.hitPctOf(ambiguous), null)
  const confirmed = T.readUsage({ input: 100, prompt: 100, cache_read: 0, cache_write: 0, cache_provenance: 'exact' })
  assert.equal(T.hitPctOf(confirmed), 0)
  const estimated = T.readUsage({ input: 50, prompt: 100, cache_hit_pct: 40 })
  assert.equal(estimated.cacheSource, 'estimated')
  assert.equal(T.hitPctOf(estimated), 40)
  assert.equal(T.cacheCoverage(estimated), 1)
  assert.match(T.cacheCoverageDetail(estimated, (key, ...args) => T.I18N.en[key](...args)), /0% exact · 100% estimated/)
  assert.equal(T.hitPctOf({ input: 100, cacheRead: 0, cacheWrite: 0 }), null, 'legacy is ambiguous')
})

test('cumulative cache split evidence requires both snapshots to support the delta', () => {
  const model = 'm', provider = 'p'
  const payload = { model, provider, providers: [{ slug: provider, pricing: {
    m: { input: '2', output: '4', cache: '.5', cache_write: '3', tiers: [] }
  } }] }
  const fold = (ledger, sessionId, usage, now) => T.applyUsage(ledger, {
    now, sessionId, storedId: 'conv', provider, payload, usage: { model, output: 0, ...usage }
  })

  let ambiguous = fold(T.emptyLedger(), 'ambiguous', { input: 60, prompt: 100, calls: 1 }, NOW)
  ambiguous = fold(ambiguous, 'ambiguous', {
    input: 120, prompt: 200, cache_read: 40, cache_write: 40, calls: 2
  }, NOW + 1)
  const ambiguousBucket = Object.values(ambiguous.days[T.dayKey(NOW)])[0]
  assert.equal(ambiguousBucket.cacheRead, 0)
  assert.equal(ambiguousBucket.cacheWrite, 0)
  assert.equal(ambiguousBucket.cacheUnknown, 80,
    'the delta keeps the forty cached tokens unclassified, alongside the prior forty')
  assert.equal(ambiguousBucket.cacheReadEvidence, 'unknown')
  assert.equal(ambiguousBucket.cacheWriteEvidence, 'unknown')
  assert.equal(ambiguous.snapshots.ambiguous.cacheReadEvidence, 'reported',
    'the latest cumulative snapshot can be reported without labelling the derived delta reported')

  let reported = fold(T.emptyLedger(), 'reported', {
    input: 60, prompt: 100, cache_read: 30, cache_write: 10, calls: 1
  }, NOW)
  reported = fold(reported, 'reported', {
    input: 120, prompt: 200, cache_read: 60, cache_write: 20, calls: 2
  }, NOW + 1)
  const reportedBucket = Object.values(reported.days[T.dayKey(NOW)])[0]
  assert.deepEqual([reportedBucket.input, reportedBucket.cacheRead, reportedBucket.cacheWrite], [120, 60, 20],
    'both monotonic reported snapshots contribute exactly their per-stream deltas')
  assert.equal(reportedBucket.cacheReadEvidence, 'reported')
  assert.equal(reportedBucket.cacheWriteEvidence, 'reported')
})

test('pre-upgrade aggregate evidence stays mixed after new reported cache counters', () => {
  const model = 'm', provider = 'p'
  const payload = { model, provider, providers: [{ slug: provider, pricing: {
    m: { input: '2', output: '4', cache: '.5', cache_write: '3', tiers: [] }
  } }] }
  let ledger = T.applyUsage(T.emptyLedger(), { now: NOW, sessionId: 'old-runtime', storedId: 'conv', provider, payload,
    usage: { model, input: 100, prompt: 1300, output: 0, calls: 1, cache_hit_pct: 15 } })
  const key = JSON.stringify(['', provider, model, 0])
  const day = T.dayKey(NOW)
  const withoutEvidence = bucket => {
    const { cacheReadEvidence, cacheWriteEvidence, ...legacy } = bucket
    return legacy
  }
  ledger = {
    ...ledger,
    days: { ...ledger.days, [day]: { ...ledger.days[day], [key]: withoutEvidence(ledger.days[day][key]) } },
    sessions: { ...ledger.sessions, conv: withoutEvidence(ledger.sessions.conv) }
  }
  ledger = T.applyUsage(ledger, { now: NOW + 1, sessionId: 'new-runtime', storedId: 'conv', provider, payload,
    usage: { model, input: 100, prompt: 1300, output: 0, cache_read: 200, cache_write: 1000, calls: 1 } })

  const dayBucket = ledger.days[day][key]
  assert.equal(dayBucket.cacheReadEvidence, 'partial')
  assert.equal(dayBucket.cacheWriteEvidence, 'partial', 'older derived writes are not relabelled reported')
  assert.equal(ledger.sessions.conv.cacheReadEvidence, 'partial')
  assert.equal(ledger.sessions.conv.cacheWriteEvidence, 'partial')
  const row = T.ledgerCsv(ledger).trim().split('\r\n')[1].split(',')
  assert.deepEqual(row.slice(19, 21), ['partial', 'partial'])
})

test('net savings include write premiums and require prices for used buckets', () => {
  const rates = { input: 2, output: 4, cache: .5, write: 3, inputKnown: true, outputKnown: true, cacheKnown: true }
  assert.equal(T.cacheSavings(200, rates, 1000), -.0007)
  assert.equal(T.cacheSavings(200, { ...rates, write: null }, 1000), null)
  assert.equal(T.cacheSavings(200, { ...rates, cacheKnown: false }, 0), null)
  assert.equal(T.cacheSavings(200, { ...rates, outputKnown: false }, 0), null)
  assert.equal(T.cacheSavings(200, { ...rates, inputKnown: false }, 0), null)
})

test('conversation and filtered ledger use the same weighted covered prompt rate', () => {
  let led = T.emptyLedger()
  const usage = { model: 'm', input: 100, prompt: 400, output: 50,
    cache_read: 200, cache_write: 100, calls: 1 }
  led = T.applyUsage(led, { now: NOW, sessionId: 's', storedId: 'conv', provider: 'p', usage })
  const conversation = led.sessions.conv
  const selected = T.summarize(led, () => true, null)
  assert.equal(T.hitPctOf(conversation), 50)
  assert.equal(selected.totals.hitPct, 50)
  assert.equal(T.cacheCoverage(conversation), 1)
  assert.match(T.cacheCoverageDetail(conversation, (key, ...args) => T.I18N.en[key](...args)), /100% exact · 0% estimated/)
  assert.equal(selected.totals.cacheCoverage, 1)
  assert.equal(selected.totals.netSavings, null, 'unknown write rate cannot invent savings')
  assert.equal(T.summarize(led, () => false, null).totals.hitPct, null)
})

test('an ambiguous cold start stays unavailable when derived cumulative splits cannot be differenced', () => {
  let led = T.emptyLedger()
  const opts = { now: NOW, sessionId: 'cold-start', storedId: 'conv', provider: 'p' }
  led = T.applyUsage(led, { ...opts, usage: { model: 'm', input: 100, prompt: 100, output: 10, calls: 1 } })
  assert.equal(T.hitPctOf(led.sessions.conv), null)
  assert.equal(T.cacheCoverage(led.sessions.conv), null,
    'an ambiguous split does not become measured 0% coverage')
  led = T.applyUsage(led, { ...opts, now: NOW + 1, usage: { model: 'm', input: 200, prompt: 300, output: 20, cache_hit_pct: 33, calls: 2 } })
  led = T.applyUsage(led, { ...opts, now: NOW + 2, usage: { model: 'm', input: 250, prompt: 400, output: 30, cache_hit_pct: 38, calls: 3 } })
  assert.equal(led.sessions.conv.calls, 3)
  assert.equal(T.cacheCoverage(led.sessions.conv), null,
    'the cumulative derived cache split is not presented as priced coverage when its writes move backwards')
  assert.equal(led.sessions.conv.cacheUnknown, 150)
  assert.equal(led.sessions.conv.cacheEstimated, false,
    'unclassified cumulative estimates are not promoted into historical measured evidence')
  assert.equal(led.snapshots['cold-start'].cacheReadEvidence, 'estimated')
  assert.equal(led.snapshots['cold-start'].cacheWriteEvidence, 'derived')
})

test('settled conversation net savings include the cache-write premium', () => {
  const payload = { model: 'm', provider: 'p', providers: [{ slug: 'p', pricing: {
    m: { input: '2', output: '4', cache: '.5', cache_write: '3', tiers: [] }
  } }] }
  const led = T.applyUsage(T.emptyLedger(), { now: NOW, sessionId: 's', storedId: 'conv', provider: 'p', payload,
    usage: { model: 'm', input: 100, prompt: 1300, output: 10, cache_read: 200, cache_write: 1000, calls: 1 } })
  const conversation = led.sessions.conv
  assert.equal(conversation.netSavings, -.0007)
  assert.equal(conversation.netSavingsPrompt, 1300)
  assert.equal(T.summarize(led, () => true, null).totals.netSavings, -.0007)
  assert.equal(T.hitPctOf(conversation), 200 / 1300 * 100)
})

test('a call with unavailable token counts remains in the conversation', () => {
  const led = T.applyUsage(T.emptyLedger(), { now: NOW, sessionId: 'empty', storedId: 'conv',
    usage: { model: 'm', input: 0, output: 0, calls: 1 } })
  assert.equal(led.sessions.conv.calls, 1)
  assert.equal(T.hitPctOf(led.sessions.conv), null)
})

test('unknown-model first frame remains separate and keeps its tokens', () => {
  let led = T.emptyLedger()
  led = T.applyUsage(led, { now: NOW, sessionId: 'cold', storedId: 'conv', provider: '',
    usage: { input: 100, prompt: 100, output: 10, calls: 1 } })
  led = T.applyUsage(led, { now: NOW + 1, sessionId: 'cold', storedId: 'conv', provider: 'p',
    usage: { model: 'model-a', input: 150, prompt: 250, output: 20, calls: 2, cache_read: 100, cache_write: 0 } })
  const rows = T.summarize(led, () => true, null).rows
  assert.equal(rows.find(r => r.model === '(unknown)').input, 100)
  assert.equal(rows.find(r => r.model === 'model-a').input, 50)
  assert.equal(led.sessions.conv.calls, 2)
})

test('resolveRates: own provider wins over a foreign row with the same model', () => {
  const r = T.resolveRates({ model: 'claude-opus-5', provider: 'github-copilot', payload: copilotPayload({ input: '$5', output: '$25', cache: '$0.5' }) })
  assert.equal(r.origin, 'live')
  assert.deepEqual(r.rates, { input: 5, output: 25, cache: 0.5, write: null, inputKnown: false,
    outputKnown: true, cacheKnown: true, writeKnown: false, hasTiers: false, tierDetailsKnown: true,
    tiers: [], cacheWriteRates: [], usagePricingVersion: 2, usageTierKnown: false, usageInputKnown: true,
    usageOutputKnown: true, usageCacheKnown: true, usageWriteKnown: false, usagePriceSource: 'live_catalogue' })
})

test('resolveRates: empty own catalog -> bundled table of the same provider, not nous', () => {
  const r = T.resolveRates({ model: 'claude-opus-5', provider: 'github-copilot', payload: copilotPayload(null) })
  assert.equal(r.origin, 'bundled')
  assert.equal(r.rates.input, 5)
})

test('resolveRates: remembered rates are scoped by provider', () => {
  const remembered = { 'github-copilot|m': { input: 1, output: 2, cache: 0.1 } }
  assert.equal(T.resolveRates({ model: 'm', provider: 'github-copilot', remembered }).origin, 'remembered')
  assert.equal(T.resolveRates({ model: 'm', provider: 'openai', remembered }).origin, 'none')
})

test('resolveRates: exact provider first, then a labelled deterministic fallback', () => {
  // No exact route: still priced for public coverage, but explicitly labelled.
  const r = T.resolveRates({ model: 'claude-opus-5', provider: '', payload: null })
  assert.equal(r.origin, 'fallback')
  assert.ok(r.rates && r.rates.input >= 0)
  assert.ok(r.foreignSlug, 'the fallback source is named, never silent')
  assert.equal(r.providerUnknown, true)

  const foreignOnly = T.resolveRates({ model: 'claude-opus-5', provider: 'openai', payload: null })
  assert.equal(foreignOnly.origin, 'fallback')
  assert.equal(foreignOnly.foreignSlug, 'openrouter', 'first hit in fixed priority order, not payload order')
  assert.equal(T.bundledLookup('claude-opus-5', 'openai'), null, 'own-provider lookup stays strict')

  // The same route resolves to the same fallback every time.
  assert.equal(T.resolveRates({ model: 'claude-opus-5', provider: 'openai', payload: null }).foreignSlug, 'openrouter')

  // Nothing anywhere: honestly unpriced.
  const nowhere = T.resolveRates({ model: 'no-such-model-zz', provider: 'commandcode', payload: null })
  assert.equal(nowhere.origin, 'none')
  assert.equal(nowhere.rates, null)
})

test('legacy rows stay unpriced unless their own route was remembered', () => {
  const pricer = T.legacyPricer(null, {})
  assert.equal(pricer('claude-opus-5').origin, 'none')
  assert.equal(pricer('claude-opus-5').rates, null)
  const remembered = T.legacyPricer(null, { 'claude-opus-5': { input: 1, output: 2, cache: 0.1 } })
  assert.equal(remembered('claude-opus-5').origin, 'remembered')
})

test('applyUsage: deltas, settlement at record time, no-op on repeat', () => {
  const payload = copilotPayload({ input: '$5', output: '$25', cache: '$0.5' })
  let led = T.emptyLedger()
  const args = { now: NOW, payload, profile: 'p', provider: 'github-copilot', sessionId: 's1' }
  led = T.applyUsage(led, { ...args, usage: { model: 'claude-opus-5', input: 1_000_000, output: 0, calls: 1 } })
  const same = T.applyUsage(led, { ...args, usage: { model: 'claude-opus-5', input: 1_000_000, output: 0, calls: 1 } })
  assert.equal(same, led)
  led = T.applyUsage(led, { ...args, usage: { model: 'claude-opus-5', input: 1_000_000, output: 1_000_000, calls: 2 } })
  const s = T.summarize(led, () => true, null)
  assert.equal(s.rows.length, 1)
  assert.equal(s.rows[0].cost, 30)
  assert.equal(s.rows[0].calls, 2)
  assert.equal(s.rows[0].provider, 'github-copilot')

  // Catalog price change later must NOT move the settled total.
  const cheaper = copilotPayload({ input: '$1', output: '$1', cache: '$0.1' })
  const s2 = T.summarize(led, () => true, T.legacyPricer(cheaper, {}))
  assert.equal(s2.totals.cost, 30)
})

test('applyUsage: counter reset adopts the new run whole', () => {
  const payload = copilotPayload({ input: '$1', output: '$1', cache: '$1' })
  const args = { now: NOW, payload, provider: 'github-copilot', sessionId: 's' }
  let led = T.applyUsage(T.emptyLedger(), { ...args, usage: { model: 'claude-opus-5', input: 500, calls: 3 } })
  led = T.applyUsage(led, { ...args, usage: { model: 'claude-opus-5', input: 100, calls: 1 } })
  const r = T.summarize(led, () => true, null).rows[0]
  assert.equal(r.input, 600)
  assert.equal(r.calls, 4)
})

test('applyUsage: rounded cache percentage changes cannot replay cumulative prompt usage', () => {
  const args = { now: NOW, sessionId: 'rounded', storedId: 'conversation' }
  let led = T.applyUsage(T.emptyLedger(), { ...args, usage: {
    model: 'm', input: 1000, prompt: 1000, output: 0, calls: 1, cache_hit_pct: 50
  } })
  led = T.applyUsage(led, { ...args, now: NOW + 1, usage: {
    model: 'm', input: 1003, prompt: 1003, output: 0, calls: 1, cache_hit_pct: 51
  } })
  const session = led.sessions.conversation
  assert.equal(session.input + session.cacheRead + session.cacheWrite + session.cacheUnknown, 1003)
  assert.equal(session.cacheRead, 500,
    'a rounded read increase larger than the new prompt delta is not forced into the read stream')
  assert.equal(session.cacheUnknown, 503,
    'the ambiguous new prompt tokens remain accounted for but unclassified')
  assert.equal(session.calls, 1)
  assert.equal(led.snapshots.rounded.counterPrompt, 1003)
})

test('applyUsage: missing gateway counters carry forward without losing later deltas', () => {
  const args = { now: NOW, sessionId: 'missing', storedId: 'conversation' }
  let led = T.applyUsage(T.emptyLedger(), { ...args, usage: {
    model: 'm', input: 100, prompt: 100, output: 10, calls: 4
  } })
  led = T.applyUsage(led, { ...args, now: NOW + 1, usage: { model: 'm', output: 15 } })
  assert.deepEqual(
    [led.sessions.conversation.input, led.sessions.conversation.output, led.sessions.conversation.calls],
    [100, 15, 4]
  )
  led = T.applyUsage(led, { ...args, now: NOW + 2, usage: {
    model: 'm', input: 130, prompt: 130, output: 15
  } })
  assert.deepEqual(
    [led.sessions.conversation.input, led.sessions.conversation.output, led.sessions.conversation.calls],
    [130, 15, 4]
  )
})

test('applyUsage: existing v2 snapshots continue from stored totals without replaying history', () => {
  const args = { now: NOW, sessionId: 'legacy-snapshot', storedId: 'conversation' }
  const original = T.applyUsage(T.emptyLedger(), { ...args, usage: {
    model: 'm', input: 1000, prompt: 1000, output: 10, calls: 2, cache_hit_pct: 50
  } })
  const oldSnapshot = { ...original.snapshots['legacy-snapshot'] }
  for (const field of ['counterPrompt', 'counterPromptSource', 'counterInput', 'counterOutput', 'counterCalls']) delete oldSnapshot[field]
  const stored = { ...original, snapshots: { 'legacy-snapshot': oldSnapshot } }
  const { ledger, migrated } = T.readStoredLedger({ get: (key, fallback) => key === 'ledger.v2' ? stored : fallback }, NOW)
  assert.equal(migrated, false)
  const before = { ...ledger.sessions.conversation }
  const updated = T.applyUsage(ledger, { ...args, now: NOW + 1, usage: {
    model: 'm', input: 1003, prompt: 1003, output: 12, calls: 3, cache_hit_pct: 51
  } })
  assert.equal(updated.sessions.conversation.input + updated.sessions.conversation.cacheRead +
    updated.sessions.conversation.cacheWrite + updated.sessions.conversation.cacheUnknown, 1003)
  assert.equal(updated.sessions.conversation.output, before.output + 2)
  assert.equal(updated.sessions.conversation.calls, before.calls + 1)
  assert.equal(ledger.sessions.conversation.input + ledger.sessions.conversation.cacheRead +
    ledger.sessions.conversation.cacheWrite + ledger.sessions.conversation.cacheUnknown, 1000)
})

test('applyUsage: input-to-prompt counter switch includes stored cache counters', () => {
  const payload = copilotPayload({ input: '$5', output: '$25', cache: '$0.5' })
  for (const [cacheRead, cacheWrite] of [[20, 0], [0, 25]]) {
    for (const legacy of [false, true]) {
      const sessionId = `counter-switch-${cacheRead}-${cacheWrite}-${legacy}`
      const storedId = sessionId
      const args = { now: NOW, payload, provider: 'github-copilot', sessionId, storedId }
      let led = T.applyUsage(T.emptyLedger(), { ...args, usage: {
        model: 'claude-opus-5', input: 100, output: 10, calls: 3,
        cache_read: cacheRead, cache_write: cacheWrite, cache_provenance: 'exact'
      } })

      if (legacy) {
        const oldSnapshot = { ...led.snapshots[sessionId] }
        for (const field of ['counterPrompt', 'counterPromptSource', 'counterInput', 'counterFreshInput', 'counterOutput', 'counterCalls']) {
          delete oldSnapshot[field]
        }
        const stored = { ...led, snapshots: { [sessionId]: oldSnapshot } }
        led = T.readStoredLedger({ get: (key, fallback) => key === 'ledger.v2' ? stored : fallback }, NOW).ledger
      }

      led = T.applyUsage(led, { ...args, now: NOW + 1, usage: {
        model: 'claude-opus-5', input: 130, prompt: 160, output: 15, calls: 4,
        cache_read: cacheRead ? 25 : 5, cache_write: cacheWrite || 5, cache_provenance: 'exact'
      } })

      const session = led.sessions[storedId]
      const expectedCost = cacheRead ? 0.0010625 : 0.0011525
      assert.equal(session.input + session.cacheRead + session.cacheWrite, 160)
      assert.equal(session.output, 15)
      assert.equal(session.calls, 4)
      assert.ok(Math.abs(session.cost - expectedCost) < 1e-15)
      assert.equal(session.cacheCoveredPrompt, 160)
      assert.equal(session.cacheExactPrompt, 160)
      assert.equal(T.cacheCoverage(session), 1)
    }
  }
})

test('applyUsage: same model on two providers stays in separate buckets', () => {
  let led = T.emptyLedger()
  led = T.applyUsage(led, { now: NOW, provider: 'github-copilot', sessionId: 'a', usage: { model: 'claude-opus-5', input: 10 } })
  led = T.applyUsage(led, { now: NOW, provider: 'anthropic', sessionId: 'b', usage: { model: 'claude-opus-5', input: 10 } })
  assert.equal(T.summarize(led, () => true, null).rows.length, 2)
})

test('applyUsage: unpriced tokens tracked, not silently zero', () => {
  const led = T.applyUsage(T.emptyLedger(), { now: NOW, provider: 'x', sessionId: 's', usage: { model: 'no-such-model-zz', input: 42 } })
  const s = T.summarize(led, () => true, null)
  assert.equal(s.totals.unpricedTokens, 42)
  assert.equal(s.totals.known, false)
  assert.equal(s.rows[0].cost, null)
})

test('applyUsage: an unpriced zero-token call stays visible as incomplete evidence', () => {
  const led = T.applyUsage(T.emptyLedger(), { now: NOW, provider: 'x', sessionId: 's', usage: {
    model: 'no-such-model-zz', input: 0, output: 0, calls: 1
  } })
  const s = T.summarize(led, () => true, null)
  assert.equal(s.rows[0].calls, 1)
  assert.equal(s.rows[0].unpricedTokens, 0)
  assert.equal(s.rows[0].unpricedCalls, 1)
  assert.equal(s.rows[0].missingUsageCalls, 0, 'confirmed zero usage is not missing usage')
  assert.equal(s.totals.unpricedCalls, 1)
  assert.equal(s.rows[0].cost, null)
  assert.equal(s.totals.known, false)
})

test('applyUsage: a known-rate call with missing usage stays partial until its cumulative update resolves', () => {
  const args = { now: NOW, provider: 'github-copilot', sessionId: 'usage-gap', storedId: 'conversation',
    payload: copilotPayload({ input: '$9', output: '$9', cache: '$9', tiers: [] }) }
  let led = T.applyUsage(T.emptyLedger(), { ...args, usage: {
    model: 'claude-opus-5', input: 100, prompt: 100, output: 0, calls: 1
  } })
  const firstCost = T.summarize(led, () => true, null).rows[0].cost
  assert.ok(firstCost > 0, 'the fixture has known rates for the priced subtotal')

  led = T.applyUsage(led, { ...args, now: NOW + 1, usage: { model: 'claude-opus-5', calls: 2 } })
  led = T.applyUsage(led, { ...args, now: NOW + 2, usage: { model: 'claude-opus-5', calls: 3 } })
  let summary = T.summarize(led, () => true, null)
  assert.equal(summary.rows[0].cost, firstCost, 'keep the known subtotal')
  assert.equal(summary.rows[0].unpricedCalls, 0, 'rate evidence is not the missing evidence')
  assert.equal(summary.rows[0].missingUsageCalls, 2)
  assert.equal(summary.totals.missingUsageCalls, 2)

  // The newest call's delayed cumulative counters arrive without a call-count
  // increment. Resolve only that pending call; the earlier gap stays open.
  led = T.applyUsage(led, { ...args, now: NOW + 3, usage: {
    model: 'claude-opus-5', input: 150, prompt: 150, output: 0, calls: 3
  } })
  summary = T.summarize(led, () => true, null)
  assert.equal(summary.rows[0].missingUsageCalls, 1)
  assert.equal(summary.totals.missingUsageCalls, 1)
  assert.equal(summary.rows[0].coverageUnknown, false)
  assert.ok(summary.rows[0].cost > firstCost, 'the newly reported tokens are priced once')
  assert.equal(led.sessions.conversation.missingUsageCalls, 1)
  assert.equal(led.snapshots['usage-gap'].guardrail.usageValueMissingCalls, 1)
  assert.equal(led.snapshots['usage-gap'].guardrail.pendingUsageCall, null)
})

test('summarize marks absent or partially present call-coverage counters as unknown', () => {
  for (const bucket of [{}, { missingUsageCalls: 0 }]) {
    const summary = T.summarize(coverageLedger(bucket), () => true, null)
    assert.equal(summary.rows[0].coverageUnknown, true)
    assert.equal(summary.totals.coverageUnknown, true)
  }
})

test('summarize treats recorded zero call-coverage counters as complete', () => {
  const summary = T.summarize(coverageLedger({ unpricedCalls: 0, missingUsageCalls: 0 }), () => true, null)
  assert.equal(summary.rows[0].coverageUnknown, false)
  assert.equal(summary.totals.coverageUnknown, false)
})

test('summarize keeps null cost unknown and still reprices legacy buckets', () => {
  const missingCost = T.summarize(coverageLedger({ cost: null }), () => true, null)
  assert.equal(missingCost.rows[0].cost, null)
  assert.equal(missingCost.totals.known, false)

  const mixedLedger = coverageLedger({ cost: null })
  const [key] = Object.keys(mixedLedger.days[T.dayKey(NOW)])
  mixedLedger.days['2026-10-22'] = {
    [key]: { ...mixedLedger.days[T.dayKey(NOW)][key], cost: 0.25 }
  }
  const mixed = T.summarize(mixedLedger, () => true, null)
  assert.equal(mixed.rows[0].cost, 0.25, 'a null bucket does not erase a known subtotal')
  assert.equal(mixed.totals.known, true)

  const legacyLedger = coverageLedger({
    cost: null, legacy: true, input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0,
    calls: 1, pricedTokens: 1_000_000, unpricedTokens: 0
  })
  const legacy = T.summarize(legacyLedger, () => true,
    T.legacyPricer(null, { 'model-x': { input: 2, output: 4, cache: 0.5 } }))
  assert.equal(legacy.rows[0].cost, 2, 'a null settled cost must not suppress remembered legacy pricing')
  assert.equal(legacy.rows[0].legacy, true)
})

test('summarize preserves numeric zero and negative settled costs', () => {
  for (const cost of [0, -0.25]) {
    const summary = T.summarize(coverageLedger({ cost }), () => true, null)
    assert.equal(summary.rows[0].cost, cost)
    assert.equal(summary.totals.known, true)
  }
})

test('coverage uncertainty survives a new write into a partially covered old bucket', () => {
  const legacy = coverageLedger({ missingUsageCalls: 0 })
  const updated = T.applyUsage(legacy, {
    now: NOW, profile: 'work', provider: 'provider-x', sessionId: 'after-upgrade', storedId: 'conversation',
    usage: { model: 'model-x', input: 10, calls: 1 }
  })
  const bucket = Object.values(updated.days[T.dayKey(NOW)])[0]
  assert.equal(bucket.coverageUnknown, true)
  assert.equal(typeof bucket.unpricedCalls, 'number', 'the new write adds its own evidence counter')
  assert.equal(T.summarize(updated, () => true, null).totals.coverageUnknown, true)
  assert.equal(updated.sessions.conversation.coverageUnknown, true, 'conversation history retains the uncertainty too')
})

test('applyUsage: explicit zero counters with known rates are confirmed usage, not a pending gap', () => {
  const led = T.applyUsage(T.emptyLedger(), {
    now: NOW, provider: 'github-copilot', sessionId: 'confirmed-zero',
    payload: copilotPayload({ input: '$9', output: '$9', cache: '$9', tiers: [] }),
    usage: { model: 'claude-opus-5', input: 0, prompt: 0, output: 0, calls: 1 }
  })
  const summary = T.summarize(led, () => true, null)
  assert.equal(summary.rows[0].missingUsageCalls, 0)
  assert.equal(summary.totals.missingUsageCalls, 0)
  assert.equal(led.snapshots['confirmed-zero'].guardrail.pendingUsageCall, null)
  assert.equal(led.snapshots['confirmed-zero'].guardrail.usageValueMissingCalls, 0)
})

test('applyUsage: gateway cost_usd preferred and diffed', () => {
  const args = { now: NOW, provider: 'openrouter', sessionId: 's' }
  let led = T.applyUsage(T.emptyLedger(), { ...args, usage: { model: 'm', input: 10, cost_usd: 0.5 } })
  led = T.applyUsage(led, { ...args, usage: { model: 'm', input: 20, cost_usd: 0.75 } })
  const r = T.summarize(led, () => true, null).rows[0]
  assert.equal(r.cost, 0.75)
  assert.equal(r.sources.gateway, 20)
})

test('retention is by calendar date (400 days), not by count', () => {
  let led = T.emptyLedger()
  const old = new Date(2025, 0, 1).getTime()
  led = T.applyUsage(led, { now: old, provider: 'p', sessionId: 'o', usage: { model: 'm', input: 1 } })
  led = T.applyUsage(led, { now: NOW, provider: 'p', sessionId: 'n', usage: { model: 'm', input: 1 } })
  assert.deepEqual(Object.keys(led.days), [T.dayKey(NOW)])
  // 121 distinct recent days all survive (v1 capped at 120).
  let l2 = T.emptyLedger()
  for (let i = 0; i < 121; i++) {
    const at = new Date(2026, 9, 21 - i, 12).getTime()
    l2 = T.applyUsage(l2, { now: NOW, provider: 'p', sessionId: `s${i}`, usage: { model: 'm', input: 1 } })
    l2 = T.applyUsage(l2, { now: at, provider: 'p', sessionId: `t${i}`, usage: { model: 'm', input: 1 } })
  }
  assert.equal(Object.keys(l2.days).length, 121)
  assert.equal(l2.since, T.daysAgoKey(120, NOW))
})

test('v1 migration keeps tokens, marks them legacy, never fakes a settled cost', () => {
  const v1 = {
    v: 1,
    days: { '2026-10-01': { 'claude-opus-5': { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, calls: 1 } } },
    rates: { 'claude-opus-5': { input: 5, output: 25, cache: 0.5 } },
    snapshots: { 's::claude-opus-5': { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, calls: 1 } }
  }
  const store = { get: (k, d) => (k === 'ledger.v1' ? v1 : d) }
  const { ledger, migrated } = T.readStoredLedger(store, NOW)
  assert.equal(migrated, true)
  assert.equal(ledger.v, 2)
  const s = T.summarize(ledger, () => true, T.legacyPricer(null, ledger.legacyRates))
  assert.equal(s.rows[0].legacy, true)
  assert.equal(s.rows[0].cost, 5)
  assert.equal(s.totals.legacyTokens, 1_000_000)
  assert.equal(s.rows[0].coverageUnknown, true)
  assert.equal(s.totals.coverageUnknown, true)
  assert.equal(T.ledgerCsv(ledger).trim().split('\r\n')[1].split(',')[18], 'yes')
  // Continuing the same session after upgrade must not double count.
  const next = T.applyUsage(ledger, { now: NOW, provider: 'github-copilot', sessionId: 's', usage: { model: 'claude-opus-5', input: 1_000_000, calls: 1 } })
  assert.equal(next, ledger)
})

test('pre-existing v2 buckets migrated from v1 retain unknown coverage without rewriting', () => {
  const ledger = { ...T.emptyLedger(), days: { '2026-10-01': {
    migrated: { legacy: true, model: 'claude-opus-5', input: 100, output: 50,
      calls: 1, unpricedCalls: 0, missingUsageCalls: 0, coverageUnknown: false }
  } } }
  const summary = T.summarize(ledger, () => true, null)
  assert.equal(summary.rows[0].coverageUnknown, true)
  assert.equal(summary.totals.coverageUnknown, true)
  assert.equal(ledger.days['2026-10-01'].migrated.coverageUnknown, false,
    'reading existing v2 data does not rewrite it')
  assert.equal(T.ledgerCsv(ledger).trim().split('\r\n')[1].split(',')[18], 'yes')
})

test('CSV export: header, settled cost, formula injection neutralised', () => {
  let led = T.applyUsage(T.emptyLedger(), {
    now: NOW,
    payload: copilotPayload({ input: '$5', output: '$25', cache: '$0.5' }),
    profile: '=HYPERLINK("x")',
    provider: 'github-copilot',
    sessionId: 's',
    usage: { model: 'claude-opus-5', input: 1_000_000, calls: 1 }
  })
  const csv = T.ledgerCsv(led).trim().split('\r\n')
  assert.equal(csv.length, 2)
  assert.ok(csv[0].startsWith('date,profile,provider,model'))
  assert.ok(csv[1].includes(`"'=HYPERLINK(""x"")"`))
  assert.ok(csv[1].includes(',5,live,'))
  assert.equal(T.csvCell(-3), '-3')
})

test('CSV keeps gross cache-read savings and adds a separate signed net column', () => {
  const payload = { model: 'm', provider: 'p', providers: [{ slug: 'p', pricing: {
    m: { input: '2', output: '4', cache: '.5', cache_write: '3', tiers: [] }
  } }] }
  const led = T.applyUsage(T.emptyLedger(), { now: NOW, sessionId: 's', storedId: 'conv', provider: 'p', payload,
    usage: { model: 'm', input: 100, prompt: 1300, output: 10, cache_read: 200, cache_write: 1000, calls: 1 } })
  const [header, row] = T.ledgerCsv(led).trim().split('\r\n').map(line => line.split(','))
  assert.equal(header[13], 'cache_saved_usd')
  assert.equal(header[14], 'cache_estimated')
  assert.equal(header[15], 'net_cache_savings_usd')
  assert.equal(Number(row[13]), .0003)
  assert.equal(Number(row[15]), -.0007)
  const unknown = T.applyUsage(T.emptyLedger(), { now: NOW, sessionId: 's', provider: 'p', payload,
    usage: { model: 'm', input: 100, prompt: 100, calls: 1 } })
  const unknownRow = T.ledgerCsv(unknown).trim().split('\r\n')[1].split(',')
  assert.equal(unknownRow[15], '', 'unknown coverage has no net value')
})

test('CSV appends cache provenance without moving historical columns', () => {
  const fields = (model, coverage) => ({
    input: 100, output: 0, cacheRead: 0, cacheWrite: 0, calls: 1, cost: 0.01,
    legacy: false, model, profile: 'work', provider: 'p', pricedTokens: 100, unpricedTokens: 0,
    saved: 0, sources: { live: 100 }, ...coverage
  })
  const led = { days: { '2026-10-21': {
    complete: fields('complete', { unpricedCalls: 0, missingUsageCalls: 0 }),
    gap: fields('gap', { unpricedCalls: 0, missingUsageCalls: 1 }),
    legacy: fields('legacy', {})
  } } }
  const [header, ...rows] = T.ledgerCsv(led).trim().split('\r\n').map(line => line.split(','))
  assert.deepEqual(header.slice(0, 16), [
    'date', 'profile', 'provider', 'model', 'input', 'output', 'cache_read', 'cache_write', 'calls',
    'cost_usd', 'cost_basis', 'priced_tokens', 'unpriced_tokens', 'cache_saved_usd', 'cache_estimated', 'net_cache_savings_usd'
  ])
  assert.deepEqual(header.slice(16), ['unpriced_calls', 'missing_usage_calls', 'coverage_unknown',
    'cache_read_evidence', 'cache_write_evidence', 'cache_unknown_prompt_tokens', 'cache_savings_basis',
    'cache_savings_min_usd', 'cache_savings_max_usd', 'cache_population', 'cache_valuation_source',
    'cache_savings_coverage'])
  assert.equal(header.length, 28)
  const byModel = Object.fromEntries(rows.map(row => [row[3], row]))
  assert.deepEqual(byModel.complete.slice(16), ['0', '0', 'no', 'unknown', 'unknown', '0',
    'unavailable', '', '', 'desktop_local_ledger_unclassified', 'unavailable', 'unavailable'])
  assert.equal(byModel.complete[6], '', 'unknown reads export blank, not measured zero')
  assert.equal(byModel.complete[7], '', 'unknown writes export blank, not measured zero')
  assert.deepEqual(byModel.gap.slice(16), ['0', '1', 'no', 'unknown', 'unknown', '0',
    'unavailable', '', '', 'desktop_local_ledger_unclassified', 'unavailable', 'unavailable'])
  assert.deepEqual(byModel.legacy.slice(16), ['0', '0', 'yes', 'unknown', 'unknown', '0',
    'unavailable', '', '', 'desktop_local_ledger_unclassified', 'unavailable', 'unavailable'])

  const reported = fields('reported', { cacheReadEvidence: 'reported', cacheWriteEvidence: 'reported',
    cacheUnknown: 25, netSavings: -.01, netSavingsPrompt: 75, cacheCoveredPrompt: 75 })
  const reportedLedger = { days: { '2026-10-21': { reported } } }
  const row = T.ledgerCsv(reportedLedger).trim().split('\r\n')[1].split(',')
  assert.equal(row[15], '', 'the historical value column remains limited to complete coverage')
  assert.deepEqual(row.slice(19, 28), ['reported', 'reported', '25', 'partial', '-0.01', '-0.01',
    'desktop_local_ledger_unclassified', 'desktop_local_estimate', 'partial'],
  'the additive fields carry the signed partial subtotal and its scope')
})

test('daysAgoKey is DST-safe local calendar math', () => {
  assert.equal(T.daysAgoKey(1, new Date(2026, 2, 9, 0, 30).getTime()), '2026-03-08')
  assert.equal(T.daysAgoKey(0, NOW), T.dayKey(NOW))
})

test('close returns to the route the ledger was opened from', () => {
  window.location.hash = '#/session/abc'
  T.openLedger()
  assert.equal(window.location.hash, '#/spend-sense')
  T.closeLedger()
  assert.equal(__nav.at(-1), '/session/abc')
})

test('close works when the page was reached via sidebar nav (hashchange)', () => {
  window.location.hash = '#/spend-sense'
  T.onHashChange({ oldURL: 'app://x/index.html#/settings?tab=a' })
  T.closeLedger()
  assert.equal(__nav.at(-1), '/settings?tab=a')
})

test('close never loops back onto the ledger; falls back to new chat', () => {
  assert.equal(T.isLedgerRoute('/spend-sense?x=1'), true)
  assert.equal(T.isLedgerRoute('/spend-senses'), false)
  window.location.hash = '#/spend-sense'
  T.onHashChange({ oldURL: 'app://x/#/spend-sense' })
  T.closeLedger()
  assert.notEqual(__nav.at(-1), '/spend-sense')
})

test('settings-section hashes select Settings, never Costs', () => {
  assert.equal(T.ledgerTabForHash('#settings-billing'), 'settings')
  assert.equal(T.ledgerTabForHash('#settings'), 'settings')
  assert.equal(T.ledgerTabForHash('#about'), 'about')
  assert.equal(T.ledgerTabForHash('#settings-about'), 'about')
  assert.equal(T.ledgerTabForHash('#membership'), 'memberships')
  assert.equal(T.ledgerTabForHash('#billing'), 'costs')
  assert.equal(T.ledgerTabForHash('#costs'), 'costs')
  assert.equal(T.ledgerTabForHash('#usage'), 'usage')
  assert.equal(T.ledgerTabForHash('#reports'), 'reports')
  assert.equal(T.ledgerTabForHash('#news'), 'news')
  assert.equal(T.ledgerTabForHash(''), 'overview')
  assert.equal(T.ledgerTabForHash(null), 'overview')
})

test('per-conversation totals survive a restart (new runtime id, counters reset)', () => {
  let led = T.emptyLedger()
  const u = (input, output, cacheRead, calls) => ({ model: 'gpt-4o', input, output, cache_read: cacheRead, calls, total: input + output + cacheRead })
  led = T.applyUsage(led, { now: 1e12, sessionId: 'run-1', storedId: 'conv-A', usage: u(1000, 200, 500, 2) })
  led = T.applyUsage(led, { now: 1e12 + 1, sessionId: 'run-1', storedId: 'conv-A', usage: u(1500, 300, 900, 3) })
  // app restarted, conversation resumed under a fresh runtime id, counters from 0
  led = T.applyUsage(led, { now: 1e12 + 2, sessionId: 'run-2', storedId: 'conv-A', usage: u(100, 50, 400, 1) })
  const s = led.sessions['conv-A']
  assert.equal(s.input, 1600)
  assert.equal(s.output, 350)
  assert.equal(s.cacheRead, 1300)
  assert.equal(s.calls, 4)
  assert.equal(s.firstAt, 1e12)
  assert.equal(s.lastAt, 1e12 + 2)
  // per-day ledger agrees with the conversation total
  const day = Object.values(Object.values(led.days)[0])[0]
  assert.equal(day.input, s.input)
  assert.ok(Math.abs(day.cost - s.cost) < 1e-12)
})

test('no stored id -> day ledger only, no session entry', () => {
  const led = T.applyUsage(T.emptyLedger(), { sessionId: 'r', usage: { model: 'gpt-4o', input: 10, output: 5, calls: 1 } })
  assert.deepEqual(led.sessions, {})
})

test('ledgers saved before sessions and legacyRates were introduced load with compatibility defaults', () => {
  const store = { get: (k, fallback) => (k === 'ledger.v2'
    ? { v: 2, days: {}, rates: {}, since: null, snapshots: {} }
    : fallback) }
  const { ledger } = T.readStoredLedger(store)
  assert.deepEqual(ledger.sessions, {})
  assert.deepEqual(ledger.legacyRates, {})
})

test('missing storage keys return the supplied Symbol fallback and keep a fresh ledger writable', () => {
  const reads = []
  const loaded = T.readStoredLedger({
    get: (key, fallback) => {
      reads.push({ key, fallback })
      return fallback
    }
  }, NOW)
  assert.deepEqual(reads.map(({ key }) => key), ['ledger.v2', 'ledger.v1'])
  assert.equal(typeof reads[0].fallback, 'symbol')
  assert.equal(reads[0].fallback, reads[1].fallback)
  assert.deepEqual(loaded.diagnostics, {
    sourceVersion: 'none', validationOutcome: 'fresh', recordingStatus: 'active', writeStatus: 'enabled'
  })
})

test('populated historical v2 data loads when only the later optional roots are absent', () => {
  const historical = {
    v: 2,
    days: { '2025-03-01': { prior: {
      cacheRead: 30, cacheWrite: 4, calls: 2, cost: 0.25, input: 100, legacy: false,
      model: 'historical-model', output: 20, profile: 'default', provider: 'provider-x',
      saved: 0, sources: { focused: 2 }, unpricedTokens: 0
    } } },
    rates: {}, since: '2025-03-01', snapshots: {
      'runtime::historical-model': {
        input: 100, output: 20, cacheRead: 30, cacheWrite: 4, calls: 2, at: NOW, costUsd: null
      }
    }
  }
  const loaded = T.readStoredLedger({ get: (key, fallback) => key === 'ledger.v2' ? historical : fallback }, NOW)
  assert.equal(loaded.error, null)
  assert.equal(loaded.diagnostics.validationOutcome, 'valid-v2')
  assert.equal(loaded.ledger.days['2025-03-01'].prior.input, 100)
  assert.deepEqual(loaded.ledger.sessions, {})
  assert.deepEqual(loaded.ledger.legacyRates, {})
})

test('historical v2 optional counters are initialised before priced and unpriced accumulation', () => {
  const day = T.dayKey(NOW)
  const profile = 'work'
  const provider = 'provider-x'
  const pricedModel = 'historical-priced-model'
  const unpricedModel = 'historical-unpriced-model'
  const keyFor = model => JSON.stringify([profile, provider, model, 0])
  const historicalBucket = model => ({
    cacheRead: 0, cacheWrite: 0, calls: 1, cost: 0.25, input: 100, legacy: false,
    model, output: 0, profile, provider, sources: { gateway: 100 }
  })
  const historical = {
    v: 2,
    days: { [day]: {
      [keyFor(pricedModel)]: historicalBucket(pricedModel),
      [keyFor(unpricedModel)]: historicalBucket(unpricedModel)
    } },
    rates: {}, since: day, snapshots: {},
    sessions: {
      'old-priced': { ...historicalBucket(pricedModel), firstAt: NOW - 100, lastAt: NOW - 100 },
      'old-unpriced': { ...historicalBucket(unpricedModel), firstAt: NOW - 100, lastAt: NOW - 100 }
    }
  }
  const loaded = T.readStoredLedger({
    get: (key, fallback) => key === 'ledger.v2' ? historical : fallback
  }, NOW)
  assert.equal(loaded.error, null)

  const pricedPayload = { model: pricedModel, provider, providers: [{
    slug: provider, pricing: { [pricedModel]: {
      input: '$2', output: '$4', cache: '$0.5', cache_write: '$0.5', tiers: []
    } }
  }] }
  let ledger = T.applyUsage(loaded.ledger, {
    now: NOW + 1, payload: pricedPayload, profile, provider,
    sessionId: 'new-priced', storedId: 'old-priced',
    usage: { model: pricedModel, input: 10, cache_read: 5, output: 1, calls: 1 }
  })
  ledger = T.applyUsage(ledger, {
    now: NOW + 2, profile, provider, sessionId: 'new-unpriced', storedId: 'old-unpriced',
    usage: { model: unpricedModel, input: 7, output: 1, calls: 1 }
  })

  const priced = ledger.days[day][keyFor(pricedModel)]
  const unpriced = ledger.days[day][keyFor(unpricedModel)]
  assert.equal(priced.pricedTokens, 16)
  assert.equal(priced.unpricedTokens, 0)
  assert.ok(priced.saved > 0)
  assert.equal(unpriced.pricedTokens, 0)
  assert.equal(unpriced.unpricedTokens, 8)
  assert.equal(unpriced.unpricedCalls, 1)
  assert.equal(unpriced.missingUsageCalls, 0)
  for (const bucket of [priced, unpriced, ledger.sessions['old-priced'], ledger.sessions['old-unpriced']]) {
    for (const field of ['pricedTokens', 'unpricedTokens', 'unpricedCalls', 'missingUsageCalls', 'saved']) {
      assert.ok(Number.isFinite(bucket[field]), 'counter is initialised on historical bucket')
    }
    assert.equal(bucket.coverageUnknown, true, 'missing historical coverage stays explicitly unknown')
  }
  assert.equal(T.normalizeV2(ledger).ok, true)
})

test('ledger v2 validation rejects malformed envelopes and stored numeric fields', () => {
  const valid = T.applyUsage(T.emptyLedger(), {
    now: NOW, sessionId: 'runtime', storedId: 'conversation', provider: 'provider-x',
    usage: { model: 'model-x', input: 10, output: 2, calls: 1 }
  })
  assert.equal(T.normalizeV2(valid).ok, true, 'current ledger writes include fields introduced after the RC')
  assert.equal(valid.snapshots.runtime.guardrail.pendingUsageRef, null)
  const withPendingUsageRef = structuredClone(valid)
  withPendingUsageRef.snapshots.runtime.guardrail.pendingUsageRef = {
    day: T.dayKey(NOW), bucketKey: 'route', sessionId: 'conversation'
  }
  assert.equal(T.normalizeV2(withPendingUsageRef).ok, true,
    'the current pending-usage reference is retained by validation')
  withPendingUsageRef.snapshots.runtime.guardrail.pendingUsageRef.day = 'not-a-day'
  assert.equal(T.normalizeV2(withPendingUsageRef).ok, false)
  const badValues = [
    null,
    [],
    { ...valid, v: 3 },
    (() => { const value = structuredClone(valid); delete value.since; return value })(),
    { ...valid, days: [] },
    (() => {
      const value = structuredClone(valid)
      const day = Object.keys(value.days)[0]
      const bucket = Object.keys(value.days[day])[0]
      value.days[day][bucket].input = '10'
      return value
    })(),
    { ...valid, rates: { route: { input: '1', output: 2, cache: 3 } } },
    (() => {
      const value = structuredClone(valid)
      value.snapshots.runtime.counterInput = '10'
      return value
    })(),
    (() => {
      const value = structuredClone(valid)
      const day = Object.keys(value.days)[0]
      const bucket = Object.keys(value.days[day])[0]
      value.days[day][bucket].pricedTokens = '10'
      return value
    })(),
    (() => {
      const value = structuredClone(valid)
      value.snapshots.runtime.guardrail.usageValueCost = '0'
      return value
    })(),
    { ...valid, sessions: [] },
    (() => {
      const value = structuredClone(valid)
      delete value.sessions.conversation.lastAt
      return value
    })()
  ]
  for (const value of badValues) assert.equal(T.normalizeV2(value).ok, false)

  const compatible = structuredClone(T.emptyLedger())
  delete compatible.sessions
  delete compatible.legacyRates
  const normalized = T.normalizeV2(compatible)
  assert.equal(normalized.ok, true)
  assert.deepEqual(normalized.ledger.sessions, {})
  assert.deepEqual(normalized.ledger.legacyRates, {})
})

test('summary safely accumulates accepted buckets with inherited-property keys', () => {
  const day = '2026-10-21'
  const keys = ['toString', 'constructor', '__proto__']
  const buckets = Object.fromEntries(keys.map((key, index) => [key, {
    cacheRead: 0, cacheWrite: 0, calls: 1, cost: 0.25, input: 10, legacy: false,
    model: 'hostile-key-' + index, output: 1, profile: 'default', provider: 'provider-x',
    sources: { gateway: index + 1 }
  }]))
  const candidate = { ...T.emptyLedger(), days: { [day]: buckets }, since: day }
  const normalized = T.normalizeV2(candidate)
  assert.equal(normalized.ok, true)

  const result = T.summarize(normalized.ledger, () => true, null)
  assert.deepEqual(result.rows.map(row => row.model).sort(),
    ['hostile-key-0', 'hostile-key-1', 'hostile-key-2'])
  assert.deepEqual(result.rows.map(row => row.sources.gateway).sort((a, b) => a - b), [1, 2, 3])
})

test('invalid v2 data blocks v1 fallback and every Desktop ledger write', () => {
  const invalidV2 = { ...T.emptyLedger(), days: null }
  const priorV1 = { v: 1, days: {}, rates: {}, snapshots: {} }
  const invalidV2Snapshot = structuredClone(invalidV2)
  const priorV1Snapshot = structuredClone(priorV1)
  const values = new Map([['ledger.v2', invalidV2], ['ledger.v1', priorV1]])
  const writes = []
  const handlers = new Map()
  plugin.register({
    storage: {
      get: (key, fallback) => values.has(key) ? values.get(key) : fallback,
      set: (key, value) => { writes.push([key, value]); values.set(key, value) },
      remove: key => values.delete(key)
    },
    rest: async () => ({}), os: null,
    i18n: { register() {}, t: key => key },
    register() {}, onDispose() {}, onEvent: (name, handler) => { handlers.set(name, handler); return () => {} },
    setInterval: () => () => {}
  })

  const heldLedger = T.$ledger.get()
  assert.equal(T.$ledgerReadError.get(), true)
  assert.equal(T.$ledgerLoadDiagnostics.get().recordingStatus, 'paused')
  assert.equal(T.$ledgerLoadDiagnostics.get().writeStatus, 'blocked')
  assert.equal(T.saveLedger(T.emptyLedger()), false)
  assert.equal(T.enqueueUsage('runtime', { model: 'model-x', input: 1, calls: 1 }), null)
  handlers.get('message.complete')({
    session_id: 'runtime', payload: { usage: { model: 'model-x', input: 1, calls: 1 } }
  })
  assert.equal(T.$ledger.get(), heldLedger)
  assert.deepEqual(values.get('ledger.v2'), invalidV2Snapshot)
  assert.deepEqual(values.get('ledger.v1'), priorV1Snapshot)
  assert.deepEqual(writes, [])
  T.$ledgerReadError.set(false)
})

test('malformed Desktop ledger keeps the view switch available for backend Settings', () => {
  const loaded = T.readStoredLedger({
    get: (key, fallback) => key === 'ledger.v2'
      ? { ...T.emptyLedger(), days: null }
      : fallback
  }, NOW)
  assert.equal(loaded.error, 'invalid-v2')

  const previous = {
    ledger: T.$ledger.get(),
    readError: T.$ledgerReadError.get(),
    view: T.$view.get(),
    tab: T.$ledgerTab.get()
  }
  try {
    T.$ledger.set(loaded.ledger)
    T.$ledgerReadError.set(true)
    T.$view.set('desktop')
    T.$ledgerTab.set('settings')

    const desktopPage = T.LedgerPage()
    const productTree = desktopPage.type(desktopPage.props)
    const toggle = findElement(productTree, element =>
      typeof element.type === 'function' && element.type.name === 'ViewToggle')
    assert.ok(toggle, 'the paused local view retains the All Hermes switch')
    const control = toggle.type(toggle.props)
    assert.ok(control.props.options.some(option => option.id === 'all'))
    control.props.onChange('all')
    assert.equal(T.$view.get(), 'all')

    const settingsPage = T.LedgerPage()
    assert.equal(settingsPage.type.name, 'SettingsPage',
      'switching views while Settings is selected reaches backend settings')
  } finally {
    T.$ledger.set(previous.ledger)
    T.$ledgerReadError.set(previous.readError)
    T.$view.set(previous.view)
    T.$ledgerTab.set(previous.tab)
  }
})

test('v1 migration writes the compatible v2 value and retains the original v1 data', () => {
  const priorV1 = {
    v: 1, days: { '2026-10-01': { model: { input: 20, output: 5, cacheRead: 0, cacheWrite: 0, calls: 1 } } },
    rates: {}, snapshots: {}
  }
  const priorV1Snapshot = structuredClone(priorV1)
  const values = new Map([['ledger.v1', priorV1]])
  const writes = []
  plugin.register({
    storage: {
      get: (key, fallback) => values.has(key) ? values.get(key) : fallback,
      set: (key, value) => { writes.push([key, value]); values.set(key, value) },
      remove: key => values.delete(key)
    },
    rest: async () => ({}), os: null,
    i18n: { register() {}, t: key => key },
    register() {}, onDispose() {}, onEvent() {}, setInterval: () => () => {}
  })
  assert.equal(T.$ledgerReadError.get(), false)
  assert.deepEqual(writes.map(([key]) => key), ['ledger.v2'])
  assert.equal(T.normalizeV2(values.get('ledger.v2')).ok, true)
  assert.deepEqual(values.get('ledger.v1'), priorV1Snapshot)
})

test('ledger diagnostics report a failed persistence write without hiding the recording state', () => {
  plugin.register({
    storage: { get: (_key, fallback) => fallback, set: () => { throw new Error('write failed') }, remove() {} },
    rest: async () => ({}), os: null,
    i18n: { register() {}, t: key => key },
    register() {}, onDispose() {}, onEvent() {}, setInterval: () => () => {}
  })
  assert.equal(T.saveLedger(T.emptyLedger()), false)
  assert.deepEqual(T.$ledgerLoadDiagnostics.get(), {
    sourceVersion: 'none', validationOutcome: 'fresh', recordingStatus: 'active', writeStatus: 'failed'
  })
})

test('ledger diagnostics expose safe state without echoing stored values', () => {
  const malformed = { v: 2, days: { privateValue: 'sensitive-value' } }
  const loaded = T.readStoredLedger({
    get: (key, fallback) => key === 'ledger.v2' ? malformed : fallback
  }, NOW)
  assert.deepEqual(loaded.diagnostics, {
    sourceVersion: 2, validationOutcome: 'invalid-v2', recordingStatus: 'paused', writeStatus: 'blocked'
  })
  const translate = (key, ...args) => {
    const entry = T.I18N.en[key]
    return typeof entry === 'function' ? entry(...args) : entry ?? key
  }
  const line = T.ledgerDiagnosticText(loaded.diagnostics, translate)
  assert.match(line, /source v2 · validation invalid v2 · recording paused · writes blocked/)
  assert.doesNotMatch(line, /sensitive-value/)
  for (const key of Object.keys(T.I18N.en).filter(name => name.startsWith('settingsLedger'))) {
    assert.ok(T.I18N.zh[key], `Chinese ledger diagnostic translation exists for ${key}`)
  }
})

test('side pane docks as a tab beside Files (shares the right-sidebar toggle)', () => {
  assert.deepEqual(T.PANE_DATA.dock, { pane: 'files', pos: 'center' })
  assert.equal(T.PANE_DATA.placement, 'right')
})

test('registers the All Hermes page on /spend-sense and keeps the live chip', () => {
  const registered = []
  const ctx = {
    storage: { get: (k, d) => d, set() {}, remove() {} },
    os: null,
    rest: async () => ({}),
    i18n: { register() {}, t: k => k },
    register: c => registered.push(c),
    onEvent() {},
    setInterval: () => () => {},
    onDispose() {}
  }
  plugin.register(ctx)
  const page = registered.find(c => c.id === 'page')
  const nav = registered.find(c => c.id === 'nav')
  assert.equal(page.data.path, '/spend-sense')
  assert.equal(nav.data.label, 'SpendSense')
  assert.ok(registered.some(c => c.id === 'chip'))
  assert.ok(registered.some(c => c.id === 'pane'))
})
test('CommandCode prices exactly from its own table, not a reseller', () => {
  const r = T.resolveRates({ model: 'deepseek/deepseek-v4.1-flash', provider: 'commandcode', payload: null })
  assert.equal(r.origin, 'bundled')
  assert.deepEqual(r.rates, { input: 0.15, output: 0.6, cache: 0.003, write: null, inputKnown: true, outputKnown: true, cacheKnown: true, usagePricingVersion: 2, usageTierKnown: true, usageInputKnown: true, usageOutputKnown: true, usageCacheKnown: true, usageWriteKnown: false, usagePriceSource: 'bundled_catalogue' },
    'the verified CommandCode rates')
  assert.equal(r.foreignSlug, null)
  const noProvider = T.resolveRates({ model: 'deepseek/deepseek-v4.1-flash', provider: '', payload: null })
  assert.equal(noProvider.origin, 'fallback', 'without a provider coverage continues, but labelled')
})
test('vendor-prefixed and bare model slugs resolve to the same route rates', () => {
  const prefixed = T.resolveRates({ model: 'deepseek/deepseek-v4.1-flash', provider: 'commandcode', payload: null })
  const bare = T.resolveRates({ model: 'deepseek-v4.1-flash', provider: 'commandcode', payload: null })
  assert.equal(prefixed.origin, 'bundled')
  assert.equal(bare.origin, 'bundled')
  assert.deepEqual(prefixed.rates, bare.rates, 'prefix is a vendor namespace, not a different model')
  assert.deepEqual(prefixed.rates, { input: 0.15, output: 0.6, cache: 0.003, write: null, inputKnown: true, outputKnown: true, cacheKnown: true, usagePricingVersion: 2, usageTierKnown: true, usageInputKnown: true, usageOutputKnown: true, usageCacheKnown: true, usageWriteKnown: false, usagePriceSource: 'bundled_catalogue' })

  // The vendor prefix must not be mistaken for the serving provider.
  assert.equal(T.providerMatches({ slug: 'commandcode' }, 'commandcode'), true)
  assert.equal(T.providerMatches({ slug: 'deepseek' }, 'commandcode'), false)

  // A payload keyed by the prefixed id prices the bare active model.
  const payload = { model: 'deepseek/deepseek-v4.1-flash', provider: 'commandcode', providers: [
    { slug: 'commandcode', pricing: { 'deepseek/deepseek-v4.1-flash': { input: '$0.15', output: '$0.60', cache: '$0.003' } } }
  ] }
  const live = T.resolveRates({ model: 'deepseek-v4.1-flash', provider: 'commandcode', payload })
  assert.equal(live.origin, 'live')
  assert.deepEqual(live.rates, { input: 0.15, output: 0.6, cache: 0.003, write: null, inputKnown: false,
    outputKnown: true, cacheKnown: true, writeKnown: false, hasTiers: false, tierDetailsKnown: true,
    tiers: [], cacheWriteRates: [], usagePricingVersion: 2, usageTierKnown: false, usageInputKnown: true,
    usageOutputKnown: true, usageCacheKnown: true, usageWriteKnown: false, usagePriceSource: 'live_catalogue' })
  assert.equal(T.liveProvider(payload, 'deepseek-v4.1-flash'), 'commandcode')
})
test('a corrected provider uses its own exact rates, not a live foreign row', () => {
  // Reproduces the screenshot: provider is commandcode, the payload carries an
  // OpenRouter row with pricing, and commandcode's own row has none.
  const payload = {
    model: 'deepseek/deepseek-v4.1-flash', provider: 'commandcode',
    providers: [
      { slug: 'openrouter', pricing: { 'deepseek/deepseek-v4.1-flash': { input: '$0.30', output: '$1.20', cache: '$0.006' } } },
      { slug: 'commandcode', pricing: {} }
    ]
  }
  const r = T.resolveRates({ model: 'deepseek/deepseek-v4.1-flash', provider: 'commandcode', payload })
  assert.equal(r.origin, 'bundled', 'own exact table wins over a foreign live row')
  assert.deepEqual(r.rates, { input: 0.15, output: 0.6, cache: 0.003, write: null, inputKnown: true, outputKnown: true, cacheKnown: true, usagePricingVersion: 2, usageTierKnown: true, usageInputKnown: true, usageOutputKnown: true, usageCacheKnown: true, usageWriteKnown: false, usagePriceSource: 'bundled_catalogue' })
  assert.equal(r.foreignSlug, null, 'no borrowing warning when the exact rate exists')
})

test('switching providers twice keeps each route and its own rates', () => {
  const codex = { model: 'gpt-6.1-sol', provider: 'openai-codex',
    providers: [{ slug: 'openai-codex', pricing: { 'gpt-6.1-sol': { input: '$5', output: '$25', cache: '$0.5' } } }] }
  const cc = { model: 'deepseek/deepseek-v4.1-flash', provider: 'commandcode',
    providers: [{ slug: 'commandcode', pricing: { 'deepseek/deepseek-v4.1-flash': { input: '$0.15', output: '$0.60', cache: '$0.003' } } }] }
  let led = T.emptyLedger()
  const at = Date.UTC(2026, 9, 29, 12)
  led = T.applyUsage(led, { now: at, payload: codex, provider: 'openai-codex', sessionId: 's', storedId: 'stored',
    profile: 'default', usage: { model: 'gpt-6.1-sol', input: 1_000_000, output: 1_000_000, calls: 1 } })
  led = T.applyUsage(led, { now: at + 1000, payload: cc, provider: 'commandcode', sessionId: 's', storedId: 'stored',
    profile: 'default', usage: { model: 'deepseek/deepseek-v4.1-flash', input: 2_000_000, output: 2_000_000, calls: 2 } })
  const rows = T.summarize(led, () => true, null).rows
  const byProvider = Object.fromEntries(rows.map(r => [r.provider, r]))
  assert.ok(byProvider['openai-codex'] && byProvider.commandcode, 'both routes retained separately')
  // 1M in + 1M out: codex 5+25, commandcode 0.15+0.60
  assert.ok(Math.abs(byProvider['openai-codex'].cost - 30) < 1e-9)
  assert.ok(Math.abs(byProvider.commandcode.cost - 0.75) < 1e-9, 'the second route is not priced at the first route rates')
  assert.equal(byProvider.commandcode.foreignSlug, undefined)
})

test('synthetic cumulative model switch counts each delta once', () => {
  let led = T.emptyLedger()
  const at = Date.UTC(2026, 0, 1)
  const events = [
    {model:'model-a', input:100, output:10, cache_read:50, calls:1},
    {model:'model-b', input:200, output:20, cache_read:100, calls:2}
  ]
  for (const [index, usage] of events.entries()) {
    led = T.applyUsage(led, {now:at + index * 1000, profile:'test', provider:'test',
      sessionId:'runtime', storedId:'conversation', usage})
  }
  const session = led.sessions.conversation
  assert.equal(session.input + session.output + session.cacheRead + session.cacheWrite, 320)
  assert.equal(session.calls, 2)
})

test('safeHttpUrl allowlists http(s) and rejects unsafe schemes', () => {
  // F126: only verifiable web URLs may become link targets.
  assert.equal(T.safeHttpUrl('https://example.com/pricing'), 'https://example.com/pricing')
  assert.equal(T.safeHttpUrl('http://example.com/x'), 'http://example.com/x')
  assert.equal(T.safeHttpUrl('  https://example.com/trimmed  '), 'https://example.com/trimmed')
  for (const bad of ['', null, undefined, 'javascript:alert(1)', 'JaVaScRiPt:alert(1)',
      'data:text/html,<h1>x</h1>', '//example.com/protocol-relative', '/relative/path',
      'ftp://example.com/file', 'not a url']) {
    assert.equal(T.safeHttpUrl(bad), null, `rejected: ${String(bad)}`)
  }
})

test('NewsSourceLink renders an anchor for http(s) and nothing otherwise', () => {
  const t = key => key
  const link = T.NewsSourceLink({ url: 'https://example.com/x', t })
  assert.equal(link.type, 'a')
  assert.equal(link.props.href, 'https://example.com/x')
  assert.equal(link.props.target, '_blank')
  assert.equal(T.NewsSourceLink({ url: 'javascript:alert(1)', t }), null)
  assert.equal(T.NewsSourceLink({ url: '', t }), null)
})
