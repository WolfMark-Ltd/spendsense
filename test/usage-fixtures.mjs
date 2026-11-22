/**
 * The Usage synthetic fixture, defined once.
 *
 * `usage-layout.page.jsx` renders it in Chromium and `usage-render.test.mjs`
 * renders it in jsdom. The payload carries every honesty path the page has:
 * priced rows, an unpriced row (index 27 loses its rate and its priced tokens),
 * missing cache-hit evidence, an unnamed provider, a negative cache saving and
 * partial coverage.
 *
 * Every value is invented — synthetic providers, synthetic models, round
 * figures. No credentials, no network, no production data.
 */

/**
 * The active filter set both renderers install: three slices, including a very
 * long model name so the chip row has to wrap, and a scope slice whose value is
 * a translated vocabulary term rather than user data.
 */
export const USAGE_FILTERS = {
  model: 'synthetic-very-long-model-name-for-narrow-width-wrapping-checks',
  provider: '', surface: 'telegram', task: '', parent: '', scope: 'subagent',
}

const row = (i = 0) => ({
  tokens: 120000 - i * 1500, calls: 140 - i, input_tokens: 24000, output_tokens: 12000,
  cache_read_tokens: 72000 - i * 1500, cache_write_tokens: 12000,
  cache_write_state: 'reported',
  list_usd: i === 27 ? null : 9.6 - i * 0.2,
  priced_tokens: i === 27 ? 0 : 120000 - i * 1500, unpriced_tokens: i === 27 ? 92000 : 150 * i,
  unpriced_calls: i % 9 === 0 ? 2 : 0, fallback_calls: i % 7 === 0 ? 1 : 0,
  cache_hit_rate: i === 27 ? null : 0.62 - i * 0.008,
  cache_known_calls: 90 - i, cache_unknown_calls: 12,
  billing_mix: i % 3 === 0 ? { api: 40 } : {},
  economics: { uncached_usd: 12 - i * 0.2, cached_usd: 8 - i * 0.2, savings_usd: i === 5 ? -0.4 : 3.2 - i * 0.06,
    savings_usd_high: null, savings_basis: 'exact', coverage: 0.82,
    read_benefit_usd: 4.2, read_benefit_basis: 'exact', read_benefit_calls: 96, read_benefit_tokens: 72000,
    covered_tokens: 98000, covered_calls: 96, excluded_calls: 8 },
})

export const usageByModel = () => Array.from({ length: 30 }, (_, i) => ({
  model: i === 0 ? 'synthetic-very-long-model-name-for-narrow-width-wrapping-checks' : `synthetic-model-${i}`,
  provider: i === 13 ? '' : `synthetic-provider-${i % 3}`,
  ...row(i),
}))

const totals = () => ({
  ...row(0), tokens: 3141592, calls: 1234, input_tokens: 640000, output_tokens: 320000,
  cache_read_tokens: 1900000, cache_write_tokens: 281592, list_usd: 82.4,
  cache_write_state: 'reported',
  priced_tokens: 3014592, unpriced_tokens: 127000, unpriced_calls: 6,
  cache_hit_rate: 0.61, cache_prompt_coverage: 0.66,
  billed_usd: 18.2, billed_complete: false, billing_mix: { api: 900, included: 300 },
})

export const usageAnalytics = () => {
  const byModel = usageByModel()
  const total = totals()
  return {
    ok: true,
    window: {
      since: '2026-11-04T00:00:00Z', until: '2026-11-11T00:00:00Z', days: 7,
      timezone: 'Europe/London', since_local: '2026-11-04T00:00:00+00:00', until_local: '2026-11-11T00:00:00+00:00',
    },
    totals: total,
    economics: total.economics,
    pricing_coverage: { coverage: 0.96 },
    previous: { comparable: true, deltas: { list_usd: 0.125, tokens: -0.042 } },
    options: {
      models: byModel.map(r => ({ model: r.model, provider: r.provider })),
      providers: ['synthetic-provider-0', 'synthetic-provider-1', 'synthetic-provider-2'],
      surfaces: ['cli', 'telegram'],
      tasks: ['main', 'aux'],
      operations: [
        { parent: 'synthetic nightly research sweep over many sources', subagent_calls: 42 },
        { parent: 'synthetic release triage', subagent_calls: 9 },
      ],
    },
    by_model: byModel,
    by_route: ['synthetic-provider-0', 'synthetic-provider-1', 'synthetic-provider-2']
      .map((provider, i) => ({ provider, ...row(i * 4) })),
    by_scope: [
      { scope: 'direct', ...row(1) },
      { scope: 'subagent', ...row(3) },
      { scope: 'auxiliary', ...row(6) },
    ],
    attribution: { child_sessions: 37, unattributed_calls: 5 },
    trend: {
      granularity: 'day',
      buckets: Array.from({ length: 7 }, (_, i) => ({
        ts: `2026-11-${String(i + 4).padStart(2, '0')}T00:00:00Z`,
        ts_local: `2026-11-${String(i + 4).padStart(2, '0')}T00:00:00+00:00`,
        input_usd: 1.1, output_usd: 0.9, cache_read_usd: 0.2, cache_write_usd: 0.1,
        ...row(i),
      })),
    },
    recording: { since: '2026-10-01T00:00:00Z', last: '2026-11-10T18:00:00Z', calls: 1234 },
    notes: ['Recorded calls only. Synthetic fixture note.'],
    note_codes: [],
  }
}

/** A `/health` body the bundle accepts as a complete pair. */
export const usageHealth = contract => ({
  ok: true, version: '0.6.17', rate_card: 'catalogue', db_present: true,
  event_db_present: true, event_db_status: 'ok',
  build: { contract, revision: '0'.repeat(40), desktop_sha256: '0'.repeat(64) },
})

/** The transport both renderers register: one mapping, one answer. */
export const usageTransport = ({ requiredContract } = {}) => async path => {
  if (String(path).startsWith('/analytics?')) return usageAnalytics()
  if (path === '/health') return usageHealth(requiredContract)
  return { ok: true }
}
