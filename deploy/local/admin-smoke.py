#!/usr/bin/env python3
"""Verify platform password login, isolated legacy pages, and complete session logout."""
import http.cookiejar
import json
from pathlib import Path
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
BASE = 'http://127.0.0.1:3100'


class Client:
    def __init__(self):
        self.jar = http.cookiejar.CookieJar()
        self.http = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPCookieProcessor(self.jar))

    def request(self, path, method='GET', body=None, origin=BASE, cookie=None):
        headers = {'Origin': BASE, 'Content-Type': 'application/json'}
        if origin is None:
            del headers['Origin']
        else:
            headers['Origin'] = origin
        if cookie is not None:
            headers['Cookie'] = cookie
        for c in self.jar:
            if c.name == 'csrftoken':
                headers['X-CSRFTOKEN'] = urllib.parse.unquote(c.value)
        req = urllib.request.Request(BASE + path, None if body is None else json.dumps(body).encode(), headers, method=method)
        try:
            response = self.http.open(req, timeout=20)
        except urllib.error.HTTPError as e:
            response = e
        data = response.read()
        return response.status, json.loads(data) if data and response.headers.get_content_type() == 'application/json' else data

    def ok(self, path, method='GET', body=None):
        status, data = self.request(path, method, body)
        assert 200 <= status < 300, (path, status)
        return data

    def login(self, username, password):
        return self.request('/api/account/login', 'POST', {'username': username, 'password': password})


def main():
    account = json.loads((ROOT / '.local/admin-account.json').read_text())
    checks = []

    def check(name, condition):
        assert condition, name
        checks.append(name)

    anonymous = Client()
    check('Anonymous admin access rejected', anonymous.request('/management-api/auth/current_user')[0] == 401)
    check('Development login disabled', anonymous.request('/api/session', 'POST', {'user_id': 'admin'})[0] == 403)
    check('Demo shortcuts disabled in health configuration', anonymous.ok('/api/health')['data']['dev_login'] is False)
    check('Login metadata points to teaching platform', anonymous.ok('/api/health')['data']['login_url'] == '/management/login')
    credentials = {'username': account['username'], 'password': account['password']}
    check('Cross-site login rejected', anonymous.request('/api/account/login', 'POST', credentials, origin='https://untrusted.invalid')[0] == 403)
    check('Login without Origin rejected', anonymous.request('/api/account/login', 'POST', credentials, origin=None)[0] == 403)
    bad = Client()
    check('Wrong password returns a structured error', bad.login('admin', 'invalid-not-the-account-password')[0] == 401)
    check('Wrong password rejected', bad.request('/api/me')[0] == 401)
    admin = Client()
    check('Platform password login succeeds', admin.login(account['username'], account['password'])[0] == 200)
    me = admin.ok('/api/me')['data']
    check('Existing admin identity and password preserved', me['user'] == 'admin' and me['auth_source'] == 'hustoj')
    check('Teacher and administrator functionality available', 'admin' in me['roles'] and 'teacher' in me['roles'])
    check('Password login does not issue a development cookie', not any(c.name == 'course_session' for c in admin.jar))
    profile = admin.ok('/management-api/auth/current_user')
    check('Same admin identity reaches management', profile['username'] == 'admin' and profile['role'] == 2)
    check('Linked admin cannot bypass shared password authentication', admin.request('/management-api/auth/login', 'POST', credentials)[0] == 401)
    # Set the account's display name through its authorized profile management API.
    profile = admin.ok(f'/management-api/users/{profile["id"]}', 'PATCH', dict(profile, real_name='教学管理员'))
    check('Account profile uses the administrator name', profile['real_name'] == '教学管理员')
    check('Teacher course workspace available', admin.request('/api/courses')[0] == 200)
    check('Management course administration available', admin.request('/management-api/courses?all=true')[0] == 200)
    check('Administrator can query users', admin.request('/management-api/users/user_fuzzy_lookup?key=admin&page_size=10&page_num=1&include_count=true')[0] == 200)
    check('Management import has native HOJ credentials', admin.request('/management-api/hoj/import', 'POST', {})[0] == 200)
    for path in ['/oj/status.php', '/oj/loginpage.php', '/oj/admin/', '/oj/logout.php']:
        try:
            response = anonymous.http.open(BASE + path, timeout=20)
        except urllib.error.HTTPError as e:
            if e.code != 308:
                raise
            response = anonymous.http.open(urllib.parse.urljoin(BASE, e.headers['Location']), timeout=20)
        check('Legacy URL redirects into teaching UI: ' + path, response.url == BASE + '/management/home')
    for path in ['/status.php', '/loginpage.php', '/admin/', '/']:
        try:
            anonymous.http.open('http://127.0.0.1:8080' + path, timeout=20)
            raise AssertionError('Legacy page still exposed: ' + path)
        except urllib.error.HTTPError as e:
            check('Native web page closed: ' + path, e.code == 404)
    for name in ['ace.js', 'mode-c_cpp.js', 'mode-python.js', 'mode-java.js', 'theme-xcode.js']:
        check('Editor asset independent of legacy web: ' + name, anonymous.request('/editor/ace/' + name)[0] == 200)
    native_cookie = '; '.join(f'{c.name}={c.value}' for c in admin.jar if c.name == 'PHPSESSID')
    check('Cross-site logout rejected', admin.request('/api/session', 'DELETE', origin='https://untrusted.invalid')[0] == 403)
    check('Rejected logout preserves the current account', admin.ok('/api/me')['data']['user'] == 'admin')
    check('Logout completes inside platform', admin.ok('/api/session', 'DELETE')['data']['logout_url'] == '/management/login')
    check('Logged-out HOJ account rejected', admin.request('/api/me')[0] == 401)
    check('Logged-out management account rejected', admin.request('/management-api/auth/current_user')[0] == 401)
    replay = Client()
    check('Old PHP session and identity cache revoked', replay.request('/api/me', cookie=native_cookie)[0] == 401)
    check('Old session rejected across management', replay.request('/management-api/auth/current_user', cookie=native_cookie)[0] == 401)
    independent = Client()
    check('Independent account falls through shared account lookup', independent.login('local_admin', 'unknown')[0] == 401)
    local_secrets = json.loads((ROOT / '.local/management-secrets.json').read_text())
    independent.ok('/management-api/auth/login', 'POST', {'username': 'local_admin', 'password': local_secrets['admin']})
    check('Independent management accounts retain password login', independent.ok('/management-api/auth/current_user')['username'] == 'local_admin')
    independent.ok('/management-api/auth/logout', 'POST', {})
    print(json.dumps({'passed': len(checks), 'checks': checks}, indent=2))


if __name__ == '__main__':
    main()
