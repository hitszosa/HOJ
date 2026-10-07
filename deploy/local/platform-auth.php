<?php
// JSON-only account adapter. The teaching service calls this; no legacy templates are rendered.
ini_set('session.use_strict_mode', '1');
session_set_cookie_params(['path' => '/', 'httponly' => true, 'samesite' => 'Lax']);
require_once('./include/db_info.inc.php');
require_once('./include/my_func.inc.php');
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
function reply($status, $body) {
    http_response_code($status);
    echo json_encode($body, JSON_UNESCAPED_UNICODE);
    exit;
}
if ($_SERVER['REQUEST_METHOD'] !== 'POST') reply(405, ['error' => '请求方法不支持']);
$origin = $_SERVER['HTTP_ORIGIN'] ?? '';
$allowed_origins = array_map('trim', explode(',', getenv('HOJ_ALLOWED_ORIGINS') ?: 'http://127.0.0.1:3100,http://localhost:3100'));
if (!in_array($origin, $allowed_origins, true)) {
    reply(403, ['error' => '跨站请求被拒绝']);
}
if (($_GET['mode'] ?? '') === 'logout') {
    $_SESSION = [];
    session_destroy();
    setcookie(session_name(), '', ['expires' => 1, 'path' => '/', 'httponly' => true, 'samesite' => 'Lax']);
    reply(200, ['user' => '']);
}
if (($_GET['mode'] ?? '') === 'provision') {
    $actor = $_SESSION[$OJ_NAME . '_user_id'] ?? '';
    $rights = pdo_query("SELECT rightstr FROM privilege WHERE user_id=? AND rightstr IN ('teacher','administrator')", $actor);
    $is_admin = count(array_filter($rights, fn($r) => $r['rightstr'] === 'administrator')) > 0;
    if (!$rights) reply(403, ['error' => '仅教师或管理员可创建账号']);
    $input = json_decode(file_get_contents('php://input', false, null, 0, 16385), true);
    $username = $input['username'] ?? '';
    $name = $input['real_name'] ?? '';
    $role = $input['role'] ?? -1;
    if (!is_string($username) || !preg_match('/^[A-Za-z0-9_.-]{1,48}$/D', $username)
        || !is_string($name) || mb_strlen($name) < 1 || mb_strlen($name) > 100
        || !in_array($role, [0, 1], true)) reply(400, ['error' => '账号、姓名或角色不合法']);
    if ($role === 1 && !$is_admin) reply(403, ['error' => '教师只能创建学生账号']);
    $existing = pdo_query('SELECT user_id,defunct FROM users WHERE user_id=?', $username);
    if ($existing) {
        $staff = pdo_query("SELECT rightstr FROM privilege WHERE user_id=? AND rightstr IN ('teacher','administrator')", $username);
        if ($existing[0]['defunct'] !== 'N' || ($role === 0 && $staff) || ($role === 1 && !$staff))
            reply(409, ['error' => '已有账号的状态或角色不同，不能覆盖']);
        reply(200, ['user' => $username]);
    }
    pdo_query("INSERT INTO users(user_id,nick,password,reg_time,accesstime,expiry_date,defunct) VALUES(?,?,?,NOW(),NOW(),'2099-01-01','N')", $username, $name, pwGen($username));
    if ($role === 1) pdo_query("INSERT INTO privilege(user_id,rightstr) VALUES(?,'teacher')", $username);
    reply(201, ['user' => $username]);
}
if (($_GET['mode'] ?? '') === 'password') {
    $actor = $_SESSION[$OJ_NAME . '_user_id'] ?? '';
    if (!$actor) reply(401, ['error' => '请先登录']);
    $input = json_decode(file_get_contents('php://input', false, null, 0, 16385), true);
    $old = $input['old_password'] ?? null;
    $new = $input['new_password'] ?? null;
    if (!is_string($old) || strlen($old) < 1 || strlen($old) > 1024
        || !is_string($new) || mb_strlen($new) < 8 || strlen($new) > 1024 || $old === $new) {
        reply(400, ['error' => '新密码至少需要 8 个字符，且不能与旧密码相同']);
    }
    // Do not use check_login here: it destroys the caller's existing session.
    $rows = pdo_query("SELECT password FROM users WHERE user_id=? AND defunct='N' AND expiry_date>=CURDATE()", $actor);
    if (!$rows || !pwCheck(md5($old), $rows[0]['password'])) reply(401, ['error' => '旧的密码有误']);
    $hash = pwGen($new);
    pdo_query('UPDATE users SET password=? WHERE user_id=? AND password=?', $hash, $actor, $rows[0]['password']);
    $current = pdo_query('SELECT password FROM users WHERE user_id=?', $actor);
    if (!$current || !hash_equals($hash, $current[0]['password'])) reply(409, ['error' => '密码已被修改，请重新登录']);
    // Revoke the other native sessions. The caller remains signed in until the
    // frontend completes logout; its management sessions are revoked separately.
    $pattern = '/_user_id\|s:\d+:"' . preg_quote($actor, '/') . '";/';
    foreach (glob('/var/lib/php/sessions/sess_*') ?: [] as $file) {
        if (basename($file) === 'sess_' . session_id()) continue;
        $contents = @file_get_contents($file);
        if ($contents !== false && preg_match($pattern, $contents)) @unlink($file);
    }
    reply(200, ['user' => $actor]);
}
if (($_GET['mode'] ?? '') !== 'login') reply(404, ['error' => '接口不存在']);
$input = json_decode(file_get_contents('php://input', false, null, 0, 16385), true);
$username = $input['username'] ?? null;
$password = $input['password'] ?? null;
if (!is_string($username) || !preg_match('/^[A-Za-z0-9_.-]{1,64}$/D', $username)
    || !is_string($password) || strlen($password) < 1 || strlen($password) > 1024) {
    reply(400, ['error' => '请输入有效的账号和密码']);
}
$ip = $_SERVER['REMOTE_ADDR'];
$since = date('Y-m-d H:i:s', time() - 300);
$failed = pdo_query("SELECT COUNT(*) AS n FROM loginlog WHERE user_id=? AND password='login fail' AND time>=?", $username, $since);
$limit = isset($OJ_LOGIN_FAIL_LIMIT) && $OJ_LOGIN_FAIL_LIMIT > 0 ? $OJ_LOGIN_FAIL_LIMIT : 10;
if ($failed[0]['n'] >= $limit) reply(429, ['error' => '登录尝试过多，请稍后重试']);
require_once('./include/login-hustoj.php');
$login = check_login($username, md5($password));
pdo_query('INSERT INTO loginlog(user_id,password,ip,time) VALUES(?,?,?,NOW())', $username, $login ? 'login ok' : 'login fail', $ip);
if (!$login) reply(401, ['error' => '账号或密码错误']);
session_regenerate_id(true);
$_SESSION = [];
$_SESSION[$OJ_NAME . '_user_id'] = $login;
$profile = pdo_query('SELECT nick,group_name FROM users WHERE user_id=?', $login)[0];
$_SESSION[$OJ_NAME . '_nick'] = $profile['nick'];
$_SESSION[$OJ_NAME . '_group_name'] = $profile['group_name'];
$rights = pdo_query('SELECT rightstr,valuestr FROM privilege WHERE user_id=?', $login);
foreach ($rights as $right) $_SESSION[$OJ_NAME . '_' . $right['rightstr']] = $right['valuestr'] ?? true;
reply(200, ['user' => $login]);
