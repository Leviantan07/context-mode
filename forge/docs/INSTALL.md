# Installation — V1

## Prerequisites

- Node.js ≥ 20
- Docker (for Postgres, or run Postgres yourself)
- An Anthropic API key (or an `ant auth login` profile — see the Claude API
  skill's auth notes; the Claude Agent SDK resolves credentials the same way)
- A LangSmith API key — optional, tracing no-ops without it

## Setup

```bash
cd forge
cp .env.example .env
# edit .env: ANTHROPIC_API_KEY, FORGE_REPO_PATH (a real repo checkout on disk), LANGSMITH_API_KEY

npm install   # installs all workspace packages
```

(`package-lock.json` isn't committed — the repo's root `.gitignore` excludes it
everywhere, matching context-mode's own bun-lock convention. `npm install`
regenerates it locally; that's expected.)

## Database

```bash
docker compose up -d postgres

npm run db:migrate    # applies the checked-in migration (packages/db/migrations/0000_*.sql)
```

If you change `packages/db/src/schema.ts`, regenerate before migrating:

```bash
npm run db:generate   # diffs the schema, writes a new migration file
npm run db:migrate
```

## Run

Two processes, both dev-mode (tsx, no build step):

```bash
npm run dev:api      # Fastify API on :8787 — also drives the worker in-process
```

(There's no separate `dev:worker` process to start in V1 — the API calls
`executeTask()` directly. `packages/worker/src/worker.ts` is a placeholder
for when dispatch moves to a real queue; see docs/ARCHITECTURE.md.)

Dashboard:

```bash
cd packages/dashboard && npm run dev   # serves public/ on :5173
```

Open `http://localhost:5173`, set the API base URL to `http://localhost:8787`
when prompted (stored in `localStorage`, only asked once). On a phone, use
your machine's LAN IP instead of `localhost` and "Add to Home Screen."

## Docker Compose (API + Postgres)

```bash
docker compose up --build
```

Mounts `FORGE_REPO_PATH` (from `.env`) into the API container at `/repo` —
set `FORGE_REPO_PATH=/repo` in `.env` when running this way, since the path
inside the container differs from the host path used in local dev.

## Verifying the install

```bash
curl http://localhost:8787/health
curl -X POST http://localhost:8787/tasks \
  -H 'content-type: application/json' \
  -d '{"prompt": "List the files in this repo"}'
```

Watch it run either in the dashboard (open the task it just created) or via
`curl -N http://localhost:8787/tasks/<id>/events` for the raw SSE stream.

## Mobile access: GitHub Pages + Codespaces (no local/LAN machine needed)

For using the dashboard from a phone without keeping a machine on the same
WiFi running Forge, split the two halves across two GitHub-only services:
the **dashboard** (static) on GitHub Pages, always reachable; the **API +
Postgres** (dynamic) in a **Codespace**, which sleeps after ~30 min idle and
needs a manual wake before use — see `../mobile/README.md` for that tradeoff.

**One-time setup:**

1. Repo Settings → Pages → Build and deployment → Source: **GitHub Actions**.
   (The `.github/workflows/forge-dashboard-pages.yml` workflow needs this to
   have anywhere to publish to.)
2. Repo Settings → Secrets and variables → **Codespaces** → add
   `ANTHROPIC_API_KEY` (and `LANGSMITH_API_KEY` if you want tracing). These
   land in the Codespace's shell environment automatically and get folded
   into `forge/.env` by `.devcontainer/setup.sh`.
3. Push to a branch the Pages workflow watches (or run it manually via
   Actions → "Deploy Forge Dashboard to Pages" → Run workflow) to publish
   the dashboard once. Its URL is under repo Settings → Pages.

**Each time you want to use it:**

1. Code → Codespaces → Create codespace (or resume an existing one) on the
   branch with this scaffold. First creation runs `.devcontainer/setup.sh`
   automatically: installs deps, starts Postgres, applies migrations, builds
   and starts the API — takes a few minutes the first time, seconds after.
2. Open the **Ports** tab, copy the forwarded URL for port 8787 (already set
   to public visibility by `devcontainer.json`, no manual toggle needed).
3. Open the GitHub Pages URL from step 3 above on your phone, paste that
   port-8787 URL when prompted for the API base, "Add to Home Screen."
4. If the Codespace went idle and slept, resume it from
   github.com/codespaces (works from a phone browser) before using the
   dashboard again — `.devcontainer/start.sh` brings Postgres + the API back
   up automatically on resume.

This needs the CORS fix in `packages/api/src/server.ts` (`@fastify/cors`,
`origin: true`) since the dashboard and API are on different origins here —
already wired in.

## Known gaps in this scaffold (see docs/ARCHITECTURE.md for why)

- One fixed repo (`FORGE_REPO_PATH`) for every task — no per-project checkout.
- `openHandsRunner` throws — Claude Code is the only working runner.
- No auth on the API, and CORS now allows any origin — anyone who can reach
  the API URL can create tasks. Fine for local/LAN/personal-Codespace use;
  add real auth before exposing this more broadly.
