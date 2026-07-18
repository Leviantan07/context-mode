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

## Known gaps in this scaffold (see docs/ARCHITECTURE.md for why)

- One fixed repo (`FORGE_REPO_PATH`) for every task — no per-project checkout.
- `openHandsRunner` throws — Claude Code is the only working runner.
- No auth on the API — anyone who can reach `:8787` can create tasks.
  Fine for local/LAN use; add real auth before exposing this to the internet.
