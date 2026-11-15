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

// The vocabulary each locale must render. Written out rather than read from
// I18N so a key that goes missing shows up as a failure, not a coincidence.
const COPY = {
  en: {
    reported: 'Reported',
    unsupported: 'Not available from Hermes',
    noHermesReading: 'No reading from Hermes',
    failed: 'Read failed',
    unreported: 'Unreported',
    noCredential: 'No credential',
    costs: /Compare subscription value in Costs/,
    diagnosticsLabel: /diagnostic/i,
    diagnostics: /optional/i,
    included: /Included in another account’s subscription/,
    prepaid: /Prepaid credits · no recurring membership fee/,
    metered: /Metered API · no recurring membership fee/,
    free: /Free access · no membership fee/,
    noteUnsupported: /does not report an allowance for this route/,
    noteNoReading: /no credential, no usage endpoint, or the read failed/,
    noteFailed: /could not be fetched/,
    noteStored: /No provider reading has been requested/,
    noteAge: /Provider reading from 10 min ago/,
  },
  zh: {
    reported: '已上报',
    unsupported: 'Hermes 无法提供',
    noHermesReading: 'Hermes 未提供读数',
    failed: '读取失败',
    unreported: '未上报',
    noCredential: '无凭证',
    costs: /在“成本”中比较订阅价值/,
    diagnosticsLabel: /诊断/,
    diagnostics: /可选/,
    included: /包含在另一账户的订阅中/,
    prepaid: /预付额度/,
    metered: /按量 API/,
    free: /免费访问/,
    noteUnsupported: /不为此线路提供额度读数/,
    noteNoReading: /无凭据、无用量端点或读取失败/,
    noteFailed: /无法获取提供方读数/,
    noteStored: /尚未请求提供方读数/,
    noteAge: /提供方读数来自 10 分钟前/,
  },
}

if (!chrome) {
  test('memberships clarity (skipped: no Chrome binary)', t => {
    t.skip('No Chrome/Chromium binary available: reading-state layout cannot be verified here.')
  })
} else {
  test('memberships clarity: every reading state is named, distinct and never zero', async () => {
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

        for (const [caseId, view] of Object.entries(result.cases)) {
          assert.ok(view.paneOverflow <= 1, `${locale} ${caseId}: no horizontal overflow (${view.paneOverflow}px)`)
          const row = id => {
            const found = view.rows.find(entry => entry.account === id)
            assert.ok(found, `${locale} ${caseId}: ${id} renders`)
            return found
          }

          // A successful provider reading.
          assert.equal(row('memb:reported').readingState, 'reported',
            `${locale} ${caseId}: a provider reading is Reported`)
          assert.equal(row('memb:reported').readingLabel, copy.reported,
            `${locale} ${caseId}: the reported chip is localised`)
          assert.match(row('memb:reported').readingAge, copy.noteAge,
            `${locale} ${caseId}: a provider reading states how old it is`)

          // Hermes cannot read this route: a data limitation, with its own words.
          const unsupported = row('memb:unsupported')
          assert.equal(unsupported.readingState, 'unsupported',
            `${locale} ${caseId}: an unreadable route is not reported as unreported`)
          assert.equal(unsupported.readingLabel, copy.unsupported,
            `${locale} ${caseId}: the limitation is named in the reader's language`)
          assert.ok(unsupported.chipOverflow <= 1,
            `${locale} ${caseId}: the limitation chip fits its row (${unsupported.chipOverflow}px)`)
          assert.deepEqual(unsupported.readingNotes.map(note => note.state), ['unsupported'],
            `${locale} ${caseId}: the allowance group explains the limitation`)
          assert.match(unsupported.readingNotes[0].text, copy.noteUnsupported)

          // Hermes answered without a reading: not permanent, not an error.
          const noHermes = row('memb:nohermes')
          assert.equal(noHermes.readingState, 'no_reading',
            `${locale} ${caseId}: a read that returned nothing is its own state`)
          assert.equal(noHermes.readingLabel, copy.noHermesReading)
          assert.deepEqual(noHermes.readingNotes.map(note => note.state), ['no_reading'])
          assert.match(noHermes.readingNotes[0].text, copy.noteNoReading)

          // A failed read is an error, and is announced as one.
          const failed = row('memb:failed')
          assert.equal(failed.readingState, 'failed', `${locale} ${caseId}: a failed read is a failure`)
          assert.equal(failed.readingLabel, copy.failed)
          assert.deepEqual(failed.readingNotes.map(note => note.state), ['failed'])
          assert.match(failed.readingNotes[0].text, copy.noteFailed)

          // Nothing asked yet keeps the Unreported vocabulary and says why.
          const stored = row('memb:stored')
          assert.equal(stored.readingState, 'unreported',
            `${locale} ${caseId}: a stored view stays Unreported`)
          assert.equal(stored.readingLabel, copy.unreported)
          assert.deepEqual(stored.readingNotes.map(note => note.state), ['not_read'])
          assert.match(stored.readingNotes[0].text, copy.noteStored)

          // Arrangements, fees and the unconfigured account.
          assert.match(row('memb:included').fee, copy.included,
            `${locale} ${caseId}: an included route carries no separate fee`)
          assert.match(row('memb:prepaid').fee, copy.prepaid)
          assert.match(row('memb:nocred').fee, copy.metered)
          assert.match(row('memb:free').fee, copy.free)
          assert.ok(row('memb:nocred').stateChips.includes(copy.noCredential),
            `${locale} ${caseId}: a missing credential is named on the row`)

          // Absence is never rendered as a measured zero, anywhere in the pane.
          assert.equal(view.zeroMentions, 0,
            `${locale} ${caseId}: no zero usage or zero fee is invented (${view.zeroMentions})`)
          for (const entry of view.rows) {
            assert.doesNotMatch(entry.readingLabel, /0%/,
              `${locale} ${caseId}: ${entry.account} never reads as 0% used`)
            assert.doesNotMatch(entry.fee, /\(0%|0% used\)/,
              `${locale} ${caseId}: ${entry.account} fee never carries a usage percentage`)
          }
          assert.doesNotMatch(view.paneText, /\b0% used/,
            `${locale} ${caseId}: the pane never states 0% used`)

          // The Costs subscription-value link is present, reachable and labelled.
          assert.match(view.costsLink, copy.costs,
            `${locale} ${caseId}: the Costs link is labelled`)
          assert.equal(view.costsFocusable, true,
            `${locale} ${caseId}: the Costs link is keyboard reachable`)

          // Diagnostics stay optional and clearly labelled.
          assert.match(view.diagnosticsSummary, copy.diagnosticsLabel,
            `${locale} ${caseId}: the request log is a labelled disclosure`)
          assert.match(view.diagnosticsSummary, copy.diagnostics,
            `${locale} ${caseId}: the request log is marked optional`)

          // The attention summary states its scope in the reader's language.
          assert.ok(view.attentionScope.length > 0,
            `${locale} ${caseId}: the attention count states what it counts`)
        }
        assert.equal(result.hostCalls, 0, `${locale}: no host/gateway calls were made`)
      }
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })
}
