import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  REPORTS_SUITE_BUDGET_MS, connectToChromium, findChromiumBinary, launchChromium,
  measureInBrowserContext, stopChromium,
} from './reports-layout.chromium.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const MODULES = join(ROOT, 'test/harness/node_modules')
const CHROME = findChromiumBinary()
const PROFILE_DIRNAME = 'chromium-profile'

// The fixture is served from loopback rather than file:// so browser storage has
// a real origin: that is what lets each case prove its context is isolated.
const startFixtureServer = html => new Promise((resolve, reject) => {
  const server = createServer((request, response) => {
    const pathname = (request.url || '/').split('?')[0]
    if (pathname === '/' || pathname === '/index.html') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      response.end(html)
    } else if (pathname === '/favicon.ico') {
      response.writeHead(204).end()
    } else {
      response.writeHead(404, { 'content-type': 'text/plain' }).end('not found')
    }
  })
  server.once('error', reject)
  server.listen(0, '127.0.0.1', () => resolve(server))
})

test('Reports stays scannable and keyboard usable from 320px through ledger width', {
  skip: CHROME ? false : 'No Chromium binary available for real Reports layout checks',
}, async () => {
  const work = mkdtempSync(join(tmpdir(), 'wm-reports-layout-'))
  const profileDir = join(work, PROFILE_DIRNAME)
  mkdirSync(profileDir)

  // LIFO teardown: the browser, then the fixture server, then the scratch tree.
  const teardown = []
  let failure = null

  try {
    teardown.push(() => rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))

    const esbuild = (await import(pathToFileURL(join(MODULES, 'esbuild/lib/main.js')).href)).default
    const bundle = join(work, 'page.js')
    await esbuild.build({
      entryPoints: [join(ROOT, 'test/reports-layout.page.jsx')], bundle: true,
      format: 'iife', platform: 'browser', outfile: bundle, jsx: 'automatic',
      alias: { '@hermes/plugin-sdk': join(ROOT, 'test/reports-layout.sdk.mjs') },
      nodePaths: [MODULES], logLevel: 'warning',
    })
    const html = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><style>
*{box-sizing:border-box}html,body{margin:0;width:100%;min-height:100%}
body{font:400 13px/1.5 system-ui,sans-serif;background:var(--ui-fill-primary);color:var(--ui-text-primary)}
body{--ui-fill-primary:#fff;--ui-fill-secondary:#f2f4f7;--ui-fill-tertiary:#e3e5eb;
--ui-stroke-secondary:#c5cbd5;--ui-text-primary:#151823;--ui-text-secondary:#414655;
--ui-text-tertiary:#555b69;--ui-text-quaternary:#626877;--ui-accent:#3157c0;
--ui-success:#087f5b;--ui-warning:#9a5e00;--ui-error:#b42318}
body[data-theme="dark"]{--ui-fill-primary:#12141a;--ui-fill-secondary:#1a1d26;--ui-fill-tertiary:#232633;
--ui-stroke-secondary:#2b2f40;--ui-text-primary:#eef0f6;--ui-text-secondary:#b9bdd1;
--ui-text-tertiary:#a9aec6;--ui-text-quaternary:#9398b0;--ui-accent:#7fa0ff;
--ui-success:#2dd4bf;--ui-warning:#f5b544;--ui-error:#f26d6d}
#reports-layout-host{width:100vw;min-height:100vh;color:var(--ui-text-primary)}
#reports-layout-result{display:none}
</style></head><body><div id="reports-layout-host"></div><div id="reports-layout-result"></div>
<script>${readFileSync(bundle, 'utf8')}</script></body></html>`

    const server = await startFixtureServer(html)
    teardown.push(() => new Promise(resolve => server.close(resolve)))
    const origin = `http://127.0.0.1:${server.address().port}/`

    // One Chromium for the whole matrix: the contexts, not the browser, provide
    // the per-combination isolation.
    const browser = await launchChromium({ binary: CHROME, profileDir })
    teardown.push(() => stopChromium({
      child: browser.child, exited: browser.exited, group: browser.group, stderr: browser.stderr,
    }))

    const { socket, client } = await connectToChromium(browser.port)
    teardown.push(() => { socket.close() })

    const deadline = Date.now() + REPORTS_SUITE_BUDGET_MS
    for (const locale of ['en', 'zh']) {
      for (const width of [320, 380, 560, 1200]) {
        const theme = locale === 'en' ? 'dark' : 'light'
        const days = width === 320 || width === 560 ? 7 : 30
        const id = `${locale}/${width}px/${theme}`
        if (Date.now() >= deadline) {
          throw new Error(`Reports layout checks exceeded their ${REPORTS_SUITE_BUDGET_MS}ms budget before ${id}`)
        }
        const result = await measureInBrowserContext(client, {
          url: `${origin}?locale=${locale}&days=${days}&theme=${theme}`,
          width, height: 1800,
        })
        assert.deepEqual(result.errors, [], `${id} has no page errors`)
        assert.equal(result.viewport, width, `${id} uses the requested viewport width`)
        assert.equal(result.inheritedState, null, `${id} starts from a browser free of earlier state`)
        assert.equal(result.isolationMarkerWritten, true, `${id} can persist state inside its own context`)
        assert.ok(result.shellWidth > 0, `${id} renders the Reports pane`)
        assert.ok(result.pageScroll <= result.viewport + 1,
          `${id} has no page-level horizontal overflow (${result.pageScroll}/${result.viewport})`)
        assert.ok(result.shellScroll - result.shellWidth <= 1,
          `${id} keeps content inside the Reports pane (${result.shellScroll}/${result.shellWidth})`)
        assert.ok(result.toolbarScroll - result.toolbarWidth <= 1,
          `${id} keeps the period and action toolbar inside its width`)
        assert.ok(result.actionWidths.every(width => width > 0), `${id} renders all report actions`)
        assert.ok(result.actionOverflow.every(px => px <= 1), `${id} wraps action labels inside buttons`)
        assert.deepEqual(result.actionOverlap, [], `${id} does not overlap action buttons`)
        assert.ok(result.statOverflow.every(px => px <= 1), `${id} wraps summary values`)
        assert.ok(result.sectionOverflow.every(px => px <= 1), `${id} wraps section content`)
        assert.ok(result.tableRegions.length >= 2, `${id} keeps both report tables available`)
        assert.ok(result.tableRegions.every(region => region.width > 0 && region.tabIndex === 0),
          `${id} exposes tables through keyboard-scrollable regions`)
        assert.ok(result.tableRegions.every(region => region.overflowX === 'auto' && ['clip', 'hidden'].includes(region.overflowY)),
          `${id} keeps report tables horizontally scrollable without a vertical scroll area`)
        assert.ok(result.tableRegions.every(region => region.verticalDelta === 0),
          `${id} lets report tables expand to their full height`)
        assert.equal(result.previewPeriodCount, 1, `${id} shows one period heading in the preview`)
        assert.equal(result.feedbackGroup, true, `${id} labels the report action group`)
        assert.match(result.downloadLabel, locale === 'zh' ? /下载 Markdown/ : /Download Markdown/)
        assert.match(result.text, locale === 'zh' ? /没有服务商读数/ : /No provider reading/)
      }
    }

    assert.equal(browser.child.exitCode, null, 'the single Chromium root process survives the whole matrix')
    assert.deepEqual(readdirSync(work).filter(name => name.startsWith(PROFILE_DIRNAME)), [PROFILE_DIRNAME],
      'Reports opens exactly one Chromium profile for the whole suite')
  } catch (error) {
    failure = error
  }

  const cleanupErrors = []
  for (const step of teardown.reverse()) {
    try {
      await step()
    } catch (error) {
      cleanupErrors.push(error)
    }
  }
  if (failure) {
    if (cleanupErrors.length) {
      failure.message += ` (and teardown failed: ${cleanupErrors.map(error => error.message).join('; ')})`
    }
    throw failure
  }
  if (cleanupErrors.length) {
    throw new AggregateError(cleanupErrors, 'Reports layout teardown failed')
  }
  assert.equal(existsSync(work), false, 'Reports removes its scratch profile after a successful run')
})
