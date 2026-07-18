/**
 * semantic — shared types for the symbol-oriented patch engine.
 *
 * Pipeline: instruction → symbol resolution (AST/Python-ast) → candidate
 * patch generation at multiple granularities → composite scoring →
 * deterministic review gates → transactional apply (snapshot + rollback) →
 * PatchMemory record.
 */

export type SymbolKind =
  | "function"
  | "method"
  | "class"
  | "interface"
  | "enum"
  | "variable"
  | "parameter"
  | "import"
  | "decorator"
  | "comment"
  | "string"
  | "literal"
  | "file";

export type SymbolLanguage = "typescript" | "javascript" | "python";

export interface SourcePosition {
  line: number; // 1-indexed
  column: number; // 0-indexed
}

/** A single resolved language symbol with a precise, byte-accurate span. */
export interface SymbolInfo {
  kind: SymbolKind;
  name: string;
  /** Dotted path, e.g. "ClassName.methodName" or "process_request.timeout". */
  path: string;
  language: SymbolLanguage;
  start: number; // char offset into file text
  end: number; // char offset into file text (exclusive)
  startPos: SourcePosition;
  endPos: SourcePosition;
  /** Signature text for functions/methods (params + return type), when applicable. */
  signature?: string;
  /** Immediate children (params for functions, members for classes, etc.) */
  children?: SymbolInfo[];
}

export type PatchStrategy =
  | "character"
  | "token"
  | "expression"
  | "statement"
  | "ast"
  | "semantic";

/** One candidate rewrite of the file, produced at a specific granularity. */
export interface PatchCandidate {
  strategy: PatchStrategy;
  /** Full new file content this candidate would produce. */
  newText: string;
  /** The narrowest [start,end) span of oldText actually replaced. */
  rangeStart: number;
  rangeEnd: number;
  replacement: string;
  description: string;
}

export interface PatchScoreBreakdown {
  minimalEdit: number; // 0-1, higher = smaller edit
  compilation: number; // 0-1, 1 = compiles / no available checker (neutral pass)
  semanticSafety: number; // 0-1, 1 = public signatures/refs preserved
  formattingPreservation: number; // 0-1, 1 = no incidental whitespace churn
  gitDiff: number; // 0-1, higher = fewer changed lines
  tokenEfficiency: number; // 0-1, higher = fewer tokens changed
  total: number; // weighted sum
}

export interface ScoredCandidate {
  candidate: PatchCandidate;
  score: PatchScoreBreakdown;
  metrics: PatchMetrics;
}

export interface PatchMetrics {
  charactersChanged: number;
  linesChanged: number;
  tokensChanged: number;
  astNodesChanged: number;
  treeEditDistance: number; // approximate (node-count based, not full GumTree)
  gitDiffLines: number;
  contextTokensEstimate: number;
}

export type ReviewVerdict = "approve" | "revise" | "risk";

export interface ReviewFinding {
  agent: "static-analyzer" | "formatter-checker" | "security-agent" | "semantic-safety";
  verdict: ReviewVerdict;
  message: string;
}

export interface PatchMemoryEntry {
  id: string;
  timestamp: number;
  project: string;
  file: string;
  language: SymbolLanguage | "unknown";
  symbolKind: SymbolKind | "unknown";
  strategy: PatchStrategy;
  score: number;
  compileOk: boolean;
  reviewOk: boolean;
  applied: boolean;
  rolledBack: boolean;
  durationMs: number;
  metrics: PatchMetrics;
}

export interface PatchMemoryStats {
  totalPatches: number;
  successRate: number;
  rollbackRate: number;
  averagePatchSize: number;
  byStrategy: Record<string, { count: number; successRate: number; avgScore: number }>;
  byLanguage: Record<string, { count: number; successRate: number }>;
}

export interface RollbackResult {
  applied: boolean;
  rolledBack: boolean;
  reason?: string;
  checkerOutput?: string;
}

export interface PatchPlanResult {
  symbol: SymbolInfo;
  candidates: ScoredCandidate[];
  best: ScoredCandidate;
  findings: ReviewFinding[];
}

export interface PatchApplyResult extends PatchPlanResult {
  rollback: RollbackResult;
  memoryEntry: PatchMemoryEntry;
}
