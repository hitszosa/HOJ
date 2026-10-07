import json,pathlib,re,subprocess
root=pathlib.Path('/opt/hoj');f=json.loads((root/'load-test/fixture.json').read_text())
assert re.fullmatch(r'load_[a-z0-9]+',f['prefix'])
assert len(f['users'])==1000 and all(re.fullmatch(re.escape(f['prefix'])+r'_\d{4}',u['username']) for u in f['users'])
assert f['course_id']>0 and f['offering_id']>0 and f['batch_id']>0 and f['problem_id']>=1000
cmd=['docker','exec','-i','hoj-db-1','sh','-c','MYSQL_PWD="$MARIADB_ROOT_PASSWORD" mariadb -uroot -N -B']
def sql(q):
 r=subprocess.run(cmd,input=q,text=True,capture_output=True,check=True);return r.stdout.strip()
oid=int(f['offering_id']);bid=int(f['batch_id']);mid=int(f['course_id']);pid=int(f['problem_id']);draft=f['draft_id'];assert re.fullmatch('[a-f0-9]{32}',draft)
names=','.join("'"+u['username']+"'" for u in f['users']);uids=','.join(str(int(u['id'])) for u in f['users'])
check=sql(f"SELECT (SELECT COUNT(*) FROM grader.users WHERE id IN({uids}) AND username IN({names}))=1000 AND (SELECT COUNT(*) FROM grader.courses WHERE id={mid} AND title='临时压力测试班 {f['prefix']}')=1 AND (SELECT COUNT(*) FROM codemind_course.cm_offering WHERE offering_id={oid})=1 AND (SELECT COUNT(*) FROM jol.problem WHERE problem_id={pid} AND source='codemind:authoring/{draft}/sum')=1;")
assert check=='1','Fixture mismatch: cleanup stopped'
subprocess.run(['bash','deploy/remote/backup.sh'],cwd=root,check=True)
subprocess.run(['docker','compose','--env-file','.env','-f','deploy/remote/compose.yml','stop','api','management-api'],cwd=root,check=True)
q=f"""USE codemind_course;
CREATE TEMPORARY TABLE load_sids (sid INT PRIMARY KEY);
INSERT INTO load_sids SELECT solution_id FROM jol.solution WHERE user_id IN({names});
SET @cid=(SELECT course_id FROM cm_offering WHERE offering_id={oid});
START TRANSACTION;
DELETE FROM cm_submission WHERE offering_id={oid};
DELETE FROM cm_batch_problem WHERE batch_id={bid};
DELETE FROM cm_authoring_draft WHERE draft_id='{draft}';
DELETE FROM cm_batch WHERE batch_id={bid} AND offering_id={oid};
DELETE FROM cm_enrollment WHERE offering_id={oid};
DELETE FROM cm_offering WHERE offering_id={oid};
DELETE FROM cm_problem_knowledge WHERE problem_id={pid};
DELETE FROM cm_knowledge_point WHERE course_id=@cid;
DELETE FROM cm_course WHERE course_id=@cid AND code='MGMT-{mid}';
DELETE FROM grader.courses WHERE id={mid} AND title='临时压力测试班 {f['prefix']}';
DELETE FROM grader.users WHERE id IN({uids}) AND username IN({names});
COMMIT;
"""
for table in ['compileinfo','runtimeinfo','custominput','source_code','source_code_user','solution_ai_answer','openai_task_queue','solution']:
 q+=f'DELETE t FROM jol.{table} t JOIN load_sids s ON t.solution_id=s.sid;\n'
q+='DELETE t FROM jol.sim t WHERE t.s_id IN(SELECT sid FROM load_sids) OR t.sim_s_id IN(SELECT sid FROM load_sids);\n'
q+=f"DELETE FROM jol.problem WHERE problem_id={pid} AND source='codemind:authoring/{draft}/sum';\n"
for table in ['loginlog','privilege','users']:q+=f'DELETE FROM jol.{table} WHERE user_id IN({names});\n'
q+='SELECT "accounts_remaining",id,username FROM grader.users; SELECT "courses_remaining",COUNT(*) FROM grader.courses; SELECT "judge_queue_remaining",COUNT(*) FROM jol.solution WHERE result IN(0,1,2,3,14);\n'
print(sql(q),flush=True)
import shutil
# Remove only PHP sessions belonging to this run, including login-storm sessions.
code="""import pathlib,re,sys
prefix=sys.argv[1];pattern=re.compile(r'_user_id\\|s:\\d+:\"'+re.escape(prefix)+r'_[0-9]{4}\";');count=0
for path in pathlib.Path('/var/lib/php/sessions').glob('sess_*'):
 try:
  if pattern.search(path.read_text(errors='ignore')):path.unlink();count+=1
 except FileNotFoundError:pass
print('Removed fixture PHP sessions:',count)
"""
subprocess.run(['docker','exec','hoj-core-1','python3','-c',code,f['prefix']],check=True)
shutil.rmtree(root/'data/judge'/str(pid))
subprocess.run(['docker','compose','--env-file','.env','-f','deploy/remote/compose.yml','up','-d','--wait','--wait-timeout','120'],cwd=root,check=True)
(root/'load-test/sessions.json').unlink(missing_ok=True)
print('Only recorded pressure-test fixture removed; services restored',flush=True)
