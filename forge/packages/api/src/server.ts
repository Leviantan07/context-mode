import Fastify from "fastify";
import { taskRoutes } from "./routes/tasks.js";
import { statsRoutes } from "./routes/stats.js";

const app = Fastify({ logger: true });

app.get("/health", async () => ({ ok: true }));

await app.register(taskRoutes);
await app.register(statsRoutes);

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "0.0.0.0";

app.listen({ port, host }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
