/**
 * Contract shared by every Forge service (API, worker, dashboard).
 * Keep this file the single source of truth for shape — services import
 * from here rather than redeclaring equivalent interfaces.
 */

export const TASK_STATUSES = [
  "CREATED",
  "ANALYZING",
  "EXECUTING",
  "TESTING",
  "COMPLETED",
  "FAILED",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export interface Task {
  id: string;
  userId: string;
  projectId: string | null;
  prompt: string;
  status: TaskStatus;
  /** 0-100, best-effort — see TaskManager for how it's derived. */
  progress: number;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  result: string | null;
  errorMessage: string | null;
}

export interface Run {
  id: string;
  taskId: string;
  attemptNumber: number;
  status: TaskStatus;
  /** Claude Code's own session_id — pass to --resume / SDK `resume` option. */
  claudeSessionId: string | null;
  langsmithRunId: string | null;
  langsmithTraceUrl: string | null;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  errorMessage: string | null;
}

export interface ModelUsage {
  id: string;
  runId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  /** USD, from the SDK's `total_cost_usd` where available. */
  costUsd: number | null;
  createdAt: string;
}

export interface ToolUsage {
  id: string;
  runId: string;
  toolName: string;
  input: unknown;
  output: unknown;
  startedAt: string;
  durationMs: number | null;
  success: boolean;
  errorMessage: string | null;
}

export interface ForgeError {
  id: string;
  runId: string | null;
  taskId: string;
  message: string;
  stack: string | null;
  occurredAt: string;
}

export interface Project {
  id: string;
  name: string;
  repoUrl: string;
  defaultBranch: string;
  createdAt: string;
}

/** One line of the live/replayable task timeline — what SSE streams and what the dashboard renders. */
export type TaskEvent =
  | { taskId: string; type: "status_change"; timestamp: string; status: TaskStatus }
  | { taskId: string; type: "progress"; timestamp: string; progress: number; label: string }
  | { taskId: string; type: "assistant_text"; timestamp: string; text: string }
  | { taskId: string; type: "tool_call"; timestamp: string; tool: ToolUsage }
  | { taskId: string; type: "model_usage"; timestamp: string; usage: ModelUsage }
  | { taskId: string; type: "error"; timestamp: string; message: string }
  | { taskId: string; type: "result"; timestamp: string; result: string; durationMs: number };

export interface CreateTaskRequest {
  prompt: string;
  projectId?: string;
  userId?: string;
}

export interface CreateTaskResponse {
  task: Task;
}

export interface GlobalStats {
  totalTasks: number;
  completedTasks: number;
  failedTasks: number;
  averageDurationMs: number | null;
  totalTokens: number;
  totalCostUsd: number;
}
