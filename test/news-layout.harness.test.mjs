import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { CHROME_CANDIDATES, shotsOutsideRepo } from './news-layout.harness.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')

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

const CHROME_MOCK_HIDE = /chrom(e|ium)/i

test('the Chrome-discovery mock hides every discovery candidate', () => {
  for (const candidate of CHROME_CANDIDATES) {
    assert.match(candidate, CHROME_MOCK_HIDE,
      `${candidate} is hidden by the probe's discovery mock`)
  }
})

// Load only the browser test file, with every Chrome discovery path hidden.
test('a mandatory candidate run fails instead of skipping when Chrome is missing', {
  timeout: 90000,
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
  const suite = fileURLToPath(new URL('./news-layout.test.mjs', import.meta.url))
  const probeChild = (flag, stub = standardStub) => {
    const env = { ...process.env }
    // A real node --test parent injects runner protocol state; a standalone
    // spec-reporter child must not inherit that state (or its V8 event stream).
    for (const key of Object.keys(env)) {
      if (key.startsWith('NODE_TEST_')) delete env[key]
    }
    delete env.WP11_REQUIRE_CANDIDATE
    delete env.WP11_CANDIDATE
    if (flag) env[flag] = '1'
    const child = spawnSync(process.execPath, [
      // Force the spec reporter: a piped child would otherwise fall back to
      // TAP on older Node lines and the named-state assertions below would
      // not see the ✖/﹣ markers.
      '--experimental-test-module-mocks', '--test-reporter=spec',
      '--test-reporter-destination=stdout',
      '--import', pathToFileURL(stub).href, suite,
    ], { encoding: 'utf8', env, timeout: 30000, killSignal: 'SIGKILL' })
    assert.ok(!child.error && !child.signal && typeof child.status === 'number',
      `${flag || 'optional run'}: probe child failed to complete: `
        + `error=${child.error?.message || 'none'}, signal=${child.signal}, status=${child.status}; `
        + `${`${child.stdout || ''}\n${child.stderr || ''}`.slice(0, 400)}`)
    return child
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
