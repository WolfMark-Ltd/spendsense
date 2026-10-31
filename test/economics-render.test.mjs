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
export { QueryClientProvider, queryClient, host, $testConnectionId, $testProfile, gatewayActivationEpoch } from '@hermes/plugin-sdk'
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
const { plugin, T, React, ReactDOMClient, QueryClientProvider, queryClient, $testConnectionId, $testProfile } = lib

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
  headline: {
    status: 'ok',
    fees_monthly_by_currency: [{ currency: 'USD', amount: 20 }],
    usage_usd: 2.0,
    difference_usd: -18.0,
    difference_label: 'Estimated value comparison (API-equivalent value minus fees)',
    notes: ['Estimated value comparison of recorded usage against fees.'],
  },
  groups: [{
    currency: 'USD', monthly_fees: 20, fee_accounts: 1, unknown_fee_accounts: [],
    usage_usd: 2.0, difference_usd: -18.0, converted: false, fx: null,
    status: 'ok', notes: [],
  }],
  accounts: [{
    account_id: 'test:default', label: 'Test account', family: 'test',
    arrangement: 'subscription', plan_id: 'test.plus', plan_name: 'Test Plus',
    fee: { amount: 20, currency: 'USD', period: 'month', basis: 'catalogue', confidence: 'verified' },
    monthly_equivalent: { amount: 20, currency: 'USD' }, monthly_equivalent_usd: 20, fx: null,
    renewal: { amount: 20, currency: 'USD', period: 'month', anchor_day: 12,
      date: '2026-11-12T00:00:00Z', date_known: true },
    usage: { list_usd: 2.0, tokens: 1_000_000, calls: 12, priced_tokens: 1_000_000,
      unpriced_tokens: 0, coverage: 1 },
    attribution: { routes: [{ route: 'test', basis: 'route' }], basis: 'route', note: 'route evidence' },
    difference_usd: -18.0, status: 'ok', notes: [],
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
    { month: '2026-09', fees_by_currency: [{ currency: 'USD', amount: 20 }],
      usage_usd: 4, difference_usd: -16, in_progress: false,
      recording_partial: false, difference_note: '' },
    { month: '2026-10', fees_by_currency: [{ currency: 'USD', amount: 20 }],
      usage_usd: 2, difference_usd: -18, in_progress: true,
      recording_partial: false, difference_note: '' },
  ], excluded_before_recording: 4, note: '' },
})

const roots = []
const renderSection = async (data, extra = {}) => {
  T.$fxDraft.set(null)
  T.$fxNotice.set(null)
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = ReactDOMClient.createRoot(container)
  roots.push(root)
  const saved = []
  await React.act(async () => {
    root.render(React.createElement(T.EconomicsSection, {
      data, identity: 'local|default#1', fxRates: [], onSaveFx: rates => saved.push(rates), ...extra,
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
  const { text } = await renderSection(econFixture())
  assert.match(text(), /Monthly subscriptions/)
  assert.match(text(), /\$20\.00\/mo/)
  assert.match(text(), /API-equivalent usage/)
  assert.match(text(), /\$2\.00/)
  assert.match(text(), /Estimated value comparison/)
  assert.match(text(), /−\$18\.00/)
  assert.match(text(), /Not cash saved/)
})

test('the breakdown names the membership, renewal and coverage', async () => {
  const { container, text } = await renderSection(econFixture())
  assert.match(text(), /Test account/)
  assert.match(text(), /Test Plus/)
  assert.match(text(), /\$20\.00 due 2026-11-12/)
  assert.match(text(), /Fully priced/)
  const headers = [...container.querySelectorAll('th')].map(th => th.textContent)
  assert.deepEqual(headers, ['Account', 'Membership', 'Monthly equiv.', 'API-equivalent usage',
    'Est. value difference', 'Pricing coverage'])
})

test('paired bars carry values and labels, never bare graphics', async () => {
  const { container } = await renderSection(econFixture())
  const labels = [...container.querySelectorAll('.wm-econ-bar-label')].map(el => el.textContent)
  assert.ok(labels.some(label => label.includes('Fees (USD)')), `fee bar labelled: ${labels}`)
  assert.ok(labels.some(label => label.includes('API-equivalent usage')), `usage bar labelled: ${labels}`)
  const values = [...container.querySelectorAll('.wm-econ-bar-value')].map(el => el.textContent)
  assert.ok(values.includes('$20.00'), `fee value shown: ${values}`)
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
    currency: 'GBP', monthly_fees: 4.25, fee_accounts: 1, unknown_fee_accounts: [],
    usage_usd: 1.0, difference_usd: -4.31, converted: true,
    fx: { currency: 'GBP', usd_per_unit: 1.25, as_of: '2026-10-31', source: 'Example Bank' },
    status: 'ok', notes: [],
  }]
  const { text } = await renderSection(data)
  assert.match(text(), /Fees \(GBP, in USD\)/)
  assert.match(text(), /Converted at 1\.25 USD per GBP, dated 2026-10-31 \(Example Bank\)/)
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
  assert.match(container.textContent, /−\$18\.00/)
  assert.ok(transportCtl.calls.some(call => call.path.startsWith('/economics/summary?days=30')),
    `economics fetched: ${JSON.stringify(transportCtl.calls)}`)
  assert.ok(transportCtl.calls.some(call => call.path === '/membership/fx'),
    `fx fetched: ${JSON.stringify(transportCtl.calls)}`)
})
