'use strict';
const fs=require('fs'),http=require('http'),{performance,monitorEventLoopDelay}=require('perf_hooks');
const dir='/work',origin='http://10.249.12.21:3100';
const agent=new http.Agent({keepAlive:true,maxSockets:5000,maxFreeSockets:3000});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function save(name,obj){fs.writeFileSync(dir+'/'+name+'.json',JSON.stringify(obj,null,2),{mode:0o600});}
function client(){return {cookies:{}};}
function req(c,path,method='GET',body){return new Promise(resolve=>{
 const begin=performance.now(),payload=body===undefined?null:Buffer.from(JSON.stringify(body));
 const headers={Host:'10.249.12.21:3100',Origin:origin,'Content-Type':'application/json'};
 if(payload)headers['Content-Length']=payload.length;
 if(c){headers.Cookie=Object.entries(c.cookies).map(([k,v])=>k+'='+v).join('; ');if(c.cookies.csrftoken)headers['X-CSRFTOKEN']=decodeURIComponent(c.cookies.csrftoken);}
 let done=false;const finish=x=>{if(!done){done=true;resolve({...x,ms:performance.now()-begin});}};
 const q=http.request({host:'127.0.0.1',port:3100,path,method,headers,agent},r=>{
  if(c)for(const v of r.headers['set-cookie']||[]){const s=v.split(';')[0],i=s.indexOf('=');c.cookies[s.slice(0,i)]=s.slice(i+1);}
  const chunks=[];r.on('data',x=>chunks.push(x));r.on('end',()=>{const raw=Buffer.concat(chunks);let data;try{data=JSON.parse(raw);}catch{}finish({status:r.statusCode,data,bytes:raw.length});});r.on('error',e=>finish({status:0,error:e.code||e.message}));
 });q.setTimeout(20000,()=>q.destroy(new Error('timeout')));q.on('error',e=>finish({status:0,error:e.code||e.message}));if(payload)q.write(payload);q.end();
});}
async function ok(c,p,m,b){const r=await req(c,p,m,b);if(r.status<200||r.status>=300)throw new Error(p+' '+r.status+' '+JSON.stringify(r.data||r.error));return r.data;}
const pct=(xs,p)=>xs.length?xs.slice().sort((a,b)=>a-b)[Math.min(xs.length-1,Math.ceil(xs.length*p)-1)]:0;
async function pool(n,items,fn){let ix=0;return Promise.all(Array.from({length:Math.min(n,items.length)},async()=>{while(ix<items.length){const i=ix++;await fn(items[i],i);}}));}
let fixture=fs.existsSync(dir+'/fixture.json')?JSON.parse(fs.readFileSync(dir+'/fixture.json')):null;
async function setup(){
 const account=JSON.parse(fs.readFileSync('/opt/hoj/admin-account.json'));const admin=client();await ok(admin,'/api/account/login','POST',account);const profile=await ok(admin,'/management-api/auth/current_user');
 if(!fixture){fixture={prefix:'load_'+Date.now().toString(36),users:[],submissions:[]};save('fixture',fixture);}
 for(let start=fixture.users.length;start<1000;start+=50){const users=Array.from({length:50},(_,i)=>({username:fixture.prefix+'_'+String(start+i).padStart(4,'0'),real_name:'压测学生'+(start+i),role:0,password_expired:false}));const result=await ok(admin,'/management-api/users/batch_create','POST',users);fixture.users.push(...result.map(u=>({id:u.id,username:u.username})));save('fixture',fixture);if(fixture.users.length%200===0)console.log(JSON.stringify({setup_students:fixture.users.length}));}
 if(!fixture.course_id){const course=await ok(admin,'/management-api/courses','POST',{title:'临时压力测试班 '+fixture.prefix,year:2026,term:2,teacher_ids:[profile.id],student_ids:fixture.users.map(u=>u.id),assistant_ids:[]});fixture.course_id=course.id;save('fixture',fixture);}
 const link=(await ok(admin,'/management-api/hoj/links')).find(x=>x.course_id===fixture.course_id);fixture.offering_id=link.offering_id;save('fixture',fixture);
 if(!fixture.batch_id){const doc={title:'压力测试 C++ 两数之和',problems:[{slug:'sum',title:'压测两数之和',score:100,statement:'输入两个整数，输出其和。',samples:[{input:'1 2\n',output:'3\n'}],tests:Array.from({length:10},(_,i)=>({input:`${i} ${i+1}\n`,output:`${2*i+1}\n`})),knowledge:['算术']}]};const draft=(await ok(admin,`/api/offerings/${fixture.offering_id}/drafts`,'POST',{document:doc})).data;fixture.draft_id=draft.id||draft.draft_id;save('fixture',fixture);const published=(await ok(admin,'/api/drafts/'+fixture.draft_id+'/publish','POST',{reviewed:true,ai_enabled:false,allowed_languages:['cpp']})).data;fixture.batch_id=published.batch_id;fixture.problem_id=(await ok(admin,'/api/batches/'+fixture.batch_id)).data.problems[0].problem_id;save('fixture',fixture);}
 const clients=fixture.users.map(()=>client());const times=[],errors=[];await pool(40,fixture.users,async(u,i)=>{let r=await req(clients[i],'/api/account/login','POST',{username:u.username,password:u.username});times.push(r.ms);if(r.status!==200)errors.push({i,status:r.status});else await ok(clients[i],'/management-api/auth/current_user');});
 if(errors.length)throw new Error('Session preparation failures: '+JSON.stringify(errors.slice(0,3)));
 save('sessions',{clients,admin});save('setup',{users:1000,login_p95_ms:pct(times,.95),fixture});console.log(JSON.stringify({setup_ready:true,users:1000,login_p95_ms:pct(times,.95)}));
}
async function stage(mode,n,seconds,think){
 const state=JSON.parse(fs.readFileSync(dir+'/sessions.json'));const clients=state.clients,admin=state.admin;
 const delay=monitorEventLoopDelay({resolution:20});delay.enable();const start=performance.now(),end=start+seconds*1000;const samples=[],counts={},byPath={},errors=[];let totalBytes=0;
 console.log(JSON.stringify({phase:mode,concurrency:n,duration_s:seconds,think_ms:think,begin:true}));
 await Promise.all(Array.from({length:n},async(_,i)=>{const c=clients[i%clients.length];let k=0;while(performance.now()<end){let path,who=c,method='GET',body;
  if(mode==='login'){path='/api/account/login';method='POST';const u=fixture.users[i%fixture.users.length];body={username:u.username,password:u.username};who=client();}
  else if(i%50===49 && k%5===4){path=`/api/offerings/${fixture.offering_id}/grades`;who=admin;}
  else path=[`/api/batches/${fixture.batch_id}/problems/${fixture.problem_id}`,`/api/batches/${fixture.batch_id}`,'/management-api/courses','/api/me','/api/courses'][k%5];
  const r=await req(who,path,method,body);samples.push(r.ms);counts[r.status]=(counts[r.status]||0)+1;totalBytes+=r.bytes||0;
  const bp=byPath[path]||(byPath[path]={n:0,errors:0,times:[]});bp.n++;bp.times.push(r.ms);if(r.status!==200){bp.errors++;if(errors.length<10)errors.push({path,status:r.status,message:r.error||r.data?.message});}k++;if(think)await sleep(think);
 }}));
 const duration=(performance.now()-start)/1000;delay.disable();const good=counts[200]||0;
 const result={mode,concurrency:n,requested_duration_s:seconds,actual_duration_s:duration,requests:samples.length,rps:samples.length/duration,successful_rps:good/duration,error_rate:(samples.length-good)/samples.length,statuses:counts,p50_ms:pct(samples,.5),p95_ms:pct(samples,.95),p99_ms:pct(samples,.99),max_ms:samples.reduce((m,x)=>Math.max(m,x),0),bytes:totalBytes,generator_event_loop_p99_ms:delay.percentile(99)/1e6,think_ms:think,endpoints:Object.fromEntries(Object.entries(byPath).map(([p,b])=>[p,{requests:b.n,errors:b.errors,p95_ms:pct(b.times,.95)}])),errors};
 const name=`${mode}-${n}-${seconds}`;save(name,result);console.log(JSON.stringify({...result,endpoints:undefined}));
 return result;
}
async function browse(){
 for(const n of [100,300,500,800,1000]){const r=await stage('online',n,35,1000);if(r.error_rate>.01||r.p95_ms>3000){console.log(JSON.stringify({stop:'interactive threshold exceeded',concurrency:n}));break;}await sleep(2000);}
 for(const n of [25,50,100,300,500,800,1000,1500,2000]){const r=await stage('saturation',n,20,0);if(r.error_rate>.02||r.p95_ms>8000){console.log(JSON.stringify({stop:'saturation threshold exceeded',concurrency:n}));break;}await sleep(2000);}
}
async function login(){for(const n of [25,50,100,300,500]){const r=await stage('login',n,20,250);if(r.error_rate>.01||r.p95_ms>5000)break;await sleep(2000);}}
async function burst(n,cpu=false){
 const state=JSON.parse(fs.readFileSync(dir+'/sessions.json')),clients=state.clients;
 const code='#include <iostream>\n#include <vector>\n#include <algorithm>\nint main(){long long a,b;std::cin>>a>>b;'+(cpu?'volatile unsigned x=1;for(unsigned i=0;i<10000000;i++){x=x*1664525u+1013904223u;}':'')+'std::cout<<a+b<<"\\n";}\n';
 console.log(JSON.stringify({phase:'judge-burst',students:n,cpu_loop:cpu,begin:true}));const start=performance.now(),latencies=[],ids=[],errors=[];
 await Promise.all(Array.from({length:n},async(_,i)=>{const r=await req(clients[i],`/api/batches/${fixture.batch_id}/problems/${fixture.problem_id}/submissions`,'POST',{language:'cpp',code});latencies.push(r.ms);if(r.status===200&&r.data?.data?.submission_id){ids.push({id:r.data.data.submission_id,student:i,accepted_ms:performance.now()-start});fixture.submissions.push(r.data.data.submission_id);}else errors.push({status:r.status,message:r.error||r.data?.message});}));save('fixture',fixture);
 const accepted_s=(performance.now()-start)/1000;let remaining=ids.slice(),done=[],maxPending=ids.length;
 while(remaining.length&&performance.now()-start<600000){await sleep(2000);const next=[];await pool(24,remaining,async(x)=>{const r=await req(clients[x.student],'/api/submissions/'+x.id);const d=r.data?.data;if(r.status===200&&d&&![0,1,2,3,14].includes(d.result))done.push({...x,result:d.result,completed_ms:performance.now()-start});else next.push(x);});remaining=next;save('judge-progress',{students:n,done:done.length,remaining:remaining.length,elapsed_s:(performance.now()-start)/1000});if(done.length%50<24)console.log(JSON.stringify({judge_students:n,done:done.length,pending:remaining.length,elapsed_s:(performance.now()-start)/1000}));}
 const r={mode:'judge-burst',students:n,cpu_loop:cpu,accepted:ids.length,errors:errors.length,error_samples:errors.slice(0,5),acceptance_seconds:accepted_s,acceptance_p95_ms:pct(latencies,.95),drained:remaining.length===0,total_seconds:(performance.now()-start)/1000,completed:done.length,remaining:remaining.length,results:done.reduce((a,x)=>(a[x.result]=(a[x.result]||0)+1,a),{}),completion_p50_s:pct(done.map(x=>x.completed_ms),.5)/1000,completion_p95_s:pct(done.map(x=>x.completed_ms),.95)/1000};r.judged_per_second=done.length/r.total_seconds;save(`${process.env.HOJ_LOAD_LABEL||'judge'}-${n}-${cpu?'cpu':'short'}`,r);console.log(JSON.stringify(r));if(!r.drained||r.errors>n*.02)throw new Error('Judge load threshold exceeded');
}
(async()=>{try{const action=process.argv[2];if(action==='setup')await setup();else if(action==='browse')await browse();else if(action==='login')await login();else if(action==='fixed'){for(const n of [500,800,1000,1500,2000]){const r=await stage('saturation-fixed',n,25,0);if(r.error_rate>.02||r.p95_ms>8000)break;await sleep(2000);}}else if(action==='stage')await stage(process.argv[3],+process.argv[4],+process.argv[5],+process.argv[6]||0);else if(action==='burst')await burst(+process.argv[3],process.argv[4]==='cpu');else if(action==='judge'){for(const n of [20,100,300,500])await burst(n,false);await burst(100,true);}else throw new Error('Unknown action');}catch(e){console.error(e.message);process.exitCode=1;}finally{agent.destroy();}})();
