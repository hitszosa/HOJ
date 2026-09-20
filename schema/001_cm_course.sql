-- Course Service 教学域 schema v1
--
-- 与 HUSTOJ 的 jol 库分离部署在同一个 MySQL 实例里，通过限定名跨库读取。
-- 之所以独立成库：HUSTOJ 的 install/db.sql 与 fixing.sh 只操作自己的表，
-- 教学域放在 jol 库里会被视为「外来表」，且权限无法按库隔离。
--
-- 三条硬约束（都由实测得出，见 docs/contract-v1.md）：
--   1. 排序规则必须是 utf8mb4_general_ci —— jol 库所有表都是这个，
--      用 utf8mb4_unicode_ci 会导致跨库 JOIN 报 Illegal mix of collations。
--   2. 不能对 jol 库的表建物理外键：HUSTOJ 的表几乎全是 MyISAM，不支持外键。
--      对 problem_id / user_id / solution_id 的引用只能是逻辑外键，
--      由 Course Service 在应用层校验，并靠定时对账兜底。
--   3. 不建 AI 任务表 —— 直接复用 HUSTOJ 的 openai_task_queue 与 solution_ai_answer。
--
-- 本文件只建表，不含账号与授权；授权语句见 docs/contract-v1.md §2。

CREATE DATABASE IF NOT EXISTS `codemind_course`
    DEFAULT CHARACTER SET utf8mb4
    DEFAULT COLLATE utf8mb4_general_ci;

USE `codemind_course`;

-- ---------------------------------------------------------------- 课程与教学班

-- 课程：跨学期的稳定实体，如「COMP1007 程序设计基础」
CREATE TABLE IF NOT EXISTS `cm_course` (
    `course_id`   INT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '课程ID',
    `code`        VARCHAR(32)  NOT NULL COMMENT '课程代码，与 HOA 仓库名一致，如 COMP1007',
    `name`        VARCHAR(128) NOT NULL COMMENT '课程名称',
    `credit`      DECIMAL(3,1)          DEFAULT NULL COMMENT '学分',
    `hoa_repo`    VARCHAR(64)           DEFAULT NULL COMMENT 'HITSZ-OpenAuto 仓库名；NULL=未关联',
    `created_at`  DATETIME     NOT NULL COMMENT '创建时间',
    `updated_at`  DATETIME     NOT NULL COMMENT '更新时间',
    PRIMARY KEY (`course_id`),
    UNIQUE KEY `uk_course_code` (`code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='课程';

-- 教学班：课程 × 学期 × 教学班编号，如「COMP1007 · 2026 秋 · 01 班」
CREATE TABLE IF NOT EXISTS `cm_offering` (
    `offering_id` INT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '教学班ID',
    `course_id`   INT UNSIGNED NOT NULL COMMENT '课程ID',
    `term`        VARCHAR(16)  NOT NULL COMMENT '学期，如 2026-秋',
    `section`     VARCHAR(32)  NOT NULL DEFAULT '' COMMENT '教学班编号',
    `title`       VARCHAR(128)          DEFAULT NULL COMMENT '展示用标题',
    `teacher_id`  VARCHAR(48)  NOT NULL COMMENT '主讲教师，逻辑外键 → jol.users.user_id',
    `status`      ENUM('draft','active','archived') NOT NULL DEFAULT 'draft' COMMENT '状态',
    `created_at`  DATETIME     NOT NULL COMMENT '创建时间',
    `updated_at`  DATETIME     NOT NULL COMMENT '更新时间',
    PRIMARY KEY (`offering_id`),
    UNIQUE KEY `uk_offering` (`course_id`, `term`, `section`),
    KEY `idx_offering_teacher` (`teacher_id`),
    KEY `idx_offering_term_status` (`term`, `status`),
    CONSTRAINT `fk_offering_course` FOREIGN KEY (`course_id`)
        REFERENCES `cm_course` (`course_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='教学班';

-- 选课关系。为什么不用 HUSTOJ 的 users.group_name：
-- 它是单值字段，一个学生同时上两门课就表达不了；而且没有角色区分。
CREATE TABLE IF NOT EXISTS `cm_enrollment` (
    `enrollment_id` INT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '选课记录ID',
    `offering_id`   INT UNSIGNED NOT NULL COMMENT '教学班ID',
    `user_id`       VARCHAR(48)  NOT NULL COMMENT '逻辑外键 → jol.users.user_id',
    `role`          ENUM('student','ta','teacher') NOT NULL DEFAULT 'student' COMMENT '教学班内角色',
    `student_no`    VARCHAR(32)           DEFAULT NULL COMMENT '学号（user_id 非学号时使用）',
    `status`        ENUM('active','dropped') NOT NULL DEFAULT 'active' COMMENT '选课状态',
    `created_at`    DATETIME     NOT NULL COMMENT '创建时间',
    `updated_at`    DATETIME     NOT NULL COMMENT '更新时间',
    PRIMARY KEY (`enrollment_id`),
    UNIQUE KEY `uk_enrollment` (`offering_id`, `user_id`),
    KEY `idx_enrollment_user_status` (`user_id`, `status`),
    CONSTRAINT `fk_enrollment_offering` FOREIGN KEY (`offering_id`)
        REFERENCES `cm_offering` (`offering_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='选课关系';

-- ---------------------------------------------------------------- 批次题单

-- 批次题单：教学班内的一次作业，如「第 3 周 · 循环结构」
-- 为什么不复用 HUSTOJ 的 contest：contest 自带排行榜、封榜、OI 赛制等比赛语义，
-- 学生看到排名会把作业当竞赛，与「校内编程作业」的产品定位冲突。
CREATE TABLE IF NOT EXISTS `cm_batch` (
    `batch_id`    INT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '批次ID',
    `offering_id` INT UNSIGNED NOT NULL COMMENT '教学班ID',
    `seq`         INT UNSIGNED NOT NULL COMMENT '批次序号，用于排序',
    `title`       VARCHAR(128) NOT NULL COMMENT '批次标题',
    `description` TEXT                  DEFAULT NULL COMMENT '批次说明（Markdown）',
    `open_at`     DATETIME              DEFAULT NULL COMMENT '开放时间；NULL=立即开放',
    `due_at`      DATETIME              DEFAULT NULL COMMENT '截止时间；NULL=不设截止',
    `allow_late`  TINYINT(1)   NOT NULL DEFAULT 1 COMMENT '截止后是否允许补交',
    `ai_enabled`  TINYINT(1)   NOT NULL DEFAULT 1 COMMENT '本批次是否开启 AI 辅助（考试场景置0）',
    `status`      ENUM('draft','published','closed') NOT NULL DEFAULT 'draft' COMMENT '状态',
    `source_ref`  VARCHAR(255)          DEFAULT NULL COMMENT '题单来源，如 hoa:HITSZ-OpenAuto/COMP1007@oj/w03.yml',
    `created_at`  DATETIME     NOT NULL COMMENT '创建时间',
    `updated_at`  DATETIME     NOT NULL COMMENT '更新时间',
    PRIMARY KEY (`batch_id`),
    UNIQUE KEY `uk_batch_seq` (`offering_id`, `seq`),
    KEY `idx_batch_status_due` (`status`, `due_at`),
    CONSTRAINT `fk_batch_offering` FOREIGN KEY (`offering_id`)
        REFERENCES `cm_offering` (`offering_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='批次题单';

-- 批次内的题目。problem_id 引用 jol.problem，逻辑外键（对方是 MyISAM，无法建物理外键）
CREATE TABLE IF NOT EXISTS `cm_batch_problem` (
    `batch_problem_id` INT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '批次题目ID',
    `batch_id`         INT UNSIGNED NOT NULL COMMENT '批次ID',
    `problem_id`       INT          NOT NULL COMMENT '逻辑外键 → jol.problem.problem_id',
    `seq`              TINYINT UNSIGNED NOT NULL COMMENT '批次内顺序',
    `score`            DECIMAL(5,2) NOT NULL DEFAULT 100.00 COMMENT '分值',
    `due_at`           DATETIME              DEFAULT NULL COMMENT '单题截止；NULL=继承批次',
    `required`         TINYINT(1)   NOT NULL DEFAULT 1 COMMENT '是否必做',
    `created_at`       DATETIME     NOT NULL COMMENT '创建时间',
    `updated_at`       DATETIME     NOT NULL COMMENT '更新时间',
    PRIMARY KEY (`batch_problem_id`),
    UNIQUE KEY `uk_bp_seq` (`batch_id`, `seq`),
    UNIQUE KEY `uk_bp_problem` (`batch_id`, `problem_id`),
    KEY `idx_bp_problem` (`problem_id`),
    CONSTRAINT `fk_bp_batch` FOREIGN KEY (`batch_id`)
        REFERENCES `cm_batch` (`batch_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='批次题目';

-- ---------------------------------------------------------------- 提交索引与对账

-- 提交在教学域的归属索引。
--
-- 这张表存在的唯一理由是 **对账**：HUSTOJ 是 MyISAM、没有事务，提交要分三步写
-- （见 docs/contract-v1.md §4），进程在中途崩溃会留下残留行。`submit_state` 让
-- 对账任务能精确找出「已写 jol.solution(result=14) 但没走完」的提交并重放或放弃。
--
-- submission_id 由 jol.solution 的自增值决定，本表不自增。
CREATE TABLE IF NOT EXISTS `cm_submission` (
    `submission_id`    INT UNSIGNED NOT NULL COMMENT '= jol.solution.solution_id（逻辑外键）',
    `offering_id`      INT UNSIGNED NOT NULL COMMENT '教学班ID',
    `batch_id`         INT UNSIGNED          DEFAULT NULL COMMENT '批次ID；NULL=自由练习',
    `batch_problem_id` INT UNSIGNED          DEFAULT NULL COMMENT '批次题目ID',
    `user_id`          VARCHAR(48)  NOT NULL COMMENT '逻辑外键 → jol.users.user_id',
    `language`         TINYINT      NOT NULL COMMENT 'HUSTOJ 语言编号',
    `submit_state`     ENUM('placeholder','promoted','abandoned') NOT NULL DEFAULT 'placeholder'
        COMMENT 'placeholder=已占位待放行；promoted=已放行判题；abandoned=对账时判为放弃',
    `created_at`       DATETIME     NOT NULL COMMENT '创建时间',
    `promoted_at`      DATETIME              DEFAULT NULL COMMENT '放行时间',
    PRIMARY KEY (`submission_id`),
    KEY `idx_cs_state_created` (`submit_state`, `created_at`) COMMENT '对账扫描用',
    KEY `idx_cs_batch_user` (`batch_id`, `user_id`),
    KEY `idx_cs_offering_user` (`offering_id`, `user_id`),
    CONSTRAINT `fk_cs_batch` FOREIGN KEY (`batch_id`)
        REFERENCES `cm_batch` (`batch_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='提交归属与对账';

-- ---------------------------------------------------------------- 知识点

-- 知识点树。学生端「知识点掌握度」、L3 题目推荐、L4 学习路径都依赖它
CREATE TABLE IF NOT EXISTS `cm_knowledge_point` (
    `kp_id`     INT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '知识点ID',
    `course_id` INT UNSIGNED NOT NULL COMMENT '课程ID',
    `parent_id` INT UNSIGNED          DEFAULT NULL COMMENT '父知识点；NULL=顶层',
    `code`      VARCHAR(64)  NOT NULL COMMENT '知识点编码，课程内唯一',
    `name`      VARCHAR(128) NOT NULL COMMENT '知识点名称',
    `created_at` DATETIME    NOT NULL COMMENT '创建时间',
    `updated_at` DATETIME    NOT NULL COMMENT '更新时间',
    PRIMARY KEY (`kp_id`),
    UNIQUE KEY `uk_kp_code` (`course_id`, `code`),
    KEY `idx_kp_parent` (`parent_id`),
    CONSTRAINT `fk_kp_course` FOREIGN KEY (`course_id`)
        REFERENCES `cm_course` (`course_id`),
    CONSTRAINT `fk_kp_parent` FOREIGN KEY (`parent_id`)
        REFERENCES `cm_knowledge_point` (`kp_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='知识点';

-- 题目到知识点的标注。source 区分人工与 AI，AI 标注必须经教师确认才可用于评估类场景
CREATE TABLE IF NOT EXISTS `cm_problem_knowledge` (
    `problem_knowledge_id` INT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '主键',
    `problem_id`  INT          NOT NULL COMMENT '逻辑外键 → jol.problem.problem_id',
    `kp_id`       INT UNSIGNED NOT NULL COMMENT '知识点ID',
    `weight`      DECIMAL(4,3) NOT NULL DEFAULT 1.000 COMMENT '权重 0-1',
    `source`      ENUM('teacher','ai') NOT NULL DEFAULT 'teacher' COMMENT '标注来源',
    `confirmed`   TINYINT(1)   NOT NULL DEFAULT 1 COMMENT 'AI 标注是否已由教师确认',
    `created_at`  DATETIME     NOT NULL COMMENT '创建时间',
    PRIMARY KEY (`problem_knowledge_id`),
    UNIQUE KEY `uk_pk_problem_kp` (`problem_id`, `kp_id`),
    KEY `idx_pk_kp` (`kp_id`),
    CONSTRAINT `fk_pk_kp` FOREIGN KEY (`kp_id`)
        REFERENCES `cm_knowledge_point` (`kp_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='题目知识点标注';
