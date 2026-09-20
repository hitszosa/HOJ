"""Offline boundary tests for the sandbox trial runs (自测).

A trial reuses HUSTOJ's `problem_id=0` + custominput path, so it must never
enter `cm_submission` (assignment and class statistics). The suite pins that
boundary plus input limits, throttling, token ownership and result semantics.
"""
import base64
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import sys
import time
import unittest
from unittest.mock import patch

from fastapi import HTTPException
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import service  # noqa: E402

STUDENT = 'cm_pilot_student'
TEACHER = 'cm_pilot_teacher'
TA = 'cm_pilot_ta'
OUTSIDER = 'cm_pilot_outsider'
BID = 900
PID = 1025
OID = 1
CODE = 'a,b=map(int,input().split())\nprint(a+b)\n'
PY_HEADER = '# coding=utf-8\n'
NUL = '\0'


class TrialDB:
    """In-memory stand-in covering the trial read/write path."""

    def __init__(self):
        self.solutions = {}          # sid -> row
        self.submissions = []        # cm_submission rows: trials must stay out
        self.source_code = {}
        self.custominput = {}
        self.compileinfo = {}
        self.runtimeinfo = {}
        self.pending_trial = None    # 频率闸：SELECT ... LIMIT 1 的返回
        self.fail_write = False
        self.next_sid = 6000
        self.queries = []

    # ---------------- reads ----------------
    def rows(self, sql):
        self.queries.append(sql)
        if 'FROM cm_offering o LEFT JOIN' in sql:
            oid = int(re.search(r'o\.offering_id=(\d+)', sql).group(1))
            user = self._user(sql)
            role = 'student' if user == STUDENT and oid == OID else ('ta' if user == TA else None)
            return [{'offering_id': oid, 'course_id': 1, 'status': self.status, 'teacher_id': TEACHER, 'role': role}]
        return []

    status = 'active'

    def one(self, sql):
        self.queries.append(sql)
        if 'FROM jol.solution' in sql and 'problem_id=0' in sql and 'DATE_SUB' in sql:
            return self.pending_trial
        if 'FROM jol.solution' in sql:
            sid = int(re.search(r'solution_id=(\d+)', sql).group(1))
            return self.solutions.get(sid)
        if 'FROM jol.compileinfo' in sql:
            sid = int(re.search(r'solution_id=(\d+)', sql).group(1))
            return self.compileinfo.get(sid)
        if 'FROM jol.runtimeinfo' in sql:
            sid = int(re.search(r'solution_id=(\d+)', sql).group(1))
            return self.runtimeinfo.get(sid)
        if 'FROM cm_batch WHERE batch_id=' in sql:
            return {'batch_id': BID, 'offering_id': OID, 'status': self.batch_status, 'open_at': None,
                    'due_at': self.due_at, 'allow_late': self.allow_late, 'ai_enabled': '1',
                    'read_only': '0', 'source_ref': None}
        if 'FROM jol.problem p JOIN cm_batch_problem bp USING(problem_id)' in sql:
            return [{'problem_id': PID, 'title': '两个整数的和', 'description': '求和', 'sample_input': '1 2\n',
                     'sample_output': '3\n', 'time_limit': 1, 'memory_limit': 128, 'defunct': 'N'}]
        if 'FROM cm_batch_problem bp JOIN jol.problem p USING(problem_id)' in sql:
            return [{'problem_id': PID, 'batch_id': BID, 'seq': 1}]
        rows = self.rows(sql)
        return rows[0] if rows else None

    batch_status = 'published'
    due_at = None
    allow_late = '0'

    # ---------------- writes ----------------
    def write(self, sql, ops=False):
        if self.fail_write:
            raise HTTPException(503, '判题服务暂时不可达')
        produced = ''
        for statement in (chunk.strip() for chunk in sql.split(';')):
            if statement:
                produced = self.apply(statement) or produced
        return produced

    def apply(self, sql):
        if 'INSERT INTO jol.solution(' in sql:
            sid = self.next_sid
            self.next_sid += 1
            self.solutions[sid] = {'solution_id': sid, 'problem_id': 0, 'user_id': self._user(sql),
                                   'result': '0', 'time': '3', 'memory': '1024'}
            return str(sid)
        if 'INSERT INTO jol.custominput(' in sql or 'INSERT INTO jol.source_code' in sql:
            sid = self.next_sid - 1                      # written with @sid, not a literal
            if 'custominput' in sql:
                self.custominput[sid] = self._hex(sql)[-1]
            else:
                self.source_code[sid] = self._hex(sql)[-1]
            return ''
        if 'INSERT INTO cm_submission' in sql:
            self.submissions.append(sql)
            return ''
        return ''

    # ---------------- helpers ----------------
    @staticmethod
    def _hex(sql):
        return [bytes.fromhex(h).decode('utf-8') for h in re.findall(r"X'([0-9a-f]*)'", sql)]

    @staticmethod
    def _user(sql):
        return bytes.fromhex(re.search(r"X'([0-9a-f]*)'", sql).group(1)).decode('utf-8')


def forged_token(sid=BID, user=STUDENT, exp=None, signature='forged'):
    payload = base64.urlsafe_b64encode(json.dumps(
        {'sid': 9000, 'bid': sid, 'pid': PID, 'user': user, 'exp': int(time.time()) + 3600},
        separators=(',', ':')).encode()).decode().rstrip('=')
    return payload + '.' + signature


def expired_token(sid=9000, user=STUDENT):
    payload = base64.urlsafe_b64encode(json.dumps(
        {'sid': sid, 'bid': BID, 'pid': PID, 'user': user, 'exp': int(time.time()) - 10},
        separators=(',', ':')).encode()).decode().rstrip('=')
    signature = hmac.new(service.key(), ('trial:' + payload).encode(), hashlib.sha256).hexdigest()
    return payload + '.' + signature


class TrialTests(unittest.TestCase):
    def setUp(self):
        self.db = TrialDB()
        for p in [patch.object(service, 'db', self.db),
                  patch.object(service, 'key', lambda: b'omp-trial-test-key'),
                  patch.dict(os.environ, {'COURSE_DEV_LOGIN': '1', 'COURSE_HUSTOJ_COOKIE': 'PHPSESSID'})]:
            p.start()
            self.addCleanup(p.stop)

    def client(self, user=STUDENT):
        c = TestClient(service.app, raise_server_exceptions=False)
        c.cookies.set('course_session', service.cookie(user))
        return c

    def run_trial(self, **payload):
        body = {'code': CODE, 'language': 'python', 'input': '1 2\n'}
        body.update(payload)
        return self.client().post(f'/api/batches/{BID}/problems/{PID}/trials', json=body)

    # ---------------- a trial is not a submission ----------------
    def test_trial_never_creates_a_formal_submission(self):
        r = self.run_trial()
        self.assertEqual(200, r.status_code, r.text)
        run_id = r.json()['runId']
        self.assertEqual([], self.db.submissions)
        sid = max(self.db.solutions)
        self.assertEqual(0, int(self.db.solutions[sid]['problem_id']))
        self.assertEqual(CODE, self.db.source_code[sid].replace(PY_HEADER, '', 1))
        self.assertEqual('1 2\n', self.db.custominput[sid])
        self.assertTrue(run_id)

    def test_trial_result_is_readable_by_its_owner(self):
        run_id = self.run_trial().json()['runId']
        self.db.solutions[max(self.db.solutions)]['result'] = '4'
        body = self.client().get(f'/api/trials/{run_id}').json()
        self.assertEqual('finished', body['state'])
        self.assertEqual('自测结束', body['label'])

    def test_native_thirteen_is_not_declared_ac(self):
        run_id = self.run_trial().json()['runId']
        self.db.solutions[max(self.db.solutions)]['result'] = '13'
        body = self.client().get(f'/api/trials/{run_id}').json()
        self.assertEqual('finished', body['state'])
        self.assertEqual('自测结束', body['label'])
        self.assertNotIn('通过', body['label'])

    # ---------------- input boundaries ----------------
    def test_code_is_required_and_size_limited(self):
        self.assertEqual(400, self.run_trial(code='   ').status_code)
        self.assertEqual(400, self.run_trial(language='rust').status_code)
        self.assertEqual(400, self.run_trial(code='数' * 21850).status_code)          # 65550 bytes
        self.assertEqual(200, self.run_trial(code='x = 1\n' * 9300).status_code)      # 55800 bytes, OK
        self.assertEqual(400, self.run_trial(code='x = 1\n' * 11000).status_code)     # 66000 bytes

    def test_python_header_counts_towards_the_column_limit(self):
        # DB column is 65535 bytes; python adds a 15 byte coding header.
        self.assertEqual(200, self.run_trial(code='x' * (65535 - len(PY_HEADER) - 1)).status_code)
        self.assertEqual(400, self.run_trial(code='x' * 65521).status_code)          # 65521+15 > 65535

    def test_input_may_be_empty_and_is_bounded(self):
        self.assertEqual(200, self.run_trial(input='').status_code)
        self.assertEqual(200, self.run_trial(input='a' * 16384).status_code)
        self.assertEqual(400, self.run_trial(input='a' * 16385).status_code)
        self.assertEqual(400, self.run_trial(input='a' + NUL).status_code)
        self.assertEqual(400, self.run_trial(input=123).status_code)

    # ---------------- who may run a trial ----------------
    def test_only_the_enrolled_student_may_run_trials(self):
        self.assertEqual(403, self.run_trial(code=CODE).__class__ and
                         self.client(TEACHER).post(f'/api/batches/{BID}/problems/{PID}/trials',
                                                   json={'code': CODE, 'language': 'python', 'input': ''}).status_code)
        self.assertEqual(404, self.client(OUTSIDER).post(
            f'/api/batches/{BID}/problems/{PID}/trials',
            json={'code': CODE, 'language': 'python', 'input': ''}).status_code)

    def test_archived_or_closed_batches_refuse_trials(self):
        self.db.status = 'archived'
        self.assertEqual(409, self.run_trial().status_code)
        self.db.status = 'active'
        self.db.batch_status = 'closed'
        self.assertEqual(409, self.run_trial().status_code)

    def test_throttling_returns_429_with_retry_after(self):
        self.db.pending_trial = {'solution_id': 5999}
        r = self.run_trial()
        self.assertEqual(429, r.status_code)
        self.assertEqual('3', r.headers.get('Retry-After'))

    def test_database_failure_is_reported_as_503(self):
        self.db.fail_write = True
        self.assertEqual(503, self.run_trial().status_code)

    # ---------------- token ownership ----------------
    def test_forged_and_expired_tokens_are_rejected_for_a_real_run(self):
        run_id = self.run_trial().json()['runId']
        self.assertEqual(200, self.client().get(f'/api/trials/{run_id}').status_code)
        payload = run_id.split('.')[0]                 # same claims, broken signature
        self.assertEqual(404, self.client().get(f"/api/trials/{payload + '.' + '0' * 64}").status_code)
        sid = max(self.db.solutions)
        self.assertEqual(404, self.client().get(f'/api/trials/{expired_token(sid=sid)}').status_code)

    def test_other_peoples_runs_and_formal_submissions_are_invisible(self):
        run_id = self.run_trial().json()['runId']
        self.assertEqual(404, self.client(OUTSIDER).get(f'/api/trials/{run_id}').status_code)
        formal_sid = max(self.db.solutions) + 7
        self.db.solutions[formal_sid] = {'solution_id': formal_sid, 'problem_id': PID, 'user_id': STUDENT,
                                         'result': '4', 'time': '1', 'memory': '1'}
        formal = service.trial_token(formal_sid, BID, PID, STUDENT)
        self.assertEqual(404, self.client().get(f'/api/trials/{formal}').status_code)

    def test_own_result_stays_readable_after_the_class_is_archived(self):
        run_id = self.run_trial().json()['runId']
        self.db.status = 'archived'
        self.assertEqual(200, self.client().get(f'/api/trials/{run_id}').status_code)
        self.assertEqual(409, self.run_trial().status_code)

    # ---------------- output boundaries ----------------
    def test_runtime_output_is_truncated_and_flagged(self):
        run_id = self.run_trial().json()['runId']
        sid = max(self.db.solutions)
        self.db.solutions[sid]['result'] = '6'
        self.db.runtimeinfo[sid] = {'error': '输' * 9000}           # 27000 bytes
        body = self.client().get(f'/api/trials/{run_id}').json()
        self.assertTrue(body['truncated'])
        self.assertLessEqual(len(body['output'].encode('utf-8')), 16384)
        self.assertEqual('', body['compileError'])

    def test_compile_error_is_reported_in_its_own_field(self):
        run_id = self.run_trial().json()['runId']
        sid = max(self.db.solutions)
        self.db.solutions[sid]['result'] = '11'
        self.db.compileinfo[sid] = {'error': 'line 3: syntax error'}
        body = self.client().get(f'/api/trials/{run_id}').json()
        self.assertEqual('line 3: syntax error', body['compileError'])
        self.assertEqual('', body['output'])
        self.assertFalse(body['truncated'])

    def test_pending_results_are_reported_as_running(self):
        run_id = self.run_trial().json()['runId']
        for code in (0, 1, 2, 3, 14):
            with self.subTest(result=code):
                self.db.solutions[max(self.db.solutions)]['result'] = str(code)
                self.assertEqual('running', self.client().get(f'/api/trials/{run_id}').json()['state'])


if __name__ == '__main__':
    unittest.main()
