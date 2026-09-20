# 首轮真实多 Agent 协作约定

计划：`oj-real-agents-1` v1。主 Agent：`codex-platform`。

## 顺序与范围

主 Agent 先完成 contract（本文与 003 数据迁移），验收后释放 frontend、backend、hoa。backend 与 hoa 均验收后释放 tests。contract、frontend、backend、hoa、tests 全部验收后才释放主 Agent 的 integration。提交不等于验收。

| 节点 | 负责人 | 编辑范围 |
| --- | --- | --- |
| frontend | kimi-worker | course-service/web/ |
| backend | deepseek-099caf3b | course-service/service.py |
| hoa | codebuddy-fb39f339 | course-service/tools/ |
| tests | omp-oj-main | course-service/tests/ |
| contract / integration | codex-platform | course-service/，仅各自节点运行时 |

已通过限轮阻塞线程 t5–t8 收集建议并由主 Agent 定案。四个工作 Agent 已有真实宿主 Hook 回报；旧主身份上的 kimi 标记是修复前误绑定记录，不作为接入证据。

## 接口决策

1. 无教学班成员资格返回 404；已是成员但没有教师权限返回 403。archived 教学班禁止所有写操作（含学生提交），返回 409；历史查看仍允许。教师下载已发布且非只读来源的题单属于只读操作，可允许。
2. 来源采用顶层 `read_only`（严格布尔）与 `source_ref`（字符串，最多 255 字符）。`read_only` 表示禁止公开导出，不等同禁止本地教学编辑。草稿更新、复制、发布不能清除已有 true；导入来源引用保留到具体题单文件。
3. `cm_batch.read_only` 与已有 `source_ref` 持久化来源。导出器同时核对请求标记及题单本身的标记，不能因调用者漏传参数而放行。逐题选择和公开字段白名单继续生效，隐藏测试与学生代码不外发。
4. `cm_batch.authoring_key` 为可空且唯一的 VARCHAR(64)，取 authoring draft ID。已有批次保持 NULL。后端必须用该唯一键原子创建或找回批次，避免创建后回填前崩溃产生重复。不能仅靠内存锁或尚未持久化的 JSON 完成幂等。
5. 发布失败时批次保持不可见；重试要同步最新题面、完整测试集及关联关系，不能遗留多余测试。教学域 InnoDB 可用事务，HUSTOJ MyISAM 不可假设跨库事务回滚。全部准备完成后才发布可见状态。
6. HOA 课程链接使用已有课程映射或明确的只读链接数据。未在 registry 收录不等于获批 RAG 语料；本轮不改 codemind registry、不抓取未获批语料、不向 GitHub 发布。

## 验证和运行

Python 使用 `course-service/.venv/bin/python`。OMP 的离线测试在 backend 与 hoa 验收后执行；会写共享数据库的端到端测试由主 Agent 在集成阶段串行执行。

Kimi 可以管理前端 3100，API 8100 的重启由主 Agent 负责，避免覆盖他人验证。前端证据要来自当前实现，而非旧生产构建。任何范围或接口变更先通过总线协商。

每次改文件先拿锁、读最近三条记录；每批改动登记 300 字内摘要；submit 附实际命令和结果。主 Agent 独立复核后 approve，下游才释放。SSO、真实模型凭据和生产判题机验证仍按交接文档列为明确限制，不虚报完成。

## contract 验收证据

2026-09-19：在本机 hustoj 容器的 codemind_course 库使用业务账号连续执行 003 两次，均 exit 0；information_schema 确认 read_only=tinyint(1)、authoring_key=varchar(64)，uk_batch_authoring_key 的 NON_UNIQUE=0。只增加字段与索引，未修改现有题单或提交记录。

发布权限补充：已发布草稿在 active 班重复发布返回 200 及原 batchId；archived 班仍返回 409，不因幂等分支绕过历史只读限制。
