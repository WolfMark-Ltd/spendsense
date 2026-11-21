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
const boot = async ({ locale = 'en' } = {}) => {
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
  respond = () => clarityResponse()
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

test('every reading state is named separately, in the reader\'s language', async () => {
  const container = await boot()
  // A successful provider reading states its age.
  const reported = readingOf(container, 'memb:reported')
  assert.equal(reported.state, 'reported', 'a provider reading is Reported')
  assert.equal(reported.label, 'Reported')
  assert.match(reported.age, /Provider reading from 10 min ago/,
    `a provider reading states how old it is: ${reported.age}`)
  assert.deepEqual(reported.notes, [], 'a healthy reading is not explained per card')

  // Hermes cannot read this route: a data limitation, with its own words.
  const unsupported = readingOf(container, 'memb:unsupported')
  assert.equal(unsupported.state, 'unsupported',
    'an unreadable route is not reported as unreported')
  assert.equal(unsupported.label, 'Not available from Hermes')
  assert.deepEqual(unsupported.notes, [],
    'the normal limitation is explained once, on the page, not per card')

  // Hermes answered without a reading: not permanent, not an error.
  const noReading = readingOf(container, 'memb:nohermes')
  assert.equal(noReading.state, 'no_reading', 'a read that returned nothing is its own state')
  assert.equal(noReading.label, 'No reading from Hermes')
  assert.deepEqual(noReading.notes, [], 'a returned-nothing read is not repeated per card')

  // A failed read is an error, and is announced as one.
  const failed = readingOf(container, 'memb:failed')
  assert.equal(failed.state, 'failed', 'a failed read is a failure')
  assert.equal(failed.label, 'Read failed')
  assert.deepEqual(failed.notes.map(note => note.state), ['failed'])
  assert.match(failed.notes[0].text, /could not be fetched/,
    `the failure says what happened: ${failed.notes[0].text}`)

  // Nothing asked yet keeps the Unreported vocabulary.
  const stored = readingOf(container, 'memb:stored')
  assert.equal(stored.state, 'unreported', 'a stored view stays Unreported')
  assert.equal(stored.label, 'Unreported')
  assert.deepEqual(stored.notes, [], 'the stored view is not explained per card')

  // F85: one page-level explanation for the routes Hermes cannot read, and a
  // health line that counts them separately from attention.
  assert.match(container.textContent, /No reading from Hermes[\s\S]{0,400}?normal data limitation/,
    'the page states the Hermes data limitation once')
  const health = container.querySelector('[data-reading-health]')
  assert.ok(health, 'the page states provider reading health')
  assert.match(health.textContent, /Provider readings:/)
  assert.match(health.textContent, /2 with no reading from Hermes/,
    'the provider summary counts the routes Hermes cannot read')
  assert.match(health.textContent, /1 failed/, 'a failed read is counted in the reading summary')
  assert.equal(container.querySelector('[data-reading-failed]')?.getAttribute('data-reading-failed'), '1',
    'the failed count is machine-readable for a retry')
})

test('the reading vocabulary survives translation without collapsing states', async () => {
  const container = await boot({ locale: 'zh' })
  const expected = {
    'memb:reported': ['reported', '已上报'],
    'memb:unsupported': ['unsupported', 'Hermes 无法提供'],
    'memb:nohermes': ['no_reading', 'Hermes 未提供读数'],
    'memb:failed': ['failed', '读取失败'],
    'memb:stored': ['unreported', '未上报'],
  }
  for (const [id, [state, label]] of Object.entries(expected)) {
    const reading = readingOf(container, id)
    assert.equal(reading.state, state, `${id} keeps its state in Chinese`)
    assert.equal(reading.label, label, `${id} is named in the reader's language`)
  }
  assert.deepEqual(
    ['reviewed', 'paid', 'attention', 'fees'].map(kind => cardOf(container, kind).label),
    ['已检查账户', '付费订阅', '需要注意', '会员费用'],
    'the four headline readings are named in order, in Chinese')
  assert.deepEqual(cardOf(container, 'fees').lines, ['USD 110.00/月', 'EUR 19.99/月'],
    'fee lines keep their currency, period and one-per-line shape in Chinese')
})

test('absence is never rendered as a measured zero', async () => {
  const container = await boot()
  // An unpriced plan names the gap rather than printing 0.
  const unpriced = readingOf(container, 'memb:nohermes')
  assert.match(unpriced.fee, /no published price/,
    `an unpriced plan states why there is no figure: ${unpriced.fee}`)
  assert.doesNotMatch(unpriced.fee, /[$€£]0\.00/, 'an unknown fee never becomes zero')
  assert.equal(unpriced.status, 'Needs attention',
    'a chosen plan with no price is attention, not a confirmed zero')

  // A metered route names its arrangement instead of inventing a fee.
  const metered = readingOf(container, 'memb:nocred')
  assert.match(metered.fee, /Metered API · no recurring membership fee/)
  assert.equal(metered.status, 'No credential', 'a missing credential is named on the row')

  // Nowhere in the pane does an unobserved allowance read as a percentage.
  const text = container.textContent.replace(/\s+/g, ' ')
  assert.doesNotMatch(text, /\b0% used/, 'the pane never states 0% used')
  assert.doesNotMatch(text, /[$€£]0\.00/, 'no zero amount is invented anywhere in the pane')
  for (const id of ['memb:reported', 'memb:unsupported', 'memb:nohermes', 'memb:failed', 'memb:stored']) {
    const reading = readingOf(container, id)
    assert.doesNotMatch(reading.label, /0%/, `${id} never reads as 0% used`)
    assert.doesNotMatch(reading.fee, /0% used/, `${id} fee never carries a usage percentage`)
  }
})

test('the summary reconciles and never calls a scope count a subscription', async () => {
  const container = await boot()
  assert.deepEqual(['reviewed', 'paid', 'attention', 'fees'].map(kind => cardOf(container, kind).label),
    ['Accounts reviewed', 'Paid subscriptions', 'Needs attention', 'Membership fees'],
    'the four headline readings are named in order')

  const reviewed = cardOf(container, 'reviewed')
  assert.equal(reviewed.value, '9', 'every account is counted once as reviewed')
  assert.equal(reviewed.status, 'All arrangements', 'a reviewed account is not called a subscription')
  assert.match(reviewed.note, /not subscribed/, 'the reviewed card says what it does not mean')

  const paid = cardOf(container, 'paid')
  assert.equal(paid.value, '4', 'only subscription accounts with a chosen plan are paid')
  assert.equal(paid.status, '1 fee unknown', 'a paid account with no fee amount is named as unknown')
  assert.equal(paid.tone, 'attention', 'an unknown fee changes the paid card\'s accent')
  assert.match(paid.note, /Free, included and prepaid accounts are counted by arrangement/,
    'the paid count states what it excludes')

  // Strengthened: the attention count and its status are asserted explicitly.
  // The browser suite derived the expected status from the observed value
  // (`value === '0' ? Clear : Open`), which passes whatever the count is.
  const attention = cardOf(container, 'attention')
  assert.equal(attention.value, '2',
    'the unfunded paid plan and the unconfirmed account need attention')
  assert.equal(attention.status, 'Needs action', 'two reasons are an action, never "None"')
  assert.match(attention.note, /Plan setup and allowance marks/,
    'the attention count states what it measures')
  assert.match(attention.note, /failed provider read is reported separately/i,
    'attention never absorbs a reading failure')

  const fees = cardOf(container, 'fees')
  assert.deepEqual(fees.lines, ['USD 110.00/mo', 'EUR 19.99/mo'],
    'one fee line per currency, never summed')
  assert.equal(fees.status, 'Declared', 'a recorded fee is Declared')
  assert.match(fees.note, /Not a bill/, 'the fee card says it is not a bill')
  assert.equal(fees.tone, 'declared', 'a recorded fee carries the declared accent')

  // Distinct accents: a scope count, an attention count and a declared fee
  // never share a rail.
  assert.notEqual(reviewed.tone, paid.tone, 'a scope count and a paid count differ')
  assert.notEqual(attention.tone, fees.tone, 'attention and declared readings do not share an accent')
})

test('accounts group by arrangement, and each heading states its own count', async () => {
  const container = await boot()
  const groups = [...container.querySelectorAll('[data-group-kind]')]
  assert.deepEqual(groups.map(el => el.getAttribute('data-group-kind')),
    ['paid', 'free', 'included', 'prepaid', 'metered', 'unconfirmed'],
    'accounts are grouped by arrangement, in a stable order')
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
  assert.deepEqual(counts, [4, 1, 1, 1, 1, 1], 'every account lands in exactly one group')
  for (const [index, heading] of groups.entries()) {
    assert.equal(heading.querySelector('.wm-membership-group-count')?.textContent.trim(),
      String(counts[index]),
      `the group heading states its own count (${heading.textContent.trim().slice(0, 40)})`)
  }
  // Every account on the page is inside exactly one group.
  const grouped = counts.reduce((sum, count) => sum + count, 0)
  assert.equal(grouped, container.querySelectorAll('[data-account]').length,
    'no account is rendered outside a group')
  // F28/F30: the normal view never shows a technical route slug, and a slug is
  // replaced by a friendly name.
  const text = container.textContent.replace(/\s+/g, ' ')
  assert.doesNotMatch(text, /commandcode-anthropic|opencode-zen|xai-oauth/,
    'no technical route slug is shown in the normal view')
  assert.match(rowOf(container, 'memb:unsupported').textContent, /CommandCode \(Anthropic route\)/,
    'a route slug is replaced by a friendly name')
  assert.equal(rowOf(container, 'memb:stored').getAttribute('data-arrangement'), 'unconfirmed',
    'an unconfirmed account is not called "no current plan"')
})

test('backend messages stay behind the technical details', async () => {
  const container = await boot()
  const diagnostics = container.querySelector('[data-wm-diagnostics]')
  assert.ok(diagnostics, 'the technical details disclosure renders')
  assert.match(diagnostics.querySelector('summary')?.textContent || '', /Technical details/i,
    'the disclosure is named plainly')
  assert.match(diagnostics.textContent, /optional/i, 'the request log is marked optional')
  // The raw provider message is inside that disclosure and nowhere else, so a
  // closed disclosure keeps it out of the normal view (the Chromium suite still
  // measures that visibility directly).
  const note = container.querySelector('[data-wm-backend-notes]')
  assert.ok(note, 'the backend messages render inside the diagnostics')
  assert.equal(note.closest('[data-wm-diagnostics]'), diagnostics,
    'the backend messages are inside the technical details')
  // The message appears in one text node, inside that disclosure and nowhere
  // else. Walk text nodes: reading textContent off every element would copy
  // the whole subtree repeatedly and is slow on a page this size.
  const carriers = []
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeValue.includes('TimeoutExpired')
      && !node.parentElement.closest('[data-wm-diagnostics]')) carriers.push(node.nodeValue.trim())
  }
  assert.deepEqual(carriers, [], 'no raw provider error is rendered outside the technical details')
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
