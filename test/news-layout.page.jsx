// WP11 Model News layout harness page: renders the REAL NewsPage from
// desktop/plugin.js's `__test` export (no production edits) against the
// committed synthetic fixtures in test/fixtures/news/. All data is invented;
// no network, no real user data, no secrets.
//
// Modes (URL parameters):
//   ?run=foryou|all   grid of every matrix case at that scope (one Chrome run)
//   ?case=<fixture>__<scope>__<w>__<theme>__<locale>[&probe=1]
//                     single case; with probe=1 the page also drives the
//                     candidate-design interactions (groups, search, focus)
// The Node test reads the JSON recorded in #news-layout-result.
import React from 'react'
import { createRoot } from 'react-dom/client'
import plugin, { __test as T } from '../desktop/plugin.js'
import REALISTIC from './fixtures/news/realistic.json'
import VARIANTS from './fixtures/news/variants.json'

// ------------------------------------------------------------------ SELECTORS
// PLACEHOLDER DOM hooks for the WP11 candidate design ("model-first groups").
// The UI agent will publish the real hooks; update this one block only.
// Every candidate-gated assertion in news-layout.test.mjs reads through this
// object, so new hooks never require touching test logic.
const SELECTORS = {
  group: '[data-news-group]',
  groupId: '[data-news-group-id]',
  groupName: '[data-news-friendly-name]',
  modelId: '[data-news-model-id]',
  providerRow: '[data-news-provider-row]',
  fieldChip: '[data-news-field-chip]',
  impactLine: '[data-news-impact]',
  search: '[data-news-search]',
  dateFilter: '[data-news-date-filter]',
  loadMore: '[data-news-load-more]',
  list: '[data-news-list]',
  details: '[data-news-details]',
  scope: '[data-news-scope]',
  category: '[data-news-category]',
  emptyForYou: '[data-news-empty-foryou]',
  linkAll: '[data-news-link-all]',
}

// Exact model-ID strings that must render verbatim (never lowercased or
// stripped), including the dated variant pair and the namespaced IDs.
const EXACT_IDS = [
  'claude-sonnet-4-5-20250929', 'claude-sonnet-4-5',
  'claude-opus-4-1-20250805-thinking', 'gpt-5.6-sol', 'gpt-5.6-sol-pro',
  'openrouter/anthropic/claude-sonnet-4.5', 'deepseek-ai/deepseek-v4-pro',
]

// Wording the reference design forbids. Scanned against the whole pane text
// in both locales; a hit is a hard failure.
const FORBIDDEN = {
  entitlement: [
    /on your plan/i, /you have access/i, /included in your plan/i, /entitled/i,
    /您的套餐内/, /您已包含/, /包含在您的套餐/, /有权使用/, /已为您开通/,
  ],
  charge: [
    /you (will )?save/i, /guaranteed/i, /actual charge/i, /you were charged/i,
    /您(将)?节省/, /保证/, /实际扣费/, /已扣费/,
  ],
  blended: [/blended/i, /average/i, /avg\.?\s*%/, /混合价格/, /平均/],
}

const ERROR_FIXTURE = VARIANTS.error
const FIXTURES = {
  realistic: REALISTIC,
  empty: VARIANTS.empty,
  partial: VARIANTS.partial,
  stale: VARIANTS.stale,
  nosignals: VARIANTS.nosignals,
}

const errors = (globalThis.__newsErrors = [])
const onError = message => { errors.push(String(message)) }
window.addEventListener('error', event => onError(event.message))
window.addEventListener('unhandledrejection', event => onError(String(event.reason)))

plugin.register({
  rest: async (path, options = {}) => {
    // Grid runs fix one fixture per Chrome run via ?fixture=; single-case mode
    // reads it from ?case=.
    const fixtureName = globalThis.__wp11Fixture || 'realistic'
    if (path === '/news/refresh' && options.method === 'POST') {
      if (fixtureName === 'error') return ERROR_FIXTURE
      return FIXTURES[fixtureName]
    }
    if (path === '/news') {
      return { ok: true, live_updates: FIXTURES[fixtureName]?.settings?.live_updates ?? false }
    }
    if (path === '/news/settings' && options.method === 'PUT') return { ok: true }
    return { ok: true }
  },
  storage: { get: (_key, fallback) => fallback, set() {}, delete() {} },
  register() {}, registerMany() {}, onDispose() {}, onEvent: () => () => {},
  setTimeout: fn => { const timer = setTimeout(fn, 0); return () => clearTimeout(timer) },
  setInterval: () => () => {}, addEventListener: () => () => {},
  os: {}, pet: null, i18n: { register() {}, t: key => key },
})

// case = <fixture>__<scope>__<w>__<theme>__<locale>
const CASE = (() => {
  const raw = new URLSearchParams(location.search).get('case') || ''
  const parts = raw ? raw.split('__') : []
  const [fixture = 'realistic', scope = 'foryou', w = '380', theme = 'dark', locale = 'en'] = parts
  return { raw, fixture, scope, w: Number(w), theme, locale }
})()
const PROBE = new URLSearchParams(location.search).get('probe') === '1'
const RUN = new URLSearchParams(location.search).get('run') || ''

const fixturesForCase = ({ fixture, scope }) => {
  if (fixture === 'error') return []
  const payload = FIXTURES[fixture]
  const items = [...payload.local.items, ...payload.central.items]
  return scope === 'foryou' ? items.filter(item => item.relevance?.relevant) : items
}

// ------------------------------------------------------------------ matrix
const MATRIX = []
for (const scope of ['foryou', 'all'])
  for (const w of [380, 1200])
    for (const theme of ['dark', 'light'])
      for (const locale of ['en', 'zh-CN'])
        MATRIX.push({ fixture: 'realistic', scope, w, theme, locale })
for (const fixture of ['empty', 'partial', 'nosignals'])
  for (const scope of ['foryou', 'all'])
    MATRIX.push({ fixture, scope, w: 380, theme: 'dark', locale: 'en' })
for (const fixture of ['stale', 'error'])
  MATRIX.push({ fixture, scope: 'foryou', w: 380, theme: 'dark', locale: 'en' })

// Single-case mode is driven by ?case=; grid mode by
// ?fixture=<f>&run=<scope>&locale=<l>, optionally sliced into chunks
// (?chunk=0&chunks=3) so no single Chrome run is too heavy. Fixture, scope
// and locale are fixed for a whole run and set ONCE before any render:
// React may defer the initial renders, so per-case globals would be read too
// late.
const params = new URLSearchParams(location.search)
const chunkIndex = Number(params.get('chunk') || 0)
const chunkCount = Number(params.get('chunks') || 1)
const runLocale = params.get('locale') || ''
const runFixture = params.get('fixture') || ''
globalThis.__wp11Fixture = CASE.raw ? CASE.fixture : (runFixture || 'realistic')
const scopedCases = CASE.raw
  ? MATRIX.filter(c => `${c.fixture}__${c.scope}__${c.w}__${c.theme}__${c.locale}` === CASE.raw)
  : MATRIX.filter(c => (!RUN || c.scope === RUN) && (!runLocale || c.locale === runLocale)
    && (!runFixture || c.fixture === runFixture))
const cases = CASE.raw
  ? scopedCases
  : scopedCases.filter((_c, index) => index % chunkCount === chunkIndex)
if (CASE.raw && !cases.length) cases.push({ fixture: CASE.fixture, scope: CASE.scope, w: CASE.w, theme: CASE.theme, locale: CASE.locale })

globalThis.__wp11I18N = T.I18N
globalThis.__wp11Locale = (CASE.raw ? CASE.locale : (runLocale || cases[0]?.locale || 'en'))
T.$newsScope.set(CASE.raw ? CASE.scope : (RUN || 'foryou'))
T.$newsCategory.set('all')

const root = document.getElementById('news-layout-cases')
for (const c of cases) {
  const id = `${c.fixture}__${c.scope}__${c.w}__${c.theme}__${c.locale}`
  let container = document.getElementById(id)
  if (!container) {
    container = document.createElement('div')
    container.id = id
    container.className = 'case wm-news-host'
    root.appendChild(container)
  }
  container.classList.add(c.theme)
  container.style.width = `${c.w}px`
  if (CASE.raw) document.body.dataset.single = c.theme
  const reactRoot = createRoot(container)
  reactRoot.render(React.createElement(T.NewsPage))
}

const tick = (ms = 25) => new Promise(resolve => setTimeout(resolve, ms))

// ------------------------------------------------------------------ helpers

/** Map every fixture item onto the card it produced; the harness annotates
 * the card with data-wp11-id so the test can assert per-item reachability.
 * Production does not render internal item ids; the candidate design will
 * surface them in Details (checked by the gated group B). */
function annotateItems(pane, items) {
  const cards = [...pane.querySelectorAll('.wm-news-card')]
  const used = new Set()
  const matched = []
  const missing = []
  for (const item of items) {
    const title = item.model || item.provider
    const day = (item.observed_at || '').slice(0, 10)
    const eff = (item.effective_at || '').slice(0, 10)
    const hit = cards.find(card => {
      if (used.has(card)) return false
      const h3 = card.querySelector('h3')
      if (!h3 || (h3.firstChild?.textContent || '').trim() !== title) return false
      const badge = card.querySelector('.wm-news-badge')
      if (!badge || badge.getAttribute('data-cat') !== item.category) return false
      if (item.model) {
        const small = h3.querySelector('small')
        if (!small || small.textContent !== item.provider) return false
      }
      if (day && !card.textContent.includes(day)) return false
      if (eff && !card.textContent.includes(eff)) return false
      if (item.provenance && !card.textContent.includes(item.provenance)) return false
      if (item.source_url
        && ![...card.querySelectorAll('a')].some(a => a.getAttribute('href') === item.source_url)) return false
      return true
    })
    if (hit) { used.add(hit); hit.dataset.wp11Id = item.id; matched.push(item.id) }
    else missing.push(item.id)
  }
  return { expected: items.length, matched, missing, extraCards: cards.length - used.size }
}

function presenceGaps(pane, text, items) {
  const hrefs = new Set([...pane.querySelectorAll('a')].map(a => a.getAttribute('href')))
  const missingModel = []
  const missingProvider = []
  const missingSource = []
  for (const item of items) {
    if (item.model && !text.includes(item.model)) missingModel.push(item.id)
    if (item.provider && !text.includes(item.provider)) missingProvider.push(item.id)
    if (item.source_url && !hrefs.has(item.source_url)) missingSource.push(item.id)
  }
  return { missingModel, missingProvider, missingSource }
}

function forbiddenHits(text) {
  const hits = {}
  for (const [kind, patterns] of Object.entries(FORBIDDEN)) {
    const found = patterns.filter(pattern => pattern.test(text))
    if (found.length) hits[kind] = found.map(pattern => pattern.toString())
  }
  return hits
}

function overflowList(pane) {
  return [...pane.querySelectorAll(
    '.wm-news-card, .wm-news-controls, .wm-product-section, .wm-segments')]
  .map(el => ({ cls: el.className, excess: el.scrollWidth - el.clientWidth }))
  .filter(x => x.excess > 1)
}

/** Observation only (not asserted): header overflow outside the A scope. */
function headerOverflow(pane) {
  return [...pane.querySelectorAll('.wm-product-heading')]
  .map(el => ({ cls: el.className, excess: el.scrollWidth - el.clientWidth }))
  .filter(x => x.excess > 1)
}

const parseColor = text => {
  const match = /rgba?\(([^)]+)\)/.exec(text || '')
  if (!match) return null
  const [r, g, b, a = 1] = match[1].split(',').map(Number)
  return { r, g, b, a }
}

const srgb = value => {
  const v = value / 255
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
}

const luminance = ({ r, g, b }) =>
  0.2126 * srgb(r) + 0.7152 * srgb(g) + 0.0722 * srgb(b)

const contrast = (fg, bg) => {
  if (!fg || !bg) return null
  const l1 = luminance(fg)
  const l2 = luminance(bg)
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
}

function effectiveBackground(el) {
  for (let node = el; node; node = node.parentElement) {
    const raw = getComputedStyle(node).backgroundColor
    const color = parseColor(raw)
    if (color && color.a > 0.05) return raw
  }
  return 'rgb(255,255,255)'
}

/** WCAG contrast of every badge/chip/impact text against its effective
 * background; the test asserts the minimum is >= 4.5:1. */
function contrastScan(pane) {
  const selectors = ['.wm-news-badge', '.wm-news-route', '.wm-news-impact']
  if (pane.querySelector(SELECTORS.fieldChip)) selectors.push(SELECTORS.fieldChip)
  const els = [...pane.querySelectorAll(selectors.join(','))]
  let min = Infinity
  let worst = null
  for (const el of els) {
    const style = getComputedStyle(el)
    if (style.display === 'none' || style.visibility === 'hidden') continue
    const bg = effectiveBackground(el)
    const ratio = contrast(parseColor(style.color), parseColor(bg))
    if (ratio == null) continue
    if (ratio < min) {
      min = ratio
      worst = { cls: el.className, color: style.color, bg, ratio: Math.round(ratio * 100) / 100 }
    }
  }
  return { count: els.length, min: min === Infinity ? null : Math.round(min * 100) / 100, worst }
}

function expandHidden(pane) {
  // Content behind a collapsed Details must be reachable before measuring.
  for (const details of pane.querySelectorAll('details:not([open])')) {
    details.querySelector('summary')?.click()
  }
  for (const details of pane.querySelectorAll(SELECTORS.details)) {
    if (details instanceof HTMLDetailsElement && !details.open) {
      details.querySelector('summary')?.click()
    } else {
      details.querySelector('button, [aria-expanded]')?.click()
    }
  }
}

const groupIdOf = group =>
  group.getAttribute('data-news-group')
  || group.querySelector(SELECTORS.groupId)?.textContent?.trim()
  || group.querySelector(SELECTORS.modelId)?.textContent?.trim()
  || ''

const comesRightAfter = (nameEl, idEl) => {
  if (!nameEl || !idEl) return false
  let node = nameEl
  for (let hops = 0; hops < 6 && node; hops += 1) {
    if (node === idEl || (node.contains && node.contains(idEl))) return true
    node = node.nextElementSibling
  }
  return false
}

const visibleFocusables = pane =>
  [...pane.querySelectorAll(
    'button, a[href], input, select, textarea, summary, [tabindex]:not([tabindex="-1"])')]
  .filter(el => (el.offsetParent !== null || el.getClientRects().length > 0)
    && !el.matches('button[disabled], input[disabled], [aria-disabled="true"]'))
  .map(el => ({
    tag: el.tagName.toLowerCase(),
    label: (el.getAttribute('aria-label') || el.textContent || el.value || '').trim().slice(0, 40),
    pressed: el.getAttribute('aria-pressed'),
  }))

const setInputValue = (input, value) => {
  const setter = Object.getOwnPropertyDescriptor(
    input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
    'value').set
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

const selectedState = button => ({
  pressed: button?.getAttribute('aria-pressed'),
  outline: (() => {
    if (!button) return null
    const style = getComputedStyle(button)
    return { style: style.outlineStyle, width: style.outlineWidth, color: style.outlineColor }
  })(),
})

// ------------------------------------------------------------------ probes

/** Candidate-design interactions (single case per Chrome run so the shared
 * atoms are not crossed). Recorded only when the candidate DOM is detected
 * or WP11_CANDIDATE forces probing; on baseline this never runs. */
async function probeCandidate(c, pane) {
  const out = { selectors: SELECTORS }
  const groups = () => [...pane.querySelectorAll(SELECTORS.group)]

  // Static group structure.
  out.groups = groups().map(group => {
    const nameEl = group.querySelector(SELECTORS.groupName)
    const idEl = group.querySelector(SELECTORS.modelId)
    return {
      id: groupIdOf(group),
      name: nameEl?.textContent?.trim() || '',
      exactIdBelowName: comesRightAfter(nameEl, idEl),
      itemIds: [...group.querySelectorAll('[data-wp11-id]')].map(el => el.dataset.wp11Id),
      providerRows: group.querySelectorAll(SELECTORS.providerRow).length,
      text: group.textContent.slice(0, 400),
    }
  })
  out.impactWording = /hypothetical|api-equivalent/i.test(pane.textContent)
  // Every element carrying an original item id, with its group, so the test
  // can assert reachability and merge/distinct behaviour.
  out.idElements = [...pane.querySelectorAll('[data-wp11-id], [data-news-source-id]')].map(el => ({
    id: el.dataset.wp11Id || el.getAttribute('data-news-source-id'),
    group: (() => {
      const group = el.closest(SELECTORS.group)
      return group ? (group.getAttribute('data-news-group') || groupIdOf(group)) : ''
    })(),
  }))
  const chipIssues = []
  for (const chip of pane.querySelectorAll(SELECTORS.fieldChip)) {
    const text = chip.textContent || ''
    const directions = text.match(/\b(down|up|reduced|increased|cheaper|higher|lower)\b|↓|↑|降|涨|下调|上调/gi) || []
    if (directions.length > 1) chipIssues.push(text.trim().slice(0, 60))
  }
  out.chipDirectionIssues = chipIssues

  if (c.fixture === 'nosignals' && c.scope === 'foryou') {
    const link = pane.querySelector(SELECTORS.linkAll)
    out.emptyForYou = {
      present: !!pane.querySelector(SELECTORS.emptyForYou),
      hasLinkToAll: !!link,
      linkVisible: !!link && (link.offsetParent !== null || link.getClientRects().length > 0),
    }
    if (link) {
      link.click()
      await tick(120)
      out.emptyForYou.groupsAfterClick = groups().length
    }
    return out
  }

  // Ring persistence: select a category, switch scope and back; the ring must
  // survive on the category AND the scope must carry its own ring.
  const scopeButtons = [...pane.querySelectorAll(`${SELECTORS.scope} button`)]
  const categoryButtons = [...pane.querySelectorAll(`${SELECTORS.category} button`)]
  const reductions = categoryButtons.find(b => /reductions|降价/i.test(b.textContent || ''))
  if (reductions && scopeButtons.length >= 2) {
    reductions.click()
    await tick(80)
    const selectedCategory = selectedState(categoryButtons.find(b => b.getAttribute('aria-pressed') === 'true'))
    const allScope = scopeButtons.find(b => /all updates|全部动态/i.test(b.textContent || ''))
    const forYou = scopeButtons.find(b => /for you|为你推荐/i.test(b.textContent || ''))
    allScope?.click()
    await tick(80)
    const afterSwitchAll = selectedState(categoryButtons.find(b => (b.textContent || '').match(/reductions|降价/i)))
    const scopeRingOnAll = selectedState(scopeButtons.find(b => b.getAttribute('aria-pressed') === 'true'))
    forYou?.click()
    await tick(80)
    const afterSwitchBack = selectedState(categoryButtons.find(b => (b.textContent || '').match(/reductions|降价/i)))
    out.ring = {
      categoryOnSelect: selectedCategory,
      categoryAfterScopeSwitch: afterSwitchAll,
      scopeRing: scopeRingOnAll,
      categoryAfterSwitchBack: afterSwitchBack,
      survives: afterSwitchAll.pressed === 'true'
        && afterSwitchBack.pressed === 'true'
        && afterSwitchAll.outline?.style !== 'none'
        && Number.parseFloat(afterSwitchAll.outline?.width || '0') > 0,
    }
    // restore
    categoryButtons.find(b => /all|全部/i.test(b.textContent || ''))?.click()
    await tick(60)
  } else {
    out.ring = { missingSelectors: true }
  }

  // Search: full-ID substring match.
  const search = pane.querySelector(SELECTORS.search)
  if (search) {
    const before = groups().map(groupIdOf)
    setInputValue(search, 'sol')
    await tick(120)
    out.search = { before, after: groups().map(groupIdOf) }
    setInputValue(search, '')
    await tick(60)
  } else {
    out.search = { missingSelector: true }
  }

  // Date filter: narrowing to the last 3 days must drop the mistral items.
  const dateFilter = pane.querySelector(SELECTORS.dateFilter)
  if (dateFilter) {
    const before = groups().map(groupIdOf)
    setInputValue(dateFilter, '3d')
    await tick(120)
    out.dateFilter = { before, after: groups().map(groupIdOf) }
    setInputValue(dateFilter, 'all')
    await tick(60)
  } else {
    out.dateFilter = { missingSelector: true }
  }

  // Load-more keeps focus inside the list.
  const loadMore = pane.querySelector(SELECTORS.loadMore)
  out.loadMore = loadMore
    ? (() => {
        loadMore.click()
        return { present: true, focusInsideList: !!pane.querySelector(SELECTORS.list)?.contains(document.activeElement) }
      })()
    : { present: false }

  // Keyboard reachability: DOM order of the primary controls.
  const focusables = visibleFocusables(pane)
  out.focusables = focusables
  const indexOf = match => focusables.findIndex(el => match.test(el.label))
  out.keyboard = {
    scopeIndex: indexOf(/for you|为你推荐/),
    categoryIndex: indexOf(/new models|新模型/),
    searchIndex: pane.querySelector(SELECTORS.search)
      ? focusables.findIndex(el => el.tag === 'input') : -1,
    detailsIndex: focusables.findIndex(el => el.tag === 'summary'
      || /details|more|详情|展开/i.test(el.label)),
    loadMoreIndex: indexOf(/load more|加载更多|show more|显示更多/),
  }
  const detailsToggle = pane.querySelector(`${SELECTORS.details} summary`)
    || pane.querySelector(`${SELECTORS.details} button`)
    || pane.querySelector('details summary')
  if (detailsToggle) {
    const region = detailsToggle.closest('details') || detailsToggle.closest(SELECTORS.details)
    const before = region instanceof HTMLDetailsElement ? region.open : null
    detailsToggle.click()
    await tick(60)
    const after = region instanceof HTMLDetailsElement ? region.open : null
    detailsToggle.focus()
    out.keyboard.toggle = {
      tag: detailsToggle.tagName.toLowerCase(),
      keyboardOperable: ['button', 'summary', 'input', 'a'].includes(detailsToggle.tagName.toLowerCase()),
      toggled: before === null ? null : before !== after,
      focusVisible: detailsToggle.matches(':focus-visible'),
    }
    if (before === true) detailsToggle.click()
  } else {
    out.keyboard.toggle = { missing: true }
  }
  return out
}

// ------------------------------------------------------------------ measure

function paneText(pane) {
  // ProductShell inlines its CSS in a <style> element; textContent would be
  // dominated by stylesheet text, so strip style/script before capturing.
  const clone = pane.cloneNode(true)
  clone.querySelectorAll('style, script').forEach(el => el.remove())
  return clone.textContent
}

async function measureCase(c) {
  const id = `${c.fixture}__${c.scope}__${c.w}__${c.theme}__${c.locale}`
  const pane = document.getElementById(id)
  if (!pane) return { id, error: 'container missing' }
  expandHidden(pane)
  await tick()
  const items = fixturesForCase(c)
  const ids = annotateItems(pane, items)
  const text = paneText(pane)
  // Exact-ID verbatim rendering is asserted against the items the current
  // scope actually shows; the All scope must carry every entry.
  const exactExpected = EXACT_IDS.filter(id => items.some(item => (item.model || '').includes(id)))
  const labels = [...pane.querySelectorAll('.wm-segments button')].map(b => b.textContent)
  const candidateDetected = !!pane.querySelector(SELECTORS.group)
  const result = {
    id, fixture: c.fixture, scope: c.scope, w: c.w, theme: c.theme, locale: c.locale,
    height: pane.scrollHeight, cards: pane.querySelectorAll('.wm-news-card').length,
    overflow: overflowList(pane),
    headerOverflow: headerOverflow(pane),
    labels,
    ids, presence: presenceGaps(pane, text, items),
    exactExpected: c.fixture === 'realistic' ? exactExpected : [],
    exactMissing: c.fixture === 'realistic' ? exactExpected.filter(x => !text.includes(x)) : [],
    forbidden: forbiddenHits(text),
    contrast: contrastScan(pane),
    candidateDetected,
    errors: [...errors.splice(0), ...(globalThis.__newsQueryErrors || []).splice(0)].slice(0, 6),
    text: text.slice(0, 12000),
  }
  if (PROBE && candidateDetected) result.probe = await probeCandidate(c, pane)
  else if (PROBE) result.probe = { skipped: 'candidate DOM not detected' }
  return result
}

setTimeout(async () => {
  const results = []
  for (const c of cases) results.push(await measureCase(c))
  document.getElementById('news-layout-result').textContent = JSON.stringify({ cases: results, total: scopedCases.length })
}, 900)
