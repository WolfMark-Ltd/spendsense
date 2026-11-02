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
  plan_choices: [], excluded_plans: [], rev: 'r1', ...extra,
})

const roots = []
const boot = async () => {
  queryClient.clear()
  T.$membershipSnapshot.set(null)
  T.$membershipDraft.set(null)
  T.$membershipNotice.set(null)
  T.$membershipBusy.set(null)
  T.$membershipNative.set(false)
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
  await clickByText(container, 'Refresh readings')
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
  await clickByText(container, 'Refresh readings')
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

test('API Only persists, disables subscription controls and restores the saved subscription', async () => {
  $testConnectionId.set('gateway-a'); $testProfile.set('default'); transportCtl.reset()
  let saved = account('api', { label: 'Account A', plan_id: 'example.pro',
    plan_choices: [{ id: 'example.pro', name: 'Pro', price: { amount: 20, currency: 'USD', period: 'month' } }],
    fee: { basis: 'declared', effective: { amount: 17, currency: 'GBP', period: 'year' } } })
  transportCtl.respond(call => {
    if (call.path.startsWith('/membership/plans')) return plansOk()
    if (call.method === 'PUT') {
      saved = { ...call.body, effective_arrangement: call.body.api_only ? 'api_only' : 'subscription',
        fee: call.body.api_only ? { basis: 'api_only', effective: { amount: null } }
          : { basis: 'declared', effective: { amount: 17, currency: 'GBP', period: 'year' } } }
      return { ok: true, account: saved }
    }
    return { ok: true, accounts: [saved] }
  })
  const { container } = await boot(); await flush(3)
  const checkbox = container.querySelector('input[type="checkbox"]')
  await React.act(async () => checkbox.click()); await flush(4)
  assert.equal(saved.api_only, true)
  assert.equal(saved.plan_id, 'example.pro')
  assert.match(container.textContent, /API Only · no recurring membership fee/)
  const planSelect = [...container.querySelectorAll('label')].find(l => l.textContent.includes('Plan for this provider account')).querySelector('select')
  assert.equal(planSelect.disabled, true)
  assert.equal([...container.querySelectorAll('button')].find(b => b.textContent === 'Edit fee').disabled, true)
  await React.act(async () => checkbox.click()); await flush(4)
  assert.equal(saved.api_only, false)
  assert.equal(planSelect.disabled, false)
  assert.match(container.textContent, /£17.00\/yr/)
})

test('unconfirmed and prepaid accounts show their arrangements without subscription controls', async () => {
  $testConnectionId.set('gateway-a'); $testProfile.set('default'); transportCtl.reset()
  let saved = account('wallet', { billing_arrangement: 'unconfirmed', effective_arrangement: 'unconfirmed' })
  transportCtl.respond(call => {
    if (call.path.startsWith('/membership/plans')) return plansOk()
    if (call.method === 'PUT') {
      saved = { ...call.body, effective_arrangement: call.body.billing_arrangement }
      return { ok: true }
    }
    return { ok: true, accounts: [saved] }
  })
  const { container } = await boot(); await flush(3)
  const card = container.querySelector('[data-account="wallet"]')
  assert.match(card.textContent, /No confirmed billing arrangement/)
  assert.doesNotMatch(card.textContent, /Plan for this provider account/)
  const select = [...card.querySelectorAll('label')].find(l => l.textContent.includes('Billing arrangement')).querySelector('select')
  await React.act(async () => {
    select.value = 'prepaid'; select.dispatchEvent(new window.Event('change', { bubbles: true }))
  }); await flush(4)
  assert.equal(saved.billing_arrangement, 'prepaid')
  assert.match(card.textContent, /Prepaid credit account/)
  assert.doesNotMatch(card.textContent, /Plan for this provider account/)
  assert.doesNotMatch(card.textContent, /Edit fee/)
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
  await clickByText(container, 'Refresh readings'); await flush(3)
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
  assert.match(container.textContent, /Spend Sense makes no direct HTTP pricing requests/)
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
  assert.deepEqual(T.settledDesktopMonth(T.emptyLedger()), { known: false, cost: 0, pricedTokens: 0 })
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
  assert.match(container.textContent, /Recorded usage/)
  assert.match(container.querySelector('.wm-product-summary').textContent, /\$0\.42/)
  assert.match(container.textContent, /API-equivalent/)
  assert.match(container.textContent, /Membership fees/)
  const summary = container.querySelector('.wm-product-summary')
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
  await React.act(async () => T.$ledger.set(T.emptyLedger()))
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
  await clickByText(rows[0], 'Open Memberships')
  assert.equal(T.$ledgerTab.get(), 'memberships')
  T.$ledgerTab.set('overview'); await flush(3)
  assert.match(rows[1].textContent, /Usage pricing/)
  await clickByText(rows[1], 'Open Usage')
  assert.equal(T.$ledgerTab.get(), 'usage')
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
  // the content shell in exactly the same place on all six tabs.
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
    assert.equal(container.querySelectorAll('[role="tab"]').length, 6, `${tab} shows all six tabs`)
    // LedgerTabs brings its own shell wrapper, so the pin is structural: the
    // tab shell must be a direct child of the page root — a sibling of the
    // content shell, never nested inside it. Compare booleans only: handing
    // live DOM nodes to assert hangs the runner while it serialises them.
    const pageRoot = container.firstElementChild
    const tablist = container.querySelector('[role="tablist"]')
    assert.ok(tablist, `${tab} renders the tab bar`)
    const tabShell = tablist.closest('.wm-shell')
    assert.ok(tabShell && [...pageRoot.children].includes(tabShell),
      `${tab} keeps the tab bar as a top-level sibling of the content shell`)
    assert.ok([...container.querySelectorAll('.wm-shell')]
      .every(shell => shell === tabShell || !shell.contains(tablist)),
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

test('toggling API Only sends the card revision and confirms the save', async () => {
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
  const label = container.querySelector('label.wm-check')
  assert.ok(label, 'the API Only control is a checkbox row, not a stacked filter caption')
  const box = label.querySelector('input[type="checkbox"]')
  assert.ok(box)
  assert.equal(box.checked, false)
  assert.equal(label.textContent.trim(), 'API Only')
  await React.act(async () => { box.click() })
  await flush(6)
  const write = transportCtl.calls.find(call => call.method === 'PUT')
  assert.ok(write, 'toggling sends a PUT')
  assert.equal(write.body.api_only, true)
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
  const box = container.querySelector('label.wm-check input[type="checkbox"]')
  assert.ok(box, 'the card renders even without a revision')
  await React.act(async () => { box.click() })
  await flush(3)
  assert.equal(transportCtl.calls.some(call => call.method === 'PUT'), false,
    'no doomed PUT is sent for an unversioned record')
  assert.match(text(), /has no revision/, 'the notice names the real problem, not a reload loop')
  // The guard is an opener-allowlist, so a different write kind is refused too.
  await setField(container, 'Billing arrangement', 'prepaid')
  await flush(3)
  assert.equal(transportCtl.calls.some(call => call.method === 'PUT'), false,
    'a second write kind is refused without a revision')
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
