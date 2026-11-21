import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  NEWS_LAYOUT_MATRIX, NEWS_PAGE_NOW_MS, measureNewsCase, newsCaseId, newsCaseUrl,
  newsIsolationControl, newsShotName,
} from './news-layout.chromium.mjs'

const ORIGIN = 'http://127.0.0.1:4321/'

const payloadFor = (id, extra = {}) => JSON.stringify({
  cases: [{
    id,
    fixture: id.split('__')[0],
    readiness: { ready: true, waitedMs: 25, expectedItems: 3 },
    isolation: { prior: null, wrote: true },
    ...extra,
  }],
  total: 1,
})

// Focused double for the browser-level CDP connection: every orchestration
// contract below is provable without launching Chromium for bookkeeping.
class FakeBrowser {
  commandTimeoutMs = 5000
  pageLoadTimeoutMs = 1000

  constructor({ payload, fail = {}, box = { x: 0, y: 0, width: 380, height: 900 }, navigateErrorText = null } = {}) {
    this.calls = []
    this.contexts = 0
    this.payload = payload ?? null
    this.fail = fail
    this.box = box
    this.navigateErrorText = navigateErrorText
    this.exceptions = new Map()
    this.loads = 0
  }

  addException(sessionId, text) {
    const list = this.exceptions.get(sessionId) || []
    list.push(text)
    this.exceptions.set(sessionId, list)
  }

  // The case currently navigated, so a default payload always answers for the
  // page the driver actually asked for.
  currentCase() {
    const latest = this.calls.filter(call => call.method === 'Page.navigate').at(-1)
    return new URL(latest.params.url).searchParams.get('case') || ''
  }

  answer() {
    if (typeof this.payload === 'function') {
      return this.payload({ caseId: this.currentCase(), load: this.loads })
    }
    if (typeof this.payload === 'string') return this.payload
    return payloadFor(this.currentCase())
  }

  async command(method, params = {}) {
    this.calls.push({ method, params })
    if (this.fail[method]) throw new Error(this.fail[method])
    if (method === 'Target.createBrowserContext') return { browserContextId: `ctx-${++this.contexts}` }
    if (method === 'Target.createTarget') return { targetId: `tgt-${this.contexts}` }
    if (method === 'Page.navigate') return { frameId: 'frame-1', loaderId: 'loader-1' }
    if (method === 'Page.captureScreenshot') return { data: Buffer.from('png-bytes').toString('base64') }
    return {}
  }

  async attachToTarget(targetId) {
    this.calls.push({ method: 'Target.attachToTarget', params: { targetId } })
    return `session-for-${targetId}`
  }

  async sessionCommand(sessionId, method, params = {}) {
    this.calls.push({ method, params, sessionId })
    if (this.fail[method]) throw new Error(this.fail[method])
    if (method === 'Page.navigate' && this.navigateErrorText) return { errorText: this.navigateErrorText }
    if (method === 'Page.captureScreenshot') return { data: Buffer.from('png-bytes').toString('base64') }
    if (method === 'Runtime.evaluate') {
      if (String(params.expression).includes('getBoundingClientRect')) {
        return { result: { value: this.box } }
      }
      this.loads += 1
      return { result: { value: this.answer() } }
    }
    return {}
  }

  resetPageLoad(sessionId) {
    this.calls.push({ method: 'resetPageLoad', sessionId })
  }

  waitForPageLoad(sessionId) {
    this.calls.push({ method: 'waitForPageLoad', sessionId })
    return Promise.resolve()
  }

  takeExceptions(sessionId = null) {
    const key = sessionId ?? null
    const list = this.exceptions.get(key) || []
    this.exceptions.delete(key)
    return list
  }

  dropExceptions(sessionId = null) {
    this.exceptions.delete(sessionId ?? null)
  }

  methods() {
    return this.calls.map(call => call.method)
  }

  navigations() {
    return this.calls.filter(call => call.method === 'Page.navigate').map(call => call.params.url)
  }
}

const CASE = 'realistic__all__1200__dark__en'

test('the layout matrix keeps all 24 scenarios and every dimension', () => {
  assert.equal(NEWS_LAYOUT_MATRIX.length, 24)
  assert.equal(new Set(NEWS_LAYOUT_MATRIX.map(newsCaseId)).size, 24, 'every case id is unique')
  const realistic = NEWS_LAYOUT_MATRIX.filter(entry => entry.fixture === 'realistic')
  assert.equal(realistic.length, 16, 'the realistic fixture spans the full responsive matrix')
  assert.deepEqual([...new Set(realistic.map(entry => entry.w))].sort((a, b) => a - b), [380, 1200])
  assert.deepEqual([...new Set(realistic.map(entry => entry.theme))].sort(), ['dark', 'light'])
  assert.deepEqual([...new Set(realistic.map(entry => entry.locale))].sort(), ['en', 'zh-CN'])
  assert.deepEqual([...new Set(realistic.map(entry => entry.scope))].sort(), ['all', 'foryou'])
  for (const fixture of ['empty', 'partial', 'nosignals', 'stale', 'error']) {
    assert.ok(NEWS_LAYOUT_MATRIX.some(entry => entry.fixture === fixture), `${fixture} is exercised`)
  }
  assert.equal(NEWS_LAYOUT_MATRIX.filter(entry => entry.fixture === 'nosignals').length, 2,
    'no-signals covers both scopes')
  assert.equal(NEWS_LAYOUT_MATRIX.filter(entry => entry.fixture === 'error').length, 1)
})

test('a case id names its fixture, scope, width, theme and locale', () => {
  assert.equal(newsCaseId({ fixture: 'partial', scope: 'all', w: 380, theme: 'light', locale: 'zh-CN' }),
    'partial__all__380__light__zh-CN')
  assert.equal(newsCaseUrl(ORIGIN, CASE), `${ORIGIN}?case=realistic__all__1200__dark__en`)
  assert.equal(newsCaseUrl(ORIGIN, CASE, { probe: 'story' }),
    `${ORIGIN}?case=realistic__all__1200__dark__en&probe=story`)
  // `model=` must stay present-but-empty: the page reads presence, not truthiness.
  assert.equal(newsCaseUrl(ORIGIN, CASE, { probe: 'story', model: '' }),
    `${ORIGIN}?case=realistic__all__1200__dark__en&probe=story&model=`)
  assert.equal(newsCaseUrl(ORIGIN, CASE, { model: 'split-model' }),
    `${ORIGIN}?case=realistic__all__1200__dark__en&model=split-model`)
})

test('the page clock is the pinned fixture instant', () => {
  assert.equal(NEWS_PAGE_NOW_MS, Date.parse('2026-11-10T12:00:00Z'))
})

test('every scenario gets its own browser context, disposed before the next', async () => {
  const browser = new FakeBrowser()
  const first = await measureNewsCase(browser, { origin: ORIGIN, id: 'realistic__foryou__380__dark__en', width: 380 })
  const second = await measureNewsCase(browser, { origin: ORIGIN, id: 'realistic__all__1200__light__zh-CN', width: 1200 })

  assert.equal(first.id, 'realistic__foryou__380__dark__en')
  assert.equal(second.id, 'realistic__all__1200__light__zh-CN')

  const created = browser.calls.filter(call => call.method === 'Target.createTarget')
  assert.deepEqual(created.map(call => call.params.browserContextId), ['ctx-1', 'ctx-2'],
    'each case opens a target in a new context')
  const disposed = browser.calls.filter(call => call.method === 'Target.disposeBrowserContext')
    .map(call => call.params.browserContextId)
  assert.deepEqual(disposed, ['ctx-1', 'ctx-2'], 'each context is released')
  const firstDispose = browser.methods().indexOf('Target.disposeBrowserContext')
  const secondContext = browser.methods().lastIndexOf('Target.createBrowserContext')
  assert.ok(firstDispose < secondContext, 'the first context is gone before the second is created')
  assert.deepEqual(browser.navigations(), [
    `${ORIGIN}?case=realistic__foryou__380__dark__en`,
    `${ORIGIN}?case=realistic__all__1200__light__zh-CN`,
  ], 'each scenario is navigated with only its own parameters')
})

test('the viewport under test is the case width, not a shared default', async () => {
  const browser = new FakeBrowser()
  await measureNewsCase(browser, { origin: ORIGIN, id: 'realistic__all__1200__dark__en', width: 1200 })
  await measureNewsCase(browser, { origin: ORIGIN, id: 'realistic__all__380__dark__en', width: 380 })
  const metrics = browser.calls.filter(call => call.method === 'Emulation.setDeviceMetricsOverride')
  assert.deepEqual(metrics.map(call => call.params.width), [1200, 380])
  assert.ok(metrics.every(call => call.params.deviceScaleFactor === 1 && call.params.mobile === false))
})

test('a published payload must describe exactly the requested case', async () => {
  const twoCases = new FakeBrowser({
    payload: JSON.stringify({ cases: [{ id: CASE, isolation: {} }, { id: CASE, isolation: {} }], total: 2 }),
  })
  await assert.rejects(
    measureNewsCase(twoCases, { origin: ORIGIN, id: CASE, width: 1200 }),
    /published 2 cases for realistic__all__1200__dark__en/,
  )
  assert.ok(twoCases.methods().includes('Target.disposeBrowserContext'), 'the context is still released')

  const wrongCase = new FakeBrowser({ payload: payloadFor('realistic__foryou__380__dark__en') })
  await assert.rejects(
    measureNewsCase(wrongCase, { origin: ORIGIN, id: CASE, width: 1200 }),
    /measured "realistic__foryou__380__dark__en" while asked for realistic__all__1200__dark__en/,
  )

  const refused = new FakeBrowser({ payload: JSON.stringify({ cases: [], total: 0, error: 'needs ?case=' }) })
  await assert.rejects(
    measureNewsCase(refused, { origin: ORIGIN, id: CASE, width: 1200 }),
    /refused realistic__all__1200__dark__en: needs \?case=/,
  )
})

test('a missing measurement fails by case and still releases its context', async () => {
  const browser = new FakeBrowser({ payload: '' })
  await assert.rejects(
    measureNewsCase(browser, { origin: ORIGIN, id: CASE, width: 1200, timeoutMs: 30 }),
    /Model News case realistic__all__1200__dark__en: Model News layout measurement for realistic__all__1200__dark__en timed out after 30ms/,
  )
  assert.ok(browser.methods().includes('Target.disposeBrowserContext'))
  assert.ok(browser.methods().includes('Target.closeTarget'))
})

test('a malformed measurement is reported, never parsed as a result', async () => {
  const browser = new FakeBrowser({ payload: 'not json' })
  await assert.rejects(
    measureNewsCase(browser, { origin: ORIGIN, id: CASE, width: 1200 }),
    /published a malformed result/,
  )
})

test('a CDP or navigation failure is reported for the affected scenario', async () => {
  const emulation = new FakeBrowser({ fail: { 'Emulation.setDeviceMetricsOverride': 'Emulation is unavailable' } })
  await assert.rejects(
    measureNewsCase(emulation, { origin: ORIGIN, id: CASE, width: 1200 }),
    /Model News case realistic__all__1200__dark__en: Emulation is unavailable/,
  )
  assert.ok(emulation.methods().includes('Target.disposeBrowserContext'))

  const navigation = new FakeBrowser({ navigateErrorText: 'net::ERR_CONNECTION_REFUSED' })
  await assert.rejects(
    measureNewsCase(navigation, { origin: ORIGIN, id: CASE, width: 1200 }),
    /Model News case .* navigation failed: net::ERR_CONNECTION_REFUSED/,
  )
})

test('a browser crash mid-run fails the case and still releases the context', async () => {
  const browser = new FakeBrowser({ fail: { 'Runtime.evaluate': 'Chromium DevTools connection closed' } })
  await assert.rejects(
    measureNewsCase(browser, { origin: ORIGIN, id: CASE, width: 1200 }),
    /Chromium DevTools connection closed/,
  )
  assert.ok(browser.methods().includes('Target.disposeBrowserContext'),
    'a crashed measurement does not leak its context')
})

test('an uncaught page exception is named when the measurement times out', async () => {
  const browser = new FakeBrowser({ payload: '' })
  browser.addException('session-for-tgt-1', 'TypeError: Cannot read properties of null (reading querySelectorAll)')
  await assert.rejects(
    measureNewsCase(browser, { origin: ORIGIN, id: CASE, width: 1200, timeoutMs: 30 }),
    error => {
      assert.match(error.message, /Browser exceptions:/)
      assert.match(error.message, /Cannot read properties of null/)
      return true
    },
  )
})

test('a released page takes its exceptions with it', async () => {
  // One connection serves every case, so an earlier page's error must not be
  // reported against a later one.
  const browser = new FakeBrowser()
  browser.addException('session-for-tgt-1', 'TypeError: from an earlier page')
  await measureNewsCase(browser, { origin: ORIGIN, id: 'realistic__all__380__dark__en', width: 380 })
  assert.equal(browser.exceptions.size, 0, 'the released session’s exceptions are discarded')

  browser.payload = ''
  await assert.rejects(
    measureNewsCase(browser, { origin: ORIGIN, id: CASE, width: 1200, timeoutMs: 30 }),
    error => {
      assert.doesNotMatch(error.message, /Browser exceptions:/,
        'a later timeout names no earlier page’s error')
      return true
    },
  )
})

test('the isolation control proves the marker is observable in one context', async () => {
  // First load in a fresh context: no marker. Second navigation in the SAME
  // context: the previous case id. This is what makes the per-case
  // `isolation.prior === null` assertion non-vacuous.
  const browser = new FakeBrowser({
    payload: ({ caseId, load }) => payloadFor(caseId, {
      isolation: { prior: load > 1 ? caseId : null, wrote: true },
    }),
  })
  const control = await newsIsolationControl(browser, { origin: ORIGIN, id: CASE })
  assert.equal(control.first.prior, null)
  assert.equal(control.first.wrote, true)
  assert.equal(control.second.prior, CASE)
  assert.equal(browser.navigations().length, 2, 'both loads are one page in one context')
  assert.equal(browser.calls.filter(call => call.method === 'Target.createBrowserContext').length, 1)
  assert.equal(browser.methods().filter(method => method === 'Page.navigate').length, 2)
})

test('screenshots are opt-in, captured from the measured page and named deterministically', async () => {
  const quiet = new FakeBrowser()
  await measureNewsCase(quiet, { origin: ORIGIN, id: CASE, width: 1200 })
  assert.equal(quiet.methods().includes('Page.captureScreenshot'), false,
    'no screenshot is captured unless a path is requested')

  const work = mkdtempSync(join(tmpdir(), 'wm-news-shot-'))
  try {
    const path = join(work, newsShotName(CASE))
    assert.equal(path.endsWith('news-realistic-all-1200-dark-en.png'), true,
      'the name is derived from the case, never from a timestamp or hash')
    const browser = new FakeBrowser()
    await measureNewsCase(browser, { origin: ORIGIN, id: CASE, width: 1200, screenshotPath: path })

    assert.ok(existsSync(path), 'the screenshot is written to the requested path')
    assert.equal(readFileSync(path, 'utf8'), 'png-bytes')
    const capture = browser.calls.find(call => call.method === 'Page.captureScreenshot')
    assert.deepEqual(capture.params.clip, { x: 0, y: 0, width: 380, height: 900, scale: 1 })
    assert.equal(capture.params.format, 'png')
    assert.equal(capture.params.captureBeyondViewport, true)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
})

test('a probe case is screenshotted from a pristine load, not the probed page', async () => {
  const work = mkdtempSync(join(tmpdir(), 'wm-news-shot-probe-'))
  try {
    const path = join(work, newsShotName(CASE))
    const browser = new FakeBrowser()
    await measureNewsCase(browser, {
      origin: ORIGIN, id: CASE, width: 1200, probe: '1', screenshotPath: path,
    })

    // The probed measurement keeps its probe, and the screenshot comes from a
    // second, un-probed navigation: the probe expands pagination and changes
    // filters, so the measured layout is only reproducible without it.
    const navigations = browser.navigations()
    assert.equal(navigations.length, 2)
    assert.equal(navigations[0], `${ORIGIN}?case=${CASE}&probe=1`)
    assert.equal(navigations[1], `${ORIGIN}?case=${CASE}`)
    assert.equal(browser.calls.filter(call => call.method === 'Target.createBrowserContext').length, 2,
      'the pristine capture gets its own context')
    const capture = browser.calls.find(call => call.method === 'Page.captureScreenshot')
    assert.equal(capture?.sessionId, 'session-for-tgt-2',
      'the screenshot is captured from the pristine session, not the probed one')
    assert.ok(existsSync(path))
    assert.equal(readFileSync(path, 'utf8'), 'png-bytes')
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
})

test('a screenshot without a rendered case box fails instead of writing an empty file', async () => {
  const work = mkdtempSync(join(tmpdir(), 'wm-news-shot-empty-'))
  try {
    const path = join(work, 'unused.png')
    const browser = new FakeBrowser({ box: { x: 0, y: 0, width: 0, height: 0 } })
    await assert.rejects(
      measureNewsCase(browser, { origin: ORIGIN, id: CASE, width: 1200, screenshotPath: path }),
      /has no rendered case box/,
    )
    assert.equal(existsSync(path), false)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
})
