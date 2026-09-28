from __future__ import annotations

import time

from fastapi import HTTPException

from hoj.infra.database import db, q


def offering_access(user, oid, teacher=False, write=False):
    """单一权限闸：无成员资格 404，成员但教师权限不足 403，历史（archived）教学班写操作 409。"""
    row = db.one(f"SELECT o.*, e.role FROM cm_offering o LEFT JOIN cm_enrollment e ON e.offering_id=o.offering_id AND e.user_id={q(user)} AND e.status='active' WHERE o.offering_id={int(oid)}")
    if not row or (row['teacher_id'] != user and not row['role'] and user != 'admin'): raise HTTPException(404,'教学班不存在或不可访问')
    role = 'teacher' if (row['teacher_id']==user or user == 'admin') else row['role']
    if teacher and role!='teacher': raise HTTPException(403,'只有本教学班教师可以操作')
    if write and row['status']=='archived': raise HTTPException(409,'历史教学班为只读，不能修改、发布或提交')
    row['role']=role
    return row


def batch_access(user, bid, teacher=False, write=False):
    b = db.one(f'SELECT * FROM cm_batch WHERE batch_id={int(bid)}')
    if not b: raise HTTPException(404,'题单不存在')
    off = offering_access(user,b['offering_id'],teacher,write=write)
    if off['role']=='student' and (b['status']=='draft' or (b['open_at'] and b['open_at'] > time.strftime('%Y-%m-%d %H:%M:%S'))):
        raise HTTPException(404,'题单尚未开放')
    return b,off


def check_teacher(user: str):
    if user == 'admin':
        return
    rows = db.rows(f"""SELECT 1 FROM jol.privilege WHERE user_id={q(user)} AND rightstr IN ('teacher', 'administrator')
                       UNION SELECT 1 FROM cm_offering WHERE teacher_id={q(user)} LIMIT 1""")
    if not rows:
        raise HTTPException(403, '只有教师身份可以访问此功能')


def get_teacher_primary_offering(user: str) -> int:
    row = db.one(f"""SELECT o.offering_id FROM cm_offering o 
                     WHERE (o.teacher_id={q(user)} OR {q(user)}='admin') AND o.status='active' 
                     ORDER BY o.term DESC LIMIT 1""")
    if row:
        return int(row['offering_id'])
    row2 = db.one("SELECT offering_id FROM cm_offering ORDER BY offering_id DESC LIMIT 1")
    if row2:
        return int(row2['offering_id'])
    raise HTTPException(400, '暂无可用教学班，请先开设或分配教学班')
