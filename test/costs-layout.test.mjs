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

test('Costs keeps mixed financial evidence scannable at 380px and 1200px in both themes', {
  skip: CHROME ? false : 'No Chromium binary available for real Costs layout checks',
}, async () => {
  const work = mkdtempSync(join(tmpdir(), 'wm-costs-layout-'))
  try {
    const esbuild = (await import(pathToFileURL(join(MODULES, 'esbuild/lib/main.js')).href)).default
    const bundle = join(work, 'page.js')
    await esbuild.build({
      entryPoints: [join(ROOT, 'test/costs-layout.page.jsx')], bundle: true,
      format: 'iife', platform: 'browser', outfile: bundle, jsx: 'automatic',
      alias: { '@hermes/plugin-sdk': join(ROOT, 'test/overview-layout.sdk.mjs') },
      nodePaths: [MODULES], logLevel: 'warning',
    })
    const html = join(work, 'page.html')
    writeFileSync(html, `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box}body{margin:0;padding:10px;display:grid;grid-template-columns:380px 1200px;gap:10px;align-items:start;font:13px/1.5 system-ui,sans-serif}
.case{height:1800px;overflow:auto;background:var(--ui-fill-primary);color:var(--ui-text-primary)}
.case.dark{--ui-fill-primary:#12141a;--ui-fill-secondary:#1a1d26;--ui-fill-tertiary:#232633;--ui-stroke-secondary:#2b2f40;--ui-text-primary:#eef0f6;--ui-text-secondary:#b9bdd1;--ui-text-tertiary:#a9aec6;--ui-text-quaternary:#9398b0;--ui-accent:#7fa0ff;--ui-success:#2dd4bf;--ui-warning:#f5b544;--ui-error:#f26d6d}
.case.light{--ui-fill-primary:#fff;--ui-fill-secondary:#f2f4f7;--ui-fill-tertiary:#e3e5eb;--ui-stroke-secondary:#c5cbd5;--ui-text-primary:#151823;--ui-text-secondary:#414655;--ui-text-tertiary:#555b69;--ui-text-quaternary:#626877;--ui-accent:#3157c0;--ui-success:#087f5b;--ui-warning:#9a5e00;--ui-error:#b42318}
body[data-single]{display:block;padding:0}body[data-single="dark"]{background:#12141a}body[data-single="light"]{background:#fff}
body[data-single] .case{height:auto;min-height:100vh;overflow:visible;margin:0 auto}
#costs-layout-result{display:none}
</style></head><body><div id="costs-layout-cases"></div><div id="costs-layout-result"></div>
<script>${readFileSync(bundle, 'utf8')}</script><script>
const name=new URLSearchParams(location.search).get('case');if(name){document.body.dataset.single=name.endsWith('dark')?'dark':'light';document.getElementById('costs-layout-cases').style.display='block'}
</script></body></html>`)
    const url = pathToFileURL(html).href
    const dom = execFileSync(CHROME, [
      '--headless', '--disable-gpu', '--no-sandbox', `--user-data-dir=${join(work, 'chrome-profile')}`,
      '--virtual-time-budget=5000', '--dump-dom', url,
    ], { maxBuffer: 64 * 1024 * 1024, timeout: 90000 }).toString()
    const match = dom.match(/<div id="costs-layout-result"[^>]*>([^<]*)<\/div>/)
    assert.ok(match?.[1], 'Chromium records Costs layout results')
    const result = JSON.parse(match[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&gt;/g, '>').replace(/&lt;/g, '<'))
    assert.equal(result.layouts.length, 4)
    for (const layout of result.layouts) {
      assert.equal(layout.columns, layout.width <= 760 ? 2 : 3, layout.id)
      assert.deepEqual(layout.overflow, [], `${layout.id} has no overflowing cards or sections`)
      assert.match(layout.api, /\$0\.00/, `${layout.id} preserves zero API-equivalent value`)
      assert.match(layout.provider, /\$0\.00/, `${layout.id} preserves zero provider-reported value`)
      assert.match(layout.charges, /Not recorded/, `${layout.id} distinguishes missing charge evidence`)
      assert.doesNotMatch(layout.charges, /\$0\.00/, `${layout.id} never displays missing charges as zero`)
      assert.match(layout.fees, /£20\.00\/mo/, `${layout.id} shows GBP fee and its period`)
      assert.match(layout.fees, /\$0\.00\/mo/, `${layout.id} shows zero USD fee`)
      assert.match(layout.fees, /fee unknown/, `${layout.id} marks the subtotal partial`)
      assert.equal(layout.feeLines.length, 2, `${layout.id} keeps currencies and periods on separate lines`)
      assert.match(layout.cache, /\$0\.00/, `${layout.id} preserves zero cache impact`)
      assert.match(layout.cache, /Partial/, `${layout.id} exposes incomplete cache pricing coverage`)
      assert.match(layout.allowances, /1 limit/, `${layout.id} distinguishes plan limits from spend`)
      assert.match(layout.text, /Fees vs usage by currency/, `${layout.id} keeps the currency comparison visual`)
      assert.equal(layout.comparisons, 2, `${layout.id} renders labelled fee and API-equivalent bars`)
      assert.equal(layout.closedDetails, true, `${layout.id} keeps detailed evidence in closed disclosures`)
    }
    assert.equal(result.interactions.closedBeforeAction, true)
    assert.equal(result.interactions.fxOpensFromBlocker, true, 'the dated-FX blocker opens its settings disclosure')
    assert.equal(result.interactions.fxActionReceivesFocus, true, 'the opened FX disclosure receives keyboard focus')
    assert.notEqual(result.layouts[0].background, result.layouts[2].background, 'dark and light host fills differ')
    assert.notEqual(result.layouts[0].foreground, result.layouts[2].foreground, 'dark and light text colours differ')

    const screenshotDir = process.env.COSTS_LAYOUT_SHOT_DIR
    if (screenshotDir) {
      mkdirSync(screenshotDir, { recursive: true })
      for (const id of ['narrow-dark', 'wide-dark', 'narrow-light', 'wide-light']) {
        const width = id.startsWith('narrow') ? 420 : 1240
        const height = id.startsWith('narrow') ? 2400 : 1500
        execFileSync(CHROME, [
          '--headless', '--disable-gpu', '--no-sandbox', `--user-data-dir=${join(work, `chrome-shot-${id}`)}`,
          '--virtual-time-budget=5000', `--window-size=${width},${height}`,
          `--screenshot=${join(screenshotDir, `costs-${id}.png`)}`, `${url}?case=${id}`,
        ], { timeout: 90000, stdio: 'ignore' })
      }
    }
  } finally { rmSync(work, { recursive: true, force: true }) }
})
