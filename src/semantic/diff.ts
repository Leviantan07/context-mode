/**
 * semantic/diff — minimal-edit primitives used by the SemanticPatchOptimizer.
 *
 * No external diff library: a common-prefix/suffix trim shrinks a candidate
 * replacement to its smallest changed substring (character-level minimality),
 * and a compact Myers O(ND) line diff gives git-style changed-line counts
 * without shelling out to `git diff` (candidates are evaluated against
 * in-memory text, not working-tree files).
 */

/** Length of the longest common prefix, in UTF-16 code units. */
export function commonPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  return i;
}

/** Length of the longest common suffix, in UTF-16 code units. Does not overlap `prefixLen`. */
export function commonSuffixLength(a: string, b: string, prefixLen = 0): number {
  const maxA = a.length - prefixLen;
  const maxB = b.length - prefixLen;
  const max = Math.min(maxA, maxB);
  let i = 0;
  while (
    i < max &&
    a.charCodeAt(a.length - 1 - i) === b.charCodeAt(b.length - 1 - i)
  ) {
    i++;
  }
  return i;
}

export interface MinimalSpan {
  /** Offset into `oldText` where the changed region starts. */
  start: number;
  /** Offset into `oldText` where the changed region ends (exclusive). */
  end: number;
  /** The replacement text for [start, end). */
  replacement: string;
}

/**
 * Shrink a full old→new replacement to the smallest changed span by
 * trimming any shared prefix/suffix. Used to turn a symbol-range replace
 * into a character-level minimal patch.
 */
export function minimalSpan(oldText: string, newText: string): MinimalSpan {
  const prefixLen = commonPrefixLength(oldText, newText);
  const suffixLen = commonSuffixLength(oldText, newText, prefixLen);
  const start = prefixLen;
  const end = oldText.length - suffixLen;
  const newEnd = newText.length - suffixLen;
  return { start, end, replacement: newText.slice(prefixLen, newEnd) };
}

export type LineDiffOp = { op: "equal" | "insert" | "delete"; line: string };

/**
 * Compact Myers diff (O(ND)) over lines. Good enough for changed-line
 * counts on the symbol-sized spans this engine operates on — not intended
 * for whole-repository diffing.
 */
export function myersLineDiff(oldLines: string[], newLines: string[]): LineDiffOp[] {
  const n = oldLines.length;
  const m = newLines.length;
  const max = n + m;
  if (max === 0) return [];
  const offset = max;
  const size = 2 * max + 1;
  let v = new Int32Array(size);
  const trace: Int32Array[] = [];

  let dFinal = -1;
  outer: for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) {
        x = v[offset + k + 1];
      } else {
        x = v[offset + k - 1] + 1;
      }
      let y = x - k;
      while (x < n && y < m && oldLines[x] === newLines[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        dFinal = d;
        break outer;
      }
    }
  }

  // Backtrack to build the edit script.
  const ops: LineDiffOp[] = [];
  let x = n;
  let y = m;
  for (let d = dFinal; d > 0; d--) {
    const vPrev = trace[d];
    const k = x - y;
    let prevK: number;
    if (k === -d || (k !== d && vPrev[offset + k - 1] < vPrev[offset + k + 1])) {
      prevK = k + 1;
    } else {
      prevK = k - 1;
    }
    const prevX = vPrev[offset + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ op: "equal", line: oldLines[x - 1] });
      x--;
      y--;
    }
    if (x === prevX) {
      ops.push({ op: "insert", line: newLines[y - 1] });
      y--;
    } else {
      ops.push({ op: "delete", line: oldLines[x - 1] });
      x--;
    }
  }
  while (x > 0 && y > 0) {
    ops.push({ op: "equal", line: oldLines[x - 1] });
    x--;
    y--;
  }
  ops.reverse();
  return ops;
}

/** Count changed (inserted + deleted) lines between two texts, git-diff style. */
export function countChangedLines(oldText: string, newText: string): number {
  if (oldText === newText) return 0;
  const ops = myersLineDiff(oldText.split("\n"), newText.split("\n"));
  let changed = 0;
  for (const op of ops) if (op.op !== "equal") changed++;
  return changed;
}

/** Byte-based token estimate, matching the bytes/4 heuristic used elsewhere in context-mode. */
export function estimateTokens(text: string): number {
  return Math.round(Buffer.byteLength(text, "utf8") / 4);
}
