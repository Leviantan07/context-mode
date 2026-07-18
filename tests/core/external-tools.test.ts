/**
 * Detection tests for the optional Adaptive RAG backends (rtk / graphify /
 * nexus). Uses real subprocess spawns against tiny fake executables rather
 * than mocking node:child_process, so the test exercises the actual
 * execFileSync probe path (PATH lookup, --version parsing, timeout).
 */
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { detectExternalTools, getExternalToolsSummary } from "../../src/external-tools.js";

const isWindows = process.platform === "win32";

let tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  tmpDirs = [];
});

/** Writes a fake executable that prints `version` and exits 0 on `--version`. */
function makeFakeBinary(version: string): string {
  const dir = mkdtempSync(join(tmpdir(), "cm-ext-tools-"));
  tmpDirs.push(dir);
  const path = join(dir, isWindows ? "fake.cmd" : "fake.sh");
  const script = isWindows
    ? `@echo off\r\necho ${version}\r\n`
    : `#!/bin/sh\necho '${version}'\n`;
  writeFileSync(path, script);
  if (!isWindows) chmodSync(path, 0o755);
  return path;
}

describe("detectExternalTools", () => {
  test("reports unavailable for a binary that doesn't exist on PATH", () => {
    const tools = detectExternalTools({
      CONTEXT_MODE_RTK_CMD: "cm-definitely-not-a-real-binary-xyz",
      CONTEXT_MODE_GRAPHIFY_CMD: "cm-definitely-not-a-real-binary-xyz",
      CONTEXT_MODE_NEXUS_CMD: "cm-definitely-not-a-real-binary-xyz",
    } as NodeJS.ProcessEnv);

    expect(tools.rtk.available).toBe(false);
    expect(tools.graphify.available).toBe(false);
    expect(tools.nexus.available).toBe(false);
    expect(tools.rtk.version).toBe("unknown");
  });

  test("honors env var override and parses --version output when the binary exists", () => {
    const fakeGraphify = makeFakeBinary("graphify 1.2.3");
    const tools = detectExternalTools({
      CONTEXT_MODE_RTK_CMD: "cm-definitely-not-a-real-binary-xyz",
      CONTEXT_MODE_GRAPHIFY_CMD: fakeGraphify,
      CONTEXT_MODE_NEXUS_CMD: "cm-definitely-not-a-real-binary-xyz",
    } as NodeJS.ProcessEnv);

    expect(tools.graphify.available).toBe(true);
    expect(tools.graphify.command).toBe(fakeGraphify);
    expect(tools.graphify.version).toBe("graphify 1.2.3");
    expect(tools.rtk.available).toBe(false);
  });

  test("defaults to the bare command name when no env override is set", () => {
    const tools = detectExternalTools({} as NodeJS.ProcessEnv);
    expect(tools.rtk.command).toBe("rtk");
    expect(tools.graphify.command).toBe("graphify");
    expect(tools.nexus.command).toBe("nexus");
  });

  test("each entry carries its key, human name, and install URL", () => {
    const tools = detectExternalTools({} as NodeJS.ProcessEnv);
    expect(tools.rtk.key).toBe("rtk");
    expect(tools.rtk.installUrl).toBe("https://github.com/rtk-ai/rtk");
    expect(tools.graphify.installUrl).toBe("https://github.com/Graphify-Labs/graphify");
    expect(tools.nexus.installUrl).toBe("https://github.com/nexi-lab/nexus");
  });
});

describe("getExternalToolsSummary", () => {
  test("formats available tools as [OK] with version", () => {
    const fakeRtk = makeFakeBinary("rtk 0.9.0");
    const tools = detectExternalTools({
      CONTEXT_MODE_RTK_CMD: fakeRtk,
      CONTEXT_MODE_GRAPHIFY_CMD: "cm-definitely-not-a-real-binary-xyz",
      CONTEXT_MODE_NEXUS_CMD: "cm-definitely-not-a-real-binary-xyz",
    } as NodeJS.ProcessEnv);

    const lines = getExternalToolsSummary(tools);
    expect(lines.some((l) => l.startsWith("[OK] RTK (Rust Token Killer): "))).toBe(true);
    expect(lines.some((l) => l.includes("rtk 0.9.0"))).toBe(true);
  });

  test("formats missing tools as [WARN] with an install link", () => {
    const tools = detectExternalTools({
      CONTEXT_MODE_RTK_CMD: "cm-definitely-not-a-real-binary-xyz",
      CONTEXT_MODE_GRAPHIFY_CMD: "cm-definitely-not-a-real-binary-xyz",
      CONTEXT_MODE_NEXUS_CMD: "cm-definitely-not-a-real-binary-xyz",
    } as NodeJS.ProcessEnv);

    const lines = getExternalToolsSummary(tools);
    for (const line of lines) {
      expect(line).toMatch(/^\[WARN\] .+: not found — optional, powers ctx_adaptive_rag\. Install: https:\/\/github\.com\/.+/);
    }
  });
});
