CREATE TABLE code_grading_reviews (
    submission_id BIGINT NOT NULL,
    source_file_ident VARCHAR(255) NOT NULL,
    source_sha256 VARCHAR(64) NOT NULL,
    revision BIGINT NOT NULL,
    base_cents INT NOT NULL,
    files MEDIUMTEXT NOT NULL CHECK (JSON_VALID(files)),
    marks MEDIUMTEXT NOT NULL CHECK (JSON_VALID(marks)),
    updated_by BIGINT NULL,
    updated_at DATETIME NOT NULL,
    PRIMARY KEY (submission_id),
    CONSTRAINT code_grading_submission FOREIGN KEY (submission_id) REFERENCES submissions(id) ON DELETE CASCADE,
    CONSTRAINT code_grading_author FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;
