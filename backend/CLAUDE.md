# backend/ — HOJ 课程服务（Rust · Axum + sqlx）

在 HUSTOJ（`jol` 库 + 判题机）之上提供课程、题单、作业、学情接口。前端是 `../frontend`（Next.js），通过 `/api` 代理访问。

## 目录

```
src/
  main.rs  app.rs          启动；路由挂载 + 全局中间件（Origin 校验、1MB 限制、no-store）
  config.rs  state.rs      环境变量配置；AppState（两个连接池、HTTP 客户端、签名密钥、会话缓存、题库索引）
  response.rs  error.rs    统一信封 {code, message, data}；AppError 每个变体固定 HTTP 状态码 + code
  extract.rs               Json / Path / Query 提取器（失败也走信封）——handler 里用这三个，不用 axum 原生的
  auth.rs  security.rs     身份解析（SSO 头 → HUSTOJ 会话 → 开发登录）；cookie 与自测 runId 签名
  access.rs                权限闸：offering_access / batch_access（所有按班级、题单的访问都必须先过这里）
  hustoj.rs                HUSTOJ 适配：状态码、语言、两阶段提交写入、自测、判题数据写入
  document.rs              题单文档：校验（先 Value 后强类型）、YAML/JSON/FPS 解析、发布前检查
  authoring.rs             草稿存取、草稿 → 题单发布（三条发布入口共用）、MySQL 命名锁
  problem_bank.rs          本地题库 data/problem_sets：启动时建索引，按需读完整题目
  ai.rs  dt.rs             AI 出题与学习建议；DATETIME 的 JSON 格式
  routes/<领域>.rs         一个领域一个文件；文件顶部的 router() 就是该领域全部接口
tests/http.rs              不连库的 HTTP 层回归（鉴权、CSRF、信封）
legacy/                    旧 Python 版，迁移期对照用，切换完成后删除
.sqlx/                     sqlx 离线查询缓存（必须提交）
```

## 约定

- **响应**：handler 返回 `AppResult<ApiOk<T>>`，成功写 `Ok(ok(data))`。`T` 必须 `#[derive(Serialize, TS)] #[ts(export)]`。
- **错误**：`AppError::not_found("中文提示")` 等构造函数；提示直接展示给用户，要具体。数据库错误用 `?` 自动转成 503，细节只进日志。
- **JSON 字段一律 snake_case**（请求与响应都是）。时间字段用 `#[serde(with = "crate::dt")]` + `#[ts(type = "string")]`，格式 `YYYY-MM-DD HH:MM:SS`。`i64`/`u64` 字段加 `#[ts(type = "number")]`。
- **SQL**：优先 `sqlx::query!` / `query_as!`（编译期对照真实库校验）。LEFT JOIN 出来的列加 `AS "col?"`，聚合列加 `AS "n!: i64"` 覆盖可空性。只有动态拼条件时才用 `QueryBuilder`，值一律 `push_bind`。
- **时间比较交给数据库**：`open_at > NOW()` 这类判断写进 SQL（见 `access::load_batch`），不要用进程时钟。
- **两个连接池**：`s.db`（codemind 账号：教学域全权、jol 只读 + 提交链路写权限）；`s.ops`（codemind_ops：写 jol.problem / jol.users / custominput）。按最小权限选。
- **jol 是 MyISAM，没有事务**：写 jol 的多步操作要能安全重试（见 `hustoj::insert_submission` 的两阶段写入、`authoring::publish` 的顺序）。需要跨进程互斥时用 `authoring::with_lock`（MySQL 命名锁）。
- **避免 N+1**：列表页的统计用一条 GROUP BY 查出来，按 id 合并。
- 新增接口：在对应 `routes/*.rs` 的 `router()` 里加一行，handler 写在同一文件。

## 常用命令

```bash
cargo test                      # 单元测试 + HTTP 测试；同时重新生成 ../frontend/src/api/generated/*.ts
cargo clippy --all-targets
SQLX_OFFLINE=true cargo build   # 不连库编译（CI / 部署）
cargo sqlx prepare -- --all-targets   # 改了 SQL 后，连库重新生成 .sqlx/ 并提交
cargo run                       # 读取 backend/.env
```

编译期 SQL 校验需要一个带 `jol` 与 `codemind_course` 两个库的 MariaDB（`DATABASE_URL` 写在 `backend/.env`）。
库结构：`jol` 用 HUSTOJ 的 `install/db.sql`，教学域用 `schema/001–004`；两边排序规则都必须是 `utf8mb4_general_ci`。

## 运行配置（环境变量）

| 变量 | 说明 |
|---|---|
| `COURSE_DATABASE_URL` / `COURSE_OPS_DATABASE_URL` | 完整连接串；未设置时由下列变量拼出 |
| `COURSE_DB_SOCKET` | mysqld.sock 路径（优先于 host/port；来源视为 localhost） |
| `COURSE_DB_HOST` `COURSE_DB_PORT` `COURSE_DB_USER` `COURSE_DB_PASSWORD` `COURSE_OPS_USER` `COURSE_OPS_PASSWORD` | 分项配置 |
| `COURSE_BIND` | 监听地址，默认 `127.0.0.1:8100` |
| `COURSE_JUDGE_DATA_DIR` | 与 HUSTOJ 共享的判题数据目录；不设则回退 `docker exec` 写入 |
| `COURSE_ALLOWED_ORIGINS` | 写请求允许的 Origin，逗号分隔 |
| `COURSE_DEV_LOGIN=1` | 开启开发登录（生产必须关闭） |
| `COURSE_SSO_HEADER` | 显式设置后才信任该身份头；网关必须剥掉客户端自带的同名头 |
| `COURSE_HUSTOJ_SESSION_URL` `COURSE_HUSTOJ_COOKIE` `COURSE_SESSION_CACHE_TTL` | HUSTOJ 会话回源校验与缓存秒数（默认 30） |
| `COURSE_AI_URL` `COURSE_AI_MODEL` `COURSE_AI_KEY` `COURSE_AI_TIMEOUT` | OpenAI 兼容模型服务 |
