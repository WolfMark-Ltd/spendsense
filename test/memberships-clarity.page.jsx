// Browser entry for the WP20 Memberships clarity regression. Renders the real
// MembershipsPage in narrow/wide × dark/light containers with a synthetic
// account set covering every reading situation a provider can produce —
// reported, included, prepaid, metered, free and unconfigured — plus a route
// Hermes cannot read, a failed read and a stored view nobody has refreshed.
// Records real geometry, chips, notes and the Costs link behaviour for
// --dump-dom capture. The `native_probe` fields mirror the payload a provider
// read returns; the page's own request in this harness is the stored view.
import React from 'react'
import { createRoot } from 'react-dom/client'
import plugin, { __test as T } from '__ROOT__/desktop/plugin.js'
import { calls } from '__ROOT__/test/tooltip-layout.sdk.mjs'

const LOCALE = '__LOCALE__'
// Screenshot captures (?shot=1) stop before the Costs link is pressed, so the
// tab bar in the image still shows Memberships selected.
const SHOT = new URLSearchParams(location.search).has('shot')
const out = { locale: LOCALE, cases: {}, checks: {} }
const t = (key, ...args) => {
  const entry = T.I18N[LOCALE][key]
  return typeof entry === 'function' ? entry(...args) : entry ?? key
}
globalThis.__membershipTranslator = t
const done = () => {
  out.hostCalls = calls.length
  document.getElementById('memberships-clarity-result').textContent = JSON.stringify(out)
}

const accounts = [
  // A successful provider reading, read ten minutes ago.
  { id: 'memb:reported', family: 'anthropic', label: 'main',
    billing_arrangement: 'subscription', effective_arrangement: 'subscription',
    plan_id: 'anthropic.claude-max', plan: { name: 'Claude Max 20x' },
    fee: { basis: 'catalogue', effective: { amount: 100, currency: 'USD', period: 'month' } },
    quota: { provider_state: 'live', age_seconds: 600, has_provider_reporting: true, windows: [
      { id: 'weekly', label: 'Weekly', used_percent: 24, state: 'live', scope: 'account',
        basis: ['provider_reported'] },
    ] },
    native_probe: { state: 'ok', reason: '' },
    manual_exhaustions: [], fee_overrides: [], plan_choices: [], excluded_plans: [],
    rev: 'r1', route_entitlement_rev: 'route-r1', credential_present: true },

  // Hermes answers, and has no allowance reading for this route.
  { id: 'memb:unsupported', family: 'commandcode-anthropic', label: 'commandcode-anthropic',
    billing_arrangement: 'subscription', effective_arrangement: 'subscription',
    plan_id: 'commandcode.goat', plan: { name: 'GOAT' },
    fee: { basis: 'catalogue', effective: { amount: 19.99, currency: 'EUR', period: 'month' } },
    quota: { provider_state: 'absent', age_seconds: null, has_provider_reporting: false, windows: [
      { id: 'daily', label: 'Daily allowance', used_percent: null, state: 'no_data', scope: 'account',
        basis: ['none'] },
    ] },
    native_probe: { state: 'unsupported', reason: 'the hermes CLI is not on PATH' },
    manual_exhaustions: [], fee_overrides: [], plan_choices: [], excluded_plans: [],
    rev: 'r1', route_entitlement_rev: 'route-r1', credential_present: true },

  // The provider read itself failed.
  { id: 'memb:failed', family: 'commandcode', label: 'goat',
    billing_arrangement: 'subscription', effective_arrangement: 'subscription',
    plan_id: 'commandcode.goat', plan: { name: 'GOAT' },
    fee: { basis: 'catalogue', effective: { amount: 10, currency: 'USD', period: 'month' } },
    quota: { provider_state: 'absent', age_seconds: null, has_provider_reporting: false, windows: [
      { id: 'five-hours', label: 'Five-hour window', used_percent: null, state: 'no_data',
        scope: 'account', basis: ['none'] },
    ] },
    native_probe: { state: 'error', reason: 'usage read failed: TimeoutExpired' },
    manual_exhaustions: [], fee_overrides: [], plan_choices: [], excluded_plans: [],
    rev: 'r1', route_entitlement_rev: 'route-r1', credential_present: true },

  // Hermes answered, but returned no reading: it cannot say which of
  // "no credential", "no endpoint" or "the fetch failed" applies.
  { id: 'memb:nohermes', family: 'xai', label: 'grok',
    billing_arrangement: 'subscription', effective_arrangement: 'subscription',
    plan_id: 'xai.supergrok', plan: { name: 'SuperGrok' },
    fee: { basis: 'unpriced', effective: { amount: null } },
    quota: { provider_state: 'absent', age_seconds: null, has_provider_reporting: false, windows: [
      { id: 'messages', label: 'Messages', used_percent: null, state: 'no_data',
        scope: 'account', basis: ['none'] },
    ] },
    native_probe: { state: 'unavailable', reason: 'no credential configured, no usage endpoint, or the fetch failed' },
    manual_exhaustions: [], fee_overrides: [], plan_choices: [], excluded_plans: [],
    rev: 'r1', route_entitlement_rev: 'route-r1', credential_present: true },

  // Nothing has been asked yet: the stored view only.
  { id: 'memb:stored', family: 'openai-codex', label: 'personal',
    billing_arrangement: 'unconfirmed', effective_arrangement: 'unconfirmed',
    plan_id: null, plan: null,
    fee: { basis: 'unconfirmed', effective: { amount: null } },
    quota: { provider_state: 'absent', windows: [] },
    manual_exhaustions: [], fee_overrides: [], plan_choices: [], excluded_plans: [],
    rev: 'r1', route_entitlement_rev: 'route-r1', credential_present: true },

  // Shared entitlement: no separate fee, and the owner is named.
  { id: 'memb:included', family: 'anthropic', label: 'shared',
    billing_arrangement: 'included', effective_arrangement: 'included',
    plan_id: null, plan: null,
    entitlement_owner_id: 'memb:reported',
    entitlement_owner: { id: 'memb:reported', label: 'main', family: 'anthropic' },
    fee: { basis: 'included', effective: { amount: null, currency: null, period: null } },
    quota: { provider_state: 'absent', windows: [] },
    manual_exhaustions: [], fee_overrides: [], plan_choices: [], excluded_plans: [],
    rev: 'r1', route_entitlement_rev: 'route-r1', credential_present: true },

  // Prepaid credits: no recurring fee.
  { id: 'memb:prepaid', family: 'openai', label: 'credits',
    billing_arrangement: 'prepaid', effective_arrangement: 'prepaid',
    plan_id: null, plan: null,
    fee: { basis: 'prepaid', effective: { amount: null } },
    quota: { provider_state: 'absent', windows: [] },
    manual_exhaustions: [], fee_overrides: [], plan_choices: [], excluded_plans: [],
    rev: 'r1', route_entitlement_rev: 'route-r1', credential_present: true },

  // A catalogue-listed free tier.
  { id: 'memb:free', family: 'google-gemini', label: 'free',
    billing_arrangement: 'subscription', effective_arrangement: 'free_tier',
    plan_id: 'google-gemini.free', plan: { name: 'Gemini Free' },
    fee: { basis: 'free_tier', effective: { amount: 0, currency: 'USD', period: 'month' } },
    quota: { provider_state: 'absent', windows: [] },
    manual_exhaustions: [], fee_overrides: [], plan_choices: [], excluded_plans: [],
    rev: 'r1', route_entitlement_rev: 'route-r1', credential_present: true },

  // Metered API with no credential left: configured in the store, not usable.
  { id: 'memb:nocred', family: 'deepseek', label: 'key',
    billing_arrangement: 'unconfirmed', effective_arrangement: 'api_only',
    plan_id: null, plan: null,
    fee: { basis: 'api_only', effective: { amount: null } },
    quota: { provider_state: 'absent', windows: [] },
    manual_exhaustions: [], fee_overrides: [], plan_choices: [], excluded_plans: [],
    rev: 'r1', route_entitlement_rev: 'route-r1', credential_present: false },
]

const focusable = el => {
  if (!el || el.disabled) return false
  el.focus()
  const landed = document.activeElement === el
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur()
  return landed
}

try {
  plugin.register({
    rest: async path => {
      if (path.startsWith('/membership/accounts')) {
        return { ok: true, accounts, store: { loaded: true, error: '' },
          notes: ['openai-codex: usage read failed (usage read failed: TimeoutExpired)'] }
      }
      if (path.startsWith('/membership/plans')) return { ok: true, plans: [], vocabulary: {} }
      if (path.startsWith('/allowance/weather')) return { ok: true, accounts: [] }
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
  const ids = ['narrow-dark', 'wide-dark', 'narrow-light', 'wide-light']
  for (const id of ids) {
    createRoot(document.getElementById(id)).render(React.createElement(T.MembershipsPage, {}))
  }
  const step = (ms, fn) => new Promise(resolve => setTimeout(() => resolve(fn()), ms))
  setTimeout(() => {
    (async () => {
      try {
        // $membershipExpanded is shared by every root, so one toggle shows the
        // reading notes in all four cases.
        {
          const host = document.getElementById(ids[0])
          for (const id of ['memb:reported', 'memb:unsupported', 'memb:nohermes', 'memb:failed', 'memb:stored']) {
            const card = host.querySelector(`[data-account="${id}"]`)
            // Structure, not copy: the disclosure is the row's aria-expanded
            // control, so this works in every locale.
            const details = card.querySelector('.wm-row-head button[aria-expanded]')
            details.click()
          }
        }
        await step(600, () => {})
        // Screenshot captures open the allowance groups, so the picture shows
        // the reading notes the states produce. Tests keep them closed.
        if (SHOT) {
          for (const id of ids) {
            for (const account of ['memb:reported', 'memb:unsupported', 'memb:nohermes', 'memb:failed', 'memb:stored']) {
              const group = document.getElementById(id)
                ?.querySelector(`[data-account="${account}"] details[data-group="allowances"]`)
              if (group) group.open = true
            }
          }
          await step(200, () => {})
        }
        const zeroPattern = /(^|[^\d])0%|\$0\.00/
        for (const id of ids) {
          const host = document.getElementById(id)
          const pane = host.querySelector('.wm-memberships') || host
          const rows = [...host.querySelectorAll('article[data-account]')].map(card => {
            const chip = card.querySelector('.wm-row-mid [data-state]')
            return {
              account: card.dataset.account,
              head: card.querySelector('.wm-row-head').textContent,
              fee: card.querySelector('.wm-row-fee')?.textContent || '',
              readingState: chip?.dataset.state || '',
              readingLabel: chip?.textContent || '',
              chipOverflow: chip ? chip.scrollWidth - chip.clientWidth : 0,
              stateChips: [...card.querySelectorAll('.wm-row-state .wm-chip')]
                .map(element => element.textContent),
              readingNotes: [...card.querySelectorAll('[data-reading-note]')]
                .map(note => ({ state: note.dataset.readingNote, text: note.textContent })),
              readingAge: card.querySelector('[data-reading-age]')?.textContent || '',
            }
          })
          const costs = host.querySelector('[data-wm-costs-link]')
          out.cases[id] = {
            paneOverflow: host.scrollWidth - host.clientWidth,
            rows,
            zeroMentions: (pane.textContent.match(zeroPattern) || []).length,
            paneText: pane.textContent,
            costsLink: costs ? costs.textContent : '',
            costsFocusable: focusable(costs),
            diagnosticsSummary: host.querySelector('[data-wm-diagnostics] > summary')?.textContent || '',
            diagnosticsNote: host.querySelector('[data-wm-diagnostics] p')?.textContent || '',
            attentionScope: host.querySelector('[data-attention-scope]')?.textContent || '',
            summaryLabels: [...host.querySelectorAll('.wm-membership-summary dt')].map(el => el.textContent),
            summaryValues: [...host.querySelectorAll('.wm-membership-summary dd')].map(el => el.textContent),
            groups: (() => {
              // Headings and cards share one parent, so group membership is
              // read from document order.
              const out = []
              for (const node of host.querySelectorAll('.wm-membership-groups > *')) {
                if (node.dataset.groupKind) {
                  out.push({ kind: node.dataset.groupKind, title: node.textContent || '', accounts: [] })
                } else if (node.dataset.account && out.length) {
                  out[out.length - 1].accounts.push(node.dataset.account)
                }
              }
              return out
            })(),
            arrangementChips: [...host.querySelectorAll('.wm-arrangement-chips li')].map(el => el.textContent),
            arrangementOf: Object.fromEntries([...host.querySelectorAll('article[data-account]')]
              .map(card => [card.dataset.account, card.dataset.arrangement])),
            readingHealth: host.querySelector('[data-reading-health]')?.textContent || '',
            readingFailed: host.querySelector('[data-reading-health]')?.dataset.readingFailed || '',
            explainer: host.querySelector('details.wm-membership-explainer')?.textContent || '',
            backendNotesInDetails: !!host.querySelector('[data-wm-diagnostics] [data-wm-backend-notes]'),
            rawNotesInNormalView: [...host.querySelectorAll('.wm-attention, .wm-empty, .wm-membership-value')]
              .some(el => /TimeoutExpired/.test(el.textContent || '')),
          }
        }
        // The link is the discoverable route into the Costs subscription-value
        // view: pressing it selects the Costs destination.
        if (!SHOT) {
          // The destination is another change's page, so stand in for the
          // anchor it publishes: the link must land on that section.
          const anchor = document.createElement('section')
          anchor.id = 'wm-subscription-economics'
          document.body.appendChild(anchor)
          const narrow = document.getElementById('narrow-dark')
          T.$ledgerTab.set('memberships')
          narrow.querySelector('[data-wm-costs-link]').click()
          out.checks.costsTabAfterClick = T.$ledgerTab.get()
          await step(400, () => {})
          out.checks.costsAnchorFocused = document.activeElement === anchor
          out.checks.costsAnchorTabIndex = anchor.getAttribute('tabindex')
          anchor.remove()
        }
        done()
      } catch (error) { out.error = String(error && error.stack || error); done() }
    })()
  }, 1600)
} catch (error) { out.error = String(error && error.stack || error); done() }
