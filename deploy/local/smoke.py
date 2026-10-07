#!/usr/bin/env python3
"""Assert permissions, native session integration, and real judge outcomes."""
import hashlib
import http.cookiejar
import json
from pathlib import Path
import re
import time
import urllib.error
import urllib.parse
import urllib.request

BASE = 'http://127.0.0.1:3100'
ROOT = Path(__file__).resolve().parents[2]
results = []
failures = []

def client():
    return urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

def request(c, path, data=None, status=200, method=None, origin=BASE):
    body = json.dumps(data).encode() if data is not None else None
    req = urllib.request.Request(BASE + '/api' + path, data=body, method=method, headers={'Content-Type': 'application/json', 'Origin': origin})
    try:
        response = c.open(req, timeout=10)
    except urllib.error.HTTPError as e:
        response = e
    payload = json.loads(response.read())
    assert response.code == status, (path, response.code, status, payload)
    return payload.get('data')

def check(name):
    results.append(name)
    print('PASS', name, flush=True)

teacher, student, outsider, ta = [client() for _ in range(4)]
for c, role in [(teacher, 'teacher'), (student, 'student'), (outsider, 'outsider'), (ta, 'ta')]:
    request(c, '/session', {'role': role})
assert request(teacher, '/me')['portal'] == 'teacher'
assert request(student, '/me')['portal'] == 'student'
request(client(), '/me', status=401)
request(outsider, '/offerings/1', status=404)
request(student, '/offerings/1/insights', status=403)
request(teacher, '/session', {'role': 'teacher'}, status=403, origin='https://example.invalid')
check('角色门户、匿名鉴权、班级隔离、学情权限与 CSRF')

draft = request(teacher, '/offerings/1/drafts', {'document': {
    'title': '本地验收 · 两数和', 'problems': [{
        'slug': 'local-sum', 'title': '两数和（本地验收）',
        'statement': '输入两个整数 a b，输出 a+b。',
        'samples': [{'input': '1 2\n', 'output': '3\n'}],
        'tests': [{'input': '2 3\n', 'output': '5\n'}, {'input': '-2 9\n', 'output': '7\n'}],
    }],
}})
did = draft['id']
request(student, f'/drafts/{did}', status=403)
request(ta, f'/drafts/{did}', status=403)
request(teacher, f'/drafts/{did}/publish', {}, status=422)
bid = request(teacher, f'/drafts/{did}/publish', {'reviewed': True, 'ai_enabled': False})['batch_id']
assert request(teacher, f'/drafts/{did}/publish', {'reviewed': True})['batch_id'] == bid
pid = request(student, f'/batches/{bid}')['problems'][0]['problem_id']
path = f'/batches/{bid}/problems/{pid}'
request(teacher, path + '/submissions', {'language': 'python', 'code': 'print(5)'}, status=403)
check(f'草稿审核、发布幂等、学生可见与教师提交权限（batch={bid}, problem={pid}）')

cases = [
    ('Python AC', 'python', 'a,b=map(int,input().split())\nprint(a+b)\n', 4),
    ('C AC', 'c', '#include <stdio.h>\nint main(){int a,b;scanf("%d%d",&a,&b);printf("%d\\n",a+b);return 0;}\n', 4),
    ('C++ AC', 'cpp', '#include <iostream>\nint main(){int a,b;std::cin>>a>>b;std::cout<<a+b<<std::endl;}\n', 4),
    ('Java AC', 'java', 'import java.util.Scanner; public class Main { public static void main(String[] args){Scanner s=new Scanner(System.in);System.out.println(s.nextInt()+s.nextInt());}}\n', 4),
    ('Python WA', 'python', 'print(999)\n', 6),
    ('C CE', 'c', 'this is not valid C;\n', 11),
    ('Python RE', 'python', 'print(1/0)\n', 10),
    ('Python TLE', 'python', 'while True: pass\n', 7),
    ('C 沙箱拒绝未授权系统调用', 'c', '#include <sys/socket.h>\nint main(){return socket(AF_INET,SOCK_STREAM,0);}\n', 10),
]
for name, language, code, expected in cases:
    sid = request(student, path + '/submissions', {'language': language, 'code': code})['submission_id']
    deadline = time.monotonic() + 45
    while time.monotonic() < deadline:
        result = request(student, f'/submissions/{sid}')
        if result['result'] >= 4:
            break
        time.sleep(0.5)
    if result['result'] != expected:
        failures.append((name, sid, expected, result))
        print('FAIL', failures[-1], flush=True)
        continue
    request(outsider, f'/submissions/{sid}', status=404)
    request(teacher, f'/submissions/{sid}/code')
    check(f'{name}（submission={sid}, result={expected}）')

trial = request(student, path + '/trials', {'language': 'python', 'code': 'a,b=map(int,input().split())\nprint(a+b)\n', 'input': '12 30\n'})
request(student, path + '/trials', {'language': 'python', 'code': 'print(1)', 'input': ''}, status=429)
deadline = time.monotonic() + 45
while time.monotonic() < deadline:
    result = request(student, '/trials/' + trial['run_id'])
    if result['state'] != 'running':
        break
    time.sleep(0.5)
assert result['output'].strip() == '42', result
check('真实自测输出 42 与重复请求限流')

native = client()
native.open(BASE + '/oj/loginpage.php').read()
csrf_html = native.open(BASE + '/oj/csrf.php').read().decode()
csrf = re.search(r'name="csrf" value="([^"]+)"', csrf_html).group(1)
form = urllib.parse.urlencode({'user_id': 'cm_pilot_student', 'password': hashlib.md5(b'hoj-local-demo').hexdigest(), 'csrf': csrf}).encode()
native.open(urllib.request.Request(BASE + '/oj/login.php', data=form)).read()
identity = request(native, '/me')
assert identity['user'] == 'cm_pilot_student' and identity['auth_source'] == 'hustoj', identity
check('HUSTOJ 原生账号登录 → PHP 会话桥接 → 教学 API 身份')

assert request(student, '/problem-sets/tree')['tree']['root']['count'] == 2148
request(teacher, '/offerings/1/students')
request(teacher, '/offerings/1/insights')
check('2,148 题题库、班级名单与学情统计')
assert not failures, failures
(ROOT / '.local/verification.json').write_text(json.dumps({'batch_id': bid, 'problem_id': pid, 'checks': results}, ensure_ascii=False, indent=2))
print(f'All {len(results)} checks passed. Batch {bid}, problem {pid}.')
