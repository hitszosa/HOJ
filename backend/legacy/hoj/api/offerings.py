from __future__ import annotations

import re

from fastapi import APIRouter, HTTPException, Request

from hoj.auth import principal
from hoj.hustoj.constants import RESULTS
from hoj.infra.database import db, q
from hoj.services.access import offering_access

router = APIRouter()


@router.get('/api/courses')
def courses(request:Request):
    user=principal(request)
    if user == 'admin':
        return db.rows("SELECT c.*,o.offering_id,o.term,o.section,o.status,o.teacher_id,'teacher' AS role FROM cm_course c JOIN cm_offering o ON o.course_id=c.course_id ORDER BY o.term DESC,c.code")
    return db.rows(f"SELECT c.*,o.offering_id,o.term,o.section,o.status,o.teacher_id,CASE WHEN o.teacher_id={q(user)} THEN 'teacher' ELSE e.role END role FROM cm_course c JOIN cm_offering o ON o.course_id=c.course_id LEFT JOIN cm_enrollment e ON e.offering_id=o.offering_id AND e.user_id={q(user)} AND e.status='active' WHERE o.teacher_id={q(user)} OR e.user_id={q(user)} ORDER BY o.term DESC,c.code")


@router.get('/api/offerings/{oid}')
def offering(oid:int,request:Request):
    user=principal(request); off=offering_access(user,oid)
    visibility="AND b.status!='draft' AND (b.open_at IS NULL OR b.open_at<=NOW())" if off['role']=='student' else ''
    problem_visibility = "AND p.defunct='N'" if off['role']=='student' else ""
    batches=db.rows(f"SELECT b.*,(SELECT COUNT(*) FROM cm_batch_problem bp JOIN jol.problem p USING(problem_id) WHERE bp.batch_id=b.batch_id {problem_visibility}) problem_count FROM cm_batch b WHERE b.offering_id={oid} {visibility} ORDER BY seq")
    cnt_row = db.one(f"SELECT COUNT(*) n FROM cm_enrollment WHERE offering_id={oid} AND role='student' AND status='active'")
    total_students = int(cnt_row['n']) if cnt_row and 'n' in cnt_row else 0
    off['student_count'] = total_students
    for b in batches:
        b['student_count'] = total_students
        done_row = db.one(f"SELECT COUNT(DISTINCT s.problem_id) n FROM cm_submission cs JOIN jol.solution s ON s.solution_id=cs.submission_id JOIN jol.problem p ON p.problem_id=s.problem_id WHERE cs.batch_id={int(b['batch_id'])} AND cs.user_id={q(user)} AND s.result=4 AND p.defunct='N'")
        b['done'] = int(done_row['n']) if done_row and 'n' in done_row else 0
        if off['role'] in ('teacher', 'ta'):
            sub_row = db.one(f"SELECT COUNT(DISTINCT cs.user_id) n FROM cm_submission cs WHERE cs.batch_id={int(b['batch_id'])}")
            b['submitted_count'] = int(sub_row['n']) if sub_row and 'n' in sub_row else 0
            p_cnt = max(1, int(b.get('problem_count') or 1))
            comp_row = db.one(f"SELECT COUNT(*) n FROM (SELECT cs.user_id FROM cm_submission cs JOIN jol.solution s ON s.solution_id=cs.submission_id JOIN cm_batch_problem bp ON bp.batch_id=cs.batch_id AND bp.problem_id=s.problem_id WHERE cs.batch_id={int(b['batch_id'])} AND s.result=4 GROUP BY cs.user_id HAVING COUNT(DISTINCT s.problem_id)>={p_cnt}) t")
            b['completed_count'] = int(comp_row['n']) if comp_row and 'n' in comp_row else 0
            b['submission_rate'] = round((b['submitted_count'] / total_students * 100), 1) if total_students > 0 else 0.0
            b['completion_rate'] = round((b['completed_count'] / total_students * 100), 1) if total_students > 0 else 0.0

    res = {'offering': off, 'batches': batches, 'totalStudents': total_students}
    if off['role'] in ('teacher', 'ta'):
        student_stats = db.rows(f"SELECT e.user_id, COALESCE(u.nick, e.user_id) nick, e.student_no, COUNT(DISTINCT CASE WHEN s.result=4 THEN s.problem_id END) passed, COUNT(s.solution_id) attempts, MAX(s.in_date) last_active FROM cm_enrollment e LEFT JOIN jol.users u ON u.user_id=e.user_id LEFT JOIN cm_submission cs ON cs.offering_id=e.offering_id AND cs.user_id=e.user_id LEFT JOIN jol.solution s ON s.solution_id=cs.submission_id WHERE e.offering_id={oid} AND e.role='student' AND e.status='active' GROUP BY e.user_id, u.nick, e.student_no ORDER BY passed DESC, attempts ASC") or []
        results_breakdown = db.rows(f"SELECT s.result, COUNT(*) count FROM cm_submission cs JOIN jol.solution s ON s.solution_id=cs.submission_id WHERE cs.offering_id={oid} GROUP BY s.result") or []
        for c in results_breakdown: c['label'] = RESULTS.get(int(c.get('result') or 0), '其他结果')
        res['insights'] = {'students': student_stats, 'results': results_breakdown}
    return res


@router.get('/api/offerings/{oid}/insights')
def insights(oid:int,request:Request):
    user=principal(request); off=offering_access(user,oid)
    if off['role'] not in ('teacher','ta'): raise HTTPException(403,'仅任课教师与助教可查看班级学情')
    rows=db.rows(f"SELECT e.user_id,COUNT(DISTINCT CASE WHEN s.result=4 THEN s.problem_id END) passed,COUNT(s.solution_id) attempts,MAX(s.in_date) last_active FROM cm_enrollment e LEFT JOIN cm_submission cs ON cs.offering_id=e.offering_id AND cs.user_id=e.user_id LEFT JOIN jol.solution s ON s.solution_id=cs.submission_id WHERE e.offering_id={oid} AND e.role='student' AND e.status='active' GROUP BY e.user_id")
    clusters=db.rows(f'SELECT s.result,COUNT(*) count FROM cm_submission cs JOIN jol.solution s ON s.solution_id=cs.submission_id WHERE cs.offering_id={oid} GROUP BY s.result')
    for c in clusters: c['label']=RESULTS.get(int(c['result']),'其他结果')
    return {'students':rows,'results':clusters,'offering':off,'source':'HUSTOJ 实际提交，按结果码统计'}


@router.get('/api/offerings/{oid}/students')
def offering_students(oid:int, request:Request):
    user = principal(request)
    off = offering_access(user, oid, teacher=True)
    students = db.rows(f"""SELECT 
        e.enrollment_id,
        e.offering_id,
        e.user_id,
        e.role,
        e.student_no,
        e.status,
        e.created_at,
        COALESCE(u.nick, e.user_id) AS nick,
        COALESCE(u.school, 'HITSZ') AS school,
        COUNT(DISTINCT CASE WHEN s.result=4 THEN s.problem_id END) AS passed,
        COUNT(s.solution_id) AS attempts,
        MAX(s.in_date) AS last_active
    FROM cm_enrollment e
    LEFT JOIN jol.users u ON u.user_id = e.user_id
    LEFT JOIN cm_submission cs ON cs.offering_id = e.offering_id AND cs.user_id = e.user_id
    LEFT JOIN jol.solution s ON s.solution_id = cs.submission_id
    WHERE e.offering_id = {oid}
    GROUP BY e.enrollment_id, e.offering_id, e.user_id, e.role, e.student_no, e.status, e.created_at, u.nick, u.school
    ORDER BY CASE e.status WHEN 'active' THEN 0 ELSE 1 END, e.student_no ASC, e.user_id ASC""")
    return {'offering': off, 'students': students}


@router.post('/api/offerings/{oid}/students')
def add_offering_student(oid:int, data:dict, request:Request):
    user = principal(request)
    offering_access(user, oid, teacher=True, write=True)
    raw_list = data.get('students')
    if raw_list is None:
        if 'userId' in data or 'studentNo' in data or 'rawText' in data:
            raw_list = [data]
        else:
            raise HTTPException(422, '请提供学生信息')
    to_add = []
    for item in raw_list:
        if isinstance(item, dict) and 'rawText' in item:
            for line in str(item['rawText']).splitlines():
                parts = [p.strip() for p in re.split(r'[,，\t\s]+', line.strip()) if p.strip()]
                if not parts:
                    continue
                uid = parts[0]
                sno = parts[1] if len(parts) > 1 else uid
                nick = parts[2] if len(parts) > 2 else uid
                to_add.append({'userId': uid, 'studentNo': sno, 'nick': nick, 'role': item.get('role', 'student')})
        elif isinstance(item, dict):
            uid = item.get('userId') or item.get('studentNo')
            sno = item.get('studentNo') or uid
            nick = item.get('nick') or item.get('name') or uid
            role = item.get('role', 'student')
            if uid:
                to_add.append({'userId': str(uid).strip(), 'studentNo': str(sno).strip() if sno else None, 'nick': str(nick).strip() if nick else None, 'role': role})

    if not to_add:
        raise HTTPException(422, '有效学生名单不能为空')

    added_count = 0
    for s in to_add:
        uid = s['userId']
        if not re.fullmatch(r'[A-Za-z0-9_.-]{1,48}', uid):
            continue
        sno = s.get('studentNo') or uid
        nick = s.get('nick') or uid
        role = s.get('role') if s.get('role') in ('student', 'ta', 'teacher') else 'student'
        db.write(f"INSERT IGNORE INTO jol.users(user_id, email, ip, nick, school, reg_time) VALUES ({q(uid)}, {q(uid + '@hitsz.edu.cn')}, '127.0.0.1', {q(nick)}, 'HITSZ', NOW())", ops=True)
        db.write(f"""INSERT INTO cm_enrollment(offering_id, user_id, role, student_no, status, created_at, updated_at)
            VALUES ({oid}, {q(uid)}, {q(role)}, {q(sno)}, 'active', NOW(), NOW())
            ON DUPLICATE KEY UPDATE status='active', role=VALUES(role), student_no=COALESCE(VALUES(student_no), student_no), updated_at=NOW()""")
        added_count += 1

    return {'ok': True, 'count': added_count}


@router.delete('/api/offerings/{oid}/students/{uid}')
def drop_offering_student(oid:int, uid:str, request:Request):
    user = principal(request)
    offering_access(user, oid, teacher=True, write=True)
    if not re.fullmatch(r'[A-Za-z0-9_.-]{1,48}', uid):
        raise HTTPException(400, '用户标识不合法')
    db.write(f"UPDATE cm_enrollment SET status='dropped', updated_at=NOW() WHERE offering_id={oid} AND user_id={q(uid)}")
    return {'ok': True}


@router.post('/api/courses/{cid}/offerings')
def create_offering(cid:int, data:dict, request:Request):
    user = principal(request)
    c = db.one(f"SELECT * FROM cm_course WHERE course_id={cid}")
    if not c:
        raise HTTPException(404, '课程不存在')
    assigned = db.rows(f"""SELECT 'teacher' AS role FROM jol.privilege
        WHERE user_id={q(user)} AND rightstr IN ('teacher', 'administrator')
        UNION SELECT 'teacher' AS role FROM cm_offering WHERE teacher_id={q(user)}""")
    if not assigned and user != 'admin':
        raise HTTPException(403, '仅教师或管理员可开设新班级')
    
    term = str(data.get('term', '')).strip() or '2026-春'
    section = str(data.get('section', '')).strip()
    title = str(data.get('title', '')).strip() or f"{c['name']} {section}班"
    teacher_id = str(data.get('teacherId', '')).strip() or user
    
    if not section:
        raise HTTPException(422, '请填写教学班编号（如 01, 02）')
    if not re.fullmatch(r'[A-Za-z0-9_\-\u4e00-\u9fa5]{1,32}', section):
        raise HTTPException(422, '班级编号格式不合法')
    
    existing = db.one(f"SELECT offering_id FROM cm_offering WHERE course_id={cid} AND term={q(term)} AND section={q(section)}")
    if existing:
        raise HTTPException(409, f'该学期已存在 {section} 班')
    
    db.write(f"""INSERT INTO cm_offering(course_id, term, section, title, teacher_id, status, created_at, updated_at)
        VALUES ({cid}, {q(term)}, {q(section)}, {q(title)}, {q(teacher_id)}, 'active', NOW(), NOW())""")
    row = db.one(f"SELECT offering_id FROM cm_offering WHERE course_id={cid} AND term={q(term)} AND section={q(section)}")
    return {'ok': True, 'offeringId': int(row['offering_id'])}


@router.patch('/api/offerings/{oid}')
def update_offering(oid:int, data:dict, request:Request):
    user = principal(request)
    offering_access(user, oid, teacher=True)
    updates = []
    if 'status' in data:
        st = data['status']
        if st not in ('draft', 'active', 'archived'):
            raise HTTPException(422, '状态无效')
        updates.append(f"status={q(st)}")
    if 'title' in data:
        t = str(data['title']).strip()
        updates.append(f"title={q(t)}")
    if 'section' in data:
        sec = str(data['section']).strip()
        if not re.fullmatch(r'[A-Za-z0-9_\-\u4e00-\u9fa5]{1,32}', sec):
            raise HTTPException(422, '班级编号格式不合法')
        updates.append(f"section={q(sec)}")
    if not updates:
        return {'ok': True}
    updates.append("updated_at=NOW()")
    db.write(f"UPDATE cm_offering SET {', '.join(updates)} WHERE offering_id={oid}")
    return {'ok': True}
