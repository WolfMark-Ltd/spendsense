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
import { clarityResponse } from '__ROOT__/test/memberships-fixtures.mjs'

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
      if (path.startsWith('/membership/accounts')) return clarityResponse()
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
  // Bounded wait for the accounts to render: a fixed sleep that was ample
  // becomes a race the moment the page grows or the machine is busy.
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
            summaryLabels: [...host.querySelectorAll('.wm-membership-summary-label')].map(el => el.textContent),
            summaryCards: [...host.querySelectorAll('.wm-membership-summary [data-summary-card]')].map(card => {
              const figure = card.querySelector('.wm-membership-summary-value')
              const lines = [...card.querySelectorAll('.wm-membership-fee-lines li')]
              // The fee reading is a list, not a single figure: measure the
              // line a reader actually sees.
              const style = figure ? getComputedStyle(figure)
                : lines.length ? getComputedStyle(lines[0]) : null
              const cardStyle = getComputedStyle(card)
              return {
                kind: card.dataset.summaryCard,
                tone: card.dataset.tone,
                label: card.querySelector('.wm-membership-summary-label')?.textContent || '',
                value: figure ? figure.textContent : lines.map(el => el.textContent).join(' '),
                lines: lines.map(el => el.textContent),
                status: card.querySelector('.wm-membership-summary-status')?.textContent || '',
                note: card.querySelector('.wm-membership-summary-note')?.textContent || '',
                valueSize: style ? parseFloat(style.fontSize) : 0,
                valueWeight: style ? Number(style.fontWeight) : 0,
                railWidth: cardStyle.borderLeftWidth,
                railColour: cardStyle.borderLeftColor,
                background: cardStyle.backgroundColor,
                overflow: card.scrollWidth - card.clientWidth,
              }
            }),
            summaryColumns: getComputedStyle(host.querySelector('.wm-membership-summary'))
              .gridTemplateColumns.split(' ').filter(Boolean).length,
            arrangementSum: [...host.querySelectorAll('.wm-arrangement-chips li')]
              .reduce((sum, li) => sum + Number(li.querySelector('.wm-arrangement-count')?.textContent || 0), 0),
            arrangementLabels: [...host.querySelectorAll('.wm-arrangement-label')].map(el => el.textContent),
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
