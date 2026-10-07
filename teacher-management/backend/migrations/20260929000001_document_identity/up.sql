ALTER TABLE grading_documents
    DROP COLUMN source_sha256,
    DROP COLUMN pdf_sha256;

UPDATE cache_revision SET revision = UUID() WHERE id = 1;
