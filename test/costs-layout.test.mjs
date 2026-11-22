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

const LAYOUT_STRINGS = {
  en: { charges: /Not recorded/, gbpFee: /GBP 20\.00\/mo/, usdFee: /USD 0\.00\/mo/,
    partial: /fee unknown/, cachePartial: /Partial/,
    scope: /timestamped backend calls.*unclassified calls are not assumed to be main.*unknown cache evidence stay out of priced subtotals.*not a provider charge or subscription saving/,
    limit: /1 limit/,
    groups: /Fees vs usage by currency/, attention: /What needs attention\?/, fix: /Fix now/,
    seeAttention: /1 issue needs attention/, blocker: /Add a dated user-supplied/,
    feeAction: /Set or confirm this account’s subscription fee/,
    moneyFee: /GBP 20\.00 fees in window/, moneyUsage: /\$0\.00 usage/,
    verdict: /Partial evidence: .* in known fees vs .* of attributed usage/,
    fixHint: /use the action on each row/ },
  zh: { charges: /无法获取逐次调用/, gbpFee: /GBP 20\.00\/月/, usdFee: /USD 0\.00\/月/,
    partial: /项费用未知/, cachePartial: /部分/,
    scope: /所选报告窗口内带时间戳的后端调用.*未分类调用不会被假设为主调用.*未知缓存证据不计入已定价小计.*不是供应商费用或订阅节省/,
    limit: /1 项限额/,
    groups: /按货币对比费用与用量/, attention: /哪些事项需要注意？/, fix: /立即处理/,
    seeAttention: /1 个问题需要注意/, blocker: /添加注明日期的.*汇率/,
    feeAction: /设置或确认此账户的订阅费用/,
    moneyFee: /GBP 20\.00 窗口内费用/, moneyUsage: /\$0\.00 用量/,
    verdict: /部分证据/, fixHint: /按每行的操作处理/ },
}

test('Costs keeps mixed financial evidence scannable at 380px and 1200px in both themes and languages', {
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
    for (const lang of ['en', 'zh']) {
      const expected = LAYOUT_STRINGS[lang]
      const dom = execFileSync(CHROME, [
        '--headless', '--disable-gpu', '--no-sandbox', `--user-data-dir=${join(work, `chrome-profile-${lang}`)}`,
        '--virtual-time-budget=5000', '--dump-dom', `${url}?lang=${lang}`,
      ], { maxBuffer: 64 * 1024 * 1024, timeout: 90000 }).toString()
      const match = dom.match(/<div id="costs-layout-result"[^>]*>([^<]*)<\/div>/)
      assert.ok(match?.[1], `Chromium records Costs layout results in ${lang}`)
      const result = JSON.parse(match[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&gt;/g, '>').replace(/&lt;/g, '<'))
      assert.equal(result.layouts.length, 4)
      for (const layout of result.layouts) {
        const id = `${lang} ${layout.id}`
        assert.equal(layout.columns, layout.width <= 760 ? 2 : 3, id)
        assert.deepEqual(layout.overflow, [], `${id} has no overflowing cards or sections`)
        assert.match(layout.api, /\$0\.00/, `${id} preserves zero API-equivalent value`)
        assert.match(layout.provider, /\$0\.00/, `${id} preserves zero provider-reported value`)
        assert.match(layout.charges, expected.charges, `${id} distinguishes missing charge evidence`)
        assert.doesNotMatch(layout.charges, /\$0\.00/, `${id} never displays missing charges as zero`)
        assert.match(layout.fees, expected.gbpFee, `${id} shows GBP fee and its period`)
        assert.match(layout.fees, expected.usdFee, `${id} shows zero USD fee`)
        assert.match(layout.fees, expected.partial, `${id} marks the subtotal partial`)
        assert.equal(layout.feeLines.length, 2, `${id} keeps currencies and periods on separate lines`)
        assert.match(layout.cache, /\$0\.00/, `${id} preserves zero cache impact`)
        assert.doesNotMatch(layout.cache, expected.cachePartial, `${id} states partial coverage once globally instead of a card pill`)
        assert.equal(layout.scopeLines, 1, `${id} states priced-subtotal scope exactly once`)
        assert.match(layout.scopeLine, expected.scope, `${id} explains priced-subtotal scope`)
        assert.match(layout.allowances, expected.limit, `${id} distinguishes plan limits from spend`)
        assert.match(layout.text, expected.groups, `${id} keeps the currency comparison visual`)
        assert.equal(layout.comparisons, 2, `${id} renders labelled fee and API-equivalent bars`)
        assert.equal(layout.closedDetails, true, `${id} keeps detailed evidence in closed disclosures`)
        assert.match(layout.attention, expected.attention, `${id} summarises what needs attention`)
        assert.match(layout.attention, expected.fix, `${id} classifies the dated-FX gap as fixable`)
        assert.match(layout.attention, expected.feeAction, `${id} raises the unknown membership fee once`)
        assert.equal(layout.attentionCount, '2', `${id} counts each material cause once`)
        assert.equal(layout.catHints.length, 1, `${id} explains the single fixable category`)
        assert.match(layout.catHints[0], expected.fixHint, `${id} points each row at its fix action`)
        assert.equal(layout.verdict, 'partial', `${id} narrates the partial comparison`)
        assert.match(layout.verdictText, expected.verdict, `${id} scopes known fees and usage`)
        assert.deepEqual(layout.seeAttention.length, 1, `${id} links the unavailable group to attention`)
        assert.match(layout.seeAttention[0], expected.seeAttention, `${id} counts the group issues`)
        assert.match(layout.groupMoney, expected.moneyFee, `${id} keeps the supported fee figure`)
        assert.match(layout.groupMoney, expected.moneyUsage, `${id} keeps the supported zero usage`)
        assert.doesNotMatch(layout.groupRow, expected.blocker, `${id} moves blocker sentences out of the row`)
        assert.equal(layout.logClosed, true, `${id} keeps the raw blocker log closed`)
        assert.equal(layout.trendInline, false, `${id} leaves a single month out of the trend view`)
        assert.equal(layout.anchor, true, `${id} anchors the subscription comparison`)
        assert.match(layout.pricing, /Synthetic catalogue/, `${id} keeps the pricing source visible`)
      }
      assert.equal(result.interactions.closedBeforeAction, true, `${lang} FX disclosure starts closed`)
      assert.equal(result.interactions.fxOpensFromBlocker, true, `${lang}: the dated-FX blocker opens its settings disclosure`)
      assert.equal(result.interactions.fxActionReceivesFocus, true, `${lang}: the opened FX disclosure receives keyboard focus`)
      assert.equal(result.interactions.seeAttentionFocusesHeading, true, `${lang}: the group link focuses the attention heading`)
      assert.ok(result.interactions.chevronClosed, `${lang}: the closed disclosure marker is measurable`)
      assert.notEqual(result.interactions.chevronClosed.content, 'none', `${lang}: a closed disclosure shows a chevron`)
      assert.notEqual(result.interactions.chevronClosed.transform, result.interactions.chevronOpen.transform,
        `${lang}: the chevron changes state when the disclosure opens`)
      assert.ok(result.interactions.nestedChevron, `${lang}: the nested account list marker is measurable`)
      assert.notEqual(result.interactions.nestedChevron.content, 'none', `${lang}: nested account lists show a chevron`)
      assert.equal(result.interactions.summaryClickCloses, true, `${lang}: clicking the heading closes the disclosure`)
      assert.equal(result.interactions.summaryClickReopens, true, `${lang}: clicking the heading reopens it`)
      assert.equal(result.interactions.verdictLinkFocusesHeading, true, `${lang}: the partial verdict links to the attention heading`)
      if (lang === 'en') {
        assert.notEqual(result.layouts[0].background, result.layouts[2].background, 'dark and light host fills differ')
        assert.notEqual(result.layouts[0].foreground, result.layouts[2].foreground, 'dark and light text colours differ')
      }
    }

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
