#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

function writeStatus(fields) {
  atomicWrite(spec.statusFile, {
    pid: process.pid,
    ...(childPid ? { childPid } : {}),
    startedAt,
    threadId,
    ...(spec.resumeThreadId ? { resumeThreadId: spec.resumeThreadId } : {}),
    ...(resumeFallback ? { resumeFallback } : {}),
    ...(sandboxFallback ? { sandboxFallback } : {}),
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
// 0.169.0). The scratch directory is removed when the worker finishes cleanly.
const READ_PROFILE = "orchestrator-read";
const [command, ...prefixArgs] = spec.codexCommand;
const scratchDir = spec.sandbox === "read-only"
  ? fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "orch-worker-")))
  : null;

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

// Without `--sandbox`, a read worker is read-only only if Codex applies the
// profile. A Codex that ignores or rejects it would fall back to the user's
// default permissions, which may be writable. So before the first launch the
// profile is proven on this machine with `codex sandbox`, under the same
// arguments, cwd, and TMPDIR: the scratch directory must be writable and the
// worktree must not. Anything else, including a probe that cannot run, falls
// back to plain `--sandbox read-only` and records why; that is always safe and
// only costs the worker its temp directory.
const PROBE_SCRIPT = [
  'const fs = require("fs"), path = require("path");',
  "const [scratch, checkout, name] = process.argv.slice(1);",
  "const writable = (dir) => { const file = path.join(dir, name);",
  '  try { fs.writeFileSync(file, ""); fs.unlinkSync(file); return true; } catch { return false; } };',
  "process.stdout.write(JSON.stringify({ scratch: writable(scratch), checkout: writable(checkout) }));"
].join("\n");

function probeReadProfile() {
  const marker = `.orch-sandbox-probe-${process.pid}`;
  const result = spawnSync(
    command,
    [...prefixArgs, "sandbox", ...readProfileArgs(), "--", process.execPath, "-e", PROBE_SCRIPT,
      scratchDir, spec.worktreePath, marker],
    {
      cwd: spec.worktreePath,
      env: { ...process.env, TMPDIR: scratchDir },
      encoding: "utf8",
      timeout: 30000
    }
  );
  // If a broken sandbox let the probe write, remove what it wrote.
  fs.rmSync(path.join(spec.worktreePath, marker), { force: true });
  let observed = null;
  try {
    observed = JSON.parse(String(result.stdout ?? "").trim().split("\n").at(-1));
  } catch {
    observed = null;
  }
  if (observed?.scratch === true && observed?.checkout === false) {
    return null;
  }
  if (observed && typeof observed.checkout === "boolean") {
    return { reason: observed.checkout ? "checkout_writable" : "scratch_denied", message: "" };
  }
  const detail = result.error?.message || String(result.stderr ?? "").trim().split("\n").at(-1) || "";
  return { reason: "probe_failed", message: `exit ${result.status ?? "none"}: ${detail}`.slice(0, 500) };
}

function sandboxArgs() {
  if (!scratchDir || sandboxFallback) {
    return ["--sandbox", spec.sandbox];
  }
  return readProfileArgs();
}

writeStatus({ status: "running" });

const output = fs.createWriteStream(spec.outputFile, { flags: "a", mode: 0o600 });
const errors = fs.createWriteStream(spec.errorFile, { flags: "a", mode: 0o600 });

if (scratchDir) {
  sandboxFallback = probeReadProfile();
  if (sandboxFallback) {
    errors.write(`[orchestrator] read profile not applied (${sandboxFallback.reason}); ` +
      "running under --sandbox read-only, without a writable TMPDIR.\n");
    writeStatus({ status: "running" });
  }
}
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
  return new Promise((resolve) => {
    const child = spawn(command, codexArgs(resumeThreadId), {
      cwd: spec.worktreePath,
      env: scratchDir ? { ...process.env, TMPDIR: scratchDir } : process.env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    current = child;
    childPid = child.pid ?? childPid;
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
                try {
                  child.kill("SIGTERM");
                } catch {
                  // Already gone; the relaunch below still runs.
                }
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

if (result.error) {
  writeStatus({
    status: "failed",
    finishedAt: new Date().toISOString(),
    error: result.error.message
  });
} else {
  writeStatus({
    status: stopping ? "cancelled" : result.code === 0 ? "completed" : "failed",
    finishedAt: new Date().toISOString(),
    exitCode: result.code,
    signal: result.signal
  });
}
output.end();
errors.end();
if (scratchDir) {
  fs.rmSync(scratchDir, { recursive: true, force: true });
}
