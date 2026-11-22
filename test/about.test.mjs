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
import { after, test } from 'node:test'
import { flat, loadPageHarness, translatorFor } from './render-harness.mjs'
import { overviewHealth } from './overview-fixtures.mjs'

const harness = await loadPageHarness()
const { T, React, ReactDOMClient, QueryClientProvider, queryClient, i18nBackend, plugin, dom, flush } = harness

plugin.register({
  rest: async path => {
    if (path === '/health') return overviewHealth(T.REQUIRED_BACKEND_CONTRACT)
    return { ok: true }
  },
  storage: { get: (_key, fallback) => fallback, set() {}, delete() {} },
  register() {}, registerMany() {}, onDispose() {}, onEvent: () => () => {},
  setTimeout: fn => { const timer = setTimeout(fn, 0); return () => clearTimeout(timer) },
  setInterval: () => () => {}, addEventListener: () => () => {},
  os: {}, pet: null, i18n: { register() {}, t: key => key },
})

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
  assert.equal(flat(container.querySelector('.wm-about-name')?.textContent), 'SpendSense 0.6.19')
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

test('more information keeps privacy, licence, credits and contact', async () => {
  const container = await boot()
  const more = container.querySelector('.wm-about-more')
  assert.deepEqual([...more.querySelectorAll('details > summary')].map(s => flat(s.textContent)),
    ['Why don’t my SpendSense figures match my provider’s usage or billing dashboard?',
      'Privacy', 'Licence & credits'])
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
  const replay = await boot()
  assert.equal(replay.querySelector('#about-faq').open, false, 'a satisfied request never replays itself')
})
