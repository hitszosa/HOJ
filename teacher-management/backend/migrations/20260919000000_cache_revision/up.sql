CREATE TABLE cache_revision (
    id INT NOT NULL PRIMARY KEY,
    revision VARCHAR(36) NOT NULL
) ENGINE=InnoDB;

INSERT INTO cache_revision (id, revision) VALUES (1, UUID());
