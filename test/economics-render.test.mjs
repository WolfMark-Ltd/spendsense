// Run: node --test --test-force-exit test/*.test.mjs
//
// Subscription economics rendering regressions — real React, real
// TanStack Query, synthetic fixtures. Renders EconomicsSection directly with
// canned report payloads, and EconomicsPanel through a synthetic transport.
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

const work = mkdtempSync(join(tmpdir(), 'wm-econ-'))
process.on('exit', () => rmSync(work, { recursive: true, force: true }))

const entry = join(work, 'entry.mjs')
writeFileSync(entry, `
export { default as plugin, __test as T } from '${join(ROOT, 'desktop', 'plugin.js')}'
export * as React from 'react'
export * as ReactDOMClient from 'react-dom/client'
export { QueryClientProvider, queryClient, host, $testConnectionId, $testProfile, gatewayActivationEpoch, i18nCalls, i18nBackend } from '@hermes/plugin-sdk'
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
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/' })
const define = (name, value) => Object.defineProperty(globalThis, name, {
  value, configurable: true, writable: true,
})
define('window', dom.window)
define('document', dom.window.document)
define('navigator', dom.window.navigator)
define('HTMLElement', dom.window.HTMLElement)
define('Node', dom.window.Node)
define('FormData', dom.window.FormData)
define('MouseEvent', dom.window.MouseEvent)
define('Event', dom.window.Event)
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const lib = await import(pathToFileURL(bundle).href)
const { plugin, T, React, ReactDOMClient, QueryClientProvider, queryClient, $testConnectionId, $testProfile, i18nCalls, i18nBackend } = lib
const translated = (key, ...args) => i18nCalls.some(call =>
  call.length === args.length + 1 && call[0] === key && args.every((a, i) => call[i + 1] === a))
// Render through the real English catalogue: assertions see what users see,
// and a key missing from en fails closed to the key itself.
i18nBackend.t = (key, ...args) => {
  const entry = T.I18N.en[key]
  return typeof entry === 'function' ? entry(...args) : entry ?? key
}

test('historical fee note passes its account count in English and Simplified Chinese', () => {
  for (const language of ['en', 'zh']) {
    const t = (key, ...args) => {
      const entry = T.I18N[language][key]
      return typeof entry === 'function' ? entry(...args) : entry ?? key
    }
    const counted = T.econNoteText({ code: 'econ_group_window_history_missing',
      params: { count: 3 } }, 'fallback', t)
    assert.match(counted, /3/)
    const withoutCount = T.econNoteText({ code: 'econ_group_window_history_missing',
      params: {} }, 'fallback', t)
    assert.doesNotMatch(withoutCount, /undefined/)
    assert.notEqual(withoutCount, 'fallback')
  }
})

function controller() {
  const calls = []
  let responder = () => ({ ok: true })
  const transport = (path, opts = {}) => {
    const call = { path, method: String(opts.method || 'GET').toUpperCase(), body: opts.body }
    calls.push(call)
    return Promise.resolve().then(() => responder(call))
  }
  return { calls, transport, respond(fn) { responder = fn }, reset() { calls.length = 0 } }
}
const transportCtl = controller()

plugin.register({
  rest: transportCtl.transport,
  storage: { get: (_k, d) => d, set() {}, delete() {} },
  register() {}, registerMany() {}, onDispose() {}, onEvent: () => () => {},
  setTimeout: (fn) => { const t = setTimeout(fn, 0); return () => clearTimeout(t) },
  setInterval: () => () => {},
  addEventListener: () => () => {},
  os: {}, pet: null, i18n: { register() {}, t: key => key },
})

const econFixture = () => ({
  ok: true,
  window: { days: 30 },
  window_days: 29.5,
  headline: {
    status: 'ok',
    fees_monthly_by_currency: [{ currency: 'USD', amount: 20 }],
    fees_window_by_currency: [{ currency: 'USD', amount: 19.37 }],
    usage_usd: 2.0,
    difference_usd: -17.37,
    difference_label: 'Estimated value comparison over the same window (API-equivalent value minus fees)',
    notes: ['Estimated value comparison of recorded usage against fees.'],
  },
  groups: [{
    currency: 'USD', monthly_fees: 20, window_fees: 19.37, fee_accounts: 1,
    unknown_fee_accounts: [],
    usage_usd: 2.0, difference_usd: -17.37, converted: false, fx: null,
    status: 'ok', notes: [],
  }],
  accounts: [{
    account_id: 'test:default', label: 'Test account', family: 'test',
    arrangement: 'subscription', plan_id: 'test.plus', plan_name: 'Test Plus',
    fee: { amount: 20, currency: 'USD', period: 'month', basis: 'catalogue', confidence: 'verified' },
    monthly_equivalent: { amount: 20, currency: 'USD' }, monthly_equivalent_usd: 20, fx: null,
    window_expenditure: { amount: 19.37, currency: 'USD' }, window_expenditure_usd: 19.37,
    renewal: { amount: 20, currency: 'USD', period: 'month', anchor_day: 12,
      date: '2026-11-12T00:00:00Z', date_known: true },
    usage: { list_usd: 2.0, tokens: 1_000_000, calls: 12, priced_tokens: 1_000_000,
      unpriced_tokens: 0, unpriced_calls: 0, coverage: 1 },
    attribution: { routes: [{ route: 'test', basis: 'route' }], basis: 'route', note: 'route evidence' },
    difference_usd: -17.37, status: 'ok', notes: [],
  }],
  non_subscription_accounts: [{
    account_id: 'api:default', label: 'API account', family: 'api-only',
    arrangement: 'api_only', usage: { list_usd: 5.0, tokens: 100, calls: 2 },
    difference_usd: null, explanation: 'API Only: pay-as-you-go usage with no subscription to compare against.',
  }],
  unattributed: { routes: ['mystery'],
    usage: { list_usd: null, tokens: 500_000, calls: 3 },
    note: 'Usage on routes no account claims.' },
  ambiguous: { routes: [], usage: { list_usd: 0, tokens: 0, calls: 0 }, note: '' },
  trend: { months: [
    { month: '2026-09', fees_by_currency: [{ currency: 'USD', amount: 20 }], fees_usd: 20,
      usage_usd: 4, difference_usd: -16, in_progress: false, partial: false,
      recording_partial: false, difference_note: '' },
    { month: '2026-10', fees_by_currency: [{ currency: 'USD', amount: 20 }], fees_usd: 20,
      usage_usd: 2, difference_usd: -18, in_progress: true, partial: false,
      recording_partial: false, difference_note: '' },
  ], excluded_before_recording: 4, note: '' },
})

const roots = []
const renderSection = async (data, extra = {}) => {
  i18nCalls.length = 0
  T.$fxDraft.set(null)
  T.$fxNotice.set(null)
  T.$fxSaving.set(null)
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = ReactDOMClient.createRoot(container)
  roots.push(root)
  const saved = []
  await React.act(async () => {
    root.render(React.createElement(T.EconomicsSection, {
      data, identity: 'local|default#1', fxRates: [], fxReady: true,
      onSaveFx: rates => saved.push(rates), ...extra,
    }))
  })
  return { container, saved, text: () => container.textContent }
}

const renderCostsSummary = async ({ billing = {}, totals = {}, accounts = [], summaryReady = true } = {}, language = 'en') => {
  i18nCalls.length = 0
  const t = (key, ...args) => {
    const entry = T.I18N[language][key]
    return typeof entry === 'function' ? entry(...args) : entry ?? key
  }
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = ReactDOMClient.createRoot(container)
  roots.push(root)
  const ready = summaryReady
  await React.act(async () => {
    root.render(React.createElement(T.CostsEvidenceSummary, {
      billing, totals, accounts, fees: T.membershipSummary(accounts), accountsReady: true,
      summaryLoading: false, accountsLoading: false, summaryReady: ready, accountsFailed: false, t,
    }))
  })
  return { container, text: () => container.textContent }
}

const renderAttention = async ({ groups = [], econAccounts = [], unknownFees = null, fxError = '',
  onRetryFx = null, onOpenFx = null, onOpenLog = null } = {}, language = 'en') => {
  const t = (key, ...args) => {
    const entry = T.I18N[language][key]
    return typeof entry === 'function' ? entry(...args) : entry ?? key
  }
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = ReactDOMClient.createRoot(container)
  roots.push(root)
  await React.act(async () => {
    root.render(React.createElement(T.CostsAttention, {
      groups, econAccounts, unknownFees, fxError, onRetryFx, onOpenFx, onOpenLog, t,
    }))
  })
  return { container, text: () => container.textContent }
}

const flush = async (times = 6) => {
  await React.act(async () => {
    for (let i = 0; i < times; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 0))
    }
  })
}

after(() => { queryClient.clear(); dom.window.close() })
test.afterEach(async () => {
  while (roots.length) {
    const root = roots.pop()
    try { await React.act(async () => { root.unmount() }) } catch { /* already gone */ }
  }
  queryClient.clear()
})

test('the economics section leads with the three headline figures', async () => {
  const { container, text } = await renderSection(econFixture())
  assert.match(text(), /Monthly subscriptions/)
  assert.match(text(), /USD 20\.00\/mo/)
  assert.equal(container.querySelector('.wm-product-stat strong').textContent, 'USD 20.00/mo',
    'the headline fee amount renders in its own element')
  assert.match(text(), /API-equivalent usage/)
  assert.match(text(), /\$2\.00/)
  assert.match(text(), /Estimated value comparison/)
  assert.match(text(), /−\$17\.37/)
  assert.match(text(), /Not cash saved/)
  assert.match(text(), /USD 19\.37 in the last 30 days/)
  assert.match(text(), /same window/)
  assert.ok(translated('econPerMonth', 'USD 20.00'), 'the monthly fee value is interpolated')
  assert.ok(translated('econSpanDays', 30), 'the span interpolates rounded days')
  assert.ok(translated('econSubsSmall', 'USD 19.37', 'in the last 30 days', 1, 'Complete'),
    'the window value, span, count and status are interpolated')
})

test('unknown economics currencies stay localised in headline, window and group values', async () => {
  const previousTranslator = i18nBackend.t
  i18nBackend.t = (key, ...args) => {
    const entry = T.I18N.zh[key]
    return typeof entry === 'function' ? entry(...args) : entry ?? key
  }
  try {
    const data = econFixture()
    data.headline.fees_monthly_by_currency = [{ currency: 'XYZ', amount: 20 }]
    data.headline.fees_window_by_currency = [{ currency: 'XYZ', amount: 19.37 }]
    data.groups = [{
      currency: 'XYZ', monthly_fees: 20, window_fees: 19.37, fee_complete: true,
      window_fee_complete: true, usage_usd: null, difference_usd: null,
      status: 'unavailable', notes: [], blockers: []
    }]
    data.accounts = []
    const { text } = await renderSection(data)
    assert.match(text(), /币种未知 20\.00/)
    assert.match(text(), /币种未知 19\.37/)
    assert.doesNotMatch(text(), /Currency unknown/)
  } finally {
    i18nBackend.t = previousTranslator
  }
})

test('the breakdown names the membership, renewal and coverage', async () => {
  const { container, text } = await renderSection(econFixture())
  assert.match(text(), /Test account/)
  assert.match(text(), /Test Plus/)
  assert.match(text(), /USD 20\.00 due 2026-11-12/)
  assert.match(text(), /USD 19\.37 in window/)
  assert.match(text(), /Fully priced/)
  assert.ok(translated('econDue', 'USD 20.00', '2026-11-12'), 'the renewal amount and date are interpolated')
  assert.ok(translated('econInWindow', 'USD 19.37'), 'the windowed fee is interpolated')
  const headers = [...container.querySelectorAll('th')].map(th => th.textContent)
  assert.deepEqual(headers, ['Account', 'Membership', 'Monthly equiv.', 'API-equivalent usage',
    'Est. value difference', 'Pricing coverage'])
})

test('paired bars carry values and labels, never bare graphics', async () => {
  const { container } = await renderSection(econFixture())
  const labels = [...container.querySelectorAll('.wm-econ-bar-label')].map(el => el.textContent)
  assert.ok(labels.some(label => label.includes('Fees in window (USD)')), `fee bar labelled: ${labels}`)
  assert.ok(labels.some(label => label.includes('API-equivalent usage')), `usage bar labelled: ${labels}`)
  const values = [...container.querySelectorAll('.wm-econ-bar-value')].map(el => el.textContent)
  assert.ok(values.includes('$19.37'), `windowed fee value shown: ${values}`)
  assert.ok(values.includes('$2.00'), `usage value shown: ${values}`)
  const feeFill = container.querySelector('.wm-econ-bar-fill.wm-econ-fee')
  const usageFill = container.querySelector('.wm-econ-bar-fill.wm-econ-usage')
  assert.equal(feeFill.style.width, '100%')
  assert.equal(usageFill.style.width, '10%')
})

test('the trend shows comparable months with an in-progress flag', async () => {
  const { text } = await renderSection(econFixture())
  assert.match(text(), /2026-09/)
  assert.match(text(), /2026-10/)
  assert.match(text(), /in progress/)
})

test('api-only, unattributed and ambiguous usage stay outside the comparison', async () => {
  const { text } = await renderSection(econFixture())
  assert.match(text(), /Not in the comparison/)
  assert.match(text(), /API Only: pay-as-you-go/)
  assert.match(text(), /Unattributed: — on mystery/)
})

test('a missing comparison renders an unavailable state, not a zero', async () => {
  const data = econFixture()
  data.headline = { status: 'unavailable', fees_monthly_by_currency: [],
    usage_usd: null, difference_usd: null, notes: ['No subscription has a known fee.'] }
  data.groups = []
  data.accounts = []
  const { text } = await renderSection(data)
  assert.match(text(), /Unavailable/)
  assert.match(text(), /No subscription has a known fee/)
  assert.doesNotMatch(text(), /\$0\.00/)
})

test('a currency group with no comparison reason still explains the unavailable state', async () => {
  const data = econFixture()
  data.groups = [{ currency: 'USD', monthly_fees: 0, usage_usd: null,
    difference_usd: null, status: 'unavailable', notes: [], blockers: [] }]
  data.accounts = []
  const { text } = await renderSection(data)
  assert.match(text(), /No comparison available\./)
})

test('Costs distinguishes reported use, API-equivalent zero, missing charges, mixed fee currencies and partial cache evidence', async () => {
  const accounts = [
    { id: 'usd-zero', effective_arrangement: 'subscription', fee: { effective: { amount: 0, currency: 'USD', period: 'month' } },
      plan: { entitlements: { windows: [{ id: 'allowance', label: 'Allowance', amount: 100, currency: 'USD' }] } } },
    { id: 'gbp-month', effective_arrangement: 'subscription', fee: { effective: { amount: 20, currency: 'GBP', period: 'month' } }, plan: null },
    { id: 'fee-unknown', effective_arrangement: 'subscription', fee: { effective: { amount: null } }, plan: null },
  ]
  const { container, text } = await renderCostsSummary({
    billing: { evidence: {
      provider_reported: { usd: 0, basis: 'provider_history', source: 'Provider request history' },
      api_equivalent: { usd: 0, basis: 'current_catalogue', source: 'Current catalogue',
        pricing_coverage: { priced_tokens: 0, unpriced_tokens: 0, priced_calls: 1, unpriced_calls: 0 } },
      credits_consumed: { usd: 0, basis: 'membership_allowance', source: 'Declared allowance' },
      incremental_cash: { usd: null, basis: 'incomplete', source: 'No complete evidence' },
    } },
    totals: { tokens: 200, economics: { savings_usd: 0, uncached_usd: 2, cached_usd: 2,
      coverage: 0.5, covered_tokens: 100, covered_calls: 1, excluded_calls: 1,
      gap_reasons: { missing_cache_read_rate: 1 } } },
    accounts,
  })
  assert.equal(container.querySelector('[data-cost-kind="api"] .wm-cost-card-value').textContent, '$0.00')
  assert.match(container.querySelector('[data-cost-kind="api"]').textContent, /Fully priced/,
    'a zero amount remains a known value when all API-equivalent usage is priced')
  assert.equal(container.querySelector('[data-cost-kind="reported"] .wm-cost-card-value').textContent, '$0.00')
  assert.equal(container.querySelector('[data-cost-kind="charges"] .wm-cost-card-value').textContent, 'Not recorded')
  assert.doesNotMatch(container.querySelector('[data-cost-kind="charges"]').textContent, /\$0\.00/)
  const cache = container.querySelector('[data-cost-kind="cache"]')
  assert.equal(cache.querySelector('.wm-cost-card-value').textContent, '$0.00')
  assert.match(cache.textContent, /Partial/)
  assert.match(cache.textContent, /API-equivalent value is zero/)
  const fees = [...container.querySelectorAll('.wm-cost-fee-lines li')].map(line => line.textContent)
  assert.deepEqual(fees, ['USD 0.00/mo', 'GBP 20.00/mo'])
  assert.match(container.querySelector('[data-cost-kind="fees"]').textContent, /1 fee unknown/)
  assert.match(container.querySelector('[data-cost-kind="allowances"]').textContent, /1 limit/)
  assert.match(text(), /Credits consumed/)
  assert.match(text(), /Provider request history/)
  assert.match(text(), /Tokens with cache rate evidence: 100 of 200/)
  assert.equal(container.querySelectorAll('.wm-cost-card-details').length, 0)
  assert.equal(container.querySelectorAll('.wm-cost-other-billing:not([open])').length, 1)
})

test('Costs labels API-equivalent subtotals as partial and discloses exact coverage in both languages', async () => {
  for (const [language, partialLabel, customPhrase, counts] of [
    ['en', 'Priced subtotal', 'configured custom rates',
      '100 tokens priced across 1 calls; 50 tokens across 2 calls have no API-equivalent price'],
    ['zh', '已定价小计', '已配置自定义费率',
      '100 个 token 已定价，涉及 1 次调用；50 个 token、2 次调用缺少 API 等值价格'],
  ]) {
    const { container } = await renderCostsSummary({ billing: { evidence: {
      api_equivalent: { usd: 1.25, basis: 'estimated', source: 'Published catalogue or configured custom rate',
        pricing_coverage: { priced_tokens: 100, unpriced_tokens: 50, priced_calls: 1, unpriced_calls: 2 } },
    } } }, language)
    const card = container.querySelector('[data-cost-kind="api"]')
    assert.equal(card.querySelector('.wm-cost-card-value').textContent, '$1.25')
    assert.match(card.textContent, /Partial|部分/)
    assert.match(card.textContent, new RegExp(partialLabel))

    container.querySelector('.wm-cost-other-billing').open = true
    const apiDetails = container.querySelector('.wm-cost-detail-row')
    assert.match(apiDetails.textContent, new RegExp(customPhrase))
    assert.match(apiDetails.textContent, new RegExp(counts))
  }
})

test('Costs treats missing API-equivalent coverage as unknown, even when an amount is present', async () => {
  const { container } = await renderCostsSummary({ billing: { evidence: {
    api_equivalent: { usd: 0, basis: 'estimated', source: 'Published catalogue' },
  } } })
  const card = container.querySelector('[data-cost-kind="api"]')
  assert.equal(card.querySelector('.wm-cost-card-value').textContent, '$0.00')
  assert.match(card.textContent, /Coverage unknown/)
  assert.match(card.textContent, /amount may be partial/)
  assert.doesNotMatch(card.textContent, /Fully priced/)

  const unpriced = await renderCostsSummary({ billing: { evidence: {
    api_equivalent: { usd: null, basis: 'unpriced', source: 'No published rate',
      pricing_coverage: { priced_tokens: 0, unpriced_tokens: 50, priced_calls: 0, unpriced_calls: 1 } },
  } } })
  const unpricedCard = unpriced.container.querySelector('[data-cost-kind="api"]')
  assert.match(unpricedCard.textContent, /Unknown/)
  assert.match(unpricedCard.textContent, /No priced subtotal/)
})

test('Costs does not count included or no-plan routes as subscriptions with unknown fees', async () => {
  const paidOwner = { id: 'owner', effective_arrangement: 'subscription',
    fee: { effective: { amount: 20, currency: 'USD', period: 'month' } } }
  const includedRoute = { id: 'included', effective_arrangement: 'included',
    fee: { basis: 'included', effective: { amount: null } } }
  const noPlanRoute = { id: 'no-plan', effective_arrangement: 'no_plan',
    fee: { basis: 'no_plan', effective: { amount: null } } }

  const withIncluded = await renderCostsSummary({ accounts: [paidOwner, includedRoute] })
  const includedFees = withIncluded.container.querySelector('[data-cost-kind="fees"]')
  assert.deepEqual([...includedFees.querySelectorAll('.wm-cost-fee-lines li')].map(line => line.textContent), ['USD 20.00/mo'])
  assert.match(includedFees.textContent, /Saved/)
  assert.doesNotMatch(includedFees.textContent, /fee unknown|No known fee/)

  const noPlanOnly = await renderCostsSummary({ accounts: [noPlanRoute] })
  const noPlanFees = noPlanOnly.container.querySelector('[data-cost-kind="fees"]')
  assert.match(noPlanFees.textContent, /No saved recurring fees/)
  assert.doesNotMatch(noPlanFees.textContent, /No known fee|fee unknown/)
})

test('Costs keeps negative cache savings and unknown coverage distinct in both languages', async () => {
  for (const [language, negative, unknown, partial, coverageUnknown, negativeExplanation] of [
    ['en', '−$0.400', 'No complete cache price evidence', 'Partial', 'Coverage unknown',
      'cached API-equivalent cost exceeded the uncached equivalent'],
    ['zh', '−$0.400', '没有完整的缓存费率证据', '部分', '覆盖情况未知',
      '缓存用量的 API 等值成本高于未缓存等值'],
  ]) {
    const { container } = await renderCostsSummary({
      totals: { tokens: 10, economics: { savings_usd: -0.4, uncached_usd: 0.1, cached_usd: 0.5,
        coverage: 0.2, covered_tokens: 2, covered_calls: 1, excluded_calls: 4, gap_reasons: {} } },
    }, language)
    const negativeCard = container.querySelector('[data-cost-kind="cache-negative"]')
    assert.equal(negativeCard.querySelector('.wm-cost-card-value').textContent, negative)
    assert.match(negativeCard.textContent, new RegExp(partial))
    assert.match(negativeCard.textContent, new RegExp(negativeExplanation))
    await React.act(async () => { roots.pop().unmount() })

    const missing = await renderCostsSummary({
      totals: { tokens: 10, economics: { savings_usd: null, uncached_usd: null, cached_usd: null,
        coverage: null, covered_tokens: 0, covered_calls: 0, excluded_calls: 4, gap_reasons: {} } },
    }, language)
    const unknownCard = missing.container.querySelector('[data-cost-kind="cache"]')
    assert.match(unknownCard.textContent, new RegExp(unknown))
    assert.doesNotMatch(unknownCard.querySelector('.wm-cost-card-value').textContent, /\$0\.00/)
    await React.act(async () => { roots.pop().unmount() })

    const partialCoverage = await renderCostsSummary({
      totals: { tokens: 0, economics: { savings_usd: 0, coverage: 0.5,
        covered_calls: 1, excluded_calls: 0 } },
    }, language)
    const partialCard = partialCoverage.container.querySelector('[data-cost-kind="cache"]')
    assert.match(partialCard.textContent, new RegExp(partial), 'known coverage below 100% remains partial even with no excluded calls')
    await React.act(async () => { roots.pop().unmount() })

    const unknownCoverage = await renderCostsSummary({
      totals: { tokens: 10, economics: { savings_usd: 0.1, coverage: null,
        covered_calls: 1, excluded_calls: 0 } },
    }, language)
    const unknownCoverageCard = unknownCoverage.container.querySelector('[data-cost-kind="cache"]')
    assert.match(unknownCoverageCard.textContent, new RegExp(coverageUnknown))
    assert.doesNotMatch(unknownCoverageCard.textContent, new RegExp(partial))
  }
})

test('blocked comparison reasons provide Memberships, Usage, pricing and FX actions, including zero usage', async () => {
  const data = econFixture()
  data.groups = [{ currency: 'GBP', monthly_fees: 20, window_fees: 20, fee_complete: true,
    window_fee_complete: true, usage_usd: 0, difference_usd: null, converted: false,
    fx: null, status: 'unavailable', notes: [], blockers: [
      { account_id: 'fee', code: 'subscription_fee_missing' },
      { account_id: 'fx', code: 'dated_fx_rate_missing', currency: 'GBP' },
      { account_id: 'usage', code: 'no_usage_recorded' },
      { account_id: 'price', code: 'provider_price_catalogue_missing' },
    ] }]
  data.accounts = []
  const fxOpened = []
  const { container, text } = await renderSection(data, { onOpenFx: () => fxOpened.push(true) })
  assert.match(text(), /\$0\.00 usage/, 'a valid zero is not mistaken for missing usage')
  const actions = [...container.querySelectorAll('.wm-econ-action')]
  assert.deepEqual(actions.map(button => button.textContent), [
    'Review in Memberships', 'Add dated FX rate', 'Review in Usage', 'Check pricing settings',
  ])
  await React.act(async () => { actions[1].dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  assert.deepEqual(fxOpened, [true])
  await React.act(async () => { actions[0].dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  assert.equal(T.$ledgerTab.get(), 'memberships')
  await React.act(async () => { actions[2].dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  assert.equal(T.$ledgerTab.get(), 'usage')
  await React.act(async () => { actions[3].dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  assert.equal(T.$ledgerTab.get(), 'settings')
})

test('missing fees, dated FX and historical window fees have per-account blockers in both languages', async () => {
  const data = econFixture()
  data.headline = {
    status: 'unavailable',
    fees_monthly_by_currency: [
      { currency: 'GBP', amount: null, complete: false, unknown_fee_accounts: ['gbp:default'] },
      { currency: 'USD', amount: 30, complete: true, unknown_fee_accounts: [] },
    ],
    fees_window_by_currency: [], usage_usd: null, difference_usd: null,
    notes: ['Historical fee evidence is missing for the reporting window.'],
  }
  data.groups = [
    { currency: 'GBP', monthly_fees: null, window_fees: null, fee_accounts: 0,
      unknown_fee_accounts: ['gbp:default'], fee_complete: false, window_fee_complete: false,
      usage_usd: 1, difference_usd: null, status: 'unavailable', notes: [],
      blockers: [{ account_id: 'gbp:default', code: 'subscription_fee_missing' },
        { account_id: 'gbp:default', code: 'dated_fx_rate_missing', currency: 'GBP' }] },
    { currency: 'USD', monthly_fees: 30, window_fees: null, fee_accounts: 1,
      unknown_fee_accounts: [], fee_complete: true, window_fee_complete: false,
      usage_usd: 2, difference_usd: null, status: 'unavailable', notes: [],
      blockers: [{ account_id: 'test:default', code: 'window_fee_history_missing' }] },
  ]
  data.accounts[0].window_expenditure.amount = null
  data.accounts[0].blockers = [
    { code: 'window_fee_history_missing' },
    { code: 'missing_cache_read_rate' },
  ]
  const previousTranslator = i18nBackend.t
  try {
    for (const [language, expected, knownFee] of [
      ['en', ['Set or confirm this account’s subscription fee in Memberships.',
        'Add a dated user-supplied GBP to USD rate in Costs.',
        'Historical fee evidence is incomplete; add its effective date and amount in Memberships.',
        'A cache rate is unavailable; check the provider’s cache price evidence.'], 'USD 30.00/mo'],
      ['zh', ['请在“会员”中设置或确认此账户的订阅费用。',
        '请在“费用”中添加注明日期的 GBP 兑 USD 用户提供汇率。',
        '历史费用证据不完整；请在“会员”中补充生效日期和金额。',
        '缓存费率不可用；请检查供应商缓存价格证据。'], 'USD 30.00/月'],
    ]) {
      i18nBackend.t = (key, ...args) => {
        const entry = T.I18N[language][key]
        return typeof entry === 'function' ? entry(...args) : entry ?? key
      }
      const { text } = await renderSection(data)
      for (const phrase of expected) assert.ok(text().includes(phrase), `${language}: ${phrase}`)
      assert.ok(text().includes(knownFee), `${language}: known current USD fee remains visible`)
      assert.doesNotMatch(text(), /\$0\.00/)
    }
  } finally {
    i18nBackend.t = previousTranslator
  }
})

test('the insufficient-history blocker agrees across languages on continued recording', async () => {
  const data = econFixture()
  data.groups[0].status = 'unavailable'
  data.groups[0].blockers = [{ account_id: 'test:default', code: 'insufficient_comparison_history' }]
  data.accounts[0].status = 'unavailable'
  data.accounts[0].blockers = [{ account_id: 'test:default', code: 'insufficient_comparison_history' }]
  const previousTranslator = i18nBackend.t
  try {
    for (const [language, phrase, unavailable] of [
      ['en', 'Continue recording before comparing.', /shorter period|Extend the window/],
      ['zh', '延长记录时间后再比较', /较短周期/],
    ]) {
      i18nBackend.t = (key, ...args) => {
        const entry = T.I18N[language][key]
        return typeof entry === 'function' ? entry(...args) : entry ?? key
      }
      const { text } = await renderSection(data)
      assert.ok(text().includes(phrase), `${language}: ${phrase}`)
      assert.doesNotMatch(text(), unavailable, `${language} never advises changing the fixed comparison window`)
    }
  } finally {
    i18nBackend.t = previousTranslator
  }
})

test('the fx editor stages a rate and saves the whole document', async () => {
  const { container, saved } = await renderSection(econFixture())
  const form = container.querySelector('form.wm-econ-fx-form')
  assert.ok(form, 'the fx form renders')
  const set = (name, value) => {
    const input = form.querySelector(`input[name="${name}"]`)
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, value)
    input.dispatchEvent(new window.Event('input', { bubbles: true }))
  }
  set('currency', 'gbp')
  set('usd_per_unit', '1.25')
  set('as_of', '2026-10-31')
  set('source', 'Example Bank')
  await React.act(async () => {
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))
  })
  await flush(2)
  assert.match(container.textContent, /GBP at 1\.25 USD per unit, dated 2026-10-31 \(Example Bank\)/)
  assert.ok(translated('fxRateLine', 'GBP', 1.25, '2026-10-31', 'Example Bank'),
    'the staged rate values are interpolated')
  const save = [...container.querySelectorAll('button')].find(b => b.textContent === 'Save rates')
  assert.ok(save && !save.disabled, 'save enables once the draft differs')
  await React.act(async () => { save.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  assert.equal(saved.length, 1)
  assert.deepEqual(saved[0], [{ currency: 'GBP', usd_per_unit: 1.25,
    as_of: '2026-10-31', source: 'Example Bank' }])
})

test('a converted group cites its rate beside the bars', async () => {
  const data = econFixture()
  data.groups = [{
    currency: 'GBP', monthly_fees: 4.25, window_fees: 4.12, fee_accounts: 1,
    unknown_fee_accounts: [],
    usage_usd: 1.0, difference_usd: -4.15, converted: true,
    fx: { currency: 'GBP', usd_per_unit: 1.25, as_of: '2026-10-31', source: 'Example Bank' },
    status: 'ok', notes: [],
  }]
  const { container, text } = await renderSection(data)
  assert.match(text(), /Fees in window \(GBP, in USD\)/)
  assert.match(text(), /Converted at 1\.25 USD per GBP, dated 2026-10-31 \(Example Bank\)/)
  // The converted bar converts the windowed fee: 4.12 × 1.25 = $5.15.
  const values = [...container.querySelectorAll('.wm-econ-bar-value')].map(el => el.textContent)
  assert.ok(values.includes('$5.15'), `converted window fee shown: ${values}`)
})

test('the economics panel reads the report and the rates for this connection', async () => {
  $testConnectionId.set('gateway-a')
  $testProfile.set('default')
  const data = econFixture()
  transportCtl.reset()
  transportCtl.respond(call => {
    if (call.path.startsWith('/economics/summary')) return { ...data }
    if (call.path.startsWith('/membership/fx')) return { ok: true, rates: [], loaded: false }
    throw new Error(`unexpected path ${call.path}`)
  })
  queryClient.clear()
  T.$fxDraft.set(null)
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = ReactDOMClient.createRoot(container)
  roots.push(root)
  await React.act(async () => {
    root.render(React.createElement(QueryClientProvider, { client: queryClient },
      React.createElement(T.EconomicsPanel, { identity: T.membershipIdentityNow() })))
  })
  await flush(8)
  assert.match(container.textContent, /Subscription economics/)
  assert.match(container.textContent, /−\$17\.37/)
  assert.ok(transportCtl.calls.some(call => call.path.startsWith('/economics/summary?days=30')),
    `economics fetched: ${JSON.stringify(transportCtl.calls)}`)
  assert.ok(transportCtl.calls.some(call => call.path === '/membership/fx'),
    `fx fetched: ${JSON.stringify(transportCtl.calls)}`)
})

test('a partially priced trend month keeps its bars and warns it is a lower bound', async () => {
  const data = econFixture()
  data.trend = { months: [{
    month: '2026-10', fees_by_currency: [{ currency: 'USD', amount: 20 }], fees_usd: 20,
    usage_usd: 2.0, usage_coverage: 0.5, has_unpriced_usage: true, difference_usd: -18.0,
    in_progress: false, partial: true, recording_partial: false,
    difference_note: "Only 50.0% of this month's usage is priced; the value is a lower bound.",
  }], excluded_before_recording: 0, note: '' }
  const { container, text } = await renderSection(data)
  assert.ok(container.querySelector('.wm-econ-trend-bars'), 'bars still render')
  assert.match(text(), /partial pricing/)
  assert.match(text(), /lower bound/)
})

test('a route ownership transition is labelled as partial attribution', async () => {
  const data = econFixture()
  data.trend = { months: [{
    month: '2026-10', fees_by_currency: [{ currency: 'USD', amount: 20 }], fees_usd: 20,
    usage_usd: null, usage_calls: 0, unattributed_usage_calls: 1, difference_usd: null,
    in_progress: false, partial: true, partial_pricing: false, partial_attribution: true,
    recording_partial: false,
    difference_note: 'Shared route ownership changed during this month; observed usage on affected routes was excluded from this comparison: route-anthropic.',
  }], excluded_before_recording: 0, note: '' }
  const { container, text } = await renderSection(data)
  assert.equal(container.querySelector('.wm-econ-trend-bars'), null)
  assert.match(text(), /partial attribution/)
  assert.doesNotMatch(text(), /partial pricing/)
  assert.match(text(), /observed usage on affected routes was excluded from this comparison/)
})

test('a fully unpriced trend month shows no value and no bars', async () => {
  const data = econFixture()
  data.trend = { months: [{
    month: '2026-10', fees_by_currency: [{ currency: 'USD', amount: 20 }], fees_usd: null,
    usage_usd: null, usage_coverage: 0, has_unpriced_usage: true, difference_usd: null,
    in_progress: true, partial: false, recording_partial: false,
    difference_note: 'Usage in this month has no published price.',
  }], excluded_before_recording: 0, note: '' }
  const { container, text } = await renderSection(data)
  assert.equal(container.querySelector('.wm-econ-trend-bars'), null)
  assert.match(text(), /— usage/)
  assert.match(text(), /no published price/)
  assert.doesNotMatch(text(), /\$0\.00 usage/)
})

test('a trend month without a converted fee total degrades to a text row', async () => {
  // Older backends predate fees_usd; the client must not sum mixed
  // currencies itself to draw the bars.
  const data = econFixture()
  data.trend = { months: [{
    month: '2026-10', fees_by_currency: [{ currency: 'GBP', amount: 4.25 }],
    usage_usd: 1.0, difference_usd: null, in_progress: false, partial: false,
    recording_partial: false, difference_note: 'Non-USD fees with no FX rate dated in this month.',
  }], excluded_before_recording: 0, note: '' }
  const { container, text } = await renderSection(data)
  assert.equal(container.querySelector('.wm-econ-trend-bars'), null)
  assert.match(text(), /GBP 4\.25\/mo/)
  assert.ok(translated('econPerMonth', 'GBP 4.25'), 'the fallback fee value is interpolated')
  assert.match(text(), /no FX rate dated in this month/)
})

test('the fx editor stays disabled until the saved rates load', async () => {
  const { container } = await renderSection(econFixture(), { fxReady: false, fxError: '' })
  assert.match(container.textContent, /Reading saved FX rates/)
  const save = [...container.querySelectorAll('button')].find(b => b.textContent === 'Save rates')
  assert.ok(save && save.disabled, 'save is blocked before the read completes')
  const add = [...container.querySelectorAll('button')].find(b => b.textContent === 'Add rate')
  assert.ok(add && add.disabled, 'staging is blocked before the read completes')
  assert.doesNotMatch(container.textContent, /No FX rates saved/)
})

test('a failed fx read explains itself and offers a retry', async () => {
  let retries = 0
  const { container } = await renderSection(econFixture(),
    { fxReady: false, fxError: 'Saved FX rates could not be read for this connection.',
      onRetryFx: () => { retries += 1 } })
  assert.match(container.textContent, /could not be read for this connection/)
  const retry = [...container.querySelectorAll('button')].find(b => b.textContent === 'Retry')
  assert.ok(retry, 'retry renders')
  await React.act(async () => { retry.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  assert.equal(retries, 1)
})

test('the saving flag belongs to one connection only', async () => {
  const { container } = await renderSection(econFixture())
  await React.act(async () => { T.$fxSaving.set({ origin: 'elsewhere|default#9' }) })
  await flush(2)
  const save = [...container.querySelectorAll('button')].find(b => /Save rates|Saving…/.test(b.textContent))
  assert.equal(save.textContent, 'Save rates', 'another connection saving does not stick this button')
  await React.act(async () => { T.$fxSaving.set({ origin: 'local|default#1' }) })
  await flush(2)
  assert.equal(save.textContent, 'Saving…', 'this connection saving shows')
  assert.ok(save.disabled)
})

test('membership edits invalidate the cached economics comparison', async () => {
  $testConnectionId.set('gateway-a')
  $testProfile.set('default')
  const identity = T.membershipIdentityNow()
  const other = 'elsewhere|default#9'
  queryClient.clear()
  const keyFor = id => [plugin.id, 'economics-summary', id]
  queryClient.setQueryData(keyFor(identity), { ...econFixture(), identity })
  queryClient.setQueryData(keyFor(other), { ...econFixture(), identity: other })
  assert.equal(queryClient.getQueryState(keyFor(identity))?.isInvalidated, false)
  await T.invalidateEconomicsFor(identity)
  assert.equal(queryClient.getQueryState(keyFor(identity))?.isInvalidated, true)
  assert.equal(queryClient.getQueryState(keyFor(other))?.isInvalidated, false)
})

test('the attention summary groups blockers into fix, history and unavailable', async () => {
  const econAccounts = [
    { account_id: 'a:one', label: 'First account', family: 'a' },
    { account_id: 'a:two', label: 'Second account', family: 'a' },
    { account_id: 'route-x', label: 'Mystery account', family: 'x' },
  ]
  const groups = [{ currency: 'GBP', blockers: [
    { account_id: 'a:one', code: 'subscription_fee_missing' },
    { account_id: 'a:two', code: 'subscription_fee_missing' },
    { account_id: 'a:one', code: 'no_usage_recorded' },
    { account_id: 'a:one', code: 'missing_cache_read_rate' },
    { account_id: 'route-x', code: 'mystery_future_code' },
  ] }]
  const { container, text } = await renderAttention({ groups, econAccounts })
  assert.match(text(), /What needs attention\?/)
  assert.equal(container.querySelector('.wm-cost-attn-count').textContent, '4')
  const titles = [...container.querySelectorAll('.wm-cost-attn-cat-title')].map(el => el.textContent)
  assert.deepEqual(titles, ['Fix now', 'Needs more history', 'Not recorded / unavailable'])
  const fix = container.querySelector('[data-attn-category="fix"]')
  assert.match(fix.textContent, /Set or confirm this account’s subscription fee/)
  assert.match(fix.textContent, /2 accounts/)
  assert.match(fix.textContent, /First account/)
  assert.match(fix.textContent, /Second account/)
  assert.doesNotMatch(fix.textContent, /a:one|a:two/,
    'friendly labels replace raw account ids in standard view')
  assert.equal(fix.querySelector('button').textContent, 'Review in Memberships')
  const history = container.querySelector('[data-attn-category="history"]')
  assert.match(history.textContent, /No calls were recorded/)
  assert.equal(history.querySelector('button'), null, 'history items carry guidance, not actions')
  const unavailable = [...container.querySelectorAll('[data-attn-category="unavailable"]')]
  assert.equal(unavailable.length, 2)
  assert.doesNotMatch(text(), /mystery_future_code|route-x/,
    'raw codes and slugs stay out of the attention summary')
  assert.match(text(), /exact code is in the blocker log/)
  for (const row of unavailable) {
    assert.equal(row.querySelector('button').textContent, 'View blocker log')
  }
  const unlabeled = await renderAttention({ groups: [{ currency: 'USD',
    blockers: [{ account_id: 'raw:slug', code: 'subscription_fee_missing' }] }], econAccounts: [] })
  assert.doesNotMatch(unlabeled.container.querySelector('.wm-cost-attn-text').textContent, /raw:slug/,
    'default row text never shows a raw id')
  assert.match(unlabeled.text(), /raw:slug/,
    'an id without a friendly label falls back inside the deliberate expander only')
})

test('attention actions navigate, open FX and retry the failed read', async () => {
  const calls = []
  const { container } = await renderAttention({
    groups: [{ currency: 'GBP', blockers: [
      { account_id: 'a', code: 'subscription_fee_missing' },
      { account_id: 'b', code: 'dated_fx_rate_missing', currency: 'GBP' },
      { account_id: 'c', code: 'model_unidentified' },
      { account_id: 'd', code: 'missing_cache_read_rate' },
    ] }],
    econAccounts: [],
    fxError: 'Saved FX rates could not be read for this connection.',
    onRetryFx: () => calls.push('retry'),
    onOpenFx: () => calls.push('fx'),
    onOpenLog: () => calls.push('log'),
  })
  const buttons = [...container.querySelectorAll('.wm-cost-attn-action')]
  assert.deepEqual(buttons.map(button => button.textContent), [
    'Add dated FX rate', 'Review in Usage', 'Review in Memberships', 'Retry', 'View blocker log',
  ])
  T.$ledgerTab.set('costs')
  await React.act(async () => { buttons[2].dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  assert.equal(T.$ledgerTab.get(), 'memberships')
  await React.act(async () => { buttons[0].dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  await React.act(async () => { buttons[3].dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  await React.act(async () => { buttons[4].dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  assert.deepEqual(calls, ['fx', 'retry', 'log'])
  await React.act(async () => { buttons[1].dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  assert.equal(T.$ledgerTab.get(), 'usage')
})

test('scrolling to attention focuses its heading', async () => {
  const section = document.createElement('section')
  section.id = 'wm-costs-attention'
  section.innerHTML = '<h2 tabindex="-1" data-costs-attention-heading>What needs attention?</h2>'
  document.body.appendChild(section)
  try {
    T.scrollToCostsAttention()
    assert.equal(document.activeElement, section.querySelector('h2'))
  } finally {
    section.remove()
  }
})

test('unknown membership fees raise one fix item unless a fee blocker exists', async () => {
  const alone = await renderAttention({ unknownFees: { count: 2, labels: ['Plan A', 'Plan B'] } })
  assert.match(alone.text(), /Set or confirm this account’s subscription fee/)
  assert.match(alone.text(), /2 accounts/)
  assert.match(alone.text(), /Plan A/)
  const covered = await renderAttention({
    groups: [{ currency: 'USD', blockers: [{ account_id: 'a', code: 'subscription_fee_missing' }] }],
    econAccounts: [{ account_id: 'a', label: 'Covered account' }],
    unknownFees: { count: 1, labels: ['Covered account'] },
  })
  assert.equal(covered.container.querySelectorAll('[data-attn-category="fix"]').length, 1,
    'the backend fee blocker and the unknown-fee fallback never double-report')
})

test('unknown-currency fee blockers render once with their account', async () => {
  const { container, text } = await renderAttention({
    groups: [{ currency: 'unknown',
      blockers: [{ account_id: 'u:one', code: 'subscription_fee_missing' }] }],
    econAccounts: [{ account_id: 'u:one', label: 'Unknown currency account',
      fee: { currency: null }, blockers: [{ code: 'subscription_fee_missing' }] }],
  })
  assert.equal(container.querySelectorAll('[data-attn-category="fix"]').length, 1,
    'group and account passes dedupe to one row')
  assert.equal(container.querySelector('.wm-cost-attn-count').textContent, '1')
  assert.match(text(), /Unknown currency account/)
  assert.doesNotMatch(text(), /u:one/)
})

test('an empty comparison shows the quiet attention state', async () => {
  const { text } = await renderAttention({})
  assert.match(text(), /Nothing needs attention/)
  const { text: zhText } = await renderAttention({}, 'zh')
  assert.match(zhText(), /没有需要注意的事项/)
})

test('the attention summary translates its categories and actions', async () => {
  const { container, text } = await renderAttention({
    groups: [{ currency: 'GBP', blockers: [
      { account_id: 'a', code: 'dated_fx_rate_missing', currency: 'GBP' },
      { account_id: 'a', code: 'insufficient_comparison_history' },
      { account_id: 'b', code: 'tier_rate_unavailable' },
    ] }],
    econAccounts: [{ account_id: 'a', label: '测试帐户' }],
  }, 'zh')
  assert.match(text(), /哪些事项需要注意？/)
  const titles = [...container.querySelectorAll('.wm-cost-attn-cat-title')].map(el => el.textContent)
  assert.deepEqual(titles, ['立即处理', '需要更多历史记录', '未记录/不可用'])
  const buttons = [...container.querySelectorAll('.wm-cost-attn-action')].map(button => button.textContent)
  assert.deepEqual(buttons, ['添加注明日期的汇率', '查看问题日志'])
  assert.doesNotMatch(text(), /undefined/)
})

test('group rows stay compact with supported figures and link to attention', async () => {
  const data = econFixture()
  data.groups = [{ currency: 'GBP', monthly_fees: 20, window_fees: 20, fee_complete: true,
    window_fee_complete: true, usage_usd: 0, difference_usd: null, converted: false,
    fx: null, status: 'unavailable', notes: [], blockers: [
      { account_id: 'gbp:default', code: 'dated_fx_rate_missing', currency: 'GBP' },
    ] }]
  data.accounts = []
  const { container } = await renderSection(data)
  const row = container.querySelector('[data-econ-group="GBP"]')
  assert.ok(row, 'the currency row renders')
  assert.match(row.querySelector('.wm-econ-group-money').textContent, /GBP 20\.00 fees in window/)
  assert.match(row.querySelector('.wm-econ-group-money').textContent, /\$0\.00 usage/)
  assert.equal(row.querySelector('.wm-econ-chip').textContent, 'Unavailable')
  assert.doesNotMatch(row.textContent, /Add a dated user-supplied/,
    'blocker sentences leave the default row for the attention summary')
  const jump = row.querySelector('.wm-econ-see-attention')
  assert.equal(jump.textContent, '1 issue needs attention — see above')
  const log = container.querySelector('#wm-cost-blocker-log')
  assert.ok(log, 'the full blocker log stays available behind a labelled disclosure')
  assert.equal(log.open, false)
  assert.match(log.textContent, /gbp:default/)
  assert.match(log.textContent, /Add a dated user-supplied GBP to USD rate/)
  const comparable = await renderSection(econFixture())
  assert.match(comparable.container.querySelector('[data-econ-group="USD"] .wm-econ-group-money').textContent,
    /−\$17\.37 difference/, 'a supported group difference stays visible with its label')
})

test('unknown blocker codes keep raw evidence in the log only', async () => {
  const data = econFixture()
  data.groups = [{ currency: 'USD', monthly_fees: 20, window_fees: 19.37, fee_complete: true,
    window_fee_complete: true, usage_usd: 2, difference_usd: null, converted: false,
    fx: null, status: 'unavailable', notes: [], blockers: [
      { account_id: 'route-x', code: 'mystery_future_code' },
    ] }]
  data.accounts = []
  const { container } = await renderSection(data)
  const row = container.querySelector('[data-econ-group="USD"]')
  assert.doesNotMatch(row.textContent, /mystery_future_code|route-x/)
  const log = container.querySelector('#wm-cost-blocker-log')
  assert.match(log.textContent, /mystery_future_code/)
  assert.match(log.textContent, /route-x/)
})

test('the blocker log keeps exact codes beside friendly explanations', async () => {
  const data = econFixture()
  data.groups = [{ currency: 'USD', monthly_fees: 20, window_fees: 19.37, fee_complete: true,
    window_fee_complete: true, usage_usd: 2, difference_usd: null, converted: false,
    fx: null, status: 'unavailable', notes: [], blockers: [
      { account_id: 'test:default', code: 'missing_cache_read_rate' },
      { account_id: 'test:default', code: 'missing_cache_write_rate' },
    ] }]
  data.accounts[0].blockers = [{ code: 'missing_cache_read_rate' }]
  const { container } = await renderSection(data)
  const log = container.querySelector('#wm-cost-blocker-log')
  assert.match(log.textContent, /\(missing_cache_read_rate\)/)
  assert.match(log.textContent, /\(missing_cache_write_rate\)/)
  assert.deepEqual([...log.querySelectorAll('[data-blocker-code]')].map(li => li.dataset.blockerCode),
    ['missing_cache_read_rate', 'missing_cache_write_rate', 'missing_cache_read_rate'])
  const table = container.querySelector('.wm-econ-table')
  assert.match(table.textContent, /cache price evidence/,
    'the account row keeps its friendly explanation')
  assert.doesNotMatch(table.textContent, /\(missing_cache_read_rate\)|\(missing_cache_write_rate\)/,
    'the account table keeps plain explanations; codes live in the log')
})

test('a two-month comparable trend surfaces inline while one month stays closed', async () => {
  const inline = await renderSection(econFixture())
  assert.ok(inline.container.querySelector('.wm-econ-trend-inline'),
    'two comparable USD months render the trend without a click')
  assert.equal(inline.container.querySelector('.wm-econ-trend-inline').textContent.includes('2026-09'), true)
  const single = econFixture()
  single.trend = { months: [{
    month: '2026-10', fees_by_currency: [{ currency: 'USD', amount: 20 }], fees_usd: 20,
    usage_usd: 2.0, difference_usd: -18.0, in_progress: false, partial: false,
    recording_partial: false, difference_note: '',
  }], excluded_before_recording: 0, note: '' }
  const closed = await renderSection(single)
  assert.equal(closed.container.querySelector('.wm-econ-trend-inline'), null,
    'a single comparable period is not presented as a trend')
  const disclosure = [...closed.container.querySelectorAll('.wm-econ-disclosure')]
    .find(details => details.querySelector('summary').textContent === 'Monthly trend')
  assert.ok(disclosure && !disclosure.open, 'the single month stays one click away')
})

test('the inline trend keeps non-comparable months and raw notes out of view', async () => {
  const data = econFixture()
  data.trend = { months: [
    { month: '2026-08', fees_by_currency: [{ currency: 'USD', amount: 20 }], fees_usd: 20,
      usage_usd: 4, difference_usd: -16, in_progress: false, partial: false,
      recording_partial: false, difference_note: '' },
    { month: '2026-09', fees_by_currency: [{ currency: 'USD', amount: 20 }], fees_usd: 20,
      usage_usd: 2, difference_usd: -18, in_progress: false, partial: true,
      recording_partial: false,
      difference_note: "Only 50.0% of this month's usage is priced; the value is a lower bound." },
    { month: '2026-10', fees_by_currency: [{ currency: 'USD', amount: 20 }], fees_usd: 20,
      usage_usd: null, usage_calls: 0, unattributed_usage_calls: 1, difference_usd: null,
      in_progress: false, partial: true, partial_pricing: false, partial_attribution: true,
      recording_partial: false,
      difference_note: 'Shared route ownership changed during this month; observed usage on affected routes was excluded from this comparison: route-anthropic.' },
  ], excluded_before_recording: 0, note: '' }
  const { container } = await renderSection(data)
  const inline = container.querySelector('.wm-econ-trend-inline')
  assert.ok(inline, 'two comparable months still surface the trend')
  assert.match(inline.textContent, /2026-08/)
  assert.match(inline.textContent, /2026-09/)
  assert.match(inline.textContent, /partial pricing/, 'translated flags stay inline')
  assert.doesNotMatch(inline.textContent, /2026-10/, 'the non-comparable month leaves the inline view')
  assert.doesNotMatch(inline.textContent, /route-anthropic|lower bound/,
    'raw slugs and untranslated notes stay out of the standard view')
  const parked = container.querySelector('.wm-econ-trend-parked')
  assert.ok(parked && !parked.open, 'parked months stay one click away')
  assert.match(parked.textContent, /Months needing more evidence/)
  assert.match(parked.textContent, /route-anthropic/)
  assert.match(parked.textContent, /partial attribution/)
})

test('the economics section carries a stable subscription anchor', async () => {
  const { container } = await renderSection(econFixture())
  const section = container.querySelector('#wm-subscription-economics')
  assert.ok(section, 'Memberships can deep-link the subscription comparison')
  assert.equal(section.querySelector('h2').textContent, 'Subscription economics')
})

test('the panel blocks the fx editor when the rates read fails', async () => {
  $testConnectionId.set('gateway-a')
  $testProfile.set('default')
  const data = econFixture()
  transportCtl.reset()
  transportCtl.respond(call => {
    if (call.path.startsWith('/economics/summary')) return { ...data }
    if (call.path.startsWith('/membership/fx')) throw new Error('request failed with status 500')
    throw new Error(`unexpected path ${call.path}`)
  })
  queryClient.clear()
  T.$fxDraft.set(null)
  T.$fxNotice.set(null)
  T.$fxSaving.set(null)
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = ReactDOMClient.createRoot(container)
  roots.push(root)
  await React.act(async () => {
    root.render(React.createElement(QueryClientProvider, { client: queryClient },
      React.createElement(T.EconomicsPanel, { identity: T.membershipIdentityNow() })))
  })
  await flush(8)
  assert.match(container.textContent, /could not be read for this connection/)
  assert.doesNotMatch(container.textContent, /status 500/)
  const save = [...container.querySelectorAll('button')].find(b => b.textContent === 'Save rates')
  assert.ok(save && save.disabled, 'save is blocked while the read has failed')
})

test('a comparable headline tells whether membership is worthwhile without claiming cash savings', async () => {
  const behind = await renderSection(econFixture())
  const verdict = behind.container.querySelector('[data-econ-verdict]')
  assert.ok(verdict, 'the worth-it story renders beneath the headline figures')
  assert.equal(verdict.dataset.econVerdict, 'behind')
  assert.match(verdict.textContent, /\$2\.00 of API-equivalent usage attributed to memberships/)
  assert.match(verdict.textContent, /against USD 19\.37 in fees/)
  assert.match(verdict.textContent, /fees exceed usage value by \$17\.37/)
  assert.match(verdict.textContent, /Estimated value, not cash saved/)
  assert.doesNotMatch(verdict.textContent, /saved \$|you saved/i)
  assert.doesNotMatch(verdict.textContent, /mystery/,
    'unattributed routes stay out of the membership-covered story')
  const data = econFixture()
  data.headline.usage_usd = 23
  data.headline.difference_usd = 3.63
  const ahead = await renderSection(data)
  const aheadVerdict = ahead.container.querySelector('[data-econ-verdict="ahead"]')
  assert.ok(aheadVerdict)
  assert.match(aheadVerdict.textContent, /the comparison favours membership/)
  const partial = econFixture()
  partial.headline.status = 'partial'
  partial.headline.usage_usd = 23
  partial.headline.difference_usd = 3.63
  const partialVerdict = (await renderSection(partial)).container.querySelector('[data-econ-verdict]')
  assert.equal(partialVerdict.dataset.econVerdict, 'partial')
  assert.match(partialVerdict.textContent, /USD 19\.37 in known fees vs \$23\.00 of attributed usage/)
  assert.doesNotMatch(partialVerdict.textContent, /favours|exceed/,
    'a lower-bound comparison states components, never direction')
  const even = econFixture()
  even.headline.usage_usd = 19.37
  even.headline.difference_usd = 0
  const evenVerdict = (await renderSection(even)).container.querySelector('[data-econ-verdict="even"]')
  assert.ok(evenVerdict, 'equal usage and fees read as break-even, not favourable')
  assert.match(evenVerdict.textContent, /matches fees/)
})

test('a comparable headline tells the worth-it story in Simplified Chinese', async () => {
  const previousTranslator = i18nBackend.t
  i18nBackend.t = (key, ...args) => {
    const entry = T.I18N.zh[key]
    return typeof entry === 'function' ? entry(...args) : entry ?? key
  }
  try {
    const { container } = await renderSection(econFixture())
    const verdict = container.querySelector('[data-econ-verdict="behind"]')
    assert.ok(verdict)
    assert.match(verdict.textContent, /费用超出用量价值 \$17\.37/)
    assert.match(verdict.textContent, /不是实际节省的现金/)
  } finally {
    i18nBackend.t = previousTranslator
  }
})

test('an unavailable comparison still shows its known fee and usage components', async () => {
  const data = econFixture()
  data.headline = { status: 'unavailable', fees_monthly_by_currency: [{ currency: 'USD', amount: 20 }],
    fees_window_by_currency: [{ currency: 'USD', amount: 19.37 }], usage_usd: 5,
    difference_usd: null, notes: ['1 subscription(s) have no fee.'],
    note_codes: [{ code: 'econ_head_unpriced', params: { count: 1 } }] }
  data.groups = [{ currency: 'USD', monthly_fees: 20, window_fees: 19.37, fee_complete: false,
    fee_accounts: 1, unknown_fee_accounts: ['fee:missing'], window_fee_complete: false,
    window_fee_accounts: 1, usage_usd: 5, difference_usd: null, converted: false,
    fx: null, status: 'unavailable', notes: [], note_codes: [],
    blockers: [{ account_id: 'fee:missing', code: 'subscription_fee_missing' }] }]
  data.accounts = []
  const { container } = await renderSection(data)
  const verdict = container.querySelector('[data-econ-verdict="partial"]')
  assert.ok(verdict, 'known components render even though the full comparison is unavailable')
  assert.match(verdict.textContent, /Partial evidence: ≥USD 19\.37 in known fees vs \$5\.00 of attributed usage/,
    'the incomplete window allocation keeps its lower-bound marker in the partial story')
  assert.match(verdict.textContent, /full comparison is unavailable/)
  assert.equal(verdict.querySelector('.wm-econ-verdict-link').textContent, 'See what blocks it')
  assert.match(container.querySelector('.wm-product-stat strong').textContent, /USD/,
    'the headline fee figure survives beside the partial story')
  const feesOnly = econFixture()
  feesOnly.headline = { status: 'unavailable', fees_monthly_by_currency: [{ currency: 'GBP', amount: 20 }],
    fees_window_by_currency: [{ currency: 'GBP', amount: 20 }], usage_usd: null,
    difference_usd: null, notes: [], note_codes: [] }
  feesOnly.groups = []
  feesOnly.accounts = []
  const feesVerdict = (await renderSection(feesOnly)).container.querySelector('[data-econ-verdict="partial"]')
  assert.match(feesVerdict.textContent, /GBP 20\.00 in known fees/)
  assert.doesNotMatch(feesVerdict.textContent, /usage/)
  const usageOnly = econFixture()
  usageOnly.headline = { status: 'unavailable', fees_monthly_by_currency: [], fees_window_by_currency: [],
    usage_usd: 5, difference_usd: null, notes: [], note_codes: [] }
  usageOnly.groups = []
  usageOnly.accounts = []
  const usageVerdict = (await renderSection(usageOnly)).container.querySelector('[data-econ-verdict="partial"]')
  assert.ok(usageVerdict.textContent.startsWith(T.I18N.en.econVerdictPartialUsage('$5.00')),
    'an unknown fee component is omitted, never printed as a dash')
  const bare = econFixture()
  bare.headline = { status: 'unavailable', fees_monthly_by_currency: [], usage_usd: null,
    difference_usd: null, notes: ['No subscription has a known fee.'] }
  bare.groups = []
  bare.accounts = []
  assert.equal((await renderSection(bare)).container.querySelector('[data-econ-verdict]'), null,
    'with no known component there is no partial story, only the honest Unavailable')
  const zeroes = econFixture()
  zeroes.headline = { status: 'ok', fees_monthly_by_currency: [{ currency: 'USD', amount: 0 }],
    fees_window_by_currency: [{ currency: 'USD', amount: 0 }], usage_usd: 0,
    difference_usd: 0, notes: [], note_codes: [] }
  assert.equal((await renderSection(zeroes)).container.querySelector('[data-econ-verdict]'), null,
    'no spend and no usage carry no worth-it story')
})

test('the partial verdict points at what blocks the full comparison', async () => {
  const attention = await renderAttention({
    groups: [{ currency: 'USD', blockers: [{ account_id: 'a', code: 'subscription_fee_missing' }] }],
    econAccounts: [{ account_id: 'a', label: 'Missing fee account' }],
  })
  const data = econFixture()
  data.headline = { status: 'unavailable', fees_monthly_by_currency: [{ currency: 'USD', amount: 20 }],
    fees_window_by_currency: [{ currency: 'USD', amount: 19.37 }], usage_usd: 5,
    difference_usd: null, notes: [], note_codes: [] }
  const { container } = await renderSection(data)
  const link = container.querySelector('.wm-econ-verdict-link')
  assert.ok(link)
  await React.act(async () => { link.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  assert.equal(document.activeElement,
    attention.container.querySelector('[data-costs-attention-heading]'),
    'the verdict link focuses the attention summary it points at')
})

test('incomplete groups name their window-fee scope', async () => {
  const data = econFixture()
  data.groups = [{ currency: 'USD', monthly_fees: 20, window_fees: 19.37, fee_complete: false,
    fee_accounts: 2, unknown_fee_accounts: ['fee:one', 'fee:two'], window_fee_complete: false,
    window_fee_accounts: 1, unallocated_window_accounts: ['fee:three'],
    usage_usd: 5, difference_usd: null, converted: false,
    fx: null, status: 'unavailable', notes: [], note_codes: [], blockers: [] }]
  data.accounts = []
  const { container } = await renderSection(data)
  const scope = container.querySelector('[data-econ-group="USD"] .wm-econ-group-scope')
  assert.ok(scope, 'the partial group scopes its window fees')
  assert.equal(scope.textContent,
    'Known window fees from 1 of 4 subscriptions · 2 fees unknown, 1 lacks fee history')
  const windowOnly = econFixture()
  windowOnly.groups = [{ currency: 'USD', monthly_fees: 40, window_fees: 19.37, fee_complete: true,
    fee_accounts: 2, unknown_fee_accounts: [], window_fee_complete: false,
    window_fee_accounts: 1, unallocated_window_accounts: ['fee:three'],
    usage_usd: 5, difference_usd: null, converted: false,
    fx: null, status: 'unavailable', notes: [], note_codes: [], blockers: [] }]
  windowOnly.accounts = []
  const historyScope = (await renderSection(windowOnly)).container
    .querySelector('[data-econ-group="USD"] .wm-econ-group-scope')
  assert.equal(historyScope?.textContent,
    'Known window fees from 1 of 2 subscriptions · 1 lacks fee history',
    'window-only gaps scope the displayed figure too')
  const complete = await renderSection(econFixture())
  assert.equal(complete.container.querySelector('[data-econ-group="USD"] .wm-econ-group-scope'), null,
    'a complete group needs no scope line')
})

test('attention categories explain whether an action helps', async () => {
  const { container } = await renderAttention({
    groups: [{ currency: 'GBP', blockers: [
      { account_id: 'a', code: 'subscription_fee_missing' },
      { account_id: 'a', code: 'no_usage_recorded' },
      { account_id: 'b', code: 'tier_rate_unavailable' },
    ] }],
    econAccounts: [],
  })
  const hints = [...container.querySelectorAll('.wm-cost-attn-cat-hint')].map(el => el.textContent)
  assert.deepEqual(hints, [
    'These have a fix — use the action on each row.',
    'These resolve as recording history accumulates — nothing to fix.',
    'This evidence is not reported — the blocker log holds the detail.',
  ])
  const { container: zhContainer } = await renderAttention({
    groups: [{ currency: 'GBP', blockers: [
      { account_id: 'a', code: 'subscription_fee_missing' },
      { account_id: 'a', code: 'no_usage_recorded' },
      { account_id: 'b', code: 'tier_rate_unavailable' },
    ] }],
    econAccounts: [],
  }, 'zh')
  const zhHints = [...zhContainer.querySelectorAll('.wm-cost-attn-cat-hint')].map(el => el.textContent)
  assert.deepEqual(zhHints, [
    '这些问题可以修复——请按每行的操作处理。',
    '这些问题会随着记录历史的积累而解决——无需修复。',
    '此类证据未被报告——详情见问题日志。',
  ])
})

test('unknown blocker codes stay out of the account table', async () => {
  const data = econFixture()
  data.accounts[0].blockers = [{ code: 'mystery_future_code' }]
  const { container } = await renderSection(data)
  const table = container.querySelector('.wm-econ-table')
  assert.match(table.textContent, /exact code is in the blocker log/,
    'the account row falls back to the code-free sentence')
  assert.doesNotMatch(table.textContent, /mystery_future_code/)
  const log = container.querySelector('#wm-cost-blocker-log')
  assert.match(log.textContent, /\(mystery_future_code\)/,
    'the exact code stays available in the closed technical log')
})
