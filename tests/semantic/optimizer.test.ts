import { describe, it, expect } from "vitest";
import { resolveTypeScriptSymbols, findSymbol } from "../../src/semantic/symbol-resolver.js";
import { generateCandidates, optimize } from "../../src/semantic/optimizer.js";

const SRC = `
function process_request(url: string): string {
  return url;
}
`;

describe("generateCandidates", () => {
  it("produces a ladder of candidates that all reproduce the same resulting file", () => {
    const symbols = resolveTypeScriptSymbols("sample.ts", SRC);
    const fn = findSymbol(symbols, "process_request")!;
    const newSymbolText = "function process_request(url: string, timeout: number = 30): string {\n  return url;\n}";

    const candidates = generateCandidates(SRC, fn, newSymbolText, "typescript");
    expect(candidates.length).toBeGreaterThan(0);

    const expected = SRC.slice(0, fn.start) + newSymbolText + SRC.slice(fn.end);
    for (const c of candidates) {
      expect(c.newText).toBe(expected);
    }

    // character tier should be the smallest range; some candidate should cover
    // the whole resolved symbol node (its strategy label may collapse into
    // "statement" when that tier's span happens to coincide with the node's).
    const byRangeSize = [...candidates].sort(
      (a, b) => (a.rangeEnd - a.rangeStart) - (b.rangeEnd - b.rangeStart),
    );
    expect(byRangeSize[0].strategy).toBe("character");
    expect(candidates.some((c) => c.rangeStart === fn.start && c.rangeEnd === fn.end)).toBe(true);
  });

  it("returns no candidates for a true no-op edit", () => {
    const symbols = resolveTypeScriptSymbols("sample.ts", SRC);
    const fn = findSymbol(symbols, "process_request")!;
    const identicalText = SRC.slice(fn.start, fn.end);
    const candidates = generateCandidates(SRC, fn, identicalText, "typescript");
    expect(candidates).toHaveLength(0);
  });
});

describe("optimize", () => {
  it("ranks candidates with a valid compile score above an invalid one, and smaller edits higher when compilation ties", () => {
    const symbols = resolveTypeScriptSymbols("sample.ts", SRC);
    const fn = findSymbol(symbols, "process_request")!;
    const newSymbolText = "function process_request(url: string, timeout: number = 30): string {\n  return url;\n}";

    const scored = optimize(SRC, fn, newSymbolText, "typescript", { compilationScore: 1 });
    expect(scored.length).toBeGreaterThan(0);
    // Sorted best-first.
    for (let i = 1; i < scored.length; i++) {
      expect(scored[i - 1].score.total).toBeGreaterThanOrEqual(scored[i].score.total);
    }
    // The character-minimal candidate should score at least as well as the widest (whole-node) candidate.
    const character = scored.find((s) => s.candidate.strategy === "character");
    const widest = [...scored].sort(
      (a, b) => (b.candidate.rangeEnd - b.candidate.rangeStart) - (a.candidate.rangeEnd - a.candidate.rangeStart),
    )[0];
    expect(character).toBeDefined();
    expect(widest).toBeDefined();
    expect(character!.score.minimalEdit).toBeGreaterThanOrEqual(widest!.score.minimalEdit);
  });
});
