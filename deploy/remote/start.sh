#!/bin/bash
# Run as root from /opt/hoj after creating .env, init SQL and building images.
set -euo pipefail
cd "$(dirname "$0")/../.."
test -f .env
compose=(docker compose --env-file .env -f deploy/remote/compose.yml)
"${compose[@]}" up -d --wait --wait-timeout 120 db storage
"${compose[@]}" run --rm --no-deps management-api migrate
"${compose[@]}" run --rm --no-deps management-api init-storage
"${compose[@]}" up -d --wait --wait-timeout 120
for url in http://127.0.0.1:8100/api/health http://127.0.0.1:8101/healthz http://127.0.0.1:3100/management/login; do
    curl -fsS --retry 10 --retry-connrefused --retry-delay 1 "$url" >/dev/null
done
"${compose[@]}" ps --format '{{.Service}} {{.State}} {{.Health}}'
