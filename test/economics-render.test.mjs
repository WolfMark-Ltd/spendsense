// Run: node --test test/
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
      unpriced_tokens: 0, coverage: 1 },
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
  assert.match(text(), /\$20\.00\/mo/)
  assert.equal(container.querySelector('.wm-product-stat strong').textContent, '$20.00/mo',
    'the headline fee amount renders in its own element')
  assert.match(text(), /API-equivalent usage/)
  assert.match(text(), /\$2\.00/)
  assert.match(text(), /Estimated value comparison/)
  assert.match(text(), /−\$17\.37/)
  assert.match(text(), /Not cash saved/)
  assert.match(text(), /\$19\.37 in the last 30 days/)
  assert.match(text(), /same window/)
  assert.ok(translated('econPerMonth', '$20.00'), 'the monthly fee value is interpolated')
  assert.ok(translated('econSpanDays', 30), 'the span interpolates rounded days')
  assert.ok(translated('econSubsSmall', '$19.37', 'in the last 30 days', 1, 'Complete'),
    'the window value, span, count and status are interpolated')
})

test('the breakdown names the membership, renewal and coverage', async () => {
  const { container, text } = await renderSection(econFixture())
  assert.match(text(), /Test account/)
  assert.match(text(), /Test Plus/)
  assert.match(text(), /\$20\.00 due 2026-11-12/)
  assert.match(text(), /\$19\.37 in window/)
  assert.match(text(), /Fully priced/)
  assert.ok(translated('econDue', '$20.00', '2026-11-12'), 'the renewal amount and date are interpolated')
  assert.ok(translated('econInWindow', '$19.37'), 'the windowed fee is interpolated')
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
  assert.match(text(), /£4\.25\/mo/)
  assert.ok(translated('econPerMonth', '£4.25'), 'the fallback fee value is interpolated')
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
