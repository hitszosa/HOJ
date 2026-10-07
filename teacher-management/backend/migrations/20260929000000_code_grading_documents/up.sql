CREATE TABLE code_grading_documents (
    submission_id BIGINT NOT NULL,
    original_sha256 VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    source_version VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    pdf_sha256 VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    preview_file_ident VARCHAR(255) NOT NULL,
    page_count INT NOT NULL,
    PRIMARY KEY (submission_id, original_sha256),
    INDEX code_grading_documents_preview (preview_file_ident),
    CONSTRAINT code_grading_document_submission FOREIGN KEY (submission_id) REFERENCES submissions(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;
