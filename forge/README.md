# Forge — V1

A phone-accessible interface for sending tasks to a Claude Code–based
development Forge, with full observability of every execution: tokens,
inference time, cost, steps, errors, tools used.

V1 is deliberately narrow — orchestration, Claude Code execution, metrics,
and observability. No Vast.ai, no on-demand GPUs, no multi-model routing, no
auto-optimization. See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for
the full design and why it's scoped this way.

## Layout

```
packages/
  shared/      — TypeScript types every service imports (the contract)
  db/          — Postgres schema (Drizzle ORM) + migrations
  worker/      — drives Claude Code via the Claude Agent SDK; the "nervous system"
  api/         — Fastify HTTP API + Task Manager + SSE
  dashboard/   — static mobile-first dashboard (also the V1 mobile interface)
mobile/        — why there's no separate native app in V1, and what one would add
docs/
  ARCHITECTURE.md
  INSTALL.md
```

## Quick start

See [`docs/INSTALL.md`](docs/INSTALL.md).

## Status

This is the V1 scaffold: architecture + working "nervous system" (task
state machine, DB schema, Claude Code worker, LangSmith wiring, API, SSE,
dashboard). Some pieces are intentionally stubs — see
`packages/worker/src/runners/openhands.ts` and the "explicitly NOT in V1"
section of the architecture doc.
