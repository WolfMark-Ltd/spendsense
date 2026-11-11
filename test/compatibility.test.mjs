// Backend skew detection at the shared ctx.rest boundary.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'

const source = readFileSync(new URL('../desktop/plugin.js', import.meta.url), 'utf8')
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
const useEffect = noop, useRef = initial => ({ current: initial })
const queryClient = { fetchQuery: async query => query.queryFn(), invalidateQueries: async () => {} }
const usePluginI18n = () => (key, ...args) => {
  const entry = I18N[globalThis.compatibilityLanguage || 'en'][key]
  return typeof entry === 'function' ? entry(...args) : entry ?? key
}
const useQuery = () => globalThis.compatibilityQueryResponse
const useValue = store => store.get()
const jsx = (type, props) => ({ type, props: props || {} }), jsxs = jsx
`
const body = source
  .replace(/import \{[^}]*\} from '@hermes\/plugin-sdk'\n/, stub)
  .replace(/import \{[^}]*\} from 'react'\n/, '')
  .replace(/import \{ jsx, jsxs \} from 'react\/jsx-runtime'\n/, '')
globalThis.window = { location: { hash: '' }, addEventListener() {}, removeEventListener() {} }
const dir = mkdtempSync(join(tmpdir(), 'compatibility-test-'))
const file = join(dir, 'plugin.mjs')
writeFileSync(file, body)
const { __test: T } = await import(pathToFileURL(file).href)

const translate = language => (key, ...args) => {
  const value = T.I18N[language][key]
  return typeof value === 'function' ? value(...args) : value ?? key
}
const en = translate('en')
const zh = translate('zh')
function allNodes(node) {
  if (!node || typeof node !== 'object') return []
  if (Array.isArray(node)) return node.flatMap(allNodes)
  return [node, ...allNodes(node.props?.children)]
}
function allText(node) {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node !== 'object') return String(node)
  if (Array.isArray(node)) return node.map(allText).join(' ')
  return allText(node.props?.children)
}
function failedTransport(status, body, prefix = '') {
  return async () => {
    throw new Error(`${prefix}${status}: ${JSON.stringify(body)}`)
  }
}
async function requestError(path, method, status, body, prefix = '') {
  let rejected
  const previousCompatibility = T.$backendCompatibility.get()
  try {
    await assert.rejects(
      T.backendRequest(path, { method }, failedTransport(status, body, prefix)),
      error => { rejected = error; return error instanceof Error }
    )
    return rejected
  } finally {
    T.$backendCompatibility.set(previousCompatibility)
  }
}

function snapshotGlobals(names) {
  return new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]))
}

function restoreGlobals(snapshot) {
  for (const [name, descriptor] of snapshot) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else delete globalThis[name]
  }
}

test('known newer endpoints and the WP04 arrangement route recognise route-level 404s', async () => {
  for (const path of ['/economics/summary?days=30', '/allowance/weather', '/reports/digest?days=7&lang=en']) {
    const error = await requestError(path, 'GET', 404, { detail: 'Not Found' })
    assert.equal(T.isBackendCompatibilityError(error), true, path)
  }
  const arrangement = await requestError(
    '/membership/accounts/openai%3Adefault/arrangement', 'PUT', 404, { detail: 'Not Found' })
  assert.equal(T.isBackendCompatibilityError(arrangement), true)
  assert.match(T.backendCompatibilityText(arrangement, en), /backend may be older/i)
  assert.match(T.backendCompatibilityText(arrangement, en), /update.*backend.*Desktop together/i)
  assert.match(T.backendCompatibilityText(arrangement, zh), /后端可能比此.*旧/)
  assert.match(T.backendCompatibilityText(arrangement, zh), /Desktop/)
  assert.match(T.backendCompatibilityText(arrangement, zh), /一起更新/)
  assert.doesNotMatch(T.backendCompatibilityText(arrangement, en), /8bc1f3d|commit/i)

  const ipc404 = await requestError('/economics/summary', 'GET', 404, { detail: 'Not Found' },
    "Error invoking remote method 'hermes:api': Error: ")
  assert.equal(T.isBackendCompatibilityError(ipc404), true)
})

test('only an unknown newer field on the account write is treated as 422 skew', async () => {
  const extraField = {
    detail: [
      { type: 'extra_forbidden', loc: ['body', 'billing_arrangement'], msg: 'Extra inputs are not permitted' },
      { type: 'extra_forbidden', loc: ['body', 'api_only'], msg: 'Extra inputs are not permitted' }
    ]
  }
  const mismatch = await requestError('/membership/accounts/a', 'PUT', 422, extraField)
  assert.equal(T.isBackendCompatibilityError(mismatch), true)

  const invalidValue = await requestError('/membership/accounts/a', 'PUT', 422, {
    detail: 'billing arrangement is invalid'
  })
  assert.equal(T.isBackendCompatibilityError(invalidValue), false)
  assert.equal(T.membershipErrorText(invalidValue, 'write', en), en('memErrValidation'))
  assert.equal(T.membershipErrorText(invalidValue, 'write', zh), zh('memErrValidation'))
  assert.match(T.backendCompatibilityText(mismatch, en), /update.*backend.*Desktop together/i)
  assert.match(T.backendCompatibilityText(mismatch, zh), /一起更新/)
})

test('network errors, unrelated 404s, missing records and missing plugin namespaces stay ordinary', async () => {
  let network
  await assert.rejects(
    T.backendRequest('/economics/summary', { method: 'GET' }, async () => { throw new Error('fetch failed') }),
    error => { network = error; return error instanceof Error }
  )
  assert.equal(T.isBackendCompatibilityError(network), false)

  let portFailure
  await assert.rejects(
    T.backendRequest('/economics/summary', { method: 'GET' }, async () => {
      throw new Error("Error invoking remote method 'hermes:api': Error: connect ECONNREFUSED 127.0.0.1:404")
    }),
    error => { portFailure = error; return error instanceof Error }
  )
  assert.equal(T.isBackendCompatibilityError(portFailure), false)

  for (const [path, method, status, detail] of [
    ['/billing/profiles', 'GET', 404, 'Not Found'],
    ['/membership/accounts/missing/arrangement', 'PUT', 404, 'no such membership in this store'],
    ['/economics/summary', 'GET', 404, 'Plugin not found'],
    ['/billing/profiles', 'PUT', 422, 'api_only: extra fields not permitted']
  ]) {
    const error = await requestError(path, method, status, { detail })
    assert.equal(T.isBackendCompatibilityError(error), false, `${method} ${path}: ${detail}`)
  }
})

test('MembershipCard forwards classified and ordinary weather errors to AllowanceWeather', async () => {
  const compatibilityError = await requestError('/allowance/weather', 'GET', 404, { detail: 'Not Found' })
  const account = {
    id: 'weather-account', family: 'openai-codex', rev: 'rev-1',
    effective_arrangement: 'subscription', quota: {}, fee: {}
  }
  const renderWeather = weatherError => {
    const card = T.MembershipCard({
      account, accounts: [account], plans: [], busy: '', onAction() {}, draft: null,
      saveFee() {}, catalogue: {}, notice: null, weather: null, weatherError, hasAttention: false
    })
    const component = allNodes(card).find(node => node.type === T.AllowanceWeather)
    assert.ok(component)
    return { component, output: T.AllowanceWeather(component.props) }
  }

  const compatibilityWeather = renderWeather(compatibilityError)
  assert.equal(compatibilityWeather.component.props.error, compatibilityError)
  assert.equal(compatibilityWeather.output, null)

  const ordinaryError = new Error('fetch failed')
  const ordinaryWeather = renderWeather(ordinaryError)
  assert.equal(ordinaryWeather.component.props.error, ordinaryError)
  assert.equal(allText(ordinaryWeather.output), en('wxUnavailable'))
})

test('a later success clears only the flagged route for the same identity', async () => {
  const previousCompatibility = T.$backendCompatibility.get()
  const previousConnection = T.$scopeConnection.get()
  const failedPath = '/economics/summary?days=30'
  T.$backendCompatibility.set(null)
  try {
    let compatibilityError
    await assert.rejects(
      T.backendRequest(failedPath, { method: 'GET' }, failedTransport(404, { detail: 'Not Found' })),
      error => { compatibilityError = error; return T.isBackendCompatibilityError(error) }
    )
    const flagged = T.$backendCompatibility.get()
    assert.ok(flagged)
    assert.equal(flagged.identity, T.membershipIdentityNow())
    assert.equal(flagged.route, '/economics/summary')
    assert.equal(flagged.method, 'GET')
    assert.ok(compatibilityError)

    await T.backendRequest('/reports/digest', { method: 'GET' }, async () => ({ ok: true }))
    assert.deepEqual(T.$backendCompatibility.get(), flagged)

    T.$scopeConnection.set('another-connection')
    await T.backendRequest('/economics/summary?days=7', { method: 'GET' }, async () => ({ ok: true }))
    assert.deepEqual(T.$backendCompatibility.get(), flagged)

    T.$scopeConnection.set(previousConnection)
    await T.backendRequest('/economics/summary?days=7', { method: 'GET' }, async () => ({ ok: true }))
    assert.equal(T.$backendCompatibility.get(), null)
  } finally {
    T.$scopeConnection.set(previousConnection)
    T.$backendCompatibility.set(previousCompatibility)
  }
})

test('the installed transport wrapper records one translated warning and removes digest retry guidance', async () => {
  const globals = snapshotGlobals([
    'compatibilityLanguage', 'compatibilityQueryResponse', 'compatibilityRetried'
  ])
  const previousRest = T.getRest()
  const previousCompatibility = T.$backendCompatibility.get()
  try {
    globalThis.compatibilityRetried = undefined
    T.setRest(async () => ({ ok: false, status: 404, detail: 'Not Found' }))
    const identity = T.membershipIdentityNow()
    let economicsError
    await assert.rejects(T.economicsQuery(identity).queryFn(), error => {
      economicsError = error
      return T.isBackendCompatibilityError(error)
    })
    assert.equal(T.$backendCompatibility.get()?.identity, identity)

    globalThis.compatibilityLanguage = 'zh'
    const shell = T.ProductShell({ children: null })
    const warnings = shell.props.children.filter(node => node?.props?.className === 'wm-alert wm-backend-compatibility')
    assert.equal(warnings.length, 1)
    assert.match(warnings[0].props.children, /后端可能比此/)
    assert.match(T.membershipErrorText(economicsError, 'write', zh), /一起更新/)

    const account = {
      id: 'a', family: 'openai-codex', rev: 'rev-1', effective_arrangement: 'subscription',
      quota: {}, fee: {}
    }
    const card = notice => T.MembershipCard({
      account, accounts: [account], plans: [], busy: '', onAction() {}, draft: null,
      saveFee() {}, catalogue: {}, notice, weather: null, weatherError: null, hasAttention: false
    })
    const compatibilityNotice = T.backendCompatibilityText(economicsError, zh)
    assert.doesNotMatch(allText(card({
      tone: 'warn', text: compatibilityNotice, accountId: account.id, compatibility: true
    })), /后端可能比此/)
    assert.ok(allText(card({
      tone: 'warn', text: zh('memErrValidation'), accountId: account.id
    })).includes(zh('memErrValidation')))

    let digestError
    await assert.rejects(T.digestQuery(identity, 30, 'zh').queryFn(), error => {
      digestError = error
      return T.isBackendCompatibilityError(error)
    })
    assert.equal(T.isBackendCompatibilityError(digestError), true)
    assert.match(digestError.path, /^\/reports\/digest\?/)

    globalThis.compatibilityQueryResponse = {
      data: null, error: digestError, isLoading: false, isFetching: false,
      refetch: () => { globalThis.compatibilityRetried = true }
    }
    const reportPage = T.ReportsPage()
    const reportContent = reportPage.props.children
    const labels = allText(reportContent)
    assert.doesNotMatch(labels, /Report unavailable|Retry|此连接无法生成报告|重试/)
    const generate = allNodes(reportContent).find(node => node.props?.children === zh('rpGenerate'))
    assert.ok(generate)
    assert.equal(generate.props.disabled, undefined)
    assert.equal(globalThis.compatibilityRetried, undefined)
  } finally {
    T.restoreRest(previousRest)
    T.$backendCompatibility.set(previousCompatibility)
    restoreGlobals(globals)
  }
})
