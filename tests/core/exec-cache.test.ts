/**
 * Unit tests for the exec-cache module: TTL cache store + isCacheable()
 * heuristic that decides which sandboxed runs are safe to memoize.
 *
 * Run: npx vitest run tests/core/exec-cache.test.ts
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import {
  isCacheable,
  execCacheKey,
  getExecCache,
  setExecCache,
  clearExecCache,
  execCacheSize,
  execCacheTtlMs,
} from "../../src/exec-cache.js";

beforeEach(() => clearExecCache());
afterEach(() => {
  clearExecCache();
  delete process.env.CTX_EXEC_CACHE_TTL_MS;
});

describe("execCacheKey", () => {
  test("identical parts produce identical keys", () => {
    expect(execCacheKey(["shell", "ls -la"])).toBe(execCacheKey(["shell", "ls -la"]));
  });

  test("different parts produce different keys", () => {
    expect(execCacheKey(["shell", "ls -la"])).not.toBe(execCacheKey(["shell", "ls -l"]));
  });

  test("undefined and empty string are distinct enough not to collide with adjacent-field shift", () => {
    // ["a", undefined] vs [undefined, "a"] must differ (guards separator soundness)
    expect(execCacheKey(["a", undefined])).not.toBe(execCacheKey([undefined, "a"]));
  });

  test("field boundary is not ambiguous (ab|c vs a|bc)", () => {
    expect(execCacheKey(["ab", "c"])).not.toBe(execCacheKey(["a", "bc"]));
  });
});

describe("cache store get/set/TTL/eviction", () => {
  test("set then get returns the entry", () => {
    const key = execCacheKey(["shell", "echo hi"]);
    setExecCache(key, { stdout: "hi", stderr: "", exitCode: 0 });
    const got = getExecCache(key);
    expect(got).not.toBeNull();
    expect(got!.stdout).toBe("hi");
    expect(got!.exitCode).toBe(0);
  });

  test("miss returns null", () => {
    expect(getExecCache(execCacheKey(["shell", "never-run"]))).toBeNull();
  });

  test("entry past TTL is evicted on read", async () => {
    process.env.CTX_EXEC_CACHE_TTL_MS = "20";
    expect(execCacheTtlMs()).toBe(20);
    const key = execCacheKey(["shell", "echo ttl"]);
    setExecCache(key, { stdout: "ttl", stderr: "", exitCode: 0 });
    expect(getExecCache(key)).not.toBeNull();
    await new Promise((r) => setTimeout(r, 40));
    expect(getExecCache(key)).toBeNull();
  });

  test("oversized stdout is not cached", () => {
    const key = execCacheKey(["shell", "huge"]);
    const big = "x".repeat(600 * 1024); // > 512KB cap
    setExecCache(key, { stdout: big, stderr: "", exitCode: 0 });
    expect(getExecCache(key)).toBeNull();
  });

  test("clearExecCache empties the store", () => {
    setExecCache(execCacheKey(["shell", "a"]), { stdout: "a", stderr: "", exitCode: 0 });
    expect(execCacheSize()).toBe(1);
    clearExecCache();
    expect(execCacheSize()).toBe(0);
  });
});

describe("isCacheable — shell", () => {
  test.each([
    "ls -la",
    "cat package.json",
    "grep foo bar.txt",
    "git status",
    "git log --oneline -10",
    "git diff HEAD",
    "echo hello",
    "wc -l file.txt",
    "find . -name '*.ts'",
    "node -e 'console.log(1+1)'",
    "npm ls",
    "cat a.txt 2>&1",
  ])("read-only command is cacheable: %s", (cmd) => {
    expect(isCacheable("shell", cmd).cacheable).toBe(true);
  });

  test.each([
    "rm -rf build",
    "mv a b",
    "cp a b",
    "mkdir out",
    "touch x",
    "chmod +x run.sh",
    "sed -i 's/a/b/' f",
    "git commit -m x",
    "git push origin main",
    "git checkout -b feature",
    "npm install",
    "pnpm add lodash",
    "pip install requests",
    "docker build .",
    "kubectl apply -f x.yaml",
    "echo hi > out.txt",
    "echo hi >> out.txt",
    "cat a | tee b",
    "curl -X POST https://api.example.com",
    "apt-get install curl",
  ])("mutating command is NOT cacheable: %s", (cmd) => {
    expect(isCacheable("shell", cmd).cacheable).toBe(false);
  });

  test.each([
    "date",
    "echo $RANDOM",
    "uuidgen",
    "openssl rand -hex 16",
    "mktemp",
  ])("non-deterministic command is NOT cacheable: %s", (cmd) => {
    expect(isCacheable("shell", cmd).cacheable).toBe(false);
  });

  test("2>&1 fd-dup does not trigger the redirect guard", () => {
    expect(isCacheable("shell", "make 2>&1").cacheable).toBe(true);
  });
});

describe("isCacheable — javascript/typescript", () => {
  test("pure computation is cacheable", () => {
    expect(isCacheable("javascript", "console.log([1,2,3].reduce((a,b)=>a+b,0))").cacheable).toBe(true);
  });

  test("read-only fs is cacheable", () => {
    expect(isCacheable("javascript", "const fs=require('fs');console.log(fs.readFileSync('a').length)").cacheable).toBe(true);
  });

  test.each([
    "require('fs').writeFileSync('a','b')",
    "fs.appendFileSync('log','x')",
    "fs.rmSync('dir',{recursive:true})",
    "fs.mkdirSync('out')",
    "await fetch('http://x', { method: 'POST' })",
  ])("mutating JS is NOT cacheable: %s", (code) => {
    expect(isCacheable("javascript", code).cacheable).toBe(false);
  });

  test.each([
    "console.log(Math.random())",
    "console.log(Date.now())",
    "console.log(new Date())",
    "console.log(crypto.randomUUID())",
    "console.log(performance.now())",
  ])("non-deterministic JS is NOT cacheable: %s", (code) => {
    expect(isCacheable("javascript", code).cacheable).toBe(false);
  });

  test("embedded shell mutation via child_process is caught", () => {
    expect(isCacheable("javascript", "require('child_process').execSync('rm -rf /tmp/x')").cacheable).toBe(false);
  });

  test("typescript is treated like javascript", () => {
    expect(isCacheable("typescript", "const x: number = 1; console.log(x)").cacheable).toBe(true);
    expect(isCacheable("typescript", "writeFileSync('a','b')").cacheable).toBe(false);
  });
});

describe("isCacheable — other languages", () => {
  test("pure python is cacheable", () => {
    expect(isCacheable("python", "print(sum(range(10)))").cacheable).toBe(true);
  });

  test.each([
    ["python", "import time; print(time.time())"],
    ["python", "import random; print(random.randint(1,9))"],
    ["python", "print(open('f','w'))"],
    ["python", "import os; os.remove('x')"],
    ["ruby", "puts SecureRandom.hex"],
    ["rust", "std::fs::write(\"a\", b\"x\").unwrap();"],
  ])("mutating/non-deterministic %s is NOT cacheable", (lang, code) => {
    expect(isCacheable(lang, code).cacheable).toBe(false);
  });

  test("embedded shell-out in python is caught", () => {
    expect(isCacheable("python", "import os; os.system('rm -rf build')").cacheable).toBe(false);
  });
});
