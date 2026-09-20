-- MariaDB 10.6: additive, repeatable migration for coordinated authoring.
USE codemind_course;
ALTER TABLE cm_batch
  ADD COLUMN IF NOT EXISTS read_only TINYINT(1) NOT NULL DEFAULT 0
    COMMENT 'Imported provenance forbids public export; retain on copy/update',
  ADD COLUMN IF NOT EXISTS authoring_key VARCHAR(64) DEFAULT NULL
    COMMENT 'Authoring draft ID: durable idempotency key for batch creation';
ALTER TABLE cm_batch
  ADD UNIQUE INDEX IF NOT EXISTS uk_batch_authoring_key (authoring_key);
