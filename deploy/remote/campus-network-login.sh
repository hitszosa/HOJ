#!/usr/bin/env bash
# Run interactively on the server as its ordinary SSH user.
set -eu

auth_tool=/opt/hoj-campus-auth/hitsz-srun-login
server_ip=10.249.12.21

if [ ! -t 0 ] || [ ! -t 1 ]; then
    echo '请在交互终端中运行此命令。' >&2
    exit 2
fi
if [ ! -x "$auth_tool" ]; then
    echo '服务器校园网认证工具尚未安装。' >&2
    exit 2
fi

echo "为服务器 $server_ip 进行校园网认证。"
echo '使用学校统一身份账号（学号/工号）及其密码。'
echo '所有输入均不回显；需要验证码时按提示选择并输入。'
echo '本次不保存登录会话、不登记可信 MFA 设备。'
echo 'Ctrl+C 可以取消。'

old_tty=$(stty -g)
restore_tty() { stty "$old_tty" 2>/dev/null || true; }
trap restore_tty EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP
stty -echo
set +e
"$auth_tool" login -bind "$server_ip" -no-session -no-remember-sso -no-remember-mfa
auth_exit=$?
set -e
restore_tty
printf '\n'
if [ "$auth_exit" -ne 0 ]; then
    echo "统一身份认证未完成（退出码 $auth_exit）。" >&2
    exit "$auth_exit"
fi

# The upstream client can exit zero even when the network login fails.
# Verify the actual server address and HTTPS egress instead of trusting that exit code.
python3 - "$server_ip" <<'PY'
import json
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

server_ip = sys.argv[1]
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
callback = 'hojStatus'
url = 'https://net.hitsz.edu.cn/cgi-bin/rad_user_info?' + urllib.parse.urlencode({
    'ip': server_ip, 'callback': callback,
})
try:
    with opener.open(url, timeout=8) as response:
        text = response.read(65536).decode()
    # Without a callback the gateway may return legacy CSV when online.
    # Request JSONP explicitly and parse its named envelope without executing it.
    envelope = re.fullmatch(r'\s*' + re.escape(callback) + r'\((.*)\);?\s*', text, re.DOTALL)
    payload = envelope.group(1) if envelope else text
    if payload.strip() == 'not_online_error':
        print('校园网状态：服务器尚未认证在线。', file=sys.stderr)
        sys.exit(1)
    try:
        status = json.loads(payload)
    except json.JSONDecodeError:
        print('校园网状态响应格式无法识别，不能据此判断服务器离线；请告知 Codex 复查。', file=sys.stderr)
        sys.exit(1)
    if not isinstance(status, dict) or status.get('error') != 'ok' or status.get('online_ip') != server_ip:
        print('校园网状态：尚未确认服务器 IP 在线。', file=sys.stderr)
        sys.exit(1)
    print('已确认服务器 IP 在线：' + server_ip)
    try:
        with opener.open('https://api.deepseek.com/models', timeout=8) as response:
            http_status = response.status
    except urllib.error.HTTPError as error:
        http_status = error.code
    if http_status not in (200, 401):
        print('DeepSeek HTTPS 返回 HTTP ' + str(http_status) + '，需要进一步复查。', file=sys.stderr)
        sys.exit(1)
    print('DeepSeek HTTPS 已可达。请通知 Codex 补验真实模型出题和学习建议。')
except (OSError, urllib.error.URLError) as error:
    print('联网检查失败：' + type(error).__name__ + '；请将这个结果告知 Codex。', file=sys.stderr)
    sys.exit(1)
PY
