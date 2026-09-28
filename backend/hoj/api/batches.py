from __future__ import annotations

import time

from fastapi import APIRouter, HTTPException, Request
import yaml

from hoj import hoa
from hoj.api.drafts import save_draft
from hoj.auth import principal
from hoj.hustoj.constants import LANGUAGES, LANG_NAMES, RESULTS
from hoj.infra.database import db, q
from hoj.infra.locks import MUTEX
from hoj.infra.security import read_trial_token, trial_token
from hoj.services.access import batch_access
from hoj.services.previous_ac import find_user_previous_ac

router = APIRouter()


@router.get('/api/batches/{bid}')
def batch(bid:int,request:Request):
    user=principal(request); b,off=batch_access(user,bid)
    if b.get('allowed_languages'):
        b['allowedLanguages'] = [x.strip() for x in b['allowed_languages'].split(',') if x.strip()]
    else:
        b['allowedLanguages'] = ['c', 'cpp', 'java', 'python']
    visibility="AND p.defunct='N'" if off['role']=='student' else ''
    ps=db.rows(f"SELECT bp.*,p.title,p.hint,p.defunct,p.source FROM cm_batch_problem bp JOIN jol.problem p USING(problem_id) WHERE bp.batch_id={bid} {visibility} ORDER BY bp.seq")
    for p in ps:
        progress=db.one(f"SELECT COUNT(*) attempts,COALESCE(MAX(s.result=4),0) passed FROM cm_submission cs JOIN jol.solution s ON s.solution_id=cs.submission_id WHERE cs.batch_id={bid} AND s.problem_id={int(p['problem_id'])} AND cs.user_id={q(user)}")
        p.update(progress)
        if off['role'] == 'student' and str(p.get('passed')) != '1':
            prev = find_user_previous_ac(user, p, b.get('allowedLanguages'))
            p['hasPreviousAc'] = bool(prev)
    return {'batch':b,'offering':off,'problems':ps}


@router.get('/api/batches/{bid}/problems/{pid}')
def problem(bid:int,pid:int,request:Request):
    user=principal(request)
    b,off=batch_access(user,bid)
    if b.get('allowed_languages'):
        b['allowedLanguages'] = [x.strip() for x in b['allowed_languages'].split(',') if x.strip()]
    else:
        b['allowedLanguages'] = ['c', 'cpp', 'java', 'python']
    visibility="AND p.defunct='N'" if off['role']=='student' else ''
    p=db.one(f"SELECT p.problem_id,p.title,p.description,p.input,p.output,p.sample_input,p.sample_output,p.hint,p.time_limit,p.memory_limit,p.source FROM jol.problem p JOIN cm_batch_problem bp USING(problem_id) WHERE bp.batch_id={bid} AND p.problem_id={pid} {visibility}")
    if not p: raise HTTPException(404,'题目不存在或未发布')
    prev_ac = find_user_previous_ac(user, p, b.get('allowedLanguages')) if off['role'] == 'student' else None
    return {'problem':p,'batch':b,'role':off['role'],'archived':off['status']=='archived','previousAc':prev_ac}


@router.post('/api/batches/{bid}/problems/{pid}/submissions')
def submit(bid:int,pid:int,data:dict,request:Request):
    user=principal(request); b,off=batch_access(user,bid,write=True)
    if off['role']!='student': raise HTTPException(403,'仅学生本人可以提交')
    if b['status']=='closed' or (b['due_at'] and b['due_at']<time.strftime('%Y-%m-%d %H:%M:%S') and b['allow_late']=='0'):
        raise HTTPException(409,'此题单已停止接收提交')
    problem(bid,pid,request)
    code=data.get('code'); lang_key=data.get('language'); lang=LANGUAGES.get(lang_key)
    if lang is None or not isinstance(code,str) or not code.strip() or len(code.encode())>65536: raise HTTPException(400,'请选择支持的语言并填写 64KB 以内的代码')
    allowed_langs_raw = b.get('allowed_languages')
    if allowed_langs_raw:
        allowed = [x.strip().lower() for x in allowed_langs_raw.split(',') if x.strip()]
        if allowed and lang_key not in allowed:
            allowed_names = [LANG_NAMES.get(LANGUAGES.get(x), x) for x in allowed]
            raise HTTPException(400, f'该作业限制仅允许使用以下语言提交：{", ".join(allowed_names)}')
    if lang==6: code='# coding=utf-8\n'+code
    bp=db.one(f'SELECT batch_problem_id FROM cm_batch_problem WHERE batch_id={bid} AND problem_id={pid}')
    # Same connection; source and teaching index must exist before result=0.
    sql=f"""INSERT INTO jol.solution(problem_id,user_id,language,in_date,result,code_length,ip) VALUES({pid},{q(user)},{lang},NOW(),14,{len(code.encode())},'127.0.0.1');
SET @sid=LAST_INSERT_ID();
INSERT INTO cm_submission(submission_id,offering_id,batch_id,batch_problem_id,user_id,language,submit_state,created_at) VALUES(@sid,{int(off['offering_id'])},{bid},{int(bp['batch_problem_id'])},{q(user)},{lang},'placeholder',NOW());
INSERT INTO jol.source_code(solution_id,source) VALUES(@sid,{q(code)});
INSERT INTO jol.source_code_user(solution_id,source) VALUES(@sid,{q(code)});
UPDATE jol.solution SET result=0 WHERE solution_id=@sid AND result=14;
UPDATE cm_submission SET submit_state='promoted',promoted_at=NOW() WHERE submission_id=@sid;
SELECT @sid;"""
    with MUTEX: sid=int(db.write(sql).splitlines()[-1])
    return {'submissionId':sid}


@router.post('/api/batches/{bid}/problems/{pid}/trials')
def run_trial(bid:int,pid:int,data:dict,request:Request):
    user=principal(request); b,off=batch_access(user,bid,write=True)
    if off['role']!='student': raise HTTPException(403,'仅学生本人可以自测')
    if b['status']=='closed' or (b['due_at'] and b['due_at']<time.strftime('%Y-%m-%d %H:%M:%S') and b['allow_late']=='0'):
        raise HTTPException(409,'此题单已停止接收运行与提交')
    problem(bid,pid,request)
    code, language, stdin = data.get('code'), data.get('language'), data.get('input','')
    if not isinstance(language,str) or language not in LANGUAGES or not isinstance(code,str) or not code.strip():
        raise HTTPException(400,'请选择支持的语言并填写代码')
    allowed_langs_raw = b.get('allowed_languages')
    if allowed_langs_raw:
        allowed = [x.strip().lower() for x in allowed_langs_raw.split(',') if x.strip()]
        if allowed and language not in allowed:
            allowed_names = [LANG_NAMES.get(LANGUAGES.get(x), x) for x in allowed]
            raise HTTPException(400, f'该作业限制仅允许使用以下语言自测：{", ".join(allowed_names)}')
    if not isinstance(stdin,str): raise HTTPException(400,'自测输入必须是文本')
    try:
        if len(code.encode('utf-8'))>65536 or len(stdin.encode('utf-8'))>16384 or '\0' in stdin:
            raise ValueError()
    except (ValueError, UnicodeError):
        raise HTTPException(400,'代码须为64KB以内的UTF-8文本，输入须为16KB以内且不含空字符的UTF-8文本')
    lang=LANGUAGES[language]
    if lang==6: code='# coding=utf-8\n'+code
    if len(code.encode('utf-8'))>65535:
        raise HTTPException(400,'代码连同运行所需编码头须小于64KB')
    # HUSTOJ reserves problem_id=0 for sandboxed custom-input runs. Never index
    # these in cm_submission: they must not affect assignment/class statistics.
    sql=f"""INSERT INTO jol.solution(problem_id,user_id,language,in_date,result,code_length,ip)
VALUES(0,{q(user)},{lang},NOW(),14,{len(code.encode())},'127.0.0.1');
SET @sid=LAST_INSERT_ID();
INSERT INTO jol.source_code(solution_id,source) VALUES(@sid,{q(code)});
INSERT INTO jol.source_code_user(solution_id,source) VALUES(@sid,{q(code)});
INSERT INTO jol.custominput(solution_id,input_text) VALUES(@sid,{q(stdin)});
UPDATE jol.solution SET result=0 WHERE solution_id=@sid AND problem_id=0 AND result=14;
SELECT @sid;"""
    with MUTEX:
        pending=db.one(f"""SELECT solution_id FROM jol.solution WHERE user_id={q(user)} AND problem_id=0
            AND in_date>DATE_SUB(NOW(),INTERVAL 10 MINUTE)
            AND (result IN (0,1,2,3,14) OR in_date>DATE_SUB(NOW(),INTERVAL 3 SECOND)) LIMIT 1""")
        if pending: raise HTTPException(429,'自测正在处理或操作过快，请稍后再试',headers={'Retry-After':'3'})
        # The existing authoring connection can insert custominput; no new grant
        # or table is needed. Code is executed only by HUSTOJ, never this process.
        sid=int(db.write(sql,ops=True).splitlines()[-1])
    return {'runId':trial_token(sid,bid,pid,user)}


@router.get('/api/trials/{run_id}')
def trial_result(run_id:str,request:Request):
    user=principal(request); token=read_trial_token(run_id,user)
    b,off=batch_access(user,token['bid'])
    if off['role']!='student': raise HTTPException(404,'自测记录不存在')
    problem(token['bid'],token['pid'],request)
    sid=token['sid']
    row=db.one(f"SELECT solution_id,user_id,problem_id,result,time,memory FROM jol.solution WHERE solution_id={sid} AND user_id={q(user)} AND problem_id=0")
    if not row or row['user_id']!=user or int(row['problem_id'])!=0:
        raise HTTPException(404,'自测记录不存在')
    code=int(row['result']); running=code in (0,1,2,3,14)
    output=compile_error=''; truncated=False
    if not running:
        table='compileinfo' if code==11 else 'runtimeinfo'
        info=db.one(f'SELECT error FROM jol.{table} WHERE solution_id={sid}') or {}
        text=info.get('error') or ''
        raw=text.encode('utf-8'); truncated=len(raw)>16384
        text=raw[:16384].decode('utf-8','ignore')
        if code==11: compile_error=text
        else: output=text
    # Native result=13 combines stdout/runtime diagnostics. It is not AC and
    # does not imply matching sample output or passing hidden test cases.
    label=RESULTS.get(code,'自测结束') if code not in (4,13) else '自测结束'
    return {'state':'running' if running else 'finished','result':code,'label':label,
            'time':int(row.get('time') or 0),'memory':int(row.get('memory') or 0),
            'output':output,'compileError':compile_error,'truncated':truncated}


@router.patch('/api/batches/{bid}')
def batch_settings(bid:int,data:dict,request:Request):
    batch_access(principal(request),bid,True,write=True)
    updates = []
    if 'aiEnabled' in data:
        if not isinstance(data['aiEnabled'],bool): raise HTTPException(422,'需要 aiEnabled 布尔值')
        updates.append(f"ai_enabled={int(data['aiEnabled'])}")
    if 'allowedLanguages' in data:
        langs = data['allowedLanguages']
        if langs is None or langs == '':
            updates.append("allowed_languages=NULL")
        elif isinstance(langs, list):
            valid = [l for l in langs if l in LANGUAGES]
            updates.append(f"allowed_languages={q(','.join(valid)) if valid else 'NULL'}")
        elif isinstance(langs, str):
            valid = [l.strip() for l in langs.split(',') if l.strip() in LANGUAGES]
            updates.append(f"allowed_languages={q(','.join(valid)) if valid else 'NULL'}")
    if updates:
        db.write(f"UPDATE cm_batch SET {', '.join(updates)},updated_at=NOW() WHERE batch_id={bid}")
    return {'ok':True}


@router.post('/api/batches/{bid}/copy')
def copy_batch(bid:int,request:Request):
    b,off=batch_access(principal(request),bid,True,write=True)
    ps=db.rows(f'SELECT p.* FROM jol.problem p JOIN cm_batch_problem bp USING(problem_id) WHERE bp.batch_id={bid} ORDER BY bp.seq')
    doc={'title':b['title']+'（副本）','read_only':int(b['read_only'] or 0)==1,'source_ref':b['source_ref'] or None,
         'problems':[{'slug':f'problem-{p["problem_id"]}','title':p['title'],'statement':p['description'] or '', 'samples':[{'input':p['sample_input'] or '', 'output':p['sample_output'] or ''}],'tests':[]} for p in ps]}
    return save_draft(int(off['offering_id']),{'document':doc},request)


@router.post('/api/batches/{bid}/export')
def export(bid:int,data:dict,request:Request):
    b,off=batch_access(principal(request),bid,True)     # 只读下载：历史教学班也允许查看与导出
    # 题单自身的只读来源优先于调用者参数：漏传标记或显式传 false 都不放行。
    if int(b['read_only'] or 0)==1 or data.get('read_only') is True or data.get('readOnly') is True:
        raise HTTPException(409,'该题单来源为只读，不允许公开导出')
    if b['status']!='published': raise HTTPException(409,'只能导出已发布题单')
    selected=data.get('selected',[])
    if not isinstance(selected,list) or not selected or any(type(i)!=int for i in selected): raise HTTPException(422,'请逐题选择公开导出的题目')
    ps=db.rows(f'SELECT p.problem_id,p.title,p.description,p.sample_input,p.sample_output FROM jol.problem p JOIN cm_batch_problem bp USING(problem_id) WHERE bp.batch_id={bid} ORDER BY bp.seq')
    if any(i not in {int(p['problem_id']) for p in ps} for i in selected): raise HTTPException(422,'选择的题目不属于此题单')
    c=db.one(f'SELECT code FROM cm_course WHERE course_id={int(off["course_id"])}')
    doc={'course':c['code'],'batch':f'batch-{bid}','seq':int(b['seq']),'title':b['title'],'status':'published','problems':[{'slug':f'problem-{p["problem_id"]}','title':p['title'],'statement':p['description'],'samples':[{'input':p['sample_input'] or '', 'output':p['sample_output'] or ''}]} for p in ps if int(p['problem_id']) in selected]}
    try: clean=hoa.build_export_document(hoa.ExportRequest(doc,[p['slug'] for p in doc['problems']]))
    except ValueError as e: raise HTTPException(422,str(e))
    return {'filename':f'{c["code"]}-batch-{bid}.yml','content':yaml.safe_dump(clean,allow_unicode=True,sort_keys=False),'publishedToHoa':False}
