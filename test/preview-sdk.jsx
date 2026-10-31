// Test-only browser adapter. Never shipped as the disk plugin SDK.
import React, {useEffect, useState, useSyncExternalStore} from 'react'
export const atom = initial => { let value = initial; const listeners = new Set(); return {get:()=>value,set:next=>{value=next; for(const fn of listeners)fn(value)},listen:fn=>{listeners.add(fn);return()=>listeners.delete(fn)}} }

// Real derivation, so a scope atom behaves here as it does under nanostores.
export const computed = (stores, cb) => {
  const list = Array.isArray(stores) ? stores : [stores]
  return {
    get: () => cb(...list.map(s => s.get())),
    listen: (fn) => {
      const offs = list.map(s => (s.listen ? s.listen(fn) : () => {}))
      return () => offs.forEach(off => off())
    }
  }
}
export const useValue = a => useSyncExternalStore(fn=>a.listen(fn),()=>a.get())
export const gatewayActivationEpoch = () => globalThis.__ledgerActivationEpoch ?? 0
export const profileRouteCalls = globalThis.__ledgerProfileRoutesCalls = []
const empty = atom(null)
export const host = {state:{focusedSessionId:empty,focusedStoredSessionId:empty,focusedUsage:empty,profile:atom('default'),focusedSessionProfile:atom('default'),gateway:atom('connected'),connectionId:atom('local')},profileRoutes:async()=>{profileRouteCalls.push('profileRoutes');return [{connectionId:'local',profile:'default'}]},request:async()=>({providers:[]}),onEvent:()=>()=>{},navigate:()=>{},notify:()=>{}}
export const cn = (...x)=>x.filter(Boolean).join(' ')
export function Button({children,size,variant,...props}){return <button {...props}>{children}</button>}
export function Badge({children}){return <span>{children}</span>}
export function Codicon(){return null}
export function Tip({children,label}){return <span title={typeof label==='string'?label:undefined}>{children}</span>}
export function SegmentedControl({value,options,onChange}){return <span className="preview-segments">{options.map(o=><button key={o.id} aria-pressed={o.id===value} onClick={()=>onChange(o.id)}>{o.label}</button>)}</span>}
export const usePluginI18n = ()=>key=>({viewAll:'All Hermes',viewDesktop:'This desktop',range_today:'Today',range_week:'7 days',range_month:'30 days',range_all:'365 days',close:'Close',closeTip:'Close dashboard'}[key]||key)
const cache = new Map()
export const queryClient = {fetchQuery:async q=>q.queryFn(),getQueryData:()=>null,invalidateQueries:()=>{}}
export function useQuery(options){
 const key=JSON.stringify(options.queryKey), [state,setState]=useState({isLoading:true,isFetching:true})
 const [revision,setRevision]=useState(0)
 useEffect(()=>{let current=true;setState({isLoading:true,isFetching:true});Promise.resolve().then(options.queryFn).then(data=>{cache.set(key,data);if(current)setState({data,isLoading:false,isFetching:false})}).catch(error=>{if(current)setState({error,isLoading:false,isFetching:false})});return()=>{current=false}},[key,revision])
 return {...state,refetch:()=>setRevision(x=>x+1)}
}
