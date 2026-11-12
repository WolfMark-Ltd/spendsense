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
const useEffect = noop, useRef = initial => ({ current: initial }), useState = initial => [initial, noop]
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

  for (const details of [
    [{ type: 'extra_forbidden', loc: ['body', 'unrelated'], msg: 'Extra inputs are not permitted', input: 'billing_arrangement' }],
    [
      { type: 'value_error', loc: ['body', 'billing_arrangement'], msg: 'billing arrangement is invalid' },
      { type: 'extra_forbidden', loc: ['body', 'unrelated'], msg: 'Extra inputs are not permitted' }
    ],
  ]) {
    const ordinaryValidation = await requestError('/membership/accounts/a', 'PUT', 422, { detail: details })
    assert.equal(T.isBackendCompatibilityError(ordinaryValidation), false)
  }

  const invalidValue = await requestError('/membership/accounts/a', 'PUT', 422, {
    detail: 'billing arrangement is invalid'
  })
  assert.equal(T.isBackendCompatibilityError(invalidValue), false)
  assert.equal(T.membershipErrorText(invalidValue, 'write', en), en('memErrValidation'))
  assert.equal(T.membershipErrorText(invalidValue, 'write', zh), zh('memErrValidation'))

  const plainTextMismatch = await requestError('/membership/accounts/a', 'PUT', 422, {
    detail: 'billing_arrangement and api_only: extra fields not permitted'
  })
  assert.equal(T.isBackendCompatibilityError(plainTextMismatch), true)

  for (const detail of [
    'billing_arrangement has an invalid value; extra field legacy_alias is forbidden',
    'api_only is supported. An unrelated extra field legacy_mode is not permitted'
  ]) {
    const ambiguous = await requestError('/membership/accounts/a', 'PUT', 422, { detail })
    assert.equal(T.isBackendCompatibilityError(ambiguous), false, detail)
    assert.equal(T.membershipErrorText(ambiguous, 'write', en), en('memErrValidation'))
  }

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
  const previousCompatibility = T.$backendCompatibility.get()
  const previousConnection = T.$scopeConnection.get()
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

  try {
    T.$backendCompatibility.set([])
    let compatibilityError
    await assert.rejects(
      T.backendRequest('/allowance/weather', { method: 'GET' }, failedTransport(404, { detail: 'Not Found' })),
      error => { compatibilityError = error; return T.isBackendCompatibilityError(error) }
    )
    assert.equal(T.$backendCompatibility.get().some(failure => failure.identity === T.membershipIdentityNow()
      && failure.route === '/allowance/weather' && failure.method === 'GET'), true)

    const compatibilityWeather = renderWeather(compatibilityError)
    assert.equal(compatibilityWeather.component.props.error, compatibilityError)
    assert.equal(compatibilityWeather.output, null)

    T.$scopeConnection.set('another-connection')
    const otherConnectionWeather = renderWeather(compatibilityError)
    assert.equal(allText(otherConnectionWeather.output), en('wxUnavailable'))
    T.$scopeConnection.set(previousConnection)
    assert.equal(renderWeather(compatibilityError).output, null)

    await T.backendRequest('/allowance/weather', { method: 'GET' }, async () => ({ ok: true }))
    assert.deepEqual(T.$backendCompatibility.get(), [])
    const recoveredWeather = renderWeather(compatibilityError)
    assert.equal(allText(recoveredWeather.output), en('wxUnavailable'))

    const ordinaryError = new Error('fetch failed')
    const ordinaryWeather = renderWeather(ordinaryError)
    assert.equal(ordinaryWeather.component.props.error, ordinaryError)
    assert.equal(allText(ordinaryWeather.output), en('wxUnavailable'))
  } finally {
    T.$scopeConnection.set(previousConnection)
    T.$backendCompatibility.set(previousCompatibility)
  }
})

test('route recovery clears only its identity-route-method failure', async () => {
  const previousCompatibility = T.$backendCompatibility.get()
  const previousConnection = T.$scopeConnection.get()
  const globals = snapshotGlobals(['compatibilityQueryResponse'])
  const failedEconomicsPath = '/economics/summary?days=30'
  const failedDigestPath = '/reports/digest?days=30&lang=en'
  const failedMembershipPath = '/membership/accounts/a'
  T.$backendCompatibility.set([])
  try {
    let economicsError
    await assert.rejects(
      T.backendRequest(failedEconomicsPath, { method: 'GET' }, failedTransport(404, { detail: 'Not Found' })),
      error => { economicsError = error; return T.isBackendCompatibilityError(error) }
    )
    let digestError
    await assert.rejects(
      T.backendRequest(failedDigestPath, { method: 'GET' }, failedTransport(404, { detail: 'Not Found' })),
      error => { digestError = error; return T.isBackendCompatibilityError(error) }
    )
    let membershipError
    await assert.rejects(
      T.backendRequest(failedMembershipPath, { method: 'PUT' }, failedTransport(422, {
        detail: 'billing_arrangement and api_only: extra fields not permitted'
      })),
      error => { membershipError = error; return T.isBackendCompatibilityError(error) }
    )
    const identity = T.membershipIdentityNow()
    const failures = T.$backendCompatibility.get()
    assert.deepEqual(failures.map(({ identity, route, method }) => ({ identity, route, method })), [
      { identity, route: '/economics/summary', method: 'GET' },
      { identity, route: '/reports/digest', method: 'GET' },
      { identity, route: failedMembershipPath, method: 'PUT' },
    ])
    assert.ok(T.isBackendCompatibilityError(economicsError))
    assert.ok(T.isBackendCompatibilityError(digestError))
    assert.ok(T.isBackendCompatibilityError(membershipError))

    await T.backendRequest('/allowance/weather', { method: 'GET' }, async () => ({ ok: true }))
    assert.deepEqual(T.$backendCompatibility.get(), failures)

    T.$scopeConnection.set('another-connection')
    await T.backendRequest('/economics/summary?days=7', { method: 'GET' }, async () => ({ ok: true }))
    assert.deepEqual(T.$backendCompatibility.get(), failures)
    const otherConnectionWarnings = T.ProductShell({ children: null }).props.children
      .filter(node => node?.props?.className === 'wm-alert wm-backend-compatibility')
    assert.equal(otherConnectionWarnings.length, 0)

    T.$scopeConnection.set(previousConnection)
    const originalConnectionWarnings = T.ProductShell({ children: null }).props.children
      .filter(node => node?.props?.className === 'wm-alert wm-backend-compatibility')
    assert.equal(originalConnectionWarnings.length, 1)
    await T.backendRequest(failedMembershipPath, { method: 'GET' }, async () => ({ ok: true }))
    assert.deepEqual(T.$backendCompatibility.get(), failures)

    await T.backendRequest('/economics/summary?days=7', { method: 'GET' }, async () => ({ ok: true }))
    assert.deepEqual(T.$backendCompatibility.get(), [failures[1], failures[2]])

    const warningsAfterOneRecovery = T.ProductShell({ children: null }).props.children
      .filter(node => node?.props?.className === 'wm-alert wm-backend-compatibility')
    assert.equal(warningsAfterOneRecovery.length, 1)

    globalThis.compatibilityQueryResponse = {
      data: null, error: digestError, isLoading: false, isFetching: false, refetch() {}
    }
    const reportContent = T.ReportsPage().props.children
    const reportNodes = allNodes(reportContent)
    const generate = reportNodes.find(node => node.props?.children === en('rpGenerate'))
    assert.ok(generate)
    assert.equal(typeof generate.props.onClick, 'function')
    const generateButton = allNodes(T.AsyncButton(generate.props)).find(node => node.type === T.ProductButton)
    assert.ok(generateButton)
    assert.notEqual(generateButton.props.disabled, true)
    assert.doesNotMatch(allText(reportContent), /Report unavailable|Retry|此连接无法生成报告|重试/)

    await T.backendRequest('/reports/digest?days=7&lang=en', { method: 'GET' }, async () => ({ ok: true }))
    assert.deepEqual(T.$backendCompatibility.get(), [failures[2]])
    await T.backendRequest(failedMembershipPath, { method: 'PUT' }, async () => ({ ok: true }))
    assert.deepEqual(T.$backendCompatibility.get(), [])
    const warningsAfterAllRecoveries = T.ProductShell({ children: null }).props.children
      .filter(node => node?.props?.className === 'wm-alert wm-backend-compatibility')
    assert.equal(warningsAfterAllRecoveries.length, 0)
  } finally {
    T.$scopeConnection.set(previousConnection)
    T.$backendCompatibility.set(previousCompatibility)
    restoreGlobals(globals)
  }
})

test('a recovered digest route restores report error and retry guidance', async () => {
  const previousCompatibility = T.$backendCompatibility.get()
  const globals = snapshotGlobals(['compatibilityQueryResponse'])
  T.$backendCompatibility.set([])
  try {
    let digestError
    await assert.rejects(
      T.backendRequest('/reports/digest?days=7&lang=en', { method: 'GET' }, failedTransport(404, { detail: 'Not Found' })),
      error => { digestError = error; return T.isBackendCompatibilityError(error) }
    )
    globalThis.compatibilityQueryResponse = {
      data: null, error: digestError, isLoading: false, isFetching: false, refetch() {}
    }
    const incompatibleReport = T.ReportsPage()
    const incompatibleShell = T.ProductShell({ children: incompatibleReport.props.children })
    const incompatibleWarnings = incompatibleShell.props.children
      .filter(node => node?.props?.className === 'wm-alert wm-backend-compatibility')
    assert.equal(incompatibleWarnings.length, 1)
    assert.doesNotMatch(allText(incompatibleReport.props.children), /Report unavailable|Retry|此连接无法生成报告|重试/)

    await T.backendRequest('/reports/digest?days=30&lang=en', { method: 'GET' }, async () => ({ ok: true }))
    assert.deepEqual(T.$backendCompatibility.get(), [])

    const recoveredReport = T.ReportsPage()
    const recoveredShell = T.ProductShell({ children: recoveredReport.props.children })
    const recoveredWarnings = recoveredShell.props.children
      .filter(node => node?.props?.className === 'wm-alert wm-backend-compatibility')
    assert.equal(recoveredWarnings.length, 0)
    assert.ok(allText(recoveredReport.props.children).includes(en('rpError')))
    assert.ok(allText(recoveredReport.props.children).includes(en('rpRetry')))
    const generate = allNodes(recoveredReport.props.children)
      .find(node => node.props?.children === en('rpGenerate'))
    assert.ok(generate)
    const generateButton = allNodes(T.AsyncButton(generate.props)).find(node => node.type === T.ProductButton)
    assert.ok(generateButton)
    assert.notEqual(generateButton.props.disabled, true)
  } finally {
    T.$backendCompatibility.set(previousCompatibility)
    restoreGlobals(globals)
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
    assert.ok(T.$backendCompatibility.get().some(failure => failure.identity === identity
      && failure.route === '/economics/summary' && failure.method === 'GET'))

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
    const generateButton = allNodes(T.AsyncButton(generate.props)).find(node => node.type === T.ProductButton)
    assert.ok(generateButton)
    assert.notEqual(generateButton.props.disabled, true)
    assert.equal(globalThis.compatibilityRetried, undefined)
  } finally {
    T.restoreRest(previousRest)
    T.$backendCompatibility.set(previousCompatibility)
    restoreGlobals(globals)
  }
})

// WP15: the pair's identity and contract, read from /health before any request fails.
test('a backend older than the contract field is treated as an older pair', () => {
  const legacy = { ok: true, version: '0.6.0' }
  const pair = T.backendPairState('conn-1', legacy)
  assert.ok(pair, 'a backend that reports no build block cannot be this bundle`s pair')
  assert.equal(pair.found, 1)
  assert.equal(pair.required, T.REQUIRED_BACKEND_CONTRACT)
  assert.equal(pair.desktop, T.DESKTOP_CONTRACT)
  assert.equal(pair.revision, null)
  assert.equal(pair.desktopSha256, null)

  // A recorded zero or a non-integer is not a contract level.
  assert.equal(T.backendContract({ build: { contract: 0 } }), 1)
  assert.equal(T.backendContract({ build: { contract: '3' } }), 3)
  assert.equal(T.backendContract({ build: { contract: 3.5 } }), 1)
  assert.equal(T.backendContract(null), 1)
})

test('a backend at or above the required contract raises no pair verdict', () => {
  for (const contract of [T.REQUIRED_BACKEND_CONTRACT, T.REQUIRED_BACKEND_CONTRACT + 1]) {
    assert.equal(T.backendPairState('conn-1', { ok: true, version: '0.6.0', build: { contract } }), null,
      String(contract))
  }
  assert.equal(T.backendPairState('conn-1', undefined), null)
  assert.equal(T.backendPairState('conn-1', { ok: true, version: '0.6.0', build: {} })?.found, 1)
})

test('only a health payload can judge the pair', () => {
  // Another route's body, or a proxy's JSON, is not evidence about the backend build.
  for (const payload of [
    { ok: true },
    { ok: true, generated_at: '2026-10-31T12:00:00Z', sections: [] },
    { ok: true, build: { contract: 1 } },
    { error: 'nope' },
    null
  ]) {
    assert.equal(T.backendPairState('conn-1', payload), null, JSON.stringify(payload))
  }
  assert.ok(T.backendPairState('conn-1', { ok: true, rate_card: {}, build: { contract: 1 } }))
  assert.ok(T.backendPairState('conn-1', { ok: true, db_present: true, build: { contract: 1 } }))
})

test('the pair verdict carries the backend revision and the expected bundle digest', () => {
  const revision = 'a'.repeat(40)
  const digest = 'b'.repeat(64)
  const pair = T.backendPairState('conn-1', {
    ok: true, version: '0.6.0', build: { contract: 1, revision, desktop_sha256: digest }
  })
  assert.equal(pair.revision, revision)
  assert.equal(pair.desktopSha256, digest)

  // A shortened or non-hex value is not repeated back as an identity.
  const forged = T.backendPairState('conn-1', {
    ok: true, version: '0.6.0', build: { contract: 1, revision: 'a'.repeat(39), desktop_sha256: '<script>' }
  })
  assert.equal(forged.revision, null)
  assert.equal(forged.desktopSha256, null)
})

test('the halves shipped by one revision declare a compatible contract', () => {
  const api = readFileSync(new URL('../dashboard/plugin_api.py', import.meta.url), 'utf8')
  const declared = Number((api.match(/^API_CONTRACT = (\d+)$/m) || [])[1])
  assert.ok(Number.isInteger(declared) && declared > 0,
    'dashboard/plugin_api.py must declare API_CONTRACT')
  assert.ok(T.DESKTOP_CONTRACT > 0 && T.REQUIRED_BACKEND_CONTRACT > 0)
  // The release that ships this bundle must accept its own pair. Raising the
  // requirement without the backend, or the backend without the requirement,
  // is the mistake this catches.
  assert.ok(T.REQUIRED_BACKEND_CONTRACT <= declared,
    `this bundle needs backend contract ${T.REQUIRED_BACKEND_CONTRACT}, the same revision offers ${declared}`)
  assert.ok(T.DESKTOP_CONTRACT <= declared)
})

test('a health payload is judged even when the usage stores are absent', async () => {
  // `ok` reports store readiness, not identity: a fresh profile must still learn
  // that its backend is too old, before it opens a single tab.
  const globals = snapshotGlobals(['compatibilityLanguage', 'compatibilityQueryResponse'])
  const previousRest = T.getRest()
  const previousCompatibility = T.$backendCompatibility.get()
  try {
    T.$backendCompatibility.set([])
    const payload = {
      ok: false, version: '0.6.0', db_present: false, event_db_present: false,
      build: { contract: 1, revision: 'e'.repeat(40) }
    }
    T.setRest(async () => payload)
    const query = T.backendHealthQuery(T.membershipIdentityNow())
    assert.deepEqual(await query.queryFn(), payload)
    assert.equal(T.backendPairState('conn-1', payload).found, 1)

    globalThis.compatibilityQueryResponse = { data: payload }
    const shell = T.ProductShell({ children: [] })
    assert.equal(shell.props.children
      .filter(node => node?.props?.className === 'wm-alert wm-backend-compatibility').length, 1)
  } finally {
    T.restoreRest(previousRest)
    T.$backendCompatibility.set(previousCompatibility)
    restoreGlobals(globals)
  }
})

test('the shell health read is a health response, not a store verdict', async () => {
  const previousRest = T.getRest()
  try {
    T.setRest(async () => null)
    const query = T.backendHealthQuery(T.membershipIdentityNow())
    await assert.rejects(query.queryFn(), /Health check failed/)
  } finally {
    T.restoreRest(previousRest)
  }
  assert.equal(T.backendHealthQuery('conn-1').queryKey[1], 'health')
})

test('an error-only body is a failed health read, not health data', async () => {
  // A bridge that resolves `{ok: false, error}` rather than throwing must still
  // reach Settings as a failure. Binding the response to the payload shape keeps
  // that message from being swallowed, while a genuine unhealthy payload passes.
  const previousRest = T.getRest()
  try {
    T.setRest(async () => ({ ok: false, error: 'store unreadable' }))
    await assert.rejects(
      T.backendHealthQuery(T.membershipIdentityNow()).queryFn(), /store unreadable/)

    for (const payload of [
      { ok: false, version: '0.6.0', event_db_status: 'unreadable' },
      { ok: false, db_present: false, event_db_present: false, build: { contract: 1 } }
    ]) {
      T.setRest(async () => payload)
      assert.deepEqual(await T.backendHealthQuery(T.membershipIdentityNow()).queryFn(), payload)
      // A fresh profile with no stores still names the pair it is talking to.
      assert.equal(T.backendPairState('conn-1', payload)?.found, 1)
    }
  } finally {
    T.restoreRest(previousRest)
  }
})

test('a mismatched pair renders recovery instructions, not the bare banner', () => {
  const globals = snapshotGlobals(['compatibilityQueryResponse', 'compatibilityLanguage'])
  const previousCompatibility = T.$backendCompatibility.get()
  try {
    T.$backendCompatibility.set([])
    const revision = 'c'.repeat(40)
    const digest = 'd'.repeat(64)
    globalThis.compatibilityQueryResponse = { data: {
      ok: true, version: '0.6.0', build: { contract: 1, revision, desktop_sha256: digest }
    } }

    const shell = T.ProductShell({ children: [] })
    const warnings = shell.props.children
      .filter(node => node?.props?.className === 'wm-alert wm-backend-compatibility')
    assert.equal(warnings.length, 1)
    const text = allText(warnings[0])
    assert.match(text, /different releases/)
    assert.match(text, new RegExp(revision))
    assert.match(text, new RegExp(digest))
    assert.match(text, /desktop-plugins\/spend-sense\/plugin\.js/)
    assert.match(text, /changes no data/)
    assert.match(text, /Saves may fail/)
    assert.doesNotMatch(text, /The backend may be older than this SpendSense Desktop UI/)

    globalThis.compatibilityLanguage = 'zh'
    const zhShell = T.ProductShell({ children: [] })
    const zhWarnings = zhShell.props.children
      .filter(node => node?.props?.className === 'wm-alert wm-backend-compatibility')
    assert.equal(zhWarnings.length, 1)
    const zhText = allText(zhWarnings[0])
    assert.match(zhText, /前后端来自不同版本/)
    assert.match(zhText, new RegExp(revision))
    assert.match(zhText, /一起更新|同时更新/)

    // A healthy, matching pair keeps the shell quiet.
    globalThis.compatibilityLanguage = 'en'
    globalThis.compatibilityQueryResponse = { data: {
      ok: true, version: '0.6.0', build: { contract: T.REQUIRED_BACKEND_CONTRACT }
    } }
    const matched = T.ProductShell({ children: [] })
    assert.equal(matched.props.children
      .filter(node => node?.props?.className === 'wm-alert wm-backend-compatibility').length, 0)
  } finally {
    T.$backendCompatibility.set(previousCompatibility)
    restoreGlobals(globals)
  }
})
