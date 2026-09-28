from __future__ import annotations

import os

from fastapi import APIRouter

from hoj.auth import DEV_USERS
from hoj.infra.database import db

router = APIRouter()


@router.get('/api/health')
def health():
    return {'ok':True,'devLogin':os.environ.get('COURSE_DEV_LOGIN')=='1',
            'ssoConfigured':bool(os.environ.get('COURSE_SSO_HEADER')),
            'ssoHeader':os.environ.get('COURSE_SSO_HEADER','X-Remote-User'),
            'aiConfigured':bool(os.environ.get('COURSE_AI_URL')),
            'loginUrl':'/oj/loginpage.php','logoutUrl':'/oj/logout.php','hustojUrl':'/oj/course.php'}


@router.get('/api/demo/users')
def demo_users():
    teaching_rows = db.rows("""SELECT DISTINCT o.teacher_id, c.code, c.name
        FROM cm_offering o
        JOIN cm_course c USING(course_id)
        WHERE o.status = 'active'
        ORDER BY c.code""")
    teacher_map = {}
    for r in teaching_rows:
        tid = r['teacher_id']
        if tid not in teacher_map:
            teacher_map[tid] = []
        teacher_map[tid].append(f"{r['code']} {r['name']}")
    
    teachers = [
        {'userId': tid, 'desc': '当前授课: ' + ' / '.join(courses)}
        for tid, courses in teacher_map.items()
    ]
    if not any(t['userId'] == 'admin' for t in teachers):
        teachers.append({'userId': 'admin', 'desc': '系统管理员（全校课程统览）'})
    
    student_rows = db.rows("""SELECT DISTINCT e.user_id, e.student_no, c.code
        FROM cm_enrollment e
        JOIN cm_offering o USING(offering_id)
        JOIN cm_course c USING(course_id)
        WHERE e.status = 'active' AND e.role = 'student'
        ORDER BY e.user_id""")
    student_map = {}
    for r in student_rows:
        uid = r['user_id']
        if uid not in student_map:
            student_map[uid] = {'studentNo': r.get('student_no') or uid, 'courses': []}
        student_map[uid]['courses'].append(r['code'])
    
    students = [
        {'userId': uid, 'studentNo': info['studentNo'], 'desc': '当前选修: ' + ', '.join(info['courses'])}
        for uid, info in student_map.items()
    ]
    if not students:
        students = [{'userId': 'cm_pilot_student', 'studentNo': '2026001', 'desc': '体验学生'}]

    return {
        'teachers': teachers,
        'students': students,
        'defaultUsers': DEV_USERS,
        'ssoSupport': {
            'enabled': bool(os.environ.get('COURSE_SSO_HEADER')),
            'header': os.environ.get('COURSE_SSO_HEADER', 'X-Remote-User'),
            'roleHeader': os.environ.get('COURSE_SSO_ROLE_HEADER', 'X-Remote-Role'),
        }
    }


@router.get('/api/faq')
def get_faq():
    return {
        'compilers': [
            {'lang': 'C', 'compiler': 'GCC 9.4+', 'command': 'gcc -O2 -Wall -std=c11 source.c -lm', 'timeLimit': '1.0s', 'memoryLimit': '128MB'},
            {'lang': 'C++', 'compiler': 'G++ 9.4+ / Clang', 'command': 'g++ -O2 -Wall -std=c++17 source.cpp -lm', 'timeLimit': '1.0s', 'memoryLimit': '128MB'},
            {'lang': 'Python', 'compiler': 'Python 3.9+', 'command': 'python3 -u source.py', 'timeLimit': '3.0s (x3倍)', 'memoryLimit': '256MB'},
            {'lang': 'Java', 'compiler': 'OpenJDK 17', 'command': 'javac -J-Xms32m -J-Xmx256m Main.java / java Main', 'timeLimit': '2.0s (x2倍)', 'memoryLimit': '256MB'}
        ],
        'verdicts': [
            {'code': 'AC', 'name': '正确 (Accepted)', 'color': 'ok', 'desc': '恭喜！程序在全部测试点均输出了正确结果，且时空消耗在限制范围内。'},
            {'code': 'WA', 'name': '答案错误 (Wrong Answer)', 'color': 'danger', 'desc': '程序输出的内容与预期标准输出不符，请检查算法逻辑或边界用例。'},
            {'code': 'TLE', 'name': '时间超限 (Time Limit Exceeded)', 'color': 'warn', 'desc': '程序运行耗时超过限制，通常是因为算法复杂度过高或存在死循环。'},
            {'code': 'MLE', 'name': '内存超限 (Memory Limit Exceeded)', 'color': 'warn', 'desc': '程序申请的内存空间超出上限，请检查大型数组开辟或递归深度。'},
            {'code': 'RE', 'name': '运行错误 (Runtime Error)', 'color': 'warn', 'desc': '程序运行时崩溃，常见原因有除零、数组越界、空指针解引用或栈溢出。'},
            {'code': 'CE', 'name': '编译错误 (Compile Error)', 'color': 'warn', 'desc': '源码未通过编译器编译，点击该条记录可查看编译器详细报错提示。'},
            {'code': 'PE', 'name': '格式错误 (Presentation Error)', 'color': 'neutral', 'desc': '输出结果仅在空格或换行等格式排版上与标准输出存在细微差异。'},
            {'code': 'OLE', 'name': '输出超限 (Output Limit Exceeded)', 'color': 'warn', 'desc': '程序打印了过多冗余信息（如调试输出漏删或死循环打印）。'}
        ],
        'ioTips': [
            {'title': '关于多组测试数据读取 (EOF)', 'desc': '题目未声明输入组数时通常以文件末尾 EOF 为结束标志。C/C++ 可用 while(scanf(...) != EOF) 或 while(cin >> x)；Python 可用 sys.stdin.read().split() 批量处理。'},
            {'title': 'I/O 性能优化', 'desc': '在 C++ 中处理大数据量时，建议在 main 函数头部加入 std::ios::sync_with_stdio(false); std::cin.tie(nullptr); 并尽量避免使用 std::endl。'},
            {'title': '避免冗余提示信息', 'desc': '提交代码中切勿包含“请输入：”等交互提示文字，判题机严格比对 stdout，任何多余字符均会导致 WA。'}
        ]
    }
