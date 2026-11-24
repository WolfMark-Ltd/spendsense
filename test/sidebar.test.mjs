// Run: bash scripts/node-tests.sh browserless sidebar.test.mjs
//
// Live sidebar regressions — real React, real atoms, synthetic host state.
// The hard requirement under test: the five sections stay mounted and keep
// their DOM positions while live usage refreshes, gaps and returns.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const HARNESS_MODULES = join(ROOT, 'test', 'harness', 'node_modules')

if (!existsSync(join(HARNESS_MODULES, '@tanstack', 'react-query'))) {
  throw new Error('real-query harness is not installed: run `npm ci --prefix test/harness`')
}

const work = mkdtempSync(join(tmpdir(), 'wm-sidebar-'))
process.on('exit', () => rmSync(work, { recursive: true, force: true }))

const entry = join(work, 'entry.mjs')
writeFileSync(entry, `
export { default as plugin, __test as T } from '${join(ROOT, 'desktop', 'plugin.js')}'
export * as React from 'react'
export * as ReactDOMClient from 'react-dom/client'
export { QueryClientProvider, queryClient, host, i18nBackend, gatewayActivationEpoch, __bumpActivation } from '@hermes/plugin-sdk'
`)
const bundle = join(work, 'bundle.mjs')
const esbuild = (await import(pathToFileURL(join(HARNESS_MODULES, 'esbuild', 'lib', 'main.js')).href)).default
await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: bundle,
  alias: {
    '@hermes/plugin-sdk': join(ROOT, 'test', 'harness', 'real-sdk.mjs'),
    react: join(HARNESS_MODULES, 'react'),
    'react-dom': join(HARNESS_MODULES, 'react-dom'),
  },
  nodePaths: [HARNESS_MODULES],
  logLevel: 'warning',
})

const { JSDOM } = await import(pathToFileURL(join(HARNESS_MODULES, 'jsdom', 'lib', 'api.js')).href)
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
const define = (name, value) => Object.defineProperty(globalThis, name, {
  value, configurable: true, writable: true,
})
define('window', dom.window)
define('document', dom.window.document)
define('navigator', dom.window.navigator)
define('HTMLElement', dom.window.HTMLElement)
define('Node', dom.window.Node)
define('MouseEvent', dom.window.MouseEvent)
define('KeyboardEvent', dom.window.KeyboardEvent)
define('Event', dom.window.Event)
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const lib = await import(pathToFileURL(bundle).href)
const { plugin, T, React, ReactDOMClient, QueryClientProvider, queryClient, host, i18nBackend, __bumpActivation } = lib

const storageSets = []
const intervals = new Set()
// Pre-seeded storage values, read when plugin.register() runs.
const storageSeed = {}
const makeCtx = () => ({
  rest: async () => ({ ok: true }),
  storage: {
    get: (k, d) => (k in storageSeed ? storageSeed[k] : d),
    set: (k, v) => { storageSets.push([k, v]) },
    delete() {},
  },
  register() {}, registerMany() {}, onDispose() {}, onEvent: () => () => {},
  setTimeout: (fn) => { const t = setTimeout(fn, 0); return () => clearTimeout(t) },
  setInterval: (fn, ms) => {
    if (ms !== 250) return () => {}
    const t = setInterval(fn, ms)
    intervals.add(t)
    return () => { clearInterval(t); intervals.delete(t) }
  },
  addEventListener: () => () => {},
  os: {}, pet: null, i18n: { register() {}, t: key => key },
})
plugin.register(makeCtx())

// --- fixtures ---------------------------------------------------------------
const liveUsage = (over = {}) => ({
  input: 1200, output: 300, cache_read: 4800, cache_write: 120, calls: 2,
  model: 'gpt-4o', ...over,
})
// Conversation totals as the ledger stores them: tokens reconcile exactly.
const histBucket = (over = {}) => ({
  input: 328500, output: 57100, cacheRead: 1000000, cacheWrite: 0, calls: 57,
  pricedTokens: 1385600, unpricedTokens: 0, cost: 1.234,
  sources: { bundled: 1385600 }, model: 'gpt-4o', provider: 'openai',
  foreignSlug: null, cacheEstimated: false, cacheSource: 'exact',
  netSavingsPrompt: 1328500, netSavings: 0.5,
  firstAt: Date.now() - 3600_000, ...over,
})

const resetHost = () => {
  host.state.focusedSessionId.set(null)
  host.state.focusedStoredSessionId.set(null)
  host.state.focusedUsage.set(null)
  host.state.model.set('')
  T.$ledger.set(T.emptyLedger())
  T.$ratesOpen.set(false)
  T.$infoOpen.set(null)
  T.resetStableLive()
  queryClient.clear()
}

const roots = []
const renderMeter = async () => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = ReactDOMClient.createRoot(container)
  roots.push(root)
  await React.act(async () => {
    root.render(React.createElement(QueryClientProvider, { client: queryClient },
      React.createElement(T.Meter, {})))
  })
  return container
}

const flush = async (times = 6) => {
  await React.act(async () => {
    for (let i = 0; i < times; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 0))
    }
  })
}

const openTip = async (container, id) => {
  const button = container.querySelector(`[aria-controls="wm-info-${id}"]`)
  assert.ok(button, `missing ${id} disclosure`)
  await React.act(async () => button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
  return container.querySelector(`#wm-info-${id}`).textContent
}

const sectionsOf = container => ({
  head: container.querySelector('.wm-meter-head'),
  cards: [...container.querySelectorAll('.wm-meter-sections .wm-card')],
})

// Structural equality would pass for rebuilt lookalikes; node retention
// needs the same count plus strict identity per card.
const assertSameCards = (actual, expected, msg) => {
  assert.equal(actual.length, expected.length, `${msg} (same card count)`)
  actual.forEach((card, i) => assert.equal(card, expected[i], `${msg} [${i}]`))
}

after(() => {
  queryClient.clear()
  for (const t of intervals) clearInterval(t)
  dom.window.close()
})
test.afterEach(async () => {
  while (roots.length) {
    const root = roots.pop()
    try { await React.act(async () => { root.unmount() }) } catch { /* already gone */ }
  }
  document.body.innerHTML = ''
  resetHost()
})

// --- the five sections --------------------------------------------------------
test('live usage renders all five sections with labelled values', async () => {
  resetHost()
  host.state.focusedSessionId.set('s1')
  host.state.focusedUsage.set(liveUsage())
  const container = await renderMeter()
  await flush()
  const { head, cards } = sectionsOf(container)
  assert.ok(head, 'identity header renders')
  assert.equal(cards.length, 4, 'cost, composition, gauge and rates cards render')
  const figure = container.querySelector('.wm-kpi-figure')
  assert.ok(figure && figure.textContent !== '—', `cost figure renders: ${figure?.textContent}`)
  assert.equal(container.querySelector('.wm-scope-chip').textContent, 'scopeLocalRunEstimate',
    'the run is the fallback before a conversation record exists')
  assert.match(container.textContent, /apiEquivalent/)
  assert.match(container.textContent, /promptMix/)
  const legendValues = [...container.querySelectorAll('.wm-legend-value')].map(el => el.textContent)
  assert.ok(legendValues.includes('1.2k'), `fresh input labelled: ${legendValues}`)
  assert.ok(legendValues.includes('4.8k'), `cache read labelled: ${legendValues}`)
  const ring = container.querySelector('.wm-ring')
  assert.ok(ring, 'cache ring renders')
  assert.match(ring.getAttribute('aria-label'), /78%/)
  const toggle = container.querySelector('.wm-rates-toggle')
  assert.ok(toggle, 'rates toggle renders')
  assert.equal(toggle.getAttribute('aria-expanded'), 'false')
  assert.equal(container.querySelector('#wm-rates-body'), null)
})

test('a transient gap keeps every section mounted and marks the reading stale', async () => {
  resetHost()
  host.state.focusedSessionId.set('s1')
  host.state.focusedUsage.set(liveUsage())
  const container = await renderMeter()
  await flush()
  const before = sectionsOf(container)
  const figureBefore = container.querySelector('.wm-kpi-figure').textContent
  assert.equal(before.cards.length, 4)

  // The stream drops: same session, briefly no reading.
  host.state.focusedUsage.set(null)
  await flush()
  const during = sectionsOf(container)
  assert.equal(during.head, before.head, 'header node is retained')
  assertSameCards(during.cards, before.cards, 'all four cards keep their DOM nodes')
  assert.match(container.textContent, /meterUpdating/)
  assert.ok(container.querySelector('.wm-meter-sections.wm-stale'), 'stale readings are dimmed')
  assert.equal(container.querySelector('.wm-kpi-figure').textContent, figureBefore,
    'the retained figure does not flash to a placeholder')

  // The stream returns with bigger counters.
  host.state.focusedUsage.set(liveUsage({ input: 2400, calls: 3 }))
  await flush()
  const afterGap = sectionsOf(container)
  assert.equal(afterGap.head, before.head, 'header node survives the round trip')
  assertSameCards(afterGap.cards, before.cards, 'cards survive the round trip')
  assert.doesNotMatch(container.textContent, /meterUpdating/)
  assert.match(container.textContent, /meterLive/)
})

test('a recorded conversation stays selected when the current run has larger totals', async () => {
  resetHost()
  host.state.focusedSessionId.set('s1')
  host.state.focusedStoredSessionId.set('stored-1')
  const firstAt = Date.UTC(2026, 10, 17, 18, 6)
  const ledger = T.emptyLedger()
  ledger.sessions['stored-1'] = histBucket({
    input: 200, output: 100, cacheRead: 50, cacheWrite: 0, calls: 1,
    pricedTokens: 350, unpricedTokens: 0, cost: 0.001,
    sources: { bundled: 350 }, netSavingsPrompt: 250, netSavings: 0.0001,
    firstAt,
  })
  T.$ledger.set(ledger)
  host.state.focusedUsage.set(liveUsage())
  const container = await renderMeter()
  await flush()
  const before = sectionsOf(container)
  const figureEl = container.querySelector('.wm-kpi-figure')
  assert.equal(figureEl.firstChild.textContent, '$0.0010', 'the cost figure renders bare')
  assert.equal(figureEl.querySelector('[data-certainty="partial"]')?.textContent, 'meterPartial',
    'partial coverage rides a chip, not a + suffix')
  assert.doesNotMatch(figureEl.textContent, /[+≈]/, 'no legacy figure markers survive beside the chip')
  const figureBefore = figureEl.textContent
  assert.match(container.querySelector('.wm-kpi-source').textContent, /apiEquivalent/)
  assert.doesNotMatch(container.querySelector('.wm-kpi-source').textContent, /sidebarCostPartial/)
  assert.match(await openTip(container, 'cost-source'), /localEstimateScopeNote/)
  assert.deepEqual([...container.querySelectorAll('.wm-kpi-metrics .wm-metric-value')]
    .map(el => el.textContent), ['350', '1'])
  assert.equal(container.querySelector('.wm-scope-chip').textContent, 'scopeLocalConversationEstimate')
  assert.ok(container.querySelector('.wm-kpi-since'), 'conversation period remains visible')
  const savedBefore = container.querySelector('[data-kind="saved"] .wm-metric-value').textContent
  assert.equal(savedBefore, '—', 'a local net-savings estimate is not shown as cache-read benefit')

  host.state.focusedUsage.set(liveUsage({ input: 2400, calls: 3 }))
  await flush()
  assert.equal(container.querySelector('.wm-scope-chip').textContent, 'scopeLocalConversationEstimate')
  assert.equal(container.querySelector('.wm-kpi-figure').textContent, figureBefore)
  assert.deepEqual([...container.querySelectorAll('.wm-kpi-metrics .wm-metric-value')]
    .map(el => el.textContent), ['350', '1'])
  assert.equal(container.querySelector('[data-kind="saved"] .wm-metric-value').textContent, savedBefore)
  assert.ok(container.querySelector('.wm-kpi-since'), 'conversation period remains visible on later calls')

  host.state.focusedUsage.set(null)
  await flush()
  const during = sectionsOf(container)
  assert.equal(during.head, before.head, 'header node is retained')
  assertSameCards(during.cards, before.cards, 'all four cards keep their DOM nodes')
  assert.equal(container.querySelector('.wm-kpi-figure').textContent, figureBefore,
    'the conversation figure remains stable during a stream gap')
  assert.match(container.textContent, /meterUpdating/, 'the retained reading is stale')
  assert.ok(container.querySelector('.wm-meter-sections.wm-stale'), 'stale readings are dimmed')
  assert.equal(container.querySelector('.wm-scope-chip').textContent, 'scopeLocalConversationEstimate')
  assert.equal(container.querySelector('[data-kind="saved"] .wm-metric-value').textContent, savedBefore)
  assert.ok(container.querySelector('.wm-kpi-since'), 'conversation period survives the gap')

  host.state.focusedUsage.set(liveUsage({ input: 2400, calls: 3 }))
  await flush()
  assertSameCards(sectionsOf(container).cards, before.cards, 'cards survive the round trip')
  assert.doesNotMatch(container.textContent, /meterUpdating/)
  assert.match(container.textContent, /meterLive/)
  assert.equal(container.querySelector('.wm-scope-chip').textContent, 'scopeLocalConversationEstimate')
  assert.equal(container.querySelector('.wm-kpi-figure').textContent, figureBefore)
  assert.equal(container.querySelector('[data-kind="saved"] .wm-metric-value').textContent, savedBefore)
  assert.ok(container.querySelector('.wm-kpi-since'), 'conversation period survives the round trip')
})

test('a model change updates the header without remounting sections', async () => {
  resetHost()
  host.state.focusedSessionId.set('s1')
  host.state.focusedUsage.set(liveUsage())
  const container = await renderMeter()
  await flush()
  const before = sectionsOf(container)
  host.state.focusedUsage.set(liveUsage({ model: 'gpt-5' }))
  await flush()
  const afterModel = sectionsOf(container)
  assert.equal(afterModel.head, before.head)
  assertSameCards(afterModel.cards, before.cards, 'cards survive the model change')
  assert.equal(container.querySelector('.wm-model').textContent, 'GPT 5')
  assert.equal(container.querySelector('.wm-model').title, 'gpt-5')
})

test('a session switch never bleeds the previous reading', async () => {
  resetHost()
  host.state.focusedSessionId.set('s1')
  host.state.focusedUsage.set(liveUsage())
  const container = await renderMeter()
  await flush()
  assert.ok(container.querySelector('.wm-kpi-figure'))

  host.state.focusedSessionId.set('s2')
  host.state.focusedUsage.set(null)
  await flush()
  assert.equal(container.querySelector('.wm-kpi-figure'), null)
  assert.equal(container.querySelector('.wm-meter-sections'), null)
  assert.match(container.textContent, /empty/)
  assert.doesNotMatch(container.textContent, /meterUpdating/)
})

test('recorded conversation figures stay simple while scope details remain available', async () => {
  resetHost()
  host.state.focusedSessionId.set('runtime-9')
  host.state.focusedStoredSessionId.set('stored-9')
  host.state.model.set('gpt-4o')
  const ledger = T.emptyLedger()
  ledger.sessions['stored-9'] = histBucket()
  T.$ledger.set(ledger)
  const container = await renderMeter()
  await flush()
  assert.equal(container.querySelector('.wm-kpi-figure').firstChild.textContent, '$1.23',
    'the cost figure renders bare')
  assert.equal(container.querySelector('.wm-kpi-figure [data-certainty="partial"]')?.textContent,
    'meterPartial', 'partial coverage rides a chip, not a + suffix')
  assert.match(container.querySelector('.wm-kpi-source').textContent, /apiEquivalent/)
  assert.doesNotMatch(container.querySelector('.wm-kpi-source').textContent, /sidebarCostPartial/)
  assert.match(await openTip(container, 'cost-source'), /localEstimateScopeNote/)
  assert.match(container.textContent, /meterRecorded/)
  assert.match(container.textContent, /scopeLocalConversationEstimate/)
  const metrics = [...container.querySelectorAll('.wm-metric-value')].map(el => el.textContent)
  assert.ok(metrics.includes('1.39M'), `total tokens: ${metrics}`)
  assert.ok(metrics.includes('57'), `calls: ${metrics}`)
  const ring = container.querySelector('.wm-ring')
  assert.match(ring.getAttribute('aria-label'), /75%/)
  const expected = (1000000 / 1328500) * T.RING_C
  const dash = ring.querySelector('.wm-ring-value').getAttribute('stroke-dasharray')
  assert.ok(Math.abs(parseFloat(dash) - expected) < 1e-6, `ring arc ${dash} matches 75.27%`)
  // Compact gauge metrics keep the supported cache-read figure prominent.
  const stats = container.querySelector('.wm-gauge-stats').textContent
  assert.doesNotMatch(stats, /coverageLabel|savedGauge|\$0\.50/)
  assert.equal(container.querySelector('[data-kind="saved"] .wm-metric-value').textContent, '—',
    'a local net-savings estimate is not presented as the cache-read benefit')
  assert.match(await openTip(container, 'cache-coverage'), /cacheCoverageHelp/,
    'coverage scope remains available behind the title tooltip')
  assert.doesNotMatch(stats, /hitRate/, 'the ring is the only hit-rate display')
})

test('a cache coverage change redraws the gauge in place', async () => {
  resetHost()
  host.state.focusedSessionId.set('s1')
  host.state.focusedUsage.set(liveUsage())
  const container = await renderMeter()
  await flush()
  const ringBefore = container.querySelector('.wm-ring')
  const dashBefore = ringBefore.querySelector('.wm-ring-value').getAttribute('stroke-dasharray')
  const exactMetrics = [...container.querySelectorAll('.wm-kpi-metrics .wm-metric-value')]
    .map(el => el.textContent)
  assert.equal(exactMetrics[0], '6.4k', 'exact totals carry no marker')

  // The gateway now reports a reconstructed percentage instead of counters.
  host.state.focusedUsage.set({ input: 1000, prompt: 2000, cache_hit_pct: 50, output: 100, calls: 1, model: 'gpt-4o' })
  await flush()
  const ringAfter = container.querySelector('.wm-ring')
  assert.equal(ringAfter, ringBefore, 'the ring element is reused')
  const dashAfter = ringAfter.querySelector('.wm-ring-value').getAttribute('stroke-dasharray')
  assert.notEqual(dashAfter, dashBefore, 'the arc follows the new hit rate')
  assert.equal(ringAfter.querySelector('.wm-ring-text').textContent, '50%')
  assert.equal(ringAfter.getAttribute('aria-label'), 'weightedCacheHit: 50% (estimatedLabel)')
  assert.ok(ringAfter.querySelector('.wm-ring-value').classList.contains('wm-ring-estimated'),
    'reconstructed coverage dims the ring')
  const estMetrics = [...container.querySelectorAll('.wm-kpi-metrics .wm-metric-value')]
    .map(el => el.textContent)
  assert.match(estMetrics[0], /^2\.1k meterPartial$/, `reconstructed totals carry a Partial chip: ${estMetrics}`)
  // Rounded hit percentages cannot establish the backend cache-read benefit.
  assert.equal(container.querySelector('[data-kind="saved"] .wm-metric-value').textContent, '—')
  assert.doesNotMatch(container.textContent, /readBenefitUsageLink/)

  host.state.focusedUsage.set({ input: 1000, prompt: 2000, cache_hit_pct: 50, output: 100, calls: 1, model: 'no-such-model-9z' })
  await flush()
  assert.equal(container.querySelector('[data-kind="saved"] .wm-metric-value').textContent, '—')

})

test('rounded hit-rate residual is unclassified rather than a measured write', () => {
  const bucket = T.readUsage({input: 500, prompt: 1000, output: 0, calls: 1, cache_hit_pct: 40})
  assert.equal(bucket.cacheWriteEvidence, 'derived')
  const rows = T.tokenRows(key => key, bucket, false, null)
  assert.equal(rows.find(row => row.key === 'cw').value, '—',
    'the normal figure uses a dash instead of a technical unknown label')
  const shares = T.compositionShares(bucket)
  assert.equal(shares.write, 0)
  assert.equal(shares.unknown, 100)
  assert.equal(shares.prompt, 1000)
})

test('a partial local conversation keeps coverage details off the sidebar figures', async () => {
  resetHost()
  host.state.focusedSessionId.set('s1')
  host.state.focusedStoredSessionId.set('stored-partial')
  const ledger = T.emptyLedger()
  // 70% of the prompt tokens carry a priced, known cache split; the cold start
  // never did. The figure is the measured part, never a complete total.
  ledger.sessions['stored-partial'] = histBucket({
    input: 400000, output: 50000, cacheRead: 600000, cacheWrite: 0, calls: 10,
    pricedTokens: 1050000, unpricedTokens: 0, cost: 1.5,
    sources: { bundled: 1050000 }, cacheEstimated: false, cacheSource: undefined,
    cacheCoveredPrompt: 700000, cacheCoveredRead: 600000, cacheExactPrompt: 700000,
    netSavingsPrompt: 700000, netSavings: 1.5,
  })
  T.$ledger.set(ledger)
  host.state.focusedUsage.set(null)
  const container = await renderMeter()
  await flush()
  assert.equal(container.querySelector('[data-kind="saved"] .wm-metric-value').textContent, '—',
    'partial local net savings are not substituted for the supported cache-read figure')
  assert.doesNotMatch(container.querySelector('.wm-gauge-stats').textContent, /\$1\.50/)
  assert.match(await openTip(container, 'cache-coverage'), /cacheCoverageHelp/,
    'scope and methodology remain available on demand')
})

test('a net cache loss renders as a signed figure, not $0.00', async () => {
  // Greptile P1 on the sidebar surface: the write premium exceeds the read
  // discount, so the conversation has a real net loss.
  resetHost()
  host.state.focusedSessionId.set('s1')
  host.state.focusedStoredSessionId.set('stored-loss')
  const ledger = T.emptyLedger()
  ledger.sessions['stored-loss'] = histBucket({
    input: 100, output: 10, cacheRead: 200, cacheWrite: 1000, calls: 1,
    pricedTokens: 1310, unpricedTokens: 0, cost: 0.002,
    sources: { live: 1310 }, cacheEstimated: false, cacheSource: 'exact',
    cacheCoveredPrompt: 1300, cacheCoveredRead: 200, cacheExactPrompt: 1300,
    netSavingsPrompt: 1300, netSavings: -1.25,
  })
  T.$ledger.set(ledger)
  host.state.focusedUsage.set(null)
  const container = await renderMeter()
  await flush()
  const stats = container.querySelector('.wm-gauge-stats')
  assert.equal(container.querySelector('[data-kind="saved"] .wm-metric-value').textContent, '—',
    'a local cache loss is not shown as the cache-read benefit')
  assert.doesNotMatch(stats.textContent, /−\$1\.25/)
  assert.doesNotMatch(stats.textContent, /\$0\.00/, 'a loss never renders as zero')
})

test('an exact backend zero cache-read benefit remains distinct from unavailable', async () => {
  resetHost()
  host.state.focusedSessionId.set('runtime-zero')
  host.state.focusedStoredSessionId.set('stored-zero')
  const originalRest = T.getRest()
  T.setRest(async path => path.startsWith('/session/summary?') ? {
    ok: true, session_id: 'runtime-zero',
    population: { requested: 'all', satisfied: true, separable: false },
    totals: { calls: 1, input_tokens: 100, output_tokens: 10, prompt_tokens: 120,
      cache_read_tokens: 20, cache_write_tokens: 0,
      cache_read_state: 'reported', cache_write_state: 'reported', unpriced_tokens: 0 },
    valuation: { read_benefit_usd: 0, read_benefit_basis: 'exact',
      read_benefit_calls: 1, read_benefit_tokens: 20 }
  } : { rate: null })
  const ledger = T.emptyLedger()
  ledger.sessions['stored-zero'] = histBucket({
    input: 100, output: 10, cacheRead: 20, cacheWrite: 0, calls: 1,
    pricedTokens: 130, unpricedTokens: 0, cost: 0.001,
    sources: { live: 130 }, cacheEstimated: false, cacheSource: 'exact',
    cacheCoveredPrompt: 120, cacheCoveredRead: 20, cacheExactPrompt: 120,
    netSavingsPrompt: 120, netSavings: 0,
  })
  T.$ledger.set(ledger)
  const container = await renderMeter()
  await flush()
  try {
    const saved = container.querySelector('[data-kind="saved"] .wm-metric-value')
    assert.equal(saved.textContent, '$0.00')
    assert.doesNotMatch(container.querySelector('.wm-gauge-stats').textContent, /savedNotEstablished/)
  } finally {
    T.restoreRest(originalRest)
  }
})

test('a proven session summary renders the cache-read benefit with coverage in its tooltip', async () => {
  resetHost()
  const requests = []
  const originalRest = T.getRest()
  const previousTranslate = i18nBackend.t
  i18nBackend.t = (key, ...args) => {
    const value = T.I18N.en[key]
    return typeof value === 'function' ? value(...args) : value ?? key
  }
  T.setRest(async path => {
    requests.push(path)
    if (path.startsWith('/session/summary?')) return {
      ok: true, session_id: 'summary-session',
      population: { requested: 'all', satisfied: true, separable: false },
      totals: { calls: 2, input_tokens: 100, output_tokens: 10, prompt_tokens: 200,
        cache_read_tokens: 100, cache_write_tokens: 0,
        cache_read_state: 'reported', cache_write_state: 'reported', unpriced_tokens: 0 },
      valuation: { api_equivalent_usd: .001, api_equivalent_basis: 'exact',
        read_benefit_usd: .005, read_benefit_basis: 'exact', read_benefit_calls: 1, read_benefit_tokens: 100,
        savings_usd: 0, savings_usd_high: null, savings_basis: 'exact', coverage: 1,
        covered_calls: 1, excluded_calls: 0, cache_hit_rate: 0, cache_hit_rate_basis: 'all_calls' }
    }
    return { rate: null }
  })
  host.state.model.set('gpt-4o')
  queryClient.setQueryData(T.catalogQuery('summary-session', 'gpt-4o', false).queryKey,
    { model: 'gpt-4o', provider: 'openai' })
  host.state.focusedSessionId.set('summary-session')
  const container = await renderMeter()
  await flush()
  try {
    assert.ok(requests.some(path => path.startsWith('/session/summary?') &&
      path.includes('session_id=summary-session') && path.includes('population=all')),
    `session summary request: ${requests}`)
    assert.equal(container.querySelector('.wm-scope-chip').textContent, 'This session · all recorded calls')
    assert.equal(container.querySelector('.wm-model').textContent, 'GPT 4o',
      'the active Desktop route is retained instead of empty backend filter echoes')
    assert.equal(container.querySelector('.wm-provider-badge').textContent, 'openai',
      'the separately resolved active route provider remains visible')
    const benefitFigure = container.querySelector('[data-kind="saved"] .wm-metric-value')
    assert.equal(benefitFigure.firstChild.textContent, '$0.0050', 'the benefit figure renders bare')
    assert.equal(benefitFigure.querySelector('[data-certainty="partial"]')?.textContent,
      'Partial', 'partial coverage rides a chip, not a + suffix')
    assert.doesNotMatch(benefitFigure.textContent, /[+≈]/, 'no legacy figure markers survive beside the chip')
    assert.equal(container.querySelectorAll('[data-kind="saved"]').length, 1,
      'the session read benefit appears once')
    assert.doesNotMatch(container.textContent, /1 of 1 calls|100 read tokens|readBenefitUsageLink/,
      'coverage details and the Usage link stay out of the normal pane')
    const benefitTip = await openTip(container, 'read-benefit')
    assert.match(benefitTip, /API-equivalent cache-read benefit for this runtime session/)
    assert.match(benefitTip, /1 of 2 calls · 100 read tokens/)
    assert.match(container.querySelector('.wm-kpi-figure').textContent, /\$0\.0010/)
    assert.equal(container.querySelector('.wm-rates-toggle'), null,
      'a multi-route session summary does not present a single-route Rates panel')
    assert.equal(container.querySelector('.wm-ring').getAttribute('aria-label'), 'Weighted cache hit: 0%',
      'the zero hit rate is exposed to assistive technology')
  } finally {
    T.restoreRest(originalRest)
    i18nBackend.t = previousTranslate
  }
})

test('an empty session summary does not present unsupported local net savings', async () => {
  resetHost()
  const originalRest = T.getRest()
  T.setRest(async path => {
    if (path.startsWith('/session/summary?')) return {
      ok: true, session_id: 'empty-summary-session',
      population: { requested: 'all', satisfied: true, separable: false },
      totals: { calls: 0, input_tokens: 0, output_tokens: 0, prompt_tokens: 0,
        cache_read_tokens: 0, cache_write_tokens: 0,
        cache_read_state: 'reported', cache_write_state: 'reported' },
      valuation: { savings_basis: 'indeterminate', covered_calls: 0, excluded_calls: 0 }
    }
    return { rate: null }
  })
  host.state.focusedSessionId.set('empty-summary-session')
  host.state.focusedStoredSessionId.set('empty-summary-conversation')
  const ledger = T.emptyLedger()
  ledger.sessions['empty-summary-conversation'] = histBucket({ netSavings: .5 })
  T.$ledger.set(ledger)
  const container = await renderMeter()
  await flush()
  try {
    assert.equal(container.querySelector('.wm-scope-chip').textContent, 'scopeLocalConversationEstimate')
    assert.equal(container.querySelector('[data-kind="saved"] .wm-metric-value').textContent, '—')
  } finally {
    T.restoreRest(originalRest)
  }
})

test('a backend API-equivalent range keeps both endpoints in the pane and chip formatter', async () => {
  resetHost()
  const originalRest = T.getRest()
  T.setRest(async path => {
    if (path.startsWith('/session/summary?')) return {
      ok: true, session_id: 'range-summary-session',
      population: { requested: 'all', satisfied: true, separable: false },
      totals: { calls: 1, input_tokens: 100, output_tokens: 10, prompt_tokens: 200,
        cache_read_tokens: 100, cache_write_tokens: 0,
        cache_read_state: 'reported', cache_write_state: 'reported', unpriced_tokens: 0 },
      valuation: { api_equivalent_usd: .202, api_equivalent_usd_high: .502,
        api_equivalent_basis: 'range', savings_usd: 0, savings_usd_high: null,
        savings_basis: 'exact', coverage: 1, covered_calls: 1, excluded_calls: 0,
        cache_hit_rate: .5, cache_hit_rate_basis: 'all_calls' }
    }
    return { rate: null }
  })
  host.state.model.set('gpt-4o')
  queryClient.setQueryData(T.catalogQuery('range-summary-session', 'gpt-4o', false).queryKey,
    { model: 'gpt-4o', provider: 'openai' })
  host.state.focusedSessionId.set('range-summary-session')
  const meter = await renderMeter()
  await flush()
  try {
    assert.match(meter.querySelector('.wm-kpi-figure').textContent, /^\$0\.202–\$0\.502$/)
    assert.equal(T.apiEquivalentDisplay({ cost: 2, costSource: 'backend_summary', costBasis: 'indeterminate', costPartial: true }), '$2.00+')
    assert.equal(T.apiEquivalentDisplay({ cost: 2, costSource: 'local', costPartial: true }), '$2.00+')
    assert.equal(T.sidebarCostDisplay({cost: 0, costHigh: 1, costBasis: 'range', costPartial: true}), '$0.00–$1.00')
    assert.equal(T.sidebarCostDisplay({cost: 0, costPartial: true}), '—')
    assert.match(T.apiEquivalentDisplay({ cost: .202, costHigh: .502, costSource: 'backend_summary',
      costBasis: 'range', costPartial: true }), /^≈\$0\.202–\$0\.502$/)
  } finally {
    T.restoreRest(originalRest)
  }
})

test('a refused session summary does not present unsupported local net savings', async () => {
  resetHost()
  const requests = []
  const originalRest = T.getRest()
  T.setRest(async path => {
    requests.push(path)
    if (path.startsWith('/session/summary?')) return {
      ok: true, session_id: 'refused-session', model: 'gpt-4o', provider: 'openai',
      population: { requested: 'all', satisfied: false, separable: false,
        reason: 'population_not_recorded' }, totals: null, valuation: null,
      alternate: { scope: 'all_calls', valuation: { savings_usd: 999999, savings_basis: 'exact' } }
    }
    return { rate: null }
  })
  host.state.focusedSessionId.set('refused-session')
  host.state.focusedStoredSessionId.set('refused-conversation')
  const ledger = T.emptyLedger()
  ledger.sessions['refused-conversation'] = histBucket({
    input: 100, output: 10, cacheRead: 200, cacheWrite: 1000, calls: 1,
    netSavingsPrompt: 1300, netSavings: -.5, cacheSource: 'exact', cacheExactPrompt: 1300,
    cacheReadEvidence: 'reported', cacheWriteEvidence: 'reported'
  })
  T.$ledger.set(ledger)
  const container = await renderMeter()
  await flush()
  try {
    assert.ok(requests.some(path => path.startsWith('/session/summary?') && path.includes('population=all')))
    assert.equal(container.querySelector('.wm-scope-chip').textContent, 'scopeLocalConversationEstimate')
    assert.equal(container.querySelector('[data-kind="saved"] .wm-metric-value').textContent, '—')
    assert.doesNotMatch(container.textContent, /999999/,
      'the refused response alternate all-calls block is never rendered')
  } finally {
    T.restoreRest(originalRest)
  }
})

test('a failed session summary explains the fallback inside the cost-source tip only', async () => {
  resetHost()
  const originalRest = T.getRest()
  const previousTranslate = i18nBackend.t
  i18nBackend.t = (key, ...args) => {
    const value = T.I18N.en[key]
    return typeof value === 'function' ? value(...args) : value ?? key
  }
  T.setRest(async path => {
    if (path.startsWith('/session/summary?')) throw new Error('boom-unreachable')
    return { rate: null }
  })
  host.state.focusedSessionId.set('failed-session')
  host.state.focusedStoredSessionId.set('failed-conversation')
  const ledger = T.emptyLedger()
  ledger.sessions['failed-conversation'] = histBucket({
    input: 100, output: 10, cacheRead: 0, cacheWrite: 0, calls: 1,
    pricedTokens: 110, unpricedTokens: 0, cost: 0.01, sources: { live: 110 },
  })
  T.$ledger.set(ledger)
  const container = await renderMeter()
  await flush()
  try {
    assert.equal(container.querySelector('.wm-scope-chip').textContent, 'conversation')
    assert.match(await openTip(container, 'cost-source'),
      /Session scope unavailable \(backend read failed: boom-unreachable\)/,
      'the fallback reason lives in the existing info control')
    assert.equal(container.querySelector('[data-scope-reason]'), null,
      'no raw diagnostic line in the header')
    assert.doesNotMatch(container.querySelector('.wm-meter-head').textContent, /boom-unreachable/,
      'the header stays clean')
  } finally {
    T.restoreRest(originalRest)
    i18nBackend.t = previousTranslate
  }
})

test('a retained stale reading keeps the current fallback reason, not the saved one', () => {
  const key = 'stale-reason-session'
  const prev = { key,
    snapshot: { bucket: { input: 100, calls: 1 }, cost: 0.01, scopeReason: 'summary_no_calls' } }
  const live = { bucket: null, usage: null, scopeReason: 'backend read failed: boom-unreachable' }
  const merged = T.mergeStableLive(prev, live, key)
  assert.equal(merged.stale, true, 'the gap still retains the last reading')
  assert.equal(merged.view.bucket, prev.snapshot.bucket, 'retained figures survive the gap')
  assert.equal(merged.view.scopeReason, 'backend read failed: boom-unreachable',
    'a saved reason never hides a new backend failure')
})

test('a bounded read benefit keeps its bound wording without a Partial chip', async () => {
  resetHost()
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = ReactDOMClient.createRoot(container)
  roots.push(root)
  const view = {
    bucket: { input: 100, output: 10, cacheRead: 50, cacheWrite: 0, calls: 2 },
    cacheHitPct: 50, savedSource: 'backend_summary', fromHistory: true,
    readBenefit: { available: true, value: 1.5, basis: 'lower_bound',
      calls: 1, tokens: 50, total: 2, partial: true },
  }
  await React.act(async () => {
    root.render(React.createElement(T.CacheGauge, { t: key => key, view }))
  })
  const saved = container.querySelector('[data-kind="saved"] .wm-metric-value')
  assert.match(saved.textContent, /savingsLowerBoundValue/, 'the bound wording is untouched')
  assert.equal(saved.querySelector('[data-certainty="partial"]'), null,
    'bounds carry their own meaning and take no chip')
})

test('a cache-only frame renders as valid live usage', async () => {
  resetHost()
  host.state.focusedSessionId.set('s1')
  host.state.focusedUsage.set(liveUsage({ input: 0, output: 0, calls: 0 }))
  const container = await renderMeter()
  await flush()
  // Display: the sections render with the cache tokens counted.
  assert.equal(sectionsOf(container).cards.length, 4)
  const metrics = [...container.querySelectorAll('.wm-kpi-metrics .wm-metric-value')]
    .map(el => el.textContent)
  assert.equal(metrics[0], '4.9k', `cache-only total: ${metrics}`)
  const legendValues = [...container.querySelectorAll('.wm-legend-value')].map(el => el.textContent)
  assert.ok(legendValues.includes('4.8k'), `cache read labelled: ${legendValues}`)
  const ring = container.querySelector('.wm-ring')
  assert.match(ring.getAttribute('aria-label'), /98%/)
  // Session identity: this run's scope, not the conversation fallback.
  assert.equal(container.querySelector('.wm-scope-chip').textContent, 'scopeLocalRunEstimate')
  // A refresh keeps every section standing.
  const before = sectionsOf(container)
  host.state.focusedUsage.set(liveUsage({ input: 0, output: 0, calls: 0, cache_read: 5000 }))
  await flush()
  const after = sectionsOf(container)
  assert.equal(after.head, before.head)
  assertSameCards(after.cards, before.cards, 'cards survive the refresh')
  assert.equal(container.querySelector('.wm-scope-chip').textContent, 'scopeLocalRunEstimate')
})

test('a calls-only frame still renders without token data', async () => {
  resetHost()
  host.state.focusedSessionId.set('s1')
  host.state.focusedUsage.set(liveUsage({ input: 0, output: 0, cache_read: 0, cache_write: 0, calls: 3 }))
  const container = await renderMeter()
  await flush()
  assert.equal(sectionsOf(container).cards.length, 4)
  const metrics = [...container.querySelectorAll('.wm-kpi-metrics .wm-metric-value')]
    .map(el => el.textContent)
  assert.equal(metrics[0], '0', `no tokens yet: ${metrics}`)
  assert.equal(metrics[1], '3', `calls counted: ${metrics}`)
  assert.equal(container.querySelector('.wm-scope-chip').textContent, 'scopeLocalRunEstimate')
  const ring = container.querySelector('.wm-ring')
  assert.match(ring.getAttribute('aria-label'), /—/, 'no prompt means no hit rate')
  assert.equal(container.querySelector('.wm-kpi-figure').textContent, '—')
  assert.doesNotMatch(container.querySelector('.wm-kpi-source').textContent, /sidebarCostPartial|partialCacheEvidence|coverageUnknownNote/,
    'the normal sidebar has no prominent technical coverage caveat')
  assert.match(await openTip(container, 'cost-source'), /partialCacheEvidence/,
    'the detail remains available in the tooltip by the figure')
  const method = container.querySelector('[aria-controls="wm-info-cache-coverage"]')
  await React.act(async () => {
    method.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
  await flush(2)
  assert.doesNotMatch(container.querySelector('#wm-info-cache-coverage').textContent, /0%/,
    'unavailable coverage is omitted, not shown as 0%')
  const before = sectionsOf(container)
  host.state.focusedUsage.set(liveUsage({ input: 0, output: 0, cache_read: 0, cache_write: 0, calls: 4 }))
  await flush()
  const after = sectionsOf(container)
  assert.equal(after.head, before.head)
  assertSameCards(after.cards, before.cards, 'cards survive the refresh')
})

test('an all-zero frame keeps the genuine empty state', async () => {
  resetHost()
  host.state.focusedSessionId.set('s1')
  host.state.focusedUsage.set(liveUsage({ input: 0, output: 0, calls: 0, cache_read: 0, cache_write: 0 }))
  const container = await renderMeter()
  await flush()
  assert.equal(container.querySelector('.wm-meter-sections'), null)
  assert.match(container.textContent, /empty/)
  // The first real reading still brings the sections up.
  host.state.focusedUsage.set(liveUsage())
  await flush()
  assert.equal(sectionsOf(container).cards.length, 4)
})

test('an activation bump and fresh tick leave the sections standing', async () => {
  resetHost()
  host.state.focusedSessionId.set('s1')
  host.state.focusedUsage.set(liveUsage())
  const container = await renderMeter()
  await flush()
  const before = sectionsOf(container)
  __bumpActivation()
  host.state.focusedUsage.set(liveUsage({ input: 1300 }))
  await flush(10)
  const afterBump = sectionsOf(container)
  assert.equal(afterBump.head, before.head)
  assertSameCards(afterBump.cards, before.cards, 'cards survive the activation bump')
  assert.ok(container.querySelector('.wm-kpi-figure').textContent !== '—')
})

test('a fresh session shows the stable empty state', async () => {
  resetHost()
  host.state.focusedSessionId.set('brand-new')
  const container = await renderMeter()
  await flush()
  assert.match(container.textContent, /empty/)
  assert.equal(container.querySelector('.wm-meter-sections'), null)
  // …and the sections appear once the first reading lands.
  host.state.focusedUsage.set(liveUsage())
  await flush()
  assert.equal(sectionsOf(container).cards.length, 4)
})

// --- rates panel ---------------------------------------------------------------
test('rates stay collapsed by default and survive refreshes once open', async () => {
  resetHost()
  host.state.focusedSessionId.set('s1')
  host.state.focusedUsage.set(liveUsage())
  const container = await renderMeter()
  await flush()
  const toggle = container.querySelector('.wm-rates-toggle')
  assert.equal(toggle.getAttribute('aria-expanded'), 'false')

  await React.act(async () => {
    toggle.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
  await flush(2)
  assert.equal(toggle.getAttribute('aria-expanded'), 'true')
  const body = container.querySelector('#wm-rates-body')
  assert.ok(body, 'rates body opens')
  const cells = [...body.querySelectorAll('.wm-rate-cell .wm-metric-value')].map(el => el.textContent)
  assert.equal(cells.length, 3, `input/output/cache cells: ${cells}`)
  assert.ok(cells.every(v => v.startsWith('$') || v === '—'), `cells carry values: ${cells}`)

  host.state.focusedUsage.set(liveUsage({ input: 5000 }))
  await flush()
  assert.equal(toggle.getAttribute('aria-expanded'), 'true', 'refresh does not collapse rates')
  assert.equal(container.querySelector('#wm-rates-body'), body, 'rates body node is retained')
  assert.ok(storageSets.some(([k, v]) => k === 'rates-open' && v === true),
    `expansion persists: ${JSON.stringify(storageSets)}`)
})

test('rates restore open from stored state', async () => {
  resetHost()
  storageSeed['rates-open'] = true
  try {
    plugin.register(makeCtx())
    host.state.focusedSessionId.set('s1')
    host.state.focusedUsage.set(liveUsage())
    const container = await renderMeter()
    await flush()
    const toggle = container.querySelector('.wm-rates-toggle')
    assert.equal(toggle.getAttribute('aria-expanded'), 'true')
    assert.ok(container.querySelector('#wm-rates-body'), 'the stored expansion restores the body')
  } finally {
    delete storageSeed['rates-open']
  }
})

// --- info popovers ---------------------------------------------------------------
test('info popovers open on click and close on Escape', async () => {
  resetHost()
  host.state.focusedSessionId.set('s1')
  host.state.focusedUsage.set(liveUsage())
  const container = await renderMeter()
  await flush()
  const buttons = [...container.querySelectorAll('.wm-info-btn')]
  assert.ok(buttons.length >= 3, `info buttons render: ${buttons.length}`)
  const first = container.querySelector('[aria-controls="wm-info-read-benefit"]')
  assert.ok(first, 'the cache-read benefit figure keeps its help tip')
  assert.equal(first.getAttribute('aria-expanded'), 'false')
  assert.equal(container.querySelector('.wm-info-pop'), null)

  await React.act(async () => {
    first.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
  await flush(2)
  assert.equal(first.getAttribute('aria-expanded'), 'true')
  const pop = container.querySelector('#wm-info-read-benefit')
  assert.ok(pop, 'popover opens')
  assert.equal(pop.getAttribute('role'), 'tooltip')
  assert.ok(pop.textContent.length > 0, 'popover content is rendered')

  await React.act(async () => {
    first.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })
  await flush(2)
  assert.equal(container.querySelector('.wm-info-pop'), null, 'Escape closes the popover')
  assert.equal(first.getAttribute('aria-expanded'), 'false')
})

test('only one popover opens at a time', async () => {
  resetHost()
  host.state.focusedSessionId.set('s1')
  host.state.focusedUsage.set(liveUsage())
  const container = await renderMeter()
  await flush()
  const buttons = [...container.querySelectorAll('.wm-info-btn')]
  await React.act(async () => {
    buttons[0].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
  await flush(2)
  assert.equal(container.querySelectorAll('.wm-info-pop').length, 1)
  await React.act(async () => {
    buttons[1].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
  await flush(2)
  const pops = container.querySelectorAll('.wm-info-pop')
  assert.equal(pops.length, 1, 'opening a second tip closes the first')
  assert.equal(buttons[0].getAttribute('aria-expanded'), 'false')
  assert.equal(buttons[1].getAttribute('aria-expanded'), 'true')
})

test('info popovers open on keyboard focus', async () => {
  resetHost()
  host.state.focusedSessionId.set('s1')
  host.state.focusedUsage.set(liveUsage())
  const container = await renderMeter()
  await flush()
  const first = container.querySelector('.wm-info-btn')
  await React.act(async () => { first.focus() })
  await flush(2)
  assert.ok(container.querySelector('.wm-info-pop'), 'focus opens the popover')
  await React.act(async () => { first.blur() })
  await flush(2)
  assert.equal(container.querySelector('.wm-info-pop'), null, 'blur closes the popover')
})

for (const [locale, label, wording] of [
  ['en', 'Coverage details', /all prompt tokens for the current run/],
  ['zh', '覆盖率说明', /本轮中具有精确或估算缓存拆分的提示词令牌 ÷ 全部提示词令牌/],
]) {
  test(`current-run Coverage help opens on focus and explains its scope (${locale})`, async () => {
    resetHost()
    host.state.focusedSessionId.set('s1')
    host.state.focusedUsage.set(liveUsage({
      model: 'deepseek/deepseek-v4.1-flash',
      input: 100000, prompt: 600000, output: 10000, cache_read: 500000, cache_write: 0, calls: 1,
    }))
    const previousTranslate = i18nBackend.t
    i18nBackend.t = (key, ...args) => {
      const value = T.I18N[locale][key]
      return typeof value === 'function' ? value(...args) : value ?? key
    }
    const errors = []
    const recordError = event => errors.push(String(event.error || event.message || event.reason))
    window.addEventListener('error', recordError)
    window.addEventListener('unhandledrejection', recordError)
    try {
      const container = await renderMeter()
      await flush()
      const tipId = 'wm-info-cache-coverage'
      const button = container.querySelector(`[aria-controls="${tipId}"]`)
      assert.ok(button, 'Coverage help button renders')
      assert.equal(button.getAttribute('aria-label'), label)
      assert.equal(button.tabIndex, 0)
      assert.equal(button.getAttribute('aria-expanded'), 'false')

      await React.act(async () => { button.focus() })
      await flush(2)
      assert.equal(document.activeElement, button)
      assert.equal(button.getAttribute('aria-expanded'), 'true')
      assert.equal(button.getAttribute('aria-describedby'), tipId)
      const help = container.querySelector(`#${tipId}`)
      assert.ok(help, 'Coverage help text renders')
      assert.match(help.textContent, wording)

      await React.act(async () => {
        button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      })
      await flush(2)
      assert.equal(button.getAttribute('aria-expanded'), 'false')
      assert.equal(container.querySelector(`#${tipId}`), null)
      assert.equal(document.activeElement, button, 'Escape leaves focus on Coverage help')
      assert.deepEqual(errors, [], 'current-run Coverage help reports no runtime errors')
    } finally {
      window.removeEventListener('error', recordError)
      window.removeEventListener('unhandledrejection', recordError)
      i18nBackend.t = previousTranslate
    }
  })
}

test('a click never toggles shut what hover just opened', async () => {
  resetHost()
  host.state.focusedSessionId.set('s1')
  host.state.focusedUsage.set(liveUsage())
  const container = await renderMeter()
  await flush()
  const first = container.querySelector('.wm-info-btn')
  await React.act(async () => {
    first.dispatchEvent(new dom.window.MouseEvent('mouseover', { bubbles: true }))
  })
  await flush(2)
  assert.ok(container.querySelector('.wm-info-pop'), 'hover opens the popover')
  await React.act(async () => {
    first.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
  await flush(2)
  assert.ok(container.querySelector('.wm-info-pop'), 'the following click keeps it open')
  assert.equal(first.getAttribute('aria-expanded'), 'true')
})

test('Escape closes a mouse-opened popover from the focused button', async () => {
  resetHost()
  host.state.focusedSessionId.set('s1')
  host.state.focusedUsage.set(liveUsage())
  const container = await renderMeter()
  await flush()
  const first = container.querySelector('.wm-info-btn')
  // Mirror a real mouse click: hover, press, natural focus, release.
  await React.act(async () => {
    first.dispatchEvent(new dom.window.MouseEvent('mouseover', { bubbles: true }))
    first.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true }))
    first.focus()
    first.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
  await flush(2)
  assert.ok(container.querySelector('.wm-info-pop'), 'the click opens the popover')
  assert.equal(document.activeElement, first, 'the clicked button holds focus')
  await React.act(async () => {
    document.activeElement.dispatchEvent(
      new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })
  await flush(2)
  assert.equal(container.querySelector('.wm-info-pop'), null, 'Escape closes it')
  assert.equal(first.getAttribute('aria-expanded'), 'false')
  assert.equal(document.activeElement, first, 'focus stays on the button')
})

test('Escape dismisses a hover-opened tip without reaching the window closer', async () => {
  resetHost()
  host.state.focusedSessionId.set('s1')
  host.state.focusedUsage.set(liveUsage())
  const container = await renderMeter()
  await flush()
  const first = container.querySelector('.wm-info-btn')
  await React.act(async () => {
    first.dispatchEvent(new dom.window.MouseEvent('mouseover', { bubbles: true }))
  })
  await flush(2)
  assert.ok(container.querySelector('.wm-info-pop'), 'hover opens the popover')
  assert.notEqual(document.activeElement, first, 'hover alone moves no focus')
  // Escape targets the focused element, not the mouse position: with focus
  // elsewhere in the pane, the button handler cannot fire.
  const figure = container.querySelector('.wm-kpi-figure')
  // A window bubble listener stands in for the ledger page closer.
  let windowCloses = 0
  const spy = () => { windowCloses += 1 }
  window.addEventListener('keydown', spy)
  try {
    await React.act(async () => {
      figure.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    await flush(2)
    assert.equal(container.querySelector('.wm-info-pop'), null, 'the pane dismisses the tip')
    assert.equal(T.$infoOpen.get(), null)
    assert.equal(windowCloses, 0, 'the ledger closer never fires')
    // Plain Escape with no tip open still propagates as before.
    await React.act(async () => {
      figure.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    await flush(2)
    assert.equal(windowCloses, 1, 'navigation is preserved when no tip is open')
  } finally {
    window.removeEventListener('keydown', spy)
  }
})

test('the cache popover carries the coverage breakdown', async () => {
  resetHost()
  host.state.focusedSessionId.set('s1')
  host.state.focusedUsage.set(liveUsage())
  const container = await renderMeter()
  await flush()
  const method = container.querySelector('[aria-controls="wm-info-cache-coverage"]')
  assert.ok(method, 'the cache title keeps its coverage help button')
  await React.act(async () => {
    method.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
  await flush(2)
  const pop = container.querySelector('#wm-info-cache-coverage')
  assert.ok(pop, 'the methodology popover opens')
  assert.match(pop.textContent, /cacheMethodInfo/)
  assert.match(pop.textContent, /cacheCoverageLine/, 'the exact/estimated breakdown moved here')
})

test('Coverage has its own keyboard-operable explanation', async () => {
  resetHost()
  host.state.focusedSessionId.set('runtime-coverage')
  host.state.focusedStoredSessionId.set('stored-coverage')
  const ledger = T.emptyLedger()
  ledger.sessions['stored-coverage'] = histBucket({
    input: 100, cacheRead: 200, cacheWrite: 0, calls: 1,
    cacheCoveredPrompt: 300, cacheCoveredRead: 200, cacheExactPrompt: 300,
    netSavingsPrompt: 200,
  })
  T.$ledger.set(ledger)
  const container = await renderMeter()
  await flush()
  const button = container.querySelector('[aria-controls="wm-info-cache-coverage"]')
  assert.ok(button, 'the Coverage value has its own help button')
  assert.equal(button.tagName, 'BUTTON', 'the help trigger is a native keyboard control')
  assert.equal(button.getAttribute('aria-label'), 'coverageHelpLabel')
  await React.act(async () => { button.focus() })
  await flush(2)
  assert.equal(button.getAttribute('aria-expanded'), 'true')
  assert.equal(button.getAttribute('aria-describedby'), 'wm-info-cache-coverage')
  const pop = container.querySelector('#wm-info-cache-coverage')
  assert.equal(pop?.getAttribute('role'), 'tooltip')
  assert.match(pop?.textContent || '', /cacheCoverageHelp/)
})

test('the savings label keeps its methodology tooltip', async () => {
  resetHost()
  host.state.focusedSessionId.set('runtime-9')
  host.state.focusedStoredSessionId.set('stored-9')
  host.state.model.set('gpt-4o')
  const ledger = T.emptyLedger()
  ledger.sessions['stored-9'] = histBucket()
  T.$ledger.set(ledger)
  const container = await renderMeter()
  await flush()
  const savings = container.querySelector('[aria-controls="wm-info-read-benefit"]')
  assert.ok(savings, 'the cache-read figure keeps its info button')
  await React.act(async () => {
    savings.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
  await flush(2)
  const pop = container.querySelector('#wm-info-read-benefit')
  assert.ok(pop, 'the cache-read popover opens')
  assert.match(pop.textContent, /readBenefitSessionExplanation/)
  assert.ok(pop.classList.contains('wm-info-pop-wide'), 'the narrow column gets the wide popover')
  assert.ok(pop.classList.contains('wm-info-up'), 'the low-anchored popover opens upward')
})

test('per-MTok rates never show float artefacts', () => {
  assert.equal(T.fmtRate(3), '$3')
  assert.equal(T.fmtRate(0.3), '$0.3')
  assert.equal(T.fmtRate(0.1 + 0.2), '$0.3')
  assert.equal(T.fmtRate(0.075), '$0.075')
  assert.equal(T.fmtRate(null), '—')
  assert.equal(T.fmtRate(Number.NaN), '—')
})

test('sub-grid positive rates never render as free', () => {
  assert.equal(T.fmtRate(0.00001), '$0.00001')
  assert.equal(T.fmtRate(0.00004), '$0.00004')
  assert.equal(T.fmtRate(0.00005), '$0.0001')
  assert.equal(T.fmtRate(0), '$0')
})

test('the pane root cannot collide with the analytics cache bar', async () => {
  resetHost()
  host.state.focusedSessionId.set('s1')
  host.state.focusedUsage.set(liveUsage())
  const container = await renderMeter()
  await flush()
  assert.ok(container.querySelector('.wm-pane'), 'the pane renders under its own class')
  assert.equal(container.querySelector('.wm-meter'), null)
})

// --- direct component checks ------------------------------------------------------
test('the composition bar labels every part with its share', async () => {
  resetHost()
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = ReactDOMClient.createRoot(container)
  roots.push(root)
  const view = { bucket: { input: 100, output: 50, cacheRead: 300, cacheWrite: 100, calls: 2, cacheSource: 'exact' }, usage: null }
  await React.act(async () => {
    root.render(React.createElement(T.TokenComposition, { t: key => key, view }))
  })
  const bar = container.querySelector('.wm-mix-bar')
  assert.match(bar.getAttribute('aria-label'), /20%/)
  assert.match(bar.getAttribute('aria-label'), /60%/)
  const fills = [...bar.querySelectorAll('.wm-mix-fill')].map(el => el.style.width)
  assert.deepEqual(fills, ['20%', '60%', '20%', '0%'])
  const partialBucket = T.readUsage({ input: 500, prompt: 1000, output: 0, calls: 1, cache_hit_pct: 40 })
  await React.act(async () => {
    root.render(React.createElement(T.TokenComposition, {
      t: key => key === 'unclassifiedPromptTokens' ? 'unclassified prompt' : key,
      view: { bucket: partialBucket, usage: null }
    }))
  })
  const partialBar = container.querySelector('.wm-mix-bar')
  const unknownLegend = [...container.querySelectorAll('.wm-legend-item')]
    .find(item => item.textContent.includes('unclassified prompt'))
  assert.ok(unknownLegend, 'a visible unknown segment has a compact legend label')
  assert.equal(unknownLegend.querySelector('.wm-legend-value').textContent, '100',
    'the residual count renders bare and exact: the label and swatch already qualify it')
  assert.doesNotMatch(unknownLegend.textContent, /[+≈]/,
    'no legacy markers on the unclassified row')
  assert.equal(partialBar.querySelector('[data-part="unknown"]').style.width, '10%')
})

// --- WP13: compact sidebar ------------------------------------------------------
const WP13_LONG_MODEL = 'claude-opus-4-6-thinking-20250601-xlarge-extended-reasoning'

const renderHeader = async (view, presence = 'live', t = key => key) => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = ReactDOMClient.createRoot(container)
  roots.push(root)
  await React.act(async () => {
    root.render(React.createElement(T.MeterHeader, { presence, t, view }))
  })
  return container
}

test('the model label is readable while its exact ID stays in the title', async () => {
  resetHost()
  host.state.focusedSessionId.set('s1')
  host.state.focusedUsage.set(liveUsage({ model: WP13_LONG_MODEL }))
  const container = await renderMeter()
  await flush()
  const model = container.querySelector('.wm-model')
  assert.equal(model.textContent, 'Claude Opus 4.6 Thinking 20250601 XLarge Extended Reasoning')
  assert.equal(model.getAttribute('title'), WP13_LONG_MODEL, 'the tooltip carries the full name')
  assert.ok(container.querySelector('.wm-model-name-row button'), 'the exact ID has a focusable disclosure')
  const badge = container.querySelector('.wm-provider-badge')
  assert.equal(badge, null, 'an unknown provider is not added as sidebar clutter')
})

test('provider-prefixed model IDs have a readable name and keyboard disclosure', async () => {
  const enT = (key, ...args) => {
    const entry = T.I18N.en[key]
    return typeof entry === 'function' ? entry(...args) : entry
  }
  const id = 'deepseek/deepseek-v4.1-flash'
  const container = await renderHeader({ model: id, provider: 'deepseek', fromHistory: true }, 'recorded', enT)
  assert.equal(container.querySelector('.wm-model').textContent, 'DeepSeek V4.1 Flash')
  assert.equal(container.querySelector('.wm-model').title, id)
  assert.equal(container.querySelector('.wm-model-name-row').nextElementSibling.className, 'wm-provider-badge')
  const disclosure = container.querySelector('.wm-model-name-row [aria-label="Exact model ID"]')
  assert.ok(disclosure)
  await React.act(async () => { disclosure.focus() })
  assert.equal(container.querySelector('#wm-info-model-id').textContent, `Exact model ID: ${id}`)
  assert.equal(T.modelDisplayName('deepseek/deepseek-v4.2-flash'), 'DeepSeek V4.2 Flash')
  assert.notEqual(T.modelDisplayName('deepseek/deepseek-v4.1-flash'), T.modelDisplayName('deepseek/deepseek-v4.2-flash'))
  assert.equal(T.modelDisplayName('google/gemma-3-4b-it'), 'Gemma 3 4b It')
  assert.equal(T.modelDisplayName('anthropic/claude-opus-4-6'), 'Claude Opus 4.6')
})

test('a recorded route renders the provider badge with the membership label', async () => {
  resetHost()
  host.state.focusedSessionId.set('runtime-9')
  host.state.focusedStoredSessionId.set('stored-9')
  host.state.model.set('gpt-4o')
  const ledger = T.emptyLedger()
  ledger.sessions['stored-9'] = histBucket({ provider: 'anthropic' })
  T.$ledger.set(ledger)
  const container = await renderMeter()
  await flush()
  const badge = container.querySelector('.wm-provider-badge')
  assert.equal(badge.textContent, 'memProviderAnthropic', 'mapped providers localise')
  assert.equal(badge.getAttribute('title'), 'providerTip')
})

test('an unmapped provider prints its id as-is with the raw-id tooltip', async () => {
  const container = await renderHeader({ model: 'gpt-4o', provider: 'openai', fromHistory: true })
  const badge = container.querySelector('.wm-provider-badge')
  assert.equal(badge.textContent, 'openai')
  assert.equal(badge.getAttribute('title'), 'providerTip')
  const unknown = await renderHeader({ model: 'gpt-4o', provider: null, fromHistory: false })
  const unknownBadge = unknown.querySelector('.wm-provider-badge')
  assert.equal(unknownBadge, null, 'the normal header omits an unknown provider message')
})

test('the provider badge tooltip carries the raw provider id', async () => {
  const enT = (key, ...args) => {
    const entry = T.I18N.en[key]
    return typeof entry === 'function' ? entry(...args) : entry
  }
  const mapped = await renderHeader({ model: 'gpt-4o', provider: 'anthropic', fromHistory: true }, 'recorded', enT)
  const mappedBadge = mapped.querySelector('.wm-provider-badge')
  assert.equal(mappedBadge.textContent, 'Anthropic')
  assert.match(mappedBadge.getAttribute('title'), /anthropic/, 'the mapped badge keeps the raw id in its tooltip')
  const raw = await renderHeader({ model: 'gpt-4o', provider: 'openai', fromHistory: true }, 'recorded', enT)
  const rawBadge = raw.querySelector('.wm-provider-badge')
  assert.equal(rawBadge.textContent, 'openai')
  assert.match(rawBadge.getAttribute('title'), /openai/, 'the unmapped badge keeps the raw id in its tooltip')
})

test('the WP13 labels exist in English and Chinese', () => {
  const { en, zh } = T.I18N
  assert.equal(en.openLedger, 'Open SpendSense')
  assert.equal(zh.openLedger, '打开 SpendSense')
  assert.equal(en.memProviderAnthropic, 'Anthropic')
  assert.equal(zh.memProviderAnthropic, 'Anthropic 服务')
  assert.match(en.providerTip('acme'), /acme/)
  assert.match(zh.providerTip('acme'), /acme/)
  assert.ok(en.providerUnknown.length > 0 && zh.providerUnknown.length > 0)
  assert.ok(en.providerUnknownTip.length > 0 && zh.providerUnknownTip.length > 0)
})

test('the open-ledger button routes to the ledger from the live meter', async () => {
  resetHost()
  host.state.focusedSessionId.set('s1')
  host.state.focusedUsage.set(liveUsage())
  const container = await renderMeter()
  await flush()
  const button = container.querySelector('.wm-meter-sections .wm-open-ledger')
  assert.ok(button, 'the live meter offers the ledger action')
  assert.equal(button.tagName, 'BUTTON', 'a native button stays keyboard-operable')
  assert.equal(button.getAttribute('type'), 'button')
  assert.equal(button.getAttribute('tabindex'), null, 'the button stays in the tab order')
  assert.equal(button.textContent, 'openLedger')
  const seen = []
  const orig = host.navigate
  define('location', dom.window.location)
  define('history', dom.window.history)
  dom.window.location.hash = '#/chat/return-test'
  host.navigate = route => seen.push(route)
  try {
    await React.act(async () => {
      button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    })
    await flush(2)
  } finally {
    host.navigate = orig
  }
  assert.deepEqual(seen, ['/spend-sense'])
  assert.equal([...container.querySelectorAll('button')].some(el => el.textContent === 'readBenefitUsageLink'), false,
    'the pane has no redundant Usage link')
  host.navigate = orig
  delete globalThis.location
  delete globalThis.history
})

test('the empty state offers the ledger action', async () => {
  resetHost()
  host.state.focusedSessionId.set('brand-new')
  const container = await renderMeter()
  await flush()
  const button = container.querySelector('.wm-meter-empty .wm-open-ledger')
  assert.ok(button, 'the empty state offers the ledger action')
  assert.equal(button.tagName, 'BUTTON', 'a native button stays keyboard-operable')
  const seen = []
  const orig = host.navigate
  host.navigate = route => seen.push(route)
  try {
    await React.act(async () => {
      button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    })
    await flush(2)
  } finally {
    host.navigate = orig
  }
  assert.deepEqual(seen, ['/spend-sense'])
})

test('the meter stylesheet pins the compact container rules', () => {
  assert.match(T.METER_CSS, /container-type:\s*inline-size/, 'the pane is a container')
  assert.match(T.METER_CSS, /@container[^{]*max-width:\s*320px/, 'the 320px compact query exists')
  assert.match(T.METER_CSS, /wm-gauge-stat\[data-kind="saved"\]/, 'the savings value has its own responsive row')
  assert.match(T.METER_CSS, /--wm-gauge-ring:68px/, 'the narrow gauge keeps the larger legible ring')
  assert.match(T.METER_CSS, /\.wm-open-ledger/, 'the ledger button is styled')
})
