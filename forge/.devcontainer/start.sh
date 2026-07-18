#!/usr/bin/env bash
# Runs on every Codespace resume (postStartCommand) — idempotent, just
# brings the already-built services back up after the container slept.
# Heavy lifting (install, migrate, first build) lives in setup.sh, which
# only runs once on creation.
set -euo pipefail
cd "$(dirname "$0")/.."   # -> forge/

if [ -f .env ]; then
  docker compose up -d
fi
