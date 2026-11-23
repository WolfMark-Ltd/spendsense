// Membership pane contract. Loads desktop/plugin.js with the host SDK stubbed
// and exercises the pure helpers behind `__test` — the same functions the
// rendered card calls, so a label or basis change fails here rather than only
// in a screenshot.
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
globalThis.__nav = []
globalThis.window = { location: { hash: '' }, addEventListener() {}, removeEventListener() {} }
const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'tcm-membership-'))
const file = join(dir, 'plugin.mjs')
writeFileSync(file, body)
const mod = await import(pathToFileURL(file).href)
const T = mod.__test

const account = (over = {}) => ({
  id: 'openai-codex:default', family: 'openai-codex', label: 'Account limits',
  credential_present: true, plan_id: null, plan_hint: 'Plus', fee_overrides: [], manual_exhaustions: [],
  usage_source: 'usage_api',
  fee: { basis: 'no_plan', effective: { amount: null, currency: null, period: null },
    published: null, override: null, currency_comparable: true },
  quota: { state: 'live', windows: [], account_exhausted: false, conflicts: [], notes: [] },
  plan_proposal: { plan_id: null, confidence: 'alias', label: 'Plus', requires_confirmation: true },
  ...over
})

test('the fee line always names its basis', () => {
  assert.equal(T.feeLabel({ basis: 'catalogue', effective: { amount: 20, currency: 'USD', period: 'month' } }),
    'Catalogue: USD 20.00/mo')
  assert.equal(T.feeLabel({ basis: 'no_plan', effective: {} }), 'No current plan')
  assert.match(T.feeLabel({ basis: 'unpriced', effective: {} }), /no published price/)
  const declared = T.feeLabel({ basis: 'declared', effective: { amount: 17, currency: 'GBP', period: 'month' },
    published: { amount: 20, currency: 'USD' }, currency_comparable: true })
  assert.match(declared, /Your price: GBP 17\.00\/mo/)
  assert.match(declared, /catalogue USD 20\.00/)
})

test('a currency-mismatched override does not imply a converted catalogue figure', () => {
  const line = T.feeLabel({ basis: 'declared', effective: { amount: 17, currency: 'GBP', period: 'month' },
    published: { amount: 20, currency: 'USD' }, currency_comparable: false })
  assert.doesNotMatch(line, /catalogue \$/)
})

test('a null fee is never rendered as zero', () => {
  assert.equal(T.fmtMoney(null, 'USD'), null)
  assert.equal(T.fmtMoney(undefined, 'GBP'), null)
  assert.equal(T.fmtMoney(0, 'USD'), '$0.00')
})

test('quota rows keep provider, manual and credit readings distinct', () => {
  const rows = T.quotaRows(account({
    quota: {
      state: 'live', account_exhausted: false, conflicts: [],
      windows: [
        { id: 'weekly', label: 'Weekly', scope: 'account', used_percent: 24, reset_at: '2026-11-04T14:16:38Z',
          state: 'live', basis: ['provider_reported'] },
        { id: 'session', label: 'Session', scope: 'account', used_percent: 100, used_percent_from: 'manual',
          state: 'manual', basis: ['manual'], manual: { status: 'active' } },
        { id: 'weekly-marked', label: 'Weekly marked', scope: 'account', used_percent: 100, used_percent_from: 'manual',
          state: 'manual', basis: ['provider_reported', 'manual'], manual: { status: 'active' } },
        { id: 'weekly-credits', label: 'Weekly credits', scope: 'account', used_percent: null, amount: 20,
          currency: 'USD', state: 'no_data', basis: ['none'] },
        { id: 'monthly', label: 'Monthly', scope: 'account', used_percent: null, state: 'no_data', basis: ['none'] }
      ]
    }
  }))
  const byId = Object.fromEntries(rows.map(r => [r.id, r]))
  assert.equal(byId.weekly.reading, '24% used')
  assert.equal(byId.weekly.source, 'Provider')
  assert.equal(byId.weekly.stateLabel, 'live')
  assert.equal(byId.session.reading, '100% used (you reported)')
  assert.equal(byId.session.source, 'You reported')
  assert.equal(byId.session.stateLabel, 'manual')
  assert.deepEqual(byId['weekly-marked'].basis, ['provider_reported', 'manual'],
    'the compact account summary can still see the provider basis under a manual state')
  assert.equal(byId['weekly-credits'].reading, 'USD 20.00 allowance')
  assert.equal(byId.monthly.reading, 'No reading')
  assert.equal(byId.monthly.stateLabel, 'not recorded')
})

test('compact allowance state distinguishes reported, partial, stale, manual and missing readings', () => {
  const en = (key, ...args) => {
    const entry = T.I18N.en[key]
    return typeof entry === 'function' ? entry(...args) : entry ?? key
  }
  const provider = state => ({ state, basis: ['provider_reported'] })
  const status = rows => T.membershipReadingStatus(rows, en)
  assert.deepEqual(status([]), { state: 'unreported', label: 'Unreported' })
  assert.deepEqual(status([provider('live')]), { state: 'reported', label: 'Reported' })
  assert.deepEqual(status([provider('live'), { state: 'no_data', basis: ['none'] }]),
    { state: 'partial', label: 'Partially reported' })
  assert.deepEqual(status([provider('stale')]), { state: 'stale', label: 'Stale reading' })
  assert.deepEqual(status([{ state: 'manual', basis: ['manual'] }]), { state: 'manual', label: 'Manual mark' })
  assert.deepEqual(status([
    { state: 'manual', basis: ['provider_reported', 'manual'] }, provider('live')
  ]), { state: 'manual', label: 'Manual mark' },
  'manual state does not hide provider evidence or make a fully reported account partial')
})

test('stale provider freshness survives a manual state on a provider-backed window', () => {
  const en = (key, ...args) => {
    const entry = T.I18N.en[key]
    return typeof entry === 'function' ? entry(...args) : entry ?? key
  }
  const staleQuota = {
    provider_state: 'stale',
    windows: [
      { id: 'weekly', state: 'manual', basis: ['provider_reported', 'manual'] },
      { id: 'session', state: 'manual', basis: ['manual'] }
    ]
  }
  const rows = T.quotaRows(account({ quota: staleQuota }), Date.now(), en)
  assert.equal(rows[0].providerState, 'stale')
  assert.deepEqual(T.membershipReadingStatus(rows, en),
    { state: 'stale', label: 'Stale reading' })

  const manualOnly = T.quotaRows(account({ quota: {
    provider_state: 'stale', windows: [{ id: 'session', state: 'manual', basis: ['manual'] }]
  } }), Date.now(), en)
  assert.deepEqual(T.membershipReadingStatus(manualOnly, en),
    { state: 'manual', label: 'Manual mark' },
    'provider freshness only overrides status when provider-backed rows exist')
})

test('Memberships provider names are display-only labels with a safe fallback', () => {
  const en = (key, ...args) => {
    const entry = T.I18N.en[key]
    return typeof entry === 'function' ? entry(...args) : entry ?? key
  }
  const zh = (key, ...args) => {
    const entry = T.I18N.zh[key]
    return typeof entry === 'function' ? entry(...args) : entry ?? key
  }
  assert.equal(T.membershipProviderLabel('anthropic', en), 'Anthropic')
  assert.equal(T.membershipProviderLabel('google-gemini', en), 'Google Gemini')
  assert.equal(T.membershipProviderLabel('openai-codex', en), 'OpenAI Codex')
  // F28: a route slug is named in words, never echoed to the reader.
  assert.equal(T.membershipProviderLabel('new-provider', en), 'new-provider',
    'the shared provider label still echoes an unmapped id for other screens')
  assert.equal(T.membershipFriendlyProvider('new-provider', en), 'New Provider',
    'Memberships names the same id in words')
  assert.equal(T.membershipFriendlyProvider('commandcode-anthropic', en), 'CommandCode (Anthropic route)')
  assert.equal(T.membershipFriendlyProvider('opencode-zen', en), 'OpenCode Zen')
  assert.equal(T.membershipAccountName({ family: 'commandcode-anthropic', label: 'commandcode-anthropic' }, en),
    'CommandCode (Anthropic route)')
  assert.equal(T.membershipAccountName({ family: 'anthropic', label: 'main' }, en), 'main',
    'a name the reader chose is kept')
  assert.equal(T.membershipIdentityLabel({ family: 'anthropic', label: 'Work' }, en), 'Anthropic · Work')
  assert.equal(T.membershipIdentityLabel({ family: 'openai-codex', label: 'openai-codex' }, en), 'OpenAI Codex')
  assert.equal(T.membershipIdentityLabel({ family: 'google-gemini', label: '工作室' }, zh), 'Google Gemini 服务 · 工作室')
  // A jump chip names the provider as well, so two "main" accounts stay
  // distinguishable and no chip is a bare route slug.
  assert.equal(T.membershipAccountShortcutLabel({ family: 'openai-codex', label: 'Personal' }, en), 'Personal',
    'a sentence keeps the short name')
  assert.equal(T.membershipAccountShortcutLabel({ family: 'commandcode-anthropic', label: 'commandcode-anthropic' }, en),
    'CommandCode (Anthropic route)', 'a slug is never the short name')
  assert.equal(T.membershipAccountShortcutLabel({ family: 'google-gemini', label: 'google-gemini' }, en), 'Google Gemini',
    'a raw provider slug is replaced by its name')
})

test('needs attention covers exhaustion, conflict, reconfirm, and missing plan or fee', () => {
  const items = T.needsAttention([
    account({ id: 'a', quota: { account_exhausted: true, conflicts: ['weekly'], windows: [] } }),
    account({ id: 'b', plan_id: 'x.y', fee: { basis: 'unpriced', effective: {} },
      quota: { windows: [{ id: 'w', label: 'W', scope: 'account', used_percent: null,
        state: 'manual', basis: ['manual'], manual: { status: 'reconfirm_due' } }] } })
  ])
  const text = items.map(i => i.text).join(' | ')
  assert.match(text, /Account marked exhausted/)
  const stale = T.needsAttention([account({ id: 'c', plan_id: 'x.plus',
    plan_reconfirmation: { required: true, reported_label: 'Pro' } })])
  assert.match(stale.map(i => i.text).join(' '), /Hermes now reports "Pro"/)
  assert.deepEqual(T.LEDGER_TABS.map(([id]) => id), ['overview', 'usage', 'costs', 'memberships', 'reports', 'news', 'settings', 'about'])
  assert.match(text, /disagrees with your manual mark on weekly/)
  assert.match(text, /no reliable reset time/)
  assert.match(text, /No fee set for the chosen plan/)
})

test('the summary never adds a non-USD fee into a USD total', () => {
  const s = T.membershipSummary([
    account({ fee: { basis: 'catalogue', effective: { amount: 20, currency: 'USD' } } }),
    account({ fee: { basis: 'declared', effective: { amount: 17, currency: 'GBP' } } }),
    account({ fee: { basis: 'no_plan', effective: { amount: null } } })
  ])
  assert.equal(s.total, 3)
  assert.equal(s.monthlyUsd, 20)
  assert.deepEqual(s.byCurrency, { USD: 20, GBP: 17 })
  // Both currencies are shown, never a converted total.
  assert.equal(T.feesLabel(s), 'USD 20.00/mo + GBP 17.00/mo')
  assert.equal(T.feesLabel(T.membershipSummary([])), '—')
})

test('membership prices name supported currencies and label unknown codes explicitly', () => {
  assert.equal(T.fmtMembershipMoney(12.5, 'GBP'), 'GBP 12.50')
  assert.equal(T.fmtMembershipMoney(12.5, null), 'Currency unknown 12.50')
  assert.equal(T.fmtMembershipMoney(12.5, 'ZZZ'), 'Currency unknown 12.50')
  assert.match(T.feeLabel({ basis: 'declared', effective: { amount: 12.5 } }), /Currency unknown 12\.50/)
  assert.deepEqual(T.membershipSummary([
    account({ fee: { effective: { amount: 12.5, period: 'month' } } })
  ]).byCurrencyPeriod, { 'UNKNOWN/month': 12.5 })
  assert.equal(T.feesLabel({ byCurrencyPeriod: { 'UNKNOWN/month': 12.5 } }), 'Currency unknown 12.50/mo')
  assert.equal(T.feeDraft(account({ fee: { effective: { amount: 12.5 } } })).currency, '')
  assert.equal(T.customPlanDraftFor({ id: 'owner' }).currency, '')
  assert.match(T.feeDraftErrors({ amount: '1', currency: 'ZZZ', period: 'month', anchor_day: 1 }).join(' '), /Pick a currency/)
})

test('plan choices come from the backend and mark provisional prices', () => {
  const plans = [
    { id: 'openai-codex.chatgpt-plus', name: 'ChatGPT Plus',
      price: { amount: 20, currency: 'USD' }, verification: { status: 'verified' } },
    { id: 'openai-codex.chatgpt-business', name: 'ChatGPT Business',
      price: { amount: 25, currency: 'USD' }, verification: { status: 'provisional' } },
    { id: 'openai-codex.chatgpt-enterprise', name: 'Enterprise',
      price: { amount: null }, verification: { status: 'unverified' } }
  ]
  const choices = T.accountPlanChoices({ plan_choices: plans })
  assert.equal(choices.length, 3)
  assert.equal(T.planOptionLabel(choices[0]), 'ChatGPT Plus — USD 20.00/month')
  assert.match(T.planOptionLabel(choices[1]), /provisional/)
  assert.match(T.planOptionLabel(choices[2]), /no fee set \(unpriced\)/)
  // A payload without the field must default to [], never undefined.map.
  assert.deepEqual(T.accountPlanChoices({}), [])
  assert.deepEqual(T.accountPlanChoices(null), [])
})

test('a plan that cannot serve the route is named, not hidden silently', () => {
  const note = T.excludedPlansNote({
    excluded_plans: [{ id: 'commandcode.go', name: 'Go', reasons: ['no Provider API access'] }]
  })
  assert.match(note, /Go is a real plan/)
  assert.match(note, /not cover this route/)
  assert.equal(T.excludedPlansNote({ excluded_plans: [] }), '')
  assert.equal(T.excludedPlansNote(null), '')
})

test('a provider plan string is a proposal, never a selection', () => {
  assert.match(T.proposalText(account()), /Hermes reports "Plus"/)
  assert.equal(T.proposalText(account({ plan_proposal: { confidence: 'none', label: 'Plus' } })), '')
  // A confirmed plan makes the suggestion stale.
  assert.equal(T.proposalText(account({ plan_id: 'openai-codex.chatgpt-plus' })), '')
  assert.equal(T.proposalText(account({ plan_proposal: null })), '')
})

test('the fee draft seeds from the override, then the catalogue, then blank', () => {
  const fromOverride = T.feeDraft(account({
    fee: { basis: 'declared', effective: { amount: 20, currency: 'USD', period: 'month' },
      override: { amount: 17, currency: 'GBP', period: 'month', reason: 'annual' } }
  }))
  assert.equal(fromOverride.amount, 17)
  assert.equal(fromOverride.currency, 'GBP')
  assert.equal(fromOverride.reason, 'annual')
  const fromCatalogue = T.feeDraft(account({
    fee: { basis: 'catalogue', effective: { amount: 20, currency: 'USD', period: 'month' }, override: null }
  }))
  assert.equal(fromCatalogue.amount, 20)
  assert.equal(T.feeDraft(account()).amount, '')
})

test('draft validation rejects the values the backend would reject', () => {
  const base = { amount: 10, currency: 'USD', period: 'month', anchor_day: 1 }
  assert.deepEqual(T.feeDraftErrors(base), [])
  assert.match(T.feeDraftErrors({ ...base, amount: '' }).join(' '), /Enter an amount/)
  assert.match(T.feeDraftErrors({ ...base, amount: -1 }).join(' '), /Enter an amount/)
  assert.match(T.feeDraftErrors({ ...base, currency: 'usd' }).join(' '), /Pick a currency/)
  assert.match(T.feeDraftErrors({ ...base, period: 'fortnight' }).join(' '), /Pick a billing period/)
  assert.match(T.feeDraftErrors({ ...base, anchor_day: 32 }).join(' '), /Billing day/)
})

test('saving a fee appends a revision and leaves the catalogue price alone', () => {
  const accountDoc = account({ fee_overrides: [{ id: 'old', amount: 19, currency: 'USD', period: 'month' }] })
  const before = JSON.parse(JSON.stringify(accountDoc))
  const override = T.overrideFromDraft(
    { amount: '17', currency: 'gbp', period: 'month', anchor_day: '12', effective_from: '2026-10-01', reason: 'annual' },
    accountDoc)
  assert.equal(override.amount, 17)
  assert.equal(override.currency, 'GBP')
  assert.equal(override.billing_cycle.anchor_day, 12)
  assert.equal(override.revisions, 2)
  assert.deepEqual(accountDoc, before, 'the account document must not be mutated in place')
})

test('restoring a catalogue fee deactivates the active override without adding a zero price', () => {
  const accountDoc = account({
    fee: { basis: 'declared', published: { amount: 20, currency: 'USD', period: 'month' },
      override: { revision_id: 'r2', amount: 17, currency: 'USD', period: 'month' } },
    fee_overrides: [
      { id: 'r1', amount: 18, currency: 'USD', period: 'month',
        effective_from: '2026-01-01T00:00:00Z', effective_to: '2026-09-01T00:00:00Z' },
      { id: 'r2', amount: 17, currency: 'USD', period: 'month',
        effective_from: '2026-09-01T00:00:00Z' }
    ]
  })
  const restored = T.restoreCatalogueFee(accountDoc, '2026-10-30T12:00:00Z')
  assert.equal(restored.length, 2)
  assert.equal(restored[0].amount, 18)
  assert.equal(restored[0].effective_to, '2026-09-01T00:00:00Z')
  assert.equal(restored[1].amount, 17)
  assert.equal(restored[1].effective_to, '2026-10-30T12:00:00Z')
  assert.equal(restored.some(entry => entry.amount === 0), false)
  assert.equal(accountDoc.fee_overrides[1].effective_to, undefined)
})

test('writes send a body object and no headers (ctx.rest boundary)', async () => {
  const calls = []
  const transport = async (path, opts = {}) => { calls.push({ path, opts }); return { ok: true } }
  await T.membershipWrite('PUT', '/membership/accounts/a', { plan_id: 'x.y' }, transport)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].path, '/membership/accounts/a')
  assert.equal(calls[0].opts.method, 'PUT')
  assert.equal(typeof calls[0].opts.body, 'object')
  assert.equal(calls[0].opts.headers, undefined)
  await T.membershipWrite('DELETE', '/membership/accounts/a/exhaustion/e1', null, transport)
  assert.equal(calls[1].opts.body, undefined)
})

test('a failure is classified before it is described', () => {
  // One status code is not one situation: a missing namespace, a missing record
  // and a broken store need different words, and none of them may claim "the
  // routes are missing" unless that is what happened.
  assert.equal(T.membershipErrorKind(new Error('409 conflict: stale')).kind, 'conflict')
  assert.equal(T.membershipErrorKind(new Error('422 Input should be a valid dictionary')).kind, 'validation')
  assert.equal(T.membershipErrorKind(new Error('404 {"detail":"Plugin not found"}')).kind, 'namespace')
  assert.equal(T.membershipErrorKind(new Error('404 {"detail":"no such membership"}')).kind, 'missing')
  assert.equal(T.membershipErrorKind(new Error('503 store_unreadable: bad')).kind, 'storage')
  assert.equal(T.membershipErrorKind(new Error('503 seat_write_uncertain: reload')).kind, 'seat_write_uncertain')
  assert.match(T.membershipErrorText(new Error('503 seat_write_uncertain: reload'), 'write'), /may have been saved.*Reload/)
  assert.equal(T.membershipErrorKind(new Error('401 Unauthorized')).kind, 'auth')
  assert.equal(T.membershipErrorKind(new Error('502 bad gateway')).kind, 'backend')
  assert.equal(T.membershipErrorKind(new Error('timeout after 15000ms')).kind, 'timeout')

  assert.match(T.membershipErrorText(new Error('409 conflict'), 'write'), /changed since you loaded it/)
  assert.match(T.membershipErrorText(new Error('422 bad'), 'write'), /not valid/)
  assert.match(T.membershipErrorText(new Error('404 {"detail":"Plugin not found"}'), 'read'),
               /not available on this connection and profile/)
  assert.match(T.membershipErrorText(new Error('404 {"detail":"no such membership"}'), 'write'),
               /no longer in the store/)
  assert.match(T.membershipErrorText(new Error('503 store_unreadable: x'), 'write'),
               /could not be read, so nothing was changed/)
  assert.doesNotMatch(T.membershipErrorText(new Error('404 {"detail":"Plugin not found"}'), 'read'),
                      /routes are missing/i)

  const detail = T.membershipErrorText(new Error('{"detail":[{"loc":["body"],"msg":"bad"}]}'), 'write')
  assert.doesNotMatch(detail, /[{}[\]"]/)
})

test('a malformed payload is a failure, not an empty list', () => {
  // Returning [] here is what made an unreadable answer look like "no
  // memberships"; the query wrapper turns the throw into a visible error.
  assert.throws(() => T.membershipAccounts(undefined), /malformed membership response/)
  assert.throws(() => T.membershipAccounts(null), /malformed membership response/)
  assert.throws(() => T.membershipAccounts({ accounts: 'nope' }), /malformed membership response/)
  assert.deepEqual(T.membershipAccounts({ accounts: [] }), [])
  assert.equal(T.membershipAccounts({ accounts: [{ id: 'a' }] }).length, 1)
})

test('the reason list only offers values the backend accepts', () => {
  // Mirrors membership.OVERRIDE_REASONS; the Python suite pins the served list
  // to the model, so a new reason must be added in both places deliberately.
  const served = ['discount', 'legacy_pricing', 'promotion', 'regional', 'catalogue_behind', 'annual_prepay', 'other']
  assert.deepEqual(T.OVERRIDE_REASON_FALLBACK, served)
  for (const value of served) {
    assert.ok(T.REASON_LABELS[value], `missing a label for ${value}`)
  }
  const fromCatalogue = T.feeReasons({ vocabulary: { override_reasons: served } })
  assert.deepEqual(fromCatalogue.map(([v]) => v), served)
  assert.equal(fromCatalogue[0][1], 'Discount')
  // A rejected value the old form offered must be gone.
  assert.ok(!fromCatalogue.some(([v]) => v === 'annual' || v === 'grandfathered'))
  assert.deepEqual(T.feeReasons(null).map(([v]) => v), served)
  assert.deepEqual(T.feeCurrencies({ vocabulary: { currencies: ['USD', 'GBP'] } }), ['USD', 'GBP'])
  assert.ok(T.feeCurrencies(null).includes('USD'))
})

test('an account with no published windows can still be marked exhausted', () => {
  assert.equal(T.ACCOUNT_SCOPE, '__account__')
  assert.equal(T.accountHolderMarked(account({ manual_exhaustions: [] })), false)
  assert.equal(T.accountHolderMarked(account({ manual_exhaustions: [
    { id: 'm1', scope: { kind: 'account', id: 'account' }, state: 'active' }] })), true)
  assert.equal(T.accountHolderMarked(account({ manual_exhaustions: [
    { id: 'm2', scope: { kind: 'account', id: 'account' }, state: 'cleared' }] })), false)
  assert.equal(T.accountHolderMarked(account({ manual_exhaustions: [
    { id: 'm3', scope: { kind: 'window', id: 'weekly' }, state: 'active' }] })), false)
})

test('the pane and its CSS are exported for the render harness', () => {
  assert.equal(typeof T.MembershipsPage, 'function')
  assert.equal(typeof T.MembershipCard, 'function')
  assert.match(T.MEMBERSHIP_CSS, /\.wm-quota/)
})

test('restoring the catalogue closes all overlapping fee overrides', () => {
 const item = account({fee:{override:{revision_id:'new'}},fee_overrides:[
   {id:'old',effective_from:'2026-01-01'}, {id:'new',effective_from:'2026-02-01'},
   {id:'future',effective_from:'2027-01-01'}]})
 const at = '2026-10-30T12:00:00Z'
 const result = T.restoreCatalogueFee(item, at)
 assert.equal(result[0].effective_to, at)
 assert.equal(result[1].effective_to, at)
 assert.equal(result[2].effective_to, undefined)
})

test('credit counts are not displayed as dollars', () => {
 const rows = T.quotaRows({quota:{windows:[{id:'weekly',limit:'credits',amount:10000,currency:null}]}})
 assert.equal(rows[0].reading, '10000 credits')
})

/* ---- WP20: a missing reading has a reason, and never a zero ----------- */

test('a reading is classified by why it exists, not only by whether it does', () => {
  const live = account({ quota: { provider_state: 'live', windows: [
    { id: 'weekly', label: 'Weekly', used_percent: 12, state: 'live', basis: ['provider_reported'] }] } })
  assert.equal(T.allowanceReadState(live, { native: true }).state, 'reported')

  const stale = account({ quota: { provider_state: 'stale', windows: [
    { id: 'weekly', label: 'Weekly', used_percent: 12, state: 'stale', basis: ['provider_reported'] }] } })
  assert.equal(T.allowanceReadState(stale, { native: true }).state, 'stale')

  // Nothing has been asked yet: the stored view only.
  const stored = account({ quota: { provider_state: 'absent', windows: [] } })
  assert.equal(T.allowanceReadState(stored, { native: false }).state, 'not_read')

  // Hermes answered and has no reading to give — a data limitation.
  const unsupported = account({ quota: { provider_state: 'absent', windows: [] },
    native_probe: { state: 'unsupported', reason: 'the hermes CLI is not on PATH' } })
  assert.equal(T.allowanceReadState(unsupported, { native: true }).state, 'unsupported')
  // "unavailable" covers no credential, no endpoint, a failed fetch and an
  // exhausted probe budget: it must not be presented as a permanent gap.
  const absentProbe = account({ quota: { provider_state: 'absent', windows: [] },
    native_probe: { state: 'unavailable', reason: 'no credential configured' } })
  assert.equal(T.allowanceReadState(absentProbe, { native: true }).state, 'no_reading')

  // The read itself failed: an error, not a limitation.
  const failed = account({ quota: { provider_state: 'absent', windows: [] },
    native_probe: { state: 'error', reason: 'usage read failed: TimeoutExpired' } })
  assert.equal(T.allowanceReadState(failed, { native: true }).state, 'failed')

  // Hermes answered for the wrong account: that reading is not applied.
  const mismatch = account({ quota: { provider_state: 'identity_mismatch', windows: [] } })
  assert.equal(T.allowanceReadState(mismatch, { native: true }).state, 'failed')

  // An anonymous reading for a named account keeps its own state (F119):
  // withheld, never misattributed, never a generic "not reported".
  const unverified = account({ quota: { provider_state: 'identity_unverified', windows: [] } })
  assert.equal(T.allowanceReadState(unverified, { native: true }).state, 'unverified')
  assert.equal(T.allowanceReadNoteKey('unverified'), 'memReadingNoteUnverified')

  // A real read that carried no windows is reported as empty, not as a limit.
  const empty = account({ quota: { provider_state: 'live', windows: [] } })
  assert.equal(T.allowanceReadState(empty, { native: true }).state, 'unreported')
})

test('the row chip names the limitation, and never reads as zero usage', () => {
  const chip = (over, native) => T.membershipReadingStatus([], undefined,
    { account: account(over), native })
  assert.equal(chip({ quota: { provider_state: 'absent', windows: [] } }, false).label, 'Unreported')
  assert.equal(chip({ quota: { provider_state: 'absent', windows: [] },
    native_probe: { state: 'unsupported' } }, true).label, 'Not available from Hermes')
  assert.equal(chip({ quota: { provider_state: 'absent', windows: [] },
    native_probe: { state: 'error' } }, true).label, 'Read failed')
  assert.equal(chip({ quota: { provider_state: 'absent', windows: [] },
    native_probe: { state: 'unsupported' } }, true).state, 'unsupported')
  assert.equal(chip({ quota: { provider_state: 'absent', windows: [] },
    native_probe: { state: 'unavailable', reason: 'no credential configured' } }, true).label,
    'No reading from Hermes', 'a read that returned nothing is not called permanent')
  assert.equal(chip({ quota: { provider_state: 'absent', windows: [] },
    native_probe: { state: 'unavailable' } }, true).state, 'no_reading')
  assert.equal(chip({ quota: { provider_state: 'identity_unverified', windows: [] } }, true).label,
    'Unverified reading', 'a withheld anonymous reading names itself')
  // Without context the previous contract is unchanged.
  assert.deepEqual(T.membershipReadingStatus([]), { state: 'unreported', label: 'Unreported' })
})

test('a window nobody reads says why, instead of “No reading”', () => {
  const base = { quota: { provider_state: 'absent', windows: [{ id: 'weekly', label: 'Weekly', state: 'no_data' }] } }
  const unsupported = T.quotaRows(account(base), Date.now(), undefined, { readState: 'unsupported' })[0]
  assert.equal(unsupported.reading, 'Not available from Hermes')
  assert.equal(unsupported.stateLabel, 'not available')
  const unreported = T.quotaRows(account(base), Date.now(), undefined, { readState: 'unreported' })[0]
  assert.equal(unreported.reading, 'Not reported by the provider')
  const failed = T.quotaRows(account(base), Date.now(), undefined, { readState: 'failed' })[0]
  assert.equal(failed.reading, 'Read failed')
  const unverified = T.quotaRows(account(base), Date.now(), undefined, { readState: 'unverified' })[0]
  assert.equal(unverified.reading, 'Withheld: unverified account')
  assert.equal(unverified.stateLabel, 'unverified')
  // Unchanged default for a caller that supplies no context.
  assert.equal(T.quotaRows(account(base))[0].reading, 'No reading')
  for (const row of [unsupported, unreported, failed, unverified]) {
    assert.doesNotMatch(row.reading, /0%|\$0\.00/, 'absence is never rendered as zero')
  }
})

test('a reading age keeps counting after the answer arrived', () => {
  const arrived = 1_000_000
  // Ten minutes old when the server answered, twenty minutes ago in real time.
  assert.equal(T.providerAgeSeconds({ age_seconds: 600 }, arrived, arrived + 600_000), 1200)
  assert.equal(T.providerAgeSeconds({ age_seconds: 0 }, arrived, arrived), 0)
  assert.equal(T.providerAgeSeconds({ age_seconds: 600 }, null, arrived + 600_000), 600,
    'an unknown arrival time leaves the server figure alone')
  assert.equal(T.providerAgeSeconds({ age_seconds: null }, arrived, arrived), null)
})

test('a provider reading states its own age, and absence states nothing', () => {
  assert.equal(T.readingAgeText({ age_seconds: 12 }), 'Provider reading from just now.')
  assert.equal(T.readingAgeText({ age_seconds: 600 }), 'Provider reading from 10 min ago.')
  assert.equal(T.readingAgeText({ age_seconds: 7200 }), 'Provider reading from 2 h ago.')
  assert.equal(T.readingAgeText({ age_seconds: null }), '')
  assert.equal(T.readingAgeText({}), '')
})

test('a refresh counts the accounts it could not read', () => {
  const list = [
    account({ id: 'a', native_probe: { state: 'ok' } }),
    account({ id: 'b', native_probe: { state: 'error' } }),
    account({ id: 'c', native_probe: { state: 'unsupported' } }),
    account({ id: 'd' }),
  ]
  assert.deepEqual(T.membershipReadFailures(list), { failed: 1, missing: 1, total: 4 })
  // A successful probe that answered for another account is still a bad read.
  const mismatched = [account({ id: 'e', native_probe: { state: 'ok' },
    quota: { provider_state: 'identity_mismatch', windows: [] } })]
  assert.equal(T.membershipReadFailures(mismatched).failed, 1)
  // A withheld anonymous reading counts as missing, never failed.
  const unverified = [account({ id: 'f', native_probe: { state: 'ok' },
    quota: { provider_state: 'identity_unverified', windows: [] } })]
  assert.deepEqual(T.membershipReadFailures(unverified), { failed: 0, missing: 1, total: 1 })
  assert.deepEqual(T.membershipReadFailures([]), { failed: 0, missing: 0, total: 0 })
})

test('a refresh notice keeps failures and empty reads apart', () => {
  const failures = T.membershipReadFailures([
    account({ id: 'ok', native_probe: { state: 'ok' } }),
    account({ id: 'boom', native_probe: { state: 'error' } }),
    account({ id: 'empty', native_probe: { state: 'unavailable' } }),
  ])
  // Both are reported, neither is called zero usage, and only the error is a
  // failure: "unavailable" also covers a route with no credential at all.
  assert.deepEqual(failures, { failed: 1, missing: 1, total: 3 })
  assert.match(T.I18N.en.memReadingsPartial(failures.failed, failures.total), /1 of 3 accounts could not be read/)
  assert.match(T.I18N.en.memReadingsNoReading(failures.missing, failures.total), /1 of 3 accounts returned no reading/)
})

test('a failed allowance-weather read is described by what failed', () => {
  assert.match(T.wxErrorText(new Error('request timeout after 15000ms')), /did not answer in time/)
  assert.match(T.wxErrorText(new Error('404 not found')), /does not serve allowance readings/)
  assert.match(T.wxErrorText(new Error('401 unauthorized')), /Sign in/)
  assert.match(T.wxErrorText(new Error('boom')), /unavailable/)
})

test('the Costs link selects the subscription-value destination', () => {
  T.$ledgerTab.set('memberships')
  T.openCostsValue()
  assert.equal(T.$ledgerTab.get(), 'costs')
})

// WP27: the four headline cards say what each figure actually measures.
test('the headline cards separate reviewed accounts from paid subscriptions', () => {
  const en = (key, ...args) => {
    const entry = T.I18N.en[key]
    return typeof entry === 'function' ? entry(...args) : entry ?? key
  }
  const list = [
    account({ id: 'paid', plan_id: 'anthropic.claude-max', effective_arrangement: 'subscription',
      fee: { basis: 'catalogue', effective: { amount: 100, currency: 'USD', period: 'month' } } }),
    account({ id: 'unpriced', plan_id: 'xai.supergrok', effective_arrangement: 'subscription',
      fee: { basis: 'unpriced', effective: { amount: null } } }),
    account({ id: 'free', plan_id: 'google-gemini.free', effective_arrangement: 'free_tier',
      fee: { basis: 'free_tier', effective: { amount: 0, currency: 'USD', period: 'month' } } }),
    account({ id: 'shared', effective_arrangement: 'included',
      fee: { basis: 'included', effective: { amount: null } } }),
    account({ id: 'prepaid', effective_arrangement: 'prepaid',
      fee: { basis: 'prepaid', effective: { amount: null } } }),
    account({ id: 'api', effective_arrangement: 'api_only',
      fee: { basis: 'api_only', effective: { amount: null } } }),
    account({ id: 'none', effective_arrangement: 'no_plan',
      fee: { basis: 'no_plan', effective: { amount: null } } }),
    account({ id: 'unknown', effective_arrangement: 'unconfirmed',
      fee: { basis: 'unconfirmed', effective: { amount: null } } }),
  ]
  const summary = T.membershipSummary(list)
  const cards = Object.fromEntries(T.membershipSummaryCards(summary, 2, true, null, en)
    .map(card => [card.kind, card]))
  assert.deepEqual(Object.keys(cards), ['reviewed', 'paid', 'attention', 'fees'])
  assert.equal(cards.reviewed.value, '8', 'every account is reviewed once')
  assert.equal(cards.paid.value, '2', 'free, included, prepaid, metered and no-plan are not paid')
  assert.equal(cards.reviewed.status, 'All arrangements')
  assert.match(cards.reviewed.note, /not subscribed/,
    'reviewed never reads as a subscription')
  assert.equal(cards.paid.status, '1 fee unknown',
    'a chosen plan with no amount is named, not counted as a zero fee')
  assert.equal(cards.paid.tone, 'attention')
  assert.equal(cards.attention.value, '2')
  assert.equal(cards.attention.status, 'Needs action')
  assert.equal(cards.attention.tone, 'attention')
  assert.deepEqual(cards.fees.value, ['USD 100.00/mo'],
    'the confirmed free tier adds a real zero; the unpriced plan adds no line')
  assert.equal(cards.fees.status, 'Declared')
  assert.equal(cards.fees.tone, 'declared')
  assert.match(cards.fees.note, /Not a bill/)
})

test('the headline cards never sum currencies and never invent a zero', () => {
  const en = (key, ...args) => {
    const entry = T.I18N.en[key]
    return typeof entry === 'function' ? entry(...args) : entry ?? key
  }
  const summary = T.membershipSummary([
    account({ id: 'usd', effective_arrangement: 'subscription', plan_id: 'p.usd',
      fee: { basis: 'declared', effective: { amount: 30, currency: 'USD', period: 'month' } } }),
    account({ id: 'gbp', effective_arrangement: 'subscription', plan_id: 'p.gbp',
      fee: { basis: 'declared', effective: { amount: 160, currency: 'GBP', period: 'month' } } }),
    account({ id: 'yearly', effective_arrangement: 'subscription', plan_id: 'p.year',
      fee: { basis: 'declared', effective: { amount: 120, currency: 'USD', period: 'year' } } }),
  ])
  const fees = T.membershipSummaryCards(summary, 0, true, null, en).find(card => card.kind === 'fees')
  assert.deepEqual(fees.value, ['USD 30.00/mo', 'GBP 160.00/mo', 'USD 120.00/yr'],
    'one line per currency and period, never a combined total')
  assert.equal(fees.status, 'Declared')
  // No recorded fee is "None recorded", distinct from an unknown amount.
  const empty = T.membershipSummaryCards(T.membershipSummary([]), 0, true, null, en)
    .find(card => card.kind === 'fees')
  assert.equal(empty.value, 'No fee amount recorded')
  assert.equal(empty.status, 'None recorded')
  assert.equal(empty.tone, 'neutral')
})

test('the headline cards state a pending or unreadable read without a duplicate chip', () => {
  const en = (key, ...args) => {
    const entry = T.I18N.en[key]
    return typeof entry === 'function' ? entry(...args) : entry ?? key
  }
  const summary = T.membershipSummary([account({ id: 'a', effective_arrangement: 'no_plan' })])
  const loading = T.membershipSummaryCards(summary, 0, false, null, en)
  assert.equal(loading[0].value, 'Loading…')
  assert.equal(loading[0].status, '', 'a loading card does not repeat the word in a chip')
  const failed = T.membershipSummaryCards(summary, 0, false, new Error('boom'), en)
  assert.equal(failed[0].value, 'Unavailable')
  assert.equal(failed[0].status, '')
  for (const card of [...loading, ...failed]) {
    assert.equal(card.tone, 'neutral', 'an unread figure claims no accent')
    assert.equal(card.note, '', 'an unread figure states no basis it cannot know')
  }
})

test('the four headline readings exist in both locales', () => {
  const keys = ['memSummaryReviewedStatus', 'memSummaryReviewedNote', 'memSummaryPaidStatus',
    'memSummaryPaidUnknown', 'memSummaryPaidNote', 'memSummaryAttentionOpen',
    'memSummaryAttentionClear', 'memSummaryAttentionNote', 'memSummaryFeesDeclared',
    'memSummaryFeesUnknown', 'memSummaryFeesNone', 'memSummaryFeesNote']
  for (const key of keys) {
    assert.ok(T.I18N.en[key], `${key} exists in English`)
    assert.ok(T.I18N.zh[key], `${key} exists in Chinese`)
    assert.notEqual(String(T.I18N.zh[key]), String(T.I18N.en[key]), `${key} is translated`)
  }
})
