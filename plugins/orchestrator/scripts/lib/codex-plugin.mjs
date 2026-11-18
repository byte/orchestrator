import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Support for running workers through the OpenAI Codex plugin for Claude Code
 * (`codex@openai-codex`) instead of invoking `codex exec` directly.
 *
 * The plugin drives Codex through its app-server, usually via a shared broker,
 * so the orchestrator's wrapper uses only the plugin's public job commands
 * (`task --background`, `status`, `result`, `cancel`): a stop then interrupts
 * the turn instead of leaving it running in the broker.
 */

export const EXECUTORS = Object.freeze(["cli", "codex-plugin"]);
export const DEFAULT_EXECUTOR = "cli";

/** Efforts the plugin's `task --effort` accepts (openai-codex 1.0.6). */
const PLUGIN_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh"]);

export function normalizeExecutor(value) {
  if (value === undefined || value === null || value === "") {
    return DEFAULT_EXECUTOR;
  }
  const executor = String(value).trim().toLowerCase();
  if (!EXECUTORS.includes(executor)) {
    throw new Error(`Unknown executor "${value}". Use one of: ${EXECUTORS.join(", ")}.`);
  }
  return executor;
}

/**
 * The plugin tops out at `xhigh`. A higher route runs at `xhigh` and says so;
 * it is never refused, as an unavailable model is substituted rather than failed.
 */
export function pluginEffort(effort) {
  const requested = String(effort ?? "").toLowerCase();
  if (!requested || PLUGIN_EFFORTS.has(requested)) {
    return { effort: requested || null, stepped: false };
  }
  return { effort: "xhigh", stepped: true, requested };
}

function installedPluginsFile() {
  const base = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  return path.join(base, "plugins", "installed_plugins.json");
}

/**
 * The plugin's `codex-companion.mjs`: `ORCHESTRATOR_CODEX_COMPANION` when set,
 * otherwise the installed `codex@openai-codex` plugin. Returns null when absent.
 */
export function findCodexCompanion() {
  const override = process.env.ORCHESTRATOR_CODEX_COMPANION;
  if (override) {
    return fs.existsSync(override) ? path.resolve(override) : null;
  }
  let installed;
  try {
    installed = JSON.parse(fs.readFileSync(installedPluginsFile(), "utf8"));
  } catch {
    return null;
  }
  const entries = installed?.plugins?.["codex@openai-codex"] ?? installed?.["codex@openai-codex"] ?? [];
  for (const entry of Array.isArray(entries) ? entries : [entries]) {
    const script = entry?.installPath && path.join(entry.installPath, "scripts", "codex-companion.mjs");
    if (script && fs.existsSync(script)) {
      return script;
    }
  }
  return null;
}

/** What the plugin path does not guarantee, recorded on every attempt that uses it. */
export function pluginLimitations(kind) {
  return [
    "output schema not enforced by Codex; the result is parsed from the final message",
    "saved Codex approval rules are not ignored (no --ignore-rules)",
    ...(kind === "write" ? [] : ["read sandbox has no private writable TMPDIR"]),
    "warm resume uses the plugin's most recent thread for the worktree",
    "cancel interrupts the turn, but a command already running in the plugin's shared app-server runs until it ends"
  ];
}
