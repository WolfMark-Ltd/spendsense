import React from 'react'
import { createRoot } from 'react-dom/client'
import plugin, { __test as T } from '../desktop/plugin.js'
import { host, queryClient, QueryClientProvider, i18nBackend } from '@hermes/plugin-sdk'

const params = new URLSearchParams(location.search)
const tooltipInteraction = params.get('tooltipInteraction')
const readBenefitInteraction = params.get('readBenefitInteraction')
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
  rest: async path => {
    if (String(path).startsWith('/session/summary?') && ['known', 'partial', 'unavailable'].includes(state)) {
      const totalCalls = state === 'partial' ? 30 : 26
      const readCalls = state === 'partial' ? 21 : 26
      const valuation = {
        api_equivalent_usd: 1.23, api_equivalent_basis: 'exact',
        savings_usd: state === 'unavailable' ? null : 5.4,
        savings_usd_high: null, savings_basis: state === 'unavailable' ? 'indeterminate' : 'exact',
        coverage: state === 'partial' ? 0.8 : 1,
        covered_calls: state === 'partial' ? 21 : 26, excluded_calls: state === 'partial' ? 9 : 0,
        cache_hit_rate: 0.83, cache_hit_rate_basis: 'all_calls',
      }
      if (state !== 'unavailable') Object.assign(valuation, {
        read_benefit_usd: 12.35, read_benefit_basis: 'exact',
        read_benefit_calls: readCalls, read_benefit_tokens: 500000,
      })
      return {
        ok: true, session_id: 'layout',
        population: { requested: 'all', satisfied: true, separable: false },
        totals: { calls: totalCalls, input_tokens: 80000, output_tokens: 10000,
          prompt_tokens: 600000, cache_read_tokens: 500000, cache_write_tokens: 20000,
          cache_read_state: 'reported', cache_write_state: 'reported', unpriced_tokens: 0 },
        valuation,
      }
    }
    return { ok: true }
  },
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
  const readBenefitButton = rootNode.querySelector('.wm-gauge-stat[data-kind="saved"] .wm-info-btn')
  const readBenefitDisclosure = {}
  if (readBenefitButton && ['hover', 'focus', 'click'].includes(readBenefitInteraction)) {
    if (readBenefitInteraction === 'hover') {
      readBenefitButton.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true, view: window }))
    } else if (readBenefitInteraction === 'focus') {
      readBenefitButton.focus()
    } else {
      readBenefitButton.click()
    }
    await wait(120)
    const popover = document.getElementById('wm-info-read-benefit')
    readBenefitDisclosure.found = !!readBenefitButton
    readBenefitDisclosure.focused = document.activeElement === readBenefitButton
    readBenefitDisclosure.expanded = readBenefitButton.getAttribute('aria-expanded') === 'true'
    readBenefitDisclosure.label = readBenefitButton.getAttribute('aria-label') || ''
    readBenefitDisclosure.tabIndex = readBenefitButton.tabIndex
    readBenefitDisclosure.describedBy = readBenefitButton.getAttribute('aria-describedby') || ''
    readBenefitDisclosure.text = popover?.textContent || ''
    readBenefitDisclosure.trigger = rect(readBenefitButton)
    readBenefitDisclosure.popover = popover ? rect(popover) : null
    readBenefitDisclosure.offsetParent = popover?.offsetParent?.className || ''
    if (readBenefitInteraction === 'focus' || readBenefitInteraction === 'click') {
      readBenefitButton.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
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
    const scopeChip = node.querySelector('.wm-scope-chip')
    const savedRow = node.querySelector('.wm-gauge-stat[data-kind="saved"]')
    const savedLabel = savedRow?.querySelector('.wm-metric-label')
    const savedValue = savedRow?.querySelector('.wm-metric-value')
    const costFigure = node.querySelector('.wm-kpi-figure')
    const savedNote = node.querySelector('.wm-gauge-stats .wm-gauge-note')
    const gaugeCard = savedRow?.closest('.wm-card')
    const labelRect = rect(savedLabel)
    const valueRect = rect(savedValue)
    const noteRect = savedNote ? rect(savedNote) : null
    const gaugeRect = rect(gaugeCard)
    const statusRect = rect(statusRow)
    const scopeRect = rect(scopeChip)
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
      scopeLabel: scopeChip?.textContent || '',
      scopeOverflow: scopeChip ? Math.max(0, scopeChip.scrollWidth - scopeChip.clientWidth) : -1,
      scopeContained: !!statusRow && !!scopeChip && inside(statusRect, scopeRect),
      tooltipMetrics,
      writePaint: write ? getComputedStyle(write).backgroundColor : null,
      writeWidth: write ? rect(write).width : 0,
      provider: providerBadge?.textContent || '',
      providerOverflow: providerBadge ? Math.max(0, providerBadge.scrollWidth - providerBadge.clientWidth) : -1,
      providerSeparate: !!modelNameRow && modelNameRow.nextElementSibling === providerBadge,
      ringWidth: rect(node.querySelector('.wm-ring')).width,
      savedLabel: savedLabel?.textContent || '',
      savedValue: savedValue?.textContent || '',
      savedValueFontSize: savedValue ? parseFloat(getComputedStyle(savedValue).fontSize) : 0,
      savedValueColor: savedValue ? getComputedStyle(savedValue).color : null,
      costFigureFontSize: costFigure ? parseFloat(getComputedStyle(costFigure).fontSize) : 0,
      costFigureColor: costFigure ? getComputedStyle(costFigure).color : null,
      savedNote: savedNote?.textContent || '',
      labelOverflow: savedLabel ? Math.max(0, savedLabel.scrollWidth - savedLabel.clientWidth) : -1,
      valueOverflow: savedValue ? Math.max(0, savedValue.scrollWidth - savedValue.clientWidth) : -1,
      noteOverflow: savedNote ? Math.max(0, savedNote.scrollWidth - savedNote.clientWidth) : -1,
      labelValueOverlap: overlaps(labelRect, valueRect),
      contentsWithinCard: inside(gaugeRect, labelRect) && inside(gaugeRect, valueRect) && (!savedNote || inside(gaugeRect, noteRect)),
      readBenefitText: savedRow?.textContent || '',
      openSpendSense: node.querySelector('.wm-open-ledger')?.textContent || '',
    }
  })
  document.getElementById('sidebar-layout-result').textContent = JSON.stringify({
    errors: window.__sidebarErrors || [], locale, state, scope, tooltipInteraction, readBenefitInteraction,
    modelIdDisclosures, readBenefitDisclosure,
    layouts,
  })
}, 350)

window.addEventListener('error', event => {
  (window.__sidebarErrors = window.__sidebarErrors || []).push(String(event.message || event.error))
})
