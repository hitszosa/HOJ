"use client";
import {createContext,useContext,useEffect,useState,type Dispatch,type SetStateAction} from 'react';
import {useRouter,useSearchParams} from 'next/navigation';
import {api} from '@/lib/api';
import {Button,Card} from './ui';
import type {DraftCreated} from '@/api/generated/DraftCreated';
export type BasketItem={setId:string;setName:string;slug:string;title:string;difficulty:string;knowledge?:string[];statement?:string};
type BasketState={basket:BasketItem[];setBasket:Dispatch<SetStateAction<BasketItem[]>>};
const Context=createContext<BasketState|null>(null);
export function LibraryBasketProvider({user,children}:{user:string;children:React.ReactNode}){
 const [basket,setBasket]=useState<BasketItem[]>([]),[ready,setReady]=useState(false);
 const key=`hoj:library-basket:${user}`;
 useEffect(()=>{try{const raw=JSON.parse(sessionStorage.getItem(key)||'[]');if(Array.isArray(raw))setBasket(raw.filter(x=>typeof x.setId==='string'&&typeof x.slug==='string').slice(0,100));}catch{}setReady(true);},[key]);
 useEffect(()=>{if(ready)try{sessionStorage.setItem(key,JSON.stringify(basket));}catch{}},[key,basket,ready]);
 return <Context.Provider value={{basket,setBasket}}>{children}</Context.Provider>;
}
export function useLibraryBasket(){return useContext(Context);}
export function LibraryBasketPanel(){
 const state=useLibraryBasket(),router=useRouter(),params=useSearchParams();const [title,setTitle]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
 if(!state||!state.basket.length)return null;
 const {basket,setBasket}=state;
 async function create(){setBusy(true);setError('');try{const oid=Number(params.get('oid'));const res=await api<DraftCreated>('/teacher/library/compose','POST',{title:title.trim()||`组合题单（${basket.length}题）`,offering_id:oid>0?oid:undefined,items:basket.map(p=>({set_id:p.setId,slug:p.slug}))});setBasket([]);router.push(`/programming/drafts/${res.id}?library=1${oid>0?`&oid=${oid}`:''}`);}catch(e){setError(String(e).split('|').pop()||'组题失败，请检查选题是否已删除');}finally{setBusy(false);}}
 return <Card className="sticky bottom-3 z-40 border-brand shadow-lg"><h2 className="font-semibold">选题篮 · {basket.length} 道题</h2><p className="text-meta text-fg-muted">自编、AI、导入和预置题目可一起组题；保存后再选择课程布置。</p><div className="mt-3 max-h-40 overflow-auto flex flex-wrap gap-2">{basket.map(p=><span key={`${p.setId}:${p.slug}`} className="border border-line rounded-control px-2 py-1 text-meta">{p.title}<button aria-label={`移出选题篮 ${p.title}`} className="ml-2" onClick={()=>setBasket(xs=>xs.filter(x=>x.setId!==p.setId||x.slug!==p.slug))}>×</button></span>)}</div><div className="mt-3 flex flex-wrap gap-3"><input aria-label="新题单名称" className="border border-line rounded-control px-3 py-2 bg-surface" placeholder="新题单名称" value={title} onChange={e=>setTitle(e.target.value)}/><Button disabled={busy} onClick={create}>{busy?'正在组题…':'创建题单'}</Button><Button variant="secondary" disabled={busy} onClick={()=>setBasket([])}>清空</Button></div>{error&&<p role="alert" className="mt-2 text-danger">{error}</p>}</Card>;
}
