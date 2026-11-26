// WP54 connection-indicator visual driver (evidence generator, not a test).
//
// Renders each of the six connection states in the REAL SpendSense product
// shell — one isolated browser context per case, both themes, a
// representative narrow window and one full-page capture — then verifies the
// rendered chip state before capturing. Uses the established guarded,
// resource-bounded Chromium procedure: one browser root process, isolated
// contexts per case, verified process-group teardown. No browser process is
// left behind; the suite exits only after the tree is proven gone.
//
// Usage: node test/connection-visual.chromium.mjs <output-dir> [--w 1200] [--page]
import { createServer } from 'node:http'
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { findChromiumBinary, launchChromium, connectToChromium, stopChromium, pollForValue, withIsolatedPage } from './chromium-lifecycle.mjs'

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const MODULES = join(ROOT, 'test/harness/node_modules')
const RESULT_ID = 'conn-visual-result'
// The build (esbuild bundle + browser profile) lives outside the repository:
// generated artefacts must never be committed.
const WORK = process.env.CONN_VISUAL_WORK
  || new URL('file:///tmp').pathname + '/connection-visual-build'
const PROFILE_DIR = `${WORK}/profile`
const CASE_TIMEOUT_MS = 20_000

const STATES = ['live', 'loading', 'refreshing', 'reconnecting', 'offline', 'error']
const THEMES = ['dark', 'light']

const esbuild = (await import(pathToFileURL(join(MODULES, 'esbuild/lib/main.js')).href)).default
mkdirSync(WORK, { recursive: true })
const bundle = join(WORK, 'page.js')
await esbuild.build({
  entryPoints: [join(ROOT, 'test/connection-visual.page.jsx')], bundle: true,
  format: 'iife', platform: 'browser', outfile: bundle, jsx: 'automatic',
  alias: { '@hermes/plugin-sdk': join(ROOT, 'test/harness/real-sdk.mjs') },
  nodePaths: [MODULES], logLevel: 'warning',
})
// One page; the body background follows the case theme.
const html = `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box}body{margin:0;font:13px/1.5 system-ui,sans-serif}
.case{min-height:100%}
.case.dark{--wm-border:#2b2f40;--wm-text-secondary:#b9bdd1;--wm-text-muted:#a9aec6;--wm-surface:#12141a;--wm-surface-raised:#232633;--ui-fill-primary:#12141a;--ui-fill-secondary:#1a1d26;--ui-fill-tertiary:#232633;--ui-stroke-secondary:#2b2f40;--ui-text-primary:#eef0f6;--ui-text-secondary:#b9bdd1;--ui-text-tertiary:#a9aec6;--ui-text-quaternary:#9398b0;--ui-accent:#7fa0ff;--ui-success:#2dd4bf;--ui-warning:#f5b544;--ui-error:#f26d6d;--wm-positive:#2dd4bf;--wm-action:#7fa0ff;--wm-attention:#f5b544;--wm-error:#f26d6d;background:#12141a;color:#eef0f6;color-scheme:dark}
.case.light{--wm-border:#c5cbd5;--wm-text-secondary:#414655;--wm-text-muted:#555b69;--wm-surface:#fff;--wm-surface-raised:#f2f4f7;--ui-fill-primary:#fff;--ui-fill-secondary:#f2f4f7;--ui-fill-tertiary:#e3e5eb;--ui-stroke-secondary:#c5cbd5;--ui-text-primary:#151823;--ui-text-secondary:#414655;--ui-text-tertiary:#555b69;--ui-text-quaternary:#626877;--ui-accent:#3157c0;--ui-success:#087f5b;--ui-warning:#9a5e00;--ui-error:#b42318;--wm-positive:#087f5b;--wm-action:#3157c0;--wm-attention:#9a5e00;--wm-error:#b42318;background:#fff;color:#151823;color-scheme:light}
#${RESULT_ID}{display:none}
</style></head><body>
<div id="conn-visual-case" class="case"></div><div id="${RESULT_ID}"></div>
<script>Date.now = () => ${Date.parse('2026-11-26T10:11:12')}</script>
<script src="page.js"></script></body></html>`

const server = createServer((request, response) => {
  const pathname = (request.url || '/').split('?')[0]
  if (pathname === '/' || pathname === '/index.html') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    response.end(html)
  } else if (pathname === '/page.js') {
    response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' })
    response.end(readFileSync(bundle))
  } else {
    response.writeHead(204).end()
  }
})
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
const origin = `http://127.0.0.1:${server.address().port}/`

const outDir = process.argv[2] || '/tmp/connection-visual'
mkdirSync(outDir, { recursive: true })
const widthArg = process.argv.includes('--w') ? Number(process.argv[process.argv.indexOf('--w') + 1]) : 1200
const doFullPage = process.argv.includes('--page')

const binary = findChromiumBinary()
if (!binary) throw new Error('No Chromium binary available')
// A fresh profile every run: a stale DevToolsActivePort file from a previous
// (crashed) run would be read as if it were this browser's port.
rmSync(PROFILE_DIR, { recursive: true, force: true })
mkdirSync(PROFILE_DIR, { recursive: true })
const browser = await launchChromium({ binary, profileDir: PROFILE_DIR })
let socket = null
try {
  const connected = await connectToChromium(browser.port)
  socket = connected.socket
  const client = connected.client

  const caseUrl = (state, theme, full) =>
    `${origin}?case=${state}__${theme}${full ? '&page=full' : ''}`

  async function captureCase(state, theme, { full = false, width = widthArg, height = 720 } = {}) {
    const name = full
      ? `conn-${state}-${theme}-full.png`
      : `conn-${state}-${theme}-${width}.png`
    return withIsolatedPage(client, {
      url: caseUrl(state, theme, full), width, height,
      subject: `Connection visual ${state}__${theme}`, releaseLabel: 'Connection visual',
      run: async page => {
        const payload = await pollForValue(
          budgetMs => page.evaluate(`document.getElementById(${JSON.stringify(RESULT_ID)}).textContent`, budgetMs),
          { label: `Connection visual ${state}__${theme}`, timeoutMs: CASE_TIMEOUT_MS },
        )
        if (!payload?.ready) throw new Error(`fixture not ready: ${JSON.stringify(payload)}`)
        const rect = payload.tabsRect
        // The full-page capture stays inside the viewport: captureBeyondViewport
        // duplicates the sticky header at the scroll top, which is a capture
        // artefact, not the product's layout. The clip ends at the shell's own
        // height, so no blank area below the content is captured.
        const clip = full
          ? { x: 0, y: 0, width, height: Math.min(height, Math.ceil(payload.shellHeight || height)), scale: 1 }
          : { x: 0, y: 0, width, height: Math.max(96, Math.ceil(rect.top + rect.height + 8)), scale: 1 }
        const shot = await page.command('Page.captureScreenshot', {
          format: 'png', fromSurface: true, captureBeyondViewport: false, clip,
        }, 20_000)
        if (!shot?.data) throw new Error(`no screenshot data for ${name}`)
        writeFileSync(join(outDir, name), Buffer.from(shot.data, 'base64'))
        return { name, status: payload.status, sub: payload.sub,
                 last: payload.lastElement, rect: payload.tabsRect, brand: payload.brandRect }
      },
    })
  }

  const results = []
  for (const theme of THEMES)
    for (const state of STATES)
      results.push(await captureCase(state, theme))
  if (doFullPage) results.push(await captureCase('live', 'dark', { full: true, height: 1600 }))

  // Header consistency: the indicator block must sit at the row's far right
  // in every captured case, and the row geometry must be identical across
  // states within a theme (no layout shift).
  const rows = new Map()
  for (const r of results.filter(Boolean)) {
    const key = `${r.rect?.height}x${r.rect?.top}`
    if (!rows.has(key)) rows.set(key, [])
    rows.get(key).push(r.name)
  }
  console.log(JSON.stringify({ outDir, cases: results.filter(Boolean).length,
    rowGeometries: [...rows.entries()].map(([k, v]) => ({ key: k, cases: v.length })),
    lastElements: [...new Set(results.filter(Boolean).map(r => r.last))],
    results: results.filter(Boolean).map(r => ({ name: r.name, status: r.status, sub: r.sub })) }, null, 2))
} finally {
  let teardownError = null
  if (socket) { try { socket.close() } catch (error) { teardownError = error } }
  try { await stopChromium({ child: browser.child, exited: browser.exited, group: browser.group, stderr: browser.stderrTail }) }
  catch (error) { teardownError = error }
  try { server.close() } catch {}
  if (teardownError) throw teardownError
}
