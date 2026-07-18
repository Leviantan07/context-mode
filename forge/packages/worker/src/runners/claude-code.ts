/**
 * Drives Claude Code via the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`)
 * — the SDK's `query()` async generator yields typed messages (`SDKMessage`),
 * so this file never parses newline-delimited JSON off a subprocess's stdout.
 *
 * Message shapes below are taken directly from the installed SDK's own type
 * defs (node_modules/@anthropic-ai/claude-agent-sdk/entrypoints/sdk/coreTypes.d.ts,
 * v0.1.77) rather than guessed from docs — in particular:
 *   - `SDKResultMessage.usage` is snake_case (BetaUsage shape), but the
 *     per-model breakdown `SDKResultMessage.modelUsage` is a *camelCase* map
 *     keyed by model name, and is the only place `costUSD` appears. This
 *     runner sources model_usage events from that map, not from per-turn
 *     assistant message usage (which has no cost figure and would double-count
 *     against the aggregate).
 *   - `permissionMode: 'bypassPermissions'` additionally requires
 *     `allowDangerouslySkipPermissions: true` or the SDK rejects it.
 */
import { query, type Options, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Runner, RunnerOptions } from "./types.js";

interface PendingToolCall {
  toolName: string;
  input: unknown;
  startedAt: number;
}

/**
 * No safe default in headless mode — there's no human to answer an approval
 * prompt, so leaving this unset can hang the worker forever on the first
 * tool call. Set deliberately via env var; see docs/ARCHITECTURE.md →
 * Permission mode.
 */
function resolvePermissionOptions(): Pick<Options, "permissionMode" | "allowDangerouslySkipPermissions"> {
  if (process.env.CLAUDE_CODE_PERMISSION_MODE === "bypassPermissions") {
    return { permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true };
  }
  return { permissionMode: "acceptEdits" };
}

function extractModelUsageEvents(result: SDKResultMessage) {
  return Object.entries(result.modelUsage ?? {}).map(([model, usage]) => ({
    type: "model_usage" as const,
    model,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheCreationInputTokens: usage.cacheCreationInputTokens,
    cacheReadInputTokens: usage.cacheReadInputTokens,
    costUsd: usage.costUSD,
  }));
}

export const claudeCodeRunner: Runner = {
  name: "claude-code",

  async run({ prompt, cwd, model, resumeSessionId, onEvent }: RunnerOptions): Promise<void> {
    const pendingToolCalls = new Map<string, PendingToolCall>();

    const stream = query({
      prompt,
      options: {
        model: model ?? process.env.CLAUDE_CODE_MODEL ?? "sonnet",
        cwd,
        includePartialMessages: false,
        ...resolvePermissionOptions(),
        ...(resumeSessionId ? { resume: resumeSessionId } : {}),
      },
    });

    let finalResultEmitted = false;

    for await (const message of stream) {
      switch (message.type) {
        case "system": {
          if (message.subtype === "init") {
            await onEvent({ type: "session_start", sessionId: message.session_id });
          }
          break;
        }

        case "assistant": {
          for (const block of message.message.content) {
            if (block.type === "text") {
              await onEvent({ type: "assistant_text", text: block.text });
            } else if (block.type === "tool_use") {
              pendingToolCalls.set(block.id, {
                toolName: block.name,
                input: block.input,
                startedAt: Date.now(),
              });
            }
          }
          break;
        }

        case "user": {
          const content = message.message.content;
          if (!Array.isArray(content)) break;
          for (const block of content as Array<Record<string, unknown>>) {
            if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
              const pending = pendingToolCalls.get(block.tool_use_id);
              pendingToolCalls.delete(block.tool_use_id);
              const isError = block.is_error === true;
              await onEvent({
                type: "tool_call",
                toolName: pending?.toolName ?? "unknown",
                input: pending?.input ?? null,
                output: block.content ?? null,
                durationMs: pending ? Date.now() - pending.startedAt : null,
                success: !isError,
                errorMessage: isError ? String(block.content ?? "tool error") : undefined,
              });
            }
          }
          break;
        }

        case "result": {
          const failed = message.is_error === true || message.subtype !== "success";

          for (const usageEvent of extractModelUsageEvents(message)) {
            await onEvent(usageEvent);
          }

          finalResultEmitted = true;
          await onEvent({
            type: "result",
            result: "result" in message ? message.result : "",
            success: !failed,
            errorMessage: failed ? message.subtype : undefined,
          });
          break;
        }
      }
    }

    // The SDK stream ended without a `result` message — treat as failure
    // rather than silently reporting the task as complete.
    if (!finalResultEmitted) {
      await onEvent({
        type: "result",
        result: "",
        success: false,
        errorMessage: "Claude Code session ended without a result message",
      });
    }
  },
};
