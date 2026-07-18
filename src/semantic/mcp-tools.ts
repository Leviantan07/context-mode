/**
 * semantic/mcp-tools — registers the symbol-level editing tools onto the
 * McpServer: ctx_semantic_resolve, ctx_semantic_patch, ctx_semantic_patch_stats.
 *
 * Kept separate from server.ts (which is already large) and decoupled from
 * its internals — callers inject the few pieces of server state this needs
 * (response tracking, project-path resolution, the Read deny-policy check,
 * and the detected python binary) via `SemanticToolDeps`.
 */
import { z } from "zod";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";
import { resolveSymbols, findSymbol } from "./symbol-resolver.js";
import { plan, planAndApply, SymbolNotFoundError } from "./engine.js";
import { PatchMemory } from "./memory.js";
import type { SymbolInfo, PatchMemoryStats } from "./types.js";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

export interface SemanticToolDeps {
  // Using `any` for the McpServer instance's registerTool avoids a hard
  // dependency on the exact @modelcontextprotocol/sdk type re-export path.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  server: { registerTool: (name: string, meta: any, handler: (params: any) => Promise<ToolResult>) => unknown };
  trackResponse: (toolName: string, response: ToolResult) => ToolResult;
  resolveProjectPath: (filePath: string) => string;
  checkFilePathDenyPolicy: (filePath: string, toolName: string) => ToolResult | null;
  /** Checks BOTH Read and Edit deny patterns — required before a tool writes back to a resolved path. */
  checkWriteFilePathDenyPolicy: (filePath: string, toolName: string) => ToolResult | null;
  getProjectDir: () => string;
  getPythonBin: () => string | null;
  /** Per-project PatchMemory JSON file path (mirrors the content-store/session-db layout). */
  getMemoryPath: () => string;
}

function text(s: string): ToolResult {
  return { content: [{ type: "text" as const, text: s }] };
}

function errorText(s: string): ToolResult {
  return { content: [{ type: "text" as const, text: s }], isError: true };
}

function formatSymbolLine(s: SymbolInfo): string {
  const sig = s.signature ? ` — ${s.signature.replace(/\s+/g, " ").slice(0, 80)}` : "";
  return `${s.kind.padEnd(10)} ${s.path}  (L${s.startPos.line}:${s.startPos.column})${sig}`;
}

function unifiedSnippet(before: string, after: string, maxLen = 600): string {
  const trim = (s: string) => (s.length > maxLen ? s.slice(0, maxLen) + "\n… (truncated)" : s);
  const beforeLines = trim(before).split("\n").map((l) => `- ${l}`);
  const afterLines = trim(after).split("\n").map((l) => `+ ${l}`);
  return [...beforeLines, ...afterLines].join("\n");
}

function formatStats(stats: PatchMemoryStats): string {
  const lines: string[] = [];
  lines.push(`Total patches recorded: ${stats.totalPatches}`);
  lines.push(`Success rate: ${(stats.successRate * 100).toFixed(1)}%`);
  lines.push(`Rollback rate: ${(stats.rollbackRate * 100).toFixed(1)}%`);
  lines.push(`Average patch size: ${stats.averagePatchSize.toFixed(0)} chars`);
  lines.push("");
  lines.push("By strategy:");
  for (const [strategy, s] of Object.entries(stats.byStrategy)) {
    lines.push(`  ${strategy.padEnd(12)} n=${s.count}  success=${(s.successRate * 100).toFixed(0)}%  avgScore=${s.avgScore.toFixed(2)}`);
  }
  lines.push("");
  lines.push("By language:");
  for (const [language, s] of Object.entries(stats.byLanguage)) {
    lines.push(`  ${language.padEnd(12)} n=${s.count}  success=${(s.successRate * 100).toFixed(0)}%`);
  }
  return lines.join("\n");
}

export function registerSemanticTools(deps: SemanticToolDeps): void {
  const { server, trackResponse, resolveProjectPath, checkFilePathDenyPolicy, checkWriteFilePathDenyPolicy, getPythonBin, getProjectDir, getMemoryPath } = deps;

  server.registerTool(
    "ctx_semantic_resolve",
    {
      title: "Resolve Code Symbol",
      description:
        "Resolve a function/method/class/interface/enum/variable/parameter/import/decorator/comment/string/literal " +
        "inside a file to its exact AST span — via the TypeScript compiler API for TS/JS, and Python's own `ast` " +
        "module (stdlib, shelled out) for .py. Use this BEFORE editing so you target a symbol, not a line number: " +
        "code shifts lines, symbols don't. Omit `query` to list every symbol in the file (capped).\n\n" +
        "Query forms: \"process_request\" (name match), \"ClassName.method\" (dotted path), " +
        "\"function:process_request\" (kind-filtered), \"process_request.timeout\" (a parameter).",
      inputSchema: z.object({
        path: z.string().describe("Absolute file path or relative to project root."),
        query: z.string().optional().describe("Symbol query. Omitted = list all symbols in the file."),
      }),
    },
    async (params) => {
      const { path, query } = params as { path: string; query?: string };
      const pathDenied = checkFilePathDenyPolicy(path, "ctx_semantic_resolve");
      if (pathDenied) return pathDenied;
      try {
        const resolved = resolveProjectPath(path);
        const fileText = readFileSync(resolved, "utf8");
        const symbols = resolveSymbols(resolved, fileText, { pythonBin: getPythonBin() });

        if (!query) {
          const listed = symbols.slice(0, 200).map(formatSymbolLine).join("\n");
          const suffix = symbols.length > 200 ? `\n… ${symbols.length - 200} more (narrow with a query)` : "";
          return trackResponse("ctx_semantic_resolve", text(`${symbols.length} symbols in ${path}:\n\n${listed}${suffix}`));
        }

        const match = findSymbol(symbols, query);
        if (!match) {
          const sample = symbols.slice(0, 20).map((s) => `${s.kind}:${s.path}`).join(", ");
          return trackResponse("ctx_semantic_resolve", errorText(
            `No symbol matched "${query}" in ${path}.\nAvailable (sample): ${sample}`,
          ));
        }
        const body = fileText.slice(match.start, match.end);
        const preview = body.length > 400 ? body.slice(0, 400) + "\n… (truncated)" : body;
        return trackResponse("ctx_semantic_resolve", text(
          `${match.kind} "${match.name}" — ${match.path}\n` +
          `Span: L${match.startPos.line}:${match.startPos.column} → L${match.endPos.line}:${match.endPos.column} ` +
          `(offset ${match.start}-${match.end})\n` +
          (match.signature ? `Signature: ${match.signature}\n` : "") +
          `\n${preview}`,
        ));
      } catch (err: unknown) {
        return trackResponse("ctx_semantic_resolve", errorText(`Resolution failed: ${err instanceof Error ? err.message : String(err)}`));
      }
    },
  );

  server.registerTool(
    "ctx_semantic_patch",
    {
      title: "Apply Symbol-Level Patch",
      description:
        "Symbol-oriented edit: resolves `symbol` to its exact AST span, generates a candidate patch ladder " +
        "(character → token → expression/statement → AST), scores each on minimal-edit size, compilation/syntax " +
        "validity, semantic safety, formatting preservation, diff size, and token efficiency, runs deterministic " +
        "review gates (static analyzer, formatter checker, security agent, semantic-safety), then applies the " +
        "smallest passing candidate transactionally — snapshot, write, verify, and automatic rollback on any " +
        "failure. `newCode` is the FULL replacement text for the matched symbol's span (not a diff).\n\n" +
        "Use this instead of a raw line-based edit whenever the target can be named as a symbol. " +
        "Set apply:false to preview the plan without writing.",
      inputSchema: z.object({
        path: z.string().describe("Absolute file path or relative to project root."),
        symbol: z.string().describe("Symbol query, e.g. \"process_request\", \"ClassName.method\", \"function:foo\"."),
        newCode: z.string().describe("Full replacement text for the matched symbol's exact span."),
        apply: z.boolean().optional().default(true).describe("false = plan/dry-run only, no write."),
        testCommand: z.string().optional().describe("Optional shell command run after writing (e.g. a test file); failure triggers rollback."),
      }),
    },
    async (params) => {
      const { path, symbol, newCode, apply, testCommand } = params as {
        path: string; symbol: string; newCode: string; apply?: boolean; testCommand?: string;
      };
      const pathDenied = checkWriteFilePathDenyPolicy(path, "ctx_semantic_patch");
      if (pathDenied) return pathDenied;
      try {
        const resolved = resolveProjectPath(path);
        const project = getProjectDir();
        const memoryPath = getMemoryPath();
        mkdirSync(dirname(memoryPath), { recursive: true });
        const memory = new PatchMemory(memoryPath);
        const originalText = readFileSync(resolved, "utf8");

        const result = await planAndApply({
          filePath: resolved,
          symbolQuery: symbol,
          newSymbolText: newCode,
          pythonBin: getPythonBin(),
          project,
          memory,
          apply: apply !== false,
          testCommand,
          testCwd: project,
        });

        const { best, findings, rollback, symbol: sym } = result;
        const statusLine = rollback.applied
          ? "APPLIED"
          : rollback.rolledBack
            ? "ROLLED BACK"
            : "NOT APPLIED (plan only)";

        const findingsText = findings
          .map((f) => `  [${f.verdict.toUpperCase()}] ${f.agent}: ${f.message}`)
          .join("\n");

        const scoreText = Object.entries(best.score)
          .map(([k, v]) => `${k}=${(v as number).toFixed(2)}`)
          .join(" ");

        const beforeSpan = originalText.slice(best.candidate.rangeStart, best.candidate.rangeEnd);

        const report = [
          `${statusLine} — ${sym.kind} "${sym.name}" via ${best.candidate.strategy} strategy (score ${best.score.total.toFixed(2)})`,
          `  ${best.candidate.description}`,
          rollback.reason ? `  Reason: ${rollback.reason}` : "",
          rollback.checkerOutput ? `  Checker output: ${rollback.checkerOutput.slice(0, 400)}` : "",
          "",
          `Score breakdown: ${scoreText}`,
          `Metrics: ${best.metrics.charactersChanged} chars, ${best.metrics.linesChanged} lines, ` +
            `${best.metrics.tokensChanged} tokens changed, ${best.metrics.astNodesChanged} AST nodes (approx), ` +
            `${best.metrics.gitDiffLines} diff lines.`,
          "",
          "Review:",
          findingsText,
          "",
          "Diff:",
          unifiedSnippet(beforeSpan, best.candidate.replacement),
        ].filter(Boolean).join("\n");

        return trackResponse("ctx_semantic_patch", { content: [{ type: "text" as const, text: report }], isError: !rollback.applied && apply !== false });
      } catch (err: unknown) {
        if (err instanceof SymbolNotFoundError) {
          return trackResponse("ctx_semantic_patch", errorText(
            `${err.message}\nAvailable symbols (sample): ${err.available.join(", ")}\n` +
            `Tip: call ctx_semantic_resolve(path) first to list exact symbol paths.`,
          ));
        }
        return trackResponse("ctx_semantic_patch", errorText(`Patch failed: ${err instanceof Error ? err.message : String(err)}`));
      }
    },
  );

  server.registerTool(
    "ctx_semantic_patch_stats",
    {
      title: "Semantic Patch Memory Stats",
      description:
        "Show PatchMemory statistics for this project: success/rollback rate, average patch size, and a " +
        "breakdown by strategy and language — which patch strategies have actually worked here before.",
      inputSchema: z.object({
        language: z.enum(["typescript", "javascript", "python"]).optional(),
      }),
    },
    async (params) => {
      const { language } = params as { language?: "typescript" | "javascript" | "python" };
      try {
        const memoryPath = getMemoryPath();
        const memory = new PatchMemory(memoryPath);
        const stats = memory.getStats({ language });
        if (stats.totalPatches === 0) {
          return trackResponse("ctx_semantic_patch_stats", text("No patches recorded yet for this project. Use ctx_semantic_patch to make one."));
        }
        return trackResponse("ctx_semantic_patch_stats", text(formatStats(stats)));
      } catch (err: unknown) {
        return trackResponse("ctx_semantic_patch_stats", errorText(`Failed to read patch memory: ${err instanceof Error ? err.message : String(err)}`));
      }
    },
  );
}
