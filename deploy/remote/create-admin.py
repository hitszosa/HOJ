#!/usr/bin/env python3
"""Create the shared administrator without logging secrets or replacing accounts."""
import json
from pathlib import Path
import re
import subprocess

ROOT=Path(__file__).resolve().parents[2]
COMPOSE=['docker','compose','--env-file',str(ROOT/'.env'),'-f',str(ROOT/'deploy/remote/compose.yml')]
def sql(statement):
    reply=subprocess.run(COMPOSE+['exec','-T','db','sh','-c',
        'MYSQL_PWD="$MARIADB_ROOT_PASSWORD" mariadb -uroot --default-character-set=utf8mb4 -N'],
        input=statement,text=True,capture_output=True,check=True)
    return reply.stdout.strip()

account=json.loads((ROOT/'admin-account.json').read_text())
if account['username']!='admin':
    raise SystemExit('Only the shared admin account is supported')
if sql("SELECT COUNT(*) FROM jol.users WHERE user_id='admin';")=='0':
    encoded=subprocess.run(COMPOSE+['exec','-T','core','php','-r',
        'require "/home/judge/src/web/include/my_func.inc.php"; echo pwGen(stream_get_contents(STDIN));'],
        input=account['password'],text=True,capture_output=True,check=True).stdout.strip()
    if not re.fullmatch('[A-Za-z0-9+/=]{32}',encoded):
        raise SystemExit('Native password encoder returned an unexpected hash')
    sql(f"INSERT INTO jol.users(user_id,nick,password,reg_time,accesstime,expiry_date,defunct) "
        f"VALUES('admin','教学管理员','{encoded}',NOW(),NOW(),'2099-01-01','N');")
for role in ['administrator','teacher']:
    sql(f"INSERT INTO jol.privilege(user_id,rightstr) SELECT 'admin','{role}' "
        f"WHERE NOT EXISTS (SELECT 1 FROM jol.privilege WHERE user_id='admin' AND rightstr='{role}');")
print('Shared admin account ready; password remains in the private admin-account.json.')
