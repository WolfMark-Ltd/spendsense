/**
 * The `@hermes/plugin-sdk` stand-in used by the real-React membership harness.
 *
 * Unlike `test/preview-sdk.jsx` this is not a query re-implementation: `useQuery`,
 * `useQueryClient` and `queryClient` are the real TanStack Query 5.101.2 the
 * Desktop bundles, and the atoms are the real nanostores. What is faked is only
 * the app around it: the connection/profile atoms the host exposes and a
 * transport the test drives by hand.
 *
 * Bundled by `test/membership-scope.test.mjs` with esbuild, so the plugin runs
 * as one module graph with one copy of React.
 */
import { QueryClient } from '@tanstack/react-query'
import { atom, computed } from 'nanostores'
import { useSyncExternalStore } from 'react'
import { jsx } from 'react/jsx-runtime'

export { atom, computed }
export { useQuery, useQueryClient, QueryClientProvider } from '@tanstack/react-query'

/** One client for the plugin and the test's provider, so keys and cache agree. */
export const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, gcTime: Infinity } },
})

/** nanostores atom → React state, with real subscription semantics. */
export function useValue(store) {
  return useSyncExternalStore(
    cb => store.listen(cb),
    () => store.get(),
    () => store.get()
  )
}

/** The host's ambient scope atoms: switching these is switching backend. */
const connectionId = atom('gateway-a')
const profile = atom('default')
/** The host's gateway signal; it changes when an activation completes. */
const gateway = atom('connected')
export const hostRequests = []
export const host = {
  state: {
    connectionId,
    profile,
    gateway,
    focusedSessionId: atom(null),
    focusedStoredSessionId: atom(null),
    focusedUsage: atom(null),
    model: atom(''),
    focusedSessionProfile: profile
  },
  notify() {},
  navigate() {},
  async request(method, params = {}) {
    hostRequests.push({ method, params })
    return { models: {} }
  }
}
export { connectionId as $testConnectionId, profile as $testProfile }

/**
 * Activation generation: a real function, as the SDK exposes it — and, as in the
 * host, the gateway atom changes when the activation it describes completes.
 * `__bumpActivation` does both, so a test that bumps it exercises the same
 * signal path a reconnect does rather than only a number.
 */
let activationEpoch = 1
export function __bumpActivationQuiet() { activationEpoch += 1; return activationEpoch }
export const gatewayActivationEpoch = () => activationEpoch
export function __bumpActivation() {
  activationEpoch += 1
  gateway.set(`connected#${activationEpoch}`)
  return activationEpoch
}

/* ---- the rest of the SDK surface the plugin imports ---------------------- */

const noop = () => null
export const Badge = noop
export function Button({ children, size, variant, ...props }) {
  return jsx('button', { ...props, children })
}
export const Codicon = noop
export const SegmentedControl = noop
export const Tip = noop
export const cn = (...parts) => parts.filter(Boolean).join(' ')
export const usePluginI18n = () => (key) => key
