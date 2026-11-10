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
const { plugin, T, React, ReactDOMClient, queryClient, QueryClientProvider, i18nBackend } = lib
// The full NewsPage reads its labels through the real i18n backend; point it
// at the English catalogue so page-level assertions see user-visible text.
i18nBackend.t = (key, ...args) => {
  const entry = T.I18N.en[key]
  return typeof entry === 'function' ? entry(...args) : entry ?? key
}
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
const renderCard = async (item, impact, locale, options = {}) => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = ReactDOMClient.createRoot(container)
  roots.push(root)
  const show = async (nextLocale) => {
    await React.act(async () => {
      root.render(React.createElement(T.NewsCard, { item, impact, t: translator(nextLocale), ...options }))
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
  assert.match(text(), /Partial hypothetical API-equivalent/)
  assert.match(text(), /not a bill or guaranteed saving/)
  assert.match(text(), /cache rates unavailable for comparison; cache tokens excluded/)
})

test('the same card renders translated Chinese and keeps proper names', async () => {
  const { container, text } = await renderCard(codedItem(), codedImpact(), 'zh')
  const summary = container.querySelector('.wm-news-summary').textContent
  assert.ok(summary.includes('m1') && summary.includes('Acme'), 'model and provider names are preserved')
  assert.ok(summary.includes('降至'), 'the price verb is translated')
  assert.ok(!summary.includes('reduced to'))
  assert.ok(!container.querySelector('.wm-news-conditions').textContent.includes('Tiered/context'))
  assert.match(text(), /部分假设的 API 等效估算/)
  assert.match(text(), /并非账单/)
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
  assert.equal(heading.querySelector('[data-news-model-name]').textContent, 'Claude Sonnet 4.5',
    'friendly name is primary')
  assert.equal(heading.querySelector('[data-news-model-id]').textContent, 'claude-sonnet-4-5-20250929',
    'the exact model ID sits underneath in mono')
  assert.match(text(), /Related update/,
    'the fuzzy used_model reason stays neutral, never "you used this model"')
  assert.doesNotMatch(text(), /matches a model you used|Used recently/)
  const down = container.querySelector('.wm-news-chip[data-tone="down"]')
  assert.match(down.textContent, /Input ▼ −20%/)
  assert.equal(down.getAttribute('data-news-chip'), 'input')
  assert.equal(down.getAttribute('data-news-dir'), 'down')
  assert.match(container.textContent, /Output ● unchanged/)
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
  assert.match(container.querySelector('.wm-news-chip[data-tone="down"]').textContent, /输入 ▼ −20%/)
  const impact = container.querySelector('.wm-news-offerimpact')
  assert.match(impact.textContent, /假设的 API 等效估算/)
  assert.match(impact.textContent, /并非账单/)
  assert.match(text(), /相关动态/)
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

// --- WP11 corrections: hooks, official rates, card kinds, NUL guard ----------

const hookGroup = () => {
  // A local/central pair with an identical transition and the same
  // observed_at merges into one event with two evidence sources; an older
  // event stays in History.
  const base = {
    category: 'price_reduction', provider: 'Anthropic', model: 'claude-sonnet-4-5-20250929',
    previous: { input: 5.0, output: 25.0, cache_read: 0.5, cache_write: 6.25 },
    current: { input: 4.0, output: 25.0, cache_read: 0.4, cache_write: 6.25 },
    has_tiers: false, observed_at: '2026-11-03T00:00:00Z', effective_at: '2026-11-03T00:00:00Z',
    relevance: { relevant: false, reasons: [] },
  }
  return T.newsGroupModels([
    { ...base, id: 'loc-1', origin: 'local', source_url: 'https://example.com/a',
      provenance: 'local snapshot' },
    { ...base, id: 'cen-1', origin: 'central', source_url: 'https://example.com/b',
      provenance: 'SpendSense announcements' },
    { ...base, id: 'old-1', origin: 'local', source_url: '',
      observed_at: '2026-11-01T00:00:00Z', effective_at: '' },
  ]).groups[0]
}

test('the group and offer markup carries the full DOM hook contract', async () => {
  T.$newsDetailsOpen.set([])
  const group = hookGroup()
  const view = await renderNode(React.createElement(T.NewsModelGroup, {
    group, impacts: { 'loc-1': { basis: 'partial', delta_usd: -1.5, window_days: 30, reason: '' } },
    t: translator('en'), matchedOffers: [0], detailsId: 'wh1' }), 'en')
  const c = view.container
  const card = c.querySelector('article[data-news-group]')
  assert.equal(card.getAttribute('data-news-group'), 'claude-sonnet-4-5-20250929')
  assert.equal(card.getAttribute('data-news-classes'), 'reduction')
  assert.equal(card.querySelector('[data-news-model-name]'), null,
    'model_name is absent, so the attribute is absent too')
  assert.equal(card.querySelector('[data-news-model-id]').textContent, 'claude-sonnet-4-5-20250929')
  const offer = card.querySelector('[data-news-offer]')
  assert.ok(offer, 'the offer row is marked')
  assert.equal(offer.getAttribute('data-news-provider'), 'Anthropic')
  assert.equal(offer.getAttribute('data-news-model'), 'claude-sonnet-4-5-20250929')
  assert.equal(offer.getAttribute('data-news-class'), 'reduction')
  assert.equal(offer.getAttribute('data-news-match'), 'true')
  const chip = offer.querySelector('[data-news-chip="input"]')
  assert.equal(chip.getAttribute('data-news-dir'), 'down')
  assert.equal(chip.getAttribute('data-news-reason'), null, 'comparable chips carry no reason')
  assert.ok(offer.querySelector('[data-news-chip="cache_read"]'))
  const impact = offer.querySelector('[data-news-impact]')
  assert.equal(impact.getAttribute('data-news-impact'), 'partial')
  const button = offer.querySelector('button[data-news-details]')
  assert.ok(button, 'the details button is marked')
  assert.equal(button.getAttribute('aria-expanded'), 'false')
  assert.ok(button.getAttribute('aria-controls'))
  const panel = offer.querySelector('[data-news-details-panel]')
  assert.equal(panel.id, button.getAttribute('aria-controls'))
  // Evidence sources of the merged event, each with its origin.
  await React.act(async () => { button.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
  const sources = [...panel.querySelectorAll('[data-news-source]')]
  assert.deepEqual(sources.map(el => el.getAttribute('data-news-source')), ['local', 'central'])
  assert.match(panel.textContent, /loc-1/)
  assert.match(panel.textContent, /cen-1/)
  assert.ok(panel.querySelector('a[href="https://example.com/a"]'), 'local evidence keeps its link')
  assert.ok(panel.querySelector('a[href="https://example.com/b"]'), 'central evidence keeps its link')
  const history = panel.querySelector('[data-news-history]')
  assert.ok(history, 'History is marked')
  const events = [...history.querySelectorAll('[data-news-event]')]
  assert.deepEqual(events.map(el => el.getAttribute('data-news-event')), ['old-1'],
    'History carries exact event ids; the merged event stays the live row')
  // No NUL anywhere in an attribute value.
  for (const el of c.querySelectorAll('*')) {
    for (const attr of el.attributes) {
      assert.ok(!attr.value.includes('\u0000'), `no NUL in ${attr.name}`)
    }
  }
})

test('not-comparable chips carry their reason; tiers render their status', async () => {
  const item = {
    id: 't1', origin: 'local', category: 'price_reduction', provider: 'P', model: 'm1',
    previous: { input: 5.0, output: 25.0, cache_read: null, cache_write: null },
    current: { input: 4.0, output: 25.0, cache_read: null, cache_write: null },
    has_tiers: true, observed_at: '2026-11-03T00:00:00Z', effective_at: '',
    source_url: '', provenance: '', confidence: 'observed',
    relevance: { relevant: false, reasons: [] },
  }
  const group = T.newsGroupModels([item]).groups[0]
  T.$newsDetailsOpen.set([])
  const view = await renderNode(React.createElement(T.NewsModelGroup, {
    group, impacts: {}, t: translator('en'), matchedOffers: null, detailsId: 'wt1' }), 'en')
  const tierChip = view.container.querySelector('[data-news-chip="tiers"]')
  assert.ok(tierChip, 'a tier signal renders a tier chip')
  assert.equal(tierChip.getAttribute('data-news-dir'), 'na')
  assert.equal(tierChip.getAttribute('data-news-reason'), 'tier_type_unknown')
  assert.match(tierChip.textContent, /Not comparable/)
})

test('comparable tier rows render per row, with a directional tier chip', async () => {
  const item = {
    id: 't2', origin: 'local', category: 'price_reduction', provider: 'P', model: 'm1',
    previous: { input: 5.0, output: 25.0, cache_read: null, cache_write: null },
    current: { input: 4.0, output: 25.0, cache_read: null, cache_write: null },
    has_tiers: true, tiers_detail: 'known',
    tiers_before: [{ type: 'up_to_200k', size: 200000, input: 2, output: 4 },
      { type: 'up_to_1m', size: 1000000, input: 1, output: 3 }],
    tiers_after: [{ type: 'up_to_200k', size: 200000, input: 1, output: 4 },
      { type: 'up_to_1m', size: 1000000, input: 1, output: 3 }],
    observed_at: '2026-11-03T00:00:00Z', effective_at: '', source_url: '',
    provenance: '', confidence: 'observed', relevance: { relevant: false, reasons: [] },
  }
  const group = T.newsGroupModels([item]).groups[0]
  T.$newsDetailsOpen.set([])
  const view = await renderNode(React.createElement(T.NewsModelGroup, {
    group, impacts: {}, t: translator('en'), matchedOffers: null, detailsId: 'wt2' }), 'en')
  const tierChip = view.container.querySelector('[data-news-chip="tiers"]')
  assert.equal(tierChip.getAttribute('data-news-dir'), 'down')
  assert.equal(tierChip.getAttribute('data-news-reason'), null)
  assert.match(tierChip.textContent, /−50%/, 'the largest comparable tier move, concise')
  const button = view.container.querySelector('button[data-news-details]')
  await React.act(async () => { button.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
  const rows = [...view.container.querySelectorAll('[data-news-details-panel] .wm-news-history li')]
  assert.equal(rows.length, 2, 'each tier row is listed separately')
  assert.match(rows[0].textContent, /up_to_200k/)
  assert.match(rows[0].textContent, /Input −50%/)
  assert.match(rows[1].textContent, /up_to_1m/)
  assert.match(rows[1].textContent, /unchanged/)
})

test('official rates render as text with every window as its own row, never a link', async () => {
  const item = {
    id: 'o1', origin: 'local', category: 'price_reduction', provider: 'P', model: 'm1',
    previous: { input: 5.0, output: null, cache_read: null, cache_write: null },
    current: { input: 4.0, output: null, cache_read: null, cache_write: null },
    has_tiers: false, observed_at: '2026-11-03T00:00:00Z', effective_at: '',
    source_url: '', provenance: '', confidence: 'observed',
    official: {
      verified_at: '2026-11-02T00:00:00Z',
      source_note: 'https://not-a-link.example pricing page snapshot',
      windows: [
        { days: 7, start_minute: 510, end_minute: 1020, input: 4, output: 20, cache_read: 0.4, cache_write: null },
        { days: 30, start_minute: 0, end_minute: 1439, input: 4, output: 20, cache_read: null, cache_write: 6 },
      ],
    },
    relevance: { relevant: false, reasons: [] },
  }
  const group = T.newsGroupModels([item]).groups[0]
  T.$newsDetailsOpen.set([])
  const view = await renderNode(React.createElement(T.NewsModelGroup, {
    group, impacts: {}, t: translator('en'), matchedOffers: null, detailsId: 'wo1' }), 'en')
  const button = view.container.querySelector('button[data-news-details]')
  await React.act(async () => { button.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
  const panel = view.container.querySelector('[data-news-details-panel]')
  assert.match(panel.textContent, /Official rates verified/)
  assert.match(panel.textContent, /https:\/\/not-a-link\.example pricing page snapshot/,
    'the source note shows as plain text')
  const officialBlock = panel.querySelector('.wm-news-officialblock')
  assert.equal(officialBlock.querySelectorAll('a').length, 0, 'never rendered as a link')
  const rows = [...officialBlock.querySelectorAll('.wm-news-officialrow')]
  assert.equal(rows.length, 2, 'each window is its own row')
  assert.match(rows[0].textContent, /7-day window/)
  assert.match(rows[0].textContent, /08:30–17:00/)
  assert.match(rows[0].textContent, /Input \$4/)
  assert.match(rows[1].textContent, /30-day window/)
  // zh keeps the same structure.
  const zhView = await renderNode(React.createElement(T.NewsModelGroup, {
    group, impacts: {}, t: translator('zh'), matchedOffers: null, detailsId: 'wo1z' }), 'zh')
  const zhButton = zhView.container.querySelector('button[data-news-details]')
  await React.act(async () => { zhButton.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
  const zhPanel = zhView.container.querySelector('[data-news-details-panel]')
  assert.match(zhPanel.textContent, /官方价格核实于/)
  assert.equal(zhPanel.querySelector('.wm-news-officialblock').querySelectorAll('a').length, 0)
})

test('cards carry their kind: plan, listing and the flat fallback', async () => {
  const plan = await renderCard({ id: 'p', category: 'subscription', provider: 'Acme', model: '' }, null, 'en')
  assert.ok(plan.container.querySelector('[data-news-plan]'), 'a subscription item is a plan card')
  assert.equal(plan.container.querySelector('[data-news-impact]'), null, 'no impact, no hook')
  const listing = await renderCard({ id: 'l', category: 'new_model', provider: 'Acme', model: 'm9' }, null, 'en')
  assert.ok(listing.container.querySelector('[data-news-listing]'), 'a new_model item is a listing card')
  const flat = await renderCard({ id: 'f', category: 'price_reduction', provider: 'Acme', model: 'm1' }, null, 'en')
  assert.equal(flat.container.querySelector('[data-news-plan]'), null)
  assert.equal(flat.container.querySelector('[data-news-listing]'), null)
  // The degraded flat fallback marks every card.
  const flatMarked = await renderCard(
    { id: 'f2', category: 'subscription', provider: 'Acme', model: '' }, null, 'en', { flat: true })
  assert.ok(flatMarked.container.querySelector('[data-news-flat]'))
  const withImpact = await renderCard(
    { id: 'i', category: 'price_reduction', provider: 'Acme', model: 'm1' },
    { basis: 'full', delta_usd: -2, window_days: 30 }, 'en')
  assert.equal(withImpact.container.querySelector('[data-news-impact]').getAttribute('data-news-impact'), 'full')
})

test('the scope and category controls carry their hook contract', async () => {
  const scopeView = await renderNode(React.createElement(T.NewsScopeTabs, {
    scope: 'foryou', forYouCount: 2, allCount: 9, t: translator('en'), onChange: () => {} }), 'en')
  const scopeWrap = scopeView.container.querySelector('[data-news-scope]')
  assert.ok(scopeWrap, 'the scope group is wrapped')
  const pressed = [...scopeWrap.querySelectorAll('button[aria-pressed]')]
  assert.deepEqual(pressed.map(b => b.getAttribute('value')), ['foryou', 'all'])
  assert.equal(pressed[0].getAttribute('aria-pressed'), 'true')
})

// --- the full NewsPage: page-level hooks ------------------------------------

test('NewsPage carries the scope, category, search, days, count and paging hooks', async () => {
  // A payload with 12 model events, 7 of them relevant: For You shows 5 with a
  // Show-all control; All shows 10 with a Load-more control.
  const payload = {
    ok: true,
    local: {
      baseline: true, snapshot_at: '2026-11-01T00:00:00Z', removed_model_count: 0,
      items: Array.from({ length: 12 }, (_, i) => ({
        id: `n${i}`, origin: 'local', category: 'price_reduction',
        provider: 'Acme', model: `acme/model-${i}`,
        summary_code: '', summary_params: null, summary: `model-${i} changed.`,
        previous: { input: 5.0, output: 25.0, cache_read: null, cache_write: null },
        current: { input: 4.0, output: 25.0, cache_read: null, cache_write: null },
        has_tiers: false, observed_at: '2026-11-03T00:00:00Z', effective_at: '',
        source_url: '', provenance: '', confidence: 'observed',
        relevance: { relevant: i < 7, reasons: i < 7 ? ['configured_provider'] : [] },
      })),
    },
    central: { items: [] },
    impacts: {},
    settings: { live_updates: true },
    signals: { configured_families: ['acme'] },
  }
  T.setRest(async path => path === '/news/refresh' ? payload : { ok: true })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = ReactDOMClient.createRoot(container)
  roots.push(root)
  T.$newsScope.set('foryou')
  T.$newsCategory.set('all')
  T.$newsSearch.set('')
  T.$newsDays.set(null)
  T.$newsShown.set(T.NEWS_PAGE_SIZE)
  T.$newsShowAll.set(false)
  T.$newsDetailsOpen.set([])
  await React.act(async () => {
    root.render(React.createElement(QueryClientProvider, { client: queryClient },
      React.createElement(T.NewsPage)))
  })
  await React.act(async () => {
    for (let i = 0; i < 6; i += 1) await new Promise(resolve => setTimeout(resolve, 0))
  })
  const c = () => container
  // For You: the scope hook, the category wrapper, counts, and Show all.
  const scope = c().querySelector('[data-news-scope]')
  assert.ok(scope, 'the scope group is marked')
  assert.deepEqual([...scope.querySelectorAll('button[aria-pressed]')].map(b => b.getAttribute('value')),
    ['foryou', 'all'])
  const category = c().querySelector('[data-news-category]')
  assert.ok(category && category.querySelectorAll('button[aria-pressed]').length >= 5,
    'the category segments render inside the page-local wrapper')
  const counts = [...c().querySelectorAll('[data-news-count]')]
  assert.deepEqual(counts.map(el => el.getAttribute('data-news-count')).sort(), ['events', 'groups'])
  const showAll = c().querySelector('button[data-news-show-all]')
  assert.ok(showAll, 'more than five For You groups offer Show all')
  assert.match(showAll.textContent, /7/)
  assert.equal(c().querySelectorAll('[data-news-group]').length, 5, 'For You shows five groups first')
  await React.act(async () => { showAll.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
  assert.equal(c().querySelectorAll('[data-news-group]').length, 7, 'Show all reveals the rest')

  // Switch to All: search, day buttons and load-more appear.
  const allButton = [...scope.querySelectorAll('button')].find(b => b.getAttribute('value') === 'all')
  await React.act(async () => { allButton.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
  const search = c().querySelector('input[data-news-search]')
  assert.ok(search, 'the search input is marked')
  assert.equal(search.getAttribute('type'), 'search')
  assert.ok(search.getAttribute('aria-label'), 'the search input is labelled')
  const days = c().querySelector('[data-news-days]')
  assert.ok(days, 'the day window is a marked button group')
  assert.deepEqual([...days.querySelectorAll('button[aria-pressed]')].map(b => b.getAttribute('value')),
    ['7', '30', '90', 'all'])
  assert.equal([...days.querySelectorAll('button')].find(b => b.getAttribute('value') === 'all')
    .getAttribute('aria-pressed'), 'true')
  assert.equal(c().querySelectorAll('[data-news-group]').length, 10, 'All pages by ten')
  const loadMore = c().querySelector('button[data-news-load-more]')
  assert.ok(loadMore, 'twelve entries leave two behind')
  assert.match(loadMore.textContent, /2/, 'the remaining count is in the button text')
  await React.act(async () => { loadMore.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
  assert.equal(c().querySelectorAll('[data-news-group]').length, 12)
  // A search with no results offers the marked Clear control.
  await React.act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(search, 'zzz-no-match')
    search.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
  const clear = c().querySelector('button[data-news-clear]')
  assert.ok(clear, 'a filtered-empty state offers Clear filters')
  // No NUL in any attribute, page-wide.
  for (const el of c().querySelectorAll('*')) {
    for (const attr of el.attributes) {
      assert.ok(!attr.value.includes('\u0000'), `no NUL in ${attr.name}`)
    }
  }
})
