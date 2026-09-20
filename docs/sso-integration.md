# 哈尔滨工业大学（深圳）统一身份认证 (SSO) 对接规范

## 1. 架构与认证流概述

平台支持双轨认证模型：
1. **学校统一身份认证模式（生产环境推荐）**：通过学校 CAS、OAuth2 / OIDC、SAML 2.0 或统一身份网关认证，由前端反向代理（如 Nginx / OpenResty / API Gateway）完成身份校验后，透传受信身份头（`X-Remote-User`）给后端教学服务。后端直接识别并免密建立受信会话，根据任课关系与选课名单实现严格权限隔离。
2. **演示与本地开发模式（Demo / Testing）**：支持一键切换预置的哈工大（深圳）各核心课程任课教师、多年级学生账号，以及自定义输入账号，方便功能演示、答辩与离线测试。

```
                       [ 浏览器 / 用户端 ]
                               │
            ┌──────────────────┴──────────────────┐
            │                                     │
      (生产 SSO 访问)                         (本地演示登录)
            │                                     │
            ▼                                     ▼
    [ 学校 CAS / OAuth2 网关 ]             [ /api/session (Demo) ]
            │ (认证通过后透传请求)                   │ (生成安全测试 Cookie)
            ▼                                     ▼
    [ Nginx 反向代理层 ]                   [ Course Service ]
       - 注入 X-Remote-User                  - 校验 is_allowed_dev_user
       - 注入 X-Remote-Role                  - 隔离课程与班级数据
            │                                     │
            └──────────────────┬──────────────────┘
                               ▼
                    [ 数据库 / 权限闸门 ]
         - 教师端：严格隔离，仅可见所任教的课程与教学班
         - 学生端：严格隔离，仅可见所选修课程的公开作业
         - 管理员：可统览全局全部课程与班级
```

---

## 2. 反向代理请求头协议

当网关或 Nginx 代理上游请求到 `course-service` 时，需透传以下头部信息：

| 标头字段 (Header) | 说明 | 示例值 | 必需 |
| :--- | :--- | :--- | :--- |
| `X-Remote-User` | 用户唯一标识（工号 / 学号 / 统一账号） | `teacher_wang` / `2401001` | **是** |
| `X-Remote-Role` | 身份类别（可选，由网关或平台映射确定） | `teacher` / `student` | 否 |
| `X-Remote-Name` | 用户真实姓名（可选，首次登录自动建档） | `王焦乐` / `张三` | 否 |
| `X-Remote-Email`| 用户学校邮箱（可选） | `wang@hitsz.edu.cn` | 否 |

> **安全红线**：
> 在生产环境中，Nginx 必须在对外入口处**显式清空**客户端自带的 `X-Remote-User`，仅允许网关认证成功后由 `auth_request` 或内网代理注入，防止外部客户端伪造请求头。

---

## 3. Nginx 标准配置范例

### 方案 A：对接 CAS / SAML 反向代理网关 (`auth_request` 模式)

```nginx
# /etc/nginx/conf.d/codemind_course.conf

server {
    listen 80;
    server_name oj.hitsz.edu.cn;

    # 1. 静态前端资源托管与 Next.js 代理
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }

    # 2. 课程平台后端 API 入口（SSO 鉴权保护）
    location /api/ {
        # 强制清除外部可能伪造的头
        proxy_set_header X-Remote-User "";
        proxy_set_header X-Remote-Role "";

        # 调用内部 SSO 认证子请求
        auth_request /_sso_auth;
        auth_request_set $sso_user $upstream_http_x_remote_user;
        auth_request_set $sso_role $upstream_http_x_remote_role;

        # 认证通过后将受信身份注入并转发给教学服务
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header X-Remote-User $sso_user;
        proxy_set_header X-Remote-Role $sso_role;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }

    # 3. 学校统一身份认证鉴权端点 (例如配合 pam-cas / mod_auth_cas / OAuth2 Proxy)
    location = /_sso_auth {
        internal;
        proxy_pass http://127.0.0.1:4180/validate;
        proxy_pass_request_body off;
        proxy_set_header Content-Length "";
        proxy_set_header X-Original-URI $request_uri;
    }

    # 认证失败时引导跳转到学校 CAS 登录页面
    error_page 401 = @error401;
    location @error401 {
        return 302 https://sso.hitsz.edu.cn/cas/login?service=https://$host$request_uri;
    }
}
```

---

## 4. 环境变量配置

在 `course-service` 启动环境或 `.env` 中配置：

```bash
# 是否开启生产 SSO 请求头识别（缺省为 X-Remote-User）
COURSE_SSO_HEADER=X-Remote-User

# 是否开启开发/演示登录（生产环境建议设为 0，仅由 SSO 控制；演示测试环境设为 1）
COURSE_DEV_LOGIN=1

# 允许的跨域来源
COURSE_ALLOWED_ORIGINS=http://localhost:3000,http://127.0.0.1:3000,https://oj.hitsz.edu.cn
```

---

## 5. 教师专属授课权限隔离逻辑

平台在核心接口 `GET /api/courses` 中实现行级权限隔离：

1. **普通任课教师**：
   - 只能查看到在 `cm_offering.teacher_id` 中指定为其工号的课程及教学班；
   - 绝不能越权查看或编辑其他教师的课程、班级学生或作业草稿；
2. **学生账号**：
   - 只能查看到在 `cm_enrollment` 中处于激活（`active`）状态的选课班级；
3. **系统管理员 (`admin`)**：
   - 可全局查看全校所有学院开设的课程与全部教学班，便于统筹运维与选课监控。

---

## 6. 账号体系与动态排课解耦说明

平台不在代码中固化任何教师真实姓名，授课关系完全由教学数据库 `cm_offering.teacher_id`（教工号 / 用户账号）动态维护：

1. **教工号身份绑定**：
   学校统一身份认证传递的教工号（如 `T2024001` 或 `teacher_01`）与 `cm_offering.teacher_id` 进行关联。
2. **排课轮换完全解耦**：
   每学期任课教师轮换调整时，仅需在平台或教务数据中更新教学班（`cm_offering`）的 `teacher_id`，系统接口与权限即刻动态跟随生效，代码与前端无任何硬编码耦合。
3. **测试环境动态发现**：
   测试登录面板中的教师账号通过 `GET /api/demo/users` 从数据库实时查询当前活跃排课数据生成，支持任意教工号/学号免密测试。
