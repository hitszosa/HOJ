#!/usr/bin/env python3
"""Create reviewable teacher/student examples in the isolated local teaching class."""
import datetime
import io
import json
from pathlib import Path
import urllib.request
import uuid
import zipfile
from importlib.util import spec_from_file_location, module_from_spec

ROOT = Path(__file__).resolve().parents[2]
spec = spec_from_file_location('management_smoke', ROOT / 'deploy/local/management-smoke.py')
module = module_from_spec(spec)
spec.loader.exec_module(module)
Session = module.Session
teacher, student = Session(), Session()
teacher.login('teacher')
student.login('student')
admin = Session()
admin.login('admin')
links = admin.ok('/management-api/hoj/import', 'POST', {})
course = next(link['course_id'] for link in links if link['offering_id'] == 1)
existing = teacher.ok(f'/management-api/assignments?course={course}')
now = datetime.datetime.now(datetime.timezone.utc)
examples = [
    ('第一周练习 · 作业提交与成绩', 'txt', '体验学生：第一周练习\n已完成课堂练习与课后题。\n'.encode(), '实验报告 · PDF 批注演示'),
    ('课程项目 · 阶段检查', 'txt', '体验学生：课程项目阶段检查\n项目进度：已完成需求分析与基础实现。\n'.encode(), '课程小论文 · Word 批改演示'),
]
archive = io.BytesIO()
with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as z:
    z.writestr('main.py', 'def add(a, b):\n    return a + b\n\nprint(add(12, 30))\n')
    z.writestr('README.txt', '课程项目提交材料。教师下载后录入成绩；编程评测在 HOJ 完成。\n')
examples.append(('期末项目 · 提交材料', 'zip', archive.getvalue(), '代码与文档 · ZIP 批改演示'))
result = []
http = urllib.request.build_opener(urllib.request.ProxyHandler({}))
for title, extension, contents, legacy_title in examples:
    prior = next((a for a in existing if a['title'] == title), None)
    if prior:
        result.append({'assignment_id': prior['id'], 'title': title})
        continue
    legacy = next((a for a in existing if a['title'] == legacy_title), None)
    if legacy:
        assignment = teacher.ok(f'/management-api/assignments/{legacy["id"]}', 'PATCH', {'title': title})
    else:
        assignment = teacher.ok('/management-api/assignments', 'POST', {
            'course': str(course), 'title': title, 'start_time': (now-datetime.timedelta(hours=1)).isoformat(),
            'due_time': (now+datetime.timedelta(days=14)).isoformat(), 'max_file_size': 50*1024*1024,
        })
    aid = assignment['id']
    teacher.ok(f'/management-api/assignments/{aid}', 'PATCH', {
        'description': '教学管理演示：设置作业时间与满分，查看学生已交 / 缺交名单，下载提交材料，录入成绩并导出成绩表。',
        'score':100,'show_score':True,'allowed_extension':f'.{extension}','max_file_size':50*1024*1024,
    })
    teacher.ok(f'/management-api/assignments/{aid}/publish', 'POST')
    cap = student.ok('/management-api/files/touch', 'POST', {
        'original_file_name':f'体验学生_实验作业.{extension}', 'ident':{'type':'submission','assignment_id':aid},
    })
    boundary='hoj'+uuid.uuid4().hex
    chunks=[]
    for key,value in cap['params'].items():
        chunks.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{key}"\r\n\r\n{value}\r\n'.encode())
    chunks += [f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="submission.{extension}"\r\nContent-Type: application/octet-stream\r\n\r\n'.encode(),contents,f'\r\n--{boundary}--\r\n'.encode()]
    request = urllib.request.Request(cap['url'], b''.join(chunks), {'Content-Type':f'multipart/form-data; boundary={boundary}'},method='POST')
    assert http.open(request,timeout=30).status < 300
    student.ok('/management-api/files/finish','POST',{'ident':cap['ident']})
    submission = student.ok(f'/management-api/submissions?assignment={aid}&file_ident={cap["ident"]}','POST',{})
    sid=submission['id']
    scored = teacher.ok('/management-api/submissions/score_update', 'POST', {'submission':sid,'score':95})
    assert scored['score'] == 95
    result.append({'assignment_id':aid,'submission_id':sid,'title':title,'score':95})
print(json.dumps({'course_id':course,'examples':result},ensure_ascii=False,indent=2))
