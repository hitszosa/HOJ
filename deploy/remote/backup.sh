#!/bin/bash
# Back up only this deployment. Keep backups on this host until copied elsewhere.
set -euo pipefail
cd "$(dirname "$0")/../.."
umask 077
mkdir -p backups
stamp=$(date +%Y%m%d-%H%M%S)
docker compose --env-file .env -f deploy/remote/compose.yml exec -T db sh -c \
    'MYSQL_PWD="$MARIADB_ROOT_PASSWORD" mariadb-dump -uroot --lock-all-tables --databases jol codemind_course grader' \
    | gzip > "backups/databases-$stamp.sql.gz.tmp"
mv "backups/databases-$stamp.sql.gz.tmp" "backups/databases-$stamp.sql.gz"
tar -czf "backups/files-$stamp.tar.gz" .env admin-account.json data/judge data/course-local data/objects
printf 'Backup completed: %s\n' "$stamp"
