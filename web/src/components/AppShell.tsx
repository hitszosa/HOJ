"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
const STUDENT_NAV = [
  ['/student', '我的课程'],
  ['/student/categories', '算法题库与知识图谱'],
  ['/student/status', '评测状态'],
  ['/student/ranklist', '排行榜'],
  ['/faq', '常见问答'],
  ['/student/history', '历史课程'],
];
const TEACHER_NAV = [
  ['/teacher', '教学工作台'],
  ['/teacher/categories', '算法题库与知识图谱'],
  ['/teacher/status', '实时评测流'],
  ['/faq', '常见问答'],
];
export function AppShell({children}:{children:ReactNode}) {
 const path=usePathname();
 const [portal,setPortal]=useState<string|null>(null);
 useEffect(()=>{
  let active=true;let broadcastReceived=false;
  // 身份与页面同源：优先听 Platform 的广播（登录、切换、401 过期都会触发），
  // 同时自行取一次兜底，避免时序竞争导致导航空白。
  const onPortal=(e:Event)=>{broadcastReceived=true;if(active)setPortal((e as CustomEvent<string|null>).detail||null);};
  window.addEventListener('hoj-portal',onPortal);
  window.addEventListener('hustoj-portal',onPortal);
  fetch('/api/me').then(r=>r.ok?r.json():null).then(m=>{if(active&&!broadcastReceived)setPortal(m?.portal||null);}).catch(()=>{if(active&&!broadcastReceived)setPortal(null);});
  return()=>{active=false;window.removeEventListener('hoj-portal',onPortal);window.removeEventListener('hustoj-portal',onPortal);};
 },[path]);
 const nav=portal==='teacher'?TEACHER_NAV:portal==='student'?STUDENT_NAV:[];
 const home=portal==='teacher'?'/teacher':portal==='student'?'/student':'/';
 return <div className="min-h-screen bg-surface-muted"><header className="border-b border-line bg-surface"><div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-6 py-5"><Link href={home} className="flex items-center gap-3"><span className="brand-symbol">hoj</span><div><span className="text-xl font-semibold tracking-tight">HOJ 教学平台</span><p className="text-meta text-fg-muted">{portal==='teacher'?'教学工作台':portal==='student'?'学生学习空间':'校内编程作业平台'}</p></div></Link><div className="flex flex-wrap items-center gap-3">{portal&&<button className="text-meta text-fg-muted hover:text-brand" onClick={async()=>{await fetch('/api/session',{method:'DELETE'});window.location.assign('/');}}>退出登录</button>}</div></div>{nav.length>0&&<nav aria-label="主导航" className="mx-auto flex max-w-7xl gap-6 overflow-x-auto px-6">{nav.map(([href,label])=><Link key={href} href={href} aria-current={path===href?'page':undefined} className={`whitespace-nowrap border-b-2 py-3 text-body ${path===href?'border-brand font-semibold text-brand':'border-transparent text-fg-muted hover:text-fg'}`}>{label}</Link>)}</nav>}</header><main className="mx-auto max-w-7xl px-6 py-10">{children}</main><footer className="mx-auto flex max-w-7xl flex-wrap justify-between gap-3 border-t border-line px-6 py-6 text-meta text-fg-muted"><span>HOJ 教学平台</span><span>本地体验环境 · 账号、题库与判题由 HOJ 提供</span><span className="text-fg-subtle">开放评测与教学题库中心</span></footer></div>;
}
