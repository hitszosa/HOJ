"""Unit tests for previous AC detection and one-click prefill functionality (方案 A)."""

import os
import unittest
from fastapi.testclient import TestClient
import service
from service import app, db, q

class PreviousAcTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)
        self.student = 'cm_pilot_student'
        self.client.post('/api/session', json={'userId': self.student})

    def test_no_previous_ac(self):
        # Offering 1, Batch 10, Problem 1025
        resp = self.client.get('/api/batches/10/problems/1025')
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertIn('previousAc', data)
        # Verify previousAc structure
        if data['previousAc'] is not None:
            self.assertTrue(data['previousAc']['hasPreviousAc'])
            self.assertIn('code', data['previousAc'])
            self.assertIn('language', data['previousAc'])

    def test_previous_ac_smart_match(self):
        # Insert a mock problem and mock AC solution for cm_pilot_student
        slug = 'test-ac-slug-999'
        source_bank = f'bank:{slug}'
        db.write(f"""
            INSERT INTO jol.problem (title, description, source, in_date, defunct)
            VALUES ('特异匹配测试题', '测试题描述', {q(source_bank)}, NOW(), 'N')
            ON DUPLICATE KEY UPDATE defunct='N';
        """, ops=True)
        bank_p = db.one(f"SELECT problem_id FROM jol.problem WHERE source={q(source_bank)}")
        bank_pid = int(bank_p['problem_id'])

        # Insert AC solution for student in Python
        code_content = "print('hello previous ac')"
        db.write(f"""
            INSERT INTO jol.solution(problem_id, user_id, in_date, language, result, time, memory, code_length, ip)
            VALUES({bank_pid}, {q(self.student)}, NOW(), 6, 4, 12, 1024, {len(code_content)}, '127.0.0.1');
            SET @sid = LAST_INSERT_ID();
            INSERT INTO jol.source_code(solution_id, source) VALUES(@sid, {q(code_content)});
        """, ops=True)

        # Now test find_user_previous_ac with a batch problem row that has the same slug
        batch_prob_row = {
            'problem_id': 99999,
            'source': f'codemind:authoring/fakeident/{slug}',
            'title': '特异匹配测试题'
        }
        res = service.find_user_previous_ac(self.student, batch_prob_row, allowed_languages=['python', 'cpp'])
        self.assertIsNotNone(res)
        self.assertTrue(res['hasPreviousAc'])
        self.assertEqual(res['language'], 'python')
        self.assertEqual(res['code'], code_content)
        self.assertEqual(res['time'], 12)
        self.assertTrue(res['isLanguageAllowed'])

        # Test with language restriction where python is disallowed
        res_disallowed = service.find_user_previous_ac(self.student, batch_prob_row, allowed_languages=['c', 'cpp'])
        self.assertIsNotNone(res_disallowed)
        self.assertFalse(res_disallowed['isLanguageAllowed'])

if __name__ == '__main__':
    unittest.main()
