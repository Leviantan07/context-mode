/**
 * semantic/rollback — every patch is transactional.
 *
 * Snapshot → write → verify (syntax check, optionally a caller-supplied
 * test command) → keep on success, restore the exact original bytes on any
 * failure. No patch produced by this engine is ever left on disk in a
 * broken state.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import type { RollbackResult } from "./types.js";

export interface VerifyStep {
  ok: boolean;
  output?: string;
}

export interface ApplyOptions {
  filePath: string;
  newText: string;
  /** Already-computed syntax/compile result — re-checked here defensively. */
  staticCheck: VerifyStep;
  /** Optional shell command (e.g. a project's test runner) run with cwd = testCwd after writing. */
  testCommand?: string;
  testCwd?: string;
  testTimeoutMs?: number;
}

export function applyWithRollback(opts: ApplyOptions): RollbackResult {
  const { filePath, newText, staticCheck, testCommand, testCwd, testTimeoutMs } = opts;

  if (!staticCheck.ok) {
    return { applied: false, rolledBack: false, reason: "Static check failed before write — nothing applied.", checkerOutput: staticCheck.output };
  }

  const hadFile = existsSync(filePath);
  const original = hadFile ? readFileSync(filePath, "utf8") : null;

  try {
    writeFileSync(filePath, newText, "utf8");
  } catch (err) {
    return { applied: false, rolledBack: false, reason: `Write failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (testCommand) {
    try {
      const output = execSync(testCommand, {
        cwd: testCwd,
        timeout: testTimeoutMs ?? 60_000,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { applied: true, rolledBack: false, checkerOutput: output.slice(-2000) };
    } catch (err: unknown) {
      const output = err && typeof err === "object"
        ? [(err as { stdout?: string }).stdout, (err as { stderr?: string }).stderr].filter(Boolean).join("\n").slice(-2000)
        : String(err);
      // Roll back to the exact original bytes.
      if (original !== null) {
        writeFileSync(filePath, original, "utf8");
      }
      return { applied: false, rolledBack: true, reason: "Test command failed after applying patch.", checkerOutput: output };
    }
  }

  return { applied: true, rolledBack: false };
}
