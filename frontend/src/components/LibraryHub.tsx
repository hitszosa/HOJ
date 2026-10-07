"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import type { Me } from "@/api/generated/Me";
import { CategoryTreeView } from "@/components/CategoryTreeView";
import { TeacherLibraryView } from "@/components/TeacherLibraryView";
import { canManageLibrary } from "@/lib/platform-navigation";

import {LibraryBasketProvider,LibraryBasketPanel} from "./LibraryBasket";

export function LibraryHub({identity}:{identity:Me}) {
 const router=useRouter(),params=useSearchParams();
 const canManage=canManageLibrary(identity);
 const legacyQuestions=params.get('view')==='mine'&&params.get('tab')==='problems';
 const mine=canManage && params.get('view')==='mine'&&!legacyQuestions;
 const own=canManage&&(params.get('source')==='mine'||legacyQuestions);
 function select(view:string,source?:string) { const next=new URLSearchParams(params.toString());next.set('view',view);next.delete('tab');if(source)next.set('source',source);router.replace(`/library?${next}`); }
 const bankAction=(tab:string)=>{const next=new URLSearchParams(params.toString());next.set('view','public');next.set('source','mine');next.set('tab',tab);return `/library?${next}`;};
 return <LibraryBasketProvider user={identity.user} key={identity.user}><div>
  {canManage&&<nav aria-label="题库分类" className="mb-6 flex gap-3 border-b border-line pb-3">
   <button type="button" className={`rounded-control px-4 py-2 ${!mine?'bg-brand text-brand-fg':'text-fg-muted'}`} aria-pressed={!mine} onClick={()=>select('public')}>题库</button>
   <button type="button" className={`rounded-control px-4 py-2 ${mine?'bg-brand text-brand-fg':'text-fg-muted'}`} aria-pressed={mine} onClick={()=>select('mine')}>我的题单</button>
  </nav>}
  {mine?<TeacherLibraryView key="sets" portal={identity.portal} user={identity.user}/>:<>
   {canManage&&<section className="mb-6 space-y-4"><header className="flex flex-wrap items-center justify-between gap-4"><div><h1 className="text-3xl font-semibold">题库</h1><p className="mt-2 text-meta text-fg-muted">自己出的题和公开题库中的题，都可以在这里加入同一个选题篮，组合成题单。</p></div><div className="flex flex-wrap gap-3"><Link className="rounded-control bg-brand px-4 py-2 text-brand-fg" href={bankAction('create')}>✏️ 去出题</Link><Link className="rounded-control border border-line px-4 py-2" href={bankAction('import')}>📂 导入题目</Link></div></header><nav aria-label="题目来源" className="flex flex-wrap gap-3"><button type="button" aria-pressed={own} className={`rounded-control px-4 py-2 ${own?'bg-brand text-brand-fg':'border border-line text-fg-muted'}`} onClick={()=>select('public','mine')}>我出的题</button><button type="button" aria-pressed={!own} className={`rounded-control px-4 py-2 ${!own?'bg-brand text-brand-fg':'border border-line text-fg-muted'}`} onClick={()=>select('public','others')}>别人的题</button></nav></section>}
   {own?<TeacherLibraryView key="questions" questionsOnly portal={identity.portal} user={identity.user}/>:<CategoryTreeView unified={canManage} portal={canManage?'teacher':'student'} user={identity.user}/>}
  </>}
  {canManage&&<LibraryBasketPanel/>}
 </div></LibraryBasketProvider>;
}
