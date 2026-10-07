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
    linux/amd64) target=x86_64-unknown-linux-gnu ;;
    linux/arm64) target=aarch64-unknown-linux-gnu ;;
    *) fail "Unsupported platform: $platform" ;;
esac
[[ -n $image ]] || fail "IMAGE must not be empty"
for command in cargo cargo-zigbuild rustc zig cc docker git; do
    command -v "$command" >/dev/null 2>&1 || fail "Missing prerequisite: $command (see README.md)"
done
docker buildx version >/dev/null
docker info >/dev/null

repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$repo"
revision=$(git rev-parse HEAD)
dirty=false
if [[ -n $(git status --porcelain --untracked-files=normal) ]]; then dirty=true; fi
if $push && $dirty; then fail "--push requires a clean Git worktree; commit source changes first"; fi

# Pin one host cache directory for both Cargo output and packaging, including
# relative CARGO_TARGET_DIR overrides. Never copy the repository into Docker.
export CARGO_TARGET_DIR=${CARGO_TARGET_DIR:-"$repo/target"}
case "$CARGO_TARGET_DIR" in
    /*) ;;
    *) export CARGO_TARGET_DIR="$repo/$CARGO_TARGET_DIR" ;;
esac
cargo zigbuild --release --locked --bins --target "$target.2.36"
if [[ -n $(git status --porcelain --untracked-files=normal) || $(git rev-parse HEAD) != "$revision" ]]; then
    dirty=true
fi
if $push && $dirty; then fail "Git source changed during compilation; refusing to publish"; fi

context=$(mktemp -d "${TMPDIR:-/tmp}/grader-image.XXXXXX")
trap 'rm -rf -- "$context"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
mkdir "$context/bin"
cp Dockerfile "$context/Dockerfile"
for binary in grader-backend register_oauth_client migrate_upload_objects; do
    source="$CARGO_TARGET_DIR/$target/release/$binary"
    [[ -x $source ]] || fail "Missing built executable: $source"
    cp "$source" "$context/bin/$binary"
done
runtime_image=${RUNTIME_IMAGE:-harbor.osa.moe/grader/backend-runtime:bookworm-${platform#linux/}}
echo "Packaging $image ($platform), Git $revision, source dirty=$dirty"
docker buildx build --builder "$(docker context show)" --platform "$platform" --load \
    --build-arg "RUNTIME_IMAGE=$runtime_image" \
    --label "org.opencontainers.image.revision=$revision" \
    --label "io.grader.source.dirty=$dirty" \
    --tag "$image" "$context"
if $push; then docker push "$image"; fi
