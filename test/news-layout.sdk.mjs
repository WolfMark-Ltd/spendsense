// Browser stub of @hermes/plugin-sdk for the WP11 Model News layout harness.
// Credential-free host copied from the repo's tooltip/memberships/overview
// layout stubs; the plugin backend bridge never touches the network — `rest`
// is the synthetic transport the page registers.
import { useEffect, useState } from 'react'
import { jsx } from 'react/jsx-runtime'

export * from './tooltip-layout.sdk.mjs'

// Real queryFn execution (identity checks, envelope validation), so NewsPage
// renders its actual data path against the fixture transport. Query failures
// are recorded for the test's diagnostics.
export const useQuery = (opts = {}) => {
  const [state, setState] = useState({ isLoading: true, isFetching: true, data: null, error: null })
  useEffect(() => {
    let live = true
    Promise.resolve().then(() => opts.queryFn()).then(
      data => { if (live) setState({ isLoading: false, isFetching: false, data, error: null, refetch: async () => {} }) },
      error => {
        (globalThis.__newsQueryErrors = globalThis.__newsQueryErrors || [])
          .push(String(error && error.message || error))
        if (live) setState({ isLoading: false, isFetching: false, data: null, error, refetch: async () => {} })
      },
    )
    return () => { live = false }
  }, [])
  return state
}

// Real English/Chinese product copy from plugin.js's exported I18N tables.
// The page sets globalThis.__wp11Locale before each synchronous render; the
// plugin's own table keys are 'en' and 'zh' (not 'zh-CN').
export const usePluginI18n = () => (key, ...args) => {
  if (typeof key === 'function') return ''
  const locale = globalThis.__wp11Locale === 'zh-CN' ? 'zh' : (globalThis.__wp11Locale || 'en')
  const entry = globalThis.__wp11I18N?.[locale]?.[key]
  return typeof entry === 'function' ? entry(...args) : entry ?? key
}

// Hermes owns the real SegmentedControl; this approximation renders the same
// options with the same pressed-state semantics so the news scope control is
// present and switchable. It wraps instead of overflowing at 380px.
export function SegmentedControl({ options = [], value, onChange, 'aria-label': ariaLabel }) {
  return jsx('div', {
    className: 'wm-segments', role: 'group', 'aria-label': ariaLabel || 'segments',
    style: { display: 'flex', flexWrap: 'wrap', gap: 4, maxWidth: '100%' },
    children: options.map(option =>
      jsx('button', {
        type: 'button', 'aria-pressed': value === option.id,
        onClick: () => onChange(option.id),
        children: option.label,
      }, option.id)),
  })
}
