/**
 * Detection for optional external RAG-adjacent tools that ctx_adaptive_rag can
 * route to when present: rtk (token compression), graphify (code knowledge
 * graph), nexus (multi-agent semantic search / memory). None are required —
 * context-mode's built-in FTS5 keyword search is always the fallback.
 *
 * Each tool's binary name is overridable via env var so a differently-named
 * install (or a CLI surface that drifts from our best-guess defaults) doesn't
 * require a code change.
 */
import { execFileSync } from "node:child_process";

export interface ExternalToolInfo {
  key: "rtk" | "graphify" | "nexus";
  name: string;
  command: string;
  available: boolean;
  version: string;
  installUrl: string;
}

export interface ExternalToolsMap {
  rtk: ExternalToolInfo;
  graphify: ExternalToolInfo;
  nexus: ExternalToolInfo;
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
    key: "graphify",
    name: "Graphify",
    envVar: "CONTEXT_MODE_GRAPHIFY_CMD",
    defaultCommand: "graphify",
    installUrl: "https://github.com/Graphify-Labs/graphify",
  },
  {
    key: "nexus",
    name: "Nexus",
    envVar: "CONTEXT_MODE_NEXUS_CMD",
    defaultCommand: "nexus",
    installUrl: "https://github.com/nexi-lab/nexus",
  },
];

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

/** Detects rtk/graphify/nexus on PATH (or at their env-var override path). */
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

/** Plain-text [OK]/[WARN] lines for ctx_doctor — mirrors existing doctor formatting. */
export function getExternalToolsSummary(tools: ExternalToolsMap): string[] {
  return Object.values(tools).map((info) =>
    info.available
      ? `[OK] ${info.name}: ${info.command} (${info.version})`
      : `[WARN] ${info.name}: not found — optional, powers ctx_adaptive_rag. Install: ${info.installUrl}`,
  );
}
