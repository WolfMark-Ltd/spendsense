// Browser entry for the WP27 Memberships headline-card regression. Renders the
// real MembershipsPage at pane, mid and ledger widths in dark and light with a
// synthetic account set covering every arrangement the page can show, and
// records the computed geometry of the four summary cards: rail, figure size
// and weight, status chip, note, grid columns, gaps and overflow. Also records
// what one expanded row shows without a second click. Real page, real CSS.
import React from 'react'
import { createRoot } from 'react-dom/client'
import plugin, { __test as T } from '__ROOT__/desktop/plugin.js'
import { calls } from '__ROOT__/test/tooltip-layout.sdk.mjs'

const LOCALE = '__LOCALE__'
const out = { locale: LOCALE, cases: {} }
const t = (key, ...args) => {
  const entry = T.I18N[LOCALE][key]
  return typeof entry === 'function' ? entry(...args) : entry ?? key
}
globalThis.__membershipTranslator = t
const done = () => {
  out.hostCalls = calls.length
  document.getElementById('memberships-cards-result').textContent = JSON.stringify(out)
}

const base = (id, extra) => ({
  id, manual_exhaustions: [], fee_overrides: [], plan_choices: [], excluded_plans: [],
  rev: 'r1', route_entitlement_rev: 'route-r1', credential_present: true, ...extra,
})

const accounts = [
  // A paid subscription with a catalogue fee and a live reading.
  base('anthropic:main', { family: 'anthropic', label: 'Main', billing_arrangement: 'subscription',
    effective_arrangement: 'subscription', plan_id: 'anthropic.claude-max', plan: { name: 'Claude Max 20x' },
    fee: { basis: 'catalogue', effective: { amount: 100, currency: 'USD', period: 'month' } },
    quota: { provider_state: 'live', age_seconds: 900, has_provider_reporting: true, windows: [
      { id: 'weekly', label: 'Weekly', used_percent: 24, state: 'live', scope: 'account', basis: ['provider_reported'] },
    ] }, native_probe: { state: 'ok', reason: '' } }),
  // A paid subscription whose fee is genuinely unknown.
  base('xai-oauth:grok', { family: 'xai-oauth', label: 'Grok',
    billing_arrangement: 'subscription', effective_arrangement: 'subscription',
    plan_id: 'xai.supergrok', plan: { name: 'SuperGrok' },
    fee: { basis: 'unpriced', effective: { amount: null } },
    quota: { provider_state: 'absent', age_seconds: null, has_provider_reporting: false, windows: [] },
    native_probe: { state: 'unavailable', reason: 'no credential configured' } }),
  // A second paid subscription in another currency.
  base('commandcode:goat', { family: 'commandcode', label: 'Work',
    billing_arrangement: 'subscription', effective_arrangement: 'subscription',
    plan_id: 'commandcode.goat', plan: { name: 'GOAT' },
    fee: { basis: 'catalogue', effective: { amount: 19.99, currency: 'EUR', period: 'month' } },
    quota: { provider_state: 'absent', windows: [] } }),
  // A confirmed free tier: a real zero, not an unknown.
  base('google-gemini:free', { family: 'google-gemini', label: 'Free',
    billing_arrangement: 'subscription', effective_arrangement: 'free_tier',
    plan_id: 'google-gemini.free', plan: { name: 'Gemini Free' },
    fee: { basis: 'free_tier', effective: { amount: 0, currency: 'USD', period: 'month' } },
    quota: { provider_state: 'absent', windows: [] } }),
  // Included with another plan: no separate fee.
  base('anthropic:shared', { family: 'anthropic', label: 'Shared',
    billing_arrangement: 'included', effective_arrangement: 'included',
    plan_id: null, plan: null, entitlement_owner_id: 'anthropic:main',
    entitlement_owner: { id: 'anthropic:main', label: 'Main', family: 'anthropic' },
    fee: { basis: 'included', effective: { amount: null, currency: null, period: null } },
    quota: { provider_state: 'absent', windows: [] } }),
  // Prepaid credits.
  base('openai:credits', { family: 'openai', label: 'Credits',
    billing_arrangement: 'prepaid', effective_arrangement: 'prepaid',
    plan_id: null, plan: null, fee: { basis: 'prepaid', effective: { amount: null } },
    quota: { provider_state: 'absent', windows: [] } }),
  // Metered API with no credential.
  base('deepseek:key', { family: 'deepseek', label: 'Key',
    billing_arrangement: 'unconfirmed', effective_arrangement: 'api_only',
    plan_id: null, plan: null, fee: { basis: 'api_only', effective: { amount: null } },
    quota: { provider_state: 'absent', windows: [] }, credential_present: false }),
  // A deliberate no-plan account.
  base('nous:portal', { family: 'nous', label: 'Portal',
    billing_arrangement: 'no_plan', effective_arrangement: 'no_plan',
    plan_id: null, plan: null, fee: { basis: 'no_plan', effective: { amount: null } },
    quota: { provider_state: 'absent', windows: [] } }),
  // Nothing confirmed yet: the account that needs attention.
  base('openai-codex:personal', { family: 'openai-codex', label: 'Personal',
    billing_arrangement: 'unconfirmed', effective_arrangement: 'unconfirmed',
    plan_id: null, plan: null, fee: { basis: 'unconfirmed', effective: { amount: null } },
    quota: { provider_state: 'absent', windows: [] } }),
]

try {
  plugin.register({
    rest: async path => {
      if (path.startsWith('/membership/accounts')) {
        return { ok: true, accounts, store: { loaded: true, error: '' }, notes: [] }
      }
      if (path.startsWith('/membership/plans')) return { ok: true, plans: [], vocabulary: {} }
      return { ok: true, accounts: [] }
    },
    storage: { get: (_k, d) => d, set() {}, delete() {} },
    register() {}, registerMany() {}, onDispose() {}, onEvent: () => () => {},
    setTimeout: fn => { const timer = setTimeout(fn, 0); return () => clearTimeout(timer) },
    setInterval: () => () => {},
    addEventListener: () => () => {},
    os: {}, pet: null, i18n: { register() {}, t: key => key },
  })
  T.$ledgerTab.set('memberships')
  const ids = [...document.querySelectorAll('[id^="cards-"]')].map(el => el.id)
  for (const id of ids) {
    createRoot(document.getElementById(id)).render(React.createElement(T.MembershipsPage, {}))
  }
  const step = (ms, fn) => new Promise(resolve => setTimeout(() => resolve(fn()), ms))
  const waitFor = async (find, ms = 10000) => {
    const deadline = Date.now() + ms
    for (;;) {
      const found = find()
      if (found) return found
      if (Date.now() >= deadline) return found
      await step(25, () => {})
    }
  }
  setTimeout(() => {
    (async () => {
      try {
        await waitFor(() => document.getElementById(ids[0])?.querySelector('[data-account]'))
        // Expand one row once: $membershipExpanded is shared by every root.
        {
          const host = document.getElementById(ids[0])
          const card = host.querySelector('[data-account="anthropic:main"]')
          card.querySelector('.wm-row-head button[aria-expanded]').click()
        }
        await step(500, () => {})
        for (const id of ids) {
          const host = document.getElementById(id)
          const pane = host.querySelector('.wm-memberships')
          const grid = host.querySelector('.wm-membership-summary')
          const cards = [...host.querySelectorAll('.wm-membership-summary [data-summary-card]')]
          const measure = card => {
            const figure = card.querySelector('.wm-membership-summary-value')
            const label = card.querySelector('.wm-membership-summary-label')
            const status = card.querySelector('.wm-membership-summary-status')
            const note = card.querySelector('.wm-membership-summary-note')
            const lines = [...card.querySelectorAll('.wm-membership-fee-lines li')]
            const style = getComputedStyle(card)
            const figureStyle = figure ? getComputedStyle(figure)
              : lines.length ? getComputedStyle(lines[0]) : null
            const rect = card.getBoundingClientRect()
            return {
              kind: card.dataset.summaryCard,
              tone: card.dataset.tone,
              label: label?.textContent || '',
              labelSize: label ? parseFloat(getComputedStyle(label).fontSize) : 0,
              value: figure?.textContent || lines.map(li => li.textContent).join(' '),
              lines: lines.map(el => el.textContent),
              valueSize: figureStyle ? parseFloat(figureStyle.fontSize) : 0,
              valueWeight: figureStyle ? Number(figureStyle.fontWeight) : 0,
              railWidth: style.borderLeftWidth,
              railColour: style.borderLeftColor,
              background: style.backgroundColor,
              pageBackground: getComputedStyle(host).backgroundColor,
              status: status?.textContent || '',
              statusSize: status ? parseFloat(getComputedStyle(status).fontSize) : 0,
              note: note?.textContent || '',
              noteSize: note ? parseFloat(getComputedStyle(note).fontSize) : 0,
              overflow: card.scrollWidth - card.clientWidth,
              left: Math.round(rect.left),
              right: Math.round(rect.right),
              top: Math.round(rect.top),
              width: Math.round(rect.width),
            }
          }
          const cardMeasure = cards.map(measure)
          const gridStyle = getComputedStyle(grid)
          const row = host.querySelector('[data-account="anthropic:main"]')
          out.cases[id] = {
            columns: gridStyle.gridTemplateColumns.split(' ').filter(Boolean).length,
            columnGap: parseFloat(gridStyle.columnGap) || 0,
            rowGap: parseFloat(gridStyle.rowGap) || 0,
            cards: cardMeasure,
            paneOverflow: host.scrollWidth - host.clientWidth,
            paneText: pane.textContent,
            paneVisibleText: pane.innerText || '',
            // The row a reader opens shows its readings; the edit path and the
            // technical group wait.
            expanded: row ? {
              allowancesOpen: row.querySelector('[data-group="allowances"]').open,
              planOpen: row.querySelector('[data-group="plan"]').open,
              advancedOpen: row.querySelector('[data-group="advanced"]').open,
              allowancesHeight: Math.round(row.querySelector('[data-group="allowances"] .wm-group-body')
                .getBoundingClientRect().height),
            } : null,
          }
        }
        done()
      } catch (error) { out.error = String(error && error.stack || error); done() }
    })()
  }, 1600)
} catch (error) { out.error = String(error && error.stack || error); done() }
