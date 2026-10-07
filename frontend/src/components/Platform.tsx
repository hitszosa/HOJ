"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { Badge, Button, Card, CardTitle, Empty, Progress, Stat } from "@/components/ui";
import { matchRoute, readDraft, routePortal, writeDraft } from "@/lib/routes";
import {canManageLibrary} from '@/lib/platform-navigation';
import { loadPortalPage } from "@/lib/portal";
import { CodeEditor } from "@/components/CodeEditor";
import { TrialPanel } from "@/components/TrialPanel";
import { StatusStreamView } from "@/components/StatusStreamView";
import { PublicProblemWorkspace } from "@/components/PublicProblems";
import { LibraryHub } from "@/components/LibraryHub";
import { MarkdownView } from "@/components/MarkdownView";
import { JudgeDetailView } from "@/components/JudgeDetailView";
import {ProblemSetEditor} from "@/components/ProblemSetEditor";
import {TeacherQuestionRanking} from "@/components/TeacherQuestionRanking";
import { ProblemWeightSettings } from "@/components/ProblemWeightSettings";
import { weightedGrade, weightShare } from "@/lib/grading";

import { api } from "@/lib/api";
import type { Me } from "@/api/generated/Me";
import type { BatchDetail } from "@/api/generated/BatchDetail";
import type { ProblemDetail } from "@/api/generated/ProblemDetail";
import type { Draft } from "@/api/generated/Draft";
import type { InsightsResponse } from "@/api/generated/InsightsResponse";
import type { SubmissionResult } from "@/api/generated/SubmissionResult";
import type { DraftCreated } from "@/api/generated/DraftCreated";
import type { Analysis } from "@/api/generated/Analysis";
import type { Document } from "@/api/generated/Document";
import type { SubmitResponse } from "@/api/generated/SubmitResponse";
import type { ExportResponse } from "@/api/generated/ExportResponse";

const field="w-full rounded-control border border-line bg-surface px-3 py-2 text-body text-fg focus:outline-none focus:ring-2 focus:ring-brand";
const action="inline-flex rounded-control bg-brand px-4 py-2 text-meta font-medium text-brand-fg hover:opacity-90";
function date(value:string|null) { return value?value.replace('T',' ').slice(0,16):'未设置'; }
function formatSourceRef(ref: string | null | undefined) {
 if (!ref) return '';
 if (ref.startsWith('library:')) return '我的题单';
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
function broadcastPortal(identity:Me|null) {
 const portal=identity?.portal||null;
 window.dispatchEvent(new CustomEvent('hoj-identity',{detail:identity}));
 window.dispatchEvent(new CustomEvent('hoj-portal',{detail:portal}));
 window.dispatchEvent(new CustomEvent('hustoj-portal',{detail:portal}));
}

function Heading({tag,title,description,children}:{tag:string;title:string;description?:string;children?:React.ReactNode}) {return <header className="flex flex-wrap items-end justify-between gap-4"><div><p className="eyebrow">{tag}</p><h1 className="text-3xl font-semibold tracking-tight">{title}</h1>{description&&<p className="mt-2 text-fg-muted">{description}</p>}</div>{children}</header>;}

function Batch({data,reload,onWeightsSaved}:{data:BatchDetail;reload:()=>void;onWeightsSaved:(problems:BatchDetail["problems"])=>void}) {
 const [selected,setSelected]=useState<number[]>([]); const [message,setMessage]=useState(''); const router=useRouter();const b=data.batch;const teacher=data.offering.role==='teacher';const student=data.offering.role==='student';
 const params=useSearchParams();const [editing,setEditing]=useState(false),[editDoc,setEditDoc]=useState<Document|null>(null),[busyEdit,setBusyEdit]=useState(false);
 const startEdit=async()=>{setBusyEdit(true);try{setEditDoc(await api<Document>(`/batches/${b.batch_id}/document`));setEditing(true);}catch(e){setMessage(String(e).split('|').pop()||'无法编辑作业');}finally{setBusyEdit(false);}};
 useEffect(()=>{if(params.get('edit')==='1'&&teacher&&data.offering.status==='active')void startEdit();},[b.batch_id]);
 if(editing&&editDoc)return <div className="space-y-5"><Heading tag="ASSIGNMENT" title="编辑课程作业" description="保存后直接更新本次作业；改动题目的历史代码会重新评测，删除题目会实际清理对应提交。"/><ProblemSetEditor key={(editDoc as any).revision} initial={editDoc} assignment onCancel={()=>setEditing(false)} onSave={async doc=>{await api(`/batches/${b.batch_id}/document`,'PUT',{document:doc});setEditing(false);reload();}}/></div>;
 const langLabels: Record<string, string> = { c: 'C', cpp: 'C++', java: 'Java', python: 'Python 3' };
 const batchAllowed = b.allowed_languages.map((x) => langLabels[x] || x).join(' / ');
 const run=async(fn:()=>Promise<any>)=>{try{setMessage('');await fn();}catch(e){setMessage(String(e).split('|').pop()||'操作失败');}};
 return <div className="space-y-6"><Heading tag="ASSIGNMENT" title={b.title} description={`${data.offering.term} · 截止 ${date(b.due_at)}`}><div className="flex flex-wrap items-center gap-2"><Badge tone={b.ai_enabled?'brand':'neutral'}>AI 辅助{b.ai_enabled?'已开启':'已关闭'}</Badge><Badge tone="brand">允许语言: {batchAllowed}</Badge>{b.source_ref&&<Badge tone="brand">{formatSourceRef(b.source_ref)}</Badge>}{b.read_only&&<Badge tone="warn">只读来源 · 不可公开导出</Badge>}</div></Heading><div className="grid gap-stack sm:grid-cols-3">{student&&<Stat label="实验成绩" value={weightedGrade(data.problems)} unit="/ 100"/>}{student&&<Stat label="已通过" value={data.problems.filter((p)=>p.passed).length} unit="题"/>}<Stat label="题目总数" value={data.problems.length} unit="题"/>{student&&<Stat label="提交次数" value={data.problems.reduce((n,p)=>n+p.attempts,0)} unit="次"/>}</div><Card><CardTitle title="本批次题目" meta="按教学顺序推进，每道题都有自己的节奏。"/>{data.problems.length===0?<Empty title="暂无可见题目"/>:data.problems.map((p)=><div className="flex flex-wrap items-center justify-between gap-3 border-t border-line py-5" key={p.problem_id}><div className="flex items-start gap-3">{teacher&&<input aria-label={`选择导出 ${p.title}`} type="checkbox" checked={selected.includes(Number(p.problem_id))} onChange={e=>setSelected(e.target.checked?[...selected,Number(p.problem_id)]:selected.filter(x=>x!==Number(p.problem_id)))}/>}<span className="text-fg-subtle">{String(p.seq).padStart(2,'0')}</span><div><h3 className="font-semibold">{p.title}</h3><p className="mt-1 text-meta text-fg-muted">{p.hint||'编程练习'} · 分数占比 {weightShare(p,data.problems)}%{student&&` · 提交 ${p.attempts} 次`}</p></div></div><div className="flex items-center gap-3">{student&&<Badge tone={p.passed?'ok':p.has_previous_ac?'brand':p.attempts>0?'warn':'neutral'}>{p.passed?'已通过':p.has_previous_ac?'题库已AC · 未提交':p.attempts>0?'继续尝试':'未提交'}</Badge>}<Link className={action} href={`/assignments/${b.batch_id}/problems/${p.problem_id}`}>{student?'进入练习':'预览题目'}</Link></div></div>)}</Card>{teacher&&<TeacherQuestionRanking key={b.batch_id} data={data}/>} {teacher&&<ProblemWeightSettings data={data} onSaved={onWeightsSaved}/>} {teacher&&<Card><CardTitle title="教师操作" meta={data.offering.status==='archived'?'历史教学班为只读：设置与复制不可用；非只读来源的已发布题单仍可导出。':b.read_only?'本批次来自只读来源（如 HOA 导入），按红线不可公开导出。':'公开导出只包含已勾选题目的题面与样例，不包含隐藏测试或学生代码。'}/><div className="flex flex-wrap gap-3"><Button disabled={data.offering.status==='archived'||busyEdit} onClick={startEdit}>编辑作业题目</Button><Button disabled={data.offering.status==='archived'} onClick={()=>run(async()=>{if(!window.confirm(`实际删除作业「${b.title}」及其题目、提交代码和成绩？无法在页面中恢复。`))return;await api(`/batches/${b.batch_id}`,'DELETE');window.location.href=`/courses/${data.offering.offering_id}`;})}>删除本次作业</Button><Button disabled={data.offering.status==='archived'} onClick={()=>run(async()=>{await api(`/batches/${b.batch_id}`,'PATCH',{ai_enabled:!b.ai_enabled});reload();})}>{b.ai_enabled?'关闭':'开启'} AI 辅助</Button><Button disabled={data.offering.status==='archived'} onClick={()=>run(async()=>{const d=await api<DraftCreated>(`/batches/${b.batch_id}/copy`,'POST');router.push(`/programming/drafts/${d.id}`);})}>复制为新草稿</Button><Button disabled={b.read_only} onClick={()=>run(async()=>{const d=await api<ExportResponse>(`/batches/${b.batch_id}/export`,'POST',{selected});download(d.filename,d.content);setMessage('已下载公开题单，尚未上传到 HOA。');})}>{b.read_only?'只读来源不可导出':'导出勾选题目'}（{selected.length}）</Button></div></Card>}{message&&<p role="status" className="text-brand">{message}</p>}</div>;
}

function Workspace({data,bid,pid,user}:{data:ProblemDetail;bid:string;pid:string;user:string}) {
 const p=data.problem;
 const b=data.batch;
 const prev=data.previous_ac;
 const ALL_WORKSPACE_LANGS: [string, string][] = [['c','C'],['cpp','C++'],['java','Java'],['python','Python 3']];
 const allowedList = b.allowed_languages;
 const selectableLangs = ALL_WORKSPACE_LANGS.filter(([v]) => allowedList.includes(v));
 const finalLangs = selectableLangs.length > 0 ? selectableLangs : ALL_WORKSPACE_LANGS;

 const [code,setCode]=useState('');
 const [lang,setLang]=useState<string>(() => {
  return finalLangs.some(([v]) => v === 'python') ? 'python' : finalLangs[0][0];
 });
 const [result,setResult]=useState<SubmissionResult|null>(null);
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState('');
 const [analysis,setAnalysis]=useState<Analysis|null>(null);
 const [sid,setSid]=useState<number|null>(null);

 useEffect(() => {
  if (!finalLangs.some(([v]) => v === lang)) {
   setLang(finalLangs[0][0]);
  }
 }, [b.allowed_languages.join(',')]);
 useEffect(()=>{setCode(readDraft(user,bid,pid));setSid(null);setResult(null);setAnalysis(null);},[user,bid,pid]);
 useEffect(()=>{if(!sid)return;let active=true;let timer:ReturnType<typeof setTimeout>;let attempts=0;const poll=async()=>{try{const r=await api<SubmissionResult>(`/submissions/${sid}`);if(!active)return;setResult(r);if([0,1,2,3,14].includes(Number(r.result))&&attempts++<60){timer=setTimeout(poll,1500);}else{setBusy(false);if(attempts>=60)setError('判题仍在队列中，请稍后刷新结果。');}}catch(e){if(active){setError(String(e));setBusy(false);}}};poll();return()=>{active=false;clearTimeout(timer);};},[sid]);
 const readOnly=data.role!=='student';
 if(readOnly)return <div className="space-y-6"><Heading tag={`PROBLEM ${pid}`} title={p.title} description={`${p.time_limit} 秒 · ${p.memory_limit} MB · ${data.archived?'历史课程只读':'题目预览（只读）'}`}/><Card><CardTitle title="题目要求" meta={data.role!=='student'?'教师预览：不包含学生代码与反馈区域。':undefined}/><MarkdownView content={p.description} placeholder="暂无题目要求描述"/>{p.input&&<><h3 className="mt-6 font-semibold">输入</h3><p className="whitespace-pre-wrap">{p.input}</p></>}{p.output&&<><h3 className="mt-6 font-semibold">输出</h3><p>{p.output}</p></>}<h3 className="mt-6 font-semibold">样例输入</h3><pre className="sample">{p.sample_input}</pre><h3 className="mt-4 font-semibold">样例输出</h3><pre className="sample">{p.sample_output}</pre></Card></div>;
 return <div className="space-y-6"><Heading tag={`PROBLEM ${pid}`} title={p.title} description={`${p.time_limit} 秒 · ${p.memory_limit} MB · ${data.archived?'历史课程只读':'编程练习'}`}/><div className="grid grid-cols-1 lg:grid-cols-2 gap-stack items-stretch"><Card className="flex flex-col h-full lg:max-h-[820px] overflow-hidden"><CardTitle title="题目要求"/><div className="flex-1 overflow-y-auto min-h-0 space-y-4 pr-2"><MarkdownView content={p.description} placeholder="暂无题目要求描述"/>{p.input&&<><h3 className="mt-6 font-semibold">输入</h3><p className="whitespace-pre-wrap">{p.input}</p></>}{p.output&&<><h3 className="mt-6 font-semibold">输出</h3><p>{p.output}</p></>}<h3 className="mt-6 font-semibold">样例输入</h3><pre className="sample">{p.sample_input}</pre><h3 className="mt-4 font-semibold">样例输出</h3><pre className="sample">{p.sample_output}</pre></div></Card><Card className="flex flex-col h-full lg:max-h-[820px] overflow-hidden"><CardTitle title="我的代码" meta="草稿按身份与题目隔离保存在当前浏览器，判题结果来自 HOJ。"/><div className="flex-1 flex flex-col min-h-0 overflow-y-auto pr-2">{prev&&<div className="mb-3 rounded-control border border-ok/30 bg-ok-soft/70 p-3 text-xs"><div className="flex flex-wrap items-center justify-between gap-2"><div className="flex items-center gap-2"><span className="text-base">💡</span><div><p className="font-semibold text-ok">检测到您此前已在题库通过本题 (AC)</p><p className="mt-0.5 text-fg-muted">提交语言: <strong className="text-fg">{prev.language_name}</strong> · 耗时: {prev.time} ms · 提交时间: {prev.in_date}</p></div></div><button type="button" className="inline-flex items-center gap-1 rounded-control bg-ok px-3 py-1.5 font-medium text-white shadow-sm hover:opacity-90 active:scale-95 transition cursor-pointer" onClick={()=>{setCode(prev.code);if(prev.is_language_allowed){setLang(prev.language);}writeDraft(user,bid,pid,prev.code);}}>📥 一键载入上次通过代码</button></div>{!prev.is_language_allowed&&<p className="mt-2 text-warn border-t border-ok/20 pt-1.5">⚠️ 原提交语言 ({prev.language_name}) 不在当前作业允许列表中，载入后请按作业要求调整语言实现。</p>}</div>}<label className="block text-meta shrink-0">编程语言{finalLangs.length < 4 ? ` (本作业允许: ${finalLangs.map(([,l])=>l).join('/')})` : ''}<select className={`${field} my-2`} value={lang} onChange={e=>setLang(e.target.value)}>{finalLangs.map(([v,l])=><option key={v} value={v}>{l}</option>)}</select></label><CodeEditor className="flex-1 min-h-[320px]" value={code} language={lang} readOnly={data.archived} onChange={next=>{setCode(next);writeDraft(user,bid,pid,next);}}/><div className="shrink-0 pt-3"><button className={`${action} disabled:opacity-40`} disabled={busy||data.archived} onClick={async()=>{setBusy(true);setError('');setAnalysis(null);try{const r=await api<SubmitResponse>(`/batches/${bid}/problems/${pid}/submissions`,'POST',{code,language:lang});setSid(r.submission_id);}catch(e){setError(String(e).split('|').pop()||'提交失败');setBusy(false);}}}>{busy?'正在判题…':'正式提交作业'}</button>{error&&<p role="alert" className="mt-2 text-meta text-danger">{error}</p>}{result&&<div className="mt-3 border-t border-line pt-3"><div className="flex items-center justify-between"><Badge tone={result.result===4?'ok':'warn'}>#{sid} · {result.label}</Badge><span className="text-meta text-fg-muted">{result.time} ms · {result.memory} KB</span></div>{result.error&&<div className="mt-3"><JudgeDetailView error={result.error} /></div>}</div>}</div></div></Card><TrialPanel className="lg:min-h-[460px] lg:max-h-[600px]" bid={bid} pid={pid} code={code} language={lang} sampleInput={p.sample_input||''} sampleOutput={p.sample_output||''} disabled={data.archived}/><Card className="flex flex-col h-full lg:min-h-[460px] lg:max-h-[600px] overflow-hidden"><CardTitle title="学习反馈" meta="F 为判题事实，A 为待验证的学习建议。"/><div className="flex-1 overflow-y-auto min-h-0 space-y-4 pr-2">{!data.batch.ai_enabled?<Empty title="本批次已关闭 AI 辅助"/>:!sid||!result||[0,1,2,3,14].includes(Number(result.result))?<p className="text-fg-muted">完成一次判题后，可以逐级查看反馈。</p>:<div><div className="flex flex-wrap gap-2">{[1,2,3].map(level=><Button key={level} onClick={async()=>{try{setAnalysis(await api<Analysis>(`/submissions/${sid}/analysis?level=${level}`));}catch(e){setError(String(e));}}}>{level} 级提示</Button>)}</div>{analysis&&<div className="mt-4 space-y-3">{analysis.mode&&<Badge tone={analysis.mode==='model'?'brand':'neutral'}>{analysis.mode==='model'?'模型生成':'规则建议'}</Badge>}<p className="text-meta text-fg-muted">{analysis.label}</p>{analysis.evidence.map((e)=><div key={e.id} className="rounded-control border border-line bg-surface-muted/50 p-3"><Badge tone={e.kind==='F'?'neutral':'brand'}>{e.id} · {e.kind==='F'?'判题事实':'解释与建议'}</Badge><p className="mt-2 text-meta text-fg leading-relaxed">{e.text}</p></div>)}</div>}</div>}</div></Card></div></div>;
}

function DraftEditor({data,reload,archived,ta}:{data:Draft;reload:()=>void;archived:boolean;ta:boolean}) {
 const router=useRouter(),params=useSearchParams();const oid=params.get('oid');
 const back=`/library?${params.get('return')==='questions'?'view=public&source=mine':'view=mine'}${oid?`&oid=${oid}`:''}`;
 return <div className="space-y-6"><Heading tag="PROBLEM SET" title="出题" description="可以自己编写，也可以让 AI 先搭框架，再修改题面、样例和测试。保存后从我的题单布置作业。"/><ProblemSetEditor initial={data.document} returnToQuestions={params.get('return')==='questions'} readOnly={archived||ta} onCancel={()=>router.push(back)} onSave={async doc=>{await api(`/drafts/${data.draft_id}`,'PUT',{document:doc});}}/></div>;
}

type ProgrammingGrade = {user_id:string; student_no:string; real_name:string; batch_id:number; batch_title:string; required:number; passed:number; attempts:number; score:number; total_weight:number; passed_weight:number};
function ProgrammingGrades({offeringId}:{offeringId:number}) {
 const [rows,setRows]=useState<ProgrammingGrade[]>([]);
 const [error,setError]=useState('');
 const [loading,setLoading]=useState(true);
 const [exported,setExported]=useState(false);
 useEffect(()=>{let active=true;api<ProgrammingGrade[]>(`/offerings/${offeringId}/grades`).then(data=>{if(active)setRows(data);}).catch(e=>{if(active)setError(String(e).split('|').pop()||'成绩加载失败');}).finally(()=>{if(active)setLoading(false);});return()=>{active=false;};},[offeringId]);
 return <Card><div className="flex flex-wrap items-center justify-between gap-3"><CardTitle title="实验成绩" meta="每次实验按已 AC 计分题的权重占比自动折算为 100 分；重复 AC 不重复加分，未提交学生也包含在名单中。"/>{!loading&&!error&&rows.length>0&&<a className={action} href={`/api/offerings/${offeringId}/grades/export`} download={`programming-grades-${offeringId}.csv`} onClick={()=>setExported(true)}>导出学生成绩 CSV</a>}</div>{error&&<p role="alert" className="text-danger">{error}</p>}{loading?<p>正在加载成绩…</p>:<div className="overflow-auto mt-4"><table className="w-full text-left"><thead><tr><th>学号</th><th>姓名</th><th>实验</th><th>AC / 必做</th><th>成绩</th><th>提交次数</th></tr></thead><tbody>{rows.map(row=><tr key={`${row.user_id}-${row.batch_id}`}><td className="py-3">{row.student_no}</td><td>{row.real_name}</td><td>{row.batch_title}</td><td>{row.passed} / {row.required}</td><td>{row.score}</td><td>{row.attempts}</td></tr>)}</tbody></table>{!rows.length&&<p className="py-4 text-fg-muted">暂无已发布实验的成绩。</p>}</div>}{exported&&<p role="status" className="text-brand mt-3">已开始下载成绩列表，共 {rows.length} 条记录。</p>}</Card>;
}

function Insights({data}:{data:InsightsResponse}) {return <div className="space-y-6"><Heading tag="CLASS INSIGHTS" title="看见每位同学的进步" description={data.offering.title ?? undefined}/><ProgrammingGrades offeringId={data.offering.offering_id}/><div className="grid gap-stack sm:grid-cols-3"><Stat label="选课人数" value={data.students.length}/><Stat label="累计提交" value={data.students.reduce((n,s)=>n+s.attempts,0)}/><Stat label="已开始练习" value={data.students.filter((s)=>Number(s.attempts)>0).length}/></div><div className="grid gap-stack lg:grid-cols-2"><Card><CardTitle title="判题结果分布" meta={data.source}/>{data.results.length?data.results.map((r)=><div className="my-4" key={r.result}><div className="mb-2 flex justify-between"><span>{r.label}</span><span>{r.count} 次</span></div><Progress label={r.label} value={Number(r.count)} max={data.results.reduce((n,x)=>n+x.count,0)}/></div>):<Empty title="尚无提交数据"/>}</Card><Card><CardTitle title="需要关注的学习进展" meta="按学生列出实际进度，不进行排名。"/><div className="overflow-auto"><table className="w-full text-left zebra"><thead><tr><th>学生</th><th>通过题数</th><th>提交次数</th></tr></thead><tbody>{data.students.map((s)=><tr key={s.user_id}><td className="py-4">{s.user_id}</td><td>{s.passed}</td><td>{s.attempts}</td></tr>)}</tbody></table></div></Card></div></div>;}

function CourseContent({offeringId, children}:{offeringId:string|number; children:React.ReactNode}) {
 return <><a className="mb-6 inline-block text-body text-brand" href={`/courses/${offeringId}`}>← 返回课程</a>{children}</>;
}

export function Platform() {
 const path=usePathname();
 return <PlatformPage key={path}/>;
}

function PlatformPage() {
 const path=usePathname();const router=useRouter();const route=matchRoute(path);const parts=path.split('/').filter(Boolean);const reload=()=>setRevision(n=>n+1);
 // 1) 先确认身份：未认证前往统一登录页；me 变化广播给 Shell，让导航同源同步。
 const [me,setMe]=useState<Me|null>(null);const [meError,setMeError]=useState('');const [revision,setRevision]=useState(0);
 useEffect(()=>{let active=true;setMe(null);setMeError('');api<Me>('/me').then(m=>{if(!active)return;setMe(m);broadcastPortal(m);}).catch(e=>{if(!active)return;setMeError(e.message);broadcastPortal(null);});return()=>{active=false;};},[revision]);
 useEffect(()=>{if(meError.startsWith('401|'))window.location.replace(`/management/login?next=${encodeURIComponent(window.location.pathname+window.location.search)}`);},[meError]);
 // 2) 身份与路由检查未通过时不发数据请求、不渲染内容；跳转目标在 effect 里统一执行。
 const home='/management/courses';
 let redirectTo:string|null=null;
 if(me){
  const portal=routePortal(route);
  if(portal&&portal!==me.portal)redirectTo=home;
  else if(route.name==='redirect')redirectTo=route.to;
  else if(route.name==='home'||(route.name==='status'&&canManageLibrary(me)))redirectTo=home;
  else if(route.name==='studio')redirectTo=`/library?view=mine&oid=${route.oid}`;
 }
 useEffect(()=>{if(redirectTo){if(redirectTo.startsWith('/management/'))window.location.replace(redirectTo);else router.replace(redirectTo);}},[redirectTo]);
 // 3) 端内数据：仅在身份通过且无跳转目标后请求。
 let endpoint='';
 if(route.name==='batch')endpoint=`/batches/${route.bid}`;
 if(route.name==='workspace')endpoint=`/batches/${route.bid}/problems/${route.pid}`;
 if(route.name==='studio')endpoint=`/offerings/${route.oid}/drafts`;
 if(route.name==='draft')endpoint=`/drafts/${route.did}`;
 if(route.name==='insights')endpoint=`/offerings/${route.oid}/insights`;
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
 if(meError.startsWith('401|'))return <p role="status" className="py-20 text-center text-fg-muted">正在前往登录页面…</p>;
 if(meError)return <div className="space-y-4"><Empty title={meError.split('|').pop()||'身份确认失败'} hint="请重新登录后再试。"/><Button onClick={reload}>重新加载</Button></div>;
 if(!me||redirectTo)return <p role="status" className="py-20 text-center text-fg-muted">{!me?'正在确认登录身份…':'正在跳转…'}</p>;
 if(route.name==='not-found')return <div className="space-y-4"><Empty title="页面未找到" hint={`路径 /${parts.join('/')} 不属于课程工作台的任何功能，请检查链接是否正确。`}/><a className={action} href={home}>返回课程</a></div>;
  if(route.name==='status')return <StatusStreamView portal={me.portal} user={me.user}/>;
  if(route.name==='problem')return <PublicProblemWorkspace pid={route.pid} user={me.user}/>;
 if(route.name==='library')return <LibraryHub identity={me}/>;
 if(error)return <div className="space-y-4"><Empty title={error.split('|').pop()||'加载失败'} hint="请检查当前登录身份与课程权限。"/><Button onClick={reload}>重新加载</Button><a className="ml-3 text-brand" href={home}>返回课程</a></div>;
 if(!data)return <p role="status" className="py-20 text-center text-fg-muted">正在读取课程数据…</p>;
 if(route.name==='workspace')return <CourseContent offeringId={data.batch.offering_id}><Workspace key={path} user={me.user} data={data} bid={route.bid} pid={route.pid}/></CourseContent>;
 if(route.name==='batch')return <CourseContent offeringId={data.offering.offering_id}><Batch data={data} reload={reload} onWeightsSaved={problems=>setData({...data,problems})}/></CourseContent>;
 if(route.name==='draft')return <DraftEditor key={data.draft_id} data={data} reload={reload} archived={archived} ta={ta}/>;
 if(route.name==='insights')return <CourseContent offeringId={data.offering.offering_id}><Insights data={data}/></CourseContent>;
 return null;
}
