#!/usr/bin/env bash
# One-time Codespace bootstrap (postCreateCommand): generate forge/.env from
# the Codespaces environment, bring up Postgres, apply migrations, then
# build and start the API. See forge/docs/INSTALL.md -> "GitHub Pages +
# Codespaces" for the account-level setup this depends on (Codespaces
# secrets, repo Pages source).
set -euo pipefail
cd "$(dirname "$0")/.."   # -> forge/

if [ ! -f .env ]; then
  cp .env.example .env
fi

# Codespaces mounts the repo at /workspaces/<repo-name> — point the worker
# at the checkout it's already running inside, no volume-mount juggling.
sed -i "s#^FORGE_REPO_PATH=.*#FORGE_REPO_PATH=/workspaces/context-mode#" .env

# ANTHROPIC_API_KEY / LANGSMITH_API_KEY: set as Codespaces secrets (repo or
# personal, in GitHub Settings -> Codespaces) and they land in this shell's
# environment automatically — pull them into .env for docker compose's
# env_file to pick up.
if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
  sed -i "s#^ANTHROPIC_API_KEY=.*#ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}#" .env
fi
if [ -n "${LANGSMITH_API_KEY:-}" ]; then
  sed -i "s#^LANGSMITH_API_KEY=.*#LANGSMITH_API_KEY=${LANGSMITH_API_KEY}#" .env
fi

docker compose up -d postgres

echo "Waiting for Postgres..."
until docker compose exec -T postgres pg_isready -U forge >/dev/null 2>&1; do
  sleep 1
done

npm install
DATABASE_URL="postgres://forge:forge@localhost:5432/forge" npm run db:migrate

docker compose up -d --build api

echo ""
if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  echo "WARNING: ANTHROPIC_API_KEY was not set in this Codespace's environment."
  echo "  Set it as a Codespaces secret (GitHub -> Settings -> Codespaces -> Secrets),"
  echo "  then rebuild the container, OR edit forge/.env by hand and run:"
  echo "    cd forge && docker compose up -d --build api"
else
  echo "Forge API is starting on port 8787 (forwarded publicly by Codespaces)."
fi
echo "Check the 'Ports' tab for the forwarded URL — that's what the dashboard's"
echo "first-load prompt (forge_api_base) should point to."
