from __future__ import annotations

import os
import subprocess
import xml.etree.ElementTree as ET

from fastapi import HTTPException


DB = 'codemind_course'


def q(value):
    if value is None: return 'NULL'
    return "CONVERT(X'%s' USING utf8mb4)" % str(value).encode().hex()


class Database:
    def call(self, sql, ops=False, xml=False):
        prefix = 'COURSE_OPS_' if ops else 'COURSE_DB_'
        user = os.environ.get(prefix+'USER', 'codemind_ops' if ops else 'codemind')
        password = os.environ.get(prefix+'PASSWORD') or os.environ.get('COURSE_DB_PASSWORD')
        if not password: raise HTTPException(503, '尚未配置数据库连接')
        command = ['docker','exec','-i',os.environ.get('COURSE_CONTAINER','hustoj'), 'mysql', '--default-character-set=utf8mb4', '-u'+user, '-p'+password, DB]
        command += ['--xml'] if xml else ['-N','-B']
        try:
            result = subprocess.run(command, input=sql, text=True, capture_output=True, timeout=20)
        except (OSError, subprocess.TimeoutExpired):
            raise HTTPException(503, '判题服务暂时不可达')
        if result.returncode: raise HTTPException(503, '数据库操作失败，请查看课程服务配置与授权')
        return result.stdout

    def rows(self, sql):
        data = self.call(sql, xml=True)
        if not data.strip(): return []
        return [{f.attrib['name']: f.text for f in row} for row in ET.fromstring(data).findall('row')]

    def one(self, sql):
        rows = self.rows(sql)
        return rows[0] if rows else None

    def write(self, sql, ops=False):
        return self.call(sql, ops=ops).strip()


class DatabaseHandle:
    """稳定的模块级句柄：业务代码 `from hoj.infra.database import db`，测试替换 `db.backend`。"""
    def __init__(self, backend):
        self.backend = backend

    def rows(self, sql):
        return self.backend.rows(sql)

    def one(self, sql):
        return self.backend.one(sql)

    def write(self, sql, ops=False):
        return self.backend.write(sql, ops=ops)


db = DatabaseHandle(Database())
