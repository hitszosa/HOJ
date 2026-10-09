#!/usr/bin/env python3
"""Generate credentials and initialization SQL for a new, isolated Linux deployment."""
import argparse
import json
import os
from pathlib import Path
import re
import secrets
from urllib.parse import urlsplit

ROOT=Path(__file__).resolve().parents[2]
parser=argparse.ArgumentParser()
parser.add_argument('--public-url',required=True)
parser.add_argument('--storage-url',required=True)
args=parser.parse_args()
for raw in [args.public_url,args.storage_url]:
    url=urlsplit(raw)
    if url.scheme not in ['http','https'] or not url.hostname or url.username or url.password or url.path not in ['', '/'] or url.query or url.fragment:
        raise SystemExit('Use an HTTP(S) origin without credentials or a path')
if os.geteuid()!=0:
    raise SystemExit('Run configuration as root inside the isolated deployment directory')
if (ROOT/'.env').exists() or (ROOT/'data/mysql/mysql').exists():
    raise SystemExit('Existing deployment found; credentials and data were not changed')
ROOT.chmod(0o700)
os.umask(0o077)
values={key:secrets.token_hex(24) for key in ['DB_ROOT_PASSWORD','JUDGE_DB_PASSWORD',
    'COURSE_DB_PASSWORD','COURSE_OPS_PASSWORD','MANAGEMENT_DB_PASSWORD','STORAGE_PASSWORD']}
values.update(SESSION_SECRET_KEY=secrets.token_hex(32),
    HOJ_ORIGINS=args.public_url.rstrip('/')+',http://127.0.0.1:3100',
    PUBLIC_STORAGE_URL=args.storage_url.rstrip('/'))
(ROOT/'.env').write_text(''.join(key+'='+value+'\n' for key,value in values.items()))
(ROOT/'admin-account.json').write_text(json.dumps({'username':'admin',
    'password':'HOJ-'+secrets.token_urlsafe(18),'url':args.public_url.rstrip('/')+'/management/login'},indent=2))
sql=(ROOT/'vendor/hustoj/install/db.sql').read_text()
sql=sql.replace('create database if not exists jol ;',
    'CREATE DATABASE IF NOT EXISTS jol DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;')
# Explicit table collations prevent MariaDB 11.8's uca1400 default from changing
# the type of cross-database name expressions to VARBINARY.
sql=re.sub(r'(?i)(?:DEFAULT\s+)?CHARSET\s*=?\s*utf8mb4(?=\s*;)',
    'DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci',sql)
sql+='\nDELETE FROM jol.news;\n'
for name in ['001_cm_course.sql','002_authoring.sql','003_collaboration.sql','004_allowed_languages.sql','008_library_independent.sql']:
    sql+='\n'+(ROOT/'backend/schema'/name).read_text()
sql+='\nCREATE DATABASE grader DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;\n'
rights={'jol':['ALL ON jol.*'],'grader':['ALL ON grader.*'],
    'codemind_ops':['ALL ON codemind_course.*','SELECT, INSERT, UPDATE, DELETE ON jol.*'],
    'codemind':['ALL ON codemind_course.*','SELECT ON jol.*','INSERT, UPDATE(result) ON jol.solution',
                'INSERT ON jol.source_code','INSERT ON jol.source_code_user']}
for user,key in [('jol','JUDGE_DB_PASSWORD'),('codemind','COURSE_DB_PASSWORD'),
                 ('codemind_ops','COURSE_OPS_PASSWORD'),('grader','MANAGEMENT_DB_PASSWORD')]:
    # Services share an isolated network namespace and connect over its loopback.
    for host in ['localhost','127.0.0.1']:
        sql+=f"CREATE USER '{user}'@'{host}' IDENTIFIED BY '{values[key]}';\n"
        for right in rights[user]:
            sql+=f"GRANT {right} TO '{user}'@'{host}';\n"
init=ROOT/'init';init.mkdir(mode=0o755);init.chmod(0o755)
path=init/'001-init.sql';path.write_text(sql);path.chmod(0o644)
for name in ['mysql','judge','judge-log','course-local','objects']:
    (ROOT/'data'/name).mkdir(parents=True,exist_ok=True)
print('New deployment configured; secrets are in private .env and admin-account.json.')
