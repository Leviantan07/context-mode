import { describe, it, expect } from "vitest";
import { resolveTypeScriptSymbols, resolvePythonSymbols, findSymbol, detectLanguage } from "../../src/semantic/symbol-resolver.js";
import { execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TS_SAMPLE = `
import { readFileSync } from "node:fs";

interface Options {
  timeout: number;
}

/** Processes a request. */
function process_request(url: string, timeout: number = 10): string {
  const label = "processing";
  return label + url + timeout;
}

class Handler {
  private count: number = 0;

  handle(req: string): void {
    this.count++;
  }
}
`;

describe("detectLanguage", () => {
  it("maps extensions to languages", () => {
    expect(detectLanguage("foo.ts")).toBe("typescript");
    expect(detectLanguage("foo.tsx")).toBe("typescript");
    expect(detectLanguage("foo.js")).toBe("javascript");
    expect(detectLanguage("foo.py")).toBe("python");
    expect(detectLanguage("foo.rb")).toBeNull();
  });
});

describe("resolveTypeScriptSymbols", () => {
  const symbols = resolveTypeScriptSymbols("sample.ts", TS_SAMPLE);

  it("finds the function with an exact span and signature", () => {
    const fn = symbols.find((s) => s.kind === "function" && s.name === "process_request");
    expect(fn).toBeDefined();
    expect(TS_SAMPLE.slice(fn!.start, fn!.end)).toContain("function process_request");
    expect(fn!.signature).toContain("timeout: number = 10");
  });

  it("finds parameters nested under the function path", () => {
    const param = symbols.find((s) => s.kind === "parameter" && s.path === "process_request.timeout");
    expect(param).toBeDefined();
  });

  it("finds the class and its method with a dotted path", () => {
    const method = symbols.find((s) => s.kind === "method" && s.path === "Handler.handle");
    expect(method).toBeDefined();
    expect(TS_SAMPLE.slice(method!.start, method!.end)).toContain("handle(req: string)");
  });

  it("finds the import and interface", () => {
    expect(symbols.some((s) => s.kind === "import")).toBe(true);
    expect(symbols.some((s) => s.kind === "interface" && s.name === "Options")).toBe(true);
  });

  it("finds string and comment symbols", () => {
    expect(symbols.some((s) => s.kind === "string" && s.name === "processing")).toBe(true);
    expect(symbols.some((s) => s.kind === "comment")).toBe(true);
  });
});

describe("findSymbol", () => {
  const symbols = resolveTypeScriptSymbols("sample.ts", TS_SAMPLE);

  it("resolves exact name match", () => {
    const match = findSymbol(symbols, "process_request");
    expect(match?.kind).toBe("function");
  });

  it("resolves dotted parameter query", () => {
    const match = findSymbol(symbols, "process_request.timeout");
    expect(match?.kind).toBe("parameter");
  });

  it("resolves kind-filtered query", () => {
    const match = findSymbol(symbols, "method:handle");
    expect(match?.kind).toBe("method");
    expect(match?.path).toBe("Handler.handle");
  });

  it("returns null when nothing matches", () => {
    expect(findSymbol(symbols, "does_not_exist_anywhere")).toBeNull();
  });
});

const hasPython = (() => {
  try {
    execFileSync("python3", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasPython)("resolvePythonSymbols", () => {
  it("resolves functions, classes, parameters and imports via the ast module", () => {
    const src = [
      "import os",
      "",
      "class Handler:",
      "    def process_request(self, url, timeout=10):",
      "        label = 'processing'",
      "        return label",
      "",
    ].join("\n");
    const tmp = join(tmpdir(), `ctx-semantic-test-${Date.now()}.py`);
    writeFileSync(tmp, src, "utf8");
    try {
      const symbols = resolvePythonSymbols("python3", tmp);
      const method = symbols.find((s) => s.kind === "method" && s.name === "process_request");
      expect(method).toBeDefined();
      expect(src.slice(method!.start, method!.end)).toContain("def process_request");

      const param = symbols.find((s) => s.kind === "parameter" && s.name === "timeout");
      expect(param).toBeDefined();

      expect(symbols.some((s) => s.kind === "class" && s.name === "Handler")).toBe(true);
      expect(symbols.some((s) => s.kind === "import")).toBe(true);
    } finally {
      unlinkSync(tmp);
    }
  });
});
