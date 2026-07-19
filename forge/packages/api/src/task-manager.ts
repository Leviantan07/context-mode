/**
 * The Task Manager from docs/ARCHITECTURE.md. In V1 this is deliberately
 * thin: creating a task is a row insert, dispatching it is a direct
 * in-process call into @forge/worker. The state machine itself lives in
 * executeTask() (packages/worker/src/execute-task.ts) — this file's job is
 * just "own the create+dispatch entrypoint the routes call."
 */
import { getDb, schema } from "@forge/db";
import { executeTask } from "@forge/worker";
import { estimateTask, type CreateTaskRequest, type Task } from "@forge/shared";
import { publish } from "./event-bus.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export async function createTask(req: CreateTaskRequest): Promise<Task> {
  const db = getDb();

  // Compute the pre-run estimate now, before any run exists — this is the
  // "estimé" the dashboard compares against actual consumption.
  const estimate = estimateTask({ prompt: req.prompt, model: process.env.CLAUDE_CODE_MODEL });

  const [row] = await db
    .insert(schema.tasks)
    .values({
      userId: req.userId ?? "default",
      projectId: req.projectId,
      prompt: req.prompt,
      status: "CREATED",
      estimatedInputTokens: estimate.estimatedInputTokens,
      estimatedOutputTokens: estimate.estimatedOutputTokens,
    })
    .returning();

  const task = toDomainTask(row);

  // Fire-and-forget: the HTTP response returns the CREATED task immediately;
  // progress streams over SSE from here on. Errors inside executeTask are
  // caught internally and turned into a FAILED task + an `errors` row, not
  // an unhandled rejection.
  // V1 simplification: one fixed repo checkout for every task, via
  // FORGE_REPO_PATH. Per-project checkouts (cloning `projects.repo_url` on
  // demand) is the natural next step but adds real complexity (concurrent
  // checkouts, cleanup, auth) that's out of scope for the scaffold.
  void executeTask({
    taskId: task.id,
    projectId: task.projectId,
    prompt: task.prompt,
    repoPath: requireEnv("FORGE_REPO_PATH"),
    onEvent: (event) => {
      publish(event);
    },
  });

  return task;
}

export function toDomainTask(row: typeof schema.tasks.$inferSelect): Task {
  return {
    id: row.id,
    userId: row.userId,
    projectId: row.projectId,
    prompt: row.prompt,
    status: row.status as Task["status"],
    progress: row.progress,
    estimatedInputTokens: row.estimatedInputTokens,
    estimatedOutputTokens: row.estimatedOutputTokens,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    durationMs: row.durationMs,
    result: row.result,
    errorMessage: row.errorMessage,
  };
}
