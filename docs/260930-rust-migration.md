# 后端迁移到 Rust（Axum + sqlx）记录 · 2026-09-30

分支：`exp/rust-backend`（从 `exp/monorepo` 切出）。旧 Python 版移到 `backend/legacy/`，迁移期保留做对照，切换完成后删除。

## 1. 接口对照（45 个，全部迁移）

| 接口 | 旧 Python | 新 Rust |
|---|---|---|
| GET `/api/health` | `api/system.py::health` | `routes/system.rs::health` |
| GET `/api/demo/users` | `system.py::demo_users` | `system.rs::demo_users` |
| GET `/api/faq` | `system.py::get_faq` | `system.rs::faq` |
| POST/DELETE `/api/session` | `session.py::login/logout` | `session.rs::login/logout` |
| GET `/api/me` | `session.py::me` | `session.rs::me` |
| GET `/api/courses` | `offerings.py::courses` | `offerings.rs::courses` |
| POST `/api/courses/{cid}/offerings` | `offerings.py::create_offering` | `offerings.rs::create_offering` |
| GET/PATCH `/api/offerings/{oid}` | `offerings.py::offering/update_offering` | `offerings.rs::offering/update_offering` |
| GET `/api/offerings/{oid}/insights` | `offerings.py::insights` | `offerings.rs::insights` |
| GET/POST `/api/offerings/{oid}/students` | `offerings.py::offering_students/add_offering_student` | `offerings.rs::students/add_students` |
| DELETE `/api/offerings/{oid}/students/{uid}` | `offerings.py::drop_offering_student` | `offerings.rs::drop_student` |
| GET/POST `/api/offerings/{oid}/drafts` | `drafts.py::drafts/save_draft` | `drafts.rs::list/create` |
| POST `/api/offerings/{oid}/generate` | `drafts.py::generate` | `drafts.rs::generate` |
| GET/PUT/DELETE `/api/drafts/{id}` | `drafts.py::draft/update_draft/delete_draft` | `drafts.rs::read/update/remove` |
| POST `/api/drafts/{id}/publish` | `drafts.py::publish` | `drafts.rs::publish` |
| GET/PATCH `/api/batches/{bid}` | `batches.py::batch/batch_settings` | `batches.rs::batch/settings` |
| GET `/api/batches/{bid}/problems/{pid}` | `batches.py::problem` | `batches.rs::problem` |
| POST `…/problems/{pid}/submissions` | `batches.py::submit` | `batches.rs::submit` |
| POST `…/problems/{pid}/trials` | `batches.py::run_trial` | `batches.rs::run_trial` |
| GET `/api/trials/{run_id}` | `batches.py::trial_result` | `batches.rs::trial_result` |
| POST `/api/batches/{bid}/copy` | `batches.py::copy_batch` | `batches.rs::copy` |
| POST `/api/batches/{bid}/export` | `batches.py::export` | `batches.rs::export` |
| GET `/api/submissions/{sid}` | `submissions.py::result` | `submissions.rs::result` |
| GET `/api/submissions/{sid}/analysis` | `submissions.py::analysis` | `submissions.rs::analysis` |
| GET `/api/submissions/{sid}/code` | `submissions.py::get_submission_code` | `submissions.rs::code` |
| GET `/api/status` | `submissions.py::get_status_stream` | `submissions.rs::status` |
| GET `/api/ranklist` | `ranking.py::get_ranklist` | `ranking.rs::ranklist` |
| GET `/api/teacher/library` | `teacher_library.py::get_teacher_library` | `teacher_library.rs::library` |
| POST `/api/teacher/library/sets` | `teacher_library.py::create_library_set` | `teacher_library.rs::create_set` |
| POST `/api/teacher/library/deploy` | `teacher_library.py::deploy_library_set` | `teacher_library.rs::deploy` |
| GET `/api/problem-sets` | `problem_sets.py::get_all_problem_sets` | `problem_sets.rs::index` |
| GET `/api/problem-sets/tree` | `problem_sets.py::category_tree_view` | `problem_sets.rs::tree` |
| GET `/api/problem-sets/my-status` | `problem_sets.py::get_bank_my_status` | `problem_sets.rs::my_status` |
| POST `/api/problem-sets/publish-to-offerings` | `problem_sets.py::publish_to_offerings` | `problem_sets.rs::publish_to_offerings` |
| GET `/api/offerings/{oid}/problem-sets` | `problem_sets.py::offering_problem_sets` | `problem_sets.rs::offering_sets` |
| POST `/api/offerings/{oid}/import-set` | `problem_sets.py::import_problem_set` | `problem_sets.rs::import_set` |
| GET `/api/public-problems` | `public_problems.py::get_public_problems` | `public_problems.rs::list` |
| GET `/api/public-problems/{key}` | `public_problems.py::get_public_problem` | `public_problems.rs::detail` |
| POST `/api/public-problems/{key}/submissions` | `public_problems.py::submit_public_problem` | `public_problems.rs::submit` |

## 2. 契约变化（前端已同步修改）

- **统一信封**：`{code, message, data}`，风格与 `comp-backend-old` 一致。成功 `code="OK"`；失败 `code` 为 `VALIDATION_ERROR / UNAUTHORIZED / FORBIDDEN / NOT_FOUND / CONFLICT / PAYLOAD_TOO_LARGE / UNPROCESSABLE_ENTITY / TOO_MANY_REQUESTS / UPSTREAM_ERROR / SERVICE_UNAVAILABLE / INTERNAL_ERROR`，`message` 为可直接展示的中文。HTTP 状态码照常使用。
- **字段全部 snake_case**，请求体与查询参数也是（`offering_id`、`page_size`、`only_mine`…）。
- **真实类型**：数字、布尔不再是字符串（旧版 `mysql --xml` 返回的全是字符串，前端有大量 `==='1'`）。
- **前端类型由后端生成**：`cargo test` 输出到 `frontend/src/api/generated/`，前端 `api<T>()` 直接使用；字段写错 `tsc` 会报错。
- 结构调整：`/api/offerings/{oid}` 的教师统计收进 `batches[].staff`；`/api/problem-sets/tree` 返回 `{tree:{root,total_problems,total_sets}, my_status}`；`/api/offerings/{oid}/problem-sets` 用 `categories[].matched` 替代单独的推荐列表；公开题详情去掉 `sampleInput/sampleOutput`，统一用 `samples`。
- 补齐了前端一直在读、旧后端从未返回的字段：`Offering.course_code/course_name`、源码页的 `nick/code_length/in_date`、状态流的查重 `sim/sim_solution_id`。

## 3. 修正的问题

| 问题 | 旧行为 | 新行为 |
|---|---|---|
| **SSO 头可伪造（高危）** | 未配置 SSO 时也信任 `X-Remote-User`，Nginx 不清理，任何人可冒充 admin | 只在显式设置 `COURSE_SSO_HEADER` 时信任；Nginx 默认清空该头 |
| 每条 SQL 一次 `docker exec mysql` | 单次约 60ms，教师班级页约 0.6–0.7s | 连接池；同一页面约 25ms |
| 进程锁 `MUTEX` | `uvicorn --workers 4` 下跨进程无效 | 发布与自测改用 MySQL 命名锁（跨进程有效） |
| N+1 查询 | 班级页、题单页逐题单 / 逐题查询 | 按 id 聚合的一次查询 |
| 公开题提交 | 先写 `result=0` 再写源码（判题机可能读到空源码），并用 `MAX(solution_id)` 反查 id | 与作业提交一致的两阶段写入，直接取 `LAST_INSERT_ID` |
| 开班可指定任意教师 | 任何教师可用 `teacherId` 替他人开班 | 只有 admin 可指定 |
| 无班教师建题单 | 落到“全库最新的班”，之后本人无权访问该草稿 | 直接报错 |
| 非题单提交请求学习建议 | 500 | 404“该提交不属于任何题单” |
| 截止 / 开放时间判断 | 进程本地时钟与数据库时钟混用 | 统一用数据库 `NOW()` |
| 题库首访并发 | 可能插出两道同源题 | `INSERT … WHERE NOT EXISTS` |
| 状态流用户搜索 | `%`、`_` 未转义 | 已转义 |

## 4. 部署变化

- 数据库连接：挂载 hustoj 容器的 `/run/mysqld` 到宿主机 `/run/hoj-mysql`，经 unix socket 连接，**授权不变**、不暴露 3306。
- 判题数据：直接写共享目录 `/home/judge/data`（`COURSE_JUDGE_DATA_DIR`），不再 `docker exec tee`。
- 构建：`SQLX_OFFLINE=true cargo build --release --locked`，构建机不需要数据库。
- **已有 hustoj 容器没有 `/run/mysqld` 挂载，且其数据库未挂卷**，重建会丢数据。`deploy_rh2288.sh` 检测到这种情况会停下并给出两种处理方式（备份后重建容器 / 改走 TCP 并追加授权），需要人工决定。
- **排序规则**：HUSTOJ 的 `db.sql` 不指定排序规则，jol 跟随服务器默认（MariaDB 11 为 `uca1400_ai_ci`，MySQL 8 为 `0900_ai_ci`），教学域表固定 `utf8mb4_general_ci`。跨库字符串连接已显式加 `COLLATE`，不需要改库。
- `hoj-infra/services/hoj/compose.yaml` 的 api 服务仍是 Python 命令，需要同步改为 Rust 镜像，并给 hustoj 与 api 共享 `/run/mysqld`。

## 5. 验证

- 后端：单元测试与 HTTP 层测试全部通过，`cargo clippy --all-targets` 无警告。
- 本地库（HUSTOJ `db.sql` + `schema/001–004`）上跑通完整流程：建草稿 → 发布（幂等）→ 学生提交 / 自测（频率限制 429）→ 结果与源码权限 → 班级统计 → 名单增删 → 复制 / 导出 → 题库导入与多班发布 → 公开题首访落库与提交。
- 前端：`tsc` 无错误，vitest 全部通过；无头 Chrome 巡检教师端、学生端 22 个页面无报错，并实际操作了提交、自测、审核发布、选题篮发布、添加学生、题库部署。
- syvps 隔离验证栈（`/srv/hoj-verify`：MariaDB 11.8 默认排序规则 + 真实 HUSTOJ 判题机，静态 musl 二进制，经挂载的 unix socket 连库）：
  - 冒烟脚本全部符合预期（36 个成功，其余为预期的 4xx），服务日志无错误。首次运行暴露了跨库 `user_id` 连接的排序规则冲突（班级学生统计、名单、排行榜 503），已修复。
  - 真实判题：作业题 Python AC / WA、C++ AC、C 编译错误（含编译信息）、自测输出、公开题首访写入测试点并完成判题。
  - HUSTOJ 原生会话：注册并登录 HUSTOJ 后 `/api/me` 识别为 `hustoj` 来源；伪造或格式非法的会话 401；未配置 SSO 时忽略 `X-Remote-User`；HUSTOJ 登出后在缓存期内仍有效，过期后 401。
  - AI 调用链路（OpenAI 兼容的假模型）：出题生成草稿、学习建议走模型且带 Bearer、外发内容不含隐藏测试、已通过的提交不调模型；模型故障时出题 502、学习建议降级为规则。
- 未验证：真实模型的输出质量、生产机（rh2288）的 socket 挂载（需先决定 hustoj 容器的处理方式，见第 4 节）。
