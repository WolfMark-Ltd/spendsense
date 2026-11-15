import React from 'react'
import { createRoot } from 'react-dom/client'
import plugin, { __test as T } from '../desktop/plugin.js'

const locale = globalThis.__overviewLocale || 'en'
globalThis.__overviewI18n = Object.fromEntries(Object.entries(T.I18N[locale] || T.I18N.en).map(([key, value]) => [
  key, typeof value === 'function' ? (...args) => value(...args) : value,
]))

const accounts = [
  {
    id: 'synthetic-anthropic', family: 'anthropic', label: 'Synthetic Claude account',
    billing_arrangement: 'subscription', effective_arrangement: 'subscription',
    plan_id: 'synthetic-plan', plan: { name: 'Synthetic plan' },
    fee: { basis: 'declared', effective: { amount: 20, currency: 'GBP', period: 'month' } },
    quota: { windows: [] }, manual_exhaustions: [], fee_overrides: [],
    plan_choices: [], excluded_plans: [], rev: 'fixture',
  },
  {
    id: 'synthetic-openai', family: 'openai-codex', label: 'Synthetic OpenAI account',
    billing_arrangement: 'subscription', effective_arrangement: 'subscription',
    plan_id: null, plan: null,
    fee: { basis: 'no_plan', effective: { amount: null } },
    quota: { windows: [] }, manual_exhaustions: [], fee_overrides: [],
    plan_choices: [], excluded_plans: [], rev: 'fixture',
  },
]

const today = new Date()
const day = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`

plugin.register({
  rest: async path => {
    if (path === '/analytics?days=30') return {
      ok: true,
      totals: { list_usd: 12.34, billed_usd: null, billed_complete: false,
        billing_mix: { actual: 1, estimated: 1, included: 0, unknown: 2 },
        calls: 24, unpriced_tokens: 1500 },
      by_model: [
        { provider: 'openai-codex', model: 'openai/gpt-5.1-codex-super-long-model-name-for-wrapping', calls: 15 },
        { provider: 'anthropic', model: 'anthropic/claude-opus-4-6', calls: 9 },
      ],
    }
    if (path === '/membership/accounts') return { ok: true, accounts, store: { loaded: true, error: '' }, notes: [] }
    if (path === '/allowance/weather') return { ok: true, accounts: [] }
    if (path === '/economics/summary?days=30&trend_months=6') return {
      ok: true, window_days: 30, headline: { status: 'partial', difference_usd: 999 }, accounts: [],
    }
    if (path === '/budgets/status') return {
      ok: true, rev: 'fixture', budgets: [{
        id: 'synthetic-budget', label: 'Synthetic API-equivalent limit', amount: 100,
        currency: 'USD', enabled: true, scope: 'total', measurement: 'api_equivalent',
        thresholds: [50, 80, 100], timezone: 'Europe/London', cycle_day: 1,
      }], statuses: [{
        id: 'synthetic-budget', budget: {
          id: 'synthetic-budget', label: 'Synthetic API-equivalent limit', amount: 100,
          currency: 'USD', enabled: true, scope: 'total', measurement: 'api_equivalent',
          thresholds: [50, 80, 100], timezone: 'Europe/London', cycle_day: 1,
        }, spend: 46, percentage: 46, complete: true, level: 'normal',
        budget_rev: 'fixture', cycle: { id: 'fixture-cycle', start: '2026-11-01', end: '2026-12-01' },
      }],
    }
    return { ok: true }
  },
  storage: { get: (_key, fallback) => fallback, set() {}, delete() {} },
  register() {}, registerMany() {}, onDispose() {}, onEvent: () => () => {},
  setTimeout: fn => { const timer = setTimeout(fn, 0); return () => clearTimeout(timer) },
  setInterval: () => () => {}, addEventListener: () => () => {},
  os: {}, pet: null, i18n: { register() {}, t: key => key },
})

T.$ledger.set({
  ...T.emptyLedger(),
  days: { [day]: { synthetic: { cost: 0.42, pricedTokens: 24000, unpricedTokens: 350 } } },
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

setTimeout(() => {
  const output = { layouts: [] }
  for (const id of cases) {
    const pane = document.getElementById(id)
    const summary = pane.querySelector('.wm-product-summary')
    const panels = pane.querySelector('.wm-overview-panels')
    if (!summary || !panels) {
      output.layouts.push({ id, missingOverview: true, errors: window.__overviewErrors || [] })
      continue
    }
    const columns = element => getComputedStyle(element).gridTemplateColumns.trim().split(/\s+/).length
    const overflow = [...pane.querySelectorAll('.wm-kpi, .wm-product-section')]
      .map(element => ({ name: element.dataset.kpi || element.className,
        excess: element.scrollWidth - element.clientWidth, scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth, text: element.textContent }))
    const paneBounds = pane.getBoundingClientRect()
    const buttons = [...pane.querySelectorAll('button')].filter(button => button.getClientRects().length)
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
      buttonsOutsidePane: buttons.filter(button => {
        const rect = button.getBoundingClientRect()
        return rect.left < paneBounds.left - 1 || rect.right > paneBounds.right + 1
          || rect.top < paneBounds.top - 1 || rect.bottom > paneBounds.bottom + 1
      }).map(button => button.getAttribute('aria-label') || button.textContent.trim()),
      documentOverflow: selected ? document.documentElement.scrollWidth - document.documentElement.clientWidth : null,
      summaryColumns: columns(summary), panelColumns: columns(panels),
      cards: summary.querySelectorAll('.wm-kpi').length,
      locale,
      charges: pane.querySelector('[data-kpi="actual-charges"]').textContent,
      recorded: pane.querySelector('[data-kpi="recorded-usage"]').textContent,
      estimate: pane.querySelector('[data-kpi="api-equivalent-estimate"]').textContent,
      fees: pane.querySelector('[data-kpi="saved-fees"]').textContent,
      pricingAction: pane.querySelector('.wm-attention-rows li:last-child button')?.textContent.trim() || '',
      methodsCollapsed: !pane.querySelector('details.wm-method').open,
      methodSections: pane.querySelectorAll('.wm-method-grid h3').length,
      modelLabels: [...pane.querySelectorAll('.wm-overview-model-name strong')].map(el => el.textContent),
      modelDetails: [...pane.querySelectorAll('.wm-overview-model-name .wm-info-btn')].map(el => el.getAttribute('aria-label')),
      kpiHeights: [...summary.querySelectorAll('.wm-kpi')].map(el => Math.round(el.getBoundingClientRect().height)),
      kpiDetails: [...summary.querySelectorAll('.wm-kpi')].map(card => ({
        name: card.dataset.kpi, width: card.clientWidth, height: card.clientHeight,
        children: [...card.children].map(child => ({ className: child.className,
          height: Math.round(child.getBoundingClientRect().height), width: Math.round(child.getBoundingClientRect().width),
          scrollWidth: child.scrollWidth, text: child.textContent.slice(0, 100) }))
      })),
      overflow: overflow.filter(item => item.excess > 1),
      text: pane.querySelector('.wm-shell')?.textContent || pane.textContent,
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
}, 900)
