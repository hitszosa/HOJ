"""Offline boundary tests for the HUSTOJ-native session authentication.

Nothing here talks to PHP or MySQL: `httpx.Client` is replaced by a stand-in
that decides, per case, what `course.php?mode=session` answers. The point is the
identity boundary — a client never gets to declare who it is.
"""
import os
import re
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import service  # noqa: E402

DEV_TEACHER = 'cm_pilot_teacher'
NATIVE_USER = 'cm_real_student'
DEFAULT_ENDPOINT = 'http://127.0.0.1:8080/course.php?mode=session'
CALLS = []
LAST_KWARGS = None
HANDLER = None


class FakeResponse:
    def __init__(self, status_code=200, payload=None, content=b''):
        self.status_code = status_code
        self.content = content
        self._payload = payload

    def json(self):
        if self._payload is None:
            raise ValueError('response is not JSON')
        return self._payload


def session_ok(**extra):
    return FakeResponse(200, dict({'user': NATIVE_USER, 'authSource': 'hustoj'}, **extra), b'{}')


class FakeClient:
    """Stand-in for httpx.Client; HANDLER decides the upstream answer."""

    def __init__(self, **kwargs):
        global LAST_KWARGS
        LAST_KWARGS = kwargs

    def __enter__(self):
        return self

    def __exit__(self, *exc_info):
        return False

    def get(self, url, cookies=None):
        CALLS.append((url, dict(cookies or {})))
        outcome = HANDLER(url, dict(cookies or {}))
        if isinstance(outcome, Exception):
            raise outcome
        return outcome

class IdentityDB:
    """Stand-in for the persisted-authority queries behind /api/me."""

    def __init__(self):
        self.privileged = set()        # jol.privilege rightstr='teacher'
        self.taught = set()            # cm_offering.teacher_id
        self.enrollments = {}          # user -> [role, ...] (active rows only, as the SQL filters)
        self.inactive_enrollments = {} # user -> [role, ...] never returned: status != 'active'
        self.offerings = {}            # oid -> {'teacher_id':..., 'status':...}
        self.members = {}              # oid -> {user: role}
        self.course_rows = []          # /api/courses 的行
        self.queries = []

    def rows(self, sql):
        self.queries.append(sql)
        user = bytes.fromhex(re.search(r"X'([0-9a-f]*)'", sql).group(1)).decode()
        if 'FROM jol.privilege' in sql:
            rows = [{'role': 'teacher'}] if user in self.privileged else []
            if user in self.taught:
                rows.append({'role': 'teacher'})
            rows += [{'role': role} for role in self.enrollments.get(user, [])]
            return rows
        if 'FROM cm_course c JOIN cm_offering o' in sql:
            out = []
            for row in self.course_rows:
                oid = row['offering_id']
                role = 'teacher' if row.get('teacher_id') == user else self.members.get(oid, {}).get(user)
                if role is None:
                    continue
                out.append(dict(row, role=role))
            return out
        if 'FROM cm_offering o LEFT JOIN' in sql:
            oid = int(re.search(r'o\.offering_id=(\d+)', sql).group(1))
            offering = self.offerings.get(oid)
            if not offering:
                return []
            return [dict(offering, role=self.members.get(oid, {}).get(user))]
        return []

    def one(self, sql):
        rows = self.rows(sql)
        return rows[0] if rows else None

    def write(self, sql, ops=False):
        return ''


class NativeAuthTests(unittest.TestCase):
    def setUp(self):
        global CALLS, LAST_KWARGS, HANDLER
        CALLS = []
        LAST_KWARGS = None
        HANDLER = lambda url, cookies: session_ok()  # noqa: E731
        self.db = IdentityDB()
        for p in [patch.object(service.httpx, 'Client', FakeClient),
                  patch.object(service, 'db', self.db),
                  patch.object(service, 'key', lambda: b'omp-native-auth-key'),
                  patch.dict(os.environ, {'COURSE_DEV_LOGIN': '1', 'COURSE_HUSTOJ_COOKIE': 'PHPSESSID'})]:
            p.start()
            self.addCleanup(p.stop)

    def client(self, session_id=None, dev_user=None):
        c = TestClient(service.app, raise_server_exceptions=False)
        if session_id is not None:
            c.cookies.set('PHPSESSID', session_id)
        if dev_user is not None:
            c.cookies.set('course_session', service.cookie(dev_user))
        return c

    def reply(self, response):
        global HANDLER
        HANDLER = lambda url, cookies: response  # noqa: E731

    def raise_from_upstream(self, error):
        global HANDLER
        HANDLER = lambda url, cookies: error  # noqa: E731

    def test_native_session_wins_and_forwards_the_php_cookie(self):
        sid = 'a' * 26
        r = self.client(session_id=sid, dev_user=DEV_TEACHER).get('/api/me')
        self.assertEqual(200, r.status_code, r.text)
        self.assertEqual(NATIVE_USER, r.json()['user'])
        self.assertEqual('hustoj', r.json()['authSource'])
        self.assertEqual([(DEFAULT_ENDPOINT, {'PHPSESSID': sid})], CALLS)

    def test_client_is_configured_without_redirect_following(self):
        self.client(session_id='b' * 26).get('/api/me')
        self.assertFalse(LAST_KWARGS['follow_redirects'])
        self.assertEqual(5, LAST_KWARGS['timeout'])

    def test_upstream_unauthorized_is_propagated(self):
        self.reply(FakeResponse(401, None, b''))
        r = self.client(session_id='c' * 26, dev_user=DEV_TEACHER).get('/api/me')
        self.assertEqual(401, r.status_code, r.text)

    def test_network_failure_is_fail_closed(self):
        self.raise_from_upstream(httpx.ConnectTimeout('PHP session endpoint timed out'))
        r = self.client(session_id='d' * 26, dev_user=DEV_TEACHER).get('/api/me')
        self.assertEqual(503, r.status_code, r.text)      # must not fall back to the dev cookie

    def test_redirect_to_login_page_is_rejected(self):
        self.reply(FakeResponse(302, None, b''))
        self.assertEqual(503, self.client(session_id='e' * 26).get('/api/me').status_code)

    def test_malformed_identity_payload_is_rejected(self):
        for payload in [FakeResponse(200, None, b'<html>login</html>'),
                        FakeResponse(200, {'user': NATIVE_USER, 'authSource': 'guest'}),
                        FakeResponse(200, {'user': 'u' * 65, 'authSource': 'hustoj'}),
                        FakeResponse(200, {'user': 'evil\nuser', 'authSource': 'hustoj'}),
                        FakeResponse(200, {'user': 42, 'authSource': 'hustoj'})]:
            with self.subTest(payload=payload._payload):
                self.reply(payload)
                self.assertEqual(503, self.client(session_id='f' * 26).get('/api/me').status_code)

    def test_oversized_identity_payload_is_rejected(self):
        self.reply(FakeResponse(200, {'user': NATIVE_USER, 'authSource': 'hustoj'}, b'x' * 8193))
        self.assertEqual(503, self.client(session_id='g' * 26).get('/api/me').status_code)

    def test_malformed_session_cookie_never_reaches_php(self):
        for sid in ['abc', '../etc/passwd', 'x' * 257]:
            with self.subTest(sid=sid):
                CALLS.clear()
                self.assertEqual(401, self.client(session_id=sid).get('/api/me').status_code)
                self.assertEqual([], CALLS)

    def test_dev_cookie_needs_the_explicit_switch(self):
        with patch.dict(os.environ, {'COURSE_DEV_LOGIN': '0'}):
            self.assertEqual(401, self.client(dev_user=DEV_TEACHER).get('/api/me').status_code)
        self.assertEqual(200, self.client(dev_user=DEV_TEACHER).get('/api/me').status_code)

    def test_dev_identity_is_labelled_and_native_is_preferred(self):
        dev = self.client(dev_user=DEV_TEACHER).get('/api/me').json()
        self.assertEqual('development', dev['authSource'])
        native = self.client(session_id='h' * 26, dev_user=DEV_TEACHER).get('/api/me').json()
        self.assertEqual('hustoj', native['authSource'])

    def test_session_revocation_is_seen_on_the_next_request(self):
        replies = iter([session_ok(), FakeResponse(401, None, b'')])
        global HANDLER
        HANDLER = lambda url, cookies: next(replies)  # noqa: E731
        c = self.client(session_id='i' * 26)
        self.assertEqual(200, c.get('/api/me').status_code)
        self.assertEqual(401, c.get('/api/me').status_code)
        self.assertEqual(2, len(CALLS))                # every request re-verifies, nothing cached

    def test_choosing_a_dev_identity_drops_the_native_cookie(self):
        r = self.client().post('/api/session', json={'role': 'teacher'})
        self.assertEqual(200, r.status_code, r.text)
        self.assertIn('PHPSESSID', r.headers.get('set-cookie', ''))

    def test_health_reports_the_login_mode(self):
        body = self.client().get('/api/health').json()
        self.assertTrue(body['devLogin'])
        self.assertEqual('/oj/loginpage.php', body['loginUrl'])
        with patch.dict(os.environ, {'COURSE_DEV_LOGIN': '0'}):
            self.assertFalse(self.client().get('/api/health').json()['devLogin'])




class OriginAndLogoutTests(unittest.TestCase):
    def setUp(self):
        for p in [patch.object(service, 'key', lambda: b'omp-origin-test-key'),
                  patch.object(service, 'db', IdentityDB()),
                  patch.dict(os.environ, {'COURSE_DEV_LOGIN': '1', 'COURSE_HUSTOJ_COOKIE': 'PHPSESSID'})]:
            p.start()
            self.addCleanup(p.stop)

    def client(self, php_session=True):
        c = TestClient(service.app, raise_server_exceptions=False)
        if php_session:
            c.cookies.set('PHPSESSID', 'z' * 26)
        return c

    def test_foreign_origin_is_refused_and_allow_list_is_configurable(self):
        c = self.client(php_session=False)
        self.assertEqual(403, c.post('/api/session', json={'role': 'teacher'},
                                     headers={'origin': 'http://attacker.invalid'}).status_code)
        with patch.dict(os.environ, {'COURSE_ALLOWED_ORIGINS': 'https://school.example'}):
            allowed = self.client(php_session=False).post('/api/session', json={'role': 'teacher'},
                                                          headers={'origin': 'https://school.example'})
            self.assertNotEqual(403, allowed.status_code)
            refused = self.client(php_session=False).post('/api/session', json={'role': 'teacher'},
                                                          headers={'origin': 'http://127.0.0.1:3100'})
            self.assertEqual(403, refused.status_code)

    def test_missing_origin_is_not_an_identity_grant(self):
        anonymous = self.client(php_session=False).get('/api/me')
        self.assertEqual(401, anonymous.status_code)      # no cookie, no origin, still unauthenticated
        c = self.client(php_session=False)
        c.cookies.set('course_session', service.cookie(DEV_TEACHER))
        self.assertEqual(200, c.get('/api/me').status_code)

    def test_logout_keeps_the_php_session_and_returns_the_logout_url(self):
        c = self.client()
        r = c.delete('/api/session')
        self.assertEqual(200, r.status_code, r.text)
        self.assertEqual('/oj/logout.php', r.json()['logoutUrl'])
        set_cookie = r.headers.get('set-cookie', '')
        self.assertIn('course_session', set_cookie)
        self.assertNotIn('PHPSESSID', set_cookie)         # destroyed by HUSTOJ's own logout




class PortalTests(unittest.TestCase):
    """Portal and roles come from persisted authority, never from the client."""

    def setUp(self):
        global CALLS, LAST_KWARGS, HANDLER
        CALLS = []
        LAST_KWARGS = None
        HANDLER = lambda url, cookies: session_ok()  # noqa: E731
        self.db = IdentityDB()
        for p in [patch.object(service.httpx, 'Client', FakeClient),
                  patch.object(service, 'db', self.db),
                  patch.object(service, 'key', lambda: b'omp-portal-test-key'),
                  patch.dict(os.environ, {'COURSE_DEV_LOGIN': '1', 'COURSE_HUSTOJ_COOKIE': 'PHPSESSID'})]:
            p.start()
            self.addCleanup(p.stop)

    def me(self, **params):
        c = TestClient(service.app, raise_server_exceptions=False)
        c.cookies.set('PHPSESSID', 'p' * 26)
        r = c.get('/api/me', params=params, headers={'X-Role': 'teacher', 'X-Portal': 'teacher'})
        self.assertEqual(200, r.status_code, r.text)
        return r.json()

    def test_global_privilege_opens_the_teacher_portal(self):
        self.db.privileged = {NATIVE_USER}
        body = self.me()
        self.assertEqual(['teacher'], body['roles'])
        self.assertEqual('teacher', body['portal'])
        self.assertEqual('/teacher', body['home'])

    def test_ta_enrollment_opens_the_teacher_portal(self):
        self.db.enrollments = {NATIVE_USER: ['ta']}
        body = self.me()
        self.assertEqual(['ta'], body['roles'])
        self.assertEqual('teacher', body['portal'])

    def test_offering_teacher_opens_the_teacher_portal(self):
        self.db.taught = {NATIVE_USER}
        self.assertEqual(['teacher'], self.me()['roles'])

    def test_plain_student_stays_on_the_student_portal(self):
        self.db.enrollments = {NATIVE_USER: ['student']}
        body = self.me()
        self.assertEqual(['student'], body['roles'])
        self.assertEqual('student', body['portal'])
        self.assertEqual('/student', body['home'])

    def test_user_without_any_course_is_still_a_student(self):
        body = self.me()
        self.assertEqual(['student'], body['roles'])
        self.assertEqual('student', body['portal'])

    def test_unknown_role_values_are_dropped(self):
        self.db.enrollments = {NATIVE_USER: ['guest', 'student']}
        self.assertEqual(['student'], self.me()['roles'])
        self.db.enrollments = {NATIVE_USER: ['guest']}
        self.assertEqual(['student'], self.me()['roles'])

    def test_client_supplied_roles_and_portal_are_ignored(self):
        self.db.enrollments = {NATIVE_USER: ['student']}
        body = self.me(role='teacher', portal='teacher', user='cm_pilot_teacher')
        self.assertEqual(['student'], body['roles'])
        self.assertEqual('student', body['portal'])
        self.assertEqual(NATIVE_USER, body['user'])

    def test_dual_identity_keeps_the_full_role_list_on_the_teacher_portal(self):
        self.db.privileged = {NATIVE_USER}
        self.db.enrollments = {NATIVE_USER: ['student']}
        body = self.me()
        self.assertEqual(['student', 'teacher'], body['roles'])
        self.assertEqual('teacher', body['portal'])
        self.db.privileged = set()
        self.db.enrollments = {NATIVE_USER: ['student', 'ta']}
        body = self.me()
        self.assertEqual(['student', 'ta'], body['roles'])
        self.assertEqual('teacher', body['portal'])

    def test_inactive_enrollment_grants_nothing(self):
        self.db.inactive_enrollments = {NATIVE_USER: ['teacher', 'ta']}
        body = self.me()
        self.assertEqual(['student'], body['roles'])
        self.assertEqual('student', body['portal'])

    def test_course_owner_stays_teacher_when_also_enrolled_as_student(self):
        self.db.course_rows = [{'code': 'PILOT1007', 'offering_id': 1, 'term': '2026-秋', 'section': '1',
                                'status': 'active', 'teacher_id': NATIVE_USER}]
        self.db.members[1] = {NATIVE_USER: 'student'}
        c = TestClient(service.app, raise_server_exceptions=False)
        c.cookies.set('PHPSESSID', 'p' * 26)
        rows = c.get('/api/courses').json()
        self.assertEqual('teacher', rows[0]['role'])
        courses_sql = next(q for q in self.db.queries if 'FROM cm_course c JOIN cm_offering o' in q)
        self.assertIn('CASE WHEN o.teacher_id', courses_sql)   # 本轮修复：owner 优先
        self.assertNotIn("COALESCE(e.role,'teacher')", courses_sql)

    def test_global_teacher_does_not_widen_course_access(self):
        self.db.privileged = {NATIVE_USER}
        self.db.offerings[2] = {'offering_id': 2, 'course_id': 2, 'status': 'active', 'teacher_id': DEV_TEACHER}
        self.db.members[2] = {}                       # not a member of offering 2
        c = TestClient(service.app, raise_server_exceptions=False)
        c.cookies.set('PHPSESSID', 'p' * 26)
        self.assertEqual(404, c.get('/api/offerings/2').status_code)
        self.assertEqual(404, c.post('/api/offerings/2/drafts', json={'document': {}}).status_code)

if __name__ == '__main__':
    unittest.main()
