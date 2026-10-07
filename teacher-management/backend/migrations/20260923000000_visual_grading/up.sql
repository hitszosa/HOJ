CREATE TABLE grading_rubrics (
    assignment_id BIGINT NOT NULL,
    user_id BIGINT NOT NULL,
    revision BIGINT NOT NULL,
    base_cents INT NOT NULL,
    rules MEDIUMTEXT NOT NULL CHECK (JSON_VALID(rules)),
    PRIMARY KEY (assignment_id, user_id),
    CONSTRAINT grading_rubric_assignment FOREIGN KEY (assignment_id) REFERENCES assignments(id) ON DELETE CASCADE,
    CONSTRAINT grading_rubric_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

CREATE TABLE grading_documents (
    submission_id BIGINT NOT NULL,
    version VARCHAR(36) NOT NULL,
    source_file_ident VARCHAR(255) NOT NULL,
    source_sha256 VARCHAR(64) NOT NULL,
    pdf_sha256 VARCHAR(64) NOT NULL,
    preview_file_ident VARCHAR(255) NULL,
    page_count INT NOT NULL,
    PRIMARY KEY (submission_id),
    KEY grading_document_preview (preview_file_ident),
    CONSTRAINT grading_document_submission FOREIGN KEY (submission_id) REFERENCES submissions(id) ON DELETE CASCADE,
    CONSTRAINT grading_document_preview_file FOREIGN KEY (preview_file_ident) REFERENCES file_info(file_ident)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

CREATE TABLE grading_reviews (
    submission_id BIGINT NOT NULL,
    revision BIGINT NOT NULL,
    base_cents INT NOT NULL,
    marks MEDIUMTEXT NOT NULL CHECK (JSON_VALID(marks)),
    updated_by BIGINT NULL,
    updated_at DATETIME NOT NULL,
    PRIMARY KEY (submission_id),
    CONSTRAINT grading_review_document FOREIGN KEY (submission_id) REFERENCES grading_documents(submission_id) ON DELETE CASCADE,
    CONSTRAINT grading_review_author FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;
