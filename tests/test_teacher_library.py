"""Unit tests for Teacher Library ('我的题库' / '我的题单' / '我的题目')."""

import unittest
from fastapi.testclient import TestClient
import service
from service import app, db, q

class TeacherLibraryTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)
        self.teacher = 'cm_pilot_teacher'
        self.client.post('/api/session', json={'userId': self.teacher})

    def test_student_cannot_access_library(self):
        client = TestClient(app)
        client.post('/api/session', json={'userId': 'cm_pilot_student'})
        resp = client.get('/api/teacher/library')
        self.assertEqual(resp.status_code, 403)

    def test_get_teacher_library(self):
        resp = self.client.get('/api/teacher/library')
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertIn('sets', data)
        self.assertIn('problems', data)
        self.assertIn('offerings', data)
        self.assertIn('stats', data)
        self.assertIn('totalSets', data['stats'])
        self.assertIn('totalProblems', data['stats'])

    def test_create_and_delete_library_set(self):
        # 1. Create a blank set
        resp = self.client.post('/api/teacher/library/sets', json={
            'title': '测试自建题单_Library'
        })
        self.assertEqual(resp.status_code, 200)
        draft = resp.json()
        self.assertIn('id', draft)
        self.assertEqual(draft['status'], 'draft')
        draft_id = draft['id']

        # 2. Verify it shows up in library
        resp = self.client.get('/api/teacher/library')
        self.assertEqual(resp.status_code, 200)
        sets = resp.json()['sets']
        found = next((s for s in sets if s['draftId'] == draft_id), None)
        self.assertIsNotNone(found)
        self.assertEqual(found['title'], '测试自建题单_Library')

        # 3. Delete the draft
        resp = self.client.delete(f'/api/drafts/{draft_id}')
        self.assertEqual(resp.status_code, 200)
        self.assertTrue(resp.json()['ok'])

        # 4. Verify it is gone
        resp = self.client.get(f'/api/drafts/{draft_id}')
        self.assertEqual(resp.status_code, 404)

    def test_import_yaml_into_library(self):
        yaml_content = """title: 个人题库测试YAML题单
problems:
  - slug: test-lib-p1
    title: 个人题库测试题目一
    statement: "题目描述内容，计算平方。"
    knowledge:
      - 快速幂
    samples:
      - input: "3\n"
        output: "9\n"
    tests:
      - input: "5\n"
        output: "25\n"
"""
        resp = self.client.post('/api/teacher/library/sets', json={
            'content': yaml_content
        })
        self.assertEqual(resp.status_code, 200)
        draft = resp.json()
        draft_id = draft['id']

        # Check library problems view
        resp = self.client.get('/api/teacher/library')
        self.assertEqual(resp.status_code, 200)
        problems = resp.json()['problems']
        prob = next((p for p in problems if p['slug'] == 'test-lib-p1'), None)
        self.assertIsNotNone(prob)
        self.assertEqual(prob['title'], '个人题库测试题目一')
        self.assertEqual(prob['knowledge'], ['快速幂'])

        # Clean up
        self.client.delete(f'/api/drafts/{draft_id}')

    def test_deploy_set_to_offering(self):
        # Create a valid set with hidden tests
        yaml_content = """title: 待发布测试题单
problems:
  - slug: test-deploy-p1
    title: 测试发布试题
    statement: "简单输出加一。"
    knowledge:
      - 基础
    samples:
      - input: "1\n"
        output: "2\n"
    tests:
      - input: "10\n"
        output: "11\n"
"""
        resp = self.client.post('/api/teacher/library/sets', json={
            'content': yaml_content
        })
        self.assertEqual(resp.status_code, 200)
        draft_id = resp.json()['id']

        # Deploy to Offering 10 (taught by cm_pilot_teacher)
        resp = self.client.post('/api/teacher/library/deploy', json={
            'draftId': draft_id,
            'offeringIds': [10],
            'aiEnabled': True
        })
        self.assertEqual(resp.status_code, 200)
        deploy_res = resp.json()
        self.assertTrue(deploy_res['ok'])
        self.assertEqual(len(deploy_res['results']), 1)
        self.assertEqual(deploy_res['results'][0]['offeringId'], 10)
        self.assertIn('batchId', deploy_res['results'][0])

    def test_offering_problem_sets_includes_my_problem_sets(self):
        resp = self.client.get('/api/offerings/10/problem-sets')
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertIn('myProblemSets', data)
        self.assertIsInstance(data['myProblemSets'], list)
