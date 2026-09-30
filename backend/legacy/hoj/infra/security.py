from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import time

from fastapi import HTTPException

from hoj.config import ROOT


def key():
    location = ROOT / 'data/local/session.key'
    location.parent.mkdir(parents=True, exist_ok=True)
    try:
        fd = os.open(location, os.O_WRONLY|os.O_CREAT|os.O_EXCL, 0o600)
    except FileExistsError: pass
    else:
        with os.fdopen(fd,'w') as f: f.write(secrets.token_hex(32))
    return location.read_bytes()


def cookie(user):
    payload = base64.urlsafe_b64encode(json.dumps({'user':user,'exp':time.time()+43200}).encode()).decode()
    return payload+'.'+hmac.new(key(),payload.encode(),hashlib.sha256).hexdigest()


def trial_token(sid, bid, pid, user):
    payload = base64.urlsafe_b64encode(json.dumps({
        'sid':sid, 'bid':bid, 'pid':pid, 'user':user, 'exp':int(time.time())+3600,
    }, separators=(',', ':')).encode()).decode().rstrip('=')
    signature = hmac.new(key(), ('trial:'+payload).encode(), hashlib.sha256).hexdigest()
    return payload+'.'+signature


def read_trial_token(token, user):
    try:
        if len(token)>2048: raise ValueError()
        payload, signature = token.split('.')
        expected = hmac.new(key(), ('trial:'+payload).encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(signature, expected): raise ValueError()
        data = json.loads(base64.urlsafe_b64decode(payload+'='*(-len(payload)%4)))
        if (data['user']!=user or type(data['exp']) is not int or data['exp']<=time.time()
                or any(type(data[k]) is not int or data[k]<=0 for k in ('sid','bid','pid'))):
            raise ValueError()
        return data
    except (ValueError, TypeError, KeyError, UnicodeError):
        raise HTTPException(404, '自测记录不存在或已过期')
