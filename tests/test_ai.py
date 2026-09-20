"""Offline boundary tests for the AI analysis path (no shared DB, no real model).

`httpx.Client` is replaced so every case decides what the model service answers;
`service.db` is replaced by an in-memory stand-in. The assertions target the
contract: permissions before any model call, rule fallback on every failure,
only this submission's own code in the payload, and server facts that the model
cannot overwrite.
"""
import json
import os
from pathlib import Path
import re
import sys
import unittest
from unittest.mock import patch

import httpx
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import service  # noqa: E402

TEACHER = 'cm_pilot_teacher'
STUDENT = 'cm_pilot_student'
TA = 'cm_pilot_ta'
OUTSIDER = 'cm_pilot_outsider'
SECOND_STUDENT = 'cm_pilot_ta'
OTHER_SID = 4243
SID = 4242
BID = 900
PID = 1025
OID = 1
STUDENT_CODE = 'a,b=map(int,input().split())\nprint(a+b)\n'
OTHER_CODE = '# 其他学生的提交 other-student-secret\nprint(1)\n'
HIDDEN_MARKER = 'HIDDEN-TEST-42'
RUNTIME_TEXT = f'runtime 回显了隐藏输入输出 {HIDDEN_MARKER}'
POSTS = []
NEXT = None


class FakeResponse:
    def __init__(self, status_code=200, payload=None):
        self.status_code = status_code
        self._payload = payload

    def json(self):
        if self._payload is None:
            raise ValueError('response is not JSON')
        return self._payload


def ok_reply(text='先对照输入约束检查边界值。'):
    return FakeResponse(200, {'choices': [{'message': {'content': text}}]})


class FakeClient:
    def __init__(self, **kwargs):
        self.kwargs = kwargs

    def __enter__(self):
        return self

    def __exit__(self, *exc_info):
        return False

    def get(self, url, **kwargs):
        raise AssertionError('analysis must not issue GET requests')

    def post(self, url, headers=None, json=None):
        POSTS.append({'url': url, 'headers': headers or {}, 'json': json})
        if isinstance(NEXT, Exception):
            raise NEXT
        return NEXT


class FakeDB:
    def __init__(self, result=6, ai_enabled='1'):
        self.result = result
        self.ai_enabled = ai_enabled
        self.code = STUDENT_CODE
        self.compile_row = None
        self.runtime_row = {'error': RUNTIME_TEXT}
        self.source_queries = []
        self.writes = []

    def rows(self, sql):
        if 'FROM cm_offering o LEFT JOIN' in sql:
            oid = int(re.search(r'o\.offering_id=(\d+)', sql).group(1))
            user = bytes.fromhex(re.search(r"X'([0-9a-f]*)'", sql).group(1)).decode()
            role = 'student' if user in (STUDENT, SECOND_STUDENT) and oid == OID else None
            return [{'offering_id': oid, 'course_id': 1, 'status': 'active', 'teacher_id': TEACHER, 'role': role}]
        if 'FROM cm_batch_problem bp JOIN jol.problem p USING(problem_id)' in sql:
            return [{'problem_id': PID, 'title': '两个整数的和', 'description': '求和', 'input': '两个整数',
                     'output': '和', 'sample_input': '1 2\n', 'sample_output': '3\n', 'hint': '',
                     'defunct': 'N', 'batch_id': BID, 'seq': 1}]
        if 'FROM jol.problem p JOIN cm_batch_problem bp USING(problem_id)' in sql:
            return [{'problem_id': PID, 'title': '两个整数的和', 'description': '求和', 'input': '两个整数',
                     'output': '和', 'sample_input': '1 2\n', 'sample_output': '3\n', 'hint': '',
                     'time_limit': 1, 'memory_limit': 128, 'defunct': 'N'}]
        return []

    def one(self, sql):
        if 'FROM cm_submission cs JOIN jol.solution s' in sql:
            sid = int(re.search(r'cs\.submission_id=(\d+)', sql).group(1))
            owner = STUDENT if sid == SID else SECOND_STUDENT
            return {'submission_id': sid, 'offering_id': OID, 'batch_id': BID, 'user_id': owner,
                    'result': str(self.result), 'time': '12', 'memory': '3400', 'problem_id': PID,
                    'language': '6', 'submit_state': 'promoted'}
        if 'FROM jol.compileinfo' in sql:
            return self.compile_row
        if 'FROM jol.runtimeinfo' in sql:
            return self.runtime_row
        if 'FROM jol.source_code' in sql:
            self.source_queries.append(int(re.search(r'solution_id=(\d+)', sql).group(1)))
            return {'source': self.code}
        if 'FROM cm_batch WHERE batch_id=' in sql:
            return {'batch_id': BID, 'offering_id': OID, 'status': 'published', 'ai_enabled': self.ai_enabled,
                    'open_at': None, 'due_at': None, 'allow_late': '0', 'read_only': '0', 'source_ref': None}
        rows = self.rows(sql)
        return rows[0] if rows else None

    def write(self, sql, ops=False):
        self.writes.append(sql)
        return ''


class AnalysisTests(unittest.TestCase):
    def setUp(self):
        global POSTS, NEXT
        POSTS = []
        NEXT = ok_reply()
        self.db = FakeDB()
        for p in [patch.object(service, 'db', self.db),
                  patch.object(service, 'key', lambda: b'omp-ai-analysis-key'),
                  patch.object(service.httpx, 'Client', FakeClient),
                  patch.dict(os.environ, {'COURSE_DEV_LOGIN': '1', 'COURSE_HUSTOJ_COOKIE': 'PHPSESSID',
                                          'COURSE_AI_URL': 'http://ai.invalid', 'COURSE_AI_MODEL': 'test-model',
                                          'COURSE_AI_KEY': 'test-key'})]:
            p.start()
            self.addCleanup(p.stop)

    def client(self, user=STUDENT):
        c = TestClient(service.app, raise_server_exceptions=False)
        c.cookies.set('course_session', service.cookie(user))
        return c

    def ask(self, level=1, user=STUDENT, sid=SID):
        return self.client(user).get(f'/api/submissions/{sid}/analysis', params={'level': level})

    def reply(self, outcome):
        global NEXT
        NEXT = outcome

    def case_sent(self):
        return json.loads(POSTS[0]['json']['messages'][1]['content'])

    # ---------------- success and degradation ----------------
    def test_model_answer_is_used_when_available(self):
        self.reply(ok_reply('对照样例检查边界值。'))
        r = self.ask()
        self.assertEqual(200, r.status_code, r.text)
        body = r.json()
        self.assertEqual('model', body['mode'])
        self.assertEqual('对照样例检查边界值。', body['evidence'][1]['text'])
        self.assertEqual(1, len(POSTS))

    def test_unconfigured_service_degrades_without_calling_the_model(self):
        with patch.dict(os.environ, {'COURSE_AI_URL': '', 'COURSE_AI_MODEL': ''}):
            body = self.ask().json()
        self.assertEqual('rules', body['mode'])
        self.assertEqual('not_configured', body['reason'])
        self.assertFalse(body['degraded'])
        self.assertEqual([], POSTS)

    def test_timeout_degrades_to_rules(self):
        self.reply(httpx.ReadTimeout('model timed out'))
        body = self.ask().json()
        self.assertEqual('rules', body['mode'])
        self.assertEqual('model_unavailable', body['reason'])
        self.assertTrue(body['degraded'])

    def test_malformed_responses_degrade_to_rules(self):
        cases = {'http_error': FakeResponse(500, {'choices': [{'message': {'content': 'x'}}]}),
                 'not_json': FakeResponse(200, None),
                 'missing_choices': FakeResponse(200, {}),
                 'empty_text': FakeResponse(200, {'choices': [{'message': {'content': '   '}}]}),
                 'non_string_content': FakeResponse(200, {'choices': [{'message': {'content': 42}}]}),
                 'too_long': FakeResponse(200, {'choices': [{'message': {'content': '建' * 1201}}]})}
        for name, response in cases.items():
            with self.subTest(case=name):
                POSTS.clear()
                self.reply(response)
                body = self.ask().json()
                self.assertEqual('rules', body['mode'])
                self.assertIn(body['reason'], ('model_unavailable', 'invalid_response'))
        # 非字符串内容必须判为「返回不可用」，而不是当成功
        POSTS.clear()
        self.reply(cases['non_string_content'])
        self.assertEqual('invalid_response', self.ask().json()['reason'])

    def test_passed_submission_never_calls_the_model(self):
        self.db.result = 4
        body = self.ask().json()
        self.assertEqual('rules', body['mode'])
        self.assertEqual('already_passed', body['reason'])
        self.assertEqual([], POSTS)

    # ---------------- permissions come first ----------------
    def test_ai_disabled_batch_is_refused_before_any_call(self):
        self.db.ai_enabled = '0'
        self.assertEqual(403, self.ask().status_code)
        self.assertEqual([], POSTS)

    def test_invalid_level_is_refused_before_any_call(self):
        self.assertEqual(400, self.ask(level=9).status_code)
        self.assertEqual([], POSTS)

    def test_outsider_submission_is_invisible_and_never_analysed(self):
        self.assertEqual(404, self.ask(user=OUTSIDER).status_code)
        self.assertEqual([], POSTS)

    def test_other_students_submission_is_invisible_and_their_code_is_never_read(self):
        # 本班第二名学生拥有另一份提交；当前学生访问它必须 404，且服务端不会读他的代码。
        self.db.code = OTHER_CODE
        self.assertEqual(404, self.ask(sid=OTHER_SID).status_code)
        self.assertEqual([], POSTS)
        self.assertEqual([], self.db.source_queries)
        self.assertNotIn('other-student-secret', json.dumps(POSTS, ensure_ascii=False))

    # ---------------- what goes to the model ----------------
    def test_request_carries_only_this_submission(self):
        self.ask()
        payload = POSTS[0]['json']
        case = self.case_sent()
        sent = json.dumps(payload, ensure_ascii=False)
        self.assertEqual(STUDENT_CODE, case['code'])
        self.assertEqual([SID], self.db.source_queries)   # 只读本次授权提交的代码
        self.assertNotIn(OTHER_CODE, sent)
        self.assertNotIn(HIDDEN_MARKER, sent)
        self.assertNotIn('tests', case)
        self.assertNotIn('error', case['judge'])          # 裸 error 字段不外发
        self.assertEqual('test-model', payload['model'])
        self.assertTrue(POSTS[0]['url'].endswith('/chat/completions'))

    def test_payload_limits_and_level_guide(self):
        self.ask(level=3)
        case = self.case_sent()
        self.assertEqual(3, case['level'])
        self.assertEqual(service.HINT_LEVEL_GUIDE[3], case['levelGuide'])
        self.assertEqual(6, case['judge']['resultCode'])

    def test_only_compile_error_is_sent_never_runtime_echo(self):
        self.db.compile_row = {'error': 'line 3: syntax error'}
        self.db.runtime_row = {'error': RUNTIME_TEXT}
        self.ask()
        case = self.case_sent()
        self.assertEqual('line 3: syntax error', case['judge']['compileError'])
        self.assertNotIn(HIDDEN_MARKER, json.dumps(case, ensure_ascii=False))

    def test_nested_error_rows_are_flattened_and_length_limited(self):
        self.db.compile_row = {'error': {'nested': 'ignored'}}
        self.ask()
        self.assertEqual('', self.case_sent()['judge']['compileError'])
        POSTS.clear()
        self.db.compile_row = {'error': 'E' * 5000}
        self.ask()
        compile_error = self.case_sent()['judge']['compileError']
        self.assertTrue(compile_error.endswith('……（已截断）'))
        self.assertLessEqual(len(compile_error), 2000 + len('……（已截断）'))

    def test_code_is_truncated_by_utf8_bytes(self):
        self.db.code = '数' * 5000                        # 15000 UTF-8 bytes
        self.ask()
        code = self.case_sent()['code']
        self.assertLessEqual(len(code.encode('utf-8')), 8000 + len('……（已截断）'.encode('utf-8')))
        self.assertTrue(code.endswith('……（已截断）'))
        code.encode('utf-8').decode('utf-8')             # 不得切出半个多字节字符

    # ---------------- server facts are never overwritten ----------------
    def test_fact_evidence_survives_a_model_that_disputes_it(self):
        self.reply(ok_reply('实际上你的提交是编译错误，用时 999 ms。'))
        body = self.ask().json()
        fact = body['evidence'][0]
        self.assertEqual('F', fact['kind'])
        self.assertIn(f'提交 #{SID}', fact['text'])
        self.assertIn('答案错误', fact['text'])
        self.assertIn('用时 12 ms', fact['text'])
        self.assertIn('3400 KB', fact['text'])
        self.assertNotIn('999 ms', fact['text'])
        self.assertEqual(['F1'], body['evidence'][1]['basis'])


if __name__ == '__main__':
    unittest.main()
