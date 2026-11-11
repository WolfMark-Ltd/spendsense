const OPEN = 1

export const DEVTOOLS_COMMAND_TIMEOUT_MS = 5000
export const PAGE_LOAD_TIMEOUT_MS = 10000
export const LAYOUT_RESULT_TIMEOUT_MS = 5000
export const LAYOUT_POLL_INTERVAL_MS = 50

export function createDevToolsClient(socket, {
  commandTimeoutMs = DEVTOOLS_COMMAND_TIMEOUT_MS,
  pageLoadTimeoutMs = PAGE_LOAD_TIMEOUT_MS,
} = {}) {
  const pending = new Map()
  let commandId = 0
  let connectionError = null
  let pageLoadSeen = false
  let pageLoadWaiter = null

  const rejectConnection = error => {
    if (connectionError) return
    connectionError = error
    for (const [id, request] of pending) {
      clearTimeout(request.timeout)
      pending.delete(id)
      request.reject(error)
    }
    if (pageLoadWaiter && !pageLoadWaiter.settled) {
      const waiter = pageLoadWaiter
      pageLoadWaiter = null
      waiter.settled = true
      clearTimeout(waiter.timeout)
      waiter.reject(error)
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
      pageLoadSeen = true
      if (pageLoadWaiter && !pageLoadWaiter.settled) {
        pageLoadWaiter.settled = true
        clearTimeout(pageLoadWaiter.timeout)
        pageLoadWaiter.resolve()
      }
    }
  })
  socket.addEventListener('close', () => {
    rejectConnection(new Error('Chromium DevTools connection closed'))
  }, { once: true })
  socket.addEventListener('error', () => {
    rejectConnection(new Error('Chromium DevTools connection failed'))
  }, { once: true })

  const command = (method, params = {}, timeoutMs = commandTimeoutMs) => new Promise((resolve, reject) => {
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
      socket.send(JSON.stringify({ id, method, params }))
    } catch (error) {
      clearTimeout(timeout)
      pending.delete(id)
      reject(error)
    }
  })

  const waitForPageLoad = (timeoutMs = pageLoadTimeoutMs) => {
    if (pageLoadSeen) return Promise.resolve()
    if (connectionError) return Promise.reject(connectionError)
    if (socket.readyState !== OPEN) {
      return Promise.reject(new Error('Chromium DevTools connection is not open'))
    }
    if (pageLoadWaiter) return pageLoadWaiter.promise

    let resolve
    let reject
    const promise = new Promise((resolvePromise, rejectPromise) => {
      resolve = resolvePromise
      reject = rejectPromise
    })
    const waiter = { promise, resolve, reject, timeout: null, settled: false }
    waiter.timeout = setTimeout(() => {
      if (waiter.settled) return
      waiter.settled = true
      pageLoadWaiter = null
      reject(new Error(`Chromium page load timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    pageLoadWaiter = waiter
    return promise
  }

  return { command, waitForPageLoad }
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
