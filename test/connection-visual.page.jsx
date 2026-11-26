// WP54 connection-indicator visual fixture page.
//
// Renders the REAL SpendSense product shell — logo, tab row, shared
// connection indicator, shell content — with controlled state injection
// through the same atoms and gateway state the production bridge writes.
// No user data, no network: the transport is a synthetic per-case stub and
// the connection state is injected through the plugin's own connection
// atoms, exactly as backendRequest would set them.
//
// One page, one case. The driver navigates a fresh browser context to
//   ?case=<state>__<theme>[&page=full]
// The page settles the health query, applies the case injection, then
// publishes the rendered chip state in #conn-visual-result for the driver
// to verify before capturing.
import React from 'react'
import { createRoot } from 'react-dom/client'
import plugin, { __test as T } from '../desktop/plugin.js'
import { QueryClientProvider, queryClient, host, i18nBackend } from '@hermes/plugin-sdk'

const params = new URLSearchParams(window.location.search)
const [state, theme] = (params.get('case') || 'live__dark').split('__')
const fullWidth = params.get('page') === 'full'

// Product copy: the plugin's own English table, applied with the rendered
// arguments so interpolation entries (the update time) resolve exactly as
// the product renders them.
i18nBackend.t = (key, ...args) => {
  const entry = T.I18N.en[key]
  return typeof entry === 'function' ? entry(...args) : (entry ?? key)
}

// Synthetic transport: answers the health read (the real payload shape).
// For the loading case it never answers, so no data has settled yet.
const transport = state === 'loading'
  ? () => new Promise(() => {})
  : async () => ({ ok: true, version: '0.6.42', contract: 4, ready: true,
      build: { contract: 4, revision: '0'.repeat(40) } })

plugin.register({
  rest: transport,
  storage: { get: (k, d) => d, set() {}, delete() {} },
  register() {}, registerMany() {}, onDispose() {}, onEvent: () => () => {},
  setTimeout: fn => { const t = setTimeout(fn, 0); return () => clearTimeout(t) },
  setInterval: (fn, ms) => (ms !== 250 ? () => {} : setInterval(fn, ms)),
  addEventListener: () => () => {},
  os: {}, pet: null, i18n: { register() {}, t: key => key },
})

const identity = T.membershipIdentityNow()

/** The case's controlled state injection — the same writes the real bridge
 *  and gateway make, made through the same atoms. */
function injectCaseState() {
  const PINNED = Date.now()
  if (state === 'live') return
  if (state === 'loading' || state === 'refreshing') {
    T.$connectionBusyBy.set({ [identity]: 1 })
    return
  }
  if (state === 'offline') {
    host.state.gateway.set('disconnected')
    T.$connectionLastSuccessBy.set({ [identity]: PINNED - 42_000 })
    return
  }
  if (state === 'reconnecting') {
    host.state.gateway.set('reconnecting')
    T.$connectionLastSuccessBy.set({ [identity]: PINNED - 42_000 })
    return
  }
  if (state === 'error') {
    T.$connectionFailuresBy.set({ [identity]: 2 })
    return
  }
  throw new Error(`Unknown connection case: ${state}`)
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

async function main() {
  const container = document.getElementById('conn-visual-case')
  container.className = `case ${theme}`
  if (fullWidth) container.dataset.full = '1'
  document.body.dataset.single = theme
  const root = createRoot(container)
  // The real product mounts a page component, and each page brings its own
  // ProductShell (logo, tabs, shared indicator). LedgerPage for the Overview
  // tab is the actual mount unit — rendered here exactly as the product
  // renders it.
  await new Promise(resolve => {
    root.render(
      React.createElement(QueryClientProvider, { client: queryClient },
        React.createElement(T.LedgerPage)),
    )
    resolve()
  })
  // Let the health query settle before injecting, so the injection layers
  // on top of a settled render — the same order the real app sees.
  await wait(120)
  injectCaseState()
  await wait(120)
  const chip = container.querySelector('.wm-connection-status')
  const sub = container.querySelector('.wm-conn-status-sub')
  const block = container.querySelector('.wm-conn-status-block')
  const brand = container.querySelector('.wm-product-brand')
  const tabs = container.querySelector('.wm-product-tabs')
  const shell = container.querySelector('.wm-product')
  const status = chip?.getAttribute('data-connection')
  const expected = state
  const ready = status === expected && !!brand && !!tabs
  const rectOf = el => {
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { top: r.top, height: r.height, left: r.left, right: r.right, width: r.width }
  }
  document.getElementById('conn-visual-result').textContent = JSON.stringify({
    case: `${state}__${theme}`, ready,
    status, sub: sub?.textContent ?? null,
    lastElement: tabs ? tabs.lastElementChild?.className : null,
    blockRect: rectOf(block),
    brandRect: rectOf(brand),
    tabsRect: rectOf(tabs),
    shellHeight: shell ? shell.scrollHeight : null,
  })
  if (!ready) throw new Error(`fixture ${state}__${theme}: rendered ${status}`)
}

main().catch(error => {
  document.getElementById('conn-visual-result').textContent =
    JSON.stringify({ case: `${state}__${theme}`, ready: false, error: String(error && error.message || error) })
  throw error
})
