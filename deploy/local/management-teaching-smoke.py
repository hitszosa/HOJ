#!/usr/bin/env python3
"""Verify the simplified teaching workflow against the isolated local demo class."""
import json
import urllib.request
from pathlib import Path
from importlib.util import spec_from_file_location, module_from_spec

ROOT = Path(__file__).resolve().parents[2]
spec = spec_from_file_location('bridge_smoke', ROOT / 'deploy/local/management-smoke.py')
module = module_from_spec(spec)
spec.loader.exec_module(module)
Session = module.Session


def main():
    checks = []

    def check(name, condition):
        assert condition, name
        checks.append(name)

    teacher, student, ta = Session(), Session(), Session()
    teacher.login('teacher')
    profile = student.login('student')
    ta.login('ta')
    links = teacher.ok('/management-api/hoj/links')
    course = next(link['course_id'] for link in links if link['offering_id'] == 1)
    demo = json.loads((ROOT / '.local/management-teaching-demo.json').read_text())
    assignment = demo['examples'][0]['assignment_id']
    submissions = teacher.ok(f'/management-api/submissions?course={course}&assignment={assignment}')
    submission = next(s for s in submissions if s['user']['id'] == profile['id'])
    sid = submission['id']
    original = submission['score']
    capability = teacher.ok('/management-api/files/download', 'POST', {'ident': submission['file']})
    http = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with http.open(capability['url'], timeout=15) as response:
        check('Original teaching attachment can be downloaded', response.status == 200 and len(response.read()) > 0)
    try:
        check('Student cannot score a submission', student.request('/management-api/submissions/score_update', 'POST', {'submission': sid, 'score': 70})[0] == 403)
        check('Missing CSRF cannot change a score', teacher.request('/management-api/submissions/score_update', 'POST', {'submission': sid, 'score': 70}, csrf=False)[0] == 403)
        scored = ta.ok('/management-api/submissions/score_update', 'POST', {'submission': sid, 'score': 0})
        check('Course assistant can record zero points', scored['status'] == 1 and scored['score'] == 0)
        report = teacher.ok(f'/management-api/assignments/{assignment}/grading/report')
        own = next(row for row in report if row['user_id'] == profile['id'])
        check('Export distinguishes graded zero from ungraded', own['score'] == 0 and own['submission_id'] == sid)
        check('Export includes missing students', any(row['submission_id'] is None and row['score'] is None for row in report))
        check('Export contains only teaching score fields', set(own) == {'user_id', 'username', 'real_name', 'submission_id', 'score'})
        check('Student cannot export class scores', student.request(f'/management-api/assignments/{assignment}/grading/report')[0] == 403)
        missing = teacher.ok(f'/management-api/submissions/no_submission_students?assignment={assignment}')
        check('Missing roster excludes submitted student', profile['id'] not in [s['id'] for s in missing] and len(missing) > 0)
        check('Assignment statistics remain available', teacher.request(f'/management-api/assignments/{assignment}/statistics')[0] == 200)
        check('Course grade statistics remain available', teacher.request(f'/management-api/courses/{course}/statistics')[0] == 200)
        for path, method, body in [
            (f'/management-api/submissions/{sid}/grading/document', 'POST', {}),
            (f'/management-api/submissions/{sid}/grading', 'GET', None),
            (f'/management-api/submissions/{sid}/grading/code', 'GET', None),
            (f'/management-api/submissions/{sid}/grading/code/document', 'POST', {}),
            (f'/management-api/assignments/{assignment}/grading/rubrics', 'GET', None),
        ]:
            check('Removed visual grading endpoint: ' + path, teacher.request(path, method, body)[0] == 404)
    finally:
        teacher.ok('/management-api/submissions/score_update', 'POST', {'submission': sid, 'score': original})
    check('Original demo score restored', next(row for row in teacher.ok(f'/management-api/assignments/{assignment}/grading/report') if row['user_id'] == profile['id'])['score'] == original)
    print(json.dumps({'passed': len(checks), 'checks': checks}, indent=2))


if __name__ == '__main__':
    main()
