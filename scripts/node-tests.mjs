import { spawn } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Explicit selection and per-file completion budgets. The third value opts
// into force-exit only for React/jsdom harnesses with lingering handles.
const suites = {
  browserless: [
    ['analytics', 49], ['budgets', 30, true], ['cache-savings', 36],
    ['compatibility', 16], ['dashboard-entry', 1], ['digest', 2],
    ['digest-render', 24, true], ['economics', 28], ['economics-render', 52, true],
    ['membership', 38], ['membership-scope', 99, true], ['memberships-reading', 6, true],
    ['news', 24],
    ['news-editorial', 46], ['news-groups', 52], ['news-layout.chromium', 16],
    ['news-layout.harness', 4],
    ['news-render', 60, true], ['node-runner', 5], ['plugin', 67], ['recount', 16],
    ['overview-render', 4, true],
    ['reports-layout.chromium', 19], ['reports-layout.devtools', 11],
    ['sidebar', 45, true], ['ui-labels', 50],
    ['usage-render', 8, true],
    ['ux-primitives', 32, true], ['weather', 11], ['weather-render', 9, true],
    ['wp14-fixes', 9],
  ],
  browser: [
    ['budgets-layout', 1], ['costs-layout', 1], ['memberships-cards', 1],
    ['memberships-clarity', 1], ['memberships-disclosure', 1],
    ['memberships-layout', 1], ['memberships-polish', 1], ['memberships-visibility', 1],
    ['news-layout', 7], ['overview-layout', 1], ['reports-layout', 1],
    ['settings-layout', 1], ['sidebar-layout', 1], ['tooltip-layout', 1], ['usage-layout', 1],
  ],
}

const root = fileURLToPath(new URL('../', import.meta.url))
const fileName = name => `${name}.test.mjs`

export function checkResult({ error, status, signal, stdout }, expected) {
  if (error || status !== 0 || signal) {
    throw new Error(error?.message || (signal ? `signal ${signal}` : `exit ${status}`))
  }
  const summary = key => [...stdout.matchAll(new RegExp(`^# ${key} (\\d+)\\r?$`, 'gm'))]
  const countIs = (key, n) => {
    const matches = summary(key)
    return matches.length === 1 && Number(matches[0][1]) === n
  }
  // Also check the TAP records: a green summary is insufficient if output
  // was truncated, and skipped/todo cases do not satisfy the pass budget.
  const reported = [...stdout.matchAll(/^ok \d+ - /gm)].length
  if (reported !== expected || !countIs('tests', expected) || !countIs('pass', expected)
      || !['fail', 'cancelled', 'skipped', 'todo'].every(key => countIs(key, 0))) {
    const totals = stdout.match(/^# (?:tests|pass|fail|cancelled|skipped|todo) \d+/gm) || []
    throw new Error(`expected ${expected} passes with a complete summary; got ${reported} TAP records (${totals.join(', ') || 'no summary'})`)
  }
}

async function main([action, mode, selected, ...args]) {
  if (!process.env.SPENDSENSE_TEST_REGISTRY) throw new Error('Use bash scripts/node-tests.sh or scripts/managed-tests.py')
  if (!Object.hasOwn(suites, mode) || args.length || !['--plan', '--run'].includes(action)) {
    throw new Error('invalid managed Node test request')
  }
  // The isolation flag arrived in 22.8; the locked jsdom requires 22.13 on Node 22.
  const [major, minor] = process.versions.node.split('.').map(Number)
  if (!(major === 22 && minor >= 13) && major < 24) {
    throw new Error(`Node.js 22.13+ on the 22.x line, or 24+, is required (found ${process.version})`)
  }
  const isolationFlag = process.allowedNodeEnvironmentFlags.has('--test-isolation')
    ? '--test-isolation=none' : '--experimental-test-isolation=none'
  const declared = Object.values(suites).flat().map(([name]) => fileName(name)).sort()
  // Discovery is a consistency check, not a selection mechanism.
  const actual = readdirSync(new URL('../test/', import.meta.url)).filter(name => name.endsWith('.test.mjs')).sort()
  if (declared.join('\n') !== actual.join('\n')) {
    throw new Error(`Node test inventory mismatch: unlisted ${actual.filter(f => !declared.includes(f))}; missing ${declared.filter(f => !actual.includes(f))}`)
  }
  if (mode === 'browser' && ![
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  ].some(existsSync)) throw new Error('Chrome/Chromium is required for the browser suite')

  const entries = suites[mode].filter(([name]) => !selected || fileName(name) === selected)
  if (!entries.length) throw new Error(`${selected} is not declared in the ${mode} inventory`)
  if (action === '--plan') {
    console.log(JSON.stringify(entries.map(([name]) => fileName(name))))
    return
  }
  if (!selected) throw new Error('managed execution requires one declared file')
  const [[name, expected, forceExit]] = entries
  const child = spawn(process.execPath, [
    '--test', isolationFlag, ...(forceExit ? ['--test-force-exit'] : []),
    '--test-reporter=tap', `test/${fileName(name)}`,
  ], { cwd: root, stdio: ['ignore', 'pipe', 'inherit'] })
  // Keep TAP complete for the existing checker. The outer supervisor closes
  // the owned group if the publisher or any pipe holder fails to exit.
  const chunks = []
  let size = 0
  const result = await new Promise((resolve, reject) => {
    child.stdout.on('data', chunk => {
      size += chunk.length
      if (size > 16 * 1024 * 1024) {
        child.stdout.destroy()
        reject(new Error('TAP output exceeded 16 MiB'))
      } else {
        chunks.push(chunk)
      }
    })
    child.once('error', reject)
    child.once('close', (status, signal) => resolve({ status, signal }))
  }).catch(error => {
    console.error(`${selected}: ${error.message}`)
    process.exit(1)
  })
  const stdout = Buffer.concat(chunks).toString('utf8')
  try {
    checkResult({ ...result, stdout }, expected)
  } catch (error) {
    console.error(stdout.slice(-12000))
    throw new Error(`${selected}: ${error.message}`)
  }
  console.log(`${selected}: ${expected}/${expected}`)
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main(process.argv.slice(2)).catch(error => {
    console.error(error.message)
    process.exitCode = 1
  })
}
