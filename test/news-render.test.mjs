// Run: node --test test/
//
// Model News localisation rendering — real React, synthetic fixtures.
// Renders NewsCard directly with coded backend items in both locales.
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

const work = mkdtempSync(join(tmpdir(), 'wm-news-'))
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
const { plugin, T, React, ReactDOMClient, queryClient } = lib
const translator = locale => (key, ...args) => {
  const entry = T.I18N[locale][key]
  return typeof entry === 'function' ? entry(...args) : entry ?? key
}

plugin.register({
  rest: async () => ({ ok: true }),
  storage: { get: (_k, d) => d, set() {}, delete() {} },
  register() {}, registerMany() {}, onDispose() {}, onEvent: () => () => {},
  setTimeout: (fn) => { const t = setTimeout(fn, 0); return () => clearTimeout(t) },
  setInterval: () => () => {},
  addEventListener: () => () => {},
  os: {}, pet: null, i18n: { register() {}, t: key => key },
})

const roots = []
const renderCard = async (item, impact, locale) => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = ReactDOMClient.createRoot(container)
  roots.push(root)
  const show = async (nextLocale) => {
    await React.act(async () => {
      root.render(React.createElement(T.NewsCard, { item, impact, t: translator(nextLocale) }))
    })
  }
  await show(locale)
  return { container, text: () => container.textContent, show }
}

after(() => { queryClient.clear(); dom.window.close() })
test.afterEach(async () => {
  while (roots.length) {
    const root = roots.pop()
    try { await React.act(async () => { root.unmount() }) } catch { /* already gone */ }
  }
  queryClient.clear()
})

const codedItem = () => ({
  id: 'n1', origin: 'local', category: 'price_reduction',
  provider: 'Acme', model: 'm1',
  summary: 'm1 (Acme) reduced to $1.00/$2.00 per MTok in/out.',
  summary_code: 'news_sum_price_change',
  summary_params: { model: 'm1', provider: 'Acme', input: '$1.00', output: '$2.00' },
  previous: { input: 3.0, output: 15.0, cache_read: null, cache_write: null },
  current: { input: 1.0, output: 2.0, cache_read: null, cache_write: null },
  has_tiers: false,
  observed_at: '2026-11-04T00:00:00Z', effective_at: '',
  source_url: '', confidence: 'observed', provenance: 'Hermes models.dev cache',
  conditions: 'Tiered/context pricing changed; base rates compared.',
  conditions_code: 'news_cond_tiers_changed',
})
const codedImpact = () => ({
  basis: 'partial', reason: 'cache rates unavailable for comparison; cache tokens excluded',
  reason_codes: ['news_impact_cache_excluded'],
  window_days: 30, tokens: { input: 1, output: 1, cache_read: 0, cache_write: 0 },
  calls: 1, old_usd: 3.0, new_usd: 1.5, delta_usd: -1.5,
})

test('a coded news card renders backend-identical English', async () => {
  const { container, text } = await renderCard(codedItem(), codedImpact(), 'en')
  assert.equal(container.querySelector('.wm-news-summary').textContent,
    'm1 (Acme) reduced to $1.00/$2.00 per MTok in/out.')
  assert.equal(container.querySelector('.wm-news-conditions').textContent,
    'Tiered/context pricing changed; base rates compared.')
  assert.match(text(), /Partial API-equivalent estimate/)
  assert.match(text(), /cache rates unavailable for comparison; cache tokens excluded/)
})

test('the same card renders translated Chinese and keeps proper names', async () => {
  const { container, text } = await renderCard(codedItem(), codedImpact(), 'zh')
  const summary = container.querySelector('.wm-news-summary').textContent
  assert.ok(summary.includes('m1') && summary.includes('Acme'), 'model and provider names are preserved')
  assert.ok(summary.includes('降至'), 'the price verb is translated')
  assert.ok(!summary.includes('reduced to'))
  assert.ok(!container.querySelector('.wm-news-conditions').textContent.includes('Tiered/context'))
  assert.match(text(), /部分 API 等效估算/)
  assert.match(text(), /缓存价格无法对比/)
})

test('items without codes keep their raw English in both locales', async () => {
  const legacy = { ...codedItem(), summary_code: '', summary_params: null,
    conditions_code: '', conditions: 'Curator note stays English.' }
  const legacyImpact = { ...codedImpact(), reason_codes: null,
    reason: 'a future reason the client does not know' }
  for (const locale of ['en', 'zh']) {
    const { container, text } = await renderCard(legacy, legacyImpact, locale)
    assert.equal(container.querySelector('.wm-news-summary').textContent, legacy.summary)
    assert.equal(container.querySelector('.wm-news-conditions').textContent,
      'Curator note stays English.')
    assert.match(text(), /a future reason the client does not know/)
  }
})

test('switching locales never persists translated labels', async () => {
  const item = codedItem()
  const impact = codedImpact()
  const card = await renderCard(item, impact, 'en')
  const before = card.text()
  assert.match(before, /reduced to/)
  await card.show('zh')
  assert.match(card.text(), /降至/)
  assert.doesNotMatch(card.text(), /reduced to/)
  await card.show('en')
  assert.equal(card.text(), before, 'returning to English restores byte-identical output')
})
