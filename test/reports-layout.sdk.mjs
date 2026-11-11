export * from './harness/real-sdk.mjs'

import { jsx, jsxs } from 'react/jsx-runtime'

export function SegmentedControl({ options, value, onChange }) {
  return jsxs('div', { className: 'wm-period-selector', role: 'tablist', children: options.map(option =>
    jsx('button', { type: 'button', role: 'tab', 'aria-selected': String(option.id) === String(value),
      onClick: () => onChange(option.id), children: option.label }, option.id)) })
}
