import React from 'react'
import { createRoot } from 'react-dom/client'
import plugin, { __test as T } from '../desktop/plugin.js'
import {
  overviewLedgerDays, overviewTransport,
} from './overview-fixtures.mjs'

// The payload is defined once in `overview-fixtures.mjs` so the browser and the
// browserless Overview suite render the same synthetic accounts and analytics.
const locale = globalThis.__overviewLocale || 'en'
globalThis.__overviewI18n = Object.fromEntries(Object.entries(T.I18N[locale] || T.I18N.en).map(([key, value]) => [
  key, typeof value === 'function' ? (...args) => value(...args) : value,
]))

plugin.register({
  rest: overviewTransport({ requiredContract: T.REQUIRED_BACKEND_CONTRACT }),
  storage: { get: (_key, fallback) => fallback, set() {}, delete() {} },
  register() {}, registerMany() {}, onDispose() {}, onEvent: () => () => {},
  setTimeout: fn => { const timer = setTimeout(fn, 0); return () => clearTimeout(timer) },
  setInterval: () => () => {}, addEventListener: () => () => {},
  os: {}, pet: null, i18n: { register() {}, t: key => key },
})

T.$ledger.set({ ...T.emptyLedger(), days: overviewLedgerDays() })

window.addEventListener('error', event => {
  (window.__overviewErrors = window.__overviewErrors || []).push(String(event.message))
})

const selected = new URLSearchParams(location.search).get('case')
const cases = selected ? [selected] : [268, 380, 1200].flatMap(width => ['dark', 'light'].map(theme => `w${width}-${theme}`))
const root = document.getElementById('overview-layout-cases')
for (const id of cases) {
  const width = Number(id.match(/^w(\d+)-/)?.[1] || 380)
  const theme = id.endsWith('dark') ? 'dark' : 'light'
  let container = document.getElementById(id)
  if (!container) {
    container = document.createElement('div')
    container.id = id
    container.className = 'case wm-analytics wm-product'
    root.appendChild(container)
  }
  container.classList.add(theme)
  container.style.colorScheme = theme
  container.style.width = `${width}px`
  createRoot(container).render(React.createElement(T.OverviewPage))
}

const tick = (ms = 25) => new Promise(resolve => setTimeout(resolve, ms))

/** Bounded readiness ceiling, in milliseconds of page time. */
const READY_TIMEOUT_MS = 4000

/**
 * The final structure every assertion below measures.
 *
 * A fixed wait measures whatever happens to be on screen, and an early read has
 * produced a whole case with no Overview panels on an unchanged revision. The
 * pre-query page is not a fixture state either, so the gate also requires the
 * 30-day analytics query to have resolved (the ranking only renders from it).
 */
const structurallyReady = () => cases.every(id => {
  const pane = document.getElementById(id)
  const summary = pane?.querySelector('.wm-product-summary')
  return !!summary && !!pane.querySelector('.wm-overview-panels')
    && summary.querySelectorAll('.wm-kpi').length === 4
    && !!pane.querySelector('.wm-overview-model-row')
})

const run = async () => {
  let waitedMs = 0
  while (waitedMs < READY_TIMEOUT_MS && !structurallyReady()) {
    await tick(50)
    waitedMs += 50
  }
  // A case that missed the deadline is published as missing rather than
  // measured, so a page that never painted fails by name instead of passing a
  // set of assertions about nothing.
  const readiness = { ready: structurallyReady(), waitedMs }
  const output = { layouts: [], readiness }
  for (const id of cases) {
    const pane = document.getElementById(id)
    const summary = pane.querySelector('.wm-product-summary')
    const panels = pane.querySelector('.wm-overview-panels')
    if (!summary || !panels) {
      output.layouts.push({ id, missingOverview: true, readiness, errors: window.__overviewErrors || [] })
      continue
    }
    const columns = element => getComputedStyle(element).gridTemplateColumns.trim().split(/\s+/).length
    const overflow = [...pane.querySelectorAll('.wm-kpi, .wm-product-section')]
      .map(element => ({ name: element.dataset.kpi || element.className,
        excess: element.scrollWidth - element.clientWidth, scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth, text: element.textContent }))
    const paneBounds = pane.getBoundingClientRect()
    // Collapsed disclosures keep layout boxes in newer Chrome but are never
    // painted, so geometry assertions cover visible controls only.
    const buttons = [...pane.querySelectorAll('button')]
      .filter(button => button.getClientRects().length && !button.closest('details:not([open])'))
    const tabs = pane.querySelector('.wm-product-tabs')
    output.layouts.push({
      id, width: pane.clientWidth,
      paneOverflow: pane.scrollWidth - pane.clientWidth,
      paneLeft: Math.round(paneBounds.left),
      paneRight: Math.round(paneBounds.right),
      paneBottom: Math.round(paneBounds.bottom),
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      navigationOverflow: tabs ? tabs.scrollWidth - tabs.clientWidth : null,
      clippedButtons: buttons.filter(button => {
        const rect = button.getBoundingClientRect()
        return rect.left < paneBounds.left - 1 || rect.right > paneBounds.right + 1
      }).map(button => button.getAttribute('aria-label') || button.textContent.trim()),
      // Nothing checks a rect against an empty list, so the count is published:
      // an empty `clippedButtons` only means something when buttons exist.
      buttonCount: buttons.length,
      buttonsOutsidePane: buttons.filter(button => {
        const rect = button.getBoundingClientRect()
        return rect.left < paneBounds.left - 1 || rect.right > paneBounds.right + 1
          || rect.top < paneBounds.top - 1 || rect.bottom > paneBounds.bottom + 1
      }).map(button => button.getAttribute('aria-label') || button.textContent.trim()),
      documentOverflow: selected ? document.documentElement.scrollWidth - document.documentElement.clientWidth : null,
      summaryColumns: columns(summary), panelColumns: columns(panels),
      cards: summary.querySelectorAll('.wm-kpi').length,
      // The page title is the locale guard: it proves the run rendered the
      // language its per-locale assertions assume.
      heading: pane.querySelector('.wm-product-heading h1')?.textContent || '',
      kpiWidths: [...summary.querySelectorAll('.wm-kpi')].map(el => Math.round(el.getBoundingClientRect().width)),
      errors: window.__overviewErrors || [],
      methodsCollapsed: !pane.querySelector('details.wm-method').open,
      kpiHeights: [...summary.querySelectorAll('.wm-kpi')].map(el => Math.round(el.getBoundingClientRect().height)),
      kpiDetails: [...summary.querySelectorAll('.wm-kpi')].map(card => ({
        name: card.dataset.kpi, width: card.clientWidth, height: card.clientHeight,
        children: [...card.children].map(child => ({ className: child.className,
          height: Math.round(child.getBoundingClientRect().height), width: Math.round(child.getBoundingClientRect().width),
          scrollWidth: child.scrollWidth, text: child.textContent.slice(0, 100) }))
      })),
      overflow: overflow.filter(item => item.excess > 1),
      background: getComputedStyle(pane).backgroundColor,
      foreground: getComputedStyle(pane).color,
      sticky: (() => {
        const tabs = pane.querySelector('.wm-product-tabs')
        const before = tabs?.getBoundingClientRect().top
        pane.scrollTop = 300
        const after = tabs?.getBoundingClientRect().top
        const style = tabs ? getComputedStyle(tabs) : null
        return { position: style?.position, zIndex: style?.zIndex, backgroundImage: style?.backgroundImage,
          topDelta: Math.round((after ?? 0) - (before ?? 0)), top: Math.round((after ?? 0) - pane.getBoundingClientRect().top) }
      })(),
    })
  }
  if (new URLSearchParams(location.search).get('review') === '1') {
    output.reviewJumps = []
    for (const id of cases.filter(id => Number(id.match(/^w(\d+)-/)?.[1]) <= 380)) {
      const pane = document.getElementById(id)
      const button = pane.querySelector('.wm-attn-strip button')
      const target = pane.querySelector('.wm-overview-attention')
      const tabs = pane.querySelector('.wm-product-tabs')
      const heading = target?.querySelector('h2')
      const intro = target?.querySelector(':scope > p')
      if (!button || !target || !tabs || !heading || !intro) {
        output.reviewJumps.push({ id, missingTarget: true })
        continue
      }
      button.focus()
      const focused = document.activeElement === button
      button.click()
      const paneTop = pane.getBoundingClientRect().top
      const paneBottom = pane.getBoundingClientRect().bottom
      const tabsRect = tabs.getBoundingClientRect()
      const headingRect = heading.getBoundingClientRect()
      const introRect = intro.getBoundingClientRect()
      output.reviewJumps.push({
        id, focused,
        tabsHeight: tabsRect.height,
        tabsBottom: tabsRect.bottom - paneTop,
        scrollMarginTop: parseFloat(getComputedStyle(target).scrollMarginTop),
        headingTop: headingRect.top - paneTop,
        headingBottom: headingRect.bottom - paneTop,
        introTop: introRect.top - paneTop,
        introBottom: introRect.bottom - paneTop,
        paneBottom: paneBottom - paneTop,
      })
    }
  }
  document.getElementById('overview-layout-result').textContent = JSON.stringify(output)
}

run()
