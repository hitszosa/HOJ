# 2026-09-28 单仓库拆分与真实环境回归记录

本文记录 `service.py` 拆分为 `backend/` 与 `frontend/` 单仓库的改动、在真实 HUSTOJ 上的新旧代码对比回归，以及回归中确认的问题。拆分改动在 `exp/monorepo` 分支，尚未合入 `main`。解耦总体方向沿用 [2026-09-26 记录](260926-issues.md) 第 3 节。

## 1. 本次完成的改动

### 1.1 目录结构

```text
backend/
  hoj/
    main.py        应用组装：中间件与路由挂载
    config.py      backend/.env 加载与路径
    auth.py        身份解析（SSO 头 / HUSTOJ 原生会话 / 开发登录）
    api/           10 个按领域拆分的路由模块
    services/      权限闸、题库、出题发布、AI 学习建议等业务逻辑
    hustoj/        HUSTOJ 适配层雏形：会话协议、测试点写入、状态码
    infra/         数据库执行器、签名密钥、进程锁
    hoa.py         原 tools/hoa.py，可用 python -m hoj.hoa 调用
  schema/  data/  tests/  tools/  requirements.txt  pyproject.toml
frontend/          原 web/，内容未改
Makefile           make install / dev-api / dev-web / test
```

### 1.2 拆分方式与行为保持

- 按顶层函数原文机械搬移，SQL 文本一字未改（离线测试的假库按 SQL 文本匹配）。
- 与拆分前逐函数比对 AST，仅 3 处有意改动：`ROOT` 改指 `backend/`；`db` 改为可替换后端的稳定句柄（测试替换 `database.db.backend`）；`principal` 改为调用 `security.key()`，使测试替换签名密钥时只有一个入口。
- 新旧应用的 OpenAPI 比对：46 个接口的方法、路径、参数与请求体完全一致。
- 测试与 `tools/` 脚本改为直接导入 `hoj.*`，删除了 `service.py`，不保留兼容层；`hoa` 不再依赖 `sys.path` 注入。
- 同步更新了 `deploy/deploy_rh2288.sh`、两个 systemd 单元、`.gitignore`、README 与文档中的路径。

### 1.3 已有部署的迁移事项

| 项目 | 原位置 | 新位置 |
|---|---|---|
| API 启动入口 | `uvicorn service:app` | `cd backend && uvicorn hoj.main:app` |
| 环境变量文件 | 仓库根 `.env` | `backend/.env` |
| Python 虚拟环境 | 仓库根 `.venv` | `backend/.venv` |
| 会话签名密钥 | `data/local/session.key` | `backend/data/local/session.key`（不迁移则所有开发登录会话失效） |
| 前端工作目录 | `web/` | `frontend/` |

引用了旧入口或旧路径的容器编排与部署配置，需要按上表同步调整。

## 2. 验证

### 2.1 离线验证

- 后端：113 通过、35 失败、2 跳过，失败名单与拆分前逐条一致。35 个失败均为需要真实数据库的测试，在无数据库时返回 503/401。
- 前端：Vitest 29 通过，`tsc --noEmit` 通过。
- 服务启动：`/api/health` 返回 200，未登录访问 `/api/courses` 返回 401。

### 2.2 真实 HUSTOJ 回归

方法：

1. 使用三容器 HUSTOJ 部署（Web、MariaDB 11.8、判题机）新建一套独立环境，数据库从空库初始化，默认排序规则为 `utf8mb4_uca1400_ai_ci`。
2. 课程侧依次执行 `schema/000`、`001`、`003`、`004` 与 `tools/setup_pilot.py`，并安装 `course.php` 身份桥接。
3. 保存初始快照。拆分前与拆分后的代码各自运行前都恢复同一份快照，设置 `COURSE_LIVE_TEST=1`，完整运行 unittest（150 项）。

**结果：新旧代码 150 项逐条结果一致，失败信息逐条一致。** 共 17 失败、10 错误，原因都与拆分无关：

| 类别 | 数量 | 原因 |
|---|---|---|
| 缺少并列仓库 | 10 错误 | `hoa` 测试读取 `<workspace>/codemind/data/source_registry/courses.json` |
| 依赖固定数据 | 13 失败 | 测试写死教学班编号（35、1）与账号（`teacher_wang`、`teacher_su` 等），仓库没有对应的造数脚本，空库中返回 404 或空结果 |
| 写死端口 | 1 失败 | `test_native_session_wins_and_forwards_the_php_cookie` 断言会话地址为 `127.0.0.1:8080` |
| 判题未完成 | 1 失败 | 端到端流程中提交停在"运行中"，见 3.1 |
| 其他数据相关 | 2 失败 | 公开题库为空；`/api/me` 门户判定依赖教师数据 |

## 3. 发现的问题

### 3.1 三容器部署下测试点写不到判题机

**现象：** 端到端测试中，教师发布题单后学生提交停在 `result=3`（运行中），超时未出结果。新旧代码一致。

**原因：** `write_test_files` 通过 `docker exec $COURSE_CONTAINER` 写 `/home/judge/data/<pid>`。代码按"数据库与判题在同一容器"的单容器 HUSTOJ 设计，`COURSE_CONTAINER` 同时承担数据库访问和测试点写入。在数据库与判题机分离的部署中，这个变量只能指向数据库容器，测试点因此写进了数据库容器，判题机的数据目录中没有对应文件。

**影响：** 所有数据库与判题机分离的部署都会遇到：教师发布的题目无法判题。

**建议：** 作为适配层的首项工作，把数据库访问与测试点写入拆成两项独立配置，测试点改为直接写判题机数据目录所在的共享卷，不再经 `docker exec`。

### 3.2 HUSTOJ 编排中判题网络名写死

所用 HUSTOJ 容器编排中，判题机的 `JUDGER_NETWORK` 为固定值，没有跟随网络名变量。在同一主机上另起一套环境时，新判题机的沙箱会加入原有网络，并通过主机名 `mysql` 连到原有数据库。建议改为引用网络名变量；在修正前，复制编排时必须同时修改这一项。

### 3.3 初始化脚本权限导致首次启动未建库

HUSTOJ 建库脚本 `db.sql` 若权限为 `0600 root`，MariaDB 以 `mysql` 用户执行初始化时报 `Permission denied`，`jol` 库未创建，HUSTOJ 首页返回 500。新建环境时需确保该文件对容器内 `mysql` 用户可读，或改为手工导入。

### 3.4 进程内锁在多 worker 下无效

`MUTEX` 是 `threading.RLock`，而 `deploy/systemd/hoj-api.service` 以 `--workers 4` 启动。自测防刷采用"先查再插"，发布流程也依赖这个锁，多进程下互斥不成立。本次未修改，建议改用 MySQL `GET_LOCK()` 或唯一约束。

### 3.5 测试依赖外部状态

- 13 项测试依赖固定编号的教学班与账号，只能在特定数据库上通过。建议补造数夹具，或改为在测试内创建所需数据。
- `hoa` 测试依赖工作区中的 `codemind` 仓库。
- 1 项测试写死 `8080` 端口，应读取与服务一致的配置。

### 3.6 拆分遗留

以下内容为保持行为不变而暂未处理：

- 路由函数互相调用：`submit`、`run_trial`、`trial_result`、`analysis` 调用 `problem()`；`analysis` 调用 `result()`；`copy_batch`、`generate` 调用 `save_draft()`。因此 `api.batches`、`api.submissions`、`api.drafts` 之间存在导入依赖。
- `jol.*` SQL 仍分散在 `api/` 与 `services/` 中，`hustoj/` 目前只收拢了会话、测试点与常量。
- `import_problem_set` 与 `publish_to_offerings` 有约 150 行重复代码。

## 4. 后续顺序

| 顺序 | 待办 | 完成标准 |
|---|---|---|
| 1 | 修复测试点写入（3.1） | 三容器部署中端到端测试的提交能判出 AC |
| 2 | 建立 HUSTOJ 适配层，从提交与判题链路开始 | `hoj/hustoj/` 之外不再出现 `jol.*`，CI 中用 grep 检查 |
| 3 | 替换进程内锁（3.4） | 多 worker 下自测限流与发布互斥成立 |
| 4 | 测试造数夹具（3.5） | 在空库上除外部仓库依赖外全部通过 |
| 5 | 同步部署配置（1.3） | 所有编排与部署脚本使用 `hoj.main:app` 与 `backend/` 路径 |
