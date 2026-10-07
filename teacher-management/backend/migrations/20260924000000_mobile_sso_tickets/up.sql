CREATE TABLE mobile_sso_tickets (
    session_id BIGINT NOT NULL PRIMARY KEY,
    ticket_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    expires_at DATETIME NOT NULL,
    UNIQUE KEY uniq_mobile_sso_ticket_hash (ticket_hash),
    CONSTRAINT fk_mobile_sso_ticket_session FOREIGN KEY (session_id)
        REFERENCES user_sessions (id) ON DELETE CASCADE
) ENGINE=InnoDB;
