#!/usr/bin/env python3
"""Lifecycle for this checkout's local teacher management and its private dependencies."""
from pathlib import Path
import json
import os
import secrets
import shutil
import signal
import subprocess
import sys
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
RUN = ROOT / '.local'
RUN.mkdir(exist_ok=True)
PIDS = RUN / 'management-pids.json'
COMPOSE = ['docker', 'compose', '--env-file', str(ROOT / 'deploy/local/management.env'), '-f', str(ROOT / 'deploy/local/management-compose.yml')]
HTTP = urllib.request.build_opener(urllib.request.ProxyHandler({}))
BACKEND = ROOT / 'teacher-management/backend'
FRONTEND = ROOT / 'teacher-management/frontend'
LOCAL_ENV = {**os.environ, 'NO_PROXY': '127.0.0.1,localhost,::1', 'no_proxy': '127.0.0.1,localhost,::1'}


def run(command, cwd=ROOT, **kwargs):
    kwargs.setdefault('env', LOCAL_ENV)
    subprocess.run(command, cwd=cwd, check=True, **kwargs)


def ready(url):
    try:
        with HTTP.open(url, timeout=3) as response:
            return response.status == 200
    except Exception:
        return False


def configure():
    secret_file = RUN / 'management-secrets.json'
    if not secret_file.exists():
        secret_file.write_text(json.dumps({k: secrets.token_hex(24) for k in ['db', 's3', 'admin']} | {'session': secrets.token_hex(32)}))
        secret_file.chmod(0o600)
    secrets_local = json.loads(secret_file.read_text())
    compose_env = ROOT / 'deploy/local/management.env'
    compose_env.write_text(f"MANAGEMENT_DB_PASSWORD={secrets_local['db']}\nMINIO_ROOT_PASSWORD={secrets_local['s3']}\n")
    compose_env.chmod(0o600)
    env = BACKEND / '.env'
    if not env.exists():
        env.write_text(f"""DATABASE_URL=mysql://grader:{secrets_local['db']}@127.0.0.1:13307/grader
BIND=127.0.0.1:8101
SESSION_SECRET_KEY={secrets_local['session']}
COOKIE_SECURE=false
AWS_ACCESS_KEY_ID=hoj-local-storage
AWS_SECRET_ACCESS_KEY={secrets_local['s3']}
AWS_REGION=us-east-1
S3_PUBLIC_URL=http://127.0.0.1:9002
S3_INTERNAL_URL=http://127.0.0.1:9002
S3_BUCKET_NAME=grader-uploads
UPLOAD_TTL_SECONDS=3600
HOJ_API_URL=http://127.0.0.1:8100
DATABASE_MAX_CONNECTIONS=10
GRADER_ADMIN_PASSWORD={secrets_local['admin']}
CORS_ORIGINS=http://127.0.0.1:3100,http://localhost:3100,http://127.0.0.1:3101
RUST_LOG=info
""")
        env.chmod(0o600)
    # Existing local installations also need the trusted platform origins for
    # authenticated account/course writes across the two teaching services.
    config = env.read_text()
    if not any(line.startswith('CORS_ORIGINS=') for line in config.splitlines()):
        env.write_text(config + '\nCORS_ORIGINS=http://127.0.0.1:3100,http://localhost:3100,http://127.0.0.1:3101\n')


def stop():
    if not PIDS.exists():
        return
    for name, pid in json.loads(PIDS.read_text()).items():
        cmd = subprocess.run(['ps', '-p', str(pid), '-o', 'command='], capture_output=True, text=True).stdout
        expected = str(BACKEND / 'target/debug/grader-backend') if name == 'api' else str(FRONTEND / 'node_modules/vite/bin/vite.js')
        if expected in cmd:
            os.kill(pid, signal.SIGTERM)
    PIDS.unlink(missing_ok=True)


def start():
    configure()
    if ready('http://127.0.0.1:8101/healthz') and ready('http://127.0.0.1:3101/management/'):
        run(COMPOSE + ['up', '-d', '--remove-orphans', '--wait'])
        run([str(BACKEND / 'target/debug/grader-backend'), 'init-storage'], cwd=BACKEND)
        print('Teacher management already running: http://127.0.0.1:3100/management/home')
        return
    stop()
    run(COMPOSE + ['up', '-d', '--build', '--remove-orphans', '--wait'])
    cargo = shutil.which('cargo') or str(Path.home() / '.cargo/bin/cargo')
    run([cargo, 'build', '--locked', '-j', '3'], cwd=BACKEND)
    executable = str(BACKEND / 'target/debug/grader-backend')
    run([executable, 'migrate'], cwd=BACKEND)
    for url in ['http://127.0.0.1:9002/minio/health/live']:
        for _ in range(90):
            if ready(url):
                break
            time.sleep(1)
        else:
            raise SystemExit(f'Dependency not ready: {url}')
    run([executable, 'init-storage'], cwd=BACKEND)
    # A separate local administrator is available for API probes and Grader-created accounts.
    # Do not reset an existing account on subsequent starts.
    marker = RUN / 'management-admin-created'
    if not marker.exists():
        run([executable, 'create-admin', '--username', 'local_admin', '--real-name', '本地管理验证账号'], cwd=BACKEND)
        marker.touch()
    local_frontend_env = FRONTEND / '.env.local'
    if not local_frontend_env.exists():
        local_frontend_env.write_text('VITE_MINIO_CONSOLE_URL=http://127.0.0.1:9003\n')
    if not (FRONTEND / 'node_modules').exists():
        run(['corepack', 'pnpm@11.28.3', 'install', '--frozen-lockfile'], cwd=FRONTEND)
    if not (FRONTEND / 'dist/index.html').exists():
        run(['corepack', 'pnpm@11.28.3', 'build'], cwd=FRONTEND)
    pids = {}
    for name, cwd, command in [
        ('api', BACKEND, [executable, 'serve']),
        ('web', FRONTEND, [shutil.which('node'), str(FRONTEND / 'node_modules/vite/bin/vite.js'), 'preview', '--host', '127.0.0.1', '--port', '3101', '--strictPort']),
    ]:
        with (RUN / f'management-{name}.log').open('ab') as log:
            process = subprocess.Popen(command, cwd=cwd, stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True, env=LOCAL_ENV)
        pids[name] = process.pid
        PIDS.write_text(json.dumps(pids))
    for _ in range(60):
        if ready('http://127.0.0.1:8101/healthz') and ready('http://127.0.0.1:3101/management/'):
            print('Teacher management ready: http://127.0.0.1:3100/management/home')
            return
        if any(subprocess.run(['kill', '-0', str(pid)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode for pid in pids.values()):
            raise SystemExit('Teacher management exited; inspect .local/management-*.log')
        time.sleep(1)
    raise SystemExit('Teacher management startup timed out')


if __name__ == '__main__':
    action = sys.argv[1] if len(sys.argv) > 1 else 'status'
    if action == 'start':
        start()
    elif action == 'stop':
        stop()
        configure()
        run(COMPOSE + ['stop'])
    elif action == 'status':
        configure()
        run(COMPOSE + ['ps'])
        for name, url in [('Management API', 'http://127.0.0.1:8101/healthz'), ('Management web', 'http://127.0.0.1:3100/management/home')]:
            print(f'{name}: {"ready" if ready(url) else "stopped"} — {url}')
    else:
        raise SystemExit('Usage: python3 deploy/local/management.py start|stop|status')
