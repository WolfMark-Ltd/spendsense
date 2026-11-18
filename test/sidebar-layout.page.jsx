import React from 'react'
import { createRoot } from 'react-dom/client'
import plugin, { __test as T } from '../desktop/plugin.js'
import { host, queryClient, QueryClientProvider, i18nBackend } from '@hermes/plugin-sdk'

const params = new URLSearchParams(location.search)
const tooltipInteraction = params.get('tooltipInteraction')
const coverageInteraction = params.get('coverageInteraction')
const preservePosition = params.get('preservePosition') === 'true'
const locale = params.get('locale') === 'zh-CN' ? 'zh' : 'en'
const scope = params.get('scope') || 'conversation'
const exactModelId = 'deepseek/deepseek-v4.1-flash'
const provider = 'commandcode'
const prompt = 600000
const state = params.get('state') || 'partial'
const saved = state === 'unavailable' ? null : state === 'zero' ? 0 : state === 'negative' ? -0.42 : 12.35
const coverage = state === 'partial' ? 0.7 : state === 'unavailable' ? 0 : 1
const covered = Math.round(prompt * coverage)

const translate = (key, ...args) => {
  if (typeof key === 'function') return ''
  const value = T.I18N[locale][key]
  return typeof value === 'function' ? value(...args) : value ?? key
}
i18nBackend.t = translate

plugin.register({
  rest: async () => ({ ok: true }),
  storage: { get: (_key, fallback) => fallback, set() {}, delete() {} },
  register() {}, registerMany() {}, onDispose() {}, onEvent: () => () => {},
  setTimeout: fn => { const timer = setTimeout(fn, 0); return () => clearTimeout(timer) },
  setInterval: () => () => {}, addEventListener: () => () => {},
  os: {}, pet: null, i18n: { register() {}, t: translate },
})

const ledger = T.emptyLedger()
if (scope === 'conversation') ledger.sessions.layout = {
  input: 80000, output: 10000, cacheRead: 500000, cacheWrite: 20000, calls: 26,
  pricedTokens: 610000, unpricedTokens: 0, unpricedCalls: 0, missingUsageCalls: 0,
  cost: 1.23, sources: { bundled: 610000 }, model: exactModelId, provider,
  foreignSlug: null, cacheEstimated: false,
  cacheCoveredPrompt: prompt, cacheCoveredRead: 500000,
  cacheExactPrompt: prompt, cacheEstimatedPrompt: 0,
  netSavingsPrompt: covered, netSavings: saved, firstAt: Date.now() - 3600_000,
}
T.$ledger.set(ledger)
T.$ledgerReadError.set(false)
T.$automaticModelOptions.set(false)
T.$ratesOpen.set(false)
T.$infoOpen.set(null)
T.resetStableLive()
host.state.focusedSessionId.set('layout')
host.state.focusedStoredSessionId.set(scope === 'conversation' ? 'layout' : null)
host.state.focusedUsage.set(scope === 'conversation' ? null : {
  model: exactModelId, input: 100000, prompt, output: 10000,
  cache_read: 500000, cache_write: 0, calls: 1,
})
host.state.model.set(exactModelId)

const configs = params.has('all')
  ? ['dark', 'light'].flatMap(theme => [650, 800].flatMap(height => [268, 350, 500]
    .map(width => ({ id: `${width}-${height}-${theme}`, width, height, theme }))))
  : [{
      id: params.get('case') || '268-700-dark',
      width: Number(params.get('width')) || 268,
      height: Number(params.get('height')) || 700,
      theme: params.get('theme') || 'dark',
    }]

const rootNode = document.getElementById('sidebar-layout-cases')
const mounted = []
for (const config of configs) {
  const node = document.createElement('div')
  node.className = `case ${config.theme}`
  node.dataset.case = config.id
  node.style.width = `${config.width}px`
  node.style.height = `${config.height}px`
  rootNode.appendChild(node)
  const root = createRoot(node)
  mounted.push(root)
  root.render(React.createElement(QueryClientProvider, { client: queryClient },
    React.createElement(T.Meter)))
}
if (configs.length === 1) {
  document.body.dataset.single = configs[0].theme
  document.body.style.background = configs[0].theme === 'dark' ? '#12141a' : '#fff'
}

const rect = node => {
  const r = node.getBoundingClientRect()
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }
}
const overlaps = (a, b) => a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1
const inside = (outer, inner) => inner.left >= outer.left - 1 && inner.top >= outer.top - 1
  && inner.right <= outer.right + 1 && inner.bottom <= outer.bottom + 1

setTimeout(async () => {
  const modelIdButton = rootNode.querySelector('.wm-model-name-row .wm-info-btn[aria-controls="wm-info-model-id"]')
  const modelIdDisclosures = {}
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
  const recordModelIdDisclosure = mode => {
    const popover = document.getElementById('wm-info-model-id')
    modelIdDisclosures[mode] = {
      found: !!modelIdButton,
      expanded: modelIdButton?.getAttribute('aria-expanded') === 'true',
      text: popover?.textContent || '',
      trigger: modelIdButton ? rect(modelIdButton) : null,
      popover: popover ? rect(popover) : null,
      offsetParent: popover?.offsetParent?.className || '',
    }
  }
  if (modelIdButton && ['hover', 'focus', 'both'].includes(tooltipInteraction)) {
    if (tooltipInteraction === 'hover' || tooltipInteraction === 'both') {
      modelIdButton.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true, view: window }))
      await wait(120)
      recordModelIdDisclosure('hover')
    }
    if (tooltipInteraction === 'both') {
      modelIdButton.dispatchEvent(new MouseEvent('mouseout', {
        bubbles: true, cancelable: true, relatedTarget: document.body, view: window,
      }))
      await wait(60)
    }
    if (tooltipInteraction === 'focus' || tooltipInteraction === 'both') {
      modelIdButton.focus()
      await wait(120)
      recordModelIdDisclosure('focus')
    }
    if (tooltipInteraction === 'both') {
      modelIdButton.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
      await wait(60)
    }
  }
  const coverageButton = rootNode.querySelector('.wm-info-btn[aria-controls="wm-info-cache-coverage"]')
  const coverageDisclosure = {}
  if (coverageButton && ['hover', 'focus', 'click'].includes(coverageInteraction)) {
    if (coverageInteraction === 'hover') {
      coverageButton.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true, view: window }))
    } else if (coverageInteraction === 'focus') {
      coverageButton.focus()
    } else {
      coverageButton.click()
    }
    await wait(120)
    const popover = document.getElementById('wm-info-cache-coverage')
    coverageDisclosure.found = !!coverageButton
    coverageDisclosure.expanded = coverageButton.getAttribute('aria-expanded') === 'true'
    coverageDisclosure.label = coverageButton.getAttribute('aria-label') || ''
    coverageDisclosure.tabIndex = coverageButton.tabIndex
    coverageDisclosure.describedBy = coverageButton.getAttribute('aria-describedby') || ''
    coverageDisclosure.text = popover?.textContent || ''
    coverageDisclosure.trigger = rect(coverageButton)
    coverageDisclosure.popover = popover ? rect(popover) : null
    coverageDisclosure.offsetParent = popover?.offsetParent?.className || ''
    if (coverageInteraction === 'focus' || coverageInteraction === 'click') {
      coverageButton.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
      await wait(60)
    }
  }
  const layouts = [...rootNode.querySelectorAll('.case')].map(node => {
    const pane = node.querySelector('.wm-pane')
    const scrollTopBefore = pane?.scrollTop || 0
    if (pane && !preservePosition) pane.scrollTop = pane.scrollHeight
    const scrollTopAfter = pane?.scrollTop || 0
    const paneRect = pane ? rect(pane) : null
    const openSpendSenseButton = node.querySelector('.wm-open-ledger')
    const openSpendSenseRect = openSpendSenseButton ? rect(openSpendSenseButton) : null
    const paneClientRect = pane && paneRect ? {
      left: paneRect.left, top: paneRect.top,
      right: paneRect.left + pane.clientWidth, bottom: paneRect.top + pane.clientHeight,
    } : null
    const model = node.querySelector('.wm-model')
    const modelNameRow = node.querySelector('.wm-model-name-row')
    const tooltipMetrics = [...node.querySelectorAll('.wm-info-btn')].map(button => ({
      hitWidth: rect(button).width,
      hitHeight: rect(button).height,
      ringWidth: parseFloat(getComputedStyle(button, '::after').width),
      glyphFontSize: parseFloat(getComputedStyle(button.querySelector('.wm-info-glyph')).fontSize),
    }))
    const providerBadge = node.querySelector('.wm-provider-badge')
    const write = node.querySelector('.wm-mix-fill[data-part="write"]')
    const productTitle = node.querySelector('.wm-meter-brandrow .wm-meter-name')
    const statusRow = node.querySelector('.wm-meter-statusrow')
    const savedRow = node.querySelector('.wm-gauge-stat[data-kind="saved"]')
    const savedLabel = savedRow?.querySelector('.wm-metric-label')
    const savedValue = savedRow?.querySelector('.wm-metric-value')
    const savedNote = node.querySelector('.wm-gauge-note')
    const gaugeCard = savedRow?.closest('.wm-card')
    const labelRect = rect(savedLabel)
    const valueRect = rect(savedValue)
    const noteRect = rect(savedNote)
    const gaugeRect = rect(gaugeCard)
    return {
      id: node.dataset.case,
      width: node.clientWidth,
      height: pane?.clientHeight || 0,
      scrollHeight: pane?.scrollHeight || 0,
      scrollDelta: Math.max(0, (pane?.scrollHeight || 0) - (pane?.clientHeight || 0)),
      scrollTopBefore,
      scrollTopAfter,
      openSpendSenseVisible: !!openSpendSenseRect && !!paneClientRect && inside(paneClientRect, openSpendSenseRect),
      horizontalOverflow: Math.max(0, (pane?.scrollWidth || 0) - (pane?.clientWidth || 0)),
      model: model?.textContent || '',
      modelId: model?.title || '',
      modelOverflow: model ? Math.max(0, model.scrollWidth - model.clientWidth) : -1,
      productTitle: productTitle?.textContent || '',
      productTitleOverflow: productTitle ? Math.max(0, productTitle.scrollWidth - productTitle.clientWidth) : -1,
      productTitleOwnRow: !!productTitle && !!statusRow && productTitle.parentElement.nextElementSibling === statusRow,
      tooltipMetrics,
      writePaint: write ? getComputedStyle(write).backgroundColor : null,
      writeWidth: write ? rect(write).width : 0,
      provider: providerBadge?.textContent || '',
      providerOverflow: providerBadge ? Math.max(0, providerBadge.scrollWidth - providerBadge.clientWidth) : -1,
      providerSeparate: !!modelNameRow && modelNameRow.nextElementSibling === providerBadge,
      ringWidth: rect(node.querySelector('.wm-ring')).width,
      savedLabel: savedLabel?.textContent || '',
      savedValue: savedValue?.textContent || '',
      savedNote: savedNote?.textContent || '',
      labelOverflow: savedLabel ? Math.max(0, savedLabel.scrollWidth - savedLabel.clientWidth) : -1,
      valueOverflow: savedValue ? Math.max(0, savedValue.scrollWidth - savedValue.clientWidth) : -1,
      noteOverflow: savedNote ? Math.max(0, savedNote.scrollWidth - savedNote.clientWidth) : -1,
      labelValueOverlap: overlaps(labelRect, valueRect),
      contentsWithinCard: inside(gaugeRect, labelRect) && inside(gaugeRect, valueRect) && inside(gaugeRect, noteRect),
      openSpendSense: node.querySelector('.wm-open-ledger')?.textContent || '',
    }
  })
  document.getElementById('sidebar-layout-result').textContent = JSON.stringify({
    errors: window.__sidebarErrors || [], locale, state, scope, tooltipInteraction, coverageInteraction,
    modelIdDisclosures, coverageDisclosure,
    layouts,
  })
}, 350)

window.addEventListener('error', event => {
  (window.__sidebarErrors = window.__sidebarErrors || []).push(String(event.message || event.error))
})
