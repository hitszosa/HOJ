from __future__ import annotations

import os
import re

from fastapi import HTTPException
import httpx


def native_session(request):
    """Verify the existing HUSTOJ session; never accept client-declared identity."""
    name = os.environ.get('COURSE_HUSTOJ_COOKIE', 'PHPSESSID')
    sid = request.cookies.get(name)
    if sid is None:
        return None
    if not re.fullmatch(r'[A-Za-z0-9,-]{16,256}', sid):
        raise HTTPException(401, 'HUSTOJ 登录已失效，请重新登录')
    endpoint = os.environ.get('COURSE_HUSTOJ_SESSION_URL', 'http://127.0.0.1:8080/course.php?mode=session')
    try:
        with httpx.Client(timeout=5, trust_env=False, follow_redirects=False) as client:
            response = client.get(endpoint, cookies={name: sid})
        if response.status_code == 401:
            raise HTTPException(401, '请先登录 HUSTOJ')
        if response.status_code != 200 or len(response.content) > 8192:
            raise ValueError('invalid session response')
        data = response.json()
        if (not isinstance(data, dict) or data.get('authSource') != 'hustoj'
                or not isinstance(data.get('user'), str)
                or not 1 <= len(data['user']) <= 64
                or any(ord(c) < 32 for c in data['user'])):
            raise ValueError('invalid session identity')
    except (httpx.HTTPError, ValueError, TypeError):
        raise HTTPException(503, 'HUSTOJ 身份服务暂时不可用')
    return {'user': data['user'], 'authSource': 'hustoj'}
