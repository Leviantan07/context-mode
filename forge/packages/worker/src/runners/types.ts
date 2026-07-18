/**
 * Every execution backend (Claude Code today, OpenHands later) implements
 * this interface. The Task Manager and DB/LangSmith persistence code depend
 * only on this — adding a second runner never touches them.
 */

export interface RunnerOptions {
  prompt: string;
  /** Absolute path to the checked-out repo the runner should operate in. */
  cwd: string;
  model?: string;
  /** Resume a prior session (this runner's own session ID format). */
  resumeSessionId?: string;
  onEvent: (event: RunnerEvent) => void | Promise<void>;
}

export type RunnerEvent =
  | { type: "session_start"; sessionId: string }
  | { type: "assistant_text"; text: string }
  | {
      type: "tool_call";
      toolName: string;
      input: unknown;
      output: unknown;
      durationMs: number | null;
      success: boolean;
      errorMessage?: string;
    }
  | {
      type: "model_usage";
      model: string;
      inputTokens: number;
      outputTokens: number;
      cacheCreationInputTokens: number;
      cacheReadInputTokens: number;
      costUsd: number | null;
    }
  | { type: "result"; result: string; success: boolean; errorMessage?: string };

export interface Runner {
  readonly name: string;
  run(options: RunnerOptions): Promise<void>;
}
