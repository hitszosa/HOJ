#!/usr/bin/env python3
"""Meaningful HOJ ↔ Grader integration checks; uses only isolated local services."""
import http.cookiejar
import json
from pathlib import Path
import urllib.error
import urllib.parse
import urllib.request

BASE = 'http://127.0.0.1:3100'
ROOT = Path(__file__).resolve().parents[2]


class Session:
    def __init__(self):
        self.jar = http.cookiejar.CookieJar()
        self.http = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPCookieProcessor(self.jar))

    def request(self, path, method='GET', body=None, csrf=True, headers=None):
        h = {'Content-Type': 'application/json', 'Origin': BASE}
        if csrf:
            for cookie in self.jar:
                if cookie.name == 'csrftoken':
                    h['X-CSRFTOKEN'] = urllib.parse.unquote(cookie.value)
        h.update(headers or {})
        req = urllib.request.Request(BASE + path, None if body is None else json.dumps(body).encode(), headers=h, method=method)
        try:
            response = self.http.open(req, timeout=30)
        except urllib.error.HTTPError as error:
            response = error
        content = response.read()
        value = json.loads(content) if content and response.headers.get_content_type() == 'application/json' else content
        return response.status, value

    def ok(self, path, method='GET', body=None):
        status, value = self.request(path, method, body)
        assert 200 <= status < 300, (path, status, value)
        return value

    def login(self, role):
        self.ok('/api/session', 'POST', {'user_id': 'admin'} if role == 'admin' else {'role': role})
        return self.ok('/management-api/auth/current_user')


def main():
    checks = []
    
    
    def check(name, condition):
        assert condition, name
        checks.append(name)
    
    
    anonymous = Session()
    check('Anonymous identity rejected', anonymous.request('/management-api/auth/current_user')[0] == 401)
    check('Client identity headers cannot impersonate admin', anonymous.request('/management-api/auth/current_user', headers={'X-Remote-User': 'admin', 'X-Remote-Role': 'teacher'})[0] == 401)
    teacher = Session()
    profile = teacher.login('teacher')
    check('HOJ teacher identity retained', profile['username'] == 'cm_pilot_teacher' and profile['role'] == 1 and not profile['password_expired'])
    check('Bridge does not create an independent session', not any(cookie.name == 'sessionid' for cookie in teacher.jar))
    check('Missing CSRF rejected', teacher.request('/management-api/hoj/import', 'POST', {}, csrf=False)[0] == 403)
    check('Forged CSRF rejected', teacher.request('/management-api/hoj/import', 'POST', {}, headers={'X-CSRFTOKEN': 'forged'})[0] == 403)
    admin = Session()
    check('HOJ super administrator identity retained', admin.login('admin')['role'] == 2)
    check('Teacher cannot overwrite course relationships through import', teacher.request('/management-api/hoj/import', 'POST', {})[0] == 403)
    links = admin.ok('/management-api/hoj/import', 'POST', {})
    again = admin.ok('/management-api/hoj/import', 'POST', {})
    check('HOJ course import is idempotent', links == again and len(links) > 0)
    course_id = next(link['course_id'] for link in links if link['offering_id'] == 1)
    course = teacher.ok(f'/management-api/courses/{course_id}')
    student, ta, outsider = Session(), Session(), Session()
    student_user, ta_user, outsider_user = student.login('student'), ta.login('ta'), outsider.login('outsider')
    check('Student identity and enrollment retained', student_user['role'] == 0 and student_user['id'] in course['students'])
    check('Assistant remains course scoped', ta_user['role'] == 0 and ta_user['id'] in course['assistants'])
    check('Student can read enrolled course', student.request(f'/management-api/courses/{course_id}')[0] == 200)
    check('Unenrolled student cannot read course', outsider.request(f'/management-api/courses/{course_id}')[0] in [403, 404])
    check('Student cannot edit roster', student.request(f'/management-api/courses/{course_id}', 'PATCH', {'title': 'unauthorized'})[0] == 403)
    check('Assistant cannot create global course', ta.request('/management-api/courses', 'POST', {'title': 'unauthorized', 'teacher_ids': [], 'student_ids': [], 'assistant_ids': []})[0] == 403)
    check('Assistant can read course submission list', ta.request(f'/management-api/submissions?course={course_id}')[0] == 200)
    old_csrf = next(urllib.parse.unquote(cookie.value) for cookie in teacher.jar if cookie.name == 'csrftoken')
    teacher.ok('/api/session', 'POST', {'role': 'student'})
    check('Account switch rejects old teacher CSRF', teacher.request('/management-api/hoj/import', 'POST', {}, headers={'X-CSRFTOKEN': old_csrf})[0] == 403)
    check('Account switch immediately changes identity', teacher.ok('/management-api/auth/current_user')['id'] == student_user['id'])
    teacher.ok('/api/session', 'DELETE')
    check('HOJ logout also revokes management access', teacher.request('/management-api/auth/current_user')[0] == 401)
    secrets_local = json.loads((ROOT / '.local/management-secrets.json').read_text())
    native = Session()
    native_profile = native.ok('/management-api/auth/login', 'POST', {'username': 'local_admin', 'password': secrets_local['admin']})
    check('Grader-created accounts can use local login', native_profile['role'] == 2 and native.ok('/management-api/auth/current_user')['id'] == native_profile['id'])
    check('Invalid HOJ identity does not fall back to native admin session', native.request('/management-api/auth/current_user', headers={'Cookie': 'course_session=forged; ' + '; '.join(f'{c.name}={c.value}' for c in native.jar)})[0] == 401)
    switched = Session()
    switched.login('teacher')
    switched.ok('/management-api/auth/login', 'POST', {'username': 'local_admin', 'password': secrets_local['admin']})
    check('Native login clears prior HOJ identity', switched.ok('/management-api/auth/current_user')['role'] == 2 and not any(c.name in ['course_session', 'PHPSESSID'] for c in switched.jar))
    switched.login('teacher')
    check('HOJ login clears prior native management session', not any(c.name == 'sessionid' for c in switched.jar) and switched.ok('/management-api/auth/current_user')['role'] == 1)
    switched.ok('/api/session', 'DELETE')
    check('Logout cannot fall back to a previous native account', switched.request('/management-api/auth/current_user')[0] == 401)
    # Static assets must retain the /management prefix through the main origin.
    check('Management SPA delivered at main origin', anonymous.request('/management/home')[0] == 200)
    check('Bulk-import template delivered at main origin', anonymous.request('/management/batch-create-user-template.xltx')[0] == 200)
    print(json.dumps({'passed': len(checks), 'checks': checks, 'course_id': course_id}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
