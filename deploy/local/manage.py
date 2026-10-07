#!/usr/bin/env python3
"""Start/stop this checkout's local services without a terminal dependency."""
from pathlib import Path
import json
import os
import shutil
import signal
import subprocess
import sys
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
RUN = ROOT / '.local'
RUN.mkdir(exist_ok=True)
COMPOSE = ['docker', 'compose', '-f', str(ROOT / 'deploy/local/compose.yml')]
PIDS = RUN / 'pids.json'
HTTP = urllib.request.build_opener(urllib.request.ProxyHandler({}))

def run(command, cwd=ROOT, **kwargs):
    subprocess.run(command, cwd=cwd, check=True, **kwargs)

def alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False

def stop_services():
    if not PIDS.exists():
        return
    for name, pid in json.loads(PIDS.read_text()).items():
        # Never stop an unrelated process if the OS has reused a saved PID.
        cmd = subprocess.run(['ps', '-p', str(pid), '-o', 'command='], capture_output=True, text=True).stdout
        expected = str(ROOT / ('backend/target/debug/hoj' if name == 'api' else 'frontend/node_modules/next/dist/bin/next'))
        cwd = subprocess.run(['lsof', '-a', '-p', str(pid), '-d', 'cwd', '-Fn'], capture_output=True, text=True).stdout
        next_owned = name == 'web' and cmd.strip().startswith('next-server ') and f'n{ROOT / "frontend"}\n' in cwd
        if expected in cmd or next_owned:
            os.kill(pid, signal.SIGTERM)
    PIDS.unlink(missing_ok=True)

def ready(url):
    try:
        with HTTP.open(url, timeout=2) as response:
            return response.status == 200
    except Exception:
        return False

action = sys.argv[1] if len(sys.argv) > 1 else 'status'
if action == 'stop':
    run([sys.executable, str(ROOT / 'deploy/local/management.py'), 'stop'])
    stop_services()
    run(COMPOSE + ['stop'])
elif action == 'status':
    run([sys.executable, str(ROOT / 'deploy/local/management.py'), 'status'])
    run(COMPOSE + ['ps'])
    for name, url in [('API', 'http://127.0.0.1:8100/api/health'), ('Web', 'http://127.0.0.1:3100')]:
        print(f'{name}: {"ready" if ready(url) else "stopped"} — {url}')
elif action == 'start':
    if ready('http://127.0.0.1:8100/api/health') and ready('http://127.0.0.1:3100/teacher'):
        run([sys.executable, str(ROOT / 'deploy/local/management.py'), 'start'])
        print('Already running: http://127.0.0.1:3100')
        sys.exit(0)
    stop_services()
    if subprocess.run(['docker', 'info'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode:
        run(['colima', 'start'])
    run(COMPOSE + ['up', '-d', '--wait'])
    run([sys.executable, str(ROOT / 'deploy/local/init.py')])
    executable = ROOT / 'backend/target/debug/hoj'
    if not executable.exists():
        cargo = shutil.which('cargo') or str(Path.home() / '.cargo/bin/cargo')
        run([cargo, 'build', '--locked'], cwd=ROOT / 'backend', env={**os.environ, 'SQLX_OFFLINE': 'true'})
    if not (ROOT / 'frontend/.next/BUILD_ID').exists():
        run(['npm', 'ci', '--no-audit', '--no-fund'], cwd=ROOT / 'frontend')
        run(['npm', 'run', 'build'], cwd=ROOT / 'frontend')
    pids = {}
    for name, cwd, command in [
        ('api', ROOT / 'backend', [str(executable)]),
        ('web', ROOT / 'frontend', [shutil.which('node'), str(ROOT / 'frontend/node_modules/next/dist/bin/next'), 'start', '--hostname', '127.0.0.1', '-p', '3100']),
    ]:
        with (RUN / f'{name}.log').open('ab') as log:
            process = subprocess.Popen(command, cwd=cwd, stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
        pids[name] = process.pid
        PIDS.write_text(json.dumps(pids))
    for _ in range(60):
        if ready('http://127.0.0.1:8100/api/health') and ready('http://127.0.0.1:3100/teacher'):
            run([sys.executable, str(ROOT / 'deploy/local/management.py'), 'start'])
            print('Ready: http://127.0.0.1:3100 — logs: .local/api.log and .local/web.log')
            break
        if not all(alive(pid) for pid in pids.values()):
            raise SystemExit('Service exited; inspect .local/api.log and .local/web.log')
        time.sleep(1)
    else:
        raise SystemExit('Startup timed out; inspect .local/api.log and .local/web.log')
else:
    raise SystemExit('Usage: python3 deploy/local/manage.py start|stop|status')
