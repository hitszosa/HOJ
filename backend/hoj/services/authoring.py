from __future__ import annotations

from fastapi import HTTPException

from hoj.hustoj.testdata import write_test_files
from hoj.infra.database import db, q


def ensure_authoring_batch(oid,title,ident,read_only,source_ref,legacy_bid=None):
    """按 authoring_key 原子地创建或找回批次；序号冲突时重试，绝不复用他人批次。

    authoring_key 落库且唯一，因此“建批次后回填前崩溃”不会产生重复批次：
    重试走同一条查询/插入路径，拿回同一个 batch_id。
    升级前遗留的“draft.batch_id 有值但 authoring_key 为 NULL”的中断草稿会认领原批次，
    不会新建第二个批次。
    """
    existing=db.one(f'SELECT batch_id FROM cm_batch WHERE authoring_key={q(ident)}')
    if existing:
        bid=int(existing['batch_id'])
        db.write(f"UPDATE cm_batch SET title={q(title)},read_only=GREATEST(read_only,{int(read_only)}),source_ref=COALESCE({q(source_ref)},source_ref),updated_at=NOW() WHERE batch_id={bid}")
        return bid
    if legacy_bid:
        db.write(f"UPDATE cm_batch SET authoring_key={q(ident)},title={q(title)},read_only=GREATEST(read_only,{int(read_only)}),source_ref=COALESCE({q(source_ref)},source_ref),updated_at=NOW() WHERE batch_id={int(legacy_bid)} AND offering_id={int(oid)} AND authoring_key IS NULL")
        adopted=db.one(f'SELECT batch_id FROM cm_batch WHERE authoring_key={q(ident)}')
        if adopted: return int(adopted['batch_id'])
    for _ in range(3):
        row=db.one(f'SELECT COALESCE(MAX(seq),0)+1 n FROM cm_batch WHERE offering_id={int(oid)}')
        seq=int(row['n'])
        db.write(f"INSERT INTO cm_batch(offering_id,seq,title,status,read_only,source_ref,authoring_key,created_at,updated_at) VALUES({int(oid)},{seq},{q(title)},'draft',{int(read_only)},{q(source_ref)},{q(ident)},NOW(),NOW()) ON DUPLICATE KEY UPDATE batch_id=LAST_INSERT_ID(batch_id)")
        found=db.one(f'SELECT batch_id FROM cm_batch WHERE authoring_key={q(ident)}')
        if found: return int(found['batch_id'])
        # 命中 uk_batch_seq（别人先占了同一个 seq）时本行未插入，换下一个序号重试。
    raise HTTPException(409,'批次序号冲突，请稍后重试发布')


def sync_authoring_problem(ident,p):
    """题面/样例/hint 每次都按草稿重写；重试与首次发布走同一条幂等路径。"""
    source=f'codemind:authoring/{ident}/{p["slug"]}'
    knowledge=q('、'.join(p.get('knowledge',[])))
    exists=db.one(f'SELECT problem_id FROM jol.problem WHERE source={q(source)}')
    if exists:
        pid=int(exists['problem_id'])
        db.write(f"UPDATE jol.problem SET title={q(p['title'])},description={q(p['statement'])},sample_input={q(p['samples'][0]['input'])},sample_output={q(p['samples'][0]['output'])},hint={knowledge} WHERE problem_id={pid}",ops=True)
    else:
        pid=int(db.write(f"INSERT INTO jol.problem(title,description,input,output,sample_input,sample_output,hint,source,in_date,defunct,time_limit,memory_limit) VALUES({q(p['title'])},{q(p['statement'])},'','',{q(p['samples'][0]['input'])},{q(p['samples'][0]['output'])},{knowledge},{q(source)},NOW(),'Y',1,128); SELECT LAST_INSERT_ID();",ops=True).splitlines()[-1])
    write_test_files(pid,p['tests'])
    return pid
