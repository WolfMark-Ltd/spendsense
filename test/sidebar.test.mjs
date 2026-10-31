// Run: node --test test/
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
export { QueryClientProvider, queryClient, host, gatewayActivationEpoch, __bumpActivation } from '@hermes/plugin-sdk'
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
const { plugin, T, React, ReactDOMClient, QueryClientProvider, queryClient, host, __bumpActivation } = lib

const storageSets = []
const intervals = new Set()
plugin.register({
  rest: async () => ({ ok: true }),
  storage: { get: (_k, d) => d, set: (k, v) => { storageSets.push([k, v]) }, delete() {} },
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

const sectionsOf = container => ({
  head: container.querySelector('.wm-meter-head'),
  cards: [...container.querySelectorAll('.wm-meter-sections .wm-card')],
})

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
  assert.deepEqual(during.cards, before.cards, 'all four cards keep their DOM nodes')
  assert.match(container.textContent, /meterUpdating/)
  assert.ok(container.querySelector('.wm-meter-sections.wm-stale'), 'stale readings are dimmed')
  assert.equal(container.querySelector('.wm-kpi-figure').textContent, figureBefore,
    'the retained figure does not flash to a placeholder')

  // The stream returns with bigger counters.
  host.state.focusedUsage.set(liveUsage({ input: 2400, calls: 3 }))
  await flush()
  const afterGap = sectionsOf(container)
  assert.equal(afterGap.head, before.head, 'header node survives the round trip')
  assert.deepEqual(afterGap.cards, before.cards, 'cards survive the round trip')
  assert.doesNotMatch(container.textContent, /meterUpdating/)
  assert.match(container.textContent, /meterLive/)
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
  assert.deepEqual(afterModel.cards, before.cards)
  assert.equal(container.querySelector('.wm-model').textContent, 'gpt-5')
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

test('recorded conversation totals render exactly with recorded presence', async () => {
  resetHost()
  host.state.focusedSessionId.set('runtime-9')
  host.state.focusedStoredSessionId.set('stored-9')
  host.state.model.set('gpt-4o')
  const ledger = T.emptyLedger()
  ledger.sessions['stored-9'] = histBucket()
  T.$ledger.set(ledger)
  const container = await renderMeter()
  await flush()
  assert.equal(container.querySelector('.wm-kpi-figure').textContent, '$1.23')
  assert.match(container.textContent, /meterRecorded/)
  assert.match(container.textContent, /scopeConversation/)
  const metrics = [...container.querySelectorAll('.wm-metric-value')].map(el => el.textContent)
  assert.ok(metrics.includes('1.39M'), `total tokens: ${metrics}`)
  assert.ok(metrics.includes('57'), `calls: ${metrics}`)
  const ring = container.querySelector('.wm-ring')
  assert.match(ring.getAttribute('aria-label'), /75%/)
  const expected = (1000000 / 1328500) * T.RING_C
  const dash = ring.querySelector('.wm-ring-value').getAttribute('stroke-dasharray')
  assert.ok(Math.abs(parseFloat(dash) - expected) < 1e-6, `ring arc ${dash} matches 75.27%`)
  assert.match(container.textContent, /exactLabel/)
  assert.doesNotMatch(container.textContent, /≈/)
  // Compact gauge metrics: coverage beside the ring, savings beneath it.
  const stats = container.querySelector('.wm-gauge-stats').textContent
  assert.match(stats, /coverageLabel/)
  assert.match(stats, /100%/)
  assert.match(stats, /savedTotal/)
  assert.match(stats, /\$0\.50/)
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
  assert.match(ringAfter.getAttribute('aria-label'), /≈50%/)
  assert.match(ringAfter.getAttribute('aria-label'), /estimatedLabel/)
  assert.ok(ringAfter.querySelector('.wm-ring-value').classList.contains('wm-ring-estimated'),
    'reconstructed coverage dims the ring')
  const estMetrics = [...container.querySelectorAll('.wm-kpi-metrics .wm-metric-value')]
    .map(el => el.textContent)
  assert.ok(estMetrics[0].startsWith('≈'), `reconstructed totals carry ≈: ${estMetrics}`)
  assert.equal(container.querySelectorAll('.wm-gauge-stats .wm-gauge-note').length, 0,
    'no exact/estimated label sits under the unavailable savings value')
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
  assert.deepEqual(afterBump.cards, before.cards)
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

// --- info popovers ---------------------------------------------------------------
test('info popovers open on click and close on Escape', async () => {
  resetHost()
  host.state.focusedSessionId.set('s1')
  host.state.focusedUsage.set(liveUsage())
  const container = await renderMeter()
  await flush()
  const buttons = [...container.querySelectorAll('.wm-info-btn')]
  assert.ok(buttons.length >= 3, `info buttons render: ${buttons.length}`)
  const first = buttons[0]
  assert.equal(first.getAttribute('aria-expanded'), 'false')
  assert.equal(container.querySelector('.wm-info-pop'), null)

  await React.act(async () => {
    first.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
  await flush(2)
  assert.equal(first.getAttribute('aria-expanded'), 'true')
  const pop = container.querySelector('.wm-info-pop')
  assert.ok(pop, 'popover opens')
  assert.equal(pop.getAttribute('role'), 'tooltip')
  assert.ok(pop.textContent.length > 20, 'popover explains the methodology')

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

test('the cache popover carries the coverage breakdown', async () => {
  resetHost()
  host.state.focusedSessionId.set('s1')
  host.state.focusedUsage.set(liveUsage())
  const container = await renderMeter()
  await flush()
  const method = container.querySelector('[aria-controls="wm-info-cache-method"]')
  assert.ok(method, 'the cache title keeps its info button')
  await React.act(async () => {
    method.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
  await flush(2)
  const pop = container.querySelector('#wm-info-cache-method')
  assert.ok(pop, 'the methodology popover opens')
  assert.match(pop.textContent, /cacheMethodInfo/)
  assert.match(pop.textContent, /cacheCoverageLine/, 'the exact/estimated breakdown moved here')
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
  const savings = container.querySelector('[aria-controls="wm-info-savings-method"]')
  assert.ok(savings, 'the savings label keeps its info button')
  await React.act(async () => {
    savings.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
  await flush(2)
  const pop = container.querySelector('#wm-info-savings-method')
  assert.ok(pop, 'the savings popover opens')
  assert.match(pop.textContent, /savingsInfo/)
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
  const view = { bucket: { input: 100, output: 50, cacheRead: 300, cacheWrite: 100, calls: 2 }, usage: null }
  await React.act(async () => {
    root.render(React.createElement(T.TokenComposition, { t: key => key, view }))
  })
  const bar = container.querySelector('.wm-mix-bar')
  assert.match(bar.getAttribute('aria-label'), /20%/)
  assert.match(bar.getAttribute('aria-label'), /60%/)
  const fills = [...bar.querySelectorAll('.wm-mix-fill')].map(el => el.style.width)
  assert.deepEqual(fills, ['20%', '60%', '20%'])
})
