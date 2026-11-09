// Browser stub used only by the Memberships layout regression and screenshot
// capture so that visual labels use the real English product copy.
export * from './memberships-layout.sdk.mjs'

export const usePluginI18n = () => (...args) => {
  if (typeof args[0] === 'function') return ''
  const translate = globalThis.__membershipTranslator
  if (typeof translate === 'function') return translate(...args)
  return args.length ? `${args[0]}:${args.slice(1).join(',')}` : String(args[0])
}
