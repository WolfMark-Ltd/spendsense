import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const MODULES = join(ROOT, 'test/harness/node_modules')
const CHROME = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].find(existsSync)

test('Hermes sidebar keeps the model and net cache evidence readable from 268px to 500px', {
  skip: CHROME ? false : 'No Chromium binary available for real sidebar layout checks',
}, async () => {
  const work = mkdtempSync(join(tmpdir(), 'wm-sidebar-layout-'))
  try {
    const esbuild = (await import(pathToFileURL(join(MODULES, 'esbuild/lib/main.js')).href)).default
    const bundle = join(work, 'page.js')
    await esbuild.build({
      entryPoints: [join(ROOT, 'test/sidebar-layout.page.jsx')], bundle: true,
      format: 'iife', platform: 'browser', outfile: bundle, jsx: 'automatic',
      alias: {
        '@hermes/plugin-sdk': join(ROOT, 'test/harness/real-sdk.mjs'),
        react: join(MODULES, 'react'),
        'react-dom': join(MODULES, 'react-dom'),
      },
      nodePaths: [MODULES], logLevel: 'warning',
    })
    const html = join(work, 'page.html')
    writeFileSync(html, `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box}html,body{margin:0;min-height:100%;font:13px/1.5 system-ui,sans-serif}body{padding:12px;background:#e7e9ee;color:#151823}
#sidebar-layout-cases{display:grid;grid-template-columns:repeat(3,max-content);gap:12px;align-items:start}
.case{overflow:hidden;background:var(--ui-fill-primary);color:var(--ui-text-primary)}
.case.dark{--ui-fill-primary:#12141a;--ui-fill-secondary:#1a1d26;--ui-fill-tertiary:#232633;--ui-stroke-secondary:#2b2f40;--ui-text-primary:#eef0f6;--ui-text-secondary:#b9bdd1;--ui-text-tertiary:#a9aec6;--ui-text-quaternary:#9398b0;--ui-accent:#7fa0ff;--ui-success:#2dd4bf;--ui-warning:#f5b544;--ui-error:#f26d6d}
.case.light{--ui-fill-primary:#fff;--ui-fill-secondary:#f2f4f7;--ui-fill-tertiary:#e3e5eb;--ui-stroke-secondary:#c5cbd5;--ui-text-primary:#151823;--ui-text-secondary:#414655;--ui-text-tertiary:#555b69;--ui-text-quaternary:#626877;--ui-accent:#3157c0;--ui-success:#087f5b;--ui-warning:#9a5e00;--ui-error:#b42318}
body[data-single]{padding:0;background:var(--ui-fill-primary)}body[data-single] #sidebar-layout-cases{display:block}body[data-single] .case{margin:0}
</style></head><body><div id="sidebar-layout-cases"></div><div id="sidebar-layout-result"></div>
<script>${readFileSync(bundle, 'utf8')}</script></body></html>`)
    const url = pathToFileURL(html).href
    const run = locale => {
      const dom = execFileSync(CHROME, [
        '--headless', '--disable-gpu', '--no-sandbox', `--user-data-dir=${join(work, `chrome-${locale}`)}`,
        '--virtual-time-budget=5000', '--dump-dom', `${url}?all=1&locale=${locale}&state=partial`,
      ], { maxBuffer: 32 * 1024 * 1024, timeout: 120000 }).toString()
      const match = dom.match(/<div id="sidebar-layout-result"[^>]*>(.*?)<\/div>/s)
      assert.ok(match?.[1], `Chromium records sidebar layout results (${locale})`)
      return JSON.parse(match[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&'))
    }

    for (const locale of ['en', 'zh-CN']) {
      const result = run(locale)
      assert.deepEqual(result.errors, [], `no browser errors (${locale})`)
      assert.equal(result.layouts.length, 12, `six widths/heights in both themes (${locale})`)
      for (const layout of result.layouts) {
        const id = `${locale}/${layout.id}`
        assert.equal(layout.model, 'DeepSeek V4.1 Flash', `${id} shows a readable model name`)
        assert.equal(layout.modelId, 'deepseek/deepseek-v4.1-flash', `${id} retains the exact model ID`)
        assert.equal(layout.modelOverflow, 0, `${id} wraps the model within its row`)
        assert.ok(layout.tooltipMetrics.length >= 4, `${id} renders the expected sidebar tooltip controls`)
        for (const [index, tip] of layout.tooltipMetrics.entries()) {
          assert.equal(tip.hitWidth, 24, `${id}/tip${index} keeps the accessible hit width`)
          assert.equal(tip.hitHeight, 24, `${id}/tip${index} keeps the accessible hit height`)
          assert.equal(tip.ringWidth, 12, `${id}/tip${index} uses the smaller shared ring`)
          assert.equal(tip.glyphFontSize, 8, `${id}/tip${index} keeps the small information glyph`)
        }
        assert.equal(layout.provider, 'commandcode', `${id} keeps the provider separate`)
        assert.equal(layout.providerSeparate, true, `${id} puts the provider on its own line`)
        assert.ok(layout.ringWidth >= 52 && layout.ringWidth <= 72, `${id} scales the ring to ${layout.ringWidth}px`)
        assert.match(layout.savedLabel, locale === 'en' ? /Theoretical net savings/ : /理论净节省/,
          `${id} labels the theoretical estimate`)
        assert.ok(layout.savedValue.includes('≈'), `${id} marks a partial subtotal`)
        assert.match(layout.savedNote, locale === 'en' ? /70%/ : /70%/,
          `${id} states the measured prompt coverage`)
        assert.equal(layout.labelOverflow, 0, `${id} keeps the savings label inside its column`)
        assert.equal(layout.valueOverflow, 0, `${id} keeps the amount and qualifier together`)
        assert.equal(layout.noteOverflow, 0, `${id} wraps the coverage note`)
        assert.equal(layout.labelValueOverlap, false, `${id} keeps label and amount distinct`)
        assert.equal(layout.contentsWithinCard, true, `${id} keeps label, amount and note inside the card`)
        assert.equal(layout.horizontalOverflow, 0, `${id} has no horizontal pane overflow`)
        assert.equal(layout.openSpendSense, locale === 'en' ? 'Open SpendSense' : '打开 SpendSense',
          `${id} retains the existing navigation action`)
      }
      for (const theme of ['dark', 'light']) for (const height of [650, 800]) {
        const ringWidths = [268, 350, 500].map(width => result.layouts.find(layout =>
          layout.id === `${width}-${height}-${theme}`).ringWidth)
        assert.ok(ringWidths[0] < ringWidths[1] && ringWidths[1] < ringWidths[2],
          `${locale}/${theme}/${height} scales the ring with sidebar width: ${ringWidths.join(' → ')}`)
      }
      const scroll = result.layouts.map(layout => `${layout.width}x${layout.height}:${layout.scrollDelta}px`).join(', ')
      console.log(`Sidebar vertical scroll depth (${locale}): ${scroll}`)
    }

    const screenshotDir = process.env.SIDEBAR_LAYOUT_SHOT_DIR
    if (screenshotDir) {
      mkdirSync(screenshotDir, { recursive: true })
      for (const [width, height, theme] of [[268, 650, 'dark'], [268, 800, 'light'], [500, 650, 'light'], [500, 800, 'dark']]) {
        const name = `sidebar-en-${width}x${height}-${theme}.png`
        const screenshot = join(screenshotDir, name)
        const profile = join(work, `shot-${width}-${height}-${theme}`)
        execFileSync(CHROME, [
          '--headless', '--disable-gpu', '--no-sandbox', `--user-data-dir=${profile}`,
          '--virtual-time-budget=5000', `--window-size=${width},${height}`,
          `--screenshot=${screenshot}`,
          `${url}?case=${width}-${height}-${theme}&width=${width}&height=${height}&theme=${theme}&locale=en&state=partial`,
        ], { timeout: 120000, stdio: 'ignore' })
        assert.ok(existsSync(screenshot) && statSync(screenshot).size > 0, `writes ${name}`)
      }
    }
  } finally { rmSync(work, { recursive: true, force: true }) }
})
