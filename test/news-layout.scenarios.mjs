/**
 * Model News page scenarios shared by both renderers.
 *
 * The Chromium layout page (`news-layout.page.jsx`) and the browserless
 * NewsPage tests (`news-render.test.mjs`) must reason about the SAME payloads:
 * a scenario that exists twice drifts, and a browserless replacement then
 * proves something the browser never rendered. The committed fixtures are
 * passed in (each renderer loads them its own way), and everything below is
 * pure data — no filesystem, no network, no clock.
 *
 * The scenarios were page-local until the Stage 3 assertion migration; their
 * identities are exported so a test can name a record without re-typing it.
 */

export const EVIDENCE_SHARED_ID = 'evidence-shared-event-1'
export const EVIDENCE_HIST_LOCAL_ID = 'evidence-hist-local-1'
export const EVIDENCE_HIST_CENTRAL_ID = 'evidence-hist-central-1'

/**
 * @param {{ realistic: object, variants: object }} fixtures parsed
 *   `test/fixtures/news/realistic.json` and `.../variants.json`.
 */
export function buildNewsScenarios({ realistic: REALISTIC, variants: VARIANTS }) {
  // --- evidence retention payload (page-local; never in the grid matrix) ----
  // 1) Same-ID local+central records: both items share ONE id, so the offer
  //    dedupes to exactly one event — but the two records stay distinguishable
  //    by source_url, observed_at, effective_at and provenance, and Details
  //    must keep BOTH recoverable.
  // 2) A proven distinct-ID pair (identical transition + the settled proof:
  //    same NONEMPTY source_url AND same NONEMPTY effective_at) collapsed into
  //    one event, which becomes HISTORY once a newer update lands in the same
  //    offer: the historical event must keep every original id, both source
  //    evidences, full timestamps, provenance, its exact previous/current
  //    rates and its raw tier rows recoverable.
  const evidenceSharedLocal = {
    id: EVIDENCE_SHARED_ID, origin: 'local', category: 'price_reduction',
    provider: 'evidenceco', model: 'ev-model',
    summary: 'ev-model (evidenceco) list price changed.',
    previous: { input: 2.0, output: 8.0, cache_read: 0.2, cache_write: 2.0 },
    current: { input: 1.5, output: 6.0, cache_read: 0.15, cache_write: 1.5 },
    observed_at: '2026-11-09T08:00:00Z', effective_at: '2026-11-08',
    source_url: 'https://announcements.spend-sense.example/feed/ev-shared-local',
    provenance: 'Synthetic local diff (evidence variant)', confidence: 'observed',
    relevance: { relevant: false, reasons: [] },
  }
  const evidenceSharedCentral = {
    ...evidenceSharedLocal,
    origin: 'central',
    observed_at: '2026-11-10T10:00:00Z', effective_at: '2026-11-09',
    source_url: 'https://announcements.spend-sense.example/feed/ev-shared-central',
    provenance: 'Synthetic central feed (evidence variant)', confidence: 'curated',
  }
  const EVIDENCE_HIST_RATES_PREV = { input: 2.04, output: 8.16, cache_read: 0.204, cache_write: 2.56 }
  const EVIDENCE_HIST_RATES_CUR = { input: 2.55, output: 10.2, cache_read: 0.255, cache_write: 3.2 }
  const evidenceHistTiers = rates => [{ type: 'standard', size: 250000, ...rates }]
  const evidenceHistLocal = {
    id: EVIDENCE_HIST_LOCAL_ID, origin: 'local', category: 'price_increase',
    provider: 'evidenceco', model: 'hist-model',
    summary: 'hist-model (evidenceco) list price changed.',
    previous: EVIDENCE_HIST_RATES_PREV, current: EVIDENCE_HIST_RATES_CUR,
    tiers_detail: 'known',
    tiers_before: evidenceHistTiers(EVIDENCE_HIST_RATES_PREV),
    tiers_after: evidenceHistTiers(EVIDENCE_HIST_RATES_CUR),
    observed_at: '2026-11-08T11:00:00Z', effective_at: '2026-11-07',
    source_url: 'https://announcements.spend-sense.example/feed/hist-pair',
    provenance: 'Synthetic local diff (history variant)', confidence: 'observed',
    relevance: { relevant: false, reasons: [] },
  }
  const evidenceHistCentral = {
    id: EVIDENCE_HIST_CENTRAL_ID, origin: 'central', category: 'price_increase',
    provider: 'evidenceco', model: 'hist-model',
    summary: 'hist-model (evidenceco) list price changed.',
    previous: EVIDENCE_HIST_RATES_PREV, current: EVIDENCE_HIST_RATES_CUR,
    tiers_detail: 'known',
    tiers_before: evidenceHistTiers(EVIDENCE_HIST_RATES_PREV),
    tiers_after: evidenceHistTiers(EVIDENCE_HIST_RATES_CUR),
    observed_at: '2026-11-08T09:30:00Z', effective_at: '2026-11-07',
    source_url: 'https://announcements.spend-sense.example/feed/hist-pair',
    provenance: 'Synthetic central feed (history variant)', confidence: 'curated',
    relevance: { relevant: false, reasons: [] },
  }
  const evidenceHistNewer = {
    id: 'evidence-hist-newer-1', origin: 'local', category: 'price_reduction',
    provider: 'evidenceco', model: 'hist-model',
    summary: 'hist-model (evidenceco) list price changed.',
    previous: EVIDENCE_HIST_RATES_CUR, current: { input: 1.0, output: 4.0, cache_read: 0.1, cache_write: 1.0 },
    observed_at: '2026-11-10T12:00:00Z',
    source_url: 'https://announcements.spend-sense.example/feed/hist-newer',
    provenance: 'Synthetic local diff (history variant)', confidence: 'observed',
    relevance: { relevant: false, reasons: [] },
  }
  const evidence = {
    ok: true,
    settings: { live_updates: true },
    catalogue: { source: 'models.dev cache (synthetic fixture)',
      as_of: '2026-11-09', snapshot_at: '2026-11-10T09:15:00Z' },
    providers_configured: [],
    impact_window_days: 30,
    local: {
      items: [evidenceSharedLocal, evidenceHistLocal, evidenceHistNewer],
      baseline: false, store_error: '', snapshot_at: '2026-11-10T09:15:00Z',
      removed_models: [], removed_model_count: 0, removed_plan_count: 0,
    },
    central: {
      state: 'fresh', items: [evidenceSharedCentral, evidenceHistCentral],
      fetched_at: '2026-11-10T06:40:00Z', error: '',
    },
    for_you_count: 0,
    impacts: {},
    signals: { configured_families: [], used_providers: [], used_models: [],
      plan_ids: [], plan_families: [] },
  }

  return {
    evidence,

    // The evidence pairs marked relevant, so the headline surface renders the
    // MERGED local/publish-side event — one change, two source records — and
    // Details can be checked for both.
    evmerged: {
      ...evidence,
      local: { ...evidence.local,
        items: evidence.local.items.map(item => ({ ...item,
          relevance: { relevant: true, reasons: [] } })) },
      central: { ...evidence.central,
        items: evidence.central.items.map(item => ({ ...item,
          relevance: { relevant: true, reasons: [] } })) },
    },

    // The same verified events with no plan/membership announcement, so the
    // Subscription Updates filter exercises the source-limitation path instead
    // of an empty-result message.
    noplan: {
      ...REALISTIC,
      local: { ...REALISTIC.local,
        items: REALISTIC.local.items.filter(item => item.category !== 'subscription') },
      central: { ...REALISTIC.central,
        items: REALISTIC.central.items.filter(item => item.category !== 'subscription') },
    },

    // A publisher-supplied briefing whose removals section carries a
    // history-confirmed record that exists nowhere in the archive's items.
    // That is the shape the client must render from the entry's own evidence
    // rather than from a joined record.
    published: {
      ...REALISTIC,
      central: {
        ...REALISTIC.central,
        briefing: {
          version: 1,
          generated_at: REALISTIC.central.fetched_at,
          sections: [
            { id: 'biggest_reductions', total: 1, entries: [{
              event_type: 'price_reduction',
              headline_code: 'news_head_single_rate',
              headline_params: { provider: 'openai', model: 'gpt-5.6-sol',
                rate: 'news_rate_input', pct: -50, before: '$2.5', after: '$1.25', direction: 'down' },
              headline: 'openai cuts gpt-5.6-sol input by 50% ($2.5 → $1.25 per 1M tokens)',
              provider: 'openai', model: 'gpt-5.6-sol', model_family: 'gpt-5.6-sol',
              observed_at: REALISTIC.central.fetched_at, confidence: 'observed',
              event_ids: [REALISTIC.local.items[0].id], personal: true,
            }] },
            { id: 'removals', total: 1, entries: [{
              event_type: 'removed_from_provider',
              headline_code: 'news_head_removed_from_provider',
              headline_params: { provider: 'acme', model: 'alpha',
                observations: 2 },
              headline: 'acme no longer lists alpha (confirmed across 2 catalogue observations)',
              provider: 'acme', model: 'alpha', model_family: 'alpha',
              observed_at: '2026-11-09T00:00:00Z', confidence: 'observed',
              source_url: 'https://models.dev/removals/rm-acme-alpha',
              event_ids: ['rm-acme-alpha'], personal: true,
            }] },
          ],
          counts: { events: 2 },
          unsupported: [],
        },
      },
    },

    // A publisher-supplied briefing that reports no plan-event source while
    // this archive DOES hold subscription events. The limitation must not
    // replace a populated result.
    //
    // The briefing carries a renderable section on purpose: a document whose
    // sections are all unrecognised is discarded before its `unsupported` list
    // is read, so without one the limitation could never fire and this case
    // would assert nothing. (It did not, until the assertion moved here.)
    plansource: {
      ...REALISTIC,
      central: { ...REALISTIC.central, briefing: { version: 1,
        generated_at: REALISTIC.central.fetched_at, counts: {},
        sections: [{ id: 'biggest_reductions', total: 1, entries: [{
          event_type: 'price_reduction', headline_code: 'news_head_single_rate',
          headline_params: { provider: 'openai', model: 'gpt-5.6-sol',
            rate: 'news_rate_input', pct: -50, before: '$2.5', after: '$1.25', direction: 'down' },
          headline: 'openai cuts gpt-5.6-sol input by 50% ($2.5 → $1.25 per 1M tokens)',
          provider: 'openai', model: 'gpt-5.6-sol', model_family: 'gpt-5.6-sol',
          observed_at: REALISTIC.central.fetched_at, confidence: 'observed',
          event_ids: [REALISTIC.local.items[0].id], personal: true,
        }] }],
        unsupported: [{ id: 'subscriptions', reason_code: 'news_unsupported_no_plan_events' }] } },
    },

    // A section whose cap trimmed a ninth entry. The omitted entry is not in
    // the payload, so the note may state the limit and the count but must not
    // claim where the missing entry can be found.
    capnote: {
      ...REALISTIC,
      central: { ...REALISTIC.central, briefing: { version: 1,
        generated_at: REALISTIC.central.fetched_at, unsupported: [], counts: {},
        sections: [{ id: 'removals', total: 9, entries: Array.from({ length: 8 }, (_, i) => ({
          event_type: 'removed_from_provider', headline_code: 'news_head_removed',
          headline_params: { provider: 'acme', model: `gone-${i}` },
          headline: `acme no longer lists gone-${i}`,
          provider: 'acme', model: `gone-${i}`, model_family: `gone-${i}`,
          observed_at: '2026-11-09T00:00:00Z', confidence: 'curated',
          source_url: 'https://builder.example/gone', event_ids: [`ghost-${i}`],
          personal: true,
        })) }] } },
    },

    // A family with two removal variants — one whose record the archive holds,
    // one that exists only in the published briefing — each with its OWN source
    // URL. Details must attribute each link to its provider.
    variantsources: {
      ...REALISTIC,
      central: { ...REALISTIC.central, briefing: { version: 1,
        generated_at: REALISTIC.central.fetched_at, unsupported: [], counts: {},
        sections: [{ id: 'removals', total: 1, entries: [{
          event_type: 'removed_from_provider', headline_code: 'news_head_removed',
          headline_params: { provider: 'acme', model: 'pair-model' },
          headline: 'acme no longer lists pair-model', provider: 'acme', model: 'pair-model',
          model_family: 'pair-model', family_label: 'Pair Model',
          observed_at: '2026-11-09T00:00:00Z', confidence: 'curated',
          provenance: 'publisher history (family head)',
          source_url: 'https://builder.example/family-head',
          personal: true,
          family_event_count: 2, event_ids: [REALISTIC.local.items[0].id],
          variants: [
            { event_type: 'removed_from_provider', headline_code: 'news_head_removed',
              headline_params: { provider: 'acme', model: 'pair-model' },
              headline: 'acme no longer lists pair-model', provider: 'acme', model: 'pair-model',
              observed_at: '2026-11-09T00:00:00Z', confidence: 'curated',
              provenance: 'publisher history (acme)',
              source_url: 'https://builder.example/acme-variant',
              event_ids: [REALISTIC.local.items[0].id] },
            { event_type: 'removed_from_provider', headline_code: 'news_head_removed',
              headline_params: { provider: 'zeta', model: 'pair-model' },
              headline: 'zeta no longer lists pair-model', provider: 'zeta', model: 'pair-model',
              observed_at: '2026-11-09T06:00:00Z', confidence: 'curated',
              provenance: 'publisher history (zeta)',
              source_url: 'https://builder.example/zeta-variant',
              event_ids: ['ghost-zeta'] },
          ],
        }] }] } },
    },

    // One headline whose model is the OLDEST of a long substring-matching set,
    // so its group sorts past the first page and has to be revealed before it
    // can be marked.
    manygroups: {
      ...REALISTIC,
      local: { ...REALISTIC.local, items: [...REALISTIC.local.items,
        { id: 'local-page-target', origin: 'local', category: 'price_reduction',
          provider: 'acme', model: 'pair-model',
          previous: { input: 2, output: 4 }, current: { input: 1, output: 2 },
          observed_at: '2026-11-09T00:00:00Z',
          source_url: 'https://models.dev/page-head', provenance: 'Synthetic target',
          confidence: 'observed', relevance: { relevant: false, reasons: [] } },
        ...Array.from({ length: 13 }, (_, i) => ({
          id: `local-page-${i}`, origin: 'local', category: 'price_increase',
          provider: 'acme', model: `pair-model-${i + 2}`,
          previous: { input: 1 + i, output: 2 + i }, current: { input: 2 + i, output: 4 + i },
          observed_at: `2026-11-11T${String((i % 9) + 1).padStart(2, '0')}:00:00Z`,
          source_url: 'https://models.dev/page', provenance: 'Synthetic page filler',
          confidence: 'observed', relevance: { relevant: false, reasons: [] },
        }))] },
      central: { ...REALISTIC.central, briefing: { version: 1,
        generated_at: REALISTIC.central.fetched_at, unsupported: [], counts: {},
        sections: [{ id: 'biggest_reductions', total: 1, entries: [{
          event_type: 'price_reduction', headline_code: 'news_head_single_rate',
          headline_params: { provider: 'acme', model: 'pair-model',
            rate: 'news_rate_input', pct: -50, before: '$2', after: '$1', direction: 'down' },
          headline: 'acme cuts pair-model input by 50% ($2 → $1 per 1M tokens)',
          provider: 'acme', model: 'pair-model', model_family: 'pair-model',
          observed_at: '2026-11-09T00:00:00Z', confidence: 'observed',
          source_url: 'https://models.dev/page-head', event_ids: ['local-page-target'],
          personal: true,
        }] }] } },
    },

    // One model family whose members sit on two providers. The headlined cut
    // belongs to `acme`, while `zeta` has a NEWER price rise, so the archive
    // sorts zeta's offer first and its matching cut is a History row inside
    // zeta's own (closed) panel. A link that marks every event in the family
    // would land on that hidden row.
    splitfamily: {
      ...REALISTIC,
      local: { ...REALISTIC.local, items: [...REALISTIC.local.items,
        { id: 'split-a', origin: 'local', category: 'price_reduction',
          provider: 'acme', model: 'split-model',
          previous: { input: 10, output: 20 }, current: { input: 5, output: 10 },
          observed_at: '2026-11-02T00:00:00Z',
          source_url: 'https://models.dev/split-a', provenance: 'Synthetic split A',
          confidence: 'observed', relevance: { relevant: true, reasons: [] } },
        { id: 'split-b-cut', origin: 'local', category: 'price_reduction',
          provider: 'zeta', model: 'split-model',
          previous: { input: 10, output: 20 }, current: { input: 6, output: 12 },
          observed_at: '2026-11-01T00:00:00Z',
          source_url: 'https://models.dev/split-b-cut', provenance: 'Synthetic split B cut',
          confidence: 'observed', relevance: { relevant: true, reasons: [] } },
        { id: 'split-b-rise', origin: 'local', category: 'price_increase',
          provider: 'zeta', model: 'split-model',
          previous: { input: 2, output: 4 }, current: { input: 3, output: 6 },
          observed_at: '2026-11-09T00:00:00Z',
          source_url: 'https://models.dev/split-b-rise', provenance: 'Synthetic split B rise',
          confidence: 'observed', relevance: { relevant: true, reasons: [] } },
      ] },
      central: { ...REALISTIC.central, briefing: null },
    },
  }
}
