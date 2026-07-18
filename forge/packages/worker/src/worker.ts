/**
 * Standalone entrypoint — not used by V1 (the API calls executeTask()
 * in-process, see docs/ARCHITECTURE.md → Task Manager). This exists so a
 * future job-queue-based dispatch has somewhere to live without restructuring
 * execute-task.ts: a queue consumer would sit here, popping jobs and calling
 * the same executeTask() the API calls directly today.
 */
console.log("[worker] standalone mode is not wired to a queue in V1 — see the comment at the top of this file.");
