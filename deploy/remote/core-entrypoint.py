import os
import pathlib
import re
import signal
import subprocess
import time

home = pathlib.Path('/home/judge')
password = os.environ['JUDGE_DB_PASSWORD']
if not re.fullmatch(r'[a-f0-9]{48}', password):
    raise SystemExit('JUDGE_DB_PASSWORD must be a generated 48-character hex secret')
config = home / 'src/web/include/db_info.inc.php'
# Always render from the image's pristine configuration. The DB host contains
# a semicolon (PDO port syntax), so re-editing rendered PHP is unsafe.
template = config.with_suffix(config.suffix + '.template')
if not template.exists():
    template.write_text(config.read_text())
text = template.read_text()
for key, value in {'DB_HOST': '127.0.0.1;port=13306', 'DB_NAME': 'jol', 'DB_USER': 'jol',
                   'DB_PASS': password, 'DB_RO_USER': 'jol', 'DB_RO_PASS': password}.items():
    text, count = re.subn(r'(static\s+\$' + key + r'\s*=\s*)(?:"[^"\n]*"|\x27[^\x27\n]*\x27|[^;\n]+);',
                         lambda m: m[1] + '"' + value + '";', text, count=1)
    if not count:
        raise SystemExit('Missing native database setting ' + key)
config.write_text(text)
subprocess.run(['php', '-l', str(config)], check=True)
(home / 'etc/judge.conf').write_text(f'''OJ_HOST_NAME=127.0.0.1
OJ_USER_NAME=jol
OJ_PASSWORD={password}
OJ_DB_NAME=jol
OJ_PORT_NUMBER=13306
OJ_RUNNING=6
OJ_SLEEP_TIME=1
OJ_TOTAL=1
OJ_MOD=0
OJ_LANG_SET=0,1,6
OJ_COMPILE_CHROOT=1
OJ_USE_PTRACE=1
OJ_SHM_RUN=0
OJ_USE_DOCKER=0
OJ_INTERNAL_CLIENT=1
OJ_SIM_ENABLE=0
OJ_OI_MODE=1
OJ_HTTP_JUDGE=0
OJ_CPU_COMPENSATION=1.0
OJ_TIME_LIMIT_TO_TOTAL=1
''')
os.chmod(home / 'etc/judge.conf', 0o600)
for i in range(6):
    (home / f'run{i}').mkdir(exist_ok=True)
subprocess.run(['php-fpm8.1', '-t'], check=True)
subprocess.run(['nginx', '-t'], check=True)
children = [subprocess.Popen(['php-fpm8.1', '-F']),
            subprocess.Popen(['nginx', '-g', 'daemon off;'])]
# judged daemonizes; it is monitored together with PHP and nginx below.
subprocess.run(['judged', str(home)], check=True)
def stop(*_):
    subprocess.run(['pkill', '-TERM', '-x', 'judged'], check=False)
    for child in children:
        child.terminate()
    raise SystemExit(0)
signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
while all(c.poll() is None for c in children):
    time.sleep(3)
    if subprocess.run(['pgrep', '-x', 'judged'], stdout=subprocess.DEVNULL).returncode:
        raise SystemExit('judged stopped')
raise SystemExit('PHP or nginx stopped')
