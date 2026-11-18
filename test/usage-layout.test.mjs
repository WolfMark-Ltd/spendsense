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

const CASES = ['narrow-dark', 'wide-dark', 'narrow-light', 'wide-light']

test('Usage and shared state paint work at 380px and 1200px in both themes and locales, with and without optional host tokens', {
  skip: CHROME ? false : 'No Chromium binary available for real Usage layout checks',
}, async () => {
  const work = mkdtempSync(join(tmpdir(), 'wm-usage-layout-'))
  try {
    const esbuild = (await import(pathToFileURL(join(MODULES, 'esbuild/lib/main.js')).href)).default
    const bundle = join(work, 'page.js')
    await esbuild.build({
      entryPoints: [join(ROOT, 'test/usage-layout.page.jsx')], bundle: true,
      format: 'iife', platform: 'browser', outfile: bundle, jsx: 'automatic',
      alias: { '@hermes/plugin-sdk': join(ROOT, 'test/usage-layout.sdk.mjs') },
      nodePaths: [MODULES], logLevel: 'warning',
    })
    const html = join(work, 'page.html')
    writeFileSync(html, `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box}body{margin:0;padding:10px;display:grid;grid-template-columns:380px 1200px;gap:10px;align-items:start;font:13px/1.5 system-ui,sans-serif}
.case{height:2200px;overflow:auto;background:var(--ui-fill-primary);color:var(--ui-text-primary)}
.case.dark{--ui-fill-primary:#12141a;--ui-fill-secondary:#1a1d26;--ui-fill-tertiary:#232633;--ui-stroke-secondary:#2b2f40;--ui-text-primary:#eef0f6;--ui-text-secondary:#b9bdd1;--ui-text-tertiary:#a9aec6;--ui-text-quaternary:#9398b0;--ui-accent:#7fa0ff;--ui-success:#2dd4bf}
body[data-state-tokens] .case.dark{--ui-warning:#f5b544;--ui-error:#f26d6d}
.case.light{--ui-fill-primary:#fff;--ui-fill-secondary:#f2f4f7;--ui-fill-tertiary:#e3e5eb;--ui-stroke-secondary:#c5cbd5;--ui-text-primary:#151823;--ui-text-secondary:#414655;--ui-text-tertiary:#555b69;--ui-text-quaternary:#626877;--ui-accent:#3157c0;--ui-success:#087f5b}
body[data-state-tokens] .case.light{--ui-warning:#9a5e00;--ui-error:#b42318}
body:not([data-state-tokens]) .case{--ui-fill-tertiary:initial}
.case.dark{--ui-bg-tertiary:#232633}.case.light{--ui-bg-tertiary:#e3e5eb}
body[data-single]{display:block;padding:0}body[data-single="dark"]{background:#12141a}body[data-single="light"]{background:#fff}
body[data-single] .case{height:auto;min-height:100vh;overflow:visible;margin:0 auto}
#usage-layout-result{display:none}
</style></head><body><div id="usage-layout-cases"></div><div id="usage-layout-result"></div>
<script>if(new URLSearchParams(location.search).get('stateTokens') !== 'absent') document.body.dataset.stateTokens = ''</script>
<script>${readFileSync(bundle, 'utf8')}</script></body></html>`)
    const url = pathToFileURL(html).href
    const run = (locale, stateTokens) => {
      const dom = execFileSync(CHROME, [
        '--headless', '--disable-gpu', '--no-sandbox', `--user-data-dir=${join(work, `chrome-profile-${locale}-${stateTokens}`)}`,
        '--virtual-time-budget=8000', '--dump-dom', `${url}?locale=${locale}&open=filters&stateTokens=${stateTokens}`,
      ], { maxBuffer: 64 * 1024 * 1024, timeout: 120000 }).toString()
      const match = dom.match(/<div id="usage-layout-result"[^>]*>([^<]*)<\/div>/)
      assert.ok(match?.[1], `Chromium records Usage layout results (${locale})`)
      return JSON.parse(match[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&gt;/g, '>').replace(/&lt;/g, '<'))
    }
    for (const [locale, stateTokens] of [
      ['en', 'present'], ['zh-CN', 'present'], ['en', 'absent'], ['zh-CN', 'absent'],
    ]) {
      const result = run(locale, stateTokens)
      assert.deepEqual(result.errors, [], `no page errors (${locale})`)
      assert.deepEqual(result.queryErrors, [], `no analytics query errors (${locale})`)
      assert.equal(result.layouts.length, 4, `four layouts (${locale})`)
      for (const layout of result.layouts) {
        const id = `${locale}/${layout.id}/${stateTokens}`
        assert.notEqual(layout.missingUsage, true, `${id} renders the Usage page`)
        assert.equal(layout.headingStart, locale === 'en' ? 'Usage analytics' : '用量分析', `${id} starts with the Usage title`)
        assert.deepEqual(layout.numbers, ['01', '02', '03', '04', '05', '06', '07'], `${id} numbers every section 01–07`)
        assert.equal(layout.sections, 7, `${id} renders seven panels`)
        assert.equal(layout.stats, 5, `${id} keeps five KPI stats`)
        assert.ok(layout.statGroups.length >= 2, `${id} groups KPIs with labelled separators`)
        assert.equal(layout.selects, 7, `${id} keeps all seven filters`)
        assert.equal(layout.advancedFilters, true, `${id} discloses advanced filters`)
        assert.equal(layout.advancedOpen, true, `${id} measures the advanced row expanded`)
        assert.equal(layout.advancedSelects, 4, `${id} keeps four advanced filters`)
        assert.match(layout.advancedSummary, /2/, `${id} counts two active advanced slices`)
        assert.deepEqual(layout.advancedRowOverlap, [], `${id} has no overlapping advanced filters`)
        assert.equal(layout.advancedRowOverflow, 0, `${id} keeps the advanced row inside its pane`)
        assert.ok(layout.stickyColumnWidth > 0 && layout.stickyColumnWidth < layout.tableViewportWidth,
          `${id} keeps the pinned model column inside the table viewport (${layout.stickyColumnWidth}/${layout.tableViewportWidth})`)
        assert.equal(layout.chips, 3, `${id} renders three active-filter chips`)
        assert.deepEqual(layout.filterOverlap, [], `${id} has no overlapping filters`)
        assert.deepEqual(layout.chipOverlap, [], `${id} has no overlapping chips`)
        assert.equal(layout.filtersOverflow, 0, `${id} keeps filters inside their row`)
        assert.equal(layout.statOverflow, 0, `${id} keeps KPI values inside their cards`)
        assert.doesNotMatch(layout.text, /× Close|× 关闭/, `${id} removes the redundant Close`)
        // Cache-read swatch (index 2) stays distinct from the other streams
        // and readable against the panel in both themes.
        const [input, output, read, write] = layout.chartKeySwatches
        for (const [name, swatch] of [['input', input], ['output', output], ['read', read], ['write', write]]) {
          assert.ok(swatch?.color, `${id} resolves a ${name} stream colour`)
        }
        const colours = new Set([input.color, output.color, read.color, write.color])
        assert.equal(colours.size, 4, `${id} keeps four distinct stream colours`)
        assert.ok(read.ratio >= 3, `${id} keeps cache-read readable (${read.ratio}:1)`)
        assert.equal(layout.chartPalette.length, 8, `${id} defines eight chart-series colours`)
        const paletteColours = layout.chartPalette.map(entry => entry?.color)
        assert.ok(paletteColours.every(Boolean), `${id} resolves every chart-series colour`)
        assert.equal(new Set(paletteColours).size, 8, `${id} keeps the broader chart palette distinct`)
        for (const entry of layout.chartPalette) {
          assert.ok(entry.ratio >= 3, `${id} keeps a chart colour distinct from the panel (${entry.ratio}:1)`)
        }
        assert.equal(layout.warningToken, stateTokens === 'present' ? (layout.id.endsWith('dark') ? '#f5b544' : '#9a5e00') : '', id)
        assert.notEqual(layout.cacheReadFill, 'rgb(0, 0, 0)', `${id} paints the cache-read SVG rect`)
        assert.equal(layout.cacheReadFill, read.color, `${id} uses the same paint for the bar and chart key`)
        for (const [chart, minimum] of Object.entries({
          distribution: 6, trend: 4, comparisons: 8, ranking: 8, composition: 5, doughnut: 5,
        })) {
          const paints = layout.chartPaint[chart]
          assert.ok(paints.length >= minimum, `${id} draws ${chart}`)
          for (const paint of paints) {
            assert.ok(paint && paint !== 'none' && paint !== 'rgba(0, 0, 0, 0)' &&
              paint !== 'rgb(0, 0, 0)' && !/^color\(srgb 0 0 0(?: |\))/.test(paint),
            `${id} ${chart} has visible, non-black paint: ${paint}`)
          }
        }
        assert.equal(layout.cacheReadStroke, read.color, `${id} paints the doughnut using the same cache-read colour`)
        const dark = layout.id.endsWith('dark')
        const accent = dark ? 'rgb(127, 160, 255)' : 'rgb(49, 87, 192)'
        const warning = stateTokens === 'present' ? (dark ? 'rgb(245, 181, 68)' : 'rgb(154, 94, 0)') : accent
        const error = stateTokens === 'present' ? (dark ? 'rgb(242, 109, 109)' : 'rgb(180, 35, 24)') : accent
        const success = dark ? 'rgb(45, 212, 191)' : 'rgb(8, 127, 91)'
        const { stateStyles } = layout
        assert.notEqual(stateStyles.pillBackground, 'rgba(0, 0, 0, 0)', `${id} paints the Costs attention count`)
        assert.ok(stateStyles.pillContrast >= 4.5, `${id} keeps the Costs attention count readable`)
        assert.equal(stateStyles.rail, `3px solid ${warning}`, `${id} paints the Memberships warning rail`)
        assert.equal(stateStyles.reportsRail, `3px solid ${error}`, `${id} preserves the WP32 Reports rail`)
        assert.ok(stateStyles.flash.startsWith(warning), `${id} paints the destination highlight`)
        assert.equal(stateStyles.partial, warning, `${id} styles the partial chip`)
        assert.equal(stateStyles.sidebarPartial, warning, `${id} styles the sidebar partial chip`)
        assert.equal(stateStyles.error, error, `${id} styles the error chip`)
        assert.equal(stateStyles.feedback, error, `${id} styles the error feedback`)
        assert.equal(stateStyles.success, success, `${id} preserves the success chip`)
        assert.equal(stateStyles.settingsWarning, warning, `${id} keeps Settings warning text visible in the attention colour`)
        assert.equal(stateStyles.confirmation, `1px solid ${warning}`, `${id} paints the Settings confirmation outline`)
        assert.equal(stateStyles.news, warning, `${id} styles the price increase badge`)
        // Exact chart values are reachable by hover (title) and focus (detail).
        assert.ok(layout.trendPoints > 0, `${id} renders trend points`)
        assert.equal(layout.trendTitles, layout.trendPoints, `${id} titles every trend point`)
        assert.ok(layout.legendRows > 0, `${id} renders legend rows`)
        assert.equal(layout.legendTitles, layout.legendRows, `${id} titles every legend row`)
        assert.match(layout.text, /72,000/, `${id} shows exact cache-read stream values`)
        assert.equal(layout.explorerColumns, 7, `${id} keeps the readable core explorer columns`)
        assert.equal(layout.firstColumnSticky, 'sticky', `${id} pins the explorer model column`)
        assert.equal(layout.methodologyOpen, false, `${id} keeps Methodology collapsed`)
        assert.equal(layout.baselineOpen, false, `${id} keeps Baseline collapsed`)
      }
      const interaction = result.interaction || {}
      assert.equal(interaction.chipsBefore, 3, `chip removal starts from three chips (${locale})`)
      assert.equal(interaction.chipsAfterSurface, 2, `removing the surface chip leaves two (${locale})`)
      assert.match(interaction.summaryAfterSurface || '', /1/, `the disclosure count drops to one (${locale})`)
      assert.equal(interaction.chipsAfterModel, 1, `removing the model chip leaves one (${locale})`)
      assert.equal(interaction.disclosureToggle, true, `the disclosure toggles closed and open (${locale})`)
      const wide = result.layouts.find(l => l.id === 'wide-dark')
      if (locale === 'en') {
        assert.match(wide.text, /Theoretical net savings/, 'WP06 cache-savings evidence survives')
        assert.match(wide.text, /Provider charges are not recorded/, 'WP05 billing honesty survives')
        assert.match(wide.text, /Partial/, 'partial coverage stays visible')
        assert.match(wide.text, /Billing classification/, 'recorded-cost classification stays visible')
        assert.match(wide.text, /Methodology & coverage details/, 'methodology disclosure stays available')
      } else {
        assert.match(wide.text, /缓存读取/, 'zh chart key translates cache read')
        assert.match(wide.text, /模型/, 'zh filter chips translate')
      }
    }

    const screenshotDir = process.env.USAGE_LAYOUT_SHOT_DIR
    if (screenshotDir) {
      mkdirSync(screenshotDir, { recursive: true })
      for (const locale of ['en', 'zh-CN']) {
        for (const id of CASES) {
          const width = id.startsWith('narrow') ? 420 : 1240
          const height = id.startsWith('narrow') ? 3600 : 2200
          execFileSync(CHROME, [
            '--headless', '--disable-gpu', '--no-sandbox', `--user-data-dir=${join(work, `chrome-shot-${locale}-${id}`)}`,
            '--virtual-time-budget=8000',
            `--window-size=${width},${height}`, `--screenshot=${join(screenshotDir, `usage-${locale}-${id}.png`)}`,
            `${url}?case=${id}&locale=${locale}`,
          ], { timeout: 120000, stdio: 'ignore' })
        }
      }
    }
  } finally { rmSync(work, { recursive: true, force: true }) }
})
