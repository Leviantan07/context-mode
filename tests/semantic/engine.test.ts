import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { plan, planAndApply, SymbolNotFoundError } from "../../src/semantic/engine.js";
import { PatchMemory } from "../../src/semantic/memory.js";

let dir: string;
let filePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ctx-semantic-engine-"));
  filePath = join(dir, "sample.ts");
  writeFileSync(
    filePath,
    "function process_request(url: string): string {\n  return url;\n}\n",
    "utf8",
  );
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("plan", () => {
  it("throws SymbolNotFoundError for an unknown symbol", () => {
    expect(() =>
      plan({ filePath, symbolQuery: "does_not_exist", newSymbolText: "x" }),
    ).toThrow(SymbolNotFoundError);
  });

  it("picks a passing candidate for a valid edit", () => {
    const result = plan({
      filePath,
      symbolQuery: "process_request",
      newSymbolText:
        "function process_request(url: string, timeout: number = 30): string {\n  return url;\n}",
    });
    expect(result.best.candidate.newText).toContain("timeout: number = 30");
    expect(result.findings.every((f) => f.verdict !== "risk")).toBe(true);
  });
});

describe("planAndApply", () => {
  it("applies a valid patch, writes the file, and records success in PatchMemory", async () => {
    const memory = new PatchMemory(join(dir, "memory.json"));
    const result = await planAndApply({
      filePath,
      symbolQuery: "process_request",
      newSymbolText:
        "function process_request(url: string, timeout: number = 30): string {\n  return url;\n}",
      project: dir,
      memory,
      apply: true,
    });

    expect(result.rollback.applied).toBe(true);
    expect(result.rollback.rolledBack).toBe(false);
    const onDisk = readFileSync(filePath, "utf8");
    expect(onDisk).toContain("timeout: number = 30");

    const stats = memory.getStats();
    expect(stats.totalPatches).toBe(1);
    expect(stats.successRate).toBe(1);
  });

  it("rolls back and leaves the file untouched when the test command fails", async () => {
    const memory = new PatchMemory(join(dir, "memory.json"));
    const original = readFileSync(filePath, "utf8");

    const result = await planAndApply({
      filePath,
      symbolQuery: "process_request",
      newSymbolText:
        "function process_request(url: string, timeout: number = 30): string {\n  return url;\n}",
      project: dir,
      memory,
      apply: true,
      testCommand: "exit 1",
    });

    expect(result.rollback.applied).toBe(false);
    expect(result.rollback.rolledBack).toBe(true);
    expect(readFileSync(filePath, "utf8")).toBe(original);

    const stats = memory.getStats();
    expect(stats.totalPatches).toBe(1);
    expect(stats.rollbackRate).toBe(1);
  });

  it("does not write anything in dry-run mode (apply: false)", async () => {
    const memory = new PatchMemory(join(dir, "memory.json"));
    const original = readFileSync(filePath, "utf8");

    const result = await planAndApply({
      filePath,
      symbolQuery: "process_request",
      newSymbolText:
        "function process_request(url: string, timeout: number = 30): string {\n  return url;\n}",
      project: dir,
      memory,
      apply: false,
    });

    expect(result.rollback.applied).toBe(false);
    expect(readFileSync(filePath, "utf8")).toBe(original);
  });
});
