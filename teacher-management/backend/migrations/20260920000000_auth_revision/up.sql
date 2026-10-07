ALTER TABLE cache_revision ADD COLUMN auth_revision VARCHAR(36) NOT NULL DEFAULT '';
UPDATE cache_revision SET auth_revision = UUID();
ALTER TABLE cache_revision ALTER COLUMN auth_revision DROP DEFAULT;
