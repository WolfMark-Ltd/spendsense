// WP20: Memberships clarity across the reading states a provider can produce.
// Real Chromium layout in narrow/wide × dark/light, in English and Chinese,
// with one account per situation: a successful provider reading, a route
// Hermes cannot read, a failed read, a stored view nobody has refreshed, a
// shared entitlement, prepaid credits, a free tier and a metered account with
// no credential. Asserts the chip vocabulary, that absence never renders as
// zero, the reading notes, the optional diagnostics label and the Costs
// subscription-value link. Skips with an explicit message where no Chrome
// binary is available.
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

// Only the label the browser suite still reads: the reading vocabulary itself
// is asserted in test/memberships-reading.test.mjs, against the same accounts.
const COPY = {
  en: { costs: /Compare subscription value in Costs/ },
  zh: { costs: /在“成本”中比较订阅价值/ },
}

if (!chrome) {
  test('memberships clarity (skipped: no Chrome binary)', t => {
    t.skip('No Chrome/Chromium binary available: reading-state layout cannot be verified here.')
  })
} else {
  test('memberships clarity: the reading matrix lays out at 380px and ledger width', async () => {
    const work = mkdtempSync(join(tmpdir(), 'wm-memberships-clarity-'))
    try {
      const esbuild = (await import(pathToFileURL(join(HARNESS_MODULES, 'esbuild', 'lib', 'main.js')).href)).default
      for (const locale of ['en', 'zh']) {
        const copy = COPY[locale]
        const src = readFileSync(join(ROOT, 'test', 'memberships-clarity.page.jsx'), 'utf8')
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
.narrow{width:380px}.wide{width:1080px}#memberships-clarity-result{display:none}
</style></head><body>${['narrow-dark', 'wide-dark', 'narrow-light', 'wide-light'].map(id => `<div id="${id}" class="case ${id.replace('-', ' ')}"></div>`).join('')}<div id="memberships-clarity-result"></div>
<script>${readFileSync(bundle, 'utf8')}</script></body></html>`)
        const dom = execFileSync(chrome, [
          '--headless', '--disable-gpu', '--no-sandbox', `--user-data-dir=${join(work, `chrome-profile-${locale}`)}`,
          '--virtual-time-budget=20000', '--dump-dom', `file://${html}`,
        ], { maxBuffer: 64 * 1024 * 1024, timeout: 150000 }).toString()
        const match = dom.match(/<div id="memberships-clarity-result"[^>]*>([^<]*)<\/div>/)
        assert.ok(match && match[1], `${locale}: the page script must record a result`)
        const result = JSON.parse(match[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#39;/g, "'"))
        assert.equal(result.error, undefined, `${locale}: page script error: ${result.error}`)
        assert.equal(result.checks.costsTabAfterClick, 'costs',
          `${locale}: the Costs link selects the Costs destination`)
        assert.equal(result.checks.costsAnchorFocused, true,
          `${locale}: the Costs link lands on the subscription-economics section, not just the tab`)
        assert.equal(result.checks.costsAnchorTabIndex, '-1',
          `${locale}: the destination section is focusable for keyboard readers`)

        for (const [caseId, view] of Object.entries(result.cases)) {
          assert.ok(view.paneOverflow <= 1, `${locale} ${caseId}: no horizontal overflow (${view.paneOverflow}px)`)
          const row = id => {
            const found = view.rows.find(entry => entry.account === id)
            assert.ok(found, `${locale} ${caseId}: ${id} renders`)
            return found
          }

          // Presence: every reading situation the fixture holds is on screen.
          // The words those rows say are asserted browserlessly, once
          // (test/memberships-reading.test.mjs); what stays here is the
          // geometry of the cells that hold them, measured at real widths.
          for (const id of ['memb:reported', 'memb:unsupported', 'memb:nohermes',
            'memb:failed', 'memb:stored', 'memb:included', 'memb:prepaid',
            'memb:nocred', 'memb:free']) row(id)
          assert.ok(row('memb:unsupported').chipOverflow <= 1,
            `${locale} ${caseId}: the limitation chip fits its row (${row('memb:unsupported').chipOverflow}px)`)

          // The Costs subscription-value link is present, reachable and labelled.
          assert.match(view.costsLink, copy.costs,
            `${locale} ${caseId}: the Costs link is labelled`)
          assert.equal(view.costsFocusable, true,
            `${locale} ${caseId}: the Costs link is keyboard reachable`)

          // WP27: each reading keeps its own card, the figures dominate and
          // every card carries the accepted Costs rail.
          assert.deepEqual(view.summaryCards.map(entry => entry.kind),
            ['reviewed', 'paid', 'attention', 'fees'],
            `${locale} ${caseId}: each reading keeps its own card`)
          const card = kind => view.summaryCards.find(entry => entry.kind === kind)
          for (const entry of view.summaryCards) {
            // A multi-line fee reading steps down one size in the pane so a
            // currency never splits from its amount.
            const minFigure = caseId.startsWith('wide') ? 20 : 17
            assert.ok(entry.valueSize >= minFigure,
              `${locale} ${caseId}: ${entry.kind} figure is prominent (${entry.valueSize}px)`)
            assert.ok(entry.valueWeight >= 600,
              `${locale} ${caseId}: ${entry.kind} figure is weighty (${entry.valueWeight})`)
            assert.equal(entry.railWidth, '3px',
              `${locale} ${caseId}: ${entry.kind} carries the 3px accent rail`)
            assert.ok(entry.overflow <= 1,
              `${locale} ${caseId}: ${entry.kind} card does not overflow (${entry.overflow}px)`)
          }
          assert.notEqual(card('reviewed').railColour, card('paid').railColour,
            `${locale} ${caseId}: a scope count and a declared subscription differ in accent`)
          assert.equal(view.summaryColumns, caseId.startsWith('wide') ? 4 : 2,
            `${locale} ${caseId}: the four cards form one row wide and a 2x2 grid in the pane`)

          // F82: raw backend messages stay out of the normal view. Their
          // containment is asserted browserlessly; this is the painted half,
          // which only a browser can measure.
          assert.equal(view.rawNotesInNormalView, false,
            `${locale} ${caseId}: no raw provider error is in the normal view`)
        }
        assert.equal(result.hostCalls, 0, `${locale}: no host/gateway calls were made`)
      }
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })
}
