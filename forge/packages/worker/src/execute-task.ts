/**
 * Orchestrates one task execution: claims a `runs` row, drives a Runner,
 * and turns every RunnerEvent into (a) a durable Postgres row, (b) a
 * LangSmith child run, and (c) a TaskEvent handed to the caller — the API
 * uses that last one to fan out over SSE. This is the "system nerveux"
 * the V1 brief asks for: every step of a task is captured here, in one
 * place, before it reaches any dashboard.
 *
 * V1 calls this in-process from the API (see docs/ARCHITECTURE.md — Task
 * Manager). Swapping to a real job queue later means a queue worker calls
 * this same function instead of the API calling it directly; nothing in
 * here changes.
 */
import { eq, count } from "drizzle-orm";
import { getDb, schema } from "@forge/db";
import type { TaskEvent, TaskStatus, ModelUsage, ToolUsage } from "@forge/shared";
import type { Runner } from "./runners/types.js";
import { claudeCodeRunner } from "./runners/claude-code.js";
import { startRunTrace, logModelUsage, logToolCall, endRunTrace } from "./langsmith.js";

const TEST_COMMAND_RE = /\b(npm test|npm run test|pytest|jest|vitest|go test|cargo test|rspec|mvn test)\b/i;

export interface ExecuteTaskParams {
  taskId: string;
  projectId: string | null;
  prompt: string;
  /** Absolute path to the checked-out repo the runner should operate in. */
  repoPath: string;
  runner?: Runner;
  onEvent?: (event: TaskEvent) => void | Promise<void>;
}

export async function executeTask(params: ExecuteTaskParams): Promise<void> {
  const db = getDb();
  const runner = params.runner ?? claudeCodeRunner;
  const emit = params.onEvent ?? (() => {});

  const [{ value: existingRuns }] = await db
    .select({ value: count() })
    .from(schema.runs)
    .where(eq(schema.runs.taskId, params.taskId));

  const [run] = await db
    .insert(schema.runs)
    .values({
      taskId: params.taskId,
      attemptNumber: existingRuns + 1,
      status: "ANALYZING" satisfies TaskStatus,
    })
    .returning();

  await setTaskStatus(params.taskId, "ANALYZING", emit, { startedAt: new Date() });

  const trace = await startRunTrace({
    taskId: params.taskId,
    projectId: params.projectId,
    prompt: params.prompt,
  });
  if (trace) {
    await db
      .update(schema.runs)
      .set({ langsmithRunId: trace.runId, langsmithTraceUrl: trace.traceUrl ?? undefined })
      .where(eq(schema.runs.id, run.id));
  }

  let toolCallCount = 0;

  try {
    await runner.run({
      prompt: params.prompt,
      cwd: params.repoPath,
      onEvent: async (event) => {
        switch (event.type) {
          case "session_start": {
            await db.update(schema.runs).set({ claudeSessionId: event.sessionId }).where(eq(schema.runs.id, run.id));
            await setTaskStatus(params.taskId, "EXECUTING", emit, { progress: 15 });
            break;
          }

          case "assistant_text": {
            await emit({
              taskId: params.taskId,
              type: "assistant_text",
              timestamp: new Date().toISOString(),
              text: event.text,
            });
            break;
          }

          case "tool_call": {
            toolCallCount += 1;
            const [row] = await db
              .insert(schema.toolUsage)
              .values({
                runId: run.id,
                toolName: event.toolName,
                input: event.input as object,
                output: event.output as object,
                durationMs: event.durationMs ?? undefined,
                success: event.success,
                errorMessage: event.errorMessage,
              })
              .returning();
            const toolUsage = toDomainToolUsage(row);
            await logToolCall(trace, toolUsage);

            if (TEST_COMMAND_RE.test(String(event.input ?? ""))) {
              await setTaskStatus(params.taskId, "TESTING", emit, { progress: 85 });
            } else {
              await setTaskStatus(params.taskId, "EXECUTING", emit, {
                progress: Math.min(15 + toolCallCount * 5, 80),
              });
            }

            await emit({
              taskId: params.taskId,
              type: "tool_call",
              timestamp: new Date().toISOString(),
              tool: toolUsage,
            });
            if (!event.success) {
              await db.insert(schema.errors).values({
                runId: run.id,
                taskId: params.taskId,
                message: event.errorMessage ?? `tool ${event.toolName} failed`,
              });
            }
            break;
          }

          case "model_usage": {
            const [row] = await db
              .insert(schema.modelUsage)
              .values({
                runId: run.id,
                model: event.model,
                inputTokens: event.inputTokens,
                outputTokens: event.outputTokens,
                cacheCreationInputTokens: event.cacheCreationInputTokens,
                cacheReadInputTokens: event.cacheReadInputTokens,
                costUsd: event.costUsd ?? undefined,
              })
              .returning();
            const usage = toDomainModelUsage(row);
            await logModelUsage(trace, usage);
            await emit({
              taskId: params.taskId,
              type: "model_usage",
              timestamp: new Date().toISOString(),
              usage,
            });
            break;
          }

          case "result": {
            const completedAt = new Date();
            const startedAt = run.startedAt;
            const durationMs = completedAt.getTime() - new Date(startedAt).getTime();
            const finalStatus: TaskStatus = event.success ? "COMPLETED" : "FAILED";

            await db
              .update(schema.runs)
              .set({
                status: finalStatus,
                completedAt,
                durationMs,
                errorMessage: event.errorMessage,
              })
              .where(eq(schema.runs.id, run.id));

            await setTaskStatus(params.taskId, finalStatus, emit, {
              completedAt,
              durationMs,
              result: event.result,
              errorMessage: event.errorMessage,
              progress: 100,
            });

            if (!event.success) {
              await db.insert(schema.errors).values({
                runId: run.id,
                taskId: params.taskId,
                message: event.errorMessage ?? "task failed",
              });
            }

            await endRunTrace(trace, {
              result: event.result,
              success: event.success,
              errorMessage: event.errorMessage,
            });

            await emit({
              taskId: params.taskId,
              type: "result",
              timestamp: completedAt.toISOString(),
              result: event.result,
              durationMs,
            });
            break;
          }
        }
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db
      .update(schema.runs)
      .set({ status: "FAILED" satisfies TaskStatus, completedAt: new Date(), errorMessage: message })
      .where(eq(schema.runs.id, run.id));
    await db.insert(schema.errors).values({ runId: run.id, taskId: params.taskId, message, stack: err instanceof Error ? err.stack : undefined });
    await setTaskStatus(params.taskId, "FAILED", emit, { completedAt: new Date(), errorMessage: message, progress: 100 });
    await endRunTrace(trace, { result: "", success: false, errorMessage: message });
    await emit({ taskId: params.taskId, type: "error", timestamp: new Date().toISOString(), message });
  }
}

async function setTaskStatus(
  taskId: string,
  status: TaskStatus,
  emit: (event: TaskEvent) => void | Promise<void>,
  extra: Partial<{
    startedAt: Date;
    completedAt: Date;
    durationMs: number;
    result: string;
    errorMessage: string;
    progress: number;
  }>,
): Promise<void> {
  const db = getDb();
  await db
    .update(schema.tasks)
    .set({ status, updatedAt: new Date(), ...extra })
    .where(eq(schema.tasks.id, taskId));
  await emit({ taskId, type: "status_change", timestamp: new Date().toISOString(), status });
  if (extra.progress != null) {
    await emit({ taskId, type: "progress", timestamp: new Date().toISOString(), progress: extra.progress, label: status });
  }
}

function toDomainToolUsage(row: typeof schema.toolUsage.$inferSelect): ToolUsage {
  return {
    id: row.id,
    runId: row.runId,
    toolName: row.toolName,
    input: row.input,
    output: row.output,
    startedAt: row.startedAt.toISOString(),
    durationMs: row.durationMs,
    success: row.success,
    errorMessage: row.errorMessage,
  };
}

function toDomainModelUsage(row: typeof schema.modelUsage.$inferSelect): ModelUsage {
  return {
    id: row.id,
    runId: row.runId,
    model: row.model,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cacheCreationInputTokens: row.cacheCreationInputTokens,
    cacheReadInputTokens: row.cacheReadInputTokens,
    costUsd: row.costUsd,
    createdAt: row.createdAt.toISOString(),
  };
}
