/**
 * semantic/memory — PatchMemory.
 *
 * Append-only, JSON-file-backed record of past patches: which strategy was
 * picked, whether it compiled, whether review passed, whether it had to be
 * rolled back. `getStats()` lets the engine (and `ctx_semantic_patch_stats`)
 * see which strategies actually work for a given language/project, so
 * future patches can be biased toward what has historically succeeded here.
 *
 * Deliberately a flat JSON array rather than SQLite: entries are small,
 * volume is low (one per patch, not per file), and it keeps this module
 * dependency-free (no better-sqlite3 requirement) for callers that only
 * want read-only stats.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import type { PatchMemoryEntry, PatchMemoryStats, SymbolLanguage } from "./types.js";

const MAX_ENTRIES = 2000;

export class PatchMemory {
  constructor(private readonly filePath: string) {}

  private load(): PatchMemoryEntry[] {
    try {
      if (!existsSync(this.filePath)) return [];
      const raw = readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private save(entries: PatchMemoryEntry[]): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      const trimmed = entries.slice(-MAX_ENTRIES);
      const tmp = `${this.filePath}.tmp-${process.pid}`;
      writeFileSync(tmp, JSON.stringify(trimmed), "utf8");
      renameSync(tmp, this.filePath);
    } catch {
      /* best-effort — patch memory is a learning aid, never load-bearing */
    }
  }

  record(entry: PatchMemoryEntry): void {
    const entries = this.load();
    entries.push(entry);
    this.save(entries);
  }

  all(): PatchMemoryEntry[] {
    return this.load();
  }

  recentFailures(limit = 10): PatchMemoryEntry[] {
    return this.load()
      .filter((e) => e.rolledBack || !e.applied)
      .slice(-limit)
      .reverse();
  }

  getStats(filter: { language?: SymbolLanguage | "unknown"; strategy?: string } = {}): PatchMemoryStats {
    let entries = this.load();
    if (filter.language) entries = entries.filter((e) => e.language === filter.language);
    if (filter.strategy) entries = entries.filter((e) => e.strategy === filter.strategy);

    const totalPatches = entries.length;
    const succeeded = entries.filter((e) => e.applied && !e.rolledBack);
    const rolledBack = entries.filter((e) => e.rolledBack);
    const avgSize = entries.length
      ? entries.reduce((sum, e) => sum + e.metrics.charactersChanged, 0) / entries.length
      : 0;

    const byStrategy: PatchMemoryStats["byStrategy"] = {};
    for (const e of entries) {
      const bucket = (byStrategy[e.strategy] ??= { count: 0, successRate: 0, avgScore: 0 });
      bucket.count++;
    }
    for (const strategy of Object.keys(byStrategy)) {
      const subset = entries.filter((e) => e.strategy === strategy);
      const ok = subset.filter((e) => e.applied && !e.rolledBack).length;
      byStrategy[strategy].successRate = subset.length ? ok / subset.length : 0;
      byStrategy[strategy].avgScore = subset.length ? subset.reduce((s, e) => s + e.score, 0) / subset.length : 0;
    }

    const byLanguage: PatchMemoryStats["byLanguage"] = {};
    for (const e of entries) {
      const bucket = (byLanguage[e.language] ??= { count: 0, successRate: 0 });
      bucket.count++;
    }
    for (const language of Object.keys(byLanguage)) {
      const subset = entries.filter((e) => e.language === language);
      const ok = subset.filter((e) => e.applied && !e.rolledBack).length;
      byLanguage[language].successRate = subset.length ? ok / subset.length : 0;
    }

    return {
      totalPatches,
      successRate: totalPatches ? succeeded.length / totalPatches : 0,
      rollbackRate: totalPatches ? rolledBack.length / totalPatches : 0,
      averagePatchSize: avgSize,
      byStrategy,
      byLanguage,
    };
  }
}
