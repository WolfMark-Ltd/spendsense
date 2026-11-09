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
const params = new URLSearchParams(location.search)
const visualCapture = params.has('visual')
if (visualCapture) {
  document.documentElement.dataset.theme = params.get('theme') || 'dark'
}
globalThis.__membershipTranslator = (key, ...args) => {
  const entry = T.I18N.en[key]
  return typeof entry === 'function' ? entry(...args) : entry ?? key
}
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
const visualAccounts = [
  {
    id: 'anthropic:work', family: 'anthropic', label: 'Work',
    billing_arrangement: 'subscription', effective_arrangement: 'subscription',
    plan_id: 'anthropic.claude-pro', plan: { name: 'Claude Pro' },
    fee: { basis: 'declared', effective: { amount: 20, currency: 'USD', period: 'month' } },
    quota: { windows: [
      { id: 'weekly', label: 'Weekly allowance', used_percent: 46, state: 'live' },
      { id: 'monthly', label: 'Monthly allowance', used_percent: 31, state: 'live' },
    ] }, manual_exhaustions: [], fee_overrides: [], plan_choices: [], excluded_plans: [], rev: 'r1',
  },
  {
    id: 'openai-codex:personal', family: 'openai-codex', label: 'Personal',
    billing_arrangement: 'unconfirmed', effective_arrangement: 'unconfirmed',
    plan_id: null, plan: null,
    fee: { basis: 'unconfirmed', effective: {} },
    quota: { windows: [{ id: 'messages', label: 'Messages', state: 'no_data' }] },
    manual_exhaustions: [], fee_overrides: [], plan_choices: [], excluded_plans: [], rev: 'r1',
  },
  {
    id: 'google-gemini:studio', family: 'google-gemini', label: 'Studio',
    billing_arrangement: 'subscription', effective_arrangement: 'subscription',
    plan_id: 'google-gemini.ai-pro', plan: { name: 'Google AI Pro' },
    fee: { basis: 'catalogue', effective: { amount: 19.99, currency: 'EUR', period: 'month' } },
    quota: { windows: [
      { id: 'daily', label: 'Daily allowance', used_percent: 24, state: 'live' },
      { id: 'monthly', label: 'Monthly allowance', state: 'no_data' },
    ] }, manual_exhaustions: [], fee_overrides: [], plan_choices: [], excluded_plans: [], rev: 'r1',
  },
]

try {
  plugin.register({
    rest: async path => {
      if (path.startsWith('/membership/accounts')) {
        return { ok: true, accounts: visualCapture ? visualAccounts : accounts,
          store: { loaded: true, error: '' }, notes: [] }
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
  T.$ledgerTab.set('memberships')
  for (const width of [380, 1200]) {
    const host = document.getElementById(`app-${width}`)
    createRoot(host).render(React.createElement(T.MembershipsPage, {}))
  }
  const click = el => el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  const step = (ms, fn) => new Promise(resolve => setTimeout(() => resolve(fn()), ms))
  setTimeout(() => {
    (async () => {
      try {
        if (!visualCapture) {
          // Visible path in the narrow pane: Details → Allowances → Mark exhausted.
          const narrow = document.getElementById('app-380')
          const card = narrow.querySelector('[data-account="anthropic:default"]')
          click([...card.querySelectorAll('.wm-row-head button')].find(b => /Details/.test(b.textContent)))
          await step(150, () => click(card.querySelector('[data-group="allowances"] > summary')))
          await step(150, () => {
            const li = card.querySelector('li[data-window="win-2"]')
            const markLabel = b => (b.textContent || '').replace(/\s+/g, '').toLowerCase()
            click([...li.querySelectorAll('button')]
              .find(b => ['markexhausted', 'memmarkexhausted'].includes(markLabel(b))))
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
        }
        for (const width of [380, 1200]) {
          const host = document.getElementById(`app-${width}`)
          const summary = host.querySelector('.wm-membership-summary')
          const cols = getComputedStyle(summary).gridTemplateColumns.split(' ').filter(Boolean).length
          const values = [...summary.querySelectorAll('dd')]
          const feesText = summary.lastElementChild?.querySelector('dd')?.textContent || ''
          out.containers[width] = {
            columns: cols,
            feesText,
            hasLongFee: feesText.includes('1234567.89'),
            hasMixedCurrencies: feesText.includes('$') && feesText.includes('£'),
            overflow: values.map(el => el.scrollWidth - el.clientWidth),
            paneOverflow: host.scrollWidth - host.clientWidth,
            rows: host.querySelectorAll('.wm-row-head').length,
            readingStates: [...host.querySelectorAll('.wm-row-mid [data-state]')].map(el => el.dataset.state),
          }
        }
        done()
      } catch (error) { out.error = String(error); done() }
    })()
  }, 1500)
} catch (error) { out.error = String(error); done() }
