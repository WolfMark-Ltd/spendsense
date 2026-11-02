// Browser entry for the memberships layout test. Renders the real
// MembershipsPage twice — 380px and 1200px containers — with synthetic
// accounts carrying long mixed-currency fees, drives the window exhaustion
// flow in the narrow pane, and records real grid geometry plus the
// interaction result for --dump-dom capture.
import React from 'react'
import { createRoot } from 'react-dom/client'
import plugin, { __test as T } from '../desktop/plugin.js'
import { calls } from './tooltip-layout.sdk.mjs'

const out = { containers: {} }
const done = () => {
  out.hostCalls = calls.length
  document.getElementById('memberships-layout-result').textContent = JSON.stringify(out)
}

const accounts = [
  {
    id: 'anthropic:default', family: 'anthropic', label: 'main',
    billing_arrangement: 'subscription', effective_arrangement: 'subscription',
    plan_id: 'anthropic.claude-max', plan: { name: 'Claude Max 20x' },
    fee: { basis: 'declared', effective: { amount: 1234567.89, currency: 'USD', period: 'month' } },
    quota: { windows: [
      { id: 'win-1', label: 'Weekly window', used_percent: 10, state: 'live' },
      { id: 'win-2', label: 'Monthly window', used_percent: 40, state: 'live' },
    ] }, manual_exhaustions: [], fee_overrides: [],
    plan_choices: [], excluded_plans: [], rev: 'r1',
  },
  {
    id: 'openai-codex:default', family: 'openai-codex', label: 'main',
    billing_arrangement: 'subscription', effective_arrangement: 'subscription',
    plan_id: 'openai-codex.chatgpt-plus', plan: { name: 'ChatGPT Plus' },
    fee: { basis: 'catalogue', effective: { amount: 1234.56, currency: 'GBP', period: 'month' } },
    quota: { windows: [] }, manual_exhaustions: [], fee_overrides: [],
    plan_choices: [], excluded_plans: [], rev: 'r1',
  },
]

try {
  plugin.register({
    rest: async path => {
      if (path.startsWith('/membership/accounts')) {
        return { ok: true, accounts, store: { loaded: true, error: '' }, notes: [] }
      }
      if (path.startsWith('/membership/plans')) return { ok: true, plans: [], vocabulary: {} }
      if (path.startsWith('/allowance/weather')) return { ok: true, verdicts: [] }
      return { ok: true, accounts: [] }
    },
    storage: { get: (_k, d) => d, set() {}, delete() {} },
    register() {}, registerMany() {}, onDispose() {}, onEvent: () => () => {},
    setTimeout: fn => { const t = setTimeout(fn, 0); return () => clearTimeout(t) },
    setInterval: () => () => {},
    addEventListener: () => () => {},
    os: {}, pet: null, i18n: { register() {}, t: key => key },
  })
  for (const width of [380, 1200]) {
    const host = document.getElementById(`app-${width}`)
    createRoot(host).render(React.createElement(T.MembershipsPage, {}))
  }
  const click = el => el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  const step = (ms, fn) => new Promise(resolve => setTimeout(() => resolve(fn()), ms))
  setTimeout(() => {
    (async () => {
      try {
        // Visible path in the narrow pane: Details → Allowances → Mark exhausted.
        const narrow = document.getElementById('app-380')
        const card = narrow.querySelector('[data-account="anthropic:default"]')
        click([...card.querySelectorAll('.wm-row-head button')].find(b => /Details/.test(b.textContent)))
        await step(150, () => click(card.querySelector('[data-group="allowances"] > summary')))
        await step(150, () => {
          const li = card.querySelector('li[data-window="win-2"]')
          click([...li.querySelectorAll('button')].find(b => b.textContent === 'Mark exhausted'))
        })
        await step(150, () => {
          const form = card.querySelector('form.wm-exhaustion-form')
          const li = card.querySelector('li[data-window="win-2"]')
          const active = document.activeElement
          out.narrowExhaustion = {
            formOpened: !!form,
            inlineInWindow: form?.closest('li[data-window]')?.dataset.window === 'win-2',
            directlyUnderButton: li?.querySelector('.wm-quota-actions')?.nextElementSibling === form,
            focusInForm: active?.type === 'datetime-local' && !!active?.closest('form.wm-exhaustion-form'),
            paneOverflow: narrow.scrollWidth - narrow.clientWidth,
          }
        })
        for (const width of [380, 1200]) {
          const host = document.getElementById(`app-${width}`)
          const stats = host.querySelector('.wm-stats')
          const cols = getComputedStyle(stats).gridTemplateColumns.split(' ').filter(Boolean).length
          const values = [...host.querySelectorAll('.wm-statvalue')]
          const feesText = values.map(el => el.textContent).join(' | ')
          out.containers[width] = {
            columns: cols,
            feesText,
            hasLongFee: feesText.includes('1234567.89'),
            hasMixedCurrencies: feesText.includes('$') && feesText.includes('£'),
            overflow: values.map(el => el.scrollWidth - el.clientWidth),
            paneOverflow: host.scrollWidth - host.clientWidth,
            rows: host.querySelectorAll('.wm-row-head').length,
          }
        }
        done()
      } catch (error) { out.error = String(error); done() }
    })()
  }, 1500)
} catch (error) { out.error = String(error); done() }
