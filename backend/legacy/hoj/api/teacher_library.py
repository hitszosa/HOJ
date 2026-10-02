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
from hoj.services.access import check_teacher, get_teacher_primary_offering, offering_access
from hoj.services.ai import ai_config
from hoj.services.authoring import ensure_authoring_batch, sync_authoring_problem
from hoj.services.documents import parse_document, validate_document
from hoj.services.drafts import get_draft

router = APIRouter()


@router.get('/api/teacher/library')
def get_teacher_library(request: Request):
    user = principal(request)
    check_teacher(user)
    
    # 1. Fetch all offerings taught by this teacher
    offerings_rows = db.rows(f"""SELECT c.code, c.name, o.offering_id, o.term, o.section, o.status, o.title
                                FROM cm_course c
                                JOIN cm_offering o USING(course_id)
                                WHERE o.teacher_id={q(user)} OR {q(user)}='admin'
                                ORDER BY o.term DESC, c.code""")
    
    # 2. Fetch all drafts owned by this teacher
    draft_rows = db.rows(f"""SELECT d.draft_id, d.offering_id, d.owner_id, d.title, d.payload, d.status, d.origin, d.batch_id, d.updated_at,
                                    o.term AS offering_term, o.section AS offering_section, o.title AS offering_title,
                                    c.name AS course_name, c.code AS course_code
                             FROM cm_authoring_draft d
                             LEFT JOIN cm_offering o ON d.offering_id = o.offering_id
                             LEFT JOIN cm_course c ON o.course_id = c.course_id
                             WHERE d.owner_id={q(user)}
                             ORDER BY d.updated_at DESC""")
    
    sets = []
    flattened_problems = []
    seen_problem_keys = set()
    
    for r in draft_rows:
        try:
            doc = json.loads(r['payload']) if isinstance(r['payload'], str) else (r['payload'] or {})
        except Exception:
            doc = {}
        
        raw_probs = doc.get('problems', [])
        parsed_probs = []
        for p in raw_probs:
            slug = p.get('slug') or p.get('title') or ''
            statement = p.get('statement') or ''
            knowledge = p.get('knowledge') or []
            if isinstance(knowledge, str):
                knowledge = [k.strip() for k in knowledge.split('、') if k.strip()]
            difficulty = p.get('difficulty') or 'medium'
            samples = p.get('samples') or []
            tests = p.get('tests') or []
            
            prob_item = {
                'slug': slug,
                'title': p.get('title') or slug,
                'statement': statement,
                'knowledge': knowledge,
                'difficulty': difficulty,
                'samples': samples,
                'samplesCount': len(samples),
                'testsCount': len(tests),
                'draftId': r['draft_id'],
                'draftTitle': r['title'],
                'origin': r['origin'],
                'updatedAt': str(r['updated_at'])
            }
            parsed_probs.append(prob_item)
            
            p_key = (p.get('title') or slug, slug)
            if p_key not in seen_problem_keys:
                seen_problem_keys.add(p_key)
                flattened_problems.append(prob_item)
        
        sets.append({
            'draftId': r['draft_id'],
            'offeringId': int(r['offering_id']) if r.get('offering_id') else None,
            'title': r['title'],
            'status': r['status'],
            'origin': r['origin'],
            'batchId': int(r['batch_id']) if r.get('batch_id') else None,
            'updatedAt': str(r['updated_at']),
            'count': len(parsed_probs),
            'problems': parsed_probs,
            'courseCode': r.get('course_code'),
            'courseName': r.get('course_name'),
            'offeringTerm': r.get('offering_term'),
            'offeringSection': r.get('offering_section'),
            'offeringTitle': r.get('offering_title')
        })
    
    ai_count = sum(1 for s in sets if s['origin'] == 'ai')
    teacher_count = sum(1 for s in sets if s['origin'] == 'teacher')
    published_count = sum(1 for s in sets if s['status'] == 'published')
    
    return {
        'sets': sets,
        'problems': flattened_problems,
        'offerings': offerings_rows,
        'stats': {
            'totalSets': len(sets),
            'totalProblems': len(flattened_problems),
            'aiSets': ai_count,
            'teacherSets': teacher_count,
            'publishedSets': published_count
        }
    }


@router.post('/api/teacher/library/sets')
def create_library_set(data: dict, request: Request):
    user = principal(request)
    check_teacher(user)
    
    oid = data.get('offeringId')
    if oid:
        offering_access(user, int(oid), teacher=True, write=True)
        oid = int(oid)
    else:
        oid = get_teacher_primary_offering(user)
        
    topic = str(data.get('topic', '')).strip()[:500]
    content = data.get('content')
    doc_data = data.get('document')
    
    if topic:
        endpoint, model, token = ai_config()
        if not endpoint or not model:
            raise HTTPException(503, '尚未连接 AI 出题服务；请使用自编题或导入题单')
        try:
            with httpx.Client(timeout=45, trust_env=False) as client:
                r = client.post(
                    endpoint.rstrip('/') + '/chat/completions',
                    headers={'Authorization': 'Bearer ' + (token or '')},
                    json={
                        'model': model,
                        'messages': [
                            {'role': 'system', 'content': '你是编程课教师助手。只返回 JSON 题单，含 title, problems。每题含 slug,title,statement,samples:[{input,output}],tests:[{input,output}],knowledge:[字符串]。给出可验证的边界测试。产物必须由教师审核。不得声称已访问外部资料。'},
                            {'role': 'user', 'content': topic}
                        ]
                    }
                )
                r.raise_for_status()
                text = r.json()['choices'][0]['message']['content']
            text = re.sub(r'^```(?:json)?\s*|\s*```$', '', text.strip())
            doc = validate_document(json.loads(text))
        except (httpx.HTTPError, ValueError, KeyError, IndexError):
            raise HTTPException(502, 'AI 服务没有返回有效题单，请重试或手动编写')
        
        ident = uuid.uuid4().hex
        db.write(f"INSERT INTO cm_authoring_draft(draft_id,offering_id,owner_id,title,payload,status,origin,updated_at) VALUES({q(ident)},{oid},{q(user)},{q(doc['title'])},{q(json.dumps(doc,ensure_ascii=False))},'draft','ai',NOW())")
        return {'id': ident, 'document': doc, 'status': 'draft'}
        
    elif content:
        doc = parse_document(content)
        ident = uuid.uuid4().hex
        db.write(f"INSERT INTO cm_authoring_draft(draft_id,offering_id,owner_id,title,payload,status,origin,updated_at) VALUES({q(ident)},{oid},{q(user)},{q(doc['title'])},{q(json.dumps(doc,ensure_ascii=False))},'draft','teacher',NOW())")
        return {'id': ident, 'document': doc, 'status': 'draft'}
    elif doc_data:
        doc = validate_document(doc_data)
        ident = uuid.uuid4().hex
        db.write(f"INSERT INTO cm_authoring_draft(draft_id,offering_id,owner_id,title,payload,status,origin,updated_at) VALUES({q(ident)},{oid},{q(user)},{q(doc['title'])},{q(json.dumps(doc,ensure_ascii=False))},'draft','teacher',NOW())")
        return {'id': ident, 'document': doc, 'status': 'draft'}
    else:
        title = str(data.get('title', '')).strip() or '新建自编题单'
        doc = {
            'title': title,
            'problems': [{
                'slug': 'prob-01',
                'title': '第一题：新试题描述',
                'statement': '输入描述...\n输出描述...\n数据范围...',
                'knowledge': ['基础语法'],
                'samples': [{'input': '1 2\n', 'output': '3\n'}],
                'tests': [{'input': '2 3\n', 'output': '5\n'}]
            }]
        }
        ident = uuid.uuid4().hex
        db.write(f"INSERT INTO cm_authoring_draft(draft_id,offering_id,owner_id,title,payload,status,origin,updated_at) VALUES({q(ident)},{oid},{q(user)},{q(title)},{q(json.dumps(doc,ensure_ascii=False))},'draft','teacher',NOW())")
        return {'id': ident, 'document': doc, 'status': 'draft'}


@router.post('/api/teacher/library/deploy')
def deploy_library_set(data: dict, request: Request):
    user = principal(request)
    check_teacher(user)
    
    draft_id = str(data.get('draftId', '')).strip()
    if not draft_id:
        raise HTTPException(422, '请指定要发布的题单 (draftId)')
        
    raw_oids = data.get('offeringIds')
    if not isinstance(raw_oids, list) or not raw_oids:
        raise HTTPException(422, '请至少选择一个发布的教学班级')
        
    clean_oids = []
    for raw_oid in raw_oids:
        try:
            oid = int(raw_oid)
        except (ValueError, TypeError):
            continue
        offering_access(user, oid, teacher=True, write=True)
        clean_oids.append(oid)
    if not clean_oids:
        raise HTTPException(422, '无效的教学班级列表')
        
    source_draft = get_draft(draft_id, user, write=False)
    doc = validate_document(source_draft['document'])
    
    # Check hidden tests
    for p in doc['problems']:
        if not p.get('tests'):
            raise HTTPException(422, f'题目「{p.get("title")}」缺少隐藏测试；仅公开样例不能发布')
        sample_pairs = {(s['input'], s['output']) for s in p.get('samples', [])}
        if all((t['input'], t['output']) in sample_pairs for t in p['tests']):
            raise HTTPException(422, f'题目「{p.get("title")}」隐藏测试必须覆盖样例之外的输入')
            
    due = data.get('dueAt') or None
    if due:
        try:
            time.strptime(due.replace('T', ' '), '%Y-%m-%d %H:%M')
        except ValueError:
            raise HTTPException(422, '截止时间格式无效')
        due = due.replace('T', ' ')
        
    ai_enabled = 1 if data.get('aiEnabled', True) else 0
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
            
    results = []
    with MUTEX:
        for oid in clean_oids:
            # If draft already belongs to this oid and is unpublished, use it directly
            if int(source_draft['offering_id']) == oid and source_draft['status'] != 'published':
                cur_ident = draft_id
            else:
                cur_ident = uuid.uuid4().hex
                db.write(f"INSERT INTO cm_authoring_draft(draft_id,offering_id,owner_id,title,payload,status,origin,updated_at) "
                         f"VALUES({q(cur_ident)},{oid},{q(user)},{q(doc['title'])},{q(json.dumps(doc,ensure_ascii=False))},'draft',{q(source_draft['origin'])},NOW())")
            
            read_only = 1 if doc.get('read_only') is True else 0
            source_ref = doc.get('source_ref') or f"teacher:{user}:{cur_ident[:8]}"
            bid = ensure_authoring_batch(oid, doc['title'], cur_ident, read_only, source_ref)
            pids = [sync_authoring_problem(cur_ident, p) for p in doc['problems']]
            ids = ','.join(str(int(x)) for x in pids)
            db.write(f"UPDATE jol.problem SET defunct='Y' WHERE source LIKE {q(f'codemind:authoring/{cur_ident}/%')} AND problem_id NOT IN ({ids})", ops=True)
            db.write(f"UPDATE jol.problem SET defunct='N' WHERE problem_id IN ({ids})", ops=True)
            pairs = ','.join(f"({int(bid)},{int(pid)},{seq},100,NOW(),NOW())" for seq, pid in enumerate(pids, 1))
            db.write("BEGIN;"
                     f" DELETE FROM cm_batch_problem WHERE batch_id={int(bid)};"
                     f" INSERT INTO cm_batch_problem(batch_id,problem_id,seq,score,created_at,updated_at) VALUES {pairs};"
                     f" UPDATE cm_authoring_draft SET batch_id={int(bid)}, status='published', updated_at=NOW() WHERE draft_id={q(cur_ident)};"
                     f" UPDATE cm_batch SET status='published',due_at={q(due)},ai_enabled={ai_enabled},allowed_languages={q(allowed_langs_str)},source_ref=COALESCE({q(source_ref)},source_ref),updated_at=NOW() WHERE batch_id={int(bid)};"
                     " COMMIT;")
            
            off_info = db.one(f"SELECT c.name, o.section FROM cm_offering o JOIN cm_course c USING(course_id) WHERE o.offering_id={oid}")
            results.append({
                'offeringId': oid,
                'batchId': bid,
                'draftId': cur_ident,
                'courseName': off_info['name'] if off_info else '',
                'section': off_info['section'] if off_info else '',
                'status': 'published'
            })
            
    return {
        'ok': True,
        'title': doc['title'],
        'problemCount': len(doc['problems']),
        'offeringCount': len(clean_oids),
        'results': results
    }
