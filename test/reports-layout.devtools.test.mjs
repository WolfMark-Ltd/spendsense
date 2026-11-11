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
