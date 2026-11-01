// Run: node --test test/
// Phase A shared primitives (design/proposal.md §3–§4): token roles, product
// header, six-tab navigation, opaque tooltips and async-button feedback.
// Real React + jsdom harness, same as sidebar/membership tests. No production
// page is rebuilt here; these tests pin the shared layer PR-B/C/D build on.
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
const work = mkdtempSync(join(tmpdir(), 'wm-ux-'))
process.on('exit', () => rmSync(work, { recursive: true, force: true }))
const entry = join(work, 'entry.mjs')
writeFileSync(entry, `
export { default as plugin, __test as T } from '${join(ROOT, 'desktop', 'plugin.js')}'
export * as React from 'react'
export * as ReactDOMClient from 'react-dom/client'
export { QueryClientProvider, queryClient } from '@hermes/plugin-sdk'
`)
const bundle = join(work, 'bundle.mjs')
const esbuild = (await import(pathToFileURL(join(HARNESS_MODULES, 'esbuild', 'lib', 'main.js')).href)).default
await esbuild.build({
  entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', outfile: bundle,
  alias: {
    '@hermes/plugin-sdk': join(ROOT, 'test', 'harness', 'real-sdk.mjs'),
    react: join(HARNESS_MODULES, 'react'),
    'react-dom': join(HARNESS_MODULES, 'react-dom'),
  },
  nodePaths: [HARNESS_MODULES], logLevel: 'warning',
})
const { JSDOM } = await import(pathToFileURL(join(HARNESS_MODULES, 'jsdom', 'lib', 'api.js')).href)
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
const define = (name, value) => Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
define('window', dom.window); define('document', dom.window.document); define('navigator', dom.window.navigator)
define('HTMLElement', dom.window.HTMLElement); define('Node', dom.window.Node)
define('MouseEvent', dom.window.MouseEvent); define('KeyboardEvent', dom.window.KeyboardEvent); define('Event', dom.window.Event)
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const lib = await import(pathToFileURL(bundle).href)
const { T, React, ReactDOMClient, QueryClientProvider, queryClient } = lib
const roots = []
after(async () => { for (const r of roots) await React.act(async () => r.unmount()) })
const renderEl = async element => {
  const container = document.createElement('div'); document.body.appendChild(container)
  const root = ReactDOMClient.createRoot(container); roots.push(root)
  await React.act(async () => root.render(React.createElement(QueryClientProvider, { client: queryClient }, element)))
  return container
}
const flush = async (times = 3) => {
  await React.act(async () => { for (let i = 0; i < times; i += 1) await new Promise(r => setTimeout(r, 0)) })
}

test('SHARED_CSS names the Phase A roles and enforces [hidden]', () => {
  assert.match(T.SHARED_CSS, /--wm-action:var\(--ui-accent\)/)
  assert.match(T.SHARED_CSS, /--wm-positive:/)
  assert.match(T.SHARED_CSS, /--wm-attention:var\(--ui-warning\)/)
  assert.match(T.SHARED_CSS, /--wm-space-3:12px/)
  assert.match(T.SHARED_CSS, /--wm-font-display:24px/)
  // Finding: a hidden certainty chip must stay hidden despite display:inline-flex.
  assert.match(T.SHARED_CSS, /\[hidden\]\{display:none!important\}/)
  assert.match(T.SHARED_CSS, /\.wm-certainty\{display:inline-flex/)
})

test('shared tooltip styles are opaque and reach both pane and product surfaces', () => {
  assert.match(T.SHARED_CSS, /\.wm-info-pop\{[^}]*background:var\(--ui-fill-secondary,#1a1d26\)/)
  assert.match(T.METER_CSS, /wm-info-pop/, 'pane bundle carries the shared tooltip')
  assert.match(T.ANALYTICS_CSS, /wm-info-pop/, 'product bundle carries the shared tooltip')
})

test('layout breakpoints use container queries on the plugin root, not the viewport', () => {
  assert.match(T.ANALYTICS_CSS, /container-type:inline-size/)
  assert.match(T.PRODUCT_CSS, /@container\(max-width:620px\)/)
})

test('LedgerTabs: six tabs in order, roving tabindex, click and arrow navigation', async () => {
  T.$ledgerTab.set('overview')
  const container = await renderEl(React.createElement(T.LedgerTabs))
  const tabs = [...container.querySelectorAll('[role="tab"]')]
  assert.deepEqual(tabs.map(el => el.textContent), ['Overview', 'Usage', 'Costs', 'Memberships', 'Reports', 'Settings & About'])
  assert.equal(tabs[0].getAttribute('aria-selected'), 'true')
  assert.deepEqual(tabs.map(el => el.tabIndex), [0, -1, -1, -1, -1, -1], 'only the active tab is tabbable')

  await React.act(async () => tabs[2].click()); await flush()
  assert.equal(T.$ledgerTab.get(), 'costs')
  const after = [...container.querySelectorAll('[role="tab"]')]
  assert.equal(after[2].getAttribute('aria-selected'), 'true')
  assert.deepEqual(after.map(el => el.tabIndex), [-1, -1, 0, -1, -1, -1])

  // ArrowRight from Costs moves selection and focus to Memberships.
  await React.act(async () => {
    after[2].dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }))
  }); await flush()
  assert.equal(T.$ledgerTab.get(), 'memberships')
  assert.equal(document.activeElement.textContent, 'Memberships')

  // End / Home bound the list.
  const current = [...container.querySelectorAll('[role="tab"]')]
  await React.act(async () => {
    current[3].dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }))
  }); await flush()
  assert.equal(T.$ledgerTab.get(), 'settings')
  const last = [...container.querySelectorAll('[role="tab"]')]
  await React.act(async () => {
    last[5].dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }))
  }); await flush()
  assert.equal(T.$ledgerTab.get(), 'overview')
})

test('ProductHeader renders one h1, subtitle and actions in the shared heading', async () => {
  const container = await renderEl(React.createElement(T.ProductHeader, {
    title: 'Overview', subtitle: 'One line.',
    actions: React.createElement('button', { type: 'button' }, 'Act'),
  }))
  const header = container.querySelector('header.wm-product-heading')
  assert.ok(header)
  assert.equal(header.querySelector('h1').textContent, 'Overview')
  assert.equal(header.querySelector('p').textContent, 'One line.')
  assert.equal(header.querySelector('button').textContent, 'Act')
  const bare = await renderEl(React.createElement(T.ProductHeader, { title: 'Costs' }))
  assert.equal(bare.querySelector('p'), null, 'subtitle is optional')
})

test('AsyncButton: pending blocks duplicate clicks; success/error announce beside it', async () => {
  let clicks = 0
  const pending = await renderEl(React.createElement(T.AsyncButton, {
    status: 'pending', pendingLabel: 'Saving…', onClick: () => { clicks += 1 }, children: 'Save',
  }))
  const btn = pending.querySelector('button')
  assert.equal(btn.disabled, true)
  assert.equal(btn.getAttribute('aria-busy'), 'true')
  assert.equal(btn.textContent, 'Saving…')
  await React.act(async () => btn.click())
  assert.equal(clicks, 0, 'a disabled pending button cannot be clicked again')

  const ok = await renderEl(React.createElement(T.AsyncButton, {
    status: 'success', successLabel: 'Saved.', onClick: () => { clicks += 1 }, children: 'Save',
  }))
  assert.equal(ok.querySelector('button').disabled, false)
  assert.equal(ok.querySelector('.wm-async-status').getAttribute('role'), 'status')
  assert.equal(ok.querySelector('.wm-async-status').textContent, 'Saved.')

  const bad = await renderEl(React.createElement(T.AsyncButton, {
    status: 'error', errorLabel: 'Not saved.', children: 'Save',
  }))
  assert.equal(bad.querySelector('.wm-async-status').getAttribute('role'), 'alert')
})

test('InfoTip: focus opens an accessible tooltip, Escape closes it', async () => {
  T.$infoOpen.set(null)
  const container = await renderEl(React.createElement(T.InfoTip, {
    id: 'ux-test', label: 'About this figure', text: 'Priced when recorded.',
  }))
  const btn = container.querySelector('.wm-info-btn')
  assert.equal(btn.getAttribute('aria-expanded'), 'false')
  await React.act(async () => btn.focus()); await flush()
  const pop = container.querySelector('.wm-info-pop')
  assert.ok(pop, 'focus opens the tooltip')
  assert.equal(pop.getAttribute('role'), 'tooltip')
  assert.equal(pop.textContent, 'Priced when recorded.')
  assert.equal(btn.getAttribute('aria-expanded'), 'true')
  assert.equal(btn.getAttribute('aria-describedby'), 'wm-info-ux-test')
  await React.act(async () => {
    btn.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  }); await flush()
  assert.equal(container.querySelector('.wm-info-pop'), null, 'Escape closes the tooltip')
  T.$infoOpen.set(null)
})

test('membership fees are preserved per account; routes are never grouped or suppressed', () => {
  const acct = (id, amount, currency) => ({
    id, plan_id: `${id}-plan`, effective_arrangement: 'subscription',
    fee: { effective: { amount, currency, period: 'month' } }, quota: {},
  })
  // The PR-A layer must not merge a Command Code account into Anthropic or
  // drop its fee: each account keeps its own fee, currencies stay separate.
  const summary = T.membershipSummary([
    acct('commandcode:default', 10, 'USD'),
    acct('openai-codex:default', 20, 'USD'),
    acct('anthropic:default', 160, 'GBP'),
  ])
  assert.equal(summary.total, 3)
  assert.equal(summary.withPlan, 3)
  assert.equal(T.feesLabel(summary), '$30.00/mo + £160.00/mo')
})
