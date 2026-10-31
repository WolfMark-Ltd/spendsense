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
const queryClient = { fetchQuery: async q => q.queryFn(), getQueryData: () => null }
const usePluginI18n = noop, useQuery = noop, useValue = noop
const jsx = noop, jsxs = noop
`
const body = src
  .replace(/import \{[^}]*\} from '@hermes\/plugin-sdk'\n/, stub)
  .replace(/import \{ useEffect \} from 'react'\n/, '')
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
    'Catalogue: $20.00/mo')
  assert.equal(T.feeLabel({ basis: 'no_plan', effective: {} }), 'No plan selected')
  assert.match(T.feeLabel({ basis: 'unpriced', effective: {} }), /no published price/)
  const declared = T.feeLabel({ basis: 'declared', effective: { amount: 17, currency: 'GBP', period: 'month' },
    published: { amount: 20, currency: 'USD' }, currency_comparable: true })
  assert.match(declared, /Your price: £17\.00\/mo/)
  assert.match(declared, /catalogue \$20\.00/)
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
  assert.equal(byId['weekly-credits'].reading, '$20.00 allowance')
  assert.equal(byId.monthly.reading, 'No reading')
  assert.equal(byId.monthly.stateLabel, 'not recorded')
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
  assert.equal(T.feesLabel(s), '$20.00/mo + £17.00/mo')
  assert.equal(T.feesLabel(T.membershipSummary([])), '—')
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
  assert.equal(T.planOptionLabel(choices[0]), 'ChatGPT Plus — $20.00/month')
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
