/**
 * semantic/optimizer — SemanticPatchOptimizer.
 *
 * Patch generation is treated as an optimization problem: the same resulting
 * file (`newFullText`) can always be expressed as many different [start,end)
 * replacements over `oldText`. This module enumerates that ladder — from the
 * character-minimal span up to the whole resolved AST node — and scores each
 * candidate so the engine can apply the smallest one that is still safe.
 *
 * Character → Token → Expression/Statement → AST
 *
 * ("Semantic Patch" is not a distinct span tier — it's the label for
 * whichever candidate survives scoring + review; see engine.ts.)
 */
import * as ts from "typescript";
import { minimalSpan, countChangedLines, estimateTokens } from "./diff.js";
import type {
  SymbolInfo,
  PatchCandidate,
  ScoredCandidate,
  PatchScoreBreakdown,
  PatchMetrics,
  SymbolLanguage,
} from "./types.js";

function isWord(ch: string | undefined): boolean {
  return !!ch && /\w/.test(ch);
}

function expandToTokenBoundary(text: string, start: number, end: number): { start: number; end: number } {
  let a = start;
  if (isWord(text[a - 1]) && isWord(text[a])) {
    while (a > 0 && isWord(text[a - 1])) a--;
  }
  let b = end;
  if (isWord(text[b - 1]) && isWord(text[b])) {
    while (b < text.length && isWord(text[b])) b++;
  }
  return { start: a, end: b };
}

/** Smallest node satisfying `predicate` that fully encloses [start, end). */
function findSmallestEnclosing(
  sourceFile: ts.SourceFile,
  start: number,
  end: number,
  predicate: (n: ts.Node) => boolean,
): ts.Node | null {
  let best: ts.Node | null = null;
  let bestSize = Infinity;
  function visit(node: ts.Node) {
    const s = node.getStart(sourceFile);
    const e = node.getEnd();
    if (s <= start && end <= e) {
      const size = e - s;
      if (predicate(node) && size < bestSize) {
        best = node;
        bestSize = size;
      }
      ts.forEachChild(node, visit);
    }
  }
  visit(sourceFile);
  return best;
}

function expandToLineBoundary(text: string, start: number, end: number): { start: number; end: number } {
  let a = start;
  while (a > 0 && text[a - 1] !== "\n") a--;
  let b = end;
  while (b < text.length && text[b] !== "\n") b++;
  return { start: a, end: b };
}

function candidateFromRange(
  oldText: string,
  newFullText: string,
  strategy: PatchCandidate["strategy"],
  start: number,
  end: number,
  description: string,
): PatchCandidate {
  // Both oldText and newFullText share the same untouched prefix/suffix by
  // construction (all candidates target the same edit), so the replacement
  // for any wider [start,end) is just the corresponding slice of newFullText.
  const growLeft = start; // chars of oldText before the range, unchanged
  const growRight = oldText.length - end; // chars of oldText after the range, unchanged
  const replacement = newFullText.slice(growLeft, newFullText.length - growRight);
  const newText = oldText.slice(0, start) + replacement + oldText.slice(end);
  return { strategy, newText, rangeStart: start, rangeEnd: end, replacement, description };
}

/**
 * Generate the candidate ladder for replacing `symbol`'s span in `oldText`
 * with `newSymbolText`. Every candidate reproduces the exact same
 * `newFullText` — they differ only in how much surrounding, unchanged text
 * each one's [rangeStart, rangeEnd) drags along.
 */
export function generateCandidates(
  oldText: string,
  symbol: SymbolInfo,
  newSymbolText: string,
  language: SymbolLanguage,
): PatchCandidate[] {
  const newFullText = oldText.slice(0, symbol.start) + newSymbolText + oldText.slice(symbol.end);
  const candidates: PatchCandidate[] = [];

  // 1. character — globally minimal span (common prefix/suffix trim over the whole file).
  const { start: charStart, end: charEnd } = minimalSpan(oldText, newFullText);
  if (charStart === charEnd && newFullText.length === oldText.length && oldText === newFullText) {
    // No-op edit — nothing to patch.
    return [];
  }
  candidates.push(candidateFromRange(oldText, newFullText, "character", charStart, charEnd, "Minimal character-level span."));

  // 2. token — expand to nearest identifier/number boundary so we never split a token.
  const tok = expandToTokenBoundary(oldText, charStart, charEnd);
  if (tok.start !== charStart || tok.end !== charEnd) {
    candidates.push(candidateFromRange(oldText, newFullText, "token", tok.start, tok.end, "Expanded to whole-token boundaries."));
  }

  // 3. expression / statement — for TS/JS, walk the real AST for the smallest
  //    enclosing Expression/Statement node; for Python, approximate with line boundaries.
  if (language === "typescript" || language === "javascript") {
    try {
      const sourceFile = ts.createSourceFile("__probe__.tsx", oldText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      const exprNode = findSmallestEnclosing(sourceFile, tok.start, tok.end, ts.isExpression);
      if (exprNode) {
        const s = (exprNode as ts.Node).getStart(sourceFile);
        const e = (exprNode as ts.Node).getEnd();
        if (s < tok.start || e > tok.end) {
          candidates.push(candidateFromRange(oldText, newFullText, "expression", s, e, "Smallest enclosing expression node."));
        }
      }
      const stmtNode = findSmallestEnclosing(sourceFile, tok.start, tok.end, ts.isStatement);
      if (stmtNode) {
        const s = (stmtNode as ts.Node).getStart(sourceFile);
        const e = (stmtNode as ts.Node).getEnd();
        if (s < tok.start || e > tok.end) {
          candidates.push(candidateFromRange(oldText, newFullText, "statement", s, e, "Smallest enclosing statement node."));
        }
      }
    } catch {
      // Re-parse failed (e.g. the file isn't actually valid TS/JS in isolation) — skip this tier.
    }
  } else if (language === "python") {
    const line = expandToLineBoundary(oldText, tok.start, tok.end);
    if (line.start < tok.start || line.end > tok.end) {
      candidates.push(candidateFromRange(oldText, newFullText, "statement", line.start, line.end, "Expanded to enclosing line(s)."));
    }
  }

  // 4. ast — the originally resolved symbol node, whole.
  candidates.push(candidateFromRange(oldText, newFullText, "ast", symbol.start, symbol.end, `Whole resolved ${symbol.kind} node.`));

  // De-dupe identical ranges (small symbols often collapse several tiers to the same span).
  const seen = new Set<string>();
  return candidates.filter((c) => {
    const key = `${c.rangeStart}:${c.rangeEnd}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export interface ScoringContext {
  /** 0-1, from a compile/syntax check; 1 when no checker is available for the language (neutral). */
  compilationScore: number;
  compilationOutput?: string;
}

const WEIGHTS = {
  minimalEdit: 0.30,
  compilation: 0.25,
  semanticSafety: 0.20,
  formattingPreservation: 0.10,
  gitDiff: 0.10,
  tokenEfficiency: 0.05,
} as const;

function formattingPreservationScore(oldText: string, candidate: PatchCandidate): number {
  const before = oldText.slice(candidate.rangeStart, candidate.rangeEnd);
  const beforeStripped = before.replace(/\s+/g, "");
  const afterStripped = candidate.replacement.replace(/\s+/g, "");
  if (beforeStripped === afterStripped && before !== candidate.replacement) {
    // Same meaningful content, only whitespace differs — incidental reformatting.
    return 0.5;
  }
  return 1;
}

/** Public-signature-preservation heuristic: penalize when the replacement's leading signature-ish text diverges from the original's for AST/expression/statement tiers over a function/method/class/interface symbol. */
function semanticSafetyScore(symbol: SymbolInfo, candidate: PatchCandidate, oldText: string): number {
  if (!["function", "method", "class", "interface"].includes(symbol.kind)) return 1;
  if (candidate.rangeStart > symbol.start || candidate.rangeEnd < symbol.start) return 1; // signature not in range at all
  const oldSig = (symbol.signature ?? "").replace(/\s+/g, " ").trim();
  if (!oldSig) return 1;
  // Only meaningful when the candidate's replaced range actually covers the signature.
  if (candidate.rangeEnd < symbol.start + oldSig.length) return 1;
  const newFull = oldText.slice(0, candidate.rangeStart) + candidate.replacement + oldText.slice(candidate.rangeEnd);
  const newSigApprox = newFull.slice(symbol.start, symbol.start + oldSig.length + 80).replace(/\s+/g, " ").trim();
  // Loosely compare param/return counts by counting commas + arrow/colon presence.
  const paramCountOld = (oldSig.match(/,/g) ?? []).length;
  const paramCountNew = (newSigApprox.match(/,/g) ?? []).length;
  if (Math.abs(paramCountOld - paramCountNew) > 1) return 0.6; // signature shape changed materially
  return 1;
}

export function scoreCandidate(
  oldText: string,
  symbol: SymbolInfo,
  candidate: PatchCandidate,
  ctx: ScoringContext,
): ScoredCandidate {
  const before = oldText.slice(candidate.rangeStart, candidate.rangeEnd);
  const charactersChanged = Math.max(before.length, candidate.replacement.length);
  const linesChanged = countChangedLines(before, candidate.replacement);
  const tokensChanged = estimateTokens(before) + estimateTokens(candidate.replacement);
  const gitDiffLines = countChangedLines(oldText, candidate.newText);

  const totalChars = Math.max(oldText.length, 1);
  const minimalEdit = 1 - Math.min(1, charactersChanged / totalChars);
  const totalLines = Math.max(oldText.split("\n").length, 1);
  const gitDiff = 1 - Math.min(1, gitDiffLines / totalLines);
  const contextTokensEstimate = estimateTokens(oldText.slice(
    Math.max(0, candidate.rangeStart - 200),
    Math.min(oldText.length, candidate.rangeEnd + 200),
  ));
  const tokenEfficiency = 1 - Math.min(1, tokensChanged / Math.max(estimateTokens(oldText), 1));

  const formattingPreservation = formattingPreservationScore(oldText, candidate);
  const semanticSafety = semanticSafetyScore(symbol, candidate, oldText);

  const breakdown: PatchScoreBreakdown = {
    minimalEdit,
    compilation: ctx.compilationScore,
    semanticSafety,
    formattingPreservation,
    gitDiff,
    tokenEfficiency,
    total: 0,
  };
  breakdown.total =
    breakdown.minimalEdit * WEIGHTS.minimalEdit +
    breakdown.compilation * WEIGHTS.compilation +
    breakdown.semanticSafety * WEIGHTS.semanticSafety +
    breakdown.formattingPreservation * WEIGHTS.formattingPreservation +
    breakdown.gitDiff * WEIGHTS.gitDiff +
    breakdown.tokenEfficiency * WEIGHTS.tokenEfficiency;

  // Astronomically approximate AST-nodes-changed / tree-edit-distance without a full
  // GumTree implementation: treat each ~changed token as one node edit.
  const astNodesChanged = Math.max(1, Math.round(tokensChanged / 2));
  const treeEditDistance = astNodesChanged;

  const metrics: PatchMetrics = {
    charactersChanged,
    linesChanged,
    tokensChanged,
    astNodesChanged,
    treeEditDistance,
    gitDiffLines,
    contextTokensEstimate,
  };

  return { candidate, score: breakdown, metrics };
}

/** SemanticPatchOptimizer entry point: generate, score, and rank candidates smallest-best-first. */
export function optimize(
  oldText: string,
  symbol: SymbolInfo,
  newSymbolText: string,
  language: SymbolLanguage,
  ctx: ScoringContext,
): ScoredCandidate[] {
  const candidates = generateCandidates(oldText, symbol, newSymbolText, language);
  const scored = candidates.map((c) => scoreCandidate(oldText, symbol, c, ctx));
  scored.sort((a, b) => b.score.total - a.score.total);
  return scored;
}
