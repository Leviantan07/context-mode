import { describe, it, expect } from "vitest";
import { commonPrefixLength, commonSuffixLength, minimalSpan, countChangedLines, estimateTokens } from "../../src/semantic/diff.js";

describe("commonPrefixLength / commonSuffixLength", () => {
  it("finds shared prefix and suffix", () => {
    expect(commonPrefixLength("hello world", "hello there")).toBe(6);
    expect(commonSuffixLength("hello world", "cold world")).toBe(6);
  });

  it("handles no overlap", () => {
    expect(commonPrefixLength("abc", "xyz")).toBe(0);
    expect(commonSuffixLength("abc", "xyz")).toBe(0);
  });
});

describe("minimalSpan", () => {
  it("shrinks a full replacement to the smallest changed substring", () => {
    const oldText = "function foo(a, b) { return a + b; }";
    const newText = "function foo(a, b, c) { return a + b; }";
    const span = minimalSpan(oldText, newText);
    expect(oldText.slice(0, span.start) + span.replacement + oldText.slice(span.end)).toBe(newText);
    // Only the inserted ", c" should be the changed region, not the whole function.
    expect(span.replacement).toBe(", c");
  });

  it("returns an empty span for identical text", () => {
    const span = minimalSpan("same", "same");
    expect(span.start).toBe(span.end);
    expect(span.replacement).toBe("");
  });
});

describe("countChangedLines", () => {
  it("returns 0 for identical text", () => {
    expect(countChangedLines("a\nb\nc", "a\nb\nc")).toBe(0);
  });

  it("counts inserted and deleted lines", () => {
    const oldText = "a\nb\nc";
    const newText = "a\nx\nc";
    // one deleted line (b) + one inserted line (x) = 2
    expect(countChangedLines(oldText, newText)).toBe(2);
  });
});

describe("estimateTokens", () => {
  it("matches the bytes/4 heuristic used elsewhere in context-mode", () => {
    const text = "a".repeat(40);
    expect(estimateTokens(text)).toBe(10);
  });
});
