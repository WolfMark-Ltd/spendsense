// WP23: real Chromium layout of the About & Support hub with isolated,
// invented values and no transport. Hero identity, the six actions in order,
// the Ko-fi support section directly below them, the FAQ and the progressive
// more-information disclosures. No payment widgets, scripts or iframes.
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

const ACTION_URLS = [
  'https://github.com/WolfMark-Ltd/spendsense/blob/main/docs/quickstart.md',
  'https://github.com/WolfMark-Ltd/spendsense/blob/main/docs/troubleshooting.md',
  'https://github.com/WolfMark-Ltd/spendsense/issues/new?template=bug-report.yml',
  'https://github.com/WolfMark-Ltd/spendsense/issues/new?template=feature-request.yml',
  'https://github.com/WolfMark-Ltd/spendsense',
  'https://wolfmark.co.uk/',
]
const KOFI_URL = 'https://ko-fi.com/wolfmark'
const CASES = {
  en: {
    heads: ['SpendSense 0.6.46', 'Get help and get involved', 'Support WolfMark Development', 'Help & FAQ', 'More information'],
    kofi: 'Support on Ko-fi',
    faqQ: 'Why don’t my SpendSense figures match my provider’s usage or billing dashboard?',
    privacy: 'Privacy',
    licence: 'Licence & credits',
  },
  zh: {
    heads: ['SpendSense 0.6.46', '获取帮助与参与', '支持 WolfMark 开发', '帮助与常见问题', '更多信息'],
    kofi: '在 Ko-fi 上支持',
    faqQ: '为什么 SpendSense 的数据与服务商的用量或账单面板对不上？',
    privacy: '隐私',
    licence: '许可与致谢',
  },
}

test('about hub fits narrow/wide light/dark containers with ordered actions and Ko-fi below', { skip: chrome ? false : 'No Chromium available for real layout checks' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wm-about-layout-'))
  try {
    const sdk = join(dir, 'sdk.mjs')
    let source = readFileSync(join(root, 'test/tooltip-layout.sdk.mjs'), 'utf8')
    source = source.replace(/export const usePluginI18n = \(\) => \(key, \.\.\.args\) => \{[\s\S]*?\n\}/,
      'export const usePluginI18n = () => (...args) => globalThis.__aboutT(...args)')
    source = source.replace("export const useQuery = () => ({ isLoading: false, isFetching: false, data: null })",
      "export const useQuery = options => {\n  const kind = options && options.queryKey ? options.queryKey[1] : null\n  const canned = globalThis.__aboutCanned ? globalThis.__aboutCanned[kind] : null\n  return { isLoading: false, isFetching: false, error: null, data: canned ? { ...canned, identity: options.queryKey[2] } : null, refetch: async () => {} }\n}")
    writeFileSync(sdk, source)
    for (const locale of ['en', 'zh']) {
      const entry = join(dir, `entry-${locale}.jsx`)
      writeFileSync(entry, `
import React from 'react'
import {createRoot} from 'react-dom/client'
import {__test as T} from '${root}/desktop/plugin.js'
import {calls} from '@hermes/plugin-sdk'
globalThis.__aboutT = (key, ...args) => typeof T.I18N.${locale}[key] === 'function' ? T.I18N.${locale}[key](...args) : T.I18N.${locale}[key] || key
globalThis.__aboutCanned = {
  // A matched pair: WP15's shell reads build.contract, and a fixture without one
  // would paint the mismatch notice over every container. The notice itself is
  // covered by test/compatibility.test.mjs.
  'health': { ok: true, version: '0.6.0-test', db_present: true, build: { contract: 3 } },
}
const cases = ['narrow-dark','wide-dark','narrow-light','wide-light']
for(const id of cases) {
  const el = document.getElementById(id)
  createRoot(el).render(<T.AboutPage />)
}
// Each root renders on React's own schedule, not the harness's, so wait for
// every root to carry its support section and bound the wait.
let readyChecks = 0
const begin = () => {
  const ready = cases.every(id => document.querySelector('#'+id+' .wm-about-kofi'))
  if (!ready && ++readyChecks <= 120) return setTimeout(begin, 25)
  measure()
}
const measure = () => {
  const out = {calls:calls.length, layouts:[]}
  for(const id of cases) {
    const el=document.getElementById(id), rect=el.getBoundingClientRect()
    const outside=[...el.querySelectorAll('input,select,button,a,details')].filter(x=>{const r=x.getBoundingClientRect();return r.left < rect.left-1 || r.right > rect.right+1})
    const tabs=[...el.querySelectorAll('[role="tab"]')].map(t=>t.getAttribute('aria-selected')+':'+t.tabIndex)
    const ordered=[...el.querySelectorAll('.wm-about-action,.wm-about-kofi')]
    const sections=[...el.querySelector('main').children].filter(child=>child.tagName==='SECTION')
    const supportIndex=sections.findIndex(section=>section.classList.contains('wm-about-support'))
    out.layouts.push({id,
      heads:[...el.querySelectorAll('main h2')].map(h=>h.textContent),
      heroSvg:el.querySelectorAll('.wm-about-hero svg').length,
      actionHrefs:[...el.querySelectorAll('.wm-about-action')].map(a=>a.getAttribute('href')),
      actionTargets:[...el.querySelectorAll('.wm-about-action')].map(a=>a.getAttribute('target')+'|'+a.getAttribute('rel')),
      kofiHref:el.querySelector('.wm-about-kofi')?.getAttribute('href') || '',
      kofiText:el.querySelector('.wm-about-kofi')?.textContent || '',
      kofiTarget:(el.querySelector('.wm-about-kofi')?.getAttribute('target') || '')+'|'+(el.querySelector('.wm-about-kofi')?.getAttribute('rel') || ''),
      kofiLast:ordered.length === 7 && ordered[ordered.length-1].classList.contains('wm-about-kofi'),
      supportBelow:supportIndex > 0 && !!sections[supportIndex-1].querySelector('.wm-about-actions'),
      embeds:el.querySelectorAll('iframe,script,embed,object').length,
      faqQ:el.querySelector('#about-faq summary')?.textContent || '',
      faqClosed:el.querySelector('#about-faq')?.open === false,
      moreSummaries:[...el.querySelectorAll('.wm-about-more details > summary')].map(s=>s.textContent),
      overflow:outside.map(x=>x.tagName), tabs})
  }
  const summary = document.querySelector('#wide-light #about-faq summary')
  summary?.focus()
  out.focusedSummary = document.activeElement === summary
  const details = summary?.closest('details')
  const wasOpen = details?.open === true
  summary?.click()
  out.toggleWorks = details?.open === true && !wasOpen
  document.getElementById('result').textContent=JSON.stringify(out)
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
        assert.deepEqual(layout.heads, CASES[locale].heads, `${locale} ${layout.id}: hero, actions, support, faq, more`)
        assert.equal(layout.heroSvg, 2, `${locale} ${layout.id}: hero carries the marque and company lockup`)
        assert.deepEqual(layout.actionHrefs, ACTION_URLS, `${locale} ${layout.id}: actions in order`)
        assert.ok(layout.actionTargets.every(t => t === '_blank|noreferrer'), `${locale} ${layout.id}`)
        assert.equal(layout.kofiHref, KOFI_URL, `${locale} ${layout.id}: exact Ko-fi URL`)
        assert.equal(layout.kofiText, CASES[locale].kofi, `${locale} ${layout.id}`)
        assert.equal(layout.kofiTarget, '_blank|noreferrer', `${locale} ${layout.id}`)
        assert.equal(layout.kofiLast, true, `${locale} ${layout.id}: Ko-fi follows every action`)
        assert.equal(layout.supportBelow, true, `${locale} ${layout.id}: support sits below the actions`)
        assert.equal(layout.embeds, 0, `${locale} ${layout.id}: no payment widgets, scripts or iframes`)
        assert.equal(layout.faqQ, CASES[locale].faqQ, `${locale} ${layout.id}`)
        assert.equal(layout.faqClosed, true, `${locale} ${layout.id}`)
        assert.deepEqual(layout.moreSummaries, [CASES[locale].privacy, CASES[locale].licence], `${locale} ${layout.id}`)
        assert.deepEqual(layout.overflow, [], `${locale} ${layout.id}`)
        assert.equal(layout.tabs.length, 8, `${locale} ${layout.id}: eight-tab navigation kept`)
        assert.equal(layout.tabs.filter(t => t.startsWith('true:')).length, 1, `${locale} ${layout.id}`)
        assert.equal(layout.tabs.filter(t => t === 'false:-1').length, 7, `${locale} ${layout.id}: roving tabindex`)
      }
      assert.equal(data.focusedSummary, true, `${locale}: FAQ summary is keyboard-focusable`)
      assert.equal(data.toggleWorks, true, `${locale}: FAQ disclosure toggles`)
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
