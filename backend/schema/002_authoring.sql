USE codemind_course;
CREATE TABLE IF NOT EXISTS cm_authoring_draft (
 draft_id CHAR(32) PRIMARY KEY,
 offering_id INT UNSIGNED NOT NULL,
 owner_id VARCHAR(48) NOT NULL,
 title VARCHAR(128) NOT NULL,
 payload MEDIUMTEXT NOT NULL,
 status ENUM('draft','published') NOT NULL DEFAULT 'draft',
 origin ENUM('teacher','ai') NOT NULL DEFAULT 'teacher',
 batch_id INT UNSIGNED DEFAULT NULL,
 updated_at DATETIME NOT NULL,
 FOREIGN KEY (offering_id) REFERENCES cm_offering(offering_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
