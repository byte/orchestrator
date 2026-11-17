#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { worktreeGitEnv } from "./lib/git.mjs";
import { removeTree, SCRATCH_OWNER_FILE } from "./lib/remove-tree.mjs";

function atomicWrite(filePath, payload) {
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
  fs.renameSync(temporary, filePath);
}

// Codex CLI 0.169.0 reports a thread id it has no rollout for (never existed, or
// its session files were removed) as exit 1, nothing on stdout, and on stderr:
//   Error: thread/resume: thread/resume failed: no rollout found for thread id <id> (code -32600)
// Observed 2026-11-15. "Expired" threads are assumed to fail the same way, since
// expiry means the rollout is gone; that case was inferred, not observed.
const MISSING_THREAD = /no rollout found|thread\/resume failed|(?:thread|session|conversation) not found/i;

const specPath = process.argv[2];
const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));
const startedAt = new Date().toISOString();
let threadId = null;
let childPid = null;
let resumeFallback = null;
let sandboxFallback = null;

// Every status write is numbered, so a poll that read an older snapshot cannot
// save it over a newer one another poll already synchronized.
let statusSeq = 0;

let currentStatus = "starting";

function writeStatus(fields) {
  statusSeq += 1;
  currentStatus = fields.status ?? currentStatus;
  atomicWrite(spec.statusFile, {
    seq: statusSeq,
    pid: process.pid,
    ...(childPid ? { childPid } : {}),
    startedAt,
    threadId,
    ...(spec.resumeThreadId ? { resumeThreadId: spec.resumeThreadId } : {}),
    ...(resumeFallback ? { resumeFallback } : {}),
    ...(sandboxFallback ? { sandboxFallback } : {}),
    ...(scratchDir ? { scratchDir } : {}),
    ...fields
  });
}

// A read-only worker still needs somewhere to put temporary files, or it cannot
// run the tests it is reviewing: Codex's `--sandbox read-only` denies every
// write, the system temp directory included. Instead of that flag, a read-only
// worker gets a permissions profile that extends Codex's built-in `:read-only`
// with write access to one private scratch directory, exported as TMPDIR. The
// worktree and everything else stay unwritable. `--sandbox` must be left out:
// when both are given, it wins over the profile (verified against Codex CLI
// 0.169.0). The scratch directory is removed when the wrapper exits, including
// on SIGTERM; one left by a hard kill is recorded in the status file for
// `run cleanup`.
//
// The profile name is fresh for every launch. Codex merges `-c` overrides into
// the user's config, so a fixed name would inherit any grants a user's config
// already gives a profile of that name, and the probe below could not see them.
const READ_PROFILE = `orchestrator-read-${crypto.randomBytes(8).toString("hex")}`;
const [command, ...prefixArgs] = spec.codexCommand;
const scratchDir = spec.sandbox === "read-only"
  ? fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "orch-worker-")))
  : null;
// `run cleanup` removes a scratch directory a hard-killed wrapper left behind
// only if it names this runner's status file, so a forged `scratchDir` cannot
// point it at an unrelated directory.
if (scratchDir) {
  fs.writeFileSync(path.join(scratchDir, SCRATCH_OWNER_FILE), path.resolve(spec.statusFile), { flag: "wx", mode: 0o600 });
}

// No worker may leave its sandbox. With a user config such as
// `approval_policy = "on-request"` and an automatic approvals reviewer, Codex lets
// the model run a command unsandboxed (`require_escalated`) once the reviewer
// approves it, so every launch pins `approval_policy="never"`. That alone is not
// enough: a persisted execpolicy rule (`~/.codex/rules/*.rules`, "always allow"
// prefixes such as `node`, `npm test` or `git commit`) runs a matching command
// outside the sandbox without asking, so no worker loads any rules. A write
// worker therefore cannot commit (`workspace-write` keeps `.git` read-only); this
// wrapper, outside the sandbox, commits its changes when Codex finishes.
const LOCKDOWN = ["-c", 'approval_policy="never"', "--ignore-rules"];

function readProfileArgs() {
  return [
    "-c",
    `default_permissions="${READ_PROFILE}"`,
    "-c",
    `permissions.${READ_PROFILE}.extends=":read-only"`,
    "-c",
    `permissions.${READ_PROFILE}.filesystem={${JSON.stringify(scratchDir)}="write"}`
  ];
}

function inside(parent, child) {
  let base;
  try {
    base = fs.realpathSync(parent);
  } catch {
    return false;
  }
  const relative = path.relative(base, child);
  // `..tmp` is a directory inside the parent; only `..` itself or `../…` leaves it.
  const leaves = relative === ".." || relative.startsWith(`..${path.sep}`);
  return relative === "" || (!leaves && !path.isAbsolute(relative));
}

// Without `--sandbox`, a read worker is read-only only if Codex applies the
// profile. A Codex that ignores or rejects it would fall back to the user's
// default permissions, which may be writable. So before the first launch the
// profile is proven on this machine with `codex sandbox`, under the same
// arguments, cwd, and TMPDIR: the scratch directory must be writable and the
// worktree must not, and the probe must exit cleanly. Anything else, including
// a probe that cannot run, falls back to plain `--sandbox read-only` and records
// why; that is always safe and only costs the worker its temp directory. The
// probe creates a randomly named file exclusively, so it never touches an
// existing one, and counts only a permission error as "not writable". It also
// requires Codex's network-disabled marker, as plain `--sandbox read-only` has
// no network either (checked by flag, so the probe itself sends nothing).
const PROBE_SCRIPT = [
  'const fs = require("fs"), path = require("path");',
  "const [scratch, checkout, name] = process.argv.slice(1);",
  "const writable = (dir) => { const file = path.join(dir, name);",
  '  try { fs.writeFileSync(file, "", { flag: "wx" }); } catch (error) {',
  '    return ["EPERM", "EACCES", "EROFS"].includes(error.code) ? false : `error:${error.code}`; }',
  "  fs.unlinkSync(file); return true; };",
  "process.stdout.write(JSON.stringify({ scratch: writable(scratch), checkout: writable(checkout),",
  '  network: process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? "off" : "on" }));'
].join("\n");

async function probeReadProfile() {
  // A scratch directory inside the worktree or the repository would make part
  // of the checkout writable, and a probe of the checkout root cannot see that.
  if (inside(spec.worktreePath, scratchDir) || inside(process.cwd(), scratchDir)) {
    return { reason: "scratch_inside_checkout", message: scratchDir };
  }
  const marker = `.orch-sandbox-probe-${crypto.randomBytes(8).toString("hex")}`;
  const result = await new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(
      command,
      [...prefixArgs, "sandbox", ...readProfileArgs(), "--", process.execPath, "-e", PROBE_SCRIPT,
        scratchDir, spec.worktreePath, marker],
      // Its own process group: a launcher (the npm `codex` script) runs the native
      // binary as a child, and killing only the launcher leaves that child holding
      // the pipes, so the probe would never close.
      { cwd: spec.worktreePath, env: { ...process.env, TMPDIR: scratchDir }, stdio: ["ignore", "pipe", "pipe"], detached: true }
    );
    let settled = false;
    const finish = (value) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        clearTimeout(grace);
        resolve(value);
      }
    };
    const killGroup = (signal) => {
      try {
        process.kill(-child.pid, signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          // Already gone.
        }
      }
    };
    let grace = null;
    // A stop or the timeout kills the whole group, and gives up waiting for the
    // pipes shortly after, so a descendant that survives cannot hang the wrapper.
    const abandon = (signal) => {
      killGroup(signal);
      grace ??= setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        finish({ code: null, signal, stdout, stderr });
      }, 2000);
    };
    current = { kill: (signal) => abandon(signal === "SIGINT" ? "SIGINT" : "SIGKILL") };
    const timer = setTimeout(() => abandon("SIGKILL"), 30000);
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => finish({ error, stdout, stderr }));
    child.on("close", (code, signal) => finish({ code, signal, stdout, stderr }));
  });
  current = null;
  let observed = null;
  try {
    observed = JSON.parse(result.stdout.trim().split("\n").at(-1));
  } catch {
    observed = null;
  }
  const clean = !result.error && result.code === 0 && !result.signal;
  if (clean && observed?.scratch === true && observed?.checkout === false && observed?.network === "off") {
    return null;
  }
  if (clean && observed?.scratch === true && observed?.checkout === false && observed?.network === "on") {
    return { reason: "network_enabled", message: "" };
  }
  if (clean && observed && observed.checkout === true) {
    return { reason: "checkout_writable", message: "" };
  }
  if (clean && observed && observed.checkout === false && observed.scratch === false) {
    return { reason: "scratch_denied", message: "" };
  }
  const detail = result.error?.message || result.stderr.trim().split("\n").at(-1) ||
    (observed ? JSON.stringify(observed) : "");
  return {
    reason: "probe_failed",
    message: `exit ${result.code ?? "none"}${result.signal ? ` (${result.signal})` : ""}: ${detail}`.slice(0, 500)
  };
}

function sandboxArgs() {
  if (!scratchDir || sandboxFallback) {
    return ["--sandbox", spec.sandbox, ...LOCKDOWN];
  }
  return [...readProfileArgs(), ...LOCKDOWN];
}

/**
 * Commit everything a write worker left in its worktree, from outside the
 * sandbox. The worktree is worker-controlled, so nothing in it may run here:
 * hooks are disabled (a worker could edit a hooks directory such as `.husky/`
 * that `core.hooksPath` points at) and so is signing, which could prompt.
 * Returns an error message, or null.
 */
function commitWorkerChanges() {
  // The git directory comes from the supervisor repository's records: the
  // worktree's `.git` pointer file is worker-controlled and could aim git at a
  // config the worker wrote (`core.fsmonitor`, say).
  if (!spec.gitDir) {
    return "no recorded git directory for the worktree; not committing";
  }
  // worktreeGitEnv also turns off hooks, fsmonitor, signing and submodule recursion.
  const git = (args) => spawnSync("git", args, {
    cwd: spec.worktreePath,
    encoding: "utf8",
    env: worktreeGitEnv(spec.worktreePath, spec.gitDir)
  });
  const add = git(["add", "-A"]);
  if (add.status !== 0) {
    return `git add failed: ${(add.stderr || add.error?.message || "").trim()}`;
  }
  // No textconv or external diff: the worker's .gitattributes apply, and could
  // select a configured diff program to run on files it wrote.
  if (git(["diff", "--cached", "--quiet", "--no-textconv", "--no-ext-diff"]).status === 0) {
    return null;
  }
  const commit = git(["commit", "--no-verify", "--quiet", "-m", spec.commitMessage || "Orchestrator worker changes"]);
  return commit.status === 0 ? null : `git commit failed: ${(commit.stderr || commit.error?.message || "").trim()}`;
}

/** commitWorkerChanges, with any exception (an unsupported Git, say) as its error. */
function commitOrError() {
  try {
    return commitWorkerChanges();
  } catch (error) {
    return `could not commit the worker's changes: ${error.message}`;
  }
}

/** Whether the worker's final message pauses for input rather than finishing. */
function pausedForInput() {
  try {
    const message = JSON.parse(fs.readFileSync(spec.lastMessageFile, "utf8"));
    return message?.needs_input != null;
  } catch {
    return false;
  }
}

writeStatus({ status: "running" });

const output = fs.createWriteStream(spec.outputFile, { flags: "a", mode: 0o600 });
const errors = fs.createWriteStream(spec.errorFile, { flags: "a", mode: 0o600 });

const prompt = fs.readFileSync(spec.promptFile);
// A resume after `run answer` sends only the answer, because the thread already
// holds the briefing. A fresh thread started in its place needs the full
// briefing instead, which the launcher writes to `fallbackPromptFile`.
const fallbackPrompt = spec.fallbackPromptFile ? fs.readFileSync(spec.fallbackPromptFile) : prompt;

// A resumed thread does not inherit its model, effort, or sandbox (verified against
// Codex CLI 0.169.0), so every launch passes all three explicitly. `-C` and the
// sandbox arguments are only accepted on `exec`, before `resume`.
function codexArgs(resumeThreadId) {
  const route = [
    "--model",
    spec.model,
    "-c",
    `model_reasoning_effort="${spec.reasoningEffort}"`
  ];
  const io = [
    "--json",
    "--output-schema",
    spec.schemaFile,
    "--output-last-message",
    spec.lastMessageFile
  ];
  const head = [...prefixArgs, "exec", "-C", spec.worktreePath, ...sandboxArgs()];
  return resumeThreadId
    ? [...head, "resume", ...route, ...io, resumeThreadId, "-"]
    : [...head, ...route, ...io, "-"];
}

let current = null;
let stopping = false;
function stopChild(signal = "SIGTERM") {
  if (stopping) {
    return;
  }
  stopping = true;
  try {
    current?.kill(signal);
  } catch {
    // Exit handling below records the final state.
  }
}
process.on("SIGTERM", () => stopChild("SIGTERM"));
process.on("SIGINT", () => stopChild("SIGINT"));

function runCodex(resumeThreadId, input = prompt) {
  return new Promise((resolveRun) => {
    // Its own process group, so a stop reaches every process Codex started (a
    // command it ran that still holds the pipes, say), not only the launcher.
    const child = spawn(command, codexArgs(resumeThreadId), {
      cwd: spec.worktreePath,
      env: scratchDir ? { ...process.env, TMPDIR: scratchDir } : process.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true
    });
    const timers = [];
    let settled = false;
    const resolve = (value) => {
      if (!settled) {
        settled = true;
        timers.forEach(clearTimeout);
        // Codex exiting does not end what it started (a command that ignores
        // SIGTERM and does not hold the pipes, say): kill whatever is left of
        // its group, however Codex ended. Once the wrapper exits, nothing else
        // would escalate a stop.
        killGroup("SIGKILL");
        resolveRun(value);
      }
    };
    const killGroup = (signal) => {
      try {
        process.kill(-child.pid, signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          // Already gone.
        }
      }
    };
    // A stop signals the group, kills it 5 s later if it is still there, and
    // stops waiting for the pipes 2 s after that, so a process that survives
    // even SIGKILL (it left the group) cannot keep the wrapper running.
    current = {
      kill: (signal) => {
        killGroup(signal);
        timers.push(setTimeout(() => {
          killGroup("SIGKILL");
          timers.push(setTimeout(() => {
            child.stdout.destroy();
            child.stderr.destroy();
            resolve({ code: null, signal: "SIGKILL", sawThread, stderrText, replacedWithoutBriefing });
          }, 2000));
        }, 5000));
      }
    };
    childPid = child.pid ?? childPid;
    // Recorded at once: if the wrapper is killed before Codex reports its
    // thread, a poll or cancel still knows which group to stop.
    if (child.pid) {
      writeStatus({ status: currentStatus });
    }
    let sawThread = false;
    let replacedWithoutBriefing = false;
    let stderrText = "";
    let buffered = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output.write(chunk);
      buffered += chunk;
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          if (event.type === "thread.started" && event.thread_id) {
            sawThread = true;
            threadId = event.thread_id;
            // A thread id Codex cannot parse as a UUID is not an error: Codex
            // silently starts a new thread instead (observed 2026-11-15). It is
            // recorded either way. When the input was the full briefing, the
            // attempt continues cold on that thread. When it was only an answer,
            // the new thread has no assignment, so it is stopped and the full
            // briefing is sent as a fresh thread, as for a missing thread.
            if (resumeThreadId && threadId !== resumeThreadId && !resumeFallback) {
              resumeFallback = {
                reason: "thread_replaced",
                message: `Codex started thread ${threadId} instead of resuming ${resumeThreadId}.`
              };
              if (input !== fallbackPrompt) {
                replacedWithoutBriefing = true;
                // Stop the whole group, with the same escalation as a cancel,
                // so a process holding the pipes cannot block the relaunch.
                current.kill("SIGTERM");
              }
            }
            writeStatus({ status: "running" });
          }
        } catch {
          // Preserve malformed output in the JSONL file; collection will report it.
        }
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderrText += chunk;
      errors.write(chunk);
    });
    child.stdin.on("error", () => {
      // A child that exits before reading the prompt is reported by its exit code.
    });
    child.stdin.end(input);
    child.on("error", (error) => resolve({ error }));
    // `close` rather than `exit`: stderr must be fully read before deciding
    // whether a failed resume reported a missing thread.
    child.on("close", (code, signal) => resolve({ code, signal, sawThread, stderrText, replacedWithoutBriefing }));
  });
}

function finishScratch() {
  if (!scratchDir) {
    return;
  }
  try {
    removeTree(scratchDir);
  } catch (error) {
    // Left for `run cleanup`; the worker's own result still stands.
    errors.write(`[orchestrator] could not remove scratch ${scratchDir}: ${error.message}\n`);
  }
}

if (scratchDir) {
  sandboxFallback = await probeReadProfile();
  if (sandboxFallback && !stopping) {
    errors.write(`[orchestrator] read profile not applied (${sandboxFallback.reason}); ` +
      "running under --sandbox read-only, without a writable TMPDIR.\n");
    writeStatus({ status: "running" });
  }
  if (stopping) {
    // Stopped while proving the profile: nothing was launched.
    writeStatus({ status: "cancelled", finishedAt: new Date().toISOString(), exitCode: null, signal: null });
    finishScratch();
    output.end();
    errors.end();
    process.exit(0);
  }
}

let result = await runCodex(spec.resumeThreadId ?? null);
if (
  spec.resumeThreadId &&
  !stopping &&
  !result.error &&
  result.code !== 0 &&
  !result.sawThread &&
  MISSING_THREAD.test(result.stderrText)
) {
  // The thread to resume is gone. The briefing is self-contained, so it runs as a
  // fresh thread in the same worktree (the full briefing when the resume carried
  // only an answer); the fallback is recorded in the status file and surfaced as
  // a `task.resume_fallback` run event.
  resumeFallback = {
    reason: "thread_missing",
    message: result.stderrText.trim().split("\n").at(-1).slice(0, 500)
  };
  errors.write("\n[orchestrator] resume failed; relaunching as a fresh thread.\n");
  writeStatus({ status: "running" });
  result = await runCodex(null, fallbackPrompt);
}

if (result.replacedWithoutBriefing && !stopping) {
  errors.write("\n[orchestrator] resume started a new thread; relaunching it with the full briefing.\n");
  // The stopped thread may have written a result before it was stopped; the
  // relaunch must stand on its own result or report none.
  fs.rmSync(spec.lastMessageFile, { force: true });
  writeStatus({ status: "running" });
  result = await runCodex(null, fallbackPrompt);
}

// A finished write worker's changes are committed for it; a paused one keeps
// them uncommitted for its resume, and a failed or stopped one is left as is.
const commitError = spec.sandbox === "workspace-write" && !result.error && !stopping &&
  result.code === 0 && !pausedForInput()
  ? commitOrError()
  : null;
if (commitError) {
  errors.write(`\n[orchestrator] ${commitError}\n`);
}

if (result.error || commitError) {
  writeStatus({
    status: "failed",
    finishedAt: new Date().toISOString(),
    error: result.error?.message ?? commitError
  });
} else {
  writeStatus({
    status: stopping ? "cancelled" : result.code === 0 ? "completed" : "failed",
    finishedAt: new Date().toISOString(),
    exitCode: result.code,
    signal: result.signal
  });
}
finishScratch();
output.end();
errors.end();
