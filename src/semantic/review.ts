/**
 * semantic/review — deterministic multi-agent patch review.
 *
 * "Agents" here are not separate LLM calls (a redistributable MCP server
 * tool has no business making hidden model calls on a user's behalf) —
 * they're deterministic gates, each with the same authority the spec's
 * agents have: approve, ask for a smaller patch, or flag a risk.
 *   - static-analyzer   → real syntax check (TS compiler API / python -m py_compile)
 *   - formatter-checker  → brace/indent balance + incidental whitespace churn
 *   - security-agent     → newly-introduced dangerous patterns
 *   - semantic-safety     → public signature / reference preservation
 */
import * as ts from "typescript";
import { execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { PatchCandidate, ReviewFinding, ScoredCandidate, SymbolInfo, SymbolLanguage } from "./types.js";

export interface StaticCheckResult {
  ok: boolean;
  score: number; // 0-1, 1 = clean or no checker available
  output?: string;
}

/** Syntax-only check via the TS compiler API — fast, in-process, no project resolution needed. */
export function checkTypeScriptSyntax(newText: string, filePath: string): StaticCheckResult {
  const scriptKind = /\.(tsx)$/i.test(filePath) ? ts.ScriptKind.TSX
    : /\.(jsx)$/i.test(filePath) ? ts.ScriptKind.JSX
    : /\.(js|mjs|cjs)$/i.test(filePath) ? ts.ScriptKind.JS
    : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(filePath, newText, ts.ScriptTarget.Latest, true, scriptKind);
  const diagnostics = (sourceFile as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics ?? [];
  if (diagnostics.length === 0) return { ok: true, score: 1 };
  const output = diagnostics
    .slice(0, 5)
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"))
    .join("; ");
  return { ok: false, score: 0, output };
}

export function checkPythonSyntax(newText: string, pythonBin: string): StaticCheckResult {
  const tmp = join(tmpdir(), `ctx-semantic-pycheck-${process.pid}-${Date.now()}.py`);
  try {
    writeFileSync(tmp, newText, "utf8");
    execFileSync(pythonBin, ["-c", `compile(open(${JSON.stringify(tmp)}).read(), ${JSON.stringify(tmp)}, "exec")`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, score: 1 };
  } catch (err: unknown) {
    const message = err && typeof err === "object" && "stderr" in err
      ? String((err as { stderr?: Buffer | string }).stderr)
      : String(err);
    return { ok: false, score: 0, output: message.split("\n").slice(-4).join("\n") };
  } finally {
    try { unlinkSync(tmp); } catch { /* best effort */ }
  }
}

export function checkSyntax(
  newText: string,
  filePath: string,
  language: SymbolLanguage,
  pythonBin: string | null,
): StaticCheckResult {
  if (language === "typescript" || language === "javascript") return checkTypeScriptSyntax(newText, filePath);
  if (language === "python") {
    if (!pythonBin) return { ok: true, score: 1, output: "no python runtime available — skipped" };
    return checkPythonSyntax(newText, pythonBin);
  }
  return { ok: true, score: 1 };
}

const DANGEROUS_PATTERNS: Array<{ re: RegExp; message: string }> = [
  { re: /\beval\s*\(/, message: "introduces eval()" },
  { re: /\bnew\s+Function\s*\(/, message: "introduces new Function()" },
  { re: /child_process|execSync|spawnSync|os\.system|subprocess\.(call|run|Popen)/, message: "introduces a shell/process-spawning call" },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, message: "embeds a private key" },
  { re: /(api[_-]?key|secret|password|token)\s*[:=]\s*['"][A-Za-z0-9_\-]{16,}['"]/i, message: "embeds a hardcoded credential-like literal" },
  { re: /AKIA[0-9A-Z]{16}/, message: "embeds what looks like an AWS access key" },
];

export function securityAgent(before: string, candidate: PatchCandidate): ReviewFinding {
  for (const { re, message } of DANGEROUS_PATTERNS) {
    const inBefore = re.test(before);
    const inAfter = re.test(candidate.replacement);
    if (inAfter && !inBefore) {
      return { agent: "security-agent", verdict: "risk", message: `Patch ${message}, which was not present before.` };
    }
  }
  return { agent: "security-agent", verdict: "approve", message: "No newly-introduced dangerous patterns detected." };
}

function bracketBalance(text: string): boolean {
  const pairs: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
  const stack: string[] = [];
  let inString: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") { i++; continue; }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") { inString = ch; continue; }
    if (ch === "(" || ch === "[" || ch === "{") stack.push(ch);
    else if (ch === ")" || ch === "]" || ch === "}") {
      if (stack.pop() !== pairs[ch]) return false;
    }
  }
  return stack.length === 0;
}

export function formatterChecker(before: string, candidate: PatchCandidate): ReviewFinding {
  if (!bracketBalance(candidate.replacement) && bracketBalance(before)) {
    return {
      agent: "formatter-checker",
      verdict: "revise",
      message: "Replacement text has unbalanced brackets/parens relative to the span it replaces.",
    };
  }
  const beforeStripped = before.replace(/\s+/g, "");
  const afterStripped = candidate.replacement.replace(/\s+/g, "");
  if (beforeStripped === afterStripped && before !== candidate.replacement) {
    return {
      agent: "formatter-checker",
      verdict: "revise",
      message: "Change is whitespace-only — consider a smaller patch or none at all.",
    };
  }
  return { agent: "formatter-checker", verdict: "approve", message: "Formatting preserved." };
}

export function semanticSafetyFinding(symbol: SymbolInfo, safetyScore: number): ReviewFinding {
  if (safetyScore >= 0.95) {
    return { agent: "semantic-safety", verdict: "approve", message: `${symbol.kind} "${symbol.name}" signature preserved.` };
  }
  return {
    agent: "semantic-safety",
    verdict: "risk",
    message: `${symbol.kind} "${symbol.name}" signature shape appears to have changed — verify callers.`,
  };
}

export interface ReviewInput {
  filePath: string;
  language: SymbolLanguage;
  pythonBin: string | null;
  before: string;
  symbol: SymbolInfo;
  scored: ScoredCandidate;
}

export function runReview(input: ReviewInput): { findings: ReviewFinding[]; static: StaticCheckResult } {
  const { filePath, language, pythonBin, before, symbol, scored } = input;
  const staticCheck = checkSyntax(scored.candidate.newText, filePath, language, pythonBin);
  const findings: ReviewFinding[] = [
    {
      agent: "static-analyzer",
      verdict: staticCheck.ok ? "approve" : "risk",
      message: staticCheck.ok ? "Syntax check passed." : `Syntax check failed: ${staticCheck.output ?? "unknown error"}`,
    },
    formatterChecker(before, scored.candidate),
    securityAgent(before, scored.candidate),
    semanticSafetyFinding(symbol, scored.score.semanticSafety),
  ];
  return { findings, static: staticCheck };
}

export function reviewPassed(findings: ReviewFinding[]): boolean {
  return findings.every((f) => f.verdict !== "risk");
}
