"""Create isolated local pilot accounts and courses; never alters existing courses."""
import os
import sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from service import db, q, ROOT, DEV_USERS

def main():
    db.write((ROOT/'schema/002_authoring.sql').read_text(),ops=True)
    for role,user in DEV_USERS.items():
        db.write(f"INSERT IGNORE INTO jol.users(user_id,nick,password,reg_time) VALUES({q(user)},{q('平台体验 · '+role)},'!local-pilot-no-password',NOW())",ops=True)
    db.write("INSERT IGNORE INTO cm_course(code,name,hoa_repo,created_at,updated_at) VALUES('PILOT1007','程序设计基础 · 功能体验','HITSZ-OpenAuto/COMP1007',NOW(),NOW())")
    cid=int(db.one("SELECT course_id FROM cm_course WHERE code='PILOT1007'")['course_id'])
    for term,status in [('2026-秋','active'),('2026-春','archived')]:
        db.write(f"INSERT IGNORE INTO cm_offering(course_id,term,section,title,teacher_id,status,created_at,updated_at) VALUES({cid},{q(term)},'体验班','编程作业体验班',{q(DEV_USERS['teacher'])},{q(status)},NOW(),NOW())")
        oid=int(db.one(f'SELECT offering_id FROM cm_offering WHERE course_id={cid} AND term={q(term)}')['offering_id'])
        for role in ('student','teacher','ta'):
            db.write(f"INSERT IGNORE INTO cm_enrollment(offering_id,user_id,role,created_at,updated_at) VALUES({oid},{q(DEV_USERS[role])},{q(role)},NOW(),NOW())")
    print('本地体验课程已就绪；原有课程与提交保持不变。')

if __name__=='__main__': main()
