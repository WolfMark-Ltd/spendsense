// WP12: real Chromium layout of the reorganised Settings page with isolated,
// invented values and no transport. Operational sections first, privacy notes
// next to their controls, support links and licence disclosure in About.
// Jump controls are buttons that scroll without touching the host hash.
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

const ABOUT_LINKS = ['https://wolfmark.co.uk/', 'https://github.com/WolfMark-Ltd/spendsense',
  'https://github.com/WolfMark-Ltd/spendsense/issues/new?template=bug-report.yml',
  'https://github.com/WolfMark-Ltd/spendsense/issues/new?template=feature-request.yml',
  'https://github.com/WolfMark-Ltd/spendsense/blob/main/docs/quickstart.md',
  'https://wolfmark.co.uk/contact']
const CASES = {
  en: {
    heads: ['Budget guardrails', 'Pricing provenance and freshness', 'SpendSense Live Updates',
      'Hermes model availability', 'Advanced billing rules', 'Display and recovery',
      'Diagnostics', 'About and support'],
    navLabel: 'On this page',
    licence: 'Licence & credits',
    privacy: ['no direct HTTP pricing requests', 'off by default', 'cached in this Desktop session', 'telemetry'],
  },
  zh: {
    heads: ['预算护栏', '价格溯源与新鲜度', 'SpendSense 实时更新',
      'Hermes 模型可用性', '高级计费规则', '显示与恢复',
      '诊断', '关于与支持'],
    navLabel: '本页导航',
    licence: '许可与致谢',
    privacy: ['不直接发起', '默认关闭', '已缓存的选项', '遥测'],
  },
}

test('settings fits narrow/wide light/dark containers, ordered with working disclosures', { skip: chrome ? false : 'No Chromium available for real layout checks' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wm-settings-layout-'))
  try {
    const sdk = join(dir, 'sdk.mjs')
    let source = readFileSync(join(root, 'test/tooltip-layout.sdk.mjs'), 'utf8')
    source = source.replace(/export const usePluginI18n = \(\) => \(key, \.\.\.args\) => \{[\s\S]*?\n\}/,
      'export const usePluginI18n = () => (...args) => globalThis.__settingsT(...args)')
    source = source.replace("export const useQuery = () => ({ isLoading: false, isFetching: false, data: null })",
      "export const useQuery = options => {\n  const kind = options && options.queryKey ? options.queryKey[1] : null\n  const canned = globalThis.__settingsCanned ? globalThis.__settingsCanned[kind] : null\n  return { isLoading: false, isFetching: false, error: null, data: canned ? { ...canned, identity: options.queryKey[2] } : null, refetch: async () => {} }\n}")
    writeFileSync(sdk, source)
    for (const locale of ['en', 'zh']) {
      const entry = join(dir, `entry-${locale}.jsx`)
      writeFileSync(entry, `
import React from 'react'
import {createRoot} from 'react-dom/client'
import {__test as T} from '${root}/desktop/plugin.js'
import {calls} from '@hermes/plugin-sdk'
globalThis.__settingsT = (key, ...args) => typeof T.I18N.${locale}[key] === 'function' ? T.I18N.${locale}[key](...args) : T.I18N.${locale}[key] || key
globalThis.__settingsCanned = {
  'pricing-status': { source: 'synthetic bundled snapshot', as_of: '2026-11-10T00:00:00.000Z', age_seconds: 7200, stale: false },
  'membership-plans': { ok: true, source: 'bundled', catalogue_version: 'test-2026-11-11.1', generated_at: '2026-11-10T00:00:00.000Z', central: null, totals: { plans: 2, verified: 1, provisional: 1, placeholders: 0 }, sources: [{ id: 'synthetic-source', evidence_kind: 'official', retrieved_at: '2026-11-09', url: 'https://example.com/synthetic-provider/pricing' }] },
  // A matched pair: WP15's shell reads build.contract, and a fixture without one
  // would paint the mismatch notice over every container. The notice itself is
  // covered by test/compatibility.test.mjs.
  'health': { ok: true, version: '0.6.0-test', db_present: true, build: { contract: 3 } },
  'news-settings': { ok: true, settings: { live_updates: false } },
  'budget-status': { ok: true, rev: 'fixture', budgets: [], statuses: [] },
  'billing-profiles': { ok: true, profiles: [] },
}
const cases = ['narrow-dark','wide-dark','narrow-light','wide-light']
for(const id of cases) {
  const el = document.getElementById(id)
  createRoot(el).render(<T.SettingsPage />)
}
// Each root renders on React's own schedule, not the harness's. A fixed sleep
// measured the page before it existed once the compatibility block made the
// roots heavier, so wait for every root to carry its sections and bound the wait.
let readyChecks = 0
const begin = () => {
  const ready = cases.every(id => document.querySelector('#'+id+' #settings-about'))
  if (!ready && ++readyChecks <= 120) return setTimeout(begin, 25)
  measure()
}
const measure = () => {
  const out = {calls:calls.length, layouts:[]}
  for(const id of cases) {
    const el=document.getElementById(id), rect=el.getBoundingClientRect()
    const nav=el.querySelector('nav[aria-label]')
    const jumps=[...(nav?.querySelectorAll('button') || [])].map(b=>b.textContent)
    const outside=[...el.querySelectorAll('input,select,button,a,details')].filter(x=>{const r=x.getBoundingClientRect();return r.left < rect.left-1 || r.right > rect.right+1})
    const tabs=[...el.querySelectorAll('[role=\"tab\"]')].map(t=>t.getAttribute('aria-selected')+':'+t.tabIndex)
    out.layouts.push({id,
      heads:[...el.querySelectorAll('.wm-settings-grid h2')].map(h=>h.textContent),
      navLabel:nav?.getAttribute('aria-label'), jumps,
      aboutLinks:[...el.querySelector('#settings-about').querySelectorAll('a')].map(a=>a.getAttribute('href')),
      aboutTargets:[...el.querySelector('#settings-about').querySelectorAll('a')].map(a=>a.getAttribute('target')+'|'+a.getAttribute('rel')),
      licence:el.querySelector('#settings-about details summary')?.textContent || '',
      licenceStartsClosed:el.querySelector('#settings-about details')?.open === false,
      toggles:el.querySelectorAll('.wm-setting-toggle input[type=\"checkbox\"]').length,
      overflow:outside.map(x=>x.tagName), tabs})
  }
  const sec = id => document.querySelector('#wide-light #'+id)?.textContent || ''
  out.privacy = [sec('settings-pricing'), sec('settings-models'), sec('settings-models'), sec('settings-data')]
  // Jump behaviour: instant scroll (reduced motion), host hash untouched.
  window.matchMedia = () => ({ matches: true })
  const narrow = document.getElementById('narrow-dark')
  const hashBefore = location.hash
  const jumpBtns = [...narrow.querySelectorAll('nav[aria-label] button')]
  const about = document.getElementById('settings-about')
  jumpBtns[jumpBtns.length - 1]?.click()
  out.hashUnchanged = location.hash === hashBefore
  out.jumpFocusTag = document.activeElement?.tagName || ''
  out.jumpFocusText = document.activeElement?.textContent || ''
  setTimeout(() => {
    const bar = narrow.querySelector('.wm-product-tabs')
    const targetTop = about.getBoundingClientRect().top
    out.jumpVisible = targetTop >= bar.getBoundingClientRect().bottom - 1
    out.jumpInView = targetTop >= 0 && targetTop < window.innerHeight
    out.scrollMargins = {
      narrow: getComputedStyle(narrow.querySelector('#settings-about')).scrollMarginTop,
      wide: getComputedStyle(document.getElementById('wide-dark').querySelector('#settings-about')).scrollMarginTop,
    }
    const summary = document.querySelector('#wide-light #settings-about details summary')
    summary?.focus()
    out.focusedSummary = document.activeElement === summary
    const details = summary?.closest('details')
    const wasOpen = details?.open === true
    summary?.click()
    out.toggleWorks = details?.open === true && !wasOpen
    const jump = document.querySelector('#wide-light nav[aria-label] button')
    jump?.focus()
    out.focusedJump = document.activeElement === jump
    document.getElementById('result').textContent=JSON.stringify(out)
  }, 100)
}
begin()
`)
      const esbuild = (await import(pathToFileURL(join(modules, 'esbuild/lib/main.js')))).default
      await esbuild.build({ entryPoints: [entry], bundle: true, platform: 'browser', format: 'iife', outfile: join(dir, `page-${locale}.js`),
        alias: { '@hermes/plugin-sdk': sdk, react: join(modules, 'react'), 'react-dom': join(modules, 'react-dom') },
        nodePaths: [modules], logLevel: 'warning', jsx: 'automatic' })
      const html = join(dir, `page-${locale}.html`)
      writeFileSync(html, `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box}body{margin:0;font:13px/1.5 system-ui} .case{margin:10px;display:inline-block;vertical-align:top;background:var(--ui-fill-primary);color:var(--ui-text-primary);container-type:inline-size}
.dark{--ui-fill-primary:#12141a;--ui-fill-secondary:#1a1d26;--ui-fill-tertiary:#232633;--ui-stroke-secondary:#2b2f40;--ui-text-primary:#eef0f6;--ui-text-secondary:#b9bdd1;--ui-text-tertiary:#a9aec6;--ui-text-quaternary:#9398b0;--ui-accent:#4f7cff;--ui-warning:#f5b544;--ui-error:#f26d6d}
.light{--ui-fill-primary:#fff;--ui-fill-secondary:#f2f4f7;--ui-fill-tertiary:#e3e5eb;--ui-stroke-secondary:#c5cbd5;--ui-text-primary:#151823;--ui-text-secondary:#414655;--ui-text-tertiary:#555b69;--ui-text-quaternary:#626877;--ui-accent:#3157c0;--ui-warning:#9a5e00;--ui-error:#b42318}
.narrow{width:380px}.wide{width:1080px}#result{display:none}
</style></head><body>${['narrow-dark', 'wide-dark', 'narrow-light', 'wide-light'].map(id => `<div id="${id}" class="case ${id.replace('-', ' ')}"></div>`).join('')}<div id="result"></div><script>${readFileSync(join(dir, `page-${locale}.js`), 'utf8')}</script></body></html>`)
      const output = execFileSync(chrome, ['--headless', '--disable-gpu', '--no-sandbox', `--user-data-dir=${join(dir, `chrome-profile-${locale}`)}`, '--virtual-time-budget=5000', '--dump-dom', `file://${html}`], { timeout: 60000, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).toString()
      const result = output.match(/<div id="result"[^>]*>([^<]*)<\/div>/)
      assert.ok(result?.[1], `${locale}: browser records layout results`)
      const data = JSON.parse(result[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&gt;/g, '>').replace(/&lt;/g, '<'))
      assert.equal(data.calls, 0, `${locale}: no transport or host requests`)
      assert.equal(data.layouts.length, 4, locale)
      for (const layout of data.layouts) {
        assert.deepEqual(layout.heads, CASES[locale].heads, `${locale} ${layout.id}: operational sections first`)
        assert.equal(layout.navLabel, CASES[locale].navLabel, `${locale} ${layout.id}`)
        assert.deepEqual(layout.jumps, CASES[locale].heads, `${locale} ${layout.id}: jump labels match sections`)
        assert.deepEqual(layout.aboutLinks, ABOUT_LINKS, `${locale} ${layout.id}`)
        assert.ok(layout.aboutTargets.every(t => t === '_blank|noreferrer'), `${locale} ${layout.id}`)
        assert.equal(layout.licence, CASES[locale].licence, `${locale} ${layout.id}`)
        assert.equal(layout.licenceStartsClosed, true, `${locale} ${layout.id}`)
        assert.equal(layout.toggles, 2, `${locale} ${layout.id}: both opt-in toggles render`)
        assert.deepEqual(layout.overflow, [], `${locale} ${layout.id}`)
        assert.equal(layout.tabs.length, 7, `${locale} ${layout.id}: seven-tab navigation kept`)
        assert.equal(layout.tabs.filter(t => t.startsWith('true:')).length, 1, `${locale} ${layout.id}`)
        assert.equal(layout.tabs.filter(t => t === 'false:-1').length, 6, `${locale} ${layout.id}: roving tabindex`)
      }
      for (const [index, snippet] of CASES[locale].privacy.entries()) {
        assert.match(data.privacy[index], new RegExp(snippet.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${locale}: privacy note ${index} sits with its control`)
      }
      assert.equal(data.hashUnchanged, true, `${locale}: jump scroll leaves the host hash alone`)
      assert.equal(data.jumpFocusTag, 'H2', `${locale}: jump lands focus on the destination heading`)
      assert.equal(data.jumpFocusText, CASES[locale].heads.at(-1), `${locale}: jump lands on the selected section`)
      assert.equal(data.jumpVisible, true, `${locale}: jumped-to heading lands below the sticky bar`)
      assert.equal(data.jumpInView, true, `${locale}: jumped-to heading is in view`)
      assert.deepEqual(data.scrollMargins, { narrow: '150px', wide: '70px' }, `${locale}: scroll offset fits the bar`)
      assert.equal(data.focusedSummary, true, `${locale}: disclosure summary is keyboard-focusable`)
      assert.equal(data.toggleWorks, true, `${locale}: disclosure toggles`)
      assert.equal(data.focusedJump, true, `${locale}: jump controls are keyboard-focusable`)
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
