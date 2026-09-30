from __future__ import annotations

import json
import re
import time
import uuid

from fastapi import APIRouter, HTTPException, Request

from hoj.auth import principal
from hoj.config import ROOT, yaml_load
from hoj.hustoj.constants import LANGUAGES
from hoj.infra.database import db, q
from hoj.infra.locks import MUTEX
from hoj.services.access import offering_access
from hoj.services.authoring import ensure_authoring_batch, sync_authoring_problem
from hoj.services.documents import validate_document
from hoj.services.drafts import get_draft
from hoj.services.problem_bank import TAXONOMY, get_problem_sets_index, resolve_set_file

router = APIRouter()


@router.get('/api/offerings/{oid}/problem-sets')
def offering_problem_sets(oid: int, request: Request):
    user = principal(request)
    offering_access(user, oid, teacher=True)
    cinfo = db.one(f"""SELECT c.course_id, c.code, c.name, o.term, o.section, o.title as offering_title
                       FROM cm_offering o
                       JOIN cm_course c USING(course_id)
                       WHERE o.offering_id={int(oid)}""")
    if not cinfo:
        raise HTTPException(404, '课程不存在')
        
    code = cinfo['code'].upper()
    canonical_code = code.replace('PILOT', 'COMP')
    
    data = get_problem_sets_index()
    
    syllabus_file = ROOT / 'data' / 'course_syllabus.json'
    syllabus = {}
    if syllabus_file.is_file():
        try:
            with open(syllabus_file, 'r', encoding='utf-8') as f:
                syllabus = json.load(f)
        except Exception:
            syllabus = {}
            
    recommended_codes = set(syllabus.get(canonical_code, {}).get('recommended_categories', []))
    
    recommended_categories = []
    all_categories = []
    for cat in data['categories']:
        matched = cat['code'] in recommended_codes
        item = dict(cat)
        item['matched'] = matched
        all_categories.append(item)
        if matched:
            recommended_categories.append(item)
            
    course_sets = []
    contest_sets = []
    for s in data['standalone_sets']:
        scourse = (s.get('course') or '').upper()
        scode = s['code'].upper()
        if scourse == canonical_code or scode.startswith(canonical_code):
            course_sets.append(s)
        elif not any(scode.startswith(c) for c in ('COMP', 'PILOT')):
            contest_sets.append(s)
            
    # Fetch this teacher's personal sets/drafts
    my_drafts = db.rows(f"""SELECT draft_id, title, payload, origin, updated_at 
                            FROM cm_authoring_draft 
                            WHERE owner_id={q(user)} 
                            ORDER BY updated_at DESC""")
    my_problem_sets = []
    for d in my_drafts:
        try:
            doc = json.loads(d['payload']) if isinstance(d['payload'], str) else (d['payload'] or {})
            probs = []
            for p in doc.get('problems', []):
                probs.append({
                    'slug': p.get('slug', ''),
                    'title': p.get('title', ''),
                    'difficulty': p.get('difficulty', 'medium'),
                    'knowledge': p.get('knowledge', []),
                    'statement': p.get('statement', ''),
                    'samples': p.get('samples', [])
                })
            my_problem_sets.append({
                'id': f"draft:{d['draft_id']}",
                'draftId': d['draft_id'],
                'code': d['draft_id'][:8],
                'title': d['title'],
                'origin': d['origin'],
                'count': len(probs),
                'problems': probs
            })
        except Exception:
            pass

    return {
        'courseId': int(cinfo['course_id']),
        'courseCode': cinfo['code'],
        'courseName': cinfo['name'],
        'offeringTitle': cinfo.get('offering_title') or f"{cinfo['term']} · {cinfo['section']}班",
        'term': cinfo['term'],
        'section': cinfo['section'],
        'recommendedCategories': recommended_categories,
        'courseSets': course_sets,
        'allCategories': all_categories,
        'contestSets': contest_sets,
        'myProblemSets': my_problem_sets
    }


@router.get('/api/problem-sets')
def get_all_problem_sets(request: Request):
    user = principal(request)
    return get_problem_sets_index()


@router.get('/api/problem-sets/tree')
def category_tree_view(request: Request):
    user = principal(request)
    data = get_problem_sets_index()
    cat_map = {c['code']: c for c in data['categories']}
    set_map = {s['code']: s for s in data['standalone_sets']}

    tree_nodes = []
    total_problems = 0
    total_sets = 0

    for pillar in TAXONOMY:
        p_node = {
            'id': pillar['id'],
            'name': pillar['name'],
            'icon': pillar['icon'],
            'description': pillar['description'],
            'kind': 'pillar',
            'children': [],
            'count': 0
        }
        for grp in pillar['children']:
            g_node = {
                'id': grp['id'],
                'name': grp['name'],
                'kind': 'group',
                'children': [],
                'count': 0
            }
            for code in grp['codes']:
                item = cat_map.get(code) or set_map.get(code)
                if not item:
                    continue
                total_sets += 1
                leaf = {
                    'id': item['id'],
                    'code': item['code'],
                    'name': item['title'],
                    'kind': 'leaf',
                    'count': item['count'],
                    'tags': item.get('tags', []),
                    'difficultyCount': item.get('difficultyCount', {}),
                    'problems': item.get('problems', [])
                }
                g_node['children'].append(leaf)
                g_node['count'] += leaf['count']
            p_node['children'].append(g_node)
            p_node['count'] += g_node['count']
        tree_nodes.append(p_node)
        total_problems += p_node['count']

    root_tree = {
        'id': 'root',
        'name': '算法题库全景分类体系',
        'icon': '🎓',
        'kind': 'root',
        'count': total_problems,
        'children': tree_nodes
    }

    user_status = {}
    try:
        if user:
            rows = db.rows(f"""
                SELECT p.source,
                       MAX(CASE WHEN s.result = 4 THEN 1 ELSE 0 END) as passed,
                       COUNT(s.solution_id) as tries
                FROM jol.solution s
                JOIN jol.problem p ON s.problem_id = p.problem_id
                WHERE s.user_id = {q(user)} AND p.source LIKE 'bank:%'
                GROUP BY p.source
            """)
            for r in rows:
                src = r['source']
                pslug = src.split(':', 1)[1] if ':' in src else src
                user_status[pslug] = 'passed' if int(r['passed']) == 1 else ('tried' if int(r['tries']) > 0 else 'unattempted')
    except Exception:
        pass

    return {
        'root': root_tree,
        'pillars': tree_nodes,
        'totalProblems': total_problems,
        'totalSets': total_sets,
        'myStatus': user_status
    }


@router.get('/api/problem-sets/my-status')
def get_bank_my_status(request: Request):
    user = principal(request)
    status_map = {}
    try:
        rows = db.rows(f"""
            SELECT p.source,
                   MAX(CASE WHEN s.result = 4 THEN 1 ELSE 0 END) as passed,
                   COUNT(s.solution_id) as tries
            FROM jol.solution s
            JOIN jol.problem p ON s.problem_id = p.problem_id
            WHERE s.user_id = {q(user)} AND p.source LIKE 'bank:%'
            GROUP BY p.source
        """)
        for r in rows:
            src = r['source']
            pslug = src.split(':', 1)[1] if ':' in src else src
            status_map[pslug] = 'passed' if int(r['passed']) == 1 else ('tried' if int(r['tries']) > 0 else 'unattempted')
    except Exception:
        pass
    return status_map


@router.post('/api/offerings/{oid}/import-set')
def import_problem_set(oid: int, data: dict, request: Request):
    user = principal(request)
    offering_access(user, oid, teacher=True, write=True)
    
    file_cache = {}
    def load_set_doc(sid):
        if sid in file_cache:
            return file_cache[sid]
        if sid.startswith('draft:'):
            did = sid.split(':', 1)[1]
            draft_row = get_draft(did, user, write=False)
            code = f"draft:{did[:8]}"
            doc = draft_row.get('document') or {}
            file_cache[sid] = (code, doc)
            return code, doc
        code, path = resolve_set_file(sid)
        if not path.is_file():
            raise HTTPException(404, f'未找到题单文件: {sid}')
        with open(path, 'r', encoding='utf-8') as f:
            doc = yaml_load(f) or {}
        file_cache[sid] = (code, doc)
        return code, doc

    items = data.get('items')
    chosen = []
    source_refs = set()
    
    if isinstance(items, list) and items:
        for it in items:
            sid = str(it.get('setId', '')).strip()
            slug = str(it.get('slug', '')).strip()
            if not sid or not slug:
                continue
            code, doc = load_set_doc(sid)
            source_refs.add(code)
            for p in doc.get('problems', []):
                if p.get('slug') == slug:
                    chosen.append(dict(p))
                    break
        if not chosen:
            raise HTTPException(422, '未在指定题单中找到勾选的题目')
    else:
        set_id = str(data.get('setId', '')).strip()
        if not set_id:
            raise HTTPException(422, '请指定题单编号 (setId) 或题目清单 (items)')
        code, source_doc = load_set_doc(set_id)
        source_refs.add(code)
        all_problems = source_doc.get('problems', [])
        if not all_problems:
            raise HTTPException(422, '题单内容为空')
        selected_slugs = data.get('selectedSlugs')
        if isinstance(selected_slugs, list) and selected_slugs:
            slug_set = set(selected_slugs)
            chosen = [p for p in all_problems if p.get('slug') in slug_set]
        else:
            chosen = all_problems[:15] if len(all_problems) > 15 else all_problems
        if not chosen:
            raise HTTPException(422, '未选中任何题目')

    if len(chosen) > 100:
        chosen = chosen[:100]
        
    draft_problems = []
    used_slugs = set()
    for seq, p in enumerate(chosen, 1):
        raw_slug = str(p.get('slug') or f'prob-{seq}')
        slug = re.sub(r'[^a-zA-Z0-9_-]', '-', raw_slug)[:64]
        if not slug or slug in used_slugs:
            slug = f"{slug[:50]}-{uuid.uuid4().hex[:6]}"
        used_slugs.add(slug)
        
        title = str(p.get('title') or f'题目 {seq}').strip()
        statement = str(p.get('statement') or '').strip()
        if not statement:
            statement = title
            
        samples = p.get('samples')
        if not samples or not isinstance(samples, list):
            samples = [{'input': '1\n', 'output': '1\n'}]
        else:
            samples = [{'input': str(s.get('input', '')), 'output': str(s.get('output', ''))} for s in samples]
            
        tests = p.get('tests')
        if isinstance(tests, list) and tests:
            tests = [{'input': str(t.get('input', '')), 'output': str(t.get('output', ''))} for t in tests]
        else:
            tests = []
            
        draft_problems.append({
            'slug': slug,
            'seq': seq,
            'title': title,
            'statement': statement,
            'knowledge': [str(k) for k in p.get('knowledge', []) if isinstance(k, (str, int))],
            'samples': samples,
            'tests': tests
        })
        
    title = str(data.get('title', '')).strip()
    if not title:
        if len(source_refs) == 1:
            code = list(source_refs)[0]
            title = f"题单 · {code}"
        else:
            title = f"跨题单组合练习 ({len(draft_problems)} 题)"
            
    source_ref = f"bank:{','.join(sorted(source_refs))}" if len(source_refs) <= 3 else f"bank:mixed({len(source_refs)})"
    if len(source_ref) > 255:
        source_ref = source_ref[:255]
        
    doc = {
        'title': title,
        'source_ref': source_ref,
        'read_only': False,
        'problems': draft_problems
    }
    
    validated = validate_document(doc)
    ident = uuid.uuid4().hex
    db.write(f"INSERT INTO cm_authoring_draft(draft_id,offering_id,owner_id,title,payload,status,origin,updated_at) "
             f"VALUES({q(ident)},{oid},{q(user)},{q(validated['title'])},{q(json.dumps(validated,ensure_ascii=False))},'draft','teacher',NOW())")
    return {'id': ident, 'status': 'draft', 'count': len(draft_problems), 'document': validated}


@router.post('/api/problem-sets/publish-to-offerings')
def publish_to_offerings(data: dict, request: Request):
    user = principal(request)
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

    file_cache = {}
    def load_set_doc(sid):
        if sid in file_cache:
            return file_cache[sid]
        if sid.startswith('draft:'):
            did = sid.split(':', 1)[1]
            draft_row = get_draft(did, user, write=False)
            code = f"draft:{did[:8]}"
            doc = draft_row.get('document') or {}
            file_cache[sid] = (code, doc)
            return code, doc
        code, path = resolve_set_file(sid)
        if not path.is_file():
            raise HTTPException(404, f'未找到题单文件: {sid}')
        with open(path, 'r', encoding='utf-8') as f:
            doc = yaml_load(f) or {}
        file_cache[sid] = (code, doc)
        return code, doc

    items = data.get('items')
    chosen = []
    source_refs = set()
    
    if isinstance(items, list) and items:
        for it in items:
            sid = str(it.get('setId', '')).strip()
            slug = str(it.get('slug', '')).strip()
            if not sid or not slug:
                continue
            code, doc = load_set_doc(sid)
            source_refs.add(code)
            for p in doc.get('problems', []):
                if p.get('slug') == slug:
                    chosen.append(dict(p))
                    break
        if not chosen:
            raise HTTPException(422, '未在指定题单中找到勾选的题目')
    else:
        set_id = str(data.get('setId', '')).strip()
        if not set_id:
            raise HTTPException(422, '请指定题单编号 (setId) 或题目清单 (items)')
        code, source_doc = load_set_doc(set_id)
        source_refs.add(code)
        all_problems = source_doc.get('problems', [])
        if not all_problems:
            raise HTTPException(422, '题单内容为空')
        selected_slugs = data.get('selectedSlugs')
        if isinstance(selected_slugs, list) and selected_slugs:
            slug_set = set(selected_slugs)
            chosen = [p for p in all_problems if p.get('slug') in slug_set]
        else:
            chosen = all_problems[:15] if len(all_problems) > 15 else all_problems
        if not chosen:
            raise HTTPException(422, '未选中任何题目')

    if len(chosen) > 100:
        chosen = chosen[:100]

    draft_problems = []
    used_slugs = set()
    for seq, p in enumerate(chosen, 1):
        raw_slug = str(p.get('slug') or f'prob-{seq}')
        slug = re.sub(r'[^a-zA-Z0-9_-]', '-', raw_slug)[:64]
        if not slug or slug in used_slugs:
            slug = f"{slug[:50]}-{uuid.uuid4().hex[:6]}"
        used_slugs.add(slug)
        
        title = str(p.get('title') or f'题目 {seq}').strip()
        statement = str(p.get('statement') or '').strip()
        if not statement:
            statement = title
            
        samples = p.get('samples')
        if not samples or not isinstance(samples, list):
            samples = [{'input': '1\n', 'output': '1\n'}]
        else:
            samples = [{'input': str(s.get('input', '')), 'output': str(s.get('output', ''))} for s in samples]
            
        tests = p.get('tests')
        if isinstance(tests, list) and tests:
            tests = [{'input': str(t.get('input', '')), 'output': str(t.get('output', ''))} for t in tests]
        else:
            tests = [{'input': str(s.get('input', '1\n')), 'output': str(s.get('output', '1\n'))} for s in samples]
            
        draft_problems.append({
            'slug': slug,
            'seq': seq,
            'title': title,
            'statement': statement,
            'knowledge': [str(k) for k in p.get('knowledge', []) if isinstance(k, (str, int))],
            'samples': samples,
            'tests': tests
        })
        
    title = str(data.get('title', '')).strip()
    if not title:
        if len(source_refs) == 1:
            code = list(source_refs)[0]
            title = f"题单 · {code}"
        else:
            title = f"跨题单组合练习 ({len(draft_problems)} 题)"
            
    source_ref = f"bank:{','.join(sorted(source_refs))}" if len(source_refs) <= 3 else f"bank:mixed({len(source_refs)})"
    if len(source_ref) > 255:
        source_ref = source_ref[:255]
        
    raw_allowed = data.get('allowedLanguages')
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

    doc = {
        'title': title,
        'source_ref': source_ref,
        'read_only': False,
        'allowed_languages': allowed_langs_str,
        'problems': draft_problems
    }
    
    validated = validate_document(doc)
    action = str(data.get('action', 'publish')).strip().lower()
    due = data.get('dueAt') or None
    if due:
        try: time.strptime(due.replace('T', ' '), '%Y-%m-%d %H:%M')
        except ValueError: raise HTTPException(422, '截止时间格式无效')
        due = due.replace('T', ' ')
    ai_enabled = 1 if data.get('aiEnabled', True) else 0

    results = []
    with MUTEX:
        for oid in clean_oids:
            ident = uuid.uuid4().hex
            db.write(f"INSERT INTO cm_authoring_draft(draft_id,offering_id,owner_id,title,payload,status,origin,updated_at) "
                     f"VALUES({q(ident)},{oid},{q(user)},{q(validated['title'])},{q(json.dumps(validated,ensure_ascii=False))},'draft','teacher',NOW())")
            
            if action == 'publish':
                bid = ensure_authoring_batch(oid, doc['title'], ident, 0, source_ref)
                pids = [sync_authoring_problem(ident, p) for p in doc['problems']]
                ids = ','.join(str(int(x)) for x in pids)
                db.write(f"UPDATE jol.problem SET defunct='Y' WHERE source LIKE {q(f'codemind:authoring/{ident}/%')} AND problem_id NOT IN ({ids})", ops=True)
                db.write(f"UPDATE jol.problem SET defunct='N' WHERE problem_id IN ({ids})", ops=True)
                pairs = ','.join(f"({int(bid)},{int(pid)},{seq},100,NOW(),NOW())" for seq, pid in enumerate(pids, 1))
                db.write("BEGIN;"
                         f" DELETE FROM cm_batch_problem WHERE batch_id={int(bid)};"
                         f" INSERT INTO cm_batch_problem(batch_id,problem_id,seq,score,created_at,updated_at) VALUES {pairs};"
                         f" UPDATE cm_authoring_draft SET batch_id={int(bid)}, status='published', updated_at=NOW() WHERE draft_id={q(ident)};"
                         f" UPDATE cm_batch SET status='published',due_at={q(due)},ai_enabled={ai_enabled},allowed_languages={q(allowed_langs_str)},source_ref=COALESCE({q(source_ref)},source_ref),updated_at=NOW() WHERE batch_id={int(bid)};"
                         " COMMIT;")
                results.append({'offeringId': oid, 'batchId': bid, 'draftId': ident, 'status': 'published'})
            else:
                results.append({'offeringId': oid, 'draftId': ident, 'status': 'draft'})

    return {
        'ok': True,
        'action': action,
        'title': validated['title'],
        'problemCount': len(draft_problems),
        'offeringCount': len(clean_oids),
        'results': results
    }
