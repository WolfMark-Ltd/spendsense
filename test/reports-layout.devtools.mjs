const OPEN = 1

export const DEVTOOLS_COMMAND_TIMEOUT_MS = 5000
export const PAGE_LOAD_TIMEOUT_MS = 10000
export const LAYOUT_RESULT_TIMEOUT_MS = 5000
export const LAYOUT_POLL_INTERVAL_MS = 50

// Flattened CDP sessions let one browser-level socket drive several isolated
// pages: a command carries its `sessionId` and the reply echoes it back, so a
// single pending table and a single command counter remain sufficient.
export function createDevToolsClient(socket, {
  commandTimeoutMs = DEVTOOLS_COMMAND_TIMEOUT_MS,
  pageLoadTimeoutMs = PAGE_LOAD_TIMEOUT_MS,
} = {}) {
  const pending = new Map()
  const pageLoads = new Map()
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
    settleWaiter(waiter, waiter?.reject, new Error('Reports page-load wait was reset before it settled'))
  }

  return { command, sessionCommand, attachToTarget, waitForPageLoad, resetPageLoad, pageLoadTimeoutMs, commandTimeoutMs }
}

export async function pollForMeasurement(read, {
  timeoutMs = LAYOUT_RESULT_TIMEOUT_MS,
  pollIntervalMs = LAYOUT_POLL_INTERVAL_MS,
} = {}) {
  const deadline = Date.now() + timeoutMs
  while (true) {
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) {
      throw new Error(`Reports layout measurement timed out after ${timeoutMs}ms`)
    }

    const result = await read(Math.min(DEVTOOLS_COMMAND_TIMEOUT_MS, remainingMs))
    const value = typeof result === 'string' ? result : result?.result?.value
    if (typeof value === 'string' && value.length > 0) return JSON.parse(value)

    const delayMs = Math.min(pollIntervalMs, deadline - Date.now())
    if (delayMs <= 0) {
      throw new Error(`Reports layout measurement timed out after ${timeoutMs}ms`)
    }
    await new Promise(resolve => setTimeout(resolve, delayMs))
  }
}
