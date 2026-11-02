// Browser entry for the memberships layout test. Renders the real
// MembershipsPage twice — 380px and 1200px containers — with synthetic
// accounts carrying long mixed-currency fees, and records real grid
// geometry for --dump-dom capture.
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
    quota: { windows: [] }, manual_exhaustions: [], fee_overrides: [],
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
  setTimeout(() => {
    try {
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
  }, 1500)
} catch (error) { out.error = String(error); done() }
