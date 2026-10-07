#!/usr/bin/env python3
"""Real grading checks on a disposable, uniquely named remote class.

Usage: python3 deploy/remote/smoke.py <base-url> <private-admin-json> <output-dir>
The output directory contains IDs needed to remove only this run's test data.
"""
import csv
import importlib.util
import io
import json
import os
from pathlib import Path
import secrets
import sys
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('client', ROOT / 'deploy/local/admin-smoke.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.BASE = sys.argv[1].rstrip('/')
OUT = Path(sys.argv[3])
OUT.mkdir(parents=True, exist_ok=True)

class Client(module.Client):
    def request(self, path, method='GET', body=None, origin='default', cookie=None):
        headers={'Content-Type':'application/json'}
        if origin is not None:
            headers['Origin']=module.BASE if origin=='default' else origin
        if cookie is not None:
            headers['Cookie']=cookie
        for c in self.jar:
            if c.name=='csrftoken':
                headers['X-CSRFTOKEN']=urllib.parse.unquote(c.value)
        transport=os.environ.get('HOJ_TEST_CONNECT_URL',module.BASE).rstrip('/')
        request=urllib.request.Request(transport+path,None if body is None else json.dumps(body).encode(),headers,method=method)
        try:
            response=self.http.open(request,timeout=20)
        except urllib.error.HTTPError as error:
            response=error
        data=response.read()
        return response.status,json.loads(data) if data and response.headers.get_content_type()=='application/json' else data

def attachment_checks(admin,first,fixture,save,check):
    # The management module also supports ordinary teaching attachments and grading.
    assignment=admin.ok('/management-api/assignments/'+str(fixture['assignment_id'])) if fixture.get('assignment_id') else admin.ok('/management-api/assignments','POST',{'course':fixture['course_id'],
        'title':'临时部署验证附件','due_time':'2030-01-01T00:00:00Z',
        'start_time':'2026-01-01T00:00:00Z','max_file_size':1048576,'show_score':True})
    aid=assignment['id'];fixture['assignment_id']=aid;save()
    admin.ok(f'/management-api/assignments/{aid}','PATCH',{'published':True,'allowed_extension':'txt','score':100})
    capability=first.ok('/management-api/files/touch','POST',{
        'original_file_name':'deployment-check.txt','ident':{'type':'submission','assignment_id':aid}})
    ident=capability['ident'];fixture['file_ident']=ident;save()
    check('Upload URL is accessible on the remote server',capability['url'].startswith(module.BASE.rsplit(':',1)[0]+':9002/'))
    boundary='hoj-'+secrets.token_hex(12)
    payload=b'HOJ deployment storage roundtrip\n'
    body=b''
    for key,value in capability['params'].items():
        body+=f'--{boundary}\r\nContent-Disposition: form-data; name="{key}"\r\n\r\n{value}\r\n'.encode()
    body+=f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="deployment-check.txt"\r\nContent-Type: text/plain\r\n\r\n'.encode()+payload+f'\r\n--{boundary}--\r\n'.encode()
    http=urllib.request.build_opener(urllib.request.ProxyHandler({}))
    def storage_request(url, data=None, headers=None, method='GET'):
        parsed=urllib.parse.urlsplit(url)
        headers=dict(headers or {})
        transport=os.environ.get('HOJ_TEST_STORAGE_CONNECT_URL')
        if transport:
            target=urllib.parse.urlsplit(transport)
            headers['Host']=parsed.netloc
            url=urllib.parse.urlunsplit((target.scheme,target.netloc,parsed.path,parsed.query,parsed.fragment))
        return urllib.request.Request(url,data,headers,method=method)
    request=storage_request(capability['url'],body,{'Content-Type':'multipart/form-data; boundary='+boundary},method='POST')
    with http.open(request,timeout=20) as response:
        check('Signed object upload succeeds',response.status in [200,201,204])
    check('Upload completion validates stored object',first.request('/management-api/files/finish','POST',{'ident':ident})[0]==200)
    submitted=first.ok(f'/management-api/submissions?assignment={aid}&file_ident={ident}','POST',{})
    fixture['management_submission_id']=submitted['id'];save()
    admin.ok('/management-api/submissions/score_update','POST',{'submission':submitted['id'],'score':70})
    grading=admin.ok(f'/management-api/assignments/{aid}/grading/report')
    check('Teaching attachment grade and missing roster exported',len(grading)==3 and sum(r['score']==70 for r in grading)==1 and sum(r['submission_id'] is None for r in grading)==2)
    check('Student cannot grade attachments',first.request('/management-api/submissions/score_update','POST',{'submission':submitted['id'],'score':99})[0]==403)
    download=admin.ok('/management-api/files/download','POST',{'ident':ident})
    with http.open(storage_request(download['url']),timeout=20) as response:
        check('Teacher downloads original attachment',response.read()==payload)
    try:
        http.open(storage_request(download['url'].split('?',1)[0]),timeout=10)
        private=False
    except urllib.error.HTTPError as error:
        private=error.code==403
    check('Object storage rejects anonymous download',private)
    check('PDF grading endpoint absent',admin.request(f'/management-api/submissions/{submitted["id"]}/grading/document','POST',{})[0]==404)

def main():
    account = json.loads(Path(sys.argv[2]).read_text())
    checks, submissions, checkpoints = [], [], []
    def check(label, passed):
        assert passed, label
        checks.append(label)
    admin = Client()
    check('Cross-site login rejected', admin.request('/api/account/login', 'POST', account, origin='https://untrusted.invalid')[0] == 403)
    check('Development login disabled', admin.request('/api/session', 'POST', {'user_id':'admin'})[0] == 403)
    check('Native login succeeds with remote Origin', admin.login(account['username'], account['password'])[0] == 200)
    me = admin.ok('/api/me')['data']
    check('Admin has teacher and administrator roles', {'admin','teacher'} <= set(me['roles']))
    profile = admin.ok('/management-api/auth/current_user')
    check('One login works across both modules', profile['username'] == 'admin' and profile['role'] == 2)
    for path in ['/oj/status.php','/oj/admin/','/status.php','/admin/']:
        status, data = admin.request(path)
        check('Legacy entry not exposed: '+path, status in [404,410] or (isinstance(data,bytes) and b'HUSTOJ' not in data and b'loginpage.php' not in data))
    previous = json.loads((OUT/'fixture.json').read_text()) if (OUT/'fixture.json').exists() else {}
    if '--resume-attachments' in sys.argv:
        fixture=json.loads((OUT/'fixture.json').read_text())
        checks[:]=fixture['checks']
        def save():
            fixture['checks']=checks
            (OUT/'fixture.json').write_text(json.dumps(fixture,ensure_ascii=False,indent=2))
        first=Client()
        check('Imported student login after transmission repair',first.login(fixture['students'][0],fixture['students'][0])[0]==200)
        check('Attachment student obtains management session',first.ok('/management-api/auth/current_user')['role']==0)
        final=sorted(admin.ok(f"/api/offerings/{fixture['offering_id']}/grades")['data'],key=lambda r:r['user_id'])
        check('Verified final native grades before attachment resume',[r['score'] for r in final]==[100,70,0])
        for row in fixture['submissions']:
            check('Rechecked actual C++ result '+str(row['id']),admin.ok('/api/submissions/'+str(row['id']))['data']['result']==row['expected'])
        attachment_checks(admin,first,fixture,save,check)
        report={'passed':len(checks),'checks':checks,'fixture':fixture,'submissions':fixture['submissions'],'final_grades':final}
        (OUT/'result.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
        print(json.dumps({'passed':len(checks),'scores':[r['score'] for r in final]},ensure_ascii=False))
        return
    if previous.get('submissions'):
        raise SystemExit('This test directory already has submissions; use a fresh directory.')
    prefix = previous.get('prefix') or 'probe_' + secrets.token_hex(8)
    students = [prefix + suffix for suffix in ['_a','_b','_c']]
    fixture = {**previous,'prefix':prefix,'students':students,'checks':checks,'base_url':module.BASE}
    def save():
        path=OUT/'fixture.json'
        path.write_text(json.dumps(fixture,ensure_ascii=False,indent=2));path.chmod(0o600)
    save()
    users = [admin.ok('/management-api/users/'+str(i)) for i in previous['student_ids']] if previous.get('student_ids') else admin.ok('/management-api/users/batch_create','POST',[
        {'username':u,'real_name':'部署验证学生'+str(i+1),'role':0,'password_expired':False}
        for i,u in enumerate(students)])
    fixture['student_ids']=[u['id'] for u in users];save()
    check('Roster batch import creates three students',len(users)==3)
    clients=[Client() for _ in students]
    for c,u in zip(clients,students):
        check('Imported account has shared login: '+u,c.login(u,u)[0]==200)
        check('Imported student role is preserved',c.ok('/management-api/auth/current_user')['role']==0)
    course=admin.ok('/management-api/courses/'+str(previous['course_id'])) if previous.get('course_id') else admin.ok('/management-api/courses','POST',{'title':'临时部署验证班 '+prefix,'year':2026,'term':2,'teacher_ids':[profile['id']],'student_ids':fixture['student_ids'],'assistant_ids':[]})
    fixture['course_id']=course['id'];save()
    link=next(l for l in admin.ok('/management-api/hoj/links') if l['course_id']==course['id'])
    oid=link['offering_id'];fixture['offering_id']=oid;save()
    check('Course and roster synchronized',admin.ok(f'/api/offerings/{oid}')['data']['total_students']==3)
    doc={'title':'部署验证：30/70 权重','problems':[
        {'slug':slug,'title':title,'score':weight,'statement':'输入两个整数 a、b，输出'+title+'。','samples':[{'input':'1 2\n','output':sample}],
         'tests':[{'input':'10 3\n','output':hidden},{'input':'-4 2\n','output':other}],'knowledge':['算术']}
        for slug,title,weight,sample,hidden,other in [('sum','两数之和',30,'3\n','13\n','-2\n'),('difference','两数之差',70,'-1\n','7\n','-6\n')]]}
    draft=admin.ok('/api/drafts/'+previous['draft_id'])['data'] if previous.get('draft_id') else admin.ok(f'/api/offerings/{oid}/drafts','POST',{'document':doc})['data']
    draft['id']=draft.get('id') or draft['draft_id']
    fixture['draft_id']=draft['id'];save()
    published=admin.ok('/api/drafts/'+draft['id']+'/publish','POST',{'reviewed':True,'ai_enabled':False,'allowed_languages':['cpp']})['data']
    bid=published['batch_id'];fixture['batch_id']=bid;save()
    detail=admin.ok(f'/api/batches/{bid}')['data'];pids=[p['problem_id'] for p in detail['problems']]
    fixture['problem_ids']=pids;save()
    check('Published weights persisted',[p['score'] for p in detail['problems']]==[30,70])
    first,second,absent=clients
    def weights(a,b):
        return {'problem_weights':[{'problem_id':p,'score':v} for p,v in zip(pids,[a,b])]}
    for w in [weights(0,0),weights(-1,70),weights(1000,70),weights(.001,70),{'problem_weights':[]}]:
        check('Invalid weights rejected',admin.request(f'/api/batches/{bid}','PATCH',w)[0]==422)
    check('Student cannot change weights',first.request(f'/api/batches/{bid}','PATCH',weights(99,1))[0]==403)
    check('Student cannot export all grades',first.request(f'/api/offerings/{oid}/grades/export')[0]==403)
    def scores(label, expected):
        rows=admin.ok(f'/api/offerings/{oid}/grades')['data']
        rows=sorted([r for r in rows if r['batch_id']==bid],key=lambda r:r['user_id'])
        check(label,[r['score'] for r in rows]==expected)
        checkpoints.append({'label':label,'grades':rows})
        for c,row in zip(clients,rows):
            ps=c.ok(f'/api/batches/{bid}')['data']['problems']
            total=sum(p['score'] for p in ps if p['required'])
            calculated=round(sum(p['score'] for p in ps if p['required'] and p['passed'])*100/total,2)
            check('Student and teacher scores agree',calculated==row['score'])
        return rows
    def submit(client,pid,code,result):
        sid=client.ok(f'/api/batches/{bid}/problems/{pid}/submissions','POST',{'language':'cpp','code':code})['data']['submission_id']
        submissions.append({'id':sid,'expected':result});fixture['submissions']=submissions;save()
        deadline=time.monotonic()+90
        while time.monotonic()<deadline:
            data=client.ok(f'/api/submissions/{sid}')['data']
            if data['result'] not in [0,1,2,3,14]:break
            time.sleep(.5)
        submissions[-1]['result']=data['result'];save()
        check(f'Real C++ judge {sid}: expected result {result}',data['result']==result)
    code=lambda op:'#include <iostream>\nusing namespace std;\nint main(){long long a,b;cin>>a>>b;cout<<(a'+op+'b)<<"\\n";}\n'
    scores('Initially zero',[0,0,0])
    submit(first,pids[0],code('+'),4)
    submit(second,pids[1],code('-'),4)
    scores('Partial AC earns 30 and 70',[30,70,0])
    submit(second,pids[0],code('-'),6)
    submit(second,pids[0],'int main( {\n',11)
    scores('WA and CE earn no points',[30,70,0])
    submit(first,pids[0],code('+'),4)
    scores('Repeated AC counted once',[30,70,0])
    admin.ok(f'/api/batches/{bid}','PATCH',weights(50,50));scores('Existing grades recalculate',[50,50,0])
    admin.ok(f'/api/batches/{bid}','PATCH',weights(0,70));scores('Zero-weight problem excluded',[0,100,0])
    admin.ok(f'/api/batches/{bid}','PATCH',weights(30,70))
    submit(first,pids[1],code('-'),4)
    scores('All AC earns full score',[100,70,0])
    submit(first,pids[0],code('-'),6)
    final=scores('Later WA preserves earned AC',[100,70,0])
    check('Teacher can read student source','long long' in admin.ok(f'/api/submissions/{submissions[0]["id"]}/code')['data']['code'])
    check('Other student cannot read source',second.request(f'/api/submissions/{submissions[0]["id"]}/code')[0]==403)
    raw=admin.ok(f'/api/offerings/{oid}/grades/export')
    exported=list(csv.DictReader(io.StringIO(raw.decode('utf-8-sig'))))
    check('Export includes UTF-8 BOM',raw.startswith(b'\xef\xbb\xbf'))
    check('CSV grades agree',[r['成绩（100分）'] for r in exported]==['100','70','0'])
    (OUT/'grades.csv').write_bytes(raw)
    attachment_checks(admin,first,fixture,save,check)
    report={'passed':len(checks),'checks':checks,'fixture':fixture,'submissions':submissions,'checkpoints':checkpoints,'final_grades':final}
    (OUT/'result.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
    print(json.dumps({'passed':len(checks),'scores':[r['score'] for r in final]},ensure_ascii=False))

if __name__=='__main__':
    main()
