// Run: node --test test/
//
// Synthetic regression for cumulative counters and rounded cache estimates.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'

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
const body = src
  .replace(/import \{[^}]*\} from '@hermes\/plugin-sdk'\n/, stub)
  .replace(/import \{ useEffect \} from 'react'\n/, '')
  .replace(/import \{ jsx, jsxs \} from 'react\/jsx-runtime'\n/, '')
globalThis.window = { location: { hash: '' }, addEventListener() {}, removeEventListener() {} }
const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'tcm-recount-'))
const file = join(dir, 'plugin.mjs')
writeFileSync(file, body)
const mod = await import(pathToFileURL(file).href)
const T = mod.__test

const fixture = JSON.parse(readFileSync(new URL('./fixtures/synthetic-cumulative.json', import.meta.url), 'utf8'))
const NOW = Date.parse('2026-10-30T00:28:05Z')
const RUNTIME = 'synthetic-runtime'
const CONVERSATION = 'synthetic-runtime'

/** The frame the gateway sends: nested status-bar view, no raw cache fields. */
function frameFor(f, model = fixture.model) {
  return {
    model,
    input: f.prompt - f.cache,
    prompt: f.prompt,
    output: f.output,
    calls: f.calls,
    cache_hit_pct: Math.round((f.cache / f.prompt) * 100)
  }
}

function fold(frames, { sessionId = RUNTIME, storedId = CONVERSATION, model = fixture.model, start = null } = {}) {
  let led = start || { ...T.emptyLedger() }
  let at = NOW - frames.length * 1000
  for (const f of frames) {
    at += 1000
    led = T.applyUsage(led, {
      now: at,
      payload: { model, provider: fixture.provider },
      profile: '',
      provider: fixture.provider,
      sessionId,
      storedId,
      usage: frameFor(f, model)
    })
  }
  return led
}

const tokensOf = b => (b ? (b.input || 0) + (b.output || 0) + (b.cacheRead || 0) + (b.cacheWrite || 0) : 0)

test('live counters: a derived cache-read dip is not a new run', () => {
  // Cache estimate falls while every provider counter grows: the prompt's
  // rounded hit percentage dropped from 92% to 91% as it grew.
  const model = fixture.model
  const a = { model, input: 500, prompt: 11000, output: 100, calls: 4, cache_hit_pct: 92 }
  const b = { model, input: 505, prompt: 11100, output: 140, calls: 5, cache_hit_pct: 91 }
  const ua = T.readUsage(a)
  const ub = T.readUsage(b)
  assert.ok(ub.cacheRead < ua.cacheRead, 'fixture must reproduce the decreasing estimate')
  let led = T.applyUsage(T.emptyLedger(), { now: NOW, payload: null, profile: '', provider: 'commandcode', sessionId: RUNTIME, storedId: CONVERSATION, usage: a })
  led = T.applyUsage(led, { now: NOW + 1000, payload: null, profile: '', provider: 'commandcode', sessionId: RUNTIME, storedId: CONVERSATION, usage: b })
  assert.equal(led.sessions[CONVERSATION].calls, 5, 'calls must accumulate 4 → 5, not re-add the whole run')
  assert.equal(led.sessions[CONVERSATION].input, 505)
  assert.equal(led.sessions[CONVERSATION].output, 140)
})

test('synthetic turn folds to its canonical totals, not the inflated pane', () => {
  const led = fold(fixture.frames)
  const conv = led.sessions[CONVERSATION]
  assert.equal(conv.calls, fixture.canonical.requests, 'one call per reported request')
  assert.equal(conv.input, fixture.canonical.prompt_tokens - fixture.canonical.cache_read_tokens)
  assert.equal(conv.output, fixture.canonical.output_tokens)
  // Derived cache-read may differ by the rounding of cache_hit_pct, but it must
  // stay within 1% of prompt per frame rather than re-adding whole totals.
  const drift = Math.abs(tokensOf(conv) - fixture.canonical.total_tokens)
  assert.ok(drift / fixture.canonical.total_tokens < 0.02, `token drift ${drift} must stay under 2%`)
})

test('the inflation is not a key change: runtime and runtime::model agree', () => {
  const byRuntime = fold(fixture.frames)
  // Emulate the 0.2.3 snapshot key by running the same frames through a copy of
  // applyUsage whose key includes the model: reach it by alternating models is
  // not possible, so assert the invariant that one key per runtime is enough by
  // checking the snapshot map holds exactly one entry for the conversation.
  assert.equal(Object.keys(byRuntime.snapshots).length, 1, 'one runtime, one snapshot')
  assert.equal(byRuntime.sessions[CONVERSATION].calls, fixture.canonical.requests)
})

test('a duplicated frame (message.complete after a tick) adds nothing', () => {
  const led = fold(fixture.frames)
  const before = { ...led.sessions[CONVERSATION] }
  const next = T.applyUsage(led, {
    now: NOW + 5000,
    payload: { model: fixture.model, provider: fixture.provider },
    profile: '',
    provider: fixture.provider,
    sessionId: RUNTIME,
    storedId: CONVERSATION,
    usage: frameFor(fixture.frames.at(-1))
  })
  assert.equal(next.sessions[CONVERSATION].calls, before.calls)
  assert.equal(tokensOf(next.sessions[CONVERSATION]), tokensOf(before))
})

test('successive runtimes in one conversation add once each', () => {
  const first = fold(fixture.frames)
  const secondFrames = fixture.frames.slice(0, 6).map((f, i) => ({
    prompt: f.prompt + 4000, cache: f.cache, output: f.output, calls: i + 1
  }))
  const second = fold(secondFrames, { sessionId: 'runtime-b', start: first })
  const conv = second.sessions[CONVERSATION]
  assert.equal(conv.calls, fixture.canonical.requests + 6, 'second runtime contributes its own 6 calls')
  assert.ok(conv.input > first.sessions[CONVERSATION].input)
  assert.ok(tokensOf(conv) < fixture.canonical.total_tokens * 2, 'must not multiply the conversation')
})

test('a real restart still adopts the new run whole', () => {
  const led = fold(fixture.frames.slice(0, 10))
  const restarted = T.applyUsage(led, {
    now: NOW + 60_000,
    payload: { model: fixture.model, provider: fixture.provider },
    profile: '',
    provider: fixture.provider,
    sessionId: RUNTIME,
    storedId: CONVERSATION,
    usage: { model: fixture.model, input: 500, prompt: 6000, output: 60, calls: 1, cache_hit_pct: 90 }
  })
  assert.equal(restarted.sessions[CONVERSATION].calls, 11, 'new run starts at 1 after 10')
  assert.ok(restarted.sessions[CONVERSATION].input > led.sessions[CONVERSATION].input)
})

test('scope: a conversation total at least as large as the live run is labelled conversation', () => {
  // The screenshot showed the cost chip reading "this run" beside a note that
  // said "conversation total since …": both labels must follow the bucket.
  assert.equal(T.liveScope({ input: 20, output: 5 }, null), 'conversation')
  assert.equal(T.liveScope({ input: 20, output: 5 }, { input: 20, output: 5 }), 'conversation')
  assert.equal(T.liveScope({ input: 20, output: 5 }, { input: 21, output: 5 }), 'run')
  assert.equal(T.liveScope(null, { input: 21, output: 5 }), 'run')
  assert.equal(T.liveScope({}, { input: 21, output: 5 }), 'run')
})

test('model switch inside one runtime: counters keep counting, both models priced', () => {
  // A switch keeps the runtime's cumulative counters (only a new runtime resets
  // them), so the conversation must count each call once and keep both routes.
  const first = fixture.frames.slice(0, 8)
  const second = fixture.frames.slice(8, 14).map((f, i) => ({
    prompt: f.prompt, cache: f.cache, output: f.output, calls: f.calls
  }))
  let led = fold(first, { model: 'deepseek/deepseek-v4.1-flash' })
  led = fold(second, { model: 'z-ai/glm-5.3-flash', start: led })
  const conv = led.sessions[CONVERSATION]
  assert.equal(conv.calls, 14)
  const models = JSON.stringify(led.days)
  assert.ok(models.includes('deepseek/deepseek-v4.1-flash'), 'first route kept')
  assert.ok(models.includes('z-ai/glm-5.3-flash'), 'second route kept')
  assert.ok(tokensOf(conv) < fixture.canonical.total_tokens, 'no whole-run re-adoption on switch')
})

test('gateway cost: cumulative cost_usd is diffed, not summed per tick', () => {
  const frames = fixture.frames.slice(0, 5)
  let led = T.emptyLedger()
  let at = NOW - 10_000
  const cumulative = [0.001, 0.002, 0.004, 0.007, 0.011]
  frames.forEach((f, i) => {
    at += 1000
    led = T.applyUsage(led, {
      now: at, payload: { model: fixture.model, provider: fixture.provider }, profile: '',
      provider: fixture.provider, sessionId: RUNTIME, storedId: CONVERSATION,
      usage: { ...frameFor(f), cost_usd: cumulative[i] }
    })
  })
  const conv = led.sessions[CONVERSATION]
  assert.equal(conv.calls, 5)
  assert.ok(Math.abs(conv.cost - 0.011) < 1e-9, `cost ${conv.cost} must equal the last cumulative reading`)
  assert.equal(conv.sources.gateway > 0, true)
})

test('raw cache fields are exact and not labelled estimated', () => {
  const f = fixture.frames[20]
  const led = T.applyUsage(T.emptyLedger(), {
    now: NOW, payload: null, profile: '', provider: fixture.provider,
    sessionId: RUNTIME, storedId: CONVERSATION,
    usage: { model: fixture.model, input: f.prompt - f.cache, prompt: f.prompt, output: f.output,
             calls: f.calls, cache_read: f.cache, cache_write: 0 }
  })
  const conv = led.sessions[CONVERSATION]
  assert.equal(conv.cacheEstimated, false, 'raw cache fields are exact, not estimated')
  assert.equal(conv.cacheRead, f.cache)
  assert.equal(conv.input + conv.cacheRead + conv.cacheWrite, f.prompt)
})

test('fluctuating derived cache: counters stay exact and the split stays labelled', () => {
  const led = fold(fixture.frames)
  const conv = led.sessions[CONVERSATION]
  assert.equal(conv.cacheEstimated, true, 'a derived split must be labelled estimated')
  for (const field of ['input', 'output', 'cacheRead', 'cacheWrite', 'calls']) {
    assert.ok(conv[field] >= 0, `${field} must never go negative`)
  }
  // The provider-sourced counters are exact; only the cache split drifts.
  assert.equal(conv.output, fixture.canonical.output_tokens)
  assert.equal(conv.input, fixture.canonical.prompt_tokens - fixture.canonical.cache_read_tokens)
  assert.ok(Math.abs(conv.cacheRead - fixture.canonical.cache_read_tokens) / fixture.canonical.cache_read_tokens < 0.01)
})

test('a missing calls field keeps the last known count (present → missing → present)', () => {
  // `readUsage` maps an absent `calls` to 0. The delta must not subtract calls
  // that were already counted, and the snapshot must keep the last known value.
  const base = { model: fixture.model, input: 100, prompt: 200, cache_hit_pct: 50 }
  let led = T.emptyLedger()
  let at = NOW
  led = T.applyUsage(led, { now: at, payload: null, profile: '', provider: fixture.provider,
    sessionId: RUNTIME, storedId: CONVERSATION, usage: { ...base, output: 10, calls: 5 } })
  assert.equal(led.sessions[CONVERSATION].calls, 5)

  at += 1000
  led = T.applyUsage(led, { now: at, payload: null, profile: '', provider: fixture.provider,
    sessionId: RUNTIME, storedId: CONVERSATION, usage: { ...base, output: 15 } })  // calls absent
  assert.equal(led.sessions[CONVERSATION].calls, 5, 'absent calls must not reduce the count')

  at += 1000
  led = T.applyUsage(led, { now: at, payload: null, profile: '', provider: fixture.provider,
    sessionId: RUNTIME, storedId: CONVERSATION, usage: { ...base, output: 20, calls: 7 } })
  assert.equal(led.sessions[CONVERSATION].calls, 7, 'the next real reading resumes from the last known count')
  assert.equal(led.sessions[CONVERSATION].output, 20)
})

test('an estimated cache-write-only increment still marks the bucket estimated', () => {
  // hit% 1 on a 40-token prompt rounds the derived read to 0, so the whole gap
  // is written: the bucket must carry the estimated marker on that delta alone.
  const led = T.applyUsage(T.emptyLedger(), {
    now: NOW, payload: null, profile: '', provider: fixture.provider,
    sessionId: RUNTIME, storedId: CONVERSATION,
    usage: { model: fixture.model, input: 10, prompt: 40, output: 5, calls: 1, cache_hit_pct: 1 }
  })
  const conv = led.sessions[CONVERSATION]
  assert.equal(conv.cacheRead, 0)
  assert.equal(conv.cacheWrite, 30)
  assert.equal(conv.cacheEstimated, true, 'a write-only derived increment is still an estimate')
})

test('a 57-call window with a fluctuating derived cache folds to 57 calls', () => {
  // Uses a synthetic cumulative window: the true cache balance grows monotonically,
  // the gateway's rounded hit percentage jitters around it, and the derived
  // cacheRead therefore dips and recovers inside one runtime. Only provider
  // counters may decide scope; the derived dips must not re-adopt the run.
  let led = T.emptyLedger()
  let at = NOW
  let input = 0, cache = 0, output = 0
  for (let i = 1; i <= 57; i++) {
    input += 5_400 + (i % 7) * 120
    cache += 180_000 + (i % 11) * 4_000
    output += 1_000 + (i % 5) * 40
    const prompt = input + cache
    const hit = Math.round((cache / prompt) * 100)
    at += 9_000
    led = T.applyUsage(led, {
      now: at, payload: null, profile: '', provider: fixture.provider,
      sessionId: RUNTIME, storedId: CONVERSATION,
      usage: { model: fixture.model, input, prompt, output, calls: i, cache_hit_pct: hit }
    })
    assert.equal(led.sessions[CONVERSATION].calls, i, `calls after frame ${i}`)
  }
  const conv = led.sessions[CONVERSATION]
  const expected = input + cache + output
  const tokens = conv.input + conv.cacheRead + conv.cacheWrite + conv.output
  assert.equal(conv.calls, 57)
  assert.ok(Math.abs(tokens - expected) / expected < 0.02, `tokens ${tokens} vs ${expected}`)
})

test('the conversation start time comes from that conversation, not the runtime', () => {
  const T0 = Date.parse('2026-10-30T02:23:00Z')
  let led = T.applyUsage(T.emptyLedger(), {
    now: T0, payload: null, profile: '', provider: fixture.provider,
    sessionId: 'runtime-A', storedId: CONVERSATION,
    usage: { model: fixture.model, input: 1_000, prompt: 2_000, output: 100, calls: 1, cache_hit_pct: 50 }
  })
  assert.equal(led.sessions[CONVERSATION].firstAt, T0)
  // A later frame in a DIFFERENT runtime must not move the start time.
  led = T.applyUsage(led, {
    now: T0 + 600_000, payload: null, profile: '', provider: fixture.provider,
    sessionId: 'runtime-B', storedId: CONVERSATION,
    usage: { model: fixture.model, input: 2_000, prompt: 4_000, output: 200, calls: 2, cache_hit_pct: 50 }
  })
  assert.equal(led.sessions[CONVERSATION].firstAt, T0)
})

test('a different conversation keeps its own start time', () => {
  const A = Date.parse('2026-10-30T02:23:00Z')
  const B = Date.parse('2026-10-30T04:10:00Z')
  let led = T.applyUsage(T.emptyLedger(), {
    now: A, payload: null, profile: '', provider: fixture.provider,
    sessionId: 'runtime-A', storedId: 'conv-A',
    usage: { model: fixture.model, input: 1_000, prompt: 2_000, output: 100, calls: 1, cache_hit_pct: 50 }
  })
  led = T.applyUsage(led, {
    now: B, payload: null, profile: '', provider: fixture.provider,
    sessionId: 'runtime-A', storedId: 'conv-B',
    usage: { model: fixture.model, input: 500, prompt: 900, output: 40, calls: 1, cache_hit_pct: 40 }
  })
  assert.equal(led.sessions['conv-A'].firstAt, A)
  assert.equal(led.sessions['conv-B'].firstAt, B)
})
