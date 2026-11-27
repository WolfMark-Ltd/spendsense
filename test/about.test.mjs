/**
 * About & Support hub — structure and copy, rendered browserlessly.
 *
 * The hub is presentational: hero identity, the six actions in their mandated
 * order, the Ko-fi support section directly below them, the FAQ and the
 * progressive more-information disclosures. Geometry (overflow, narrow/wide,
 * dark/light) belongs to test/about-layout.test.mjs.
 *
 * Setup once: npm ci --prefix test/harness
 * Run with:   bash scripts/node-tests.sh browserless
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { after, test } from 'node:test'
import { flat, loadPageHarness, translatorFor } from './render-harness.mjs'
import { overviewHealth } from './overview-fixtures.mjs'

const harness = await loadPageHarness()
const { T, React, ReactDOMClient, QueryClientProvider, queryClient, i18nBackend, plugin, dom, flush } = harness

const baseCtx = {
  rest: async path => {
    if (path === '/health') return overviewHealth(T.REQUIRED_BACKEND_CONTRACT)
    return { ok: true }
  },
  storage: { get: (_key, fallback) => fallback, set() {}, delete() {} },
  register() {}, registerMany() {}, onDispose() {}, onEvent: () => () => {},
  setTimeout: fn => { const timer = setTimeout(fn, 0); return () => clearTimeout(timer) },
  setInterval: () => () => {}, addEventListener: () => () => {},
  os: {}, pet: null, i18n: { register() {}, t: key => key },
}
plugin.register(baseCtx)

/**
 * Re-register with a stubbed OS door, restoring the doorless ctx after.
 * osApi is module state set by register, so this drives the real host-door
 * branch of external links without touching any other suite state.
 */
const withOsApi = async (os, fn) => {
  plugin.register({ ...baseCtx, os })
  try { await fn() } finally { await React.act(async () => { plugin.register(baseCtx) }) }
}

const roots = []

/**
 * Render the real AboutPage. The previous page is unmounted first: two
 * mounted pages share the tooltip atom and the query cache, and an assertion
 * left on the earlier screen could pass vacuously.
 */
const boot = async ({ locale = 'en' } = {}) => {
  while (roots.length) {
    const previous = roots.pop()
    try { await React.act(async () => { previous.unmount() }) } catch { /* already gone */ }
  }
  queryClient.clear()
  T.$ledgerTab.set('about')
  T.$infoOpen.set(null)
  i18nBackend.t = translatorFor(T.I18N, locale)
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = ReactDOMClient.createRoot(container)
  roots.push(root)
  await React.act(async () => {
    root.render(React.createElement(QueryClientProvider, { client: queryClient },
      React.createElement(T.AboutPage)))
  })
  await flush()
  return container
}

after(() => {
  queryClient.clear()
  dom.window.close()
  harness.close()
})
test.afterEach(async () => {
  while (roots.length) {
    const root = roots.pop()
    try { await React.act(async () => { root.unmount() }) } catch { /* already gone */ }
  }
  queryClient.clear()
})

const ACTION_URLS = [
  'https://github.com/WolfMark-Ltd/spendsense/blob/main/docs/quickstart.md',
  'https://github.com/WolfMark-Ltd/spendsense/blob/main/docs/troubleshooting.md',
  'https://github.com/WolfMark-Ltd/spendsense/issues/new?template=bug-report.yml',
  'https://github.com/WolfMark-Ltd/spendsense/issues/new?template=feature-request.yml',
  'https://github.com/WolfMark-Ltd/spendsense',
  'https://wolfmark.co.uk/',
]
const ACTION_LABELS = {
  en: ['Quick-start guide', 'Help and troubleshooting', 'Report a bug',
    'Request a feature', 'GitHub repository', 'WolfMark website'],
  zh: ['快速入门指南', '帮助与故障排除', '报告问题',
    '功能建议', 'GitHub 仓库', 'WolfMark 官网'],
}

test('the hero introduces SpendSense and names WolfMark as the developer', async () => {
  const container = await boot()
  assert.equal(flat(container.querySelector('main h1')?.textContent), 'About & Support')
  assert.ok(container.querySelector('.wm-about-hero svg'), 'the approved marque renders in the hero')
  assert.equal(flat(container.querySelector('.wm-about-name')?.textContent), 'SpendSense 0.6.45')
  assert.match(flat(container.querySelector('.wm-about-developer')?.textContent), /WolfMark Ltd/)
  assert.match(flat(container.querySelector('.wm-about-hero > p')?.textContent), /usage accounting for Hermes/)
})

test('the six actions link out in the mandated order with safe targets', async () => {
  const container = await boot()
  const actions = [...container.querySelectorAll('.wm-about-action')]
  assert.deepEqual(actions.map(a => a.getAttribute('href')), ACTION_URLS)
  assert.deepEqual(actions.map(a => flat(a.querySelector('strong')?.textContent)), ACTION_LABELS.en)
  assert.ok(actions.every(a => a.getAttribute('target') === '_blank' && a.getAttribute('rel') === 'noreferrer'))
  assert.ok(actions.every(a => flat(a.querySelector('span')?.textContent).length > 0), 'every action has a description')
})

test('the Ko-fi support section follows the repository and website links', async () => {
  const container = await boot()
  const main = container.querySelector('main')
  const kofi = main.querySelector('.wm-about-kofi')
  assert.equal(kofi.getAttribute('href'), 'https://ko-fi.com/wolfmark')
  assert.equal(flat(kofi.textContent), 'Support on Ko-fi')
  assert.equal(kofi.getAttribute('target'), '_blank')
  assert.equal(kofi.getAttribute('rel'), 'noreferrer')
  const ordered = [...main.querySelectorAll('.wm-about-action, .wm-about-kofi')]
  assert.equal(ordered.length, 7)
  assert.equal(ordered.at(-1), kofi, 'the Ko-fi CTA comes after every action link')
  const sections = [...main.children].filter(el => el.tagName === 'SECTION')
  const supportIndex = sections.findIndex(section => section.classList.contains('wm-about-support'))
  assert.ok(sections[supportIndex - 1].querySelector('.wm-about-actions'),
    'the support section sits directly below the actions')
  assert.match(flat(main.querySelector('.wm-about-support p')?.textContent), /voluntary contribution/i)
  assert.match(flat(main.querySelector('.wm-about-support .wm-subtle')?.textContent), /not charitable donations/i)
  assert.equal(main.querySelectorAll('iframe, script, embed, object').length, 0,
    'support is a plain link: no payment widgets, scripts or iframes')
})

test('the FAQ answers the provider-mismatch question, collapsed by default', async () => {
  const container = await boot()
  const faq = container.querySelector('#about-faq')
  assert.ok(faq)
  assert.equal(faq.open, false)
  assert.equal(flat(faq.querySelector('summary')?.textContent),
    'Why don’t my SpendSense figures match my provider’s usage or billing dashboard?')
  assert.match(flat(faq.textContent), /calendar month to date/)
  assert.match(flat(faq.textContent), /API-equivalent estimates, not payments/)
  assert.match(flat(faq.textContent), /actual provider charges are not recorded/)
  const guide = faq.querySelector('a[href="https://github.com/WolfMark-Ltd/spendsense/blob/main/docs/troubleshooting.md"]')
  assert.ok(guide)
  assert.equal(guide.getAttribute('target'), '_blank')
})

test('Help & FAQ is its own discoverable section', async () => {
  const container = await boot()
  const faqSection = container.querySelector('.wm-about-faq-section')
  assert.ok(faqSection)
  assert.equal(flat(faqSection.querySelector('h2')?.textContent), 'Help & FAQ')
  assert.equal(faqSection.querySelector('#about-faq')?.tagName, 'DETAILS')
})

test('more information keeps privacy, licence, credits and contact', async () => {
  const container = await boot()
  const more = container.querySelector('.wm-about-more')
  assert.deepEqual([...more.querySelectorAll('details > summary')].map(s => flat(s.textContent)),
    ['Privacy', 'Licence & credits'])
  assert.match(flat(more.textContent), /does not collect prompts, responses or telemetry/)
  assert.match(flat(more.textContent), /GPL-3\.0/)
  assert.match(flat(more.textContent), /AFei/)
  const contact = more.querySelector('a[href="https://wolfmark.co.uk/contact"]')
  assert.ok(contact)
  assert.equal(flat(contact.textContent), 'Contact WolfMark support')
})

test('Chinese labels render through the dictionary', async () => {
  const container = await boot({ locale: 'zh' })
  assert.equal(flat(container.querySelector('main h1')?.textContent), '关于与支持')
  const tabs = [...container.querySelectorAll('[role="tab"]')]
  assert.equal(tabs.length, 8)
  assert.equal(tabs.at(-1).getAttribute('aria-label'), '关于与支持')
  assert.deepEqual([...container.querySelectorAll('.wm-about-action strong')].map(s => flat(s.textContent)),
    ACTION_LABELS.zh)
  assert.deepEqual([...container.querySelectorAll('.wm-about-group h3')].map(s => flat(s.textContent)),
    ['帮助资源', '参与贡献', 'WolfMark'])
  assert.equal(flat(container.querySelector('.wm-about-faq-section h2')?.textContent), '帮助与常见问题')
  assert.equal(flat(container.querySelector('.wm-about-kofi')?.textContent), '在 Ko-fi 上支持')
  assert.equal(flat(container.querySelector('#about-faq summary')?.textContent),
    '为什么 SpendSense 的数据与服务商的用量或账单面板对不上？')
})

test('goAboutFaq reveals and focuses the FAQ exactly once', async () => {
  const plain = await boot()
  assert.equal(plain.querySelector('#about-faq').open, false)
  T.goAboutFaq()
  assert.equal(T.$ledgerTab.get(), 'about')
  const revealed = await boot()
  const faq = revealed.querySelector('#about-faq')
  assert.equal(faq.open, true)
  assert.equal(document.activeElement, faq.querySelector('summary'))
  assert.equal(faq.querySelector('summary').hasAttribute('tabindex'), false,
    'the summary stays in the normal keyboard tab order')
  const replay = await boot()
  assert.equal(replay.querySelector('#about-faq').open, false, 'a satisfied request never replays itself')
})

test('goAboutCacheFaq reveals and focuses the cache answer, leaving mismatch closed', async () => {
  const plain = await boot()
  assert.equal(plain.querySelector('#about-faq-cache').open, false)
  T.goAboutCacheFaq()
  assert.equal(T.$ledgerTab.get(), 'about')
  const revealed = await boot()
  const cache = revealed.querySelector('#about-faq-cache')
  assert.equal(cache.open, true)
  assert.equal(document.activeElement, cache.querySelector('summary'))
  assert.equal(revealed.querySelector('#about-faq').open, false,
    'the cache link opens its own answer, not the mismatch one')
  const replay = await boot()
  assert.equal(replay.querySelector('#about-faq-cache').open, false, 'a satisfied request never replays itself')
})

test('the hero showcases the WolfMark company lockup beside the SpendSense marque', async () => {
  const container = await boot()
  const hero = container.querySelector('.wm-about-hero')
  assert.equal(hero.querySelectorAll('svg').length, 2)
  const lockup = hero.querySelector('.wm-about-company svg')
  assert.ok(lockup)
  assert.equal(lockup.getAttribute('aria-label'), 'WolfMark')
  assert.equal(lockup.querySelectorAll('path').length, 9)
  assert.match(flat(hero.querySelector('.wm-about-developer')?.textContent), /WolfMark Ltd/)
})

test('the company lockup reproduces the approved master exactly', async () => {
  const container = await boot()
  const company = container.querySelector('.wm-about-company')
  const lockup = company.querySelector('svg')
  assert.equal(lockup.getAttribute('viewBox'), '232.558 267.748 1360.585 336.056')
  const paths = [...lockup.querySelectorAll('path')]
  assert.equal(paths.length, 9)
  // Pinned digest of the nine glyph `d` strings in DOM order, taken from the
  // approved brand-kit master: any redrawn, retraced or edited glyph fails.
  // Re-pin only from a newly approved master, never from rendered output.
  const geometry = createHash('sha256')
    .update(paths.map(path => path.getAttribute('d')).join('\n')).digest('hex')
  assert.equal(geometry, '0e98641af8d8175d0ce6d6e0bfe200a8a54f9bafd4dd9fa84579be71b83e45c1')
  // The master marks the O, A and R counters fill-rule evenodd; without it
  // the default nonzero rule fills the R bowl and the A counter (F150).
  paths.forEach((path, index) => {
    assert.equal(path.getAttribute('fill-rule'), [2, 6, 7].includes(index) ? 'evenodd' : null)
  })
  assert.equal(company.children[0].className, 'wm-about-developer')
  assert.equal(company.children[1].tagName, 'svg',
    'the developer caption leads into the company signature lockup')
})

test('the six actions stay ordered under three group headings', async () => {
  const container = await boot()
  const groups = [...container.querySelectorAll('.wm-about-group')]
  assert.deepEqual(groups.map(g => flat(g.querySelector('h3')?.textContent)),
    ['Help resources', 'Contribute', 'WolfMark'])
  assert.deepEqual(groups.map(g => g.querySelectorAll('.wm-about-action').length), [2, 2, 2])
})

test('action and Ko-fi clicks call the host external opener with the exact URLs', async () => {
  const seen = []
  await withOsApi({ openExternal: async url => { seen.push(url); return true } }, async () => {
    const container = await boot()
    for (const action of container.querySelectorAll('.wm-about-action')) {
      await React.act(async () => { action.click() })
    }
    await React.act(async () => { container.querySelector('.wm-about-kofi').click() })
    await flush()
    assert.deepEqual(seen, [...ACTION_URLS, 'https://ko-fi.com/wolfmark'])
  })
})

test('clicks fall back to the desktop preload bridge when ctx.os lacks the door', async () => {
  const seen = []
  window.hermesDesktop = { openExternal: async url => { seen.push(url); return true } }
  try {
    const container = await boot()
    await React.act(async () => { container.querySelector('.wm-about-action').click() })
    await flush()
    assert.deepEqual(seen, [ACTION_URLS[0]])
  } finally {
    delete window.hermesDesktop
  }
})

test('a false OS result falls through to the preload bridge', async () => {
  const osSeen = []
  const bridgeSeen = []
  window.hermesDesktop = { openExternal: async url => { bridgeSeen.push(url); return true } }
  try {
    await withOsApi({ openExternal: async url => { osSeen.push(url); return false } }, async () => {
      const container = await boot()
      await React.act(async () => { container.querySelector('.wm-about-action').click() })
      await flush()
      assert.deepEqual(osSeen, [ACTION_URLS[0]])
      assert.deepEqual(bridgeSeen, [ACTION_URLS[0]])
    })
  } finally {
    delete window.hermesDesktop
  }
})

test('a throwing OS opener falls through to the preload bridge', async () => {
  const osSeen = []
  const bridgeSeen = []
  window.hermesDesktop = { openExternal: async url => { bridgeSeen.push(url); return true } }
  try {
    await withOsApi({ openExternal: async url => { osSeen.push(url); throw new Error('door slammed') } }, async () => {
      const container = await boot()
      await React.act(async () => { container.querySelector('.wm-about-action').click() })
      await flush()
      assert.deepEqual(osSeen, [ACTION_URLS[0]])
      assert.deepEqual(bridgeSeen, [ACTION_URLS[0]])
    })
  } finally {
    delete window.hermesDesktop
  }
})

test('clicks keep native navigation when no host door exists', async () => {
  const container = await boot()
  const link = container.querySelector('.wm-about-action')
  const event = new MouseEvent('click', { bubbles: true, cancelable: true })
  await React.act(async () => { link.dispatchEvent(event) })
  assert.equal(event.defaultPrevented, false)
})

test('the FAQ answers the cache-hit question with the shared formula, in both languages', async () => {
  for (const locale of ['en', 'zh']) {
    const container = await boot({ locale })
    const dict = T.I18N[locale]
    const entries = [...container.querySelectorAll('.wm-about-faq-section .wm-about-faq')]
    assert.equal(entries.length, 2, `${locale}: mismatch plus cache methodology`)
    const cache = entries[1]
    assert.equal(cache.open, false, `${locale}: the cache entry starts collapsed`)
    assert.equal(flat(cache.querySelector('summary')?.textContent), dict.aboutFaqCacheQ)
    assert.ok(flat(cache.textContent).includes(dict.usageCacheFormula),
      `${locale}: the FAQ carries the general methodology`)
  }
})
