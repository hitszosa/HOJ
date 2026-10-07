#!/usr/bin/env python3
"""Exercise meeting-defined permission boundaries with isolated synthetic fixtures."""
import json
from pathlib import Path
from importlib.util import spec_from_file_location, module_from_spec

ROOT = Path(__file__).resolve().parents[2]
spec = spec_from_file_location('bridge_smoke', ROOT / 'deploy/local/management-smoke.py')
module = module_from_spec(spec)
spec.loader.exec_module(module)
Session = module.Session


def main():
    checks = []

    def check(name, condition):
        assert condition, name
        checks.append(name)

    teacher, assistant, student, admin = Session(), Session(), Session(), Session()
    me = teacher.login('teacher')
    assistant.login('ta')
    pupil = student.login('student')
    secret = json.loads((ROOT / '.local/management-secrets.json').read_text())
    admin.ok('/management-api/auth/login', 'POST', {'username': 'local_admin', 'password': secret['admin']})
    admin.ok('/management-api/auth/current_user')
    own_id = next(link['course_id'] for link in teacher.ok('/management-api/hoj/links') if link['offering_id'] == 1)
    own = teacher.ok(f'/management-api/courses/{own_id}')
    lookup = admin.ok('/management-api/users/user_batch_lookup', 'POST', {'usernames': ['meeting_probe_teacher_b'], 'ids': []})
    other = lookup['success'][0]['user'] if lookup['success'] else admin.ok('/management-api/users', 'POST', {
        'username': 'meeting_probe_teacher_b', 'real_name': 'Synthetic Teacher B', 'role': 1, 'password_expired': False})
    courses = admin.ok('/management-api/courses?all=true')
    foreign = next((c for c in courses if c['title'] == 'Meeting permission fixture B'), None)
    if not foreign:
        foreign = admin.ok('/management-api/courses', 'POST', {
            'title': 'Meeting permission fixture B', 'year': 2026, 'term': 2,
            'teacher_ids': [other['id']], 'student_ids': [pupil['id']], 'assistant_ids': []})
    fid = foreign['id']
    path = f'/management-api/courses/{fid}'
    check('Teacher can read existing foreign course', teacher.request(path)[0] == 200)
    check('Teacher cannot create courses', teacher.request('/management-api/courses', 'POST', {
        'title': 'Denied creation', 'teacher_ids': [me['id']], 'student_ids': [], 'assistant_ids': []})[0] == 403)
    check('Teacher cannot rename another course', teacher.request(path, 'PATCH', {'title': 'Denied rename'})[0] == 403)
    check('Teacher cannot add self to another course', teacher.request(path, 'PATCH', {'teacher_ids': [other['id'], me['id']]})[0] == 403)
    check('Teacher cannot replace another roster', teacher.request(path, 'PATCH', {'student_ids': []})[0] == 403)
    check('Teacher cannot delete another course', teacher.request(path, 'DELETE')[0] == 403)
    check('Teacher cannot rename own course configuration', teacher.request(f'/management-api/courses/{own_id}', 'PATCH', {'title': 'Denied rename'})[0] == 403)
    check('Teacher cannot change own teacher relationships', teacher.request(f'/management-api/courses/{own_id}', 'PATCH', {'teacher_ids': [me['id']]})[0] == 403)
    check('Teacher cannot delete own course', teacher.request(f'/management-api/courses/{own_id}', 'DELETE')[0] == 403)
    updated = teacher.ok(f'/management-api/courses/{own_id}', 'PATCH', {'student_ids': own['students'], 'assistant_ids': own['assistants']})
    check('Teacher can manage own student and assistant roster', sorted(updated['students']) == sorted(own['students']) and sorted(updated['assistants']) == sorted(own['assistants']))
    check('Assistant cannot manage course roster', assistant.request(f'/management-api/courses/{own_id}', 'PATCH', {'student_ids': own['students']})[0] == 403)
    check('Alternate assistant endpoint cannot cross course boundary', teacher.request('/management-api/users/set_assistant', 'POST', {'course_id': fid, 'user_id': pupil['id']})[0] == 403)
    check('Teacher cannot create foreign assignments', teacher.request('/management-api/assignments', 'POST', {
        'course': str(fid), 'title': 'Denied assignment', 'start_time': '2026-10-01T00:00:00Z',
        'due_time': '2026-12-01T00:00:00Z', 'max_file_size': 1024})[0] == 403)
    check('Teacher cannot inspect foreign grade statistics', teacher.request(f'/management-api/courses/{fid}/statistics')[0] == 403)
    check('Teacher cannot create administrator accounts', teacher.request('/management-api/users', 'POST', {
        'username': 'denied_admin', 'real_name': 'Denied', 'role': 2, 'password_expired': False})[0] == 403)
    promoted = dict(me, role=2)
    check('Teacher cannot promote self to administrator', teacher.request(f'/management-api/users/{me["id"]}', 'PATCH', promoted)[0] == 403)
    check('Teacher cannot batch overwrite users', teacher.request('/management-api/users/batch_create', 'POST', [dict(promoted)])[0] == 403)
    check('Teacher cannot reset another password', teacher.request('/management-api/users/change_password', 'POST', {'user_id': other['id'], 'new_password': 'not-applied'})[0] == 403)
    check('Teacher cannot deactivate another account', teacher.request(f'/management-api/users/{other["id"]}', 'DELETE')[0] == 403)
    check('Teacher cannot restore teacher role through HOJ import', teacher.request('/management-api/hoj/import', 'POST', {})[0] == 403)
    check('Super administrator can maintain course configuration', admin.request(path, 'PATCH', {'title': foreign['title'], 'teacher_ids': [other['id']]})[0] == 200)
    actual = admin.ok(path)
    check('Denied operations leave foreign teacher roster intact', [t['id'] for t in actual['teachers']] == [other['id']] and actual['title'] == foreign['title'])
    check('Denied promotion leaves teacher role intact', teacher.ok('/management-api/auth/current_user')['role'] == 1)
    check('Student cannot read unenrolled course', student.request('/management-api/courses/999999999')[0] in [403, 404])
    print(json.dumps({'passed': len(checks), 'checks': checks}, indent=2))


if __name__ == '__main__':
    main()
