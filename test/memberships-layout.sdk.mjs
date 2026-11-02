// Browser stub of @hermes/plugin-sdk for the memberships layout test.
// Same credential-free host as the tooltip stub, but useQuery executes the
// real queryFn (identity checks, envelope validation and all) against the
// synthetic transport registered by the page, so the real page renders.
import { useEffect, useState } from 'react'

export * from './tooltip-layout.sdk.mjs'

export const useQuery = (opts = {}) => {
  const [state, setState] = useState({ isLoading: true, isFetching: true, data: null, error: null })
  useEffect(() => {
    let live = true
    Promise.resolve().then(() => opts.queryFn()).then(
      data => { if (live) setState({ isLoading: false, isFetching: false, data, error: null, refetch: async () => {} }) },
      error => { if (live) setState({ isLoading: false, isFetching: false, data: null, error, refetch: async () => {} }) },
    )
    return () => { live = false }
  }, [])
  return state
}
