// Browser stub of @hermes/plugin-sdk for the WP09 Usage layout harness.
// Credential-free host copied from the repo's tooltip/news layout stubs; the
// plugin backend bridge never touches the network — `rest` is the synthetic
// transport the page registers.
import { useEffect, useState } from 'react'

export * from './tooltip-layout.sdk.mjs'

// Real queryFn execution (scope checks, envelope validation), so AnalyticsPage
// renders its actual data path against the fixture transport. Query failures
// are recorded for the test's diagnostics.
export const useQuery = (opts = {}) => {
  const [state, setState] = useState({ isLoading: true, isFetching: true, data: null, error: null })
  useEffect(() => {
    let live = true
    Promise.resolve().then(() => opts.queryFn()).then(
      data => { if (live) setState({ isLoading: false, isFetching: false, data, error: null, refetch: async () => {} }) },
      error => {
        (globalThis.__usageQueryErrors = globalThis.__usageQueryErrors || [])
          .push(String(error && error.message || error))
        if (live) setState({ isLoading: false, isFetching: false, data: null, error, refetch: async () => {} })
      },
    )
    return () => { live = false }
  }, [])
  return state
}

// Real English/Chinese product copy from plugin.js's exported I18N tables.
// The locale is fixed per Chrome run (?locale=) because React may defer the
// initial renders, so per-case globals would be read too late.
export const usePluginI18n = () => (key, ...args) => {
  if (typeof key === 'function') return ''
  const locale = globalThis.__usageLocale === 'zh-CN' ? 'zh' : (globalThis.__usageLocale || 'en')
  const entry = globalThis.__usageI18N?.[locale]?.[key]
  return typeof entry === 'function' ? entry(...args) : entry ?? key
}
