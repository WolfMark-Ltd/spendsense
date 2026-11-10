// Run: node --test test/
//
// Browser interaction test for the PR-D Memberships polish: real Chrome
// geometry and focus with synthetic attention accounts. Asserts the
// six-choice billing control fits a 380px pane without clipping, attention
// navigation expands the right account and visibly focuses the right
// control, and a real segmented write persists. Skips with an explicit
// message where no Chrome binary is available.
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
  test('memberships polish interaction (skipped: no Chrome binary)', t => {
    t.skip('No Chrome/Chromium binary available: geometry and focus cannot be verified here.')
  })
} else {
  test('memberships polish: segmented control, attention focus and write at 380px', async () => {
    const work = mkdtempSync(join(tmpdir(), 'wm-memberships-polish-'))
    try {
      const esbuild = (await import(pathToFileURL(join(HARNESS_MODULES, 'esbuild', 'lib', 'main.js')).href)).default
      const bundle = join(work, 'page.js')
      await esbuild.build({
        entryPoints: [join(ROOT, 'test', 'memberships-polish.page.jsx')],
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
#app-380{width:380px;height:600px;overflow:auto}
#app-1200{width:1200px}
#memberships-polish-result{display:none}
</style></head><body><div id="app-380"></div><div id="app-1200"></div><div id="memberships-polish-result"></div>
<script>${readFileSync(bundle, 'utf8')}</script></body></html>`)
      const dom = execFileSync(chrome, [
        '--headless', '--disable-gpu', '--no-sandbox', `--user-data-dir=${join(work, 'chrome-profile')}`,
        '--virtual-time-budget=15000', '--dump-dom', `file://${html}`,
      ], { maxBuffer: 64 * 1024 * 1024, timeout: 90000 }).toString()
      const match = dom.match(/<div id="memberships-polish-result"[^>]*>([^<]*)<\/div>/)
      assert.ok(match && match[1], 'the page script must record a result')
      const result = JSON.parse(match[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&'))
      assert.equal(result.error, undefined, `page script error: ${result.error}`)
      // Segmented control geometry at 380px.
      assert.equal(result.geometry.rows, 3, 'all three synthetic accounts render at 380px')
      assert.equal(result.geometry.segs.length, 3, 'each card has a segmented control')
      for (const seg of result.geometry.segs) {
        assert.equal(seg.options, 6, `${seg.account} offers six arrangements`)
        assert.equal(seg.pressed, 1, `${seg.account} shows exactly one pressed option`)
        assert.ok(seg.minHeight >= 38,
          `${seg.account} segmented buttons meet the 38px narrow touch target (got ${seg.minHeight})`)
        assert.equal(seg.clipped, 0, `${seg.account} segmented buttons are not clipped`)
        assert.equal(seg.focusable, 6, `${seg.account} options are keyboard-focusable`)
      }
      assert.ok(result.geometry.paneOverflow <= 1,
        `the 380px pane has no horizontal overflow (${result.geometry.paneOverflow}px)`)
      for (const width of result.geometry.attnButtonWidths) {
        assert.ok(width >= 200, `attention actions go full-width in the pane (got ${width}px)`)
      }
      assert.equal(result.geometry.cssSeg, true, 'the segmented styles ship in MEMBERSHIP_CSS')
      assert.equal(result.geometry.cssFlash, true, 'the highlight style ships in MEMBERSHIP_CSS')
      assert.equal(result.geometry.cssReducedMotion, true,
        'reduced-motion keeps a static highlight instead of the pulse')
      // Attention navigation lands on the right visible control.
      const arrangement = result.steps.arrangement
      assert.equal(arrangement.expanded, true, 'arrangement target expands its account')
      assert.equal(arrangement.groupOpen, true, 'arrangement target opens Plan & billing')
      assert.equal(arrangement.focused, true, 'arrangement target focuses the pressed option')
      assert.equal(arrangement.focusedLabel, 'memArrUnconfirmed',
        'focus lands on the current arrangement, not the first button')
      assert.equal(arrangement.flashed, true, 'the arrangement control is highlighted')
      assert.equal(arrangement.laidOut, true, 'the focused option has real size inside its card')
      assert.equal(arrangement.scrolled, true, 'the arrangement control is scrolled into view')
      const fee = result.steps.fee
      assert.equal(fee.expanded, true, 'fee target expands its account')
      assert.equal(fee.focused, true, 'fee target focuses the fee action')
      assert.equal(fee.flashed, true, 'the fee action is highlighted')
      assert.equal(fee.laidOut, true, 'the fee action has real size inside its card')
      assert.equal(fee.scrolled, true, 'the fee action is scrolled into view')
      const window = result.steps.window
      assert.equal(window.groupOpen, true, 'window target opens Allowances & readings')
      assert.equal(window.focused, true, 'window target focuses the Clear mark action')
      assert.equal(window.flashed, true, 'the window row is highlighted')
      assert.equal(window.laidOut, true, 'the Clear mark action has real size inside its card')
      assert.equal(window.scrolled, true, 'the window row is scrolled into view')
      // A real segmented write persists through the current guards.
      assert.equal(result.steps.write.puts.length, 1, 'one arrangement write is sent')
      assert.deepEqual(result.steps.write.puts[0],
        { id: 'xai:default', arrangement: 'subscription', owner_account_id: null,
          rev: 'r1', route_rev: 'route-r1' })
      assert.equal(result.steps.write.pressedIsSubscription, true,
        'the control reflects the saved arrangement after re-read')
      assert.ok(result.containers['1200'].paneOverflow <= 1, 'no overflow at ledger width')
      assert.equal(result.hostCalls, 0, 'no host/gateway calls were made')
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })
}
