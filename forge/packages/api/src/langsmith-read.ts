/**
 * Server-side LangSmith read path. The phone never talks to LangSmith
 * directly — that would put the LangSmith API key in the browser and hit
 * CORS. Instead the Forge API queries LangSmith here (key stays server-side)
 * and hands the phone plain JSON.
 *
 * Division of labour, deliberately:
 *   - Postgres is the authoritative, queryable mirror of every metric — it's
 *     written in the *same* code path as the LangSmith traces (see
 *     packages/worker/src/execute-task.ts), so it always has the full
 *     input/output/cache split and is fast to aggregate.
 *   - LangSmith is the trace viewer (deep-link per task) and, when
 *     FORGE_METRICS_SOURCE=langsmith, an alternate source of the actual-token
 *     totals — useful to cross-check that the two agree.
 *
 * This reader is best-effort and defensive: any failure returns an empty map
 * and the caller falls back to Postgres, so a LangSmith outage or SDK-version
 * drift never breaks the dashboard.
 *
 * Correlation: the worker tags each LangSmith root run with
 * `extra.metadata.taskId` (see packages/worker/src/langsmith.ts), so we map
 * LangSmith runs back to Forge tasks by that key. Root-run token totals are
 * LangSmith's rolled-up descendant totals; the per-model input/output/cache
 * breakdown always comes from Postgres.
 */
import { Client } from "langsmith";

export interface LangSmithActuals {
  actualTokens: number;
  traceUrl: string | null;
}

const projectName = process.env.LANGSMITH_PROJECT ?? "forge";

/** True when the operator asked the dashboard to source actuals from LangSmith. */
export function langsmithMetricsEnabled(): boolean {
  return process.env.FORGE_METRICS_SOURCE === "langsmith" && !!process.env.LANGSMITH_API_KEY;
}

/** Best-effort map of Forge taskId → actual-token totals from LangSmith. Empty on any failure. */
export async function readActualsByTaskId(rangeDays: number): Promise<Map<string, LangSmithActuals>> {
  const out = new Map<string, LangSmithActuals>();
  if (!langsmithMetricsEnabled()) return out;

  try {
    const client = new Client({ apiKey: process.env.LANGSMITH_API_KEY });
    const startTime = new Date(Date.now() - rangeDays * 24 * 3600 * 1000);
    const base = process.env.LANGSMITH_ENDPOINT ?? "https://smith.langchain.com";

    for await (const run of client.listRuns({ projectName, isRoot: true, startTime })) {
      const taskId = (run.extra as { metadata?: { taskId?: string } } | undefined)?.metadata?.taskId;
      if (!taskId) continue;
      out.set(taskId, {
        actualTokens: run.total_tokens ?? 0,
        traceUrl: run.app_path ? `${base}${run.app_path}` : null,
      });
    }
  } catch (err) {
    console.warn("[langsmith-read] falling back to Postgres:", err);
    return new Map();
  }
  return out;
}
