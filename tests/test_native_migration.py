import os
import sys
import unittest
from pathlib import Path
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import service

class NativeMigrationEndpointsTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(service.app)
        os.environ['COURSE_DEV_LOGIN'] = '1'

    def test_status_stream_pagination_and_filtering(self):
        # 1. Login as student
        self.client.post('/api/session', json={'userId': 'cm_pilot_student'})
        resp = self.client.get('/api/status?pageSize=10')
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertIn('items', data)
        self.assertIn('total', data)
        self.assertTrue(data['total'] >= 0)
        if data['items']:
            first = data['items'][0]
            self.assertIn('solutionId', first)
            self.assertIn('problemId', first)
            self.assertIn('resultLabel', first)
            self.assertIn('languageName', first)

        # 2. Filter onlyMine
        resp_mine = self.client.get('/api/status?onlyMine=true')
        self.assertEqual(resp_mine.status_code, 200)
        mine_data = resp_mine.json()
        for it in mine_data['items']:
            self.assertEqual(it['userId'], 'cm_pilot_student')

    def test_submission_code_access_control(self):
        # Student viewing own code vs other code
        # Find a submission by cm_pilot_student and one by another user if available
        self.client.post('/api/session', json={'userId': 'cm_pilot_student'})
        status_resp = self.client.get('/api/status?onlyMine=true&pageSize=5')
        items = status_resp.json().get('items', [])
        if items:
            my_sid = items[0]['solutionId']
            # Access own code -> 200
            code_resp = self.client.get(f'/api/submissions/{my_sid}/code')
            self.assertEqual(code_resp.status_code, 200)
            code_data = code_resp.json()
            self.assertIn('code', code_data)
            self.assertEqual(code_data['userId'], 'cm_pilot_student')

        # Find a submission not by student
        status_all = self.client.get('/api/status?pageSize=50')
        other_items = [it for it in status_all.json().get('items', []) if it['userId'] != 'cm_pilot_student']
        if other_items:
            other_sid = other_items[0]['solutionId']
            # Student accessing other student code -> 403
            forbidden_resp = self.client.get(f'/api/submissions/{other_sid}/code')
            self.assertEqual(forbidden_resp.status_code, 403)

            # Admin accessing other code -> 200
            self.client.post('/api/session', json={'userId': 'admin'})
            admin_resp = self.client.get(f'/api/submissions/{other_sid}/code')
            self.assertEqual(admin_resp.status_code, 200)

    def test_ranklist(self):
        self.client.post('/api/session', json={'userId': 'cm_pilot_student'})
        resp = self.client.get('/api/ranklist?pageSize=10')
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertIn('items', data)
        self.assertIn('total', data)
        if data['items']:
            first = data['items'][0]
            self.assertIn('rank', first)
            self.assertIn('userId', first)
            self.assertIn('solved', first)
            self.assertIn('passRate', first)

    def test_public_problems_and_submit(self):
        self.client.post('/api/session', json={'userId': 'cm_pilot_student'})
        resp = self.client.get('/api/public-problems?pageSize=10')
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertIn('items', data)
        self.assertTrue(data['total'] > 0)
        prob = data['items'][0]
        pid = prob['problemId']

        # Get problem detail
        det_resp = self.client.get(f'/api/public-problems/{pid}')
        self.assertEqual(det_resp.status_code, 200)
        det = det_resp.json()
        self.assertEqual(det['problemId'], pid)
        self.assertIn('description', det)

        # Submit code to public problem
        sub_resp = self.client.post(f'/api/public-problems/{pid}/submissions', json={
            'code': 'print("hello world")',
            'language': 'python'
        })
        self.assertEqual(sub_resp.status_code, 200)
        sid = sub_resp.json().get('submissionId')
        self.assertIsNotNone(sid)

    def test_faq_endpoint(self):
        resp = self.client.get('/api/faq')
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertIn('compilers', data)
        self.assertIn('verdicts', data)
        self.assertIn('ioTips', data)
        self.assertTrue(any(v['code'] == 'AC' for v in data['verdicts']))
