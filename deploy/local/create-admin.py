#!/usr/bin/env python3
"""Provision the admin account only in this checkout's isolated HUSTOJ container."""
from pathlib import Path
import json
import secrets
import subprocess

ROOT = Path(__file__).resolve().parents[2]
ACCOUNT = ROOT / '.local/admin-account.json'
ACCOUNT.parent.mkdir(exist_ok=True)


def sql(source):
    result = subprocess.run(['docker', 'exec', '-i', 'hoj-local-hustoj', 'mysql',
                             '--default-character-set=utf8mb4', '-uroot', '-N'],
                            input=source, text=True, check=True, capture_output=True)
    return result.stdout.strip()


def main():
    if not ACCOUNT.exists():
        if sql("SELECT COUNT(*) FROM jol.users WHERE user_id='admin';") != '0':
            raise SystemExit('An existing admin account was found; its password was not changed.')
        ACCOUNT.write_text(json.dumps({'username': 'admin', 'password': 'HOJ-' + secrets.token_urlsafe(12)}, indent=2))
        ACCOUNT.chmod(0o600)
    account = json.loads(ACCOUNT.read_text())
    if sql("SELECT COUNT(*) FROM jol.users WHERE user_id='admin';") == '0':
        # Use the native application's password encoder, without placing the secret in argv.
        password_hash = subprocess.run([
            'docker', 'exec', '-i', 'hoj-local-hustoj', 'php', '-r',
            'require "/home/judge/src/web/include/my_func.inc.php"; echo pwGen(stream_get_contents(STDIN));',
        ], input=account['password'], text=True, check=True, capture_output=True).stdout.strip()
        if len(password_hash) != 32:
            raise SystemExit('Native password encoder returned an unexpected format.')
        sql(f"""
INSERT INTO jol.users(user_id,nick,password,reg_time,accesstime,expiry_date,defunct)
VALUES('admin','教学管理员','{password_hash}',NOW(),NOW(),'2099-01-01','N');
""")
    for role in ['administrator', 'teacher']:
        sql(f"""INSERT INTO jol.privilege(user_id,rightstr)
SELECT 'admin','{role}' WHERE NOT EXISTS
(SELECT 1 FROM jol.privilege WHERE user_id='admin' AND rightstr='{role}');""")
    print('admin account ready; credentials are saved in .local/admin-account.json')


if __name__ == '__main__':
    main()
