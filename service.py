"""Local Course Service pilot using the existing MySQL/HUSTOJ contract.

Docker transport is for local development. Session identities come from signed,
HttpOnly cookies; development accounts are available only with COURSE_DEV_LOGIN=1.
"""
from __future__ import annotations
import base64
from collections import Counter, defaultdict
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys
import threading
import time
import uuid
import xml.etree.ElementTree as ET

from fastapi import FastAPI, HTTPException, Request, Response
import httpx
import yaml
try:
    from yaml import CSafeLoader as SafeLoader, CSafeDumper as SafeDumper
except ImportError:
    from yaml import SafeLoader, SafeDumper

def yaml_load(stream):
    return yaml.load(stream, Loader=SafeLoader)

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / 'tools'))
import hoa

def load_local_env():
    env_path = ROOT / '.env'
    if env_path.is_file():
        try:
            for line in env_path.read_text(encoding='utf-8').splitlines():
                line = line.strip()
                if line and not line.startswith('#') and '=' in line:
                    k, v = line.split('=', 1)
                    k, v = k.strip(), v.strip().strip("'\"")
                    if k and k not in os.environ:
                        os.environ[k] = v
        except Exception:
            pass

load_local_env()

DB = 'codemind_course'

MUTEX = threading.RLock()
app = FastAPI(title='HUSTOJ 教学服务', version='0.3.0')
RESULTS = {0:'等待判题',1:'等待重判',2:'编译中',3:'运行中',4:'通过',5:'格式错误',6:'答案错误',7:'时间超限',8:'内存超限',9:'输出超限',10:'运行错误',11:'编译错误',14:'正在保存'}
LANGUAGES = {'c':0, 'cpp':1, 'java':3, 'python':6}
LANG_NAMES = {0:'C', 1:'C++', 2:'Pascal', 3:'Java', 4:'Ruby', 5:'Bash', 6:'Python', 7:'PHP', 8:'Perl', 9:'C#', 10:'Objective-C', 11:'FreeBasic', 12:'Schema', 13:'Clang', 14:'Clang++', 15:'Lua', 16:'JavaScript', 17:'Go', 18:'SQL', 19:'Fortran', 20:'MATLAB'}
DEV_USERS = {'student':'cm_pilot_student', 'teacher':'cm_pilot_teacher', 'ta':'cm_pilot_ta', 'outsider':'cm_pilot_outsider'}

def is_allowed_dev_user(user: str) -> bool:
    if not isinstance(user, str) or not re.fullmatch(r'[A-Za-z0-9_.-]{1,64}', user):
        return False
    return True



def q(value):
    if value is None: return 'NULL'
    return "CONVERT(X'%s' USING utf8mb4)" % str(value).encode().hex()


class Database:
    def call(self, sql, ops=False, xml=False):
        prefix = 'COURSE_OPS_' if ops else 'COURSE_DB_'
        user = os.environ.get(prefix+'USER', 'codemind_ops' if ops else 'codemind')
        password = os.environ.get(prefix+'PASSWORD') or os.environ.get('COURSE_DB_PASSWORD')
        if not password: raise HTTPException(503, '尚未配置数据库连接')
        command = ['docker','exec','-i',os.environ.get('COURSE_CONTAINER','hustoj'), 'mysql', '--default-character-set=utf8mb4', '-u'+user, '-p'+password, DB]
        command += ['--xml'] if xml else ['-N','-B']
        try:
            result = subprocess.run(command, input=sql, text=True, capture_output=True, timeout=20)
        except (OSError, subprocess.TimeoutExpired):
            raise HTTPException(503, '判题服务暂时不可达')
        if result.returncode: raise HTTPException(503, '数据库操作失败，请查看课程服务配置与授权')
        return result.stdout

    def rows(self, sql):
        data = self.call(sql, xml=True)
        if not data.strip(): return []
        return [{f.attrib['name']: f.text for f in row} for row in ET.fromstring(data).findall('row')]

    def one(self, sql):
        rows = self.rows(sql)
        return rows[0] if rows else None

    def write(self, sql, ops=False):
        return self.call(sql, ops=ops).strip()


db = Database()


def key():
    location = ROOT / 'data/local/session.key'
    location.parent.mkdir(parents=True, exist_ok=True)
    try:
        fd = os.open(location, os.O_WRONLY|os.O_CREAT|os.O_EXCL, 0o600)
    except FileExistsError: pass
    else:
        with os.fdopen(fd,'w') as f: f.write(secrets.token_hex(32))
    return location.read_bytes()


def cookie(user):
    payload = base64.urlsafe_b64encode(json.dumps({'user':user,'exp':time.time()+43200}).encode()).decode()
    return payload+'.'+hmac.new(key(),payload.encode(),hashlib.sha256).hexdigest()


def native_session(request):
    """Verify the existing HUSTOJ session; never accept client-declared identity."""
    name = os.environ.get('COURSE_HUSTOJ_COOKIE', 'PHPSESSID')
    sid = request.cookies.get(name)
    if sid is None:
        return None
    if not re.fullmatch(r'[A-Za-z0-9,-]{16,256}', sid):
        raise HTTPException(401, 'HUSTOJ 登录已失效，请重新登录')
    endpoint = os.environ.get('COURSE_HUSTOJ_SESSION_URL', 'http://127.0.0.1:8080/course.php?mode=session')
    try:
        with httpx.Client(timeout=5, trust_env=False, follow_redirects=False) as client:
            response = client.get(endpoint, cookies={name: sid})
        if response.status_code == 401:
            raise HTTPException(401, '请先登录 HUSTOJ')
        if response.status_code != 200 or len(response.content) > 8192:
            raise ValueError('invalid session response')
        data = response.json()
        if (not isinstance(data, dict) or data.get('authSource') != 'hustoj'
                or not isinstance(data.get('user'), str)
                or not 1 <= len(data['user']) <= 64
                or any(ord(c) < 32 for c in data['user'])):
            raise ValueError('invalid session identity')
    except (httpx.HTTPError, ValueError, TypeError):
        raise HTTPException(503, 'HUSTOJ 身份服务暂时不可用')
    return {'user': data['user'], 'authSource': 'hustoj'}


def principal(request):
    cached = getattr(request.state, 'course_identity', None)
    if cached:
        return cached['user']
    # 优先支持统一身份认证 (SSO) 反向代理头（如学校 CAS / SAML / Keycloak 通过 Nginx 注入）
    sso_header = os.environ.get('COURSE_SSO_HEADER', 'X-Remote-User')
    sso_user = request.headers.get(sso_header)
    if sso_user and sso_user.strip():
        u = sso_user.strip()
        if re.fullmatch(r'[A-Za-z0-9_.-]{1,64}', u):
            identity = {'user': u, 'authSource': 'sso'}
            request.state.course_identity = identity
            return u
    identity = native_session(request)
    if identity:
        request.state.course_identity = identity
        return identity['user']
    if os.environ.get('COURSE_DEV_LOGIN') != '1':
        raise HTTPException(401, '请先登录 HUSTOJ')
    try:
        payload, sig = request.cookies.get('course_session','').split('.')
        if not hmac.compare_digest(sig,hmac.new(key(),payload.encode(),hashlib.sha256).hexdigest()): raise ValueError()
        decoded = json.loads(base64.urlsafe_b64decode(payload))
        if decoded['exp'] < time.time(): raise ValueError()
        if not is_allowed_dev_user(decoded['user']): raise ValueError()
        request.state.course_identity = {'user': decoded['user'], 'authSource': 'development'}
        return decoded['user']
    except (ValueError, KeyError, TypeError): raise HTTPException(401,'请先登录课程平台')


@app.middleware('http')
async def request_guard(request, call_next):
    if request.method not in ('GET','HEAD','OPTIONS'):
        origin = request.headers.get('origin')
        allowed_origins = {value.strip() for value in os.environ.get(
            'COURSE_ALLOWED_ORIGINS', 'http://localhost:3100,http://127.0.0.1:3100').split(',') if value.strip()}
        # CSRF origin checking does not replace authentication, including for clients without Origin.
        if origin and origin not in allowed_origins:
            return Response('跨站请求被拒绝',403)
        if int(request.headers.get('content-length','0')) > 1048576:
            return Response('文件不能超过 1MB',413)
    response = await call_next(request)
    response.headers['Cache-Control']='no-store'
    return response


def offering_access(user, oid, teacher=False, write=False):
    """单一权限闸：无成员资格 404，成员但教师权限不足 403，历史（archived）教学班写操作 409。"""
    row = db.one(f"SELECT o.*, e.role FROM cm_offering o LEFT JOIN cm_enrollment e ON e.offering_id=o.offering_id AND e.user_id={q(user)} AND e.status='active' WHERE o.offering_id={int(oid)}")
    if not row or (row['teacher_id'] != user and not row['role'] and user != 'admin'): raise HTTPException(404,'教学班不存在或不可访问')
    role = 'teacher' if (row['teacher_id']==user or user == 'admin') else row['role']
    if teacher and role!='teacher': raise HTTPException(403,'只有本教学班教师可以操作')
    if write and row['status']=='archived': raise HTTPException(409,'历史教学班为只读，不能修改、发布或提交')
    row['role']=role
    return row


def batch_access(user, bid, teacher=False, write=False):
    b = db.one(f'SELECT * FROM cm_batch WHERE batch_id={int(bid)}')
    if not b: raise HTTPException(404,'题单不存在')
    off = offering_access(user,b['offering_id'],teacher,write=write)
    if off['role']=='student' and (b['status']=='draft' or (b['open_at'] and b['open_at'] > time.strftime('%Y-%m-%d %H:%M:%S'))):
        raise HTTPException(404,'题单尚未开放')
    return b,off


@app.get('/api/health')
def health():
    return {'ok':True,'devLogin':os.environ.get('COURSE_DEV_LOGIN')=='1',
            'ssoConfigured':bool(os.environ.get('COURSE_SSO_HEADER')),
            'ssoHeader':os.environ.get('COURSE_SSO_HEADER','X-Remote-User'),
            'aiConfigured':bool(os.environ.get('COURSE_AI_URL')),
            'loginUrl':'/oj/loginpage.php','logoutUrl':'/oj/logout.php','hustojUrl':'/oj/course.php'}


@app.get('/api/demo/users')
def demo_users():
    teaching_rows = db.rows("""SELECT DISTINCT o.teacher_id, c.code, c.name
        FROM cm_offering o
        JOIN cm_course c USING(course_id)
        WHERE o.status = 'active'
        ORDER BY c.code""")
    teacher_map = {}
    for r in teaching_rows:
        tid = r['teacher_id']
        if tid not in teacher_map:
            teacher_map[tid] = []
        teacher_map[tid].append(f"{r['code']} {r['name']}")
    
    teachers = [
        {'userId': tid, 'desc': '当前授课: ' + ' / '.join(courses)}
        for tid, courses in teacher_map.items()
    ]
    if not any(t['userId'] == 'admin' for t in teachers):
        teachers.append({'userId': 'admin', 'desc': '系统管理员（全校课程统览）'})
    
    student_rows = db.rows("""SELECT DISTINCT e.user_id, e.student_no, c.code
        FROM cm_enrollment e
        JOIN cm_offering o USING(offering_id)
        JOIN cm_course c USING(course_id)
        WHERE e.status = 'active' AND e.role = 'student'
        ORDER BY e.user_id""")
    student_map = {}
    for r in student_rows:
        uid = r['user_id']
        if uid not in student_map:
            student_map[uid] = {'studentNo': r.get('student_no') or uid, 'courses': []}
        student_map[uid]['courses'].append(r['code'])
    
    students = [
        {'userId': uid, 'studentNo': info['studentNo'], 'desc': '当前选修: ' + ', '.join(info['courses'])}
        for uid, info in student_map.items()
    ]
    if not students:
        students = [{'userId': 'cm_pilot_student', 'studentNo': '2026001', 'desc': '体验学生'}]

    return {
        'teachers': teachers,
        'students': students,
        'defaultUsers': DEV_USERS,
        'ssoSupport': {
            'enabled': bool(os.environ.get('COURSE_SSO_HEADER')),
            'header': os.environ.get('COURSE_SSO_HEADER', 'X-Remote-User'),
            'roleHeader': os.environ.get('COURSE_SSO_ROLE_HEADER', 'X-Remote-Role'),
        }
    }


@app.post('/api/session')
def login(data:dict, response:Response):
    if os.environ.get('COURSE_DEV_LOGIN')!='1': raise HTTPException(403,'开发登录已关闭，请接入学校身份认证')
    user = data.get('userId') or DEV_USERS.get(data.get('role'))
    if not user or not is_allowed_dev_user(user):
        raise HTTPException(400, '未知测试身份或用户不存在')
    response.set_cookie('course_session',cookie(user),httponly=True,samesite='strict',max_age=43200)
    # Explicitly choosing a development identity must not reuse a native session.
    response.delete_cookie(os.environ.get('COURSE_HUSTOJ_COOKIE', 'PHPSESSID'))
    return {'user':user}


@app.delete('/api/session')
def logout(response:Response):
    # Preserve PHPSESSID until HUSTOJ's logout endpoint destroys its server session.
    response.delete_cookie('course_session')
    return {'ok':True, 'logoutUrl':'/oj/logout.php'}


@app.get('/api/me')
def me(request:Request):
    user=principal(request)
    # Portal selection is derived from persisted authority, never request flags.
    # This selects a workspace only; offering_access still authorizes every course.
    assigned = db.rows(f"""SELECT 'teacher' AS role FROM jol.privilege
        WHERE user_id={q(user)} AND rightstr IN ('teacher', 'administrator')
        UNION SELECT 'teacher' AS role FROM cm_offering WHERE teacher_id={q(user)}
        UNION SELECT role FROM cm_enrollment WHERE user_id={q(user)} AND status='active'""")
    roles = sorted({row['role'] for row in assigned
                    if row.get('role') in ('student', 'teacher', 'ta')}) or ['student']
    if user == 'admin':
        roles = ['admin', 'teacher']
    portal = 'teacher' if any(role in roles for role in ('teacher', 'ta', 'admin')) else 'student'
    return {'user':user,'devLogin':os.environ.get('COURSE_DEV_LOGIN')=='1',
            'authSource':request.state.course_identity['authSource'],
            'roles':roles, 'portal':portal, 'home':'/'+portal}


@app.get('/api/courses')
def courses(request:Request):
    user=principal(request)
    if user == 'admin':
        return db.rows("SELECT c.*,o.offering_id,o.term,o.section,o.status,o.teacher_id,'teacher' AS role FROM cm_course c JOIN cm_offering o ON o.course_id=c.course_id ORDER BY o.term DESC,c.code")
    return db.rows(f"SELECT c.*,o.offering_id,o.term,o.section,o.status,o.teacher_id,CASE WHEN o.teacher_id={q(user)} THEN 'teacher' ELSE e.role END role FROM cm_course c JOIN cm_offering o ON o.course_id=c.course_id LEFT JOIN cm_enrollment e ON e.offering_id=o.offering_id AND e.user_id={q(user)} AND e.status='active' WHERE o.teacher_id={q(user)} OR e.user_id={q(user)} ORDER BY o.term DESC,c.code")


@app.get('/api/offerings/{oid}')
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


def find_user_previous_ac(user: str, problem_row: dict, allowed_languages: list[str] = None) -> dict | None:
    if not user or not problem_row:
        return None
    if isinstance(problem_row, list):
        problem_row = problem_row[0] if problem_row else {}
    source = str(problem_row.get('source') or '').strip()
    title = str(problem_row.get('title') or '').strip()
    pid = int(problem_row.get('problem_id') or 0)
    if pid <= 0:
        return None

    slug = None
    if source.startswith('codemind:authoring/'):
        slug = source.split('/')[-1]
    elif source.startswith('bank:'):
        slug = source[len('bank:'):]

    match_conds = [f"p.problem_id = {pid}"]
    if slug:
        match_conds.append(f"p.source = {q(f'bank:{slug}')}")
        match_conds.append(f"p.source LIKE {q(f'%/{slug}')}")
    if title:
        match_conds.append(f"p.title = {q(title)}")

    or_clause = " OR ".join(match_conds)
    sql = f"""
        SELECT s.solution_id, s.problem_id, s.language, s.time, s.memory, s.in_date, sc.source as code
        FROM jol.solution s
        JOIN jol.source_code sc ON sc.solution_id = s.solution_id
        JOIN jol.problem p ON p.problem_id = s.problem_id
        WHERE s.user_id = {q(user)}
          AND s.result = 4
          AND ({or_clause})
        ORDER BY s.solution_id DESC
        LIMIT 10
    """
    rows = db.rows(sql)
    if not rows:
        return None

    rev_langs = {v: k for k, v in LANGUAGES.items()}
    parsed = []
    for r in rows:
        lang_int = int(r.get('language') or 0)
        lang_key = rev_langs.get(lang_int, 'cpp' if lang_int == 1 else 'c')
        lang_name = LANG_NAMES.get(lang_int, lang_key.upper())
        code = r.get('code') or ''
        if lang_key == 'python' and code.startswith('# coding=utf-8\n'):
            code = code[len('# coding=utf-8\n'):]
        is_allowed = True
        if allowed_languages and len(allowed_languages) > 0:
            is_allowed = (lang_key in allowed_languages)
        parsed.append({
            'hasPreviousAc': True,
            'solutionId': int(r['solution_id']),
            'language': lang_key,
            'languageName': lang_name,
            'code': code,
            'time': int(r.get('time') or 0),
            'memory': int(r.get('memory') or 0),
            'inDate': str(r.get('in_date') or ''),
            'isLanguageAllowed': is_allowed
        })

    allowed_rows = [item for item in parsed if item['isLanguageAllowed']]
    return allowed_rows[0] if allowed_rows else parsed[0]


@app.get('/api/batches/{bid}')
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


@app.get('/api/batches/{bid}/problems/{pid}')
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


@app.post('/api/batches/{bid}/problems/{pid}/submissions')
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


@app.get('/api/submissions/{sid}')
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


def trial_token(sid, bid, pid, user):
    payload = base64.urlsafe_b64encode(json.dumps({
        'sid':sid, 'bid':bid, 'pid':pid, 'user':user, 'exp':int(time.time())+3600,
    }, separators=(',', ':')).encode()).decode().rstrip('=')
    signature = hmac.new(key(), ('trial:'+payload).encode(), hashlib.sha256).hexdigest()
    return payload+'.'+signature


def read_trial_token(token, user):
    try:
        if len(token)>2048: raise ValueError()
        payload, signature = token.split('.')
        expected = hmac.new(key(), ('trial:'+payload).encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(signature, expected): raise ValueError()
        data = json.loads(base64.urlsafe_b64decode(payload+'='*(-len(payload)%4)))
        if (data['user']!=user or type(data['exp']) is not int or data['exp']<=time.time()
                or any(type(data[k]) is not int or data[k]<=0 for k in ('sid','bid','pid'))):
            raise ValueError()
        return data
    except (ValueError, TypeError, KeyError, UnicodeError):
        raise HTTPException(404, '自测记录不存在或已过期')


@app.post('/api/batches/{bid}/problems/{pid}/trials')
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


@app.get('/api/trials/{run_id}')
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


def ai_config():
    """模型服务配置的只读入口：题单生成与学习建议共用同一口径。"""
    return (os.environ.get('COURSE_AI_URL'), os.environ.get('COURSE_AI_MODEL'), os.environ.get('COURSE_AI_KEY'))


def ai_timeout():
    try:
        return max(1.0, min(60.0, float(os.environ.get('COURSE_AI_TIMEOUT', '20'))))
    except ValueError:
        return 20.0


def clip(text, limit):
    """按字符截断文本（用于题面等短文本）；非字符串一律视为空。"""
    if not isinstance(text, str):
        return ''
    return text if len(text) <= limit else text[:limit] + '……（已截断）'


def clip_bytes(text, limit):
    """按 UTF-8 字节截断（用于源码大字段），不会切出半个多字节字符。"""
    if not isinstance(text, str):
        return ''
    raw = text.encode('utf-8')
    if len(raw) <= limit:
        return text
    return raw[:limit].decode('utf-8', 'ignore') + '……（已截断）'


def error_text(row):
    """db 的 XML 行形如 {'error': 文本}；取出其中的字符串，其余一律忽略。"""
    if isinstance(row, dict):
        row = row.get('error')
    return row if isinstance(row, str) else ''


HINT_LEVEL_GUIDE = {1: '只给方向性提示，不点具体行号', 2: '指出可疑的结构或边界，可引用判题错误信息', 3: '给出接近可操作的定位，但仍不得提供完整解答'}
RULES_HINTS = {6: ['对照输入约束检查边界值。', '选取最小规模与最大规模，手动跟踪关键变量。', '把实际输出和预期输出逐行比较，定位第一个不同的位置。'],
               11: ['先定位编译器给出的第一条错误。', '检查该行之前的括号、类型声明和作用域。', '逐步缩小报错片段，修复后重新提交。'],
               7: ['检查循环是否可以结束。', '估算输入规模与循环次数的关系。', '查找是否重复计算了相同的中间结果。']}
RULES_FALLBACK = ['先读取判题结果与错误信息。', '使用题目样例复现并记录中间状态。', '一次只修改一个假设，再用新的提交验证。']


def analysis_hint(problem_row, code, judge, level):
    """调用已配置的模型服务生成一条学习建议。返回 (建议文本, 失败原因)；失败原因非空表示应降级为规则建议。

    只发送当前这一次已授权的提交：公开题面字段、学生本人代码、服务端判题事实与提示级别。
    - 隐藏测试从不进入请求（服务端不读取判题目录，数据库里也没有隐藏测试）。
    - 运行时错误可能回显隐藏输入/输出，因此只发送编译信息（compileError），不外发 runtimeinfo 原文。
    - 代码按 UTF-8 字节限长，题面按字符限长。
    """
    endpoint, model, token = ai_config()
    if not endpoint or not model:
        return None, 'not_configured'
    case = {
        'level': level,
        'levelGuide': HINT_LEVEL_GUIDE[level],
        'problem': {'title': clip(problem_row.get('title'), 200),
                    'statement': clip(problem_row.get('description'), 4000),
                    'input': clip(problem_row.get('input'), 1000),
                    'output': clip(problem_row.get('output'), 1000),
                    'sampleInput': clip(problem_row.get('sample_input'), 1000),
                    'sampleOutput': clip(problem_row.get('sample_output'), 1000)},
        'judge': {'resultCode': int(judge['result']), 'resultLabel': judge['label'],
                  'timeMs': judge.get('time'), 'memoryKb': judge.get('memory'),
                  'compileError': clip(judge.get('compileError'), 2000)},
        'language': judge.get('language'),
        'code': clip_bytes(code, 8000)}
    payload = {
        'model': model,
        'temperature': 0.2,
        'messages': [
            {'role': 'system', 'content': '你是编程课助教。只依据给定事实写 1 条中文学习建议，不超过 300 字。'
                                         '不得改写、质疑或猜测判题结果，不得声称看到隐藏测试或外部资料，'
                                         '不得给出可直接提交的完整解答。'},
            {'role': 'user', 'content': json.dumps(case, ensure_ascii=False)}]}
    try:
        with httpx.Client(timeout=ai_timeout(), trust_env=False, follow_redirects=False) as client:
            response = client.post(endpoint.rstrip('/') + '/chat/completions',
                                   headers={'Authorization': 'Bearer ' + (token or '')}, json=payload)
        if response.status_code != 200:
            return None, 'model_unavailable'
        content = response.json()['choices'][0]['message']['content']
    except (httpx.HTTPError, ValueError, KeyError, IndexError, TypeError):
        return None, 'model_unavailable'
    if not isinstance(content, str):        # dict / list / int 等一律视为无效返回，绝不能抛 500
        return None, 'invalid_response'
    text = content.strip()
    if not text or len(text) > 1200:
        return None, 'invalid_response'
    return text, None


@app.get('/api/submissions/{sid}/analysis')
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


@app.get('/api/offerings/{oid}/insights')
def insights(oid:int,request:Request):
    user=principal(request); off=offering_access(user,oid)
    if off['role'] not in ('teacher','ta'): raise HTTPException(403,'仅任课教师与助教可查看班级学情')
    rows=db.rows(f"SELECT e.user_id,COUNT(DISTINCT CASE WHEN s.result=4 THEN s.problem_id END) passed,COUNT(s.solution_id) attempts,MAX(s.in_date) last_active FROM cm_enrollment e LEFT JOIN cm_submission cs ON cs.offering_id=e.offering_id AND cs.user_id=e.user_id LEFT JOIN jol.solution s ON s.solution_id=cs.submission_id WHERE e.offering_id={oid} AND e.role='student' AND e.status='active' GROUP BY e.user_id")
    clusters=db.rows(f'SELECT s.result,COUNT(*) count FROM cm_submission cs JOIN jol.solution s ON s.solution_id=cs.submission_id WHERE cs.offering_id={oid} GROUP BY s.result')
    for c in clusters: c['label']=RESULTS.get(int(c['result']),'其他结果')
    return {'students':rows,'results':clusters,'offering':off,'source':'HUSTOJ 实际提交，按结果码统计'}


@app.get('/api/offerings/{oid}/students')
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


@app.post('/api/offerings/{oid}/students')
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


@app.delete('/api/offerings/{oid}/students/{uid}')
def drop_offering_student(oid:int, uid:str, request:Request):
    user = principal(request)
    offering_access(user, oid, teacher=True, write=True)
    if not re.fullmatch(r'[A-Za-z0-9_.-]{1,48}', uid):
        raise HTTPException(400, '用户标识不合法')
    db.write(f"UPDATE cm_enrollment SET status='dropped', updated_at=NOW() WHERE offering_id={oid} AND user_id={q(uid)}")
    return {'ok': True}


@app.post('/api/courses/{cid}/offerings')
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


@app.patch('/api/offerings/{oid}')
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


def validate_document(doc):
    if not isinstance(doc,dict): raise HTTPException(422,'题单须为对象')
    if 'read_only' in doc and not isinstance(doc['read_only'],bool): raise HTTPException(422,'read_only 必须为布尔值')
    if doc.get('source_ref') is not None and (not isinstance(doc['source_ref'],str) or len(doc['source_ref'])>255):
        raise HTTPException(422,'source_ref 必须是不超过 255 字符的字符串')
    if doc.get('allowed_languages') is not None and (not isinstance(doc['allowed_languages'],str) or len(doc['allowed_languages'])>64):
        raise HTTPException(422,'allowed_languages 必须是不超过 64 字符的字符串')
    if not isinstance(doc.get('title'),str) or not doc['title'].strip(): raise HTTPException(422,'请填写题单标题')
    problems=doc.get('problems')
    if not isinstance(problems,list) or not 1<=len(problems)<=100: raise HTTPException(422,'每个题单需要 1–100 道题')
    slugs=set()
    for p in problems:
        if not isinstance(p,dict) or not all(isinstance(p.get(k),str) and p[k].strip() for k in ('slug','title','statement')): raise HTTPException(422,'每题须有 slug、标题和题面')
        if not re.fullmatch(r'[a-zA-Z0-9_-]{1,64}',p['slug']) or p['slug'] in slugs: raise HTTPException(422,'题目 slug 不合法或重复')
        slugs.add(p['slug'])
        for kind in ('samples','tests'):
            samples=p.get(kind,[])
            if not isinstance(samples,list) or len(samples)>100: raise HTTPException(422,'样例或测试数据格式错误')
            for sample in samples:
                if not isinstance(sample,dict) or any(not isinstance(sample.get(k),str) for k in ('input','output')): raise HTTPException(422,'样例和测试须包含文本 input/output')
        if not p.get('samples'): raise HTTPException(422,'每题至少提供一个样例')
    return doc


def parse_document(content):
    if not isinstance(content,str) or len(content.encode())>1048576: raise HTTPException(422,'题单文件过大')
    try:
        if content.lstrip().startswith('<'):
            if re.search(r'<!DOCTYPE|<!ENTITY',content,re.I): raise ValueError('XML 不允许 DTD 或实体')
            root=ET.fromstring(content)
            ps=[]
            for i,item in enumerate(root.findall('item')):
                ins=item.findall('test_input'); outs=item.findall('test_output')
                if len(ins)!=len(outs): raise ValueError('测试输入输出数量不一致')
                ps.append({'slug':f'fps-{i+1}','title':item.findtext('title',''),'statement':item.findtext('description','')+'\n'+item.findtext('input','')+'\n'+item.findtext('output',''),'samples':[{'input':item.findtext('sample_input',''),'output':item.findtext('sample_output','')}],'tests':[{'input':a.text or '', 'output':b.text or ''} for a,b in zip(ins,outs)]})
            doc={'title':'导入的 FPS 题单','problems':ps}
        else: doc=yaml_load(content)
    except (ValueError,yaml.YAMLError,ET.ParseError): raise HTTPException(422,'无法解析题单，请检查 YAML / JSON / FPS XML 格式')
    return validate_document(doc)


@app.get('/api/offerings/{oid}/drafts')
def drafts(oid:int,request:Request):
    offering_access(principal(request),oid,True)
    return db.rows(f'SELECT draft_id,title,status,origin,updated_at FROM cm_authoring_draft WHERE offering_id={oid} ORDER BY updated_at DESC')


@app.post('/api/offerings/{oid}/drafts')
def save_draft(oid:int,data:dict,request:Request):
    user=principal(request); offering_access(user,oid,True,write=True)
    doc=parse_document(data['content']) if 'content' in data else validate_document(data.get('document'))
    ident=uuid.uuid4().hex
    db.write(f"INSERT INTO cm_authoring_draft(draft_id,offering_id,owner_id,title,payload,status,origin,updated_at) VALUES({q(ident)},{oid},{q(user)},{q(doc['title'])},{q(json.dumps(doc,ensure_ascii=False))},'draft','teacher',NOW())")
    return {'id':ident,'document':doc,'status':'draft'}


def get_draft(ident,user,write=False):
    row=db.one(f'SELECT * FROM cm_authoring_draft WHERE draft_id={q(ident)}')
    if not row: raise HTTPException(404,'草稿不存在')
    offering_access(user,row['offering_id'],True,write=write)
    row['document']=json.loads(row.pop('payload'))
    return row


@app.get('/api/drafts/{ident}')
def draft(ident:str,request:Request): return get_draft(ident,principal(request))


@app.put('/api/drafts/{ident}')
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


@app.delete('/api/drafts/{ident}')
def delete_draft(ident: str, request: Request):
    user = principal(request)
    row = get_draft(ident, user, write=True)
    if row['status'] == 'published':
        raise HTTPException(409, '已发布的题单不可直接从题库删除，请在班级作业中管理')
    db.write(f"DELETE FROM cm_authoring_draft WHERE draft_id={q(ident)}")
    return {'ok': True}


def check_teacher(user: str):
    if user == 'admin':
        return
    rows = db.rows(f"""SELECT 1 FROM jol.privilege WHERE user_id={q(user)} AND rightstr IN ('teacher', 'administrator')
                       UNION SELECT 1 FROM cm_offering WHERE teacher_id={q(user)} LIMIT 1""")
    if not rows:
        raise HTTPException(403, '只有教师身份可以访问此功能')


def get_teacher_primary_offering(user: str) -> int:
    row = db.one(f"""SELECT o.offering_id FROM cm_offering o 
                     WHERE (o.teacher_id={q(user)} OR {q(user)}='admin') AND o.status='active' 
                     ORDER BY o.term DESC LIMIT 1""")
    if row:
        return int(row['offering_id'])
    row2 = db.one("SELECT offering_id FROM cm_offering ORDER BY offering_id DESC LIMIT 1")
    if row2:
        return int(row2['offering_id'])
    raise HTTPException(400, '暂无可用教学班，请先开设或分配教学班')


@app.get('/api/teacher/library')
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


@app.post('/api/teacher/library/sets')
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


@app.post('/api/teacher/library/deploy')
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


@app.post('/api/offerings/{oid}/generate')
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


PROBLEM_SETS_CACHE = None

def get_problem_sets_index():
    global PROBLEM_SETS_CACHE
    if PROBLEM_SETS_CACHE is not None:
        return PROBLEM_SETS_CACHE
    
    ps_dir = ROOT / 'data' / 'problem_sets'
    catalog_file = ps_dir / 'index' / 'catalog.json'
    categories_dir = ps_dir / 'problems' / 'categories'
    
    categories = []
    category_map = {}
    
    catalog = []
    if catalog_file.is_file():
        try:
            with open(catalog_file, 'r', encoding='utf-8') as f:
                catalog = json.load(f)
        except Exception:
            catalog = []
            
    cat_problems = defaultdict(list)
    for p in catalog:
        cat_problems[p['category_id']].append(p)
        
    for cat_file in sorted(categories_dir.glob('*.yml')):
        stem = cat_file.stem
        ps = cat_problems.get(stem, [])
        cat_name = ps[0]['category_name'] if ps else stem
        tags = ps[0].get('tags', [cat_name]) if ps else [stem]
        diff_counter = Counter(p.get('difficulty', '')[:2] for p in ps if p.get('difficulty'))
        
        preview_problems = []
        for p in ps:
            preview_problems.append({
                'slug': p['slug'],
                'title': p['title'],
                'difficulty': p.get('difficulty', 'L1-入门'),
                'tags': p.get('tags', []),
                'knowledge': p.get('knowledge', []),
                'provenance': p.get('provenance', ''),
                'statement': p.get('statement', ''),
                'samples': p.get('samples', [])
            })
            
        cat_info = {
            'id': f'cat:{stem}',
            'kind': 'category',
            'code': stem,
            'title': f'{stem} · {cat_name}',
            'categoryName': cat_name,
            'tags': tags,
            'count': len(ps),
            'difficultyCount': dict(diff_counter),
            'problems': preview_problems
        }
        categories.append(cat_info)
        category_map[stem] = cat_info
        
    standalone_sets = []
    for sfile in sorted(ps_dir.glob('*.yml')):
        stem = sfile.stem
        try:
            with open(sfile, 'r', encoding='utf-8') as f:
                doc = yaml_load(f) or {}
            ps = doc.get('problems', [])
            preview_problems = []
            for p in ps:
                preview_problems.append({
                    'slug': p.get('slug', ''),
                    'title': p.get('title', ''),
                    'difficulty': p.get('difficulty', 'medium'),
                    'tags': p.get('tags', []),
                    'knowledge': p.get('knowledge', []),
                    'provenance': p.get('provenance', ''),
                    'statement': p.get('statement', ''),
                    'samples': p.get('samples', [])
                })
            standalone_sets.append({
                'id': f'set:{stem}',
                'kind': 'set',
                'code': stem,
                'title': doc.get('title', stem),
                'course': doc.get('course', ''),
                'count': len(ps),
                'problems': preview_problems
            })
        except Exception:
            pass

    PROBLEM_SETS_CACHE = {
        'categories': categories,
        'category_map': category_map,
        'standalone_sets': standalone_sets
    }
    return PROBLEM_SETS_CACHE


@app.get('/api/offerings/{oid}/problem-sets')
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


TAXONOMY = [
    {
        'id': 'p1-basics',
        'name': '1. 基础与语言入门',
        'icon': '🌱',
        'description': 'C/C++ 语法规范、分支与循环结构、基础函数与模块化设计',
        'children': [
            {
                'id': 'g1-syntax',
                'name': '语言与基本语法',
                'codes': ['01-basic-io', '08-functions', '10-struct-pointer', 'DFBY-P05']
            },
            {
                'id': 'g1-branch',
                'name': '顺序与分支结构',
                'codes': ['02-branching', 'DFBY-P01']
            },
            {
                'id': 'g1-loop',
                'name': '循环与多重迭代',
                'codes': ['03-loops', '04-nested-loops', 'DFBY-P02']
            }
        ]
    },
    {
        'id': 'p2-structures',
        'name': '2. 核心数据结构',
        'icon': '🧱',
        'description': '线性表、数组矩阵、栈队列、二叉树与并查集等存储结构',
        'children': [
            {
                'id': 'g2-linear',
                'name': '线性表、数组与字符串',
                'codes': ['05-array-1d', '06-array-2d', '07-strings', '13-linear-list', 'DFBY-P03', 'DFBY-P04']
            },
            {
                'id': 'g2-stack-queue',
                'name': '栈、队列与单调结构',
                'codes': ['14-stack-queue']
            },
            {
                'id': 'g2-trees',
                'name': '树形结构与并查集',
                'codes': ['15-binary-tree', '16-heap-priority', '17-dsu']
            }
        ]
    },
    {
        'id': 'p3-algorithms',
        'name': '3. 算法思想与进阶',
        'icon': '⚡',
        'description': '排序二分、递归分治、搜索回溯、贪心动态规划与图论体系',
        'children': [
            {
                'id': 'g3-sorting-search',
                'name': '排序与高效检索',
                'codes': ['11-sorting', '12-binary-search']
            },
            {
                'id': 'g3-recursion-search',
                'name': '递归分治与搜索回溯',
                'codes': ['09-recursion-divide', '19-dfs-backtracking', 'LUOGU-T03']
            },
            {
                'id': 'g3-greedy',
                'name': '经典贪心策略',
                'codes': ['18-greedy', 'LUOGU-T04', 'YBT-ADV-S01']
            },
            {
                'id': 'g3-dp',
                'name': '动态规划模型',
                'codes': ['20-dp-knapsack', '21-dp-linear-interval', 'LUOGU-T01', 'YBT-ADV-S03']
            },
            {
                'id': 'g3-graphs',
                'name': '图论核心算法',
                'codes': ['22-graph-shortest', '23-graph-mst-topo', 'LUOGU-T02', 'YBT-ADV-S02']
            }
        ]
    },
    {
        'id': 'p4-math',
        'name': '4. 数学与数论专项',
        'icon': '🔢',
        'description': '经典数论素数筛法、高精度大数乘除与组合数学',
        'children': [
            {
                'id': 'g4-theory',
                'name': '初等数学与数论基础',
                'codes': ['24-number-theory', 'YBT-ADV-S05', 'YBT-ADV-S04']
            }
        ]
    },
    {
        'id': 'p5-contests',
        'name': '5. 竞赛真题与等级认证',
        'icon': '🏆',
        'description': '蓝桥杯真题、GESP 等级认证、USACO 实战与高校专业机试',
        'children': [
            {
                'id': 'g5-lanqiao',
                'name': '蓝桥杯历届真题精选',
                'codes': ['LANQIAO-B01', 'LANQIAO-B02', 'LANQIAO-B03', 'LANQIAO-B04', 'LANQIAO-B05', 'LANQIAO-B06']
            },
            {
                'id': 'g5-gesp',
                'name': 'CCF GESP 认证精选',
                'codes': ['GESP-G01']
            },
            {
                'id': 'g5-usaco',
                'name': 'USACO 国际竞赛实战',
                'codes': ['USACO-U01', 'USACO-U02']
            },
            {
                'id': 'g5-nowcoder',
                'name': '牛客大学专业机试',
                'codes': ['NOWCODER-N01']
            }
        ]
    }
]


@app.get('/api/problem-sets')
def get_all_problem_sets(request: Request):
    user = principal(request)
    return get_problem_sets_index()


@app.get('/api/problem-sets/tree')
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


@app.get('/api/problem-sets/my-status')
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


def resolve_set_file(set_id: str):
    ps_dir = ROOT / 'data' / 'problem_sets'
    if set_id.startswith(('cat:', 'category:')):
        code = set_id.split(':', 1)[1]
        target_path = ps_dir / 'problems' / 'categories' / f'{code}.yml'
    elif set_id.startswith('set:'):
        code = set_id.split(':', 1)[1]
        target_path = ps_dir / f'{code}.yml'
    else:
        code = set_id
        target_path = ps_dir / f'{code}.yml'
        if not target_path.is_file():
            target_path = ps_dir / 'problems' / 'categories' / f'{code}.yml'
    return code, target_path


def find_problem_by_slug(slug: str):
    data = get_problem_sets_index()
    target_set_id = None
    for cat in data['categories']:
        for p in cat.get('problems', []):
            if p.get('slug') == slug:
                target_set_id = cat['id']
                break
        if target_set_id:
            break
    if not target_set_id:
        for s in data['standalone_sets']:
            for p in s.get('problems', []):
                if p.get('slug') == slug:
                    target_set_id = s['id']
                    break
            if target_set_id:
                break
    if not target_set_id:
        return None
    code, path = resolve_set_file(target_set_id)
    if not path.is_file():
        return None
    with open(path, 'r', encoding='utf-8') as f:
        doc = yaml_load(f) or {}
    for p in doc.get('problems', []):
        if p.get('slug') == slug:
            prob = dict(p)
            prob['set_id'] = target_set_id
            prob['category_name'] = doc.get('title', code)
            return prob
    return None


def ensure_bank_problem(slug: str):
    source = f'bank:{slug}'
    existing = db.one(f"SELECT problem_id FROM jol.problem WHERE source={q(source)}")
    if existing:
        return int(existing['problem_id'])
    prob = find_problem_by_slug(slug)
    if not prob:
        return None
    title = str(prob.get('title') or slug).strip()
    statement = str(prob.get('statement') or '').strip()
    samples = prob.get('samples') or [{'input': '1\n', 'output': '1\n'}]
    sample_in = str(samples[0].get('input', '')) if samples else ''
    sample_out = str(samples[0].get('output', '')) if samples else ''
    tests = prob.get('tests') or samples
    hint = '、'.join(str(x) for x in (prob.get('tags', []) or prob.get('knowledge', [])) if x)
    sql = f"""
        INSERT INTO jol.problem(title, description, input, output, sample_input, sample_output, hint, source, in_date, defunct, time_limit, memory_limit)
        VALUES({q(title)}, {q(statement)}, '', '', {q(sample_in)}, {q(sample_out)}, {q(hint)}, {q(source)}, NOW(), 'N', 1, 128);
    """
    db.write(sql, ops=True)
    row = db.one(f"SELECT problem_id FROM jol.problem WHERE source={q(source)}")
    pid = int(row['problem_id'])
    try:
        write_test_files(pid, tests)
    except Exception:
        pass
    return pid


@app.post('/api/offerings/{oid}/import-set')
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


@app.post('/api/problem-sets/publish-to-offerings')
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


def write_test_files(pid,tests):
    """先清掉该题旧的编号测试点再整体重写，重试不会遗留多余测试。"""
    container=os.environ.get('COURSE_CONTAINER','hustoj')
    directory=f'/home/judge/data/{int(pid)}'
    try:
        subprocess.run(['docker','exec',container,'mkdir','-p',directory],check=True,timeout=10)
        subprocess.run(['docker','exec',container,'find',directory,'-maxdepth','1','-type','f',
                        '-regextype','posix-extended','-regex','.*/[0-9]+\\.(in|out)','-delete'],check=True,timeout=10)
        for n,test in enumerate(tests,1):
            for extension,field in [('in','input'),('out','output')]:
                target=f'{directory}/{n}.{extension}'
                subprocess.run(['docker','exec','-i',container,'tee',target],input=test[field],text=True,stdout=subprocess.DEVNULL,check=True,timeout=10)
    except (OSError,subprocess.SubprocessError):
        raise HTTPException(503,'测试点写入判题机失败，本次发布未放开可见，可安全重试')


@app.post('/api/drafts/{ident}/publish')
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


@app.patch('/api/batches/{bid}')
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


@app.post('/api/batches/{bid}/copy')
def copy_batch(bid:int,request:Request):
    b,off=batch_access(principal(request),bid,True,write=True)
    ps=db.rows(f'SELECT p.* FROM jol.problem p JOIN cm_batch_problem bp USING(problem_id) WHERE bp.batch_id={bid} ORDER BY bp.seq')
    doc={'title':b['title']+'（副本）','read_only':int(b['read_only'] or 0)==1,'source_ref':b['source_ref'] or None,
         'problems':[{'slug':f'problem-{p["problem_id"]}','title':p['title'],'statement':p['description'] or '', 'samples':[{'input':p['sample_input'] or '', 'output':p['sample_output'] or ''}],'tests':[]} for p in ps]}
    return save_draft(int(off['offering_id']),{'document':doc},request)


@app.post('/api/batches/{bid}/export')
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


# ---------------------------------------------------------------- 原生 HUSTOJ 核心功能迁移接口

@app.get('/api/status')
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


@app.get('/api/submissions/{sid}/code')
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


@app.get('/api/ranklist')
def get_ranklist(request: Request, offeringId: int = None, page: int = 1, pageSize: int = 50):
    user = principal(request)
    limit = max(1, min(pageSize, 100))
    offset = (max(1, page) - 1) * limit

    if offeringId is not None and offeringId > 0:
        offering_access(user, int(offeringId))
        sql = f"""
            SELECT e.user_id, COALESCE(u.nick, e.user_id) as nick,
                   COUNT(DISTINCT CASE WHEN s.result = 4 AND s.problem_id > 0 THEN s.problem_id END) as solved,
                   COUNT(CASE WHEN s.problem_id > 0 THEN s.solution_id END) as submit,
                   MAX(s.in_date) as last_submit
            FROM cm_enrollment e
            LEFT JOIN jol.users u ON u.user_id = e.user_id
            LEFT JOIN cm_submission cs ON cs.user_id = e.user_id AND cs.offering_id = {int(offeringId)}
            LEFT JOIN jol.solution s ON s.solution_id = cs.submission_id
            WHERE e.offering_id = {int(offeringId)} AND e.role = 'student' AND e.status = 'active'
            GROUP BY e.user_id, u.nick
            ORDER BY solved DESC, submit ASC, last_submit DESC
            LIMIT {limit} OFFSET {offset}
        """
        total_sql = f"SELECT COUNT(*) as n FROM cm_enrollment WHERE offering_id={int(offeringId)} AND role='student' AND status='active'"
    else:
        sql = f"""
            SELECT u.user_id, COALESCE(u.nick, u.user_id) as nick,
                   COUNT(DISTINCT CASE WHEN s.result = 4 AND s.problem_id > 0 THEN s.problem_id END) as solved,
                   COUNT(CASE WHEN s.problem_id > 0 THEN s.solution_id END) as submit,
                   MAX(s.in_date) as last_submit
            FROM jol.users u
            LEFT JOIN jol.solution s ON s.user_id = u.user_id
            WHERE u.defunct = 'N'
              AND u.user_id NOT IN ('admin')
              AND u.user_id NOT LIKE 'teacher_%'
              AND u.user_id NOT LIKE 'test_%'
              AND u.user_id NOT IN ('cm_pilot_teacher', 'cm_pilot_ta', 'cm_pilot_outsider')
              AND u.user_id NOT IN (SELECT DISTINCT user_id FROM jol.privilege WHERE rightstr IN ('administrator', 'teacher'))
            GROUP BY u.user_id, u.nick
            ORDER BY solved DESC, submit ASC, last_submit DESC
            LIMIT {limit} OFFSET {offset}
        """
        total_sql = """
            SELECT COUNT(*) as n FROM jol.users u
            WHERE u.defunct = 'N'
              AND u.user_id NOT IN ('admin')
              AND u.user_id NOT LIKE 'teacher_%'
              AND u.user_id NOT LIKE 'test_%'
              AND u.user_id NOT IN ('cm_pilot_teacher', 'cm_pilot_ta', 'cm_pilot_outsider')
              AND u.user_id NOT IN (SELECT DISTINCT user_id FROM jol.privilege WHERE rightstr IN ('administrator', 'teacher'))
        """

    rows = db.rows(sql)
    total_row = db.one(total_sql)
    total_count = int(total_row['n']) if total_row else 0

    my_rank = None
    for i, r in enumerate(rows):
        r['rank'] = offset + i + 1
        r['userId'] = r['user_id']
        solved = int(r.get('solved') or 0)
        submit = int(r.get('submit') or 0)
        r['solved'] = solved
        r['submit'] = submit
        r['passRate'] = round((solved / submit * 100), 1) if submit > 0 else 0.0
        r['lastSubmit'] = str(r.get('last_submit') or '')
        if r['user_id'] == user:
            my_rank = r['rank']

    return {
        'items': rows,
        'total': total_count,
        'page': page,
        'pageSize': limit,
        'myRank': my_rank
    }


@app.get('/api/public-problems')
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


@app.get('/api/public-problems/{pid}')
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


@app.post('/api/public-problems/{pid}/submissions')
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


@app.get('/api/faq')
def get_faq():
    return {
        'compilers': [
            {'lang': 'C', 'compiler': 'GCC 9.4+', 'command': 'gcc -O2 -Wall -std=c11 source.c -lm', 'timeLimit': '1.0s', 'memoryLimit': '128MB'},
            {'lang': 'C++', 'compiler': 'G++ 9.4+ / Clang', 'command': 'g++ -O2 -Wall -std=c++17 source.cpp -lm', 'timeLimit': '1.0s', 'memoryLimit': '128MB'},
            {'lang': 'Python', 'compiler': 'Python 3.9+', 'command': 'python3 -u source.py', 'timeLimit': '3.0s (x3倍)', 'memoryLimit': '256MB'},
            {'lang': 'Java', 'compiler': 'OpenJDK 17', 'command': 'javac -J-Xms32m -J-Xmx256m Main.java / java Main', 'timeLimit': '2.0s (x2倍)', 'memoryLimit': '256MB'}
        ],
        'verdicts': [
            {'code': 'AC', 'name': '正确 (Accepted)', 'color': 'ok', 'desc': '恭喜！程序在全部测试点均输出了正确结果，且时空消耗在限制范围内。'},
            {'code': 'WA', 'name': '答案错误 (Wrong Answer)', 'color': 'danger', 'desc': '程序输出的内容与预期标准输出不符，请检查算法逻辑或边界用例。'},
            {'code': 'TLE', 'name': '时间超限 (Time Limit Exceeded)', 'color': 'warn', 'desc': '程序运行耗时超过限制，通常是因为算法复杂度过高或存在死循环。'},
            {'code': 'MLE', 'name': '内存超限 (Memory Limit Exceeded)', 'color': 'warn', 'desc': '程序申请的内存空间超出上限，请检查大型数组开辟或递归深度。'},
            {'code': 'RE', 'name': '运行错误 (Runtime Error)', 'color': 'warn', 'desc': '程序运行时崩溃，常见原因有除零、数组越界、空指针解引用或栈溢出。'},
            {'code': 'CE', 'name': '编译错误 (Compile Error)', 'color': 'warn', 'desc': '源码未通过编译器编译，点击该条记录可查看编译器详细报错提示。'},
            {'code': 'PE', 'name': '格式错误 (Presentation Error)', 'color': 'neutral', 'desc': '输出结果仅在空格或换行等格式排版上与标准输出存在细微差异。'},
            {'code': 'OLE', 'name': '输出超限 (Output Limit Exceeded)', 'color': 'warn', 'desc': '程序打印了过多冗余信息（如调试输出漏删或死循环打印）。'}
        ],
        'ioTips': [
            {'title': '关于多组测试数据读取 (EOF)', 'desc': '题目未声明输入组数时通常以文件末尾 EOF 为结束标志。C/C++ 可用 while(scanf(...) != EOF) 或 while(cin >> x)；Python 可用 sys.stdin.read().split() 批量处理。'},
            {'title': 'I/O 性能优化', 'desc': '在 C++ 中处理大数据量时，建议在 main 函数头部加入 std::ios::sync_with_stdio(false); std::cin.tie(nullptr); 并尽量避免使用 std::endl。'},
            {'title': '避免冗余提示信息', 'desc': '提交代码中切勿包含“请输入：”等交互提示文字，判题机严格比对 stdout，任何多余字符均会导致 WA。'}
        ]
    }
