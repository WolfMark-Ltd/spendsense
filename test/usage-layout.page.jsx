import React from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import plugin, { __test as T } from '../desktop/plugin.js'
import { USAGE_FILTERS, usageTransport } from './usage-fixtures.mjs'

const params = new URLSearchParams(location.search)
const fixtureState = params.get('state') || 'fixture'
// The payload lives in `usage-fixtures.mjs` so the browser and the browserless
// Usage suite render one synthetic dataset, not two that can drift.
plugin.register({
  rest: usageTransport({ requiredContract: T.REQUIRED_BACKEND_CONTRACT, state: fixtureState }),
  storage: { get: (_key, fallback) => fallback, set() {}, delete() {} },
  register() {}, registerMany() {}, onDispose() {}, onEvent: () => () => {},
  setTimeout: fn => { const timer = setTimeout(fn, 0); return () => clearTimeout(timer) },
  setInterval: () => () => {}, addEventListener: () => () => {},
  os: {}, pet: null, i18n: { register() {}, t: key => key },
})

// Locale is fixed per run (see sdk note); ?case= selects one case for shots.
globalThis.__usageI18N = T.I18N
globalThis.__usageLocale = params.get('locale') || 'en'
// One shared state for every case: three active filters (including a very
// long model name) so chips render, and a selected trend point so the exact
// chart detail renders. The scope matches the stub host identity.
const usageScope = T.analyticsScope('test', 'connected', 'local')
T.$analytics.set({ [usageScope]: { ...T.analyticsInitialState(), trendIndex: 0, filters: { ...USAGE_FILTERS } } })

const ALL = ['narrow-dark', 'wide-dark', 'narrow-light', 'wide-light']
const selected = params.get('case')
const cases = selected ? [selected] : ALL
const root = document.getElementById('usage-layout-cases')
for (const id of cases) {
  const override = selected && Number(params.get('width')) > 0 ? Number(params.get('width')) : 0
  const width = override || (id.startsWith('narrow') ? 380 : 1200)
  const theme = id.endsWith('dark') ? 'dark' : 'light'
  let container = document.getElementById(id)
  if (!container) {
    container = document.createElement('div')
    container.id = id
    container.className = 'case wm-analytics-host'
    root.appendChild(container)
  }
  container.classList.add(theme)
  container.style.width = `${width}px`
  if (selected) document.body.dataset.single = theme
  createRoot(container).render(React.createElement(T.AnalyticsPage))
}

const tick = (ms = 25) => new Promise(resolve => setTimeout(resolve, ms))
const parseColor = raw => {
  const text = String(raw)
  let m = text.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/)
  if (m) return { r: +m[1], g: +m[2], b: +m[3] }
  m = text.match(/color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/)
  return m ? { r: +m[1] * 255, g: +m[2] * 255, b: +m[3] * 255 } : null
}
const luminance = ({ r, g, b }) => {
  const f = c => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4 }
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}
const contrast = (fg, bg) => {
  const l1 = luminance(fg); const l2 = luminance(bg)
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
}
const effectiveBg = node => {
  let el = node
  while (el && el !== document.body) {
    const raw = getComputedStyle(el).backgroundColor
    const parsed = parseColor(raw)
    if (parsed && !String(raw).startsWith('rgba(0, 0, 0, 0') && !String(raw).endsWith(', 0)')) return parsed
    el = el.parentElement
  }
  return parseColor(getComputedStyle(document.body).backgroundColor) || { r: 255, g: 255, b: 255 }
}
const rectsOverlap = (a, b) => a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1
function overlapPairs(elements) {
  const rects = elements.map(el => el.getBoundingClientRect())
  const pairs = []
  for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
    if (rectsOverlap(rects[i], rects[j])) pairs.push([i, j])
  }
  return pairs
}

// Use the production styles on representative state elements, including the
// sidebar and product roots. Keep the fixture out of the Usage layout sample.
function measureStateStyles(pane) {
  const sample = document.createElement('div')
  sample.style.cssText = 'position:absolute;inset-inline-start:-10000px'
  sample.className = 'wm-analytics wm-product'
  // The native host uses an editor background instead of the older raised fill.
  if (!getComputedStyle(pane).getPropertyValue('--ui-warning').trim()) {
    sample.style.setProperty('--ui-fill-secondary', 'initial')
    sample.style.setProperty('--ui-bg-editor', getComputedStyle(pane).backgroundColor)
  }
  pane.append(sample)
  const root = createRoot(sample)
  flushSync(() => root.render(<>
    <style>{T.ANALYTICS_CSS + T.PRODUCT_CSS + T.ECONOMICS_CSS + T.MEMBERSHIP_CSS + T.NEWS_CSS + T.REPORTS_CSS}</style>
    <span className="wm-cost-attn-count">2</span>
    <div className="wm-membership-summary-card" data-tone="attention">Needs attention</div>
    <div className="wm-flash" style={{ animation: 'none' }}>Destination highlight</div>
    <span className="wm-status-chip" data-tone="attention">Partial</span>
    <span className="wm-status-chip" data-tone="error">Error</span>
    <span className="wm-status-chip" data-tone="positive">Ready</span>
    <p className="wm-async-status" data-status="error" role="alert">Could not save</p>
    <section className="wm-product-section">
      <p className="wm-warn-note" role="status">Hermes could not refresh model availability</p>
      <div className="wm-confirm-box">Confirm change</div>
    </section>
    <span className="wm-news-badge" data-cat="price_increase">Price increase</span>
    <div className="wm-digest-section" data-section="coverage">Attribution</div>
    <div className="wm-pane"><span className="wm-status-chip" data-tone="attention">Partial</span></div>
  </>))
  const css = selector => getComputedStyle(sample.querySelector(selector))
  const pill = css('.wm-cost-attn-count')
  const rail = css('.wm-membership-summary-card')
  const reports = css('.wm-digest-section')
  const properties = {
    pillBackground: pill.backgroundColor,
    pillContrast: contrast(parseColor(pill.color), parseColor(pill.backgroundColor)),
    rail: rail.borderLeft,
    reportsRail: reports.borderLeft,
    flash: css('.wm-flash').boxShadow,
    partial: css('[data-tone="attention"].wm-status-chip').color,
    sidebarPartial: css('.wm-pane .wm-status-chip').color,
    error: css('[data-tone="error"].wm-status-chip').color,
    success: css('[data-tone="positive"].wm-status-chip').color,
    feedback: css('.wm-async-status').color,
    settingsWarning: css('.wm-product-section > .wm-warn-note').color,
    confirmation: css('.wm-confirm-box').borderLeft,
    news: css('.wm-news-badge').color,
  }
  root.unmount()
  sample.remove()
  return properties
}

function chartPaint(pane, selector, property) {
  return [...pane.querySelectorAll(selector)].map(element => getComputedStyle(element)[property])
}

async function measure() {
  // Bounded readiness gate. A fixed wait measures whatever happens to be on
  // screen: an early read has produced empty contrast counts and '' copy on
  // unchanged revisions. Require the final structure every assertion below
  // measures; a page that missed the deadline is reported, so the failure names
  // the page rather than one downstream number.
  const READY_TIMEOUT_MS = 6000
  const structurallyReady = () => cases.every(id => {
    const pane = document.getElementById(id)
    if (!pane?.querySelector('.wm-shell')) return false
    return pane.querySelectorAll('section.wm-panel').length === 7
      && pane.querySelectorAll('.wm-stat').length === 3
      && pane.querySelectorAll('.wm-scopechips button').length === 3
      && pane.querySelectorAll('[data-trend-point]').length > 0
      && pane.querySelectorAll('.wm-tablewrap thead th').length === 7
  })
  let waitedMs = 0
  while (waitedMs < READY_TIMEOUT_MS && !structurallyReady()) {
    await tick(50)
    waitedMs += 50
  }
  const readiness = { ready: structurallyReady(), waitedMs }
  // The committed test opens every Advanced disclosure (?open=filters) so
  // the hidden filters get real layout and the overlap/overflow checks below
  // cover the advanced row too.
  if (params.get('open') === 'filters') {
    for (const advanced of document.querySelectorAll('[data-filters-advanced]')) advanced.open = true
    await tick(300)
  }
  if (selected && params.get('scroll') === 'explorer') {
    const wrap = document.querySelector('.wm-tablewrap')
    if (wrap) wrap.scrollLeft = 260
    await tick(300)
  }
  const output = { layouts: [], readiness, errors: window.__usageErrors || [], queryErrors: globalThis.__usageQueryErrors || [] }
  const cacheReadPaint = (pane, tag, prop) => {
    const segment = pane.querySelectorAll(`svg[data-chart="composition"] ${tag}[role="button"]`)[2]
    return segment ? getComputedStyle(segment)[prop] : null
  }
  for (const id of cases) {
    const pane = document.getElementById(id)
    const usageRoot = pane.querySelector('.wm-analytics')
    const shell = pane.querySelector('.wm-shell')
    if (!shell) {
      output.layouts.push({ id, missingUsage: true })
      continue
    }
    const filters = [...pane.querySelectorAll('.wm-filters .wm-filter, .wm-filters .wm-button')]
    const chips = [...pane.querySelectorAll('.wm-scopechips button')]
    const dots = [...pane.querySelectorAll('.wm-chartkey .wm-dot')]
    const swatch = index => {
      if (!dots[index]) return null
      const fg = parseColor(getComputedStyle(dots[index]).backgroundColor)
      const bg = parseColor(getComputedStyle(pane).backgroundColor)
      return fg && bg ? { color: getComputedStyle(dots[index]).backgroundColor, ratio: +contrast(fg, bg).toFixed(2) } : null
    }
    const palette = T.CHART_COLORS.map(color => {
      const sample = document.createElement('span')
      sample.style.cssText = 'position:absolute;inset-inline-start:-10000px'
      sample.style.color = color
      pane.append(sample)
      const computed = getComputedStyle(sample).color
      const fg = parseColor(computed)
      const bg = parseColor(getComputedStyle(pane).backgroundColor)
      sample.remove()
      return fg && bg ? { color: computed, ratio: +contrast(fg, bg).toFixed(2) } : null
    })
    const stats = [...pane.querySelectorAll('.wm-stat')]
    const statOverflow = stats.filter(el => el.scrollWidth - el.clientWidth > 1).length
    const trendPoints = [...pane.querySelectorAll('[data-trend-point]')]
    const legendRows = [...pane.querySelectorAll('.wm-legend .wm-legendrow')]
    const advanced = pane.querySelector('[data-filters-advanced]')
    const advancedRow = pane.querySelector('.wm-advancedrow')
    const advancedRowFilters = advanced ? [...advanced.querySelectorAll('.wm-filter')] : []
    const tableWrap = pane.querySelector('.wm-tablewrap')
    const firstCell = pane.querySelector('tbody td:first-child')
    output.layouts.push({
      id, width: pane.clientWidth,
      mainScrollDelta: Math.max(0, pane.scrollHeight - pane.clientHeight),
      usageScrollDelta: Math.max(0, usageRoot.scrollHeight - usageRoot.clientHeight),
      usageOverflowY: getComputedStyle(usageRoot).overflowY,
      // The page title is the locale guard: it proves this run rendered the
      // language its per-locale assertions assume.
      headingStart: pane.querySelector('.wm-topline > div > :first-child')?.textContent,
      sections: pane.querySelectorAll('section.wm-panel').length,
      stats: stats.length,
      readBenefit: pane.querySelector('#wm-usage-read-benefit .wm-statvalue')?.textContent || '',
      selects: pane.querySelectorAll('select').length,
      advancedFilters: !!advanced,
      // The advanced row's own height: a collapsed `<details>` measures zero
      // and every overlap/overflow assertion below would then pass on nothing.
      advancedRowHeight: advancedRow ? Math.round(advancedRow.getBoundingClientRect().height) : 0,
      advancedRowOverlap: overlapPairs(advancedRowFilters),
      advancedRowOverflow: advancedRow && advancedRow.scrollWidth - advancedRow.clientWidth > 1 ? 1 : 0,
      stickyColumnWidth: firstCell ? firstCell.offsetWidth : 0,
      tableViewportWidth: tableWrap ? tableWrap.clientWidth : 0,
      tableOverflowX: tableWrap ? getComputedStyle(tableWrap).overflowX : '',
      tableOverflowY: tableWrap ? getComputedStyle(tableWrap).overflowY : '',
      tableVerticalDelta: tableWrap ? Math.max(0, tableWrap.scrollHeight - tableWrap.clientHeight) : 0,
      filterOverlap: overlapPairs(filters),
      chipOverlap: overlapPairs(chips),
      chips: chips.length,
      filtersOverflow: filters.filter(el => el.scrollWidth - el.clientWidth > 1).length,
      statOverflow,
      stateStyles: measureStateStyles(pane),
      warningToken: getComputedStyle(pane).getPropertyValue('--ui-warning').trim(),
      cacheReadFill: cacheReadPaint(pane, 'rect', 'fill'),
      chartPaint: {
        distribution: chartPaint(pane, '.wm-legend .wm-barfill', 'backgroundColor'),
        trend: chartPaint(pane, 'svg[data-chart="trend"] > path, svg[data-chart="trend"] circle', 'fill'),
        comparisons: chartPaint(pane, '.wm-comparetrack, .wm-comparetrack > span', 'backgroundColor'),
        ranking: chartPaint(pane, 'svg[data-chart="ranking"] rect', 'fill'),
        composition: chartPaint(pane, 'svg[data-chart="composition"] rect', 'fill'),
      },
      chartKeyDots: dots.length,
      chartKeySwatches: [swatch(0), swatch(1), swatch(2), swatch(3)],
      chartPalette: palette,
      trendPoints: trendPoints.length,
      legendRows: legendRows.length,
      explorerColumns: pane.querySelectorAll('thead th').length,
      firstColumnSticky: (() => {
        const cell = pane.querySelector('tbody td:first-child')
        return cell ? getComputedStyle(cell).position : 'none'
      })(),
      text: shell.textContent,
    })
  }
  const compositionToggle = document.querySelector('svg[data-chart="composition"]')
    ?.closest('section').querySelectorAll('.wm-segments button')
  if (compositionToggle?.length === 2 && !selected) {
    compositionToggle[1].click()
    await tick(100)
    for (const layout of output.layouts) {
      const pane = document.getElementById(layout.id)
      layout.cacheReadStroke = cacheReadPaint(pane, 'circle', 'stroke')
      layout.chartPaint.doughnut = chartPaint(pane, 'svg[data-chart="composition"] circle', 'stroke')
    }
    compositionToggle[0].click()
    await tick(100)
  }
  // Interaction probe on the first case only: the remainder list's scroll
  // geometry is the part a browser alone can report. The chip and disclosure
  // counts the probe used to record are asserted in jsdom against the real
  // component (`usage-render.test.mjs`).
  output.interaction = selected ? null : await interactionProbe()
  // Re-read the shared error array: output initialised before the probe, and
  // the listener creates the array lazily, so the initial snapshot can miss
  // probe-phase errors.
  output.errors = window.__usageErrors || []
  document.getElementById('usage-layout-result').textContent = JSON.stringify(output)
}

async function interactionProbe() {
  const probe = document.getElementById(cases[0])
  const interaction = {}
  const allState = T.$analytics.get()
  const current = allState[usageScope] || T.analyticsInitialState()
  T.$analytics.set({ ...allState, [usageScope]: { ...current, otherOpen: true } })
  await tick(300)
  const remainder = probe.querySelector('.wm-remainder')
  interaction.otherListOverflowY = remainder ? getComputedStyle(remainder).overflowY : ''
  interaction.otherListVerticalDelta = remainder
    ? Math.max(0, remainder.scrollHeight - remainder.clientHeight)
    : -1
  return interaction
}

window.addEventListener('error', event => {
  (window.__usageErrors = window.__usageErrors || []).push(String(event.message))
})
measure()
