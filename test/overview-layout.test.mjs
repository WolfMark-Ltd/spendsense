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
  let esbuild
  try {
    esbuild = (await import(pathToFileURL(join(MODULES, 'esbuild/lib/main.js')).href)).default
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
body[data-single] .case{height:auto;min-height:100vh;overflow:visible;margin:0}
#overview-layout-result{display:none}
</style></head><body><div id="overview-layout-cases"></div><div id="overview-layout-result"></div>
<script>globalThis.__overviewLocale=new URLSearchParams(location.search).get('locale')||'en'</script>
<script>${readFileSync(bundle, 'utf8')}</script><script>
const params=new URLSearchParams(location.search);const name=params.get('case');if(name){document.body.dataset.single=name.endsWith('dark')?'dark':'light';const cases=document.getElementById('overview-layout-cases');cases.style.display='block';cases.style.gridTemplateColumns='none'}
if(params.get('review')==='1'){const nativeMatchMedia=window.matchMedia.bind(window);window.matchMedia=query=>query==='(prefers-reduced-motion: reduce)'?{matches:true,media:query,addEventListener(){},removeEventListener(){}}:nativeMatchMedia(query)}
</script></body></html>`)
    const url = pathToFileURL(html).href
    // ovTitle in the product dictionary. Pinned here so a run cannot prove the
    // geometry of a page that silently rendered the wrong language; the copy
    // itself is asserted browserlessly in `overview-render.test.mjs`.
    const TITLES = { en: 'Overview', zh: '总览' }
    const results = {}
    const singleLayouts = new Map()
    for (const locale of ['en', 'zh']) {
      const dom = execFileSync(CHROME, [
        '--headless', '--disable-gpu', '--no-sandbox', `--user-data-dir=${join(work, `chrome-profile-${locale}`)}`,
        '--virtual-time-budget=5000', '--dump-dom', `${url}?locale=${locale}`,
      ], { maxBuffer: 64 * 1024 * 1024, timeout: 90000 }).toString()
      const match = dom.match(/<div id="overview-layout-result"[^>]*>([^<]*)<\/div>/)
      assert.ok(match?.[1], `[${locale}] Chromium records Overview layout results`)
      const result = JSON.parse(match[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&gt;/g, '>').replace(/&lt;/g, '<'))
      assert.equal(result.layouts.length, 8, `[${locale}] every width and theme is rendered`)
      assert.equal(result.readiness?.ready, true,
        `[${locale}] the page reached its final structure (${result.readiness?.waitedMs}ms)`)
      for (const layout of result.layouts) {
        const tag = `[${locale}/${layout.id}]`
        assert.notEqual(layout.missingOverview, true, `${tag} renders Overview panels: ${layout.errors?.join('\n')}`)
        assert.deepEqual(layout.errors, [], `${tag} renders without page errors`)
        assert.equal(layout.heading, TITLES[locale], `${tag} renders the page in the requested language`)
        assert.equal(layout.cards, 4, tag)
        assert.ok(layout.paneOverflow <= 1, `${tag} product container has no horizontal scroll`)
        if (layout.documentOverflow !== null) assert.ok(layout.documentOverflow <= 1, `${tag} document has no horizontal scroll`)
        assert.equal(layout.summaryColumns, layout.width <= 340 ? 1 : 2, tag)
        assert.equal(layout.panelColumns, layout.width <= 760 ? 1 : 2, tag)
        assert.deepEqual(layout.overflow, [], `${tag} has no overflowing card content`)
        assert.equal(layout.methodsCollapsed, true, `${tag} keeps methodology collapsed by default`)
        assert.ok(layout.kpiHeights.every(height => height < 260),
          `${tag} KPI cards remain compact (${JSON.stringify(layout.kpiDetails)})`)
        assert.ok(Math.max(...layout.kpiHeights) - Math.min(...layout.kpiHeights) <= 1,
          `${tag} financial cards have equal heights (${layout.kpiHeights.join(', ')})`)
        assert.ok(Math.max(...layout.kpiWidths) - Math.min(...layout.kpiWidths) <= 1,
          `${tag} financial cards have equal widths (${layout.kpiWidths.join(', ')})`)
        assert.equal(layout.sticky.position, 'sticky', `${tag} keeps sticky navigation`)
        assert.equal(layout.sticky.zIndex, '30', `${tag} keeps navigation above page content`)
        assert.match(layout.sticky.backgroundImage, /linear-gradient/, `${tag} gives sticky navigation an opaque underlay`)
        assert.equal(layout.sticky.top, 0, `${tag} navigation remains pinned at the scroller top`)
        assert.ok(layout.navigationOverflow <= 1, `${tag} navigation tabs fit their available row width`)
        assert.ok(layout.connectionStatus, `${tag} renders the shared connection indicator`)
        // Wide headers keep the indicator on the first visual row beside the
        // destinations; below 760px the header deliberately stacks it under
        // the wrapping tab group so the destinations keep their full width.
        if (layout.width > 760) {
          assert.ok(layout.connectionStatus.top < layout.connectionStatus.firstTabBottom,
            `${tag} keeps the connection indicator on the header's first row (top ${layout.connectionStatus.top}px, first tab bottom ${layout.connectionStatus.firstTabBottom}px)`)
        }
        assert.ok(layout.connectionStatus.rightInset >= 0 && layout.connectionStatus.rightInset <= 19,
          `${tag} keeps the connection indicator inside the header's right edge (${layout.connectionStatus.rightInset}px)`)
        assert.ok(layout.buttonCount >= 7,
          `${tag} renders its controls before their rects are checked (${layout.buttonCount})`)
        assert.deepEqual(layout.clippedButtons, [], `${tag} buttons stay inside the Overview pane`)
      }
      assert.notEqual(result.layouts[0].background, result.layouts[1].background, `[${locale}] dark and light host fills differ`)
      assert.notEqual(result.layouts[0].foreground, result.layouts[1].foreground, `[${locale}] dark and light text colours differ`)
      results[locale] = result

      for (const width of [268, 380]) {
        for (const theme of ['dark', 'light']) {
          const id = `w${width}-${theme}`
          const viewportWidth = width + 40
          // 2500 (was 2400): the F19 Subscription value strip adds one
          // flowing line to the pane. Bumped by the measured worst case
          // (~65px at 268px with two fee currencies) plus margin, not reset.
          const viewportHeight = 2500
          const singleDom = execFileSync(CHROME, [
            '--headless', '--disable-gpu', '--no-sandbox', `--user-data-dir=${join(work, `chrome-single-${id}-${locale}`)}`,
            '--virtual-time-budget=5000', `--window-size=${viewportWidth},${viewportHeight}`, '--dump-dom',
            `${url}?case=${id}&locale=${locale}`,
          ], { maxBuffer: 64 * 1024 * 1024, timeout: 90000 }).toString()
          const singleMatch = singleDom.match(/<div id="overview-layout-result"[^>]*>([^<]*)<\/div>/)
          assert.ok(singleMatch?.[1], `[${id}/${locale}] Chromium records single-pane layout results`)
          const singleResult = JSON.parse(singleMatch[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&gt;/g, '>').replace(/&lt;/g, '<'))
          assert.equal(singleResult.layouts.length, 1, `[${id}/${locale}] renders one selected pane`)
          assert.equal(singleResult.readiness?.ready, true,
            `[${id}/${locale}] the pane reached its final structure (${singleResult.readiness?.waitedMs}ms)`)
          const layout = singleResult.layouts[0]
          const tag = `[${id}/${locale}/single]`
          assert.equal(layout.width, width, tag)
          assert.equal(layout.heading, TITLES[locale], `${tag} renders the page in the requested language`)
          assert.ok(layout.paneOverflow <= 1, `${tag} pane has no horizontal scroll`)
          assert.notEqual(layout.documentOverflow, null, `${tag} measures document overflow in single-pane mode`)
          assert.ok(layout.documentOverflow <= 1, `${tag} document has no horizontal scroll`)
          assert.ok(layout.navigationOverflow <= 1, `${tag} tab strip fits`)
          assert.deepEqual(layout.overflow, [], `${tag} has no overflowing cards`)
          assert.deepEqual(layout.clippedButtons, [], `${tag} buttons fit within the pane`)
          assert.deepEqual(layout.buttonsOutsidePane, [], `${tag} buttons fit within the full-height pane`)
          assert.equal(layout.methodsCollapsed, true, `${tag} methodology starts collapsed`)
          assert.equal(layout.paneLeft, 0, `${tag} pane is aligned to the screenshot origin`)
          assert.equal(layout.paneRight, width, `${tag} pane right edge matches its target width`)
          assert.ok(layout.paneBottom <= layout.viewportHeight + 1, `${tag} full pane fits the viewport`)
          singleLayouts.set(`${id}/${locale}`, layout)
        }
      }

      const reviewDom = execFileSync(CHROME, [
        '--headless', '--disable-gpu', '--no-sandbox', `--user-data-dir=${join(work, `chrome-review-${locale}`)}`,
        '--virtual-time-budget=5000', '--dump-dom', `${url}?locale=${locale}&review=1`,
      ], { maxBuffer: 64 * 1024 * 1024, timeout: 90000 }).toString()
      const reviewMatch = reviewDom.match(/<div id="overview-layout-result"[^>]*>([^<]*)<\/div>/)
      assert.ok(reviewMatch?.[1], `[${locale}] Chromium records Review jump positions`)
      const reviewResult = JSON.parse(reviewMatch[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&gt;/g, '>').replace(/&lt;/g, '<'))
      const reviewJumps = reviewResult.reviewJumps || []
      assert.equal(reviewResult.readiness?.ready, true,
        `[${locale}] the Review page reached its final structure (${reviewResult.readiness?.waitedMs}ms)`)
      assert.equal(reviewJumps.length, 4, `[${locale}] all 268px and 380px Review actions are exercised`)
      for (const jump of reviewJumps) {
        const tag = `[${locale}/${jump.id}/Review]`
        assert.ok(jump.focused, `${tag} action receives keyboard focus before activation`)
        assert.ok(jump.tabsHeight > 68, `${tag} fixture wraps its sticky tabs beyond the old 68px offset`)
        assert.equal(jump.scrollMarginTop, Math.ceil(jump.tabsHeight + 8), `${tag} offset follows the rendered sticky header`)
        assert.ok(jump.headingTop >= jump.tabsBottom - 1, `${tag} Needs attention heading sits below sticky navigation`)
        assert.ok(jump.headingBottom <= jump.paneBottom, `${tag} Needs attention heading stays in the visible pane`)
        assert.ok(jump.introTop >= jump.tabsBottom - 1, `${tag} Needs attention introduction stays below sticky navigation`)
        assert.ok(jump.introBottom <= jump.paneBottom, `${tag} Needs attention introduction stays in the visible pane`)
      }
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
        let paneLayout = null
        if (width < 500) {
          paneLayout = singleLayouts.get(`${id}/${locale}`)
          assert.ok(paneLayout, `[${id}/${locale}] uses the verified single-pane layout`)
          assert.equal(paneLayout.width, width - 40, `[${id}/${locale}] renders the intended pane width`)
          assert.equal(paneLayout.paneLeft, 0, `[${id}/${locale}] pane starts at the screenshot origin`)
          assert.equal(paneLayout.paneRight, width - 40, `[${id}/${locale}] entire pane fits before screenshot capture`)
          assert.ok(paneLayout.navigationOverflow <= 1, `[${id}/${locale}] all navigation tabs fit`)
          assert.deepEqual(paneLayout.clippedButtons, [], `[${id}/${locale}] all buttons fit horizontally in the pane`)
          assert.deepEqual(paneLayout.buttonsOutsidePane, [], `[${id}/${locale}] all buttons fit inside the full-height pane`)
        }
        execFileSync(CHROME, [
          '--headless', '--disable-gpu', '--no-sandbox', `--user-data-dir=${join(work, `chrome-shot-${id}-${locale}`)}`,
          '--virtual-time-budget=5000',
          `--window-size=${width},${height}`, `--screenshot=${join(screenshotDir, filename)}`,
          `${url}?case=${id}&locale=${locale}`,
        ], { timeout: 90000, stdio: 'ignore' })
        const png = readFileSync(join(screenshotDir, filename))
        assert.equal(png.toString('hex', 0, 8), '89504e470d0a1a0a', `[${id}/${locale}] writes a PNG screenshot`)
        if (paneLayout) {
          const screenshotWidth = png.readUInt32BE(16)
          const screenshotHeight = png.readUInt32BE(20)
          assert.ok(screenshotWidth >= paneLayout.paneRight,
            `[${id}/${locale}] screenshot contains the pane's right edge (${screenshotWidth}/${paneLayout.paneRight})`)
          assert.ok(screenshotHeight >= paneLayout.paneBottom,
            `[${id}/${locale}] screenshot contains all pane content (${screenshotHeight}/${paneLayout.paneBottom})`)
        }
      }
    }
  } finally {
    esbuild?.stop()
    rmSync(work, { recursive: true, force: true })
  }
})
