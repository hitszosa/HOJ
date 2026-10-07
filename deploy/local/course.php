<?php
// Bridge for the local HUSTOJ image: identity comes only from its PHP session.
require_once __DIR__ . '/include/db_info.inc.php';
if (($_GET['mode'] ?? '') !== 'session') {
    header('Location: http://127.0.0.1:3100/', true, 302);
    exit;
}
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
$user = $_SESSION[$OJ_NAME . '_user_id'] ?? null;
if (!is_string($user) || $user === '') {
    http_response_code(401);
    echo json_encode(['error' => '请先登录 HUSTOJ']);
    exit;
}
$rows = pdo_query("SELECT user_id FROM users WHERE user_id=? AND defunct='N' AND expiry_date >= CURDATE()", $user);
if (!$rows) {
    http_response_code(401);
    echo json_encode(['error' => '账号不存在或已停用']);
    exit;
}
echo json_encode(['authSource' => 'hustoj', 'user' => $user], JSON_UNESCAPED_UNICODE);
