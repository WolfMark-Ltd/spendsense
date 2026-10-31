// node --test test/analytics.test.mjs — real plugin, SDK-only rendering double.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
const source = readFileSync(new URL('../desktop/plugin.js', import.meta.url), 'utf8')
const stub = `
const atom = value => ({ get: () => value, set: next => { value = next }, listen: () => () => {} })
const computed = (stores, cb) => {
  const list = Array.isArray(stores) ? stores : [stores]
  return { get: () => cb(...list.map(s => s.get())), listen: () => () => {} }
}
const gatewayActivationEpoch = () => globalThis.analyticsEpoch ?? 0
const host = globalThis.analyticsHost = { state: { profile: atom('default'), gateway: atom('connected'), connectionId: atom('local'), model: atom(''), focusedSessionId: atom(null), focusedStoredSessionId: atom(null), focusedSessionProfile: atom('default'), focusedUsage: atom(null) }, profileRoutes: async () => {
 (globalThis.analyticsRouteCalls ||= []).push('profileRoutes')
 return [{connectionId:'local',profile:'default'}]
}, request: async (method, params) => globalThis.__catalog ? globalThis.__catalog(method, params) : null }
const cn = (...xs) => xs.filter(Boolean).join(' ')
const jsx = (type, props, key) => ({type, props: props || {}, key}), jsxs = jsx
const Badge = 'badge', Button = 'button', Codicon = 'icon', SegmentedControl = 'segments', Tip = 'tip'
const useValue = store => { globalThis.analyticsSubscriptions?.push(store); return store.get() }
const useEffect = () => {}
const usePluginI18n = () => key => key
const useQuery = q => { globalThis.analyticsQueries.push(q); return globalThis.analyticsResponse || {isLoading:true} }
const queryClient = { fetchQuery: async q => q.queryFn(), getQueryData: () => null }
`
const body = source.replace(/import \{[^}]*\} from '@hermes\/plugin-sdk'\n/, stub)
 .replace(/import \{ useEffect \} from 'react'\n/, '')
 .replace(/import \{ jsx, jsxs \} from 'react\/jsx-runtime'\n/, '')
const dir = mkdtempSync(join(tmpdir(), 'analytics-test-'))
const file = join(dir, 'plugin.mjs')
writeFileSync(file, body)
const { __test: T } = await import(pathToFileURL(file))
globalThis.analyticsQueries = []
function render(node) {
 if (node == null || typeof node !== 'object') return node
 if (Array.isArray(node)) return node.map(render)
 if (typeof node.type === 'function') return render(node.type(node.props))
 return {...node, props:{...node.props,children:render(node.props.children)}}
}
function nodes(node, predicate) {
 if (!node || typeof node !== 'object') return []
 if (Array.isArray(node)) return node.flatMap(x => nodes(x,predicate))
 return [...(predicate(node) ? [node] : []), ...nodes(node.props?.children,predicate)]
}
function text(node) {
 if (node == null || typeof node === 'boolean') return ''
 if (typeof node !== 'object') return String(node)
 if (Array.isArray(node)) return node.map(text).join(' ')
 return text(node.props.children)
}

test('top-N conserves priced subtotal, excludes unknown prices and exposes exact remainder', () => {
 assert.equal(typeof T.analyticsDistribution, 'function', 'distribution helper is exported')
 const rows = Array.from({length:9}, (_,i) => ({model:`m${i}`,provider:'p',tokens:100-i,list_usd:i === 8 ? null : 8-i,unpriced_tokens:i===8?92:0}))
 const result = T.analyticsDistribution(rows,'cost','model',6)
 assert.equal(result.total,36)
 assert.equal(result.items.length,7)
 assert.equal(result.items.reduce((s,x)=>s+x.value,0),36)
 assert.equal(result.items.at(-1).other,true)
 assert.deepEqual(result.remainder.map(x=>x.model),['m6','m7'])
 assert.equal(result.unpricedTokens,92)
 assert.equal(result.items.reduce((s,x)=>s+x.share,0),1)
 const tokens = T.analyticsDistribution(rows,'tokens','model',6)
 assert.equal(tokens.total,864)
 assert.equal(tokens.remainder.length,3)
 assert.deepEqual(T.analyticsDistribution([], 'cost','provider').items,[])
})

test('timestamp stacks use true elapsed time and preserve missing cost components as gaps', () => {
 assert.equal(typeof T.analyticsTrend, 'function', 'trend helper is exported')
 const rows = [
  {ts:'2026-10-29T00:00:00Z',input_tokens:3,output_tokens:2,cache_read_tokens:5,cache_write_tokens:1,list_usd:9},
  {ts:'2026-10-29T01:00:00Z',input_tokens:0,output_tokens:4,cache_read_tokens:0,cache_write_tokens:0,list_usd:null},
  {ts:'2026-10-29T04:00:00Z',input_tokens:9,output_tokens:0,cache_read_tokens:0,cache_write_tokens:0,list_usd:0}
 ]
 const token = T.analyticsTrend(rows,'tokens')
 assert.deepEqual(token.points.map(p=>p.x),[0,.25,1])
 assert.deepEqual(token.points[0].values,[3,2,5,1])
 assert.equal(token.max,11)
 const cost = T.analyticsTrend(rows,'cost')
 assert.deepEqual(cost.points[0].values,null,'total dollars must not be fabricated into category costs')
 assert.equal(cost.points[1].total,null)
 assert.equal(cost.points[2].total,0)
 assert.equal(cost.stacked,false)
 assert.deepEqual(T.analyticsTrend([],'tokens').points,[])
 const composition = T.analyticsComposition(rows[0])
 assert.equal(composition.reduce((s,r)=>s+r.value,0),11)
 assert.ok(composition.every(x=>Number.isFinite(x.share)))
})

test('all explorer columns sort deterministically, preserve negative savings and put nulls last', () => {
 assert.equal(typeof T.analyticsSort,'function','sort helper is exported')
 const rows = [
  {model:'b',provider:'z',calls:1,list_usd:null,cache_hit_rate:null,economics:{savings_usd:null}},
  {model:'a',provider:'y',calls:4,list_usd:0,cache_hit_rate:0,economics:{savings_usd:-2}},
  {model:'c',provider:'x',calls:2,list_usd:5,cache_hit_rate:.8,economics:{savings_usd:3}}
 ]
 assert.deepEqual(T.analyticsSort(rows,'list_usd','asc').map(r=>r.model),['a','c','b'])
 assert.deepEqual(T.analyticsSort(rows,'list_usd','desc').map(r=>r.model),['c','a','b'])
 assert.deepEqual(T.analyticsSort(rows,'savings','asc').map(r=>r.model),['a','c','b'])
 assert.deepEqual(T.analyticsSort(rows,'model','asc').map(r=>r.model),['a','b','c'])
 assert.deepEqual(T.analyticsSort(rows,'provider','asc').map(r=>r.model),['c','a','b'])
 assert.deepEqual(T.analyticsSort(rows,'calls','desc').map(r=>r.calls),[4,2,1])
 assert.deepEqual(rows.map(r=>r.model),['b','a','c'],'source never mutated')
 assert.equal(T.analyticsPricing({tokens:10,priced_tokens:0,unpriced_tokens:10,list_usd:null}),'Unpriced')
 assert.equal(T.analyticsPricing({tokens:10,priced_tokens:5,unpriced_tokens:5,list_usd:0}),'Partial · 50.0%')
 assert.equal(T.analyticsPricing({tokens:10,priced_tokens:10,unpriced_tokens:0,list_usd:0}),'Complete')
 assert.equal(T.analyticsPricing({tokens:10,priced_tokens:10,unpriced_tokens:0,list_usd:1,fallback_calls:2}),'Fallback rates · 2 calls')
 assert.equal(T.analyticsPricing({tokens:10,priced_tokens:5,unpriced_tokens:5,list_usd:1,fallback_calls:2}),'Partial · 50.0% · fallback rates')
})

test('exact AND filter state is scope-isolated and query identity includes every backend constraint', async () => {
 assert.equal(typeof T.analyticsInitialState,'function','filter state helper is exported')
 const initial = T.analyticsInitialState()
 let state = T.analyticsReduce(initial,{type:'filter',key:'surface',value:'telegram'})
 state = T.analyticsReduce(state,{type:'select',group:'model',row:{model:'org/model & v2',provider:'route/a'}})
 state = T.analyticsReduce(state,{type:'filter',key:'task',value:'aux'})
 assert.deepEqual(state.filters,{model:'org/model & v2',provider:'route/a',surface:'telegram',task:'aux',parent:'',scope:''})
 assert.deepEqual(initial.filters,{model:'',provider:'',surface:'',task:'',parent:'',scope:''})
 assert.deepEqual(T.analyticsReduce(state,{type:'select',group:'model',row:{other:true}}).filters,state.filters)
 const activeScope = T.analyticsScope('default','connected','local')
 const query = T.analyticsQuery(30,state.filters,activeScope)
 const paths=[]
 T.setRest(async path=>{paths.push(path);return {ok:true}})
 await query.queryFn()
 const url = new URL(paths[0],'http://test')
 assert.equal(url.pathname,'/analytics')
 assert.deepEqual(Object.fromEntries(url.searchParams),{days:'30',model:'org/model & v2',provider:'route/a',surface:'telegram',task:'aux'})
 assert.notDeepEqual(query.queryKey,T.analyticsQuery(30,state.filters,'connection-b/default/open/1').queryKey)
 assert.notDeepEqual(query.queryKey,T.analyticsQuery(7,state.filters,activeScope).queryKey)
 assert.notDeepEqual(query.queryKey,T.analyticsQuery(30,{...state.filters,task:''},activeScope).queryKey)
 assert.deepEqual(T.analyticsReduce(state,{type:'clear'}).filters,initial.filters)
 assert.equal(T.analyticsScope('p','open'),T.analyticsScope('p','open'))
})

const metric = (i=0) => ({tokens:10000-i*100,calls:12-i,input_tokens:2000,output_tokens:1000,cache_read_tokens:6000-i*100,cache_write_tokens:1000,
 list_usd:i===8?null:10-i,priced_tokens:i===8?0:10000-i*100,unpriced_tokens:i===8?9200:0,coverage:i===8?0:1,
 cache_hit_rate:i===8?null:.6-i*.03,cache_known_calls:8,cache_unknown_calls:4,cache_coverage:.66,billed_usd:0,billed_complete:false,
 economics:{uncached_usd:12-i,cached_usd:8-i,savings_usd:i===7?-1:4,coverage:.8,covered_tokens:8000,covered_calls:8,excluded_calls:4}})
const fixture = {ok:true,window:{since:'2026-10-01T00:00:00Z',until:'2026-10-30T00:00:00Z',days:30,timezone:'UTC'},
 totals:{...metric(),unpriced_tokens:1000,priced_tokens:9000,coverage:.9},economics:metric().economics,
 options:{models:[{model:'m0',provider:'p0'}],providers:['p0','p1'],surfaces:['telegram','cli'],tasks:['main','aux']},
 by_model:Array.from({length:9},(_,i)=>({model:`m${i}`,provider:`p${i%2}`,...metric(i)})),
 by_route:[{provider:'p0',...metric()}],trend:{granularity:'day',buckets:[{ts:'2026-10-01T00:00:00Z',...metric()},{ts:'2026-10-03T00:00:00Z',...metric(1)}]},
 recording:{since:'2026-10-01T00:00:00Z',last:'2026-10-29T12:00:00Z',calls:10},notes:['Recorded calls only.']}
function page(data=fixture,extra={},props={}) {
 globalThis.analyticsResponse = {data,isLoading:false,isFetching:false,refetch:()=>{globalThis.analyticsRefetch=(globalThis.analyticsRefetch||0)+1},...extra}
 return render(T.AnalyticsPage(props))
}
function button(tree,label) { return nodes(tree,n=>n.type==='button' && (n.props['aria-label']===label || text(n)===label))[0] }

test('/rates unavailability falls back to the bundled snapshot', () => {
 const hit = T.resolveRates({model: 'deepseek/deepseek-v4.1-flash', provider: 'commandcode', payload: null, remembered: {}})
 assert.ok(hit.rates, 'bundled rates still price the call when the backend is down')
 assert.notEqual(hit.origin, 'backend')
 assert.notEqual(hit.origin, 'none')
})

test('billing save sends an object body through the Desktop REST contract', async () => {
 const calls = []
 const transport = async (path, opts) => { calls.push({ path, opts }); return { ok: true } }
 const payload = T.profilePayload({ id: 'goat', kind: 'custom', account: 'GOAT', rate_input: '1', rate_output: '2' })
 await T.billingWrite('PUT', '/billing/profiles/goat', payload, transport)
 const [call] = calls
 assert.equal(call.path, '/billing/profiles/goat')
 assert.equal(call.opts.method, 'PUT')
 assert.equal(typeof call.opts.body, 'object', 'body must be an object, not a JSON string')
 assert.equal(call.opts.body.id, 'goat')
 assert.equal(call.opts.headers, undefined, 'the bridge sets headers, not the plugin')
})

test('billing errors stay concise and never dump validation JSON', () => {
 assert.match(T.billingErrorMessage(new Error('Input should be a valid dictionary')), /not valid/i)
 assert.match(T.billingErrorMessage(new Error('conflict: stale revision')), /changed since/i)
 assert.match(T.billingErrorMessage(new Error('401 Unauthorized')), /sign in again/i)
 const raw = T.billingErrorMessage(new Error('{"detail":[{"msg":"Input should be a valid dictionary"}]}'))
 assert.doesNotMatch(raw, /[\[\]{}]|"msg"|valid dictionary/i)
})

test('billing presentation modes change the visible figures and overrides persist', () => {
 const rows = T.billingEvidence({evidence: {provider_reported: {usd: 1, basis: 'confirmed'},
   api_equivalent: {usd: 2, basis: 'estimated'}, credits_consumed: {usd: 3, basis: 'inferred'},
   incremental_cash: {usd: 4, basis: 'inferred'}, subscription_fee: {usd: 5, basis: 'profile'}}})
 assert.deepEqual(T.evidenceForMode(rows, 'spend').map(r => r.key), ['provider_reported', 'incremental_cash', 'subscription_fee'])
 assert.deepEqual(T.evidenceForMode(rows, 'api').map(r => r.key), ['api_equivalent'])
 assert.equal(T.evidenceForMode(rows, 'both').length, 5)
 assert.equal(T.evidenceForMode(rows, 'accounting').length, 5)
 T.$billingPresentation.set('spend')
 T.$billingPresentation.set('both')
})

test('custom rate overrides and account labels persist in the payload', () => {
 const payload = T.profilePayload({id: 'goat', kind: 'custom', account: 'GOAT', rate_input: '1.5',
   rate_output: '3', rate_cache: '0.15', effective_from: '2026-10-01', cycle_day: 5})
 assert.equal(payload.account, 'GOAT')
 assert.deepEqual(payload.rate_override, {input: 1.5, output: 3, cache_read: 0.15})
 assert.deepEqual(payload.billing_cycle, {day: 5})
 assert.equal(T.profileDraftErrors({id: 'goat', provider: 'example', kind: 'custom'}).length, 0)
})

test('dashboard renders four SVG analytics, honest pricing/billing/cache coverage and a complete sortable explorer', () => {
 assert.equal(typeof T.AnalyticsPage,'function','analytics page is exported')
 T.$analytics.set({})
 const tree=page()
 for(const title of ['Usage analytics','API-equivalent','Weighted cache hit','Theoretical net savings','Model Explorer','Cache economics']) assert.ok(text(tree).includes(title),title)
 assert.ok(text(tree).includes('Partial'))
 assert.ok(text(tree).includes('Recorded billing'))
 assert.ok(text(tree).includes('not an invoice'))
 assert.ok(text(tree).includes('Unknown is not zero'))
 assert.equal(nodes(tree,n=>n.type==='svg' && !!n.props['data-chart']).length,4,'four SVG charts')
 assert.equal(nodes(tree,n=>n.type==='section').length,7,'four charts, delegation, explorer, economics')
 assert.ok(text(tree).includes('Delegated operations'))
 assert.equal(nodes(tree,n=>n.type==='th').length,14)
 const labels=nodes(tree,n=>n.type==='th').map(text)
 for(const label of ['Billing','Reasoning']) assert.ok(labels.some(value=>value.includes(label)),label)
 assert.ok(text(tree).includes('Reasoning is included in output'))
 assert.ok(nodes(tree,n=>n.type==='details' && nodes(n,x=>x.type==='summary' && text(x)==='Methodology & coverage details').length>0).some(n=>!n.props.open))
 assert.ok(nodes(tree,n=>n.type==='th').every(n=>!!n.props['aria-sort']))
 assert.equal(nodes(tree,n=>n.type==='select').length,7)
 assert.ok(nodes(tree,n=>n.type==='svg').every(n=>!!n.props.viewBox))
 const scope=T.analyticsScope('default','connected')
 button(tree,'Distribution tokens').props.onClick()
 assert.equal(T.$analytics.get()[scope].distributionMetric,'tokens')
 button(page(),'Distribution by provider').props.onClick()
 assert.equal(T.$analytics.get()[scope].grouping,'provider')
 const select=nodes(page(),n=>n.type==='select' && n.props['aria-label']==='Surface filter')[0]
 select.props.onChange({target:{value:'telegram'}})
 const q=globalThis.analyticsQueries.at(-1)
 assert.ok(q.queryKey.includes('analytics'))
 page()
 assert.ok(globalThis.analyticsQueries.at(-1).queryKey.includes('telegram'))
 button(page(),'Clear filters').props.onClick()
 assert.deepEqual(T.$analytics.get()[scope].filters,T.analyticsInitialState().filters)
})

test('legend exact-selection, Other inspection, sorting and keyboard chart details are wired', () => {
 assert.equal(typeof T.AnalyticsPage,'function','analytics page is exported')
 T.$analytics.set({})
 const scope=T.analyticsScope('default','connected')
 let tree=page()
 button(tree,'Inspect Other models').props.onClick()
 assert.equal(T.$analytics.get()[scope].otherOpen,true)
 assert.deepEqual(T.$analytics.get()[scope].filters,T.analyticsInitialState().filters)
 tree=page()
 assert.ok(text(tree).includes('Remainder · 2 models'))
 button(tree,'Filter m6 via p0').props.onClick()
 assert.deepEqual(T.$analytics.get()[scope].filters,{model:'m6',provider:'p0',surface:'',task:'',parent:'',scope:''})
 button(page(),'Sort by Calls').props.onClick()
 assert.equal(T.$analytics.get()[scope].sortKey,'calls')
 button(page(),'Trend cost').props.onClick()
 assert.equal(T.$analytics.get()[scope].trendMetric,'cost')
 button(page(),'Composition doughnut').props.onClick()
 assert.equal(T.$analytics.get()[scope].compositionMode,'doughnut')
 tree=page()
 const point=nodes(tree,n=>n.props?.['data-trend-point']===0)[0]
 point.props.onKeyDown({key:'Enter',preventDefault(){}})
 assert.equal(T.$analytics.get()[scope].trendIndex,0)
 assert.ok(text(page()).includes('2026-10-01'))
 button(page(),'Select Cache read composition').props.onClick()
 assert.equal(T.$analytics.get()[scope].compositionFocus,'cache_read_tokens')
})

test('error, retry, loading and no-results remain actionable without invented zero totals', () => {
 assert.equal(typeof T.AnalyticsPage,'function','analytics page is exported')
 T.$analytics.set({})
 const failed=page(undefined,{data:undefined,error:new Error('offline')})
 assert.ok(text(failed).includes('offline'))
 button(failed,'Retry analytics').props.onClick()
 assert.equal(globalThis.analyticsRefetch,1)
 assert.ok(button(failed,'Use this desktop’s ledger'))
 assert.ok(text(page(undefined,{data:undefined,isLoading:true})).includes('Reading timestamped calls'))
 assert.ok(text(page(undefined,{data:undefined,isLoading:false})).includes('Usage data is not available for this profile yet'))
 const empty=page({...fixture,totals:{tokens:0,calls:0},by_model:[],by_route:[],trend:{buckets:[]}})
 assert.ok(text(empty).includes('No backend calls recorded for this period'))
 assert.equal(nodes(empty,n=>n.props?.role==='status').length,1)
 assert.ok(!text(empty).includes('NaN'))
 const unknown=page({...fixture,totals:{...metric(),list_usd:null,priced_tokens:0,unpriced_tokens:10000,cache_hit_rate:null,billed_usd:null,economics:{savings_usd:null}},economics:{savings_usd:null}})
 assert.ok(text(unknown).includes('Unpriced'))
 assert.ok(!text(unknown).includes('NaN'))
})

test('product Usage keeps one aligned shell and explains an empty period', () => {
 T.$view.set('all')
 const empty=page({...fixture,totals:{tokens:0,calls:0},by_model:[],by_route:[],trend:{buckets:[]}}, {}, {productPage:true})
 const roots=nodes(empty,n=>n.type==='div' && String(n.props?.className || '').split(/\s+/).includes('wm-analytics'))
 assert.equal(roots.length,1,'product Usage has one full-height scroll root')
 assert.ok(String(roots[0].props.className).split(/\s+/).includes('wm-product'))
 assert.equal(nodes(empty,n=>n.props?.role==='tablist' && n.props?.['aria-label']==='Spend Sense sections').length,1)
 assert.ok(text(empty).includes('This report covers backend analytics'))
 button(empty,'Show Desktop-recorded usage').props.onClick()
 assert.equal(T.$view.get(),'desktop','the empty-state action opens the separate local ledger')
 T.$view.set('all')
})

test('remainder percentages retain their share of the whole, not just the remainder', () => {
 const result=T.analyticsDistribution(Array.from({length:8},(_,i)=>({model:`m${i}`,provider:'p',tokens:8-i})),'tokens','model',6)
 assert.equal(result.remainder[0].share,2/36)
 assert.equal(result.remainder[1].share,1/36)
})

test('rendering selected filters does not mutate React Query option arrays', () => {
 const options={models:Object.freeze([{model:'m0',provider:'p0'}]),providers:Object.freeze(['p0']),surfaces:Object.freeze(['cli']),tasks:Object.freeze(['main'])}
 const state={...T.analyticsInitialState(),filters:{model:'missing-model',provider:'missing-provider',surface:'missing-surface',task:'missing-task'}}
 assert.doesNotThrow(()=>render(T.AnalyticsDashboard({data:{...fixture,options},state,dispatch:()=>{}})))
 assert.deepEqual(options.providers,['p0'])
})

test('baseline query is lazy and separate, rapid actions preserve every exact filter', () => {
 T.$analytics.set({})
 globalThis.analyticsQueries=[]
 let tree=page()
 assert.equal(globalThis.analyticsQueries.length,1)
 const scope=T.analyticsScope('default','connected')
 const surface=nodes(tree,n=>n.type==='select'&&n.props['aria-label']==='Surface filter')[0]
 const task=nodes(tree,n=>n.type==='select'&&n.props['aria-label']==='Task filter')[0]
 surface.props.onChange({target:{value:'telegram'}})
 task.props.onChange({target:{value:'aux'}})
 assert.equal(T.$analytics.get()[scope].filters.surface,'telegram')
 assert.equal(T.$analytics.get()[scope].filters.task,'aux')
 const details=nodes(tree,n=>n.type==='details'&&n.props.className==='wm-baseline')[0]
 details.props.onToggle({currentTarget:{open:true}})
 globalThis.analyticsQueries=[]
 tree=page()
 assert.equal(globalThis.analyticsQueries.length,2)
 assert.ok(globalThis.analyticsQueries[1].queryKey.includes('historical-baseline'))
 assert.equal(globalThis.analyticsQueries[1].queryKey.includes('telegram'),false)
 assert.ok(text(tree).includes('NOT included in period'))
})

test('keyboard repeats use current selected timestamp and Other toggles do not capture stale state', () => {
 T.$analytics.set({})
 const scope=T.analyticsScope('default','connected')
 const data={...fixture,trend:{granularity:'day',buckets:[...fixture.trend.buckets,{ts:'2026-10-04T00:00:00Z',...metric()}]}}
 const tree=page(data)
 const point=nodes(tree,n=>n.props?.['data-trend-point']===0)[0]
 point.props.onKeyDown({key:'ArrowRight',preventDefault(){}})
 point.props.onKeyDown({key:'ArrowRight',preventDefault(){}})
 assert.equal(T.$analytics.get()[scope].trendIndex,2)
 const other=button(tree,'Inspect Other models')
 other.props.onClick();other.props.onClick()
 assert.equal(T.$analytics.get()[scope].otherOpen,false)
})

test('delegation panel separates direct, delegated and auxiliary usage and filters exactly', () => {
 T.$analytics.set({})
 const scope=T.analyticsScope('default','connected')
 const byScope=[
  {scope:'direct',calls:10,tokens:1000,list_usd:2,cache_hit_rate:.9,economics:{savings_usd:1}},
  {scope:'subagent',calls:20,tokens:3000,list_usd:6,cache_hit_rate:.7,economics:{savings_usd:2}},
  {scope:'auxiliary',calls:2,tokens:100,list_usd:.1,cache_hit_rate:null,economics:{savings_usd:null}}
 ]
 const data={...fixture,by_scope:byScope,attribution:{child_sessions:4,known_sessions:9,unattributed_calls:0,cycles:0,complete:true}}
 let tree=page(data)
 assert.ok(text(tree).includes('Delegated operations'))
 assert.ok(text(tree).includes('Parent (direct)'))
 assert.ok(text(tree).includes('Subagents'))
 assert.ok(text(tree).includes('4 child sessions known'))
 assert.ok(text(tree).includes('Cache: parent 90.0% · workers 70.0%'))
 button(tree,'Delegation scope subagent').props.onClick()
 assert.equal(T.$analytics.get()[scope].filters.scope,'subagent')
 tree=page({...data,attribution:{...data.attribution,unattributed_calls:3}})
 assert.ok(text(tree).includes('could not be attributed'))
})

test('economics comparison explains unchanged output cost and period uses calendar window labels', () => {
 const tree=page()
 assert.ok(text(tree).includes('same output cost'))
 const select=nodes(tree,n=>n.type==='select'&&n.props['aria-label']==='Period filter')[0]
 assert.ok(text(select).includes('Today'))
 assert.ok(!text(select).includes('24 hours'))
})

test('gateway local calendar labels do not slice the UTC date under a BST label', () => {
 T.$analytics.set({})
 const data={...fixture,window:{...fixture.window,timezone:'BST',since:'2026-07-08T23:00:00+00:00',until:'2026-07-09T11:00:00+00:00',since_local:'2026-07-09T00:00:00+01:00',until_local:'2026-07-09T12:00:00+01:00'},trend:{granularity:'hour',buckets:[{...metric(),ts:'2026-07-08T23:00:00+00:00',ts_local:'2026-07-09T00:00:00+01:00'}]}}
 const tree=page(data)
 assert.ok(text(tree).includes('2026-07-09 → 2026-07-09 · BST'))
 const chart=nodes(tree,n=>n.props?.['data-chart']==='trend')[0]
 assert.ok(text(chart).includes('00:00 +01:00'))
 assert.ok(!text(chart).includes('23:00 UTC'))
 const point=nodes(tree,n=>n.props?.['data-trend-point']===0)[0]
 point.props.onKeyDown({key:'Enter',preventDefault(){}})
 assert.ok(text(page(data)).includes('2026-07-09 00:00:00+01:00'))
})

test('analytics scope renders without async inventory and isolates profile, socket, connection and activation epoch', () => {
 const host=globalThis.analyticsHost
 globalThis.analyticsRouteCalls=[]
 T.$analytics.set({})
 const scopes=[], analyticsKeys=[], baselineKeys=[]
 const cases=[['default','connected','local',10],['other','connected','local',10],['default','disconnected','local',10],['default','connected','remote',10],['default','connected','local',11]]
 try {
  for(const [index,[profile,gateway,connection,epoch]] of cases.entries()) {
   host.state.profile.set(profile)
   host.state.gateway.set(gateway)
   host.state.connectionId.set(connection)
   globalThis.analyticsEpoch=epoch
   let scope
   assert.doesNotThrow(()=>{scope=T.analyticsScope(profile,gateway)},'scope must not synchronously consume async profileRoutes')
   assert.equal(typeof scope,'string')
   assert.equal(T.analyticsScope(profile,gateway,connection),scope,'default connection matches the active synchronous atom')
   assert.equal(T.analyticsScope(profile,gateway),scope,'unchanged active route has stable identity')
   scopes.push(scope)
   globalThis.analyticsQueries=[]
   globalThis.analyticsSubscriptions=[]
   let tree
   assert.doesNotThrow(()=>{tree=page()},'real analytics page renders against the async SDK contract')
   assert.ok(globalThis.analyticsSubscriptions.includes(host.state.connectionId),'page subscribes to same-profile connection switches')
   const surface=nodes(tree,n=>n.type==='select' && n.props['aria-label']==='Surface filter')[0]
   assert.equal(surface.props.value,'','new scope must not inherit another scope’s filter')
   analyticsKeys.push(JSON.stringify(globalThis.analyticsQueries[0].queryKey))
   surface.props.onChange({target:{value:`surface-${index}`}})
   const baseline=nodes(tree,n=>n.type==='details' && n.props.className==='wm-baseline')[0]
   assert.equal(baseline.props.open,false,'baseline visibility is scope-local too')
   baseline.props.onToggle({currentTarget:{open:true}})
   globalThis.analyticsQueries=[]
   page()
   assert.equal(globalThis.analyticsQueries.length,2)
   const [analyticsQuery,baselineQuery]=globalThis.analyticsQueries
   assert.ok(analyticsQuery.queryKey.includes(scope))
   assert.ok(analyticsQuery.queryKey.includes(`surface-${index}`))
   assert.ok(baselineQuery.queryKey.includes(scope))
   baselineKeys.push(JSON.stringify(baselineQuery.queryKey))
   assert.equal(T.$analytics.get()[scope].filters.surface,`surface-${index}`)
  }
  assert.equal(new Set(scopes).size,cases.length,'same-profile source swaps change scope via epoch')
  assert.equal(new Set(analyticsKeys).size,cases.length,'analytics query caches are isolated')
  assert.equal(new Set(baselineKeys).size,cases.length,'baseline query caches are isolated')
  assert.equal(Object.keys(T.$analytics.get()).length,cases.length,'state is keyed by the same distinct scopes')
  assert.equal(T.$analytics.get()[scopes[0]].filters.surface,'surface-0','later route selections leave prior state intact')
  assert.deepEqual(globalThis.analyticsRouteCalls,[],'neither scope calculation nor rendering performs route-inventory I/O')
 } finally {
  host.state.profile.set('default')
  host.state.gateway.set('connected')
  host.state.connectionId.set('local')
  delete globalThis.analyticsEpoch
  delete globalThis.analyticsSubscriptions
  T.$analytics.set({})
 }
})
test('provider follows the active selection instead of a cached session route', async () => {
 assert.equal(typeof T.liveProvider,'function','provider resolver is exported')
 const openai = {model:'gpt-6.1-sol',provider:'openai-codex'}
 const deepseek = {model:'deepseek/deepseek-v4.1-flash',provider:'commandcode'}
 assert.equal(T.liveProvider(openai,'gpt-6.1-sol'),'openai-codex')
 assert.equal(T.liveProvider(openai,'deepseek/deepseek-v4.1-flash'),'','a switched-away provider must not be shown')
 assert.equal(T.liveProvider(deepseek,'deepseek-v4.1-flash'),'commandcode','bare id matches a namespaced payload')
 assert.equal(T.liveProvider({provider:'commandcode'},'anything'),'commandcode','no payload model means no contradiction')
 const a=T.catalogQuery('sess','gpt-6.1-sol',true), b=T.catalogQuery('sess','deepseek/deepseek-v4.1-flash',true)
 assert.notDeepEqual(a.queryKey,b.queryKey,'a model switch must miss the cache')
 assert.equal(a.staleTime,0,'a live session payload is never served stale')
 assert.notEqual(T.catalogQuery(null).staleTime,0,'the global picker catalog may stay warm')
})

test('recording a call after a model switch stores the route that served it', async () => {
 T.$ledger.set(T.emptyLedger())
 T.$automaticModelOptions.set(true)
 const calls=[]
 globalThis.__catalog=(method,params)=>{ calls.push(params); return params.session_id ? {model:'deepseek/deepseek-v4.1-flash',provider:'commandcode',providers:[]} : {providers:[]} }
 await T.enqueueUsage('session-1',{model:'deepseek/deepseek-v4.1-flash',input:1000,output:10,calls:1})
 const summary=T.summarize(T.$ledger.get(),()=>true,null)
 const row=summary.rows.find(r=>r.model==='deepseek/deepseek-v4.1-flash')
 assert.ok(row,'the call is recorded')
 assert.equal(row.provider,'commandcode','the new route, not the earlier openai-codex route')
 assert.ok(calls.length>=1)
 delete globalThis.__catalog
 T.$automaticModelOptions.set(false)
})

test('analytics rejects stale or reactivated gateway requests', async () => {
 const h = globalThis.analyticsHost
 const scope = T.analyticsScope(h.state.profile.get(),h.state.gateway.get(),h.state.connectionId.get())
 let resolve
 T.setRest(() => new Promise(r => { resolve = r }))
 const pending = T.analyticsQuery(7,{},scope).queryFn()
 h.state.connectionId.set('other')
 resolve({ok:true})
 await assert.rejects(pending,/connection changed/i)
 await assert.rejects(T.analyticsQuery(7,{},scope).queryFn(),/connection changed/i)
 h.state.connectionId.set('local')
 globalThis.analyticsEpoch = (globalThis.analyticsEpoch ?? 0) + 1
 await assert.rejects(T.analyticsQuery(7,{},scope).queryFn(),/connection changed/i)
})

test('usage queued on a previous activation cannot settle on the new gateway', async () => {
 T.$ledger.set(T.emptyLedger())
 T.$automaticModelOptions.set(true)
 let resolve
 globalThis.__catalog = () => new Promise(r => { resolve = r })
 const pending = T.enqueueUsage('synthetic-session',{model:'model',input:100,output:10,calls:1})
 await Promise.resolve()
 globalThis.analyticsHost.state.connectionId.set('other')
 resolve({model:'model',provider:'provider',providers:[]})
 await pending
 assert.deepEqual(T.$ledger.get(),T.emptyLedger())
 globalThis.analyticsHost.state.connectionId.set('local')
 T.$automaticModelOptions.set(false)
 delete globalThis.__catalog
})


test('a backend price cannot cross gateway activations', async () => {
 const h = globalThis.analyticsHost
 let resolve
 T.setRest(() => new Promise(r => { resolve = r }))
 const pending = T.ensureBackendRate('synthetic-provider', 'synthetic-model')
 h.state.connectionId.set('different')
 resolve({rate:{input:1, output:2, cache_read:0.5}})
 await pending
 assert.notEqual(T.resolveRates({provider:'synthetic-provider', model:'synthetic-model'}).origin, 'backend')
 h.state.connectionId.set('local')
 assert.notEqual(T.resolveRates({provider:'synthetic-provider', model:'synthetic-model'}).origin, 'backend')
})

test('editing a rule preserves nested rates and unrelated model allowances', () => {
 const original = { id:'route', provider:'example', kind:'custom', label:'old', currency:'USD',
   rate_override:{input:1,output:2,cache_read:0.1,cache_write:0.3},
   allowances:{'model-a':8,'model-b':12}, allowance_usd:30, billing_cycle:{day:7,timezone:'UTC'} }
 const draft = T.profileDraft(original,'scope')
 const result = T.profilePayload({...draft,label:'new'})
 assert.deepEqual(result.rate_override,original.rate_override)
 assert.deepEqual(result.allowances,original.allowances)
 assert.equal(result.allowance_usd,30)
 assert.deepEqual(result.billing_cycle,original.billing_cycle)
 assert.equal(result.currency,'USD')
})
