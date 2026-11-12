// Browser entry for the F63 memberships disclosure regression. Renders the
// real MembershipsPage in narrow/wide × dark/light containers with synthetic
// accounts, then drives each card group (Plan & billing, Allowances &
// readings, Advanced & diagnostics) through closed → open → closed with real
// geometry and focus checks for --dump-dom capture. Group toggles are native
// <details> behaviour, so no waiting is needed between steps.
import React from 'react'
import { createRoot } from 'react-dom/client'
import plugin, { __test as T } from '__ROOT__/desktop/plugin.js'
import { calls } from '__ROOT__/test/tooltip-layout.sdk.mjs'

const LOCALE = '__LOCALE__'
const out = { locale: LOCALE, cases: {}, flow: {} }
const t = (key, ...args) => {
  const entry = T.I18N[LOCALE][key]
  return typeof entry === 'function' ? entry(...args) : entry ?? key
}
globalThis.__membershipTranslator = t
const done = () => {
  out.hostCalls = calls.length
  document.getElementById('memberships-disclosure-result').textContent = JSON.stringify(out)
}

const accounts = [
  { id: 'memb:sub', family: 'anthropic', label: 'main',
    billing_arrangement: 'subscription', effective_arrangement: 'subscription',
    plan_id: 'anthropic.claude-max', plan: { name: 'Claude Max 20x' },
    fee: { basis: 'catalogue', effective: { amount: 100, currency: 'USD', period: 'month' } },
    quota: { windows: [
      { id: 'win-1', label: 'Weekly', used_percent: 24, state: 'live',
        basis: ['provider_reported'], scope: 'account' },
    ] },
    manual_exhaustions: [], fee_overrides: [], plan_choices: [],
    excluded_plans: [], rev: 'r1', route_entitlement_rev: 'route-r1', credential_present: true },
  { id: 'memb:unconfirmed', family: 'openai-codex', label: 'main',
    billing_arrangement: 'unconfirmed', effective_arrangement: 'unconfirmed',
    plan_id: null, plan: null,
    fee: { basis: 'unconfirmed', effective: { amount: null } },
    quota: { windows: [] },
    manual_exhaustions: [], fee_overrides: [], plan_choices: [],
    excluded_plans: [], rev: 'r1', route_entitlement_rev: 'route-r1', credential_present: true },
]
const weatherAccounts = [{ account_id: 'memb:sub', cycle: {}, notes: [],
  windows: [{ id: 'wp-1', label: 'Weekly pool', verdict: 'ahead',
    declared: { kind: 'unknown' }, provider: null }],
  rules: [] }]

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
  T.$ledgerTab.set('memberships')
  const ids = ['narrow-dark', 'wide-dark', 'narrow-light', 'wide-light']
  for (const id of ids) {
    createRoot(document.getElementById(id)).render(React.createElement(T.MembershipsPage, {}))
  }
  const step = (ms, fn) => new Promise(r => setTimeout(() => r(fn()), ms))
  const chevron = summary => getComputedStyle(summary, '::before').transform
  // A control counts as keyboard-reachable only when .focus() actually lands.
  const focusable = el => {
    if (!el || el.disabled) return false
    el.focus()
    const landed = document.activeElement === el
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur()
    return landed
  }
  setTimeout(() => {
    (async () => {
      try {
        // Expand the subscription card once: $membershipExpanded is shared,
        // so one toggle covers all four roots.
        {
          const host = document.getElementById(ids[0])
          const card = host.querySelector('[data-account="memb:sub"]')
          const btn = [...card.querySelectorAll('.wm-row-head button')]
            .find(b => b.textContent.includes(t('memDetails')))
          btn.click()
        }
        await step(500, () => {})
        for (const id of ids) {
          const host = document.getElementById(id)
          const card = host.querySelector('[data-account="memb:sub"]')
          const group = name => card.querySelector(`details[data-group="${name}"]`)
          const body = name => group(name).querySelector(':scope > .wm-group-body')
          const summary = name => group(name).querySelector(':scope > summary')
          const probe = {
            plan: () => card.querySelector('button[data-action="edit-fee"]'),
            allowances: () => card.querySelector('li[data-window="win-1"] button[data-action="mark-exhausted"]'),
            advanced: () => group('advanced').querySelector('.wm-setting-action button'),
          }
          const snap = name => ({
            open: group(name).open,
            height: Math.round(body(name).getBoundingClientRect().height),
            display: getComputedStyle(body(name)).display,
            chevron: chevron(summary(name)),
            control: !!probe[name](),
            focusable: focusable(probe[name]()),
          })
          const closed = { plan: snap('plan'), allowances: snap('allowances'), advanced: snap('advanced') }
          // Native toggles: no React state, no waiting between clicks.
          for (const name of ['plan', 'allowances', 'advanced']) summary(name).click()
          const open = { plan: snap('plan'), allowances: snap('allowances'), advanced: snap('advanced') }
          // Nested allowance-weather disclosure, measured while its parent
          // allowances group is open so only its own state affects layout.
          const weather = card.querySelector('.wm-weather-details')
          const weatherUl = weather ? weather.querySelector(':scope > ul') : null
          const weatherSnap = () => weather && weatherUl ? {
            open: weather.open,
            height: Math.round(weatherUl.getBoundingClientRect().height),
          } : null
          const weatherClosed = weatherSnap()
          if (weather && !weather.open) weather.querySelector(':scope > summary').click()
          const weatherOpen = weatherSnap()
          for (const name of ['plan', 'allowances', 'advanced']) summary(name).click()
          const reclosed = { plan: snap('plan'), allowances: snap('allowances'), advanced: snap('advanced') }
          out.cases[id] = { closed, open, reclosed, weatherClosed, weatherOpen,
            paneOverflow: host.scrollWidth - host.clientWidth }
        }
        // Fee-draft round trip in narrow-dark: opening the form opens its
        // group, and cancelling keeps the group open with focus on the opener.
        const narrow = document.getElementById('narrow-dark')
        const card = narrow.querySelector('[data-account="memb:sub"]')
        const plan = card.querySelector('details[data-group="plan"]')
        if (!plan.open) plan.querySelector(':scope > summary').click()
        await step(200, () => { card.querySelector('button[data-action="edit-fee"]').click() })
        await step(400, () => {
          const form = card.querySelector('form.wm-fee-form')
          out.flow.formOpened = !!form
          out.flow.groupOpenWithDraft = plan.open === true
          const cancel = form ? [...form.querySelectorAll('button')].find(b => b.type !== 'submit') : null
          cancel?.click()
        })
        await step(400, () => {
          const edit = card.querySelector('button[data-action="edit-fee"]')
          out.flow.formClosed = !card.querySelector('form.wm-fee-form')
          out.flow.groupOpenAfterCancel = plan.open === true
          out.flow.editHeight = Math.round(edit.getBoundingClientRect().height)
          out.flow.focusReturned = document.activeElement === edit
        })
        done()
      } catch (error) { out.error = String(error && error.stack || error); done() }
    })()
  }, 1500)
} catch (error) { out.error = String(error && error.stack || error); done() }
