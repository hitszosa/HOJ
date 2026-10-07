#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/../.."
exec python3 deploy/remote/release.py build "$@"
