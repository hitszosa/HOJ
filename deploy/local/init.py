#!/usr/bin/env python3
"""Initialize only the isolated hoj-local-hustoj container."""
from pathlib import Path
import secrets
import subprocess

ROOT = Path(__file__).resolve().parents[2]
env = ROOT / 'backend/.env'
if not env.exists():
    password, ops = secrets.token_hex(24), secrets.token_hex(24)
    env.write_text(
        f'COURSE_DB_HOST=127.0.0.1\nCOURSE_DB_PORT=13306\n'
        f'COURSE_DB_PASSWORD={password}\nCOURSE_OPS_PASSWORD={ops}\n'
        f'COURSE_DEV_LOGIN=0\nCOURSE_BIND=127.0.0.1:8100\n'
        f'COURSE_JUDGE_DATA_DIR={ROOT}/.local/judge-data\n'
        'COURSE_CONTAINER=hoj-local-hustoj\n'
    )
    env.chmod(0o600)
values = dict(line.split('=', 1) for line in env.read_text().splitlines() if '=' in line and not line.startswith('#'))
password, ops = values['COURSE_DB_PASSWORD'], values['COURSE_OPS_PASSWORD']
# sqlx defaults sessions to UTC; match HUSTOJ and the local UI's Shanghai clock.
from urllib.parse import quote
with env.open('a') as config:
    for key, user, secret in [('COURSE_DATABASE_URL', 'codemind', password), ('COURSE_OPS_DATABASE_URL', 'codemind_ops', ops)]:
        if key not in values:
            config.write(f'{key}=mysql://{user}:{quote(secret, safe="")}@127.0.0.1:13306/codemind_course?timezone=%2B08:00\n')
def sql(source):
    subprocess.run(['docker', 'exec', '-i', 'hoj-local-hustoj', 'mysql', '--default-character-set=utf8mb4', '-uroot'], input=source, text=True, check=True)

for name in ['001_cm_course.sql', '002_authoring.sql', '003_collaboration.sql', '004_allowed_languages.sql', '008_library_independent.sql']:
    sql((ROOT / 'backend/schema' / name).read_text())
bootstrap = (ROOT / 'backend/schema/000_bootstrap_accounts.sql').read_text()
bootstrap = bootstrap.replace('REPLACE_ME_STRONG_PASSWORD', password).replace('REPLACE_ME_OPS_PASSWORD', ops)
# Docker's forwarded connections originate outside the container's localhost.
bootstrap += f"""
CREATE USER IF NOT EXISTS 'codemind'@'%' IDENTIFIED BY '{password}';
CREATE USER IF NOT EXISTS 'codemind_ops'@'%' IDENTIFIED BY '{ops}';
GRANT ALL ON codemind_course.* TO 'codemind'@'%';
GRANT SELECT ON jol.* TO 'codemind'@'%';
GRANT INSERT, UPDATE(result) ON jol.solution TO 'codemind'@'%';
GRANT INSERT ON jol.source_code TO 'codemind'@'%';
GRANT INSERT ON jol.source_code_user TO 'codemind'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON jol.* TO 'codemind_ops'@'%';
GRANT ALL ON codemind_course.* TO 'codemind_ops'@'%';
"""
sql(bootstrap)
if values.get('COURSE_DEV_LOGIN') == '1':
    sql("""
    INSERT IGNORE INTO jol.users(user_id,nick,password,reg_time,accesstime,expiry_date) VALUES
     ('cm_pilot_student','体验学生',MD5('hoj-local-demo'),NOW(),NOW(),'2099-01-01'),
     ('cm_pilot_teacher','体验教师',MD5('hoj-local-demo'),NOW(),NOW(),'2099-01-01'),
     ('cm_pilot_ta','体验助教',MD5('hoj-local-demo'),NOW(),NOW(),'2099-01-01'),
     ('cm_pilot_outsider','未选课学生',MD5('hoj-local-demo'),NOW(),NOW(),'2099-01-01');
    INSERT INTO jol.privilege(user_id,rightstr) SELECT 'cm_pilot_teacher','teacher'
     WHERE NOT EXISTS(SELECT 1 FROM jol.privilege WHERE user_id='cm_pilot_teacher' AND rightstr='teacher');
    INSERT IGNORE INTO codemind_course.cm_course(course_id,code,name,credit,hoa_repo,created_at,updated_at)
     VALUES(1,'COMP1007','程序设计基础',3.0,'COMP1007',NOW(),NOW());
    INSERT IGNORE INTO codemind_course.cm_offering(offering_id,course_id,term,section,title,teacher_id,status,created_at,updated_at)
     VALUES(1,1,'2026-秋','01','本地体验班','cm_pilot_teacher','active',NOW(),NOW());
    INSERT IGNORE INTO codemind_course.cm_enrollment(offering_id,user_id,role,student_no,status,created_at,updated_at)
     VALUES(1,'cm_pilot_student','student','2026001','active',NOW(),NOW()),
           (1,'cm_pilot_ta','ta','2026002','active',NOW(),NOW());
    """)
print('Local database initialized; native account login is ready.')
