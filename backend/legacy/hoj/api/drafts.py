from __future__ import annotations

import json
import re
import time
import uuid

from fastapi import APIRouter, HTTPException, Request
import httpx

from hoj.auth import principal
from hoj.hustoj.constants import LANGUAGES
from hoj.infra.database import db, q
from hoj.infra.locks import MUTEX
from hoj.services.access import offering_access
from hoj.services.ai import ai_config
from hoj.services.authoring import ensure_authoring_batch, sync_authoring_problem
from hoj.services.documents import parse_document, validate_document
from hoj.services.drafts import get_draft

router = APIRouter()


@router.get('/api/offerings/{oid}/drafts')
def drafts(oid:int,request:Request):
    offering_access(principal(request),oid,True)
    return db.rows(f'SELECT draft_id,title,status,origin,updated_at FROM cm_authoring_draft WHERE offering_id={oid} ORDER BY updated_at DESC')


@router.post('/api/offerings/{oid}/drafts')
def save_draft(oid:int,data:dict,request:Request):
    user=principal(request); offering_access(user,oid,True,write=True)
    doc=parse_document(data['content']) if 'content' in data else validate_document(data.get('document'))
    ident=uuid.uuid4().hex
    db.write(f"INSERT INTO cm_authoring_draft(draft_id,offering_id,owner_id,title,payload,status,origin,updated_at) VALUES({q(ident)},{oid},{q(user)},{q(doc['title'])},{q(json.dumps(doc,ensure_ascii=False))},'draft','teacher',NOW())")
    return {'id':ident,'document':doc,'status':'draft'}


@router.get('/api/drafts/{ident}')
def draft(ident:str,request:Request): return get_draft(ident,principal(request))


@router.put('/api/drafts/{ident}')
def update_draft(ident:str,data:dict,request:Request):
    row=get_draft(ident,principal(request),write=True)
    if row['status']!='draft': raise HTTPException(409,'已发布题单不可覆盖，请复制为新草稿')
    doc=validate_document(data.get('document'))
    previous=row['document'] if isinstance(row.get('document'),dict) else {}
    # 既有只读来源不可被更新洗掉；来源引用缺失时沿用原值。
    if previous.get('read_only') is True: doc['read_only']=True
    if not doc.get('source_ref') and previous.get('source_ref'): doc['source_ref']=previous['source_ref']
    db.write(f'UPDATE cm_authoring_draft SET title={q(doc["title"])},payload={q(json.dumps(doc,ensure_ascii=False))},updated_at=NOW() WHERE draft_id={q(ident)}')
    return {'ok':True}


@router.delete('/api/drafts/{ident}')
def delete_draft(ident: str, request: Request):
    user = principal(request)
    row = get_draft(ident, user, write=True)
    if row['status'] == 'published':
        raise HTTPException(409, '已发布的题单不可直接从题库删除，请在班级作业中管理')
    db.write(f"DELETE FROM cm_authoring_draft WHERE draft_id={q(ident)}")
    return {'ok': True}


@router.post('/api/offerings/{oid}/generate')
def generate(oid:int,data:dict,request:Request):
    offering_access(principal(request),oid,True,write=True)
    topic=str(data.get('topic','')).strip()[:500]
    if not topic: raise HTTPException(422,'请填写教学目标')
    endpoint, model, token = ai_config()
    if not endpoint or not model: raise HTTPException(503,'尚未连接 AI 出题服务；请使用自编题或导入题单')
    try:
        with httpx.Client(timeout=45, trust_env=False) as client:
            r=client.post(endpoint.rstrip('/')+'/chat/completions',headers={'Authorization':'Bearer '+(token or '')},json={'model':model,'messages':[{'role':'system','content':'你是编程课教师助手。只返回 JSON 题单，含 title, problems。每题含 slug,title,statement,samples:[{input,output}],tests:[{input,output}],knowledge:[字符串]。给出可验证的边界测试。产物必须由教师审核。不得声称已访问外部资料。'},{'role':'user','content':topic}]})
            r.raise_for_status(); text=r.json()['choices'][0]['message']['content']
        text=re.sub(r'^```(?:json)?\s*|\s*```$','',text.strip())

        doc=validate_document(json.loads(text))
    except (httpx.HTTPError,ValueError,KeyError,IndexError): raise HTTPException(502,'AI 服务没有返回有效题单，请重试或手动编写')
    saved=save_draft(oid,{'document':doc},request)
    db.write(f"UPDATE cm_authoring_draft SET origin='ai' WHERE draft_id={q(saved['id'])}")
    return saved


@router.post('/api/drafts/{ident}/publish')
def publish(ident:str,data:dict,request:Request):
    user=principal(request)
    with MUTEX:
        row=get_draft(ident,user,write=True)          # 历史只读在幂等分支之前就拦下
        if row['status']=='published' and row.get('batch_id'): return {'batchId':int(row['batch_id'])}
        doc=validate_document(row['document'])
        if data.get('reviewed') is not True: raise HTTPException(422,'发布前请确认已审核题面、样例与隐藏测试')
        for p in doc['problems']:
            if not p.get('tests'): raise HTTPException(422,'每题必须有隐藏测试；仅样例不能发布')
            sample_pairs={(s['input'],s['output']) for s in p['samples']}
            if all((t['input'],t['output']) in sample_pairs for t in p['tests']): raise HTTPException(422,'隐藏测试必须覆盖样例之外的输入')
        oid=int(row['offering_id'])
        due=data.get('dueAt') or None
        if due:
            try: time.strptime(due.replace('T',' '),'%Y-%m-%d %H:%M')
            except ValueError: raise HTTPException(422,'截止时间格式无效')
            due=due.replace('T',' ')
        # read_only 只增不减：草稿或批次已有 true 时发布不得洗成 false。
        read_only=1 if doc.get('read_only') is True else 0
        source_ref=doc.get('source_ref') or None
        # 1) 批次先以 draft 状态就位（authoring_key 唯一键幂等），此时对学生仍不可见。
        bid=ensure_authoring_batch(oid,doc['title'],ident,read_only,source_ref,row.get('batch_id'))
        pids=[sync_authoring_problem(ident,p) for p in doc['problems']]
        # 2) HUSTOJ 侧（MyISAM，无事务）先统一放开题目可见；失败时批次仍是 draft，学生看不到。
        ids=','.join(str(int(x)) for x in pids)
        db.write(f"UPDATE jol.problem SET defunct='Y' WHERE source LIKE {q(f'codemind:authoring/{ident}/%')} AND problem_id NOT IN ({ids})",ops=True)
        db.write(f"UPDATE jol.problem SET defunct='N' WHERE problem_id IN ({ids})",ops=True)
        # 3) 关联关系整体重建，并与批次/草稿状态放在同一个教学域事务里：
        #    cm_batch_problem 上 (batch_id,seq) 与 (batch_id,problem_id) 都是唯一键，
        #    增量 upsert 在“换题但 seq 不变”时会命中旧行、写不进新题，必须先清空再整批写入。
        pairs=','.join(f"({int(bid)},{int(pid)},{seq},100,NOW(),NOW())" for seq,pid in enumerate(pids,1))
        raw_allowed = data.get('allowedLanguages') or doc.get('allowed_languages')
        allowed_langs_str = None
        if raw_allowed:
            if isinstance(raw_allowed, str):
                langs = [x.strip().lower() for x in raw_allowed.split(',') if x.strip()]
            elif isinstance(raw_allowed, list):
                langs = [str(x).strip().lower() for x in raw_allowed if str(x).strip()]
            else:
                langs = []
            valid = [l for l in langs if l in LANGUAGES]
            if valid:
                allowed_langs_str = ','.join(valid)

        db.write("BEGIN;"
                 f" DELETE FROM cm_batch_problem WHERE batch_id={int(bid)};"
                 f" INSERT INTO cm_batch_problem(batch_id,problem_id,seq,score,created_at,updated_at) VALUES {pairs};"
                 f" UPDATE cm_authoring_draft SET batch_id={int(bid)} WHERE draft_id={q(ident)};"
                 f" UPDATE cm_batch SET status='published',due_at={q(due)},ai_enabled={1 if data.get('aiEnabled',True) else 0},allowed_languages={q(allowed_langs_str)},read_only=GREATEST(read_only,{read_only}),source_ref=COALESCE({q(source_ref)},source_ref),updated_at=NOW() WHERE batch_id={int(bid)};"
                 f" UPDATE cm_authoring_draft SET status='published',updated_at=NOW() WHERE draft_id={q(ident)};"
                 " COMMIT;")
        return {'batchId':bid}
