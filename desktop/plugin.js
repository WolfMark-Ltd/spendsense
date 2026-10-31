/** Modified by WolfMark Ltd from Token & Cost Meter; see NOTICE and licenses/Apache-2.0.txt. */
/**
 * BUILD 0.2.4-ui-1 (branch fix/token-cost-ui-consistency): folds live
 * counters only from monotonic provider fields, so a derived cache estimate can
 * no longer re-adopt a whole run, and labels the conversation bucket it shows.
 * Candidate for private installation; installed builds are identified by hash.
 */
/**
 * token-cost-meter — live token usage + model-aware USD cost, with a
 * persistent local ledger that survives restarting Hermes.
 *
 * Live  : host.state.focusedUsage (streamed UsageStats, no RPC)
 * Prices: host.request('model.options', { session_id }) — scoped to the
 *         session whose usage is being priced, so a split tile never borrows
 *         another tile's provider. pricing[model] = {input,output,cache} as
 *         "$/Mtok" strings ("free", "" = unknown).
 * Ledger: ctx.storage (namespaced, app-level — shared by every profile). The
 *         gateway's in-memory counters reset on restart, so usage is folded
 *         into per-day buckets keyed by profile + provider + model, and the
 *         cost of every delta is SETTLED at the moment it is recorded, with
 *         the rate source that priced it. Re-pricing history at read time
 *         would make yesterday's total move whenever a catalog changes.
 */

import {
  atom,
  Badge,
  Button,
  cn,
  Codicon,
  computed,
  gatewayActivationEpoch,
  host,
  queryClient,
  SegmentedControl,
  Tip,
  usePluginI18n,
  useQuery,
  useValue
} from '@hermes/plugin-sdk'
import { useEffect } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const ID = 'spend-sense'
const PLUGIN_VERSION = '0.5.0'
const LEDGER_KEY = 'ledger.v2'
/** Pre-1.0 ledger. Migrated on first load and left untouched as a backup. */
const LEGACY_LEDGER_KEY = 'ledger.v1'
const LEDGER_VERSION = 2
/** Calendar days of per-day totals kept (by date, not by count). */
const KEEP_DAYS = 400
/** Per-session counter snapshots older than this are dropped. */
const SNAPSHOT_TTL_MS = 30 * 86_400_000
const MAX_SNAPSHOTS = 2000
/** Per-conversation totals kept for the side pane (newest by lastAt win). */
const MAX_SESSIONS = 1000
const CATALOG_STALE_MS = 10 * 60 * 1000
const M = 1_000_000
const LEDGER_ROUTE = '/spend-sense'
/** "All Hermes" backend windows. The API caps at 365 days. */
const RANGE_DAYS = { today: 1, week: 7, month: 30, all: 365 }
const VIEW_ALL = 'all'
const VIEW_DESKTOP = 'desktop'
const GROUPINGS = ['route', 'model', 'surface', 'task']

/* ------------------------------------------------------------------ utils */

/** "$3.00" | "3.00" | "free" | "" | "?" -> number ($ per 1M tokens) or null */
function parseRate(text) {
  if (text == null) return null
  const s = String(text).trim()
  if (!s || s === '?') return null
  if (s.toLowerCase() === 'free') return 0
  const n = Number.parseFloat(s.replace(/[$,\s]/g, ''))
  return Number.isFinite(n) && n >= 0 ? n : null
}

function fmtTokens(n) {
  const v = Number(n) || 0
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`
  return String(v)
}

function fmtUsd(v) {
  if (v == null || !Number.isFinite(v)) return '—'
  if (v === 0) return '$0.00'
  if (v < 0) return `−${fmtUsd(-v)}`
  if (v < 0.01) return `$${v.toFixed(4)}`
  if (v < 1) return `$${v.toFixed(3)}`
  return `$${v.toFixed(2)}`
}

/** Local calendar day, not UTC — "today" must mean the user's today. */
function dayKey(ts) {
  const d = ts != null ? new Date(ts) : new Date()
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** The local day `n` calendar days before `now` (DST-safe: no 86.4M ms math). */
function daysAgoKey(n, now) {
  const d = now != null ? new Date(now) : new Date()
  d.setDate(d.getDate() - n)
  return dayKey(d.getTime())
}

function num(v) {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : 0
}

function tokensOf(b) {
  return num(b.input) + num(b.output) + num(b.cacheRead) + num(b.cacheWrite)
}

function validRates(r) {
  return !!r && ['input', 'output', 'cache'].every(k => typeof r[k] === 'number' && Number.isFinite(r[k]) && r[k] >= 0)
}

/* ---------------------------------------------------------------- pricing */

/**
 * Bundled fallback rates, generated from the models.dev catalog by
 * scripts/gen-rates.py (the desktop plugin loader forbids relative imports,
 * so the table is inlined).
 *
 * WHY this exists: Hermes only fetches LIVE pricing for openrouter / nous /
 * ai-gateway / novita / deepinfra / fireworks / kilocode
 * (hermes_cli/models_pricing.py::_PRICING_FETCHERS). Every other provider —
 * notably subscription/OAuth routes like github-copilot — gets `pricing: {}`
 * in `model.options`.
 *
 * Shape: { providerId: { modelIdLowercase: [inUsdPerMtok, outUsdPerMtok, cacheReadUsdPerMtok?] } }
 */
const FALLBACK_RATES = /* @generated */ {"302ai":{"claude-fable-5":[10.0,50.0,1.0],"claude-fable-5-1":[10.0,50.0,0.25],"claude-haiku-4-5":[1.0,5.0,1.0],"claude-haiku-4-5-20251001":[1.0,5.0,1.0],"claude-haiku-5-5":[0.1,0.5,0.01],"claude-opus-4-1-20250805":[15.0,75.0,1.5],"claude-opus-4-1-20250805-thinking":[15.0,75.0,15.0],"claude-opus-4-5-20251101":[5.0,25.0,5.0],"claude-opus-4-7":[5.0,25.0,0.5],"claude-opus-4-7-thinking":[5.0,25.0,5.0],"claude-opus-4-8":[5.0,25.0,0.5],"claude-opus-5":[5.0,25.0,0.5],"claude-opus-5-5":[4.0,20.0,0.2],"claude-opus-5-thinking":[5.0,25.0,0.5],"claude-sonnet-4-5-20250929":[3.0,15.0,0.3],"claude-sonnet-4-5-20250929-thinking":[3.0,15.0,0.3],"claude-sonnet-4-6":[3.0,15.0,0.3],"claude-sonnet-4-6-thinking":[3.0,15.0,0.3],"claude-sonnet-5":[2.0,10.0,0.2],"claude-sonnet-5-5":[2.0,10.0,0.2],"deepseek-flash":[0.15,0.6,0.003],"deepseek-v3.2":[0.29,0.43,0.29],"deepseek-v3.2-thinking":[0.29,0.43,0.29],"doubao-seed-1-6-thinking-250715":[0.121,1.21,0.121],"doubao-seed-1-6-vision-250815":[0.114,1.143,0.114],"doubao-seed-1-8-251215":[0.1143,0.286,0.1143],"gemini-2.0-flash-lite":[0.075,0.3,0.075],"gemini-2.5-flash":[0.3,2.5,0.3],"gemini-2.5-flash-image":[0.3,30.0,0.3],"gemini-2.5-flash-lite-preview-09-2025":[0.1,0.4,0.1],"gemini-2.5-flash-nothink":[0.3,2.5,0.3],"gemini-2.5-flash-preview-09-2025":[0.3,2.5,0.3],"gemini-2.5-pro":[1.25,10.0,1.25],"gemini-3-flash-preview":[0.5,3.0,0.5],"gemini-3-pro-image-preview":[2.0,120.0,2.0],"gemini-3-pro-preview":[2.0,12.0,2.0],"gemini-3.1-flash-image-preview":[0.5,60.0,0.5],"gemini-3.1-flash-lite":[0.25,1.5,0.03],"gemini-3.1-flash-lite-preview":[0.25,1.5,0.25],"gemini-3.1-pro-preview":[2.0,12.0,2.0],"gemini-3.5-flash":[1.5,9.0,1.5],"gemini-3.5-flash-lite":[0.3,2.5,0.03],"gemini-3.5-flash-thinking":[1.5,9.0,1.5],"gemini-3.6-flash":[1.5,7.5,0.15],"gemini-3.7-flash":[0.75,3.75,0.075],"gemini-3.8-flash":[0.75,3.75,0.075],"gemini-4-argon":[4.0,10.0,0.2],"glm-4.5":[0.286,1.143,0.286],"glm-4.5v":[0.29,0.86,0.29],"glm-4.6":[0.286,1.142,0.286],"glm-4.6v":[0.145,0.43,0.145],"glm-4.7":[0.286,1.142,0.286],"glm-5":[0.6,2.6,0.6],"glm-5-turbo":[0.72,3.2,0.72],"glm-5.1":[1.4,4.4,0.26],"glm-5.2":[1.4,4.4,0.26],"glm-5.3":[1.4,4.4,0.26],"glm-5.3-flash":[0.075,0.25,0.015],"glm-5v-turbo":[0.72,3.2,0.72],"gpt-4.1":[2.0,8.0,2.0],"gpt-4.1-mini":[0.4,1.6,0.4],"gpt-4.1-nano":[0.1,0.4,0.1],"gpt-4o":[2.5,10.0,2.5],"gpt-5":[1.25,10.0,1.25],"gpt-5-mini":[0.25,2.0,0.025],"gpt-5-pro":[15.0,120.0,0.005],"gpt-5-thinking":[1.25,10.0,1.25],"gpt-5.1":[1.25,10.0,1.25],"gpt-5.1-chat-latest":[1.25,10.0,1.25],"gpt-5.2":[1.75,14.0,1.75],"gpt-5.2-chat-latest":[1.75,14.0,1.75],"gpt-5.3-chat-latest":[1.75,14.0,1.75],"gpt-5.4":[2.5,15.0,0.25],"gpt-5.4-mini":[0.75,4.5,0.075],"gpt-5.4-nano":[0.2,1.25,0.02],"gpt-5.5":[5.0,30.0,0.5],"gpt-5.6-luna":[0.2,1.2,0.02],"gpt-5.6-luna-pro":[0.2,1.2,0.02],"gpt-5.6-sol":[5.0,30.0,0.5],"gpt-5.6-sol-pro":[5.0,30.0,0.5],"gpt-5.6-terra":[2.0,12.0,0.2],"gpt-5.6-terra-pro":[2.0,12.0,0.2],"gpt-6-astra":[10.0,50.0,1.0],"gpt-6-luna":[0.1,0.5,0.01],"gpt-6-sol":[2.0,10.0,0.2],"gpt-6.1-sol":[2.0,10.0,0.1],"grok-4-1-fast-reasoning":[0.2,0.5,0.2],"grok-4-fast-non-reasoning":[0.2,0.5,0.2],"grok-4-fast-reasoning":[0.2,0.5,0.2],"grok-4.1":[2.0,10.0,2.0],"grok-4.20-beta-0309-reasoning":[2.0,6.0,2.0],"grok-4.3":[1.25,2.5,1.25],"grok-4.5":[2.0,6.0,0.5],"grok-4.6":[2.0,6.0,0.5],"grok-4.7":[2.0,6.0,0.5],"kimi-k2-0905-preview":[0.62854,2.5146,0.62854],"kimi-k2-thinking":[0.575,2.3,0.575],"kimi-k2.5":[0.627,3.3,0.627],"kimi-k2.6":[0.95,4.0,0.95],"kimi-k2.7-code":[0.95,4.0,0.95],"kimi-k3":[3.0,15.0,0.3],"kimi-k3.1-pro":[2.4,12.0,0.24],"minimax-m1":[0.132,1.254,0.132],"minimax-m2":[0.33,1.32,0.33],"minimax-m2.1":[0.3,1.2,0.3],"minimax-m2.5":[0.3,1.2,0.3],"minimax-m2.7":[0.3,1.2,0.3],"minimax-m3":[0.72,2.88,0.144],"ministral-14b-2512":[0.33,0.33,0.33],"mistral-large-2512":[1.1,3.3,1.1],"o3":[2.0,8.0,2.0],"qwen3-235b-a22b":[0.29,2.86,0.29],"qwen3-235b-a22b-instruct-2507":[0.29,1.143,0.29],"qwen3-30b-a3b":[0.11,1.08,0.11],"qwen3-coder-480b-a35b-instruct":[0.86,3.43,0.86],"qwen3-max-2025-09-23":[0.86,3.43,0.86],"qwen3.5-35b-a3b":[0.06,0.46,0.06],"qwen3.5-plus":[0.12,0.69,0.12],"qwen3.6-35b-a3b":[0.28,1.7,0.28],"qwen3.6-flash":[0.19,1.13,0.0171],"qwen3.6-plus":[0.3,1.8,0.3],"qwen3.7-max":[1.8,5.3,1.8],"qwen3.7-max-2026-06-08":[1.8,5.3,1.8],"qwen3.7-plus":[0.228,0.92,0.023],"qwen3.8-flash":[0.15,0.47,0.016],"qwen3.8-max":[2.16,6.36,0.168]},"abacus":{"claude-3-7-sonnet-20250219":[3.0,15.0,3.0],"claude-fable-5":[10.0,50.0,10.0],"claude-haiku-4-5-20251001":[1.0,5.0,1.0],"claude-opus-4-1-20250805":[15.0,75.0,15.0],"claude-opus-4-20250514":[15.0,75.0,15.0],"claude-opus-4-5-20251101":[5.0,25.0,5.0],"claude-opus-4-6":[5.0,25.0,5.0],"claude-opus-4-7":[5.0,25.0,5.0],"claude-opus-4-8":[5.0,25.0,5.0],"claude-opus-5":[5.0,25.0,5.0],"claude-sonnet-4-20250514":[3.0,15.0,3.0],"claude-sonnet-4-5-20250929":[3.0,15.0,3.0],"claude-sonnet-4-6":[3.0,15.0,3.0],"claude-sonnet-5":[2.0,10.0,2.0],"deepseek-ai/deepseek-r1":[3.0,7.0,3.0],"deepseek-ai/deepseek-v3.1-terminus":[0.27,1.0,0.27],"deepseek-ai/deepseek-v3.2":[0.27,0.4,0.27],"deepseek-ai/deepseek-v4-flash":[0.14,0.28,0.03],"deepseek-ai/deepseek-v4-pro":[1.74,3.48,0.15],"deepseek/deepseek-v3.1":[0.55,1.66,0.55],"gemini-2.5-flash":[0.3,2.5,0.03],"gemini-2.5-flash-image":[0.3,30.0,0.3],"gemini-2.5-pro":[1.25,10.0,0.125],"gemini-3-flash-preview":[0.5,3.0,0.05],"gemini-3-pro-image":[2.0,12.0,0.2],"gemini-3-pro-image-preview":[2.0,12.0,0.2],"gemini-3.1-flash-image":[0.5,3.0,0.5],"gemini-3.1-flash-image-preview":[0.5,3.0,0.5],"gemini-3.1-flash-lite":[0.25,1.5,0.025],"gemini-3.1-flash-lite-preview":[0.25,1.5,0.025],"gemini-3.1-pro-preview":[2.0,12.0,0.2],"gemini-3.5-flash":[1.5,9.0,0.15],"gemini-3.5-flash-lite":[0.3,2.5,0.03],"gemini-3.6-flash":[0.75,3.75,0.075],"gemini-3.7-flash":[0.75,3.75,0.075],"google/gemma-4-31b-it":[0.14,0.4,0.14],"gpt-4.1":[2.0,8.0,0.5],"gpt-4.1-mini":[0.4,1.6,0.1],"gpt-4.1-nano":[0.1,0.4,0.025],"gpt-4o":[2.5,10.0,1.25],"gpt-4o-2024-11-20":[2.5,10.0,2.5],"gpt-4o-mini":[0.15,0.6,0.15],"gpt-5":[1.25,10.0,0.125],"gpt-5-codex":[1.25,10.0,0.125],"gpt-5-mini":[0.25,2.0,0.025],"gpt-5-nano":[0.05,0.4,0.005],"gpt-5.1":[1.25,10.0,0.125],"gpt-5.1-chat-latest":[1.25,10.0,1.25],"gpt-5.1-codex":[1.25,10.0,0.125],"gpt-5.1-codex-max":[1.25,10.0,1.25],"gpt-5.2":[1.75,14.0,0.175],"gpt-5.2-chat-latest":[1.75,14.0,1.75],"gpt-5.2-codex":[1.75,14.0,0.175],"gpt-5.3-chat-latest":[1.75,14.0,1.75],"gpt-5.3-codex":[1.75,14.0,0.175],"gpt-5.3-codex-xhigh":[1.75,14.0,1.75],"gpt-5.4":[2.5,15.0,0.25],"gpt-5.4-mini":[0.75,4.5,0.075],"gpt-5.4-nano":[0.2,1.25,0.02],"gpt-5.5":[5.0,30.0,0.5],"gpt-5.6-luna":[0.2,1.2,0.02],"gpt-5.6-sol":[4.0,20.0,0.4],"gpt-5.6-terra":[2.0,12.0,0.2],"grok-4-0709":[3.0,15.0,3.0],"grok-4-1-fast-non-reasoning":[0.2,0.5,0.2],"grok-4-fast-non-reasoning":[0.2,0.5,0.2],"grok-4.3":[1.25,2.5,0.2],"grok-4.5":[2.0,6.0,0.3],"grok-4.6":[2.0,6.0,0.5],"grok-code-fast-1":[0.2,1.5,0.2],"kimi-k2-turbo-preview":[0.15,8.0,0.15],"kimi-k2.5":[0.6,3.0,0.6],"llama-3.3-70b-versatile":[0.59,0.79,0.59],"meta-llama/llama-4-maverick-17b-128e-instruct-fp8":[0.14,0.59,0.14],"meta-llama/meta-llama-3.1-405b-instruct-turbo":[3.5,3.5,3.5],"meta-llama/meta-llama-3.1-8b-instruct":[0.02,0.05,0.02],"meta-llama/meta-llama-3.3-70b-instruct":[0.59,0.79,0.59],"mimo-v2-pro":[1.0,3.0,0.2],"minimaxai/minimax-m2.7":[0.3,1.2,0.3],"minimaxai/minimax-m3":[0.3,1.2,0.3],"moonshotai/kimi-k2.6":[0.95,4.0,0.16],"moonshotai/kimi-k2.7-code":[0.95,4.0,0.19],"moonshotai/kimi-k3":[3.0,15.0,0.3],"muse-spark-1.1":[1.25,4.25,0.15],"muse-spark-1.2":[1.25,4.25,0.15],"o3":[2.0,8.0,0.5],"o3-mini":[1.1,4.4,0.55],"o3-pro":[20.0,80.0,20.0],"o4-mini":[1.1,4.4,1.1],"openai/gpt-oss-120b":[0.037,0.17,0.037],"qwen-2.5-coder-32b":[0.79,0.79,0.79],"qwen/qwen2.5-72b-instruct":[0.11,0.38,0.11],"qwen/qwen3-235b-a22b-instruct-2507":[0.13,0.6,0.13],"qwen/qwen3-32b":[0.08,0.28,0.08],"qwen/qwen3-coder-480b-a35b-instruct":[0.38,1.55,0.38],"qwen/qwen3.6-27b":[0.32,3.2,0.32],"qwen/qwq-32b":[0.4,0.4,0.4],"qwen3-max":[1.2,6.0,1.2],"qwen3.7-max":[2.5,7.5,2.5],"qwen3.8-max":[2.0,6.0,0.25],"route-llm":[2.0,10.0,0.1],"thinkingmachines/inkling":[3.74,9.36,0.748],"zai-org/glm-4.5":[0.6,2.2,0.6],"zai-org/glm-4.6":[0.55,2.2,0.55],"zai-org/glm-4.7":[0.6,2.2,0.6],"zai-org/glm-5":[1.0,3.2,1.0],"zai-org/glm-5.1":[1.38,4.4,0.26],"zai-org/glm-5.2":[1.4,4.4,0.26]},"abliteration-ai":{"abliterated-model":[3.0,3.0,0.3],"abliterated-model-large":[5.0,5.0,0.5],"abliterated-model-large-v2":[5.0,5.0,0.5]},"above":{"deepseek-v4-flash":[0.165,0.66,0.0033],"deepseek-v4-pro":[0.726,2.178,0.0242],"deepseek-v4.1-flash":[0.165,0.66,0.0033],"glm-5.2":[1.54,4.84,0.154],"glm-5.2-fast":[2.31,7.26,0.231],"glm-5.3-flash":[0.165,0.55,0.0319],"mimo-v2.6-flash":[0.1692,0.3385,0.0034],"mimo-v2.6-pro":[0.5077,1.0154,0.0042],"mimo-v2.6-pro-ultraspeed":[5.0769,10.1538,0.0423],"qwen3.8-max":[2.2,6.6,0.275]},"agnes":{"agnes-2.0-flash":[0.0,0.0],"agnes-2.5-flash":[0.0,0.0],"agnes-2.5-pro-alpha":[0.45,0.9,0.0038],"agnes-3.0-flash":[0.0,0.0]},"ai-router":{"gpt-5.4":[2.5,15.0,0.25],"gpt-5.5":[5.0,30.0,0.5],"gpt-5.6-luna":[1.0,6.0,0.1],"gpt-5.6-sol":[5.0,30.0,0.5],"gpt-5.6-terra":[2.5,15.0,0.25]},"ai21":{"jamba-large":[2.0,8.0,2.0],"jamba-mini":[0.2,0.4,0.2]},"aiand":{"deepseek-ai/deepseek-v4-pro":[1.0,2.5,0.25],"deepseek-ai/deepseek-v4.1-flash":[0.3,0.6,0.02],"google/gemma-4-31b-it":[0.2,0.5,0.05],"moonshotai/kimi-k3":[3.0,12.5,0.5],"motif-technologies/motif-3":[0.5,2.0,0.2],"openai/gpt-oss-120b":[0.15,0.6,0.08],"qwen/qwen3.6-27b":[0.32,3.2,0.2],"qwen/qwen3.8-27b":[0.4,3.0,0.2],"zai-org/glm-5.3":[1.0,4.0,0.3],"zai-org/glm-5.3-flash":[0.15,0.5,0.03]},"aihubmix":{"alicloud-deepseek-v4-flash":[0.14,0.28,0.028],"alicloud-deepseek-v4-pro":[1.69,3.38,0.13],"alicloud-glm-5.1":[0.84,3.38,0.169],"claude-fable-5":[11.0,55.0,1.1],"claude-fable-5-1":[11.0,55.0,0.275],"claude-haiku-4-5":[1.1,5.5,0.11],"claude-haiku-5-5":[0.1,0.5,0.01],"claude-opus-4-5":[5.0,25.0,0.5],"claude-opus-4-5-think":[5.0,25.0,0.5],"claude-opus-4-6":[5.0,25.0,0.5],"claude-opus-4-6-think":[5.0,25.0,0.5],"claude-opus-4-7":[5.0,25.0,0.5],"claude-opus-4-7-think":[5.0,25.0,0.5],"claude-opus-4-8":[5.0,25.0,0.5],"claude-opus-4-8-think":[5.0,25.0,0.5],"claude-opus-5":[5.0,25.0,0.5],"claude-opus-5-5":[4.0,20.0,0.2],"claude-sonnet-4-5":[3.3,16.5,0.33],"claude-sonnet-4-5-think":[3.3,16.5,0.33],"claude-sonnet-4-6":[3.0,15.0,0.3],"claude-sonnet-4-6-think":[3.0,15.0,0.3],"claude-sonnet-5":[2.0,10.0,0.2],"claude-sonnet-5-5":[2.0,10.0,0.1],"coding-glm-5.1":[0.06,0.22,0.013],"coding-glm-5.1-free":[0.0,0.0],"coding-glm-5.2-free":[0.0,0.0],"coding-glm-5.3-flash-free":[0.0,0.0],"coding-glm-5.3-free":[0.0,0.0],"coding-minimax-m2.7":[0.2,0.2,0.2],"coding-minimax-m2.7-free":[0.0,0.0],"coding-minimax-m2.7-highspeed":[0.2,0.2,0.2],"coding-xiaomi-mimo-v2.5":[0.08,0.16,0.0016],"coding-xiaomi-mimo-v2.5-pro":[0.2,0.4,0.0016],"deep-deepseek-v4-flash":[0.154,0.308,0.0308],"deep-deepseek-v4-pro":[0.478,0.956,0.004302],"deepseek-v4-flash-0731":[0.142,0.284,0.0284],"deepseek-v4-flash-0731-fast":[0.28,1.4,0.07],"deepseek-v4-flash-vision-exp":[0.155,0.62,0.0031],"deepseek-v4-pro-0813":[0.6918,2.0754,0.023057694],"deepseek-v4.1-flash":[0.155,0.62,0.0031],"doubao-seed-2-0-code-preview":[0.4822,2.411,0.09644],"doubao-seed-2-0-lite-260428":[0.09041,0.54246,0.018082],"doubao-seed-2-0-mini-260428":[0.030136,0.30136,0.0060272],"doubao-seed-2-0-pro":[0.4958,2.479,0.09916],"gemini-2.5-flash":[0.3,2.499,0.03],"gemini-2.5-flash-image":[0.3,30.0,0.03],"gemini-2.5-flash-lite":[0.1,0.4,0.01],"gemini-2.5-pro":[1.25,10.0,0.125],"gemini-3-flash-preview":[0.5,3.0,0.05],"gemini-3-pro-image":[2.0,120.0,2.0],"gemini-3.1-flash-image":[0.5,3.0,0.5],"gemini-3.1-flash-lite":[0.25,1.5,0.025],"gemini-3.1-flash-lite-image":[0.25,1.5,0.025],"gemini-3.1-pro-preview":[2.0,12.0,0.2],"gemini-3.1-pro-preview-customtools":[2.0,12.0,0.2],"gemini-3.5-flash":[0.75,3.75,0.075],"gemini-3.5-flash-lite":[0.3,2.499999,0.03],"gemini-3.6-flash":[0.75,3.75,0.075],"gemini-3.7-flash":[0.75,3.75,0.075],"gemini-3.8-flash":[0.75,3.75,0.075],"gemini-4-argon":[2.0,10.0,0.1],"glm-4.5v":[0.274,1.096,0.274],"glm-4.6":[0.273974,1.095896,0.0547948],"glm-4.6v":[0.137,0.411,0.0274],"glm-4.7":[0.273974,1.095896,0.0547948],"glm-4.7-flash-free":[0.0,0.0],"glm-5.2":[1.1268,3.9438,0.2817],"glm-5.3":[1.1268,3.9438,0.2817],"glm-5.3-flash":[0.11268,0.39438,0.02817],"glm-5v-turbo":[0.7042,3.09848,0.169008],"gpt-5":[1.25,10.0,0.125],"gpt-5.1":[1.25,10.0,0.125],"gpt-5.1-codex":[1.25,10.0,0.125],"gpt-5.1-codex-mini":[0.25,2.0,0.025],"gpt-5.2":[1.75,14.0,0.175],"gpt-5.2-codex":[1.75,14.0,0.175],"gpt-5.3-codex":[1.75,14.0,0.175],"gpt-5.4":[2.5,15.0,0.25],"gpt-5.4-mini":[0.75,4.5,0.075],"gpt-5.4-nano":[0.2,1.25,0.02],"gpt-5.5":[5.0,30.0,0.5],"gpt-5.5-pro":[30.0,180.0,30.0],"gpt-5.6-luna":[0.2,1.2,0.02],"gpt-5.6-sol":[4.0,20.0,0.4],"gpt-5.6-terra":[2.0,12.0,0.2],"gpt-6-astra":[10.0,50.0,1.0],"gpt-6-luna":[0.1,0.5,0.01],"gpt-6-sol":[2.0,10.0,0.2],"gpt-6.1-sol":[2.0,10.0,0.1],"gpt-image-1.5":[5.0,32.0,5.0],"gpt-image-2":[5.0,30.0,1.25],"gpt-image-2.5-flare":[5.0,30.0,1.25],"gpt-image-2.5-sunburst":[5.0,30.0,1.25],"grok-4.3":[1.25,2.5,0.2],"grok-4.5":[2.2,6.6,0.55],"grok-4.6":[2.0,6.0,0.5],"grok-4.7":[2.0,6.0,0.5],"grok-build-0.1":[1.0,2.0,0.2],"hy3":[0.1562,0.6248,0.03905],"hy3-preview":[0.17,0.566661,0.051],"hy4-preview":[0.845,2.535,0.04225],"kimi-k2.5":[0.6,3.0,0.1],"kimi-k2.6":[0.95,4.0,0.16],"kimi-k2.7-code":[0.95,3.9995,0.160835],"kimi-k2.7-code-highspeed":[1.9,7.999,0.32167],"kimi-k3":[3.0,15.0,0.3],"ling-3.0-flash-free":[0.0,0.0],"longcat-2.0":[0.7746,3.0984,0.015492],"mimo-v2.5":[0.155,0.31,0.0031],"mimo-v2.5-pro":[0.48,0.96,0.00384],"mimo-v2.6-flash":[0.155,0.31,0.0031],"mimo-v2.6-pro":[0.48,0.96,0.00384],"mimo-v2.6-pro-ultraspeed":[4.8,9.6,0.0384],"minimax-m2.7":[0.3,1.2,0.06],"minimax-m3":[0.288,1.152,0.288],"muse-spark-1.1":[1.375,4.675,1.375],"muse-spark-1.2":[1.375,4.675,1.375],"muse-spark-1.3":[1.375,4.675,0.165],"nemotron-3-nano-omni-30b-a3b-reasoning-free":[0.0,0.0],"nemotron-3-super-120b-a12b-free":[0.0,0.0],"nemotron-3-ultra-550b-a55b-free":[0.0,0.0],"nemotron-3.5-content-safety-free":[0.0,0.0],"nemotron-3.5-lightning-free":[0.0,0.0],"o3":[2.0,8.0,0.5],"o4-mini":[1.1,4.4,0.275],"qwen3-max":[0.4508,2.7048,0.09016],"qwen3-vl-plus":[0.137,1.37],"qwen3.5-122b-a10b":[0.1126,0.9008,0.1126],"qwen3.5-27b":[0.0846,0.6768,0.0846],"qwen3.5-35b-a3b":[0.0564,0.4512,0.0564],"qwen3.5-397b-a17b":[0.1644,0.9864,0.1644],"qwen3.5-flash":[0.0282,0.282,0.00282],"qwen3.5-plus":[0.1096,0.6576,0.01096],"qwen3.6-35b-a3b":[0.254,1.524,0.254],"qwen3.6-flash":[0.169,1.014,0.0169],"qwen3.6-max-preview":[1.27,7.61,0.1268],"qwen3.6-plus":[0.282,1.692,0.0282],"qwen3.7-flash":[0.0282,0.1128,0.00564],"qwen3.7-max":[1.69,5.07,0.169],"qwen3.7-plus":[0.282,1.128,0.0564],"qwen3.8-2.4t-a95b":[2.0,6.0,0.5],"qwen3.8-flash":[0.1126,0.380025,0.014075],"qwen3.8-flash-free":[0.0,0.0],"qwen3.8-max":[1.69,5.07,0.169],"qwen3.8-max-free":[0.0,0.0],"qwen3.8-max-preview":[0.338,1.014,0.0676],"qwen3.8-omni-flash":[0.1126,0.380025,0.014075],"step-3.7-flash":[0.22,1.32,0.044],"step-5-preview":[1.08,3.0888,0.054],"xiaomi-mimo-v2.5":[0.44,2.2,0.088],"xiaomi-mimo-v2.5-free":[0.0,0.0],"xiaomi-mimo-v2.5-pro":[1.1,3.3,0.22],"xiaomi-mimo-v2.5-pro-free":[0.0,0.0],"zai-glm-5.1":[0.845,3.38,0.183112]},"aimlapi":{"aion-labs/aion-rp-llama-3.1-8b":[0.8464,1.6928,0.8464],"alibaba/qwen-max":[1.6,6.4,0.32],"alibaba/qwen-plus":[0.4,1.2,0.08],"alibaba/qwen3-coder-480b-a35b-instruct":[1.058,5.15775,1.058],"alibaba/qwen3-next-80b-a3b-instruct":[0.1587,1.2696,0.1587],"alibaba/qwen3.8-2.4t-a95b":[2.645,6.6125,0.529],"alibaba/qwen3.8-27b":[0.4761,3.3856,0.4761],"alibaba/qwen3.8-flash":[0.16,0.47,0.016],"alibaba/qwen3.8-max":[2.0,6.0,0.25],"alibaba/qwen3.8-max-prime":[4.232,12.696,0.529],"amazon/nova-lite-v1":[0.06348,0.25392,0.06348],"amazon/nova-micro-v1":[0.03703,0.14812,0.03703],"amazon/nova-pro-v1":[0.8464,3.3856,0.8464],"anthracite-org/magnum-v4-72b":[3.174,5.29,3.174],"anthropic/claude-fable-5":[10.0,50.0,1.0],"anthropic/claude-fable-5.1":[10.0,50.0,0.25],"anthropic/claude-haiku-4.5":[1.058,5.29,0.1058],"anthropic/claude-haiku-5.5":[0.1,0.5,0.01],"anthropic/claude-opus-4.5":[5.29,26.45,0.529],"anthropic/claude-opus-4.7":[5.29,26.45,0.529],"anthropic/claude-opus-4.8":[5.29,26.45,0.529],"anthropic/claude-opus-5":[5.0,25.0,0.5],"anthropic/claude-opus-5.5":[4.0,20.0,0.2],"anthropic/claude-sonnet-4.5":[3.174,15.87,0.3174],"anthropic/claude-sonnet-4.6":[3.174,15.87,0.3174],"anthropic/claude-sonnet-5":[2.0,10.0,0.2],"anthropic/claude-sonnet-5.5":[2.0,10.0,0.2],"bytedance-seed/seed-1.6-flash":[0.07935,0.3174,0.07935],"bytedance-seed/seed-2.0-code":[0.529,3.174,0.529],"bytedance-seed/seed-2.0-lite":[0.2645,2.116,0.2645],"bytedance-seed/seed-2.0-mini":[0.1058,0.4232,0.1058],"cognitivecomputations/dolphin-mistral-24b-venice-edition":[0.2116,0.9522,0.2116],"cohere/command-a":[2.645,10.58,2.645],"cohere/command-r-08-2024":[0.1587,0.6348,0.1587],"cohere/command-r-plus-08-2024":[2.645,10.58,2.645],"cohere/command-r7b-12-2024":[0.039675,0.1587,0.039675],"deepseek/deepseek-chat":[0.39,1.56,0.0078],"deepseek/deepseek-chat-v3-0324":[0.30682,1.20612,0.14812],"deepseek/deepseek-v4-flash":[0.3,1.2,0.006],"deepseek/deepseek-v4-flash-vision-exp":[0.44,1.32,0.014],"deepseek/deepseek-v4-pro":[0.9,2.7,0.03],"deepseek/deepseek-v4-pro-0813":[1.84092,3.68184,0.15341],"deepseek/deepseek-v4.1-flash":[0.3,1.2,0.006],"google/gemini-3-8-flash":[0.75,3.75,0.075],"google/gemini-3.1-flash-lite-preview":[0.2645,1.587,0.02645],"google/gemini-3.1-pro-preview":[2.0,12.0,0.5],"google/gemini-3.1-pro-preview-customtools":[2.116,12.696,0.2116],"google/gemini-3.6-flash":[1.5,7.5,0.15],"google/gemini-3.7-flash":[0.75,3.75,0.075],"google/gemini-3.8-flash":[0.75,3.75,0.075],"google/gemini-flash-latest":[1.587,9.522,0.1587],"google/gemma-2-27b-it":[0.6877,0.6877,0.6877],"google/gemma-3-12b-it":[0.0529,0.1587,0.04232],"google/gemma-3-27b-it":[0.1587,0.48668,0.07935],"google/gemma-3-4b-it":[0.0529,0.1058,0.04232],"google/gemma-4-26b-a4b-it":[0.1587,0.6348,0.1587],"google/gemma-4-31b-it":[1.04742,1.57642,1.04742],"gryphe/mythomax-l2-13b":[1.98375,1.98375,1.98375],"ibm-granite/granite-4.0-h-micro":[0.017986,0.118496,0.017986],"inception/mercury-2":[0.2645,0.7935,0.02645],"inception/mercury-2.5":[0.2116,0.7935,0.02116],"inference-net/schematron-v2-small":[0.0529,0.24334,0.0529],"inference-net/schematron-v2-turbo":[0.03174,0.1587,0.03174],"mancer/weaver":[0.7935,1.058,0.7935],"meta-llama/llama-3.3-70b-instruct-turbo":[0.76176,2.383674,0.76176],"meta/muse-glimmer-30b":[0.3703,1.587,0.04232],"meta/muse-spark-1.1":[1.3225,4.4965,0.1587],"meta/muse-spark-1.2":[1.3225,4.4965,0.1587],"meta/muse-spark-1.3":[1.3225,4.4965,0.1587],"mistralai/codestral-2508":[0.3174,0.9522,0.03174],"mistralai/devstral-2512":[0.46552,2.3276,0.046552],"mistralai/ministral-14b-2512":[0.3703,0.3703,0.02116],"mistralai/ministral-3b-2512":[0.1587,0.1587,0.01058],"mistralai/ministral-8b-2512":[0.3174,0.3174,0.01587],"mistralai/mistral-large":[2.116,6.348,0.2116],"mistralai/mistral-large-2407":[2.116,6.348,0.2116],"mistralai/mistral-medium-3":[0.4232,2.116,0.04232],"mistralai/mistral-medium-3-5":[1.587,7.935,1.587],"mistralai/mistral-medium-3.1":[0.4232,2.116,0.04232],"mistralai/mistral-nemo":[0.1587,0.17986,0.1587],"mistralai/mistral-saba":[0.2116,0.6348,0.02116],"mistralai/mistral-small-24b-instruct-2501":[0.0529,0.08464,0.0529],"mistralai/mistral-small-2603":[0.198375,0.7935,0.01587],"mistralai/mistral-small-3.1-24b-instruct":[0.371358,0.58719,0.371358],"mistralai/mistral-small-3.2-24b-instruct":[0.07935,0.2116,0.07935],"mistralai/mixtral-8x22b-instruct":[2.116,6.348,0.2116],"mistralai/voxtral-small-24b-2507":[0.1058,0.3174,0.01058],"moonshot/kimi-k3":[3.0,15.0,0.3],"moonshotai/kimi-k2":[0.60306,2.4334,0.60306],"moonshotai/kimi-k2-0905":[1.058,3.174,1.058],"moonshotai/kimi-k2-thinking":[0.6348,2.645,0.1587],"morph/morph-v3-fast":[0.8464,1.2696,0.8464],"morph/morph-v3-large":[0.9522,2.0102,0.9522],"nousresearch/hermes-3-llama-3.1-405b":[1.058,1.058,1.058],"nousresearch/hermes-3-llama-3.1-70b":[0.7406,0.7406,0.7406],"openai/gpt-4.1":[2.0,8.0,0.5],"openai/gpt-4.1-mini":[0.4,1.6,0.1],"openai/gpt-4o":[2.5,10.0,1.25],"openai/gpt-4o-2024-05-13":[5.29,15.87,5.29],"openai/gpt-4o-2024-08-06":[2.5,10.0,1.25],"openai/gpt-4o-2024-11-20":[2.5,10.0,1.25],"openai/gpt-4o-mini":[0.15,0.6,0.075],"openai/gpt-5":[1.25,10.0,0.125],"openai/gpt-5-1":[1.25,10.0,0.125],"openai/gpt-5-2":[1.75,14.0,0.175],"openai/gpt-5-4":[2.5,15.0,0.25],"openai/gpt-5-5":[5.0,30.0,0.5],"openai/gpt-5-mini":[0.25,2.0,0.025],"openai/gpt-5-nano":[0.05,0.4,0.005],"openai/gpt-5-pro":[15.87,126.96,15.87],"openai/gpt-5.1-codex-max":[2.645,21.16,0.2645],"openai/gpt-5.2-pro":[22.218,177.744,22.218],"openai/gpt-5.3-codex":[3.703,29.624,0.3703],"openai/gpt-5.4-image-2":[8.464,15.87,2.116],"openai/gpt-5.4-mini":[1.587,9.522,0.1587],"openai/gpt-5.4-nano":[0.2116,1.3225,0.02116],"openai/gpt-5.4-pro":[31.74,190.44,31.74],"openai/gpt-5.5-pro":[31.74,190.44,31.74],"openai/gpt-5.6-luna":[0.2,1.2,0.02],"openai/gpt-5.6-luna-pro":[0.2116,1.2696,0.02116],"openai/gpt-5.6-sol":[4.0,20.0,0.4],"openai/gpt-5.6-sol-pro":[4.232,21.16,0.4232],"openai/gpt-5.6-terra":[2.0,12.0,0.2],"openai/gpt-5.6-terra-pro":[2.116,12.696,0.2116],"openai/gpt-6-astra":[10.0,50.0,1.0],"openai/gpt-6-luna":[0.1,0.5,0.01],"openai/gpt-6-sol":[2.0,10.0,0.2],"openai/gpt-6.1-sol":[2.0,10.0,0.1],"openai/gpt-6.1-terra":[1.0,5.0,0.05],"openai/gpt-oss-120b":[0.3703,1.0051,0.3703],"openai/gpt-oss-20b":[0.07935,0.3174,0.039675],"openai/gpt-oss-safeguard-20b":[0.07935,0.3174,0.039675],"openai/o3-pro":[21.16,84.64,21.16],"perceptron/perceptron-mk1.5":[0.1587,1.587,0.1587],"perplexity/sonar":[1.0,1.0,1.0],"perplexity/sonar-pro":[3.0,15.0,3.0],"rekaai/reka-edge":[0.1058,0.1058,0.1058],"relace/relace-apply-3":[0.8993,1.3225,0.8993],"relace/relace-search":[1.058,3.174,1.058],"sakana/fugu-max":[2.116,6.348,0.2645],"sakana/fugu-ultra":[5.29,31.74,0.529],"sakana/fugu-ultra-v2":[5.29,31.74,0.529],"sao10k/l3-lunaris-8b":[0.0529,0.0529,0.0529],"sao10k/l3.1-euryale-70b":[1.534523,1.534523,1.534523],"sao10k/l3.3-euryale-70b":[0.6877,0.7935,0.6877],"stepfun/step-5-preview":[1.058,2.8566,0.0529],"tencent/hy-mt2-1.8b":[0.046552,0.187266,0.046552],"tencent/hy-mt2-30b-a3b":[0.078292,0.31211,0.078292],"tencent/hy-mt2-7b":[0.078292,0.31211,0.078292],"tencent/hy3":[0.2116,0.8464,0.0529],"tencent/hy4-preview":[0.882372,2.646058,0.044436],"thedrummer/cydonia-24b-v4.1":[0.3174,0.529,0.1587],"thedrummer/skyfall-36b-v2":[0.5819,0.8464,0.2645],"thedrummer/unslopnemo-12b":[0.4232,0.4232,0.4232],"thinkingmachines/inkling":[1.058,4.2849,0.17986],"thinkingmachines/inkling-small":[0.61364,1.52352,0.122728],"unbiased/pareto":[2.645,7.935,0.2645],"undi95/remm-slerp-l2-13b":[0.529,0.7935,0.529],"upstage/solar-pro-3":[0.1587,0.6348,0.01587],"upstage/solar-pro4":[0.03174,0.12696,0.006348],"x-ai/grok-4-20-0309-non-reasoning":[1.25,2.5,0.2],"x-ai/grok-4-fast-non-reasoning":[1.25,2.5,0.2],"xiaomi/mimo-v2.5":[0.14812,0.29624,0.002962],"xiaomi/mimo-v2.5-pro":[0.46023,0.92046,0.003809],"z-ai/glm-4.5v":[0.6348,1.9044,0.11638],"z-ai/glm-4.6v":[0.3174,0.9522,0.05819],"z-ai/glm-4.7-flash":[0.13225,0.529,0.01058],"z-ai/glm-5-turbo":[1.2,4.0,0.24],"z-ai/glm-5.3-flash":[0.15,0.5,0.03],"z-ai/glm-5v-turbo":[1.2,4.0,0.24],"zhipu/glm-5.2":[1.4,4.4,0.26],"zhipu/glm-5.3":[1.4,4.4,0.26]},"ainetcafe":{"kimi-k3":[2.1,10.5,0.3]},"aixy":{"anthropic/claude-fable-5-1":[10.0,50.0,0.25],"anthropic/claude-haiku-5-5":[0.1,0.5,0.01],"anthropic/claude-opus-5-5":[4.0,20.0,0.2],"anthropic/claude-sonnet-5-5":[2.0,10.0,0.1],"gemini/gemini-3.8-flash":[0.75,3.75,0.075],"gemini/gemini-4-argon":[2.0,10.0,0.1],"openai/gpt-5.6-luna":[0.2,1.2,0.02],"openai/gpt-5.6-sol":[4.0,20.0,0.4],"openai/gpt-5.6-terra":[2.0,12.0,0.2],"openai/gpt-6-astra":[10.0,50.0,1.0],"openai/gpt-6-luna":[0.1,0.5,0.01],"openai/gpt-6-sol":[2.0,10.0,0.2],"openai/gpt-6.1-sol":[2.0,10.0,0.1]},"aki-io":{"deepseek-v4.1-flash-552b":[0.280375,1.1215,0.11215],"gemma4-26b":[0.11215,0.56075,0.11215],"glm5.3-754b":[1.1215,3.92525,0.280375],"gpt-oss-120b":[0.168225,0.616825,0.168225],"mistral4-119b":[0.2243,0.6729,0.2243],"qwen3.6-35b":[0.168225,0.56075,0.168225],"qwen3.8-27b":[0.33645,2.4673,0.11215]},"alibaba":{"deepseek-v4-flash-0731":[0.44,1.32,0.088],"glm-5.2":[1.4,4.4,0.28],"kimi-k3":[3.0,15.0,0.3],"qvq-max":[1.2,4.8,1.2],"qwen-flash":[0.05,0.4,0.01],"qwen-max":[1.6,6.4,1.6],"qwen-mt-plus":[2.46,7.37,2.46],"qwen-mt-turbo":[0.16,0.49,0.16],"qwen-omni-turbo":[0.07,0.27,0.07],"qwen-omni-turbo-realtime":[0.27,1.07,0.27],"qwen-plus":[0.4,1.2,0.08],"qwen-plus-character-ja":[0.5,1.4,0.5],"qwen-turbo":[0.05,0.2,0.05],"qwen-vl-max":[0.8,3.2,0.8],"qwen-vl-ocr":[0.07,0.16,0.07],"qwen-vl-plus":[0.21,0.63,0.21],"qwen2-5-omni-7b":[0.1,0.4,0.1],"qwen3-14b":[0.35,1.4,0.35],"qwen3-235b-a22b":[0.7,2.8,0.7],"qwen3-32b":[0.7,2.8,0.7],"qwen3-8b":[0.18,0.7,0.18],"qwen3-coder-30b-a3b-instruct":[0.45,2.25,0.45],"qwen3-coder-480b-a35b-instruct":[1.5,7.5,1.5],"qwen3-coder-flash":[0.3,1.5,0.06],"qwen3-coder-plus":[1.0,5.0,1.0],"qwen3-livetranslate-flash-realtime":[10.0,10.0,10.0],"qwen3-max":[1.2,6.0,1.2],"qwen3-next-80b-a3b-instruct":[0.5,2.0,0.5],"qwen3-next-80b-a3b-thinking":[0.5,6.0,0.5],"qwen3-omni-flash":[0.43,1.66,0.43],"qwen3-omni-flash-realtime":[0.52,1.99,0.52],"qwen3-vl-235b-a22b":[0.7,2.8,0.7],"qwen3-vl-30b-a3b":[0.2,0.8,0.2],"qwen3-vl-plus":[0.2,1.6,0.04],"qwen3.5-122b-a10b":[0.4,3.2,0.4],"qwen3.5-27b":[0.3,2.4,0.3],"qwen3.5-35b-a3b":[0.25,2.0,0.25],"qwen3.5-397b-a17b":[0.6,3.6,0.6],"qwen3.5-flash":[0.1,0.4,0.01],"qwen3.5-plus":[0.4,2.4,0.4],"qwen3.6-27b":[0.6,3.6,0.6],"qwen3.6-35b-a3b":[0.375,2.25,0.375],"qwen3.6-flash":[0.25,1.5,0.025],"qwen3.6-max-preview":[1.3,7.8,0.13],"qwen3.6-plus":[0.5,3.0,0.05],"qwen3.7-flash":[0.03,0.13,0.006],"qwen3.7-max":[2.5,7.5,0.5],"qwen3.7-plus":[0.4,1.6,0.08],"qwen3.8-flash":[0.15,0.47,0.016],"qwen3.8-max":[2.0,6.0,0.25],"qwen3.8-omni-flash":[0.15,0.47,0.016],"qwq-plus":[0.8,2.4,0.8]},"alibaba-cn":{"deepseek-r1":[0.574,2.294,0.574],"deepseek-r1-0528":[0.574,2.294,0.574],"deepseek-r1-distill-llama-70b":[0.287,0.861,0.287],"deepseek-r1-distill-llama-8b":[0.0,0.0],"deepseek-r1-distill-qwen-1-5b":[0.0,0.0],"deepseek-r1-distill-qwen-14b":[0.144,0.431,0.144],"deepseek-r1-distill-qwen-32b":[0.287,0.861,0.287],"deepseek-r1-distill-qwen-7b":[0.072,0.144,0.072],"deepseek-v3":[0.287,1.147,0.287],"deepseek-v3-1":[0.574,1.721,0.574],"deepseek-v3-2-exp":[0.287,0.431,0.287],"deepseek-v4-flash":[0.14,0.28,0.0028],"deepseek-v4-pro":[1.65,3.301,1.65],"deepseek-v4.1-flash":[0.29754,1.19015,0.01488],"glm-5":[0.573,2.58,0.573],"glm-5.1":[0.825,3.301,0.165],"glm-5.2":[1.1,3.851,0.275],"glm-5.3":[1.1,3.851,0.275],"kimi-k2-thinking":[0.574,2.294,0.574],"kimi-k2.5":[0.574,3.011,0.1148],"kimi-k2.6":[0.929,3.858,0.1858],"kimi-k3":[2.827,14.133,0.283],"kimi/kimi-k2.5":[0.6,3.0,0.1],"minimax-m2.5":[0.3,1.2,0.3],"minimax/minimax-m2.7":[0.3,1.2,0.06],"moonshot-kimi-k2-instruct":[0.574,2.294,0.574],"qvq-max":[1.147,4.588,1.147],"qwen-deep-research":[7.742,23.367,7.742],"qwen-doc-turbo":[0.087,0.144,0.087],"qwen-flash":[0.022,0.216,0.0044],"qwen-long":[0.072,0.287,0.072],"qwen-math-plus":[0.574,1.721,0.574],"qwen-math-turbo":[0.287,0.861,0.287],"qwen-max":[0.345,1.377,0.345],"qwen-mt-plus":[0.259,0.775,0.259],"qwen-mt-turbo":[0.101,0.28,0.101],"qwen-omni-turbo":[0.058,0.23,0.058],"qwen-omni-turbo-realtime":[0.23,0.918,0.23],"qwen-plus":[0.115,0.287,0.023],"qwen-plus-character":[0.115,0.287,0.115],"qwen-turbo":[0.044,0.087,0.044],"qwen-vl-max":[0.23,0.574,0.23],"qwen-vl-ocr":[0.043,0.072,0.043],"qwen-vl-plus":[0.115,0.287,0.115],"qwen2-5-omni-7b":[0.087,0.345,0.087],"qwen3-14b":[0.144,0.574,0.144],"qwen3-235b-a22b":[0.287,1.147,0.287],"qwen3-32b":[0.287,1.147,0.287],"qwen3-8b":[0.072,0.287,0.072],"qwen3-coder-30b-a3b-instruct":[0.216,0.861,0.216],"qwen3-coder-480b-a35b-instruct":[0.861,3.441,0.861],"qwen3-coder-flash":[0.144,0.574,0.0288],"qwen3-coder-plus":[0.574,2.296,0.574],"qwen3-max":[0.359,1.434,0.359],"qwen3-next-80b-a3b-instruct":[0.144,0.574,0.144],"qwen3-next-80b-a3b-thinking":[0.144,1.434,0.144],"qwen3-omni-flash":[0.258,0.989,0.258],"qwen3-omni-flash-realtime":[0.23,0.918,0.23],"qwen3-vl-235b-a22b":[0.286705,1.14682,0.286705],"qwen3-vl-30b-a3b":[0.108,0.431,0.108],"qwen3-vl-plus":[0.143353,1.433525,0.028671],"qwen3.5-397b-a17b":[0.172,1.032,0.172],"qwen3.5-flash":[0.029,0.287,0.029],"qwen3.5-plus":[0.115,0.688,0.115],"qwen3.6-flash":[0.165,0.99,0.0165],"qwen3.6-max-preview":[1.32,7.9,0.132],"qwen3.6-plus":[0.276,1.651,0.0276],"qwen3.7-flash":[0.02962,0.1185,0.005924],"qwen3.7-max":[1.65,4.951,0.33],"qwen3.7-plus":[0.276,1.101,0.0552],"qwen3.8-flash":[0.11875,0.40073,0.014844],"qwen3.8-max":[1.77744,5.33231,0.22218],"qwen3.8-omni-flash":[0.113,0.382,0.014],"qwq-plus":[0.23,0.574,0.23],"siliconflow/deepseek-r1-0528":[0.5,2.18,0.5],"siliconflow/deepseek-v3-0324":[0.25,1.0,0.25],"siliconflow/deepseek-v3.1-terminus":[0.27,1.0,0.27],"siliconflow/deepseek-v3.2":[0.27,0.42,0.27],"tongyi-intent-detect-v3":[0.058,0.144,0.058]},"alibaba-coding-plan":{"glm-4.7":[0.0,0.0],"glm-5":[0.0,0.0],"kimi-k2.5":[0.0,0.0],"minimax-m2.5":[0.0,0.0],"qwen3-coder-next":[0.0,0.0],"qwen3-coder-plus":[0.0,0.0],"qwen3-max-2026-01-23":[0.0,0.0],"qwen3.5-plus":[0.0,0.0],"qwen3.6-plus":[0.0,0.0],"qwen3.7-plus":[0.0,0.0]},"alibaba-coding-plan-cn":{"glm-4.7":[0.0,0.0],"glm-5":[0.0,0.0],"kimi-k2.5":[0.0,0.0],"minimax-m2.5":[0.0,0.0],"qwen3-coder-next":[0.0,0.0],"qwen3-coder-plus":[0.0,0.0],"qwen3-max-2026-01-23":[0.0,0.0],"qwen3.5-plus":[0.0,0.0],"qwen3.6-plus":[0.0,0.0],"qwen3.7-plus":[0.0,0.0]},"alibaba-token-plan":{"deepseek-v3.2":[0.0,0.0],"deepseek-v4-flash":[0.0,0.0],"deepseek-v4-flash-0731":[0.0,0.0],"deepseek-v4-pro":[0.0,0.0],"deepseek-v4-pro-0813":[0.0,0.0],"deepseek-v4.1-flash":[0.0,0.0],"deepseek-v4.1-flash-1017":[0.0,0.0],"glm-5":[0.0,0.0],"glm-5.1":[0.0,0.0],"glm-5.2":[0.0,0.0],"glm-5.3":[0.0,0.0],"happyhorse-1.1-i2v":[0.0,0.0],"happyhorse-1.1-r2v":[0.0,0.0],"happyhorse-1.1-t2v":[0.0,0.0],"kimi-k2.5":[0.0,0.0],"kimi-k2.6":[0.0,0.0],"kimi-k2.7-code":[0.0,0.0],"minimax-m2.5":[0.0,0.0],"qwen-image-2.0":[0.0,0.0],"qwen-image-2.0-pro":[0.0,0.0],"qwen3.6-flash":[0.0,0.0],"qwen3.6-plus":[0.0,0.0],"qwen3.7-max":[0.0,0.0],"qwen3.7-plus":[0.0,0.0],"qwen3.8-flash":[0.0,0.0],"qwen3.8-max":[0.0,0.0],"qwen3.8-max-preview":[0.0,0.0],"wan2.7-image":[0.0,0.0],"wan2.7-image-pro":[0.0,0.0]},"alibaba-token-plan-cn":{"deepseek-v3.2":[0.0,0.0],"deepseek-v4-flash":[0.0,0.0],"deepseek-v4-flash-0731":[0.0,0.0],"deepseek-v4-pro":[0.0,0.0],"deepseek-v4-pro-0813":[0.0,0.0],"deepseek-v4.1-flash":[0.0,0.0],"deepseek-v4.1-flash-1017":[0.0,0.0],"glm-5":[0.0,0.0],"glm-5.1":[0.0,0.0],"glm-5.2":[0.0,0.0],"glm-5.3":[0.0,0.0],"happyhorse-1.1-i2v":[0.0,0.0],"happyhorse-1.1-r2v":[0.0,0.0],"happyhorse-1.1-t2v":[0.0,0.0],"kimi-k2.5":[0.0,0.0],"kimi-k2.6":[0.0,0.0],"kimi-k2.7-code":[0.0,0.0],"minimax-m2.5":[0.0,0.0],"qwen-image-2.0":[0.0,0.0],"qwen-image-2.0-pro":[0.0,0.0],"qwen3.6-flash":[0.0,0.0],"qwen3.6-plus":[0.0,0.0],"qwen3.7-max":[0.0,0.0],"qwen3.7-plus":[0.0,0.0],"qwen3.8-flash":[0.0,0.0],"qwen3.8-max":[0.0,0.0],"qwen3.8-max-preview":[0.0,0.0],"wan2.7-image":[0.0,0.0],"wan2.7-image-pro":[0.0,0.0]},"amazon-bedrock":{"amazon.nova-2-lite-v1:0":[0.33,2.75,0.0825],"amazon.nova-lite-v1:0":[0.06,0.24,0.015],"amazon.nova-micro-v1:0":[0.035,0.14,0.00875],"amazon.nova-pro-v1:0":[0.8,3.2,0.2],"anthropic.claude-fable-5":[10.0,50.0,1.0],"anthropic.claude-fable-5-1":[10.0,50.0,0.25],"anthropic.claude-haiku-4-5-20251001-v1:0":[1.0,5.0,0.1],"anthropic.claude-haiku-5-5":[0.1,0.5,0.01],"anthropic.claude-opus-4-1-20250805-v1:0":[15.0,75.0,1.5],"anthropic.claude-opus-4-5-20251101-v1:0":[5.0,25.0,0.5],"anthropic.claude-opus-4-6-v1":[5.5,27.5,0.55],"anthropic.claude-opus-4-7":[5.0,25.0,0.5],"anthropic.claude-opus-4-8":[5.0,25.0,0.5],"anthropic.claude-opus-5":[5.0,25.0,0.5],"anthropic.claude-opus-5-5":[4.0,20.0,0.2],"anthropic.claude-sonnet-4-5-20250929-v1:0":[3.0,15.0,0.3],"anthropic.claude-sonnet-4-6":[3.3,16.5,0.33],"anthropic.claude-sonnet-5":[2.0,10.0,0.2],"anthropic.claude-sonnet-5-5":[2.0,10.0,0.1],"apac.amazon.nova-lite-v1:0":[0.063,0.252,0.01575],"apac.amazon.nova-micro-v1:0":[0.037,0.148,0.00925],"apac.amazon.nova-pro-v1:0":[0.84,3.36,0.21],"apac.anthropic.claude-sonnet-4-20250514-v1:0":[3.0,15.0,0.3],"au.anthropic.claude-haiku-4-5-20251001-v1:0":[1.1,5.5,0.11],"au.anthropic.claude-haiku-5-5":[0.11,0.55,0.011],"au.anthropic.claude-opus-4-6-v1":[5.5,27.5,0.55],"au.anthropic.claude-opus-4-7":[5.5,27.5,0.55],"au.anthropic.claude-opus-4-8":[5.5,27.5,0.55],"au.anthropic.claude-opus-5":[5.5,27.5,0.55],"au.anthropic.claude-opus-5-5":[4.4,22.0,0.22],"au.anthropic.claude-sonnet-4-5-20250929-v1:0":[3.3,16.5,0.33],"au.anthropic.claude-sonnet-4-6":[3.3,16.5,0.33],"au.anthropic.claude-sonnet-5":[2.2,11.0,0.22],"au.anthropic.claude-sonnet-5-5":[2.2,11.0,0.11],"ca.amazon.nova-lite-v1:0":[0.064,0.256,0.016],"deepseek.r1-v1:0":[1.35,5.4,1.35],"deepseek.v3-v1:0":[0.58,1.68,0.58],"deepseek.v3.2":[0.62,1.85,0.62],"eu.amazon.nova-2-lite-v1:0":[0.374,3.157,0.0935],"eu.amazon.nova-lite-v1:0":[0.069,0.276,0.01725],"eu.amazon.nova-micro-v1:0":[0.04,0.16,0.01],"eu.amazon.nova-pro-v1:0":[0.92,3.68,0.23],"eu.anthropic.claude-fable-5":[11.0,55.0,1.1],"eu.anthropic.claude-haiku-4-5-20251001-v1:0":[1.1,5.5,0.11],"eu.anthropic.claude-haiku-5-5":[0.11,0.55,0.011],"eu.anthropic.claude-opus-4-5-20251101-v1:0":[5.5,27.5,0.55],"eu.anthropic.claude-opus-4-6-v1":[5.5,27.5,0.55],"eu.anthropic.claude-opus-4-7":[5.5,27.5,0.55],"eu.anthropic.claude-opus-4-8":[5.5,27.5,0.55],"eu.anthropic.claude-opus-5":[5.5,27.5,0.55],"eu.anthropic.claude-opus-5-5":[4.4,22.0,0.22],"eu.anthropic.claude-sonnet-4-20250514-v1:0":[3.0,15.0,0.3],"eu.anthropic.claude-sonnet-4-5-20250929-v1:0":[3.3,16.5,0.33],"eu.anthropic.claude-sonnet-4-6":[3.3,16.5,0.33],"eu.anthropic.claude-sonnet-5":[2.2,11.0,0.22],"eu.anthropic.claude-sonnet-5-5":[2.2,11.0,0.11],"eu.mistral.pixtral-large-2502-v1:0":[2.0,6.0,2.0],"global.amazon.nova-2-lite-v1:0":[0.3,2.5,0.075],"global.anthropic.claude-fable-5":[10.0,50.0,1.0],"global.anthropic.claude-fable-5-1":[10.0,50.0,0.25],"global.anthropic.claude-haiku-4-5-20251001-v1:0":[1.0,5.0,0.1],"global.anthropic.claude-haiku-5-5":[0.1,0.5,0.01],"global.anthropic.claude-opus-4-5-20251101-v1:0":[5.0,25.0,0.5],"global.anthropic.claude-opus-4-6-v1":[5.0,25.0,0.5],"global.anthropic.claude-opus-4-7":[5.0,25.0,0.5],"global.anthropic.claude-opus-4-8":[5.0,25.0,0.5],"global.anthropic.claude-opus-5":[5.0,25.0,0.5],"global.anthropic.claude-opus-5-5":[4.0,20.0,0.2],"global.anthropic.claude-sonnet-4-20250514-v1:0":[3.0,15.0,0.3],"global.anthropic.claude-sonnet-4-5-20250929-v1:0":[3.0,15.0,0.3],"global.anthropic.claude-sonnet-4-6":[3.0,15.0,0.3],"global.anthropic.claude-sonnet-5":[2.0,10.0,0.2],"global.anthropic.claude-sonnet-5-5":[2.0,10.0,0.1],"global.moonshotai.kimi-k3":[3.0,15.0,0.3],"global.openai.gpt-5.6-luna":[0.2,1.2,0.02],"global.openai.gpt-5.6-sol":[4.0,20.0,0.4],"global.openai.gpt-5.6-terra":[2.0,12.0,0.2],"global.openai.gpt-6-astra":[10.0,50.0,1.0],"global.openai.gpt-6-luna":[0.1,0.5,0.01],"global.openai.gpt-6-sol":[2.0,10.0,0.2],"global.openai.gpt-6.1-sol":[2.0,10.0,0.1],"global.openai.gpt-6.1-terra":[1.0,5.0,0.05],"global.xai.grok-4.6":[2.0,6.0,0.5],"global.xai.grok-4.7":[2.0,6.0,0.5],"global.zai.glm-5.3":[1.68,5.28,0.312],"google.gemma-3-12b-it":[0.09,0.29,0.09],"google.gemma-3-27b-it":[0.23,0.38,0.23],"google.gemma-3-4b-it":[0.04,0.08,0.04],"google.gemma-4-26b-a4b":[0.13,0.4,0.13],"google.gemma-4-31b":[0.14,0.4,0.14],"google.gemma-4-e2b":[0.04,0.08,0.04],"in.anthropic.claude-haiku-4-5-20251001-v1:0":[1.1,5.5,0.11],"in.anthropic.claude-opus-5":[5.5,27.5,0.55],"in.anthropic.claude-sonnet-5":[2.2,11.0,0.22],"in.openai.gpt-5.6-luna":[0.22,1.32,0.022],"in.openai.gpt-5.6-terra":[2.2,13.2,0.22],"jp.amazon.nova-2-lite-v1:0":[0.396,3.311,0.099],"jp.anthropic.claude-haiku-4-5-20251001-v1:0":[1.1,5.5,0.11],"jp.anthropic.claude-haiku-5-5":[0.11,0.55,0.011],"jp.anthropic.claude-opus-4-7":[5.5,27.5,0.55],"jp.anthropic.claude-opus-4-8":[5.5,27.5,0.55],"jp.anthropic.claude-opus-5":[5.5,27.5,0.55],"jp.anthropic.claude-opus-5-5":[4.4,22.0,0.22],"jp.anthropic.claude-sonnet-4-5-20250929-v1:0":[3.3,16.5,0.33],"jp.anthropic.claude-sonnet-4-6":[3.3,16.5,0.33],"jp.anthropic.claude-sonnet-5":[2.2,11.0,0.22],"meta.llama3-1-70b-instruct-v1:0":[0.72,0.72,0.72],"meta.llama3-1-8b-instruct-v1:0":[0.22,0.22,0.22],"meta.llama3-3-70b-instruct-v1:0":[0.72,0.72,0.72],"meta.llama4-maverick-17b-instruct-v1:0":[0.24,0.97,0.24],"meta.llama4-scout-17b-instruct-v1:0":[0.17,0.66,0.17],"minimax.minimax-m2":[0.3,1.2,0.3],"minimax.minimax-m2.1":[0.3,1.2,0.3],"minimax.minimax-m2.5":[0.3,1.2,0.3],"mistral.devstral-2-123b":[0.4,2.0,0.4],"mistral.magistral-small-2509":[0.5,1.5,0.5],"mistral.ministral-3-14b-instruct":[0.2,0.2,0.2],"mistral.ministral-3-3b-instruct":[0.1,0.1,0.1],"mistral.ministral-3-8b-instruct":[0.15,0.15,0.15],"mistral.mistral-large-3-675b-instruct":[0.5,1.5,0.5],"mistral.pixtral-large-2502-v1:0":[2.0,6.0,2.0],"mistral.voxtral-mini-3b-2507":[0.04,0.04,0.04],"mistral.voxtral-small-24b-2507":[0.1,0.3,0.1],"moonshot.kimi-k2-thinking":[0.6,2.5,0.6],"moonshotai.kimi-k2.5":[0.6,3.0,0.6],"nvidia.nemotron-nano-12b-v2":[0.2,0.6,0.2],"nvidia.nemotron-nano-3-30b":[0.06,0.24,0.06],"nvidia.nemotron-nano-9b-v2":[0.06,0.23,0.06],"nvidia.nemotron-super-3-120b":[0.15,0.65,0.15],"openai.gpt-5.4":[2.75,16.5,0.275],"openai.gpt-5.5":[5.5,33.0,0.55],"openai.gpt-5.6-luna":[0.22,1.32,0.022],"openai.gpt-5.6-sol":[4.4,22.0,0.44],"openai.gpt-5.6-terra":[2.2,13.2,0.22],"openai.gpt-6-astra":[11.0,55.0,1.1],"openai.gpt-6-luna":[0.11,0.55,0.011],"openai.gpt-6-sol":[2.2,11.0,0.22],"openai.gpt-6.1-sol":[2.2,11.0,0.11],"openai.gpt-6.1-terra":[1.1,5.5,0.055],"openai.gpt-oss-120b":[0.15,0.6,0.15],"openai.gpt-oss-120b-1:0":[0.15,0.6,0.15],"openai.gpt-oss-20b":[0.07,0.3,0.07],"openai.gpt-oss-20b-1:0":[0.07,0.3,0.07],"openai.gpt-oss-safeguard-120b":[0.15,0.6,0.15],"openai.gpt-oss-safeguard-20b":[0.07,0.2,0.07],"qwen.qwen3-235b-a22b-2507-v1:0":[0.22,0.88,0.22],"qwen.qwen3-32b-v1:0":[0.15,0.6,0.15],"qwen.qwen3-coder-30b-a3b-v1:0":[0.15,0.6,0.15],"qwen.qwen3-coder-480b-a35b-v1:0":[0.45,1.8,0.45],"qwen.qwen3-coder-next":[0.5,1.2,0.5],"qwen.qwen3-next-80b-a3b":[0.15,1.2,0.15],"qwen.qwen3-vl-235b-a22b":[0.53,2.66,0.53],"us-gov.openai.gpt-oss-120b-1:0":[0.18,0.72,0.18],"us-gov.openai.gpt-oss-20b-1:0":[0.084,0.36,0.084],"us.amazon.nova-2-lite-v1:0":[0.33,2.75,0.0825],"us.amazon.nova-lite-v1:0":[0.06,0.24,0.015],"us.amazon.nova-micro-v1:0":[0.035,0.14,0.00875],"us.amazon.nova-premier-v1:0":[2.5,12.5,0.625],"us.amazon.nova-pro-v1:0":[0.8,3.2,0.2],"us.anthropic.claude-fable-5":[11.0,55.0,1.1],"us.anthropic.claude-fable-5-1":[11.0,55.0,0.275],"us.anthropic.claude-haiku-4-5-20251001-v1:0":[1.1,5.5,0.11],"us.anthropic.claude-haiku-5-5":[0.11,0.55,0.011],"us.anthropic.claude-opus-4-1-20250805-v1:0":[15.0,75.0,1.5],"us.anthropic.claude-opus-4-5-20251101-v1:0":[5.5,27.5,0.55],"us.anthropic.claude-opus-4-6-v1":[5.5,27.5,0.55],"us.anthropic.claude-opus-4-7":[5.5,27.5,0.55],"us.anthropic.claude-opus-4-8":[5.5,27.5,0.55],"us.anthropic.claude-opus-5":[5.5,27.5,0.55],"us.anthropic.claude-opus-5-5":[4.4,22.0,0.22],"us.anthropic.claude-sonnet-4-20250514-v1:0":[3.0,15.0,0.3],"us.anthropic.claude-sonnet-4-5-20250929-v1:0":[3.3,16.5,0.33],"us.anthropic.claude-sonnet-4-6":[3.3,16.5,0.33],"us.anthropic.claude-sonnet-5":[2.2,11.0,0.22],"us.anthropic.claude-sonnet-5-5":[2.2,11.0,0.11],"us.deepseek.r1-v1:0":[1.35,5.4,1.35],"us.meta.llama3-1-70b-instruct-v1:0":[0.72,0.72,0.72],"us.meta.llama3-1-8b-instruct-v1:0":[0.22,0.22,0.22],"us.meta.llama3-3-70b-instruct-v1:0":[0.72,0.72,0.72],"us.meta.llama4-maverick-17b-instruct-v1:0":[0.24,0.97,0.24],"us.meta.llama4-scout-17b-instruct-v1:0":[0.17,0.66,0.17],"us.mistral.pixtral-large-2502-v1:0":[2.0,6.0,2.0],"us.moonshotai.kimi-k3":[3.3,16.5,0.33],"us.openai.gpt-5.6-luna":[0.22,1.32,0.022],"us.openai.gpt-5.6-sol":[4.4,22.0,0.44],"us.openai.gpt-5.6-terra":[2.2,13.2,0.22],"us.openai.gpt-6-astra":[11.0,55.0,1.1],"us.openai.gpt-6-luna":[0.11,0.55,0.011],"us.openai.gpt-6-sol":[2.2,11.0,0.22],"us.openai.gpt-6.1-sol":[2.2,11.0,0.11],"us.openai.gpt-6.1-terra":[1.1,5.5,0.055],"us.writer.palmyra-x4-v1:0":[2.5,10.0,2.5],"us.writer.palmyra-x5-v1:0":[0.6,6.0,0.6],"us.xai.grok-4.6":[2.2,6.6,0.55],"us.xai.grok-4.7":[2.2,6.6,0.55],"us.zai.glm-5.3":[1.848,5.808,0.3432],"writer.palmyra-x4-v1:0":[2.5,10.0,2.5],"writer.palmyra-x5-v1:0":[0.6,6.0,0.6],"xai.grok-4.3":[1.25,2.5,0.2],"xai.grok-4.6":[2.2,6.6,0.55],"zai.glm-4.7":[0.6,2.2,0.6],"zai.glm-4.7-flash":[0.07,0.4,0.07],"zai.glm-5":[1.0,3.2,1.0]},"ambient":{"ambient/large":[0.6,2.0,0.15],"ambient/small":[0.001,0.001],"minimax/minimax-m3":[0.23,0.96,0.05],"qwen/qwen3-30b-a3b-instruct-2507":[0.09,0.3,0.09],"qwen/qwen3.6-27b":[0.32,3.2,0.16],"qwen/qwen3.6-35b-a3b":[0.15,1.0,0.15],"qwen/qwen3.8-27b":[0.32,3.2,0.16],"unsloth/qwen3.8-27b-gguf":[0.001,0.001],"z-ai/glm-5.2":[0.6,2.0,0.15],"zai-org/glm-5.2-fp8":[1.2,4.2,0.26]},"amd":{"deepseek-v4-flash":[0.0,0.0],"deepseek-v4-flash-vision-exp":[0.0,0.0],"deepseek-v4.1-flash":[0.0,0.0],"gemma-4-31b-it":[0.0,0.0],"glm-5.3-flash":[0.0,0.0],"mimo-v2.6-flash":[0.0,0.0],"minicpm-v-4.7-1b":[0.0,0.0],"minicpm-v-4.7-35b-a3b":[0.0,0.0],"minicpm5-2b":[0.0,0.0],"qwen3.8-27b":[0.0,0.0],"qwen3.8-flash-next":[0.0,0.0]},"anthropic":{"claude-fable-5":[10.0,50.0,1.0],"claude-fable-5-1":[10.0,50.0,0.25],"claude-haiku-4-5":[1.0,5.0,0.1],"claude-haiku-4-5-20251001":[1.0,5.0,0.1],"claude-haiku-5-5":[0.1,0.5,0.01],"claude-opus-4-5":[5.0,25.0,0.5],"claude-opus-4-5-20251101":[5.0,25.0,0.5],"claude-opus-4-6":[5.0,25.0,0.5],"claude-opus-4-7":[5.0,25.0,0.5],"claude-opus-4-8":[5.0,25.0,0.5],"claude-opus-5":[5.0,25.0,0.5],"claude-opus-5-5":[4.0,20.0,0.2],"claude-sonnet-4-5":[3.0,15.0,0.3],"claude-sonnet-4-5-20250929":[3.0,15.0,0.3],"claude-sonnet-4-6":[3.0,15.0,0.3],"claude-sonnet-5":[2.0,10.0,0.2],"claude-sonnet-5-5":[2.0,10.0,0.1]},"arcee":{"deepseek/deepseek-v4-flash-latest":[0.14,0.28,0.028],"deepseek/deepseek-v4-pro":[1.74,3.48,0.2],"deepseek/deepseek-v4-pro-0813":[1.32,3.96,0.044],"deepseek/deepseek-v4.1-flash":[0.22,0.66,0.007],"deepseek/deepseek-v4.1-flash-1017":[0.3,1.2,0.006],"moonshotai/kimi-k3":[3.0,15.0,0.3],"thinkingmachines/inkling-small":[0.5,1.2,0.1],"trinity-large-thinking":[0.25,0.8,0.06],"zai-org/glm-5.2":[1.4,4.4,0.26],"zai-org/glm-5.3":[1.4,4.4,0.26],"zai-org/glm-5.3-flash":[0.15,0.5,0.03]},"atomic-chat":{"gemma-4-e4b-it-iq4_xs":[0.0,0.0],"gemma-4-e4b-it-mlx-4bit":[0.0,0.0],"meta-llama-3_1-8b-instruct-gguf":[0.0,0.0],"qwen3_5-9b-mlx-4bit":[0.0,0.0],"qwen3_5-9b-q4_k_m":[0.0,0.0]},"auriko":{"claude-opus-4-6":[5.0,25.0,0.5],"claude-opus-4-7":[5.0,25.0,0.5],"claude-sonnet-4-6":[3.0,15.0,0.3],"deepseek-v4-flash":[0.14,0.28,0.0028],"deepseek-v4-pro":[1.32,3.96,0.044],"gemini-2.5-flash":[0.3,2.5,0.03],"gemini-2.5-pro":[1.25,10.0,0.125],"gemini-3.1-pro-preview":[2.0,12.0,0.2],"glm-5.1":[1.4,4.4,0.26],"grok-4.3":[1.25,2.5,0.2],"kimi-k2.5":[0.45,2.25,0.07],"kimi-k2.6":[0.95,4.0,0.16],"minimax-m2-7":[0.3,1.2,0.06],"minimax-m2-7-highspeed":[0.6,2.4,0.06],"qwen-3.6-plus":[0.5,3.0,0.1]},"azure":{"claude-fable-5":[10.0,50.0,1.0],"claude-fable-5-1":[10.0,50.0,0.25],"claude-haiku-4-5":[1.0,5.0,0.1],"claude-haiku-5-5":[0.1,0.5,0.01],"claude-mythos-5":[10.0,50.0,1.0],"claude-opus-4-5":[5.0,25.0,0.5],"claude-opus-4-6":[5.0,25.0,0.5],"claude-opus-4-7":[5.0,25.0,0.5],"claude-opus-4-8":[5.0,25.0,0.5],"claude-opus-5":[5.0,25.0,0.5],"claude-opus-5-5":[4.0,20.0,0.2],"claude-sonnet-4-5":[3.0,15.0,0.3],"claude-sonnet-4-6":[3.0,15.0,0.3],"claude-sonnet-5":[2.0,10.0,0.2],"claude-sonnet-5-5":[2.0,10.0,0.2],"codestral-2501":[0.3,0.9,0.3],"codex-mini":[1.5,6.0,0.375],"cohere-command-a":[2.5,10.0,2.5],"cohere-embed-v-4-0":[0.12,0.0,0.12],"cohere-embed-v3-english":[0.1,0.0,0.1],"cohere-embed-v3-multilingual":[0.1,0.0,0.1],"deepseek-v3.2":[0.58,1.68,0.58],"deepseek-v3.2-speciale":[0.58,1.68,0.58],"deepseek-v4-flash":[0.19,0.51,0.19],"deepseek-v4-pro":[1.74,3.48,1.74],"deepseek-v4.1-flash":[0.3,1.2,0.006],"gpt-3.5-turbo-0125":[0.5,1.5,0.5],"gpt-3.5-turbo-1106":[1.0,2.0,1.0],"gpt-3.5-turbo-instruct":[1.5,2.0,1.5],"gpt-4-turbo":[10.0,30.0,10.0],"gpt-4-turbo-vision":[10.0,30.0,10.0],"gpt-4.1":[2.0,8.0,0.5],"gpt-4.1-mini":[0.4,1.6,0.1],"gpt-4.1-nano":[0.1,0.4,0.025],"gpt-4o":[2.5,10.0,1.25],"gpt-4o-mini":[0.15,0.6,0.075],"gpt-5":[1.25,10.0,0.125],"gpt-5-codex":[1.25,10.0,0.125],"gpt-5-mini":[0.25,2.0,0.025],"gpt-5-nano":[0.05,0.4,0.005],"gpt-5-pro":[15.0,120.0,15.0],"gpt-5.1":[1.25,10.0,0.125],"gpt-5.1-codex":[1.25,10.0,0.125],"gpt-5.1-codex-max":[1.25,10.0,0.125],"gpt-5.1-codex-mini":[0.25,2.0,0.025],"gpt-5.2":[1.75,14.0,0.175],"gpt-5.2-codex":[1.75,14.0,0.175],"gpt-5.3-codex":[1.75,14.0,0.175],"gpt-5.4":[2.5,15.0,0.25],"gpt-5.4-mini":[0.75,4.5,0.075],"gpt-5.4-nano":[0.2,1.25,0.02],"gpt-5.4-pro":[30.0,180.0,30.0],"gpt-5.5":[5.0,30.0,0.5],"gpt-5.6-luna":[0.2,1.2,0.02],"gpt-5.6-sol":[4.0,20.0,0.4],"gpt-5.6-terra":[2.0,12.0,0.2],"gpt-6-astra":[10.0,50.0,1.0],"gpt-6-luna":[0.1,0.5,0.01],"gpt-6-sol":[2.0,10.0,0.2],"gpt-6.1-sol":[2.0,10.0,0.1],"gpt-6.1-terra":[1.0,5.0,0.05],"gpt-chat-latest":[5.0,30.0,0.5],"gpt-image-1":[5.0,40.0,1.25],"gpt-image-1.5":[5.0,32.0,1.25],"gpt-image-2":[5.0,30.0,1.25],"gpt-image-2.5-flare":[5.0,30.0,1.25],"gpt-image-2.5-sunburst":[5.0,30.0,1.25],"grok-4-1-fast-non-reasoning":[0.2,0.5,0.05],"grok-4-1-fast-reasoning":[0.2,0.5,0.05],"grok-4-20-non-reasoning":[2.0,6.0,2.0],"grok-4-20-reasoning":[2.0,6.0,2.0],"grok-4.6":[2.0,6.0,0.5],"kimi-k2.5":[0.6,3.0,0.6],"kimi-k2.6":[0.95,4.0,0.95],"kimi-k2.7-code":[0.95,4.0,0.19],"llama-3.3-70b-instruct":[0.71,0.71,0.71],"llama-4-maverick-17b-128e-instruct-fp8":[0.25,1.0,0.25],"llama-4-scout-17b-16e-instruct":[0.2,0.78,0.2],"ministral-3b":[0.04,0.04,0.04],"mistral-medium-2505":[0.4,2.0,0.4],"mistral-small-2503":[0.1,0.3,0.1],"model-router":[0.14,0.0,0.14],"o1":[15.0,60.0,7.5],"o3":[2.0,8.0,0.5],"o3-mini":[1.1,4.4,0.55],"o4-mini":[1.1,4.4,0.275],"phi-4":[0.125,0.5,0.125],"phi-4-mini":[0.075,0.3,0.075],"phi-4-mini-reasoning":[0.075,0.3,0.075],"phi-4-multimodal":[0.08,0.32,0.08],"phi-4-reasoning":[0.125,0.5,0.125],"phi-4-reasoning-plus":[0.125,0.5,0.125],"text-embedding-3-large":[0.13,0.0,0.13],"text-embedding-3-small":[0.02,0.0,0.02],"text-embedding-ada-002":[0.1,0.0,0.1]},"azure-cognitive-services":{"claude-fable-5":[10.0,50.0,1.0],"claude-fable-5-1":[10.0,50.0,0.25],"claude-haiku-4-5":[1.0,5.0,0.1],"claude-haiku-5-5":[0.1,0.5,0.01],"claude-mythos-5":[10.0,50.0,1.0],"claude-opus-4-5":[5.0,25.0,0.5],"claude-opus-4-6":[5.0,25.0,0.5],"claude-opus-4-7":[5.0,25.0,0.5],"claude-opus-4-8":[5.0,25.0,0.5],"claude-opus-5":[5.0,25.0,0.5],"claude-opus-5-5":[4.0,20.0,0.2],"claude-sonnet-4-5":[3.0,15.0,0.3],"claude-sonnet-4-6":[3.0,15.0,0.3],"claude-sonnet-5":[2.0,10.0,0.2],"claude-sonnet-5-5":[2.0,10.0,0.2],"codestral-2501":[0.3,0.9,0.3],"codex-mini":[1.5,6.0,0.375],"cohere-command-a":[2.5,10.0,2.5],"cohere-embed-v-4-0":[0.12,0.0,0.12],"cohere-embed-v3-english":[0.1,0.0,0.1],"cohere-embed-v3-multilingual":[0.1,0.0,0.1],"deepseek-v3.2":[0.58,1.68,0.58],"deepseek-v3.2-speciale":[0.58,1.68,0.58],"deepseek-v4-flash":[0.19,0.51,0.19],"deepseek-v4-pro":[1.74,3.48,1.74],"deepseek-v4.1-flash":[0.3,1.2,0.006],"gpt-3.5-turbo-0125":[0.5,1.5,0.5],"gpt-3.5-turbo-1106":[1.0,2.0,1.0],"gpt-3.5-turbo-instruct":[1.5,2.0,1.5],"gpt-4-turbo":[10.0,30.0,10.0],"gpt-4-turbo-vision":[10.0,30.0,10.0],"gpt-4.1":[2.0,8.0,0.5],"gpt-4.1-mini":[0.4,1.6,0.1],"gpt-4.1-nano":[0.1,0.4,0.025],"gpt-4o":[2.5,10.0,1.25],"gpt-4o-mini":[0.15,0.6,0.075],"gpt-5":[1.25,10.0,0.125],"gpt-5-codex":[1.25,10.0,0.125],"gpt-5-mini":[0.25,2.0,0.025],"gpt-5-nano":[0.05,0.4,0.005],"gpt-5-pro":[15.0,120.0,15.0],"gpt-5.1":[1.25,10.0,0.125],"gpt-5.1-codex":[1.25,10.0,0.125],"gpt-5.1-codex-max":[1.25,10.0,0.125],"gpt-5.1-codex-mini":[0.25,2.0,0.025],"gpt-5.2":[1.75,14.0,0.175],"gpt-5.2-codex":[1.75,14.0,0.175],"gpt-5.3-codex":[1.75,14.0,0.175],"gpt-5.4":[2.5,15.0,0.25],"gpt-5.4-mini":[0.75,4.5,0.075],"gpt-5.4-nano":[0.2,1.25,0.02],"gpt-5.4-pro":[30.0,180.0,30.0],"gpt-5.5":[5.0,30.0,0.5],"gpt-5.6-luna":[0.2,1.2,0.02],"gpt-5.6-sol":[4.0,20.0,0.4],"gpt-5.6-terra":[2.0,12.0,0.2],"gpt-6-astra":[10.0,50.0,1.0],"gpt-6-luna":[0.1,0.5,0.01],"gpt-6-sol":[2.0,10.0,0.2],"gpt-6.1-sol":[2.0,10.0,0.1],"gpt-6.1-terra":[1.0,5.0,0.05],"gpt-chat-latest":[5.0,30.0,0.5],"gpt-image-1":[5.0,40.0,1.25],"gpt-image-1.5":[5.0,32.0,1.25],"gpt-image-2":[5.0,30.0,1.25],"gpt-image-2.5-flare":[5.0,30.0,1.25],"gpt-image-2.5-sunburst":[5.0,30.0,1.25],"grok-4-1-fast-non-reasoning":[0.2,0.5,0.05],"grok-4-1-fast-reasoning":[0.2,0.5,0.05],"grok-4-20-non-reasoning":[2.0,6.0,2.0],"grok-4-20-reasoning":[2.0,6.0,2.0],"grok-4.6":[2.0,6.0,0.5],"kimi-k2.5":[0.6,3.0,0.6],"kimi-k2.6":[0.95,4.0,0.95],"kimi-k2.7-code":[0.95,4.0,0.19],"llama-3.3-70b-instruct":[0.71,0.71,0.71],"llama-4-maverick-17b-128e-instruct-fp8":[0.25,1.0,0.25],"llama-4-scout-17b-16e-instruct":[0.2,0.78,0.2],"ministral-3b":[0.04,0.04,0.04],"mistral-medium-2505":[0.4,2.0,0.4],"mistral-small-2503":[0.1,0.3,0.1],"model-router":[0.14,0.0,0.14],"o1":[15.0,60.0,7.5],"o3":[2.0,8.0,0.5],"o3-mini":[1.1,4.4,0.55],"o4-mini":[1.1,4.4,0.275],"phi-4":[0.125,0.5,0.125],"phi-4-mini":[0.075,0.3,0.075],"phi-4-mini-reasoning":[0.075,0.3,0.075],"phi-4-multimodal":[0.08,0.32,0.08],"phi-4-reasoning":[0.125,0.5,0.125],"phi-4-reasoning-plus":[0.125,0.5,0.125],"text-embedding-3-large":[0.13,0.0,0.13],"text-embedding-3-small":[0.02,0.0,0.02],"text-embedding-ada-002":[0.1,0.0,0.1]},"bailing":{"ling-1t":[0.57,2.29,0.57],"ring-1t":[0.57,2.29,0.57]},"baseten":{"deepseek-ai/deepseek-v4-flash-0731":[0.13,0.26,0.028],"deepseek-ai/deepseek-v4-pro-0813":[1.32,3.96,0.132],"deepseek-ai/deepseek-v4.1-flash":[0.3,1.2,0.007],"deepseek-ai/deepseek-v4.1-flash-1017":[0.3,1.2,0.007],"deepseek-ai/deepseek-v4.1-flash-1017-fast":[0.6,2.4,0.014],"deepseek-ai/deepseek-v4.1-flash-fast":[0.6,2.4,0.014],"moonshotai/kimi-k3":[3.0,15.0,0.3],"nvidia/nvidia-nemotron-3-ultra-550b-a55b":[0.6,2.4,0.12],"openai/gpt-oss-120b":[0.1,0.5,0.1],"zai-org/glm-5.2":[1.4,4.4,0.14],"zai-org/glm-5.2-fast":[2.1,6.6,0.21],"zai-org/glm-5.3":[1.4,4.4,0.14],"zai-org/glm-5.3-fast":[2.1,6.6,0.21],"zai-org/glm-5.3-flash":[0.15,0.5,0.03]},"bee":{"bee-brood":[0.6,2.4,0.06],"bee-buzz":[2.5,10.0,0.25],"bee-cell":[0.3,1.2,0.03],"bee-comb":[1.25,5.0,0.125],"bee-hive":[5.0,20.0,0.5],"bee-swarm":[25.0,150.0,2.5]},"berget":{"google/gemma-4-31b-it":[0.280375,0.56075,0.280375],"mistralai/mistral-small-3.2-24b-instruct-2506":[0.33645,0.33645,0.33645],"moonshotai/kimi-k3":[3.3645,16.8225,1.00935],"qwen/qwen3.8-27b-fp8":[0.46,3.48,0.46],"zai-org/glm-5.2":[1.54,4.84,1.54],"zai-org/glm-5.3-flash":[0.29,0.58,0.29]},"bothub":{"deepseek-v4-flash-0731":[0.589,1.7671,0.589],"deepseek-v4-pro-0813":[1.7671,5.3011,1.7671],"gemma-4-31b-it:free":[0.0,0.0],"glm-5.3":[1.4243,4.4765,1.4243],"glm-5.3-flash":[0.1566,0.522,0.1566],"gpt-5.6-luna":[0.2677,1.6064,0.2677],"muse-spark-1.3-contributor":[0.1,0.2,0.1],"nemotron-3-ultra-550b-a55b:free":[0.0,0.0]},"boundless":{"claude-fable-5.1":[10.0,50.0,0.25],"claude-opus-5":[5.0,25.0,0.5],"claude-opus-5.5":[4.0,20.0,0.2],"deepseek-v4-pro-0813":[1.04,2.08,0.0352],"deepseek-v4.1-flash":[0.2,1.0,0.01],"dsv4":[0.04,0.21,0.02],"glm-5.2":[0.34,2.3,0.17],"glm-5.3":[1.12,3.52,0.14],"glm-5.3-flash":[0.12,0.4,0.024],"gpt-5.6-luna":[0.2,1.2,0.02],"gpt-5.6-sol":[2.0,10.0,0.2],"gpt-6-luna":[0.1,0.5,0.01],"gpt-6-sol":[2.0,10.0,0.2],"kimi-k3":[2.3,11.4,0.23],"mimo-v2.6-flash":[0.14,0.28,0.0028],"mimo-v2.6-pro":[0.435,0.87,0.0036],"minimax-m3":[0.28,1.1,0.056],"nemotron3-super":[0.12,0.52,0.06],"qwen3.6":[0.04,0.35,0.02],"qwen3.8-flash":[0.15,0.47,0.016]},"cerebras":{"gpt-oss-120b":[0.35,0.75,0.35],"qwen-3.8-27b":[0.99,1.49,0.99]},"chutes":{"deepseek-ai/deepseek-v3.2-tee":[1.0,1.0,0.09999999999999998],"deepseek-ai/deepseek-v4-flash-0731-tee":[0.44,1.32,0.04399999999999999],"google/gemma-4-31b-turbo-tee":[0.12,0.37,0.011999999999999997],"moonshotai/kimi-k2.6-tee":[0.39,1.8,0.03899999999999999],"moonshotai/kimi-k3-tee":[1.85,9.5,0.18499999999999997],"qwen/qwen3.5-397b-a17b-tee":[0.45,3.0,0.04499999999999999],"qwen/qwen3.6-27b-tee":[0.25,2.0,0.024999999999999994],"qwen/qwen3.8-27b-tee":[0.039,1.25,0.003899999999999999],"zai-org/glm-5.1-tee":[0.9,2.9,0.08999999999999998],"zai-org/glm-5.2-tee":[1.25,3.95,0.12499999999999997]},"clarifai":{"arcee_ai/afm/models/trinity-mini":[0.045,0.15,0.045],"clarifai/main/models/mm-poly-8b":[0.658,1.11,0.658],"deepseek-ai/deepseek-ocr/models/deepseek-ocr":[0.2,0.7,0.2],"minimaxai/chat-completion/models/minimax-m2_5-high-throughput":[0.3,1.2,0.3],"mistralai/completion/models/ministral-3-14b-reasoning-2512":[2.5,1.7,2.5],"mistralai/completion/models/ministral-3-3b-reasoning-2512":[1.039,0.54825,1.039],"moonshotai/chat-completion/models/kimi-k2_6":[0.95,4.0,0.95],"openai/chat-completion/models/gpt-oss-120b-high-throughput":[0.09,0.36,0.09],"openai/chat-completion/models/gpt-oss-20b":[0.045,0.18,0.045],"qwen/qwencoder/models/qwen3-coder-30b-a3b-instruct":[0.11458,0.74812,0.11458],"qwen/qwenlm/models/qwen3-30b-a3b-instruct-2507":[0.3,0.5,0.3],"qwen/qwenlm/models/qwen3-30b-a3b-thinking-2507":[0.36,1.3,0.36]},"claudinio":{"claudinio":[0.5,2.0,0.15],"claudius":[3.0,8.0,0.9]},"cline-pass":{"cline-pass/deepseek-v4-flash":[0.14,0.28,0.0028],"cline-pass/deepseek-v4-pro":[0.66,1.98,0.022],"cline-pass/deepseek-v4.1-flash":[0.15,0.6,0.003],"cline-pass/glm-5.2":[1.4,4.4,0.26],"cline-pass/glm-5.3":[1.4,4.4,0.26],"cline-pass/glm-5.3-flash":[0.15,0.5,0.03],"cline-pass/kimi-k2.6":[0.95,4.0,0.16],"cline-pass/kimi-k2.7-code":[0.95,4.0,0.19],"cline-pass/kimi-k3":[3.0,15.0,0.3],"cline-pass/mimo-v2.5":[0.14,0.28,0.0028],"cline-pass/mimo-v2.5-pro":[1.74,3.48,0.0145],"cline-pass/mimo-v2.6-flash":[0.14,0.28,0.0028],"cline-pass/mimo-v2.6-pro":[0.435,0.87,0.0036],"cline-pass/minimax-m3":[0.3,1.2,0.06],"cline-pass/muse-spark-1.3-contributor":[0.1,0.2,0.002],"cline-pass/qwen3.7-max":[2.5,7.5,0.5],"cline-pass/qwen3.7-plus":[0.4,1.6,0.04],"cline-pass/qwen3.8-max":[2.0,6.0,0.25]},"cloudferro-sherlock":{"meta-llama/llama-3.3-70b-instruct":[2.92,2.92,2.92],"minimaxai/minimax-m2.5":[0.3,1.2,0.3],"openai/gpt-oss-120b":[2.92,2.92,2.92],"speakleash/bielik-11b-v3.0-instruct":[0.67,0.67,0.67],"zai-org/glm-5.3":[0.34,4.48,0.34]},"cloudflare-ai-gateway":{"alibaba/qwen3-max":[1.2,6.0,1.2],"alibaba/qwen3.5-397b-a17b":[0.6,3.6,0.6],"alibaba/qwen3.7-max":[1.25,3.75,0.25],"alibaba/qwen3.7-plus":[0.32,1.28,0.064],"alibaba/qwen3.8-max":[2.0,6.0,0.25],"anthropic/claude-fable-5":[10.0,50.0,1.0],"anthropic/claude-fable-5.1":[10.0,50.0,0.25],"anthropic/claude-haiku-4.5":[1.0,5.0,0.1],"anthropic/claude-haiku-5.5":[0.1,0.5,0.01],"anthropic/claude-opus-4.5":[5.0,25.0,0.5],"anthropic/claude-opus-4.6":[5.0,25.0,0.5],"anthropic/claude-opus-4.7":[5.0,25.0,0.5],"anthropic/claude-opus-4.8":[5.0,25.0,0.5],"anthropic/claude-opus-5":[5.0,25.0,0.5],"anthropic/claude-opus-5.5":[4.0,20.0,0.2],"anthropic/claude-sonnet-4.5":[3.0,15.0,0.3],"anthropic/claude-sonnet-4.6":[3.0,15.0,0.3],"anthropic/claude-sonnet-5":[2.0,10.0,0.2],"anthropic/claude-sonnet-5.5":[2.0,10.0,0.2],"deepseek/deepseek-v4-pro":[1.74,3.48,0.145],"fireworks/ember-1":[3.0,15.0,0.3],"google/gemini-2.5-flash":[0.3,2.5,0.03],"google/gemini-2.5-flash-lite":[0.1,0.4,0.01],"google/gemini-2.5-pro":[1.25,10.0,0.125],"google/gemini-3-flash":[0.5,3.0,0.05],"google/gemini-3.1-flash-lite":[0.25,1.5,0.03],"google/gemini-3.1-pro":[2.0,12.0,0.2],"google/gemini-3.5-flash":[1.5,9.0,0.15],"google/gemini-3.5-flash-lite":[0.3,2.5,0.03],"google/gemini-3.6-flash":[1.5,7.5,0.15],"google/gemini-3.7-flash":[0.75,3.75,0.075],"google/gemini-3.8-flash":[0.75,3.75,0.075],"google/gemini-4-argon":[2.0,10.0,0.1],"meta/muse-spark-1.1":[1.25,4.25,0.16],"meta/muse-spark-1.2":[1.25,4.25,0.16],"meta/muse-spark-1.3":[1.25,4.25,0.16],"meta/muse-spark-open":[1.25,4.25,0.15],"meta/muse-wonder-1.0":[4.0,20.0,0.2],"minimax/m3.1-flash":[0.15,0.6,0.015],"moonshotai/kimi-k3":[3.0,15.0,0.3],"openai/gpt-4.1":[2.0,8.0,0.5],"openai/gpt-4.1-mini":[0.4,1.6,0.1],"openai/gpt-4.1-nano":[0.1,0.4,0.025],"openai/gpt-4o":[1.25,5.0,0.625],"openai/gpt-4o-mini":[0.075,0.3,0.0375],"openai/gpt-5":[1.25,10.0,0.125],"openai/gpt-5-mini":[0.25,2.0,0.025],"openai/gpt-5-nano":[0.05,0.4,0.005],"openai/gpt-5.1":[1.25,10.0,0.125],"openai/gpt-5.4":[2.5,15.0,0.25],"openai/gpt-5.4-mini":[0.75,4.5,0.075],"openai/gpt-5.4-nano":[0.2,1.25,0.02],"openai/gpt-5.4-pro":[30.0,180.0,30.0],"openai/gpt-5.5":[5.0,30.0,5.0],"openai/gpt-5.5-pro":[30.0,180.0,30.0],"openai/gpt-5.6-luna":[0.2,1.2,0.02],"openai/gpt-5.6-sol":[4.0,20.0,0.4],"openai/gpt-5.6-terra":[2.0,12.0,0.2],"openai/gpt-6-astra":[10.0,50.0,1.0],"openai/gpt-6-luna":[0.1,0.5,0.01],"openai/gpt-6-sol":[2.0,10.0,0.2],"openai/gpt-6.1-sol":[2.0,10.0,0.1],"openai/gpt-6.1-terra":[1.0,5.0,0.05],"openai/o3":[2.0,8.0,0.5],"openai/o3-mini":[1.1,4.4,0.55],"openai/o4-mini":[1.1,4.4,0.275],"reflection-ai/beam-1.0-501b-a23b":[0.0,0.0],"unbiased/pareto":[2.5,7.5,0.25],"xai/grok-4.20-0309-non-reasoning":[2.0,6.0,0.2],"xai/grok-4.20-0309-reasoning":[2.0,6.0,0.2],"xai/grok-4.3":[1.25,2.5,0.2],"xai/grok-4.5":[2.0,6.0,0.3],"xai/grok-4.6":[2.0,6.0,0.5],"xai/grok-4.7":[2.0,6.0,0.5]},"cloudflare-workers-ai":{"@cf/aisingapore/gemma-sea-lion-v4-27b-it":[0.351,0.555,0.351],"@cf/deepseek-ai/deepseek-r1-distill-qwen-32b":[0.497,4.881,0.497],"@cf/deepseek-ai/deepseek-v4-flash-0731":[0.44,1.32,0.014],"@cf/deepseek-ai/deepseek-v4-pro-0813":[1.32,3.96,0.044],"@cf/deepseek-ai/deepseek-v4.1-flash-1017":[0.3,1.2,0.006],"@cf/google/gemma-4-26b-a4b-it":[0.1,0.3,0.05],"@cf/ibm-granite/granite-4.0-h-micro":[0.017,0.112,0.017],"@cf/meta/llama-3.1-8b-instruct-fp8":[0.152,0.287,0.152],"@cf/meta/llama-3.2-11b-vision-instruct":[0.0485,0.676,0.0485],"@cf/meta/llama-3.2-1b-instruct":[0.027,0.201,0.027],"@cf/meta/llama-3.2-3b-instruct":[0.0509,0.335,0.0509],"@cf/meta/llama-3.3-70b-instruct-fp8-fast":[0.293,2.253,0.293],"@cf/meta/llama-4-scout-17b-16e-instruct":[0.27,0.85,0.27],"@cf/meta/llama-guard-3-8b":[0.484,0.03,0.484],"@cf/mistralai/mistral-small-3.1-24b-instruct":[0.351,0.555,0.351],"@cf/moonshotai/kimi-k2.6":[0.95,4.0,0.16],"@cf/moonshotai/kimi-k2.7-code":[0.95,4.0,0.19],"@cf/nvidia/nemotron-3-120b-a12b":[0.5,1.5,0.5],"@cf/openai/gpt-oss-120b":[0.35,0.75,0.35],"@cf/openai/gpt-oss-20b":[0.2,0.3,0.2],"@cf/qwen/qwen2.5-coder-32b-instruct":[0.66,1.0,0.66],"@cf/qwen/qwen3-30b-a3b-fp8":[0.0509,0.335,0.0509],"@cf/qwen/qwen3.8-27b":[0.45,3.2,0.05],"@cf/qwen/qwq-32b":[0.66,1.0,0.66],"@cf/zai-org/glm-4.7-flash":[0.0605,0.4,0.0605],"@cf/zai-org/glm-5.2":[1.4,4.4,0.26],"@cf/zai-org/glm-5.3":[1.4,4.4,0.26],"@cf/zai-org/glm-5.3-flash":[0.15,0.5,0.03]},"cohere":{"c4ai-aya-expanse-32b":[0.5,1.5,0.5],"command-a-03-2025":[2.5,10.0,2.5],"command-a-plus-05-2026":[2.5,10.0,2.5],"command-a-reasoning-08-2025":[2.5,10.0,2.5],"command-a-translate-08-2025":[2.5,10.0,2.5],"command-a-vision-07-2025":[2.5,10.0,2.5],"command-r-08-2024":[0.15,0.6,0.15],"command-r-plus-08-2024":[2.5,10.0,2.5],"command-r7b-12-2024":[0.0375,0.15,0.0375],"command-r7b-arabic-02-2025":[0.0375,0.15,0.0375],"north-mini-code-1-0":[0.0,0.0],"north-small-translate-09-2026":[0.0,0.0]},"commandcode":{"claude-fable-5":[10.0,50.0,1.0],"claude-fable-5-1":[10.0,50.0,0.25],"claude-haiku-4-5-20251001":[1.0,5.0,0.1],"claude-haiku-5-5":[0.1,0.5,0.01],"claude-opus-4-7":[5.0,25.0,0.5],"claude-opus-4-8":[5.0,25.0,0.5],"claude-opus-5":[5.0,25.0,0.5],"claude-opus-5-5":[4.0,20.0,0.2],"claude-sonnet-4-6":[3.0,15.0,0.3],"claude-sonnet-5":[2.0,10.0,0.2],"claude-sonnet-5-5":[2.0,10.0,0.1],"deepseek/deepseek-v4-flash":[0.15,0.6,0.003],"deepseek/deepseek-v4-flash-fast":[0.28,0.56,0.07],"deepseek/deepseek-v4-flash-vision-exp":[0.15,0.6,0.003],"deepseek/deepseek-v4-pro":[0.66,1.98,0.022],"deepseek/deepseek-v4.1-flash":[0.15,0.6,0.003],"deepseek/deepseek-v4.1-flash-fast":[0.16,0.58,0.016],"google/gemini-3.1-flash-lite":[0.25,1.5,0.03],"google/gemini-3.5-flash":[1.5,9.0,0.15],"google/gemini-3.5-flash-lite":[0.3,2.5,0.03],"google/gemini-3.6-flash":[1.5,7.5,0.15],"google/gemini-3.7-flash":[1.5,7.5,0.15],"google/gemini-3.8-flash":[1.5,7.5,0.15],"google/gemini-4-argon":[2.0,10.0,0.1],"gpt-5.3-codex":[2.0,8.0,0.5],"gpt-5.4":[2.5,15.0,0.25],"gpt-5.4-mini":[0.75,4.5,0.075],"gpt-5.5":[5.0,30.0,0.5],"gpt-5.6-luna":[0.2,1.2,0.02],"gpt-5.6-sol":[5.0,30.0,0.5],"gpt-5.6-terra":[2.0,12.0,0.2],"gpt-6-astra":[10.0,50.0,1.0],"gpt-6-luna":[0.1,0.5,0.01],"gpt-6-sol":[2.0,10.0,0.2],"gpt-6.1-sol":[2.0,10.0,0.1],"gpt-6.1-terra":[1.0,5.0,0.05],"inclusionai/ling-3.1-flash:free":[0.0,0.0],"meta/muse-spark-1.1":[1.25,4.25,0.15],"meta/muse-spark-1.2":[1.25,4.25,0.15],"meta/muse-spark-1.2-contributor":[0.1,0.2,0.002],"meta/muse-spark-1.3":[1.25,4.25,0.15],"meta/muse-spark-1.3-contributor":[0.1,0.2,0.002],"meta/muse-wonder-1.0":[4.0,20.0,0.2],"minimaxai/minimax-m2.5":[0.3,1.2,0.03],"minimaxai/minimax-m2.7":[0.3,1.2,0.06],"minimaxai/minimax-m3":[0.3,1.2,0.06],"mistral/mistral-large-4":[1.36,4.18,0.14],"moonshotai/kimi-k2.7-code":[0.95,4.0,0.19],"moonshotai/kimi-k2.7-code-highspeed":[1.9,8.0,0.38],"moonshotai/kimi-k3":[3.0,15.0,0.3],"nvidia/nemotron-3-ultra-550b-a55b":[0.6,2.4,0.12],"qwen/qwen3.8-27b":[0.4,3.0,0.04],"qwen/qwen3.8-flash":[0.16,0.47,0.016],"qwen/qwen3.8-max":[2.0,6.0,0.25],"qwen/qwen3.8-max-0902":[2.0,6.0,0.25],"qwen/qwen3.8-omni-flash":[0.15,0.47,0.016],"sakana/fugu-ultra":[5.0,30.0,0.5],"stepfun/step-3.5-flash":[0.09,0.3,0.02],"stepfun/step-3.7-flash":[0.2,1.15,0.04],"stepfun/step-5-preview":[1.0,2.7,0.05],"tencent/hy3-paid":[0.14,0.58,0.035],"tencent/hy4-preview":[0.834,2.501,0.042],"thinkingmachines/inkling":[1.0,4.05,0.17],"thinkingmachines/inkling-small":[0.5,1.2,0.1],"xai/grok-4.5":[2.0,6.0,0.5],"xai/grok-4.6":[2.0,6.0,0.5],"xai/grok-4.7":[2.0,6.0,0.5],"z-ai/glm-5.3-flash":[0.15,0.5,0.03],"z-ai/glm-5.3-flashx":[0.37,1.25,0.075],"zai-org/glm-5.2":[1.4,4.4,0.26],"zai-org/glm-5.2-fast":[3.0,10.25,0.5],"zai-org/glm-5.3":[1.4,4.4,0.26]},"coralbricks":{"deepseek-v4.1-flash-fast":[0.25,1.2,0.005]},"cortecs":{"apertus-70b":[1.393,2.228,1.393],"claude-4-5-sonnet":[2.989,14.945,0.326],"claude-4-6-sonnet":[3.196,15.94,0.32],"claude-haiku-4-5":[0.996,4.982,0.099],"claude-haiku-5.5":[0.113,0.563,0.011],"claude-opus-5":[5.5,27.498,0.55],"claude-opus-5.5":[4.399,21.998,0.219],"claude-opus4-5":[5.313,26.568,0.531],"claude-opus4-6":[5.313,26.561,0.531],"claude-opus4-7":[5.437,27.186,0.544],"claude-opus4-8":[5.437,27.186,0.544],"claude-sonnet-5":[2.2,11.0,0.219],"claude-sonnet-5.5":[2.25,11.249,0.225],"codestral-2508":[0.368,1.103,0.037],"deepseek-v3.2":[0.5,1.499,0.15],"deepseek-v4-flash-0731":[0.082,0.413,0.06],"deepseek-v4-pro":[1.7,3.4,0.15],"deepseek-v4-pro-0813":[2.0,3.999,0.5],"deepseek-v4.1-flash":[0.3,1.2,0.075],"deepseek-v4.1-flash-1017":[0.203,0.609,0.006],"devstral-2512":[0.478,2.392,0.045],"gemini-2.5-flash":[0.299,2.491,0.029],"gemini-2.5-pro":[1.495,9.964,0.242],"gemini-3.1-flash-lite":[0.272,1.631,0.025],"gemini-3.5-flash":[1.649,9.899,0.165],"gemini-3.5-flash-lite":[0.33,2.749,0.033],"gemini-3.6-flash":[0.75,3.75,0.075],"gemini-3.7-flash":[0.75,3.75,0.075],"gemini-3.8-flash":[0.825,4.125,0.082],"gemini-4-argon":[2.25,11.249,0.113],"gemma-3-27b-it":[0.099,0.299,0.099],"gemma-4-26b-a4b-it":[0.111,0.557,0.111],"gemma-4-31b-it":[0.223,0.39,0.223],"glm-4.7-flash":[0.08,0.478,0.08],"glm-5.1":[1.384,4.348,0.346],"glm-5.2":[0.9,3.24,0.189],"glm-5.3":[0.511,2.045,0.154],"glm-5.3-flash":[0.1,0.35,0.018],"gpt-4.1":[2.192,8.769,0.546],"gpt-4.1-mini":[0.434,1.704,0.134],"gpt-4.1-nano":[0.111,0.434,0.056],"gpt-4o":[2.659,10.635,1.33],"gpt-4o-mini":[0.159,0.638,0.081],"gpt-5":[1.375,10.96,0.156],"gpt-5-mini":[0.279,2.192,0.056],"gpt-5-nano":[0.06,0.439,0.019],"gpt-5.1":[1.375,10.96,0.156],"gpt-5.4":[2.898,15.453,0.242],"gpt-5.6-luna":[0.219,1.32,0.022],"gpt-5.6-sol":[4.399,21.998,0.44],"gpt-5.6-terra":[2.2,13.199,0.219],"gpt-6-astra":[12.272,61.359,1.228],"gpt-6-luna":[0.12,0.6,0.012],"gpt-6-sol":[2.4,11.999,0.24],"gpt-6.1-sol":[2.4,11.999,0.12],"gpt-6.1-terra":[1.176,5.882,0.059],"gpt-oss-120b":[0.089,0.446,0.01],"gpt-oss-20b":[0.045,0.167,0.045],"gpt-oss-safeguard-120b":[0.179,0.697,0.179],"hermes-4-405b":[0.996,2.989,0.996],"kimi-k2.6":[0.475,2.97,0.1],"kimi-k2.7-code":[0.656,3.3,0.18],"kimi-k3":[3.0,14.999,3.0],"kolibri-1":[0.167,0.613,0.084],"llama-3.3-70b-instruct":[0.724,0.724,0.724],"minicpm-v-4.5":[0.651,1.097,0.651],"minimax-m2":[0.349,1.405,0.349],"minimax-m2.1":[0.359,1.435,0.359],"minimax-m2.5":[0.348,1.39,0.075],"minimax-m3":[0.3,1.2,0.06],"minimax-m3.1-flash":[0.304,1.219,0.076],"ministral-14b-2512":[0.24,0.24,0.022],"ministral-3b-2512":[0.123,0.123,0.012],"ministral-8b-2512":[0.179,0.179,0.017],"mistral-7b-instruct-v0.2":[0.159,0.219,0.159],"mistral-large-2402":[4.284,12.952,4.284],"mistral-large-2512":[0.613,1.838,0.061],"mistral-large-4-0":[0.765,2.351,0.079],"mistral-medium-3.5":[1.532,7.843,0.154],"mistral-nemo-instruct-2407":[0.145,0.145,0.014],"mistral-small-2503":[0.111,0.334,0.111],"mistral-small-2603":[0.156,0.625,0.016],"mistral-small-3.2-24b-instruct-2506":[0.1,0.312,0.1],"mixtral-8x7b-instruct-v0.1":[0.488,0.758,0.488],"nemotron-nano-v2-12b":[0.24,0.707,0.24],"nova-2-lite":[0.373,3.144,0.373],"nova-lite-v1":[0.069,0.275,0.069],"nova-micro-v1":[0.04,0.159,0.04],"nova-pro-v1":[0.918,3.671,0.918],"nvidia-nemotron-3-nano-30b-a3b":[0.06,0.24,0.06],"pixtral-large-2502":[1.993,5.978,1.993],"qwen2.5-vl-72b-instruct":[1.014,1.014,1.014],"qwen3-235b-a22b-instruct-2507":[0.199,0.598,0.018],"qwen3-30b-a3b-instruct-2507":[0.099,0.299,0.099],"qwen3-32b":[0.179,0.697,0.179],"qwen3-coder-30b-a3b-instruct":[0.179,0.697,0.014],"qwen3-coder-next":[0.167,0.891,0.167],"qwen3-vl-235b-a22b":[0.617,3.119,0.052],"qwen3.5-397b-a17b":[0.668,4.01,0.668],"qwen3.5-9b":[0.111,0.167,0.111],"qwen3.6-27b":[0.446,3.008,0.446],"qwen3.6-35b-a3b":[0.167,0.557,0.167],"qwen3.8-2.4t-a95b":[2.5,6.0,0.625],"qwen3.8-27b":[0.1,0.4,0.04],"qwen3.8-flash-next":[0.201,0.5,0.05],"qwen3guard-gen-0.6b":[0.0,0.0],"qwen3guard-gen-8b":[0.0,0.0],"voxtral-small-2507":[0.123,0.368,0.012]},"crossmodel":{"anthropic/claude-fable-5":[10.0,50.0,1.0],"anthropic/claude-fable-5-1":[10.0,50.0,0.25],"anthropic/claude-haiku-4-5":[1.0,5.0,0.1],"anthropic/claude-haiku-5-5":[0.1,0.5,0.01],"anthropic/claude-opus-4-7":[5.0,25.0,0.5],"anthropic/claude-opus-4-8":[5.0,25.0,0.5],"anthropic/claude-opus-5":[5.0,25.0,0.5],"anthropic/claude-opus-5-5":[4.0,20.0,0.2],"anthropic/claude-sonnet-4-6":[3.0,15.0,0.3],"anthropic/claude-sonnet-5":[2.0,10.0,0.2],"anthropic/claude-sonnet-5-5":[2.0,10.0,0.1],"deepseek/deepseek-v4-flash":[0.3,1.2,0.006],"deepseek/deepseek-v4-flash-vision-exp":[0.3,1.2,0.006],"deepseek/deepseek-v4-pro":[1.35,4.05,0.045],"deepseek/deepseek-v4.1-flash":[0.3,1.2,0.006],"gemini/gemini-2.5-flash":[0.3,2.5,0.03],"gemini/gemini-2.5-flash-lite":[0.1,0.4,0.01],"gemini/gemini-2.5-pro":[1.25,10.0,0.125],"gemini/gemini-3-flash-preview":[0.5,3.0,0.05],"gemini/gemini-3.1-pro-preview":[2.0,12.0,0.2],"gemini/gemini-3.5-flash":[1.5,9.0,0.15],"gemini/gemini-3.5-flash-lite":[0.3,2.5,0.03],"gemini/gemini-3.6-flash":[0.75,3.75,0.075],"gemini/gemini-3.7-flash":[0.75,3.75,0.075],"gemini/gemini-3.8-flash":[0.75,3.75,0.075],"gemini/gemini-4-argon":[2.0,10.0,0.1],"minimax/minimax-m2.7":[0.33,1.32,0.066],"minimax/minimax-m3":[0.33,1.32,0.066],"moonshot/kimi-k2.6":[1.0,4.16,0.18],"moonshot/kimi-k2.7-code":[1.0,4.16,0.18],"moonshot/kimi-k3":[3.0,15.0,0.3],"openai/gpt-4o-mini":[0.15,0.6,0.075],"openai/gpt-5.4":[2.5,15.0,0.25],"openai/gpt-5.4-mini":[0.75,4.5,0.075],"openai/gpt-5.4-nano":[0.2,1.25,0.02],"openai/gpt-5.5":[5.0,30.0,0.5],"openai/gpt-5.5-pro":[30.0,180.0,30.0],"openai/gpt-5.6-luna":[0.2,1.2,0.02],"openai/gpt-5.6-sol":[4.0,20.0,0.4],"openai/gpt-5.6-terra":[2.0,12.0,0.2],"openai/gpt-6-astra":[10.0,50.0,1.0],"openai/gpt-6-luna":[0.1,0.5,0.01],"openai/gpt-6-sol":[2.0,10.0,0.2],"openai/gpt-6.1-sol":[2.0,10.0,0.1],"qwen/qwen3.6-flash":[0.19,1.13,0.019],"qwen/qwen3.6-plus":[0.32,1.88,0.032],"qwen/qwen3.7-flash":[0.04,0.13,0.01],"qwen/qwen3.7-max":[1.88,5.63,0.375],"qwen/qwen3.7-plus":[0.32,1.25,0.032],"qwen/qwen3.8-flash":[0.13,0.43,0.016],"qwen/qwen3.8-max":[1.88,5.63,0.23],"qwen/qwen3.8-omni-flash":[0.13,0.43,0.016],"tencent/hy3":[0.16,0.64,0.04],"tencent/hy4-preview":[0.96,2.88,0.048],"x-ai/grok-4.3":[1.25,2.5,0.2],"x-ai/grok-4.5":[2.0,6.0,0.3],"x-ai/grok-4.6":[2.0,6.0,0.5],"x-ai/grok-4.7":[2.0,6.0,0.5],"x-ai/grok-build-0.1":[1.0,2.0,0.2],"xiaomi/mimo-v2.6-flash":[0.16,0.32,0.004],"xiaomi/mimo-v2.6-pro":[0.47,0.94,0.005],"z-ai/glm-4.7":[0.47,2.16,0.1],"z-ai/glm-5":[0.6,3.0,0.16],"z-ai/glm-5-turbo":[0.9,3.7,0.18],"z-ai/glm-5.1":[1.0,3.8,0.2],"z-ai/glm-5.2":[1.2,4.4,0.3],"z-ai/glm-5.3":[1.2,4.4,0.3],"z-ai/glm-5.3-flash":[0.15,0.5,0.03]},"crusoe":{"deepseek-ai/deepseek-v3-0324":[0.5,1.5,0.25],"google/gemma-4-31b-it":[0.14,0.4,0.14],"meta-llama/llama-3.3-70b-instruct":[0.25,0.75,0.13],"moonshotai/kimi-k2.6":[0.7,3.5,0.35],"nvidia/nemotron-3-nano-omni-reasoning-30b-a3b":[0.3,1.83,0.3],"nvidia/nvidia-nemotron-3-nano-30b-a3b":[0.05,0.2,0.03],"nvidia/nvidia-nemotron-3-super-120b-a12b":[0.3,2.4,0.15],"openai/gpt-oss-120b":[0.05,0.25,0.05],"qwen/qwen3-235b-a22b-instruct-2507":[0.22,0.8,0.11],"zai/glm-5.1":[1.2,4.4,0.25],"zai/glm-5.2":[1.4,4.4,0.26]},"daoxe":{"claude-haiku-4-5-20251001":[1.0,5.0,0.1],"claude-opus-4-8":[5.0,25.0,0.5],"claude-sonnet-4-6":[3.0,15.0,0.3],"gemini-3.1-pro-preview":[2.0,12.0,0.2],"gpt-5.4":[2.5,15.0,0.25],"gpt-5.5":[5.0,30.0,0.5],"grok-4.3":[1.25,2.5,0.2],"grok-4.5":[2.0,6.0,0.5],"kimi-k2.5":[4.0,16.0,0.8]},"databricks":{"databricks-claude-haiku-4-5":[1.0,5.0,0.1],"databricks-claude-opus-4-1":[15.0,75.0,1.5],"databricks-claude-opus-4-5":[5.0,25.0,0.5],"databricks-claude-opus-4-6":[5.0,25.0,0.5],"databricks-claude-opus-4-7":[5.0,25.0,0.5],"databricks-claude-sonnet-4":[3.0,15.0,0.3],"databricks-claude-sonnet-4-5":[3.0,15.0,0.3],"databricks-claude-sonnet-4-6":[3.0,15.0,0.3],"databricks-gemini-2-5-flash":[0.3,2.5,0.03],"databricks-gemini-2-5-pro":[1.25,10.0,0.125],"databricks-gemini-3-1-flash-lite":[0.25,1.5,0.025],"databricks-gemini-3-1-pro":[2.0,12.0,0.2],"databricks-gemini-3-5-flash":[1.5,9.0,0.15],"databricks-gemini-3-flash":[0.5,3.0,0.05],"databricks-gemini-3-pro":[2.0,12.0,0.2],"databricks-glm-5-2":[1.4,4.4,0.26],"databricks-gpt-5":[1.25,10.0,0.125],"databricks-gpt-5-1":[1.25,10.0,0.125],"databricks-gpt-5-2":[1.75,14.0,0.175],"databricks-gpt-5-4":[2.5,15.0,0.25],"databricks-gpt-5-4-mini":[0.75,4.5,0.075],"databricks-gpt-5-4-nano":[0.2,1.25,0.02],"databricks-gpt-5-5":[5.0,30.0,0.5],"databricks-gpt-5-6-luna":[0.2,1.2,0.02],"databricks-gpt-5-6-sol":[4.0,20.0,0.4],"databricks-gpt-5-6-terra":[2.0,12.0,0.2],"databricks-gpt-5-mini":[0.25,2.0,0.025],"databricks-gpt-5-nano":[0.05,0.4,0.005],"databricks-gpt-oss-120b":[0.15,0.6,0.15],"databricks-gpt-oss-20b":[0.07,0.3,0.07],"databricks-kimi-k2-7-code":[0.95,4.0,0.19]},"deepinfra":{"anthropic/claude-fable-5":[10.0,50.0,10.0],"bytedance/seed-2.0-code":[0.5,3.0,0.1],"bytedance/seed-2.0-mini":[0.1,0.4,0.02],"bytedance/seed-2.0-pro":[0.5,3.0,0.1],"deepseek-ai/deepseek-r1-0528":[0.5,2.15,0.35],"deepseek-ai/deepseek-v3":[0.32,0.89,0.32],"deepseek-ai/deepseek-v3-0324":[0.24,0.9,0.135],"deepseek-ai/deepseek-v3.1":[0.25,0.95,0.13],"deepseek-ai/deepseek-v3.2":[0.26,0.38,0.13],"deepseek-ai/deepseek-v4-flash":[0.09,0.18,0.018],"deepseek-ai/deepseek-v4-flash-0731":[0.06,0.18,0.015],"deepseek-ai/deepseek-v4-flash-vision-exp":[0.44,1.32,0.014],"deepseek-ai/deepseek-v4-pro":[1.3,2.6,0.1],"deepseek-ai/deepseek-v4-pro-0813":[1.3,2.6,0.1],"deepseek-ai/deepseek-v4.1-flash":[0.2,0.6,0.006],"deepseek-ai/deepseek-v4.1-flash-1017":[0.2,0.6,0.006],"google/gemma-3-12b-it":[0.05,0.15,0.05],"google/gemma-3-27b-it":[0.08,0.16,0.08],"google/gemma-3-4b-it":[0.05,0.1,0.05],"google/gemma-4-26b-a4b-it":[0.07,0.34,0.07],"google/gemma-4-31b-it":[0.2,0.4,0.2],"google/gemma-4-e4b-it":[0.02,0.1,0.02],"meta-llama/llama-3.3-70b-instruct-turbo":[0.1,0.32,0.1],"meta-llama/llama-4-maverick-17b-128e-instruct-fp8":[0.2,0.8,0.2],"meta-llama/llama-4-scout-17b-16e-instruct":[0.1,0.3,0.1],"meta-llama/llama-guard-4-12b":[0.18,0.18,0.18],"minimaxai/minimax-m2.5":[0.15,1.15,0.03],"minimaxai/minimax-m2.7":[0.25,1.0,0.05],"minimaxai/minimax-m3":[0.28,1.1,0.056],"mistralai/mistral-small-24b-instruct-2501":[0.05,0.08,0.05],"moonshotai/kimi-k2.5":[0.45,2.25,0.07],"moonshotai/kimi-k2.6":[0.75,3.5,0.15],"moonshotai/kimi-k2.7-code":[0.68,3.4,0.136],"moonshotai/kimi-k3":[2.85,14.25,0.285],"nvidia/llama-3.3-nemotron-super-49b-v1.5":[0.4,0.4,0.4],"nvidia/nemotron-3-nano-30b-a3b":[0.05,0.2,0.025],"nvidia/nemotron-3-nano-omni-30b-a3b-reasoning":[0.2,0.8,0.2],"openai/gpt-oss-120b":[0.037,0.17,0.037],"openai/gpt-oss-20b":[0.03,0.14,0.03],"qwen/qwen3-235b-a22b-instruct-2507":[0.09,0.55,0.09],"qwen/qwen3-30b-a3b":[0.12,0.5,0.12],"qwen/qwen3-32b":[0.08,0.28,0.08],"qwen/qwen3-coder-480b-a35b-instruct-turbo":[0.3,1.0,0.1],"qwen/qwen3-max":[1.2,6.0,0.24],"qwen/qwen3-next-80b-a3b-instruct":[0.09,1.1,0.09],"qwen/qwen3-vl-235b-a22b-instruct":[0.2,0.88,0.11],"qwen/qwen3-vl-30b-a3b-instruct":[0.15,0.6,0.15],"qwen/qwen3.5-122b-a10b":[0.29,2.4,0.29],"qwen/qwen3.5-27b":[0.26,2.6,0.26],"qwen/qwen3.5-35b-a3b":[0.14,1.0,0.05],"qwen/qwen3.5-397b-a17b":[0.45,3.0,0.22],"qwen/qwen3.5-9b":[0.1,0.15,0.1],"qwen/qwen3.6-27b":[0.32,3.2,0.32],"qwen/qwen3.6-35b-a3b":[0.1,0.95,0.1],"qwen/qwen3.7-max":[2.5,7.5,0.5],"qwen/qwen3.8-2.4t-a95b":[2.0,6.0,0.2],"qwen/qwen3.8-27b":[0.2,2.5,0.05],"qwen/qwen3.8-flash":[0.113,0.382,0.0141],"qwen/qwen3.8-max":[1.65,4.951,0.206],"stepfun-ai/step-3.7-flash":[0.2,1.15,0.04],"stepfun-ai/step-5-preview":[1.0,2.7,0.1],"tencent/hy3":[0.13,0.53,0.033],"tencent/hy4-preview":[0.834,2.501,0.042],"thinkingmachines/inkling":[0.95,4.05,0.16],"thinkingmachines/inkling-small":[0.45,1.2,0.1],"xiaomimimo/mimo-v2.5":[0.14,0.28,0.0028],"xiaomimimo/mimo-v2.5-pro":[1.0,3.0,0.2],"xiaomimimo/mimo-v2.6-flash":[0.14,0.28,0.0028],"xiaomimimo/mimo-v2.6-pro":[0.43,0.87,0.0036],"zai-org/glm-4.6":[0.5,2.0,0.1],"zai-org/glm-4.7":[0.4,1.75,0.08],"zai-org/glm-4.7-flash":[0.06,0.4,0.01],"zai-org/glm-5":[0.6,2.08,0.12],"zai-org/glm-5.1":[1.05,3.5,0.205],"zai-org/glm-5.2":[0.75,2.4,0.14],"zai-org/glm-5.3":[0.9,4.0,0.2],"zai-org/glm-5.3-flash":[0.15,0.5,0.03]},"deepseek":{"deepseek-flash":[0.15,0.6,0.003],"deepseek-v4-flash":[0.15,0.6,0.003],"deepseek-v4-flash-vision-exp":[0.15,0.6,0.003],"deepseek-v4-pro":[0.66,1.98,0.022]},"digitalocean":{"all-mini-lm-l6-v2":[0.009,0.0,0.009],"anthropic-claude-4.5-sonnet":[3.0,15.0,0.3],"anthropic-claude-4.6-sonnet":[3.0,15.0,0.3],"anthropic-claude-5-sonnet":[2.0,10.0,0.2],"anthropic-claude-5.5-haiku":[0.1,0.5,0.01],"anthropic-claude-fable-5":[10.0,50.0,1.0],"anthropic-claude-fable-5.1":[10.0,50.0,0.25],"anthropic-claude-haiku-4.5":[1.0,5.0,0.1],"anthropic-claude-opus-4.5":[5.0,25.0,0.5],"anthropic-claude-opus-4.6":[5.0,25.0,0.5],"anthropic-claude-opus-4.7":[5.0,25.0,0.5],"anthropic-claude-opus-4.8":[5.0,25.0,0.5],"anthropic-claude-opus-5":[5.0,25.0,0.5],"anthropic-claude-opus-5.5":[4.0,20.0,0.2],"anthropic-claude-sonnet-5.5":[2.0,10.0,0.2],"arcee-trinity-large-thinking":[0.25,0.9,0.06],"bge-m3":[0.02,0.0,0.02],"bge-reranker-v2-m3":[0.01,0.0,0.01],"deepseek-3.2":[0.5,1.6,0.15],"deepseek-4-flash":[0.14,0.28,0.028],"deepseek-v4-flash-0731":[0.14,0.28,0.028],"deepseek-v4-pro":[1.74,3.48,0.348],"deepseek-v4-pro-0813":[1.32,3.96,0.044],"deepseek-v4.1-flash":[0.3,1.2,0.006],"deepseek-v4.1-flash-1017":[0.3,1.2,0.006],"e5-large-v2":[0.02,0.0,0.02],"gemma-4-31b-it":[0.18,0.5,0.036],"glm-5.2":[1.4,4.4,0.21],"glm-5.3":[1.4,4.4,0.26],"glm-5.3-flash":[0.15,0.5,0.03],"gte-large-en-v1.5":[0.09,0.0,0.09],"kimi-k2.6":[0.95,4.0,0.19],"kimi-k3":[3.0,15.0,0.3],"llama-4-maverick":[0.25,0.87,0.05],"mimo-v2.5-pro":[0.8,3.0,0.16],"minimax-m2.5":[0.3,1.2,0.06],"minimax-m3.1-flash":[0.15,0.6,0.015],"mistral-3-14b":[0.2,0.2,0.04],"multi-qa-mpnet-base-dot-v1":[0.009,0.0,0.009],"nemotron-3-nano-omni":[0.5,0.9,0.1],"nemotron-3-ultra-550b":[0.9,1.7,0.18],"nemotron-3.5-super-vl":[0.3,0.65,0.06],"nemotron-nano-12b-v2-vl":[0.2,0.6,0.04],"openai-gpt-4.1":[2.0,8.0,0.5],"openai-gpt-4o":[2.5,10.0,1.25],"openai-gpt-4o-mini":[0.15,0.6,0.075],"openai-gpt-5":[1.25,10.0,0.125],"openai-gpt-5-mini":[0.25,2.0,0.025],"openai-gpt-5-nano":[0.05,0.4,0.005],"openai-gpt-5.2":[1.75,14.0,0.175],"openai-gpt-5.2-pro":[21.0,168.0,21.0],"openai-gpt-5.3-codex":[1.75,14.0,0.175],"openai-gpt-5.4":[2.5,15.0,0.25],"openai-gpt-5.4-mini":[0.75,4.5,0.075],"openai-gpt-5.4-nano":[0.2,1.25,0.02],"openai-gpt-5.4-pro":[30.0,180.0,30.0],"openai-gpt-5.5":[5.0,30.0,0.5],"openai-gpt-5.6-luna":[0.2,1.2,0.02],"openai-gpt-5.6-sol":[4.0,20.0,0.4],"openai-gpt-5.6-terra":[2.0,12.0,0.2],"openai-gpt-6-1-sol":[2.0,10.0,0.1],"openai-gpt-6-astra":[10.0,50.0,1.0],"openai-gpt-6-luna":[0.1,0.5,0.01],"openai-gpt-6-sol":[2.0,10.0,0.2],"openai-gpt-image-1":[5.0,40.0,1.25],"openai-gpt-image-1.5":[5.0,10.0,1.0],"openai-gpt-image-2":[8.0,30.0,8.0],"openai-gpt-oss-120b":[0.1,0.7,0.02],"openai-gpt-oss-20b":[0.05,0.45,0.01],"openai-o1":[15.0,60.0,7.5],"openai-o3":[2.0,8.0,0.5],"openai-o3-mini":[1.1,4.4,0.55],"qwen3-embedding-0.6b":[0.04,0.0,0.04],"qwen3.5-397b-a17b":[0.55,3.5,0.111],"qwen3.8-max":[2.0,6.0,0.2],"reflection-beam":[0.4,1.2,0.04]},"dinference":{"glm-4.7":[0.45,1.65,0.45],"glm-5":[0.75,2.4,0.75],"glm-5.1":[1.25,3.89,1.25],"glm-5.2":[1.25,3.89,1.25],"gpt-oss-120b":[0.0675,0.27,0.0675],"minimax-m2.5":[0.22,0.88,0.22]},"drun":{"public/deepseek-r1":[0.55,2.2,0.55],"public/deepseek-v3":[0.28,1.1,0.28],"public/minimax-m25":[0.29,1.16,0.29]},"ebcloud":{"deepseek-v4-flash":[0.143,0.2857,0.143],"deepseek-v4-pro":[0.4286,0.8571,0.4286],"glm-5.1":[0.8571,3.4286,0.8571],"kimi-k2.6":[0.9286,3.8571,0.9286]},"echo":{"echo":[10.0,50.0,10.0]},"edenai":{"amazon/amazon.nova-lite-v1:0":[0.06,0.24,0.015],"amazon/amazon.nova-lite-v1:0@us":[0.06,0.24,0.015],"amazon/amazon.nova-micro-v1:0":[0.035,0.14,0.00875],"amazon/amazon.nova-micro-v1:0@us":[0.035,0.14,0.00875],"amazon/amazon.nova-pro-v1:0":[0.8,3.2,0.2],"amazon/amazon.nova-pro-v1:0@us":[0.8,3.2,0.2],"amazon/google.gemma-3-12b-it":[0.09,0.29,0.09],"amazon/google.gemma-3-12b-it@us":[0.09,0.29,0.09],"amazon/google.gemma-3-27b-it":[0.23,0.38,0.23],"amazon/google.gemma-3-27b-it@us":[0.23,0.38,0.23],"amazon/google.gemma-3-4b-it":[0.04,0.08,0.04],"amazon/google.gemma-3-4b-it@us":[0.04,0.08,0.04],"amazon/mistral.pixtral-large-2502-v1:0":[2.0,6.0,2.0],"amazon/mistral.pixtral-large-2502-v1:0@us":[2.0,6.0,2.0],"amazon/mistral.voxtral-mini-3b-2507":[0.04,0.04,0.04],"amazon/mistral.voxtral-mini-3b-2507@us":[0.04,0.04,0.04],"amazon/mistral.voxtral-small-24b-2507":[0.1,0.3,0.1],"amazon/mistral.voxtral-small-24b-2507@us":[0.1,0.3,0.1],"amazon/moonshot.kimi-k2-thinking":[0.6,2.5,0.6],"amazon/moonshotai.kimi-k2.5":[0.6,3.0,0.6],"amazon/openai.gpt-oss-safeguard-20b":[0.07,0.2,0.07],"amazon/openai.gpt-oss-safeguard-20b@us":[0.07,0.2,0.07],"amazon/qwen.qwen3-coder-next":[0.5,1.2,0.5],"amazon/zai.glm-4.7-flash":[0.07,0.4,0.07],"amazon/zai.glm-4.7-flash@us":[0.07,0.4,0.07],"anthropic/claude-fable-5":[10.0,50.0,1.0],"anthropic/claude-fable-5-1":[10.0,50.0,0.25],"anthropic/claude-fable-latest":[10.0,50.0,0.25],"anthropic/claude-haiku-5-5":[0.1,0.5,0.01],"anthropic/claude-haiku-latest":[0.1,0.5,0.01],"anthropic/claude-opus-4-5":[5.0,25.0,0.5],"anthropic/claude-opus-4-5-20251101":[5.0,25.0,0.5],"anthropic/claude-opus-4-6":[5.0,25.0,0.5],"anthropic/claude-opus-4-7":[5.0,25.0,0.5],"anthropic/claude-opus-4-8":[5.0,25.0,0.5],"anthropic/claude-opus-5":[5.0,25.0,0.5],"anthropic/claude-opus-5-5":[4.0,20.0,0.2],"anthropic/claude-opus-latest":[4.0,20.0,0.2],"anthropic/claude-sonnet-4-6":[3.0,15.0,0.3],"anthropic/claude-sonnet-5":[2.0,10.0,0.2],"anthropic/claude-sonnet-5-5":[2.0,10.0,0.1],"anthropic/claude-sonnet-latest":[2.0,10.0,0.1],"arkanecloud/deepseek-ai/deepseek-v4-flash-0731":[0.2,0.4,0.05],"arkanecloud/deepseek-ai/deepseek-v4.1-flash":[0.3,1.2,0.075],"arkanecloud/deepseek-ai/deepseek-v4.1-flash-1017":[0.3,1.2,0.075],"arkanecloud/meta-llama/llama-3.1-70b-instruct":[0.8,0.8,0.16],"arkanecloud/meta-llama/llama-3.1-8b-instruct":[0.15,0.15,0.03],"arkanecloud/meta-llama/llama-3.3-70b-instruct":[0.7,0.7,0.2],"arkanecloud/ministral-14b":[0.15,0.15,0.15],"arkanecloud/nvidia/nemotron-3-super-120b-a12b":[0.4,0.8,0.1],"arkanecloud/nvidia/nemotron-3-ultra-550b-a55b":[0.6,3.5,0.2],"arkanecloud/openai/gpt-oss-120b":[0.15,0.6,0.1],"arkanecloud/openai/gpt-oss-20b":[0.07,0.25,0.05],"arkanecloud/qwen/qwen3-235b-a22b-instruct-2507":[0.25,1.0,0.2],"azure/gpt-4.1-nano":[0.1,0.4,0.025],"azure/gpt-4.1-nano@eu":[0.11,0.44,0.0275],"azure/gpt-5.1-codex":[1.25,10.0,0.125],"azure/gpt-5.1-codex-max":[1.25,10.0,0.125],"azure/gpt-5.1-codex-mini":[0.25,2.0,0.025],"azure/gpt-5.2-codex":[1.75,14.0,0.175],"cerebras/gpt-oss-120b":[0.35,0.75,0.35],"cloudflare/@cf/aisingapore/gemma-sea-lion-v4-27b-it":[0.351,0.555,0.351],"cloudflare/@cf/deepseek-ai/deepseek-v4-flash-0731":[0.44,1.32,0.014],"cloudflare/@cf/deepseek-ai/deepseek-v4-pro-0813":[1.32,3.96,0.044],"cloudflare/@cf/deepseek-ai/deepseek-v4.1-flash-1017":[0.3,1.2,0.006],"cloudflare/@cf/meta/llama-3.2-1b-instruct":[0.027,0.201,0.027],"cloudflare/@cf/meta/llama-3.2-3b-instruct":[0.0509,0.335,0.0509],"cloudflare/@cf/meta/llama-guard-3-8b":[0.484,0.03,0.484],"cloudflare/@cf/mistralai/mistral-small-3.1-24b-instruct":[0.351,0.555,0.351],"cloudflare/@cf/openai/gpt-oss-120b":[0.35,0.75,0.35],"cloudflare/@cf/openai/gpt-oss-20b":[0.2,0.3,0.2],"cloudflare/@cf/qwen/qwen2.5-coder-32b-instruct":[0.66,1.0,0.66],"cloudflare/@cf/zai-org/glm-4.7-flash":[0.0605,0.4,0.0605],"cohere/c4ai-aya-expanse-32b":[0.5,1.5,0.5],"cohere/command-a-03-2025":[2.5,10.0,2.5],"cohere/command-r-08-2024":[0.15,0.6,0.15],"cohere/command-r-plus-08-2024":[2.5,10.0,2.5],"cohere/command-r7b-12-2024":[0.0375,0.15,0.0375],"databricks/databricks-deepseek-v4-flash-0731":[0.14,0.28,0.014],"databricks/databricks-deepseek-v4-pro-0813":[1.32,3.959999,0.132],"databricks/databricks-gpt-oss-120b":[0.15001,0.59997,0.015001],"databricks/databricks-gpt-oss-120b@eu":[0.15001,0.59997,0.015001],"databricks/databricks-gpt-oss-20b":[0.07,0.30002,0.007],"databricks/databricks-gpt-oss-20b@eu":[0.07,0.30002,0.007],"databricks/databricks-inkling":[1.0,4.05,0.1],"databricks/databricks-qwen3-next-80b-a3b-instruct":[0.15001,1.20001,0.015001],"databricks/databricks-qwen3-next-80b-a3b-instruct@eu":[0.15001,1.20001,0.015001],"deepinfra/bytedance/seed-2.0-code":[0.5,3.0,0.1],"deepinfra/bytedance/seed-2.0-mini":[0.1,0.4,0.02],"deepinfra/deepseek-ai/deepseek-r1":[0.7,2.4,0.7],"deepinfra/deepseek-ai/deepseek-r1-0528":[0.5,2.15,0.35],"deepinfra/deepseek-ai/deepseek-v3":[0.32,0.89,0.32],"deepinfra/deepseek-ai/deepseek-v3-0324":[0.24,0.9,0.135],"deepinfra/deepseek-ai/deepseek-v4-flash-0731":[0.06,0.18,0.015],"deepinfra/deepseek-ai/deepseek-v4-pro-0813":[1.3,2.6,0.1],"deepinfra/deepseek-ai/deepseek-v4.1-flash":[0.2,0.6,0.006],"deepinfra/deepseek-ai/deepseek-v4.1-flash-1017":[0.2,0.6,0.006],"deepinfra/google/gemma-3-12b-it":[0.05,0.15,0.05],"deepinfra/google/gemma-3-27b-it":[0.08,0.16,0.08],"deepinfra/google/gemma-3-4b-it":[0.05,0.1,0.05],"deepinfra/gryphe/mythomax-l2-13b":[0.4,0.4,0.4],"deepinfra/ibm-granite/granite-4.2-8b":[0.06,0.25,0.015],"deepinfra/meta-llama/llama-3.2-11b-vision-instruct":[0.345,0.345,0.345],"deepinfra/meta-llama/llama-3.2-3b-instruct":[0.02,0.02,0.02],"deepinfra/meta-llama/llama-3.3-70b-instruct":[0.1,0.32,0.1],"deepinfra/meta-llama/llama-guard-3-8b":[0.055,0.055,0.055],"deepinfra/meta-llama/llama-guard-4-12b":[0.18,0.18,0.18],"deepinfra/meta-models/muse-glimmer-30b":[0.3,1.2,0.04],"deepinfra/microsoft/wizardlm-2-8x22b":[0.48,0.48,0.48],"deepinfra/mistralai/mistral-small-24b-instruct-2501":[0.05,0.08,0.05],"deepinfra/mistralai/mixtral-8x7b-instruct-v0.1":[0.4,0.4,0.4],"deepinfra/moonshotai/kimi-k2-instruct":[0.5,2.0,0.5],"deepinfra/moonshotai/kimi-k2.5":[0.45,2.25,0.07],"deepinfra/nemotron-3-super-120b-a12b":[0.085,0.4,0.085],"deepinfra/nemotron-3-ultra-550b-a55b":[0.5,2.2,0.1],"deepinfra/nousresearch/hermes-3-llama-3.1-405b":[1.0,1.0,1.0],"deepinfra/nousresearch/hermes-3-llama-3.1-70b":[0.7,0.7,0.7],"deepinfra/nvidia/llama-3.1-nemotron-70b-instruct":[0.6,0.6,0.6],"deepinfra/nvidia/nemotron-3-nano-30b-a3b":[0.05,0.2,0.025],"deepinfra/openai/gpt-oss-120b":[0.037,0.17,0.037],"deepinfra/openai/gpt-oss-20b":[0.03,0.14,0.03],"deepinfra/qwen/qwen2.5-7b-instruct":[0.04,0.1,0.04],"deepinfra/qwen/qwen3-235b-a22b-instruct-2507":[0.09,0.55,0.09],"deepinfra/qwen/qwen3-235b-a22b-thinking-2507":[0.23,2.3,0.2],"deepinfra/qwen/qwen3-coder-480b-a35b-instruct":[0.4,1.6,0.4],"deepinfra/qwen/qwen3-max":[1.2,6.0,0.24],"deepinfra/qwen/qwen3-next-80b-a3b-instruct":[0.09,1.1,0.09],"deepinfra/qwen/qwen3-vl-235b-a22b-instruct":[0.2,0.88,0.11],"deepinfra/qwen/qwen3-vl-30b-a3b-instruct":[0.15,0.6,0.15],"deepinfra/stepfun-ai/step-3.5-flash":[0.09,0.3,0.02],"deepinfra/stepfun-ai/step-3.7-flash":[0.2,1.15,0.04],"deepinfra/stepfun-ai/step-5-preview":[1.0,2.7,0.1],"deepinfra/tencent/hy3":[0.13,0.53,0.033],"deepinfra/tencent/hy4-preview":[0.834,2.501,0.042],"deepinfra/thinkingmachines/inkling":[0.95,4.05,0.16],"deepinfra/thinkingmachines/inkling-small":[0.45,1.2,0.1],"deepinfra/zai-org/glm-4.7-flash":[0.06,0.4,0.01],"deepseek-v4-flash-vision-exp":[0.15,0.6,0.003],"deepseek/deepseek-chat":[0.15,0.6,0.003],"deepseek/deepseek-v4-flash":[0.15,0.6,0.003],"deepseek/deepseek-v4-flash-vision-exp":[0.15,0.6,0.003],"deepseek/deepseek-v4-pro":[0.66,1.98,0.022],"fireworks_ai/accounts/fireworks/models/ember-1":[3.0,15.0,0.3],"fireworks_ai/accounts/fireworks/models/gpt-oss-120b":[0.15,0.6,0.015],"fireworks_ai/accounts/fireworks/models/inkling":[1.0,4.05,0.17],"fireworks_ai/accounts/fireworks/models/muse-spark-open":[1.25,4.25,0.15],"fireworks_ai/gpt-oss-120b":[0.15,0.6,0.014],"flexai/deepseek-v4-flash-0731":[0.119,0.238,0.0178],"flexai/deepseek-v4-flash-0731@eu":[0.119,0.238,0.0178],"flexai/deepseek-v4.1-flash-1017":[0.15,0.6,0.0225],"flexai/gpt-oss-120b":[0.05,0.25,0.0075],"flexai/gpt-oss-20b":[0.02,0.1,0.003],"flexai/muse-glimmer-30b":[0.3,1.2,0.045],"flexai/step-3.7-flash":[0.2,1.15,0.03],"google/deep-research-max-preview-04-2026":[2.0,12.0,2.0],"google/deep-research-preview-04-2026":[2.0,12.0,2.0],"google/gemini-2.5-flash-image":[0.3,2.5,0.03],"google/gemini-3-flash-preview":[0.5,3.0,0.05],"google/gemini-3-pro-image":[2.0,12.0,0.2],"google/gemini-3-pro-image-preview":[2.0,12.0,0.2],"google/gemini-3.1-flash-image":[0.5,3.0,0.5],"google/gemini-3.1-flash-image-preview":[0.5,3.0,0.5],"google/gemini-3.1-flash-lite":[0.25,1.5,0.025],"google/gemini-3.1-flash-lite-image":[0.25,1.5,0.25],"google/gemini-3.1-flash-lite-preview":[0.25,1.5,0.025],"google/gemini-3.1-pro-preview":[2.0,12.0,0.2],"google/gemini-3.1-pro-preview-customtools":[2.0,12.0,0.2],"google/gemini-3.5-flash":[1.5,9.0,0.15],"google/gemini-3.5-flash-lite":[0.3,2.5,0.03],"google/gemini-3.6-flash":[0.75,3.75,0.075],"google/gemini-3.7-flash":[1.5,7.5,0.15],"google/gemini-3.8-flash":[1.5,7.5,0.15],"google/gemini-4-argon":[4.0,20.0,0.2],"google/gemini-flash-latest":[1.5,7.5,0.15],"google/gemini-nano-banana-2.1":[1.5,7.5,1.5],"google/gemini-pro-latest":[4.0,20.0,0.2],"google/gemini-robotics-er-2-preview":[1.0,5.0,0.1],"greenference/gpt-oss-20b":[0.009,0.045,0.0045],"greenpt/deepseek-v4-flash-0731":[0.155862,0.389655,0.044532],"greenpt/deepseek-v4.1-flash":[0.244926,1.224631,0.012246],"greenpt/gpt-oss-120b":[0.22266,0.77931,0.22266],"greenpt/llama-3.3-70b-instruct":[1.224631,1.224631,1.224631],"greenpt/qwen3-235b-a22b-instruct-2507":[1.001971,3.005912,1.001971],"groq/meta-llama/llama-prompt-guard-2-22m":[0.03,0.03,0.015],"groq/meta-llama/llama-prompt-guard-2-86m":[0.04,0.04,0.02],"groq/openai/gpt-oss-120b":[0.15,0.6,0.075],"groq/openai/gpt-oss-20b":[0.075,0.3,0.0375],"groq/openai/gpt-oss-safeguard-20b":[0.075,0.3,0.0375],"infomaniak/mistralai/ministral-3-14b-instruct-2512":[0.33399,0.44532,0.33399],"ionos/meta-llama/llama-3.3-70b-instruct":[0.723645,0.723645,0.723645],"ionos/openai/gpt-oss-120b":[0.166995,0.723645,0.166995],"ionos/qwen/qwen3-coder-next":[0.166995,0.89064,0.166995],"meta/muse-spark-1.1":[1.25,4.25,0.15],"meta/muse-spark-1.2":[1.25,4.25,0.15],"meta/muse-spark-1.3":[1.25,4.25,0.15],"meta/muse-wonder-1.0":[4.0,20.0,0.2],"microsoft/gpt-4":[30.0,60.0,30.0],"microsoft/o3-mini":[1.1,4.4,0.55],"minimax/minimax-m2":[0.3,1.2,0.3],"minimax/minimax-m2.1":[0.3,1.2,0.03],"minimax/minimax-m2.5":[0.3,1.2,0.03],"minimax/minimax-m2.7":[0.3,1.2,0.06],"minimax/minimax-m3":[0.3,1.2,0.06],"minimax/minimax-m3.1-flash":[0.15,0.6,0.015],"mistral/codestral-2508":[0.3,0.9,0.03],"mistral/codestral-2508@eu":[0.33,0.99,0.033],"mistral/codestral-latest":[0.3,0.9,0.03],"mistral/codestral-latest@eu":[0.33,0.99,0.033],"mistral/devstral-2512":[0.4,2.0,0.04],"mistral/devstral-2512@eu":[0.44,2.2,0.044],"mistral/devstral-medium-latest":[0.4,2.0,0.4],"mistral/devstral-medium-latest@eu":[0.44,2.2,0.44],"mistral/magistral-medium-latest":[1.5,7.5,0.15],"mistral/magistral-medium-latest@eu":[1.65,8.25,0.165],"mistral/ministral-14b-2512":[0.2,0.2,0.02],"mistral/ministral-14b-2512@eu":[0.22,0.22,0.022],"mistral/ministral-3b-2512":[0.1,0.1,0.01],"mistral/ministral-3b-2512@eu":[0.11,0.11,0.011],"mistral/ministral-8b-2512":[0.15,0.15,0.015],"mistral/ministral-8b-2512@eu":[0.165,0.165,0.0165],"mistral/mistral-large-2407":[2.0,6.0,0.2],"mistral/mistral-large-2407@eu":[2.2,6.6,0.22],"mistral/mistral-large-2512":[0.5,1.5,0.05],"mistral/mistral-large-2512@eu":[0.55,1.65,0.055],"mistral/mistral-large-4@eu":[0.748,2.299,0.077],"mistral/mistral-large-latest":[2.0,6.0,0.2],"mistral/mistral-large-latest@eu":[2.2,6.6,0.22],"mistral/mistral-medium-2505":[0.4,2.0,0.4],"mistral/mistral-medium-2505@eu":[0.44,2.2,0.44],"mistral/mistral-medium-2604":[1.5,7.5,0.15],"mistral/mistral-medium-2604@eu":[1.65,8.25,0.165],"mistral/mistral-medium-3":[0.4,2.0,0.04],"mistral/mistral-medium-3-5":[1.5,7.5,0.15],"mistral/mistral-medium-3-5@eu":[1.65,8.25,0.165],"mistral/mistral-medium-3@eu":[0.44,2.2,0.044],"mistral/mistral-medium-latest":[1.5,7.5,0.15],"mistral/mistral-medium-latest@eu":[1.65,8.25,0.165],"mistral/mistral-small-2603":[0.15,0.6,0.015],"mistral/mistral-small-2603@eu":[0.165,0.66,0.0165],"mistral/mistral-small-latest":[0.15,0.6,0.015],"mistral/mistral-small-latest@eu":[0.165,0.66,0.0165],"mistral/voxtral-small-latest":[0.1,0.4,0.01],"mistral/voxtral-small-latest@eu":[0.11,0.44,0.011],"moonshot/kimi-k2.6":[0.95,4.0,0.16],"moonshot/kimi-k2.7-code":[0.95,4.0,0.19],"moonshot/kimi-k2.7-code-highspeed":[1.9,8.0,0.38],"moonshot/kimi-k3":[3.0,15.0,0.3],"moonshot/kimi-k3.1-pro":[2.0,10.0,0.2],"nebius/deepseek-ai/deepseek-v4-flash-0731":[0.14,0.28,0.14],"nebius/deepseek-ai/deepseek-v4-pro-0813":[1.32,3.96,1.32],"nebius/deepseek-ai/deepseek-v4.1-flash":[0.3,1.2,0.3],"nebius/deepseek-ai/deepseek-v4.1-flash-1017":[0.3,1.2,0.3],"nebius/google/gemma-3-27b-it":[0.1,0.3,0.1],"nebius/meta-models/muse-spark-open":[1.25,4.25,1.25],"nebius/nvidia/nemotron-3-super-120b-a12b":[0.3,0.9,0.3],"nebius/nvidia/nemotron-3-ultra-550b-a55b":[1.0,3.0,1.0],"nebius/openai/gpt-oss-120b":[0.15,0.6,0.15],"nebius/qwen/qwen3-235b-a22b-instruct-2507":[0.2,0.6,0.2],"nebius/qwen/qwen3-30b-a3b-instruct-2507":[0.1,0.3,0.1],"openai/gpt-4.1":[2.0,8.0,0.5],"openai/gpt-4.1-mini":[0.4,1.6,0.1],"openai/gpt-4o":[2.5,10.0,1.25],"openai/gpt-4o-2024-08-06":[2.5,10.0,1.25],"openai/gpt-4o-2024-11-20":[2.5,10.0,1.25],"openai/gpt-4o-mini":[0.15,0.6,0.075],"openai/gpt-5":[1.25,10.0,0.125],"openai/gpt-5-mini":[0.25,2.0,0.025],"openai/gpt-5-nano":[0.05,0.4,0.005],"openai/gpt-5-pro":[15.0,120.0,15.0],"openai/gpt-5-search-api":[1.25,10.0,0.125],"openai/gpt-5.1":[1.25,10.0,0.125],"openai/gpt-5.2":[1.75,14.0,0.175],"openai/gpt-5.2-pro":[21.0,168.0,21.0],"openai/gpt-5.3-codex":[1.75,14.0,0.175],"openai/gpt-5.4":[2.5,15.0,0.25],"openai/gpt-5.4-mini":[0.75,4.5,0.075],"openai/gpt-5.4-nano":[0.2,1.25,0.02],"openai/gpt-5.4-pro":[30.0,180.0,30.0],"openai/gpt-5.5":[5.0,30.0,0.5],"openai/gpt-5.5-pro":[30.0,180.0,30.0],"openai/gpt-5.6-luna":[0.2,1.2,0.02],"openai/gpt-5.6-sol":[4.0,20.0,0.4],"openai/gpt-5.6-terra":[2.0,12.0,0.2],"openai/gpt-6-astra":[10.0,50.0,1.0],"openai/gpt-6-luna":[0.1,0.5,0.01],"openai/gpt-6-sol":[2.0,10.0,0.2],"openai/gpt-6.1-sol":[2.0,10.0,0.1],"openai/gpt-6.1-terra":[1.0,5.0,0.05],"openai/gpt-latest":[10.0,50.0,1.0],"openai/gpt-mini-latest":[0.2,1.2,0.02],"openai/gpt-pro-latest":[4.0,20.0,0.4],"openai/o3":[2.0,8.0,0.5],"openai/o3-pro":[20.0,80.0,20.0],"ovhcloud/gpt-oss-120b":[0.09,0.47,0.09],"ovhcloud/gpt-oss-20b":[0.05,0.18,0.05],"perplexityai/sonar":[1.0,1.0,1.0],"perplexityai/sonar-deep-research":[2.0,8.0,2.0],"perplexityai/sonar-pro":[3.0,15.0,3.0],"perplexityai/sonar-reasoning-pro":[2.0,8.0,2.0],"qwen/deepseek-v4-flash-0731":[0.22,0.66,0.022],"qwen/deepseek-v4-pro-0813":[0.66,1.98,0.066],"qwen/deepseek-v4.1-flash":[0.15,0.6,0.015],"qwen/deepseek-v4.1-flash-1017":[0.15,0.6,0.015],"qwen/qwen-max":[1.6,6.4,0.32],"qwen/qwen-mt-plus":[2.46,7.37,2.46],"qwen/qwen3-coder-flash":[0.3,1.5,0.06],"qwen/qwen3.8-2.4t-a95b":[2.0,6.0,0.25],"qwen/qwen3.8-27b":[0.5,3.0,0.1],"qwen/qwen3.8-flash":[0.15,0.47,0.016],"qwen/qwen3.8-max":[2.0,6.0,0.25],"qwen/qwen3.8-max-0902":[2.0,6.0,0.25],"qwen/qwen3.8-omni-flash":[0.15,0.47,0.15],"scaleway/deepseek-v4-flash-0731":[0.44532,0.89064,0.089064],"scaleway/deepseek-v4.1-flash":[0.669,2.007,0.1338],"scaleway/gemma-3-27b-it":[0.287125,0.57425,0.287125],"scaleway/gpt-oss-120b":[0.166995,0.66798,0.166995],"scaleway/llama-3.3-70b-instruct":[1.001971,1.001971,1.001971],"scaleway/qwen3-235b-a22b-instruct-2507":[0.834975,2.504926,0.834975],"scaleway/qwen3-coder-30b-a3b-instruct":[0.2245,0.898,0.2245],"sference/deepseek-ai/deepseek-v4-flash-0731":[0.28,0.56,0.07],"sference/deepseek-ai/deepseek-v4.1-flash-1017":[0.5,1.5,0.05],"tencent/deepseek-v4-pro-0813":[0.66,1.98,0.022],"tencent/deepseek-v4.1-flash":[0.15,0.6,0.003],"tencent/deepseek-v4.1-flash-1017":[0.15,0.6,0.003],"tencent/hy3":[0.132,0.528,0.033],"tencent/hy4-preview":[0.834,2.501,0.042],"tencent/step-5-preview":[1.0,2.7,0.05],"tensorx/deepseek/deepseek-r1-0528":[0.66,2.6,0.165],"tensorx/deepseek/deepseek-v4-flash-0731":[0.25,0.3,0.0625],"tensorx/deepseek/deepseek-v4-pro-0813":[2.0,4.0,0.5],"tensorx/deepseek/deepseek-v4.1-flash":[0.5,1.5,0.125],"tensorx/deepseek/deepseek-v4.1-flash-1017":[0.5,1.5,0.125],"tensorx/moonshotai/kimi-k2.5":[0.5,2.8,0.125],"together_ai/deepseek-ai/deepseek-v4-pro-0813":[1.32,3.96,0.13],"together_ai/deepseek-ai/deepseek-v4.1-flash":[0.3,1.2,0.006],"together_ai/deepseek-ai/deepseek-v4.1-flash-1017":[0.3,1.2,0.006],"together_ai/meta-models/muse-glimmer-30b":[0.35,1.5,0.04],"together_ai/openai/gpt-oss-120b":[0.15,0.6,0.15],"together_ai/reflection/beam-1.0-501b-a23b":[0.4,1.2,0.04],"together_ai/thinkingmachines/inkling":[1.0,4.05,0.17],"vertex/gemini-2.5-flash-image":[0.3,2.5,0.03],"vertex/gemini-3-flash-preview":[0.5,3.0,0.05],"vertex/gemini-3-pro-image":[2.0,12.0,0.2],"vertex/gemini-3.1-flash-image":[0.5,3.0,0.5],"vertex/gemini-3.1-flash-lite":[0.25,1.5,0.025],"vertex/gemini-3.1-flash-lite-image":[0.25,1.5,0.25],"vertex/gemini-3.1-flash-lite@eu":[0.25,1.5,0.025],"vertex/gemini-3.1-flash-lite@us":[0.25,1.5,0.025],"vertex/gemini-3.1-pro-preview":[2.0,12.0,0.2],"vertex/gemini-3.5-flash":[1.5,9.0,0.15],"vertex/gemini-3.5-flash-lite":[0.3,2.5,0.03],"vertex/gemini-3.5-flash-lite@eu":[0.3,2.5,0.03],"vertex/gemini-3.5-flash-lite@us":[0.3,2.5,0.03],"vertex/gemini-3.5-flash@eu":[1.5,9.0,0.15],"vertex/gemini-3.5-flash@us":[1.5,9.0,0.15],"vertex/gemini-3.6-flash":[0.75,3.75,0.075],"vertex/gemini-3.6-flash@eu":[0.75,3.75,0.075],"vertex/gemini-3.6-flash@us":[0.75,3.75,0.075],"vertex/gemini-3.7-flash":[1.5,7.5,0.15],"vertex/gemini-3.7-flash@eu":[1.5,7.5,0.15],"vertex/gemini-3.7-flash@us":[1.5,7.5,0.15],"vertex/gemini-3.8-flash":[1.5,7.5,0.15],"vertex/gemini-3.8-flash@eu":[1.5,7.5,0.15],"vertex/gemini-3.8-flash@us":[1.5,7.5,0.15],"vertex/gemini-4-argon":[4.0,20.0,0.2],"vertex/gemini-4-argon@eu":[4.0,20.0,0.2],"vertex/gemini-4-argon@us":[4.0,20.0,0.2],"vertex/gemini-flash-latest":[1.5,7.5,0.15],"vertex/gemini-nano-banana-2.1":[1.5,7.5,1.5],"vertex/gemini-pro-latest":[4.0,20.0,0.2],"xai/grok-4-fast-non-reasoning":[0.2,0.5,0.05],"xai/grok-4.20-0309-non-reasoning":[1.25,2.5,0.2],"xai/grok-4.20-0309-reasoning":[1.25,2.5,0.2],"xai/grok-4.3":[1.25,2.5,0.2],"xai/grok-4.5":[2.0,6.0,0.3],"xai/grok-4.6":[2.0,6.0,0.5],"xai/grok-4.7":[2.0,6.0,0.5],"xai/grok-build-0.1":[1.0,2.0,0.2],"xai/grok-latest":[2.0,6.0,0.5],"zai/glm-4.6":[0.6,2.2,0.11],"zai/glm-4.6v":[0.3,0.9,0.05],"zai/glm-4.7":[0.6,2.2,0.11],"zai/glm-5":[1.0,3.2,0.2],"zai/glm-5-turbo":[1.2,4.0,0.24],"zai/glm-5.1":[1.4,4.4,0.26],"zai/glm-5.2":[1.4,4.4,0.26],"zai/glm-5.3":[1.4,4.4,0.26],"zai/glm-5.3-flash":[0.15,0.5,0.03],"zai/glm-5v-turbo":[1.2,4.0,0.24]},"empiriolabs":{"deepseek-v4-1-flash-1017":[0.3,1.2,0.3],"deepseek-v4-flash-0731":[0.424,1.272,0.424],"deepseek-v4-pro":[1.65,3.3,1.65],"deepseek-v4-pro-0813":[1.32,3.96,1.32],"fugu-max":[2.0,6.0,0.25],"fugu-ultra-v1-0":[7.5,45.0,1.5],"fugu-ultra-v1-1":[5.0,30.0,0.5],"fugu-ultra-v2-0":[5.0,30.0,0.5],"gemma-3-27b":[0.0,0.0],"gemma-4-26b-a4b":[0.05,0.29,0.025],"glm-4-5-flash":[0.0,0.0],"glm-4-6v-flash":[0.0,0.0],"glm-4-7-flash":[0.0,0.0],"glm-4-7-flashx":[0.07,0.4,0.063],"glm-5-1":[0.825,3.301,0.165],"glm-5-2":[1.4,4.4,1.4],"glm-5-3":[1.4,4.4,1.4],"glm-5-3-flash":[0.075,0.25,0.075],"kimi-k2-6":[0.8939,3.7131,0.1788],"kimi-k2-7-code":[0.95,4.0,0.95],"kimi-k2-7-code-highspeed":[1.9,8.0,1.9],"kimi-k3":[3.0,15.0,3.0],"mimo-v2-6-flash":[0.14,0.28,0.14],"mimo-v2-6-pro":[0.435,0.87,0.435],"mimo-v2-6-pro-ultraspeed":[4.35,8.7,4.35],"minimax-m2-7":[0.15,0.6,0.03],"minimax-m2-7-highspeed":[0.3,1.2,0.03],"minimax-m3":[0.225,0.9,0.045],"minimax-m3-1-flash":[0.1125,0.45,0.01125],"mistral-small-4":[0.15,0.6,0.15],"muse-glimmer-30b":[0.2,0.8,0.05],"muse-spark-1-1":[1.25,4.25,1.0],"muse-spark-1-2":[1.25,4.25,1.0],"muse-spark-1-3":[1.25,4.25,1.0],"qwen3-5-122b-a10b":[0.115,0.917,0.115],"qwen3-5-27b":[0.086,0.688,0.086],"qwen3-5-35b-a3b":[0.057,0.459,0.057],"qwen3-5-397b-a17b":[0.172,1.032,0.172],"qwen3-5-4b":[0.04,0.07,0.02],"qwen3-5-9b":[0.09,0.13,0.045],"qwen3-5-flash":[0.09,0.368,0.09],"qwen3-5-plus":[0.36,2.21,0.36],"qwen3-6-27b":[0.412564,2.475384,0.412564],"qwen3-6-35b-a3b":[0.07,0.42,0.035],"qwen3-6-flash":[0.25,1.5,0.25],"qwen3-6-plus":[0.5,3.0,0.5],"qwen3-7-flash":[0.03,0.13,0.006],"qwen3-7-max":[2.5,7.5,2.5],"qwen3-7-plus":[0.4,1.6,0.4],"qwen3-8-27b":[0.17,0.5,0.08],"qwen3-8-flash":[0.16,0.47,0.16],"qwen3-8-max":[2.0,6.0,2.0],"qwen3-8-max-0902":[2.0,6.0,2.0],"qwen3-8-omni-flash":[0.3,0.94,0.3],"seed-2-0-code":[0.4,2.4,0.4],"seed-2-0-lite":[0.31,2.5,0.31],"seed-2-0-mini":[0.12,0.5,0.12],"seed-2-0-pro":[0.63,3.79,0.63],"seed-2-1-turbo":[0.63,3.13,0.63],"step-3-5-flash":[0.1,0.3,0.02],"step-3-5-flash-2603":[0.1,0.3,0.02],"step-3-7-flash":[0.2,1.15,0.04],"step-5-preview":[1.0,2.7,0.05]},"engy":{"deepseek-v4-flash-0731":[0.045,0.09,0.009],"deepseek-v4.1-flash":[0.03,0.12,0.006],"deepseek-v4.1-flash-1017":[0.03,0.12,0.006],"glm-5.2":[0.68,1.5,0.18],"glm-5.3":[0.98,3.08,0.18],"glm-5.3-flash":[0.135,0.45,0.027],"kimi-k3":[1.95,9.75,0.195],"qwen3.6-35b-a3b":[0.045,0.3,0.015],"qwen3.8-27b":[0.045,0.32,0.015]},"evroc":{"evroc/roc":[2.875,11.516,2.875],"google/gemma-4-26b-a4b-it":[0.144,0.575,0.144],"intfloat/multilingual-e5-large-instruct":[0.114,0.114,0.114],"mistralai/mistral-medium-3.5-128b":[1.725,6.9,1.725],"moonshotai/kimi-k2.6":[1.4375,5.75,1.4375],"nvidia/llama-3.3-70b-instruct-fp8":[1.15,1.15,1.15],"openai/gpt-oss-120b":[0.23,0.92,0.23],"openai/whisper-large-v3":[0.0023,0.0023,0.0023],"openai/whisper-large-v3-turbo":[0.0023,0.0023,0.0023],"qwen/qwen3-embedding-8b":[0.115,0.115,0.115],"qwen/qwen3-reranker-4b":[0.0575,0.0,0.0575],"qwen/qwen3.6-35b-a3b":[0.345,1.38,0.345],"qwen/qwen3.8-27b":[0.87,3.5,0.87],"zai-org/glm-5.2":[1.4375,5.75,1.4375]},"fastrouter":{"anthropic/claude-opus-4.1":[15.0,75.0,1.5],"anthropic/claude-opus-4.8":[5.0,25.0,0.5],"anthropic/claude-sonnet-4.6":[3.0,15.0,0.3],"deepseek/deepseek-v4-pro":[1.74,3.48,0.145],"google/gemini-2.5-flash":[0.3,2.5,0.03],"google/gemini-2.5-pro":[1.25,10.0,0.125],"google/gemini-3-pro-image-preview":[2.0,12.0,2.0],"google/gemini-3.1-flash-image-preview":[0.5,3.0,0.5],"google/gemini-3.1-pro-preview":[2.0,12.0,0.2],"google/gemini-3.5-flash":[1.5,9.0,0.15],"google/gemma-4-31b-it":[0.1,0.3,0.1],"minimax/minimax-m2.7":[0.3,1.2,0.06],"minimax/minimax-m2.7-highspeed":[0.6,2.4,0.06],"moonshotai/kimi-k2.6":[0.75,3.5,0.15],"openai/gpt-4.1":[2.0,8.0,0.5],"openai/gpt-5":[1.25,10.0,0.125],"openai/gpt-5-mini":[0.25,2.0,0.025],"openai/gpt-5-nano":[0.05,0.4,0.005],"openai/gpt-5.3-codex":[1.75,14.0,0.175],"openai/gpt-5.4-mini":[0.75,4.5,0.075],"openai/gpt-5.4-nano":[0.2,1.25,0.02],"openai/gpt-5.5":[5.0,30.0,0.5],"openai/gpt-5.5-pro":[30.0,180.0,30.0],"openai/gpt-oss-120b":[0.09,0.36,0.09],"openai/gpt-oss-20b":[0.07,0.25,0.007],"sarvam/sarvam-105b":[0.04,0.16,0.025],"x-ai/grok-4":[3.0,15.0,0.75],"x-ai/grok-4.3":[1.25,2.5,0.2],"x-ai/grok-build-0.1":[1.0,2.0,0.2],"z-ai/glm-5":[0.6,2.08,0.12],"z-ai/glm-5.1":[1.05,3.5,0.205]},"fireworks-ai":{"accounts/fireworks/models/deepseek-v4p1-flash":[0.3,1.2,0.006],"accounts/fireworks/models/deepseek-v4p1-flash-1017":[0.3,1.2,0.006],"accounts/fireworks/models/ember-1":[3.0,15.0,0.3],"accounts/fireworks/models/glm-5p3":[1.4,4.4,0.26],"accounts/fireworks/models/glm-5p3-flash":[0.15,0.5,0.03],"accounts/fireworks/models/gpt-oss-120b":[0.15,0.6,0.015],"accounts/fireworks/models/inkling":[1.0,4.05,0.17],"accounts/fireworks/models/kimi-k3":[3.0,15.0,0.3],"accounts/fireworks/models/minimax-m3":[0.3,1.2,0.06],"accounts/fireworks/models/minimax-m3p1-flash":[0.15,0.6,0.015],"accounts/fireworks/models/muse-spark-open":[1.25,4.25,0.15],"accounts/fireworks/models/nemotron-3-ultra-nvfp4":[0.6,2.4,0.12],"accounts/fireworks/models/nemotron-lightning-3p5-30b-a3b":[0.05,0.2,0.01],"accounts/fireworks/models/qwen3p8-2p4t-a95b":[2.0,6.0,0.25],"accounts/fireworks/models/qwen3p8-max":[2.0,6.0,0.25],"accounts/fireworks/routers/deepseek-flash-latest":[0.3,1.2,0.006],"accounts/fireworks/routers/deepseek-v4p1-flash-1017-spot":[0.21,0.84,0.0042],"accounts/fireworks/routers/deepseek-v4p1-flash-spot":[0.21,0.84,0.0042],"accounts/fireworks/routers/glm-5p3-fast":[2.1,6.6,0.39],"accounts/fireworks/routers/glm-5p3-spot":[0.98,3.08,0.182],"accounts/fireworks/routers/glm-fast-latest":[2.1,6.6,0.39],"accounts/fireworks/routers/glm-flash-latest":[0.15,0.5,0.03],"accounts/fireworks/routers/glm-latest":[1.4,4.4,0.26],"accounts/fireworks/routers/kimi-fast-latest":[4.5,22.5,0.45],"accounts/fireworks/routers/kimi-k3-fast":[4.5,22.5,0.45],"accounts/fireworks/routers/kimi-k3-spot":[2.1,10.5,0.21],"accounts/fireworks/routers/kimi-latest":[3.0,15.0,0.3],"accounts/fireworks/routers/minimax-latest":[0.3,1.2,0.06],"accounts/fireworks/routers/qwen-max-latest":[2.0,6.0,0.25]},"freemodel":{"claude-fable-5":[10.0,50.0,1.0],"claude-haiku-4-5-20251001":[1.0,5.0,0.1],"claude-opus-4-6":[5.0,25.0,0.5],"claude-opus-4-7":[5.0,25.0,0.5],"claude-opus-4-8":[5.0,25.0,0.5],"claude-sonnet-4-6":[3.0,15.0,0.3],"gpt-5.3-codex":[1.75,14.0,0.175],"gpt-5.4":[2.5,15.0,0.25],"gpt-5.4-mini":[0.75,4.5,0.075],"gpt-5.5":[5.0,30.0,0.5]},"friendli":{"google/gemma-4-31b-it":[0.14,0.4,0.14],"zai-org/glm-5.1":[1.4,4.4,0.26],"zai-org/glm-5.2":[1.4,4.4,0.26],"zai-org/glm-5.3":[1.26,3.96,0.234],"zai-org/glm-5.3-flash":[0.15,0.5,0.03]},"frogbot":{"claude-haiku-4-5":[1.0,5.0,0.1],"claude-opus-4-6":[5.0,25.0,0.5],"claude-opus-4-7":[5.0,25.0,0.5],"claude-sonnet-4-6":[3.0,15.0,0.3],"deepseek-v4-pro":[1.32,3.96,0.044],"gemini-2.5-flash":[0.3,2.5,0.075],"gemini-2.5-pro":[1.25,10.0,0.31],"gemini-3-1-pro-preview":[2.0,12.0,0.2],"gemini-3-flash-preview":[0.5,3.0,0.05],"gpt-4o":[2.5,10.0,1.25],"gpt-5-3-codex":[1.75,14.0,0.175],"gpt-5-4-mini":[0.75,4.5,0.075],"gpt-5-4-nano":[0.2,1.25,0.02],"gpt-5-5":[5.0,30.0,0.5],"gpt-oss-120b":[0.15,0.6,0.15],"gpt-oss-20b":[0.07,0.2,0.07],"grok-4-1-fast-non-reasoning":[0.2,0.5,0.05],"grok-4-1-fast-reasoning":[0.2,0.5,0.05],"grok-4-3":[1.25,2.5,0.2],"grok-code-fast-1":[0.2,1.5,0.02],"kimi-k2-6":[0.95,4.0,0.16],"kimi-k2.5":[0.6,3.0,0.1],"minimax-m2-5":[0.3,1.2,0.03],"minimax-m2-7":[0.3,1.2,0.06],"qwen-3-6-plus":[0.5,3.0,0.1],"zai-glm-5-1":[1.4,4.4,0.26]},"github-copilot":{"claude-fable-5":[10.0,50.0,1.0],"claude-fable-5.1":[10.0,50.0,0.25],"claude-haiku-4.5":[1.0,5.0,0.1],"claude-haiku-5.5":[0.1,0.5,0.01],"claude-opus-4.7":[5.0,25.0,0.5],"claude-opus-4.8":[5.0,25.0,0.5],"claude-opus-5":[5.0,25.0,0.5],"claude-opus-5.5":[4.0,20.0,0.2],"claude-sonnet-4.6":[3.0,15.0,0.3],"claude-sonnet-5":[2.0,10.0,0.2],"claude-sonnet-5.5":[2.0,10.0,0.1],"gemini-3.5-flash":[1.5,9.0,0.15],"gemini-3.6-flash":[0.75,3.75,0.075],"gemini-3.7-flash":[0.75,3.75,0.075],"gemini-3.8-flash":[0.75,3.75,0.075],"gemini-4-argon":[2.0,10.0,0.1],"gpt-5-mini":[0.25,2.0,0.025],"gpt-5.3-codex":[1.75,14.0,0.175],"gpt-5.4":[2.5,15.0,0.25],"gpt-5.4-mini":[0.75,4.5,0.075],"gpt-5.4-nano":[0.2,1.25,0.02],"gpt-5.5":[5.0,30.0,0.5],"gpt-5.6-luna":[0.2,1.2,0.02],"gpt-5.6-sol":[4.0,20.0,0.4],"gpt-5.6-terra":[2.0,12.0,0.2],"gpt-6-astra":[10.0,50.0,1.0],"gpt-6-luna":[0.1,0.5,0.01],"gpt-6-sol":[2.0,10.0,0.2],"gpt-6.1-sol":[2.0,10.0,0.1],"gpt-6.1-terra":[1.0,5.0,0.05],"grok-4.5":[2.0,6.0,0.5],"grok-4.6":[2.0,6.0,0.5],"grok-4.7":[2.0,6.0,0.5],"kimi-k2.7-code":[0.95,4.0,0.19],"kimi-k3":[3.0,15.0,0.3],"mai-code-1.1-flash":[0.2,1.2,0.02]},"gitlab":{"duo-chat-fable-5":[0.0,0.0],"duo-chat-fable-5-1":[0.0,0.0],"duo-chat-gpt-5-1":[0.0,0.0],"duo-chat-gpt-5-2":[0.0,0.0],"duo-chat-gpt-5-2-codex":[0.0,0.0],"duo-chat-gpt-5-3-codex":[0.0,0.0],"duo-chat-gpt-5-4":[0.0,0.0],"duo-chat-gpt-5-4-mini":[0.0,0.0],"duo-chat-gpt-5-4-nano":[0.0,0.0],"duo-chat-gpt-5-5":[0.0,0.0],"duo-chat-gpt-5-6-luna":[0.0,0.0],"duo-chat-gpt-5-6-sol":[0.0,0.0],"duo-chat-gpt-5-6-terra":[0.0,0.0],"duo-chat-gpt-5-codex":[0.0,0.0],"duo-chat-gpt-5-mini":[0.0,0.0],"duo-chat-gpt-6-1-sol":[0.0,0.0],"duo-chat-gpt-6-astra":[0.0,0.0],"duo-chat-gpt-6-luna":[0.0,0.0],"duo-chat-gpt-6-sol":[0.0,0.0],"duo-chat-haiku-4-5":[0.0,0.0],"duo-chat-haiku-5-5":[0.0,0.0],"duo-chat-opus-4-5":[0.0,0.0],"duo-chat-opus-4-6":[0.0,0.0],"duo-chat-opus-4-7":[0.0,0.0],"duo-chat-opus-4-8":[0.0,0.0],"duo-chat-opus-5":[0.0,0.0],"duo-chat-opus-5-5":[0.0,0.0],"duo-chat-sonnet-4-5":[0.0,0.0],"duo-chat-sonnet-4-6":[0.0,0.0],"duo-chat-sonnet-5":[0.0,0.0],"duo-chat-sonnet-5-5":[0.0,0.0]},"gmicloud":{"anthropic/claude-opus-4.6":[5.0,25.0,0.5],"anthropic/claude-opus-4.7":[4.5,22.5,0.45],"anthropic/claude-opus-4.8":[5.0,25.0,0.5],"anthropic/claude-sonnet-4.6":[3.0,15.0,0.3],"deepseek-ai/deepseek-v4-flash":[0.112,0.224,0.022],"deepseek-ai/deepseek-v4-pro":[1.392,2.784,0.116],"minimaxai/minimax-m2.7":[0.3,1.2,0.06],"minimaxai/minimax-m3":[0.6,2.4,0.12],"moonshotai/kimi-k2.6":[0.855,3.6,0.144],"moonshotai/kimi-k2.7-code-highspeed":[1.9,8.0,0.38],"openai/gpt-5.5":[5.0,30.0,0.5],"qwen/qwen3.7-max":[2.5,7.5,0.25],"qwen/qwen3.8-flash":[0.16,0.47,0.016],"qwen/qwen3.8-max":[2.0,6.0,0.25],"zai-org/glm-5-fp8":[0.6,1.92,0.12],"zai-org/glm-5.1-fp8":[0.98,3.08,0.182],"zai-org/glm-5.2-fp8":[0.979,3.08,0.182]},"google":{"deep-research-max-preview-04-2026":[2.0,12.0,0.2],"deep-research-preview-04-2026":[2.0,12.0,0.2],"gemini-2.5-computer-use-preview-10-2025":[1.25,10.0,1.25],"gemini-2.5-flash":[0.3,2.5,0.03],"gemini-2.5-flash-image":[0.3,30.0,0.075],"gemini-2.5-flash-lite":[0.1,0.4,0.01],"gemini-2.5-flash-preview-tts":[0.5,10.0,0.5],"gemini-2.5-pro":[1.25,10.0,0.125],"gemini-2.5-pro-preview-tts":[1.0,20.0,1.0],"gemini-3-flash-preview":[0.5,3.0,0.05],"gemini-3-pro-image":[2.0,120.0,2.0],"gemini-3.1-flash-image":[0.5,60.0,0.5],"gemini-3.1-flash-lite":[0.25,1.5,0.025],"gemini-3.1-flash-lite-image":[0.25,30.0,0.25],"gemini-3.1-flash-lite-preview":[0.25,1.5,0.025],"gemini-3.1-flash-live-preview":[0.75,4.5,0.75],"gemini-3.1-flash-tts-preview":[1.0,20.0,1.0],"gemini-3.1-pro-preview":[2.0,12.0,0.2],"gemini-3.1-pro-preview-customtools":[2.0,12.0,0.2],"gemini-3.5-flash":[1.5,9.0,0.15],"gemini-3.5-flash-lite":[0.3,2.5,0.03],"gemini-3.5-live-translate-preview":[3.5,21.0,3.5],"gemini-3.6-flash":[0.75,3.75,0.075],"gemini-3.7-flash":[0.75,3.75,0.075],"gemini-3.8-flash":[0.75,3.75,0.075],"gemini-4-argon":[2.0,10.0,0.1],"gemini-embedding-001":[0.15,0.0,0.15],"gemini-embedding-2":[0.2,0.0,0.2],"gemini-flash-latest":[0.75,3.75,0.075],"gemini-flash-lite-latest":[0.3,2.5,0.03],"gemini-omni-flash-preview":[1.5,17.5,1.5],"gemini-pro-latest":[2.0,12.0,0.2],"lyria-3-clip-preview":[0.0,0.0],"lyria-3-pro-preview":[0.0,0.0]},"google-vertex":{"claude-fable-5-1@default":[10.0,50.0,0.25],"claude-fable-5@default":[10.0,50.0,1.0],"claude-haiku-4-5@20251001":[1.0,5.0,0.1],"claude-haiku-5-5@default":[0.1,0.5,0.01],"claude-opus-4-1@20250805":[15.0,75.0,1.5],"claude-opus-4-5@20251101":[5.0,25.0,0.5],"claude-opus-4-6@default":[5.0,25.0,0.5],"claude-opus-4-7@default":[5.0,25.0,0.5],"claude-opus-4-8@default":[5.0,25.0,0.5],"claude-opus-4@20250514":[15.0,75.0,1.5],"claude-opus-5-5@default":[4.0,20.0,0.2],"claude-opus-5@default":[5.0,25.0,0.5],"claude-sonnet-4-5@20250929":[3.0,15.0,0.3],"claude-sonnet-4-6@default":[3.0,15.0,0.3],"claude-sonnet-4@20250514":[3.0,15.0,0.3],"claude-sonnet-5-5@default":[2.0,10.0,0.1],"claude-sonnet-5@default":[2.0,10.0,0.2],"codestral-2":[0.3,0.9,0.3],"deepseek-ai/deepseek-v3.1-maas":[0.6,1.7,0.06],"deepseek-ai/deepseek-v3.2-maas":[0.56,1.68,0.056],"gemini-2.5-flash":[0.3,2.5,0.03],"gemini-2.5-flash-image":[0.3,30.0,0.3],"gemini-2.5-flash-lite":[0.1,0.4,0.01],"gemini-2.5-flash-tts":[0.5,10.0,0.5],"gemini-2.5-pro":[1.25,10.0,0.125],"gemini-2.5-pro-tts":[1.0,20.0,1.0],"gemini-3-flash-preview":[0.5,3.0,0.05],"gemini-3-pro-image":[2.0,120.0,0.2],"gemini-3.1-flash-image":[0.5,60.0,0.05],"gemini-3.1-flash-lite":[0.25,1.5,0.025],"gemini-3.1-flash-lite-image":[0.25,30.0,0.025],"gemini-3.1-pro-preview":[2.0,12.0,0.2],"gemini-3.1-pro-preview-customtools":[2.0,12.0,0.2],"gemini-3.5-flash":[1.5,9.0,0.15],"gemini-3.5-flash-lite":[0.3,2.5,0.03],"gemini-3.6-flash":[0.75,3.75,0.075],"gemini-3.7-flash":[0.75,3.75,0.075],"gemini-3.8-flash":[0.75,3.75,0.075],"gemini-4-argon":[2.0,10.0,0.1],"gemini-embedding-001":[0.15,0.0,0.15],"gemini-nano-banana-2.1":[1.5,30.0,0.15],"google/gemma-4-26b-a4b-it-maas":[0.15,0.6,0.015],"meta/llama-3.3-70b-instruct-maas":[0.72,0.72,0.72],"meta/llama-4-maverick-17b-128e-instruct-maas":[0.35,1.15,0.35],"meta/llama-4-scout-17b-16e-instruct-maas":[0.25,0.7,0.25],"mistral-medium-3":[0.4,2.0,0.4],"mistral-small-2503":[0.1,0.3,0.1],"moonshotai/kimi-k2-thinking-maas":[0.6,2.5,0.06],"openai/gpt-oss-120b-maas":[0.09,0.36,0.09],"openai/gpt-oss-20b-maas":[0.07,0.25,0.007],"qwen/qwen3-235b-a22b-instruct-2507-maas":[0.22,0.88,0.22],"xai/grok-4.1-fast-non-reasoning":[0.2,0.5,0.05],"xai/grok-4.1-fast-reasoning":[0.2,0.5,0.05],"xai/grok-4.20-non-reasoning":[1.25,2.5,0.2],"xai/grok-4.20-reasoning":[1.25,2.5,0.2],"xai/grok-4.3":[1.25,2.5,0.2],"xai/grok-4.6":[2.0,6.0,0.5],"xai/grok-4.7":[2.0,6.0,0.5],"zai-org/glm-4.7-maas":[0.6,2.2,0.06],"zai-org/glm-5-maas":[1.0,3.2,0.1],"zai-org/glm-5.2-maas":[1.4,4.4,0.14]},"google-vertex-anthropic":{"claude-fable-5-1@default":[10.0,50.0,0.25],"claude-fable-5@default":[10.0,50.0,1.0],"claude-haiku-4-5@20251001":[1.0,5.0,0.1],"claude-haiku-5-5@default":[0.1,0.5,0.01],"claude-opus-4-1@20250805":[15.0,75.0,1.5],"claude-opus-4-5@20251101":[5.0,25.0,0.5],"claude-opus-4-6@default":[5.0,25.0,0.5],"claude-opus-4-7@default":[5.0,25.0,0.5],"claude-opus-4-8@default":[5.0,25.0,0.5],"claude-opus-4@20250514":[15.0,75.0,1.5],"claude-opus-5-5@default":[4.0,20.0,0.2],"claude-opus-5@default":[5.0,25.0,0.5],"claude-sonnet-4-5@20250929":[3.0,15.0,0.3],"claude-sonnet-4-6@default":[3.0,15.0,0.3],"claude-sonnet-4@20250514":[3.0,15.0,0.3],"claude-sonnet-5-5@default":[2.0,10.0,0.1],"claude-sonnet-5@default":[2.0,10.0,0.2]},"greenpt":{"deepseek-v4-flash-0731":[0.1596,0.399,0.0456],"deepseek-v4.1-flash":[0.255552,1.27776,0.0127776],"devstral-2-123b-instruct-2512":[0.57,2.736,0.57],"gemma-3-27b-it":[0.342,0.684,0.342],"gemma4":[0.57,1.71,0.57],"glm-5.1":[1.756,5.518,1.756],"glm-5.2":[1.738325,5.1589,0.4486],"glm-5.2-caveman":[1.738325,5.1589,0.4486],"glm-5.2-caveman-lite":[1.738325,5.1589,0.4486],"glm-5.2-caveman-ultra":[1.738325,5.1589,0.4486],"glm-5.2-honey":[1.738325,5.1589,0.4486],"glm-5.2-honey-lite":[1.738325,5.1589,0.4486],"glm-5.2-honey-ultra":[1.738325,5.1589,0.4486],"glm-5.2-ponytail":[1.738325,5.1589,0.4486],"glm-5.2-ponytail-lite":[1.738325,5.1589,0.4486],"glm-5.2-ponytail-ultra":[1.738325,5.1589,0.4486],"glm-5.3":[1.27754,5.11016,0.319385],"glm-5.3-flash":[0.127754,0.511016,0.0255508],"gpt-oss-120b":[0.228,0.798,0.228],"green-l":[0.285,0.912,0.285],"green-l-raw":[0.285,0.912,0.285],"green-r":[0.399,1.083,0.399],"green-r-raw":[0.399,1.083,0.399],"holo2-30b-a3b":[0.399,0.969,0.399],"kimi-k2.6":[0.7524,4.275,0.2508],"kimi-k2.6-fast":[1.655,8.778,1.655],"kimi-k2.7-code":[0.863555,4.317775,0.222057],"kimi-k3":[3.762,18.81,0.9405],"llama-3.3-70b-instruct":[1.254,1.254,1.254],"minimax-m2.5":[0.49346,2.4673,0.123365],"mistral-medium-3.5-128b":[2.052,10.26,2.052],"mistral-small-3.2-24b-instruct-2506":[0.228,0.456,0.228],"pixtral-12b-2409":[0.285,0.285,0.285],"qwen3-235b-a22b-instruct-2507":[1.026,3.078,1.026],"qwen3-coder-30b-a3b-instruct":[0.285,1.083,0.285],"qwen3.5-397b-a17b":[0.798,4.959,0.798],"qwen3.6-35b-a3b":[0.342,2.052,0.342],"voxtral-small-24b-2507":[0.228,0.513,0.228]},"groq":{"allam-2-7b":[0.0,0.0],"llama-3.1-8b-instant":[0.05,0.08,0.05],"llama-3.3-70b-versatile":[0.59,0.79,0.59],"meta-llama/llama-prompt-guard-2-22m":[0.03,0.03,0.03],"meta-llama/llama-prompt-guard-2-86m":[0.04,0.04,0.04],"openai/gpt-oss-120b":[0.15,0.6,0.075],"openai/gpt-oss-20b":[0.075,0.3,0.0375],"openai/gpt-oss-safeguard-20b":[0.075,0.3,0.0375],"qwen/qwen3.6-27b":[0.6,3.0,0.3],"qwen/qwen3.8-27b":[0.8,4.0,0.8]},"helicone":{"chatgpt-4o-latest":[5.0,20.0,2.5],"claude-3-haiku-20240307":[0.25,1.25,0.03],"claude-3.5-haiku":[0.8,4.0,0.08],"claude-3.5-sonnet-v2":[3.0,15.0,0.3],"claude-3.7-sonnet":[3.0,15.0,0.3],"claude-4.5-haiku":[1.0,5.0,0.1],"claude-4.5-opus":[5.0,25.0,0.5],"claude-4.5-sonnet":[3.0,15.0,0.3],"claude-haiku-4-5-20251001":[1.0,5.0,0.1],"claude-opus-4":[15.0,75.0,1.5],"claude-opus-4-1":[15.0,75.0,1.5],"claude-opus-4-1-20250805":[15.0,75.0,1.5],"claude-sonnet-4":[3.0,15.0,0.3],"claude-sonnet-4-5-20250929":[3.0,15.0,0.3],"deepseek-r1-distill-llama-70b":[0.03,0.13,0.03],"deepseek-reasoner":[0.56,1.68,0.07],"deepseek-tng-r1t2-chimera":[0.3,1.2,0.3],"deepseek-v3":[0.56,1.68,0.07],"deepseek-v3.1-terminus":[0.27,1.0,0.216],"deepseek-v3.2":[0.27,0.41,0.27],"ernie-4.5-21b-a3b-thinking":[0.07,0.28,0.07],"gemini-2.5-flash":[0.3,2.5,0.075],"gemini-2.5-flash-lite":[0.1,0.4,0.025],"gemini-2.5-pro":[1.25,10.0,0.3125],"gemini-3-pro-preview":[2.0,12.0,0.2],"gemma-3-12b-it":[0.05,0.1,0.05],"gemma2-9b-it":[0.01,0.03,0.01],"glm-4.6":[0.45,1.5,0.45],"gpt-4.1":[2.0,8.0,0.5],"gpt-4.1-mini":[0.4,1.6,0.1],"gpt-4.1-mini-2025-04-14":[0.4,1.6,0.1],"gpt-4.1-nano":[0.1,0.4,0.025],"gpt-4o":[2.5,10.0,1.25],"gpt-4o-mini":[0.15,0.6,0.075],"gpt-5":[1.25,10.0,0.125],"gpt-5-chat-latest":[1.25,10.0,0.125],"gpt-5-codex":[1.25,10.0,0.125],"gpt-5-mini":[0.25,2.0,0.025],"gpt-5-nano":[0.05,0.4,0.005],"gpt-5-pro":[15.0,120.0,15.0],"gpt-5.1":[1.25,10.0,0.125],"gpt-5.1-chat-latest":[1.25,10.0,0.125],"gpt-5.1-codex":[1.25,10.0,0.125],"gpt-5.1-codex-mini":[0.25,2.0,0.025],"gpt-oss-120b":[0.04,0.16,0.04],"gpt-oss-20b":[0.05,0.2,0.05],"grok-3":[3.0,15.0,0.75],"grok-3-mini":[0.3,0.5,0.075],"grok-4":[3.0,15.0,0.75],"grok-4-1-fast-non-reasoning":[0.2,0.5,0.05],"grok-4-1-fast-reasoning":[0.2,0.5,0.05],"grok-4-fast-non-reasoning":[0.2,0.5,0.05],"grok-4-fast-reasoning":[0.2,0.5,0.05],"grok-code-fast-1":[0.2,1.5,0.02],"hermes-2-pro-llama-3-8b":[0.14,0.14,0.14],"kimi-k2-0711":[0.57,2.3,0.57],"kimi-k2-0905":[0.5,2.0,0.4],"kimi-k2-thinking":[0.48,2.0,0.48],"llama-3.1-8b-instant":[0.05,0.08,0.05],"llama-3.1-8b-instruct":[0.02,0.05,0.02],"llama-3.1-8b-instruct-turbo":[0.02,0.03,0.02],"llama-3.3-70b-instruct":[0.13,0.39,0.13],"llama-3.3-70b-versatile":[0.59,0.79,0.59],"llama-4-maverick":[0.15,0.6,0.15],"llama-4-scout":[0.08,0.3,0.08],"llama-guard-4":[0.21,0.21,0.21],"llama-prompt-guard-2-22m":[0.01,0.01,0.01],"llama-prompt-guard-2-86m":[0.01,0.01,0.01],"mistral-large-2411":[2.0,6.0,2.0],"mistral-nemo":[20.0,40.0,20.0],"mistral-small":[0.075,0.2,0.075],"o1":[15.0,60.0,7.5],"o1-mini":[1.1,4.4,0.55],"o3":[2.0,8.0,0.5],"o3-mini":[1.1,4.4,0.55],"o3-pro":[20.0,80.0,20.0],"o4-mini":[1.1,4.4,0.275],"qwen2.5-coder-7b-fast":[0.03,0.09,0.03],"qwen3-235b-a22b-thinking":[0.3,2.9,0.3],"qwen3-30b-a3b":[0.08,0.29,0.08],"qwen3-32b":[0.29,0.59,0.29],"qwen3-coder":[0.22,0.95,0.22],"qwen3-coder-30b-a3b-instruct":[0.1,0.3,0.1],"qwen3-next-80b-a3b-instruct":[0.14,1.4,0.14],"qwen3-vl-235b-a22b-instruct":[0.3,1.5,0.3],"sonar":[1.0,1.0,1.0],"sonar-deep-research":[2.0,8.0,2.0],"sonar-pro":[3.0,15.0,3.0],"sonar-reasoning":[1.0,5.0,1.0],"sonar-reasoning-pro":[2.0,8.0,2.0]},"hetzner":{"qwen/qwen3.6-35b-a3b-fp8":[0.0,0.0],"qwen3.8-27b":[0.0,0.0]},"hpc-ai":{"anthropic/claude-opus-4.7":[5.0,25.0,0.5],"deepseek/deepseek-v4-flash":[0.14,0.28,0.028],"deepseek/deepseek-v4-pro":[1.74,3.48,0.145],"minimax/minimax-m2.5":[0.3,1.2,0.03],"moonshotai/kimi-k2.5":[0.6,3.0,0.1],"moonshotai/kimi-k2.7-code":[0.95,4.0,0.19],"openai/gpt-5.5":[5.0,30.0,0.5],"zai-org/glm-5.1":[0.615,2.46,0.133],"zai-org/glm-5.2":[1.4,4.4,0.26]},"huggingface":{"deepseek-ai/deepseek-r1":[0.7,2.5,0.7],"deepseek-ai/deepseek-r1-0528":[3.0,5.0,3.0],"deepseek-ai/deepseek-v3":[0.4,1.3,0.4],"deepseek-ai/deepseek-v3-0324":[0.27,1.12,0.27],"deepseek-ai/deepseek-v3.1":[0.27,1.0,0.27],"deepseek-ai/deepseek-v3.2":[0.28,0.4,0.28],"deepseek-ai/deepseek-v4-flash":[0.14,0.28,0.14],"deepseek-ai/deepseek-v4-flash-0731":[0.14,0.28,0.14],"deepseek-ai/deepseek-v4-flash-vision-exp":[0.44,1.32,0.44],"deepseek-ai/deepseek-v4-pro":[0.435,0.87,0.003625],"deepseek-ai/deepseek-v4-pro-0813":[1.32,3.96,1.32],"deepseek-ai/deepseek-v4.1-flash":[0.3,1.2,0.3],"deepseek-ai/deepseek-v4.1-flash-1017":[0.3,1.2,0.3],"google/gemma-3-12b-it":[0.05,0.15,0.05],"google/gemma-3-27b-it":[0.08,0.16,0.08],"google/gemma-3-4b-it":[0.05,0.1,0.05],"google/gemma-4-26b-a4b-it":[0.13,0.4,0.13],"google/gemma-4-31b-it":[0.14,0.4,0.14],"meta-llama/llama-3.1-8b-instruct":[0.06,0.06,0.06],"meta-llama/llama-3.3-70b-instruct":[0.59,0.79,0.59],"meta-llama/llama-guard-4-12b":[0.18,0.18,0.18],"minimaxai/minimax-m1-80k":[0.55,2.2,0.55],"minimaxai/minimax-m2":[0.3,1.2,0.3],"minimaxai/minimax-m2.1":[0.3,1.2,0.3],"minimaxai/minimax-m2.5":[0.3,1.2,0.03],"minimaxai/minimax-m2.7":[0.3,1.2,0.06],"minimaxai/minimax-m3":[0.3,1.2,0.3],"minimaxai/minimax-m3.1-flash":[0.15,0.6,0.15],"moonshotai/kimi-k2-instruct":[1.0,3.0,1.0],"moonshotai/kimi-k2-instruct-0905":[1.0,3.0,1.0],"moonshotai/kimi-k2-thinking":[0.6,2.5,0.15],"moonshotai/kimi-k2.5":[0.6,3.0,0.1],"moonshotai/kimi-k2.6":[0.95,4.0,0.16],"moonshotai/kimi-k2.7-code":[0.95,4.0,0.95],"moonshotai/kimi-k3":[3.0,15.0,3.0],"openai/gpt-oss-120b":[0.25,0.69,0.25],"openai/gpt-oss-20b":[0.1,0.5,0.1],"qwen/qwen2.5-coder-32b-instruct":[0.06,0.2,0.06],"qwen/qwen3-235b-a22b":[0.2,0.8,0.2],"qwen/qwen3-235b-a22b-instruct-2507":[0.855,2.565,0.855],"qwen/qwen3-235b-a22b-thinking-2507":[0.3,3.0,0.3],"qwen/qwen3-30b-a3b":[0.12,0.5,0.12],"qwen/qwen3-32b":[0.29,0.59,0.29],"qwen/qwen3-8b":[0.07,0.18,0.07],"qwen/qwen3-coder-30b-a3b-instruct":[0.07,0.26,0.07],"qwen/qwen3-coder-480b-a35b-instruct":[2.0,2.0,2.0],"qwen/qwen3-coder-next":[0.2,1.5,0.2],"qwen/qwen3-embedding-4b":[0.01,0.0,0.01],"qwen/qwen3-embedding-8b":[0.01,0.0,0.01],"qwen/qwen3-next-80b-a3b-instruct":[0.25,1.0,0.25],"qwen/qwen3-vl-235b-a22b-instruct":[0.3,1.5,0.3],"qwen/qwen3-vl-235b-a22b-thinking":[0.98,3.95,0.98],"qwen/qwen3-vl-30b-a3b-instruct":[0.2,0.7,0.2],"qwen/qwen3.5-122b-a10b":[0.4,3.2,0.4],"qwen/qwen3.5-27b":[0.3,2.4,0.3],"qwen/qwen3.5-35b-a3b":[0.25,2.0,0.25],"qwen/qwen3.5-397b-a17b":[0.6,3.6,0.6],"qwen/qwen3.5-9b":[0.17,0.25,0.17],"qwen/qwen3.6-27b":[0.47,3.19,0.47],"qwen/qwen3.6-35b-a3b":[0.15,0.95,0.15],"qwen/qwen3.8-2.4t-a95b":[2.5,6.25,2.5],"qwen/qwen3.8-27b":[0.4,3.0,0.4],"stepfun-ai/step-3.5-flash":[0.1,0.3,0.1],"stepfun-ai/step-3.7-flash":[0.2,1.15,0.2],"tencent/hy3":[0.14,0.58,0.14],"tencent/hy4-preview":[0.834,2.501,0.834],"thinkingmachines/inkling":[1.0,4.05,1.0],"thinkingmachines/inkling-small":[0.5,1.2,0.5],"xiaomimimo/mimo-v2.5":[0.4,2.0,0.4],"xiaomimimo/mimo-v2.5-pro":[1.0,3.0,1.0],"zai-org/autoglm-phone-9b-multilingual":[0.035,0.138,0.035],"zai-org/glm-4.5-air":[0.13,0.85,0.13],"zai-org/glm-4.5v":[0.6,1.8,0.6],"zai-org/glm-4.6":[0.55,2.2,0.55],"zai-org/glm-4.6v-flash":[0.3,0.9,0.3],"zai-org/glm-4.7":[0.6,2.2,0.11],"zai-org/glm-4.7-flash":[0.0,0.0],"zai-org/glm-5":[1.0,3.2,0.2],"zai-org/glm-5.1":[1.0,3.2,0.2],"zai-org/glm-5.2":[1.4,4.4,1.4],"zai-org/glm-5.3":[1.4,4.4,1.4],"zai-org/glm-5.3-flash":[0.15,0.5,0.15]},"hyper":{"deepseek-v4-flash-0731":[0.44,1.32,0.044],"deepseek-v4-pro-0813":[1.437216,4.311648,0.047907],"deepseek-v4.1-flash":[0.33,1.31,0.03],"deepseek-v4.1-flash-1017":[0.33,1.31,0.03],"gemma-4-26b-a4b-it":[0.098,0.334,0.049],"glm-5.2":[1.52432,4.79072,0.152432],"glm-5.3":[1.52432,4.79072,0.283088],"glm-5.3-flash":[0.16332,0.5444,0.031575],"gpt-oss-120b":[0.178,0.68,0.089],"inkling":[1.0888,4.40964,0.185096],"kimi-k2-thinking":[0.6,2.5,0.3],"kimi-k2.7-code":[1.03436,4.3552,0.206872],"kimi-k3":[3.2664,16.332,0.32664],"minimax-m2.7":[0.484,1.852,0.242],"minimax-m3":[0.32664,1.30656,0.064239],"prism":[3.2664,16.332,0.32664],"qwen3.7-flash":[0.2,0.8,0.04],"qwen3.7-max":[2.5,7.5,0.5],"qwen3.7-plus":[1.2,4.8,0.24],"qwen3.8-2.4t-a95b":[2.0,6.0,0.25],"qwen3.8-27b":[0.5,3.0,0.1],"qwen3.8-flash":[0.15,0.47,0.016],"qwen3.8-max":[2.0,6.0,0.25]},"impossibl":{"anthropic/claude-fable-5":[10.0,50.0,1.0],"anthropic/claude-haiku-4-5":[1.0,5.0,0.1],"anthropic/claude-opus-4-5":[5.0,25.0,0.5],"anthropic/claude-opus-4-6":[5.0,25.0,0.5],"anthropic/claude-opus-4-7":[5.0,25.0,0.5],"anthropic/claude-opus-4-8":[5.0,25.0,0.5],"anthropic/claude-sonnet-4-5":[3.0,15.0,0.3],"anthropic/claude-sonnet-4-6":[3.0,15.0,0.3],"anthropic/claude-sonnet-5":[2.0,10.0,0.2],"cerebras/gpt-oss-120b":[0.35,0.75,0.35],"deepseek/deepseek-v4-flash":[0.19,0.51,0.028],"deepseek/deepseek-v4-pro":[1.74,3.48,0.145],"fireworks/glm-5.2":[1.4,4.4,0.14],"fireworks/gpt-oss-120b":[0.15,0.6,0.015],"fireworks/gpt-oss-20b":[0.07,0.3,0.035],"google/gemini-2.5-flash":[0.3,2.5,0.03],"google/gemini-2.5-flash-lite":[0.1,0.4,0.01],"google/gemini-2.5-pro":[1.25,10.0,0.125],"google/gemini-3.1-flash-lite":[0.25,1.5,0.025],"google/gemini-3.1-pro-preview":[2.0,12.0,0.2],"google/gemini-3.5-flash":[1.5,9.0,0.15],"google/gemini-3.5-flash-lite":[0.3,2.5,0.03],"google/gemini-3.6-flash":[0.75,3.75,0.075],"groq/gpt-oss-120b":[0.15,0.6,0.075],"groq/gpt-oss-20b":[0.075,0.3,0.0375],"moonshotai/kimi-k3":[3.0,15.0,0.3],"openai/gpt-3.5-turbo":[0.5,1.5,0.5],"openai/gpt-4-turbo":[10.0,30.0,10.0],"openai/gpt-4.1":[2.0,8.0,0.5],"openai/gpt-4.1-mini":[0.4,1.6,0.1],"openai/gpt-4.1-nano":[0.1,0.4,0.025],"openai/gpt-4o":[2.5,10.0,1.25],"openai/gpt-4o-mini":[0.15,0.6,0.075],"openai/gpt-5":[1.25,10.0,0.125],"openai/gpt-5-codex":[1.25,10.0,0.125],"openai/gpt-5-mini":[0.25,2.0,0.025],"openai/gpt-5-nano":[0.05,0.4,0.005],"openai/gpt-5-pro":[15.0,120.0,15.0],"openai/gpt-5.1":[1.25,10.0,0.125],"openai/gpt-5.1-codex":[1.25,10.0,0.125],"openai/gpt-5.1-codex-mini":[0.25,2.0,0.025],"openai/gpt-5.2":[1.75,14.0,0.175],"openai/gpt-5.2-codex":[1.75,14.0,0.175],"openai/gpt-5.3-codex":[1.75,14.0,0.175],"openai/gpt-5.4":[2.5,15.0,0.25],"openai/gpt-5.4-mini":[0.75,4.5,0.075],"openai/gpt-5.4-nano":[0.2,1.25,0.02],"openai/gpt-5.4-pro":[30.0,180.0,3.0],"openai/gpt-5.5":[5.0,30.0,0.5],"openai/gpt-5.5-pro":[30.0,180.0,3.0],"openai/gpt-5.6-luna":[0.2,1.2,0.02],"openai/gpt-5.6-sol":[4.0,20.0,0.4],"openai/gpt-5.6-terra":[2.0,12.0,0.2],"openai/o1":[15.0,60.0,7.5],"openai/o3":[2.0,8.0,0.5],"openai/o3-mini":[1.1,4.4,0.55],"openai/o4-mini":[1.1,4.4,0.275],"qwen/qwen3.6-flash":[0.25,1.5,0.05],"qwen/qwen3.7-max":[2.5,7.5,0.5],"qwen/qwen3.7-plus":[0.4,1.6,0.08],"qwen/qwen3.8-max-preview":[2.5,7.5,2.5],"thinkingmachines/inkling":[1.87,4.68,0.374],"xai/grok-4.20-0309-non-reasoning":[1.25,2.5,0.2],"xai/grok-4.20-0309-reasoning":[1.25,2.5,0.2],"xai/grok-4.3":[1.25,2.5,0.2],"xai/grok-4.5":[2.0,6.0,0.3],"xai/grok-build-0.1":[1.0,2.0,0.2],"xiaomi/mimo-v2.5":[0.14,0.28,0.003],"zai/glm-4.5":[0.6,2.2,0.11],"zai/glm-4.5-air":[0.2,1.1,0.03],"zai/glm-4.6":[0.6,2.2,0.11],"zai/glm-4.7":[0.6,2.2,0.11],"zai/glm-5":[1.0,3.2,0.2],"zai/glm-5-turbo":[1.2,4.0,0.24],"zai/glm-5.1":[1.4,4.4,0.26],"zai/glm-5.2":[1.4,4.4,0.26]},"inception":{"mercury-2":[0.25,0.75,0.025],"mercury-2.5":[0.2,0.75,0.02],"mercury-3":[0.1,0.35,0.01],"mercury-edit-2":[0.25,0.75,0.025]},"inceptron":{"deepseek-ai/deepseek-v4-flash-0731":[0.13,0.3688,0.027],"moonshotai/kimi-k2.6":[0.6236,3.5,0.1674],"moonshotai/kimi-k2.7-code":[0.56,3.1,0.15],"zai-org/glm-5.2":[1.2,4.4,0.16],"zai-org/glm-5.3":[1.2,2.2,0.14],"zai-org/glm-5.3-flash":[0.17,0.6,0.06]},"inco":{"deepseek-v4.1-flash:fast":[0.6,2.4,0.012],"glm-5.3":[1.4,4.4,0.26],"glm-5.3-flash:fast":[0.3,1.0,0.06],"glm-5.3:fast":[2.8,8.8,0.52],"kimi-k3:fast":[6.0,30.0,0.6],"minimax-m3":[0.3,1.2,0.06],"minimax-m3:fast":[0.6,2.4,0.12]},"infer":{"infer/gpt-5.6-sol:official":[2.5,12.5,0.25],"infer/gpt-6-astra:official":[12.5,62.5,1.25]},"inference":{"google/gemma-3":[0.15,0.3,0.15],"meta/llama-3.1-8b-instruct":[0.025,0.025,0.025],"meta/llama-3.2-11b-vision-instruct":[0.055,0.055,0.055],"meta/llama-3.2-1b-instruct":[0.01,0.01,0.01],"meta/llama-3.2-3b-instruct":[0.02,0.02,0.02],"mistral/mistral-nemo-12b-instruct":[0.038,0.1,0.038],"osmosis/osmosis-structure-0.6b":[0.1,0.5,0.1],"qwen/qwen-2.5-7b-vision-instruct":[0.2,0.2,0.2],"qwen/qwen3-embedding-4b":[0.01,0.0,0.01]},"inferx":{"agents-a1":[0.0,0.0],"deepseek-v4-flash":[0.0,0.0],"devstral-2-123b-instruct-2512-int4-autoround":[0.0,0.0],"gemma-4-31b-it-fp8":[0.0,0.0],"mimo-v25":[0.0,0.0],"ornith-1.0-35b-fp8":[0.0,0.0],"qwen3-coder-next-fp8":[0.0,0.0],"qwen3-coder-next-fp8-no-thinking":[0.0,0.0],"qwen3-embedding-8b":[0.0,0.0],"qwen3.6-27b-fp8":[0.0,0.0],"qwen3.6-35b-a3b-fp8":[0.0,0.0],"qwen3.6-35b-a3b-fp8-no-thinking":[0.0,0.0]},"infomaniak":{"bge_multilingual_gemma2":[0.08,0.0,0.08],"google/gemma-4-31b-it":[0.25,0.5,0.25],"mini_lm_l12_v2":[0.0,0.0],"mistralai/ministral-3-14b-instruct-2512":[0.37,0.5,0.37],"mistralai/mistral-small-4-119b-2603":[0.25,0.93,0.25],"moonshotai/kimi-k2.6":[0.74,3.72,0.74],"nvidia/nvidia-nemotron-3-nano-30b-a3b-fp8":[0.06,0.25,0.06],"qwen/qwen3.5-122b-a10b-fp8":[0.5,3.97,0.5],"qwen/qwen3.5-397b-a17b-fp8":[0.99,4.46,0.99],"swiss-ai/apertus-v1.5-70b":[0.87,3.1,0.87]},"io-net":{"deepseek-ai/deepseek-r1-0528":[0.523667,2.205333,0.261834],"intel/qwen3-coder-480b-a35b-instruct-int4-mixed-ar":[0.46125,2.29375,0.230625],"meta-llama/llama-3.2-90b-vision-instruct":[0.35,0.4,0.175],"meta-llama/llama-3.3-70b-instruct":[0.5466,1.0226,0.2733],"meta-llama/llama-4-maverick-17b-128e-instruct-fp8":[0.26875,0.82625,0.134375],"mistralai/devstral-small-2505":[0.05,0.22,0.025],"mistralai/magistral-small-2506":[0.5,1.5,0.25],"mistralai/mistral-large-instruct-2411":[2.0,6.0,1.0],"mistralai/mistral-nemo-instruct-2407":[0.0514,0.082,0.0257],"moonshotai/kimi-k2-instruct-0905":[0.57,2.3,0.285],"moonshotai/kimi-k2-thinking":[0.6,2.5,0.3],"openai/gpt-oss-120b":[0.188,0.7,0.094],"openai/gpt-oss-20b":[0.055,0.194,0.0275],"qwen/qwen2.5-vl-32b-instruct":[0.05,0.22,0.025],"qwen/qwen3-235b-a22b-thinking-2507":[0.11,0.6,0.055],"qwen/qwen3-next-80b-a3b-instruct":[0.11875,1.2625,0.059375],"zai-org/glm-4.6":[0.52,2.0375,0.26]},"iteracompute":{"deepseek/deepseek-v4-flash-0731":[0.17,0.7,0.005],"deepseek/deepseek-v4-pro-0813":[0.79,2.38,0.026],"deepseek/deepseek-v4.1-flash":[0.17,0.7,0.005],"minimax/minimax-m3":[0.3,1.19,0.05],"moonshotai/kimi-k2.7-code":[0.69,3.29,0.15],"moonshotai/kimi-k3":[2.35,11.76,0.23],"qwen/qwen3.8-2.4t-a95b":[1.95,5.7,0.25],"qwen/qwen3.8-27b":[0.0,0.0],"z-ai/glm-5.3":[0.82,2.88,0.2],"z-ai/glm-5.3-flash":[0.08,0.28,0.023]},"jalapeno":{"deepseek-v4-flash":[0.14,0.28,0.028],"deepseek-v4-pro":[1.6,3.38,0.14],"glm-5.1":[1.38,4.4,0.26],"glm-5.2":[1.4,4.4,0.26],"hy3":[0.14,0.58,0.14],"kimi-k2.5":[0.6,3.0,0.1],"kimi-k2.7-code":[0.95,4.0,0.19],"kimi-k3":[3.0,15.0,0.3],"minimax-m3":[0.3,1.2,0.06],"qwen3-next-80b-a3b-instruct":[0.15,1.5,0.15],"qwen3-next-80b-a3b-thinking":[0.15,1.5,0.15],"qwen3-vl-235b-a22b-instruct":[0.3,1.5,0.3],"qwen3-vl-235b-a22b-thinking":[0.98,3.95,0.98],"qwen3.5-122b-a10b":[0.4,3.2,0.4],"qwen3.5-27b":[0.3,2.4,0.3],"qwen3.5-35b-a3b":[0.25,2.0,0.25],"qwen3.5-397b-a17b":[0.6,3.6,0.6]},"jiekou":{"baidu/ernie-4.5-300b-a47b-paddle":[0.28,1.1,0.28],"baidu/ernie-4.5-vl-424b-a47b":[0.42,1.25,0.42],"claude-haiku-4-5-20251001":[1.0,5.0,0.1],"claude-opus-4-1-20250805":[13.5,67.5,13.5],"claude-opus-4-20250514":[13.5,67.5,13.5],"claude-opus-4-5-20251101":[4.75,23.75,0.475],"claude-opus-4-6":[5.0,25.0,0.5],"claude-sonnet-4-20250514":[2.7,13.5,2.7],"claude-sonnet-4-5-20250929":[3.0,15.0,0.3],"deepseek/deepseek-r1-0528":[0.7,2.5,0.35],"deepseek/deepseek-v3-0324":[0.28,1.14,0.14],"deepseek/deepseek-v3.1":[0.27,1.0,0.27],"gemini-2.5-flash":[0.285,2.375,0.0285],"gemini-2.5-flash-lite":[0.095,0.38,0.0095],"gemini-2.5-flash-lite-preview-06-17":[0.09,0.36,0.09],"gemini-2.5-flash-lite-preview-09-2025":[0.09,0.36,0.09],"gemini-2.5-flash-preview-05-20":[0.1425,3.325,0.0285],"gemini-2.5-pro":[1.1875,9.5,0.1187],"gemini-2.5-pro-preview-06-05":[1.1875,9.5,0.1187],"gemini-3-flash-preview":[0.475,2.85,0.0475],"gemini-3-pro-preview":[1.8,10.8,1.8],"gpt-5-chat-latest":[1.125,9.0,1.125],"gpt-5-codex":[1.1875,9.5,0.1187],"gpt-5-mini":[0.2375,1.9,0.0237],"gpt-5-nano":[0.0475,0.38,0.0047],"gpt-5-pro":[14.25,114.0,14.25],"gpt-5.1":[1.1875,9.5,0.1187],"gpt-5.1-codex":[1.1875,9.5,0.1187],"gpt-5.1-codex-max":[1.1875,9.5,0.1187],"gpt-5.1-codex-mini":[0.2375,1.9,0.0237],"gpt-5.2":[1.6625,13.3,0.1662],"gpt-5.2-codex":[1.75,14.0,0.175],"gpt-5.2-pro":[19.95,159.6,19.95],"grok-4-0709":[2.85,14.25,2.85],"grok-4-1-fast-non-reasoning":[0.19,0.475,0.19],"grok-4-1-fast-reasoning":[0.19,0.475,0.19],"grok-4-fast-non-reasoning":[0.18,0.45,0.18],"grok-4-fast-reasoning":[0.18,0.45,0.18],"grok-code-fast-1":[0.19,1.425,0.019],"minimax/minimax-m2.1":[0.3,1.2,0.03],"minimaxai/minimax-m1-80k":[0.55,2.2,0.55],"moonshotai/kimi-k2-0905":[0.6,2.5,0.6],"moonshotai/kimi-k2-instruct":[0.57,2.3,0.57],"moonshotai/kimi-k2.5":[0.6,3.0,0.1],"o3":[9.5,38.0,0.475],"o3-mini":[1.045,4.18,0.5225],"o4-mini":[1.1,4.4,1.1],"qwen/qwen3-235b-a22b-fp8":[0.2,0.8,0.2],"qwen/qwen3-235b-a22b-instruct-2507":[0.15,0.8,0.15],"qwen/qwen3-235b-a22b-thinking-2507":[0.3,3.0,0.3],"qwen/qwen3-30b-a3b-fp8":[0.09,0.45,0.09],"qwen/qwen3-32b-fp8":[0.1,0.45,0.1],"qwen/qwen3-coder-480b-a35b-instruct":[0.38,1.55,0.38],"qwen/qwen3-coder-next":[0.2,1.5,0.2],"qwen/qwen3-next-80b-a3b-instruct":[0.15,1.5,0.15],"qwen/qwen3-next-80b-a3b-thinking":[0.15,1.5,0.15],"xiaomimimo/mimo-v2-flash":[0.1,0.3,0.02],"zai-org/glm-4.5":[0.6,2.2,0.6],"zai-org/glm-4.5v":[0.6,1.8,0.6],"zai-org/glm-4.7":[0.6,2.2,0.6],"zai-org/glm-4.7-flash":[0.07,0.4,0.01]},"kenari":{"claude-fable-5":[12.0,57.14285714,1.2],"claude-opus-4-7":[5.71428571,29.71428571,0.57142857],"claude-opus-4-8":[5.71428571,29.71428571,0.57142857],"claude-opus-5":[5.71428571,28.57142857,2.28571429],"claude-sonnet-4-6":[3.6,17.71428571,0.36],"claude-sonnet-5":[1.42857143,7.14285714,0.57142857],"deepseek-v4-1-flash":[0.15714286,0.31428571,0.00371429],"deepseek-v4-flash":[0.15714286,0.31428571,0.00371429],"deepseek-v4-flash:free":[0.0,0.0],"deepseek-v4-pro":[0.57142857,1.14285714,0.00571429],"gemini-3-1-flash-lite":[0.28571429,1.71428571,0.02857143],"gemini-3-1-pro":[1.2,7.14285714,0.12],"gemini-3-6-flash":[0.34285714,1.71428571,0.03428571],"gemini-3-7-flash":[0.34285714,1.71428571,0.03428571],"gemma-4-31b-it":[0.10285714,0.40571429,0.04114286],"glm-4-7-flash:free":[0.0,0.0],"glm-5-2":[0.28571429,3.42857143,0.05314286],"glm-5-3":[0.28571429,3.42857143,0.05314286],"glm-5-3-flash":[0.11428571,0.34285714,0.02285714],"gpt-5-4-mini":[0.85714286,5.37142857,0.85714286],"gpt-5-5":[5.71428571,36.0,0.57142857],"gpt-5-6-luna":[0.2,1.14285714,0.02],"gpt-5-6-sol":[2.97142857,17.71428571,1.18857143],"gpt-5-6-terra":[2.4,14.28571429,2.4],"gpt-oss-120b":[0.036,0.2,0.0036],"gpt-oss-20b":[0.036,0.15428571,0.00371429],"grok-4-5":[2.28571429,6.85714286,0.34285714],"grok-4-6":[2.28571429,6.85714286,0.34285714],"hy3":[0.15428571,0.62857143,0.01542857],"hy3:free":[0.0,0.0],"kimi-k2-6":[0.57142857,2.85714286,0.28571429],"kimi-k2-6:free":[0.0,0.0],"kimi-k2-7-code":[0.57142857,2.85714286,0.11428571],"kimi-k2-7-code:free":[0.0,0.0],"kimi-k3":[0.85714286,8.57142857,0.11428571],"mimo-v2-5":[0.16571429,0.33142857,0.16571429],"mimo-v2-5-pro":[0.52,1.02857143,0.52],"mimo-v2-5:free":[0.0,0.0],"minimax-m2-7":[0.36,1.42857143,0.06857143],"minimax-m2-7-highspeed":[0.59428571,2.4,0.11428571],"minimax-m3":[0.36,1.42857143,0.06857143],"mistral-large:free":[0.0,0.0],"mistral-medium-3-5:free":[0.0,0.0],"nemotron-3-super-120b-a12b":[0.09714286,0.48,0.00971429],"nemotron-3-super-120b-a12b:free":[0.0,0.0],"nemotron-3-ultra-550b-a55b":[0.68571429,4.28571429,0.06857143],"qwen3-7-plus":[0.38285714,1.48571429,0.07428571],"qwen3-8-max":[2.4,6.85714286,0.29714286],"step-3-7-flash":[0.24,1.37142857,0.048],"step-3-7-flash:free":[0.0,0.0]},"kilo":{"aion-labs/aion-2.0":[0.8,1.6,0.2],"aion-labs/aion-3.0":[3.0,6.0,0.75],"aion-labs/aion-3.0-mini":[0.7,1.4,0.18],"aion-labs/aion-3.5":[3.0,6.0,0.75],"aion-labs/aion-3.5-mini":[0.7,1.4,0.18],"aion-labs/aion-rp-llama-3.1-8b":[0.8,1.6,0.8],"amazon/nova-2-lite-v1":[0.3,2.5,0.3],"amazon/nova-lite-v1":[0.06,0.24,0.06],"amazon/nova-micro-v1":[0.035,0.14,0.035],"amazon/nova-premier-v1":[2.5,12.5,0.625],"amazon/nova-pro-v1":[0.8,3.2,0.8],"anthracite-org/magnum-v4-72b":[2.5,5.0,2.5],"anthropic/claude-fable-5":[10.0,50.0,1.0],"anthropic/claude-fable-5.1":[10.0,50.0,0.25],"anthropic/claude-haiku-4.5":[1.0,5.0,0.1],"anthropic/claude-haiku-5.5":[0.1,0.5,0.01],"anthropic/claude-opus-4.1":[15.0,75.0,1.5],"anthropic/claude-opus-4.5":[5.0,25.0,0.5],"anthropic/claude-opus-4.6":[5.0,25.0,0.5],"anthropic/claude-opus-4.7":[5.0,25.0,0.5],"anthropic/claude-opus-4.8":[5.0,25.0,0.5],"anthropic/claude-opus-5":[5.0,25.0,0.5],"anthropic/claude-opus-5.5":[4.0,20.0,0.2],"anthropic/claude-sonnet-4.5":[3.0,15.0,0.3],"anthropic/claude-sonnet-4.6":[3.0,15.0,0.3],"anthropic/claude-sonnet-5":[2.0,10.0,0.2],"anthropic/claude-sonnet-5.5":[2.0,10.0,0.1],"bytedance-seed/seed-1.6":[0.25,2.0,0.25],"bytedance-seed/seed-1.6-flash":[0.075,0.3,0.075],"bytedance-seed/seed-2-1-turbo":[0.5,2.5,0.5],"bytedance-seed/seed-2.0-code":[0.5,3.0,0.5],"bytedance-seed/seed-2.0-lite":[0.25,2.0,0.25],"bytedance-seed/seed-2.0-mini":[0.1,0.4,0.1],"bytedance/ui-tars-1.5-7b":[0.1,0.2,0.1],"cognitivecomputations/dolphin-mistral-24b-venice-edition":[0.2,0.9,0.2],"cohere/command-a":[2.5,10.0,2.5],"cohere/command-a-plus":[0.3,1.5,0.15],"cohere/command-r-08-2024":[0.15,0.6,0.15],"cohere/command-r-plus-08-2024":[2.5,10.0,2.5],"cohere/command-r7b-12-2024":[0.0375,0.15,0.0375],"cohere/north-mini-code:free":[0.0,0.0],"deepseek/deepseek-chat":[0.2574,1.0287,0.2574],"deepseek/deepseek-chat-v3-0324":[0.29,1.14,0.11],"deepseek/deepseek-chat-v3.1":[0.25,0.95,0.13],"deepseek/deepseek-r1-0528":[0.5,2.15,0.35],"deepseek/deepseek-v3.1-terminus":[0.27,1.0,0.27],"deepseek/deepseek-v3.2":[0.28,0.42,0.028],"deepseek/deepseek-v3.2-exp":[0.27,0.41,0.27],"deepseek/deepseek-v4-flash":[0.091,0.182,0.0182],"deepseek/deepseek-v4-flash-0731":[0.44,1.32,0.028],"deepseek/deepseek-v4-flash-vision-exp":[0.2156,0.6468,0.00686],"deepseek/deepseek-v4-pro":[1.6,3.2,0.135],"deepseek/deepseek-v4-pro-0813":[1.32,3.96,0.044],"deepseek/deepseek-v4.1-flash":[0.3,1.2,0.006],"deepseek/deepseek-v4.1-flash-1017":[0.3,1.2,0.006],"dots-studio/dots-3-note-preview:free":[0.0,0.0],"elorian/glimpse":[0.6,3.0,0.06],"fireworks/ember-1":[3.0,15.0,0.3],"google/gemini-2.5-flash":[0.15,1.25,0.015],"google/gemini-2.5-flash-image":[0.3,2.5,0.03],"google/gemini-2.5-flash-lite":[0.05,0.2,0.005],"google/gemini-2.5-pro":[0.625,5.0,0.0625],"google/gemini-2.5-pro-preview":[0.625,5.0,0.0625],"google/gemini-3-flash-preview":[0.25,1.5,0.025],"google/gemini-3-pro-image":[2.0,12.0,0.2],"google/gemini-3-pro-image-preview":[1.0,6.0,0.1],"google/gemini-3.1-flash-image":[0.5,3.0,0.5],"google/gemini-3.1-flash-image-preview":[0.5,3.0,0.5],"google/gemini-3.1-flash-lite":[0.125,0.75,0.0125],"google/gemini-3.1-flash-lite-image":[0.25,1.5,0.25],"google/gemini-3.1-flash-lite-preview":[0.125,0.75,0.0125],"google/gemini-3.1-pro-preview":[1.0,6.0,0.1],"google/gemini-3.1-pro-preview-customtools":[2.0,12.0,0.2],"google/gemini-3.5-flash":[0.75,4.5,0.075],"google/gemini-3.5-flash-lite":[0.15,1.25,0.015],"google/gemini-3.6-flash":[0.375,1.875,0.0375],"google/gemini-3.7-flash":[0.75,3.75,0.075],"google/gemini-3.8-flash":[0.75,3.75,0.075],"google/gemini-4-argon":[2.0,10.0,0.1],"google/gemini-nano-banana-2.1":[1.5,7.5,1.5],"google/gemma-2-27b-it":[0.65,0.65,0.65],"google/gemma-3-12b-it":[0.04,0.12,0.04],"google/gemma-3-27b-it":[0.08,0.16,0.08],"google/gemma-3-4b-it":[0.04,0.05,0.02],"google/gemma-4-26b-a4b-it":[0.042,0.22,0.021],"google/gemma-4-31b-it":[0.1,0.34,0.1],"google/lyria-3-clip-preview":[0.0,0.0],"google/lyria-3-pro-preview":[0.0,0.0],"gryphe/mythomax-l2-13b":[0.08,0.11,0.08],"ibm-granite/granite-4.2-8b":[0.06,0.15,0.015],"inception/mercury-2":[0.25,0.75,0.025],"inception/mercury-2.5":[0.2,0.75,0.02],"inception/mercury-3":[0.2,0.7,0.02],"inclusionai/ling-3.0-flash":[0.06,0.18,0.012],"inclusionai/ling-3.0-flash-vl":[0.06,0.18,0.012],"inclusionai/ling-3.1-flash":[0.3,0.9,0.06],"inference-net/schematron-v2-small":[0.05,0.23,0.05],"inference-net/schematron-v2-turbo":[0.03,0.15,0.03],"kilo-auto/balanced":[0.325,1.95,0.0325],"kilo-auto/efficient":[0.325,1.95,0.0325],"kilo-auto/free":[0.0,0.0],"kilo-auto/frontier":[5.0,25.0,0.5],"kilo-auto/small":[0.05,0.4,0.005],"liquid/lfm-2.5-2.6b":[0.35,0.5,0.04],"liquid/lfm-2.5-2.6b:free":[0.0,0.0],"liquid/lfm-2.5-24b-a2b":[0.05,0.7,0.025],"mancer/weaver":[0.4,0.75,0.4],"meituan/longcat-2.0":[0.75,3.0,0.015],"meta-llama/llama-3.1-70b-instruct":[0.4,0.4,0.4],"meta-llama/llama-3.1-8b-instruct":[0.02,0.04,0.02],"meta-llama/llama-3.2-1b-instruct":[0.027,0.201,0.027],"meta-llama/llama-3.2-3b-instruct":[0.05,0.33,0.05],"meta-llama/llama-3.3-70b-instruct":[0.1,0.32,0.1],"meta-llama/llama-4-maverick":[0.1875,0.6525,0.05],"meta-llama/llama-4-scout":[0.08,0.24,0.08],"meta-llama/llama-guard-4-12b":[0.144,0.144,0.144],"meta/muse-glimmer-30b":[0.3,1.2,0.04],"meta/muse-spark-1.1":[1.25,4.25,0.15],"meta/muse-spark-1.2":[1.25,4.25,0.15],"meta/muse-spark-1.2-contributor":[0.1,0.2,0.002],"meta/muse-spark-1.3":[1.25,4.25,0.15],"meta/muse-spark-1.3-contributor":[0.1,0.2,0.002],"meta/muse-spark-open":[1.25,4.25,0.15],"meta/muse-wonder":[4.0,20.0,0.2],"microsoft/phi-4":[0.056,0.112,0.056],"minimax/minimax-01":[0.2,1.1,0.2],"minimax/minimax-m1":[0.55,2.2,0.55],"minimax/minimax-m2":[0.255,1.02,0.255],"minimax/minimax-m2-her":[0.3,1.2,0.03],"minimax/minimax-m2.1":[0.3,1.2,0.03],"minimax/minimax-m2.5":[0.3,1.2,0.03],"minimax/minimax-m2.7":[0.3,1.2,0.06],"minimax/minimax-m3":[0.3,1.2,0.06],"minimax/minimax-m3.1-flash":[0.15,0.6,0.015],"mistralai/codestral-2508":[0.3,0.9,0.03],"mistralai/devstral-2512":[0.4,2.0,0.04],"mistralai/ministral-14b-2512":[0.2,0.2,0.02],"mistralai/ministral-3b-2512":[0.1,0.1,0.01],"mistralai/ministral-8b-2512":[0.15,0.15,0.015],"mistralai/mistral-large":[2.0,6.0,0.2],"mistralai/mistral-large-2407":[2.0,6.0,0.2],"mistralai/mistral-large-2512":[0.5,1.5,0.05],"mistralai/mistral-large-4-0":[1.36,4.18,0.14],"mistralai/mistral-medium-3":[0.4,2.0,0.04],"mistralai/mistral-medium-3-5":[1.5,7.5,1.5],"mistralai/mistral-medium-3.1":[0.4,2.0,0.04],"mistralai/mistral-nemo":[0.15,0.15,0.015],"mistralai/mistral-saba":[0.2,0.6,0.02],"mistralai/mistral-small-24b-instruct-2501":[0.05,0.08,0.05],"mistralai/mistral-small-2603":[0.15,0.6,0.015],"mistralai/mistral-small-3.1-24b-instruct":[0.351,0.555,0.351],"mistralai/mistral-small-3.2-24b-instruct":[0.1,0.3,0.01],"mistralai/mixtral-8x22b-instruct":[2.0,6.0,0.2],"mistralai/voxtral-small-24b-2507":[0.1,0.3,0.01],"moondream/moondream3-preview":[0.3,2.5,0.3],"moondream/moondream3.1-9b-a2b":[0.3,2.5,0.3],"moonshotai/kimi-k2":[0.57,2.3,0.57],"moonshotai/kimi-k2-0905":[0.6,2.5,0.6],"moonshotai/kimi-k2-thinking":[0.6,2.5,0.15],"moonshotai/kimi-k2.5":[0.6,3.0,0.6],"moonshotai/kimi-k2.6":[0.65,3.41,0.15],"moonshotai/kimi-k2.7-code":[0.56,3.1,0.15],"moonshotai/kimi-k3":[3.0,15.0,0.3],"moonshotai/kimi-k3.1-pro":[2.0,10.0,0.2],"morph/morph-v3-fast":[0.8,1.2,0.8],"morph/morph-v3-large":[0.9,1.9,0.9],"nex-agi/nex-n2.5-mini":[0.025,0.1,0.0025],"nex-agi/nex-n2.5-pro":[0.075,0.25,0.015],"nousresearch/hermes-3-llama-3.1-405b":[1.0,1.0,1.0],"nousresearch/hermes-3-llama-3.1-70b":[0.7,0.7,0.7],"nousresearch/hermes-4-405b":[1.0,3.0,0.2],"nvidia/nemotron-3-nano-30b-a3b":[0.05,0.2,0.05],"nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free":[0.0,0.0],"nvidia/nemotron-3-super-120b-a12b":[0.08,0.45,0.08],"nvidia/nemotron-3-ultra-550b-a55b":[0.4,1.76,0.08],"nvidia/nemotron-3-ultra-550b-a55b:free":[0.0,0.0],"nvidia/nemotron-3.5-content-safety":[0.2,0.2,0.2],"nvidia/nemotron-3.5-content-safety:free":[0.0,0.0],"nvidia/nemotron-3.5-lightning":[0.025,0.12,0.0125],"nvidia/nemotron-3.5-lightning:free":[0.0,0.0],"nvidia/nemotron-3.5-super-vl":[0.06,0.35,0.01],"nvidia/nemotron-3.5-super-vl:free":[0.0,0.0],"openai/gpt-3.5-turbo-0613":[1.0,2.0,1.0],"openai/gpt-3.5-turbo-16k":[3.0,4.0,3.0],"openai/gpt-4":[30.0,60.0,30.0],"openai/gpt-4.1":[2.0,8.0,0.5],"openai/gpt-4.1-mini":[0.4,1.6,0.1],"openai/gpt-4.1-nano":[0.1,0.4,0.03],"openai/gpt-4o":[2.5,10.0,1.25],"openai/gpt-4o-2024-05-13":[5.0,15.0,5.0],"openai/gpt-4o-2024-08-06":[2.5,10.0,1.25],"openai/gpt-4o-2024-11-20":[2.5,10.0,1.25],"openai/gpt-4o-mini":[0.15,0.6,0.075],"openai/gpt-4o-mini-2024-07-18":[0.15,0.6,0.075],"openai/gpt-5":[1.25,10.0,0.125],"openai/gpt-5-image":[10.0,10.0,1.25],"openai/gpt-5-image-mini":[2.5,2.0,0.25],"openai/gpt-5-mini":[0.25,2.0,0.025],"openai/gpt-5-nano":[0.05,0.4,0.005],"openai/gpt-5-pro":[15.0,120.0,15.0],"openai/gpt-5.1":[1.25,10.0,0.125],"openai/gpt-5.1-codex":[1.25,10.0,0.13],"openai/gpt-5.1-codex-max":[1.25,10.0,0.125],"openai/gpt-5.1-codex-mini":[0.25,2.0,0.03],"openai/gpt-5.2":[1.75,14.0,0.175],"openai/gpt-5.2-codex":[1.75,14.0,0.175],"openai/gpt-5.2-pro":[21.0,168.0,21.0],"openai/gpt-5.3-codex":[1.75,14.0,0.175],"openai/gpt-5.4":[2.5,15.0,0.25],"openai/gpt-5.4-image-2":[8.0,15.0,2.0],"openai/gpt-5.4-mini":[0.75,4.5,0.075],"openai/gpt-5.4-nano":[0.2,1.25,0.02],"openai/gpt-5.4-pro":[30.0,180.0,30.0],"openai/gpt-5.5":[5.0,30.0,0.5],"openai/gpt-5.5-pro":[30.0,180.0,30.0],"openai/gpt-5.6-luna":[0.2,1.2,0.02],"openai/gpt-5.6-luna-pro":[0.2,1.2,0.02],"openai/gpt-5.6-sol":[4.0,20.0,0.4],"openai/gpt-5.6-sol-pro":[4.0,20.0,0.4],"openai/gpt-5.6-terra":[2.0,12.0,0.2],"openai/gpt-5.6-terra-pro":[2.0,12.0,0.2],"openai/gpt-6-astra":[10.0,50.0,1.0],"openai/gpt-6-astra-pro":[10.0,50.0,1.0],"openai/gpt-6-luna":[0.1,0.5,0.01],"openai/gpt-6-luna-pro":[0.1,0.5,0.01],"openai/gpt-6-sol":[2.0,10.0,0.2],"openai/gpt-6-sol-pro":[2.0,10.0,0.2],"openai/gpt-6.1-sol":[2.0,10.0,0.1],"openai/gpt-6.1-sol-pro":[2.0,10.0,0.1],"openai/gpt-6.1-terra":[1.0,5.0,0.05],"openai/gpt-6.1-terra-pro":[1.0,5.0,0.05],"openai/gpt-audio":[2.5,10.0,2.5],"openai/gpt-audio-mini":[0.6,2.4,0.6],"openai/gpt-chat-latest":[5.0,30.0,0.5],"openai/gpt-oss-120b":[0.03,0.15,0.015],"openai/gpt-oss-20b":[0.018,0.09,0.009],"openai/gpt-oss-safeguard-20b":[0.075,0.3,0.0375],"openai/o3":[2.0,8.0,0.5],"openai/o3-pro":[20.0,80.0,20.0],"openrouter/auto":[0.0,0.0],"openrouter/bodybuilder":[0.0,0.0],"openrouter/free":[0.0,0.0],"openrouter/pareto-code":[0.0,0.0],"particle-ai/particle-1":[0.25,1.0,0.03],"perceptron/perceptron-mk1":[0.15,1.5,0.15],"perceptron/perceptron-mk1.5":[0.15,1.5,0.15],"perplexity/sonar":[1.0,1.0,1.0],"perplexity/sonar-deep-research":[2.0,8.0,2.0],"perplexity/sonar-pro":[3.0,15.0,3.0],"perplexity/sonar-pro-search":[3.0,15.0,3.0],"perplexity/sonar-reasoning-pro":[2.0,8.0,2.0],"poolside/laguna-s-2.1":[0.1,0.2,0.01],"poolside/laguna-s-2.1:free":[0.0,0.0],"poolside/laguna-xs-2.1":[0.1,0.2,0.05],"poolside/laguna-xs-2.1:free":[0.0,0.0],"prism-ml/ternary-bonsai-2-27b":[0.075,0.5,0.0375],"prism-ml/ternary-bonsai-2-9b":[0.08,0.13,0.04],"qwen/qwen-2.5-72b-instruct":[0.36,0.4,0.36],"qwen/qwen-2.5-7b-instruct":[0.1,0.2,0.1],"qwen/qwen-2.5-coder-32b-instruct":[0.66,1.0,0.66],"qwen/qwen-plus":[0.26,0.78,0.052],"qwen/qwen2.5-vl-72b-instruct":[0.8,1.0,0.4],"qwen/qwen3-14b":[0.12,0.24,0.12],"qwen/qwen3-235b-a22b-2507":[0.09,0.55,0.09],"qwen/qwen3-235b-a22b-thinking-2507":[0.45,3.5,0.45],"qwen/qwen3-30b-a3b":[0.12,0.5,0.12],"qwen/qwen3-30b-a3b-instruct-2507":[0.1,0.3,0.1],"qwen/qwen3-32b":[0.08,0.28,0.08],"qwen/qwen3-coder":[0.3,1.0,0.1],"qwen/qwen3-coder-30b-a3b-instruct":[0.07,0.28,0.07],"qwen/qwen3-coder-flash":[0.195,0.975,0.039],"qwen/qwen3-coder-next":[0.12,0.8,0.07],"qwen/qwen3-next-80b-a3b-instruct":[0.09,1.1,0.09],"qwen/qwen3-vl-235b-a22b-instruct":[0.21,1.9,0.1],"qwen/qwen3-vl-30b-a3b-instruct":[0.15,0.6,0.15],"qwen/qwen3-vl-30b-a3b-thinking":[0.29,1.0,0.29],"qwen/qwen3-vl-8b-instruct":[0.25,0.75,0.12],"qwen/qwen3.5-122b-a10b":[0.26,2.08,0.26],"qwen/qwen3.5-27b":[0.195,1.56,0.195],"qwen/qwen3.5-35b-a3b":[0.1625,1.3,0.1625],"qwen/qwen3.5-397b-a17b":[0.39,2.34,0.39],"qwen/qwen3.5-9b":[0.17,0.25,0.17],"qwen/qwen3.5-flash-02-23":[0.065,0.26,0.065],"qwen/qwen3.5-plus-02-15":[0.26,1.56,0.26],"qwen/qwen3.5-plus-20260420":[0.3,1.8,0.3],"qwen/qwen3.6-27b":[0.45,2.7,0.45],"qwen/qwen3.6-35b-a3b":[0.1,0.9,0.025],"qwen/qwen3.6-flash":[0.1875,1.125,0.1875],"qwen/qwen3.6-plus":[0.325,1.95,0.325],"qwen/qwen3.7-flash":[0.03,0.13,0.006],"qwen/qwen3.7-max":[1.475,4.425,0.295],"qwen/qwen3.7-plus":[0.32,1.28,0.064],"qwen/qwen3.8-2.4t-a95b":[2.0,6.0,0.25],"qwen/qwen3.8-27b":[0.425,2.55,0.085],"qwen/qwen3.8-flash":[0.15,0.47,0.016],"qwen/qwen3.8-max-0902":[2.0,6.0,0.25],"qwen/qwen3.8-max-prime":[4.0,12.0,0.5],"qwen/qwen3.8-omni-flash":[0.15,0.47,0.016],"recursive/flint-v1.0:free":[0.0,0.0],"reflection/beam-1.0-501b-a23b":[0.25,1.0,0.05],"reflection/beam-free":[0.0,0.0],"rekaai/reka-edge":[0.1,0.1,0.1],"rekaai/reka-flash-3":[0.1,0.2,0.1],"relace/relace-apply-3":[0.85,1.25,0.85],"relace/relace-search":[1.0,3.0,1.0],"sakana/fugu-max":[2.0,6.0,0.25],"sakana/fugu-ultra":[5.0,30.0,0.5],"sakana/fugu-ultra-v2":[5.0,30.0,0.5],"sakana/sakana-namazu":[0.95,4.0,0.15],"sao10k/l3-lunaris-8b":[0.04,0.05,0.04],"sao10k/l3.1-euryale-70b":[0.85,0.85,0.85],"scaledown/extract":[0.05,0.0,0.05],"scaledown/summarize":[0.05,0.0,0.05],"stealth/glyph-cluster":[0.0,0.0],"stepfun/step-3.5-flash":[0.1,0.3,0.1],"stepfun/step-3.7-flash":[0.2,1.15,0.04],"stepfun/step-5-preview":[1.0,2.7,0.1],"tencent/hunyuan-a13b-instruct":[0.14,0.57,0.14],"tencent/hy-mt2-1.8b":[0.044,0.177,0.044],"tencent/hy-mt2-30b-a3b":[0.074,0.295,0.074],"tencent/hy-mt2-7b":[0.074,0.295,0.074],"tencent/hy3":[0.132,0.528,0.033],"tencent/hy3-preview":[0.18,0.6,0.06],"tencent/hy4-preview":[0.834,2.501,0.042],"thedrummer/cydonia-24b-v4.1":[0.3,0.5,0.15],"thedrummer/skyfall-36b-v2":[0.55,0.8,0.25],"thedrummer/unslopnemo-12b":[0.4,0.4,0.4],"thinkingmachines/inkling":[1.0,4.05,0.17],"thinkingmachines/inkling-small":[0.45,1.2,0.1],"unbiased/pareto-26.10":[0.8,3.2,0.03],"unbiased/pareto-26.9":[2.5,7.5,0.25],"undi95/remm-slerp-l2-13b":[0.35,0.65,0.35],"upstage/solar-mini4":[0.1,0.4,0.01],"upstage/solar-pro-3":[0.15,0.6,0.015],"upstage/solar-pro4":[0.3,1.2,0.06],"writer/palmyra-x5":[0.6,6.0,0.6],"x-ai/grok-4.20":[1.25,2.5,0.2],"x-ai/grok-4.20-multi-agent":[1.25,2.5,0.2],"x-ai/grok-4.3":[1.25,2.5,0.2],"x-ai/grok-4.5":[2.0,6.0,0.3],"x-ai/grok-4.6":[2.0,6.0,0.5],"x-ai/grok-4.7":[2.0,6.0,0.5],"x-ai/grok-build-0.1":[1.0,2.0,0.2],"xiaomi/mimo-v2.5":[0.14,0.28,0.003],"xiaomi/mimo-v2.5-pro":[0.435,0.87,0.004],"xiaomi/mimo-v2.6-flash":[0.1,0.28,0.003],"xiaomi/mimo-v2.6-pro":[0.435,0.87,0.004],"xiaomi/mimo-v2.6-pro-ultraspeed":[4.35,8.7,0.036],"xingchen-agi/xing4.0-29b-a4b:free":[0.0,0.0],"z-ai/glm-4.5":[0.6,2.2,0.11],"z-ai/glm-4.5-air":[0.13,0.85,0.025],"z-ai/glm-4.5v":[0.6,1.8,0.11],"z-ai/glm-4.6":[0.5,2.0,0.1],"z-ai/glm-4.6v":[0.3,0.9,0.05],"z-ai/glm-4.7":[0.54,1.98,0.099],"z-ai/glm-4.7-flash":[0.0605,0.4,0.0605],"z-ai/glm-5":[1.0,3.2,0.2],"z-ai/glm-5-turbo":[1.2,4.0,0.24],"z-ai/glm-5.1":[1.4,4.4,0.26],"z-ai/glm-5.2":[1.4,4.4,0.26],"z-ai/glm-5.3":[1.4,4.4,0.26],"z-ai/glm-5.3-flash":[0.15,0.5,0.03],"z-ai/glm-5.3-flashx":[0.37,1.25,0.09],"z-ai/glm-5.3-prime":[2.8,8.8,0.56],"z-ai/glm-5v-turbo":[1.2,4.0,0.24],"~anthropic/claude-fable-latest":[10.0,50.0,0.25],"~anthropic/claude-haiku-latest":[0.1,0.5,0.01],"~anthropic/claude-opus-latest":[4.0,20.0,0.2],"~anthropic/claude-sonnet-latest":[2.0,10.0,0.1],"~deepseek/deepseek-flash-latest":[0.0233,1.8,0.0231],"~deepseek/deepseek-pro-latest":[0.1035,8.0,0.1],"~deepseek/deepseek-v4-flash-latest":[0.057,0.1341,0.028],"~google/gemini-flash-latest":[0.75,3.75,0.075],"~google/gemini-pro-latest":[2.0,10.0,0.1],"~moonshotai/kimi-latest":[0.1824,9.3388,0.18],"~openai/gpt-astra-latest":[10.0,50.0,1.0],"~openai/gpt-luna-latest":[0.1,0.5,0.01],"~openai/gpt-mini-latest":[0.75,4.5,0.075],"~openai/gpt-sol-latest":[2.0,10.0,0.1],"~openai/gpt-terra-latest":[1.0,5.0,0.05],"~unbiased/pareto-latest":[0.8,3.2,0.03],"~x-ai/grok-latest":[2.0,6.0,0.5],"~z-ai/glm-flash-latest":[0.0457,0.0742,0.03],"~z-ai/glm-latest":[0.0699,1.4,0.0689]},"kimi-code-plan-cn":{"k3":[0.0,0.0],"k3-256k":[0.0,0.0],"k3.1-pro":[0.0,0.0],"k3.1-pro-highspeed":[0.0,0.0],"kimi-for-coding":[0.0,0.0],"kimi-for-coding-highspeed":[0.0,0.0]},"kimi-code-plan-global":{"k3":[0.0,0.0],"k3-256k":[0.0,0.0],"k3.1-pro":[0.0,0.0],"k3.1-pro-highspeed":[0.0,0.0],"kimi-for-coding":[0.0,0.0],"kimi-for-coding-highspeed":[0.0,0.0]},"klokintegration":{"kloker":[0.23,1.16,0.23],"kloker-integration-architect":[0.23,1.16,0.23],"kloker-integration-developer":[0.23,1.16,0.23]},"kosmik":{"qwen/qwen3.8-27b":[0.35,2.2,0.09]},"kuae-cloud-coding-plan":{"glm-4.7":[0.0,0.0]},"lilac":{"google/gemma-4-31b-it":[0.11,0.35,0.11],"minimaxai/minimax-m3":[0.28,1.1,0.05],"moonshotai/kimi-k2.6":[0.7,3.5,0.2],"zai-org/glm-5.2":[0.9,3.0,0.27]},"llmgateway":{"auto":[0.0,0.0],"claude-fable-5":[10.0,50.0,1.0],"claude-fable-5-1":[10.0,50.0,0.25],"claude-haiku-4-5":[1.0,5.0,0.1],"claude-haiku-4-5-20251001":[1.0,5.0,0.1],"claude-haiku-5-5":[0.1,0.5,0.01],"claude-opus-4-5-20251101":[5.0,25.0,0.5],"claude-opus-4-6":[5.0,25.0,0.5],"claude-opus-4-7":[5.0,25.0,0.5],"claude-opus-4-8":[5.0,25.0,0.5],"claude-opus-5":[5.0,25.0,0.5],"claude-opus-5-5":[4.0,20.0,0.2],"claude-sonnet-4-5":[3.0,15.0,0.3],"claude-sonnet-4-5-20250929":[3.0,15.0,0.3],"claude-sonnet-4-6":[3.0,15.0,0.3],"claude-sonnet-5":[2.0,10.0,0.2],"claude-sonnet-5-5":[2.0,10.0,0.1],"codestral-2508":[0.3,0.9,0.3],"custom":[0.0,0.0],"deepseek-v3.2":[0.26,0.38,0.13],"deepseek-v4-flash":[0.076,0.153,0.014],"deepseek-v4-pro":[0.435,0.87,0.00363],"deepseek-v4.1-flash":[0.135,0.54,0.0027],"deepseek-v4.1-flash-1017":[0.15,0.6,0.003],"deepseek-v4.1-flash-cyber":[0.3,1.0,0.007],"devstral-2512":[0.4,2.0,0.4],"fugu-max":[2.0,6.0,0.25],"fugu-ultra":[5.0,30.0,0.5],"fugu-ultra-v2.0":[5.0,30.0,0.5],"gemini-3-flash-preview":[0.5,3.0,0.05],"gemini-3.1-flash-lite":[0.25,1.5,0.025],"gemini-3.1-pro-preview":[2.0,12.0,0.2],"gemini-3.5-flash":[1.5,9.0,0.15],"gemini-3.5-flash-lite":[0.3,2.5,0.03],"gemini-3.6-flash":[0.75,3.75,0.075],"gemini-3.7-flash":[0.75,3.75,0.075],"gemini-3.8-flash":[0.75,3.75,0.075],"gemini-4-argon":[4.0,20.0,0.2],"gemini-pro-latest":[2.0,12.0,0.2],"gemma-4-26b-a4b-it":[0.07,0.34,0.07],"gemma-4-31b-it":[0.1,0.25,0.01],"glm-4-32b-0414-128k":[0.1,0.1,0.1],"glm-4.5":[0.6,2.2,0.11],"glm-4.5-air":[0.2,1.1,0.03],"glm-4.5-airx":[1.1,4.5,0.22],"glm-4.5-x":[2.2,8.9,0.45],"glm-4.5v":[0.6,1.8,0.11],"glm-4.6":[0.55,2.2,0.11],"glm-4.6v":[0.3,0.9,0.05],"glm-4.6v-flashx":[0.04,0.4,0.004],"glm-4.7":[0.45,2.0,0.19],"glm-4.7-flashx":[0.07,0.4,0.01],"glm-5":[0.573,2.58,0.144],"glm-5-turbo":[1.2,4.0,0.24],"glm-5.1":[1.38,4.4,0.26],"glm-5.2":[0.605,2.123,0.154],"glm-5.2-fast":[2.156,6.776,0.429],"glm-5.3":[0.45,1.8,0.135],"glm-5.3-fast":[2.8,8.8,0.56],"glm-5.3-flash":[0.088,0.25,0.025],"glm-5v-turbo":[1.2,4.0,0.24],"gpt-4.1":[2.0,8.0,0.5],"gpt-4.1-mini":[0.4,1.6,0.1],"gpt-4o":[2.5,10.0,1.25],"gpt-4o-mini":[0.15,0.6,0.075],"gpt-4o-mini-transcribe":[1.25,5.0,1.25],"gpt-4o-transcribe":[2.5,10.0,2.5],"gpt-5":[1.25,10.0,0.125],"gpt-5-mini":[0.25,2.0,0.025],"gpt-5-nano":[0.05,0.4,0.005],"gpt-5-pro":[15.0,120.0,15.0],"gpt-5.1":[1.25,10.0,0.125],"gpt-5.1-codex":[1.25,10.0,0.125],"gpt-5.1-codex-mini":[0.25,2.0,0.025],"gpt-5.2":[1.75,14.0,0.175],"gpt-5.2-codex":[1.75,14.0,0.175],"gpt-5.2-pro":[21.0,168.0,21.0],"gpt-5.3-codex":[1.75,14.0,0.175],"gpt-5.4":[2.5,15.0,0.25],"gpt-5.4-mini":[0.75,4.5,0.075],"gpt-5.4-nano":[0.2,1.25,0.02],"gpt-5.4-pro":[30.0,180.0,30.0],"gpt-5.5":[5.0,30.0,0.5],"gpt-5.5-pro":[30.0,180.0,30.0],"gpt-5.6-luna":[0.2,1.2,0.02],"gpt-5.6-sol":[4.0,20.0,0.4],"gpt-5.6-terra":[2.0,12.0,0.2],"gpt-6-astra":[10.0,50.0,1.0],"gpt-6-luna":[0.1,0.5,0.01],"gpt-6-sol":[2.0,10.0,0.2],"gpt-6.1-sol":[2.0,10.0,0.1],"gpt-6.1-terra":[1.0,5.0,0.05],"gpt-live-transcribe":[0.0,0.0],"gpt-oss-120b":[0.032,0.14,0.032],"gpt-oss-20b":[0.04,0.19,0.01],"gpt-transcribe":[0.0,0.0],"granite-4.2-8b":[0.06,0.25,0.015],"grok-4":[3.0,15.0,0.75],"grok-4-1-fast-reasoning":[0.2,0.5,0.05],"grok-4-20-beta-0309-non-reasoning":[2.0,6.0,0.2],"grok-4-20-beta-0309-reasoning":[2.0,6.0,0.2],"grok-4-20-non-reasoning":[1.25,2.5,0.2],"grok-4-20-reasoning":[1.25,2.5,0.2],"grok-4-3":[1.25,2.5,0.2],"grok-4-5":[2.0,6.0,0.3],"grok-4-6":[2.0,6.0,0.5],"grok-4-7":[2.0,6.0,0.5],"grok-build-0-1":[1.0,2.0,0.2],"hy-mt2-plus":[0.074,0.295,0.074],"hy3":[0.132,0.528,0.033],"hy4-preview":[0.834,2.501,0.042],"kimi-k2":[0.57,2.3,0.5],"kimi-k2.5":[0.574,3.011,0.225],"kimi-k2.6":[0.6,3.05,0.13],"kimi-k2.7-code":[0.737,3.08,0.143],"kimi-k2.7-code-highspeed":[1.9,8.0,0.38],"kimi-k3":[3.0,15.0,0.3],"kimi-k3-fast":[4.5,22.5,0.45],"kimi-k3.1-pro":[2.0,10.0,0.2],"kimi-k3.1-pro-highspeed":[4.0,20.0,0.2],"ling-3.0-flash":[0.06,0.18,0.012],"ling-3.0-flash-vl":[0.06,0.18,0.012],"llama-3.1-70b-instruct":[0.72,0.72,0.72],"llama-3.2-11b-instruct":[0.07,0.33,0.07],"llama-3.3-70b-instruct":[0.135,0.4,0.135],"llama-4-maverick-17b-instruct":[0.27,0.85,0.27],"llama-4-scout-17b-instruct":[0.18,0.59,0.18],"mimo-v2.6-flash":[0.12,0.25,0.0025],"mimo-v2.6-pro":[0.435,0.87,0.0036],"minimax-m2":[0.2,1.0,0.03],"minimax-m2.1":[0.27,1.1,0.27],"minimax-m2.1-lightning":[0.12,0.48,0.12],"minimax-m2.5":[0.3,1.2,0.03],"minimax-m2.5-highspeed":[0.6,2.4,0.03],"minimax-m2.7":[0.3,1.2,0.06],"minimax-m2.7-highspeed":[0.6,2.4,0.06],"minimax-m3":[0.28,1.1,0.05],"minimax-m3.1-flash":[0.1,0.5,0.005],"minimax-text-01":[0.2,1.1,0.2],"ministral-14b-2512":[0.2,0.2,0.2],"ministral-3b-2512":[0.1,0.1,0.1],"ministral-8b-2512":[0.15,0.15,0.15],"mistral-large-2512":[0.5,1.5,0.5],"mistral-large-4":[1.36,4.18,0.14],"mistral-large-latest":[4.0,12.0,4.0],"mistral-medium-3-5":[1.5,7.5,1.5],"mistral-small-2506":[0.1,0.3,0.1],"mistral-small-2603":[0.15,0.6,0.15],"muse-glimmer-30b":[0.3,1.2,0.04],"muse-spark-1.1":[1.25,4.25,0.15],"muse-spark-1.2":[1.25,4.25,0.15],"muse-spark-1.2-contributor":[0.1,0.2,0.002],"muse-spark-1.3":[1.25,4.25,0.15],"muse-spark-1.3-contributor":[0.1,0.2,0.002],"muse-wonder-1.0":[4.0,20.0,0.2],"nemotron-3-ultra-550b":[0.5,2.2,0.1],"o3":[2.0,8.0,0.5],"qwen-flash":[0.05,0.4,0.01],"qwen-max":[1.6,6.4,1.6],"qwen-plus":[0.4,1.2,0.08],"qwen-plus-latest":[0.4,1.2,0.08],"qwen3-14b":[0.076,0.228,0.076],"qwen3-30b-a3b":[0.095,0.285,0.095],"qwen3-32b":[0.36,0.87,0.36],"qwen3-coder-flash":[0.3,1.5,0.06],"qwen3-vl-235b-a22b-instruct":[0.2,0.88,0.11],"qwen3-vl-30b-a3b-instruct":[0.15,0.6,0.15],"qwen3-vl-plus":[0.2,1.6,0.04],"qwen3.5-122b-a10b":[0.4,3.2,0.4],"qwen3.5-27b":[0.3,2.4,0.3],"qwen3.5-35b-a3b":[0.25,2.0,0.25],"qwen3.5-9b":[0.1,0.15,0.1],"qwen3.6-27b":[0.15,1.35,0.15],"qwen3.6-35b-a3b":[0.248,1.485,0.248],"qwen3.6-flash":[0.25,1.5,0.05],"qwen3.6-plus":[0.5,3.0,0.05],"qwen3.7-flash":[0.03,0.13,0.006],"qwen3.7-max":[1.25,3.75,0.25],"qwen3.7-plus":[0.4,1.6,0.08],"qwen3.8-2.4t-a95b":[2.0,6.0,0.25],"qwen3.8-27b":[0.08,0.35,0.05],"qwen3.8-flash":[0.15,0.47,0.016],"qwen3.8-max":[1.54,4.631,0.198],"qwen3.8-omni-flash":[0.15,0.47,0.016],"qwen35-397b-a17b":[0.6,3.6,0.6],"reka-edge-2603":[0.1,0.1,0.1],"seed-1-6-250615":[0.25,2.0,0.05],"seed-1-6-250915":[0.25,2.0,0.05],"seed-1-6-flash-250715":[0.07,0.3,0.015],"seed-1-8-251228":[0.25,2.0,0.05],"seed-2-0-code-preview-260328":[0.5,3.0,0.1],"seed-2-0-lite-260428":[0.25,2.0,0.05],"seed-2-0-mini-260428":[0.1,0.4,0.02],"seed-2-0-pro-260328":[0.5,3.0,0.1],"sonar":[0.25,2.5,0.25],"step-3.7-flash":[0.2,1.15,0.04]},"llmgateway-providers":{"alibaba/deepseek-v4-flash":[0.2,0.4,0.04],"alibaba/deepseek-v4-pro":[2.4,4.8,0.2],"alibaba/deepseek-v4.1-flash":[0.3,1.2,0.03],"alibaba/deepseek-v4.1-flash-1017":[0.3,1.2,0.03],"alibaba/glm-5":[0.573,2.58,0.573],"alibaba/glm-5.2":[1.4,4.4,0.28],"alibaba/glm-5.3":[1.4,4.4,0.28],"alibaba/kimi-k2.5":[0.574,3.011,0.574],"alibaba/kimi-k3":[3.0,15.0,0.3],"alibaba/qwen-flash":[0.05,0.4,0.01],"alibaba/qwen-max":[1.6,6.4,1.6],"alibaba/qwen-plus":[0.4,1.2,0.08],"alibaba/qwen-plus-latest":[0.4,1.2,0.08],"alibaba/qwen3-coder-flash":[0.3,1.5,0.06],"alibaba/qwen3-vl-plus":[0.2,1.6,0.04],"alibaba/qwen3.5-122b-a10b":[0.4,3.2,0.4],"alibaba/qwen3.5-27b":[0.3,2.4,0.3],"alibaba/qwen3.5-35b-a3b":[0.25,2.0,0.25],"alibaba/qwen3.6-35b-a3b":[0.375,2.25,0.375],"alibaba/qwen3.6-flash":[0.25,1.5,0.05],"alibaba/qwen3.6-plus":[0.5,3.0,0.05],"alibaba/qwen3.7-flash":[0.03,0.13,0.006],"alibaba/qwen3.7-max":[2.5,7.5,0.5],"alibaba/qwen3.7-plus":[0.4,1.6,0.08],"alibaba/qwen3.8-flash":[0.15,0.47,0.016],"alibaba/qwen3.8-max":[2.0,6.0,0.25],"alibaba/qwen3.8-omni-flash":[0.15,0.47,0.016],"alibaba/qwen35-397b-a17b":[0.6,3.6,0.6],"anthropic/claude-fable-5":[10.0,50.0,1.0],"anthropic/claude-fable-5-1":[10.0,50.0,0.25],"anthropic/claude-haiku-4-5":[1.0,5.0,0.1],"anthropic/claude-haiku-4-5-20251001":[1.0,5.0,0.1],"anthropic/claude-haiku-5-5":[0.1,0.5,0.01],"anthropic/claude-opus-4-5-20251101":[5.0,25.0,0.5],"anthropic/claude-opus-4-6":[5.0,25.0,0.5],"anthropic/claude-opus-4-7":[5.0,25.0,0.5],"anthropic/claude-opus-4-8":[5.0,25.0,0.5],"anthropic/claude-opus-5":[5.0,25.0,0.5],"anthropic/claude-opus-5-5":[4.0,20.0,0.2],"anthropic/claude-sonnet-4-5":[3.0,15.0,0.3],"anthropic/claude-sonnet-4-5-20250929":[3.0,15.0,0.3],"anthropic/claude-sonnet-4-6":[3.0,15.0,0.3],"anthropic/claude-sonnet-5":[2.0,10.0,0.2],"anthropic/claude-sonnet-5-5":[2.0,10.0,0.1],"aws-bedrock/claude-fable-5":[10.0,50.0,1.0],"aws-bedrock/claude-fable-5-1":[10.0,50.0,0.25],"aws-bedrock/claude-haiku-4-5":[1.0,5.0,0.1],"aws-bedrock/claude-haiku-4-5-20251001":[1.0,5.0,0.1],"aws-bedrock/claude-haiku-5-5":[0.1,0.5,0.01],"aws-bedrock/claude-opus-4-5-20251101":[5.0,25.0,0.5],"aws-bedrock/claude-opus-4-6":[5.0,25.0,0.5],"aws-bedrock/claude-opus-4-7":[5.0,25.0,0.5],"aws-bedrock/claude-opus-4-8":[5.0,25.0,0.5],"aws-bedrock/claude-opus-5":[5.0,25.0,0.5],"aws-bedrock/claude-opus-5-5":[4.0,20.0,0.2],"aws-bedrock/claude-sonnet-4-5":[3.0,15.0,0.3],"aws-bedrock/claude-sonnet-4-5-20250929":[3.0,15.0,0.3],"aws-bedrock/claude-sonnet-4-6":[3.0,15.0,0.3],"aws-bedrock/claude-sonnet-5":[2.0,10.0,0.2],"aws-bedrock/claude-sonnet-5-5":[2.0,10.0,0.1],"aws-bedrock/grok-4-3":[1.25,2.5,0.2],"aws-bedrock/grok-4-6":[2.0,6.0,0.5],"aws-bedrock/grok-4-7":[2.0,6.0,0.5],"aws-bedrock/kimi-k3":[3.0,15.0,0.3],"aws-bedrock/llama-3.1-70b-instruct":[0.72,0.72,0.72],"aws-bedrock/llama-4-maverick-17b-instruct":[0.24,0.97,0.24],"aws-bedrock/llama-4-scout-17b-instruct":[0.17,0.66,0.17],"aws-mantle/gpt-5.6-luna":[0.22,1.32,0.022],"aws-mantle/gpt-5.6-sol":[4.4,22.0,0.44],"aws-mantle/gpt-5.6-terra":[2.2,13.2,0.22],"aws-mantle/gpt-6-astra":[10.0,50.0,1.0],"azure-ai-foundry/grok-4-1-fast-reasoning":[0.2,0.5,0.2],"azure-ai-foundry/grok-4-3":[1.25,2.5,0.2],"azure-anthropic/claude-fable-5":[10.0,50.0,1.0],"azure-anthropic/claude-fable-5-1":[10.0,50.0,0.25],"azure-anthropic/claude-opus-4-6":[5.0,25.0,0.5],"azure-anthropic/claude-opus-4-7":[5.0,25.0,0.5],"azure-anthropic/claude-opus-4-8":[5.0,25.0,0.5],"azure-anthropic/claude-opus-5":[5.0,25.0,0.5],"azure-anthropic/claude-opus-5-5":[4.0,20.0,0.2],"azure-anthropic/claude-sonnet-5":[2.0,10.0,0.2],"azure-anthropic/claude-sonnet-5-5":[2.0,10.0,0.1],"azure/gpt-4.1":[2.0,8.0,0.5],"azure/gpt-4.1-mini":[0.4,1.6,0.1],"azure/gpt-4o":[2.5,10.0,1.25],"azure/gpt-5":[1.25,10.0,0.125],"azure/gpt-5-mini":[0.25,2.0,0.025],"azure/gpt-5-nano":[0.05,0.4,0.005],"azure/gpt-5.1":[1.25,10.0,0.125],"azure/gpt-5.1-codex":[1.25,10.0,1.25],"azure/gpt-5.1-codex-mini":[0.25,2.0,0.025],"azure/gpt-5.2":[1.75,14.0,0.175],"azure/gpt-5.2-codex":[1.75,14.0,0.175],"azure/gpt-5.3-codex":[1.75,14.0,0.175],"azure/gpt-5.4":[2.5,15.0,0.25],"azure/gpt-5.4-mini":[0.75,4.5,0.075],"azure/gpt-5.4-nano":[0.2,1.25,0.02],"azure/gpt-5.4-pro":[30.0,180.0,30.0],"azure/gpt-5.5":[5.0,30.0,0.5],"azure/gpt-5.6-luna":[0.2,1.2,0.02],"azure/gpt-5.6-sol":[4.0,20.0,0.4],"azure/gpt-5.6-terra":[2.0,12.0,0.2],"azure/gpt-6-astra":[10.0,50.0,1.0],"azure/gpt-6-luna":[0.1,0.5,0.01],"azure/gpt-6-sol":[2.0,10.0,0.2],"azure/gpt-6.1-sol":[2.0,10.0,0.1],"azure/gpt-oss-120b":[0.15,0.6,0.15],"baidu/deepseek-v4-flash":[0.44,1.32,0.014],"baidu/deepseek-v4-pro":[1.32,3.96,0.042],"baidu/deepseek-v4.1-flash":[0.3,1.2,0.006],"baidu/deepseek-v4.1-flash-1017":[0.28,1.13,0.006],"baidu/glm-5.1":[1.4,4.4,0.26],"baidu/glm-5.2":[1.4,4.4,0.26],"baidu/glm-5.3":[1.4,4.4,0.26],"baidu/glm-5.3-flash":[0.15,0.5,0.03],"bytedance/deepseek-v3.2":[0.28,0.42,0.056],"bytedance/deepseek-v4-flash":[0.44,1.32,0.014],"bytedance/deepseek-v4-pro":[1.32,3.96,0.044],"bytedance/glm-4.7":[0.6,2.2,0.11],"bytedance/glm-5.2":[1.4,4.4,0.26],"bytedance/gpt-oss-120b":[0.1,0.5,0.02],"bytedance/seed-1-6-250615":[0.25,2.0,0.05],"bytedance/seed-1-6-250915":[0.25,2.0,0.05],"bytedance/seed-1-6-flash-250715":[0.07,0.3,0.015],"bytedance/seed-1-8-251228":[0.25,2.0,0.05],"bytedance/seed-2-0-code-preview-260328":[0.5,3.0,0.1],"bytedance/seed-2-0-lite-260428":[0.25,2.0,0.05],"bytedance/seed-2-0-mini-260428":[0.1,0.4,0.02],"bytedance/seed-2-0-pro-260328":[0.5,3.0,0.1],"canopywave/deepseek-v4-flash":[0.14,0.28,0.03],"canopywave/deepseek-v4-pro":[1.74,3.48,0.01],"canopywave/glm-5.2":[1.4,4.4,0.26],"canopywave/kimi-k2.6":[0.95,4.0,0.16],"canopywave/kimi-k3":[3.0,15.0,0.3],"cerebras/gpt-oss-120b":[0.35,0.75,0.35],"cloudflare/deepseek-v4-flash":[0.44,1.32,0.014],"cloudflare/deepseek-v4-pro":[1.32,3.96,0.044],"cloudflare/deepseek-v4.1-flash-1017":[0.3,1.2,0.006],"cloudflare/glm-5.3":[1.4,4.4,0.26],"cloudflare/glm-5.3-flash":[0.15,0.5,0.03],"consensusprotocol/deepseek-v4-flash":[0.1,0.2,0.005],"consensusprotocol/deepseek-v4.1-flash":[0.15,0.55,0.005],"consensusprotocol/gemma-4-31b-it":[0.1,0.25,0.01],"consensusprotocol/glm-5.3-flash":[0.1,0.25,0.01],"consensusprotocol/gpt-oss-20b":[0.04,0.19,0.01],"consensusprotocol/mimo-v2.6-flash":[0.12,0.25,0.0025],"consensusprotocol/minimax-m3":[0.28,1.1,0.05],"consensusprotocol/qwen3.8-27b":[0.08,0.35,0.05],"deepinfra/deepseek-v3.2":[0.26,0.38,0.13],"deepinfra/deepseek-v4-flash":[0.08,0.18,0.016],"deepinfra/deepseek-v4-pro":[1.3,2.6,0.1],"deepinfra/deepseek-v4.1-flash":[0.2,0.6,0.006],"deepinfra/deepseek-v4.1-flash-1017":[0.2,0.6,0.006],"deepinfra/gemma-4-26b-a4b-it":[0.07,0.34,0.07],"deepinfra/gemma-4-31b-it":[0.2,0.4,0.2],"deepinfra/granite-4.2-8b":[0.06,0.25,0.015],"deepinfra/ling-3.0-flash":[0.06,0.18,0.012],"deepinfra/ling-3.0-flash-vl":[0.06,0.18,0.012],"deepinfra/mimo-v2.6-flash":[0.14,0.28,0.0028],"deepinfra/mimo-v2.6-pro":[0.435,0.87,0.0036],"deepinfra/muse-glimmer-30b":[0.3,1.2,0.04],"deepinfra/nemotron-3-ultra-550b":[0.5,2.2,0.1],"deepinfra/qwen3-vl-235b-a22b-instruct":[0.2,0.88,0.11],"deepinfra/qwen3-vl-30b-a3b-instruct":[0.15,0.6,0.15],"deepinfra/qwen3.5-9b":[0.1,0.15,0.1],"deepseek/deepseek-v4-pro":[0.66,1.98,0.022],"deepseek/deepseek-v4.1-flash-1017":[0.15,0.6,0.003],"entrim/deepseek-v4.1-flash-1017":[0.2,0.8,0.005],"entrim/glm-5.3":[0.5,2.0,0.15],"entrim/glm-5.3-flash":[0.1,0.35,0.0175],"fireworks/deepseek-v4.1-flash":[0.22,0.66,0.007],"fireworks/glm-5.3":[1.4,4.4,0.26],"fireworks/glm-5.3-flash":[0.15,0.5,0.03],"fireworks/kimi-k3":[3.0,15.0,0.3],"fireworks/kimi-k3-fast":[4.5,22.5,0.45],"google-ai-studio/gemini-3-flash-preview":[0.5,3.0,0.05],"google-ai-studio/gemini-3.1-flash-lite":[0.25,1.5,0.025],"google-ai-studio/gemini-3.1-pro-preview":[2.0,12.0,0.2],"google-ai-studio/gemini-3.5-flash-lite":[0.3,2.5,0.03],"google-ai-studio/gemini-3.6-flash":[0.75,3.75,0.075],"google-ai-studio/gemini-3.8-flash":[0.75,3.75,0.075],"google-ai-studio/gemini-4-argon":[4.0,20.0,0.2],"google-ai-studio/gemini-pro-latest":[2.0,12.0,0.2],"google-vertex/gemini-3-flash-preview":[0.5,3.0,0.05],"google-vertex/gemini-3.1-flash-lite":[0.25,1.5,0.025],"google-vertex/gemini-3.1-pro-preview":[2.0,12.0,0.2],"google-vertex/gemini-3.5-flash":[1.5,9.0,0.15],"google-vertex/gemini-3.5-flash-lite":[0.3,2.5,0.03],"google-vertex/gemini-3.6-flash":[0.75,3.75,0.075],"google-vertex/gemini-3.7-flash":[0.75,3.75,0.075],"google-vertex/gemini-3.8-flash":[0.75,3.75,0.075],"google-vertex/gemini-4-argon":[4.0,20.0,0.2],"greenference/glm-5.3-flash":[0.14,0.49,0.028],"greenference/qwen3-14b":[0.076,0.228,0.076],"greenference/qwen3-30b-a3b":[0.095,0.285,0.095],"greenference/qwen3.6-27b":[0.15,1.35,0.15],"groq/gpt-oss-120b":[0.15,0.75,0.15],"groq/gpt-oss-20b":[0.1,0.5,0.1],"inference.net/deepseek-v4.1-flash-1017":[0.3,1.0,0.007],"inference.net/deepseek-v4.1-flash-cyber":[0.3,1.0,0.007],"inference.net/glm-5.3":[0.9,3.0,0.15],"inference.net/glm-5.3-flash":[0.09,0.28,0.02],"inference.net/llama-3.2-11b-instruct":[0.07,0.33,0.07],"inference.net/minimax-m3.1-flash":[0.1,0.5,0.005],"luminal/deepseek-v4.1-flash":[0.135,0.54,0.0027],"meta-contributor/muse-spark-1.2-contributor":[0.1,0.2,0.002],"meta-contributor/muse-spark-1.3-contributor":[0.1,0.2,0.002],"meta/muse-spark-1.1":[1.25,4.25,0.15],"meta/muse-spark-1.2":[1.25,4.25,0.15],"meta/muse-spark-1.3":[1.25,4.25,0.15],"meta/muse-wonder-1.0":[4.0,20.0,0.2],"minimax/minimax-m2":[0.2,1.0,0.03],"minimax/minimax-m2.1":[0.27,1.1,0.27],"minimax/minimax-m2.1-lightning":[0.12,0.48,0.12],"minimax/minimax-m2.5":[0.3,1.2,0.03],"minimax/minimax-m2.5-highspeed":[0.6,2.4,0.03],"minimax/minimax-m2.7":[0.3,1.2,0.06],"minimax/minimax-m2.7-highspeed":[0.6,2.4,0.06],"minimax/minimax-m3":[0.6,2.4,0.12],"minimax/minimax-m3.1-flash":[0.15,0.6,0.015],"minimax/minimax-text-01":[0.2,1.1,0.2],"mistral/codestral-2508":[0.3,0.9,0.3],"mistral/devstral-2512":[0.4,2.0,0.4],"mistral/glm-5.3":[1.4,4.4,0.14],"mistral/ministral-14b-2512":[0.2,0.2,0.2],"mistral/ministral-3b-2512":[0.1,0.1,0.1],"mistral/ministral-8b-2512":[0.15,0.15,0.15],"mistral/mistral-large-2512":[0.5,1.5,0.5],"mistral/mistral-large-4":[1.36,4.18,0.14],"mistral/mistral-large-latest":[4.0,12.0,4.0],"mistral/mistral-medium-3-5":[1.5,7.5,1.5],"mistral/mistral-small-2506":[0.1,0.3,0.1],"mistral/mistral-small-2603":[0.15,0.6,0.15],"moonshot/kimi-k2.5":[0.6,3.0,0.1],"moonshot/kimi-k2.6":[0.95,4.0,0.16],"moonshot/kimi-k2.7-code":[0.95,4.0,0.19],"moonshot/kimi-k2.7-code-highspeed":[1.9,8.0,0.38],"moonshot/kimi-k3":[3.0,15.0,0.3],"moonshot/kimi-k3.1-pro":[2.0,10.0,0.2],"moonshot/kimi-k3.1-pro-highspeed":[4.0,20.0,0.2],"nebius/minimax-m3.1-flash":[0.15,0.6,0.015],"novita/deepseek-v4-flash":[0.14,0.28,0.028],"novita/deepseek-v4.1-flash":[0.3,1.2,0.006],"novita/deepseek-v4.1-flash-1017":[0.3,1.2,0.006],"novita/gemma-4-26b-a4b-it":[0.13,0.4,0.13],"novita/gemma-4-31b-it":[0.14,0.4,0.14],"novita/glm-4.5v":[0.6,1.8,0.11],"novita/glm-4.6":[0.55,2.2,0.11],"novita/glm-4.6v":[0.3,0.9,0.055],"novita/glm-4.7":[0.6,2.2,0.11],"novita/glm-5":[1.0,3.2,0.2],"novita/glm-5.1":[1.38,4.4,0.26],"novita/glm-5.2":[1.4,4.4,0.26],"novita/glm-5.3":[1.4,4.4,0.26],"novita/glm-5.3-flash":[0.15,0.5,0.03],"novita/hy3":[0.14,0.58,0.035],"novita/kimi-k2":[0.57,2.3,0.57],"novita/kimi-k2.6":[0.8,3.4,0.16],"novita/kimi-k2.7-code":[0.95,4.0,0.19],"novita/kimi-k3":[3.0,15.0,0.3],"novita/ling-3.0-flash":[0.06,0.18,0.012],"novita/llama-3.3-70b-instruct":[0.135,0.4,0.135],"novita/llama-4-maverick-17b-instruct":[0.27,0.85,0.27],"novita/llama-4-scout-17b-instruct":[0.18,0.59,0.18],"novita/minimax-m2.5":[0.3,1.2,0.03],"novita/minimax-m2.7":[0.3,1.2,0.06],"novita/minimax-m3.1-flash":[0.15,0.6,0.015],"novita/qwen3-vl-30b-a3b-instruct":[0.2,0.7,0.2],"novita/qwen3.5-122b-a10b":[0.4,3.2,0.4],"novita/qwen3.6-35b-a3b":[0.248,1.485,0.248],"novita/qwen3.7-max":[1.25,3.75,0.25],"novita/qwen3.8-2.4t-a95b":[2.0,6.0,0.25],"novita/qwen3.8-27b":[0.42,3.0,0.085],"novita/qwen3.8-flash":[0.15,0.47,0.016],"novita/qwen3.8-max":[2.0,6.0,0.25],"novita/qwen35-397b-a17b":[0.6,3.6,0.6],"novita/step-3.7-flash":[0.2,1.15,0.04],"openai/gpt-4.1":[2.0,8.0,0.5],"openai/gpt-4.1-mini":[0.4,1.6,0.1],"openai/gpt-4o":[2.5,10.0,1.25],"openai/gpt-4o-mini":[0.15,0.6,0.075],"openai/gpt-4o-mini-transcribe":[1.25,5.0,1.25],"openai/gpt-4o-transcribe":[2.5,10.0,2.5],"openai/gpt-5":[1.25,10.0,0.125],"openai/gpt-5-mini":[0.25,2.0,0.025],"openai/gpt-5-nano":[0.05,0.4,0.005],"openai/gpt-5-pro":[15.0,120.0,15.0],"openai/gpt-5.1":[1.25,10.0,0.125],"openai/gpt-5.2":[1.75,14.0,0.175],"openai/gpt-5.2-pro":[21.0,168.0,21.0],"openai/gpt-5.3-codex":[1.75,14.0,0.175],"openai/gpt-5.4":[2.5,15.0,0.25],"openai/gpt-5.4-mini":[0.75,4.5,0.075],"openai/gpt-5.4-nano":[0.2,1.25,0.02],"openai/gpt-5.4-pro":[30.0,180.0,30.0],"openai/gpt-5.5":[5.0,30.0,0.5],"openai/gpt-5.5-pro":[30.0,180.0,30.0],"openai/gpt-5.6-luna":[0.2,1.2,0.02],"openai/gpt-5.6-sol":[4.0,20.0,0.4],"openai/gpt-5.6-terra":[2.0,12.0,0.2],"openai/gpt-6-astra":[10.0,50.0,1.0],"openai/gpt-6-luna":[0.1,0.5,0.01],"openai/gpt-6-sol":[2.0,10.0,0.2],"openai/gpt-6.1-sol":[2.0,10.0,0.1],"openai/gpt-6.1-terra":[1.0,5.0,0.05],"openai/gpt-live-transcribe":[0.0,0.0],"openai/gpt-transcribe":[0.0,0.0],"openai/o3":[2.0,8.0,0.5],"perplexity/sonar":[0.25,2.5,0.25],"quartz/gemini-3.1-pro-preview":[2.0,12.0,0.2],"ranoai/deepseek-v4-flash":[0.14,0.28,0.028],"reka-ai/deepseek-v4.1-flash":[0.15,0.6,0.009],"reka-ai/deepseek-v4.1-flash-1017":[0.2,0.8,0.01],"reka-ai/glm-5.3":[0.45,1.8,0.135],"reka-ai/glm-5.3-flash":[0.09,0.28,0.027],"reka-ai/reka-edge-2603":[0.1,0.1,0.1],"runpod/kimi-k3":[3.0,15.0,0.3],"runware/deepseek-v4-flash":[0.076,0.153,0.014],"runware/deepseek-v4-pro":[0.961,1.922,0.079],"runware/deepseek-v4.1-flash":[0.15,0.6,0.01],"runware/deepseek-v4.1-flash-1017":[0.15,0.6,0.01],"runware/gemma-4-31b-it":[0.102,0.297,0.012],"runware/glm-5.2":[0.8,2.55,0.16],"runware/glm-5.3":[1.2,4.0,0.2],"runware/glm-5.3-flash":[0.15,0.5,0.03],"runware/gpt-oss-120b":[0.032,0.14,0.032],"runware/kimi-k2.6":[0.6,3.05,0.13],"runware/kimi-k3":[3.0,15.0,0.3],"sakana/fugu-max":[2.0,6.0,0.25],"sakana/fugu-ultra":[5.0,30.0,0.5],"sakana/fugu-ultra-v2.0":[5.0,30.0,0.5],"sciforium/deepseek-v4.1-flash-1017":[0.15,0.6,0.003],"scx-ai-gp/deepseek-v4.1-flash":[0.15,0.6,0.01],"scx-ai-gp/glm-5.2":[0.605,2.123,0.154],"scx-ai-gp/glm-5.2-fast":[2.156,6.776,0.429],"scx-ai-gp/glm-5.3":[0.924,2.904,0.1716],"scx-ai-gp/glm-5.3-fast":[2.8,8.8,0.56],"scx-ai-gp/glm-5.3-flash":[0.088,0.25,0.025],"scx-ai-gp/kimi-k2.7-code":[0.737,3.08,0.143],"scx-ai-gp/kimi-k3":[3.135,15.675,0.319],"scx-ai-gp/qwen3.8-max":[1.54,4.631,0.198],"scx-ai/gpt-oss-120b":[0.17,0.55,0.17],"scx-ai/minimax-m2.7":[0.48,1.79,0.05],"scx-ai/qwen3-32b":[0.36,0.87,0.36],"tencent/deepseek-v4-flash":[0.14,0.28,0.0028],"tencent/deepseek-v4-pro":[0.435,0.87,0.00363],"tencent/glm-5":[1.0,3.2,0.2],"tencent/glm-5-turbo":[1.2,4.0,0.24],"tencent/glm-5.1":[1.4,4.4,0.26],"tencent/glm-5.2":[1.4,4.4,0.26],"tencent/glm-5v-turbo":[1.2,4.0,0.24],"tencent/hy-mt2-plus":[0.074,0.295,0.074],"tencent/hy3":[0.132,0.528,0.033],"tencent/hy4-preview":[0.834,2.501,0.042],"tencent/kimi-k2.6":[0.858,3.566,0.145],"tencent/kimi-k2.7-code":[0.95,4.0,0.19],"tencent/kimi-k2.7-code-highspeed":[1.9,8.0,0.38],"tencent/kimi-k3":[3.0,15.0,0.3],"tencent/minimax-m2.7":[0.3,1.2,0.06],"tencent/minimax-m3":[0.3,1.2,0.06],"together-ai/deepseek-v4-pro":[1.32,3.96,0.13],"together-ai/deepseek-v4.1-flash":[0.3,1.2,0.006],"together-ai/deepseek-v4.1-flash-1017":[0.3,1.2,0.006],"together-ai/glm-4.7":[0.45,2.0,0.45],"together-ai/glm-5.3":[1.4,4.4,0.26],"together-ai/glm-5.3-flash":[0.15,0.5,0.03],"together-ai/gpt-oss-120b":[0.15,0.6,0.15],"together-ai/kimi-k3":[3.0,15.0,0.3],"together-ai/minimax-m3":[0.3,1.2,0.06],"together-ai/minimax-m3.1-flash":[0.15,0.6,0.015],"together-ai/muse-glimmer-30b":[0.35,1.5,0.04],"together-ai/qwen3.8-2.4t-a95b":[2.0,6.0,0.25],"vertex-anthropic/claude-haiku-4-5":[1.0,5.0,0.1],"vertex-anthropic/claude-opus-4-5-20251101":[5.0,25.0,0.5],"vertex-anthropic/claude-opus-4-6":[5.0,25.0,0.5],"vertex-anthropic/claude-opus-4-7":[5.0,25.0,0.5],"vertex-anthropic/claude-sonnet-4-5":[3.0,15.0,0.3],"vertex-anthropic/claude-sonnet-4-6":[3.0,15.0,0.3],"vertex-anthropic/claude-sonnet-5":[2.0,10.0,0.2],"vertex-openai/grok-4-20-non-reasoning":[1.25,2.5,0.2],"vertex-openai/grok-4-20-reasoning":[1.25,2.5,0.2],"vertex-openai/grok-4-6":[2.0,6.0,0.5],"vertex-openai/grok-4-7":[2.0,6.0,0.5],"xai/grok-4":[3.0,15.0,0.75],"xai/grok-4-20-beta-0309-non-reasoning":[2.0,6.0,0.2],"xai/grok-4-20-beta-0309-reasoning":[2.0,6.0,0.2],"xai/grok-4-3":[1.25,2.5,0.2],"xai/grok-4-5":[2.0,6.0,0.3],"xai/grok-4-6":[2.0,6.0,0.5],"xai/grok-4-7":[2.0,6.0,0.5],"xai/grok-build-0-1":[1.0,2.0,0.2],"xiaomi/mimo-v2.6-flash":[0.14,0.28,0.0028],"xiaomi/mimo-v2.6-pro":[0.435,0.87,0.0036],"zai/glm-4-32b-0414-128k":[0.1,0.1,0.1],"zai/glm-4.5":[0.6,2.2,0.11],"zai/glm-4.5-air":[0.2,1.1,0.03],"zai/glm-4.5-airx":[1.1,4.5,0.22],"zai/glm-4.5-x":[2.2,8.9,0.45],"zai/glm-4.5v":[0.6,1.8,0.11],"zai/glm-4.6":[0.6,2.2,0.11],"zai/glm-4.6v":[0.3,0.9,0.05],"zai/glm-4.6v-flashx":[0.04,0.4,0.004],"zai/glm-4.7":[0.6,2.2,0.11],"zai/glm-4.7-flashx":[0.07,0.4,0.01],"zai/glm-5":[1.0,3.2,0.2],"zai/glm-5.1":[1.4,4.4,0.26],"zai/glm-5.2":[1.4,4.4,0.26],"zai/glm-5.3":[1.4,4.4,0.26],"zai/glm-5.3-flash":[0.15,0.5,0.03]},"llmtech":{"nvidia/qwen3.8-27b-nvfp4":[0.25,2.09,0.04]},"llmtr":{"gemma-4":[2.0,5.0,0.5],"google/gemini-2.5-flash-lite":[0.1,0.1,0.1],"magibu-11b-v8":[0.1,0.5,0.1],"medgemma-4b":[3.0,5.0,3.0],"meta/muse-spark-1.2-contributor":[0.1,0.2,0.002],"mimo/mimo-v2.5":[0.14,0.28,0.14],"mimo/mimo-v2.5-pro":[0.435,0.87,0.435],"mistral/voxtral-small-latest":[0.1,0.3,0.1],"muse-glimmer-30b-tr":[2.0,5.0,0.5],"perplexity/sonar-deep-research":[2.0,8.0,2.0],"poolside/laguna-xs-2.1":[0.0,0.0],"publicai/apertus-70b-instruct":[0.82,2.92,0.82],"publicai/apertus-8b-instruct":[0.1,0.2,0.1],"qwen/qwen-flash":[0.05,0.4,0.01],"qwen/qwen-plus":[0.4,1.2,0.08],"qwen/qwen3-coder-flash":[0.3,1.5,0.06],"qwen/qwen3-coder-plus":[1.0,5.0,1.0],"qwen/qwen3-max":[1.2,6.0,1.2],"qwen/qwen3-vl-plus":[0.2,1.6,0.04],"qwen/qwen3.5-397b-a17b":[0.6,3.6,0.6],"qwen/qwen3.5-plus":[0.4,2.4,0.4],"qwen/qwen3.6-flash":[0.25,1.5,0.25],"qwen/qwen3.6-plus":[0.5,3.0,0.5],"qwen/qwen3.7-plus":[0.4,1.6,0.08],"qwen3-6-35b":[5.0,10.0,5.0],"sakana/fugu-ultra":[5.0,30.0,0.5],"thinkingmachines/inkling":[1.87,4.68,0.374],"thinkingmachines/inkling-small":[0.58,1.44,0.116],"trendyol-asure-12b":[0.1,0.5,0.025],"upstage/solar-pro2":[0.15,0.6,0.015],"upstage/solar-pro3":[0.15,0.6,0.015],"upstage/solar-pro4":[0.15,0.6,0.03]},"lmstudio":{"openai/gpt-oss-20b":[0.0,0.0],"qwen/qwen3-30b-a3b-2507":[0.0,0.0],"qwen/qwen3-coder-30b":[0.0,0.0]},"longcat":{"longcat-2.0":[0.3,1.2,0.006],"longcat-2.5-preview":[0.3,1.2,0.006]},"lowrouter":{"auto/mistralai/codestral-2508":[0.3138,0.9413,0.0314],"auto/mistralai/ministral-14b-2512":[0.2092,0.2092,0.0209],"auto/mistralai/ministral-3b-2512":[0.1046,0.1046,0.0105],"auto/mistralai/ministral-8b-2512":[0.1569,0.1569,0.0157],"auto/mistralai/mistral-large-2512":[0.5229,1.5688,0.0523],"auto/mistralai/mistral-large-4":[1.4367,4.4156,0.1479],"auto/mistralai/mistral-medium-3.5":[1.5688,7.8442,0.1569],"auto/mistralai/mistral-small-2603":[0.1569,0.6275,0.0157],"auto/openai/gpt-4.1":[2.0,8.0,0.5],"auto/openai/gpt-4.1-mini":[0.4,1.6,0.1],"auto/openai/gpt-4o":[2.5,10.0,1.25],"auto/openai/gpt-4o-mini":[0.15,0.6,0.075],"auto/openai/gpt-5":[1.25,10.0,0.125],"auto/openai/gpt-5-mini":[0.25,2.0,0.025],"auto/openai/gpt-5-nano":[0.05,0.4,0.005],"auto/openai/gpt-5.2":[1.75,14.0,0.175],"auto/openai/gpt-5.4":[2.5,15.0,0.25],"auto/openai/gpt-5.4-mini":[0.75,4.5,0.075],"auto/openai/gpt-5.5":[5.0,30.0,0.5],"auto/openai/gpt-5.6-luna":[0.2,1.2,0.02],"auto/openai/gpt-5.6-sol":[4.0,20.0,0.4],"auto/openai/gpt-5.6-terra":[2.0,12.0,0.2],"auto/openai/gpt-6-astra":[10.0,50.0,1.0],"auto/openai/gpt-6-luna":[0.1,0.5,0.01],"auto/openai/gpt-6-sol":[2.0,10.0,0.2],"auto/openai/gpt-6.1-sol":[2.0,10.0,0.1],"auto/openai/gpt-6.1-terra":[1.0,5.0,0.05],"auto/openai/gpt-oss-120b":[0.1695,0.6779,0.1695],"auto/openai/gpt-oss-20b":[0.113,0.4745,0.113],"auto/openai/gpt-oss-safeguard-120b":[0.18,0.73,0.18],"auto/openai/gpt-oss-safeguard-20b":[0.08,0.24,0.08],"auto/openai/o3":[2.0,8.0,0.5]},"lucidquery":{"lucidnova-rf1-100b":[2.0,5.0,2.0],"lucidquery-agi-01-frontier":[5.04675,24.673,5.04675],"lucidquery-agi-01-swift":[2.80375,16.8225,2.80375],"lucidquery-nexus-coder":[2.0,5.0,2.0]},"lynkr":{"lynkr-auto":[0.0,0.0]},"meganova":{"deepseek-ai/deepseek-r1-0528":[0.5,2.15,0.4],"deepseek-ai/deepseek-v3-0324":[0.275,1.1,0.275],"deepseek-ai/deepseek-v3.1":[0.19,0.79,0.19],"deepseek-ai/deepseek-v3.2":[0.26,0.38,0.13],"deepseek-ai/deepseek-v3.2-exp":[0.26,0.38,0.13],"meta-llama/llama-3.3-70b-instruct":[0.1,0.3,0.1],"minimaxai/minimax-m2.1":[0.28,1.2,0.28],"minimaxai/minimax-m2.5":[0.3,1.2,0.15],"mistralai/mistral-nemo-instruct-2407":[0.02,0.04,0.02],"mistralai/mistral-small-3.2-24b-instruct-2506":[0.0,0.0],"moonshotai/kimi-k2-thinking":[0.6,2.6,0.6],"moonshotai/kimi-k2.5":[0.45,2.25,0.07],"qwen/qwen2.5-vl-32b-instruct":[0.2,0.6,0.2],"qwen/qwen3-235b-a22b-instruct-2507":[0.09,0.1,0.09],"qwen/qwen3.5-plus":[0.4,2.4,0.4],"xiaomimimo/mimo-v2-flash":[0.1,0.3,0.1],"zai-org/glm-4.6":[0.45,1.9,0.45],"zai-org/glm-4.7":[0.4,1.75,0.08],"zai-org/glm-5":[0.8,2.56,0.2]},"melious":{"deepseek-v4-flash-0731":[0.1115,0.27875,0.0223],"deepseek-v4.1-flash":[0.223,1.115,0.01115],"deepseek-v4.1-flash-1017":[0.3345,1.338,0.03345],"glm-5.3":[1.115,3.345,0.223],"glm-5.3-flash":[0.1115,0.446,0.0223],"kimi-k2.6":[0.669,4.014,0.16725],"kimi-k2.7-code":[0.61325,3.28925,0.16725],"kimi-k3":[3.17775,15.88875,0.79165]},"merge-gateway":{"anthropic/claude-fable-5":[10.0,50.0,1.0],"anthropic/claude-fable-5-1":[10.0,50.0,0.25],"anthropic/claude-haiku-4-5-20251001":[1.0,5.0,0.1],"anthropic/claude-haiku-5-5":[0.1,0.5,0.01],"anthropic/claude-opus-4-1-20250805":[15.0,75.0,1.5],"anthropic/claude-opus-4-5-20251101":[5.0,25.0,0.5],"anthropic/claude-opus-4-6":[5.0,25.0,0.5],"anthropic/claude-opus-4-7":[5.0,25.0,0.5],"anthropic/claude-opus-4-8":[5.0,25.0,0.5],"anthropic/claude-opus-5":[5.0,25.0,0.5],"anthropic/claude-opus-5-5":[4.0,20.0,0.2],"anthropic/claude-sonnet-4-5-20250929":[3.0,15.0,0.3],"anthropic/claude-sonnet-4-6":[3.0,15.0,0.3],"anthropic/claude-sonnet-5":[2.0,10.0,0.2],"anthropic/claude-sonnet-5-5":[2.0,10.0,0.1],"bytedance/dola-seed-2.0-code":[0.4,2.4,0.4],"bytedance/dola-seed-2.0-code-preview":[0.5,3.0,0.5],"bytedance/dola-seed-2.0-lite":[0.31,2.5,0.31],"bytedance/dola-seed-2.0-mini":[0.12,0.5,0.12],"bytedance/dola-seed-2.0-pro":[0.63,3.79,0.63],"cohere/command-a-03-2025":[2.5,10.0,2.5],"cohere/command-r-08-2024":[0.15,0.6,0.15],"cohere/command-r-plus-08-2024":[2.5,10.0,2.5],"cohere/command-r7b-12-2024":[0.0375,0.15,0.0375],"deepseek/deepseek-r1":[1.35,5.4,1.35],"deepseek/deepseek-r1-0528":[1.35,5.4,0.945],"deepseek/deepseek-v3":[0.27,1.1,0.27],"deepseek/deepseek-v3.1":[0.56,1.68,0.13],"deepseek/deepseek-v3.2":[0.28,0.4,0.13],"deepseek/deepseek-v4-flash":[0.3,1.2,0.006],"deepseek/deepseek-v4-flash-0423":[0.139,0.278,0.139],"deepseek/deepseek-v4-flash-0731":[0.035,0.07,0.007],"deepseek/deepseek-v4-flash-0731-fast":[0.28,0.56,0.07],"deepseek/deepseek-v4-pro":[1.32,3.96,0.044],"deepseek/deepseek-v4-pro-0423":[1.65,3.3,1.65],"deepseek/deepseek-v4-pro-0813":[1.74,3.48,0.003625],"deepseek/deepseek-v4.1-flash":[0.15,0.6,0.003],"deepseek/deepseek-v4.1-flash-1017":[0.15,0.6,0.003],"google/gemini-2.5-computer-use-preview-10-2025":[1.25,10.0,1.25],"google/gemini-2.5-flash":[0.3,2.5,0.03],"google/gemini-2.5-flash-image":[0.3,2.5,0.3],"google/gemini-2.5-flash-lite":[0.1,0.4,0.01],"google/gemini-2.5-pro":[1.25,10.0,0.125],"google/gemini-3-flash-preview":[0.5,3.0,0.05],"google/gemini-3-pro-image":[2.0,12.0,2.0],"google/gemini-3.1-flash-image":[0.5,3.0,0.5],"google/gemini-3.1-flash-lite":[0.25,1.5,0.025],"google/gemini-3.1-pro-preview":[2.0,12.0,0.2],"google/gemini-3.1-pro-preview-customtools":[2.0,12.0,0.2],"google/gemini-3.5-flash":[1.5,9.0,0.15],"google/gemini-3.5-flash-lite":[0.3,2.5,0.03],"google/gemini-3.6-flash":[1.5,7.5,0.15],"google/gemini-3.7-flash":[0.75,3.75,0.075],"google/gemini-3.8-flash":[0.75,3.75,0.075],"google/gemini-4-argon":[2.0,10.0,0.1],"google/gemini-embedding-001":[0.15,0.0,0.15],"google/gemini-embedding-2":[0.2,0.0,0.2],"google/gemini-flash-latest":[1.5,9.0,0.15],"google/gemini-flash-lite-latest":[0.25,1.5,0.025],"google/gemma-3-12b-it":[0.09,0.29,0.09],"google/gemma-3-27b-it":[0.08,0.45,0.04],"google/gemma-3-4b-it":[0.04,0.08,0.04],"google/gemma-4-26b-a4b-it":[0.13,0.4,0.13],"google/gemma-4-31b-it":[0.14,0.4,0.14],"meta/llama-3.1-70b-instruct":[0.99,0.99,0.99],"meta/llama-3.1-8b-instruct":[0.22,0.22,0.22],"meta/llama-3.3-70b-instruct":[0.22,0.5,0.11],"meta/muse-spark-open":[1.25,4.25,0.15],"minimax/minimax-m2":[0.3,1.2,0.03],"minimax/minimax-m2.1":[0.3,1.2,0.03],"minimax/minimax-m2.5":[0.3,1.2,0.03],"minimax/minimax-m2.5-highspeed":[0.6,2.4,0.03],"minimax/minimax-m2.7":[0.3,1.2,0.06],"minimax/minimax-m2.7-highspeed":[0.6,2.4,0.06],"minimax/minimax-m3":[0.3,1.2,0.06],"minimax/minimax-m3.1-flash":[0.15,0.6,0.015],"mistral/codestral-latest":[0.3,0.9,0.3],"mistral/devstral-2512":[0.4,2.0,0.04],"mistral/devstral-medium-latest":[0.4,2.0,0.4],"mistral/magistral-medium-latest":[2.0,5.0,2.0],"mistral/mistral-large-2512":[0.5,1.5,0.05],"mistral/mistral-large-latest":[0.5,1.5,0.5],"mistral/mistral-medium-2505":[0.4,2.0,0.04],"mistral/mistral-medium-latest":[0.4,2.0,0.4],"mistral/mistral-small-latest":[0.15,0.6,0.15],"mistral/pixtral-large-latest":[2.0,6.0,2.0],"moonshot/kimi-k2.5":[0.6,3.0,0.1],"moonshot/kimi-k2.6":[0.95,4.0,0.16],"moonshot/kimi-k2.7-code":[0.95,4.0,0.19],"moonshot/kimi-k2.7-code-highspeed":[1.9,8.0,0.38],"moonshot/kimi-k3":[3.0,15.0,0.3],"moonshot/kimi-k3.1-pro":[2.0,10.0,0.2],"nvidia/nemotron-3-nano-30b-a3b":[0.05,0.2,0.05],"nvidia/nemotron-3.5-lightning-30b-a3b":[0.0,0.0],"nvidia/nemotron-nano-9b-v2":[0.06,0.23,0.06],"openai/gpt-3.5-turbo":[0.5,1.5,0.5],"openai/gpt-4":[30.0,60.0,30.0],"openai/gpt-4-turbo":[10.0,30.0,10.0],"openai/gpt-4.1":[2.0,8.0,0.5],"openai/gpt-4.1-mini":[0.4,1.6,0.1],"openai/gpt-4.1-nano":[0.1,0.4,0.025],"openai/gpt-4o":[2.5,10.0,1.25],"openai/gpt-4o-2024-05-13":[5.0,15.0,5.0],"openai/gpt-4o-2024-08-06":[2.5,10.0,1.25],"openai/gpt-4o-2024-11-20":[2.5,10.0,1.25],"openai/gpt-4o-mini":[0.15,0.6,0.075],"openai/gpt-5":[1.25,10.0,0.125],"openai/gpt-5-chat-latest":[1.25,10.0,0.125],"openai/gpt-5-mini":[0.25,2.0,0.025],"openai/gpt-5-nano":[0.05,0.4,0.005],"openai/gpt-5-search-api":[1.25,10.0,1.25],"openai/gpt-5.1":[1.25,10.0,0.125],"openai/gpt-5.1-chat-latest":[1.25,10.0,0.125],"openai/gpt-5.2":[1.75,14.0,0.175],"openai/gpt-5.2-chat-latest":[1.75,14.0,0.175],"openai/gpt-5.3-chat-latest":[1.75,14.0,0.175],"openai/gpt-5.4":[2.5,15.0,0.25],"openai/gpt-5.4-mini":[0.75,4.5,0.075],"openai/gpt-5.4-nano":[0.2,1.25,0.02],"openai/gpt-5.5":[5.0,30.0,0.5],"openai/gpt-5.6-luna":[0.2,1.2,0.02],"openai/gpt-5.6-sol":[5.0,30.0,0.5],"openai/gpt-5.6-terra":[2.0,12.0,0.2],"openai/gpt-6-astra":[10.0,50.0,1.0],"openai/gpt-6-luna":[0.1,0.5,0.01],"openai/gpt-6-sol":[2.0,10.0,0.2],"openai/gpt-6.1-sol":[2.0,10.0,0.1],"openai/gpt-6.1-terra":[1.0,5.0,0.05],"openai/gpt-audio":[2.5,10.0,2.5],"openai/gpt-audio-mini":[0.6,2.4,0.6],"openai/gpt-oss-120b":[0.05,0.25,0.05],"openai/gpt-oss-20b":[0.04,0.15,0.02],"openai/gpt-oss-safeguard-120b":[0.15,0.6,0.15],"openai/gpt-oss-safeguard-20b":[0.07,0.2],"openai/o1":[15.0,60.0,7.5],"openai/o3":[2.0,8.0,0.5],"openai/o3-mini":[1.1,4.4,0.55],"openai/o4-mini":[1.1,4.4,0.275],"qwen/qwen-flash":[0.022,0.216,0.0044],"qwen/qwen-plus":[0.115,0.287,0.023],"qwen/qwen3-235b-a22b":[0.287,1.147,0.0574],"qwen/qwen3-235b-a22b-instruct-2507":[0.1,0.6,0.0574],"qwen/qwen3-30b-a3b":[0.108,1.076,0.0216],"qwen/qwen3-32b":[0.15,0.6,0.15],"qwen/qwen3-coder-480b-a35b-instruct":[0.22,1.8,0.22],"qwen/qwen3-coder-flash":[0.144,0.574,0.0288],"qwen/qwen3-coder-next":[0.15,0.8,0.075],"qwen/qwen3-coder-plus":[0.574,2.294,0.1148],"qwen/qwen3-max":[0.359,1.434,0.0718],"qwen/qwen3-max-preview":[1.08,4.8,1.08],"qwen/qwen3-next-80b-a3b-instruct":[0.1,1.1,0.05],"qwen/qwen3-next-80b-a3b-thinking":[0.15,1.2,0.15],"qwen/qwen3-vl-235b-a22b-instruct":[0.21,1.9,0.105],"qwen/qwen3-vl-235b-a22b-thinking":[0.287,2.867,0.0574],"qwen/qwen3-vl-30b-a3b-instruct":[0.15,0.6,0.0216],"qwen/qwen3-vl-flash":[0.022,0.215,0.0044],"qwen/qwen3-vl-plus":[0.143,1.434,0.0286],"qwen/qwen3.5-122b-a10b":[0.115,0.917,0.023],"qwen/qwen3.5-27b":[0.086,0.688,0.0172],"qwen/qwen3.5-35b-a3b":[0.057,0.459,0.020357],"qwen/qwen3.5-397b-a17b":[0.172,1.032,0.0344],"qwen/qwen3.5-4b":[0.04,0.07,0.04],"qwen/qwen3.5-9b":[0.09,0.13,0.09],"qwen/qwen3.5-flash":[0.029,0.287,0.0029],"qwen/qwen3.5-plus":[0.115,0.688,0.0115],"qwen/qwen3.6-27b":[0.4126,2.4754,0.4126],"qwen/qwen3.6-35b-a3b":[0.248,1.485,0.0496],"qwen/qwen3.6-flash":[0.165,0.99,0.0165],"qwen/qwen3.6-max-preview":[1.31,7.88,1.31],"qwen/qwen3.6-plus":[0.276,1.651,0.0276],"qwen/qwen3.7-max":[0.825,2.4755,0.165],"qwen/qwen3.7-plus":[0.4,1.6,0.4],"qwen/qwen3.8-2.4t-a95b":[2.5,6.25,0.5],"qwen/qwen3.8-flash":[0.15,0.47,0.016],"qwen/qwen3.8-max":[2.0,6.0,0.25],"sakana/fugu-max":[2.0,6.0,0.25],"sakana/fugu-ultra":[5.0,30.0,0.5],"sakana/sakana-namazu":[0.95,4.0,0.15],"thinkingmachines/inkling":[1.0,4.05,0.17],"writer/palmyra-x4":[2.5,10.0,2.5],"writer/palmyra-x5":[0.6,6.0,0.6],"xai/grok-4.20-0309-non-reasoning":[1.25,2.5,0.2],"xai/grok-4.20-0309-reasoning":[1.25,2.5,0.2],"xai/grok-4.3":[1.25,2.5,0.2],"xai/grok-4.5":[2.0,6.0,0.5],"xai/grok-4.6":[2.0,6.0,0.5],"xai/grok-4.7":[2.0,6.0,0.5],"xai/grok-build-0.1":[1.0,2.0,0.2],"zai/glm-4.5":[0.6,2.2,0.11],"zai/glm-4.5-air":[0.2,1.1,0.03],"zai/glm-4.5v":[0.6,1.8,0.11],"zai/glm-4.6":[0.6,2.2,0.11],"zai/glm-4.7":[0.6,2.2,0.11],"zai/glm-4.7-flash":[0.07,0.4,0.07],"zai/glm-4.7-flashx":[0.07,0.4,0.01],"zai/glm-5":[1.0,3.2,0.2],"zai/glm-5-turbo":[1.2,4.0,0.24],"zai/glm-5.1":[1.4,4.4,0.26],"zai/glm-5.2":[1.05,3.3,0.195],"zai/glm-5.3":[0.7,2.2,0.13],"zai/glm-5.3-flash":[0.15,0.5,0.03]},"meta":{"muse-spark-1.1":[1.25,4.25,0.15],"muse-spark-1.2":[1.25,4.25,0.15],"muse-spark-1.2-contributor":[0.1,0.2,0.002],"muse-spark-1.3":[1.25,4.25,0.15],"muse-spark-1.3-contributor":[0.1,0.2,0.002],"muse-wonder-1.0":[4.0,20.0,0.2]},"minimax":{"minimax-m2":[0.3,1.2,0.3],"minimax-m2.1":[0.3,1.2,0.03],"minimax-m2.5":[0.3,1.2,0.03],"minimax-m2.5-highspeed":[0.6,2.4,0.03],"minimax-m2.7":[0.3,1.2,0.06],"minimax-m2.7-highspeed":[0.6,2.4,0.06],"minimax-m3":[0.3,1.2,0.06],"minimax-m3.1-flash":[0.15,0.6,0.015]},"minimax-cn":{"minimax-m2":[0.3137,1.2549,0.0314],"minimax-m2.1":[0.3137,1.2549,0.0314],"minimax-m2.5":[0.3137,1.2549,0.0314],"minimax-m2.5-highspeed":[0.6275,2.5098,0.0314],"minimax-m2.7":[0.3137,1.2549,0.0627],"minimax-m2.7-highspeed":[0.6275,2.5098,0.0627],"minimax-m3":[0.3137,1.2549,0.0627],"minimax-m3.1-flash":[0.1494,0.5976,0.0149]},"minimax-cn-coding-plan":{"minimax-m2":[0.0,0.0],"minimax-m2.1":[0.0,0.0],"minimax-m2.5":[0.0,0.0],"minimax-m2.5-highspeed":[0.0,0.0],"minimax-m2.7":[0.0,0.0],"minimax-m2.7-highspeed":[0.0,0.0],"minimax-m3":[0.0,0.0],"minimax-m3.1-flash":[0.0,0.0],"minimax-m3.1-flash-preview":[0.0,0.0]},"minimax-coding-plan":{"minimax-m2":[0.0,0.0],"minimax-m2.1":[0.0,0.0],"minimax-m2.5":[0.0,0.0],"minimax-m2.5-highspeed":[0.0,0.0],"minimax-m2.7":[0.0,0.0],"minimax-m2.7-highspeed":[0.0,0.0],"minimax-m3":[0.0,0.0],"minimax-m3.1-flash":[0.0,0.0],"minimax-m3.1-flash-preview":[0.0,0.0]},"mistral":{"codestral-2508":[0.3,0.9,0.03],"codestral-latest":[0.3,0.9,0.03],"deepseek-v4-1-flash-1017":[0.3,1.2,0.007],"devstral-2512":[0.4,2.0,0.4],"devstral-latest":[0.4,2.0,0.4],"devstral-medium-latest":[0.4,2.0,0.4],"glm-5-2":[1.4,4.4,0.14],"labs-devstral-small-2512":[0.0,0.0],"labs-leanstral-1-5-1":[0.0,0.0],"magistral-medium-latest":[2.0,5.0,2.0],"ministral-14b-2512":[0.2,0.2,0.02],"ministral-3b-2512":[0.1,0.1,0.01],"ministral-3b-latest":[0.1,0.1,0.01],"ministral-8b-2512":[0.15,0.15,0.015],"ministral-8b-latest":[0.15,0.15,0.015],"mistral-embed":[0.1,0.0,0.1],"mistral-large-2512":[0.5,1.5,0.05],"mistral-large-4":[1.36,4.18,0.14],"mistral-large-latest":[0.5,1.5,0.05],"mistral-medium-2505":[0.4,2.0,0.4],"mistral-medium-2508":[0.4,2.0,0.4],"mistral-medium-2604":[1.5,7.5,0.15],"mistral-medium-latest":[1.5,7.5,0.15],"mistral-small-2506":[0.1,0.3,0.1],"mistral-small-2603":[0.15,0.6,0.015],"mistral-small-latest":[0.15,0.6,0.015],"open-mistral-nemo":[0.15,0.15,0.15],"pixtral-12b":[0.15,0.15,0.15],"voxtral-small-2507":[0.1,0.4,0.1],"voxtral-small-latest":[0.1,0.4,0.1],"zai-glm-5-2":[1.4,4.4,0.14],"zai-glm-5-3":[1.4,4.4,0.14],"zai-glm-5-3-flash":[0.15,0.5,0.03]},"mixlayer":{"qwen/qwen3.5-122b-a10b":[0.4,3.2,0.4],"qwen/qwen3.5-27b":[0.3,2.4,0.3],"qwen/qwen3.5-35b-a3b":[0.25,1.3,0.25],"qwen/qwen3.5-397b-a17b":[0.6,3.6,0.6],"qwen/qwen3.5-9b":[0.1,0.4,0.1]},"moark":{"deepseek-v4-flash":[0.5,0.5,0.5],"deepseek-v4-flash-0731":[0.15,0.3,0.15],"deepseek-v4-pro":[1.8,3.6,1.8],"glm-4.7":[0.42,2.2,0.42],"glm-5.3":[1.2,4.18,1.2],"kimi-k2.6":[0.98,4.0,0.98],"kimi-k3":[3.0,15.0,3.0],"minimax-m2.1":[0.29,1.2,0.29],"minimax-m2.7":[0.29,1.2,0.29],"qwen3.6-flash":[0.18,1.03,0.18]},"modal":{"deepseek-ai/deepseek-v4.1-flash":[0.3,1.2,0.03],"meta-models/muse-spark-open-816b-a42b":[1.25,4.25,0.15],"moonshotai/kimi-k3":[3.0,15.0,0.3],"nvidia/glm-5.3-flash-nvfp4":[0.15,0.5,0.03],"qwen/qwen3.8-2.4t-a95b":[2.0,6.0,0.25],"thinkingmachines/inkling-nvfp4":[1.2,5.0,0.27],"zai-org/glm-5.3":[1.4,4.4,0.26],"zai-org/glm-5.3-flash":[0.45,1.5,0.09]},"modelis":{"claude-fable-5":[10.0,50.0,10.0],"claude-opus-4-8":[5.0,25.0,5.0],"claude-sonnet-4-6":[3.0,15.0,3.0],"deepseek-v4-flash":[0.0983,0.1966,0.0983],"deepseek-v4-pro":[0.435,0.87,0.435],"gemini-2.5-flash":[0.3,2.5,0.3],"gemini-2.5-pro":[1.25,10.0,1.25],"qwen/qwen3.7-max":[3.0,9.0,3.0],"qwen/qwen3.7-plus":[0.768,3.072,0.768]},"modelscope":{"qwen/qwen3-235b-a22b-instruct-2507":[0.0,0.0],"qwen/qwen3-235b-a22b-thinking-2507":[0.0,0.0],"qwen/qwen3-30b-a3b-instruct-2507":[0.0,0.0],"qwen/qwen3-30b-a3b-thinking-2507":[0.0,0.0],"qwen/qwen3-coder-30b-a3b-instruct":[0.0,0.0],"zhipuai/glm-4.5":[0.0,0.0],"zhipuai/glm-4.6":[0.0,0.0]},"modular":{"deepseek/deepseek-v4.1-flash":[0.17,1.2,0.02],"google/gemma-4-31b-it":[0.25,0.65,0.08],"minimax/minimax-m3":[0.3,1.2,0.06],"minimaxai/minimax-m3.1-flash":[0.15,0.6,0.015]},"moonshotai":{"kimi-k2.6":[0.95,4.0,0.16],"kimi-k2.7-code":[0.95,4.0,0.19],"kimi-k2.7-code-highspeed":[1.9,8.0,0.38],"kimi-k3":[3.0,15.0,0.3],"kimi-k3.1-pro":[2.0,10.0,0.2],"kimi-k3.1-pro-highspeed":[4.0,20.0,0.2]},"moonshotai-cn":{"kimi-k2.6":[0.9711,4.0337,0.1643],"kimi-k2.7-code":[0.9711,4.0337,0.1942],"kimi-k2.7-code-highspeed":[1.9421,8.0673,0.3884],"kimi-k3":[2.9879,14.9395,0.2988],"kimi-k3.1-pro":[1.9437,10.1671,0.1944],"kimi-k3.1-pro-highspeed":[3.8874,20.3342,0.1944]},"morph":{"auto":[0.85,1.55,0.85],"morph-dsv41flash":[0.12,0.8,0.008],"morph-dsv41flash-1017":[0.12,0.8,0.008],"morph-dsv4flash":[0.141953125,0.399625,0.0359375],"morph-glm52-744b":[1.19,6.0,0.1955],"morph-glm53-744b":[1.19,6.0,0.1955],"morph-glm53flash":[0.2,0.7,0.04],"morph-kimik3":[2.5,14.0,0.29],"morph-kimik3-fast":[6.0,22.5,0.6],"morph-v3-fast":[0.8,1.2,0.8],"morph-v3-large":[0.9,1.9,0.9]},"munito":{"aleph-alpha/kolibri-1":[0.13,0.51,0.078],"deepseek-ai/deepseek-v4-flash":[0.099,0.25,0.019],"deepseek-ai/deepseek-v4.1-flash-1017":[0.27,1.0,0.0054],"qwen/qwen3.8-27b":[0.18,2.4,0.05],"zai-org/glm-5.3-flash":[0.13,0.45,0.027]},"munito-eu":{"aleph-alpha/kolibri-1":[0.16,0.56,0.094],"deepseek-ai/deepseek-v4-flash":[0.11,0.28,0.022],"qwen/qwen3.8-27b":[0.2,2.7,0.11],"zai-org/glm-5.3-flash":[0.15,0.5,0.03]},"nan":{"deepseek-v4-flash":[0.0,0.0],"gemma4":[0.0,0.0],"glm5.3":[0.0,0.0],"glm5.3-flash":[0.0,0.0],"mimo-v2.6-flash":[0.0,0.0],"qwen-image-2.1":[0.0,0.0],"qwen3.6":[0.0,0.0],"qwen3.8-flash":[0.0,0.0]},"nano-gpt":{"abacusai/dracarys-72b-instruct":[0.493,0.493,0.2465],"abliteration-ai/abliterated-model":[1.0,3.0,0.1],"abliteration-ai/abliterated-model-large":[3.0,5.0,0.3],"abliteration-ai/abliterated-model-large-flash":[1.0,2.0,0.1],"abliteration-ai/abliterated-model-large-v2":[3.0,5.0,0.3],"agnes-3.0-flash":[0.05,0.15,0.005],"aion-labs/aion-2.0":[0.8,1.6,0.2],"aion-labs/aion-3.0":[3.0,6.0,0.75],"aion-labs/aion-3.0-mini":[0.7,1.4,0.18],"aion-labs/aion-3.5":[3.0,6.0,0.75],"aion-labs/aion-3.5-mini":[0.7,1.4,0.18],"aion-labs/aion-rp-llama-3.1-8b":[0.8,1.6,0.4],"aisingapore/gemma-sea-lion-v4-27b-it":[0.24,0.48,0.24],"aisingapore/qwen-sea-lion-v4-32b-it":[0.3,0.6,0.3],"aleph-alpha/kolibri-1":[0.168,0.588,0.0987],"amazon/nova-2-lite-v1":[0.51,4.25,0.255],"amazon/nova-lite-v1":[0.0595,0.238,0.02975],"amazon/nova-pro-v1":[0.799,3.196,0.3995],"anthracite-org/magnum-v2-72b":[2.006,2.992,1.003],"anthracite-org/magnum-v4-72b":[2.006,2.992,1.003],"anthropic/claude-fable-5":[10.0,50.0,1.0],"anthropic/claude-fable-5.1":[10.0,50.0,0.25],"anthropic/claude-fable-latest":[10.0,50.0,0.25],"anthropic/claude-haiku-4.5":[1.0,5.0,0.1],"anthropic/claude-haiku-4.5:thinking":[1.0,5.0,0.1],"anthropic/claude-haiku-5.5":[0.1,0.5,0.01],"anthropic/claude-haiku-latest":[0.1,0.5,0.01],"anthropic/claude-opus-4.1":[15.0,75.0,1.5],"anthropic/claude-opus-4.1:thinking":[15.0,75.0,1.5],"anthropic/claude-opus-4.1:thinking:1024":[15.0,75.0,1.5],"anthropic/claude-opus-4.1:thinking:32768":[15.0,75.0,1.5],"anthropic/claude-opus-4.1:thinking:8192":[15.0,75.0,1.5],"anthropic/claude-opus-4.5":[5.0,25.0,0.5],"anthropic/claude-opus-4.5:thinking":[5.0,25.0,0.5],"anthropic/claude-opus-4.6":[5.0,25.0,0.5],"anthropic/claude-opus-4.6:thinking":[5.0,25.0,0.5],"anthropic/claude-opus-4.6:thinking:low":[5.0,25.0,0.5],"anthropic/claude-opus-4.6:thinking:max":[5.0,25.0,0.5],"anthropic/claude-opus-4.6:thinking:medium":[5.0,25.0,0.5],"anthropic/claude-opus-4.7":[5.0,25.0,0.5],"anthropic/claude-opus-4.7:thinking":[5.0,25.0,0.5],"anthropic/claude-opus-4.8":[5.0,25.0,0.5],"anthropic/claude-opus-4.8:thinking":[5.0,25.0,0.5],"anthropic/claude-opus-5":[5.0,25.0,0.5],"anthropic/claude-opus-5.5":[4.0,20.0,0.2],"anthropic/claude-opus-latest":[4.0,20.0,0.2],"anthropic/claude-sonnet-4.5":[3.0,15.0,0.3],"anthropic/claude-sonnet-4.5:thinking":[3.0,15.0,0.3],"anthropic/claude-sonnet-4.6":[3.0,15.0,0.3],"anthropic/claude-sonnet-4.6:thinking":[3.0,15.0,0.3],"anthropic/claude-sonnet-5":[2.0,10.0,0.2],"anthropic/claude-sonnet-5.5":[2.0,10.0,0.1],"anthropic/claude-sonnet-5.5:thinking":[2.0,10.0,0.1],"anthropic/claude-sonnet-5:thinking":[2.0,10.0,0.2],"anthropic/claude-sonnet-latest":[2.0,10.0,0.1],"arcee-ai/trinity-large-thinking":[0.25,0.9,0.125],"asi1-mini":[1.0,1.0,0.5],"auto-model":[0.0,0.0],"auto-model-basic":[9.996,19.992,4.998],"auto-model-premium":[9.996,19.992,4.998],"auto-model-standard":[9.996,19.992,4.998],"baseten/kimi-k2-instruct-fp4":[0.4,1.8,0.2],"bytedance-seed/seed-2-1-turbo":[0.5,2.5,0.25],"bytedance-seed/seed-2.0-code":[0.5,3.0,0.25],"bytedance-seed/seed-2.0-lite":[0.25,2.0,0.125],"bytedance/doubao-seed-2.1-pro":[1.0,5.0,0.5],"bytedance/doubao-seed-2.1-turbo":[0.5,2.5,0.25],"bytedance/doubao-seed-character":[0.15,0.37,0.03],"celeris-1":[2.0,6.0,1.0],"claw-high":[0.6,1.1,0.2],"claw-low":[0.6,1.1,0.2],"claw-medium":[0.6,1.1,0.2],"cohere/command-r-plus-08-2024":[2.856,14.246,1.428],"command-a-reasoning-08-2025":[2.5,10.0,1.25],"deepcogito/cogito-v1-preview-qwen-32b":[1.8,1.8,0.9],"deepseek-ai/deepseek-r1-0528":[0.5,2.15,0.35],"deepseek-ai/deepseek-v3.1":[0.2,0.7,0.1],"deepseek-ai/deepseek-v3.1-terminus":[0.25,0.7,0.125],"deepseek-ai/deepseek-v3.1-terminus:thinking":[0.25,0.7,0.125],"deepseek-ai/deepseek-v3.1:thinking":[0.2,0.7,0.1],"deepseek-ai/deepseek-v3.2-exp":[0.28,0.42,0.14],"deepseek-ai/deepseek-v3.2-exp-thinking":[0.28,0.42,0.14],"deepseek-chat":[0.1,0.425,0.05],"deepseek-chat-cheaper":[0.1,0.425,0.05],"deepseek-v3-0324":[0.2,0.77,0.135],"deepseek/deepseek-latest":[0.66,1.98,0.022],"deepseek/deepseek-v3.2":[0.2088,0.3096,0.0216],"deepseek/deepseek-v3.2:thinking":[0.2088,0.3096,0.0216],"deepseek/deepseek-v4-flash":[0.14,0.28,0.0028],"deepseek/deepseek-v4-flash-0423":[0.14,0.28,0.028],"deepseek/deepseek-v4-flash-0423:thinking":[0.14,0.28,0.028],"deepseek/deepseek-v4-flash-0731":[0.05,0.16,0.013],"deepseek/deepseek-v4-flash-0731:thinking":[0.05,0.16,0.013],"deepseek/deepseek-v4-flash-latest":[0.1,0.6,0.005],"deepseek/deepseek-v4-flash-vision-exp":[0.2156,0.6468,0.00686],"deepseek/deepseek-v4-flash:thinking":[0.14,0.28,0.0028],"deepseek/deepseek-v4-pro":[0.7,1.4,0.07],"deepseek/deepseek-v4-pro-0813":[0.66,1.98,0.022],"deepseek/deepseek-v4-pro-0813:thinking":[0.66,1.98,0.022],"deepseek/deepseek-v4-pro:thinking":[0.7,1.4,0.07],"deepseek/deepseek-v4.1-flash":[0.09,0.25,0.006],"deepseek/deepseek-v4.1-flash-0910-uncensored":[0.33,1.32,0.00825],"deepseek/deepseek-v4.1-flash-0910-uncensored:thinking":[0.33,1.32,0.00825],"deepseek/deepseek-v4.1-flash-1017":[0.1,0.6,0.005],"deepseek/deepseek-v4.1-flash-1017-uncensored":[0.33,1.32,0.00825],"deepseek/deepseek-v4.1-flash-1017-uncensored:thinking":[0.33,1.32,0.00825],"deepseek/deepseek-v4.1-flash-1017:thinking":[0.1,0.6,0.005],"deepseek/deepseek-v4.1-flash-uncensored":[0.33,1.32,0.00825],"deepseek/deepseek-v4.1-flash-uncensored:thinking":[0.33,1.32,0.00825],"deepseek/deepseek-v4.1-flash:thinking":[0.09,0.25,0.006],"doctor-shotgun/ms3.2-24b-magnum-diamond":[0.493,0.493,0.2465],"doubao-seed-2-0-code-preview-260215":[0.782,3.893,0.391],"doubao-seed-2-0-lite-260215":[0.25,2.0,0.0731],"doubao-seed-2-0-mini-260215":[0.1,0.4845,0.02465],"doubao-seed-2-0-pro-260215":[0.782,3.876,0.391],"elorian/glimpse":[0.63,3.15,0.063],"envoid/llama-3.05-nemotron-tenyxchat-storybreaker-70b":[0.493,0.493,0.2465],"envoid/llama-3.05-nt-storybreaker-ministral-70b":[0.493,0.493,0.2465],"ernie-5.0-thinking-preview":[1.0,3.5,0.5],"ernie-5.1":[0.75,3.0,0.75],"ernie-5.1:thinking":[0.75,3.0,0.75],"eva-unit-01/eva-llama-3.33-70b-v0.0":[2.006,2.006,1.003],"eva-unit-01/eva-llama-3.33-70b-v0.1":[2.006,2.006,1.003],"eva-unit-01/eva-qwen2.5-32b-v0.2":[0.799,0.799,0.3995],"eva-unit-01/eva-qwen2.5-72b-v0.2":[0.799,0.799,0.3995],"failspy/meta-llama-3-70b-instruct-abliterated-v3.5":[0.7,0.7,0.35],"fastgpt":[7.5,7.5,7.5],"featherless-ai/qwerky-72b":[0.5,0.5,0.25],"fireworks/ember-1":[3.0,15.0,0.3],"galrionsoftworks/mn-loosecannon-12b-v1":[0.493,0.493,0.2465],"gemini-2.0-pro-exp-02-05":[1.989,7.956,0.49725],"gemini-2.0-pro-reasoner":[1.292,4.998,0.323],"gemini-2.5-flash":[0.3,2.5,0.03],"gemini-2.5-flash-lite":[0.1,0.4,0.01],"gemini-2.5-flash-lite-preview-06-17":[0.15,0.6,0.015],"gemini-2.5-flash-lite-preview-09-2025":[0.1,0.4,0.01],"gemini-2.5-flash-lite-preview-09-2025-thinking":[0.1,0.4,0.01],"gemini-2.5-flash-nothinking":[0.3,2.5,0.03],"gemini-2.5-flash-preview-04-17":[0.15,0.6,0.015],"gemini-2.5-flash-preview-04-17:thinking":[0.15,3.5,0.015],"gemini-2.5-flash-preview-05-20":[0.15,0.6,0.015],"gemini-2.5-flash-preview-05-20:thinking":[0.15,3.5,0.015],"gemini-2.5-flash-preview-09-2025":[0.3,2.5,0.03],"gemini-2.5-flash-preview-09-2025-thinking":[0.3,2.5,0.03],"gemini-2.5-pro":[1.25,10.0,0.125],"gemini-2.5-pro-exp-03-25":[2.5,10.0,0.25],"gemini-2.5-pro-preview-03-25":[2.5,10.0,0.25],"gemini-2.5-pro-preview-05-06":[2.5,10.0,0.25],"gemini-2.5-pro-preview-06-05":[2.5,10.0,0.25],"gemini-3-pro-image-preview":[2.0,12.0,0.2],"gemini-exp-1206":[1.258,4.998,0.629],"gemma-4-12b-it":[0.05,0.25,0.025],"gemma-4-12b-it-semancer":[0.05,0.25,0.025],"gemma-4-12b-it-starry-ocean":[0.05,0.25,0.025],"gemma-4-12b-it-station-keeper":[0.05,0.25,0.025],"gemma-4-26b-a4b-it-chimerax":[0.12,0.38,0.06],"gemma-4-26b-a4b-it-chimeraxheretic":[0.12,0.38,0.06],"gemma-4-26b-a4b-it-darksoul":[0.12,0.38,0.06],"gemma-4-26b-a4b-it-luminous":[0.12,0.38,0.06],"gemma-4-26b-a4b-it-moonlight":[0.12,0.38,0.06],"gemma-4-26b-a4b-it-musica":[0.12,0.38,0.06],"gemma-4-26b-a4b-it-opusdistill":[0.12,0.38,0.06],"gemma-4-26b-a4b-it-shadowsiren":[0.12,0.38,0.06],"gemma-4-26b-a4b-meromero":[0.12,0.38,0.06],"gemma-4-26b-a4b-meromero:thinking":[0.12,0.38,0.06],"gemma-4-31b-agares-v1":[0.306,0.306,0.306],"gemma-4-31b-animus-v14.1":[0.306,0.306,0.306],"gemma-4-31b-assguard":[0.306,0.306,0.306],"gemma-4-31b-claude-4.6-opus-reasoning-distilled":[0.306,0.306,0.0306],"gemma-4-31b-cognitive-unshackled":[0.306,0.306,0.153],"gemma-4-31b-dark-gemistry":[0.306,0.306,0.306],"gemma-4-31b-darkidol":[0.306,0.306,0.153],"gemma-4-31b-fabled":[0.306,0.306,0.306],"gemma-4-31b-garnetv2":[0.306,0.306,0.153],"gemma-4-31b-gembrain-uncensored-heretic":[0.306,0.306,0.306],"gemma-4-31b-gembrain-x-core":[0.306,0.306,0.306],"gemma-4-31b-isometry-rp":[0.306,0.306,0.306],"gemma-4-31b-it-darkidol":[0.1,0.45,0.05],"gemma-4-31b-it-fabled":[0.1,0.45,0.05],"gemma-4-31b-it-garnet":[0.1,0.45,0.05],"gemma-4-31b-it-gembrain":[0.1,0.45,0.05],"gemma-4-31b-it-gemsicle":[0.1,0.45,0.05],"gemma-4-31b-it-isometry":[0.1,0.45,0.05],"gemma-4-31b-it-novelist":[0.1,0.45,0.05],"gemma-4-31b-it-scarlet":[0.1,0.45,0.05],"gemma-4-31b-k1-v5":[0.306,0.306,0.306],"gemma-4-31b-meromero":[0.306,0.306,0.306],"gemma-4-31b-meromero-v2":[0.1,0.45,0.05],"gemma-4-31b-meromero-v2:thinking":[0.1,0.45,0.05],"gemma-4-31b-novelist":[0.306,0.306,0.306],"gemma-4-31b-queen":[0.306,0.306,0.153],"gemma-4-31b-sdft-heretic-rp":[0.306,0.306,0.306],"gemma-4-31b-styletune":[0.306,0.306,0.306],"glm-4-long":[0.2006,0.2006,0.1003],"glm-4.6-derestricted-v5":[0.4,1.5,0.2],"google/diffusiongemma":[0.05,0.15,0.025],"google/gemini-3-flash-preview":[0.5,3.0,0.05],"google/gemini-3-flash-preview-thinking":[0.5,3.0,0.05],"google/gemini-3.1-flash-lite":[0.25,1.5,0.025],"google/gemini-3.1-pro-preview":[2.0,12.0,0.2],"google/gemini-3.1-pro-preview-customtools":[2.0,12.0,0.2],"google/gemini-3.1-pro-preview-high":[2.0,12.0,0.2],"google/gemini-3.1-pro-preview-low":[2.0,12.0,0.2],"google/gemini-3.5-flash":[1.5,9.0,0.15],"google/gemini-3.5-flash-lite":[0.3,2.5,0.03],"google/gemini-3.5-flash-thinking":[1.5,9.0,0.15],"google/gemini-3.6-flash":[0.75,3.75,0.075],"google/gemini-3.7-flash":[0.75,3.75,0.075],"google/gemini-3.8-flash":[0.75,3.75,0.075],"google/gemini-4-argon":[2.0,10.0,0.1],"google/gemini-flash-latest":[0.75,3.75,0.075],"google/gemini-flash-lite-latest":[0.3,2.5,0.03],"google/gemini-pro-latest":[2.0,12.0,0.2],"google/gemma-4-26b-a4b-it":[0.07,0.24,0.046],"google/gemma-4-26b-a4b-it-cybersecurity":[0.1056,0.3344,0.0528],"google/gemma-4-26b-a4b-it:thinking":[0.07,0.24,0.046],"google/gemma-4-31b-it":[0.14,0.4,0.05],"google/gemma-4-31b-it:thinking":[0.1,0.34,0.1],"google/gemma4-31b-splituntied":[0.1,0.3,0.05],"gryphe/mythomax-l2-13b":[0.1003,0.1003,0.05015],"heabsy/cyberheabsy":[1.5,4.5,0.275],"heabsy/qwen3.8-27b-uncensored-fast":[1.0,3.0,0.22],"hermes-high":[0.6,1.1,0.2],"hermes-low":[0.6,1.1,0.2],"hermes-medium":[0.6,1.1,0.2],"holo3-35b-a3b":[0.25,1.8,0.125],"holo3-35b-a3b:thinking":[0.25,1.8,0.125],"huihui-ai/deepseek-r1-distill-llama-70b-abliterated":[0.7,0.7,0.35],"huihui-ai/deepseek-r1-distill-qwen-32b-abliterated":[1.4,1.4,0.7],"huihui-ai/llama-3.3-70b-instruct-abliterated":[0.7,0.7,0.35],"huihui-ai/qwen2.5-32b-instruct-abliterated":[0.7,0.7,0.35],"ibm-granite/granite-4.2-8b":[0.06,0.15,0.015],"inception/mercury-2.5-preview":[0.04,0.15,0.004],"inception/mercury-3":[0.1,0.35,0.01],"inclusionai/ling-3.0-flash":[0.075,0.22,0.015],"inclusionai/ling-3.0-flash-vl":[0.06,0.18,0.012],"inclusionai/ling-3.0-flash:thinking":[0.075,0.22,0.015],"inclusionai/ling-3.1-flash":[0.075,0.22,0.015],"inference-net/schematron-v2-small":[0.05,0.23,0.025],"inference-net/schematron-v2-turbo":[0.03,0.15,0.015],"inflatebot/mn-12b-mag-mell-r1":[0.493,0.493,0.2465],"kimi-k2-instruct-fast":[0.4,1.8,0.2],"latitudegames/wayfarer-large-70b-llama-3.3":[0.7,0.7,0.35],"lightonai/lightonocr-2-1b":[0.1785,0.3465,0.1785],"liquid/lfm-2.5-2.6b":[0.1,0.2,0.05],"liquid/lfm-2.5-24b-a2b":[0.05,0.7,0.025],"llm360/k2-think":[0.17,0.68,0.085],"longcat-2.0":[0.75,3.0,0.015],"longcat-2.0:thinking":[0.75,3.0,0.015],"marinaraspaghetti/nemomix-unleashed-12b":[0.493,0.493,0.2465],"meganova-ai/manta-flash-1.0":[0.02,0.16,0.01],"meganova-ai/manta-mini-1.0":[0.02,0.16,0.01],"meganova-ai/manta-pro-1.0":[0.06,0.5,0.03],"meituan/longcat-2.5-preview":[0.75,2.95,0.015],"mercury-2":[0.25,0.75,0.025],"mercury-coder-small":[0.25,1.0,0.125],"meta-llama-3-1-8b-instruct-fp8":[0.02,0.03,0.01],"meta-llama/llama-3.1-8b-instruct":[0.02,0.04,0.0272],"meta-llama/llama-3.2-3b-instruct":[0.0306,0.0493,0.0153],"meta-llama/llama-3.3-70b-instruct":[0.05,0.23,0.025],"meta-llama/llama-4-maverick":[0.1875,0.6525,0.05],"meta-llama/llama-4-scout":[0.085,0.46,0.0425],"meta/muse-glimmer-30b":[0.35,1.5,0.04],"meta/muse-spark-1.1":[1.25,4.25,0.15],"meta/muse-spark-1.2":[1.25,4.25,0.15],"meta/muse-spark-1.2-contributor":[0.1,0.2,0.002],"meta/muse-spark-1.3":[1.25,4.25,0.15],"meta/muse-spark-1.3-contributor":[0.1,0.2,0.002],"meta/muse-spark-open":[1.25,4.25,0.15],"meta/muse-wonder":[4.0,20.0,0.2],"microsoft/wizardlm-2-8x22b":[0.493,0.493,0.2465],"minimax-m1":[0.1394,1.3328,0.0697],"minimax/minimax-01":[0.1394,1.122,0.0697],"minimax/minimax-latest":[0.23,0.96,0.05],"minimax/minimax-m2":[0.17,1.53,0.085],"minimax/minimax-m2-her":[0.302,1.207,0.151],"minimax/minimax-m2.1":[0.3,1.2,0.03],"minimax/minimax-m2.5":[0.27,1.08,0.027],"minimax/minimax-m2.7":[0.21,0.84,0.042],"minimax/minimax-m2.7-turbo":[0.6,2.4,0.06],"minimax/minimax-m3":[0.23,0.96,0.05],"minimax/minimax-m3.1-flash":[0.15,0.6,0.015],"minimax/minimax-m3:thinking":[0.23,0.96,0.05],"minimaxai/minimax-m1-80k":[0.6052,2.4225,0.3026],"mistral-code-agent-latest":[0.4,2.0,0.2],"mistral-code-latest":[0.3,0.9,0.15],"mistralai/codestral-2508":[0.3,0.9,0.15],"mistralai/devstral-2-123b-instruct-2512":[0.4,1.4,0.2],"mistralai/devstral-small-2505":[0.06,0.06,0.03],"mistralai/ministral-14b-2512":[0.2,0.2,0.1],"mistralai/ministral-14b-instruct-2512":[0.1,0.4,0.05],"mistralai/ministral-3b-2512":[0.1,0.1,0.05],"mistralai/ministral-8b-2512":[0.15,0.15,0.075],"mistralai/mistral-large":[2.006,6.001,0.2],"mistralai/mistral-large-4":[0.68,2.09,0.07],"mistralai/mistral-medium-3":[0.4,2.0,0.2],"mistralai/mistral-medium-3.1":[0.4,2.0,0.2],"mistralai/mistral-medium-3.5":[1.5,7.5,0.75],"mistralai/mistral-medium-3.5:thinking":[1.5,7.5,0.75],"mistralai/mistral-nemo-instruct-2407":[0.1003,0.1207,0.05015],"mistralai/mistral-saba":[0.1989,0.595,0.09945],"mistralai/mistral-small-24b-instruct-2501":[0.1155,0.3465,0.1155],"mistralai/mistral-small-3.1-24b-instruct":[0.1,0.3,0.05],"mistralai/mistral-small-3.2-24b-instruct":[0.2,0.4,0.1],"mistralai/mistral-small-4-119b-2603":[0.4,1.4,0.2],"mistralai/mistral-small-4-119b-2603:thinking":[0.4,1.4,0.2],"mistralai/mixtral-8x22b-instruct-v0.1":[2.0,6.0,0.2],"mlabonne/neuraldaredevil-8b-abliterated":[0.44,0.44,0.22],"moondream/moondream3-preview":[0.3,2.5,0.3],"moondream/moondream3.1-9b-a2b":[0.3,2.5,0.3],"moonshotai/kimi-k2-instruct":[0.4,1.8,0.2],"moonshotai/kimi-k2-instruct-0711":[0.4,1.8,0.2],"moonshotai/kimi-k2-instruct-0905":[0.4,1.8,0.2],"moonshotai/kimi-k2-thinking":[0.6,2.5,0.15],"moonshotai/kimi-k2.5":[0.375,2.0,0.07],"moonshotai/kimi-k2.5:thinking":[0.375,2.0,0.07],"moonshotai/kimi-k2.6":[0.39,1.8,0.039],"moonshotai/kimi-k2.6:thinking":[0.39,1.8,0.039],"moonshotai/kimi-k2.7-code":[0.6,3.0,0.12],"moonshotai/kimi-k2.7-code-highspeed":[1.9,8.0,0.32],"moonshotai/kimi-k3":[1.65,8.25,0.165],"moonshotai/kimi-k3.1-pro":[2.0,10.0,0.2],"moonshotai/kimi-k3.1-pro-highspeed":[4.0,20.0,0.2],"moonshotai/kimi-latest":[2.0,10.0,0.2],"nano-gpt-help":[0.0,0.0],"nanogpt/coding-router":[1.1,2.2,0.11],"nanogpt/coding-router:high":[1.1,2.2,0.11],"nanogpt/coding-router:low":[0.14,0.28,0.028],"nanogpt/coding-router:max":[5.0,30.0,0.5],"nanogpt/coding-router:medium":[0.14,0.28,0.028],"neversleep/lumimaid-v0.2-70b":[1.0,1.5,0.5],"nex-agi/nex-n2.5-mini":[0.025,0.1,0.0025],"nex-agi/nex-n2.5-pro":[0.075,0.25,0.015],"nothingiisreal/l3.1-70b-celeste-v0.1-bf16":[0.493,0.493,0.2465],"nousresearch/hermes-3-llama-3.1-70b":[0.408,0.408,0.204],"nousresearch/hermes-4-405b":[0.3,1.2,0.15],"nousresearch/hermes-4-405b:thinking":[0.3,1.2,0.15],"nvidia/llama-3.1-nemotron-70b-instruct-hf":[0.357,0.408,0.1785],"nvidia/llama-3.3-nemotron-super-49b-v1":[0.15,0.15,0.075],"nvidia/nemotron-3-nano-30b-a3b":[0.17,0.68,0.085],"nvidia/nemotron-3-super-120b-a12b":[0.05,0.25,0.025],"nvidia/nemotron-3-super-120b-a12b:thinking":[0.05,0.25,0.025],"nvidia/nemotron-3-ultra-550b-a55b":[0.5,2.5,0.15],"nvidia/nemotron-3-ultra-550b-a55b:thinking":[0.5,2.5,0.15],"nvidia/nemotron-3.5-content-safety":[0.05,0.15,0.025],"nvidia/nemotron-3.5-lightning":[0.05,0.2,0.01],"nvidia/nemotron-3.5-lightning:thinking":[0.05,0.2,0.01],"nvidia/nemotron-3.5-super-vl":[0.15,0.5,0.02],"openai/gpt-4-turbo":[10.0,30.0,10.0],"openai/gpt-4.1":[2.0,8.0,0.5],"openai/gpt-4.1-mini":[0.4,1.6,0.1],"openai/gpt-4.1-nano":[0.1,0.4,0.025],"openai/gpt-4o":[2.5,10.0,1.25],"openai/gpt-4o-2024-08-06":[2.5,10.0,1.25],"openai/gpt-4o-2024-11-20":[2.5,10.0,1.25],"openai/gpt-4o-mini":[0.15,0.6,0.075],"openai/gpt-5":[1.25,10.0,0.125],"openai/gpt-5-mini":[0.25,2.0,0.025],"openai/gpt-5-nano":[0.05,0.4,0.005],"openai/gpt-5-pro":[15.0,120.0,1.5],"openai/gpt-5.1":[1.25,10.0,0.125],"openai/gpt-5.1-2025-11-13":[1.25,10.0,0.125],"openai/gpt-5.1-codex":[1.25,10.0,0.125],"openai/gpt-5.1-codex-max":[2.5,20.0,0.25],"openai/gpt-5.1-codex-mini":[0.25,2.0,0.025],"openai/gpt-5.2":[1.75,14.0,0.175],"openai/gpt-5.2-codex":[1.75,14.0,0.175],"openai/gpt-5.3-codex":[1.75,14.0,0.175],"openai/gpt-5.4":[2.5,15.0,0.25],"openai/gpt-5.4-mini":[0.75,4.5,0.075],"openai/gpt-5.4-nano":[0.2,1.25,0.02],"openai/gpt-5.5":[5.0,30.0,0.5],"openai/gpt-5.6-luna":[0.2,1.2,0.02],"openai/gpt-5.6-luna-pro":[0.2,1.2,0.02],"openai/gpt-5.6-sol":[2.0,10.0,0.2],"openai/gpt-5.6-sol-pro":[2.0,10.0,0.2],"openai/gpt-5.6-terra":[2.0,12.0,0.2],"openai/gpt-5.6-terra-pro":[2.0,12.0,0.2],"openai/gpt-6-astra":[10.0,50.0,1.0],"openai/gpt-6-astra-pro":[10.0,50.0,1.0],"openai/gpt-6-luna":[0.1,0.5,0.01],"openai/gpt-6-luna-pro":[0.1,0.5,0.01],"openai/gpt-6-sol":[2.0,10.0,0.2],"openai/gpt-6-sol-pro":[2.0,10.0,0.2],"openai/gpt-6.1-sol":[2.0,10.0,0.1],"openai/gpt-6.1-sol-pro":[2.0,10.0,0.1],"openai/gpt-6.1-terra":[1.0,5.0,0.05],"openai/gpt-6.1-terra-pro":[1.0,5.0,0.05],"openai/gpt-astra-latest":[10.0,50.0,1.0],"openai/gpt-chat-latest":[2.0,10.0,0.1],"openai/gpt-latest":[10.0,50.0,1.0],"openai/gpt-luna-latest":[0.1,0.5,0.01],"openai/gpt-oss-120b":[0.03,0.15,0.03],"openai/gpt-oss-20b":[0.02,0.1,0.02],"openai/gpt-oss-safeguard-20b":[0.075,0.3,0.075],"openai/gpt-sol-latest":[2.0,10.0,0.1],"openai/gpt-terra-latest":[1.0,5.0,0.05],"openai/o1":[15.0,60.0,7.5],"openai/o1-pro":[150.0,600.0,75.0],"openai/o3":[2.0,8.0,1.0],"openai/o3-mini":[1.1,4.4,0.55],"openai/o3-mini-high":[1.1,4.4,0.55],"openai/o3-mini-low":[1.1,4.4,0.55],"openai/o3-pro-2025-06-10":[22.0,88.0,11.0],"openai/o4-mini":[1.1,4.4,0.55],"openai/o4-mini-high":[1.1,4.4,0.55],"ornith-ai/ornith-1.5-122b":[0.26,2.08,0.07],"ornith-ai/ornith-1.5-35b-a3b":[0.1,0.4,0.05],"ornith-ai/ornith-1.5-35b-a3b:thinking":[0.1,0.4,0.05],"pamanseau/openreasoning-nemotron-32b":[0.1,0.4,0.05],"particle-ai/particle-1":[0.25,1.0,0.03],"perceptron/perceptron-mk1":[0.15,1.5,0.075],"perceptron/perceptron-mk1.5":[0.15,1.5,0.15],"phi-4-mini-instruct":[0.17,0.68,0.085],"phi-4-multimodal-instruct":[0.07,0.11,0.035],"pokee-isaac":[0.15,1.0,0.075],"poolside/laguna-s-2.1":[0.1,0.2,0.01],"poolside/laguna-s-2.1:thinking":[0.1,0.2,0.01],"prism-ml/ternary-bonsai-2-27b":[0.075,0.5,0.0375],"prism-ml/ternary-bonsai-2-9b":[0.08,0.13,0.04],"qwen/qwen-2.5-72b-instruct":[0.36,0.4,0.1785],"qwen/qwen-long":[0.1003,0.408,0.05015],"qwen/qwen-max":[1.5997,6.392,0.79985],"qwen/qwen-plus":[0.3995,1.2002,0.19975],"qwen/qwen-turbo":[0.04998,0.2006,0.02499],"qwen/qwen2.5-coder-32b-instruct":[0.2006,0.2006,0.1003],"qwen/qwen2.5-vl-72b-instruct":[0.69989,0.69989,0.69989],"qwen/qwen3-14b":[0.08,0.24,0.04],"qwen/qwen3-235b-a22b":[0.0875,0.35,0.0175],"qwen/qwen3-235b-a22b-instruct-2507":[0.0875,0.35,0.0175],"qwen/qwen3-235b-a22b-thinking-2507":[0.3,0.5,0.3],"qwen/qwen3-30b-a3b":[0.1,0.3,0.05],"qwen/qwen3-30b-a3b-instruct-2507":[0.2,0.5,0.1],"qwen/qwen3-32b":[0.08,0.24,0.05],"qwen/qwen3-8b":[0.47,0.47,0.235],"qwen/qwen3-coder":[0.13,0.5,0.065],"qwen/qwen3-coder-30b-a3b-instruct":[0.1,0.4,0.05],"qwen/qwen3-coder-flash":[0.3,1.5,0.15],"qwen/qwen3-coder-next":[0.250251,0.80293,0.079764],"qwen/qwen3-next-80b-a3b-instruct":[0.09,1.1,0.07],"qwen/qwen3-next-80b-a3b-thinking":[0.15,0.65,0.075],"qwen/qwen3-vl-235b-a22b-instruct":[0.3,1.9,0.15],"qwen/qwen3-vl-235b-a22b-thinking":[0.5,6.0,0.25],"qwen/qwen3.5-122b-a10b":[0.26,2.08,0.103788],"qwen/qwen3.5-122b-a10b:thinking":[0.26,2.08,0.103788],"qwen/qwen3.5-27b":[0.25,2.0,0.135],"qwen/qwen3.5-27b:thinking":[0.25,2.0,0.135],"qwen/qwen3.5-35b-a3b":[0.14,1.0,0.05],"qwen/qwen3.5-35b-a3b:thinking":[0.14,1.0,0.05],"qwen/qwen3.5-397b-a17b":[0.39,2.34,0.3],"qwen/qwen3.5-397b-a17b:thinking":[0.39,2.34,0.3],"qwen/qwen3.5-9b":[0.05,0.15,0.008],"qwen/qwen3.5-flash":[0.1,0.4,0.05],"qwen/qwen3.5-flash:thinking":[0.1,0.4,0.05],"qwen/qwen3.5-plus":[0.4,2.4,0.04],"qwen/qwen3.5-plus:thinking":[0.4,2.4,0.04],"qwen/qwen3.6-27b":[0.203,2.24,0.1015],"qwen/qwen3.6-27b:thinking":[0.203,2.24,0.1015],"qwen/qwen3.6-35b-a3b":[0.112,0.8,0.056],"qwen/qwen3.6-35b-a3b:thinking":[0.112,0.8,0.056],"qwen/qwen3.6-flash":[0.19,1.16,0.02],"qwen/qwen3.6-max-preview":[1.04,6.24,0.52],"qwen/qwen3.6-plus":[0.325,1.95,0.0325],"qwen/qwen3.7-flash":[0.03,0.13,0.006],"qwen/qwen3.7-flash:thinking":[0.03,0.13,0.006],"qwen/qwen3.7-max":[1.475,4.425,0.295],"qwen/qwen3.7-max:thinking":[1.475,4.425,0.295],"qwen/qwen3.7-plus":[0.4,1.6,0.08],"qwen/qwen3.7-plus:thinking":[0.4,1.6,0.08],"qwen/qwen3.8-27b":[0.15,0.7,0.04],"qwen/qwen3.8-27b-antislop":[0.1,0.6,0.05],"qwen/qwen3.8-27b-cybersecurity":[0.1,0.6,0.05],"qwen/qwen3.8-27b-darkidol":[0.1,0.6,0.05],"qwen/qwen3.8-27b-fable":[0.25,1.5,0.125],"qwen/qwen3.8-27b-fimi":[0.1,0.6,0.05],"qwen/qwen3.8-27b-hemmingway":[0.25,1.5,0.125],"qwen/qwen3.8-27b-kimiko":[0.1,0.6,0.05],"qwen/qwen3.8-27b-kiwen":[0.1,0.6,0.05],"qwen/qwen3.8-27b-novelist":[0.1,0.6,0.05],"qwen/qwen3.8-27b-queen":[0.25,1.5,0.125],"qwen/qwen3.8-27b-swift":[0.1,0.6,0.05],"qwen/qwen3.8-27b-synthia":[0.1,0.6,0.05],"qwen/qwen3.8-27b-uncensored":[1.0,3.0,0.22],"qwen/qwen3.8-27b-uncensored:thinking":[1.0,3.0,0.22],"qwen/qwen3.8-27b:thinking":[0.15,0.7,0.04],"qwen/qwen3.8-flash":[0.14,0.42,0.016],"qwen/qwen3.8-max":[2.0,6.0,0.25],"qwen/qwen3.8-max-0902":[2.0,6.0,0.25],"qwen/qwen3.8-max-prime":[4.0,12.0,0.5],"qwen/qwen3.8-max:thinking":[2.0,6.0,0.25],"qwen/qwen3.8-omni-flash":[0.15,0.47,0.016],"qwen3-vl-235b-a22b-instruct-original":[0.3,1.9,0.15],"qwen3.5-27b-blossom-v6.4-derestricted":[0.306,0.306,0.306],"qwen3.5-27b-bluestar-v3-derestricted":[0.306,0.306,0.153],"qwen3.5-27b-claude-4.6-opus-reasoning-distilled-derestricted":[0.306,0.306,0.0306],"qwen3.5-27b-claude-4.6-opus-reasoning-distilled-derestricted-lite":[0.306,0.306,0.0306],"qwen3.5-27b-queen-derestricted":[0.306,0.306,0.153],"readyart/ms3.2-the-omega-directive-24b-unslop-v2.0":[0.5,0.5,0.25],"reflection/beam-1.0":[0.5,1.5,0.05],"reka/reka-edge-2603":[0.105,0.105,0.105],"reka/reka-flash-3":[0.105,0.21,0.105],"sakana/fugu-max":[2.0,6.0,0.25],"sakana/fugu-ultra":[5.0,30.0,0.5],"sakana/fugu-ultra-v1.1":[5.0,30.0,0.5],"salesforce/llama-xlam-2-70b-fc-r":[2.5,2.5,1.25],"sao10k/l3-8b-stheno-v3.2":[0.2006,0.2006,0.1003],"sao10k/l3.1-70b-euryale-v2.2":[0.306,0.357,0.153],"sao10k/l3.1-70b-hanami-x1":[0.493,0.493,0.2465],"sao10k/l3.3-70b-euryale-v2.3":[0.493,0.493,0.2465],"sarvam-105b":[0.054,0.2124,0.0336],"shisa-ai/shisa-v2-llama3.3-70b":[0.5,0.5,0.25],"shisa-ai/shisa-v2.1-llama3.3-70b":[0.5,0.5,0.25],"soob3123/amoral-gemma3-27b-v2":[0.3,0.3,0.15],"soob3123/grayline-qwen3-8b":[0.3,0.3,0.3],"soob3123/veiled-calla-12b":[0.3,0.3,0.15],"speakleash/bielik-11b-v3.0-instruct":[0.48,0.48,0.48],"steelskull/l3.3-cu-mai-r1-70b":[0.493,0.493,0.2465],"steelskull/l3.3-electra-r1-70b":[0.69989,0.69989,0.349945],"steelskull/l3.3-ms-nevoria-70b":[0.493,0.493,0.2465],"steelskull/l3.3-nevoria-r1-70b":[0.493,0.493,0.2465],"stepfun-ai/step-3.5-flash":[0.1,0.3,0.05],"stepfun-ai/step-3.5-flash-2603":[0.1,0.3,0.05],"stepfun/step-3.7-flash:thinking":[0.2,1.15,0.04],"stepfun/step-5-preview":[1.0,2.7,0.05],"synth-2.5-flash":[0.03,0.1,0.03],"synth-2.5-pro":[0.1,0.2,0.1],"tee/deepseek-v3.2":[0.5,1.0,0.25],"tee/deepseek-v4.1-flash":[0.65,1.45,0.13],"tee/gemma-4-26b-a4b-uncensored":[0.15,0.7,0.075],"tee/gemma-4-31b-it":[0.15,0.46,0.075],"tee/gemma4-31b":[0.4,1.0,0.4],"tee/gemma4-31b:thinking":[0.4,1.0,0.4],"tee/glm-5.1":[0.7,2.5,0.18],"tee/glm-5.1-thinking":[0.7,2.5,0.18],"tee/glm-5.2":[1.4,4.4,0.7],"tee/glm-5.2:thinking":[1.4,4.4,0.7],"tee/glm-5.3":[1.4,4.4,0.26],"tee/glm-5.3-flash":[0.15,0.5,0.03],"tee/gpt-oss-120b":[2.0,2.0,2.0],"tee/kimi-k2.6":[1.5,5.25,0.375],"tee/kimi-k2.7-code":[0.95,4.0,0.19],"tee/kimi-k3":[3.0,15.0,1.5],"tee/llama3-3-70b":[1.75,2.75,1.75],"tee/nemotron-3.5-lightning":[0.08,0.2,0.04],"tee/qwen2.5-vl-72b-instruct":[0.7,0.7,0.35],"tee/qwen3.5-27b":[0.3,2.4,0.15],"tee/qwen3.5-397b-a17b":[0.55,3.5,0.275],"tee/qwen3.6-27b":[0.32,2.7,0.16],"tee/qwen3.6-35b-a3b":[0.2,1.27,0.1],"tee/qwen3.8-27b":[0.4,3.0,0.15],"tencent/hy3":[0.066,0.26,0.029],"tencent/hy4-preview":[0.834,2.501,0.042],"thedrummer/anubis-70b-v1":[0.31,0.31,0.155],"thedrummer/anubis-70b-v1.1":[0.31,0.31,0.155],"thedrummer/artemis-v1.1":[0.1,0.45,0.05],"thedrummer/cydonia-24b-v2":[0.1003,0.1207,0.05015],"thedrummer/cydonia-24b-v4":[0.2006,0.2414,0.1003],"thedrummer/cydonia-24b-v4.1":[0.3,0.5,0.15],"thedrummer/cydonia-24b-v4.3":[0.12,0.15,0.06],"thedrummer/magidonia-24b-v4.3":[0.1003,0.1207,0.05015],"thedrummer/rocinante-12b-v1.1":[0.408,0.595,0.204],"thedrummer/skyfall-36b-v2":[0.55,0.8,0.25],"thedrummer/unslopnemo-12b-v4.1":[0.493,0.493,0.2465],"thinkingmachines/inkling":[1.0,4.05,0.17],"thinkingmachines/inkling-small":[0.45,1.2,0.1],"thinkingmachines/inkling-small:thinking":[0.45,1.2,0.1],"thinkingmachines/inkling:thinking":[1.0,4.05,0.17],"unbiased/pareto-26.10":[0.8,3.2,0.03],"unbiased/pareto-26.9":[2.5,7.5,0.25],"undi95/remm-slerp-l2-13b":[0.799,1.207,0.3995],"universal-summarizer":[30.0,30.0,30.0],"unsloth/gemma-3-12b-it":[0.272,0.272,0.136],"unsloth/gemma-3-27b-it":[0.2992,0.2992,0.1496],"unsloth/gemma-3-4b-it":[0.2006,0.2006,0.1003],"upstage/solar-mini4":[0.05,0.2,0.005],"upstage/solar-mini4:thinking":[0.05,0.2,0.005],"upstage/solar-pro-3":[0.15,0.6,0.015],"upstage/solar-pro4":[0.03,0.12,0.006],"upstage/solar-pro4:thinking":[0.03,0.12,0.006],"venice-uncensored":[0.4,1.8,0.4],"vongolachouko/starcannon-unleashed-12b-v1.0":[0.493,0.493,0.2465],"x-ai/grok-4.20":[1.25,2.5,0.2],"x-ai/grok-4.20-multi-agent":[1.25,2.5,0.2],"x-ai/grok-4.3":[1.25,2.5,0.2],"x-ai/grok-4.5":[2.0,6.0,0.3],"x-ai/grok-4.6":[2.0,6.0,0.5],"x-ai/grok-4.7":[2.0,6.0,0.5],"x-ai/grok-build-0.1":[1.0,2.0,0.2],"x-ai/grok-latest":[2.0,6.0,0.5],"xiaomi/mimo-v2.5":[0.14,0.28,0.0028],"xiaomi/mimo-v2.5-pro":[0.435,0.87,0.0036],"xiaomi/mimo-v2.5-pro:thinking":[0.435,0.87,0.0036],"xiaomi/mimo-v2.5:thinking":[0.14,0.28,0.0028],"xiaomi/mimo-v2.6-flash":[0.14,0.28,0.0028],"xiaomi/mimo-v2.6-flash-abliterated":[0.5,1.5,0.275],"xiaomi/mimo-v2.6-flash-uncensored":[0.5,1.5,0.1995],"xiaomi/mimo-v2.6-flash-uncensored:thinking":[0.5,1.5,0.1995],"xiaomi/mimo-v2.6-pro":[0.435,0.87,0.0036],"xiaomi/mimo-v2.6-pro-ultraspeed":[4.35,8.7,0.036],"xingchen-agi/xing4.0-29b-a4b":[0.22,0.9,0.011],"z-ai/glm-4.5":[0.3,1.3,0.15],"z-ai/glm-4.5-air":[0.13,0.85,0.025],"z-ai/glm-4.5-air:thinking":[0.13,0.85,0.025],"z-ai/glm-4.5:thinking":[0.3,1.3,0.15],"z-ai/glm-4.5v":[0.6,1.8,0.3],"z-ai/glm-4.5v:thinking":[0.6,1.8,0.3],"z-ai/glm-4.6":[0.5,2.0,0.1],"z-ai/glm-4.6-original":[0.5,2.0,0.1],"z-ai/glm-4.6-turbo":[1.0,3.0,0.5],"z-ai/glm-4.6-turbo:thinking":[1.0,3.0,0.5],"z-ai/glm-4.6:thinking":[0.5,2.0,0.1],"z-ai/glm-4.6v":[0.3,0.9,0.15],"z-ai/glm-4.6v-original":[0.6,0.9,0.3],"z-ai/glm-4.7":[0.4004,1.9292,0.08008],"z-ai/glm-4.7-flash":[0.07,0.4,0.010672],"z-ai/glm-4.7-flash:thinking":[0.07,0.4,0.010672],"z-ai/glm-4.7-original":[0.4004,1.9292,0.08008],"z-ai/glm-4.7-original:thinking":[0.4004,1.9292,0.08008],"z-ai/glm-4.7:thinking":[0.4004,1.9292,0.08008],"z-ai/glm-5":[0.6,1.9,0.1],"z-ai/glm-5-original":[0.6,1.9,0.1],"z-ai/glm-5-original:thinking":[0.6,1.9,0.1],"z-ai/glm-5-turbo":[1.2,4.0,0.24],"z-ai/glm-5.1":[0.7,2.5,0.18],"z-ai/glm-5.1:thinking":[0.7,2.5,0.18],"z-ai/glm-5.2":[0.226,2.208,0.076],"z-ai/glm-5.2:thinking":[0.226,2.208,0.076],"z-ai/glm-5.3":[0.6,1.1,0.2],"z-ai/glm-5.3-flash":[0.1,0.3,0.025],"z-ai/glm-5.3-flash-apex":[0.15,0.5,0.075],"z-ai/glm-5.3-flash-apex-abliterated":[0.15,0.5,0.075],"z-ai/glm-5.3-flash-cybersecurity":[0.15,0.5,0.075],"z-ai/glm-5.3-flash-uncensored":[0.2,0.8,0.07],"z-ai/glm-5.3-uncensored":[1.25,2.25,0.3],"z-ai/glm-5.3:thinking":[0.6,1.1,0.2],"z-ai/glm-5:thinking":[0.6,1.9,0.1],"z-ai/glm-5v-turbo":[1.2,4.0,0.24],"z-ai/glm-5v-turbo:thinking":[1.2,4.0,0.24],"z-ai/glm-latest":[0.6,1.1,0.2]},"nearai":{"anthropic/claude-fable-5":[10.0,50.0,1.0],"anthropic/claude-fable-5-1":[10.0,50.0,0.25],"anthropic/claude-haiku-4-5":[1.0,5.0,0.1],"anthropic/claude-haiku-5-5":[0.1,0.5,0.01],"anthropic/claude-opus-4-6":[5.0,25.0,0.5],"anthropic/claude-opus-4-7":[5.0,25.0,0.5],"anthropic/claude-opus-4-8":[5.0,25.0,0.5],"anthropic/claude-opus-5":[5.0,25.0,0.5],"anthropic/claude-opus-5-5":[4.0,20.0,0.2],"anthropic/claude-sonnet-4-5":[3.0,15.0,0.3],"anthropic/claude-sonnet-4-6":[3.0,15.0,0.3],"anthropic/claude-sonnet-5":[2.0,10.0,0.2],"anthropic/claude-sonnet-5-5":[2.0,10.0,0.1],"deepseek/deepseek-v3.2":[1.1,1.1,0.55],"deepseek/deepseek-v4.1-flash-1017":[0.3,1.2,0.006],"google/gemini-2.5-flash":[0.3,2.5,0.03],"google/gemini-2.5-flash-lite":[0.1,0.4,0.01],"google/gemini-2.5-pro":[1.25,10.0,0.125],"google/gemini-3.1-flash-lite":[0.25,1.5,0.025],"google/gemini-3.5-flash":[1.5,9.0,0.15],"google/gemini-3.8-flash":[0.75,3.75,0.075],"moonshotai/kimi-k2.6":[0.81,3.85,0.41],"moonshotai/kimi-k3":[3.3,16.5,0.33],"moonshotai/kimi-k3.1-pro":[2.0,10.0,0.2],"openai/gpt-4.1":[2.0,8.0,0.5],"openai/gpt-4.1-mini":[0.4,1.6,0.1],"openai/gpt-5":[1.25,10.0,0.125],"openai/gpt-5-mini":[0.25,2.0,0.025],"openai/gpt-5-nano":[0.05,0.4,0.005],"openai/gpt-5.1":[1.25,10.0,0.125],"openai/gpt-5.2":[1.75,14.0,0.175],"openai/gpt-5.4":[2.5,15.0,0.25],"openai/gpt-5.4-mini":[0.75,4.5,0.075],"openai/gpt-5.4-nano":[0.2,1.25,0.02],"openai/gpt-5.5":[5.0,30.0,0.5],"openai/gpt-5.6-luna":[0.2,1.2,0.02],"openai/gpt-5.6-sol":[4.0,20.0,0.4],"openai/gpt-6-astra":[10.0,50.0,1.0],"openai/gpt-6-luna":[0.1,0.5,0.01],"openai/gpt-6-sol":[2.0,10.0,0.2],"openai/gpt-6.1-sol":[2.0,10.0,0.1],"openai/o3":[2.0,8.0,0.5],"openai/o3-mini":[1.1,4.4,0.55],"openai/o4-mini":[1.1,4.4,0.275],"openai/whisper-large-v3":[0.01,0.01,0.01],"qwen/qwen3-embedding-0.6b":[0.01,0.01,0.01],"qwen/qwen3-reranker-0.6b":[0.01,0.01,0.01],"qwen/qwen3-vl-30b-a3b-instruct":[0.15,0.55,0.03],"qwen/qwen3.5-397b-a17b":[0.5,3.3,0.25],"qwen/qwen3.6-35b-a3b-fp8":[0.17,1.1,0.056],"qwen/qwen3.7-max":[2.8,7.5,2.8],"qwen/qwen3.8-27b":[0.04,1.35,0.018],"x-ai/grok-4.6":[2.0,6.0,0.5],"x-ai/grok-4.7":[2.0,6.0,0.5],"z-ai/glm-5.3":[1.8,5.75,0.45],"z-ai/glm-5.3-flash":[0.08,0.5,0.012]},"nebius":{"deepseek-ai/deepseek-v4-flash-0731":[0.14,0.28,0.01],"deepseek-ai/deepseek-v4-pro":[1.75,3.5,1.75],"deepseek-ai/deepseek-v4-pro-0813":[1.32,3.96,0.04],"deepseek-ai/deepseek-v4.1-flash":[0.3,1.2,0.01],"deepseek-ai/deepseek-v4.1-flash-1017":[0.3,1.2,0.006],"google/gemma-3-27b-it":[0.1,0.3,0.1],"meta-models/muse-spark-open":[1.25,4.25,0.15],"minimaxai/minimax-m3":[0.3,1.2,0.06],"minimaxai/minimax-m3.1-flash":[0.15,0.6,0.015],"moonshotai/kimi-k2.7-code":[0.95,4.0,0.15],"moonshotai/kimi-k3":[3.0,15.0,0.3],"nousresearch/hermes-4-405b":[1.0,3.0,1.0],"nvidia/nemotron-3-super-120b-a12b":[0.3,0.9,0.06],"nvidia/nemotron-3-ultra-550b-a55b":[1.0,3.0,0.12],"nvidia/nemotron-3.5-super-vl":[0.3,0.9,0.06],"nvidia/nemotron-3_5-lightning":[0.06,0.24,0.06],"openai/gpt-oss-120b":[0.15,0.6,0.15],"qwen/qwen3-235b-a22b-instruct-2507":[0.2,0.6,0.2],"qwen/qwen3-30b-a3b-instruct-2507":[0.1,0.3,0.1],"qwen/qwen3-embedding-8b":[0.01,0.0,0.01],"qwen/qwen3.5-397b-a17b":[0.6,3.6,0.12],"qwen/qwen3.8-27b":[0.45,3.0,0.1],"reflection/beam":[0.25,1.0,0.05],"zai-org/glm-5.2":[1.4,4.4,0.14],"zai-org/glm-5.3":[1.4,4.4,0.26],"zai-org/glm-5.3-flash":[0.15,0.5,0.03]},"neon":{"claude-fable-5":[10.0,50.0,1.0],"claude-fable-5-1":[10.0,50.0,0.25],"claude-haiku-4-5":[1.0,5.0,0.1],"claude-haiku-5-5":[0.1,0.5,0.01],"claude-opus-4-1":[15.0,75.0,1.5],"claude-opus-4-5":[5.0,25.0,0.5],"claude-opus-4-6":[5.0,25.0,0.5],"claude-opus-4-7":[5.0,25.0,0.5],"claude-opus-4-8":[5.0,25.0,0.5],"claude-opus-5":[5.0,25.0,0.5],"claude-opus-5-5":[4.0,20.0,0.2],"claude-sonnet-4-5":[3.0,15.0,0.3],"claude-sonnet-4-6":[3.0,15.0,0.3],"claude-sonnet-5":[2.0,10.0,0.2],"claude-sonnet-5-5":[2.0,10.0,0.2],"deepseek-v4-1-flash":[0.3,1.2,0.03],"gemini-3-1-flash-lite":[0.25,1.5,0.025],"gemini-3-1-pro":[2.0,12.0,0.2],"gemini-3-5-flash":[1.5,9.0,0.15],"gemini-3-5-flash-lite":[0.3,2.5,0.03],"gemini-3-6-flash":[1.5,7.5,0.15],"gemini-3-7-flash":[1.5,7.5,0.15],"gemini-3-8-flash":[1.5,7.5,0.15],"gemini-3-flash":[0.5,3.0,0.05],"gemini-4-argon":[4.0,20.0,0.2],"gemma-3-12b":[0.15,0.5,0.15],"glm-5-2":[1.4,4.4,0.26],"glm-5-3":[1.4,4.4,0.26],"glm-5-3-flash":[0.15,0.5,0.03],"gpt-5":[1.25,10.0,0.125],"gpt-5-1":[1.25,10.0,0.125],"gpt-5-2":[1.75,14.0,0.175],"gpt-5-3-codex":[1.75,14.0,0.175],"gpt-5-4":[2.5,15.0,0.25],"gpt-5-4-mini":[0.75,4.5,0.075],"gpt-5-4-nano":[0.2,1.25,0.02],"gpt-5-5":[5.0,30.0,0.5],"gpt-5-5-pro":[30.0,180.0,30.0],"gpt-5-6-luna":[0.2,1.2,0.02],"gpt-5-6-sol":[5.0,30.0,0.5],"gpt-5-6-terra":[2.0,12.0,0.2],"gpt-5-mini":[0.25,2.0,0.025],"gpt-5-nano":[0.05,0.4,0.01],"gpt-6-1-sol":[2.0,10.0,0.1],"gpt-6-astra":[10.0,50.0,1.0],"gpt-6-luna":[0.1,0.5,0.01],"gpt-6-sol":[2.0,10.0,0.2],"gpt-oss-120b":[0.15,0.6,0.15],"gpt-oss-20b":[0.07,0.3,0.07],"grok-4-6":[2.0,6.0,0.5],"grok-4-7":[2.5,7.5,0.5],"inkling":[1.0,4.05,0.17],"kimi-k3":[3.0,15.0,0.3],"llama-4-maverick":[0.5,1.5,0.5],"meta-llama-3-1-8b-instruct":[0.15,0.45,0.15],"meta-llama-3-3-70b-instruct":[0.5,1.5,0.5],"qwen3-next-80b-a3b-instruct":[0.15,1.2,0.15],"qwen35-122b-a10b":[0.22,2.2,0.22]},"neosmith":{"neosmith.intelligent-basic":[1.17,4.37,0.22],"neosmith.intelligent-maestro":[2.4,12.0,0.35],"neosmith.intelligent-pro":[1.81,8.39,0.3],"neosmith.neolite":[0.6,2.4,0.08]},"neuralwatt":{"deepseek-v4-flash":[0.14,0.28,0.028],"deepseek-v4-flash-flex":[0.091,0.182,0.0182],"deepseek-v4-flash-speed":[0.14,0.28,0.028],"deepseek-v4.1-flash":[0.15,0.6,0.015],"deepseek-v4.1-flash-flex":[0.0975,0.39,0.00975],"gemma-4-31b":[0.144,0.42,0.0144],"glm-5.3":[1.45,4.5,0.145],"glm-5.3-flash":[0.15,0.5,0.03],"glm-5.3-flash-flex":[0.0975,0.325,0.0195],"glm-5.3-flex":[0.9425,2.925,0.09425],"kimi-k2.7-code":[0.95,4.0,0.095],"kimi-k2.7-code-fast":[0.95,4.0,0.095],"kimi-k2.7-code-flex":[0.6175,2.6,0.06175],"kimi-k3":[3.0,15.0,0.3],"kimi-k3-fast":[3.0,15.0,0.3],"kimi-k3-flex":[1.95,9.75,0.195],"mimo-v2.6-pro":[0.87,1.74,0.036],"mimo-v2.6-pro-flex":[0.5655,1.131,0.0234],"qwen-3.8-27b":[0.45,3.2,0.25],"qwen-3.8-27b-flex":[0.2925,2.08,0.1625],"qwen3.6-35b":[0.29,1.15,0.029],"qwen3.6-35b-fast":[0.29,1.15,0.029],"qwen3.6-35b-flex":[0.1885,0.7475,0.01885]},"nova":{"nova-2-lite-v1":[0.0,0.0],"nova-2-pro-v1":[0.0,0.0]},"novita-ai":{"apodex/apodex-1.1-mini":[0.0,0.0],"baai/bge-m3":[0.01,0.0,0.01],"baai/bge-reranker-v2-m3":[0.01,0.0,0.01],"baichuan/baichuan-m2-32b":[0.07,0.07,0.07],"baidu/cobuddy":[0.28,1.13,0.07],"baidu/ernie-4.5-21b-a3b":[0.07,0.28,0.07],"deepseek/deepseek-ocr-2":[0.03,0.03,0.03],"deepseek/deepseek-r1-0528":[0.7,2.5,0.35],"deepseek/deepseek-r1-0528-qwen3-8b":[0.06,0.09,0.06],"deepseek/deepseek-r1-turbo":[0.7,2.5,0.7],"deepseek/deepseek-v4-flash-0731":[0.44,1.32,0.028],"deepseek/deepseek-v4-pro":[1.6,3.2,0.135],"deepseek/deepseek-v4-pro-0813":[1.32,3.96,0.044],"deepseek/deepseek-v4.1-flash":[0.3,1.2,0.006],"deepseek/deepseek-v4.1-flash-1017":[0.3,1.2,0.006],"deepseek/deepseek_v3":[0.89,0.89,0.89],"google/gemma-3-12b-it":[0.05,0.1,0.05],"google/gemma-3-27b-it":[0.119,0.2,0.119],"google/gemma-4-26b-a4b-it":[0.13,0.4,0.13],"google/gemma-4-31b-it":[0.14,0.4,0.14],"gryphe/mythomax-l2-13b":[0.09,0.09,0.09],"inclusionai/ling-3.0-flash":[0.06,0.18,0.012],"inclusionai/ling-3.0-flash-fin":[0.075,0.22,0.015],"inclusionai/ling-3.0-flash-sante":[0.075,0.22,0.015],"inclusionai/ling-3.0-flash-vl":[0.075,0.22,0.015],"inclusionai/ling-3.1-flash":[0.3,0.9,0.06],"meta-llama/llama-3.1-8b-instruct":[0.02,0.05,0.02],"meta-llama/llama-3.2-1b-instruct":[0.02,0.02,0.02],"meta-llama/llama-3.3-70b-instruct":[0.135,0.4,0.135],"meta-llama/llama-4-maverick-17b-128e-instruct-fp8":[0.27,0.85,0.27],"meta-llama/llama-4-scout-17b-16e-instruct":[0.18,0.59,0.18],"microsoft/wizardlm-2-8x22b":[0.62,0.62,0.62],"mindai/macaron-v1-tall":[0.2475,1.43,0.044],"mindai/macaron-v1-venti":[0.825,2.475,0.165],"minimax/minimax-m2.5":[0.3,1.2,0.03],"minimax/minimax-m2.7":[0.3,1.2,0.06],"minimax/minimax-m2.7-highspeed":[0.6,2.4,0.06],"minimax/minimax-m3":[0.3,1.2,0.06],"minimax/minimax-m3.1-flash":[0.15,0.6,0.015],"minimaxai/minimax-m1-80k":[0.55,2.2,0.55],"moonshotai/kimi-k2-0905":[0.6,2.5,0.6],"moonshotai/kimi-k2-instruct":[0.57,2.3,0.57],"moonshotai/kimi-k2-thinking":[0.6,2.5,0.15],"moonshotai/kimi-k2.5":[0.6,3.0,0.1],"moonshotai/kimi-k2.6":[0.8,3.4,0.16],"moonshotai/kimi-k2.7-code":[0.95,4.0,0.19],"moonshotai/kimi-k3":[3.0,15.0,0.3],"moonshotai/kimi-k3.1-pro":[2.0,10.0,0.2],"moonshotai/kimi-k3.1-pro-highspeed":[4.0,20.0,0.2],"nousresearch/hermes-2-pro-llama-3-8b":[0.14,0.14,0.14],"nvidia/nemotron-3-nano-30b-a3b":[0.05,0.2,0.05],"openai/gpt-oss-120b":[0.05,0.25,0.05],"paddlepaddle/paddleocr-vl":[0.02,0.02,0.02],"qwen/qwen-mt-plus":[0.25,0.75,0.25],"qwen/qwen3-embedding-8b":[0.07,0.0,0.07],"qwen/qwen3-omni-30b-a3b-thinking":[0.25,0.97,0.25],"qwen/qwen3-reranker-8b":[0.05,0.0,0.05],"qwen/qwen3-vl-30b-a3b-instruct":[0.2,0.7,0.2],"qwen/qwen3.5-122b-a10b":[0.4,3.2,0.4],"qwen/qwen3.5-27b":[0.3,2.4,0.3],"qwen/qwen3.5-35b-a3b":[0.25,2.0,0.25],"qwen/qwen3.5-397b-a17b":[0.6,3.6,0.6],"qwen/qwen3.6-27b":[0.6,3.6,0.6],"qwen/qwen3.6-35b-a3b":[0.248,1.485,0.248],"qwen/qwen3.7-max":[1.25,3.75,0.25],"qwen/qwen3.8-2.4t-a95b":[2.0,6.0,0.25],"qwen/qwen3.8-27b":[0.42,3.0,0.085],"qwen/qwen3.8-flash":[0.15,0.47,0.016],"qwen/qwen3.8-max":[2.0,6.0,0.25],"stepfun/step-3.7-flash":[0.2,1.15,0.04],"stepfun/step-5-preview":[1.0,2.7,0.1],"tencent/hy3":[0.14,0.58,0.035],"tencent/hy4-preview":[0.834,2.501,0.042],"xiaomimimo/mimo-v2.5":[0.168,0.336,0.0034],"xiaomimimo/mimo-v2.5-pro":[0.522,1.044,0.0043],"xiaomimimo/mimo-v2.6-flash":[0.14,0.28,0.0028],"xiaomimimo/mimo-v2.6-pro":[0.435,0.87,0.0036],"zai-org/autoglm-phone-9b-multilingual":[0.035,0.138,0.035],"zai-org/glm-4.5-air":[0.13,0.85,0.025],"zai-org/glm-4.5v":[0.6,1.8,0.11],"zai-org/glm-4.6":[0.55,2.2,0.11],"zai-org/glm-4.6v":[0.3,0.9,0.055],"zai-org/glm-4.7":[0.6,2.2,0.11],"zai-org/glm-4.7-flash":[0.07,0.4,0.01],"zai-org/glm-5":[1.0,3.2,0.2],"zai-org/glm-5.1":[1.38,4.4,0.26],"zai-org/glm-5.2":[1.4,4.4,0.26],"zai-org/glm-5.3":[1.4,4.4,0.26],"zai-org/glm-5.3-flash":[0.15,0.5,0.03]},"nvidia":{"black-forest-labs/flux.1-dev":[0.0,0.0],"black-forest-labs/flux_1-kontext-dev":[0.0,0.0],"black-forest-labs/flux_1-schnell":[0.0,0.0],"black-forest-labs/flux_2-klein-4b":[0.0,0.0],"deepseek-ai/deepseek-v4.1-flash":[0.0,0.0],"google/diffusiongemma-26b-a4b-it":[0.0,0.0],"google/gemma-3-12b-it":[0.0,0.0],"google/gemma-3-4b-it":[0.0,0.0],"google/gemma-4-31b-it":[0.0,0.0],"google/google-paligemma":[0.0,0.0],"meta/llama-3.2-11b-vision-instruct":[0.0,0.0],"meta/llama-3.2-90b-vision-instruct":[0.0,0.0],"meta/llama-guard-4-12b":[0.0,0.0],"meta/muse-glimmer-30b":[0.0,0.0],"minimaxai/minimax-m3.1-flash":[0.0,0.0],"mistralai/magistral-small-2506":[0.0,0.0],"mistralai/mistral-7b-instruct-v0.3":[0.0,0.0],"mistralai/mistral-medium-3-instruct":[0.0,0.0],"moonshotai/kimi-k2.6":[0.0,0.0],"moonshotai/kimi-k3":[0.0,0.0],"nvidia/active-speaker-detection":[0.0,0.0],"nvidia/bevformer":[0.0,0.0],"nvidia/cosmos-reason2-8b":[0.0,0.0],"nvidia/cosmos-transfer2_5-2b":[0.0,0.0],"nvidia/llama-3.1-nemotron-70b-instruct":[0.0,0.0],"nvidia/llama-3.1-nemotron-safety-guard-8b-v3":[0.0,0.0],"nvidia/llama-3.1-nemotron-ultra-253b-v1":[0.0,0.0],"nvidia/llama-nemotron-embed-vl-1b-v2":[0.0,0.0],"nvidia/llama-nemotron-rerank-vl-1b-v2":[0.0,0.0],"nvidia/magpie-tts-zeroshot":[0.0,0.0],"nvidia/nemotron-3-nano-omni-30b-a3b-reasoning":[0.0,0.0],"nvidia/nemotron-3-ultra-550b-a55b":[0.0,0.0],"nvidia/nemotron-3.5-content-safety":[0.0,0.0],"nvidia/nemotron-3.5-lightning-30b-a3b":[0.0,0.0],"nvidia/nemotron-3.5-super-vl-120b-a12b":[0.0,0.0],"nvidia/nemotron-voicechat":[0.0,0.0],"nvidia/rerank-qa-mistral-4b":[0.0,0.0],"nvidia/riva-translate-4b-instruct-v1.1":[0.0,0.0],"nvidia/sparsedrive":[0.0,0.0],"nvidia/streampetr":[0.0,0.0],"nvidia/studiovoice":[0.0,0.0],"nvidia/synthetic-video-detector":[0.0,0.0],"nvidia/usdcode":[0.0,0.0],"nvidia/usdvalidate":[0.0,0.0],"openai/gpt-oss-20b":[0.0,0.0],"openai/whisper-large-v3":[0.0,0.0],"poolside/laguna-xs-2.1":[0.0,0.0],"qwen/qwen-image":[0.0,0.0],"qwen/qwen-image-edit":[0.0,0.0],"stepfun-ai/step-5-preview":[0.0,0.0],"z-ai/glm-5.3":[0.0,0.0],"z-ai/glm-5.3-flash":[0.0,0.0]},"oci":{"meta.llama-3.3-70b-instruct":[0.72,0.72,0.72],"meta.llama-4-maverick-17b-128e-instruct-fp8":[0.72,0.72,0.72],"meta.llama-4-scout-17b-16e-instruct":[0.72,0.72,0.72],"openai.gpt-oss-120b":[0.15,0.6,0.15],"openai.gpt-oss-20b":[0.07,0.3,0.07],"xai.grok-4.20-non-reasoning":[1.25,2.5,0.2],"xai.grok-4.20-reasoning":[1.25,2.5,0.2],"xai.grok-4.3":[1.25,2.5,0.2],"xai.grok-4.6":[2.0,6.0,0.5]},"ofox":{"anthropic/claude-fable-5":[10.0,50.0,1.0],"anthropic/claude-fable-5.1":[10.0,50.0,0.25],"anthropic/claude-haiku-4.5":[1.0,5.0,0.1],"anthropic/claude-haiku-5.5":[0.1,0.5,0.01],"anthropic/claude-opus-4.5":[5.0,25.0,0.5],"anthropic/claude-opus-4.6":[5.0,25.0,0.5],"anthropic/claude-opus-4.7":[5.0,25.0,0.5],"anthropic/claude-opus-4.8":[5.0,25.0,0.5],"anthropic/claude-opus-5":[5.0,25.0,0.5],"anthropic/claude-opus-5.5":[4.0,20.0,0.2],"anthropic/claude-sonnet-4.5":[3.0,15.0,0.3],"anthropic/claude-sonnet-4.6":[3.0,15.0,0.3],"anthropic/claude-sonnet-5":[2.0,10.0,0.2],"anthropic/claude-sonnet-5.5":[2.0,10.0,0.2],"bailian/qwen-flash":[0.022,0.22,0.0043],"bailian/qwen-max":[0.35,1.38,0.069],"bailian/qwen-plus":[0.12,0.29,0.023],"bailian/qwen-turbo":[0.05,0.09,0.0086],"bailian/qwen-vl-max":[0.23,0.58,0.046],"bailian/qwen3-coder-flash":[0.5,2.5,0.06],"bailian/qwen3-coder-next":[0.2,1.5,0.2],"bailian/qwen3-coder-plus":[1.8,9.0,0.2],"bailian/qwen3-max":[0.36,1.43,0.072],"bailian/qwen3.5-122b-a10b":[0.29,2.29,0.29],"bailian/qwen3.5-27b":[0.29,2.05,0.29],"bailian/qwen3.5-35b-a3b":[0.29,1.83,0.29],"bailian/qwen3.5-397b-a17b":[0.55,3.5,0.55],"bailian/qwen3.5-flash":[0.1,0.4,0.01],"bailian/qwen3.5-plus":[0.4,2.4,0.04],"bailian/qwen3.6-27b":[0.6,3.6,0.6],"bailian/qwen3.6-flash":[0.25,1.5,0.025],"bailian/qwen3.6-max-preview":[2.15,12.86,0.2],"bailian/qwen3.6-plus":[0.5,3.0,0.05],"bailian/qwen3.7-max":[2.5,7.5,0.5],"bailian/qwen3.7-plus":[0.4,1.6,0.08],"bailian/qwen3.8-27b":[0.45,3.2,0.05],"bailian/qwen3.8-flash":[0.15,0.47,0.016],"bailian/qwen3.8-max":[2.0,6.0,0.25],"bailian/qwen3.8-max-0902":[2.0,6.0,0.25],"deepseek/deepseek-v3.2":[0.29,0.43,0.06],"deepseek/deepseek-v4-flash":[0.44,1.32,0.014],"deepseek/deepseek-v4-flash-0423":[0.19,0.51,0.028],"deepseek/deepseek-v4-flash-0731":[0.44,1.32,0.014],"deepseek/deepseek-v4-pro":[1.32,3.96,0.044],"deepseek/deepseek-v4-pro-0423":[1.74,3.48,0.145],"deepseek/deepseek-v4-pro-0813":[1.32,3.96,0.044],"deepseek/deepseek-v4.1-flash":[0.3,1.2,0.006],"deepseek/deepseek-v4.1-flash-1017":[0.3,1.2,0.006],"google/gemini-2.5-flash":[0.3,2.5,0.03],"google/gemini-2.5-flash-lite":[0.1,0.4,0.01],"google/gemini-2.5-pro":[1.25,10.0,0.125],"google/gemini-3-flash-preview":[0.5,3.0,0.05],"google/gemini-3.1-flash-lite":[0.25,1.5,0.025],"google/gemini-3.1-pro-preview":[2.0,12.0,0.2],"google/gemini-3.5-flash":[1.5,9.0,0.15],"google/gemini-3.5-flash-lite":[0.3,2.5,0.03],"google/gemini-3.6-flash":[0.75,3.75,0.075],"google/gemini-3.7-flash":[0.75,3.75,0.075],"google/gemini-3.8-flash":[0.75,3.75,0.075],"google/gemini-4-argon":[2.0,10.0,0.1],"minimax/m2-her":[0.3,1.2,0.3],"minimax/minimax-m2":[0.3,1.2,0.03],"minimax/minimax-m2.1":[0.3,1.2,0.03],"minimax/minimax-m2.1-lightning":[0.3,2.4,0.03],"minimax/minimax-m2.5":[0.3,1.2,0.03],"minimax/minimax-m2.5-lightning":[0.3,2.4,0.03],"minimax/minimax-m2.7":[0.3,1.2,0.06],"minimax/minimax-m2.7-highspeed":[0.6,2.4,0.06],"minimax/minimax-m3":[0.6,2.4,0.12],"moonshotai/kimi-k2.6":[0.95,4.0,0.16],"moonshotai/kimi-k2.7-code":[0.95,4.0,0.19],"moonshotai/kimi-k2.7-code-highspeed":[1.9,8.0,0.38],"moonshotai/kimi-k3":[3.0,15.0,0.3],"moonshotai/kimi-k3.1-pro":[2.0,11.0,0.2],"openai/gpt-4.1":[2.0,8.0,0.5],"openai/gpt-4.1-mini":[0.4,1.6,0.1],"openai/gpt-4o":[2.5,10.0,1.25],"openai/gpt-4o-mini":[0.15,0.6,0.075],"openai/gpt-5":[1.25,10.0,0.13],"openai/gpt-5-mini":[0.25,2.0,0.03],"openai/gpt-5-nano":[0.05,0.4,0.01],"openai/gpt-5.1":[1.25,10.0,0.13],"openai/gpt-5.1-codex-max":[1.25,10.0,0.13],"openai/gpt-5.1-codex-mini":[0.25,2.0,0.03],"openai/gpt-5.2":[1.75,14.0,0.18],"openai/gpt-5.2-codex":[1.75,14.0,0.18],"openai/gpt-5.3-codex":[1.75,14.0,0.18],"openai/gpt-5.4":[2.5,15.0,0.25],"openai/gpt-5.4-mini":[0.75,4.5,0.075],"openai/gpt-5.4-nano":[0.2,1.25,0.02],"openai/gpt-5.4-pro":[30.0,180.0,30.0],"openai/gpt-5.5":[5.0,30.0,0.5],"openai/gpt-5.6-luna":[0.2,1.2,0.02],"openai/gpt-5.6-sol":[2.5,15.0,0.25],"openai/gpt-5.6-terra":[2.0,12.0,0.2],"openai/gpt-6-astra":[10.0,50.0,1.0],"openai/gpt-6-luna":[0.1,0.5,0.01],"openai/gpt-6-sol":[2.0,10.0,0.2],"openai/gpt-6.1-sol":[2.0,10.0,0.1],"openai/gpt-6.1-terra":[1.0,5.0,0.05],"qwen/qwen-flash":[0.022,0.22,0.0043],"qwen/qwen-max":[0.35,1.38,0.069],"qwen/qwen-plus":[0.12,0.29,0.023],"qwen/qwen-turbo":[0.043,0.09,0.0086],"qwen/qwen-vl-max":[0.23,0.58,0.023],"qwen/qwen3-coder-flash":[0.5,2.5,0.06],"qwen/qwen3-coder-next":[0.2,1.5,0.2],"qwen/qwen3-coder-plus":[1.8,9.0,0.2],"qwen/qwen3-max":[0.36,1.43,0.072],"qwen/qwen3.5-122b-a10b":[0.29,2.29,0.29],"qwen/qwen3.5-27b":[0.29,2.05,0.29],"qwen/qwen3.5-35b-a3b":[0.29,1.83,0.29],"qwen/qwen3.5-397b-a17b":[0.55,3.5,0.55],"qwen/qwen3.5-flash":[0.1,0.4,0.01],"qwen/qwen3.5-plus":[0.4,2.4,0.04],"qwen/qwen3.6-27b":[0.43,2.57,0.43],"qwen/qwen3.6-flash":[0.25,1.5,0.025],"qwen/qwen3.6-max-preview":[2.15,12.86,0.2],"qwen/qwen3.6-plus":[0.5,3.0,0.05],"qwen/qwen3.7-max":[1.71,5.14,0.17],"qwen/qwen3.7-plus":[0.4,1.6,0.08],"qwen/qwen3.8-27b":[0.5,1.71,0.043],"qwen/qwen3.8-flash":[0.11,0.39,0.011],"qwen/qwen3.8-max":[1.71,5.14,0.17],"qwen/qwen3.8-max-0902":[1.71,5.14,0.17],"volcengine/doubao-seed-2.0-code":[0.67,3.36,0.14],"volcengine/doubao-seed-2.0-lite":[0.13,0.76,0.03],"volcengine/doubao-seed-2.0-mini":[0.06,0.56,0.02],"volcengine/doubao-seed-2.0-pro":[0.67,3.36,0.14],"volcengine/doubao-seed-2.1-pro":[0.7072,3.536,0.1416],"volcengine/doubao-seed-2.1-turbo":[0.3536,1.7696,0.068],"volcengine/doubao-seed-character":[0.177,0.884,0.024],"volcengine/doubao-seed-evolving":[0.884,4.42,0.177],"x-ai/grok-4.1-fast":[0.2,0.5,0.05],"x-ai/grok-4.20":[4.0,12.0,0.4],"x-ai/grok-4.3":[1.25,2.5,0.2],"x-ai/grok-4.5":[2.0,6.0,0.3],"x-ai/grok-4.6":[2.0,6.0,0.5],"x-ai/grok-4.7":[2.0,6.0,0.5],"z-ai/glm-4.6":[0.6,2.2,0.11],"z-ai/glm-4.7":[0.4,2.2,0.11],"z-ai/glm-4.7-flashx":[0.072,0.4,0.01],"z-ai/glm-5":[1.0,3.2,0.2],"z-ai/glm-5-turbo":[1.2,4.0,0.24],"z-ai/glm-5.1":[1.4,4.4,0.26],"z-ai/glm-5.2":[1.4,4.4,0.26],"z-ai/glm-5.3":[1.4,4.4,0.26],"z-ai/glm-5.3-flash":[0.15,0.5,0.03],"z-ai/glm-5.3-flashx":[0.15,0.5,0.03],"z-ai/glm-5v-turbo":[1.2,4.0,0.24]},"ollama-cloud":{"deepseek-v4-pro":[0.66,1.98,0.022],"deepseek-v4-pro:0813":[0.66,1.98,0.022],"deepseek-v4.1-flash":[0.15,0.6,0.003],"deepseek-v4.1-flash:1017":[0.15,0.6,0.003],"gemma4:31b":[0.14,0.4,0.05],"glm-5.2":[1.4,4.4,0.26],"glm-5.3":[1.4,4.4,0.26],"glm-5.3-flash":[0.15,0.5,0.03],"gpt-oss:120b":[0.15,0.6,0.014],"gpt-oss:20b":[0.07,0.3,0.035],"kimi-k2.6":[0.95,4.0,0.16],"kimi-k2.7-code":[0.95,4.0,0.19],"kimi-k3":[3.0,15.0,0.3],"minimax-m2.7":[0.3,1.2,0.06],"minimax-m3":[0.6,2.4,0.12],"minimax-m3.1-flash":[0.15,0.6,0.015],"mistral-large-3:675b":[0.5,1.5,0.5],"mistral-large-4":[0.68,2.09,0.07],"muse-spark-open":[1.25,4.25,0.15],"nemotron-3-nano:30b":[0.06,0.24,0.06],"nemotron-3-super":[0.015,0.6,0.015],"nemotron-3-ultra":[0.1,3.0,0.1]},"openai":{"gpt-3.5-turbo":[0.5,1.5],"gpt-4":[30.0,60.0,30.0],"gpt-4-turbo":[10.0,30.0,10.0],"gpt-4.1":[2.0,8.0,0.5],"gpt-4.1-mini":[0.4,1.6,0.1],"gpt-4.1-nano":[0.1,0.4,0.025],"gpt-4o":[2.5,10.0,1.25],"gpt-4o-2024-05-13":[5.0,15.0,5.0],"gpt-4o-2024-08-06":[2.5,10.0,1.25],"gpt-4o-2024-11-20":[2.5,10.0,1.25],"gpt-4o-mini":[0.15,0.6,0.075],"gpt-5":[1.25,10.0,0.125],"gpt-5-mini":[0.25,2.0,0.025],"gpt-5-nano":[0.05,0.4,0.005],"gpt-5-pro":[15.0,120.0,15.0],"gpt-5.1":[1.25,10.0,0.125],"gpt-5.2":[1.75,14.0,0.175],"gpt-5.2-pro":[21.0,168.0,21.0],"gpt-5.3-codex":[1.75,14.0,0.175],"gpt-5.3-codex-spark":[1.75,14.0,0.175],"gpt-5.4":[2.5,15.0,0.25],"gpt-5.4-mini":[0.75,4.5,0.075],"gpt-5.4-nano":[0.2,1.25,0.02],"gpt-5.4-pro":[30.0,180.0,30.0],"gpt-5.5":[5.0,30.0,0.5],"gpt-5.5-pro":[30.0,180.0,30.0],"gpt-5.6":[4.0,20.0,0.4],"gpt-5.6-luna":[0.2,1.2,0.02],"gpt-5.6-sol":[4.0,20.0,0.4],"gpt-5.6-terra":[2.0,12.0,0.2],"gpt-6-astra":[10.0,50.0,1.0],"gpt-6-luna":[0.1,0.5,0.01],"gpt-6-sol":[2.0,10.0,0.2],"gpt-6.1-sol":[2.0,10.0,0.1],"gpt-6.1-terra":[1.0,5.0,0.05],"gpt-daybreak-blue-latest":[4.0,20.0,0.4],"gpt-daybreak-red-latest":[12.5,75.0,1.25],"gpt-image-2":[5.0,30.0,1.25],"gpt-realtime-2.1":[4.0,24.0,0.4],"o1":[15.0,60.0,7.5],"o1-pro":[150.0,600.0,150.0],"o3":[2.0,8.0,0.5],"o3-mini":[1.1,4.4,0.55],"o3-pro":[20.0,80.0,20.0],"o4-mini":[1.1,4.4,0.275],"text-embedding-3-large":[0.13,0.0,0.13],"text-embedding-3-small":[0.02,0.0,0.02],"text-embedding-ada-002":[0.1,0.0,0.1]},"opencode":{"beam-free":[0.0,0.0],"big-pickle":[0.0,0.0],"cat-jam-free":[0.0,0.0],"claude-3-5-haiku":[0.8,4.0,0.08],"claude-fable-5":[10.0,50.0,1.0],"claude-fable-5-1":[10.0,50.0,0.25],"claude-haiku-4-5":[1.0,5.0,0.1],"claude-haiku-5-5":[0.1,0.5,0.01],"claude-opus-4-1":[15.0,75.0,1.5],"claude-opus-4-5":[5.0,25.0,0.5],"claude-opus-4-6":[5.0,25.0,0.5],"claude-opus-4-7":[5.0,25.0,0.5],"claude-opus-4-8":[5.0,25.0,0.5],"claude-opus-5":[5.0,25.0,0.5],"claude-opus-5-5":[4.0,20.0,0.2],"claude-sonnet-4":[3.0,15.0,0.3],"claude-sonnet-4-5":[3.0,15.0,0.3],"claude-sonnet-4-6":[3.0,15.0,0.3],"claude-sonnet-5":[2.0,10.0,0.2],"claude-sonnet-5-5":[2.0,10.0,0.2],"deepseek-v4-flash":[0.14,0.28,0.028],"deepseek-v4-flash-free":[0.0,0.0],"deepseek-v4-flash-vision-exp":[0.14,0.28,0.028],"deepseek-v4-pro":[1.74,3.48,0.145],"deepseek-v4.1-flash":[0.3,1.2,0.006],"deepseek-v4.1-flash-free":[0.0,0.0],"exo-free":[0.0,0.0],"fledge-alpha-free":[0.0,0.0],"flint-40b-free":[0.0,0.0],"gemini-3-flash":[0.5,3.0,0.05],"gemini-3-pro":[2.0,12.0,0.2],"gemini-3.1-pro":[2.0,12.0,0.2],"gemini-3.5-flash":[1.5,9.0,0.15],"gemini-3.5-flash-lite":[0.3,2.5,0.03],"gemini-3.6-flash":[1.5,7.5,0.15],"gemini-3.7-flash":[1.5,7.5,0.15],"gemini-3.8-flash":[1.5,7.5,0.15],"gemini-4-argon":[2.0,10.0,0.1],"glm-4.6":[0.6,2.2,0.1],"glm-4.7":[0.6,2.2,0.1],"glm-4.7-free":[0.0,0.0],"glm-5":[1.0,3.2,0.2],"glm-5-free":[0.0,0.0],"glm-5.1":[1.4,4.4,0.26],"glm-5.2":[1.4,4.4,0.26],"glm-5.3":[1.4,4.4,0.26],"glm-5.3-flash":[0.15,0.5,0.03],"glm-5.3-flash-free":[0.0,0.0],"gpt-5":[1.07,8.5,0.107],"gpt-5-codex":[1.07,8.5,0.107],"gpt-5-nano":[0.05,0.4,0.005],"gpt-5.1":[1.07,8.5,0.107],"gpt-5.1-codex":[1.07,8.5,0.107],"gpt-5.1-codex-max":[1.25,10.0,0.125],"gpt-5.1-codex-mini":[0.25,2.0,0.025],"gpt-5.2":[1.75,14.0,0.175],"gpt-5.2-codex":[1.75,14.0,0.175],"gpt-5.3-codex":[1.75,14.0,0.175],"gpt-5.3-codex-spark":[1.75,14.0,0.175],"gpt-5.4":[2.5,15.0,0.25],"gpt-5.4-mini":[0.75,4.5,0.075],"gpt-5.4-nano":[0.2,1.25,0.02],"gpt-5.4-pro":[30.0,180.0,30.0],"gpt-5.5":[5.0,30.0,0.5],"gpt-5.5-pro":[30.0,180.0,30.0],"gpt-5.6-luna":[0.2,1.2,0.02],"gpt-5.6-sol":[4.0,20.0,0.4],"gpt-5.6-terra":[2.0,12.0,0.2],"gpt-6-astra":[10.0,50.0,1.0],"gpt-6-luna":[0.1,0.5,0.01],"gpt-6-sol":[2.0,10.0,0.2],"gpt-6.1-sol":[2.0,10.0,0.1],"grok-4.5":[2.0,6.0,0.3],"grok-4.6":[2.0,6.0,0.5],"grok-4.7":[2.0,6.0,0.5],"grok-build-0.1":[1.0,2.0,0.2],"grok-code":[0.0,0.0],"hy3-free":[0.0,0.0],"hy3-preview-free":[0.0,0.0],"kimi-k2":[0.4,2.5,0.4],"kimi-k2-thinking":[0.4,2.5,0.4],"kimi-k2.5":[0.6,3.0,0.1],"kimi-k2.5-free":[0.0,0.0],"kimi-k2.6":[0.95,4.0,0.16],"kimi-k2.7-code":[0.95,4.0,0.19],"kimi-k3":[3.0,15.0,0.3],"laguna-s-2.1-free":[0.0,0.0],"ling-2.6-flash-free":[0.0,0.0],"ling-3.0-flash-fin-free":[0.0,0.0],"ling-3.0-flash-free":[0.0,0.0],"ling-3.0-tiny-free":[0.0,0.0],"ling-3.1-flash-free":[0.0,0.0],"ll-alpha-free":[0.0,0.0],"longcat-2.0-free":[0.0,0.0],"longcat-2.5-preview-free":[0.0,0.0],"mimo-v2-flash-free":[0.0,0.0],"mimo-v2-omni-free":[0.0,0.0],"mimo-v2-pro-free":[0.0,0.0],"mimo-v2.5-free":[0.0,0.0],"mimo-v2.6-flash-free":[0.0,0.0],"minimax-m2.1":[0.3,1.2,0.1],"minimax-m2.1-free":[0.0,0.0],"minimax-m2.5":[0.3,1.2,0.06],"minimax-m2.5-free":[0.0,0.0],"minimax-m2.7":[0.3,1.2,0.06],"minimax-m3":[0.3,1.2,0.06],"minimax-m3-free":[0.0,0.0],"minimax-m3.1-flash-free":[0.0,0.0],"mistral-large-4":[0.68,2.09,0.07],"muse-spark-1.2":[1.25,4.25,0.15],"muse-spark-1.2-contributor-free":[0.0,0.0],"muse-spark-1.3":[1.25,4.25,0.15],"muse-spark-1.3-contributor-free":[0.0,0.0],"muse-wonder-1.0":[4.0,20.0,0.2],"nemotron-3-super-free":[0.0,0.0],"nemotron-3-ultra-free":[0.0,0.0],"nemotron-3.5-lightning-free":[0.0,0.0],"nemotron-3.5-super-vl-free":[0.0,0.0],"north-mini-code-free":[0.0,0.0],"qwen3-coder":[0.45,1.8,0.45],"qwen3.5-plus":[0.2,1.2,0.02],"qwen3.6-plus":[0.5,3.0,0.05],"qwen3.6-plus-free":[0.0,0.0],"qwen3.8-flash":[0.15,0.47,0.016],"qwen3.8-max":[2.0,6.0,0.25],"ring-2.6-1t-free":[0.0,0.0],"space-bunny-free":[0.0,0.0],"step-5-preview-free":[0.0,0.0],"trinity-large-preview-free":[0.0,0.0],"x-preview-f-free":[0.0,0.0]},"opencode-go":{"beam-free":[0.0,0.0],"cat-jam-free":[0.0,0.0],"claude-haiku-5-5":[0.1,0.5,0.01],"deepseek-v4-pro":[0.66,1.98,0.022],"deepseek-v4.1-flash":[0.15,0.6,0.003],"gemini-4-argon":[2.0,10.0,0.1],"gemini-4-argon-contributor":[4.0,20.0,0.2],"glm-5.2":[1.4,4.4,0.26],"glm-5.3":[1.4,4.4,0.26],"glm-5.3-flash":[0.15,0.5,0.03],"gpt-5.6-luna":[0.2,1.2,0.02],"gpt-6-luna":[0.1,0.5,0.01],"grok-4.7":[2.0,6.0,0.5],"hy3":[0.14,0.58,0.035],"hy4-preview":[0.834,2.501,0.042],"iceman-contributor-free":[0.0,0.0],"kimi-k2.7-code":[0.95,4.0,0.19],"kimi-k3":[3.0,15.0,0.3],"kimi-k3.1-pro":[2.0,10.0,0.2],"longcat-2.0":[0.3,1.2,0.006],"longcat-2.5-preview-free":[0.0,0.0],"mimo-v2.5":[0.14,0.28,0.0028],"mimo-v2.5-pro":[0.435,0.87,0.003625],"mimo-v2.6-flash":[0.14,0.28,0.0028],"mimo-v2.6-pro":[0.435,0.87,0.003625],"minimax-m2.7":[0.3,1.2,0.06],"minimax-m3":[0.3,1.2,0.06],"minimax-m3.1-flash":[0.15,0.6,0.015],"minimax-m3.1-flash-free":[0.0,0.0],"muse-spark-1.2-contributor":[0.1,0.2,0.002],"muse-spark-1.3-contributor":[0.1,0.2,0.002],"qwen3.7-plus":[0.4,1.6,0.04],"qwen3.8-flash":[0.15,0.47,0.016],"qwen3.8-max":[2.0,6.0,0.25],"space-bunny":[0.15,0.6,0.03],"step-5-preview":[1.0,2.7,0.1],"step-5-preview-free":[0.0,0.0]},"openreason":{"deepseek-ai/deepseek-v4-flash-0731":[0.1371,0.2743,0.1371],"moonshotai/kimi-k2.7-code":[1.0022,4.22,1.0022],"openai/gpt-oss-120b":[0.1055,0.422,0.1055]},"openrouter":{"aion-labs/aion-2.0":[0.8,1.6,0.2],"aion-labs/aion-3.0":[3.0,6.0,0.75],"aion-labs/aion-3.0-mini":[0.7,1.4,0.18],"aion-labs/aion-3.5":[3.0,6.0,0.75],"aion-labs/aion-3.5-mini":[0.7,1.4,0.18],"aion-labs/aion-rp-llama-3.1-8b":[0.8,1.6,0.8],"amazon/nova-2-lite-v1":[0.3,2.5,0.3],"amazon/nova-lite-v1":[0.06,0.24,0.06],"amazon/nova-micro-v1":[0.035,0.14,0.035],"amazon/nova-premier-v1":[2.5,12.5,0.625],"amazon/nova-pro-v1":[0.8,3.2,0.8],"anthracite-org/magnum-v4-72b":[2.5,5.0,2.5],"anthropic/claude-fable-5":[10.0,50.0,1.0],"anthropic/claude-fable-5.1":[10.0,50.0,0.25],"anthropic/claude-haiku-4.5":[1.0,5.0,0.1],"anthropic/claude-haiku-5.5":[0.1,0.5,0.01],"anthropic/claude-opus-4.1":[15.0,75.0,1.5],"anthropic/claude-opus-4.5":[5.0,25.0,0.5],"anthropic/claude-opus-4.6":[5.0,25.0,0.5],"anthropic/claude-opus-4.7":[5.0,25.0,0.5],"anthropic/claude-opus-4.8":[5.0,25.0,0.5],"anthropic/claude-opus-5":[5.0,25.0,0.5],"anthropic/claude-opus-5.5":[4.0,20.0,0.2],"anthropic/claude-sonnet-4.5":[3.0,15.0,0.3],"anthropic/claude-sonnet-4.6":[3.0,15.0,0.3],"anthropic/claude-sonnet-5":[2.0,10.0,0.2],"anthropic/claude-sonnet-5.5":[2.0,10.0,0.1],"bytedance-seed/seed-1.6":[0.25,2.0,0.25],"bytedance-seed/seed-1.6-flash":[0.075,0.3,0.075],"bytedance-seed/seed-2-1-turbo":[0.5,2.5,0.5],"bytedance-seed/seed-2.0-code":[0.5,3.0,0.5],"bytedance-seed/seed-2.0-lite":[0.25,2.0,0.25],"bytedance-seed/seed-2.0-mini":[0.1,0.4,0.1],"bytedance/ui-tars-1.5-7b":[0.1,0.2,0.1],"cognitivecomputations/dolphin-mistral-24b-venice-edition":[0.2,0.9,0.2],"cohere/command-a":[2.5,10.0,2.5],"cohere/command-a-plus":[0.3,1.5,0.15],"cohere/command-r-08-2024":[0.15,0.6,0.15],"cohere/command-r-plus-08-2024":[2.5,10.0,2.5],"cohere/command-r7b-12-2024":[0.0375,0.15,0.0375],"cohere/north-mini-code:free":[0.0,0.0],"deepseek/deepseek-chat":[0.2574,1.0287,0.2574],"deepseek/deepseek-chat-v3-0324":[0.29,1.14,0.11],"deepseek/deepseek-chat-v3.1":[0.25,0.95,0.13],"deepseek/deepseek-r1-0528":[0.5,2.15,0.35],"deepseek/deepseek-v3.1-terminus":[0.27,1.0,0.27],"deepseek/deepseek-v3.2":[0.28,0.42,0.028],"deepseek/deepseek-v3.2-exp":[0.27,0.41,0.27],"deepseek/deepseek-v4-flash":[0.091,0.182,0.0182],"deepseek/deepseek-v4-flash-0731":[0.119,0.238,0.0238],"deepseek/deepseek-v4-flash-vision-exp":[0.2156,0.6468,0.00686],"deepseek/deepseek-v4-pro":[0.95526,1.91052,0.079605],"deepseek/deepseek-v4-pro-0813":[0.66,1.98,0.022],"deepseek/deepseek-v4.1-flash":[0.045,0.5,0.006],"deepseek/deepseek-v4.1-flash-1017":[0.15,0.6,0.003],"dots-studio/dots-3-note-preview:free":[0.0,0.0],"elorian/glimpse":[0.6,3.0,0.06],"fireworks/ember-1":[3.0,15.0,0.3],"google/gemini-2.5-flash":[0.3,2.5,0.03],"google/gemini-2.5-flash-image":[0.3,2.5,0.03],"google/gemini-2.5-flash-lite":[0.1,0.4,0.01],"google/gemini-2.5-pro":[1.25,10.0,0.125],"google/gemini-2.5-pro-preview":[1.25,10.0,0.125],"google/gemini-3-flash-preview":[0.5,3.0,0.05],"google/gemini-3-pro-image":[2.0,12.0,0.2],"google/gemini-3-pro-image-preview":[2.0,12.0,0.2],"google/gemini-3.1-flash-image":[0.5,3.0,0.5],"google/gemini-3.1-flash-image-preview":[0.5,3.0,0.5],"google/gemini-3.1-flash-lite":[0.25,1.5,0.025],"google/gemini-3.1-flash-lite-image":[0.25,1.5,0.25],"google/gemini-3.1-flash-lite-preview":[0.25,1.5,0.025],"google/gemini-3.1-pro-preview":[2.0,12.0,0.2],"google/gemini-3.1-pro-preview-customtools":[2.0,12.0,0.2],"google/gemini-3.5-flash":[1.5,9.0,0.15],"google/gemini-3.5-flash-lite":[0.3,2.5,0.03],"google/gemini-3.6-flash":[0.75,3.75,0.075],"google/gemini-3.7-flash":[0.75,3.75,0.075],"google/gemini-3.8-flash":[0.75,3.75,0.075],"google/gemini-4-argon":[2.0,10.0,0.1],"google/gemini-nano-banana-2.1":[1.5,7.5,1.5],"google/gemma-2-27b-it":[0.65,0.65,0.65],"google/gemma-3-12b-it":[0.05,0.15,0.05],"google/gemma-3-27b-it":[0.08,0.35,0.04],"google/gemma-3-4b-it":[0.05,0.1,0.05],"google/gemma-4-26b-a4b-it":[0.09,0.3,0.05],"google/gemma-4-26b-a4b-it:free":[0.0,0.0],"google/gemma-4-31b-it":[0.2,0.4,0.2],"google/gemma-4-31b-it:free":[0.0,0.0],"google/lyria-3-clip-preview":[0.0,0.0],"google/lyria-3-pro-preview":[0.0,0.0],"gryphe/mythomax-l2-13b":[0.08,0.11,0.08],"ibm-granite/granite-4.2-8b":[0.06,0.15,0.015],"inception/mercury-2":[0.25,0.75,0.025],"inception/mercury-2.5":[0.04,0.15,0.004],"inception/mercury-3":[0.1,0.35,0.01],"inclusionai/ling-3.0-flash":[0.021,0.063,0.0042],"inclusionai/ling-3.0-flash-vl":[0.06,0.18,0.012],"inclusionai/ling-3.1-flash":[0.075,0.225,0.015],"inference-net/schematron-v2-small":[0.05,0.23,0.05],"inference-net/schematron-v2-turbo":[0.03,0.15,0.03],"liquid/lfm-2.5-2.6b":[0.35,0.5,0.04],"liquid/lfm-2.5-2.6b:free":[0.0,0.0],"liquid/lfm-2.5-24b-a2b":[0.05,0.7,0.025],"mancer/weaver":[0.4,0.75,0.4],"meituan/longcat-2.0":[0.3,1.2,0.006],"meta-llama/llama-3.1-70b-instruct":[0.4,0.4,0.4],"meta-llama/llama-3.1-8b-instruct":[0.05,0.08,0.025],"meta-llama/llama-3.2-1b-instruct":[0.027,0.201,0.027],"meta-llama/llama-3.2-3b-instruct":[0.05,0.33,0.05],"meta-llama/llama-3.3-70b-instruct":[0.1,0.32,0.1],"meta-llama/llama-4-maverick":[0.1875,0.6525,0.05],"meta-llama/llama-4-scout":[0.1,0.3,0.1],"meta-llama/llama-guard-4-12b":[0.18,0.18,0.18],"meta/muse-glimmer-30b":[0.3,1.2,0.04],"meta/muse-spark-1.1":[1.25,4.25,0.15],"meta/muse-spark-1.2":[1.25,4.25,0.15],"meta/muse-spark-1.2-contributor":[0.1,0.2,0.002],"meta/muse-spark-1.3":[1.25,4.25,0.15],"meta/muse-spark-1.3-contributor":[0.1,0.2,0.002],"meta/muse-spark-open":[1.25,4.25,0.15],"meta/muse-wonder":[4.0,20.0,0.2],"microsoft/phi-4":[0.07,0.14,0.07],"minimax/minimax-01":[0.2,1.1,0.2],"minimax/minimax-m1":[0.55,2.2,0.55],"minimax/minimax-m2":[0.255,1.02,0.255],"minimax/minimax-m2-her":[0.3,1.2,0.03],"minimax/minimax-m2.1":[0.3,1.2,0.03],"minimax/minimax-m2.5":[0.3,1.2,0.03],"minimax/minimax-m2.7":[0.3,1.2,0.06],"minimax/minimax-m3":[0.3,1.2,0.06],"minimax/minimax-m3.1-flash":[0.15,0.6,0.015],"mistralai/codestral-2508":[0.3,0.9,0.03],"mistralai/devstral-2512":[0.4,2.0,0.04],"mistralai/ministral-14b-2512":[0.2,0.2,0.02],"mistralai/ministral-3b-2512":[0.1,0.1,0.01],"mistralai/ministral-8b-2512":[0.15,0.15,0.015],"mistralai/mistral-large":[2.0,6.0,0.2],"mistralai/mistral-large-2407":[2.0,6.0,0.2],"mistralai/mistral-large-2512":[0.5,1.5,0.05],"mistralai/mistral-large-4-0":[1.36,4.18,0.14],"mistralai/mistral-medium-3":[0.4,2.0,0.04],"mistralai/mistral-medium-3-5":[1.5,7.5,1.5],"mistralai/mistral-medium-3.1":[0.4,2.0,0.04],"mistralai/mistral-nemo":[0.029,0.03,0.029],"mistralai/mistral-saba":[0.2,0.6,0.02],"mistralai/mistral-small-24b-instruct-2501":[0.05,0.08,0.05],"mistralai/mistral-small-2603":[0.15,0.6,0.015],"mistralai/mistral-small-3.1-24b-instruct":[0.351,0.555,0.351],"mistralai/mistral-small-3.2-24b-instruct":[0.075,0.2,0.075],"mistralai/mixtral-8x22b-instruct":[2.0,6.0,0.2],"mistralai/voxtral-small-24b-2507":[0.1,0.3,0.01],"moondream/moondream3-preview":[0.3,2.5,0.3],"moondream/moondream3.1-9b-a2b":[0.3,2.5,0.3],"moonshotai/kimi-k2":[0.57,2.3,0.57],"moonshotai/kimi-k2-0905":[0.6,2.5,0.6],"moonshotai/kimi-k2-thinking":[0.6,2.5,0.15],"moonshotai/kimi-k2.5":[0.5,2.5,0.15],"moonshotai/kimi-k2.6":[0.65,3.41,0.15],"moonshotai/kimi-k2.7-code":[0.56,3.1,0.15],"moonshotai/kimi-k3":[0.239,10.8,0.21],"moonshotai/kimi-k3.1-pro":[2.0,10.0,0.2],"morph/morph-v3-fast":[0.8,1.2,0.8],"morph/morph-v3-large":[0.9,1.9,0.9],"nex-agi/nex-n2.5-mini":[0.025,0.1,0.0025],"nex-agi/nex-n2.5-pro":[0.075,0.25,0.015],"nousresearch/hermes-3-llama-3.1-405b":[1.0,1.0,1.0],"nousresearch/hermes-3-llama-3.1-70b":[0.7,0.7,0.7],"nousresearch/hermes-4-405b":[1.0,3.0,0.2],"nvidia/nemotron-3-nano-30b-a3b":[0.06,0.24,0.012],"nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free":[0.0,0.0],"nvidia/nemotron-3-super-120b-a12b":[0.3,2.4,0.15],"nvidia/nemotron-3-ultra-550b-a55b":[0.6,2.4,0.12],"nvidia/nemotron-3-ultra-550b-a55b:free":[0.0,0.0],"nvidia/nemotron-3.5-content-safety":[0.2,0.2,0.2],"nvidia/nemotron-3.5-content-safety:free":[0.0,0.0],"nvidia/nemotron-3.5-lightning":[0.07,0.2,0.04],"nvidia/nemotron-3.5-lightning:free":[0.0,0.0],"nvidia/nemotron-3.5-super-vl":[0.15,0.5,0.02],"nvidia/nemotron-3.5-super-vl:free":[0.0,0.0],"openai/gpt-3.5-turbo-0613":[1.0,2.0,1.0],"openai/gpt-3.5-turbo-16k":[3.0,4.0,3.0],"openai/gpt-4":[30.0,60.0,30.0],"openai/gpt-4.1":[2.0,8.0,0.5],"openai/gpt-4.1-mini":[0.4,1.6,0.1],"openai/gpt-4.1-nano":[0.1,0.4,0.03],"openai/gpt-4o":[2.5,10.0,1.25],"openai/gpt-4o-2024-05-13":[5.0,15.0,5.0],"openai/gpt-4o-2024-08-06":[2.5,10.0,1.25],"openai/gpt-4o-2024-11-20":[2.5,10.0,1.25],"openai/gpt-4o-mini":[0.15,0.6,0.075],"openai/gpt-4o-mini-2024-07-18":[0.15,0.6,0.075],"openai/gpt-5":[1.25,10.0,0.125],"openai/gpt-5-image":[10.0,10.0,1.25],"openai/gpt-5-image-mini":[2.5,2.0,0.25],"openai/gpt-5-mini":[0.25,2.0,0.025],"openai/gpt-5-nano":[0.05,0.4,0.005],"openai/gpt-5-pro":[15.0,120.0,15.0],"openai/gpt-5.1":[1.25,10.0,0.125],"openai/gpt-5.1-codex":[1.25,10.0,0.13],"openai/gpt-5.1-codex-max":[1.25,10.0,0.125],"openai/gpt-5.1-codex-mini":[0.25,2.0,0.03],"openai/gpt-5.2":[1.75,14.0,0.175],"openai/gpt-5.2-codex":[1.75,14.0,0.175],"openai/gpt-5.2-pro":[21.0,168.0,21.0],"openai/gpt-5.3-codex":[1.75,14.0,0.175],"openai/gpt-5.4":[2.5,15.0,0.25],"openai/gpt-5.4-image-2":[8.0,15.0,2.0],"openai/gpt-5.4-mini":[0.75,4.5,0.075],"openai/gpt-5.4-nano":[0.2,1.25,0.02],"openai/gpt-5.4-pro":[30.0,180.0,30.0],"openai/gpt-5.5":[5.0,30.0,0.5],"openai/gpt-5.5-pro":[30.0,180.0,30.0],"openai/gpt-5.6-luna":[0.2,1.2,0.02],"openai/gpt-5.6-luna-pro":[0.2,1.2,0.02],"openai/gpt-5.6-sol":[4.0,20.0,0.4],"openai/gpt-5.6-sol-pro":[4.0,20.0,0.4],"openai/gpt-5.6-terra":[2.0,12.0,0.2],"openai/gpt-5.6-terra-pro":[2.0,12.0,0.2],"openai/gpt-6-astra":[10.0,50.0,1.0],"openai/gpt-6-astra-pro":[10.0,50.0,1.0],"openai/gpt-6-luna":[0.1,0.5,0.01],"openai/gpt-6-luna-pro":[0.1,0.5,0.01],"openai/gpt-6-sol":[2.0,10.0,0.2],"openai/gpt-6-sol-pro":[2.0,10.0,0.2],"openai/gpt-6.1-sol":[2.0,10.0,0.1],"openai/gpt-6.1-sol-pro":[2.0,10.0,0.1],"openai/gpt-6.1-terra":[1.0,5.0,0.05],"openai/gpt-6.1-terra-pro":[1.0,5.0,0.05],"openai/gpt-audio":[2.5,10.0,2.5],"openai/gpt-audio-mini":[0.6,2.4,0.6],"openai/gpt-chat-latest":[5.0,30.0,0.5],"openai/gpt-oss-120b":[0.15,0.6,0.075],"openai/gpt-oss-20b":[0.018,0.09,0.009],"openai/gpt-oss-safeguard-20b":[0.075,0.3,0.0375],"openai/o3":[2.0,8.0,0.5],"openai/o3-pro":[20.0,80.0,20.0],"openrouter/free":[0.0,0.0],"particle-ai/particle-1":[0.25,1.0,0.03],"perceptron/perceptron-mk1":[0.15,1.5,0.15],"perceptron/perceptron-mk1.5":[0.15,1.5,0.15],"perplexity/sonar":[1.0,1.0,1.0],"perplexity/sonar-deep-research":[2.0,8.0,2.0],"perplexity/sonar-pro":[3.0,15.0,3.0],"perplexity/sonar-pro-search":[3.0,15.0,3.0],"perplexity/sonar-reasoning-pro":[2.0,8.0,2.0],"poolside/laguna-s-2.1":[0.09,0.18,0.009],"poolside/laguna-s-2.1:free":[0.0,0.0],"poolside/laguna-xs-2.1":[0.06,0.12,0.03],"poolside/laguna-xs-2.1:free":[0.0,0.0],"prism-ml/ternary-bonsai-2-27b":[0.075,0.5,0.0375],"prism-ml/ternary-bonsai-2-9b":[0.08,0.13,0.04],"qwen/qwen-2.5-72b-instruct":[0.36,0.4,0.36],"qwen/qwen-2.5-7b-instruct":[0.1,0.2,0.1],"qwen/qwen-2.5-coder-32b-instruct":[0.66,1.0,0.66],"qwen/qwen-plus":[0.26,0.78,0.052],"qwen/qwen2.5-vl-72b-instruct":[0.8,1.0,0.4],"qwen/qwen3-14b":[0.12,0.24,0.12],"qwen/qwen3-235b-a22b-2507":[0.09,0.55,0.09],"qwen/qwen3-235b-a22b-thinking-2507":[0.45,3.5,0.45],"qwen/qwen3-30b-a3b":[0.12,0.5,0.12],"qwen/qwen3-30b-a3b-instruct-2507":[0.1,0.3,0.1],"qwen/qwen3-32b":[0.08,0.28,0.08],"qwen/qwen3-coder":[0.3,1.0,0.1],"qwen/qwen3-coder-30b-a3b-instruct":[0.07,0.28,0.07],"qwen/qwen3-coder-flash":[0.195,0.975,0.039],"qwen/qwen3-coder-next":[0.12,0.8,0.07],"qwen/qwen3-next-80b-a3b-instruct":[0.09,1.1,0.09],"qwen/qwen3-vl-235b-a22b-instruct":[0.21,1.9,0.1],"qwen/qwen3-vl-30b-a3b-instruct":[0.15,0.6,0.15],"qwen/qwen3-vl-30b-a3b-thinking":[0.29,1.0,0.29],"qwen/qwen3-vl-8b-instruct":[0.25,0.75,0.12],"qwen/qwen3.5-122b-a10b":[0.26,2.08,0.26],"qwen/qwen3.5-27b":[0.26,2.6,0.26],"qwen/qwen3.5-35b-a3b":[0.14,1.0,0.05],"qwen/qwen3.5-397b-a17b":[0.5,3.6,0.3],"qwen/qwen3.5-9b":[0.17,0.25,0.17],"qwen/qwen3.5-flash-02-23":[0.065,0.26,0.065],"qwen/qwen3.5-plus-02-15":[0.26,1.56,0.26],"qwen/qwen3.5-plus-20260420":[0.3,1.8,0.3],"qwen/qwen3.6-27b":[0.45,2.7,0.45],"qwen/qwen3.6-35b-a3b":[0.1,0.9,0.025],"qwen/qwen3.6-flash":[0.1875,1.125,0.1875],"qwen/qwen3.6-plus":[0.325,1.95,0.325],"qwen/qwen3.7-flash":[0.03,0.13,0.006],"qwen/qwen3.7-max":[1.475,4.425,0.295],"qwen/qwen3.7-plus":[0.32,1.28,0.064],"qwen/qwen3.8-2.4t-a95b":[2.0,6.0,0.25],"qwen/qwen3.8-27b":[0.039,1.25,0.0039],"qwen/qwen3.8-flash":[0.15,0.47,0.016],"qwen/qwen3.8-max-0902":[2.0,6.0,0.25],"qwen/qwen3.8-max-prime":[4.0,12.0,0.5],"qwen/qwen3.8-omni-flash":[0.15,0.47,0.016],"recursive/flint-v1.0:free":[0.0,0.0],"reflection/beam-1.0-501b-a23b":[0.25,1.0,0.05],"rekaai/reka-edge":[0.1,0.1,0.1],"rekaai/reka-flash-3":[0.1,0.2,0.1],"relace/relace-apply-3":[0.85,1.25,0.85],"relace/relace-search":[1.0,3.0,1.0],"sakana/fugu-max":[2.0,6.0,0.25],"sakana/fugu-ultra":[5.0,30.0,0.5],"sakana/fugu-ultra-v2":[5.0,30.0,0.5],"sakana/sakana-namazu":[0.95,4.0,0.15],"sao10k/l3-lunaris-8b":[0.04,0.05,0.04],"sao10k/l3.1-euryale-70b":[0.85,0.85,0.85],"scaledown/extract":[0.04,0.0,0.04],"scaledown/summarize":[0.04,0.0,0.04],"stepfun/step-3.5-flash":[0.1,0.3,0.1],"stepfun/step-3.7-flash":[0.2,1.15,0.04],"stepfun/step-5-preview":[1.0,2.7,0.1],"tencent/hunyuan-a13b-instruct":[0.14,0.57,0.14],"tencent/hy-mt2-1.8b":[0.044,0.177,0.044],"tencent/hy-mt2-30b-a3b":[0.074,0.295,0.074],"tencent/hy-mt2-7b":[0.074,0.295,0.074],"tencent/hy3":[0.132,0.528,0.033],"tencent/hy3-preview":[0.18,0.6,0.06],"tencent/hy4-preview":[0.834,2.501,0.042],"thedrummer/cydonia-24b-v4.1":[0.3,0.5,0.15],"thedrummer/skyfall-36b-v2":[0.55,0.8,0.25],"thedrummer/unslopnemo-12b":[0.4,0.4,0.4],"thinkingmachines/inkling":[1.0,4.05,0.17],"thinkingmachines/inkling-small":[0.45,1.2,0.1],"thinkingmachines/inkling-small:free":[0.0,0.0],"thinkingmachines/inkling:free":[0.0,0.0],"unbiased/pareto-26.10":[0.8,3.2,0.03],"unbiased/pareto-26.9":[2.5,7.5,0.25],"undi95/remm-slerp-l2-13b":[0.35,0.65,0.35],"upstage/solar-mini4":[0.05,0.2,0.005],"upstage/solar-pro-3":[0.15,0.6,0.015],"upstage/solar-pro4":[0.15,0.6,0.03],"writer/palmyra-x5":[0.6,6.0,0.6],"x-ai/grok-4.20":[1.25,2.5,0.2],"x-ai/grok-4.20-multi-agent":[1.25,2.5,0.2],"x-ai/grok-4.3":[1.25,2.5,0.2],"x-ai/grok-4.5":[2.0,6.0,0.3],"x-ai/grok-4.6":[2.0,6.0,0.5],"x-ai/grok-4.7":[2.0,6.0,0.5],"x-ai/grok-build-0.1":[1.0,2.0,0.2],"xiaomi/mimo-v2.5":[0.4,2.0,0.08],"xiaomi/mimo-v2.5-pro":[0.48,1.8,0.096],"xiaomi/mimo-v2.6-flash":[0.14,0.28,0.0028],"xiaomi/mimo-v2.6-pro":[0.435,0.87,0.0036],"xiaomi/mimo-v2.6-pro-ultraspeed":[4.35,8.7,0.036],"xingchen-agi/xing4.0-29b-a4b:free":[0.0,0.0],"z-ai/glm-4.5":[0.6,2.2,0.11],"z-ai/glm-4.5-air":[0.13,0.85,0.025],"z-ai/glm-4.5v":[0.6,1.8,0.11],"z-ai/glm-4.6":[0.5,2.0,0.1],"z-ai/glm-4.6v":[0.3,0.9,0.05],"z-ai/glm-4.7":[0.54,1.98,0.099],"z-ai/glm-4.7-flash":[0.0605,0.4,0.0605],"z-ai/glm-5":[1.0,3.2,0.2],"z-ai/glm-5-turbo":[1.2,4.0,0.24],"z-ai/glm-5.1":[1.4,4.4,0.26],"z-ai/glm-5.2":[0.006,7.0,0.005],"z-ai/glm-5.3":[0.0699,1.4,0.0689],"z-ai/glm-5.3-flash":[0.0457,0.0742,0.03],"z-ai/glm-5.3-flashx":[0.37,1.25,0.09],"z-ai/glm-5.3-prime":[2.8,8.8,0.56],"z-ai/glm-5v-turbo":[1.2,4.0,0.24],"~anthropic/claude-fable-latest":[10.0,50.0,0.25],"~anthropic/claude-haiku-latest":[0.1,0.5,0.01],"~anthropic/claude-opus-latest":[4.0,20.0,0.2],"~anthropic/claude-sonnet-latest":[2.0,10.0,0.1],"~deepseek/deepseek-flash-latest":[0.0193,1.8,0.0191],"~deepseek/deepseek-pro-latest":[0.1035,8.0,0.1],"~deepseek/deepseek-v4-flash-latest":[0.057,0.1341,0.028],"~google/gemini-flash-latest":[0.75,3.75,0.075],"~google/gemini-pro-latest":[2.0,10.0,0.1],"~moonshotai/kimi-latest":[0.1824,9.3388,0.18],"~openai/gpt-astra-latest":[10.0,50.0,1.0],"~openai/gpt-luna-latest":[0.1,0.5,0.01],"~openai/gpt-mini-latest":[0.75,4.5,0.075],"~openai/gpt-sol-latest":[2.0,10.0,0.1],"~openai/gpt-terra-latest":[1.0,5.0,0.05],"~unbiased/pareto-latest":[0.8,3.2,0.03],"~x-ai/grok-latest":[2.0,6.0,0.5],"~z-ai/glm-flash-latest":[0.0457,0.0742,0.03],"~z-ai/glm-latest":[0.0699,1.4,0.0689]},"opper":{"claude-fable-5":[10.0,50.0,1.0],"claude-fable-5-1":[10.0,50.0,0.25],"claude-haiku-4-5":[1.1,5.5,0.11],"claude-opus-4-5":[5.0,25.0,0.5],"claude-opus-4-6":[5.0,25.0,0.5],"claude-opus-4-7":[5.5,27.5,0.55],"claude-opus-4-8":[5.0,25.0,0.5],"claude-opus-5":[5.5,27.5,0.55],"claude-sonnet-4-5":[3.3,16.5,0.33],"claude-sonnet-4-6":[3.3,16.5,0.33],"claude-sonnet-5":[2.2,11.0,0.22],"deepseek-v4-flash":[0.25,0.66,0.25],"deepseek-v4-pro":[1.78812,3.57624,1.78812],"gemini-3-flash-preview":[0.5,3.0,0.05],"gemini-3.1-pro-preview":[2.0,12.0,0.2],"gemini-3.5-flash":[1.5,9.0,0.15],"gemini-3.5-flash-lite":[0.3,2.5,0.03],"gemini-3.7-flash":[0.75,3.75,0.075],"gemini-3.8-flash":[0.825,4.125,0.0825],"gemma-4-31b-it":[0.46488,2.44062,0.46488],"glm-5.2":[1.62708,5.811,1.62708],"glm-5.3":[1.75,4.6488,0.44],"glm-5.3-flash":[0.2,0.5,0.07],"gpt-5.3-codex":[1.75,14.0,0.175],"gpt-5.4":[2.5,15.0,0.25],"gpt-5.4-mini":[0.75,4.5,0.075],"gpt-5.4-nano":[0.2,1.25,0.02],"gpt-5.4-pro":[30.0,180.0,30.0],"gpt-5.5":[5.0,30.0,0.5],"gpt-5.5-pro":[30.0,180.0,30.0],"gpt-5.6-luna":[0.2,1.2,0.02],"gpt-5.6-sol":[5.0,30.0,0.5],"gpt-5.6-terra":[2.0,12.0,0.2],"gpt-6-astra":[10.0,50.0,1.0],"gpt-oss-120b":[1.1622,4.88124,1.1622],"gpt-oss-20b":[0.11622,0.488124,0.11622],"grok-4.3":[1.25,2.5,0.2],"grok-4.5":[2.0,6.0,0.5],"grok-4.6":[2.0,6.0,0.5],"grok-build-0.1":[1.0,2.0,0.2],"kimi-k3":[3.0,15.0,3.0],"minimax-m2.7":[0.69732,2.78928,0.69732],"minimax-m3":[0.6,2.4,0.12],"mistral-large-2512":[0.5,1.5,0.5],"mistral-small-2603":[0.5811,2.44062,0.5811],"muse-spark-1.2":[1.25,4.25,0.15],"muse-spark-1.3":[1.25,4.25,0.15],"qwen3-coder-next":[0.5811,2.3244,0.5811],"qwen3.6-35b-a3b":[0.248,1.485,0.248],"qwen3.8-2.4t-a95b":[2.5,6.0,0.63],"qwen3.8-27b":[0.5811,3.0,0.5811],"qwen3.8-max":[2.0,6.0,0.25],"sonar":[1.0,1.0,1.0],"sonar-pro":[3.0,15.0,3.0],"sonar-reasoning-pro":[2.0,8.0,2.0]},"orcarouter":{"anthropic/claude-fable-5":[10.0,50.0,1.0],"anthropic/claude-haiku-4.5":[1.0,5.0,0.1],"anthropic/claude-opus-4.5":[5.0,25.0,0.5],"anthropic/claude-opus-4.6":[5.0,25.0,0.5],"anthropic/claude-opus-4.7":[5.0,25.0,0.5],"anthropic/claude-opus-4.8":[5.0,25.0,0.5],"anthropic/claude-opus-5":[5.0,25.0,0.5],"anthropic/claude-sonnet-4.5":[3.0,15.0,0.3],"anthropic/claude-sonnet-4.6":[3.0,15.0,0.3],"anthropic/claude-sonnet-5":[2.0,10.0,0.2],"deepseek/deepseek-chat":[0.22,0.66,0.007],"deepseek/deepseek-reasoner":[0.242,0.726,0.0077],"deepseek/deepseek-v4-flash":[0.22,0.66,0.007],"deepseek/deepseek-v4-flash-0731":[0.22,0.66,0.007],"deepseek/deepseek-v4-flash-free":[0.0,0.0],"deepseek/deepseek-v4-flash-vision-exp":[0.22,0.66,0.007],"deepseek/deepseek-v4-pro":[0.66,1.98,0.022],"deepseek/deepseek-v4-pro-0813":[0.66,1.98,0.022],"google/gemini-2.5-flash":[0.3,2.5,0.03],"google/gemini-2.5-flash-lite":[0.1,0.4,0.01],"google/gemini-2.5-pro":[2.5,15.0,0.25],"google/gemini-3-flash-preview":[0.5,3.0,0.05],"google/gemini-3.1-flash-lite":[0.25,1.5,0.025],"google/gemini-3.1-flash-lite-preview":[0.25,1.5,0.025],"google/gemini-3.1-pro-preview":[2.0,12.0,0.2],"google/gemini-3.1-pro-preview-customtools":[4.0,18.0,0.4],"google/gemini-3.5-flash":[1.5,9.0,0.15],"google/gemini-3.5-flash-lite":[0.3,2.5,0.03],"google/gemini-3.6-flash":[0.75,3.75,0.075],"google/gemini-flash-latest":[0.5,3.0,0.1],"google/gemini-flash-lite-latest":[0.25,1.5,0.025],"google/gemini-robotics-er-1.6-preview":[1.0,5.0,1.0],"google/gemma-4-26b-a4b-it":[0.06,0.33,0.0075],"google/gemma-4-31b-it":[0.13,0.38,0.02],"grok/grok-4.3":[1.25,2.5,0.2],"grok/grok-4.5":[2.0,6.0,0.3],"grok/grok-4.6":[2.0,6.0,0.5],"kimi/kimi-k2.5":[0.6,3.0,0.1],"kimi/kimi-k2.6":[0.95,4.0,0.16],"kimi/kimi-k2.7-code":[0.95,4.0,0.19],"kimi/kimi-k3":[3.0,15.0,0.3],"meta/muse-spark-1.1":[1.25,4.25,0.15],"meta/muse-spark-1.2":[1.25,4.25,0.15],"minimax/minimax-m2.5":[0.3,1.2,0.03],"minimax/minimax-m2.5-highspeed":[0.6,2.4,0.03],"minimax/minimax-m2.7":[0.3,1.2,0.06],"minimax/minimax-m2.7-highspeed":[0.6,2.4,0.06],"minimax/minimax-m3":[0.3,1.2,0.06],"openai/gpt-3.5-turbo":[0.5,1.5],"openai/gpt-4":[30.0,60.0,30.0],"openai/gpt-4-turbo":[10.0,30.0,10.0],"openai/gpt-4.1":[2.0,8.0,0.5],"openai/gpt-4.1-mini":[0.4,1.6,0.1],"openai/gpt-4.1-nano":[0.1,0.4,0.025],"openai/gpt-4o":[2.5,10.0,1.25],"openai/gpt-4o-2024-05-13":[5.0,15.0,5.0],"openai/gpt-4o-2024-08-06":[2.5,10.0,1.25],"openai/gpt-4o-2024-11-20":[2.5,10.0,1.25],"openai/gpt-4o-mini":[0.15,0.6,0.075],"openai/gpt-5":[1.25,10.0,0.125],"openai/gpt-5-chat-latest":[1.25,10.0,0.125],"openai/gpt-5-mini":[0.25,2.0,0.025],"openai/gpt-5-nano":[0.05,0.4,0.005],"openai/gpt-5-pro":[15.0,120.0,15.0],"openai/gpt-5.1":[1.25,10.0,0.125],"openai/gpt-5.1-chat-latest":[1.25,10.0,0.125],"openai/gpt-5.1-codex":[1.25,10.0,0.125],"openai/gpt-5.1-codex-mini":[0.25,2.0,0.025],"openai/gpt-5.2":[1.75,14.0,0.175],"openai/gpt-5.2-chat-latest":[1.75,14.0,0.175],"openai/gpt-5.2-codex":[1.75,14.0,0.175],"openai/gpt-5.2-pro":[21.0,168.0,21.0],"openai/gpt-5.3-codex":[1.75,14.0,0.175],"openai/gpt-5.4":[2.5,15.0,0.25],"openai/gpt-5.4-mini":[0.75,4.5,0.075],"openai/gpt-5.4-nano":[0.2,1.25,0.02],"openai/gpt-5.4-pro":[30.0,180.0,30.0],"openai/gpt-5.5":[5.0,30.0,0.5],"openai/gpt-5.5-pro":[30.0,180.0,30.0],"openai/gpt-5.6-luna":[0.2,1.2,0.02],"openai/gpt-5.6-sol":[4.0,20.0,0.4],"openai/gpt-5.6-terra":[2.0,12.0,0.2],"openai/gpt-oss-120b":[0.03,0.17,0.03],"orcarouter/auto":[0.0,0.0],"orcarouter/free":[0.0,0.0],"qwen/qwen3-max":[0.359,1.434,0.359],"qwen/qwen3-vl-235b-a22b-instruct":[0.4,1.6,0.4],"qwen/qwen3-vl-235b-a22b-thinking":[0.4,4.0,0.4],"qwen/qwen3.5-122b-a10b":[0.115,0.917,0.115],"qwen/qwen3.5-27b":[0.086,0.688,0.086],"qwen/qwen3.5-35b-a3b":[0.057,0.459,0.057],"qwen/qwen3.5-397b-a17b":[0.172,1.032,0.172],"qwen/qwen3.5-flash":[0.1,0.4,0.1],"qwen/qwen3.5-plus":[0.4,2.4,0.4],"qwen/qwen3.6-35b-a3b":[0.248,1.485,0.248],"qwen/qwen3.6-flash":[0.25,1.5,0.25],"qwen/qwen3.6-plus":[0.276,1.651,0.0276],"qwen/qwen3.7-flash":[0.03,0.13,0.006],"qwen/qwen3.7-max":[1.25,3.75,0.25],"qwen/qwen3.7-plus":[0.35,1.42,0.071],"qwen/qwen3.8-27b":[0.33,2.4,0.33],"qwen/qwen3.8-max":[2.0,6.0,0.25],"tencent/hy3":[0.18,0.59,0.059],"tencent/hy3-free":[0.0,0.0],"z-ai/glm-4.5":[0.6,2.2,0.11],"z-ai/glm-4.5-air":[0.2,1.1,0.03],"z-ai/glm-4.6":[0.6,2.2,0.11],"z-ai/glm-4.7":[0.6,2.2,0.11],"z-ai/glm-5":[1.0,3.2,0.26],"z-ai/glm-5.1":[1.4,4.4,0.26],"z-ai/glm-5.2":[1.4,4.4,0.26],"z-ai/glm-5.3":[1.26,3.96,0.234],"z-ai/glm-5.3-flash":[0.15,0.5,0.03],"z-ai/glm-5.3-flash-free":[0.0,0.0]},"ovhcloud":{"gpt-oss-120b":[0.09,0.47,0.09],"gpt-oss-20b":[0.05,0.18,0.05],"meta-llama-3_3-70b-instruct":[0.74,0.74,0.74],"mistral-nemo-instruct-2407":[0.14,0.14,0.14],"mistral-small-3.2-24b-instruct-2506":[0.1,0.31,0.1],"qwen2.5-vl-72b-instruct":[1.01,1.01,1.01],"qwen3.5-397b-a17b":[0.71,4.25,0.71],"qwen3.5-9b":[0.12,0.18,0.12],"qwen3.6-27b":[0.47,3.19,0.47],"qwen3.8-27b":[0.47,3.19,0.47],"qwen3guard-gen-0.6b":[0.0,0.0],"qwen3guard-gen-8b":[0.0,0.0]},"pareto":{"z-ai/glm-5.3-flash":[0.06,0.2,0.012]},"pendra":{"deepseek-v4-flash":[0.0,0.0],"glm-4.7-flash":[0.0,0.0],"gpt-oss:120b":[0.0,0.0],"llama3.3:70b":[0.0,0.0],"qwen3-coder:30b":[0.0,0.0],"qwen3.6:27b":[0.0,0.0]},"perplexity":{"sonar":[1.0,1.0,1.0],"sonar-deep-research":[2.0,8.0,2.0],"sonar-pro":[3.0,15.0,3.0],"sonar-reasoning-pro":[2.0,8.0,2.0]},"perplexity-agent":{"anthropic/claude-fable-5":[10.0,50.0,1.0],"anthropic/claude-fable-5-1":[10.0,50.0,0.25],"anthropic/claude-haiku-4-5":[1.0,5.0,0.1],"anthropic/claude-haiku-5-5":[0.1,0.5,0.01],"anthropic/claude-opus-4-5":[5.0,25.0,0.5],"anthropic/claude-opus-4-6":[5.0,25.0,0.5],"anthropic/claude-opus-4-7":[5.0,25.0,0.5],"anthropic/claude-opus-5":[5.0,25.0,0.5],"anthropic/claude-opus-5-5":[4.0,20.0,0.2],"anthropic/claude-sonnet-4-5":[3.0,15.0,0.3],"anthropic/claude-sonnet-4-6":[3.0,15.0,0.3],"anthropic/claude-sonnet-5":[2.0,10.0,0.2],"anthropic/claude-sonnet-5-5":[2.0,10.0,0.1],"deepseek/deepseek-v4-flash-0731":[0.13,0.26,0.028],"google/gemini-3-flash-preview":[0.5,3.0,0.05],"google/gemini-3.1-pro-preview":[2.0,12.0,0.2],"google/gemini-3.6-flash":[1.5,7.5,0.15],"google/gemini-3.7-flash":[0.75,3.75,0.075],"google/gemini-3.8-flash":[0.75,3.75,0.075],"google/gemini-4-argon":[2.0,10.0,0.1],"moonshot-ai/kimi-k2.7-code":[0.95,4.0,0.19],"moonshot-ai/kimi-k3":[3.0,15.0,0.3],"nvidia/nemotron-3-super-120b-a12b":[0.25,2.5,0.25],"openai/gpt-5-mini":[0.25,2.0,0.025],"openai/gpt-5.1":[1.25,10.0,0.125],"openai/gpt-5.2":[1.75,14.0,0.175],"openai/gpt-5.4":[2.5,15.0,0.25],"openai/gpt-5.5":[5.0,30.0,0.5],"openai/gpt-5.6-luna":[0.2,1.2,0.02],"openai/gpt-5.6-sol":[4.0,20.0,0.4],"openai/gpt-5.6-terra":[2.0,12.0,0.2],"openai/gpt-6-astra":[10.0,50.0,1.0],"openai/gpt-6-luna":[0.1,0.5,0.01],"openai/gpt-6-sol":[2.0,10.0,0.2],"openai/gpt-6.1-sol":[2.0,10.0,0.1],"perplexity/deepseek-v4-pro-0813":[1.32,3.96,0.044],"perplexity/glm-5.3":[1.4,4.4,0.26],"perplexity/glm-5.3-flash":[0.15,0.5,0.03],"perplexity/kimi-k3":[3.0,15.0,0.3],"perplexity/nemotron-3.5-super-120b-a12b":[0.2,0.5,0.04],"perplexity/sonar":[0.25,2.5,0.0625],"xai/grok-4-1-fast-non-reasoning":[0.2,0.5,0.05],"xai/grok-4.5":[2.0,6.0,0.3],"xai/grok-4.6":[2.0,6.0,0.5],"xai/grok-4.7":[2.0,6.0,0.5]},"pioneer":{"claude-fable-5":[11.0,55.0,1.1],"claude-haiku-4-5":[1.0,5.0,0.1],"claude-opus-5":[5.0,25.0,0.5],"claude-opus-5-fast":[10.0,50.0,1.0],"claude-sonnet-5":[2.0,10.0,0.2],"deepseek-ai/deepseek-v4-flash":[0.1,0.2,0.0197],"fastino/gliguard-llmguardrails-300m":[0.15,0.15,0.15],"fastino/gliguard-pii-multi":[0.15,0.15,0.15],"fastino/gliner-2.5-decide":[0.03,0.0,0.03],"fastino/gliner2-base-v1":[0.03,0.0,0.03],"fastino/gliner2-large-v1":[0.03,0.0,0.03],"fastino/gliner2-multi-large-v1":[0.03,0.0,0.03],"fastino/gliner2-multi-v1":[0.03,0.0,0.03],"fastino/gliner2-privacy-filter-pii-multi":[0.03,0.0,0.03],"fastino/gliner2.5-base-v1":[0.03,0.0,0.03],"fastino/gliner2.5-multi-v1":[0.03,0.0,0.03],"gpt-5.5":[5.0,30.0,0.5],"gpt-5.6-luna":[1.0,6.0,0.1],"gpt-5.6-sol":[5.0,30.0,0.5],"gpt-5.6-terra":[2.5,15.0,0.25],"moonshotai/kimi-k3":[3.0,15.0,0.3],"moonshotai/kimi-k3-fast":[4.5,22.5,0.45],"nvidia/nvidia-nemotron-3.5-lightning-30b-a3b-bf16":[0.07,0.2,0.035],"nvidia/nvidia-nemotron-3.5-super-vl-120b-a12b-nvfp4":[0.08,0.45,0.04],"zai-org/glm-5.2":[1.4,4.4,0.26]},"poe":{"anthropic/claude-haiku-3":[0.21,1.1,0.021],"anthropic/claude-haiku-3.5":[0.68,3.4,0.068],"anthropic/claude-haiku-4.5":[0.8586,4.2929,0.0859],"anthropic/claude-opus-4":[13.0,64.0,1.3],"anthropic/claude-opus-4.1":[13.0,64.0,1.3],"anthropic/claude-opus-4.5":[4.2929,21.4646,0.4293],"anthropic/claude-opus-4.6":[4.2929,21.4646,0.4293],"anthropic/claude-opus-4.7":[4.2929,21.4646,0.4293],"anthropic/claude-opus-4.8":[4.2929,21.4646,0.4293],"anthropic/claude-sonnet-3.5":[2.6,13.0,0.26],"anthropic/claude-sonnet-3.5-june":[2.6,13.0,0.26],"anthropic/claude-sonnet-3.7":[2.6,13.0,0.26],"anthropic/claude-sonnet-4":[2.6,13.0,0.26],"anthropic/claude-sonnet-4.5":[2.5758,12.8788,0.2576],"anthropic/claude-sonnet-4.6":[2.5758,12.8788,0.2576],"cerebras/gpt-oss-120b-cs":[0.3535,0.7576,0.3535],"cerebras/llama-3.1-8b-cs":[0.1,0.1,0.1],"empiriolabs/deepseek-v4-flash-el":[0.14,0.28,0.14],"empiriolabs/deepseek-v4-pro-el":[1.67,3.33,1.67],"fireworks-ai/kimi-k2.5-fw":[0.0,0.0],"google/gemini-2.0-flash":[0.1,0.42,0.1],"google/gemini-2.0-flash-lite":[0.052,0.21,0.052],"google/gemini-2.5-flash":[0.21,1.8,0.021],"google/gemini-2.5-flash-lite":[0.07,0.28,0.07],"google/gemini-2.5-pro":[0.87,7.0,0.087],"google/gemini-3-flash":[0.404,2.4242,0.0404],"google/gemini-3.1-flash-lite":[0.2525,1.5152,0.2525],"google/gemini-3.1-pro":[2.0202,12.1212,0.202],"google/gemini-3.5-flash":[1.5152,9.0909,0.1515],"google/gemini-3.5-flash-lite":[0.303,2.5253,0.0303],"google/gemini-3.6-flash":[0.7576,3.7879,0.0758],"google/gemini-3.7-flash":[0.7576,3.7879,0.0758],"google/gemini-3.8-flash":[0.7576,3.7879,0.0758],"google/gemini-deep-research":[1.6,9.6,1.6],"google/gemini-omni-1.1-flash":[1.5152,9.0909,1.5152],"google/gemma-4-31b":[0.0,0.0],"google/nano-banana":[0.21,1.8,0.021],"google/nano-banana-pro":[2.0202,12.1212,0.202],"novita/deepseek-v3.2":[0.2626,0.3838,0.1313],"novita/glm-4.6":[0.6061,2.2222,0.1111],"novita/glm-4.7-flash":[0.0707,0.404,0.0707],"novita/glm-5":[1.0,3.2,0.2],"novita/kimi-k2.5":[0.6,3.0,0.1],"novita/kimi-k2.6":[0.9596,4.0404,0.1616],"novita/minimax-m2.1":[0.303,1.2121,0.1515],"openai/chatgpt-4o-latest":[4.5,14.0,4.5],"openai/gpt-3.5-turbo":[0.45,1.4,0.45],"openai/gpt-3.5-turbo-instruct":[1.4,1.8,1.4],"openai/gpt-3.5-turbo-raw":[0.45,1.4,0.45],"openai/gpt-4-turbo":[9.0,27.0,9.0],"openai/gpt-4.1":[1.8182,7.2727,0.4545],"openai/gpt-4.1-mini":[0.3636,1.4545,0.0909],"openai/gpt-4.1-nano":[0.09,0.36,0.022],"openai/gpt-4o-aug":[2.2727,9.0909,1.1364],"openai/gpt-4o-mini":[0.1364,0.5455,0.0682],"openai/gpt-4o-mini-search":[0.14,0.54,0.14],"openai/gpt-4o-search":[2.2727,9.0909,2.2727],"openai/gpt-5":[1.1364,9.0909,0.1136],"openai/gpt-5-chat":[1.1,9.0,0.11],"openai/gpt-5-codex":[1.1,9.0,1.1],"openai/gpt-5-mini":[0.2273,1.8182,0.0227],"openai/gpt-5-nano":[0.0455,0.3636,0.0045],"openai/gpt-5-pro":[13.6364,109.0909,13.6364],"openai/gpt-5.1":[1.1364,9.0909,0.1136],"openai/gpt-5.1-codex":[1.1,9.0,0.11],"openai/gpt-5.1-codex-max":[1.1,9.0,0.11],"openai/gpt-5.1-codex-mini":[0.22,1.8,0.022],"openai/gpt-5.1-instant":[1.1,9.0,0.11],"openai/gpt-5.2":[1.5909,12.7273,0.1591],"openai/gpt-5.2-codex":[1.6,13.0,0.16],"openai/gpt-5.2-instant":[1.6,13.0,0.16],"openai/gpt-5.2-pro":[19.0909,152.7273,19.0909],"openai/gpt-5.3-codex":[1.5909,12.7273,0.1591],"openai/gpt-5.3-codex-spark":[0.0,0.0],"openai/gpt-5.3-instant":[1.6,13.0,0.16],"openai/gpt-5.4":[2.2727,13.6364,0.2273],"openai/gpt-5.4-mini":[0.6818,4.0909,0.0682],"openai/gpt-5.4-nano":[0.1818,1.1364,0.0182],"openai/gpt-5.4-pro":[27.2727,163.6364,27.2727],"openai/gpt-5.5":[4.5455,27.2727,0.4545],"openai/gpt-5.5-pro":[27.2727,163.6364,27.2727],"openai/gpt-image-2":[5.0505,30.303,1.2626],"openai/o1":[14.0,54.0,14.0],"openai/o1-pro":[140.0,540.0,140.0],"openai/o3":[1.8182,7.2727,0.4545],"openai/o3-deep-research":[9.0,36.0,2.2],"openai/o3-mini":[0.99,4.0,0.99],"openai/o3-mini-high":[0.99,4.0,0.99],"openai/o3-pro":[18.1818,72.7273,18.1818],"openai/o4-mini":[0.99,4.0,0.25],"openai/o4-mini-deep-research":[1.8,7.2,0.45],"xai/grok-3":[3.0,15.0,0.75],"xai/grok-3-mini":[0.3,0.5,0.075],"xai/grok-4":[3.0,15.0,0.75],"xai/grok-4-fast-non-reasoning":[0.2,0.5,0.05],"xai/grok-4-fast-reasoning":[0.2,0.5,0.05],"xai/grok-4.20-multi-agent":[1.2626,2.5253,0.202],"xai/grok-code-fast-1":[0.2,1.5,0.02]},"poolside":{"poolside/laguna-m.1":[0.0,0.0],"poolside/laguna-s-2.1":[0.0,0.0],"poolside/laguna-xs-2.1":[0.0,0.0]},"prime":{"anthropic/claude-fable-5":[10.0,50.0,10.0],"anthropic/claude-fable-5.1":[10.0,50.0,10.0],"anthropic/claude-opus-4.6":[5.0,25.0,5.0],"anthropic/claude-opus-4.7":[5.0,25.0,5.0],"anthropic/claude-opus-4.8":[5.0,25.0,5.0],"anthropic/claude-opus-5":[5.0,25.0,5.0],"anthropic/claude-opus-5.5":[4.0,20.0,4.0],"anthropic/claude-sonnet-4.6":[3.0,15.0,3.0],"anthropic/claude-sonnet-5":[2.0,10.0,2.0],"anthropic/claude-sonnet-5.5":[2.0,10.0,2.0],"deepseek/deepseek-v4-flash":[0.44,1.32,0.44],"deepseek/deepseek-v4-flash-0731":[0.44,1.32,0.44],"deepseek/deepseek-v4-pro":[1.91,3.83,1.91],"deepseek/deepseek-v4.1-flash":[0.3,1.2,0.006],"deepseek/deepseek-v4.1-flash-1017":[0.3,1.2,0.006],"google/gemini-3-flash-preview":[0.5,3.0,0.5],"google/gemini-3.1-pro-preview":[2.0,12.0,2.0],"google/gemini-3.5-flash":[1.5,9.0,1.5],"google/gemini-3.6-flash":[1.5,7.5,1.5],"google/gemini-3.7-flash":[1.35,6.75,1.35],"google/gemini-3.8-flash":[0.75,3.75,0.75],"google/gemini-4-argon":[2.0,10.0,2.0],"google/gemma-3-27b-it":[0.119,0.3,0.119],"meta-llama/llama-3.3-70b-instruct":[1.04,2.253,1.04],"meta/muse-spark-open":[1.25,4.25,1.25],"mistralai/mistral-large-2512":[0.5,1.5,0.5],"mistralai/mistral-nemo":[0.165,0.17,0.165],"mistralai/mistral-small-2603":[0.165,0.66,0.165],"mistralai/mixtral-8x22b-instruct":[2.2,6.6,2.2],"moonshotai/kimi-k2-0905":[0.6,2.5,0.6],"moonshotai/kimi-k3":[3.45,17.25,3.45],"moonshotai/kimi-k3.1-pro":[2.0,10.0,2.0],"openai/gpt-4.1":[2.0,8.0,2.0],"openai/gpt-4.1-mini":[0.4,1.6,0.4],"openai/gpt-4.1-nano":[0.1,0.4,0.1],"openai/gpt-4o":[2.5,10.0,2.5],"openai/gpt-4o-mini":[0.15,0.6,0.15],"openai/gpt-5":[1.25,10.0,1.25],"openai/gpt-5-mini":[0.25,2.0,0.25],"openai/gpt-5-nano":[0.05,0.4,0.05],"openai/gpt-5.1":[1.25,10.0,1.25],"openai/gpt-5.2":[1.75,14.0,1.75],"openai/gpt-5.3-codex":[1.75,14.0,1.75],"openai/gpt-5.4":[2.5,15.0,2.5],"openai/gpt-5.4-mini":[0.75,4.5,0.75],"openai/gpt-5.4-nano":[0.2,1.25,0.2],"openai/gpt-5.4-pro":[30.0,180.0,30.0],"openai/gpt-5.5":[5.0,30.0,5.0],"openai/gpt-5.6-luna":[0.2,1.2,0.2],"openai/gpt-5.6-luna-pro":[1.0,6.0,1.0],"openai/gpt-5.6-sol":[5.0,30.0,5.0],"openai/gpt-5.6-sol-pro":[5.0,30.0,5.0],"openai/gpt-5.6-terra":[2.5,15.0,2.5],"openai/gpt-5.6-terra-pro":[2.5,15.0,2.5],"openai/gpt-6-astra":[10.0,50.0,10.0],"openai/gpt-6-luna":[0.1,0.5,0.1],"openai/gpt-6-sol":[2.0,10.0,2.0],"openai/gpt-6.1-sol":[2.0,10.0,2.0],"openai/gpt-oss-120b":[0.35,0.75,0.35],"openai/gpt-oss-20b":[0.07,0.3,0.07],"qwen/qwen3-30b-a3b-instruct-2507":[0.13,0.52,0.13],"qwen/qwen3-coder-next":[0.3,1.5,0.3],"qwen/qwen3-vl-235b-a22b-instruct":[0.3,1.5,0.3],"qwen/qwen3-vl-30b-a3b-instruct":[0.2,0.7,0.2],"qwen/qwen3.8-27b":[0.99,3.2,0.99],"x-ai/grok-4.6":[2.0,6.0,2.0],"x-ai/grok-4.7":[1.6,4.8,1.6],"z-ai/glm-5.2":[1.54,4.84,1.54],"z-ai/glm-5.3":[0.98,3.08,0.182],"z-ai/glm-5.3-flash":[0.15,0.5,0.03]},"privatemode-ai":{"deepseek-ocr-2":[0.8897,1.4675,0.0924],"glm-5.3":[1.791,6.6326,0.1733],"glm-5.3-flash":[0.2311,0.7511,0.0578],"glm-flash-latest":[0.2311,0.7511,0.0578],"glm-latest":[1.791,6.6326,0.1733],"gpt-oss-120b":[0.2311,0.7511,0.0462],"kimi-k2.6":[1.791,8.9436,0.1733],"kimi-latest":[1.791,8.9436,0.1733],"qwen3-embedding-4b":[0.1502,0.0,0.1502],"voxtral-mini-3b":[0.00462,0.0,0.00462],"whisper-large-v3":[0.01618,0.0,0.01618]},"qihang-ai":{"claude-haiku-4-5-20251001":[0.14,0.71,0.14],"claude-opus-4-5-20251101":[0.71,3.57,0.71],"claude-sonnet-4-5-20250929":[0.43,2.14,0.43],"gemini-2.5-flash":[0.09,0.71,0.09],"gemini-3-flash-preview":[0.07,0.43,0.07],"gemini-3-pro-preview":[0.57,3.43,0.57],"gpt-5-mini":[0.04,0.29,0.04],"gpt-5.2":[0.25,2.0,0.25],"gpt-5.2-codex":[0.14,1.14,0.14]},"qiniu-ai":{"deepseek-r1":[0.57971014,2.31884058,0.57971014],"deepseek-r1-0528":[0.57971014,2.31884058,0.57971014],"deepseek-v3":[0.28985507,1.15942029,0.28985507],"deepseek-v3.1":[0.57971014,1.73913043,0.57971014],"deepseek/deepseek-v3.1-terminus":[0.57971014,1.73913043,0.57971014],"deepseek/deepseek-v3.1-terminus-thinking":[0.57971014,1.73913043,0.57971014],"deepseek/deepseek-v3.2-251201":[0.28985507,0.43478261,0.02898551],"deepseek/deepseek-v3.2-exp":[0.28985507,0.43478261,0.28985507],"deepseek/deepseek-v3.2-exp-thinking":[0.28985507,0.43478261,0.28985507],"doubao-1.5-pro-32k":[0.11594203,0.28985507,0.11594203],"doubao-1.5-thinking-pro":[0.57971014,2.31884058,0.57971014],"doubao-1.5-vision-pro":[0.43478261,1.30434783,0.43478261],"doubao-seed-1.6":[0.11594203,1.15942029,0.11594203],"doubao-seed-1.6-flash":[0.02173913,0.2173913,0.02173913],"doubao-seed-1.6-thinking":[0.11594203,1.15942029,0.11594203],"doubao-seed-2.0-code":[0.46376812,2.31884058,0.09275362],"doubao-seed-2.0-lite":[0.08695652,0.52173913,0.0173913],"doubao-seed-2.0-mini":[0.02898551,0.28985507,0.0057971],"doubao-seed-2.0-pro":[0.46376812,2.31884058,0.09275362],"glm-4.5":[0.57971014,2.31884058,0.57971014],"kimi-k2":[0.57971014,2.31884058,0.57971014],"meituan/longcat-flash-lite":[0.0,0.0],"mimo-v2-flash":[0.1,0.3,0.01],"minimax-m1":[0.57971014,2.31884058,0.57971014],"minimax/minimax-m2":[0.30434783,1.2173913,0.30434783],"minimax/minimax-m2.1":[0.30434783,1.2173913,0.30434783],"minimax/minimax-m2.5":[0.30434783,1.2173913,0.30434783],"minimax/minimax-m2.5-highspeed":[0.60869565,2.43478261,0.60869565],"moonshotai/kimi-k2-thinking":[0.57971014,2.31884058,0.57971014],"moonshotai/kimi-k2.5":[0.57971014,3.04347826,0.57971014],"qwen-max-2025-01-25":[0.34782609,1.39130435,0.34782609],"qwen-turbo":[0.04347826,0.08695652,0.04347826],"qwen-vl-max-2025-01-25":[0.43478261,1.30434783,0.43478261],"qwen2.5-vl-72b-instruct":[2.31884058,6.95652174,2.31884058],"qwen3-235b-a22b":[0.28985507,1.15942029,0.28985507],"qwen3-235b-a22b-instruct-2507":[0.28985507,1.15942029,0.28985507],"qwen3-235b-a22b-thinking-2507":[0.28985507,2.89855072,0.28985507],"qwen3-30b-a3b":[0.10869565,0.43478261,0.10869565],"qwen3-30b-a3b-instruct-2507":[0.10869565,0.43478261,0.10869565],"qwen3-30b-a3b-thinking-2507":[0.10869565,1.08695652,0.10869565],"qwen3-32b":[0.28985507,1.15942029,0.28985507],"qwen3-coder-480b-a35b-instruct":[0.86956522,3.47826087,0.86956522],"qwen3-max":[0.86956522,3.47826087,0.86956522],"qwen3-max-preview":[0.86956522,3.47826087,0.86956522],"qwen3-next-80b-a3b-instruct":[0.14492754,0.57971014,0.14492754],"qwen3-next-80b-a3b-thinking":[0.14492754,1.44927536,0.14492754],"qwen3-vl-30b-a3b-thinking":[0.10869565,1.08695652,0.10869565],"qwen3.5-397b-a17b":[0.17391304,1.04347826,0.17391304],"z-ai/glm-4.6":[1.04347826,1.82608696,1.04347826],"z-ai/glm-4.7":[0.45913043,1.81565217,0.45913043],"z-ai/glm-5":[0.57971014,2.60869565,0.57971014]},"qvac":{"gemma4-31b":[0.0,0.0],"gpt-oss-120b":[0.0,0.0],"gpt-oss-20b":[0.0,0.0],"qwen3.5-0.8b":[0.0,0.0],"qwen3.5-2b":[0.0,0.0],"qwen3.5-4b":[0.0,0.0],"qwen3.5-9b":[0.0,0.0],"qwen3.6-27b":[0.0,0.0],"qwen3.6-35b-a3b":[0.0,0.0]},"reflection":{"beam-1.0-501b-a23b":[0.0,0.0]},"regolo-ai":{"apertus-70b":[0.46,2.42,0.46],"brick-complexity-pro":[0.12,0.46,0.12],"brick-v1-beta":[0.0,0.0],"deepseek-ocr-2":[0.0,0.0],"faster-whisper-large-v3":[0.0,0.0],"gemma4-31b":[0.46,2.42,0.46],"glm5.2":[2.31,6.0,2.31],"gpt-oss-120b":[1.1215,4.7103,1.1215],"gpt-oss-20b":[0.11215,0.47103,0.11215],"llama-3.3-70b-instruct":[0.6,2.7,0.6],"mistral-small-4-119b":[0.56075,2.35515,0.56075],"qwen-image":[0.5,2.0,0.5],"qwen3-coder-next":[0.3,1.2,0.3],"qwen3-embedding-8b":[0.1,0.1,0.1],"qwen3-reranker-4b":[0.12,0.12,0.12],"qwen3.5-122b":[1.1215,4.7103,1.1215],"qwen3.5-9b":[0.078505,0.392525,0.078505],"qwen3.8-27b":[0.58,2.42,0.58]},"requesty":{"claude-fable-5":[11.0,55.0,1.1],"claude-fable-5.1":[10.0,50.0,0.25],"claude-fable-5.1@eu":[11.0,55.0,0.275],"claude-fable-5@eu":[11.0,55.0,1.1],"claude-haiku-4-5":[1.0,5.0,0.1],"claude-haiku-4-5@eu":[1.1,5.5,0.11],"claude-haiku-5-5":[0.1,0.5,0.01],"claude-haiku-5-5@eu":[0.11,0.55,0.02],"claude-opus-4-1":[15.0,75.0,1.5],"claude-opus-4-5":[5.0,25.0,0.5],"claude-opus-4-5@eu":[5.5,27.5,0.55],"claude-opus-4-6":[5.0,25.0,0.5],"claude-opus-4-6@eu":[5.5,27.5,0.55],"claude-opus-4-7":[5.0,25.0,0.5],"claude-opus-4-7@eu":[5.5,27.5,0.55],"claude-opus-4-8":[5.0,25.0,0.5],"claude-opus-4-8@eu":[5.5,27.5,0.55],"claude-opus-5":[5.0,25.0,0.5],"claude-opus-5-5":[4.0,20.0,0.2],"claude-opus-5-5@eu":[4.4,22.0,0.22],"claude-opus-5@eu":[5.5,27.5,0.55],"claude-sonnet-4-5":[3.0,15.0,0.3],"claude-sonnet-4-5@eu":[3.3,16.5,0.3],"claude-sonnet-4-6":[3.0,15.0,0.3],"claude-sonnet-4-6@eu":[3.3,16.5,0.3],"claude-sonnet-4@eu":[3.0,15.0,0.3],"claude-sonnet-5":[2.0,10.0,0.2],"claude-sonnet-5-5":[2.0,10.0,0.2],"claude-sonnet-5-5@eu":[2.2,11.0,0.22],"claude-sonnet-5@eu":[2.2,11.0,0.22],"deepseek-v4-flash":[0.28,0.56,0.07],"deepseek-v4-flash-0731":[0.28,0.56,0.07],"deepseek-v4-flash-0731@eu":[0.28,0.56,0.07],"deepseek-v4-pro":[1.32,3.96,0.044],"deepseek-v4-pro-0813":[1.32,3.96,0.044],"deepseek-v4-pro-0813@eu":[1.75,3.5,0.44],"deepseek-v4-pro@eu":[1.75,3.5,0.44],"deepseek-v4.1-flash":[0.5,1.5,0.05],"deepseek-v4.1-flash-1017":[0.5,1.5,0.05],"deepseek-v4.1-flash-1017@eu":[0.5,1.5,0.05],"deepseek-v4.1-flash@eu":[0.5,1.5,0.05],"devstral-latest":[0.44,2.2,0.44],"devstral-latest@eu":[0.44,2.2,0.44],"fugu-ultra":[5.0,30.0,0.5],"gemini-2.5-flash-lite@eu":[0.1,0.4,0.01],"gemini-2.5-flash@eu":[0.3,2.5,0.075],"gemini-2.5-pro@eu":[1.25,10.0,0.31],"gemini-3-pro-image":[2.0,12.0,0.2],"gemini-3.1-flash-image":[0.5,2.0,0.5],"gemini-3.1-flash-lite":[0.25,1.5,0.025],"gemini-3.1-flash-lite@eu":[0.275,1.65,0.0275],"gemini-3.1-pro-preview":[2.0,12.0,0.2],"gemini-3.5-flash":[1.5,9.0,0.15],"gemini-3.5-flash-lite":[0.3,2.5,0.03],"gemini-3.5-flash-lite@eu":[0.33,2.75,0.033],"gemini-3.5-flash@eu":[1.65,9.9,0.165],"gemini-3.6-flash":[1.5,7.0,0.15],"gemini-3.7-flash":[0.75,3.75,0.075],"gemini-3.7-flash@eu":[0.825,4.125,0.0825],"gemini-3.8-flash":[0.75,3.75,0.075],"gemini-3.8-flash@eu":[0.825,4.125,0.0825],"gemini-4-argon":[2.0,10.0,0.1],"gemini-4-argon@eu":[2.2,11.0,0.11],"gemma-4-26b-a4b-it":[0.07,0.34,0.07],"gemma-4-31b-it":[0.0,0.0],"glm-5.1":[1.4,4.4,0.26],"glm-5.1@eu":[1.4,4.4,1.4],"glm-5.2":[0.8,2.55,0.16],"glm-5.2-fast":[2.1,6.6,0.21],"glm-5.2@eu":[1.2,4.2,0.26],"glm-5.3":[1.2,4.2,0.26],"glm-5.3-flash":[0.2,0.6,0.07],"glm-5.3-flash@eu":[0.2,0.6,0.07],"glm-5.3@eu":[1.2,4.2,0.26],"gpt-4.1-mini@eu":[0.44,1.76,0.11],"gpt-4.1-nano@eu":[0.11,0.44,0.0275],"gpt-4.1@eu":[2.2,8.8,0.55],"gpt-4o-mini@eu":[0.165,0.66,0.0825],"gpt-5-mini@eu":[0.275,2.2,0.0275],"gpt-5-nano@eu":[0.055,0.44,0.0055],"gpt-5.1@eu":[1.375,11.0,0.1375],"gpt-5.3-codex":[1.75,14.0,0.175],"gpt-5.4":[2.75,16.5,0.275],"gpt-5.4-mini":[0.75,4.5,0.075],"gpt-5.4-nano":[0.2,1.25,0.02],"gpt-5.4-pro":[30.0,180.0,30.0],"gpt-5.4@eu":[2.75,16.5,0.275],"gpt-5.5":[5.5,33.0,0.55],"gpt-5.5-pro":[30.0,180.0,30.0],"gpt-5.5@eu":[5.5,33.0,0.55],"gpt-5.6-luna":[0.2,1.2,0.02],"gpt-5.6-luna@eu":[0.22,1.32,0.022],"gpt-5.6-sol":[4.0,20.0,0.4],"gpt-5.6-sol@eu":[4.4,22.0,0.44],"gpt-5.6-terra":[2.0,12.0,0.2],"gpt-5.6-terra@eu":[2.2,13.2,0.22],"gpt-5@eu":[1.375,11.0,0.1375],"gpt-6-astra":[10.0,50.0,1.0],"gpt-6-luna":[0.1,0.5,0.01],"gpt-6-luna@eu":[0.12,0.6,0.012],"gpt-6-sol":[2.0,10.0,0.2],"gpt-6-sol@eu":[2.4,12.0,0.24],"gpt-6.1-sol":[2.0,10.0,0.1],"gpt-6.1-sol@eu":[2.4,12.0,0.12],"gpt-6.1-terra":[1.0,5.0,0.05],"gpt-6.1-terra@eu":[1.2,6.0,0.06],"grok-4.2-beta":[2.0,6.0,0.2],"grok-4.3":[1.25,2.5,0.2],"grok-4.5":[2.0,6.0,0.5],"grok-4.6":[2.0,6.0,0.5],"grok-4.7":[2.0,6.0,0.5],"grok-build-0.1":[1.0,2.0,0.1],"hy3":[0.14,0.58,0.035],"inkling":[1.87,4.68,0.374],"inkling-256k":[1.87,4.68,0.374],"kat-coder-pro":[0.3,1.2,0.3],"kimi-k2.5@eu":[0.72,3.6,0.72],"kimi-k2.6":[0.95,4.0,0.16],"kimi-k2.6@eu":[0.95,4.0,0.95],"kimi-k2.7-code":[0.95,4.0,0.19],"kimi-k2.7-code@eu":[1.25,4.5,0.31],"kimi-k3":[3.0,15.0,0.45],"kimi-k3.1-pro":[2.0,10.0,0.2],"kimi-k3.1-pro-highspeed":[4.0,20.0,0.2],"kimi-k3@eu":[3.0,15.0,0.45],"laguna-m.1":[0.0,0.0],"laguna-xs.2":[0.0,0.0],"leanstral-1-5":[0.0,0.0],"leanstral-1-5@eu":[0.0,0.0],"ling-2.6-1t":[0.3,2.5,0.3],"ling-2.6-flash":[0.1,0.3,0.1],"ling-3.0-tiny":[0.0,0.0],"mimo-v2.5":[0.14,0.28,0.0028],"mimo-v2.5-pro":[0.435,0.87,0.0036],"mimo-v2.6-flash":[0.14,0.28,0.0027],"mimo-v2.6-pro":[0.43,0.87,0.0036],"minimax-m2.7":[0.3,1.2,0.06],"minimax-m2.7-highspeed":[0.6,2.4,0.06],"minimax-m3":[0.3,1.2,0.06],"minimax-m3.1-flash":[0.15,0.6,0.015],"minimax-m3.1-flash@eu":[0.3,1.2,0.07],"minimax-m3@eu":[0.4,2.0,0.1],"mistral-large-4":[0.68,2.09,0.07],"mistral-large-4@eu":[0.68,2.09,0.07],"mistral-medium-3-5":[1.65,8.25,1.65],"mistral-medium-3-5@eu":[1.65,8.25,1.65],"mistral-medium-latest":[0.44,2.2,0.44],"mistral-medium-latest@eu":[0.44,2.2,0.44],"mistral-small-2603":[0.165,0.66,0.165],"mistral-small-2603@eu":[0.165,0.66,0.165],"muse-glimmer-30b":[0.0,0.0],"muse-spark-1.3":[1.25,4.25,0.15],"muse-spark-open":[1.25,4.25,0.15],"muse-wonder-1.0":[4.0,20.0,0.2],"nemotron-3-nano-omni":[0.06,0.24,0.06],"nemotron-3-nano-omni-30b-a3b-reasoning":[0.0,0.0],"nemotron-3-nano-omni@eu":[0.06,0.24,0.06],"nemotron-3-super-120b-a12b":[0.0,0.0],"nemotron-3-ultra-550b-a55b":[0.0,0.0],"nemotron-3-ultra-nvfp4":[0.6,2.4,0.12],"nemotron-3.5-content-safety":[0.0,0.0],"nemotron-3.5-lightning-30b-a3b":[0.0,0.0],"nemotron-lightning-3.5-30b-a3b":[0.05,0.2,0.01],"nvidia-nemotron-3-super-120b-a12b":[0.1,0.5,0.1],"nvidia-nemotron-3-ultra":[0.5,2.5,0.5],"o4-mini@eu":[1.21,4.84,0.3025],"qwen3.5-27b":[0.26,2.6,0.26],"qwen3.5-2b":[0.02,0.1,0.02],"qwen3.5-35b-a3b":[0.14,1.0,0.05],"qwen3.6-plus":[0.5,3.0,0.05],"qwen3.7-max":[2.5,7.5,0.25],"qwen3.7-plus":[0.32,1.28,0.032],"qwen3.8-2.4t-a95b":[2.0,6.0,0.2],"qwen3.8-2.4t-a95b@eu":[2.5,6.0,0.63],"qwen3.8-flash":[0.16,0.47,0.016],"qwen3.8-flash-next":[0.2,0.5,0.05],"qwen3.8-flash-next@eu":[0.2,0.5,0.05],"qwen3.8-max":[2.0,6.0,0.25],"ring-2.6-1t":[0.3,2.5,0.3],"seed-1.8":[0.25,2.0,0.05],"seed-2.0-code":[0.5,3.0,0.1],"seed-2.0-mini":[0.1,0.4,0.02],"seed-2.0-pro":[0.5,3.0,0.1],"step-3.7-flash":[0.2,1.15,0.04],"step-5-preview":[1.0,2.7,0.05]},"routing-run":{"claude-opus-4-8":[5.0,25.0,5.0],"claude-sonnet-4-6":[3.0,15.0,3.0],"deepseek-v4-flash":[0.112,0.224,0.112],"deepseek-v4-pro":[0.348,0.696,0.348],"glm-5.2":[0.8,2.4,0.8],"glm-5.2-nitro":[0.8,2.4,0.8],"gpt-5.6-luna":[0.7,4.2,0.7],"gpt-5.6-sol":[2.5,15.0,2.5],"gpt-5.6-terra":[1.5,9.0,1.5],"kimi-k2.6":[0.275,1.1,0.275],"kimi-k2.6-nitro":[0.275,1.1,0.275],"kimi-k2.7-code":[0.275,1.1,0.275],"kimi-k2.7-code-nitro":[0.275,1.1,0.275],"nemotron-3-ultra":[0.1,0.1,0.1],"qwen3.5-9b":[0.16,0.48,0.16]},"runinfra":{"deepseek-ai/deepseek-v4-flash-0731":[0.13,0.27,0.01],"deepseek-ai/deepseek-v4-pro-0813":[0.6,1.9,0.03],"inferact/qwen3.8-2.4t-a95b-nvfp4":[2.0,6.0,0.2],"nvidia/nvidia-nemotron-3.5-lightning-30b-a3b-bf16":[0.05,0.15,0.01],"ornith-ai/ornith-1.5-35b-a3b":[0.1,0.4,0.01],"qwen/qwen3.8-27b":[0.1,0.4,0.01],"zai-org/glm-5.3":[1.3,4.2,0.13],"zai-org/glm-5.3-flash":[0.11,0.45,0.03]},"sakana":{"fugu-ultra":[5.0,30.0,0.5],"fugu-ultra-20260615":[5.0,30.0,0.5],"sakana-namazu":[0.95,4.0,0.15]},"salad-cloud":{"qwen3.6-35b-a3b":[0.09,0.6,0.09]},"sambanova":{"deepseek-v3.1":[3.0,4.5,3.0],"deepseek-v3.2":[3.0,4.5,3.0],"gemma-4-31b-it":[0.38,1.15,0.38],"gpt-oss-120b":[0.22,0.59,0.22],"meta-llama-3.3-70b-instruct":[0.6,1.2,0.6],"minimax-m3":[0.6,2.4,0.06]},"sap-ai-core":{"amazon--nova-lite":[0.3,2.5,0.3],"amazon--nova-micro":[0.035,0.14,0.035],"amazon--nova-pro":[0.8,3.2,0.8],"amazon--titan-embed-text":[0.02,0.0,0.02],"anthropic--claude-3-haiku":[0.25,1.25,0.03],"anthropic--claude-4-opus":[15.0,75.0,1.5],"anthropic--claude-4-sonnet":[3.0,15.0,0.3],"anthropic--claude-4.5-haiku":[1.0,5.0,0.1],"anthropic--claude-4.5-opus":[5.0,25.0,0.5],"anthropic--claude-4.5-sonnet":[3.0,15.0,0.3],"anthropic--claude-4.6-opus":[5.0,25.0,0.5],"anthropic--claude-4.6-sonnet":[3.0,15.0,0.3],"anthropic--claude-4.7-opus":[5.0,25.0,0.5],"anthropic--claude-4.8-opus":[5.0,25.0,0.5],"cohere--command-a-reasoning":[2.5,10.0,2.5],"gemini-2.5-flash":[0.3,2.5,0.03],"gemini-2.5-flash-lite":[0.1,0.4,0.01],"gemini-2.5-pro":[1.25,10.0,0.125],"gemini-3.1-flash-lite":[0.25,1.5,0.025],"gemini-3.5-flash":[1.5,9.0,0.15],"gpt-4.1":[2.0,8.0,0.5],"gpt-4.1-mini":[0.4,1.6,0.1],"gpt-4.1-nano":[0.1,0.4,0.1],"gpt-5":[1.25,10.0,0.125],"gpt-5-mini":[0.25,2.0,0.025],"gpt-5-nano":[0.05,0.4,0.005],"gpt-5.2":[1.75,14.0,0.175],"gpt-5.4":[2.5,15.0,0.25],"gpt-5.5":[5.0,30.0,0.5],"gpt-5.6-luna":[0.2,1.2,0.02],"gpt-5.6-sol":[4.0,20.0,0.4],"gpt-5.6-terra":[2.0,12.0,0.2],"mistralai--mistral-medium-instruct":[0.4,2.0,0.4],"mistralai--mistral-small":[0.15,0.6,0.15],"sonar":[1.0,1.0,1.0],"sonar-deep-research":[2.0,8.0,2.0],"sonar-pro":[3.0,15.0,3.0],"text-embedding-3-large":[0.13,0.0,0.13],"text-embedding-3-small":[0.02,0.0,0.02]},"sarvam":{"sarvam-105b":[0.15790269,0.63161075,0.05263423]},"scaleway":{"bge-multilingual-gemma2":[0.11215,0.0,0.11215],"deepseek-v4-flash-0731":[0.468,0.936,0.0936],"deepseek-v4.1-flash":[0.672,2.016,0.134],"gemma-4-26b-a4b-it":[0.280375,0.56075,0.280375],"glm-5.2":[2.0187,6.16825,2.0187],"glm-5.3":[2.01,6.15,2.01],"gpt-oss-120b":[0.168225,0.6729,0.168225],"lightonocr-3-0.8b":[2.464,0.0,2.464],"llama-3.3-70b-instruct":[1.00935,1.00935,1.00935],"mistral-medium-3.5-128b":[1.68225,8.41125,1.68225],"mistral-small-3.2-24b-instruct-2506":[0.168225,0.392525,0.168225],"qwen3-235b-a22b-instruct-2507":[0.841125,2.523375,0.841125],"qwen3-embedding-8b":[0.11215,0.0,0.11215],"qwen3.5-397b-a17b":[0.6729,4.0374,0.6729],"qwen3.6-35b-a3b":[0.280375,1.68225,0.280375],"qwen3.8-27b":[0.684,3.762,0.137]},"scnet-token-plan":{"deepseek-v4-flash":[0.0,0.0],"deepseek-v4-flash-0731":[0.0,0.0],"deepseek-v4-pro":[0.0,0.0],"deepseek-v4-pro-0813":[0.0,0.0],"deepseek-v4.1-flash":[0.0,0.0],"glm-5":[0.0,0.0],"glm-5.1":[0.0,0.0],"glm-5.2":[0.0,0.0],"glm-5.3":[0.0,0.0],"glm-5.3-flash":[0.0,0.0],"kimi-k2.5":[0.0,0.0],"kimi-k2.6":[0.0,0.0],"kimi-k2.7-code":[0.0,0.0],"kimi-k3":[0.0,0.0],"minimax-m2.5":[0.0,0.0],"minimax-m2.7":[0.0,0.0],"minimax-m3":[0.0,0.0],"qwen3.8-flash":[0.0,0.0],"qwen3.8-max":[0.0,0.0]},"scx-ai":{"glm-5.2":[0.55,1.784,0.111],"gpt-oss-120b":[0.17,0.55,0.17],"minimax-m2.7":[0.48,1.79,0.05],"qwen3.8-max":[1.815,5.4461,0.17]},"sensenova":{"deepseek-v4-flash":[0.0,0.0],"deepseek-v4-pro":[0.0,0.0],"deepseek-v4.1-flash":[0.0,0.0],"glm-5.2":[0.0,0.0],"kimi-k3":[0.0,0.0],"sensenova-6.8-flash-lite":[0.0,0.0]},"siliconflow":{"bytedance-seed/seed-oss-36b-instruct":[0.21,0.57,0.21],"deepseek-ai/deepseek-r1":[0.5,2.18,0.5],"deepseek-ai/deepseek-v3":[0.25,1.0,0.25],"deepseek-ai/deepseek-v3.1":[0.27,1.0,0.27],"deepseek-ai/deepseek-v3.1-terminus":[0.27,1.0,0.27],"deepseek-ai/deepseek-v3.2":[0.27,0.42,0.135],"deepseek-ai/deepseek-v3.2-exp":[0.27,0.41,0.27],"deepseek-ai/deepseek-v4-flash":[0.13,0.28,0.028],"deepseek-ai/deepseek-v4-flash-0731":[0.22,0.66,0.014],"deepseek-ai/deepseek-v4-flash-vision-exp":[0.44,1.32,0.028],"deepseek-ai/deepseek-v4-pro":[1.50162,3.135,0.135],"deepseek-ai/deepseek-v4-pro-0813":[1.32,3.96,0.044],"google/gemma-4-12b-it":[0.1,0.3,0.1],"google/gemma-4-26b-a4b-it":[0.14,0.4,0.05],"google/gemma-4-31b-it":[0.75,1.0,0.25],"inclusionai/ling-flash-2.0":[0.14,0.57,0.14],"meituan-longcat/longcat-2.0":[0.75,2.95,0.015],"minimaxai/minimax-m2.5":[0.3,1.2,0.03],"minimaxai/minimax-m3":[0.3,1.2,0.06],"moonshotai/kimi-k2.5":[0.45,2.25,0.07],"moonshotai/kimi-k2.6":[0.77,3.4,0.14],"moonshotai/kimi-k2.7-code":[0.85916,3.8,0.17993],"moonshotai/kimi-k3":[2.7,13.5,0.27],"nex-agi/nex-n2-pro":[0.5,2.5,0.25],"openai/gpt-oss-120b":[0.05,0.45,0.05],"openai/gpt-oss-20b":[0.04,0.18,0.04],"qwen/qwen2.5-72b-instruct":[0.59,0.59,0.59],"qwen/qwen2.5-7b-instruct":[0.05,0.05,0.05],"qwen/qwen3-14b":[0.07,0.28,0.07],"qwen/qwen3-30b-a3b-instruct-2507":[0.09,0.3,0.09],"qwen/qwen3-32b":[0.14,0.57,0.14],"qwen/qwen3-8b":[0.06,0.06,0.06],"qwen/qwen3-coder-30b-a3b-instruct":[0.07,0.28,0.07],"qwen/qwen3-coder-480b-a35b-instruct":[0.25,1.0,0.25],"qwen/qwen3-vl-30b-a3b-instruct":[0.29,1.0,0.29],"qwen/qwen3-vl-30b-a3b-thinking":[0.29,1.0,0.29],"qwen/qwen3-vl-32b-instruct":[0.2,0.6,0.2],"qwen/qwen3-vl-32b-thinking":[0.2,1.5,0.2],"qwen/qwen3-vl-8b-instruct":[0.18,0.68,0.18],"qwen/qwen3.5-122b-a10b":[0.26,2.08,0.26],"qwen/qwen3.5-27b":[0.25,2.0,0.25],"qwen/qwen3.5-35b-a3b":[0.24,1.8,0.15],"qwen/qwen3.5-397b-a17b":[0.39,2.34,0.39],"qwen/qwen3.5-9b":[0.1,0.15,0.1],"qwen/qwen3.6-27b":[0.3,3.2,0.3],"qwen/qwen3.6-35b-a3b":[0.24,1.8,0.15],"qwen/qwen3.8-2.4t-a95b":[2.0,6.0,0.25],"stepfun-ai/step-3.5-flash":[0.1,0.3,0.1],"tencent/hunyuan-a13b-instruct":[0.14,0.57,0.14],"tencent/hy3":[0.132,0.528,0.033],"zai-org/glm-4.5-air":[0.14,0.86,0.14],"zai-org/glm-5":[0.95,2.55,0.2],"zai-org/glm-5.1":[1.19,3.74,0.6],"zai-org/glm-5.2":[1.302,4.092,0.26],"zai-org/glm-5.3":[1.4,4.4,0.26],"zai-org/glm-5.3-flash":[0.15,0.5,0.03],"zai-org/glm-5v-turbo":[1.2,4.0,0.24]},"siliconflow-cn":{"bytedance-seed/seed-oss-36b-instruct":[0.22417122,0.59778991,0.22417122],"deepseek-ai/deepseek-ocr":[0.0,0.0],"deepseek-ai/deepseek-r1":[0.59778991,2.39115964,0.05977899],"deepseek-ai/deepseek-v3":[0.29889496,1.19557982,0.0298895],"deepseek-ai/deepseek-v3.1-terminus":[0.59778991,1.79336973,0.05977899],"deepseek-ai/deepseek-v3.2":[0.59778991,0.89668487,0.05977899],"deepseek-ai/deepseek-v4-flash":[0.44834243,1.3450273,0.04483424],"deepseek-ai/deepseek-v4-pro":[1.79336973,3.58673947,0.14944748],"inclusionai/ling-flash-2.0":[0.14944748,0.59778991,0.14944748],"paddlepaddle/paddleocr-vl-1.5":[0.0,0.0],"pro/deepseek-ai/deepseek-r1":[0.59778991,2.39115964,0.05977899],"pro/deepseek-ai/deepseek-v3":[0.29889496,1.19557982,0.0298895],"pro/deepseek-ai/deepseek-v3.1-terminus":[0.59778991,1.79336973,0.05977899],"pro/deepseek-ai/deepseek-v3.2":[0.59778991,0.89668487,0.05977899],"pro/moonshotai/kimi-k2.5":[0.45,2.25,0.07],"pro/moonshotai/kimi-k2.6":[0.97140861,4.0350819,0.16439223],"pro/zai-org/glm-5":[1.0,3.2,1.0],"pro/zai-org/glm-5.1":[0.89668487,3.58673947,0.19428172],"qwen/qwen2.5-72b-instruct":[0.61721808,0.61721808,0.61721808],"qwen/qwen2.5-7b-instruct":[0.0,0.0],"qwen/qwen3-14b":[0.07472374,0.29889496,0.07472374],"qwen/qwen3-30b-a3b-instruct-2507":[0.10461323,0.41845294,0.10461323],"qwen/qwen3-32b":[0.14944748,0.59778991,0.14944748],"qwen/qwen3-8b":[0.0,0.0],"qwen/qwen3-coder-30b-a3b-instruct":[0.10461323,0.41845294,0.10461323],"qwen/qwen3-vl-30b-a3b-instruct":[0.10461323,0.41845294,0.10461323],"qwen/qwen3-vl-30b-a3b-thinking":[0.10461323,0.41845294,0.10461323],"qwen/qwen3-vl-32b-instruct":[0.14944748,0.59778991,0.14944748],"qwen/qwen3-vl-32b-thinking":[0.14944748,1.49447478,0.14944748],"qwen/qwen3-vl-8b-instruct":[0.07472374,0.29889496,0.07472374],"qwen/qwen3.5-122b-a10b":[0.11955798,0.95646386,0.11955798],"qwen/qwen3.5-27b":[0.08966849,0.71734789,0.08966849],"qwen/qwen3.5-35b-a3b":[0.05977899,0.47823193,0.05977899],"qwen/qwen3.5-4b":[0.0,0.0],"qwen/qwen3.5-9b":[0.07472374,0.59778991,0.07472374],"qwen/qwen3.6-35b-a3b":[0.26900546,1.61403276,0.26900546],"stepfun-ai/step-3.5-flash":[0.10461323,0.3138397,0.10461323],"tencent/hunyuan-a13b-instruct":[0.14944748,0.59778991,0.14944748],"zai-org/glm-4.5-air":[0.14944748,0.89668487,0.14944748],"zai-org/glm-5.2":[1.19557982,4.18452938,0.29889496]},"snowflake-cortex":{"claude-fable-5":[10.0,50.0,1.0],"claude-haiku-4-5":[1.0,5.0,0.1],"claude-opus-4-5":[5.0,25.0,0.5],"claude-opus-4-6":[5.0,25.0,0.5],"claude-opus-4-7":[5.0,25.0,0.5],"claude-opus-4-8":[5.0,25.0,0.5],"claude-opus-5":[5.0,25.0,0.5],"claude-sonnet-4-5":[3.0,15.0,0.3],"claude-sonnet-4-6":[3.0,15.0,0.3],"claude-sonnet-5":[2.0,10.0,0.2],"mistral-large2":[2.0,6.0,2.0],"openai-gpt-4.1":[2.0,8.0,0.5],"openai-gpt-5":[1.25,10.0,0.13],"openai-gpt-5-mini":[0.25,2.0,0.03],"openai-gpt-5-nano":[0.06,0.44,0.01],"openai-gpt-5.1":[1.25,10.0,0.13],"openai-gpt-5.2":[1.75,14.0,0.18],"openai-gpt-5.4":[2.5,15.0,0.25],"openai-gpt-5.5":[5.0,30.0,0.5],"openai-gpt-5.6-luna":[0.2,1.2,0.02],"openai-gpt-5.6-sol":[4.0,20.0,0.4],"openai-gpt-5.6-terra":[2.0,12.0,0.2]},"stackit":{"cortecs/llama-3.3-70b-instruct-fp8-dynamic":[0.53,0.76,0.53],"google/gemma-3-27b-it":[0.53,0.76,0.53],"intfloat/e5-mistral-7b-instruct":[0.02243,0.0,0.02243],"openai/gpt-oss-120b":[0.53,0.76,0.53],"openai/gpt-oss-20b":[0.18,0.29,0.18],"qwen/qwen3-vl-235b-a22b-instruct-fp8":[1.76,2.05,1.76],"qwen/qwen3-vl-embedding-8b":[0.09,0.0,0.09],"qwen/qwen3.6-27b":[0.53,0.76,0.53]},"standardcompute":{"anthropic/claude-fable-5":[10.0,50.0,1.0],"anthropic/claude-fable-5.1":[10.0,50.0,0.25],"anthropic/claude-haiku-5.5":[0.1,0.5,0.01],"anthropic/claude-opus-5":[5.0,25.0,0.5],"anthropic/claude-opus-5.5":[4.0,20.0,0.2],"anthropic/claude-sonnet-5":[2.0,10.0,0.2],"anthropic/claude-sonnet-5.5":[2.0,10.0,0.1],"deepseek/deepseek-v4-flash":[0.0826,0.1652,0.01652],"deepseek/deepseek-v4-flash-0731":[0.44,1.32,0.014],"deepseek/deepseek-v4-pro":[1.044,2.088,0.2088],"deepseek/deepseek-v4-pro-0813":[1.122,3.366,0.1122],"deepseek/deepseek-v4.1-flash":[0.14,0.42,0.0042],"google/gemini-2.5-flash":[0.3,2.5,0.03],"google/gemini-2.5-pro":[1.25,10.0,0.125],"google/gemini-3.1-pro-preview":[2.0,12.0,0.2],"google/gemini-3.5-flash-lite":[0.3,2.5,0.03],"google/gemini-3.8-flash":[0.75,3.75,0.075],"minimax/minimax-m3":[0.3,1.2,0.06],"mistralai/mistral-large-4-0":[0.68,2.09,0.07],"moonshotai/kimi-k3":[3.0,15.0,0.3],"openai/gpt-5.6-luna":[0.2,1.2,0.02],"openai/gpt-5.6-sol":[4.0,20.0,0.4],"openai/gpt-5.6-terra":[2.0,12.0,0.2],"openai/gpt-6-astra":[10.0,50.0,1.0],"openai/gpt-6-luna":[0.1,0.5,0.01],"qwen/qwen3.7-flash":[0.03,0.13,0.006],"qwen/qwen3.7-max":[1.475,4.425,0.295],"qwen/qwen3.7-plus":[0.32,1.28,0.064],"qwen/qwen3.8-27b":[0.425,2.55,0.085],"qwen/qwen3.8-flash":[0.15,0.47,0.016],"qwen/qwen3.8-max-0902":[2.0,6.0,0.25],"x-ai/grok-4.3":[1.25,2.5,0.2],"xiaomi/mimo-v2.5":[0.14,0.28,0.0028],"xiaomi/mimo-v2.5-pro":[0.435,0.87,0.0036],"xiaomi/mimo-v2.6-flash":[0.14,0.28,0.0028],"xiaomi/mimo-v2.6-pro":[0.43,0.87,0.0036],"z-ai/glm-5.2":[0.5625,1.8,0.105],"z-ai/glm-5.3":[1.4,4.4,0.26],"z-ai/glm-5.3-flash":[0.08,0.5,0.012]},"stepfun":{"step-3.5-flash":[0.10461,0.31384,0.02092],"step-3.5-flash-2603":[0.10461,0.31384,0.02092],"step-3.7-flash":[0.20175,1.21052,0.04035],"step-5-preview":[1.04613,2.98895,0.10461]},"stepfun-ai":{"step-3.5-flash":[0.1,0.3,0.02],"step-3.5-flash-2603":[0.1,0.3,0.02],"step-3.7-flash":[0.2,1.15,0.04],"step-5-preview":[1.0,2.7,0.1]},"subconscious":{"subconscious/deepseek-v4.1-flash-marathon":[0.14,0.28,0.0028],"subconscious/glm-5.3-marathon":[1.4,4.4,0.26]},"submodel":{"deepseek-ai/deepseek-r1-0528":[0.2,0.8,0.2],"deepseek-ai/deepseek-v3-0324":[0.2,0.8,0.2],"deepseek-ai/deepseek-v3.1":[0.2,0.8,0.2],"openai/gpt-oss-120b":[0.1,0.5,0.1],"qwen/qwen3-235b-a22b-instruct-2507":[0.2,0.3,0.2],"qwen/qwen3-235b-a22b-thinking-2507":[0.2,0.6,0.2],"qwen/qwen3-coder-480b-a35b-instruct-fp8":[0.2,0.8,0.2],"zai-org/glm-4.5-air":[0.1,0.5,0.1],"zai-org/glm-4.5-fp8":[0.2,0.8,0.2]},"synthetic":{"hf:deepseek-ai/deepseek-v4.1-flash":[0.6,1.2,0.03],"hf:deepseek-ai/deepseek-v4.1-flash-1017":[0.6,1.2,0.03],"hf:minimaxai/minimax-m3":[0.6,1.2,0.6],"hf:moonshotai/kimi-k2.7-code":[0.95,4.0,0.95],"hf:moonshotai/kimi-k3":[3.0,15.0,0.45],"hf:nvidia/nvidia-nemotron-3-super-120b-a12b-nvfp4":[0.3,1.0,0.06],"hf:openai/gpt-oss-120b":[0.1,0.1,0.02],"hf:qwen/qwen3.6-27b":[0.45,3.6,0.45],"hf:zai-org/glm-4.7-flash":[0.1,0.5,0.02],"hf:zai-org/glm-5.2":[1.4,4.4,1.4],"hf:zai-org/glm-5.3":[1.4,4.4,0.26],"hf:zai-org/glm-5.3-flash":[0.15,0.5,0.04]},"tempr":{"anthropic/claude-fable-5":[10.0,50.0,1.0],"anthropic/claude-fable-5-1":[10.0,50.0,0.25],"anthropic/claude-haiku-4-5":[1.0,5.0,0.1],"anthropic/claude-haiku-4-5-20251001":[1.0,5.0,0.1],"anthropic/claude-opus-4-5":[5.0,25.0,0.5],"anthropic/claude-opus-4-5-20251101":[5.0,25.0,0.5],"anthropic/claude-opus-4-6":[5.0,25.0,0.5],"anthropic/claude-opus-4-7":[5.0,25.0,0.5],"anthropic/claude-opus-4-8":[5.0,25.0,0.5],"anthropic/claude-opus-5":[5.0,25.0,0.5],"anthropic/claude-sonnet-4-5":[3.0,15.0,0.3],"anthropic/claude-sonnet-4-5-20250929":[3.0,15.0,0.3],"anthropic/claude-sonnet-4-6":[3.0,15.0,0.3],"anthropic/claude-sonnet-5":[2.0,10.0,0.2],"cerebras/gpt-oss-120b":[0.35,0.75,0.35],"cerebras/qwen-3.8-27b":[0.99,1.49,0.99],"deepseek/deepseek-flash":[0.15,0.6,0.003],"deepseek/deepseek-v4-pro":[0.66,1.98,0.022],"google/gemini-3-flash-preview":[0.5,3.0,0.05],"google/gemini-3.1-flash-lite":[0.25,1.5,0.025],"google/gemini-3.1-pro-preview":[2.0,12.0,0.2],"google/gemini-3.1-pro-preview-customtools":[2.0,12.0,0.2],"google/gemini-3.5-flash":[1.5,9.0,0.15],"google/gemini-3.5-flash-lite":[0.3,2.5,0.03],"google/gemini-3.6-flash":[0.75,3.75,0.075],"google/gemini-3.7-flash":[0.75,3.75,0.075],"google/gemini-3.8-flash":[0.75,3.75,0.075],"google/gemini-embedding-001":[0.15,0.0,0.15],"google/gemini-embedding-2":[0.2,0.0,0.2],"google/gemini-flash-latest":[0.75,3.75,0.075],"google/gemini-flash-lite-latest":[0.3,2.5,0.03],"groq/allam-2-7b":[0.0,0.0],"groq/openai/gpt-oss-120b":[0.15,0.6,0.075],"groq/openai/gpt-oss-20b":[0.075,0.3,0.0375],"groq/qwen/qwen3.8-27b":[0.8,4.0,0.4],"minimax/minimax-m2.7":[0.3,1.2,0.06],"minimax/minimax-m2.7-highspeed":[0.6,2.4,0.06],"minimax/minimax-m3":[0.3,1.2,0.06],"mistral/mistral-embed":[0.1,0.0,0.1],"mistral/mistral-large-2512":[0.5,1.5,0.05],"mistral/mistral-large-latest":[0.5,1.5,0.05],"mistral/mistral-medium-2604":[1.5,7.5,0.15],"mistral/mistral-medium-latest":[1.5,7.5,0.15],"mistral/mistral-small-2603":[0.15,0.6,0.015],"mistral/mistral-small-latest":[0.15,0.6,0.015],"mistral/voxtral-small-latest":[0.1,0.4,0.1],"mistral/zai-glm-5-2":[1.4,4.4,0.14],"mistral/zai-glm-5-3":[1.4,4.4,0.14],"moonshot/kimi-k2.6":[0.95,4.0,0.16],"moonshot/kimi-k2.7-code":[0.95,4.0,0.19],"moonshot/kimi-k2.7-code-highspeed":[1.9,8.0,0.38],"moonshot/kimi-k3":[3.0,15.0,0.3],"xai/grok-4.20-0309-non-reasoning":[1.25,2.5,0.2],"xai/grok-4.20-0309-reasoning":[1.25,2.5,0.2],"xai/grok-4.3":[1.25,2.5,0.2],"xai/grok-4.5":[2.0,6.0,0.3],"xai/grok-4.6":[2.0,6.0,0.5],"xai/grok-4.7":[2.0,6.0,0.5],"xai/grok-build-0.1":[1.0,2.0,0.2],"xiaomi-mimo/mimo-v2.6-flash":[0.14,0.28,0.0028],"xiaomi-mimo/mimo-v2.6-pro":[0.435,0.87,0.0036],"xiaomi-mimo/mimo-v2.6-pro-ultraspeed":[4.35,8.7,0.036],"zai/glm-4.5":[0.6,2.2,0.11],"zai/glm-4.5-air":[0.2,1.1,0.03],"zai/glm-4.5-flash":[0.0,0.0],"zai/glm-4.5v":[0.6,1.8,0.11],"zai/glm-4.6":[0.6,2.2,0.11],"zai/glm-4.6v":[0.3,0.9,0.05],"zai/glm-4.6v-flash":[0.0,0.0],"zai/glm-4.7":[0.6,2.2,0.11],"zai/glm-4.7-flash":[0.0,0.0],"zai/glm-4.7-flashx":[0.07,0.4,0.01],"zai/glm-5":[1.0,3.2,0.2],"zai/glm-5-turbo":[1.2,4.0,0.24],"zai/glm-5.1":[1.4,4.4,0.26],"zai/glm-5.2":[1.4,4.4,0.26],"zai/glm-5.3":[1.4,4.4,0.26],"zai/glm-5.3-flash":[0.15,0.5,0.03],"zai/glm-5.3-flashx":[0.37,1.25,0.075],"zai/glm-5v-turbo":[1.2,4.0,0.24]},"tencent-coding-plan":{"glm-5":[0.0,0.0],"hunyuan-2.0-instruct":[0.0,0.0],"hunyuan-2.0-thinking":[0.0,0.0],"hunyuan-t1":[0.0,0.0],"hunyuan-turbos":[0.0,0.0],"kimi-k2.5":[0.0,0.0],"minimax-m2.5":[0.0,0.0],"tc-code-latest":[0.0,0.0]},"tencent-token-plan":{"hy3":[0.0,0.0],"hy4-preview":[0.834,2.501,0.042]},"tencent-tokenhub":{"hy3":[0.0,0.0],"hy3-preview":[0.0,0.0],"hy4-preview":[0.834,2.501,0.042]},"tensorx":{"deepseek/deepseek-r1-0528":[0.66,2.6,0.165],"deepseek/deepseek-v3.2":[0.3,0.5,0.075],"deepseek/deepseek-v4-flash-0731":[0.25,0.3,0.06],"deepseek/deepseek-v4-pro":[1.75,3.5,0.4375],"deepseek/deepseek-v4-pro-0813":[2.0,4.0,0.5],"deepseek/deepseek-v4.1-flash":[0.5,1.5,0.13],"minimax/minimax-m2.5":[0.3,1.2,0.075],"minimax/minimax-m3":[0.4,2.0,0.1],"moonshotai/kimi-k2.5":[0.5,2.8,0.125],"moonshotai/kimi-k2.6":[1.0,4.0,0.25],"moonshotai/kimi-k2.7-code":[1.25,4.5,0.3125],"moonshotai/kimi-k3":[3.0,15.0,0.75],"qwen/qwen3-235b-a22b-2507":[0.072,0.464,0.018],"qwen/qwen3.5-122b-a10b":[0.5,3.5,0.125],"qwen/qwen3.5-9b":[0.15,0.2,0.0375],"qwen/qwen3.8-2.4t-a95b":[2.5,6.0,0.63],"qwen/qwen3.8-27b":[0.4,2.4,0.1],"qwen/qwen3.8-flash-next":[0.2,0.5,0.05],"z-ai/glm-5":[1.0,3.2,0.25],"z-ai/glm-5-turbo":[1.2,4.0,0.3],"z-ai/glm-5.1":[1.4,4.4,0.35],"z-ai/glm-5.2":[1.5,4.5,0.375],"z-ai/glm-5.3":[1.75,4.5,0.44],"z-ai/glm-5.3-flash":[0.2,0.5,0.05],"z-ai/glm-5v-turbo":[1.2,4.0,0.3]},"thinkingmachines":{"deepseek-ai/deepseek-v3.1":[1.695,4.215,0.339],"deepseek-ai/deepseek-v4.1-flash-1017:peft:262144":[0.6,3.6,0.12],"deepseek-ai/deepseek-v4.1-flash:peft:262144":[0.6,3.6,0.12],"moonshotai/kimi-k2.6":[2.205,5.49,0.441],"moonshotai/kimi-k2.6:peft:131072":[2.205,5.49,0.441],"nvidia/nvidia-nemotron-3-nano-30b-a3b-bf16":[0.195,0.495,0.039],"nvidia/nvidia-nemotron-3-super-120b-a12b-bf16":[0.57,1.44,0.114],"nvidia/nvidia-nemotron-3-super-120b-a12b-bf16:peft:262144":[0.57,1.44,0.114],"nvidia/nvidia-nemotron-3-ultra-550b-a55b-bf16":[1.8,6.225,0.36],"nvidia/nvidia-nemotron-3-ultra-550b-a55b-bf16:peft:262144":[1.8,6.225,0.36],"nvidia/nvidia-nemotron-3.5-lightning-30b-a3b-bf16":[0.184,0.495,0.0368],"nvidia/nvidia-nemotron-3.5-lightning-30b-a3b-bf16:peft:262144":[0.184,0.495,0.0368],"nvidia/nvidia-nemotron-3.5-super-vl-120b-a12b-bf16":[0.57,1.44,0.114],"nvidia/nvidia-nemotron-3.5-super-vl-120b-a12b-bf16:peft:262144":[0.57,1.44,0.114],"openai/gpt-oss-120b":[0.33,0.84,0.066],"openai/gpt-oss-120b:peft:131072":[0.33,0.84,0.066],"openai/gpt-oss-20b":[0.18,0.45,0.036],"qwen/qwen3-8b":[0.195,0.6,0.039],"qwen/qwen3.5-35b-a3b-base":[0.54,1.335,0.108],"qwen/qwen3.5-397b-a17b":[1.65,7.5,0.33],"qwen/qwen3.5-397b-a17b:peft:262144":[1.65,7.5,0.33],"qwen/qwen3.5-4b":[0.33,1.005,0.066],"qwen/qwen3.5-4b:peft:262144":[0.33,1.005,0.066],"qwen/qwen3.5-9b":[0.3,0.807,0.06],"qwen/qwen3.5-9b-base":[0.3,0.807,0.06],"qwen/qwen3.6-27b":[1.86,5.595,0.372],"qwen/qwen3.6-35b-a3b":[0.45,1.335,0.09],"qwen/qwen3.6-35b-a3b:peft:262144":[0.45,1.335,0.09],"qwen/qwen3.8-27b":[0.6975,5.595,0.1395],"qwen/qwen3.8-27b:peft:262144":[0.6975,5.595,0.1395],"thinkingmachines/inkling":[1.87,4.68,0.374],"thinkingmachines/inkling-small":[0.58,1.44,0.116],"thinkingmachines/inkling-small:peft:262144":[0.58,1.44,0.116],"thinkingmachines/inkling-small:peft:262144:sampling-nvfp4":[0.3,1.2,0.06],"thinkingmachines/inkling:peft:262144":[1.87,4.68,0.374],"thinkingmachines/inkling:peft:262144:sampling-nvfp4":[1.0,4.05,0.17],"zai-org/glm-5.3-flash:peft:262144":[0.84,2.11,0.168],"zai-org/glm-5.3:peft:262144":[3.78,12.15,0.756]},"tinfoil":{"deepseek-v4-1-flash":[0.65,1.45,0.13],"gemma4-31b":[0.4,1.0,0.4],"glm-5-3":[1.8,5.75,0.45],"gpt-oss-120b":[0.15,0.6,0.15],"gpt-oss-safeguard-120b":[0.15,0.6,0.15],"kimi-k3":[4.0,20.0,0.8],"llama3-3-70b":[1.75,2.75,1.75],"nomic-embed-text":[0.05,0.0,0.05]},"togetherai":{"deepseek-ai/deepseek-r1":[3.0,7.0,3.0],"deepseek-ai/deepseek-v3":[1.25,1.25,1.25],"deepseek-ai/deepseek-v3-1":[0.6,1.7,0.6],"deepseek-ai/deepseek-v4-flash-0731":[0.14,0.28,0.03],"deepseek-ai/deepseek-v4-pro-0813":[1.32,3.96,0.13],"deepseek-ai/deepseek-v4.1-flash":[0.3,1.2,0.006],"essentialai/rnj-1-instruct":[0.15,0.15,0.15],"liquidai/lfm2-24b-a2b":[0.03,0.12,0.03],"meta-llama/llama-3.3-70b-instruct-turbo":[1.04,1.04,1.04],"meta-models/muse-spark-open-816b-a42b":[1.25,4.25,0.15],"minimaxai/minimax-m2.5":[0.3,1.2,0.06],"minimaxai/minimax-m2.7":[0.3,1.2,0.06],"minimaxai/minimax-m3":[0.3,1.2,0.06],"moonshotai/kimi-k3":[3.0,15.0,0.3],"nvidia/nemotron-3-ultra-550b-a55b":[0.6,3.6,0.2],"nvidia/nvidia-nemotron-3.5-super-vl":[0.15,0.5,0.02],"openai/gpt-oss-120b":[0.15,0.6,0.15],"qwen/qwen2.5-7b-instruct-turbo":[0.3,0.3,0.3],"qwen/qwen3-235b-a22b-instruct-2507-tput":[0.2,0.6,0.2],"qwen/qwen3-coder-480b-a35b-instruct-fp8":[2.0,2.0,2.0],"qwen/qwen3-coder-next-fp8":[0.5,1.2,0.5],"qwen/qwen3.5-397b-a17b":[0.6,3.6,0.35],"qwen/qwen3.5-9b":[0.17,0.25,0.17],"qwen/qwen3.6-plus":[0.5,3.0,0.5],"qwen/qwen3.7-max":[2.5,7.5,0.5],"reflection/beam-1.0-501b-a23b":[0.4,1.2,0.04],"thinkingmachines/inkling":[1.0,4.05,0.17],"zai-org/glm-5":[1.0,3.2,1.0],"zai-org/glm-5.1":[1.4,4.4,0.26],"zai-org/glm-5.2":[1.4,4.4,0.26],"zai-org/glm-5.3":[1.4,4.4,0.26],"zai-org/glm-5.3-flash":[0.15,0.5,0.03]},"tokengo":{"deepseek/deepseek-v3.1":[0.19,0.71,0.06],"deepseek/deepseek-v3.2":[0.2174,0.326,0.06],"deepseek/deepseek-v4-flash":[0.098,0.196,0.028],"deepseek/deepseek-v4-pro":[0.435,0.87,0.435],"minimax/minimax-m2.5":[0.3,1.2,0.03],"moonshotai/kimi-k2.6":[0.95,4.0,0.16],"moonshotai/kimi-k3":[3.0,15.0,0.3],"qwen/qwen3.5-397b-a17b":[0.4,2.65,0.2],"z-ai/glm-5":[0.89,3.2647,0.2226],"z-ai/glm-5.1":[1.4,4.4,0.26],"z-ai/glm-5.2":[1.4,4.4,0.26],"z-ai/glm-5.3":[1.4,4.4,0.26],"z-ai/glm-5.3-flash":[0.15,0.5,0.03]},"tokenrouter":{"z-ai/glm-5.3-free":[0.0,0.0]},"umans-ai":{"umans-coder":[0.15,0.5,0.03],"umans-deepseek-v4-flash-0731":[0.14,0.28,0.028],"umans-deepseek-v4.1-flash":[0.15,0.6,0.028],"umans-deepseek-v4.1-flash-1017":[0.15,0.6,0.028],"umans-flash":[0.15,1.0,0.05],"umans-glm-5.3":[1.4,4.4,0.26],"umans-glm-5.3-flash":[0.15,0.5,0.03],"umans-kimi-k3":[3.0,15.0,0.3]},"umans-ai-coding-plan":{"umans-coder":[0.0,0.0],"umans-deepseek-v4-flash-0731":[0.0,0.0],"umans-deepseek-v4.1-flash":[0.0,0.0],"umans-deepseek-v4.1-flash-1017":[0.0,0.0],"umans-flash":[0.0,0.0],"umans-glm-5.3":[0.0,0.0],"umans-glm-5.3-flash":[0.0,0.0],"umans-kimi-k3":[0.0,0.0],"umans-qwen3.6-35b-a3b":[0.0,0.0]},"unorouter":{"claude-haiku-4-5-20251001":[1.2,6.0,1.2],"claude-opus-4-8":[0.425,2.125,0.425],"claude-sonnet-5":[1.44,7.2,1.44],"deepseek-v4-flash":[0.0625,0.125,0.0625],"deepseek-v4-flash:free":[0.0,0.0],"deepseek-v4-pro":[0.8999,1.7999,0.8999],"deepseek-v4-pro:free":[0.0,0.0],"gemini-3.5-flash":[0.1857,1.1142,0.1857],"gemma-4-31b-it:free":[0.0,0.0],"glm-4.5-flash:free":[0.0,0.0],"glm-5.2":[1.6001,5.0288,1.6001],"glm-5.2:free":[0.0,0.0],"gpt-5.2":[1.05,8.4,1.05],"gpt-5.4":[1.8,10.8,1.8],"gpt-5.4:free":[0.0,0.0],"gpt-5.5":[0.1875,1.125,0.1875],"gpt-5.5:free":[0.0,0.0],"kimi-k2.6":[1.2675,5.3368,1.2675],"minimax-m2.7":[0.819,3.276,0.819],"minimax-m2.7:free":[0.0,0.0],"nemotron-3-ultra-550b-a55b:free":[0.0,0.0],"qwen3.5-397b-a17b:free":[0.0,0.0],"step-3.7-flash:free":[0.0,0.0]},"upstage":{"solar-mini":[0.15,0.15,0.15],"solar-mini4":[0.1,0.4,0.01],"solar-pro2":[0.25,0.25,0.25],"solar-pro3":[0.25,0.25,0.25],"solar-pro4":[0.3,1.2,0.06]},"vancine":{"deepseek-v4.1-flash":[0.24,0.96,0.0048],"glm-5.3":[1.12,3.52,0.208],"glm-5.3-flash":[0.12,0.4,0.024],"hy4-preview":[0.67,2.0,0.034],"kimi-k3":[2.4,12.0,0.24],"minimax-m3":[0.24,0.96,0.048],"qwen3.8-flash":[0.12,0.38,0.013],"qwen3.8-max":[1.6,4.8,0.2]},"venice":{"abliteration-abliterated-model-large-flash":[1.25,2.5,0.125],"abliteration-abliterated-model-large-v2":[3.0,5.0,0.3],"aion-labs-aion-3-0":[3.75,7.5,0.9375],"aion-labs-aion-3-0-mini":[0.875,1.75,0.225],"aion-labs-aion-3-5":[3.75,7.5,0.9375],"aion-labs-aion-3-5-mini":[0.875,1.75,0.225],"claude-fable-5":[10.0,50.0,1.0],"claude-fable-5-1":[10.0,50.0,0.25],"claude-haiku-5-5":[0.1,0.5,0.01],"claude-opus-4-5":[5.0,25.0,0.5],"claude-opus-4-6":[5.0,25.0,0.5],"claude-opus-4-7":[5.0,25.0,0.5],"claude-opus-4-8":[5.0,25.0,0.5],"claude-opus-4-8-fast":[10.0,50.0,1.0],"claude-opus-5":[5.0,25.0,0.5],"claude-opus-5-5":[4.0,20.0,0.2],"claude-opus-5-5-fast":[8.0,40.0,0.4],"claude-opus-5-fast":[10.0,50.0,1.0],"claude-sonnet-4-5":[3.0,15.0,0.3],"claude-sonnet-4-6":[3.0,15.0,0.3],"claude-sonnet-5":[2.0,10.0,0.2],"claude-sonnet-5-5":[2.0,10.0,0.1],"deepseek-v3.2":[0.33,0.48,0.16],"deepseek-v4-1-flash":[0.3,1.2,0.0075],"deepseek-v4-1-flash-1017":[0.3,1.2,0.0075],"deepseek-v4-1-flash-1017-uncensored":[0.33,1.32,0.00825],"deepseek-v4-1-flash-uncensored":[0.33,1.32,0.00825],"deepseek-v4-flash":[0.138,0.275,0.028],"deepseek-v4-flash-0731":[0.13,0.26,0.028],"deepseek-v4-flash-0731-fast":[0.35,0.7,0.0875],"deepseek-v4-pro":[1.65,3.301,0.33],"deepseek-v4-pro-0813":[1.65,4.95,0.165],"gemini-3-1-pro-preview":[2.5,15.0,0.5],"gemini-3-5-flash":[1.55,9.45,0.155],"gemini-3-5-flash-lite":[0.375,3.125,0.0375],"gemini-3-6-flash":[0.9375,4.6875,0.09375],"gemini-3-7-flash":[0.9375,4.6875,0.09375],"gemini-3-8-flash":[0.9375,4.6875,0.09375],"gemini-3-flash-preview":[0.7,3.75,0.07],"gemini-4-argon":[2.5,12.5,0.125],"gemma-4-uncensored":[0.1625,0.5,0.1625],"google-gemma-3-27b-it":[0.12,0.2,0.12],"google-gemma-4-26b-a4b-it":[0.13,0.4,0.05],"google-gemma-4-31b-it":[0.12,0.36,0.09],"grok-4-20":[1.42,2.83,0.23],"grok-4-20-multi-agent":[1.42,2.83,0.23],"grok-4-3":[1.42,2.83,0.23],"grok-4-5":[2.27,6.8,0.34],"grok-4-6":[2.27,6.8,0.57],"grok-4-7":[2.27,6.8,0.57],"grok-build-0-1":[1.0,2.0,0.2],"hermes-3-llama-3.1-405b":[1.1,3.0,1.1],"hy4-preview":[1.0425,3.12625,0.0525],"kimi-k2-5":[0.56,3.5,0.22],"kimi-k2-6":[0.75,3.5,0.16],"kimi-k2-7-code":[0.75,3.5,0.16],"kimi-k3":[3.75,18.75,0.375],"kimi-k3-1-pro":[3.0,15.0,0.30000000000000004],"kimi-k3-1-pro-highspeed":[6.0,30.0,0.6000000000000001],"kimi-k3-fast-api":[4.5,22.5,0.45],"llama-3.2-3b":[0.15,0.6,0.15],"llama-3.3-70b":[0.7,2.8,0.7],"mercury-2":[0.3125,0.9375,0.03125],"mercury-2-5":[0.25,0.9375,0.025],"mercury-3":[0.1,0.35,0.01],"minimax-m25":[0.27,0.95,0.03],"minimax-m27":[0.375,1.5,0.06875],"minimax-m3-1-flash":[0.1875,0.75,0.01875],"minimax-m3-preview":[0.3,1.2,0.06],"mistral-small-3-2-24b-instruct":[0.09375,0.25,0.09375],"muse-spark-open":[1.5625,5.3125,0.1875],"muse-wonder":[5.0,25.0,0.25],"nvidia-nemotron-3-5-super-vl-120b-a12b":[0.2,0.5,0.04],"nvidia-nemotron-3-nano-30b-a3b":[0.075,0.3,0.075],"nvidia-nemotron-3-ultra-550b-a55b":[0.625,3.125,0.1875],"olafangensan-glm-4.7-flash-heretic":[0.07,0.4,0.035],"openai-gpt-4o-2024-11-20":[2.5,10.0,1.25],"openai-gpt-4o-mini-2024-07-18":[0.15,0.6,0.075],"openai-gpt-52":[1.75,14.0,0.175],"openai-gpt-53-codex":[1.75,14.0,0.175],"openai-gpt-54":[2.5,15.0,0.25],"openai-gpt-54-mini":[0.75,4.5,0.075],"openai-gpt-54-pro":[30.0,180.0,30.0],"openai-gpt-55":[5.0,30.0,0.5],"openai-gpt-55-pro":[30.0,180.0,30.0],"openai-gpt-56-luna":[0.2,1.2,0.02],"openai-gpt-56-luna-pro":[0.2,1.2,0.02],"openai-gpt-56-sol":[4.0,20.0,0.4],"openai-gpt-56-sol-pro":[4.0,20.0,0.4],"openai-gpt-56-terra":[2.0,12.0,0.2],"openai-gpt-56-terra-pro":[2.0,12.0,0.2],"openai-gpt-6-astra":[10.0,50.0,1.0],"openai-gpt-6-astra-pro":[10.0,50.0,1.0],"openai-gpt-6-luna":[0.1,0.5,0.01],"openai-gpt-6-sol":[2.0,10.0,0.2],"openai-gpt-61-sol":[2.0,10.0,0.1],"openai-gpt-61-sol-ultrafast":[12.0,60.0,0.6],"openai-gpt-61-terra":[1.0,5.0,0.05],"openai-gpt-oss-120b":[0.07,0.3,0.07],"qwen-3-6-plus":[0.625,3.75,0.0625],"qwen-3-7-max":[2.7,8.05,0.27],"qwen-3-7-plus":[0.5,2.0,0.05],"qwen-3-8-2-4t-a95b":[2.5,7.5,0.3125],"qwen-3-8-27b":[0.45,3.2,0.45],"qwen-3-8-flash":[0.14,0.49,0.014],"qwen-3-8-max":[2.5,7.5,0.3125],"qwen3-235b-a22b-instruct-2507":[0.15,0.75,0.15],"qwen3-235b-a22b-thinking-2507":[0.45,3.5,0.45],"qwen3-5-35b-a3b":[0.15,1.0,0.05],"qwen3-5-397b-a17b":[0.75,4.5,0.75],"qwen3-6-27b":[0.325,3.25,0.325],"qwen3-6-35b-a3b":[0.1,1.0,0.1],"qwen3-coder-480b-a35b-instruct-turbo":[0.35,1.5,0.04],"qwen3-next-80b":[0.35,1.9,0.35],"qwen3-vl-235b-a22b":[0.21,1.9,0.1],"seed-2-1-turbo":[0.625,3.125,0.125],"venice-uncensored-1-2":[0.2,0.9,0.2],"venice-uncensored-role-play":[0.5,2.0,0.5],"xiaomi-mimo-v2-5":[0.4,2.0,0.08],"xiaomi-mimo-v2-6-flash":[0.175,0.35,0.00375],"z-ai-glm-5-3":[1.75,5.5,0.325],"z-ai-glm-5-3-flash":[0.15,0.5,0.03],"z-ai-glm-5-turbo":[1.2,4.0,0.24],"z-ai-glm-5v-turbo":[1.5,5.0,0.3],"zai-org-glm-4.6":[0.43,1.75,0.08],"zai-org-glm-4.7":[0.55,2.65,0.11],"zai-org-glm-5":[1.0,3.2,0.2],"zai-org-glm-5-1":[1.54,4.84,0.286],"zai-org-glm-5-2":[1.4,4.4,0.26]},"vercel":{"alibaba/qwen-3-14b":[0.12,0.24,0.12],"alibaba/qwen-3-235b":[0.22,0.88,0.22],"alibaba/qwen-3-30b":[0.12,0.5,0.12],"alibaba/qwen-3-32b":[0.15,0.6,0.15],"alibaba/qwen3-coder":[0.22,1.8,0.022],"alibaba/qwen3-coder-30b-a3b":[0.15,0.6,0.15],"alibaba/qwen3-coder-next":[0.5,1.2,0.5],"alibaba/qwen3-max-thinking":[1.2,6.0,0.24],"alibaba/qwen3-next-80b-a3b-instruct":[0.15,1.2,0.15],"alibaba/qwen3-next-80b-a3b-thinking":[0.15,1.2,0.15],"alibaba/qwen3-vl-instruct":[0.2,0.88,0.11],"alibaba/qwen3.5-flash":[0.1,0.4,0.01],"alibaba/qwen3.5-plus":[0.4,2.4,0.04],"alibaba/qwen3.6-27b":[0.6,3.6,0.6],"alibaba/qwen3.6-plus":[0.5,3.0,0.05],"alibaba/qwen3.7-flash":[0.03,0.13,0.006],"alibaba/qwen3.7-max":[2.5,7.5,0.5],"alibaba/qwen3.7-plus":[0.4,1.6,0.08],"alibaba/qwen3.8-2.4t-a95b":[2.0,6.0,0.25],"alibaba/qwen3.8-27b":[0.5,3.0,0.1],"alibaba/qwen3.8-flash":[0.15,0.47,0.016],"alibaba/qwen3.8-max":[2.0,6.0,0.25],"alibaba/qwen3.8-max-0902":[2.0,6.0,0.25],"alibaba/qwen3.8-max-prime":[4.0,12.0,0.5],"alibaba/qwen3.8-omni-flash":[0.15,0.47,0.016],"amazon/nova-2-lite":[0.33,2.75,0.0825],"amazon/nova-lite":[0.06,0.24,0.015],"amazon/nova-micro":[0.035,0.14,0.00875],"amazon/nova-pro":[0.8,3.2,0.2],"anthropic/claude-fable-5":[10.0,50.0,1.0],"anthropic/claude-fable-5.1":[10.0,50.0,0.25],"anthropic/claude-haiku-4.5":[1.0,5.0,0.1],"anthropic/claude-haiku-5.5":[0.1,0.5,0.01],"anthropic/claude-opus-4.5":[5.0,25.0,0.5],"anthropic/claude-opus-4.6":[5.0,25.0,0.5],"anthropic/claude-opus-4.7":[5.0,25.0,0.5],"anthropic/claude-opus-4.8":[5.0,25.0,0.5],"anthropic/claude-opus-4.8-fast":[10.0,50.0,1.0],"anthropic/claude-opus-5":[5.0,25.0,0.5],"anthropic/claude-opus-5-fast":[10.0,50.0,1.0],"anthropic/claude-opus-5.5":[4.0,20.0,0.2],"anthropic/claude-opus-5.5-fast":[8.0,40.0,0.4],"anthropic/claude-sonnet-4.5":[3.0,15.0,0.3],"anthropic/claude-sonnet-4.6":[3.0,15.0,0.3],"anthropic/claude-sonnet-5":[2.0,10.0,0.2],"anthropic/claude-sonnet-5.5":[2.0,10.0,0.1],"arcee-ai/trinity-large-thinking":[0.25,0.8,0.06],"bytedance/seed-1.6":[0.25,2.0,0.05],"bytedance/seed-1.8":[0.25,2.0,0.05],"bytedance/seed-2.1-turbo":[0.5,2.5,0.1],"callstack/apex":[0.5,3.0,0.2],"cohere/command-a":[2.5,10.0,2.5],"deepseek/deepseek-r1":[1.35,5.4,1.35],"deepseek/deepseek-v3.1":[0.25,0.95,0.13],"deepseek/deepseek-v3.2":[0.62,1.85,0.62],"deepseek/deepseek-v3.2-thinking":[0.62,1.85,0.62],"deepseek/deepseek-v4-flash":[0.13,0.26,0.028],"deepseek/deepseek-v4-flash-0731":[0.076,0.153,0.014],"deepseek/deepseek-v4-flash-vision-exp":[0.2156,0.6468,0.0068],"deepseek/deepseek-v4-pro":[0.66,1.98,0.022],"deepseek/deepseek-v4-pro-0813":[0.66,1.98,0.066],"deepseek/deepseek-v4.1-flash":[0.075,0.3,0.0015],"deepseek/deepseek-v4.1-flash-1017":[0.075,0.3,0.0015],"deepseek/deepseek-v4.1-flash-1017-fast":[0.6,2.4,0.014],"deepseek/deepseek-v4.1-flash-fast":[0.6,2.4,0.014],"elorian/glimpse":[0.6,3.0,0.06],"fireworks/ember-1":[3.0,15.0,0.3],"google/gemini-2.5-flash":[0.3,2.5,0.03],"google/gemini-2.5-flash-image":[0.3,2.5,0.03],"google/gemini-2.5-flash-lite":[0.1,0.4,0.01],"google/gemini-2.5-pro":[1.25,10.0,0.125],"google/gemini-3-flash":[0.5,3.0,0.05],"google/gemini-3-pro-image":[2.0,12.0,0.2],"google/gemini-3.1-flash-image":[0.5,3.0,0.05],"google/gemini-3.1-flash-image-preview":[0.5,3.0,0.05],"google/gemini-3.1-flash-lite":[0.25,1.5,0.03],"google/gemini-3.1-flash-lite-image":[0.25,1.5,0.03],"google/gemini-3.1-pro-preview":[2.0,12.0,0.2],"google/gemini-3.5-flash":[1.5,9.0,0.15],"google/gemini-3.5-flash-lite":[0.3,2.5,0.03],"google/gemini-3.5-transcribe":[2.0,12.0,2.0],"google/gemini-3.6-flash":[0.75,3.75,0.075],"google/gemini-3.7-flash":[0.75,3.75,0.075],"google/gemini-3.8-flash":[0.75,3.75,0.075],"google/gemini-3.8-flash-lite-tts":[0.5,6.0,0.5],"google/gemini-3.8-flash-tts":[0.5,9.0,0.5],"google/gemini-3.8-live":[0.75,4.5,0.75],"google/gemini-3.8-live-extended-thinking":[0.75,4.5,0.75],"google/gemini-4-argon":[2.0,10.0,0.1],"google/gemini-nano-banana-2.1":[1.5,7.5,0.15],"google/gemini-omni-flash-preview":[1.5,9.0,1.5],"google/gemma-4-26b-a4b-it":[0.15,0.6,0.015],"google/gemma-4-31b-it":[0.14,0.4,0.14],"inception/mercury-2":[0.25,0.75,0.025],"inception/mercury-2.5":[0.04,0.15,0.004],"inception/mercury-3":[0.1,0.35,0.01],"inception/mercury-coder-small":[0.25,1.0,0.25],"inclusionai/ling-3.0-flash":[0.021,0.063,0.0042],"inclusionai/ling-3.0-flash-fin":[0.075,0.22,0.015],"inclusionai/ling-3.0-flash-sante":[0.075,0.22,0.015],"inclusionai/ling-3.0-flash-vl":[0.075,0.22,0.015],"inclusionai/ling-3.1-flash":[0.3,0.9,0.06],"inference-net/schematron-v2-small":[0.05,0.23,0.05],"inference-net/schematron-v2-turbo":[0.03,0.15,0.03],"interfaze/interfaze-beta":[1.5,3.5,1.5],"liquid/lfm2.5-24b-a2b":[0.05,0.7,0.025],"meituan/longcat-2.5-preview":[0.3,1.2,0.006],"meta/llama-3.1-70b":[0.72,0.72,0.72],"meta/llama-3.1-8b":[0.22,0.22,0.22],"meta/llama-3.3-70b":[0.72,0.72,0.72],"meta/llama-4-maverick":[0.24,0.97,0.24],"meta/llama-4-scout":[0.17,0.66,0.17],"meta/muse-glimmer-30b":[0.35,1.5,0.04],"meta/muse-spark-1.1":[1.25,4.25,0.15],"meta/muse-spark-1.2":[1.25,4.25,0.15],"meta/muse-spark-1.2-contributor":[0.1,0.2,0.002],"meta/muse-spark-1.3":[1.25,4.25,0.15],"meta/muse-spark-1.3-contributor":[0.1,0.2,0.002],"meta/muse-spark-open":[1.25,4.25,0.15],"meta/muse-wonder-1.0":[4.0,20.0,0.2],"microsoft/mai-image-2.6":[5.0,38.0,5.0],"microsoft/mai-image-2.6-flash":[1.75,19.0,1.75],"minimax/minimax-m2":[0.3,1.2,0.03],"minimax/minimax-m2.1":[0.3,1.2,0.03],"minimax/minimax-m2.1-lightning":[0.3,2.4,0.03],"minimax/minimax-m2.5":[0.3,1.2,0.03],"minimax/minimax-m2.5-highspeed":[0.6,2.4,0.03],"minimax/minimax-m2.7":[0.3,1.2,0.06],"minimax/minimax-m2.7-highspeed":[0.6,2.4,0.06],"minimax/minimax-m3":[0.3,1.2,0.06],"minimax/minimax-m3.1-flash":[0.15,0.6,0.015],"mistral/codestral":[0.3,0.9,0.03],"mistral/ministral-14b":[0.2,0.2,0.02],"mistral/ministral-3b":[0.1,0.1,0.01],"mistral/ministral-8b":[0.15,0.15,0.015],"mistral/mistral-large-3":[0.5,1.5,0.05],"mistral/mistral-large-4":[1.36,4.18,0.14],"mistral/mistral-medium-3.5":[1.5,7.5,0.15],"mistral/mistral-nemo":[0.029,0.03,0.029],"mistral/mistral-small":[0.15,0.6,0.015],"mixedbread/toast-1":[0.3,0.72,0.036],"moonshotai/kimi-k2":[0.57,2.3,0.57],"moonshotai/kimi-k2.5":[0.6,3.0,0.6],"moonshotai/kimi-k2.6":[0.95,4.0,0.16],"moonshotai/kimi-k2.7-code":[0.95,4.0,0.19],"moonshotai/kimi-k2.7-code-highspeed":[1.9,8.0,0.38],"moonshotai/kimi-k3":[3.0,15.0,0.3],"moonshotai/kimi-k3-fast":[4.5,22.5,0.45],"moonshotai/kimi-k3.1-pro":[2.0,10.0,0.2],"moonshotai/kimi-k3.1-pro-highspeed":[4.0,20.0,0.2],"morph/morph-v3-fast":[0.8,1.2,0.8],"morph/morph-v3-large":[0.9,1.9,0.9],"nvidia/nemotron-3-nano-30b-a3b":[0.05,0.2,0.025],"nvidia/nemotron-3-super-120b-a12b":[0.15,0.65,0.15],"nvidia/nemotron-3-ultra-550b-a55b":[0.6,2.4,0.12],"nvidia/nemotron-3.5-lightning":[0.05,0.2,0.01],"nvidia/nemotron-3.5-lightning-free":[0.0,0.0],"nvidia/nemotron-3.5-super-vl":[0.2,0.5,0.04],"nvidia/nemotron-nano-12b-v2-vl":[0.2,0.6,0.2],"nvidia/nemotron-nano-9b-v2":[0.06,0.23,0.06],"openai/gpt-4.1":[2.0,8.0,0.5],"openai/gpt-4.1-fast":[3.5,14.0,0.875],"openai/gpt-4.1-mini":[0.4,1.6,0.1],"openai/gpt-4.1-mini-fast":[0.7,2.8,0.175],"openai/gpt-4.1-nano":[0.1,0.4,0.03],"openai/gpt-4o":[2.5,10.0,1.25],"openai/gpt-4o-fast":[4.25,17.0,2.125],"openai/gpt-4o-mini":[0.15,0.6,0.075],"openai/gpt-4o-mini-fast":[0.25,1.0,0.125],"openai/gpt-4o-mini-transcribe":[1.25,5.0,1.25],"openai/gpt-4o-transcribe":[2.5,10.0,2.5],"openai/gpt-5":[1.25,10.0,0.125],"openai/gpt-5-codex":[1.25,10.0,0.13],"openai/gpt-5-fast":[2.5,20.0,0.25],"openai/gpt-5-mini":[0.25,2.0,0.025],"openai/gpt-5-mini-fast":[0.45,3.6,0.045],"openai/gpt-5-nano":[0.05,0.4,0.005],"openai/gpt-5-pro":[15.0,120.0,15.0],"openai/gpt-5.1-codex":[1.25,10.0,0.13],"openai/gpt-5.1-codex-max":[1.25,10.0,0.125],"openai/gpt-5.1-codex-mini":[0.25,2.0,0.03],"openai/gpt-5.1-thinking":[1.25,10.0,0.125],"openai/gpt-5.1-thinking-fast":[2.5,20.0,0.25],"openai/gpt-5.2":[1.75,14.0,0.175],"openai/gpt-5.2-codex":[1.75,14.0,0.175],"openai/gpt-5.2-fast":[3.5,28.0,0.35],"openai/gpt-5.2-pro":[21.0,168.0,21.0],"openai/gpt-5.3-codex":[1.75,14.0,0.175],"openai/gpt-5.3-codex-fast":[3.5,28.0,0.35],"openai/gpt-5.4":[2.5,15.0,0.25],"openai/gpt-5.4-fast":[5.0,30.0,0.5],"openai/gpt-5.4-mini":[0.75,4.5,0.075],"openai/gpt-5.4-mini-fast":[1.5,9.0,0.15],"openai/gpt-5.4-nano":[0.2,1.25,0.02],"openai/gpt-5.4-pro":[30.0,180.0,30.0],"openai/gpt-5.5":[5.0,30.0,0.5],"openai/gpt-5.5-fast":[12.5,75.0,1.25],"openai/gpt-5.5-pro":[30.0,180.0,30.0],"openai/gpt-5.6-luna":[0.2,1.2,0.02],"openai/gpt-5.6-luna-fast":[0.4,2.4,0.04],"openai/gpt-5.6-sol":[4.0,20.0,0.4],"openai/gpt-5.6-sol-fast":[8.0,40.0,0.8],"openai/gpt-5.6-terra":[2.0,12.0,0.2],"openai/gpt-5.6-terra-fast":[4.0,24.0,0.4],"openai/gpt-6-astra":[10.0,50.0,1.0],"openai/gpt-6-astra-fast":[20.0,100.0,2.0],"openai/gpt-6-luna":[0.1,0.5,0.01],"openai/gpt-6-luna-fast":[0.2,1.0,0.02],"openai/gpt-6-sol":[2.0,10.0,0.2],"openai/gpt-6-sol-fast":[4.0,20.0,0.4],"openai/gpt-6.1-sol":[2.0,10.0,0.1],"openai/gpt-6.1-sol-fast":[4.0,20.0,0.2],"openai/gpt-6.1-terra":[1.0,5.0,0.05],"openai/gpt-6.1-terra-fast":[2.0,10.0,0.1],"openai/gpt-image-1-mini":[2.0,8.0,0.2],"openai/gpt-image-1.5":[5.0,32.0,1.25],"openai/gpt-image-2":[5.0,30.0,1.25],"openai/gpt-image-2.5-flare":[5.0,30.0,1.25],"openai/gpt-image-2.5-sunburst":[5.0,30.0,1.25],"openai/gpt-oss-120b":[0.1,0.5,0.1],"openai/gpt-oss-20b":[0.03,0.14,0.03],"openai/gpt-oss-safeguard-120b":[0.15,0.6,0.15],"openai/gpt-oss-safeguard-20b":[0.07,0.2,0.07],"openai/gpt-realtime-1.5":[4.0,16.0,0.4],"openai/gpt-realtime-2":[4.0,24.0,0.4],"openai/gpt-realtime-2.1":[4.0,24.0,0.4],"openai/gpt-realtime-mini":[0.6,2.4,0.06],"openai/o1":[15.0,60.0,7.5],"openai/o3":[2.0,8.0,0.5],"openai/o3-fast":[3.5,14.0,0.875],"openai/o3-mini":[1.1,4.4,0.55],"openai/o3-pro":[20.0,80.0,20.0],"openai/o4-mini":[1.1,4.4,0.275],"particle/particle-1":[0.125,0.5,0.015],"perplexity/sonar":[0.25,2.5,0.25],"poolside/laguna-s-2.1":[0.09,0.18,0.009],"poolside/laguna-s-2.1-free":[0.0,0.0],"quiverai/arrow-2":[4.0,20.0,0.4],"quiverai/arrow-2-telos":[6.0,30.0,0.6],"reflection/beam":[0.0,0.0],"reflection/beam-free":[0.0,0.0],"sakana/fugu-max":[2.0,6.0,0.25],"sakana/fugu-ultra":[5.0,30.0,0.5],"sakana/fugu-ultra-v2":[5.0,30.0,0.5],"sakana/namazu":[0.95,4.0,0.15],"scaledown/scaledown-extract-1":[0.05,0.0,0.05],"scaledown/scaledown-summarize-1":[0.05,0.0,0.05],"spacexai/grok-4.20-multi-agent":[1.25,2.5,0.2],"spacexai/grok-4.20-multi-agent-beta":[1.25,2.5,0.2],"spacexai/grok-4.20-non-reasoning":[1.25,2.5,0.2],"spacexai/grok-4.20-non-reasoning-beta":[1.25,2.5,0.4],"spacexai/grok-4.20-reasoning":[1.25,2.5,0.2],"spacexai/grok-4.20-reasoning-beta":[1.25,2.5,0.2],"spacexai/grok-4.3":[1.25,2.5,0.2],"spacexai/grok-4.5":[2.0,6.0,0.3],"spacexai/grok-4.6":[2.0,6.0,0.5],"spacexai/grok-4.7":[2.0,6.0,0.5],"spacexai/grok-build-0.1":[1.0,2.0,0.2],"stealth/glyph-cluster":[0.0,0.0],"stepfun/step-3.7-flash":[0.2,1.15,0.04],"stepfun/step-5-preview":[1.0,2.7,0.1],"tencent/hy-mt2-lite":[0.044,0.177,0.044],"tencent/hy-mt2-plus":[0.074,0.295,0.074],"tencent/hy-mt2-pro":[0.074,0.295,0.074],"tencent/hy3":[0.14,0.58,0.035],"tencent/hy4-preview":[0.834,2.501,0.042],"thinkingmachines/inkling":[1.0,4.05,0.17],"thinkingmachines/inkling-small":[0.45,1.2,0.1],"xiaomi/mimo-v2.5":[0.119,0.238,0.0025],"xiaomi/mimo-v2.5-pro":[0.3045,0.609,0.0028],"xiaomi/mimo-v2.6-flash":[0.14,0.28,0.0028],"xiaomi/mimo-v2.6-pro":[0.435,0.87,0.0036],"xiaomi/mimo-v2.6-pro-ultraspeed":[4.35,8.7,0.036],"zai/glm-4.5":[0.6,2.2,0.11],"zai/glm-4.5-air":[0.2,1.1,0.03],"zai/glm-4.5v":[0.6,1.8,0.11],"zai/glm-4.6":[0.6,2.2,0.11],"zai/glm-4.7":[0.6,2.2,0.6],"zai/glm-4.7-flash":[0.07,0.4,0.07],"zai/glm-4.7-flashx":[0.06,0.4,0.01],"zai/glm-5":[1.0,3.2,1.0],"zai/glm-5-turbo":[1.2,4.0,0.24],"zai/glm-5.1":[1.4,4.4,0.26],"zai/glm-5.2":[0.8,2.55,0.16],"zai/glm-5.2-fast":[2.8,8.8,0.56],"zai/glm-5.3":[1.4,4.4,0.14],"zai/glm-5.3-fast":[2.1,6.6,0.21],"zai/glm-5.3-flash":[0.15,0.5,0.03],"zai/glm-5.3-flashx":[0.37,1.25,0.075],"zai/glm-5v-turbo":[1.2,4.0,0.24]},"vispark":{"vispark/vision-large":[7.37,22.11,7.37],"vispark/vision-medium":[4.21,12.63,4.21],"vispark/vision-small":[1.05,3.16,1.05]},"vivgrid":{"claude-fable-5":[10.0,50.0,1.25],"claude-fable-5-1":[10.0,50.0,0.5],"claude-haiku-5-5":[0.1,0.5,0.01],"claude-opus-5":[5.0,25.0,0.5],"claude-opus-5-5":[4.0,20.0,0.2],"claude-sonnet-5":[2.0,10.0,0.2],"claude-sonnet-5-5":[2.0,10.0,0.2],"deepseek-v3.2":[0.28,0.42,0.03],"deepseek-v4-flash":[0.44,1.32,0.044],"deepseek-v4-pro":[1.74,3.48,0.14],"deepseek-v4-pro-0813":[1.35,3.0,0.05],"deepseek-v4.1-flash":[0.31,1.23,0.01],"gemini-3.1-flash-lite-preview":[0.25,1.5,0.025],"gemini-3.1-pro-preview":[3.0,12.0,0.3],"gemini-3.7-flash":[0.75,3.75,0.075],"gemini-3.8-flash":[0.75,3.75,0.15],"glm-5.2":[1.2,4.2,0.3],"glm-5.3":[1.2,4.2,0.3],"glm-5.3-flash":[0.15,0.5,0.04],"gpt-5-mini":[0.25,2.0,0.03],"gpt-5.1-codex":[1.25,10.0,0.125],"gpt-5.1-codex-max":[1.25,10.0,0.125],"gpt-5.2-codex":[1.75,14.0,0.175],"gpt-5.3-codex":[1.75,14.0,0.175],"gpt-5.4":[2.5,15.0,0.25],"gpt-5.4-mini":[0.75,4.5,0.075],"gpt-5.4-nano":[0.2,1.25,0.02],"gpt-5.5":[5.0,30.0,0.5],"gpt-5.6-luna":[1.0,6.0,0.1],"gpt-5.6-sol":[5.0,30.0,0.5],"gpt-5.6-terra":[2.5,15.0,0.25],"gpt-6-astra":[10.0,50.0,1.0],"gpt-6-luna":[0.1,0.5,0.01],"gpt-6-sol":[2.0,10.0,0.2],"gpt-6.1-sol":[2.0,10.0,0.2],"gpt-6.1-terra":[1.1,5.5,0.055],"kimi-k3":[3.0,15.0,0.3],"viv-fast":[0.13,0.4,0.05]},"volcengine":{"deepseek-v4-flash-ga-260731":[0.4453,1.3359,0.01484],"deepseek-v4-pro-ga-260813":[1.3359,4.00771,0.04453],"doubao-seed-1-6-251015":[0.11875,1.18747,0.02375],"doubao-seed-1-6-flash-250828":[0.02227,0.22265,0.00445],"doubao-seed-1-6-vision-250815":[0.11875,1.18747,0.02375],"doubao-seed-1-8-251228":[0.11875,1.18747,0.02375],"doubao-seed-2-0-code-preview-260215":[0.47499,2.37494,0.095],"doubao-seed-2-0-lite-260428":[0.08906,0.53436,0.01781],"doubao-seed-2-0-mini-260428":[0.02969,0.29687,0.00594],"doubao-seed-2-0-pro-260215":[0.47499,2.37494,0.095],"doubao-seed-2-1-pro-260628":[0.8906,4.45301,0.17812],"doubao-seed-2-1-turbo-260628":[0.4453,2.22651,0.08906],"doubao-seed-character-260628":[0.11875,0.29687,0.02375],"doubao-seed-evolving":[0.8906,4.45301,0.17812],"glm-5-2-260617":[1.18747,4.15615,0.29687],"glm-5-3-flash-260828":[0.11875,0.41563,0.03414]},"volcengine-coding-plan":{"deepseek-v4-flash":[0.0,0.0],"deepseek-v4-pro":[0.0,0.0],"doubao-seed-2.0-lite":[0.0,0.0],"doubao-seed-2.1-turbo":[0.0,0.0],"doubao-seed-evolving":[0.0,0.0],"glm-5.3":[0.0,0.0],"glm-5.3-flash":[0.0,0.0],"kimi-k2.7-code":[0.0,0.0],"kimi-k3":[0.0,0.0],"minimax-m3":[0.0,0.0]},"vultr":{"deepseek-v4-flash-0731":[0.1,0.25,0.1],"deepseek-v4.1-flash":[0.15,0.6,0.15],"glm-5.2":[0.75,3.0,0.75],"glm-5.3":[0.75,3.0,0.75],"glm-5.3-flash":[0.1,0.35,0.1],"glm-5.x-menthol":[0.4,1.75,0.4],"laguna-s-2.1":[0.09,0.18,0.09],"mimo-v2.6-flash-rl":[0.1,0.25,0.1],"mimo-v2.6-pro-rl":[0.4,0.8,0.4],"minimax-m3":[0.2,0.9,0.2],"muse-glimmer-30b":[0.25,1.0,0.25],"nemotron-3-nano-omni-30b-a3b-reasoning":[0.1,0.25,0.1],"nemotron-3.5-content-safety":[0.05,0.15,0.05],"qwen3.8-27b":[0.15,1.0,0.15],"qwen3.8-flash-next":[0.1,0.2,0.1]},"wafer.ai":{"glm-5.1":[1.0,3.2,0.1],"glm-5.2":[1.4,4.4,0.26],"glm5.2-fast":[3.0,10.25,0.5],"kimi-k2.6":[1.14,4.8,0.19],"minimax-m3":[0.33,1.32,0.07]},"wallaby":{"moonshotai/kimi-k3":[2.7,13.5,0.27]},"wandb":{"deepseek-ai/deepseek-v3.1":[0.55,1.65,0.55],"deepseek-ai/deepseek-v4-flash-0731":[0.13,0.28,0.07],"deepseek-ai/deepseek-v4-pro-0813":[1.31,3.96,0.044],"deepseek-ai/deepseek-v4.1-flash":[0.13,0.65,0.002],"google/gemma-4-26b-a4b-it":[0.1,0.3,0.05],"google/gemma-4-31b-it":[0.1,0.34,0.1],"ibm-granite/granite-4.2-8b":[0.06,0.15,0.015],"meta-llama/llama-3.1-8b-instruct":[0.22,0.22,0.22],"meta-llama/llama-3.3-70b-instruct":[0.71,0.71,0.71],"minimaxai/minimax-m3":[0.23,0.96,0.05],"moonshotai/kimi-k2.6":[0.65,3.41,0.15],"moonshotai/kimi-k2.7-code":[0.6,3.0,0.12],"nvidia/nvidia-nemotron-3-ultra-550b-a55b":[0.5,2.15,0.1],"nvidia/nvidia-nemotron-3.5-lightning-30b-a3b":[0.07,0.2,0.04],"nvidia/nvidia-nemotron-3.5-super-vl-120b-a12b":[0.15,0.5,0.02],"openai/gpt-oss-120b":[0.03,0.17,0.03],"openai/gpt-oss-20b":[0.03,0.13,0.03],"qwen/qwen3.6-35b-a3b":[0.1,0.95,0.05],"qwen/qwen3.8-27b":[0.4,3.0,0.15],"reflection/beam-1.0-501b-a23b":[0.3,1.0,0.04],"zai-org/glm-5.2":[0.62,2.42,0.14],"zai-org/glm-5.3":[1.2,4.0,0.19],"zai-org/glm-5.3-flash":[0.12,0.38,0.02]},"watsonx":{"ibm/granite-4-h-small":[0.0636,0.265,0.0636],"meta-llama/llama-3-3-70b-instruct":[0.7526,0.7526,0.7526],"meta-llama/llama-4-maverick-17b-128e-instruct-fp8":[0.371,1.484,0.371],"mistralai/mistral-small-3-1-24b-instruct-2503":[0.106,0.318,0.106],"openai/gpt-oss-120b":[0.159,0.636,0.159]},"xai":{"grok-4.20-0309-non-reasoning":[1.25,2.5,0.2],"grok-4.20-0309-reasoning":[1.25,2.5,0.2],"grok-4.20-multi-agent-0309":[1.25,2.5,0.2],"grok-4.3":[1.25,2.5,0.2],"grok-4.5":[2.0,6.0,0.3],"grok-4.6":[2.0,6.0,0.5],"grok-4.7":[2.0,6.0,0.5],"grok-build-0.1":[1.0,2.0,0.2]},"xiaomi":{"mimo-v2.5":[0.14,0.28,0.0028],"mimo-v2.5-pro":[0.435,0.87,0.0036],"mimo-v2.5-pro-ultraspeed":[1.305,2.61,0.0108],"mimo-v2.6-flash":[0.14,0.28,0.0028],"mimo-v2.6-pro":[0.435,0.87,0.0036],"mimo-v2.6-pro-ultraspeed":[4.35,8.7,0.036]},"xiaomi-token-plan-ams":{"mimo-v2.5":[0.0,0.0],"mimo-v2.5-pro":[0.0,0.0],"mimo-v2.5-tts":[0.0,0.0],"mimo-v2.5-tts-voiceclone":[0.0,0.0],"mimo-v2.5-tts-voicedesign":[0.0,0.0],"mimo-v2.6-flash":[0.0,0.0],"mimo-v2.6-pro":[0.0,0.0]},"xiaomi-token-plan-cn":{"mimo-v2.5":[0.0,0.0],"mimo-v2.5-pro":[0.0,0.0],"mimo-v2.5-tts":[0.0,0.0],"mimo-v2.5-tts-voiceclone":[0.0,0.0],"mimo-v2.5-tts-voicedesign":[0.0,0.0],"mimo-v2.6-flash":[0.0,0.0],"mimo-v2.6-pro":[0.0,0.0]},"xiaomi-token-plan-sgp":{"mimo-v2.5":[0.0,0.0],"mimo-v2.5-pro":[0.0,0.0],"mimo-v2.5-tts":[0.0,0.0],"mimo-v2.5-tts-voiceclone":[0.0,0.0],"mimo-v2.5-tts-voicedesign":[0.0,0.0],"mimo-v2.6-flash":[0.0,0.0],"mimo-v2.6-pro":[0.0,0.0]},"xpersona":{"claude-fable-5":[3.0,18.5,0.3],"claude-haiku-4-5":[0.6,3.7,0.06],"claude-opus-4-8":[1.5,9.25,0.15],"claude-sonnet-4-6":[0.9,5.55,0.09],"gemini-3.5-flash":[1.55,12.2,0.155],"gpt-5.4":[0.75,6.0,0.075],"gpt-5.4-mini":[0.375,4.0,0.0375],"gpt-5.5":[1.5,12.0,0.15],"gpt-5.6":[1.5,12.0,0.15],"gpt-5.6-sol":[1.5,12.0,0.15],"gpt-5.6-terra":[1.5,2.0,0.15],"xpersona-frieren-coder":[1.5,6.0,0.15],"xpersona-gpt-5.5":[3.0,18.0,0.3]},"zai":{"glm-4.5":[0.6,2.2,0.11],"glm-4.5-air":[0.2,1.1,0.03],"glm-4.5-flash":[0.0,0.0],"glm-4.5v":[0.6,1.8,0.11],"glm-4.6":[0.6,2.2,0.11],"glm-4.6v":[0.3,0.9,0.05],"glm-4.6v-flash":[0.0,0.0],"glm-4.7":[0.6,2.2,0.11],"glm-4.7-flash":[0.0,0.0],"glm-4.7-flashx":[0.07,0.4,0.01],"glm-5":[1.0,3.2,0.2],"glm-5-turbo":[1.2,4.0,0.24],"glm-5.1":[1.4,4.4,0.26],"glm-5.2":[1.4,4.4,0.26],"glm-5.3":[1.4,4.4,0.26],"glm-5.3-flash":[0.15,0.5,0.03],"glm-5.3-flashx":[0.37,1.25,0.075],"glm-5v-turbo":[1.2,4.0,0.24]},"zai-coding-plan":{"glm-4.7":[0.0,0.0],"glm-5-turbo":[0.0,0.0],"glm-5.2":[0.0,0.0],"glm-5.2-highspeed":[0.0,0.0],"glm-5.3":[0.0,0.0],"glm-5.3-flash":[0.0,0.0],"glm-5.3-highspeed":[0.0,0.0]},"zeldoc":{"zdev":[0.0,0.0]},"zenifra":{"alibaba/qwen3.6-35b-a3b":[0.19,0.48,0.19]},"zenmux":{"anthropic/claude-fable-5":[10.0,50.0,1.0],"anthropic/claude-fable-5.1":[10.0,50.0,0.25],"anthropic/claude-haiku-4.5":[1.0,5.0,0.1],"anthropic/claude-opus-4.1":[15.0,75.0,1.5],"anthropic/claude-opus-4.5":[5.0,25.0,0.5],"anthropic/claude-opus-4.6":[5.0,25.0,0.5],"anthropic/claude-opus-4.7":[5.0,25.0,0.5],"anthropic/claude-opus-4.8":[5.0,25.0,0.5],"anthropic/claude-opus-5.5":[4.0,20.0,0.2],"anthropic/claude-sonnet-4.5":[3.0,15.0,0.3],"anthropic/claude-sonnet-4.6":[3.0,15.0,0.3],"anthropic/claude-sonnet-5":[2.0,10.0,0.2],"baidu/ernie-5.0-thinking-preview":[0.84,3.37,0.84],"bytedance/doubao-seed-1.8":[0.11,0.28,0.023],"bytedance/doubao-seed-2.0-code":[0.45,2.24,0.09],"bytedance/doubao-seed-2.0-lite":[0.09,0.51,0.02],"bytedance/doubao-seed-2.0-mini":[0.03,0.28,0.01],"bytedance/doubao-seed-2.0-pro":[0.45,2.24,0.09],"bytedance/doubao-seed-code":[0.17,1.12,0.034],"deepseek/deepseek-v3.2":[0.293,0.4395,0.0293],"deepseek/deepseek-v3.2-exp":[0.22,0.33,0.22],"deepseek/deepseek-v4-flash":[0.22,0.66,0.007],"deepseek/deepseek-v4-pro":[0.66,1.98,0.022],"deepseek/deepseek-v4.1-flash":[0.075,0.3,0.0015],"google/gemini-2.5-flash":[0.3,2.5,0.03],"google/gemini-2.5-flash-lite":[0.1,0.4,0.01],"google/gemini-2.5-pro":[1.25,10.0,0.13],"google/gemini-3-flash-preview":[0.5,3.0,0.05],"google/gemini-3.1-flash-lite":[0.25,1.5,0.025],"google/gemini-3.1-pro-preview":[2.0,12.0,0.2],"google/gemini-3.5-flash":[1.5,9.0,0.15],"inclusionai/ring-2.6-1t":[0.1318155,1.0984625,0.0263631],"minimax/minimax-m2":[0.3,1.2,0.03],"minimax/minimax-m2.1":[0.3,1.2,0.03],"minimax/minimax-m2.5":[0.3,1.2,0.03],"minimax/minimax-m2.5-lightning":[0.6,2.4,0.03],"minimax/minimax-m2.7":[0.3,1.2,0.06],"minimax/minimax-m2.7-highspeed":[0.611,2.4439,0.0611],"minimax/minimax-m3":[0.3,1.2,0.06],"minimax/minimax-m3.1-flash":[0.15,0.6,0.015],"moonshotai/kimi-k2.6":[0.95,4.0,0.16],"moonshotai/kimi-k2.7-code":[0.95,4.0,0.19],"moonshotai/kimi-k2.7-code-highspeed":[1.9,8.0,0.38],"moonshotai/kimi-k3":[3.0,15.0,0.3],"openai/chat-latest":[5.0,30.0,0.5],"openai/gpt-5":[1.25,10.0,0.125],"openai/gpt-5-codex":[1.25,10.0,0.125],"openai/gpt-5.1":[1.25,10.0,0.125],"openai/gpt-5.1-codex":[1.25,10.0,0.125],"openai/gpt-5.1-codex-mini":[0.25,2.0,0.025],"openai/gpt-5.2":[1.75,14.0,0.175],"openai/gpt-5.2-codex":[1.75,14.0,0.175],"openai/gpt-5.2-pro":[21.0,168.0,21.0],"openai/gpt-5.3-codex":[1.75,14.0,0.175],"openai/gpt-5.4":[2.5,15.0,0.25],"openai/gpt-5.4-mini":[0.75,4.5,0.075],"openai/gpt-5.4-nano":[0.2,1.25,0.02],"openai/gpt-5.4-pro":[30.0,180.0,30.0],"openai/gpt-5.5":[5.0,30.0,0.5],"openai/gpt-5.5-pro":[30.0,180.0,30.0],"openai/gpt-5.6-luna":[0.2,1.2,0.02],"openai/gpt-5.6-sol":[4.0,20.0,0.4],"openai/gpt-5.6-terra":[2.0,12.0,0.2],"openai/gpt-6-astra":[10.0,50.0,1.0],"openai/gpt-6-sol":[2.0,10.0,0.2],"qwen/qwen3-coder-plus":[1.0,5.0,0.1],"qwen/qwen3-max":[1.2,6.0,1.2],"qwen/qwen3.5-flash":[0.1,0.4,0.02],"qwen/qwen3.5-plus":[0.4,2.4,0.08],"qwen/qwen3.6-plus":[0.5,3.0,0.1],"qwen/qwen3.7-max":[1.25,3.75,0.25],"qwen/qwen3.7-plus":[0.4,1.6,0.08],"stepfun/step-3.5-flash":[0.1,0.3,0.1],"stepfun/step-3.7-flash":[0.2,1.15,0.04],"volcengine/doubao-seed-1.8":[0.11,0.28,0.02],"volcengine/doubao-seed-2.0-code":[0.9,4.48,0.9],"volcengine/doubao-seed-2.0-lite":[0.09,0.51,0.02],"volcengine/doubao-seed-2.0-mini":[0.03,0.28,0.01],"volcengine/doubao-seed-2.0-pro":[0.45,2.24,0.09],"volcengine/doubao-seed-code":[0.17,1.12,0.03],"x-ai/grok-4.2-fast":[2.0,6.0,0.2],"x-ai/grok-4.2-fast-non-reasoning":[2.0,6.0,0.2],"x-ai/grok-4.3":[1.25,2.5,0.2],"x-ai/grok-4.5":[2.0,6.0,0.5],"x-ai/grok-4.6":[2.0,6.0,0.5],"x-ai/grok-build-0.1":[1.0,2.0,0.2],"xiaomi/mimo-v2.5":[0.4,2.0,0.08],"xiaomi/mimo-v2.5-pro":[1.0,3.0,0.2],"xiaomi/mimo-v2.6-pro":[0.435,0.87,0.0036],"z-ai/glm-4.5":[0.2911,1.1645,0.0582],"z-ai/glm-4.5-air":[0.1165,0.2911,0.0233],"z-ai/glm-4.6":[0.2911,1.1645,0.0582],"z-ai/glm-4.6v":[0.1456,0.4367,0.0291],"z-ai/glm-4.6v-flash":[0.0218,0.2184,0.0044],"z-ai/glm-4.6v-flash-free":[0.0,0.0],"z-ai/glm-4.7":[0.2911,1.1645,0.0582],"z-ai/glm-4.7-flash-free":[0.0,0.0],"z-ai/glm-4.7-flashx":[0.0728,0.4367,0.0146],"z-ai/glm-5":[0.58,2.6,0.14],"z-ai/glm-5-turbo":[0.73,3.19,0.174],"z-ai/glm-5.1":[0.8781,3.5126,0.1903],"z-ai/glm-5.2":[1.4,4.4,0.26],"z-ai/glm-5.3":[1.4,4.4,0.26],"z-ai/glm-5.3-flash":[0.075,0.25,0.015],"z-ai/glm-5.3-flashx":[0.375,1.25,0.075],"z-ai/glm-5v-turbo":[0.726,3.1946,0.1743]},"zhipuai":{"glm-4.5":[0.6,2.2,0.11],"glm-4.5-air":[0.11952,0.89637,0.0239],"glm-4.5-flash":[0.0,0.0],"glm-4.5v":[0.29879,0.89637,0.05976],"glm-4.6":[0.6,2.2,0.11],"glm-4.6v":[0.1494,0.44819,0.02988],"glm-4.6v-flash":[0.0,0.0],"glm-4.7":[0.44819,2.09153,0.08964],"glm-4.7-flash":[0.0,0.0],"glm-4.7-flashx":[0.0747,0.44819,0.01494],"glm-5":[0.59758,2.68911,0.1494],"glm-5.1":[0.89637,3.58548,0.19421],"glm-5.2":[1.19516,4.18306,0.29879],"glm-5.3":[1.19516,4.18306,0.29879],"glm-5.3-flash":[0.11952,0.41831,0.03436],"glm-5.3-flashx":[0.29879,1.04577,0.08516],"glm-5v-turbo":[0.74698,3.28669,0.17927]},"zhipuai-coding-plan":{"glm-4.6v":[0.0,0.0],"glm-5.3":[0.0,0.0],"glm-5.3-flash":[0.0,0.0],"glm-5.3-highspeed":[0.0,0.0]}}

/** Hermes provider slug -> models.dev provider id. */
const PROVIDER_ALIASES = {
  'github-copilot': 'github-copilot',
  copilot: 'github-copilot',
  'copilot-acp': 'github-copilot',
  claude: 'anthropic',
  'claude-code': 'anthropic',
  anthropic: 'anthropic',
  openai: 'openai',
  codex: 'openai',
  gemini: 'google',
  'google-gemini': 'google',
  google: 'google',
  vertex: 'google-vertex',
  grok: 'xai',
  xai: 'xai',
  deepseek: 'deepseek',
  kimi: 'moonshotai',
  moonshot: 'moonshotai',
  bedrock: 'amazon-bedrock',
  azure: 'azure',
  groq: 'groq',
  mistral: 'mistral',
  together: 'togetherai',
  openrouter: 'openrouter'
}

/** Candidate model ids for a slug: as-is, tail after '/', and dot/dash swaps. */
function modelAliases(model) {
  const base = String(model).toLowerCase().trim()
  const tail = base.includes('/') ? base.split('/').pop() : base
  const out = new Set([base, tail])
  for (const v of [base, tail]) {
    out.add(v.replace(/\./g, '-'))
    out.add(v.replace(/-(\d)/g, '.$1'))
  }
  return [...out].filter(Boolean)
}

function tableRates(table, names) {
  if (!table) return null
  const row = r => ({ cache: r[2] ?? r[0], input: r[0], output: r[1] ?? 0, inputKnown: false, outputKnown: false, cacheKnown: false })
  for (const n of names) {
    const r = table[n]
    if (Array.isArray(r)) return row(r)
  }
  // Provider tables key some models by a vendor-prefixed slug
  // ("deepseek/deepseek-v4.1-flash") while the live route reports the bare id,
  // or the reverse. Compare the model-name tail, never the provider prefix.
  const wanted = new Set(names.map(n => String(n).toLowerCase().split('/').pop()))
  for (const [key, r] of Object.entries(table)) {
    if (Array.isArray(r) && wanted.has(String(key).toLowerCase().split('/').pop())) return row(r)
  }
  return null
}

/**
 * Bundled models.dev lookup. `own` is true only when the hit came from the
 * table of the provider actually serving the model; any other provider's row
 * is a borrowed price and must be labelled as such.
 */
function bundledLookup(model, provider) {
  if (!model) return null
  const names = modelAliases(model)
  const slug = String(provider || '').toLowerCase().trim()
  const preferred = slug ? PROVIDER_ALIASES[slug] || slug : ''
  if (preferred) {
    const own = tableRates(FALLBACK_RATES[preferred], names)
    if (own) return { own: true, rates: own, source: preferred }
  }
  // Never price one provider's route with another provider's table: a model
  // id repeated across resellers routinely carries different rates.
  return null
}

/** Same identity rule as the app's catalogProviderMatches: slug, name or alias. */
function providerMatches(row, provider) {
  if (!row || !provider) return false
  const want = String(provider).toLowerCase()
  const eq = v => typeof v === 'string' && v.toLowerCase() === want
  return eq(row.slug) || eq(row.name) || (Array.isArray(row.aliases) && row.aliases.some(eq))
}

/** Pull the pricing entry for a model out of a model.options payload. */
function findPricing(payload, model, provider) {
  if (!payload || !Array.isArray(payload.providers) || !model) return null
  const rows = payload.providers
  const want = String(model)
  const tail = want.includes('/') ? want.split('/').pop() : want

  const pick = row => {
    const p = row && row.pricing
    if (!p || typeof p !== 'object') return null
    if (p[want]) return { row, entry: p[want] }
    for (const key of Object.keys(p)) {
      if (key === tail || (key.includes('/') && key.split('/').pop() === tail)) return { row, entry: p[key] }
    }
    return null
  }

  const ownRow = provider ? rows.find(r => providerMatches(r, provider)) : null
  if (ownRow) {
    const hit = pick(ownRow)
    if (hit) return { ...hit, ownProvider: true }
  }
  // A foreign row listing the same model id. Its rates are THAT provider's
  // (nous and github-copilot both carry claude-opus-5 at different prices).
  for (const row of rows) {
    if (row === ownRow) continue
    const hit = pick(row)
    if (hit) return { ...hit, ownProvider: false }
  }
  return null
}

/** {input,output,cache} $/Mtok, or null when the catalog knows nothing. */
function toRates(entry) {
  if (!entry) return null
  const rIn = parseRate(entry.input)
  const rOut = parseRate(entry.output)
  if (rIn == null && rOut == null) return null
  const input = rIn ?? 0
  const output = rOut ?? 0
  const cache = parseRate(entry.cache) ?? input
  return { input, output, cache, write: parseRate(entry.cache_write ?? entry.cacheWrite), inputKnown: rIn != null && Array.isArray(entry.tiers) && entry.tiers.length === 0, outputKnown: rOut != null, cacheKnown: parseRate(entry.cache) != null }
}

function rateKey(provider, model) {
  return `${String(provider || '').toLowerCase()}|${model}`
}

/**
 * Resolve the rates for (model, provider). Order:
 *   1. live catalog row of the serving provider          -> 'live'
 *   2. rates remembered from an earlier live hit there    -> 'remembered'
 *   3. bundled models.dev table of the serving provider   -> 'bundled'
 *   4. anything else (another provider's catalog/table)   -> 'foreign' (+ slug)
 * When the serving provider is unknown, 1–3 are impossible and every price is
 * borrowed: `providerUnknown` lets the UI say so instead of implying a match.
 */
const $backendRates = atom({})
const backendRateBook = {}
const $automaticModelOptions = atom(false)
async function ensureBackendRate(provider, model) {
  const p = String(provider || '').trim(); const m = String(model || '').trim()
  if (!p || !m || typeof rest !== 'function') return
  const identity = membershipIdentityNow()
  const key = JSON.stringify([identity, rateKey(p, m)])
  if (backendRateBook[key] === 'pending') return
  const seen = backendRateBook[key]
  if (seen && Date.now() - seen.at < 5 * 60_000) return
  backendRateBook[key] = 'pending'
  try {
    const result = await rest(`/rates?provider=${encodeURIComponent(p)}&model=${encodeURIComponent(m)}`)
    if (!membershipIdentityCurrent(identity)) { delete backendRateBook[key]; return }
    if (!result?.rate) throw new Error('unpriced')
    const entry = { at: Date.now(), rates: { input: result.rate.input, output: result.rate.output, cache: result.rate.cache_read, write: result.rate.cache_write,
      inputKnown: result.rate.input != null && result.rate.has_tiers === false, outputKnown: result.rate.output != null, cacheKnown: result.rate.cache_read != null },
      provenance: result.rate.provenance, provisional: result.rate.provisional || [],
      stale: Boolean(result.catalogue?.stale), asOf: result.catalogue?.as_of || '', age: result.catalogue?.age_seconds ?? null }
    backendRateBook[key] = entry
    $backendRates.set({ ...backendRateBook })
  } catch {
    if (!membershipIdentityCurrent(identity)) { delete backendRateBook[key]; return }
    backendRateBook[key] = { at: Date.now(), rates: null }
    $backendRates.set({ ...backendRateBook })
  }
}

function resolveRates({ model, provider, payload, remembered }) {
  const p = String(provider || '').trim()
  const base = { foreignSlug: null, provider: p || null, providerUnknown: !p }
  if (!model) return { ...base, origin: 'none', rates: null }
  const served = backendRateBook[JSON.stringify([membershipIdentityNow(), rateKey(p, model)])]
  if (p && served && validRates(served.rates)) {
    return { ...base, origin: 'backend', rates: served.rates, provenance: served.provenance,
      provisional: served.provisional || [], stale: served.stale, asOf: served.asOf, age: served.age }
  }

  const found = findPricing(payload, model, p || null)
  if (p) {
    const live = found && found.ownProvider ? toRates(found.entry) : null
    if (live) return { ...base, origin: 'live', rates: live }
    const saved = remembered && remembered[rateKey(p, model)]
    if (validRates(saved)) return { ...base, origin: 'remembered', rates: saved }
    const own = bundledLookup(model, p)
    if (own && own.own) return { ...base, origin: 'bundled', rates: own.rates }
  }
  // Public coverage: no exact rate for this route, so use a deterministic,
  // clearly-labelled models.dev equivalent. Never an order-dependent borrow.
  const fallback = fallbackLookup(model, p)
  if (fallback) return { ...base, origin: 'fallback', foreignSlug: fallback.source,
    fallbackSlug: fallback.source, rates: fallback.rates }
  const foreignLive = found && !found.ownProvider ? toRates(found.entry) : null
  if (foreignLive) return { ...base, origin: 'fallback', foreignSlug: found.row.slug || '?',
    fallbackSlug: found.row.slug || '?', rates: foreignLive }
  return { ...base, origin: 'none', rates: null }
}

/** Fixed order so the same route always reports the same fallback source. */
const FALLBACK_PRIORITY = ['openrouter', 'nous', 'deepseek', 'openai', 'anthropic', 'google', 'xai']
function fallbackLookup(model, provider) {
  const names = modelAliases(model)
  const skip = String(provider || '').toLowerCase().trim()
  const canonicalSkip = PROVIDER_ALIASES[skip] || skip
  const rest = Object.keys(FALLBACK_RATES).sort().filter(id => id !== canonicalSkip && !FALLBACK_PRIORITY.includes(id))
  for (const id of [...FALLBACK_PRIORITY.filter(x => x !== canonicalSkip), ...rest]) {
    const hit = tableRates(FALLBACK_RATES[id], names)
    if (hit) return { rates: hit, source: id }
  }
  return null
}

/**
 * Hermes' CanonicalUsage splits prompt = input + cache_read + cache_write, so
 * bill each stream at its own rate; absent cache-write rates use the input
 * rate only for the existing general cost estimate, not strict net savings.
 */
function costOf(bucket, rates) {
  if (!bucket || !rates) return null
  const parts = {
    input: (num(bucket.input) * rates.input) / M,
    cacheRead: (num(bucket.cacheRead) * rates.cache) / M,
    cacheWrite: (num(bucket.cacheWrite) * (rates.write ?? rates.input)) / M,
    output: (num(bucket.output) * rates.output) / M
  }
  return { parts, total: parts.input + parts.cacheRead + parts.cacheWrite + parts.output }
}

/** What cache reads saved versus paying the full input rate for them. */
// Kept for the original CSV column and historical ledger compatibility.
function grossCacheReadSavings(cacheRead, rates) {
  return rates ? num(cacheRead) * Math.max(0, rates.input - rates.cache) / M : null
}

function cacheSavings(cacheRead, rates, cacheWrite = 0) {
  if (!rates || rates.inputKnown !== true || rates.outputKnown !== true ||
      !Number.isFinite(rates.input) || !Number.isFinite(rates.output) ||
      (num(cacheRead) && (rates.cacheKnown !== true || !Number.isFinite(rates.cache))) ||
      (num(cacheWrite) && !Number.isFinite(rates.write))) return null
  const readSavings = num(cacheRead) ? num(cacheRead) * (rates.input - rates.cache) : 0
  const writeSavings = num(cacheWrite) ? num(cacheWrite) * (rates.input - rates.write) : 0
  return (readSavings + writeSavings) / M
}

/** Strict single-bucket net value; unknown read/write prices stay unknown. */
function liveSavings(bucket, rates) {
  if (!bucket || !rates) return null
  return cacheSavings(bucket.cacheRead, rates, bucket.cacheWrite)
}

/**
 * UsageStats -> the token streams the ledger tracks.
 *
 * The gateway's `_get_usage` sends `input` (session_input_tokens, falling back
 * to session_prompt_tokens), `prompt` (= input + cache_read + cache_write) and
 * a ROUNDED `cache_hit_pct` that is present only when cache_read > 0. Raw
 * cache_read / cache_write are honoured when a producer sends them.
 *
 *   - both raw counters and positive cache activity -> recorded counters.
 *   - all-zero counters without explicit provenance -> unknown.
 *   - prompt > input, no hit%         -> split is unknown; the gap is retained
 *                                        for total accounting but not hit rate.
 *   - prompt > input, hit% present    -> reads ≈ prompt × hit%, capped at the
 *                                        gap; the rest are writes. ESTIMATED.
 *   - prompt == input, hit% present   -> input fell back to prompt; split it by
 *                                        hit%. ESTIMATED.
 * `input` is never reduced twice: the gap already excludes fresh input.
 */
function readUsage(u) {
  const input = num(u.input)
  const prompt = num(u.prompt)
  const rawHit = Number(u.cache_hit_pct)
  const hitPct = u.cache_hit_pct != null && Number.isFinite(rawHit) ? Math.max(0, Math.min(100, rawHit)) : null
  const base = { calls: num(u.calls), output: num(u.output) }
  const positiveRaw = num(u.cache_read) > 0 || num(u.cache_write) > 0
  const exactRaw = u.cache_read != null && u.cache_write != null &&
    (positiveRaw || u.cache_provenance === 'exact')

  const hasRaw = u.cache_read != null || u.cache_write != null
  if (hasRaw) {
    const cacheRead = num(u.cache_read)
    const cacheWrite = num(u.cache_write)
    const cached = cacheRead + cacheWrite
    // `input` carries the whole prompt when the provider had no split.
    const fresh = prompt && input === prompt && input >= cached ? input - cached : input
    return { ...base, cacheSource: exactRaw ? 'exact' : 'unknown', cacheEstimated: false, cacheRead, cacheWrite, input: fresh }
  }

  if (prompt > input) {
    const gap = prompt - input
    if (hitPct == null) return { ...base, cacheSource: 'unknown', cacheEstimated: true, cacheRead: 0, cacheWrite: gap, input }
    const cacheRead = Math.min(gap, Math.round((prompt * hitPct) / 100))
    return { ...base, cacheSource: 'estimated', cacheEstimated: true, cacheRead, cacheWrite: gap - cacheRead, input }
  }

  if (prompt && hitPct != null && hitPct > 0) {
    const cacheRead = Math.min(prompt, Math.round((prompt * hitPct) / 100))
    return { ...base, cacheSource: 'estimated', cacheEstimated: true, cacheRead, cacheWrite: 0, input: prompt - cacheRead }
  }

  return { ...base, cacheSource: 'unknown', cacheEstimated: hitPct != null && !prompt, cacheRead: 0, cacheWrite: 0, input }
}

/** Prompt-cache hit rate of a bucket, in percent (null without prompt tokens). */
function hitPctOf(b) {
  if (!b) return null
  if (b.cacheSource) {
    const prompt = num(b.input) + num(b.cacheRead) + num(b.cacheWrite)
    return b.cacheSource !== 'unknown' && prompt ? num(b.cacheRead) / prompt * 100 : null
  }
  return num(b.cacheCoveredPrompt) ? num(b.cacheCoveredRead) / num(b.cacheCoveredPrompt) * 100 : null
}

function cacheCoverage(b) {
  if (!b) return null
  const prompt = num(b.input) + num(b.cacheRead) + num(b.cacheWrite)
  if (!prompt) return null
  if (b.cacheSource) return b.cacheSource === 'unknown' ? 0 : 1
  return Math.min(1, num(b.cacheCoveredPrompt) / prompt)
}

function cacheCoverageDetail(b, t) {
  if (!b) return ''
  const prompt = num(b.input) + num(b.cacheRead) + num(b.cacheWrite)
  if (!prompt) return ''
  const exact = b.cacheSource === 'exact' ? prompt : num(b.cacheExactPrompt)
  const estimated = b.cacheSource === 'estimated' ? prompt : num(b.cacheEstimatedPrompt)
  return t('cacheCoverageDetail', Math.round(Math.min(1, exact / prompt) * 100),
    Math.round(Math.min(1, estimated / prompt) * 100))
}

function cacheCoverageLine(t, coverage, bucket) {
  return t('cacheCoverageLine', Math.round((coverage || 0) * 100), cacheCoverageDetail(bucket, t))
}

/* ----------------------------------------------------------------- ledger */

/**
 * v2 shape:
 *   days[YYYY-MM-DD][bucketKey] = Bucket   (bucketKey = profile+provider+model)
 *   snapshots[sid::model]       = last cumulative reading (+ costUsd, at)
 *   rates[provider|model]       = last live catalog rates for that route
 *   legacyRates[model]          = v1's provider-less remembered rates
 *   sessions[storedSessionId]   = Bucket + firstAt/lastAt — a conversation's running
 *                                 total that survives app/gateway restarts
 *   since                       = first day this ledger has data for
 */
function emptyLedger() {
  return { v: LEDGER_VERSION, days: {}, legacyRates: {}, rates: {}, sessions: {}, since: null, snapshots: {} }
}

function bucketKey(profile, provider, model, legacy) {
  return JSON.stringify([profile || '', provider || '', model, legacy ? 1 : 0])
}

function newBucket({ legacy = false, model, profile = '', provider = '' }) {
  return {
    cacheEstimated: false,
    cacheCoveredPrompt: 0,
    cacheCoveredRead: 0,
    cacheExactPrompt: 0,
    cacheEstimatedPrompt: 0,
    netSavings: 0,
    netSavingsPrompt: 0,
    cacheRead: 0,
    cacheWrite: 0,
    calls: 0,
    cost: 0,
    input: 0,
    legacy,
    model,
    output: 0,
    pricedTokens: 0,
    profile,
    provider,
    saved: 0,
    sources: {},
    unpricedTokens: 0
  }
}

const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v)

/** v1 stored tokens only, keyed by model, and re-priced them on every read. */
function migrateV1(raw, now) {
  const led = emptyLedger()
  const at = now ?? Date.now()
  for (const [date, models] of Object.entries(isObj(raw.days) ? raw.days : {})) {
    if (!isObj(models)) continue
    const day = {}
    for (const [model, b] of Object.entries(models)) {
      if (!isObj(b)) continue
      const nb = newBucket({ legacy: true, model })
      nb.input = num(b.input)
      nb.output = num(b.output)
      nb.cacheRead = num(b.cacheRead)
      nb.cacheWrite = num(b.cacheWrite)
      nb.calls = num(b.calls)
      nb.cost = null
      day[bucketKey('', '', model, true)] = nb
    }
    if (Object.keys(day).length) led.days[date] = day
  }
  for (const [k, s] of Object.entries(isObj(raw.snapshots) ? raw.snapshots : {})) {
    if (isObj(s)) led.snapshots[k] = { ...s, at }
  }
  for (const [model, r] of Object.entries(isObj(raw.rates) ? raw.rates : {})) {
    if (validRates(r)) led.legacyRates[model] = r
  }
  led.since = Object.keys(led.days).sort()[0] || null
  return led
}

function normalizeV2(raw) {
  if (!isObj(raw) || raw.v !== LEDGER_VERSION) return null
  return {
    v: LEDGER_VERSION,
    days: isObj(raw.days) ? raw.days : {},
    legacyRates: isObj(raw.legacyRates) ? raw.legacyRates : {},
    rates: isObj(raw.rates) ? raw.rates : {},
    sessions: isObj(raw.sessions) ? raw.sessions : {},
    since: typeof raw.since === 'string' ? raw.since : null,
    snapshots: isObj(raw.snapshots) ? raw.snapshots : {}
  }
}

/** -> { ledger, migrated } from a ctx.storage-like `{ get(key, fallback) }`. */
function readStoredLedger(store, now) {
  if (!store) return { ledger: emptyLedger(), migrated: false }
  const v2 = normalizeV2(store.get(LEDGER_KEY, null))
  if (v2) return { ledger: { ...v2, snapshots: collapseSnapshotKeys(v2.snapshots) }, migrated: false }
  const v1 = store.get(LEGACY_LEDGER_KEY, null)
  if (isObj(v1) && v1.v === 1) {
    const migratedLedger = migrateV1(v1, now)
    return { ledger: { ...migratedLedger, snapshots: collapseSnapshotKeys(migratedLedger.snapshots) }, migrated: true }
  }
  return { ledger: emptyLedger(), migrated: false }
}


/** Collapse legacy `runtime::model` snapshot keys to runtime epochs, keeping the
 *  highest reading for each runtime. Structural migration only: totals and
 *  settled costs are not rewritten. */
function collapseSnapshotKeys(snapshots) {
  const out = {}
  const score = v => num(v.input) + num(v.output) + num(v.cacheRead) + num(v.cacheWrite)
  for (const [key, snap] of Object.entries(snapshots || {})) {
    const runtime = String(key).split('::')[0]
    if (!out[runtime] || score(snap) >= score(out[runtime])) out[runtime] = snap
  }
  return out
}

function pruneDays(days, now) {
  const cutoff = daysAgoKey(KEEP_DAYS - 1, now)
  const out = {}
  for (const k of Object.keys(days)) if (k >= cutoff) out[k] = days[k]
  return out
}

function pruneSessions(sessions, now) {
  const cutoff = now - KEEP_DAYS * 86_400_000
  const fresh = Object.entries(sessions).filter(([, s]) => isObj(s) && num(s.lastAt) >= cutoff)
  if (fresh.length > MAX_SESSIONS) fresh.sort((a, b) => num(b[1].lastAt) - num(a[1].lastAt)).length = MAX_SESSIONS
  return Object.fromEntries(fresh)
}

function changeCacheKnown(cur, init, delta) {
  return cur.cacheSource !== 'unknown' && init.cacheDeltaKnown === true &&
    num(delta.input) + num(delta.cacheRead) + num(delta.cacheWrite) > 0
}

/** Add one priced delta to a bucket (copy-on-write). */
function addDelta(prevBucket, init, { costDelta, cur, delta, deltaTokens, resolved, source }) {
  const b = prevBucket ? { ...prevBucket, sources: { ...prevBucket.sources } } : newBucket(init)
  b.input += delta.input
  b.output += delta.output
  b.cacheRead += delta.cacheRead
  b.cacheWrite += delta.cacheWrite
  b.calls += delta.calls
  const prompt = num(delta.input) + num(delta.cacheRead) + num(delta.cacheWrite)
  if (changeCacheKnown(cur, init, delta)) {
    b.cacheCoveredPrompt = num(b.cacheCoveredPrompt) + prompt
    b.cacheCoveredRead = num(b.cacheCoveredRead) + num(delta.cacheRead)
    if (cur.cacheSource === 'exact') b.cacheExactPrompt = num(b.cacheExactPrompt) + prompt
    if (cur.cacheSource === 'estimated') b.cacheEstimatedPrompt = num(b.cacheEstimatedPrompt) + prompt
    const net = cacheSavings(delta.cacheRead, resolved.rates, delta.cacheWrite)
    if (net != null) {
      b.netSavings = (Number.isFinite(b.netSavings) ? b.netSavings : 0) + net
      b.netSavingsPrompt = num(b.netSavingsPrompt) + prompt
    }
  }
  if (cur.cacheEstimated && (num(delta.cacheRead) || num(delta.cacheWrite) || changeCacheKnown(cur, init, delta))) b.cacheEstimated = true
  if (costDelta != null) {
    b.cost += costDelta
    b.pricedTokens += deltaTokens
    b.sources[source] = num(b.sources[source]) + deltaTokens
    if (source === 'foreign' && resolved.foreignSlug) b.foreignSlug = resolved.foreignSlug
  } else {
    b.unpricedTokens += deltaTokens
  }
  if (resolved.rates) b.saved += grossCacheReadSavings(delta.cacheRead, resolved.rates)
  return b
}

function pruneSnapshots(snaps, now) {
  const fresh = Object.entries(snaps).filter(([, s]) => isObj(s) && now - num(s.at) <= SNAPSHOT_TTL_MS)
  if (fresh.length > MAX_SNAPSHOTS) fresh.sort((a, b) => num(b[1].at) - num(a[1].at)).length = MAX_SNAPSHOTS
  return Object.fromEntries(fresh)
}

function cumulativeCounter(value) {
  if (value == null || value === '' || typeof value === 'boolean') return null
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : null
}

function promptCounterOf(usage) {
  const prompt = cumulativeCounter(usage.prompt)
  const input = cumulativeCounter(usage.input)
  if (prompt != null && (prompt > 0 || input == null || input === 0)) return { value: prompt, source: 'prompt' }
  return input == null ? { value: null, source: null } : { value: input, source: 'input' }
}

function previousPromptCounter(prev, source) {
  if (cumulativeCounter(prev.counterPrompt) != null && prev.counterPromptSource === source) return prev.counterPrompt
  if (source === 'prompt') {
    if (prev.counterPromptSource === 'input' && cumulativeCounter(prev.counterInput) != null) {
      return prev.counterInput + num(prev.cacheRead) + num(prev.cacheWrite)
    }
    if (cumulativeCounter(prev.counterPrompt) != null) return null
    return num(prev.input) + num(prev.cacheRead) + num(prev.cacheWrite)
  }
  if (source === 'input' && cumulativeCounter(prev.counterInput) != null) return prev.counterInput
  if (cumulativeCounter(prev.counterPrompt) != null) return null
  if (source === 'input' && !prev.cacheEstimated && !num(prev.cacheRead) && !num(prev.cacheWrite)) return num(prev.input)
  return null
}

function fitBucketDelta(delta, keys, total) {
  const bucketDelta = keys.reduce((sum, key) => sum + delta[key], 0)
  if (bucketDelta > total && bucketDelta > 0) {
    if (Number.isInteger(total) && Number.isInteger(bucketDelta)) {
      const parts = keys.map(key => {
        const exact = delta[key] * total / bucketDelta
        return { key, value: Math.floor(exact), remainder: exact - Math.floor(exact) }
      })
      let remaining = total - parts.reduce((sum, part) => sum + part.value, 0)
      parts.sort((a, b) => b.remainder - a.remainder)
      for (const part of parts) {
        if (!remaining) break
        if (part.value < delta[part.key]) { part.value += 1; remaining -= 1 }
      }
      for (const part of parts) delta[part.key] = part.value
    } else {
      const scale = total / bucketDelta
      for (const key of keys) delta[key] *= scale
    }
  }
  return bucketDelta < total ? total - bucketDelta : 0
}

function promptDeltaBuckets(cur, prev, promptDelta = null, freshDelta = null) {
  const delta = {
    input: Math.max(0, cur.input - num(prev.input)),
    cacheRead: Math.max(0, cur.cacheRead - num(prev.cacheRead)),
    cacheWrite: Math.max(0, cur.cacheWrite - num(prev.cacheWrite))
  }
  if (promptDelta == null) return delta
  if (freshDelta == null) {
    delta.input += fitBucketDelta(delta, ['input', 'cacheRead', 'cacheWrite'], promptDelta)
  } else {
    delta.input = Math.min(promptDelta, Math.max(0, freshDelta))
    delta.cacheWrite += fitBucketDelta(delta, ['cacheRead', 'cacheWrite'], promptDelta - delta.input)
  }
  return delta
}

/**
 * Fold one session's cumulative counters into the ledger (pure).
 *
 * Counters are cumulative per LIVE agent and reset on restart, /new and
 * /reset, so we diff against the last snapshot for session+model and add only
 * the delta; a counter that went backwards is a fresh run, adopted whole.
 * The delta is priced NOW, with the rates of the route that served it, and
 * the dollars are stored — history never re-prices.
 *
 * Returns the same object when nothing changed.
 */
function applyUsage(led, { now = Date.now(), payload = null, profile = '', provider = '', sessionId, storedId = '', usage }) {
  if (!sessionId || !usage) return led
  const model = String(usage.model || '').trim() || '(unknown)'

  const cur = readUsage(usage)
  if (!tokensOf(cur) && !cur.calls) return led

  const gatewayCost =
    typeof usage.cost_usd === 'number' && Number.isFinite(usage.cost_usd) && usage.cost_usd > 0 ? usage.cost_usd : null
  // The counter epoch is the RUNTIME (sessionId), not the model. A model switch
  // keeps the same cumulative counters, so it must diff against the previous
  // reading; only a new runtime starts a new epoch.
  const snapKey = String(sessionId)
  const prev = led.snapshots[snapKey]
  // Restart detection uses ONLY provider-monotonic counters. `cacheRead` /
  // `cacheWrite` are reconstructed from a rounded `cache_hit_pct` whenever the
  // frame has no raw cache fields, and that estimate can dip as the prompt grows
  // (e.g. 92% of 11k → 91% of 11.1k). Treating such a dip as a new run adopts
  // the whole cumulative total again and permanently inflates the conversation:
  // on 30 Oct 2026, 75 real requests folded to 494 calls / 60.25M tokens.
  const rawPrompt = promptCounterOf(usage)
  const rawInput = cumulativeCounter(usage.input)
  const rawFreshInput = rawPrompt.source === 'prompt' && rawInput != null && rawPrompt.value > rawInput ? rawInput : null
  const rawOutput = cumulativeCounter(usage.output)
  const rawCalls = cumulativeCounter(usage.calls)
  const hasCallCounter = rawCalls != null && rawCalls > 0
  const prevPrompt = prev && rawPrompt.source ? previousPromptCounter(prev, rawPrompt.source) : null
  const prevFreshInput = prev ? cumulativeCounter(prev.counterFreshInput) : null
  const prevInput = prev
    ? cumulativeCounter(prev.counterInput) ?? (prev.counterPromptSource === 'input' ? cumulativeCounter(prev.counterPrompt) : null)
    : null
  const prevOutput = prev
    ? cumulativeCounter(prev.counterOutput) ?? num(prev.output)
    : null
  const prevCalls = prev
    ? cumulativeCounter(prev.counterCalls) ?? num(prev.calls)
    : 0
  const restarted = !prev ||
    (rawPrompt.value != null && prevPrompt != null && rawPrompt.value < prevPrompt) ||
    (rawPrompt.source === 'input' && rawInput != null && prevInput != null && rawInput < prevInput) ||
    (rawOutput != null && prevOutput != null && rawOutput < prevOutput) ||
    (hasCallCounter && prevCalls != null && rawCalls < prevCalls)

  if (!restarted && prev) {
    if (rawPrompt.value == null) {
      cur.input = num(prev.input)
      cur.cacheRead = num(prev.cacheRead)
      cur.cacheWrite = num(prev.cacheWrite)
      cur.cacheEstimated = Boolean(prev.cacheEstimated)
      cur.cacheSource = prev.cacheSource || 'unknown'
    }
    if (rawOutput == null) cur.output = num(prev.output)
  }

  // A payload without `calls` reads as 0. Carry the last known count through a
  // non-restart frame, so neither the delta nor the stored snapshot loses it and
  // a later real reading cannot subtract calls already counted. A genuine restart
  // still adopts the frame as-is: its own counter starts again at 1.
  if (!restarted && !hasCallCounter && prevCalls > 0) cur.calls = prevCalls

  const delta = restarted
    ? cur
    : {
        ...promptDeltaBuckets(
          cur,
          prev,
          rawPrompt.source === 'prompt' && prevPrompt != null ? Math.max(0, rawPrompt.value - prevPrompt) : null,
          rawFreshInput != null && prevFreshInput != null ? Math.max(0, rawFreshInput - prevFreshInput) : null
        ),
        calls: hasCallCounter ? Math.max(0, cur.calls - prevCalls) : 0,
        output: rawOutput != null && prevOutput != null ? Math.max(0, rawOutput - prevOutput) : 0
      }
  const deltaTokens = tokensOf(delta)
  // Nothing new — don't churn storage on every mid-turn tick.
  if (!deltaTokens && !delta.calls) return led

  const resolved = resolveRates({ model, payload, provider, remembered: led.rates })
  let costDelta = null
  let source = 'none'
  const prevGateway = prev && typeof prev.costUsd === 'number' ? prev.costUsd : null
  if (gatewayCost != null && (restarted || (prevGateway != null && gatewayCost >= prevGateway))) {
    costDelta = restarted ? gatewayCost : gatewayCost - prevGateway
    source = 'gateway'
  } else if (resolved.rates) {
    costDelta = costOf(delta, resolved.rates).total
    source = resolved.origin
  }

  const day = dayKey(now)
  const key = bucketKey(profile, provider, model, false)
  const days = { ...led.days }
  const forDay = { ...(days[day] || {}) }
  const cacheDeltaKnown = cur.cacheSource !== 'unknown' && (restarted || prev?.cacheSource === cur.cacheSource)
  const change = { costDelta, cur, delta, deltaTokens, resolved, source }
  const b = addDelta(forDay[key], { model, profile, provider, cacheDeltaKnown }, change)
  forDay[key] = b
  days[day] = forDay

  const rates =
    resolved.origin === 'live' && provider ? { ...led.rates, [rateKey(provider, model)]: resolved.rates } : led.rates
  const snapshots = pruneSnapshots({ ...led.snapshots, [snapKey]: {
    ...cur,
    at: now,
    costUsd: gatewayCost,
    counterPrompt: restarted || rawPrompt.value != null ? rawPrompt.value : prev?.counterPrompt ?? null,
    counterPromptSource: restarted || rawPrompt.value != null ? rawPrompt.source : prev?.counterPromptSource ?? null,
    counterInput: restarted || rawInput != null ? rawInput : prev?.counterInput ?? null,
    counterFreshInput: restarted || rawPrompt.value != null ? rawFreshInput : prev?.counterFreshInput ?? null,
    counterOutput: restarted || rawOutput != null ? rawOutput : prev?.counterOutput ?? null,
    counterCalls: restarted ? hasCallCounter ? rawCalls : null : hasCallCounter ? rawCalls : prev?.counterCalls ?? null
  } }, now)
  const pruned = pruneDays(days, now)
  const since = led.since && led.since <= day ? led.since : Object.keys(pruned).sort()[0] || day

  let sessions = led.sessions || {}
  if (storedId) {
    const prevS = sessions[storedId]
    const s = addDelta(prevS, { model, profile, provider, cacheDeltaKnown }, change)
    // The pane shows the conversation's latest route.
    s.model = model
    s.profile = profile
    s.provider = provider
    s.firstAt = prevS ? num(prevS.firstAt) || now : now
    s.lastAt = now
    sessions = pruneSessions({ ...sessions, [storedId]: s }, now)
  }

  return { ...led, days: pruned, rates, sessions, since, snapshots }
}

/**
 * Rates for a legacy (v1, provider-less) bucket. Its route was never recorded,
 * so it stays unpriced unless a remembered rate exists: borrowing a provider's
 * card would reprice old calls whenever the catalog's ordering changes.
 */
function legacyPricer(payload, legacyRates) {
  return model => {
    const saved = legacyRates && legacyRates[model]
    if (validRates(saved)) return { origin: 'remembered', rates: saved }
    return { origin: 'none', rates: null }
  }
}

/**
 * Sum buckets over the days matching `filter`, one row per
 * profile+provider+model, plus totals for the range.
 */
function summarize(led, filter, priceLegacy) {
  const rows = {}
  for (const [date, buckets] of Object.entries(led.days)) {
    if (!filter(date) || !isObj(buckets)) continue
    for (const [key, b] of Object.entries(buckets)) {
      if (!isObj(b)) continue
      const r = rows[key] || (rows[key] = { ...newBucket(b), cost: b.legacy ? null : 0 })
      for (const f of ['input', 'output', 'cacheRead', 'cacheWrite', 'calls', 'pricedTokens', 'unpricedTokens', 'saved', 'cacheCoveredPrompt', 'cacheCoveredRead', 'cacheExactPrompt', 'cacheEstimatedPrompt', 'netSavingsPrompt']) {
        r[f] += num(b[f])
      }
      if (Number.isFinite(b.netSavings)) r.netSavings += b.netSavings
      if (!b.legacy) r.cost += num(b.cost)
      if (b.cacheEstimated) r.cacheEstimated = true
      if (b.foreignSlug) r.foreignSlug = b.foreignSlug
      for (const [s, n] of Object.entries(isObj(b.sources) ? b.sources : {})) r.sources[s] = num(r.sources[s]) + num(n)
    }
  }

  const totals = {
    cacheEstimated: false,
    cost: 0,
    foreignTokens: 0,
    known: false,
    legacyTokens: 0,
    prompt: 0,
    read: 0,
    saved: 0,
    cacheCoveredPrompt: 0,
    cacheCoveredRead: 0,
    cacheExactPrompt: 0,
    cacheEstimatedPrompt: 0,
    netSavings: 0,
    netSavingsPrompt: 0,
    unpricedTokens: 0
  }
  const list = Object.values(rows).map(r => {
    if (r.legacy) {
      const priced = priceLegacy ? priceLegacy(r.model) : null
      r.legacyOrigin = priced ? priced.origin : 'none'
      if (priced && priced.rates) {
        r.cost = costOf(r, priced.rates).total
        r.saved = grossCacheReadSavings(r.cacheRead, priced.rates)
        r.foreignSlug = priced.foreignSlug || null
      } else {
        r.unpricedTokens = tokensOf(r)
      }
      totals.legacyTokens += tokensOf(r)
    } else if (!r.pricedTokens) {
      r.cost = null
    }
    if (r.cost != null) {
      totals.cost += r.cost
      totals.known = true
    }
    totals.saved += num(r.saved)
    totals.cacheCoveredPrompt += num(r.cacheCoveredPrompt)
    totals.cacheCoveredRead += num(r.cacheCoveredRead)
    totals.cacheExactPrompt += num(r.cacheExactPrompt)
    totals.cacheEstimatedPrompt += num(r.cacheEstimatedPrompt)
    totals.netSavings += r.netSavings
    totals.netSavingsPrompt += num(r.netSavingsPrompt)
    totals.read += num(r.cacheRead)
    totals.prompt += num(r.input) + num(r.cacheRead) + num(r.cacheWrite)
    totals.unpricedTokens += num(r.unpricedTokens)
    totals.foreignTokens += num(r.sources.foreign) + (r.legacy && r.legacyOrigin === 'foreign' ? tokensOf(r) : 0)
    if (r.cacheEstimated) totals.cacheEstimated = true
    return r
  })
  list.sort((a, b) => num(b.cost) - num(a.cost) || tokensOf(b) - tokensOf(a))
  totals.hitPct = hitPctOf(totals)
  totals.cacheCoverage = cacheCoverage({ input: totals.prompt, cacheCoveredPrompt: totals.cacheCoveredPrompt })
  totals.netSavings = totals.prompt && totals.netSavingsPrompt === totals.prompt ? totals.netSavings : null
  return { rows: list, totals }
}

const RANGES = {
  today: () => {
    const t = dayKey()
    return d => d === t
  },
  week: () => {
    const since = daysAgoKey(6)
    return d => d >= since
  },
  month: () => {
    const p = dayKey().slice(0, 7)
    return d => d.startsWith(p)
  },
  all: () => () => true
}

/* ----------------------------------------------------------------- export */

/** CSV cell: quoted when needed, and neutralised against spreadsheet formula injection. */
function csvCell(v) {
  if (v == null) return ''
  let s = String(v)
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

const CSV_COLUMNS = [
  'date', 'profile', 'provider', 'model', 'input', 'output', 'cache_read', 'cache_write', 'calls',
  'cost_usd', 'cost_basis', 'priced_tokens', 'unpriced_tokens', 'cache_saved_usd', 'cache_estimated', 'net_cache_savings_usd'
]

function costBasis(b) {
  if (b.legacy) return 'legacy-unsettled'
  const keys = Object.keys(b.sources || {}).filter(k => num(b.sources[k]))
  return keys.sort().join('+') || 'none'
}

function ledgerCsv(led) {
  const lines = [CSV_COLUMNS.join(',')]
  for (const date of Object.keys(led.days).sort()) {
    const buckets = Object.values(led.days[date] || {}).sort((a, b) => String(a.model).localeCompare(String(b.model)))
    for (const b of buckets) {
      lines.push(
        [
          date, b.profile || '', b.provider || '', b.model, num(b.input), num(b.output), num(b.cacheRead),
          num(b.cacheWrite), num(b.calls), b.legacy || !num(b.pricedTokens) ? '' : Number(num(b.cost).toFixed(6)),
          costBasis(b), num(b.pricedTokens), num(b.unpricedTokens),
          b.legacy ? '' : Number(num(b.saved).toFixed(6)), b.cacheEstimated ? 'yes' : 'no',
          num(b.netSavingsPrompt) && num(b.netSavingsPrompt) === num(b.input) + num(b.cacheRead) + num(b.cacheWrite)
            ? Number(b.netSavings.toFixed(6)) : ''
        ]
          .map(csvCell)
          .join(',')
      )
    }
  }
  return `${lines.join('\r\n')}\r\n`
}

/* ---------------------------------------------------------------- runtime */

/** Live mirror of the persisted ledger so React re-renders on every commit. */
const $ledger = atom(emptyLedger())
const $range = atom('today')
/** 'all' = authoritative gateway ledger; 'desktop' = the local observed ledger. */
const $view = atom(VIEW_ALL)
/** Breakdown shown in the All Hermes table. */
const $group = atom('route')
const $basis = atom('hybrid')
/** Namespace-scoped backend door (ctx.rest); null on a build without it. */
let rest = null
/** Last storage write failure (null when the latest write succeeded). */
const $storageError = atom(null)
let storage = null
/** ctx.os (curated OS door) — absent on older app builds. */
let osApi = null

function saveLedger(next) {
  $ledger.set(next)
  if (!storage) return
  try {
    storage.set(LEDGER_KEY, next)
    if ($storageError.get()) $storageError.set(null)
  } catch (err) {
    const message = String((err && err.message) || err)
    if (!$storageError.get()) {
      try {
        host.notify({ kind: 'warning', message: `Spend Sense could not save its Desktop ledger (${message})` })
      } catch {
        /* notify is best-effort */
      }
    }
    $storageError.set(message)
  }
}

/**
 * Provider/model identity is per ACTIVE selection, not per session. A session
 * that switches model mid-conversation keeps the same id, so the cache key must
 * carry the model too or the old provider is served for minutes.
 */
function sameModel(a, b) {
  const norm = v => String(v || '').toLowerCase().trim().split('/').pop()
  return !!norm(a) && norm(a) === norm(b)
}

/** Provider is authoritative only when the payload describes the active model. */
function liveProvider(payload, activeModel) {
  if (!activeModel || !payload || typeof payload.provider !== 'string') return ''
  if (payload.model && activeModel && !sameModel(payload.model, activeModel)) return ''
  return payload.provider
}

function catalogQuery(sessionId, model, allowRefresh = $automaticModelOptions.get()) {
  const identity = typeof membershipIdentityNow === 'function' ? membershipIdentityNow() : 'default'
  const queryKey = [ID, 'model-options', identity, sessionId || 'global', sessionId ? String(model || '') : '']
  return {
    queryFn: () => {
      if (allowRefresh) return host.request('model.options', sessionId ? { session_id: sessionId } : {})
      const cached = queryClient.getQueryData(queryKey)
      if (cached != null) return cached
      throw new Error('Automatic Hermes model options refresh is off.')
    },
    queryKey,
    retry: 1,
    // A session payload describes a live route; never serve a switched-away
    // provider from cache. The global picker catalog can stay warm.
    staleTime: allowRefresh ? sessionId ? 0 : CATALOG_STALE_MS : Infinity
  }
}

/** The session's model.options payload (cached; stale data beats none on error). */
async function getCatalog(sessionId, model) {
  const q = catalogQuery(sessionId, model)
  try {
    return await queryClient.fetchQuery(q)
  } catch {
    return queryClient.getQueryData(q.queryKey) ?? null
  }
}

/**
 * Owner profile of a session. Exact for the focused chat; other sessions fall
 * back to the gateway socket's profile (the SDK exposes no per-session owner).
 */
function profileFor(sessionId) {
  try {
    if (sessionId && sessionId === host.state.focusedSessionId.get()) {
      return host.state.focusedSessionProfile.get() || host.state.profile.get() || ''
    }
    return host.state.profile.get() || ''
  } catch {
    return ''
  }
}

/**
 * Live (runtime) session id -> durable stored session id. Runtime ids change
 * every time a conversation is resumed; stored ids don't, so per-conversation
 * totals are keyed by the latter. Learned whenever a session is focused.
 */
const storedIds = new Map()

function learnStoredId() {
  try {
    const sid = host.state.focusedSessionId.get()
    const stored = host.state.focusedStoredSessionId.get()
    if (sid && stored) storedIds.set(JSON.stringify([membershipIdentityNow(), sid]), stored)
  } catch {
    /* older hosts: no stored id, per-conversation totals just stay empty */
  }
}

function storedIdFor(sessionId) {
  learnStoredId()
  return storedIds.get(JSON.stringify([membershipIdentityNow(), sessionId])) || ''
}

/** Per-session serial queue: readings for one session commit in arrival order. */
const chains = new Map()
let pluginLifetime = 0

function enqueueUsage(sessionId, usage) {
  if (!sessionId || !usage) return null
  const snapshot = { ...usage }
  const identity = membershipIdentityNow()
  const lifetime = pluginLifetime
  const profile = profileFor(sessionId)
  const storedId = storedIdFor(sessionId)
  const prev = chains.get(sessionId) || Promise.resolve()
  const run = prev
    .then(async () => {
      // An ambient SDK request must never settle a reading from another activation.
      if (lifetime !== pluginLifetime || !membershipIdentityCurrent(identity)) return
      const payload = await getCatalog(sessionId, snapshot.model)
      if (lifetime !== pluginLifetime || !membershipIdentityCurrent(identity)) return
      const provider = liveProvider(payload, snapshot.model)
      const led = $ledger.get()
      const next = applyUsage(led, { payload, profile, provider, sessionId, storedId, usage: snapshot })
      if (next !== led) saveLedger(next)
    })
    .catch(() => console.warn(`[${ID}] usage not recorded`))
  chains.set(sessionId, run)
  run.finally(() => {
    if (chains.get(sessionId) === run) chains.delete(sessionId)
  })
  return run
}

async function writeClipboard(text) {
  try {
    if (osApi && typeof osApi.writeClipboard === 'function' && (await osApi.writeClipboard(text))) return true
  } catch {
    /* fall through */
  }
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    /* fall through to the desktop bridge */
  }
  try {
    const bridge = typeof window !== 'undefined' && window.hermesDesktop
    if (bridge && typeof bridge.writeClipboard === 'function') {
      await bridge.writeClipboard(text)
      return true
    }
  } catch {
    /* no clipboard */
  }
  return false
}

async function exportLedger(kind, t) {
  const led = $ledger.get()
  const text =
    kind === 'csv' ? ledgerCsv(led) : JSON.stringify({ exportedAt: new Date().toISOString(), ledger: led }, null, 2)
  if (kind === 'json-copy') {
    const ok = await writeClipboard(text)
    host.notify({ kind: ok ? 'success' : 'error', message: ok ? t('copied') : t('exportFailed') })
    return
  }
  try {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `spend-sense-${dayKey()}.csv`
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
  } catch {
    const ok = await writeClipboard(text)
    host.notify({ kind: ok ? 'info' : 'error', message: ok ? t('csvCopied') : t('exportFailed') })
  }
}

/* ------------------------------------------------------------- side pane */

/**
 * Side-pane placement. Docked as a tab beside the core Files pane, so it shares
 * that zone and the title bar's right-sidebar toggle shows/hides it like Files.
 * The dock is only a first-adoption hint: if Files is absent, the host falls
 * back to any right-placed zone, and a user's own drag is kept on later boots.
 */
const PANE_DATA = { placement: 'right', width: '268px', dock: { pane: 'files', pos: 'center' } }

/* ---------------------------------------------------------------- routing */

/** Last app route that wasn't the ledger page — where "close" goes back to. */
let returnTo = null

function currentRoute() {
  return (typeof window !== 'undefined' && window.location.hash.slice(1)) || '/'
}

function isLedgerRoute(route) {
  return route === LEDGER_ROUTE || route.startsWith(`${LEDGER_ROUTE}?`) || route.startsWith(`${LEDGER_ROUTE}/`)
}

function rememberRoute() {
  const route = currentRoute()
  if (!isLedgerRoute(route)) returnTo = route
}

/** Entering the page from anywhere: the route we LEFT is the one to return to. */
function onHashChange(e) {
  const old = e && typeof e.oldURL === 'string' && e.oldURL.includes('#') ? e.oldURL.split('#').slice(1).join('#') || '/' : null
  if (old && !isLedgerRoute(old) && isLedgerRoute(currentRoute())) returnTo = old
  else rememberRoute()
}

function openLedger() {
  rememberRoute()
  host.navigate(LEDGER_ROUTE)
}

function closeLedger() {
  const target = returnTo && !isLedgerRoute(returnTo) ? returnTo : '/'
  host.navigate(target)
}

/* ------------------------------------------------------------------ hooks */

const $none = atom(null)

/** The focused session's live numbers, priced with ITS provider's catalog. */
/**
 * Which bucket the pane presents for a conversation: the durable conversation
 * total once it exists and is at least as large as the live run, otherwise the
 * live run's own counters. The chip label and the note must both follow this.
 */
function liveScope(hist, bucket) {
  const histTokens = hist ? tokensOf(hist) : 0
  if (histTokens && (!bucket || histTokens >= tokensOf(bucket))) return 'conversation'
  return 'run'
}

function useLive() {
  const sessionId = useValue(host.state.focusedSessionId)
  const storedId = useValue(host.state.focusedStoredSessionId || $none)
  const rawUsage = useValue(host.state.focusedUsage)
  const stateModel = useValue(host.state.model)
  const led = useValue($ledger)
  const allowRefresh = useValue($automaticModelOptions)
  // After a restart the host seeds the focused session with an all-zero usage
  // object; treat that as "nothing yet" so the UI falls back to the ledger.
  const usage =
    rawUsage && (num(rawUsage.input) || num(rawUsage.output) || num(rawUsage.total) || num(rawUsage.calls))
      ? rawUsage
      : null

  // The live usage stream carries the model actually running; without it fall
  // back to the host's selected model, then to the catalog's own value.
  const activeModel = (usage && usage.model) || stateModel || ''
  const modelQuery = catalogQuery(sessionId, activeModel, allowRefresh)
  const hasCachedOptions = queryClient.getQueryData(modelQuery.queryKey) != null
  const { data: payload, error, isLoading } = useQuery({
    ...modelQuery,
    enabled: allowRefresh || hasCachedOptions,
    staleTime: allowRefresh ? modelQuery.staleTime : Infinity,
    refetchInterval: allowRefresh ? 15 * 60 * 1000 : false
  })

  const provider = liveProvider(payload, activeModel)
  const model = activeModel || (payload && payload.model) || ''
  const resolved = resolveRates({ model, payload, provider, remembered: led.rates })
  const bucket = usage ? readUsage(usage) : null
  const computed = costOf(bucket, resolved.rates)
  const backendCost =
    usage && typeof usage.cost_usd === 'number' && usage.cost_usd > 0 ? usage.cost_usd : null

  // The conversation's recorded total (all runs, survives restarts). It is
  // written on every usage tick, so while a run is live it already includes
  // it; prefer it whenever it exists and isn't behind the live counters.
  const hist = storedId && led.sessions ? led.sessions[storedId] : null
  if (liveScope(hist, bucket) === 'conversation') {
    const kinds = Object.keys(hist.sources || {}).filter(k => num(hist.sources[k]))
    const histSource = !hist.pricedTokens ? 'none' : kinds.length === 1 ? kinds[0] : 'mixed'
    const histModel = hist.model || model
    const histRates = usage ? resolved : resolveRates({ model: histModel, payload, provider: hist.provider || provider, remembered: led.rates })
    return {
      bucket: hist,
      cacheHitPct: hitPctOf(hist),
      cost: hist.pricedTokens ? hist.cost : null,
      costSource: histSource,
      foreignSlug: hist.foreignSlug || resolved.foreignSlug,
      // This branch always returns the durable conversation bucket, so the
      // scope chip must say "conversation" even while a run is live. It used to
      // read "this run" beside a note saying "conversation total since …".
      fromHistory: true,
      model: (usage && usage.model) || histModel,
      partial: num(hist.unpricedTokens) > 0 && num(hist.pricedTokens) > 0,
      pricingError: error ? String(error.message || error) : null,
      pricingLoading: isLoading,
      // While a run is live, the current route is the live one or unknown;
      // never present a previously recorded route as the active selection.
      provider: provider || (!usage ? (hist.provider || null) : null),
      providerUnknown: !(provider || (!usage && hist.provider)),
      rates: histRates.rates,
      saved: num(hist.netSavingsPrompt) === num(hist.input) + num(hist.cacheRead) + num(hist.cacheWrite) && num(hist.netSavingsPrompt)
        ? hist.netSavings : null,
      cacheCoverage: cacheCoverage(hist),
      sinceAt: hist.firstAt,
      usage
    }
  }

  return {
    bucket,
    cacheHitPct: bucket ? hitPctOf(bucket) : null,
    cost: backendCost != null ? backendCost : computed ? computed.total : null,
    costSource: backendCost != null ? 'gateway' : computed ? resolved.origin : 'none',
    foreignSlug: resolved.foreignSlug,
    model,
    pricingError: error ? String(error.message || error) : null,
    pricingLoading: isLoading,
    provider: provider || null,
    providerUnknown: !provider,
    rates: resolved.rates,
    // A cumulative run can span models; one current price cannot value it.
    saved: bucket?.cacheSource !== 'unknown' && num(bucket?.calls) === 1
      ? liveSavings(bucket, resolved.rates) : null,
    cacheCoverage: cacheCoverage(bucket),
    usage
  }
}

/** Ledger summary for a range, legacy rows priced against the global catalog. */
function useSummary(range) {
  const led = useValue($ledger)
  const allowRefresh = useValue($automaticModelOptions)
  const modelQuery = catalogQuery(null, '', allowRefresh)
  const hasCachedOptions = queryClient.getQueryData(modelQuery.queryKey) != null
  const { data: payload } = useQuery({ ...modelQuery, enabled: allowRefresh || hasCachedOptions })
  return summarize(led, RANGES[range](), legacyPricer(payload, led.legacyRates))
}

/* --------------------------------------------------------------------- UI */

function fmtDate(ms) {
  const d = new Date(num(ms))
  if (Number.isNaN(d.getTime())) return '—'
  const p2 = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`
}

/** Human labels for pricing-source identifiers. A missing translation key must
 *  never reach the UI: the host returns the key itself, so `src_backend` would
 *  render as a system identifier beside a price. None of these imply a
 *  provider-reported charge. */
const SOURCE_FALLBACKS = {
  backend: 'Hermes backend estimate',
  bundled: 'models.dev table estimate',
  gateway: 'gateway-reported',
  live: 'catalogue rates (estimate)',
  remembered: 'remembered catalogue rates',
  mixed: 'mixed pricing sources',
  none: 'pricing unavailable'
}

function sourceFallback(origin) {
  const id = String(origin || '').replace(/^src_/, '')
  if (SOURCE_FALLBACKS[id]) return SOURCE_FALLBACKS[id]
  const words = id.replace(/[_-]+/g, ' ').trim()
  // Never echo a raw identifier; say plainly that it is an estimate.
  return words ? `${words} (estimate)` : SOURCE_FALLBACKS.none
}

function sourceLabel(t, origin, foreignSlug, providerUnknown) {
  if (origin === 'fallback') return t('src_fallback', foreignSlug || 'models.dev')
  if (origin === 'foreign') return providerUnknown ? t('src_unconfirmed', foreignSlug || '?') : t('src_foreign', foreignSlug || '?')
  const key = `src_${origin}`
  const label = t(key)
  if (!label || label === key || /^src_/.test(label)) return sourceFallback(origin)
  return label
}

/** Totals heading. The figures aggregate the whole conversation across runtime
 *  restarts, so they must not be described as a single session. */
function scopeTotalsTitle(t, fromHistory) {
  return fromHistory ? t('scopeTotalsConversation') : t('scopeTotalsRun')
}

/** Token rows for the pane. Provider counters (input, output, calls) are shown
 *  exactly; only derived cache fields carry the ≈ marker and a `derived` tag,
 *  because a reconstructed cache-write is not provider-confirmed usage. */
function tokenRows(t, b, hasContext, u) {
  const approx = b.cacheEstimated ? '≈' : ''
  const derived = b.cacheEstimated ? t('derivedMark') : ''
  const rows = [
    { key: 'i', label: t('input'), value: fmtTokens(b.input) },
    { key: 'o', label: t('output'), value: fmtTokens(b.output) },
    b.cacheRead ? { key: 'cr', dim: true, label: t('cacheRead') + derived, value: `${approx}${fmtTokens(b.cacheRead)}` } : null,
    b.cacheWrite ? { key: 'cw', dim: true, label: t('cacheWrite') + derived, value: `${approx}${fmtTokens(b.cacheWrite)}` } : null,
    // The total includes the derived cache, so it is an estimate too — mark it
    // rather than letting an exact-looking figure carry an estimated component.
    { key: 'tt', label: t('total') + (b.cacheEstimated ? t('inclDerived') : ''), value: `${approx}${fmtTokens(tokensOf(b))}` },
    { key: 'c', dim: true, label: t('calls'), value: String(b.calls ?? 0) }
  ]
  if (hasContext) {
    rows.push({ key: 'ctx', dim: true, label: t('context'), value: `${Math.round(u.context_percent)}% · ${fmtTokens(u.context_used)}/${fmtTokens(u.context_max)}` })
  }
  return rows.filter(Boolean)
}

function Chip() {
  const t = usePluginI18n(ID)
  const live = useLive()
  const today = useSummary('today').totals
  const open = openLedger
  const todayText = today.known ? `${t('today')} ${fmtUsd(today.cost)}${today.unpricedTokens ? '+' : ''}` : null

  if (!live.bucket) {
    return jsx(Tip, {
      label: t('chipTipIdle'),
      children: jsx('button', {
        className: cn(
          'inline-flex h-full items-center px-1.5 text-[0.6875rem] transition-colors',
          'text-(--ui-text-quaternary) hover:bg-(--chrome-action-hover) hover:text-foreground'
        ),
        onClick: open,
        type: 'button',
        children: todayText || t('idle')
      })
    })
  }

  const warn = live.costSource === 'foreign' || live.costSource === 'none'
  return jsx(Tip, {
    label: t(
      'chipTip',
      live.model || '—',
      sourceLabel(t, live.costSource, live.foreignSlug, live.providerUnknown),
      fmtUsd(today.cost),
      live.cacheHitPct != null ? `${live.bucket?.cacheEstimated ? '≈' : ''}${Math.round(live.cacheHitPct)}%` : '—',
      live.saved != null ? `${live.bucket && live.bucket.cacheEstimated ? '≈' : ''}${fmtUsd(live.saved)}` : '—'
    ),
    children: jsxs('button', {
      className: cn(
        'inline-flex h-full items-center gap-1.5 px-1.5 text-[0.6875rem] transition-colors',
        'text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground'
      ),
      onClick: open,
      type: 'button',
      children: [
        jsx('span', { children: `${fmtTokens(live.bucket.input)}↑ ${fmtTokens(live.bucket.output)}↓` }),
        jsx('span', { className: 'text-(--ui-text-quaternary)', children: '·' }),
        jsx('span', {
          className: live.cost == null ? 'text-(--ui-text-quaternary)' : warn ? 'text-(--ui-warning)' : 'text-(--ui-accent)',
          children: live.cost == null ? t('noPrice') : `${warn ? '⚠ ' : ''}${fmtUsd(live.cost)}`
        }),
        live.cacheHitPct != null
          ? jsx('span', { className: 'text-(--ui-text-quaternary)', children: `· ⚡${live.bucket?.cacheEstimated ? '≈' : ''}${Math.round(live.cacheHitPct)}%` })
          : null,
        todayText ? jsx('span', { className: 'text-(--ui-text-quaternary)', children: `· ${todayText}` }) : null
      ].filter(Boolean)
    })
  })
}

/** Thin proportional bar: cached (accent) vs fresh (muted) prompt tokens. */
function CacheBar({ pct }) {
  const clamped = Math.max(0, Math.min(100, pct))
  return jsx('div', {
    className: 'h-1 w-full overflow-hidden rounded-full bg-(--ui-fill-tertiary)',
    children: jsx('div', {
      className: 'h-full rounded-full bg-(--ui-accent) transition-[width] duration-500',
      style: { width: `${clamped}%` }
    })
  })
}

function Row({ dim, label, value }) {
  return jsxs('div', {
    className: 'flex items-baseline justify-between gap-3 tabular-nums',
    children: [
      jsx('span', { className: 'min-w-0 truncate text-(--ui-text-tertiary)', children: label }),
      jsx('span', { className: cn('shrink-0', dim && 'text-(--ui-text-quaternary)'), children: value })
    ]
  })
}

function Section({ children, title }) {
  return jsxs('div', {
    className: 'flex flex-col gap-1',
    children: [
      jsx('div', { className: 'text-[0.625rem] tracking-wide text-(--ui-text-quaternary) uppercase', children: title }),
      jsx('div', { className: 'flex flex-col gap-0.5 text-xs', children })
    ]
  })
}

function Note({ children, warn }) {
  return jsx('div', {
    className: cn('text-[0.6875rem] leading-relaxed', warn ? 'text-(--ui-warning)' : 'text-(--ui-text-quaternary)'),
    children
  })
}

/** Caveats for a range summary — shown wherever a total is shown. */
function rangeNotes(t, totals, storageError) {
  const notes = []
  if (storageError) notes.push(jsx(Note, { warn: true, children: t('storageError', storageError) }, 'st'))
  if (totals.unpricedTokens) notes.push(jsx(Note, { warn: true, children: t('unpricedNote', fmtTokens(totals.unpricedTokens)) }, 'up'))
  if (totals.foreignTokens) notes.push(jsx(Note, { warn: true, children: t('foreignNote', fmtTokens(totals.foreignTokens)) }, 'fo'))
  if (totals.legacyTokens) notes.push(jsx(Note, { children: t('legacyNote', fmtTokens(totals.legacyTokens)) }, 'lg'))
  if (totals.cacheCoverage != null) notes.push(jsx(Note, { children: t('cacheCoverageRange', Math.round(totals.cacheCoverage * 100)) }, 'cc'))
  if (totals.cacheEstimated) notes.push(jsx(Note, { children: t('cacheEstNote') }, 'ce'))
  return notes
}

/**
 * Spend Sense marque (assets/branding/spend-sense-marque-v2.svg), inlined
 * because the desktop plugin loader forbids relative asset imports. Rendered
 * small and decorative beside existing titles — never a hero element — with
 * fixed dimensions so it cannot shift surrounding layout. Each call site passes
 * a distinct `id` so the inline gradient defs never share a document id.
 */
const BRAND_MARK_PATH = 'M 352.000000 84.000000 L 208.000000 84.000000 C 200.573938 84.000000 193.452029 86.949992 188.201010 92.201010 L 92.201010 188.201010 C 86.949992 193.452029 84.000000 200.573938 84.000000 208.000000 L 84.000000 224.000000 C 84.000000 233.958678 89.289516 243.167920 97.891611 248.185809 L 265.891611 346.185809 C 279.249065 353.977657 296.393961 349.465842 304.185809 336.108389 C 311.977657 322.750935 307.465842 305.606039 294.108389 297.814191 L 126.108389 199.814191 L 112.000000 224.000000 L 140.000000 224.000000 L 140.000000 208.000000 L 112.000000 208.000000 L 131.798990 227.798990 L 227.798990 131.798990 L 208.000000 140.000000 L 352.000000 140.000000 C 367.463973 140.000000 380.000000 127.463973 380.000000 112.000000 C 380.000000 96.536027 367.463973 84.000000 352.000000 84.000000 Z M 160.000000 428.000000 L 304.000000 428.000000 C 311.426062 428.000000 318.547971 425.050008 323.798990 419.798990 L 419.798990 323.798990 C 425.050008 318.547971 428.000000 311.426062 428.000000 304.000000 L 428.000000 288.000000 C 428.000000 278.041322 422.710484 268.832080 414.108389 263.814191 L 246.108389 165.814191 C 232.750935 158.022343 215.606039 162.534158 207.814191 175.891611 C 200.022343 189.249065 204.534158 206.393961 217.891611 214.185809 L 385.891611 312.185809 L 400.000000 288.000000 L 372.000000 288.000000 L 372.000000 304.000000 L 400.000000 304.000000 L 380.201010 284.201010 L 284.201010 380.201010 L 304.000000 372.000000 L 160.000000 372.000000 C 144.536027 372.000000 132.000000 384.536027 132.000000 400.000000 C 132.000000 415.463973 144.536027 428.000000 160.000000 428.000000 Z'
function BrandMark({ size = 20, id = 'mark' }) {
  const gradientId = `spend-sense-brand-${id}`
  return jsxs('svg', { viewBox: '0 0 512 512', width: size, height: size, 'aria-hidden': true, focusable: 'false',
    style: { flexShrink: 0 }, children: [
      jsx('defs', { children: jsxs('linearGradient', { id: gradientId, x1: 84, y1: 256, x2: 428, y2: 256,
        gradientUnits: 'userSpaceOnUse', children: [
          jsx('stop', { offset: '0%', stopColor: '#2563EB' }),
          jsx('stop', { offset: '100%', stopColor: '#813CF8' })
        ] }) }),
      jsx('path', { fill: `url(#${gradientId})`, d: BRAND_MARK_PATH })
    ] })
}

/** Right-hand pane: the focused session only. Range totals live on the ledger page. */
function Meter() {
  const t = usePluginI18n(ID)
  const live = useLive()
  const storageError = useValue($storageError)
  const backendRates = useValue($backendRates)
  const rateIdentity = useValue($membershipIdentity)
  useEffect(() => { ensureBackendRate(live.provider, live.model) }, [live.provider, live.model, rateIdentity])
  const sections = []

  if (live.bucket) {
    const u = live.usage
    const b = live.bucket
    const approx = b.cacheEstimated ? '≈' : ''
    const warn = live.costSource === 'foreign' || live.costSource === 'none'
    sections.push(
      jsxs(
        'div',
        {
          className: 'flex flex-col gap-2',
          children: [
            jsxs('div', {
              className: 'flex items-center justify-between gap-2',
              children: [
                jsx('div', { className: 'truncate text-sm font-medium', children: live.model || '—' }),
                jsxs('div', { className: 'flex items-center gap-1.5', children: [
                  jsx('span', { className: 'text-[0.5625rem] uppercase tracking-wide text-(--ui-text-quaternary)', children: live.fromHistory ? t('scopeConversation') : t('scopeRun') }),
                  jsx(Tip, {
                    label: live.provider ? t('providerTip', live.provider) : t('providerUnknownTip'),
                    children: jsx(Badge, { variant: 'muted', children: live.provider || t('providerUnknown') })
                  })
                ] })
              ]
            }),
            jsxs('div', {
              className: 'flex flex-wrap items-baseline gap-x-2',
              children: [
                jsx('div', {
                  className: 'text-2xl font-semibold tabular-nums text-(--ui-accent)',
                  children: live.cost == null ? '—' : fmtUsd(live.cost)
                }),
                jsx('span', {
                  className: cn('text-[0.625rem]', warn ? 'text-(--ui-warning)' : 'text-(--ui-text-quaternary)'),
                  children: sourceLabel(t, live.costSource, live.foreignSlug, live.providerUnknown)
                })
              ]
            }),
            jsx(Section, {
              title: scopeTotalsTitle(t, live.fromHistory),
              children: tokenRows(t, b, !!(u && typeof u.context_percent === 'number'), u).map(row =>
                jsx(Row, { dim: row.dim, label: row.label, value: row.value }, row.key)
              )
            }),
            live.sinceAt
              ? jsx(Note, { children: t(live.fromHistory ? 'historyNote' : 'cumulativeNote', fmtDate(live.sinceAt)) }, 'hist')
              : null,
            live.partial ? jsx(Note, { warn: true, children: t('unpricedNote', fmtTokens(b.unpricedTokens)) }, 'up') : null,
            num(b.input) + num(b.cacheRead) + num(b.cacheWrite) > 0
              ? jsx(Section, {
                  title: t('cacheTitle'),
                  children: [
                    jsx(Row, { label: t('hitRate'), value: live.cacheHitPct == null ? '—' : `${approx}${Math.round(live.cacheHitPct)}%` }, 'hr'),
                    live.cacheHitPct != null ? jsx('div', { className: 'py-1', children: jsx(CacheBar, { pct: live.cacheHitPct }) }, 'bar') : null,
                    jsx(Note, { children: cacheCoverageLine(t, live.cacheCoverage, b) }, 'coverage'),
                    live.saved != null ? jsx(Row, { label: t('savedTotal'), value: `${approx}${fmtUsd(live.saved)}` }, 'sv') : null,
                    b.cacheEstimated ? jsx(Note, { children: t('cacheEstNote') }, 'est') : null
                  ].filter(Boolean)
                })
              : null,
            live.rates
              ? jsxs('div', { className: 'flex flex-col gap-1', children: [
                  jsx(Section, {
                    title: t('rates'),
                    children: [
                      jsx(Row, { dim: true, label: t('input'), value: `$${live.rates.input}` }, 'ri'),
                      jsx(Row, { dim: true, label: t('output'), value: `$${live.rates.output}` }, 'ro'),
                      jsx(Row, { dim: true, label: t('cacheRead'), value: `$${live.rates.cache}` }, 'rc')
                    ]
                  }),
                  // The native pane prices with its own resolver, which may be on a
                  // peak card; this pane prices at the WolfMark catalogue card. Both
                  // are estimates, and neither is a provider invoice.
                  jsx(Note, { children: t('ratesNote') }, 'rn')
                ] })
              : jsx(Note, {
                  children: live.pricingLoading ? t('loadingPrice') : live.pricingError || t('noPriceLong')
                })
          ].filter(Boolean)
        },
        'live'
      )
    )
  } else {
    sections.push(jsx(Note, { children: t('empty') }, 'live'))
  }

  if (storageError) sections.push(jsx(Note, { warn: true, children: t('storageError', storageError) }, 'st'))

  return jsxs('div', { className: 'wm-meter flex h-full flex-col gap-3 overflow-auto p-3', children: [
    jsx('style', { children: '.wm-meter-brand{display:flex;align-items:center;gap:9px;border-bottom:1px solid var(--ui-stroke-secondary);padding:2px 0 10px}.wm-meter-mark{display:grid;place-items:center;width:24px;height:24px;flex-shrink:0}.wm-meter-name{font-size:12px;font-weight:620;letter-spacing:-.15px;color:var(--ui-text-primary)}.wm-meter-subtitle{font-size:10px;color:var(--ui-text-tertiary)}' }),
    jsxs('header', { className: 'wm-meter-brand', children: [
      jsx('span', { className: 'wm-meter-mark', children: jsx(BrandMark, { size: 20, id: 'pane' }) }),
      jsxs('div', { children: [jsx('div', { className: 'wm-meter-name', children: 'Spend Sense' }),
        jsx('div', { className: 'wm-meter-subtitle', children: 'Live usage · focused session' })] })
    ] }),
    jsx('div', { className: 'flex min-w-0 flex-col gap-3', children: sections })
  ] })
}

/* -------------------------------------------------------------- full page */

function rowBasis(t, r) {
  if (r.legacy) return t('basisLegacy')
  const kinds = Object.keys(r.sources).filter(k => num(r.sources[k]))
  if (!kinds.length) return t('src_none')
  if (kinds.length > 1) return t('basisMixed')
  return kinds[0] === 'foreign' ? t('src_foreign', r.foreignSlug || '?') : t(`src_${kinds[0]}`)
}

/* ---------------------------------------------------------- analytics math */

/** A true price gap stays null; a known free price stays zero. */
const finiteValue = v => typeof v === 'number' && Number.isFinite(v) ? v : null
const analyticsId = r => JSON.stringify([r.provider || '', r.model || ''])
function analyticsDistribution(rows, metric = 'cost', grouping = 'model', limit = 6) {
  const valueKey = metric === 'cost' ? 'list_usd' : 'tokens'
  const entries = rows.map(row => ({
    ...row, id: grouping === 'provider' ? row.provider : analyticsId(row),
    label: grouping === 'provider' ? row.provider || 'Unknown provider' : row.model || 'Unknown model',
    value: finiteValue(row[valueKey])
  })).filter(row => row.value != null && row.value > 0)
    .sort((a, b) => b.value - a.value || String(a.id).localeCompare(String(b.id)))
  const total = entries.reduce((sum, row) => sum + row.value, 0)
  const remainder = entries.slice(limit).map(row=>({...row,share:total ? row.value / total : 0}))
  const items = entries.slice(0, limit)
  if (remainder.length) items.push({id:'__other__',label:'Other',other:true,value:remainder.reduce((s,r)=>s+r.value,0)})
  return {total, remainder, items: items.map(r => ({...r,share:total ? r.value / total : 0})),
    unpricedTokens: rows.reduce((s,r)=>s+num(r.unpriced_tokens),0)}
}

const TOKEN_STREAMS = [
  ['input_tokens','Input','var(--ui-accent)'],
  ['output_tokens','Output','var(--ui-success)'],
  ['cache_read_tokens','Cache read','var(--ui-warning)'],
  ['cache_write_tokens','Cache write','color-mix(in srgb, var(--ui-accent) 45%, var(--ui-text-primary))']
]
function analyticsComposition(totals = {}) {
  const total = TOKEN_STREAMS.reduce((s,[key])=>s+num(totals[key]),0)
  return TOKEN_STREAMS.map(([key,label,color])=>({id:key,label,color,value:num(totals[key]),share:total?num(totals[key])/total:0}))
}
/** Never infer category-dollar costs from token proportions or current prices. */
function analyticsTrend(buckets, metric = 'tokens') {
  const valid = buckets.filter(b=>Number.isFinite(Date.parse(b.ts))).slice().sort((a,b)=>Date.parse(a.ts)-Date.parse(b.ts))
  const start = valid.length ? Date.parse(valid[0].ts) : 0
  const end = valid.length ? Date.parse(valid.at(-1).ts) : start
  const points = valid.map(row=>{
    const values = metric === 'tokens' ? TOKEN_STREAMS.map(([key])=>num(row[key]))
      : ['input_usd','output_usd','cache_read_usd','cache_write_usd'].every(key=>finiteValue(row[key])!=null)
        ? ['input_usd','output_usd','cache_read_usd','cache_write_usd'].map(key=>row[key]) : null
    return {row,ts:row.ts,x:end===start?.5:(Date.parse(row.ts)-start)/(end-start),values,
      total:metric==='tokens'?values.reduce((a,b)=>a+b,0):finiteValue(row.list_usd)}
  })
  return {points,max:Math.max(0,...points.map(p=>p.total || 0)),stacked:metric==='tokens'||points.every(p=>p.values!=null)}
}

function analyticsPricing(row) {
  if (!num(row.tokens)) return 'No usage'
  if (finiteValue(row.list_usd) == null || !num(row.priced_tokens)) return 'Unpriced'
  const fallback = num(row.fallback_calls)
  if (num(row.unpriced_tokens)) return `Partial · ${((num(row.priced_tokens) / num(row.tokens)) * 100).toFixed(1)}%${fallback ? ' · fallback rates' : ''}`
  if (fallback) return `Fallback rates · ${fallback} calls`
  return 'Complete'
}
function analyticsSort(rows, key, direction = 'desc') {
  const value = row => key === 'savings' ? finiteValue(row.economics?.savings_usd)
    : key === 'pricing' ? (num(row.tokens) ? num(row.priced_tokens) / num(row.tokens) : null)
    : key === 'billing' ? Object.keys(row.billing_mix || {}).filter(k=>row.billing_mix[k]>0).sort().join(' + ') || 'unknown'
    : ['model','provider'].includes(key) ? String(row[key] || '') : finiteValue(row[key])
  return rows.slice().sort((a,b)=>{
    const av = value(a), bv = value(b)
    if (av == null || bv == null) return av == null && bv == null ? analyticsId(a).localeCompare(analyticsId(b)) : av == null ? 1 : -1
    const result = typeof av === 'string' ? av.localeCompare(bv) : av - bv
    return (direction === 'asc' ? result : -result) || analyticsId(a).localeCompare(analyticsId(b))
  })
}

/** Three plain conclusions from data already on the page; no new claims. */
function analyticsInsights(data) {
  const totals = data?.totals || {}
  const insights = []
  const priced = (data?.by_model || []).filter(r => finiteValue(r.list_usd) != null && num(r.list_usd) > 0)
    .sort((a, b) => num(b.list_usd) - num(a.list_usd))
  if (priced.length && num(totals.list_usd)) {
    const top = priced[0]
    insights.push({label: 'Biggest driver', text: `${top.model || 'Unknown model'} via ${top.provider || 'unknown'} is ${percent(num(top.list_usd) / num(totals.list_usd))} of priced API-equivalent cost.`})
  }
  const e = data?.economics || totals.economics || {}
  if (finiteValue(e.savings_usd) != null) insights.push({label: 'Cache verdict', text: e.savings_usd < 0
    ? `Cache writes cost ${analyticMoney(-e.savings_usd)} more than reads save on covered calls. See Cache economics.`
    : `Caching saves a theoretical ${analyticMoney(e.savings_usd)} on covered calls (${percent(e.coverage)} covered).`})
  const scopes = Object.fromEntries((data?.by_scope || []).map(r => [r.scope, r]))
  const sub = scopes.subagent
  if (sub && num(totals.tokens)) insights.push({label: 'Delegated work', text: `Subagents used ${percent(num(sub.tokens) / num(totals.tokens))} of tokens across ${exactTokens(sub.calls)} calls.`})
  return insights
}
function deltaText(value) {
  if (finiteValue(value) == null) return null
  return `${value >= 0 ? '▲' : '▼'} ${Math.abs(value * 100).toFixed(1)}% vs previous period`
}

/* -------------------------------------------------------- analytics state */

function analyticsInitialState() {
  return {filters:{model:'',provider:'',surface:'',task:'',parent:'',scope:''},days:7,distributionMetric:'cost',grouping:'model',
    trendMetric:'tokens',compositionMode:'stacked',ranking:'cache_hit_rate',sortKey:'list_usd',sortDirection:'desc',
    otherOpen:false,trendIndex:null,compositionFocus:null,baselineOpen:false,showAllModels:false,columnMode:'core'}
}
function analyticsReduce(state, action) {
  if (action.type === 'toggle' && ['otherOpen','showAllModels'].includes(action.key)) return {...state,[action.key]:!state[action.key]}
  if (action.type === 'trend-step') return {...state,trendIndex:Math.max(0,Math.min(action.total-1,(state.trendIndex ?? action.index)+action.direction))}
  if (action.type === 'clear') return {...state,filters:analyticsInitialState().filters,otherOpen:false,trendIndex:null}
  if (action.type === 'filter' && ['model','provider','surface','task','parent','scope'].includes(action.key))
    return {...state,filters:{...state.filters,[action.key]:String(action.value || '')},otherOpen:false,trendIndex:null}
  if (action.type === 'select' && !action.row.other) {
    const filters = {...state.filters,provider:action.row.provider || ''}
    if (action.group === 'model') filters.model = action.row.model || ''
    else filters.model = ''
    return {...state,filters,otherOpen:false,trendIndex:null}
  }
  if (action.type === 'sort') return {...state,sortKey:action.key,
    sortDirection:state.sortKey===action.key && state.sortDirection==='desc'?'asc':'desc'}
  if (action.type === 'set' && Object.hasOwn(state, action.key) && action.key !== 'filters') return {...state,[action.key]:action.value}
  return state
}
const $analytics = atom({})
/** Scope uses synchronous active-route state only; profileRoutes is async inventory I/O. */
function analyticsScope(profile, gateway, connectionId = host.state.connectionId?.get()) {
  const epoch = typeof gatewayActivationEpoch === 'function' ? gatewayActivationEpoch() : 0
  return JSON.stringify([profile || '',gateway || '',connectionId || '',epoch])
}
function analyticsDispatch(scope, action) {
  const all = $analytics.get()
  $analytics.set({...all,[scope]:analyticsReduce(all[scope] || analyticsInitialState(),action)})
}
function analyticsQuery(days, filters, scope) {
  const parameters = new URLSearchParams({days:String(days)})
  for (const key of ['model','provider','surface','task','parent','scope']) if (filters[key]) parameters.set(key,filters[key])
  return {queryKey:[ID,'analytics',scope,days,...['model','provider','surface','task','parent','scope'].map(k=>filters[k] || '')],
    queryFn:async()=>{
      if (typeof rest !== 'function') throw new Error('This desktop build has no plugin backend bridge (ctx.rest).')
      const currentScope = () => analyticsScope(host.state.profile?.get(), host.state.gateway?.get(), host.state.connectionId?.get())
      if (currentScope() !== scope) throw new Error('Analytics connection changed.')
      const result = await rest(`/analytics?${parameters}`)
      if (currentScope() !== scope) throw new Error('Analytics connection changed.')
      if (!result || result.ok === false) throw new Error(result?.error || 'Analytics response is unavailable.')
      return result
    },retry:false,staleTime:30_000,refetchInterval:60_000}
}

/* ---------------------------------------------------------- analytics UI */

const ANALYTICS_CSS = `
.wm-analytics{height:100%;overflow:auto;container-type:inline-size;color:var(--ui-text-primary);font-size:12px;line-height:1.5}
.wm-analytics *{box-sizing:border-box}.wm-analytics .wm-shell{max-width:1560px;padding:28px 32px 40px;margin:auto;display:grid;gap:22px;min-width:0}
.wm-analytics h1,.wm-analytics h2,.wm-analytics p{margin:0}.wm-analytics h1{font-size:27px;line-height:1.2;font-weight:650;letter-spacing:-1px}.wm-analytics h2{font-size:13px;font-weight:600;letter-spacing:-.15px}
.wm-analytics .wm-eyebrow{font-size:10px;text-transform:uppercase;letter-spacing:1.6px;color:var(--ui-text-tertiary);margin-bottom:7px}
.wm-analytics .wm-subtle{color:var(--ui-text-secondary);font-size:11.5px}.wm-analytics .wm-dim{color:var(--ui-text-quaternary)}
.wm-analytics .wm-mono{font-family:var(--font-mono,ui-monospace,monospace);font-variant-numeric:tabular-nums;letter-spacing:-.3px}
.wm-analytics .wm-topline,.wm-analytics .wm-panelhead{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.wm-analytics .wm-topactions,.wm-analytics .wm-controls{display:flex;align-items:center;gap:7px;flex-wrap:wrap}.wm-analytics .wm-panelhead{margin-bottom:18px;align-items:flex-start}
.wm-analytics button,.wm-analytics select{font:inherit;color:inherit}.wm-analytics button{cursor:pointer}.wm-analytics button:disabled{cursor:wait;opacity:.5}
.wm-analytics .wm-button{display:inline-flex;align-items:center;justify-content:center;gap:7px;border:1px solid var(--ui-stroke-secondary);border-radius:6px;background:transparent;padding:6px 10px;font-size:11px;min-height:30px}
.wm-analytics button[data-active=true]{border-color:var(--ui-accent);color:var(--ui-accent);background:color-mix(in srgb,var(--ui-accent) 8%,transparent)}.wm-analytics button:hover{background:var(--ui-fill-secondary)}.wm-analytics button:focus-visible,.wm-analytics select:focus-visible,.wm-analytics summary:focus-visible,.wm-analytics [tabindex]:focus-visible{outline:2px solid var(--ui-accent);outline-offset:3px}
.wm-analytics .wm-segments{display:inline-flex;padding:2px;border:1px solid var(--ui-stroke-secondary);border-radius:6px;gap:2px;flex-shrink:0}
.wm-analytics .wm-segments button{border:0;border-radius:4px;background:transparent;padding:3px 8px;font-size:10px;color:var(--ui-text-tertiary);min-height:24px}
.wm-analytics .wm-segments button[aria-pressed=true]{color:var(--ui-text-primary);background:var(--ui-fill-secondary);box-shadow:0 1px 0 var(--ui-stroke-secondary)}
.wm-analytics .wm-filters{display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;border-bottom:1px solid var(--ui-stroke-secondary);padding-bottom:18px}
.wm-analytics .wm-filter{display:flex;flex-direction:column;gap:5px;min-width:115px;flex:1;max-width:250px}.wm-analytics .wm-filter span{font-size:10px;color:var(--ui-text-tertiary)}
.wm-analytics select{width:100%;max-width:100%;min-height:33px;border:1px solid var(--ui-stroke-secondary);background:var(--ui-fill-primary);padding:6px 25px 6px 9px;border-radius:6px;font-size:11px}
.wm-analytics option{background:var(--ui-fill-primary);color:var(--ui-text-primary)}
.wm-analytics .wm-scopechips{display:flex;gap:6px;flex-wrap:wrap;margin-top:-9px}.wm-analytics .wm-scopechips button{border:1px solid color-mix(in srgb,var(--ui-accent) 35%,var(--ui-stroke-secondary));background:color-mix(in srgb,var(--ui-accent) 7%,transparent);color:var(--ui-accent);border-radius:4px;padding:3px 7px;font-size:10px;max-width:100%;overflow-wrap:anywhere}
.wm-analytics .wm-stats{display:grid;grid-template-columns:1.3fr 1fr 1fr 1fr 1fr;gap:0;border:1px solid var(--ui-stroke-secondary);border-radius:9px;overflow:hidden}
.wm-analytics .wm-insights{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:10px}.wm-analytics .wm-insight{border:1px solid var(--ui-stroke-secondary);border-radius:8px;padding:12px 14px;display:grid;gap:5px}.wm-analytics .wm-insight b{font-size:11px}.wm-analytics .wm-insight span{font-size:11.5px;color:var(--ui-text-secondary);line-height:1.5}
.wm-analytics .wm-stat{padding:19px 21px;min-width:0;border-right:1px solid var(--ui-stroke-secondary)}.wm-analytics .wm-stat:last-child{border:0}.wm-analytics .wm-statlabel{font-size:11px;color:var(--ui-text-tertiary);margin-bottom:10px}.wm-analytics .wm-statvalue{font-size:29px;line-height:1.2;font-weight:550;letter-spacing:-1.2px;overflow-wrap:anywhere;margin-bottom:10px}.wm-analytics .wm-statvalue small{font-size:11px;letter-spacing:0;margin-left:6px;font-weight:400}
.wm-analytics .wm-badge{display:inline-block;font-size:10px;line-height:1.4;letter-spacing:.15px;border:1px solid var(--ui-stroke-secondary);border-radius:4px;padding:2px 5px;vertical-align:middle;color:var(--ui-text-secondary)}
.wm-analytics .wm-warn{color:var(--ui-warning)}.wm-analytics .wm-good{color:var(--ui-success)}.wm-analytics .wm-accent{color:var(--ui-accent)}
.wm-analytics .wm-charts{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.35fr);gap:16px}.wm-analytics .wm-charts > section:nth-child(5){grid-column:1/-1}.wm-analytics .wm-panel{border:1px solid var(--ui-stroke-secondary);border-radius:9px;padding:20px;min-width:0;background:color-mix(in srgb,var(--ui-fill-secondary) 15%,transparent)}
.wm-analytics .wm-paneltitle{display:flex;align-items:center;gap:7px;margin-bottom:4px}.wm-analytics .wm-number{font-family:var(--font-mono,ui-monospace,monospace);font-size:10px;color:var(--ui-text-quaternary)}
.wm-analytics .wm-donutbody{display:grid;grid-template-columns:minmax(135px,.9fr) minmax(0,1.1fr);align-items:center;gap:16px;min-height:230px}
.wm-analytics svg{display:block;max-width:100%;overflow:visible}.wm-analytics .wm-donut{width:100%;max-width:220px;margin:auto}.wm-analytics .wm-ring{transform:rotate(-90deg);transform-origin:center}
.wm-analytics .wm-svgtext{fill:var(--ui-text-primary);font-family:var(--font-mono,ui-monospace,monospace);font-size:19px;font-weight:500}.wm-analytics .wm-svghint{fill:var(--ui-text-tertiary);font-size:9px}
.wm-analytics .wm-legend{display:grid;gap:4px;min-width:0}.wm-analytics .wm-legendrow{display:grid;grid-template-columns:7px minmax(0,1.2fr) minmax(60px,1fr) auto;gap:8px;text-align:left;align-items:center;padding:7px 4px;border:0;background:transparent;border-radius:4px;font-size:11px;width:100%;min-width:0}.wm-analytics .wm-bartrack{height:8px;background:var(--ui-stroke-secondary);border-radius:99px;overflow:hidden}.wm-analytics .wm-barfill{display:block;height:100%;border-radius:99px}
.wm-analytics .wm-dot{width:6px;height:6px;border-radius:2px;display:inline-block;flex-shrink:0}.wm-analytics .wm-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block;min-width:0}.wm-analytics .wm-legendrow small{font-size:9px;color:var(--ui-text-quaternary);display:block}.wm-analytics .wm-legendrow .wm-value{text-align:right;font-size:11px;white-space:nowrap}
.wm-analytics .wm-footnote{border-top:1px solid var(--ui-stroke-secondary);padding-top:12px;margin-top:15px;font-size:11px;color:var(--ui-text-tertiary);line-height:1.6}.wm-analytics .wm-remainder{padding:12px;background:var(--ui-fill-secondary);border-radius:6px;margin-top:12px;max-height:240px;overflow:auto}
.wm-analytics .wm-trend{width:100%;height:auto;min-height:180px;margin-top:10px}.wm-analytics .wm-gridline{stroke:var(--ui-stroke-secondary);stroke-width:1;stroke-dasharray:3 5}.wm-analytics .wm-axis{fill:var(--ui-text-tertiary);font-family:var(--font-mono,ui-monospace,monospace);font-size:10px}
.wm-analytics .wm-chartkey{display:flex;gap:13px;flex-wrap:wrap;font-size:11px;color:var(--ui-text-tertiary);margin-top:10px}.wm-analytics .wm-chartkey span{display:inline-flex;align-items:center;gap:5px}.wm-analytics .wm-chartdetail{display:flex;justify-content:space-between;gap:9px;flex-wrap:wrap;min-height:32px;padding-top:10px;font-size:11px;color:var(--ui-text-tertiary)}
.wm-analytics .wm-rank{width:100%;min-height:200px}.wm-analytics .wm-composition{min-height:225px;display:grid;align-content:center;gap:20px}.wm-analytics .wm-compositiontotal{font-size:27px;font-weight:500;letter-spacing:-1px}.wm-analytics .wm-compositionkey{display:grid;grid-template-columns:1fr 1fr;gap:4px 16px}
.wm-analytics .wm-tablewrap{overflow:auto;margin:0 -20px}.wm-analytics table{width:100%;border-collapse:collapse;white-space:nowrap;text-align:right;font-size:11px}.wm-analytics caption{text-align:left;position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}
.wm-analytics th{font-size:10px;color:var(--ui-text-tertiary);font-weight:450;border-bottom:1px solid var(--ui-stroke-secondary);position:sticky;top:0;background:var(--ui-fill-primary);z-index:1}.wm-analytics th button{font:inherit;color:inherit;border:0;background:transparent;padding:10px 10px;text-align:right;width:100%;white-space:nowrap}.wm-analytics td{padding:11px 10px;border-bottom:1px solid var(--ui-stroke-secondary);font-variant-numeric:tabular-nums}.wm-analytics td:first-child,.wm-analytics th:first-child{padding-left:20px;text-align:left}.wm-analytics td:last-child,.wm-analytics th:last-child{padding-right:20px}.wm-analytics tr:last-child td{border-bottom:0}.wm-analytics tbody tr:hover{background:var(--ui-fill-secondary)}
.wm-analytics .wm-modelbutton{border:0;background:transparent;color:var(--ui-text-primary);text-align:left;padding:0;font-weight:500;max-width:260px;display:block;overflow:hidden;text-overflow:ellipsis}.wm-analytics .wm-meter{width:64px;height:3px;background:var(--ui-fill-tertiary);border-radius:2px;overflow:hidden;margin:5px 0 0 auto}.wm-analytics .wm-meter span{display:block;height:100%;background:var(--ui-accent)}
.wm-analytics .wm-economics{display:grid;grid-template-columns:1fr 1fr;gap:28px}.wm-analytics .wm-comparison{display:grid;gap:15px;margin-top:20px}.wm-analytics .wm-comparerow{display:grid;gap:7px}.wm-analytics .wm-comparelabel{display:flex;justify-content:space-between;font-size:11px}.wm-analytics .wm-comparetrack{height:9px;background:var(--ui-fill-tertiary);border-radius:3px;overflow:hidden}.wm-analytics .wm-comparetrack span{display:block;height:100%;border-radius:3px}
.wm-analytics .wm-explanation{border-left:1px solid var(--ui-stroke-secondary);padding-left:26px;color:var(--ui-text-tertiary);font-size:11px}.wm-analytics .wm-explanation p+p{margin-top:9px}.wm-analytics details summary{cursor:pointer;font-size:11px;color:var(--ui-text-tertiary)}.wm-analytics .wm-bars{display:grid;gap:10px;margin-top:14px}.wm-analytics .wm-bar{display:grid;grid-template-columns:150px minmax(0,1fr) 90px;gap:10px;align-items:center;font-size:11px}.wm-analytics .wm-bartrack{height:10px;border-radius:5px;background:var(--ui-fill-secondary);overflow:hidden}.wm-analytics .wm-barfill{height:100%;border-radius:5px;background:var(--ui-accent)}.wm-analytics .wm-barfill.wm-cash{background:var(--ui-warning)}.wm-analytics .wm-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:10px}.wm-analytics .wm-card{border:1px solid var(--ui-stroke-secondary);border-radius:8px;padding:12px;display:grid;gap:6px;min-width:0}.wm-analytics .wm-card b{font-weight:600}.wm-analytics .wm-baseline{border-top:1px solid var(--ui-stroke-secondary);padding-top:15px}.wm-analytics .wm-empty{padding:36px 20px;border:1px dashed var(--ui-stroke-secondary);border-radius:8px;text-align:center;display:grid;justify-items:center;gap:10px;color:var(--ui-text-tertiary)}.wm-analytics .wm-alert{border:1px solid color-mix(in srgb,var(--ui-warning) 50%,var(--ui-stroke-secondary));padding:14px;border-radius:6px;color:var(--ui-warning)}
@container(max-width:1050px){.wm-analytics .wm-shell{padding:22px}.wm-analytics .wm-charts{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}.wm-analytics .wm-donutbody{grid-template-columns:1fr;gap:10px}.wm-analytics .wm-donut{max-width:165px}.wm-analytics .wm-stats{grid-template-columns:1fr 1fr}.wm-analytics .wm-stat:nth-child(2){border-right:0}.wm-analytics .wm-stat:nth-child(-n+2){border-bottom:1px solid var(--ui-stroke-secondary)}}
@container(max-width:720px){.wm-analytics .wm-shell{padding:18px 14px;gap:17px}.wm-analytics .wm-charts{grid-template-columns:minmax(0,1fr)}.wm-analytics h1{font-size:24px}.wm-analytics .wm-economics{grid-template-columns:minmax(0,1fr);gap:18px}.wm-analytics .wm-explanation{border-left:0;border-top:1px solid var(--ui-stroke-secondary);padding:16px 0 0}.wm-analytics .wm-panel{padding:16px}.wm-analytics .wm-tablewrap{margin:0 -16px}.wm-analytics .wm-donutbody{grid-template-columns:minmax(120px,.85fr) minmax(0,1.15fr)}.wm-analytics .wm-stat{padding:16px}.wm-analytics .wm-statvalue{font-size:25px}.wm-analytics .wm-filter{max-width:none;min-width:125px}}
@container(max-width:380px){.wm-analytics .wm-donutbody{grid-template-columns:1fr}.wm-analytics .wm-stats{grid-template-columns:1fr}.wm-analytics .wm-stat{border-right:0;border-bottom:1px solid var(--ui-stroke-secondary)}.wm-analytics .wm-compositionkey{grid-template-columns:1fr}}
@media(prefers-reduced-motion:reduce){.wm-analytics *{animation:none!important;transition:none!important;scroll-behavior:auto!important}}
`
const CHART_COLORS = ['var(--ui-accent)','var(--ui-success)','var(--ui-warning)',
  'color-mix(in srgb, var(--ui-accent) 40%, var(--ui-text-primary))',
  'color-mix(in srgb, var(--ui-success) 40%, var(--ui-text-primary))',
  'color-mix(in srgb, var(--ui-warning) 45%, var(--ui-text-primary))','var(--ui-text-quaternary)']
const percent = v => finiteValue(v)==null ? '—' : `${(v*100).toFixed(1)}%`
const exactTokens = value => finiteValue(value)==null ? '—' : value.toLocaleString('en-US')
function analyticMoney(value) { return finiteValue(value)==null ? '—' : value<0 ? `−${fmtUsd(-value)}` : fmtUsd(value) }
function keyActivate(event, fn) { if (event.key === 'Enter' || event.key === ' ') {event.preventDefault();fn()} }
function ProductButton({children, variant = 'outline', size = 'sm', ...props}) {
  return jsx(Button, { ...props, size, variant, children })
}
function keyedElementChildren(children, prefix) {
  return children.map((child, index) => {
    if (!child || typeof child !== 'object' || !child.type || child.key != null) return child
    return jsx(child.type, { ...child.props }, `${prefix}-${index}`)
  })
}
function AnalyticsButton({label,children,onClick,disabled}) {
  return jsx(ProductButton,{type:'button',className:'wm-button','aria-label':label,onClick,disabled,children:children || label})
}
function AnalyticsSegments({label,value,options,onChange}) {
  return jsx('div',{className:'wm-segments',role:'group','aria-label':label,children:options.map(([id,text,aria])=>
    jsx('button',{type:'button','aria-label':aria || `${label} ${id}`,'aria-pressed':value===id,onClick:()=>onChange(id),children:text},id))})
}
function AnalyticsPanel({number,title,subtitle,controls,children,footer}) {
  return jsxs('section',{className:'wm-panel','aria-label':title,children:[
    jsxs('div',{className:'wm-panelhead',children:[jsxs('div',{children:[jsxs('div',{className:'wm-paneltitle',children:[jsx('span',{className:'wm-number',children:number}),jsx('h2',{children:title})]}),jsx('p',{className:'wm-subtle',children:subtitle})]}),controls]}),
    children,footer?jsx('div',{className:'wm-footnote',children:footer}):null]})
}
function AnalyticsStat({label,value,hint,extra,tone}) {
  return jsxs('div',{className:'wm-stat',children:[jsx('div',{className:'wm-statlabel',children:label}),jsx('div',{className:cn('wm-statvalue wm-mono',tone),children:value}),jsx('div',{className:'wm-subtle',children:hint}),extra?jsx('div',{className:'wm-subtle',style:{marginTop:5},children:extra}):null]})
}
function AnalyticsDonut({items,total,label,format,onSelect,chart='distribution'}) {
  const radius=72,circumference=2*Math.PI*radius
  let offset=0
  return jsxs('svg',{className:'wm-donut',viewBox:'0 0 200 200','data-chart':chart,role:'img','aria-label':`${label}: ${format(total)}`,children:[
    jsx('title',{children:`${label}. ${items.map(r=>`${r.label}: ${format(r.value)} (${percent(r.share)})`).join('; ')}`}),
    jsx('circle',{cx:100,cy:100,r:radius,fill:'none',stroke:'var(--ui-fill-tertiary)',strokeWidth:22}),
    ...items.map((item,i)=>{
      const start=offset;offset+=item.share*circumference
      const select=()=>onSelect(item)
      return jsx('circle',{className:'wm-ring',cx:100,cy:100,r:radius,fill:'none',stroke:item.color || CHART_COLORS[i%CHART_COLORS.length],strokeWidth:22,
        strokeDasharray:`${item.share*circumference} ${circumference}`,strokeDashoffset:-start,
        role:'button',tabIndex:0,'aria-label':`${item.other?'Inspect':'Select'} ${item.label}: ${format(item.value)}, ${percent(item.share)}`,
        onClick:select,onKeyDown:event=>keyActivate(event,select),style:{cursor:'pointer'},children:jsx('title',{children:`${item.label} · ${format(item.value)} · ${percent(item.share)}`})},item.id)
    }),jsx('text',{x:100,y:97,textAnchor:'middle',className:'wm-svgtext',children:format(total)}),jsx('text',{x:100,y:116,textAnchor:'middle',className:'wm-svghint',children:label})]})
}
function AnalyticsDistribution({data,state,dispatch}) {
  const grouped=state.grouping==='provider'
  const dist=analyticsDistribution((grouped?data.by_route:data.by_model) || [],state.distributionMetric,state.grouping)
  const format=state.distributionMetric==='cost'?analyticMoney:fmtTokens
  const select=row=>row.other ? dispatch({type:'toggle',key:'otherOpen'}) : dispatch({type:'select',group:state.grouping,row})
  const legend=(row,i)=>jsxs('button',{type:'button',className:'wm-legendrow',
    'aria-label':row.other?`Inspect Other ${grouped?'providers':'models'}`:`Filter ${grouped?row.provider:row.model} via ${row.provider}`,
    'aria-expanded':row.other?state.otherOpen:undefined,onClick:()=>select(row),title:row.other?'Inspect the exact remainder without changing filters':`Apply exact ${state.grouping} filter`,children:[
      jsx('span',{className:'wm-dot',style:{background:CHART_COLORS[i%CHART_COLORS.length]}}),
      jsxs('span',{className:'wm-label',children:[row.label,!grouped&&!row.other?jsx('small',{children:row.provider || 'Unknown provider'}):null]}),
      jsx('span',{className:'wm-bartrack','aria-hidden':'true',children:jsx('span',{className:'wm-barfill',style:{width:`${Math.max(0,Math.min(100,row.share*100))}%`,background:CHART_COLORS[i%CHART_COLORS.length]}})}),
      jsxs('span',{className:'wm-value wm-mono',children:[format(row.value),jsx('small',{children:percent(row.share)})]})]},row.id)
  return jsx(AnalyticsPanel,{number:'01',title:'Usage distribution',subtitle:'Where your usage goes',controls:jsxs('div',{className:'wm-controls',children:[
    jsx(AnalyticsSegments,{label:'Distribution',value:state.distributionMetric,options:[['cost','Cost'],['tokens','Tokens']],onChange:value=>dispatch({type:'set',key:'distributionMetric',value})}),
    jsx(AnalyticsSegments,{label:'Distribution by',value:state.grouping,options:[['model','Model'],['provider','Provider']],onChange:value=>dispatch({type:'set',key:'grouping',value})})]}),
    children:jsxs('div',{children:[jsx('div',{className:'wm-legend',children:dist.items.length?dist.items.map(legend):jsx('p',{className:'wm-subtle',children:state.distributionMetric==='cost'?'No priced cost to distribute. Known free usage has zero cost; unpriced usage is not zero.':'No tokens to distribute.'})}),
      state.otherOpen?jsxs('div',{className:'wm-remainder',children:[jsx('h2',{children:`Remainder · ${dist.remainder.length} ${grouped?'providers':'models'}`}),...dist.remainder.map((r,i)=>legend(r,i+6))]}):null]}),
    footer:jsxs('span',{children:[state.distributionMetric==='cost'?'Shares of the PRICED subtotal only. ':'Shares of all recorded tokens. ',num(dist.unpricedTokens)?jsx('span',{className:'wm-warn',children:`${fmtTokens(dist.unpricedTokens)} unpriced tokens are excluded from cost shares. `}):null,'Top 6 + Other conserves the total. Click a legend to filter; Other only inspects.']})})
}
function AnalyticsTrendChart({data,state,dispatch}) {
  const metric=state.trendMetric
  const trend=analyticsTrend(data.trend?.buckets || [],metric)
  const format=metric==='cost'?analyticMoney:fmtTokens
  const width=600,height=240,left=48,right=580,top=17,bottom=195
  const x=point=>left+point.x*(right-left),y=value=>bottom-(value/(trend.max || 1))*(bottom-top)
  const select=index=>dispatch({type:'set',key:'trendIndex',value:index})
  const active=state.trendIndex==null?null:trend.points[state.trendIndex]
  const layers=[]
  if(trend.stacked && trend.points.length>1) for(let i=0;i<4;i++) {
    const lower=p=>p.values.slice(0,i).reduce((a,b)=>a+b,0)
    const upper=p=>lower(p)+p.values[i]
    const d=`M ${trend.points.map(p=>`${x(p)},${y(upper(p))}`).join(' L ')} L ${trend.points.slice().reverse().map(p=>`${x(p)},${y(lower(p))}`).join(' L ')} Z`
    layers.push(jsx('path',{d,fill:TOKEN_STREAMS[i][2],fillOpacity:.68,stroke:TOKEN_STREAMS[i][2],strokeWidth:.8},`layer${i}`))
  }
  const markers=trend.points.map((p,index)=>jsxs('g',{'data-trend-point':index,role:'button',tabIndex:0,'aria-label':`${p.ts}: ${format(p.total)}${num(p.row.unpriced_tokens)?' partial priced subtotal':''}`,
    onClick:()=>select(index),onFocus:()=>select(index),onMouseEnter:()=>select(index),onKeyDown:event=>{
      if(event.key==='ArrowRight'||event.key==='ArrowLeft'){event.preventDefault();dispatch({type:'trend-step',index,total:trend.points.length,direction:event.key==='ArrowRight'?1:-1})}
      else keyActivate(event,()=>select(index))
    },style:{cursor:'crosshair'},children:[
      jsx('title',{children:`${p.ts} · ${format(p.total)} · ${exactTokens(p.row.calls)} calls`}),
      trend.stacked&&trend.points.length===1?TOKEN_STREAMS.map(([, ,color],i)=>jsx('rect',{x:x(p)-15,width:30,y:y(p.values.slice(0,i+1).reduce((a,b)=>a+b,0)),height:(p.values[i]/(trend.max||1))*(bottom-top),fill:color},i)):null,
      jsx('line',{x1:x(p),x2:x(p),y1:top,y2:bottom,stroke:'var(--ui-accent)',strokeOpacity:active===p?.45:0}),
      jsx('rect',{x:x(p)-Math.min(18,(right-left)/Math.max(1,trend.points.length)/2),y:top,width:Math.min(36,(right-left)/Math.max(1,trend.points.length)),height:bottom-top,fill:'transparent'}),
      p.total!=null?jsx('circle',{cx:x(p),cy:y(p.total),r:active===p?4:2.5,fill:'var(--ui-accent)',stroke:'var(--ui-fill-primary)',strokeWidth:1.5}):null]},p.ts))
  // The API may omit category-dollar streams. Draw only real total-dollar segments, never guessed stacks.
  const costLines=[]
  if(!trend.stacked) {
    let run=[]
    const flush=()=>{if(run.length>1)costLines.push(jsx('polyline',{points:run.map(p=>`${x(p)},${y(p.total)}`).join(' '),fill:'none',stroke:'var(--ui-accent)',strokeWidth:2},`run${costLines.length}`));run=[]}
    for(const p of trend.points){if(p.total==null)flush();else run.push(p)}flush()
  }
  const axisLabel=row=>data.trend?.granularity==='hour' ? `${String(row.ts_local || row.ts).slice(11,16)} ${row.ts_local ? String(row.ts_local).slice(-6) : 'UTC'}` : String(row.ts_local || row.ts).slice(5,10)
  return jsx(AnalyticsPanel,{number:'02',title:'Usage over time',subtitle:`Timestamped calls · ${data.trend?.granularity || 'day'} buckets · ${data.window?.timezone || 'UTC'}`,controls:jsx(AnalyticsSegments,{label:'Trend',value:metric,options:[['tokens','Tokens'],['cost','Cost']],onChange:value=>dispatch({type:'set',key:'trendMetric',value})}),children:jsxs('div',{children:[
    jsxs('svg',{className:'wm-trend',viewBox:`0 0 ${width} ${height}`,'data-chart':'trend',role:'img','aria-label':`${metric} over true timestamps`,children:[
      jsx('title',{children:'True elapsed-time positions. Focus or hover a timestamp for exact values.'}),
      ...[0,.25,.5,.75,1].flatMap(r=>[jsx('line',{className:'wm-gridline',x1:left,x2:right,y1:y(r*trend.max),y2:y(r*trend.max)},`grid${r}`),jsx('text',{className:'wm-axis',x:left-9,y:y(r*trend.max)+3,textAnchor:'end',children:format(r*trend.max)},`axis${r}`)]),
      ...layers,...costLines,...markers,
      ...trend.points.filter((_,i)=>i===0||i===trend.points.length-1||i===Math.floor(trend.points.length/2)).map(p=>jsx('text',{x:x(p),y:bottom+24,textAnchor:'middle',className:'wm-axis',children:axisLabel(p.row)},`date${p.ts}`))]}),
    jsx('div',{className:'wm-chartkey',children:trend.stacked?TOKEN_STREAMS.map(([key,label,color])=>jsxs('span',{children:[jsx('i',{className:'wm-dot',style:{background:color}}),label]},key)):jsx('span',{children:'Priced API-equivalent subtotal · category-dollar streams unavailable'})}),
    jsx('div',{className:'wm-chartdetail','aria-live':'polite',children:active?[
      jsx('span',{className:'wm-mono',children:(active.row.ts_local || active.ts).replace('T',' ').replace('Z',' UTC')},'ts'),
      jsx('strong',{className:'wm-mono',children:`${format(active.total)}${num(active.row.unpriced_tokens)?' · partial':''}`},'total'),
      ...TOKEN_STREAMS.map(([key,label])=>jsx('span',{children:`${label} ${exactTokens(active.row[key])}`},key))
    ]:'Hover or keyboard-focus a point to inspect exact usage. ← → selects adjacent timestamps.'})]}),
    footer:metric==='cost'?'API-equivalent cost, not recorded billing. Unknown prices leave gaps; unpriced tokens are never counted as $0.':'Stacked fresh input + output + cache read + cache write. X positions reflect real elapsed time, not array indices.'})
}
function AnalyticsDelegation({data,state,dispatch}) {
  const scopes=Object.fromEntries((data.by_scope || []).map(row=>[row.scope,row]))
  const direct=scopes.direct || null, sub=scopes.subagent || null, aux=scopes.auxiliary || null, un=scopes.unattributed || null
  const attribution=data.attribution || {}
  const max=Math.max(num(direct?.list_usd),num(sub?.list_usd)) || 1
  const bar=(row,label,color)=>jsxs('div',{className:'wm-comparerow',children:[
    jsxs('div',{className:'wm-comparelabel',children:[jsx('span',{children:label}),jsx('span',{className:'wm-mono',children:`${analyticMoney(row?.list_usd)} · ${fmtTokens(row?.tokens)} tok · ${exactTokens(row?.calls)} calls`})]}),
    jsx('div',{className:'wm-comparetrack',role:'img','aria-label':`${label}: ${analyticMoney(row?.list_usd)}`,children:row&&num(row.list_usd)?jsx('span',{style:{width:`${num(row.list_usd)/max*100}%`,background:color}}):null})]},label)
  return jsx(AnalyticsPanel,{number:'03',title:'Delegated operations',subtitle:'Parent inference versus delegated workers',controls:jsx(AnalyticsSegments,{label:'Delegation scope',value:state.filters.scope || 'all',options:[['all','All'],['direct','Parent'],['subagent','Subagents']],onChange:value=>dispatch({type:'filter',key:'scope',value:value==='all'?'':value})}),children:jsxs('div',{children:[
    jsx('div',{className:'wm-comparison',children:[bar(direct,'Parent (direct)','var(--ui-accent)'),bar(sub,'Subagents','var(--ui-success)')]}),
    jsxs('div',{className:'wm-subtle',style:{marginTop:14},children:[
      jsx('p',{children:`${exactTokens(attribution.child_sessions)} child sessions known · ${exactTokens(sub?.calls || 0)} delegated calls captured`}),
      jsx('p',{children:`Cache: parent ${percent(direct?.cache_hit_rate)} · workers ${percent(sub?.cache_hit_rate)} · auxiliary ${percent(aux?.cache_hit_rate)}`}),
      (data.options?.operations || []).length?jsx('p',{children:`Busiest operations: ${(data.options.operations || []).slice(0,5).map(o=>`${String(o.parent).length>24?`${String(o.parent).slice(0,23)}…`:o.parent} (${exactTokens(o.subagent_calls)} worker calls)`).join(' · ')}`}):null,
      num(attribution.unattributed_calls)?jsx('p',{className:'wm-warn',children:`${exactTokens(attribution.unattributed_calls)} calls could not be attributed to a session; they stay in totals as unattributed.`}):null,
      jsx('p',{children:'Combined totals include parent, delegated and auxiliary calls exactly once. Child sessions are matched read-only through state.db parent_session_id; nested delegations roll up to the operation root.'})].filter(Boolean)})]}),
    footer:'A subagent is a persisted child session, not a separate invoice. Where Hermes cannot establish a parent, usage is reported as unattributed rather than assigned.'})
}
function AnalyticsRanking({data,state,dispatch}) {
  const ranked=analyticsSort(data.by_model || [],state.ranking,'desc').slice(0,8)
  const numeric=row=>state.ranking==='savings'?finiteValue(row.economics?.savings_usd):finiteValue(row[state.ranking])
  const maximum=Math.max(0,...ranked.map(r=>Math.abs(numeric(r)||0))) || 1
  const format=state.ranking==='savings'?analyticMoney:state.ranking==='cache_read_tokens'?fmtTokens:percent
  const signed=state.ranking==='savings'
  const start=signed?333:225,end=535,range=signed?100:end-start
  return jsx(AnalyticsPanel,{number:'04',title:'Cache performance',subtitle:'Weighted prompt-cache rate · model × route',controls:jsx(AnalyticsSegments,{label:'Rank by',value:state.ranking,options:[['cache_hit_rate','Hit rate'],['cache_read_tokens','Volume']],onChange:value=>dispatch({type:'set',key:'ranking',value})}),
    children:jsxs('svg',{className:'wm-rank',viewBox:`0 0 620 ${Math.max(170,ranked.length*42+8)}`,'data-chart':'ranking',role:'img','aria-label':'Cache ranking. Exact model filters available on every row.',children:[jsx('title',{children:'Ranked models. Rates are weighted on known-cache calls only. Volume is cache-read tokens. Savings can be negative.'}),
      ...ranked.map((row,i)=>{
        const value=numeric(row),barWidth=Math.abs(value || 0)/(state.ranking==='cache_hit_rate'?1:maximum)*range
        const action=()=>dispatch({type:'select',group:'model',row})
        return jsxs('g',{transform:`translate(0,${i*42+5})`,role:'button',tabIndex:0,'aria-label':`Filter ${row.model} via ${row.provider}; hit ${percent(row.cache_hit_rate)}, ${fmtTokens(row.cache_read_tokens)} read tokens, net savings ${analyticMoney(row.economics?.savings_usd)}`,onClick:action,onKeyDown:event=>keyActivate(event,action),style:{cursor:'pointer'},children:[
          jsx('title',{children:`${row.model} · ${row.provider}\nKnown-cache calls: ${row.cache_known_calls || 0}; unknown: ${row.cache_unknown_calls || 0}\nRead tokens: ${exactTokens(row.cache_read_tokens)}; theoretical net savings: ${analyticMoney(row.economics?.savings_usd)}`}),
          jsx('text',{x:0,y:12,fill:'var(--ui-text-primary)',fontSize:11,children:row.model?.length>31?`${row.model.slice(0,29)}…`:row.model}),jsx('text',{x:0,y:26,className:'wm-axis',children:`${row.provider || 'unknown'} · ${fmtTokens(row.cache_read_tokens)} read · ${analyticMoney(row.economics?.savings_usd)} net`}),
          jsx('rect',{x:signed?233:start,y:5,width:signed?200:range,height:8,rx:3,fill:'var(--ui-fill-tertiary)'}),
          value!=null?jsx('rect',{x:value<0?start-barWidth:start,y:5,width:barWidth,height:8,rx:3,fill:value<0?'var(--ui-warning)':'var(--ui-success)'}):null,
          signed?jsx('line',{x1:start,x2:start,y1:1,y2:18,stroke:'var(--ui-text-quaternary)'}):null,
          jsx('text',{x:609,y:13,textAnchor:'end',className:'wm-axis',children:value==null?'unknown':format(value)})]},analyticsId(row))})]}),
    footer:`Top ${ranked.length} by ${state.ranking==='savings'?'theoretical net savings':state.ranking==='cache_read_tokens'?'cache-read volume':'weighted rate'}. Zero-cache older rows are ambiguous, not confirmed misses. Unknown is not zero. All models remain in the explorer.`})
}
function AnalyticsComposition({data,state,dispatch}) {
  const parts=analyticsComposition(data.totals)
  const total=parts.reduce((s,r)=>s+r.value,0)
  const focus=parts.find(r=>r.id===state.compositionFocus)
  const select=row=>dispatch({type:'set',key:'compositionFocus',value:row.id})
  let x=0
  return jsx(AnalyticsPanel,{number:'05',title:'Token composition',subtitle:'Four disjoint streams · no prompt double-counting',controls:jsx(AnalyticsSegments,{label:'Composition',value:state.compositionMode,options:[['stacked','Stacked'],['doughnut','Doughnut']],onChange:value=>dispatch({type:'set',key:'compositionMode',value})}),
    children:jsxs('div',{className:'wm-composition',children:[state.compositionMode==='doughnut'?
      jsx(AnalyticsDonut,{items:parts,total,label:'all token streams',format:fmtTokens,onSelect:select,chart:'composition'}):
      jsxs('div',{children:[jsx('div',{className:'wm-compositiontotal wm-mono',children:fmtTokens(total)}),jsx('p',{className:'wm-subtle',children:'tokens across all recorded calls'}),
        jsxs('svg',{viewBox:'0 0 600 44',style:{width:'100%',marginTop:18},'data-chart':'composition',role:'img','aria-label':`Token composition: ${exactTokens(total)} total`,children:[jsx('title',{children:parts.map(r=>`${r.label}: ${exactTokens(r.value)} (${percent(r.share)})`).join('; ')}),jsx('rect',{x:0,y:4,width:600,height:28,rx:4,fill:'var(--ui-fill-tertiary)'}),...parts.map(row=>{
          const start=x;x+=row.share*600
          return jsx('rect',{x:start,y:4,width:row.share*600,height:28,fill:row.color,role:'button',tabIndex:0,'aria-label':`Select ${row.label} composition`,onClick:()=>select(row),onKeyDown:event=>keyActivate(event,()=>select(row)),children:jsx('title',{children:`${row.label}: ${exactTokens(row.value)} · ${percent(row.share)}`})},row.id)
        })]})]}),
      jsx('div',{className:'wm-compositionkey',children:parts.map(row=>jsxs('button',{type:'button',className:'wm-legendrow','aria-label':`Select ${row.label} composition`,'aria-pressed':state.compositionFocus===row.id,onClick:()=>select(row),children:[jsx('span',{className:'wm-dot',style:{background:row.color}}),jsx('span',{children:row.label}),jsxs('span',{className:'wm-value wm-mono',children:[fmtTokens(row.value),jsx('small',{children:percent(row.share)})]})]},row.id))})]}),
    footer:jsx('div',{'aria-live':'polite',children:focus?`${focus.label}: ${exactTokens(focus.value)} tokens · ${percent(focus.share)} of all tokens. ${focus.id==='cache_read_tokens'?'Reused prompt tokens; billed at the cache-read rate when known.':focus.id==='cache_write_tokens'?'New cache writes; write premiums are included in net savings when rates are known.':focus.id==='input_tokens'?'Fresh, uncached input only.':'Generated output tokens.'}`:'Select a stream for its exact count. This is a composition inspection, not a hidden model filter.'})})
}
const ANALYTICS_COLUMNS = [['model','Model'],['provider','Provider'],['calls','Calls'],['tokens','Tokens'],['input_tokens','Input'],['output_tokens','Output'],['reasoning_tokens','Reasoning'],['cache_read_tokens','Read'],['cache_write_tokens','Write'],['cache_hit_rate','Cache %'],['savings','Net savings'],['list_usd','API cost'],['per_call','$/call'],['per_million','$/1M tokens'],['pricing','Pricing'],['billing','Billing']]
const ANALYTICS_CORE_COLUMNS = ['model','provider','calls','tokens','input_tokens','output_tokens','list_usd','per_call','per_million','pricing','billing']
/**
 * API-equivalent unit costs for one explorer row. list_usd is a priced
 * subtotal, so the averages stay unknown while any tokens are unpriced:
 * dividing a partial subtotal by all calls would understate the true rate.
 */
function explorerUnitCosts(row) {
  if (!row || num(row.unpriced_tokens)) return { per_call: null, per_million: null }
  return {
    per_call: finiteValue(row.list_usd) != null && num(row.calls) ? num(row.list_usd) / num(row.calls) : null,
    per_million: finiteValue(row.list_usd) != null && num(row.tokens) ? num(row.list_usd) / num(row.tokens) * 1_000_000 : null
  }
}
function analyticsExplorerCsv(rows) {
  const head = ['model','provider','calls','tokens','api_usd','usd_per_call','usd_per_1m_tokens','cache_hit_rate','priced_tokens','unpriced_tokens']
  const line = row => [row.model || '',row.provider || '',row.calls ?? '',row.tokens ?? '',row.list_usd ?? '',
    row.per_call == null ? '' : row.per_call.toFixed(6),row.per_million == null ? '' : row.per_million.toFixed(4),
    row.cache_hit_rate == null ? '' : row.cache_hit_rate.toFixed(4),
    row.priced_tokens ?? '',row.unpriced_tokens ?? ''].map(v => csvCell(v)).join(',')
  return [head.join(','), ...rows.map(line)].join('\n') + '\n'
}
function downloadAnalyticsCsv(rows) {
  try {
    const url = URL.createObjectURL(new Blob([analyticsExplorerCsv(rows)], {type:'text/csv;charset=utf-8'}))
    const a = document.createElement('a'); a.href = url; a.download = `spend-sense-models-${dayKey()}.csv`
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 10_000)
  } catch { /* host without download: table remains visible */ }
}
function AnalyticsExplorer({data,state,dispatch}) {
  const enriched=(data.by_model || []).map(r=>({...r, ...explorerUnitCosts(r)}))
  const rows=analyticsSort(enriched,state.sortKey,state.sortDirection)
  const columns=state.columnMode==='all'?ANALYTICS_COLUMNS:ANALYTICS_COLUMNS.filter(([key])=>ANALYTICS_CORE_COLUMNS.includes(key))
  const visible=state.showAllModels?rows:rows.slice(0,25)
  return jsx(AnalyticsPanel,{title:'Model Explorer',subtitle:`${rows.length} model × route pairs · every column sortable`,controls:jsxs('div',{className:'wm-controls',children:[
    jsx(AnalyticsSegments,{label:'Columns',value:state.columnMode,options:[['core','Core'],['all','All']],onChange:value=>dispatch({type:'set',key:'columnMode',value})}),
    rows.length>25?jsx(AnalyticsButton,{label:state.showAllModels?'Show top 25 only':'Show all models',onClick:()=>dispatch({type:'toggle',key:'showAllModels'}),children:state.showAllModels?'Top 25':'Show all'}):null,
    jsx(AnalyticsButton,{label:'Export filtered models as CSV',onClick:()=>downloadAnalyticsCsv(rows),children:'Export CSV'}),
    jsx('span',{className:'wm-badge',children:'EXACT ROUTE FILTERS'})]}),
    children:jsxs('div',{children:[jsx('div',{className:'wm-tablewrap',children:jsxs('table',{children:[jsx('caption',{children:'Models for the selected period and exact AND filters. Unknown prices, cache rates and savings sort last.'}),
      jsx('thead',{children:jsx('tr',{children:columns.map(([key,label])=>jsx('th',{scope:'col','aria-sort':state.sortKey===key?(state.sortDirection==='asc'?'ascending':'descending'):'none',children:jsx('button',{type:'button','aria-label':`Sort by ${label}`,onClick:()=>dispatch({type:'sort',key}),children:`${label}${state.sortKey===key?(state.sortDirection==='desc'?' ↓':' ↑'):''}`})},key))})}),
      jsx('tbody',{children:visible.map(row=>jsx('tr',{children:columns.map(([key])=>{
        let content
        if(key==='model') content=jsx('button',{type:'button',className:'wm-modelbutton',title:row.model,'aria-label':`Filter ${row.model} via ${row.provider}`,onClick:()=>dispatch({type:'select',group:'model',row}),children:row.model || 'Unknown model'})
        else if(key==='provider') content=jsx('span',{className:'wm-subtle',children:row.provider || 'Unknown'})
        else if(key==='billing') content=jsx('span',{className:'wm-badge',title:'Latest route/model billing classification, not a per-call invoice',children:Object.keys(row.billing_mix || {}).filter(kind=>row.billing_mix[kind]>0).sort().join(' + ') || 'unknown'})
        else if(key==='cache_hit_rate') content=jsxs('div',{title:`${row.cache_known_calls || 0} known-cache calls; ${row.cache_unknown_calls || 0} unknown`,children:[percent(row.cache_hit_rate),row.cache_hit_rate!=null?jsx('div',{className:'wm-meter',children:jsx('span',{style:{width:`${Math.max(0,Math.min(1,row.cache_hit_rate))*100}%`}})}):null]})
        else if(key==='savings') content=jsx('span',{className:row.economics?.savings_usd<0?'wm-warn':row.economics?.savings_usd>0?'wm-good':'wm-dim',children:analyticMoney(row.economics?.savings_usd)})
        else if(key==='list_usd') content=jsxs('span',{className:num(row.unpriced_tokens)?'wm-warn':'',children:[analyticMoney(row.list_usd),num(row.unpriced_tokens)&&row.list_usd!=null?jsx('small',{children:' partial'}):null]})
        else if(key==='per_call'||key==='per_million') content=jsx('span',{title:num(row.unpriced_tokens)?'Unknown: pricing coverage is partial':undefined,children:row[key]==null?'—':`$${num(row[key]).toFixed(num(row[key])<1?4:2)}`})
        else if(key==='pricing') content=jsx('span',{className:cn('wm-badge',num(row.unpriced_tokens)&&'wm-warn'),title:`${exactTokens(row.priced_tokens)} priced / ${exactTokens(row.tokens)} total tokens`,children:analyticsPricing(row)})
        else content=jsx('span',{title:exactTokens(row[key]),children:key==='calls'?exactTokens(row[key]):fmtTokens(row[key])})
        return jsx('td',{className:['model','provider','pricing'].includes(key)?'':'wm-mono',children:content},key)
      })},analyticsId(row)))})]})}),rows.length>25?jsx('p',{className:'wm-subtle',style:{marginTop:10},children:state.showAllModels?`Showing all ${rows.length} pairs.`:`Showing top 25 of ${rows.length} pairs by the current sort. Use Show all for the full table.`}):null]}),
    footer:'$/call and $/1M tokens are API-equivalent averages, not recorded billing. They stay unknown while any tokens are unpriced. Reasoning is included in output, never added again to the four-stream total. Billing is the latest route classification, not an allocated per-call invoice. API cost is the priced subtotal when coverage is partial. Cache % is a weighted rate on calls with known cache activity; it is not an average of model percentages. Click a model to apply its exact model + provider pair.'})
}
function AnalyticsEconomics({data}) {
  const e=data.economics || data.totals?.economics || {}
  const max=Math.max(num(e.uncached_usd),num(e.cached_usd)) || 1
  return jsx(AnalyticsPanel,{title:'Cache economics',subtitle:'A theoretical counterfactual, not a billing credit',controls:jsx('span',{className:cn('wm-badge',e.savings_usd<0?'wm-warn':'wm-good'),children:e.savings_usd==null?'INSUFFICIENT PRICING':e.savings_usd<0?'NET WRITE PREMIUM':'NET CACHE BENEFIT'}),children:jsxs('div',{className:'wm-economics',children:[
    jsxs('div',{children:[jsx('div',{className:cn('wm-compositiontotal wm-mono',e.savings_usd<0?'wm-warn':'wm-good'),children:analyticMoney(e.savings_usd)}),jsx('div',{className:'wm-subtle',children:'theoretical net savings'}),
      jsx('div',{className:'wm-comparison',children:[['Without cache',e.uncached_usd,'var(--ui-text-quaternary)'],['With cache',e.cached_usd,'var(--ui-success)']].map(([label,value,color])=>jsxs('div',{className:'wm-comparerow',children:[jsxs('div',{className:'wm-comparelabel',children:[jsx('span',{children:label}),jsx('span',{className:'wm-mono',children:analyticMoney(value)})]}),jsx('div',{className:'wm-comparetrack',role:'img','aria-label':`${label}: ${analyticMoney(value)}`,children:finiteValue(value)!=null?jsx('span',{style:{width:`${num(value)/max*100}%`,background:color}}):null})]},label))})]}),
    jsxs('div',{className:'wm-explanation',children:[jsx('p',{children:'Without cache: the same prompt tokens at uncached input rates. With cache: fresh input + cache reads + cache writes at their effective per-call catalogue rates. Both include the same output cost, which cancels out of net savings.'}),
      jsx('p',{children:'Net = uncached prompt cost − cached prompt cost. Write premiums may outweigh read discounts, so savings can be negative. This does not represent money returned on subscription or included routes.'}),
      jsx('p',{className:'wm-mono',children:`${percent(e.coverage)} token coverage · ${exactTokens(e.covered_tokens)} covered tokens · ${exactTokens(e.covered_calls)} covered calls · ${exactTokens(e.excluded_calls)} excluded calls`}),
      jsx('p',{children:'Calls with unknown input/read/write prices or ambiguous cache splits are excluded, not assumed free. All comparisons use the same period and exact scope filters.'})]})]})})
}
function AnalyticsFilters({data,state,dispatch}) {
  const filter=(key,value)=>dispatch({type:'filter',key,value})
  const opts=data?.options || {}
  return jsxs('div',{children:[jsxs('div',{className:'wm-filters',children:[
    jsxs('label',{className:'wm-filter',children:[jsx('span',{children:'Period'}),jsx('select',{'aria-label':'Period filter',value:state.days,onChange:event=>dispatch({type:'set',key:'days',value:Number(event.target.value)}),children:[[1,'Today'],[7,'Last 7 days'],[30,'Last 30 days'],[90,'Last 90 days'],[365,'Last 365 days']].map(([days,label])=>jsx('option',{value:days,children:label},days))})]}),
    ...[['model','Model (any provider)',opts.models || [],'Model'],['provider','Provider route',opts.providers || [],'Provider'],['surface','Where it ran',opts.surfaces || [],'Surface'],['task','Kind of work',opts.tasks || [],'Task']].map(([key,label,raw,ariaName])=>{
      const options=key==='model'?[...new Set(raw.map(r=>typeof r==='string'?r:r.model))]:[...raw]
      if(state.filters[key]&&!options.includes(state.filters[key]))options.unshift(state.filters[key])
      return jsxs('label',{className:'wm-filter',children:[jsx('span',{children:label}),jsx('select',{'aria-label':`${ariaName} filter`,value:state.filters[key],onChange:event=>filter(key,event.target.value),children:[jsx('option',{value:'',children:`All ${key==='surface'?'surfaces':key==='task'?'tasks':key==='model'?'models':'providers'}`},'all'),...options.map(value=>jsx('option',{value,children:value || 'Unknown'},value))]})]},key)
    }),
    jsxs('label',{className:'wm-filter',children:[jsx('span',{children:'Parent operation'}),jsx('select',{'aria-label':'Operation filter',value:state.filters.parent,onChange:event=>filter('parent',event.target.value),children:[jsx('option',{value:'',children:'All operations'},'all'),...(opts.operations || []).map(o=>jsx('option',{value:o.parent,children:`${o.parent} (${o.subagent_calls} worker calls)`},o.parent))]})]}),
    jsxs('label',{className:'wm-filter',children:[jsx('span',{children:'Who did the work'}),jsx('select',{'aria-label':'Delegation filter',value:state.filters.scope,onChange:event=>filter('scope',event.target.value),children:[jsx('option',{value:'',children:'Everyone combined'},'all'),jsx('option',{value:'direct',children:'Parent direct only'},'direct'),jsx('option',{value:'subagent',children:'Subagents only'},'subagent'),jsx('option',{value:'auxiliary',children:'Auxiliary only'},'auxiliary'),jsx('option',{value:'unattributed',children:'Unattributed only'},'unattributed')]})]}),
    jsx(AnalyticsButton,{label:'Clear filters',onClick:()=>dispatch({type:'clear'})})]}),
    Object.values(state.filters).some(Boolean)?jsxs('div',{style:{marginTop:10},children:[jsx('p',{className:'wm-subtle',children:'Filtered view — only calls matching all of these are included. Remove one to widen the scope.'}),jsx('div',{className:'wm-scopechips',children:Object.entries(state.filters).filter(([,value])=>value).map(([key,value])=>jsx('button',{type:'button','aria-label':`Remove ${key} filter`,onClick:()=>filter(key,''),children:`${key}: ${value} ×`},key))})]}):null]})
}
function AnalyticsBaseline({days,scope}) {
  const identity = useValue($membershipIdentity)
  const {data,error,isLoading}=useQuery({...backendQuery(days,'hybrid',identity),queryKey:[ID,'historical-baseline',identity,scope,days],refetchInterval:false})
  if(error)return jsx('p',{className:'wm-warn',children:`Historical report unavailable: ${String(error.message || error)}`})
  if(isLoading&&!data)return jsx('p',{className:'wm-subtle',children:'Reading historical baseline…'})
  const baseline=data?.baseline
  const t=(key,...args)=>typeof I18N.en[key]==='function'?I18N.en[key](...args):I18N.en[key] || key
  return jsxs('div',{className:'wm-subtle',style:{paddingTop:12},children:[
    jsx('p',{children:'Historical cumulative estimate — NOT included in period analytics or filters.'}),
    jsx('p',{children:baseline?.totals?`${fmtTokens(baseline.totals.tokens)} tokens · API-equivalent ${analyticMoney(baseline.totals.list_usd)} · recorded billing ${analyticMoney(baseline.totals.billed_usd)}`:'No historical baseline captured.'}),
    baseline?.note?jsx('p',{children:baseline.note}):null,jsx('p',{children:reconciliationText(t,data?.reconciliation)})]})
}
function AnalyticsDashboard({data,state,dispatch,query={},scope='',profile='',productPage=false}) {
  const t = usePluginI18n(ID)
  const totals=data?.totals
  const economics=data?.economics || totals?.economics || {}
  const refresh=()=>query.refetch?.()
  const billingMix=totals?.billing_mix ? Object.entries(totals.billing_mix).map(([kind,value])=>`${kind}: ${typeof value==='number'?fmtTokens(value):String(value)}`).join(' · ') : ''
  const header=jsxs('header',{className:'wm-topline',children:[jsxs('div',{children:[jsx('div',{className:'wm-eyebrow',children:'WolfMark / Spend Sense'}),jsx('h1',{children:'Usage analytics'}),jsx('p',{className:'wm-subtle',style:{marginTop:7},children:`Recorded calls · ${profile || 'current profile'} · all Hermes surfaces`})]}),
    jsxs('div',{className:'wm-topactions',children:[jsx('span',{className:'wm-badge',children:'NERD MODE'}),jsx(AnalyticsButton,{label:'Refresh analytics',disabled:query.isFetching,onClick:refresh,children:query.isFetching?'Refreshing…':'↻ Refresh'}),jsx(AnalyticsButton,{label:'Use this desktop’s ledger',onClick:()=>$view.set(VIEW_DESKTOP),children:'This desktop'}),jsx(AnalyticsButton,{label:'Close analytics',onClick:closeLedger,children:'× Close'})]})]})
  return jsxs('div',{className:cn('wm-analytics',productPage&&'wm-product'),children:[jsx('style',{children:productPage?ANALYTICS_CSS+PRODUCT_CSS:ANALYTICS_CSS}),productPage?jsx(LedgerTabs,{}):null,jsxs('div',{className:'wm-shell',children:[header,jsx(AnalyticsFilters,{data,state,dispatch}),
    query.error?jsxs('div',{className:'wm-alert',role:'alert',children:[jsx('h2',{children:'Analytics unavailable'}),jsx('p',{children:String(query.error.message || query.error)}),jsx('p',{children:data?'The visible snapshot is stale. Retry before using these values.':'The live chip and this desktop’s ledger are still available.'}),jsx(AnalyticsButton,{label:'Retry analytics',onClick:refresh})]}):null,
    query.isLoading&&!data?jsx('div',{className:'wm-empty',role:'status',children:'Reading timestamped calls…'}):null,
    totals?jsxs('div',{className:'wm-stats',children:[
      jsx(AnalyticsStat,{label:'API-equivalent',value:analyticMoney(totals.list_usd),tone:'wm-accent',hint:jsx('span',{className:cn('wm-badge',num(totals.unpriced_tokens)&&'wm-warn'),children:analyticsPricing(totals)}),extra:(data.previous?.comparable && deltaText(data.previous.deltas?.list_usd)) || 'Priced per-call estimate · not an invoice'}),
      jsx(AnalyticsStat,{label:t('weightedCacheHit'),value:percent(totals.cache_hit_rate),tone:'wm-good',hint: totals.cache_prompt_coverage == null ? t('cacheCoverageUnavailable') : t('cacheCoveragePrompt', percent(totals.cache_prompt_coverage)),extra:t('cacheCoverageBasis')}),
      jsx(AnalyticsStat,{label:'Theoretical net savings',value:analyticMoney(economics.savings_usd),tone:economics.savings_usd<0?'wm-warn':'wm-good',hint:'Read discounts − write premiums',extra:`${percent(economics.coverage)} economics coverage · detail below`}),
      jsx(AnalyticsStat,{label:'Tokens / calls',value:fmtTokens(totals.tokens),hint:`${exactTokens(totals.calls)} recorded calls`,extra:(data.previous?.comparable && deltaText(data.previous.deltas?.tokens)) || `${fmtTokens(totals.input_tokens)} in · ${fmtTokens(totals.output_tokens)} out`}),
      jsx(AnalyticsStat,{label:'Pricing coverage',value:percent(data.pricing_coverage?.coverage),hint:`${exactTokens(totals.unpriced_tokens)} unpriced tokens`,extra:analyticsPricing(totals)})]}):null,
    totals&&analyticsInsights(data).length?jsx('div',{className:'wm-insights','aria-label':'What matters in this period',children:analyticsInsights(data).map(item=>jsxs('div',{className:'wm-insight',children:[jsx('b',{children:item.label}),jsx('span',{children:item.text})]},item.label))}):null,
    totals?jsxs('div',{className:'wm-topline wm-subtle',children:[jsxs('span',{title:billingMix || 'Only explicit per-call charges are shown; unknown is not zero.',children:[jsx('strong',{children:'Recorded billing ' }),jsx('span',{className:'wm-mono',children:analyticMoney(totals.billed_usd)}),' ',jsx('span',{className:cn('wm-badge',!totals.billed_complete&&'wm-warn'),children:totals.billed_complete?'Complete':totals.billed_usd==null?'Unknown':'Partial'}),' · includes only recorded charges; unknown routes are not $0.']}),jsx('span',{className:'wm-mono',children:data.window?`${String(data.window.since_local || data.window.since || '').slice(0,10)} → ${String(data.window.until_local || data.window.until || '').slice(0,10)} · ${data.window.since_local ? data.window.timezone || 'local' : 'UTC'}`:'Timestamped window'})]}):null,
    totals&&num(totals.unpriced_tokens)?jsx('div',{className:'wm-alert',children:`${exactTokens(totals.unpriced_tokens)} unpriced tokens. API-equivalent cost is a partial priced subtotal; unknown prices are excluded, not counted as zero.`}):null,
    totals&&!num(totals.calls)?jsxs('div',{className:'wm-empty',role:'status',children:[jsx('h2',{children:'No backend calls recorded for this period'}),jsx('p',{children:'This report covers backend analytics. Desktop-recorded usage shown on Overview is separate; open the local ledger to view calls captured by this Desktop. Try a longer period or clear filters to check this report. The historical baseline remains separate below.'}),jsx(AnalyticsButton,{label:'Show Desktop-recorded usage',onClick:()=>$view.set(VIEW_DESKTOP),children:'Show Desktop-recorded usage'}),jsx(AnalyticsButton,{label:'Clear empty scope',onClick:()=>dispatch({type:'clear'})})]}):null,
    !totals&&!query.isLoading&&!query.error?jsx('div',{className:'wm-empty',role:'status',children:'Usage data is not available for this profile yet.'}):null,
    totals?jsxs('div',{className:'wm-charts',children:[jsx(AnalyticsDistribution,{data,state,dispatch}),jsx(AnalyticsTrendChart,{data,state,dispatch}),jsx(AnalyticsDelegation,{data,state,dispatch}),jsx(AnalyticsRanking,{data,state,dispatch}),jsx(AnalyticsComposition,{data,state,dispatch})]}):null,
    totals?jsx(AnalyticsExplorer,{data,state,dispatch}):null,totals?jsx(AnalyticsEconomics,{data}):null,
    totals?jsxs('div',{className:'wm-subtle',children:[jsx('p',{children:`Recording since ${data.recording?.since || 'not yet available'} · latest ${data.recording?.last || '—'}. Only timestamped captured calls enter this period.`}),jsx('p',{children:'Cache hit = read tokens ÷ (fresh input + read + write tokens), weighted on calls with known cache activity. Legacy zero-cache rows are ambiguous and excluded from the known denominator.'}),jsxs('details',{style:{marginTop:10},children:[jsx('summary',{children:'Methodology & coverage details'}),...(data.notes || []).map((note,i)=>jsx('p',{style:{marginTop:7},children:note},i))]})]}):null,
    jsxs('details',{className:'wm-baseline',open:state.baselineOpen,onToggle:event=>dispatch({type:'set',key:'baselineOpen',value:event.currentTarget.open}),children:[jsx('summary',{children:'Historical baseline & reconciliation — separate cumulative estimate'}),state.baselineOpen?jsx(AnalyticsBaseline,{days:state.days,scope}):null]})]})]})
}
function AnalyticsPage({productPage=false}={}) {
  const profile=useValue(host.state.profile)
  const gateway=useValue(host.state.gateway)
  const connection=useValue(host.state.connectionId || $none)
  const scope=analyticsScope(profile,gateway,connection)
  const states=useValue($analytics)
  const state=states[scope] || analyticsInitialState()
  // Dispatch reads the latest atom, so rapid actions never borrow a stale render's filters.
  const dispatch=action=>analyticsDispatch(scope,action)
  const query=useQuery(analyticsQuery(state.days,state.filters,scope))
  return jsx(AnalyticsDashboard,{data:query.data,state,dispatch,query,scope,profile,productPage})
}


/* ------------------------------------------------- billing & pricing settings */

/** Evidence rows, each carrying its own basis so nothing looks confirmed. */
function billingEvidence(billing) {
  const ev = billing?.evidence || {}
  const rows = [
    ['provider_reported', 'Provider-reported use', 'Confirmed by the provider’s own request history.', 'Not recorded'],
    ['api_equivalent', 'API-equivalent value', 'Published rates applied to these tokens. Theoretical, not an invoice.', 'Not priced'],
    ['credits_consumed', 'Credits consumed', 'Inferred from your membership profile — not a provider-confirmed deduction.', 'No plan set'],
    ['incremental_cash', 'Additional cash', 'Inferred overage after allowances; never asserted as a confirmed charge.', 'No plan set'],
    ['subscription_fee', 'Membership fee', 'Declared by you in a billing profile; charged once per cycle, not per call.', 'No membership']
  ]
  return rows.map(([key, label, explanation, empty]) => ({
    key, label, explanation, empty,
    usd: ev[key]?.usd ?? null,
    basis: ev[key]?.basis || 'none',
    source: ev[key]?.source || ''
  }))
}

function profileDraftErrors(draft) {
  const errors = []
  if (!draft) return ['no draft']
  if (!String(draft.id || '').trim()) errors.push('A short name is required.')
  if (!String(draft.provider || '').trim()) errors.push('A provider route is required.')
  if (!String(draft.kind || '')) errors.push('Choose how this route is paid for.')
  if (draft.kind === 'unknown' && draft.monthly_fee_usd) errors.push('An unknown arrangement cannot assert a fee.')
  if (draft.monthly_fee_usd != null && draft.monthly_fee_usd !== '' && !Number.isFinite(Number(draft.monthly_fee_usd))) errors.push('Fee must be a number.')
  if (draft.allowance_usd != null && draft.allowance_usd !== '' && !Number.isFinite(Number(draft.allowance_usd))) errors.push('Allowance must be a number.')
  return errors
}

function billingNumberStep(options = {}) {
  return options.step ?? (options.type === 'number' ? 'any' : undefined)
}

function profilePayload(draft) {
  const number = value => (value === '' || value == null ? undefined : Number(value))
  const payload = {
    id: String(draft.id).trim(),
    provider: String(draft.provider || '').trim() || undefined,
    model: String(draft.model || '').trim() || undefined,
    kind: draft.kind,
    monthly_fee_usd: number(draft.monthly_fee_usd),
    allowance_usd: draft.allowance_model ? draft.original_scalar_allowance : number(draft.allowance_usd),
    overage_paid: Boolean(draft.overage_paid),
    count_credits_as_spend: Boolean(draft.count_credits_as_spend),
    effective_from: draft.effective_from || undefined,
    effective_to: draft.effective_to || undefined,
    billing_cycle: draft.cycle_day ? { ...(draft.billing_cycle || {}), day: Number(draft.cycle_day) } : undefined,
    currency: draft.currency || undefined,
    label: draft.label || undefined,
    account: draft.account || undefined,
    rate_override: draft.rate_input !== '' && draft.rate_input != null && draft.rate_output !== '' && draft.rate_output != null ? {
      ...(draft.rate_override || {}), input: Number(draft.rate_input), output: Number(draft.rate_output),
      ...(draft.rate_cache !== '' && draft.rate_cache != null ? { cache_read: Number(draft.rate_cache) } : {})
    } : undefined,
    rev: draft.rev || undefined
  }
  if (payload.rate_override && (draft.rate_cache === '' || draft.rate_cache == null)) delete payload.rate_override.cache_read
  const allowances = { ...(draft.allowances || {}) }
  if (draft.original_allowance_model && draft.original_allowance_model !== draft.allowance_model)
    delete allowances[draft.original_allowance_model]
  const allowanceModel = String(draft.allowance_model || '').trim()
  if (allowanceModel) {
    if (draft.allowance_usd === '' || draft.allowance_usd == null) delete allowances[allowanceModel]
    else allowances[allowanceModel] = Number(draft.allowance_usd)
  }
  if (Object.keys(allowances).length) payload.allowances = allowances
  return Object.fromEntries(Object.entries(payload).filter(([, value]) => value !== undefined))
}

const KIND_CHOICES = [
  ['api', 'Pay as you go'],
  ['prepaid', 'Prepaid wallet'],
  ['custom', 'Custom token rates'],
  ['unknown', 'Unknown']
]

const $billingDraft = atom(null)
const $billingPresentation = atom('both')

/** Which figures each presentation mode leads with. */
function evidenceForMode(rows, mode) {
  const keys = mode === 'spend' ? ['provider_reported', 'incremental_cash', 'subscription_fee']
    : mode === 'api' ? ['api_equivalent']
    : ['provider_reported', 'api_equivalent', 'credits_consumed', 'incremental_cash', 'subscription_fee']
  return rows.filter(row => keys.includes(row.key))
}
const $ledgerTab = atom(typeof location !== 'undefined' && /memberships?/.test(location.hash) ? 'memberships'
  : typeof location !== 'undefined' && /billing/.test(location.hash) ? 'costs'
    : typeof location !== 'undefined' && /usage/.test(location.hash) ? 'usage'
      : typeof location !== 'undefined' && /costs/.test(location.hash) ? 'costs'
        : typeof location !== 'undefined' && /settings/.test(location.hash) ? 'settings' : 'overview')
const $billingNotice = atom(null)
const $billingProfiles = atom({ profiles: [], loading: true, error: '' })

function billingQuery(identity = membershipIdentityNow()) {
  return {
    queryKey: [ID, 'billing-profiles', identity],
    queryFn: async () => {
      if (!membershipIdentityCurrent(identity)) throw new Error('Connection changed.')
      if (typeof rest !== 'function') throw new Error('This desktop build has no plugin backend bridge.')
      const result = await rest('/billing/profiles')
      if (!result || result.ok === false || result.error) throw new Error(result?.error || 'Billing profiles are unavailable.')
      if (!membershipIdentityCurrent(identity)) throw new Error('Connection changed.')
      return { ...result, identity }
    },
    retry: false, staleTime: 10_000
  }
}

async function billingWrite(method, path, body, transport = rest) {
  if (typeof transport !== 'function') throw new Error('No plugin backend bridge.')
  // ctx.rest takes `body` as a value and serialises it in the desktop main
  // process. Passing a pre-stringified body double-encodes it, which FastAPI
  // sees as a string rather than an object (422 "Input should be a valid
  // dictionary").
  const result = await transport(path, { method, ...(body ? { body } : {}) })
  if (!result || result.ok === false) throw new Error(result?.detail || result?.error || 'The profile could not be saved.')
  return result
}

/** Concise, non-technical messages — never a raw FastAPI/Pydantic payload. */
function billingErrorMessage(error) {
  const raw = typeof error?.message === 'string' ? error.message : ''
  if (/conflict|409/i.test(raw)) return 'This arrangement changed since you loaded it. Reload, then save again.'
  if (/valid dictionary|422|validation/i.test(raw)) return 'Some details are not valid. Check the name, arrangement and any amounts.'
  if (/401|unauthori/i.test(raw)) return 'Your Desktop session has expired. Sign in again, then retry.'
  if (/404/i.test(raw)) return 'Billing is not available in the running backend. Reload the plugin and check its health.'
  return 'The arrangement could not be saved. Please retry; if it persists, check the backend log.'
}

function billingSummaryQuery(identity = membershipIdentityNow()) {
  return {
    queryKey: [ID, 'billing-summary', identity],
    queryFn: async () => {
      if (!membershipIdentityCurrent(identity)) throw new Error('Connection changed.')
      if (typeof rest !== 'function') throw new Error('This desktop build has no plugin backend bridge.')
      const result = await rest('/billing/summary')
      if (!result || result.ok === false) throw new Error(result?.error || 'Billing summary is unavailable.')
      if (!membershipIdentityCurrent(identity)) throw new Error('Connection changed.')
      return { ...result, identity }
    },
    retry: false, staleTime: 30_000
  }
}

function economicsQuery(identity = membershipIdentityNow()) {
  return {
    queryKey: [ID, 'economics-summary', identity],
    queryFn: async () => {
      if (!membershipIdentityCurrent(identity)) throw new Error('Connection changed.')
      if (typeof rest !== 'function') throw new Error('This desktop build has no plugin backend bridge.')
      const result = await rest('/economics/summary?days=30&trend_months=6')
      if (!result || result.ok === false) throw new Error(result?.error || 'Subscription economics is unavailable.')
      if (!membershipIdentityCurrent(identity)) throw new Error('Connection changed.')
      return { ...result, identity }
    },
    retry: false, staleTime: 30_000
  }
}

function fxQuery(identity = membershipIdentityNow()) {
  return {
    queryKey: [ID, 'fx-rates', identity],
    queryFn: async () => {
      if (!membershipIdentityCurrent(identity)) throw new Error('Connection changed.')
      if (typeof rest !== 'function') throw new Error('This desktop build has no plugin backend bridge.')
      const result = await rest('/membership/fx')
      if (!result || result.ok === false) throw new Error(result?.detail || result?.error || 'FX rates are unavailable.')
      if (!membershipIdentityCurrent(identity)) throw new Error('Connection changed.')
      return { ...result, identity }
    },
    retry: false, staleTime: 30_000
  }
}

async function fxWrite(rates, transport = rest) {
  if (typeof transport !== 'function') throw new Error('No plugin backend bridge.')
  const result = await transport('/membership/fx', { method: 'PUT', body: { rates } })
  if (!result || result.ok === false) throw new Error(result?.detail || result?.error || 'The rates were not saved.')
  return result
}

/**
 * Membership data changed, so the economics comparison built on it is stale.
 * Best-effort: freshness must never break the save flow that triggered it.
 */
async function invalidateEconomicsFor(identity) {
  try {
    await queryClient.invalidateQueries({ queryKey: [ID, 'economics-summary', identity] })
  } catch {
    /* the cached comparison simply stays until its stale time elapses */
  }
}

/** Transport markers that must never reach the user verbatim. */
const FX_TRANSPORT = /\b\d{3}\b|timeout|timed out|network|failed to fetch|fetch failed|connection|econn|socket|abort/i

/** FX failures carry the server's validation sentence; anything else is generic. */
function fxErrorMessage(error) {
  const raw = typeof error?.message === 'string' ? error.message : ''
  if (/conflict|409/i.test(raw)) return 'The rates changed since you loaded them. Reload, then save again.'
  if (/401|unauthori/i.test(raw)) return 'Your Desktop session has expired. Sign in again, then retry.'
  if (/404/i.test(raw)) return 'FX rates are not available in the running backend. Reload the plugin and check its health.'
  if (/422|validation/i.test(raw)) {
    // Only the server's plain validation sentence passes through: a raw
    // transport message with no colon, or detail still carrying a status,
    // fails closed to the generic rejection sentence.
    const detail = raw.replace(/^.*?:\s*/, '')
    if (detail && detail !== raw && !FX_TRANSPORT.test(detail)) return detail
    return 'The rates were rejected. Check each rate and retry.'
  }
  if (!raw) return 'The rates could not be saved. Please retry; if it persists, check the backend log.'
  // Transport failures (status codes, timeouts, network errors) never reach
  // the user verbatim; only the server's plain validation detail passes.
  if (FX_TRANSPORT.test(raw)) {
    return 'The rates could not be saved. Please retry; if it persists, check the backend log.'
  }
  return raw
}

/** UTC calendar day for renewal dates, which are UTC midnights. */
function fmtDay(value) {
  if (value === null || value === undefined || value === '') return '—'
  const when = new Date(value)
  if (Number.isNaN(when.getTime())) return '—'
  return when.toISOString().slice(0, 10)
}

/** Short human status for an economics comparison. */
function econStatusLabel(status) {
  return status === 'ok' ? 'Complete' : status === 'partial' ? 'Partial' : 'Unavailable'
}

/** One line for a usage value and its pricing coverage. */
function econCoverageLabel(usage) {
  if (!usage || !num(usage.tokens)) return 'No usage observed'
  if (usage.list_usd == null) return 'No published price'
  if (usage.coverage == null) return 'Coverage unknown'
  const pct = Math.round(usage.coverage * 100)
  return pct >= 100 ? 'Fully priced' : `${pct}% priced`
}

/** Window-allocated expenditure lines, one per currency — never summed here. */
function econWindowLines(fees) {
  const rows = Array.isArray(fees) ? fees : []
  if (!rows.length) return ['—']
  return rows.map(({ amount, currency }) => fmtMoney(amount, currency) || '—')
}

/** Display span of the reporting window for "in the last N days" labels. */
function windowSpanLabel(windowDays) {
  const days = finiteValue(windowDays)
  if (days == null || days <= 0) return 'in the reporting window'
  const rounded = Math.max(1, Math.round(days))
  return `in the last ${rounded} day${rounded === 1 ? '' : 's'}`
}

/** Monthly-equivalent fee lines, one per currency — never summed here. */
function econFeeLines(fees) {
  const rows = Array.isArray(fees) ? fees : []
  if (!rows.length) return ['—']
  return rows.map(({ amount, currency }) => {
    const money = fmtMoney(amount, currency)
    return money ? `${money}/mo` : '—'
  })
}

const LEDGER_TABS = [['overview', 'Overview'], ['usage', 'Usage'], ['costs', 'Costs'],
  ['memberships', 'Memberships'], ['settings', 'Settings & About']]
function LedgerTabs() {
  const tab = useValue($ledgerTab)
  useEffect(() => {
    if (typeof window === 'undefined' || typeof location === 'undefined') return undefined
    const sync = () => {
      const id = String(location.hash || '').replace('#', '')
      if (LEDGER_TABS.some(([known]) => known === id) && $ledgerTab.get() !== id) $ledgerTab.set(id)
    }
    window.addEventListener('hashchange', sync)
    return () => window.removeEventListener('hashchange', sync)
  }, [])
  const onKeyDown = event => {
    if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return
    const index = LEDGER_TABS.findIndex(([id]) => id === tab)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? LEDGER_TABS.length - 1
      : (index + (event.key === 'ArrowRight' ? 1 : -1) + LEDGER_TABS.length) % LEDGER_TABS.length
    event.preventDefault()
    goLedgerTab(LEDGER_TABS[next][0])
    event.currentTarget.querySelectorAll('[role="tab"]')[next]?.focus()
  }
  return jsx('div', { className: 'wm-shell', style: { paddingBottom: 0 }, children:
    jsx('div', { className: 'wm-product-tabs', role: 'tablist', 'aria-label': 'Spend Sense sections', onKeyDown, children:
      [jsx('span', { className: 'wm-product-brand', 'aria-hidden': true,
        children: jsx(BrandMark, { size: 16, id: 'tabs' }) }, 'brand'),
      ...LEDGER_TABS.map(([id, label]) =>
        jsx(ProductButton, { role: 'tab', variant: 'ghost', 'aria-selected': tab === id, 'aria-pressed': tab === id,
          className: cn('wm-product-tab', tab === id && 'wm-product-tab-active'), 'data-active': tab === id,
          onClick: () => goLedgerTab(id), children: label }, id))] }) })
}

function goLedgerTab(next) {
  $ledgerTab.set(next)
  try { if (typeof location !== 'undefined') history.replaceState(null, '', '#' + next) } catch {}
}

function profileDraft(profile, identity) {
    const [allowanceModel, modelAllowance] = Object.entries(profile.allowances || {})[0] || ['', '']
    return { ...profile, origin: identity,
      cycle_day: profile?.billing_cycle?.day || 1,
      rate_input: profile.rate_override?.input ?? '', rate_output: profile.rate_override?.output ?? '',
      rate_cache: profile.rate_override?.cache_read ?? '', allowance_model: allowanceModel,
      allowance_usd: allowanceModel ? modelAllowance : (profile.allowance_usd ?? ''),
      original_allowance_model: allowanceModel, original_scalar_allowance: profile.allowance_usd }
}

function AdvancedBillingRules() {
  const identity = useValue($membershipIdentity)
  const profilesQuery = useQuery(billingQuery(identity))
  const rawDraft = useValue($billingDraft)
  const notice = useValue($billingNotice)
  const draft = rawDraft?.origin === identity ? rawDraft : null
  const loaded = profilesQuery.data?.identity === identity && membershipIdentityCurrent(identity)
    ? profilesQuery.data.profiles || [] : []
  const advanced = loaded.filter(profile => !['subscription_included', 'subscription_credits', 'free'].includes(profile.kind))
  const legacy = loaded.length - advanced.length
  const errors = profileDraftErrors(draft)
  const startEdit = profile => $billingDraft.set(profileDraft(profile, identity))
  const update = (key, value) => $billingDraft.set({ ...draft, [key]: value })
  const save = async event => {
    event?.preventDefault?.()
    if (!draft || !membershipIdentityCurrent(draft.origin) || errors.length) return
    const captured = draft.origin
    try {
      await billingWrite('PUT', `/billing/profiles/${encodeURIComponent(draft.id)}`, profilePayload(draft))
      if (!membershipIdentityCurrent(captured) || $billingDraft.get() !== draft) return
      $billingNotice.set({ tone: 'good', origin: captured, text: 'Saved. Recorded usage was not changed.' })
      $billingDraft.set(null)
      await profilesQuery.refetch?.()
    } catch (error) {
      if (membershipIdentityCurrent(captured)) $billingNotice.set({ tone: 'warn', origin: captured, text: billingErrorMessage(error) })
    }
  }
  const remove = async profile => {
    const captured = identity
    if (!membershipIdentityCurrent(captured)) return
    try {
      await billingWrite('DELETE', `/billing/profiles/${encodeURIComponent(profile.id)}`)
      if (!membershipIdentityCurrent(captured)) return
      $billingNotice.set({ tone: 'good', origin: captured, text: 'Removed. Recorded usage was not changed.' })
      await profilesQuery.refetch?.()
    } catch (error) {
      if (membershipIdentityCurrent(captured)) $billingNotice.set({ tone: 'warn', origin: captured, text: billingErrorMessage(error) })
    }
  }
  const field = (label, key, options = {}) => jsxs('label', { className: 'wm-filter', children: [
    jsx('span', { children: label }),
    options.choices
      ? jsx('select', { value: draft[key] ?? '', onChange: event => update(key, event.target.value),
        children: options.choices.map(([value, text]) => jsx('option', { value, children: text }, value)) })
      : jsx('input', { value: draft[key] ?? '', type: options.type || 'text', step: billingNumberStep(options), placeholder: options.placeholder || '',
        onChange: event => update(key, event.target.value) })
  ] }, key)
  return jsxs('section', { className: 'wm-product-section', children: keyedElementChildren([
    jsx('h2', { children: 'Advanced billing rules' }),
    jsx('p', { children: 'Optional prepaid wallets, route-specific allowances and custom token rates. Membership plans and recurring fees are managed in Memberships.' }),
    legacy ? jsx('p', { className: 'wm-subtle', children:
      `${legacy} legacy subscription arrangement(s) are retained for reference and excluded from all fee totals. Choose those plans in Memberships.` }) : null,
    notice?.origin === identity ? jsx('div', { className: 'wm-alert', role: 'status', children: notice.text }) : null,
    profilesQuery.error ? jsx('div', { className: 'wm-alert', role: 'alert',
      children: String(profilesQuery.error.message || profilesQuery.error) }) : null,
    jsx('div', { className: 'wm-setting-action', children: [
      jsx(ProductButton, { type: 'button', className: 'wm-button', onClick: () =>
        $billingDraft.set({ id: '', kind: 'prepaid', provider: '', model: '', monthly_fee_usd: '',
          allowance_usd: '', allowance_model: '', cycle_day: 1, overage_paid: false,
          origin: identity }), children: 'Add advanced rule' }),
      jsx(ProductButton, { type: 'button', className: 'wm-button', onClick: () => profilesQuery.refetch?.(),
        disabled: profilesQuery.isFetching, children: profilesQuery.isFetching ? 'Refreshing…' : 'Refresh rules' })
    ] }),
    profilesQuery.isPending ? jsx('p', { className: 'wm-subtle', children: 'Reading advanced rules…' }) : null,
    advanced.length ? jsx('div', { className: 'wm-cost-list', children: advanced.map(profile => jsxs('div', {
      className: 'wm-cost-row', children: [
        jsxs('div', { children: [
          jsx('strong', { children: profile.label || profile.id }),
          jsx('small', { children: [profile.provider, profile.model, profile.kind].filter(Boolean).join(' · ') }),
          jsx('small', { children: profile.kind === 'custom' && profile.rate_override
            ? `Custom input ${fmtUsd(profile.rate_override.input)} / output ${fmtUsd(profile.rate_override.output)} per million tokens`
            : profile.allowances ? Object.entries(profile.allowances).map(([model, value]) => `${model}: ${fmtUsd(value)} allowance`).join(' · ')
              : profile.allowance_usd != null ? `${fmtUsd(profile.allowance_usd)} allowance` : 'No allowance reported' })
        ] }),
        jsx('div', { className: 'wm-setting-action', children: [
          jsx(ProductButton, { type: 'button', className: 'wm-button', onClick: () => startEdit(profile), children: 'Edit' }),
          jsx(ProductButton, { type: 'button', className: 'wm-button', onClick: () => remove(profile), children: 'Delete' })
        ] })
      ]
    }, profile.id)) }) : !profilesQuery.isPending ? jsx('p', { className: 'wm-subtle', children:
      'No advanced rules are saved. This is optional; Costs and Memberships work without them.' }) : null,
    draft ? jsxs('form', { className: 'wm-custom-form', onSubmit: save, children: [
      jsx('h3', { children: draft.id ? 'Edit advanced rule' : 'New advanced rule' }),
      jsx('div', { className: 'wm-custom-grid', children: [
        field('Rule name', 'id', { placeholder: 'e.g. OpenRouter prepaid' }),
        field('Display label', 'label', { placeholder: 'Optional' }),
        field('Provider route', 'provider', { placeholder: 'openai-codex' }),
        field('Model (optional)', 'model', { placeholder: 'provider/model' }),
        field('Rule type', 'kind', { choices: KIND_CHOICES }),
        field('Prepaid balance / allowance (USD)', 'allowance_usd', { type: 'number' }),
        field('Allowance model (optional)', 'allowance_model', { placeholder: 'provider/model' }),
        field('Cycle day', 'cycle_day', { type: 'number', step: '1' }),
        field('Effective from', 'effective_from', { type: 'date' }),
        field('Effective to', 'effective_to', { type: 'date' }),
        field('Custom input rate per million (USD)', 'rate_input', { type: 'number' }),
        field('Custom output rate per million (USD)', 'rate_output', { type: 'number' }),
        field('Custom cache-read rate per million (USD)', 'rate_cache', { type: 'number' })
      ] }),
      jsx('p', { className: 'wm-subtle', children: 'Prepaid and custom-rate rules affect estimates only. They do not change settled Desktop records or represent provider invoices.' }),
      jsx('div', { className: 'wm-setting-action', children: [
        jsx(ProductButton, { type: 'submit', className: 'wm-button', disabled: errors.length > 0, children: 'Save rule' }),
        jsx(ProductButton, { type: 'button', className: 'wm-button', onClick: () => $billingDraft.set(null), children: 'Cancel' })
      ] }),
      errors.length ? jsx('p', { className: 'wm-warn-note', role: 'alert', children: errors.join(' ') }) : null
    ] }) : null
  ], 'advanced-billing-rules') })
}

const PRODUCT_CSS = [
  '.wm-product .wm-shell{max-width:1180px;padding:24px 22px;gap:18px}',
  '.wm-product .wm-product-heading{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;flex-wrap:wrap}',
  '.wm-product .wm-product-heading h1{margin:0;font-size:24px;line-height:1.2;font-weight:620;letter-spacing:-.35px}',
  '.wm-product .wm-product-heading p{margin:5px 0 0;color:var(--ui-text-tertiary);font-size:13px;line-height:1.45}',
  '.wm-product .wm-product-tabs{display:flex;gap:4px;overflow:auto;padding:3px;border-bottom:1px solid var(--ui-stroke-secondary);position:sticky;top:0;z-index:6;background:var(--ui-fill-primary)}',
  '.wm-product .wm-product-brand{display:inline-flex;align-items:center;flex-shrink:0;align-self:center;margin:0 6px 0 2px}',
  '.wm-product .wm-product-tab{border:0;background:transparent;color:var(--ui-text-tertiary);border-radius:6px;padding:8px 13px;min-height:38px;display:inline-flex;align-items:center;font:inherit;font-size:13px;white-space:nowrap;cursor:pointer;transition:background-color .15s ease,color .15s ease,box-shadow .15s ease}',
  '.wm-product .wm-product-tab:hover{background:var(--ui-fill-secondary);color:var(--ui-text-primary)}',
  '.wm-product .wm-product-tab-active{background:var(--ui-fill-secondary);color:var(--ui-text-primary);font-weight:570;box-shadow:inset 0 -2px 0 var(--ui-accent)}',
  '.wm-product .wm-button{min-height:34px;transition:background-color .15s ease,color .15s ease,border-color .15s ease}',
  '.wm-product .wm-account-jump{display:flex;gap:6px;flex-wrap:wrap;align-items:center}',
  '.wm-product .wm-account-chip{border:1px solid var(--ui-stroke-secondary);background:transparent;color:var(--ui-text-secondary);border-radius:99px;padding:6px 11px;min-height:32px;font:inherit;font-size:12px;cursor:pointer;transition:background-color .15s ease,color .15s ease}',
  '.wm-product .wm-account-chip:hover{background:var(--ui-fill-secondary);color:var(--ui-text-primary)}',
  '.wm-product .wm-account-chip[data-attention="true"]{border-color:var(--ui-warning);color:var(--ui-text-primary)}',
  '.wm-product .wm-overview-attention{margin:6px 0 4px;padding-left:18px;display:grid;gap:5px;font-size:13px;line-height:1.5;color:var(--ui-text-secondary)}',
  '.wm-product .wm-product-summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(185px,1fr));gap:10px}',
  '.wm-product .wm-product-stat{border:1px solid var(--ui-stroke-secondary);border-radius:8px;background:var(--ui-fill-primary);padding:14px 15px;min-width:0;min-height:98px}',
  '.wm-product .wm-product-stat label{display:block;color:var(--ui-text-tertiary);font-size:12px}',
  '.wm-product .wm-product-stat strong{display:block;margin-top:5px;font-size:19px;line-height:1.3;font-weight:580;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}',
  '.wm-product .wm-product-section{border:1px solid var(--ui-stroke-secondary);border-radius:8px;padding:17px;background:var(--ui-fill-primary)}',
  '.wm-product .wm-product-section h2{margin:0 0 4px;font-size:16px;font-weight:590}',
  '.wm-product .wm-product-section > p{margin:4px 0 12px;color:var(--ui-text-tertiary);font-size:12px;line-height:1.5}',
  '.wm-product .wm-cost-list{display:grid;gap:0}',
  '.wm-product .wm-cost-row{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:12px;border-top:1px solid var(--ui-stroke-secondary);padding:11px 2px}',
  '.wm-product .wm-cost-row:first-child{border-top:0}',
  '.wm-product .wm-cost-row strong{font-size:13px;font-weight:550}',
  '.wm-product .wm-cost-row small{display:block;margin-top:3px;color:var(--ui-text-tertiary);font-size:11px;line-height:1.4}',
  '.wm-product .wm-source-link{border:0;padding:0;background:none;color:var(--ui-text-tertiary);font:inherit;font-size:11px;text-align:left;text-decoration:underline;text-underline-offset:2px;cursor:pointer}',
  '.wm-product .wm-source-link:hover{color:var(--ui-text-primary)}',
  '.wm-product .wm-settings-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px}',
  '.wm-product .wm-settings-grid .wm-product-section{min-width:0}',
  '.wm-product .wm-setting-action{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}',
  '.wm-product .wm-setting-toggle{display:flex;align-items:flex-start;gap:9px;margin:10px 0;padding:10px;border:1px solid var(--ui-stroke-secondary);border-radius:7px;background:var(--ui-fill-secondary);color:var(--ui-text-primary);font-size:12px;line-height:1.45}',
  '.wm-product .wm-setting-toggle input{margin:2px 0 0;accent-color:var(--ui-accent)}',
  '.wm-product .wm-custom-form{display:grid;gap:12px;margin-top:14px;padding:14px;border:1px solid var(--ui-stroke-secondary);border-radius:8px;background:var(--ui-fill-secondary)}',
  '.wm-product .wm-custom-form h3,.wm-product .wm-exhaustion-form h3{margin:0;font-size:13px;font-weight:600}',
  '.wm-product .wm-custom-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px}',
  '.wm-product .wm-custom-form input,.wm-product .wm-allowance-editor input,.wm-product .wm-exhaustion-form input{width:100%;min-height:34px;border:1px solid var(--ui-stroke-secondary);border-radius:6px;padding:7px 9px;background:var(--ui-fill-primary);color:var(--ui-text-primary);font:inherit}',
  '.wm-product .wm-allowances{display:grid;gap:9px;padding-top:8px;border-top:1px solid var(--ui-stroke-secondary)}',
  '.wm-product .wm-allowance-editor{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));align-items:end;gap:9px;padding:10px 0;border-top:1px solid var(--ui-stroke-secondary)}',
  '.wm-product .wm-confirm-box{margin-top:10px;padding:11px;border:1px solid var(--ui-warning);border-radius:7px;background:color-mix(in srgb,var(--ui-warning) 7%,transparent)}',
  '.wm-product .wm-exhaustion-form{display:grid;gap:10px;margin-top:10px;padding:12px;border:1px solid var(--ui-accent);border-radius:8px;background:var(--ui-fill-secondary)}',
  '.wm-product .wm-product-stat small{display:block;margin-top:6px;color:var(--ui-text-tertiary);font-size:11px;line-height:1.4}',
  '.wm-product .wm-product-section p{max-width:78ch}',
  '.wm-product :focus-visible{outline:2px solid var(--ui-accent);outline-offset:2px}',
  '@container(max-width:620px){.wm-product .wm-shell{padding:17px 12px;gap:14px}.wm-product .wm-product-heading h1{font-size:21px}.wm-product .wm-product-section{padding:14px}.wm-product .wm-cost-row{align-items:start}}'
].join('');

function pricingStatusQuery(identity = membershipIdentityNow()) {
  return {
    queryKey: [ID, 'pricing-status', identity],
    queryFn: async () => {
      if (!membershipIdentityCurrent(identity)) throw new Error('Connection changed.')
      if (typeof rest !== 'function') throw new Error('Pricing status is unavailable.')
      const result = await rest('/rates')
      if (!membershipIdentityCurrent(identity)) throw new Error('Connection changed.')
      if (!result?.ok || !result.catalogue) throw new Error('Pricing status is unavailable.')
      return result.catalogue
    },
    retry: false, staleTime: 30_000
  }
}

function membershipEntitlementSummary(account) {
  const windows = account?.plan?.entitlements?.windows || []
  const names = windows.map(window => {
    const amount = window.amount == null ? '' : ` · ${fmtMoney(window.amount, window.currency || 'USD')} allowance`
    return `${window.label || window.id}${amount}`
  })
  const restrictions = account?.plan?.model_restrictions || []
  const parts = []
  if (names.length) parts.push(`plan allowances: ${names.join(', ')} (usage in Memberships)`)
  if (restrictions.length) parts.push(`restricted models: ${restrictions.join(', ')}`)
  if (account?.plan?.effective?.effective_from || account?.plan?.effective?.effective_to) {
    parts.push(`effective ${account.plan.effective.effective_from || 'any time'} to ${account.plan.effective.effective_to || 'ongoing'}`)
  }
  return parts.join(' · ')
}

function CostsPage() {
  const identity = useValue($membershipIdentity)
  const summary = useQuery(billingSummaryQuery(identity))
  const accounts = useQuery(membershipQuery(false, identity))
  const pricing = useQuery(pricingStatusQuery(identity))
  const current = accounts.data?.identity === identity && membershipIdentityCurrent(identity)
    ? accounts.data : null
  const accountsReady = !!current
  const list = current ? membershipAccounts(current) : []
  const fees = membershipSummary(list)
  const billing = summary.data?.billing || {}
  const evidence = billingEvidence(billing).filter(row => row.key !== 'subscription_fee')
  const ignored = Number(billing.legacy_membership_arrangements_ignored || 0)
  const status = pricing.data
  const sourceText = status
    ? 'Pricing: ' + (status.source || 'source unavailable') +
      (status.age_seconds != null ? ' · ' + Math.round(status.age_seconds / 3600) + ' h old' : ' · date unknown') +
      (status.stale ? ' · stale' : '') + ' · sources and privacy'
    : 'Pricing sources and privacy'
  return jsxs('div', { className: 'wm-analytics wm-product', children: [
    jsx('style', { children: ANALYTICS_CSS + PRODUCT_CSS + ECONOMICS_CSS }),
    jsx(LedgerTabs, {}),
    jsxs('main', { className: 'wm-shell', children: [
      jsxs('header', { className: 'wm-product-heading', children: [
        jsxs('div', { children: [jsx('h1', { children: 'Costs' }),
          jsx('p', { children: 'Recorded usage, current price estimates and the memberships you have declared.' })] }),
        jsx('button', { type: 'button', className: 'wm-source-link',
          onClick: () => goLedgerTab('settings'), children: sourceText })
      ] }),
      summary.error
        ? jsx('div', { className: 'wm-alert', role: 'alert', children: String(summary.error.message || summary.error) })
        : null,
      accounts.error
        ? jsx('div', { className: 'wm-alert', role: 'alert', children: membershipErrorText(accounts.error, 'read') })
        : null,
      jsx(EconomicsPanel, { identity }),
      jsxs('section', { className: 'wm-product-section', children: [
        jsx('h2', { children: 'Membership costs' }),
        jsx('p', { children: 'Each account appears once. Totals keep currencies and billing periods separate.' }),
        jsxs('div', { className: 'wm-product-summary', children: [
          jsxs('div', { className: 'wm-product-stat', children: [
            jsx('label', { children: 'Saved memberships' }),
            jsx('strong', { children: accountsReady ? fees.withPlan + ' of ' + fees.total : '—' })
          ] }),
          jsxs('div', { className: 'wm-product-stat', children: [
            jsx('label', { children: 'Combined membership fees' }),
            jsx('strong', { children: accountsReady ? feesLabel(fees) : '—' })
          ] })
        ] }),
        !accountsReady && !accounts.error
          ? jsx('p', { className: 'wm-subtle', children: 'Reading memberships for this connection…' })
          : null,
        list.length
          ? jsx('div', { className: 'wm-cost-list', children: list.map(account => jsxs('div', {
              className: 'wm-cost-row', children: [
                jsxs('div', { children: [
                  jsx('strong', { children: account.plan?.name || account.label || account.family }),
                  jsx('small', { children:
                    (account.label !== account.family ? account.label + ' · ' : '') +
                    (account.fee?.basis === 'catalogue' ? 'Bundled catalogue price'
                      : account.fee?.basis === 'custom' ? 'User-defined plan price'
                      : account.fee?.basis === 'declared' ? 'Your fee; plan price kept separately'
                      : account.fee?.basis === 'unpriced' ? 'No published price' : account.family)
                    + (membershipEntitlementSummary(account) ? ' · ' + membershipEntitlementSummary(account) : '')
                  })
                ] }),
                jsx('strong', { children: feeLabel(account.fee) })
              ]
            }, account.id)) })
          : accountsReady ? jsx('p', { className: 'wm-subtle', children:
              'No saved memberships yet. Discover accounts and confirm their plans in Memberships.' }) : null,
        ignored
          ? jsx('p', { className: 'wm-subtle', children: ignored + ' old subscription arrangement(s) remain stored but are excluded. Choose each plan in Memberships to keep one authoritative record.' })
          : null
      ] }),
      jsxs('section', { className: 'wm-product-section', children: [
        jsx('h2', { children: 'Usage evidence' }),
        jsx('p', { children: 'Provider-reported values and price estimates are different kinds of evidence; neither is a payment receipt.' }),
        summary.isPending ? jsx('p', { className: 'wm-subtle', children: 'Reading usage evidence…' }) : null,
        jsx('div', { className: 'wm-product-summary', children: evidence.map(row => jsx('div', {
          className: 'wm-product-stat', children: [
            jsx('label', { children: row.label }),
            jsx('strong', { children: row.usd == null ? row.empty : fmtUsd(row.usd) }),
            jsx('small', { className: 'wm-subtle', children: row.basis + ' · ' + row.explanation })
          ]
        }, row.key)) })
      ] }),
      jsx('p', { className: 'wm-subtle', children:
        'Desktop-recorded values keep the rates captured at the time. Backend API-equivalent estimates use the current available catalogue and can change; they are not historical charges.' })
    ] })
  ] })
}

/** Paired fee-vs-usage bars for one comparable currency group. */
function EconomicsBars({ group }) {
  // Windowed fees pair with windowed usage; fall back to monthly figures
  // only against an older backend that predates window allocation.
  const base = finiteValue(group.window_fees) ?? finiteValue(group.monthly_fees) ?? 0
  const fee = group.converted && group.fx ? base * group.fx.usd_per_unit : base
  const usage = finiteValue(group.usage_usd) ?? 0
  const max = Math.max(fee, usage, 0.000001)
  const bar = (value, cls, label) => jsxs('div', { className: 'wm-econ-bar-row', children: [
    jsx('span', { className: 'wm-econ-bar-label', children: label }),
    jsx('div', { className: 'wm-econ-bar-track', role: 'img',
      'aria-label': `${label}: ${analyticMoney(value)}`,
      children: jsx('div', { className: `wm-econ-bar-fill ${cls}`,
        style: { width: `${Math.max(2, Math.round((value / max) * 100))}%` } }) }),
    jsx('span', { className: 'wm-econ-bar-value', children: analyticMoney(value) })
  ] })
  return jsxs('div', { className: 'wm-econ-bars', children: [
    bar(fee, 'wm-econ-fee', `Fees in window (${group.currency}${group.converted ? ', in USD' : ''})`),
    bar(usage, 'wm-econ-usage', 'API-equivalent usage'),
    group.converted && group.fx
      ? jsx('p', { className: 'wm-subtle', children:
          `Converted at ${group.fx.usd_per_unit} USD per ${group.currency}, dated ${group.fx.as_of} (${group.fx.source}).` })
      : null
  ].filter(Boolean) })
}

/** One account row of the economics breakdown table. */
function EconomicsAccountRow({ row }) {
  const fee = row.fee || {}
  const monthly = row.monthly_equivalent || {}
  const windowFee = row.window_expenditure || {}
  const usage = row.usage || {}
  const renewal = row.renewal || {}
  const feeText = fee.amount == null ? 'No fee set'
    : `${fmtMoney(fee.amount, fee.currency)}/${fee.period === 'month' ? 'mo' : fee.period === 'year' ? 'yr' : fee.period}`
  const basisText = fee.basis === 'declared' ? 'Your price' : fee.basis === 'custom' ? 'User-defined plan'
    : fee.basis === 'catalogue' ? 'Catalogue price' : null
  const renewalText = renewal.amount == null ? null
    : renewal.date_known && renewal.date
      ? `${fmtMoney(renewal.amount, renewal.currency)} due ${fmtDay(renewal.date)}`
      : `${fmtMoney(renewal.amount, renewal.currency)} · renewal date unknown`
  const usageText = usage.list_usd == null ? '—' : analyticMoney(usage.list_usd)
  const usageDetail = usage.tokens ? `${fmtTokens(usage.tokens)} · ${usage.calls} calls` : null
  const routes = (row.attribution?.routes || []).map(r => r.route).join(', ')
  const difference = finiteValue(row.difference_usd)
  return jsxs('tr', { children: [
    jsxs('td', { children: [
      jsx('div', { className: 'wm-econ-account', children: row.label || row.family }),
      jsx('div', { className: 'wm-econ-dim', children: [row.plan_name || 'No plan', row.family].filter(Boolean).join(' · ') || null })
    ] }),
    jsxs('td', { children: [
      jsx('div', { children: feeText }),
      basisText ? jsx('div', { className: 'wm-econ-dim', children: basisText }) : null,
      renewalText ? jsx('div', { className: 'wm-econ-dim', children: renewalText }) : null
    ].filter(Boolean) }),
    jsxs('td', { className: 'wm-econ-num', children: [
      jsx('div', { children: monthly.amount == null ? '—'
        : `${fmtMoney(monthly.amount, monthly.currency)}/mo` }),
      windowFee.amount == null ? null
        : jsx('div', { className: 'wm-econ-dim',
            children: `${fmtMoney(windowFee.amount, windowFee.currency)} in window` })
    ].filter(Boolean) }),
    jsxs('td', { className: 'wm-econ-num', children: [
      jsx('div', { children: usageText }),
      usageDetail ? jsx('div', { className: 'wm-econ-dim', children: usageDetail }) : null,
      routes ? jsx('div', { className: 'wm-econ-dim', children: routes }) : null
    ].filter(Boolean) }),
    jsx('td', { className: cn('wm-econ-num', difference != null && (difference < 0 ? 'wm-econ-negative' : 'wm-econ-positive')),
      children: difference == null ? econStatusLabel(row.status) : analyticMoney(difference) }),
    jsxs('td', { children: [
      jsx('div', { children: econCoverageLabel(usage) }),
      jsx('div', { className: 'wm-econ-dim', children: econStatusLabel(row.status) })
    ] })
  ] })
}

/** Monthly trend: paired bars where comparable, honest text rows elsewhere. */
function EconomicsTrend({ trend }) {
  const months = trend?.months || []
  if (!months.length) {
    return jsx('p', { className: 'wm-subtle', children:
      'No monthly history yet. The trend appears once recording and fees cover a calendar month.' })
  }
  return jsx('div', { className: 'wm-econ-trend', children: months.map(entry => {
    const difference = finiteValue(entry.difference_usd)
    const feeUsd = finiteValue(entry.fees_usd)
    const flags = [entry.in_progress ? 'in progress' : null,
      entry.recording_partial ? 'partial recording' : null,
      entry.partial ? 'partial pricing' : null].filter(Boolean).join(' · ')
    const feesText = (entry.fees_by_currency || []).map(({ amount, currency }) =>
      `${fmtMoney(amount, currency)}/mo`).join(' + ') || 'No fees'
    // Bars need the backend's converted fee total; without it (or without a
    // difference) the month renders as an honest text row instead of a
    // client-side currency sum.
    if (difference == null || feeUsd == null) {
      return jsxs('div', { className: 'wm-econ-trend-row', children: [
        jsx('span', { className: 'wm-econ-trend-month', children: entry.month }, 'month'),
        jsxs('span', { className: 'wm-econ-dim', children: [
          `${feesText} · ${analyticMoney(entry.usage_usd)} usage`,
          flags ? ` · ${flags}` : '',
          entry.difference_note ? ` · ${entry.difference_note}` : ''
        ].join('') }, 'detail')
      ] }, entry.month)
    }
    const usage = finiteValue(entry.usage_usd) ?? 0
    const max = Math.max(feeUsd, usage, 0.000001)
    return jsxs('div', { className: 'wm-econ-trend-month-block', children: [
      jsxs('div', { className: 'wm-econ-trend-row', children: [
        jsx('span', { className: 'wm-econ-trend-month', children: entry.month }, 'month'),
        jsxs('div', { className: 'wm-econ-trend-bars', role: 'img',
          'aria-label': `${entry.month}: fees ${analyticMoney(feeUsd)}, usage ${analyticMoney(usage)}, difference ${analyticMoney(difference)}`,
          children: [
            jsx('div', { className: 'wm-econ-bar-fill wm-econ-fee', title: `Fees ${analyticMoney(feeUsd)}`,
              style: { width: `${Math.max(2, Math.round((feeUsd / max) * 100))}%` } }, 'fee'),
            jsx('div', { className: 'wm-econ-bar-fill wm-econ-usage', title: `Usage ${analyticMoney(usage)}`,
              style: { width: `${Math.max(2, Math.round((usage / max) * 100))}%` } }, 'usage')
          ] }, 'bars'),
        jsxs('span', { className: cn('wm-econ-num', difference < 0 ? 'wm-econ-negative' : 'wm-econ-positive'),
          children: [analyticMoney(difference), flags ? jsx('span', { className: 'wm-econ-dim', children: ` · ${flags}` }) : null].filter(Boolean) }, 'diff')
      ] }, 'row'),
      entry.partial && entry.difference_note
        ? jsx('div', { className: 'wm-econ-dim wm-econ-trend-note', children: entry.difference_note }, 'note')
        : null
    ].filter(Boolean) }, entry.month)
  }) })
}

const $fxDraft = atom(null)
const $fxSaving = atom(null)
const $fxNotice = atom(null)

/**
 * User-managed FX rates: list, add and remove. Saved as one document.
 * Staged edits live in $fxDraft, gated by connection identity like the
 * billing draft, so a gateway switch mid-edit cannot save stale rates.
 * The editor stays disabled until the saved document has loaded for this
 * connection: replacing rates that were never read would silently drop them.
 */
function EconomicsFx({ fxError, fxReady, identity, rates, onRetry, onSave }) {
  const rawDraft = useValue($fxDraft)
  const saving = useValue($fxSaving)?.origin === identity
  const notice = useValue($fxNotice)
  const saved = rates || []
  const draft = rawDraft?.origin === identity ? rawDraft.rates : saved
  const stage = next => $fxDraft.set({ origin: identity, rates: next })
  const add = event => {
    event.preventDefault()
    const read = name => (new FormData(event.target).get(name) || '').toString().trim()
    const currency = read('currency').toUpperCase()
    const usd = Number(read('usd_per_unit'))
    const asOf = read('as_of')
    const source = read('source')
    if (!currency || !Number.isFinite(usd) || usd <= 0 || !asOf || !source) return
    if (draft.some(r => r.currency === currency)) {
      $fxNotice.set({ tone: 'warn', origin: identity, text: `A rate for ${currency} is already staged.` })
      return
    }
    $fxNotice.set(null)
    stage([...draft, { currency, usd_per_unit: usd, as_of: asOf, source }])
    event.target.reset()
  }
  const remove = currency => stage(draft.filter(r => r.currency !== currency))
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved)
  return jsxs('div', { className: 'wm-econ-fx', children: [
    !fxReady
      ? jsxs('div', { className: 'wm-econ-fx-blocked', children: [
          jsx('p', { className: 'wm-warn-note', role: 'alert',
            children: fxError || 'Reading saved FX rates for this connection…' }),
          fxError && typeof onRetry === 'function'
            ? jsx(ProductButton, { type: 'button', className: 'wm-button', size: 'sm',
                onClick: onRetry, children: 'Retry' })
            : null
        ].filter(Boolean) })
      : null,
    fxReady && draft.length
      ? jsx('ul', { className: 'wm-econ-fx-list', children: draft.map(rate =>
          jsxs('li', { children: [
            jsx('span', { children: `${rate.currency} at ${rate.usd_per_unit} USD per unit, dated ${rate.as_of} (${rate.source})` }),
            jsx(ProductButton, { type: 'button', className: 'wm-button', size: 'sm',
              disabled: !fxReady, onClick: () => remove(rate.currency), children: 'Remove' })
          ] }, rate.currency)) })
      : null,
    fxReady && !draft.length
      ? jsx('p', { className: 'wm-subtle', children: 'No FX rates saved. Fees stay in their own currencies until you add one.' })
      : null,
    jsxs('form', { className: 'wm-econ-fx-form', onSubmit: fxReady ? add : event => event.preventDefault(), children: [
      jsx('input', { name: 'currency', placeholder: 'GBP', 'aria-label': 'Currency', maxLength: 3, disabled: !fxReady }),
      jsx('input', { name: 'usd_per_unit', placeholder: 'USD per unit, e.g. 1.27', 'aria-label': 'USD per unit',
        type: 'number', step: 'any', min: '0', disabled: !fxReady }),
      jsx('input', { name: 'as_of', 'aria-label': 'Rate date', type: 'date', disabled: !fxReady }),
      jsx('input', { name: 'source', placeholder: 'Source, e.g. Bank of England spot', 'aria-label': 'Rate source', disabled: !fxReady }),
      jsx(ProductButton, { type: 'submit', className: 'wm-button', disabled: !fxReady, children: 'Add rate' })
    ] }),
    notice?.origin === identity ? jsx('p', { className: notice.tone === 'good' ? 'wm-subtle' : 'wm-warn-note',
      role: notice.tone === 'good' ? 'status' : 'alert', children: notice.text }) : null,
    jsx('div', { className: 'wm-setting-action', children:
      jsx(ProductButton, { type: 'button', className: 'wm-button', disabled: !fxReady || !dirty || saving,
        onClick: () => onSave(draft), children: saving ? 'Saving…' : 'Save rates' }) })
  ].filter(Boolean) })
}

/**
 * Subscription economics, rendered from one report payload. Pure presentation:
 * the container owns the queries, so the harness can drive this with fixtures.
 */
function EconomicsSection({ data, fxError, fxReady, identity, fxRates, onRetryFx, onSaveFx }) {
  const headline = data?.headline || {}
  const groups = data?.groups || []
  const accounts = data?.accounts || []
  const others = data?.non_subscription_accounts || []
  const difference = finiteValue(headline.difference_usd)
  const feeLines = econFeeLines(headline.fees_monthly_by_currency)
  const span = windowSpanLabel(data?.window_days)
  const windowLines = econWindowLines(headline.fees_window_by_currency)
  return jsxs('section', { className: 'wm-product-section', 'aria-label': 'Subscription economics', children: [
    jsx('h2', { children: 'Subscription economics' }),
    jsx('p', { children: 'Subscription spending against the API-equivalent value of the usage recorded against it, over the same window. The difference is an estimated value comparison, not cash saved.' }),
    jsxs('div', { className: 'wm-product-summary', children: [
      jsxs('div', { className: 'wm-product-stat', children: [
        jsx('label', { children: 'Monthly subscriptions' }),
        jsx('strong', { children: feeLines.join(' + ') }),
        jsx('small', { children: `${windowLines.join(' + ')} ${span} · ${accounts.length} subscription(s) · ${econStatusLabel(headline.status)}` })
      ] }),
      jsxs('div', { className: 'wm-product-stat', children: [
        jsx('label', { children: 'API-equivalent usage · 30 days' }),
        jsx('strong', { children: headline.usage_usd == null ? '—' : analyticMoney(headline.usage_usd) }),
        jsx('small', { children: headline.usage_usd == null
          ? 'No priced usage is attributed to subscriptions.'
          : 'Theoretical public price of attributed usage.' })
      ] }),
      jsxs('div', { className: cn('wm-product-stat', difference != null && (difference < 0 ? 'wm-econ-negative' : 'wm-econ-positive')), children: [
        jsx('label', { children: 'Estimated value comparison' }),
        jsx('strong', { children: difference == null ? econStatusLabel(headline.status) : analyticMoney(difference) }),
        jsx('small', { children: 'API value minus fees in the same window. Not cash saved.' })
      ] })
    ] }),
    (headline.notes || []).length
      ? jsx('ul', { className: 'wm-econ-notes', children: headline.notes.map((note, i) =>
          jsx('li', { children: note }, i)) })
      : null,
    groups.length ? jsxs('div', { className: 'wm-econ-groups', children: [
      jsx('h3', { children: 'Fees vs usage by currency' }),
      ...groups.map(group => group.difference_usd == null && !group.usage_usd && group.status === 'unavailable'
        ? jsxs('div', { className: 'wm-econ-group', children: [
            jsx('strong', { children: group.currency }),
            jsx('span', { className: 'wm-econ-dim', children: ` ${fmtMoney(group.monthly_fees, group.currency)}/mo · ${(group.notes || []).join(' ') || 'No comparison available.'}` })
          ] }, group.currency)
        : jsxs('div', { className: 'wm-econ-group', children: [
            jsxs('div', { className: 'wm-econ-group-head', children: [
              jsx('strong', { children: group.currency }),
              jsx('span', { className: 'wm-econ-dim', children:
                `${fmtMoney(group.monthly_fees, group.currency)}/mo fees · ${group.window_fees == null ? '—' : fmtMoney(group.window_fees, group.currency)} in window · ${analyticMoney(group.usage_usd)} usage · ${econStatusLabel(group.status)}` })
            ] }),
            group.difference_usd == null
              ? jsx('p', { className: 'wm-subtle', children: (group.notes || []).join(' ') || 'No comparison available.' })
              : jsx(EconomicsBars, { group })
          ] }, group.currency))
    ] }) : null,
    accounts.length ? jsxs('div', { className: 'wm-econ-accounts', children: [
      jsx('h3', { children: 'Provider and account breakdown' }),
      jsx('div', { className: 'wm-econ-scroll', children:
        jsxs('table', { className: 'wm-econ-table', children: [
          jsx('thead', { children: jsx('tr', { children:
            ['Account', 'Membership', 'Monthly equiv.', 'API-equivalent usage', 'Est. value difference', 'Pricing coverage']
              .map(name => jsx('th', { children: name }, name)) }) }),
          jsx('tbody', { children: accounts.map(row =>
            jsx(EconomicsAccountRow, { row }, row.account_id)) })
        ] }) })
    ] }) : null,
    (data?.trend?.months || []).length ? jsxs('div', { className: 'wm-econ-accounts', children: [
      jsx('h3', { children: 'Monthly trend' }),
      jsx(EconomicsTrend, { trend: data.trend })
    ] }) : null,
    others.length ? jsxs('div', { className: 'wm-econ-accounts', children: [
      jsx('h3', { children: 'Not in the comparison' }),
      jsx('ul', { className: 'wm-econ-notes', children: others.map(row =>
        jsx('li', { children:
          `${row.label || row.family}: ${row.usage?.list_usd == null ? 'no priced usage' : `${analyticMoney(row.usage.list_usd)} API-equivalent usage`} · ${row.explanation}` },
        row.account_id)) })
    ] }) : null,
    (data?.unattributed?.usage?.tokens || data?.ambiguous?.usage?.tokens) ? jsxs('div', { className: 'wm-econ-accounts', children: [
      jsx('h3', { children: 'Usage outside any subscription' }),
      jsx('ul', { className: 'wm-econ-notes', children: [
        data?.unattributed?.usage?.tokens ? jsx('li', { children:
          `Unattributed: ${analyticMoney(data.unattributed.usage.list_usd)} on ${(data.unattributed.routes || []).join(', ') || 'unknown routes'}. ${data.unattributed.note}` }, 'unattributed') : null,
        data?.ambiguous?.usage?.tokens ? jsx('li', { children:
          `Ambiguous: ${analyticMoney(data.ambiguous.usage.list_usd)} claimed by more than one account; counted once, attributed to nobody.` }, 'ambiguous') : null
      ].filter(Boolean) })
    ] }) : null,
    jsxs('div', { className: 'wm-econ-accounts', children: [
      jsx('h3', { children: 'Currency conversion' }),
      jsx('p', { className: 'wm-subtle', children: 'Converted totals appear only with a dated rate you supply. No rates are fetched automatically.' }),
      jsx(EconomicsFx, { fxError, fxReady, identity, rates: fxRates || [], onRetry: onRetryFx, onSave: onSaveFx })
    ] })
  ].filter(Boolean) })
}

/** Subscription economics wired to the backend. */
function EconomicsPanel({ identity }) {
  const economics = useQuery(economicsQuery(identity))
  const fx = useQuery(fxQuery(identity))
  const current = economics.data?.identity === identity && membershipIdentityCurrent(identity)
  const fxCurrent = fx.data?.identity === identity && membershipIdentityCurrent(identity)
  const saveFx = async rates => {
    const captured = identity
    if (!membershipIdentityCurrent(captured)) return
    $fxSaving.set({ origin: captured })
    $fxNotice.set(null)
    try {
      await fxWrite(rates)
      if (!membershipIdentityCurrent(captured) || $fxDraft.get()?.origin !== captured) return
      $fxDraft.set(null)
      $fxNotice.set({ tone: 'good', origin: captured, text: 'Rates saved.' })
      await Promise.all([economics.refetch?.(), fx.refetch?.()])
    } catch (error) {
      if (membershipIdentityCurrent(captured)) {
        $fxNotice.set({ tone: 'warn', origin: captured, text: fxErrorMessage(error) })
      }
    } finally {
      // Release this save's flag even after a connection switch, so the new
      // connection's button never sticks on "Saving…".
      if ($fxSaving.get()?.origin === captured) $fxSaving.set(null)
    }
  }
  if (economics.error) {
    return jsx('section', { className: 'wm-product-section', children: keyedElementChildren([
      jsx('h2', { children: 'Subscription economics' }),
      jsx('div', { className: 'wm-alert', role: 'alert',
        children: String(economics.error.message || economics.error) })
    ], 'econ-error') })
  }
  if (!current) {
    return jsx('section', { className: 'wm-product-section', children: keyedElementChildren([
      jsx('h2', { children: 'Subscription economics' }),
      jsx('p', { className: 'wm-subtle', children: 'Reading subscription economics for this connection…' })
    ], 'econ-loading') })
  }
  const fxReady = fxCurrent && !fx.error
  const fxError = fx.error && membershipIdentityCurrent(identity)
    ? 'Saved FX rates could not be read for this connection.'
    : ''
  return jsx(EconomicsSection, { data: economics.data, identity,
    fxRates: fxReady ? fx.data?.rates || [] : [], fxReady, fxError,
    onRetryFx: () => fx.refetch?.(), onSaveFx: saveFx })
}

const ECONOMICS_CSS = [
  '.wm-product .wm-econ-notes{margin:6px 0 4px;padding-left:18px;display:grid;gap:4px;font-size:12px;line-height:1.5;color:var(--ui-text-secondary)}',
  '.wm-product .wm-econ-groups,.wm-product .wm-econ-accounts{display:grid;gap:10px;margin-top:16px}',
  '.wm-product .wm-econ-groups h3,.wm-product .wm-econ-accounts h3{margin:0;font-size:13px;font-weight:600}',
  '.wm-product .wm-econ-group{border-top:1px solid var(--ui-stroke-secondary);padding-top:10px;display:grid;gap:8px}',
  '.wm-product .wm-econ-group-head{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}',
  '.wm-product .wm-econ-group-head strong{font-size:13px}',
  '.wm-product .wm-econ-dim{color:var(--ui-text-tertiary);font-size:11px}',
  '.wm-product .wm-econ-bars{display:grid;gap:6px}',
  '.wm-product .wm-econ-bar-row{display:grid;grid-template-columns:minmax(130px,180px) minmax(0,1fr) auto;gap:10px;align-items:center}',
  '.wm-product .wm-econ-bar-label{font-size:12px;color:var(--ui-text-tertiary)}',
  '.wm-product .wm-econ-bar-track{height:10px;border-radius:5px;background:var(--ui-fill-tertiary);overflow:hidden}',
  '.wm-product .wm-econ-bar-fill{height:100%;border-radius:5px}',
  '.wm-product .wm-econ-fee{background:var(--ui-accent)}',
  '.wm-product .wm-econ-usage{background:var(--ui-success)}',
  '.wm-product .wm-econ-bar-value{font-variant-numeric:tabular-nums;font-size:12px;min-width:64px;text-align:right}',
  '.wm-product .wm-econ-scroll{overflow-x:auto}',
  '.wm-product .wm-econ-table{width:100%;border-collapse:collapse;font-size:12px;min-width:640px}',
  '.wm-product .wm-econ-table th{text-align:left;color:var(--ui-text-tertiary);font-weight:500;padding:6px 10px 6px 0;border-bottom:1px solid var(--ui-stroke-secondary);white-space:nowrap}',
  '.wm-product .wm-econ-table td{padding:9px 10px 9px 0;border-bottom:1px solid var(--ui-stroke-secondary);vertical-align:top}',
  '.wm-product .wm-econ-table tr:last-child td{border-bottom:0}',
  '.wm-product .wm-econ-table .wm-econ-num{font-variant-numeric:tabular-nums;white-space:nowrap}',
  '.wm-product .wm-econ-table th:nth-child(n+3):nth-child(-n+5),.wm-product .wm-econ-table td:nth-child(n+3):nth-child(-n+5){text-align:right}',
  '.wm-product .wm-econ-account{font-weight:550;font-size:13px}',
  '.wm-product .wm-econ-negative strong,.wm-product td.wm-econ-negative,.wm-product span.wm-econ-negative{color:var(--ui-text-primary)}',
  '.wm-product .wm-econ-positive strong,.wm-product td.wm-econ-positive,.wm-product span.wm-econ-positive{color:var(--ui-success)}',
  '.wm-product .wm-econ-trend{display:grid;gap:8px}',
  '.wm-product .wm-econ-trend-row{display:grid;grid-template-columns:64px minmax(0,1fr) auto;gap:10px;align-items:center}',
  '.wm-product .wm-econ-trend-month-block{display:grid;gap:2px}',
  '.wm-product .wm-econ-trend-note{padding-left:74px}',
  '.wm-product .wm-econ-trend-month{font-variant-numeric:tabular-nums;font-size:12px;color:var(--ui-text-tertiary)}',
  '.wm-product .wm-econ-trend-bars{display:grid;gap:3px}',
  '.wm-product .wm-econ-trend-bars .wm-econ-bar-fill{height:8px}',
  '.wm-product .wm-econ-fx{display:grid;gap:10px}',
  '.wm-product .wm-econ-fx-blocked{display:flex;flex-direction:column;gap:8px;align-items:flex-start}',
  '.wm-product .wm-econ-fx-blocked .wm-warn-note{margin:0}',
  '.wm-product .wm-econ-fx-list{list-style:none;margin:0;padding:0;display:grid;gap:6px;font-size:12px}',
  '.wm-product .wm-econ-fx-list li{display:flex;justify-content:space-between;align-items:center;gap:10px;border-top:1px solid var(--ui-stroke-secondary);padding-top:6px}',
  '.wm-product .wm-econ-fx-form{display:grid;grid-template-columns:80px minmax(0,1fr) minmax(0,1fr) minmax(0,2fr) auto;gap:8px}',
  '.wm-product .wm-econ-fx-form input{min-height:34px;border:1px solid var(--ui-stroke-secondary);border-radius:6px;padding:7px 9px;background:var(--ui-fill-primary);color:var(--ui-text-primary);font:inherit;font-size:12px;min-width:0}',
  '@container(max-width:620px){.wm-product .wm-econ-bar-row{grid-template-columns:minmax(0,1fr) auto}.wm-product .wm-econ-bar-label{grid-column:1/-1}.wm-product .wm-econ-fx-form{grid-template-columns:1fr 1fr}}'
].join('');


const $settingsConfirmation = atom(null)
const $modelRefreshState = atom(null)
const $membershipClock = atom(Date.now())

function overviewAnalyticsQuery(identity = membershipIdentityNow()) {
  return {
    queryKey: [ID, 'overview-analytics', identity],
    queryFn: async () => {
      if (!membershipIdentityCurrent(identity)) throw new Error('Connection changed.')
      if (typeof rest !== 'function') throw new Error('Analytics is unavailable.')
      const result = await rest('/analytics?days=30')
      if (!membershipIdentityCurrent(identity)) throw new Error('Connection changed.')
      if (!result?.ok || !result.totals) throw new Error(result?.error || 'Analytics is unavailable.')
      return result
    },
    retry: false, staleTime: 30_000
  }
}

function settledDesktopMonth(ledger, now = new Date()) {
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  let cost = 0
  let priced = 0
  for (const [day, buckets] of Object.entries(ledger?.days || {})) {
    if (!day.startsWith(month)) continue
    for (const bucket of Object.values(buckets || {})) {
      if (bucket?.legacy || !Number(bucket?.pricedTokens)) continue
      const value = Number(bucket?.cost)
      if (!Number.isFinite(value)) continue
      cost += value
      priced += Number(bucket.pricedTokens)
    }
  }
  return { known: priced > 0, cost, pricedTokens: priced }
}

function OverviewPage() {
  const identity = useValue($membershipIdentity)
  const analytics = useQuery(overviewAnalyticsQuery(identity))
  const accounts = useQuery(membershipQuery(false, identity))
  const economics = useQuery(economicsQuery(identity))
  const ledger = useValue($ledger)
  const accountsReady = accounts.data?.identity === identity && membershipIdentityCurrent(identity)
  const currentAccounts = accountsReady
    ? membershipAccounts({ accounts: accounts.data.accounts }) : []
  const fees = membershipSummary(currentAccounts)
  const local = settledDesktopMonth(ledger)
  const result = analytics.data?.totals || {}
  const econReady = economics.data?.identity === identity && membershipIdentityCurrent(identity)
  const econHeadline = econReady ? economics.data?.headline || {} : {}
  const econDifference = finiteValue(econHeadline.difference_usd)
  return jsxs('div', { className: 'wm-analytics wm-product', children: [
    jsx('style', { children: ANALYTICS_CSS + PRODUCT_CSS + ECONOMICS_CSS }),
    jsx(LedgerTabs, {}),
    jsxs('main', { className: 'wm-shell', children: [
      jsxs('header', { className: 'wm-product-heading', children: [
        jsxs('div', { children: [jsx('h1', { children: 'Overview' }),
          jsx('p', { children: 'A quick view of recorded costs, estimates and the memberships you have declared.' })] })
      ] }),
      analytics.error ? jsx('div', { className: 'wm-alert', role: 'alert',
        children: String(analytics.error.message || analytics.error) }) : null,
      jsx('section', { className: 'wm-product-summary', children: [
        jsx('div', { className: 'wm-product-stat', children: [
          jsx('label', { children: 'Desktop-recorded this month' }),
          jsx('strong', { children: local.known ? fmtUsd(local.cost) : '—' }),
          jsx('small', { children: local.known
            ? 'Settled at the rates captured when each usage delta was recorded.'
            : 'No priced Desktop cost is available for this month.' })
        ] }),
        jsx('div', { className: 'wm-product-stat', children: [
          jsx('label', { children: 'Backend API-equivalent · 30 days' }),
          jsx('strong', { children: result.list_usd == null ? '—' : fmtUsd(result.list_usd) }),
          jsx('small', { children: analytics.isLoading && !analytics.data
            ? 'Reading backend usage…'
              : analytics.error && !analytics.data
              ? 'Backend usage could not be read for this connection.'
              : !analytics.data
                ? 'Backend usage data is not available for this connection.'
                : result.calls === 0
                ? 'No backend calls recorded in the last 30 days.'
                : 'Estimate at the current available catalogue; not a historical charge.' })
        ] }),
        jsx('div', { className: 'wm-product-stat', children: [
          jsx('label', { children: 'Declared membership fees' }),
          jsx('strong', { children: accountsReady ? feesLabel(fees) : '—' }),
          jsx('small', { children: accountsReady
            ? fees.withPlan + ' saved plan(s) across ' + fees.total + ' account(s).'
            : accounts.error ? 'Memberships could not be read for this connection.'
              : 'Reading memberships for this connection…' })
        ] }),
        jsx('div', { className: cn('wm-product-stat', econDifference != null && econDifference >= 0 && 'wm-econ-positive'), children: [
          jsx('label', { children: 'Subscription value · 30 days' }),
          jsx('strong', { children: !econReady ? '—'
            : econDifference == null ? econStatusLabel(econHeadline.status) : analyticMoney(econDifference) }),
          jsx('small', { children: !econReady
            ? economics.error ? 'Subscription economics could not be read for this connection.'
              : 'Reading subscription economics…'
            : econDifference == null
              ? (econHeadline.notes || [])[0] || 'No comparison is available. See Costs.'
              : `${econFeeLines(econHeadline.fees_monthly_by_currency).join(' + ')} · ` +
                `${econWindowLines(econHeadline.fees_window_by_currency).join(' + ')} ${windowSpanLabel(economics.data?.window_days)} · ` +
                `${analyticMoney(econHeadline.usage_usd)} usage. See Costs.` })
        ] })
      ] }),
      (() => {
        const items = accountsReady ? needsAttention(currentAccounts) : []
        const unpriced = Number(result.unpriced_tokens || 0)
        return jsxs('div', { className: 'wm-product-section', children: [
          jsx('h2', { children: items.length || unpriced ? 'Needs attention' : 'Continue' }),
          items.length
            ? jsx('ul', { className: 'wm-overview-attention', children: items.slice(0, 5).map((item, index) =>
                jsx('li', { children: `${item.account.label || item.account.family}: ${item.text}` }, index)) })
            : jsx('p', { children: accountsReady
                ? 'Nothing needs confirming right now. Usage shows Hermes analytics, Costs brings estimates and declared memberships together, and Memberships is where plans and fees live.'
                : 'Usage shows Hermes analytics, Costs brings estimates and declared memberships together, and Memberships is where plans and fees live.' }),
          unpriced ? jsx('p', { className: 'wm-subtle', children: unpriced.toLocaleString('en-GB') + ' tokens in the last 30 days have no published price, so API-equivalent totals are partial. See Usage for coverage.' }) : null,
          jsx('div', { className: 'wm-setting-action', children: [
            items.length ? jsx(ProductButton, { className: 'wm-button wm-accent', onClick: () => goLedgerTab('memberships'), children: 'Review memberships' }) : null,
            jsx(ProductButton, { className: 'wm-button', onClick: () => goLedgerTab('usage'), children: 'Open Usage' }),
            jsx(ProductButton, { className: 'wm-button', onClick: () => goLedgerTab('costs'), children: 'Open Costs' }),
            items.length ? null : jsx(ProductButton, { className: 'wm-button', onClick: () => goLedgerTab('memberships'), children: 'Manage memberships' })
          ].filter(Boolean) })
        ] })
      })()
    ] })
  ] })
}

function SettingsPage() {
  const identity = useValue($membershipIdentity)
  const status = useQuery(pricingStatusQuery(identity))
  const planCatalogue = useQuery(membershipPlansQuery(identity))
  const health = useQuery({
    queryKey: [ID, 'health', identity],
    queryFn: async () => {
      if (!membershipIdentityCurrent(identity)) throw new Error('Connection changed.')
      const result = await rest('/health')
      if (!membershipIdentityCurrent(identity)) throw new Error('Connection changed.')
      if (!result?.ok) throw new Error(result?.error || 'Health check failed.')
      return result
    },
    retry: false, staleTime: 30_000
  })
  const confirmation = useValue($settingsConfirmation)
  const refreshState = useValue($modelRefreshState)
  const automaticModelOptions = useValue($automaticModelOptions)
  const liveConfirmation = confirmation?.origin === identity ? confirmation : null
  const liveRefresh = refreshState?.origin === identity ? refreshState : null
  const [clock] = [useValue($membershipClock)]

  const copyRecovery = async () => {
    const captured = identity
    if (!membershipIdentityCurrent(captured)) return
    try {
      const [accountDoc, profileDoc] = await Promise.all([
        rest('/membership/accounts'), rest('/billing/profiles')
      ])
      if (!membershipIdentityCurrent(captured)) return
      if (!Array.isArray(accountDoc?.accounts) || accountDoc?.store?.error ||
          !Array.isArray(profileDoc?.profiles) || profileDoc?.error) {
        throw new Error('The user-data export is incomplete.')
      }
      const bundle = {
        product: 'Spend Sense',
        version: PLUGIN_VERSION,
        exported_at: new Date().toISOString(),
        note: 'This contains only Spend Sense membership and advanced-rule data. It contains no provider credential secrets or recorded usage ledger.',
        memberships: accountDoc.accounts,
        advanced_rules: profileDoc.profiles
      }
      const copied = await writeClipboard(JSON.stringify(bundle, null, 2))
      if (!membershipIdentityCurrent(captured)) return
      if (!copied) throw new Error('Clipboard access was unavailable.')
      $settingsConfirmation.set({ origin: captured, stage: 'data-copied' })
    } catch (error) {
      if (membershipIdentityCurrent(captured)) {
        $modelRefreshState.set({ origin: captured, tone: 'warn',
          text: String(error.message || error) })
      }
    }
  }

  const resetPreferences = () => {
    if (!liveConfirmation || liveConfirmation.stage !== 'reset-preferences' ||
        !membershipIdentityCurrent(identity)) {
      $settingsConfirmation.set({ origin: identity, stage: 'reset-preferences' })
      return
    }
    try {
      for (const key of ['range', 'view', 'group', 'basis', 'automatic-model-options']) storage?.delete?.(key)
      $range.set('today')
      $view.set(VIEW_ALL)
      $group.set('route')
      $basis.set('hybrid')
      $automaticModelOptions.set(false)
      $settingsConfirmation.set(null)
      $modelRefreshState.set({ origin: identity, tone: 'good',
        text: 'Spend Sense display preferences were reset. Hermes saved pane placement is unchanged.' })
    } catch (error) {
      $modelRefreshState.set({ origin: identity, tone: 'warn',
        text: 'Preferences could not be reset: ' + String(error.message || error) })
    }
  }

  const resetUserData = async () => {
    if (!liveConfirmation || liveConfirmation.stage !== 'data-copied' ||
        !membershipIdentityCurrent(identity)) return
    const captured = identity
    try {
      const result = await rest('/settings/reset-user-data', {
        method: 'POST', body: { confirm: 'RESET_USER_ENTERED_DATA' }
      })
      if (!membershipIdentityCurrent(captured) || !result?.ok) return
      $settingsConfirmation.set(null)
      $membershipSnapshot.set({ identity: captured, accounts: [], store: { loaded: true, error: '' }, notes: [] })
      await queryClient.invalidateQueries({ queryKey: [ID, 'membership-accounts', captured] })
      await queryClient.invalidateQueries({ queryKey: [ID, 'billing-profiles', captured] })
      await invalidateEconomicsFor(captured)
      $modelRefreshState.set({ origin: captured, tone: 'good',
        text: 'Memberships and advanced billing rules were cleared for this profile. Captured usage records were retained.' })
    } catch (error) {
      if (membershipIdentityCurrent(captured)) $modelRefreshState.set({
        origin: captured, tone: 'warn', text: 'User-entered data was not reset: ' + String(error.message || error)
      })
    }
  }

  const refreshModels = async () => {
    if (!liveRefresh || !membershipIdentityCurrent(identity)) {
      $modelRefreshState.set({ origin: identity, stage: 'confirm-models' })
      return
    }
    const captured = identity
    try {
      const sessionId = host.state.focusedSessionId?.get?.() || null
      const model = host.state.model?.get?.() || ''
      const params = { refresh: true, ...(sessionId ? { session_id: sessionId } : {}) }
      const result = await host.request('model.options', params)
      if (!membershipIdentityCurrent(captured)) return
      const query = catalogQuery(sessionId, model)
      queryClient.setQueryData(query.queryKey, result)
      if (!sessionId) queryClient.setQueryData(catalogQuery(null).queryKey, result)
      $modelRefreshState.set({ origin: captured, tone: 'good',
        text: 'Hermes model availability was refreshed. This does not force a pricing catalogue refresh.' })
      $settingsConfirmation.set(null)
    } catch (error) {
      if (membershipIdentityCurrent(captured)) $modelRefreshState.set({ origin: captured, tone: 'warn',
        text: 'Hermes could not refresh model availability: ' + String(error.message || error) })
    }
  }

  const pricing = status.data
  const membershipBook = planCatalogue.data?.identity === identity && membershipIdentityCurrent(identity)
    ? planCatalogue.data : null
  const last = health.data
  return jsxs('div', { className: 'wm-analytics wm-product', children: [
    jsx('style', { children: ANALYTICS_CSS + PRODUCT_CSS }),
    jsx(LedgerTabs, {}),
    jsxs('main', { className: 'wm-shell', children: [
      jsxs('header', { className: 'wm-product-heading', children: [
        jsxs('div', { children: [jsx('h1', { children: 'Settings & About' }),
          jsx('p', { children: 'Privacy, pricing provenance, diagnostics and recovery.' })] })
      ] }),
      jsxs('div', { className: 'wm-settings-grid', children: keyedElementChildren([
        jsxs('section', { className: 'wm-product-section', children: [
          jsx('h2', { children: 'External data and privacy' }),
          jsx('p', { children: 'Spend Sense makes no direct HTTP pricing requests. It reads Hermes model-pricing metadata when available and falls back to its bundled offline rate snapshot. Membership plans are bundled; user-defined plans stay in your plugin data.' }),
          jsx('p', { children: 'Automatic Hermes model-options refresh is off by default. When enabled, the live pane asks Hermes for current options on session/model changes and every 15 minutes. Hermes may refresh public models.dev metadata or make authenticated requests to configured provider endpoints using credentials it manages. Membership discovery parses Hermes authentication storage to count configured credential slots; it does not return or log credential values.' }),
          jsx('p', { children: 'Spend Sense stores accounting metadata, membership choices, fee history, custom plan details, and optional user-reported exhaustion marks. It does not collect prompts, responses or telemetry. The plugin backend uses its existing profile-specific plugin data.' }),
          jsx('p', { children: 'With automatic refresh off, the plugin uses options already cached in this Desktop session and bundled rates. If a route is uncertain, it may use a clearly labelled fallback estimate or remain unpriced; it is never presented as a confirmed provider price. Account discovery and account readings remain user-triggered.' })
        ] }),
        jsxs('section', { className: 'wm-product-section', children: [
          jsx('h2', { children: 'Pricing provenance and freshness' }),
          status.error ? jsx('p', { className: 'wm-warn-note', children: 'Pricing status is unavailable. Hermes’ cache or the bundled offline snapshot can still be used.' }) : null,
          pricing ? jsxs('p', { children: [
            'Source: ', jsx('strong', { children: pricing.source || 'unavailable' }),
            pricing.as_of ? ' · snapshot/cache date: ' + new Date(pricing.as_of).toLocaleString() : ' · date unavailable',
            pricing.age_seconds != null ? ' · ' + Math.round(pricing.age_seconds / 3600) + ' h old' : '',
            pricing.stale ? ' · stale' : ''
          ] }) : null,
          jsx('p', { className: 'wm-subtle', children: 'Refreshing this status only rereads the backend metadata. It does not trigger an external pricing fetch.' }),
          jsx(ProductButton, { type: 'button', className: 'wm-button', disabled: status.isFetching,
            onClick: () => status.refetch?.(), children: status.isFetching ? 'Checking…' : 'Refresh pricing status' }),
          jsxs('p', { children: [
            'Captured Desktop costs retain the rates applied when recorded. Backend API-equivalent values are estimates recalculated using the current available prices; they are not historical charges.'
          ] }),
          jsx('p', { children: 'No WolfMark-hosted membership catalogue is published. A future optional, versioned feed would need schema validation, provenance, offline caching and rollback; this build uses the bundled plans.' }),
          membershipBook ? jsxs('div', { className: 'wm-note', children: [
            jsx('p', { children: 'Bundled membership catalogue ' + membershipBook.catalogue_version +
              (membershipBook.generated_at ? ' · generated ' + new Date(membershipBook.generated_at).toLocaleString() : '') }),
            jsxs('p', { children: [membershipBook.totals?.plans || 0, ' plans · ',
              membershipBook.totals?.verified || 0, ' verified prices · ',
              membershipBook.totals?.provisional || 0, ' provisional · ',
              membershipBook.totals?.placeholders || 0, ' without a published fee'] }),
            jsx('details', { children: [
              jsx('summary', { children: 'Bundled source register' }),
              jsx('ul', { children: (membershipBook.sources || []).map(source => jsx('li', { children: [
                source.id + ' · ' + source.evidence_kind + ' · ' + (source.retrieved_at || 'retrieval date not recorded') + ' · ',
                jsx('a', { href: source.url, target: '_blank', rel: 'noreferrer', children: source.url })
              ] }, source.id)) })
            ] })
          ] }) : planCatalogue.error ? jsx('p', { className: 'wm-warn-note', children: 'Bundled membership catalogue provenance is unavailable.' }) : null
        ] }),
        jsx(AdvancedBillingRules, {}),
        jsxs('section', { className: 'wm-product-section', children: [
          jsx('h2', { children: 'Hermes model availability' }),
          jsx('p', { children: 'This refresh asks Hermes to refresh the current profile’s model list. Hermes may probe configured provider endpoints using credentials managed by Hermes.' }),
          jsx('label', { className: 'wm-setting-toggle', children: [
            jsx('input', { type: 'checkbox', checked: automaticModelOptions,
              onChange: event => $automaticModelOptions.set(Boolean(event.target.checked)) }),
            jsx('span', { children: 'Allow automatic Hermes model-options refresh for live pricing. Off by default; when off, cached options and bundled/offline rates are used, with uncertain routes labelled or left unpriced.' })
          ] }),
          liveRefresh?.stage === 'confirm-models'
            ? jsx('div', { className: 'wm-confirm-box', children: [
                jsx('p', { role: 'alert', children: 'This can make authenticated requests to configured providers. Continue with the current Hermes profile?' }),
                jsx(ProductButton, { type: 'button', className: 'wm-button', onClick: refreshModels, children: 'Confirm model refresh' }),
                jsx(ProductButton, { type: 'button', className: 'wm-button', onClick: () => $modelRefreshState.set(null), children: 'Cancel' })
              ] })
            : jsx(ProductButton, { type: 'button', className: 'wm-button', onClick: refreshModels, children: 'Refresh Hermes models' }),
          liveRefresh?.text ? jsx('p', { className: liveRefresh.tone === 'warn' ? 'wm-warn-note' : 'wm-subtle',
            role: 'status', children: liveRefresh.text }) : null
        ] }),
        jsxs('section', { className: 'wm-product-section', children: [
          jsx('h2', { children: 'Diagnostics' }),
          jsx('p', { children: 'Plugin version ' + PLUGIN_VERSION + ' · ' +
            (last?.version ? 'backend version ' + last.version : health.isPending ? 'checking backend…' : 'backend status unavailable') }),
          health.error ? jsx('p', { className: 'wm-warn-note', role: 'status',
            children: 'Backend health check failed: ' + String(health.error.message || health.error) }) : null,
          last ? jsx('p', { children: last.ok ? 'Backend health: ready' : 'Backend health: usage database unavailable' }) : null,
          jsx('details', { className: 'wm-note', children: [
            jsx('summary', { children: 'Recent request diagnostics' }),
            membershipDiagnostics.length
              ? jsx('ul', { children: membershipDiagnostics.map((entry, index) => jsx('li', {
                  children: `${entry.at} · ${entry.method} ${entry.path} · ${entry.status ?? entry.outcome} · ${entry.scope}`
                }, index)) })
              : jsx('p', { children: 'No membership requests recorded in this session.' })
          ] }),
          jsx('p', { className: 'wm-subtle', children: 'Diagnostics contain only method, relative path, status, profile scope and time. They do not include tokens, headers, credential values, or request bodies.' })
        ] }),
        jsxs('section', { className: 'wm-product-section', children: [
          jsx('h2', { children: 'Display and recovery' }),
          jsx('p', { children: 'Resetting display preferences affects only Spend Sense filters and view mode. Hermes pane placement is stored by Hermes and remains as you set it.' }),
          liveConfirmation?.stage === 'reset-preferences'
            ? jsx('div', { className: 'wm-confirm-box', children: [
                jsx('p', { role: 'alert', children: 'Reset the Spend Sense display preferences to their defaults?' }),
                jsx(ProductButton, { type: 'button', className: 'wm-button', onClick: resetPreferences, children: 'Confirm preference reset' }),
                jsx(ProductButton, { type: 'button', className: 'wm-button', onClick: () => $settingsConfirmation.set(null), children: 'Cancel' })
              ] })
            : jsx(ProductButton, { type: 'button', className: 'wm-button',
                onClick: () => $settingsConfirmation.set({ origin: identity, stage: 'reset-preferences' }),
                children: 'Reset display preferences' }),
          jsx('p', { children: 'User-data recovery covers Memberships and advanced billing rules only. It leaves the captured Desktop usage ledger, Hermes data and provider credentials untouched.' }),
          liveConfirmation?.stage === 'data-copied'
            ? jsx('div', { className: 'wm-confirm-box', children: [
                jsx('p', { role: 'alert', children: 'A backup was copied to your clipboard. Save it somewhere secure before clearing profile membership and advanced-rule data.' }),
                jsx(ProductButton, { type: 'button', className: 'wm-button', onClick: resetUserData, children: 'Confirm and clear user-entered data' }),
                jsx(ProductButton, { type: 'button', className: 'wm-button', onClick: () => $settingsConfirmation.set(null), children: 'Cancel' })
              ] })
            : jsx(ProductButton, { type: 'button', className: 'wm-button',
                onClick: copyRecovery, children: 'Copy recovery backup before reset' })
        ] }),
        jsxs('section', { className: 'wm-product-section', children: [
          jsx('h2', { children: 'About and support' }),
          jsx(BrandMark, { size: 32, id: 'about' }),
          jsx('p', { children: 'Spend Sense ' + PLUGIN_VERSION }),
          jsx('p', { children: '© 2026 WolfMark Ltd. Includes software by AFei (IT-dreamer/token-cost-meter), under Apache License 2.0. See the bundled NOTICE and licences.' }),
          jsx('p', { children: 'Support and product information are available from WolfMark.' }),
          jsx('a', { href: 'https://wolfmark.co.uk/contact', target: '_blank', rel: 'noreferrer',
            className: 'wm-source-link', children: 'Contact WolfMark support' }),
          jsx('p', { className: 'wm-subtle', children: 'The bundled pricing and membership catalogue is maintained through normal reviewed plugin releases. No user-defined plan is overwritten by a catalogue update.' })
        ] })
      ], 'settings-grid') }),
      liveRefresh?.tone === 'warn' && !liveRefresh.stage
        ? jsx('div', { className: 'wm-alert', role: 'status', children: liveRefresh.text }) : null,
          jsx('p', { className: 'wm-subtle', children: 'The Spend Sense pane can be dragged to the left or right using Hermes’ supported layout controls. Hermes remembers your placement across reloads.' })
    ] })
  ] })
}

/* --------------------------------------------------------- all hermes view */

/** Backend query for the authoritative ledger. `rest` is ctx.rest (scoped). */
function backendQuery(days, basis, identity = membershipIdentityNow()) {
  return {
    queryKey: [ID, 'ledger', identity, days, basis],
    queryFn: async () => {
      if (!membershipIdentityCurrent(identity)) throw new Error('Connection changed.')
      if (typeof rest !== 'function') {
        throw new Error('This desktop build has no plugin backend bridge (ctx.rest).')
      }
      const result = await rest(`/ledger?days=${days}&basis=${encodeURIComponent(basis)}`)
      if (!membershipIdentityCurrent(identity)) throw new Error('Connection changed.')
      return { ...result, identity }
    },
    retry: false,
    staleTime: 30_000
  }
}

function ViewToggle({ t, view }) {
  return jsx(SegmentedControl, {
    onChange: v => $view.set(v),
    options: [
      { id: VIEW_ALL, label: t('viewAll') },
      { id: VIEW_DESKTOP, label: t('viewDesktop') }
    ],
    value: view
  })
}

function RangeToggle({ t, range }) {
  return jsx(SegmentedControl, {
    onChange: v => $range.set(v),
    options: ['today', 'week', 'month', 'all'].map(id => ({ id, label: t(`range_${id}`) })),
    value: range
  })
}

function BasisToggle({ t, basis }) {
  return jsx(SegmentedControl, {
    onChange: v => $basis.set(v),
    options: ['hybrid', 'billed', 'list'].map(id => ({ id, label: t(`basis_${id}`) })),
    value: basis
  })
}

function CloseButton({ t }) {
  return jsx(Tip, {
    label: t('closeTip'),
    children: jsx(Button, {
      'aria-label': t('close'),
      onClick: closeLedger,
      size: 'icon-sm',
      variant: 'ghost',
      children: jsx(Codicon, { name: 'close' })
    })
  })
}

function Stat({ hint, label, value, warn }) {
  return jsxs('div', {
    className: 'rounded-md border border-(--ui-stroke-secondary) p-3',
    children: [
      jsx('div', { className: 'text-[0.6875rem] text-(--ui-text-quaternary)', children: label }),
      jsx('div', {
        className: cn('text-lg font-semibold tabular-nums', warn ? 'text-(--ui-warning)' : ''),
        children: value
      }),
      hint ? jsx('div', { className: 'text-[0.625rem] text-(--ui-text-quaternary)', children: hint }) : null
    ].filter(Boolean)
  })
}

function GroupTable({ group, rows, t }) {
  const head = [t('groupName'), t('tokens'), t('calls'), t('billed'), t('list'), t('basis'), t('status')]
  const cells = row => {
    const subtitle =
      group === 'model' ? row.provider : group === 'route' ? `${row.models ? row.models.length : 0} ${t('models')}` : ''
    const list = row.list_usd == null
      ? t('unpriced')
      : `${row.list_usd_upper > row.list_usd ? '≥ ' : ''}${fmtUsd(row.list_usd)}`
    return [
      jsxs('td', {
        className: 'py-1.5 pr-3',
        children: [
          jsx('div', { children: row.name }),
          subtitle ? jsx('div', { className: 'text-[0.625rem] text-(--ui-text-quaternary)', children: subtitle }) : null
        ].filter(Boolean)
      }),
      jsx('td', { className: 'py-1.5 pr-3 text-right tabular-nums', children: fmtTokens(row.tokens) }),
      jsx('td', { className: 'py-1.5 pr-3 text-right tabular-nums text-(--ui-text-tertiary)', children: String(row.calls || 0) }),
      jsx('td', {
        className: cn('py-1.5 pr-3 text-right tabular-nums',
          row.billed_usd == null ? 'text-(--ui-text-quaternary)' : ''),
        children: row.billed_usd == null ? t('unknown') : fmtUsd(row.billed_usd)
      }),
      jsx('td', {
        className: cn('py-1.5 pr-3 text-right tabular-nums',
          row.list_usd == null ? 'text-(--ui-warning)' : ''),
        children: list
      }),
      jsx('td', { className: 'py-1.5 pr-3 text-right tabular-nums text-(--ui-accent)', children: fmtUsd(row.basis_usd) }),
      jsx('td', {
        className: cn('py-1.5 text-right text-[0.625rem]',
          row.status === 'complete' ? 'text-(--ui-text-quaternary)' : 'text-(--ui-warning)'),
        children: t(`status_${row.status}`) || row.status
      })
    ]
  }
  return jsxs('table', {
    className: 'w-full text-xs',
    children: [
      jsx('thead', {
        children: jsx('tr', {
          children: head.map((label, i) =>
            jsx('th', {
              className: cn('pb-1.5 font-medium text-(--ui-text-quaternary)',
                i === 0 ? 'pr-3 text-left' : i === head.length - 1 ? 'text-right' : 'pr-3 text-right'),
              children: label
            }, label)
          )
        })
      }),
      jsx('tbody', {
        children: rows.map((row, i) =>
          jsx('tr', { className: 'border-b border-(--ui-stroke-secondary) align-top', children: cells(row) }, `${i}`)
        )
      })
    ]
  })
}

function reconciliationText(t, r) {
  if (!r || !r.status) return ''
  if (r.status === 'no_baseline') return t('noBaseline')
  if (r.status === 'state_db_unavailable') return t('stateUnavailable')
  if (r.delta_tokens == null) return ''
  if (r.delta_tokens === 0) return t('noGrowth')
  if (r.gap_tokens > 0) return t('reconcileGap', fmtTokens(r.gap_tokens), fmtTokens(r.delta_tokens))
  if (r.status === 'overcount') return t('reconcileOver', fmtTokens(Math.abs(r.gap_tokens)))
  return t('reconciled', fmtTokens(r.captured_tokens), fmtTokens(r.delta_tokens))
}

function LegacyAllHermesPage({ range }) {
  const t = usePluginI18n(ID)
  const view = useValue($view)
  const group = useValue($group)
  const basis = useValue($basis)
  const days = RANGE_DAYS[range] || 30
  const { data, error, isLoading, isFetching, refetch } = useQuery({
    ...backendQuery(days, basis),
    refetchInterval: 60_000
  })

  const totals = data && data.totals ? data.totals : null
  const rows = data && Array.isArray(data[`by_${group}`]) ? data[`by_${group}`] : []
  const rateCard = data && data.rate_card ? data.rate_card : null

  const header = jsxs('div', {
    className: 'flex flex-wrap items-center justify-between gap-3',
    children: [
      jsx('h1', { className: 'text-base font-semibold', children: t('allHermesTitle') }),
      jsxs('div', {
        className: 'flex flex-wrap items-center gap-2',
        children: [jsx(ViewToggle, { t, view }), jsx(RangeToggle, { t, range }), jsx(BasisToggle, { t, basis }), jsx(CloseButton, { t })]
      })
    ]
  })

  if (error) {
    return jsxs('div', {
      className: 'mx-auto flex w-full max-w-3xl flex-col gap-4 p-6',
      children: [
        header,
        jsxs('div', {
          className: 'rounded-md border border-(--ui-warning) p-4 text-xs',
          children: [
            jsx('div', { className: 'mb-2 font-medium text-(--ui-warning)', children: t('backendUnavailable') }),
            jsx('div', { className: 'mb-3 text-(--ui-text-tertiary)', children: String(error.message || error) }),
            jsxs('div', {
              className: 'flex flex-wrap gap-2',
              children: [
                jsx(Button, { onClick: () => refetch(), size: 'sm', variant: 'outline', children: t('backendRetry') }),
                jsx(Button, { onClick: () => $view.set(VIEW_DESKTOP), size: 'sm', variant: 'ghost', children: t('backendUseDesktop') })
              ]
            })
          ]
        })
      ]
    })
  }

  if (isLoading && !data) {
    return jsxs('div', {
      className: 'mx-auto flex w-full max-w-3xl flex-col gap-4 p-6',
      children: [header, jsx('div', { className: 'text-xs text-(--ui-text-quaternary)', children: t('backendLoading') })]
    })
  }

  const billingMix = totals && totals.billing_tokens
    ? Object.entries(totals.billing_tokens)
        .filter(([, n]) => n > 0)
        .map(([kind, n]) => `${t(`class_${kind}`)} ${fmtTokens(n)}`)
        .join(' · ')
    : ''
  const rec = data && data.recording ? data.recording : null
  const recon = data && data.reconciliation ? data.reconciliation : null
  const baseline = data && data.baseline ? data.baseline : null
  const baselineTotals = baseline && baseline.totals ? baseline.totals : null
  const eventInfo = data && data.events ? data.events : null
  const coverage = totals ? Math.round((totals.coverage || 0) * 1000) / 10 : 0

  return jsxs('div', {
    className: 'mx-auto flex w-full max-w-3xl flex-col gap-4 p-6',
    children: [
      header,
      jsx('div', { className: 'text-xs text-(--ui-text-quaternary)', children: t('allHermesHint') }),
      totals
        ? jsxs('div', {
            className: 'grid grid-cols-2 gap-3 sm:grid-cols-4',
            children: [
              jsx(Stat, {
                label: t('statList'),
                value: totals.list_usd == null ? '—' : fmtUsd(totals.list_usd),
                hint: t('perCallExact')
              }),
              jsx(Stat, {
                label: t('statBilled'),
                value: totals.billed_usd == null ? '—' : fmtUsd(totals.billed_usd),
                hint: billingMix || t('billedPartial'),
                warn: totals.billed_usd == null
              }),
              jsx(Stat, {
                label: t('statCalls'),
                value: String(totals.calls || 0),
                hint: eventInfo ? t('eventsLine', eventInfo.calls, eventInfo.failures, eventInfo.missing_usage) : null
              }),
              jsx(Stat, {
                label: t('statCoverage'),
                value: `${coverage}%`,
                hint: totals.unpriced_tokens ? t('unpricedTokens', fmtTokens(totals.unpriced_tokens)) : null,
                warn: coverage < 99
              })
            ]
          })
        : null,
      jsxs('div', {
        className: 'flex flex-col gap-1 text-[0.6875rem] text-(--ui-text-quaternary)',
        children: [
          jsx('div', {
            children: rec && rec.since
              ? t('recordedSince', String(rec.since).slice(0, 19).replace('T', ' '))
              : t('notRecordingYet')
          }),
          recon
            ? jsx('div', {
                className: recon.gap_tokens > 0 ? 'text-(--ui-warning)' : '',
                children: reconciliationText(t, recon)
              })
            : null,
          eventInfo
            ? jsx('div', {
                children: t('eventsLine', eventInfo.calls, eventInfo.failures, eventInfo.missing_usage)
              })
            : null
        ].filter(Boolean)
      }),
      rateCard
        ? jsx('div', {
            className: 'text-[0.6875rem] text-(--ui-text-quaternary)',
            children: t('rateCard', rateCard.source, rateCard.as_of ? String(rateCard.as_of).slice(0, 10) : '')
          })
        : null,
      jsx(SegmentedControl, {
        onChange: v => $group.set(v),
        options: GROUPINGS.map(id => ({ id, label: t(`group_${id}`) })),
        value: group
      }),
      rows.length
        ? jsx(GroupTable, { group, rows, t })
        : jsx('div', {
            className: 'rounded-md border border-(--ui-stroke-secondary) p-6 text-center text-xs text-(--ui-text-quaternary)',
            children: t('allHermesEmpty')
          }),
      data && data.unpriced && data.unpriced.length
        ? jsxs('div', {
            className: 'rounded-md border border-(--ui-warning) p-3 text-xs',
            children: [
              jsx('div', { className: 'mb-1 font-medium text-(--ui-warning)', children: t('unpricedTitle') }),
              ...data.unpriced.slice(0, 6).map((u, i) =>
                jsx('div', { className: 'text-(--ui-text-tertiary)', children: t('unpricedLine', u.provider, u.model, fmtTokens(u.tokens), u.reason) }, `${i}`)
              )
            ]
          })
        : null,
      baselineTotals
        ? jsxs('details', {
            className: 'rounded-md border border-(--ui-stroke-secondary) p-3 text-xs',
            children: [
              jsx('summary', { className: 'cursor-pointer font-medium', children: t('baselineTitle') }),
              jsxs('div', {
                className: 'mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3',
                children: [
                  jsx(Stat, { label: t('baselineTokens'), value: fmtTokens(baselineTotals.tokens) }),
                  jsx(Stat, {
                    label: t('statList'),
                    value: baselineTotals.list_usd == null ? '—' : `${fmtUsd(baselineTotals.list_usd)} est.`
                  }),
                  jsx(Stat, {
                    label: t('statBilled'),
                    value: baselineTotals.billed_usd == null ? '—' : fmtUsd(baselineTotals.billed_usd),
                    warn: !baselineTotals.billed_complete
                  })
                ]
              }),
              baseline.note
                ? jsx('p', { className: 'mt-2 text-[0.6875rem] text-(--ui-text-quaternary)', children: baseline.note })
                : null,
              baseline.by_route && baseline.by_route.length
                ? jsx('div', {
                    className: 'mt-2 flex flex-col gap-0.5 text-[0.6875rem] text-(--ui-text-tertiary)',
                    children: baseline.by_route.slice(0, 5).map((r, i) =>
                      jsx('div', {
                        children: t('baselineRouteLine', r.name, fmtTokens(r.tokens),
                          r.list_usd == null ? t('unpriced') : fmtUsd(r.list_usd),
                          r.billed_usd == null ? t('unknown') : fmtUsd(r.billed_usd))
                      }, `${i}`)
                    )
                  })
                : null
            ]
          })
        : null,
      data && data.limits && data.limits.length
        ? jsxs('details', {
            className: 'rounded-md border border-(--ui-stroke-secondary) p-3 text-[0.6875rem] text-(--ui-text-quaternary)',
            children: [
              jsx('summary', { className: 'cursor-pointer', children: t('limitsTitle') }),
              jsx('ul', {
                className: 'mt-2 list-disc space-y-1 pl-4',
                children: data.limits.map((line, i) => jsx('li', { children: line }, `${i}`))
              })
            ]
          })
        : null,
      jsxs('div', {
        className: 'flex flex-wrap items-center gap-2',
        children: [
          jsx(Button, { disabled: isFetching, onClick: () => refetch(), size: 'sm', variant: 'outline', children: t('refresh') }),
          jsx(Button, { onClick: () => $view.set(VIEW_DESKTOP), size: 'sm', variant: 'ghost', children: t('backendUseDesktop') })
        ]
      })
    ].filter(Boolean)
  })
}

/* ------------------------------------------------------------ memberships */

/**
 * Membership pane state. Kept in atoms like the rest of the file so a commit
 * re-renders without adding React hooks the host may not export.
 */
const $membershipDraft = atom(null)
const $customPlanDraft = atom(null)
const $exhaustionDraft = atom(null)
const $membershipNotice = atom(null)
const $membershipBusy = atom('')
/** Read account usage through Hermes on the next fetch. */
const $membershipNative = atom(false)
const $membershipAttentionOnly = atom(false)
/**
 * Last good account payload. A refetch with a new query key unmounts the cards
 * for a moment; rendering from this keeps the pane from flashing "no memberships"
 * and stops a click racing an empty list.
 */
const $membershipSnapshot = atom(null)

// A membership read belongs to one gateway, one profile *and* one activation of
// that gateway. These are the identity of the read: the SDK routes every
// ctx.rest call with the ambient connection/profile, so a result cached or
// started under one identity must never be served or accepted under another.
// `host.state.*` are readonly atoms; older builds may not expose them, hence the
// fallbacks.
const $scopeConnection = host?.state?.connectionId || atom(null)
const $scopeProfile = host?.state?.profile || atom('default')

/**
 * `gatewayActivationEpoch()` is a function, not an atom, so it cannot be a
 * dependency on its own. The host's gateway atom does change when an activation
 * completes in common cases. Listeners and a lifecycle-scoped interval keep
 * the captured generation in step even when socket state stays unchanged.
 */
const $membershipActivation = atom(gatewayActivationEpoch())
for (const signal of [host?.state?.gateway, $scopeConnection, $scopeProfile]) {
  if (signal?.listen) signal.listen(() => $membershipActivation.set(gatewayActivationEpoch()))
}

/** `${connection}|${profile}` — the scope a membership read belongs to. */
const membershipScopeOf = (connectionId, profile) =>
  `${connectionId || 'local'}|${profile || 'default'}`

/** `${scope}#${activation}` — the identity a read, draft or write belongs to. */
const membershipIdentityOf = (connectionId, profile, activation) =>
  `${membershipScopeOf(connectionId, profile)}#${activation ?? 0}`

const $membershipScope = computed([$scopeConnection, $scopeProfile], membershipScopeOf)

const $membershipIdentity = computed(
  [$scopeConnection, $scopeProfile, $membershipActivation],
  membershipIdentityOf
)

const membershipScopeNow = () => membershipScopeOf($scopeConnection.get(), $scopeProfile.get())
const membershipIdentityNow = () =>
  membershipIdentityOf($scopeConnection.get(), $scopeProfile.get(), gatewayActivationEpoch())

/** True only while the captured identity is still the one the pane is showing. */
const membershipIdentityCurrent = identity => identity === membershipIdentityNow()

/**
 * Kept for callers that compare a scope plus a generation separately. The pane
 * itself uses `membershipIdentityCurrent`, which folds both into one string.
 */
const membershipScopeCurrent = (scope, generation) =>
  membershipScopeNow() === scope && gatewayActivationEpoch() === generation

/**
 * Bounded, redacted request log. Method, relative path, status, identity, plugin
 * id and generation only — never headers, tokens, bodies or account contents.
 */
const MEMBERSHIP_DIAGNOSTIC_LIMIT = 12
const membershipDiagnostics = []
function membershipTrace(entry) {
  membershipDiagnostics.unshift({
    at: new Date().toISOString(),
    plugin: ID,
    method: String(entry.method || 'GET').toUpperCase(),
    path: String(entry.path || ''),
    status: entry.status ?? null,
    scope: String(entry.identity || entry.scope || ''),
    generation: entry.generation ?? null,
    outcome: String(entry.outcome || '')
  })
  membershipDiagnostics.length = Math.min(membershipDiagnostics.length, MEMBERSHIP_DIAGNOSTIC_LIMIT)
}

/* ---- state that always belongs to exactly one identity ------------------- */

/** A notice is only ever shown in the identity that produced it. */
function setMembershipNotice(identity, tone, text, operation = null, accountId = null) {
  if (!membershipIdentityCurrent(identity) || (operation && !membershipOperationCurrent(identity, operation))) return false
  $membershipNotice.set({ tone, text, origin: identity, accountId })
  return true
}

let membershipOperationSerial = 0
let latestMembershipOperation = null
function membershipOperationCurrent(identity, operation) {
  return membershipIdentityCurrent(identity) && latestMembershipOperation === operation
}

function claimMembershipBusy(identity, key) {
  if (!membershipIdentityCurrent(identity)) return null
  const held = $membershipBusy.get()
  if (held && held.origin === identity) return null
  const operation = ++membershipOperationSerial
  latestMembershipOperation = operation
  $membershipBusy.set({ key, origin: identity, operation })
  if ($membershipNotice.get()?.origin === identity) $membershipNotice.set(null)
  return operation
}

function releaseMembershipBusy(identity, operation) {
  const held = $membershipBusy.get()
  // An old scope finishing must not clear a new scope's spinner.
  if (held && held.origin === identity && held.operation === operation) $membershipBusy.set(null)
}

/** The busy key the current identity may show, or '' when it holds none. */
function membershipBusyKey(busy, identity) {
  return busy && busy.origin === identity ? busy.key : ''
}

/** Pane styles. Reuses the shell's card grid; adds only what is new here. */
const MEMBERSHIP_CSS = `
.wm-memberships{display:grid;gap:12px}
.wm-memberships .wm-cards{align-items:start}
.wm-card-head{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}
.wm-card-head h3{margin:0;font-size:13px;font-weight:600;letter-spacing:-0.2px}
.wm-chip{display:inline-flex;align-items:center;border:1px solid var(--ui-stroke-secondary);border-radius:999px;
 padding:2px 8px;font-size:11px;line-height:1.4;color:var(--ui-text-secondary);white-space:nowrap}
.wm-chip[data-state="live"]{color:var(--ui-success,#3fb950);border-color:color-mix(in srgb,var(--ui-success,#3fb950) 45%,transparent)}
.wm-chip[data-state="manual"]{color:var(--ui-accent);border-color:color-mix(in srgb,var(--ui-accent) 45%,transparent)}
.wm-chip[data-state="stale"],.wm-chip[data-state="no_data"]{color:var(--ui-text-tertiary)}
.wm-note{margin:0;font-size:11.5px;line-height:1.5;color:var(--ui-text-secondary)}
.wm-accent-note{color:var(--ui-accent)}
.wm-warn-note{color:var(--ui-warning)}
.wm-fee-row{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;
 border-top:1px solid var(--ui-stroke-secondary);padding-top:8px}
.wm-fee{font-size:13px;font-weight:550}
.wm-quota{list-style:none;margin:0;padding:0;display:grid;gap:8px}
.wm-quota li{border:1px solid var(--ui-stroke-secondary);border-radius:7px;padding:9px 10px;display:grid;gap:3px;min-width:0}
.wm-quota li[data-state="manual"]{border-color:color-mix(in srgb,var(--ui-accent) 45%,transparent)}
.wm-quota-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
.wm-quota-label{font-size:12px;font-weight:550}
.wm-quota-reading{font-size:15px;font-weight:550;letter-spacing:-0.3px}
.wm-quota-actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:4px}
.wm-quota-empty{display:grid;gap:6px;justify-items:start;border:1px dashed var(--ui-stroke-secondary);
 border-radius:7px;padding:9px 10px}
.wm-alert[data-tone="good"]{border-color:color-mix(in srgb,var(--ui-success,#3fb950) 45%,var(--ui-stroke-secondary));
 color:var(--ui-success,#3fb950);padding:9px 12px;font-size:12px}
.wm-attention{border:1px solid var(--ui-stroke-secondary);border-radius:8px;padding:10px 12px}
.wm-attention h3{margin:0 0 6px;font-size:12px;font-weight:600}
.wm-attention ul{margin:0;padding-left:16px;display:grid;gap:3px}
.wm-attention li{font-size:11.5px;line-height:1.5;color:var(--ui-text-secondary)}
.wm-attention li[data-tone="warn"]{color:var(--ui-warning)}
.wm-fee-form{max-width:640px}
.wm-fee-form h3{margin:0;font-size:13px}
.wm-fee-fields{border:0;margin:0;padding:0;min-width:0}
.wm-memberships select:disabled,.wm-memberships input:disabled{opacity:.55}
`

let membershipReadSerial = 0
const latestMembershipRead = new Map()
function membershipQuery(native = false, identity = membershipIdentityNow(),
                         generation = gatewayActivationEpoch(), operation = null) {
  return {
    // The identity is in the key: a result cached for one gateway, profile or
    // activation is not reusable by another, so a switch or a re-activation
    // cannot serve the previous one's answer.
    queryKey: [ID, 'membership-accounts', identity, native ? 'native' : 'stored', operation],
    queryFn: async () => {
      if (!membershipIdentityCurrent(identity)) throw new Error('Membership connection changed.')
      const read = ++membershipReadSerial
      if (typeof rest !== 'function') throw new Error('This desktop build has no plugin backend bridge.')
      membershipTrace({ method: 'GET', path: `/membership/accounts${native ? '?native=true' : ''}`,
                        identity, generation, outcome: 'start' })
      const result = await rest(`/membership/accounts${native ? '?native=true' : ''}`)
      if (!membershipIdentityCurrent(identity)) throw new Error('Membership connection changed.')
      if (!result || result.ok === false) throw new Error(result?.error || 'Memberships are unavailable.')
      const accounts = membershipAccounts(result)   // throws on a malformed envelope
      // Only successful reads advance the watermark, and an older response
      // must never move it backwards after a newer request has succeeded.
      if (read > (latestMembershipRead.get(identity) || 0)) {
        latestMembershipRead.set(identity, read)
        if (latestMembershipRead.size > 128) latestMembershipRead.delete(latestMembershipRead.keys().next().value)
      }
      return { identity, generation, read, accounts, store: result.store || null,
               notes: Array.isArray(result.notes) ? result.notes : [] }
    },
    retry: false, staleTime: 5_000
  }
}

function membershipPlansQuery(identity = membershipIdentityNow(),
                              generation = gatewayActivationEpoch()) {
  return {
    queryKey: [ID, 'membership-plans', identity],
    queryFn: async () => {
      if (typeof rest !== 'function') throw new Error('This desktop build has no plugin backend bridge.')
      membershipTrace({ method: 'GET', path: '/membership/plans', identity, generation, outcome: 'start' })
      const result = await rest('/membership/plans')
      if (!result || result.ok === false) throw new Error(result?.error || 'The plan catalogue is unavailable.')
      if (!membershipIdentityCurrent(identity)) throw new Error('Connection changed.')
      return { ...result, identity }
    },
    retry: false, staleTime: 300_000
  }
}

/** ctx.rest takes `body` as a value; the main process serialises it. */
async function membershipWrite(method, path, body, transport = rest) {
  if (typeof transport !== 'function') throw new Error('No plugin backend bridge.')
  const result = await transport(path, { method, ...(body ? { body } : {}) })
  if (!result || result.ok === false) throw new Error(result?.detail || result?.error || 'The change was not saved.')
  return result
}

/**
 * What actually failed. The transport rejects with status and body text in the
 * message, so this reads them rather than assuming every 404 means the same
 * thing: a missing namespace, a deleted account and a missing mark are three
 * different situations.
 */
function membershipErrorKind(error) {
  const raw = typeof error?.message === 'string' ? error.message : String(error ?? '')
  const status = Number((raw.match(/\b([45][0-9]{2})\b/) || [])[1] || 0)
  if (/store_unreadable/i.test(raw)) return { kind: 'storage', status }
  if (status === 401 || /unauthori|sign in/i.test(raw)) return { kind: 'auth', status }
  if (/plugin not found|no such plugin/i.test(raw)) return { kind: 'namespace', status }
  if (status === 409 || /conflict/i.test(raw)) return { kind: 'conflict', status }
  if (status === 422 || /valid dictionary|validation|unknown fields/i.test(raw)) return { kind: 'validation', status }
  if (status === 404) return { kind: 'missing', status }
  if (status >= 500) return { kind: 'backend', status }
  if (/timeout|timed out|abort/i.test(raw)) return { kind: 'timeout', status }
  if (/bridge/i.test(raw)) return { kind: 'bridge', status }
  return { kind: 'unknown', status }
}

/** Short, operation-specific text. Never a raw FastAPI/Pydantic payload. */
function membershipErrorText(error, operation = 'read') {
  const { kind } = membershipErrorKind(error)
  if (kind === 'storage') return 'The membership store could not be read, so nothing was changed. The file is preserved; fix or restore it before saving.'
  if (kind === 'auth') return 'Your Desktop session has expired. Sign in again, then retry.'
  if (kind === 'namespace') return 'The membership plugin is not available on this connection and profile. Choose the right connection, or check that the plugin is enabled here.'
  if (kind === 'conflict') return 'This membership changed since you loaded it. Reload, then save again.'
  if (kind === 'validation') return 'Some details are not valid. Check the amount, currency and dates.'
  if (kind === 'missing') {
    if (operation === 'clear') return 'That mark is no longer there — it may have been cleared in another window.'
    if (operation === 'write') return 'This account is no longer in the store for this connection. Reload the pane.'
    return 'No memberships were recorded for this connection yet.'
  }
  if (kind === 'backend') return 'The backend answered with an error. Nothing was changed; retry once, then check its log.'
  if (kind === 'timeout') return 'The backend did not answer in time. Nothing was changed; retry when the connection settles.'
  if (kind === 'bridge') return 'This Desktop build has no plugin backend bridge, so memberships cannot be read.'
  return operation === 'refresh'
    ? 'Readings could not be refreshed. The previous reading is still shown.'
    : 'That did not complete. Please retry; if it persists, check the backend log.'
}

/** Kept for older call sites: a read error is the common case. */
function membershipErrorMessage(error) {
  return membershipErrorText(error, 'read')
}

function membershipAccounts(payload) {
  if (!Array.isArray(payload?.accounts)) {
    // A malformed envelope is a failure, not "no memberships": saying nothing
    // here is what makes an empty list look authoritative.
    throw new Error('malformed membership response: no accounts array')
  }
  return payload.accounts
}

function fmtMoney(amount, currency) {
  if (amount === null || amount === undefined || amount === '' || Number.isNaN(Number(amount))) return null
  const value = Number(amount)
  const symbol = { USD: '$', GBP: '£', EUR: '€', JPY: '¥', INR: '₹' }[String(currency || 'USD')] || ''
  return symbol ? `${symbol}${value.toFixed(2)}` : `${value.toFixed(2)} ${currency || ''}`.trim()
}

/** One sentence for the fee, always naming its basis. */
function feeLabel(fee) {
  if (!fee || typeof fee !== 'object') return 'No fee information'
  const effective = fee.effective || {}
  const amount = fmtMoney(effective.amount, effective.currency)
  const period = effective.period ? `/${String(effective.period).replace('month', 'mo').replace('year', 'yr')}` : ''
  if (fee.basis === 'api_only') return 'API Only · no recurring membership fee'
  if (fee.basis === 'prepaid') return 'Prepaid credits · no recurring membership fee'
  if (fee.basis === 'unconfirmed') return 'No confirmed billing arrangement'
  if (fee.basis === 'declared') {
    const published = fee.published ? fmtMoney(fee.published.amount, fee.published.currency) : null
    const comparable = fee.currency_comparable !== false
    const tail = published && comparable
      ? ` (${fee.published.source === 'user_defined' ? 'plan default' : 'catalogue'} ${published})` : ''
    return `Your price: ${amount}${period}${tail}`
  }
  if (fee.basis === 'custom') return `User-defined plan: ${amount}${period}`
  if (fee.basis === 'catalogue') return `Catalogue: ${amount}${period}`
  if (fee.basis === 'unpriced') return 'Plan chosen, but no published price — set your own fee'
  return 'No plan selected'
}

/** A quota row rendered from the backend contract, never a guess. */
function quotaRows(account, now = Date.now()) {
  const quota = account?.quota || {}
  const windows = Array.isArray(quota.windows) ? quota.windows : []
  return windows.map(window => {
    // `Number(null)` is 0, so an absent reading must be excluded before coercion
    // or every window without a percentage would render as "0% used".
    const raw = window.used_percent
    const used = raw === null || raw === undefined || raw === '' || !Number.isFinite(Number(raw))
      ? null : Number(raw)
    const fromManual = window.used_percent_from === 'manual'
    const state = window.state || 'no_data'
    const bases = Array.isArray(window.basis) ? window.basis : []
    let reading
    if (used !== null) {
      reading = `${Math.round(used)}% used${fromManual ? ' (you reported)' : ''}`
    } else if (window.amount !== null && window.amount !== undefined) {
      // A count of credits is not money; monetary allowances carry currency.
      reading = window.limit === 'credits' ? `${window.amount} credits` :
        window.currency ? `${fmtMoney(window.amount, window.currency)} allowance` : `${window.amount} allowance`
    } else {
      reading = 'No reading'
    }
    const source = fromManual ? 'You reported' : bases.includes('provider_reported') ? 'Provider' : 'No data'
    const reset = window.reset_at ? `resets ${fmtReset(window.reset_at)} · ${fmtCountdown(window.reset_at, now)}` : ''
    return {
      id: window.id, label: window.label || window.id, scope: window.scope || 'account',
      reading, source, reset, state, conflict: !!window.conflict,
      manual: window.manual || null,
      stateLabel: state === 'live' ? 'live' : state === 'stale' ? 'stale' : state === 'manual' ? 'manual' : 'not recorded'
    }
  })
}

function fmtReset(value) {
  const when = new Date(value)
  if (Number.isNaN(when.getTime())) return String(value)
  return when.toISOString().replace('T', ' ').replace(':00.000Z', '').replace('.000Z', '') + ' UTC'
}

function fmtCountdown(value, now = Date.now()) {
  const target = new Date(value).getTime()
  if (!Number.isFinite(target)) return ''
  const seconds = Math.floor(Math.abs(target - now) / 1000)
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const span = days ? `${days}d ${hours}h` : hours ? `${hours}h ${minutes}m` : `${minutes}m`
  return target >= now ? `in ${span}` : `${span} ago`
}

/** Everything the owner should look at, most urgent first. */
function needsAttention(accounts) {
  const out = []
  for (const account of accounts) {
    const quota = account.quota || {}
    if (quota.conflicts && quota.conflicts.length) {
      out.push({ account, tone: 'warn', text: `Provider data disagrees with your manual mark on ${quota.conflicts.join(', ')}.` })
    }
    if (quota.account_exhausted) {
      out.push({ account, tone: 'warn', text: 'Account marked exhausted.' })
    }
    for (const row of quotaRows(account)) {
      if (row.manual && row.manual.status === 'reconfirm_due') {
        out.push({ account, tone: 'info', text: `${row.label}: no reliable reset time — please confirm or clear.` })
      }
    }
    if (account.effective_arrangement === 'api_only' || account.effective_arrangement === 'prepaid') continue
    if (account.effective_arrangement === 'unconfirmed') {
      out.push({ account, tone: 'info', text: 'Billing arrangement not confirmed.' })
      continue
    }
    if (account.plan_reconfirmation?.required) {
      out.push({ account, tone: 'info', text: `Hermes now reports "${account.plan_reconfirmation.reported_label}" — reconfirm the saved plan.` })
    }
    const basis = account.fee?.basis
    if (!account.plan_id) {
      out.push({ account, tone: 'info', text: 'No plan confirmed yet.' })
    } else if (basis === 'unpriced' || basis === 'no_plan') {
      out.push({ account, tone: 'info', text: 'No fee set for the chosen plan.' })
    }
  }
  return out
}

function membershipSummary(accounts) {
  const total = accounts.length
  const withPlan = accounts.filter(a => a.plan_id && !['api_only', 'prepaid', 'unconfirmed'].includes(a.effective_arrangement)).length
  const exhausted = accounts.filter(a => a.quota?.account_exhausted).length
  const byCurrency = {}
  const byCurrencyPeriod = {}
  for (const account of accounts) {
    const effective = account.fee?.effective
    if (!effective || effective.amount === null || effective.amount === undefined) continue
    const code = String(effective.currency || 'USD').toUpperCase()
    const period = String(effective.period || 'month')
    byCurrency[code] = (byCurrency[code] || 0) + Number(effective.amount)
    const key = `${code}/${period}`
    byCurrencyPeriod[key] = (byCurrencyPeriod[key] || 0) + Number(effective.amount)
  }
  return { total, withPlan, exhausted, byCurrency, byCurrencyPeriod,
    monthlyUsd: byCurrencyPeriod['USD/month'] || 0 }
}

function feesLabel(summary) {
  const periodLabel = { month: '/mo', year: '/yr', quarter: '/quarter', week: '/wk' }
  const entries = Object.entries(summary?.byCurrencyPeriod || {})
  if (!entries.length) return '—'
  return entries.map(([key, amount]) => {
    const [code, period = 'month'] = key.split('/')
    return `${fmtMoney(amount, code) || `${amount} ${code}`}${periodLabel[period] || `/${period}`}`
  }).join(' + ')
}

function customPlanDraftFor(account, identity = membershipIdentityNow()) {
  const plan = account?.custom_plan || {}
  const price = plan.price || {}
  const cycle = plan.billing_cycle || {}
  const allowances = Array.isArray(plan.allowances) ? plan.allowances : []
  return {
    origin: identity, account_id: account?.id,
    name: plan.name || '', amount: price.amount ?? '', currency: price.currency || 'USD',
    period: price.period || 'month', anchor_day: cycle.anchor_day || '',
    effective_from: plan.effective_from || '', effective_to: plan.effective_to || '',
    model_restrictions: Array.isArray(plan.model_restrictions) ? plan.model_restrictions.join(', ') : '',
    allowances: allowances.length ? allowances.map(window => ({
      label: window.label || window.id || '', kind: window.kind || 'rolling',
      duration_minutes: window.duration_minutes ?? '', amount: window.amount ?? '',
      currency: window.currency || 'USD', scope: window.scope || 'account'
    })) : [{ label: '', kind: 'rolling', duration_minutes: '', amount: '', currency: 'USD', scope: 'account' }]
  }
}

function customPlanDraftErrors(draft) {
  const errors = []
  if (!draft || !String(draft.name || '').trim()) errors.push('A plan name is required.')
  if (draft?.amount !== '' && draft?.amount != null &&
      (!Number.isFinite(Number(draft.amount)) || Number(draft.amount) < 0)) errors.push('Plan fee must be zero or more.')
  if (draft?.amount !== '' && draft?.amount != null && !String(draft.currency || '').trim()) errors.push('Choose a fee currency.')
  if (!['month', 'year', 'quarter', 'week'].includes(String(draft?.period || 'month'))) errors.push('Choose a billing period.')
  if (draft?.anchor_day !== '' && draft?.anchor_day != null &&
      (!Number.isInteger(Number(draft.anchor_day)) || Number(draft.anchor_day) < 1 || Number(draft.anchor_day) > 31)) {
    errors.push('Billing cycle day must be between 1 and 31.')
  }
  if (draft?.effective_from && draft?.effective_to && new Date(draft.effective_to) <= new Date(draft.effective_from)) {
    errors.push('End date must be after the start date.')
  }
  for (const window of draft?.allowances || []) {
    if (!String(window.label || '').trim()) {
      if (window.duration_minutes || window.amount !== '') errors.push('Name each allowance window you define.')
      continue
    }
    if (window.duration_minutes !== '' && (!Number.isInteger(Number(window.duration_minutes)) || Number(window.duration_minutes) <= 0)) {
      errors.push('Allowance duration must be positive minutes.')
    }
    if (window.amount !== '' && (!Number.isFinite(Number(window.amount)) || Number(window.amount) < 0)) {
      errors.push('Allowance amount must be zero or more.')
    }
  }
  return [...new Set(errors)]
}

function customPlanPayload(draft, account) {
  const numberOrNull = value => value === '' || value == null ? null : Number(value)
  const slug = value => String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  const allowances = (draft.allowances || []).filter(window => String(window.label || '').trim()).map(window => ({
    id: slug(window.label), label: String(window.label).trim(), kind: window.kind || 'rolling',
    duration_minutes: window.duration_minutes === '' ? null : Number(window.duration_minutes),
    amount: numberOrNull(window.amount), currency: window.amount === '' ? null : window.currency,
    scope: window.scope || 'account'
  }))
  return {
    id: `custom:${account.id}`, name: String(draft.name).trim(),
    price: { amount: numberOrNull(draft.amount),
      currency: draft.amount === '' ? null : String(draft.currency).toUpperCase(), period: draft.period || 'month' },
    billing_cycle: { anchor_day: draft.anchor_day === '' ? null : Number(draft.anchor_day), period: draft.period || 'month' },
    allowances,
    model_restrictions: String(draft.model_restrictions || '').split(/[\n,]/).map(value => value.trim()).filter(Boolean),
    effective_from: draft.effective_from || null, effective_to: draft.effective_to || null
  }
}

/**
 * Plans the backend says this route may offer. Eligibility (for example, a
 * CommandCode CLI plan with no Provider API access) is decided server-side so
 * the pane cannot drift from the rule the write endpoint enforces.
 */
function accountPlanChoices(account) {
  return Array.isArray(account?.plan_choices) ? account.plan_choices : []
}

/** A short sentence naming plans that exist but cannot serve this route. */
function excludedPlansNote(account) {
  const excluded = Array.isArray(account?.excluded_plans) ? account.excluded_plans : []
  if (!excluded.length) return ''
  const names = excluded.map(p => p.name || p.id)
  return `${names.length === 1 ? names[0] + ' is a real plan but does' : 'Some plans exist but do'} not cover this route, so ${names.length === 1 ? 'it is' : 'they are'} not offered here.`
}

function planOptionLabel(plan) {
  const amount = fmtMoney(plan?.price?.amount, plan?.price?.currency)
  const state = plan?.source === 'user_defined' ? ' (user-defined)' :
    plan?.verification?.status === 'verified' ? '' :
    plan?.verification?.status === 'provisional' ? ' (provisional)' : ' (unpriced)'
  const periods = { month: '/month', year: '/year', quarter: '/quarter', week: '/week' }
  const price = plan?.price?.amount === null || plan?.price?.amount === undefined
    ? 'no fee set' : `${amount}${periods[plan.price.period || 'month'] || '/' + plan.price.period}`
  return `${plan?.name || plan?.id} — ${price}${state}`
}

/**
 * Reasons the backend accepts, mirrored from `membership.OVERRIDE_REASONS`.
 * The pane prefers the list served by /membership/plans; this is only the
 * offline fallback, and a Python test pins the served list to the model.
 */
const OVERRIDE_REASON_FALLBACK = [
  'discount', 'legacy_pricing', 'promotion', 'regional', 'catalogue_behind', 'annual_prepay', 'other'
]
const REASON_LABELS = {
  discount: 'Discount', legacy_pricing: 'Legacy price', promotion: 'Promotion',
  regional: 'Regional price', catalogue_behind: 'Catalogue is behind',
  annual_prepay: 'Annual prepay', other: 'Other'
}

function feeReasons(catalogue) {
  const served = catalogue?.vocabulary?.override_reasons
  const list = Array.isArray(served) && served.length ? served : OVERRIDE_REASON_FALLBACK
  return list.map(value => [value, REASON_LABELS[value] || value])
}

function feeCurrencies(catalogue) {
  const served = catalogue?.vocabulary?.currencies
  return Array.isArray(served) && served.length ? served : ['USD', 'GBP', 'EUR']
}

/** Saved plan the provider no longer reports: ask, never auto-change. */
function reconfirmationText(account) {
  const flag = account?.plan_reconfirmation
  if (!flag?.required) return ''
  return `Hermes reports "${flag.reported_label}" but this account is saved as ${flag.saved_plan_name || flag.saved_plan_id}. Reconfirm the plan below — nothing has been changed.`
}

/** The plan Hermes itself suggests, as a non-preselected proposal. */
function proposalText(account) {
  // Once a plan is confirmed the suggestion is stale and must not ask again.
  if (account?.plan_id) return ''
  const proposal = account?.plan_proposal
  if (!proposal || !proposal.label) return ''
  if (proposal.confidence === 'none') return ''
  return `Hermes reports "${proposal.label}" — confirm the matching plan below.`
}

function feeDraft(account) {
  const effective = account?.fee?.effective || {}
  const override = account?.fee?.override || {}
  return {
    account_id: account?.id,
    amount: override.amount ?? effective.amount ?? '',
    currency: override.currency || effective.currency || 'USD',
    period: override.period || effective.period || 'month',
    anchor_day: override.billing_cycle?.anchor_day || account?.billing_cycle?.anchor_day || 1,
    effective_from: new Date().toISOString().slice(0, 10),
    reason: override.reason || 'discount',
    note: ''
  }
}

function feeDraftErrors(draft) {
  const errors = []
  if (!draft) return ['no draft']
  const amount = Number(draft.amount)
  if (draft.amount === '' || Number.isNaN(amount) || amount < 0) errors.push('Enter an amount of 0 or more.')
  if (!/^[A-Z]{3}$/.test(String(draft.currency || ''))) errors.push('Pick a currency.')
  if (!['month', 'year', 'quarter', 'week'].includes(String(draft.period))) errors.push('Pick a billing period.')
  const day = Number(draft.anchor_day)
  if (!Number.isInteger(day) || day < 1 || day > 31) errors.push('Billing day must be between 1 and 31.')
  return errors
}

/** Build the override revision; the catalogue price is never replaced. */
function overrideFromDraft(draft, account) {
  const existing = Array.isArray(account?.fee_overrides) ? account.fee_overrides : []
  return {
    id: `fee-${Date.now().toString(36)}`,
    amount: Number(draft.amount),
    currency: String(draft.currency).toUpperCase(),
    period: String(draft.period),
    billing_cycle: { anchor_day: Number(draft.anchor_day), period: String(draft.period) },
    effective_from: draft.effective_from || new Date().toISOString().slice(0, 10),
    effective_to: null,
    reason: String(draft.reason || 'discount'),
    note: String(draft.note || ''),
    recorded_at: new Date().toISOString(),
    revisions: existing.length + 1
  }
}

function restoreCatalogueFee(account, at = new Date().toISOString()) {
  const revision = account?.fee?.override?.revision_id
  if (!revision || !Array.isArray(account.fee_overrides)) return null
  let changed = false
  const overrides = account.fee_overrides.map(entry => {
    const end = entry?.effective_to ? Date.parse(entry.effective_to) : Infinity
    const start = entry?.effective_from ? Date.parse(entry.effective_from) : -Infinity
    const now = Date.parse(at)
    if (!(start < now && now < end)) return entry
    changed = true
    return { ...entry, effective_to: at }
  })
  return changed ? overrides : null
}

/** Sentinel scope id for a mark that covers the whole login. */
const ACCOUNT_SCOPE = '__account__'

/** True when an active account-wide manual mark already exists. */
function accountHolderMarked(account) {
  return (account?.manual_exhaustions || []).some(entry =>
    entry && entry.scope && entry.scope.kind === 'account' && entry.state !== 'cleared')
}

function MembershipCard({ account, plans, busy, onAction, draft, saveFee, catalogue, notice }) {
  const identity = useValue($membershipIdentity)
  const now = useValue($membershipClock)
  const rawPlanDraft = useValue($customPlanDraft)
  const rawExhaustionDraft = useValue($exhaustionDraft)
  const rows = quotaRows(account, now)
  const fee = account.fee || {}
  const proposal = proposalText(account)
  const reconfirmation = reconfirmationText(account)
  const excluded = excludedPlansNote(account)
  const planSaved = !!account.plan_id
  const arrangement = account.effective_arrangement || (account.api_only ? 'api_only' : account.billing_arrangement || (planSaved ? 'subscription' : 'unconfirmed'))
  const apiOnly = arrangement === 'api_only'
  const subscription = arrangement === 'subscription'
  const customDraft = rawPlanDraft?.origin === identity && rawPlanDraft.account_id === account.id
    ? rawPlanDraft : null
  const customErrors = customPlanDraftErrors(customDraft)
  const setPlanField = (key, value) => $customPlanDraft.set({ ...customDraft, [key]: value })
  const setAllowance = (index, key, value) => {
    const allowances = (customDraft.allowances || []).map((item, i) => i === index ? { ...item, [key]: value } : item)
    $customPlanDraft.set({ ...customDraft, allowances })
  }
  const exhaustionDraft = rawExhaustionDraft?.origin === identity && rawExhaustionDraft.account_id === account.id
    ? rawExhaustionDraft : null
  const openExhaustion = (scopeId, label) => onAction('exhaust', account, scopeId, label)
  const submitExhaustion = event => {
    event.preventDefault()
    if (!exhaustionDraft) return
    let reset_at = null
    if (exhaustionDraft.reset_local) {
      const date = new Date(exhaustionDraft.reset_local)
      if (Number.isFinite(date.getTime())) reset_at = date.toISOString()
    }
    onAction('confirm-exhaust', account, { ...exhaustionDraft, reset_at })
  }
  const field = (label, key, options = {}) => jsxs('label', { className: 'wm-filter', children: [
    jsx('span', { children: label }),
    options.choices
      ? jsx('select', { value: customDraft[key] ?? '', onChange: event => setPlanField(key, event.target.value),
        children: options.choices.map(([value, text]) => jsx('option', { value, children: text }, value)) })
      : jsx('input', { type: options.type || 'text', value: customDraft[key] ?? '',
        placeholder: options.placeholder || '', onChange: event => setPlanField(key, event.target.value) })
  ] }, key)
  return jsxs('article', { className: 'wm-card', 'data-account': account.id, children: keyedElementChildren([
    jsxs('header', { className: 'wm-card-head', children: [
      jsx('h3', { children: account.label && account.label !== account.family
        ? `${account.family} · ${account.label}` : account.family }),
      jsx('span', { className: 'wm-chip', 'data-state': account.credential_present ? 'live' : 'no_data',
        children: account.credential_present ? 'configured credential' : 'credential not found' })
    ] }),
    jsx('p', { className: 'wm-note', children:
      account.identity_source === 'native' ? 'Account identified by Hermes.' : 'Provider account slot; credential values are never shown.' }),
    jsxs('label', { className: 'wm-filter', children: [
      jsx('input', { type: 'checkbox', checked: apiOnly, disabled: !!busy,
        onChange: event => onAction('api-only', account, event.target.checked) }),
      jsx('span', { children: 'API Only' })
    ] }),
    jsx('p', { className: 'wm-note', children: apiOnly
      ? 'API Only: no recurring membership fee. Usage and API cost estimates remain available.'
      : arrangement === 'prepaid' ? 'Prepaid credit account. Top-ups are not recurring membership fees; configure cost rules separately in Costs.'
      : arrangement === 'subscription' ? 'Subscription account.' : 'No confirmed billing arrangement.' }),
    !apiOnly ? jsxs('label', { className: 'wm-filter', children: [
      jsx('span', { children: 'Billing arrangement' }),
      jsxs('select', { value: arrangement, disabled: !!busy,
        onChange: event => onAction('arrangement', account, event.target.value), children: [
          jsx('option', { value: 'unconfirmed', children: 'Not confirmed' }),
          jsx('option', { value: 'subscription', children: 'Subscription' }),
          jsx('option', { value: 'prepaid', children: 'Prepaid credits' })
        ] })
    ] }) : null,
    busy === account.id ? jsx('p', { role: 'status', className: 'wm-note', children: 'Saving changes…' }) : null,
    notice?.accountId === account.id && notice.tone === 'good'
      ? jsx('p', { role: 'status', className: 'wm-note', children: notice.text }) : null,
    subscription && ['xai', 'grok'].includes(account.family)
      ? jsx('p', { className: 'wm-note', children: 'Grok consumer subscriptions and xAI API billing are separate. Select a subscription only if it applies to this account.' }) : null,
    subscription && proposal ? jsx('p', { className: 'wm-note wm-accent-note', children: proposal }) : null,
    subscription && reconfirmation ? jsx('p', { className: 'wm-note wm-accent-note', 'data-plan-reconfirmation': 'true', children: reconfirmation }) : null,
    subscription && excluded ? jsx('p', { className: 'wm-note', 'data-excluded': 'true', children: excluded }) : null,
    subscription && account.plan?.notes ? jsx('p', { className: 'wm-note', children: account.plan.notes }) : null,
    subscription || apiOnly ? jsxs('label', { className: 'wm-filter', children: [
      jsx('span', { children: 'Plan for this provider account' }),
      jsxs('select', {
        value: account.plan_id || '', disabled: !subscription || !!busy,
        onChange: event => onAction('plan', account, event.target.value),
        children: [
          jsx('option', { value: '', children: planSaved ? '— clear selection —' : '— confirm a plan —' }, 'unselected'),
          ...plans.map(plan => jsx('option', { value: plan.id, children: planOptionLabel(plan) }, plan.id))
        ]
      })
    ] }) : null,
    subscription || apiOnly ? jsxs('div', { className: 'wm-fee-row', children: [
      jsx('span', { className: 'wm-fee', children: feeLabel(fee) }),
      jsx(ProductButton, { type: 'button', className: 'wm-button', disabled: !subscription || !!busy, onClick: () => onAction('fee', account), children: 'Edit fee' })
    ] }) : null,
    subscription && draft && draft.account_id === account.id
        ? jsxs('form', { className: 'wm-fee-form', onSubmit: event => { event.preventDefault(); saveFee() }, children: [
            jsx('h3', { children: `Membership fee · ${account.label || account.family}` }),
            notice?.tone === 'warn' && notice.accountId === account.id ? jsx('p', { role: 'alert', className: 'wm-warn-note', children: notice.text }) : null,
            jsx('p', { className: 'wm-note', children: 'The published catalogue price is kept separately; this becomes your own revision.' }),
            jsxs('fieldset', { disabled: !!busy, className: 'wm-controls wm-fee-fields', children: [
              jsxs('label', { className: 'wm-filter', children: [
                jsx('span', { children: 'Amount' }),
                jsx('input', { type: 'number', step: '0.01', min: '0', value: draft.amount, autoFocus: true,
                  onChange: event => $membershipDraft.set({ ...draft, amount: event.target.value }) })
              ] }),
              jsxs('label', { className: 'wm-filter', children: [
                jsx('span', { children: 'Currency' }),
                jsx('select', { value: draft.currency, onChange: event => $membershipDraft.set({ ...draft, currency: event.target.value }),
                  children: feeCurrencies(catalogue).map(code => jsx('option', { value: code, children: code }, code)) })
              ] }),
              jsxs('label', { className: 'wm-filter', children: [
                jsx('span', { children: 'Period' }),
                jsx('select', { value: draft.period, onChange: event => $membershipDraft.set({ ...draft, period: event.target.value }),
                  children: ['month', 'year', 'quarter', 'week'].map(code => jsx('option', { value: code, children: code }, code)) })
              ] }),
              jsxs('label', { className: 'wm-filter', children: [
                jsx('span', { children: 'Renews on day' }),
                jsx('input', { type: 'number', min: '1', max: '31', value: draft.anchor_day,
                  onChange: event => $membershipDraft.set({ ...draft, anchor_day: event.target.value }) })
              ] }),
              jsxs('label', { className: 'wm-filter', children: [
                jsx('span', { children: 'Effective from' }),
                jsx('input', { type: 'date', value: draft.effective_from,
                  onChange: event => $membershipDraft.set({ ...draft, effective_from: event.target.value }) })
              ] }),
              jsxs('label', { className: 'wm-filter', children: [
                jsx('span', { children: 'Reason' }),
                jsx('select', { value: draft.reason, onChange: event => $membershipDraft.set({ ...draft, reason: event.target.value }),
                  children: feeReasons(catalogue).map(([value, text]) => jsx('option', { value, children: text }, value)) })
              ] })
            ] }),
            jsxs('div', { className: 'wm-controls', children: [
              jsx(ProductButton, { type: 'submit', className: cn('wm-button', 'wm-accent'), disabled: !!busy, children: busy === account.id ? 'Saving…' : 'Save fee' }),
              jsx(ProductButton, { type: 'button', className: 'wm-button', disabled: !!busy, onClick: () => $membershipDraft.set(null), children: 'Cancel' })
            ] })
          ] })
        : null,
    subscription && fee.basis === 'declared' && fee.published?.source === 'catalogue'
      ? jsx(ProductButton, { type: 'button', className: 'wm-button', 'data-action': 'restore-catalogue-price',
          disabled: !!busy, onClick: () => onAction('restore-fee', account),
          children: 'Restore catalogue price' })
      : null,
    subscription && fee.basis === 'declared' && fee.published?.source === 'user_defined'
      ? jsx('p', { className: 'wm-note', children: 'Your fee override is shown separately from the user-defined plan price.' })
      : null,
    subscription ? jsx('div', { className: 'wm-setting-action', children: [
      jsx(ProductButton, { type: 'button', className: 'wm-button', disabled: !!busy,
        onClick: () => onAction('edit-custom-plan', account),
        children: account.custom_plan ? 'Edit user-defined plan' : 'Create user-defined plan' })
    ] }) : null,
    subscription && customDraft ? jsxs('form', { className: 'wm-custom-form', onSubmit: event => {
      event.preventDefault()
      onAction('save-custom-plan', account, customDraft)
    }, children: [
      jsx('h3', { children: 'User-defined plan for this credential' }),
      jsx('p', { className: 'wm-note', children: 'Provider and account are taken from this discovered card. This plan stays attached to this account and outside the bundled catalogue.' }),
      jsx('div', { className: 'wm-custom-grid', children: [
        field('Plan name', 'name'),
        field('Fee (optional)', 'amount', { type: 'number' }),
        field('Currency', 'currency', { choices: feeCurrencies({ vocabulary: { currencies: ['USD', 'GBP', 'EUR', 'AUD', 'CAD', 'JPY', 'CNY', 'CHF', 'SEK', 'PLN', 'INR'] } }).map(code => [code, code]) }),
        field('Billing frequency', 'period', { choices: [['month', 'Monthly'], ['year', 'Yearly'], ['quarter', 'Quarterly'], ['week', 'Weekly']] }),
        field('Billing-cycle anchor day', 'anchor_day', { type: 'number' }),
        field('Effective from', 'effective_from', { type: 'date' }),
        field('Effective to', 'effective_to', { type: 'date' }),
        field('Model restrictions (comma-separated)', 'model_restrictions')
      ] }),
      jsx('div', { className: 'wm-allowances', children: [
        jsxs('div', { className: 'wm-card-head', children: [
          jsx('strong', { children: 'Optional allowance definitions' }),
          jsx(ProductButton, { type: 'button', className: 'wm-button', onClick: () =>
            $customPlanDraft.set({ ...customDraft, allowances: [...(customDraft.allowances || []),
              { label: '', kind: 'rolling', duration_minutes: '', amount: '', currency: 'USD', scope: 'account' }] }),
            children: 'Add allowance' })
        ] }),
        ...(customDraft.allowances || []).map((window, index) => jsxs('div', { className: 'wm-allowance-editor',
          'data-custom-allowance': String(index), children: [
            jsx('label', { className: 'wm-filter', children: [
              jsx('span', { children: 'Window name' }),
              jsx('input', { value: window.label, onChange: event => setAllowance(index, 'label', event.target.value) })
            ] }),
            jsx('label', { className: 'wm-filter', children: [
              jsx('span', { children: 'Window kind' }),
              jsx('select', { value: window.kind, onChange: event => setAllowance(index, 'kind', event.target.value),
                children: [['rolling', 'Rolling'], ['billing_cycle', 'Billing cycle'], ['monthly_credit', 'Monthly credit']]
                  .map(([value, text]) => jsx('option', { value, children: text }, value)) })
            ] }),
            jsx('label', { className: 'wm-filter', children: [
              jsx('span', { children: 'Rolling duration (minutes, optional)' }),
              jsx('input', { type: 'number', min: '1', value: window.duration_minutes,
                onChange: event => setAllowance(index, 'duration_minutes', event.target.value) })
            ] }),
            jsx('label', { className: 'wm-filter', children: [
              jsx('span', { children: 'Credit amount (optional)' }),
              jsx('input', { type: 'number', min: '0', value: window.amount,
                onChange: event => setAllowance(index, 'amount', event.target.value) })
            ] }),
            jsx('label', { className: 'wm-filter', children: [
              jsx('span', { children: 'Currency' }),
              jsx('select', { value: window.currency, onChange: event => setAllowance(index, 'currency', event.target.value),
                children: ['USD', 'GBP', 'EUR', 'AUD', 'CAD', 'JPY', 'CNY', 'CHF', 'SEK', 'PLN', 'INR']
                  .map(code => jsx('option', { value: code, children: code }, code)) })
            ] }),
            jsx('label', { className: 'wm-filter', children: [
              jsx('span', { children: 'Applies to' }),
              jsx('select', { value: window.scope, onChange: event => setAllowance(index, 'scope', event.target.value),
                children: [['account', 'Account'], ['model', 'Model']].map(([value, text]) =>
                  jsx('option', { value, children: text }, value)) })
            ] }),
            jsx(ProductButton, { type: 'button', className: 'wm-button', onClick: () =>
              $customPlanDraft.set({ ...customDraft,
                allowances: customDraft.allowances.filter((_, i) => i !== index) }),
              children: 'Remove window' })
          ]
        }, index))
      ] }),
      customErrors.length ? jsx('p', { className: 'wm-warn-note', role: 'alert', children: customErrors.join(' ') }) : null,
      jsx('div', { className: 'wm-setting-action', children: [
        jsx(ProductButton, { type: 'submit', className: 'wm-button', disabled: !!busy || customErrors.length > 0, children: 'Save user-defined plan' }),
        jsx(ProductButton, { type: 'button', className: 'wm-button', onClick: () => $customPlanDraft.set(null), children: 'Cancel' })
      ] })
    ] }) : null,
    rows.length
      ? jsxs('ul', { className: 'wm-quota', children: rows.map(row => jsxs('li', { 'data-window': row.id, 'data-state': row.state, children: [
          jsxs('div', { className: 'wm-quota-head', children: [
            jsx('span', { className: 'wm-quota-label', children: row.label }),
            jsx('span', { className: 'wm-chip', 'data-state': row.state, children: row.stateLabel })
          ] }),
          jsx('div', { className: 'wm-quota-reading', children: row.reading }),
          jsx('div', { className: 'wm-note', children: [row.source, row.reset,
            row.manual && !row.reset ? 'No reset time supplied by you.' : ''].filter(Boolean).join(' · ') }),
          jsxs('div', { className: 'wm-quota-actions', children: [
            jsx(ProductButton, { type: 'button', className: 'wm-button', disabled: !!busy,
              onClick: () => openExhaustion(row.id, row.label), children: 'Mark exhausted' }),
            row.manual && row.manual.status !== 'cleared'
              ? jsx(ProductButton, { type: 'button', className: 'wm-button', disabled: !!busy,
                  onClick: () => onAction('clear', account, row.manual.id), children: 'Clear mark' })
              : null
          ] })
        ] }, row.id)) })
      : jsxs('div', { className: 'wm-quota-empty', children: [
          jsx('p', { className: 'wm-note', children: 'No quota windows are published for this account. You can still record that it is used up.' }),
          jsx(ProductButton, { type: 'button', className: 'wm-button', 'data-action': 'exhaust-account',
            disabled: !!busy,
            onClick: () => openExhaustion(ACCOUNT_SCOPE, 'Account'),
            children: 'Mark account exhausted' })
        ] }),
    rows.length && !accountHolderMarked(account)
      ? jsx(ProductButton, { type: 'button', className: 'wm-button', 'data-action': 'exhaust-account-footer',
          disabled: !!busy,
          onClick: () => openExhaustion(ACCOUNT_SCOPE, 'Account'),
          children: 'Mark account exhausted' })
      : null,
    exhaustionDraft ? jsxs('form', { className: 'wm-exhaustion-form', onSubmit: submitExhaustion, children: [
      jsx('h3', { children: 'Record your exhaustion report' }),
      jsx('p', { className: 'wm-note', children: `${exhaustionDraft.label} · This is user-reported and is not provider-confirmed.` }),
      jsx('label', { className: 'wm-filter', children: [
        jsx('span', { children: 'Expected reset date and time (optional)' }),
        jsx('input', { type: 'datetime-local', value: exhaustionDraft.reset_local || '',
          onChange: event => $exhaustionDraft.set({ ...exhaustionDraft, reset_local: event.target.value }) })
      ] }),
      jsx('p', { className: 'wm-note', children: 'No reset time is inferred from when you mark it. A countdown appears only when you supply a time.' }),
      jsx('div', { className: 'wm-setting-action', children: [
        jsx(ProductButton, { type: 'submit', className: 'wm-button', disabled: !!busy, children: 'Save manual status' }),
        jsx(ProductButton, { type: 'button', className: 'wm-button',
          onClick: () => $exhaustionDraft.set(null), children: 'Cancel' })
      ] })
    ] }) : null
  ], `membership-card-${account.id}`) })
}


function MembershipsPage() {
  // The identity is reactive: switching gateway or profile, or a re-activation
  // of the same gateway, re-renders this page with a different value, which
  // re-keys every membership query and re-stamps every piece of local state.
  const identity = useValue($membershipIdentity)
  const plans = useQuery(membershipPlansQuery(identity))
  const native = useValue($membershipNative)
  const attentionOnly = useValue($membershipAttentionOnly)
  const accounts = useQuery(membershipQuery(native, identity))
  const rawDraft = useValue($membershipDraft)
  const rawNotice = useValue($membershipNotice)
  const rawBusy = useValue($membershipBusy)
  const snapshot = useValue($membershipSnapshot)
  // Every hook runs on every render: no conditional useValue here.
  const catalogue = plans.data || {}

  // State that belongs to another identity is not shown, not edited and not
  // cleared by whoever finishes later. Derived, not copied: a draft typed in
  // this identity survives anything the previous one is still doing.
  const draft = rawDraft && rawDraft.origin === identity ? rawDraft : null
  const notice = rawNotice && rawNotice.origin === identity ? rawNotice : null
  const busy = membershipBusyKey(rawBusy, identity)
  const current = snapshot && snapshot.identity === identity ? snapshot : null

  // A change of identity is a different backend, not a refresh. Only state that
  // belongs elsewhere is dropped, so the effect can never delete a draft that
  // was opened in the identity now on screen.
  useEffect(() => {
    if (!membershipIdentityCurrent(identity)) return
    const held = $membershipSnapshot.get()
    if (held && held.identity !== identity) $membershipSnapshot.set(null)
    const typed = $membershipDraft.get()
    if (typed && typed.origin !== identity) $membershipDraft.set(null)
    const custom = $customPlanDraft.get()
    if (custom && custom.origin !== identity) $customPlanDraft.set(null)
    const exhaustion = $exhaustionDraft.get()
    if (exhaustion && exhaustion.origin !== identity) $exhaustionDraft.set(null)
    const said = $membershipNotice.get()
    if (said && said.origin !== identity) $membershipNotice.set(null)
    const working = $membershipBusy.get()
    if (working && working.origin !== identity) $membershipBusy.set(null)
    $membershipNative.set(false)
    $membershipAttentionOnly.set(false)
    // The request log is deliberately *not* cleared: it is already bounded, and
    // wiping it would erase the very requests that failed to load.
  }, [identity])

  useEffect(() => {
    if (!accounts.data) return
    // Stamped with the identity that produced it; never adopted from another.
    if (accounts.data.identity !== identity || !membershipIdentityCurrent(identity) ||
        accounts.data.read !== latestMembershipRead.get(identity)) return
    $membershipSnapshot.set({ identity, accounts: accounts.data.accounts,
                              store: accounts.data.store, notes: accounts.data.notes })
  }, [accounts.data, identity])

  const list = current ? membershipAccounts(current) : []
  const accountsReady = !!current
  const attention = needsAttention(list)
  const attentionIds = new Set(attention.map(item => item.account.id))
  const displayed = attentionOnly ? list.filter(account => attentionIds.has(account.id)) : list
  const jumpToAccount = account => {
    try {
      const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
      document.querySelector(`[data-account="${account.id}"]`)
        ?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' })
    } catch {}
  }
  const summary = membershipSummary(list)
  const storeError = current?.store?.error || ''
  const storeNotes = Array.isArray(current?.notes) ? current.notes : []
  const plansError = plans.error ? membershipErrorText(plans.error, 'plans') : ''

  const refuse = () => {
    setMembershipNotice(membershipIdentityNow(), 'warn',
      'That action belongs to a different connection. Reload the pane before changing anything.')
    return { ok: false, stale: true }
  }

  const refuseBusy = () => {
    setMembershipNotice(identity, 'warn', 'Another membership action is still processing. Please wait and try again.')
    return { ok: false, busy: true }
  }

  /**
   * One write, bound to the identity it started in. The identity is checked
   * before the request and again after it, so nothing started here can write
   * through a transport that now belongs to something else, and a reply that
   * arrives after a switch is dropped rather than shown as the new identity's
   * result.
   */
  const run = async (key, path, body, method = 'POST') => {
    const captured = membershipIdentityNow()
    if (captured !== identity) return refuse()
    const generation = gatewayActivationEpoch()
    const operation = claimMembershipBusy(captured, key)
    if (!operation) return refuseBusy()
    try {
      membershipTrace({ method, path, identity: captured, generation, outcome: 'write' })
      await membershipWrite(method, path, body)
      if (!membershipOperationCurrent(captured, operation)) return { ok: false, stale: true }
      // The write returns raw store records; the canonical read restores the
      // computed fee, quota and plan-choice fields. If that read fails the write
      // is still done — say exactly that rather than announcing a clean success.
      try {
        const payload = await queryClient.fetchQuery({
          ...membershipQuery($membershipNative.get(), captured, generation, operation), staleTime: 0 })
        if (membershipOperationCurrent(captured, operation)) {
          if (payload.read === latestMembershipRead.get(captured)) {
            $membershipSnapshot.set({ identity: captured, accounts: payload.accounts,
                                      store: payload.store, notes: payload.notes })
          }
          setMembershipNotice(captured, 'good', 'Saved.', operation, key)
        }
      } catch (readError) {
        setMembershipNotice(captured, 'warn',
          `Saved, but the list could not be re-read. ${membershipErrorText(readError, 'read')}`, operation)
      }
      await invalidateEconomicsFor(captured)
      return { ok: membershipOperationCurrent(captured, operation), identity: captured }
    } catch (error) {
      setMembershipNotice(captured, 'warn', membershipErrorText(error, 'write'), operation, key)
      return { ok: false, error }
    } finally {
      // Only the identity that holds the flag may clear it.
      releaseMembershipBusy(captured, operation)
    }
  }

  const onAction = (kind, account, value, label) => {
    // Defence in depth: the list is already gated by identity, but a click can
    // land between a switch and the re-render.
    if (!current || current.identity !== membershipIdentityNow()) return refuse()
    if (membershipBusyKey($membershipBusy.get(), identity)) return refuseBusy()
    if (kind === 'api-only' || kind === 'arrangement') {
      const update = kind === 'api-only' ? { api_only: !!value } : { billing_arrangement: value }
      return run(account.id, `/membership/accounts/${encodeURIComponent(account.id)}`,
                 { ...account, ...update }, 'PUT')
    }
    if (kind === 'plan') {
      return run(account.id, `/membership/accounts/${encodeURIComponent(account.id)}`,
                 { ...account, plan_id: value || null }, 'PUT')
    }
    if (kind === 'fee') {
      // The draft carries the identity it was opened in, so a save can tell
      // whether the form it is submitting still belongs to this connection.
      $membershipNotice.set(null)
      $membershipDraft.set({ ...feeDraft(account), origin: membershipIdentityNow() })
      return { ok: true }
    }
    if (kind === 'restore-fee') {
      const fee_overrides = restoreCatalogueFee(account)
      if (!fee_overrides) return refuse()
      return run(account.id, '/membership/accounts/' + encodeURIComponent(account.id),
                 { ...account, fee_overrides }, 'PUT')
    }
    if (kind === 'edit-custom-plan') {
      $customPlanDraft.set(customPlanDraftFor(account, identity))
      return { ok: true }
    }
    if (kind === 'save-custom-plan') {
      if (!value || value.origin !== identity || !membershipIdentityCurrent(value.origin) ||
          value.account_id !== account.id) return refuse()
      const errors = customPlanDraftErrors(value)
      if (errors.length) {
        setMembershipNotice(identity, 'warn', errors.join(' '))
        return { ok: false, invalid: true }
      }
      const custom_plan = customPlanPayload(value, account)
      const outcome = run(account.id, `/membership/accounts/${encodeURIComponent(account.id)}`,
        { ...account, plan_id: custom_plan.id, custom_plan }, 'PUT')
      return Promise.resolve(outcome).then(result => {
        if (result?.ok && $customPlanDraft.get() === value && membershipIdentityCurrent(identity)) {
          $customPlanDraft.set(null)
        }
        return result
      })
    }
    if (kind === 'exhaust') {
      const wholeAccount = value === ACCOUNT_SCOPE
      $exhaustionDraft.set({ origin: identity, account_id: account.id,
        scope_id: wholeAccount ? 'account' : value,
        scope_kind: wholeAccount ? 'account' : 'window',
        label: label || (wholeAccount ? 'Account' : value), reset_local: '' })
      return { ok: true }
    }
    if (kind === 'confirm-exhaust') {
      const draft = $exhaustionDraft.get()
      if (!draft || draft.origin !== identity || draft.account_id !== account.id ||
          !membershipIdentityCurrent(draft.origin)) return refuse()
      const body = { scope_id: draft.scope_id, scope_kind: draft.scope_kind, label: draft.label,
        reset_at: value?.reset_at || null,
        note: 'Manually reported from Spend Sense; not provider-confirmed.' }
      return run(account.id, `/membership/accounts/${encodeURIComponent(account.id)}/exhaustion`, body)
        .then(result => {
          if (result?.ok && $exhaustionDraft.get() === draft && membershipIdentityCurrent(identity)) {
            $exhaustionDraft.set(null)
          }
          return result
        })
    }
    if (kind === 'clear') {
      return run(account.id, `/membership/accounts/${encodeURIComponent(account.id)}/exhaustion/${encodeURIComponent(value)}`,
                 null, 'DELETE')
    }
    return null
  }

  const discover = async () => {
    const captured = membershipIdentityNow()
    if (captured !== identity) return refuse()
    const generation = gatewayActivationEpoch()
    const operation = claimMembershipBusy(captured, 'discover')
    if (!operation) return refuseBusy()
    try {
      membershipTrace({ method: 'POST', path: '/membership/discover?native=true',
                        identity: captured, generation, outcome: 'discover' })
      const result = await membershipWrite('POST', '/membership/discover?native=true')
      if (!membershipOperationCurrent(captured, operation)) return
      if (Array.isArray(result?.accounts)) {
        $membershipSnapshot.set({ identity: captured, accounts: result.accounts,
                                  store: result.store || null, notes: result.notes || [] })
      }
      const summary = `Discovered ${result.discovered ?? 0} account(s): ${result.added?.length ?? 0} new, ${result.updated?.length ?? 0} updated.`
      $membershipNative.set(true)
      try {
        const payload = await queryClient.fetchQuery({ ...membershipQuery(true, captured, generation, operation), staleTime: 0 })
        if (!membershipOperationCurrent(captured, operation) || payload.read !== latestMembershipRead.get(captured)) return
        $membershipSnapshot.set({ identity: captured, accounts: payload.accounts,
                                  store: payload.store, notes: payload.notes })
        setMembershipNotice(captured, 'good', summary, operation)
      } catch (readError) {
        setMembershipNotice(captured, 'warn',
          `${summary} The refreshed list could not be read. ${membershipErrorText(readError, 'read')}`, operation)
      }
      await invalidateEconomicsFor(captured)
    } catch (error) {
      setMembershipNotice(captured, 'warn', membershipErrorText(error, 'discover'), operation)
    } finally {
      releaseMembershipBusy(captured, operation)
    }
  }

  /**
   * Refresh asks for the native query for the identity it started in, and awaits
   * a real result. `queryClient.fetchQuery` rejects on failure, so "Readings
   * refreshed" cannot appear next to a failed read.
   */
  const refreshReadings = async () => {
    const captured = membershipIdentityNow()
    if (captured !== identity) return refuse()
    const generation = gatewayActivationEpoch()
    const operation = claimMembershipBusy(captured, 'refresh')
    if (!operation) return refuseBusy()
    try {
      membershipTrace({ method: 'GET', path: '/membership/accounts?native=true',
                        identity: captured, generation, outcome: 'refresh' })
      const payload = await queryClient.fetchQuery({ ...membershipQuery(true, captured, generation, operation), staleTime: 0 })
      if (!membershipOperationCurrent(captured, operation) || payload.read !== latestMembershipRead.get(captured)) return
      $membershipNative.set(true)
      $membershipSnapshot.set({ identity: captured, accounts: payload.accounts,
                                store: payload.store, notes: payload.notes })
      setMembershipNotice(captured, 'good', 'Readings refreshed from Hermes.', operation)
    } catch (error) {
      setMembershipNotice(captured, 'warn', membershipErrorText(error, 'refresh'), operation)
    } finally {
      releaseMembershipBusy(captured, operation)
    }
  }

  const saveFee = async () => {
    // The fee form is a mutation path like any other: it must prove the draft
    // still belongs to the connection that is on screen *before* it sends
    // anything, including when the switch happens in the same tick as the click.
    const origin = draft?.origin
    if (!draft || !origin || !membershipIdentityCurrent(origin)) return refuse()
    const errors = feeDraftErrors(draft)
    if (errors.length) {
      setMembershipNotice(origin, 'warn', errors.join(' '), null, draft.account_id)
      return { ok: false, invalid: true }
    }
    const account = list.find(a => a.id === draft.account_id)
    if (!account) return refuse()
    const override = overrideFromDraft(draft, account)
    const outcome = await run(account.id, `/membership/accounts/${encodeURIComponent(account.id)}`,
                              { ...account, fee_overrides: [...(account.fee_overrides || []), override] }, 'PUT')
    // The draft survives a failed save: losing what the owner typed because the
    // backend rejected it is the one thing a form must never do. And a draft
    // opened since this save began is not this save's to clear.
    const still = $membershipDraft.get()
    if (outcome?.ok && still === draft && membershipIdentityCurrent(origin)) {
      $membershipDraft.set(null)
    }
    return outcome
  }

  return jsxs('div', { className: 'wm-analytics wm-product', children: [
    jsxs('style', { children: [ANALYTICS_CSS, PRODUCT_CSS, MEMBERSHIP_CSS] }),
    jsxs('div', { className: 'wm-shell wm-memberships', children: [
      jsx(LedgerTabs, {}),
      jsxs('div', { className: 'wm-controls', children: [
        jsx(ProductButton, { type: 'button', className: cn('wm-button', 'wm-accent'), disabled: !!busy,
          onClick: discover, children: busy === 'discover' ? 'Discovering…' : 'Discover accounts' }),
        jsx(ProductButton, { type: 'button', className: 'wm-button', disabled: !!busy,
          onClick: refreshReadings, children: busy === 'refresh' ? 'Refreshing…' : 'Refresh readings' })
      ] }),
      notice ? jsx('div', { className: 'wm-alert', 'data-tone': notice.tone === 'warn' ? 'warn' : 'good',
        role: 'status', children: notice.text }) : null,
      storeError
        ? jsx('div', { className: 'wm-alert', role: 'alert', 'data-tone': 'warn',
            children: 'The membership store on this backend could not be read, so nothing can be saved until it is repaired. Your file has not been changed.' })
        : null,
      plansError
        ? jsx('div', { className: 'wm-alert', role: 'status', 'data-tone': 'warn',
            children: `Plan catalogue unavailable on this connection. ${plansError}` })
        : null,
      jsxs('div', { className: 'wm-stats', children: [
        jsxs('div', { className: 'wm-stat', children: [jsx('div', { className: 'wm-statlabel', children: 'Accounts' }),
          jsx('div', { className: 'wm-statvalue', children: accountsReady ? String(summary.total) : '—' })] }),
        jsxs('div', { className: 'wm-stat', children: [jsx('div', { className: 'wm-statlabel', children: 'Plans confirmed' }),
          jsx('div', { className: 'wm-statvalue', children: accountsReady ? `${summary.withPlan} of ${summary.total}` : '—' })] }),
        jsxs('div', { className: 'wm-stat', children: [jsx('div', { className: 'wm-statlabel', children: 'Marked exhausted' }),
          jsx('div', { className: 'wm-statvalue', children: accountsReady ? String(summary.exhausted) : '—' })] }),
        jsxs('div', { className: 'wm-stat', children: [jsx('div', { className: 'wm-statlabel', children: 'Your declared fees' }),
          jsx('div', { className: 'wm-statvalue', children: accountsReady ? feesLabel(summary) : '—' })] })
      ] }),
      jsx('p', { className: 'wm-note',
        children: 'A declared fee is what you pay; provider percentages are limits, not money, and are never added to it.' }),
      attention.length
        ? jsxs('section', { className: 'wm-attention', 'aria-label': 'Needs attention', children: [
            jsx('h3', { children: 'Needs attention' }),
            jsxs('ul', { children: attention.slice(0, 6).map((item, index) =>
              jsx('li', { 'data-tone': item.tone, children: `${item.account.label || item.account.family}: ${item.text}` }, index)) })
          ] })
        : null,
      storeNotes.length
        ? jsxs('section', { className: 'wm-attention', 'aria-label': 'Backend notes', children: [
            jsx('h3', { children: 'Backend notes' }),
            jsxs('ul', { children: storeNotes.slice(0, 6).map((note, index) => jsx('li', { children: note }, index)) })
          ] })
        : null,
      accounts.error
        ? jsx('div', { className: 'wm-alert', role: 'alert', children: membershipErrorText(accounts.error, 'read') })
        : null,
      accountsReady && list.length > 1
        ? jsxs('nav', { className: 'wm-account-jump', 'aria-label': 'Jump to an account', children: [
            jsx('button', { type: 'button', className: 'wm-account-chip', 'aria-pressed': attentionOnly,
              onClick: () => $membershipAttentionOnly.set(!attentionOnly),
              children: attentionOnly ? `Showing needs attention (${attentionIds.size}) — show all` : `Needs attention only (${attentionIds.size})` }),
            ...list.map(account => jsx('button', { type: 'button', className: 'wm-account-chip',
              'data-attention': attentionIds.has(account.id) ? 'true' : undefined,
              onClick: () => jumpToAccount(account),
              children: (account.label || account.family) + (attentionIds.has(account.id) ? ' · check' : '') }, account.id))
          ] })
        : null,
      jsxs('div', { className: 'wm-cards', children:
        !accountsReady && !accounts.error
          ? [jsx('p', { className: 'wm-empty', role: 'status', children: 'Reading memberships for this connection…' })]
          : accountsReady && displayed.length
            ? displayed.map(account => jsx(MembershipCard, {
                account,
                plans: accountPlanChoices(account),
                busy, onAction, draft, saveFee, catalogue, notice
              }, account.id))
            : [jsx('p', { className: 'wm-empty', children: accounts.error
                ? 'Memberships could not be read for this connection.'
                : attentionOnly ? 'Nothing needs attention. Show all accounts to see every membership.'
                : 'No memberships yet. Use "Discover accounts" to find the providers configured in this Hermes profile.' })] }),
      membershipDiagnostics.length
        ? jsxs('details', { className: 'wm-note', children: [
            jsx('summary', { children: 'Request diagnostics (this session)' }),
            jsx('ul', { children: membershipDiagnostics.map((entry, index) =>
              jsx('li', { children: `${entry.at} ${entry.method} ${entry.path} → ${entry.status ?? entry.outcome} · ${entry.scope}` }, index)) })
          ] })
        : null
    ] })
  ] })
}

function LedgerPage() {
  const t = usePluginI18n(ID)
  const led = useValue($ledger)
  const range = useValue($range)
  const view = useValue($view)
  const tab = useValue($ledgerTab)
  useValue($membershipIdentity)
  const storageError = useValue($storageError)
  const { rows, totals } = useSummary(range)
  const dayCount = Object.keys(led.days).length

  // Esc closes the page, unless the user is typing somewhere.
  useEffect(() => {
    const onKey = e => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      const el = e.target
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return
      if (document.querySelector('[role="dialog"]')) return
      closeLedger()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // The authoritative view is the default; the local ledger stays one click
  // away and remains the fallback when the backend is unreachable.
  if (view === VIEW_ALL) {
    if (tab === 'costs' || tab === 'billing') return jsx(CostsPage, {})
    if (tab === 'memberships') return jsx(MembershipsPage, {})
    if (tab === 'overview') return jsx(OverviewPage, {})
    if (tab === 'settings') return jsx(SettingsPage, {})
    return jsx(AnalyticsPage, { productPage: true })
  }

  const cells = r => {
    const pct = hitPctOf(r)
    const approx = r.cacheEstimated ? '≈' : ''
    const warn = r.legacy ? r.legacyOrigin === 'foreign' : num(r.sources.foreign) || r.unpricedTokens
    return [
      jsxs('td', {
        className: 'py-1.5 pr-3',
        children: [
          jsx('div', { children: r.model }),
          jsx('div', {
            className: 'text-[0.625rem] text-(--ui-text-quaternary)',
            children: [r.profile, r.provider || (r.legacy ? null : t('providerUnknown'))].filter(Boolean).join(' · ') || null
          })
        ]
      }),
      jsx('td', { className: 'py-1.5 pr-3 text-right tabular-nums', children: `${approx}${fmtTokens(r.input)}` }),
      jsx('td', { className: 'py-1.5 pr-3 text-right tabular-nums', children: fmtTokens(r.output) }),
      jsx('td', { className: 'py-1.5 pr-3 text-right tabular-nums text-(--ui-text-tertiary)', children: `${approx}${fmtTokens(r.cacheRead)}` }),
      jsx('td', { className: 'py-1.5 pr-3 text-right tabular-nums text-(--ui-text-tertiary)', children: String(r.calls) }),
      jsx('td', { className: 'py-1.5 pr-3 text-right tabular-nums', children: pct == null ? '—' : `${approx}${Math.round(pct)}%` }),
      jsx('td', { className: 'py-1.5 pr-3 text-right tabular-nums text-(--ui-accent)', children: num(r.netSavingsPrompt) && num(r.netSavingsPrompt) === num(r.input) + num(r.cacheRead) + num(r.cacheWrite) ? `${approx}${fmtUsd(r.netSavings)}` : '—' }),
      jsxs('td', {
        className: 'py-1.5 text-right tabular-nums',
        children: [
          jsx('div', { children: r.cost == null ? '—' : `${r.unpricedTokens && r.cost != null ? '≥' : ''}${fmtUsd(r.cost)}` }),
          jsx('div', {
            className: cn('text-[0.625rem]', warn ? 'text-(--ui-warning)' : 'text-(--ui-text-quaternary)'),
            children: rowBasis(t, r)
          })
        ]
      })
    ]
  }

  const head = ['modelCol', 'input', 'output', 'cacheRead', 'calls', 'hitRate', 'saved', 'cost'].map((k, i) =>
    jsx('th', {
      className: cn('pb-1.5 font-medium text-(--ui-text-quaternary)', i === 0 ? 'pr-3 text-left' : 'pr-3 text-right', k === 'cost' && 'pr-0'),
      children: t(k)
    }, k)
  )

  return jsxs('div', {
    className: 'mx-auto flex w-full max-w-3xl flex-col gap-4 p-6',
    children: [
      jsxs('div', {
        className: 'flex flex-wrap items-center justify-between gap-3',
        children: [
          jsx('h1', { className: 'text-base font-semibold', children: t('pageTitleDesktop') }),
          jsxs('div', {
            className: 'flex flex-wrap items-center gap-2',
            children: [
              jsx(ViewToggle, { t, view }),
              jsx(SegmentedControl, {
                onChange: v => $range.set(v),
                options: ['today', 'week', 'month', 'all'].map(id => ({ id, label: t(`range_${id}`) })),
                value: range
              }),
              jsx(CloseButton, { t })
            ]
          })
        ]
      }),
      jsxs('div', {
        className: 'flex flex-wrap items-baseline gap-2',
        children: [
          jsx('div', {
            className: 'text-3xl font-semibold tabular-nums text-(--ui-accent)',
            children: totals.known ? `${totals.unpricedTokens ? '≥' : ''}${fmtUsd(totals.cost)}` : '—'
          }),
          jsx('span', { className: 'text-xs text-(--ui-text-quaternary)', children: t('grandHint') })
        ]
      }),
      jsx('div', {
        className: 'text-xs text-(--ui-text-tertiary)',
        children: led.since ? t('coverage', led.since, dayCount, KEEP_DAYS) : t('coverageNone')
      }),
      totals.hitPct != null
        ? jsxs('div', {
            className: 'flex flex-col gap-1.5',
            children: [
              jsxs('div', {
                className: 'flex items-baseline justify-between text-xs text-(--ui-text-tertiary)',
                children: [
                  jsx('span', { children: `${t('hitRate')} ${totals.cacheEstimated ? '≈' : ''}${Math.round(totals.hitPct)}%` }),
                  jsx('span', { children: `${t('savedTotal')} ${totals.cacheEstimated ? '≈' : ''}${fmtUsd(totals.netSavings)}` })
                ]
              }),
              jsx(CacheBar, { pct: totals.hitPct })
            ]
          })
        : null,
      ...rangeNotes(t, totals, storageError),
      rows.length
        ? jsxs('table', {
            className: 'w-full text-xs',
            children: [
              jsx('thead', { children: jsx('tr', { children: head }) }),
              jsx('tbody', {
                children: rows.map((r, i) =>
                  jsx('tr', { className: 'border-b border-(--ui-stroke-secondary) align-top', children: cells(r) }, `${i}`)
                )
              })
            ]
          })
        : jsx('div', {
            className: 'rounded-md border border-(--ui-stroke-secondary) p-6 text-center text-xs text-(--ui-text-quaternary)',
            children: t('noLedger')
          }),
      jsxs('div', {
        className: 'flex flex-wrap items-center gap-2',
        children: [
          jsx(Button, { disabled: !dayCount, onClick: () => exportLedger('csv', t), size: 'sm', variant: 'outline', children: t('exportCsv') }),
          jsx(Button, { disabled: !dayCount, onClick: () => exportLedger('json-copy', t), size: 'sm', variant: 'ghost', children: t('copyJson') })
        ]
      }),
      jsx('p', { className: 'text-[0.6875rem] leading-relaxed text-(--ui-text-quaternary)', children: t('disclaimer') })
    ].filter(Boolean)
  })
}

/* ------------------------------------------------------------------- i18n */

const I18N = {
  en: {
    basisLegacy: 'pre-1.0 data · at current rates',
    basisMixed: 'mixed rate sources',
    cacheEstNote: '≈ The gateway cache split is reconstructed or incomplete; cache figures and savings are estimates.',
    cacheCoverageDetail: (exact, estimated) => `${exact}% exact · ${estimated}% estimated`,
    cacheCoverageLine: (coverage, detail) => `${coverage}% of prompt tokens covered · ${detail}`,
    cacheCoverageRange: coverage => `${coverage}% of prompt tokens covered by cache data`,
    cacheCoveragePrompt: coverage => `${coverage} of prompt tokens covered`,
    cacheCoverageUnavailable: 'Prompt coverage unavailable',
    cacheCoverageBasis: 'Based on recorded cache activity · see details',
    weightedCacheHit: 'Weighted cache hit',
    cacheRead: 'Cache read',
    cacheTitle: 'Prompt cache',
    cacheWrite: 'Cache write',
    close: 'Close',
    closeTip: 'Close (Esc)',
    calls: 'Calls',
    chipTip: (model, source, today, hit, saved) =>
      `${model} — cost ${source}. Today ${today}. Cache hit ${hit}; theoretical net cache savings ${saved}. Click for details.`,
  chipTipIdle: 'Spend Sense — click for details',
    context: 'Context',
    copied: 'Ledger JSON copied to the clipboard.',
    copyJson: 'Copy JSON',
    cost: 'Cost',
    coverage: (since, n, keep) => `Recorded since ${since} · ${n} day(s) with usage · daily totals kept ${keep} days`,
    coverageNone: 'Nothing recorded yet.',
    csvCopied: 'Download unavailable — CSV copied to the clipboard instead.',
    disclaimer:
      'Estimates. Costs are settled when usage is recorded, from the serving provider’s catalog $/Mtok (or the bundled models.dev table), not a billing API; subscription routes (Copilot, Nous credits) bill differently. The ledger is stored locally and only records usage seen while the plugin was running.',
    empty: 'No usage recorded for this conversation yet — it appears after the next reply.',
    historyNote: d => `Conversation total since ${d}, across restarts. New replies keep adding to it.`,
    cumulativeNote: d => `Conversation total since ${d}, including earlier runs.`,
    exportCsv: 'Export CSV',
    exportFailed: 'Export failed.',
    foreignNote: n => `⚠ ${n} tokens were priced with another provider’s rates — they may not match your route.`,
    grandHint: 'estimated, settled at record time',
    hitRate: 'Hit rate',
    idle: 'tokens —',
    input: 'Input',
    legacyNote: n => `${n} tokens come from the pre-1.0 ledger, which stored no provider or price; they are estimated at current rates and may change.`,
    loadingPrice: 'Loading pricing…',
    modelCol: 'Model',
    navLabel: 'Spend Sense',
    noLedger: 'Nothing recorded in this range. Usage is folded in as turns complete.',
    noPrice: 'n/a',
    noPriceLong: 'No rate for this model in the provider catalog or the bundled models.dev table. Run scripts/gen-rates.py to refresh it.',
    output: 'Output',
  pageTitle: 'Spend Sense',
    pageTitleDesktop: 'Spend Sense — this desktop',
    allHermesTitle: 'Spend Sense',
    viewAll: 'All Hermes',
    viewDesktop: 'This desktop',
    allHermesHint:
      'Timestamped calls captured since this plugin was enabled. The historical baseline is read separately from state.db and is never added to the period.',
    allHermesEmpty: 'No usage recorded in this window.',
    backendUnavailable: 'The Spend Sense backend is not reachable.',
    backendLoading: 'Reading the timestamped ledger…',
    backendRetry: 'Retry',
    backendUseDesktop: 'Use this desktop’s ledger',
    statBasis: 'API-equivalent',
    statBilled: 'Billed',
    statList: 'API-equivalent',
    statCalls: 'Calls',
    statCoverage: 'Priced tokens',
    upperHint: amount => `up to ${amount} where context tiers apply`,
    listHint: 'context tiers may raise this',
    perCallList: 'per-call list, exact tiers',
    basisMode: b => `basis: ${b}`,
    basis_hybrid: 'Both',
    basis_billed: 'Billed',
    basis_list: 'API rates',
    perCallExact: 'exact per-call pricing',
    class_actual: 'actual',
    class_estimated: 'estimated',
    class_included: 'included',
    class_unknown: 'unknown',
    recordedSince: d => `Recorded since ${d}`,
    notRecordingYet: 'No timestamped calls recorded yet; the historical baseline is below.',
    reconciled: (captured, delta) => `Reconciled: captured ${captured} of ${delta} tokens since baseline.`,
    reconcileGap: (gap, delta) => `Recording gap: ${gap} of ${delta} tokens not captured.`,
    reconcileOver: n => `Captured ${n} tokens more than state.db growth (possible retries or pruning).`,
    noBaseline: 'Historical baseline not captured yet.',
    stateUnavailable: 'state.db unavailable for reconciliation.',
    noGrowth: 'No state.db growth since baseline yet.',
    eventsLine: (calls, failures, missing) => `${calls} calls · ${failures} failures · ${missing} missing usage`,
    baselineTitle: 'Historical baseline — cumulative estimate, not period usage',
    baselineTokens: 'Tokens (all time)',
    baselineRouteLine: (name, tokens, list, billed) => `${name} — ${tokens} · API ${list} · billed ${billed}`,
    billedPartial: 'some routes have no recorded charge',
    unpricedTokens: n => `${n} unpriced`,
    unpricedTitle: 'Unpriced usage (no rate for that route/model)',
    unpricedLine: (provider, model, tokens, reason) => `${provider} · ${model} — ${tokens} — ${reason}`,
    limitsTitle: 'How these numbers are made',
    rateCard: (source, asOf) => `Rates: ${source}${asOf ? ` · ${asOf}` : ''}`,
    refresh: 'Refresh',
    groupName: 'Name',
    group_route: 'Route',
    group_model: 'Model',
    group_surface: 'Surface',
    group_task: 'Task',
    models: 'models',
    unknown: 'unknown',
    unpriced: 'unpriced',
    status_complete: 'complete',
    status_partial: 'partial',
    status_unpriced: 'unpriced',
    status_empty: 'empty',
    providerTip: slug => `Serving provider: ${slug}`,
    providerUnknown: 'provider ?',
    providerUnknownTip: 'The serving provider could not be confirmed — any price shown is an estimate.',
    scopeRun: 'this run',
    scopeConversation: 'conversation',
    scopeTotalsConversation: 'Conversation totals',
    scopeTotalsRun: 'This run’s totals',
    derivedMark: ' · derived',
    inclDerived: ' · incl. derived cache',
    ratesNote:
      'Rates come from the WolfMark catalogue card, not the provider’s invoice. Hermes may show a different estimate when its own route or peak/off-peak pricing differs.',
    range_all: 'All recorded',
    range_month: 'This month',
    range_today: 'Today',
    range_week: '7 days',
    rates: 'Rates ($/Mtok)',
    saved: 'Net savings',
    savedTotal: 'Theoretical net cache savings',
    sessionTokens: 'This session',
    src_backend: 'Hermes backend estimate',
    src_bundled: 'estimated from models.dev rates',
    src_foreign: slug => `⚠ rates borrowed from ${slug} — may not match your route`,
    src_fallback: slug => `estimate at ${slug} rates — no exact rate for this route`,
    src_gateway: 'reported by gateway',
    src_live: 'computed from catalog pricing',
    src_none: 'pricing unavailable',
    src_mixed: 'mixed pricing sources',
    src_remembered: 'remembered catalog rates',
    src_unconfirmed: slug => `⚠ provider unconfirmed — rates borrowed from ${slug}`,
    storageError: msg => `⚠ The ledger could not be saved (${msg}). New usage is kept only until Hermes restarts.`,
    today: 'today',
    total: 'Total',
    unpricedNote: n => `${n} tokens had no known rate and are not in the total (shown as ≥).`
  },
  zh: {
    basisLegacy: '1.0 前旧数据 · 按现价估算',
    basisMixed: '多种价格来源',
    cacheEstNote: '≈ 网关缓存拆分是推算值或不完整；缓存数据及节省额均为估算。',
    cacheCoverageDetail: (exact, estimated) => `精确 ${exact}% · 估算 ${estimated}%`,
    cacheCoverageLine: (coverage, detail) => `提示词令牌覆盖率 ${coverage}% · ${detail}`,
    cacheCoverageRange: coverage => `缓存数据覆盖提示词令牌的 ${coverage}%`,
    cacheCoveragePrompt: coverage => `提示词令牌覆盖率 ${coverage}`,
    cacheCoverageUnavailable: '提示词覆盖率不可用',
    cacheCoverageBasis: '基于已记录的缓存活动 · 查看详情',
    weightedCacheHit: '加权缓存命中率',
    cacheRead: '缓存读取',
    cacheTitle: '提示词缓存',
    cacheWrite: '缓存写入',
    close: '关闭',
    closeTip: '关闭（Esc）',
    calls: '调用',
    chipTip: (model, source, today, hit, saved) =>
      `${model} — 费用${source}。今日 ${today}。缓存命中 ${hit}，理论缓存净节省 ${saved}。点击查看明细。`,
  chipTipIdle: 'WolfMark 成本账本 — 点击查看详情',
    context: '上下文',
    copied: '账本 JSON 已复制到剪贴板。',
    copyJson: '复制 JSON',
    cost: '花费',
    coverage: (since, n, keep) => `自 ${since} 起记录 · 有用量的天数 ${n} · 按日汇总保留 ${keep} 天`,
    coverageNone: '尚无记录。',
    csvCopied: '无法下载，已改为把 CSV 复制到剪贴板。',
    disclaimer:
      '仅为估算。金额在记录用量时按实际承载线路的目录单价（或内置 models.dev 价格表）结算，并非账单接口；订阅制线路（Copilot、Nous 额度等）的实际计费不同。账本保存在本地，且只记录插件运行期间观察到的用量。',
    empty: '这个会话还没有记录到用量，下一次回复后会显示。',
    historyNote: d => `自 ${d} 起的会话累计（重启后保留），继续对话会接着累加。`,
    cumulativeNote: d => `自 ${d} 起的会话累计，包含之前的运行。`,
    exportCsv: '导出 CSV',
    exportFailed: '导出失败。',
    foreignNote: n => `⚠ 有 ${n} 令牌借用了其他供应商的价格，可能与你的线路不符。`,
    grandHint: '估算值，记录时结算',
    hitRate: '命中率',
    idle: '令牌 —',
    input: '输入',
    legacyNote: n => `有 ${n} 令牌来自 2.0 之前的账本，当时没有记录供应商和价格，现按当前单价估算，数值可能变化。`,
    loadingPrice: '正在加载价格…',
    modelCol: '模型',
    navLabel: 'WolfMark 成本账本',
    noLedger: '该区间没有记录。每轮对话结束后会自动累加。',
    noPrice: '无',
    noPriceLong: '供应商目录与内置 models.dev 价格表中都没有该模型。可运行 scripts/gen-rates.py 刷新价格表。',
    output: '输出',
  pageTitle: 'WolfMark 成本账本',
    providerTip: slug => `实际承载线路：${slug}`,
    providerUnknown: '供应商未知',
    providerUnknownTip: '无法确认实际承载的供应商——显示的价格均为借用。',
    range_all: '全部记录',
    range_month: '本月',
    range_today: '今日',
    range_week: '近 7 天',
    rates: '单价（$/百万令牌）',
    saved: '净节省',
    savedTotal: '理论缓存净节省',
    scopeRun: '本轮',
    scopeConversation: '对话',
    scopeTotalsConversation: '对话总计',
    scopeTotalsRun: '本轮总计',
    derivedMark: ' · 推算',
    inclDerived: ' · 含推算缓存',
    ratesNote:
      '费率来自 WolfMark 目录卡，而非供应商账单。Hermes 自身可能采用不同路线或峰谷费率，因此估算可能不同。',
    sessionTokens: '本次会话',
    src_backend: 'WolfMark 后端估算',
    src_bundled: '按 models.dev 单价估算',
    src_foreign: slug => `⚠ 借用了 ${slug} 的价格，可能与你的线路不符`,
    src_gateway: '来自网关',
    src_live: '按目录价格计算',
    src_none: '价格不可用',
    src_mixed: '多种计价来源',
    src_remembered: '历史目录价格',
    src_unconfirmed: slug => `⚠ 供应商未确认，借用了 ${slug} 的价格`,
    storageError: msg => `⚠ 账本保存失败（${msg}）。新用量只保留到 Hermes 重启前。`,
    today: '今日',
    total: '合计',
    unpricedNote: n => `有 ${n} 令牌没有可用单价，未计入总额（显示为 ≥）。`
  }
}

/* --------------------------------------------------------------- register */

export default {
  id: ID,
  name: 'Spend Sense',
  description: 'Hermes usage accounting, provider-aware cost estimates, memberships, and live session usage.',
  register(ctx) {
    pluginLifetime++
    storage = ctx.storage
    ctx.setInterval(() => $membershipActivation.set(gatewayActivationEpoch()), 250)
    ctx.setInterval(() => $membershipClock.set(Date.now()), 30_000)
    osApi = ctx.os || null
    rest = typeof ctx.rest === 'function' ? ctx.rest : null
    const { ledger, migrated } = readStoredLedger(ctx.storage)
    $ledger.set(ledger)
    if (migrated) saveLedger(ledger)
    $range.set(ctx.storage.get('range', 'today'))
    $view.set(ctx.storage.get('view', VIEW_ALL))
    $group.set(ctx.storage.get('group', 'route'))
    $basis.set(ctx.storage.get('basis', 'hybrid'))
    $automaticModelOptions.set(Boolean(ctx.storage.get('automatic-model-options', false)))
    ctx.onDispose($range.listen(v => ctx.storage.set('range', v)))
    ctx.onDispose($view.listen(v => ctx.storage.set('view', v)))
    ctx.onDispose($group.listen(v => ctx.storage.set('group', v)))
    ctx.onDispose($basis.listen(v => ctx.storage.set('basis', v)))
    ctx.onDispose($automaticModelOptions.listen(v => ctx.storage.set('automatic-model-options', Boolean(v))))
    ctx.onDispose(() => {
      pluginLifetime++
      storage = null
      osApi = null
      rest = null
      chains.clear()
      storedIds.clear()
    })

    ctx.i18n.register(I18N)

    // Remember where the user came from however they reach the page
    // (status chip, sidebar nav, palette), so "close" returns there.
    rememberRoute()
    window.addEventListener('hashchange', onHashChange)
    ctx.onDispose(() => window.removeEventListener('hashchange', onHashChange))

    // --- ledger intake -------------------------------------------------
    // message.complete carries the authoritative final usage of a turn;
    // session.usage is the mid-turn tick (applyUsage no-ops on a zero delta).
    const intake = event => {
      const usage = event && event.payload && event.payload.usage
      if (usage && event.session_id) enqueueUsage(event.session_id, usage)
    }
    ctx.onEvent('message.complete', intake)
    ctx.onEvent('session.usage', intake)
    learnStoredId()
    if (host.state.focusedStoredSessionId) {
      ctx.onDispose(host.state.focusedSessionId.listen(learnStoredId))
      ctx.onDispose(host.state.focusedStoredSessionId.listen(learnStoredId))
    }

    // Safety net: fold the focused session's live numbers on a slow timer.
    ctx.setInterval(() => {
      const sid = host.state.focusedSessionId.get()
      const usage = host.state.focusedUsage.get()
      if (sid && usage) enqueueUsage(sid, usage)
    }, 30_000)

    // --- UI ------------------------------------------------------------
    ctx.register({
      id: 'pane',
      area: 'panes',
      title: 'Spend Sense',
      data: PANE_DATA,
      render: () => jsx(Meter, {})
    })
    ctx.register({ id: 'chip', area: 'statusBar.right', order: 120, render: () => jsx(Chip, {}) })
    ctx.register({
      id: 'page',
      area: 'routes',
      title: 'Spend Sense',
      data: { path: LEDGER_ROUTE },
      render: () => jsx(LedgerPage, {})
    })
    ctx.register({
      id: 'nav',
      area: 'sidebar.nav',
      data: { codicon: 'graph', label: 'Spend Sense', path: LEDGER_ROUTE }
    })
  }
}

/** Pure internals, exported for the node test-suite (the host only reads `default`). */
export const __test = {
  analyticsDistribution, analyticsTrend, analyticsComposition, analyticsSort, analyticsPricing, analyticsInsights, analyticsExplorerCsv, explorerUnitCosts, deltaText,
  AnalyticsPage, AnalyticsDashboard, AnalyticsDistribution, AnalyticsTrendChart, AnalyticsRanking, AnalyticsComposition,
  AnalyticsExplorer, AnalyticsEconomics, AnalyticsBaseline, AnalyticsDelegation, ANALYTICS_CSS, ANALYTICS_COLUMNS,
  backendQuery, catalogQuery, liveProvider, sameModel, getCatalog, ensureBackendRate, $view, $automaticModelOptions,
  // Memberships: page, scope, error classification and diagnostics are exported
  // so the real-React harness can drive them without a live Desktop.
  membershipScopeOf, membershipScopeNow, membershipScopeCurrent,
  membershipIdentityNow, membershipIdentityCurrent,
  membershipErrorKind, membershipErrorText, membershipErrorMessage, membershipAccounts,
  membershipWrite, membershipDiagnostics,
  $membershipScope, $membershipSnapshot, $membershipNotice,
  $membershipBusy, $membershipNative, $membershipAttentionOnly, $membershipDraft, $scopeConnection, $scopeProfile,
  fmtMoney, feeLabel, quotaRows, needsAttention, membershipSummary, feesLabel, accountPlanChoices,
  excludedPlansNote, planOptionLabel,
  proposalText, feeDraft, feeDraftErrors, ACCOUNT_SCOPE, accountHolderMarked, overrideFromDraft, feeReasons, feeCurrencies,
  OVERRIDE_REASON_FALLBACK, REASON_LABELS, restoreCatalogueFee, MembershipsPage, MembershipCard, MEMBERSHIP_CSS,
  billingWrite, billingErrorMessage, billingEvidence, evidenceForMode, profileDraftErrors, profilePayload,
  billingNumberStep,
  economicsQuery, fxQuery, fxWrite, fxErrorMessage, fmtDay, econStatusLabel, econCoverageLabel, econFeeLines,
  econWindowLines, windowSpanLabel, invalidateEconomicsFor,
  EconomicsPanel, EconomicsSection, EconomicsBars, EconomicsAccountRow, EconomicsTrend, EconomicsFx, ECONOMICS_CSS,
  $fxDraft, $fxSaving, $fxNotice,
  AdvancedBillingRules, profileDraft, billingQuery, billingSummaryQuery, pricingStatusQuery, membershipPlansQuery,
  CostsPage, OverviewPage, SettingsPage, LedgerTabs, LEDGER_TABS, goLedgerTab, $ledgerTab, $billingPresentation, BrandMark, PRODUCT_CSS,
  settledDesktopMonth, customPlanDraftFor, customPlanDraftErrors, customPlanPayload, fmtCountdown,
  analyticsInitialState, analyticsReduce, analyticsQuery, analyticsScope, analyticsDispatch, $analytics,
  setRest: value => { rest = value },
  PANE_DATA,
  applyUsage,
  bundledLookup,
  csvCell,
  daysAgoKey,
  dayKey,
  emptyLedger,
  liveScope,
  enqueueUsage,
  findPricing,
  providerMatches,
  closeLedger,
  isLedgerRoute,
  ledgerCsv,
  onHashChange,
  openLedger,
  legacyPricer,
  migrateV1,
  readStoredLedger,
  readUsage, cacheCoverage, cacheCoverageDetail, cacheCoverageLine,
  resolveRates,
  summarize,
  sourceLabel, sourceFallback, SOURCE_FALLBACKS, scopeTotalsTitle, tokenRows, I18N,
  fmtUsd, fmtTokens, fmtDate, tokensOf, hitPctOf, cacheSavings, liveSavings,
  $ledger
}
