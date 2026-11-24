/**
 * Memberships reading states, rendered browserlessly — real React, real
 * TanStack Query, real plugin bundle, synthetic accounts.
 *
 * These assertions used to run inside `memberships-clarity.test.mjs`: the
 * reading vocabulary, the summary contract and the arrangement groups,
 * re-verified once per layout case × locale in Chromium, under `--dump-dom`.
 * They are data and copy, not geometry, so they belong here — where they run
 * in seconds and fail on the assertion, not on a virtual-time race. Chromium
 * keeps the layout, colour, focus and interaction evidence that suite exists
 * for.
 *
 * The accounts are the SAME ones the browser harness renders:
 * `test/memberships-fixtures.mjs` is the single definition.
 *
 * Setup once: npm ci --prefix test/harness
 * Run with:   bash scripts/node-tests.sh browserless
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { clarityResponse } from './memberships-fixtures.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const HARNESS_MODULES = join(ROOT, 'test', 'harness', 'node_modules')

if (!existsSync(join(HARNESS_MODULES, '@tanstack', 'react-query'))) {
  throw new Error('real-query harness is not installed: run `npm ci --prefix test/harness`')
}

const work = mkdtempSync(join(tmpdir(), 'wm-members-reading-'))
process.on('exit', () => rmSync(work, { recursive: true, force: true }))

// --- one bundle: plugin + real React + real query ---------------------------
const entry = join(work, 'entry.mjs')
writeFileSync(entry, `
export { default as plugin, __test as T } from '${join(ROOT, 'desktop', 'plugin.js')}'
export * as React from 'react'
export * as ReactDOMClient from 'react-dom/client'
export { QueryClientProvider, queryClient, i18nBackend } from '@hermes/plugin-sdk'
`)
const bundle = join(work, 'bundle.mjs')
const esbuild = (await import(pathToFileURL(join(HARNESS_MODULES, 'esbuild', 'lib', 'main.js')).href)).default
await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: bundle,
  alias: {
    '@hermes/plugin-sdk': join(ROOT, 'test', 'harness', 'real-sdk.mjs'),
    // One React: npm installs a peer copy into test/harness, and two copies
    // means a null dispatcher inside the provider.
    react: join(HARNESS_MODULES, 'react'),
    'react-dom': join(HARNESS_MODULES, 'react-dom'),
  },
  nodePaths: [HARNESS_MODULES],
  logLevel: 'warning',
})

const { JSDOM } = await import(pathToFileURL(join(HARNESS_MODULES, 'jsdom', 'lib', 'api.js')).href)
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/' })
const define = (name, value) => Object.defineProperty(globalThis, name, {
  value, configurable: true, writable: true,
})
define('window', dom.window)
define('document', dom.window.document)
define('navigator', dom.window.navigator)
define('HTMLElement', dom.window.HTMLElement)
define('Node', dom.window.Node)
define('NodeFilter', dom.window.NodeFilter)
define('Event', dom.window.Event)
define('MouseEvent', dom.window.MouseEvent)
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const lib = await import(pathToFileURL(bundle).href)
const { plugin, T, React, ReactDOMClient, QueryClientProvider, queryClient, i18nBackend } = lib

// --- locale: the product's own catalogue, never a test-only table -----------
const translator = locale => (key, ...args) => {
  const entry = T.I18N[locale][key]
  return typeof entry === 'function' ? entry(...args) : entry ?? key
}
i18nBackend.t = translator('en')

// --- transport -------------------------------------------------------------
let respond = () => clarityResponse()
plugin.register({
  rest: async path => {
    if (path.startsWith('/membership/accounts')) return respond()
    if (path.startsWith('/membership/plans')) return { ok: true, plans: [], vocabulary: {} }
    if (path.startsWith('/allowance/weather')) return { ok: true, accounts: [] }
    return { ok: true }
  },
  storage: { get: (_k, d) => d, set() {}, delete() {} },
  register() {}, registerMany() {}, onDispose() {}, onEvent: () => () => {},
  setTimeout: fn => { const timer = setTimeout(fn, 0); return () => clearTimeout(timer) },
  setInterval: () => () => {},
  addEventListener: () => () => {},
  os: {}, pet: null, i18n: { register() {}, t: key => key },
})

const roots = []
const flush = async (times = 6) => {
  await React.act(async () => {
    for (let i = 0; i < times; i += 1) await new Promise(resolve => setTimeout(resolve, 0))
  })
}

/** Render the real MembershipsPage over the shared account matrix. */
const boot = async ({ locale = 'en', accounts = null } = {}) => {
  queryClient.clear()
  T.$membershipSnapshot.set(null)
  T.$membershipDraft.set(null)
  T.$membershipNotice.set(null)
  T.$membershipBusy.set(null)
  T.$membershipNative.set(false)
  T.$membershipTarget.set(null)
  T.$membershipExpanded.set({ origin: null, ids: [] })
  T.$membershipAttentionOnly.set(false)
  T.$ledgerTab.set('memberships')
  // An accounts override renders a focused matrix for states the shared
  // clarity matrix does not cover; the shared fixtures stay untouched.
  respond = accounts ? () => ({ ...clarityResponse(), accounts }) : () => clarityResponse()
  i18nBackend.t = translator(locale)
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = ReactDOMClient.createRoot(container)
  roots.push(root)
  await React.act(async () => {
    root.render(React.createElement(QueryClientProvider, { client: queryClient },
      React.createElement(T.MembershipsPage)))
  })
  await flush()
  return container
}

after(() => { queryClient.clear(); dom.window.close(); esbuild.stop() })
test.afterEach(async () => {
  while (roots.length) {
    const root = roots.pop()
    try { await React.act(async () => { root.unmount() }) } catch { /* already gone */ }
  }
  queryClient.clear()
})

// --- what the rendered page says -------------------------------------------
/** One account row, located by its own identity rather than by position. */
const rowOf = (container, id) => {
  const row = container.querySelector(`[data-account="${id}"]`)
  assert.ok(row, `${id} renders`)
  return row
}

/** The reading chip, its notes and the row's own copy. */
const readingOf = (container, id) => {
  const row = rowOf(container, id)
  const chip = row.querySelector('.wm-chip')
  assert.ok(chip, `${id} renders a reading chip`)
  return {
    row,
    state: chip.getAttribute('data-state'),
    label: chip.textContent.trim(),
    notes: [...row.querySelectorAll('[data-reading-note]')]
      .map(note => ({ state: note.getAttribute('data-reading-note'), text: note.textContent.trim() })),
    age: row.querySelector('[data-reading-age]')?.textContent.trim() || '',
    fee: row.querySelector('.wm-row-fee')?.textContent.trim() || '',
    status: row.querySelector('.wm-row-state')?.textContent.trim() || '',
  }
}

/** One headline card, by its kind. */
const cardOf = (container, kind) => {
  const card = container.querySelector(`[data-summary-card="${kind}"]`)
  assert.ok(card, `the ${kind} card renders`)
  return {
    card,
    tone: card.getAttribute('data-tone'),
    label: card.querySelector('.wm-membership-summary-label')?.textContent.trim() || '',
    value: card.querySelector('.wm-membership-summary-value')?.textContent.trim() || '',
    status: card.querySelector('.wm-membership-summary-status')?.textContent.trim() || '',
    note: card.querySelector('.wm-membership-summary-note')?.textContent.trim() || '',
    lines: [...card.querySelectorAll('.wm-membership-fee-lines li')].map(li => li.textContent.trim()),
  }
}

// ---------------------------------------------------------------------------
// Every expectation below runs for both languages. The Chromium suites checked
// these per locale; a replacement that checks only English would leave the
// Chinese wording able to regress silently.
const COPY = {
  en: {
    reported: 'Reported', reportedAge: /Provider reading from 10 min ago/,
    unsupported: 'Not available from Hermes',
    noReading: 'No reading from Hermes',
    failed: 'Read failed', failedNote: /could not be fetched/,
    unreported: 'Unreported',
    included: /Included in another account[’']s subscription/,
    prepaid: /Prepaid credits · no recurring membership fee/,
    metered: /Metered API · no recurring membership fee/,
    free: /Free access · no membership fee/,
    noCredential: 'No credential',
    unpriced: /no published price/,
    explainer: /No reading from Hermes[\s\S]{0,400}?normal data limitation/,
    health: /Provider readings:/,
    healthNoReading: /2 with no reading from Hermes/,
    healthFailed: /1 failed/,
    attentionScope: /Plan setup and allowance marks/,
    diagnostics: /Technical details/i,
    optional: /optional/i,
    summaryLabels: ['Accounts reviewed', 'Paid subscriptions', 'Needs attention', 'Membership fees'],
    reviewedStatus: 'All arrangements', reviewedNote: /not subscribed/,
    paidUnknown: '1 fee unknown',
    paidNote: /Free, included and prepaid accounts are counted by arrangement/,
    attentionStatus: 'Needs action',
    attentionNote: /Plan setup and allowance marks\. A failed provider read is reported separately/,
    feesStatus: 'Declared', feesNote: /Not a bill/,
    feeLines: ['USD 110.00/mo', 'EUR 19.99/mo'],
  },
  zh: {
    reported: '已上报', reportedAge: /提供方读数来自 10 分钟前/,
    unsupported: 'Hermes 无法提供',
    noReading: 'Hermes 未提供读数',
    failed: '读取失败', failedNote: /无法获取提供方读数/,
    unreported: '未上报',
    included: /包含在另一账户的订阅中/,
    prepaid: /预付额度/,
    metered: /按量 API/,
    free: /免费访问/,
    noCredential: '无凭证',
    unpriced: /没有公布价格/,
    explainer: /Hermes 未提供读数[\s\S]{0,400}?正常的数据限制/,
    health: /提供方读数/,
    healthNoReading: /Hermes 未提供 2/,
    healthFailed: /失败 1/,
    attentionScope: /方案设置与额度标记/,
    diagnostics: /技术详情/,
    optional: /可选/,
    summaryLabels: ['已检查账户', '付费订阅', '需要注意', '会员费用'],
    reviewedStatus: '全部计费方式', reviewedNote: /不代表已订阅/,
    paidUnknown: '1 项费用未知',
    paidNote: /免费、共享与预付账户按计费方式另行统计/,
    attentionStatus: '需处理',
    attentionNote: /仅统计方案设置与额度标记；提供方读取失败另行报告/,
    feesStatus: '已声明', feesNote: /不是账单/,
    feeLines: ['USD 110.00/月', 'EUR 19.99/月'],
  },
}

const LOCALES = Object.keys(COPY)

test('every reading state is named separately, in both languages', async () => {
  for (const locale of LOCALES) {
    const copy = COPY[locale]
    const container = await boot({ locale })

    // A successful provider reading states its age.
    const reported = readingOf(container, 'memb:reported')
    assert.equal(reported.state, 'reported', `${locale}: a provider reading is Reported`)
    assert.equal(reported.label, copy.reported, `${locale}: the reported chip is localised`)
    assert.match(reported.age, copy.reportedAge,
      `${locale}: a provider reading states how old it is (${reported.age})`)
    assert.deepEqual(reported.notes, [], `${locale}: a healthy reading is not explained per card`)

    // Hermes cannot read this route: a data limitation, with its own words.
    const unsupported = readingOf(container, 'memb:unsupported')
    assert.equal(unsupported.state, 'unsupported',
      `${locale}: an unreadable route is not reported as unreported`)
    assert.equal(unsupported.label, copy.unsupported, `${locale}: the limitation is named`)
    assert.deepEqual(unsupported.notes, [],
      `${locale}: the normal limitation is explained once, on the page`)

    // Hermes answered without a reading: not permanent, not an error.
    const noReading = readingOf(container, 'memb:nohermes')
    assert.equal(noReading.state, 'no_reading', `${locale}: a read that returned nothing is its own state`)
    assert.equal(noReading.label, copy.noReading)
    assert.deepEqual(noReading.notes, [], `${locale}: a returned-nothing read is not repeated per card`)

    // A failed read is an error, and is announced as one.
    const failed = readingOf(container, 'memb:failed')
    assert.equal(failed.state, 'failed', `${locale}: a failed read is a failure`)
    assert.equal(failed.label, copy.failed)
    assert.deepEqual(failed.notes.map(note => note.state), ['failed'])
    assert.match(failed.notes[0].text, copy.failedNote,
      `${locale}: the failure says what happened (${failed.notes[0].text})`)

    // Nothing asked yet keeps the Unreported vocabulary.
    const stored = readingOf(container, 'memb:stored')
    assert.equal(stored.state, 'unreported', `${locale}: a stored view stays Unreported`)
    assert.equal(stored.label, copy.unreported)
    assert.deepEqual(stored.notes, [], `${locale}: the stored view is not explained per card`)

    // The arrangements that are not a recurring fee each say so in their own words.
    assert.match(readingOf(container, 'memb:included').fee, copy.included,
      `${locale}: an included route carries no separate fee`)
    assert.match(readingOf(container, 'memb:prepaid').fee, copy.prepaid,
      `${locale}: prepaid credits carry no recurring fee`)
    assert.match(readingOf(container, 'memb:nocred').fee, copy.metered,
      `${locale}: a metered route names its arrangement`)
    assert.match(readingOf(container, 'memb:free').fee, copy.free,
      `${locale}: a confirmed free tier is named as free access`)
    assert.equal(readingOf(container, 'memb:nocred').status, copy.noCredential,
      `${locale}: a missing credential is named on the row`)

    // F85: one page-level explanation, and a health line that counts the routes
    // Hermes cannot read separately from attention.
    assert.match(container.textContent, copy.explainer,
      `${locale}: the page states the Hermes data limitation once`)
    const health = container.querySelector('[data-reading-health]')
    assert.ok(health, `${locale}: the page states provider reading health`)
    assert.match(health.textContent, copy.health)
    assert.match(health.textContent, copy.healthNoReading,
      `${locale}: the provider summary counts the routes Hermes cannot read`)
    assert.match(health.textContent, copy.healthFailed,
      `${locale}: a failed read is counted in the reading summary`)
    assert.equal(container.querySelector('[data-reading-failed]')?.getAttribute('data-reading-failed'), '1',
      `${locale}: the failed count is machine-readable for a retry`)
    assert.match(container.querySelector('[data-attention-scope]')?.textContent || '', copy.attentionScope,
      `${locale}: the attention count says what it measures`)
  }
})

test('absence is never rendered as a measured zero, in both languages', async () => {
  for (const locale of LOCALES) {
    const copy = COPY[locale]
    const container = await boot({ locale })
    // An unpriced plan names the gap rather than printing 0.
    const unpriced = readingOf(container, 'memb:nohermes')
    assert.match(unpriced.fee, copy.unpriced,
      `${locale}: an unpriced plan states why there is no figure (${unpriced.fee})`)
    assert.doesNotMatch(unpriced.fee, /[$€£]0\.00/, `${locale}: an unknown fee never becomes zero`)

    // Nowhere in the pane does an unobserved allowance read as a percentage.
    const text = container.textContent.replace(/\s+/g, ' ')
    assert.doesNotMatch(text, /\b0% used/, `${locale}: the pane never states 0% used`)
    assert.doesNotMatch(text, /[$€£]0\.00/, `${locale}: no zero amount is invented anywhere in the pane`)
    for (const id of ['memb:reported', 'memb:unsupported', 'memb:nohermes', 'memb:failed', 'memb:stored']) {
      const reading = readingOf(container, id)
      assert.doesNotMatch(reading.label, /0%/, `${locale}: ${id} never reads as 0% used`)
      assert.doesNotMatch(reading.fee, /0% used/, `${locale}: ${id} fee never carries a usage percentage`)
    }
  }
})

test('the summary reconciles and never calls a scope count a subscription', async () => {
  for (const locale of LOCALES) {
    const copy = COPY[locale]
    const container = await boot({ locale })
    assert.deepEqual(['reviewed', 'paid', 'attention', 'fees'].map(kind => cardOf(container, kind).label),
      copy.summaryLabels, `${locale}: the four headline readings are named in order`)

    const reviewed = cardOf(container, 'reviewed')
    assert.equal(reviewed.value, '9', `${locale}: every account is counted once as reviewed`)
    assert.equal(reviewed.status, copy.reviewedStatus,
      `${locale}: a reviewed account is not called a subscription`)
    assert.match(reviewed.note, copy.reviewedNote,
      `${locale}: the reviewed card says what it does not mean`)

    const paid = cardOf(container, 'paid')
    assert.equal(paid.value, '4', `${locale}: only subscription accounts with a chosen plan are paid`)
    assert.equal(paid.status, copy.paidUnknown,
      `${locale}: a paid account with no fee amount is named as unknown`)
    assert.equal(paid.tone, 'attention', `${locale}: an unknown fee changes the paid card's accent`)
    assert.match(paid.note, copy.paidNote, `${locale}: the paid count states what it excludes`)

    // Strengthened: the attention count and its status are asserted explicitly.
    // The browser suite derived the expected status from the observed value
    // (`value === '0' ? Clear : Open`), which passes whatever the count is.
    const attention = cardOf(container, 'attention')
    assert.equal(attention.value, '2',
      `${locale}: the unfunded paid plan and the unconfirmed account need attention`)
    assert.equal(attention.status, copy.attentionStatus, `${locale}: two reasons are an action, never "None"`)
    assert.match(attention.note, copy.attentionNote,
      `${locale}: the attention count states what it measures`)

    const fees = cardOf(container, 'fees')
    assert.deepEqual(fees.lines, copy.feeLines,
      `${locale}: one fee line per currency, never summed`)
    assert.equal(fees.status, copy.feesStatus, `${locale}: a recorded fee is Declared`)
    assert.match(fees.note, copy.feesNote, `${locale}: the fee card says it is not a bill`)
    assert.equal(fees.tone, 'declared', `${locale}: a recorded fee carries the declared accent`)
    assert.notEqual(reviewed.tone, paid.tone, `${locale}: a scope count and a paid count differ`)
    assert.notEqual(attention.tone, fees.tone,
      `${locale}: attention and declared readings do not share an accent`)
  }
})

test('accounts group by arrangement, and each heading states its own count', async () => {
  for (const locale of LOCALES) {
    const container = await boot({ locale })
    const groups = [...container.querySelectorAll('[data-group-kind]')]
    assert.deepEqual(groups.map(el => el.getAttribute('data-group-kind')),
      ['paid', 'free', 'included', 'prepaid', 'metered', 'unconfirmed'],
      `${locale}: accounts are grouped by arrangement, in a stable order`)
    // The headings and their cards share one parent (a card keeps its identity
    // when an edit moves it between groups), so a group is the heading plus the
    // cards that follow it up to the next heading.
    const cardsOf = heading => {
      const cards = []
      for (let node = heading.nextElementSibling; node; node = node.nextElementSibling) {
        if (node.hasAttribute('data-group-kind')) break
        if (node.hasAttribute('data-account')) cards.push(node)
      }
      return cards
    }
    const counts = groups.map(heading => cardsOf(heading).length)
    assert.deepEqual(counts, [4, 1, 1, 1, 1, 1], `${locale}: every account lands in exactly one group`)
    for (const [index, heading] of groups.entries()) {
      assert.equal(heading.querySelector('.wm-membership-group-count')?.textContent.trim(),
        String(counts[index]),
        `${locale}: the group heading states its own count (${heading.textContent.trim().slice(0, 40)})`)
    }
    assert.equal(counts.reduce((sum, count) => sum + count, 0),
      container.querySelectorAll('[data-account]').length,
      `${locale}: no account is rendered outside a group`)

    // F28/F30: the normal view never shows a technical route slug, and a slug is
    // replaced by a friendly name.
    const text = container.textContent.replace(/\s+/g, ' ')
    assert.doesNotMatch(text, /commandcode-anthropic|opencode-zen|xai-oauth/,
      `${locale}: no technical route slug is shown in the normal view`)
    assert.match(rowOf(container, 'memb:unsupported').textContent, /CommandCode \(Anthropic route\)/,
      `${locale}: a route slug is replaced by a friendly name`)
    assert.equal(rowOf(container, 'memb:stored').getAttribute('data-arrangement'), 'unconfirmed',
      `${locale}: an unconfirmed account is not called "no current plan"`)
  }
})

test('a withheld anonymous reading explains itself on the card, in both languages', async () => {
  // F119: a named account whose provider reading arrived without an account
  // identity keeps its own state, and the rendered card says why the reading
  // was withheld — the chip alone must never be the whole story.
  const account = {
    id: 'memb:unverified', family: 'anthropic', label: 'main',
    billing_arrangement: 'subscription', effective_arrangement: 'subscription',
    plan_id: 'anthropic.claude-max', plan: { name: 'Claude Max 20x' },
    fee: { basis: 'catalogue', effective: { amount: 100, currency: 'USD', period: 'month' } },
    quota: { provider_state: 'identity_unverified', age_seconds: null, has_provider_reporting: true,
      windows: [{ id: 'weekly', label: 'Weekly', used_percent: null, state: 'no_data',
        scope: 'account', basis: ['none'] }] },
    native_probe: { state: 'ok', reason: '' },
    manual_exhaustions: [], fee_overrides: [], plan_choices: [], excluded_plans: [],
    rev: 'r1', route_entitlement_rev: 'route-r1', credential_present: true,
  }
  const note = { en: /withheld rather than shown/, zh: /暂不显示/ }
  for (const locale of LOCALES) {
    const container = await boot({ locale, accounts: [account] })
    const reading = readingOf(container, 'memb:unverified')
    assert.equal(reading.state, 'unverified', `${locale}: the chip names the withheld reading`)
    const explained = reading.notes.filter(entry => entry.state === 'unverified')
    assert.equal(explained.length, 1, `${locale}: the card renders exactly one unverified note`)
    assert.match(explained[0].text, note[locale],
      `${locale}: the note says why Hermes' reading was withheld`)
  }
})

test('backend messages stay behind the technical details, in both languages', async () => {
  for (const locale of LOCALES) {
    const copy = COPY[locale]
    const container = await boot({ locale })
    const diagnostics = container.querySelector('[data-wm-diagnostics]')
    assert.ok(diagnostics, `${locale}: the technical details disclosure renders`)
    assert.match(diagnostics.querySelector('summary')?.textContent || '', copy.diagnostics,
      `${locale}: the disclosure is named plainly`)
    assert.match(diagnostics.textContent, copy.optional, `${locale}: the request log is marked optional`)
    // The raw provider message is inside that disclosure and nowhere else, so a
    // closed disclosure keeps it out of the normal view (the Chromium suite
    // still measures that visibility directly).
    const note = container.querySelector('[data-wm-backend-notes]')
    assert.ok(note, `${locale}: the backend messages render inside the diagnostics`)
    assert.equal(note.closest('[data-wm-diagnostics]'), diagnostics,
      `${locale}: the backend messages are inside the technical details`)
    const carriers = []
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.nodeValue.includes('TimeoutExpired')
        && !node.parentElement.closest('[data-wm-diagnostics]')) carriers.push(node.nodeValue.trim())
    }
    assert.deepEqual(carriers, [],
      `${locale}: no raw provider error is rendered outside the technical details`)
  }
})

test('the memberships stylesheet carries the disclosure and highlight contracts', async () => {
  // Moved from memberships-disclosure.test.mjs and memberships-polish.test.mjs.
  // A closed <details> summary pseudo-element keeps its previous transform
  // until the next paint, so those suites could only ever assert the rule
  // string — and they did, from inside a browser run. Asserting the rules
  // directly needs no browser; what stays in Chromium is the computed
  // transform of an OPEN group, which a browser alone can report.
  const css = T.MEMBERSHIP_CSS
  const openRule = '.wm-group[open] > summary::before{transform:rotate(90deg)}'
  const closedStart = '.wm-group > summary::before{content:"\u203A"'
  assert.ok(css.includes(openRule), 'the chevron rotates for an open group only')
  assert.ok(css.includes(closedStart), 'the closed chevron is the unscoped rule')
  const closedRule = css.slice(css.indexOf(closedStart), css.indexOf('}', css.indexOf(closedStart)) + 1)
  assert.ok(!closedRule.includes('rotate'), 'a closed group does not inherit the open rotation')

  // The attention highlight: an animation, and a static replacement for
  // readers who ask for reduced motion.
  assert.match(css, /\.wm-flash\{[^}]*animation:wm-flash/, 'the highlight animates')
  assert.match(css, /@media \(prefers-reduced-motion:reduce\)\{\.wm-flash\{animation:none\}/,
    'reduced motion keeps the highlight static instead of pulsing')

  // The arrangement control wraps rather than overflowing a narrow card.
  assert.match(css, /\.wm-seg\{[^}]*flex-wrap:wrap/, 'the arrangement control wraps')
  assert.match(css, /\.wm-seg button\{[^}]*min-width:0/, 'its buttons may shrink inside the card')
})
