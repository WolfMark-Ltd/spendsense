import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const MODULES = join(ROOT, 'test/harness/node_modules')
// Every binary the real Chrome discovery may pick. The probe's discovery
// mock must hide ALL of them (CHROME_MOCK_HIDE, below) so a browserless host
// — including a Chromium-only one — always simulates absence.
const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
]
const CHROME = CHROME_CANDIDATES.find(existsSync)

// Realistic-fixture identities the candidate assertions reason about, derived
// from the committed fixture so regenerated data never desynchronises tests.
const REALISTIC = JSON.parse(readFileSync(join(ROOT, 'test/fixtures/news/realistic.json'), 'utf8'))
const VARIANTS = JSON.parse(readFileSync(join(ROOT, 'test/fixtures/news/variants.json'), 'utf8'))
const NEWS_ITEMS = [...REALISTIC.local.items, ...REALISTIC.central.items]
// Mirror of the UI's newsIsRelevant: read-time relevance wins, the stored
// flag fills in. These counts drive the For You / All card expectations so
// regenerated fixtures cannot desynchronise the baseline assertions.
const isRelevant = item => (item.relevance && typeof item.relevance === 'object')
  ? !!item.relevance.relevant
  : !!item.for_you
const RELEVANT_COUNT = NEWS_ITEMS.filter(isRelevant).length
const TOTAL_COUNT = NEWS_ITEMS.length
const PARTIAL_ITEMS = [
  ...VARIANTS.partial.local.items, ...VARIANTS.partial.central.items,
]
const PARTIAL_RELEVANT = PARTIAL_ITEMS.filter(isRelevant).length
const uniqueId = predicate => {
  const hits = NEWS_ITEMS.filter(predicate)
  assert.equal(hits.length, 1, `fixture lookup unique: ${hits.map(hit => hit.id).join(', ')}`)
  return hits[0].id
}
const KIMI_LOCAL = uniqueId(item => item.origin === 'local' && item.model === 'kimi-k2.5')
const KIMI_CENTRAL_PREFIX = 'central-2026-11-07-moonshotai'
const KIMI_CENTRAL = uniqueId(item => item.id.startsWith(KIMI_CENTRAL_PREFIX))
const GEMINI_CUT_A = uniqueId(item => item.model === 'gemini-3-flash' && item.source_url.endsWith('cut-a'))
const GEMINI_CUT_B = uniqueId(item => item.model === 'gemini-3-flash' && item.source_url.endsWith('cut-b'))
const MISTRAL_FIRST = uniqueId(item => item.model === 'mistral-large-3' && item.effective_at === '2026-11-01')
const MISTRAL_REPEAT = uniqueId(item => item.model === 'mistral-large-3' && item.effective_at === '2026-11-05')
const DEEPSEEK_LOCAL = uniqueId(item => item.model === 'deepseek-v4' && item.origin === 'local')
const DEEPSEEK_CENTRAL = uniqueId(item => item.model === 'deepseek-v4' && item.origin === 'central')
// Recency-timestamp variants: every stamp the recency rules must reject.
const TS_OLD = uniqueId(item => item.model === 'ts-old90day')
const TS_MALFORMED = uniqueId(item => item.model === 'ts-malformed')
const TS_FUTURE = uniqueId(item => item.model === 'ts-future')
const TS_EMPTY = uniqueId(item => item.model === 'ts-empty')
// Page-local evidence-payload identities (built in news-layout.page.jsx; not
// committed fixtures — see the README's evidence-variant note).
const EVIDENCE_HIST_LOCAL_ID = 'evidence-hist-local-1'
const EVIDENCE_HIST_CENTRAL_ID = 'evidence-hist-central-1'

// Mandatory candidate verification: either explicit flag requires the
// candidate DOM hooks — a mandatory run must FAIL, never skip, when the
// hooks are missing from the rendered page.
const MANDATORY = process.env.WP11_REQUIRE_CANDIDATE === '1'
  || process.env.WP11_CANDIDATE === '1'

// NEWS_LAYOUT_SHOTS must point OUTSIDE the repository: screenshots are
// generated artefacts and must never be written into the repo. The check is
// a lexical resolve plus a path-relative boundary test, so a repo-relative
// string or traversal cannot land inside the repo, the repo root itself is
// rejected, and a sibling directory whose name merely shares the repo root's
// prefix (e.g. `<root>-sibling`) is not falsely rejected.
const shotsOutsideRepo = target => {
  const resolved = resolve(String(target))
  const rel = relative(ROOT, resolved)
  const outside = rel !== '' && (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
  assert.ok(outside,
    `NEWS_LAYOUT_SHOTS must not point inside the repository: ${target} (resolved ${resolved})`)
  return resolved
}

const decode = text => text
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'")
  .replace(/&quot;/g, '"').replace(/&amp;/g, '&')

const RESULT_DIV = /<div id="news-layout-result"[^>]*>([\s\S]*?)<\/div>/

const chromeDom = (chrome, url) => {
  let last
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return execFileSync(chrome, [
        '--headless', '--disable-gpu', '--no-sandbox', '--virtual-time-budget=6000', '--dump-dom', url,
      ], { maxBuffer: 128 * 1024 * 1024, timeout: 120000 }).toString()
    } catch (error) {
      // Headless Chrome sometimes trips its teardown watchdog after the dump
      // was already recorded; accept a dump that contains the result div.
      const stdout = error?.stdout?.toString?.() || ''
      if (RESULT_DIV.test(stdout)) return stdout
      last = error
    }
  }
  throw last
}

const parsePayload = dom => {
  const match = dom.match(RESULT_DIV)
  assert.ok(match?.[1], 'Chromium records the Model News layout results')
  return JSON.parse(decode(match[1]))
}

// Built once and shared by both tests (bundle + two grid Chrome runs).
let HARNESS = null
async function harness() {
  if (HARNESS) return HARNESS
  const work = mkdtempSync(join(tmpdir(), 'wm-news-layout-'))
  process.on('exit', () => rmSync(work, { recursive: true, force: true }))
  const esbuild = (await import(pathToFileURL(join(MODULES, 'esbuild/lib/main.js')).href)).default
  const bundle = join(work, 'page.js')
  await esbuild.build({
    entryPoints: [join(ROOT, 'test/news-layout.page.jsx')], bundle: true,
    format: 'iife', platform: 'browser', outfile: bundle, jsx: 'automatic',
    alias: { '@hermes/plugin-sdk': join(ROOT, 'test/news-layout.sdk.mjs') },
    nodePaths: [MODULES], logLevel: 'warning',
  })
  const html = join(work, 'page.html')
  writeFileSync(html, `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box}body{margin:0;padding:10px;display:grid;grid-template-columns:380px 1200px;gap:10px;align-items:start;font:13px/1.5 system-ui,sans-serif}
.case{background:var(--ui-fill-primary);color:var(--ui-text-primary);min-width:0}
.case.dark{--ui-fill-primary:#12141a;--ui-fill-secondary:#1a1d26;--ui-fill-tertiary:#232633;--ui-stroke-secondary:#2b2f40;--ui-text-primary:#eef0f6;--ui-text-secondary:#b9bdd1;--ui-text-tertiary:#a9aec6;--ui-text-quaternary:#9398b0;--ui-accent:#7fa0ff;--ui-success:#2dd4bf;--ui-warning:#f5b544;--ui-error:#f26d6d}
.case.light{--ui-fill-primary:#fff;--ui-fill-secondary:#f2f4f7;--ui-fill-tertiary:#e3e5eb;--ui-stroke-secondary:#c5cbd5;--ui-text-primary:#151823;--ui-text-secondary:#414655;--ui-text-tertiary:#555b69;--ui-text-quaternary:#626877;--ui-accent:#3157c0;--ui-success:#087f5b;--ui-warning:#9a5e00;--ui-error:#b42318}
body[data-single]{display:block;padding:0}body[data-single="dark"]{background:#12141a}body[data-single="light"]{background:#fff}
body[data-single] .case{margin:0}
#news-layout-result{display:none}
</style></head><body><div id="news-layout-cases"></div><div id="news-layout-result"></div>
<script src="page.js"></script></body></html>`)
  const url = pathToFileURL(html).href
  // One Chrome run per (fixture, scope, locale) combo, chunked so no single
  // dump is heavy enough to trip headless teardown. A run whose total fits in
  // one chunk is used directly.
  const results = []
  const combos = []
  for (const locale of ['en', 'zh-CN'])
    for (const scope of ['foryou', 'all'])
      combos.push({ fixture: 'realistic', scope, locale })
  for (const fixture of ['empty', 'partial', 'nosignals'])
    for (const scope of ['foryou', 'all'])
      combos.push({ fixture, scope, locale: 'en' })
  for (const fixture of ['stale', 'error'])
    combos.push({ fixture, scope: 'foryou', locale: 'en' })
  for (const combo of combos) {
    const query = `fixture=${combo.fixture}&run=${combo.scope}&locale=${encodeURIComponent(combo.locale)}`
    const first = parsePayload(chromeDom(CHROME, `${url}?${query}&chunk=0&chunks=1`))
    if (first.total <= 5) { results.push(...first.cases); continue }
    const chunks = Math.ceil(first.total / 5)
    for (let index = 0; index < chunks; index += 1) {
      results.push(...parsePayload(chromeDom(CHROME, `${url}?${query}&chunk=${index}&chunks=${chunks}`)).cases)
    }
  }
  HARNESS = { work, url, results }
  return HARNESS
}

const runProbe = async (h, caseId) => {
  const result = parsePayload(chromeDom(CHROME, `${h.url}?case=${caseId}&probe=1`)).cases[0]
  assert.ok(result?.probe, `probe ${caseId} recorded`)
  return result
}

// A) known baseline defects. Entries here keep the strict assertion in place
// while documenting product bugs that exist on current origin/main. When the
// WP11 candidate layout fixes a defect, its matches() stops firing and the
// entry becomes inert — remove it then. Under a mandatory candidate run the
// waivers are disabled entirely: the candidate must clear the strict bar.
const KNOWN_BASELINE_DEFECTS = [{
  id: 'news-category-segments-overflow-380en',
  reason: 'Baseline defect: the real category AnalyticsSegments row cannot wrap '
    + 'or shrink (.wm-analytics .wm-segments is inline-flex with flex-shrink:0), '
    + 'so .wm-news-controls overflows by ~12-14px at 380px (both locales, both '
    + 'themes). Expected to be fixed by the WP11 candidate layout.',
  matches: r => r.w === 380 && r.overflow.length > 0
    && r.overflow.every(o => o.cls === 'wm-news-controls' && o.excess > 0 && o.excess <= 24),
}]

// Exact model-ID strings that must render verbatim (mirrors the page's list).
const EXACT_IDS = [
  'claude-sonnet-4-5-20250929', 'claude-sonnet-4-5',
  'claude-opus-4-1-20250805-thinking', 'gpt-5.6-sol', 'gpt-5.6-sol-pro',
  'openrouter/anthropic/claude-sonnet-4.5', 'deepseek-ai/deepseek-v4-pro',
]

// Candidate pagination semantics. The final UI shows the first
// NEWS_FOR_YOU_LIMIT ranked groups on For You and the first NEWS_PAGE_SIZE
// entries on All; completeness is always asserted on the EXPANDED list
// (after show-all / load-more), never redefined away. Grouping turns N
// relevant events into one entry per distinct model (+ one per model-less
// card), which is what the paginated counts below derive from.
const NEWS_PAGE_SIZE = 10
const NEWS_FOR_YOU_LIMIT = 5
const FOR_YOU_GROUPS = new Set(NEWS_ITEMS.filter(isRelevant)
  .map(item => item.model).filter(Boolean)).size
const PARTIAL_FOR_YOU_GROUPS = new Set(PARTIAL_ITEMS.filter(isRelevant)
  .map(item => item.model).filter(Boolean)).size
const ALL_ENTRIES = new Set(NEWS_ITEMS.map(item => item.model).filter(Boolean)).size
  + NEWS_ITEMS.filter(item => !item.model).length
const PARTIAL_ENTRIES = new Set(PARTIAL_ITEMS.map(item => item.model).filter(Boolean)).size
  + PARTIAL_ITEMS.filter(item => !item.model).length
// Exact IDs that belong on For You at all (the relevant subset); the
// remaining exact IDs are covered by the complete All list.
const FOR_YOU_EXACT = EXACT_IDS.filter(id =>
  NEWS_ITEMS.some(item => isRelevant(item) && item.model === id))
// Localised "(N groups)" / "(N updates)" scope-tab count wording.
const countLabelRegex = n => new RegExp(`\\(${n} (groups?|updates?|个分组|条动态)\\)`)

test('Model News baseline invariants and WCAG contrast (real NewsPage, committed fixtures)', {
  skip: CHROME || MANDATORY ? false : 'No Chromium binary available for real Model News layout checks',
}, async t => {
  if (!CHROME) {
    assert.fail('No Chromium binary available for real Model News layout checks, but '
      + 'WP11_REQUIRE_CANDIDATE=1 or WP11_CANDIDATE=1 makes the candidate verification '
      + 'mandatory: FAILING, never skipping.')
  }
  const h = await harness()
  const results = h.results
  const worstContrast = results.filter(r => r.contrast.min != null)
    .sort((a, b) => a.contrast.min - b.contrast.min)[0]
  t.diagnostic(`Minimum badge/chip/impact contrast: ${JSON.stringify({
    case: worstContrast?.id, ...worstContrast?.contrast,
  })}`)
  assert.equal(results.length, 24)
  const realistic = results.filter(r => r.fixture === 'realistic')
  assert.equal(realistic.length, 16)

  // Under a mandatory candidate run no baseline-defect waiver may soften the
  // strict bar.
  const defects = MANDATORY ? [] : KNOWN_BASELINE_DEFECTS
  for (const r of results) {
    const label = r.id
    if (r.fixture === 'error') {
      // The transport failure is the fixture; it must be the only query error.
      assert.deepEqual(r.errors,
        ['Synthetic refresh failure (verification fixture): the news service is unreachable.'],
        `${label} fails with the synthetic transport error only`)
    } else {
      assert.deepEqual(r.errors, [], `${label} renders without page errors`)
    }
    // A) no horizontal overflow in any card or control, except documented
    // known baseline defects (see KNOWN_BASELINE_DEFECTS above)
    const knownDefect = defects.find(defect => defect.matches(r))
    assert.deepEqual(knownDefect ? [] : r.overflow, [],
      `${label} has no overflowing card or control content: ${JSON.stringify(r.overflow)}`)
    if (knownDefect) {
      assert.ok(true, `${label} overflow covered by known baseline defect ${knownDefect.id}`)
    }
    // C) WCAG contrast of badge/chip/impact text (state-only fixtures render
    // none of these elements; card-bearing cases must sample them)
    if (r.contrast.count > 0) {
      assert.ok(r.contrast.min >= 4.5,
        `${label} badge/chip/impact contrast >= 4.5:1 (worst ${JSON.stringify(r.contrast.worst)})`)
    } else {
      const cardBearing = r.fixture === 'realistic' || r.fixture === 'partial'
        || r.fixture === 'stale' || (r.fixture === 'nosignals' && r.scope === 'all')
      assert.ok(!cardBearing, `${label} renders contrast-checkable badge/chip/impact elements`)
    }
    // A) no entitlement, actual-charge or blended-percentage wording
    assert.deepEqual(Object.keys(r.forbidden), [], `${label} keeps forbidden wording out: ${JSON.stringify(r.forbidden)}`)

    if (r.fixture === 'realistic') {
      // A) exact model ID strings render verbatim. The baseline flat list
      // shows every relevant event on For You and every item on All, so it
      // must carry every exact ID; the candidate design paginates (For You:
      // initial ranked-group page; All: first NEWS_PAGE_SIZE entries), so
      // there this scope asserts the rendered subset only — full candidate
      // coverage is asserted after load-more / show-all in the candidate
      // test, never weakened.
      if (r.scope === 'all' && !r.candidateDetected) {
        assert.deepEqual(r.exactExpected, EXACT_IDS, `${label} expects every exact ID`)
      } else {
        assert.ok(r.exactExpected.length > 0
          && r.exactExpected.every(id => EXACT_IDS.includes(id)),
        `${label} exact expectations stay within the real ID set`)
      }
      assert.deepEqual(r.exactMissing, [], `${label} renders every exact model ID verbatim`)
      if (!r.candidateDetected) {
        // A) every fixture item maps to exactly one rendered card, and every
        // model/provider/source is present (flat pages show everything)
        assert.deepEqual(r.ids.missing, [], `${label} maps every fixture item to a card: missing ${JSON.stringify(r.ids.missing)}`)
        assert.deepEqual(r.presence.missingModel, [], `${label} shows every model`)
        assert.deepEqual(r.presence.missingProvider, [], `${label} shows every provider`)
        assert.deepEqual(r.presence.missingSource, [], `${label} links every source URL`)
      }
      assert.equal(r.ids.extraCards, 0, `${label} renders no unexplained cards`)
      const forYouLabel = r.labels.find(text => /for you|为你推荐/i.test(text))
      const allLabel = r.labels.find(text => /all updates|全部动态/i.test(text))
      if (r.candidateDetected) {
        assert.match(forYouLabel || '',
          countLabelRegex(FOR_YOU_GROUPS), `${label} For You count (grouped)`)
        assert.match(allLabel || '',
          countLabelRegex(ALL_ENTRIES), `${label} All Updates count (grouped)`)
      } else {
        assert.match(forYouLabel || '',
          new RegExp(`\\(${RELEVANT_COUNT}\\)`), `${label} For You count`)
        assert.match(allLabel || '',
          new RegExp(`\\(${TOTAL_COUNT}\\)`), `${label} All Updates count`)
      }
      if (r.scope === 'foryou') {
        // candidate For You shows the initial ranked-group page, not all events
        assert.equal(r.cards, r.candidateDetected ? Math.min(NEWS_FOR_YOU_LIMIT, FOR_YOU_GROUPS) : RELEVANT_COUNT,
          `${label} For You initial page`)
      } else {
        assert.equal(r.cards, r.candidateDetected ? Math.min(NEWS_PAGE_SIZE, ALL_ENTRIES) : TOTAL_COUNT,
          `${label} All Updates initial page`)
      }
    }
    if (r.locale === 'zh-CN') {
      // A) zh renders translated chrome while IDs stay ASCII
      assert.match(r.text, /模型动态/, `${label} zh title`)
      assert.match(r.text, /为你推荐/, `${label} zh For You label`)
    }
    if (r.fixture === 'empty') {
      assert.match(r.text, /Catalogues unchanged since the last check/i, `${label} empty state message`)
      assert.equal(r.cards, 0, label)
    }
    if (r.fixture === 'partial') {
      assert.match(r.text, /Local catalogue news is shown/i, `${label} live-updates-off note`)
      assert.equal(r.cards, r.candidateDetected
        ? (r.scope === 'foryou'
          ? Math.min(NEWS_FOR_YOU_LIMIT, PARTIAL_FOR_YOU_GROUPS)
          : Math.min(NEWS_PAGE_SIZE, PARTIAL_ENTRIES))
        : PARTIAL_RELEVANT, label)
    }
    if (r.fixture === 'stale') {
      assert.match(r.text, /central feed unavailable/, `${label} central stale alert`)
      assert.equal(r.cards, r.candidateDetected ? Math.min(NEWS_FOR_YOU_LIMIT, FOR_YOU_GROUPS) : RELEVANT_COUNT,
        `${label} stale cache still serves the relevant items`)
    }
    if (r.fixture === 'nosignals') {
      if (r.scope === 'foryou') {
        assert.match(r.text, /Nothing to personalise yet/i, `${label} no-signals empty state`)
        assert.equal(r.cards, 0, label)
      } else {
        assert.equal(r.cards, r.candidateDetected ? Math.min(NEWS_PAGE_SIZE, ALL_ENTRIES) : TOTAL_COUNT,
          `${label} All initial page without signals`)
      }
    }
    if (r.fixture === 'error') {
      assert.match(r.text, /Model news is unavailable for this connection\./i, `${label} error state message`)
      assert.equal(r.cards, 0, label)
    }
  }

  // Screenshot mode: only when NEWS_LAYOUT_SHOTS points outside the repo.
  const shots = process.env.NEWS_LAYOUT_SHOTS
  if (shots) {
    const resolved = shotsOutsideRepo(shots)
    mkdirSync(resolved, { recursive: true })
    for (const r of results) {
      const name = `news-${r.fixture}-${r.scope}-${r.w}-${r.theme}-${r.locale}.png`
      const target = join(resolved, name)
      for (let attempt = 0; attempt < 3 && !existsSync(target); attempt += 1) {
        try {
          execFileSync(CHROME, [
            '--headless', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
            '--virtual-time-budget=6000', `--window-size=${r.w},${Math.max(r.height + 40, 120)}`,
            `--screenshot=${target}`, `${h.url}?case=${r.id}`,
          ], { timeout: 120000, stdio: 'ignore' })
        } catch (error) {
          // The teardown watchdog can fire after the PNG was written; only
          // retry when no usable file appeared.
          if (existsSync(target)) break
          if (attempt === 2) throw error
        }
      }
    }
  }
})

test('NEWS_LAYOUT_SHOTS containment rejects paths that resolve inside the repository', () => {
  // Absolute paths inside the repo, the repo root itself and an inside entry
  // whose name merely starts with ".." must all be rejected.
  assert.throws(() => shotsOutsideRepo(join(ROOT, 'test', 'shots')), /must not point inside/)
  assert.throws(() => shotsOutsideRepo(ROOT), /must not point inside/)
  assert.throws(() => shotsOutsideRepo(join(ROOT, '..weird-inside')), /must not point inside/)
  // Repo-relative strings resolve against the process cwd: from the repo root
  // they land inside and must be rejected — the raw string never starts with
  // the absolute repo root, so a plain startsWith check accepts them.
  const cwd = process.cwd()
  process.chdir(ROOT)
  try {
    assert.throws(() => shotsOutsideRepo('test/fixtures/news'), /must not point inside/)
    assert.throws(() => shotsOutsideRepo('test/../test/shots'), /must not point inside/)
    // Traversal that escapes and re-enters the repo must be rejected too.
    assert.throws(() => shotsOutsideRepo(`../${basename(ROOT)}/nested/shots`), /must not point inside/)
  } finally {
    process.chdir(cwd)
  }
})

test('NEWS_LAYOUT_SHOTS containment accepts directories outside the repository', () => {
  // Plain absolute directory outside the repo.
  shotsOutsideRepo(join(tmpdir(), 'wp11-shots-outside'))
  // A safe sibling directory: relative(ROOT, sibling) starts with "..", so it
  // is outside even when its name shares the repo root's prefix — a plain
  // startsWith(ROOT) check would falsely reject the prefix sibling.
  shotsOutsideRepo(`${ROOT}-sibling-shots`)
  shotsOutsideRepo(join(ROOT, '..', 'wp11-review-sibling-shots'))
  shotsOutsideRepo(join(ROOT, '..', 'elsewhere-shots'))
  // A repo-relative string that resolves outside the repo is fine.
  const cwd = process.cwd()
  process.chdir(ROOT)
  try {
    shotsOutsideRepo('..')
  } finally {
    process.chdir(cwd)
  }
})

test('Model News candidate-design assertions (real NewsPage DOM hooks; WP11_REQUIRE_CANDIDATE=1 or WP11_CANDIDATE=1 makes them mandatory)', {
  skip: CHROME || MANDATORY ? false : 'No Chromium binary available for real Model News layout checks',
}, async t => {
  if (!CHROME) {
    assert.fail('No Chromium binary available for real Model News layout checks, but '
      + 'WP11_REQUIRE_CANDIDATE=1 or WP11_CANDIDATE=1 makes the candidate verification '
      + 'mandatory: FAILING, never skipping.')
  }
  const h = await harness()
  const detected = h.results.some(r => r.candidateDetected)
  if (!detected) {
    const message = 'Candidate design not detected: no [data-news-group] in the rendered DOM. '
      + (MANDATORY
        ? 'WP11_REQUIRE_CANDIDATE=1 or WP11_CANDIDATE=1 is set, so the candidate DOM hooks are '
          + 'mandatory and this is a FAILURE, never a skip.'
        : 'Neither mandatory flag is set; baseline may skip until the candidate UI publishes its hooks.')
    if (MANDATORY) assert.fail(message)
    t.skip(message)
    return
  }
  const all = await runProbe(h, 'realistic__all__1200__dark__en')
  if (all.probe.skipped) {
    const message = `Candidate DOM hooks absent in the probed page (${all.id}).`
    if (MANDATORY) assert.fail(message)
    t.skip(message)
    return
  }
  const forYou = await runProbe(h, 'realistic__foryou__1200__dark__en')
  const noSignals = await runProbe(h, 'nosignals__foryou__1200__dark__en')
  const probe = all.probe

  // B) initial All pagination semantics: the first NEWS_PAGE_SIZE entries
  // render with a load-more control; the expanded snapshot below carries
  // the complete list.
  assert.equal(probe.initial.cards, Math.min(NEWS_PAGE_SIZE, ALL_ENTRIES),
    `All starts paginated with ${Math.min(NEWS_PAGE_SIZE, ALL_ENTRIES)} entries (got ${probe.initial.cards})`)
  assert.equal(probe.initial.loadMorePresent, true, 'load-more is offered on the initial All page')
  assert.ok(probe.expanded.groups.length >= probe.initial.groups.length,
    `load-more expands the group list (${probe.initial.groups.length} → ${probe.expanded.groups.length})`)

  // B) model-first groups over the EXPANDED list: one group per exact model ID
  const groupIds = probe.groups.map(group => group.id)
  for (const id of ['gpt-5.6-sol', 'gpt-5.6-sol-pro', 'claude-sonnet-4-5',
    'claude-sonnet-4-5-20250929', 'claude-opus-4-1-20250805-thinking',
    'openrouter/anthropic/claude-sonnet-4.5', 'deepseek-ai/deepseek-v4-pro']) {
    assert.ok(groupIds.includes(id), `one group per exact model ID: ${id} (groups: ${groupIds.join(', ')})`)
  }
  // friendly sourced model_name is primary with the exact ID immediately
  // below; without a supplied name the exact ID stands alone — names are
  // never synthesized from IDs.
  for (const group of probe.groups) {
    if (group.name) {
      assert.equal(group.exactIdBelowName, true,
        `group ${group.id}: exact ID sits directly below the friendly name`)
    } else {
      assert.equal(group.idText, group.id,
        `group ${group.id}: without a friendly name the exact ID stands alone`)
    }
  }
  const solPro = probe.groups.find(group => group.id === 'gpt-5.6-sol-pro')
  assert.equal(solPro?.name, 'GPT-5.6 Sol Pro',
    'the fixture model_name renders as the friendly group heading')
  // per-field % chips with no repeated direction word inside each chip
  assert.deepEqual(probe.chipDirectionIssues, [],
    `chips carry one direction each: ${JSON.stringify(probe.chipDirectionIssues)}`)
  // impact line says hypothetical / API-equivalent
  assert.ok(probe.impactWording, 'impact line states the estimate is hypothetical/API-equivalent')
  // a provider row per offer: gpt-5.6-sol exists on three providers
  const solGroup = probe.groups.find(group => group.id === 'gpt-5.6-sol')
  assert.ok(solGroup && solGroup.offers.length >= 3,
    `gpt-5.6-sol group lists a row per provider offer (${solGroup?.offers.length})`)
  // All Updates is complete after load-more: every original model-item id
  // reachable in Details over the fully expanded list (the static first page
  // cannot carry them all; cards without a model are content-annotated).
  const reachable = new Set([...probe.idReach.itemIds, ...probe.idReach.events])
  const modelItemIds = NEWS_ITEMS.filter(item => item.model).map(item => item.id)
  assert.deepEqual(modelItemIds.filter(id => !reachable.has(id)), [],
    `every original id reachable after load-more: missing ${JSON.stringify(modelItemIds.filter(id => !reachable.has(id)))}`)
  // presence over the fully expanded list: every model, provider and source
  // URL of the whole payload is on the page once pagination is exhausted
  assert.deepEqual(probe.presence.missingModel, [],
    `every model present after load-more: ${JSON.stringify(probe.presence.missingModel)}`)
  assert.deepEqual(probe.presence.missingProvider, [],
    `every provider present after load-more: ${JSON.stringify(probe.presence.missingProvider)}`)
  assert.deepEqual(probe.presence.missingSource, [],
    `every source URL linked after load-more: ${JSON.stringify(probe.presence.missingSource)}`)

  // --- dedupe proof --------------------------------------------------------
  // Shared precondition for every pair below: identical transition (exact
  // provider/model/category, previous/current signatures, known tier rows
  // when declared). Merging then needs an explicit same-event proof and is
  // strictly local↔central 1:1 — never within one origin, never by nearby
  // time. Merge semantics are read PER EVENT from the dedicated evidence
  // blocks: an event is merged exactly when its evidence rows hold 2+ ids
  // with both origins; an unmerged event lists exactly its own record.
  // `itemIds` stays a reachability/locating aid only (history evidence rows
  // now legitimately expose each event's own id).
  const offerEvents = offer => [...offer.itemIds, ...offer.eventIds]
  const findOfferWith = id =>
    probe.groups.flatMap(group => group.offers).find(offer => offerEvents(offer).includes(id))
  // proven pair (same nonempty effective_at + same nonempty source_url): merge
  const kimiOffer = findOfferWith(KIMI_LOCAL)
  assert.ok(kimiOffer, 'kimi proven pair: local twin reachable')
  assert.deepEqual([...kimiOffer.mergedIds].sort(), [KIMI_LOCAL, KIMI_CENTRAL].sort(),
    `kimi merged event keeps both original ids as evidence (${JSON.stringify(kimiOffer.mergedIds)})`)
  assert.ok(kimiOffer.mergedOrigins.includes('local') && kimiOffer.mergedOrigins.includes('central'),
    `kimi merged event keeps both origin evidences (${JSON.stringify(kimiOffer.mergedOrigins)})`)
  // variant (equal nonempty observed_at, effective both empty, one URL
  // missing — an absent URL never conflicts): merge
  const deepseekOffer = findOfferWith(DEEPSEEK_LOCAL)
  assert.ok(deepseekOffer, 'deepseek variant pair: local twin reachable')
  assert.deepEqual([...deepseekOffer.mergedIds].sort(), [DEEPSEEK_LOCAL, DEEPSEEK_CENTRAL].sort(),
    `deepseek observed/equal pair merges: both original ids retained (${JSON.stringify(deepseekOffer.mergedIds)})`)
  assert.ok(deepseekOffer.mergedOrigins.includes('local') && deepseekOffer.mergedOrigins.includes('central'),
    `deepseek merged event keeps both origin evidences (${JSON.stringify(deepseekOffer.mergedOrigins)})`)
  // both URLs nonempty and different → distinct events; each event's
  // evidence rows equal exactly its own record, and the conflicting twin
  // appears as a separate event
  const geminiOffer = findOfferWith(GEMINI_CUT_A)
  assert.ok(geminiOffer, 'gemini conflict control: local event reachable')
  assert.ok(geminiOffer.eventIds.includes(GEMINI_CUT_A) || geminiOffer.eventIds.includes(GEMINI_CUT_B),
    'conflicting source URLs keep the near-duplicates as two events')
  assert.deepEqual(geminiOffer.mergedIds, [],
    'the conflicting pair renders NO merged evidence block')
  assert.equal(geminiOffer.historyEvidence.length, 1,
    'the conflicting pair stays two events (latest + history)')
  const geminiHistory = geminiOffer.historyEvidence[0]
  const geminiLatestId = geminiHistory.id === GEMINI_CUT_A ? GEMINI_CUT_B : GEMINI_CUT_A
  assert.deepEqual(geminiHistory.evidenceIds, [geminiHistory.id],
    `the history event lists exactly its own record (${JSON.stringify(geminiHistory.evidenceIds)})`)
  assert.deepEqual(geminiOffer.singleEvidenceIds, [geminiLatestId],
    `the unmerged latest event lists exactly its own record (${JSON.stringify(geminiOffer.singleEvidenceIds)})`)
  assert.deepEqual([geminiHistory.id, geminiLatestId].sort(), [GEMINI_CUT_A, GEMINI_CUT_B].sort(),
    'both original ids stay reachable as two distinct events')
  // conflicting nonempty effective dates → distinct; both twins are central,
  // so this is also the same-origin control (same-origin different-id items
  // never merge) and there is no temporal-proximity heuristic to exploit.
  const mistralOffer = findOfferWith(MISTRAL_REPEAT)
  assert.ok(mistralOffer, 'mistral conflict/same-origin control: newest event reachable')
  assert.ok(mistralOffer.eventIds.includes(MISTRAL_FIRST),
    'conflicting effective dates keep the repeated transition as two events')
  assert.deepEqual(mistralOffer.mergedIds, [],
    'the repeated transition renders NO merged evidence block')
  assert.equal(mistralOffer.historyEvidence.length, 1,
    'the repeated transition stays two events (latest + history)')
  const mistralHistory = mistralOffer.historyEvidence[0]
  assert.equal(mistralHistory.id, MISTRAL_FIRST, 'the older repeated transition is the history event')
  assert.deepEqual(mistralHistory.evidenceIds, [mistralHistory.id],
    `the history event lists exactly its own record (${JSON.stringify(mistralHistory.evidenceIds)})`)
  assert.deepEqual(mistralOffer.singleEvidenceIds, [MISTRAL_REPEAT],
    `the unmerged latest event lists exactly its own record (${JSON.stringify(mistralOffer.singleEvidenceIds)})`)
  // cross-origin merging is 1:1: counted PER EVENT, exactly the two proven
  // pairs merged (a merged event may sit on the latest or in History)
  const mergedEvents = probe.groups.flatMap(group => group.offers)
    .flatMap(offer => [
      { ids: offer.mergedIds.length ? offer.mergedIds : offer.singleEvidenceIds,
        origins: offer.mergedOrigins },
      ...offer.historyEvidence.map(event => ({
        ids: event.evidenceIds, origins: event.evidenceOrigins })),
    ])
    .filter(event => event.ids.length >= 2
      && event.origins.includes('local') && event.origins.includes('central'))
  assert.equal(mergedEvents.length, 2,
    `exactly the two proven pairs merged across origins, per event (${mergedEvents.length})`)

  // --- case-only identity + recency ---------------------------------------
  // The backend's fuzzy used_model reason (usage "M1" vs item "m1") stays
  // neutral: only "Related update" wording and no numeric personal estimate.
  // The exact control x2 with a valid in-window last_used_at earns "Used
  // recently" and a priced impact. Valid-but-old earns the truthful "Used
  // before"; malformed, future and empty stamps earn neither.
  const offerOf = (groupId, provider) =>
    probe.groups.find(group => group.id === groupId)?.offers.find(offer => offer.provider === provider)
  const m1Offer = offerOf('m1', 'fixturelabs')
  assert.ok(m1Offer, 'm1 (case-only identity) offer found')
  assert.match(m1Offer.reasons, /Related update/i,
    `m1 keeps the neutral used_model wording (${m1Offer.reasons})`)
  assert.doesNotMatch(m1Offer.reasons, /Used recently|Used before/i,
    `m1 never claims recency from the fuzzy match (${m1Offer.reasons})`)
  assert.ok(m1Offer.impact === null || m1Offer.impact === 'unavailable',
    `m1 carries no priced impact (basis ${m1Offer.impact})`)
  assert.ok(!/[≈$]/.test(m1Offer.impactText || ''),
    `m1 impact text stays non-numeric: ${m1Offer.impactText}`)
  const x2Offer = offerOf('x2', 'fixturelabs')
  assert.ok(x2Offer, 'x2 (exact-match control) offer found')
  assert.match(x2Offer.reasons, /Used recently/i,
    `a valid in-window last_used_at earns the recency label (${x2Offer.reasons})`)
  assert.equal(x2Offer.impact, 'full', 'the exact-control usage prices a full impact')
  assert.match(x2Offer.impactText, /≈/, `the exact-control impact is numeric (${x2Offer.impactText})`)
  const reasonsOf = id => findOfferWith(id)?.reasons || ''
  const oldReasons = reasonsOf(TS_OLD)
  assert.match(oldReasons, /Used before/i,
    `a valid ~101-day-old last_used_at earns "Used before" (${oldReasons})`)
  assert.doesNotMatch(oldReasons, /Used recently/i,
    'a ~101-day-old last_used_at never earns "Used recently"')
  for (const [id, kind] of [[TS_MALFORMED, 'malformed'], [TS_FUTURE, 'future'], [TS_EMPTY, 'empty']]) {
    const reasons = reasonsOf(id)
    assert.doesNotMatch(reasons, /Used recently|Used before/i,
      `a ${kind} last_used_at earns no recency wording (${reasons})`)
    const offer = findOfferWith(id)
    assert.ok(offer.impact === null || offer.impact === 'unavailable',
      `${kind} timestamp item carries no numeric impact (basis ${offer.impact})`)
    assert.ok(!/[≈$]/.test(offer.impactText || ''),
      `${kind} timestamp item impact stays non-numeric: ${offer.impactText}`)
  }

  // --- tiers and official note --------------------------------------------
  // Root tiers_detail 'known' renders one comparable tier chip and lists
  // every row in Details; the official source note is plain text, never a
  // link; the exact 30-day recency window is exercised above via x2/TS_OLD.
  const opusGroup = probe.groups.find(group => group.id === 'anthropic/claude-opus-4.1')
  const opusTierChip = opusGroup?.offers.flatMap(offer => offer.chips)
    .find(chip => chip.field === 'tiers')
  assert.ok(opusTierChip, 'known tiers render a tier chip')
  assert.equal(opusTierChip.dir, 'up', `tier chip direction (${opusTierChip.text})`)
  assert.match(opusTierChip.text, /\+20%/, `tier chip magnitude (${opusTierChip.text})`)
  assert.match(probe.expandedText, /standard/, 'tier rows are listed one by one in Details')
  assert.ok(probe.officialNote, 'the official verification block renders its source note')
  assert.equal(probe.officialNote.linked, false,
    `the official source note is plain text, never a link (${probe.officialNote?.text})`)

  // --- evidence retention regressions (page-local payload) -----------------
  // 1) Same-ID local+central records dedupe to ONE event, but both records
  //    stay recoverable in Details: each record's source URL, full observed
  //    timestamp, effective date and provenance.
  // 2) A proven distinct-ID pair collapses into one event that becomes
  //    HISTORY once a newer update lands in the same offer: the historical
  //    event keeps every original id, both origin evidences, full stamps,
  //    provenance, its exact previous/current four rates and its raw tier
  //    type/size recoverable (text or attributes; display format is not
  //    constrained beyond recoverability).
  const evidence = await runProbe(h, 'evidence__all__1200__dark__en')
  assert.ok(!evidence.probe?.skipped, 'evidence probe ran against the candidate DOM')
  const evOfferOf = model => evidence.probe.evidence?.find(offer => offer.model === model)
  assert.ok(evOfferOf('ev-model') && evOfferOf('hist-model'),
    `evidence variant offers rendered (${JSON.stringify(evidence.probe.evidence?.map(o => o.model))})`)

  const shared = evOfferOf('ev-model')
  assert.equal(shared.eventCount, 1,
    `same-ID local+central records dedupe to exactly one event (${shared.eventCount})`)
  const SHARED_TOKENS = [
    'evidence-shared-event-1',
    'https://announcements.spend-sense.example/feed/ev-shared-local',
    'https://announcements.spend-sense.example/feed/ev-shared-central',
    '2026-11-09T08:00:00Z', '2026-11-10T10:00:00Z',
    '2026-11-08', '2026-11-09',
    'Synthetic local diff (evidence variant)', 'Synthetic central feed (evidence variant)',
  ]
  for (const token of SHARED_TOKENS) {
    assert.ok(shared.panelHtml.includes(token),
      `same-ID variant keeps both records recoverable in Details: ${token}`)
  }

  const hist = evOfferOf('hist-model')
  assert.equal(hist.eventCount, 2,
    `the proven pair collapsed into one event beside the newer update (${hist.eventCount})`)
  assert.equal(hist.historyEvents.length, 1, 'the collapsed pair sits in History')
  const histLi = hist.historyEvents[0]
  assert.equal(histLi.id, EVIDENCE_HIST_LOCAL_ID,
    'the historical event element carries its merged original id')
  assert.ok(histLi.sourceTags.includes('local') && histLi.sourceTags.includes('central'),
    `the historical event keeps both origin evidences (${JSON.stringify(histLi.sourceTags)})`)
  const HIST_LI_TOKENS = [
    EVIDENCE_HIST_CENTRAL_ID,
    // The settled proof: same NONEMPTY source_url AND same NONEMPTY
    // effective_at (no invented link field) — one shared URL for the pair.
    'https://announcements.spend-sense.example/feed/hist-pair',
    '2026-11-08T11:00:00Z', '2026-11-08T09:30:00Z',
    '2026-11-07',
    'Synthetic local diff (history variant)', 'Synthetic central feed (history variant)',
    // Historical-only values: the previous four rates and the tier row
    // identity exist nowhere else in the offer, so their presence in the
    // historical event's own element proves per-event evidence retention.
    '$2.04', '$8.16', '$0.204', '$2.56',
    'standard',
  ]
  for (const token of HIST_LI_TOKENS) {
    assert.ok(histLi.html.includes(token),
      `historical event keeps its evidence recoverable: ${token}`)
  }
  // Exact historical previous/current four rates and raw tier identity —
  // recoverable somewhere in the Details panel (the rendered forms are the
  // UI's own; only recoverability is asserted).
  const HIST_PANEL_TOKENS = [
    ...HIST_LI_TOKENS,
    '$2.55', '$10.2', '$0.255', '$3.2',
  ]
  for (const token of HIST_PANEL_TOKENS) {
    assert.ok(hist.panelHtml.includes(token),
      `history variant Details panel keeps evidence recoverable: ${token}`)
  }
  assert.ok(hist.panelHtml.includes('250000') || hist.panelHtml.includes('250.0k'),
    'the historical tier size is recoverable (raw or formatted)')

  // search is a full-ID substring match
  assert.deepEqual([...probe.search.after].sort(), ['gpt-5.6-sol', 'gpt-5.6-sol-pro'].sort(),
    `"sol" matches the sol groups: ${JSON.stringify(probe.search)}`)
  // date filter works: the item observed ~36 days ago drops from the 30-day
  // window and comes back under All time
  assert.ok(probe.dateFilter.before.includes('ts-old90day'),
    `date filter precondition: the old item is listed (${JSON.stringify(probe.dateFilter.before)})`)
  assert.ok(!probe.dateFilter.after.includes('ts-old90day'),
    `the 30-day window drops the ~36-day-old item: ${JSON.stringify(probe.dateFilter.after)}`)
  assert.ok(probe.dateFilter.restored.includes('ts-old90day'),
    `All time restores the dropped item: ${JSON.stringify(probe.dateFilter.restored)}`)
  // load-more keeps focus inside the list (only assertable when present)
  if (probe.loadMore.present) {
    t.diagnostic(`Load-more focus after activation: ${JSON.stringify(probe.loadMore)}`)
    assert.equal(probe.loadMore.focusInsideList, true, 'load-more keeps focus inside the list')
  }
  // persistent selected ring on scope AND category, surviving switches
  assert.equal(probe.ring.endScope, 'all',
    `the ring interaction must end back on All (got ${JSON.stringify(probe.ring)})`)
  assert.equal(probe.ring.survives, true, `category ring survives scope switches: ${JSON.stringify(probe.ring)}`)
  assert.equal(probe.ring.scopeRing?.pressed, 'true', 'scope carries its own selected ring')
  assert.ok(Number.parseFloat(probe.ring.scopeRing?.outline?.width || '0') > 0
    && probe.ring.scopeRing.outline.style !== 'none', 'scope ring is visible')

  // For You shows the initial page of ranked groups, with show-all for the rest
  const forYouGroups = [...new Set(NEWS_ITEMS.filter(isRelevant).map(item => item.model).filter(Boolean))]
  assert.equal(forYou.probe.forYou.visible, Math.min(5, forYouGroups.length),
    `For You shows the initial page of groups (got ${forYou.probe.forYou.visible})`)
  assert.equal(forYou.probe.groups.length,
    forYou.probe.forYou.showAllPresent ? forYouGroups.length : Math.min(5, forYouGroups.length),
    `For You structure captures the post-show-all total (got ${forYou.probe.groups.length})`)
  if (forYouGroups.length > 5) {
    assert.equal(forYou.probe.forYou.showAllPresent, true, 'show-all is offered for the remaining groups')
    assert.equal(forYou.probe.forYou.afterShowAll, forYouGroups.length,
      `show-all reveals every relevant group (${forYou.probe.forYou.afterShowAll})`)
    // For You after show-all covers every relevant exact ID (the relevant
    // subset of EXACT_IDS; the rest are covered by the complete All list)
    for (const id of FOR_YOU_EXACT) {
      assert.ok(forYou.probe.forYou.afterShowAllGroups.includes(id),
        `For You after show-all covers exact ID ${id} (got ${JSON.stringify(forYou.probe.forYou.afterShowAllGroups)})`)
    }
  }
  // keyboard: tab order reaches scope, category, search, details, load-more
  const k = probe.keyboard
  for (const [name, index] of Object.entries(k)) {
    if (name === 'toggle') continue
    assert.ok(index >= 0, `keyboard reaches ${name} (focusables: ${JSON.stringify(probe.focusables.slice(0, 12))})`)
  }
  assert.ok(k.scopeIndex < k.categoryIndex && k.categoryIndex < k.searchIndex
    && k.searchIndex < k.detailsIndex, `tab order scope→category→search→details (got ${JSON.stringify(k)})`)
  assert.equal(k.toggle.keyboardOperable, true, 'details toggle is keyboard-operable')
  assert.equal(k.toggle.toggled, true, 'toggle activates')
  assert.equal(k.toggle.focusVisible, true, 'focus-visible outline present on the toggle')

  // no-signals variant: empty For You with a visible navigation path to All
  const empty = noSignals.probe.emptyForYou
  assert.equal(empty.present, true, 'no-signals For You shows its empty state')
  assert.equal(empty.hasPathToAll, true, 'empty For You offers a visible path to All Updates')
  assert.ok((empty.groupsAfterClick || 0) > 0, 'following the path shows the full list')
})

// The discovery mock's hide rule, shared by the generated stubs and the
// regression test below. The earlier /chrome/i rule missed /usr/bin/chromium
// and /usr/bin/chromium-browser: on a Chromium-only runtime the probe child
// resolved CHROME and would have launched a real browser instead of
// simulating absence. chrom(e|ium) covers every current and future
// chrome/chromium-named discovery candidate.
const CHROME_MOCK_HIDE = /chrom(e|ium)/i

test('the Chrome-discovery mock hides every discovery candidate', () => {
  for (const candidate of CHROME_CANDIDATES) {
    assert.match(candidate, CHROME_MOCK_HIDE,
      `${candidate} is hidden by the probe's discovery mock`)
  }
})

// Regression probe for the mandatory gate: re-runs THIS file in a child
// process with Chrome discovery mocked away (node:test module mocking; no
// real browser involved), so a missing Chromium can never silently skip a
// mandatory candidate run. The child sets WP11_LAYOUT_PROBE_CHILD so this
// probe skips itself there (no grandchild recursion).
test('a mandatory candidate run fails instead of skipping when Chrome is missing', {
  skip: process.env.WP11_LAYOUT_PROBE_CHILD ? 'probe child run' : false,
}, async t => {
  const work = mkdtempSync(join(tmpdir(), 'wm-news-probe-'))
  process.on('exit', () => rmSync(work, { recursive: true, force: true }))
  // namedExports (not exports): the older option key is deprecated on Node 24
  // but is the only one Node 22 honours, so one source works across both; no
  // `default` key — Node 24 rejects the mock when `default` is defined.
  // `hostRule` decides what the SIMULATED host filesystem contains beyond
  // the hidden discovery candidates.
  const writeDiscoveryStub = (name, hostRule) => {
    const stub = join(work, name)
    writeFileSync(stub, [
      "import { mock } from 'node:test'",
      "import fs from 'node:fs'",
      'const realExistsSync = fs.existsSync',
      `const simulatedHost = path => ${hostRule}`,
      "mock.module('node:fs', { namedExports: { ...fs,",
      `  existsSync: path => ${CHROME_MOCK_HIDE}.test(String(path)) ? false : simulatedHost(path),`,
      '  mkdirSync: fs.mkdirSync, mkdtempSync: fs.mkdtempSync,',
      '  readFileSync: fs.readFileSync, rmSync: fs.rmSync,',
      '  writeFileSync: fs.writeFileSync } })',
    ].join('\n'))
    return stub
  }
  const standardStub = writeDiscoveryStub('no-chrome.mjs', 'realExistsSync(path)')
  const self = fileURLToPath(import.meta.url)
  const probeChild = (flag, stub = standardStub) => {
    const env = { ...process.env, WP11_LAYOUT_PROBE_CHILD: '1' }
    delete env.WP11_REQUIRE_CANDIDATE
    delete env.WP11_CANDIDATE
    if (flag) env[flag] = '1'
    return spawnSync(process.execPath, [
      // Force the spec reporter: a piped child would otherwise fall back to
      // TAP on older Node lines and the named-state assertions below would
      // not see the ✖/﹣ markers.
      '--experimental-test-module-mocks', '--test-reporter=spec',
      '--test-reporter-destination=stdout',
      '--import', pathToFileURL(stub).href, self,
    ], { encoding: 'utf8', env })
  }
  for (const flag of ['WP11_REQUIRE_CANDIDATE', 'WP11_CANDIDATE', null]) {
    const child = probeChild(flag)
    const output = `${child.stdout}\n${child.stderr}`
    // Skip only when module mocking itself is unavailable in this Node; a
    // child killed by a signal or otherwise aborted is a FAILURE here, never
    // a silent skip.
    if (/mock\.module is not a function/.test(output)) {
      t.skip(`node:test module mocking unavailable in this Node: ${output.slice(0, 400)}`)
      return
    }
    assert.ok(typeof child.status === 'number',
      `${flag || 'optional run'}: probe child was killed by signal ${child.signal}: `
        + `${output.slice(0, 400)}`)
    const lines = child.stdout.split('\n')
    const stateLine = name => lines.find(line => line.includes(name))
    const baseline = stateLine('Model News baseline invariants')
    const candidate = stateLine('Model News candidate-design assertions')
    const guard = stateLine('a mandatory candidate run fails instead of skipping')
    if (flag) {
      assert.notEqual(child.status, 0, `${flag}=1: a mandatory run without Chrome must FAIL`)
      assert.ok(baseline?.startsWith('✖') && candidate?.startsWith('✖'),
        `${flag}=1: both named browser tests must FAIL `
          + `(baseline: ${baseline}; candidate: ${candidate})`)
      assert.match(output, /never skipp/i,
        `${flag}=1: the failure must state it is mandatory, never a skip`)
    } else {
      assert.equal(child.status, 0,
        'without a mandatory flag a missing Chrome keeps the optional skip')
      assert.ok(baseline?.startsWith('﹣') && candidate?.startsWith('﹣'),
        `optional run: both named browser tests must SKIP, unchanged `
          + `(baseline: ${baseline}; candidate: ${candidate})`)
    }
    // The self-guard must be transparent in every child: the probe skips
    // itself there (no grandchild recursion), visibly in the child's output.
    assert.ok(guard?.startsWith('﹣') && guard.includes('probe child run'),
      `probe guard skips itself transparently in the child (got ${guard})`)
  }
  // Chromium-only host simulation: the ONLY existing discovery candidates
  // are the two chromium binaries. The mock must hide them too, so a
  // mandatory run fails through the gate — never a real browser invocation —
  // and the default run keeps its optional skip.
  const chromiumOnlyStub = writeDiscoveryStub('chromium-only-host.mjs',
    "['/usr/bin/chromium', '/usr/bin/chromium-browser'].includes(String(path))")
  const mandatory = probeChild('WP11_REQUIRE_CANDIDATE', chromiumOnlyStub)
  assert.notEqual(mandatory.status, 0,
    'a Chromium-only host must FAIL a mandatory run, never launch a browser')
  const mandatoryLines = mandatory.stdout.split('\n')
  const mandatoryBaseline =
    mandatoryLines.find(line => line.includes('Model News baseline invariants'))
  const mandatoryCandidate =
    mandatoryLines.find(line => line.includes('Model News candidate-design assertions'))
  assert.ok(mandatoryBaseline?.startsWith('✖') && mandatoryCandidate?.startsWith('✖'),
    `chromium-only mandatory run: both named browser tests FAIL via the gate `
      + `(baseline: ${mandatoryBaseline}; candidate: ${mandatoryCandidate})`)
  assert.match(`${mandatory.stdout}\n${mandatory.stderr}`, /FAILING, never skipping/,
    'chromium-only mandatory run reports the mandatory gate, never a browser attempt')
  const optional = probeChild(null, chromiumOnlyStub)
  assert.equal(optional.status, 0,
    'a Chromium-only host keeps the optional skip by default')
  const optionalLines = optional.stdout.split('\n')
  const optionalBaseline =
    optionalLines.find(line => line.includes('Model News baseline invariants'))
  const optionalCandidate =
    optionalLines.find(line => line.includes('Model News candidate-design assertions'))
  assert.ok(optionalBaseline?.startsWith('﹣') && optionalCandidate?.startsWith('﹣'),
    `chromium-only default run: both named browser tests SKIP `
      + `(baseline: ${optionalBaseline}; candidate: ${optionalCandidate})`)
})
