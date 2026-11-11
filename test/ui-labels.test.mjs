// Run: node --test --test-force-exit test/*.test.mjs
//
// Presentation regressions for the Token & Cost pane (0.2.4-ui-1):
// a missing `src_backend` translation rendered the raw key beside the price, the
// totals heading said "This session" while showing a conversation bucket, and the
// ≈ marker was applied to the exact input counter while the derived cache rows
// carried no `derived` tag at all.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'

const src = readFileSync(new URL('../desktop/plugin.js', import.meta.url), 'utf8')
const stub = `
const atom = v => { let s = v; return { get: () => s, set: n => { s = n }, listen: () => () => {} } }
const gatewayActivationEpoch = () => 1
const computed = (stores, cb) => {
  const list = Array.isArray(stores) ? stores : [stores]
  return { get: () => cb(...list.map(s => s.get())), listen: () => () => {} }
}
const noop = () => null
const Badge = noop, Button = noop, Codicon = noop, SegmentedControl = noop, Tip = noop
const cn = (...a) => a.filter(Boolean).join(' ')
const host = { state: { focusedSessionId: { get: () => null, listen: () => () => {} }, focusedStoredSessionId: { get: () => null, listen: () => () => {} }, profile: { get: () => '' }, focusedSessionProfile: { get: () => '' } }, notify() {}, navigate() {}, request: async () => null }
const useEffect = noop
const useRef = initial => ({ current: initial })
const queryClient = { fetchQuery: async q => q.queryFn(), getQueryData: () => null }
const usePluginI18n = noop, useQuery = noop, useValue = noop
const jsx = noop, jsxs = noop
`
const body = src
  .replace(/import \{[^}]*\} from '@hermes\/plugin-sdk'\n/, stub)
  .replace(/import \{[^}]*\} from 'react'\n/, '')
  .replace(/import \{ jsx, jsxs \} from 'react\/jsx-runtime'\n/, '')
globalThis.window = { location: { hash: '' }, addEventListener() {}, removeEventListener() {} }
const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'tcm-ui-'))
const file = join(dir, 'plugin.mjs')
writeFileSync(file, body)
const T = (await import(pathToFileURL(file).href)).__test

/** The host returns the key itself when a translation is missing. */
const rawT = (key, ...args) => {
  const entry = T.I18N.en[key]
  if (typeof entry === 'function') return entry(...args)
  return entry == null ? key : entry
}
const en = T.I18N.en
const zh = T.I18N.zh

const bucket = (over = {}) => ({
  input: 328_500, output: 57_100, cacheRead: 1_000_000, cacheWrite: 0,
  calls: 57, pricedTokens: 6_255_600, unpricedTokens: 0, cacheEstimated: true, ...over
})

test('cache coverage lines follow the chosen language', () => {
  const translator = language => (key, ...args) => {
    const entry = T.I18N[language][key]
    return typeof entry === 'function' ? entry(...args) : entry ?? key
  }
  const data = { input: 100, cacheRead: 100, cacheWrite: 0,
    cacheExactPrompt: 100, cacheEstimatedPrompt: 50 }
  assert.equal(T.cacheCoverageLine(translator('en'), .75, data),
    '75% of prompt tokens covered · 50% exact · 25% estimated')
  assert.equal(T.cacheCoverageLine(translator('zh'), .75, data),
    '提示词令牌覆盖率 75% · 精确 50% · 估算 25%')
  assert.equal(T.cacheCoverageLine(translator('en'), null, data), '',
    'unavailable coverage is omitted, not shown as 0%')
  assert.equal(T.cacheCoverageLine(translator('zh'), undefined, data), '')
  assert.equal(translator('zh')('cacheCoverageRange', 75), '缓存数据覆盖提示词令牌的 75%')
  for (const language of ['en', 'zh']) {
    for (const key of ['cacheCoverageUnavailable', 'cacheCoverageBasis', 'weightedCacheHit']) {
      assert.notEqual(translator(language)(key), key, `${language} has ${key}`)
    }
  }
})

test('every pricing-source fallback has a human label, never the raw key', () => {
  for (const origin of Object.keys(T.SOURCE_FALLBACKS)) {
    const label = T.sourceLabel(rawT, origin, null, false)
    assert.ok(label && !label.startsWith('src_'), `${origin} -> ${label}`)
    assert.notEqual(label, `src_${origin}`)
    // The English dictionary must own the string so it can be translated.
    assert.ok(en[`src_${origin}`], `missing en key src_${origin}`)
  }
})

test('backend rates read as an estimate, not a provider charge', () => {
  const label = T.sourceLabel(rawT, 'backend', null, false)
  assert.equal(label, 'Hermes backend estimate')
  assert.doesNotMatch(label, /reported|billed|invoice|charged/i)
  assert.equal(zh.src_backend, 'WolfMark 后端估算')
})

test('an unknown future origin is humanised rather than printed', () => {
  assert.equal(T.sourceFallback('route_card'), 'route card (estimate)')
  assert.equal(T.sourceLabel(rawT, 'route_card', null, false), 'route card (estimate)')
  assert.doesNotMatch(T.sourceLabel(rawT, 'route_card', null, false), /src_/)
})

test('a missing translation falls back to the human label, not the key', () => {
  const emptyT = key => key
  assert.equal(T.sourceLabel(emptyT, 'gateway', null, false), 'gateway-reported')
  assert.equal(T.sourceLabel(emptyT, 'backend', null, false), 'Hermes backend estimate')
  // Borrowed-rate warnings still go through the dictionary's function entries.
  assert.match(T.sourceLabel(rawT, 'foreign', 'zai', false), /borrowed from zai/)
})

test('the totals heading follows the bucket scope', () => {
  assert.equal(T.scopeTotalsTitle(rawT, true), 'Conversation totals')
  assert.equal(T.scopeTotalsTitle(rawT, false), 'This run’s totals')
  assert.equal(zh.scopeTotalsConversation, '对话总计')
  // "This session" must no longer label an all-runs conversation bucket.
  const b = bucket()
  const rows = T.tokenRows(rawT, b, false, null)
  assert.ok(rows.every(r => r.label !== 'This session'))
})

test('only derived cache fields carry ≈ and the derived tag', () => {
  const rows = T.tokenRows(rawT, bucket(), false, null)
  const byKey = Object.fromEntries(rows.map(r => [r.key, r]))
  assert.equal(byKey.i.value, '328.5k', 'exact input counter, unrounded by ≈')
  assert.doesNotMatch(byKey.i.value, /≈/)
  assert.equal(byKey.cr.value.startsWith('≈'), true)
  assert.match(byKey.cr.label, / · derived$/)
  assert.match(byKey.tt.label, /incl\. derived cache$/)
  assert.equal(byKey.tt.value.startsWith('≈'), true, 'the total carries an estimated cache component')
  assert.doesNotMatch(byKey.c.label, /≈/)
})

test('exact provider cache fields are shown without an estimate marker', () => {
  const rows = T.tokenRows(rawT, bucket({ cacheEstimated: false }), false, null)
  const byKey = Object.fromEntries(rows.map(r => [r.key, r]))
  assert.ok(rows.every(r => !r.value.includes('≈')))
  assert.doesNotMatch(byKey.cr.label, /derived/)
  assert.doesNotMatch(byKey.tt.label, /derived/)
})

test('a reconstructed cache write never reads as confirmed usage', () => {
  const rows = T.tokenRows(rawT, bucket({ cacheRead: 0, cacheWrite: 216_795 }), false, null)
  const cw = rows.find(r => r.key === 'cw')
  assert.ok(cw.value.startsWith('≈'))
  assert.match(cw.label, /derived/)
})

test('context is shown only when the gateway supplies it', () => {
  const withCtx = T.tokenRows(rawT, bucket(), true, { context_percent: 42, context_used: 84_000, context_max: 200_000 })
  assert.equal(withCtx.find(r => r.key === 'ctx').value, '42% · 84.0k/200.0k')
  assert.equal(T.tokenRows(rawT, bucket(), false, null).find(r => r.key === 'ctx'), undefined)
})

test('the rates note explains the differing estimate without claiming a charge', () => {
  assert.match(en.ratesNote, /not the provider’s invoice/i)
  assert.match(en.ratesNote, /peak|off-peak/i)
  assert.match(en.ratesNote, /different estimate/i)
  assert.ok(zh.ratesNote && !zh.ratesNote.startsWith('ratesNote'))
})

const RATES = { input: 0.15, output: 0.6, cache: 0.003, inputKnown: true, outputKnown: true, cacheKnown: true }

test('cache savings reconcile with the displayed rate card', () => {
  // Synthetic token counts keep the savings calculation reproducible.
  const live = T.liveSavings({ cacheRead: 1_000_000 }, RATES)
  const turn = T.liveSavings({ cacheRead: 2_000_000 }, RATES)
  assert.ok(Math.abs(live - 0.147) < 1e-6, String(live))
  assert.ok(Math.abs(turn - 0.294) < 1e-6, String(turn))
  for (const [read, value] of [[1_000_000, live], [2_000_000, turn]]) {
    assert.equal(value, (read * (RATES.input - RATES.cache)) / 1e6)
  }
})

test('savings ignore a stored value accumulated at other rates', () => {
  // hist.saved is recorded at whatever card applied then; beside a different
  // current card it would contradict the rates shown under it.
  const bucket = { cacheRead: 1_000_000, saved: 0.094 }
  assert.ok(Math.abs(T.liveSavings(bucket, RATES) - 0.147) < 1e-6)
  assert.equal(T.liveSavings(bucket, null), null)
  assert.equal(T.liveSavings(null, RATES), null)
})

test('savings are labelled as theoretical, not cash', () => {
  assert.match(en.cacheTitle, /cache/i)
  assert.equal(en.savedGauge, 'Net cache savings')
  // The wording must not imply a provider credit or recorded billing.
  assert.doesNotMatch(en.savedGauge, /refund|credit|billed|cash/i)
  // The compact gauge label leans on its tooltip for the methodology.
  assert.match(en.savingsInfo, /theoretical/i)
  assert.match(en.savingsInfo, /api-equivalent/i)
  assert.match(en.savingsInfo, /not a credit, refund or billed charge/i)
  assert.match(en.savingsInfo, /peak\/off-peak/i)
  assert.match(en.savingsInfo, /more or less than the input rate/i)
  assert.ok(zh.savingsInfo && !zh.savingsInfo.startsWith('savingsInfo'))
  assert.ok(zh.savedGauge && !zh.savedGauge.startsWith('savedGauge'))
  // A partial figure states its coverage and never borrows cash wording.
  assert.match(en.savedPartialNote(42), /42%/)
  assert.doesNotMatch(en.savedPartialNote(42), /cash|billed|charge|refund|credit/i)
  // The ledger keeps the self-explanatory label: it shows no tooltip.
  assert.match(en.savedTotal, /theoretical/i)
  assert.match(zh.savedTotal, /理论/)
})

test('composition shares split the prompt into fresh, read and write', () => {
  const shares = T.compositionShares({ input: 100, cacheRead: 300, cacheWrite: 100, output: 50 })
  assert.equal(shares.prompt, 500)
  assert.equal(shares.output, 50)
  assert.ok(Math.abs(shares.freshFrac - 0.2) < 1e-9)
  assert.ok(Math.abs(shares.readFrac - 0.6) < 1e-9)
  assert.ok(Math.abs(shares.writeFrac - 0.2) < 1e-9)
  assert.ok(Math.abs(shares.freshFrac + shares.readFrac + shares.writeFrac - 1) < 1e-9)
})

test('composition shares stay zero without prompt tokens', () => {
  for (const bucket of [null, undefined, {}, { input: 0, output: 9 }]) {
    const shares = T.compositionShares(bucket)
    assert.equal(shares.prompt, 0)
    assert.equal(shares.freshFrac, 0)
    assert.equal(shares.readFrac, 0)
    assert.equal(shares.writeFrac, 0)
  }
})

const stableLive = over => ({
  bucket: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, calls: 1 },
  cacheHitPct: 0, cost: 0.001, costSource: 'bundled', model: 'm', provider: 'p',
  rates: { input: 1, output: 2, cache: 0.5 }, usage: { input: 100 }, ...over
})

test('a live reading wins and is cached for its session', () => {
  const live = stableLive()
  const merged = T.mergeStableLive(null, live, 's1')
  assert.equal(merged.stale, false)
  assert.equal(merged.view, live)
  assert.equal(merged.cache.key, 's1')
  assert.equal(merged.cache.snapshot.cost, 0.001)
})

test('a transient gap shows the same-session reading as stale', () => {
  const first = T.mergeStableLive(null, stableLive(), 's1')
  const gap = T.mergeStableLive(first.cache, { ...stableLive(), bucket: null, usage: null }, 's1')
  assert.equal(gap.stale, true)
  assert.equal(gap.view.cost, 0.001)
  assert.equal(gap.view.model, 'm')
  assert.equal(gap.cache, first.cache)
})

test('a returning stream replaces the stale reading', () => {
  const first = T.mergeStableLive(null, stableLive(), 's1')
  const gap = T.mergeStableLive(first.cache, { ...stableLive(), bucket: null }, 's1')
  const back = T.mergeStableLive(gap.cache, stableLive({ cost: 0.002 }), 's1')
  assert.equal(back.stale, false)
  assert.equal(back.view.cost, 0.002)
  assert.equal(back.cache.snapshot.cost, 0.002)
})

test('a session switch never shows the previous reading', () => {
  const first = T.mergeStableLive(null, stableLive(), 's1')
  const switched = T.mergeStableLive(first.cache, { ...stableLive(), bucket: null, usage: null }, 's2')
  assert.equal(switched.stale, false)
  assert.equal(switched.view.bucket, null)
  assert.equal(switched.cache, null)
})

test('an empty session with no history stays empty', () => {
  const merged = T.mergeStableLive(null, { ...stableLive(), bucket: null, usage: null }, 's9')
  assert.equal(merged.stale, false)
  assert.equal(merged.view.bucket, null)
  assert.equal(merged.cache, null)
})

test('meter presence distinguishes live, recorded, updating and empty', () => {
  assert.equal(T.meterPresence(stableLive(), true), 'updating')
  assert.equal(T.meterPresence(stableLive(), false), 'live')
  assert.equal(T.meterPresence({ ...stableLive(), usage: null }, false), 'recorded')
  assert.equal(T.meterPresence({ ...stableLive(), usage: null, bucket: null }, false), 'empty')
  assert.equal(T.meterPresence(null, false), 'empty')
})

test('every sidebar string exists in English and Chinese', () => {
  const keys = ['meterLive', 'meterRecorded', 'meterUpdating', 'apiEquivalent', 'costSourceInfo',
    'totalTokens', 'promptMix', 'cacheFresh', 'cacheMethodInfo', 'exactLabel', 'estimatedLabel',
    'infoLabel', 'coverageLabel', 'savingsInfo', 'savedGauge']
  for (const key of keys) {
    assert.ok(en[key] && en[key] !== key, `en has ${key}`)
    assert.ok(zh[key] && zh[key] !== key, `zh has ${key}`)
  }
  assert.equal(typeof en.sinceDate, 'function')
  assert.equal(typeof zh.sinceDate, 'function')
  assert.equal(typeof en.partialShort, 'function')
  assert.equal(typeof zh.partialShort, 'function')
  assert.match(en.sinceDate('2026-10-31'), /2026-10-31/)
  assert.doesNotMatch(en.costSourceInfo, /invoice(?! may differ)/)
  assert.match(en.costSourceInfo, /may differ/)
})

test('the idle status-chip tooltip names SpendSense in both locales', () => {
  assert.equal(en.chipTipIdle, 'SpendSense — click for details')
  assert.equal(zh.chipTipIdle, 'SpendSense — 点击查看详情')
  for (const [language, dict] of [['en', en], ['zh', zh]]) {
    for (const key of ['chipTipIdle', 'navLabel', 'pageTitle']) {
      assert.doesNotMatch(String(dict[key]), /成本账本|Cost Ledger/,
        `${language} ${key} keeps the current brand`)
    }
  }
})

test('every ledger tab string exists in English and Chinese', () => {
  const keys = ['tabOverview', 'tabUsage', 'tabCosts', 'tabMemberships', 'tabReports', 'tabNews', 'tabSettings']
  for (const key of keys) {
    assert.ok(en[key] && en[key] !== key, `en has ${key}`)
    assert.ok(zh[key] && zh[key] !== key, `zh has ${key}`)
  }
  assert.deepEqual(keys.map(key => en[key]),
    ['Overview', 'Usage', 'Costs', 'Memberships', 'Reports', 'Model News', 'Settings'])
  assert.deepEqual(keys.map(key => zh[key]),
    ['总览', '用量', '费用', '会员', '报告', '模型动态', '设置'])
})

test('every costs string exists in English and Chinese', () => {
  const keys = ['costsPricing', 'costsPricingNoSource', 'costsPricingAge', 'costsPricingNoDate',
    'costsPricingStale', 'costsPricingTitle', 'costsTitle', 'costsSubtitle', 'costsMembershipTitle',
    'costsMembershipIntro', 'costsSavedMemberships', 'costsMembershipCount', 'costsCombinedFees',
    'costsLoading', 'costsBasisCatalogue', 'costsBasisCustom', 'costsBasisDeclared', 'costsBasisUnpriced',
    'costsEmpty', 'costsLegacyIgnored', 'costsEvidenceTitle', 'costsEvidenceIntro', 'costsEvidenceLoading',
    'costsFooterNote', 'costsEntAllowance', 'costsEntAllowances', 'costsEntRestricted', 'costsEntEffective',
    'costsEntAnyTime', 'costsEntOngoing', 'billEvProviderLabel', 'billEvProviderExplain', 'billEvProviderEmpty',
    'billEvApiLabel', 'billEvApiExplain', 'billEvApiEmpty', 'billEvCreditsLabel', 'billEvCreditsExplain',
    'billEvCreditsEmpty', 'billEvCashLabel', 'billEvCashExplain', 'billEvCashEmpty', 'billEvFeeLabel',
    'billEvFeeExplain', 'billEvFeeEmpty']
  for (const key of keys) {
    assert.ok(en[key] !== undefined && en[key] !== key, `en has ${key}`)
    assert.ok(zh[key] !== undefined && zh[key] !== key, `zh has ${key}`)
    assert.equal(typeof zh[key], typeof en[key], `${key} has the same shape`)
  }
  // The English composites keep their exact pre-localisation wording.
  assert.equal(en.costsPricing('WolfMark catalogue', '3 h old', ' · stale'),
    'Pricing: WolfMark catalogue · 3 h old · stale · sources and privacy')
  assert.equal(en.costsPricingAge(3), '3 h old')
  assert.equal(en.costsMembershipCount(2, 3), '2 of 3')
  assert.equal(en.costsLegacyIgnored(1),
    '1 old subscription arrangement(s) remain stored but are excluded. Choose each plan in Memberships to keep one authoritative record.')
  assert.equal(en.costsEntAllowances('Nightly $5.00'), 'plan allowances: Nightly $5.00 (usage in Memberships)')
  // The Chinese composites interpolate every argument.
  assert.match(zh.costsPricing('WolfMark 目录', '3 小时前', ' · 已过期'), /价格：/)
  assert.equal(zh.costsMembershipCount(2, 3), '2 / 3')
  assert.match(zh.costsEntEffective('2026-01-01', '持续有效'), /有效期/)
})

test('billing evidence and entitlement summaries follow the chosen language', () => {
  const translator = language => (key, ...args) => {
    const entry = T.I18N[language][key]
    return typeof entry === 'function' ? entry(...args) : entry ?? key
  }
  const rows = T.billingEvidence({ evidence: { provider_reported: { usd: 1 } } }, translator('zh'))
  assert.equal(rows[0].label, '供应商上报用量')
  assert.equal(rows[0].empty, '未记录')
  assert.equal(rows[0].usd, 1)
  assert.equal(rows[0].basis, 'none')
  const account = { plan: { entitlements: { windows: [{ id: 'w', label: 'Nightly', amount: 5, currency: 'USD' }] },
    model_restrictions: ['m1'], effective: { effective_from: '2026-01-01' } } }
  assert.equal(T.membershipEntitlementSummary(account),
    'plan allowances: Nightly · $5.00 allowance (usage in Memberships) · restricted models: m1 · effective 2026-01-01 to ongoing')
  assert.equal(T.membershipEntitlementSummary(account, translator('zh')),
    '方案额度：Nightly · $5.00 额度（用量见“会员”） · 受限模型：m1 · 有效期 2026-01-01 至 持续有效')
})

test('every advanced-rule string exists in English and Chinese', () => {
  const keys = ['advRulesErrNoDraft', 'advRulesErrName', 'advRulesErrProvider', 'advRulesErrKind',
    'advRulesErrUnknownFee', 'advRulesErrFeeNumber', 'advRulesErrAllowanceNumber', 'billErrConflict',
    'billErrValidation', 'billErrAuth', 'billErrUnavailable', 'billErrSave', 'billKindApi', 'billKindPrepaid',
    'billKindCustom', 'billKindUnknown', 'advRulesSaved', 'advRulesRemoved', 'advRulesTitle', 'advRulesIntro',
    'advRulesLegacy', 'advRulesAdd', 'advRulesRefreshing', 'advRulesRefresh', 'advRulesLoading',
    'advRulesCustomRate', 'advRulesModelAllowance', 'advRulesAllowance', 'advRulesNoAllowance', 'advRulesEdit',
    'advRulesDelete', 'advRulesEmpty', 'advRulesEditTitle', 'advRulesNewTitle', 'advRulesFieldName',
    'advRulesPhName', 'advRulesFieldLabel', 'advRulesPhOptional', 'advRulesFieldProvider', 'advRulesFieldModel',
    'advRulesFieldKind', 'advRulesFieldAllowance', 'advRulesFieldAllowanceModel', 'advRulesFieldCycleDay',
    'advRulesFieldFrom', 'advRulesFieldTo', 'advRulesFieldRateInput', 'advRulesFieldRateOutput',
    'advRulesFieldRateCache', 'advRulesEstimatesNote', 'advRulesSave', 'advRulesCancel']
  for (const key of keys) {
    assert.ok(en[key] !== undefined && en[key] !== key, `en has ${key}`)
    assert.ok(zh[key] !== undefined && zh[key] !== key, `zh has ${key}`)
    assert.equal(typeof zh[key], typeof en[key], `${key} has the same shape`)
  }
  // The English composites keep their exact pre-localisation wording.
  assert.equal(en.advRulesLegacy(2),
    '2 legacy subscription arrangement(s) are retained for reference and excluded from all fee totals. Choose those plans in Memberships.')
  assert.equal(en.advRulesCustomRate('$1.50', '$3.00'), 'Custom input $1.50 / output $3.00 per million tokens')
  assert.equal(en.advRulesModelAllowance('m', '$5.00'), 'm: $5.00 allowance')
  assert.equal(en.advRulesAllowance('$5.00'), '$5.00 allowance')
  // The Chinese composites interpolate every argument.
  assert.match(zh.advRulesLegacy(2), /2 个旧订阅安排/)
  assert.match(zh.advRulesCustomRate('$1.50', '$3.00'), /每百万令牌/)
  assert.match(zh.advRulesModelAllowance('m', '$5.00'), /额度/)
})

test('billing validators and errors follow the chosen language', () => {
  const translator = language => (key, ...args) => {
    const entry = T.I18N[language][key]
    return typeof entry === 'function' ? entry(...args) : entry ?? key
  }
  assert.deepEqual(T.profileDraftErrors({}, translator('zh')),
    ['需要填写简称。', '需要填写供应商线路。', '请选择该线路的付费方式。'])
  assert.deepEqual(T.profileDraftErrors(null, translator('zh')), ['无草稿'])
  assert.deepEqual(T.profileDraftErrors({}),
    ['A short name is required.', 'A provider route is required.', 'Choose how this route is paid for.'])
  assert.match(T.billingErrorMessage(new Error('conflict: stale'), translator('zh')), /重新加载/)
  assert.match(T.billingErrorMessage(new Error('boom'), translator('zh')), /后端日志/)
  assert.match(T.billingErrorMessage(new Error('conflict: stale')), /Reload, then save again/)
})

test('every settings string exists in English and Chinese', () => {
  const keys = ['tabListLabel', 'settingsNotifyPrefsReset', 'settingsNotifyPrefsFailed',
    'settingsNotifyDataCleared', 'settingsNotifyDataFailed', 'settingsNotifyModelsOk',
    'settingsNotifyModelsFailed', 'settingsNotifyCatalogueOk', 'settingsNotifyCatalogueFailed',
    'settingsNotifyLiveOff', 'settingsTitle', 'settingsSubtitle', 'settingsNavLabel', 'settingsPrivacyHeading',
    'settingsPrivacyP1', 'settingsPrivacyP2', 'settingsPrivacyP3', 'settingsPrivacyP4',
    'settingsPricingHeading', 'settingsPricingUnavailable', 'settingsPricingSourceLabel',
    'settingsPricingNoSource', 'settingsPricingDate', 'settingsPricingNoDate', 'settingsPricingAge',
    'settingsPricingStale', 'settingsPricingRefreshNote', 'settingsChecking', 'settingsRefreshPricing',
    'settingsCapturedCosts', 'settingsCatalogueFeed', 'settingsCatalogueLive', 'settingsCatalogueBundled',
    'settingsCatalogueVersion', 'settingsCatalogueGenerated', 'settingsCatalogueFetched',
    'settingsCatalogueFetchedAt', 'settingsCentralAlert', 'settingsCentralUpdate', 'settingsCentralHeldBack',
    'settingsCatalogueTotals', 'settingsRefreshCatalogue', 'settingsSourceRegister', 'settingsSourceNoDate',
    'settingsCatalogueProvenanceUnavailable', 'settingsModelsHeading', 'settingsModelsExplain',
    'settingsAutoRefreshToggle', 'settingsModelsConfirmText', 'settingsModelsConfirm', 'settingsCancel',
    'settingsRefreshModels', 'settingsDiagnosticsHeading', 'settingsDiagnosticsVersions',
    'settingsDiagnosticsBackend', 'settingsDiagnosticsChecking', 'settingsDiagnosticsNoBackend',
    'settingsHealthFailed', 'settingsHealthReady', 'settingsHealthUnavailable', 'settingsDiagnosticsRecent',
    'settingsDiagnosticsEmpty', 'settingsDiagnosticsNote', 'settingsRecoveryHeading',
    'settingsRecoveryPrefsExplain', 'settingsRecoveryPrefsConfirmText', 'settingsRecoveryPrefsConfirm',
    'settingsResetPrefs', 'settingsRecoveryDataExplain', 'settingsRecoveryBackupText',
    'settingsRecoveryDataConfirm', 'settingsCopyBackup', 'settingsAboutHeading', 'settingsAboutVersion',
    'settingsAboutCredit', 'settingsAboutSupport', 'settingsAboutContact', 'settingsLinkWolfmark',
    'settingsLinkRepo', 'settingsLinkBug', 'settingsLinkFeature', 'settingsLinkDocs',
    'settingsAboutLicenceHeading', 'settingsAboutLicenceText', 'settingsAboutCatalogueNote',
    'settingsPanePlacement']
  for (const key of keys) {
    assert.ok(en[key] !== undefined && en[key] !== key, `en has ${key}`)
    assert.ok(zh[key] !== undefined && zh[key] !== key, `zh has ${key}`)
    assert.equal(typeof zh[key], typeof en[key], `${key} has the same shape`)
  }
  // The English composites keep their exact pre-localisation wording.
  assert.equal(en.settingsCatalogueVersion('Live', '2026-11-04.3', ' · generated X'),
    'Live membership catalogue 2026-11-04.3 · generated X')
  assert.equal(en.settingsCentralAlert('stale', true),
    'Central catalogue: stale The cached live catalogue is shown.')
  assert.equal(en.settingsCatalogueTotals(58, 50, 5, 3),
    '58 plans · 50 verified prices · 5 provisional · 3 without a published fee')
  assert.equal(en.settingsAboutVersion('0.6.0'), 'SpendSense 0.6.0')
  // Proper names survive in both languages; the legal credit is identical.
  assert.match(en.settingsPrivacyP2, /models\.dev/)
  assert.match(zh.settingsPrivacyP2, /models\.dev/)
  assert.match(en.settingsAboutCredit, /WolfMark Ltd/)
  assert.match(en.settingsAboutCredit, /AFei/)
  assert.equal(zh.settingsAboutCredit, en.settingsAboutCredit)
  // The Chinese composites interpolate every argument.
  assert.match(zh.settingsCatalogueVersion('实时', '2026-11-04.3', ' · 生成于X'), /实时会员目录/)
  assert.match(zh.settingsCatalogueTotals(58, 50, 5, 3), /58 个方案/)
  assert.equal(zh.settingsAboutVersion('0.6.0'), 'SpendSense 0.6.0')
  // WP12: the subtitle scans operational-first, and the licence disclosure
  // names the exact distribution terms from NOTICE (GPL-3.0, no "or later").
  assert.match(en.settingsSubtitle, /Budgets, pricing, updates/)
  assert.match(zh.settingsSubtitle, /预算、价格、更新/)
  assert.match(en.settingsAboutLicenceText, /GPL-3\.0/)
  assert.match(en.settingsAboutLicenceText, /LICENSE/)
  assert.match(en.settingsAboutLicenceText, /Apache License 2\.0/)
  assert.match(zh.settingsAboutLicenceText, /GPL-3\.0/)
  assert.match(zh.settingsAboutLicenceText, /licenses\/Apache-2\.0\.txt/)
  // Support labels name destinations, never a response promise.
  for (const key of ['settingsLinkWolfmark', 'settingsLinkRepo', 'settingsLinkBug', 'settingsLinkFeature', 'settingsLinkDocs', 'settingsAboutContact']) {
    assert.doesNotMatch(en[key], /24\/7|guarantee|within .*hour/i)
  }
})

test('every usage panel string exists in English and Chinese', () => {
  const panelKeys = ['usageDonutAction', 'usageLegendInspectOther', 'usageLegendProviders',
    'usageLegendModels', 'usageLegendFilter', 'usageLegendInspectTitle', 'usageLegendApplyTitle',
    'usageDistTitle', 'usageDistSubtitle', 'usageSegDistribution', 'usageSegCost', 'usageSegTokens',
    'usageSegDistBy', 'usageSegModel', 'usageSegProvider', 'usageDistEmptyCost', 'usageDistEmptyTokens',
    'usageDistRemainder', 'usageDistFooterCost', 'usageDistFooterTokens', 'usageDistFooterWarn',
    'usageDistFooterNote', 'usageTrendPoint', 'usageTrendTitle', 'usageTrendPanelTitle', 'usageTrendSubtitle',
    'usageSegTrend', 'usageTrendAria', 'usageTrendHint', 'usageTrendUnstacked', 'usageTrendTotal',
    'usageTrendStream', 'usageTrendEmpty', 'usageTrendFooterCost', 'usageTrendFooterTokens', 'usageDelegBar',
    'usageDelegBarAria', 'usageDelegTitle', 'usageDelegSubtitle', 'usageSegDelegScope', 'usageSegAll',
    'usageSegParent', 'usageSegSubagents', 'usageDelegParent', 'usageDelegSubagents', 'usageDelegKnown',
    'usageDelegCache', 'usageDelegBusiest', 'usageDelegOpWorkers', 'usageDelegUnattributed', 'usageDelegNote',
    'usageDelegFooter', 'usageRankTitle', 'usageRankSubtitle', 'usageSegRankBy', 'usageSegHitRate',
    'usageSegVolume', 'usageRankAria', 'usageRankHint', 'usageRankRowAria', 'usageRankRowTitle',
    'usageRankRowSub', 'usageRankFooter', 'usageRankModeSavings', 'usageRankModeVolume', 'usageRankModeRate',
    'usageCompTitle', 'usageCompSubtitle', 'usageSegComposition', 'usageSegStacked', 'usageSegDoughnut',
    'usageDonutAllStreams', 'usageCompTokensTotal', 'usageCompAria', 'usageCompSvgPart', 'usageCompPartTitle',
    'usageCompSelect', 'usageCompFocus', 'usageCompNoteCacheRead', 'usageCompNoteCacheWrite',
    'usageCompNoteInput', 'usageCompNoteOutput', 'usageCompEmpty', 'usagePricingNone', 'usagePricingUnpriced',
    'usagePricingPartial', 'usagePricingFallback', 'usagePricingComplete', 'usageInsightDriver',
    'usageInsightDriverText', 'usageInsightVerdict', 'usageInsightVerdictLoss', 'usageInsightVerdictSave',
    'usageInsightDelegated', 'usageInsightDelegatedText', 'usageDelta', 'usageStreamInput', 'usageStreamOutput',
    'usageStreamCacheRead', 'usageStreamCacheWrite', 'usageOther', 'usageUnknown', 'usageUnknownModel',
    'usageUnknownProviderCap', 'usageSegColumns', 'usageSegCore', 'usageExplorerTitle', 'usageExplorerSubtitle',
    'usageExplorerTop25Tip', 'usageExplorerShowAllTip', 'usageExplorerTop25', 'usageExplorerShowAll',
    'usageExplorerExportTip', 'usageExplorerExport', 'usageExplorerBadge', 'usageExplorerCaption',
    'usageExplorerSortBy', 'usageExplorerSortLabel', 'usageColModel', 'usageColProvider', 'usageColCalls',
    'usageColTokens', 'usageColInput', 'usageColOutput', 'usageColReasoning', 'usageColRead', 'usageColWrite',
    'usageColCacheRate', 'usageColSavings', 'usageColApiCost', 'usageColPerCall', 'usageColPerMillion',
    'usageColPricing', 'usageColBilling', 'usageExplorerBillingTitle', 'usageExplorerCacheTitle',
    'usageExplorerPartial', 'usageExplorerUnitUnknown', 'usageExplorerPricingTitle', 'usageExplorerShowingAll',
    'usageExplorerShowingTop', 'usageExplorerFooter', 'usageEconTitle', 'usageEconSubtitle',
    'usageEconNoPricing', 'usageEconWritePremium', 'usageEconBenefit', 'usageEconNetSavings',
    'usageEconWithoutCache', 'usageEconWithCache', 'usageEconBarAria', 'usageEconExplainRates',
    'usageEconExplainNet', 'usageEconCoverage', 'usageEconExplainScope', 'usageFilterPeriod',
    'usageFilterPeriodTip', 'usagePeriodToday', 'usagePeriodWeek', 'usagePeriodMonth', 'usagePeriodQuarter',
    'usagePeriodYear', 'usageFilterModel', 'usageFilterModelName', 'usageFilterProvider',
    'usageFilterProviderName', 'usageFilterSurface', 'usageFilterSurfaceName', 'usageFilterTask',
    'usageFilterTaskName', 'usageFilterTip', 'usageFilterAll', 'usageFilterParentOp', 'usageFilterOpTip',
    'usageFilterAllOps', 'usageFilterWho', 'usageFilterDelegTip', 'usageFilterEveryone',
    'usageFilterDirectOnly', 'usageFilterSubagentsOnly', 'usageFilterAuxOnly', 'usageFilterUnattributedOnly',
    'usageFilterClear', 'usageFilterAdvanced', 'usageFilterActiveNote', 'usageFilterRemove', 'usageFilterChip',
    'usageFilterChipModel', 'usageFilterChipProvider', 'usageFilterChipSurface',
    'usageFilterChipTask', 'usageFilterChipParent', 'usageFilterChipScope',
    'usageFilterScopeDirect', 'usageFilterScopeSubagent', 'usageFilterScopeAuxiliary',
    'usageFilterScopeUnattributed',
    'usageGranDay', 'usageGranHour',
    'usageBaselineUnavailable', 'usageBaselineLoading', 'usageBaselineEstimateNote', 'usageBaselineTotals',
    'usageBaselineEmpty', 'usageLoadTitle', 'usageLoadStale', 'usageLoadFallback', 'usageRetryTip',
    'usageLoading', 'usageStatApiEquiv', 'usageKpiMoney', 'usageKpiActivity', 'usageStatApiExtra', 'usageStatSavings', 'usageStatSavingsHint',
    'usageStatSavingsExtra', 'usageStatTokens', 'usageStatTokensHint', 'usageStatTokensExtra',
    'usageStatCoverage', 'usageStatCoverageHint', 'usageInsightsAria', 'usageBillingTitle',
    'usageBillingLabel', 'usageBillingComplete', 'usageBillingPartial', 'usageBillingNote', 'usageWindowDash',
    'usageWindowPending', 'usageUnpricedAlert', 'usageEmptyTitle', 'usageEmptyBody',
    'usageEmptyShowDesktop', 'usageEmptyClear', 'usageNoData', 'usageRecordingLine', 'usageRecordingPending',
    'usageCacheFormula', 'usageMethodologyTitle', 'usageBaselineSummaryTitle']
  for (const key of panelKeys) {
    assert.ok(en[key] !== undefined && en[key] !== key, `en has ${key}`)
    assert.ok(zh[key] !== undefined && zh[key] !== key, `zh has ${key}`)
    assert.equal(typeof zh[key], typeof en[key], `${key} has the same shape`)
  }
  assert.equal(en.usageDonutAction(true, 'Input', '1K', '50%'), 'Inspect Input: 1K, 50%')
  assert.equal(en.usageTrendPoint('t', '$1', 0), 't: $1')
  assert.equal(en.usageRankFooter(8, 'weighted rate'),
    'Top 8 by weighted rate. Zero-cache older rows are ambiguous, not confirmed misses. Unknown is not zero. All models remain in the explorer.')
  assert.match(zh.usageCompFocus('输入', '1K', '50%', '注'), /占全部令牌的/)
  assert.equal(en.usageFilterAdvanced(0), 'Advanced filters')
  assert.equal(en.usageFilterAdvanced(2), 'Advanced filters · 2 active')
  assert.equal(zh.usageFilterAdvanced(0), '高级筛选')
  assert.equal(zh.usageFilterAdvanced(2), '高级筛选 · 2 项已选')
  assert.equal(en.usageLegendFilter('m', 'p'), 'Filter m via p')
  assert.equal(en.usageLegendFilter('m', 'p', '$1.00'), 'Filter m via p · $1.00')
  assert.equal(zh.usageLegendFilter('m', 'p', '1,000'), '按 m（经 p）筛选 · 1,000')
})

test('granularity and filter-chip labels translate while English stays identical', () => {
  const t = language => (key, ...args) => {
    const entry = T.I18N[language][key]
    return typeof entry === 'function' ? entry(...args) : entry ?? key
  }
  assert.equal(en.usageTrendSubtitle(en.usageGranDay, 'UTC'), 'Timestamped calls · day buckets · UTC')
  assert.equal(en.usageTrendSubtitle(en.usageGranHour, 'UTC'), 'Timestamped calls · hour buckets · UTC')
  assert.equal(zh.usageTrendSubtitle(zh.usageGranDay, 'UTC'), '带时间戳调用 · 日分桶 · UTC')
  assert.equal(zh.usageTrendSubtitle(zh.usageGranHour, 'UTC'), '带时间戳调用 · 小时分桶 · UTC')
  for (const [key, english, chinese] of [['model', 'model', '模型'], ['provider', 'provider', '供应商'],
      ['surface', 'surface', '位置'], ['task', 'task', '任务'], ['parent', 'parent', '父操作'],
      ['scope', 'scope', '范围']]) {
    assert.equal(T.usageFilterChipName(key, t('en')), english)
    assert.equal(T.usageFilterChipName(key, t('zh')), chinese)
  }
  assert.equal(T.usageFilterChipName('future', t('zh')), 'future')
  assert.equal(en.usageFilterChip(en.usageFilterChipModel, 'm1'), 'model: m1 ×')
  assert.equal(zh.usageFilterChip(zh.usageFilterChipModel, 'm1'), '模型：m1 ×')
  for (const [value, english, chinese] of [['direct', 'direct', '直接'], ['subagent', 'subagent', '子代理'],
      ['auxiliary', 'auxiliary', '辅助'], ['unattributed', 'unattributed', '未归属']]) {
    assert.equal(T.usageFilterChipValue('scope', value, t('en')), english)
    assert.equal(T.usageFilterChipValue('scope', value, t('zh')), chinese)
  }
  // Non-scope values are user data and pass through untouched.
  assert.equal(T.usageFilterChipValue('model', 'm1', t('zh')), 'm1')
  assert.equal(T.usageFilterChipValue('scope', 'future', t('zh')), 'future')
})

test('the unpriced note has no stray brace', () => {
  assert.equal(en.unpricedNote(5), '5 tokens had no known rate and are not in the total (shown as ≥).')
  assert.ok(!en.unpricedNote(5).includes('}'))
})

test('the InfoTip indicator is compact while its hit area stays accessible', () => {
  // The interactive box keeps its full size for pointer and keyboard users.
  assert.match(T.METER_CSS, /\.wm-info-btn\{[^}]*width:24px;height:24px/)
  // The visible ring is drawn smaller via a centred pseudo-element.
  assert.match(T.METER_CSS, /\.wm-info-btn::after\{[^}]*width:18px;height:18px/)
  assert.match(T.METER_CSS, /\.wm-info-btn::after\{[^}]*pointer-events:none/)
  // Hover and focus still recolour the ring; focus keeps its outline.
  assert.match(T.METER_CSS, /\.wm-info-btn:hover::after,\.wm-info-btn:focus-visible::after\{[^}]*border-color:var\(--wm-action\)/)
  assert.match(T.METER_CSS, /\.wm-info-btn:focus-visible\{[^}]*outline:2px solid var\(--wm-action\)/)
})

test('the meter stylesheet keeps popovers, ring and reduced-motion support', () => {
  assert.match(T.METER_CSS, /wm-info-pop/)
  assert.match(T.METER_CSS, /wm-info-pop-wide/)
  assert.match(T.METER_CSS, /wm-ring-value/)
  assert.match(T.METER_CSS, /wm-mix-fill/)
  assert.match(T.METER_CSS, /prefers-reduced-motion/)
  assert.match(T.METER_CSS, /wm-stale/)
})

test('the pane root class cannot collide with the analytics cache bar', () => {
  // .wm-meter is the analytics cache bar; the pane stylesheet is global
  // while the pane is mounted, so it must not style that class.
  assert.match(T.METER_CSS, /\.wm-pane\{/)
  assert.doesNotMatch(T.METER_CSS, /\.wm-meter[\s{]/)
})

test('every English string has a Chinese translation', () => {
  for (const key of Object.keys(en)) {
    assert.ok(zh[key] !== undefined && zh[key] !== key, `zh has ${key}`)
    assert.equal(typeof zh[key], typeof en[key], `${key} has the same shape`)
  }
})

test('every economics string exists in English and Chinese', () => {
  const keys = ['econTitle', 'econIntro', 'econMonthlySubs', 'econSubsSmall', 'econUsageLabel',
    'econNoPricedUsage', 'econTheoreticalPrice', 'econDiffLabel', 'econDiffHint', 'econGroupsTitle',
    'econNoComparison', 'econGroupHead', 'econAccountsTitle', 'econColAccount', 'econColMembership',
    'econColMonthly', 'econColDifference', 'econColCoverage', 'econTrendTitle', 'econOthersTitle',
    'econNoPricedUsageShort', 'econApiUsageMoney', 'econOutsideTitle', 'econUnknownRoutes',
    'econUnattributedLine', 'econAmbiguousLine', 'econFxTitle', 'econFxHint', 'econReading',
    'econStatusOk', 'econStatusPartial', 'econStatusUnavailable', 'econNoUsage', 'econNoPrice',
    'econCoverageUnknown', 'econFullyPriced', 'econNearlyAllPriced', 'econPricedPct', 'econSpanWindow', 'econSpanDays',
    'econPerMonth', 'econApiUsage', 'econFeesInWindow', 'econConvertedAt', 'econNoFee',
    'econPeriodAbbr', 'econFeeDeclared', 'econFeeCustom', 'econFeeCatalogue', 'econDue',
    'econRenewalUnknown', 'econUsageDetail', 'econNoPlan', 'econInWindow', 'econTrendEmpty',
    'econFlagProgress', 'econFlagRecording', 'econFlagPricing', 'econFlagAttribution', 'econNoFees', 'econTrendUsage',
    'econTrendAria', 'econTrendFeeTitle', 'econTrendUsageTitle', 'econOverviewLabel',
    'econOverviewError', 'econOverviewReading', 'econOverviewNone', 'econOverviewSmall',
    'fxReading', 'fxRetry', 'fxRateLine', 'fxRemove', 'fxEmpty', 'fxCurrency', 'fxUsdPlaceholder',
    'fxUsdUnit', 'fxRateDate', 'fxSourcePlaceholder', 'fxRateSource', 'fxAdd', 'fxSave', 'fxSaving',
    'fxStaged', 'fxSaved', 'fxReadError', 'fxErrConflict', 'fxErrSession', 'fxErrUnavailable',
    'fxErrRejected', 'fxErrSave']
  for (const key of keys) {
    assert.ok(en[key] !== undefined && en[key] !== key, `en has ${key}`)
    assert.ok(zh[key] !== undefined && zh[key] !== key, `zh has ${key}`)
    assert.equal(typeof zh[key], typeof en[key], `${key} has the same shape`)
  }
  // The English composites keep their exact pre-localisation wording.
  assert.equal(en.econSubsSmall('$38.77', 'in the last 30 days', 2, 'Complete'),
    '$38.77 in the last 30 days · 2 subscription(s) · Complete')
  assert.equal(en.econGroupHead('$20.00', '$19.37', '$2.00', 'Complete'),
    '$20.00/mo fees · $19.37 in window · $2.00 usage · Complete')
  assert.equal(en.econSpanDays(1), 'in the last 1 day')
  assert.equal(en.econSpanDays(30), 'in the last 30 days')
  assert.equal(en.econPeriodAbbr('month'), 'mo')
  assert.equal(en.econPeriodAbbr('year'), 'yr')
  assert.equal(en.econPeriodAbbr(undefined), undefined)
  assert.equal(en.econUnattributedLine('—', 'mystery', 'note.'), 'Unattributed: — on mystery. note.')
  assert.match(en.econIntro, /not cash saved/)
  assert.match(en.econDiffHint, /Not cash saved/)
  // The Chinese composites interpolate every argument.
  assert.match(zh.econSubsSmall('$38.77', '过去 30 天内', 2, '完成'), /2 个订阅/)
  assert.match(zh.econGroupHead('$20.00', '$19.37', '$2.00', '完成'), /\/月费用/)
  assert.equal(zh.econSpanDays(30), '过去 30 天内')
  assert.equal(zh.econPerMonth('$20.00'), '$20.00/月')
  assert.match(zh.econTrendAria('2026-10', '$20.00', '$2.00', '−$18.00'), /差值/)
  assert.match(zh.econIntro, /不是实际节省的现金/)
})

test('every allowance-weather string exists in English and Chinese', () => {
  const keys = ['wxTitle', 'wxAhead', 'wxOnTrack', 'wxBehind', 'wxExhausted', 'wxUnknown',
    'wxDaysLeft', 'wxElapsed', 'wxNoCycle', 'wxProviderShare', 'wxStaleReading',
    'wxProviderReset', 'wxManualMark', 'wxAllowance', 'wxCredits', 'wxPercentLimit',
    'wxLimitUnknown', 'wxUsedOf', 'wxObservedSpend', 'wxLowerBound', 'wxPace',
    'wxProjection', 'wxNoForecast', 'wxDetails', 'wxUnavailable', 'wxStale']
  for (const key of keys) {
    assert.ok(en[key] !== undefined && en[key] !== key, `en has ${key}`)
    assert.ok(zh[key] !== undefined && zh[key] !== key, `zh has ${key}`)
    assert.equal(typeof zh[key], typeof en[key], `${key} has the same shape`)
  }
  // The English composites keep their exact wording.
  assert.equal(en.wxDaysLeft(1), '1 day left in cycle')
  assert.equal(en.wxDaysLeft(12), '12 days left in cycle')
  assert.equal(en.wxUsedOf('$6.00', '$10.00'), '$6.00 of $10.00 used')
  assert.equal(en.wxProjection('2026-11-20'), 'At this pace, exhausted around 2026-11-20')
  // The Chinese composites interpolate every argument.
  assert.match(zh.wxDaysLeft(12), /12/)
  assert.match(zh.wxUsedOf('$6.00', '$10.00'), /\/ /)
  assert.match(zh.wxProjection('2026-11-20'), /2026-11-20/)
})

test('every membership string exists in English and Chinese', () => {
  const keys = Object.keys(en).filter(key => key.startsWith('mem'))
  assert.ok(keys.length > 100, `expected the mem family, found ${keys.length}`)
  for (const key of keys) {
    assert.ok(en[key] !== undefined && en[key] !== key, `en has ${key}`)
    assert.ok(zh[key] !== undefined && zh[key] !== key, `zh has ${key}`)
    assert.equal(typeof zh[key], typeof en[key], `${key} has the same shape`)
    if (typeof en[key] === 'string') {
      assert.match(en[key], /[A-Za-z]/, `${key} is English in en`)
      assert.match(zh[key], /[぀-ヿ㐀-䶿一-鿿豈-﫿]/u, `${key} is translated in zh`)
    }
  }
  const zhOnly = Object.keys(zh).filter(key => key.startsWith('mem') && !(key in en))
  assert.deepEqual(zhOnly, [])
  // The native-UAT findings, verbatim in both languages.
  assert.equal(en.memDiscover, 'Discover accounts')
  assert.equal(zh.memDiscover, '发现账户')
  assert.equal(en.memAccounts, 'Accounts')
  assert.equal(zh.memAccounts, '账户')
  assert.equal(en.memEditFee, 'Edit fee')
  assert.equal(zh.memEditFee, '修改费用')
  // Review corrections: period-neutral renewal day, defined (not remaining) allowance.
  assert.equal(zh.memRenewsDay, '续费日')
  assert.equal(zh.memWindowCredits, '额度数量（可选）')
})

test('whole-account exhaustion labels translate at display time', () => {
  const translator = language => (key, ...args) => {
    const entry = T.I18N[language][key]
    return typeof entry === 'function' ? entry(...args) : entry ?? key
  }
  const accountMark = { id: 'account', label: 'Account', scope: 'account',
    used_percent: 100, used_percent_from: 'manual', state: 'manual',
    basis: ['manual'], source: 'you',
    manual: { scope: { kind: 'account', id: 'account' }, status: 'active' } }
  const marked = {
    quota: { windows: [
      accountMark,
      { id: 'win-1', label: 'Nightly', scope: 'account', used_percent: 24,
        state: 'live', basis: ['provider_reported'] },
    ] },
    manual_exhaustions: [{ id: 'manual-1',
      scope: { kind: 'account', id: 'account', label: 'Account' } }],
  }
  const enRows = T.quotaRows(marked, Date.now(), translator('en'))
  const zhRows = T.quotaRows(marked, Date.now(), translator('zh'))
  assert.equal(enRows[0].label, 'Account')
  assert.equal(zhRows[0].label, '账户')
  assert.equal(enRows[0].accountMark, true)
  assert.equal(enRows[1].accountMark, false)
  // Window rows keep their stored provider labels in both languages.
  assert.equal(enRows[1].label, 'Nightly')
  assert.equal(zhRows[1].label, 'Nightly')
  // A label persisted in the other language never leaks through a switch.
  const legacyZh = { ...marked,
    quota: { windows: [{ ...accountMark, label: '账户' }] } }
  assert.equal(T.quotaRows(legacyZh, Date.now(), translator('en'))[0].label, 'Account')
  // A provider window keeps its own label even if its ID is account.
  const providerAccount = { id: 'account', label: 'Provider Account', scope: 'account',
    used_percent: 10, state: 'live', basis: ['provider_reported'], source: 'native' }
  const rows = T.quotaRows({ ...marked, quota: { windows: [providerAccount] } },
    Date.now(), translator('zh'))
  assert.equal(rows[0].label, 'Provider Account')
  assert.equal(rows[0].accountMark, false)
  // Without a translator the legacy neutral label renders as before.
  assert.equal(T.quotaRows(marked)[0].label, 'Account')
})

test('membership helpers follow the chosen language', () => {
  const translator = language => (key, ...args) => {
    const entry = T.I18N[language][key]
    return typeof entry === 'function' ? entry(...args) : entry ?? key
  }
  const enT = translator('en')
  const zhT = translator('zh')
  const declared = { basis: 'declared', effective: { amount: 17, currency: 'GBP', period: 'month' },
    published: { amount: 20, currency: 'USD' }, currency_comparable: true }
  assert.equal(T.feeLabel(declared, enT), 'Your price: £17.00/mo (catalogue $20.00)')
  assert.equal(T.feeLabel(declared, zhT), '你的价格：£17.00/月（目录 $20.00）')
  assert.equal(T.feeLabel({ basis: 'catalogue', effective: { amount: 20, currency: 'USD', period: 'month' } }, zhT),
    '目录价：$20.00/月')
  assert.equal(T.feeLabel({ basis: 'api_only', effective: {} }, zhT), '按量 API · 无固定会员费')
  const rows = T.quotaRows({ quota: { windows: [
    { id: 'w', label: 'Weekly', used_percent: 24, state: 'live', basis: ['provider_reported'] },
  ] } }, Date.now(), zhT)
  assert.equal(rows[0].reading, '已用 24%')
  assert.equal(rows[0].source, '供应商')
  assert.equal(rows[0].stateLabel, '实时')
  assert.equal(T.feesLabel({ byCurrencyPeriod: { 'USD/month': 20 } }, zhT), '$20.00/月')
  assert.equal(T.planOptionLabel({ name: 'Plus', price: { amount: 20, currency: 'USD', period: 'month' },
    verification: { status: 'verified' } }, zhT), 'Plus — $20.00/月')
  assert.match(T.planOptionLabel({ name: 'Teams', price: { amount: 30, currency: 'USD' },
    verification: { status: 'provisional' } }, zhT), /暂定/)
  assert.match(T.membershipErrorText(new Error('409 conflict'), 'write', zhT), /重新加载/)
  assert.match(T.feeDraftErrors({ amount: '', currency: 'USD', period: 'month', anchor_day: 1 }, zhT).join(' '),
    /金额/)
  assert.deepEqual(T.feeReasons({ vocabulary: { override_reasons: ['discount', 'other'] } }, zhT),
    [['discount', '折扣'], ['other', '其他']])
  // Unknown future reasons still fall back to the raw value.
  assert.deepEqual(T.feeReasons({ vocabulary: { override_reasons: ['time_travel'] } }, zhT),
    [['time_travel', 'time_travel']])
})

test('membership helpers default to the legacy English wording', () => {
  // No translator: the exact strings the pane rendered before localisation.
  assert.equal(T.feeLabel({ basis: 'catalogue', effective: { amount: 20, currency: 'USD', period: 'month' } }),
    'Catalogue: $20.00/mo')
  assert.equal(T.planOptionLabel({ name: 'Plus', price: { amount: 20, currency: 'USD' },
    verification: { status: 'verified' } }), 'Plus — $20.00/month')
  assert.equal(T.feesLabel({ byCurrencyPeriod: { 'USD/month': 20 } }), '$20.00/mo')
  assert.equal(T.quotaRows({ quota: { windows: [{ id: 'w', used_percent: 24 }] } })[0].reading, '24% used')
  assert.match(T.membershipErrorText(new Error('409 conflict'), 'write'), /changed since you loaded it/)
})

test('every digest string exists in English and Chinese', () => {
  const keys = ['reportsTitle', 'rpDays7', 'rpDays30', 'rpGenerate', 'rpGenerating',
    'rpCopy', 'rpCopied', 'rpSave', 'rpSaveFallback', 'rpFailed', 'rpError', 'rpRetry',
    'rpEmpty', 'rpStale']
  for (const key of keys) {
    assert.ok(en[key] !== undefined && en[key] !== key, `en has ${key}`)
    assert.ok(zh[key] !== undefined && zh[key] !== key, `zh has ${key}`)
    assert.equal(typeof zh[key], typeof en[key], `${key} has the same shape`)
  }
  assert.equal(en.reportsTitle, 'Reports')
  assert.match(zh.reportsTitle, /报告/)
  assert.match(zh.rpSaveFallback, /剪贴板/)
})

test('every PR28 generated-content key exists in English and Chinese', () => {
  const keys = ['newsImpactNoUsage', 'newsImpactNoRates',
    'newsSumNewProvider', 'newsSumNewModel', 'newsSumPriceChange',
    'newsVerbReduced', 'newsVerbChanged', 'newsSumNewPlan', 'newsSumPlanChange',
    'newsPlanFeeBit', 'newsPlanTermsChanged',
    'newsSumNewProviderFeed', 'newsSumNewModelFeed', 'newsSumPriceChangeFeed',
    'newsCondListingAccounts', 'newsCondTiersChanged', 'newsCondListingAnyAccount',
    'ovNoteWindow', 'ovNoteOptions', 'ovNotePrices', 'ovNoteErrors', 'ovNoteCache',
    'ovNoteFallback', 'ovNoteEconomics', 'ovNoteBilling', 'ovNotePrevious', 'ovNoteGap',
    'ovGapCallFailed', 'ovGapUsageMissing', 'ovGapCacheProvenance', 'ovGapRateUnavailable',
    'ovGapMissingBaseRate', 'ovGapMissingCacheRead', 'ovGapMissingCacheWrite',
    'usagePricingPartialCalls',
    'econHeadNoFees', 'econHeadUnpriced', 'econHeadIncomparable', 'econHeadPartial',
    'econHeadOk', 'econHeadFxError',
    'econGroupUnknownCurrency', 'econGroupUnpriced', 'econGroupNoFx',
    'econGroupMissing', 'econGroupPartial',
    'econUnattributed', 'econAmbiguous',
    'econExplApiOnly', 'econExplPrepaid', 'econExplUnconfirmed']
  for (const key of keys) {
    assert.ok(en[key] !== undefined && en[key] !== key, `en has ${key}`)
    assert.ok(zh[key] !== undefined && zh[key] !== key, `zh has ${key}`)
    assert.equal(typeof zh[key], typeof en[key], `${key} has the same shape`)
  }
  for (const map of [T.NEWS_CONDITION_KEYS, T.NEWS_IMPACT_REASON_KEYS,
      T.ANALYTICS_NOTE_KEYS, T.OV_GAP_REASON_KEYS, T.ECON_NOTE_KEYS, T.ECON_EXPLANATION_KEYS]) {
    for (const key of Object.values(map)) {
      assert.ok(en[key] !== undefined, `en has mapped ${key}`)
      assert.ok(zh[key] !== undefined, `zh has mapped ${key}`)
    }
  }
  // Catalogue-supplied plan notes have no catalogue: the raw note is the fallback.
  assert.equal(T.econExplanationText({ arrangement: 'subscription', explanation: 'Catalogue note stays English.' },
    (key, ...args) => zh[key] ?? key), 'Catalogue note stays English.')
})

test('seat billing explanations cover English and Simplified Chinese', () => {
  assert.match(en.memSeatTotal('$125.00', 'mo', 3, '$375.00'), /\$125\.00 per seat\/mo × 3 = \$375\.00/)
  assert.match(zh.memSeatTotal('$125.00', '月', 3, '$375.00'), /每席.*125.*3.*375/)
  assert.match(en.memSeatClear, /positive whole number/)
  assert.match(zh.memSeatClear, /正整数/)
  assert.match(zh.memSeatMinimum(2), /2/)
})
