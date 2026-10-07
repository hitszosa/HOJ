# 删除排行榜：2026-10-05

已删除全站排行榜和班级天梯榜的导航、课程卡片入口、班级标签页、React 视图、路由、生成类型、Rust/Python API、排行 SQL 和专属 SQLx 缓存。题库与评测列表使用的分页函数移到 `backend/src/pagination.rs`。

前端通配页面按统一路由表校验，未知页面直接返回 HTTP 404；旧 `tab=ranklist` 不再识别，课程默认显示作业。教师作业完成情况、代码浏览、权重成绩和成绩导出保留，不生成名次。没有修改或删除课程、学生、提交或成绩数据，没有调用 AI。

## 验证

- 前端 9 项路由测试和 3 项权重成绩测试通过；TypeScript 检查及本机、服务器生产构建通过。
- Rust 8 项 HTTP 测试通过，包括旧排行榜 API 返回 404。
- 服务器统一入口的匿名、管理员请求 `/api/ranklist`（含班级查询）均为 404；课程、花名册、成绩、评测列表、公开题库列表均为 200。原 QA 学生题单成绩仍为 100。
- 服务器与本机的 `/student/ranklist`、`/teacher/ranklist`、`/ranklist` 均为 HTTP 404。本机浏览器确认教师课程列表与班级详情没有排行榜入口，班级详情保留作业、学情与完成情况。
- 本机及服务器的 API、Web 已重建并重启；服务器其余服务运行正常。部署前源码和运行镜像有备份。

服务器指标：`/opt/hoj/qa-fixes/no-ranking-verification-20261005.json`。本机指标：`.local/no-ranking/remote-verification.json`、`.local/no-ranking/local-verification.json`。

网络验证边界：本次后段检查中，这台 Mac 直连 `10.249.12.21:3100` 返回空响应或连接重置，SSH 正常；远程 HTTP 复查在服务器本机通过统一 3100 入口完成。该直连现象在更新运行镜像前已出现，未确认原因；未声称远程浏览器验收通过。本机浏览器验收通过。
