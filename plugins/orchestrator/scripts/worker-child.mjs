#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";

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

function writeStatus(fields) {
  atomicWrite(spec.statusFile, {
    pid: process.pid,
    ...(childPid ? { childPid } : {}),
    startedAt,
    threadId,
    ...(spec.resumeThreadId ? { resumeThreadId: spec.resumeThreadId } : {}),
    ...(resumeFallback ? { resumeFallback } : {}),
    ...fields
  });
}

writeStatus({ status: "running" });

const output = fs.createWriteStream(spec.outputFile, { flags: "a", mode: 0o600 });
const errors = fs.createWriteStream(spec.errorFile, { flags: "a", mode: 0o600 });
const prompt = fs.readFileSync(spec.promptFile);
// A resume after `run answer` sends only the answer, because the thread already
// holds the briefing. A fresh thread started in its place needs the full
// briefing instead, which the launcher writes to `fallbackPromptFile`.
const fallbackPrompt = spec.fallbackPromptFile ? fs.readFileSync(spec.fallbackPromptFile) : prompt;
const [command, ...prefixArgs] = spec.codexCommand;

// A resumed thread does not inherit its model, effort, or sandbox (verified against
// Codex CLI 0.169.0), so every launch passes all three explicitly. `-C` and
// `--sandbox` are only accepted on `exec`, before `resume`.
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
  const head = [...prefixArgs, "exec", "-C", spec.worktreePath, "--sandbox", spec.sandbox];
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
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    current = child;
    childPid = child.pid ?? childPid;
    let sawThread = false;
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
            // silently starts a new thread instead (observed 2026-11-15). The full
            // briefing was sent, so the attempt continues cold, but it is recorded.
            if (resumeThreadId && threadId !== resumeThreadId && !resumeFallback) {
              resumeFallback = {
                reason: "thread_replaced",
                message: `Codex started thread ${threadId} instead of resuming ${resumeThreadId}.`
              };
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
    child.on("close", (code, signal) => resolve({ code, signal, sawThread, stderrText }));
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
