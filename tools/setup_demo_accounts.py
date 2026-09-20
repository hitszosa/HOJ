#!/usr/bin/env python3
"""配置多教师、多学生及班级管理演示数据与 SSO 模拟环境

此脚本为演示/本地测试环境配置多位真实授课教师、多名学生选课关系，
以及对应的教学班 (cm_offering) 与选课名单 (cm_enrollment)。
生产环境中，账号与角色将由学校统一身份认证 (SSO/CAS/OAuth2) 自动下发。
"""

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from service import db, q, ROOT as SERVICE_ROOT

TEACHERS = [
    ("teacher_su", "苏小红 教授", ["COMP1007", "COMP1011"]),
    ("teacher_liu", "刘洋 老师", ["COMP2001"]),
    ("teacher_zheng", "郑海刚 老师", ["COMP2012"]),
    ("teacher_wang", "王焦乐 老师", ["COMP2014"]),
    ("teacher_ren", "任卫红 老师", ["COMP2050"]),
    ("teacher_xia", "夏文 老师", ["COMP2052"]),
    ("teacher_wangq", "王强 教授", ["COMP3011"]),
    ("teacher_algo", "算法教学组", ["COMP3001"]),
    ("cm_pilot_teacher", "平台体验 · 教师", ["PILOT1007"]),
    ("admin", "超级管理员 · admin", ["COMP1007", "COMP2052", "PILOT1007"]),
]

STUDENTS = [
    ("student_cs01", "张三 (计科大一)", "2401001", [("COMP1011", "01"), ("COMP2001", "01")]),
    ("student_cs02", "李四 (计科大二)", "2301002", [("COMP2052", "01"), ("COMP3011", "01"), ("COMP3001", "01")]),
    ("student_auto01", "王五 (自动化大二)", "2302003", [("COMP2014", "01"), ("COMP2050", "01")]),
    ("cm_pilot_student", "平台体验 · 学生", "2026001", [("PILOT1007", "体验班"), ("COMP1007", "01")]),
    ("cm_pilot_ta", "平台体验 · 助教", "2024TA01", [("PILOT1007", "体验班"), ("COMP1007", "01")]),
    ("cm_pilot_outsider", "未选课观察员", "2026999", []),
]


def main():
    print("🚀 开始初始化多教师、多学生与教学班环境...")

    # 1. 插入教师账号到 jol.users 与 jol.privilege
    for uid, name, _ in TEACHERS:
        db.write(
            f"INSERT INTO jol.users(user_id, nick, password, reg_time) "
            f"VALUES({q(uid)}, {q(name)}, '!demo-sso-password', NOW()) "
            f"ON DUPLICATE KEY UPDATE nick={q(name)};",
            ops=True
        )
        db.write(
            f"INSERT IGNORE INTO jol.privilege(user_id, rightstr) "
            f"VALUES({q(uid)}, 'teacher');",
            ops=True
        )
        if uid == "admin":
            db.write(f"INSERT IGNORE INTO jol.privilege(user_id, rightstr) VALUES('admin', 'administrator');", ops=True)

    # 2. 插入学生账号到 jol.users
    for uid, name, _, _ in STUDENTS:
        db.write(
            f"INSERT INTO jol.users(user_id, nick, password, reg_time) "
            f"VALUES({q(uid)}, {q(name)}, '!demo-sso-password', NOW()) "
            f"ON DUPLICATE KEY UPDATE nick={q(name)};",
            ops=True
        )

    # 3. 为每位教师分配其专属教学班，清除教师之间的串课
    term = "2026-秋"
    for tid, tname, course_codes in TEACHERS:
        for code in course_codes:
            c = db.one(f"SELECT course_id, name FROM cm_course WHERE code={q(code)}")
            if not c:
                continue
            cid = int(c["course_id"])
            cname = c["name"]

            # 体验课与常规课班级划分
            sections = ["体验班"] if code == "PILOT1007" else ["01", "02"] if code in ("COMP1007", "COMP2052", "COMP2014", "COMP2001") else ["01"]

            for sec in sections:
                title = f"{cname} {term} {sec}班" if sec != "体验班" else f"{cname} · 体验班"
                db.write(f"""
                    INSERT INTO cm_offering (course_id, term, section, title, teacher_id, status, created_at, updated_at)
                    VALUES ({cid}, {q(term)}, {q(sec)}, {q(title)}, {q(tid)}, 'active', NOW(), NOW())
                    ON DUPLICATE KEY UPDATE teacher_id={q(tid)}, title={q(title)}, status='active', updated_at=NOW();
                """)

    # 4. 选课关系绑定 (cm_enrollment)
    for sid, sname, sno, enroll_list in STUDENTS:
        role = "ta" if "ta" in sid else "student"
        for code, sec in enroll_list:
            offering = db.one(f"""
                SELECT o.offering_id FROM cm_offering o
                JOIN cm_course c ON c.course_id=o.course_id
                WHERE c.code={q(code)} AND o.term={q(term)} AND o.section={q(sec)}
            """)
            if offering:
                oid = int(offering["offering_id"])
                db.write(f"""
                    INSERT INTO cm_enrollment (offering_id, user_id, role, student_no, status, created_at, updated_at)
                    VALUES ({oid}, {q(sid)}, {q(role)}, {q(sno)}, 'active', NOW(), NOW())
                    ON DUPLICATE KEY UPDATE role={q(role)}, student_no={q(sno)}, status='active', updated_at=NOW();
                """)

    print("🎉 多教师、多学生及班级选课关系已全部就绪！")


if __name__ == "__main__":
    main()
