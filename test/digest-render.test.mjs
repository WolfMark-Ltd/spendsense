// Run: node --test --test-force-exit test/*.test.mjs
//
// Local digest rendering and Reports page regressions — real React with a
// mocked transport. Must stay a separate file from test/digest.test.mjs:
// tests registered after the harness's late top-level await are silently
// dropped by the runner when both loaders share one module.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const HARNESS_MODULES = join(ROOT, 'test', 'harness', 'node_modules')

if (!existsSync(join(HARNESS_MODULES, '@tanstack', 'react-query'))) {
  throw new Error('real-query harness is not installed: run `npm ci --prefix test/harness`')
}

const work = mkdtempSync(join(tmpdir(), 'wm-dg-'))
process.on('exit', () => rmSync(work, { recursive: true, force: true }))

const entry = join(work, 'entry.mjs')
writeFileSync(entry, `
export { default as plugin, __test as T } from '${join(ROOT, 'desktop', 'plugin.js')}'
export * as React from 'react'
export * as ReactDOMClient from 'react-dom/client'
export { QueryClientProvider, queryClient, host, $testConnectionId, $testProfile, gatewayActivationEpoch, i18nCalls, i18nBackend } from '@hermes/plugin-sdk'
`)
const bundle = join(work, 'bundle.mjs')
const esbuild = (await import(pathToFileURL(join(HARNESS_MODULES, 'esbuild', 'lib', 'main.js')).href)).default
await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: bundle,
  alias: {
    '@hermes/plugin-sdk': join(ROOT, 'test', 'harness', 'real-sdk.mjs'),
    react: join(HARNESS_MODULES, 'react'),
    'react-dom': join(HARNESS_MODULES, 'react-dom'),
  },
  nodePaths: [HARNESS_MODULES],
  logLevel: 'warning',
})

const { JSDOM } = await import(pathToFileURL(join(HARNESS_MODULES, 'jsdom', 'lib', 'api.js')).href)
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/' })
const define = (name, value) => Object.defineProperty(globalThis, name, {
  value, configurable: true, writable: true,
})
define('window', dom.window)
define('document', dom.window.document)
define('navigator', dom.window.navigator)
define('HTMLElement', dom.window.HTMLElement)
define('Node', dom.window.Node)
define('FormData', dom.window.FormData)
define('MouseEvent', dom.window.MouseEvent)
define('Event', dom.window.Event)
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const lib = await import(pathToFileURL(bundle).href)
const { plugin, T, React, ReactDOMClient, QueryClientProvider, queryClient,
  host, $testConnectionId, $testProfile, i18nCalls, i18nBackend } = lib
const enT = (key, ...args) => {
  const entry = T.I18N.en[key]
  return typeof entry === 'function' ? entry(...args) : entry ?? key
}
const zhT = (key, ...args) => {
  const entry = T.I18N.zh[key]
  return typeof entry === 'function' ? entry(...args) : entry ?? key
}
i18nBackend.t = enT

const digestFixture = (days = 30, lang = 'en') => {
  const zh = lang === 'zh'
  const periodLabel = zh ? `过去 ${days} 天（2026-10-01 → 2026-10-31 UTC）`
    : `Last ${days} days (2026-10-01 → 2026-10-31 UTC)`
  return {
  ok: true, generated_at: '2026-10-31T12:00:00Z', days, lang,
  title: zh ? 'SpendSense 摘要' : 'SpendSense digest',
  period: { label: periodLabel, start: '2026-10-01T00:00:00Z', end: '2026-10-31T00:00:00Z', timezone: 'UTC' },
  sections: [
    { id: 'usage', heading: zh ? '用量' : 'Usage', window: periodLabel, kind: 'lines',
      lines: [{ label: zh ? '调用' : 'Calls', value: '3' }],
      notes: [] },
    { id: 'models', heading: zh ? '按已定价 API 等值小计排名的模型' : 'Top models by priced API-equivalent subtotal',
      window: periodLabel, kind: 'table',
      columns: [zh ? '模型' : 'Model', zh ? '调用' : 'Calls', zh ? 'Token' : 'Tokens', zh ? 'API 等值' : 'API-equiv'],
      rows: [['m', '2', '2.00M', '$4.00'], ['<img src=x onerror=alert(1)>', '1', '1.00M', '$2.00']],
      notes: [] },
    { id: 'value', heading: zh ? '用量价值' : 'Usage value', window: periodLabel, kind: 'lines',
      lines: [{ label: zh ? 'API 等值' : 'API-equivalent value', value: '$5.00' }], notes: [] },
    { id: 'allowances', heading: zh ? '当前额度状态' : 'Current allowance status',
      window: zh ? '当前额度周期（截至 2026-10-31）' : 'Current allowance cycle, as of 2026-10-31',
      kind: 'table', columns: [zh ? '账号' : 'Account', zh ? '计算的周期结束日期' : 'Calculated cycle end', zh ? '状态' : 'Status'],
      rows: [['Synthetic account', '2026-11-01', zh ? '未知' : 'Unknown']],
      notes: [zh ? '没有服务商读数或手动标记。' : 'No provider reading or manual mark is available.'] },
    { id: 'methodology', heading: zh ? '方法说明' : 'Methodology', window: '', kind: 'notes', lines: [],
      notes: [zh ? '本地生成。' : 'Local only.'] },
  ],
  markdown: `# SpendSense digest\n\n- **Calls:** 3\n\nFull-report evidence and caveats remain in the Markdown export.\n`,
  filename: `spend-sense-digest-2026-10-31-${days}d-${lang}.md`,
  empty: false,
  }
}

const controller = () => {
  const calls = []
  let responder = () => ({ ok: true })
  return {
    calls,
    reset() { calls.length = 0; responder = () => ({ ok: true }) },
    respond(fn) { responder = fn },
    transport: (path, opts = {}) => {
      const call = { path, method: opts.method || 'GET', body: opts.body }
      calls.push(call)
      return Promise.resolve().then(() => responder(call))
    },
  }
}
const transportCtl = controller()
plugin.register({
  rest: transportCtl.transport,
  storage: { get: (_k, d) => d, set() {}, delete() {} },
  register() {}, registerMany() {}, onDispose() {}, onEvent: () => () => {},
  setTimeout: (fn) => { const t = setTimeout(fn, 0); return () => clearTimeout(t) },
  setInterval: () => () => {},
  addEventListener: () => () => {},
  os: {}, pet: null, i18n: { register() {}, t: key => key },
})

const roots = []
const renderPage = async () => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = ReactDOMClient.createRoot(container)
  roots.push(root)
  await React.act(async () => {
    root.render(React.createElement(QueryClientProvider, { client: queryClient },
      React.createElement(T.ReportsPage)))
  })
  return { container, text: () => container.textContent, root }
}
const disposePage = async root => {
  const index = roots.indexOf(root)
  if (index >= 0) roots.splice(index, 1)
  await React.act(async () => { root.unmount() })
}
const flush = async (times = 6) => {
  await React.act(async () => {
    for (let i = 0; i < times; i += 1) await new Promise(resolve => setTimeout(resolve, 0))
  })
}
const clickByText = async (container, label) => {
  const button = [...container.querySelectorAll('button')].find(b => (b.textContent || '').includes(label))
  assert.ok(button, `no button matching ${label}`)
  await React.act(async () => { button.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  return button
}
const digestCalls = () => transportCtl.calls.filter(call => call.path.startsWith('/reports/digest'))

after(() => { queryClient.clear(); dom.window.close() })
test.afterEach(async () => {
  while (roots.length) {
    const root = roots.pop()
    try { await React.act(async () => { root.unmount() }) } catch { /* already gone */ }
  }
  queryClient.clear()
  transportCtl.reset()
  T.$digestDays.set(30)
  T.$ledgerTab.set('overview')
  i18nBackend.t = enT
  i18nCalls.length = 0
})

const bootReports = async () => {
  queryClient.clear(); transportCtl.reset()
  $testConnectionId.set('gateway-a'); $testProfile.set('default')
  T.$digestDays.set(30)
  T.$ledgerTab.set('reports')
  transportCtl.respond(call => {
    const match = String(call.path).match(/days=(\d+).*lang=(\w+)/)
    return { ok: true, ...digestFixture(Number(match?.[1] || 30), match?.[2] || 'en') }
  })
  const rendered = await renderPage()
  await flush(4)
  await clickByText(rendered.container, 'Generate report')
  await flush(4)
  return rendered
}

test('the preview renders sections, tables and methodology disclosure', async () => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = ReactDOMClient.createRoot(container)
  roots.push(root)
  await React.act(async () => {
    root.render(React.createElement(T.DigestPreview, { report: digestFixture() }))
  })
  const text = container.textContent
  assert.match(text, /Usage/)
  assert.match(text, /Top models by priced API-equivalent subtotal/)
  assert.match(text, /At a glance/)
  assert.match(text, /Current allowance cycle, as of 2026-10-31/)
  assert.match(text, /\$5\.00/)
  assert.equal(container.querySelectorAll('.wm-digest-section').length, 5)
  assert.equal(container.querySelector('[data-section="models"] table tbody').querySelectorAll('tr').length, 2)
  assert.equal(container.querySelectorAll('.wm-digest-method').length, 1)
  assert.match(container.querySelector('.wm-digest-method summary').textContent, /Methodology/)
  assert.equal(container.querySelectorAll('.wm-digest-period').length, 1)
  assert.equal(container.querySelectorAll('.wm-digest-context').length, 1,
    'only the current allowance-cycle context is repeated below the reporting window')
  const modelsRegion = container.querySelector('[data-section="models"] [role="region"]')
  assert.equal(modelsRegion?.tabIndex, 0, 'wide table is reachable for keyboard scrolling')
  assert.equal(modelsRegion?.querySelectorAll('th[scope="col"]').length, 4)
  // Hostile model names render as friendly text, never elements, with the
  // exact slug kept in the title for provenance.
  assert.equal(container.querySelector('img'), null)
  const hostileCell = [...container.querySelectorAll('[data-section="models"] tbody td')]
    .find(cell => cell.getAttribute('title') === '<img src=x onerror=alert(1)>')
  assert.ok(hostileCell, 'exact model slug stays retrievable')
  assert.equal(hostileCell.textContent, T.modelDisplayName('<img src=x onerror=alert(1)>'))
})

test('value, spending and coverage sections keep their accent rails when host warning/error tokens are missing', async () => {
  const report = digestFixture()
  report.sections.push(
    { id: 'spending', heading: 'Metered and cash spending', window: report.period.label, kind: 'lines',
      lines: [{ label: 'Metered usage value (all cost rules)', value: '≥$5.38' }], notes: [] },
    { id: 'coverage', heading: 'Attribution and reconciliation', window: report.period.label, kind: 'lines',
      lines: [{ label: 'Attributed tokens', value: '518.85M' }], notes: [] },
  )
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = ReactDOMClient.createRoot(container)
  roots.push(root)
  await React.act(async () => {
    root.render(React.createElement(T.DigestPreview, { report }))
  })
  for (const [id, heading] of [['value', 'Usage value'], ['spending', 'Metered and cash spending'],
      ['coverage', 'Attribution and reconciliation']]) {
    const section = container.querySelector(`.wm-digest-section[data-section="${id}"]`)
    assert.ok(section, `${id} renders as an accent-railed section`)
    assert.match(section.querySelector('h3')?.textContent || '', new RegExp(heading))
  }
  // The native host theme leaves --ui-warning/--ui-error undefined, which
  // drops the rail declarations entirely. Fall back to the default section
  // accent so the rails survive, using only existing theme tokens.
  assert.match(T.REPORTS_CSS,
    /\.wm-digest-section\[data-section="value"\],\.wm-digest-section\[data-section="spending"\]\{--wm-digest-accent:var\(--ui-warning,var\(--ui-accent\)\)\}/)
  assert.match(T.REPORTS_CSS,
    /\.wm-digest-section\[data-section="coverage"\]\{--wm-digest-accent:var\(--ui-error,var\(--ui-accent\)\)\}/)
})

test('the reports page fetches and previews the digest', async () => {
  const { container, text } = await bootReports()
  assert.match(text(), /Reports/)
  assert.match(text(), /Generate report/)
  assert.match(text(), /Copy Markdown/)
  assert.match(text(), /Download Markdown/)
  assert.match(text(), /Usage/)
  assert.equal(container.querySelector('.wm-digest')?.textContent.match(/Last 30 days/g)?.length, 1,
    'the reporting period is shown once in the preview')
  assert.match(text(), /\$5\.00/)
  assert.equal(digestCalls().length, 1)
  assert.match(digestCalls()[0].path, /days=30/)
})

test('page entry fetches nothing until Generate', async () => {
  queryClient.clear(); transportCtl.reset()
  $testConnectionId.set('gateway-a'); $testProfile.set('default')
  T.$digestDays.set(30)
  T.$ledgerTab.set('reports')
  transportCtl.respond(() => ({ ok: true, ...digestFixture() }))
  const { container, text } = await renderPage()
  await flush(4)
  assert.equal(digestCalls().length, 0)
  assert.match(text(), /Choose a period, then Generate report\./)
  assert.doesNotMatch(text(), /\$5\.00/)
  await clickByText(container, 'Generate report')
  await flush(4)
  assert.equal(digestCalls().length, 1)
  assert.match(text(), /\$5\.00/)
})

test('switching period withholds the older report until Generate', async () => {
  const { container, text } = await bootReports()
  assert.match(text(), /Usage/)
  await React.act(async () => { T.$digestDays.set(7) })
  await flush(4)
  assert.equal(digestCalls().length, 1)
  assert.doesNotMatch(text(), /\$5\.00/)
  assert.match(text(), /Choose a period, then Generate report\./)
  const copy = [...container.querySelectorAll('button')].find(b => b.textContent === 'Copy Markdown')
  assert.equal(copy?.disabled, true)
  await clickByText(container, 'Generate report')
  await flush(4)
  assert.equal(digestCalls().length, 2)
  assert.match(digestCalls()[1].path, /days=7/)
  assert.match(text(), /\$5\.00/)
})

test('a failed refresh keeps the cached report behind a stale warning', async () => {
  const { container, text } = await bootReports()
  assert.match(text(), /Usage/)
  transportCtl.respond(() => { throw new Error('backend down') })
  await clickByText(container, 'Generate report')
  await flush(4)
  assert.equal(digestCalls().length, 2)
  assert.match(text(), /Refresh failed — showing the report generated 2026-10-31\./)
  assert.match(text(), /Usage/)
  assert.match(text(), /\$5\.00/)
  assert.equal(container.querySelector('.wm-digest-error'), null)
  assert.ok(container.querySelector('[role="alert"]'))
})

test('the reports page keeps the shared tab navigation', async () => {
  const { container } = await bootReports()
  const tabs = [...container.querySelectorAll('[role="tab"]')].map(tab => tab.getAttribute('aria-label'))
  assert.deepEqual(tabs, ['Overview', 'Usage', 'Costs', 'Memberships', 'Reports', 'Model News', 'Settings'])
  const pageRoot = container.firstElementChild
  const tablist = container.querySelector('[role="tablist"]')
  assert.ok(tablist, 'reports renders the tab bar')
  const contentShell = [...pageRoot.children].find(child => child.classList.contains('wm-shell'))
  assert.ok(tablist.parentElement === pageRoot && contentShell?.parentElement === pageRoot
    && [...pageRoot.children].indexOf(tablist) < [...pageRoot.children].indexOf(contentShell),
  'reports keeps navigation before the content shell at the product root')
  assert.equal(T.$ledgerTab.get(), 'reports')
  await clickByText(container, 'Costs')
  assert.equal(T.$ledgerTab.get(), 'costs')
})

test('7 and 30 day previews keep English and Chinese period and summary copy', async () => {
  for (const [locale, translator, expectedHeading] of [
    ['en', enT, 'Top models by priced API-equivalent subtotal'],
    ['zh', zhT, '按已定价 API 等值小计排名的模型'],
  ]) {
    i18nBackend.t = translator
    for (const days of [7, 30]) {
      queryClient.clear(); transportCtl.reset()
      $testConnectionId.set('gateway-a'); $testProfile.set('default')
      T.$digestDays.set(days)
      T.$ledgerTab.set('reports')
      transportCtl.respond(call => {
        const match = String(call.path).match(/days=(\d+).*lang=(\w+)/)
        return { ok: true, ...digestFixture(Number(match?.[1] || 30), match?.[2] || 'en') }
      })
      const { container, text } = await renderPage()
      await flush(4)
      await clickByText(container, locale === 'zh' ? '生成报告' : 'Generate report')
      await flush(4)
      const expectedPeriod = locale === 'zh' ? `过去 ${days} 天` : `Last ${days} days`
      const previewText = container.querySelector('.wm-digest')?.textContent || ''
      assert.match(text(), new RegExp(expectedHeading))
      assert.match(text(), new RegExp(expectedPeriod))
      assert.equal(previewText.match(new RegExp(expectedPeriod, 'g'))?.length, 1,
        `${locale}/${days} shows the reporting period once in the preview`)
      assert.equal(container.querySelectorAll('.wm-digest-period').length, 1)
      assert.ok(container.querySelector('.wm-digest-summary'))
      assert.ok(container.querySelector('[role="group"][aria-label="' +
        (locale === 'zh' ? '报告周期' : 'Report period') + '"]'))
      const actions = [...container.querySelectorAll('.wm-reports-actions button')]
      assert.equal(actions.length, 3)
      for (const button of actions) {
        button.focus()
        assert.equal(document.activeElement, button, `${locale}/${days} action is keyboard focusable`)
      }
      await disposePage(roots[roots.length - 1])
    }
  }
})

test('generate refetches the current digest', async () => {
  const { container } = await bootReports()
  assert.equal(digestCalls().length, 1)
  await clickByText(container, 'Generate report')
  await flush(4)
  assert.equal(digestCalls().length, 2)
})

test('copy writes the markdown and notifies success', async () => {
  const copied = []
  Object.defineProperty(window.navigator, 'clipboard', {
    value: { writeText: async text => { copied.push(text) } }, configurable: true,
  })
  const notices = []
  const originalNotify = host.notify
  host.notify = notice => notices.push(notice)
  try {
    const { container } = await bootReports()
    await clickByText(container, 'Copy Markdown')
    await flush(2)
    assert.equal(copied.length, 1)
    assert.match(copied[0], /# SpendSense digest/)
    assert.match(copied[0], /Full-report evidence and caveats remain/)
    assert.deepEqual(notices, [{ kind: 'success', message: 'Markdown report copied to the clipboard.' }])
    assert.equal(container.querySelector('[role="status"]')?.textContent,
      'Markdown report copied to the clipboard.')
  } finally {
    host.notify = originalNotify
    delete window.navigator.clipboard
  }
})

test('copy without a clipboard notifies failure', async () => {
  const notices = []
  const originalNotify = host.notify
  host.notify = notice => notices.push(notice)
  try {
    const { container } = await bootReports()
    await clickByText(container, 'Copy Markdown')
    await flush(2)
    assert.deepEqual(notices, [{ kind: 'error', message: 'Could not copy the Markdown report. Check clipboard access or download the report.' }])
    assert.equal(container.querySelector('[role="alert"]')?.textContent,
      'Could not copy the Markdown report. Check clipboard access or download the report.')
  } finally {
    host.notify = originalNotify
  }
})

test('late report action feedback is ignored after its period or connection changes', async () => {
  const originalClipboard = Object.getOwnPropertyDescriptor(window.navigator, 'clipboard')
  const originalNotify = host.notify
  const notices = []
  host.notify = notice => notices.push(notice)
  let resolveWrite
  Object.defineProperty(window.navigator, 'clipboard', {
    value: { writeText: () => new Promise(resolve => { resolveWrite = resolve }) }, configurable: true,
  })
  const resolvePendingWrite = async () => {
    assert.equal(typeof resolveWrite, 'function')
    await React.act(async () => { resolveWrite() })
    await flush(4)
  }
  try {
    const periodPage = await bootReports()
    await clickByText(periodPage.container, 'Copy Markdown')
    await React.act(async () => { T.$digestDays.set(7) })
    await flush(2)
    await resolvePendingWrite()
    assert.equal(periodPage.container.querySelector('.wm-report-feedback'), null)
    assert.deepEqual(notices, [], 'a completion for the old period is not announced')
    await disposePage(periodPage.root)

    const connectionPage = await bootReports()
    await clickByText(connectionPage.container, 'Copy Markdown')
    await React.act(async () => { $testConnectionId.set('gateway-b') })
    await flush(2)
    await resolvePendingWrite()
    assert.equal(connectionPage.container.querySelector('.wm-report-feedback'), null)
    assert.deepEqual(notices, [], 'a completion for the old connection is not announced')
  } finally {
    host.notify = originalNotify
    if (originalClipboard) Object.defineProperty(window.navigator, 'clipboard', originalClipboard)
    else delete window.navigator.clipboard
  }
})

test('download starts the markdown file and reports the filename', async () => {
  const { container } = await bootReports()
  const notices = []
  const downloads = []
  const originalNotify = host.notify
  const originalAnchorClick = window.HTMLAnchorElement.prototype.click
  host.notify = notice => notices.push(notice)
  window.HTMLAnchorElement.prototype.click = function () {
    downloads.push({ href: this.href, filename: this.download })
  }
  try {
    await clickByText(container, 'Download Markdown')
    await flush(2)
    assert.equal(downloads.length, 1)
    assert.match(downloads[0].href, /^blob:/)
    assert.equal(downloads[0].filename, 'spend-sense-digest-2026-10-31-30d-en.md')
    assert.deepEqual(notices, [{ kind: 'success',
      message: 'Markdown download requested: spend-sense-digest-2026-10-31-30d-en.md' }])
    assert.equal(container.querySelector('[role="status"]')?.textContent, notices[0].message)
  } finally {
    host.notify = originalNotify
    window.HTMLAnchorElement.prototype.click = originalAnchorClick
  }
})

test('download falls back to the clipboard when downloads fail', async () => {
  const copied = []
  Object.defineProperty(window.navigator, 'clipboard', {
    value: { writeText: async text => { copied.push(text) } }, configurable: true,
  })
  const originalCreate = URL.createObjectURL
  URL.createObjectURL = () => { throw new Error('no downloads') }
  const notices = []
  const originalNotify = host.notify
  host.notify = notice => notices.push(notice)
  try {
    const { container } = await bootReports()
    await clickByText(container, 'Download Markdown')
    await flush(2)
    assert.equal(copied.length, 1)
    assert.deepEqual(notices,
      [{ kind: 'info', message: 'Download could not start. The Markdown report was copied to the clipboard instead.' }])
    assert.equal(container.querySelector('[role="status"]')?.textContent, notices[0].message)
  } finally {
    host.notify = originalNotify
    URL.createObjectURL = originalCreate
    delete window.navigator.clipboard
  }
})

test('download and clipboard failure reports the failed destinations', async () => {
  const originalCreate = URL.createObjectURL
  URL.createObjectURL = () => { throw new Error('no downloads') }
  const notices = []
  const originalNotify = host.notify
  host.notify = notice => notices.push(notice)
  try {
    const { container } = await bootReports()
    await clickByText(container, 'Download Markdown')
    await flush(2)
    assert.deepEqual(notices,
      [{ kind: 'error', message: 'Could not download or copy the Markdown report.' }])
    assert.equal(container.querySelector('[role="alert"]')?.textContent,
      'Could not download or copy the Markdown report.')
  } finally {
    host.notify = originalNotify
    URL.createObjectURL = originalCreate
  }
})

test('a failed read offers retry', async () => {
  queryClient.clear(); transportCtl.reset()
  $testConnectionId.set('gateway-a'); $testProfile.set('default')
  T.$digestDays.set(30)
  T.$ledgerTab.set('reports')
  transportCtl.respond(() => { throw new Error('backend down') })
  const { container, text } = await renderPage()
  await flush(4)
  assert.equal(digestCalls().length, 0)
  await clickByText(container, 'Generate report')
  await flush(4)
  assert.match(text(), /Report unavailable for this connection\./)
  transportCtl.respond(() => ({ ok: true, ...digestFixture() }))
  await clickByText(container, 'Retry')
  await flush(4)
  assert.match(text(), /\$5\.00/)
})

test('a Chinese catalogue requests a Chinese digest', async () => {
  i18nBackend.t = zhT
  queryClient.clear(); transportCtl.reset()
  $testConnectionId.set('gateway-a'); $testProfile.set('default')
  T.$ledgerTab.set('reports')
  transportCtl.respond(call => {
    const match = String(call.path).match(/days=(\d+).*lang=(\w+)/)
    return { ok: true, ...digestFixture(Number(match?.[1] || 30), match?.[2] || 'en') }
  })
  const { container, text } = await renderPage()
  await flush(4)
  assert.equal(digestCalls().length, 0)
  assert.match(text(), /选择周期，然后生成报告。/)
  await clickByText(container, '生成报告')
  await flush(4)
  assert.match(text(), /报告/)
  assert.match(text(), /报告概览/)
  assert.match(text(), /按已定价 API 等值小计排名的模型/)
  assert.match(text(), /当前额度周期（截至 2026-10-31）/)
  assert.match(digestCalls()[0].path, /lang=zh/)
})

test('the reports stylesheet keeps controls visible', () => {
  assert.match(T.REPORTS_CSS, /\.wm-reports-bar/)
  assert.match(T.REPORTS_CSS, /position:sticky/)
  assert.match(T.REPORTS_CSS, /\.wm-digest-lines/)
  assert.match(T.REPORTS_CSS, /\.wm-digest-method/)
})

test('the period switch shows one persistent selected state', async () => {
  const { container } = await bootReports()
  const buttons = [...container.querySelectorAll('.wm-reports-period button')]
  assert.equal(buttons.length, 2)
  assert.deepEqual(buttons.map(button => button.textContent), ['Last 7 days', 'Last 30 days'])
  assert.equal(buttons[0].getAttribute('aria-pressed'), 'false')
  assert.equal(buttons[1].getAttribute('aria-pressed'), 'true')
  for (const button of buttons) {
    button.focus()
    assert.equal(document.activeElement, button, 'period option is keyboard focusable')
  }
  await React.act(async () => {
    buttons[0].dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  })
  await flush(4)
  assert.equal(T.$digestDays.get(), 7)
  const after = [...container.querySelectorAll('.wm-reports-period button')]
  assert.equal(after[0].getAttribute('aria-pressed'), 'true')
  assert.equal(after[1].getAttribute('aria-pressed'), 'false')
})

test('the period selected state survives in the stylesheet', () => {
  assert.match(T.REPORTS_CSS, /\.wm-reports-segbtn\[aria-pressed="true"\]/)
})

test('model and provider tables show friendly names with exact slugs', async () => {
  const report = digestFixture()
  report.sections.find(section => section.id === 'models').rows =
    [['deepseek/deepseek-v4-1-flash', '5', '1.00M', '$3.00']]
  report.sections.push({ id: 'providers', heading: 'Providers', window: report.period.label,
    kind: 'table', columns: ['Provider', 'Calls', 'Tokens', 'API-equiv'],
    rows: [['openai-codex', '5', '1.00M', '$3.00'], ['mystery-route', '1', '1.0k', '$0.01']],
    notes: [] })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = ReactDOMClient.createRoot(container)
  roots.push(root)
  await React.act(async () => {
    root.render(React.createElement(T.DigestPreview, { report }))
  })
  const modelCell = container.querySelector('[data-section="models"] tbody td')
  assert.equal(modelCell?.textContent, T.modelDisplayName('deepseek/deepseek-v4-1-flash'))
  assert.equal(modelCell?.getAttribute('title'), 'deepseek/deepseek-v4-1-flash')
  const providerCells = [...container.querySelectorAll('[data-section="providers"] tbody tr td:first-child')]
  assert.equal(providerCells.length, 2)
  assert.equal(providerCells[0].textContent, 'OpenAI Codex')
  assert.equal(providerCells[0].getAttribute('title'), 'openai-codex')
  assert.equal(providerCells[1].textContent, 'mystery-route')
  assert.equal(providerCells[1].getAttribute('title'), 'mystery-route')
})

const allowancesFixture = () => {
  const report = digestFixture()
  const allowances = report.sections.find(section => section.id === 'allowances')
  allowances.notes_first = true
  allowances.rows = [['A', '2026-12-01', '20', 'Unknown'], ['B', '2026-12-01', '20', 'Unknown']]
  allowances.row_meta = [
    { account_id: 'a', why: 'No provider reading or manual mark', link: 'memberships' },
    { account_id: 'b', why: 'Prepaid top-ups are not tracked', link: null },
  ]
  return report
}

test('all-unknown allowances lead with guidance and link fixable accounts', async () => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = ReactDOMClient.createRoot(container)
  roots.push(root)
  await React.act(async () => {
    root.render(React.createElement(T.DigestPreview, { report: allowancesFixture() }))
  })
  try {
    const section = container.querySelector('[data-section="allowances"]')
    const notes = section.querySelector('.wm-digest-notes')
    const details = section.querySelector('details')
    assert.ok(notes, 'guidance notes render')
    assert.ok(details, 'identical rows collapse behind a disclosure')
    assert.ok(notes.compareDocumentPosition(details) & Node.DOCUMENT_POSITION_FOLLOWING,
      'guidance leads the table')
    assert.match(details.querySelector('summary')?.textContent || '', /Account details \(2\)/)
    assert.equal(details.querySelectorAll('tbody tr').length, 2)
    assert.match(section.textContent, /No provider reading or manual mark/)
    assert.match(section.textContent, /Prepaid top-ups are not tracked/)
    const links = [...section.querySelectorAll('button')]
      .filter(button => button.textContent === 'Open in Memberships')
    assert.equal(links.length, 1, 'only the fixable row links out')
    await React.act(async () => {
      links[0].dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    })
    assert.equal(T.$ledgerTab.get(), 'memberships')
    assert.equal(T.$membershipTarget.get()?.accountId, 'a')
  } finally {
    T.$membershipTarget.set(null)
    T.$ledgerTab.set('overview')
  }
})

test('rule allowance gaps link to billing rules in Settings', async () => {
  const report = digestFixture()
  const allowances = report.sections.find(section => section.id === 'allowances')
  allowances.rows = [['C', '2026-12-01', '20', 'Unknown']]
  allowances.row_meta = [{ account_id: 'c', why: 'Allowance limit unavailable or unusable',
    link: 'settings' }]
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = ReactDOMClient.createRoot(container)
  roots.push(root)
  await React.act(async () => {
    root.render(React.createElement(T.DigestPreview, { report }))
  })
  const button = [...container.querySelectorAll('[data-section="allowances"] button')]
    .find(node => node.textContent === 'Open billing rules in Settings')
  assert.ok(button, 'rule gaps link to Settings billing rules')
  await React.act(async () => {
    button.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  })
  assert.equal(T.$ledgerTab.get(), 'settings')
  T.$ledgerTab.set('overview')
})

test('known allowances keep the table-first layout without actions', async () => {
  const report = digestFixture()
  const allowances = report.sections.find(section => section.id === 'allowances')
  allowances.notes_first = false
  allowances.rows = [['A', '2026-12-01', '20', 'On track']]
  allowances.row_meta = [{ account_id: 'a', why: null, link: null }]
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = ReactDOMClient.createRoot(container)
  roots.push(root)
  await React.act(async () => {
    root.render(React.createElement(T.DigestPreview, { report }))
  })
  const section = container.querySelector('[data-section="allowances"]')
  assert.equal(section.querySelector('details'), null)
  assert.equal(section.querySelectorAll('button').length, 0)
  const table = section.querySelector('table')
  const notes = section.querySelector('.wm-digest-notes')
  assert.ok(table && notes)
  assert.ok(table.compareDocumentPosition(notes) & Node.DOCUMENT_POSITION_FOLLOWING,
    'known rows keep the table before the notes')
})
