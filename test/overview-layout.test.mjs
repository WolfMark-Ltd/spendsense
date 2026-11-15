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

test('Overview keeps truthful, compact layouts across widths, themes and locales', {
  skip: CHROME ? false : 'No Chromium binary available for real Overview layout checks',
  timeout: 120000,
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
.case.dark{color-scheme:dark;--ui-fill-primary:#12141a;--ui-fill-secondary:#1a1d26;--ui-fill-tertiary:#232633;--ui-stroke-secondary:#2b2f40;--ui-text-primary:#eef0f6;--ui-text-secondary:#b9bdd1;--ui-text-tertiary:#a9aec6;--ui-text-quaternary:#9398b0;--ui-accent:#7fa0ff;--ui-success:#2dd4bf;--ui-warning:#f5b544;--ui-error:#f26d6d}
.case.light{color-scheme:light;--ui-fill-primary:#fff;--ui-fill-secondary:#f2f4f7;--ui-fill-tertiary:#e3e5eb;--ui-stroke-secondary:#c5cbd5;--ui-text-primary:#151823;--ui-text-secondary:#414655;--ui-text-tertiary:#555b69;--ui-text-quaternary:#626877;--ui-accent:#3157c0;--ui-success:#087f5b;--ui-warning:#9a5e00;--ui-error:#b42318}
body[data-single]{display:block;padding:0}body[data-single="dark"]{background:#12141a}body[data-single="light"]{background:#fff}
body[data-single] .case{height:auto;min-height:100vh;overflow:visible;margin:0 auto}
#overview-layout-result{display:none}
</style></head><body><div id="overview-layout-cases"></div><div id="overview-layout-result"></div>
<script>globalThis.__overviewLocale=new URLSearchParams(location.search).get('locale')||'en'</script>
<script>${readFileSync(bundle, 'utf8')}</script><script>
const name=new URLSearchParams(location.search).get('case');if(name){document.body.dataset.single=name.endsWith('dark')?'dark':'light';const cases=document.getElementById('overview-layout-cases');cases.style.display='block';cases.style.gridTemplateColumns='none'}
</script></body></html>`)
    const url = pathToFileURL(html).href
    const results = {}
    for (const locale of ['en', 'zh']) {
      const dom = execFileSync(CHROME, [
        '--headless', '--disable-gpu', '--no-sandbox', `--user-data-dir=${join(work, `chrome-profile-${locale}`)}`,
        '--virtual-time-budget=5000', '--dump-dom', `${url}?locale=${locale}`,
      ], { maxBuffer: 64 * 1024 * 1024, timeout: 90000 }).toString()
      const match = dom.match(/<div id="overview-layout-result"[^>]*>([^<]*)<\/div>/)
      assert.ok(match?.[1], `[${locale}] Chromium records Overview layout results`)
      const result = JSON.parse(match[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&gt;/g, '>').replace(/&lt;/g, '<'))
      assert.equal(result.layouts.length, 6, `[${locale}] every width and theme is rendered`)
      for (const layout of result.layouts) {
        const tag = `[${locale}/${layout.id}]`
        assert.notEqual(layout.missingOverview, true, `${tag} renders Overview panels: ${layout.errors?.join('\n')}`)
        assert.equal(layout.locale, locale, `${tag} uses the requested language`)
        assert.equal(layout.cards, 4, tag)
        assert.ok(layout.paneOverflow <= 1, `${tag} product container has no horizontal scroll`)
        if (layout.documentOverflow !== null) assert.ok(layout.documentOverflow <= 1, `${tag} document has no horizontal scroll`)
        assert.equal(layout.summaryColumns, layout.width <= 340 ? 1 : layout.width >= 1020 ? 4 : 2, tag)
        assert.equal(layout.panelColumns, layout.width <= 760 ? 1 : 2, tag)
        assert.deepEqual(layout.overflow, [], `${tag} has no overflowing card content`)
        assert.equal(layout.methodsCollapsed, true, `${tag} keeps methodology collapsed by default`)
        assert.equal(layout.methodSections, 5, `${tag} provides five named methodology sections`)
        assert.ok(layout.kpiHeights.every(height => height < (layout.width >= 1020 ? 220 : 260)),
          `${tag} KPI cards use their natural content height (${JSON.stringify(layout.kpiDetails)})`)
        assert.equal(layout.sticky.position, 'sticky', `${tag} keeps sticky navigation`)
        assert.equal(layout.sticky.zIndex, '30', `${tag} keeps navigation above page content`)
        assert.match(layout.sticky.backgroundImage, /linear-gradient/, `${tag} gives sticky navigation an opaque underlay`)
        assert.equal(layout.sticky.top, 0, `${tag} navigation remains pinned at the scroller top`)
        assert.match(layout.charges, locale === 'en' ? /Not recorded/ : /未记录/, `${tag} preserves missing charge evidence`)
        assert.match(layout.charges, locale === 'en' ? /per-call actual-charge evidence is not in analytics/i : /逐次调用的实际费用证据/, tag)
        assert.doesNotMatch(layout.charges, /covers|\b\d+ of \d+ records\b/i, `${tag} does not infer charge coverage`)
        assert.match(layout.recorded, locale === 'en' ? /all profiles.*calendar month to date/i : /所有配置文件.*本日历月至今/, tag)
        assert.match(layout.estimate, locale === 'en' ? /active profile.*rolling 30 days/i : /当前配置文件.*滚动 30 天/, tag)
        assert.match(layout.text, locale === 'en' ? /do not add them together/i : /请勿相加/, `${tag} explains the scope difference`)
        assert.match(layout.recorded, locale === 'en' ? /At least/ : /至少/, `${tag} preserves partial lower-bound wording`)
        assert.match(layout.text, locale === 'en' ? /Actual provider charges/ : /实际服务商费用/, `${tag} labels charges separately`)
        assert.match(layout.text, locale === 'en' ? /Most-used models/ : /使用最多的模型/, `${tag} renders the call-count insight`)
        assert.match(layout.text, locale === 'en' ? /GBP 20\.00\/mo/ : /GBP 20\.00\/月/, `${tag} preserves GBP and its billing period`)
        assert.match(layout.fees, locale === 'en' ? /fee unknown; excluded/i : /费用未知；未计入/, `${tag} explains the excluded unknown fee`)
        assert.match(layout.fees, locale === 'en' ? /Partial/ : /部分/, `${tag} marks the known-fee subtotal partial`)
        assert.equal(layout.modelLabels[0], 'GPT 5.1 Codex Super Long Model Name For Wrapping', `${tag} shows the friendly model name`)
        assert.equal(layout.modelDetails.length, 2, `${tag} keeps exact model IDs available through help controls`)
      }
      assert.notEqual(result.layouts[0].background, result.layouts[1].background, `[${locale}] dark and light host fills differ`)
      assert.notEqual(result.layouts[0].foreground, result.layouts[1].foreground, `[${locale}] dark and light text colours differ`)
      results[locale] = result
    }

    const screenshotDir = process.env.OVERVIEW_LAYOUT_SHOT_DIR
    if (screenshotDir) {
      mkdirSync(screenshotDir, { recursive: true })
      const shots = [
        ...[268, 380, 1200].flatMap(width => ['dark', 'light'].map(theme => [`w${width}-${theme}`, 'en'])),
        ['w380-light', 'zh'], ['w1200-light', 'zh'],
      ]
      for (const [id, locale] of shots) {
        const width = Number(id.match(/^w(\d+)-/)?.[1]) + 40
        const height = width < 500 ? 2400 : 1600
        const filename = `overview-${id}-${locale}.png`
        execFileSync(CHROME, [
          '--headless', '--disable-gpu', '--no-sandbox', `--user-data-dir=${join(work, `chrome-shot-${id}-${locale}`)}`,
          '--virtual-time-budget=5000',
          `--window-size=${width},${height}`, `--screenshot=${join(screenshotDir, filename)}`,
          `${url}?case=${id}&locale=${locale}`,
        ], { timeout: 90000, stdio: 'ignore' })
      }
    }
  } finally { rmSync(work, { recursive: true, force: true }) }
})
