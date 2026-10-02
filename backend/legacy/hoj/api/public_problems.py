from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request

from hoj.auth import principal
from hoj.hustoj.constants import LANGUAGES
from hoj.infra.database import db, q
from hoj.services.problem_bank import ensure_bank_problem, find_problem_by_slug

router = APIRouter()


@router.get('/api/public-problems')
def get_public_problems(request: Request, keyword: str = None, page: int = 1, pageSize: int = 20):
    user = principal(request)
    limit = max(1, min(pageSize, 100))
    offset = (max(1, page) - 1) * limit

    where = ["p.defunct = 'N'", "p.problem_id > 0"]
    if keyword and keyword.strip():
        kw = keyword.strip()
        if kw.isdigit():
            where.append(f"(p.problem_id = {int(kw)} OR p.title LIKE {q(f'%{kw}%')})")
        else:
            where.append(f"(p.title LIKE {q(f'%{kw}%')} OR p.source LIKE {q(f'%{kw}%')})")
    where_clause = " AND ".join(where)

    sql = f"""
        SELECT p.problem_id, p.title, p.source, p.accepted, p.submit,
               MAX(CASE WHEN s.user_id = {q(user)} AND s.result = 4 THEN 1 WHEN s.user_id = {q(user)} THEN 0 ELSE NULL END) as solved_by_me
        FROM jol.problem p
        LEFT JOIN jol.solution s ON s.problem_id = p.problem_id AND s.user_id = {q(user)}
        WHERE {where_clause}
        GROUP BY p.problem_id, p.title, p.source, p.accepted, p.submit
        ORDER BY p.problem_id ASC
        LIMIT {limit} OFFSET {offset}
    """
    total_row = db.one(f"SELECT COUNT(*) as n FROM jol.problem p WHERE {where_clause}")
    total_count = int(total_row['n']) if total_row else 0
    rows = db.rows(sql)
    for r in rows:
        r['problemId'] = int(r['problem_id'])
        acc = int(r.get('accepted') or 0)
        sub = int(r.get('submit') or 0)
        r['accepted'] = acc
        r['submit'] = sub
        r['passRate'] = round(acc / sub * 100, 1) if sub > 0 else 0.0
        sbm = r.get('solved_by_me')
        r['solvedStatus'] = 'passed' if sbm == 1 else ('tried' if sbm == 0 else 'unattempted')

    return {
        'items': rows,
        'total': total_count,
        'page': page,
        'pageSize': limit
    }


@router.get('/api/public-problems/{pid}')
def get_public_problem(pid: str, request: Request):
    user = principal(request)
    pid_str = str(pid).strip()

    if pid_str.isdigit():
        p = db.one(f"SELECT problem_id, title, description, input, output, sample_input, sample_output, hint, source, time_limit, memory_limit, accepted, submit FROM jol.problem WHERE problem_id={int(pid_str)} AND defunct='N'")
        if p:
            sbm = db.one(f"SELECT MAX(CASE WHEN result=4 THEN 1 ELSE 0 END) as passed, COUNT(*) as tries FROM jol.solution WHERE problem_id={int(pid_str)} AND user_id={q(user)}")
            solved = 'passed' if sbm and sbm.get('passed') == '1' else ('tried' if sbm and int(sbm.get('tries') or 0) > 0 else 'unattempted')
            slug = pid_str
            if p.get('source', '') and str(p.get('source', '')).startswith('bank:'):
                slug = str(p['source']).split(':', 1)[1]
            return {
                'problemId': int(pid_str),
                'numericPid': int(p['problem_id']),
                'slug': slug,
                'title': p['title'],
                'description': p['description'],
                'input': p['input'],
                'output': p['output'],
                'sampleInput': p['sample_input'],
                'sampleOutput': p['sample_output'],
                'samples': [{'input': p['sample_input'] or '', 'output': p['sample_output'] or ''}] if p.get('sample_input') else [],
                'hint': p['hint'],
                'timeLimit': float(p['time_limit']),
                'memoryLimit': int(p['memory_limit']),
                'accepted': int(p.get('accepted') or 0),
                'submit': int(p.get('submit') or 0),
                'solvedStatus': solved
            }

    prob = find_problem_by_slug(pid_str)
    if not prob:
        raise HTTPException(404, '题目不存在或未开放')

    num_pid = ensure_bank_problem(pid_str)
    samples = prob.get('samples') or []
    s_in = samples[0].get('input', '') if samples else ''
    s_out = samples[0].get('output', '') if samples else ''

    solved = 'unattempted'
    if num_pid:
        sbm = db.one(f"SELECT MAX(CASE WHEN result=4 THEN 1 ELSE 0 END) as passed, COUNT(*) as tries FROM jol.solution WHERE problem_id={num_pid} AND user_id={q(user)}")
        solved = 'passed' if sbm and sbm.get('passed') == '1' else ('tried' if sbm and int(sbm.get('tries') or 0) > 0 else 'unattempted')

    return {
        'problemId': pid_str,
        'numericPid': num_pid,
        'slug': pid_str,
        'title': prob['title'],
        'description': prob.get('statement', ''),
        'input': prob.get('input', ''),
        'output': prob.get('output', ''),
        'sampleInput': s_in,
        'sampleOutput': s_out,
        'samples': samples,
        'hint': '、'.join(str(x) for x in (prob.get('tags', []) or prob.get('knowledge', [])) if x),
        'difficulty': prob.get('difficulty', 'L1-入门'),
        'tags': prob.get('tags', []),
        'provenance': prob.get('provenance', ''),
        'categoryName': prob.get('category_name', ''),
        'timeLimit': 1.0,
        'memoryLimit': 128,
        'accepted': 0,
        'submit': 0,
        'solvedStatus': solved
    }


@router.post('/api/public-problems/{pid}/submissions')
def submit_public_problem(pid: str, data: dict, request: Request):
    user = principal(request)
    pid_str = str(pid).strip()

    if pid_str.isdigit():
        p = db.one(f"SELECT problem_id FROM jol.problem WHERE problem_id={int(pid_str)} AND defunct='N'")
        if not p:
            raise HTTPException(404, '题目不存在或未开放')
        numeric_pid = int(pid_str)
    else:
        numeric_pid = ensure_bank_problem(pid_str)
        if not numeric_pid:
            raise HTTPException(404, '题目不存在或未开放')

    code = data.get('code')
    lang_str = data.get('language')
    if not isinstance(lang_str, str) or lang_str not in LANGUAGES:
        raise HTTPException(400, '无效的编程语言，请在 python / cpp / c / java 中选择')
    if not isinstance(code, str) or not code.strip():
        raise HTTPException(400, '代码不能为空')
    if len(code.encode('utf-8')) > 65536:
        raise HTTPException(400, '代码长度超出 64KB 限制')

    lang = LANGUAGES[lang_str]
    if lang == 6:
        code = '# coding=utf-8\n' + code

    sql = f"""
        INSERT INTO jol.solution(problem_id, user_id, in_date, language, ip, code_length, result)
        VALUES({numeric_pid}, {q(user)}, NOW(), {lang}, '127.0.0.1', {len(code.encode('utf-8'))}, 0);
        SET @sid = LAST_INSERT_ID();
        INSERT INTO jol.source_code(solution_id, source) VALUES(@sid, {q(code)});
    """
    db.write(sql, ops=True)
    sid = int(db.one(f"SELECT MAX(solution_id) as sid FROM jol.solution WHERE user_id={q(user)} AND problem_id={numeric_pid}")['sid'])
    return {'submissionId': sid}
