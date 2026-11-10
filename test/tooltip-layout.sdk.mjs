// Browser stub of @hermes/plugin-sdk for the tooltip layout test.
// Credential-free: host.request records any call (the test asserts none
// happen) and returns an empty answer; the plugin backend bridge is never
// registered, so no gateway or provider call is possible.
import { useSyncExternalStore } from 'react'
import { jsx } from 'react/jsx-runtime'

export const calls = (globalThis.__tooltipCalls = [])
export const navigations = (globalThis.__tooltipNavigations = [])
const atom = initial => {
  let value = initial
  const listeners = new Set()
  return {
    get: () => value,
    set: next => { value = next; for (const fn of listeners) fn(value) },
    listen: fn => { listeners.add(fn); return () => listeners.delete(fn) },
  }
}
export { atom }
export const computed = (stores, cb) => {
  const list = Array.isArray(stores) ? stores : [stores]
  return {
    get: () => cb(...list.map(s => s.get())),
    listen: fn => {
      const offs = list.map(s => (s.listen ? s.listen(fn) : () => {}))
      return () => offs.forEach(off => off())
    },
  }
}
export const useValue = store => useSyncExternalStore(fn => store.listen(fn), () => store.get())
export const gatewayActivationEpoch = () => 1
// Synthetic active session: invented tokens on a fake provider/model.
const session = atom('synthetic-session-1')
export const host = {
  state: {
    focusedSessionId: session,
    focusedStoredSessionId: atom(null),
    focusedUsage: atom({ input: 1200, output: 300, cache_read: 4800, cache_write: 120, calls: 2 }),
    model: atom('synthetic-model'),
    profile: atom('test'),
    focusedSessionProfile: atom('test'),
    gateway: atom('connected'),
    connectionId: atom('local'),
  },
  notify() {},
  navigate(target) { navigations.push(target) },
  async request(method, params = {}) {
    calls.push({ method, params })
    return { models: {} }
  },
  onEvent: () => () => {},
}
const noop = () => null
export const Badge = noop
export const Codicon = noop
export const SegmentedControl = noop
export const Tip = noop
export const cn = (...parts) => parts.filter(Boolean).join(' ')
export function Button({ children, ...props }) {
  return jsx('button', { ...props, children })
}
export const usePluginI18n = () => (key, ...args) => {
  if (typeof key === 'function') return ''
  const dict = globalThis.__tooltipDict
  if (dict && key in dict) {
    const entry = dict[key]
    if (typeof entry === 'function') {
      try { return entry(...args) } catch { return String(key) }
    }
    return entry
  }
  if (key === 'ratesNote') {
    return 'Rates come from the WolfMark catalogue card, not the provider’s invoice. Hermes may show a different estimate when its own route or peak/off-peak pricing differs.'
  }
  return args.length ? `${key}:${args.join(',')}` : String(key)
}
export const queryClient = { fetchQuery: async q => q.queryFn(), getQueryData: () => null, invalidateQueries() {} }
export const useQuery = () => ({ isLoading: false, isFetching: false, data: null })
