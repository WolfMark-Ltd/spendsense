// Run: node --test test/
//
// Browser layout test for the Memberships summary strip: real Chrome
// geometry with synthetic long mixed-currency fees. Asserts two columns at
// 380px, four at ledger width, and no fee-value overflow. Skips with an
// explicit message where no Chrome binary is available.
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
  test('memberships summary layout (skipped: no Chrome binary)', t => {
    t.skip('No Chrome/Chromium binary available: layout geometry cannot be verified here.')
  })
} else {
  test('memberships layout: summary and reading states, long fees, and inline exhaustion at 380px', async () => {
    const work = mkdtempSync(join(tmpdir(), 'wm-memberships-layout-'))
    try {
      const esbuild = (await import(pathToFileURL(join(HARNESS_MODULES, 'esbuild', 'lib', 'main.js')).href)).default
      const bundle = join(work, 'page.js')
      await esbuild.build({
        entryPoints: [join(ROOT, 'test', 'memberships-layout.page.jsx')],
        bundle: true, format: 'iife', platform: 'browser', outfile: bundle,
        jsx: 'automatic',
        alias: { '@hermes/plugin-sdk': join(ROOT, 'test', 'memberships-visual.sdk.mjs') },
        nodePaths: [HARNESS_MODULES], logLevel: 'warning',
      })
      const html = join(work, 'page.html')
      writeFileSync(html, `<!doctype html><html><head><meta charset="utf-8"><style>
:root{--ui-fill-primary:#12141a;--ui-fill-secondary:#1a1d26;--ui-fill-tertiary:#232633;
--ui-stroke-secondary:#2b2f40;--ui-text-primary:#eef0f6;--ui-text-secondary:#b9bdd1;
--ui-text-tertiary:#a9aec6;--ui-text-quaternary:#9398b0;--ui-accent:#4f7cff;
--ui-success:#2dd4bf;--ui-warning:#f5b544;--ui-error:#f26d6d;--font-mono:ui-monospace,monospace}
body{margin:0;background:#0a0b0f;font:400 13px/1.5 system-ui,sans-serif}
#app-380{width:380px;overflow:auto}
#app-1200{width:1200px}
#memberships-layout-result{display:none}
</style></head><body><div id="app-380"></div><div id="app-1200"></div><div id="memberships-layout-result"></div>
<script>${readFileSync(bundle, 'utf8')}</script></body></html>`)
      const dom = execFileSync(chrome, [
        '--headless', '--disable-gpu', '--no-sandbox',
        '--virtual-time-budget=12000', '--dump-dom', `file://${html}`,
      ], { maxBuffer: 64 * 1024 * 1024, timeout: 90000 }).toString()
      const match = dom.match(/<div id="memberships-layout-result"[^>]*>([^<]*)<\/div>/)
      assert.ok(match && match[1], 'the page script must record a result')
      const result = JSON.parse(match[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&'))
      assert.equal(result.error, undefined, `page script error: ${result.error}`)
      const narrow = result.containers['380']
      const wide = result.containers['1200']
      assert.equal(narrow.rows, 2, 'both synthetic accounts render at 380px')
      assert.equal(narrow.columns, 2, `380px strip stays scannable in two columns (got ${narrow.columns})`)
      assert.equal(narrow.hasLongFee, true, 'the long fee is present in the strip')
      assert.equal(narrow.hasMixedCurrencies, true, 'mixed currencies are present in the strip')
      assert.ok(narrow.overflow.every(px => px <= 1),
        `fee values do not overflow their cells (${JSON.stringify(narrow.overflow)})`)
      assert.ok(narrow.paneOverflow <= 1, `the 380px pane has no horizontal overflow (${narrow.paneOverflow}px)`)
      assert.deepEqual(narrow.readingStates, ['reported', 'unreported'],
        'provider readings and missing readings remain distinct in the account summaries')
      const flow = result.narrowExhaustion
      assert.ok(flow, 'the narrow-pane exhaustion flow ran')
      assert.equal(flow.formOpened, true, 'Mark exhausted opens the form at 380px')
      assert.equal(flow.inlineInWindow, true, 'the form renders inside the clicked window row')
      assert.equal(flow.directlyUnderButton, true, 'the form sits immediately beneath its button')
      assert.equal(flow.focusInForm, true, 'focus moves into the opened form')
      assert.ok(flow.paneOverflow <= 1, `the open form fits the 380px pane (${flow.paneOverflow}px)`)
      assert.equal(wide.columns, 4, `wide layout keeps four summary facts (got ${wide.columns})`)
      assert.equal(result.hostCalls, 0, 'no host/gateway calls were made')
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })
}
