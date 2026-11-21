/**
 * One esbuild + jsdom bootstrap for the browserless page suites.
 *
 * `news-render`, `memberships-reading` and `membership-scope` each carry their
 * own copy of this sequence. The Overview and Usage migration added two more
 * suites, so the steps live here once: build `desktop/plugin.js` against
 * `test/harness/real-sdk.mjs` (real atoms, real TanStack Query, synthetic
 * transport), install a DOM, then import the bundle.
 *
 * Nothing here is a product stand-in: the bundle is the shipped plugin, React
 * and the query client are the real packages, and only the app around them —
 * the connection atoms and the transport — is supplied by the test.
 *
 * Setup once: npm ci --prefix test/harness
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
export const HARNESS_MODULES = join(ROOT, 'test', 'harness', 'node_modules')

if (!existsSync(join(HARNESS_MODULES, '@tanstack', 'react-query'))) {
  throw new Error('real-query harness is not installed: run `npm ci --prefix test/harness`')
}

/** The translator every suite should use: the product's own dictionary. */
export const translatorFor = (I18N, locale) => (key, ...args) => {
  const entry = I18N[locale]?.[key]
  return typeof entry === 'function' ? entry(...args) : entry ?? key
}

/**
 * Build and load the plugin as one module graph with one copy of React, over a
 * fresh jsdom document.
 *
 * `extraExports` is spliced into the entry module so a suite can reach the
 * harness-only helpers (`__bumpActivation`, the test atoms) without importing
 * `real-sdk.mjs` twice — a second copy of nanostores would mean two atom sets.
 */
export async function loadPageHarness({ extraExports = '' } = {}) {
  const work = mkdtempSync(join(tmpdir(), 'wm-page-'))
  const entry = join(work, 'entry.mjs')
  writeFileSync(entry, `
export { default as plugin, __test as T } from '${join(ROOT, 'desktop', 'plugin.js')}'
export * as React from 'react'
export * as ReactDOMClient from 'react-dom/client'
export { QueryClientProvider, queryClient, i18nBackend } from '@hermes/plugin-sdk'
${extraExports}
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
      // npm installs a peer copy into test/harness; two copies of React means a
      // null dispatcher inside the provider.
      react: join(HARNESS_MODULES, 'react'),
      'react-dom': join(HARNESS_MODULES, 'react-dom'),
    },
    nodePaths: [HARNESS_MODULES],
    logLevel: 'warning',
  })

  const { JSDOM } = await import(pathToFileURL(join(HARNESS_MODULES, 'jsdom', 'lib', 'api.js')).href)
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
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
  return {
    ...lib,
    dom,
    work,
    /** Bounded settle: React act over a few macrotasks. */
    flush: async (times = 6) => {
      await lib.React.act(async () => {
        for (let i = 0; i < times; i += 1) await new Promise(resolve => setTimeout(resolve, 0))
      })
    },
    close() {
      esbuild.stop()
      rmSync(work, { recursive: true, force: true })
    },
  }
}

/** Collapse rendered whitespace so a copy assertion is not spacing-sensitive. */
export const flat = text => String(text || '').replace(/\s+/g, ' ').trim()
