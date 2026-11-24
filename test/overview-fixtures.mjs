/**
 * The Overview synthetic fixture, defined once.
 *
 * `overview-layout.page.jsx` renders it in Chromium and
 * `overview-render.test.mjs` renders it in jsdom. Two renderers over one
 * payload need one definition, or the browserless assertion proves something
 * the browser never rendered.
 *
 * Every value is invented: synthetic providers, a synthetic plan, a round fee.
 * No credentials, no network, no production data. The only clock dependency is
 * the ledger day, which must fall inside the current calendar month for
 * `settledDesktopMonth()` to settle it — so it is derived from "now" rather
 * than pinned to a date that would silently fall out of the window.
 */

/** The day key the settled-month reader will include, in local time. */
export const overviewToday = (now = new Date()) =>
  `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`

/**
 * One ledger day: a priced bucket with a known cost and a few unpriced tokens,
 * so the Recorded-usage card shows money *and* its Partial chip.
 */
export const overviewLedgerDays = (now = new Date()) => ({
  [overviewToday(now)]: {
    synthetic: { cost: 0.42, pricedTokens: 24000, unpricedTokens: 350, unpricedCalls: 0, missingUsageCalls: 0 },
  },
})

export const overviewAccounts = () => [
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

/** 30-day backend analytics: priced, partly unpriced, no provider charge evidence. */
export const overviewAnalytics = ({ totals: totalsOverride = {} } = {}) => ({
  ok: true,
  totals: {
    list_usd: 12.34, billed_usd: null, billed_complete: false,
    billing_mix: { actual: 1, estimated: 1, included: 0, unknown: 2 },
    calls: 24, unpriced_tokens: 1500,
    ...totalsOverride,
  },
  by_model: [
    { provider: 'openai-codex', model: 'openai/gpt-5.1-codex-super-long-model-name-for-wrapping', calls: 15 },
    { provider: 'anthropic', model: 'anthropic/claude-opus-4-6', calls: 9 },
  ],
})

export const overviewEconomics = () => ({
  ok: true, window_days: 30, headline: { status: 'partial', difference_usd: 999 }, accounts: [],
})

export const overviewBudgets = () => ({
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
})

/**
 * A `/health` body this bundle accepts as a complete pair. `contract` is passed
 * in from `T.REQUIRED_BACKEND_CONTRACT` rather than written here, so a contract
 * bump cannot leave the fixture claiming a pairing it no longer has.
 */
export const overviewHealth = contract => ({
  ok: true, version: '0.6.17', rate_card: 'catalogue', db_present: true,
  event_db_present: true, event_db_status: 'ok',
  build: { contract, revision: '0'.repeat(40), desktop_sha256: '0'.repeat(64) },
})

/**
 * The transport both renderers register. One mapping, so a browser case and a
 * browserless case cannot be answered differently.
 */
export const overviewTransport = ({ requiredContract, analyticsTotals } = {}) => async path => {
  if (path === '/analytics?days=30') return overviewAnalytics({ totals: analyticsTotals || {} })
  if (path === '/membership/accounts') {
    return { ok: true, accounts: overviewAccounts(), store: { loaded: true, error: '' }, notes: [] }
  }
  if (path === '/allowance/weather') return { ok: true, accounts: [] }
  if (path === '/economics/summary?days=30&trend_months=6') return overviewEconomics()
  if (path === '/budgets/status') return overviewBudgets()
  if (path === '/health') return overviewHealth(requiredContract)
  return { ok: true }
}
