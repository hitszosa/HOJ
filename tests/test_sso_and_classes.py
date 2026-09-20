import os
import sys
import unittest
from pathlib import Path
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import service

class SsoAndClassManagementTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(service.app)
        os.environ['COURSE_DEV_LOGIN'] = '1'

    def test_demo_users_endpoint(self):
        resp = self.client.get('/api/demo/users')
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertIn('teachers', data)
        self.assertIn('students', data)
        self.assertIn('ssoSupport', data)
        self.assertTrue(any(t['userId'] == 'teacher_wang' for t in data['teachers']))
        self.assertTrue(any(t['userId'] == 'teacher_ren' for t in data['teachers']))
        self.assertTrue(any(s['userId'] == 'student_cs01' for s in data['students']))

    def test_login_with_specific_user_id(self):
        resp = self.client.post('/api/session', json={'userId': 'teacher_wang'})
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()['user'], 'teacher_wang')

        me_resp = self.client.get('/api/me')
        self.assertEqual(me_resp.status_code, 200)
        self.assertEqual(me_resp.json()['user'], 'teacher_wang')
        self.assertEqual(me_resp.json()['portal'], 'teacher')

    def test_sso_header_authentication(self):
        sso_client = TestClient(service.app)
        # Passing SSO header without any cookie
        resp = sso_client.get('/api/me', headers={'X-Remote-User': 'teacher_ren'})
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertEqual(data['user'], 'teacher_ren')
        self.assertEqual(data['authSource'], 'sso')

    def test_teacher_course_isolation(self):
        # 1. teacher_wang only sees COMP2014
        c_wang = TestClient(service.app)
        c_wang.post('/api/session', json={'userId': 'teacher_wang'})
        courses_wang = c_wang.get('/api/courses').json()
        codes_wang = {c['code'] for c in courses_wang}
        self.assertIn('COMP2014', codes_wang)
        self.assertNotIn('COMP2050', codes_wang)
        self.assertNotIn('COMP2052', codes_wang)

        # 2. teacher_ren only sees COMP2050
        c_ren = TestClient(service.app)
        c_ren.post('/api/session', json={'userId': 'teacher_ren'})
        courses_ren = c_ren.get('/api/courses').json()
        codes_ren = {c['code'] for c in courses_ren}
        self.assertIn('COMP2050', codes_ren)
        self.assertNotIn('COMP2014', codes_ren)
        self.assertNotIn('COMP2052', codes_ren)

        # 3. teacher_xia only sees COMP2052
        c_xia = TestClient(service.app)
        c_xia.post('/api/session', json={'userId': 'teacher_xia'})
        courses_xia = c_xia.get('/api/courses').json()
        codes_xia = {c['code'] for c in courses_xia}
        self.assertIn('COMP2052', codes_xia)
        self.assertNotIn('COMP2014', codes_xia)
        self.assertNotIn('COMP2050', codes_xia)

        # 4. admin sees multiple/all courses
        c_admin = TestClient(service.app)
        c_admin.post('/api/session', json={'userId': 'admin'})
        courses_admin = c_admin.get('/api/courses').json()
        codes_admin = {c['code'] for c in courses_admin}
        self.assertTrue(len(codes_admin) >= 5)
        self.assertIn('COMP2014', codes_admin)
        self.assertIn('COMP2050', codes_admin)
        self.assertIn('COMP2052', codes_admin)

    def test_class_and_student_management(self):
        c_wang = TestClient(service.app)
        c_wang.post('/api/session', json={'userId': 'teacher_wang'})
        courses = c_wang.get('/api/courses').json()
        self.assertTrue(len(courses) > 0)
        oid = courses[0]['offering_id']

        # Get students roster
        roster = c_wang.get(f'/api/offerings/{oid}/students')
        self.assertEqual(roster.status_code, 200)
        data = roster.json()
        self.assertIn('students', data)
        self.assertIn('offering', data)

        # Add a student
        add_resp = c_wang.post(f'/api/offerings/{oid}/students', json={
            'userId': 'test_student_unit_99',
            'studentNo': '20269999',
            'name': '测试学生99',
            'role': 'student'
        })
        self.assertEqual(add_resp.status_code, 200)
        self.assertEqual(add_resp.json()['ok'], True)

        # Verify added student in roster
        roster2 = c_wang.get(f'/api/offerings/{oid}/students').json()
        uids = [s['user_id'] for s in roster2['students']]
        self.assertIn('test_student_unit_99', uids)

        # Drop student
        drop_resp = c_wang.delete(f'/api/offerings/{oid}/students/test_student_unit_99')
        self.assertEqual(drop_resp.status_code, 200)

        # Update offering status
        patch_resp = c_wang.patch(f'/api/offerings/{oid}', json={'title': 'C++程序设计 2026春卓越班'})
        self.assertEqual(patch_resp.status_code, 200)

if __name__ == '__main__':
    unittest.main()
