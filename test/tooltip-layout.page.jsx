import React from 'react'
import { createRoot } from 'react-dom/client'
import plugin, { __test as T } from '../desktop/plugin.js'
import { calls, navigations } from './tooltip-layout.sdk.mjs'

const locale = globalThis.__tooltipLocale || 'en'
globalThis.__tooltipDict = T.I18N[locale] || T.I18N.en
const dict = globalThis.__tooltipDict
const t = key => (typeof dict[key] === 'function' ? `[fn:${key}]` : dict[key]) || key

const out = { locale }
const done = () => {
  out.hostCalls = calls.length
  out.navigations = navigations.length
  document.getElementById('tooltip-layout-result').textContent = JSON.stringify(out)
}

try {
  const root = createRoot(document.getElementById('app'))
  root.render(React.createElement(React.Fragment, null,
    React.createElement('div', { id: 'pane-wrap' }, React.createElement(T.Meter, {})),
    React.createElement('div', { id: 'product-case' },
      React.createElement(T.ProductShell, {
        children: React.createElement('main', { className: 'wm-shell' },
          React.createElement(T.BudgetPanel, {}),
          React.createElement('div', { id: 'edge-right-row', style: { display: 'flex', justifyContent: 'flex-end' } },
            React.createElement(T.InfoTip, { id: 'wp02-edge-right', label: t('infoLabel'), text: t('ratesNote') })),
          React.createElement('div', { style: { height: '560px' } }),
          React.createElement('div', { id: 'edge-bottom-row', style: { display: 'flex', justifyContent: 'flex-end' } },
            React.createElement(T.InfoTip, { id: 'wp02-edge-bottom', label: t('infoLabel'), text: t('budgetHelp') })))
      }))))
  setTimeout(() => {
    try {
      const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
      const fire = (el, type, init) => el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ...init }))
      const rectOf = el => {
        const r = el.getBoundingClientRect()
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }
      }
      const opaque = pop => {
        const bg = getComputedStyle(pop).backgroundColor
        out.lastBackground = bg
        const m = bg.match(/rgba?\(([^)]+)\)/)
        const parts = m ? m[1].split(',').map(s => s.trim()) : []
        return parts.length === 3 || (parts.length === 4 && Number(parts[3]) === 1)
      }
      const within = (inner, outer) => inner.left >= outer.left - 1 && inner.right <= outer.right + 1
        && inner.top >= outer.top - 1 && inner.bottom <= outer.bottom + 1
      const viewport = () => ({ left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight })

      const exerciseTip = async (scopeEl, scopeRect, id, { scrollFirst = null } = {}) => {
        const result = {}
        const btn = scopeEl.querySelector(`.wm-info-btn[aria-controls="wm-info-${id}"]`)
        result.buttonFound = !!btn
        if (!btn) return result
        // Bring the trigger into view so viewport assertions are meaningful;
        // scope assertions hold regardless of page scroll.
        if (scrollFirst) scrollFirst()
        else btn.scrollIntoView({ block: 'center', inline: 'center' })
        await wait(40)
        result.buttonBox = { width: btn.offsetWidth, height: btn.offsetHeight }
        const scroller = btn.closest('.wm-analytics,.wm-pane')
        const sw0 = scroller ? scroller.scrollWidth : 0
        const sh0 = scroller ? scroller.scrollHeight : 0
        // Hover opens and dismisses without moving focus.
        fire(btn, 'mouseover')
        await wait(80)
        let pop = document.getElementById(`wm-info-${id}`)
        result.hoverOpened = !!pop
        result.focusMovedOnHover = document.activeElement === btn
        if (pop) {
          const r = rectOf(pop)
          result.popRect = r
          result.text = pop.textContent.slice(0, 80)
          result.opaque = opaque(pop)
          result.withinScope = within(r, scopeRect())
          // Client box: with classic (non-overlay) scrollbars the visible
          // content box is narrower than the border box, and scrollable
          // overflow is measured against it — the gutter counts as overflow.
          const outer = scopeRect()
          const client = {
            left: outer.left, top: outer.top,
            right: outer.left + (scroller ? scroller.clientWidth : outer.width),
            bottom: outer.top + (scroller ? scroller.clientHeight : outer.height),
          }
          result.withinClientScope = within(r, client)
          result.withinViewport = within(r, viewport())
          result.scrollWidthDelta = (scroller ? scroller.scrollWidth : 0) - sw0
          result.scrollHeightDelta = (scroller ? scroller.scrollHeight : 0) - sh0
        }
        fire(btn, 'mouseout', { relatedTarget: document.body })
        await wait(60)
        result.hoverClosed = !document.getElementById(`wm-info-${id}`)
        // Keyboard focus opens; Escape on the button closes and keeps focus.
        btn.focus()
        await wait(60)
        result.focusedButton = document.activeElement === btn
        pop = document.getElementById(`wm-info-${id}`)
        result.tooltipOpened = !!pop
        if (pop) {
          result.focusPopRect = rectOf(pop)
          result.focusWithinScope = within(rectOf(pop), scopeRect())
        }
        btn.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
        await wait(60)
        result.escapeClosed = !document.getElementById(`wm-info-${id}`)
        result.focusRetained = document.activeElement === btn
        result.expandedAfterEscape = btn.getAttribute('aria-expanded') === 'false'
        // Hover-opened with focus elsewhere in the scope: Escape on another
        // element dismisses the tip through the scope capture handler.
        fire(btn, 'mouseover')
        await wait(80)
        result.reopened = !!document.getElementById(`wm-info-${id}`)
        const other = scopeEl.querySelector('h1,h2,.wm-kpi-figure,.wm-card-title') || scopeEl
        other.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
        await wait(60)
        result.scopeEscapeClosed = !document.getElementById(`wm-info-${id}`)
        result.navigations = navigations.length
        fire(btn, 'mouseout', { relatedTarget: document.body })
        await wait(40)
        if (document.activeElement && document.activeElement.blur) document.activeElement.blur()
        return result
      }
      ;(async () => {
        const pane = document.querySelector('.wm-pane')
        out.paneFound = !!pane
        if (!pane) return done()
        const paneRect = rectOf(pane)
        out.paneWidth = Math.round(paneRect.width)
        const product = document.querySelector('#product-case .wm-analytics')
        out.productFound = !!product
        const productRect = product ? rectOf(product) : null
        out.productWidth = product ? Math.round(productRect.width) : 0
        out.viewportWidth = window.innerWidth
        out.tooltips = {}
        for (const id of ['cost-source', 'cache-method', 'savings-method', 'rates-source']) {
          out.tooltips[id] = await exerciseTip(pane, () => rectOf(pane), id)
        }
        if (product) {
          const shell = document.querySelector('#product-case')
          out.tooltips['budgets-overview'] = await exerciseTip(shell, () => rectOf(product), 'budgets-overview')
          out.tooltips['wp02-edge-right'] = await exerciseTip(shell, () => rectOf(product), 'wp02-edge-right')
          out.tooltips['wp02-edge-bottom'] = await exerciseTip(shell, () => rectOf(product), 'wp02-edge-bottom', {
            scrollFirst: () => {
              const btn = shell.querySelector('.wm-info-btn[aria-controls="wm-info-wp02-edge-bottom"]')
              if (btn) btn.scrollIntoView({ block: 'end' })
            },
          })
          out.tooltips['wp02-edge-bottom'].productScroll = {
            scrollWidth: product.scrollWidth, clientWidth: product.clientWidth,
            scrollHeight: product.scrollHeight, clientHeight: product.clientHeight,
          }
        }
        // Locale markers: real dictionary copy behind the shared tips.
        out.markers = {
          rates: typeof dict.ratesNote === 'string' ? dict.ratesNote.slice(0, 24) : '',
          budget: typeof dict.budgetHelp === 'string' ? dict.budgetHelp.slice(0, 16) : '',
          info: dict.infoLabel || '',
        }
        // Screenshot mode: leave one tip open for visual evidence.
        const shotId = new URLSearchParams(location.search).get('shot')
        if (shotId) {
          const btn = document.querySelector(`.wm-info-btn[aria-controls="wm-info-${shotId}"]`)
          if (btn) {
            btn.scrollIntoView({ block: 'center' })
            await wait(60)
            btn.focus()
            await wait(120)
            out.shot = { id: shotId, opened: !!document.getElementById(`wm-info-${shotId}`) }
          }
        }
        done()
      })().catch(error => { out.error = String(error); done() })
    } catch (error) { out.error = String(error); done() }
  }, 300)
} catch (error) { out.error = String(error); done() }
