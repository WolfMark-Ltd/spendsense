import React from 'react'
import { createRoot } from 'react-dom/client'
import plugin, { __test as T } from '../desktop/plugin.js'

const pageLang = new URLSearchParams(location.search).get('lang') === 'zh' ? 'zh' : 'en'
globalThis.__overviewI18n = Object.fromEntries(Object.entries(T.I18N[pageLang]).map(([key, value]) => [
  key, typeof value === 'function' ? (...args) => value(...args) : value,
]))

const accounts = [
  {
    id: 'fixture-usd-zero', family: 'synthetic-usd', label: 'Zero fee plan',
    effective_arrangement: 'subscription', plan_id: 'fixture-zero',
    plan: { name: 'Zero fee plan', entitlements: { windows: [
      { id: 'monthly-limit', label: 'Monthly limit', amount: 100, currency: 'USD' },
    ] } },
    fee: { basis: 'declared', effective: { amount: 0, currency: 'USD', period: 'month' } },
  },
  {
    id: 'fixture-gbp', family: 'synthetic-gbp', label: 'GBP plan',
    effective_arrangement: 'subscription', plan_id: 'fixture-gbp-plan',
    plan: { name: 'GBP plan', entitlements: { windows: [] } },
    fee: { basis: 'declared', effective: { amount: 20, currency: 'GBP', period: 'month' } },
  },
  {
    id: 'fixture-unknown-fee', family: 'synthetic-unknown', label: 'Unknown fee plan',
    effective_arrangement: 'subscription', plan_id: null, plan: null,
    fee: { basis: 'unpriced', effective: { amount: null, currency: 'USD', period: 'month' } },
  },
]

const billingSummary = {
  ok: true,
  window: { days: 30 },
  billing: { evidence: {
    provider_reported: { usd: 0, basis: 'provider_history', source: 'Synthetic provider request history' },
    api_equivalent: { usd: 0, basis: 'current_catalogue', source: 'Synthetic current catalogue',
      pricing_coverage: { priced_tokens: 50, unpriced_tokens: 0, priced_calls: 1, unpriced_calls: 0 } },
    credits_consumed: { usd: 0, basis: 'membership_allowance', source: 'Synthetic plan allowance' },
    incremental_cash: { usd: null, basis: 'incomplete', source: 'No complete evidence' },
    subscription_fee: { usd: 0, basis: 'membership_catalogue_or_declared', source: 'Memberships' },
  } },
  totals: { calls: 2, tokens: 100, economics: {
    uncached_usd: 4, cached_usd: 4, savings_usd: 0, coverage: 0.5,
    covered_tokens: 50, covered_calls: 1, excluded_calls: 1,
    gap_reasons: { missing_cache_read_rate: 1 },
  } },
}

const economics = {
  ok: true,
  window: { days: 30 },
  window_days: 30,
  headline: {
    status: 'partial',
    fees_monthly_by_currency: [
      { currency: 'USD', amount: 0, complete: true },
      { currency: 'GBP', amount: 20, complete: true },
    ],
    fees_window_by_currency: [
      { currency: 'USD', amount: 0, complete: true },
      { currency: 'GBP', amount: 20, complete: true },
    ],
    usage_usd: 0,
    difference_usd: null,
    notes: ['Some currency comparisons need a dated rate.'],
  },
  groups: [
    { currency: 'USD', monthly_fees: 0, window_fees: 0, fee_complete: true,
      window_fee_complete: true, usage_usd: 0, difference_usd: 0, converted: false,
      fx: null, status: 'ok', notes: [], blockers: [] },
    { currency: 'GBP', monthly_fees: 20, window_fees: 20, fee_complete: true,
      window_fee_complete: true, usage_usd: 0, difference_usd: null, converted: false,
      fx: null, status: 'unavailable', notes: [],
      blockers: [{ account_id: 'fixture-gbp', code: 'dated_fx_rate_missing', currency: 'GBP' }] },
  ],
  accounts: [{
    account_id: 'fixture-usd-zero', label: 'Zero fee plan', family: 'synthetic-usd',
    plan_name: 'Zero fee plan', arrangement: 'subscription', plan_id: 'fixture-zero',
    fee: { amount: 0, currency: 'USD', period: 'month', basis: 'declared' },
    monthly_equivalent: { amount: 0, currency: 'USD' },
    window_expenditure: { amount: 0, currency: 'USD' },
    usage: { list_usd: 0, tokens: 50, calls: 1, priced_tokens: 50, unpriced_tokens: 0, coverage: 1 },
    difference_usd: 0, status: 'ok', notes: [], blockers: [],
  }],
  non_subscription_accounts: [],
  unattributed: { routes: [], usage: { list_usd: null, tokens: 0, calls: 0 } },
  ambiguous: { routes: [], usage: { list_usd: null, tokens: 0, calls: 0 } },
  trend: { months: [{ month: '2026-10', fees_by_currency: [{ currency: 'USD', amount: 0 }],
    fees_usd: 0, usage_usd: 0, difference_usd: 0, in_progress: false, partial: false,
    recording_partial: false, difference_note: '' }] },
}

plugin.register({
  rest: async path => {
    if (path === '/billing/summary') return billingSummary
    if (path === '/membership/accounts') return { ok: true, accounts, store: { loaded: true, error: '' }, notes: [] }
    if (path === '/economics/summary?days=30&trend_months=6') return economics
    if (path === '/membership/fx') return { ok: true, rates: [], loaded: true }
    if (path === '/rates') return { ok: true, catalogue: { source: 'Synthetic catalogue', age_seconds: 10, stale: false } }
    if (path === '/budgets/status') return { ok: true, rev: 'fixture', budgets: [], statuses: [] }
    throw new Error(`Unexpected path ${path}`)
  },
  storage: { get: (_key, fallback) => fallback, set() {}, delete() {} },
  register() {}, registerMany() {}, onDispose() {}, onEvent: () => () => {},
  setTimeout: fn => { const timer = setTimeout(fn, 0); return () => clearTimeout(timer) },
  setInterval: () => () => {}, addEventListener: () => () => {},
  os: {}, pet: null, i18n: { register() {}, t: key => key },
})

T.$ledgerTab.set('costs')
const selected = new URLSearchParams(location.search).get('case')
const cases = selected ? [selected] : ['narrow-dark', 'wide-dark', 'narrow-light', 'wide-light']
const root = document.getElementById('costs-layout-cases')
for (const id of cases) {
  const width = id.startsWith('narrow') ? 380 : 1200
  const theme = id.endsWith('dark') ? 'dark' : 'light'
  const container = document.createElement('div')
  container.id = id
  container.className = 'case wm-analytics wm-product'
  container.classList.add(theme)
  container.style.width = `${width}px`
  root.appendChild(container)
  createRoot(container).render(React.createElement(T.CostsPage))
}

setTimeout(() => {
  const output = { layouts: [], interactions: {} }
  for (const id of cases) {
    const pane = document.getElementById(id)
    const grid = pane.querySelector('.wm-cost-summary-grid')
    const charges = pane.querySelector('[data-cost-kind="charges"]')
    const cache = pane.querySelector('[data-cost-kind="cache"]')
    const feeLines = [...pane.querySelectorAll('.wm-cost-fee-lines li')].map(line => line.textContent)
    const columns = getComputedStyle(grid).gridTemplateColumns.trim().split(/\s+/).length
    const overflow = [pane, ...pane.querySelectorAll('.wm-shell, .wm-product-heading, .wm-cost-card, .wm-product-section')]
      .map(element => ({ name: element.id || element.className, excess: element.scrollWidth - element.clientWidth }))
    output.layouts.push({
      id, width: pane.clientWidth, columns, overflow: overflow.filter(item => item.excess > 1),
      text: pane.querySelector('.wm-shell')?.textContent || pane.textContent,
      api: pane.querySelector('[data-cost-kind="api"]')?.textContent,
      provider: pane.querySelector('[data-cost-kind="reported"]')?.textContent,
      charges: charges?.textContent,
      fees: pane.querySelector('[data-cost-kind="fees"]')?.textContent,
      feeLines,
      cache: cache?.textContent,
      allowances: pane.querySelector('[data-cost-kind="allowances"]')?.textContent,
      comparisons: pane.querySelectorAll('.wm-econ-bars .wm-econ-bar-row').length,
      closedDetails: [...pane.querySelectorAll('.wm-cost-card-details, .wm-econ-disclosure')]
        .every(details => !details.open),
      background: getComputedStyle(pane).backgroundColor,
      foreground: getComputedStyle(pane).color,
    })
  }
  if (!selected) {
    const first = document.getElementById(cases[0])
    const fxDetails = first.querySelector('#wm-cost-fx-details')
    const fxAction = [...first.querySelectorAll('button')].find(button => button.textContent === globalThis.__overviewI18n.econActionFx)
    output.interactions.closedBeforeAction = !!fxDetails && !fxDetails.open
    fxAction?.click()
    output.interactions.fxOpensFromBlocker = !!fxDetails?.open
    output.interactions.fxActionReceivesFocus = document.activeElement === fxDetails?.querySelector('summary')
  }
  document.getElementById('costs-layout-result').textContent = JSON.stringify(output)
}, 1200)
