# Forge V1 — Architecture

## Goal

A phone-accessible interface that sends tasks to a Claude Code–based development
Forge, with complete observability of every execution: tokens, inference time,
cost, steps, errors, tools used.

**V1 scope is deliberately narrow.** No Vast.ai, no on-demand GPUs, no
multi-model routing, no auto-optimization. This is the nervous system and the
dashboard — everything else stacks on top of it later.

## Components

```
Mobile Interface (responsive web / PWA-lite)
        │  HTTPS + SSE
        ▼
API Backend (Fastify)
        │  enqueues
        ▼
Task Manager (state machine, in the API process for V1)
        │  dispatches
        ▼
Claude Code Worker (Node process, polls/consumes a job queue)
        │  spawns
        ▼
Claude Agent SDK → Claude Code, against a checked-out repo
        │  every event
        ▼
LangSmith (trace per task run)  +  Postgres (durable metrics)
```

Six components, matching the brief:

1. **Mobile Interface** — a mobile-first static page (`packages/dashboard`), not
   a native app. Talks to the API over HTTPS, subscribes to Server-Sent Events
   for live task progress. This is the pragmatic V1 answer to "notifications":
   push-to-phone (APNs/FCM) needs its own app-signing and credential setup that's
   out of scope for V1; SSE gives the same live-update experience inside a
   browser tab, including one added to the home screen as a PWA.
2. **API Backend** — Fastify HTTP server. Owns the REST surface
   (`POST /tasks`, `GET /tasks`, `GET /tasks/:id`, `GET /tasks/:id/events`,
   `GET /stats`) and the SSE fan-out for live updates.
3. **Task Manager** — the state machine described below. Runs inside the API
   process for V1 (no separate queue service) — a task write is a row insert,
   dispatch is an in-process call to the worker's `runTask()`. This is the
   "clean base that can evolve later": swapping in a real queue (BullMQ,
   SQS, etc.) later means changing the dispatch call, not the state machine.
4. **Claude Code Worker** — spawns Claude Code via `@anthropic-ai/claude-agent-sdk`
   against a checked-out repo, and turns every SDK event into a
   `TaskEvent` + a durable row in Postgres. This is the piece the whole
   system exists to observe.
5. **Database** — Postgres via Drizzle ORM. Schema below.
6. **Observability Layer** — LangSmith. One LangSmith **run** (with child
   runs for LLM calls, thinking, and tool calls) per Forge task. The
   Postgres tables are the durable, queryable copy of the same numbers —
   LangSmith is for tracing/debugging a single run, Postgres is for
   dashboards and history.

## Task lifecycle

```
CREATED → ANALYZING → EXECUTING → TESTING → COMPLETED
                                          ↘ FAILED
```

| Status | Meaning |
|---|---|
| `CREATED` | Row inserted, not yet picked up by a worker. |
| `ANALYZING` | Worker has claimed the task, Claude Code session is starting (system/init received). |
| `EXECUTING` | Claude Code is actively working — tool calls, file edits, assistant turns. |
| `TESTING` | Heuristic: the worker saw a test-runner command (`npm test`, `pytest`, …) execute. Best-effort signal, not a hard phase boundary — Claude Code doesn't have a distinct "testing mode." |
| `COMPLETED` | Claude Code session ended cleanly (`result` message, no error). |
| `FAILED` | Non-zero exit, budget exceeded, or an error surfaced mid-run. |

A task can have more than one **run** — a run is one attempt (one Claude Code
session). V1 doesn't auto-retry, but the schema supports it (`runs.attempt_number`)
so retry logic is additive later, not a schema migration.

## Data model

```
projects
  id, name, repo_url, default_branch, created_at

tasks
  id, user_id, project_id → projects, prompt, status, progress,
  created_at, updated_at, started_at, completed_at, duration_ms,
  result, error_message

runs                              -- one Claude Code session attempt
  id, task_id → tasks, attempt_number, status,
  claude_session_id,              -- Claude Code's own session_id, for --resume
  langsmith_run_id, langsmith_trace_url,
  started_at, completed_at, duration_ms, error_message

model_usage                       -- one row per LLM call inside a run
  id, run_id → runs, model, input_tokens, output_tokens,
  cache_creation_input_tokens, cache_read_input_tokens,
  duration_ms, cost_usd, created_at

tool_usage                        -- one row per tool call inside a run
  id, run_id → runs, tool_name, input, output,
  started_at, duration_ms, success, error_message

errors                            -- one row per error surfaced anywhere
  id, run_id → runs, task_id → tasks, message, stack, occurred_at
```

`tasks` carries the summary (what the dashboard's task list needs);
`runs`/`model_usage`/`tool_usage`/`errors` carry the detail (what the
per-task timeline view needs). This split is why `ctx_adaptive_rag`-style
"just query everything from one table" doesn't work here — the list view
and the detail view have different cost profiles, and V1 keeps them as
different queries against normalized tables rather than one wide
denormalized row.

## Claude Code integration

The worker drives Claude Code via the **Claude Agent SDK**
(`@anthropic-ai/claude-agent-sdk`), not by shelling out to the `claude` CLI
and parsing stdout — the SDK's `query()` async generator yields typed
message objects (`system`, `assistant`, `user`, `result`, and, with
`includePartialMessages: true`, `stream_event`), so there's no
newline-JSON parsing to get wrong.

```ts
for await (const message of query({
  prompt: task.prompt,
  options: {
    model: "sonnet",
    cwd: repoPath,
    permissionMode: "acceptEdits",   // see Permission mode below
    includePartialMessages: true,
  },
})) {
  // route each message into a TaskEvent + a DB row + a LangSmith child run
}
```

Every message becomes:

- a **`TaskEvent`** broadcast over SSE (dashboard renders it live),
- a **DB row** if it carries metrics (`assistant` with token usage →
  `model_usage`; a tool call → `tool_usage`; `result` → close out the
  `runs` row),
- a **LangSmith child run** (LLM call, tool call) under the task's run.

### Permission mode — a real decision, not a default to skip past

Headless mode has no human to answer an approval prompt, so
`permissionMode` can't be left at its interactive default or the worker
hangs forever on the first tool call. Two modes actually work
non-interactively:

- **`acceptEdits`** (V1 default) — file edits are auto-approved; other
  prompts may still block. Safer, but can still hang on an edge case.
- **`bypassPermissions`** — full autonomy, nothing blocks. Only ever run
  this inside an isolated container with no access to secrets or networks
  it shouldn't reach — it removes every guardrail Claude Code has.

This is set via `CLAUDE_CODE_PERMISSION_MODE` in the worker's environment
(`packages/worker/.env`), not hardcoded, precisely so the operator makes
this call deliberately per-deployment rather than inheriting a silent
default.

### What's explicitly NOT in V1

- **Vast.ai / on-demand GPUs** — the worker runs Claude Code against the
  Anthropic API; there's no local model to host.
- **Multi-model routing** — one model, set via `CLAUDE_CODE_MODEL` env var.
- **Auto-optimization** — no automatic retry-with-cheaper-model, no
  self-tuning effort levels. The dashboard shows you the numbers; a human
  decides what to change.
- **OpenHands runner** — the worker's `Runner` interface
  (`packages/worker/src/runners/types.ts`) is designed to hold a second
  implementation, and a stub file exists, but it is not implemented. Wiring
  a real OpenHands runner needs its own research pass (different process
  model — Docker-based — and a different event shape) rather than guessing
  at its CLI surface.
- **Real push notifications** — see Mobile Interface above; SSE instead of
  APNs/FCM for V1.

## Observability layer — LangSmith

One LangSmith run per Forge **run** (not per task — a retried task gets a
new LangSmith run per attempt, same as it gets a new `runs` row). Child
runs are created for each significant SDK event (LLM turn, tool call) so
LangSmith's trace view mirrors the Postgres `tool_usage`/`model_usage`
tables — same events, two destinations, one for interactive trace
debugging, one for durable dashboards/history.

```
LangSmith run (root, run_type="chain")
  name: task.prompt (truncated)
  metadata: { taskId, projectId, forgeVersion }
├─ child run (run_type="llm")   — one per assistant turn with token usage
├─ child run (run_type="tool")  — one per tool_use / tool_result pair
└─ child run (run_type="tool")  — ...
```

`packages/worker/src/langsmith.ts` wraps the `langsmith` npm package's
`Client` (`createRun` / `updateRun`) behind a small interface
(`startRunTrace`, `logModelUsage`, `logToolCall`, `endRunTrace`) so the
rest of the worker never touches the LangSmith SDK directly — if
LangSmith's API shape drifts, one file changes.

`LANGSMITH_API_KEY` unset → the wrapper no-ops (logs a warning once) rather
than crashing the worker. Postgres metrics keep working with or without
LangSmith; LangSmith is additive tracing, not a hard dependency for V1.

### The phone never talks to LangSmith directly

Two reasons: it would put the `LANGSMITH_API_KEY` in the browser, and
LangSmith's API isn't set up for cross-origin browser calls. So the read
path is **server-side**, in `packages/api/src/langsmith-read.ts`: the Forge
API queries LangSmith (`client.listRuns`, correlating back to Forge tasks by
the `extra.metadata.taskId` the worker stamps on each root run) and hands the
phone plain JSON. The key stays on the server.

Division of labour between the two stores:

- **Postgres is the authoritative, queryable mirror** — written in the same
  code path as the traces, so it always has the full input/output/cache
  split and aggregates fast. It's the default source for the dashboard's
  numbers.
- **LangSmith is the trace viewer** — every task row carries a
  `langsmith_trace_url`, so one tap on the phone opens the complete trace
  (every LLM call, tool, timing) in LangSmith. Set
  `FORGE_METRICS_SOURCE=langsmith` to *also* source the actual-token totals
  from LangSmith (with a Postgres fallback if it's unreachable) — useful to
  confirm the two agree. The dashboard shows which source served the numbers.

> A note on why this is a real web app and not a claude.ai Artifact: an
> Artifact runs under a strict CSP that blocks all external network requests,
> so it can never fetch a self-hosted Forge API or LangSmith. The polished
> Artifact was the design mockup; this PWA is the live client.

## Estimate vs actual — where the "estimate" comes from

The headline comparison needs a real *estimate*, computed before any run
exists. `packages/shared/src/estimate.ts` (`estimateTask`) does this at
task-creation time from the prompt size and a per-model agentic profile, and
the API stores it on the task (`estimated_input_tokens` /
`estimated_output_tokens`). It's deliberately a rough heuristic — the whole
dashboard exists to surface how far it drifts from reality per task, so you
can recalibrate the profile constants from the very `model_usage` history the
dashboard exposes. Measure drift → tune the estimator → measure again: that
loop is the point.

## Dashboard — the mobile PWA

The mobile client (`packages/dashboard/public/index.html`) is a real
installable PWA — mobile-first, no build step, vanilla JS +
`fetch`/`EventSource`, service worker for an offline shell. It both
**visualizes** and **pilots** the Forge:

- **Pilot** — a composer posts `POST /tasks` (with a live client-side
  estimate preview), then subscribes to `GET /tasks/:id/events` (SSE) and
  shows the run's status, progress, tool calls, and token usage streaming in
  live. This is the "notifications mobile" experience without APNs/FCM.
- **Visualize** — one read, `GET /dashboard?range=N`, returns everything the
  telemetry views render: per-task estimate vs actual, per-task variance,
  token composition by model, cost, and the LangSmith trace link. Estimate
  vs actual is the centerpiece; the design pulls its palette from steel
  tempering colors (blueprint-blue estimate vs molten-amber actual — also
  colorblind-safe, validated).

Endpoints backing it: `POST /tasks`, `GET /dashboard`, `GET /tasks/:id/events`
(SSE), plus `GET /tasks`, `GET /tasks/:id`, `GET /stats` from V1's core.
`@fastify/cors` lets the phone (served from a different origin, or the
home-screen app) reach the API; lock it down with `FORGE_CORS_ORIGIN` before
exposing it beyond your LAN.

## Why this shape evolves cleanly

- **Task Manager in-process → real queue**: `TaskManager.dispatch()` is the
  one place that currently calls the worker directly. Swapping to BullMQ/SQS
  means this function publishes a job instead of calling
  `runner.run()` — nothing else in the API or worker changes.
- **One model → multi-model routing**: the worker's `Runner` interface takes
  `model` as an option already; a router would decide which `model` to pass,
  not restructure the worker.
- **Local Claude Code → Vast.ai GPUs**: only relevant if/when a local-model
  runner is added — it would be a new `Runner` implementation, same
  interface as Claude Code and (eventually) OpenHands.
- **No auto-optimization → auto-optimization**: the metrics this system
  captures (tokens, cost, duration, tool success rate per task) are exactly
  what an optimizer would need as its input signal. V1 deliberately builds
  the measurement first.
