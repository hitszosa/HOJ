ALTER TABLE assignments DROP COLUMN show_score;
UPDATE cache_revision SET revision = UUID() WHERE id = 1;
