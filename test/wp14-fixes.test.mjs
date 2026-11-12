import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Same stub-eval harness shape as test/compatibility.test.mjs: strip ESM
// import/export lines, eval with UMD names stubbed, pull __test exports.
globalThis.window = { location: { hash: '' }, addEventListener() {}, removeEventListener() {} }
function loadPlugin(lang) {
  const src = readFileSync(new URL('../desktop/plugin.js', import.meta.url), 'utf8')
  const stub = `
const atom = value => ({ get: () => value, set: next => { value = next }, listen: () => () => {} })
const computed = (stores, cb) => {
  const list = Array.isArray(stores) ? stores : [stores]
  return { get: () => cb(...list.map(s => s.get())), listen: () => () => {} }
}
const noop = () => null
const Badge = noop, Button = noop, Codicon = noop, SegmentedControl = noop, Tip = noop
const cn = (...values) => values.filter(Boolean).join(' ')
const host = { state: { connectionId: atom(null), profile: atom('default'), gateway: atom('connected'), focusedSessionId: atom(null), focusedStoredSessionId: atom(null), focusedSessionProfile: atom('default'), focusedUsage: atom(null) }, notify() {}, navigate() {}, request: async () => null }
const gatewayActivationEpoch = () => 1
const useEffect = noop, useMemo = f => f(), useCallback = f => f, useRef = initial => ({ current: initial }), useState = initial => [initial, noop]
const queryClient = { fetchQuery: async query => query.queryFn(), invalidateQueries: async () => {} }
const usePluginI18n = () => (key, ...args) => {
  const entry = I18N[globalThis.wp14Language || 'en'][key]
  return typeof entry === 'function' ? entry(...args) : entry ?? key
}
const useQuery = (q) => {
  const key = q && q.queryKey && q.queryKey[1]
  const table = globalThis.wp14QueryData || {}
  if (key && table[key]) return table[key]
  return globalThis.wp14QueryResponse
}
const useValue = store => store.get()
const jsx = (type, props) => ({ type, props: props || {} }), jsxs = jsx
`
  const body = src
    .replace(/import \{[^}]*\} from '@hermes\/plugin-sdk'\n/, stub)
    .replace(/import \{[^}]*\} from 'react'\n/, '')
    .replace(/import \{ jsx, jsxs \} from 'react\/jsx-runtime'\n/, '')
  const tmp = join(tmpdir(), `wp14-plugin-${lang}-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`)
  writeFileSync(tmp, body)
  globalThis.wp14Language = lang
  return import(tmp).then(m => { try { unlinkSync(tmp) } catch {} return m.__test })
}

const needsAttentionEn = k => `[en:${k}]`

test('WP14 MAJOR-3: segment pill aria-label announces localized text (en)', async () => {
  const T = await loadPlugin('en')
  const node = T.AnalyticsSegments({ label: 'Cost type', value: 'all',
    options: [['all', 'All'], ['fixed', 'Fixed']], onChange: () => {} })
  const pills = node.props.children
  assert.equal(pills[0].props['aria-label'], 'Cost type All')
  assert.equal(pills[1].props['aria-label'], 'Cost type Fixed')
  assert.ok(!pills[0].props['aria-label'].startsWith('all'))
})

test('WP14 MAJOR-3: segment pill aria-label announces localized text (zh)', async () => {
  const T = await loadPlugin('zh')
  const node = T.AnalyticsSegments({ label: '费用类型', value: 'all',
    options: [['all', '全部'], ['fixed', '固定']], onChange: () => {} })
  const pills = node.props.children
  assert.equal(pills[0].props['aria-label'], '费用类型 全部')
  assert.equal(pills[1].props['aria-label'], '费用类型 固定')
  assert.ok(!pills[0].props['aria-label'].startsWith('all'))
})

test('WP14 MAJOR-4: operation-specific text diverges for missing (en)', async () => {
  const T = await loadPlugin('en')
  const t = k => T.I18N.en[k]
  const err = { message: 'HTTP 404' }
  const read = T.membershipErrorMessage(err, 'read', t)
  const write = T.membershipErrorMessage(err, 'write', t)
  const clear = T.membershipErrorMessage(err, 'clear', t)
  assert.equal(read, T.I18N.en.memErrMissingNone)
  assert.equal(write, T.I18N.en.memErrMissingWrite)
  assert.equal(clear, T.I18N.en.memErrMissingClear)
  assert.ok(read !== write && write !== clear)
})

test('WP14 MAJOR-4: refresh vs read diverge on unclassified error (en)', async () => {
  const T = await loadPlugin('en')
  const t = k => T.I18N.en[k]
  const err = { message: 'something odd happened' }
  assert.equal(T.membershipErrorMessage(err, 'refresh', t), T.I18N.en.memErrRefresh)
  assert.equal(T.membershipErrorMessage(err, 'read', t), T.I18N.en.memErrGeneric)
})

test('WP14 MAJOR-4: default t is English, en/zh parity holds', async () => {
  const T = await loadPlugin('en')
  const err = { message: 'HTTP 404' }
  assert.equal(T.membershipErrorMessage(err), T.I18N.en.memErrMissingNone)
  const zh = T.membershipErrorMessage(err, 'read', k => T.I18N.zh[k])
  assert.equal(zh, T.I18N.zh.memErrMissingNone)
  assert.ok(zh !== T.I18N.en.memErrMissingNone)
})

// LedgerTabs takes no props: it reads the $ledgerTab atom, renders one
// ProductButton per tab (role=tab with roving tabindex), and handles arrow
// keys with a single onKeyDown on the tablist container. Tab-to-panel ARIA
// linkage (ids, aria-controls, tabpanel wrapper) was evaluated and reverted:
// the WP01 flat-structure contracts pinned by ux-primitives, membership-scope
// and digest-render require the tab bar and content shell as direct children
// of the page root, so the linkage is recorded as a follow-up instead.
const wp14Key = key => ({ key, preventDefault: () => {} })

test('WP14 MAJOR-5: ArrowRight from usage moves to costs, Home/End jump', async () => {
  const T = await loadPlugin('en')
  T.$ledgerTab.set('usage')
  T.LedgerTabs().props.onKeyDown(wp14Key('ArrowRight'))
  assert.equal(T.$ledgerTab.get(), 'costs')
  T.LedgerTabs().props.onKeyDown(wp14Key('Home'))
  assert.equal(T.$ledgerTab.get(), 'overview')
  T.LedgerTabs().props.onKeyDown(wp14Key('End'))
  assert.equal(T.$ledgerTab.get(), 'settings')
})

test('WP14 MAJOR-5: arrow navigation wraps at both ends', async () => {
  const T = await loadPlugin('en')
  T.$ledgerTab.set('settings')
  T.LedgerTabs().props.onKeyDown(wp14Key('ArrowRight'))
  assert.equal(T.$ledgerTab.get(), 'overview')
  T.$ledgerTab.set('overview')
  T.LedgerTabs().props.onKeyDown(wp14Key('ArrowLeft'))
  assert.equal(T.$ledgerTab.get(), 'settings')
})

// Per-query dispatcher data for a full SettingsPage render.
function wp14SettingsQueryData(T, catalogueVersion) {
  return {
    'pricing-status': { data: { source: 'bundled', as_of: null, age_seconds: null, stale: false } },
    health: { data: {} },
    'news-settings': { data: { settings: {} } },
    'membership-plans': {
      data: {
        identity: T.membershipIdentityNow(),
        source: 'bundled',
        catalogue_version: catalogueVersion,
        generated_at: null,
        central: null,
        totals: {},
        sources: [],
      },
    },
  }
}

function findText(node, pred, out = []) {
  if (node == null) return out
  if (typeof node === 'string') { if (pred(node)) out.push(node); return out }
  if (Array.isArray(node)) { node.forEach(n => findText(n, pred, out)); return out }
  if (typeof node === 'object') {
    if (node.props && node.props.children !== undefined) findText(node.props.children, pred, out)
    return out
  }
  return out
}

test('WP14 MINOR-8: catalogue_version shows when present', async () => {
  const T = await loadPlugin('en')
  globalThis.wp14QueryData = wp14SettingsQueryData(T, 'v123')
  const node = T.SettingsPage()
  const hits = findText(node, s => s.includes('v123'))
  assert.ok(hits.length > 0, 'expected catalogue_version v123 rendered')
  delete globalThis.wp14QueryData
})

test('WP14 MINOR-8: missing catalogue_version renders no undefined', async () => {
  const T = await loadPlugin('en')
  const data = wp14SettingsQueryData(T, undefined)
  delete data['membership-plans'].data.catalogue_version
  globalThis.wp14QueryData = data
  const node = T.SettingsPage()
  const hits = findText(node, s => s.includes('undefined'))
  assert.deepEqual(hits, [])
  delete globalThis.wp14QueryData
})
