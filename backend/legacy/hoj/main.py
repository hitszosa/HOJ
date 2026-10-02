"""Local Course Service pilot using the existing MySQL/HUSTOJ contract.

Docker transport is for local development. Session identities come from signed,
HttpOnly cookies; development accounts are available only with COURSE_DEV_LOGIN=1.
"""
from __future__ import annotations

import os

from fastapi import FastAPI, Response

from hoj import config  # noqa: F401  加载 backend/.env，须先于读取环境变量的模块
from hoj.api import (batches, drafts, offerings, problem_sets, public_problems, ranking, session,
                     submissions, system, teacher_library)


app = FastAPI(title='HUSTOJ 教学服务', version='0.3.0')


@app.middleware('http')
async def request_guard(request, call_next):
    if request.method not in ('GET','HEAD','OPTIONS'):
        origin = request.headers.get('origin')
        allowed_origins = {value.strip() for value in os.environ.get(
            'COURSE_ALLOWED_ORIGINS', 'http://localhost:3100,http://127.0.0.1:3100').split(',') if value.strip()}
        # CSRF origin checking does not replace authentication, including for clients without Origin.
        if origin and origin not in allowed_origins:
            return Response('跨站请求被拒绝',403)
        if int(request.headers.get('content-length','0')) > 1048576:
            return Response('文件不能超过 1MB',413)
    response = await call_next(request)
    response.headers['Cache-Control']='no-store'
    return response


for module in (system, session, offerings, batches, submissions, drafts, teacher_library,
               problem_sets, public_problems, ranking):
    app.include_router(module.router)
