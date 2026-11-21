// Shared Chromium lifecycle for the browser acceptance suites.
//
// Extracted from the Reports suite (PR #81) so Model News reuses the same
// reviewed process ownership, DevTools transport and per-case isolation
// instead of growing a second implementation that could later diverge.
//
// The guarantees this module owns:
// - one owned Chromium root process per suite, launched in its own process
//   group (the flagged `detached` spawn option is carried explicitly because
//   Node does not expose it on the returned child);
// - teardown that verifies the whole owned tree is gone, including when the
//   leader has already exited, escalating only inside that tree;
// - a bounded browser-level CDP connection and flattened page sessions;
// - a fresh browser context and page per case, released on every path;
// - bounded, labelled polling for a published measurement.
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export const DEVTOOLS_COMMAND_TIMEOUT_MS = 5000
export const PAGE_LOAD_TIMEOUT_MS = 10000
export const LAYOUT_RESULT_TIMEOUT_MS = 5000
export const LAYOUT_POLL_INTERVAL_MS = 50

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

const OPEN = 1

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
  if (!binary) throw new Error('No Chromium binary is available for the browser layout checks')

  // Node does not expose the `detached` spawn option on the returned child, so
  // ownership of the process group has to be carried explicitly or teardown
  // silently degrades to signalling only the leader.
  const group = process.platform !== 'win32'
  const child = spawnImpl(binary, [
    '--headless', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage',
    '--remote-debugging-port=0', '--remote-allow-origins=*',
    `--user-data-dir=${profileDir}`, 'about:blank',
  ], {
    // A dedicated process group is what lets teardown signal this browser's own
    // tree without touching any other Chrome running on the machine.
    stdio: ['ignore', 'ignore', 'pipe'],
    detached: group,
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
    return { child, port, exited, stderr: stderrTail, group }
  } catch (error) {
    // Never leave an unowned browser behind when startup fails.
    if (child.pid !== undefined) {
      await stopChromium({ child, exited, group, stderr: stderrTail }).catch(() => {})
    }
    throw new Error(`${error.message}${formatStderr(stderrTail)}`)
  }
}

// Signalling the group is the only scope-safe way to reach Chromium's zygote and
// renderer children; a bare child.kill() leaves those running.
export function signalOwnedTree(child, signal, group = false) {
  if (!child?.pid) return false
  if (process.platform === 'win32') {
    // Node cannot signal a Windows process tree; taskkill /T is the scoped tool.
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    return true
  }
  if (group === true) {
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

export function ownedGroupGone(pid, group) {
  if (!pid || process.platform === 'win32' || group !== true) return true
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

export async function waitForOwnedTreeExit(child, group, timeoutMs, { sleep = wait, now = Date.now } = {}) {
  if (ownedGroupGone(child.pid, group)) return true
  const deadline = now() + timeoutMs
  while (now() < deadline) {
    await sleep(25)
    if (ownedGroupGone(child.pid, group)) return true
  }
  return false
}

/**
 * Terminate the browser this suite launched, and prove it.
 *
 * SIGTERM first so Chromium can flush and unlink its own profile, then a bounded
 * SIGKILL escalation. Success is reported only once the process group we created
 * no longer exists: a signal is a request, never evidence of termination.
 *
 * `group` says whether this teardown owns a process group (POSIX detached spawn).
 * It is required rather than inferred, because Node does not expose the spawn
 * option on the child and guessing it silently reduces the check to the leader.
 */
export async function stopChromium({
  child, exited, group, stderr = () => '',
  graceMs = BROWSER_TERMINATE_GRACE_MS,
  killTimeoutMs = BROWSER_KILL_TIMEOUT_MS,
  treeSettleMs = BROWSER_TREE_SETTLE_MS,
  signal = signalOwnedTree, waitForExit = waitForChildExit, waitForTree = waitForOwnedTreeExit,
} = {}) {
  if (typeof group !== 'boolean') {
    throw new Error('stopChromium needs to be told whether it owns the process group')
  }

  let escalated = false

  if (childIsRunning(child)) {
    escalated = signal(child, 'SIGTERM', group) === false
    if (!await waitForExit(child, graceMs)) {
      escalated = true
      signal(child, 'SIGKILL', group)
      if (!await waitForExit(child, killTimeoutMs)) {
        throw new Error(`Chromium did not terminate within ${killTimeoutMs}ms of SIGKILL${formatStderr(stderr)}`)
      }
    }
  }

  // A leader that crashed or exited on its own can still leave children behind,
  // so the group is checked on every path, not only when the leader had to die.
  let treeGone = await waitForTree(child, group, treeSettleMs)
  if (!treeGone) {
    escalated = true
    signal(child, 'SIGKILL', group)
    treeGone = await waitForTree(child, group, treeSettleMs)
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

// Flattened CDP sessions let one browser-level socket drive several isolated
// pages: a command carries its `sessionId` and the reply echoes it back, so a
// single pending table and a single command counter remain sufficient.
export function createDevToolsClient(socket, {
  commandTimeoutMs = DEVTOOLS_COMMAND_TIMEOUT_MS,
  pageLoadTimeoutMs = PAGE_LOAD_TIMEOUT_MS,
} = {}) {
  const pending = new Map()
  const pageLoads = new Map()
  const exceptions = []
  let commandId = 0
  let connectionError = null

  const pageLoadState = sessionId => {
    const key = sessionId ?? null
    let state = pageLoads.get(key)
    if (!state) {
      state = { seen: false, waiter: null }
      pageLoads.set(key, state)
    }
    return state
  }

  const settleWaiter = (waiter, settle, value) => {
    if (!waiter || waiter.settled) return
    waiter.settled = true
    clearTimeout(waiter.timeout)
    settle(value)
  }

  const rejectConnection = error => {
    if (connectionError) return
    connectionError = error
    for (const [id, request] of pending) {
      clearTimeout(request.timeout)
      pending.delete(id)
      request.reject(error)
    }
    for (const state of pageLoads.values()) {
      const waiter = state.waiter
      state.waiter = null
      settleWaiter(waiter, waiter?.reject, error)
    }
  }

  socket.addEventListener('message', event => {
    let message
    try {
      message = JSON.parse(String(event.data))
    } catch {
      return
    }

    if (message.id !== undefined && pending.has(message.id)) {
      const request = pending.get(message.id)
      clearTimeout(request.timeout)
      pending.delete(message.id)
      if (message.error) request.reject(new Error(message.error.message))
      else request.resolve(message.result)
    } else if (message.method === 'Page.loadEventFired') {
      // A load event belongs to the session that produced it, so a page that
      // finishes loading can never satisfy another page's readiness wait.
      const state = pageLoadState(message.sessionId)
      state.seen = true
      const waiter = state.waiter
      state.waiter = null
      settleWaiter(waiter, waiter?.resolve)
    } else if (message.method === 'Runtime.exceptionThrown') {
      // A page that throws before publishing its measurement would otherwise
      // time out with no explanation. Keep the first few uncaught exceptions so
      // the timeout can name the real failure.
      const details = message.params?.exceptionDetails
      const text = details?.exception?.description || details?.text || 'uncaught exception'
      if (exceptions.length < 5) exceptions.push(String(text).split('\n')[0].slice(0, 500))
    }
  })
  socket.addEventListener('close', () => {
    rejectConnection(new Error('Chromium DevTools connection closed'))
  }, { once: true })
  socket.addEventListener('error', () => {
    rejectConnection(new Error('Chromium DevTools connection failed'))
  }, { once: true })

  const command = (method, params = {}, timeoutMs = commandTimeoutMs, sessionId = null) => new Promise((resolve, reject) => {
    if (connectionError) return reject(connectionError)
    if (socket.readyState !== OPEN) return reject(new Error('Chromium DevTools connection is not open'))

    const id = ++commandId
    const timeout = setTimeout(() => {
      if (!pending.has(id)) return
      pending.delete(id)
      reject(new Error(`DevTools command ${method} timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    pending.set(id, { resolve, reject, timeout })
    try {
      socket.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }))
    } catch (error) {
      clearTimeout(timeout)
      pending.delete(id)
      reject(error)
    }
  })

  const sessionCommand = (sessionId, method, params = {}, timeoutMs = commandTimeoutMs) => {
    if (!sessionId) return Promise.reject(new Error(`DevTools command ${method} needs a page session`))
    return command(method, params, timeoutMs, sessionId)
  }

  const attachToTarget = async (targetId, timeoutMs = commandTimeoutMs) => {
    const { sessionId } = await command('Target.attachToTarget', { targetId, flatten: true }, timeoutMs)
    if (!sessionId) throw new Error('Chromium did not open a DevTools session for the page target')
    return sessionId
  }

  const waitForPageLoad = (sessionId = null, timeoutMs = pageLoadTimeoutMs) => {
    const state = pageLoadState(sessionId)
    if (state.seen) return Promise.resolve()
    if (connectionError) return Promise.reject(connectionError)
    if (socket.readyState !== OPEN) {
      return Promise.reject(new Error('Chromium DevTools connection is not open'))
    }
    if (state.waiter) return state.waiter.promise

    let resolve
    let reject
    const promise = new Promise((resolvePromise, rejectPromise) => {
      resolve = resolvePromise
      reject = rejectPromise
    })
    const waiter = { promise, resolve, reject, timeout: null, settled: false }
    waiter.timeout = setTimeout(() => {
      if (waiter.settled) return
      state.waiter = null
      settleWaiter(waiter, reject, new Error(`Chromium page load timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    state.waiter = waiter
    return promise
  }

  // A freshly created target loads about:blank, which can race with Page.enable.
  // Clearing the flag before navigating makes the next load event unambiguous.
  const resetPageLoad = (sessionId = null) => {
    const state = pageLoadState(sessionId)
    state.seen = false
    const waiter = state.waiter
    state.waiter = null
    settleWaiter(waiter, waiter?.reject, new Error('Page-load wait was reset before it settled'))
  }

  const takeExceptions = () => exceptions.splice(0, exceptions.length)

  return {
    command, sessionCommand, attachToTarget, waitForPageLoad, resetPageLoad,
    takeExceptions, pageLoadTimeoutMs, commandTimeoutMs,
  }
}

export async function pollForValue(read, {
  label = 'Layout measurement',
  timeoutMs = LAYOUT_RESULT_TIMEOUT_MS,
  pollIntervalMs = LAYOUT_POLL_INTERVAL_MS,
} = {}) {
  const deadline = Date.now() + timeoutMs
  while (true) {
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) {
      throw new Error(`${label} timed out after ${timeoutMs}ms`)
    }

    const result = await read(Math.min(DEVTOOLS_COMMAND_TIMEOUT_MS, remainingMs))
    const value = typeof result === 'string' ? result : result?.result?.value
    if (typeof value === 'string' && value.length > 0) {
      try {
        return JSON.parse(value)
      } catch (error) {
        throw new Error(`${label} published a malformed result: ${error.message}`)
      }
    }

    const delayMs = Math.min(pollIntervalMs, deadline - Date.now())
    if (delayMs <= 0) {
      throw new Error(`${label} timed out after ${timeoutMs}ms`)
    }
    await new Promise(resolve => setTimeout(resolve, delayMs))
  }
}

/**
 * One isolated browser context and page per case.
 *
 * A fresh page on the default profile would still share cookies and web storage
 * with every earlier case, so each case gets its own context and its page is
 * attached as a flattened session on the single browser connection.
 *
 * The context is released before this function returns or throws, so a failing
 * assertion cannot leak a page into the next case. `run` receives a page handle
 * bound to the case's session.
 */
export async function withIsolatedPage(client, {
  url, width, height, subject = 'Fixture', releaseLabel = 'The suite',
  commandTimeoutMs = client.commandTimeoutMs ?? DEVTOOLS_COMMAND_TIMEOUT_MS,
  pageLoadTimeoutMs = client.pageLoadTimeoutMs ?? PAGE_LOAD_TIMEOUT_MS,
  run,
} = {}) {
  const handles = { browserContextId: null, targetId: null, sessionId: null }
  let result = null
  let failure = null

  try {
    result = await openCase(client, handles, {
      url, width, height, subject, commandTimeoutMs, pageLoadTimeoutMs, run,
    })
  } catch (error) {
    failure = error
  }

  const cleanupErrors = await releaseCase(client, handles, commandTimeoutMs)
  if (failure) {
    // Name the scenario that failed: a bare CDP or navigation message does not
    // say which case the reader has to look at.
    if (subject && !failure.message.startsWith(subject) && !failure.message.includes(subject)) {
      failure.message = `${subject}: ${failure.message}`
    }
    if (cleanupErrors.length) {
      failure.message += ` (and the isolated context could not be released: ${cleanupErrors.map(e => e.message).join('; ')})`
    }
    throw failure
  }
  if (cleanupErrors.length) {
    throw new AggregateError(cleanupErrors, `${releaseLabel} could not release an isolated browser context`)
  }
  return result
}

async function openCase(client, handles, {
  url, width, height, subject, commandTimeoutMs, pageLoadTimeoutMs, run,
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
    throw new Error(`${subject} navigation failed: ${navigationResult.errorText}`)
  }

  const page = {
    sessionId,
    evaluate(expression, timeoutMs = commandTimeoutMs) {
      return client.sessionCommand(sessionId, 'Runtime.evaluate', {
        expression, returnByValue: true,
      }, timeoutMs)
    },
    command(method, params = {}, timeoutMs = commandTimeoutMs) {
      return client.sessionCommand(sessionId, method, params, timeoutMs)
    },
    // A second navigation on the same page and context: used by the isolation
    // negative control, which must observe state a fresh context would not.
    async navigate(nextUrl) {
      client.resetPageLoad(sessionId)
      const nextLoad = client.waitForPageLoad(sessionId, pageLoadTimeoutMs)
      const result = await client.sessionCommand(sessionId, 'Page.navigate', { url: nextUrl }, commandTimeoutMs)
      await nextLoad
      if (result?.errorText) throw new Error(`${subject} navigation failed: ${result.errorText}`)
    },
  }

  return run(page)
}

export async function releaseCase(client, handles, commandTimeoutMs = client.commandTimeoutMs ?? DEVTOOLS_COMMAND_TIMEOUT_MS) {
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

/**
 * Measure one case: isolate a context, navigate, poll for the published result,
 * then release. `subject` names the failing case in every error.
 */
export async function measureFixtureInContext(client, {
  url, width, height, subject, releaseLabel, resultExpression,
  measurementLabel = `${subject} measurement`,
  commandTimeoutMs, pageLoadTimeoutMs,
  measurementTimeoutMs = LAYOUT_RESULT_TIMEOUT_MS,
  pollIntervalMs,
} = {}) {
  return withIsolatedPage(client, {
    url, width, height, subject, releaseLabel,
    commandTimeoutMs, pageLoadTimeoutMs,
    run: page => pollForValue(timeoutMs => page.evaluate(resultExpression, timeoutMs), {
      label: measurementLabel, timeoutMs: measurementTimeoutMs,
      ...(pollIntervalMs ? { pollIntervalMs } : {}),
    }),
  })
}
