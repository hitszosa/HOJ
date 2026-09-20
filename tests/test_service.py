import copy
import os
import sys
from pathlib import Path
import unittest
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from fastapi import HTTPException
from fastapi.testclient import TestClient
import service

DOC={'title':'体验作业 · 两个整数的和','problems':[{'slug':'sum-two','title':'两个整数的和','statement':'输入两个整数 a 和 b，输出它们的和。范围：-1000000 ≤ a,b ≤ 1000000。','samples':[{'input':'1 2\n','output':'3\n'}],'tests':[{'input':'-2 5\n','output':'3\n'},{'input':'0 0\n','output':'0\n'},{'input':'1000000 1000000\n','output':'2000000\n'}]}]}
class ValidationTests(unittest.TestCase):
 def test_xml_entities_rejected(self):
  with self.assertRaises(HTTPException): service.parse_document('<!DOCTYPE x [<!ENTITY x SYSTEM "file:///etc/passwd">]><fps/>')
 def test_duplicate_slug_rejected(self):
  doc=copy.deepcopy(DOC);doc['problems']*=2
  with self.assertRaises(HTTPException):service.validate_document(doc)
 def test_sql_literals_are_encoded_not_interpolated(self):
  text="x'; DELETE FROM users;--"
  self.assertNotIn(text,service.q(text))
 def test_production_dev_login_disabled(self):
  with patch.dict(os.environ,{'COURSE_DEV_LOGIN':'0'}):
   self.assertEqual(403,TestClient(service.app).post('/api/session',json={'role':'teacher'}).status_code)
 def test_unauthenticated_and_cross_site_requests_rejected(self):
  c=TestClient(service.app)
  self.assertEqual(401,c.get('/api/courses').status_code)
  self.assertEqual(403,c.post('/api/session',headers={'origin':'https://attacker.invalid'},json={'role':'teacher'}).status_code)
 def test_forged_cookie_rejected(self):
  c=TestClient(service.app);c.cookies.set('course_session','e30=.fake')
  self.assertEqual(401,c.get('/api/courses').status_code)

@unittest.skipUnless(os.environ.get('COURSE_LIVE_TEST')=='1','set COURSE_LIVE_TEST=1 for isolated local pilot integration')
class LiveTests(unittest.TestCase):
 @classmethod
 def setUpClass(cls):
  os.environ['COURSE_DEV_LOGIN']='1'
  cls.teacher=TestClient(service.app);cls.teacher.post('/api/session',json={'role':'teacher'})
  cls.student=TestClient(service.app);cls.student.post('/api/session',json={'role':'student'})
  cls.outsider=TestClient(service.app);cls.outsider.post('/api/session',json={'role':'outsider'})
  cls.ta=TestClient(service.app);cls.ta.post('/api/session',json={'role':'ta'})
  offerings=[r for r in cls.teacher.get('/api/courses').json() if r.get('code')=='PILOT1007' and r.get('status')=='active']
  if not offerings: raise unittest.SkipTest('未找到 code=PILOT1007 且 active 的教学班，跳过真实库回归')
  cls.oid=int(offerings[0]['offering_id'])
 def test_complete_teaching_flow_and_permissions(self):
  saved=self.teacher.post(f'/api/offerings/{self.oid}/drafts',json={'document':DOC})
  self.assertEqual(200,saved.status_code,saved.text);did=saved.json()['id']
  self.assertEqual(403,self.student.get(f'/api/drafts/{did}').status_code)
  self.assertEqual(403,self.ta.post(f'/api/offerings/{self.oid}/drafts',json={'document':DOC}).status_code)
  self.assertEqual(404,self.outsider.get(f'/api/offerings/{self.oid}').status_code)
  self.assertEqual(422,self.teacher.post(f'/api/drafts/{did}/publish',json={}).status_code)
  pub=self.teacher.post(f'/api/drafts/{did}/publish',json={'reviewed':True})
  self.assertEqual(200,pub.status_code,pub.text);bid=pub.json()['batchId']
  self.assertEqual(bid,self.teacher.post(f'/api/drafts/{did}/publish',json={'reviewed':True}).json()['batchId'])
  batch=self.student.get(f'/api/batches/{bid}').json();pid=int(batch['problems'][0]['problem_id'])
  self.assertEqual(403,self.teacher.post(f'/api/batches/{bid}/problems/{pid}/submissions',json={'code':'x','language':'python'}).status_code)
  sub=self.student.post(f'/api/batches/{bid}/problems/{pid}/submissions',json={'code':'a,b=map(int,input().split())\nprint(a+b)\n','language':'python'})
  self.assertEqual(200,sub.status_code,sub.text);sid=sub.json()['submissionId']
  import time
  for _ in range(30):
   r=self.student.get(f'/api/submissions/{sid}')
   if int(r.json()['result']) not in (0,1,2,3,14):break
   time.sleep(.5)
  self.assertEqual('4',r.json()['result'],r.text)
  self.assertEqual(404,self.outsider.get(f'/api/submissions/{sid}').status_code)
  self.assertEqual(200,self.student.get(f'/api/submissions/{sid}/analysis').status_code)
  self.teacher.patch(f'/api/batches/{bid}',json={'aiEnabled':False})
  self.assertEqual(403,self.student.get(f'/api/submissions/{sid}/analysis').status_code)
  self.teacher.patch(f'/api/batches/{bid}',json={'aiEnabled':True})
  self.assertEqual(403,self.student.get(f'/api/offerings/{self.oid}/insights').status_code)
  self.assertEqual(200,self.ta.get(f'/api/offerings/{self.oid}/insights').status_code)
  self.assertEqual(422,self.teacher.post(f'/api/batches/{bid}/export',json={'selected':[]}).status_code)
  exported=self.teacher.post(f'/api/batches/{bid}/export',json={'selected':[pid]})
  self.assertEqual(200,exported.status_code,exported.text)
  self.assertNotIn('tests:',exported.json()['content'])
  self.assertNotIn('source_code',exported.json()['content'])
  print(f'LIVE VERIFIED offering={self.oid} batch={bid} problem={pid} submission={sid} verdict=AC')
 def test_samples_alone_never_publish(self):
  doc=copy.deepcopy(DOC);doc['problems'][0]['tests']=doc['problems'][0]['samples']
  did=self.teacher.post(f'/api/offerings/{self.oid}/drafts',json={'document':doc}).json()['id']
  r=self.teacher.post(f'/api/drafts/{did}/publish',json={'reviewed':True})
  self.assertEqual(422,r.status_code)

if __name__=='__main__':unittest.main()
