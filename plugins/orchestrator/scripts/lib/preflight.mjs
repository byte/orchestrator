import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isInitialized } from "./state.mjs";
import { SUPERVISOR_GIT_ARGS } from "./git.mjs";
import { findCodexCompanion, pluginLimitations } from "./codex-plugin.mjs";
import { listLanes } from "./lanes.mjs";
import { isGitRepository, resolveWorkspaceRoot } from "./workspace.mjs";

/**
 * Run a probe and merge both streams. `codex login status` reports on stderr, so
 * reading stdout alone yields an empty string that looks like a passing check.
 */
function tryExec(command, args, cwd) {
  const probe = spawnSync(command, args, {
    cwd,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 15000
  });

  const output = `${probe.stdout ?? ""}\n${probe.stderr ?? ""}`.trim();
  return {
    ok: !probe.error && probe.status === 0,
    stdout: probe.stdout ?? "",
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

/**
 * Not blocking: read and verify tasks run in the checkout as it is. A write task
 * cannot launch until the checkout is clean, so say so before anyone plans one.
 */
function checkCleanCheckout(cwd) {
  if (!isGitRepository(cwd)) {
    return null;
  }
  const probe = tryExec("git", [...SUPERVISOR_GIT_ARGS, "status", "--porcelain", "-z", "--untracked-files=all"], cwd);
  if (!probe.ok) return { id: "clean_checkout", label: "Checkout clean", ok: false, warning: true,
    detail: "unknown; Git status could not be read", remedy: "inspect Git status manually" };
  // Porcelain rename/copy records have a second, undecorated path. Count the
  // changed entry once; never include orchestrator's own bookkeeping.
  const dirty = [];
  const records = probe.stdout.split("\0").filter(Boolean);
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record.slice(3).startsWith(".orchestrator/")) dirty.push(record);
    if (/[RC]/.test(record.slice(0, 2))) index += 1;
  }
  return {
    id: "clean_checkout",
    label: "Checkout clean",
    ok: dirty.length === 0,
    warning: true,
    detail: dirty.length === 0
      ? "write tasks can launch"
      : `${dirty.length} uncommitted file${dirty.length === 1 ? "" : "s"}; read and verify tasks run as is, write tasks will not launch until it is committed or stashed`,
    remedy: "git commit or git stash"
  };
}

function checkInitialized(cwd) {
  const ok = isInitialized(cwd);
  return {
    id: "initialized",
    label: "Orchestrator initialized",
    ok,
    detail: ok ? ".orchestrator/ present" : ".orchestrator/ not created yet",
    remedy: "/orchestrator:init"
  };
}

export function preflight(cwd = process.cwd()) {
  const pluginPath = fileURLToPath(new URL("../../", import.meta.url));
  const plugin = JSON.parse(fs.readFileSync(new URL("../../.claude-plugin/plugin.json", import.meta.url), "utf8"));
  const setupLanes = isInitialized(cwd) ? listLanes(cwd).filter((lane) => lane.setup) : [];
  const checks = [
    { id: "plugin", label: "Executing plugin copy", ok: true, detail: `${plugin.version} at ${pluginPath}; reload/update the installed copy if this is not the expected path` },
    checkCodexBinary(),
    checkCodexAuth(),
    checkGit(cwd),
    { id: "node-version", label: "Node version", ok: true, detail: process.version },
    checkGitVersion(cwd),
    checkPendingGitOperations(cwd),
    checkInitialized(cwd),
    checkCleanCheckout(cwd),
    { id: "setup", label: "Worktree setup", ok: true, detail: setupLanes.length
      ? setupLanes.map((lane) => `${lane.name}: configured, network ${lane.setup.network ? "enabled" : "disabled"}`).join("; ")
      : "not configured; ignored dependencies are not copied and write worktrees need manual setup or lane --setup" },
    { id: "executors", label: "Executor capabilities", ok: true, detail: "cli: structured output, explicit resume, ignore-rules, probed private read scratch (fallback may lack it); codex-plugin: optional companion, weaker guarantees; see executorCapabilities in JSON and docs/compatibility.md" },
    { id: "certification", label: "Environment certification", ok: false, optional: true, detail: "unknown; version and installation discovery are not containment or live-model certification; preflight makes no model calls" },
    { id: "sandbox", label: "Sandbox capabilities", ok: false, optional: true, detail: "not checked by preflight; worker launch probes read scratch isolation, required checks/setup use codex sandbox without a model call" }
  ].filter(Boolean);

  // The default CLI executor needs no Claude-side Codex plugin.
  const blocking = checks.filter(
    (check) => !check.ok && check.id !== "initialized" && !check.optional && !check.warning
  );

  return { ok: blocking.length === 0, blocking, checks, executorCapabilities: executorCapabilities(), certification: "unknown" };
}

function checkGitVersion(cwd) {
  const probe = tryExec("git", ["--version"], cwd);
  return { id: "git-version", label: "Git version", ok: probe.ok, detail: probe.output || "unknown" };
}

function checkPendingGitOperations(cwd) {
  if (!isGitRepository(cwd)) return null;
  const pending = [];
  for (const name of ["sequencer", "CHERRY_PICK_HEAD", "MERGE_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "index.lock"]) {
    const probe = tryExec("git", [...SUPERVISOR_GIT_ARGS, "rev-parse", "--git-path", name], cwd);
    if (!probe.ok) return { id: "git-operations", label: "Pending Git operations", ok: false, warning: true, detail: "unknown; inspect Git state manually" };
    if (fs.existsSync(path.resolve(cwd, probe.stdout.trim()))) pending.push(name);
  }
  return { id: "git-operations", label: "Pending Git operations", ok: pending.length === 0, warning: true,
    detail: pending.length ? `present: ${pending.join(", ")}; preserve checkout and inspect before write launch/integration` : "none detected",
    remedy: "inspect Git state; do not remove locks or abort operations automatically" };
}

/** Discovery only: never invoke the companion, install software, or certify it. */
export function executorCapabilities() {
  return {
    cli: {
      default: true,
      certification: "unknown",
      capabilities: ["structured output schema", "explicit thread resume", "saved approval rules ignored", "private read scratch probed at launch"],
      limitations: ["private read scratch can fall back to plain read-only", "model availability and OS containment require opt-in verification"]
    },
    "codex-plugin": {
      default: false,
      companionFound: Boolean(findCodexCompanion()),
      certification: "unknown",
      capabilities: ["background task/status/result/cancel protocol"],
      limitations: [...pluginLimitations("read"), "efforts above xhigh are stepped down to xhigh", "companion presence does not verify its version or protocol compatibility"]
    }
  };
}
