"use client";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { api } from "@/lib/api";
import type { Me } from "@/api/generated/Me";
import { platformNavigation, platformRole, platformSection } from "@/lib/platform-navigation";

export function AppShell({children}:{children:ReactNode}) {
 const path=usePathname();
 const [identity,setIdentity]=useState<Me|null>(null);
 const [profile,setProfile]=useState<{username:string;real_name:string}|null>(null);
 const [locale,setLocale]=useState('zh');
 const [logoutError,setLogoutError]=useState('');
 useEffect(()=>{
  let active=true,broadcastReceived=false;
  const onIdentity=(event:Event)=>{broadcastReceived=true;if(active)setIdentity((event as CustomEvent<Me|null>).detail||null);};
  window.addEventListener('hoj-identity',onIdentity);
  api<Me>('/me').then(me=>{if(active&&!broadcastReceived)setIdentity(me);}).catch(()=>{if(active&&!broadcastReceived)setIdentity(null);});
  fetch('/management-api/auth/current_user',{credentials:'same-origin'}).then(async response=>{
   if (!response.ok) return;
   const user=await response.json();if(active)setProfile(user);
  }).catch(()=>{});
  try { const stored=JSON.parse(localStorage.getItem('theme')||'{}');setLocale(stored.language||navigator.languages.map(language=>language.split('-')[0]).find(language=>language==='zh'||language==='en')||'en'); } catch {}
  return()=>{active=false;window.removeEventListener('hoj-identity',onIdentity);};
 },[path]);
 const text=(zh:string,en:string)=>locale==='en'?en:zh;
 async function logout() {
  setLogoutError('');
  try {
   const csrf=document.cookie.split(';').map(value=>value.trim()).find(value=>value.startsWith('csrftoken='))?.slice('csrftoken='.length);
   const management=await fetch('/management-api/auth/logout',{method:'POST',headers:csrf?{'X-CSRFTOKEN':decodeURIComponent(csrf)}:{}});
   const programming=await fetch('/api/session',{method:'DELETE'});
   if (!programming.ok || (!management.ok && management.status!==401)) throw Error(text('退出失败，请重试','Sign out failed. Please retry.'));
   setIdentity(null);window.location.assign('/management/login');
  } catch(error) { setLogoutError(String(error)); }
 }
 return <div className="min-h-screen bg-surface-muted">
  <header className="hoj-app-header hoj-app-header--sticky">
   <div className="hoj-app-top">
    <a href="/management/home" className="hoj-app-brand">{text('HOJ 教学平台','HOJ Teaching Platform')}</a>
    <div className="hoj-app-account">
     {identity?<><span className="hoj-app-role">{platformRole(identity,locale)}</span><details className="hoj-account-menu">
      <summary>{profile?.username===identity.user?(profile.real_name||identity.user):identity.user} <span aria-hidden="true">⌄</span></summary>
      <div className="hoj-account-dropdown">
       <a href="/management/change_info">{text('我的账号','My account')}</a>
       <a href="/management/preferences">{text('偏好设置','Preferences')}</a>
       <a href="/management/docs">{text('使用帮助','Help')}</a>
       <button type="button" onClick={logout}>{text('退出登录','Sign out')}</button>
      </div>
     </details></>:<a className="hoj-app-signin" href="/management/login">{text('登录','Sign in')}</a>}
    </div>
   </div>
   <nav aria-label={text('平台导航','Platform navigation')} className="hoj-app-nav">
    {platformNavigation(identity).map(item=><a key={item.id} href={item.href} className="hoj-app-nav-link" aria-current={platformSection(path)===item.id?'page':undefined}>{locale==='en'?item.en:item.zh}</a>)}
   </nav>
  </header>
  {logoutError&&<p role="alert" className="mx-auto max-w-7xl px-6 py-2 text-fg">{logoutError}</p>}
  <main className="mx-auto max-w-7xl px-6 py-8">{children}</main>
 </div>;
}
