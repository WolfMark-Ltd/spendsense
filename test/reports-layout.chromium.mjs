import { spawn } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  LAYOUT_RESULT_TIMEOUT_MS, PAGE_LOAD_TIMEOUT_MS, createDevToolsClient, pollForMeasurement,
} from './reports-layout.devtools.mjs'

// One Chromium root process serves every Reports combination, so the budget has
// to cover eight isolated contexts inside the runner's per-file 300s limit.
export const REPORTS_SUITE_BUDGET_MS = 240_000
// Generous by design: a contended shared runner has been observed taking ~19s
// to publish its DevTools endpoint. The pre-existing 10s wait failed there.
export const BROWSER_START_TIMEOUT_MS = 30_000
export const BROWSER_CONNECT_TIMEOUT_MS = 15_000
export const BROWSER_TERMINATE_GRACE_MS = 5_000
export const BROWSER_KILL_TIMEOUT_MS = 5_000
export const BROWSER_TREE_SETTLE_MS = 2_000
export const BROWSER_STDERR_TAIL_BYTES = 4096

export const BROWSER_BINARY_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
]

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

export function findChromiumBinary(candidates = BROWSER_BINARY_CANDIDATES) {
  return candidates.find(existsSync) ?? null
}

export function childIsRunning(child) {
  return child.exitCode === null && child.signalCode === null
}

export function readDevToolsPortFile(portFile) {
  try {
    return Number(readFileSync(portFile, 'utf8').split('\n')[0].trim())
  } catch {
    return Number.NaN
  }
}

// Chromium writes the port it chose into DevToolsActivePort; the file can be
// observed mid-write, so a bad read is retried rather than treated as fatal.
export async function waitForDevToolsPort({
  profileDir, timeoutMs = BROWSER_START_TIMEOUT_MS, pollIntervalMs = 50,
  isAlive = () => true, readPort = readDevToolsPortFile, sleep = wait, now = Date.now,
}) {
  const portFile = join(profileDir, 'DevToolsActivePort')
  const deadline = now() + timeoutMs
  while (now() < deadline) {
    if (existsSync(portFile)) {
      const port = readPort(portFile)
      if (Number.isInteger(port) && port > 0) return port
    }
    if (!isAlive()) throw new Error('Chromium exited before it exposed a DevTools endpoint')
    await sleep(Math.min(pollIntervalMs, Math.max(1, deadline - now())))
  }
  throw new Error(`Chromium did not expose a DevTools endpoint within ${timeoutMs}ms`)
}

export function formatStderr(stderr) {
  const text = (typeof stderr === 'function' ? stderr() : stderr ?? '').trim()
  return text ? `\nChromium stderr (tail):\n${text}` : ''
}

export async function launchChromium({
  binary, profileDir, startTimeoutMs = BROWSER_START_TIMEOUT_MS,
  spawnImpl = spawn, waitForPort = waitForDevToolsPort,
} = {}) {
  if (!binary) throw new Error('No Chromium binary is available for the Reports layout checks')

  const child = spawnImpl(binary, [
    '--headless', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage',
    '--remote-debugging-port=0', '--remote-allow-origins=*',
    `--user-data-dir=${profileDir}`, 'about:blank',
  ], {
    // A dedicated process group is what lets teardown signal this browser's own
    // tree without touching any other Chrome running on the machine.
    stdio: ['ignore', 'ignore', 'pipe'],
    detached: process.platform !== 'win32',
  })

  let stderr = ''
  child.stderr?.setEncoding?.('utf8')
  child.stderr?.on?.('data', chunk => {
    stderr = `${stderr}${chunk}`.slice(-BROWSER_STDERR_TAIL_BYTES)
  })
  const stderrTail = () => stderr

  const exited = new Promise(resolve => {
    child.once('exit', (code, signal) => resolve({ code, signal }))
    // A failed spawn never emits 'exit', so a hanging teardown would otherwise
    // wait forever for an event that cannot happen.
    child.once('error', error => resolve({ code: null, signal: null, error }))
  })

  try {
    const port = await waitForPort({
      profileDir, timeoutMs: startTimeoutMs,
      isAlive: () => childIsRunning(child) && child.pid !== undefined,
    })
    return { child, port, exited, stderr: stderrTail }
  } catch (error) {
    // Never leave an unowned browser behind when startup fails.
    if (child.pid !== undefined) {
      await stopChromium({ child, exited, stderr: stderrTail }).catch(() => {})
    }
    throw new Error(`${error.message}${formatStderr(stderrTail)}`)
  }
}

// Signalling the group is the only scope-safe way to reach Chromium's zygote and
// renderer children; a bare child.kill() leaves those running.
export function signalOwnedTree(child, signal) {
  if (!child?.pid) return false
  if (process.platform === 'win32') {
    // Node cannot signal a Windows process tree; taskkill /T is the scoped tool.
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    return true
  }
  if (child.detached) {
    try {
      process.kill(-child.pid, signal)
      return true
    } catch (error) {
      if (error.code === 'ESRCH') return false
    }
  }
  try {
    child.kill(signal)
    return true
  } catch {
    return false
  }
}

export function groupMembers(pid) {
  let entries
  try {
    entries = readdirSync('/proc')
  } catch {
    return null
  }
  const members = []
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue
    let stat
    try {
      stat = readFileSync(`/proc/${entry}/stat`, 'utf8')
    } catch {
      continue
    }
    // /proc/<pid>/stat is "pid (comm) state ppid pgrp ..."; comm may hold spaces.
    const close = stat.lastIndexOf(')')
    if (close < 0) continue
    const fields = stat.slice(close + 2).split(' ')
    if (Number(fields[2]) === pid) members.push({ pid: Number(entry), state: fields[0] })
  }
  return members
}

export function ownedTreeGone(pid, detached) {
  if (!pid || process.platform === 'win32' || !detached) return true
  try {
    process.kill(-pid, 0)
  } catch (error) {
    return error.code === 'ESRCH'
  }
  // The group still answers, so it is only empty when every remaining member is
  // a zombie: those are terminated and merely awaiting a reaper we do not own.
  if (process.platform !== 'linux') return false
  const members = groupMembers(pid)
  return members ? members.every(member => member.state === 'Z') : false
}

export function waitForChildExit(child, timeoutMs) {
  if (!childIsRunning(child)) return Promise.resolve(true)
  return new Promise(resolve => {
    const settle = exited => {
      clearTimeout(timer)
      child.removeListener('exit', onExit)
      resolve(exited)
    }
    const onExit = () => settle(true)
    const timer = setTimeout(() => settle(!childIsRunning(child)), timeoutMs)
    child.once('exit', onExit)
  })
}

export async function waitForOwnedTreeExit(child, timeoutMs, { sleep = wait, now = Date.now } = {}) {
  if (ownedTreeGone(child.pid, child.detached)) return true
  const deadline = now() + timeoutMs
  while (now() < deadline) {
    await sleep(25)
    if (ownedTreeGone(child.pid, child.detached)) return true
  }
  return false
}

/**
 * Terminate the browser this suite launched, and prove it.
 *
 * SIGTERM first so Chromium can flush and unlink its own profile, then a bounded
 * SIGKILL escalation. Success is reported only once the process group we created
 * no longer exists: a signal is a request, never evidence of termination.
 */
export async function stopChromium({
  child, exited, stderr = () => '',
  graceMs = BROWSER_TERMINATE_GRACE_MS,
  killTimeoutMs = BROWSER_KILL_TIMEOUT_MS,
  treeSettleMs = BROWSER_TREE_SETTLE_MS,
  signal = signalOwnedTree, waitForExit = waitForChildExit, waitForTree = waitForOwnedTreeExit,
} = {}) {
  if (!childIsRunning(child)) {
    return { terminated: true, escalated: false, code: await exited }
  }

  let escalated = signal(child, 'SIGTERM') === false
  if (!await waitForExit(child, graceMs)) {
    escalated = true
    signal(child, 'SIGKILL')
    if (!await waitForExit(child, killTimeoutMs)) {
      throw new Error(`Chromium did not terminate within ${killTimeoutMs}ms of SIGKILL${formatStderr(stderr)}`)
    }
  }

  // The leader exiting is not the same as the group emptying: a stray renderer
  // can outlive it, which is exactly the leak this check exists to catch.
  let treeGone = await waitForTree(child, treeSettleMs)
  if (!treeGone) {
    escalated = true
    signal(child, 'SIGKILL')
    treeGone = await waitForTree(child, treeSettleMs)
  }
  if (!treeGone) {
    throw new Error(`Chromium exited but process group ${child.pid} still has members${formatStderr(stderr)}`)
  }

  return { terminated: true, escalated, code: await exited }
}

export async function openSocket(socket, timeoutMs = BROWSER_CONNECT_TIMEOUT_MS) {
  if (socket.readyState === 1) return socket
  await new Promise((resolve, reject) => {
    const onOpen = () => settle(resolve)
    const onError = () => settle(reject, new Error('Chromium DevTools connection failed'))
    const onClose = () => settle(reject, new Error('Chromium DevTools connection closed before opening'))
    const timer = setTimeout(() => settle(reject, new Error(`Chromium DevTools connection timed out after ${timeoutMs}ms`)), timeoutMs)
    function settle(fn, value) {
      clearTimeout(timer)
      socket.removeEventListener('open', onOpen)
      socket.removeEventListener('error', onError)
      socket.removeEventListener('close', onClose)
      fn(value)
    }
    socket.addEventListener('open', onOpen, { once: true })
    socket.addEventListener('error', onError, { once: true })
    socket.addEventListener('close', onClose, { once: true })
  })
  return socket
}

export async function connectToChromium(port, {
  connectTimeoutMs = BROWSER_CONNECT_TIMEOUT_MS, fetchImpl = fetch,
  websocketFactory = url => new WebSocket(url), clientOptions = {},
} = {}) {
  let response
  try {
    response = await fetchImpl(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(connectTimeoutMs),
    })
  } catch (error) {
    throw new Error(`Chromium DevTools endpoint refused the connection: ${error.message}`)
  }
  if (!response.ok) throw new Error(`Chromium DevTools endpoint answered ${response.status}`)
  const { webSocketDebuggerUrl } = await response.json()
  if (!webSocketDebuggerUrl) throw new Error('Chromium did not advertise a browser-level DevTools socket')

  const socket = websocketFactory(webSocketDebuggerUrl)
  await openSocket(socket, connectTimeoutMs)
  return { socket, client: createDevToolsClient(socket, clientOptions) }
}

/**
 * One isolated browser context per Reports combination.
 *
 * A fresh page on the default profile would still share cookies and web storage
 * with every earlier case, so each combination gets its own context and its page
 * is attached as a flattened session on the single browser connection.
 *
 * The context is released before this function returns or throws, so a failing
 * assertion cannot leak a page into the next combination.
 */
export async function measureInBrowserContext(client, {
  url, width, height,
  commandTimeoutMs = client.commandTimeoutMs ?? 5000,
  pageLoadTimeoutMs = PAGE_LOAD_TIMEOUT_MS,
  measurementTimeoutMs = LAYOUT_RESULT_TIMEOUT_MS,
  pollIntervalMs,
} = {}) {
  const handles = { browserContextId: null, targetId: null, sessionId: null }
  let measurement = null
  let failure = null

  try {
    measurement = await runCombination(client, handles, {
      url, width, height, commandTimeoutMs, pageLoadTimeoutMs, measurementTimeoutMs, pollIntervalMs,
    })
  } catch (error) {
    failure = error
  }

  const cleanupErrors = await releaseCombination(client, handles, commandTimeoutMs)
  if (failure) {
    if (cleanupErrors.length) {
      failure.message += ` (and the isolated context could not be released: ${cleanupErrors.map(e => e.message).join('; ')})`
    }
    throw failure
  }
  if (cleanupErrors.length) {
    throw new AggregateError(cleanupErrors, 'Reports could not release an isolated browser context')
  }
  return measurement
}

async function runCombination(client, handles, {
  url, width, height, commandTimeoutMs, pageLoadTimeoutMs, measurementTimeoutMs, pollIntervalMs,
}) {
  const { browserContextId } = await client.command('Target.createBrowserContext', {
    disposeOnDetach: true,
  }, commandTimeoutMs)
  if (!browserContextId) throw new Error('Chromium did not create an isolated browser context')
  handles.browserContextId = browserContextId

  const { targetId } = await client.command('Target.createTarget', {
    url: 'about:blank', browserContextId,
  }, commandTimeoutMs)
  if (!targetId) throw new Error('Chromium did not create a page in the isolated browser context')
  handles.targetId = targetId

  const sessionId = await client.attachToTarget(targetId, commandTimeoutMs)
  handles.sessionId = sessionId

  await client.sessionCommand(sessionId, 'Page.enable', {}, commandTimeoutMs)
  await client.sessionCommand(sessionId, 'Runtime.enable', {}, commandTimeoutMs)
  await client.sessionCommand(sessionId, 'Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: 1, mobile: false,
  }, commandTimeoutMs)

  client.resetPageLoad(sessionId)
  const loaded = client.waitForPageLoad(sessionId, pageLoadTimeoutMs)
  const navigation = client.sessionCommand(sessionId, 'Page.navigate', { url }, commandTimeoutMs)
  const [navigationResult] = await Promise.all([navigation, loaded])
  if (navigationResult?.errorText) {
    throw new Error(`Reports fixture navigation failed: ${navigationResult.errorText}`)
  }

  // Document readiness is not application readiness: the fixture publishes its
  // measurements after its own timers, so poll for the result with a deadline.
  return await pollForMeasurement(timeoutMs => client.sessionCommand(sessionId, 'Runtime.evaluate', {
    expression: 'document.getElementById("reports-layout-result").textContent',
    returnByValue: true,
  }, timeoutMs), { timeoutMs: measurementTimeoutMs, ...(pollIntervalMs ? { pollIntervalMs } : {}) })
}

export async function releaseCombination(client, handles, commandTimeoutMs = client.commandTimeoutMs ?? 5000) {
  const errors = []
  const attempt = async (method, params) => {
    try {
      await client.command(method, params, commandTimeoutMs)
    } catch (error) {
      errors.push(new Error(`${method} failed: ${error.message}`))
    }
  }

  if (handles.sessionId) {
    await attempt('Target.detachFromTarget', { sessionId: handles.sessionId })
    handles.sessionId = null
  }
  if (handles.targetId) {
    await attempt('Target.closeTarget', { targetId: handles.targetId })
    handles.targetId = null
  }
  if (handles.browserContextId) {
    await attempt('Target.disposeBrowserContext', { browserContextId: handles.browserContextId })
    handles.browserContextId = null
  }
  return errors
}
