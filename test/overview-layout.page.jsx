import React from 'react'
import { createRoot } from 'react-dom/client'
import plugin, { __test as T } from '../desktop/plugin.js'

globalThis.__overviewI18n = Object.fromEntries(Object.entries(T.I18N.en).map(([key, value]) => [
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
        { provider: 'synthetic-provider', model: 'synthetic-long-model-name-for-wrapping', calls: 15 },
        { provider: 'synthetic-provider', model: 'synthetic-small-model', calls: 9 },
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
const cases = selected ? [selected] : ['narrow-dark', 'wide-dark', 'narrow-light', 'wide-light']
const root = document.getElementById('overview-layout-cases')
for (const id of cases) {
  const width = id.startsWith('narrow') ? 380 : 1200
  const theme = id.endsWith('dark') ? 'dark' : 'light'
  let container = document.getElementById(id)
  if (!container) {
    container = document.createElement('div')
    container.id = id
    container.className = 'case wm-analytics wm-product'
    root.appendChild(container)
  }
  container.classList.add(theme)
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
      .map(element => ({ name: element.className, excess: element.scrollWidth - element.clientWidth }))
    output.layouts.push({
      id, width: pane.clientWidth,
      summaryColumns: columns(summary), panelColumns: columns(panels),
      cards: summary.querySelectorAll('.wm-kpi').length,
      charges: pane.querySelector('[data-kpi="actual-charges"]').textContent,
      fees: pane.querySelector('[data-kpi="saved-fees"]').textContent,
      overflow: overflow.filter(item => item.excess > 1),
      text: pane.querySelector('.wm-shell')?.textContent || pane.textContent,
      background: getComputedStyle(pane).backgroundColor,
      foreground: getComputedStyle(pane).color,
    })
  }
  document.getElementById('overview-layout-result').textContent = JSON.stringify(output)
}, 900)
