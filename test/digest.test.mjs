// Run: node --test test/
//
// Local digest helper regressions through the same stub loader the other
// suites use (no React needed). Rendered-section tests live in
// test/digest-render.test.mjs, which must stay a separate file: tests
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
const stubDir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'tcm-dg-'))
const stubFile = join(stubDir, 'plugin.mjs')
writeFileSync(stubFile, stubBody)
const S = (await import(pathToFileURL(stubFile).href)).__test

test('digestQuery keys by identity, window and language', () => {
  const query = S.digestQuery('id-a', 7, 'en')
  assert.deepEqual(query.queryKey, ['spend-sense', 'digest-report', 'id-a', 7, 'en'])
  assert.notDeepEqual(S.digestQuery('id-a', 7, 'en').queryKey, S.digestQuery('id-a', 30, 'en').queryKey)
  assert.notDeepEqual(S.digestQuery('id-a', 30, 'en').queryKey, S.digestQuery('id-a', 30, 'zh').queryKey)
  assert.notDeepEqual(S.digestQuery('id-a', 30, 'en').queryKey, S.digestQuery('id-b', 30, 'en').queryKey)
  assert.equal(S.digestQuery('id-a', 30, 'en').retry, false)
  assert.equal(S.digestQuery('id-a', 30, 'en').enabled, false)
})

test('uiLocale follows the rendered catalogue', () => {
  const en = key => S.I18N.en[key]
  const zh = key => S.I18N.zh[key]
  assert.equal(S.uiLocale(en), 'en')
  assert.equal(S.uiLocale(zh), 'zh')
  assert.equal(S.uiLocale(() => { throw new Error('no i18n') }), 'en')
  assert.equal(S.uiLocale(() => 'reportsTitle'), 'en')
})
