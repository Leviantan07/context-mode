/**
 * Pre-run token estimate — the "estimé" half of the estimate-vs-actual
 * comparison. Computed at task-creation time, before any Claude Code session
 * exists, and persisted on the task so the dashboard can compare it against
 * what LangSmith / Postgres later record as actually consumed.
 *
 * This is deliberately a *rough* heuristic, and that's the point: the whole
 * telemetry dashboard exists to surface how far these estimates drift from
 * reality per task, so you can recalibrate the constants below from the
 * historical `model_usage` the dashboard already exposes. Closing that loop
 * (measure drift → tune constants) is the intended workflow.
 *
 * Why a char/4 approximation and not messages.count_tokens: the actual input
 * Claude Code consumes is dominated by the system prompt, tool definitions,
 * file reads, and tool results across many agentic turns — none of which
 * exist yet at creation time. An exact count of just the user's prompt would
 * be precise about the wrong number. So we approximate the prompt cheaply
 * (no network round-trip on the create path) and expand it by a
 * per-model factor that models the agentic overhead. Swap `approxPromptTokens`
 * for a real count_tokens call if you want the prompt term exact; the
 * expansion term is the dominant one regardless.
 */

export interface TokenEstimate {
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
}

/** Per-model agentic profile. Calibrate from your own run history. */
const PROFILES: Record<string, { baseInput: number; baseOutput: number; inputExpansion: number; outputExpansion: number }> = {
  // Bigger models tend to be handed / take on larger, multi-file tasks.
  opus: { baseInput: 60000, baseOutput: 30000, inputExpansion: 40, outputExpansion: 18 },
  sonnet: { baseInput: 32000, baseOutput: 14000, inputExpansion: 28, outputExpansion: 12 },
  haiku: { baseInput: 12000, baseOutput: 4000, inputExpansion: 16, outputExpansion: 6 },
};

function approxPromptTokens(prompt: string): number {
  // ~4 chars per token — fine for a pre-run estimate; see file header.
  return Math.ceil(prompt.trim().length / 4);
}

function profileFor(model: string) {
  const key = model.toLowerCase();
  if (key.includes("opus")) return PROFILES.opus;
  if (key.includes("haiku")) return PROFILES.haiku;
  return PROFILES.sonnet;
}

export function estimateTask(params: { prompt: string; model?: string }): TokenEstimate {
  const p = profileFor(params.model ?? "sonnet");
  const promptTokens = approxPromptTokens(params.prompt);
  return {
    estimatedInputTokens: Math.round(p.baseInput + promptTokens * p.inputExpansion),
    estimatedOutputTokens: Math.round(p.baseOutput + promptTokens * p.outputExpansion),
  };
}
