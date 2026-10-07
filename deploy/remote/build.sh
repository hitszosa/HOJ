#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/../.."
args=(--network host --progress plain)
# A temporary build proxy is optional. Docker's pull proxy is configured separately.
if [[ -n ${HOJ_BUILD_PROXY:-} ]]; then
    args+=(--build-arg "HTTP_PROXY=$HOJ_BUILD_PROXY" --build-arg "HTTPS_PROXY=$HOJ_BUILD_PROXY"
           --build-arg "http_proxy=$HOJ_BUILD_PROXY" --build-arg "https_proxy=$HOJ_BUILD_PROXY")
fi
for service in core api management-api web management-web; do
    docker build "${args[@]}" -f "deploy/remote/Dockerfile.$service" -t "hoj-$service:amd64" .
done
docker build "${args[@]}" --build-arg GOPROXY=https://proxy.golang.org,direct \
    -f deploy/remote/Dockerfile.storage -t hoj-storage:amd64 .
