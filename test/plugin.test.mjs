// Run: node --test test/
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
const queryClient = { fetchQuery: async q => q.queryFn(), getQueryData: () => null }
const usePluginI18n = noop, useQuery = noop, useValue = noop
const jsx = noop, jsxs = noop
`
const body = src
  .replace(/import \{[^}]*\} from '@hermes\/plugin-sdk'\n/, stub)
  .replace(/import \{ useEffect \} from 'react'\n/, '')
  .replace(/import \{ jsx, jsxs \} from 'react\/jsx-runtime'\n/, '')
globalThis.__nav = []
globalThis.window = { location: { hash: '' }, addEventListener() {}, removeEventListener() {} }
const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'tcm-'))
const file = join(dir, 'plugin.mjs')
writeFileSync(file, body)
const mod = await import(pathToFileURL(file).href)
const { __test: T } = mod
const plugin = mod.default

const NOW = new Date(2026, 9, 21, 12).getTime()
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

test('readUsage: no hit% — gap is all cache writes, exact', () => {
  const u = T.readUsage({ input: 100, prompt: 150, output: 1 })
  assert.deepEqual([u.input, u.cacheRead, u.cacheWrite, u.cacheEstimated], [100, 0, 50, false])
})

test('readUsage: raw cache fields win and are exact', () => {
  const u = T.readUsage({ input: 100, prompt: 160, cache_read: 40, cache_write: 20, cache_hit_pct: 99 })
  assert.deepEqual([u.input, u.cacheRead, u.cacheWrite, u.cacheEstimated], [100, 40, 20, false])
})

test('readUsage: input fell back to prompt — split by hit%', () => {
  const u = T.readUsage({ input: 200, prompt: 200, cache_hit_pct: 50 })
  assert.deepEqual([u.input, u.cacheRead], [100, 100])
  assert.equal(u.cacheEstimated, true)
})

test('readUsage: plain usage, junk hit%', () => {
  const u = T.readUsage({ input: 10, output: 5, cache_hit_pct: 'x' })
  assert.deepEqual([u.input, u.output, u.cacheRead, u.cacheWrite], [10, 5, 0, 0])
})

test('resolveRates: own provider wins over a foreign row with the same model', () => {
  const r = T.resolveRates({ model: 'claude-opus-5', provider: 'github-copilot', payload: copilotPayload({ input: '$5', output: '$25', cache: '$0.5' }) })
  assert.equal(r.origin, 'live')
  assert.deepEqual(r.rates, { input: 5, output: 25, cache: 0.5 })
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
  // Continuing the same session after upgrade must not double count.
  const next = T.applyUsage(ledger, { now: NOW, provider: 'github-copilot', sessionId: 's', usage: { model: 'claude-opus-5', input: 1_000_000, calls: 1 } })
  assert.equal(next, ledger)
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

test('ledgers saved before this change load with an empty sessions map', () => {
  const store = { get: k => (k === 'ledger.v2' ? { v: 2, days: {}, rates: {}, snapshots: {} } : null) }
  const { ledger } = T.readStoredLedger(store)
  assert.deepEqual(ledger.sessions, {})
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
  assert.equal(nav.data.label, 'Spend Sense')
  assert.ok(registered.some(c => c.id === 'chip'))
  assert.ok(registered.some(c => c.id === 'pane'))
})
test('CommandCode prices exactly from its own table, not a reseller', () => {
  const r = T.resolveRates({ model: 'deepseek/deepseek-v4.1-flash', provider: 'commandcode', payload: null })
  assert.equal(r.origin, 'bundled')
  assert.deepEqual(r.rates, { input: 0.15, output: 0.6, cache: 0.003 },
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
  assert.deepEqual(prefixed.rates, { input: 0.15, output: 0.6, cache: 0.003 })

  // The vendor prefix must not be mistaken for the serving provider.
  assert.equal(T.providerMatches({ slug: 'commandcode' }, 'commandcode'), true)
  assert.equal(T.providerMatches({ slug: 'deepseek' }, 'commandcode'), false)

  // A payload keyed by the prefixed id prices the bare active model.
  const payload = { model: 'deepseek/deepseek-v4.1-flash', provider: 'commandcode', providers: [
    { slug: 'commandcode', pricing: { 'deepseek/deepseek-v4.1-flash': { input: '$0.15', output: '$0.60', cache: '$0.003' } } }
  ] }
  const live = T.resolveRates({ model: 'deepseek-v4.1-flash', provider: 'commandcode', payload })
  assert.equal(live.origin, 'live')
  assert.deepEqual(live.rates, { input: 0.15, output: 0.6, cache: 0.003 })
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
  assert.deepEqual(r.rates, { input: 0.15, output: 0.6, cache: 0.003 })
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
