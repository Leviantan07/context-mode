/**
 * semantic/engine — orchestrates the full pipeline:
 *
 *   Instruction → resolveSymbols (LSP-equivalent: TS compiler API / python ast)
 *              → SemanticPatchOptimizer (candidate ladder + composite score)
 *              → multi-agent review (static/formatter/security/semantic-safety)
 *              → transactional apply (snapshot → write → verify → rollback)
 *              → PatchMemory record
 */
import { readFileSync } from "node:fs";
import { detectLanguage, resolveSymbols, findSymbol } from "./symbol-resolver.js";
import { optimize } from "./optimizer.js";
import { checkSyntax, runReview, reviewPassed } from "./review.js";
import { applyWithRollback } from "./rollback.js";
import { PatchMemory } from "./memory.js";
import type {
  PatchApplyResult,
  PatchPlanResult,
  PatchMemoryEntry,
  ScoredCandidate,
  SymbolLanguage,
} from "./types.js";

export interface EnginePlanInput {
  filePath: string;
  fileText?: string; // if omitted, read from disk
  symbolQuery: string;
  newSymbolText: string;
  pythonBin?: string | null;
}

export interface EngineApplyInput extends EnginePlanInput {
  project: string;
  memory: PatchMemory;
  apply: boolean; // false = dry run / plan only
  testCommand?: string;
  testCwd?: string;
  testTimeoutMs?: number;
}

export class SymbolNotFoundError extends Error {
  constructor(query: string, public readonly available: string[]) {
    super(`No symbol matched "${query}".`);
    this.name = "SymbolNotFoundError";
  }
}

export function plan(input: EnginePlanInput): PatchPlanResult {
  const { filePath, symbolQuery, newSymbolText, pythonBin } = input;
  const language = detectLanguage(filePath);
  if (!language) throw new Error(`Unsupported file type for semantic editing: ${filePath}`);

  const text = input.fileText ?? readFileSync(filePath, "utf8");
  const symbols = resolveSymbols(filePath, text, { pythonBin });
  const symbol = findSymbol(symbols, symbolQuery);
  if (!symbol) {
    throw new SymbolNotFoundError(symbolQuery, symbols.slice(0, 30).map((s) => `${s.kind}:${s.path}`));
  }

  const newFullText = text.slice(0, symbol.start) + newSymbolText + text.slice(symbol.end);
  const staticCheck = checkSyntax(newFullText, filePath, language, pythonBin ?? null);

  const scored = optimize(text, symbol, newSymbolText, language, {
    compilationScore: staticCheck.ok ? 1 : 0,
    compilationOutput: staticCheck.output,
  });

  if (scored.length === 0) {
    throw new Error("Requested edit produces no change — file already matches the requested state.");
  }

  // Walk the ladder best-first; pick the first candidate whose review passes.
  // Nothing passing cleanly falls back to the highest-scoring candidate, with
  // its findings surfaced so the caller (and PatchMemory) can see why.
  let chosen: ScoredCandidate = scored[0];
  let findings = runReview({ filePath, language, pythonBin: pythonBin ?? null, before: text.slice(chosen.candidate.rangeStart, chosen.candidate.rangeEnd), symbol, scored: chosen }).findings;
  if (!reviewPassed(findings)) {
    for (const candidate of scored.slice(1)) {
      const review = runReview({ filePath, language, pythonBin: pythonBin ?? null, before: text.slice(candidate.candidate.rangeStart, candidate.candidate.rangeEnd), symbol, scored: candidate });
      if (reviewPassed(review.findings)) {
        chosen = candidate;
        findings = review.findings;
        break;
      }
    }
  }

  return { symbol, candidates: scored, best: chosen, findings };
}

function languageKey(language: SymbolLanguage | null): SymbolLanguage | "unknown" {
  return language ?? "unknown";
}

export async function planAndApply(input: EngineApplyInput): Promise<PatchApplyResult> {
  const started = Date.now();
  const language = detectLanguage(input.filePath);
  const planResult = plan(input);

  const passed = reviewPassed(planResult.findings);
  let rollback = { applied: false, rolledBack: false, reason: "Not applied (dry run or review did not pass)." } as PatchApplyResult["rollback"];

  if (input.apply && passed) {
    const staticCheck = checkSyntax(planResult.best.candidate.newText, input.filePath, language as SymbolLanguage, input.pythonBin ?? null);
    rollback = applyWithRollback({
      filePath: input.filePath,
      newText: planResult.best.candidate.newText,
      staticCheck,
      testCommand: input.testCommand,
      testCwd: input.testCwd,
      testTimeoutMs: input.testTimeoutMs,
    });
  } else if (input.apply && !passed) {
    rollback = { applied: false, rolledBack: false, reason: "Review did not pass — see findings." };
  }

  const durationMs = Date.now() - started;
  const memoryEntry: PatchMemoryEntry = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: Date.now(),
    project: input.project,
    file: input.filePath,
    language: languageKey(language),
    symbolKind: planResult.symbol.kind,
    strategy: planResult.best.candidate.strategy,
    score: planResult.best.score.total,
    compileOk: planResult.best.score.compilation >= 1,
    reviewOk: passed,
    applied: rollback.applied,
    rolledBack: rollback.rolledBack,
    durationMs,
    metrics: planResult.best.metrics,
  };
  input.memory.record(memoryEntry);

  return { ...planResult, rollback, memoryEntry };
}
