/**
 * Detection for optional external tools context-mode can hand off to:
 *   - rtk        — token compression, used to shrink ctx_adaptive_rag backend output
 *   - gitnexus   — code knowledge-graph indexer + hybrid (BM25 + semantic + RRF) search;
 *                  powers BOTH ctx_adaptive_rag's "graph" backend (gitnexus trace) and
 *                  its "semantic" backend (gitnexus query). Replaces the earlier
 *                  graphify/nexus split — GitNexus covers what those two did between
 *                  them, with a documented, confirmed CLI.
 *   - pxpipe     — local proxy that renders bulky context as images to cut API token
 *                  cost; NOT a retrieval backend (returns nothing to search), so it is
 *                  managed by its own ctx_pxpipe_status/start/stop tools instead of
 *                  ctx_adaptive_rag's routing.
 * None are required — context-mode's built-in FTS5 keyword search is always the
 * ctx_adaptive_rag fallback.
 *
 * Each tool's binary name is overridable via env var so a differently-named
 * install (or a CLI surface that drifts from our best-guess defaults) doesn't
 * require a code change.
 */
import { execFileSync } from "node:child_process";

export interface ExternalToolInfo {
  key: "rtk" | "gitnexus" | "pxpipe";
  name: string;
  command: string;
  available: boolean;
  version: string;
  installUrl: string;
}

export interface ExternalToolsMap {
  rtk: ExternalToolInfo;
  gitnexus: ExternalToolInfo;
  pxpipe: ExternalToolInfo;
}

interface ToolSpec {
  key: ExternalToolInfo["key"];
  name: string;
  envVar: string;
  defaultCommand: string;
  installUrl: string;
}

const TOOL_SPECS: ToolSpec[] = [
  {
    key: "rtk",
    name: "RTK (Rust Token Killer)",
    envVar: "CONTEXT_MODE_RTK_CMD",
    defaultCommand: "rtk",
    installUrl: "https://github.com/rtk-ai/rtk",
  },
  {
    key: "gitnexus",
    name: "GitNexus",
    envVar: "CONTEXT_MODE_GITNEXUS_CMD",
    defaultCommand: "gitnexus",
    installUrl: "https://github.com/abhigyanpatwari/GitNexus",
  },
  {
    key: "pxpipe",
    name: "pxpipe",
    envVar: "CONTEXT_MODE_PXPIPE_CMD",
    defaultCommand: "pxpipe",
    installUrl: "https://github.com/teamchong/pxpipe",
  },
];

/** Default host/port for the local pxpipe proxy dashboard, overridable via env. */
export function getPxpipeEndpoint(env: NodeJS.ProcessEnv = process.env): { host: string; port: number } {
  const host = env.CONTEXT_MODE_PXPIPE_HOST?.trim() || "127.0.0.1";
  const port = Number(env.CONTEXT_MODE_PXPIPE_PORT) || 47821;
  return { host, port };
}

/**
 * Command used to launch the pxpipe proxy (as documented: `npx pxpipe-proxy`).
 * Returned as argv parts (no shell) so ctx_pxpipe_start can spawn it directly.
 */
export function getPxpipeStartCommand(env: NodeJS.ProcessEnv = process.env): string[] {
  const override = env.CONTEXT_MODE_PXPIPE_START_CMD?.trim();
  const raw = override && override.length > 0 ? override : "npx pxpipe-proxy";
  return raw.split(/\s+/).filter(Boolean);
}

function probe(command: string): { available: boolean; version: string } {
  try {
    const out = execFileSync(command, ["--version"], {
      encoding: "utf-8",
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 2000,
    })
      .trim()
      .split(/\r?\n/)[0];
    return { available: true, version: out || "unknown" };
  } catch {
    return { available: false, version: "unknown" };
  }
}

/** Detects rtk/gitnexus/pxpipe on PATH (or at their env-var override path). */
export function detectExternalTools(env: NodeJS.ProcessEnv = process.env): ExternalToolsMap {
  const result = {} as ExternalToolsMap;
  for (const spec of TOOL_SPECS) {
    const override = env[spec.envVar]?.trim();
    const command = override && override.length > 0 ? override : spec.defaultCommand;
    const { available, version } = probe(command);
    result[spec.key] = {
      key: spec.key,
      name: spec.name,
      command,
      available,
      version,
      installUrl: spec.installUrl,
    };
  }
  return result;
}

const POWERS: Record<ExternalToolInfo["key"], string> = {
  rtk: "ctx_adaptive_rag",
  gitnexus: "ctx_adaptive_rag",
  pxpipe: "ctx_pxpipe_status / ctx_pxpipe_start",
};

/** Plain-text [OK]/[WARN] lines for ctx_doctor — mirrors existing doctor formatting. */
export function getExternalToolsSummary(tools: ExternalToolsMap): string[] {
  return (Object.values(tools) as ExternalToolInfo[]).map((info) =>
    info.available
      ? `[OK] ${info.name}: ${info.command} (${info.version})`
      : `[WARN] ${info.name}: not found — optional, powers ${POWERS[info.key]}. Install: ${info.installUrl}`,
  );
}
