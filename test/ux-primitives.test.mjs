// Run: node --test test/
// Phase A shared primitives (design/proposal.md §3–§4): token roles, product
// header, seven-tab navigation, opaque tooltips and async-button feedback.
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
export { QueryClientProvider, queryClient, i18nBackend } from '@hermes/plugin-sdk'
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
const { T, React, ReactDOMClient, QueryClientProvider, queryClient, i18nBackend } = lib
const enT = (key, ...args) => {
  const entry = T.I18N.en[key]
  return typeof entry === 'function' ? entry(...args) : entry ?? key
}
i18nBackend.t = enT
// Register with a benign transport so LedgerPage can mount its real pages.
lib.plugin.register({
  rest: async path => {
    if (path.startsWith('/membership/accounts')) return { ok: true, accounts: [], store: { loaded: true, error: '' }, notes: [] }
    if (path.startsWith('/membership/plans')) return { ok: true, plans: [], vocabulary: {} }
    if (path.startsWith('/economics')) return { ok: true, headline: {}, accounts: [] }
    if (path.startsWith('/allowance')) return { ok: true, accounts: [] }
    if (path.startsWith('/analytics')) return { ok: true, totals: {}, rows: [], buckets: [] }
    if (path.startsWith('/billing')) return { ok: true, billing: {}, profiles: [] }
    if (path.startsWith('/rates')) return { ok: true, catalogue: { source: 'test' } }
    return { ok: true, accounts: [], totals: {} }
  },
  storage: { get: (_k, d) => d, set() {}, delete() {} },
  register() {}, registerMany() {}, onDispose() {}, onEvent: () => () => {},
  setTimeout: fn => { const t = setTimeout(fn, 0); return () => clearTimeout(t) },
  setInterval: () => () => {},
  addEventListener: () => () => {},
  os: {}, pet: null, i18n: { register() {}, t: key => key },
})
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
// LedgerPage tests must own the whole document: earlier roots stay mounted
// until `after`, and the focus-restoration effect queries the document, so a
// leftover tab bar from another test would receive (or mask) the focus.
const resetDom = async () => {
  for (const root of roots.splice(0)) await React.act(async () => root.unmount())
  document.body.innerHTML = ''
}

test('SHARED_CSS names the Phase A roles and enforces [hidden]', () => {
  assert.match(T.SHARED_CSS, /--wm-surface:var\(--ui-fill-primary\)/)
  assert.match(T.SHARED_CSS, /--wm-surface-raised:var\(--ui-fill-secondary\)/)
  assert.match(T.SHARED_CSS, /--wm-border:var\(--ui-stroke-secondary\)/)
  assert.match(T.SHARED_CSS, /--wm-text:var\(--ui-text-primary\)/)
  assert.match(T.SHARED_CSS, /--wm-action:var\(--ui-accent\)/)
  assert.match(T.SHARED_CSS, /--wm-positive:/)
  assert.match(T.SHARED_CSS, /--wm-attention:var\(--ui-warning\)/)
  assert.match(T.SHARED_CSS, /--wm-space-3:12px/)
  assert.match(T.SHARED_CSS, /--wm-font-display:25px/)
  assert.match(T.SHARED_CSS, /--wm-radius-card:10px/)
  assert.doesNotMatch(T.SHARED_CSS, /#[0-9a-f]{3,8}/i, 'semantic colours come from Hermes host tokens')
  // Finding: a hidden certainty chip must stay hidden despite display:inline-flex.
  assert.match(T.SHARED_CSS, /\[hidden\]\{display:none!important\}/)
  assert.match(T.SHARED_CSS, /\.wm-status-chip,.wm-certainty\{display:inline-flex/)
})

test('shared tooltip styles are opaque and reach both pane and product surfaces', () => {
  assert.match(T.SHARED_CSS, /\.wm-info\{position:relative/)
  assert.match(T.SHARED_CSS, /\.wm-info-btn\{[^}]*width:24px;height:24px/)
  assert.match(T.SHARED_CSS, /\.wm-info-pop\{[^}]*position:absolute[^}]*background:var\(--wm-surface-raised\)/)
  assert.match(T.METER_CSS, /wm-info-pop/, 'pane bundle carries the shared tooltip')
  assert.match(T.ANALYTICS_CSS, /wm-info-pop/, 'product bundle carries the shared tooltip')
})

test('layout breakpoints use container queries on the plugin root, not the viewport', () => {
  assert.match(T.ANALYTICS_CSS, /container-type:inline-size/)
  assert.match(T.PRODUCT_CSS, /@container\(max-width:620px\)/)
  assert.match(T.PRODUCT_CSS, /@container\(max-width:760px\)/)
  assert.match(T.PRODUCT_CSS, /\.wm-product-tabs\{[^}]*flex-wrap:wrap[^}]*overflow:visible/)
})

test('LedgerTabs: seven tabs in order, roving tabindex, click and arrow navigation', async () => {
  T.$ledgerTab.set('overview')
  const container = await renderEl(React.createElement(T.LedgerTabs))
  const tabs = [...container.querySelectorAll('[role="tab"]')]
  assert.deepEqual(tabs.map(el => el.getAttribute('aria-label')), ['Overview', 'Usage', 'Costs', 'Memberships', 'Reports', 'Model News', 'Settings'])
  assert.deepEqual(tabs.map(el => el.querySelector('.wm-product-tab-number').textContent), ['01', '02', '03', '04', '05', '06', '07'])
  assert.equal(tabs[0].getAttribute('aria-selected'), 'true')
  assert.deepEqual(tabs.map(el => el.tabIndex), [0, -1, -1, -1, -1, -1, -1], 'only the active tab is tabbable')

  await React.act(async () => tabs[2].click()); await flush()
  assert.equal(T.$ledgerTab.get(), 'costs')
  const after = [...container.querySelectorAll('[role="tab"]')]
  assert.equal(after[2].getAttribute('aria-selected'), 'true')
  assert.deepEqual(after.map(el => el.tabIndex), [-1, -1, 0, -1, -1, -1, -1])

  // ArrowRight from Costs moves selection and focus to Memberships.
  await React.act(async () => {
    after[2].dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }))
  }); await flush()
  assert.equal(T.$ledgerTab.get(), 'memberships')
  assert.equal(document.activeElement.getAttribute('aria-label'), 'Memberships')

  // End / Home bound the list.
  const current = [...container.querySelectorAll('[role="tab"]')]
  await React.act(async () => {
    current[3].dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }))
  }); await flush()
  assert.equal(T.$ledgerTab.get(), 'settings')
  const last = [...container.querySelectorAll('[role="tab"]')]
  await React.act(async () => {
    last[6].dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }))
  }); await flush()
  assert.equal(T.$ledgerTab.get(), 'overview')
})

test('LedgerTabs: Chinese labels render through the dictionary', async () => {
  i18nBackend.t = (key, ...args) => {
    const entry = T.I18N.zh[key]
    return typeof entry === 'function' ? entry(...args) : entry ?? key
  }
  try {
    T.$ledgerTab.set('overview')
    const container = await renderEl(React.createElement(T.LedgerTabs))
    const tabs = [...container.querySelectorAll('[role="tab"]')]
    assert.deepEqual(tabs.map(el => el.getAttribute('aria-label')),
      ['总览', '用量', '费用', '会员', '报告', '模型动态', '设置'])
  } finally {
    i18nBackend.t = enT
  }
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

test('ProductShell shares themed chrome and keeps the seven-tab bar outside page content', async () => {
  T.$ledgerTab.set('memberships')
  const container = await renderEl(React.createElement(T.ProductShell, {
    pageStyles: '.wp01-test{display:block}',
    children: React.createElement('main', { children: 'Page content' }),
  }))
  const shell = container.querySelector('.wm-analytics.wm-product')
  assert.ok(shell)
  assert.equal(shell.querySelector('style').textContent.includes('.wp01-test'), true)
  assert.equal(shell.querySelectorAll('.wm-product-tabs [role="tab"]').length, 7)
  assert.equal(shell.querySelector('.wm-product-tabs').nextElementSibling.tagName, 'MAIN')
  assert.equal(shell.querySelector('main').textContent, 'Page content')
})

test('ProductCard and StatusChip expose reusable semantic variants', async () => {
  const card = await renderEl(React.createElement(T.ProductCard, {
    as: 'article', className: 'wm-product-section', 'aria-label': 'Evidence',
    children: 'Content',
  }))
  const article = card.querySelector('article.wm-product-card.wm-product-section')
  assert.equal(article.getAttribute('aria-label'), 'Evidence')
  assert.equal(article.textContent, 'Content')

  const chip = await renderEl(React.createElement(T.StatusChip, {
    tone: 'attention', children: 'Unreported',
  }))
  assert.equal(chip.querySelector('.wm-status-chip').getAttribute('data-tone'), 'attention')
  assert.equal(chip.querySelector('.wm-status-chip').textContent, 'Unreported')
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
  assert.equal(document.activeElement, btn, 'Escape leaves focus on the help control')
  T.$infoOpen.set(null)
})

test('LedgerPage: keyboard navigation restores focus to the newly mounted selected tab', async () => {
  // Regression: LedgerPage replaces the whole page (tab bar included) on a
  // tab change. Focusing the outgoing tab lost focus to <body>, so a second
  // arrow key went nowhere. This renders the real LedgerPage, not LedgerTabs
  // in isolation.
  await resetDom()
  T.$ledgerTab.set('overview')
  const container = await renderEl(React.createElement(T.LedgerPage))
  await flush(4)
  const firstBar = container.querySelector('.wm-product-tabs')
  assert.ok(firstBar, 'the ledger page mounts a tab bar')
  const overviewTab = [...container.querySelectorAll('[role="tab"]')]
    .find(el => el.getAttribute('aria-label') === 'Overview')
  await React.act(async () => {
    overviewTab.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }))
  }); await flush(4)
  assert.equal(T.$ledgerTab.get(), 'usage')
  assert.notEqual(container.querySelector('.wm-product-tabs'), firstBar,
    'the page (and its tab bar) was actually replaced')
  assert.equal(document.activeElement?.getAttribute('aria-label'), 'Usage',
    'focus is restored to the newly mounted selected tab')
  assert.equal(document.activeElement?.getAttribute('aria-selected'), 'true')

  // A second arrow continues from the restored focus without re-tabbing.
  await React.act(async () => {
    document.activeElement.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }))
  }); await flush(4)
  assert.equal(T.$ledgerTab.get(), 'costs')
  assert.equal(document.activeElement?.getAttribute('aria-label'), 'Costs')

  // Mouse navigation does not get focus forced by the keyboard path.
  T.$ledgerTab.set('overview'); await flush(4)
  const costsTab = [...container.querySelectorAll('[role="tab"]')]
    .find(el => el.getAttribute('aria-label') === 'Costs')
  await React.act(async () => costsTab.click()); await flush(4)
  assert.equal(T.$ledgerTab.get(), 'costs')
  assert.notEqual(document.activeElement?.getAttribute('aria-label'), 'Memberships')
})

test('LedgerPage: a no-op Home/End press does not leak focus restoration into mouse navigation', async () => {
  // Edge case: Home on Overview (or End on Settings) selects the tab that is
  // already active, so no page transition mounts a new tab bar to consume
  // the keyboard flag. A later mouse navigation must not be force-focused.
  await resetDom()
  T.$ledgerTab.set('overview')
  const container = await renderEl(React.createElement(T.LedgerPage))
  await flush(4)
  const overviewTab = [...container.querySelectorAll('[role="tab"]')]
    .find(el => el.getAttribute('aria-label') === 'Overview')
  await React.act(async () => {
    overviewTab.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }))
  }); await flush(4)
  assert.equal(T.$ledgerTab.get(), 'overview', 'Home on the first tab is a no-op')

  const costsTab = [...container.querySelectorAll('[role="tab"]')]
    .find(el => el.getAttribute('aria-label') === 'Costs')
  await React.act(async () => costsTab.click()); await flush(4)
  assert.equal(T.$ledgerTab.get(), 'costs')
  const costsNow = [...container.querySelectorAll('[role="tab"]')].find(el => el.getAttribute('aria-label') === 'Costs')
  assert.notEqual(document.activeElement, costsNow,
    'mouse navigation after a no-op key press must not receive restored focus')

  // Same at the other end: End on Settings is a no-op.
  T.$ledgerTab.set('settings'); await flush(4)
  const settingsTab = [...container.querySelectorAll('[role="tab"]')]
    .find(el => el.getAttribute('aria-label') === 'Settings')
  await React.act(async () => {
    settingsTab.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }))
  }); await flush(4)
  assert.equal(T.$ledgerTab.get(), 'settings', 'End on the last tab is a no-op')
  const overviewTab2 = [...container.querySelectorAll('[role="tab"]')]
    .find(el => el.getAttribute('aria-label') === 'Overview')
  await React.act(async () => overviewTab2.click()); await flush(4)
  assert.equal(T.$ledgerTab.get(), 'overview')
  const overviewNow = [...container.querySelectorAll('[role="tab"]')]
    .find(el => el.getAttribute('aria-label') === 'Overview')
  assert.notEqual(document.activeElement, overviewNow,
    'mouse navigation after a no-op End must not receive restored focus')
})

test('every attention (attn*) string exists in both en and zh, and zh renders', () => {
  const enKeys = Object.keys(T.I18N.en).filter(k => k.startsWith('attn'))
  assert.ok(enKeys.length > 5, 'the attention copy set is non-trivial')
  for (const key of enKeys) {
    assert.ok(key in T.I18N.zh, `zh is missing attention key ${key}`)
    assert.equal(typeof T.I18N.zh[key], typeof T.I18N.en[key], `zh type matches en for ${key}`)
  }
  const zhT = (key, ...args) => {
    const entry = T.I18N.zh[key]
    return typeof entry === 'function' ? entry(...args) : entry ?? key
  }
  const items = T.needsAttention([{
    id: 'x', label: 'xAI', plan_id: null, effective_arrangement: 'unconfirmed', quota: { windows: [] },
  }], null, zhT)
  assert.equal(items.length, 1)
  assert.match(items[0].text, /未确认/, 'the zh attention message renders through the translator')
})

test('every Memberships layout (mem*) string exists in both en and zh', () => {
  const enKeys = Object.keys(T.I18N.en).filter(k => k.startsWith('mem'))
  assert.ok(enKeys.length > 10, 'the Memberships copy set is non-trivial')
  for (const key of enKeys) {
    assert.ok(key in T.I18N.zh, `zh is missing Memberships key ${key}`)
    assert.equal(typeof T.I18N.zh[key], typeof T.I18N.en[key], `zh type matches en for ${key}`)
  }
  const zhT = (key, ...args) => {
    const entry = T.I18N.zh[key]
    return typeof entry === 'function' ? entry(...args) : entry ?? key
  }
  assert.equal(T.arrangementLabel('subscription', zhT), '订阅')
  assert.equal(T.arrangementLabel('prepaid', zhT), '预付额度')
  assert.equal(T.arrangementLabel('api_only', zhT), '按量 API')
  assert.equal(T.arrangementLabel('unconfirmed', zhT), '未确认')
})

test('every Overview (ov*) string exists in both en and zh', () => {
  const enKeys = Object.keys(T.I18N.en).filter(k => k.startsWith('ov'))
  assert.ok(enKeys.length > 10, 'the Overview copy set is non-trivial')
  for (const key of enKeys) {
    assert.ok(key in T.I18N.zh, `zh is missing Overview key ${key}`)
    assert.equal(typeof T.I18N.zh[key], typeof T.I18N.en[key], `zh type matches en for ${key}`)
  }
})

test('Overview KPIs use a scoped 2x2 grid that collapses to one column in narrow panes', () => {
  assert.match(T.PRODUCT_CSS, /\.wm-overview-grid\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)\}/)
  assert.match(T.PRODUCT_CSS,
    /\.wm-product \.wm-product-summary\{display:grid;grid-template-columns:repeat\(auto-fit,minmax\(185px,1fr\)\)/,
    'the shared summary grid used by Costs and others is unchanged')
  assert.match(T.PRODUCT_CSS, /@container\(max-width:620px\)\{[\s\S]*?\.wm-overview-grid\{grid-template-columns:1fr\}/,
    'narrow panes stack the Overview cards in one column')
  assert.match(T.PRODUCT_CSS, /\.wm-kpi-figure\{[^}]*overflow-wrap:anywhere/,
    'long currency and fee values wrap inside the fixed columns')
})

test('the methodology disclosure has a visible chevron for both states', () => {
  assert.match(T.PRODUCT_CSS, /\.wm-method summary::before\{content:"›"/)
  assert.match(T.PRODUCT_CSS, /\.wm-method\[open\] > summary::before\{transform:rotate\(90deg\)\}/)
  assert.match(T.PRODUCT_CSS, /summary::-[a-z]+-details-marker\{display:none\}/)
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
