import type { FastifyInstance } from "fastify";
import { eq, desc, inArray } from "drizzle-orm";
import { getDb, schema } from "@forge/db";
import type { CreateTaskRequest } from "@forge/shared";
import { createTask, toDomainTask } from "../task-manager.js";
import { subscribe } from "../event-bus.js";

export async function taskRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: CreateTaskRequest }>("/tasks", async (request, reply) => {
    if (!request.body?.prompt?.trim()) {
      return reply.code(400).send({ error: "prompt is required" });
    }
    const task = await createTask(request.body);
    return reply.code(201).send({ task });
  });

  app.get("/tasks", async () => {
    const db = getDb();
    const rows = await db.select().from(schema.tasks).orderBy(desc(schema.tasks.createdAt)).limit(50);
    return { tasks: rows.map(toDomainTask) };
  });

  app.get<{ Params: { id: string } }>("/tasks/:id", async (request, reply) => {
    const db = getDb();
    const [row] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, request.params.id));
    if (!row) return reply.code(404).send({ error: "task not found" });

    const runs = await db.select().from(schema.runs).where(eq(schema.runs.taskId, row.id));
    const runIds = runs.map((r) => r.id);
    const toolUsage = runIds.length
      ? await db.select().from(schema.toolUsage).where(inArray(schema.toolUsage.runId, runIds))
      : [];
    const modelUsage = runIds.length
      ? await db.select().from(schema.modelUsage).where(inArray(schema.modelUsage.runId, runIds))
      : [];

    return { task: toDomainTask(row), runs, toolUsage, modelUsage };
  });

  // SSE — live task timeline. The dashboard's stand-in for push notifications.
  // This writes raw headers, bypassing @fastify/cors, so the cross-origin
  // header is set here by hand (EventSource from the phone PWA needs it).
  app.get<{ Params: { id: string } }>("/tasks/:id/events", async (request, reply) => {
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": process.env.FORGE_CORS_ORIGIN ?? "*",
    });

    const unsubscribe = subscribe(request.params.id, (event) => {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    });

    request.raw.on("close", unsubscribe);
  });
}
