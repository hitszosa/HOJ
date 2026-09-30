from __future__ import annotations

from fastapi import APIRouter, Request

from hoj.auth import principal
from hoj.infra.database import db
from hoj.services.access import offering_access

router = APIRouter()


@router.get('/api/ranklist')
def get_ranklist(request: Request, offeringId: int = None, page: int = 1, pageSize: int = 50):
    user = principal(request)
    limit = max(1, min(pageSize, 100))
    offset = (max(1, page) - 1) * limit

    if offeringId is not None and offeringId > 0:
        offering_access(user, int(offeringId))
        sql = f"""
            SELECT e.user_id, COALESCE(u.nick, e.user_id) as nick,
                   COUNT(DISTINCT CASE WHEN s.result = 4 AND s.problem_id > 0 THEN s.problem_id END) as solved,
                   COUNT(CASE WHEN s.problem_id > 0 THEN s.solution_id END) as submit,
                   MAX(s.in_date) as last_submit
            FROM cm_enrollment e
            LEFT JOIN jol.users u ON u.user_id = e.user_id
            LEFT JOIN cm_submission cs ON cs.user_id = e.user_id AND cs.offering_id = {int(offeringId)}
            LEFT JOIN jol.solution s ON s.solution_id = cs.submission_id
            WHERE e.offering_id = {int(offeringId)} AND e.role = 'student' AND e.status = 'active'
            GROUP BY e.user_id, u.nick
            ORDER BY solved DESC, submit ASC, last_submit DESC
            LIMIT {limit} OFFSET {offset}
        """
        total_sql = f"SELECT COUNT(*) as n FROM cm_enrollment WHERE offering_id={int(offeringId)} AND role='student' AND status='active'"
    else:
        sql = f"""
            SELECT u.user_id, COALESCE(u.nick, u.user_id) as nick,
                   COUNT(DISTINCT CASE WHEN s.result = 4 AND s.problem_id > 0 THEN s.problem_id END) as solved,
                   COUNT(CASE WHEN s.problem_id > 0 THEN s.solution_id END) as submit,
                   MAX(s.in_date) as last_submit
            FROM jol.users u
            LEFT JOIN jol.solution s ON s.user_id = u.user_id
            WHERE u.defunct = 'N'
              AND u.user_id NOT IN ('admin')
              AND u.user_id NOT LIKE 'teacher_%'
              AND u.user_id NOT LIKE 'test_%'
              AND u.user_id NOT IN ('cm_pilot_teacher', 'cm_pilot_ta', 'cm_pilot_outsider')
              AND u.user_id NOT IN (SELECT DISTINCT user_id FROM jol.privilege WHERE rightstr IN ('administrator', 'teacher'))
            GROUP BY u.user_id, u.nick
            ORDER BY solved DESC, submit ASC, last_submit DESC
            LIMIT {limit} OFFSET {offset}
        """
        total_sql = """
            SELECT COUNT(*) as n FROM jol.users u
            WHERE u.defunct = 'N'
              AND u.user_id NOT IN ('admin')
              AND u.user_id NOT LIKE 'teacher_%'
              AND u.user_id NOT LIKE 'test_%'
              AND u.user_id NOT IN ('cm_pilot_teacher', 'cm_pilot_ta', 'cm_pilot_outsider')
              AND u.user_id NOT IN (SELECT DISTINCT user_id FROM jol.privilege WHERE rightstr IN ('administrator', 'teacher'))
        """

    rows = db.rows(sql)
    total_row = db.one(total_sql)
    total_count = int(total_row['n']) if total_row else 0

    my_rank = None
    for i, r in enumerate(rows):
        r['rank'] = offset + i + 1
        r['userId'] = r['user_id']
        solved = int(r.get('solved') or 0)
        submit = int(r.get('submit') or 0)
        r['solved'] = solved
        r['submit'] = submit
        r['passRate'] = round((solved / submit * 100), 1) if submit > 0 else 0.0
        r['lastSubmit'] = str(r.get('last_submit') or '')
        if r['user_id'] == user:
            my_rank = r['rank']

    return {
        'items': rows,
        'total': total_count,
        'page': page,
        'pageSize': limit,
        'myRank': my_rank
    }
