/**
 * Usage structure, copy and filter state — rendered browserlessly.
 *
 * These assertions used to run inside `usage-layout.test.mjs`, once per
 * locale × host-token variant × layout case: sixteen repetitions of the same
 * section numbering, KPI labels, filter inventory, chip state and disclosure
 * counts, all under `--dump-dom` behind a Chromium start and an 8 s
 * virtual-time budget. They are DOM and copy, not paint or geometry, so they
 * belong here.
 *
 * Chromium keeps what only a browser can report: CSS-variable resolution for
 * the shared state styles, SVG paint and contrast, sticky columns, horizontal
 * table scrolling, nested-scroll freedom, filter overlap and KPI overflow.
 *
 * The payload is the SAME one the Chromium harness renders:
 * `test/usage-fixtures.mjs` is the single definition.
 *
 * Setup once: npm ci --prefix test/harness
 * Run with:   bash scripts/node-tests.sh browserless
 */
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { flat, loadPageHarness, translatorFor } from './render-harness.mjs'
import { USAGE_FILTERS, usageAnalytics, usageTransport } from './usage-fixtures.mjs'

const harness = await loadPageHarness({
  // The test atoms live in `real-sdk.mjs`; re-exported through the bundle so
  // the suite and the plugin share one nanostores instance.
  extraExports: "export { $testConnectionId, $testProfile } from '@hermes/plugin-sdk'",
})
const {
  T, React, ReactDOMClient, QueryClientProvider, queryClient, i18nBackend, plugin, dom, flush,
  $testConnectionId, $testProfile,
} = harness

plugin.register({
  rest: usageTransport({ requiredContract: T.REQUIRED_BACKEND_CONTRACT }),
  storage: { get: (_key, fallback) => fallback, set() {}, delete() {} },
  register() {}, registerMany() {}, onDispose() {}, onEvent: () => () => {},
  setTimeout: fn => { const timer = setTimeout(fn, 0); return () => clearTimeout(timer) },
  setInterval: () => () => {}, addEventListener: () => () => {},
  os: {}, pet: null, i18n: { register() {}, t: key => key },
})

const roots = []
const scope = () => T.analyticsScope('default', 'connected', 'gateway-a')

/**
 * Render the real Usage page the way production does: inside the product
 * shell, over the shared fixture and the shared active-filter set.
 *
 * The previous page is unmounted first — two mounted pages share one analytics
 * atom, so a click in one would re-render both and an assertion could pass on
 * the wrong screen.
 */
const boot = async ({ locale = 'en' } = {}) => {
  while (roots.length) {
    const previous = roots.pop()
    try { await React.act(async () => { previous.unmount() }) } catch { /* already gone */ }
  }
  queryClient.clear()
  $testConnectionId.set('gateway-a')
  $testProfile.set('default')
  i18nBackend.t = translatorFor(T.I18N, locale)
  T.$analyticsFocus.set(null)
  T.$ledgerTab.set('usage')
  T.$analytics.set({ [scope()]: { ...T.analyticsInitialState(), trendIndex: 0, filters: { ...USAGE_FILTERS } } })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = ReactDOMClient.createRoot(container)
  roots.push(root)
  await React.act(async () => {
    root.render(React.createElement(QueryClientProvider, { client: queryClient },
      React.createElement(T.AnalyticsPage, { productPage: true })))
  })
  await flush()
  return container
}

after(() => {
  queryClient.clear()
  dom.window.close()
  harness.close()
})
test.afterEach(async () => {
  while (roots.length) {
    const root = roots.pop()
    try { await React.act(async () => { await root.unmount() }) } catch { /* already gone */ }
  }
  queryClient.clear()
})

const click = async element => {
  assert.ok(element, 'the control to click renders')
  await React.act(async () => element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
  await flush(3)
}

const statsOf = container => [...container.querySelectorAll('.wm-stat')].map(el => ({
  label: flat(el.querySelector('.wm-statlabel')?.textContent),
  value: flat(el.querySelector('.wm-statvalue')?.textContent),
  hints: [...el.querySelectorAll('.wm-subtle')].map(hint => flat(hint.textContent)),
}))

const chipsOf = container => [...container.querySelectorAll('.wm-scopechips button')].map(el => flat(el.textContent))
const advancedOf = container => container.querySelector('[data-filters-advanced]')
const advancedCount = container => flat(advancedOf(container)?.querySelector('summary')?.textContent)
const usageTotals = () => usageAnalytics().totals

const LOCALES = ['en', 'zh']

test('Usage states five headline figures in two labelled groups, in both languages', async () => {
  for (const locale of LOCALES) {
    const container = await boot({ locale })
    const dict = T.I18N[locale]
    assert.equal(flat(container.querySelector('h1')?.textContent), dict.usageTitle,
      `${locale}: the page states its title`)

    const groups = [...container.querySelectorAll('[data-kpi-group]')]
    assert.deepEqual(groups.map(el => el.dataset.kpiGroup), ['money', 'activity'],
      `${locale}: the figures keep a money group and an activity group`)
    assert.deepEqual(groups.map(el => el.getAttribute('aria-label')),
      [dict.usageKpiMoney, dict.usageKpiActivity], `${locale}: each group is named for assistive technology`)
    assert.ok(groups.every(el => el.getAttribute('role') === 'group'),
      `${locale}: the separators are real groups, not styling`)

    const stats = statsOf(container)
    assert.deepEqual(stats.map(stat => stat.label),
      [dict.usageStatApiEquiv, dict.usageStatSavings, dict.usageStatCoverage, dict.weightedCacheHit, dict.usageStatTokens],
      `${locale}: five figures, in the accepted order`)

    // The pricing qualifier states two different denominators: the share of
    // tokens that carry a price, and the calls that lack evidence.
    const pricing = T.analyticsPricing(usageTotals(), translatorFor(T.I18N, locale))
    assert.equal(stats[0].hints[0], pricing,
      `${locale}: the API-equivalent figure carries its own priced/partial qualifier`)
    assert.match(pricing, locale === 'en'
      ? /Partial · 96\.0% priced · 6 calls incomplete/
      : /部分 · 96\.0% 已定价 · 6 次调用不完整/,
      `${locale}: a partly priced subtotal keeps token and call coverage separate (${pricing})`)
    // A measured cash figure is not the same thing as a theoretical saving.
    assert.equal(stats[1].value, T.fmtUsd(3.2),
      `${locale}: the savings figure is the measured net saving (${stats[1].value})`)
    assert.equal(stats[1].hints.at(-1), dict.usageStatSavingsExtra('82.0%'),
      `${locale}: the saving states its own coverage`)
    assert.equal(stats[2].value, '96.0%', `${locale}: pricing coverage is the backend's own figure`)
    assert.equal(stats[3].value, '61.0%', `${locale}: the cache hit rate is the weighted reading`)
    assert.equal(stats[3].hints[0], dict.cacheCoveragePrompt('66.0%'),
      `${locale}: the cache reading states the coverage behind it`)
    assert.equal(stats[4].value, T.fmtTokens(3141592),
      `${locale}: the token total is formatted, not rounded to a bare count`)
    assert.match(stats[4].hints[0], /1,234/,
      `${locale}: the call count is stated beside the token total`)
  }
})

test('Usage numbers seven sections 01–07 and names every panel, in both languages', async () => {
  for (const locale of LOCALES) {
    const container = await boot({ locale })
    const dict = T.I18N[locale]
    assert.deepEqual([...container.querySelectorAll('.wm-panel .wm-number')].map(el => el.textContent),
      ['01', '02', '03', '04', '05', '06', '07'], `${locale}: every section is numbered 01–07`)
    assert.equal(container.querySelectorAll('section.wm-panel').length, 7,
      `${locale}: seven numbered panels`)
    assert.deepEqual([...container.querySelectorAll('.wm-panel h2')].map(el => flat(el.textContent)), [
      dict.usageDistTitle, dict.usageTrendPanelTitle, dict.usageDelegTitle, dict.usageRankTitle,
      dict.usageCompTitle, dict.usageExplorerTitle, dict.usageEconTitle,
    ], `${locale}: every panel keeps its own title`)
  }
})

test('Usage keeps seven filters, four of them behind a disclosure that counts active slices, in both languages', async () => {
  for (const locale of LOCALES) {
    const container = await boot({ locale })
    const dict = T.I18N[locale]
    // Four filters compose their accessible name as `usageFilterTip(name)`;
    // period, operation and delegation carry a full label of their own.
    assert.deepEqual([...container.querySelectorAll('select')].map(el => el.getAttribute('aria-label')), [
      dict.usageFilterPeriodTip, dict.usageFilterTip(dict.usageFilterModelName),
      dict.usageFilterTip(dict.usageFilterProviderName), dict.usageFilterTip(dict.usageFilterSurfaceName),
      dict.usageFilterTip(dict.usageFilterTaskName), dict.usageFilterOpTip, dict.usageFilterDelegTip,
    ], `${locale}: all seven filters keep their labels`)

    const advanced = advancedOf(container)
    assert.ok(advanced, `${locale}: the advanced filters stay behind a disclosure`)
    assert.equal(advanced.open, false, `${locale}: the advanced row is closed by default`)
    assert.equal(advanced.querySelectorAll('select').length, 4,
      `${locale}: surface, task, parent and scope hide behind the disclosure`)
    assert.equal(advancedCount(container), dict.usageFilterAdvanced(2),
      `${locale}: the disclosure states how many advanced slices are active`)

    // The three active slices are one chip each, named in the chosen language.
    assert.deepEqual(chipsOf(container), [
      dict.usageFilterChip(dict.usageFilterChipModel, 'Synthetic Very Long Model Name For Narrow Width Wrapping Checks'),
      dict.usageFilterChip(dict.usageFilterChipSurface, 'telegram'),
      dict.usageFilterChip(dict.usageFilterChipScope, T.usageFilterChipValue('scope', 'subagent', translatorFor(T.I18N, locale))),
    ], `${locale}: every active filter is a removable chip with its own vocabulary`)
  }
})

test('Usage drops a filter from its chip and the disclosure count follows, in both languages', async () => {
  for (const locale of LOCALES) {
    const container = await boot({ locale })
    const dict = T.I18N[locale]

    // Surface is an advanced slice; removing it must decrement the count.
    assert.equal(chipsOf(container).length, 3, `${locale}: the fixture starts with three chips`)
    await click(container.querySelectorAll('.wm-scopechips button')[1])
    assert.equal(chipsOf(container).length, 2, `${locale}: removing the surface chip leaves two`)
    assert.match(advancedCount(container), /1/, `${locale}: the disclosure count drops to one`)
    assert.equal(T.$analytics.get()[scope()].filters.surface, '',
      `${locale}: the removed slice leaves the query state`)

    // Removing the model chip leaves the third (scope) slice alone.
    await click(container.querySelectorAll('.wm-scopechips button')[0])
    assert.equal(chipsOf(container).length, 1, `${locale}: removing the model chip leaves one`)
    assert.equal(T.$analytics.get()[scope()].filters.model, '',
      `${locale}: the exact model filter is cleared, not just the label`)

    // The disclosure itself still opens and closes. It is an uncontrolled
    // <details>: the open state belongs to the DOM, not to the page reducer.
    const advanced = advancedOf(container)
    assert.equal(advanced.open, false, `${locale}: the advanced row starts closed`)
    await click(advanced.querySelector('summary'))
    assert.equal(advancedOf(container).open, true, `${locale}: the disclosure opens on activation`)
    await click(advancedOf(container).querySelector('summary'))
    assert.equal(advancedOf(container).open, false, `${locale}: the disclosure closes again`)
    assert.doesNotMatch(flat(container.textContent), /× Close|× 关闭/,
      `${locale}: the page offers no redundant Close action`)
  }
})

test('Usage keeps methodology and baseline collapsed, and leaves one coverage disclosure, in both languages', async () => {
  for (const locale of LOCALES) {
    const container = await boot({ locale })
    const dict = T.I18N[locale]
    const disclosures = [...container.querySelectorAll('.wm-shell details')]
    const methodology = disclosures.find(el => !el.hasAttribute('data-filters-advanced') && !el.classList.contains('wm-baseline')
      && flat(el.querySelector('summary')?.textContent) === dict.usageMethodologyTitle)
    assert.ok(methodology, `${locale}: the methodology disclosure is present and named`)
    assert.equal(methodology.open, false, `${locale}: methodology stays collapsed`)
    // The baseline is a separate cumulative estimate, not part of the period.
    const baseline = container.querySelector('details.wm-baseline')
    assert.ok(baseline, `${locale}: the historical baseline is present`)
    assert.equal(baseline.open, false, `${locale}: the baseline stays collapsed`)
    assert.equal(flat(baseline.querySelector('summary')?.textContent), dict.usageBaselineSummaryTitle,
      `${locale}: the baseline states that it is a separate estimate`)
    // Exactly one coverage summary region keeps the page's inference visible.
    assert.equal(container.querySelectorAll('.wm-coverage[role="region"]').length, 1,
      `${locale}: one Data coverage summary, not one per panel`)
  }
})

test('Usage offers exact chart values on hover and keeps every point and legend row titled, in both languages', async () => {
  for (const locale of LOCALES) {
    const container = await boot({ locale })
    const dict = T.I18N[locale]
    const points = [...container.querySelectorAll('[data-trend-point]')]
    assert.equal(points.length, 7, `${locale}: the trend renders one point per day`)
    assert.ok(points.every(point => (point.querySelector('title')?.textContent || '').length > 0),
      `${locale}: every trend point carries its exact values on hover`)
    const legend = [...container.querySelectorAll('.wm-legend .wm-legendrow')]
    assert.ok(legend.length > 0, `${locale}: the distribution legend renders rows`)
    assert.ok(legend.every(row => (row.getAttribute('title') || '').length > 0),
      `${locale}: every legend row carries its exact figure on hover`)

    // The four token streams stay named, and the composition key states exact
    // token counts rather than only the rounded bar values.
    assert.equal(container.querySelectorAll('.wm-chartkey .wm-dot').length, 4,
      `${locale}: four token streams are named`)
    const streams = T.analyticsComposition(usageTotals(), translatorFor(T.I18N, locale))
    for (const stream of streams) {
      assert.ok(flat(container.querySelector('.wm-chartkey')?.textContent).includes(stream.label),
        `${locale}: the chart key names ${stream.label}`)
    }
    const keyRows = [...container.querySelectorAll('.wm-compositionkey .wm-legendrow')]
    assert.equal(keyRows.length, 4, `${locale}: the composition key has one row per stream`)
    const readStream = streams.find(stream => stream.id === 'cache_read_tokens')
    const readRow = keyRows.find(row => flat(row.textContent).includes(readStream.label))
    assert.ok(readRow, `${locale}: the composition key names cache read`)
    assert.match(readRow.getAttribute('title') || '', /1,900,000/,
      `${locale}: the key states the exact cache-read count (${readRow.getAttribute('title')})`)
    // The selected trend point's detail states the exact per-day counts, not
    // the rounded bar value.
    assert.match(flat(container.querySelector('.wm-chartdetail')?.textContent), /72,000/,
      `${locale}: the selected trend point shows the exact cache-read count`)
  }
})

test('Usage keeps its billing and cache honesty copy on the rendered page, in both languages', async () => {
  for (const locale of LOCALES) {
    const container = await boot({ locale })
    const dict = T.I18N[locale]
    // The shell, not the whole container: the page carries its own <style>.
    const text = flat(container.querySelector('.wm-shell')?.textContent)
    assert.ok(text.includes(dict.usageStatSavings),
      `${locale}: the cache saving is named as theoretical, not cash`)
    assert.ok(text.includes(dict.usageCoverageCharges),
      `${locale}: provider charges stay not recorded (${dict.usageCoverageCharges})`)
    assert.ok(text.includes(dict.usageBillingLabel.trim()),
      `${locale}: the recorded-cost classification stays visible`)
    assert.ok(text.includes(dict.usageStatCoverage),
      `${locale}: the pricing-coverage figure stays named`)
    assert.ok(text.includes(dict.usageMethodologyTitle),
      `${locale}: the methodology disclosure stays available`)
  }
})
