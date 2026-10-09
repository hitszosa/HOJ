#!/usr/bin/env python3
"""Quiesce writers, export a recoverable backup, then resume the same containers."""
import argparse
from datetime import datetime
import fcntl
import gzip
import hashlib
import json
import os
from pathlib import Path
import pwd
import shutil
import subprocess
import tarfile
import time

ROOT = Path(__file__).resolve().parents[2]
SERVICES = ('web', 'api', 'management-api', 'core', 'storage', 'management-web')


def run(*args, **kwargs):
    p = subprocess.run(args, capture_output=True, **kwargs)
    if p.returncode:
        # DB and compose errors may contain secrets; keep them out of the journal.
        raise RuntimeError('Backup command failed: ' + args[0])
    return p.stdout


def query(sql):
    return run('docker', 'exec', '-i', 'hoj-db-1', 'sh', '-c',
               'MYSQL_PWD="$MARIADB_ROOT_PASSWORD" mariadb -uroot -N -B --raw',
               input=sql.encode()).decode().strip()


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b''):
            h.update(chunk)
    return {'bytes': path.stat().st_size, 'sha256': h.hexdigest()}


def prune(parent, keep):
    # Only this tool's complete backup sets are eligible for retention.
    complete = sorted(p for p in parent.iterdir() if p.is_dir()
                      and len(p.name) == 22 and (p / 'manifest.json').is_file())
    for p in complete[:-keep]:
        shutil.rmtree(p)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--already-quiesced', action='store_true')
    parser.add_argument('--export-user', default='lhy')
    parser.add_argument('--keep', type=int, default=14)
    args = parser.parse_args()
    if args.keep < 2:
        raise SystemExit('Keep at least two backup sets')
    os.umask(0o077)
    parent = ROOT / 'backups/sets'
    parent.mkdir(parents=True, exist_ok=True)
    with (ROOT / 'backups/.backup.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        names = ['hoj-' + s + '-1' for s in SERVICES]
        state = json.loads(run('docker', 'inspect', *names))
        running = [c['Name'].lstrip('/') for c in state if c['State']['Running']]
        if args.already_quiesced and running:
            raise SystemExit('Writers must be stopped before --already-quiesced')
        stamp = datetime.now().strftime('%Y%m%d-%H%M%S-%f')
        temporary = parent / ('.partial-' + stamp)
        temporary.mkdir(mode=0o700)
        stopped = []
        try:
            if not args.already_quiesced:
                if 'hoj-web-1' in running:
                    stopped.append('hoj-web-1')
                    run('docker', 'stop', '--time', '30', 'hoj-web-1')
                deadline = time.monotonic() + 120
                while int(query('SELECT COUNT(*) FROM jol.solution WHERE result < 4;')):
                    if time.monotonic() >= deadline:
                        raise RuntimeError('Judge queue did not drain; backup cancelled')
                    time.sleep(1)
                other = [n for n in running if n != 'hoj-web-1']
                stopped.extend(other)
                if other:
                    run('docker', 'stop', '--time', '30', *other)
            if int(query('SELECT COUNT(*) FROM jol.solution WHERE result < 4;')):
                raise RuntimeError('Unfinished judging prevents a consistent backup')
            dump = subprocess.Popen(['docker', 'exec', 'hoj-db-1', 'sh', '-c',
                'MYSQL_PWD="$MARIADB_ROOT_PASSWORD" mariadb-dump -uroot --lock-all-tables '
                '--routines --events --triggers --databases jol codemind_course grader'],
                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
            with gzip.open(temporary / 'databases.sql.gz', 'wb') as out:
                shutil.copyfileobj(dump.stdout, out)
            dump.stdout.close()
            if dump.wait():
                raise RuntimeError('Database dump failed')
            grants = []
            accounts = query("SELECT CONCAT(QUOTE(User),'@',QUOTE(Host)) FROM mysql.user "
                             "WHERE User IN ('jol','codemind','codemind_ops','grader');").splitlines()
            for account in accounts:
                create = query('SHOW CREATE USER ' + account + ';').split('\t')[-1]
                grants.append(create + ';')
                grants.extend(s + ';' for s in query('SHOW GRANTS FOR ' + account + ';').splitlines())
            (temporary / 'application-grants.sql').write_text('\n'.join(grants) + '\n')
            with tarfile.open(temporary / 'files.tar.gz', 'w:gz') as tar:
                for name in ('.env', 'admin-account.json', 'data/judge', 'data/course-local',
                             'data/objects', 'active-release.json', 'active-deployment.json'):
                    if (ROOT / name).exists():
                        tar.add(ROOT / name, arcname=name, recursive=True)
            run('git', '-C', str(ROOT), 'bundle', 'create', str(temporary / 'source.bundle'), '--all')
            run('git', '-C', str(ROOT), 'bundle', 'verify', str(temporary / 'source.bundle'))
            report = {'stamp': stamp, 'kind': 'write-quiesced',
                      'source_revision': run('git', '-C', str(ROOT), 'rev-parse', 'HEAD').decode().strip(),
                      'schemas': ['jol', 'grader', 'codemind_course'],
                      'files': {p.name: digest(p) for p in temporary.iterdir()}}
            (temporary / 'manifest.json').write_text(json.dumps(report, indent=2) + '\n')
            for p in temporary.iterdir():
                p.chmod(0o600)
            final = parent / stamp
            temporary.rename(final)
            account = pwd.getpwnam(args.export_user)
            export = Path(account.pw_dir) / '.hoj-backups'
            export.mkdir(mode=0o700, exist_ok=True)
            os.chown(export, account.pw_uid, account.pw_gid)
            export.chmod(0o700)
            stage = export / ('.partial-' + stamp)
            shutil.copytree(final, stage)
            os.chown(stage, account.pw_uid, account.pw_gid)
            for p in stage.iterdir():
                os.chown(p, account.pw_uid, account.pw_gid)
            stage.rename(export / stamp)
            prune(parent, args.keep)
            prune(export, args.keep)
            print('Backup completed:', stamp, flush=True)
        finally:
            # Resume only containers which were running when this operation began.
            if stopped:
                ordered = [n for n in reversed(names) if n in stopped]
                run('docker', 'start', *ordered)
            if temporary.exists():
                shutil.rmtree(temporary)


if __name__ == '__main__':
    main()
