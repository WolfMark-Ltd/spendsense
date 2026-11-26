// Run: bash scripts/node-tests.sh browserless connection-status.test.mjs
//
// The shared connection-status indicator: pure state derivation over the six
// defined states, the rendered pill's placement in the shared header row, and
// the no-extra-request guarantee (the health key is deduplicated with the
// shell's). No Chromium: every assertion is deterministic DOM/atoms.
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

const work = mkdtempSync(join(tmpdir(), 'wm-conn-'))
process.on('exit', () => rmSync(work, { recursive: true, force: true }))

const entry = join(work, 'entry.mjs')
writeFileSync(entry, `
export { default as plugin, __test as T } from '${join(ROOT, 'desktop', 'plugin.js')}'
export * as React from 'react'
export * as ReactDOMClient from 'react-dom/client'
export { QueryClientProvider, queryClient, host, i18nBackend } from '@hermes/plugin-sdk'
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
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
const define = (name, value) => Object.defineProperty(globalThis, name, {
  value, configurable: true, writable: true,
})
define('window', dom.window)
define('document', dom.window.document)
define('navigator', dom.window.navigator)
define('HTMLElement', dom.window.HTMLElement)
define('Node', dom.window.Node)
define('MouseEvent', dom.window.MouseEvent)
define('KeyboardEvent', dom.window.KeyboardEvent)
define('Event', dom.window.Event)
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const lib = await import(pathToFileURL(bundle).href)
const { plugin, T, React, ReactDOMClient, QueryClientProvider, queryClient, host, i18nBackend } = lib

const storageSets = []
const intervals = new Set()
const makeCtx = () => ({
  rest: async () => ({ ok: true }),
  storage: {
    get: (k, d) => d,
    set: (k, v) => { storageSets.push([k, v]) },
    delete() {},
  },
  register() {}, registerMany() {}, onDispose() {}, onEvent: () => () => {},
  setTimeout: (fn) => { const t = setTimeout(fn, 0); return () => clearTimeout(t) },
  setInterval: (fn, ms) => {
    if (ms !== 250) return () => {}
    const t = setInterval(fn, ms)
    intervals.add(t)
    return () => { clearInterval(t); intervals.delete(t) }
  },
  addEventListener: () => () => {},
  os: {}, pet: null, i18n: { register() {}, t: key => key },
})
plugin.register(makeCtx())
after(() => { for (const t of intervals) clearInterval(t) })

const resetHost = () => {
  host.state.gateway.set('connected')
  T.$connectionBusy.set(0)
  T.$connectionFailures.set(0)
  T.$connectionLastSuccess.set(null)
}

const mount = async element => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = ReactDOMClient.createRoot(container)
  await React.act(async () => {
    root.render(React.createElement(QueryClientProvider, { client: queryClient }, element))
  })
  await React.act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  return { container, unmount: () => { root.unmount(); container.remove() } }
}

const settledTranslate = key => {
  const entry = T.I18N.en[key]
  return typeof entry === 'function' ? entry('12:34') : entry ?? key
}

// --- 1. the state table ------------------------------------------------------
test('the six connection states derive from transport, bridge counters and health', () => {
  const base = { gateway: 'connected', busy: 0, failures: 0, hasData: true,
    healthError: false, healthFetching: false, lastSuccess: null }
  assert.equal(T.connectionStatusOf(base).key, 'live')
  // Initial retrieval: requests in flight, no settled data yet.
  assert.equal(T.connectionStatusOf({ ...base, busy: 2, hasData: false }).key, 'loading')
  // Background refresh: previously verified data stays visible.
  assert.equal(T.connectionStatusOf({ ...base, busy: 2 }).key, 'refreshing')
  // Transport attempting recovery.
  assert.equal(T.connectionStatusOf({ ...base, gateway: 'connecting' }).key, 'reconnecting')
  assert.equal(T.connectionStatusOf({ ...base, gateway: 'reconnecting' }).key, 'reconnecting')
  // Transport down and not attempting: offline, naming the last update.
  assert.equal(T.connectionStatusOf({ ...base, gateway: 'disconnected' }).key, 'offline')
  assert.equal(T.connectionStatusOf({ ...base, gateway: '' }).key, 'offline')
  assert.equal(T.connectionStatusOf({ ...base, gateway: 'disconnected', lastSuccess: 1 }).detail,
    'lastUpdate')
  // Connection error: consecutive transport failures with nothing in flight,
  // or a failed health read that is not retrying.
  assert.equal(T.connectionStatusOf({ ...base, failures: 3 }).key, 'error')
  assert.equal(T.connectionStatusOf({ ...base, healthError: true }).key, 'error')
  // A retrying health read is recovery, not a settled failure.
  assert.equal(T.connectionStatusOf({ ...base, healthError: true, healthFetching: true }).key,
    'live')
  // An isolated data error never reads as a global connection failure: the
  // bridge answered, so the failure counter stays at zero and the state is live.
  assert.equal(T.connectionStatusOf({ ...base, failures: 0 }).key, 'live')
})

// --- 2. the rendered pill ----------------------------------------------------
test('the pill renders in the shared header row on the far side from the logo', async () => {
  resetHost()
  const originalRest = T.getRest()
  const previousTranslate = i18nBackend.t
  i18nBackend.t = settledTranslate
  T.setRest(async () => ({ ok: true, version: '0.6.42', contract: 4, ready: true }))
  const { container, unmount } = await mount(React.createElement(T.LedgerTabs))
  try {
    const row = container.querySelector('.wm-product-tabs')
    assert.ok(row, 'the shared header row renders')
    const brand = row.querySelector('.wm-product-brand')
    const chip = row.querySelector('.wm-connection-status')
    assert.ok(brand && chip, 'the logo and the status pill share the header row')
    // The pill is the row's last element: margin-left:auto places it on the
    // opposite side from the logo at every page and width.
    assert.equal(row.lastElementChild, chip, 'the pill is the row\'s final element')
    assert.equal(chip.getAttribute('data-connection'), 'live',
      'a connected, settled gateway reads Live')
    assert.ok(chip.querySelector('.wm-conn-status-icon[data-state="live"]'),
      'the state icon renders beside the label')
    assert.equal(chip.getAttribute('aria-live'), 'polite',
      'the state announces politely — without claiming the notice role="status" slot')
    assert.equal(chip.getAttribute('role'), null,
      'the chip never collides with the host notice role="status" contract')
    assert.equal(chip.querySelector('.wm-conn-status-label').textContent, 'Live')
  } finally {
    T.restoreRest(originalRest)
    i18nBackend.t = previousTranslate
    unmount()
  }
})

test('state transitions drive the pill without extra backend requests', async () => {
  resetHost()
  let healthRequests = 0
  const originalRest = T.getRest()
  const previousTranslate = i18nBackend.t
  i18nBackend.t = settledTranslate
  T.setRest(async path => {
    if (path.startsWith('/health')) healthRequests += 1
    return { ok: true, version: '0.6.42', contract: 4, ready: true }
  })
  const { container, unmount } = await mount(React.createElement(T.ConnectionStatus))
  try {
    const chip = () => container.querySelector('.wm-connection-status')
    assert.ok(chip(), 'the pill renders in the initial state')
    const before = healthRequests
    // Busy with settled data → refreshing; busy without → loading.
    T.$connectionBusy.set(1)
    await React.act(async () => { await new Promise(r => setTimeout(r, 0)) })
    assert.equal(chip().getAttribute('data-connection'), 'refreshing',
      'in-flight requests over settled data read Refreshing')
    T.$connectionBusy.set(0)
    T.$connectionFailures.set(2)
    await React.act(async () => { await new Promise(r => setTimeout(r, 0)) })
    assert.equal(chip().getAttribute('data-connection'), 'error',
      'consecutive transport failures read Connection error')
    // Transport down: offline, regardless of the bridge counters.
    host.state.gateway.set('disconnected')
    await React.act(async () => { await new Promise(r => setTimeout(r, 0)) })
    assert.equal(chip().getAttribute('data-connection'), 'offline',
      'a down transport reads Offline')
    assert.equal(healthRequests, before,
      'state transitions add no backend requests — atoms only')
  } finally {
    T.restoreRest(originalRest)
    i18nBackend.t = previousTranslate
    unmount()
  }
})

test('the indicator styles carry theme tokens and reduced-motion handling', () => {
  const css = T.CONNECTION_STATUS_CSS.join('\n')
  // Every state tints from the design tokens — never hard-coded colours, so
  // light and dark themes both hold.
  assert.match(css, /color-mix\(in srgb,var\(--wm-positive\)/)
  assert.match(css, /color-mix\(in srgb,var\(--wm-action\)/)
  assert.match(css, /color-mix\(in srgb,var\(--wm-attention\)/)
  assert.match(css, /color-mix\(in srgb,var\(--wm-error\)/)
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(css), 'no hard-coded colours in the indicator styles')
  // Reduced motion turns both animations off.
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/)
  assert.match(css, /animation:none !important/)
})

after(() => { /* the harness tears down with the process */ })
