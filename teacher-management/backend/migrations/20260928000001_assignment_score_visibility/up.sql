ALTER TABLE assignments ADD COLUMN show_score BOOLEAN NOT NULL DEFAULT FALSE;
UPDATE cache_revision SET revision = UUID() WHERE id = 1;
