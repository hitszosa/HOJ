-- Empty-database baseline. Convert existing installations once with tool/migrate-legacy.ts.

CREATE TABLE `users` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  `username` varchar(150) NOT NULL,
  `email` varchar(254) DEFAULT NULL,
  `password` varchar(255) NOT NULL,
  `first_name` varchar(150) DEFAULT NULL,
  `last_name` varchar(150) DEFAULT NULL,
  `is_staff` tinyint(1) NOT NULL DEFAULT 0,
  `is_active` tinyint(1) NOT NULL DEFAULT 1,
  `date_joined` datetime NOT NULL DEFAULT current_timestamp(),
  `last_login` datetime DEFAULT NULL,
  `real_name` varchar(1000) NOT NULL,
  `role` int(11) NOT NULL DEFAULT 0,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  `password_expired` tinyint(1) NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

CREATE TABLE `courses` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  `title` varchar(60) NOT NULL,
  `year` int(11) NOT NULL,
  `term` int(11) NOT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  CONSTRAINT `CONSTRAINT_1` CHECK (`year` >= 2017 and `year` <= 2099),
  CONSTRAINT `CONSTRAINT_2` CHECK (`term` in (0,1,2))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

CREATE TABLE `course_students` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  `course_id` bigint(20) NOT NULL,
  `user_id` bigint(20) NOT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

CREATE TABLE `course_teachers` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  `course_id` bigint(20) NOT NULL,
  `user_id` bigint(20) NOT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

CREATE TABLE `course_assistants` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  `course_id` bigint(20) NOT NULL,
  `user_id` bigint(20) NOT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

CREATE TABLE `assignments` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  `title` varchar(60) NOT NULL,
  `course_id` bigint(20) NOT NULL,
  `creator_id` bigint(20) DEFAULT NULL,
  `published` tinyint(1) NOT NULL DEFAULT 0,
  `start_time` datetime NOT NULL DEFAULT current_timestamp(),
  `due_time` datetime NOT NULL,
  `description` text DEFAULT '',
  `allowed_extension` varchar(100) DEFAULT 'zip',
  `score` int(11) NOT NULL DEFAULT 100,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  `max_file_size` int(11) NOT NULL DEFAULT 10485760,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

CREATE TABLE `file_info` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  `file_ident` varchar(255) NOT NULL,
  `uploaded_by` bigint(20) DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `upload_finished_at` datetime DEFAULT NULL,
  `file_name` varchar(500) DEFAULT NULL,
  `file_size` bigint(20) DEFAULT NULL,
  `content_type` varchar(255) DEFAULT NULL,
  `assignment_id` bigint(20) DEFAULT NULL,
  `object_key` varchar(512) DEFAULT NULL,
  `staging_key` varchar(512) DEFAULT NULL,
  `upload_state` varchar(20) NOT NULL DEFAULT 'ready',
  `upload_expires_at` datetime DEFAULT NULL,
  `object_etag` varchar(255) DEFAULT NULL,
  `published_at` datetime DEFAULT NULL,
  `upload_purpose` varchar(32) NOT NULL DEFAULT 'submission',
  `source_etag` varchar(255) DEFAULT NULL,
  `source_version` varchar(1024) DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

CREATE TABLE `submissions` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  `assignment_id` bigint(20) NOT NULL,
  `user_id` bigint(20) NOT NULL,
  `submit_time` datetime NOT NULL DEFAULT current_timestamp(),
  `status` int(11) NOT NULL DEFAULT 0,
  `score` double NOT NULL DEFAULT 0,
  `file_ident` varchar(255) DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  CONSTRAINT `CONSTRAINT_1` CHECK (`status` in (0,1))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

CREATE TABLE `user_sessions` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  `session_key` varchar(32) NOT NULL,
  `user_id` bigint(20) NOT NULL,
  `session_data` text DEFAULT NULL,
  `created_at` datetime DEFAULT current_timestamp(),
  `expires_at` datetime NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

CREATE TABLE `announcements` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  `title` varchar(255) NOT NULL,
  `content` text NOT NULL,
  `display` varchar(100) NOT NULL,
  `enable` tinyint(1) NOT NULL DEFAULT 1,
  `publish_date` datetime NOT NULL,
  `effective_until` datetime NOT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  `created_by` bigint(20) NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

CREATE TABLE `audit_logs` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  `user_id` bigint(20) NOT NULL,
  `username` varchar(150) NOT NULL,
  `user_role` int(11) NOT NULL,
  `action` varchar(50) NOT NULL,
  `resource_type` varchar(50) NOT NULL,
  `resource_id` bigint(20) DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `description` text NOT NULL,
  `old_values` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`old_values`)),
  `new_values` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`new_values`)),
  `ip_address` varchar(45) DEFAULT NULL,
  `user_agent` text DEFAULT NULL,
  `session_id` varchar(255) DEFAULT NULL,
  `affected_user_id` bigint(20) DEFAULT NULL,
  `course_id` bigint(20) DEFAULT NULL,
  `assignment_id` bigint(20) DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

CREATE TABLE `oauth_clients` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  `client_id` varchar(128) NOT NULL,
  `client_secret_hash` char(64) DEFAULT NULL,
  `name` varchar(255) NOT NULL,
  `redirect_uri` varchar(2048) NOT NULL,
  `allowed_scopes` text NOT NULL,
  `active` tinyint(1) NOT NULL DEFAULT 1,
  `created_by` bigint(20) DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

CREATE TABLE `oauth_authorization_codes` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  `code_hash` char(64) NOT NULL,
  `oauth_client_id` bigint(20) NOT NULL,
  `user_id` bigint(20) NOT NULL,
  `redirect_uri` varchar(2048) NOT NULL,
  `scopes` text NOT NULL,
  `code_challenge` varchar(255) DEFAULT NULL,
  `code_challenge_method` varchar(16) DEFAULT NULL,
  `expires_at` datetime NOT NULL,
  `used_at` datetime DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

CREATE TABLE `oauth_access_tokens` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  `token_hash` char(64) NOT NULL,
  `oauth_client_id` bigint(20) NOT NULL,
  `user_id` bigint(20) NOT NULL,
  `scopes` text NOT NULL,
  `expires_at` datetime NOT NULL,
  `revoked_at` datetime DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `last_used_at` datetime DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

CREATE TABLE `oauth_consents` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  `oauth_client_id` bigint(20) NOT NULL,
  `user_id` bigint(20) NOT NULL,
  `scopes` text NOT NULL,
  `granted_at` datetime NOT NULL DEFAULT current_timestamp(),
  `revoked_at` datetime DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

CREATE TABLE `oauth_access_token_course_grants` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  `access_token_id` bigint(20) NOT NULL,
  `course_id` bigint(20) NOT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

-- Explicit indexes, created before foreign keys so InnoDB does not add implicit duplicates.

CREATE UNIQUE INDEX `username` ON `users` (`username`);
CREATE INDEX `idx_courses_year_term` ON `courses` (`year`,`term`);
CREATE INDEX `idx_course_students_user_course` ON `course_students` (`user_id`,`course_id`);
CREATE UNIQUE INDEX `unique_course_student` ON `course_students` (`course_id`,`user_id`);
CREATE INDEX `user_id` ON `course_students` (`user_id`);
CREATE INDEX `idx_course_teachers_user_course` ON `course_teachers` (`user_id`,`course_id`);
CREATE UNIQUE INDEX `unique_course_teacher` ON `course_teachers` (`course_id`,`user_id`);
CREATE INDEX `user_id` ON `course_teachers` (`user_id`);
CREATE INDEX `idx_course_assistants_user_course` ON `course_assistants` (`user_id`,`course_id`);
CREATE UNIQUE INDEX `unique_course_assistant` ON `course_assistants` (`course_id`,`user_id`);
CREATE INDEX `user_id` ON `course_assistants` (`user_id`);
CREATE INDEX `creator_id` ON `assignments` (`creator_id`);
CREATE INDEX `idx_assignments_course` ON `assignments` (`course_id`);
CREATE INDEX `idx_assignments_published` ON `assignments` (`published`);
CREATE INDEX `idx_assignments_start_time` ON `assignments` (`start_time`);
CREATE INDEX `idx_assignments_due_time` ON `assignments` (`due_time`);
CREATE INDEX `idx_assignments_course_published_due_start` ON `assignments` (`course_id`,`published`,`due_time`,`start_time`);
CREATE UNIQUE INDEX `uniq_file_info_object_key` ON `file_info` (`object_key`);
CREATE UNIQUE INDEX `uniq_file_info_staging_key` ON `file_info` (`staging_key`);
CREATE INDEX `idx_file_info_state_expiry` ON `file_info` (`upload_state`, `upload_expires_at`, `id`);
CREATE UNIQUE INDEX `file_ident` ON `file_info` (`file_ident`);
CREATE INDEX `idx_file_info_uploaded_by` ON `file_info` (`uploaded_by`);
CREATE INDEX `idx_file_info_assignment_id` ON `file_info` (`assignment_id`);
CREATE INDEX `idx_file_info_upload_finished_created` ON `file_info` (`upload_finished_at`,`created_at`,`file_ident`);
CREATE UNIQUE INDEX `uniq_submissions_assignment_user` ON `submissions` (`assignment_id`,`user_id`);
CREATE INDEX `idx_submissions_assignment` ON `submissions` (`assignment_id`);
CREATE INDEX `idx_submissions_user` ON `submissions` (`user_id`);
CREATE INDEX `idx_submissions_status` ON `submissions` (`status`);
CREATE INDEX `idx_submissions_file` ON `submissions` (`file_ident`);
CREATE INDEX `idx_submissions_assignment_status_score` ON `submissions` (`assignment_id`,`status`,`score`);
CREATE INDEX `idx_submissions_assignment_submit_time` ON `submissions` (`assignment_id`,`submit_time`);
CREATE UNIQUE INDEX `uniq_user_sessions_session_key` ON `user_sessions` (`session_key`);
CREATE INDEX `idx_user_sessions_user_id` ON `user_sessions` (`user_id`);
CREATE INDEX `idx_user_sessions_expires_at` ON `user_sessions` (`expires_at`);
CREATE INDEX `idx_announcements_enable` ON `announcements` (`enable`);
CREATE INDEX `idx_announcements_publish_date` ON `announcements` (`publish_date`);
CREATE INDEX `idx_announcements_effective_until` ON `announcements` (`effective_until`);
CREATE INDEX `idx_announcements_created_by` ON `announcements` (`created_by`);
CREATE INDEX `idx_announcements_active` ON `announcements` (`enable`,`publish_date`,`effective_until`);
CREATE INDEX `idx_audit_logs_user_id` ON `audit_logs` (`user_id`);
CREATE INDEX `idx_audit_logs_action` ON `audit_logs` (`action`);
CREATE INDEX `idx_audit_logs_resource_type` ON `audit_logs` (`resource_type`);
CREATE INDEX `idx_audit_logs_resource_id` ON `audit_logs` (`resource_id`);
CREATE INDEX `idx_audit_logs_created_at` ON `audit_logs` (`created_at`);
CREATE INDEX `idx_audit_logs_affected_user_id` ON `audit_logs` (`affected_user_id`);
CREATE INDEX `idx_audit_logs_course_id` ON `audit_logs` (`course_id`);
CREATE INDEX `idx_audit_logs_assignment_id` ON `audit_logs` (`assignment_id`);
CREATE INDEX `idx_audit_logs_user_action_date` ON `audit_logs` (`user_id`,`action`,`created_at`);
CREATE INDEX `idx_audit_logs_resource_type_id` ON `audit_logs` (`resource_type`,`resource_id`);
CREATE UNIQUE INDEX `client_id` ON `oauth_clients` (`client_id`);
CREATE INDEX `created_by` ON `oauth_clients` (`created_by`);
CREATE UNIQUE INDEX `code_hash` ON `oauth_authorization_codes` (`code_hash`);
CREATE INDEX `user_id` ON `oauth_authorization_codes` (`user_id`);
CREATE INDEX `idx_oauth_authorization_codes_client_user` ON `oauth_authorization_codes` (`oauth_client_id`,`user_id`);
CREATE INDEX `idx_oauth_authorization_codes_expires_at` ON `oauth_authorization_codes` (`expires_at`);
CREATE UNIQUE INDEX `token_hash` ON `oauth_access_tokens` (`token_hash`);
CREATE INDEX `idx_oauth_access_tokens_client_user` ON `oauth_access_tokens` (`oauth_client_id`,`user_id`);
CREATE INDEX `idx_oauth_access_tokens_user_id` ON `oauth_access_tokens` (`user_id`);
CREATE INDEX `idx_oauth_access_tokens_expires_at` ON `oauth_access_tokens` (`expires_at`);
CREATE UNIQUE INDEX `unique_oauth_consent_user_client` ON `oauth_consents` (`oauth_client_id`,`user_id`);
CREATE INDEX `user_id` ON `oauth_consents` (`user_id`);
CREATE UNIQUE INDEX `unique_oauth_access_token_course` ON `oauth_access_token_course_grants` (`access_token_id`,`course_id`);
CREATE INDEX `idx_oauth_access_token_course_grants_course_id` ON `oauth_access_token_course_grants` (`course_id`);

-- Foreign keys use the indexes declared above.

ALTER TABLE `course_students` ADD CONSTRAINT `course_students_ibfk_1` FOREIGN KEY (`course_id`) REFERENCES `courses` (`id`) ON DELETE CASCADE;
ALTER TABLE `course_students` ADD CONSTRAINT `course_students_ibfk_2` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE;
ALTER TABLE `course_teachers` ADD CONSTRAINT `course_teachers_ibfk_1` FOREIGN KEY (`course_id`) REFERENCES `courses` (`id`) ON DELETE CASCADE;
ALTER TABLE `course_teachers` ADD CONSTRAINT `course_teachers_ibfk_2` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE;
ALTER TABLE `course_assistants` ADD CONSTRAINT `course_assistants_ibfk_1` FOREIGN KEY (`course_id`) REFERENCES `courses` (`id`) ON DELETE CASCADE;
ALTER TABLE `course_assistants` ADD CONSTRAINT `course_assistants_ibfk_2` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE;
ALTER TABLE `assignments` ADD CONSTRAINT `assignments_ibfk_1` FOREIGN KEY (`course_id`) REFERENCES `courses` (`id`) ON DELETE CASCADE;
ALTER TABLE `assignments` ADD CONSTRAINT `assignments_ibfk_2` FOREIGN KEY (`creator_id`) REFERENCES `users` (`id`) ON DELETE SET NULL;
ALTER TABLE `file_info` ADD CONSTRAINT `file_info_ibfk_1` FOREIGN KEY (`uploaded_by`) REFERENCES `users` (`id`) ON DELETE SET NULL;
ALTER TABLE `file_info` ADD CONSTRAINT `fk_file_info_assignment` FOREIGN KEY (`assignment_id`) REFERENCES `assignments` (`id`) ON DELETE SET NULL;
ALTER TABLE `submissions` ADD CONSTRAINT `submissions_ibfk_1` FOREIGN KEY (`assignment_id`) REFERENCES `assignments` (`id`) ON DELETE CASCADE;
ALTER TABLE `submissions` ADD CONSTRAINT `submissions_ibfk_2` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE;
ALTER TABLE `submissions` ADD CONSTRAINT `submissions_ibfk_3` FOREIGN KEY (`file_ident`) REFERENCES `file_info` (`file_ident`) ON DELETE SET NULL;
ALTER TABLE `user_sessions` ADD CONSTRAINT `user_sessions_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE;
ALTER TABLE `announcements` ADD CONSTRAINT `announcements_ibfk_1` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`) ON DELETE CASCADE;
ALTER TABLE `oauth_clients` ADD CONSTRAINT `oauth_clients_ibfk_1` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`) ON DELETE SET NULL;
ALTER TABLE `oauth_authorization_codes` ADD CONSTRAINT `oauth_authorization_codes_ibfk_1` FOREIGN KEY (`oauth_client_id`) REFERENCES `oauth_clients` (`id`) ON DELETE CASCADE;
ALTER TABLE `oauth_authorization_codes` ADD CONSTRAINT `oauth_authorization_codes_ibfk_2` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE;
ALTER TABLE `oauth_access_tokens` ADD CONSTRAINT `oauth_access_tokens_ibfk_1` FOREIGN KEY (`oauth_client_id`) REFERENCES `oauth_clients` (`id`) ON DELETE CASCADE;
ALTER TABLE `oauth_access_tokens` ADD CONSTRAINT `oauth_access_tokens_ibfk_2` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE;
ALTER TABLE `oauth_consents` ADD CONSTRAINT `oauth_consents_ibfk_1` FOREIGN KEY (`oauth_client_id`) REFERENCES `oauth_clients` (`id`) ON DELETE CASCADE;
ALTER TABLE `oauth_consents` ADD CONSTRAINT `oauth_consents_ibfk_2` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE;
ALTER TABLE `oauth_access_token_course_grants` ADD CONSTRAINT `oauth_access_token_course_grants_ibfk_1` FOREIGN KEY (`access_token_id`) REFERENCES `oauth_access_tokens` (`id`) ON DELETE CASCADE;
ALTER TABLE `oauth_access_token_course_grants` ADD CONSTRAINT `oauth_access_token_course_grants_ibfk_2` FOREIGN KEY (`course_id`) REFERENCES `courses` (`id`) ON DELETE CASCADE;
