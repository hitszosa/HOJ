# 班级学生分页与详情页

- 班级名单：服务器搜索、分页，默认 20 人/页，可改为 50 人/页。
- 班级页使用 include_insights=false，避免一次加载全班学生统计。
- 新接口 GET /api/offerings/{oid}/student-roster，教师班级权限、学生成员有效性、页大小上限、稳定排序及 LIKE 字符转义。
- 新页面 /management/courses/{courseId}/students/{studentId}：独立学生成绩与代码页面，按身份及班级检查权限。题单默认收起。
- 列表的搜索、页码和每页人数存于 URL，进入详情和返回名单保留位置。
- 无数据库结构变更，沿用每题最佳提交与代码接口。

验证记录：.local/student-pages/。本机类型检查/构建、HTTP 鉴权检查及分页 SQL 运行检查；服务器另以 23 名临时学生检验分页、搜索、返回导航、成绩与越权，并实际清理测试数据。
