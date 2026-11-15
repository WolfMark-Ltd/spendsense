// Run: node --test --test-force-exit test/*.test.mjs
//
// Subscription economics helper regressions through the same stub loader the
// other suites use (no React needed). Rendered-section tests live in
// test/economics-render.test.mjs, which must stay a separate file: tests
// registered after the harness's late top-level await are silently dropped
// by the runner when both loaders share one module.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'

// --- part 1: stub loader for the pure helpers ------------------------------
const src = readFileSync(new URL('../desktop/plugin.js', import.meta.url), 'utf8')
const stub = `
const atom = v => { let s = v; return { get: () => s, set: n => { s = n }, listen: () => () => {} } }
const gatewayActivationEpoch = () => 1
const computed = (stores, cb) => {
  const list = Array.isArray(stores) ? stores : [stores]
  return { get: () => cb(...list.map(s => s.get())), listen: () => () => {} }
}
const noop = () => null
const Badge = noop, Button = noop, Codicon = noop, SegmentedControl = noop, Tip = noop
const cn = (...a) => a.filter(Boolean).join(' ')
const host = { state: { focusedSessionId: { get: () => null, listen: () => () => {} }, focusedStoredSessionId: { get: () => null, listen: () => () => {} }, profile: { get: () => '' }, focusedSessionProfile: { get: () => '' } }, notify() {}, navigate() {}, request: async () => null }
const useEffect = noop
const useRef = initial => ({ current: initial })
const queryClient = { fetchQuery: async q => q.queryFn(), getQueryData: () => null }
const usePluginI18n = noop, useQuery = noop, useValue = noop
const jsx = noop, jsxs = noop
`
const stubBody = src
  .replace(/import \{[^}]*\} from '@hermes\/plugin-sdk'\n/, stub)
  .replace(/import \{[^}]*\} from 'react'\n/, '')
  .replace(/import \{ jsx, jsxs \} from 'react\/jsx-runtime'\n/, '')
globalThis.window = { location: { hash: '' }, addEventListener() {}, removeEventListener() {} }
const stubDir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'tcm-econ-'))
const stubFile = join(stubDir, 'plugin.mjs')
writeFileSync(stubFile, stubBody)
const S = (await import(pathToFileURL(stubFile).href)).__test
const en = (key, ...args) => {
  const entry = S.I18N.en[key]
  return typeof entry === 'function' ? entry(...args) : entry ?? key
}
const zh = (key, ...args) => {
  const entry = S.I18N.zh[key]
  return typeof entry === 'function' ? entry(...args) : entry ?? key
}

test('fmtDay renders renewal dates as UTC calendar days', () => {
  assert.equal(S.fmtDay('2027-01-15T00:00:00Z'), '2027-01-15')
  assert.equal(S.fmtDay('not a date'), '—')
  assert.equal(S.fmtDay(null), '—')
})

test('econStatusLabel covers every backend status', () => {
  assert.equal(S.econStatusLabel(en, 'ok'), 'Complete')
  assert.equal(S.econStatusLabel(en, 'partial'), 'Partial')
  assert.equal(S.econStatusLabel(en, 'unavailable'), 'Unavailable')
  assert.equal(S.econStatusLabel(en, 'bogus'), 'Unavailable')
})

test('econCoverageLabel never reports unknown pricing as priced', () => {
  assert.equal(S.econCoverageLabel(en, null), 'No usage observed')
  assert.equal(S.econCoverageLabel(en, { tokens: 0, list_usd: 0 }), 'No usage observed')
  assert.equal(S.econCoverageLabel(en, { tokens: 10, list_usd: null }), 'No published price')
  assert.equal(S.econCoverageLabel(en, { tokens: 10, list_usd: 1, coverage: null }), 'Coverage unknown')
  assert.equal(S.econCoverageLabel(en, { tokens: 10, list_usd: 1, coverage: 1 }), 'Coverage unknown')
  assert.equal(S.econCoverageLabel(en, { tokens: 10, list_usd: 1, coverage: 0.5 }), '50% priced')
})

test('econCoverageLabel withholds fully priced on rounded 100% coverage', () => {
  // 3M priced + 1 unpriced token rounds coverage to 1.0; the label must
  // not contradict the partial backend status shown in the same cell.
  assert.equal(S.econCoverageLabel(en,
    { tokens: 3000001, list_usd: 6, coverage: 1, unpriced_tokens: 1, unpriced_calls: 0 }), 'Nearly all priced')
  assert.equal(S.econCoverageLabel(en,
    { tokens: 3000000, list_usd: 6, coverage: 1, unpriced_tokens: 0, unpriced_calls: 0 }), 'Fully priced')
  assert.equal(S.econCoverageLabel(en,
    { tokens: 3000000, list_usd: 6, coverage: 1, unpriced_tokens: 0, unpriced_calls: undefined }), 'Coverage unknown')
  assert.equal(S.econCoverageLabel(en,
    { tokens: 3000000, list_usd: 6, coverage: 1, unpriced_tokens: 0, unpriced_calls: 1 }), 'Nearly all priced')
  assert.equal(S.econCoverageLabel(en,
    { tokens: 3000000, list_usd: 6, coverage: 1.01, unpriced_tokens: 0, unpriced_calls: 0 }), 'Coverage unknown')
  // Whole-percent rounding reaches 100% well before the ratio does.
  assert.equal(S.econCoverageLabel(en,
    { tokens: 1000, list_usd: 2, coverage: 0.9995, unpriced_tokens: 1, unpriced_calls: 0 }), 'Nearly all priced')
  assert.equal(S.econCoverageLabel(zh,
    { tokens: 3000001, list_usd: 6, coverage: 1, unpriced_tokens: 1, unpriced_calls: 0 }), '几乎全部定价')
})

test('econFeeLines keeps one line per currency', () => {
  assert.deepEqual(S.econFeeLines(en, []), ['—'])
  assert.deepEqual(S.econFeeLines(en, null), ['—'])
  assert.deepEqual(S.econFeeLines(en, [
    { amount: 20, currency: 'USD' }, { amount: 4.25, currency: 'GBP' }
  ]), ['USD 20.00/mo', 'GBP 4.25/mo'])
})

test('economics fee lines localise unknown currency disclosures', () => {
  assert.match(S.econFeeLines(zh, [{ amount: 12, currency: 'XYZ' }])[0], /币种未知 12\.00/)
})

test('fxWrite posts the whole document and surfaces the server sentence', async () => {
  const calls = []
  const transport = async (path, opts) => {
    calls.push({ path, ...opts })
    return { ok: true, rates: opts.body.rates }
  }
  const rates = [{ currency: 'GBP', usd_per_unit: 1.25, as_of: '2026-10-31', source: 'Example' }]
  const result = await S.fxWrite(rates, transport)
  assert.equal(calls[0].path, '/membership/fx')
  assert.equal(calls[0].method, 'PUT')
  assert.deepEqual(calls[0].body, { rates })
  assert.deepEqual(result.rates, rates)
  await assert.rejects(S.fxWrite(rates, async () => ({ ok: false, detail: 'bad rate' })), /bad rate/)
  await assert.rejects(S.fxWrite(rates, null), /bridge/)
})

test('fxErrorMessage keeps validation detail and translates transport states', () => {
  assert.match(S.fxErrorMessage(en, new Error('unsupported currency: XX')), /unsupported currency/)
  assert.match(S.fxErrorMessage(en, new Error('404 not found')), /not available in the running backend/)
  assert.match(S.fxErrorMessage(en, new Error('401 expired')), /expired/)
  assert.match(S.fxErrorMessage(en, new Error('conflict 409')), /changed since you loaded/)
})

test('fxErrorMessage hides transport failures behind the generic sentence', () => {
  const generic = 'The rates could not be saved. Please retry; if it persists, check the backend log.'
  assert.equal(S.fxErrorMessage(en, new Error('request failed with status 500')), generic)
  assert.equal(S.fxErrorMessage(en, new Error('500 Internal Server Error: pool exhausted')), generic)
  assert.equal(S.fxErrorMessage(en, new Error('request timed out after 30000ms')), generic)
  assert.equal(S.fxErrorMessage(en, new Error('fetch failed: connection refused')), generic)
  assert.equal(S.fxErrorMessage(en, new Error('')), generic)
  assert.equal(S.fxErrorMessage(en, null), generic)
  // The server's plain validation detail still passes through.
  assert.match(S.fxErrorMessage(en, new Error('422: usd_per_unit must be a positive number')),
    /usd_per_unit must be a positive number/)
  assert.doesNotMatch(S.fxErrorMessage(en, new Error('422: usd_per_unit must be a positive number')), /422/)
  // A 422 transport message with no colon fails closed instead of leaking.
  const rejected = 'The rates were rejected. Check each rate and retry.'
  assert.equal(S.fxErrorMessage(en, new Error('request failed with status 422')), rejected)
  assert.equal(S.fxErrorMessage(en, new Error('422')), rejected)
  assert.equal(S.fxErrorMessage(en, new Error('validation error: failed with status 422')), rejected)
})

test('fxErrorMessage only treats 400-599 as statuses', () => {
  // Ordinary numbers in validation detail stay visible.
  assert.match(S.fxErrorMessage(en, new Error('422: name must be under 255 characters')),
    /name must be under 255 characters/)
  assert.match(S.fxErrorMessage(en, new Error('422: rate has 100 days of history')), /100 days/)
  // But genuine 4xx/5xx statuses still fail closed.
  const rejected = 'The rates were rejected. Check each rate and retry.'
  const generic = 'The rates could not be saved. Please retry; if it persists, check the backend log.'
  assert.equal(S.fxErrorMessage(en, new Error('request failed with status 503')), generic)
  assert.equal(S.fxErrorMessage(en, new Error('validation error: upstream returned 500')), rejected)
})

test('econWindowLines keeps one expenditure line per currency', () => {
  assert.deepEqual(S.econWindowLines([]), ['—'])
  assert.deepEqual(S.econWindowLines(null), ['—'])
  assert.deepEqual(S.econWindowLines([
    { amount: 19.37, currency: 'USD' }, { amount: 4.19, currency: 'GBP' }
  ]), ['USD 19.37', 'GBP 4.19'])
})

test('economics window lines use the current translator for unknown currencies', () => {
  assert.match(S.econWindowLines([{ amount: 9, currency: 'XYZ' }], [], zh)[0], /币种未知 9\.00/)
})

test('windowSpanLabel describes the reporting window', () => {
  assert.equal(S.windowSpanLabel(en, 30), 'in the last 30 days')
  assert.equal(S.windowSpanLabel(en, 29.5), 'in the last 30 days')
  assert.equal(S.windowSpanLabel(en, 7), 'in the last 7 days')
  assert.equal(S.windowSpanLabel(en, 1), 'in the last 1 day')
  assert.equal(S.windowSpanLabel(en, null), 'in the reporting window')
  assert.equal(S.windowSpanLabel(en, 0), 'in the reporting window')
  assert.equal(S.windowSpanLabel(en, 'bogus'), 'in the reporting window')
})

test('economics and fx queries are keyed by connection identity', () => {
  assert.deepEqual(S.economicsQuery('id-1').queryKey[1], 'economics-summary')
  assert.deepEqual(S.fxQuery('id-1').queryKey[1], 'fx-rates')
  assert.equal(S.economicsQuery('id-1').staleTime, 30_000)
})

// --- PR28: economics note_codes ------------------------------------------------
test('economics notes render backend-identical English from codes', () => {
  const cases = [
    [[{ code: 'econ_head_no_fees', params: {} }],
     ['No subscription has a known fee; declare fees in Memberships.']],
    [[{ code: 'econ_head_unpriced', params: { count: 2 } }],
     ['2 subscription(s) have no fee; the headline cannot be compared.']],
    [[{ code: 'econ_head_incomparable', params: {} }],
     ['At least one subscription cannot be compared (missing price, coverage or FX rate); see the rows.']],
    [[{ code: 'econ_head_partial', params: {} }],
     ['Estimated value comparison; at least one input is partial.']],
    [[{ code: 'econ_head_ok', params: {} }],
     ['Estimated value comparison of recorded usage against fees.']],
    [[{ code: 'econ_head_fx_error', params: { error: 'boom' } }],
     ['FX rates could not be read (boom); no conversion applied.']],
    [[{ code: 'econ_group_unknown_currency', params: {} }], ['Fee currency is unknown.']],
    [[{ code: 'econ_group_unpriced', params: { count: 1 } }],
     ['1 subscription(s) have no fee; the group cannot be compared.']],
    [[{ code: 'econ_group_no_fx', params: { currency: 'EUR' } }],
     ['Fees are in EUR with no FX rate; add a dated rate to compare against USD-valued usage.']],
    [[{ code: 'econ_group_missing', params: {} }], ['Usage or fees are missing for this group.']],
    [[{ code: 'econ_group_partial', params: {} }],
     ['At least one account comparison is partial; see the rows.']],
  ]
  for (const [codes, notes] of cases) {
    assert.deepEqual(S.econNotesText(notes, codes, en), notes, codes[0].code)
  }
})

test('economics notes translate to Chinese and fall back per entry', () => {
  const notes = ['Fee currency is unknown.', 'custom note kept']
  const codes = [{ code: 'econ_group_unknown_currency', params: {} }, { code: 'econ_future', params: {} }]
  const out = S.econNotesText(notes, codes, zh)
  assert.equal(out[0], '费用币种未知。')
  assert.equal(out[1], 'custom note kept')
  assert.deepEqual(S.econNotesText(notes, null, zh), notes)
  assert.equal(S.econNoteText({ code: 'econ_group_no_fx', params: {} }, notes[1], en), notes[1])
})

test('attribution notes and arrangement explanations render from stable keys', () => {
  assert.equal(S.econSingularNoteText(
    { note: 'Usage on routes no account claims. Attribute it by confirming the route\'s account in Memberships.',
      note_code: 'econ_unattributed' }, en),
    'Usage on routes no account claims. Attribute it by confirming the route\'s account in Memberships.')
  assert.ok(S.econSingularNoteText({ note: 'x', note_code: 'econ_ambiguous' }, zh).includes('多个帐户'))
  assert.equal(S.econSingularNoteText({ note: 'kept' }, en), 'kept')
  assert.equal(S.econExplanationText(
    { arrangement: 'api_only', explanation: 'API Only: pay-as-you-go usage with no subscription to compare against.' }, en),
    'API Only: pay-as-you-go usage with no subscription to compare against.')
  assert.ok(S.econExplanationText({ arrangement: 'prepaid', explanation: 'x' }, zh).includes('预付额度'))
  assert.ok(S.econExplanationText({ arrangement: 'unconfirmed', explanation: 'x' }, zh).includes('未确认'))
  assert.equal(S.econExplanationText({ arrangement: 'whatever', explanation: 'kept' }, en), 'kept')
})

// --- WP19: Costs attention classification --------------------------------------
test('costsBlockerCategory separates fixable, historical and unavailable causes', () => {
  for (const code of ['subscription_fee_missing', 'dated_fx_rate_missing',
    'window_fee_history_missing', 'window_fee_allocation_unavailable',
    'provider_unidentified', 'provider_not_recorded', 'model_unidentified',
    'historical_ownership_billing_rule_incomplete', 'usage_price_incomplete',
    'usage_unknown', 'usage_missing', 'missing_base_rate', 'price_evidence_missing',
    'model_not_in_catalogue', 'provider_price_catalogue_missing', 'provider_not_in_catalogue']) {
    assert.equal(S.costsBlockerCategory(code), 'fix', code)
  }
  assert.equal(S.costsBlockerCategory('no_usage_recorded'), 'history')
  assert.equal(S.costsBlockerCategory('insufficient_comparison_history'), 'history')
  for (const code of ['tier_rate_unavailable', 'cache_rate_unavailable', 'missing_cache_rate',
    'missing_cache_read_rate', 'missing_cache_write_rate', 'call_failed', 'future_code', null, undefined]) {
    assert.equal(S.costsBlockerCategory(code), 'unavailable', String(code))
  }
})

test('costsAttentionActionFor offers only actions that can resolve the cause', () => {
  assert.equal(S.costsAttentionActionFor('subscription_fee_missing'), 'memberships')
  assert.equal(S.costsAttentionActionFor('dated_fx_rate_missing'), 'fx')
  assert.equal(S.costsAttentionActionFor('model_unidentified'), 'usage')
  // Catalogue gaps route to Usage (verify the recorded route) rather than
  // Settings, which cannot add catalogue support.
  assert.equal(S.costsAttentionActionFor('provider_price_catalogue_missing'), 'usage')
  assert.equal(S.costsAttentionActionFor('fx_read_error'), 'retry')
  // History accumulates on its own; catalogue-side rates and unknown codes
  // open the diagnostic log instead of promising a fix.
  assert.equal(S.costsAttentionActionFor('no_usage_recorded'), null)
  assert.equal(S.costsAttentionActionFor('insufficient_comparison_history'), null)
  assert.equal(S.costsAttentionActionFor('missing_cache_read_rate'), 'log')
  assert.equal(S.costsAttentionActionFor('call_failed'), 'log')
  assert.equal(S.costsAttentionActionFor('future_code'), 'log')
})

test('collectCostsBlockers dedupes repeats and groups by cause and currency', () => {
  const groups = [
    { currency: 'GBP', blockers: [
      { account_id: 'a', code: 'dated_fx_rate_missing', currency: 'GBP' },
      { account_id: 'b', code: 'dated_fx_rate_missing', currency: 'GBP' },
      { account_id: 'a', code: 'dated_fx_rate_missing', currency: 'GBP' },
    ] },
    { currency: 'USD', blockers: [{ account_id: 'c', code: 'subscription_fee_missing' }] },
  ]
  const accounts = [
    { account_id: 'c', fee: { currency: 'USD' }, blockers: [{ account_id: 'c', code: 'subscription_fee_missing' }] },
    { account_id: 'd', fee: { currency: 'USD' }, blockers: [{ code: 'mystery_future_code' }] },
  ]
  const out = S.collectCostsBlockers(groups, accounts)
  assert.deepEqual(out, [
    { code: 'dated_fx_rate_missing', currency: 'GBP', accountIds: ['a', 'b'] },
    { code: 'mystery_future_code', currency: 'USD', accountIds: [] },
    { code: 'subscription_fee_missing', currency: 'USD', accountIds: ['c'] },
  ])
  assert.deepEqual(S.collectCostsBlockers(), [])
})

test('trendWarrantsInline needs two comparable months in one currency', () => {
  const month = (over = {}) => ({ month: '2026-10',
    fees_by_currency: [{ currency: 'USD', amount: 20 }], fees_usd: 20,
    usage_usd: 2, difference_usd: -18, ...over })
  assert.equal(S.trendWarrantsInline({ months: [] }), false)
  assert.equal(S.trendWarrantsInline({ months: [month()] }), false,
    'one comparable period is a breakdown, never a trend')
  assert.equal(S.trendWarrantsInline({ months: [month(), month({ month: '2026-09' })] }), true)
  assert.equal(S.trendWarrantsInline({ months: [month(), month({ month: '2026-09', difference_usd: null })] }), false,
    'a single comparable month beside an honest text row stays collapsed')
  assert.equal(S.trendWarrantsInline({ months: [month(),
    month({ month: '2026-09', fees_by_currency: [{ currency: 'GBP', amount: 4 }] })] }), false,
    'mixed fee currencies are not a consistent measurement basis')
  assert.equal(S.trendWarrantsInline(null), false)
})

test('costsPricingSourceLabel translates known sources and keeps unknown ones', () => {
  assert.equal(S.costsPricingSourceLabel('models.dev cache (models_dev_cache.json)', en),
    'models.dev pricing catalogue (local cache)')
  assert.equal(S.costsPricingSourceLabel('models.dev cache (models_dev_cache.json) + official check 2026-11-01', en),
    'models.dev pricing catalogue (local cache) + official check 2026-11-01')
  assert.equal(S.costsPricingSourceLabel('bundled models.dev snapshot', en), 'bundled pricing snapshot')
  assert.equal(S.costsPricingSourceLabel('none', en), 'source unavailable')
  assert.equal(S.costsPricingSourceLabel('FutureSource 2.0', en), 'FutureSource 2.0')
  assert.equal(S.costsPricingSourceLabel('models.dev cache (models_dev_cache.json)', zh),
    'models.dev 价格目录（本地缓存）')
  assert.equal(S.costsPricingSourceLabel(null, en), null)
})
