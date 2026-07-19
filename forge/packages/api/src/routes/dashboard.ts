/**
 * GET /dashboard?range=N — the single endpoint the mobile telemetry PWA
 * reads. Joins each task's pre-run estimate with the actual tokens/cost its
 * runs consumed, so the phone renders the estimate-vs-actual comparison from
 * real data.
 *
 * Actuals are sourced from Postgres by default (the authoritative mirror);
 * when FORGE_METRICS_SOURCE=langsmith, the total-token figure is taken from
 * LangSmith instead (with a Postgres fallback). The per-run LangSmith trace
 * URL is always included for drill-down.
 */
import type { FastifyInstance } from "fastify";
import { gte, inArray } from "drizzle-orm";
import { getDb, schema } from "@forge/db";
import type {
  DashboardPayload,
  DashboardRow,
  CompositionByModel,
  TaskStatus,
} from "@forge/shared";
import { readActualsByTaskId, langsmithMetricsEnabled } from "../langsmith-read.js";

export async function dashboardRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { range?: string } }>("/dashboard", async (request): Promise<DashboardPayload> => {
    const db = getDb();
    const rangeDays = clampRange(Number(request.query.range));
    const since = new Date(Date.now() - rangeDays * 24 * 3600 * 1000);

    const tasks = await db.select().from(schema.tasks).where(gte(schema.tasks.createdAt, since));
    const taskIds = tasks.map((t) => t.id);

    const runs = taskIds.length
      ? await db.select().from(schema.runs).where(inArray(schema.runs.taskId, taskIds))
      : [];
    const runIds = runs.map((r) => r.id);
    const usage = runIds.length
      ? await db.select().from(schema.modelUsage).where(inArray(schema.modelUsage.runId, runIds))
      : [];

    // index usage by run
    const usageByRun = new Map<string, typeof usage>();
    for (const u of usage) {
      const arr = usageByRun.get(u.runId) ?? [];
      arr.push(u);
      usageByRun.set(u.runId, arr);
    }
    // latest run per task
    const runByTask = new Map<string, (typeof runs)[number]>();
    for (const r of runs) {
      const prev = runByTask.get(r.taskId);
      if (!prev || r.startedAt > prev.startedAt) runByTask.set(r.taskId, r);
    }

    const lsActuals = langsmithMetricsEnabled() ? await readActualsByTaskId(rangeDays) : new Map();
    const usedLangsmith = lsActuals.size > 0;

    const now = Date.now();
    const compositionAgg = new Map<string, CompositionByModel>();

    const rows: DashboardRow[] = tasks.map((t) => {
      const run = runByTask.get(t.id);
      const runUsage = run ? (usageByRun.get(run.id) ?? []) : [];

      let actualInput = 0, actualOutput = 0, cacheRead = 0, cost = 0;
      const modelCount = new Map<string, number>();
      for (const u of runUsage) {
        actualInput += u.inputTokens;
        actualOutput += u.outputTokens;
        cacheRead += u.cacheReadInputTokens;
        cost += u.costUsd ?? 0;
        modelCount.set(u.model, (modelCount.get(u.model) ?? 0) + 1);

        const c = compositionAgg.get(u.model) ?? { model: u.model, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, tasks: 0 };
        c.inputTokens += u.inputTokens;
        c.outputTokens += u.outputTokens;
        c.cacheReadTokens += u.cacheReadInputTokens;
        compositionAgg.set(u.model, c);
      }

      const model = mostCommon(modelCount) ?? process.env.CLAUDE_CODE_MODEL ?? "unknown";
      const pgActual = actualInput + actualOutput;
      const ls = lsActuals.get(t.id);
      const actualTokens = ls ? ls.actualTokens : pgActual;

      return {
        taskId: t.id,
        task: t.prompt,
        model,
        status: t.status as TaskStatus,
        createdAt: t.createdAt.toISOString(),
        daysAgo: Math.floor((now - t.createdAt.getTime()) / (24 * 3600 * 1000)),
        durationMs: t.durationMs,
        estimatedTokens: t.estimatedInputTokens + t.estimatedOutputTokens,
        actualTokens,
        actualInputTokens: actualInput,
        actualOutputTokens: actualOutput,
        cacheReadTokens: cacheRead,
        costUsd: cost,
        langsmithTraceUrl: run?.langsmithTraceUrl ?? ls?.traceUrl ?? null,
      };
    });

    // count distinct tasks per model for composition
    for (const t of tasks) {
      const run = runByTask.get(t.id);
      const runUsage = run ? (usageByRun.get(run.id) ?? []) : [];
      const models = new Set(runUsage.map((u) => u.model));
      for (const m of models) {
        const c = compositionAgg.get(m);
        if (c) c.tasks += 1;
      }
    }

    // rows with an actual (a run that produced usage) drive estimate-vs-actual stats
    const measured = rows.filter((r) => r.actualTokens > 0 && r.estimatedTokens > 0);
    const estimatedTokens = measured.reduce((s, r) => s + r.estimatedTokens, 0);
    const actualTokens = rows.reduce((s, r) => s + r.actualTokens, 0);
    const mape = measured.length
      ? measured.reduce((s, r) => s + Math.abs(r.actualTokens - r.estimatedTokens) / r.estimatedTokens, 0) / measured.length * 100
      : 0;

    return {
      rangeDays,
      source: usedLangsmith ? "langsmith" : "postgres",
      summary: {
        tasks: rows.length,
        failed: rows.filter((r) => r.status === "FAILED").length,
        estimatedTokens,
        actualTokens,
        driftPct: estimatedTokens ? (measured.reduce((s, r) => s + r.actualTokens, 0) - estimatedTokens) / estimatedTokens * 100 : 0,
        mapePct: mape,
        costUsd: rows.reduce((s, r) => s + r.costUsd, 0),
        cacheReadTokens: rows.reduce((s, r) => s + r.cacheReadTokens, 0),
      },
      rows,
      composition: [...compositionAgg.values()],
      generatedAt: new Date().toISOString(),
    };
  });
}

function clampRange(n: number): number {
  if (!Number.isFinite(n)) return 7;
  return Math.max(1, Math.min(90, Math.round(n)));
}

function mostCommon(counts: Map<string, number>): string | null {
  let best: string | null = null;
  let bestN = -1;
  for (const [k, v] of counts) if (v > bestN) { best = k; bestN = v; }
  return best;
}
