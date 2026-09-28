from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request

from hoj.api.batches import problem
from hoj.auth import principal
from hoj.hustoj.constants import LANG_NAMES, RESULTS
from hoj.infra.database import db, q
from hoj.services.access import batch_access, offering_access
from hoj.services.ai import RULES_FALLBACK, RULES_HINTS, ai_config, analysis_hint, error_text

router = APIRouter()


@router.get('/api/submissions/{sid}')
def result(sid:int,request:Request):
    user=principal(request)
    row=db.one(f'SELECT cs.*,s.result,s.time,s.memory,s.problem_id FROM cm_submission cs JOIN jol.solution s ON s.solution_id=cs.submission_id WHERE cs.submission_id={sid}')
    if row:
        off=offering_access(user,row['offering_id'])
        if off['role']=='student' and row['user_id']!=user: raise HTTPException(404,'提交不存在')
    else:
        s = db.one(f'SELECT * FROM jol.solution WHERE solution_id={int(sid)}')
        if not s: raise HTTPException(404,'提交不存在')
        if user != 'admin' and s['user_id'] != user: raise HTTPException(404, '提交不存在')
        row = dict(s)
        row['offering_id'] = None
        row['batch_id'] = None
    row['label']=RESULTS.get(int(row['result']),'其他结果')
    row['error']=db.one(f'SELECT error FROM jol.compileinfo WHERE solution_id={sid}') or db.one(f'SELECT error FROM jol.runtimeinfo WHERE solution_id={sid}')
    return row


@router.get('/api/submissions/{sid}/analysis')
def analysis(sid:int,request:Request,level:int=1):
    r=result(sid,request); b,_=batch_access(principal(request),r['batch_id'])
    if b['ai_enabled']!='1': raise HTTPException(403,'本批次已关闭 AI 辅助')
    if level not in (1,2,3): raise HTTPException(400,'提示级别为 1–3')
    rc=int(r['result'])
    # F1 永远是服务端判题事实原文，模型只能补充 A1，不能覆盖任何事实字段。
    fact={'id':'F1','kind':'F','text':f"提交 #{sid}：{r['label']}，用时 {r['time']} ms，内存 {r['memory']} KB",'url':f'/api/submissions/{sid}'}
    hint, reason = None, None
    if rc != 4:
        endpoint, model, _ = ai_config()
        if not endpoint or not model:
            reason = 'not_configured'
        else:
            public = problem(r['batch_id'], r['problem_id'], request)['problem']
            code = (db.one(f'SELECT source FROM jol.source_code_user WHERE solution_id={sid}')
                    or db.one(f'SELECT source FROM jol.source_code WHERE solution_id={sid}') or {}).get('source')
            # 只取编译信息（编译器诊断，来源是学生自己的代码）；运行错误可能回显隐藏输入/输出，绝不外发。
            judge = dict(r, compileError=error_text(db.one(f'SELECT error FROM jol.compileinfo WHERE solution_id={sid}')))
            hint, reason = analysis_hint(public, code, judge, level)
    else:
        reason = 'already_passed'
    if hint:
        mode, label = 'model', '模型学习建议（已调用配置的 AI 服务）'
    else:
        mode = 'rules'
        label = {'not_configured':'规则学习建议（未配置 AI 服务，未调用模型）',
                 'model_unavailable':'规则学习建议（AI 服务暂不可用，已降级）',
                 'invalid_response':'规则学习建议（AI 返回不可用，已降级）',
                 'already_passed':'规则学习建议（本次已通过，未调用模型）'}.get(reason,'规则学习建议（未调用模型）')
        hints = ['本次提交已通过，可回顾解题过程。'] * 3 if rc == 4 else RULES_HINTS.get(rc, RULES_FALLBACK)
        hint = hints[level-1]
    out = {'mode':mode,'label':label,'level':level,
           'evidence':[fact,{'id':'A1','kind':'A','text':hint,'basis':['F1']}]}
    if mode == 'rules':
        out['reason'] = reason
        out['degraded'] = reason in ('model_unavailable', 'invalid_response')
    return out


# ---------------------------------------------------------------- 原生 HUSTOJ 核心功能迁移接口
@router.get('/api/status')
def get_status_stream(request: Request, page: int = 1, pageSize: int = 20,
                      problemId: int = None, userId: str = None,
                      language: int = None, result: int = None,
                      offeringId: int = None, onlyMine: bool = False):
    user = principal(request)
    limit = max(1, min(pageSize, 100))
    offset = (max(1, page) - 1) * limit

    where = ["s.problem_id > 0"]
    if onlyMine:
        where.append(f"s.user_id = {q(user)}")
    elif userId and userId.strip():
        uid = userId.strip()
        where.append(f"(s.user_id LIKE {q(f'%{uid}%')} OR u.nick LIKE {q(f'%{uid}%')})")

    if problemId is not None and problemId > 0:
        where.append(f"s.problem_id = {int(problemId)}")

    if language is not None:
        where.append(f"s.language = {int(language)}")

    if result is not None:
        where.append(f"s.result = {int(result)}")

    if offeringId is not None and offeringId > 0:
        offering_access(user, int(offeringId))
        where.append(f"cs.offering_id = {int(offeringId)}")

    where_clause = " AND ".join(where)

    sql = f"""
        SELECT s.solution_id, s.problem_id, s.user_id, COALESCE(u.nick, s.nick, s.user_id) as nick,
               s.result, s.time, s.memory, s.language, s.code_length, s.in_date,
               p.title as problem_title,
               cs.offering_id, cs.batch_id,
               o.title as offering_title
        FROM jol.solution s
        LEFT JOIN jol.problem p ON p.problem_id = s.problem_id
        LEFT JOIN jol.users u ON u.user_id = s.user_id
        LEFT JOIN cm_submission cs ON cs.submission_id = s.solution_id
        LEFT JOIN cm_offering o ON o.offering_id = cs.offering_id
        WHERE {where_clause}
        ORDER BY s.solution_id DESC
        LIMIT {limit} OFFSET {offset}
    """

    count_sql = f"""
        SELECT COUNT(*) as n
        FROM jol.solution s
        LEFT JOIN jol.users u ON u.user_id = s.user_id
        LEFT JOIN cm_submission cs ON cs.submission_id = s.solution_id
        WHERE {where_clause}
    """

    rows = db.rows(sql)
    total_row = db.one(count_sql)
    total = int(total_row['n']) if total_row else 0

    for r in rows:
        r['solutionId'] = int(r['solution_id'])
        r['problemId'] = int(r['problem_id'])
        r['userId'] = r['user_id']
        r['problemTitle'] = r.get('problem_title') or f"题目 #{r['problemId']}"
        r['offeringTitle'] = r.get('offering_title') or ''
        r['time'] = int(r.get('time') or 0)
        r['memory'] = int(r.get('memory') or 0)
        res_val = int(r['result'])
        r['result'] = res_val
        r['resultLabel'] = RESULTS.get(res_val, '其他结果')
        lang_val = int(r.get('language') or 0)
        r['language'] = lang_val
        r['languageName'] = LANG_NAMES.get(lang_val, '其他')
        r['inDate'] = str(r.get('in_date') or '')
        r['codeLength'] = int(r.get('code_length') or 0)
        r['canViewCode'] = bool(user == 'admin' or r['user_id'] == user)

    return {
        'items': rows,
        'total': total,
        'page': page,
        'pageSize': limit
    }


@router.get('/api/submissions/{sid}/code')
def get_submission_code(sid: int, request: Request):
    user = principal(request)
    s = db.one(f"SELECT s.*, p.title as problem_title FROM jol.solution s LEFT JOIN jol.problem p ON p.problem_id=s.problem_id WHERE s.solution_id={int(sid)}")
    if not s:
        raise HTTPException(404, '提交记录不存在')
    cs = db.one(f"SELECT * FROM cm_submission WHERE submission_id={int(sid)}")

    is_owner = (s['user_id'] == user)
    is_admin = (user == 'admin')
    is_offering_teacher = False
    if cs and cs.get('offering_id'):
        try:
            offering_access(user, int(cs['offering_id']), teacher=True)
            is_offering_teacher = True
        except HTTPException:
            is_offering_teacher = False

    is_my_student = False
    if not (is_owner or is_admin or is_offering_teacher):
        enroll = db.one(f"""SELECT 1 FROM cm_enrollment e 
            JOIN cm_offering o ON o.offering_id=e.offering_id 
            WHERE e.user_id={q(s['user_id'])} AND o.teacher_id={q(user)} LIMIT 1""")
        is_my_student = bool(enroll)

    if not (is_owner or is_admin or is_offering_teacher or is_my_student):
        raise HTTPException(403, '仅提交者本人或授课教师可以查看源代码')

    source_row = db.one(f"SELECT source FROM jol.source_code WHERE solution_id={int(sid)}")
    code = source_row['source'] if source_row else ''
    if code.startswith('# coding=utf-8\n'):
        code = code[len('# coding=utf-8\n'):]

    compile_err = db.one(f"SELECT error FROM jol.compileinfo WHERE solution_id={int(sid)}")
    runtime_err = db.one(f"SELECT error FROM jol.runtimeinfo WHERE solution_id={int(sid)}")
    sim_row = db.one(f"SELECT * FROM jol.sim WHERE s_id={int(sid)} OR sim_s_id={int(sid)}")

    return {
        'solutionId': int(sid),
        'userId': s['user_id'],
        'problemId': int(s['problem_id']),
        'problemTitle': s.get('problem_title'),
        'result': int(s['result']),
        'resultLabel': RESULTS.get(int(s['result']), '其他结果'),
        'time': int(s.get('time') or 0),
        'memory': int(s.get('memory') or 0),
        'language': int(s.get('language') or 0),
        'languageName': LANG_NAMES.get(int(s.get('language') or 0), '其他'),
        'code': code,
        'compileError': compile_err['error'] if compile_err else None,
        'runtimeError': runtime_err['error'] if runtime_err else None,
        'sim': sim_row
    }
