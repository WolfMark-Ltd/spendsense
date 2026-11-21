/**
 * Memberships page fixtures shared by the Chromium layout harness and the
 * browserless reading-state tests.
 *
 * The reading-state matrix is the product's core financial vocabulary: a
 * provider reading, a route Hermes cannot read, a failed read, a read that
 * returned nothing, a stored view nobody refreshed, a shared entitlement,
 * prepaid credits, a free tier, a metered account with no credential, and an
 * unconfirmed account. Both renderers must be looking at the same accounts, or
 * the browserless replacement proves something the browser never rendered.
 *
 * Pure data: no filesystem, no clock, no network.
 */
export const clarityAccounts = [
  // A successful provider reading, read ten minutes ago.
  { id: 'memb:reported', family: 'anthropic', label: 'main',
    billing_arrangement: 'subscription', effective_arrangement: 'subscription',
    plan_id: 'anthropic.claude-max', plan: { name: 'Claude Max 20x' },
    fee: { basis: 'catalogue', effective: { amount: 100, currency: 'USD', period: 'month' } },
    quota: { provider_state: 'live', age_seconds: 600, has_provider_reporting: true, windows: [
      { id: 'weekly', label: 'Weekly', used_percent: 24, state: 'live', scope: 'account',
        basis: ['provider_reported'] },
    ] },
    native_probe: { state: 'ok', reason: '' },
    manual_exhaustions: [], fee_overrides: [], plan_choices: [], excluded_plans: [],
    rev: 'r1', route_entitlement_rev: 'route-r1', credential_present: true },

  // Hermes answers, and has no allowance reading for this route.
  { id: 'memb:unsupported', family: 'commandcode-anthropic', label: 'commandcode-anthropic',
    billing_arrangement: 'subscription', effective_arrangement: 'subscription',
    plan_id: 'commandcode.goat', plan: { name: 'GOAT' },
    fee: { basis: 'catalogue', effective: { amount: 19.99, currency: 'EUR', period: 'month' } },
    quota: { provider_state: 'absent', age_seconds: null, has_provider_reporting: false, windows: [
      { id: 'daily', label: 'Daily allowance', used_percent: null, state: 'no_data', scope: 'account',
        basis: ['none'] },
    ] },
    native_probe: { state: 'unsupported', reason: 'the hermes CLI is not on PATH' },
    manual_exhaustions: [], fee_overrides: [], plan_choices: [], excluded_plans: [],
    rev: 'r1', route_entitlement_rev: 'route-r1', credential_present: true },

  // The provider read itself failed.
  { id: 'memb:failed', family: 'commandcode', label: 'goat',
    billing_arrangement: 'subscription', effective_arrangement: 'subscription',
    plan_id: 'commandcode.goat', plan: { name: 'GOAT' },
    fee: { basis: 'catalogue', effective: { amount: 10, currency: 'USD', period: 'month' } },
    quota: { provider_state: 'absent', age_seconds: null, has_provider_reporting: false, windows: [
      { id: 'five-hours', label: 'Five-hour window', used_percent: null, state: 'no_data',
        scope: 'account', basis: ['none'] },
    ] },
    native_probe: { state: 'error', reason: 'usage read failed: TimeoutExpired' },
    manual_exhaustions: [], fee_overrides: [], plan_choices: [], excluded_plans: [],
    rev: 'r1', route_entitlement_rev: 'route-r1', credential_present: true },

  // Hermes answered, but returned no reading: it cannot say which of
  // "no credential", "no endpoint" or "the fetch failed" applies.
  { id: 'memb:nohermes', family: 'xai', label: 'grok',
    billing_arrangement: 'subscription', effective_arrangement: 'subscription',
    plan_id: 'xai.supergrok', plan: { name: 'SuperGrok' },
    fee: { basis: 'unpriced', effective: { amount: null } },
    quota: { provider_state: 'absent', age_seconds: null, has_provider_reporting: false, windows: [
      { id: 'messages', label: 'Messages', used_percent: null, state: 'no_data',
        scope: 'account', basis: ['none'] },
    ] },
    native_probe: { state: 'unavailable', reason: 'no credential configured, no usage endpoint, or the fetch failed' },
    manual_exhaustions: [], fee_overrides: [], plan_choices: [], excluded_plans: [],
    rev: 'r1', route_entitlement_rev: 'route-r1', credential_present: true },

  // Nothing has been asked yet: the stored view only.
  { id: 'memb:stored', family: 'openai-codex', label: 'personal',
    billing_arrangement: 'unconfirmed', effective_arrangement: 'unconfirmed',
    plan_id: null, plan: null,
    fee: { basis: 'unconfirmed', effective: { amount: null } },
    quota: { provider_state: 'absent', windows: [] },
    manual_exhaustions: [], fee_overrides: [], plan_choices: [], excluded_plans: [],
    rev: 'r1', route_entitlement_rev: 'route-r1', credential_present: true },

  // Shared entitlement: no separate fee, and the owner is named.
  { id: 'memb:included', family: 'anthropic', label: 'shared',
    billing_arrangement: 'included', effective_arrangement: 'included',
    plan_id: null, plan: null,
    entitlement_owner_id: 'memb:reported',
    entitlement_owner: { id: 'memb:reported', label: 'main', family: 'anthropic' },
    fee: { basis: 'included', effective: { amount: null, currency: null, period: null } },
    quota: { provider_state: 'absent', windows: [] },
    manual_exhaustions: [], fee_overrides: [], plan_choices: [], excluded_plans: [],
    rev: 'r1', route_entitlement_rev: 'route-r1', credential_present: true },

  // Prepaid credits: no recurring fee.
  { id: 'memb:prepaid', family: 'openai', label: 'credits',
    billing_arrangement: 'prepaid', effective_arrangement: 'prepaid',
    plan_id: null, plan: null,
    fee: { basis: 'prepaid', effective: { amount: null } },
    quota: { provider_state: 'absent', windows: [] },
    manual_exhaustions: [], fee_overrides: [], plan_choices: [], excluded_plans: [],
    rev: 'r1', route_entitlement_rev: 'route-r1', credential_present: true },

  // A catalogue-listed free tier.
  { id: 'memb:free', family: 'google-gemini', label: 'free',
    billing_arrangement: 'subscription', effective_arrangement: 'free_tier',
    plan_id: 'google-gemini.free', plan: { name: 'Gemini Free' },
    fee: { basis: 'free_tier', effective: { amount: 0, currency: 'USD', period: 'month' } },
    quota: { provider_state: 'absent', windows: [] },
    manual_exhaustions: [], fee_overrides: [], plan_choices: [], excluded_plans: [],
    rev: 'r1', route_entitlement_rev: 'route-r1', credential_present: true },

  // Metered API with no credential left: configured in the store, not usable.
  { id: 'memb:nocred', family: 'deepseek', label: 'key',
    billing_arrangement: 'unconfirmed', effective_arrangement: 'api_only',
    plan_id: null, plan: null,
    fee: { basis: 'api_only', effective: { amount: null } },
    quota: { provider_state: 'absent', windows: [] },
    manual_exhaustions: [], fee_overrides: [], plan_choices: [], excluded_plans: [],
    rev: 'r1', route_entitlement_rev: 'route-r1', credential_present: false },
]

/**
 * The `/membership/accounts` response the clarity page renders. The `notes`
 * line is a raw backend message, so it also proves the page keeps provider
 * errors behind its technical details rather than in the normal view.
 */
export const clarityResponse = () => ({
  ok: true,
  accounts: clarityAccounts,
  store: { loaded: true, error: '' },
  notes: ['openai-codex: usage read failed (usage read failed: TimeoutExpired)'],
})
