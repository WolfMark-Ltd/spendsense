// Run: node --test test/
//
// Model News localisation rendering — real React, synthetic fixtures.
// Renders NewsCard directly with coded backend items in both locales.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { after, test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const HARNESS_MODULES = join(ROOT, 'test', 'harness', 'node_modules')
const harnessRequire = createRequire(join(ROOT, 'test', 'harness', 'package.json'))

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
  },
  nodePaths: [HARNESS_MODULES],
  // Keep React's native CommonJS module.require: bundling it makes act()
  // fall back to MessageChannels whose referenced ports keep Node alive.
  plugins: [{ name: 'native-react', setup(build) {
    build.onResolve({ filter: /^react(?:-dom)?(?:\/|$)/ }, args => ({
      path: harnessRequire.resolve(args.path), external: true,
    }))
  } }],
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

after(() => { queryClient.clear(); dom.window.close(); esbuild.stop() })
test.afterEach(async () => {
  while (roots.length) {
    const root = roots.pop()
    await React.act(async () => { root.unmount() })
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
  const show = async (nextLocale, nextElement = element) => {
    await React.act(async () => {
      root.render(React.cloneElement(nextElement, { t: translator(nextLocale) }))
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
    await React.act(async () => { T.$newsDetailsOpen.set([]) })
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
    const history = panel.querySelector('[data-news-history]')
    assert.ok(history, 'History lists older events')
    assert.match(history.textContent, /g-old/)
    assert.ok(history.querySelector('a[href="https://example.com/pricing"]'), 'history keeps its source link')
  }
})

test('a demoted merged event keeps full evidence and raw tiers in History, EN and zh', async () => {
  const tiersBefore = [{ type: 'context', size: 200000, input: 2.0, output: 10.0, cache_read: 0.2 }]
  const tiersAfter = [{ type: 'context', size: 200000, input: 1.6, output: 8.0, cache_read: 0.2 }]
  // Proof (b): distinct IDs, identical transition, equal nonempty effective_at
  // and URL. Different observed timestamps must survive the later demotion.
  const l1 = groupItem({ id: 'l1', provider: 'Acme', model: 'm1',
    observed_at: '2026-11-03T00:00:00Z', effective_at: '2026-11-05T00:00:00Z',
    source_url: 'https://example.com/local-scan', provenance: 'Hermes local scan',
    tiers_detail: 'known', tiers_before: tiersBefore, tiers_after: tiersAfter })
  const c1 = groupItem({ id: 'c1', origin: 'central', provider: 'Acme', model: 'm1',
    observed_at: '2026-11-04T12:34:56Z', effective_at: '2026-11-05T00:00:00Z',
    source_url: 'https://example.com/local-scan', provenance: 'models.dev central feed',
    tiers_detail: 'known', tiers_before: tiersBefore, tiers_after: tiersAfter })
  const l2 = groupItem({ id: 'l2', provider: 'Acme', model: 'm1',
    observed_at: '2026-11-05T00:00:00Z',
    current: { input: 6.0, output: 30.0, cache_read: 0.6, cache_write: 7.0 } })
  const group = groupFrom([l1, c1, l2])
  assert.equal(group.offers[0].events.length, 2, 'no inflated event count')
  for (const [locale, labels] of [
    ['en', { evidence: 'Evidence sources', before: 'Tiers before', after: 'Tiers after' }],
    ['zh', { evidence: '证据来源', before: '之前分层', after: '之后分层' }],
  ]) {
    await React.act(async () => { T.$newsDetailsOpen.set([]) })
    const node = React.createElement(T.NewsModelGroup, { group: groupFrom([l1, c1]), impacts: {}, t: translator(locale),
      matchedOffers: null, detailsId: `wh-${locale}` })
    const view = await renderNode(node, locale)
    const button = view.container.querySelector('button.wm-news-details')
    await React.act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    assert.ok(!view.container.querySelector('[data-news-history]'), 'merged pair starts as latest')
    assert.deepEqual([...view.container.querySelectorAll('[data-news-source-id]')]
      .map(row => row.getAttribute('data-news-source-id')), ['l1', 'c1'])
    await view.show(locale, React.cloneElement(node, { group }))
    const history = view.container.querySelector('[data-news-history]')
    assert.ok(history, 'History renders')
    const events = history.querySelectorAll('[data-news-event]')
    assert.equal(events.length, 1, 'the merged pair stays one history event')
    assert.equal(events[0].getAttribute('data-news-event'), 'l1',
      'the merged event stays reachable under its primary id')
    const disclosure = events[0].querySelector('details.wm-news-histevidence')
    assert.ok(disclosure, 'a nested accessible disclosure holds the full audit trail')
    assert.equal(disclosure.querySelector('summary').textContent, labels.evidence)
    disclosure.open = true
    const text = disclosure.textContent
    assert.match(text, new RegExp(labels.before), `tier before label (${locale})`)
    assert.match(text, new RegExp(labels.after), `tier after label (${locale})`)
    // Both original records with their exact ids and exact source anchors.
    const rows = [...disclosure.querySelectorAll('[data-news-evidence] [data-news-source-id]')]
    assert.deepEqual(rows.map(row => row.getAttribute('data-news-source-id')), ['l1', 'c1'])
    const anchors = [...disclosure.querySelectorAll('a.wm-source-link')]
      .map(a => a.getAttribute('href'))
    assert.ok(anchors.includes('https://example.com/local-scan'), 'local anchor exact')
    assert.deepEqual(anchors, [l1.source_url, c1.source_url], 'both original anchors exact')
    for (const [index, source] of [l1, c1].entries()) {
      const row = rows[index]
      assert.ok(row.textContent.includes(source.observed_at), 'full original observed timestamp')
      assert.ok(row.textContent.includes(source.effective_at), 'full original effective timestamp')
      assert.ok(row.textContent.includes(source.provenance), 'original provenance')
      assert.deepEqual([...row.querySelectorAll('.wm-news-rates tbody tr')].map(tr =>
        [...tr.querySelectorAll('td')].slice(1).map(td => td.textContent)),
        ['input', 'output', 'cache_read', 'cache_write'].map(key =>
          [`$${source.previous[key]}`, `$${source.current[key]}`]), 'every exact previous/current rate')
      assert.equal(row.querySelector('[data-news-tier-rows="before"]').textContent,
        `context (200000)${locale === 'en' ? 'Input $2 · Output $10 · Cache read $0.2' : '输入 $2 · 输出 $10 · 缓存读取 $0.2'}`)
      assert.equal(row.querySelector('[data-news-tier-rows="after"]').textContent,
        `context (200000)${locale === 'en' ? 'Input $1.6 · Output $8 · Cache read $0.2' : '输入 $1.6 · 输出 $8 · 缓存读取 $0.2'}`)
    }
    // Observed/effective dates and provenance of BOTH records.
    assert.match(text, /2026-11-03/, 'observed dates reachable')
    assert.match(text, /2026-11-05/, 'effective dates reachable')
    assert.match(text, /Hermes local scan/, 'local provenance reachable')
    assert.match(text, /models\.dev central feed/, 'central provenance reachable')
    // Exact was/now rates of the historical event, not a summary.
    const rates = disclosure.querySelector('.wm-news-rates')
    assert.ok(rates, 'the historical was/now table is present')
    assert.match(rates.textContent, /\$5/, 'previous input exact')
    assert.match(rates.textContent, /\$4/, 'current input exact')
    assert.match(rates.textContent, /\$0\.5/, 'previous cache_read exact')
    assert.match(rates.textContent, /\$0\.4/, 'current cache_read exact')
    // Raw tier rows exactly as supplied, before and after.
    const beforeRows = disclosure.querySelector('[data-news-tier-rows="before"]')
    const afterRows = disclosure.querySelector('[data-news-tier-rows="after"]')
    assert.ok(beforeRows && afterRows, 'both raw tier blocks render')
    assert.match(beforeRows.textContent, /\$2/, 'tier before input exact')
    assert.match(beforeRows.textContent, /context/, 'tier row type exact')
    assert.match(afterRows.textContent, /\$1\.6/, 'tier after input exact')
    assert.match(afterRows.textContent, /\$8/, 'tier after output exact')
  }
})

test('a same-id pair renders both original records as evidence', async () => {
  const local = groupItem({ id: 'md-shared', provider: 'Acme', model: 'm1',
    source_url: 'https://example.com/local', provenance: 'Hermes local scan' })
  const central = groupItem({ id: 'md-shared', origin: 'central', provider: 'Acme', model: 'm1',
    observed_at: '2026-11-04T00:00:00Z',
    source_url: 'https://example.com/central', provenance: 'models.dev central feed' })
  const group = groupFrom([local, central])
  assert.equal(group.offers[0].events.length, 1, 'one event for one stored id')
  await React.act(async () => { T.$newsDetailsOpen.set([]) })
  const node = React.createElement(T.NewsModelGroup, { group, impacts: {}, t: translator('en'),
    matchedOffers: null, detailsId: 'ws1' })
  const view = await renderNode(node, 'en')
  const button = view.container.querySelector('button.wm-news-details')
  await React.act(async () => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  const evidence = view.container.querySelector('.wm-news-evidence')
  assert.ok(evidence, 'the latest event exposes its evidence block')
  const rows = [...evidence.querySelectorAll('[data-news-source-id]')]
  assert.deepEqual(rows.map(row => row.getAttribute('data-news-source-id')),
    ['md-shared', 'md-shared'], 'both original records render')
  const hrefs = [...evidence.querySelectorAll('a.wm-source-link')].map(a => a.getAttribute('href'))
  assert.deepEqual(hrefs, ['https://example.com/local', 'https://example.com/central'],
    'each record keeps its exact URL')
  assert.match(evidence.textContent, /Hermes local scan/)
  assert.match(evidence.textContent, /models\.dev central feed/)
})

test('a group without model_name shows the exact ID alone', async () => {
  const group = groupFrom([groupItem({ id: 'g1', model_name: '' })])
  const { container } = await renderNode(
    React.createElement(T.NewsModelGroup, { group, impacts: {}, t: translator('en'),
      matchedOffers: null, detailsId: 'wn1' }), 'en')
  const heading = container.querySelector('h3')
  assert.equal(heading.textContent, 'claude-sonnet-4-5-20250929')
  assert.ok(!heading.querySelector('.wm-news-groupid'), 'no duplicated ID line')
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
  // For You counts entries: groups plus relevant plan/listing cards.
  assert.match(buttons[0].textContent, /3 updates/, 'the For You count is labelled as entries')
  assert.match(buttons[1].textContent, /8 updates/, 'the All count is labelled too')
  assert.match(T.NEWS_CSS, /wm-news-controls \[aria-pressed="true"\][^}]*outline:2px solid var\(--ui-accent\)/,
    'the ring rule is page-local CSS, weight 600')
})

test('the control row has no inflexible width at 380px', () => {
  // The search no longer carries a fixed floor: it can shrink with the row.
  assert.match(T.NEWS_CSS, /\.wm-news-search,\.wm-news-select\{[^}]*min-width:0\}/,
    'no inflexible control min-width in NEWS_CSS')
  // At narrow widths the scope, category and date segments wrap their buttons
  // instead of overflowing the page.
  assert.match(T.NEWS_CSS, /@container\(max-width:560px\)\{[\s\S]*\.wm-news-seg,\.wm-news-controls \.wm-segments\{width:100%;flex-wrap:wrap\}/,
    'the segment groups wrap inside the narrow container')
})

test('narrow controls stretch only non-segment controls; segments stay compact', () => {
  // Full-width buttons are for the search/select and direct control buttons
  // only; a bare `.wm-news-controls button` rule captured the scope and date
  // segment buttons and stacked each into a full-row 99-radius oval.
  assert.match(T.NEWS_CSS,
    /\.wm-news-controls > button,\.wm-news-search,\.wm-news-select\{min-height:38px;width:100%\}/,
    'the narrow full-width rule targets non-segment controls')
  assert.doesNotMatch(T.NEWS_CSS, /\.wm-news-controls button,\.wm-news-search/,
    'the capture-all segment-stacking rule is gone')
  // The scope, date and category segments share one wrapping compact row;
  // the category AnalyticsSegments row wraps with them instead of
  // overflowing or stacking.
  assert.match(T.NEWS_CSS,
    /\.wm-news-seg,\.wm-news-controls \.wm-segments\{width:100%;flex-wrap:wrap\}/,
    'all three segments wrap inside the narrow container')
  assert.match(T.NEWS_CSS,
    /\.wm-news-segbtn,\.wm-news-controls \.wm-segments button\{flex:1 1 auto;min-height:38px\}/,
    'segment buttons share the wrapping row instead of stacking')
})

// --- WP11 corrections: hooks, official rates, card kinds, NUL guard ----------

const hookGroup = () => {
  // A local/central pair with an identical transition, the same observed_at
  // and matching (non-conflicting) URLs merges into one event with two
  // evidence sources; an older event stays in History.
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
    { ...base, id: 'cen-1', origin: 'central', source_url: 'https://example.com/a',
      provenance: 'SpendSense announcements' },
    { ...base, id: 'old-1', origin: 'local', source_url: '',
      observed_at: '2026-11-01T00:00:00Z', effective_at: '' },
  ]).groups[0]
}

test('the group and offer markup carries the full DOM hook contract', async () => {
  await React.act(async () => { T.$newsDetailsOpen.set([]) })
  const group = hookGroup()
  const view = await renderNode(React.createElement(T.NewsModelGroup, {
    group, impacts: { 'loc-1': { basis: 'partial', delta_usd: -1.5, window_days: 30, reason: '' } },
    t: translator('en'), matchedOffers: [0], detailsId: 'wh1' }), 'en')
  const c = view.container
  const card = c.querySelector('article[data-news-group]')
  assert.equal(card.getAttribute('data-news-group'), 'claude-sonnet-4-5-20250929')
  assert.equal(card.getAttribute('data-news-classes'), 'reduction')
  assert.ok(!card.querySelector('[data-news-model-name]'),
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
  // Evidence sources of the merged event, each with its origin. The history
  // disclosure additionally renders the historical event's own record.
  await React.act(async () => { button.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
  const evidenceBlock = panel.querySelector('.wm-news-evidence')
  const sources = [...evidenceBlock.querySelectorAll('[data-news-source]')]
  assert.deepEqual(sources.map(el => el.getAttribute('data-news-source')), ['local', 'central'])
  assert.match(panel.textContent, /loc-1/)
  assert.match(panel.textContent, /cen-1/)
  assert.ok(panel.querySelector('a[href="https://example.com/a"]'), 'both evidence sources keep their link')
  assert.equal(panel.querySelectorAll('a[href="https://example.com/a"]').length, 3,
    'two evidence links plus the merged event meta link, all to the shared source')
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
  await React.act(async () => { T.$newsDetailsOpen.set([]) })
  const view = await renderNode(React.createElement(T.NewsModelGroup, {
    group, impacts: {}, t: translator('en'), matchedOffers: null, detailsId: 'wt1' }), 'en')
  const tierChip = view.container.querySelector('[data-news-chip="tiers"]')
  assert.ok(tierChip, 'a tier signal renders a tier chip')
  assert.equal(tierChip.getAttribute('data-news-dir'), 'na')
  // No captured arrays at all: the caveat is tier_unavailable.
  assert.equal(tierChip.getAttribute('data-news-reason'), 'tier_unavailable')
  assert.match(tierChip.textContent, /Not comparable/)
  // Unknown detail WITH captured rows: the tier type is what is unknown.
  const typed = T.newsGroupModels([{ ...item, tiers_detail: 'unknown',
    tiers_before: [{ type: 'context', size: 200000, input: 1, output: 2 }],
    tiers_after: [{ type: 'context', size: 200000, input: 1, output: 2 }] }]).groups[0]
  const typedView = await renderNode(React.createElement(T.NewsModelGroup, {
    group: typed, impacts: {}, t: translator('en'), matchedOffers: null, detailsId: 'wt1b' }), 'en')
  const typedChip = typedView.container.querySelector('[data-news-chip="tiers"]')
  assert.equal(typedChip.getAttribute('data-news-reason'), 'tier_type_unknown')
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
  await React.act(async () => { T.$newsDetailsOpen.set([]) })
  const view = await renderNode(React.createElement(T.NewsModelGroup, {
    group, impacts: {}, t: translator('en'), matchedOffers: null, detailsId: 'wt2' }), 'en')
  const tierChip = view.container.querySelector('[data-news-chip="tiers"]')
  assert.equal(tierChip.getAttribute('data-news-dir'), 'down')
  assert.equal(tierChip.getAttribute('data-news-reason'), null)
  assert.match(tierChip.textContent, /−50%/, 'the largest comparable tier move, concise')
  const button = view.container.querySelector('button[data-news-details]')
  await React.act(async () => { button.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
  const rows = [...view.container.querySelectorAll('[data-news-details-panel] [data-news-tier-list] li')]
  assert.equal(rows.length, 2, 'each tier row is listed separately')
  assert.match(rows[0].textContent, /up_to_200k/)
  assert.match(rows[0].textContent, /Input −50%/)
  assert.match(rows[1].textContent, /up_to_1m/)
  assert.match(rows[1].textContent, /unchanged/)
})

test('a single unmerged event exposes exact evidence and raw tiers in Details, EN and zh', async () => {
  const item = {
    id: 'exact-1', origin: 'local', category: 'price_reduction', provider: 'P', model: 'm1',
    previous: { input: 5.0, output: 25.0, cache_read: null, cache_write: null },
    current: { input: 2.3456789, output: 12.345678, cache_read: null, cache_write: null },
    has_tiers: true, tiers_detail: 'known',
    // Mismatched tier types and thresholds: no row pairs up, so nothing is
    // comparable — the raw rows still render exactly as supplied.
    tiers_before: [{ type: 'context', size: 200000, input: 3.14159, output: 15.9265 }],
    tiers_after: [{ type: 'long_context', size: 1000000, input: 2.71828, cache_write: 0.75 }],
    observed_at: '2026-11-03T14:26:31Z', effective_at: '2026-11-10T00:09:00Z',
    source_url: 'https://example.com/exact', provenance: 'Exact scan', confidence: 'observed',
    relevance: { relevant: false, reasons: [] },
  }
  const group = T.newsGroupModels([item]).groups[0]
  assert.equal(group.offers[0].tierStatus, 'mismatch', 'the mismatched tiers are not comparable')
  for (const [locale, origin, evidence] of [['en', 'Local', 'Evidence sources'], ['zh', '本地', '证据来源']]) {
    await React.act(async () => { T.$newsDetailsOpen.set([]) })
    const view = await renderNode(React.createElement(T.NewsModelGroup, {
      group, impacts: {}, t: translator(locale), matchedOffers: null, detailsId: `wse-${locale}` }), locale)
    const button = view.container.querySelector('button[data-news-details]')
    await React.act(async () => { button.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const panel = view.container.querySelector('[data-news-details-panel]')
    assert.equal(button.getAttribute('aria-expanded'), 'true')
    assert.ok(!panel.hidden)
    // The rounded was/now summary table stays, but the exact record is now
    // reachable too, behind a native details disclosure.
    assert.match(panel.querySelector('.wm-news-rates').textContent, /\$2\.3457/,
      'the summary rate table stays rounded')
    const disclosure = panel.querySelector('details[data-news-single-evidence]')
    assert.ok(disclosure, 'the single unmerged event exposes an exact-evidence disclosure')
    assert.equal(disclosure.querySelector('summary').textContent, evidence)
    assert.ok(!panel.querySelector('.wm-news-evidence'), 'no merged evidence block for one source')
    const row = disclosure.querySelector('[data-news-evidence] [data-news-source-id]')
    assert.equal(row.getAttribute('data-news-source-id'), 'exact-1', 'the exact stored id is reachable')
    assert.equal(row.querySelector('[data-news-source]').getAttribute('data-news-source'), 'local')
    assert.match(row.querySelector('[data-news-source]').textContent, new RegExp(origin))
    assert.match(row.textContent, new RegExp('Observed 2026-11-03T14:26:31Z|观察于2026-11-03T14:26:31Z'),
      'the exact ISO observed timestamp, not the rounded day')
    assert.match(row.textContent, new RegExp('Effective 2026-11-10T00:09:00Z|生效于2026-11-10T00:09:00Z'),
      'the exact ISO effective timestamp')
    assert.ok(row.querySelector('a[href="https://example.com/exact"]'), 'the exact source URL is linked')
    const table = row.querySelector('.wm-news-rates')
    assert.match(table.textContent, /\$5/, 'the exact was rate')
    assert.match(table.textContent, /\$2\.3456789/, 'the exact now input rate, full precision')
    assert.match(table.textContent, /\$12\.345678/, 'the exact now output rate, full precision')
    // Raw tier rows exactly as supplied — mismatched types and thresholds
    // keep their own values, with no invented percentages anywhere.
    const before = row.querySelector('[data-news-tier-rows="before"]')
    const after = row.querySelector('[data-news-tier-rows="after"]')
    assert.match(before.textContent, /context \(200000\)/)
    assert.match(before.textContent, /\$3\.14159/)
    assert.match(before.textContent, /\$15\.9265/)
    assert.match(after.textContent, /long_context \(1000000\)/)
    assert.match(after.textContent, /\$2\.71828/)
    assert.match(after.textContent, /\$0\.75/, 'a field missing before renders only where supplied')
    assert.ok(!row.querySelector('[data-news-tier-blocks]').textContent.includes('%'),
      'raw tier rows carry no invented percentages')
  }
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
  await React.act(async () => { T.$newsDetailsOpen.set([]) })
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

test('official exact rates and the verified ISO stay recoverable, EN and zh', async () => {
  const item = {
    id: 'o2', origin: 'local', category: 'price_reduction', provider: 'P', model: 'm1',
    previous: { input: 5.0, output: null, cache_read: null, cache_write: null },
    current: { input: 4.0, output: null, cache_read: null, cache_write: null },
    has_tiers: false, observed_at: '2026-11-03T00:00:00Z', effective_at: '',
    source_url: '', provenance: '', confidence: 'observed',
    official: {
      verified_at: '2026-11-02T08:31:27Z',
      source_note: 'https://not-a-link.example pricing page snapshot',
      windows: [
        { days: 7, start_minute: 510, end_minute: 1020, input: 4.123456, output: 20.987654, cache_read: 0.4, cache_write: null },
        { days: 30, start_minute: 0, end_minute: 1439, input: 4, output: 20, cache_read: null, cache_write: 6 },
      ],
    },
    relevance: { relevant: false, reasons: [] },
  }
  for (const [locale, verified, summary] of [
    ['en', /Official rates verified 2026-11-02T08:31:27Z/, 'Exact official rates'],
    ['zh', /官方价格核实于2026-11-02T08:31:27Z/, '官方精确价格'],
  ]) {
    const view = await renderCard(item, null, locale)
    const block = view.container.querySelector('.wm-news-officialblock')
    assert.equal(block.querySelectorAll('.wm-news-officialrow').length, 2,
      'the compact rounded rows keep one row per window')
    assert.equal(block.querySelectorAll('a').length, 0, 'the source note stays text, never a link')
    const disclosure = block.querySelector('details[data-news-official-exact]')
    assert.ok(disclosure, 'the exact official values are recoverable behind a disclosure')
    assert.equal(disclosure.querySelector('summary').textContent, summary)
    assert.match(disclosure.textContent, verified, 'the exact verified ISO timestamp')
    const rows = [...disclosure.querySelectorAll('[data-news-official-exactrow]')]
    assert.equal(rows.length, 2, 'each window keeps its own exact row')
    assert.match(rows[0].textContent, /7-day window|7 天窗口/)
    assert.match(rows[0].textContent, /08:30–17:00/)
    assert.match(rows[0].textContent, /\$4\.123456/, 'exact input, full precision')
    assert.match(rows[0].textContent, /\$20\.987654/, 'exact output, full precision')
    assert.match(rows[0].textContent, /\$0\.4/, 'exact cache read')
    assert.match(rows[1].textContent, /30-day window|30 天窗口/)
    assert.match(rows[1].textContent, /00:00–23:59/)
    assert.match(rows[1].textContent, /\$4 · [^·]+ \$20/, 'exact base rates stay exact')
    assert.match(rows[1].textContent, /\$6/, 'exact cache write')
    assert.match(rows[0].textContent, /Input|输入/, 'the rounded rows keep their field labels')
  }
})

test('flat plan cards expose the exact record: id, ISO dates, fees, no token rates', async () => {
  const plan = {
    id: 'plan-exact-1', origin: 'local', category: 'subscription', provider: 'anthropic', model: '',
    summary: 'Claude Max: fee USD 100/month → USD 200/month.',
    summary_code: 'news_sum_plan_change',
    summary_params: { plan: 'Claude Max', fee_before: 'USD 100/month', fee_after: 'USD 200/month', fee_changed: true },
    previous: null, current: null,
    observed_at: '2026-11-10T09:15:00Z', effective_at: '2026-12-01T00:00:00Z',
    source_url: 'https://example.com/plans/max', provenance: 'bundled membership catalogue',
    confidence: 'observed', conditions: '', conditions_code: '',
  }
  const card = await renderCard(plan, null, 'en')
  assert.ok(card.container.querySelector('[data-news-plan]'), 'the plan card keeps its kind hook')
  assert.ok(!card.container.querySelector('.wm-news-rates'), 'plans never map into token rate tables')
  const disclosure = card.container.querySelector('details[data-news-card-evidence]')
  assert.ok(disclosure, 'the plan card exposes an exact-evidence disclosure')
  assert.equal(disclosure.querySelector('summary').textContent, 'Evidence sources')
  const row = disclosure.querySelector('[data-news-evidence] [data-news-source-id]')
  assert.equal(row.getAttribute('data-news-source-id'), 'plan-exact-1', 'the original item id is reachable')
  assert.equal(row.querySelector('[data-news-source]').getAttribute('data-news-source'), 'local')
  assert.match(row.textContent, /Observed 2026-11-10T09:15:00Z/, 'the exact ISO observed timestamp')
  assert.match(row.textContent, /Effective 2026-12-01T00:00:00Z/, 'the exact ISO effective timestamp')
  assert.ok(row.querySelector('a[href="https://example.com/plans/max"]'), 'the exact source URL is linked')
  assert.match(disclosure.textContent, /bundled membership catalogue/, 'the exact provenance')
  const fees = [...disclosure.querySelectorAll('li')].map(li => li.textContent)
  assert.ok(fees.some(text => text.includes('Fee before: USD 100/month')), 'the exact before fee')
  assert.ok(fees.some(text => text.includes('Fee after: USD 200/month')), 'the exact after fee')
  assert.ok(!disclosure.textContent.includes('Cache'), 'no invented token fees')
  await card.show('zh')
  const zhDisclosure = card.container.querySelector('details[data-news-card-evidence]')
  const zhFees = [...zhDisclosure.querySelectorAll('li')].map(li => li.textContent)
  assert.ok(zhFees.some(text => text.includes('原费用: USD 100/month')), 'zh before fee, values unchanged')
  assert.ok(zhFees.some(text => text.includes('新费用: USD 200/month')), 'zh after fee, values unchanged')
})

test('provider-only listing cards expose the exact record without invented fees', async () => {
  const listing = {
    id: 'listing-exact-1', origin: 'central', category: 'new_model', provider: 'Acme', model: '',
    summary: 'New provider listing.', summary_code: '', summary_params: null,
    previous: null, current: null,
    observed_at: '2026-11-09T23:59:59Z', effective_at: '',
    source_url: 'https://example.com/listing', provenance: 'central feed', confidence: 'observed',
  }
  const { container } = await renderCard(listing, null, 'en')
  assert.ok(container.querySelector('[data-news-listing]'), 'the listing card keeps its kind hook')
  assert.ok(!container.querySelector('.wm-news-rates'), 'no invented token rates')
  const disclosure = container.querySelector('details[data-news-card-evidence]')
  assert.ok(disclosure, 'the listing card exposes an exact-evidence disclosure')
  const row = disclosure.querySelector('[data-news-evidence] [data-news-source-id]')
  assert.equal(row.getAttribute('data-news-source-id'), 'listing-exact-1')
  assert.equal(row.querySelector('[data-news-source]').getAttribute('data-news-source'), 'central')
  assert.match(row.textContent, /Central/)
  assert.match(row.textContent, /Observed 2026-11-09T23:59:59Z/, 'the exact ISO observed timestamp')
  assert.ok(row.querySelector('a[href="https://example.com/listing"]'))
  assert.match(disclosure.textContent, /central feed/)
  assert.equal(disclosure.querySelectorAll('li').length, 1,
    'a non-plan card adds no fee rows')
})

test('cards carry their kind: plan, listing and the flat fallback', async () => {
  const plan = await renderCard({ id: 'p', category: 'subscription', provider: 'Acme', model: '' }, null, 'en')
  assert.ok(plan.container.querySelector('[data-news-plan]'), 'a subscription item is a plan card')
  assert.ok(!plan.container.querySelector('[data-news-impact]'), 'no impact, no hook')
  const listing = await renderCard({ id: 'l', category: 'new_model', provider: 'Acme', model: 'm9' }, null, 'en')
  assert.ok(listing.container.querySelector('[data-news-listing]'), 'a new_model item is a listing card')
  const flat = await renderCard({ id: 'f', category: 'price_reduction', provider: 'Acme', model: 'm1' }, null, 'en')
  assert.ok(!flat.container.querySelector('[data-news-plan]'))
  assert.ok(!flat.container.querySelector('[data-news-listing]'))
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
  await React.act(async () => { T.$newsScope.set('foryou') })
  await React.act(async () => { T.$newsCategory.set('all') })
  await React.act(async () => { T.$newsSearch.set('') })
  await React.act(async () => { T.$newsDays.set(null) })
  await React.act(async () => { T.$newsShown.set(T.NEWS_PAGE_SIZE) })
  await React.act(async () => { T.$newsShowAll.set(false) })
  await React.act(async () => { T.$newsDetailsOpen.set([]) })
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
  // For You counts entries (groups plus relevant plan/listing cards).
  assert.deepEqual(counts.map(el => el.getAttribute('data-news-count')).sort(),
    ['entries', 'events'])
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

/** A paginated NewsPage payload: `count` relevant model events. */
const newsPagePayload = count => ({
  ok: true,
  local: {
    baseline: true, snapshot_at: '2026-11-01T00:00:00Z', removed_model_count: 0,
    items: Array.from({ length: count }, (_, i) => ({
      id: `p${i}`, origin: 'local', category: 'price_reduction',
      provider: 'Acme', model: `acme/model-${i}`,
      summary_code: '', summary_params: null, summary: `model-${i} changed.`,
      previous: { input: 5.0, output: 25.0, cache_read: null, cache_write: null },
      current: { input: 4.0, output: 25.0, cache_read: null, cache_write: null },
      has_tiers: false, observed_at: '2026-11-03T00:00:00Z', effective_at: '',
      source_url: '', provenance: '', confidence: 'observed',
      relevance: { relevant: true, reasons: ['configured_provider'] },
    })),
  },
  central: { items: [] },
  impacts: {},
  settings: { live_updates: true },
  signals: { configured_families: ['acme'] },
})

/** Render the settled full NewsPage over a paginated payload; scope reset. */
const renderNewsPage = async (count, scope = 'all') => {
  T.setRest(async path => path === '/news/refresh' ? newsPagePayload(count) : { ok: true })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = ReactDOMClient.createRoot(container)
  roots.push(root)
  await React.act(async () => { T.$newsScope.set(scope) })
  await React.act(async () => { T.$newsCategory.set('all') })
  await React.act(async () => { T.$newsSearch.set('') })
  await React.act(async () => { T.$newsDays.set(null) })
  await React.act(async () => { T.$newsShown.set(T.NEWS_PAGE_SIZE) })
  await React.act(async () => { T.$newsShowAll.set(false) })
  await React.act(async () => { T.$newsDetailsOpen.set([]) })
  await React.act(async () => {
    root.render(React.createElement(QueryClientProvider, { client: queryClient },
      React.createElement(T.NewsPage)))
  })
  await React.act(async () => {
    for (let i = 0; i < 6; i += 1) await new Promise(resolve => setTimeout(resolve, 0))
  })
  const c = () => container
  return {
    c,
    list: () => c().querySelector('.wm-news-list[role="list"]'),
    groups: () => c().querySelectorAll('[data-news-group]').length,
  }
}

test('pagination keeps real focus: Load more stays focused, then the first new group does', async () => {
  // 22 relevant model events: All pages 10 -> 20 -> 22, For You offers Show all.
  const { c, list, groups } = await renderNewsPage(22)
  assert.equal(groups(), 10, 'All pages by ten')
  const loadMore = c().querySelector('button[data-news-load-more]')
  assert.ok(loadMore, '22 entries leave twelve behind')
  await React.act(async () => { loadMore.focus() })
  assert.equal(document.activeElement, loadMore, 'focus is on Load more before paging')
  // 10 -> 20: the button stays mounted (stable key); the same DOM element
  // keeps focus — no remount, focus never drops to body.
  await React.act(async () => { loadMore.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
  assert.equal(groups(), 20, 'the first page load reveals ten more')
  assert.ok(c().querySelector('button[data-news-load-more]'), 'Load more is still present')
  assert.equal(document.activeElement, loadMore,
    'the same Load more element is still focused, never body')
  // 20 -> 22: final page, the button disappears; focus moves to the first
  // newly revealed group instead of falling back to body.
  await React.act(async () => { loadMore.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
  assert.equal(groups(), 22, 'the final page reveals the rest')
  assert.ok(!c().querySelector('button[data-news-load-more]'), 'no Load more on the final page')
  // The final click revealed the entries after the previous page cut (index
  // 20 here): the first of them takes focus.
  const firstRevealed = list().children[2 * T.NEWS_PAGE_SIZE]
  assert.ok(firstRevealed.matches('[data-news-group]'), 'the first newly revealed entry is a group')
  assert.equal(document.activeElement, firstRevealed,
    'the first newly revealed group takes focus, never body')
  assert.equal(firstRevealed.getAttribute('tabindex'), '-1',
    'the focused group is programmatically focusable')
  // For You Show all follows the same focus contract.
  const scopeButtons = [...c().querySelectorAll('[data-news-scope] button')]
  await React.act(async () => {
    scopeButtons.find(b => b.getAttribute('value') === 'foryou')
      .dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  assert.equal(groups(), 5, 'For You shows five groups first')
  const showAll = c().querySelector('button[data-news-show-all]')
  assert.ok(showAll, '22 relevant groups offer Show all')
  await React.act(async () => { showAll.focus() })
  assert.equal(document.activeElement, showAll)
  await React.act(async () => { showAll.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
  assert.ok(!c().querySelector('button[data-news-show-all]'), 'Show all disappears once used')
  assert.equal(groups(), 22, 'Show all reveals every relevant group')
  const firstNewGroup = list().children[T.NEWS_FOR_YOU_LIMIT]
  assert.equal(document.activeElement, firstNewGroup,
    'the first newly revealed For You group takes focus, never body')
  assert.equal(document.activeElement.tagName, 'ARTICLE')
})

test('category segments label every option with its visible text, EN and zh', async () => {
  for (const [locale, labels] of [
    ['en', ['All', 'New Models', 'Reductions', 'Increases', 'Subscription Updates']],
    ['zh', ['全部', '新模型', '降价', '涨价', '订阅更新']],
  ]) {
    const previousBackend = i18nBackend.t
    i18nBackend.t = (key, ...args) => {
      const entry = T.I18N[locale][key]
      return typeof entry === 'function' ? entry(...args) : entry ?? key
    }
    try {
      const { c } = await renderNewsPage(1)
      const group = c().querySelector('[data-news-category] [role="group"]')
      assert.ok(group, 'the category group renders')
      assert.equal(group.getAttribute('aria-label'), labels[0],
        `the category group keeps its ${locale} accessible name`)
      const buttons = [...group.querySelectorAll('button[aria-pressed]')]
      assert.equal(buttons.length, 5)
      assert.deepEqual(buttons.map(b => b.textContent), labels,
        `${locale}: every category renders in order with its localised label`)
      for (const [index, button] of buttons.entries()) {
        assert.equal(button.getAttribute('aria-label'), button.textContent,
          `${locale}: the accessible name is the visible label`)
        assert.doesNotMatch(button.getAttribute('aria-label'), /_(model|reduction|increase)$/,
          `${locale}: no raw category id leaks into the accessible name`)
      }
    } finally {
      i18nBackend.t = previousBackend
    }
  }
})

test('stale data after a failed refetch keeps pagination focus on the inner list', async () => {
  // Load healthy, then the backend starts failing: the page keeps the last
  // read (retained current) behind the stale alert — and pagination focus
  // must still land on the inner role="list", never the outer wrapper.
  const { c, list, groups } = await renderNewsPage(22)
  assert.equal(groups(), 10)
  T.setRest(async () => { throw new Error('backend down') })
  await React.act(async () => {
    await queryClient.invalidateQueries({ queryKey: T.newsQuery().queryKey })
    for (let i = 0; i < 6; i += 1) await new Promise(resolve => setTimeout(resolve, 0))
  })
  assert.ok(c().querySelector('.wm-alert[role="alert"]'), 'the stale alert renders')
  assert.match(c().querySelector('.wm-alert[role="alert"]').textContent,
    /Refresh failed — showing the last read\./)
  assert.equal(groups(), 10, 'the retained current data keeps its ten groups')
  assert.equal(c().querySelectorAll('.wm-news-list').length, 2,
    'the stale branch wraps the inner list in an outer .wm-news-list')
  const inner = list()
  assert.ok(inner, 'the inner list is the role="list" element')
  // Load more: 10 -> 20 keeps focus on the same element; 20 -> 22 (final
  // page) hands focus to the first newly revealed group inside the inner list.
  let loadMore = c().querySelector('button[data-news-load-more]')
  assert.ok(loadMore, 'the stale page still pages')
  await React.act(async () => { loadMore.focus() })
  await React.act(async () => { loadMore.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
  assert.equal(groups(), 20)
  assert.equal(document.activeElement, loadMore,
    'focus stays on the same Load more element through the stale page')
  await React.act(async () => { loadMore.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
  assert.equal(groups(), 22)
  assert.ok(!c().querySelector('button[data-news-load-more]'))
  const firstRevealed = inner.children[2 * T.NEWS_PAGE_SIZE]
  assert.equal(document.activeElement, firstRevealed,
    'the first newly revealed group in the inner list takes focus, never body')
  assert.equal(firstRevealed.getAttribute('tabindex'), '-1')
  // Show all under the same stale page: focus lands on the first new group.
  const scopeButtons = [...c().querySelectorAll('[data-news-scope] button')]
  await React.act(async () => {
    scopeButtons.find(b => b.getAttribute('value') === 'foryou')
      .dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  const showAll = c().querySelector('button[data-news-show-all]')
  assert.ok(showAll, 'the stale For You page still offers Show all')
  await React.act(async () => { showAll.focus() })
  await React.act(async () => { showAll.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
  assert.ok(!c().querySelector('button[data-news-show-all]'))
  const staleInner = list()
  assert.equal(document.activeElement, staleInner.children[T.NEWS_FOR_YOU_LIMIT],
    'the first newly revealed For You group takes focus inside the inner list')
  assert.equal(document.activeElement.tagName, 'ARTICLE')
})

// --- WP11 fixture rendering: the real generated payloads ---------------------

const readFixture = name => JSON.parse(readFileSync(
  new URL(`../test/fixtures/news/${name}`, import.meta.url), 'utf8'))

const fixtureGroup = (name, model) => {
  const payload = readFixture(name)
  const groups = T.newsGroupModels([...payload.local.items, ...payload.central.items]).groups
  return { payload, group: groups.find(g => g.model === model) }
}

const openDetails = async (view) => {
  const button = view.container.querySelector('button[data-news-details]')
  await React.act(async () => { button.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
  return view.container.querySelector('[data-news-details-panel]')
}

test('fixture local-central: the sonnet group renders name, mixed class, evidence and official', async () => {
  await React.act(async () => { T.$newsDetailsOpen.set([]) })
  const { group } = fixtureGroup('payload-local-central.json', 'claude-sonnet-4')
  const view = await renderNode(React.createElement(T.NewsModelGroup, {
    group, impacts: { 'local-price-reduction-anthropic-claude-sonnet-4--r-----cache-read---0-3--2ea96cf7f1':
      { basis: 'full', delta_usd: -0.465, window_days: 30 } },
    t: translator('en'), matchedOffers: null, detailsId: 'wf-sonnet' }), 'en')
  const c = view.container
  assert.equal(c.querySelector('[data-news-group]').getAttribute('data-news-group'), 'claude-sonnet-4')
  assert.equal(c.querySelector('[data-news-model-name]').textContent, 'Claude Sonnet 4')
  assert.equal(c.querySelector('[data-news-model-id]').textContent, 'claude-sonnet-4-5'.replace('4-5', '4'))
  assert.equal(c.querySelector('.wm-news-badge[data-class]').getAttribute('data-class'), 'mixed',
    'the coded news_rate_mixed drives the class')
  const panel = await openDetails(view)
  const sources = [...panel.querySelectorAll('[data-news-source]')]
  assert.deepEqual(sources.map(el => el.getAttribute('data-news-source')), ['local', 'central'])
  assert.match(panel.textContent, /Anthropic pricing page, Sonnet 4 row/)
  assert.match(panel.textContent, /Official rates verified 2026-01-02/)
  const impact = c.querySelector('[data-news-impact]')
  assert.equal(impact.getAttribute('data-news-impact'), 'full')
  assert.match(impact.textContent, /not a bill or guaranteed saving/)
})

test('fixture local-central: the haiku window renders the weekday list as text', async () => {
  await React.act(async () => { T.$newsDetailsOpen.set([]) })
  const { group } = fixtureGroup('payload-local-central.json', 'claude-haiku-4-5')
  const view = await renderNode(React.createElement(T.NewsModelGroup, {
    group, impacts: {}, t: translator('en'), matchedOffers: null, detailsId: 'wf-haiku' }), 'en')
  const panel = await openDetails(view)
  const row = panel.querySelector('.wm-news-officialrow')
  assert.ok(row, 'the official window renders as its own row')
  assert.match(row.textContent, /Days 0, 1, 2, 3, 4/)
  assert.match(row.textContent, /08:00–17:00/)
  assert.match(row.textContent, /Input \$1\.25/)
  assert.equal(panel.querySelector('.wm-news-officialblock').querySelectorAll('a').length, 0)
})

test('fixture unknown-recurrence: m1 keeps four events with the newest class', async () => {
  await React.act(async () => { T.$newsDetailsOpen.set([]) })
  const { group } = fixtureGroup('payload-unknown-recurrence.json', 'm1')
  const view = await renderNode(React.createElement(T.NewsModelGroup, {
    group, impacts: {}, t: translator('en'), matchedOffers: null, detailsId: 'wf-m1' }), 'en')
  const c = view.container
  assert.equal(c.querySelector('.wm-news-badge[data-class]').getAttribute('data-class'), 'increase')
  // m1's local events supply the friendly name "M One"; the newest central
  // event supplies none, so the newest SUPPLIED name is shown, never invented.
  assert.equal(c.querySelector('[data-news-model-name]')?.textContent, 'M One',
    'the friendly sourced name is shown over the exact ID')
  assert.equal(c.querySelector('[data-news-model-id]').textContent, 'm1')
  const panel = await openDetails(view)
  // No cross-origin merge happened, so no merged evidence block exists; the
  // single unmerged latest event exposes its OWN record behind the exact
  // evidence disclosure, and the History disclosure renders every history
  // event's OWN record — full evidence, never a summary-only row.
  const ownRecords = [...panel.querySelectorAll('[data-news-evidence] [data-news-source-id]')]
  assert.deepEqual(ownRecords.map(el => el.getAttribute('data-news-source-id')),
    ['md-c312c6eae578',
      'local-price-increase-acme-m1--r-----cache-read---null---cache-writ-eb62304d22-r4def01',
      'local-price-reduction-acme-m1--r-----cache-read---null---cache-writ-8f80b1eeda',
      'local-price-increase-acme-m1--r-----cache-read---null---cache-writ-eb62304d22'],
    'the latest event and every history event keep their own original record reachable')
  assert.equal(ownRecords[0].querySelector('[data-news-source]').getAttribute('data-news-source'),
    'central', 'the unmerged latest record is exposed with its own origin tag')
  assert.ok(ownRecords.slice(1).every(el =>
    el.querySelector('[data-news-source]').getAttribute('data-news-source') === 'local'),
    'no cross-origin merge: every history record stays local')
  assert.ok(!panel.querySelector('.wm-news-evidence'),
    'no merged evidence block: the recurrence stayed separate')
  const history = panel.querySelector('[data-news-history]')
  assert.deepEqual([...history.querySelectorAll('[data-news-event]')].map(el => el.getAttribute('data-news-event')), [
    'local-price-increase-acme-m1--r-----cache-read---null---cache-writ-eb62304d22-r4def01',
    'local-price-reduction-acme-m1--r-----cache-read---null---cache-writ-8f80b1eeda',
    'local-price-increase-acme-m1--r-----cache-read---null---cache-writ-eb62304d22',
  ])
})

test('fixture unknown-recurrence: m2 shows the tier_unavailable caveat and the exact ID', async () => {
  await React.act(async () => { T.$newsDetailsOpen.set([]) })
  const { group } = fixtureGroup('payload-unknown-recurrence.json', 'm2')
  const view = await renderNode(React.createElement(T.NewsModelGroup, {
    group, impacts: {}, t: translator('en'), matchedOffers: null, detailsId: 'wf-m2' }), 'en')
  const c = view.container
  const tierChip = c.querySelector('[data-news-chip="tiers"]')
  assert.ok(tierChip, 'the tier signal renders a tier chip')
  assert.equal(tierChip.getAttribute('data-news-reason'), 'tier_unavailable')
  assert.equal(tierChip.getAttribute('data-news-dir'), 'na')
  assert.match(tierChip.textContent, /Not comparable/)
  assert.ok(!c.querySelector('[data-news-model-name]'),
    'model_name is absent, so the exact ID stands alone')
  assert.equal(c.querySelector('[data-news-model-id]').textContent, 'm2')
  const panel = await openDetails(view)
  // The only ul.wm-news-history in the panel is the merged event's evidence
  // list; no tier rows list is fabricated for the unavailable tiers, and a
  // single merged event has no separate event History list.
  const historyLists = [...panel.querySelectorAll('ul.wm-news-history')]
  assert.equal(historyLists.length, 1,
    'only the merged event evidence list renders; no tier rows list is fabricated')
  assert.ok(!historyLists[0].hasAttribute('data-news-history'),
    'the single merged event has no separate event History list')
  assert.ok(!panel.textContent.includes('Tiers'),
    'no tier rows are fabricated for the unavailable tiers')
  const sources = [...panel.querySelectorAll('[data-news-source]')]
  assert.deepEqual(sources.map(el => el.getAttribute('data-news-source')), ['local', 'central'],
    'the m2 pair merged under the proof rules and shows both sources')
})

// --- WP11 final triage batch: reproduced defects (RED before GREEN) ---------

test('mixed comparable tier moves render a mixed label, never "unchanged"', async () => {
  const item = {
    id: 'tm1', origin: 'local', category: 'price_reduction', provider: 'P', model: 'm1',
    summary: 'Rates changed.', summary_code: '', summary_params: null,
    previous: { input: 5.0, output: 25.0, cache_read: null, cache_write: null },
    current: { input: 4.0, output: 25.0, cache_read: null, cache_write: null },
    has_tiers: true, tiers_detail: 'known',
    // Row 1 moves both ways (input down, output up); row 2 input rises while
    // output stays. Every field is comparable, the directions conflict.
    tiers_before: [{ type: 'up_to_200k', size: 200000, input: 2, output: 4 },
      { type: 'up_to_1m', size: 1000000, input: 1, output: 3 }],
    tiers_after: [{ type: 'up_to_200k', size: 200000, input: 1, output: 5 },
      { type: 'up_to_1m', size: 1000000, input: 2, output: 3 }],
    observed_at: '2026-11-03T00:00:00Z', effective_at: '', source_url: '',
    provenance: '', confidence: 'observed', relevance: { relevant: false, reasons: [] },
  }
  const group = T.newsGroupModels([item]).groups[0]
  assert.equal(group.offers[0].tierDir, 'na')
  assert.equal(group.offers[0].tierReason, null)
  await React.act(async () => { T.$newsDetailsOpen.set([]) })
  const en = await renderNode(React.createElement(T.NewsModelGroup, {
    group, impacts: {}, t: translator('en'), matchedOffers: null }), 'en')
  const tierChip = en.container.querySelector('[data-news-chip="tiers"]')
  assert.ok(tierChip, 'a comparable mixed tier change still carries a tier chip')
  assert.equal(tierChip.getAttribute('data-news-dir'), 'na')
  assert.equal(tierChip.getAttribute('data-news-reason'), null)
  assert.doesNotMatch(tierChip.textContent, /unchanged/,
    'a mixed movement is never labelled unchanged')
  assert.match(tierChip.textContent, /Mixed change/, 'the honest mixed label')
  assert.doesNotMatch(tierChip.textContent, /%/, 'no blended percentage is invented')
  const zh = await renderNode(React.createElement(T.NewsModelGroup, {
    group, impacts: {}, t: translator('zh'), matchedOffers: null }), 'zh')
  const zhChip = zh.container.querySelector('[data-news-chip="tiers"]')
  assert.doesNotMatch(zhChip.textContent, /未变/, 'zh: a mixed movement is never 未变')
  assert.match(zhChip.textContent, /涨跌互现/, 'zh: the honest mixed label')
})

test('raw tier rows render per available side even when the comparison is unknown', async () => {
  const source = {
    id: 'tb1', origin: 'local', category: 'price_reduction', provider: 'P', model: 'm1',
    previous: { input: 5.0, output: 25.0 }, current: { input: 4.0, output: 25.0 },
    has_tiers: true, tiers_detail: 'unknown',
    // The backend retained the previous raw tiers; the new read failed, so
    // the overall comparison is unknown — the captured side is still evidence.
    tiers_before: [{ type: 'context', size: 200000, input: 2.0, output: 10.0 }],
    observed_at: '2026-11-03T00:00:00Z', effective_at: '', source_url: '',
    provenance: '', confidence: 'observed', relevance: { relevant: false, reasons: [] },
  }
  const view = await renderNode(React.createElement(T.NewsEvidenceRow, { source, t: translator('en') }), 'en')
  const blocks = view.container.querySelector('[data-news-tier-blocks]')
  assert.ok(blocks, 'captured raw tiers render despite the unknown comparison')
  const before = blocks.querySelector('[data-news-tier-rows="before"]')
  assert.ok(before, 'the known before side renders')
  assert.match(before.textContent, /context/)
  assert.match(before.textContent, /\$2/)
  assert.equal(blocks.querySelector('[data-news-tier-rows="after"]') === null, true,
    'no after side is invented')
  // A record with no captured arrays still renders no tier block.
  const bare = await renderNode(React.createElement(T.NewsEvidenceRow, {
    source: { ...source, tiers_before: undefined, tiers_after: undefined },
    t: translator('en') }), 'en')
  assert.equal(bare.container.querySelector('[data-news-tier-blocks]') === null, true,
    'nothing is fabricated for records without captured tiers')
})

test('details panel ids follow the model/provider identity, not the list position', async () => {
  const mk = (id, provider, over = {}) => groupItem({ id, provider, model: 'acme/m1', ...over })
  const forward = T.newsGroupModels([
    mk('a1', 'Anthropic'),
    mk('a2', 'Bedrock', { observed_at: '2026-11-04T00:00:00Z' }),
  ]).groups[0]
  await React.act(async () => { T.$newsDetailsOpen.set([]) })
  const node = group => React.createElement(T.NewsModelGroup, {
    group, impacts: {}, t: translator('en'), matchedOffers: null })
  const view = await renderNode(node(forward), 'en')
  const panelIdOf = provider => [...view.container.querySelectorAll('[data-news-offer]')]
    .find(offer => offer.getAttribute('data-news-provider') === provider)
    .querySelector('button[data-news-details]').getAttribute('aria-controls')
  const anthropicId = panelIdOf('Anthropic')
  const bedrockId = panelIdOf('Bedrock')
  assert.notEqual(anthropicId, bedrockId, 'each offer owns its own panel id')
  // The id is an unambiguous JSON tuple of [connection, model, provider].
  const tupleOf = id => JSON.parse(decodeURIComponent(id.replace(/^wm-news-panel-/, '')))
  assert.deepEqual(tupleOf(anthropicId), ['', 'acme/m1', 'Anthropic'],
    'the panel id carries the exact model/provider identity as an unambiguous tuple')
  assert.deepEqual(tupleOf(bedrockId), ['', 'acme/m1', 'Bedrock'])
  // Open the Anthropic offer's panel, then reorder the offers the way a
  // search or filter reorder would: the open state must stay with Anthropic.
  await React.act(async () => { T.$newsDetailsOpen.set([anthropicId]) })
  await view.show('en', node(forward))
  const expandedOf = provider => [...view.container.querySelectorAll('[data-news-offer]')]
    .find(offer => offer.getAttribute('data-news-provider') === provider)
    .querySelector('button[data-news-details]').getAttribute('aria-expanded')
  assert.equal(expandedOf('Anthropic'), 'true', 'the opened offer stays open')
  assert.equal(expandedOf('Bedrock'), 'false')
  const reversed = T.newsGroupModels([
    mk('a2', 'Bedrock', { observed_at: '2026-11-04T00:00:00Z' }),
    mk('a1', 'Anthropic'),
  ]).groups[0]
  await view.show('en', node(reversed))
  assert.equal(expandedOf('Anthropic'), 'true',
    'after a reorder the same model/provider keeps its open panel')
  assert.equal(expandedOf('Bedrock'), 'false',
    'the offer that moved into the old position does not inherit the state')
})

test('a known-untiered event renders no tier chip', async () => {
  const item = {
    id: 'ut1', origin: 'local', category: 'price_reduction', provider: 'P', model: 'm1',
    summary: 'Rate changed.', summary_code: '', summary_params: null,
    previous: { input: 5.0, output: 25.0, cache_read: null, cache_write: null },
    current: { input: 4.0, output: 25.0, cache_read: null, cache_write: null },
    has_tiers: true, tiers_detail: 'known', tiers_before: [], tiers_after: [],
    observed_at: '2026-11-03T00:00:00Z', effective_at: '', source_url: '',
    provenance: '', confidence: 'observed', relevance: { relevant: false, reasons: [] },
  }
  const group = T.newsGroupModels([item]).groups[0]
  await React.act(async () => { T.$newsDetailsOpen.set([]) })
  const view = await renderNode(React.createElement(T.NewsModelGroup, {
    group, impacts: {}, t: translator('en'), matchedOffers: null }), 'en')
  assert.equal(view.container.querySelector('[data-news-chip="tiers"]') === null, true,
    'captured empty tier arrays establish untiered: no tier chip, no warning')
})

test('the optional rate-changed class renders as an honest neutral badge', async () => {
  const item = {
    id: 'rc1', origin: 'local', category: 'price_reduction', provider: 'P', model: 'm1',
    summary: 'Cache availability changed.', summary_code: '', summary_params: null,
    previous: { input: 4.0, output: 25.0, cache_read: null, cache_write: 6.25 },
    current: { input: 4.0, output: 25.0, cache_read: 0.4, cache_write: 6.25 },
    has_tiers: false, rate_change_code: 'news_rate_changed',
    observed_at: '2026-11-03T00:00:00Z', effective_at: '', source_url: '',
    provenance: '', confidence: 'observed', relevance: { relevant: false, reasons: [] },
  }
  const group = T.newsGroupModels([item]).groups[0]
  assert.equal(group.offers[0].news_class, 'rate_changed')
  await React.act(async () => { T.$newsDetailsOpen.set([]) })
  const en = await renderNode(React.createElement(T.NewsModelGroup, {
    group, impacts: {}, t: translator('en'), matchedOffers: null }), 'en')
  const badge = en.container.querySelector('.wm-news-badge[data-class]')
  assert.equal(badge.getAttribute('data-class'), 'rate_changed')
  assert.equal(badge.textContent, 'Rates changed')
  assert.ok(en.container.querySelector('[data-dir="flat"]'),
    'the neutral glyph: no up, down or tier claim')
  const zh = await renderNode(React.createElement(T.NewsModelGroup, {
    group, impacts: {}, t: translator('zh'), matchedOffers: null }), 'zh')
  assert.equal(zh.container.querySelector('.wm-news-badge[data-class]').textContent, '费率已变更')
})

test('a relevant plan-only payload renders the plan card in For You', async () => {
  const payload = {
    ok: true,
    local: {
      baseline: true, snapshot_at: '2026-11-01T00:00:00Z', removed_model_count: 0,
      items: [{
        id: 'plan-page-1', origin: 'local', category: 'subscription', provider: 'Acme', model: '',
        summary: 'Team: fee $100/month → $200/month.', summary_code: 'news_sum_plan_change',
        summary_params: { plan: 'Team', fee_before: '$100/month', fee_after: '$200/month' },
        previous: null, current: null, has_tiers: false,
        observed_at: '2026-11-03T00:00:00Z', effective_at: '', source_url: '',
        provenance: '', confidence: 'observed',
        relevance: { relevant: true, reasons: ['selected_plan_family'] },
      }],
    },
    central: { items: [] }, impacts: {}, settings: { live_updates: true },
    signals: { plan_families: ['team'] },
  }
  T.setRest(async path => path === '/news/refresh' ? payload : { ok: true })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = ReactDOMClient.createRoot(container)
  roots.push(root)
  await React.act(async () => { T.$newsScope.set('foryou') })
  await React.act(async () => { T.$newsCategory.set('all') })
  await React.act(async () => { T.$newsSearch.set('') })
  await React.act(async () => { T.$newsDays.set(null) })
  await React.act(async () => { T.$newsShown.set(T.NEWS_PAGE_SIZE) })
  await React.act(async () => { T.$newsShowAll.set(false) })
  await React.act(async () => { T.$newsDetailsOpen.set([]) })
  await React.act(async () => {
    root.render(React.createElement(QueryClientProvider, { client: queryClient },
      React.createElement(T.NewsPage)))
  })
  await React.act(async () => {
    for (let i = 0; i < 6; i += 1) await new Promise(resolve => setTimeout(resolve, 0))
  })
  const c = () => container
  // Category segment buttons are found by their visible localised label.
  const segmentButton = label => [...c().querySelectorAll('[data-news-category] button')]
    .find(button => button.textContent.includes(label))
  assert.ok(c().querySelector('[data-news-plan]'),
    'the relevant plan card appears in For You')
  assert.ok(!c().querySelector('.wm-empty'), 'no empty state while the plan is shown')
  assert.equal(c().querySelector('button[data-news-show-all]') === null, true,
    'a plan-only For You shows every entry, so no Show All is offered')
  // The subscription category keeps the plan card.
  const subsButton = segmentButton('Subscription Updates')
  assert.ok(subsButton, 'the Subscription Updates segment renders')
  await React.act(async () => { subsButton.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
  assert.ok(c().querySelector('[data-news-plan]'),
    'the subscription filter keeps the relevant plan card')
  assert.ok(!c().querySelector('.wm-empty'))
  // An empty filter result states a message; it is never blank.
  const redButton = segmentButton('Reductions')
  assert.ok(redButton, 'the Reductions segment renders')
  await React.act(async () => { redButton.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
  const empty = c().querySelector('.wm-empty[role="status"]')
  assert.ok(empty, 'an empty filtered For You still renders the status region')
  assert.match(empty.textContent, /No updates match|Nothing in this category/,
    'the empty state carries honest text, never a blank page')
})

test('a For You category filter with no matching entries shows a message, not a blank page', async () => {
  // A relevant group whose legacy category says price_reduction but whose
  // latest comparison is a rise: the flat pool is non-empty (so the old
  // newsEmptyText returns null) while the filtered For You list is empty.
  const payload = {
    ok: true,
    local: {
      baseline: true, snapshot_at: '2026-11-01T00:00:00Z', removed_model_count: 0,
      items: [{
        id: 'mis-1', origin: 'local', category: 'price_reduction',
        provider: 'Acme', model: 'acme/m1',
        summary: 'Rates changed.', summary_code: '', summary_params: null,
        previous: { input: 4.0, output: 25.0, cache_read: null, cache_write: null },
        current: { input: 5.0, output: 25.0, cache_read: null, cache_write: null },
        has_tiers: false, observed_at: '2026-11-03T00:00:00Z', effective_at: '',
        source_url: '', provenance: '', confidence: 'observed',
        relevance: { relevant: true, reasons: ['configured_provider'] },
      }],
    },
    central: { items: [] }, impacts: {}, settings: { live_updates: true },
    signals: { configured_families: ['acme'] },
  }
  T.setRest(async path => path === '/news/refresh' ? payload : { ok: true })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = ReactDOMClient.createRoot(container)
  roots.push(root)
  await React.act(async () => { T.$newsScope.set('foryou') })
  await React.act(async () => { T.$newsCategory.set('price_reduction') })
  await React.act(async () => { T.$newsSearch.set('') })
  await React.act(async () => { T.$newsDays.set(null) })
  await React.act(async () => { T.$newsShown.set(T.NEWS_PAGE_SIZE) })
  await React.act(async () => { T.$newsShowAll.set(false) })
  await React.act(async () => { T.$newsDetailsOpen.set([]) })
  await React.act(async () => {
    root.render(React.createElement(QueryClientProvider, { client: queryClient },
      React.createElement(T.NewsPage)))
  })
  await React.act(async () => {
    for (let i = 0; i < 6; i += 1) await new Promise(resolve => setTimeout(resolve, 0))
  })
  const empty = container.querySelector('.wm-empty[role="status"]')
  assert.ok(empty, 'the empty state region renders')
  assert.ok(empty.textContent.trim().length > 0,
    'the empty state is never blank when the flat pool disagrees with the filter')
  assert.match(empty.textContent, /No updates match/,
    'the message reflects the actually filtered For You entries')
})

// --- Details panel identity: unambiguous tuples, connection isolation -------

test('details panel ids separate colliding model/provider tuples', async () => {
  // 'a:b' + 'c' and 'a' + 'b:c' concatenate to the same model:provider text;
  // the panel id must be an unambiguous tuple, never a joined string.
  const g1 = T.newsGroupModels([groupItem({ id: 'col-1', provider: 'c', model: 'a:b' })]).groups[0]
  const g2 = T.newsGroupModels([groupItem({ id: 'col-2', provider: 'b:c', model: 'a' })]).groups[0]
  assert.equal(g1.model, 'a:b')
  assert.equal(g2.model, 'a')
  await React.act(async () => { T.$newsDetailsOpen.set([]) })
  // A function component wrapper keeps renderNode's cloneElement(t) off the
  // Fragment (a bare Fragment rejects the prop with a React warning).
  const BothGroups = () => React.createElement(React.Fragment, null,
    React.createElement(T.NewsModelGroup, { group: g1, impacts: {}, t: translator('en'), matchedOffers: null }),
    React.createElement(T.NewsModelGroup, { group: g2, impacts: {}, t: translator('en'), matchedOffers: null }))
  const view = await renderNode(React.createElement(BothGroups), 'en')
  const ids = [...view.container.querySelectorAll('button[data-news-details]')]
    .map(button => button.getAttribute('aria-controls'))
  assert.equal(new Set(ids).size, 2,
    'the ambiguous model:provider concatenation must not collide')
  // The encoded form is a JSON tuple; every field boundary stays recoverable.
  const decoded = ids.map(id => JSON.parse(decodeURIComponent(id.replace(/^wm-news-panel-/, ''))))
  assert.deepEqual(decoded[0], ['', 'a:b', 'c'])
  assert.deepEqual(decoded[1], ['', 'a', 'b:c'])
})

test('an open Details panel never migrates to another connection', async () => {
  // The same model/provider exists on two connections. Opening Details on
  // connection A, then switching connections, must leave connection B's
  // identical offer closed — and connection A's own state comes back intact.
  let connection = 'gateway-a'
  const payloadFor = key => ({
    ok: true,
    local: {
      baseline: true, snapshot_at: '2026-11-01T00:00:00Z', removed_model_count: 0,
      items: [{
        id: `${key}-m1`, origin: 'local', category: 'price_reduction',
        provider: 'Acme', model: 'acme/m1',
        summary: 'Rates changed.', summary_code: '', summary_params: null,
        previous: { input: 5.0, output: 25.0, cache_read: null, cache_write: null },
        current: { input: 4.0, output: 25.0, cache_read: null, cache_write: null },
        has_tiers: false, observed_at: '2026-11-03T00:00:00Z', effective_at: '',
        source_url: '', provenance: '', confidence: 'observed',
        relevance: { relevant: true, reasons: ['configured_provider'] },
      }],
    },
    central: { items: [] }, impacts: {}, settings: { live_updates: true },
    signals: { configured_families: ['acme'] },
  })
  T.setRest(async path => path === '/news/refresh' ? payloadFor(connection) : { ok: true })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = ReactDOMClient.createRoot(container)
  roots.push(root)
  await React.act(async () => { T.$newsScope.set('all') })
  await React.act(async () => { T.$newsCategory.set('all') })
  await React.act(async () => { T.$newsSearch.set('') })
  await React.act(async () => { T.$newsDays.set(null) })
  await React.act(async () => { T.$newsShown.set(T.NEWS_PAGE_SIZE) })
  await React.act(async () => { T.$newsShowAll.set(false) })
  await React.act(async () => { T.$newsDetailsOpen.set([]) })
  await React.act(async () => {
    root.render(React.createElement(QueryClientProvider, { client: queryClient },
      React.createElement(T.NewsPage)))
  })
  const settle = async () => {
    await React.act(async () => {
      for (let i = 0; i < 6; i += 1) await new Promise(resolve => setTimeout(resolve, 0))
    })
  }
  await settle()
  try {
    const detailsButton = () => container.querySelector('button[data-news-details]')
    const opened = detailsButton()
    assert.ok(opened, 'the connection-A offer renders with its Details control')
    const idA = opened.getAttribute('aria-controls')
    await React.act(async () => { opened.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    assert.equal(detailsButton().getAttribute('aria-expanded'), 'true',
      'the panel opens on connection A')
    // Switch the real connection atom the way the host does; the page
    // refetches and renders connection B's identical model/provider.
    connection = 'gateway-b'
    await React.act(async () => { lib.$testConnectionId.set('gateway-b') })
    await settle()
    const buttonB = detailsButton()
    assert.ok(buttonB, 'the connection-B offer renders')
    const idB = buttonB.getAttribute('aria-controls')
    assert.notEqual(idB, idA, 'another connection never shares the panel id')
    assert.equal(buttonB.getAttribute('aria-expanded'), 'false',
      'the open Details state never migrates to another connection')
    // Back on connection A the user's own open panel is still there.
    connection = 'gateway-a'
    await React.act(async () => { lib.$testConnectionId.set('gateway-a') })
    await settle()
    assert.equal(detailsButton().getAttribute('aria-controls'), idA)
    assert.equal(detailsButton().getAttribute('aria-expanded'), 'true',
      'connection A keeps its own open panel')
  } finally {
    connection = 'gateway-a'
    await React.act(async () => { lib.$testConnectionId.set('gateway-a') })
  }
})

/** Ten relevant model groups plus one relevant plan, in memory, no fixture. */
const prefixPayload = () => ({
  ok: true,
  local: {
    baseline: true, snapshot_at: '2026-11-01T00:00:00Z', removed_model_count: 0,
    items: [
      // Exact recency ranks the plan card first; nothing is reordered by the
      // page afterwards.
      {
        id: 'plan-1', origin: 'local', category: 'subscription', provider: 'Acme', model: '',
        summary: 'Team: fee $100/month → $200/month.', summary_code: 'news_sum_plan_change',
        summary_params: { plan: 'Team', fee_before: '$100/month', fee_after: '$200/month' },
        previous: null, current: null, has_tiers: false,
        observed_at: '2026-11-03T00:00:00Z', effective_at: '', source_url: '',
        provenance: '', confidence: 'observed',
        relevance: { relevant: true, reasons: ['selected_plan_family'] },
        last_used_at: '2026-11-05T00:00:00Z',
      },
      ...Array.from({ length: 10 }, (_, i) => ({
        id: `n${i}`, origin: 'local', category: 'price_reduction',
        provider: 'Acme', model: `acme/model-${i}`,
        summary: `model-${i} changed.`, summary_code: '', summary_params: null,
        previous: { input: 5.0, output: 25.0, cache_read: null, cache_write: null },
        current: { input: 4.0, output: 25.0, cache_read: null, cache_write: null },
        has_tiers: false, observed_at: '2026-11-03T00:00:00Z', effective_at: '',
        source_url: '', provenance: '', confidence: 'observed',
        relevance: { relevant: true, reasons: ['configured_provider'] },
      })),
    ],
  },
  central: { items: [] }, impacts: {}, settings: { live_updates: true },
  signals: { configured_families: ['acme'], plan_families: ['team'] },
})

// The payload above carries fixed 2026-11 stamps, and newsUsedRecently reads
// Date.now: pin the render to a fixed instant just after those stamps so the
// 30-day recency window cannot expire with the real wall clock. Scoped to one
// call, so no other test sees the fake time.
const PINNED_NOW_MS = Date.parse('2026-11-10T12:00:00Z')
const atPinnedNow = async fn => {
  const realNow = Date.now
  Date.now = () => PINNED_NOW_MS
  try { return await fn() } finally { Date.now = realNow }
}

/** Render the settled For You page over `payload`; scope preset to For You. */
const renderPrefixPage = async payload => {
  T.setRest(async path => path === '/news/refresh' ? payload : { ok: true })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = ReactDOMClient.createRoot(container)
  roots.push(root)
  await React.act(async () => { T.$newsScope.set('foryou') })
  await React.act(async () => { T.$newsCategory.set('all') })
  await React.act(async () => { T.$newsSearch.set('') })
  await React.act(async () => { T.$newsDays.set(null) })
  await React.act(async () => { T.$newsShown.set(T.NEWS_PAGE_SIZE) })
  await React.act(async () => { T.$newsShowAll.set(false) })
  await React.act(async () => { T.$newsDetailsOpen.set([]) })
  await React.act(async () => {
    root.render(React.createElement(QueryClientProvider, { client: queryClient },
      React.createElement(T.NewsPage)))
  })
  await React.act(async () => {
    for (let i = 0; i < 6; i += 1) await new Promise(resolve => setTimeout(resolve, 0))
  })
  const c = () => container
  const list = () => c().querySelector('.wm-news-list[role="list"]')
  return { c, list }
}

test('For You shows the ranked prefix through the fifth model group, with the plan in place', () => atPinnedNow(async () => {
  const { c, list } = await renderPrefixPage(prefixPayload())
  // The initial page is the smallest ranked prefix through the FIFTH model
  // group: the plan card keeps its original rank ahead of it, so five model
  // groups AND the ranked plan are all visible — the fifth group is never
  // pushed behind the card.
  const groups = () => [...c().querySelectorAll('[data-news-group]')]
    .map(el => el.getAttribute('data-news-group'))
  assert.equal(groups().length, 5, 'the fifth model group is not displaced')
  assert.equal(groups().includes('acme/model-4') === true, true,
    'the fifth ranked model group renders on the initial page')
  assert.equal(c().querySelector('[data-news-plan]') === null, false,
    'the ranked plan card stays visible alongside the five groups')
  // Original rank preserved: the plan card is the first entry, then the
  // groups in rank order — no partition or reorder.
  assert.equal(list().children[0].getAttribute('data-news-plan') !== null, true,
    'the plan keeps its original ranked position')
  assert.equal(list().children[1].getAttribute('data-news-group'), 'acme/model-0')
  assert.equal(list().children[5].getAttribute('data-news-group'), 'acme/model-4')
  // Honest count labels over all ranked entries.
  assert.match(c().querySelector('[data-news-scope]').textContent, /11 updates/,
    'the For You tab counts all ranked entries honestly')
  // Entries remain beyond the prefix, so Show All is offered with the total.
  const showAll = c().querySelector('button[data-news-show-all]')
  assert.ok(showAll, 'entries remain beyond the prefix: Show All is offered')
  assert.match(showAll.textContent, /11/, 'Show All names the honest entry total')
  // Expanding reveals every entry, then focus moves to the FIRST NEWLY
  // revealed entry at the actual prior visible length (6 here), not a
  // constant index.
  await React.act(async () => { showAll.focus() })
  await React.act(async () => { showAll.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
  assert.equal(groups().length, 10, 'Show All reveals all ten model groups')
  assert.equal(c().querySelector('[data-news-plan]') !== null, true,
    'the plan card stays after expansion')
  assert.equal(list().children.length, 11, 'all ranked entries are listed')
  assert.equal(document.activeElement, list().children[6],
    'focus lands on the first newly revealed entry at the actual prior length')
  assert.equal(list().children[6].getAttribute('data-news-group'), 'acme/model-5',
    'the focused entry is the first one the expansion revealed')
  assert.equal(c().querySelector('button[data-news-show-all]') === null, true,
    'no Show All remains once every entry is visible')
}))

test('a groups-only For You keeps the exact five-group page with no Show All', () => atPinnedNow(async () => {
  const payload = prefixPayload()
  payload.local.items = payload.local.items.filter(item => item.model).slice(0, 5)
  const { c } = await renderPrefixPage(payload)
  const groups = [...c().querySelectorAll('[data-news-group]')]
    .map(el => el.getAttribute('data-news-group'))
  assert.deepEqual(groups, ['acme/model-0', 'acme/model-1', 'acme/model-2', 'acme/model-3', 'acme/model-4'],
    'exactly the old five-group initial page')
  assert.equal(c().querySelector('button[data-news-show-all]') === null, true,
    'five groups with no cards leave nothing behind: no Show All')
  assert.match(c().querySelector('[data-news-scope]').textContent, /5 updates/,
    'the honest entries count')
}))

test('the ranked prefix holds when the surrounding clock is far from the fixture dates', async () => {
  // Simulate a real clock long after the 2026-11 fixture stamps: without the
  // pinned render the plan loses its recency rank signal and the prefix
  // changes. The pin must decide, and the surrounding clock must come back.
  const realNow = Date.now
  const farFuture = Date.parse('2027-06-01T00:00:00Z')
  Date.now = () => farFuture
  try {
    await atPinnedNow(async () => {
      const { c, list } = await renderPrefixPage(prefixPayload())
      assert.equal(list().children[0].getAttribute('data-news-plan') !== null, true,
        'the plan keeps its rank under a clock far from the fixture dates')
      assert.equal([...c().querySelectorAll('[data-news-group]')].length, 5,
        'the fifth model group still renders under a far-future clock')
    })
    assert.equal(Date.now(), farFuture,
      'the pinned render restores the surrounding clock')
  } finally {
    Date.now = realNow
  }
})
