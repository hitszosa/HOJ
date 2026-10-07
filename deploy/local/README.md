# HOJ 本地部署与验收（Apple Silicon Mac）

工作目录：`/Users/jiaoziang/HOJ`。代码版本：`d0ac7d7`，来自 https://github.com/hitszosa/HOJ 。

## 使用

打开 http://127.0.0.1:3100/management/login ，使用正式账号 `admin` 登录。
此账号具备教师和超级管理员权限，登录后进入教学管理中心。
随机生成的密码保存在 `.local/admin-account.json`（权限 `0600`，Git 忽略）。
首次创建可运行 `python3 deploy/local/create-admin.py`；重复运行及重启服务不会重置密码。
平台内统一完成账号密码登录与退出。`8080` 仅提供内部 JSON 账号与身份适配接口，原生网页全部返回 404；`/oj/*` 旧链接跳回教学管理中心。判题与题库继续使用原有服务。
体验快捷登录已关闭，已有课程、作业与验收记录保留。

```bash
cd /Users/jiaoziang/HOJ
python3 deploy/local/manage.py status
python3 deploy/local/manage.py stop
python3 deploy/local/manage.py start
python3 deploy/local/admin-smoke.py
```

`stop` 保留数据库、题目数据和作业记录；`start` 在后台启动服务，可关闭终端。
容器名称为 `hoj-local-hustoj`；已有的 `hustoj` 容器保持停止状态。
本次部署不使用宿主机原有 MySQL 数据库。

## 服务与数据

| 服务 | 地址 / 数据 |
| --- | --- |
| 教学前端 | `127.0.0.1:3100`，Next.js 生产构建 |
| Rust API | `127.0.0.1:8100` |
| 内部账号适配接口 | `127.0.0.1:8080`，原生网页已关闭 |
| MariaDB | `127.0.0.1:13306`，独立 Docker 卷 `hoj-local_mysql` |
| 判题数据 | `.local/judge-data/`，与容器共享 |
| 数据库凭据 | `backend/.env`，随机生成密码，权限 `0600`，Git 忽略 |
| 后台进程与日志 | `.local/pids.json`、`.local/api.log`、`.local/web.log` |
| 认证签名密钥 | `backend/data/local/session.key`，Git 忽略 |
| 验收记录 | `.local/backend-test.log`、`.local/smoke.log`、`.local/verification.log`、`.local/verification.json` |

所有端口仅绑定本机回环地址。当前 `COURSE_DEV_LOGIN=0`，仅允许真实账号登录；学校 SSO 和 AI 模型未配置。
数据库服务器与 API 连接的时区均设置为 UTC+8。

## 依赖与镜像

使用本机已有的 Node.js 24、Colima、Docker，以及本次安装的 Rust 1.99 minimal 工具链。
前端使用锁文件执行 `npm ci`；后端使用 `--locked` 和 `SQLX_OFFLINE=true` 构建。
Rust 安装在 `~/.cargo/bin`，启动脚本会自动查找该路径。

此电脑原来已有 ARM64 镜像 `hustoj-dev:latest`，本地 Dockerfile 以它为基础构建
`hoj-local-hustoj:arm64`。基础镜像 ID：
`sha256:9d3670325bfd84b42170ca964757579f286f18bc9bd2262bd11c1baaec74e23d`。
它包含 MariaDB 10.6、PHP 8.1、Nginx 和 HUSTOJ 判题机。
迁移到其他电脑时，需要同时迁移该基础镜像，或者另行构建具有相同路径和入口的 HUSTOJ 镜像；
仅克隆 HOJ 仓库不包含这份基础镜像。

镜像原有 ARM64 实现将寄存器缓冲区直接传给 `PTRACE_GETREGSET`，并从 `regs[18]`
读取系统调用号，导致正确程序误判为 RE。本地 `patch-arm64.py` 修复为 `iovec + NT_PRSTATUS`
并读取 `regs[8]`，同时用 ARM64 系统调用符号配置 C/C++、Python 与 Java 的白名单。
依据为 [Linux ptrace 手册](https://man7.org/linux/man-pages/man2/ptrace.2.html)。
保留 ptrace、chroot 和资源限制；验收包含拒绝 C 程序未授权的 socket 系统调用。
`course.php` 提供原生 PHP 会话身份桥接，并核验账号有效性。

## 验收

正式账号模式：`admin-smoke.py` 验证真实密码登录、错误密码拒绝、教师与管理员权限、
两套系统的身份同步、匿名拒绝、退出及旧会话撤销、原生页面关闭、旧链接迁移和编辑器资源加载；结果保存在 `.local/clean-platform-probe.json`。
以下记录为此前体验模式的完整功能验收。旧 `smoke.py` 的原生网页登录检查已被 `admin-smoke.py` 替代；其开发身份流程不能直接用于当前正式账号环境。

- 后端：121 项库测试（包含类型导出测试）和 7 项 HTTP 测试通过。
- 前端：29 项 Vitest 测试通过，TypeScript 类型检查与 Next.js 生产构建通过。
- 教学流程：教师 / 学生门户、匿名鉴权、班级隔离、CSRF、草稿审核、发布幂等、提交权限。
- 真实判题：C、C++、Java、Python 的两数和程序 AC；WA、CE、RE、TLE 结果验证。
- 自测：输入 `12 30` 输出 `42`，重复请求限流。
- 原生身份：HUSTOJ 登录 → PHP 会话桥接 → `/api/me` 返回 `auth_source=hustoj`。
- 题库：2,148 道题分类树；班级名单与学情接口正常。
- 浏览器：教师与学生登录、课程和作业页面实际加载；编程工作台一键载入 Java AC 代码，自测样例 `1 2` 输出 `3`。
- 启动管理：停止后重新启动，持久化数据保留。

最近一次完整验收：2026-10-03，14 组端到端检查全部通过，验收题单 8、题目 1009。
截图：`.local/workspace-proof.png`。

```bash
cd backend
SQLX_OFFLINE=true ~/.cargo/bin/cargo test --locked
cd ../frontend
npm test -- --run
npm run typecheck
npm run build
```

`smoke.py` 会创建新的验收题单和提交记录，并在检查失败时返回非零退出码。
仓库原有 `backend/scripts/smoke.sh` 已执行，完整输出在 `.local/smoke.log`；
本机存在全局代理，运行该原始脚本时需要设置 `NO_PROXY=127.0.0.1,localhost`。
新增 Python 验收脚本自动绕过代理访问本机。

本次保留仓库的 Next.js 15.0.3；依赖安装提示该版本存在已知安全漏洞。
此次仅完成本地测试部署，公网部署前需升级并重新验证。

## 教师管理中心

已接入老师指定的 Grader 教师管理系统。使用相同的 `manage.py start|stop|status` 管理全部服务；访问 [教师工作台](http://127.0.0.1:3100/management/home)。完整功能、演示数据、接入规则和验收结果见 [教师管理说明](../../teacher-management/README.md)。

代码编辑器静态资源已移至 `frontend/public/editor/ace/`，带原始许可，不依赖原生网页代理。
