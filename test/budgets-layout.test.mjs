// Real Chromium layout with isolated, invented values and no transport.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
const root = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const modules = join(root, 'test/harness/node_modules')
const chrome = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(existsSync)

test('budget editor and forecast fit narrow/wide light/dark containers, with keyboard tooltips', { skip: chrome ? false : 'No Chromium available for real layout checks' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wm-budget-layout-'))
  try {
    const sdk = join(dir, 'sdk.mjs')
    let source = readFileSync(join(root, 'test/tooltip-layout.sdk.mjs'), 'utf8')
    source = source.replace(/export const usePluginI18n = \(\) => \(key, \.\.\.args\) => \{[\s\S]*?\n\}/,
      'export const usePluginI18n = () => (...args) => globalThis.__budgetT(...args)')
    source = source.replace("export const useQuery = () => ({ isLoading: false, isFetching: false, data: null })",
      "export const useQuery = options => ({ isLoading: false, isFetching: false, data: options.queryKey[1] === 'budget-status' ? { ...globalThis.__budgetReport, identity: options.queryKey[2] } : null })")
    writeFileSync(sdk, source)
    const entry = join(dir, 'entry.jsx')
    writeFileSync(entry, `
import React from 'react'
import {createRoot} from 'react-dom/client'
import {__test as T} from '${root}/desktop/plugin.js'
import {calls} from '@hermes/plugin-sdk'
globalThis.__budgetT = (key, ...args) => typeof T.I18N.en[key] === 'function' ? T.I18N.en[key](...args) : T.I18N.en[key] || key
const b = { id:'monthly', label:'Monthly catalogue value', amount:100, currency:'USD', enabled:true, scope:'total', measurement:'api_equivalent', thresholds:[50,80,100], timezone:'Europe/London', cycle_day:1, model:'', provider:'' }
globalThis.__budgetReport = { ok:true, rev:'fixture', budgets:[b], statuses:[{id:b.id, budget:b, spend:80, percentage:80, complete:true, level:'warning', budget_rev:'fixture', cycle:{id:'cycle', start:'2026-11-01', end:'2026-12-01'}, coverage:{calls:40, measured_calls:40}, forecast:{available:true, projected:125, days_remaining:12, breach_date:'2026-11-25', burn_7:4, burn_30:3, trend:'accelerating', samples:{'30':{calls:40,active_days:8}}}}] }
T.$budgetDraft.set({...T.newBudgetDraft('local|test#1','fixture'), label:'Route usage-value limit', amount:100, scope:'model_route', provider:'invented-provider', model:'invented-model'})
for(const id of ['narrow-dark','wide-dark','narrow-light','wide-light']) {
  const el = document.getElementById(id)
  createRoot(el).render(<div className="wm-analytics wm-product"><style>{T.ANALYTICS_CSS+T.PRODUCT_CSS}</style><main className="wm-shell"><T.BudgetPanel manage forecasts /></main></div>)
}
setTimeout(() => {
  const out = {calls:calls.length, layouts:[]}
  for(const id of ['narrow-dark','wide-dark','narrow-light','wide-light']) {
    const el=document.getElementById(id), rect=el.getBoundingClientRect()
    const form=el.querySelector('form'), progress=el.querySelector('progress'), info=el.querySelector('.wm-info-btn')
    const outside=[...el.querySelectorAll('input,select,button,progress,article')].filter(x=>{const r=x.getBoundingClientRect();return r.left < rect.left-1 || r.right > rect.right+1})
    out.layouts.push({id, overflow:outside.map(x=>x.tagName), form:!!form, progress:!!progress, progressLabel:progress?.getAttribute('aria-label'), text:el.textContent})
    info?.focus()
  }
  setTimeout(()=>{out.tooltip=!!document.querySelector('[role=tooltip]');document.getElementById('result').textContent=JSON.stringify(out)},100)
},500)
`)
    const esbuild = (await import(pathToFileURL(join(modules, 'esbuild/lib/main.js')))).default
    await esbuild.build({ entryPoints: [entry], bundle: true, platform: 'browser', format: 'iife', outfile: join(dir, 'page.js'),
      alias: { '@hermes/plugin-sdk': sdk }, nodePaths: [modules], logLevel: 'warning', jsx: 'automatic' })
    const html = join(dir, 'page.html')
    writeFileSync(html, `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box}body{margin:0;font:13px/1.5 system-ui} .case{margin:10px;display:inline-block;vertical-align:top;background:var(--ui-fill-primary);color:var(--ui-text-primary)}
.dark{--ui-fill-primary:#12141a;--ui-fill-secondary:#1a1d26;--ui-fill-tertiary:#232633;--ui-stroke-secondary:#2b2f40;--ui-text-primary:#eef0f6;--ui-text-secondary:#b9bdd1;--ui-text-tertiary:#a9aec6;--ui-text-quaternary:#9398b0;--ui-accent:#4f7cff;--ui-warning:#f5b544;--ui-error:#f26d6d}
.light{--ui-fill-primary:#fff;--ui-fill-secondary:#f2f4f7;--ui-fill-tertiary:#e3e5eb;--ui-stroke-secondary:#c5cbd5;--ui-text-primary:#151823;--ui-text-secondary:#414655;--ui-text-tertiary:#555b69;--ui-text-quaternary:#626877;--ui-accent:#3157c0;--ui-warning:#9a5e00;--ui-error:#b42318}
.narrow{width:380px}.wide{width:1080px}#result{display:none}
</style></head><body>${['narrow-dark','wide-dark','narrow-light','wide-light'].map(id => `<div id="${id}" class="case ${id.replace('-', ' ')}"></div>`).join('')}<div id="result"></div><script>${readFileSync(join(dir, 'page.js'), 'utf8')}</script></body></html>`)
    const output = execFileSync(chrome, ['--headless', '--disable-gpu', '--no-sandbox', '--virtual-time-budget=5000', '--dump-dom', `file://${html}`], { timeout: 60000, maxBuffer: 16*1024*1024, stdio: ['ignore', 'pipe', 'ignore'] }).toString()
    const result = output.match(/<div id="result"[^>]*>([^<]*)<\/div>/)
    assert.ok(result?.[1], 'browser records layout results')
    const data = JSON.parse(result[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&gt;/g, '>').replace(/&lt;/g, '<'))
    assert.equal(data.calls, 0)
    assert.equal(data.layouts.length, 4)
    for (const layout of data.layouts) {
      assert.deepEqual(layout.overflow, [], layout.id)
      assert.equal(layout.form, true, layout.id)
      assert.equal(layout.progress, true, layout.id)
      assert.match(layout.progressLabel, /Estimated usage value/)
      assert.match(layout.text, /runway 12 days/)
      assert.match(layout.text, /accelerating/)
    }
    assert.equal(data.tooltip, true, 'keyboard focus exposes contextual help')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
