# 真实多 Agent 联调起点

## 当前方向（2026-09-19 用户最终确认）

改造 HUSTOJ 为校内编程作业平台。HUSTOJ 账号、题库、提交与判题为基础；半独立教学界面采用单一蓝白视觉；学生端与教师端的首页、导航和详情路由分开，由 HUSTOJ 登录身份自动分流；支持学生当前/历史课程与批次题单、教师导入/编写/AI 辅助出题和学情分析，联动 HOA 课程资料。CodeMind 只作设计与 AI 参考。

前两轮计划 `oj-real-agents-1` 和 `hustoj-teaching-2` 已完成。本轮 `hustoj-portals-3` 取消多风格并分离师生端，Codex 负责服务端角色与最终集成、Kimi 负责前端改造、OMP 负责身份回归。下文旧测试数量属于历史记录，以最终节点证据为准。不删除 `codemind` 参考仓库或已验证教学服务，不清空数据库。仅清理前端真实路由不再引用的 mock/views 旧原型，并改测真实组件。

HUSTOJ 新增 `course.php` 教学入口和 `?mode=session` 当前身份接口。教学 API 原生身份接入由 DeepSeek 负责，前端清理/原生入口由 Kimi 负责，OMP 负责身份边界回归，Codex 负责 PHP 入口、契约与最终集成。CodeBuddy 已完成 HOA 节点，当前离线不视为其在继续工作。

用户已明确：测试是把 agent-bus 装进 Codex、Kimi Code、DeepSeek Harness、OMP、CodeBuddy，由当前 Codex 作为主 Agent，组织这些真实会话共同开发。不要继续由单个 Agent 包办 OJ 改造。

## 前两轮现场记录（历史，不作为当前验收结论）

- OJ Hub：`~/oj/.bus`，8978；主 Agent 身份文件 `~/oj/.bus-peer.codex-platform.json`。凭据不写进本文件。
- 当前新增 `service.py`：FastAPI + 现有 MySQL/HUSTOJ，开发环境通过 Docker mysql CLI 访问。
- 数据库新增教学域 `cm_authoring_draft`，定义在 `schema/002_authoring.sql`。
- `tools/setup_pilot.py` 创建独立 `PILOT1007` 体验课程和 cm_pilot_* 账号，保留原课程数据。
- 前端六主题、课程/历史、教师草稿编辑、YAML/JSON/FPS 导入、发布、提交判题、规则提示、学情统计、选择性公开导出已接入 API。
- 已执行 Python 26 项（含 18 项既有 HOA 测试、6 项新验证测试、2 项本机数据库端到端测试），前端 23 项主题测试、类型检查及生产构建。
- 一次真实链路：offering=10 → batch=10 → problem=1025 → submission=1148 → HUSTOJ AC。随后验证 AI 开关、跨用户访问和导出数据边界。
- 本机前端在 127.0.0.1:3100，API 在 127.0.0.1:8100；尚未做浏览器交互验收，需由分配的 Agent 完成。

## 历史待核对边界（最新状态见 ACCEPTANCE.md）

1. 当前是本机体验版，开发登录由 COURSE_DEV_LOGIN=1 显式开启；学校 SSO 尚未连接，不能作为生产账号系统上线。
2. AI 出题需要 COURSE_AI_URL / COURSE_AI_MODEL / COURSE_AI_KEY；未配置时返回明确不可用。学生提示目前是规则建议，没有声称调用真实模型。
3. 数据库配置用 COURSE_DB_USER/PASSWORD、COURSE_OPS_USER/PASSWORD；现有容器的开发账号信息见原 CODEBUDDY.md。不要把运行凭据提交到 Git。
4. 发布过程跨 MyISAM 与文件写入，失败重试需要重点审查：已有题目与测试数据更新、孤立记录、并发和回滚边界。
5. 继续检查历史课程只读、跨班/跨学生隔离、未知路由、浏览器本地代码草稿的身份隔离。
6. HOA 仅链接与导入/下载导出；未向 GitHub 发 PR，未抓取或批准新的 RAG 语料。需复核 read_only 来源信息的保留。
7. 当前服务使用单进程锁和 Docker 开发访问通道；多进程生产部署尚未验收。
8. 不要把上述测试结果当作真实多 Agent 联调已经完成。

## 推荐任务划分

真实分配以主 Agent 发布的 DAG 为准。候选：Kimi 浏览器与前端、DeepSeek 后端边界、OMP 回归测试、CodeBuddy 导入/HOA、Codex 接口决策与最终集成。派发前确认各端已加入、Hook 实际触发并收到就绪回应。
