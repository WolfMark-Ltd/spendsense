import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'

test('web dashboard entry registers the Desktop handoff', () => {
  const source = readFileSync(new URL('../dashboard/entry.js', import.meta.url), 'utf8')
  let name, component
  const window = {__HERMES_PLUGINS__: {register: (id, view) => { name = id; component = view }},
    __HERMES_PLUGIN_SDK__: {React: {createElement: (tag, props, text) => ({tag, text})}}}
  runInNewContext(source, {window})
  assert.equal(name, 'spend-sense')
  assert.match(component().text, /Hermes Desktop/)
})
