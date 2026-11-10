/**
 * Membership scope, refresh and error-handling regressions — real React, real
 * TanStack Query, synthetic transport.
 *
 * The other suites stub React and re-implement useQuery, which cannot show the
 * behaviour that broke Phase A: a pending request from one gateway resolving
 * into another gateway's render, a stale card writing through the new transport,
 * or `refetch()` resolving with an error the handler never looks at.
 *
 * This builds `desktop/plugin.js` against `test/harness/real-sdk.mjs` (real atoms, real
 * query, fake host + transport) and drives the rendered page.
 *
 * Setup once: npm install --prefix test/harness
 * Run with:   ./scripts/node-tests.sh      (adds --test-force-exit)
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const HARNESS_MODULES = join(ROOT, 'test', 'harness', 'node_modules')

if (!existsSync(join(HARNESS_MODULES, '@tanstack', 'react-query'))) {
  throw new Error('real-query harness is not installed: run `npm ci --prefix test/harness`')
}

const work = mkdtempSync(join(tmpdir(), 'wm-scope-'))
process.on('exit', () => rmSync(work, { recursive: true, force: true }))

// --- one bundle: plugin + real React + real query --------------------------
const entry = join(work, 'entry.mjs')
writeFileSync(entry, `
export { default as plugin, __test as T } from '${join(ROOT, 'desktop', 'plugin.js')}'
export * as React from 'react'
export * as ReactDOMClient from 'react-dom/client'
export { QueryClientProvider, queryClient, host, hostRequests as __hostRequests, $testConnectionId, $testProfile, __bumpActivation, __bumpActivationQuiet, gatewayActivationEpoch, i18nBackend } from '@hermes/plugin-sdk'
`)
const bundle = join(work, 'bundle.mjs')
const esbuild = (await import(pathToFileURL(join(HARNESS_MODULES, 'esbuild', 'lib', 'main.js')).href)).default
await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: bundle,
  alias: {
    '@hermes/plugin-sdk': join(ROOT, 'test', 'harness', 'real-sdk.mjs'),
    // npm installs a peer React into test/harness; two copies means a null
    // dispatcher inside the provider. Pin every import to the app's 19.2.7.
    react: join(HARNESS_MODULES, 'react'),
    'react-dom': join(HARNESS_MODULES, 'react-dom'),
  },
  nodePaths: [HARNESS_MODULES],
  logLevel: 'warning',
})

// --- a DOM before react-dom loads -----------------------------------------
const { JSDOM } = await import(pathToFileURL(join(HARNESS_MODULES, 'jsdom', 'lib', 'api.js')).href)
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/' })
const define = (name, value) => Object.defineProperty(globalThis, name, {
  value, configurable: true, writable: true,
})
define('window', dom.window)
define('document', dom.window.document)
define('navigator', dom.window.navigator)   // read-only getter on Node 24
define('HTMLElement', dom.window.HTMLElement)
define('Node', dom.window.Node)
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const lib = await import(pathToFileURL(bundle).href)
const { plugin, T, React, ReactDOMClient, QueryClientProvider, queryClient, host, __hostRequests,
  $testConnectionId, $testProfile, __bumpActivation, i18nBackend } = lib
// Render through the real English catalogue: assertions see what users see,
// and a key missing from en fails closed to the key itself.
i18nBackend.t = (key, ...args) => {
  const entry = T.I18N.en[key]
  return typeof entry === 'function' ? entry(...args) : entry ?? key
}

// --- the transport the test drives ----------------------------------------
function controller() {
  const calls = []
  let responder = () => ({ ok: true, accounts: [] })
  const transport = (path, opts = {}) => {
    const call = { path, method: String(opts.method || 'GET').toUpperCase(), body: opts.body }
    calls.push(call)
    return Promise.resolve().then(() => responder(call))
  }
  return {
    calls, transport,
    respond(fn) { responder = fn },
    reset() { calls.length = 0 },
    count(predicate) { return calls.filter(predicate).length },
  }
}

function deferred() {
  let resolve, reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

const transportCtl = controller()
const intervalHandles = []

plugin.register({
  rest: transportCtl.transport,
  storage: { get: (_k, d) => d, set() {}, delete() {} },
  register() {}, registerMany() {}, onDispose() {}, onEvent: () => () => {},
  setTimeout: (fn) => { const t = setTimeout(fn, 0); return () => clearTimeout(t) },
  setInterval: (fn, ms) => {
    if (ms !== 250) return () => {}
    const handle = setInterval(fn, ms); handle.unref(); intervalHandles.push(handle)
    return () => clearInterval(handle)
  },
  addEventListener: () => () => {},
  os: {}, pet: null, i18n: { register() {}, t: key => key },
})

const account = (id, extra = {}) => ({
  id, family: 'openai-codex', label: id, route_slugs: ['openai-codex'],
  billing_arrangement: 'subscription', plan_id: null, plan: null, fee: { basis: 'no_plan', effective: { amount: null } },
  quota: { windows: [] }, manual_exhaustions: [], fee_overrides: [],
  plan_choices: [], excluded_plans: [], rev: 'r1', route_entitlement_rev: 'route-r1', ...extra,
})

const roots = []
const boot = async () => {
  queryClient.clear()
  T.$membershipSnapshot.set(null)
  T.$membershipDraft.set(null)
  T.$membershipNotice.set(null)
  T.$membershipBusy.set(null)
  T.$membershipNative.set(false)
  T.$membershipTarget.set(null)
  T.$membershipExpanded.set({ origin: null, ids: [] })
  T.$membershipAttentionOnly.set(false)
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = ReactDOMClient.createRoot(container)
  roots.push(root)
  await React.act(async () => {
    root.render(React.createElement(QueryClientProvider, { client: queryClient },
      React.createElement(T.MembershipsPage)))
  })
  return { container, root, text: () => container.textContent }
}

const flush = async (times = 6) => {
  await React.act(async () => {
    for (let i = 0; i < times; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 0))
    }
  })
}


const typeAmount = async (container, value) => {
  const input = container.querySelector('form input[type="number"]')
  assert.ok(input, 'the fee form has an amount field')
  await React.act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, value)
    input.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
  await flush(2)
}

const clickByText = async (container, label) => {
  const button = [...container.querySelectorAll('button')].find(b => (b.textContent || '').includes(label))
  assert.ok(button, `no button matching ${label}`)
  await React.act(async () => { button.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  return button
}

const saveManualStatus = async container => {
  await flush(1)
  await clickByText(container, 'Save manual status')
  await flush(1)
}

const setField = async (container, labelText, value, scope = container) => {
  const label = [...scope.querySelectorAll('label')].find(item =>
    item.textContent.trim().startsWith(labelText) && item.querySelector('input,select'))
  assert.ok(label, `no field labelled ${labelText}`)
  const control = label.querySelector('input,select')
  await React.act(async () => {
    const prototype = control.tagName === 'SELECT'
      ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value').set
    setter.call(control, value)
    control.dispatchEvent(new window.Event(control.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }))
  })
}

const plansOk = () => ({ ok: true, families: [], vocabulary: { override_reasons: ['discount'], currencies: ['USD', 'GBP'], periods: ['month'], window_scopes: ['account'] }, totals: {} })

// ---------------------------------------------------------------------------

// jsdom keeps its own timers; without this the runner waits forever for a
// promise that a closed window would have settled.
after(() => { intervalHandles.forEach(clearInterval); queryClient.clear(); dom.window.close() })

test.afterEach(async () => {
  while (roots.length) {
    const root = roots.pop()
    try { await React.act(async () => { root.unmount() }) } catch { /* already gone */ }
  }
  queryClient.clear()
})

test('a pending read from the previous gateway cannot become the new gateway\'s answer', async () => {
  $testConnectionId.set('gateway-a'); $testProfile.set('default')
  const pendingA = deferred()
  transportCtl.reset()
  transportCtl.respond(call => call.path.startsWith('/membership/plans') ? plansOk() : pendingA.promise)

  const { container } = await boot()
  await flush(2)
  assert.match(container.textContent, /Reading memberships/, 'the pending read is shown as loading, not as empty')
  assert.doesNotMatch(container.textContent, /Plans confirmed0 of 0|No memberships yet/,
    'unconfirmed snapshot state does not expose zeros or the authoritative empty state')

  // switch gateway while A's request is still in flight
  $testConnectionId.set('gateway-b')
  transportCtl.respond(call => call.path.startsWith('/membership/plans')
    ? plansOk()
    : { ok: true, accounts: [account('b:default', { label: 'B account' })] })
  await flush(2)

  // A's transport finally rejects with the 404 that used to surface as B's state
  await React.act(async () => {
    pendingA.reject(new Error('404 {"detail":"Plugin not found"}'))
    await new Promise(resolve => setTimeout(resolve, 0))
  })
  await flush(4)

  assert.match(container.textContent, /B account/, 'gateway B\'s accounts are what render')
  assert.doesNotMatch(container.textContent, /Plugin not found|not available on this connection/,
    'a late 404 from A must not be reported as B\'s failure')
})

test('switching profile re-reads instead of reusing the previous profile\'s rows', async () => {
  $testConnectionId.set('gateway-a'); $testProfile.set('default')
  transportCtl.reset()
  transportCtl.respond(call => call.path.startsWith('/membership/plans')
    ? plansOk()
    : { ok: true, accounts: [account('default:acct', { label: 'Default profile account' })] })
  const { container } = await boot()
  await flush(3)
  assert.match(container.textContent, /Default profile account/)

  transportCtl.respond(call => call.path.startsWith('/membership/plans')
    ? plansOk()
    : { ok: true, accounts: [account('work:acct', { label: 'Work profile account' })] })
  $testProfile.set('work')
  await flush(4)

  assert.match(container.textContent, /Work profile account/)
  assert.doesNotMatch(container.textContent, /Default profile account/,
    'the previous profile\'s rows must not survive the switch')
})

test('after a switch, a card can only write through its own scope', async () => {
  $testConnectionId.set('gateway-a'); $testProfile.set('default')
  transportCtl.reset()
  transportCtl.respond(call => call.path.startsWith('/membership/plans')
    ? plansOk()
    : call.method === 'GET' ? { ok: true, accounts: [account('a:acct', { label: 'A account' })] }
      : { ok: true, accounts: [] })
  const { container } = await boot()
  await flush(3)
  assert.match(container.textContent, /A account/)

  // The switch, then a click in the same tick — the card on screen is still A's.
  transportCtl.respond(call => call.path.startsWith('/membership/plans')
    ? plansOk()
    : call.method === 'GET' ? { ok: true, accounts: [account('b:acct', { label: 'B account' })] }
      : { ok: true, accounts: [] })
  $testConnectionId.set('gateway-b')
  await flush(3)
  assert.match(container.textContent, /B account/, 'the switched profile card is rendered before using it')

  const writes = transportCtl.calls.filter(c => c.method !== 'GET')
  assert.equal(writes.filter(c => JSON.stringify(c).includes('a:acct')).length, 0,
    'no mutation may be aimed at the previous gateway\'s account')

  // In the new scope the action works, and it targets the new account.
  await clickByText(container, 'Mark account exhausted')
  await saveManualStatus(container)
  await flush(3)
  const after = transportCtl.calls.filter(c => c.method !== 'GET')
  assert.ok(after.some(c => c.path.includes('b%3Aacct') || c.path.includes('b:acct')),
    `the write targets the new scope's account (${JSON.stringify(after.map(c => c.path))})`)
  assert.ok(!after.some(c => JSON.stringify(c).includes('a:acct')))
})

test('a failed refresh never claims the readings were refreshed', async () => {
  $testConnectionId.set('gateway-a'); $testProfile.set('default')
  transportCtl.reset()
  transportCtl.respond(call => call.path.startsWith('/membership/plans')
    ? plansOk()
    : { ok: true, accounts: [account('a:acct', { label: 'A account' })] })
  const { container, root } = await boot()
  await flush(3)

  transportCtl.respond(() => { throw new Error('500 Internal Server Error') })
  await clickByText(container, 'Refresh provider usage')
  await flush(3)

  const text = container.textContent
  assert.doesNotMatch(text, /Readings refreshed from Hermes/, 'success must not be announced')
  assert.match(text, /backend answered with an error/i, 'the failure is described')
  assert.match(text, /A account/, 'the last known reading stays on screen')
})

test('a malformed envelope is an error, not an empty membership list', async () => {
  queryClient.clear()
  $testConnectionId.set('gateway-a'); $testProfile.set('default')
  transportCtl.reset()
  transportCtl.respond(call => call.path.startsWith('/membership/plans') ? plansOk() : { ok: true })
  const { container } = await boot()
  await flush(3)

  assert.doesNotMatch(container.textContent, /No memberships yet/,
    'an unreadable answer must not be presented as an empty account list')
  assert.match(container.textContent, /could not be read|did not load|retry/i)
  const summary = container.querySelector('.wm-membership-summary')
  assert.ok(summary, 'headline summary stays present when account data cannot be read')
  assert.match(summary.textContent, /Unavailable/)
  assert.equal(summary.getAttribute('aria-busy'), 'false')
})

test('recovery: after a 503 the next read renders accounts and clears the error', async () => {
  $testConnectionId.set('gateway-a'); $testProfile.set('default')
  transportCtl.reset()
  transportCtl.respond(call => call.path.startsWith('/membership/plans')
    ? plansOk()
    : { ok: false, error: 'store_unreadable: membership store unreadable: JSONDecodeError' })
  const { container, root } = await boot()
  await flush(3)
  assert.match(container.textContent, /could not be read, so nothing was changed|store/i)

  transportCtl.respond(call => call.path.startsWith('/membership/plans')
    ? plansOk()
    : { ok: true, accounts: [account('a:acct', { label: 'Recovered account' })] })
  await clickByText(container, 'Refresh provider usage')
  await flush(4)

  assert.match(container.textContent, /Recovered account/, 'the pane recovers without a reload')
})

test('diagnostics record the request shape and never a credential', async () => {
  $testConnectionId.set('gateway-a'); $testProfile.set('default')
  transportCtl.reset()
  transportCtl.respond(call => call.path.startsWith('/membership/plans')
    ? plansOk()
    : { ok: true, accounts: [account('a:acct', { label: 'A account' })] })
  T.membershipDiagnostics.length = 0
  const { container } = await boot()
  await flush(3)

  assert.ok(T.membershipDiagnostics.length > 0,
    `a request was recorded (calls: ${JSON.stringify(transportCtl.calls.map(c => c.method + ' ' + c.path))})`)
  const entry = T.membershipDiagnostics[0]
  for (const key of ['at', 'plugin', 'method', 'path', 'status', 'scope', 'generation']) {
    assert.ok(key in entry, `diagnostics missing ${key}`)
  }
  const serialised = JSON.stringify(T.membershipDiagnostics).toLowerCase()
  for (const forbidden of ['token', 'authorization', 'cookie', 'secret', 'bearer']) {
    assert.ok(!serialised.includes(forbidden), `diagnostics leaked ${forbidden}`)
  }
  assert.match(container.textContent, /Request diagnostics/, 'the pane offers the evidence')
})

test('reverse completion order: A succeeding late still cannot replace B', async () => {
  $testConnectionId.set('gateway-a'); $testProfile.set('default')
  const pendingA = deferred()
  transportCtl.reset()
  transportCtl.respond(call => call.path.startsWith('/membership/plans') ? plansOk() : pendingA.promise)
  const { container } = await boot()
  await flush(2)

  $testConnectionId.set('gateway-b')
  transportCtl.respond(call => call.path.startsWith('/membership/plans')
    ? plansOk()
    : { ok: true, accounts: [account('b:acct', { label: 'B account' })] })
  await flush(3)
  assert.match(container.textContent, /B account/)

  // A resolves successfully *after* B has rendered.
  await React.act(async () => {
    pendingA.resolve({ ok: true, accounts: [account('a:acct', { label: 'A account' })] })
    await new Promise(resolve => setTimeout(resolve, 0))
  })
  await flush(4)

  assert.match(container.textContent, /B account/)
  assert.doesNotMatch(container.textContent, /A account/,
    'a late success from the previous gateway must not replace the current rows')
})

test('host invalidation during a switch does not resurrect the old scope', async () => {
  $testConnectionId.set('gateway-a'); $testProfile.set('default')
  transportCtl.reset()
  transportCtl.respond(call => call.path.startsWith('/membership/plans')
    ? plansOk()
    : { ok: true, accounts: [account('a:acct', { label: 'A account' })] })
  const { container } = await boot()
  await flush(3)

  transportCtl.respond(call => call.path.startsWith('/membership/plans')
    ? plansOk()
    : { ok: true, accounts: [account('b:acct', { label: 'B account' })] })
  $testConnectionId.set('gateway-b')
  // The host invalidates profile-scoped queries on activation; do the same.
  await React.act(async () => { await queryClient.invalidateQueries() })
  await flush(4)

  assert.match(container.textContent, /B account/)
  assert.doesNotMatch(container.textContent, /A account/)
})

test('a plans-only failure leaves healthy accounts visible', async () => {
  $testConnectionId.set('gateway-a'); $testProfile.set('default')
  transportCtl.reset()
  transportCtl.respond(call => call.path.startsWith('/membership/plans')
    ? (() => { throw new Error('404 {"detail":"Plugin not found"}') })()
    : { ok: true, accounts: [account('a:acct', { label: 'A account' })] })
  const { container } = await boot()
  await flush(3)

  assert.match(container.textContent, /A account/, 'accounts still render')
  assert.match(container.textContent, /Plan catalogue unavailable/, 'the plans failure is stated separately')
  assert.doesNotMatch(container.textContent, /No memberships yet/)
})

test('a write that is followed by a failed read says exactly that', async () => {
  $testConnectionId.set('gateway-a'); $testProfile.set('default')
  transportCtl.reset()
  transportCtl.respond(call => call.path.startsWith('/membership/plans')
    ? plansOk()
    : { ok: true, accounts: [account('a:acct', { label: 'A account' })] })
  const { container } = await boot()
  await flush(3)

  transportCtl.respond(call => {
    if (call.path.startsWith('/membership/plans')) return plansOk()
    if (call.method !== 'GET') return { ok: true, accounts: [] }
    throw new Error('500 Internal Server Error')
  })
  await clickByText(container, 'Mark account exhausted')
  await saveManualStatus(container)
  await flush(4)

  assert.doesNotMatch(container.textContent, /^Saved\.$/m, 'a clean success is not announced')
  assert.match(container.textContent, /Saved, but the list could not be re-read/)
  assert.match(container.textContent, /A account/, 'the last known rows stay on screen')
})

test('Metered API persists, disables subscription controls and restores the saved subscription', async () => {
  $testConnectionId.set('gateway-a'); $testProfile.set('default'); transportCtl.reset()
  let saved = account('api', { label: 'Account A', plan_id: 'example.pro',
    plan_choices: [{ id: 'example.pro', name: 'Pro', price: { amount: 20, currency: 'USD', period: 'month' } }],
    fee: { basis: 'declared', effective: { amount: 17, currency: 'GBP', period: 'year' } } })
  transportCtl.respond(call => {
    if (call.path.startsWith('/membership/plans')) return plansOk()
    if (call.method === 'PUT') {
      saved = { ...saved, billing_arrangement: call.body.arrangement,
        api_only: call.body.arrangement === 'api_only', effective_arrangement: call.body.arrangement,
        fee: call.body.arrangement === 'api_only' ? { basis: 'api_only', effective: { amount: null } }
          : { basis: 'declared', effective: { amount: 17, currency: 'GBP', period: 'year' } } }
      return { ok: true, account: saved }
    }
    return { ok: true, accounts: [saved] }
  })
  const { container } = await boot(); await flush(3)
  const seg = () => container.querySelector('[data-nav="arrangement"]')
  const press = label => [...seg().querySelectorAll('button')].find(b => b.textContent === label)
  assert.equal(press('Subscription').getAttribute('aria-pressed'), 'true')
  await React.act(async () => press('Metered API').click()); await flush(4)
  assert.equal(saved.api_only, true)
  assert.equal(saved.plan_id, 'example.pro')
  assert.match(container.textContent, /Metered API · no recurring membership fee/)
  const planSelect = [...container.querySelectorAll('label')].find(l => l.textContent.includes('Plan for this provider account')).querySelector('select')
  assert.equal(planSelect.disabled, true)
  assert.equal([...container.querySelectorAll('button')].find(b => b.textContent === 'Edit fee').disabled, true)
  await React.act(async () => press('Subscription').click()); await flush(4)
  assert.equal(saved.api_only, false)
  assert.equal(saved.billing_arrangement, 'subscription')
  assert.equal(planSelect.disabled, false)
  assert.match(container.textContent, /£17.00\/yr/)
})

test('unconfirmed and prepaid accounts show their arrangements without subscription controls', async () => {
  $testConnectionId.set('gateway-a'); $testProfile.set('default'); transportCtl.reset()
  let saved = account('wallet', { billing_arrangement: 'unconfirmed', effective_arrangement: 'unconfirmed' })
  transportCtl.respond(call => {
    if (call.path.startsWith('/membership/plans')) return plansOk()
    if (call.method === 'PUT') {
      saved = { ...saved, billing_arrangement: call.body.arrangement,
        api_only: call.body.arrangement === 'api_only', effective_arrangement: call.body.arrangement }
      return { ok: true }
    }
    return { ok: true, accounts: [saved] }
  })
  const { container } = await boot(); await flush(3)
  const card = container.querySelector('[data-account="wallet"]')
  assert.match(card.textContent, /No confirmed billing arrangement/)
  assert.doesNotMatch(card.textContent, /Plan for this provider account/)
  const seg = card.querySelector('[data-nav="arrangement"]')
  assert.equal([...seg.querySelectorAll('button')].find(b => b.textContent === 'Not confirmed').getAttribute('aria-pressed'), 'true')
  await React.act(async () => {
    [...seg.querySelectorAll('button')].find(b => b.textContent === 'Prepaid credits').click()
  }); await flush(4)
  assert.equal(saved.billing_arrangement, 'prepaid')
  assert.equal(saved.api_only, false)
  assert.match(card.textContent, /Prepaid credit account/)
  assert.doesNotMatch(card.textContent, /Plan for this provider account/)
  assert.doesNotMatch(card.textContent, /Edit fee/)
})

test('Included can explicitly link to a plan-less account with a declared paid fee', async () => {
  $testConnectionId.set('gateway-a'); $testProfile.set('default'); transportCtl.reset()
  const owner = account('commandcode:default', {
    family: 'commandcode', label: 'CommandCode', route_slugs: ['commandcode'],
    billing_arrangement: 'subscription', effective_arrangement: 'subscription',
    fee: { basis: 'declared', effective: { amount: 20, currency: 'USD', period: 'month' } },
  })
  const source = account('anthropic:default', {
    family: 'anthropic', label: 'Anthropic', route_slugs: ['anthropic'],
    billing_arrangement: 'subscription', effective_arrangement: 'subscription',
  })
  let write = null
  transportCtl.respond(call => call.path.startsWith('/membership/plans') ? plansOk()
    : call.method === 'PUT'
      ? (write = call, { ok: true, accounts: [owner, source] })
      : { ok: true, accounts: [owner, source], store: { loaded: true, error: '' }, notes: [] })
  const { container } = await boot(); await flush(3)
  const card = container.querySelector('[data-account="anthropic:default"]')
  await React.act(async () => {
    [...card.querySelectorAll('[data-nav="arrangement"] button')]
      .find(button => button.textContent === 'Included via another subscription').click()
  })
  const ownerSelect = card.querySelector('label select')
  assert.ok(ownerSelect, 'the Included choice opens an explicit owner selector')
  assert.equal([...ownerSelect.options].some(option => option.value === owner.id), true,
    'a declared positive fee makes this confirmed subscription available as an owner')
  await setField(card, 'Owning paid subscription', owner.id)
  await flush(4)
  assert.ok(write, 'choosing an owner sends the relationship write')
  assert.equal(write.path, '/membership/accounts/anthropic%3Adefault/arrangement')
  assert.equal(write.body.owner_account_id, owner.id)
  assert.equal(write.body.arrangement, 'included')
})

test('cancelling an inline fee edit does not save the draft', async () => {
  $testConnectionId.set('gateway-a'); $testProfile.set('default'); transportCtl.reset()
  transportCtl.respond(call => call.path.startsWith('/membership/plans') ? plansOk() : { ok: true, accounts: [account('cancel')] })
  const { container } = await boot(); await flush(3)
  await clickByText(container, 'Edit fee'); await typeAmount(container, '33')
  await clickByText(container.querySelector('.wm-fee-form'), 'Cancel'); await flush(2)
  assert.equal(container.querySelector('.wm-fee-form'), null)
  assert.equal(transportCtl.calls.filter(c => c.method !== 'GET').length, 0)
})

test('fee save updates the selected card, closes the editor and announces success', async () => {
  $testConnectionId.set('gateway-a'); $testProfile.set('default'); transportCtl.reset()
  let saved = account('fee', { label: 'Fee account' })
  transportCtl.respond(call => {
    if (call.path.startsWith('/membership/plans')) return plansOk()
    if (call.method === 'PUT') {
      saved = { ...call.body, fee: { basis: 'declared', effective: { amount: 23, currency: 'USD', period: 'month' } } }
      return { ok: true, account: saved }
    }
    return { ok: true, accounts: [saved] }
  })
  const { container } = await boot(); await flush(3)
  await clickByText(container, 'Edit fee'); await typeAmount(container, '23')
  await clickByText(container, 'Save fee'); await flush(5)
  assert.equal(container.querySelector('.wm-fee-form'), null)
  assert.match(container.querySelector('[data-account="fee"]').textContent, /Your price: \$23.00\/mo/)
  assert.match(container.querySelector('[role="status"]').textContent, /Saved/)
})

test('fee editor opens in the selected account card', async () => {
  $testConnectionId.set('gateway-a'); $testProfile.set('default')
  transportCtl.reset()
  transportCtl.respond(call => call.path.startsWith('/membership/plans') ? plansOk()
    : { ok: true, accounts: [account('a:acct', { label: 'A account' }), account('b:acct', { label: 'B account' })] })
  const { container } = await boot()
  await flush(3)
  const cards = [...container.querySelectorAll('article[data-account]')]
  const button = [...cards[1].querySelectorAll('button')].find(b => b.textContent === 'Edit fee')
  await React.act(async () => { button.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  await flush(2)
  assert.equal(cards[0].querySelector('form'), null)
  assert.ok(cards[1].querySelector('form'))
  assert.match(cards[1].querySelector('form').textContent, /Membership fee · B account/)
})

test('a rejected fee save keeps what the owner typed', async () => {
  $testConnectionId.set('gateway-a'); $testProfile.set('default')
  transportCtl.reset()
  transportCtl.respond(call => call.path.startsWith('/membership/plans') ? plansOk()
    : { ok: true, accounts: [account('a:acct', { label: 'A account' })] })
  const { container } = await boot()
  await flush(3)

  await clickByText(container, 'Edit fee')
  await flush(2)
  const form = container.querySelector('form')
  assert.ok(form, 'the fee form opened')

  // type an amount into the first input of the form
  const input = form.querySelector('input[type="number"]')
  await React.act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, '19.5')
    input.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
  await flush(2)

  transportCtl.respond(call => {
    if (call.path.startsWith('/membership/plans')) return plansOk()
    if (call.method === 'PUT') throw new Error('409 conflict: editing an existing membership requires if_rev')
    return { ok: true, accounts: [account('a:acct', { label: 'A account' })] }
  })
  const submit = [...container.querySelectorAll('button')].find(b => (b.textContent || '') === 'Save fee')
  await React.act(async () => { submit.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  await flush(3)

  assert.match(container.textContent, /changed since you loaded it/, 'the conflict is explained')
  assert.ok(container.querySelector('form'), 'the form stays open')
  assert.match(container.querySelector('form [role=alert]').textContent, /changed since you loaded it/)
  assert.equal(container.querySelector('input[type="number"]').value, '19.5',
    'the typed amount survives the failure')
})

test('A → B → A: the return trip shows A again and drops B\'s late reply', async () => {
  $testConnectionId.set('gateway-a'); $testProfile.set('default')
  const pendingB = deferred()
  transportCtl.reset()
  transportCtl.respond(call => call.path.startsWith('/membership/plans')
    ? plansOk()
    : { ok: true, accounts: [account('a:acct', { label: 'A account' })] })
  const { container } = await boot()
  await flush(2)
  assert.match(container.textContent, /A account/)

  // leave for B, whose read never answers
  transportCtl.respond(call => call.path.startsWith('/membership/plans') ? plansOk() : pendingB.promise)
  $testConnectionId.set('gateway-b')
  await flush(2)

  // come back to A while B is still in flight
  transportCtl.respond(call => call.path.startsWith('/membership/plans')
    ? plansOk()
    : { ok: true, accounts: [account('a:acct', { label: 'A account' })] })
  $testConnectionId.set('gateway-a')
  await flush(3)
  assert.match(container.textContent, /A account/, 'A\'s rows are shown again on return')

  // B answers only now
  await React.act(async () => {
    pendingB.resolve({ ok: true, accounts: [account('b:acct', { label: 'B account' })] })
    await new Promise(resolve => setTimeout(resolve, 0))
  })
  await flush(4)

  assert.match(container.textContent, /A account/)
  assert.doesNotMatch(container.textContent, /B account/,
    'a reply from the abandoned scope must not surface after the return trip')
})

test('a fee save submitted in the same tick as a switch emits no mutation', async () => {
  $testConnectionId.set('gateway-a'); $testProfile.set('default')
  transportCtl.reset()
  transportCtl.respond(call => call.path.startsWith('/membership/plans') ? plansOk()
    : { ok: true, accounts: [account('a:acct', { label: 'A account' })] })
  const { container } = await boot()
  await flush(3)
  await clickByText(container, 'Edit fee')
  await flush(2)
  const form = container.querySelector('form')
  assert.ok(form, 'the fee form is open on A')
  const submit = [...form.querySelectorAll('button')].find(b => (b.textContent || '') === 'Save fee')

  transportCtl.respond(call => call.path.startsWith('/membership/plans') ? plansOk()
    : call.method === 'GET' ? { ok: true, accounts: [account('b:acct', { label: 'B account' })] }
      : { ok: true, accounts: [] })

  // Switch, then submit before React has re-rendered the pane: the form on
  // screen is still A's, so this is exactly the wrong-destination write.
  $testConnectionId.set('gateway-b')
  await React.act(async () => {
    submit.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  })
  await flush(4)

  const writes = transportCtl.calls.filter(c => c.method !== 'GET')
  assert.equal(writes.length, 0,
    `no mutation may be emitted after the switch (saw ${JSON.stringify(writes.map(c => c.method + ' ' + c.path))})`)
  assert.match(T.$membershipNotice.get()?.text || '', /belongs to a different connection/)
})

test('a late post-save read cannot overwrite a newer successful read', async () => {
  $testConnectionId.set('gateway-a'); $testProfile.set('default'); transportCtl.reset()
  const postSave = deferred()
  let written = false, readCount = 0
  transportCtl.respond(call => {
    if (call.path.startsWith('/membership/plans')) return plansOk()
    if (call.method === 'PUT') { written = true; return { ok: true } }
    if (!written) return { ok: true, accounts: [account('race', { label: 'Initial' })] }
    readCount++
    return readCount === 1 ? postSave.promise : { ok: true, accounts: [account('race', { label: 'Newest' })] }
  })
  const { container } = await boot(); await flush(3)
  await clickByText(container, 'Edit fee'); await typeAmount(container, '17')
  await clickByText(container, 'Save fee'); await flush(2)
  await React.act(async () => { await queryClient.refetchQueries({ queryKey: ['spend-sense', 'membership-accounts'], type: 'active' }) })
  await flush(3)
  assert.match(container.textContent, /Newest/)
  await React.act(async () => postSave.resolve({ ok: true, accounts: [account('race', { label: 'Older' })] }))
  await flush(4)
  assert.match(container.textContent, /Newest/)
  assert.doesNotMatch(container.textContent, /Older/)
  assert.match(container.textContent, /Saved\./)
  assert.equal(container.querySelector('.wm-fee-form'), null)
})

test('a newer failed read does not suppress a successful post-save read', async () => {
  $testConnectionId.set('gateway-a'); $testProfile.set('default'); transportCtl.reset()
  const postSave = deferred()
  let written = false, readCount = 0
  transportCtl.respond(call => {
    if (call.path.startsWith('/membership/plans')) return plansOk()
    if (call.method === 'PUT') { written = true; return { ok: true } }
    if (!written) return { ok: true, accounts: [account('race', { label: 'Initial' })] }
    readCount++
    if (readCount === 1) return postSave.promise
    throw new Error('503 unavailable')
  })
  const { container } = await boot(); await flush(3)
  await clickByText(container, 'Edit fee'); await typeAmount(container, '17')
  await clickByText(container, 'Save fee'); await flush(2)
  await React.act(async () => { await queryClient.refetchQueries({ queryKey: ['spend-sense', 'membership-accounts'], type: 'active' }) })
  await React.act(async () => postSave.resolve({ ok: true, accounts: [account('race', { label: 'Saved account' })] }))
  await flush(4)
  assert.match(container.textContent, /Saved account/)
  assert.match(container.textContent, /Saved\./)
  assert.equal(container.querySelector('.wm-fee-form'), null)
})

test('a late reread from the previous scope cannot close a draft opened since', async () => {
  $testConnectionId.set('gateway-a'); $testProfile.set('default')
  transportCtl.reset()
  transportCtl.respond(call => call.path.startsWith('/membership/plans') ? plansOk()
    : { ok: true, accounts: [account('a:acct', { label: 'A account' })] })
  const { container } = await boot()
  await flush(3)
  await clickByText(container, 'Edit fee')
  await flush(2)

  // The write lands *while A is still current*, so the pane starts its canonical
  // reread; that read is what hangs. This is the window the review found: the
  // save has been accepted, and the reread outlives the scope that started it.
  const pendingReread = deferred()
  let holdReread = true
  transportCtl.respond(call => {
    if (call.path.startsWith('/membership/plans')) return plansOk()
    if (call.method !== 'GET') return { ok: true, accounts: [account('a:acct', { label: 'A account' })] }
    return holdReread ? pendingReread.promise : { ok: true, accounts: [account('b:acct', { label: 'B account' })] }
  })
  await typeAmount(container, '12.5')
  await clickByText(container, 'Save fee')
  await flush(2)
  assert.ok(T.$membershipBusy.get(), 'the save is still settling while its reread hangs')

  // Switch to B and open a fresh draft there.
  holdReread = false
  $testConnectionId.set('gateway-b')
  await flush(3)
  await clickByText(container, 'Edit fee')
  await flush(2)
  assert.ok(container.querySelector('form'), 'B has a draft open')

  // A's reread finally answers.
  await React.act(async () => {
    pendingReread.resolve({ ok: true, accounts: [account('a:acct', { label: 'A account' })] })
    await new Promise(resolve => setTimeout(resolve, 0))
  })
  await flush(4)

  assert.ok(container.querySelector('form'), 'the new scope\'s draft is still open')
  assert.match(container.textContent, /B account/)
  assert.doesNotMatch(container.textContent, /A account/)
})

test('a completing request cannot clear another scope\'s busy state or post its notice', async () => {
  $testConnectionId.set('gateway-a'); $testProfile.set('default')
  const pendingA = deferred()
  transportCtl.reset()
  transportCtl.respond(call => call.path.startsWith('/membership/plans') ? plansOk()
    : { ok: true, accounts: [account('a:acct', { label: 'A account' })] })
  const { container } = await boot()
  await flush(3)

  transportCtl.respond(call => call.path.startsWith('/membership/plans') ? plansOk() : pendingA.promise)
  await clickByText(container, 'Mark account exhausted')
  await saveManualStatus(container)

  // B starts its own work while A's mark is still in flight
  $testConnectionId.set('gateway-b')
  const pendingB = deferred()
  transportCtl.respond(call => {
    if (call.path.startsWith('/membership/plans')) return plansOk()
    return call.method === 'GET' ? { ok: true, accounts: [account('b:acct', { label: 'B account' })] } : pendingB.promise
  })
  await flush(3)
  await clickByText(container, 'Mark account exhausted')
  await saveManualStatus(container)
  const busyBefore = T.$membershipBusy.get()
  assert.equal(busyBefore?.origin, 'gateway-b|default#1', 'B holds the busy flag')

  await React.act(async () => {
    pendingA.resolve({ ok: true, accounts: [] })
    await new Promise(resolve => setTimeout(resolve, 0))
  })
  await flush(3)

  assert.equal(T.$membershipBusy.get()?.origin, 'gateway-b|default#1',
    'A finishing must not clear B\'s busy state')
  assert.notEqual(T.$membershipNotice.get()?.origin, 'gateway-a|default#1',
    'A\'s completion must not post a notice into B')

  await React.act(async () => {
    pendingB.resolve({ ok: true, accounts: [] })
    await new Promise(resolve => setTimeout(resolve, 0))
  })
  await flush(2)
})

test('a re-activation while a request is pending cannot be populated by it', async () => {
  $testConnectionId.set('gateway-a'); $testProfile.set('default')
  const pendingOriginal = deferred()
  transportCtl.reset()
  transportCtl.respond(call => call.path.startsWith('/membership/plans') ? plansOk() : pendingOriginal.promise)
  const { container } = await boot()
  await flush(2)

  // the gateway re-activates: same connection, same profile, new generation
  const epoch = lib.__bumpActivation()
  assert.equal(lib.gatewayActivationEpoch(), epoch, 'the harness really bumped the epoch')
  transportCtl.respond(call => call.path.startsWith('/membership/plans') ? plansOk()
    : { ok: true, accounts: [account('a:new', { label: 'Re-activated account' })] })
  await flush(4)

  // the original (pre-activation) request answers only now
  await React.act(async () => {
    pendingOriginal.resolve({ ok: true, accounts: [account('a:old', { label: 'Stale activation account' })] })
    await new Promise(resolve => setTimeout(resolve, 0))
  })
  await flush(4)

  assert.match(container.textContent, /Re-activated account/)
  assert.doesNotMatch(container.textContent, /Stale activation account/,
    'a result from the previous activation must not populate the new one')
})

test('a pending membership save disables mutation controls on other accounts and restores them afterwards', async () => {
  $testConnectionId.set('gateway-a'); $testProfile.set('default'); transportCtl.reset()
  const pending = deferred()
  const a = account('busy-a', { label: 'Account A' })
  const b = account('busy-b', { label: 'Account B',
    fee: { basis: 'declared', effective: { amount: 10, currency: 'USD', period: 'month' },
      published: { source: 'catalogue' }, override: { revision_id: 'fee-1' } },
    quota: { windows: [{ id: 'weekly', label: 'Weekly', manual: { id: 'manual-1', status: 'active' } }] } })
  transportCtl.respond(call => call.path.startsWith('/membership/plans') ? plansOk()
    : call.method === 'PUT' ? pending.promise : { ok: true, accounts: [a, b] })
  const { container } = await boot(); await flush(3)
  const card = id => container.querySelector(`[data-account="${id}"]`)
  await clickByText(card('busy-b'), 'Create user-defined plan')
  await setField(container, 'Plan name', 'Test plan', card('busy-b').querySelector('.wm-custom-form'))
  await clickByText(card('busy-b'), 'Mark exhausted')
  await clickByText(card('busy-a'), 'Edit fee'); await typeAmount(card('busy-a'), '17')
  await clickByText(card('busy-a'), 'Save fee'); await flush(2)
  const button = name => [...card('busy-b').querySelectorAll('button')].find(el => el.textContent === name)
  for (const name of ['Mark exhausted', 'Clear mark', 'Mark account exhausted', 'Save manual status',
    'Save user-defined plan', 'Restore catalogue price']) {
    assert.ok(button(name), `expected ${name}`)
    assert.equal(button(name).disabled, true, `${name} disabled while another account is saving`)
  }
  assert.match(card('busy-a').textContent, /Saving changes/)
  await React.act(async () => pending.resolve({ ok: true }))
  await flush(4)
  for (const name of ['Mark exhausted', 'Clear mark', 'Mark account exhausted', 'Save manual status',
    'Save user-defined plan', 'Restore catalogue price']) {
    assert.equal(button(name).disabled, false, `${name} available after save`)
  }
  assert.equal(transportCtl.calls.filter(c => c.method === 'PUT').length, 1)
})

test('an action in the same tick as a save receives a busy explanation', async () => {
  $testConnectionId.set('gateway-a'); $testProfile.set('default'); transportCtl.reset()
  const pending = deferred()
  const a = account('race-a'), b = account('race-b')
  transportCtl.respond(call => call.path.startsWith('/membership/plans') ? plansOk()
    : call.method === 'PUT' ? pending.promise : { ok: true, accounts: [a, b] })
  const { container } = await boot(); await flush(3)
  const first = container.querySelector('[data-account="race-a"]')
  const second = container.querySelector('[data-account="race-b"]')
  await clickByText(first, 'Edit fee'); await typeAmount(first, '17')
  const save = [...first.querySelectorAll('button')].find(el => el.textContent === 'Save fee')
  const mark = second.querySelector('[data-action="exhaust-account"]')
  await React.act(async () => { save.click(); mark.click() })
  assert.match(container.textContent, /Another membership action is still processing/)
  assert.equal(transportCtl.calls.filter(c => c.method !== 'GET').length, 1)
  assert.equal(second.querySelector('.wm-exhaustion-form'), null)
  await React.act(async () => pending.resolve({ ok: true })); await flush(4)
})

test('a pending save disables duplicate submission and editing', async () => {
  $testConnectionId.set('gateway-a'); $testProfile.set('default')
  transportCtl.reset()
  const pending = deferred()
  transportCtl.respond(call => call.path.startsWith('/membership/plans') ? plansOk()
    : call.method === 'PUT' ? pending.promise : { ok: true, accounts: [account('same')] })
  const { container } = await boot(); await flush(3)
  await clickByText(container, 'Edit fee'); await typeAmount(container, '17')
  await clickByText(container, 'Save fee'); await flush(2)
  assert.ok([...container.querySelectorAll('button')].find(b => b.textContent === 'Saving…')?.disabled)
  assert.ok(container.querySelector('fieldset').disabled)
  assert.equal(transportCtl.calls.filter(c => c.method === 'PUT').length, 1)
  await React.act(async () => pending.resolve({ ok: true }))
  await flush(4)
})

test('profile A to B to A rejects original A when socket remains open', async () => {
  $testConnectionId.set('gateway-a'); $testProfile.set('default')
  const original = deferred()
  transportCtl.respond(call => call.path.startsWith('/membership/plans') ? plansOk() : original.promise)
  const { container } = await boot(); await flush(2)
  transportCtl.respond(call => call.path.startsWith('/membership/plans') ? plansOk() : { ok: true, accounts: [account('fresh', { label: 'Fresh account' })] })
  await React.act(async () => { lib.__bumpActivationQuiet(); $testProfile.set('work') }); await flush(2)
  await React.act(async () => { lib.__bumpActivationQuiet(); $testProfile.set('default') }); await flush(3)
  await React.act(async () => { original.resolve({ ok: true, accounts: [account('obsolete', { label: 'Obsolete account' })] }); await new Promise(r => setTimeout(r, 0)) }); await flush(3)
  assert.match(container.textContent, /Fresh account/)
  assert.doesNotMatch(container.textContent, /Obsolete account/)
})


test('same-profile reactivation rejects an old reply while socket stays open', async () => {
  $testConnectionId.set('gateway-a'); $testProfile.set('default')
  const old = deferred()
  transportCtl.respond(call => call.path.startsWith('/membership/plans') ? plansOk() : old.promise)
  const { container } = await boot(); await flush(2)
  transportCtl.respond(call => call.path.startsWith('/membership/plans') ? plansOk() : { ok: true, accounts: [account('fresh', { label: 'Fresh reactivation' })] })
  await React.act(async () => { lib.__bumpActivationQuiet(); await new Promise(r => setTimeout(r, 350)) }); await flush(3)
  await React.act(async () => { old.resolve({ ok: true, accounts: [account('old', { label: 'Old activation' })] }); await new Promise(r => setTimeout(r, 0)) }); await flush(3)
  assert.match(container.textContent, /Fresh reactivation/)
  assert.doesNotMatch(container.textContent, /Old activation/)
})

test('a late initial read cannot overwrite a newer refresh in the same activation', async () => {
  $testConnectionId.set('gateway-a'); $testProfile.set('default')
  const old = deferred()
  transportCtl.respond(call => call.path.startsWith('/membership/plans') ? plansOk() : old.promise)
  const { container } = await boot(); await flush(2)
  transportCtl.respond(call => call.path.startsWith('/membership/plans') ? plansOk()
    : { ok: true, accounts: [account('new', { label: 'New reading' })] })
  await clickByText(container, 'Refresh provider usage'); await flush(3)
  await React.act(async () => { old.resolve({ ok: true, accounts: [account('old', { label: 'Old reading' })] }); await new Promise(r => setTimeout(r, 0)) }); await flush(3)
  assert.match(container.textContent, /New reading/)
  assert.doesNotMatch(container.textContent, /Old reading/)
})

test('Settings disclose catalogue provenance and Hermes-owned network refreshes without fetching automatically', async () => {
  queryClient.clear(); transportCtl.reset(); __hostRequests.length = 0
  transportCtl.respond(call => call.path === '/rates'
    ? { ok: true, catalogue: { source: 'bundled models.dev snapshot', as_of: '2025-01-01T00:00:00+00:00', age_seconds: 3600, stale: true } }
    : call.path === '/membership/plans'
      ? { ok: true, catalogue_version: '2026-10-30.5', generated_at: '2026-10-30T21:02:11Z',
          sources: [{ id: 'example', evidence_kind: 'price_page', url: 'https://example.test/prices', retrieved_at: null }],
          totals: { plans: 10, verified: 5, provisional: 1, placeholders: 4 } }
      : call.path === '/health' ? { ok: true, version: '0.5.0' }
        : { ok: true, profiles: [], loaded: true, error: '' })
  const container = document.createElement('div'); document.body.appendChild(container)
  const root = ReactDOMClient.createRoot(container); roots.push(root)
  await React.act(async () => root.render(React.createElement(QueryClientProvider, { client: queryClient }, React.createElement(T.SettingsPage))))
  await flush(3)
  assert.match(container.textContent, /bundled models.dev snapshot/)
  assert.match(container.textContent, /stale/)
  assert.match(container.textContent, /2026-10-30.5/)
  assert.match(container.textContent, /Refresh Hermes models/)
  assert.match(container.textContent, /SpendSense makes no direct HTTP pricing requests/)
  assert.match(container.textContent, /authenticated requests to configured provider endpoints using credentials it manages/)
  assert.match(container.textContent, /Automatic Hermes model-options refresh is off by default/)
  assert.equal(container.querySelector('input[type="checkbox"]')?.checked, false,
    'automatic model-options refresh defaults off in the rendered Settings page')
  assert.equal(transportCtl.calls.filter(c => c.path === '/rates').length, 1)
  assert.equal(transportCtl.calls.filter(c => c.path === '/membership/plans').length, 1)
  assert.equal(transportCtl.calls.some(c => c.path === '/membership/discover?native=true'), false)
  assert.equal(transportCtl.calls.some(c => c.path === '/membership/accounts?native=true'), false)
  assert.equal(__hostRequests.filter(c => c.method === 'model.options').length, 0,
    'opening Settings does not ask Hermes for model options')
})

test('model options stay offline unless automatic refresh is enabled or the user confirms a refresh', async () => {
  __hostRequests.length = 0
  T.$automaticModelOptions.set(false)
  const offline = T.catalogQuery('session-a', 'model-a', false)
  assert.throws(() => offline.queryFn(), /refresh is off/)
  assert.equal(__hostRequests.length, 0, 'the disabled query cannot call Hermes')

  const automatic = T.catalogQuery('session-a', 'model-a', true)
  await automatic.queryFn()
  assert.equal(__hostRequests.at(-1)?.method, 'model.options')
  T.$automaticModelOptions.set(false)

  queryClient.clear(); transportCtl.reset(); __hostRequests.length = 0
  const container = document.createElement('div'); document.body.appendChild(container)
  const root = ReactDOMClient.createRoot(container); roots.push(root)
  transportCtl.respond(call => call.path === '/rates'
    ? { ok: true, catalogue: { source: 'bundled', as_of: null, age_seconds: null, stale: false } }
    : call.path === '/membership/plans' ? { ok: true, catalogue_version: '2026-10-30.5', families: [], sources: [], totals: {} }
      : call.path === '/health' ? { ok: true, version: '0.5.0' }
        : { ok: true, profiles: [], loaded: true, error: '' })
  await React.act(async () => root.render(React.createElement(QueryClientProvider, { client: queryClient }, React.createElement(T.SettingsPage))))
  await flush(2)
  await clickByText(container, 'Refresh Hermes models')
  assert.equal(__hostRequests.length, 0, 'the first click only opens the provider-contact warning')
  assert.match(container.textContent, /authenticated requests to configured providers/)
  await clickByText(container, 'Confirm model refresh')
  await flush(2)
  assert.equal(__hostRequests.filter(c => c.method === 'model.options').length, 1,
    'a confirmed user action is the only explicit model-options request')
  assert.equal(__hostRequests.at(-1).params.refresh, true)
})

test('Settings remain usable when cached pricing status is unavailable', async () => {
  queryClient.clear()
  transportCtl.respond(call => call.path === '/rates' ? Promise.reject(new Error('offline'))
    : call.path === '/membership/plans' ? { ok: true, catalogue_version: '2026-10-30.5', families: [], sources: [], totals: {} }
      : call.path === '/health' ? { ok: true, version: '0.5.0' }
        : { ok: true, profiles: [], loaded: true, error: '' })
  const container = document.createElement('div'); document.body.appendChild(container)
  const root = ReactDOMClient.createRoot(container); roots.push(root)
  await React.act(async () => root.render(React.createElement(QueryClientProvider, { client: queryClient }, React.createElement(T.SettingsPage))))
  await flush(3)
  assert.match(container.textContent, /Pricing status is unavailable/)
  assert.match(container.textContent, /bundled offline snapshot can still be used/)
  assert.match(container.textContent, /2026-10-30.5/)
})

test('Costs renders Memberships as the sole recurring-fee source', async () => {
  queryClient.clear(); transportCtl.reset()
  $testConnectionId.set('gateway-a'); $testProfile.set('default')
  const commandcode = account('commandcode:default', {
    family: 'commandcode', label: 'CommandCode', plan_id: 'commandcode.goat',
    plan: { name: 'GOAT', notes: '', entitlements: { windows: [
      { id: 'monthly-credit', label: 'Monthly credit allocation', amount: 100, currency: 'USD' }
    ] } },
    fee: { basis: 'catalogue', effective: { amount: 10, currency: 'USD', period: 'month' } }
  })
  const codex = account('openai-codex:default', {
    family: 'openai-codex', label: 'ChatGPT Plus', plan_id: 'openai-codex.chatgpt-plus',
    plan: { name: 'ChatGPT Plus', entitlements: { windows: [] } },
    fee: { basis: 'catalogue', effective: { amount: 20, currency: 'USD', period: 'month' } }
  })
  transportCtl.respond(call => call.path === '/membership/accounts'
    ? { ok: true, accounts: [commandcode, codex], store: { loaded: true, error: '' }, notes: [] }
    : call.path === '/billing/summary'
      ? { ok: true, billing: { evidence: { api_equivalent: { usd: 2, basis: 'estimated', source: 'catalogue' } } } }
      : call.path === '/rates'
        ? { ok: true, catalogue: { source: 'bundled snapshot', as_of: '2026-10-30T12:00:00Z', age_seconds: 3600 } }
        : { ok: true })
  const container = document.createElement('div'); document.body.appendChild(container)
  const root = ReactDOMClient.createRoot(container); roots.push(root)
  await React.act(async () => root.render(React.createElement(QueryClientProvider, { client: queryClient }, React.createElement(T.CostsPage))))
  await flush(4)
  assert.match(container.textContent, /GOAT/)
  assert.match(container.textContent, /ChatGPT Plus/)
  assert.match(container.textContent, /\$30\.00\/mo/)
  assert.match(container.textContent, /Monthly credit allocation/)
  assert.equal(container.querySelectorAll('.wm-analytics').length, 1,
    'the page has one scroll container; the tab strip does not add a full-height nested container')
  assert.equal(container.querySelectorAll('.wm-product-tabs').length, 1)
  assert.equal(transportCtl.calls.some(call => call.path.startsWith('/billing/profiles')), false,
    'Costs does not create or require a duplicate subscription arrangement')
})

test('Costs explains pending membership data instead of showing an empty total', async () => {
  queryClient.clear(); transportCtl.reset()
  $testConnectionId.set('gateway-a'); $testProfile.set('default')
  const pendingAccounts = deferred()
  transportCtl.respond(call => call.path === '/membership/accounts' ? pendingAccounts.promise
    : call.path === '/billing/summary' ? { ok: true, billing: { evidence: {} } }
      : call.path === '/rates' ? { ok: true, catalogue: { source: 'bundled', as_of: null, age_seconds: null } }
        : { ok: true })
  const container = document.createElement('div'); document.body.appendChild(container)
  const root = ReactDOMClient.createRoot(container); roots.push(root)
  await React.act(async () => root.render(React.createElement(QueryClientProvider, { client: queryClient }, React.createElement(T.CostsPage))))
  await flush(2)
  const summary = container.querySelector('.wm-product-summary')
  assert.match(container.textContent, /Reading memberships for this connection/)
  assert.doesNotMatch(summary.textContent, /0 of 0|\$0\.00\/mo/)

  await React.act(async () => pendingAccounts.resolve({ ok: true, accounts: [], store: { loaded: true, error: '' }, notes: [] }))
  await flush(3)
  assert.match(container.textContent, /No saved memberships yet/)
})

test('a rule save refreshes dependents even when the draft moves mid-write', async () => {
  queryClient.clear(); transportCtl.reset()
  $testConnectionId.set('gateway-a'); $testProfile.set('default')
  const identity = T.membershipIdentityNow()
  T.$billingDraft.set(null)
  T.$billingNotice.set(null)
  queryClient.setQueryData([plugin.id, 'economics-summary', identity], { identity })
  queryClient.setQueryData([plugin.id, 'allowance-weather', identity], { identity })
  const draft = { id: 'cap', kind: 'api', provider: 'test', model: '', monthly_fee_usd: '',
    allowance_usd: '10', allowance_model: '', cycle_day: 1, overage_paid: false,
    rate_input: '', rate_output: '', rate_cache: '', label: '',
    effective_from: '', effective_to: '', origin: identity,
    original_allowance_model: '', original_scalar_allowance: '' }
  T.$billingDraft.set(draft)
  const releaseWrite = deferred()
  transportCtl.respond(call => {
    if (call.method === 'PUT' && call.path.startsWith('/billing/profiles/')) {
      // The user keeps editing while the write is pending.
      T.$billingDraft.set({ ...draft, allowance_usd: '20' })
      return releaseWrite.promise
    }
    return { ok: true, profiles: [] }
  })
  const container = document.createElement('div'); document.body.appendChild(container)
  const root = ReactDOMClient.createRoot(container); roots.push(root)
  await React.act(async () => root.render(React.createElement(QueryClientProvider, { client: queryClient },
    React.createElement(T.AdvancedBillingRules))))
  await flush(2)
  const form = container.querySelector('form.wm-custom-form')
  assert.ok(form, 'the edit form renders for the draft')
  await React.act(async () => {
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))
  })
  await flush(2)
  assert.equal(T.$billingDraft.get().allowance_usd, '20', 'the draft moved while the write was pending')
  await React.act(async () => { releaseWrite.resolve({ ok: true, profiles: [] }) })
  await flush(4)
  try {
    // The backend write landed, so both dependents refresh despite the moved draft.
    assert.equal(queryClient.getQueryState([plugin.id, 'economics-summary', identity])?.isInvalidated, true)
    assert.equal(queryClient.getQueryState([plugin.id, 'allowance-weather', identity])?.isInvalidated, true)
    // The draft check still protects UI state: no Saved notice, no cleared draft.
    assert.equal(T.$billingDraft.get().allowance_usd, '20')
    assert.equal(T.$billingNotice.get(), null)
  } finally {
    T.$billingDraft.set(null)
    T.$billingNotice.set(null)
  }
})

test('a rule save refreshes dependents even when the connection switches mid-write', async () => {
  queryClient.clear(); transportCtl.reset()
  $testConnectionId.set('gateway-a'); $testProfile.set('default')
  const identity = T.membershipIdentityNow()
  T.$billingDraft.set(null)
  T.$billingNotice.set(null)
  queryClient.setQueryData([plugin.id, 'economics-summary', identity], { identity })
  queryClient.setQueryData([plugin.id, 'allowance-weather', identity], { identity })
  const draft = { id: 'cap', kind: 'api', provider: 'test', model: '', monthly_fee_usd: '',
    allowance_usd: '10', allowance_model: '', cycle_day: 1, overage_paid: false,
    rate_input: '', rate_output: '', rate_cache: '', label: '',
    effective_from: '', effective_to: '', origin: identity,
    original_allowance_model: '', original_scalar_allowance: '' }
  T.$billingDraft.set(draft)
  const releaseWrite = deferred()
  transportCtl.respond(call => {
    if (call.method === 'PUT' && call.path.startsWith('/billing/profiles/')) {
      // The connection switches while the write is pending.
      $testConnectionId.set('gateway-b')
      return releaseWrite.promise
    }
    return { ok: true, profiles: [] }
  })
  const container = document.createElement('div'); document.body.appendChild(container)
  const root = ReactDOMClient.createRoot(container); roots.push(root)
  await React.act(async () => root.render(React.createElement(QueryClientProvider, { client: queryClient },
    React.createElement(T.AdvancedBillingRules))))
  await flush(2)
  const form = container.querySelector('form.wm-custom-form')
  assert.ok(form, 'the edit form renders for the draft')
  await React.act(async () => {
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))
  })
  await flush(2)
  await React.act(async () => { releaseWrite.resolve({ ok: true, profiles: [] }) })
  await flush(4)
  try {
    // The write landed for the captured identity, so its dependents refresh.
    assert.equal(queryClient.getQueryState([plugin.id, 'economics-summary', identity])?.isInvalidated, true)
    assert.equal(queryClient.getQueryState([plugin.id, 'allowance-weather', identity])?.isInvalidated, true)
    // The identity check still protects UI state on the new connection.
    assert.equal(T.$billingDraft.get().allowance_usd, '10')
    assert.equal(T.$billingNotice.get(), null)
  } finally {
    $testConnectionId.set('gateway-a')
    T.$billingDraft.set(null)
    T.$billingNotice.set(null)
  }
})

test('Overview renders its settled Desktop cost summary without a React render error', async () => {
  queryClient.clear(); transportCtl.reset()
  $testConnectionId.set('gateway-a'); $testProfile.set('default')
  const now = new Date()
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  T.$ledger.set({ ...T.emptyLedger(), days: { [`${month}-01`]: {
    bucket: { cost: 0.42, pricedTokens: 1200, legacy: false }
  } } })
  assert.deepEqual(T.settledDesktopMonth(T.emptyLedger()), { known: false, cost: 0, pricedTokens: 0, unpricedTokens: 0 })
  T.$ledgerTab.set('overview')
  const pendingAccounts = deferred()
  transportCtl.respond(call => call.path.startsWith('/analytics')
    ? { ok: true, totals: { list_usd: 0, calls: 0 } }
    : call.path === '/membership/accounts'
      ? pendingAccounts.promise
      : { ok: true })

  const container = document.createElement('div'); document.body.appendChild(container)
  const root = ReactDOMClient.createRoot(container); roots.push(root)
  await React.act(async () => root.render(React.createElement(QueryClientProvider, { client: queryClient },
    React.createElement(T.OverviewPage))))
  await flush(2)

  assert.match(container.textContent, /Overview/)
  assert.match(container.textContent, /Recorded usage · API-equivalent/)
  assert.match(container.querySelector('.wm-product-summary').textContent, /\$0\.42/)
  assert.match(container.textContent, /API-equivalent/)
  assert.match(container.textContent, /Actual provider charges/)
  assert.match(container.querySelector('[data-kpi="actual-charges"]').textContent, /Not recorded/)
  assert.match(container.textContent, /Saved account fees/)
  const summary = container.querySelector('.wm-product-summary')
  assert.equal(summary.querySelectorAll('.wm-kpi').length, 4)
  assert.match(summary.textContent, /Reading memberships for this connection/)
  assert.doesNotMatch(summary.textContent, /0 of 0 accounts/)
  assert.match(summary.textContent, /No backend calls recorded in the last 30 days/)

  const commandcode = account('commandcode:default', {
    family: 'commandcode', label: 'CommandCode', plan_id: 'commandcode.goat',
    plan: { name: 'GOAT' },
    fee: { basis: 'catalogue', effective: { amount: 10, currency: 'USD', period: 'month' } }
  })
  const codex = account('openai-codex:default', {
    family: 'openai-codex', label: 'ChatGPT Plus', plan_id: 'openai-codex.chatgpt-plus',
    plan: { name: 'ChatGPT Plus' },
    fee: { basis: 'catalogue', effective: { amount: 20, currency: 'USD', period: 'month' } }
  })
  await React.act(async () => pendingAccounts.resolve({ ok: true, accounts: [commandcode, codex],
    store: { loaded: true, error: '' }, notes: [] }))
  await flush(3)
  assert.match(summary.textContent, /\$30\.00\/mo/)
  assert.match(summary.textContent, /2 of 2 accounts have a confirmed plan/)
  // Fee-basis honesty: both effective fees are catalogue prices, so the card
  // shows a Catalogue chip and never claims they are declared.
  const chips = [...summary.querySelectorAll('.wm-certainty')].map(el => el.textContent)
  assert.ok(chips.includes('Catalogue'), `catalogue basis is labelled (${chips})`)
  assert.ok(!chips.includes('Declared'), `catalogue fees are not called declared (${chips})`)
  assert.match(container.textContent, /How these figures are calculated/)
  assert.ok(summary.classList.contains('wm-overview-grid'), 'the 2x2 grid is scoped to Overview')
  const method = container.querySelector('details.wm-method > summary')
  assert.ok(method, 'the methodology disclosure keeps native details/summary behaviour')
  assert.match(method.textContent, /How these figures are calculated/)
  await React.act(async () => T.$ledger.set(T.emptyLedger()))
})

test('Overview keeps subscription value out of the summary pending verified account and financial coverage', async () => {
  queryClient.clear(); transportCtl.reset()
  $testConnectionId.set('gateway-a'); $testProfile.set('default')
  T.$ledger.set(T.emptyLedger())
  T.$ledgerTab.set('overview')
  const economics = {
    ok: true, window_days: 30,
    headline: {
      status: 'partial', difference_usd: 8.4, usage_usd: 28.4,
      fees_monthly_by_currency: [{ currency: 'USD', amount: 20 }],
      fees_window_by_currency: [{ currency: 'USD', amount: 20 }],
      notes: ['Estimated value comparison; at least one input is partial.'],
    },
    accounts: [{ usage: { tokens: 100, priced_tokens: 100, unpriced_tokens: 0 } }],
  }
  transportCtl.respond(call => call.path.startsWith('/analytics')
    ? { ok: true, totals: { list_usd: 28.4, calls: 5, unpriced_tokens: 0 } }
    : call.path === '/economics/summary?days=30&trend_months=6' ? economics
    : call.path === '/membership/accounts'
      ? { ok: true, accounts: [], store: { loaded: true, error: '' }, notes: [] }
      : { ok: true })
  const container = document.createElement('div'); document.body.appendChild(container)
  const root = ReactDOMClient.createRoot(container); roots.push(root)
  await React.act(async () => root.render(React.createElement(QueryClientProvider, { client: queryClient },
    React.createElement(T.OverviewPage))))
  await flush(4)
  const cards = [...container.querySelectorAll('.wm-product-summary .wm-kpi')]
  assert.equal(cards.length, 4)
  assert.deepEqual(cards.map(card => card.dataset.kpi), [
    'recorded-usage', 'actual-charges', 'api-equivalent-estimate', 'saved-fees'
  ])
  assert.doesNotMatch(container.querySelector('.wm-product-summary').textContent, /\$8\.40|Subscription value/)
  assert.match(cards[2].textContent, /API-equivalent estimate/)
  assert.ok(transportCtl.calls.some(call => call.path === '/economics/summary?days=30&trend_months=6'),
    'Overview keeps the existing economics query warm for Costs')
})

test('Overview keeps provider charges not recorded because analytics has no per-call evidence', async () => {
  queryClient.clear(); transportCtl.reset()
  $testConnectionId.set('gateway-a'); $testProfile.set('default')
  T.$ledger.set(T.emptyLedger())
  T.$ledgerTab.set('overview')
  transportCtl.respond(call => call.path.startsWith('/analytics')
    ? { ok: true, totals: { list_usd: 47.9, calls: 2, unpriced_tokens: 0,
        billed_usd: 0.5, billed_complete: true, billing_mix: { actual: 1, included: 1 } } }
    : call.path === '/membership/accounts'
      ? { ok: true, accounts: [], store: { loaded: true, error: '' }, notes: [] }
      : { ok: true })
  const container = document.createElement('div'); document.body.appendChild(container)
  const root = ReactDOMClient.createRoot(container); roots.push(root)
  await React.act(async () => root.render(React.createElement(QueryClientProvider, { client: queryClient },
    React.createElement(T.OverviewPage))))
  await flush(4)
  const chargeCard = container.querySelector('[data-kpi="actual-charges"]')
  assert.match(chargeCard.textContent, /Not recorded/)
  assert.match(chargeCard.textContent, /analytics endpoint does not include per-call actual-charge evidence/i)
  assert.match(chargeCard.textContent, /Per-call evidence unavailable/)
  assert.doesNotMatch(chargeCard.textContent, /\$0\.50|1 of 2 records|evidence covers/i,
    'aggregate totals and billing classifications do not imply per-call charge evidence')
  assert.match(container.querySelector('[data-kpi="api-equivalent-estimate"]').textContent, /\$47\.90/)
})

test('Overview ranks backend model call counts without displaying per-model cost', async () => {
  queryClient.clear(); transportCtl.reset()
  $testConnectionId.set('gateway-a'); $testProfile.set('default')
  T.$ledger.set(T.emptyLedger())
  T.$ledgerTab.set('overview')
  transportCtl.respond(call => call.path.startsWith('/analytics')
    ? { ok: true, totals: { list_usd: 12, calls: 6, unpriced_tokens: 0,
        billed_usd: null, billed_complete: false, billing_mix: { actual: 1, estimated: 1, included: 0, unknown: 1 } },
        by_model: [
          { model: 'claude-opus-latest', provider: 'anthropic', calls: 2, list_usd: 10 },
          { model: 'gpt-codex', provider: 'openai-codex', calls: 4, list_usd: 1 },
          { model: 'unused', provider: 'other', calls: 0, list_usd: 900 },
        ] }
    : { ok: true, accounts: [], store: { loaded: true, error: '' }, notes: [] })
  const container = document.createElement('div'); document.body.appendChild(container)
  const root = ReactDOMClient.createRoot(container); roots.push(root)
  await React.act(async () => root.render(React.createElement(QueryClientProvider, { client: queryClient },
    React.createElement(T.OverviewPage))))
  await flush(4)
  const models = container.querySelector('.wm-overview-models')
  const rows = [...models.querySelectorAll('.wm-overview-model-row')]
  assert.deepEqual(rows.map(row => row.querySelector('strong').textContent), [
    'gpt-codex', 'claude-opus-latest'
  ])
  assert.match(models.textContent, /4 calls/)
  assert.match(models.textContent, /2 calls/)
  assert.doesNotMatch(models.textContent, /\$|10|900/, 'the ranking uses calls, not price values')
  assert.equal(transportCtl.count(call => call.path === '/analytics?days=30'), 1,
    'the panel reuses Overview analytics rather than adding a request')
  await clickByText(models, 'Open Usage')
  assert.equal(T.$ledgerTab.get(), 'usage')
})

test('Overview marks a partly priced Desktop month as a lower bound', async () => {
  assert.deepEqual(
    T.settledDesktopMonth({ days: { [`${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}-01`]: {
      session: { cost: 0.42, pricedTokens: 1200, unpricedTokens: 300 } } } }),
    { known: true, cost: 0.42, pricedTokens: 1200, unpricedTokens: 300 },
    'the month keeps its unpriced-token count')
  queryClient.clear(); transportCtl.reset()
  $testConnectionId.set('gateway-a'); $testProfile.set('default')
  T.$ledger.set({ ...T.emptyLedger(), days: { [`${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}-01`]: {
    session: { cost: 0.42, pricedTokens: 1200, unpricedTokens: 300 } } } })
  T.$ledgerTab.set('overview')
  transportCtl.respond(call => call.path.startsWith('/analytics')
    ? { ok: true, totals: { list_usd: 0, calls: 0, unpriced_tokens: 0 } }
    : { ok: true, accounts: [], store: { loaded: true, error: '' }, notes: [] })
  const container = document.createElement('div'); document.body.appendChild(container)
  const root = ReactDOMClient.createRoot(container); roots.push(root)
  await React.act(async () => root.render(React.createElement(QueryClientProvider, { client: queryClient },
    React.createElement(T.OverviewPage))))
  await flush(4)
  const recorded = container.querySelector('[data-kpi="recorded-usage"]').textContent
  assert.match(recorded, /\$0\.42/, 'the priced subtotal is shown')
  assert.match(recorded, /lower bound/, 'a partly priced month is a lower bound')
  assert.match(recorded, /Partial/, 'a partly priced month carries Partial')
  await React.act(async () => T.$ledger.set(T.emptyLedger()))
})

test('Overview fee heading describes billing periods, not a monthly conversion', async () => {
  queryClient.clear(); transportCtl.reset()
  $testConnectionId.set('gateway-a'); $testProfile.set('default')
  T.$ledger.set(T.emptyLedger())
  T.$ledgerTab.set('overview')
  const yearly = account('openai-codex:default', {
    family: 'openai-codex', label: 'ChatGPT', plan_id: 'openai-codex.chatgpt-plus',
    plan: { name: 'ChatGPT Plus' },
    fee: { basis: 'declared', effective: { amount: 120, currency: 'USD', period: 'year' } }
  })
  transportCtl.respond(call => call.path.startsWith('/analytics')
    ? { ok: true, totals: { list_usd: 0, calls: 0 } }
    : call.path === '/membership/accounts'
      ? { ok: true, accounts: [yearly], store: { loaded: true, error: '' }, notes: [] }
      : { ok: true })
  const container = document.createElement('div'); document.body.appendChild(container)
  const root = ReactDOMClient.createRoot(container); roots.push(root)
  await React.act(async () => root.render(React.createElement(QueryClientProvider, { client: queryClient },
    React.createElement(T.OverviewPage))))
  await flush(4)
  assert.doesNotMatch(container.textContent, /monthly equivalent/i, 'no conversion is claimed')
  assert.match(container.textContent, /by currency and billing period/i)
  assert.match(container.textContent, /\$120\.00\/yr/, 'the original period is preserved')
})

test('Overview distinguishes unknown subscription fees from having no recurring fees', async () => {
  queryClient.clear(); transportCtl.reset()
  $testConnectionId.set('gateway-a'); $testProfile.set('default')
  T.$ledger.set(T.emptyLedger())
  T.$ledgerTab.set('overview')
  const unpricedSub = account('nous:default', {
    family: 'nous', label: 'Nous', plan_id: 'nous.portal', plan: { name: 'Nous Portal' },
    effective_arrangement: 'subscription',
    fee: { basis: 'unpriced', effective: { amount: null } }
  })
  transportCtl.respond(call => call.path.startsWith('/analytics')
    ? { ok: true, totals: { list_usd: 0, calls: 0 } }
    : call.path === '/membership/accounts'
      ? { ok: true, accounts: [unpricedSub], store: { loaded: true, error: '' }, notes: [] }
      : { ok: true })
  const container = document.createElement('div'); document.body.appendChild(container)
  const root = ReactDOMClient.createRoot(container); roots.push(root)
  await React.act(async () => root.render(React.createElement(QueryClientProvider, { client: queryClient },
    React.createElement(T.OverviewPage))))
  await flush(4)
  const fees = container.querySelector('[data-kpi="saved-fees"]').textContent
  assert.match(fees, /Unknown/, 'an unknown subscription fee is Unknown, not a dash')
  assert.match(fees, /1 account\(s\) have no known fee/, 'the subtotal discloses the missing fee')

  // Genuinely fee-free accounts are a different state, not Unknown.
  queryClient.clear()
  const metered = account('openrouter:default', {
    family: 'openrouter', label: 'OpenRouter', effective_arrangement: 'api_only' })
  transportCtl.respond(call => call.path.startsWith('/analytics')
    ? { ok: true, totals: { list_usd: 0, calls: 0 } }
    : call.path === '/membership/accounts'
      ? { ok: true, accounts: [metered], store: { loaded: true, error: '' }, notes: [] }
      : { ok: true })
  const container2 = document.createElement('div'); document.body.appendChild(container2)
  const root2 = ReactDOMClient.createRoot(container2); roots.push(root2)
  await React.act(async () => root2.render(React.createElement(QueryClientProvider, { client: queryClient },
    React.createElement(T.OverviewPage))))
  await flush(4)
  const fees2 = container2.querySelector('[data-kpi="saved-fees"]').textContent
  assert.match(fees2, /No saved recurring fees/)
  assert.doesNotMatch(fees2, /no known fee/)
  const chips2 = [...container2.querySelector('[data-kpi="saved-fees"]')
    .querySelectorAll('.wm-certainty')].map(el => el.textContent)
  assert.ok(!chips2.includes('Unknown'), `a fee-free state carries no Unknown chip (${chips2})`)
})

test('Overview shows a known fee subtotal as Partial when some fees are unknown', async () => {
  queryClient.clear(); transportCtl.reset()
  $testConnectionId.set('gateway-a'); $testProfile.set('default')
  T.$ledger.set(T.emptyLedger())
  T.$ledgerTab.set('overview')
  const declared = account('openai-codex:default', {
    family: 'openai-codex', label: 'ChatGPT Plus', plan_id: 'openai-codex.chatgpt-plus',
    plan: { name: 'ChatGPT Plus' }, effective_arrangement: 'subscription',
    fee: { basis: 'declared', effective: { amount: 20, currency: 'USD', period: 'month' } }
  })
  const unpricedSub = account('nous:default', {
    family: 'nous', label: 'Nous', plan_id: 'nous.portal', plan: { name: 'Nous Portal' },
    effective_arrangement: 'subscription',
    fee: { basis: 'unpriced', effective: { amount: null } }
  })
  transportCtl.respond(call => call.path.startsWith('/analytics')
    ? { ok: true, totals: { list_usd: 0, calls: 0 } }
    : call.path === '/membership/accounts'
      ? { ok: true, accounts: [declared, unpricedSub], store: { loaded: true, error: '' }, notes: [] }
      : { ok: true })
  const container = document.createElement('div'); document.body.appendChild(container)
  const root = ReactDOMClient.createRoot(container); roots.push(root)
  await React.act(async () => root.render(React.createElement(QueryClientProvider, { client: queryClient },
    React.createElement(T.OverviewPage))))
  await flush(4)
  const card = container.querySelector('[data-kpi="saved-fees"]')
  assert.match(card.textContent, /\$20\.00\/mo/, 'the known subtotal keeps its amount, currency and period')
  assert.match(card.textContent, /Partial/, 'an unknown subscription marks the subtotal Partial')
  assert.match(card.textContent, /1 account\(s\) have no known fee/, 'the missing fee is disclosed')
})

test('Overview never treats an unconfirmed or plan-less account as a zero fee', async () => {
  queryClient.clear(); transportCtl.reset()
  $testConnectionId.set('gateway-a'); $testProfile.set('default')
  T.$ledger.set(T.emptyLedger())
  T.$ledgerTab.set('overview')
  const unconfirmed = account('xai:default', {
    family: 'xai', label: 'xAI', effective_arrangement: 'unconfirmed' })
  const noPlan = account('custom:default', {
    family: 'custom', label: 'Custom', effective_arrangement: 'subscription' })
  transportCtl.respond(call => call.path.startsWith('/analytics')
    ? { ok: true, totals: { list_usd: 0, calls: 0 } }
    : call.path === '/membership/accounts'
      ? { ok: true, accounts: [unconfirmed, noPlan], store: { loaded: true, error: '' }, notes: [] }
      : { ok: true })
  const container = document.createElement('div'); document.body.appendChild(container)
  const root = ReactDOMClient.createRoot(container); roots.push(root)
  await React.act(async () => root.render(React.createElement(QueryClientProvider, { client: queryClient },
    React.createElement(T.OverviewPage))))
  await flush(4)
  const fees = container.querySelector('[data-kpi="saved-fees"]').textContent
  assert.match(fees, /Unknown/, 'unconfirmed and plan-less accounts are Unknown, not zero')
  assert.doesNotMatch(fees, /No recurring fees/)
  assert.match(fees, /2 account\(s\) have no known fee/)
})

test('Overview attention includes stored allowance weather without provider reads', async () => {
  queryClient.clear(); transportCtl.reset()
  $testConnectionId.set('gateway-a'); $testProfile.set('default')
  T.$ledger.set(T.emptyLedger())
  T.$ledgerTab.set('overview')
  const sub = account('openai-codex:default', {
    family: 'openai-codex', label: 'ChatGPT Plus', plan_id: 'openai-codex.chatgpt-plus',
    plan: { name: 'ChatGPT Plus' }, effective_arrangement: 'subscription',
    fee: { basis: 'declared', effective: { amount: 20, currency: 'USD', period: 'month' } }
  })
  transportCtl.respond(call => {
    if (call.path.startsWith('/analytics')) return { ok: true, totals: { list_usd: 0, calls: 0 } }
    if (call.path === '/membership/accounts') {
      return { ok: true, accounts: [sub], store: { loaded: true, error: '' }, notes: [] }
    }
    if (call.path === '/allowance/weather') {
      return { ok: true, accounts: [{ account_id: 'openai-codex:default',
        windows: [{ label: 'Weekly pool', verdict: 'ahead' }], rules: [] }] }
    }
    return { ok: true }
  })
  const container = document.createElement('div'); document.body.appendChild(container)
  const root = ReactDOMClient.createRoot(container); roots.push(root)
  await React.act(async () => root.render(React.createElement(QueryClientProvider, { client: queryClient },
    React.createElement(T.OverviewPage))))
  await flush(4)
  assert.match(container.textContent, /Weekly pool: ahead of pace\./)
  assert.equal(transportCtl.count(call => call.path.includes('native')), 0, 'no native provider read')
  assert.ok(transportCtl.count(call => call.path === '/allowance/weather') >= 1, 'stored weather is read')
})

test('Overview labels retained weather verdicts as stale after a failed refresh', async () => {
  queryClient.clear(); transportCtl.reset()
  $testConnectionId.set('gateway-a'); $testProfile.set('default')
  T.$ledger.set(T.emptyLedger())
  T.$ledgerTab.set('overview')
  const sub = account('openai-codex:default', {
    family: 'openai-codex', label: 'ChatGPT Plus', plan_id: 'openai-codex.chatgpt-plus',
    plan: { name: 'ChatGPT Plus' }, effective_arrangement: 'subscription',
    fee: { basis: 'declared', effective: { amount: 20, currency: 'USD', period: 'month' } }
  })
  const weatherOk = { ok: true, accounts: [{ account_id: 'openai-codex:default',
    windows: [{ label: 'Weekly pool', verdict: 'ahead' }], rules: [] }] }
  let failWeather = false
  transportCtl.respond(call => {
    if (call.path.startsWith('/analytics')) return { ok: true, totals: { list_usd: 0, calls: 0 } }
    if (call.path === '/membership/accounts') {
      return { ok: true, accounts: [sub], store: { loaded: true, error: '' }, notes: [] }
    }
    if (call.path === '/allowance/weather') {
      if (failWeather) throw new Error('boom')
      return weatherOk
    }
    return { ok: true }
  })
  const container = document.createElement('div'); document.body.appendChild(container)
  const root = ReactDOMClient.createRoot(container); roots.push(root)
  await React.act(async () => root.render(React.createElement(QueryClientProvider, { client: queryClient },
    React.createElement(T.OverviewPage))))
  await flush(4)
  assert.match(container.textContent, /Weekly pool: ahead of pace\./)
  assert.doesNotMatch(container.textContent, /may be stale/)

  failWeather = true
  await React.act(async () => {
    await queryClient.invalidateQueries({ predicate: q => q.queryKey[1] === 'allowance-weather' })
  })
  await flush(4)
  assert.match(container.textContent, /Weekly pool: ahead of pace\./, 'the retained verdict stays visible')
  const stale = container.querySelector('#wm-needs-attention [role="status"]')
  assert.ok(stale, 'a stale-reading warning is shown')
  assert.match(stale.textContent, /may be stale/)
})

test('Overview attention rows route to Memberships and Usage', async () => {
  queryClient.clear(); transportCtl.reset()
  $testConnectionId.set('gateway-a'); $testProfile.set('default')
  T.$ledger.set(T.emptyLedger())
  T.$ledgerTab.set('overview')
  const xai = account('xai:default', { family: 'xai', label: 'xAI', effective_arrangement: 'unconfirmed' })
  const codex = account('openai-codex:default', {
    family: 'openai-codex', label: 'ChatGPT Plus', plan_id: 'openai-codex.chatgpt-plus',
    plan: { name: 'ChatGPT Plus' },
    fee: { basis: 'declared', effective: { amount: 20, currency: 'USD', period: 'month' } }
  })
  transportCtl.respond(call => call.path.startsWith('/analytics')
    ? { ok: true, totals: { list_usd: 47.9, calls: 5, unpriced_tokens: 18240 } }
    : call.path === '/membership/accounts'
      ? { ok: true, accounts: [xai, codex], store: { loaded: true, error: '' }, notes: [] }
      : { ok: true })
  const container = document.createElement('div'); document.body.appendChild(container)
  const root = ReactDOMClient.createRoot(container); roots.push(root)
  await React.act(async () => root.render(React.createElement(QueryClientProvider, { client: queryClient },
    React.createElement(T.OverviewPage))))
  await flush(4)

  const summary = container.querySelector('.wm-product-summary')
  assert.match(summary.textContent, /Unknown/, 'no priced Desktop cost renders Unknown, not a zero')
  assert.match(summary.textContent, /lower bound/, 'unpriced tokens make the total a lower bound')
  const chips = [...summary.querySelectorAll('.wm-certainty')].map(el => el.textContent)
  assert.ok(chips.includes('Partial'), `partial certainty is labelled (${chips})`)
  assert.ok(chips.includes('Declared'), `the declared fee keeps its own chip (${chips})`)
  assert.ok(!chips.includes('Catalogue'), `no catalogue fee means no catalogue chip (${chips})`)

  assert.match(container.querySelector('.wm-attn-strip').textContent, /2 need attention/)
  const rows = [...container.querySelectorAll('.wm-attention-rows li')]
  assert.equal(rows.length, 2)
  assert.match(rows[0].textContent, /xAI/)
  await clickByText(rows[0], 'Confirm arrangement')
  assert.equal(T.$ledgerTab.get(), 'memberships')
  const queued = T.$membershipTarget.get()
  assert.ok(queued, 'the attention action queues a navigation target')
  assert.equal(queued.accountId, 'xai:default')
  assert.equal(queued.issue, 'unconfirmed')
  assert.equal(queued.focus, 'arrangement')
  T.$ledgerTab.set('overview'); await flush(3)
  assert.match(rows[1].textContent, /Usage pricing/)
  await clickByText(rows[1], 'Open Usage')
  assert.equal(T.$ledgerTab.get(), 'usage')
  T.$membershipTarget.set(null)
})

test('the membership card saves a user-defined plan against its selected credential account', async () => {
  queryClient.clear(); transportCtl.reset()
  $testConnectionId.set('gateway-a'); $testProfile.set('default')
  const id = 'openai-codex:work'
  let saved = account(id, { label: 'Work account' })
  transportCtl.respond(call => {
    if (call.path === '/membership/plans') return plansOk()
    if (call.method === 'GET') return { ok: true, accounts: [saved], store: { loaded: true, error: '' }, notes: [] }
    if (call.method === 'PUT') {
      saved = call.body
      return { ok: true, account: saved }
    }
    return { ok: true }
  })
  const { container } = await boot(); await flush(3)
  await clickByText(container, 'Create user-defined plan')
  const form = container.querySelector('.wm-custom-form')
  assert.ok(form)
  await setField(container, 'Plan name', 'Workday plan', form)
  await setField(container, 'Fee (optional)', '12.50', form)
  await setField(container, 'Currency', 'USD', form)
  await setField(container, 'Billing frequency', 'month', form)
  await setField(container, 'Model restrictions', 'provider/model-a, provider/model-b', form)
  await clickByText(form, 'Add allowance')
  const allowance = form.querySelector('[data-custom-allowance="1"]')
  assert.ok(allowance, 'the optional allowance editor is attached to this account form')
  await setField(container, 'Window name', 'Five-hour window', allowance)
  await setField(container, 'Rolling duration', '300', allowance)
  await setField(container, 'Credit amount', '50', allowance)
  await clickByText(form, 'Save user-defined plan')
  await flush(4)
  const write = transportCtl.calls.find(call => call.method === 'PUT')
  assert.ok(write, 'saving the form sends an account update')
  assert.equal(write.path, `/membership/accounts/${encodeURIComponent(id)}`)
  assert.equal(write.body.plan_id, `custom:${id}`)
  assert.equal(write.body.custom_plan.name, 'Workday plan')
  assert.deepEqual(write.body.custom_plan.price, { amount: 12.5, currency: 'USD', period: 'month' })
  assert.deepEqual(write.body.custom_plan.model_restrictions, ['provider/model-a', 'provider/model-b'])
  assert.deepEqual(write.body.custom_plan.allowances, [{ id: 'five-hour-window', label: 'Five-hour window',
    kind: 'rolling', duration_minutes: 300, amount: 50, currency: 'USD', scope: 'account' }])
  assert.match(container.textContent, /Edit user-defined plan/)
})

test('Restore catalogue price closes the fee revision instead of saving zero', async () => {
  queryClient.clear(); transportCtl.reset()
  $testConnectionId.set('gateway-a'); $testProfile.set('default')
  const original = account('openai-codex:default', {
    label: 'Default account', plan_id: 'openai-codex.chatgpt-plus',
    fee: { basis: 'declared', published: { source: 'catalogue', amount: 20, currency: 'USD', period: 'month' },
      override: { revision_id: 'fee-active', amount: 17, currency: 'USD', period: 'month' } },
    fee_overrides: [{ id: 'fee-active', amount: 17, currency: 'USD', period: 'month', effective_from: '2026-09-01T00:00:00Z' }]
  })
  transportCtl.respond(call => call.path === '/membership/plans' ? plansOk()
    : call.method === 'GET' ? { ok: true, accounts: [original], store: { loaded: true, error: '' }, notes: [] }
      : { ok: true })
  const { container } = await boot(); await flush(3)
  await clickByText(container, 'Restore catalogue price')
  await flush(3)
  const write = transportCtl.calls.find(call => call.method === 'PUT')
  assert.ok(write)
  const override = write.body.fee_overrides.find(item => item.id === 'fee-active')
  assert.ok(override.effective_to)
  assert.ok(Number.isFinite(Date.parse(override.effective_to)))
  assert.equal(write.body.fee_overrides.some(item => item.amount === 0), false)
})

test('every tab keeps the shared tab bar as a direct child of the page root', async () => {
  queryClient.clear(); transportCtl.reset()
  $testConnectionId.set('gateway-a'); $testProfile.set('default')
  T.$digestDays.set(30)
  // Membership reads succeed with an empty list; everything else fails, so
  // each page renders its error state — the tab bar must still sit outside
  // the content shell in exactly the same place on all seven tabs.
  transportCtl.respond(call => call.path === '/membership/accounts'
    ? { ok: true, accounts: [], store: { loaded: true, error: '' }, notes: [] }
    : call.path === '/membership/plans' ? plansOk()
    : call.path === '/allowance/weather' ? { ok: true, accounts: [] }
    : Promise.reject(new Error('backend down')))
  const pages = [
    ['overview', T.OverviewPage, {}],
    ['usage', T.AnalyticsPage, { productPage: true }],
    ['costs', T.CostsPage, {}],
    ['memberships', T.MembershipsPage, {}],
    ['reports', T.ReportsPage, {}],
    ['news', T.NewsPage, {}],
    ['settings', T.SettingsPage, {}],
  ]
  for (const [tab, Component, props] of pages) {
    queryClient.clear()
    T.$ledgerTab.set(tab)
    T.$membershipSnapshot.set(null); T.$membershipNotice.set(null); T.$membershipBusy.set(null)
    const container = document.createElement('div'); document.body.appendChild(container)
    const root = ReactDOMClient.createRoot(container); roots.push(root)
    await React.act(async () => {
      root.render(React.createElement(QueryClientProvider, { client: queryClient },
        React.createElement(Component, props)))
    })
    await flush(4)
    assert.equal(container.querySelectorAll('[role="tab"]').length, 7, `${tab} shows all seven tabs`)
    const pageRoot = container.firstElementChild
    const tablist = container.querySelector('[role="tablist"]')
    assert.ok(tablist, `${tab} renders the tab bar`)
    const contentShell = [...pageRoot.children].find(child => child.classList.contains('wm-shell'))
    assert.ok(tablist.parentElement === pageRoot && contentShell?.parentElement === pageRoot
      && [...pageRoot.children].indexOf(tablist) < [...pageRoot.children].indexOf(contentShell),
    `${tab} keeps navigation before the content shell at the product root`)
    assert.ok([...container.querySelectorAll('.wm-shell')].every(shell => !shell.contains(tablist)),
      `${tab} never nests the tab bar inside a content shell`)
    await React.act(async () => { root.unmount() })
    roots.pop()
    container.remove()
  }
})

test('the sidebar usage view intentionally has no tab bar', async () => {
  queryClient.clear(); transportCtl.reset()
  $testConnectionId.set('gateway-a'); $testProfile.set('default')
  transportCtl.respond(() => Promise.reject(new Error('backend down')))
  const container = document.createElement('div'); document.body.appendChild(container)
  const root = ReactDOMClient.createRoot(container); roots.push(root)
  await React.act(async () => {
    root.render(React.createElement(QueryClientProvider, { client: queryClient },
      React.createElement(T.AnalyticsPage, {})))
  })
  await flush(4)
  assert.equal(container.querySelector('[role="tablist"]'), null,
    'sidebar mode renders no tab bar by design')
})

test('selecting Metered API sends the card revision and confirms the save', async () => {
  queryClient.clear(); transportCtl.reset()
  $testConnectionId.set('gateway-a'); $testProfile.set('default')
  const current = account('anthropic:default', { label: 'UAT anthropic', api_only: false })
  transportCtl.respond(call => call.path.startsWith('/membership/plans') ? plansOk()
    : call.path.startsWith('/allowance/weather') ? { ok: true, accounts: [] }
    : call.method === 'PUT'
      ? { ok: true, account: { ...call.body, rev: 'r2' }, accounts: [{ ...call.body, rev: 'r2' }] }
      : { ok: true, accounts: [current], store: { loaded: true, error: '' }, notes: [] })
  const { container, text } = await boot()
  await flush(4)
  const seg = container.querySelector('[data-nav="arrangement"]')
  assert.ok(seg, 'the billing arrangement is a segmented control')
  assert.equal(seg.getAttribute('role'), 'group')
  const buttons = [...seg.querySelectorAll('button')]
  assert.deepEqual(buttons.map(b => b.textContent),
    ['Subscription', 'Prepaid credits', 'Metered API', 'No current plan',
      'Included via another subscription', 'Not confirmed'])
  await React.act(async () => { buttons.find(b => b.textContent === 'Metered API').click() })
  await flush(6)
  const write = transportCtl.calls.find(call => call.method === 'PUT')
  assert.ok(write, 'selecting sends a PUT')
  assert.deepEqual(write.body, {
    arrangement: 'api_only', owner_account_id: null, rev: 'r1', route_rev: 'route-r1',
  })
  assert.equal(write.body.rev, 'r1', 'the PUT carries the revision served by GET')
  assert.match(text(), /Saved\./, 'a successful edit shows clear feedback')
})

test('a record without a revision refuses the write with an honest message', async () => {
  queryClient.clear(); transportCtl.reset()
  $testConnectionId.set('gateway-a'); $testProfile.set('default')
  const bare = account('legacy:default', { label: 'Legacy account' })
  delete bare.rev
  transportCtl.respond(call => call.path.startsWith('/membership/plans') ? plansOk()
    : call.path.startsWith('/allowance/weather') ? { ok: true, accounts: [] }
    : { ok: true, accounts: [bare], store: { loaded: true, error: '' }, notes: [] })
  const { container, text } = await boot()
  await flush(4)
  const seg = container.querySelector('[data-nav="arrangement"]')
  assert.ok(seg, 'the card renders even without a revision')
  await React.act(async () => {
    [...seg.querySelectorAll('button')].find(b => b.textContent === 'Metered API').click()
  })
  await flush(3)
  assert.equal(transportCtl.calls.some(call => call.method === 'PUT'), false,
    'no doomed PUT is sent for an unversioned record')
  assert.match(text(), /has no revision/, 'the notice names the real problem, not a reload loop')
  // The guard is an opener-allowlist, so a different write kind is refused too.
  await React.act(async () => {
    [...seg.querySelectorAll('button')].find(b => b.textContent === 'Prepaid credits').click()
  })
  await flush(3)
  assert.equal(transportCtl.calls.some(call => call.method === 'PUT'), false,
    'a second arrangement choice is refused without a revision')
  await clickByText(container, 'Create user-defined plan')
  await flush(2)
  assert.equal(container.querySelector('form.wm-custom-form').noValidate, true,
    'the custom-plan form skips native validation without a revision too')
})

test('versioned accounts keep native form validation', async () => {
  queryClient.clear(); transportCtl.reset()
  $testConnectionId.set('gateway-a'); $testProfile.set('default')
  transportCtl.respond(call => call.path.startsWith('/membership/plans') ? plansOk()
    : call.path.startsWith('/allowance/weather') ? { ok: true, accounts: [] }
    : { ok: true, accounts: [account('pro:default', { label: 'Pro account' })],
        store: { loaded: true, error: '' }, notes: [] })
  const { container } = await boot()
  await flush(4)
  await clickByText(container, 'Edit fee')
  await flush(2)
  await clickByText(container, 'Create user-defined plan')
  await flush(2)
  assert.equal(container.querySelector('form.wm-fee-form').noValidate, false,
    'the fee form keeps native validation with a revision')
  assert.equal(container.querySelector('form.wm-custom-form').noValidate, false,
    'the custom-plan form keeps native validation with a revision')
})

test('a fee save on a record without a revision is refused before any write', async () => {
  queryClient.clear(); transportCtl.reset()
  $testConnectionId.set('gateway-a'); $testProfile.set('default')
  const bare = account('legacy:default', { label: 'Legacy account' })
  delete bare.rev
  transportCtl.respond(call => call.path.startsWith('/membership/plans') ? plansOk()
    : call.path.startsWith('/allowance/weather') ? { ok: true, accounts: [] }
    : { ok: true, accounts: [bare], store: { loaded: true, error: '' }, notes: [] })
  const { container, text } = await boot()
  await flush(4)
  await clickByText(container, 'Edit fee')
  await flush(2)
  // Submit untouched: the empty amount is invalid, so reaching validation
  // would report that instead. The revision refusal must come first.
  await clickByText(container, 'Save fee')
  await flush(3)
  assert.equal(transportCtl.calls.some(call => call.method === 'PUT'), false,
    'the fee save is refused before any write')
  assert.match(text(), /has no revision/)
  assert.doesNotMatch(text(), /Enter an amount/,
    'the refusal names the revision, not the unfilled form')
  // The warning is account-scoped, so it appears beside the affected fee
  // form as well as in the page-level notice.
  const inline = container.querySelector('form.wm-fee-form p[role="alert"]')
  assert.ok(inline, 'the fee form shows the revision warning inline')
  assert.match(inline.textContent, /has no revision/)
  const pageAlert = [...container.querySelectorAll('div.wm-alert')]
    .find(alert => /has no revision/.test(alert.textContent || ''))
  assert.ok(pageAlert, 'the page-level notice is kept')
  assert.equal(container.querySelector('form.wm-fee-form').noValidate, true,
    'native validation is off so the revision check runs instead of field bubbles')
})

test('PR-C: account rows are compact, collapsed by default, and expand on Details', async () => {
  queryClient.clear(); transportCtl.reset()
  $testConnectionId.set('gateway-a'); $testProfile.set('default')
  T.$membershipExpanded.set({ origin: null, ids: [] })
  T.$ledgerTab.set('memberships')
  const sub = account('anthropic:default', {
    family: 'anthropic', label: 'main', plan_id: 'anthropic.claude-pro',
    plan: { name: 'Claude Pro' }, effective_arrangement: 'subscription',
    fee: { basis: 'declared', effective: { amount: 45, currency: 'GBP', period: 'month' } }
  })
  transportCtl.respond(call => call.path === '/membership/accounts'
    ? { ok: true, accounts: [sub], store: { loaded: true, error: '' }, notes: [] }
    : { ok: true })
  const { container } = await boot()
  await flush(4)
  const card = container.querySelector('[data-account="anthropic:default"]')
  const head = card.querySelector('.wm-row-head')
  assert.ok(head, 'the card renders a compact row head')
  assert.match(head.textContent, /Anthropic · main/)
  assert.match(head.textContent, /Subscription · Claude Pro/)
  assert.match(head.textContent, /£45\.00\/mo/)
  assert.match(head.textContent, /Effective fee/)
  assert.match(head.textContent, /Allowance reading/)
  assert.equal(card.querySelector('.wm-row-mid [data-state="unreported"]')?.textContent, 'Unreported',
    'an account without allowance readings is labelled explicitly')
  const details = [...head.querySelectorAll('button')].find(b => /Details/.test(b.textContent))
  assert.equal(details.getAttribute('aria-expanded'), 'false', 'rows start collapsed')
  assert.equal(details.getAttribute('aria-controls'), card.querySelector('.wm-row-body').id,
    'the disclosure button names the body it controls')
  assert.equal(card.querySelector('.wm-row-body').hidden, true)
  const summary = container.querySelector('dl.wm-membership-summary')
  assert.ok(summary, 'headline figures render in a compact semantic summary strip')
  assert.equal(summary.getAttribute('aria-busy'), 'false', 'the loaded summary is not announced as busy')
  assert.match(summary.textContent, /Needs attention/)
  assert.match(summary.textContent, /£45\.00\/mo/)
  const refreshNote = container.querySelector('.wm-membership-refresh-note')
  assert.match(refreshNote.textContent, /where supported/)
  assert.match(refreshNote.textContent, /never changes saved plans, fees or marks/)
  const feeNote = container.querySelector('.wm-membership-fee-note')
  assert.match(feeNote.textContent, /currency and period/)
  assert.doesNotMatch(feeNote.textContent, /Allowance percentages/,
    'the concise note leaves extended methodology below the fold')
  const feeHelp = container.querySelector('details.wm-membership-explainer')
  assert.equal(feeHelp.open, false, 'extended fee and allowance caveats are available in a collapsed disclosure')
  assert.match(feeHelp.querySelector('summary').textContent, /About fees and allowance readings/)
  assert.match(feeHelp.querySelector('p').textContent, /Allowance percentages are limits, not fees/)
  // Detail groups exist in the DOM with their controls, collapsed.
  const groups = [...card.querySelectorAll('.wm-group')]
  assert.deepEqual(groups.map(g => g.querySelector('summary').textContent),
    ['Plan & billing', 'Allowances & readings', 'Advanced & diagnostics'])
  assert.ok(card.querySelector('[data-group="plan"] [data-nav="arrangement"]'), 'plan group keeps the billing arrangement control')
  assert.ok(card.querySelector('[data-group="advanced"]'), 'advanced group exists')
  assert.match(card.querySelector('[data-group="advanced"]').textContent, /Account ID: anthropic:default/)
  await React.act(async () => { details.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  await flush(2)
  assert.equal(details.getAttribute('aria-expanded'), 'true')
  assert.equal(card.querySelector('.wm-row-body').hidden, false)
})

test('PR-C: attention summary counts accounts and separates its filter from account jumps', async () => {
  queryClient.clear(); transportCtl.reset()
  $testConnectionId.set('gateway-a'); $testProfile.set('default')
  T.$membershipAttentionOnly.set(false)
  T.$membershipExpanded.set({ origin: null, ids: [] })
  T.$ledgerTab.set('memberships')
  const needsMultipleItems = account('anthropic:work', {
    family: 'anthropic', label: 'Work', billing_arrangement: 'subscription',
    effective_arrangement: 'subscription', quota: { account_exhausted: true, conflicts: [], windows: [] }
  })
  const metered = account('openai-codex:personal', {
    family: 'openai-codex', label: 'Personal', effective_arrangement: 'api_only',
    fee: { basis: 'api_only', effective: { amount: null } }
  })
  assert.equal(T.needsAttention([needsMultipleItems], new Map()).length, 2,
    'the fixture has two reasons for one account')
  transportCtl.respond(call => call.path === '/membership/accounts'
    ? { ok: true, accounts: [needsMultipleItems, metered], store: { loaded: true, error: '' }, notes: [] }
    : { ok: true })
  const { container } = await boot()
  await flush(4)
  const summary = container.querySelector('.wm-membership-summary')
  assert.equal(summary.querySelectorAll('dd')[2].textContent, '1',
    'the headline count matches the attention filter count of distinct accounts')
  const attentionSection = [...container.querySelectorAll('.wm-attention')]
    .find(el => el.getAttribute('aria-label') === 'Needs attention')
  assert.equal(attentionSection.querySelectorAll('li').length, 2,
    'individual attention reasons remain available in the details list')
  const nav = container.querySelector('nav.wm-membership-account-nav')
  assert.equal(nav.getAttribute('aria-label'), 'Account navigation')
  const filterGroup = nav.querySelector('[role="group"][aria-label="Filter accounts by attention"]')
  const filter = filterGroup.querySelector('button')
  assert.match(filter.textContent, /Needs attention only \(1\)/)
  assert.ok(filter.classList.contains('wm-button'), 'the filter has button styling distinct from jump chips')
  assert.equal(filter.classList.contains('wm-account-chip'), false)
  const shortcuts = nav.querySelector('[role="group"][aria-label="Jump to an account"]')
  assert.match(shortcuts.querySelector('.wm-account-nav-label').textContent, /Jump to an account/)
  assert.deepEqual([...shortcuts.querySelectorAll('.wm-account-chip')].map(button => button.textContent),
    ['Work · check', 'Personal'])
})

test('PR-C: plan-less API-only and prepaid rows show No plan, not the confirm prompt', async () => {
  queryClient.clear(); transportCtl.reset()
  $testConnectionId.set('gateway-a'); $testProfile.set('default')
  T.$membershipExpanded.set({ origin: null, ids: [] })
  T.$ledgerTab.set('memberships')
  const api = account('deepseek:default', {
    family: 'deepseek', label: 'main', plan_id: null, effective_arrangement: 'api_only',
    fee: { basis: 'api_only', effective: { amount: null } }
  })
  const prepaid = account('openai:default', {
    family: 'openai', label: 'main', plan_id: null, effective_arrangement: 'prepaid',
    fee: { basis: 'prepaid', effective: { amount: null } }
  })
  const sub = account('openai-codex:default', {
    family: 'openai-codex', label: 'main', plan_id: null, effective_arrangement: 'subscription',
    fee: { basis: 'no_plan', effective: { amount: null } }
  })
  transportCtl.respond(call => call.path === '/membership/accounts'
    ? { ok: true, accounts: [api, prepaid, sub], store: { loaded: true, error: '' }, notes: [] }
    : { ok: true })
  const { container } = await boot()
  await flush(4)
  const head = id => container.querySelector(`[data-account="${id}"] .wm-row-head`).textContent
  assert.match(head('deepseek:default'), /Metered API · No plan/,
    'a plan-less metered row does not ask for plan confirmation')
  assert.match(head('openai:default'), /Prepaid credits · No plan/,
    'a plan-less prepaid row does not ask for plan confirmation')
  assert.match(head('openai-codex:default'), /Subscription · No plan confirmed yet\./,
    'a plan-less subscription row keeps the confirm prompt')
})

test('PR-C: row order is stable by family, label, id across a reversed refetch', async () => {
  queryClient.clear(); transportCtl.reset()
  $testConnectionId.set('gateway-a'); $testProfile.set('default')
  T.$membershipExpanded.set({ origin: null, ids: [] })
  T.$ledgerTab.set('memberships')
  const mk = (id, family, label, extra = {}) => account(id, { family, label,
    plan_id: `${family}.pro`, plan: { name: 'Pro' }, effective_arrangement: 'subscription',
    fee: { basis: 'declared', effective: { amount: 10, currency: 'USD', period: 'month' } }, ...extra })
  // Labels deliberately oppose family order; b:2 and d:5 share family+label
  // so the id tie-breaker decides between them.
  const b2 = mk('b:2', 'alpha', 'Alfa')
  const d5 = mk('d:5', 'alpha', 'Alfa')
  const a4 = mk('a:4', 'alpha', 'Echo')
  const a3 = mk('a:3', 'beta', 'Delta', { plan_id: 'beta.pro',
    fee: { basis: 'unpriced', effective: { amount: null } } })
  const c1 = mk('c:1', 'zebra', 'Able', { plan_id: null, plan: null,
    fee: { basis: 'no_plan', effective: { amount: null } } })
  const initial = [c1, a3, d5, b2, a4]
  let saved = false
  transportCtl.respond(call => {
    if (call.path.startsWith('/membership/plans')) return plansOk()
    if (call.method === 'PUT') { saved = true; return { ok: true, account: b2 } }
    return { ok: true, accounts: saved ? [...initial].reverse() : initial,
      store: { loaded: true, error: '' }, notes: [] }
  })
  const { container } = await boot()
  await flush(4)
  const order = () => [...container.querySelectorAll('article[data-account]')].map(a => a.dataset.account)
  const navOrder = () => [...container.querySelectorAll('.wm-account-chip')]
    .map(chip => chip.textContent.replace(' · check', ''))
    .filter(text => !/Needs attention|Showing/.test(text))
  const expected = ['b:2', 'd:5', 'a:4', 'a:3', 'c:1']
  assert.deepEqual(order(), expected, 'rows sort by family, then label, then id')
  assert.deepEqual(navOrder(), ['Alfa', 'Alfa', 'Echo', 'Delta', 'Able'],
    'account navigation follows the same order')
  // The filtered list keeps the order too: a:3 (unpriced fee) and c:1 (no
  // plan) need attention.
  await clickByText(container, 'Needs attention only')
  await flush(2)
  assert.deepEqual(order(), ['a:3', 'c:1'], 'the filtered list keeps the stable order')
  await clickByText(container, 'show all')
  await flush(2)
  // A fee save refetches with the backend order reversed; the visible order
  // must not move.
  const card = container.querySelector('[data-account="b:2"]')
  await openCard(card)
  await toggleGroup(card, 'plan')
  await clickByText(card, 'Edit fee')
  await typeAmount(card, '23')
  await clickByText(card, 'Save fee')
  await flush(5)
  assert.equal(transportCtl.count(c => c.method === 'PUT'), 1, 'the fee saved')
  assert.deepEqual(order(), expected, 'rows do not move when the refetch reverses backend order')
  assert.deepEqual(navOrder(), ['Alfa', 'Alfa', 'Echo', 'Delta', 'Able'],
    'navigation does not move when the refetch reverses backend order')
})

const openCard = async card => {
  const details = [...card.querySelectorAll('.wm-row-head button')].find(b => /Details/.test(b.textContent))
  await React.act(async () => { details.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  await flush(2)
  return details
}
const toggleGroup = async (card, group) => {
  const summary = card.querySelector(`[data-group="${group}"] > summary`)
  await React.act(async () => { summary.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  await flush(2)
}

test('PR-C: Details → Plan & billing → Edit fee shows the editor; collapse keeps the draft', async () => {
  queryClient.clear(); transportCtl.reset()
  $testConnectionId.set('gateway-a'); $testProfile.set('default')
  T.$membershipExpanded.set({ origin: null, ids: [] })
  T.$ledgerTab.set('memberships')
  const sub = account('openai-codex:default', {
    family: 'openai-codex', label: 'main', plan_id: 'openai-codex.chatgpt-plus',
    plan: { name: 'ChatGPT Plus' }, effective_arrangement: 'subscription',
    fee: { basis: 'declared', effective: { amount: 20, currency: 'USD', period: 'month' } }
  })
  transportCtl.respond(call => call.path === '/membership/accounts'
    ? { ok: true, accounts: [sub], store: { loaded: true, error: '' }, notes: [] }
    : { ok: true })
  const { container } = await boot()
  await flush(4)
  const card = container.querySelector('[data-account="openai-codex:default"]')
  await openCard(card)
  await toggleGroup(card, 'plan')
  await clickByText(card, 'Edit fee')
  await flush(2)
  assert.ok(card.querySelector('form.wm-fee-form'), 'the fee editor is shown')
  await typeAmount(card, '25')
  await toggleGroup(card, 'plan')
  assert.equal(card.querySelector('[data-group="plan"]').open, false, 'the group collapses on summary click')
  await toggleGroup(card, 'plan')
  assert.equal(card.querySelector('form input[type="number"]').value, '25',
    'reopening keeps the draft value')
  await clickByText(card, 'Cancel')
  await flush(2)
})

test('PR-C: Details → Advanced → user-defined plan opens Advanced, not Plan & billing', async () => {
  queryClient.clear(); transportCtl.reset()
  $testConnectionId.set('gateway-a'); $testProfile.set('default')
  T.$membershipExpanded.set({ origin: null, ids: [] })
  T.$ledgerTab.set('memberships')
  const sub = account('openai-codex:default', {
    family: 'openai-codex', label: 'main', plan_id: 'openai-codex.chatgpt-plus',
    plan: { name: 'ChatGPT Plus' }, effective_arrangement: 'subscription',
    fee: { basis: 'declared', effective: { amount: 20, currency: 'USD', period: 'month' } }
  })
  transportCtl.respond(call => call.path === '/membership/accounts'
    ? { ok: true, accounts: [sub], store: { loaded: true, error: '' }, notes: [] }
    : { ok: true })
  const { container } = await boot()
  await flush(4)
  const card = container.querySelector('[data-account="openai-codex:default"]')
  await openCard(card)
  await toggleGroup(card, 'advanced')
  await clickByText(card, 'Create user-defined plan')
  await flush(2)
  assert.ok(card.querySelector('form.wm-custom-form'), 'the custom-plan editor is shown')
  assert.equal(card.querySelector('[data-group="advanced"]').open, true, 'the custom draft opens Advanced')
  assert.equal(card.querySelector('[data-group="plan"]').open, false,
    'the custom draft does not open the unrelated Plan & billing group')
  await clickByText(card, 'Cancel')
  await flush(2)
})

test('PR-C: Details → Allowances → exhaustion shows the exhaustion editor', async () => {
  queryClient.clear(); transportCtl.reset()
  $testConnectionId.set('gateway-a'); $testProfile.set('default')
  T.$membershipExpanded.set({ origin: null, ids: [] })
  T.$ledgerTab.set('memberships')
  const sub = account('openai-codex:default', {
    family: 'openai-codex', label: 'main', plan_id: 'openai-codex.chatgpt-plus',
    plan: { name: 'ChatGPT Plus' }, effective_arrangement: 'subscription',
    fee: { basis: 'declared', effective: { amount: 20, currency: 'USD', period: 'month' } }
  })
  transportCtl.respond(call => call.path === '/membership/accounts'
    ? { ok: true, accounts: [sub], store: { loaded: true, error: '' }, notes: [] }
    : { ok: true })
  const { container } = await boot()
  await flush(4)
  const card = container.querySelector('[data-account="openai-codex:default"]')
  await openCard(card)
  await toggleGroup(card, 'allowances')
  await clickByText(card, 'Mark account exhausted')
  await flush(2)
  assert.ok(card.querySelector('form.wm-exhaustion-form'), 'the exhaustion editor is shown')
  assert.equal(card.querySelector('[data-group="allowances"]').open, true,
    'the exhaustion draft opens Allowances & readings')
  await clickByText(card, 'Cancel')
  await flush(2)
})

test('PR-C: each draft cancel returns focus to its own opener', async () => {
  queryClient.clear(); transportCtl.reset()
  $testConnectionId.set('gateway-a'); $testProfile.set('default')
  T.$membershipExpanded.set({ origin: null, ids: [] })
  T.$ledgerTab.set('memberships')
  const sub = account('openai-codex:default', {
    family: 'openai-codex', label: 'main', plan_id: 'openai-codex.chatgpt-plus',
    plan: { name: 'ChatGPT Plus' }, effective_arrangement: 'subscription',
    fee: { basis: 'declared', effective: { amount: 20, currency: 'USD', period: 'month' } }
  })
  transportCtl.respond(call => call.path === '/membership/accounts'
    ? { ok: true, accounts: [sub], store: { loaded: true, error: '' }, notes: [] }
    : { ok: true })
  const { container } = await boot()
  await flush(4)
  const card = container.querySelector('[data-account="openai-codex:default"]')
  await openCard(card)
  await toggleGroup(card, 'plan')
  const editFee = [...card.querySelectorAll('button')].find(b => b.textContent === 'Edit fee')
  await React.act(async () => { editFee.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  await flush(2)
  await toggleGroup(card, 'advanced')
  await clickByText(card, 'Create user-defined plan')
  await flush(2)
  assert.ok(card.querySelector('form.wm-fee-form'), 'the fee draft stays open')
  assert.ok(card.querySelector('form.wm-custom-form'), 'the custom draft opens alongside')
  // Plan group precedes Advanced, so the first Cancel belongs to the fee form.
  await clickByText(card, 'Cancel')
  await flush(2)
  assert.ok(document.activeElement === editFee, 'fee cancel returns to Edit fee, not the later opener')
  const createPlan = [...card.querySelectorAll('button')].find(b => b.textContent === 'Create user-defined plan')
  await clickByText(card.querySelector('form.wm-custom-form'), 'Cancel')
  await flush(2)
  assert.ok(document.activeElement === createPlan, 'custom cancel returns to its own opener')
})

test('PR-C: window exhaustion form opens inline under its button and takes focus', async () => {
  queryClient.clear(); transportCtl.reset()
  $testConnectionId.set('gateway-a'); $testProfile.set('default')
  T.$membershipExpanded.set({ origin: null, ids: [] })
  T.$ledgerTab.set('memberships')
  const sub = account('openai-codex:default', {
    family: 'openai-codex', label: 'main', plan_id: 'openai-codex.chatgpt-plus',
    plan: { name: 'ChatGPT Plus' }, effective_arrangement: 'subscription',
    fee: { basis: 'declared', effective: { amount: 20, currency: 'USD', period: 'month' } },
    quota: { windows: [
      { id: 'win-1', label: 'Weekly window', used_percent: 10, state: 'live' },
      { id: 'win-2', label: 'Monthly window', used_percent: 40, state: 'live' },
    ] }
  })
  transportCtl.respond(call => call.path === '/membership/accounts'
    ? { ok: true, accounts: [sub], store: { loaded: true, error: '' }, notes: [] }
    : { ok: true })
  const { container } = await boot()
  await flush(4)
  const card = container.querySelector('[data-account="openai-codex:default"]')
  await openCard(card)
  await toggleGroup(card, 'allowances')
  const li = card.querySelector('li[data-window="win-2"]')
  const button = [...li.querySelectorAll('button')].find(b => b.textContent === 'Mark exhausted')
  await React.act(async () => { button.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  await flush(2)
  const forms = [...card.querySelectorAll('form.wm-exhaustion-form')]
  assert.equal(forms.length, 1, 'one exhaustion form opens')
  assert.equal(forms[0].closest('li[data-window]')?.dataset.window, 'win-2',
    'the form renders inside the clicked window row, not at the group bottom')
  assert.ok(li.querySelector('.wm-quota-actions').nextElementSibling === forms[0],
    'the form sits immediately beneath the clicked button')
  assert.equal(button.getAttribute('aria-expanded'), 'true', 'the opener announces the open form')
  assert.ok(document.activeElement === forms[0].querySelector('input[type="datetime-local"]'),
    'the first field takes focus so the response is visible')
  await clickByText(card, 'Cancel')
  await flush(2)
})

test('PR-C: account exhaustion form opens under the account button; cancel returns focus', async () => {
  queryClient.clear(); transportCtl.reset()
  $testConnectionId.set('gateway-a'); $testProfile.set('default')
  T.$membershipExpanded.set({ origin: null, ids: [] })
  T.$ledgerTab.set('memberships')
  const sub = account('openai-codex:default', {
    family: 'openai-codex', label: 'main', plan_id: 'openai-codex.chatgpt-plus',
    plan: { name: 'ChatGPT Plus' }, effective_arrangement: 'subscription',
    fee: { basis: 'declared', effective: { amount: 20, currency: 'USD', period: 'month' } },
    quota: { windows: [] }
  })
  transportCtl.respond(call => call.path === '/membership/accounts'
    ? { ok: true, accounts: [sub], store: { loaded: true, error: '' }, notes: [] }
    : { ok: true })
  const { container } = await boot()
  await flush(4)
  const card = container.querySelector('[data-account="openai-codex:default"]')
  await openCard(card)
  await toggleGroup(card, 'allowances')
  const button = [...card.querySelectorAll('button')].find(b => b.textContent === 'Mark account exhausted')
  await React.act(async () => { button.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  await flush(2)
  const form = card.querySelector('form.wm-exhaustion-form')
  assert.ok(form, 'the exhaustion form opens')
  assert.ok(form.closest('.wm-quota-empty'), 'the form renders under the account button')
  assert.ok(button.nextElementSibling === form, 'nothing sits between the button and its form')
  assert.ok(document.activeElement === form.querySelector('input[type="datetime-local"]'),
    'the first field takes focus')
  await clickByText(card, 'Cancel')
  await flush(2)
  assert.equal(card.querySelector('form.wm-exhaustion-form'), null, 'cancel closes the form')
  assert.ok(document.activeElement === button, 'cancel returns focus to the opener')
})

test('PR-C: exhaustion save shows Saving, and a failed save keeps the draft with an alert', async () => {
  queryClient.clear(); transportCtl.reset()
  $testConnectionId.set('gateway-a'); $testProfile.set('default')
  T.$membershipExpanded.set({ origin: null, ids: [] })
  T.$ledgerTab.set('memberships')
  const sub = account('openai-codex:default', {
    family: 'openai-codex', label: 'main', plan_id: 'openai-codex.chatgpt-plus',
    plan: { name: 'ChatGPT Plus' }, effective_arrangement: 'subscription',
    fee: { basis: 'declared', effective: { amount: 20, currency: 'USD', period: 'month' } },
    quota: { windows: [] }
  })
  const gate = deferred()
  let failWrites = false
  transportCtl.respond(call => {
    if (call.path.startsWith('/membership/plans')) return plansOk()
    if (call.method === 'POST' && call.path.endsWith('/exhaustion')) {
      return failWrites ? Promise.reject(new Error('500 Internal Server Error')) : gate.promise
    }
    return { ok: true, accounts: [sub], store: { loaded: true, error: '' }, notes: [] }
  })
  const { container } = await boot()
  await flush(4)
  const card = container.querySelector('[data-account="openai-codex:default"]')
  await openCard(card)
  await toggleGroup(card, 'allowances')
  await clickByText(card, 'Mark account exhausted')
  await flush(2)
  const form = card.querySelector('form.wm-exhaustion-form')
  const dt = form.querySelector('input[type="datetime-local"]')
  await React.act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(dt, '2026-12-31T23:59')
    dt.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
  await flush(2)
  await clickByText(card, 'Save manual status')
  await flush(2)
  const submit = [...card.querySelectorAll('form.wm-exhaustion-form button')].find(b => b.type === 'submit')
  assert.match(submit.textContent, /Saving…/, 'the submit button distinguishes saving from drafting')
  assert.equal([...card.querySelectorAll('form.wm-exhaustion-form button')]
    .find(b => b.textContent === 'Cancel').disabled, true, 'cancel waits while the save is in flight')
  await React.act(async () => { gate.resolve({ ok: true }); await new Promise(r => setTimeout(r, 0)) })
  await flush(5)
  assert.equal(card.querySelector('form.wm-exhaustion-form'), null, 'a clean save closes the form')
  // A failed save keeps the typed draft and explains itself inside the form.
  failWrites = true
  await clickByText(card, 'Mark account exhausted')
  await flush(2)
  await clickByText(card, 'Save manual status')
  await flush(5)
  const kept = card.querySelector('form.wm-exhaustion-form')
  assert.ok(kept, 'the failed save keeps the draft open')
  assert.match(kept.querySelector('[role="alert"]').textContent, /The backend answered with an error/,
    'the failure is explained where the save was attempted')
  await clickByText(card, 'Cancel')
  await flush(2)
})

test('PR-C: expanded rows are identity-isolated and the summary strip keeps its values', async () => {
  queryClient.clear(); transportCtl.reset()
  $testConnectionId.set('gateway-a'); $testProfile.set('default')
  T.$membershipExpanded.set({ origin: null, ids: [] })
  T.$ledgerTab.set('memberships')
  transportCtl.respond(call => call.path === '/membership/accounts'
    ? { ok: true, accounts: [account('a:acct', { label: 'A account' })],
        store: { loaded: true, error: '' }, notes: [] }
    : { ok: true })
  const { container } = await boot()
  await flush(4)
  const summary = container.querySelector('.wm-membership-summary')
  assert.ok(summary, 'the compact membership summary is present')
  assert.match(summary.textContent, /Accounts/)
  assert.match(summary.textContent, /Membership fees/)
  assert.match(summary.textContent, /No fee amount recorded/)
  const card = container.querySelector('[data-account="a:acct"]')
  const details = [...card.querySelectorAll('button')].find(b => /Details/.test(b.textContent))
  await React.act(async () => { details.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  await flush(2)
  assert.equal(details.getAttribute('aria-expanded'), 'true')
  await React.act(async () => { $testProfile.set('work') })
  await flush(4)
  const relaid = container.querySelector('[data-account="a:acct"] .wm-row-head button')
  assert.equal(relaid.getAttribute('aria-expanded'), 'false',
    'a profile switch collapses rows from the previous identity')
})

test('PR-C: refresh is renamed with an explanation and the operation is unchanged', async () => {
  queryClient.clear(); transportCtl.reset()
  $testConnectionId.set('gateway-a'); $testProfile.set('default')
  T.$ledgerTab.set('memberships')
  transportCtl.respond(call => call.path === '/membership/accounts'
    ? { ok: true, accounts: [account('a:acct', { label: 'A account' })],
        store: { loaded: true, error: '' }, notes: [] }
    : { ok: true })
  const { container, text } = await boot()
  await flush(4)
  assert.ok([...container.querySelectorAll('button')].some(b => b.textContent === 'Refresh provider usage'))
  assert.match(text(), /checks provider-reported usage where supported/)
  assert.match(text(), /never changes saved plans, fees or marks/)
  await clickByText(container, 'Refresh provider usage')
  await flush(4)
  assert.ok(transportCtl.calls.some(call => call.path === '/membership/accounts?native=true'),
    'the renamed button still triggers the stored-plus-native refresh')
})

// ---------------------------------------------------------------------------
// PR-D: segmented billing control and attention navigation.
// ---------------------------------------------------------------------------

test('PR-D: clicking the selected arrangement sends no write', async () => {
  queryClient.clear(); transportCtl.reset()
  $testConnectionId.set('gateway-a'); $testProfile.set('default')
  transportCtl.respond(call => call.path.startsWith('/membership/plans') ? plansOk()
    : { ok: true, accounts: [account('s:acct', { label: 'S account' })],
        store: { loaded: true, error: '' }, notes: [] })
  const { container } = await boot()
  await flush(4)
  const seg = container.querySelector('[data-nav="arrangement"]')
  const selected = [...seg.querySelectorAll('button')].find(b => b.getAttribute('aria-pressed') === 'true')
  assert.equal(selected.textContent, 'Subscription')
  await React.act(async () => { selected.click() })
  await flush(2)
  assert.equal(transportCtl.calls.filter(c => c.method === 'PUT').length, 0,
    'a no-op click on the current arrangement writes nothing')
})

test('PR-D: a failed arrangement write keeps the previous selection and reports inline', async () => {
  queryClient.clear(); transportCtl.reset()
  $testConnectionId.set('gateway-a'); $testProfile.set('default')
  transportCtl.respond(call => {
    if (call.path.startsWith('/membership/plans')) return plansOk()
    if (call.method === 'PUT') throw new Error('409 Conflict')
    return { ok: true, accounts: [account('f:acct', { label: 'F account' })],
      store: { loaded: true, error: '' }, notes: [] }
  })
  const { container } = await boot()
  await flush(4)
  const card = container.querySelector('[data-account="f:acct"]')
  const seg = card.querySelector('[data-nav="arrangement"]')
  await React.act(async () => {
    [...seg.querySelectorAll('button')].find(b => b.textContent === 'Prepaid credits').click()
  })
  await flush(4)
  const pressed = [...seg.querySelectorAll('button')].find(b => b.getAttribute('aria-pressed') === 'true')
  assert.equal(pressed.textContent, 'Subscription',
    'the control is derived from server state, so a failed write cannot move it')
  // A 409 maps to the stale-revision message via the existing error
  // classification; the point is the failure surfaces beside the control.
  assert.match(card.textContent, /changed since you loaded it/,
    'the card shows the failure beside the control')
})

test('PR-D: attention items carry structured issue targets, not parsed text', () => {
  const t = (key, ...args) => {
    const entry = T.I18N.en[key]
    return typeof entry === 'function' ? entry(...args) : entry ?? key
  }
  const unconfirmed = account('x:default', { effective_arrangement: 'unconfirmed' })
  const noPlan = account('s:default', { effective_arrangement: 'subscription', plan_id: null })
  const noFee = account('n:default', { effective_arrangement: 'subscription',
    plan_id: 'n.pro', plan: { name: 'Pro' }, fee: { basis: 'unpriced', effective: { amount: null } } })
  const items = T.needsAttention([unconfirmed, noPlan, noFee], new Map(), t)
  const byId = Object.fromEntries(items.map(i => [i.account.id, i]))
  assert.equal(byId['x:default'].issue, 'unconfirmed')
  assert.deepEqual(byId['x:default'].target, { group: 'plan', focus: 'arrangement' })
  assert.equal(byId['s:default'].issue, 'no-plan')
  assert.deepEqual(byId['s:default'].target, { group: 'plan', focus: 'plan' })
  assert.equal(byId['n:default'].issue, 'no-fee')
  assert.deepEqual(byId['n:default'].target, { group: 'plan', focus: 'fee' })
  assert.equal(T.attentionActionLabel('unconfirmed', t), 'Confirm arrangement')
  assert.equal(T.attentionActionLabel('no-plan', t), 'Confirm plan')
  assert.equal(T.attentionActionLabel('no-fee', t), 'Set fee')
  assert.equal(T.attentionActionLabel('reconfirm-plan', t), 'Review plan')
  assert.equal(T.attentionActionLabel('conflict', t), 'Review reading')
  const zhT = (key, ...args) => {
    const entry = T.I18N.zh[key]
    return typeof entry === 'function' ? entry(...args) : entry ?? key
  }
  assert.equal(T.attentionActionLabel('unconfirmed', zhT), '确认账单安排')
  assert.equal(T.attentionActionLabel('no-fee', zhT), '设置费用')
})

test('PR-D: a queued target expands the account, opens the group and focuses the control', async () => {
  queryClient.clear(); transportCtl.reset()
  $testConnectionId.set('gateway-a'); $testProfile.set('default')
  const xai = account('xai:default', { family: 'xai', label: 'xAI',
    billing_arrangement: 'unconfirmed', effective_arrangement: 'unconfirmed' })
  const sub = account('anthropic:default', { family: 'anthropic', label: 'main',
    plan_id: 'anthropic.pro', plan: { name: 'Pro' }, effective_arrangement: 'subscription',
    fee: { basis: 'declared', effective: { amount: 45, currency: 'GBP', period: 'month' } } })
  transportCtl.respond(call => call.path.startsWith('/membership/plans') ? plansOk()
    : { ok: true, accounts: [xai, sub], store: { loaded: true, error: '' }, notes: [] })
  const scrolled = []
  const proto = window.HTMLElement.prototype
  const originalScroll = proto.scrollIntoView
  proto.scrollIntoView = function (opts) { scrolled.push([this, opts]) }
  try {
    const { container } = await boot()
    await flush(4)
    T.$membershipTarget.set({ origin: T.membershipIdentityNow(), accountId: 'xai:default',
      issue: 'unconfirmed', group: 'plan', focus: 'arrangement' })
    await React.act(async () => { await new Promise(r => setTimeout(r, 150)) })
    await flush(2)
    const card = container.querySelector('[data-account="xai:default"]')
    assert.equal(card.querySelector('.wm-row-head button').getAttribute('aria-expanded'), 'true',
      'navigation expands the target account row')
    assert.equal(card.querySelector('[data-group="plan"]').open, true,
      'navigation opens the Plan & billing group')
    const seg = card.querySelector('[data-nav="arrangement"]')
    // Identity, not deep equality: handing two live nodes to assert hangs
    // the runner while it serialises them (see the tab-bar test below).
    assert.ok(document.activeElement === seg.querySelector('button[aria-pressed="true"]'),
      'focus moves to the pressed arrangement button')
    assert.ok(seg.classList.contains('wm-flash'), 'the target control is highlighted')
    assert.ok(scrolled.some(([el, opts]) => el === seg && opts?.block === 'nearest'),
      'the resolved target itself is scrolled into view, not the card header')
    assert.equal(T.$membershipTarget.get(), null, 'the target is consumed')
    // The other account is untouched.
    assert.equal(container.querySelector('[data-account="anthropic:default"] .wm-row-head button')
      .getAttribute('aria-expanded'), 'false')
  } finally {
    if (originalScroll) proto.scrollIntoView = originalScroll
    else delete proto.scrollIntoView
  }
})

test('PR-D: navigation waits for async loading instead of dropping the target', async () => {
  queryClient.clear(); transportCtl.reset()
  $testConnectionId.set('gateway-a'); $testProfile.set('default')
  const pending = deferred()
  const xai = account('xai:default', { family: 'xai', label: 'xAI',
    billing_arrangement: 'unconfirmed', effective_arrangement: 'unconfirmed' })
  transportCtl.respond(call => call.path.startsWith('/membership/plans') ? plansOk() : pending.promise)
  const { container } = await boot()
  await flush(1)
  T.$membershipTarget.set({ origin: T.membershipIdentityNow(), accountId: 'xai:default',
    issue: 'unconfirmed', group: 'plan', focus: 'arrangement' })
  await flush(2)
  assert.ok(T.$membershipTarget.get(), 'the target is held while accounts load')
  pending.resolve({ ok: true, accounts: [xai], store: { loaded: true, error: '' }, notes: [] })
  await flush(4)
  await React.act(async () => { await new Promise(r => setTimeout(r, 150)) })
  await flush(2)
  assert.equal(container.querySelector('[data-account="xai:default"] .wm-row-head button')
    .getAttribute('aria-expanded'), 'true', 'navigation lands once the accounts arrive')
  assert.equal(T.$membershipTarget.get(), null)
})

test('PR-D: a profile switch discards a stale navigation intention', async () => {
  queryClient.clear(); transportCtl.reset()
  $testConnectionId.set('gateway-a'); $testProfile.set('default')
  transportCtl.respond(call => call.path.startsWith('/membership/plans') ? plansOk()
    : { ok: true, accounts: [account('a:acct', { label: 'A account' })],
        store: { loaded: true, error: '' }, notes: [] })
  const { container } = await boot()
  await flush(4)
  T.$membershipTarget.set({ origin: T.membershipIdentityNow(), accountId: 'a:acct',
    issue: 'no-plan', group: 'plan', focus: 'plan' })
  await React.act(async () => { $testProfile.set('work') })
  await flush(4)
  assert.equal(T.$membershipTarget.get(), null, 'the stale target never crosses identities')
  assert.equal(container.querySelector('[data-account="a:acct"] .wm-row-head button')
    .getAttribute('aria-expanded'), 'false', 'no navigation runs for the discarded target')
})

test('PR-D: navigation leaves an open fee draft intact', async () => {
  queryClient.clear(); transportCtl.reset()
  $testConnectionId.set('gateway-a'); $testProfile.set('default')
  const sub = account('s:acct', { family: 's', label: 'S account',
    plan_id: 's.pro', plan: { name: 'Pro' }, effective_arrangement: 'subscription',
    fee: { basis: 'declared', effective: { amount: 10, currency: 'USD', period: 'month' } } })
  const xai = account('xai:default', { family: 'xai', label: 'xAI',
    billing_arrangement: 'unconfirmed', effective_arrangement: 'unconfirmed' })
  transportCtl.respond(call => call.path.startsWith('/membership/plans') ? plansOk()
    : { ok: true, accounts: [sub, xai], store: { loaded: true, error: '' }, notes: [] })
  const { container } = await boot()
  await flush(4)
  await clickByText(container.querySelector('[data-account="s:acct"]'), 'Edit fee')
  await typeAmount(container, '33')
  T.$membershipTarget.set({ origin: T.membershipIdentityNow(), accountId: 'xai:default',
    issue: 'unconfirmed', group: 'plan', focus: 'arrangement' })
  await React.act(async () => { await new Promise(r => setTimeout(r, 150)) })
  await flush(2)
  const form = container.querySelector('[data-account="s:acct"] form.wm-fee-form')
  assert.ok(form, 'the fee draft stays open through navigation')
  assert.equal(form.querySelector('input[type="number"]').value, '33', 'typed values survive')
  assert.equal(container.querySelector('[data-account="xai:default"] .wm-row-head button')
    .getAttribute('aria-expanded'), 'true')
})

test('PR-D: a missing precise target falls back to the account Details section', async () => {
  queryClient.clear(); transportCtl.reset()
  $testConnectionId.set('gateway-a'); $testProfile.set('default')
  // Metered accounts render the plan selector disabled, so a plan target
  // cannot focus it and must fall back safely.
  const metered = account('m:acct', { family: 'm', label: 'M account',
    plan_id: null, effective_arrangement: 'api_only',
    fee: { basis: 'api_only', effective: { amount: null } } })
  transportCtl.respond(call => call.path.startsWith('/membership/plans') ? plansOk()
    : { ok: true, accounts: [metered], store: { loaded: true, error: '' }, notes: [] })
  const { container } = await boot()
  await flush(4)
  T.$membershipTarget.set({ origin: T.membershipIdentityNow(), accountId: 'm:acct',
    issue: 'no-plan', group: 'plan', focus: 'plan' })
  await React.act(async () => { await new Promise(r => setTimeout(r, 150)) })
  await flush(2)
  const card = container.querySelector('[data-account="m:acct"]')
  assert.equal(card.querySelector('.wm-row-head button').getAttribute('aria-expanded'), 'true')
  // Identity, not deep equality: handing two live nodes to assert hangs
  // the runner while it serialises them.
  assert.ok(document.activeElement === card.querySelector('.wm-row-head button'),
    'focus falls back to the Details toggle')
  assert.ok(card.querySelector('.wm-row-head').classList.contains('wm-flash'),
    'the Details section header is highlighted')
})

test('PR-D: Memberships attention actions jump within the page', async () => {
  queryClient.clear(); transportCtl.reset()
  $testConnectionId.set('gateway-a'); $testProfile.set('default')
  const xai = account('xai:default', { family: 'xai', label: 'xAI',
    billing_arrangement: 'unconfirmed', effective_arrangement: 'unconfirmed' })
  transportCtl.respond(call => call.path.startsWith('/membership/plans') ? plansOk()
    : { ok: true, accounts: [xai], store: { loaded: true, error: '' }, notes: [] })
  const { container } = await boot()
  await flush(4)
  const section = [...container.querySelectorAll('.wm-attention')]
    .find(el => el.getAttribute('aria-label') === 'Needs attention')
  assert.ok(section, 'the Memberships attention section renders')
  await clickByText(section, 'Confirm arrangement')
  await React.act(async () => { await new Promise(r => setTimeout(r, 150)) })
  await flush(2)
  assert.equal(container.querySelector('[data-account="xai:default"] .wm-row-head button')
    .getAttribute('aria-expanded'), 'true', 'the in-page action expands the account')
  assert.ok(container.querySelector('[data-account="xai:default"] [data-nav="arrangement"]')
    .classList.contains('wm-flash'))
})

// ---------------------------------------------------------------------------
// PR-D review: target visibility, reading targets, tooltip anchor.
// ---------------------------------------------------------------------------

test('PR-D review: an ahead warning targets its own weather reading, not a user mark', async () => {
  queryClient.clear(); transportCtl.reset()
  $testConnectionId.set('gateway-a'); $testProfile.set('default')
  // The quota window carries an unrelated reconfirm mark: the provider
  // reading target must not resolve to its Clear mark button.
  const sub = account('w:acct', { family: 'w', label: 'W account',
    plan_id: 'w.pro', plan: { name: 'Pro' }, effective_arrangement: 'subscription',
    fee: { basis: 'declared', effective: { amount: 10, currency: 'USD', period: 'month' } },
    quota: { windows: [{ id: 'win-1', label: 'Weekly window', used_percent: 10,
      state: 'manual', used_percent_from: 'manual',
      manual: { id: 'man-1', status: 'reconfirm_due' } }] } })
  const weather = { ok: true, accounts: [{ account_id: 'w:acct',
    rollup: { state: 'ahead' }, cycle: {}, notes: [],
    windows: [{ id: 'win-1', label: 'Weekly pool', verdict: 'ahead' }], rules: [] }] }
  transportCtl.respond(call => call.path.startsWith('/membership/plans') ? plansOk()
    : call.path === '/allowance/weather' ? weather
    : { ok: true, accounts: [sub], store: { loaded: true, error: '' }, notes: [] })
  const { container } = await boot()
  await flush(4)
  T.$membershipTarget.set({ origin: T.membershipIdentityNow(), accountId: 'w:acct',
    issue: 'ahead', group: 'allowances', focus: 'reading',
    readingKind: 'window', readingId: 'win-1' })
  await React.act(async () => { await new Promise(r => setTimeout(r, 150)) })
  await flush(2)
  const card = container.querySelector('[data-account="w:acct"]')
  assert.equal(card.querySelector('.wm-weather-details').open, true,
    'the weather details open for the reading')
  const li = card.querySelector('li[data-weather-kind="window"][data-weather-id="win-1"]')
  assert.ok(li, 'the reading row carries its stable identifier')
  assert.ok(document.activeElement === li, 'focus moves to the reading itself')
  assert.ok(li.classList.contains('wm-flash'), 'the reading is highlighted')
  assert.ok(document.activeElement !== card.querySelector('button[data-action="clear-mark"]'),
    'an unrelated user mark is never focused for a provider reading')
})

test('PR-D review: a reached rule warning targets the rule reading by profile and pool', async () => {
  queryClient.clear(); transportCtl.reset()
  $testConnectionId.set('gateway-a'); $testProfile.set('default')
  const sub = account('r:acct', { family: 'r', label: 'R account',
    plan_id: 'r.pro', plan: { name: 'Pro' }, effective_arrangement: 'subscription',
    fee: { basis: 'declared', effective: { amount: 10, currency: 'USD', period: 'month' } } })
  const weather = { ok: true, accounts: [{ account_id: 'r:acct',
    rollup: { state: 'exhausted' }, cycle: {}, notes: [], windows: [],
    rules: [{ profile_id: 'prof-1', pool: 'main', label: 'Main pool', verdict: 'exhausted',
      used_usd: 50, limit_usd: 40, consumed_fraction: 1.0, lower_bound: false,
      pace_usd_per_day: null, projected_exhaustion: null, forecast_status: 'unavailable' }] }] }
  transportCtl.respond(call => call.path.startsWith('/membership/plans') ? plansOk()
    : call.path === '/allowance/weather' ? weather
    : { ok: true, accounts: [sub], store: { loaded: true, error: '' }, notes: [] })
  const { container } = await boot()
  await flush(4)
  T.$membershipTarget.set({ origin: T.membershipIdentityNow(), accountId: 'r:acct',
    issue: 'reached', group: 'allowances', focus: 'reading',
    readingKind: 'rule', readingProfile: 'prof-1', readingPool: 'main' })
  await React.act(async () => { await new Promise(r => setTimeout(r, 150)) })
  await flush(2)
  const card = container.querySelector('[data-account="r:acct"]')
  const li = card.querySelector(
    'li[data-weather-kind="rule"][data-weather-profile="prof-1"][data-weather-pool="main"]')
  assert.ok(li, 'the rule reading is addressable by profile and pool')
  assert.ok(document.activeElement === li, 'focus moves to the rule reading')
  assert.ok(li.classList.contains('wm-flash'), 'the rule reading is highlighted')
})

test('PR-D review: a disappeared reading falls back to the allowance section', async () => {
  queryClient.clear(); transportCtl.reset()
  $testConnectionId.set('gateway-a'); $testProfile.set('default')
  transportCtl.respond(call => call.path.startsWith('/membership/plans') ? plansOk()
    : { ok: true, accounts: [account('g:acct', { label: 'G account' })],
        store: { loaded: true, error: '' }, notes: [] })
  const { container } = await boot()
  await flush(4)
  T.$membershipTarget.set({ origin: T.membershipIdentityNow(), accountId: 'g:acct',
    issue: 'ahead', group: 'allowances', focus: 'reading',
    readingKind: 'window', readingId: 'win-gone' })
  await React.act(async () => { await new Promise(r => setTimeout(r, 150)) })
  await flush(2)
  const card = container.querySelector('[data-account="g:acct"]')
  const summary = card.querySelector('[data-group="allowances"] > summary')
  assert.ok(document.activeElement === summary,
    'a missing reading falls back to the allowance section')
  assert.ok(card.querySelector('[data-group="allowances"]').classList.contains('wm-flash'))
  assert.ok(document.activeElement !== card.querySelector('.wm-row-head button'),
    'the section fallback is distinct from the Details fallback')
})

test('PR-D review: account exhaustion focuses the allowance section, not a clear action', async () => {
  queryClient.clear(); transportCtl.reset()
  $testConnectionId.set('gateway-a'); $testProfile.set('default')
  const sub = account('e:acct', { family: 'e', label: 'E account',
    plan_id: 'e.pro', plan: { name: 'Pro' }, effective_arrangement: 'subscription',
    fee: { basis: 'declared', effective: { amount: 10, currency: 'USD', period: 'month' } },
    quota: { account_exhausted: true, windows: [{ id: 'win-1', label: 'Weekly window',
      used_percent: 10, state: 'manual', used_percent_from: 'manual',
      manual: { id: 'man-1', status: 'reconfirm_due' } }] } })
  transportCtl.respond(call => call.path.startsWith('/membership/plans') ? plansOk()
    : { ok: true, accounts: [sub], store: { loaded: true, error: '' }, notes: [] })
  const { container } = await boot()
  await flush(4)
  T.$membershipTarget.set({ origin: T.membershipIdentityNow(), accountId: 'e:acct',
    issue: 'exhausted', group: 'allowances', focus: 'allowances' })
  await React.act(async () => { await new Promise(r => setTimeout(r, 150)) })
  await flush(2)
  const card = container.querySelector('[data-account="e:acct"]')
  assert.ok(document.activeElement === card.querySelector('[data-group="allowances"] > summary'),
    'provider-reported exhaustion focuses the section, not another window mark')
  assert.ok(document.activeElement !== card.querySelector('button[data-action="clear-mark"]'))
})

test('PR-D review: structured reading targets come from weather rows', () => {
  const t = (key, ...args) => {
    const entry = T.I18N.en[key]
    return typeof entry === 'function' ? entry(...args) : entry ?? key
  }
  const sub = account('s:default', { effective_arrangement: 'subscription',
    plan_id: 's.pro', plan: { name: 'Pro' },
    fee: { basis: 'declared', effective: { amount: 10, currency: 'USD', period: 'month' } } })
  const weatherById = new Map([['s:default', {
    windows: [{ id: 'win-1', label: 'Weekly pool', verdict: 'ahead' }],
    rules: [{ profile_id: 'prof-1', pool: 'main', label: 'Main pool',
      verdict: 'exhausted', used_usd: 50 }],
  }]])
  const items = T.needsAttention([sub], weatherById, t)
  const byIssue = Object.fromEntries(items.map(i => [i.issue, i]))
  assert.deepEqual(byIssue.ahead.target,
    { group: 'allowances', focus: 'reading', readingKind: 'window', readingId: 'win-1' })
  assert.deepEqual(byIssue.reached.target,
    { group: 'allowances', focus: 'reading', readingKind: 'rule',
      readingProfile: 'prof-1', readingPool: 'main' })
})

test('PR-D review: the billing header anchors its info tooltip', () => {
  assert.match(T.MEMBERSHIP_CSS, /\.wm-billing-head\{[^}]*position:relative/,
    'the billing header establishes the positioned containing block')
})

test('PR26 review: whole-account exhaustion posts a language-neutral label', async () => {
  queryClient.clear(); transportCtl.reset()
  $testConnectionId.set('gateway-a'); $testProfile.set('default')
  T.$membershipExpanded.set({ origin: null, ids: [] })
  T.$ledgerTab.set('memberships')
  const sub = account('openai-codex:default', { quota: { windows: [] } })
  transportCtl.respond(call => {
    if (call.path.startsWith('/membership/plans')) return plansOk()
    if (call.method === 'POST' && call.path.endsWith('/exhaustion')) return { ok: true }
    return { ok: true, accounts: [sub], store: { loaded: true, error: '' }, notes: [] }
  })
  const { container } = await boot()
  await flush(4)
  const card = container.querySelector('[data-account="openai-codex:default"]')
  await openCard(card)
  await toggleGroup(card, 'allowances')
  await clickByText(card, 'Mark account exhausted')
  await flush(2)
  await clickByText(card, 'Save manual status')
  await flush(3)
  const post = transportCtl.calls.find(c => c.method === 'POST' && c.path.endsWith('/exhaustion'))
  assert.ok(post, 'the exhaustion mark was posted')
  assert.equal(post.body.scope_kind, 'account')
  assert.equal(post.body.label, null, 'no translated label is persisted')
  assert.equal(post.body.note, 'Manually reported from Spend Sense; not provider-confirmed.')
})

test('PR26 review: re-marking an account row stays account-scoped and neutral', async () => {
  queryClient.clear(); transportCtl.reset()
  $testConnectionId.set('gateway-a'); $testProfile.set('default')
  T.$membershipExpanded.set({ origin: null, ids: [] })
  T.$ledgerTab.set('memberships')
  const sub = account('anthropic:default', {
    quota: { windows: [{ id: 'account', label: 'Account', scope: 'account',
      used_percent: 100, used_percent_from: 'manual', state: 'manual',
      basis: ['manual'], source: 'you',
      manual: { scope: { kind: 'account', id: 'account' }, status: 'active' } }] },
    manual_exhaustions: [{ id: 'manual-1',
      scope: { kind: 'account', id: 'account', label: 'Account' } }],
  })
  transportCtl.respond(call => {
    if (call.path.startsWith('/membership/plans')) return plansOk()
    if (call.method === 'POST' && call.path.endsWith('/exhaustion')) return { ok: true }
    return { ok: true, accounts: [sub], store: { loaded: true, error: '' }, notes: [] }
  })
  const { container } = await boot()
  await flush(4)
  const card = container.querySelector('[data-account="anthropic:default"]')
  await openCard(card)
  await toggleGroup(card, 'allowances')
  const row = card.querySelector('li[data-window="account"]')
  await clickByText(row, 'Mark exhausted')
  await flush(2)
  assert.ok(row.querySelector('form.wm-exhaustion-form'),
    'the account draft opens inline on the account row')
  assert.equal(card.querySelectorAll('form.wm-exhaustion-form').length, 1,
    'the form renders once, not also at the group fallback')
  assert.equal(row.querySelector('button[data-action="mark-exhausted"]').getAttribute('aria-expanded'),
    'true', 'the row action announces the open form')
  await clickByText(card, 'Save manual status')
  await flush(3)
  const post = transportCtl.calls.find(c => c.method === 'POST' && c.path.endsWith('/exhaustion'))
  assert.ok(post, 'the re-mark was posted')
  assert.equal(post.body.scope_kind, 'account', 're-marking the account row stays account-scoped')
  assert.equal(post.body.scope_id, 'account')
  assert.equal(post.body.label, null, 'no translated label is persisted')
})

test('PR26 review: a window draft orphaned onto an account row falls back, never vanishes', async () => {
  queryClient.clear(); transportCtl.reset()
  $testConnectionId.set('gateway-a'); $testProfile.set('default')
  T.$membershipExpanded.set({ origin: null, ids: [] })
  T.$ledgerTab.set('memberships')
  const base = account('anthropic:default', {})
  const providerAccountRow = { id: 'account', label: 'Provider Account', scope: 'account',
    used_percent: 10, state: 'live', basis: ['provider_reported'], source: 'native' }
  const syntheticRow = { id: 'account', label: 'Account', scope: 'account',
    used_percent: 100, used_percent_from: 'manual', state: 'manual',
    basis: ['manual'], source: 'you',
    manual: { scope: { kind: 'account', id: 'account' }, status: 'active' } }
  let phase = 1
  transportCtl.respond(call => {
    if (call.path.startsWith('/membership/plans')) return plansOk()
    const sub = phase === 1
      ? { ...base, quota: { windows: [providerAccountRow] }, manual_exhaustions: [] }
      : { ...base, quota: { windows: [syntheticRow] },
        manual_exhaustions: [{ id: 'manual-1', scope: { kind: 'account', id: 'account' } }] }
    return { ok: true, accounts: [sub], store: { loaded: true, error: '' }, notes: [] }
  })
  const { container } = await boot()
  await flush(4)
  const card = container.querySelector('[data-account="anthropic:default"]')
  await openCard(card)
  await toggleGroup(card, 'allowances')
  // Open a window draft on the provider row, then re-read into a world
  // where only the synthetic account row carries that ID.
  await clickByText(card.querySelector('li[data-window="account"]'), 'Mark exhausted')
  await flush(2)
  phase = 2
  await clickByText(container, 'Refresh provider usage')
  await flush(6)
  const forms = card.querySelectorAll('form.wm-exhaustion-form')
  assert.equal(forms.length, 1, 'the orphaned draft still renders exactly once')
  assert.equal(card.querySelector('li[data-window="account"] form.wm-exhaustion-form'), null,
    'the window draft does not attach to the synthetic account row')
})

test('PR26 review: account-scope exhaustion rows follow the UI language', async () => {
  const enT = i18nBackend.t
  i18nBackend.t = (key, ...args) => {
    const entry = T.I18N.zh[key]
    return typeof entry === 'function' ? entry(...args) : entry ?? key
  }
  try {
    queryClient.clear(); transportCtl.reset()
    $testConnectionId.set('gateway-a'); $testProfile.set('default')
    T.$membershipExpanded.set({ origin: null, ids: [] })
    T.$ledgerTab.set('memberships')
    const sub = account('anthropic:default', {
      quota: { windows: [{ id: 'account', label: 'Account', scope: 'account',
        used_percent: 100, used_percent_from: 'manual', state: 'manual',
        basis: ['manual'], source: 'you',
        manual: { scope: { kind: 'account', id: 'account' }, status: 'active' } }] },
      manual_exhaustions: [{ id: 'manual-1',
        scope: { kind: 'account', id: 'account', label: 'Account' } }],
    })
    transportCtl.respond(call => {
      if (call.path.startsWith('/membership/plans')) return plansOk()
      return { ok: true, accounts: [sub], store: { loaded: true, error: '' }, notes: [] }
    })
    const { container } = await boot()
    await flush(4)
    const label = container.querySelector('[data-account="anthropic:default"] .wm-quota-label')
    assert.equal(label.textContent, '账户', 'the stored neutral label renders translated')
  } finally {
    i18nBackend.t = enT
  }
})

test('seat controls save and clear a quantity with billing period', async () => {
  queryClient.clear(); transportCtl.reset()
  $testConnectionId.set('gateway-a'); $testProfile.set('default')
  const id = 'openai-codex:seats'
  let saved = account(id, { plan_id: 'business', seat_rev: 's1', seat_revisions: [
    { id: 'active', plan_id: 'business', quantity: 2, period: 'month', effective_from: '2020-01-01T00:00:00Z' },
    { id: 'future', plan_id: 'business', quantity: null, period: 'month', effective_from: '2099-01-01T00:00:00Z' }
  ], plan: { name: 'Business', seat_pricing: {
    usual_minimum: 2, prices: { month: { amount: 125, currency: 'USD', period: 'month' },
      year: { amount: 1200, currency: 'USD', period: 'year' } } } },
    fee: { basis: 'catalogue', effective: { amount: 125, currency: 'USD', period: 'month' },
      published: { amount: 125, currency: 'USD', per_seat: true } } })
  transportCtl.respond(call => {
    if (call.path === '/membership/plans') return plansOk()
    if (call.method === 'PUT') {
      saved = { ...saved, seat_revisions: [...saved.seat_revisions, call.body.revision], seat_rev: 's2' }
      return { ok: true }
    }
    return { ok: true, accounts: [saved], store: { loaded: true, error: '' }, notes: [] }
  })
  const { container } = await boot(); await flush(3)
  assert.match(container.textContent, /Usually at least 2 seats/)
  assert.match(container.textContent, /\$125\.00 per seat/)
  const form = container.querySelector('input[name="quantity"]').closest('form')
  assert.equal(form.querySelector('input[name="quantity"]').value, '2', 'future revisions do not replace current form values')
  await setField(container, 'Seats', '3', form)
  await setField(container, 'Period', 'year', form)
  await React.act(async () => form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })))
  await flush(4)
  let writes = transportCtl.calls.filter(call => call.method === 'PUT')
  assert.equal(writes.at(-1).path, `/membership/accounts/${encodeURIComponent(id)}/seats`)
  assert.equal(writes.at(-1).body.revision.quantity, 3)
  assert.equal(writes.at(-1).body.revision.period, 'year')
  assert.equal(writes.at(-1).body.seat_rev, 's1')
  const next = container.querySelector('input[name="quantity"]').closest('form')
  await setField(container, 'Seats', '', next)
  await React.act(async () => next.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })))
  await flush(4)
  writes = transportCtl.calls.filter(call => call.method === 'PUT')
  assert.equal(writes.at(-1).body.revision.quantity, null)
  assert.equal(writes.at(-1).body.seat_rev, 's2')
})

test('seat comparison renders in Simplified Chinese', async () => {
  queryClient.clear(); transportCtl.reset()
  $testConnectionId.set('gateway-a'); $testProfile.set('default')
  const originalTranslate = i18nBackend.t
  i18nBackend.t = (key, ...args) => {
    const entry = T.I18N.zh[key]
    return typeof entry === 'function' ? entry(...args) : entry ?? key
  }
  try {
    const member = account('openai-codex:zh', { plan_id: 'business', plan: { name: 'Business', seat_pricing: {
      usual_minimum: 2, prices: { month: { amount: 125, currency: 'USD', period: 'month' } } } },
      fee: { basis: 'declared', effective: { amount: 330, currency: 'USD', period: 'month' },
        published: { amount: 125, currency: 'USD', per_seat: true },
        calculated: { amount: 375, currency: 'USD', period: 'month', unit_amount: 125, quantity: 3 } } })
    transportCtl.respond(call => call.path === '/membership/plans' ? plansOk()
      : { ok: true, accounts: [member], store: { loaded: true, error: '' }, notes: [] })
    const { container } = await boot(); await flush(3)
    assert.match(container.textContent, /席位数/)
    assert.match(container.textContent, /目录总价 \$375\.00/)
    assert.match(container.textContent, /\$330\.00/)
    assert.ok(container.querySelector('input[name="quantity"]'))
  } finally { i18nBackend.t = originalTranslate }
})

test('recovery clipboard includes raw seat history and membership documents', async () => {
  queryClient.clear(); transportCtl.reset()
  $testConnectionId.set('gateway-a'); $testProfile.set('default')
  const seatStore = { version: 1, accounts: { account: { family: 'test', identity: null, revisions: [
    { id: 's', plan_id: 'plan', quantity: 3, period: 'month', effective_from: '2026-01-01T00:00:00Z' }
  ] } } }
  const entitlementStore = { version: 1, routes: {} }
  const membershipStore = { version: 1, accounts: [{ id: 'account', family: 'test' }] }
  transportCtl.respond(call => call.path === '/membership/accounts'
    ? { ok: true, accounts: [account('account')], membership_store: membershipStore,
        seat_store: seatStore, entitlement_store: entitlementStore, store: {} }
    : call.path === '/budgets' ? { ok: true, version: 1, budgets: [], dismissals: {}, rev: 'fixture' }
    : call.path === '/membership/plans' ? plansOk()
      : { ok: true, profiles: [], loaded: true, error: '' })
  let copied = ''
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { copied = text } } })
  try {
    const container = document.createElement('div'); document.body.appendChild(container)
    const root = ReactDOMClient.createRoot(container); roots.push(root)
    await React.act(async () => root.render(React.createElement(QueryClientProvider, { client: queryClient }, React.createElement(T.SettingsPage))))
    await flush(3)
    await clickByText(container, 'Copy recovery backup before reset'); await flush(3)
    const bundle = JSON.parse(copied)
    assert.deepEqual(bundle.membership_store, membershipStore)
    assert.deepEqual(bundle.seat_history, seatStore)
    assert.deepEqual(bundle.route_entitlements, entitlementStore)
    assert.deepEqual(bundle.budget_guardrails.budgets, [])
    assert.equal(bundle.budget_guardrails.rev, 'fixture')
  } finally { delete navigator.clipboard }
})
