// Run: node --test test/
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

const digestFixture = (days = 30, lang = 'en') => ({
  ok: true, generated_at: '2026-10-31T12:00:00Z', days, lang,
  title: lang === 'zh' ? 'Spend Sense 摘要' : 'Spend Sense digest',
  period: { label: `Last ${days} days`, start: '2026-10-01T00:00:00Z', end: '2026-10-31T00:00:00Z', timezone: 'UTC' },
  sections: [
    { id: 'usage', heading: 'Usage', window: `Last ${days} days`, kind: 'lines',
      lines: [{ label: 'Calls', value: '3' }, { label: 'API-equivalent value', value: '$5.00' }],
      notes: [] },
    { id: 'models', heading: 'Top models', window: `Last ${days} days`, kind: 'table',
      columns: ['Model', 'Calls', 'Tokens', 'API-equiv'],
      rows: [['m', '2', '2.00M', '$4.00'], ['<img src=x onerror=alert(1)>', '1', '1.00M', '$2.00']],
      notes: [] },
    { id: 'methodology', heading: 'Methodology', window: '', kind: 'notes', lines: [],
      notes: ['Local only.'] },
  ],
  markdown: `# Spend Sense digest\n\n- **Calls:** 3\n`,
  filename: `spend-sense-digest-2026-10-31-${days}d-${lang}.md`,
  empty: false,
})

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
  return { container, text: () => container.textContent }
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
  i18nBackend.t = enT
  i18nCalls.length = 0
})

const bootReports = async () => {
  queryClient.clear(); transportCtl.reset()
  $testConnectionId.set('gateway-a'); $testProfile.set('default')
  T.$digestDays.set(30)
  transportCtl.respond(call => {
    const match = String(call.path).match(/days=(\d+).*lang=(\w+)/)
    return { ok: true, ...digestFixture(Number(match?.[1] || 30), match?.[2] || 'en') }
  })
  const rendered = await renderPage()
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
  assert.match(text, /Top models/)
  assert.match(text, /\$5\.00/)
  assert.equal(container.querySelectorAll('.wm-digest-section').length, 2)
  assert.equal(container.querySelectorAll('.wm-digest-section table tbody tr').length, 2)
  assert.equal(container.querySelectorAll('.wm-digest-method').length, 1)
  assert.match(container.querySelector('.wm-digest-method summary').textContent, /Methodology/)
  // Hostile model names render as text, never elements.
  assert.equal(container.querySelector('img'), null)
  assert.match(text, /<img src=x onerror=alert\(1\)>/)
})

test('the reports page fetches and previews the digest', async () => {
  const { container, text } = await bootReports()
  assert.match(text(), /Reports/)
  assert.match(text(), /Generate report/)
  assert.match(text(), /Usage/)
  assert.match(text(), /\$5\.00/)
  assert.equal(digestCalls().length, 1)
  assert.match(digestCalls()[0].path, /days=30/)
})

test('switching period and generating refetch the digest', async () => {
  const { text } = await bootReports()
  assert.match(text(), /Usage/)
  await React.act(async () => { T.$digestDays.set(7) })
  await flush(4)
  assert.equal(digestCalls().length, 2)
  assert.match(digestCalls()[1].path, /days=7/)
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
    await clickByText(container, 'Copy')
    await flush(2)
    assert.equal(copied.length, 1)
    assert.match(copied[0], /# Spend Sense digest/)
    assert.deepEqual(notices, [{ kind: 'success', message: 'Report copied to the clipboard.' }])
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
    await clickByText(container, 'Copy')
    await flush(2)
    assert.deepEqual(notices, [{ kind: 'error', message: 'Report action failed.' }])
  } finally {
    host.notify = originalNotify
  }
})

test('save downloads the markdown file', async () => {
  const { container } = await bootReports()
  const notices = []
  const originalNotify = host.notify
  host.notify = notice => notices.push(notice)
  try {
    await clickByText(container, 'Save')
    await flush(2)
    assert.deepEqual(notices, [], 'a clean download notifies nothing')
  } finally {
    host.notify = originalNotify
  }
})

test('save falls back to the clipboard when downloads fail', async () => {
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
    await clickByText(container, 'Save')
    await flush(2)
    assert.equal(copied.length, 1)
    assert.deepEqual(notices,
      [{ kind: 'info', message: 'Download unavailable — report copied to the clipboard instead.' }])
  } finally {
    host.notify = originalNotify
    URL.createObjectURL = originalCreate
    delete window.navigator.clipboard
  }
})

test('a failed read offers retry', async () => {
  queryClient.clear(); transportCtl.reset()
  $testConnectionId.set('gateway-a'); $testProfile.set('default')
  T.$digestDays.set(30)
  transportCtl.respond(() => { throw new Error('backend down') })
  const { container, text } = await renderPage()
  await flush(4)
  assert.match(text(), /Report unavailable for this connection\./)
  transportCtl.respond(() => ({ ok: true, ...digestFixture() }))
  await clickByText(container, 'Retry')
  await flush(4)
  assert.match(text(), /Usage/)
})

test('a Chinese catalogue requests a Chinese digest', async () => {
  i18nBackend.t = zhT
  queryClient.clear(); transportCtl.reset()
  $testConnectionId.set('gateway-a'); $testProfile.set('default')
  transportCtl.respond(call => {
    const match = String(call.path).match(/days=(\d+).*lang=(\w+)/)
    return { ok: true, ...digestFixture(Number(match?.[1] || 30), match?.[2] || 'en') }
  })
  const { text } = await renderPage()
  await flush(4)
  assert.match(text(), /报告/)
  assert.match(text(), /生成报告/)
  assert.match(digestCalls()[0].path, /lang=zh/)
})

test('the reports stylesheet keeps controls visible', () => {
  assert.match(T.REPORTS_CSS, /\.wm-reports-bar/)
  assert.match(T.REPORTS_CSS, /position:sticky/)
  assert.match(T.REPORTS_CSS, /\.wm-digest-lines/)
  assert.match(T.REPORTS_CSS, /\.wm-digest-method/)
})
