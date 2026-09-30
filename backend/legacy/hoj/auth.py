from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import time

from fastapi import HTTPException

from hoj.hustoj.session import native_session
from hoj.infra import security


DEV_USERS = {'student':'cm_pilot_student', 'teacher':'cm_pilot_teacher', 'ta':'cm_pilot_ta', 'outsider':'cm_pilot_outsider'}


def is_allowed_dev_user(user: str) -> bool:
    if not isinstance(user, str) or not re.fullmatch(r'[A-Za-z0-9_.-]{1,64}', user):
        return False
    return True


def principal(request):
    cached = getattr(request.state, 'course_identity', None)
    if cached:
        return cached['user']
    # 优先支持统一身份认证 (SSO) 反向代理头（如学校 CAS / SAML / Keycloak 通过 Nginx 注入）
    sso_header = os.environ.get('COURSE_SSO_HEADER', 'X-Remote-User')
    sso_user = request.headers.get(sso_header)
    if sso_user and sso_user.strip():
        u = sso_user.strip()
        if re.fullmatch(r'[A-Za-z0-9_.-]{1,64}', u):
            identity = {'user': u, 'authSource': 'sso'}
            request.state.course_identity = identity
            return u
    identity = native_session(request)
    if identity:
        request.state.course_identity = identity
        return identity['user']
    if os.environ.get('COURSE_DEV_LOGIN') != '1':
        raise HTTPException(401, '请先登录 HUSTOJ')
    try:
        payload, sig = request.cookies.get('course_session','').split('.')
        if not hmac.compare_digest(sig,hmac.new(security.key(),payload.encode(),hashlib.sha256).hexdigest()): raise ValueError()
        decoded = json.loads(base64.urlsafe_b64decode(payload))
        if decoded['exp'] < time.time(): raise ValueError()
        if not is_allowed_dev_user(decoded['user']): raise ValueError()
        request.state.course_identity = {'user': decoded['user'], 'authSource': 'development'}
        return decoded['user']
    except (ValueError, KeyError, TypeError): raise HTTPException(401,'请先登录课程平台')
