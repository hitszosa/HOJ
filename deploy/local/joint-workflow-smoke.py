#!/usr/bin/env python3
"""Check the UI-created joint workflow without re-seeding or changing its grades."""
import csv
import importlib.util
import io
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('platform_client', ROOT / 'deploy/local/admin-smoke.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
Client = module.Client


def main():
    checks = []
    def check(label, passed):
        assert passed, label
        checks.append(label)

    teacher, student, second, absent, admin = [Client() for _ in range(5)]
    account = json.loads((ROOT / '.local/admin-account.json').read_text())
    admin.login(account['username'], account['password'])
    for client, username, role in [(teacher, 'teacher_joint', 1), (student, '20260001', 0), (second, '20260002', 0), (absent, '20260003', 0)]:
        check(f'{username}: shared password login', client.login(username, username)[0] == 200)
        profile = client.ok('/management-api/auth/current_user')
        check(f'{username}: same management identity and role', profile['username'] == username and profile['role'] == role)
        check(f'{username}: linked local-password bypass rejected', client.request('/management-api/auth/login', 'POST', {'username':username,'password':username})[0] == 401)
    me = teacher.ok('/management-api/auth/current_user')
    course = teacher.ok('/management-api/courses/12')
    ids = course['students']
    check('Teacher created own course with exactly three students', course['title'] == 'C++联合测试班' and len(ids) == 3 and course['teachers'][0]['id'] == me['id'])
    check('Same course linked across modules', teacher.ok('/management-api/hoj/links') == [{'course_id':12,'offering_id':2}])
    native = teacher.ok('/api/offerings/2')['data']
    check('Programming roster contains exactly three students', native['total_students'] == 3)
    batch = teacher.ok('/api/batches/10')['data']
    check('Teacher-authored C++ experiment is published to own class', batch['batch']['offering_id'] == 2 and batch['batch']['status'] == 'published' and batch['batch']['allowed_languages'] == ['cpp'] and batch['batch']['ai_enabled'] is False)
    for sid, result in [(1047,6),(1048,11),(1049,4),(1050,6)]:
        check(f'Real judge submission {sid} result {result}', teacher.ok(f'/api/submissions/{sid}')['data']['result'] == result)
    code = teacher.ok('/api/submissions/1049/code')['data']
    check('Assigned teacher can inspect actual submitted source', 'long long a,b' in code['code'] and code['user_id'] == '20260001')
    status = teacher.ok('/api/status?offering_id=2')['data']
    check('Teacher code buttons match server permissions', status['total'] == 4 and all(item['can_view_code'] for item in status['items']))
    check('Student cannot read another student code', student.request('/api/submissions/1050/code')[0] == 403)
    check('Student cannot read another student judge diagnostics', second.request('/api/submissions/1049')[0] == 404)
    check('Student cannot view or export entire class grades', student.request('/api/offerings/2/grades')[0] == 403 and student.request('/api/offerings/2/grades/export')[0] == 403)
    new_user = {'username':'joint_denied','real_name':'越权测试','role':1,'password_expired':True}
    check('Teacher cannot create staff through management', teacher.request('/management-api/users','POST',new_user)[0] == 403)
    check('Teacher cannot create staff through programming adapter', teacher.request('/api/management/users','POST',new_user)[0] == 403)
    check('Student cannot create accounts', student.request('/management-api/users','POST',{**new_user,'role':0})[0] == 403)
    new_course = {'title':'不得创建的班级','year':2026,'term':2,'teacher_ids':[43],'student_ids':[],'assistant_ids':[]}
    check('Teacher cannot assign another teacher when creating a class', teacher.request('/management-api/courses','POST',new_course)[0] == 403)
    check('Student cannot open a class', student.request('/management-api/courses','POST',{**new_course,'teacher_ids':[]})[0] == 403)
    check('Teacher cannot alter responsible teachers', teacher.request('/management-api/courses/12','PATCH',{'teacher_ids':[43,me['id']]})[0] == 403)
    check('Teacher cannot alter course metadata', teacher.request('/management-api/courses/12','PATCH',{'title':'不得覆盖课程名称'})[0] == 403)
    check('Teacher cannot reset another account password', teacher.request('/management-api/users/change_password','POST',{'username':'20260001','password':'forbidden-change'})[0] == 403)
    check('Untrusted origin cannot provision users', teacher.request('/api/management/users','POST',{**new_user,'role':0},origin='https://untrusted.invalid')[0] == 403)
    check('Teacher cannot overwrite an existing account during import', teacher.request('/management-api/users/batch_create','POST',[{'username':'20260001','real_name':'不得覆盖','role':0,'password_expired':True}])[0] == 403)
    grades = teacher.ok('/api/offerings/2/grades')['data']
    check('AC, failed and absent students have correct experiment scores', [r['score'] for r in grades] == [100,0,0] and [r['attempts'] for r in grades] == [3,1,0] and len(grades) == 3)
    exported = teacher.ok('/api/offerings/2/grades/export')
    check('CSV includes UTF-8 BOM', exported.startswith(b'\xef\xbb\xbf'))
    rows = list(csv.DictReader(io.StringIO(exported.decode('utf-8-sig'))))
    downloaded = (ROOT/'.local/joint-test-student-grades.csv').read_bytes()
    check('Browser-downloaded CSV matches authenticated server export', downloaded == exported)
    check('CSV includes every roster member and distinguishes absent submissions', len(rows) == 3 and [r['状态'] for r in rows] == ['全部通过','未全部通过','未提交'] and [r['成绩（100分）'] for r in rows] == ['100','0','0'])
    report = {'passed':len(checks),'checks':checks,'course_id':12,'offering_id':2,'batch_id':10,'problem_id':1011,'submissions':[1047,1048,1049,1050],'grades':grades,'download':'Downloads/programming-grades-2.csv'}
    (ROOT/'.local/joint-test-result.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
    print(json.dumps({'passed':len(checks),'scores':[r['score'] for r in grades]},ensure_ascii=False))


if __name__ == '__main__':
    main()
