// Run: node --test test/
//
// Shared tooltip/info-tip layout: real Chrome geometry (not jsdom),
// synthetic data, no credentials, gateway or provider calls possible. Skips
// with an explicit message where no Chrome binary is available (e.g. Linux
// CI) rather than claiming visual proof it cannot run.
//
// Covers WP02: narrow and wide layouts, container/viewport edges and
// scrolling, hover + keyboard focus + Escape, dark/light host themes and
// English/Chinese copy. The pane surface pins the four Meter tips; the
// product surface (real ProductShell + BudgetPanel) pins edge placement,
// scrollbar growth and scope-level Escape.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

const THEMES = {
  dark: {
    tokens: '--ui-fill-primary:#12141a;--ui-fill-secondary:#1a1d26;--ui-fill-tertiary:#232633;'
      + '--ui-stroke-secondary:#2b2f40;--ui-text-primary:#eef0f6;--ui-text-secondary:#b9bdd1;'
      + '--ui-text-tertiary:#a9aec6;--ui-text-quaternary:#9398b0;--ui-accent:#7fa0ff;'
      + '--ui-success:#2dd4bf;--ui-warning:#f5b544;--ui-error:#f26d6d',
    background: '#12141a',
  },
  light: {
    tokens: '--ui-fill-primary:#fff;--ui-fill-secondary:#f2f4f7;--ui-fill-tertiary:#e3e5eb;'
      + '--ui-stroke-secondary:#c5cbd5;--ui-text-primary:#151823;--ui-text-secondary:#414655;'
      + '--ui-text-tertiary:#555b69;--ui-text-quaternary:#626877;--ui-accent:#3157c0;'
      + '--ui-success:#087f5b;--ui-warning:#9a5e00;--ui-error:#b42318',
    background: '#fff',
  },
}
// [paneWidth, productWidth]: narrow pane + narrow product, canonical sidebar
// pane + wide product. Eight runs (× dark/light × en/zh) keep the browser
// matrix affordable while many suite files drive Chrome in parallel.
const WIDTHS = [[268, 300], [380, 900]]
const LOCALES = ['en', 'zh']

if (!chrome) {
  test('shared tooltip layout across widths, themes and locales (skipped: no Chrome binary)', t => {
    t.skip('No Chrome/Chromium binary available: layout geometry cannot be verified here.')
  })
} else {
  test('shared tooltips stay inside narrow and wide panes in both themes and locales', async () => {
    const work = mkdtempSync(join(tmpdir(), 'wm-tooltip-layout-'))
    try {
      const esbuild = (await import(pathToFileURL(join(HARNESS_MODULES, 'esbuild', 'lib', 'main.js')).href)).default
      const bundle = join(work, 'page.js')
      await esbuild.build({
        entryPoints: [join(ROOT, 'test', 'tooltip-layout.page.jsx')],
        bundle: true, format: 'iife', platform: 'browser', outfile: bundle,
        jsx: 'automatic',
        // Pin React to the harness copy: tmpdir/worktree entries resolve
        // 'react' through different node_modules chains, and two copies in
        // one bundle break hooks (null dispatcher reads in InfoTip).
        alias: {
          '@hermes/plugin-sdk': join(ROOT, 'test', 'tooltip-layout.sdk.mjs'),
          react: join(HARNESS_MODULES, 'react'),
          'react-dom': join(HARNESS_MODULES, 'react-dom'),
        },
        nodePaths: [HARNESS_MODULES], logLevel: 'warning',
      })
      const backgrounds = {}
      let runs = 0
      for (const [paneWidth, productWidth] of WIDTHS) {
        for (const theme of Object.keys(THEMES)) {
          for (const locale of LOCALES) {
            const id = `${paneWidth}/${productWidth}/${theme}/${locale}`
            const html = join(work, `page-${paneWidth}-${productWidth}-${theme}-${locale}.html`)
            writeFileSync(html, `<!doctype html><html><head><meta charset="utf-8"><style>
:root{${THEMES[theme].tokens}}
body{margin:0;background:${THEMES[theme].background};font:400 13px/1.5 system-ui,sans-serif}
#app{display:grid;gap:12px;padding:10px;justify-items:start}
#pane-wrap{width:${paneWidth}px}
#product-case{width:${productWidth}px;height:440px}
#tooltip-layout-result{display:none}
</style></head><body><div id="app"></div><div id="tooltip-layout-result"></div>
<script>globalThis.__tooltipLocale=${JSON.stringify(locale)}</script>
<script>${await import('node:fs').then(fs => fs.readFileSync(bundle, 'utf8'))}</script></body></html>`)
            const dom = execFileSync(chrome, [
              '--headless', '--disable-gpu', '--no-sandbox',
              `--user-data-dir=${join(work, `chrome-profile-${runs}`)}`,
              '--window-size=1000,900',
              '--virtual-time-budget=12000', '--dump-dom', `file://${html}`,
            ], { maxBuffer: 64 * 1024 * 1024, timeout: 90000 }).toString()
            runs += 1
            const match = dom.match(/<div id="tooltip-layout-result"[^>]*>([^<]*)<\/div>/)
            assert.ok(match && match[1], `[${id}] the page script must record a result`)
            const result = JSON.parse(match[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&'))
            assert.equal(result.error, undefined, `[${id}] page script error: ${result.error}`)
            assert.equal(result.paneFound, true, `[${id}] the Meter pane renders`)
            assert.equal(result.productFound, true, `[${id}] the product surface renders`)
            assert.ok(Math.abs(result.paneWidth - paneWidth) <= 2,
              `[${id}] pane is ~${paneWidth}px (got ${result.paneWidth})`)
            assert.ok(Math.abs(result.productWidth - productWidth) <= 2,
              `[${id}] product is ~${productWidth}px (got ${result.productWidth})`)
            assert.equal(result.locale, locale, `[${id}] locale wires through`)
            backgrounds[`${theme}/${locale}/${paneWidth}`] = result.lastBackground

            const checkTip = (tipId, tip, surface) => {
              const tag = `[${id}] ${tipId}`
              assert.equal(tip?.buttonFound, true, `${tag} help button renders`)
              assert.deepEqual(tip.buttonBox, { width: 24, height: 24 },
                `${tag} keeps a 24px accessible target (got ${JSON.stringify(tip.buttonBox)})`)
              assert.equal(tip.hoverOpened, true, `hover opens ${tag}`)
              assert.equal(tip.focusMovedOnHover, false, `hover moves no focus for ${tag}`)
              assert.equal(tip.hoverClosed, true, `moving away closes ${tag}`)
              assert.equal(tip.focusedButton, true, `${tag} trigger takes keyboard focus`)
              assert.equal(tip.tooltipOpened, true, `focus opens ${tag}`)
              assert.equal(tip.opaque, true, `${tag} background is opaque`)
              assert.equal(tip.withinScope, true,
                `${tag} stays inside the ${surface} (pop ${JSON.stringify(tip.popRect)})`)
              assert.equal(tip.withinViewport, true,
                `${tag} stays inside the viewport (pop ${JSON.stringify(tip.popRect)})`)
              assert.equal(tip.scrollWidthDelta, 0, `opening ${tag} grows no horizontal scrollbar`)
              assert.equal(tip.scrollHeightDelta, 0, `opening ${tag} grows no vertical scrollbar`)
              assert.equal(tip.focusWithinScope, true, `focus-opened ${tag} stays inside the ${surface}`)
              assert.equal(tip.escapeClosed, true, `Escape closes ${tag}`)
              assert.equal(tip.focusRetained, true, `focus remains on the ${tag} help button after Escape`)
              assert.equal(tip.expandedAfterEscape, true, `Escape clears aria-expanded for ${tag}`)
              assert.equal(tip.reopened, true, `hover reopens ${tag}`)
              assert.equal(tip.scopeEscapeClosed, true,
                `Escape elsewhere in the scope dismisses ${tag}`)
              assert.equal(tip.navigations, 0, `Escape never navigates while ${tag} is involved`)
            }
            for (const tipId of ['rates-source', 'savings-method', 'cost-source', 'cache-method']) {
              const tip = result.tooltips[tipId]
              checkTip(tipId, tip, 'pane')
              if (tipId === 'rates-source') {
                // The 260px content cap plus 22px padding/border is reduced by
                // the pane and card insets on narrow panes.
                const expectedWidth = Math.min(282, result.paneWidth - 28)
                assert.ok(Math.abs(tip.popRect.width - expectedWidth) <= 2,
                  `[${id}] rates-source width is ~${expectedWidth}px for this pane (got ${tip.popRect.width}px)`)
              }
            }
            for (const tipId of ['budgets-overview', 'wp02-edge-right', 'wp02-edge-bottom']) {
              checkTip(tipId, result.tooltips[tipId], 'product container')
            }
            // Rendered copy follows the locale through the shared primitive.
            const ratesText = result.tooltips['rates-source'].text
            const budgetText = result.tooltips['budgets-overview'].text
            if (locale === 'en') {
              assert.match(ratesText, /catalogue card/, `[${id}] English rates copy renders`)
              assert.match(budgetText, /Advisory limits/, `[${id}] English budget copy renders`)
              assert.equal(result.markers.info, 'More information', `[${id}] English info label`)
            } else {
              assert.match(ratesText, /目录卡/, `[${id}] Chinese rates copy renders`)
              assert.match(budgetText, /仅提供建议/, `[${id}] Chinese budget copy renders`)
              assert.equal(result.markers.info, '更多信息', `[${id}] Chinese info label`)
            }
            assert.equal(result.hostCalls, 0, `[${id}] no host/gateway calls were made`)
            assert.equal(result.navigations, 0, `[${id}] no navigation happened`)
          }
        }
      }
      assert.equal(runs, WIDTHS.length * 2 * LOCALES.length, 'every width/theme/locale combination ran')
      const darkBg = backgrounds['dark/en/268']
      const lightBg = backgrounds['light/en/268']
      assert.ok(darkBg && lightBg, 'both themes record a popover background')
      assert.notEqual(darkBg, lightBg, `host themes resolve differently (${darkBg} vs ${lightBg})`)

      const screenshotDir = process.env.TOOLTIP_LAYOUT_SHOT_DIR
      if (screenshotDir) {
        mkdirSync(screenshotDir, { recursive: true })
        const bundleSource = await import('node:fs').then(fs => fs.readFileSync(bundle, 'utf8'))
        for (const theme of Object.keys(THEMES)) {
          for (const locale of LOCALES) {
            for (const [shot, paneW, productW] of [['rates-source', 380, 380], ['wp02-edge-bottom', 380, 900]]) {
              const html = join(work, `shot-${theme}-${locale}-${shot}.html`)
              writeFileSync(html, `<!doctype html><html><head><meta charset="utf-8"><style>
:root{${THEMES[theme].tokens}}
body{margin:0;background:${THEMES[theme].background};font:400 13px/1.5 system-ui,sans-serif}
#app{display:grid;gap:12px;padding:10px;justify-items:start}
#pane-wrap{width:${paneW}px}
#product-case{width:${productW}px;height:440px}
#tooltip-layout-result{display:none}
</style></head><body><div id="app"></div><div id="tooltip-layout-result"></div>
<script>globalThis.__tooltipLocale=${JSON.stringify(locale)}</script>
<script>${bundleSource}</script></body></html>`)
              execFileSync(chrome, [
                '--headless', '--disable-gpu', '--no-sandbox',
                `--user-data-dir=${join(work, `chrome-shot-${theme}-${locale}-${shot}`)}`,
                '--window-size=1000,900', '--virtual-time-budget=12000',
                `--screenshot=${join(screenshotDir, `tooltip-${theme}-${locale}-${shot}.png`)}`,
                `${pathToFileURL(html).href}?shot=${shot}`,
              ], { timeout: 90000, stdio: 'ignore' })
            }
          }
        }
      }
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })
}
