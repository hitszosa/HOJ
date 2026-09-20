"""Offline boundary regressions for the teaching service (no shared database).

The suite stands up an in-memory stand-in for `service.db` and drives the real
HTTP app, so every case exercises routing, permissions and the contractual
status codes without touching MySQL/HUSTOJ.
"""
import copy
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import unittest
import uuid
from unittest.mock import patch

SERVICE_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVICE_ROOT))
sys.path.insert(0, str(SERVICE_ROOT / 'tools'))
from fastapi.testclient import TestClient  # noqa: E402
import hoa  # noqa: E402
import service  # noqa: E402
TEACHER = 'cm_pilot_teacher'
STUDENT = 'cm_pilot_student'
OUTSIDER = 'cm_pilot_outsider'
ACTIVE_OID = 1
ARCHIVED_OID = 2
PROBLEM_ID = 1025

DOC = {'title': '体验作业 · 两个整数的和', 'problems': [
    {'slug': 'sum-two', 'title': '两个整数的和', 'statement': '输入两个整数 a 和 b，输出它们的和。',
     'samples': [{'input': '1 2\n', 'output': '3\n'}],
     'tests': [{'input': '-2 5\n', 'output': '3\n'}, {'input': '1000000 1000000\n', 'output': '2000000\n'}]}]}


def _hex(sql):
    return [bytes.fromhex(h).decode('utf-8') for h in re.findall(r"X'([0-9a-f]*)'", sql)]


class FakeDB:
    """In-memory stand-in for service.Database, dispatched on the SQL text."""

    def __init__(self):
        self.offerings = {}
        self.enrollments = []
        self.batches = {}
        self.drafts = {}
        self.batch_problems = []
        self.problems = {}
        self.courses = {}
        self.submissions = {}
        self.writes = []
        self.fail_on = None
        self.next_batch_id = 900
        self.next_problem_id = 5000
        self.next_submission_id = 7000

    # ---------------- reads ----------------
    def rows(self, sql):
        if 'FROM cm_batch WHERE batch_id=' in sql:
            row = self.batches.get(int(re.search(r'batch_id=(\d+)', sql).group(1)))
            return [dict(row)] if row else []
        if 'FROM cm_offering o LEFT JOIN' in sql:
            oid = int(re.search(r'o\.offering_id=(\d+)', sql).group(1))
            user = _hex(sql)[0]
            off = self.offerings.get(oid)
            if not off:
                return []
            role = next((e['role'] for e in self.enrollments
                         if e['offering_id'] == oid and e['user_id'] == user and e['status'] == 'active'), None)
            return [dict(off, role=role)]
        if 'FROM cm_batch b WHERE b.offering_id=' in sql:
            oid = int(re.search(r'b\.offering_id=(\d+)', sql).group(1))
            return [b for b in self.batches.values() if int(b['offering_id']) == oid]
        if 'FROM cm_authoring_draft WHERE draft_id=' in sql:
            ident = _hex(sql)[0]
            row = self.drafts.get(ident)
            return [dict(row)] if row else []
        if 'FROM cm_authoring_draft WHERE offering_id=' in sql:
            oid = int(re.search(r'offering_id=(\d+)', sql).group(1))
            return [{'draft_id': k, 'title': v['title'], 'status': v['status'], 'origin': v['origin'],
                     'updated_at': '2026-09-19 00:00:00'}
                    for k, v in self.drafts.items() if int(v['offering_id']) == oid]
        if 'FROM cm_batch_problem bp JOIN jol.problem p USING(problem_id)' in sql:
            bid = int(re.search(r'bp\.batch_id=(\d+)', sql).group(1))
            return [dict(self.problems[int(bp['problem_id'])], **bp)
                    for bp in self.batch_problems if int(bp['batch_id']) == bid]
        if 'FROM jol.problem p JOIN cm_batch_problem bp USING(problem_id)' in sql:
            bid = int(re.search(r'bp\.batch_id=(\d+)', sql).group(1))
            return [self.problems[int(bp['problem_id'])]
                    for bp in self.batch_problems if int(bp['batch_id']) == bid]
        if 'FROM cm_course WHERE course_id=' in sql:
            row = self.courses.get(int(re.search(r'course_id=(\d+)', sql).group(1)))
            return [row] if row else []
        return []

    def one(self, sql):
        if 'SELECT COALESCE(MAX(seq),0)+1 n FROM cm_batch' in sql:
            oid = int(re.search(r'offering_id=(\d+)', sql).group(1))
            seqs = [int(b['seq']) for b in self.batches.values() if int(b['offering_id']) == oid]
            return {'n': str(max(seqs) + 1 if seqs else 1)}
        if 'FROM cm_batch WHERE authoring_key=' in sql:
            key = _hex(sql)[0]
            for b in self.batches.values():
                if b.get('authoring_key') == key:
                    return dict(b)
            return None
        if 'SELECT COUNT(DISTINCT s.problem_id) n FROM cm_submission' in sql:
            return {'n': '0'}
        if 'SELECT COUNT(*) attempts' in sql:
            return {'attempts': '0', 'passed': '0'}
        if 'SELECT batch_problem_id FROM cm_batch_problem' in sql:
            bid, pid = re.search(r'batch_id=(\d+) AND problem_id=(\d+)', sql).groups()
            for bp in self.batch_problems:
                if int(bp['batch_id']) == int(bid) and int(bp['problem_id']) == int(pid):
                    return bp
            return None
        if 'SELECT problem_id FROM jol.problem WHERE source=' in sql:
            source = _hex(sql)[0]
            for pid, p in self.problems.items():
                if p.get('source') == source:
                    return {'problem_id': pid}
            return None
        if 'FROM jol.compileinfo' in sql or 'FROM jol.runtimeinfo' in sql:
            return None
        rows = self.rows(sql)
        return rows[0] if rows else None

    # ---------------- writes ----------------
    def write(self, sql, ops=False):
        """Apply every statement in one call; only id-returning INSERTs produce output."""
        self.writes.append(sql)
        if self.fail_on and self.fail_on in sql:
            raise RuntimeError('injected failure at: ' + self.fail_on)
        for part in (chunk.strip() for chunk in sql.split(';')):
            if not part:
                continue
            produced = self.apply(part)
            if produced:
                return produced
        return ''

    def apply(self, sql):
        if 'INSERT INTO cm_batch(' in sql:
            oid, seq = (int(x) for x in re.search(r'VALUES\((\d+),(\d+)', sql).groups())
            values = _hex(sql)
            batch = {'batch_id': None, 'offering_id': oid, 'seq': seq, 'title': values[0], 'status': 'draft',
                     'open_at': None, 'due_at': None, 'ai_enabled': '1', 'allow_late': '0',
                     'read_only': re.search(r"'draft',(\d),", sql).group(1),
                     'source_ref': values[1] if len(values) > 2 else None,
                     'authoring_key': values[-1]}
            for existing in self.batches.values():
                if existing.get('authoring_key') == batch['authoring_key']:
                    return str(existing['batch_id'])          # uk_batch_authoring_key hit
                if int(existing['offering_id']) == oid and int(existing['seq']) == seq:
                    # uk_batch_seq hit: nothing is inserted, the caller retries with the next seq.
                    return ''
            bid = self.next_batch_id
            self.next_batch_id += 1
            batch['batch_id'] = bid
            self.batches[bid] = batch
            return str(bid)
        if 'UPDATE cm_batch SET authoring_key=' in sql:
            bid = int(re.search(r'WHERE batch_id=(\d+)', sql).group(1))
            batch = self.batches[bid]
            if batch.get('authoring_key') is None:
                batch['authoring_key'] = _hex(sql)[0]
            if 'GREATEST(read_only,1)' in sql:
                batch['read_only'] = '1'
            return ''
        if 'UPDATE cm_batch SET title=' in sql:
            bid = int(re.search(r'WHERE batch_id=(\d+)', sql).group(1))
            self.batches[bid]['title'] = _hex(sql)[0]
            if 'GREATEST(read_only,1)' in sql:
                self.batches[bid]['read_only'] = '1'
            if 'source_ref=COALESCE(' in sql and len(_hex(sql)) > 1:
                self.batches[bid]['source_ref'] = _hex(sql)[1]
            return ''
        if 'UPDATE cm_batch SET status=' in sql:
            bid = int(re.search(r'WHERE batch_id=(\d+)', sql).group(1))
            self.batches[bid]['status'] = 'published'
            if 'GREATEST(read_only,1)' in sql:
                self.batches[bid]['read_only'] = '1'
            return ''
        if 'UPDATE cm_batch SET ai_enabled=' in sql:
            bid = int(re.search(r'WHERE batch_id=(\d+)', sql).group(1))
            self.batches[bid]['ai_enabled'] = sql.split('ai_enabled=')[1].split(',')[0]
            return ''
        if 'UPDATE cm_authoring_draft SET batch_id=' in sql:
            self.drafts[_hex(sql)[-1]]['batch_id'] = int(re.search(r'batch_id=(\d+)', sql).group(1))
            return ''
        if 'INSERT INTO cm_authoring_draft(' in sql:
            ident, user, title, payload = _hex(sql)[:4]
            oid = int(re.search(r'USING utf8mb4\),(\d+)', sql).group(1))
            self.drafts[ident] = {'draft_id': ident, 'offering_id': oid, 'owner_id': user, 'title': title,
                                  'payload': payload, 'status': 'draft', 'origin': 'teacher', 'batch_id': None}
            return ''
        if 'UPDATE cm_authoring_draft SET title=' in sql:
            title, payload, ident = _hex(sql)[:3]
            self.drafts[ident].update(title=title, payload=payload)
            return ''
        if 'UPDATE cm_authoring_draft SET status=' in sql:
            ident = _hex(sql)[0]
            if ident in self.drafts:
                self.drafts[ident]['status'] = 'published'
            return ''
        if "UPDATE cm_authoring_draft SET origin='ai'" in sql:
            return ''
        if 'INSERT INTO jol.problem(' in sql:
            title, statement, sample_in, sample_out, hint, source = _hex(sql)[:6]
            pid = self.next_problem_id
            self.next_problem_id += 1
            self.problems[pid] = {'problem_id': pid, 'title': title, 'description': statement,
                                  'sample_input': sample_in, 'sample_output': sample_out, 'hint': hint,
                                  'source': source, 'defunct': 'Y'}
            return str(pid)
        if 'UPDATE jol.problem SET title=' in sql:
            title, statement, sample_in, sample_out, hint = _hex(sql)[:5]
            pid = int(re.search(r'WHERE problem_id=(\d+)', sql).group(1))
            self.problems[pid].update(title=title, description=statement, sample_input=sample_in,
                                      sample_output=sample_out, hint=hint)
            return ''
        if 'INSERT INTO cm_batch_problem(' in sql:
            for bid, pid, seq in re.findall(r'\((\d+),(\d+),(\d+),', sql):
                bid, pid, seq = int(bid), int(pid), int(seq)
                # uk_bp_seq / uk_bp_problem: a conflict updates seq in place, it never adds a row.
                conflict = next((r for r in self.batch_problems
                                 if int(r['batch_id']) == bid
                                 and (int(r['seq']) == seq or int(r['problem_id']) == pid)), None)
                if conflict is not None:
                    conflict['seq'] = seq
                    continue
                self.batch_problems.append({'batch_id': bid, 'problem_id': pid,
                                            'batch_problem_id': len(self.batch_problems) + 1, 'seq': seq})
            return ''
        if 'DELETE FROM cm_batch_problem' in sql:
            bid = int(re.search(r'WHERE batch_id=(\d+)', sql).group(1))
            keep = set()
            found = re.search(r'NOT IN \(([^)]*)\)', sql)
            if found:
                keep = {int(x) for x in found.group(1).split(',')}
            self.batch_problems = [r for r in self.batch_problems
                                   if not (int(r['batch_id']) == bid and int(r['problem_id']) not in keep)]
            return ''
        if 'INSERT INTO jol.solution(' in sql:
            sid = self.next_submission_id
            self.next_submission_id += 1
            self.submissions[sid] = {'submission_id': sid, 'user_id': STUDENT, 'result': '0',
                                     'time': '0', 'memory': '0'}
            return str(sid)
        return ''


def draft_doc(db, ident):
    return json.loads(db.drafts[ident]['payload'])


class BoundaryTests(unittest.TestCase):
    def setUp(self):
        self.db = FakeDB()
        self.db.courses[1] = {'code': 'PILOT1007'}
        self.db.courses[2] = {'code': 'HIST1001'}
        self.db.offerings[ACTIVE_OID] = {'offering_id': ACTIVE_OID, 'course_id': 1, 'term': '2026-秋',
                                         'section': '1', 'status': 'active', 'teacher_id': TEACHER}
        self.db.offerings[ARCHIVED_OID] = {'offering_id': ARCHIVED_OID, 'course_id': 2, 'term': '2025-秋',
                                           'section': '1', 'status': 'archived', 'teacher_id': TEACHER}
        self.db.enrollments = [
            {'offering_id': ACTIVE_OID, 'user_id': STUDENT, 'role': 'student', 'status': 'active'},
            {'offering_id': ARCHIVED_OID, 'user_id': STUDENT, 'role': 'student', 'status': 'active'},
        ]
        for p in [patch.object(service, 'db', self.db),
                  patch.object(service, 'key', lambda: b'omp-offline-boundary-key'),
                  patch.object(service.subprocess, 'run',
                               lambda *a, **k: subprocess.CompletedProcess(a, 0, '', '')),
                  # Development cookies are only honoured with the switch on; keep it scoped to the test.
                  patch.dict(os.environ, {'COURSE_DEV_LOGIN': '1', 'COURSE_HUSTOJ_COOKIE': 'PHPSESSID'})]:
            p.start()
            self.addCleanup(p.stop)

    # ---------------- helpers ----------------
    def client(self, user):
        c = TestClient(service.app, raise_server_exceptions=False)
        c.cookies.set('course_session', service.cookie(user))
        return c

    def new_batch(self, oid=ACTIVE_OID, status='published', read_only='0', source_ref=None, bid=None):
        bid = bid if bid is not None else self.db.next_batch_id
        self.db.next_batch_id += 1
        self.db.batches[bid] = {'batch_id': bid, 'offering_id': oid, 'seq': 1, 'title': '体验作业', 'status': status,
                                'open_at': None, 'due_at': None, 'ai_enabled': '1', 'allow_late': '0',
                                'read_only': read_only, 'source_ref': source_ref, 'authoring_key': None}
        self.db.problems[PROBLEM_ID] = {'problem_id': PROBLEM_ID, 'title': '两个整数的和', 'description': '求和',
                                        'sample_input': '1 2\n', 'sample_output': '3\n', 'hint': '',
                                        'source': 'codemind:authoring/seed/sum-two', 'defunct': 'N'}
        self.db.batch_problems.append({'batch_id': bid, 'problem_id': PROBLEM_ID,
                                       'batch_problem_id': 1, 'seq': 1})
        return bid

    def new_draft(self, oid=ACTIVE_OID, document=None):
        r = self.client(TEACHER).post(f'/api/offerings/{oid}/drafts', json={'document': copy.deepcopy(document or DOC)})
        self.assertEqual(200, r.status_code, r.text)
        return r.json()['id']

    def seed_draft(self, oid, document=None):
        """Place a draft directly in the store — the API refuses writes in archived classes."""
        ident = uuid.uuid4().hex
        doc = copy.deepcopy(document or DOC)
        self.db.drafts[ident] = {'draft_id': ident, 'offering_id': oid, 'owner_id': TEACHER,
                                 'title': doc['title'], 'payload': json.dumps(doc, ensure_ascii=False),
                                 'status': 'draft', 'origin': 'teacher', 'batch_id': None}
        return ident

    def publish(self, ident):
        return self.client(TEACHER).post(f'/api/drafts/{ident}/publish', json={'reviewed': True})

    # ---------------- membership and role ----------------
    def test_non_member_gets_404(self):
        c = self.client(OUTSIDER)
        self.assertEqual(404, c.get(f'/api/offerings/{ACTIVE_OID}').status_code)
        self.assertEqual(404, c.get(f'/api/offerings/{ARCHIVED_OID}').status_code)
        self.assertEqual(404, c.post(f'/api/offerings/{ACTIVE_OID}/drafts', json={'document': DOC}).status_code)

    def test_member_without_teacher_role_gets_403(self):
        bid = self.new_batch()
        c = self.client(STUDENT)
        self.assertEqual(200, c.get(f'/api/offerings/{ACTIVE_OID}').status_code)
        self.assertEqual(403, c.post(f'/api/offerings/{ACTIVE_OID}/drafts', json={'document': DOC}).status_code)
        self.assertEqual(403, c.patch(f'/api/batches/{bid}', json={'aiEnabled': False}).status_code)
        self.assertEqual(403, c.post(f'/api/batches/{bid}/export', json={'selected': [PROBLEM_ID]}).status_code)

    def test_only_students_submit(self):
        bid = self.new_batch()
        payload = {'code': 'a,b=map(int,input().split())\nprint(a+b)\n', 'language': 'python'}
        self.assertEqual(403, self.client(TEACHER).post(
            f'/api/batches/{bid}/problems/{PROBLEM_ID}/submissions', json=payload).status_code)

    def test_student_submission_is_recorded_once(self):
        bid = self.new_batch()
        payload = {'code': 'a,b=map(int,input().split())\nprint(a+b)\n', 'language': 'python'}
        r = self.client(STUDENT).post(f'/api/batches/{bid}/problems/{PROBLEM_ID}/submissions', json=payload)
        self.assertEqual(200, r.status_code, r.text)
        self.assertEqual(1, len(self.db.submissions))

    # ---------------- archived (history) classes ----------------
    def test_archived_offering_rejects_every_write_with_409(self):
        did = self.seed_draft(ARCHIVED_OID)
        bid = self.new_batch(oid=ARCHIVED_OID)
        teacher = self.client(TEACHER)
        student = self.client(STUDENT)
        self.assertEqual(409, teacher.post(f'/api/offerings/{ARCHIVED_OID}/drafts',
                                           json={'document': DOC}).status_code)
        self.assertEqual(409, teacher.put(f'/api/drafts/{did}', json={'document': DOC}).status_code)
        self.assertEqual(409, teacher.post(f'/api/offerings/{ARCHIVED_OID}/generate',
                                           json={'topic': '循环与边界'}).status_code)
        self.assertEqual(409, teacher.post(f'/api/drafts/{did}/publish', json={'reviewed': True}).status_code)
        self.assertEqual(409, teacher.patch(f'/api/batches/{bid}', json={'aiEnabled': False}).status_code)
        self.assertEqual(409, teacher.post(f'/api/batches/{bid}/copy').status_code)
        self.assertEqual(409, student.post(f'/api/batches/{bid}/problems/{PROBLEM_ID}/submissions',
                                           json={'code': 'print(1)', 'language': 'python'}).status_code)

    def test_archived_offering_reads_stay_available(self):
        bid = self.new_batch(oid=ARCHIVED_OID)
        self.assertEqual(200, self.client(TEACHER).get(f'/api/offerings/{ARCHIVED_OID}').status_code)
        self.assertEqual(200, self.client(STUDENT).get(f'/api/batches/{bid}').status_code)
        self.assertEqual(200, self.client(STUDENT).get(f'/api/batches/{bid}/problems/{PROBLEM_ID}').status_code)
        self.assertEqual(200, self.client(TEACHER).get(f'/api/offerings/{ARCHIVED_OID}/insights').status_code)

    def test_archived_published_non_read_only_batch_is_downloadable(self):
        bid = self.new_batch(oid=ARCHIVED_OID, read_only='0')
        r = self.client(TEACHER).post(f'/api/batches/{bid}/export', json={'selected': [PROBLEM_ID]})
        self.assertEqual(200, r.status_code, r.text)

    # ---------------- publish: idempotency and crash recovery ----------------
    def test_publish_is_idempotent(self):
        did = self.new_draft()
        first = self.publish(did)
        self.assertEqual(200, first.status_code, first.text)
        bid = first.json()['batchId']
        second = self.publish(did)
        self.assertEqual(200, second.status_code, second.text)
        self.assertEqual(bid, second.json()['batchId'])
        self.assertEqual(1, len(self.db.batches))

    def test_publish_crash_then_retry_reuses_the_same_batch(self):
        did = self.new_draft()
        # Crash after the batch row exists (authoring_key written) but before the final transaction.
        self.db.fail_on = 'INSERT INTO cm_batch_problem'
        crashed = self.publish(did)
        self.assertEqual(500, crashed.status_code)
        self.assertEqual(1, len(self.db.batches))
        interrupted_bid = next(iter(self.db.batches))
        self.assertEqual('draft', self.db.batches[interrupted_bid]['status'])
        self.db.fail_on = None
        retried = self.publish(did)
        self.assertEqual(200, retried.status_code, retried.text)
        self.assertEqual(interrupted_bid, retried.json()['batchId'])
        self.assertEqual(1, len(self.db.batches))
        self.assertEqual('published', self.db.batches[interrupted_bid]['status'])
        self.assertEqual(interrupted_bid, self.db.drafts[did]['batch_id'])
        self.assertEqual(1, len(self.db.batch_problems))

    def test_publish_stamps_read_only_on_the_batch(self):
        doc = copy.deepcopy(DOC)
        doc['read_only'] = True
        doc['source_ref'] = 'hoa:HITSZ-OpenAuto/COMP1007@oj/w03.yml'
        did = self.new_draft(document=doc)
        r = self.publish(did)
        self.assertEqual(200, r.status_code, r.text)
        batch = self.db.batches[r.json()['batchId']]
        self.assertEqual('1', batch['read_only'])
        self.assertEqual('hoa:HITSZ-OpenAuto/COMP1007@oj/w03.yml', batch['source_ref'])
        # A published read-only batch must not be exportable afterwards.
        self.assertEqual(409, self.client(TEACHER).post(
            f'/api/batches/{batch["batch_id"]}/export', json={'selected': [PROBLEM_ID]}).status_code)

    def doc_with(self, *slugs):
        return {'title': '体验作业 · 边界', 'problems': [
            {'slug': slug, 'title': f'题目 {slug}', 'statement': f'{slug} 题面',
             'samples': [{'input': '1 2\n', 'output': '3\n'}],
             'tests': [{'input': '-2 5\n', 'output': '3\n'}]} for slug in slugs]}

    def pid_for(self, slug):
        return next(pid for pid, p in self.db.problems.items() if p['source'].endswith('/' + slug))

    def links_for(self, bid):
        return {(int(r['problem_id']), int(r['seq']))
                for r in self.db.batch_problems if int(r['batch_id']) == bid}

    def test_failed_publish_then_replaced_problem_keeps_exactly_one_link(self):
        did = self.new_draft(document=self.doc_with('alpha'))
        self.db.fail_on = "UPDATE jol.problem SET defunct='N'"
        self.assertEqual(500, self.publish(did).status_code)
        updated = self.client(TEACHER).put(f'/api/drafts/{did}', json={'document': self.doc_with('beta')})
        self.assertEqual(200, updated.status_code, updated.text)
        self.db.fail_on = None
        r = self.publish(did)
        self.assertEqual(200, r.status_code, r.text)
        self.assertEqual({(self.pid_for('beta'), 1)}, self.links_for(r.json()['batchId']))

    def test_failed_publish_then_reorder_matches_draft_order(self):
        did = self.new_draft(document=self.doc_with('alpha', 'beta'))
        self.db.fail_on = "UPDATE jol.problem SET defunct='N'"
        self.assertEqual(500, self.publish(did).status_code)
        updated = self.client(TEACHER).put(f'/api/drafts/{did}', json={'document': self.doc_with('beta', 'alpha')})
        self.assertEqual(200, updated.status_code, updated.text)
        self.db.fail_on = None
        r = self.publish(did)
        self.assertEqual(200, r.status_code, r.text)
        self.assertEqual({(self.pid_for('beta'), 1), (self.pid_for('alpha'), 2)}, self.links_for(r.json()['batchId']))

    def test_failed_publish_then_shorter_draft_drops_stale_links(self):
        did = self.new_draft(document=self.doc_with('alpha', 'beta'))
        self.db.fail_on = "UPDATE jol.problem SET defunct='N'"
        self.assertEqual(500, self.publish(did).status_code)
        updated = self.client(TEACHER).put(f'/api/drafts/{did}', json={'document': self.doc_with('alpha')})
        self.assertEqual(200, updated.status_code, updated.text)
        self.db.fail_on = None
        r = self.publish(did)
        self.assertEqual(200, r.status_code, r.text)
        self.assertEqual({(self.pid_for('alpha'), 1)}, self.links_for(r.json()['batchId']))

    def test_legacy_draft_with_null_authoring_key_recovers_without_orphan_batch(self):
        legacy_bid = self.new_batch(status='draft', bid=950)      # batch_id set, authoring_key NULL
        did = self.seed_draft(ACTIVE_OID)
        self.db.drafts[did]['batch_id'] = legacy_bid
        r = self.publish(did)
        self.assertEqual(200, r.status_code, r.text)
        bid = r.json()['batchId']
        self.assertEqual(1, len([b for b in self.db.batches.values() if int(b['offering_id']) == ACTIVE_OID]))
        self.assertEqual(bid, self.db.drafts[did]['batch_id'])
        self.assertEqual('published', self.db.batches[bid]['status'])

    # ---------------- source provenance ----------------
    def test_update_keeps_read_only_and_source_ref(self):
        doc = copy.deepcopy(DOC)
        doc['read_only'] = True
        doc['source_ref'] = 'hoa:HITSZ-OpenAuto/COMP1007@oj/w03.yml'
        did = self.new_draft(document=doc)
        r = self.client(TEACHER).put(f'/api/drafts/{did}', json={'document': copy.deepcopy(DOC)})
        self.assertEqual(200, r.status_code, r.text)
        stored = draft_doc(self.db, did)
        self.assertTrue(stored['read_only'])
        self.assertEqual('hoa:HITSZ-OpenAuto/COMP1007@oj/w03.yml', stored['source_ref'])

    def test_copy_inherits_read_only_and_source_ref(self):
        bid = self.new_batch(read_only='1', source_ref='hoa:HITSZ-OpenAuto/COMP1007@oj/w03.yml')
        r = self.client(TEACHER).post(f'/api/batches/{bid}/copy')
        self.assertEqual(200, r.status_code, r.text)
        stored = draft_doc(self.db, r.json()['id'])
        self.assertTrue(stored.get('read_only'))
        self.assertEqual('hoa:HITSZ-OpenAuto/COMP1007@oj/w03.yml', stored.get('source_ref'))

    def test_provenance_fields_are_validated(self):
        bad_flag = copy.deepcopy(DOC)
        bad_flag['read_only'] = 'yes'
        self.assertEqual(422, self.client(TEACHER).post(
            f'/api/offerings/{ACTIVE_OID}/drafts', json={'document': bad_flag}).status_code)
        long_ref = copy.deepcopy(DOC)
        long_ref['source_ref'] = 'hoa:' + 'a' * 252
        self.assertEqual(422, self.client(TEACHER).post(
            f'/api/offerings/{ACTIVE_OID}/drafts', json={'document': long_ref}).status_code)

    # ---------------- export boundary ----------------
    def test_export_refuses_read_only_batch_even_when_caller_omits_flag(self):
        bid = self.new_batch(read_only='1', source_ref='hoa:x/y@oj/w03.yml')
        teacher = self.client(TEACHER)
        self.assertEqual(409, teacher.post(f'/api/batches/{bid}/export',
                                           json={'selected': [PROBLEM_ID]}).status_code)
        self.assertEqual(409, teacher.post(f'/api/batches/{bid}/export',
                                           json={'selected': [PROBLEM_ID], 'read_only': False}).status_code)

    def test_export_requires_published_batch_and_explicit_selection(self):
        bid = self.new_batch(status='draft')
        teacher = self.client(TEACHER)
        self.assertEqual(409, teacher.post(f'/api/batches/{bid}/export',
                                           json={'selected': [PROBLEM_ID]}).status_code)
        self.db.batches[bid]['status'] = 'published'
        self.assertEqual(422, teacher.post(f'/api/batches/{bid}/export', json={'selected': []}).status_code)
        self.assertEqual(422, teacher.post(f'/api/batches/{bid}/export', json={'selected': [9999]}).status_code)

    def test_export_hides_tests_source_code_and_internal_fields(self):
        bid = self.new_batch()
        r = self.client(TEACHER).post(f'/api/batches/{bid}/export', json={'selected': [PROBLEM_ID]})
        self.assertEqual(200, r.status_code, r.text)
        content = r.json()['content']
        self.assertNotIn('tests:', content)
        self.assertNotIn('source_code', content)
        self.assertNotIn('read_only', content)
        self.assertNotIn('source_ref', content)
        self.assertNotIn('2000000', content)          # hidden test data never leaves


class HoaProvenanceTests(unittest.TestCase):
    """HOA import/export red lines, asserted against the frozen provenance helpers."""

    def setUp(self):
        self.link = hoa.CourseLink(code='COMP1007', course_name='程序设计基础')

    def batch(self, **extra):
        doc = {'course': 'COMP1007', 'batch': 'batch-1', 'seq': 1, 'title': '第三周作业', 'status': 'published',
               'problems': [{'slug': 'p1', 'title': 'A+B', 'statement': '求和',
                             'samples': [{'input': '1 2\n', 'output': '3\n'}]}]}
        doc.update(extra)
        return doc

    def test_export_requires_teacher_selection(self):
        violations = hoa.check_export(hoa.ExportRequest(self.batch(), []))
        self.assertTrue(any('红线1' in v for v in violations))

    def test_export_refuses_read_only_from_either_side(self):
        from_batch = hoa.check_export(hoa.ExportRequest(self.batch(read_only=True), ['p1']))
        from_caller = hoa.check_export(hoa.ExportRequest(self.batch(read_only=False), ['p1'], read_only=True))
        self.assertTrue(any('红线2' in v for v in from_batch))
        self.assertTrue(any('红线2' in v for v in from_caller))

    def test_export_reports_read_only_violation_once(self):
        violations = hoa.check_export(hoa.ExportRequest(self.batch(read_only=True), ['p1'], read_only=True))
        self.assertEqual(1, sum('红线2' in v for v in violations))

    def test_export_refuses_unpublished_batch(self):
        violations = hoa.check_export(hoa.ExportRequest(self.batch(status='draft'), ['p1']))
        self.assertTrue(any('红线3' in v for v in violations))

    def test_export_rebuild_drops_internal_fields(self):
        batch = self.batch(read_only=False, source_ref='hoa:HITSZ-OpenAuto/COMP1007@oj/w03.yml')
        text = hoa.export_to_yaml(hoa.ExportRequest(batch, ['p1']))
        self.assertIn('第三周作业', text)
        self.assertNotIn('read_only', text)
        self.assertNotIn('source_ref', text)

    def test_export_refuses_hidden_tests_and_student_code(self):
        batch = self.batch()
        batch['problems'][0].update(tests=[{'input': '2 2\n', 'output': '4\n'}], source_code='print(1)')
        with self.assertRaises(ValueError) as caught:
            hoa.export_to_yaml(hoa.ExportRequest(batch, ['p1']))
        self.assertIn('红线4', str(caught.exception))
        self.assertIn('红线5', str(caught.exception))

    def test_batch_read_only_is_fail_closed(self):
        self.assertFalse(hoa.batch_read_only({}))
        self.assertTrue(hoa.batch_read_only({'read_only': 'no'}))

    def test_import_rejects_invalid_provenance(self):
        with self.assertRaises(ValueError):
            hoa.validate_batch_provenance({'read_only': 'no'})
        with self.assertRaises(ValueError):
            hoa.validate_batch_provenance({'source_ref': '   '})

    def test_source_ref_points_at_the_batch_file(self):
        expected = 'hoa:HITSZ-OpenAuto/COMP1007@oj/w03.yml'
        self.assertEqual(expected, hoa.build_source_ref(self.link, 'oj/w03.yml'))
        self.assertEqual(expected, hoa.resolve_source_ref({}, self.link, '/tmp/oj/w03.yml'))
        self.assertEqual('hoa:explicit', hoa.resolve_source_ref({'source_ref': 'hoa:explicit'}, self.link, 'oj/w03.yml'))
        with self.assertRaises(ValueError):
            hoa.build_source_ref(self.link, 'oj/' + 'a' * 250 + '.yml')

    def test_corpus_approval_note_never_claims_approval(self):
        note = hoa.corpus_approval_note()
        self.assertTrue('L3 不可用' in note or '不代替审批' in note)


if __name__ == '__main__':
    unittest.main()
