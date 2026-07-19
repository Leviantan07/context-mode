import Fastify from "fastify";
import cors from "@fastify/cors";
import { taskRoutes } from "./routes/tasks.js";
import { statsRoutes } from "./routes/stats.js";
import { dashboardRoutes } from "./routes/dashboard.js";

const app = Fastify({ logger: true });

// The dashboard and the API sit on different origins — the phone's
// home-screen PWA, a static host, or the GitHub Pages + Codespaces split
// (docs/INSTALL.md) — so the browser needs CORS headers to allow the fetch.
// Defaults to any origin (the "no auth, trust the network" posture in
// INSTALL.md's known-gaps section); set FORGE_CORS_ORIGIN to lock it down
// before exposing the API more broadly.
await app.register(cors, {
  origin: process.env.FORGE_CORS_ORIGIN ?? true,
});

app.get("/health", async () => ({ ok: true }));

await app.register(taskRoutes);
await app.register(statsRoutes);
await app.register(dashboardRoutes);

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "0.0.0.0";

app.listen({ port, host }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
