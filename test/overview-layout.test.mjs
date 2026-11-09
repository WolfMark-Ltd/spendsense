import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

test('Overview keeps its summary, attention and model panels readable at 380px and 1200px in both themes', {
  skip: CHROME ? false : 'No Chromium binary available for real Overview layout checks',
}, async () => {
  const work = mkdtempSync(join(tmpdir(), 'wm-overview-layout-'))
  try {
    const esbuild = (await import(pathToFileURL(join(MODULES, 'esbuild/lib/main.js')).href)).default
    const bundle = join(work, 'page.js')
    await esbuild.build({
      entryPoints: [join(ROOT, 'test/overview-layout.page.jsx')], bundle: true,
      format: 'iife', platform: 'browser', outfile: bundle, jsx: 'automatic',
      alias: { '@hermes/plugin-sdk': join(ROOT, 'test/overview-layout.sdk.mjs') },
      nodePaths: [MODULES], logLevel: 'warning',
    })
    const html = join(work, 'page.html')
    writeFileSync(html, `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box}body{margin:0;padding:10px;display:grid;grid-template-columns:380px 1200px;gap:10px;align-items:start;font:13px/1.5 system-ui,sans-serif}
.case{height:1320px;overflow:auto;background:var(--ui-fill-primary);color:var(--ui-text-primary)}
.case.dark{--ui-fill-primary:#12141a;--ui-fill-secondary:#1a1d26;--ui-fill-tertiary:#232633;--ui-stroke-secondary:#2b2f40;--ui-text-primary:#eef0f6;--ui-text-secondary:#b9bdd1;--ui-text-tertiary:#a9aec6;--ui-text-quaternary:#9398b0;--ui-accent:#7fa0ff;--ui-success:#2dd4bf;--ui-warning:#f5b544;--ui-error:#f26d6d}
.case.light{--ui-fill-primary:#fff;--ui-fill-secondary:#f2f4f7;--ui-fill-tertiary:#e3e5eb;--ui-stroke-secondary:#c5cbd5;--ui-text-primary:#151823;--ui-text-secondary:#414655;--ui-text-tertiary:#555b69;--ui-text-quaternary:#626877;--ui-accent:#3157c0;--ui-success:#087f5b;--ui-warning:#9a5e00;--ui-error:#b42318}
body[data-single]{display:block;padding:0}body[data-single="dark"]{background:#12141a}body[data-single="light"]{background:#fff}
body[data-single] .case{height:auto;min-height:100vh;overflow:visible;margin:0 auto}
#overview-layout-result{display:none}
</style></head><body><div id="overview-layout-cases"></div><div id="overview-layout-result"></div>
<script>${readFileSync(bundle, 'utf8')}</script><script>
const name=new URLSearchParams(location.search).get('case');if(name){document.body.dataset.single=name.endsWith('dark')?'dark':'light';const cases=document.getElementById('overview-layout-cases');cases.style.display='block';cases.style.gridTemplateColumns='none'}
</script></body></html>`)
    const url = pathToFileURL(html).href
    const dom = execFileSync(CHROME, [
      '--headless', '--disable-gpu', '--no-sandbox', '--virtual-time-budget=5000', '--dump-dom', url,
    ], { maxBuffer: 64 * 1024 * 1024, timeout: 90000 }).toString()
    const match = dom.match(/<div id="overview-layout-result"[^>]*>([^<]*)<\/div>/)
    assert.ok(match?.[1], 'Chromium records Overview layout results')
    const result = JSON.parse(match[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&gt;/g, '>').replace(/&lt;/g, '<'))
    assert.equal(result.layouts.length, 4)
    for (const layout of result.layouts) {
      assert.notEqual(layout.missingOverview, true, `${layout.id} renders Overview panels: ${layout.errors?.join('\n')}`)
      assert.equal(layout.cards, 4, layout.id)
      assert.equal(layout.summaryColumns, layout.width <= 620 ? 1 : 2, layout.id)
      assert.equal(layout.panelColumns, layout.width <= 760 ? 1 : 2, layout.id)
      assert.deepEqual(layout.overflow, [], `${layout.id} has no overflowing card content`)
      assert.match(layout.text, /Not recorded/, `${layout.id} preserves missing charge evidence`)
      assert.match(layout.text, /lower bound/, `${layout.id} preserves the API-equivalent lower bound`)
      assert.match(layout.text, /Actual provider charges/, `${layout.id} labels actual charges separately`)
      assert.match(layout.text, /Most-used models/, `${layout.id} renders the call-count insight`)
      assert.match(layout.text, /£20\.00\/mo/, `${layout.id} preserves GBP and its billing period`)
      assert.match(layout.text, /Unknown/, `${layout.id} retains the unknown account fee`)
    }
    assert.notEqual(result.layouts[0].background, result.layouts[2].background, 'dark and light host fills differ')
    assert.notEqual(result.layouts[0].foreground, result.layouts[2].foreground, 'dark and light text colours differ')

    const screenshotDir = process.env.OVERVIEW_LAYOUT_SHOT_DIR
    if (screenshotDir) {
      mkdirSync(screenshotDir, { recursive: true })
      for (const id of ['narrow-dark', 'wide-dark', 'narrow-light', 'wide-light']) {
        const width = id.startsWith('narrow') ? 420 : 1240
        const height = id.startsWith('narrow') ? 2400 : 1400
        execFileSync(CHROME, [
          '--headless', '--disable-gpu', '--no-sandbox', '--virtual-time-budget=5000',
          `--window-size=${width},${height}`, `--screenshot=${join(screenshotDir, `overview-${id}.png`)}`,
          `${url}?case=${id}`,
        ], { timeout: 90000, stdio: 'ignore' })
      }
    }
  } finally { rmSync(work, { recursive: true, force: true }) }
})
