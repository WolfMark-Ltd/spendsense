// Model News Chromium driver.
//
// One Chromium root process serves the whole suite. Each layout case and each
// interaction probe gets a fresh browser context and page, navigated to the
// fixture with its own query parameters. The browser is shared; the fixture
// environment is never shared, because the page fixes its fixture, scope and
// locale globals before React renders and they may be read asynchronously.
//
// This module owns the page build, the loopback fixture server, the case
// matrix, per-case measurement and the optional screenshot capture. It runs on
// the shared `chromium-lifecycle.mjs` extracted from the Reports suite.
import { createServer } from 'node:http'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { pollForValue, withIsolatedPage } from './chromium-lifecycle.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const MODULES = join(ROOT, 'test/harness/node_modules')

export const NEWS_RESULT_ID = 'news-layout-result'
// The committed fixtures carry fixed 2026-11 stamps and the UI measures its
// 30-day recency window against Date.now: every generated page runs on this
// pinned instant instead of the wall clock, so the assertions cannot expire.
export const NEWS_PAGE_NOW_MS = Date.parse('2026-11-10T12:00:00Z')
export const NEWS_CASE_TIMEOUT_MS = 20_000
export const NEWS_SUITE_BUDGET_MS = 240_000
// A viewport the pane never exceeds; the case container carries the width
// under test, exactly as the grid page did.
export const NEWS_VIEWPORT_HEIGHT = 1800

export const newsCaseId = ({ fixture, scope, w, theme, locale }) =>
  `${fixture}__${scope}__${w}__${theme}__${locale}`

/**
 * The complete layout matrix: 24 combinations of fixture, scope, width, theme
 * and locale. Every entry is its own isolated page execution.
 */
export const NEWS_LAYOUT_MATRIX = (() => {
  const matrix = []
  for (const scope of ['foryou', 'all'])
    for (const w of [380, 1200])
      for (const theme of ['dark', 'light'])
        for (const locale of ['en', 'zh-CN'])
          matrix.push({ fixture: 'realistic', scope, w, theme, locale })
  for (const fixture of ['empty', 'partial', 'nosignals'])
    for (const scope of ['foryou', 'all'])
      matrix.push({ fixture, scope, w: 380, theme: 'dark', locale: 'en' })
  for (const fixture of ['stale', 'error'])
    matrix.push({ fixture, scope: 'foryou', w: 380, theme: 'dark', locale: 'en' })
  return matrix
})()

/** Deterministic screenshot name for a case: never a timestamp, never a hash. */
export const newsShotName = id => `news-${id.replace(/__/g, '-')}.png`

/**
 * Build the fixture page once: one esbuild bundle plus the host document.
 * The host document pins Date.now, gives every case its own container and
 * hides the result node the driver polls.
 */
export async function buildNewsPage({ work }) {
  const esbuild = (await import(pathToFileURL(join(MODULES, 'esbuild/lib/main.js')).href)).default
  const bundle = join(work, 'page.js')
  await esbuild.build({
    entryPoints: [join(ROOT, 'test/news-layout.page.jsx')], bundle: true,
    format: 'iife', platform: 'browser', outfile: bundle, jsx: 'automatic',
    alias: { '@hermes/plugin-sdk': join(ROOT, 'test/news-layout.sdk.mjs') },
    nodePaths: [MODULES], logLevel: 'warning',
  })
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box}body{margin:0;padding:10px;display:grid;grid-template-columns:380px 1200px;gap:10px;align-items:start;font:13px/1.5 system-ui,sans-serif}
.case{background:var(--ui-fill-primary);color:var(--ui-text-primary);min-width:0}
.case.dark{--ui-fill-primary:#12141a;--ui-fill-secondary:#1a1d26;--ui-fill-tertiary:#232633;--ui-stroke-secondary:#2b2f40;--ui-text-primary:#eef0f6;--ui-text-secondary:#b9bdd1;--ui-text-tertiary:#a9aec6;--ui-text-quaternary:#9398b0;--ui-accent:#7fa0ff;--ui-success:#2dd4bf;--ui-warning:#f5b544;--ui-error:#f26d6d}
.case.light{--ui-fill-primary:#fff;--ui-fill-secondary:#f2f4f7;--ui-fill-tertiary:#e3e5eb;--ui-stroke-secondary:#c5cbd5;--ui-text-primary:#151823;--ui-text-secondary:#414655;--ui-text-tertiary:#555b69;--ui-text-quaternary:#626877;--ui-accent:#3157c0;--ui-success:#087f5b;--ui-warning:#9a5e00;--ui-error:#b42318}
body[data-single]{display:block;padding:0}body[data-single="dark"]{background:#12141a}body[data-single="light"]{background:#fff}
body[data-single] .case{margin:0}
#${NEWS_RESULT_ID}{display:none}
</style></head><body><div id="news-layout-cases"></div><div id="${NEWS_RESULT_ID}"></div>
<script>Date.now = () => ${NEWS_PAGE_NOW_MS}</script>
<script src="page.js"></script></body></html>`
  return { bundle, html }
}

/**
 * Serve the page and its bundle over loopback, not file://.
 *
 * A real origin is what lets each case prove its browser context carries no
 * storage from the previous one; an opaque file:// document could not.
 */
export async function startNewsServer({ html, bundle }) {
  const bundleBody = readFileSync(bundle)
  const server = createServer((request, response) => {
    const pathname = (request.url || '/').split('?')[0]
    if (pathname === '/' || pathname === '/index.html') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      response.end(html)
    } else if (pathname === '/page.js') {
      response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' })
      response.end(bundleBody)
    } else if (pathname === '/favicon.ico') {
      response.writeHead(204).end()
    } else {
      response.writeHead(404, { 'content-type': 'text/plain' }).end('not found')
    }
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return { server, origin: `http://127.0.0.1:${server.address().port}/` }
}

/** The fixture URL for one case, preserving its original query parameters. */
export function newsCaseUrl(origin, id, { probe = null, model } = {}) {
  const query = new URLSearchParams({ case: id })
  if (probe) query.set('probe', probe)
  // `model=` present-but-empty selects a record with no model identity.
  if (model !== undefined) query.set('model', model)
  return `${origin}?${query.toString()}`
}

async function readPayload(page, { id, timeoutMs, label }) {
  const payload = await pollForValue(
    budgetMs => page.evaluate(`document.getElementById(${JSON.stringify(NEWS_RESULT_ID)}).textContent`, budgetMs),
    { label, timeoutMs },
  )
  if (payload?.error) throw new Error(`Model News layout page refused ${id}: ${payload.error}`)
  if (payload?.total !== 1 || !Array.isArray(payload.cases) || payload.cases.length !== 1) {
    throw new Error(`Model News layout page published ${payload?.cases?.length} cases for ${id}; `
      + 'one isolated page must publish exactly one result')
  }
  const measurement = payload.cases[0]
  if (measurement?.id !== id) {
    throw new Error(`Model News layout page measured ${JSON.stringify(measurement?.id)} while asked for ${id}`)
  }
  return measurement
}

/**
 * Run `fn` against the case's page, attaching that page's own uncaught
 * exceptions to a failure. Exceptions are read per session, so one case can
 * never be told about an earlier page's error.
 */
async function attempt(client, page, fn) {
  try {
    return await fn()
  } catch (error) {
    const exceptions = client.takeExceptions?.(page.sessionId) || []
    if (exceptions.length) error.message += `\nBrowser exceptions:\n${exceptions.join('\n')}`
    throw error
  }
}

/** Element box of the case container, in CSS pixels from the document origin. */
const CASE_BOX_EXPRESSION = id => `(() => {
  const el = document.getElementById(${JSON.stringify(id)});
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.left + window.scrollX, y: r.top + window.scrollY, width: r.width, height: r.height };
})()`

/**
 * Capture the case exactly as measured, from the same page and context, into
 * `path`. Only ever called when NEWS_LAYOUT_SHOTS is set to an outside path.
 */
async function captureCaseScreenshot(page, { id, path }) {
  const box = await page.evaluate(CASE_BOX_EXPRESSION(id))
  const rect = box?.result?.value
  if (!rect || !(rect.width > 0) || !(rect.height > 0)) {
    throw new Error(`Model News screenshot for ${id} has no rendered case box`)
  }
  const capture = await page.command('Page.captureScreenshot', {
    format: 'png', fromSurface: true, captureBeyondViewport: true,
    clip: { x: rect.x, y: rect.y, width: rect.width, height: Math.max(rect.height, 120), scale: 1 },
  }, 20_000)
  if (!capture?.data) throw new Error(`Chromium returned no screenshot data for ${id}`)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, Buffer.from(capture.data, 'base64'))
}

/**
 * Measure one case in its own browser context and page.
 *
 * `screenshotPath` is opt-in and comes from the state the measurement recorded.
 * A case that also ran an interaction probe is captured from a **pristine load**
 * of the same case: the probe expands pagination and changes filters on the
 * measured page, so capturing it afterwards would show a different layout than
 * the assertions checked (and than the old separate `?case=` screenshot run).
 */
export async function measureNewsCase(client, {
  origin, id, width, probe = null, model, screenshotPath,
  timeoutMs = NEWS_CASE_TIMEOUT_MS,
  height = NEWS_VIEWPORT_HEIGHT,
} = {}) {
  const url = newsCaseUrl(origin, id, { probe, model })
  const captureWhileMeasured = Boolean(screenshotPath) && !probe

  const measurement = await withIsolatedPage(client, {
    url, width, height,
    subject: `Model News case ${id}`,
    releaseLabel: 'Model News',
    run: page => attempt(client, page, async () => {
      const result = await readPayload(page, {
        id, timeoutMs, label: `Model News layout measurement for ${id}`,
      })
      if (captureWhileMeasured) await captureCaseScreenshot(page, { id, path: screenshotPath })
      return result
    }),
  })

  if (screenshotPath && probe) {
    await withIsolatedPage(client, {
      url: newsCaseUrl(origin, id), width, height,
      subject: `Model News screenshot ${id}`,
      releaseLabel: 'Model News screenshot',
      run: page => attempt(client, page, async () => {
        const pristine = await readPayload(page, {
          id, timeoutMs, label: `Model News screenshot load for ${id}`,
        })
        if (pristine.readiness && pristine.readiness.ready !== true) {
          throw new Error(`Model News screenshot ${id} did not reach readiness: `
            + JSON.stringify(pristine.readiness))
        }
        await captureCaseScreenshot(page, { id, path: screenshotPath })
      }),
    })
  }

  return measurement
}

/**
 * Prove the isolation marker is observable, not vacuous: two navigations in
 * ONE context must see each other's storage, while every case in its own
 * context must see none. Used once per suite as the negative control for the
 * per-case `isolation.prior === null` assertion.
 */
export async function newsIsolationControl(client, { origin, id, width = 380, height = NEWS_VIEWPORT_HEIGHT } = {}) {
  const url = newsCaseUrl(origin, id)
  return withIsolatedPage(client, {
    url, width, height,
    subject: 'Model News isolation control',
    releaseLabel: 'Model News isolation control',
    run: async page => {
      const first = await readPayload(page, {
        id, timeoutMs: NEWS_CASE_TIMEOUT_MS, label: 'Model News isolation control (first load)',
      })
      // Same context, same page: a leaked marker MUST be visible here.
      await page.navigate(url)
      const second = await readPayload(page, {
        id, timeoutMs: NEWS_CASE_TIMEOUT_MS, label: 'Model News isolation control (second load)',
      })
      return { first: first.isolation, second: second.isolation }
    },
  })
}
