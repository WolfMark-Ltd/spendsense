// Reports DevTools transport.
//
// The client and the bounded poll live in the shared `chromium-lifecycle.mjs`
// so Model News runs the same reviewed transport. This module keeps the Reports
// entry points (and their message wording) unchanged.
export * from './chromium-lifecycle.mjs'
import { pollForValue } from './chromium-lifecycle.mjs'

export function pollForMeasurement(read, options = {}) {
  return pollForValue(read, { ...options, label: 'Reports layout measurement' })
}
