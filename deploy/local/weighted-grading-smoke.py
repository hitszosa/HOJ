#!/usr/bin/env python3
"""Exercise real C++ judging and weight changes on the dedicated local fixture."""
import csv
import importlib.util
import io
import json
import re
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('platform_client', ROOT / 'deploy/local/admin-smoke.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
Client = module.Client


def main():
    checks, submissions, checkpoints = [], [], []
    def check(label, passed):
        assert passed, label
        checks.append(label)
    teacher, first, second, absent = [Client() for _ in range(4)]
    for c, u in [(teacher,'teacher_joint'), (first,'20260001'), (second,'20260002'), (absent,'20260003')]:
        check(f'{u}: login', c.login(u,u)[0] == 200)
    fixture = json.loads((ROOT/'.local/weighted-grading-fixture.json').read_text())
    draft = teacher.ok('/api/drafts/' + fixture['id'])['data']
    bid = draft['batch_id']
    detail = teacher.ok(f'/api/batches/{bid}')['data']
    check('Use only dedicated weighted experiment', detail['batch']['title'] == '权重自动评分联测（30/70）' and detail['batch']['offering_id'] == 2)
    pids = [p['problem_id'] for p in detail['problems']]
    check('Teacher UI publication persisted 30/70', [p['score'] for p in detail['problems']] == [30,70])
    check('Real judging uses C++ and does not depend on AI', detail['batch']['allowed_languages'] == ['cpp'] and not detail['batch']['ai_enabled'])
    def scores(label, expected):
        rows = [r for r in teacher.ok('/api/offerings/2/grades')['data'] if r['batch_id'] == bid]
        got = [r['score'] for r in rows]
        check(label, got == expected)
        checkpoints.append({'label':label,'scores':got,'rows':rows})
        for c, row in zip([first,second,absent],rows):
            data = c.ok(f'/api/batches/{bid}')['data']['problems']
            total = sum(p['score'] for p in data if p['required'])
            student_score = round(sum(p['score'] for p in data if p['required'] and p['passed'])*100/total,2)
            check(label + ': student and teacher scores agree for ' + row['user_id'], student_score == row['score'])
        return rows
    def change(a,b):
        return {'problem_weights':[{'problem_id':p,'score':v} for p,v in zip(pids,[a,b])]}
    for weights in [change(0,0), change(-1,70), change(1000,70), change(.001,70), {'problem_weights':[]}, {'problem_weights':[{'problem_id':pids[0],'score':30}]}, {'problem_weights':[{'problem_id':pids[0],'score':30},{'problem_id':pids[0],'score':70}]}, {'problem_weights':[{'problem_id':1011,'score':30},{'problem_id':pids[1],'score':70}]}]:
        check('Invalid or incomplete weights rejected: ' + str(weights), teacher.request(f'/api/batches/{bid}','PATCH',weights)[0] == 422)
    check('Invalid updates are atomic', [p['score'] for p in teacher.ok(f'/api/batches/{bid}')['data']['problems']] == [30,70])
    check('Student cannot change weights', first.request(f'/api/batches/{bid}','PATCH',change(99,1))[0] == 403)
    scores('Initially all students have zero', [0,0,0])
    def submit(c, pid, code, result):
        sid = c.ok(f'/api/batches/{bid}/problems/{pid}/submissions','POST',{'language':'cpp','code':code})['data']['submission_id']
        deadline = time.monotonic()+45
        while time.monotonic() < deadline:
            data = c.ok(f'/api/submissions/{sid}')['data']
            if data['result'] not in [0,1,2,3,14]: break
            time.sleep(.4)
        check(f'Real judge {sid} returns {result}', data['result'] == result)
        submissions.append({'id':sid,'user':data['user_id'],'problem_id':pid,'result':data['result']})
    code = lambda op: '#include <iostream>\nusing namespace std;\nint main(){long long a,b;cin>>a>>b;cout<<(a'+op+'b)<<"\\n";}\n'
    submit(first,pids[0],code('+'),4)
    submit(second,pids[1],code('-'),4)
    scores('Only first / second AC earns 30 / 70', [30,70,0])
    submit(second,pids[0],code('-'),6)
    submit(second,pids[0],'int main( {\n',11)
    scores('WA and CE do not earn points', [30,70,0])
    submit(first,pids[0],code('+'),4)
    scores('Repeated AC contributes once', [30,70,0])
    teacher.ok(f'/api/batches/{bid}','PATCH',change(50,50))
    scores('Changing weights recalculates existing submissions', [50,50,0])
    teacher.ok(f'/api/batches/{bid}','PATCH',change(0,70))
    scores('Zero-weight first problem is excluded', [0,100,0])
    teacher.ok(f'/api/batches/{bid}','PATCH',change(30,70))
    scores('Restored 30/70 weights', [30,70,0])
    submit(first,pids[1],code('-'),4)
    scores('All AC earns full score', [100,70,0])
    submit(first,pids[0],code('-'),6)
    final = scores('Later WA does not remove earned AC credit', [100,70,0])
    copy = teacher.ok(f'/api/batches/{bid}/copy','POST',{})['data']
    check('Copy retains weights', [p['score'] for p in copy['document']['problems']] == [30,70])
    exported = teacher.ok(f'/api/batches/{bid}/export','POST',{'selected':pids})['data']
    public = exported['content']  # Public problem sets are YAML.
    check('Public export retains weights', [float(v) for v in re.findall(r'^\s+score:\s*([\d.]+)',public,re.M)] == [30,70])
    check('Public export does not contain hidden tests', not re.search(r'^\s*tests:',public,re.M))
    all_rows = teacher.ok('/api/offerings/2/grades')['data']
    check('Legacy equal-weight grades unchanged', [r['score'] for r in all_rows if r['batch_id'] == 10] == [100,0,0])
    raw = teacher.ok('/api/offerings/2/grades/export')
    csv_rows = list(csv.DictReader(io.StringIO(raw.decode('utf-8-sig'))))
    selected = [r for r in csv_rows if r['实验'] == detail['batch']['title']]
    check('CSV includes UTF-8 BOM', raw.startswith(b'\xef\xbb\xbf'))
    check('CSV scores and absence match real grades', [r['成绩（100分）'] for r in selected] == ['100','70','0'] and [r['状态'] for r in selected] == ['全部通过','未全部通过','未提交'])
    (ROOT/'.local/weighted-grading-server-export.csv').write_bytes(raw)
    report = {'passed':len(checks),'checks':checks,'batch_id':bid,'problem_ids':pids,'checkpoints':checkpoints,'submissions':submissions,'final_grades':final,'copy_draft_id':copy['id']}
    (ROOT/'.local/weighted-grading-result.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
    print(json.dumps({'passed':len(checks),'batch_id':bid,'scores':[r['score'] for r in final]},ensure_ascii=False))


if __name__ == '__main__':
    main()
