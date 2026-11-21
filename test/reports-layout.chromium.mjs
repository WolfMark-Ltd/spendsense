// Reports layout lifecycle.
//
// The shared implementation lives in `chromium-lifecycle.mjs`: the Reports
// suite and the Model News suite must run one reviewed owner of process and
// DevTools lifecycle, not two that can drift. This module keeps the Reports
// names and defaults its tests and docs already use.
export * from './chromium-lifecycle.mjs'
import { measureFixtureInContext } from './chromium-lifecycle.mjs'

// One Chromium root process serves every Reports combination, so the budget has
// to cover eight isolated contexts inside the runner's per-file 300s limit.
export const REPORTS_SUITE_BUDGET_MS = 240_000

const REPORTS_RESULT_EXPRESSION =
  'document.getElementById("reports-layout-result").textContent'

/** Measure one Reports combination in its own browser context. */
export function measureInBrowserContext(client, options = {}) {
  return measureFixtureInContext(client, {
    ...options,
    subject: 'Reports fixture',
    releaseLabel: 'Reports',
    resultExpression: REPORTS_RESULT_EXPRESSION,
    measurementLabel: 'Reports layout measurement',
  })
}
