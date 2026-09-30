from __future__ import annotations

import json

from fastapi import HTTPException

from hoj.infra.database import db, q
from hoj.services.access import offering_access


def get_draft(ident,user,write=False):
    row=db.one(f'SELECT * FROM cm_authoring_draft WHERE draft_id={q(ident)}')
    if not row: raise HTTPException(404,'草稿不存在')
    offering_access(user,row['offering_id'],True,write=write)
    row['document']=json.loads(row.pop('payload'))
    return row
