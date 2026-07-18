/**
 * Thin wrapper around the `langsmith` npm package's `Client`. Nothing else
 * in the worker touches the LangSmith SDK directly — if LangSmith's run
 * schema drifts, this is the one file that needs updating.
 *
 * LANGSMITH_API_KEY unset → every method no-ops (after one warning) instead
 * of throwing. LangSmith is additive tracing for V1, not a hard dependency —
 * Postgres metrics (packages/db) keep working with or without it.
 *
 * The run-tree fields below (`trace_id`, `dotted_order`, `parent_run_id`)
 * are LangSmith's documented mechanism for nesting child runs under a root
 * run in the trace view. This wrapper implements the minimal correct
 * version (root run + flat children, no deeper nesting) — verify against
 * the installed `langsmith` package version if runs stop appearing nested
 * correctly, since this is exactly the kind of field set that drifts
 * between SDK versions.
 */
import { Client } from "langsmith";
import type { ModelUsage, ToolUsage } from "@forge/shared";

let client: Client | null = null;
let warned = false;

function getClient(): Client | null {
  if (!process.env.LANGSMITH_API_KEY) {
    if (!warned) {
      console.warn("[langsmith] LANGSMITH_API_KEY not set — tracing disabled, metrics still land in Postgres.");
      warned = true;
    }
    return null;
  }
  if (!client) {
    client = new Client({ apiKey: process.env.LANGSMITH_API_KEY });
  }
  return client;
}

/** ISO timestamp, used only to build dotted_order strings (see below). */
function isoNow(): string {
  return new Date().toISOString();
}

/**
 * LangSmith's run-tree ordering field: `{time}{run-uuid}`, dot-joined per
 * ancestor — e.g. `20230914T223155647Z1b64098b-...`. The installed
 * `langsmith` package's RunUpdate.dotted_order jsdoc carries this exact
 * example; the ISO string already ends in "Z" once its separators are
 * stripped, so nothing extra is appended before the run ID.
 */
function dottedOrder(isoStartTime: string, runId: string, parent?: string): string {
  const compact = isoStartTime.replace(/[-:]/g, "").replace(".", "");
  const segment = `${compact}${runId}`;
  return parent ? `${parent}.${segment}` : segment;
}

export interface RunTraceHandle {
  runId: string;
  traceId: string;
  rootDottedOrder: string;
  /** null when LangSmith is disabled (no API key) — callers must check before using. */
  traceUrl: string | null;
}

const projectName = process.env.LANGSMITH_PROJECT ?? "forge";

export async function startRunTrace(params: {
  taskId: string;
  projectId: string | null;
  prompt: string;
}): Promise<RunTraceHandle | null> {
  const c = getClient();
  const runId = crypto.randomUUID();
  const startTime = isoNow();
  const rootDottedOrder = dottedOrder(startTime, runId);

  if (!c) return null;

  try {
    await c.createRun({
      id: runId,
      trace_id: runId,
      dotted_order: rootDottedOrder,
      name: params.prompt.slice(0, 80),
      run_type: "chain",
      project_name: projectName,
      inputs: { prompt: params.prompt },
      start_time: Date.now(),
      extra: { metadata: { taskId: params.taskId, projectId: params.projectId, forgeVersion: "0.1.0" } },
    });
  } catch (err) {
    console.warn("[langsmith] createRun (root) failed:", err);
    return null;
  }

  const traceUrl = `https://smith.langchain.com/o/-/projects/p/${projectName}/r/${runId}`;
  return { runId, traceId: runId, rootDottedOrder, traceUrl };
}

export async function logModelUsage(handle: RunTraceHandle | null, usage: ModelUsage): Promise<void> {
  const c = getClient();
  if (!c || !handle) return;
  const childId = crypto.randomUUID();
  const startTime = isoNow();
  const nowMs = Date.now();
  try {
    await c.createRun({
      id: childId,
      trace_id: handle.traceId,
      parent_run_id: handle.runId,
      dotted_order: dottedOrder(startTime, childId, handle.rootDottedOrder),
      name: `llm:${usage.model}`,
      run_type: "llm",
      project_name: projectName,
      inputs: {},
      start_time: nowMs,
      end_time: nowMs,
      outputs: {
        usage: {
          input_tokens: usage.inputTokens,
          output_tokens: usage.outputTokens,
          cache_creation_input_tokens: usage.cacheCreationInputTokens,
          cache_read_input_tokens: usage.cacheReadInputTokens,
        },
        cost_usd: usage.costUsd,
      },
    });
  } catch (err) {
    console.warn("[langsmith] createRun (model_usage) failed:", err);
  }
}

export async function logToolCall(handle: RunTraceHandle | null, tool: ToolUsage): Promise<void> {
  const c = getClient();
  if (!c || !handle) return;
  const childId = crypto.randomUUID();
  const startTime = isoNow();
  const nowMs = Date.now();
  const startedAtMs = new Date(tool.startedAt).getTime();
  try {
    await c.createRun({
      id: childId,
      trace_id: handle.traceId,
      parent_run_id: handle.runId,
      dotted_order: dottedOrder(startTime, childId, handle.rootDottedOrder),
      name: `tool:${tool.toolName}`,
      run_type: "tool",
      project_name: projectName,
      inputs: { input: tool.input },
      outputs: { output: tool.output },
      start_time: Number.isFinite(startedAtMs) ? startedAtMs : nowMs,
      end_time: tool.durationMs != null ? (Number.isFinite(startedAtMs) ? startedAtMs + tool.durationMs : nowMs) : nowMs,
      error: tool.success ? undefined : (tool.errorMessage ?? "tool call failed"),
    });
  } catch (err) {
    console.warn("[langsmith] createRun (tool_usage) failed:", err);
  }
}

export async function endRunTrace(
  handle: RunTraceHandle | null,
  outcome: { result: string; success: boolean; errorMessage?: string },
): Promise<void> {
  const c = getClient();
  if (!c || !handle) return;
  try {
    await c.updateRun(handle.runId, {
      end_time: Date.now(),
      outputs: { result: outcome.result },
      error: outcome.success ? undefined : (outcome.errorMessage ?? "run failed"),
    });
  } catch (err) {
    console.warn("[langsmith] updateRun (end) failed:", err);
  }
}
