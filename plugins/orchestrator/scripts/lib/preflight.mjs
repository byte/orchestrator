import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { isInitialized } from "./state.mjs";
import { isGitRepository, resolveWorkspaceRoot } from "./workspace.mjs";

const CODEX_PLUGIN_ID = "codex@openai-codex";

/**
 * Run a probe and merge both streams. `codex login status` reports on stderr, so
 * reading stdout alone yields an empty string that looks like a passing check.
 */
function tryExec(command, args) {
  const probe = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 15000
  });

  const output = `${probe.stdout ?? ""}\n${probe.stderr ?? ""}`.trim();
  return {
    ok: !probe.error && probe.status === 0,
    output: output || String(probe.error?.message ?? "").trim()
  };
}

function checkCodexBinary() {
  const probe = tryExec("codex", ["--version"]);
  return {
    id: "codex-cli",
    label: "Codex CLI installed",
    ok: probe.ok,
    detail: probe.ok ? probe.output : "codex was not found on PATH",
    remedy: "npm install -g @openai/codex"
  };
}

function checkCodexAuth() {
  const probe = tryExec("codex", ["login", "status"]);
  // Require positive evidence. Treating "no error" as authenticated would pass a
  // logged-out user straight through to a dispatch that then fails.
  const authenticated = probe.ok && /logged in/i.test(probe.output) && !/not logged in/i.test(probe.output);
  return {
    id: "codex-auth",
    label: "Codex authenticated",
    ok: authenticated,
    detail: probe.output || "could not determine Codex auth status",
    remedy: "!codex login"
  };
}

/**
 * There is no dependency field in the plugin manifest, so a hard requirement on
 * the Codex plugin can only be expressed as a runtime check.
 */
function checkCodexPlugin() {
  const manifest = path.join(os.homedir(), ".claude", "plugins", "installed_plugins.json");
  let installed = false;
  let detail = "no installed_plugins.json found";

  if (fs.existsSync(manifest)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(manifest, "utf8"));
      installed = Boolean(parsed?.plugins?.[CODEX_PLUGIN_ID]);
      detail = installed ? `${CODEX_PLUGIN_ID} installed` : `${CODEX_PLUGIN_ID} is not installed`;
    } catch (error) {
      detail = `could not read ${manifest}: ${error.message}`;
    }
  }

  return {
    id: "codex-plugin",
    label: "Legacy Codex bridge installed (optional)",
    ok: installed,
    optional: true,
    detail,
    remedy: "/plugin marketplace add openai/codex-plugin-cc  then  /plugin install codex@openai-codex"
  };
}

function checkGit(cwd) {
  const ok = isGitRepository(cwd);
  return {
    id: "git",
    label: "Inside a git repository",
    ok,
    detail: ok ? resolveWorkspaceRoot(cwd) : "not a git repository",
    remedy: "git init"
  };
}

function checkInitialized(cwd) {
  const ok = isInitialized(cwd);
  return {
    id: "initialized",
    label: "Orchestrator initialized",
    ok,
    detail: ok ? ".orchestrator/ present" : ".orchestrator/ not created yet",
    remedy: "/orch:init"
  };
}

export function preflight(cwd = process.cwd()) {
  const checks = [
    checkCodexBinary(),
    checkCodexAuth(),
    checkCodexPlugin(),
    checkGit(cwd),
    checkInitialized(cwd)
  ];

  // Native pool dispatch uses Codex CLI directly. The upstream Claude bridge is
  // optional and retained only for the legacy single-task /orch:do workflow.
  const blocking = checks.filter(
    (check) => !check.ok && check.id !== "initialized" && !check.optional
  );

  return { ok: blocking.length === 0, blocking, checks };
}
