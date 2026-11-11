import React from 'react'
import { createRoot } from 'react-dom/client'
import plugin, { __test as T } from '../desktop/plugin.js'

// Clearly synthetic fixture: invented providers/models, round-ish figures,
// plus unpriced/unknown/partial states so every honesty path renders.
const row = (i = 0) => ({
  tokens: 120000 - i * 1500, calls: 140 - i, input_tokens: 24000, output_tokens: 12000,
  cache_read_tokens: 72000 - i * 1500, cache_write_tokens: 12000,
  list_usd: i === 27 ? null : 9.6 - i * 0.2,
  priced_tokens: i === 27 ? 0 : 120000 - i * 1500, unpriced_tokens: i === 27 ? 92000 : 150 * i,
  unpriced_calls: i % 9 === 0 ? 2 : 0, fallback_calls: i % 7 === 0 ? 1 : 0,
  cache_hit_rate: i === 27 ? null : 0.62 - i * 0.008,
  cache_known_calls: 90 - i, cache_unknown_calls: 12,
  billing_mix: i % 3 === 0 ? { api: 40 } : {},
  economics: { uncached_usd: 12 - i * 0.2, cached_usd: 8 - i * 0.2, savings_usd: i === 5 ? -0.4 : 3.2 - i * 0.06, coverage: 0.82, covered_tokens: 98000, covered_calls: 96, excluded_calls: 8 },
})
const byModel = Array.from({ length: 30 }, (_, i) => ({
  model: i === 0 ? 'synthetic-very-long-model-name-for-narrow-width-wrapping-checks' : `synthetic-model-${i}`,
  provider: i === 13 ? '' : `synthetic-provider-${i % 3}`,
  ...row(i),
}))
const totals = {
  ...row(0), tokens: 3141592, calls: 1234, input_tokens: 640000, output_tokens: 320000,
  cache_read_tokens: 1900000, cache_write_tokens: 281592, list_usd: 82.4,
  priced_tokens: 3014592, unpriced_tokens: 127000, unpriced_calls: 6,
  cache_hit_rate: 0.61, cache_prompt_coverage: 0.66,
  billed_usd: 18.2, billed_complete: false, billing_mix: { api: 900, included: 300 },
}
const fixture = {
  ok: true,
  window: { since: '2026-11-04T00:00:00Z', until: '2026-11-11T00:00:00Z', days: 7, timezone: 'Europe/London', since_local: '2026-11-04T00:00:00+00:00', until_local: '2026-11-11T00:00:00+00:00' },
  totals,
  economics: totals.economics,
  pricing_coverage: { coverage: 0.96 },
  previous: { comparable: true, deltas: { list_usd: 0.125, tokens: -0.042 } },
  options: {
    models: byModel.map(r => ({ model: r.model, provider: r.provider })),
    providers: ['synthetic-provider-0', 'synthetic-provider-1', 'synthetic-provider-2'],
    surfaces: ['cli', 'telegram'],
    tasks: ['main', 'aux'],
    operations: [
      { parent: 'synthetic nightly research sweep over many sources', subagent_calls: 42 },
      { parent: 'synthetic release triage', subagent_calls: 9 },
    ],
  },
  by_model: byModel,
  by_route: ['synthetic-provider-0', 'synthetic-provider-1', 'synthetic-provider-2'].map((provider, i) => ({ provider, ...row(i * 4) })),
  by_scope: [
    { scope: 'direct', ...row(1) },
    { scope: 'subagent', ...row(3) },
    { scope: 'auxiliary', ...row(6) },
  ],
  attribution: { child_sessions: 37, unattributed_calls: 5 },
  trend: {
    granularity: 'day',
    buckets: Array.from({ length: 7 }, (_, i) => ({
      ts: `2026-11-${String(i + 4).padStart(2, '0')}T00:00:00Z`, ts_local: `2026-11-${String(i + 4).padStart(2, '0')}T00:00:00+00:00`,
      input_usd: 1.1, output_usd: 0.9, cache_read_usd: 0.2, cache_write_usd: 0.1,
      ...row(i),
    })),
  },
  recording: { since: '2026-10-01T00:00:00Z', last: '2026-11-10T18:00:00Z', calls: 1234 },
  notes: ['Recorded calls only. Synthetic fixture note.'],
  note_codes: [],
}

plugin.register({
  rest: async path => {
    if (String(path).startsWith('/analytics?')) return fixture
    return { ok: true }
  },
  storage: { get: (_key, fallback) => fallback, set() {}, delete() {} },
  register() {}, registerMany() {}, onDispose() {}, onEvent: () => () => {},
  setTimeout: fn => { const timer = setTimeout(fn, 0); return () => clearTimeout(timer) },
  setInterval: () => () => {}, addEventListener: () => () => {},
  os: {}, pet: null, i18n: { register() {}, t: key => key },
})

const params = new URLSearchParams(location.search)
// Locale is fixed per run (see sdk note); ?case= selects one case for shots.
globalThis.__usageI18N = T.I18N
globalThis.__usageLocale = params.get('locale') || 'en'
// One shared state for every case: three active filters (including a very
// long model name) so chips render, and a selected trend point so the exact
// chart detail renders. The scope matches the stub host identity.
const usageScope = T.analyticsScope('test', 'connected', 'local')
T.$analytics.set({ [usageScope]: { ...T.analyticsInitialState(), trendIndex: 0, filters: { model: 'synthetic-very-long-model-name-for-narrow-width-wrapping-checks', provider: '', surface: 'telegram', task: '', parent: '', scope: 'subagent' } } })

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

async function measure() {
  await tick(1200)
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
  const output = { layouts: [], errors: window.__usageErrors || [], queryErrors: globalThis.__usageQueryErrors || [] }
  for (const id of cases) {
    const pane = document.getElementById(id)
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
      numbers: [...pane.querySelectorAll('.wm-panel .wm-number')].map(el => el.textContent),
      sections: pane.querySelectorAll('section.wm-panel').length,
      stats: stats.length,
      statGroups: [...pane.querySelectorAll('[data-kpi-group]')].map(el => el.dataset.kpiGroup),
      selects: pane.querySelectorAll('select').length,
      advancedFilters: !!advanced,
      advancedOpen: !!advanced?.open,
      advancedSummary: advanced?.querySelector('summary')?.textContent || '',
      advancedSelects: advanced ? advanced.querySelectorAll('select').length : 0,
      advancedRowOverlap: overlapPairs(advancedRowFilters),
      advancedRowOverflow: advancedRow && advancedRow.scrollWidth - advancedRow.clientWidth > 1 ? 1 : 0,
      stickyColumnWidth: firstCell ? firstCell.offsetWidth : 0,
      tableViewportWidth: tableWrap ? tableWrap.clientWidth : 0,
      filterOverlap: overlapPairs(filters),
      chipOverlap: overlapPairs(chips),
      chips: chips.length,
      filtersOverflow: filters.filter(el => el.scrollWidth - el.clientWidth > 1).length,
      statOverflow,
      chartKeyDots: dots.length,
      chartKeySwatches: [swatch(0), swatch(1), swatch(2), swatch(3)],
      trendPoints: trendPoints.length,
      trendTitles: trendPoints.filter(el => (el.querySelector('title')?.textContent || '').length > 0).length,
      legendTitles: legendRows.filter(el => (el.getAttribute('title') || '').length > 0).length,
      legendRows: legendRows.length,
      explorerColumns: pane.querySelectorAll('thead th').length,
      firstColumnSticky: (() => {
        const cell = pane.querySelector('tbody td:first-child')
        return cell ? getComputedStyle(cell).position : 'none'
      })(),
      methodologyOpen: (() => {
        // Methodology is the only disclosure that is neither the advanced
        // filters nor the baseline; match it by exclusion so the open
        // advanced row cannot masquerade as an open Methodology.
        const rest = [...pane.querySelectorAll('.wm-shell details')]
          .filter(el => !el.hasAttribute('data-filters-advanced') && !el.classList.contains('wm-baseline'))
        return rest.length === 1 && !!rest[0].open
      })(),
      baselineOpen: !!pane.querySelector('details.wm-baseline')?.open,
      text: shell.textContent,
    })
  }
  // Interaction probe on the first case only: all cases share one analytics
  // atom, so clicks here re-render every pane. Layout above is recorded first.
  // Skipped in single-case screenshot mode so shots show the pristine state.
  output.interaction = selected ? null : await interactionProbe()
  document.getElementById('usage-layout-result').textContent = JSON.stringify(output)
}

async function interactionProbe() {
  const probe = document.getElementById(cases[0])
  const probeChips = () => [...probe.querySelectorAll('.wm-scopechips button')]
  const probeSummary = () => probe.querySelector('[data-filters-advanced] summary')?.textContent || ''
  const interaction = { chipsBefore: probeChips().length, summaryBefore: probeSummary() }
  const surfaceChip = probeChips()[1]
  if (surfaceChip) {
    surfaceChip.click()
    await tick(300)
    interaction.chipsAfterSurface = probeChips().length
    interaction.summaryAfterSurface = probeSummary()
  }
  const modelChip = probeChips()[0]
  if (modelChip) {
    modelChip.click()
    await tick(300)
    interaction.chipsAfterModel = probeChips().length
  }
  const toggle = probe.querySelector('[data-filters-advanced]')
  if (toggle) {
    const summary = toggle.querySelector('summary')
    const wasOpen = toggle.open
    summary.click()
    await tick(200)
    const closed = !toggle.open
    summary.click()
    await tick(200)
    interaction.disclosureToggle = wasOpen && closed && toggle.open
  }
  return interaction
}

window.addEventListener('error', event => {
  (window.__usageErrors = window.__usageErrors || []).push(String(event.message))
})
measure()
