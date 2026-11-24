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
const boot = async ({ locale = 'en', analyticsData = null } = {}) => {
  while (roots.length) {
    const previous = roots.pop()
    try { await React.act(async () => { previous.unmount() }) } catch { /* already gone */ }
  }
  queryClient.clear()
  T.setRest(async path => analyticsData && String(path).startsWith('/analytics?')
    ? analyticsData : defaultUsageTransport(path))
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

const statsOf = container => [...container.querySelectorAll('.wm-usage-summary .wm-kpi')].map(el => ({
  label: (() => {
    const label = el.querySelector('.wm-kpi-eyebrow')
    const infoLabel = label?.querySelector('.wm-stat-with-info')
    return flat(infoLabel?.firstChild?.textContent ?? label?.textContent)
  })(),
  value: flat(el.querySelector('.wm-kpi-figure')?.textContent),
  kind: el.getAttribute('data-kpi'),
}))

const chipsOf = container => [...container.querySelectorAll('.wm-scopechips button')].map(el => flat(el.textContent))
const advancedOf = container => container.querySelector('[data-filters-advanced]')
const advancedCount = container => flat(advancedOf(container)?.querySelector('summary')?.textContent)
const usageTotals = () => usageAnalytics().totals

const LOCALES = ['en', 'zh']
const defaultUsageTransport = usageTransport({ requiredContract: T.REQUIRED_BACKEND_CONTRACT })

test('read benefit uses backend basis and coverage, and unknown writes stay unknown', async () => {
  for (const locale of LOCALES) {
    const dict = T.I18N[locale]
    const data = usageAnalytics()
    data.totals.cache_write_state = 'unknown'
    data.economics = { ...data.economics, savings_basis: 'indeterminate', savings_usd: 99,
      read_benefit_usd: 1.25, read_benefit_basis: 'exact', read_benefit_calls: 5, read_benefit_tokens: 188224 }
    const container = await boot({ locale, analyticsData: data })
    assert.match(container.textContent, /\$1\.25/)
    assert.doesNotMatch(statsOf(container)[1].value, /\+/,
      `${locale}: rule 62 renders the benefit bare`)
    assert.equal(statsOf(container).length, 4, `${locale}: coverage details do not add normal-page text`)
    const benefitTip = container.querySelector('[aria-controls="wm-info-usage-read-benefit"]')
    await click(benefitTip)
    assert.ok(container.querySelector('#wm-info-usage-read-benefit')?.textContent.includes(
      dict.readBenefitCoverage(5, 1234, T.fmtTokens(188224))))
    assert.ok(container.querySelector('#wm-info-usage-read-benefit')?.textContent.includes(dict.readBenefitExplanation))
    assert.equal(statsOf(container)[1].value, '$1.25')
    const composition = [...container.querySelectorAll('.wm-panel')].find(panel => panel.textContent.includes(dict.usageCompTitle))
    assert.doesNotMatch(composition.textContent, /unknown|unclassified/i,
      `${locale}: unavailable cache evidence stays a quiet dash in the normal composition chart`)
    assert.ok(composition.textContent.includes(dict.usageStreamCacheWrite))
    assert.match(composition.textContent, /Cache write[^—]*—|缓存写入[^—]*—/)
    await click(composition.querySelector(`button[aria-label="${dict.usageCompSelect(dict.usageStreamInput)}"]`))
    assert.doesNotMatch(composition.textContent, /unknown|unclassified/i,
      `${locale}: selecting a known stream does not add a technical coverage warning`)
  }
})

test('read benefit refuses absent or indeterminate values and preserves directional bounds', () => {
  const t = translatorFor(T.I18N, 'en')
  assert.equal(T.readBenefitState({}, 4).available, false)
  assert.equal(T.readBenefitState({read_benefit_usd: 0, read_benefit_basis: 'indeterminate', read_benefit_calls: 1, read_benefit_tokens: 0}, 4).available, false)
  assert.equal(T.readBenefitState({read_benefit_usd: 0, read_benefit_basis: 'exact', read_benefit_calls: 5, read_benefit_tokens: 0}, 4).available, false)
  const reportedZero = T.readBenefitState({read_benefit_usd: 0, read_benefit_basis: 'exact', read_benefit_calls: 1, read_benefit_tokens: 0}, 1)
  assert.equal(T.readBenefitDisplay(t, reportedZero), '$0.00')
  assert.equal(T.analyticsComposition({cache_write_tokens: 0, cache_write_state: 'reported'}, t).find(row => row.id === 'cache_write_tokens').unknown, false)
  assert.equal(T.analyticsComposition({cache_write_tokens: 0, cache_write_state: 'unknown'}, t).find(row => row.id === 'cache_write_tokens').unknown, true)
  const base = {read_benefit_usd: -1, read_benefit_calls: 2, read_benefit_tokens: 100}
  for (const basis of ['exact', 'lower_bound', 'upper_bound']) {
    const benefit = T.readBenefitState({...base, read_benefit_basis: basis}, 4)
    assert.equal(benefit.available, true)
    assert.match(T.readBenefitDisplay(t, benefit), /−\$1\.00/)
  }
  for (const benefit of [0.19, 0.38]) {
    const state = T.readBenefitState({read_benefit_usd: benefit, read_benefit_basis: 'exact',
      read_benefit_calls: 1, read_benefit_tokens: 100000, uncached_usd: 999, cached_usd: 0}, 1)
    assert.equal(state.value, benefit, 'the backend value is retained across different rate bands')
  }
})

test('Usage keeps its headline to API-equivalent, read benefit and tokens, in both languages', async () => {
  for (const locale of LOCALES) {
    const container = await boot({ locale })
    const dict = T.I18N[locale]
    assert.equal(flat(container.querySelector('h1')?.textContent), dict.usageTitle,
      `${locale}: the page states its title`)

    const stats = statsOf(container)
    assert.deepEqual(stats.map(stat => stat.label),
      [dict.usageStatApiEquiv, dict.readBenefitLabel, dict.usageStatTokens, dict.usageStatCalls],
      `${locale}: four figures, in a direct reading order`)
    assert.equal(stats.length, 4, `${locale}: no duplicate or theoretical-savings tile`)
    assert.deepEqual(stats.map(stat => stat.kind),
      ['usage-api', 'usage-benefit', 'usage-tokens', 'usage-calls'],
      `${locale}: each card carries its own rail identity`)
    assert.equal(stats[0].value, '$82.40', `${locale}: rule 62 renders the priced subtotal bare`)
    assert.equal(stats[1].value, '$4.20', `${locale}: rule 62 renders the partial read benefit bare`)
    assert.equal(stats[2].value, T.fmtTokens(3141592),
      `${locale}: the token total is formatted, not rounded to a bare count`)
    assert.match(stats[3].value, /1,234/,
      `${locale}: the call count has its own card`)
    assert.equal(container.querySelectorAll('.wm-usage-summary .wm-kpi').length, 4,
      `${locale}: the normal summary contains only the four primary figures`)
    assert.equal(container.querySelector('.wm-nerd-mode'), null,
      `${locale}: no single disclosure buries the sections`)
    const benefitTip = container.querySelector('[aria-controls="wm-info-usage-read-benefit"]')
    assert.ok(benefitTip, `${locale}: read benefit keeps its adjacent tooltip`)
    await click(benefitTip)
    assert.ok(container.querySelector('#wm-info-usage-read-benefit')?.textContent.includes(
      dict.readBenefitCoverage(96, 1234, T.fmtTokens(72000))),
    `${locale}: call and token coverage stays in the tooltip`)
    const apiTip = container.querySelector('[aria-controls="wm-info-usage-api-equivalent"]')
    assert.ok(apiTip, `${locale}: the priced subtotal keeps its adjacent tooltip`)
    await click(apiTip)
    assert.ok(container.querySelector('#wm-info-usage-api-equivalent')?.textContent.includes(
      dict.usageCoverageRateBasis),
    `${locale}: the priced-subtotal note stays in the tooltip`)
  }
})

test('Usage renders the backend $196.99 read benefit without a second benefit card', async () => {
  for (const locale of LOCALES) {
    for (const state of ['known', 'partial']) {
      const container = await boot({ locale, analyticsData: usageAnalytics(state) })
      assert.equal(statsOf(container)[1].value, '$196.99',
        `${locale}/${state}: use backend read-benefit evidence with a bare figure`)
      assert.equal(container.querySelectorAll('#wm-usage-read-benefit').length, 1,
        `${locale}/${state}: one read-benefit figure`)
      assert.equal(container.querySelectorAll('.wm-usage-summary .wm-kpi').length, 4,
        `${locale}/${state}: no second benefit card`)
      assert.equal(container.querySelector('.wm-nerd-mode'), null,
        `${locale}/${state}: no single disclosure buries the sections`)
    }
    const unavailable = await boot({ locale, analyticsData: usageAnalytics('unavailable') })
    assert.equal(statsOf(unavailable)[1].value, '—', `${locale}: unavailable is not shown as zero`)
  }
})

test('Usage keeps signed net-saving analysis in its own open section, separate from read benefit', async () => {
  for (const locale of LOCALES) {
    const dict = T.I18N[locale]
    const cases = [
      { basis: 'range', low: -.4, high: .1,
        expected: dict.savingsRangeValue('−' + T.fmtUsd(.4), T.fmtUsd(.1)) },
      { basis: 'upper_bound', low: -.1, high: null,
        expected: dict.savingsUpperBoundValue('−' + T.fmtUsd(.1)) },
      { basis: 'lower_bound', low: .1, high: null,
        expected: dict.savingsLowerBoundValue(T.fmtUsd(.1)) }
    ]
    for (const item of cases) {
      const data = usageAnalytics()
      const economics = { ...data.economics, savings_usd: item.low, savings_usd_high: item.high,
        savings_basis: item.basis, coverage: .82 }
      data.economics = economics
      data.totals.economics = economics
      const container = await boot({ locale, analyticsData: data })
      assert.equal(statsOf(container)[1].value, '$4.20',
        `${locale} ${item.basis}: read benefit stays independent of net-savings evidence`)
      const panel = [...container.querySelectorAll('.wm-panel')].find(el =>
        flat(el.querySelector('h2')?.textContent) === dict.usageEconTitle)
      assert.equal(panel?.closest('details'), null,
        `${locale} ${item.basis}: the economics panel renders openly`)
      assert.equal(flat(panel?.querySelector('.wm-compositiontotal')?.textContent), item.expected,
        `${locale} ${item.basis}: the economics panel uses the same signed bound`)
      assert.ok(flat(panel?.textContent).includes(dict.usageEconBound),
        `${locale} ${item.basis}: the panel badge identifies a qualified estimate`)
    }
  }
})

test('Usage numbers seven sections 01–07 and names every panel, in both languages', async () => {
  for (const locale of LOCALES) {
    const container = await boot({ locale })
    const dict = T.I18N[locale]
    const numbers = [...container.querySelectorAll('.wm-panel .wm-number')].map(el => el.textContent)
    assert.equal(numbers.length, 7, `${locale}: every panel is numbered`)
    assert.deepEqual([...numbers].sort(), ['01', '02', '03', '04', '05', '06', '07'],
      `${locale}: section numbers remain unique and cover 01–07`)
    assert.equal(container.querySelectorAll('section.wm-panel').length, 7,
      `${locale}: seven numbered panels`)
    assert.deepEqual([...container.querySelectorAll('.wm-panel h2')].map(el => flat(el.textContent)), [
      dict.usageDistTitle, dict.usageTrendPanelTitle, dict.usageDelegTitle, dict.usageRankTitle,
      dict.usageCompTitle, dict.usageExplorerTitle, dict.usageEconTitle,
    ], `${locale}: every panel keeps its own title in reading order`)
    assert.deepEqual([...container.querySelectorAll('.wm-panel .wm-number')].map(el => el.textContent),
      ['01', '02', '03', '04', '05', '06', '07'],
      `${locale}: section numbers run consecutively in reading order`)
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

test('Usage keeps coverage open with billing, method notes and a collapsed baseline', async () => {
  for (const locale of LOCALES) {
    const container = await boot({ locale })
    const dict = T.I18N[locale]
    const coverage = container.querySelector('.wm-coverage[role="region"]')
    assert.ok(coverage, `${locale}: one Data coverage section renders`)
    assert.equal(coverage.closest('details'), null,
      `${locale}: coverage is its own open section, not buried in a disclosure`)
    assert.equal(coverage.querySelector('.wm-badge'), null,
      `${locale}: rule 62 keeps the routine certainty badge off the coverage header`)
    // The baseline is a separate cumulative estimate, not part of the period.
    const baseline = container.querySelector('details.wm-baseline')
    assert.ok(baseline, `${locale}: the historical baseline is present`)
    assert.equal(baseline.open, false, `${locale}: the baseline stays collapsed`)
    assert.equal(flat(baseline.querySelector('summary')?.textContent), dict.usageBaselineSummaryTitle,
      `${locale}: the baseline states that it is a separate estimate`)
    // Report-specific notes stay; general methodology moved to the FAQ.
    const notes = container.querySelector('.wm-method-notes')
    assert.ok(notes?.textContent.includes(dict.usageRecordingLine('x', 'y').slice(0, 4)),
      `${locale}: the recording scope stays inline`)
    assert.equal(flat(notes?.textContent).includes(flat(dict.usageCacheFormula).slice(0, 24)), false,
      `${locale}: the general formula left the page for the FAQ`)
    assert.ok(notes?.textContent.includes(dict.usageMethodFaqLink),
      `${locale}: the method notes link to the FAQ`)
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

test('Usage keeps billing and cache methodology available, in both languages', async () => {
  for (const locale of LOCALES) {
    const container = await boot({ locale })
    const dict = T.I18N[locale]
    // The shell, not the whole container: the page carries its own <style>.
    const text = flat(container.querySelector('.wm-shell')?.textContent)
    assert.ok(text.includes(dict.usageCoverageCharges),
      `${locale}: provider charges stay not recorded (${dict.usageCoverageCharges})`)
    assert.ok(text.includes(dict.usageBillingLabel.trim()),
      `${locale}: the recorded-cost classification stays visible`)
    assert.ok(text.includes(dict.usageMethodFaqLink),
      `${locale}: the method notes link to the FAQ`)
    assert.equal(text.includes(flat(dict.usageCacheFormula).slice(0, 24)), false,
      `${locale}: the general formula lives in the FAQ, not on the page`)
  }
})

test('priced shares never round an incomplete population up to 100%', () => {
  assert.equal(T.sharePercent(1037304578, 1037452400), '99.99%',
    'the F76 population gains precision instead of a complete verdict')
  assert.equal(T.sharePercent(9000, 10000), '90.0%')
  assert.equal(T.sharePercent(9995, 10000), '99.95%')
  assert.equal(T.sharePercent(1999999, 2000000), '99.9999%',
    'precision escalates rather than capping or rounding up')
  assert.equal(T.sharePercent(10000, 10000), '100.0%', 'a genuinely complete share keeps its verdict')
  assert.equal(T.sharePercent(0, 0), null)
  assert.equal(T.analyticsListPartial({ unpriced_tokens: 0, unpriced_calls: 0,
    economics: { api_equivalent_basis: 'exact' } }), false)
  assert.equal(T.analyticsListPartial({ unpriced_tokens: 5, unpriced_calls: 0,
    economics: { api_equivalent_basis: 'exact' } }), true)
  assert.equal(T.analyticsListPartial({ unpriced_tokens: 0, unpriced_calls: 0, economics: {} }), true,
    'an absent basis stays incomplete')
})
