import React from 'react'
import { createRoot } from 'react-dom/client'
import plugin, { __test as T } from '../desktop/plugin.js'
import { host, queryClient, QueryClientProvider, i18nBackend } from '@hermes/plugin-sdk'

const params = new URLSearchParams(location.search)
const locale = params.get('locale') === 'zh-CN' ? 'zh' : 'en'
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
ledger.sessions.layout = {
  input: 100000, output: 10000, cacheRead: 500000, cacheWrite: 0, calls: 26,
  pricedTokens: 610000, unpricedTokens: 0, unpricedCalls: 0, missingUsageCalls: 0,
  cost: 1.23, sources: { bundled: 610000 }, model: exactModelId, provider,
  foreignSlug: null, cacheEstimated: false, cacheSource: 'exact',
  cacheCoveredPrompt: covered, cacheCoveredRead: Math.round(500000 * coverage),
  cacheExactPrompt: covered, cacheEstimatedPrompt: 0,
  netSavingsPrompt: covered, netSavings: saved, firstAt: Date.now() - 3600_000,
}
T.$ledger.set(ledger)
T.$ledgerReadError.set(false)
T.$automaticModelOptions.set(false)
T.$ratesOpen.set(false)
T.$infoOpen.set(null)
T.resetStableLive()
host.state.focusedSessionId.set('layout')
host.state.focusedStoredSessionId.set('layout')
host.state.focusedUsage.set(null)
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

setTimeout(() => {
  const layouts = [...rootNode.querySelectorAll('.case')].map(node => {
    const pane = node.querySelector('.wm-pane')
    const model = node.querySelector('.wm-model')
    const modelNameRow = node.querySelector('.wm-model-name-row')
    const tooltipMetrics = [...node.querySelectorAll('.wm-info-btn')].map(button => ({
      hitWidth: rect(button).width,
      hitHeight: rect(button).height,
      ringWidth: parseFloat(getComputedStyle(button, '::after').width),
      glyphFontSize: parseFloat(getComputedStyle(button).fontSize),
    }))
    const providerBadge = node.querySelector('.wm-provider-badge')
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
      horizontalOverflow: Math.max(0, (pane?.scrollWidth || 0) - (pane?.clientWidth || 0)),
      model: model?.textContent || '',
      modelId: model?.title || '',
      modelOverflow: model ? Math.max(0, model.scrollWidth - model.clientWidth) : -1,
      tooltipMetrics,
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
    errors: window.__sidebarErrors || [], locale, state, layouts,
  })
}, 350)

window.addEventListener('error', event => {
  (window.__sidebarErrors = window.__sidebarErrors || []).push(String(event.message || event.error))
})
