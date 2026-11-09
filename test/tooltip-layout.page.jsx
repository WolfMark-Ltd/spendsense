import React from 'react'
import { createRoot } from 'react-dom/client'
import plugin, { __test as T } from '../desktop/plugin.js'
import { calls } from './tooltip-layout.sdk.mjs'

const out = {}
const done = () => {
  out.hostCalls = calls.length
  document.getElementById('tooltip-layout-result').textContent = JSON.stringify(out)
}

try {
  const root = createRoot(document.getElementById('app'))
  root.render(React.createElement(T.Meter, {}))
  setTimeout(() => {
    try {
      const pane = document.querySelector('.wm-pane')
      const btn = document.querySelector('.wm-info-btn[aria-controls="wm-info-rates-source"]')
      out.paneFound = !!pane
      out.ratesSourceButtonFound = !!btn
      if (!pane || !btn) return done()
      const paneRect = pane.getBoundingClientRect()
      out.paneWidth = Math.round(paneRect.width)
      btn.focus()
      out.focusedButton = document.activeElement === btn
      setTimeout(() => {
        try {
          const pop = document.querySelector('.wm-info-pop')
          out.tooltipOpened = !!pop
          if (pop) {
            const r = pop.getBoundingClientRect()
            out.popRect = { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }
            out.paneRect = { left: paneRect.left, right: paneRect.right, top: paneRect.top, bottom: paneRect.bottom }
            out.ratesSourceTooltip = pop.id === 'wm-info-rates-source'
            const bg = getComputedStyle(pop).backgroundColor
            out.backgroundColor = bg
            const m = bg.match(/rgba?\(([^)]+)\)/)
            const parts = m ? m[1].split(',').map(s => s.trim()) : []
            out.opaque = parts.length === 3 || (parts.length === 4 && Number(parts[3]) === 1)
            out.withinPane = r.left >= paneRect.left && r.right <= paneRect.right
              && r.top >= paneRect.top && r.bottom <= paneRect.bottom
          }
          btn.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
          setTimeout(() => {
            // The pane-level handler also dismisses on Escape; either way the
            // popover must be gone and focus must remain usable.
            out.escapeClosed = !document.querySelector('.wm-info-pop')
            out.focusRetained = document.activeElement === btn
            out.expandedAfterEscape = btn.getAttribute('aria-expanded') === 'false'
            done()
          }, 50)
        } catch (error) { out.error = String(error); done() }
      }, 50)
    } catch (error) { out.error = String(error); done() }
  }, 300)
} catch (error) { out.error = String(error); done() }
