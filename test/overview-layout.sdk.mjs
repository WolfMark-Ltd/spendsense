import { useEffect, useState } from 'react'
export * from './tooltip-layout.sdk.mjs'

export const usePluginI18n = () => (key, ...args) => {
  const value = globalThis.__overviewI18n?.[key]
  return typeof value === 'function' ? value(...args) : value ?? key
}

export const useQuery = (options = {}) => {
  const [state, setState] = useState({ isLoading: true, isFetching: true, data: null, error: null })
  useEffect(() => {
    let live = true
    Promise.resolve().then(() => options.queryFn()).then(
      data => { if (live) setState({ isLoading: false, isFetching: false, data, error: null, refetch: async () => {} }) },
      error => { if (live) setState({ isLoading: false, isFetching: false, data: null, error, refetch: async () => {} }) },
    )
    return () => { live = false }
  }, [])
  return state
}
