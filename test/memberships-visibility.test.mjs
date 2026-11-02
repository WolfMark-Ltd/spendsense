// Run: node --test test/
//
// Browser regression for the PR-D review: attention targets below the fold
// of a short pane, and billing tooltip anchoring. Runs real Chrome with
// --force-prefers-reduced-motion (instant scrolling works under --dump-dom
// virtual time; smooth does not), so it also covers the reduced-motion
// navigation path end to end. Skips with an explicit message where no
// Chrome binary is available.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  test('memberships visibility (skipped: no Chrome binary)', t => {
    t.skip('No Chrome/Chromium binary available: viewport visibility cannot be verified here.')
  })
} else {
  test('memberships visibility: below-fold targets land in view; tooltip anchors', async () => {
    const work = mkdtempSync(join(tmpdir(), 'wm-memberships-visibility-'))
    try {
      const esbuild = (await import(pathToFileURL(join(HARNESS_MODULES, 'esbuild', 'lib', 'main.js')).href)).default
      const bundle = join(work, 'page.js')
      await esbuild.build({
        entryPoints: [join(ROOT, 'test', 'memberships-visibility.page.jsx')],
        bundle: true, format: 'iife', platform: 'browser', outfile: bundle,
        jsx: 'automatic',
        alias: { '@hermes/plugin-sdk': join(ROOT, 'test', 'memberships-layout.sdk.mjs') },
        nodePaths: [HARNESS_MODULES], logLevel: 'warning',
      })
      const html = join(work, 'page.html')
      writeFileSync(html, `<!doctype html><html><head><meta charset="utf-8"><style>
:root{--ui-fill-primary:#12141a;--ui-fill-secondary:#1a1d26;--ui-fill-tertiary:#232633;
--ui-stroke-secondary:#2b2f40;--ui-text-primary:#eef0f6;--ui-text-secondary:#b9bdd1;
--ui-text-tertiary:#a9aec6;--ui-text-quaternary:#9398b0;--ui-accent:#4f7cff;
--ui-success:#2dd4bf;--ui-warning:#f5b544;--ui-error:#f26d6d;--font-mono:ui-monospace,monospace}
body{margin:0;background:#0a0b0f;font:400 13px/1.5 system-ui,sans-serif}
#app-short{width:380px;height:360px;overflow:auto}
#app-wide{width:1200px}
#memberships-visibility-result{display:none}
</style></head><body><div id="app-short"></div><div id="app-wide"></div><div id="memberships-visibility-result"></div>
<script>${readFileSync(bundle, 'utf8')}</script></body></html>`)
      const dom = execFileSync(chrome, [
        '--headless', '--disable-gpu', '--no-sandbox', '--force-prefers-reduced-motion',
        '--virtual-time-budget=15000', '--dump-dom', `file://${html}`,
      ], { maxBuffer: 64 * 1024 * 1024, timeout: 90000 }).toString()
      const match = dom.match(/<div id="memberships-visibility-result"[^>]*>([^<]*)<\/div>/)
      assert.ok(match && match[1], 'the page script must record a result')
      const result = JSON.parse(match[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&'))
      assert.equal(result.error, undefined, `page script error: ${result.error}`)
      assert.equal(result.reducedMotion, true, 'the run exercises the reduced-motion path')
      assert.equal(result.setup.rows, 1, 'the tall account renders in the short pane')
      assert.equal(result.setup.targetBelowFold, true,
        'the last-row action starts below the short viewport')
      const window = result.steps.window
      assert.equal(window.focused, true, 'below-fold window target takes focus')
      assert.equal(window.flashed, true, 'below-fold window row is highlighted')
      assert.equal(window.visible, true, 'the resolved target scrolls into the short viewport')
      const reading = result.steps.reading
      assert.equal(reading.detailsOpen, true, 'the weather details open for the reading')
      assert.equal(reading.focused, true, 'below-fold reading takes focus')
      assert.equal(reading.flashed, true, 'the reading is highlighted')
      assert.equal(reading.visible, true, 'the reading scrolls into the short viewport')
      for (const name of ['short', 'wide']) {
        const tip = result.tooltip[name]
        assert.equal(tip.open, true, `billing tooltip opens at ${name} width`)
        assert.equal(tip.belowButton, true, `tooltip anchors below its button at ${name} width`)
        assert.equal(tip.nearButton, true, `tooltip sits next to its header at ${name} width`)
        assert.equal(tip.hasSize, true, `tooltip has readable size at ${name} width`)
      }
      assert.equal(result.tooltip.short.insidePane, true,
        'tooltip stays inside the short pane viewport')
      assert.equal(result.hostCalls, 0, 'no host/gateway calls were made')
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })
}
