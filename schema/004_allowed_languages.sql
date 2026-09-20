-- Migration 004: add allowed_languages to cm_batch
USE codemind_course;
ALTER TABLE cm_batch
  ADD COLUMN IF NOT EXISTS allowed_languages VARCHAR(64) DEFAULT NULL
    COMMENT '允许语言列表(逗号分隔如 c,cpp,java,python)，NULL=全允许';
