// Run: node --test test/
//
// Focused browser layout test for the sidebar tooltip at ~380px pane width:
// real Chrome geometry (not jsdom), synthetic active-session data, no
// credentials, gateway or provider calls possible. Skips with an explicit
// message where no Chrome binary is available (e.g. Linux CI) rather than
// claiming visual proof it cannot run.
import assert from 'node:assert/strict'
import { execFileSync, execSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const HARNESS_MODULES = join(ROOT, 'test', 'harness', 'node_modules')

const chromeCandidates = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
]
const chrome = chromeCandidates.find(p => existsSync(p))
if (!chrome) {
  test('sidebar tooltip layout at 380px (skipped: no Chrome binary)', t => {
    t.skip('No Chrome/Chromium binary available: layout geometry cannot be verified here.')
  })
} else {
  test('sidebar tooltip at 380px: opaque, inside the pane, focus/Escape, no host calls', async () => {
    const work = mkdtempSync(join(tmpdir(), 'wm-tooltip-layout-'))
    try {
      const esbuild = (await import(pathToFileURL(join(HARNESS_MODULES, 'esbuild', 'lib', 'main.js')).href)).default
      const bundle = join(work, 'page.js')
      await esbuild.build({
        entryPoints: [join(ROOT, 'test', 'tooltip-layout.page.jsx')],
        bundle: true, format: 'iife', platform: 'browser', outfile: bundle,
        jsx: 'automatic',
        alias: { '@hermes/plugin-sdk': join(ROOT, 'test', 'tooltip-layout.sdk.mjs') },
        nodePaths: [HARNESS_MODULES], logLevel: 'warning',
      })
      // Synthetic host theme tokens: the real Hermes host provides --ui-*;
      // the layout test stands them in so computed colours resolve.
      const html = join(work, 'page.html')
      writeFileSync(html, `<!doctype html><html><head><meta charset="utf-8"><style>
:root{--ui-fill-primary:#12141a;--ui-fill-secondary:#1a1d26;--ui-fill-tertiary:#232633;
--ui-stroke-secondary:#2b2f40;--ui-text-primary:#eef0f6;--ui-text-secondary:#b9bdd1;
--ui-text-tertiary:#a9aec6;--ui-text-quaternary:#9398b0;--ui-accent:#4f7cff;
--ui-success:#2dd4bf;--ui-warning:#f5b544;--ui-error:#f26d6d}
body{margin:0;background:#0a0b0f;font:400 13px/1.5 system-ui,sans-serif}
#app{width:380px}
#tooltip-layout-result{display:none}
</style></head><body><div id="app"></div><div id="tooltip-layout-result"></div>
<script>${await import('node:fs').then(fs => fs.readFileSync(bundle, 'utf8'))}</script></body></html>`)
      const dom = execFileSync(chrome, [
        '--headless', '--disable-gpu', '--no-sandbox',
        '--virtual-time-budget=8000', '--dump-dom', `file://${html}`,
      ], { maxBuffer: 64 * 1024 * 1024, timeout: 90000 }).toString()
      const match = dom.match(/<div id="tooltip-layout-result"[^>]*>([^<]*)<\/div>/)
      assert.ok(match && match[1], 'the page script must record a result')
      const result = JSON.parse(match[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&'))
      assert.equal(result.error, undefined, `page script error: ${result.error}`)
      assert.equal(result.paneFound, true, 'the Meter pane renders')
      assert.equal(result.buttonFound, true, 'an info trigger renders')
      assert.ok(Math.abs(result.paneWidth - 380) <= 2, `pane is ~380px (got ${result.paneWidth})`)
      assert.equal(result.focusedButton, true, 'the trigger takes keyboard focus')
      assert.equal(result.tooltipOpened, true, 'focus opens the tooltip')
      assert.equal(result.opaque, true, `tooltip background is opaque (got ${result.backgroundColor})`)
      assert.equal(result.withinPane, true,
        `tooltip stays inside the pane (pop ${JSON.stringify(result.popRect)} pane ${JSON.stringify(result.paneRect)})`)
      assert.equal(result.escapeClosed, true, 'Escape closes the tooltip')
      assert.equal(result.hostCalls, 0, 'no host/gateway calls were made')
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })
}
