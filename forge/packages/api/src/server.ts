import Fastify from "fastify";
import cors from "@fastify/cors";
import { taskRoutes } from "./routes/tasks.js";
import { statsRoutes } from "./routes/stats.js";

const app = Fastify({ logger: true });

// The dashboard and the API are deliberately on different origins in the
// GitHub Pages + Codespaces setup (docs/INSTALL.md), so the browser needs
// CORS headers to allow the fetch. Same "no auth, trust the network" posture
// already documented for this API — see INSTALL.md's known-gaps section.
await app.register(cors, { origin: true });

app.get("/health", async () => ({ ok: true }));

await app.register(taskRoutes);
await app.register(statsRoutes);

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "0.0.0.0";

app.listen({ port, host }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
