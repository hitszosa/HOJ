"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Badge, Button, Card, CardTitle, Empty, Progress, Stat } from "@/components/ui";
import { matchRoute, readDraft, routePortal, writeDraft } from "@/lib/routes";
import { loadPortalPage } from "@/lib/portal";
import { CodeEditor } from "@/components/CodeEditor";
import { TrialPanel } from "@/components/TrialPanel";
import { StatusStreamView } from "@/components/StatusStreamView";
import { RankListView } from "@/components/RankListView";
import { PublicProblemListView, PublicProblemWorkspace } from "@/components/PublicProblems";
import { FaqView } from "@/components/FaqView";
import { CategoryTreeView } from "@/components/CategoryTreeView";
import { MarkdownView } from "@/components/MarkdownView";
import { JudgeDetailView } from "@/components/JudgeDetailView";

type Row = Record<string, any>;
async function api(path:string, method="GET", body?:unknown) {
  const response=await fetch(`/api${path}`,{method,headers:body?{"Content-Type":"application/json"}:{},body:body?JSON.stringify(body):undefined});
  const data=await response.json().catch(()=>({detail:"服务暂时不可达"}));
  if(!response.ok) throw new Error(`${response.status}|${typeof data.detail==='string'?data.detail:'请求格式不正确'}`);
  return data;
}
const field="w-full rounded-control border border-line bg-surface px-3 py-2 text-body text-fg focus:outline-none focus:ring-2 focus:ring-brand";
const action="inline-flex rounded-control bg-brand px-4 py-2 text-meta font-medium text-brand-fg hover:opacity-90";
function date(value:string|null) { return value?value.replace('T',' ').slice(0,16):'未设置'; }
function formatSourceRef(ref: string | null | undefined) {
 if (!ref) return '';
 if (ref.startsWith('bank:')) {
  return `题库引入 · ${ref.slice(5)}`;
 }
 if (ref.startsWith('hoa:')) {
  return `题库引入 · ${ref.slice(4)}`;
 }
 return `导入题单 · ${ref}`;
}
function download(name:string,content:string) { const url=URL.createObjectURL(new Blob([content],{type:"text/yaml;charset=utf-8"})); const a=document.createElement('a');a.href=url;a.download=name;a.click();URL.revokeObjectURL(url); }

/** Shell 导航与页面身份同源：me 每次变化（登录、切换、401 过期）都广播一次。 */
function broadcastPortal(portal:string|null) { window.dispatchEvent(new CustomEvent('hustoj-portal',{detail:portal})); }

function Login({onLogin}:{onLogin:()=>void}) {
 const [error,setError]=useState('');
 const [busy,setBusy]=useState(false);
 const [health,setHealth]=useState<Row|null>(null);
 const [demoData,setDemoData]=useState<Row|null>(null);
 const [customUser,setCustomUser]=useState('');
 const [activeTab,setActiveTab]=useState<'teachers'|'students'|'sso'>('teachers');

 useEffect(()=>{
  let active=true;
  api('/health').then(h=>{if(active)setHealth(h);}).catch(()=>{});
  api('/demo/users').then(d=>{if(active)setDemoData(d);}).catch(()=>{});
  return()=>{active=false;};
 },[]);

 const handleLogin = async (userId: string) => {
  setBusy(true);
  setError('');
  try {
   await api('/session', 'POST', { userId });
   onLogin();
  } catch (e) {
   setError(String(e).split('|').pop() || '登录失败');
  } finally {
   setBusy(false);
  }
 };

 const loginUrl=(health&&health.loginUrl)||'/oj/loginpage.php';

 return (
  <div className="mx-auto max-w-2xl py-12">
   <p className="eyebrow">LEARN · PRACTICE · REFLECT</p>
   <h1 className="mb-6 text-4xl font-semibold">让每一次练习，<br/>成为看得见的进步。</h1>
   <Card>
    <CardTitle title="进入课程工作台" meta="哈尔滨工业大学（深圳） 计算机教学与实验平台"/>
    <a className={`${action} mt-2 w-full justify-center text-center`} href={loginUrl}>
     使用 HUSTOJ 账号统一认证登录 ↗
    </a>
    <p className="mt-2 text-meta text-fg-muted">
     正式环境通过学校 SSO 或统一认证自动识别身份，按任课与选课权限进入对应端。
    </p>

    {health && health.devLogin && (
     <div className="mt-6 border-t border-line pt-6">
      <div className="mb-4 flex items-center justify-between">
       <span className="text-title font-semibold">演示与测试环境快捷登录</span>
       <Badge tone="brand">多教师 · 专属授课隔离</Badge>
      </div>

      <div className="mb-4 flex border-b border-line text-meta">
       <button
        type="button"
        className={`px-4 py-2 font-medium border-b-2 transition-colors ${activeTab==='teachers'?'border-brand text-brand':'border-transparent text-fg-muted hover:text-fg'}`}
        onClick={()=>setActiveTab('teachers')}
       >
        任课教师 ({demoData?.teachers?.length || 0})
       </button>
       <button
        type="button"
        className={`px-4 py-2 font-medium border-b-2 transition-colors ${activeTab==='students'?'border-brand text-brand':'border-transparent text-fg-muted hover:text-fg'}`}
        onClick={()=>setActiveTab('students')}
       >
        学生身份 ({demoData?.students?.length || 0})
       </button>
       <button
        type="button"
        className={`px-4 py-2 font-medium border-b-2 transition-colors ${activeTab==='sso'?'border-brand text-brand':'border-transparent text-fg-muted hover:text-fg'}`}
        onClick={()=>setActiveTab('sso')}
       >
        学校 SSO 对接说明
       </button>
      </div>

      {activeTab === 'teachers' && (
       <div className="space-y-3">
        <p className="text-meta text-fg-muted">点击任课教师账号进入教学工作台，系统将依据排课数据库动态隔离该账号所授课程：</p>
        <div className="grid gap-2 sm:grid-cols-2">
         {(demoData?.teachers || [
          { userId: 'cm_pilot_teacher', desc: '当前授课: 示例教学班' },
          { userId: 'admin', desc: '系统管理员（全校课程统览）' },
         ]).map((t: Row) => (
          <button
           type="button"
           disabled={busy}
           key={t.userId}
           className="flex flex-col items-start rounded-control border border-line p-3 text-left hover:border-brand hover:bg-surface-muted transition-colors"
           onClick={() => handleLogin(t.userId)}
          >
           <div className="flex w-full items-center justify-between">
            <span className="font-semibold text-fg font-mono">{t.userId}</span>
            <Badge tone="brand">教师账号</Badge>
           </div>
           <p className="mt-1 text-meta text-fg-muted line-clamp-1">{t.desc}</p>
          </button>
         ))}
        </div>
       </div>
      )}

      {activeTab === 'students' && (
       <div className="space-y-3">
        <p className="text-meta text-fg-muted">选择学生测试账号，进入对应学生工作台查看当前选修课程与真实作业进度：</p>
        <div className="grid gap-2 sm:grid-cols-2">
         {(demoData?.students || [
          { userId: 'student_cs01', studentNo: '2401001', desc: '当前选修: COMP1011, COMP2001' },
          { userId: 'student_cs02', studentNo: '2301002', desc: '当前选修: COMP2052, COMP3011, COMP3001' },
          { userId: 'student_auto01', studentNo: '2302003', desc: '当前选修: COMP2014, COMP2050' },
          { userId: 'cm_pilot_student', studentNo: '2026001', desc: '体验学生' },
          { userId: 'cm_pilot_ta', studentNo: '2024TA01', desc: '助教视角' },
         ]).map((s: Row) => (
          <button
           type="button"
           disabled={busy}
           key={s.userId}
           className="flex flex-col items-start rounded-control border border-line p-3 text-left hover:border-brand hover:bg-surface-muted transition-colors"
           onClick={() => handleLogin(s.userId)}
          >
           <div className="flex w-full items-center justify-between">
            <span className="font-semibold text-fg font-mono">{s.userId}</span>
            <span className="text-meta text-fg-muted font-mono">{s.studentNo || s.userId}</span>
           </div>
           <p className="mt-1 text-meta text-fg-muted line-clamp-1">{s.desc}</p>
          </button>
         ))}
        </div>
       </div>
      )}

      {activeTab === 'sso' && (
       <div className="space-y-3 rounded-control border border-line bg-surface-muted p-4 text-meta">
        <div className="flex items-center gap-2">
         <Badge tone="ok">SSO 协议就绪</Badge>
         <span className="font-semibold text-fg">学校统一身份认证对接方案</span>
        </div>
        <p className="text-fg-muted leading-relaxed">
         本平台已配置反向代理认证透传协议。对接学校 CAS / SAML / OAuth2 单点登录系统时，学校网关或 Nginx 只需在 upstream 请求头中附加：
        </p>
        <div className="bg-surface p-3 font-mono text-xs rounded border border-line space-y-1">
         <div><span className="text-brand">X-Remote-User</span>: [教工号或学号]</div>
         <div><span className="text-brand">X-Remote-Role</span>: teacher | student</div>
        </div>
        <p className="text-fg-muted">
         后端识别请求头后将直接以 <code>authSource=&apos;sso&apos;</code> 免密建立受信会话，严格依据教师授课档案与学生选课名单划分权限。
        </p>
       </div>
      )}

      <div className="mt-4 flex gap-2 pt-3 border-t border-line">
       <input
        className={field}
        placeholder="或直接输入任一账号（如 teacher_wang / student_cs01）"
        value={customUser}
        onChange={e=>setCustomUser(e.target.value)}
        onKeyDown={e=>{if(e.key==='Enter'&&customUser.trim())handleLogin(customUser.trim());}}
       />
       <button
        type="button"
        disabled={busy||!customUser.trim()}
        className={`${action} shrink-0 disabled:opacity-40`}
        onClick={()=>handleLogin(customUser.trim())}
       >
        登录
       </button>
      </div>
     </div>
    )}

    {error && <p role="alert" className="mt-3 text-danger">{error}</p>}
   </Card>
  </div>
 );
}

function Heading({tag,title,description,children}:{tag:string;title:string;description?:string;children?:React.ReactNode}) {return <header className="flex flex-wrap items-end justify-between gap-4"><div><p className="eyebrow">{tag}</p><h1 className="text-3xl font-semibold tracking-tight">{title}</h1>{description&&<p className="mt-2 text-fg-muted">{description}</p>}</div>{children}</header>;}

function CourseList({rows,history=false,teacher=false,prefix,reload}:{rows:Row[];history?:boolean;teacher?:boolean;prefix:string;reload?:()=>void}) {
 const [showNewOffering, setShowNewOffering] = useState(false);
 const [newCourseId, setNewCourseId] = useState('');
 const [newTerm, setNewTerm] = useState('2026-春');
 const [newSection, setNewSection] = useState('');
 const [newTitle, setNewTitle] = useState('');
 const [busy, setBusy] = useState(false);
 const [msg, setMsg] = useState('');
 const [err, setErr] = useState('');

 const filtered=rows.filter(r=>teacher?['teacher','ta'].includes(r.role):history?r.status==='archived':r.status!=='archived');
 const distinctCourses = Array.from(new Map(rows.map(r => [r.course_id, { course_id: r.course_id, code: r.code, name: r.name }])).values());

 const handleCreateOffering = async () => {
  if (!newCourseId) { setErr('请选择开设的课程'); return; }
  if (!newSection.trim()) { setErr('请填写班级编号（如 02, 03）'); return; }
  setBusy(true); setErr(''); setMsg('');
  try {
   await api(`/courses/${newCourseId}/offerings`, 'POST', {
    term: newTerm,
    section: newSection.trim(),
    title: newTitle.trim() || undefined,
   });
   setNewSection(''); setNewTitle(''); setShowNewOffering(false);
   setMsg('新教学班开设成功！');
   if (reload) reload();
  } catch (e) {
   setErr(String(e).split('|').pop() || '开设失败');
  } finally {
   setBusy(false);
  }
 };

 return (
  <div className="space-y-7">
   <Heading
    tag={teacher?'TEACHING STUDIO':history?'LEARNING ARCHIVE':'MY LEARNING'}
    title={teacher?'教学工作台':history?'走过的学习旅程':'我的课程'}
    description={teacher?'从一份好作业开始，关注每位同学的学习过程。严格按您的授课名单隔离。':history?'已归档课程保留题单与学习记录，供你随时回顾。':'课程、每周作业和学习反馈，都在这里。'}
   >
    <div className="flex items-center gap-2">
     <Badge tone="brand">{filtered.length} 门课程</Badge>
     {teacher && (
      <Button onClick={()=>setShowNewOffering(!showNewOffering)}>
       {showNewOffering ? '取消' : '＋ 开设新班级'}
      </Button>
     )}
    </div>
   </Heading>

   {showNewOffering && (
    <Card>
     <CardTitle title="开设新教学班" meta="为当前所授课程增设新的教学班级（如 02班、实验班等）" />
     <div className="grid gap-3 sm:grid-cols-4 mt-4">
      <label className="text-meta">
       所属课程 *
       <select className={`${field} mt-1`} value={newCourseId} onChange={e=>setNewCourseId(e.target.value)}>
        <option value="">-- 请选择课程 --</option>
        {distinctCourses.map(c => (
         <option key={c.course_id} value={c.course_id}>{c.code} · {c.name}</option>
        ))}
       </select>
      </label>
      <label className="text-meta">
       学期 *
       <input className={`${field} mt-1`} value={newTerm} onChange={e=>setNewTerm(e.target.value)} />
      </label>
      <label className="text-meta">
       班级编号 *
       <input className={`${field} mt-1`} placeholder="如 02 或 卓越01" value={newSection} onChange={e=>setNewSection(e.target.value)} />
      </label>
      <label className="text-meta">
       教学班名称
       <input className={`${field} mt-1`} placeholder="选填，默认课程名+班号" value={newTitle} onChange={e=>setNewTitle(e.target.value)} />
      </label>
     </div>
     <div className="mt-4 flex gap-2">
      <Button disabled={busy} onClick={handleCreateOffering}>{busy ? '开设中…' : '立即开设'}</Button>
      <Button onClick={()=>setShowNewOffering(false)}>取消</Button>
     </div>
     {err && <p role="alert" className="mt-2 text-danger text-meta">{err}</p>}
     {msg && <p role="status" className="mt-2 text-brand text-meta">{msg}</p>}
    </Card>
   )}

   {!filtered.length?<Empty title="这里暂时没有课程" hint={teacher?'您暂未被分配此学期的任课教学班。':'请先由教师添加选课关系；也可以切换体验身份。'}/>:(
    <div className="grid gap-stack md:grid-cols-2">
     {filtered.map((r,i)=>(
      <Card key={r.offering_id}>
       <div className="flex items-center justify-between">
        <span className="course-number">{String(i+1).padStart(2,'0')}</span>
        <Badge tone={r.status==='archived'?'neutral':'brand'}>{r.status==='archived'?'已归档':'进行中'}</Badge>
       </div>
       <p className="mt-4 text-meta text-fg-muted">{r.code} · {r.term}</p>
       <h2 className="mt-1 text-2xl font-semibold">{r.name}</h2>
       <p className="mt-2 text-meta text-fg-muted">{r.section} 班 · 任课: {r.teacher_id}{r.role==='ta'?' · 助教（只读）':''}</p>
       <div className="mt-7 flex flex-wrap items-center gap-3">
        <Link className={action} href={`${prefix}/courses/${r.offering_id}`}>进入班级查看 →</Link>
        {teacher && r.role==='teacher' && (
         <Link className="px-4 py-2 border border-brand/40 text-brand rounded-control text-meta hover:bg-brand/5 flex items-center gap-1" href={`/teacher/categories?oid=${r.offering_id}`}>
          🌲 选题布置
         </Link>
        )}
        <Link className="px-4 py-2 border border-line rounded-control text-meta hover:bg-surface-muted flex items-center gap-1" href={`${prefix}/courses/${r.offering_id}?tab=ranklist`}>
         🏆 班级天梯榜
        </Link>
        {teacher && <Link className="text-fg-muted hover:text-fg py-2 text-meta" href={`/teacher/classes/${r.offering_id}`}>班级花名册</Link>}
        {r.hoa_repo&&/^HITSZ-OpenAuto\/[A-Za-z0-9_-]+$/.test(r.hoa_repo)?<a className="py-2 text-meta text-fg-muted" href={`https://github.com/${r.hoa_repo}`} target="_blank" rel="noreferrer">课程参考资料 ↗</a>:<span className="py-2 text-meta text-fg-subtle">标准课程</span>}
       </div>
      </Card>
     ))}
    </div>
   )}

   <Card>
    <CardTitle title={teacher?'教师教学与发布规范':'学习，从今天的一个小目标开始'} meta={teacher?'题面清楚 · 测试充分 · 反馈有据可查 · 班级名单动态管理':'先看题单，再做练习，最后回顾反馈。'}/>
    <div className="grid gap-4 sm:grid-cols-3">
     {(teacher?['开设班级与录入学生花名册','组织教学目标，审核发布作业','观察学情数据，针对性指导答疑']:['进入课程，找到当前批次','提交代码，读取真实判题结果','逐级查看学习建议，验证自己的假设']).map((s,i)=>(
      <p className="border-l-2 border-line pl-3 text-fg-muted" key={s}><span className="mr-2 text-brand">0{i+1}</span>{s}</p>
     ))}
    </div>
   </Card>
  </div>
 );
}

function Course({data,prefix,user}:{data:Row;prefix:string;user?:string}) {
 const o=data.offering; const student=o.role==='student'; 
 const [tab, setTab] = useState<'batches' | 'insights' | 'ranklist'>(() => {
  if (typeof window !== 'undefined') {
   const t = new URLSearchParams(window.location.search).get('tab');
   if (t === 'insights' || t === 'ranklist') return t;
  }
  return 'batches';
 });

 const switchTab = (newTab: 'batches' | 'insights' | 'ranklist') => {
  setTab(newTab);
  if (typeof window !== 'undefined') {
   const url = new URL(window.location.href);
   url.searchParams.set('tab', newTab);
   window.history.replaceState(null, '', url.toString());
  }
 };

 return (
  <div className="space-y-6">
   <Heading
    tag="COURSE OVERVIEW"
    title={o.title||'课程详情'}
    description={`${o.code ? o.code + ' · ' : ''}${o.term} · ${o.section} 班 · ${o.status==='archived'?'历史归档 · 只读':'当前教学班'}`}
   >
    {!student && (
     <div className="flex flex-wrap items-center gap-2">
      <Link className={action} href={`/teacher/categories?oid=${o.offering_id}`}>🌲 题库选题布置作业 →</Link>
      <Link className="px-4 py-2 border border-line rounded-control text-meta hover:bg-surface-muted" href={`/teacher/classes/${o.offering_id}`}>班级花名册</Link>
     </div>
    )}
   </Heading>

   {/* Course Internal Navigation Tabs */}
   <div className="flex items-center gap-2 border-b border-line pb-px">
    <button
     type="button"
     onClick={()=>switchTab('batches')}
     className={`px-4 py-2 text-sm font-medium border-b-2 transition ${
      tab==='batches'
       ? 'border-brand text-brand font-semibold'
       : 'border-transparent text-fg-muted hover:text-fg'
     }`}
    >
     📑 班级作业 ({data.batches?.length ?? 0})
    </button>
    {!student && (
     <button
      type="button"
      onClick={()=>switchTab('insights')}
      className={`px-4 py-2 text-sm font-medium border-b-2 transition ${
       tab==='insights'
        ? 'border-brand text-brand font-semibold'
        : 'border-transparent text-fg-muted hover:text-fg'
      }`}
     >
      📊 班级学情与完成情况
     </button>
    )}
    <button
     type="button"
     onClick={()=>switchTab('ranklist')}
     className={`px-4 py-2 text-sm font-medium border-b-2 transition ${
      tab==='ranklist'
       ? 'border-brand text-brand font-semibold'
       : 'border-transparent text-fg-muted hover:text-fg'
     }`}
    >
     🏆 班级天梯榜
    </button>
   </div>

   {/* Tab 1: Batches */}
   {tab==='batches' && (
    <div className="space-y-4">
     {data.batches.length===0?(
      student?(
       <Empty title="还没有开放的题单" hint="教师发布后，你会在这里看到本周作业。"/>
      ):(
       <Card>
        <CardTitle title="本教学班尚未发布作业批次" meta={`当前课程: ${o.code || ''} · ${o.title || ''}`}/>
        <p className="mt-3 text-fg-muted leading-relaxed">
         系统已集成 5 大知识支柱与 2,148 道精品题库，支持跨分类自由选题与多班级批量布置。点击下方按钮即可进入分类题库树，勾选试题一键发布！
        </p>
        <div className="mt-5 flex flex-wrap gap-3">
         <Link className={action} href={`/teacher/categories?oid=${o.offering_id}`}>🌲 进入分类题库选题布置 →</Link>
         <Link className="px-4 py-2 border border-line rounded-control text-meta hover:bg-surface-muted" href={`/teacher/classes/${o.offering_id}`}>查看班级学生花名册</Link>
        </div>
       </Card>
      )
     ):data.batches.map((b:Row)=>(
      <Card key={b.batch_id}>
       <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
         <p className="text-meta text-fg-muted">BATCH {String(b.seq).padStart(2,'0')} · 截止 {date(b.due_at)}</p>
         <h2 className="mt-2 text-xl font-semibold">{b.title}</h2>
         <div className="mt-2 flex flex-wrap items-center gap-2">
          {b.source_ref&&<Badge tone="brand">{formatSourceRef(b.source_ref)}</Badge>}
          {b.read_only==='1'&&<Badge tone="warn">只读来源 · 不可公开导出</Badge>}
          <span className="rounded-control bg-surface-muted px-2 py-0.5 text-xs text-fg">
           共 {b.problem_count} 道题
          </span>
          {!student && b.student_count > 0 && (
           <>
            <Badge tone={b.completion_rate >= 80 ? 'ok' : b.completion_rate >= 50 ? 'brand' : 'neutral'}>
             达标全通: {b.completed_count || 0} / {b.student_count} 人 ({b.completion_rate}%)
            </Badge>
            <span className="text-xs text-fg-muted">
             提交活跃: {b.submitted_count || 0} 人 ({b.submission_rate}%)
            </span>
           </>
          )}
          {student && (
           <p className="text-meta text-fg-muted">完成 {b.done} / {b.problem_count} 题</p>
          )}
         </div>
        </div>
        <Link className={action} href={`${prefix}/batches/${b.batch_id}`}>查看题单 →</Link>
       </div>
       {student && (
        <div className="mt-5">
         <Progress value={Number(b.done)} max={Number(b.problem_count)} label={`${b.title}完成进度`}/>
        </div>
       )}
       {!student && b.student_count > 0 && (
        <div className="mt-4 pt-3 border-t border-line flex items-center justify-between text-xs text-fg-muted">
         <span>全班完成推进度</span>
         <span className="font-mono font-medium text-fg">{b.completed_count || 0} / {b.student_count} 人 ({b.completion_rate}%)</span>
        </div>
       )}
      </Card>
     ))}
    </div>
   )}

   {/* Tab 2: Class Learning Analytics & Progress */}
   {tab==='insights' && (
    <div className="space-y-6">
     {/* Stats Cards */}
     <div className="grid gap-stack sm:grid-cols-4">
      <Stat label="班级在册人数" value={data.totalStudents || o.student_count || (data.insights?.students?.length ?? 0)} unit="人" />
      <Stat
       label="活跃提交人数"
       value={data.insights?.students?.filter((s:any)=>Number(s.attempts)>0).length ?? 0}
       unit="人"
       tone="brand"
      />
      <Stat
       label="人均通过题数"
       value={data.insights?.students?.length ? (data.insights.students.reduce((acc:number,s:any)=>acc+Number(s.passed||0),0)/data.insights.students.length).toFixed(1) : '0.0'}
       unit="题"
       tone="ok"
      />
      <Stat
       label="累计代码提交"
       value={data.insights?.students?.reduce((acc:number,s:any)=>acc+Number(s.attempts||0),0) ?? 0}
       unit="次"
      />
     </div>

     {/* Results clusters if available */}
     {data.insights?.results && data.insights.results.length > 0 && (
      <Card>
       <CardTitle title="班级评测结果分布统计" meta="按 HUSTOJ 实时判题结果聚合" />
       <div className="mt-4 flex flex-wrap gap-2.5">
        {data.insights.results.map((c:any)=>(
         <div key={c.result} className="flex items-center gap-2 rounded-control border border-line bg-surface-muted px-3 py-2 text-xs">
          <Badge tone={Number(c.result) === 4 ? 'ok' : Number(c.result) === 6 ? 'warn' : 'danger'}>
           {c.label || `Code ${c.result}`}
          </Badge>
          <span className="font-mono font-bold text-fg">{c.count}</span>
          <span className="text-fg-muted">次</span>
         </div>
        ))}
       </div>
      </Card>
     )}

     {/* Student Progress Roster */}
     <Card>
      <CardTitle
       title="学生练习进度与完成明细"
       meta={`共 ${data.insights?.students?.length ?? 0} 位同学`}
      />
      {(!data.insights?.students || data.insights.students.length === 0) ? (
       <Empty title="暂无学情数据" hint="当班级学生开始提交代码后，此处将呈现详细分析。" />
      ) : (
       <div className="mt-4 overflow-x-auto">
        <table className="w-full text-left text-sm">
         <thead>
          <tr className="border-b border-line text-xs font-semibold text-fg-muted">
           <th className="py-2.5 px-3">学生</th>
           <th className="py-2.5 px-3">学号</th>
           <th className="py-2.5 px-3">已通过题目</th>
           <th className="py-2.5 px-3">累计提交尝试</th>
           <th className="py-2.5 px-3">最近活跃时间</th>
           <th className="py-2.5 px-3">学情状态</th>
          </tr>
         </thead>
         <tbody className="divide-y divide-line">
          {data.insights.students.map((s:any)=>{
           const passed = Number(s.passed || 0);
           const attempts = Number(s.attempts || 0);
           const isStruggling = attempts >= 5 && passed === 0;
           const isInactive = attempts === 0;
           return (
            <tr key={s.user_id} className="hover:bg-surface-muted/50 transition">
             <td className="py-3 px-3 font-medium text-fg">
              {s.nick || s.user_id}
              {s.user_id === o.teacher_id && <span className="ml-1 text-xs text-brand">(教师)</span>}
             </td>
             <td className="py-3 px-3 font-mono text-xs text-fg-muted">
              {s.student_no || s.user_id}
             </td>
             <td className="py-3 px-3">
              <Badge tone={passed > 0 ? 'ok' : 'neutral'}>{passed} 题</Badge>
             </td>
             <td className="py-3 px-3 font-mono text-xs text-fg">
              {attempts} 次
             </td>
             <td className="py-3 px-3 text-xs text-fg-muted">
              {s.last_active ? date(s.last_active) : '尚未提交'}
             </td>
             <td className="py-3 px-3">
              {isStruggling ? (
               <Badge tone="danger">需重点辅导</Badge>
              ) : isInactive ? (
               <Badge tone="neutral">未开始</Badge>
              ) : passed >= 10 ? (
               <Badge tone="ok">进度领先</Badge>
              ) : (
               <Badge tone="brand">平稳进行</Badge>
              )}
             </td>
            </tr>
           );
          })}
         </tbody>
        </table>
       </div>
      )}
     </Card>
    </div>
   )}

   {/* Tab 3: Class Leaderboard (Ranklist) */}
   {tab==='ranklist' && (
    <div className="space-y-4">
     <RankListView
      portal={student ? 'student' : 'teacher'}
      user={user || ''}
      offeringId={o.offering_id}
      embedded
     />
    </div>
   )}
  </div>
 );
}

type BasketItem = {
 setId: string;
 setName: string;
 slug: string;
 title: string;
 difficulty?: string;
 knowledge?: string[];
 statement?: string;
};

function ProblemSetCard({
 item,
 expanded,
 onToggleExpand,
 basketSlugs,
 onToggleBasketItem,
 onToggleBasketAll,
 onQuickImport,
 busy,
 readonly,
}: {
 item: Row;
 expanded: boolean;
 onToggleExpand: () => void;
 basketSlugs: string[];
 onToggleBasketItem: (problem: Row) => void;
 onToggleBasketAll: () => void;
 onQuickImport: () => void;
 busy: boolean;
 readonly: boolean;
}) {
 const problems: Row[] = item.problems || [];
 const allSlugs = problems.map(p => p.slug);
 const isAllInBasket = allSlugs.length > 0 && allSlugs.every(s => basketSlugs.includes(s));

 return (
  <div className={`rounded-control border transition-all ${expanded ? 'border-brand shadow-sm bg-surface' : 'border-line bg-surface hover:border-brand/60'}`}>
   <div className="p-4">
    <div className="flex flex-wrap items-start justify-between gap-3">
     <div className="space-y-1.5 flex-1 min-w-[260px]">
      <div className="flex flex-wrap items-center gap-2">
       <h3 className="text-lg font-semibold text-fg">{item.title}</h3>
       {item.matched && <Badge tone="brand">教学大纲匹配</Badge>}
       <Badge tone="neutral">{item.count} 题</Badge>
       {basketSlugs.length > 0 && (
        <Badge tone="ok">已选 {basketSlugs.length} 题入篮 🛒</Badge>
       )}
      </div>
      {item.categoryName && item.categoryName !== item.title && (
       <p className="text-meta text-fg-muted">分类类别: {item.categoryName}</p>
      )}
      {item.difficultyCount && Object.keys(item.difficultyCount).length > 0 && (
       <div className="flex flex-wrap items-center gap-1.5 text-xs text-fg-muted pt-1">
        <span>难度分布:</span>
        {Object.entries(item.difficultyCount).map(([lvl, cnt]) => (
         <span key={lvl} className="inline-block rounded bg-surface-muted border border-line px-1.5 py-0.5 font-mono">
          {lvl}: {Number(cnt)}
         </span>
        ))}
       </div>
      )}
     </div>
     <div className="flex flex-wrap items-center gap-2">
      <Button onClick={onToggleExpand}>
       {expanded ? '收起题目 ▲' : `预览与勾选 (${problems.length}) ▼`}
      </Button>
      <button
       type="button"
       disabled={busy || readonly}
       className="px-3 py-1.5 border border-line rounded-control text-meta hover:bg-surface-muted disabled:opacity-40"
       title="快速以此单一题单创建草稿"
       onClick={onQuickImport}
      >
       仅选用本单草稿 →
      </button>
     </div>
    </div>

    {expanded && (
     <div className="mt-4 border-t border-line pt-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded bg-surface-muted p-2.5 text-meta">
       <label className="flex items-center gap-2 cursor-pointer font-medium select-none">
        <input
         type="checkbox"
         checked={isAllInBasket}
         onChange={onToggleBasketAll}
        />
        {isAllInBasket ? '取消本单全部勾选' : `全选本题单加入组卷篮 (${allSlugs.length} 题)`}
       </label>
       <div className="flex items-center gap-3 text-xs">
        <span className="text-fg-muted">本题单已入篮: <strong className="text-brand font-semibold">{basketSlugs.length}</strong> / {allSlugs.length} 题</span>
       </div>
      </div>

      <div className="max-h-96 overflow-y-auto divide-y divide-line pr-1 space-y-2">
       {problems.map(p => {
        const isChecked = basketSlugs.includes(p.slug);
        return (
         <div
          key={p.slug}
          className={`rounded p-2.5 transition-colors cursor-pointer ${isChecked ? 'bg-brand/5 border border-brand/20' : 'hover:bg-surface-muted/40'}`}
          onClick={() => onToggleBasketItem(p)}
         >
          <div className="flex items-start gap-3">
           <input
            type="checkbox"
            className="mt-1"
            checked={isChecked}
            onChange={() => {}}
           />
           <div className="flex-1 min-w-0">
            <div className="flex flex-wrap items-center gap-2">
             <span className="font-medium text-sm text-fg">{p.title}</span>
             <span className="font-mono text-xs text-fg-muted">{p.slug}</span>
             {p.difficulty && (
              <span className={`text-xs px-1.5 py-0.5 rounded ${
               String(p.difficulty).includes('入门') || String(p.difficulty).includes('easy') || String(p.difficulty).startsWith('L1')
                ? 'bg-ok/10 text-ok border border-ok/30'
                : String(p.difficulty).includes('普及') || String(p.difficulty).startsWith('L3')
                ? 'bg-brand/10 text-brand border border-brand/30'
                : 'bg-warn/10 text-warn border border-warn/30'
              }`}>
               {p.difficulty}
              </span>
             )}
             {p.provenance && (
              <span className="text-xs text-fg-muted bg-surface-muted px-1.5 py-0.5 rounded">
               {p.provenance}
              </span>
             )}
            </div>
            {p.statement && (
             <div className="mt-1.5 text-xs text-fg-muted line-clamp-2 leading-relaxed">
              <MarkdownView content={p.statement} />
             </div>
            )}
            {p.knowledge && p.knowledge.length > 0 && (
             <div className="mt-1.5 flex flex-wrap gap-1">
              {p.knowledge.map((k: string) => (
               <span key={k} className="text-xs text-fg-subtle bg-surface px-1.5 py-0.5 border border-line rounded">
                #{k}
               </span>
              ))}
             </div>
            )}
           </div>
          </div>
         </div>
        );
       })}
      </div>
     </div>
    )}
   </div>
  </div>
 );
}

const EXAMPLE={title:'第一周 · 输入与计算',problems:[{slug:'sum-two',title:'两个整数的和',statement:'输入两个整数 a 和 b，输出它们的和。\n数据范围：-1000000 ≤ a,b ≤ 1000000。',knowledge:['输入输出','整数运算'],samples:[{input:'1 2\n',output:'3\n'}],tests:[{input:'-2 5\n',output:'3\n'},{input:'0 0\n',output:'0\n'},{input:'1000000 1000000\n',output:'2000000\n'}]}]};
function Studio({data,oid,archived,ta}:{data:Row[];oid:string;archived:boolean;ta:boolean}) {
 const router=useRouter();
 const [content,setContent]=useState(JSON.stringify(EXAMPLE,null,2));
 const [topic,setTopic]=useState('');
 const [error,setError]=useState('');
 const [busy,setBusy]=useState(false);

 const [activeTab, setActiveTab] = useState<'recommended'|'categories'|'contests'|'custom'>('recommended');
 const [setsData, setSetsData] = useState<Row|null>(null);
 const [loadingSets, setLoadingSets] = useState(true);
 const [expandedId, setExpandedId] = useState<string|null>(null);
 const [importingId, setImportingId] = useState<string|null>(null);
 const [searchFilter, setSearchFilter] = useState('');

 // Cross-set Problem Basket state
 const [basket, setBasket] = useState<BasketItem[]>([]);
 const [showBasketDetail, setShowBasketDetail] = useState(false);
 const [basketTitle, setBasketTitle] = useState('');

 useEffect(() => {
  let active = true;
  api(`/offerings/${oid}/problem-sets`).then(res => {
   if (active) {
    setSetsData(res);
    setLoadingSets(false);
   }
  }).catch(() => {
   if (active) setLoadingSets(false);
  });
  return () => { active = false; };
 }, [oid]);

 const run=async(gen=false)=>{
  setBusy(true);setError('');
  try{
   const r=await api(`/offerings/${oid}/${gen?'generate':'drafts'}`,'POST',gen?{topic}:{content});
   router.push(`/teacher/drafts/${r.id}`);
  }catch(e){
   setError(String(e).split('|').pop()||'保存失败');
  }finally{
   setBusy(false);
  }
 };

 const handleToggleBasketItem = (item: Row, problem: Row) => {
  const exists = basket.some(b => b.setId === item.id && b.slug === problem.slug);
  if (exists) {
   setBasket(basket.filter(b => !(b.setId === item.id && b.slug === problem.slug)));
  } else {
   if (basket.length >= 100) {
    setError('选题篮最多容纳 100 道试题');
    return;
   }
   setBasket([...basket, {
    setId: item.id,
    setName: item.title,
    slug: problem.slug,
    title: problem.title,
    difficulty: problem.difficulty,
    knowledge: problem.knowledge || [],
    statement: problem.statement || '',
   }]);
  }
 };

 const handleToggleBasketAll = (item: Row) => {
  const problems: Row[] = item.problems || [];
  const allIn = problems.length > 0 && problems.every(p => basket.some(b => b.setId === item.id && b.slug === p.slug));
  if (allIn) {
   setBasket(basket.filter(b => b.setId !== item.id));
  } else {
   const toAdd: BasketItem[] = [];
   for (const p of problems) {
    if (!basket.some(b => b.setId === item.id && b.slug === p.slug)) {
     toAdd.push({
      setId: item.id,
      setName: item.title,
      slug: p.slug,
      title: p.title,
      difficulty: p.difficulty,
      knowledge: p.knowledge || [],
      statement: p.statement || '',
     });
    }
   }
   if (basket.length + toAdd.length > 100) {
    setError('选题篮最多容纳 100 道试题');
    return;
   }
   setBasket([...basket, ...toAdd]);
  }
 };

 const handleImportBasket = async () => {
  if (basket.length === 0) return;
  setBusy(true);
  setError('');
  try {
   const defaultTitle = setsData
    ? `${setsData.courseName || setsData.courseCode} · 综合练习作业 (${basket.length} 题)`
    : `综合练习作业 (${basket.length} 题)`;
   const res = await api(`/offerings/${oid}/import-set`, 'POST', {
    title: basketTitle.trim() || defaultTitle,
    items: basket.map(b => ({ setId: b.setId, slug: b.slug })),
   });
   router.push(`/teacher/drafts/${res.id}`);
  } catch (e) {
   setError(String(e).split('|').pop() || '生成草稿失败');
  } finally {
   setBusy(false);
  }
 };

 const handleQuickImport = async (item: Row) => {
  setImportingId(item.id);
  setError('');
  try {
   const setBasketSlugs = basket.filter(b => b.setId === item.id).map(b => b.slug);
   const res = await api(`/offerings/${oid}/import-set`, 'POST', {
    setId: item.id,
    selectedSlugs: setBasketSlugs.length > 0 ? setBasketSlugs : undefined,
   });
   router.push(`/teacher/drafts/${res.id}`);
  } catch (e) {
   setError(String(e).split('|').pop() || '导入题单失败');
  } finally {
   setImportingId(null);
  }
 };

 const readonly=archived||ta;
 const readonlyHint=archived?'历史教学班为只读：不能新建草稿、导入题单或生成 AI 草稿；历史内容仅供查看与导出。':'助教身份为只读：可以查看与导出，不能新建或修改题单。';

 const recommendedItems = setsData ? [...(setsData.courseSets || []), ...(setsData.recommendedCategories || [])] : [];
 const categoryItems = setsData?.allCategories ? (
  searchFilter.trim()
   ? setsData.allCategories.filter((c: Row) =>
      c.title.toLowerCase().includes(searchFilter.toLowerCase()) ||
       c.categoryName.toLowerCase().includes(searchFilter.toLowerCase()) ||
       (c.tags || c.courses || []).some((k: string) => k.toLowerCase().includes(searchFilter.toLowerCase()))
      )
   : setsData.allCategories
 ) : [];
 const contestItems = setsData?.contestSets || [];

 const distinctSets = Array.from(new Set(basket.map(b => b.setName)));
 const basketDiffCounts: Record<string, number> = {};
 for (const b of basket) {
  const diff = b.difficulty ? String(b.difficulty).slice(0, 2) : '其他';
  basketDiffCounts[diff] = (basketDiffCounts[diff] || 0) + 1;
 }

 return (
  <div className={`space-y-6 ${basket.length > 0 ? 'pb-32' : ''}`}>
   <Heading
    tag="AUTHORING STUDIO"
    title="把教学目标，变成一次好练习。"
    description={setsData ? `当前课程: ${setsData.courseCode} · ${setsData.courseName} (${setsData.offeringTitle})` : "自编题、选择课程题单或让 AI 辅助起草，统一经过审核发布。"}
   >
    <div className="flex gap-2">
     <Link className="px-4 py-2 border border-line rounded-control text-meta hover:bg-surface-muted" href={`/teacher/courses/${oid}`}>查看已发布作业</Link>
     <Link className="px-4 py-2 border border-line rounded-control text-meta hover:bg-surface-muted" href={`/teacher/classes/${oid}`}>班级管理</Link>
     <Link className="px-4 py-2 border border-brand/40 text-brand rounded-control text-meta hover:bg-brand/5 flex items-center gap-1.5" href="/teacher/categories"><span>🌲 分类题库树 ↗</span></Link>
    </div>
   </Heading>

   {readonly && <Empty title={archived?'历史教学班为只读':'助教只读'} hint={readonlyHint}/>}

   {/* Prominent Recommendation to use the new Category Tree */}
   <Card className="border border-brand/30 bg-brand/5 p-4">
     <div className="flex flex-wrap items-center justify-between gap-3">
       <div className="space-y-1">
         <div className="flex items-center gap-2">
           <span className="text-base font-semibold text-fg">🌲 全景分类题库选题与多班级批量布置</span>
           <Badge tone="brand">新功能</Badge>
         </div>
         <p className="text-xs text-fg-muted">
           已上线 5 大支柱、2,148 道精品试题、思维导图漫游与跨分类试题篮，可一键批量分发至多个教学班。
         </p>
       </div>
       <Link className={action} href={`/teacher/categories?oid=${oid}`}>
         进入分类题库选题布置 →
       </Link>
     </div>
   </Card>

   {/* Mode Selection Tabs */}
   <div className="border-b border-line flex flex-wrap gap-1 text-meta">
    <button
     type="button"
     className={`px-4 py-2.5 font-medium border-b-2 transition-colors flex items-center gap-2 ${activeTab==='recommended'?'border-brand text-brand font-semibold':'border-transparent text-fg-muted hover:text-fg'}`}
     onClick={()=>setActiveTab('recommended')}
    >
     <span>🎯 本课程推荐题单</span>
     {setsData && <span className="rounded-full bg-brand/10 text-brand px-2 py-0.5 text-xs font-mono">{recommendedItems.length}</span>}
    </button>
    <button
     type="button"
     className={`px-4 py-2.5 font-medium border-b-2 transition-colors flex items-center gap-2 ${activeTab==='categories'?'border-brand text-brand font-semibold':'border-transparent text-fg-muted hover:text-fg'}`}
     onClick={()=>setActiveTab('categories')}
    >
     <span>📚 全学科 24 知识库</span>
     <span className="rounded-full bg-surface-muted px-2 py-0.5 text-xs font-mono">24</span>
    </button>
    <button
     type="button"
     className={`px-4 py-2.5 font-medium border-b-2 transition-colors flex items-center gap-2 ${activeTab==='contests'?'border-brand text-brand font-semibold':'border-transparent text-fg-muted hover:text-fg'}`}
     onClick={()=>setActiveTab('contests')}
    >
     <span>🏆 竞赛与名校题单</span>
     {setsData && <span className="rounded-full bg-surface-muted px-2 py-0.5 text-xs font-mono">{contestItems.length}</span>}
    </button>
    <button
     type="button"
     className={`px-4 py-2.5 font-medium border-b-2 transition-colors flex items-center gap-2 ${activeTab==='custom'?'border-brand text-brand font-semibold':'border-transparent text-fg-muted hover:text-fg'}`}
     onClick={()=>setActiveTab('custom')}
    >
     <span>✏️ 自编 YAML / AI 生成</span>
    </button>
   </div>

   {loadingSets && activeTab !== 'custom' && (
    <Card><p className="py-8 text-center text-fg-muted">正在加载该课程题库与知识点映射…</p></Card>
   )}

   {/* Tab 1: Recommended */}
   {!loadingSets && activeTab === 'recommended' && (
    <div className="space-y-4">
     <div className="flex flex-wrap items-center justify-between gap-3 bg-surface-muted/60 p-4 rounded-control border border-line">
      <div>
       <h2 className="font-semibold text-fg">课程专属教学题单库</h2>
       <p className="mt-1 text-meta text-fg-muted">
        系统已自动匹配【{setsData?.courseCode} · {setsData?.courseName}】教学大纲涵盖的知识模块。支持跨集合勾选多道试题统一组卷。
       </p>
      </div>
      <Badge tone="brand">共 {recommendedItems.length} 份匹配题单</Badge>
     </div>

     {recommendedItems.length === 0 ? (
      <Empty title="暂无推荐题单" hint="可切换至「全学科 24 知识库」或「竞赛题单」进行选择。"/>
     ) : (
      <div className="grid gap-3">
       {recommendedItems.map((item: Row) => (
        <ProblemSetCard
         key={item.id}
         item={item}
         expanded={expandedId === item.id}
         onToggleExpand={() => setExpandedId(expandedId === item.id ? null : item.id)}
         basketSlugs={basket.filter(b => b.setId === item.id).map(b => b.slug)}
         onToggleBasketItem={(prob) => handleToggleBasketItem(item, prob)}
         onToggleBasketAll={() => handleToggleBasketAll(item)}
         onQuickImport={() => handleQuickImport(item)}
         busy={importingId === item.id}
         readonly={readonly}
        />
       ))}
      </div>
     )}
    </div>
   )}

   {/* Tab 2: 24 Categories */}
   {!loadingSets && activeTab === 'categories' && (
    <div className="space-y-4">
     <div className="flex flex-wrap items-center justify-between gap-3 bg-surface-muted/60 p-4 rounded-control border border-line">
      <div>
       <h2 className="font-semibold text-fg">全学科 24 知识点分类库 (1,167 题)</h2>
       <p className="mt-1 text-meta text-fg-muted">覆盖大学计算机大纲从基础输入输出、排序检索，到树堆图论与动态规划全谱系。勾选题单内的题目可与推荐题单合并组卷。</p>
      </div>
      <input
       type="text"
       placeholder="🔍 检索知识点或题单名称…"
       value={searchFilter}
       onChange={e => setSearchFilter(e.target.value)}
       className="rounded-control border border-line bg-surface px-3 py-1.5 text-meta text-fg"
      />
     </div>

     <div className="grid gap-3">
      {categoryItems.map((item: Row) => (
       <ProblemSetCard
        key={item.id}
        item={item}
        expanded={expandedId === item.id}
        onToggleExpand={() => setExpandedId(expandedId === item.id ? null : item.id)}
        basketSlugs={basket.filter(b => b.setId === item.id).map(b => b.slug)}
        onToggleBasketItem={(prob) => handleToggleBasketItem(item, prob)}
        onToggleBasketAll={() => handleToggleBasketAll(item)}
        onQuickImport={() => handleQuickImport(item)}
        busy={importingId === item.id}
        readonly={readonly}
       />
      ))}
     </div>
    </div>
   )}

   {/* Tab 3: Contests */}
   {!loadingSets && activeTab === 'contests' && (
    <div className="space-y-4">
     <div className="bg-surface-muted/60 p-4 rounded-control border border-line">
      <h2 className="font-semibold text-fg">名校机试与程序设计竞赛精选</h2>
      <p className="mt-1 text-meta text-fg-muted">收录蓝桥杯大学组、洛谷普及/提高、USACO、东方博宜、牛客等知名赛事实战题集。可将竞赛真题与基础题目自由混合组卷。</p>
     </div>

     <div className="grid gap-3">
      {contestItems.map((item: Row) => (
       <ProblemSetCard
        key={item.id}
        item={item}
        expanded={expandedId === item.id}
        onToggleExpand={() => setExpandedId(expandedId === item.id ? null : item.id)}
        basketSlugs={basket.filter(b => b.setId === item.id).map(b => b.slug)}
        onToggleBasketItem={(prob) => handleToggleBasketItem(item, prob)}
        onToggleBasketAll={() => handleToggleBasketAll(item)}
        onQuickImport={() => handleQuickImport(item)}
        busy={importingId === item.id}
        readonly={readonly}
       />
      ))}
     </div>
    </div>
   )}

   {/* Tab 4: Custom YAML / AI */}
   {activeTab === 'custom' && (
    <div className="grid gap-stack lg:grid-cols-[1.6fr_1fr]">
     <Card>
      <CardTitle title="新建或导入题单" meta="支持平台 YAML、JSON 与 HUSTOJ FPS XML。上传后先形成草稿。"/>
      <label className="block text-meta">
       选择题单文件
       <input className="my-3 block w-full" type="file" accept=".json,.yaml,.yml,.xml" disabled={readonly} onChange={async e=>{
        const f=e.target.files?.[0];
        if(f){
         if(f.size>1048576){setError('文件不能超过 1MB');return;}
         setContent(await f.text());
        }
       }}/>
      </label>
      <textarea aria-label="题单文档" className={`${field} min-h-96 font-mono text-sm`} value={content} onChange={e=>setContent(e.target.value)}/>
      <button className={`${action} mt-4 disabled:opacity-40`} disabled={busy||readonly} onClick={()=>run()}>
       {readonly?(archived?'历史班只读':'助教只读'):'保存为草稿 →'}
      </button>
     </Card>
     <div className="space-y-stack">
      <Card>
       <CardTitle title="AI 辅助出题" meta="输入教学目标，生成可审核的题面、样例与测试草稿。"/>
       <textarea aria-label="AI 教学目标" className={`${field} min-h-32`} placeholder="例如：面向初学者，练习循环边界，难度基础，使用校园生活场景。" value={topic} onChange={e=>setTopic(e.target.value)}/>
       <button disabled={busy||!topic.trim()||readonly} className={`${action} mt-3 disabled:opacity-40`} onClick={()=>run(true)}>
        {busy?'正在处理…':'生成 AI 草稿'}
       </button>
       <p className="mt-3 text-meta text-fg-muted">需配置 AI 服务。生成结果不会自动发布。</p>
      </Card>
      <Card>
       <CardTitle title="教学参考资源" meta="教学大纲、配套讲义与经验共享"/>
       <p className="text-body text-fg">系统已内置与各门课程教学大纲匹配的标准知识点题库。</p>
       <p className="mt-3 text-meta text-fg-muted">支持跨题单多选、自编题目及导入自定义题单。公开导出保护私有测试用例。</p>
      </Card>
     </div>
    </div>
   )}

   {error && <p role="alert" className="text-danger">{error}</p>}

   {/* Drafts Workspace */}
   <Card>
    <CardTitle title="题单工作区" meta={`${data.length} 份草稿或已发布题单`}/>
    {data.length ? data.map(r => (
     <Link className="flex items-center justify-between border-t border-line py-4 hover:bg-surface-muted/30 px-2 rounded transition-colors" key={r.draft_id} href={`/teacher/drafts/${r.draft_id}`}>
      <span>
       {r.title}
       <span className="ml-2 text-meta text-fg-muted">{r.origin==='ai'?'AI 草稿':(r.origin==='hoa'||r.origin==='bank')?'题库引入':'教师编写'}</span>
      </span>
      <Badge tone={r.status==='published'?'ok':'neutral'}>{r.status==='published'?'已发布':'待审核'}</Badge>
     </Link>
    )) : (
     <Empty title="还没有草稿" hint="从上方题单中选用题目加入选题篮，一键生成草稿。"/>
    )}
   </Card>

   {/* Floating Sticky Problem Basket Bar */}
   {basket.length > 0 && (
    <div className="fixed bottom-0 left-0 right-0 z-50 border-t-2 border-brand bg-surface shadow-2xl transition-all">
     {showBasketDetail && (
      <div className="max-h-72 overflow-y-auto border-b border-line bg-surface-muted p-4">
       <div className="mx-auto max-w-6xl">
        <div className="mb-3 flex items-center justify-between">
         <span className="font-semibold text-fg text-sm">
          已选试题清单 ({basket.length} 题 · 跨 {distinctSets.length} 个题单)
         </span>
         <button
          type="button"
          className="text-xs text-fg-muted hover:text-danger"
          onClick={() => setBasket([])}
         >
          清空选题篮 🗑️
         </button>
        </div>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
         {basket.map((b, idx) => (
          <div
           key={`${b.setId}-${b.slug}`}
           className="flex items-center justify-between gap-2 rounded border border-line bg-surface p-2.5 text-xs shadow-sm"
          >
           <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
             <span className="font-semibold text-fg truncate">{idx + 1}. {b.title}</span>
             {b.difficulty && (
              <span className="px-1 py-0.5 rounded bg-surface-muted text-fg-muted font-mono text-[10px] shrink-0">
               {b.difficulty}
              </span>
             )}
            </div>
            <p className="text-[11px] text-fg-muted truncate mt-0.5">{b.setName}</p>
           </div>
           <button
            type="button"
            title="从篮中移除"
            className="shrink-0 p-1 text-fg-muted hover:text-danger hover:bg-surface-muted rounded"
            onClick={() => setBasket(basket.filter(x => !(x.setId === b.setId && x.slug === b.slug)))}
           >
            ✕
           </button>
          </div>
         ))}
        </div>
       </div>
      </div>
     )}

     <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 p-4">
      <div className="flex flex-wrap items-center gap-3">
       <div className="flex items-center gap-2.5">
        <span className="text-2xl">🛒</span>
        <div>
         <div className="flex items-center gap-2">
          <span className="font-bold text-fg">组卷选题篮</span>
          <span className="rounded-full bg-brand text-brand-fg px-2.5 py-0.5 text-xs font-mono font-bold">
           已选 {basket.length} 题
          </span>
          <Badge tone="brand">跨 {distinctSets.length} 个题单</Badge>
         </div>
         <div className="mt-0.5 flex items-center gap-1.5 text-xs text-fg-muted">
          {Object.entries(basketDiffCounts).map(([lvl, cnt]) => (
           <span key={lvl} className="font-mono">{lvl}:{cnt}</span>
          ))}
         </div>
        </div>
       </div>
       <Button onClick={() => setShowBasketDetail(!showBasketDetail)}>
        {showBasketDetail ? '收起明细 ▲' : `查看明细 (${basket.length}) ▼`}
       </Button>
       <button
        type="button"
        className="text-xs text-fg-muted hover:text-danger underline"
        onClick={() => setBasket([])}
       >
        清空
       </button>
      </div>

      <div className="flex flex-wrap items-center gap-3">
       <input
        type="text"
        className="w-64 md:w-80 rounded-control border border-line bg-surface px-3 py-2 text-sm text-fg focus:border-brand focus:outline-none"
        placeholder={setsData ? `${setsData.courseName || setsData.courseCode} · 综合练习作业` : '作业草稿标题（选填）'}
        value={basketTitle}
        onChange={e => setBasketTitle(e.target.value)}
       />
       <button
        type="button"
        disabled={busy || readonly}
        className={`${action} font-semibold py-2.5 px-6 shadow-md disabled:opacity-40`}
        onClick={handleImportBasket}
       >
        {busy ? '正在生成草稿…' : `生成多题单组合草稿 (${basket.length} 题) →`}
       </button>
      </div>
     </div>
    </div>
   )}
  </div>
 );
}

function Batch({data,reload,prefix}:{data:Row;reload:()=>void;prefix:string}) {
 const [selected,setSelected]=useState<number[]>([]); const [message,setMessage]=useState(''); const router=useRouter();const b=data.batch;const teacher=data.offering.role==='teacher';const student=data.offering.role==='student';
 const langLabels: Record<string, string> = { c: 'C', cpp: 'C++', java: 'Java', python: 'Python 3' };
 const batchAllowed = b.allowed_languages ? b.allowed_languages.split(',').map((x: string) => langLabels[x.trim()] || x.trim()).join(' / ') : '全部语言';
 const run=async(fn:()=>Promise<any>)=>{try{setMessage('');await fn();}catch(e){setMessage(String(e).split('|').pop()||'操作失败');}};
 return <div className="space-y-6"><Heading tag="ASSIGNMENT" title={b.title} description={`${data.offering.term} · 截止 ${date(b.due_at)}`}><div className="flex flex-wrap items-center gap-2"><Badge tone={b.ai_enabled==='1'?'brand':'neutral'}>AI 辅助{b.ai_enabled==='1'?'已开启':'已关闭'}</Badge><Badge tone="brand">允许语言: {batchAllowed}</Badge>{b.source_ref&&<Badge tone="brand">{formatSourceRef(b.source_ref)}</Badge>}{b.read_only==='1'&&<Badge tone="warn">只读来源 · 不可公开导出</Badge>}</div></Heading><div className="grid gap-stack sm:grid-cols-3">{student&&<Stat label="已通过" value={data.problems.filter((p:Row)=>p.passed==='1').length} unit="题"/>}<Stat label="题目总数" value={data.problems.length} unit="题"/>{student&&<Stat label="提交次数" value={data.problems.reduce((n:number,p:Row)=>n+Number(p.attempts),0)} unit="次"/>}</div><Card><CardTitle title="本批次题目" meta="按教学顺序推进，每道题都有自己的节奏。"/>{data.problems.length===0?<Empty title="暂无可见题目"/>:data.problems.map((p:Row)=><div className="flex flex-wrap items-center justify-between gap-3 border-t border-line py-5" key={p.problem_id}><div className="flex items-start gap-3">{teacher&&<input aria-label={`选择导出 ${p.title}`} type="checkbox" checked={selected.includes(Number(p.problem_id))} onChange={e=>setSelected(e.target.checked?[...selected,Number(p.problem_id)]:selected.filter(x=>x!==Number(p.problem_id)))}/>}<span className="text-fg-subtle">{String(p.seq).padStart(2,'0')}</span><div><h3 className="font-semibold">{p.title}</h3><p className="mt-1 text-meta text-fg-muted">{p.hint||'编程练习'}{student&&` · 提交 ${p.attempts} 次`}</p></div></div><div className="flex items-center gap-3">{student&&<Badge tone={p.passed==='1'?'ok':p.attempts!=='0'?'warn':'neutral'}>{p.passed==='1'?'已通过':p.attempts!=='0'?'继续尝试':'未提交'}</Badge>}<Link className={action} href={`${prefix}/batches/${b.batch_id}/problems/${p.problem_id}`}>{student?'进入练习':'预览题目'}</Link></div></div>)}</Card>{teacher&&<Card><CardTitle title="教师操作" meta={data.offering.status==='archived'?'历史教学班为只读：设置与复制不可用；非只读来源的已发布题单仍可导出。':b.read_only==='1'?'本批次来自只读来源（如 HOA 导入），按红线不可公开导出。':'公开导出只包含已勾选题目的题面与样例，不包含隐藏测试或学生代码。'}/><div className="flex flex-wrap gap-3"><Button disabled={data.offering.status==='archived'} onClick={()=>run(async()=>{await api(`/batches/${b.batch_id}`,'PATCH',{aiEnabled:b.ai_enabled!=='1'});reload();})}>{b.ai_enabled==='1'?'关闭':'开启'} AI 辅助</Button><Button disabled={data.offering.status==='archived'} onClick={()=>run(async()=>{const d=await api(`/batches/${b.batch_id}/copy`,'POST');router.push(`/teacher/drafts/${d.id}`);})}>复制为新草稿</Button><Button disabled={b.read_only==='1'} onClick={()=>run(async()=>{const d=await api(`/batches/${b.batch_id}/export`,'POST',{selected});download(d.filename,d.content);setMessage('已下载公开题单，尚未上传到 HOA。');})}>{b.read_only==='1'?'只读来源不可导出':'导出勾选题目'}（{selected.length}）</Button></div></Card>}{message&&<p role="status" className="text-brand">{message}</p>}</div>;
}

function Workspace({data,bid,pid,user}:{data:Row;bid:string;pid:string;user:string}) {
 const p=data.problem;
 const b=data.batch;
 const ALL_WORKSPACE_LANGS: [string, string][] = [['c','C'],['cpp','C++'],['java','Java'],['python','Python 3']];
 const allowedRaw = b?.allowed_languages || b?.allowedLanguages;
 const allowedList = allowedRaw
  ? (Array.isArray(allowedRaw) ? allowedRaw : String(allowedRaw).split(',')).map((x: string) => x.trim().toLowerCase()).filter(Boolean)
  : ['c', 'cpp', 'java', 'python'];
 const selectableLangs = ALL_WORKSPACE_LANGS.filter(([v]) => allowedList.includes(v));
 const finalLangs = selectableLangs.length > 0 ? selectableLangs : ALL_WORKSPACE_LANGS;

 const [code,setCode]=useState('');
 const [lang,setLang]=useState<string>(() => {
  return finalLangs.some(([v]) => v === 'python') ? 'python' : finalLangs[0][0];
 });
 const [result,setResult]=useState<Row|null>(null);
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState('');
 const [analysis,setAnalysis]=useState<Row|null>(null);
 const [sid,setSid]=useState<number|null>(null);

 useEffect(() => {
  if (!finalLangs.some(([v]) => v === lang)) {
   setLang(finalLangs[0][0]);
  }
 }, [allowedRaw]);
 useEffect(()=>{setCode(readDraft(user,bid,pid));setSid(null);setResult(null);setAnalysis(null);},[user,bid,pid]);
 useEffect(()=>{if(!sid)return;let active=true;let timer:ReturnType<typeof setTimeout>;let attempts=0;const poll=async()=>{try{const r=await api(`/submissions/${sid}`);if(!active)return;setResult(r);if([0,1,2,3,14].includes(Number(r.result))&&attempts++<60){timer=setTimeout(poll,1500);}else{setBusy(false);if(attempts>=60)setError('判题仍在队列中，请稍后刷新结果。');}}catch(e){if(active){setError(String(e));setBusy(false);}}};poll();return()=>{active=false;clearTimeout(timer);};},[sid]);
 const readOnly=data.role!=='student';
 if(readOnly)return <div className="space-y-6"><Heading tag={`PROBLEM ${pid}`} title={p.title} description={`${p.time_limit} 秒 · ${p.memory_limit} MB · ${data.archived?'历史课程只读':'题目预览（只读）'}`}/><Card><CardTitle title="题目要求" meta={data.role!=='student'?'教师预览：不包含学生代码与反馈区域。':undefined}/><MarkdownView content={p.description} placeholder="暂无题目要求描述"/>{p.input&&<><h3 className="mt-6 font-semibold">输入</h3><p className="whitespace-pre-wrap">{p.input}</p></>}{p.output&&<><h3 className="mt-6 font-semibold">输出</h3><p>{p.output}</p></>}<h3 className="mt-6 font-semibold">样例输入</h3><pre className="sample">{p.sample_input}</pre><h3 className="mt-4 font-semibold">样例输出</h3><pre className="sample">{p.sample_output}</pre></Card></div>;
 return <div className="space-y-6"><Heading tag={`PROBLEM ${pid}`} title={p.title} description={`${p.time_limit} 秒 · ${p.memory_limit} MB · ${data.archived?'历史课程只读':'编程练习'}`}/><div className="grid grid-cols-1 lg:grid-cols-2 gap-stack items-stretch"><Card className="flex flex-col h-full lg:max-h-[820px] overflow-hidden"><CardTitle title="题目要求"/><div className="flex-1 overflow-y-auto min-h-0 space-y-4 pr-2"><MarkdownView content={p.description} placeholder="暂无题目要求描述"/>{p.input&&<><h3 className="mt-6 font-semibold">输入</h3><p className="whitespace-pre-wrap">{p.input}</p></>}{p.output&&<><h3 className="mt-6 font-semibold">输出</h3><p>{p.output}</p></>}<h3 className="mt-6 font-semibold">样例输入</h3><pre className="sample">{p.sample_input}</pre><h3 className="mt-4 font-semibold">样例输出</h3><pre className="sample">{p.sample_output}</pre></div></Card><Card className="flex flex-col h-full lg:max-h-[820px] overflow-hidden"><CardTitle title="我的代码" meta="草稿按身份与题目隔离保存在当前浏览器，判题结果来自 HUSTOJ。"/><div className="flex-1 flex flex-col min-h-0 overflow-y-auto pr-2"><label className="block text-meta shrink-0">编程语言{finalLangs.length < 4 ? ` (本作业允许: ${finalLangs.map(([,l])=>l).join('/')})` : ''}<select className={`${field} my-2`} value={lang} onChange={e=>setLang(e.target.value)}>{finalLangs.map(([v,l])=><option key={v} value={v}>{l}</option>)}</select></label><CodeEditor className="flex-1 min-h-[320px]" value={code} language={lang} readOnly={data.archived} onChange={next=>{setCode(next);writeDraft(user,bid,pid,next);}}/><div className="shrink-0 pt-3"><button className={`${action} disabled:opacity-40`} disabled={busy||data.archived} onClick={async()=>{setBusy(true);setError('');setAnalysis(null);try{const r=await api(`/batches/${bid}/problems/${pid}/submissions`,'POST',{code,language:lang});setSid(r.submissionId);}catch(e){setError(String(e).split('|').pop()||'提交失败');setBusy(false);}}}>{busy?'正在判题…':'正式提交作业'}</button>{error&&<p role="alert" className="mt-2 text-meta text-danger">{error}</p>}{result&&<div className="mt-3 border-t border-line pt-3"><div className="flex items-center justify-between"><Badge tone={result.result==='4'?'ok':'warn'}>#{sid} · {result.label}</Badge><span className="text-meta text-fg-muted">{result.time} ms · {result.memory} KB</span></div>{result.error&&<div className="mt-3"><JudgeDetailView error={result.error} /></div>}</div>}</div></div></Card><TrialPanel className="lg:min-h-[460px] lg:max-h-[600px]" bid={bid} pid={pid} code={code} language={lang} sampleInput={p.sample_input||''} sampleOutput={p.sample_output||''} disabled={data.archived}/><Card className="flex flex-col h-full lg:min-h-[460px] lg:max-h-[600px] overflow-hidden"><CardTitle title="学习反馈" meta="F 为判题事实，A 为待验证的学习建议。"/><div className="flex-1 overflow-y-auto min-h-0 space-y-4 pr-2">{data.batch.ai_enabled!=='1'?<Empty title="本批次已关闭 AI 辅助"/>:!sid||!result||[0,1,2,3,14].includes(Number(result.result))?<p className="text-fg-muted">完成一次判题后，可以逐级查看反馈。</p>:<div><div className="flex flex-wrap gap-2">{[1,2,3].map(level=><Button key={level} onClick={async()=>{try{setAnalysis(await api(`/submissions/${sid}/analysis?level=${level}`));}catch(e){setError(String(e));}}}>{level} 级提示</Button>)}</div>{analysis&&<div className="mt-4 space-y-3">{analysis.mode&&<Badge tone={analysis.mode==='model'?'brand':'neutral'}>{analysis.mode==='model'?'模型生成':'规则建议'}</Badge>}<p className="text-meta text-fg-muted">{analysis.label}</p>{analysis.evidence.map((e:Row)=><div key={e.id} className="rounded-control border border-line bg-surface-muted/50 p-3"><Badge tone={e.kind==='F'?'neutral':'brand'}>{e.id} · {e.kind==='F'?'判题事实':'解释与建议'}</Badge><p className="mt-2 text-meta text-fg leading-relaxed">{e.text}</p></div>)}</div>}</div>}</div></Card></div></div>;
}

function DraftEditor({data,reload,archived,ta}:{data:Row;reload:()=>void;archived:boolean;ta:boolean}) {
 const router=useRouter();const [doc,setDoc]=useState<Row>(data.document);const [reviewed,setReviewed]=useState(false);const [due,setDue]=useState('');const [ai,setAI]=useState(true);
 const [allowedLangs,setAllowedLangs]=useState<string[]>(()=>{
  const raw = data.document?.allowed_languages;
  return raw ? String(raw).split(',').map((x:string)=>x.trim().toLowerCase()).filter(Boolean) : ['c','cpp','java','python'];
 });
 const [message,setMessage]=useState('');const [busy,setBusy]=useState(false);const published=data.status==='published';const readOnly=published||archived||ta;
 const patchProblem=(i:number,k:string,v:unknown)=>setDoc({...doc,problems:doc.problems.map((p:Row,n:number)=>n===i?{...p,[k]:v}:p)});
 const run=async(publish=false)=>{
  setBusy(true);setMessage('');
  try{
   await api(`/drafts/${data.draft_id}`,'PUT',{document:{...doc,allowed_languages:allowedLangs.join(',')}});
   if(publish){
    const r=await api(`/drafts/${data.draft_id}/publish`,'POST',{reviewed,dueAt:due,aiEnabled:ai,allowedLanguages:allowedLangs.join(',')});
    router.push(`/teacher/batches/${r.batchId}`);
   }else{
    setMessage('草稿已保存');reload();
   }
  }catch(e){
   setMessage(String(e).split('|').pop()||'操作失败');
  }finally{
   setBusy(false);
  }
 };
 return <div className="space-y-6"><Heading tag="REVIEW & PUBLISH" title={published?'已发布的题单':'审核题单'} description={archived&&!published?'历史教学班为只读，本草稿仅可查看。':ta&&!published?'助教身份为只读，本草稿仅可查看。':'题面、样例和隐藏测试都确认后，再交给学生。'}/><Card><label>题单标题<input disabled={readOnly} className={`${field} mt-2`} value={doc.title} onChange={e=>setDoc({...doc,title:e.target.value})}/></label></Card>{doc.problems.map((p:Row,i:number)=><Card key={i}><CardTitle title={`题目 ${i+1} · ${p.title}`}/><fieldset disabled={readOnly} className="space-y-4"><label className="block">标题<input className={field} value={p.title} onChange={e=>patchProblem(i,'title',e.target.value)}/></label><label className="block">题面<textarea className={`${field} min-h-40`} value={p.statement} onChange={e=>patchProblem(i,'statement',e.target.value)}/></label>{(['samples','tests'] as const).map(kind=><div key={kind}><h3 className="mb-2 font-semibold">{kind==='samples'?'公开样例':'隐藏测试（不会公开导出）'}</h3>{(p[kind]||[]).map((sample:Row,n:number)=><div key={n} className="mb-3 grid gap-3 sm:grid-cols-2">{['input','output'].map(k=><label key={k} className="text-meta">{k==='input'?'输入':'预期输出'} #{n+1}<textarea className={`${field} font-mono`} value={sample[k]} onChange={e=>patchProblem(i,kind,p[kind].map((s:Row,j:number)=>j===n?{...s,[k]:e.target.value}:s))}/></label>)}</div>)}<Button disabled={readOnly} onClick={()=>patchProblem(i,kind,[...(p[kind]||[]),{input:'',output:''}])}>添加{kind==='samples'?'样例':'测试'}</Button></div>)}</fieldset></Card>)}{published?<Link className={action} href={`/teacher/batches/${data.batch_id}`}>查看已发布题单 →</Link>:archived?<Empty title="历史教学班为只读" hint="草稿不可修改或发布；如需复用请先在当前教学班复制。"/>:ta?<Empty title="助教身份为只读" hint="可以查看题单内容；修改与发布由任课教师完成。"/>:<Card><CardTitle title="发布设置"/><div className="space-y-4"><label className="block">截止时间<input type="datetime-local" className={`${field} mt-2`} value={due} onChange={e=>setDue(e.target.value)}/></label><label className="flex gap-2"><input type="checkbox" checked={ai} onChange={e=>setAI(e.target.checked)}/>允许本批次使用学习反馈</label><label className="block text-meta">允许编程语言<div className="mt-2 flex flex-wrap gap-3">{[{id:'c',label:'C'},{id:'cpp',label:'C++'},{id:'java',label:'Java'},{id:'python',label:'Python 3'}].map(lang=><label key={lang.id} className="flex items-center gap-1.5 text-xs cursor-pointer"><input type="checkbox" disabled={readOnly} checked={allowedLangs.includes(lang.id)} onChange={e=>{if(e.target.checked)setAllowedLangs([...allowedLangs,lang.id]);else{if(allowedLangs.length<=1){alert('至少保留一种允许的语言');return;}setAllowedLangs(allowedLangs.filter(l=>l!==lang.id));}}}/>{lang.label}</label>)}</div></label><label className="flex gap-2"><input type="checkbox" checked={reviewed} onChange={e=>setReviewed(e.target.checked)}/>我已核对题面与测试输出，并确认隐藏测试覆盖样例之外的输入</label><div className="flex gap-3"><button disabled={busy} className={action} onClick={()=>run(false)}>保存草稿</button><button disabled={!reviewed||busy} className={`${action} disabled:opacity-40`} onClick={()=>run(true)}>{busy?'正在处理…':'审核并发布'}</button></div></div></Card>}{message&&<p role="status" className="text-brand">{message}</p>}</div>;
}

function Insights({data}:{data:Row}) {return <div className="space-y-6"><Heading tag="CLASS INSIGHTS" title="看见每位同学的进步" description={data.offering.title}/><div className="grid gap-stack sm:grid-cols-3"><Stat label="选课人数" value={data.students.length}/><Stat label="累计提交" value={data.students.reduce((n:number,s:Row)=>n+Number(s.attempts),0)}/><Stat label="已开始练习" value={data.students.filter((s:Row)=>Number(s.attempts)>0).length}/></div><div className="grid gap-stack lg:grid-cols-2"><Card><CardTitle title="判题结果分布" meta={data.source}/>{data.results.length?data.results.map((r:Row)=><div className="my-4" key={r.result}><div className="mb-2 flex justify-between"><span>{r.label}</span><span>{r.count} 次</span></div><Progress label={r.label} value={Number(r.count)} max={data.results.reduce((n:number,x:Row)=>n+Number(x.count),0)}/></div>):<Empty title="尚无提交数据"/>}</Card><Card><CardTitle title="需要关注的学习进展" meta="按学生列出实际进度，不进行排名。"/><div className="overflow-auto"><table className="w-full text-left zebra"><thead><tr><th>学生</th><th>通过题数</th><th>提交次数</th></tr></thead><tbody>{data.students.map((s:Row)=><tr key={s.user_id}><td className="py-4">{s.user_id}</td><td>{s.passed}</td><td>{s.attempts}</td></tr>)}</tbody></table></div></Card></div></div>;}

function ClassManagement({data, reload, archived, ta}:{data:Row; reload:()=>void; archived:boolean; ta:boolean}) {
 const off = data.offering;
 const students: Row[] = data.students || [];
 const [message, setMessage] = useState('');
 const [error, setError] = useState('');
 const [busy, setBusy] = useState(false);
 const [showAdd, setShowAdd] = useState(false);
 const [addMode, setAddMode] = useState<'single'|'batch'>('single');
 const [singleId, setSingleId] = useState('');
 const [singleNo, setSingleNo] = useState('');
 const [singleName, setSingleName] = useState('');
 const [batchText, setBatchText] = useState('');

 const run = async (fn: () => Promise<any>) => {
  setBusy(true);
  setMessage('');
  setError('');
  try {
   await fn();
   reload();
  } catch (e) {
   setError(String(e).split('|').pop() || '操作失败');
  } finally {
   setBusy(false);
  }
 };

 const handleAddStudent = async () => {
  if (addMode === 'single') {
   if (!singleId.trim()) { setError('请填写学生学号或账号'); return; }
   await run(async () => {
    await api(`/offerings/${off.offering_id}/students`, 'POST', {
     userId: singleId.trim(),
     studentNo: singleNo.trim() || singleId.trim(),
     name: singleName.trim() || singleId.trim(),
     role: 'student',
    });
    setSingleId(''); setSingleNo(''); setSingleName('');
    setShowAdd(false);
    setMessage('学生添加成功');
   });
  } else {
   if (!batchText.trim()) { setError('请粘贴名单内容'); return; }
   await run(async () => {
    const res = await api(`/offerings/${off.offering_id}/students`, 'POST', {
     rawText: batchText.trim(),
     role: 'student',
    });
    setBatchText('');
    setShowAdd(false);
    setMessage(`批量录入成功，已处理 ${res.count || 0} 位学生`);
   });
  }
 };

 const handleDrop = async (userId: string) => {
  if (!confirm(`确认将学生 ${userId} 从当前班级移出？`)) return;
  await run(async () => {
   await api(`/offerings/${off.offering_id}/students/${userId}`, 'DELETE');
   setMessage(`已移出学生 ${userId}`);
  });
 };

 const handleToggleStatus = async () => {
  const nextStatus = off.status === 'archived' ? 'active' : 'archived';
  await run(async () => {
   await api(`/offerings/${off.offering_id}`, 'PATCH', { status: nextStatus });
   setMessage(nextStatus === 'archived' ? '教学班已设为归档' : '教学班已激活');
  });
 };

 return (
  <div className="space-y-6">
   <Heading
    tag="CLASS & ROSTER MANAGEMENT"
    title={off.name ? `${off.name} · 班级管理` : (off.title || '教学班管理')}
    description={`${off.code || ''} · ${off.term} · ${off.section} 班 · 任课教师: ${off.teacher_id}`}
   >
    <div className="flex gap-2">
     <Link className={action} href={`/teacher/offerings/${off.offering_id}`}>出题工作台 →</Link>
     <Link className="px-4 py-2 border border-line rounded-control text-meta hover:bg-surface-muted" href={`/teacher/insights/${off.offering_id}`}>班级学情</Link>
    </div>
   </Heading>

   <div className="grid gap-stack sm:grid-cols-3">
    <Stat label="班级在册人数" value={students.filter(s=>s.status==='active').length} unit="人" />
    <Stat label="已开始做题" value={students.filter(s=>Number(s.attempts)>0).length} unit="人" />
    <Stat label="累计作业提交" value={students.reduce((n,s)=>n+Number(s.attempts||0),0)} unit="次" />
   </div>

   <Card>
    <div className="flex flex-wrap items-center justify-between gap-4">
     <div>
      <CardTitle title="学生花名册" meta="任课教师可在此添加学生、批量录入名单，或调整教学班状态。" />
     </div>
     <div className="flex flex-wrap gap-2">
      <Button disabled={archived || ta} onClick={()=>setShowAdd(!showAdd)}>
       {showAdd ? '收起录入面板' : '＋ 添加学生 / 批量录入'}
      </Button>
      <Button disabled={ta} onClick={handleToggleStatus}>
       {off.status === 'archived' ? '激活教学班' : '归档此班级'}
      </Button>
     </div>
    </div>

    {showAdd && (
     <div className="mt-4 rounded-control border border-brand bg-surface-muted p-4 space-y-4">
      <div className="flex items-center gap-4 text-meta font-medium">
       <label className="flex items-center gap-1 cursor-pointer">
        <input type="radio" checked={addMode==='single'} onChange={()=>setAddMode('single')} />
        单个录入
       </label>
       <label className="flex items-center gap-1 cursor-pointer">
        <input type="radio" checked={addMode==='batch'} onChange={()=>setAddMode('batch')} />
        批量导入 (支持 Excel 粘贴)
       </label>
      </div>

      {addMode === 'single' ? (
       <div className="grid gap-3 sm:grid-cols-3">
        <label className="text-meta">
         学号 / 账号 *
         <input className={`${field} mt-1`} placeholder="如 2401005 或 student_cs05" value={singleId} onChange={e=>setSingleId(e.target.value)} />
        </label>
        <label className="text-meta">
         显示学号
         <input className={`${field} mt-1`} placeholder="如 2401005" value={singleNo} onChange={e=>setSingleNo(e.target.value)} />
        </label>
        <label className="text-meta">
         学生姓名
         <input className={`${field} mt-1`} placeholder="如 钱七" value={singleName} onChange={e=>setSingleName(e.target.value)} />
        </label>
       </div>
      ) : (
       <div>
        <p className="mb-2 text-meta text-fg-muted">每行一个学生，可从 Excel 复制列直接粘贴（格式：学号/账号 [制表符/逗号] 学号 [制表符/逗号] 姓名）：</p>
        <textarea
         className={`${field} font-mono text-sm min-h-28`}
         placeholder={"2401006\t2401006\t周八\n2401007\t2401007\t吴九"}
         value={batchText}
         onChange={e=>setBatchText(e.target.value)}
        />
       </div>
      )}

      <div className="flex gap-2">
       <Button disabled={busy} onClick={handleAddStudent}>
        {busy ? '正在录入…' : '确认录入并激活'}
       </Button>
       <Button onClick={()=>setShowAdd(false)}>取消</Button>
      </div>
     </div>
    )}

    {message && <p role="status" className="mt-3 text-brand text-meta">{message}</p>}
    {error && <p role="alert" className="mt-3 text-danger text-meta">{error}</p>}

    <div className="mt-6 overflow-auto">
     <table className="w-full text-left zebra">
      <thead>
       <tr>
        <th>学号</th>
        <th>姓名</th>
        <th>用户名</th>
        <th>角色</th>
        <th>通过题数</th>
        <th>提交次数</th>
        <th>状态</th>
        <th>操作</th>
       </tr>
      </thead>
      <tbody>
       {students.length === 0 ? (
        <tr>
         <td colSpan={8} className="py-8 text-center text-fg-muted">
          暂无选课学生。请点击上方“添加学生”添加名单。
         </td>
        </tr>
       ) : (
        students.map(s => (
         <tr key={s.user_id} className={s.status === 'dropped' ? 'opacity-50' : ''}>
          <td className="py-3 font-mono">{s.student_no || s.user_id}</td>
          <td className="font-medium">{s.nick || s.user_id}</td>
          <td className="font-mono text-fg-muted text-meta">{s.user_id}</td>
          <td><Badge tone={s.role==='ta'?'brand':'neutral'}>{s.role==='ta'?'助教':'学生'}</Badge></td>
          <td className="text-ok font-semibold">{s.passed || 0}</td>
          <td>{s.attempts || 0}</td>
          <td>
           <Badge tone={s.status === 'active' ? 'ok' : 'neutral'}>
            {s.status === 'active' ? '在册' : '已退课'}
           </Badge>
          </td>
          <td>
           {s.status === 'active' && !archived && !ta && (
            <button
             type="button"
             disabled={busy}
             className="text-danger hover:underline text-meta"
             onClick={() => handleDrop(s.user_id)}
            >
             移出
            </button>
           )}
          </td>
         </tr>
        ))
       )}
      </tbody>
     </table>
    </div>
   </Card>
  </div>
 );
}

export function Platform() {
 const path=usePathname();
 return <PlatformPage key={path}/>;
}

function PlatformPage() {
 const path=usePathname();const router=useRouter();const route=matchRoute(path);const parts=path.split('/').filter(Boolean);const reload=()=>setRevision(n=>n+1);
 // 1) 先确认身份：未认证只渲染登录壳；me 变化广播给 Shell，让导航同源同步。
 const [me,setMe]=useState<Row|null>(null);const [meError,setMeError]=useState('');const [revision,setRevision]=useState(0);
 useEffect(()=>{let active=true;setMe(null);setMeError('');api('/me').then(m=>{if(!active)return;setMe(m);broadcastPortal(m.portal||null);}).catch(e=>{if(!active)return;setMeError(e.message);broadcastPortal(null);});return()=>{active=false;};},[revision]);
 // 2) 身份与路由检查未通过时不发数据请求、不渲染内容；跳转目标在 effect 里统一执行。
 const home=me?(me.home||(me.portal==='teacher'?'/teacher':'/student')):'/';
 const prefix=me&&me.portal==='teacher'?'/teacher':'/student';
 let redirectTo:string|null=null;
 if(me){
  const portal=routePortal(route);
  if(portal&&portal!==me.portal)redirectTo=home;
  else if(route.name==='redirect')redirectTo=route.to;
  else if(route.name==='home')redirectTo=home;
  else if(route.name==='legacy-course')redirectTo=`${prefix}/courses/${route.oid}`;
  else if(route.name==='legacy-batch')redirectTo=`${prefix}/batches/${route.bid}`;
  else if(route.name==='legacy-workspace')redirectTo=`${prefix}/batches/${route.bid}/problems/${route.pid}`;
  else if(route.name==='legacy-categories')redirectTo=`${prefix}/categories`;
 }
 useEffect(()=>{if(redirectTo)router.replace(redirectTo);},[redirectTo]);
 // 3) 端内数据：仅在身份通过且无跳转目标后请求。
 let endpoint='';
 if(route.name==='student'||route.name==='student-history'||route.name==='teacher')endpoint='/courses';
 if(route.name==='student-course'||route.name==='teacher-course')endpoint=`/offerings/${route.oid}`;
 if(route.name==='student-batch'||route.name==='teacher-batch')endpoint=`/batches/${route.bid}`;
 if(route.name==='student-workspace'||route.name==='teacher-workspace')endpoint=`/batches/${route.bid}/problems/${route.pid}`;
 if(route.name==='studio')endpoint=`/offerings/${route.oid}/drafts`;
 if(route.name==='draft')endpoint=`/drafts/${route.did}`;
 if(route.name==='insights')endpoint=`/offerings/${route.oid}/insights`;
 if(route.name==='classes')endpoint=`/offerings/${route.oid}/students`;
 const dataReady=!!(me&&!redirectTo&&endpoint);
 const [data,setData]=useState<any>(null);const [error,setError]=useState('');const [archived,setArchived]=useState(false);const [ta,setTa]=useState(false);
 useEffect(()=>{
  let active=true;
  setError('');setData(null);setArchived(false);setTa(false);
  if(!dataReady)return;
  loadPortalPage(endpoint,route,me!.portal,api).then(page=>{
   if(!active)return;
   setArchived(page.archived);setTa(page.ta);setData(page.data);
  }).catch(e=>{
   if(!active)return;
   if(String(e.message).startsWith('401|')){broadcastPortal(null);setMe(null);setMeError(e.message);}
   else setError(e.message);
  });
  return()=>{active=false;};
 },[endpoint,dataReady,revision]);
  if(route.name==='faq')return <FaqView/>;
 if(meError.startsWith('401|'))return <Login onLogin={()=>{reload();router.refresh();}}/>;
 if(meError)return <div className="space-y-4"><Empty title={meError.split('|').pop()||'身份确认失败'} hint="请重新登录后再试。"/><Button onClick={reload}>重新加载</Button></div>;
 if(!me||redirectTo)return <p role="status" className="py-20 text-center text-fg-muted">{!me?'正在确认登录身份…':'正在跳转…'}</p>;
 if(route.name==='not-found')return <div className="space-y-4"><Empty title="页面未找到" hint={`路径 /${parts.join('/')} 不属于课程工作台的任何功能，请检查链接是否正确。`}/><Link className={action} href={home}>返回工作台</Link></div>;
  if(route.name==='student-status'||route.name==='teacher-status')return <StatusStreamView portal={me.portal} user={me.user}/>;
  if(route.name==='student-ranklist'||route.name==='teacher-ranklist')return <RankListView portal={me.portal} user={me.user}/>;
  if(route.name==='student-problems')return <PublicProblemListView/>;
  if(route.name==='student-problem-detail')return <PublicProblemWorkspace pid={route.pid} user={me.user}/>;
  if(route.name==='student-categories'||route.name==='teacher-categories')return <CategoryTreeView portal={me.portal} user={me.user}/>;
 if(error)return <div className="space-y-4"><Empty title={error.split('|').pop()||'加载失败'} hint="请检查当前登录身份与课程权限。"/><Button onClick={reload}>重新加载</Button><Link className="ml-3 text-brand" href={home}>返回工作台</Link></div>;
 if(!data)return <p role="status" className="py-20 text-center text-fg-muted">正在读取课程数据…</p>;
 if(route.name==='student')return <CourseList rows={data.filter((r:Row)=>r.role==='student')} prefix={prefix}/>;
 if(route.name==='student-history')return <CourseList rows={data.filter((r:Row)=>r.role==='student')} history prefix={prefix}/>;
 if(route.name==='teacher')return <CourseList rows={data.filter((r:Row)=>['teacher','ta'].includes(r.role))} teacher prefix={prefix} reload={reload}/>;
 if(route.name==='student-course'||route.name==='teacher-course')return <Course data={data} prefix={prefix} user={me.user}/>;
 if(route.name==='student-workspace'||route.name==='teacher-workspace')return <Workspace key={path} user={me.user} data={data} bid={route.bid} pid={route.pid}/>;
 if(route.name==='student-batch'||route.name==='teacher-batch')return <Batch data={data} reload={reload} prefix={prefix}/>;
 if(route.name==='studio')return <Studio data={data} oid={route.oid} archived={archived} ta={ta}/>;
 if(route.name==='draft')return <DraftEditor key={data.draft_id} data={data} reload={reload} archived={archived} ta={ta}/>;
 if(route.name==='insights')return <Insights data={data}/>;
 if(route.name==='classes')return <ClassManagement data={data} reload={reload} archived={archived} ta={ta}/>;
 return null;
}
