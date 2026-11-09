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
      out.paneFound = !!pane
      if (!pane) return done()
      const paneRect = pane.getBoundingClientRect()
      out.paneWidth = Math.round(paneRect.width)
      out.viewportWidth = window.innerWidth
      const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
      const exerciseTip = async id => {
        const result = {}
        const btn = document.querySelector(`.wm-info-btn[aria-controls="wm-info-${id}"]`)
        result.buttonFound = !!btn
        if (!btn) return result
        btn.focus()
        await wait(50)
        result.focusedButton = document.activeElement === btn
        const pop = document.getElementById(`wm-info-${id}`)
        result.tooltipOpened = !!pop
        if (pop) {
          const r = pop.getBoundingClientRect()
          result.popRect = { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }
          result.paneRect = { left: paneRect.left, right: paneRect.right, top: paneRect.top, bottom: paneRect.bottom }
          const bg = getComputedStyle(pop).backgroundColor
          const m = bg.match(/rgba?\(([^)]+)\)/)
          const parts = m ? m[1].split(',').map(s => s.trim()) : []
          result.opaque = parts.length === 3 || (parts.length === 4 && Number(parts[3]) === 1)
          result.withinPane = r.left >= paneRect.left && r.right <= paneRect.right
            && r.top >= paneRect.top && r.bottom <= paneRect.bottom
        }
        btn.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
        await wait(50)
        result.escapeClosed = !document.getElementById(`wm-info-${id}`)
        result.focusRetained = document.activeElement === btn
        result.expandedAfterEscape = btn.getAttribute('aria-expanded') === 'false'
        return result
      }
      ;(async () => {
        out.tooltips = {}
        for (const id of ['cost-source', 'cache-method', 'savings-method', 'rates-source']) {
          out.tooltips[id] = await exerciseTip(id)
        }
        done()
      })().catch(error => { out.error = String(error); done() })
    } catch (error) { out.error = String(error); done() }
  }, 300)
} catch (error) { out.error = String(error); done() }
