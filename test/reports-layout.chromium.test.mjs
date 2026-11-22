import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  findChromiumBinary, launchChromium, measureInBrowserContext, ownedGroupGone, stopChromium, waitForDevToolsPort,
} from './reports-layout.chromium.mjs'

const POSIX_ONLY = process.platform === 'win32' ? 'POSIX process groups only' : false
const IGNORES_SIGTERM = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

function temporaryProfile() {
  const dir = mkdtempSync(join(tmpdir(), 'wm-devtools-port-'))
  return { dir, remove: () => rmSync(dir, { recursive: true, force: true }) }
}

// A detached node child stands in for the browser: real signals, real process
// group, no Chromium binary needed for the lifecycle regressions.
function spawnOwnedChild(source, args = [], { group = true } = {}) {
  const child = spawn(process.execPath, ['-e', source, ...args], { detached: group, stdio: 'ignore' })
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })))
  return { child, exited }
}

async function waitForFile(path, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(path)) return readFileSync(path, 'utf8').trim()
    await wait(25)
  }
  throw new Error(`${path} was not written within ${timeoutMs}ms`)
}

// Per-pid liveness that tolerates a zombie: terminated, merely unreaped.
function childAlive(pid) {
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const close = stat.lastIndexOf(')')
    return close >= 0 ? stat.slice(close + 2).split(' ')[0] !== 'Z' : true
  } catch {
    return true
  }
}

async function waitUntilGone(pid, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!childAlive(pid)) return true
    await wait(25)
  }
  return !childAlive(pid)
}

// Records every CDP call and answers like a browser would, so the orchestration
// contract is provable without launching Chromium.
class FakeBrowser {
  commandTimeoutMs = 5000
  pageLoadTimeoutMs = 1000

  constructor({ result = '{"viewport":320}', fail = {} } = {}) {
    this.calls = []
    this.created = 0
    this.result = result
    this.fail = fail
  }

  async command(method, params = {}) {
    this.calls.push({ method, params })
    if (this.fail[method]) throw new Error(this.fail[method])
    if (method === 'Target.createBrowserContext') return { browserContextId: `ctx-${++this.created}` }
    if (method === 'Target.createTarget') return { targetId: `tgt-${this.created}` }
    if (method === 'Page.navigate') return { frameId: 'frame-1', loaderId: 'loader-1' }
    return {}
  }

  async attachToTarget(targetId) {
    this.calls.push({ method: 'Target.attachToTarget', params: { targetId } })
    return `session-for-${targetId}`
  }

  async sessionCommand(sessionId, method, params = {}) {
    this.calls.push({ method, params, sessionId })
    if (this.fail[method]) throw new Error(this.fail[method])
    if (method === 'Runtime.evaluate') return { result: { value: this.result } }
    return {}
  }

  resetPageLoad(sessionId) {
    this.calls.push({ method: 'resetPageLoad', sessionId })
  }

  waitForPageLoad(sessionId) {
    this.calls.push({ method: 'waitForPageLoad', sessionId })
    return Promise.resolve()
  }

  methods() {
    return this.calls.map(call => call.method)
  }
}

test('the published DevTools port is read from the browser profile', async () => {
  const profile = temporaryProfile()
  try {
    writeFileSync(join(profile.dir, 'DevToolsActivePort'), '43210\n/devtools/browser/abc\n')
    assert.equal(await waitForDevToolsPort({ profileDir: profile.dir, timeoutMs: 1000 }), 43210)
  } finally {
    profile.remove()
  }
})

test('a partially written DevTools port file is retried, not trusted', async () => {
  const profile = temporaryProfile()
  try {
    writeFileSync(join(profile.dir, 'DevToolsActivePort'), '')
    let reads = 0
    const port = await waitForDevToolsPort({
      profileDir: profile.dir, timeoutMs: 1000, pollIntervalMs: 1,
      readPort: () => (++reads < 3 ? Number.NaN : 43210),
      sleep: async () => {},
    })
    assert.equal(port, 43210)
    assert.equal(reads, 3)
  } finally {
    profile.remove()
  }
})

test('a browser that exits before publishing its port fails fast and says so', async () => {
  const profile = temporaryProfile()
  try {
    await assert.rejects(
      waitForDevToolsPort({ profileDir: profile.dir, timeoutMs: 5000, isAlive: () => false }),
      /exited before it exposed a DevTools endpoint/,
    )
  } finally {
    profile.remove()
  }
})

test('waiting for the DevTools port is bounded by its deadline', async () => {
  const profile = temporaryProfile()
  try {
    await assert.rejects(
      waitForDevToolsPort({ profileDir: profile.dir, timeoutMs: 40, pollIntervalMs: 5 }),
      /did not expose a DevTools endpoint within 40ms/,
    )
  } finally {
    profile.remove()
  }
})

test('the Chromium lookup reports absence instead of guessing a path', () => {
  assert.equal(findChromiumBinary([]), null)
  assert.equal(findChromiumBinary(['/nonexistent/google-chrome']), null)
  assert.equal(findChromiumBinary(['/nonexistent/google-chrome', process.execPath]), process.execPath)
})

test('startup failure includes a subsequent browser cleanup failure', async () => {
  const child = new EventEmitter()
  child.pid = 123
  child.exitCode = null
  child.signalCode = null
  const startup = new Error('port unavailable')
  const cleanup = new Error('owned browser survived')
  await assert.rejects(launchChromium({
    binary: 'mock', profileDir: 'mock', spawnImpl: () => child,
    waitForPort: async () => { throw startup },
    stopImpl: async () => { throw cleanup },
  }), error => {
    assert.ok(error instanceof AggregateError)
    assert.deepEqual(error.errors, [startup, cleanup])
    assert.match(error.message, /port unavailable/)
    assert.match(error.message, /startup cleanup failed: owned browser survived/)
    return true
  })
})

test('startup failure remains visible when browser cleanup succeeds', async () => {
  const child = new EventEmitter()
  child.pid = 123
  child.exitCode = null
  child.signalCode = null
  const startup = new Error('port unavailable')
  let cleaned = false
  await assert.rejects(launchChromium({
    binary: 'mock', profileDir: 'mock', spawnImpl: () => child,
    waitForPort: async () => { throw startup },
    stopImpl: async () => { cleaned = true },
  }), error => error.cause === startup && /port unavailable/.test(error.message))
  assert.equal(cleaned, true)
})

test('teardown refuses to guess whether it owns a process group', { skip: POSIX_ONLY }, async () => {
  // Node does not expose the spawn option on the child, so a silent default here
  // is exactly how group verification degrades into a leader-only check.
  const { child, exited } = spawnOwnedChild('setInterval(() => {}, 1000)')
  try {
    await assert.rejects(stopChromium({ child, exited }), /owns the process group/)
  } finally {
    await stopChromium({ child, exited, group: true, graceMs: 5000 })
  }
  assert.equal(ownedGroupGone(child.pid, true), true)
})

test('a browser that exits on SIGTERM is terminated without escalation', { skip: POSIX_ONLY }, async () => {
  const { child, exited } = spawnOwnedChild('setInterval(() => {}, 1000)')
  const result = await stopChromium({ child, exited, group: true, graceMs: 5000 })

  assert.equal(result.terminated, true)
  assert.equal(result.escalated, false)
  assert.equal(result.code.signal, 'SIGTERM')
  assert.equal(ownedGroupGone(child.pid, true), true)
})

test('a browser that ignores SIGTERM is escalated to SIGKILL', { skip: POSIX_ONLY }, async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'wm-ready-'))
  const readyFile = join(scratch, 'ready')
  const { child, exited } = spawnOwnedChild(`
    process.on('SIGTERM', () => {})
    require('node:fs').writeFileSync(process.argv[1], 'ready')
    setInterval(() => {}, 1000)
  `, [readyFile])

  try {
    // Without this handshake the test can beat the handler into place and the
    // default SIGTERM disposition would make the escalation look unnecessary.
    await waitForFile(readyFile)
    const result = await stopChromium({ child, exited, group: true, graceMs: 120, killTimeoutMs: 5000 })

    assert.equal(result.terminated, true)
    assert.equal(result.escalated, true)
    assert.equal(result.code.signal, 'SIGKILL')
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})

test('termination reaches a grandchild that ignores SIGTERM in the owned group', { skip: POSIX_ONLY }, async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'wm-tree-'))
  const pidFile = join(scratch, 'grandchild.pid')
  const source = `
    const { spawn } = require('node:child_process')
    const { writeFileSync } = require('node:fs')
    process.on('SIGTERM', () => {})
    const grandchild = spawn(process.execPath, ['-e', ${JSON.stringify(IGNORES_SIGTERM)}], { stdio: 'ignore' })
    writeFileSync(process.argv[1], String(grandchild.pid))
    setInterval(() => {}, 1000)
  `
  const { child, exited } = spawnOwnedChild(source, [pidFile])
  try {
    const grandchildPid = Number(await waitForFile(pidFile))
    assert.ok(grandchildPid > 0, 'the stand-in browser started a child')

    // Negative controls. Without them a "gone" result cannot be told apart from
    // a probe that never looked, which is exactly how this leak was missed.
    assert.equal(ownedGroupGone(child.pid, true), false, 'the owned group is observable while it is alive')
    assert.equal(childAlive(grandchildPid), true, 'the grandchild is running before teardown')

    // A leader-only kill would leave the grandchild holding the group open, so
    // reaching these assertions is the proof that the signal was tree-scoped.
    const result = await stopChromium({ child, exited, group: true, graceMs: 120, killTimeoutMs: 5000 })
    assert.equal(result.terminated, true)
    assert.equal(result.escalated, true)
    assert.equal(ownedGroupGone(child.pid, true), true, 'the owned group is empty after teardown')
    assert.equal(await waitUntilGone(grandchildPid), true, 'the grandchild itself is gone')
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})

test('a leader that already exited still has its surviving children cleaned up', { skip: POSIX_ONLY }, async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'wm-orphan-'))
  const pidFile = join(scratch, 'grandchild.pid')
  const source = `
    const { spawn } = require('node:child_process')
    const { writeFileSync } = require('node:fs')
    const grandchild = spawn(process.execPath, ['-e', ${JSON.stringify(IGNORES_SIGTERM)}], { stdio: 'ignore' })
    writeFileSync(process.argv[1], String(grandchild.pid))
    setTimeout(() => process.exit(0), 150)
  `
  const { child, exited } = spawnOwnedChild(source, [pidFile])
  try {
    const grandchildPid = Number(await waitForFile(pidFile))
    await exited
    assert.equal(child.exitCode !== null || child.signalCode !== null, true, 'the stand-in browser exited on its own')
    assert.equal(childAlive(grandchildPid), true, 'the grandchild outlives its leader')

    // A crash or clean self-exit must not be read as "nothing left to clean up".
    const result = await stopChromium({ child, exited, group: true, graceMs: 120, killTimeoutMs: 5000 })
    assert.equal(result.terminated, true)
    assert.equal(ownedGroupGone(child.pid, true), true, 'the owned group is empty after teardown')
    assert.equal(await waitUntilGone(grandchildPid), true, 'the orphaned grandchild is cleaned up')
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})

test('a browser that has already exited is reported without being signalled', { skip: POSIX_ONLY }, async () => {
  const { child, exited } = spawnOwnedChild('process.exit(0)')
  await exited

  const result = await stopChromium({ child, exited, group: true })
  assert.equal(result.terminated, true)
  assert.equal(result.escalated, false)
  assert.equal(result.code.code, 0)
})

test('one isolated context is created, scoped, measured and released', async () => {
  const browser = new FakeBrowser({ result: '{"viewport":320,"inheritedState":null}' })
  const measurement = await measureInBrowserContext(browser, {
    url: 'http://127.0.0.1:1234/?locale=en&days=7&theme=dark', width: 320, height: 1800,
  })

  assert.deepEqual(measurement, { viewport: 320, inheritedState: null })
  assert.deepEqual(browser.methods(), [
    'Target.createBrowserContext', 'Target.createTarget', 'Target.attachToTarget',
    'Page.enable', 'Runtime.enable', 'Emulation.setDeviceMetricsOverride',
    'resetPageLoad', 'waitForPageLoad', 'Page.navigate', 'Runtime.evaluate',
    'Target.detachFromTarget', 'Target.closeTarget', 'Target.disposeBrowserContext',
  ])

  const created = browser.calls.find(call => call.method === 'Target.createTarget')
  assert.equal(created.params.browserContextId, 'ctx-1')
  assert.equal(created.params.url, 'about:blank')
  const metrics = browser.calls.find(call => call.method === 'Emulation.setDeviceMetricsOverride')
  assert.equal(metrics.params.width, 320)
  assert.equal(metrics.params.height, 1800)
  assert.equal(metrics.sessionId, 'session-for-tgt-1')
  const navigation = browser.calls.find(call => call.method === 'Page.navigate')
  assert.equal(navigation.params.url, 'http://127.0.0.1:1234/?locale=en&days=7&theme=dark')
  assert.equal(navigation.sessionId, 'session-for-tgt-1')
})

test('every combination gets its own browser context, disposed before the next', async () => {
  const browser = new FakeBrowser()
  const options = { url: 'http://127.0.0.1:1234/', width: 380, height: 1800 }

  await measureInBrowserContext(browser, options)
  await measureInBrowserContext(browser, options)

  const targets = browser.calls.filter(call => call.method === 'Target.createTarget')
  assert.deepEqual(targets.map(call => call.params.browserContextId), ['ctx-1', 'ctx-2'])

  const disposed = browser.calls
    .filter(call => call.method === 'Target.disposeBrowserContext')
    .map(call => call.params.browserContextId)
  assert.deepEqual(disposed, ['ctx-1', 'ctx-2'])

  const firstDispose = browser.methods().indexOf('Target.disposeBrowserContext')
  const secondContext = browser.methods().lastIndexOf('Target.createBrowserContext')
  assert.ok(firstDispose < secondContext, 'the first context is gone before the second is created')
})

test('a failed measurement still releases its isolated context', async () => {
  const browser = new FakeBrowser({ result: '' })
  await assert.rejects(
    measureInBrowserContext(browser, {
      url: 'http://127.0.0.1:1234/', width: 320, height: 1800,
      measurementTimeoutMs: 20, pollIntervalMs: 1,
    }),
    /Reports layout measurement timed out after 20ms/,
  )

  assert.ok(browser.methods().includes('Target.disposeBrowserContext'))
  assert.ok(browser.methods().includes('Target.closeTarget'))
})

test('a CDP failure in the combination is reported and the context is released', async () => {
  const browser = new FakeBrowser({ fail: { 'Emulation.setDeviceMetricsOverride': 'Emulation is unavailable' } })
  await assert.rejects(
    measureInBrowserContext(browser, { url: 'http://127.0.0.1:1234/', width: 320, height: 1800 }),
    /Emulation is unavailable/,
  )
  assert.ok(browser.methods().includes('Target.disposeBrowserContext'))
})

test('a context that cannot be created fails without pretending to clean up', async () => {
  const browser = new FakeBrowser({ fail: { 'Target.createBrowserContext': 'Browser context limit reached' } })
  await assert.rejects(
    measureInBrowserContext(browser, { url: 'http://127.0.0.1:1234/', width: 320, height: 1800 }),
    /Browser context limit reached/,
  )
  assert.equal(browser.methods().includes('Target.disposeBrowserContext'), false)
})

test('a release failure is surfaced instead of being silently dropped', async () => {
  const browser = new FakeBrowser({ fail: { 'Target.disposeBrowserContext': 'Target is gone' } })
  await assert.rejects(
    measureInBrowserContext(browser, { url: 'http://127.0.0.1:1234/', width: 320, height: 1800 }),
    error => {
      assert.equal(error.name, 'AggregateError')
      assert.match(error.message, /could not release an isolated browser context/)
      assert.match(error.errors.map(inner => inner.message).join('; '),
        /Target\.disposeBrowserContext failed: Target is gone/)
      return true
    },
  )
})
