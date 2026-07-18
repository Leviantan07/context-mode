/**
 * Detection tests for optional external tools (rtk / gitnexus / pxpipe).
 * Uses real subprocess spawns against tiny fake executables rather than
 * mocking node:child_process, so the test exercises the actual
 * execFileSync probe path (PATH lookup, --version parsing, timeout).
 */
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { detectExternalTools, getExternalToolsSummary, getPxpipeEndpoint, getPxpipeStartCommand } from "../../src/external-tools.js";

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
      CONTEXT_MODE_GITNEXUS_CMD: "cm-definitely-not-a-real-binary-xyz",
      CONTEXT_MODE_PXPIPE_CMD: "cm-definitely-not-a-real-binary-xyz",
    } as NodeJS.ProcessEnv);

    expect(tools.rtk.available).toBe(false);
    expect(tools.gitnexus.available).toBe(false);
    expect(tools.pxpipe.available).toBe(false);
    expect(tools.rtk.version).toBe("unknown");
  });

  test("honors env var override and parses --version output when the binary exists", () => {
    const fakeGitnexus = makeFakeBinary("gitnexus 1.2.3");
    const tools = detectExternalTools({
      CONTEXT_MODE_RTK_CMD: "cm-definitely-not-a-real-binary-xyz",
      CONTEXT_MODE_GITNEXUS_CMD: fakeGitnexus,
      CONTEXT_MODE_PXPIPE_CMD: "cm-definitely-not-a-real-binary-xyz",
    } as NodeJS.ProcessEnv);

    expect(tools.gitnexus.available).toBe(true);
    expect(tools.gitnexus.command).toBe(fakeGitnexus);
    expect(tools.gitnexus.version).toBe("gitnexus 1.2.3");
    expect(tools.rtk.available).toBe(false);
  });

  test("defaults to the bare command name when no env override is set", () => {
    const tools = detectExternalTools({} as NodeJS.ProcessEnv);
    expect(tools.rtk.command).toBe("rtk");
    expect(tools.gitnexus.command).toBe("gitnexus");
    expect(tools.pxpipe.command).toBe("pxpipe");
  });

  test("each entry carries its key, human name, and install URL", () => {
    const tools = detectExternalTools({} as NodeJS.ProcessEnv);
    expect(tools.rtk.key).toBe("rtk");
    expect(tools.rtk.installUrl).toBe("https://github.com/rtk-ai/rtk");
    expect(tools.gitnexus.key).toBe("gitnexus");
    expect(tools.gitnexus.installUrl).toBe("https://github.com/abhigyanpatwari/GitNexus");
    expect(tools.pxpipe.key).toBe("pxpipe");
    expect(tools.pxpipe.installUrl).toBe("https://github.com/teamchong/pxpipe");
  });
});

describe("getExternalToolsSummary", () => {
  test("formats available tools as [OK] with version", () => {
    const fakeRtk = makeFakeBinary("rtk 0.9.0");
    const tools = detectExternalTools({
      CONTEXT_MODE_RTK_CMD: fakeRtk,
      CONTEXT_MODE_GITNEXUS_CMD: "cm-definitely-not-a-real-binary-xyz",
      CONTEXT_MODE_PXPIPE_CMD: "cm-definitely-not-a-real-binary-xyz",
    } as NodeJS.ProcessEnv);

    const lines = getExternalToolsSummary(tools);
    expect(lines.some((l) => l.startsWith("[OK] RTK (Rust Token Killer): "))).toBe(true);
    expect(lines.some((l) => l.includes("rtk 0.9.0"))).toBe(true);
  });

  test("formats missing tools as [WARN] with an install link, naming the feature each powers", () => {
    const tools = detectExternalTools({
      CONTEXT_MODE_RTK_CMD: "cm-definitely-not-a-real-binary-xyz",
      CONTEXT_MODE_GITNEXUS_CMD: "cm-definitely-not-a-real-binary-xyz",
      CONTEXT_MODE_PXPIPE_CMD: "cm-definitely-not-a-real-binary-xyz",
    } as NodeJS.ProcessEnv);

    const lines = getExternalToolsSummary(tools);
    for (const line of lines) {
      expect(line).toMatch(/^\[WARN\] .+: not found — optional, powers .+\. Install: https:\/\/github\.com\/.+/);
    }
    expect(lines.some((l) => l.includes("powers ctx_adaptive_rag"))).toBe(true);
    expect(lines.some((l) => l.includes("powers ctx_pxpipe_status / ctx_pxpipe_start"))).toBe(true);
  });
});

describe("getPxpipeEndpoint", () => {
  test("defaults to 127.0.0.1:47821", () => {
    expect(getPxpipeEndpoint({} as NodeJS.ProcessEnv)).toEqual({ host: "127.0.0.1", port: 47821 });
  });

  test("honors CONTEXT_MODE_PXPIPE_HOST / CONTEXT_MODE_PXPIPE_PORT overrides", () => {
    expect(
      getPxpipeEndpoint({ CONTEXT_MODE_PXPIPE_HOST: "0.0.0.0", CONTEXT_MODE_PXPIPE_PORT: "9999" } as NodeJS.ProcessEnv),
    ).toEqual({ host: "0.0.0.0", port: 9999 });
  });

  test("falls back to the default port on a non-numeric override", () => {
    expect(getPxpipeEndpoint({ CONTEXT_MODE_PXPIPE_PORT: "not-a-port" } as NodeJS.ProcessEnv).port).toBe(47821);
  });
});

describe("getPxpipeStartCommand", () => {
  test("defaults to ['npx', 'pxpipe-proxy']", () => {
    expect(getPxpipeStartCommand({} as NodeJS.ProcessEnv)).toEqual(["npx", "pxpipe-proxy"]);
  });

  test("honors CONTEXT_MODE_PXPIPE_START_CMD and splits on whitespace", () => {
    expect(
      getPxpipeStartCommand({ CONTEXT_MODE_PXPIPE_START_CMD: "pxpipe proxy --port 9999" } as NodeJS.ProcessEnv),
    ).toEqual(["pxpipe", "proxy", "--port", "9999"]);
  });
});
