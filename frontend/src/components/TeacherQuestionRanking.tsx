"use client";
import {useEffect,useState} from 'react';
import {api,qs} from '@/lib/api';
import {Button,Card,CardTitle} from '@/components/ui';
import type {BatchDetail} from '@/api/generated/BatchDetail';

type Student={user_id:string;student_no:string;nick:string;rank:number|null;score:number|null;label:string;attempts:number;submission_id:number|null;time:number|null;memory:number|null};
type Ranking={page:number;page_size:number;total:number;students:Student[]};
const field='rounded-control border border-line bg-surface px-3 py-2 text-body text-fg';

export function TeacherQuestionRanking({data}:{data:BatchDetail}) {
 const [open,setOpen]=useState(false),[pid,setPid]=useState(data.problems[0]?.problem_id??0);
 const [search,setSearch]=useState(''),[filter,setFilter]=useState(''),[page,setPage]=useState(1),[size,setSize]=useState(20),[revision,setRevision]=useState(0);
 const [ranking,setRanking]=useState<Ranking|null>(null),[loading,setLoading]=useState(false),[error,setError]=useState('');
 const [codeStudent,setCodeStudent]=useState<Student|null>(null),[code,setCode]=useState<{code:string;language_name:string;result_label:string}|null>(null),[codeError,setCodeError]=useState('');
 const teacher=data.offering.role==='teacher';
 useEffect(()=>{if(!codeStudent)return;const close=(e:KeyboardEvent)=>{if(e.key==='Escape')setCodeStudent(null);};window.addEventListener('keydown',close);return()=>window.removeEventListener('keydown',close);},[codeStudent]);
 useEffect(()=>{const timer=setTimeout(()=>{setFilter(search.trim());setPage(1);},300);return()=>clearTimeout(timer);},[search]);
 useEffect(()=>{if(!teacher||!open||!pid)return;let active=true;setLoading(true);setError('');setRanking(null);
  api<Ranking>(`/batches/${data.batch.batch_id}/problems/${pid}/teacher-ranking${qs({page,page_size:size,search:filter})}`)
   .then(result=>{if(active){setRanking(result);if(result.page!==page)setPage(result.page);}}).catch(e=>{if(active)setError(String(e).split('|').pop()||'排名加载失败');}).finally(()=>{if(active)setLoading(false);});return()=>{active=false;};
 },[teacher,open,pid,page,size,filter,revision,data.batch.batch_id]);
 useEffect(()=>{setCode(null);setCodeError('');if(!codeStudent?.submission_id)return;let active=true;
  api<{code:string;language_name:string;result_label:string}>(`/submissions/${codeStudent.submission_id}/code`).then(value=>{if(active)setCode(value);}).catch(e=>{if(active)setCodeError(String(e).split('|').pop()||'代码加载失败');});return()=>{active=false;};
 },[codeStudent]);
 if(!teacher||!data.problems.length)return null;
 const pages=Math.max(1,Math.ceil((ranking?.total??0)/size));
 return <Card><CardTitle title="每题排行榜（教师）" meta="仅本班教师可见。按每题最好成绩排序：AC 100 分，其余已完成评测 0 分，同分并列；未提交或等待评测不排名。" action={<button type="button" className={field} aria-expanded={open} onClick={()=>setOpen(!open)}>{open?'收起排行榜':'查看每题排行榜'}</button>}/>
 {open&&<div className="space-y-4"><div className="flex flex-wrap items-center gap-3"><label>题目 <select aria-label="排行榜题目" className={field} value={pid} onChange={e=>{setPid(Number(e.target.value));setPage(1);}}>{data.problems.map(p=><option key={p.problem_id} value={p.problem_id}>{p.seq}. {p.title}</option>)}</select></label><input aria-label="搜索排行榜学生" className={field} value={search} maxLength={100} placeholder="搜索学号或姓名" onChange={e=>setSearch(e.target.value)}/><label>每页 <select aria-label="排行榜每页人数" className={field} value={size} onChange={e=>{setSize(Number(e.target.value));setPage(1);}}><option value={20}>20 人</option><option value={50}>50 人</option></select></label><Button onClick={()=>setRevision(revision+1)}>刷新成绩</Button></div>
 {loading?<p role="status">正在加载排行榜…</p>:error?<p role="alert" className="text-danger">{error}</p>:ranking&&<><p className="text-meta text-fg-muted">共 {ranking.total} 人 · 第 {ranking.page} / {pages} 页 · 搜索保留全班名次</p><div className="overflow-auto"><table className="w-full text-left zebra"><thead><tr><th>名次</th><th>学号</th><th>姓名</th><th>最好成绩</th><th>评测结果</th><th>提交次数</th><th>最佳提交代码</th></tr></thead><tbody>{ranking.students.map(s=><tr key={s.user_id}><td className="py-3">{s.rank??'—'}</td><td>{s.student_no}</td><td>{s.nick}</td><td>{s.score===null?'—':`${s.score} / 100`}</td><td>{s.label}</td><td>{s.attempts}</td><td>{s.submission_id?<Button onClick={()=>setCodeStudent(s)}>查看代码</Button>:'—'}</td></tr>)}</tbody></table>{!ranking.students.length&&<p className="py-4 text-fg-muted">没有匹配的学生。</p>}</div>{pages>1&&<div className="flex items-center gap-3"><Button disabled={page<=1} onClick={()=>setPage(page-1)}>上一页</Button><span>{page} / {pages}</span><Button disabled={page>=pages} onClick={()=>setPage(page+1)}>下一页</Button></div>}</>}
 </div>}
 {codeStudent&&<div className="fixed inset-0 z-50 flex items-center justify-center bg-fg/40 p-4" onClick={()=>setCodeStudent(null)}><section role="dialog" aria-modal="true" aria-label="最佳提交代码" className="max-h-[85vh] w-full max-w-4xl overflow-auto rounded-card border border-line bg-surface p-card" onClick={e=>e.stopPropagation()}><div className="mb-4 flex items-center justify-between gap-3"><h3>{codeStudent.nick} · #{codeStudent.submission_id}</h3><button type="button" className={field} autoFocus onClick={()=>setCodeStudent(null)}>关闭代码</button></div>{codeError?<p role="alert">{codeError}</p>:code?<><p>{code.result_label} · {code.language_name}</p><pre className="mt-4 overflow-auto whitespace-pre text-meta">{code.code}</pre></>:<p>正在加载代码…</p>}</section></div>}
 </Card>;
}
