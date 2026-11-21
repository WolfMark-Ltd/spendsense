import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { checkResult } from '../scripts/node-tests.mjs'

function run(source) {
  // A nested Node process must not inherit the test worker's binary protocol.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('NODE_TEST_')))
  return spawnSync(process.execPath, [
    '--test-reporter=tap', '--input-type=module', '-e',
    `import { test } from 'node:test'; ${source}`,
  ], { encoding: 'utf8', env, timeout: 5000 })
}

test('a complete Node run meets its declared count', () => {
  assert.doesNotThrow(() => checkResult(run("test('complete', () => {})"), 1))
})

test('a green exit with a missing test fails the completion check', () => {
  const result = run("test('only one ran', () => {})")
  assert.equal(result.status, 0)
  assert.throws(() => checkResult(result, 2), /expected 2 passes/)
})

test('a green exit without a completion summary is rejected', () => {
  const result = run('process.exit(0)')
  assert.equal(result.status, 0)
  assert.throws(() => checkResult(result, 1), /expected 1 passes/)
})

test('a skipped test does not count as a pass', () => {
  const result = run("test('missing Chromium', { skip: true }, () => {})")
  assert.equal(result.status, 0)
  assert.throws(() => checkResult(result, 1), /expected 1 passes/)
})

test('an assertion failure is rejected', () => {
  const result = run("test('regression', () => { throw new Error('failed') })")
  assert.equal(result.status, 1)
  assert.throws(() => checkResult(result, 1), /exit 1/)
})
