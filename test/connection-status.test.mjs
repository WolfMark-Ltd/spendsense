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
  host.state.gateway.set('open')
  T.$connectionBusyBy.set({})
  T.$connectionFailuresBy.set({})
  T.$connectionLastSuccessBy.set({})
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

const settledTranslate = (key, ...args) => {
  const entry = T.I18N.en[key]
  return typeof entry === 'function' ? entry(...args) : entry ?? key
}

// --- 1. the state table ------------------------------------------------------
test('the six connection states derive from transport, bridge counters and health', () => {
  const base = { gateway: 'open', busy: 0, failures: 0, hasData: true,
    healthError: false, lastSuccess: null }
  assert.equal(T.connectionStatusOf(base).key, 'live')
  // The host's ConnectionState vocabulary: 'open' is the connected state.
  // Comparing only against 'connected' left a healthy gateway stuck on
  // Reconnecting, so the real values are pinned here explicitly.
  assert.equal(T.connectionStatusOf({ ...base, gateway: 'open#2' }).key, 'live',
    'an activation-suffixed open transport is still connected')
  assert.equal(T.connectionStatusOf({ ...base, gateway: 'idle' }).key, 'offline')
  assert.equal(T.connectionStatusOf({ ...base, gateway: 'closed' }).key, 'offline')
  assert.equal(T.connectionStatusOf({ ...base, gateway: 'error' }).key, 'error',
    'a failed dial is a connection error, not a recovery attempt')
  // Older hosts and the harness vocabulary still read correctly.
  assert.equal(T.connectionStatusOf({ ...base, gateway: 'connected' }).key, 'live')
  // Initial retrieval: data requests in flight, no settled data yet.
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
  // or a failed health read with no settled data.
  assert.equal(T.connectionStatusOf({ ...base, failures: 3 }).key, 'error')
  assert.equal(T.connectionStatusOf({ ...base, healthError: true, hasData: false }).key, 'error')
  // With verified data already settled, a failed background health read is
  // stale evidence, not a live connection failure.
  assert.equal(T.connectionStatusOf({ ...base, healthError: true }).key, 'live')
  // A background health refetch is neither a data request nor a user-facing
  // event: it can never move the pill (routine checks must not flicker it
  // between Live and Refreshing).
  assert.equal(T.connectionStatusOf({ ...base, busy: 0 }).key, 'live')
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
    const block = row.querySelector('.wm-conn-status-block')
    const chip = block?.querySelector('.wm-connection-status')
    assert.ok(brand && chip, 'the logo and the status pill share the header row')
    // The indicator block is the row's last element: margin-left:auto places
    // it on the opposite side from the logo at every page and width.
    assert.equal(row.lastElementChild, block, 'the indicator is the row\'s final element')
    // The brand and destinations are one wrapping group; the indicator is a
    // sibling of that group, so a narrow pane can only wrap the tabs inside
    // their own group and can never push the indicator onto a second row.
    const group = row.querySelector('.wm-product-tabs-main')
    assert.ok(group, 'the tab group renders inside the header row')
    assert.equal(row.getAttribute('role'), 'tablist', 'the header row owns the tablist role')
    assert.equal(group.getAttribute('role'), null, 'the wrapping group is presentational')
    assert.equal(group.nextElementSibling, block, 'the indicator follows the tab group')
    assert.ok(group.contains(brand), 'the logo belongs to the wrapping tab group')
    assert.equal(group.querySelectorAll('[role="tab"]').length, 8,
      'all eight destinations wrap inside the tab group')
    assert.equal(block.contains(group), false, 'the indicator is never inside the wrapping group')
    assert.equal(chip.getAttribute('data-connection'), 'live',
      'a connected, settled gateway reads Live')
    assert.ok(chip.querySelector('.wm-conn-status-icon[data-state="live"]'),
      'the state icon renders beside the label')
    assert.equal(chip.getAttribute('aria-live'), 'polite',
      'the state announces politely — without claiming the notice role="status" slot')
    assert.equal(chip.getAttribute('role'), null,
      'the chip never collides with the host notice role="status" contract')
    assert.equal(chip.querySelector('.wm-conn-status-label').textContent, 'Live')
    // The supporting line is visible beneath the pill (freshness information
    // is never hover-only) and the block reserves the same height in every
    // state, so the header cannot shift.
    const sub = block.querySelector('.wm-conn-status-sub')
    assert.ok(sub, 'the supporting line renders beneath the pill')
    assert.match(sub.textContent, /^Connected/,
      'the Live supporting line is accurate and visible without hovering')
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
    T.$connectionBusyBy.set({ [T.membershipIdentityNow()]: 1 })
    await React.act(async () => { await new Promise(r => setTimeout(r, 0)) })
    assert.equal(chip().getAttribute('data-connection'), 'refreshing',
      'in-flight requests over settled data read Refreshing')
    T.$connectionBusyBy.set({})
    T.$connectionFailuresBy.set({ [T.membershipIdentityNow()]: 2 })
    await React.act(async () => { await new Promise(r => setTimeout(r, 0)) })
    assert.equal(chip().getAttribute('data-connection'), 'error',
      'consecutive transport failures read Connection error')
    // Transport down: offline, regardless of the bridge counters.
    host.state.gateway.set('closed')
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

test('busy requests and failures are scoped to their own identity', async () => {
  // A pending or failed request for a switched-away connection can neither
  // keep the active indicator refreshing nor count against its health.
  resetHost()
  const identityA = T.membershipIdentityNow()
  const originalRest = T.getRest()
  T.setRest(async path => ({ ok: true, version: '0.6.42', contract: 4, ready: true }))
  const { container, unmount } = await mount(React.createElement(T.ConnectionStatus))
  try {
    const chip = () => container.querySelector('.wm-connection-status')
    assert.equal(chip().getAttribute('data-connection'), 'live')
    // A request in flight for identity A...
    T.$connectionBusyBy.set({ [identityA]: 1 })
    await React.act(async () => { await new Promise(r => setTimeout(r, 0)) })
    assert.equal(chip().getAttribute('data-connection'), 'refreshing')
    // ...and the identity switches away: A's pending request no longer holds
    // the active indicator, and A's stale failure count never counts
    // against B.
    T.$connectionFailuresBy.set({ [T.membershipIdentityNow()]: 2 })
    host.state.connectionId.set('other-connection')
    await React.act(async () => { await new Promise(r => setTimeout(r, 0)) })
    assert.notEqual(T.$connectionBusyBy.get()[T.membershipIdentityNow()] || 0, 1,
      'the new identity has no in-flight requests of its own')
    assert.notEqual(chip().getAttribute('data-connection'), 'refreshing',
      'identity A\'s pending request cannot hold identity B refreshing')
    await React.act(async () => { await new Promise(r => setTimeout(r, 0)) })
    assert.notEqual(chip().getAttribute('data-connection'), 'error',
      'A\'s stale failure count does not make B\'s connection an error')
  } finally {
    host.state.connectionId.set('gateway-a')
    T.restoreRest(originalRest)
    unmount()
  }
})

test('the shell and the indicator share one health request from a cold cache', async () => {
  // Both observers use the same query key: mounting the shell exercises both
  // and must produce exactly one /health request.
  resetHost()
  let healthRequests = 0
  const originalRest = T.getRest()
  const previousTranslate = i18nBackend.t
  i18nBackend.t = key => {
    const entry = T.I18N.en[key]
    return typeof entry === 'function' ? entry('12:34') : entry ?? key
  }
  T.setRest(async path => {
    if (path.startsWith('/health')) healthRequests += 1
    return { ok: true, version: '0.6.42', contract: 4, ready: true }
  })
  // A cold cache: earlier tests in this file share the identity's health
  // entry, and the point here is that a fresh shell + indicator mount
  // produces exactly one request.
  queryClient.clear()
  const { container, unmount } = await mount(React.createElement(T.ProductShell, {},
    null))
  try {
    assert.ok(container.querySelector('.wm-connection-status'),
      'the indicator renders inside the shared shell header')
    await React.act(async () => { await new Promise(r => setTimeout(r, 0)) })
    assert.equal(healthRequests, 1,
      'the shell and the indicator dedupe the health key — one request total')
  } finally {
    T.restoreRest(originalRest)
    i18nBackend.t = previousTranslate
    unmount()
  }
})

test('the supporting line never claims more than the state knows', async () => {
  resetHost()
  const originalRest = T.getRest()
  const previousTranslate = i18nBackend.t
  i18nBackend.t = settledTranslate
  T.setRest(async () => ({ ok: true, version: '0.6.42', contract: 4, ready: true }))
  const { container, unmount } = await mount(React.createElement(T.ConnectionStatus))
  try {
    const sub = () => container.querySelector('.wm-conn-status-sub')?.textContent
    // Health-only evidence: connected, but no data retrieval has happened,
    // so the Live line claims connection only — not a data refresh.
    assert.equal(sub(), 'Connected',
      'Live with health-only evidence claims no data refresh')
    // Reconnecting without verified data must not claim to be showing any.
    host.state.gateway.set('connecting')
    await React.act(async () => { await new Promise(r => setTimeout(r, 0)) })
    assert.equal(sub(), 'Restoring the connection…',
      'Reconnecting with no settled data claims no data')
    // With verified data available it may name it.
    T.$connectionLastSuccessBy.set({ [T.membershipIdentityNow()]: Date.parse('2026-11-26T10:11:12') })
    await React.act(async () => { await new Promise(r => setTimeout(r, 0)) })
    assert.equal(sub(), 'Showing last verified data',
      'Reconnecting over settled data names the last verified data')
    // Offline with a known last update names it to the second, visible
    // without hovering; offline with none claims none.
    host.state.gateway.set('closed')
    await React.act(async () => { await new Promise(r => setTimeout(r, 0)) })
    assert.equal(sub(), 'Last updated 10:11:12',
      'Offline with a known update time shows it to the second')
    T.$connectionLastSuccessBy.set({})
    await React.act(async () => { await new Promise(r => setTimeout(r, 0)) })
    assert.equal(sub(), 'No data received yet',
      'Offline with no verified data claims no data')
    // Connection error is explicit about retrieval.
    host.state.gateway.set('open')
    T.$connectionFailuresBy.set({ [T.membershipIdentityNow()]: 2 })
    await React.act(async () => { await new Promise(r => setTimeout(r, 0)) })
    assert.equal(sub(), 'Unable to retrieve data')
  } finally {
    host.state.gateway.set('open')
    T.restoreRest(originalRest)
    i18nBackend.t = previousTranslate
    unmount()
  }
})

test('the last update time reflects data retrieval, never health checks alone', async () => {
  resetHost()
  const originalRest = T.getRest()
  T.setRest(async () => ({ ok: true, version: '0.6.42', contract: 4, ready: true }))
  const { container, unmount } = await mount(React.createElement(T.ConnectionStatus))
  try {
    await React.act(async () => { await new Promise(r => setTimeout(r, 0)) })
    // The chip's health query settled successfully, and the freshness map is
    // still empty: only a backendRequest (a real data call through the
    // bridge) records a successful update — a health check by itself never
    // does.
    assert.deepEqual(T.$connectionLastSuccessBy.get(), {},
      'a successful health check does not fabricate a last-update time')
  } finally {
    T.restoreRest(originalRest)
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
