// Hermes dashboard entry. The full interface is provided by the Desktop plugin.
(function () {
  const registry = window.__HERMES_PLUGINS__
  const React = window.__HERMES_PLUGIN_SDK__?.React
  if (!registry || !React) return
  registry.register('wolfmark-cost-ledger', function SpendSenseDashboard() {
    return React.createElement('p', null, 'Open Spend Sense in Hermes Desktop to view your usage.')
  })
})()
