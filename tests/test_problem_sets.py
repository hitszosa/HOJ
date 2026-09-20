import os
import sys
import unittest
from pathlib import Path
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import service

class ProblemSetsEndpointsTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(service.app)
        os.environ['COURSE_DEV_LOGIN'] = '1'

    def test_get_problem_sets_for_comp2014(self):
        # teacher_wang teaches offering 35 (COMP2014 C++语言程序设计)
        self.client.post('/api/session', json={'userId': 'teacher_wang'})
        resp = self.client.get('/api/offerings/35/problem-sets')
        self.assertEqual(resp.status_code, 200)
        data = resp.json()

        self.assertEqual(data['courseCode'], 'COMP2014')
        self.assertIn('C++', data['courseName'])
        self.assertEqual(len(data['allCategories']), 24)

        # COMP2014 syllabus has 6 categories: 07-strings, 08-functions, 10-struct-pointer, 13-linear-list, 14-stack-queue, 16-heap-priority
        recommended_codes = [c['code'] for c in data['recommendedCategories']]
        self.assertIn('07-strings', recommended_codes)
        self.assertIn('08-functions', recommended_codes)
        self.assertIn('14-stack-queue', recommended_codes)
        self.assertIn('16-heap-priority', recommended_codes)
        self.assertNotIn('01-basic-io', recommended_codes)  # not in COMP2014 syllabus

        # Each recommended category has preview problems
        cat07 = next(c for c in data['recommendedCategories'] if c['code'] == '07-strings')
        self.assertTrue(len(cat07['problems']) > 0)
        self.assertIn('slug', cat07['problems'][0])
        self.assertIn('title', cat07['problems'][0])

        # Contest sets available
        self.assertTrue(len(data['contestSets']) > 0)

    def test_get_problem_sets_for_comp1007(self):
        # teacher_su teaches offering 1 (COMP1007 程序设计基础)
        self.client.post('/api/session', json={'userId': 'teacher_su'})
        resp = self.client.get('/api/offerings/1/problem-sets')
        self.assertEqual(resp.status_code, 200)
        data = resp.json()

        self.assertEqual(data['courseCode'], 'COMP1007')
        recommended_codes = [c['code'] for c in data['recommendedCategories']]
        self.assertIn('01-basic-io', recommended_codes)
        self.assertIn('02-branching', recommended_codes)
        self.assertIn('03-loops', recommended_codes)
        self.assertIn('07-strings', recommended_codes)
        self.assertIn('08-functions', recommended_codes)
        self.assertTrue(len(recommended_codes) >= 8)

    def test_import_set_whole(self):
        self.client.post('/api/session', json={'userId': 'teacher_wang'})
        resp = self.client.post('/api/offerings/35/import-set', json={'setId': 'cat:13-linear-list'})
        self.assertEqual(resp.status_code, 200)
        draft = resp.json()
        self.assertIn('id', draft)
        self.assertEqual(draft['status'], 'draft')
        doc = draft['document']
        self.assertIn('problems', doc)
        self.assertEqual(len(doc['problems']), 5)

        # Check that hidden tests and samples are properly formatted
        for p in doc['problems']:
            self.assertTrue(len(p['samples']) >= 1)
            self.assertTrue(len(p['tests']) >= 1)
            sample_pairs = {(s['input'], s['output']) for s in p['samples']}
            # Hidden test covers input outside samples
            self.assertFalse(all((t['input'], t['output']) in sample_pairs for t in p['tests']))

    def test_import_set_selected_slugs(self):
        self.client.post('/api/session', json={'userId': 'teacher_wang'})
        resp = self.client.post('/api/offerings/35/import-set', json={
            'setId': 'cat:07-strings',
            'selectedSlugs': ['07-strings-p01', '07-strings-p02'],
            'title': '精选字符串基础练习'
        })
        self.assertEqual(resp.status_code, 200)
        draft = resp.json()
        doc = draft['document']
        self.assertEqual(doc['title'], '精选字符串基础练习')
        self.assertEqual(len(doc['problems']), 2)
        slugs = [p['slug'] for p in doc['problems']]
        self.assertIn('07-strings-p01', slugs)
        self.assertIn('07-strings-p02', slugs)

    def test_import_multi_sets(self):
        self.client.post('/api/session', json={'userId': 'teacher_wang'})
        items = [
            {'setId': 'cat:07-strings', 'slug': '07-strings-p01'},
            {'setId': 'cat:07-strings', 'slug': '07-strings-p02'},
            {'setId': 'cat:08-functions', 'slug': '08-functions-p01-minval'},
            {'setId': 'set:LANQIAO-B01', 'slug': 'lanqiao-b01-p01'}
        ]
        resp = self.client.post('/api/offerings/35/import-set', json={
            'items': items,
            'title': 'C++ 跨集合多选作业'
        })
        self.assertEqual(resp.status_code, 200)
        draft = resp.json()
        self.assertEqual(draft['count'], 4)
        doc = draft['document']
        self.assertEqual(doc['title'], 'C++ 跨集合多选作业')
        self.assertEqual(len(doc['problems']), 4)
        self.assertEqual(doc['problems'][0]['slug'], '07-strings-p01')
        self.assertEqual(doc['problems'][2]['slug'], '08-functions-p01-minval')
        self.assertEqual(doc['problems'][3]['slug'], 'lanqiao-b01-p01')
        self.assertIn('bank:07-strings,08-functions,LANQIAO-B01', doc['source_ref'])


    def test_unauthorized_teacher_access_rejected(self):
        # teacher_ren is not teacher of offering 35
        self.client.post('/api/session', json={'userId': 'teacher_ren'})
        resp1 = self.client.get('/api/offerings/35/problem-sets')
        self.assertEqual(resp1.status_code, 404)

        resp2 = self.client.post('/api/offerings/35/import-set', json={'setId': 'cat:07-strings'})
        self.assertEqual(resp2.status_code, 404)

    def test_archived_offering_write_rejected(self):
        # offering 11 is archived
        self.client.post('/api/session', json={'userId': 'cm_pilot_teacher'})
        resp = self.client.post('/api/offerings/11/import-set', json={'setId': 'cat:07-strings'})
    def test_problem_sets_tree_and_list(self):
        # Unauthenticated returns 401
        self.client.cookies.clear()
        self.assertEqual(self.client.get('/api/problem-sets/tree').status_code, 401)
        self.assertEqual(self.client.get('/api/problem-sets').status_code, 401)

        # Authenticated student can browse tree
        self.client.post('/api/session', json={'userId': 'student_li'})
        resp = self.client.get('/api/problem-sets/tree')
        self.assertEqual(resp.status_code, 200)
        tree = resp.json()
        self.assertEqual(tree['totalProblems'], 2148)
        self.assertEqual(tree['totalSets'], 48)
        self.assertEqual(len(tree['pillars']), 5)
        self.assertEqual(tree['root']['name'], '算法题库全景分类体系')
        self.assertEqual(len(tree['root']['children']), 5)

        # All 5 pillars exist with correct names
        pillar_names = [p['name'] for p in tree['pillars']]
        self.assertIn('1. 基础与语言入门', pillar_names)
        self.assertIn('2. 核心数据结构', pillar_names)
        self.assertIn('3. 算法思想与进阶', pillar_names)
        self.assertIn('4. 数学与数论专项', pillar_names)
        self.assertIn('5. 竞赛真题与等级认证', pillar_names)

        # Flat problem-sets endpoint returns all 48 sets (24 categories + 24 standalone)
        resp_list = self.client.get('/api/problem-sets')
        self.assertEqual(resp_list.status_code, 200)
        data = resp_list.json()
        cats = data['categories']
        sets = data['standalone_sets']
        self.assertEqual(len(cats) + len(sets), 48)
        total_p = sum(c['count'] for c in cats) + sum(s['count'] for s in sets)
        self.assertEqual(total_p, 2148)

    def test_publish_to_multiple_offerings(self):
        self.client.post('/api/session', json={'userId': 'teacher_wang'})
        # Empty offeringIds rejected
        r1 = self.client.post('/api/problem-sets/publish-to-offerings', json={
            'items': [{'setId': 'cat:07-strings', 'slug': '07-strings-p01'}],
            'offeringIds': []
        })
        self.assertEqual(r1.status_code, 422)

        # Multi-offering draft creation (teacher_wang teaches offering 35)
        r2 = self.client.post('/api/problem-sets/publish-to-offerings', json={
            'items': [
                {'setId': 'cat:07-strings', 'slug': '07-strings-p01'},
                {'setId': 'cat:08-functions', 'slug': '08-functions-p01-minval'}
            ],
            'offeringIds': [35],
            'title': '跨分类测试草稿',
            'action': 'draft'
        })
        self.assertEqual(r2.status_code, 200)
        res = r2.json()
        self.assertTrue(res['ok'])
        self.assertEqual(res['problemCount'], 2)
        self.assertEqual(res['offeringCount'], 1)
        self.assertEqual(res['results'][0]['status'], 'draft')

    def test_publish_with_allowed_languages(self):
        self.client.post('/api/session', json={'userId': 'teacher_wang'})
        # Publish with restricted languages ['c', 'cpp']
        resp = self.client.post('/api/problem-sets/publish-to-offerings', json={
            'items': [{'setId': 'cat:07-strings', 'slug': '07-strings-p01'}],
            'offeringIds': [35],
            'title': 'C/C++专项作业',
            'allowedLanguages': ['c', 'cpp'],
            'action': 'publish'
        })
        self.assertEqual(resp.status_code, 200)
        res = resp.json()
        batch_id = res['results'][0]['batchId']

        # Query batch and check allowedLanguages
        batch_resp = self.client.get(f'/api/batches/{batch_id}')
        self.assertEqual(batch_resp.status_code, 200)
        b = batch_resp.json()['batch']
        self.assertEqual(b['allowed_languages'], 'c,cpp')
        self.assertEqual(b['allowedLanguages'], ['c', 'cpp'])

        # Student enrolled in offering 35 submits python code -> should be rejected with 400
        # Student user enrolled in offering 35 is student_auto01
        self.client.post('/api/session', json={'userId': 'student_auto01'})
        # Find problem_id in this batch
        problems = batch_resp.json()['problems']
        pid = problems[0]['problem_id']
        sub_resp = self.client.post(f'/api/batches/{batch_id}/problems/{pid}/submissions', json={
            'code': 'print("hello world")',
            'language': 'python'
        })
        self.assertEqual(sub_resp.status_code, 400)
        self.assertIn('该作业限制仅允许使用以下语言提交', sub_resp.json()['detail'])

    def test_category_bank_problem_solve_and_status(self):
        self.client.post('/api/session', json={'userId': 'student_auto01'})
        # 1. Test /api/problem-sets/my-status
        status_resp = self.client.get('/api/problem-sets/my-status')
        self.assertEqual(status_resp.status_code, 200)
        self.assertIsInstance(status_resp.json(), dict)

        # 2. Test getting problem by slug
        prob_resp = self.client.get('/api/public-problems/01-basic-io-p01')
        self.assertEqual(prob_resp.status_code, 200)
        prob = prob_resp.json()
        self.assertEqual(prob['slug'], '01-basic-io-p01')
        self.assertEqual(prob['title'], '单词翻转')
        self.assertIn('description', prob)
        self.assertTrue(len(prob['samples']) > 0)

        # 3. Test submitting solution by slug
        sub_resp = self.client.post('/api/public-problems/01-basic-io-p01/submissions', json={
            'code': 'import sys\nfor line in sys.stdin:\n    print(line)\n',
            'language': 'python'
        })
        self.assertEqual(sub_resp.status_code, 200)
        sid = sub_resp.json().get('submissionId')
        self.assertIsNotNone(sid)

if __name__ == '__main__':
    unittest.main()
