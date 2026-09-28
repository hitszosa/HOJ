from __future__ import annotations

import os

from fastapi import APIRouter, HTTPException, Request, Response

from hoj.auth import DEV_USERS, is_allowed_dev_user, principal
from hoj.infra.database import db, q
from hoj.infra.security import cookie

router = APIRouter()


@router.post('/api/session')
def login(data:dict, response:Response):
    if os.environ.get('COURSE_DEV_LOGIN')!='1': raise HTTPException(403,'开发登录已关闭，请接入学校身份认证')
    user = data.get('userId') or DEV_USERS.get(data.get('role'))
    if not user or not is_allowed_dev_user(user):
        raise HTTPException(400, '未知测试身份或用户不存在')
    response.set_cookie('course_session',cookie(user),httponly=True,samesite='strict',max_age=43200)
    # Explicitly choosing a development identity must not reuse a native session.
    response.delete_cookie(os.environ.get('COURSE_HUSTOJ_COOKIE', 'PHPSESSID'))
    return {'user':user}


@router.delete('/api/session')
def logout(response:Response):
    # Preserve PHPSESSID until HUSTOJ's logout endpoint destroys its server session.
    response.delete_cookie('course_session')
    return {'ok':True, 'logoutUrl':'/oj/logout.php'}


@router.get('/api/me')
def me(request:Request):
    user=principal(request)
    # Portal selection is derived from persisted authority, never request flags.
    # This selects a workspace only; offering_access still authorizes every course.
    assigned = db.rows(f"""SELECT 'teacher' AS role FROM jol.privilege
        WHERE user_id={q(user)} AND rightstr IN ('teacher', 'administrator')
        UNION SELECT 'teacher' AS role FROM cm_offering WHERE teacher_id={q(user)}
        UNION SELECT role FROM cm_enrollment WHERE user_id={q(user)} AND status='active'""")
    roles = sorted({row['role'] for row in assigned
                    if row.get('role') in ('student', 'teacher', 'ta')}) or ['student']
    if user == 'admin':
        roles = ['admin', 'teacher']
    portal = 'teacher' if any(role in roles for role in ('teacher', 'ta', 'admin')) else 'student'
    return {'user':user,'devLogin':os.environ.get('COURSE_DEV_LOGIN')=='1',
            'authSource':request.state.course_identity['authSource'],
            'roles':roles, 'portal':portal, 'home':'/'+portal}
