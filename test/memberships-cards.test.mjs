// WP27: the four Memberships headline cards in the accepted Costs evidence
// language. Real Chromium geometry at pane, mid and ledger widths in dark and
// light, English and Chinese: each reading keeps its own card, its figure
// dominates its label, the 3px rail is present and meaningful, the status chip
// and note stay subordinate, the grid wraps to a 2×2 pane layout without
// overflow, and no arrangement is misreported as a subscription. Also asserts
// that opening an account row shows its readings without a second click.
// Skips with an explicit message where no Chrome binary is available.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

// Written out rather than read from I18N, so a missing key fails here.
const COPY = {
  en: {
    labels: ['Accounts reviewed', 'Paid subscriptions', 'Needs attention', 'Membership fees'],
    reviewedStatus: 'All arrangements',
    reviewedNote: /not subscribed/,
    paidUnknown: '1 fee unknown',
    attentionStatus: 'Needs action',
    feesStatus: 'Declared',
    feesNote: /Not a bill/,
    feeLines: ['USD 100.00/mo', 'EUR 19.99/mo'],
    arrangement: 'Accounts by arrangement',
    paidLabel: 'Paid subscriptions',
    freeTier: 'Free tier',
    noFee: /No fee amount recorded/,
  },
  zh: {
    labels: ['已检查账户', '付费订阅', '需要注意', '会员费用'],
    reviewedStatus: '全部计费方式',
    reviewedNote: /不代表已订阅/,
    paidUnknown: '1 项费用未知',
    attentionStatus: '需处理',
    feesStatus: '已声明',
    feesNote: /不是账单/,
    feeLines: ['USD 100.00/月', 'EUR 19.99/月'],
    arrangement: '按计费方式分类的账户',
    paidLabel: '付费订阅',
    freeTier: '免费套餐',
    noFee: /未记录/,
  },
}

const CASES = [
  ['cards-pane-dark', 380, 'dark'],
  ['cards-pane-light', 380, 'light'],
  ['cards-mid-dark', 720, 'dark'],
  ['cards-wide-dark', 1080, 'dark'],
  ['cards-wide-light', 1080, 'light'],
]

if (!chrome) {
  test('memberships cards (skipped: no Chrome binary)', t => {
    t.skip('No Chrome/Chromium binary available: card geometry cannot be verified here.')
  })
} else {
  test('memberships cards: four dominant figures in the accepted evidence language', async () => {
    const work = mkdtempSync(join(tmpdir(), 'wm-memberships-cards-'))
    try {
      const esbuild = (await import(pathToFileURL(join(HARNESS_MODULES, 'esbuild', 'lib', 'main.js')).href)).default
      for (const locale of ['en', 'zh']) {
        const copy = COPY[locale]
        const src = readFileSync(join(ROOT, 'test', 'memberships-cards.page.jsx'), 'utf8')
          .replaceAll('__LOCALE__', locale)
          .replaceAll('__ROOT__', ROOT)
        const entry = join(work, `entry-${locale}.jsx`)
        writeFileSync(entry, src)
        const bundle = join(work, `page-${locale}.js`)
        await esbuild.build({
          entryPoints: [entry],
          bundle: true, format: 'iife', platform: 'browser', outfile: bundle,
          jsx: 'automatic',
          alias: { '@hermes/plugin-sdk': join(ROOT, 'test', 'memberships-visual.sdk.mjs') },
          nodePaths: [HARNESS_MODULES], logLevel: 'warning',
        })
        const html = join(work, `page-${locale}.html`)
        writeFileSync(html, `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box}body{margin:0;font:13px/1.5 system-ui;background:#888}
.case{margin:10px;display:inline-block;vertical-align:top;background:var(--ui-fill-primary);color:var(--ui-text-primary);container-type:inline-size;overflow:auto}
.dark{--ui-fill-primary:#12141a;--ui-fill-secondary:#1a1d26;--ui-fill-tertiary:#232633;--ui-stroke-secondary:#2b2f40;--ui-text-primary:#eef0f6;--ui-text-secondary:#b9bdd1;--ui-text-tertiary:#a9aec6;--ui-text-quaternary:#9398b0;--ui-accent:#4f7cff;--ui-success:#2dd4bf;--ui-warning:#f5b544;--ui-error:#f26d6d}
.light{--ui-fill-primary:#fff;--ui-fill-secondary:#f2f4f7;--ui-fill-tertiary:#e3e5eb;--ui-stroke-secondary:#c5cbd5;--ui-text-primary:#151823;--ui-text-secondary:#414655;--ui-text-tertiary:#555b69;--ui-text-quaternary:#626877;--ui-accent:#3157c0;--ui-success:#067647;--ui-warning:#9a5e00;--ui-error:#b42318}
#memberships-cards-result{display:none}
</style></head><body>${CASES.map(([id, width, theme]) =>
          `<div id="${id}" class="case ${theme}" style="width:${width}px"></div>`).join('')}<div id="memberships-cards-result"></div>
<script>${readFileSync(bundle, 'utf8')}</script></body></html>`)
        const dom = execFileSync(chrome, [
          '--headless', '--disable-gpu', '--no-sandbox', `--user-data-dir=${join(work, `chrome-profile-${locale}`)}`,
          '--virtual-time-budget=20000', '--dump-dom', `file://${html}`,
        ], { maxBuffer: 64 * 1024 * 1024, timeout: 180000 }).toString()
        const match = dom.match(/<div id="memberships-cards-result"[^>]*>([^<]*)<\/div>/)
        assert.ok(match && match[1], `${locale}: the page script must record a result`)
        const result = JSON.parse(match[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#39;/g, "'"))
        assert.equal(result.error, undefined, `${locale}: page script error: ${result.error}`)

        for (const [caseId, width] of CASES) {
          const view = result.cases[caseId]
          assert.ok(view, `${locale} ${caseId}: the case rendered`)
          assert.ok(view.paneOverflow <= 1, `${locale} ${caseId}: no horizontal overflow (${view.paneOverflow}px)`)
          assert.deepEqual(view.cards.map(card => card.kind),
            ['reviewed', 'paid', 'attention', 'fees'],
            `${locale} ${caseId}: four cards, one reading each, in a stable order`)
          assert.deepEqual(view.cards.map(card => card.label), copy.labels,
            `${locale} ${caseId}: the four readings are named in the reader's language`)

          // Every card is its own object and its own accent: a rail, not a
          // shared table cell.
          assert.ok(view.columnGap >= 6, `${locale} ${caseId}: cards are separated (${view.columnGap}px)`)
          for (const card of view.cards) {
            assert.equal(card.railWidth, '3px',
              `${locale} ${caseId} ${card.kind}: the 3px accent rail is present`)
            assert.notEqual(card.railColour, card.pageBackground,
              `${locale} ${caseId} ${card.kind}: the rail is visible against the page`)
            assert.ok(card.width > 120, `${locale} ${caseId} ${card.kind}: the card has room (${card.width}px)`)
            assert.ok(card.overflow <= 1,
              `${locale} ${caseId} ${card.kind}: content fits its card (${card.overflow}px)`)
            // The figure dominates its label and is the heaviest thing on the
            // card; the status and note stay subordinate to both.
            // The fee card stacks a currency per line, so it steps down one
            // size in the pane rather than breaking a currency from its amount.
            const minFigure = width >= 720 ? 20 : 17
            assert.ok(card.valueSize >= minFigure,
              `${locale} ${caseId} ${card.kind}: the figure is prominent (${card.valueSize}px)`)
            assert.ok(card.valueSize >= card.labelSize + 6,
              `${locale} ${caseId} ${card.kind}: the figure dominates its label (${card.valueSize} vs ${card.labelSize})`)
            assert.ok(card.valueWeight >= 600,
              `${locale} ${caseId} ${card.kind}: the figure carries weight (${card.valueWeight})`)
            assert.ok(card.statusSize < card.valueSize,
              `${locale} ${caseId} ${card.kind}: the status chip is subordinate (${card.statusSize}px)`)
            assert.ok(card.noteSize < card.valueSize,
              `${locale} ${caseId} ${card.kind}: the note is subordinate (${card.noteSize}px)`)
            assert.ok(card.noteSize >= 10, `${locale} ${caseId} ${card.kind}: the note stays legible`)
            assert.ok(card.status.length > 0, `${locale} ${caseId} ${card.kind}: the card states its status`)
            assert.ok(card.note.length > 0, `${locale} ${caseId} ${card.kind}: the card states its basis`)
          }

          // Four across a ledger, a 2×2 grid in the pane and at mid width.
          assert.equal(view.columns, width >= 1000 ? 4 : 2,
            `${locale} ${caseId}: four cards form ${width >= 1000 ? 'one row' : 'a 2×2 grid'} (${view.columns})`)

          const card = kind => view.cards.find(entry => entry.kind === kind)
          // F27: reviewed is a scope count, not a subscription; the paid count
          // is separate and an unknown fee is named rather than zeroed.
          assert.equal(card('reviewed').value, '9', `${locale} ${caseId}: every account is reviewed once`)
          assert.equal(card('paid').value, '3', `${locale} ${caseId}: only chosen-plan subscriptions are paid`)
          assert.equal(card('reviewed').status, copy.reviewedStatus,
            `${locale} ${caseId}: reviewed is not called a subscription`)
          assert.match(card('reviewed').note, copy.reviewedNote,
            `${locale} ${caseId}: the reviewed card says what it does not mean`)
          assert.equal(card('paid').status, copy.paidUnknown,
            `${locale} ${caseId}: a paid account with no fee amount is named`)
          assert.equal(card('paid').tone, 'attention',
            `${locale} ${caseId}: an unknown fee gives the paid card an amber rail`)
          assert.equal(card('attention').value, '2',
            `${locale} ${caseId}: the unfunded paid plan and the unconfirmed account need attention`)
          assert.equal(card('attention').status, copy.attentionStatus)
          assert.notEqual(card('attention').railColour, card('fees').railColour,
            `${locale} ${caseId}: attention and declared readings do not share an accent`)
          // A confirmed free tier is a real zero; the unknown fee never becomes
          // one, so the fee card lists only the two known amounts.
          assert.deepEqual(card('fees').lines, copy.feeLines,
            `${locale} ${caseId}: one fee line per currency, never summed`)
          assert.equal(card('fees').status, copy.feesStatus)
          assert.match(card('fees').note, copy.feesNote,
            `${locale} ${caseId}: the fee card says it is not a bill`)

          // The arrangement breakdown separates reviewed from every
          // arrangement, and its counts reconcile to the reviewed total.
          // Visible text only: a collapsed row body still holds its advanced
          // group, so textContent would prove nothing about what a reader sees.
          // innerText returns rendered text, and this caption is styled
          // uppercase; the DOM copy is sentence case.
          assert.match(view.paneVisibleText, new RegExp(copy.arrangement, 'i'),
            `${locale} ${caseId}: the arrangement breakdown is named in words`)
          assert.match(view.paneVisibleText, new RegExp(copy.freeTier),
            `${locale} ${caseId}: a confirmed free tier is listed apart from paid plans`)
          assert.doesNotMatch(view.paneVisibleText, /commandcode-anthropic|xai-oauth|openai-codex:personal/,
            `${locale} ${caseId}: no technical route slug or account id is in the normal view`)

          // Opening a row reveals the readings in one click.
          assert.equal(view.expanded.allowancesOpen, true,
            `${locale} ${caseId}: opening a row shows the allowance readings`)
          assert.ok(view.expanded.allowancesHeight > 0,
            `${locale} ${caseId}: the opened readings are laid out`)
          assert.equal(view.expanded.planOpen, false,
            `${locale} ${caseId}: the edit path waits to be opened`)
          assert.equal(view.expanded.advancedOpen, false,
            `${locale} ${caseId}: the technical group waits to be opened`)
        }
        assert.equal(result.hostCalls, 0, `${locale}: no host/gateway calls were made`)
      }
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })
}
