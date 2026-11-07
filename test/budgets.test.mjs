// Real React + Query rendering; no profile, gateway, provider or network access.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, after, mock } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const modules = join(ROOT, 'test/harness/node_modules')
const temp = mkdtempSync(join(tmpdir(), 'wm-budgets-'))
process.on('exit', () => rmSync(temp, { recursive: true, force: true }))
const sdk = join(temp, 'sdk.mjs')
writeFileSync(sdk, readFileSync(join(ROOT, 'test/harness/real-sdk.mjs'), 'utf8')
  .replace('export const Tip = noop', "export const Tip = ({ children, label }) => jsx('span', { title: label, children })"))
const entry = join(temp, 'entry.mjs')
writeFileSync(entry, `export { default as plugin, __test as T } from '${ROOT}/desktop/plugin.js'
export * as React from 'react'
export * as ReactDOMClient from 'react-dom/client'
export { QueryClientProvider, queryClient, host, $testConnectionId, $testProfile, __bumpActivation, i18nBackend } from '@hermes/plugin-sdk'`)
const esbuild = (await import(pathToFileURL(join(modules, 'esbuild/lib/main.js')))).default
await esbuild.build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', outfile: join(temp, 'bundle.mjs'),
  alias: { '@hermes/plugin-sdk': sdk, react: join(modules, 'react'), 'react-dom': join(modules, 'react-dom') }, nodePaths: [modules], logLevel: 'warning' })
const { JSDOM } = await import(pathToFileURL(join(modules, 'jsdom/lib/api.js')))
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' })
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'Event', 'MouseEvent'])
  Object.defineProperty(globalThis, key, { value: key === 'window' ? dom.window : dom.window[key], configurable: true, writable: true })
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const { plugin, T, React, ReactDOMClient, QueryClientProvider, queryClient, host, $testConnectionId, $testProfile, __bumpActivation, i18nBackend } = await import(pathToFileURL(join(temp, 'bundle.mjs')))
let language = 'en'
const t = (key, ...args) => typeof T.I18N[language][key] === 'function' ? T.I18N[language][key](...args) : T.I18N[language][key] ?? key
i18nBackend.t = t
const b = (extra = {}) => ({ id: 'session', label: 'Session estimate', amount: 1, currency: 'USD', enabled: true, scope: 'session',
  measurement: 'api_equivalent', provider: '', model: '', thresholds: [50, 80, 100], cycle_day: 1, timezone: 'UTC', ...extra })
let payload, requestError, requests = []
let responder
const events = new Map(), intervals = []
plugin.register({
  rest: async (path, options = {}) => {
    requests.push({ path, ...options })
    if (responder) return responder(path, options)
    if (requestError) throw requestError
    return payload
  }, storage: { get: (_key, fallback) => fallback, set() {}, delete() {} }, register() {}, onDispose() {},
  onEvent(name, fn) { events.set(name, fn) }, setInterval(fn, ms) { intervals.push({ fn, ms }) }, i18n: { register() {} }, os: {}
})
let roots = []
const flush = () => React.act(async () => { for (let i = 0; i < 4; i++) await new Promise(r => setTimeout(r, 0)) })
const reset = async () => {
  for (const root of roots) await React.act(async () => root.unmount())
  roots = []; document.body.innerHTML = ''; queryClient.clear(); requestError = null; responder = null; requests = []; language = 'en'
  await React.act(async () => {
    $testConnectionId.set('gateway-a'); $testProfile.set('default'); T.$ledger.set(T.emptyLedger())
    host.state.focusedSessionId.set(null); host.state.focusedStoredSessionId.set(null); host.state.focusedUsage.set(null)
    T.$budgetDraft.set(null); T.$budgetNotice.set(null); T.$budgetBusy.set(null)
  })
  payload = { ok: true, budgets: [b()], statuses: [], rev: 'r1' }
}
after(async () => { await reset(); queryClient.clear() })
const mount = async (Component, props = {}) => {
  const el = document.createElement('div'); document.body.appendChild(el)
  const root = ReactDOMClient.createRoot(el); roots.push(root)
  await React.act(async () => root.render(React.createElement(QueryClientProvider, { client: queryClient }, React.createElement(Component, props))))
  await flush(); return el
}
const modelPayload = { model: 'gpt-5', provider: 'openai', providers: [{ slug: 'openai', pricing: { 'gpt-5': { input: '1', output: '1', cache: '1', tiers: [] } } }] }
async function usage(input, cost = 99) {
  await React.act(async () => {
    const next = T.applyUsage(T.$ledger.get(), { now: Date.now(), model: 'gpt-5', provider: 'openai', payload: modelPayload,
      profile: 'default', sessionId: 'runtime', storedId: 'conversation', usage: { model: 'gpt-5', input, output: 0, calls: 1, cost_usd: cost } })
    T.$ledger.set(next)
    host.state.focusedSessionId.set('runtime'); host.state.focusedStoredSessionId.set('conversation')
    host.state.focusedUsage.set({ model: 'gpt-5', input, output: 0, calls: 1, cost_usd: cost })
  })
  await flush()
}

test('catalogue estimates remain independent of gateway cost and survive usage deltas', async () => {
  await reset(); await usage(500000)
  const bucket = T.$ledger.get().sessions.conversation
  assert.equal(bucket.cost, 99)
  assert.equal(bucket.usageValueCost, .5)
  assert.equal(bucket.usageValueMissing, 0)
  await usage(800000, 100)
  assert.equal(T.$ledger.get().sessions.conversation.usageValueCost, .8)
})

test('actual Chip updates informational, amber and red on live session activity', async () => {
  await reset(); await usage(400000)
  const el = await mount(T.Chip)
  let amount = () => el.querySelector('[data-session-budget]')
  assert.equal(amount().dataset.sessionBudget, 'normal')
  assert.equal(amount().textContent, '≈' + T.fmtUsd(.4))
  await usage(500000)
  assert.equal(amount().dataset.sessionBudget, 'info')
  await usage(800000)
  assert.equal(amount().dataset.sessionBudget, 'warning')
  assert.equal(amount().style.color, 'var(--ui-warning)')
  assert.match(amount().getAttribute('aria-label'), /Estimated usage value · not billed/)
  assert.match(amount().getAttribute('aria-label'), /80%/)
  await usage(1000000)
  assert.equal(amount().dataset.sessionBudget, 'exceeded')
  assert.equal(amount().style.color, 'var(--ui-error)')
  assert.equal(amount().textContent, '≈' + T.fmtUsd(1))
  assert.match(el.querySelector('[title]').title, /conversation/i)
  assert.equal(el.querySelectorAll('button').length, 1)
})

test('legacy, unpriced, unknown-rate and cross-gateway activity never become complete estimates', async () => {
  await reset()
  const delta = { input: 100, output: 0, cacheRead: 0, cacheWrite: 0 }
  const good = T.resolveRates({ model: 'gpt-5', provider: 'openai', payload: modelPayload })
  const legacy = { input: 100, output: 0, cacheRead: 0, cacheWrite: 0, cost: 400 }
  const computed = T.usageValueDelta(legacy, delta, good)
  assert.equal(computed.usageValueMissing, 100)
  assert.equal(computed.usageValueCost, .0001)
  for (const resolved of [{ ...good, origin: 'fallback' }, { ...good, rates: { ...good.rates, usageInputKnown: false } }, { origin: 'none', rates: null }]) {
    const result = T.usageValueDelta(null, delta, resolved)
    assert.equal(result.usageValuePriced, 0)
    assert.equal(result.usageValueMissing, 100)
  }
  await usage(800000)
  const live = { guardrailValue: T.$ledger.get().sessions.conversation }
  assert.equal(T.sessionBudgetStatus(live, [b()]).level, 'warning')
  await React.act(async () => $testConnectionId.set('gateway-b'))
  assert.equal(T.sessionBudgetStatus(live, [b()]).level, 'unavailable')
})

test('partial estimates prove reached thresholds but cannot claim within limit', async () => {
  await reset(); await usage(800000)
  const bucket = { ...T.$ledger.get().sessions.conversation, usageValueMissing: 1000 }
  assert.equal(T.sessionBudgetStatus({ guardrailValue: bucket }, [b()]).level, 'warning')
  assert.equal(T.sessionBudgetStatus({ guardrailValue: bucket }, [b({ amount: 10 })]).level, 'unavailable')
  assert.equal(T.sessionBudgetStatus({ guardrailValue: bucket }, [b({ enabled: false })]), null)
})

test('failed refresh keeps content and neutralises session and monthly warning colours', async () => {
  await reset(); await usage(800000)
  payload.budgets.push(b({ id: 'monthly', scope: 'total' }))
  payload.statuses = [{ id: 'monthly', budget: payload.budgets[1], spend: 1, percentage: 100, complete: true, level: 'exceeded' }]
  const el = await mount(T.Chip)
  assert.equal(el.querySelector('[data-budget-monthly]').dataset.budgetMonthly, 'exceeded')
  requestError = new Error('offline')
  await React.act(async () => { await queryClient.invalidateQueries({ queryKey: ['spend-sense', 'budget-status'] }) }); await flush()
  assert.equal(el.querySelector('[data-session-budget]').dataset.sessionBudget, 'unavailable')
  assert.equal(el.querySelector('[data-budget-monthly]').dataset.budgetMonthly, 'unavailable')
  assert.match(el.textContent, /Budget/)
  assert.equal(el.querySelector('[data-session-budget]').textContent, '≈' + T.fmtUsd(.8))
})

test('budget management renders labelled modes and sends a revision-checked create', async () => {
  await reset(); payload.budgets = []
  const el = await mount(T.BudgetPanel, { manage: true })
  assert.match(el.textContent, /Choose a monthly/)
  await React.act(async () => [...el.querySelectorAll('button')].find(x => x.textContent === 'Add limit').click())
  assert.ok(el.querySelector('form'))
  const draft = T.$budgetDraft.get()
  await React.act(async () => T.$budgetDraft.set({ ...draft, label: 'My cap', amount: '5' }))
  assert.match(el.textContent, /Actual metered spending/)
  responder = (path, options) => {
    if (options.method === 'PUT') return { ok: true }
    return payload
  }
  await React.act(async () => el.querySelector('form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }))); await flush()
  const put = requests.find(x => x.method === 'PUT')
  assert.ok(put.path.includes('?if_rev=r1'))
  assert.equal(put.body.measurement, 'api_equivalent')
  assert.equal(put.body.amount, 5)
  assert.equal(el.querySelector('form'), null)
})

test('dismissal, delete and edit use identity-scoped revision writes', async () => {
  await reset()
  const monthly = b({ id: 'monthly', scope: 'total' })
  payload = { ok: true, budgets: [monthly], rev: 'current', statuses: [{ id: 'monthly', budget: monthly,
    level: 'warning', complete: true, spend: .8, percentage: 80, budget_rev: 'budget-r1', cycle: { id: 'cycle', start: '2026-11-01', end: '2026-12-01' },
    coverage: { calls: 4, measured_calls: 4 }, forecast: { available: false, reason: 'insufficient_days' } }] }
  const el = await mount(T.BudgetPanel, { manage: true, forecasts: true })
  const click = async text => { await React.act(async () => [...el.querySelectorAll('button')].find(b => b.textContent === text).click()); await flush() }
  await click('Dismiss for this cycle')
  assert.deepEqual(requests.find(r => r.method === 'POST').body, { cycle: 'cycle', budget_rev: 'budget-r1', level: 'warning' })
  await click('Edit')
  assert.equal(T.$budgetDraft.get().rev, 'current')
  await click('Cancel')
  await click('Delete')
  assert.match(requests.find(r => r.method === 'DELETE').path, /if_rev=current/)
})

test('both languages cover all guardrail states and render refusal explanations', async () => {
  await reset(); language = 'zh'
  const enKeys = Object.keys(T.I18N.en).filter(k => k.startsWith('budget'))
  assert.ok(enKeys.length > 50)
  assert.deepEqual(enKeys.sort(), Object.keys(T.I18N.zh).filter(k => k.startsWith('budget')).sort())
  const monthly = b({ scope: 'total', measurement: 'actual_metered' })
  payload = { ok: true, budgets: [monthly], rev: 'r', statuses: [{ id: monthly.id, budget: monthly,
    level: 'unavailable', complete: false, spend: null, cycle: {}, coverage: { calls: 3, measured_calls: 0 },
    forecast: { available: false, reason: 'metered_unavailable' } }] }
  const el = await mount(T.BudgetPanel, { forecasts: true })
  assert.match(el.textContent, /实际计量支出/)
  assert.match(el.textContent, /逐次账单费用/)
  assert.doesNotMatch(el.textContent, /budget[A-Z_]/)
})

test('Chip polls budget status after 15 seconds without session activity', async () => {
  await reset()
  assert.equal(T.budgetQuery().refetchInterval, 15_000)
  const monthly = b({ id: 'monthly', scope: 'total' })
  payload = { ok: true, rev: 'r1', budgets: [monthly], statuses: [{ id: monthly.id, budget: monthly,
    level: 'normal', complete: true, spend: 0, percentage: 0, budget_rev: 'budget-r1', cycle: {},
    coverage: { calls: 0, measured_calls: 0 }, forecast: { available: false, reason: 'insufficient_days' } }] }
  mock.timers.enable({ apis: ['Date', 'setInterval'] })
  try {
    await mount(T.Chip)
    const count = () => requests.filter(r => r.path === '/budgets/status').length
    assert.equal(count(), 1)
    assert.equal(events.has('session.usage'), true)
    mock.timers.tick(14_999)
    await flush()
    assert.equal(count(), 1)
    await React.act(async () => {
      mock.timers.tick(1)
      for (let i = 0; i < 5; i++) await Promise.resolve()
    })
    await flush()
    assert.equal(count(), 2)
  } finally {
    mock.timers.reset()
  }
})

test('session activity invalidates budget queries on the bounded refresh timer', async () => {
  await reset()
  const timer = intervals.find(x => x.ms === 2000)
  assert.ok(timer)
  assert.ok(events.has('session.usage'))
  await React.act(async () => events.get('session.usage')({ session_id: 'runtime', payload: { usage: { input: 1, model: 'gpt-5' } } }))
  let invalidations = 0
  const original = queryClient.invalidateQueries
  queryClient.invalidateQueries = async () => { invalidations++ }
  try { timer.fn(); timer.fn(); assert.equal(invalidations, 1) } finally { queryClient.invalidateQueries = original }
})

test('a pending budget read cannot bring another connection’s warnings into view', async () => {
  await reset()
  let resolveOld
  const old = new Promise(resolve => { resolveOld = resolve })
  responder = () => old
  const el = await mount(T.BudgetPanel, { manage: true })
  responder = () => ({ ok: true, rev: 'b', budgets: [], statuses: [] })
  await React.act(async () => $testConnectionId.set('gateway-b')); await flush()
  resolveOld({ ok: true, budgets: [b({ label: 'Wrong connection limit' })], statuses: [], rev: 'a' }); await flush()
  assert.doesNotMatch(el.textContent, /Wrong connection limit/)
  assert.match(el.textContent, /Choose a monthly/)
})

test('session estimates for a different owner profile stay unavailable', async () => {
  await reset()
  await React.act(async () => {
    T.$ledger.set(T.applyUsage(T.emptyLedger(), { provider: 'openai', payload: modelPayload, profile: 'other-profile',
      sessionId: 'runtime', storedId: 'conversation', usage: { model: 'gpt-5', input: 1000000, calls: 1 } }))
  })
  const status = T.sessionBudgetStatus({ guardrailValue: T.$ledger.get().sessions.conversation }, [b()])
  assert.equal(status.level, 'unavailable')
  assert.equal(status.spend, null)
})

test('activity written by an older version stays uncovered after upgrade', async () => {
  await reset(); await usage(400000)
  const led = T.$ledger.get()
  // Old writers retain additive fields but do not advance their coverage.
  led.sessions.conversation.input += 300000
  led.snapshots.runtime.input += 300000
  led.snapshots.runtime.counterInput += 300000
  led.snapshots.runtime.counterPrompt += 300000
  const prior = T.sessionBudgetStatus({ guardrailValue: led.sessions.conversation }, [b()])
  assert.equal(prior.level, 'unavailable')
  assert.equal(prior.partial, true)
  await usage(800000)
  const current = T.$ledger.get()
  assert.equal(current.sessions.conversation.usageValueMissing, 300000)
  assert.equal(current.snapshots.runtime.guardrail.usageValueMissing, 300000)
  assert.equal(current.sessions.conversation.usageValueCost, .5)
})

test('subscription OAuth routes can use their own catalogue value without a billed charge', async () => {
  await reset()
  const model = 'gpt-5', provider = 'openai-codex'
  const payload = { model, provider, providers: [{ slug: provider, pricing: {} }] }
  const led = T.applyUsage(T.emptyLedger(), { provider, payload, profile: 'default', sessionId: 'runtime', storedId: 'conversation',
    usage: { model, input: 400000, output: 0, calls: 1, cost_usd: 0 } })
  const bucket = led.sessions.conversation
  assert.equal(bucket.usageValueCost, .5)
  assert.equal(bucket.usageValueMissing, 0)
  assert.equal(T.sessionBudgetStatus({ guardrailValue: bucket }, [b()]).level, 'info')
})

// PR #32 review regressions: reproduce before changing accounting.
const reviewedApply = (led, usage, pricing = { input: '1', output: '1', cache: '.1', cache_write: '2', tiers: [] }, extra = {}) =>
  T.applyUsage(led, { now: Date.now(), profile: 'default', provider: 'review-provider', sessionId: 'review-run', storedId: 'review-conversation',
    payload: { model: 'review-model', provider: 'review-provider', providers: [{ slug: 'review-provider', pricing: { 'review-model': pricing } }] },
    usage: { model: 'review-model', ...usage }, ...extra })
const reviewedStatus = led => T.sessionBudgetStatus({ guardrailValue: led.sessions['review-conversation'] }, [b()])

test('review: an unknown zero-token call makes a previously measured conversation partial', async () => {
  await reset()
  let led = reviewedApply(T.emptyLedger(), { input: 100000, output: 0, calls: 1 })
  assert.equal(reviewedStatus(led).level, 'normal')
  led = reviewedApply(led, { input: 100000, output: 0, calls: 2 })
  assert.equal(reviewedStatus(led).partial, true)
  assert.equal(reviewedStatus(led).level, 'unavailable')
  assert.equal(led.sessions['review-conversation'].usageValueMissingCalls, 1)
  assert.equal(led.snapshots['review-run'].guardrail.usageValueMissingCalls, 1)
})

test('review: missing output usage cannot be converted into a measured zero', async () => {
  await reset()
  const led = reviewedApply(T.emptyLedger(), { input: 100000, calls: 1 })
  assert.equal(reviewedStatus(led).partial, true)
  assert.equal(reviewedStatus(led).level, 'unavailable')
})

test('review: unresolved live context tiers cover neither input nor output-only deltas', async () => {
  await reset()
  const pricing = { input: '1', output: '1', cache: '.1', cache_write: '2', tiers: [{ threshold: 100000, input: '2', output: '4' }] }
  for (const usage of [{ input: 200000, output: 0, calls: 1 }, { input: 0, output: 200000, calls: 1 }]) {
    const led = reviewedApply(T.emptyLedger(), usage, pricing)
    assert.equal(led.sessions['review-conversation'].usageValuePriced, 0)
    assert.equal(reviewedStatus(led).level, 'unavailable')
  }
})

test('review: remembered live prices preserve unresolved tier restrictions', async () => {
  await reset()
  let led = reviewedApply(T.emptyLedger(), { input: 100000, output: 0, calls: 1 }, { input: '1', output: '1', tiers: [{ threshold: 1 }] })
  led = reviewedApply(led, { input: 200000, output: 0, calls: 2 }, null)
  assert.equal(led.sessions['review-conversation'].usageValuePriced, 0)
  assert.equal(reviewedStatus(led).level, 'unavailable')
})

test('review: missing cache read or write prices never cause a false exceeded warning', async () => {
  await reset()
  for (const [usage, prices] of [
    [{ input: 1000, output: 0, cache_read: 2000000, cache_write: 0, calls: 1 }, { input: '1', output: '1', tiers: [] }],
    [{ input: 1000, output: 0, cache_read: 0, cache_write: 2000000, calls: 1 }, { input: '1', output: '1', cache: '.1', tiers: [] }]
  ]) {
    const led = reviewedApply(T.emptyLedger(), usage, prices)
    assert.equal(led.sessions['review-conversation'].usageValuePriced, 0)
    assert.equal(reviewedStatus(led).level, 'unavailable')
  }
})

test('review: bundled context-tier models cannot look completely priced at base rates', async () => {
  await reset()
  const model = 'deep-research-max-preview-04-2026', provider = 'google'
  const led = T.applyUsage(T.emptyLedger(), { sessionId: 'review-run', storedId: 'review-conversation', profile: 'default', provider,
    payload: { model, provider, providers: [] }, usage: { model, input: 300000, output: 0, calls: 1 } })
  assert.equal(led.sessions['review-conversation'].usageValuePriced, 0)
  assert.equal(reviewedStatus(led).level, 'unavailable')
})

test('review: explicit zero and positive cache prices remain fully supported', async () => {
  await reset()
  for (const [read, write] of [['0', '0'], ['.1', '2']]) {
    const led = reviewedApply(T.emptyLedger(), { input: 100000, output: 0, cache_read: 10000, cache_write: 10000, calls: 1 },
      { input: '1', output: '1', cache: read, cache_write: write, tiers: [] })
    assert.equal(reviewedStatus(led).partial, false)
    assert.equal(reviewedStatus(led).level, 'normal')
    assert.equal(led.sessions['review-conversation'].usageValuePriced, 120000)
  }
})

test('review: late usage completes only its current missing call, including a zero-output final frame', async () => {
  await reset()
  let led = reviewedApply(T.emptyLedger(), { input: 100000, output: 0, calls: 1 })
  led = reviewedApply(led, { input: 100000, output: 0, calls: 2 })
  assert.equal(reviewedStatus(led).partial, true)
  led = reviewedApply(led, { input: 200000, output: 0, calls: 2 })
  assert.equal(reviewedStatus(led).partial, false)
  assert.equal(led.sessions['review-conversation'].usageValueMissingCalls, 0)
  assert.equal(led.snapshots['review-run'].guardrail.usageValueMissingCalls, 0)
  led = reviewedApply(led, { input: 300000, calls: 3 })
  assert.equal(reviewedStatus(led).partial, true)
  led = reviewedApply(led, { input: 300000, output: 0, calls: 3 })
  assert.equal(reviewedStatus(led).partial, false, 'explicit final zero output completes reported input usage')
})

test('review: later calls and restarts cannot erase earlier missing usage, but real subtotal warnings survive', async () => {
  await reset()
  let led = reviewedApply(T.emptyLedger(), { input: 800000, output: 0, calls: 1, cost_usd: 500 })
  led = reviewedApply(led, { input: 800000, output: 0, calls: 2, cost_usd: 501 })
  led = reviewedApply(led, { input: 810000, output: 0, calls: 3 })
  assert.equal(reviewedStatus(led).level, 'warning')
  assert.equal(reviewedStatus(led).partial, true)
  assert.equal(led.sessions['review-conversation'].usageValueMissingCalls, 1)
  led = reviewedApply(led, { input: 10000, output: 0, calls: 1 })
  assert.equal(led.snapshots['review-run'].guardrail.usageValueMissingCalls, 0)
  assert.equal(led.sessions['review-conversation'].usageValueMissingCalls, 1)
  assert.equal(reviewedStatus(led).level, 'warning')
})

test('review: partial cache and tier evidence cannot contaminate a previously proved warning', async () => {
  await reset()
  for (const prices of [{ input: '20', output: '1', tiers: [] }, { input: '20', output: '1', cache: '10', tiers: [{}] }]) {
    let led = reviewedApply(T.emptyLedger(), { input: 800000, output: 0, calls: 1 })
    led = reviewedApply(led, { input: 900000, output: 0, cache_read: 1000000, cache_write: 0, calls: 2 }, prices)
    assert.equal(led.sessions['review-conversation'].usageValueCost, .8)
    assert.equal(reviewedStatus(led).level, 'warning')
    assert.equal(reviewedStatus(led).partial, true)
  }
})

test('review: old tallies without trustworthy pricing provenance cannot prove coverage or warnings', async () => {
  await reset()
  let led = reviewedApply(T.emptyLedger(), { input: 100000, output: 0, calls: 1 })
  const bucket = led.sessions['review-conversation']
  delete bucket.usageValueVersion
  bucket.usageValueCost = 999
  assert.equal(reviewedStatus(led).level, 'unavailable')
  led = reviewedApply(led, { input: 200000, output: 0, calls: 2 })
  assert.equal(led.sessions['review-conversation'].usageValueCost, .1)
  assert.equal(reviewedStatus(led).level, 'unavailable')
  assert.equal(reviewedStatus(led).partial, true)
})

test('review: a restarted run can complete its own pending usage without inheriting the old counter baseline', async () => {
  await reset()
  let led = reviewedApply(T.emptyLedger(), { input: 500000, output: 0, calls: 2 })
  led = reviewedApply(led, { input: 10000, calls: 1 })
  led = reviewedApply(led, { input: 10000, output: 0, calls: 1 })
  assert.equal(led.snapshots['review-run'].guardrail.usageValueMissingCalls, 0)
  assert.equal(led.sessions['review-conversation'].usageValueMissingCalls, 1, 'older coalesced-call gap remains incomplete')
})

test('review: bundled explicit cache prices and remembered flat rates stay usable', async () => {
  await reset()
  const model = 'claude-opus-5', provider = 'github-copilot'
  const led = T.applyUsage(T.emptyLedger(), { sessionId: 'review-run', storedId: 'review-conversation', profile: 'default', provider,
    payload: { model, provider, providers: [] }, usage: { model, input: 10000, output: 0, cache_read: 10000, cache_write: 10000, calls: 1 } })
  assert.equal(reviewedStatus(led).partial, false)
  assert.equal(led.sessions['review-conversation'].usageValuePriced, 30000)
  assert.ok(Math.abs(led.sessions['review-conversation'].usageValueCost - .1175) < 1e-9)
  let flat = reviewedApply(T.emptyLedger(), { input: 100000, output: 0, calls: 1 })
  const remembered = flat.rates['review-provider|review-model']
  assert.equal(remembered.usagePriceSource, 'live_catalogue')
  assert.equal(remembered.usageCacheKnown, true)
  assert.equal(remembered.usageWriteKnown, true)
  flat = reviewedApply(flat, { input: 200000, output: 0, calls: 2 }, null)
  assert.equal(reviewedStatus(flat).partial, false)
  assert.equal(flat.sessions['review-conversation'].usageValueCost, .2)
})

test('review: backend tier and provisional cache evidence is preserved without disabling unused cache streams', async () => {
  await reset()
  const scenarios = [
    { name: 'flat-no-cache', rate: { input: 1, output: 1, cache_read: null, cache_write: null, has_tiers: false }, usage: { input: 100000, output: 0, calls: 1 }, partial: false },
    { name: 'tiered', rate: { input: 1, output: 1, cache_read: .1, has_tiers: true }, usage: { input: 0, output: 100000, calls: 1 }, partial: true },
    { name: 'provisional-read', rate: { input: 1, output: 1, cache_read: .1, has_tiers: false, provisional: ['cache_read'] }, usage: { input: 100000, output: 0, cache_read: 100000, calls: 1 }, partial: true }
  ]
  for (const scenario of scenarios) {
    const provider = `backend-review-${scenario.name}`
    T.setRest(async () => ({ rate: { ...scenario.rate, provenance: 'official_verified' } }))
    await T.ensureBackendRate(provider, 'review-model')
    const resolved = T.resolveRates({ provider, model: 'review-model' })
    assert.equal(resolved.origin, 'backend')
    assert.equal(resolved.rates.usagePriceSource, 'official_verified')
    const led = reviewedApply(T.emptyLedger(), scenario.usage, null, { provider, payload: { model: 'review-model', provider, providers: [] } })
    assert.equal(reviewedStatus(led).partial, scenario.partial)
  }
})

test('review: a coalesced multi-call reading cannot manufacture a proved warning at one current-model rate', async () => {
  await reset()
  const led = reviewedApply(T.emptyLedger(), { input: 2000000, output: 0, calls: 2 })
  assert.equal(reviewedStatus(led).level, 'unavailable')
  assert.equal(led.sessions['review-conversation'].usageValuePriced, 0)
})
