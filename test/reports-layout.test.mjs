import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

test('Reports stays scannable and keyboard usable from 320px through ledger width', {
  skip: CHROME ? false : 'No Chromium binary available for real Reports layout checks',
}, async () => {
  const work = mkdtempSync(join(tmpdir(), 'wm-reports-layout-'))
  try {
    const esbuild = (await import(pathToFileURL(join(MODULES, 'esbuild/lib/main.js')).href)).default
    const bundle = join(work, 'page.js')
    await esbuild.build({
      entryPoints: [join(ROOT, 'test/reports-layout.page.jsx')], bundle: true,
      format: 'iife', platform: 'browser', outfile: bundle, jsx: 'automatic',
      alias: { '@hermes/plugin-sdk': join(ROOT, 'test/reports-layout.sdk.mjs') },
      nodePaths: [MODULES], logLevel: 'warning',
    })
    const html = join(work, 'page.html')
    writeFileSync(html, `<!doctype html><html><head><meta charset="utf-8"><style>
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
<script>${readFileSync(bundle, 'utf8')}</script></body></html>`)
    const url = pathToFileURL(html).href
    for (const locale of ['en', 'zh']) {
      for (const width of [320, 380, 560, 1200]) {
        const theme = locale === 'en' ? 'dark' : 'light'
        const days = width === 320 || width === 560 ? 7 : 30
        const dom = execFileSync(CHROME, [
          '--headless', '--disable-gpu', '--no-sandbox',
          `--user-data-dir=${join(work, `chrome-${locale}-${width}`)}`,
          '--virtual-time-budget=6000', `--window-size=${width},1800`, '--dump-dom',
          `${url}?locale=${locale}&days=${days}&theme=${theme}`,
        ], { maxBuffer: 16 * 1024 * 1024, timeout: 90000,
          stdio: ['ignore', 'pipe', 'ignore'] }).toString()
        const match = dom.match(/<div id="reports-layout-result"[^>]*>([^<]*)<\/div>/)
        assert.ok(match?.[1], `Chromium records ${locale}/${width}px layout`)
        const result = JSON.parse(match[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&'))
        const id = `${locale}/${width}px/${theme}`
        assert.deepEqual(result.errors, [], `${id} has no page errors`)
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
        assert.equal(result.previewPeriodCount, 1, `${id} shows one period heading in the preview`)
        assert.equal(result.feedbackGroup, true, `${id} labels the report action group`)
        assert.match(result.downloadLabel, locale === 'zh' ? /下载 Markdown/ : /Download Markdown/)
        assert.match(result.text, locale === 'zh' ? /没有服务商读数/ : /No provider reading/)
      }
    }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
})
