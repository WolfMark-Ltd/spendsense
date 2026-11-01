// Run: node --test test/
//
// Allowance weather rendering regressions — real React, synthetic fixtures.
// Renders AllowanceWeather directly with canned report entries. Must stay a
// separate file from test/weather.test.mjs: tests registered after the
// harness's late top-level await are silently dropped by the runner when
// both loaders share one module.
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

const work = mkdtempSync(join(tmpdir(), 'wm-wx-'))
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
const { plugin, T, React, ReactDOMClient, queryClient, i18nCalls, i18nBackend } = lib
const translated = (key, ...args) => i18nCalls.some(call =>
  call.length === args.length + 1 && call[0] === key && args.every((a, i) => call[i + 1] === a))
// Render through the real English catalogue: assertions see what users see,
// and a key missing from en fails closed to the key itself.
i18nBackend.t = (key, ...args) => {
  const entry = T.I18N.en[key]
  return typeof entry === 'function' ? entry(...args) : entry ?? key
}

const wxFixture = () => ({
  account_id: 'test:default', label: 'Test', family: 'test', arrangement: 'subscription',
  cycle: { start: '2026-10-01T00:00:00Z', end: '2026-11-01T00:00:00Z',
    elapsed_days: 30.5, total_days: 31, days_remaining: 0.5,
    days_remaining_display: 1, elapsed_fraction: 0.983871 },
  rollup: { state: 'behind' },
  windows: [{
    id: 'monthly-credit', label: 'Monthly credit', kind: 'billing_cycle', scope: 'account',
    declared: { kind: 'amount', amount: 100, currency: 'USD', text: '100.0 USD' },
    duration_minutes: null,
    cycle: { start: '2026-10-01T00:00:00Z', end: '2026-11-01T00:00:00Z',
      elapsed_days: 30.5, total_days: 31, days_remaining: 0.5,
      days_remaining_display: 1, elapsed_fraction: 0.983871 },
    cycle_basis: 'membership_cycle',
    provider: { used_percent: 62, reset_at: '2026-11-01T00:00:00Z',
      reset_in_days: 0.5, state: 'live', age_seconds: 60 },
    manual: null, conflict: false, verdict: 'behind',
    verdict_basis: 'provider_vs_calendar', projection: null,
    notes: ['Verdict compares the provider-reported share with the elapsed share of the cycle.'],
  }],
  rules: [{
    profile_id: 'cap', label: 'cap · shared', provider: 'test', scope: 'profiles',
    pool: 'shared', kind: 'api',
    cycle: { start: '2026-10-01T00:00:00+00:00', end: '2026-11-01T00:00:00+00:00' },
    elapsed_days: 30.5, total_days: 31, days_remaining: 0.5,
    days_remaining_display: 1, elapsed_fraction: 0.983871,
    limit_usd: 10, used_usd: 6, remaining_usd: 4, consumed_fraction: 0.6, calls: 3,
    valued_complete: true, lower_bound: false,
    pace_usd_per_day: 0.196721, projected_exhaustion: '2026-11-20T20:00:00Z',
    forecast_status: 'ok', verdict: 'behind', verdict_basis: 'observed_vs_calendar',
    notes: ['Linear projection from observed consumption; usage outside Hermes would bring exhaustion sooner.'],
  }],
  notes: [],
})

const roots = []
const renderWeather = async (props) => {
  i18nCalls.length = 0
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = ReactDOMClient.createRoot(container)
  roots.push(root)
  await React.act(async () => {
    root.render(React.createElement(T.AllowanceWeather, props))
  })
  return { container, text: () => container.textContent }
}

after(() => { queryClient.clear(); dom.window.close() })
test.afterEach(async () => {
  while (roots.length) {
    const root = roots.pop()
    try { await React.act(async () => { root.unmount() }) } catch { /* already gone */ }
  }
  queryClient.clear()
})

test('the weather header shows the verdict and cycle position', async () => {
  const { container, text } = await renderWeather({ entry: wxFixture(), error: false })
  assert.equal(container.querySelector('.wm-weather').getAttribute('data-verdict'), 'behind')
  assert.match(text(), /Allowance weather/)
  assert.match(text(), /Behind pace/)
  assert.match(text(), /1 day left in cycle/)
  assert.match(text(), /98% of cycle elapsed/)
  assert.ok(translated('wxDaysLeft', 1), 'the remaining-days value is interpolated')
  assert.ok(translated('wxElapsed', 98), 'the elapsed share is interpolated')
})

test('the details list keeps provider readings and rule figures apart', async () => {
  const { text } = await renderWeather({ entry: wxFixture(), error: false })
  assert.match(text(), /Details/)
  assert.match(text(), /Monthly credit: \$100\.00 allowance · Provider reports 62% used/)
  assert.match(text(), /cap · shared: \$6\.00 of \$10\.00 used · 60% · \$0\.20\/day/)
  assert.match(text(), /At this pace, exhausted around 2026-11-20/)
  assert.ok(translated('wxProviderShare', 62), 'the provider share is interpolated')
  assert.ok(translated('wxUsedOf', '$6.00', '$10.00'), 'the used/limit pair is interpolated')
})

test('an unknown rollup renders Unknown, never a confident state', async () => {
  const entry = wxFixture()
  entry.rollup = { state: 'unknown' }
  entry.windows = []
  entry.rules = []
  const { container, text } = await renderWeather({ entry, error: false })
  assert.equal(container.querySelector('.wm-weather').getAttribute('data-verdict'), 'unknown')
  assert.match(text(), /Unknown/)
  assert.doesNotMatch(text(), /Ahead of pace|On track|Behind pace|Exhausted/)
})

test('a failed read renders the unavailable line; nothing renders without data', async () => {
  const failed = await renderWeather({ entry: null, error: true })
  assert.match(failed.text(), /Allowance weather is unavailable/)
  const idle = await renderWeather({ entry: null, error: false })
  assert.equal(idle.text(), '')
})

test('a failed refetch keeps the cached entry but marks it stale', async () => {
  const { text } = await renderWeather({ entry: wxFixture(), error: true })
  assert.match(text(), /Behind pace/)
  assert.match(text(), /Refresh failed — showing the last read\./)
  assert.ok(translated('wxStale'), 'the stale warning renders through i18n')
  const fresh = await renderWeather({ entry: wxFixture(), error: false })
  assert.doesNotMatch(fresh.text(), /showing the last read/)
})

test('the weather stylesheet tones every verdict', () => {
  for (const verdict of ['exhausted', 'ahead', 'on_track', 'behind']) {
    assert.match(T.WEATHER_CSS, new RegExp(`data-verdict="${verdict}"`))
  }
  assert.match(T.WEATHER_CSS, /\.wm-weather-dot/)
  assert.match(T.WEATHER_CSS, /\.wm-weather-subnotes/)
})

test('the details list shows each row’s own explanation', async () => {
  const { container, text } = await renderWeather({ entry: wxFixture(), error: false })
  assert.match(text(), /Verdict compares the provider-reported share/)
  assert.match(text(), /Linear projection from observed consumption/)
  assert.equal(container.querySelectorAll('.wm-weather-subnotes li').length, 2)
})

test('membership edits invalidate the cached weather verdicts', async () => {
  const identity = 'local|default#1'
  const other = 'elsewhere|default#9'
  queryClient.clear()
  const keyFor = id => [plugin.id, 'allowance-weather', id]
  queryClient.setQueryData(keyFor(identity), { ...wxFixture(), identity })
  queryClient.setQueryData(keyFor(other), { ...wxFixture(), identity: other })
  assert.equal(queryClient.getQueryState(keyFor(identity))?.isInvalidated, false)
  await T.invalidateWeatherFor(identity)
  assert.equal(queryClient.getQueryState(keyFor(identity))?.isInvalidated, true)
  assert.equal(queryClient.getQueryState(keyFor(other))?.isInvalidated, false)
})

test('billing rule writes invalidate the economics and weather dependents', async () => {
  const identity = 'local|default#1'
  const other = 'elsewhere|default#9'
  queryClient.clear()
  const keys = [id => [plugin.id, 'economics-summary', id], id => [plugin.id, 'allowance-weather', id]]
  for (const keyFor of keys) {
    queryClient.setQueryData(keyFor(identity), { identity })
    queryClient.setQueryData(keyFor(other), { identity: other })
  }
  await T.invalidateBillingDependentsFor(identity)
  for (const keyFor of keys) {
    assert.equal(queryClient.getQueryState(keyFor(identity))?.isInvalidated, true)
    assert.equal(queryClient.getQueryState(keyFor(other))?.isInvalidated, false)
  }
})
