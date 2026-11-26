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

test('Hermes sidebar keeps the model and cache-read figure readable from 268px to 500px', {
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
.case.dark{--ui-fill-primary:#12141a;--ui-fill-secondary:#1a1d26;--ui-fill-tertiary:#232633;--ui-stroke-secondary:#2b2f40;--ui-text-primary:#eef0f6;--ui-text-secondary:#b9bdd1;--ui-text-tertiary:#a9aec6;--ui-text-quaternary:#9398b0;--ui-accent:#7fa0ff;--ui-success:#2dd4bf}
body[data-state-tokens] .case.dark{--ui-warning:#f5b544;--ui-error:#f26d6d}
.case.light{--ui-fill-primary:#fff;--ui-fill-secondary:#f2f4f7;--ui-fill-tertiary:#e3e5eb;--ui-stroke-secondary:#c5cbd5;--ui-text-primary:#151823;--ui-text-secondary:#414655;--ui-text-tertiary:#555b69;--ui-text-quaternary:#626877;--ui-accent:#3157c0;--ui-success:#087f5b}
body[data-state-tokens] .case.light{--ui-warning:#9a5e00;--ui-error:#b42318}
body[data-single]{padding:0;background:var(--ui-fill-primary)}body[data-single] #sidebar-layout-cases{display:block}body[data-single] .case{margin:0}
</style></head><body><div id="sidebar-layout-cases"></div><div id="sidebar-layout-result"></div>
<script>if(new URLSearchParams(location.search).get('stateTokens') !== 'absent') document.body.dataset.stateTokens = ''</script>
<script>${readFileSync(bundle, 'utf8')}</script></body></html>`)
    const url = pathToFileURL(html).href
    const run = (locale, tooltipInteraction = '', readBenefitInteraction = '', state = 'partial', stateTokens = 'present', all = true) => {
      const query = `${all ? 'all=1&' : ''}locale=${locale}&state=${state}&stateTokens=${stateTokens}${tooltipInteraction ? `&tooltipInteraction=${tooltipInteraction}` : ''}${readBenefitInteraction ? `&readBenefitInteraction=${readBenefitInteraction}` : ''}${all ? '' : '&width=268&height=650&theme=dark'}`
      const dom = execFileSync(CHROME, [
        '--headless', '--disable-gpu', '--no-sandbox', `--user-data-dir=${join(work, `chrome-${locale}-${state}-${stateTokens}`)}`,
        '--virtual-time-budget=5000', '--dump-dom', `${url}?${query}`,
      ], { maxBuffer: 32 * 1024 * 1024, timeout: 120000 }).toString()
      const match = dom.match(/<div id="sidebar-layout-result"[^>]*>(.*?)<\/div>/s)
      assert.ok(match?.[1], `Chromium records sidebar layout results (${locale})`)
      return JSON.parse(match[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&'))
    }

    for (const locale of ['en', 'zh-CN']) {
      const result = run(locale, locale === 'en' ? 'both' : '', 'focus')
      assert.deepEqual(result.errors, [], `no browser errors (${locale})`)
      assert.equal(result.layouts.length, 12, `six widths/heights in both themes (${locale})`)
      assert.equal(result.readBenefitDisclosure.found, true, `${locale} finds the cache-read help button`)
      assert.equal(result.readBenefitDisclosure.focused, true, `${locale}: cache-read help receives browser focus`)
      assert.equal(result.readBenefitDisclosure.expanded, true, `${locale} opens cache-read help on keyboard focus`)
      assert.equal(result.readBenefitDisclosure.describedBy, 'wm-info-read-benefit', `${locale} connects the button and help text`)
      assert.equal(result.readBenefitDisclosure.label, locale === 'en' ? 'More information' : '更多信息',
        `${locale} keeps the existing accessible help control`)
      assert.equal(result.readBenefitDisclosure.tabIndex, 0, `${locale} keeps cache-read help in the keyboard tab order`)
      if (locale === 'en') {
        assert.match(result.readBenefitDisclosure.text, /API-equivalent cache-read benefit for this runtime session/)
        assert.match(result.readBenefitDisclosure.text, /21 of 30 calls · 500\.0k read tokens/)
      } else {
        assert.match(result.readBenefitDisclosure.text, /当前运行会话的 API 等值缓存读取收益/)
        assert.match(result.readBenefitDisclosure.text, /30 次调用中 21 次 · 500\.0k 个读取令牌/)
      }
      for (const layout of result.layouts) {
        const id = `${locale}/${layout.id}`
        assert.equal(layout.model, 'DeepSeek V4.1 Flash', `${id} shows a readable model name`)
        assert.equal(layout.modelId, 'deepseek/deepseek-v4.1-flash', `${id} retains the exact model ID`)
        assert.equal(layout.modelOverflow, 0, `${id} wraps the model within its row`)
        assert.equal(layout.productTitle, 'SpendSense', `${id} keeps the full product name`)
        assert.equal(layout.productTitleOverflow, 0, `${id} does not clip the product name`)
        assert.equal(layout.productTitleOwnRow, true, `${id} gives the full product title its own header row`)
        assert.equal(layout.scopeLabel, locale === 'en' ? 'This session · all recorded calls' : '当前会话 · 所有已记录调用',
          `${id} states that the cache benefit covers this session's recorded calls`)
        assert.equal(layout.scopeOverflow, 0, `${id} keeps the session scope label readable`)
        assert.equal(layout.scopeContained, true, `${id} keeps the session scope label inside the status row`)
        assert.ok(layout.tooltipMetrics.length >= 4, `${id} renders the expected sidebar tooltip controls`)
        for (const [index, tip] of layout.tooltipMetrics.entries()) {
          assert.equal(tip.hitWidth, 24, `${id}/tip${index} keeps the accessible hit width`)
          assert.equal(tip.hitHeight, 24, `${id}/tip${index} keeps the accessible hit height`)
          assert.ok(tip.ringWidth < 12, `${id}/tip${index} uses the smaller shared ring (${tip.ringWidth}px)`)
          assert.ok(tip.glyphFontSize >= 6 && tip.glyphFontSize <= 9,
            `${id}/tip${index} keeps the visible information glyph compact (${tip.glyphFontSize}px)`)
        }
        assert.equal(layout.provider, 'commandcode', `${id} shows the route recorded with the session`)
        assert.equal(layout.providerSeparate, true, `${id} keeps the provider badge distinct from the model row`)
        assert.ok(layout.ringWidth >= 68 && layout.ringWidth <= 88, `${id} scales the larger ring to ${layout.ringWidth}px`)
        assert.match(layout.savedLabel, locale === 'en' ? /Cache-read benefit/ : /缓存读取收益/,
          `${id} labels the supported figure`)
        assert.equal(layout.savedValue, '$12.35',
          `${id} renders the partial backend benefit value bare; the tooltip carries the coverage`)
        assert.doesNotMatch(layout.readBenefitText, /30 calls|500k read tokens|80% covered/,
          `${id} keeps call, token and coverage details out of the normal view`)
        assert.equal(layout.savedNote, '', `${id} removes the inline coverage note`)
        assert.equal(layout.labelOverflow, 0, `${id} keeps the benefit label inside its column`)
        assert.equal(layout.valueOverflow, 0, `${id} keeps the amount and qualifier together`)
        assert.equal(layout.noteOverflow, -1, `${id} has no inline coverage note`)
        assert.equal(layout.labelValueOverlap, false, `${id} keeps label and amount distinct`)
        assert.equal(layout.contentsWithinCard, true, `${id} keeps the figure inside the card`)
        assert.equal(layout.horizontalOverflow, 0, `${id} has no horizontal pane overflow`)
        assert.equal(layout.openSpendSense, locale === 'en' ? 'Open SpendSense' : '打开 SpendSense',
          `${id} retains the existing navigation action`)
        if (layout.height === 650) {
          assert.ok(layout.scrollDelta <= 75,
            `${id} keeps 650px-host scrolling within 15px of the measured 59–60px baseline (${layout.scrollDelta}px)`)
        } else {
          assert.equal(layout.scrollDelta, 0, `${id} fits the 800px host without scrolling`)
        }
        if (layout.height === 650 && layout.scrollDelta > 0) {
          assert.ok(layout.scrollTopAfter > layout.scrollTopBefore, `${id} can scroll the overflowing pane`)
          assert.equal(layout.openSpendSenseVisible, true, `${id} reveals Open SpendSense at the bottom`)
        }
      }
      assert.deepEqual(run(locale, '', '', 'unavailable', 'present', false).layouts.map(layout => layout.savedValue), ['—'],
        `${locale} keeps unavailable evidence distinct from zero`)
      assert.deepEqual(run(locale, '', '', 'known', 'present', false).layouts.map(layout => layout.savedValue), ['$12.35'],
        `${locale} renders a complete session benefit`)
      for (const theme of ['dark', 'light']) for (const height of [650, 800]) {
        const ringWidths = [268, 350, 500].map(width => result.layouts.find(layout =>
          layout.id === `${width}-${height}-${theme}`).ringWidth)
        assert.ok(ringWidths[0] < ringWidths[1] && ringWidths[1] < ringWidths[2],
          `${locale}/${theme}/${height} scales the ring with sidebar width: ${ringWidths.join(' → ')}`)
      }
      if (locale === 'en') for (const interaction of ['hover', 'focus']) {
        const disclosure = result.modelIdDisclosures[interaction]
        assert.equal(disclosure.found, true, `${interaction} finds the exact-ID trigger`)
        assert.equal(disclosure.expanded, true, `${interaction} opens the disclosure`)
        assert.equal(disclosure.offsetParent, 'wm-model-name-row', `${interaction} anchors to the model row`)
        assert.match(disclosure.text, /deepseek\/deepseek-v4\.1-flash/, `${interaction} shows the exact model ID`)
        assert.ok(Math.abs(disclosure.popover.right - disclosure.trigger.right) <= 2,
          `${interaction} aligns the disclosure beside its trigger`)
        const gap = disclosure.popover.top - disclosure.trigger.bottom
        assert.ok(gap >= 4 && gap <= 12, `${interaction} opens directly below the trigger (${gap}px gap)`)
      }
      const nativeTokens = run(locale, '', 'focus', 'partial', 'absent')
      assert.deepEqual(nativeTokens.errors, [], `${locale} renders without the optional state tokens`)
      assert.equal(nativeTokens.readBenefitDisclosure.focused, true, `${locale}: cache-read help receives browser focus without state tokens`)
      assert.equal(nativeTokens.readBenefitDisclosure.expanded, true, `${locale} keeps keyboard cache-read help`)
      assert.equal(nativeTokens.layouts.length, result.layouts.length)
      for (const [index, layout] of nativeTokens.layouts.entries()) {
        const withTokens = result.layouts[index]
        const dark = layout.id.endsWith('dark')
        assert.equal(layout.id, withTokens.id)
        assert.equal(layout.horizontalOverflow, 0, `${locale}/${layout.id} fits without state tokens`)
        assert.equal(layout.scrollDelta, withTokens.scrollDelta, `${locale}/${layout.id} retains scroll depth`)
        assert.equal(layout.writePaint, dark ? 'rgb(185, 189, 209)' : 'rgb(65, 70, 85)')
        assert.equal(withTokens.writePaint, dark ? 'rgb(245, 181, 68)' : 'rgb(154, 94, 0)')
        assert.equal(layout.writeWidth, withTokens.writeWidth)
        assert.ok(layout.writeWidth > 0)
      }
      const scroll = result.layouts.map(layout => `${layout.width}x${layout.height}:${layout.scrollDelta}px`).join(', ')
      console.log(`Sidebar vertical scroll depth (${locale}): ${scroll}`)
    }

    const screenshotDir = process.env.SIDEBAR_LAYOUT_SHOT_DIR
    if (screenshotDir) {
      mkdirSync(screenshotDir, { recursive: true })
      for (const [state, fixtureState] of [['known', 'known'], ['partial', 'partial'], ['unavailable', 'unavailable']]) {
        for (const locale of ['en', 'zh-CN']) {
          for (const [width, height, theme] of [[268, 650, 'dark'], [268, 800, 'light'], [500, 650, 'light'], [500, 800, 'dark']]) {
            const name = `sidebar-${state}-${locale}-${width}x${height}-${theme}.png`
            const screenshot = join(screenshotDir, name)
            const profile = join(work, `shot-${fixtureState}-${locale}-${width}-${height}-${theme}`)
            execFileSync(CHROME, [
              '--headless', '--disable-gpu', '--no-sandbox', `--user-data-dir=${profile}`,
              '--virtual-time-budget=5000', `--window-size=${width},${height}`,
              `--screenshot=${screenshot}`,
              `${url}?case=${width}-${height}-${theme}&width=${width}&height=${height}&theme=${theme}&locale=${locale}&state=${fixtureState}&preservePosition=true`,
            ], { timeout: 120000, stdio: 'ignore' })
            assert.ok(existsSync(screenshot) && statSync(screenshot).size > 0, `writes ${name}`)
          }
        }
      }
      const disclosureShot = join(screenshotDir, 'sidebar-model-id-hover-268x650-dark.png')
      execFileSync(CHROME, [
        '--headless', '--disable-gpu', '--no-sandbox', `--user-data-dir=${join(work, 'shot-model-id-hover')}`,
        '--virtual-time-budget=5000', '--window-size=268,650', `--screenshot=${disclosureShot}`,
        `${url}?case=268-650-dark&width=268&height=650&theme=dark&locale=en&state=partial&tooltipInteraction=hover&preservePosition=true`,
      ], { timeout: 120000, stdio: 'ignore' })
      assert.ok(existsSync(disclosureShot) && statSync(disclosureShot).size > 0, 'writes the model-ID disclosure screenshot')
      const coverageShot = join(screenshotDir, 'sidebar-cache-read-info-268x650-dark.png')
      execFileSync(CHROME, [
        '--headless', '--disable-gpu', '--no-sandbox', `--user-data-dir=${join(work, 'shot-coverage-help')}`,
        '--virtual-time-budget=5000', '--window-size=268,650', `--screenshot=${coverageShot}`,
        `${url}?case=268-650-dark&width=268&height=650&theme=dark&locale=en&state=partial&readBenefitInteraction=hover&preservePosition=true`,
      ], { timeout: 120000, stdio: 'ignore' })
      assert.ok(existsSync(coverageShot) && statSync(coverageShot).size > 0, 'writes the cache-read benefit tooltip screenshot')
    }
  } finally { rmSync(work, { recursive: true, force: true }) }
})
