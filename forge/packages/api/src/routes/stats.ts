import type { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import { getDb, schema } from "@forge/db";
import type { GlobalStats } from "@forge/shared";

export async function statsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/stats", async (): Promise<{ stats: GlobalStats }> => {
    const db = getDb();

    const [taskCounts] = await db
      .select({
        total: sql<number>`count(*)`,
        completed: sql<number>`count(*) filter (where ${schema.tasks.status} = 'COMPLETED')`,
        failed: sql<number>`count(*) filter (where ${schema.tasks.status} = 'FAILED')`,
        avgDurationMs: sql<number | null>`avg(${schema.tasks.durationMs}) filter (where ${schema.tasks.durationMs} is not null)`,
      })
      .from(schema.tasks);

    const [usage] = await db
      .select({
        totalTokens: sql<number>`coalesce(sum(${schema.modelUsage.inputTokens} + ${schema.modelUsage.outputTokens}), 0)`,
        totalCostUsd: sql<number>`coalesce(sum(${schema.modelUsage.costUsd}), 0)`,
      })
      .from(schema.modelUsage);

    return {
      stats: {
        totalTasks: Number(taskCounts.total),
        completedTasks: Number(taskCounts.completed),
        failedTasks: Number(taskCounts.failed),
        averageDurationMs: taskCounts.avgDurationMs != null ? Number(taskCounts.avgDurationMs) : null,
        totalTokens: Number(usage.totalTokens),
        totalCostUsd: Number(usage.totalCostUsd),
      },
    };
  });
}
