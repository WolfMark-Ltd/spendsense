// Browser entry for the PR-D polish layout/focus test. Renders the real
// MembershipsPage at 380px and 1200px with synthetic attention accounts,
// then drives attention navigation in the narrow pane and records real
// geometry, focus and highlight state for --dump-dom capture. The SDK stub
// renders i18n keys literally, so controls are matched by key text
// (memArr*, attnAct*) and data attributes, never English copy.
import React from 'react'
import { createRoot } from 'react-dom/client'
import plugin, { __test as T } from '../desktop/plugin.js'
import { calls } from './tooltip-layout.sdk.mjs'

const out = { containers: {}, steps: {} }
const done = () => {
  out.hostCalls = calls.length
  document.getElementById('memberships-polish-result').textContent = JSON.stringify(out)
}

// xai: unconfirmed -> arrangement target. nous: subscription + unpriced fee
// -> fee target. openai: reconfirm_due window mark -> window target.
const accounts = [
  {
    id: 'xai:default', family: 'xai', label: 'xAI', route_slugs: ['xai'],
    billing_arrangement: 'unconfirmed', effective_arrangement: 'unconfirmed',
    plan_id: null, plan: null,
    fee: { basis: 'unconfirmed', effective: { amount: null } },
    quota: { windows: [] }, manual_exhaustions: [], fee_overrides: [],
    plan_choices: [{ id: 'xai.supergrok', name: 'SuperGrok',
      price: { amount: null, currency: null, period: 'month' } }],
    excluded_plans: [], rev: 'r1',
  },
  {
    id: 'nous:default', family: 'nous', label: 'Nous',
    route_slugs: ['nous'], billing_arrangement: 'subscription',
    effective_arrangement: 'subscription', plan_id: 'nous.portal',
    plan: { name: 'Nous Portal' },
    fee: { basis: 'unpriced', effective: { amount: null } },
    quota: { windows: [] }, manual_exhaustions: [], fee_overrides: [],
    plan_choices: [{ id: 'nous.portal', name: 'Nous Portal',
      price: { amount: null, currency: null, period: 'month' } }],
    excluded_plans: [], rev: 'r1',
  },
  {
    id: 'openai:default', family: 'openai', label: 'OpenAI',
    route_slugs: ['openai'], billing_arrangement: 'subscription',
    effective_arrangement: 'subscription', plan_id: 'openai.plus',
    plan: { name: 'ChatGPT Plus' },
    fee: { basis: 'declared', effective: { amount: 20, currency: 'USD', period: 'month' } },
    quota: { windows: [
      { id: 'win-1', label: 'Weekly window', used_percent: 50, state: 'manual',
        used_percent_from: 'manual', basis: [],
        manual: { id: 'man-1', status: 'reconfirm_due' } },
    ] },
    manual_exhaustions: [], fee_overrides: [], plan_choices: [],
    excluded_plans: [], rev: 'r1',
  },
]
const puts = []

try {
  plugin.register({
    rest: async (path, opts = {}) => {
      const method = String(opts.method || 'GET').toUpperCase()
      if (method === 'PUT' && path.startsWith('/membership/accounts/')) {
        const id = decodeURIComponent(path.split('/').pop())
        const body = opts.body || {}
        puts.push({ id, api_only: body.api_only ?? null,
          billing_arrangement: body.billing_arrangement ?? null })
        const idx = accounts.findIndex(a => a.id === id)
        if (idx >= 0) {
          const next = { ...accounts[idx], ...body, rev: 'r2' }
          next.effective_arrangement = next.api_only ? 'api_only'
            : (next.billing_arrangement || 'unconfirmed')
          accounts[idx] = next
        }
        return { ok: true }
      }
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
  // Smooth scrolling does not move pixels under --dump-dom virtual time, so
  // the page records the scroll contract (called on the card, block start)
  // and asserts the target is laid out with real size inside its card. The
  // end-to-end visual scroll is a Desktop UAT item.
  const scrollCalls = []
  const nativeScrollIntoView = Element.prototype.scrollIntoView
  Element.prototype.scrollIntoView = function (opts) {
    scrollCalls.push({ account: this.closest?.('[data-account]')?.dataset?.account || null,
      block: opts?.block || null, behavior: opts?.behavior || null })
    if (nativeScrollIntoView) {
      try { nativeScrollIntoView.call(this, opts) } catch {}
    }
  }
  const laidOutInCard = el => {
    if (!el || !el.isConnected) return false
    const r = el.getBoundingClientRect()
    if (r.width < 2 || r.height < 2) return false
    const card = el.closest('[data-account]')
    if (!card) return false
    const c = card.getBoundingClientRect()
    return r.left >= c.left - 2 && r.right <= c.right + 2 &&
      r.top >= c.top - 2 && r.bottom <= c.bottom + 2
  }
  const scrolledCard = accountId => scrollCalls.some(call =>
    call.account === accountId && call.block === 'start')
  setTimeout(() => {
    (async () => {
      try {
        const narrow = document.getElementById('app-380')
        // Rows start collapsed, so expand all three before measuring.
        await step(200, () => {
          for (const card of narrow.querySelectorAll('[data-account]')) {
            const details = [...card.querySelectorAll('.wm-row-head button')]
              .find(b => b.textContent.includes('memDetails'))
            if (details && details.getAttribute('aria-expanded') !== 'true') click(details)
          }
        })
        await step(300, () => {})
        // Geometry pass: every segmented button fits its card at 380px.
        const segs = [...narrow.querySelectorAll('[data-nav="arrangement"]')]
        const segDetail = segs.map(seg => {
          const card = seg.closest('[data-account]')
          const cardRect = card.getBoundingClientRect()
          const buttons = [...seg.querySelectorAll('button')]
          return {
            account: card.dataset.account,
            options: buttons.length,
            pressed: buttons.filter(b => b.getAttribute('aria-pressed') === 'true').length,
            minHeight: Math.min(...buttons.map(b => b.getBoundingClientRect().height)),
            clipped: buttons.filter(b => {
              const r = b.getBoundingClientRect()
              return r.width < 2 || r.left < cardRect.left - 1 || r.right > cardRect.right + 1
            }).length,
            focusable: buttons.filter(b => !b.disabled && b.tabIndex >= 0).length,
          }
        })
        const attnButtons = [...narrow.querySelectorAll('.wm-attention li .wm-button')]
        out.geometry = {
          rows: narrow.querySelectorAll('.wm-row-head').length,
          segs: segDetail,
          paneOverflow: narrow.scrollWidth - narrow.clientWidth,
          attnButtonWidths: attnButtons.map(b => Math.round(b.getBoundingClientRect().width)),
          cssSeg: T.MEMBERSHIP_CSS.includes('.wm-seg'),
          cssFlash: T.MEMBERSHIP_CSS.includes('.wm-flash'),
          cssReducedMotion: T.MEMBERSHIP_CSS.includes('prefers-reduced-motion'),
        }
        const attnLi = label => [...narrow.querySelectorAll('.wm-attention li')]
          .find(li => (li.textContent || '').includes(label))
        // xai: arrangement target.
        await step(200, () => click(attnLi('xAI').querySelector('button')))
        await step(400, () => {
          const card = narrow.querySelector('[data-account="xai:default"]')
          const seg = card.querySelector('[data-nav="arrangement"]')
          const pressed = seg.querySelector('button[aria-pressed="true"]')
          out.steps.arrangement = {
            expanded: card.querySelector('.wm-row-head button').getAttribute('aria-expanded') === 'true',
            groupOpen: card.querySelector('[data-group="plan"]').open === true,
            focused: document.activeElement === pressed,
            focusedLabel: pressed.textContent,
            flashed: seg.classList.contains('wm-flash'),
            laidOut: laidOutInCard(pressed),
            scrolled: scrolledCard('xai:default'),
          }
        })
        // nous: fee target.
        await step(200, () => click(attnLi('Nous').querySelector('button')))
        await step(400, () => {
          const card = narrow.querySelector('[data-account="nous:default"]')
          const btn = card.querySelector('button[data-action="edit-fee"]')
          out.steps.fee = {
            expanded: card.querySelector('.wm-row-head button').getAttribute('aria-expanded') === 'true',
            focused: document.activeElement === btn,
            flashed: btn.classList.contains('wm-flash'),
            laidOut: laidOutInCard(btn),
            scrolled: scrolledCard('nous:default'),
          }
        })
        // openai: window target prefers the Clear mark action.
        await step(200, () => click(attnLi('OpenAI').querySelector('button')))
        await step(400, () => {
          const card = narrow.querySelector('[data-account="openai:default"]')
          const li = card.querySelector('li[data-window="win-1"]')
          const btn = li.querySelector('button[data-action="clear-mark"]')
          out.steps.window = {
            groupOpen: card.querySelector('[data-group="allowances"]').open === true,
            focused: document.activeElement === btn,
            flashed: li.classList.contains('wm-flash'),
            laidOut: laidOutInCard(btn),
            scrolled: scrolledCard('openai:default'),
          }
        })
        // Real segmented write on xai, last so attention order stays stable.
        await step(200, () => {
          const seg = narrow.querySelector('[data-account="xai:default"] [data-nav="arrangement"]')
          click([...seg.querySelectorAll('button')].find(b => b.textContent === 'memArrSubscription'))
        })
        await step(600, () => {
          const seg = narrow.querySelector('[data-account="xai:default"] [data-nav="arrangement"]')
          const pressed = seg.querySelector('button[aria-pressed="true"]')
          out.steps.write = {
            puts,
            pressedIsSubscription: pressed && pressed.textContent === 'memArrSubscription',
          }
          out.containers = {}
          for (const width of [380, 1200]) {
            const host = document.getElementById(`app-${width}`)
            out.containers[width] = {
              paneOverflow: host.scrollWidth - host.clientWidth,
              segMinHeight: Math.min(...[...host.querySelectorAll('[data-nav="arrangement"] button')]
                .map(b => b.getBoundingClientRect().height)),
            }
          }
        })
        done()
      } catch (error) { out.error = String(error && error.stack || error); done() }
    })()
  }, 1500)
} catch (error) { out.error = String(error && error.stack || error); done() }
