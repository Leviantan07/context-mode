/**
 * In-process pub/sub for TaskEvents, keyed by task ID. This is what makes
 * "Notifications Mobile" work in V1: the dashboard opens
 * GET /tasks/:id/events (SSE) and gets every event live, no APNs/FCM setup
 * required. Only works because the API and worker share one process in V1
 * (see docs/ARCHITECTURE.md) — a multi-instance API would need Redis pub/sub
 * or similar here instead.
 */
import type { TaskEvent } from "@forge/shared";

type Listener = (event: TaskEvent) => void;

const listeners = new Map<string, Set<Listener>>();

export function publish(event: TaskEvent): void {
  for (const listener of listeners.get(event.taskId) ?? []) {
    listener(event);
  }
}

export function subscribe(taskId: string, listener: Listener): () => void {
  if (!listeners.has(taskId)) listeners.set(taskId, new Set());
  listeners.get(taskId)!.add(listener);
  return () => {
    listeners.get(taskId)?.delete(listener);
    if (listeners.get(taskId)?.size === 0) listeners.delete(taskId);
  };
}
