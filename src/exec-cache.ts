/**
 * exec-cache — in-memory, session-scoped TTL cache for sandboxed execution
 * output (ctx_execute, ctx_batch_execute, ctx_execute_file).
 *
 * Mirrors the fetch-and-index TTL-cache pattern (fetch-cache.ts + the
 * getSourceMeta() check in server.ts) but for code execution: the exact
 * same (language, code[, path+mtime]) run twice within the TTL window is
 * served from memory instead of re-spawning a subprocess.
 *
 * "Intelligent" = cache eligibility is decided by isCacheable(), which
 * refuses anything that looks mutating or non-deterministic. Caching those
 * would silently replay stale or wrong output on the next identical call,
 * worse than not caching at all. The heuristic is deliberately conservative:
 * a false "not cacheable" only costs a re-execution (the safe failure mode);
 * a false "cacheable" could return a lie. When in doubt, don't cache.
 */

import { createHash } from "node:crypto";
import { extractShellCommands } from "./security.js";

// -----------------------------------------------------------
// Cache store
// -----------------------------------------------------------

export interface ExecCacheEntry {
  stdout: string;
  stderr: string;
  exitCode: number;
  cachedAt: number;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 min: local/CLI state changes faster than remote docs (24h fetch TTL)
const MAX_ENTRIES = 200;
const MAX_ENTRY_BYTES = 512 * 1024; // skip caching output too large to be worth the memory

/** TTL in ms, overridable via CTX_EXEC_CACHE_TTL_MS (mainly for tests). */
export function execCacheTtlMs(): number {
  const raw = process.env.CTX_EXEC_CACHE_TTL_MS;
  const parsed = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TTL_MS;
}

// Map iteration order == insertion order, reused for FIFO/LRU-ish eviction.
const cache = new Map<string, ExecCacheEntry>();

const KEY_SEPARATOR = String.fromCharCode(0);

export function execCacheKey(parts: (string | undefined)[]): string {
  return createHash("sha256").update(parts.map((p) => p ?? "").join(KEY_SEPARATOR)).digest("hex");
}

export function getExecCache(key: string): ExecCacheEntry | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > execCacheTtlMs()) {
    cache.delete(key);
    return null;
  }
  // Touch for recency so the eviction below is closer to LRU than FIFO.
  cache.delete(key);
  cache.set(key, entry);
  return entry;
}

export function setExecCache(key: string, entry: Omit<ExecCacheEntry, "cachedAt">): void {
  if (Buffer.byteLength(entry.stdout) > MAX_ENTRY_BYTES) return;
  cache.set(key, { ...entry, cachedAt: Date.now() });
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** Test/CLI hook: drop everything (e.g. between vitest cases). */
export function clearExecCache(): void {
  cache.clear();
}

export function execCacheSize(): number {
  return cache.size;
}

// -----------------------------------------------------------
// Cacheability heuristic
// -----------------------------------------------------------

export interface CacheabilityVerdict {
  cacheable: boolean;
  reason?: string;
}

// Shell-level mutation signals: checked against `shell` code directly and
// against every command string extracted from non-shell code (child_process,
// os.system, backticks, subprocess.run, ...) via extractShellCommands().
const SHELL_MUTATING_PATTERNS: RegExp[] = [
  /\brm\s/i,
  /\bmv\s/i,
  /\bcp\s/i,
  /\bmkdir\b/i,
  /\btouch\b/i,
  /\bchmod\b/i,
  /\bchown\b/i,
  /\bsed\s+-i\b/i,
  /\bgit\s+(commit|push|merge|rebase|reset|clean|checkout\s+-b|tag\s+-d|cherry-pick|stash\s+(pop|drop|clear)|apply|am)\b/i,
  /\b(npm|pnpm|yarn)\s+(install|i|add|remove|uninstall|publish|ci|update|upgrade|link|dedupe)\b/i,
  /\bpip\d?\s+(install|uninstall)\b/i,
  /\bdocker\s+(run|rm|stop|kill|build|push|exec|compose\s+(up|down))\b/i,
  /\bkubectl\s+(apply|delete|create|patch|scale|rollout|edit)\b/i,
  /\bkill\s/i,
  /\bpkill\b/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\bcurl\s+(-X|--request)\s*['"]?(POST|PUT|PATCH|DELETE)/i,
  /\bwget\s+.*-O\b/i,
  /\b(apt|apt-get|brew|yum|dnf)\s+(install|remove|upgrade)\b/i,
  /\btee\b/i,
  /\bdd\s+if=/i,
  />>?(?!=|&\d)/, // shell redirect (>, >>) - excludes >= and 2>&1 fd-dup noise
];

const SHELL_NONDETERMINISTIC_PATTERNS: RegExp[] = [
  /\bdate\b/i,
  /\$RANDOM\b/,
  /\buuidgen\b/i,
  /\bopenssl\s+rand\b/i,
  /\bmktemp\b/i,
];

// JS/TS-native mutation + non-determinism: checked against the raw code for
// direct API usage that never surfaces as a shell string.
const JS_MUTATING_PATTERNS: RegExp[] = [
  /\bfs\.(write|append|unlink|rm|mkdir|rename|chmod|chown|copyFile)(Sync)?\s*\(/,
  /\b(writeFileSync|appendFileSync|unlinkSync|rmSync|mkdirSync|renameSync|chmodSync|chownSync|copyFileSync)\s*\(/,
  /\bfetch\s*\([^)]*method\s*:\s*['"](POST|PUT|PATCH|DELETE)['"]/i,
];

const JS_NONDETERMINISTIC_PATTERNS: RegExp[] = [
  /\bMath\.random\s*\(/,
  /\bDate\.now\s*\(/,
  /\bnew\s+Date\s*\(\s*\)/,
  /\bcrypto\.randomUUID\s*\(/,
  /\bcrypto\.randomBytes\s*\(/,
  /\bperformance\.now\s*\(/,
  /\bprocess\.hrtime\s*\(/,
];

// Generic keyword-level checks applied to every other supported language
// (python, ruby, go, rust, php, perl, r, elixir). Coarser than the JS/shell
// buckets, but still keyword-anchored to keep false positives low.
const GENERIC_NONDETERMINISTIC_PATTERNS: RegExp[] = [
  /\btime\.time\s*\(/, // python
  /\bdatetime\.now\s*\(/i,
  /\brandom\.\w+\s*\(/i,
  /\bSecureRandom\b/,
  /\bos\.urandom\s*\(/,
  /\brand\(\)/i, // ruby/go/rust/php/perl Kernel#rand, rand.Intn, rand(), etc.
];

const GENERIC_MUTATING_PATTERNS: RegExp[] = [
  /\bopen\s*\([^)]*['"]w[ba]?['"]/i, // python/ruby open(path, "w")
  /\bFile\.(write|delete|rename|chmod)\b/i, // ruby
  /\bos\.(remove|rename|mkdir|chmod)\b/i, // python/go
  /\bstd::fs::(write|remove_file|create_dir|rename)\b/, // rust
  /\bunlink\s*\(/i,
];

function matchesAny(patterns: RegExp[], text: string): RegExp | undefined {
  return patterns.find((p) => p.test(text));
}

/**
 * Decide whether (language, code) is safe to memoize. Deliberately
 * conservative: prefers "not cacheable" over risking stale/non-deterministic
 * replay. Callers should treat a `false` verdict as "always execute fresh",
 * never as an error.
 */
export function isCacheable(language: string, code: string): CacheabilityVerdict {
  if (language === "shell") {
    const mutating = matchesAny(SHELL_MUTATING_PATTERNS, code);
    if (mutating) return { cacheable: false, reason: `mutating shell pattern: ${mutating}` };
    const nondet = matchesAny(SHELL_NONDETERMINISTIC_PATTERNS, code);
    if (nondet) return { cacheable: false, reason: `non-deterministic shell pattern: ${nondet}` };
    return { cacheable: true };
  }

  if (language === "javascript" || language === "typescript") {
    const mutating = matchesAny(JS_MUTATING_PATTERNS, code);
    if (mutating) return { cacheable: false, reason: `mutating JS pattern: ${mutating}` };
    const nondet = matchesAny(JS_NONDETERMINISTIC_PATTERNS, code);
    if (nondet) return { cacheable: false, reason: `non-deterministic JS pattern: ${nondet}` };
    // Also vet any embedded shell command (child_process.exec("rm -rf ..."), etc.)
    for (const shellCmd of extractShellCommands(code, language)) {
      const verdict = isCacheable("shell", shellCmd);
      if (!verdict.cacheable) return verdict;
    }
    return { cacheable: true };
  }

  // python/ruby/go/rust/php/perl/r/elixir
  const mutating = matchesAny(GENERIC_MUTATING_PATTERNS, code);
  if (mutating) return { cacheable: false, reason: `mutating pattern: ${mutating}` };
  const nondet = matchesAny(GENERIC_NONDETERMINISTIC_PATTERNS, code);
  if (nondet) return { cacheable: false, reason: `non-deterministic pattern: ${nondet}` };
  // Shell-outs (os.system, subprocess.run, backticks, Kernel#system, ...)
  for (const shellCmd of extractShellCommands(code, language)) {
    const verdict = isCacheable("shell", shellCmd);
    if (!verdict.cacheable) return verdict;
  }
  return { cacheable: true };
}
