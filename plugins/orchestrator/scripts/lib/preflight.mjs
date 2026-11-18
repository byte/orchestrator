import { spawnSync } from "node:child_process";

import { isInitialized } from "./state.mjs";
import { changedFiles } from "./git.mjs";
import { isGitRepository, resolveWorkspaceRoot } from "./workspace.mjs";

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
  let dirty;
  try {
    dirty = changedFiles(cwd);
  } catch {
    return null;
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
  const checks = [
    checkCodexBinary(),
    checkCodexAuth(),
    checkGit(cwd),
    checkInitialized(cwd),
    checkCleanCheckout(cwd)
  ].filter(Boolean);

  // Pool dispatch invokes Codex CLI directly; no Claude-side Codex plugin is needed.
  const blocking = checks.filter(
    (check) => !check.ok && check.id !== "initialized" && !check.optional && !check.warning
  );

  return { ok: blocking.length === 0, blocking, checks };
}
