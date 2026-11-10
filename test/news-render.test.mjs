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

// --- WP11: model-first group rendering ---------------------------------------

/** Items shaped like the real /news payload, grouped by the production helper. */
const groupFrom = (items) => T.newsGroupModels(items).groups[0]

const groupItem = (over = {}) => ({
  id: 'g1', origin: 'local', category: 'price_reduction',
  provider: 'Anthropic', model: 'claude-sonnet-4-5-20250929',
  summary: 'Rate change.', summary_code: 'news_sum_price_change',
  summary_params: { model: 'claude-sonnet-4-5-20250929', provider: 'Anthropic', input: '$4.00', output: '$25.00' },
  previous: { input: 5.0, output: 25.0, cache_read: 0.5, cache_write: 6.25 },
  current: { input: 4.0, output: 25.0, cache_read: 0.4, cache_write: 6.25 },
  has_tiers: false, conditions: '', conditions_code: '',
  observed_at: '2026-11-03T00:00:00Z', effective_at: '2026-11-03T00:00:00Z',
  source_url: 'https://example.com/pricing', provenance: 'Hermes models.dev cache',
  confidence: 'observed', related_routes: ['acme/claude-sonnet-4-5'],
  relevance: { relevant: true, reasons: ['used_model'] },
  ...over,
})

const renderNode = async (element, locale) => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = ReactDOMClient.createRoot(container)
  roots.push(root)
  const show = async (nextLocale) => {
    await React.act(async () => {
      root.render(React.cloneElement(element, { t: translator(nextLocale) }))
    })
  }
  await show(locale)
  return { container, text: () => container.textContent, show }
}

test('a model group renders the friendly name over the exact ID, EN', async () => {
  const group = groupFrom([
    groupItem({ id: 'g1' }),
    groupItem({ id: 'g0', provider: 'Bedrock', model_name: 'Claude Sonnet 4.5',
      observed_at: '2026-11-04T00:00:00Z' }),
    groupItem({ id: 'g-old', observed_at: '2026-11-01T00:00:00Z' }),
  ])
  const { container, text } = await renderNode(
    React.createElement(T.NewsModelGroup, { group, impacts: { g0: { basis: 'full', delta_usd: -3.10, window_days: 30 } },
      t: translator('en'), matchedOffers: null, detailsId: 'wg1' }), 'en')
  const heading = container.querySelector('h3')
  assert.equal(heading.firstChild.textContent, 'Claude Sonnet 4.5', 'friendly name is primary')
  assert.equal(heading.querySelector('.wm-news-groupid').textContent, 'claude-sonnet-4-5-20250929',
    'the exact model ID sits underneath in mono')
  assert.match(text(), /For you because it matches a model you used\./)
  const down = container.querySelector('.wm-news-chip[data-tone="down"]')
  assert.match(down.textContent, /Input −20%/)
  assert.match(container.textContent, /Output ±0%|Output unchanged/)
  const badge = container.querySelector('.wm-news-badge[data-class]')
  assert.equal(badge.textContent, 'Price down')
  const impact = container.querySelector('.wm-news-offerimpact')
  assert.match(impact.textContent, /Hypothetical API-equivalent/)
  assert.match(impact.textContent, /not a bill or guaranteed saving/)
  assert.doesNotMatch(impact.textContent, /save|charged|billed/)
})

test('group details open, show the audit trail and History, in both locales', async () => {
  const group = groupFrom([
    groupItem({ id: 'g1' }),
    groupItem({ id: 'g-old', observed_at: '2026-11-01T00:00:00Z',
      relevance: { relevant: false, reasons: [] } }),
  ])
  for (const [locale, dir, source] of [['en', /Price down/, /Source/], ['zh', /价格下调/, /来源/]]) {
    T.$newsDetailsOpen.set([])
    const node = React.createElement(T.NewsModelGroup, { group, impacts: {}, t: translator(locale),
      matchedOffers: null, detailsId: `wd-${locale}` })
    const view = await renderNode(node, locale)
    assert.match(view.container.querySelector('.wm-news-badge[data-class]').textContent, dir)
    const button = view.container.querySelector('button.wm-news-details')
    assert.equal(button.getAttribute('aria-expanded'), 'false')
    assert.ok(button.getAttribute('aria-controls'), 'the button names its panel')
    const panelBefore = view.container.querySelector('.wm-news-detailspanel')
    assert.equal(panelBefore.id, button.getAttribute('aria-controls'))
    assert.ok(panelBefore.hidden)
    await React.act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const panel = view.container.querySelector('.wm-news-detailspanel')
    assert.equal(button.getAttribute('aria-expanded'), 'true')
    assert.ok(!panel.hidden)
    assert.ok(panel.querySelector('.wm-news-rates'), 'the was/now rate table is present')
    assert.match(panel.textContent, /Observed|观察于/)
    assert.match(panel.textContent, source)
    assert.match(panel.textContent, /g1/)
    const history = panel.querySelector('.wm-news-history')
    assert.ok(history, 'History lists older events')
    assert.match(history.textContent, /g-old/)
    assert.ok(history.querySelector('a[href="https://example.com/pricing"]'), 'history keeps its source link')
  }
})

test('a group without model_name shows the exact ID alone', async () => {
  const group = groupFrom([groupItem({ id: 'g1', model_name: '' })])
  const { container } = await renderNode(
    React.createElement(T.NewsModelGroup, { group, impacts: {}, t: translator('en'),
      matchedOffers: null, detailsId: 'wn1' }), 'en')
  const heading = container.querySelector('h3')
  assert.equal(heading.textContent, 'claude-sonnet-4-5-20250929')
  assert.equal(heading.querySelector('.wm-news-groupid'), null, 'no duplicated ID line')
})

test('the same group renders translated Chinese and keeps the ID unchanged', async () => {
  const group = groupFrom([
    groupItem({ id: 'g1', model_name: 'Claude Sonnet 4.5' }),
  ])
  const { container, text } = await renderNode(
    React.createElement(T.NewsModelGroup, { group, impacts: { g1: { basis: 'full', delta_usd: -3.10, window_days: 30 } },
      t: translator('zh'), matchedOffers: null, detailsId: 'wz1' }), 'zh')
  const heading = container.querySelector('h3')
  assert.equal(heading.firstChild.textContent, 'Claude Sonnet 4.5', 'proper names stay untranslated')
  assert.equal(heading.querySelector('.wm-news-groupid').textContent, 'claude-sonnet-4-5-20250929')
  assert.match(container.querySelector('.wm-news-badge[data-class]').textContent, /价格下调/)
  assert.match(container.querySelector('.wm-news-chip[data-tone="down"]').textContent, /输入 −20%/)
  const impact = container.querySelector('.wm-news-offerimpact')
  assert.match(impact.textContent, /假设的 API 等效估算/)
  assert.match(impact.textContent, /并非账单/)
  assert.match(text(), /匹配您用过的模型/)
})

test('the scope control carries the persistent selected ring markup', async () => {
  const { container } = await renderNode(
    React.createElement(T.NewsScopeTabs, { scope: 'foryou', forYouCount: 3, allCount: 8,
      t: translator('en'), onChange: () => {} }), 'en')
  const buttons = [...container.querySelectorAll('button')]
  assert.equal(buttons.length, 2)
  assert.equal(buttons[0].getAttribute('aria-pressed'), 'true')
  assert.equal(buttons[1].getAttribute('aria-pressed'), 'false')
  assert.match(buttons[0].textContent, /For You/)
  assert.match(buttons[0].textContent, /3 groups/, 'scope counts are labelled as groups')
  assert.match(buttons[1].textContent, /8 updates/, 'the All count is labelled too')
  assert.match(T.NEWS_CSS, /wm-news-controls \[aria-pressed="true"\][^}]*outline:2px solid var\(--ui-accent\)/,
    'the ring rule is page-local CSS, weight 600')
})
