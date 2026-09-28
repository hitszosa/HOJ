from __future__ import annotations

from hoj.hustoj.constants import LANGUAGES, LANG_NAMES
from hoj.infra.database import db, q


def find_user_previous_ac(user: str, problem_row: dict, allowed_languages: list[str] = None) -> dict | None:
    if not user or not problem_row:
        return None
    if isinstance(problem_row, list):
        problem_row = problem_row[0] if problem_row else {}
    source = str(problem_row.get('source') or '').strip()
    title = str(problem_row.get('title') or '').strip()
    pid = int(problem_row.get('problem_id') or 0)
    if pid <= 0:
        return None

    slug = None
    if source.startswith('codemind:authoring/'):
        slug = source.split('/')[-1]
    elif source.startswith('bank:'):
        slug = source[len('bank:'):]

    match_conds = [f"p.problem_id = {pid}"]
    if slug:
        match_conds.append(f"p.source = {q(f'bank:{slug}')}")
        match_conds.append(f"p.source LIKE {q(f'%/{slug}')}")
    if title:
        match_conds.append(f"p.title = {q(title)}")

    or_clause = " OR ".join(match_conds)
    sql = f"""
        SELECT s.solution_id, s.problem_id, s.language, s.time, s.memory, s.in_date, sc.source as code
        FROM jol.solution s
        JOIN jol.source_code sc ON sc.solution_id = s.solution_id
        JOIN jol.problem p ON p.problem_id = s.problem_id
        WHERE s.user_id = {q(user)}
          AND s.result = 4
          AND ({or_clause})
        ORDER BY s.solution_id DESC
        LIMIT 10
    """
    rows = db.rows(sql)
    if not rows:
        return None

    rev_langs = {v: k for k, v in LANGUAGES.items()}
    parsed = []
    for r in rows:
        lang_int = int(r.get('language') or 0)
        lang_key = rev_langs.get(lang_int, 'cpp' if lang_int == 1 else 'c')
        lang_name = LANG_NAMES.get(lang_int, lang_key.upper())
        code = r.get('code') or ''
        if lang_key == 'python' and code.startswith('# coding=utf-8\n'):
            code = code[len('# coding=utf-8\n'):]
        is_allowed = True
        if allowed_languages and len(allowed_languages) > 0:
            is_allowed = (lang_key in allowed_languages)
        parsed.append({
            'hasPreviousAc': True,
            'solutionId': int(r['solution_id']),
            'language': lang_key,
            'languageName': lang_name,
            'code': code,
            'time': int(r.get('time') or 0),
            'memory': int(r.get('memory') or 0),
            'inDate': str(r.get('in_date') or ''),
            'isLanguageAllowed': is_allowed
        })

    allowed_rows = [item for item in parsed if item['isLanguageAllowed']]
    return allowed_rows[0] if allowed_rows else parsed[0]
