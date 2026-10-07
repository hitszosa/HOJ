-- Stop application writes and run migrate_upload_objects before this migration
-- when objects use anything other than their unchanged file_ident as the key.
-- Empty databases and direct-key SQLx imports need no object migration.
DROP TEMPORARY TABLE IF EXISTS `direct_uuid_storage_guard`;
CREATE TEMPORARY TABLE `direct_uuid_storage_guard` (
    `unmigrated` tinyint NOT NULL,
    CONSTRAINT `run_migrate_upload_objects_first` CHECK (`unmigrated` = 0)
);
INSERT INTO `direct_uuid_storage_guard` (`unmigrated`)
SELECT 1
WHERE EXISTS (
    SELECT 1 FROM `file_info`
    WHERE (`object_key` IS NOT NULL AND BINARY `object_key` <> BINARY `file_ident`)
       OR `staging_key` IS NOT NULL
       OR `upload_state` = 'finalizing'
);
DROP TEMPORARY TABLE `direct_uuid_storage_guard`;

ALTER TABLE `file_info`
    DROP INDEX `uniq_file_info_object_key`,
    DROP INDEX `uniq_file_info_staging_key`,
    DROP COLUMN `object_key`,
    DROP COLUMN `staging_key`,
    DROP COLUMN `object_etag`,
    DROP COLUMN `published_at`,
    DROP COLUMN `source_etag`,
    DROP COLUMN `source_version`;
