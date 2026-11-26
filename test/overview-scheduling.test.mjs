// Overview progressive backend scheduling, rendered browserlessly.
//
// The Overview mounts one cheap local read (ledger) plus two heavy backend
// aggregations over the same call store. The single connection serves one
// heavy aggregation at a time, so the page must fire economics only after
// the days=30 analytics settles (data or error) — never both at once —
// while ledger-backed cards render immediately. A failed analytics read
// must not wedge economics: degraded-but-complete beats a blank page.
//
// Setup once: npm ci --prefix test/harness
// Run with:   bash scripts/node-tests.sh browserless overview-scheduling.test.mjs
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { loadPageHarness, translatorFor } from './render-harness.mjs'
import { overviewAnalytics, overviewLedgerDays, overviewTransport } from './overview-fixtures.mjs'

const harness = await loadPageHarness()
const { T, React, ReactDOMClient, QueryClientProvider, queryClient, i18nBackend, plugin, dom, flush } = harness

const requested = []
let analyticsGate = null
const base = overviewTransport({ requiredContract: T.REQUIRED_BACKEND_CONTRACT })

plugin.register({
  rest: async path => {
    requested.push(path)
    if (path === '/analytics?days=30' && analyticsGate) return analyticsGate.promise
    return base(path)
  },
  storage: { get: (_key, fallback) => fallback, set() {}, delete() {} },
  register() {}, registerMany() {}, onDispose() {}, onEvent: () => () => {},
  setTimeout: fn => { const timer = setTimeout(fn, 0); return () => clearTimeout(timer) },
  setInterval: () => () => {}, addEventListener: () => () => {},
  os: {}, pet: null, i18n: { register() {}, t: key => key },
})

const roots = []
const boot = async () => {
  while (roots.length) {
    const previous = roots.pop()
    try { await React.act(async () => { previous.unmount() }) } catch { /* already gone */ }
  }
  queryClient.clear()
  requested.length = 0
  T.$ledgerTab.set('overview')
  T.$infoOpen.set(null)
  T.$ledger.set({ ...T.emptyLedger(), days: overviewLedgerDays() })
  i18nBackend.t = translatorFor(T.I18N, 'en')
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
  analyticsGate = null
  while (roots.length) {
    const root = roots.pop()
    try { await React.act(async () => { root.unmount() }) } catch { /* already gone */ }
  }
  queryClient.clear()
})

const defer = () => {
  let resolve, reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  promise.catch(() => {})
  return { promise, resolve, reject }
}

test('economics waits for the days=30 analytics to settle', async () => {
  analyticsGate = defer()
  await boot()
  assert.ok(requested.includes('/analytics?days=30'), `analytics fires on mount (${requested})`)
  assert.ok(!requested.some(p => p.startsWith('/economics/summary')),
    `economics must not fire before analytics settles (${requested})`)
  await React.act(async () => {
    analyticsGate.resolve(overviewAnalytics({}))
    await flush()
  })
  assert.ok(requested.some(p => p.startsWith('/economics/summary')),
    `economics fires once analytics settles (${requested})`)
})

test('remount within the stale window refetches nothing', async () => {
  // Fresh cache served synchronously: reopening with warm data must not
  // touch the backend at all (neither analytics nor economics refires).
  await boot()
  const heavy = p => p === '/analytics?days=30' || p.startsWith('/economics/summary')
  assert.ok(requested.filter(heavy).length >= 2, `initial mount fetches both (${requested})`)
  requested.length = 0
  // Remount WITHOUT clearing the query cache (unlike boot()).
  while (roots.length) {
    const previous = roots.pop()
    try { await React.act(async () => { previous.unmount() }) } catch { /* already gone */ }
  }
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = ReactDOMClient.createRoot(container)
  roots.push(root)
  await React.act(async () => {
    root.render(React.createElement(QueryClientProvider, { client: queryClient },
      React.createElement(T.OverviewPage)))
  })
  await flush()
  assert.deepEqual(requested.filter(heavy), [],
    `remount with fresh cache refetches nothing (${requested})`)
  assert.ok(container.textContent.length > 0)
})

test('a new identity re-applies the stagger from scratch', async () => {
  // Identity churn resets both queries to new keys; economics must again
  // wait for the fresh analytics fetch, exactly like a cold mount.
  await boot()
  requested.length = 0
  analyticsGate = defer()
  analyticsGate.promise.catch(() => {})
  await React.act(async () => {
    T.$scopeConnection.set('reconnected-gateway')
    await flush()
  })
  assert.ok(requested.includes('/analytics?days=30'),
    `fresh analytics fetch starts under the new identity (${requested})`)
  assert.ok(!requested.some(p => p.startsWith('/economics/summary')),
    `economics waits for analytics under the new identity (${requested})`)
  await React.act(async () => {
    analyticsGate.resolve(overviewAnalytics({}))
    await flush()
  })
  assert.ok(requested.some(p => p.startsWith('/economics/summary')),
    `economics fires once fresh analytics settles (${requested})`)
  await React.act(async () => { T.$scopeConnection.set('local') })
})

test('the wait predicate covers every analytics query state', () => {
  const { shouldWaitForAnalytics } = T
  // Absent query (pages that never mount Overview): proceed.
  assert.equal(shouldWaitForAnalytics(null), false)
  assert.equal(shouldWaitForAnalytics(undefined), false)
  // Pre-fetch and active fetch: wait.
  assert.equal(shouldWaitForAnalytics({ status: 'pending', fetchStatus: 'idle' }), true)
  assert.equal(shouldWaitForAnalytics({ status: 'pending', fetchStatus: 'fetching' }), true)
  assert.equal(shouldWaitForAnalytics({ status: 'success', fetchStatus: 'fetching' }), true)
  // Settled, failed, or paused (offline — waiting cannot help): proceed.
  assert.equal(shouldWaitForAnalytics({ status: 'success', fetchStatus: 'idle' }), false)
  assert.equal(shouldWaitForAnalytics({ status: 'error', fetchStatus: 'idle' }), false)
  assert.equal(shouldWaitForAnalytics({ status: 'pending', fetchStatus: 'paused' }), false)
  assert.equal(shouldWaitForAnalytics({ status: 'success', fetchStatus: 'paused' }), false)
})

test('a background analytics refresh still finishes before economics refires', async () => {
  // The stale-cache reopen scenario: both queries hold settled data, an
  // invalidation starts a background analytics refresh, and economics
  // must not dispatch until that refresh settles — no parallel burst.
  await boot()
  const heavy = p => p === '/analytics?days=30' || p.startsWith('/economics/summary')
  assert.ok(requested.filter(heavy).length >= 2, `initial mount fetches both (${requested})`)
  requested.length = 0
  analyticsGate = defer()
  analyticsGate.promise.catch(() => {})
  // NOTE: invalidateQueries only resolves once triggered refetches settle,
  // so it must not be awaited while the analytics refresh is gated.
  let invalidated
  await React.act(async () => {
    invalidated = queryClient.invalidateQueries({ queryKey: ['spend-sense'] })
    invalidated.catch(() => {})
    await flush()
  })
  assert.ok(requested.includes('/analytics?days=30'),
    `analytics refresh starts (${requested})`)
  assert.ok(!requested.some(p => p.startsWith('/economics/summary')),
    `economics waits for the active refresh (${requested})`)
  await React.act(async () => {
    analyticsGate.resolve(overviewAnalytics({}))
    await invalidated
    await flush()
  })
  assert.ok(requested.some(p => p.startsWith('/economics/summary')),
    `economics refires once the refresh settles (${requested})`)
})

test('economics still fires when analytics fails', async () => {
  // Immediate failures (both the attempt and its one retry): the error
  // state must still release economics (degraded-but-complete). The retry
  // backoff is real time, so poll with a deadline rather than flushing.
  analyticsGate = defer()
  analyticsGate.promise.catch(() => {})
  analyticsGate.reject(new Error('boom'))
  const container = await boot()
  assert.ok(requested.includes('/analytics?days=30'))
  const deadline = Date.now() + 10000
  while (!requested.some(p => p.startsWith('/economics/summary'))) {
    assert.ok(Date.now() < deadline, `economics fires after analytics fails (${requested})`)
    await React.act(async () => {
      await new Promise(resolve => setTimeout(resolve, 100))
    })
  }
  assert.ok(container.textContent.length > 0)
})
