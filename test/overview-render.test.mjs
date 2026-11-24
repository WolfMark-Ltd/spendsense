/**
 * Overview financial semantics, structure and copy — rendered browserlessly.
 *
 * These assertions used to run inside `overview-layout.test.mjs`, once per
 * layout case (three widths × two themes × two locales) under `--dump-dom`:
 * the evidence kinds, their scopes, the caveats, the pricing action label and
 * the model ranking were re-verified twelve times per locale behind a Chromium
 * start and a virtual-time budget. None of them is geometry, so they belong
 * here — where they fail on the assertion in about a second.
 *
 * The payload is the SAME one the Chromium harness renders:
 * `test/overview-fixtures.mjs` is the single definition.
 *
 * Setup once: npm ci --prefix test/harness
 * Run with:   bash scripts/node-tests.sh browserless
 */
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { flat, loadPageHarness, translatorFor } from './render-harness.mjs'
import { overviewLedgerDays, overviewTransport } from './overview-fixtures.mjs'

const harness = await loadPageHarness()
const { T, React, ReactDOMClient, QueryClientProvider, queryClient, i18nBackend, plugin, dom, flush } = harness

plugin.register({
  rest: overviewTransport({ requiredContract: T.REQUIRED_BACKEND_CONTRACT }),
  storage: { get: (_key, fallback) => fallback, set() {}, delete() {} },
  register() {}, registerMany() {}, onDispose() {}, onEvent: () => () => {},
  setTimeout: fn => { const timer = setTimeout(fn, 0); return () => clearTimeout(timer) },
  setInterval: () => () => {}, addEventListener: () => () => {},
  os: {}, pet: null, i18n: { register() {}, t: key => key },
})

const roots = []

/**
 * Render the real OverviewPage over the shared fixture.
 *
 * The previous page is unmounted first: two mounted Overview pages share the
 * tooltip atom and the query cache, and an assertion left on the earlier
 * screen could pass vacuously.
 */
const boot = async ({ locale = 'en' } = {}) => {
  while (roots.length) {
    const previous = roots.pop()
    try { await React.act(async () => { previous.unmount() }) } catch { /* already gone */ }
  }
  queryClient.clear()
  T.$ledgerTab.set('overview')
  T.$infoOpen.set(null)
  T.$ledger.set({ ...T.emptyLedger(), days: overviewLedgerDays() })
  i18nBackend.t = translatorFor(T.I18N, locale)
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = ReactDOMClient.createRoot(container)
  roots.push(root)
  await React.act(async () => {
    root.render(React.createElement(QueryClientProvider, { client: queryClient },
      React.createElement(T.OverviewPage)))
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
    try { await React.act(async () => { root.unmount() }) } catch { /* already gone */ }
  }
  queryClient.clear()
})

/** One headline card, by its own kind rather than its position. */
const cardOf = (container, kind) => {
  const card = container.querySelector(`[data-kpi="${kind}"]`)
  assert.ok(card, `the ${kind} card renders`)
  const text = flat(card.textContent)
  return {
    card,
    text,
    label: flat(card.querySelector('.wm-kpi-eyebrow')?.textContent),
    figure: flat(card.querySelector('.wm-kpi-figure')?.textContent),
    scope: flat(card.querySelector('.wm-kpi-scope')?.textContent),
    provenance: flat(card.querySelector('.wm-kpi-prov')?.textContent),
    chips: [...card.querySelectorAll('.wm-certainty')].map(el => flat(el.textContent)),
  }
}

const LOCALES = ['en', 'zh']

test('Overview separates the four evidence kinds and their scopes, in both languages', async () => {
  for (const locale of LOCALES) {
    const container = await boot({ locale })
    const cards = [...container.querySelectorAll('.wm-product-summary .wm-kpi')]
    assert.deepEqual(cards.map(card => card.dataset.kpi),
      ['recorded-usage', 'actual-charges', 'api-equivalent-estimate', 'saved-fees'],
      `${locale}: four financial cards, in the accepted evidence order`)

    // Recorded usage: a local ledger price for every profile this calendar
    // month, labelled as a priced-at-capture value and never as a charge.
    const recorded = cardOf(container, 'recorded-usage')
    assert.equal(recorded.figure, T.fmtUsd(0.42),
      `${locale}: the recorded figure is the settled Desktop subtotal (${recorded.figure})`)
    assert.equal(recorded.scope, T.I18N[locale].ovRecordedScope,
      `${locale}: the recorded card states its window and scope`)
    assert.match(recorded.scope, locale === 'en' ? /all profiles.*calendar month to date/i : /所有配置文件.*本日历月至今/,
      `${locale}: recorded usage covers all profiles, calendar month to date`)
    assert.match(recorded.provenance, locale === 'en' ? /Desktop ledger.*not charges/i : /桌面账本.*并非服务商费用/,
      `${locale}: recorded usage is a ledger price, not a charge`)
    assert.equal(recorded.chips[0], T.I18N[locale].ovCertRecorded,
      `${locale}: the recorded figure carries its saved-rate basis`)
    assert.ok(recorded.chips.includes(T.I18N[locale].ovCertPartial),
      `${locale}: unpriced tokens mark the recorded subtotal Partial (${recorded.chips})`)

    // Actual provider charges: absent evidence keeps its own words and never
    // becomes a zero, a coverage count or a fraction of the aggregates.
    const charges = cardOf(container, 'actual-charges')
    assert.equal(charges.figure, T.I18N[locale].ovNotRecorded,
      `${locale}: a missing provider charge is Not recorded, never zero`)
    assert.ok(charges.chips.includes(T.I18N[locale].ovCertChargesUnknown),
      `${locale}: the charge card names the missing per-call evidence (${charges.chips})`)
    assert.doesNotMatch(charges.text, /[$£€]0\.00/,
      `${locale}: absent charge evidence is never printed as a zero amount`)
    assert.doesNotMatch(charges.text, /covers|\b\d+ of \d+ records\b/i,
      `${locale}: aggregate totals do not imply per-call charge coverage`)

    // The API-equivalent estimate is the active profile over a rolling window,
    // so it can never be added to the all-profile recorded figure.
    const estimate = cardOf(container, 'api-equivalent-estimate')
    assert.equal(estimate.figure, T.fmtUsd(12.34),
      `${locale}: the estimate is the 30-day analytics subtotal (${estimate.figure})`)
    assert.match(estimate.scope, locale === 'en' ? /active profile.*rolling 30 days/i : /当前配置文件.*滚动 30 天/,
      `${locale}: the estimate names the active profile and its rolling window`)
    assert.ok(estimate.chips.includes(T.I18N[locale].ovCertPartial),
      `${locale}: unpriced backend calls mark the estimate Partial (${estimate.chips})`)

    // Saved fees: one line per currency and period, partial when a fee is
    // unknown, and never converted into a monthly figure.
    const fees = cardOf(container, 'saved-fees')
    assert.match(fees.figure, /GBP 20\.00\/(mo|月)/,
      `${locale}: the fee card keeps the currency and billing period (${fees.figure})`)
    assert.equal(fees.provenance, T.I18N[locale].ovPlansConfirmed(1, 2),
      `${locale}: the fee card counts confirmed plans`)
    assert.ok(fees.chips.includes(T.I18N[locale].ovCertPartial),
      `${locale}: an unknown subscription fee marks the subtotal Partial (${fees.chips})`)

    // Nothing may present the two usage amounts as additive.
    const scopeNote = flat(container.querySelector('.wm-scope-note')?.textContent)
    assert.match(scopeNote, locale === 'en' ? /do not add them together/i : /请勿相加/,
      `${locale}: the page explains that the two usage amounts do not add`)
    assert.match(scopeNote, locale === 'en'
      ? /different profiles and periods/
      : /覆盖的配置文件和周期不同/,
      `${locale}: the scope note names why they are not comparable`)
  }
})

test('Overview never prefixes a measured figure with a lower-bound qualifier, in both languages', async () => {
  for (const locale of LOCALES) {
    const container = await boot({ locale })
    for (const kind of ['recorded-usage', 'api-equivalent-estimate']) {
      const { figure } = cardOf(container, kind)
      assert.match(figure, /^\$/, `${locale}: ${kind} leads with the amount (${figure})`)
      assert.doesNotMatch(figure, /at least|至少|≥/i,
        `${locale}: ${kind} keeps the figure prominent and puts the qualifier in a chip`)
    }
  }
})

test('Overview keeps five named methodology sections behind one collapsed disclosure, in both languages', async () => {
  for (const locale of LOCALES) {
    const container = await boot({ locale })
    const method = container.querySelector('details.wm-method')
    assert.ok(method, `${locale}: the methodology disclosure uses native details/summary`)
    assert.equal(method.open, false, `${locale}: methodology is collapsed by default`)
    assert.equal(flat(method.querySelector('summary')?.textContent), T.I18N[locale].ovMethodTitle,
      `${locale}: the disclosure names what it holds`)
    assert.equal(method.querySelectorAll('.wm-method-grid h3').length, 5,
      `${locale}: five methodology sections`)
    assert.deepEqual([...method.querySelectorAll('.wm-method-grid h3')].map(el => flat(el.textContent)), [
      T.I18N[locale].ovMethodUsageTitle, T.I18N[locale].ovMethodPricingTitle,
      T.I18N[locale].ovMethodChargesTitle, T.I18N[locale].ovMethodFeesTitle,
      T.I18N[locale].ovMethodModelsTitle,
    ], `${locale}: every methodology section is named`)
    // The two usage bases are explained as different things, not one total.
    assert.match(flat(method.textContent), locale === 'en'
      ? /not payments, invoices or actual provider charges/i
      : /并非付款、发票或实际服务商费用/,
      `${locale}: the methodology says the usage figures are estimates, not charges`)
  }
})

test('Overview ranks recorded calls, names models plainly and keeps their exact IDs, in both languages', async () => {
  for (const locale of LOCALES) {
    const container = await boot({ locale })
    const models = container.querySelector('.wm-overview-models')
    assert.ok(models, `${locale}: the ranking panel renders`)
    assert.equal(flat(models.querySelector('h2')?.textContent), T.I18N[locale].ovModelsTitle,
      `${locale}: the ranking panel names its window`)
    const rows = [...models.querySelectorAll('.wm-overview-model-row')]
    assert.equal(rows.length, 2, `${locale}: both backend models are ranked`)
    assert.equal(flat(rows[0].querySelector('.wm-overview-model-name strong')?.textContent),
      'GPT 5.1 Codex Super Long Model Name For Wrapping',
      `${locale}: a long route renders as its friendly model name`)
    assert.equal(flat(rows[1].querySelector('.wm-overview-model-name strong')?.textContent),
      'Claude Opus 4.6', `${locale}: the second model keeps its friendly name`)
    // The exact route stays reachable, one control per row.
    const ids = [...models.querySelectorAll('.wm-overview-model-name .wm-info-btn')]
    assert.equal(ids.length, 2, `${locale}: every ranked model offers its exact ID`)
    assert.equal(ids[0].getAttribute('aria-label'), T.I18N[locale].ovModelIdInfoLabel,
      `${locale}: the ID control is labelled for assistive technology`)
    await React.act(async () => ids[0].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
    assert.match(flat(container.querySelector('#wm-info-overview-model-0')?.textContent),
      /openai\/gpt-5\.1-codex-super-long-model-name-for-wrapping.*openai-codex/,
      `${locale}: the tooltip carries the exact model and provider IDs`)
    await React.act(async () => T.$infoOpen.set(null))
    // Ranking is calls, and it never re-offers the Usage destination that the
    // page's own attention strip and blank state already provide.
    assert.match(flat(models.textContent), locale === 'en' ? /15 calls/ : /15 次调用/,
      `${locale}: the ranking shows the call count`)
    assert.doesNotMatch(flat(models.textContent), /\$\d/,
      `${locale}: the ranking does not turn call counts into spend`)
    assert.deepEqual([...models.querySelectorAll('button')]
      .map(button => flat(button.textContent))
      .filter(label => label === T.I18N[locale].ovOpenUsage), [],
      `${locale}: Most-used models does not repeat the Usage shortcut`)
  }
})

test('Overview carries a concise Subscription value headline that links to Costs, in both languages', async () => {
  // F19: one flowing line — label, compact figures, status, inline link.
  // The fixture headline is unreadable, so the fail-closed None line renders.
  for (const locale of LOCALES) {
    const container = await boot({ locale })
    const strip = container.querySelector('[data-overview-econ]')
    assert.ok(strip, `${locale}: the Subscription value strip renders`)
    assert.equal(strip.tagName, 'P', `${locale}: the strip is one flowing paragraph`)
    assert.equal(flat(strip.querySelector('strong')?.textContent),
      T.I18N[locale].econOverviewLabel, `${locale}: the strip is labelled plainly`)
    assert.match(flat(strip.textContent),
      new RegExp(T.I18N[locale].econOverviewNone.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      `${locale}: an unreadable headline says so instead of implying a comparison`)
    const links = [...strip.querySelectorAll('button')]
      .filter(button => flat(button.textContent) === T.I18N[locale].econOverviewSeeCosts)
    assert.equal(links.length, 1, `${locale}: exactly one See Costs link`)
    await React.act(async () => links[0].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
    assert.equal(T.$ledgerTab.get(), 'costs', `${locale}: the link navigates to Costs`)
  }
})

test('the charges methodology links once to the About FAQ, in both languages', async () => {
  for (const locale of LOCALES) {
    const container = await boot({ locale })
    const method = container.querySelector('details.wm-method')
    const links = [...method.querySelectorAll('button')]
      .filter(button => flat(button.textContent) === T.I18N[locale].ovMethodChargesFaqLink)
    assert.equal(links.length, 1, `${locale}: exactly one FAQ link, in the charges section`)
    assert.equal(flat(links[0].closest('section').querySelector('h3')?.textContent),
      T.I18N[locale].ovMethodChargesTitle, `${locale}: the link sits with the charges explanation`)
    await React.act(async () => links[0].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
    assert.equal(T.$ledgerTab.get(), 'about', `${locale}: the link navigates to About & Support`)
  }
})
