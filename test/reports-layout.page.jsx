import React from 'react'
import { createRoot } from 'react-dom/client'
import plugin, { __test as T } from '../desktop/plugin.js'
import {
  QueryClientProvider, queryClient, $testConnectionId, $testProfile, i18nBackend,
} from '@hermes/plugin-sdk'

const params = new URLSearchParams(location.search)
const locale = params.get('locale') === 'zh' ? 'zh' : 'en'
const days = Number(params.get('days')) === 7 ? 7 : 30
const theme = params.get('theme') === 'light' ? 'light' : 'dark'
const translations = T.I18N[locale]
const translate = (key, ...args) => {
  const value = translations[key]
  return typeof value === 'function' ? value(...args) : value ?? key
}
i18nBackend.t = translate

const period = locale === 'zh'
  ? `过去 ${days} 天（2026-11-04 → 2026-11-11 UTC）`
  : `Last ${days} days (2026-11-04 → 2026-11-11 UTC)`
const report = {
  ok: true, identity: 'gateway-a:default', generated_at: '2026-11-11T12:00:00Z',
  days, lang: locale, period: { label: period },
  sections: [
    { id: 'usage', heading: locale === 'zh' ? '用量' : 'Usage', window: period, kind: 'lines',
      lines: [{ label: locale === 'zh' ? '调用' : 'Calls', value: '1234' }], notes: [] },
    { id: 'models', heading: locale === 'zh' ? '按已定价 API 等值小计排名的模型' : 'Top models by priced API-equivalent subtotal',
      window: period, kind: 'table',
      columns: locale === 'zh' ? ['模型', '调用', 'Token', 'API 等值'] : ['Model', 'Calls', 'Tokens', 'API-equiv'],
      rows: [['synthetic-long-model-name-to-check-narrow-report-table-wrapping', '1234', '3.14M', '$143.61']],
      notes: [] },
    { id: 'value', heading: locale === 'zh' ? '用量价值（API 等值）' : 'Usage value (API-equivalent)',
      window: period, kind: 'lines',
      lines: [{ label: locale === 'zh' ? 'API 等值' : 'API-equivalent value', value: '≥$143.61' }],
      notes: [locale === 'zh' ? 'API 等值是理论公开价格，不是账单。' : 'API-equivalent value is a theoretical public price, not an invoice.'] },
    { id: 'spending', heading: locale === 'zh' ? '计量与现金支出' : 'Metered and cash spending',
      window: locale === 'zh' ? '当前计费周期' : 'Current billing cycles', kind: 'lines', lines: [
        { label: locale === 'zh' ? '计量（额度）支出' : 'Metered (allowance) spending', value: '—' },
      ], notes: [locale === 'zh' ? '部分调用缺少计费分类证据。' : 'Some calls lack billing classification evidence.'] },
    { id: 'allowances', heading: locale === 'zh' ? '当前额度状态' : 'Current allowance status',
      window: locale === 'zh' ? '当前额度周期（截至 2026-11-11）' : 'Current allowance cycle, as of 2026-11-11',
      kind: 'table',
      columns: locale === 'zh' ? ['账号', '计算的周期结束日期', '计算的剩余天数', '状态']
        : ['Account', 'Calculated cycle end', 'Calculated days left', 'Status'],
      rows: [['Synthetic account', '2026-12-01', '20', locale === 'zh' ? '未知' : 'Unknown']],
      notes: [locale === 'zh'
        ? '没有服务商读数或手动标记；本地用量不能替代服务商用量。'
        : 'No provider reading or manual mark is available; local usage is not provider consumption.'] },
    { id: 'methodology', heading: locale === 'zh' ? '方法说明' : 'Methodology', window: '', kind: 'notes',
      notes: [locale === 'zh' ? '完整证据保留在 Markdown 导出中。' : 'Full evidence remains in the Markdown export.'] },
  ],
  markdown: '# Synthetic report\n\nFull evidence and caveats.\n',
  filename: `spend-sense-digest-2026-11-11-${days}d-${locale}.md`, empty: false,
}

plugin.register({
  rest: async path => String(path).startsWith('/reports/digest') ? report : { ok: true },
  storage: { get: (_key, fallback) => fallback, set() {}, delete() {} },
  register() {}, registerMany() {}, onDispose() {}, onEvent: () => () => {},
  setTimeout: fn => { const timer = setTimeout(fn, 0); return () => clearTimeout(timer) },
  setInterval: () => () => {}, addEventListener: () => () => {}, os: {}, pet: null,
  i18n: { register() {}, t: key => key },
})

$testConnectionId.set('gateway-a')
$testProfile.set('default')
T.$digestDays.set(days)
T.$ledgerTab.set('reports')
document.body.dataset.theme = theme
const host = document.getElementById('reports-layout-host')
const root = createRoot(host)
root.render(React.createElement(QueryClientProvider, { client: queryClient },
  React.createElement(T.ReportsPage)))

const errors = []
window.addEventListener('error', event => errors.push(event.message))
const tick = ms => new Promise(resolve => setTimeout(resolve, ms))

async function measure() {
  await tick(80)
  const generate = [...host.querySelectorAll('.wm-reports-actions button')]
    .find(button => button.textContent.includes(translate('rpGenerate')))
  generate?.click()
  await tick(180)
  const shell = host.querySelector('.wm-shell.wm-reports')
  const toolbar = host.querySelector('.wm-reports-bar')
  const actions = [...host.querySelectorAll('.wm-reports-actions button')]
  const actionRects = actions.map(button => button.getBoundingClientRect())
  const actionOverlap = []
  for (let left = 0; left < actionRects.length; left += 1) {
    for (let right = left + 1; right < actionRects.length; right += 1) {
      const a = actionRects[left]; const b = actionRects[right]
      if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) {
        actionOverlap.push([left, right])
      }
    }
  }
  const digest = host.querySelector('.wm-digest')
  const summary = host.querySelector('.wm-digest-summary')
  const tableRegions = [...host.querySelectorAll('.wm-digest-table-wrap')].map(node => ({
    width: node.clientWidth, scroll: node.scrollWidth, tabIndex: node.tabIndex,
  }))
  const result = {
    errors, locale, theme, days, viewport: window.innerWidth,
    pageScroll: document.documentElement.scrollWidth,
    shellWidth: shell?.clientWidth || 0, shellScroll: shell?.scrollWidth || 0,
    toolbarWidth: toolbar?.clientWidth || 0, toolbarScroll: toolbar?.scrollWidth || 0,
    actionWidths: actions.map(button => button.clientWidth),
    actionOverflow: actions.map(button => button.scrollWidth - button.clientWidth),
    actionOverlap, summaryColumns: getComputedStyle(summary).gridTemplateColumns.split(' ').length,
    statOverflow: [...host.querySelectorAll('.wm-digest-stat strong')]
      .map(node => node.scrollWidth - node.clientWidth),
    sectionOverflow: [...host.querySelectorAll('.wm-digest-section')]
      .map(node => node.scrollWidth - node.clientWidth),
    tableRegions, previewPeriodCount: digest?.textContent.split(period).length - 1,
    feedbackGroup: host.querySelector('[role="group"][aria-label="' + translate('rpActions') + '"]') !== null,
    downloadLabel: actions[2]?.textContent || '', text: digest?.textContent || '',
  }
  document.getElementById('reports-layout-result').textContent = JSON.stringify(result)
}

measure().catch(error => {
  errors.push(String(error))
  document.getElementById('reports-layout-result').textContent = JSON.stringify({ errors })
})
