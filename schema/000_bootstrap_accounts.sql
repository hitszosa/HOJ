-- Course Service 数据库账号与授权引导
--
-- 必须以 MySQL root 执行（本文件创建账号）：
--     mysql -uroot < 000_bootstrap_accounts.sql
--
-- 授权的三条原则（都已逐条实测，见 docs/contract-v1.md §2）：
--   1. 教学域库全权；jol 库默认只读。
--   2. 对 jol 库的唯一写权限是「提交链路」需要的那几列：
--      INSERT solution / source_code / source_code_user，
--      以及 **only** solution.result 的列级 UPDATE（两阶段写入的最后一步）。
--      列级授权能在数据库层挡住「改判题事实」——实测 UPDATE solution SET user_id=... 会被拒。
--   3. 不授予任何 DELETE：清理与对账属于运维账号的职责。
--      脚本的清理步骤遇到无权限会降级为打印待删的 solution_id。
--
-- 建学生账号（INSERT jol.users）也不授予：那是教务 / SSO 的职责，
-- Course Service 只做学号到 user_id 的绑定。

-- 密码必须写成字面量：MariaDB 的 CREATE USER ... IDENTIFIED BY 不接受变量
-- （实测 `IDENTIFIED BY @var` 报 ERROR 1064）。部署前把下面两处的占位串替换掉，
-- 并把真实密码通过环境变量注入 Course Service，不要写进仓库。
-- 开发容器里当前用的密码是 codemind-dev-pw。
CREATE USER IF NOT EXISTS 'codemind'@'localhost' IDENTIFIED BY 'REPLACE_ME_STRONG_PASSWORD';
CREATE USER IF NOT EXISTS 'codemind'@'127.0.0.1' IDENTIFIED BY 'REPLACE_ME_STRONG_PASSWORD';

-- 教学域：全权
GRANT ALL PRIVILEGES ON `codemind_course`.*
    TO 'codemind'@'localhost', 'codemind'@'127.0.0.1';

-- 判题域：默认只读
GRANT SELECT ON `jol`.*
    TO 'codemind'@'localhost', 'codemind'@'127.0.0.1';

-- 提交链路所需的精确写权限
GRANT INSERT, UPDATE (`result`) ON `jol`.`solution`
    TO 'codemind'@'localhost', 'codemind'@'127.0.0.1';
GRANT INSERT ON `jol`.`source_code`
    TO 'codemind'@'localhost', 'codemind'@'127.0.0.1';
GRANT INSERT ON `jol`.`source_code_user`
    TO 'codemind'@'localhost', 'codemind'@'127.0.0.1';

FLUSH PRIVILEGES;

-- 运维 / 教师侧账号：题库导入、对账、清理、批量导出成绩需要写 jol 库的题目表、
-- 也要能删探测提交。**不要给 Course Service 业务账号** —— 业务账号越权写题目
-- 会让「判题事实不可改写」的边界失效。
-- 开发容器里当前用的密码是 codemind-ops-dev-pw。
CREATE USER IF NOT EXISTS 'codemind_ops'@'localhost' IDENTIFIED BY 'REPLACE_ME_OPS_PASSWORD';
CREATE USER IF NOT EXISTS 'codemind_ops'@'127.0.0.1' IDENTIFIED BY 'REPLACE_ME_OPS_PASSWORD';

GRANT SELECT, INSERT, UPDATE, DELETE ON `jol`.*
    TO 'codemind_ops'@'localhost', 'codemind_ops'@'127.0.0.1';
GRANT ALL PRIVILEGES ON `codemind_course`.*
    TO 'codemind_ops'@'localhost', 'codemind_ops'@'127.0.0.1';
