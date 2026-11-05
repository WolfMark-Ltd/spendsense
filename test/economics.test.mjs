// Run: node --test test/
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
  assert.equal(S.econCoverageLabel(en, { tokens: 10, list_usd: 1, coverage: 1 }), 'Fully priced')
  assert.equal(S.econCoverageLabel(en, { tokens: 10, list_usd: 1, coverage: 0.5 }), '50% priced')
})

test('econCoverageLabel withholds fully priced on rounded 100% coverage', () => {
  // 3M priced + 1 unpriced token rounds coverage to 1.0; the label must
  // not contradict the partial backend status shown in the same cell.
  assert.equal(S.econCoverageLabel(en,
    { tokens: 3000001, list_usd: 6, coverage: 1, unpriced_tokens: 1 }), 'Nearly all priced')
  assert.equal(S.econCoverageLabel(en,
    { tokens: 3000000, list_usd: 6, coverage: 1, unpriced_tokens: 0 }), 'Fully priced')
  // Whole-percent rounding reaches 100% well before the ratio does.
  assert.equal(S.econCoverageLabel(en,
    { tokens: 1000, list_usd: 2, coverage: 0.9995, unpriced_tokens: 1 }), 'Nearly all priced')
  assert.equal(S.econCoverageLabel(zh,
    { tokens: 3000001, list_usd: 6, coverage: 1, unpriced_tokens: 1 }), '几乎全部定价')
})

test('econFeeLines keeps one line per currency', () => {
  assert.deepEqual(S.econFeeLines(en, []), ['—'])
  assert.deepEqual(S.econFeeLines(en, null), ['—'])
  assert.deepEqual(S.econFeeLines(en, [
    { amount: 20, currency: 'USD' }, { amount: 4.25, currency: 'GBP' }
  ]), ['$20.00/mo', '£4.25/mo'])
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
  ]), ['$19.37', '£4.19'])
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
