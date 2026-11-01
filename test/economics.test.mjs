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
const queryClient = { fetchQuery: async q => q.queryFn(), getQueryData: () => null }
const usePluginI18n = noop, useQuery = noop, useValue = noop
const jsx = noop, jsxs = noop
`
const stubBody = src
  .replace(/import \{[^}]*\} from '@hermes\/plugin-sdk'\n/, stub)
  .replace(/import \{ useEffect \} from 'react'\n/, '')
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
