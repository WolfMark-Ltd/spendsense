// Browser entry for the PR-D review visibility/tooltip regressions. Renders
// the real MembershipsPage in a short 380px pane and at full width, with one
// tall account whose navigation targets start below the fold. Runs under
// --force-prefers-reduced-motion (instant scrolling works under --dump-dom
// virtual time; smooth does not), and records real viewport visibility,
// focus, highlight and tooltip geometry for --dump-dom capture.
import React from 'react'
import { createRoot } from 'react-dom/client'
import plugin, { __test as T } from '../desktop/plugin.js'
import { calls } from './tooltip-layout.sdk.mjs'

const out = { steps: {} }
const done = () => {
  out.hostCalls = calls.length
  document.getElementById('memberships-visibility-result').textContent = JSON.stringify(out)
}

const windows = []
for (let i = 1; i <= 6; i += 1) {
  windows.push({ id: `win-${i}`, label: `Weekly window ${i}`, used_percent: 10,
    state: 'live', basis: ['provider_reported'],
    ...(i === 6 ? { used_percent_from: 'manual', state: 'manual',
      manual: { id: 'man-6', status: 'reconfirm_due' } } : {}) })
}
const accounts = [
  {
    id: 'tall:default', family: 'tall', label: 'Tall', route_slugs: ['tall'],
    billing_arrangement: 'subscription', effective_arrangement: 'subscription',
    plan_id: 'tall.pro', plan: { name: 'Pro' },
    fee: { basis: 'declared', effective: { amount: 10, currency: 'USD', period: 'month' } },
    quota: { windows }, manual_exhaustions: [], fee_overrides: [],
    plan_choices: [], excluded_plans: [], rev: 'r1',
  },
]
const weatherAccounts = [{ account_id: 'tall:default',
  rollup: { state: 'ahead' }, cycle: {}, notes: [],
  windows: [{ id: 'w-pool', label: 'Weekly pool', verdict: 'ahead' }], rules: [] }]

try {
  plugin.register({
    rest: async path => {
      if (path.startsWith('/membership/accounts')) {
        return { ok: true, accounts, store: { loaded: true, error: '' }, notes: [] }
      }
      if (path.startsWith('/membership/plans')) return { ok: true, plans: [], vocabulary: {} }
      if (path.startsWith('/allowance/weather')) return { ok: true, accounts: weatherAccounts }
      return { ok: true, accounts: [] }
    },
    storage: { get: (_k, d) => d, set() {}, delete() {} },
    register() {}, registerMany() {}, onDispose() {}, onEvent: () => () => {},
    setTimeout: fn => { const t = setTimeout(fn, 0); return () => clearTimeout(t) },
    setInterval: () => () => {},
    addEventListener: () => () => {},
    os: {}, pet: null, i18n: { register() {}, t: key => key },
  })
  for (const [host, page] of [['app-short', 'MembershipsPage'], ['app-wide', 'MembershipsPage']]) {
    createRoot(document.getElementById(host)).render(React.createElement(T[page], {}))
  }
  const click = el => el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  const step = (ms, fn) => new Promise(resolve => setTimeout(() => resolve(fn()), ms))
  const inPane = (el, pane) => {
    if (!el || !el.isConnected) return false
    const r = el.getBoundingClientRect()
    if (r.width < 2 || r.height < 2) return false
    const p = pane.getBoundingClientRect()
    return r.left >= p.left - 1 && r.right <= p.right + 1 &&
      r.top >= p.top - 1 && r.bottom <= p.bottom + 1
  }
  setTimeout(() => {
    (async () => {
      try {
        out.reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches
        const short = document.getElementById('app-short')
        const card = short.querySelector('[data-account="tall:default"]')
        // Expand the tall card without navigating, so the targets start
        // below the fold of the short pane.
        await step(200, () => {
          const details = [...card.querySelectorAll('.wm-row-head button')]
            .find(b => b.textContent.includes('memDetails'))
          click(details)
          click(card.querySelector('[data-group="allowances"] > summary'))
        })
        await step(300, () => {})
        const lastBtn = card.querySelector('li[data-window="win-6"] button[data-action="clear-mark"]')
        out.setup = {
          rows: short.querySelectorAll('.wm-row-head').length,
          targetBelowFold: !inPane(lastBtn, short),
        }
        const attnLi = text => [...short.querySelectorAll('.wm-attention li')]
          .find(li => (li.textContent || '').includes(text))
        // Window target on the last quota row, below the initial viewport.
        await step(200, () => click(attnLi('Weekly window 6').querySelector('button')))
        await step(500, () => {
          const li = card.querySelector('li[data-window="win-6"]')
          const btn = li.querySelector('button[data-action="clear-mark"]')
          out.steps.window = {
            focused: document.activeElement === btn,
            flashed: li.classList.contains('wm-flash'),
            visible: inPane(btn, short),
          }
        })
        // Weather reading target, further down still.
        await step(200, () => click(attnLi('Weekly pool').querySelector('button')))
        await step(500, () => {
          const li = card.querySelector('li[data-weather-kind="window"][data-weather-id="w-pool"]')
          out.steps.reading = {
            detailsOpen: card.querySelector('.wm-weather-details').open === true,
            focused: document.activeElement === li,
            flashed: li && li.classList.contains('wm-flash'),
            visible: inPane(li, short),
          }
        })
        // Billing tooltip geometry at both widths.
        out.tooltip = {}
        for (const [name, hostId] of [['short', 'app-short'], ['wide', 'app-wide']]) {
          const host = document.getElementById(hostId)
          const hostCard = host.querySelector('[data-account="tall:default"]')
          await step(200, () => {
            const head = hostCard.querySelector('.wm-row-head button')
            if (head.getAttribute('aria-expanded') !== 'true') click(head)
          })
          await step(300, () => {
            const plan = hostCard.querySelector('[data-group="plan"]')
            if (!plan.open) click(plan.querySelector('summary'))
          })
          await step(300, () => {
            const head = hostCard.querySelector('.wm-billing-head')
            head.scrollIntoView({ behavior: 'auto', block: 'start' })
            hostCard.querySelector('.wm-info-btn').focus()
          })
          await step(300, () => {
            const btn = hostCard.querySelector('.wm-billing-head .wm-info-btn')
            const pop = hostCard.querySelector('.wm-billing-head .wm-info-pop')
            const r = pop ? pop.getBoundingClientRect() : null
            const b = btn.getBoundingClientRect()
            const p = host.getBoundingClientRect()
            out.tooltip[name] = {
              open: !!pop,
              belowButton: !!r && r.top >= b.bottom,
              nearButton: !!r && (r.top - b.bottom) < 60,
              insidePane: !!r && r.left >= p.left - 1 && r.right <= p.right + 1 &&
                r.top >= p.top - 1 && r.bottom <= p.bottom + 1,
              hasSize: !!r && r.width > 40 && r.height > 10,
            }
          })
        }
        done()
      } catch (error) { out.error = String(error && error.stack || error); done() }
    })()
  }, 1500)
} catch (error) { out.error = String(error && error.stack || error); done() }
