// F63: membership card disclosures actually disclose. Real Chromium layout
// with synthetic accounts: closed groups hide their bodies and keep keyboard
// focus out, open groups keep the grid layout with reachable controls, the
// chevron agrees with the open state, and cancelling the fee form keeps its
// group open with focus on the opener. Covers English/Chinese, light/dark
// and narrow/wide layouts. Skips with an explicit message where no Chrome
// binary is available.
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
  test('memberships disclosure (skipped: no Chrome binary)', t => {
    t.skip('No Chrome/Chromium binary available: disclosure geometry cannot be verified here.')
  })
} else {
  test('memberships disclosure: closed hides and unfocuses, open grids and focuses', async () => {
    const work = mkdtempSync(join(tmpdir(), 'wm-memberships-disclosure-'))
    try {
      const esbuild = (await import(pathToFileURL(join(HARNESS_MODULES, 'esbuild', 'lib', 'main.js')).href)).default
      for (const locale of ['en', 'zh']) {
        const src = readFileSync(join(ROOT, 'test', 'memberships-disclosure.page.jsx'), 'utf8')
          .replaceAll('__LOCALE__', locale)
          .replaceAll('__ROOT__', ROOT)
        const entry = join(work, `entry-${locale}.jsx`)
        writeFileSync(entry, src)
        const bundle = join(work, `page-${locale}.js`)
        await esbuild.build({
          entryPoints: [entry],
          bundle: true, format: 'iife', platform: 'browser', outfile: bundle,
          jsx: 'automatic',
          alias: { '@hermes/plugin-sdk': join(ROOT, 'test', 'memberships-visual.sdk.mjs') },
          nodePaths: [HARNESS_MODULES], logLevel: 'warning',
        })
        const html = join(work, `page-${locale}.html`)
        writeFileSync(html, `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box}body{margin:0;font:13px/1.5 system-ui;background:#888}
.case{margin:10px;display:inline-block;vertical-align:top;background:var(--ui-fill-primary);color:var(--ui-text-primary);container-type:inline-size;overflow:auto}
.dark{--ui-fill-primary:#12141a;--ui-fill-secondary:#1a1d26;--ui-fill-tertiary:#232633;--ui-stroke-secondary:#2b2f40;--ui-text-primary:#eef0f6;--ui-text-secondary:#b9bdd1;--ui-text-tertiary:#a9aec6;--ui-text-quaternary:#9398b0;--ui-accent:#4f7cff;--ui-success:#2dd4bf;--ui-warning:#f5b544;--ui-error:#f26d6d}
.light{--ui-fill-primary:#fff;--ui-fill-secondary:#f2f4f7;--ui-fill-tertiary:#e3e5eb;--ui-stroke-secondary:#c5cbd5;--ui-text-primary:#151823;--ui-text-secondary:#414655;--ui-text-tertiary:#555b69;--ui-text-quaternary:#626877;--ui-accent:#3157c0;--ui-success:#067647;--ui-warning:#9a5e00;--ui-error:#b42318}
.narrow{width:380px}.wide{width:1080px}#memberships-disclosure-result{display:none}
.wm-analytics{container-type:inline-size}
</style></head><body>${['narrow-dark', 'wide-dark', 'narrow-light', 'wide-light'].map(id => `<div id="${id}" class="case ${id.replace('-', ' ')}"></div>`).join('')}<div id="memberships-disclosure-result"></div>
<script>${readFileSync(bundle, 'utf8')}</script></body></html>`)
        const dom = execFileSync(chrome, [
          '--headless', '--disable-gpu', '--no-sandbox', `--user-data-dir=${join(work, `chrome-profile-${locale}`)}`,
          '--virtual-time-budget=15000', '--dump-dom', `file://${html}`,
        ], { maxBuffer: 64 * 1024 * 1024, timeout: 120000 }).toString()
        const match = dom.match(/<div id="memberships-disclosure-result"[^>]*>([^<]*)<\/div>/)
        assert.ok(match && match[1], `${locale}: the page script must record a result`)
        const result = JSON.parse(match[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&'))
        assert.equal(result.error, undefined, `${locale}: page script error: ${result.error}`)
        for (const [id, c] of Object.entries(result.cases)) {
          assert.ok(c.paneOverflow <= 1, `${locale} ${id}: no horizontal overflow (${c.paneOverflow}px)`)
          for (const name of ['plan', 'allowances', 'advanced']) {
            const shut = c.closed[name]
            assert.equal(shut.open, false, `${locale} ${id} ${name}: groups start closed`)
            assert.equal(shut.control, true, `${locale} ${id} ${name}: probe control renders`)
            assert.equal(shut.height, 0, `${locale} ${id} ${name}: closed body takes no space (got ${shut.height}px)`)
            assert.equal(shut.focusable, false, `${locale} ${id} ${name}: focus cannot enter closed content`)
            assert.equal(shut.chevron, 'none', `${locale} ${id} ${name}: chevron shows closed`)
            const shown = c.open[name]
            assert.equal(shown.open, true, `${locale} ${id} ${name}: summary click opens the group`)
            assert.equal(shown.display, 'grid', `${locale} ${id} ${name}: open body keeps the grid layout`)
            assert.ok(shown.height > 0, `${locale} ${id} ${name}: open body is laid out`)
            assert.notEqual(shown.chevron, 'none', `${locale} ${id} ${name}: chevron shows open`)
            assert.equal(shown.focusable, true, `${locale} ${id} ${name}: controls are reachable when open`)
            assert.equal(c.reclosed[name].height, 0, `${locale} ${id} ${name}: re-closing hides the body again`)
            assert.equal(c.reclosed[name].focusable, false, `${locale} ${id} ${name}: re-closing removes focusability`)
          }
          assert.ok(c.weatherClosed, `${locale} ${id}: the weather disclosure renders`)
          assert.equal(c.weatherClosed.open, false, `${locale} ${id}: weather readings start collapsed`)
          assert.equal(c.weatherClosed.height, 0, `${locale} ${id}: closed weather readings take no space`)
          assert.equal(c.weatherOpen.open, true, `${locale} ${id}: weather disclosure opens`)
          assert.ok(c.weatherOpen.height > 0, `${locale} ${id}: open weather readings are laid out`)
        }
        assert.equal(result.flow.formOpened, true, `${locale}: Edit fee opens the fee form`)
        assert.equal(result.flow.groupOpenWithDraft, true, `${locale}: the draft opens its group`)
        assert.equal(result.flow.formClosed, true, `${locale}: Cancel closes the fee form`)
        assert.equal(result.flow.groupOpenAfterCancel, true, `${locale}: Cancel keeps the group open`)
        assert.ok(result.flow.editHeight > 0, `${locale}: the opener stays laid out after Cancel`)
        assert.equal(result.flow.focusReturned, true, `${locale}: Cancel returns focus to the opener`)
        assert.equal(result.hostCalls, 0, `${locale}: no host/gateway calls were made`)
      }
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })
}
