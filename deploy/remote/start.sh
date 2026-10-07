#!/bin/bash
# Run as root from /opt/hoj after creating .env, init SQL and building images.
set -euo pipefail
cd "$(dirname "$0")/../.."
test -f .env
manifest=${1:-"releases/$(git rev-parse HEAD)/release.json"}
test -f "$manifest" || { printf 'Release manifest not found: %s\n' "$manifest" >&2; exit 1; }
override=$(python3 deploy/remote/release.py config "$manifest")
compose=(docker compose --env-file .env -f deploy/remote/compose.yml -f "$override")
if python3 -c 'import json,sys; sys.exit(json.load(open(sys.argv[1]))["status"] != "published")' "$manifest"; then
    "${compose[@]}" pull
fi
# Built releases have already passed image-ID checks; published releases use digests.
# Never fall back to pulling mutable compatibility tags while starting services.
"${compose[@]}" up -d --pull never --wait --wait-timeout 120 db storage
"${compose[@]}" run --rm --no-deps --pull never management-api migrate
"${compose[@]}" run --rm --no-deps --pull never management-api init-storage
"${compose[@]}" up -d --pull never --wait --wait-timeout 120
for url in http://127.0.0.1:8100/api/health http://127.0.0.1:8101/healthz http://127.0.0.1:3100/management/login; do
    curl -fsS --retry 10 --retry-connrefused --retry-delay 1 "$url" >/dev/null
done
"${compose[@]}" ps --format '{{.Service}} {{.State}} {{.Health}}'
