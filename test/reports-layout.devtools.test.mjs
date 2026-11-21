import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createDevToolsClient, pollForMeasurement } from './reports-layout.devtools.mjs'

class FakeSocket extends EventTarget {
  readyState = 1
  sent = []

  send(raw) {
    this.sent.push(JSON.parse(raw))
  }

  close() {
    this.readyState = 3
    this.dispatchEvent(new Event('close'))
  }

  // Stand in for Chromium: reply to, or announce events from, a chosen session.
  receive(message) {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) }))
  }

  lastSent() {
    return this.sent.at(-1)
  }
}

test('DevTools commands reject when their deadline expires', async () => {
  const client = createDevToolsClient(new FakeSocket(), { commandTimeoutMs: 15 })
  await assert.rejects(client.command('Page.enable'), /timed out after 15ms/)
})

test('socket closure rejects pending commands and the page-load promise', async () => {
  const socket = new FakeSocket()
  const client = createDevToolsClient(socket, { commandTimeoutMs: 1000, pageLoadTimeoutMs: 1000 })
  const pendingCommand = client.command('Page.navigate', { url: 'file:///fixture.html' })
  const anotherPendingCommand = client.command('Runtime.enable')
  const pendingPageLoad = client.waitForPageLoad()

  socket.close()

  await assert.rejects(pendingCommand, /DevTools connection closed/)
  await assert.rejects(anotherPendingCommand, /DevTools connection closed/)
  await assert.rejects(pendingPageLoad, /DevTools connection closed/)
  await assert.rejects(client.command('Runtime.evaluate'), /DevTools connection closed/)
})

test('page-load wait has its own deadline if Chromium never reports load', async () => {
  const client = createDevToolsClient(new FakeSocket(), { pageLoadTimeoutMs: 15 })
  await assert.rejects(client.waitForPageLoad(), /page load timed out after 15ms/)
})

test('layout measurement polling returns the first published result', async () => {
  let attempts = 0
  const measurement = await pollForMeasurement(async () => {
    attempts += 1
    if (attempts < 3) return { result: { value: '' } }
    return { result: { value: '{"viewport":320}' } }
  }, { timeoutMs: 200, pollIntervalMs: 1 })

  assert.equal(attempts, 3)
  assert.deepEqual(measurement, { viewport: 320 })
})

test('layout measurement polling fails clearly when no result is published', async () => {
  await assert.rejects(
    pollForMeasurement(async () => ({ result: { value: '' } }), {
      timeoutMs: 20, pollIntervalMs: 2,
    }),
    /Reports layout measurement timed out after 20ms/,
  )
})

test('a DevTools error response rejects with the protocol message', async () => {
  const socket = new FakeSocket()
  const client = createDevToolsClient(socket, { commandTimeoutMs: 1000 })
  const pending = client.command('Target.createBrowserContext')

  socket.receive({ id: socket.lastSent().id, error: { code: -32000, message: 'Browser context limit reached' } })

  await assert.rejects(pending, /Browser context limit reached/)
})

test('page sessions carry their own identifier on every command', async () => {
  const socket = new FakeSocket()
  const client = createDevToolsClient(socket, { commandTimeoutMs: 1000 })
  const pending = client.sessionCommand('SESSION-A', 'Runtime.evaluate', { expression: '1' })
  const sent = socket.lastSent()

  assert.equal(sent.sessionId, 'SESSION-A')
  assert.equal(sent.method, 'Runtime.evaluate')
  socket.receive({ id: sent.id, sessionId: 'SESSION-A', result: { result: { value: '42' } } })

  assert.deepEqual(await pending, { result: { value: '42' } })
  await assert.rejects(client.sessionCommand(null, 'Runtime.evaluate'), /needs a page session/)
})

test('a page load on one session never resolves another session', async () => {
  const socket = new FakeSocket()
  const client = createDevToolsClient(socket, { pageLoadTimeoutMs: 1000 })
  const firstPage = client.waitForPageLoad('SESSION-A', 1000)
  const secondPage = client.waitForPageLoad('SESSION-B', 40)

  socket.receive({ method: 'Page.loadEventFired', sessionId: 'SESSION-A', params: { timestamp: 1 } })

  await firstPage
  await assert.rejects(secondPage, /page load timed out after 40ms/)
})

test('resetting a session re-arms its page-load wait', async () => {
  const socket = new FakeSocket()
  const client = createDevToolsClient(socket, { pageLoadTimeoutMs: 1000 })

  socket.receive({ method: 'Page.loadEventFired', sessionId: 'SESSION-A' })
  await client.waitForPageLoad('SESSION-A', 1000)

  client.resetPageLoad('SESSION-A')
  const reloaded = client.waitForPageLoad('SESSION-A', 1000)
  socket.receive({ method: 'Page.loadEventFired', sessionId: 'SESSION-A', params: { timestamp: 2 } })
  await reloaded

  client.resetPageLoad('SESSION-A')
  await assert.rejects(client.waitForPageLoad('SESSION-A', 20), /page load timed out after 20ms/)
})

test('attaching to a target flattens the session and reports its identifier', async () => {
  const socket = new FakeSocket()
  const client = createDevToolsClient(socket, { commandTimeoutMs: 1000 })
  const attached = client.attachToTarget('TARGET-1')

  assert.deepEqual(socket.lastSent().params, { targetId: 'TARGET-1', flatten: true })
  socket.receive({ id: socket.lastSent().id, result: { sessionId: 'SESSION-A' } })
  assert.equal(await attached, 'SESSION-A')

  const rejected = client.attachToTarget('TARGET-2')
  socket.receive({ id: socket.lastSent().id, result: {} })
  await assert.rejects(rejected, /did not open a DevTools session/)
})
