#!/usr/bin/env bash
set -euo pipefail

usage() {
    echo "Usage: $0 IMAGE [--platform linux/amd64|linux/arm64] [--push]"
}
fail() { echo "Error: $*" >&2; exit 1; }

if [[ ${1:-} == --help || ${1:-} == -h ]]; then usage; exit 0; fi
if [[ $# -eq 0 || $1 == -* ]]; then usage >&2; exit 2; fi
image=$1
shift
platform=linux/amd64
push=false
while [[ $# -gt 0 ]]; do
    case "$1" in
        --platform)
            [[ $# -ge 2 ]] || fail "--platform requires a value"
            platform=$2
            shift 2
            ;;
        --push) push=true; shift ;;
        *) usage >&2; fail "Unknown argument: $1" ;;
    esac
done
case "$platform" in
    linux/amd64|linux/arm64) ;;
    *) fail "Unsupported platform: $platform" ;;
esac
[[ -n $image ]] || fail "IMAGE must not be empty"
command -v docker >/dev/null 2>&1 || fail "Missing prerequisite: docker"
docker buildx version >/dev/null
docker info >/dev/null

repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
base_image=${BASE_IMAGE:-debian:bookworm-slim}
# Use the local Docker image store, not a registry proxy or a remote builder.
# A preloaded official image also works when Docker Hub is unavailable.
local_platform=$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$base_image" 2>/dev/null || true)
if [[ $local_platform != "$platform" ]]; then
    docker pull --platform "$platform" "$base_image"
fi
context=$(mktemp -d "${TMPDIR:-/tmp}/grader-runtime.XXXXXX")
trap 'rm -rf -- "$context"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
cp "$repo/Dockerfile.runtime" "$context/Dockerfile"
docker buildx build --builder "$(docker context show)" --platform "$platform" --pull=false --load \
    --build-arg "BASE_IMAGE=$base_image" --tag "$image" "$context"
if $push; then docker push "$image"; fi
