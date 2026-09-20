# Course Service ↔ HUSTOJ 集成契约 v1

> 状态：**已定稿，关键条款均已在真实环境实测**（2026-09-19，Colima/Docker 的 HUSTOJ，MariaDB 10.6.23）
> 产品边界以用户 2026-09-19 确认为准：HUSTOJ 改造版为主体，教学前端与服务半独立；CodeMind 仅供设计与 AI 能力参考。旧根目录规划不再作为产品方向依据。
> 配套产物：`schema/000_bootstrap_accounts.sql`、`schema/001_cm_course.sql`、`hustoj/codemind/tools/verify_direct_submit.py`

---

## 0. 范围与职责边界

| 组件 | 拥有什么 | 明确不做什么 |
|---|---|---|
| **HUSTOJ 主体** | 原生账号与登录会话、题目（`problem`）、提交与判题事实（`solution` / `source_code` / `compileinfo` / `runtimeinfo`）、查重（`sim`）、原有管理功能及教学入口 | 教学扩展复用这些能力，避免另造账号和判题系统 |
| **Course Service**（新建 FastAPI） | 教学域（课程 / 教学班 / 选课 / 批次题单 / 知识点）、学生端与教师端的 BFF、提交入口 | 不判题、不改判题事实、不做 AI 推理 |
| **可选 AI 能力** | 参考 CodeMind 的证据分离与分析设计；真实模型须配置后启用 | 不把规则建议冒充模型输出，不以 CodeMind 替代 HUSTOJ 产品 |
| **新前端**（Next.js） | 学生端与教师端界面 | 不直连 MySQL |

教学服务读写 HUSTOJ 已有题库与提交链路，HUSTOJ 原生功能继续保留。教学班权限仍按选课与任课关系判断，不能仅因原生账号存在就获得某课程教师权限。

### 原生身份接入

`hustoj/trunk/web/course.php` 提供教学入口；`?mode=session` 读取 HUSTOJ 原生会话并核对有效账号，返回当前用户，不接受调用者声明的用户或角色。教学 API 将原生会话交给固定配置的 HUSTOJ 地址验证。前端 `/oj/` 代理原生页面，与教学页面共用主机 Cookie。部署时两个服务应使用同一站点；本地统一使用 `127.0.0.1`，不要混用 `localhost`。

开发四角色登录仅在 `COURSE_DEV_LOGIN=1` 时存在，是本机验收入口；不替代原生登录，也不代表学校 OAuth 已配置。现有数据库和账号名中的 `codemind` 为兼容历史数据保留，不代表产品主体。

---


### 师生独立端（2026-09-19）

教学界面只保留一套蓝白视觉，不再提供风格切换。`/` 根据 `GET /api/me` 的结果分流：

- 返回保留 `user`、`authSource`、`devLogin`，新增 `roles: string[]`、`portal: "student" | "teacher"`、`home: "/student" | "/teacher"`。
- 角色来源是 `jol.privilege` 中当前用户的 `teacher` 权限、`cm_offering.teacher_id` 和当前用户 `status=active` 的选课角色。仅接受 student/teacher/ta；无关系默认 student，任一 teacher/ta 优先教学端。客户端参数不能声明端口或角色。
- 学生首页 `/student`、历史 `/student/history`，详情 `/student/courses/:oid`、`/student/batches/:bid`、`/student/batches/:bid/problems/:pid`。只显示学生课程与自己的练习信息。
- 教师首页 `/teacher`，课程/题单/题目预览使用 `/teacher/courses/:oid`、`/teacher/batches/:bid`、`/teacher/batches/:bid/problems/:pid`。题单管理、草稿和学情分别为 `/teacher/offerings/:oid`、`/teacher/drafts/:did`、`/teacher/insights/:oid`。
- 两端首页、导航和操作独立。旧 `/courses`、`/batches` 链接按服务端 portal 迁移；访问错端回到 me.home。未认证没有业务导航；本地开发身份按钮只在 devLogin 开启时出现，并默认折叠。
- 端口不授予课程权限。详情还须匹配该课程角色；全局教师不能访问未授权班级，助教仅预览与查看学情，不给草稿管理/发布/导出权限。权限与归档元数据全部成功后才渲染写控件。


## 1. 库与账号

同一个 MySQL 实例、**两个库**：

| 库 | 归属 | 说明 |
|---|---|---|
| `jol` | HUSTOJ | 上游升级时由 `install/db.sql` 管理；Course Service **不新增任何表** |
| `codemind_course` | Course Service | 教学域，独立建库，与 `jol` 之间只靠逻辑外键关联 |

拆库而不是同库加前缀的三个理由：① 授权可按库隔离；② HUSTOJ 的 `fixing.sh` 升级只碰自己的表，不会把教学域当成遗留表处理；③ 备份与恢复策略可以分开。

**Course Service 账号的授权**（`schema/000_bootstrap_accounts.sql`，已从零实测通过）：

```sql
GRANT ALL PRIVILEGES ON `codemind_course`.* TO 'codemind'@...;
GRANT SELECT ON `jol`.* TO 'codemind'@...;                        -- 判题域默认只读
GRANT INSERT, UPDATE (`result`) ON `jol`.`solution` TO 'codemind'@...;   -- 列级授权
GRANT INSERT ON `jol`.`source_code` TO 'codemind'@...;
GRANT INSERT ON `jol`.`source_code_user` TO 'codemind'@...;
```

实测的权限边界（都符合预期）：

| 操作 | 结果 |
|---|---|
| 写 `codemind_course` 教学域表 | ✅ 允许 |
| 读 `jol.problem` / `jol.solution`（跨库 JOIN） | ✅ 允许 |
| 走完两阶段提交链路（写 solution → source_code → UPDATE result） | ✅ 允许，`4/4` 用例判题正确 |
| `UPDATE jol.solution SET user_id=...` | ❌ `ERROR 1143`：列级授权挡住了改判题事实 |
| `DROP TABLE jol.problem` | ❌ `ERROR 1142` |
| `INSERT INTO jol.users` | ❌ `ERROR 1142`（建号属教务/SSO 职责） |
| `UPDATE jol.problem SET title=...` | ❌ `ERROR 1142` |
| `DELETE FROM jol.source_code` | ❌ `ERROR 1142`（清理属运维账号职责） |

对账、清理、批量导入题库请另建权限更宽的**运维账号**，不要把 DELETE 交给业务账号。验证脚本在无 DELETE 权限时会降级为打印待删的 `solution_id`。

---

## 2. 教学域表结构

完整 DDL：`schema/001_cm_course.sql`（已在 MariaDB 10.6 实测建表成功，8 张表全部 InnoDB）。

```
cm_course ──< cm_offering ──< cm_enrollment
                   │
                   └──< cm_batch ──< cm_batch_problem
                            │
                            └──< cm_submission（对账用，见 §3）

cm_course ──< cm_knowledge_point ──< cm_problem_knowledge
```

**四个关键设计决策**（每条都有理由，不要随手改）：

1. **排序规则固定 `utf8mb4_general_ci`**。`jol` 库所有表都是这个，服务端默认也是这个。换成 `utf8mb4_unicode_ci` 会让跨库 JOIN 直接报 `Illegal mix of collations`。
2. **不对 `jol` 的表建物理外键**。HUSTOJ 的表几乎全是 MyISAM（`jol` 23 张表里只有 `solution_ai_answer` 是 InnoDB、`online` 是 MEMORY），MyISAM 不支持外键。因此 `problem_id` / `user_id` / `solution_id` 全是**逻辑外键**，由应用层校验 + 定时对账兜底。
3. **不复用 `contest` 当批次**（比赛语义会带出排行榜，与作业定位冲突），**不复用 `users.group_name` 当班级**（单值字段，一个学生上两门课就废）。选课关系用 `cm_enrollment`，并带 `role` 区分 student / ta / teacher。
4. **不建 AI 任务表**，直接复用 `jol.openai_task_queue` 与 `jol.solution_ai_answer`。

已知的 HUSTOJ 侧契约陷阱（写入时容易踩）：

| 陷阱 | 事实 |
|---|---|
| `problem.memory_limit` 单位 | **是 MB，尽管列注释写的是"内存限制(KB)"**。实测题目 1000 该列值 `128`，实际限制 128MB（`judge_client.cc:3656` 按 `mem_lmt * 1MB` 用）。按注释写会把限制放大 1024 倍。 |
| `problem.defunct` | `'N'` 才对学生可见，导入题目时别漏。 |
| `privilege` 表 | **没有主键、没有唯一索引**，可能有重复行；且它是全局权限，粒度到不了教学班。**教学班内的角色一律以 `cm_enrollment.role` 为准**，不要读 `privilege`。 |
| `loginlog.password` | 明文存登录密码（官方注释称"用于审计"）。接 SSO 时避开这条落库路径。 |

---

## 3. 提交链路契约（本契约最关键的部分）

### 3.1 必须两阶段写入

`judged` 只轮询 `result<2`（`judged.cc:263`），而 HUSTOJ 是 MyISAM、**没有事务**。如果一步写成 `result=0`，「`solution` 已写、`source_code` 未写」的中间态会被判题机取走，判成 **CE，错误信息是 `cc1: fatal error: Main.c: No such file or directory`**——学生和 AI 诊断层都会被这条假错误带偏（已复现，字段探测 P5）。

因此必须照 `submit.php` 的两步做法：

```sql
-- 阶段 1：占位。result=14 是「MC 待裁判确认」，judged 不会取走
INSERT INTO jol.solution(problem_id,user_id,nick,in_date,language,ip,code_length,result,
                         contest_id,num,valid,judger)
VALUES(?,?,?,NOW(),?,?,?,14, 0,-1,1,'LOCAL');
SET @sid = LAST_INSERT_ID();          -- LAST_INSERT_ID() 是连接级，必须同一连接

-- 阶段 2：源码落库
INSERT INTO jol.source_code_user(solution_id,source) VALUES(@sid,?);
INSERT INTO jol.source_code(solution_id,source)      VALUES(@sid,?);

-- 阶段 3：放行
UPDATE jol.solution SET result=0 WHERE solution_id=@sid;
```

同时写 `cm_submission(submission_id=@sid, submit_state='placeholder', ...)`，放行后置 `'promoted'`。

这个两阶段设计带来一个**安全的失败模式**：进程在中途崩溃时，残留行停在 `result=14`，`judged` 不会碰它（已验证等 3 秒后仍为 14），可以按 `result=14 AND in_date < NOW() - INTERVAL 5 MINUTE` 扫出并对账。

### 3.2 字段契约

| 字段 | 规则 |
|---|---|
| `result` | 阶段 1 必须是 `14`，阶段 3 才置 `0` |
| `user_id` / `ip` | 仅有的两列「NOT NULL 且无默认值」，必须显式给值，否则 `ERROR 1364` |
| `in_date` | 必须显式 `NOW()`；省掉会静默落成建表时的 `2016-05-13 19:24:00` |
| `nick` | 建议写入当时的昵称快照（`submit.php` 的行为），便于历史查询不受改名影响 |
| `code_length` | 写入源码的 UTF-8 字节数 |
| `contest_id` / `num` | 作业提交一律 `0` / `-1`（不挂在 contest 上） |
| `judger` | 显式写 `'LOCAL'` |
| `source_code` 内容 | **Python 提交要自带 `# coding=utf-8` 前缀**（与 `submit.php:222` 保持一致，避免两套入口的代码哈希不一致） |
| `source_code_user` | 只供 Web 展示用户原始代码，判题不读它；不写也能判题，但建议写 |

### 3.3 判题机配置契约

| 配置 | 要求 | 理由 |
|---|---|---|
| **架构** | **必须 x86_64** | ARM64 为了避开 `okcalls*.h` 的 x86 系统调用号必须 `OJ_USE_PTRACE=0`，而这会连带废掉内存测量与系统调用白名单（详见 `CodeMind-OJ重构规划.md` §3.2 第 7 条）。ARM 只能作开发验证环境。 |
| `OJ_USE_PTRACE` | x86 上保持 `1` | 关掉会同时失去 MLE 判定与系统调用白名单 |
| `OJ_LANG_SET` | 必须包含 `0,1,3,6` | C / C++ / Java / Python；`judged` 的取任务语句按它过滤 |
| `character_set_client` | 写库一律带 `--default-character-set=utf8mb4` | MariaDB CLI 默认 latin1，中文会双重编码 |

### 3.4 回归验证

```bash
python3 hustoj/codemind/tools/verify_direct_submit.py                 # 20 条用例 + 5 项字段探测
python3 hustoj/codemind/tools/verify_direct_submit.py --keep          # 保留判题记录排查
python3 hustoj/codemind/tools/verify_direct_submit.py --ptrace 1 --case MLE   # 单独验证 MLE
```

每次升级 HUSTOJ（`fixing.sh` 会覆盖 `trunk/`）后必须重跑；用例覆盖 AC / WA / TLE / RE / CE 与四门语言，MLE 在 ARM 上会被标为「本配置下不可达」。

---

## 4. 学生端参考查询

这张 SQL 是「我的课程 → 批次 → 题目 + 我的状态」的参考实现，已在跨库场景实测通过（`cm_*` 在 InnoDB、`jol.*` 在 MyISAM，排序规则一致可 JOIN）：

```sql
SET @uid = :user_id;
SELECT c.code AS 课程, b.seq AS 批次, b.title AS 批次名,
       bp.problem_id AS 题号, p.title AS 题目,
       IFNULL(a.attempts, 0) AS 提交次数,
       IF(IFNULL(s.ever_ac, 0), '已通过', '未通过') AS 我的状态,
       DATEDIFF(b.due_at, NOW()) AS 距截止天数
FROM codemind_course.cm_enrollment e
JOIN codemind_course.cm_offering  o  ON o.offering_id = e.offering_id
JOIN codemind_course.cm_course    c  ON c.course_id   = o.course_id
JOIN codemind_course.cm_batch     b  ON b.offering_id = o.offering_id AND b.status = 'published'
JOIN codemind_course.cm_batch_problem bp ON bp.batch_id = b.batch_id
JOIN jol.problem p ON p.problem_id = bp.problem_id AND p.defunct = 'N'   -- 见下
LEFT JOIN (SELECT problem_id, COUNT(*) attempts FROM jol.solution
           WHERE user_id = @uid GROUP BY problem_id) a ON a.problem_id = bp.problem_id
LEFT JOIN (SELECT problem_id, MAX(result = 4) ever_ac FROM jol.solution
           WHERE user_id = @uid GROUP BY problem_id) s ON s.problem_id = bp.problem_id
WHERE e.user_id = @uid AND e.status = 'active'
ORDER BY c.code, b.seq, bp.seq;
```

三处容易写错、都是实测踩出来的：

1. **必须加 `p.defunct = 'N'`**。题目的可见性由**两个开关同时**决定：批次的 `status='published'` 和题目的 `defunct='N'`。导入器默认把新题写成 `defunct='Y'`（防止只有样例测试点的题被发布），漏掉这个过滤会把未就绪的题目直接推给学生。
2. **用 `MAX(result = 4)` 而不是 `MIN`**：学生同一题既有 AC 又有 CE 时，`MIN` 会取到 0，把已通过显示成未通过。
3. `DATEDIFF(b.due_at, NOW())` 在 `due_at IS NULL` 时返回 NULL，前端要按「不设截止」处理。

### 4.1 题单导入（已跑通）

`data/seed/` 下有 3 份种子题单（COMP1007，共 24 题，格式见 `CodeMind-OJ重构规划.md` §4.2），导入器是 `tools/import_batch.py`：

```bash
# 题库导入需要写 jol.problem，属于运维/教师侧操作，用 codemind_ops 账号
python3 tools/import_batch.py data/seed/COMP1007-W01.yml \
    --course-name 程序设计基础 --teacher admin \
    --user codemind_ops --password <ops 密码>
python3 tools/import_batch.py <题单> --dry-run    # 只看计划
python3 tools/import_batch.py <题单> --publish    # 补完测试数据后再放开
```

已验证的行为：

| 行为 | 结果 |
|---|---|
| 幂等 | 首次导入 24 题 created；重复导入 24 题 updated，不重复建题 |
| 题目身份 | 用 `problem.source = codemind:<course>/<batch>/<slug>` 承载稳定标识，**不新增表** |
| 默认隐藏 | 新题 `defunct='Y'`；加 `--publish` 才 `'N'`。实测只有被 publish 的批次对学生可见 |
| 测试点 | 每个题目把题单里的**样例**写成第 1 个测试点（`/home/judge/data/<id>/1.in|1.out`） |
| 端到端 | 导入后的题目可直接判题（实测题目 1001 的 AC / WA 结果正确） |

**发布前的硬性要求**：种子题单只带样例测试点，而样例是能被硬编码通过的。教师必须补齐测试数据后再 `--publish`，否则学生写 `printf` 硬编码即可通过。这是使用种子题库时必须接受的运维约束。

**一个已记录的局限**：导入器只能按 `problem.source` 去重，因此**无法识别平台里已有的、不是本导入器建的题目**（例如容器里预置的题目 1000「A+B Problem」与种子里新建的 1001 是同一道题）。生产环境应从空题库开始以种子题单为主源，或先做一轮人工去重。

### 4.2 HOA 独立题单仓库规范（2026-09-19 约定）

HOA 生态采用独立题单中心仓库 `HITSZ-OpenAuto/hoa-oj`，仅面向需要 Coding 实践的课程组织题单，避免污染上百门非编程通识与理论课程仓库：

1. **目录与文件名规则**：
   - 仓库路径：`problems/<课程代码>/<课程代码>-<批次标识>.yml`（例如 `problems/COMP1007/COMP1007-W01.yml`）。
   - 命名约定：以大写课程代码为子目录，文件名为课程代码前缀加周次/实验名（大写化，如 `COMP1007-W01.yml`、`COMP2052-LAB01.yml`）。
2. **来源标识契约（`cm_batch.source_ref`）**：
   - 独立题单仓库标准格式：`hoa:HITSZ-OpenAuto/hoa-oj@problems/<课程代码>/<课程代码>-<批次>.yml`。
   - 向后兼容历史单课格式：`hoa:HITSZ-OpenAuto/<课程代码>@oj/<文件名>`。
3. **五条导出安全红线（严禁逆向外发敏感数据）**：
   - 必须教师逐题勾选，默认全不选；
   - `read_only=true` 来源题单永不回写导出；
   - 未发布（`draft`）状态禁止导出；
   - 绝不外发测试用例与测试数据（仅题面与公开样例）；
   - 绝不外发学生提交与标程代码。

---


## 5. 权限矩阵

角色来源为教学班的 `teacher_id` 与有效 `cm_enrollment.role`。HUSTOJ 全局管理员不自动获得所有教学班权限；必须具有相应任课或选课关系。HUSTOJ 原生管理权限保持其原有作用域。

| 当前教学 API 操作 | student | ta | teacher |
|---|---|---|---|
| 课程 / 批次 / 题目查看 | 自己课程已开放内容 | 自己任教班 | 自己任教班 |
| 草稿编写 / 导入 / AI 出题 / 发布 | 禁止 | 禁止 | 自己任教班，归档班禁止写入 |
| 学生提交 | 自己当前课程 | 禁止 | 禁止代交 |
| 提交记录与学习建议 | 仅自己 | 自己任教班 | 自己任教班 |
| 班级学情 | 禁止 | 自己任教班 | 自己任教班 |
| HOA 公开题单下载 | 禁止 | 禁止 | 自己任教班，来源 read_only=true 时禁止 |

课程建班、选课管理、成绩导出、知识点维护和 HOA 自动发 PR 属于后续规划，不把这份历史规划矩阵当作已交付接口。现阶段课程/选课由现有导入与配置工具准备，HOA 提供资源链接和题单文件导入/导出。

三条硬性约束：

1. **学生只能看到自己**。班级平均可以给（不排名次），但任何接口都不得返回其他学生的个人数据。
2. **越权测试是阶段 2 的验收项**：对每个「仅自己 / 仅自己任教班」的行都必须有对应的反向用例（用另一个班的学生 / 另一个班的教师去访问）。
3. **AI 开关按批次控制**，考试场景由教师置 `ai_enabled=0`，此时不产生也不返回任何 AI 产物（复用 HUSTOJ 的 `$OJ_FORBIDDEN_AI_HELP` 思路，但权威来源是 `cm_batch.ai_enabled`）。

---

## 6. CodeMind 契约盘点：复用 / 改造 / 不复用

盘点对象：`codemind/packages/contracts/models.py`（44KB，全部继承 `ContractModel`，`extra="forbid"`）、`codemind/modules/*`、`codemind/apps/api/routers/*`。

### 6.1 直接复用

| 契约 / 能力 | 位置 | 说明 |
|---|---|---|
| `HintLevel`（1–3） | `models.py:198` | 分级提示的级别定义，直接用 |
| `ErrorType`（9 类一级标签） | `models.py:180` | 根因标签体系，直接用 |
| `EvidenceSourceType` | `models.py:204` | `COURSE_DOCUMENT` / `EXPERIMENT_GUIDE` 已能覆盖 HOA 课程资料作为 K 类证据 |
| `Evidence` / `EvidenceLink` | `models.py:417`、`431` | 三类证据（F/K/A）的载体，与 `hustoj/codemind/evidence.py` 的编号方案对得上 |
| `Diagnosis` / `CandidateCause` | `models.py:710`、`695` | 诊断结果结构，直接把 HUSTOJ 事实填进去即可 |
| `RetrievalRequest` / `RetrievedChunk` / `KnowledgeQARequest` | `models.py:747`、`754`、`776` | RAG 接口形状，直接复用 |
| `modules/rag`（`RAGService` / `retrieve`） | `modules/rag/__init__.py` | 检索能力整体复用，含 HOA 语料的治理管道 |
| `modules/model_service`（`ModelService.generate` / `resolve_task_spec`） | `modules/model_service/__init__.py` | 模型路由 + 规则降级，直接复用；业务层只许 import 这两个入口 |
| `modules/report.build_report` | `modules/report/__init__.py` | 报告生成复用 |
| `apps/api/routers` 的路由形状 | `apps/api/routers/*.py` | `/api/courses`、`/{id}/insights`、`/api/me/dashboard` 等形状可直接沿用，前端 hooks 也一并复用 |

### 6.2 需要改造后才能用

| 契约 | 问题 | 处理 |
|---|---|---|
| `ProgrammingLanguage` | 只有 `python` / `c` / `java`，**缺 C++** | 增补 `cpp`（枚举加值是向后兼容的） |
| `UserRole` | 只有 `student` / `teacher` / `admin`，**缺助教** | 增补 `ta` |
| `CourseSummary` | 字段是 `experiment_count` / `average_progress`，是实验语义 | 保留形状（id / name / teacher_id / student_count / progress），字段按批次语义重命名 |
| `Submission` | 有 `experiment_id` / `file_ids` / `version`，ID 是自有 ObjectId | 换成 HUSTOJ 的 `solution_id`，代码正文不入 Pydantic（大字段走 `source_code`） |
| `RunResult` / `TestResult` / `RunMetrics` | 面向"沙箱多测试点执行"设计 | 需要一个**适配器**把 HUSTOJ 的 `solution` + `compileinfo` + `runtimeinfo` + `diff.out` 映射成这个形状——值得做，因为 AI 诊断层已经按它写的 |
| `TaskCard` | 承载「任务卡」的结构化描述（steps / inputs / acceptance_criteria） | 很适合当 **AI 辅助出题的产物格式**（草稿 → 教师确认 → 落 `jol.problem`），但不要拿来存运行期数据 |

### 6.3 不复用

| 能力 | 原因 |
|---|---|
| `modules/sandbox`（OpenSandbox） | HUSTOJ 判题机取代了它的执行职责；`analyzer.py` 的复杂度实测能力要改成「在 HUSTOJ 上多规模重跑」，不能直接搬 |
| `modules/agent` 的状态机与 `ExperimentState` | 它是围绕 `experiment` 实体设计的（CREATED→PARSING→WAITING_CONFIRMATION→READY→…）。新平台的判题由 HUSTOJ 负责，提交就是一次 INSERT，没有这套状态。用 `hustoj/codemind/` 已验证的「规则 → 模型」两级链替代 |
| `apps/api/auth.py` 与会话体系 | 需要对接校内统一身份认证，不能直接用 |
| `apps/api/store.py`（SQLite） | Course Service 用 MySQL |
| `modules/analysis/` | **这个目录是空的**（只有 `.gitkeep`）——规划 v3.0 把它列为已有能力是笔误，学情分析的实现实际在 `modules/agent/analysis_report.py` |

**一条总体判断**：不要照搬 `codemind/apps/api`。它是 SQLite + experiment 域 + 沙箱执行的完整应用，而 Course Service 应该是个薄服务——只复用 `packages/contracts` 的形状、`modules/model_service`、`modules/rag`、`modules/report`，教学域与提交入口全部新写。

---

## 7. 未决问题

| # | 问题 | 何时解决 |
|---|---|---|
| 1 | **必须在 x86_64 上复验三项**：MLE 在正式配置下的稳定性、系统调用白名单对四门语言正常程序是否全放行、Java 的 `-Xmx` 与 `RLIMIT_AS` 的实际交互（Java 是唯一不设 `RLIMIT_AS` 的语言） | 拿到 x86 判题机后立即，早于阶段 4 |
| 2 | 对账任务的策略细节：`result=14` 的残留行是重放还是放弃？重放要不要重新校验 `source_code` 是否完整？ | 阶段 2 实现时 |
| 3 | SSO 对接方式：HUSTOJ 无内置 OIDC，需在登录流程加适配层或走 `service.php`；且要避开 `loginlog` 明文密码落库 | 阶段 2 |
| 4 | MyISAM 无崩溃恢复，提交记录可能损坏。备份频率与恢复演练要覆盖 `jol` 库 | 阶段 1 运维 |
| 5 | 「复杂度实测」（L5）在 HUSTOJ 上怎么落地：需要在判题机外多规模重跑学生代码，与判题链路隔离 | 阶段 5，可延后 |
| 6 | HOA 题单回写的公开仓库红线（逐题勾选、不导测试用例、不导 draft）尚未实现 | 阶段 6 |
| 7 | **建 `codemind` 分支与启用 CI 尚未执行**——按仓库纪律（`hustoj/AGENTS.md` 与 `codemind/CLAUDE.md` 都禁止未经明确要求的 Git 写操作），本轮只交付了工作流文件 `.github/workflows/codemind.yaml`，没有建分支、没有提交。启用方式：<br>`cd hustoj && git checkout -b codemind && git add .github/workflows/codemind.yaml codemind/tools/verify_direct_submit.py && git commit -m "..."` | 由项目负责人在确认改动后执行 |
| 8 | **判题机二进制与工作区源码不一致**：`trunk/core/judge_client/judge_client.cc` 在镜像构建之后被并行改动（新增 aarch64 运行库拷贝，+18 行），本轮的实测都是对**改动前**编译的二进制做的。重新构建镜像会引入该改动，**必须重跑提交链路回归**再上线 | 下次重建镜像时 |
| 9 | 工作区存在**并行未提交的工作**（`hustoj` 的 SSO 接入：`login_sso.php` / `include/sso.php` / `SSO.md` 等；`codemind` 的 reports 与 sandbox 改动）。本轮未触碰它们；其中 SSO 工作与 §5 的登录设计、以及 `loginlog` 明文密码问题直接相关，接手前先与对方对齐 | 阶段 2 前 |


## 本地验收与部署配置（2026-09-19）

- 教学界面：`http://127.0.0.1:3100/`；原生入口：`http://127.0.0.1:8080/course.php`；API：8100。两个网页入口统一使用同一主机名。
- `COURSE_HUSTOJ_URL` 为前端固定代理目标（默认8080）；`COURSE_HUSTOJ_SESSION_URL` 为 API 固定身份验证地址（默认8080/course.php?mode=session）。均由服务部署配置，不接受请求参数覆盖。
- `COURSE_HUSTOJ_COOKIE` 默认 `PHPSESSID`；如修改 PHP session.name，需同步该配置。PHP 端会话键使用当前 `$OJ_NAME`，无需复制硬编码站点名。
- `COURSE_ALLOWED_ORIGINS` 是逗号分隔的允许前端来源；默认只含本机3100两种主机名。换站点时必须设置完整 origin（协议、主机、端口），不要使用通配符。
- `OJ_COURSE_URL` 设置 HUSTOJ 原生入口链接的教学站点地址。127.0.0.1默认值仅用于当前本机验收，远程部署必须修改。
- `DELETE /api/session` 只清除教学开发 cookie，并返回 `logoutUrl`。前端随后访问 HUSTOJ logout.php 销毁原生会话；不能先删 PHPSESSID，否则原生端无法定位待注销会话。
- `COURSE_DEV_LOGIN=1` 仅用于本机试点角色体验，正式部署关闭。当前 API 绑定127.0.0.1。学校 OAuth 凭据尚未配置。
- `COURSE_AI_URL`（OpenAI兼容API根地址）、`COURSE_AI_MODEL`、`COURSE_AI_KEY` 配置教师生成和学生模型建议。当前未配置真实模型；未配置/失败明确规则降级，不宣称真实模型验收。

## 提交前自测（2026-09-19）

`POST /api/batches/{bid}/problems/{pid}/trials` 接收 `{code, language, input}`，返回 `{runId}`。仅该教学班学生可运行，沿用题目可见性、批次关闭/截止与归档约束。语言为 c/cpp/java/python；输入允许空字符串，最多 16384 UTF-8 字节且不得含 NUL；源码连同 Python 编码头最多 65535 字节（Python 用户代码最多 65520）。同一用户 3 秒冷却；10 分钟内未完成的自测阻止重复运行，返回 429 和 Retry-After: 3。

复用 HUSTOJ `problem_id=0` 沙箱路径，使用已有 ops 连接写 solution、source_code、source_code_user 和 custominput，填充完毕才开放判题。不会写 cm_submission，不计作业提交次数。代码不在课程 API 宿主执行。

`GET /api/trials/{runId}` 返回 `{state,result,label,time,memory,output,compileError,truncated}`。runId 使用独立 trial 签名域的 HMAC，绑定用户、教学批次、题目及 solution，1 小时有效；每次读取重新检查身份和课程/题目访问权。只读取本人 problem_id=0 的记录；归档后本人已有结果可读。

0/1/2/3/14 为 running，其余为 finished；11 单独显示 compileError。原生 13 统一表示“自测结束”，不代表 AC，output 可能含运行错误或资源限制诊断。输出和编译信息各按 UTF-8 16384 字节截断并标记 truncated。题目样例输出仅供人工对照，不作为自定义输入的期望答案。
