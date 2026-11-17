import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { requireLane } from "./lanes.mjs";
import {
  AnswerSavedError,
  answerTask,
  AttachRefusedError,
  attachExecution,
  cancelRun,
  cancelTask,
  ClaimSavedError,
  claimTask,
  failTaskAttempt,
  loadRun,
  recordModelUnavailable,
  recordOverLimit,
  recordTaskResult,
  revertTaskAnswer,
  substitutionNotice,
  syncExecutionStatus,
  taskTimeoutMinutes,
  workerClockStart,
  StaleRunnerError
} from "./runs.mjs";
import { removeTree, SCRATCH_OWNER_FILE } from "./remove-tree.mjs";
import { atomicWrite } from "./state.mjs";
import { createTaskWorktree, reuseTaskWorktree, worktreeGitDir } from "./worktrees.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const childScript = path.join(here, "..", "worker-child.mjs");

export const WORKER_RESULT_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    files_touched: { type: "array", items: { type: "string" } },
    tests: {
      type: "array",
      items: {
        type: "object",
        properties: {
          command: { type: "string" },
          outcome: { type: "string" }
        },
        required: ["command", "outcome"],
        additionalProperties: false
      }
    },
    decisions: { type: "array", items: { type: "string" } },
    assumptions: { type: "array", items: { type: "string" } },
    blockers: { type: "array", items: { type: "string" } },
    // Structured outputs require every declared property to appear in
    // `required`, so an optional field must be expressed as a nullable type
    // rather than an absent key. A worker with nothing to report sends null,
    // which the blocked-attempt path already folds into "other".
    blocker_code: {
      type: ["string", "null"],
      enum: [
        "missing_context",
        "scope_required",
        "ambiguous_objective",
        "missing_authority",
        "policy_boundary",
        "model_unavailable",
        "other",
        null
      ]
    },
    // A non-null value ends the turn as `needs_input` instead of a result: the
    // worker is paused, not finished, and continues on the same thread once the
    // supervisor answers. Nullable for the same structured-output reason as
    // blocker_code, and every nested property is required too: `paths` is empty
    // for a question, `question` is null and `options` empty for a scope request.
    needs_input: {
      type: ["object", "null"],
      properties: {
        kind: { type: "string", enum: ["scope_extension", "question"] },
        paths: { type: "array", items: { type: "string" } },
        reason: { type: "string" },
        question: { type: ["string", "null"] },
        options: { type: "array", items: { type: "string" } }
      },
      required: ["kind", "paths", "reason", "question", "options"],
      additionalProperties: false
    },
    confidence: { type: "string", enum: ["high", "medium", "low"] }
  },
  required: [
    "summary",
    "files_touched",
    "tests",
    "decisions",
    "assumptions",
    "blockers",
    "blocker_code",
    "needs_input",
    "confidence"
  ],
  additionalProperties: false
};

/**
 * Codex reports API-level rejections as JSON events on stdout, not on stderr.
 * A request the API refuses outright — an invalid output schema, an unavailable
 * model — therefore leaves an empty stderr log and a bare non-zero exit, so the
 * supervisor would otherwise record "Codex exited 1" and lose the only
 * description of what actually went wrong.
 */
function eventStreamError(filePath) {
  const text = tail(filePath);
  if (!text) {
    return "";
  }
  const messages = [];
  // A truncated leading fragment simply fails to parse and is skipped.
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) {
      continue;
    }
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const isError = typeof event?.type === "string" && event.type.includes("error");
    if (!isError && !event?.error) {
      continue;
    }
    const detail = event?.error ?? event?.message ?? null;
    const message = typeof detail === "string" ? detail : detail?.message;
    if (typeof message === "string" && message.trim()) {
      messages.push(message.trim());
    }
  }
  return [...new Set(messages)].join(" | ");
}

const STREAM_TAIL_BYTES = 64000;

function streamEvents(filePath) {
  const events = [];
  for (const line of tail(filePath, STREAM_TAIL_BYTES).split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) {
      continue;
    }
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // A truncated leading fragment simply fails to parse and is skipped.
    }
  }
  return events;
}

const UNAVAILABLE_PHRASES =
  /not supported|not available|unavailable|does not exist|not found|do(?:es)? not have access|no access|not enabled|not allowed/i;
// Wording that marks an outage rather than an entitlement. Such an error, even one
// naming the model before any work, is an ordinary failure to retry: marking the
// model unavailable would skip it for the rest of the run.
const TRANSIENT_PHRASES =
  /currently (?:unavailable|overloaded|experiencing)|temporar|try again|retry later|overloaded|over capacity|rate.?limit|too many requests|timed? ?out|\b5\d\d\b/i;

/**
 * Decide whether Codex rejected the requested model itself, as opposed to the
 * worker failing. Observed against Codex CLI 0.169.0 (2026-11-15) for a model the
 * account cannot use: exit 1, empty stderr, and on stdout
 *
 *   {"type":"error","message":"The '<slug>' model is not supported when using Codex with a ChatGPT account."}
 *   {"type":"turn.failed","error":{"message":"<same text>"}}
 *
 * Only those two top-level event types count. Codex also emits warnings as
 * `item.completed` items of type "error" (for example "Model metadata for `<slug>`
 * not found. Defaulting to fallback metadata"), which are not rejections. The
 * message must name the requested slug, so an unrelated API error never triggers
 * a substitution. An API-key account reporting `model_not_found` is matched by
 * code as well; that shape is inferred from the OpenAI API, not observed here.
 *
 * A rejection comes before any work. Once the stream shows the worker doing
 * something (an item other than an "error" warning, or a finished turn), a later
 * error naming the model is a mid-run failure, not a launch rejection: treating
 * it as one would close the attempt as never reaching a worker and relaunch in a
 * fresh worktree, discarding the work.
 */
export function modelUnavailableError(filePath, model) {
  const slug = String(model ?? "").toLowerCase();
  if (!slug) {
    return null;
  }
  // A rejection is a few short lines. A stream longer than the tail read below
  // means the worker produced output, and its earliest events (the work that
  // rules out a launch rejection) may have been cut off.
  if (fs.existsSync(filePath) && fs.statSync(filePath).size > STREAM_TAIL_BYTES) {
    return null;
  }
  for (const event of streamEvents(filePath)) {
    if (
      event?.type === "turn.completed" ||
      (String(event?.type ?? "").startsWith("item.") && event.item?.type !== "error")
    ) {
      return null;
    }
    if (event?.type !== "error" && event?.type !== "turn.failed") {
      continue;
    }
    const detail = event.error ?? null;
    const message = String(
      (typeof detail === "string" ? detail : detail?.message) ?? event.message ?? ""
    ).trim();
    const code = typeof detail === "object" ? detail?.code : event.code;
    const namesModel = message.toLowerCase().includes(slug);
    if (namesModel && (code === "model_not_found" ||
        (/\bmodel\b/i.test(message) && UNAVAILABLE_PHRASES.test(message) &&
          !TRANSIENT_PHRASES.test(message) && !/fallback metadata/i.test(message)))) {
      return message;
    }
  }
  return null;
}

function executionDir(cwd, runId, taskId, attemptId) {
  return path.join(cwd, ".orchestrator", "local", "runs", runId, "workers", taskId, attemptId);
}

const TERMINAL_RUNNER_STATUSES = new Set(["completed", "failed", "cancelled"]);

/**
 * Remove scratch directories that read-only workers of this attempt left behind.
 * A wrapper removes its own when it exits, even on SIGTERM; only a hard kill or
 * a crash leaves one, recorded as `scratchDir` in that runner's status file.
 * A status file is only a claim, so a directory is removed only when the wrapper
 * and its Codex child are both gone (a "cancelled" status is written before the
 * processes exit), the path is a real directory named as the wrapper names them
 * with no symlink anywhere on it, and its owner file names this status file.
 */
export function removeLeftoverScratch(cwd, runId, taskId, attemptId) {
  const root = executionDir(cwd, runId, taskId, attemptId);
  const removed = [];
  const owned = (scratch, statusFile) => {
    try {
      if (!path.isAbsolute(scratch) || !path.basename(scratch).startsWith("orch-worker-")) {
        return false;
      }
      const stat = fs.lstatSync(scratch);
      if (!stat.isDirectory() || fs.realpathSync(scratch) !== scratch) {
        return false;
      }
      const owner = path.join(scratch, SCRATCH_OWNER_FILE);
      // A worker may have made its scratch root unreadable (`chmod 000`); a
      // directory this user owns gets its permissions back before the owner
      // file is read. removeTree restores the rest.
      if (stat.uid === process.getuid?.() && (stat.mode & 0o500) !== 0o500) {
        fs.chmodSync(scratch, 0o700);
      }
      return fs.lstatSync(owner).isFile() &&
        fs.realpathSync(fs.readFileSync(owner, "utf8")) === fs.realpathSync(statusFile);
    } catch {
      return false;
    }
  };
  const visit = (directory) => {
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath);
        continue;
      }
      if (entry.name !== "status.json") {
        continue;
      }
      let status;
      try {
        status = readJson(entryPath);
      } catch {
        continue;
      }
      const scratch = typeof status.scratchDir === "string" ? status.scratchDir : null;
      if (!scratch || sameProcess(status.pid, status.startedAt) || groupLive(status.childPid, status.childStartedAt)) {
        continue;
      }
      if (owned(scratch, entryPath)) {
        removeTree(scratch);
        removed.push(scratch);
      }
    }
  };
  visit(root);
  return removed;
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

/** When the process with this pid started, from `ps`, or null when that cannot be told. */
function processStart(pid) {
  try {
    const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C" },
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    const time = Date.parse(out);
    return Number.isNaN(time) ? null : time;
  } catch {
    return null;
  }
}

/**
 * Whether `pid` is still the process recorded as started at `startedAt`: a
 * recorded pid can since belong to an unrelated process, and that one must
 * not be taken for a live worker or signalled. Without a recorded time (an
 * older status) or a readable start time, a live pid is taken as the same.
 */
function sameProcess(pid, startedAt) {
  if (!processAlive(pid)) {
    return false;
  }
  const started = processStart(pid);
  return !startedAt || started === null || Math.abs(started - Date.parse(startedAt)) < 10000;
}

/**
 * Whether the process group a recorded Codex leader started still exists. A
 * pid is not reused while a group with that id has members, so with the
 * leader dead any member left is one of ours; with a live leader it must be
 * the same process.
 */
function groupLive(pid, startedAt) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  if (processAlive(pid)) {
    return sameProcess(pid, startedAt);
  }
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

/** Whether an attempt's worker (its wrapper, or what its Codex started) may still be running. */
export function attemptLive(attempt) {
  const runner = attempt?.runner;
  if (!runner) {
    return false;
  }
  let status = null;
  try {
    status = fs.existsSync(runner.statusFile) ? readJson(runner.statusFile) : null;
  } catch {
    status = null;
  }
  if (TERMINAL_RUNNER_STATUSES.has(status?.status)) {
    return false;
  }
  return sameProcess(runner.pid, status?.startedAt ?? runner.launchedAt) ||
    groupLive(status?.childPid, status?.childStartedAt);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function tail(filePath, bytes = 8000) {
  if (!fs.existsSync(filePath)) {
    return "";
  }
  const stat = fs.statSync(filePath);
  const start = Math.max(0, stat.size - bytes);
  const descriptor = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(stat.size - start);
    fs.readSync(descriptor, buffer, 0, buffer.length, start);
    return buffer.toString("utf8");
  } finally {
    fs.closeSync(descriptor);
  }
}

/**
 * Write a worker's prompt, schema, and spec into `directory` and start the
 * detached wrapper. Model, effort, and sandbox are always passed explicitly,
 * also when resuming: a resumed Codex thread inherits none of them and would
 * otherwise fall back to config defaults and write access. `fallbackPrompt` is
 * what a resume that finds its thread missing sends to the fresh thread instead.
 */
function spawnWorker(
  cwd,
  directory,
  { prompt, fallbackPrompt = null, codexCommand, worktreePath, model, reasoningEffort, kind, resumeThreadId = null, commitMessage = null }
) {
  fs.mkdirSync(directory, { recursive: true });
  const files = {
    promptFile: path.join(directory, "prompt.md"),
    ...(fallbackPrompt ? { fallbackPromptFile: path.join(directory, "fallback-prompt.md") } : {}),
    schemaFile: path.join(directory, "result.schema.json"),
    outputFile: path.join(directory, "events.jsonl"),
    errorFile: path.join(directory, "stderr.log"),
    lastMessageFile: path.join(directory, "result.json"),
    statusFile: path.join(directory, "status.json"),
    specFile: path.join(directory, "spec.json")
  };
  atomicWrite(files.promptFile, prompt);
  if (fallbackPrompt) {
    atomicWrite(files.fallbackPromptFile, fallbackPrompt);
  }
  atomicWrite(files.schemaFile, `${JSON.stringify(WORKER_RESULT_SCHEMA, null, 2)}\n`);
  const spec = {
    ...files,
    codexCommand,
    worktreePath,
    model,
    reasoningEffort,
    sandbox: kind === "write" ? "workspace-write" : "read-only",
    // The wrapper commits a write worker's changes with this git directory,
    // never through the worktree's own `.git` pointer file (see worktreeGitEnv).
    ...(kind === "write"
      ? { commitMessage, gitDir: worktreeGitDir(cwd, worktreePath) }
      : {}),
    ...(resumeThreadId ? { resumeThreadId } : {})
  };
  atomicWrite(files.specFile, `${JSON.stringify(spec, null, 2)}\n`);
  const child = spawn(process.execPath, [childScript, files.specFile], {
    cwd,
    detached: true,
    stdio: "ignore"
  });
  child.unref();
  return {
    pid: child.pid,
    status: "starting",
    ...files,
    launchedAt: new Date().toISOString()
  };
}

/** The message the wrapper commits a write worker's changes under. */
function workerCommitMessage(task, attemptId) {
  const subject = String(task.title || task.id).replace(/\s+/g, " ").trim().slice(0, 72);
  return `${subject}\n\nOrchestrator task ${task.id}, ${attemptId}.`;
}

function launchCommand(runner, fallback = ["codex"]) {
  try {
    return readJson(runner.specFile).codexCommand ?? fallback;
  } catch {
    // The spec only records an override; without it the default command applies.
    return fallback;
  }
}

export function launchTaskWorker(
  cwd,
  runId,
  taskId,
  lane,
  { codexCommand = ["codex"] } = {}
) {
  let dispatch;
  try {
    dispatch = claimTask(cwd, runId, taskId, lane);
  } catch (error) {
    // The claim reached disk but its event did not: fail the attempt, or the
    // task would sit dispatching with no worker and refuse launch and retry.
    if (error instanceof ClaimSavedError) {
      failTaskAttempt(cwd, runId, taskId, {
        attemptId: error.attemptId,
        error: error.message,
        reasonCode: "worker_launch_failed",
        signals: ["worker_launch_error"],
        launchFailed: true
      });
    }
    throw error;
  }
  let runner = null;
  let worktree = null;
  try {
    const run = loadRun(cwd, runId);
    const task = run.tasks[taskId];
    const attempt = task.attempts.find((entry) => entry.id === dispatch.attemptId);
    const retry = attempt.retry ?? null;
    worktree = retry?.worktree?.mode === "reuse"
      ? reuseTaskWorktree(
          cwd,
          run,
          task.attempts.find((entry) => entry.id === retry.worktree.attemptId)
        )
      : createTaskWorktree(cwd, run, task, attempt);
    runner = spawnWorker(cwd, executionDir(cwd, runId, taskId, attempt.id), {
      prompt: dispatch.briefing,
      codexCommand,
      worktreePath: worktree.path,
      model: dispatch.model,
      reasoningEffort: dispatch.reasoningEffort,
      kind: task.kind,
      commitMessage: workerCommitMessage(task, attempt.id),
      resumeThreadId: attempt.resumedFromAttemptId ? retry?.resumeThreadId ?? null : null
    });
    attachExecution(cwd, runId, taskId, {
      attemptId: attempt.id,
      worktree,
      runner
    });
    return { ...dispatch, worktree, runner };
  } catch (error) {
    // Record the failure first, so no poll sees the task attached to a worker
    // being stopped; then stop a worker spawned before the failure. An attempt
    // cancelled during the launch keeps its cancellation.
    try {
      if (!(error instanceof AttachRefusedError)) {
        const policyRefusal = error.kind === "refused";
        const fail = (reasonCode, signals) => failTaskAttempt(cwd, runId, taskId, {
          attemptId: dispatch.attemptId,
          error: error.message,
          terminalOutcome: policyRefusal ? "policy_refused" : "execution_failed",
          action: policyRefusal ? "refuse" : "execute",
          reasonCode,
          signals,
          launchFailed: true,
          worktree,
          // Fail the attempt only while it is still this launch's: attached to
          // this runner if the attach was saved, to no runner otherwise. A poll
          // and an answer may have collected and resumed it in between.
          runnerStatusFile: error.runnerAttached ? runner.statusFile : null
        });
        const tolerateStale = (operation) => {
          try {
            operation();
          } catch (failure) {
            if (!(failure instanceof StaleRunnerError)) {
              throw failure;
            }
          }
        };
        try {
          tolerateStale(() => fail(error.reasonCode ?? "worker_launch_failed", error.signals ?? ["worker_launch_error"]));
        } catch {
          // A reason code the outcome cannot take must not leave the task
          // dispatching with no worker: record the generic launch failure.
          tolerateStale(() => fail(policyRefusal ? "policy_boundary" : "worker_launch_failed", ["worker_launch_error"]));
        }
      }
    } finally {
      if (runner) {
        try {
          stopTaskWorker({ runner });
        } catch {
          // A worker that cannot be stopped is reported by its own status file.
        }
      }
    }
    throw error;
  }
}

/** Whether the attempt (or the answered round its runner belongs to) has a recorded resume fallback. */
function fallbackRecorded(attempt) {
  const round = attempt.runner?.inputRound
    ? attempt.inputRequests?.find((entry) => entry.round === attempt.runner.inputRound)?.answer
    : null;
  return Boolean((round ?? attempt).resumeFallback);
}

/**
 * Report a still-running worker whose current process has run longer than the
 * task's wall-clock limit. Reporting is all it does: the worker is never stopped
 * here. `changed` is set only on the poll that first records it.
 */
function overLimitFields(cwd, runId, task, attempt, now) {
  const clockStart = workerClockStart(attempt);
  const started = clockStart ? Date.parse(clockStart) : NaN;
  if (!Number.isFinite(started)) {
    return {};
  }
  const timeoutMinutes = taskTimeoutMinutes(task, attempt);
  const elapsedMinutes = Math.round(((now - started) / 60000) * 100) / 100;
  if (now - started < timeoutMinutes * 60000) {
    return {};
  }
  const recorded = recordOverLimit(cwd, runId, task.id, {
    attemptId: attempt.id,
    clockStart,
    elapsedMinutes,
    timeoutMinutes
  });
  if (!recorded.overLimit) {
    return {};
  }
  return {
    overLimit: { timeoutMinutes, elapsedMinutes, detectedAt: recorded.overLimit.detectedAt },
    ...(recorded.recorded ? { changed: true } : {})
  };
}

/** A paused worker's open request, repeated on every poll until it is answered. */
function awaitingAnswer(task) {
  const attempt = task.attempts.at(-1);
  const round = attempt?.inputRequests?.at(-1);
  return {
    taskId: task.id,
    attemptId: attempt?.id ?? null,
    status: task.status,
    awaitingAnswer: true,
    ...(round && !round.answer ? { round: round.round, inputRequest: round.request } : {})
  };
}

/**
 * Collect what every active worker's status file says. Each update describes one
 * task. `changed: true` marks an update the supervisor must act on: a worker that
 * finished, failed, was cancelled, paused with a request, was relaunched on a
 * substitute model, fell back from a missing thread, or went over its wall-clock
 * limit. Running workers with nothing new, and paused workers still awaiting an
 * answer (`awaitingAnswer: true`), are listed without it. `run wait` wakes on the
 * first poll that returns a changed update.
 */
export function pollRunWorkers(cwd, runId, { now = Date.now() } = {}) {
  const run = loadRun(cwd, runId);
  const updates = [];
  for (const listed of Object.values(run.tasks)) {
    // Only an active or paused task has anything to collect. Skipping the rest
    // without a reload keeps a poll at one run load plus one per active task.
    if (!["dispatching", "running", "needs_input"].includes(listed.status)) {
      continue;
    }
    // Re-read an active task: a concurrent `run poll` or `run wait` may have
    // collected it since the run was loaded, and collecting it twice would fail.
    const task = loadRun(cwd, runId).tasks[listed.id];
    if (task?.status === "needs_input") {
      updates.push(awaitingAnswer(task));
      continue;
    }
    if (!task || !["dispatching", "running"].includes(task.status)) {
      continue;
    }
    const attempt = task.attempts.at(-1);
    const statusFile = attempt.runner?.statusFile;
    const wrapperGone = () => Number.isInteger(attempt.runner?.pid) &&
      !sameProcess(attempt.runner.pid, attempt.runner.launchedAt);
    // A wrapper that died before writing any status (it could not start, say)
    // gets a failed one, or its task would wait forever.
    if (statusFile && !fs.existsSync(statusFile) && wrapperGone()) {
      atomicWrite(statusFile, `${JSON.stringify({
        pid: attempt.runner.pid,
        status: "failed",
        error: "The worker wrapper exited without writing a status.",
        finishedAt: new Date().toISOString()
      }, null, 2)}\n`);
    }
    if (!statusFile || !fs.existsSync(statusFile)) {
      updates.push({
        taskId: task.id,
        status: task.status,
        waiting: true,
        ...overLimitFields(cwd, runId, task, attempt, now)
      });
      continue;
    }
    // Every write below is checked against the runner this poll read: if a
    // concurrent poll collected it and `run answer` attached a resumed runner in
    // the meantime, this poll's view is stale and the task is left to the next.
    try {
      let status = readJson(statusFile);
      // A wrapper that died without a final status (an uncaught error, a hard
      // kill) leaves "running" behind; read again in case it wrote one as it
      // exited, then treat it as failed instead of running forever.
      if (["starting", "running"].includes(status.status) && Number.isInteger(status.pid) &&
          !sameProcess(status.pid, status.startedAt ?? attempt.runner?.launchedAt)) {
        status = readJson(statusFile);
        if (["starting", "running"].includes(status.status)) {
          status = { ...status, status: "failed", error: "The worker wrapper exited without a final status." };
          // Codex runs in its own group and outlives the wrapper; nothing else
          // would stop it once the task is failed and its slot is free.
          stopGroup(status.childPid, "SIGKILL", status.childStartedAt);
        }
      }
      const hadFallback = fallbackRecorded(attempt);
      const synced = syncExecutionStatus(cwd, runId, task.id, {
        attemptId: attempt.id,
        status,
        runnerStatusFile: statusFile
      });
      if (status.status === "running") {
        const fellBack = !hadFallback && fallbackRecorded(synced);
        const overLimit = overLimitFields(cwd, runId, task, attempt, now);
        updates.push({
          taskId: task.id,
          ...status,
          ...overLimit,
          ...(fellBack ? { changed: true } : {})
        });
        continue;
      }
      if (status.status === "cancelled") {
        const cancelled = cancelTask(
          cwd,
          runId,
          task.id,
          status.error || "Worker runner was cancelled.",
          { provenance: "automatic", runnerStatusFile: statusFile }
        );
        updates.push({
          taskId: task.id,
          attemptId: attempt.id,
          changed: true,
          status: cancelled.status,
          threadId: status.threadId,
          exitCode: status.exitCode
        });
        continue;
      }
      if (status.status === "completed" && fs.existsSync(attempt.runner.lastMessageFile)) {
        const recorded = recordTaskResult(cwd, runId, task.id, {
          attemptId: attempt.id,
          resultText: fs.readFileSync(attempt.runner.lastMessageFile, "utf8"),
          runnerStatusFile: statusFile
        });
        updates.push({
          taskId: task.id,
          attemptId: attempt.id,
          changed: true,
          status: recorded.task.status,
          threadId: status.threadId,
          exitCode: status.exitCode,
          ...(recorded.inputRequest
            ? { round: recorded.inputRequest.round, inputRequest: recorded.inputRequest.request }
            : {}),
          ...(recorded.task.result?.inputCapReached ? { inputCapReached: true } : {}),
          ...(status.resumeFallback ? { resumeFallback: status.resumeFallback } : {})
        });
        continue;
      }
      // A runner launched by `run answer` resumes an attempt that has already
      // worked, so its failure is never a launch rejection of the attempt.
      const unavailable = status.status === "failed" && !attempt.runner.inputRound
        ? modelUnavailableError(attempt.runner.outputFile, attempt.model)
        : null;
      if (unavailable) {
        updates.push(substituteUnavailableModel(cwd, runId, task, attempt, status, unavailable));
        continue;
      }
      const error = status.error
        || tail(attempt.runner.errorFile)
        || eventStreamError(attempt.runner.outputFile)
        || `Codex exited ${status.exitCode}.`;
      const missingResult = status.status === "completed";
      const failed = failTaskAttempt(cwd, runId, task.id, {
        attemptId: attempt.id,
        error,
        terminalOutcome: missingResult ? "contract_failed" : "execution_failed",
        action: missingResult ? "replan" : "execute",
        reasonCode: missingResult ? "missing_result" : "worker_process_failed",
        signals: missingResult ? ["missing_result"] : ["worker_process_error"],
        runnerStatusFile: statusFile
      });
      updates.push({
        taskId: task.id,
        attemptId: attempt.id,
        changed: true,
        status: failed.status,
        threadId: status.threadId,
        exitCode: status.exitCode,
        error,
        ...(status.resumeFallback ? { resumeFallback: status.resumeFallback } : {})
      });
    } catch (error) {
      if (error instanceof StaleRunnerError) {
        continue;
      }
      throw error;
    }
  }
  return updates;
}

/**
 * Close a rejected attempt and relaunch the task one rung down the fallback
 * ladder with the same effort, reusing the Codex command the rejected attempt
 * was launched with. The returned update names both models so `run poll` and
 * `run resume` show the substitution.
 */
function substituteUnavailableModel(cwd, runId, task, attempt, status, error) {
  const recorded = recordModelUnavailable(cwd, runId, task.id, {
    attemptId: attempt.id,
    error,
    runnerStatusFile: attempt.runner?.statusFile ?? null
  });
  const update = {
    taskId: task.id,
    attemptId: attempt.id,
    changed: true,
    status: recorded.task.status,
    threadId: status.threadId,
    exitCode: status.exitCode,
    error,
    unavailableModel: attempt.model,
    fallbackModel: recorded.fallbackModel
  };
  if (!recorded.fallbackModel || recorded.duplicate) {
    return update;
  }
  const codexCommand = launchCommand(attempt.runner);
  try {
    const run = loadRun(cwd, runId);
    const launched = launchTaskWorker(cwd, runId, task.id, requireLane(cwd, run.lane), {
      codexCommand
    });
    return {
      ...update,
      status: "substituted",
      nextAttemptId: launched.attemptId,
      requestedModel: launched.requestedModel,
      model: launched.model,
      reasoningEffort: launched.reasoningEffort,
      pinned: Boolean(launched.substitution?.pinned),
      notice: substitutionNotice(launched.substitution)
    };
  } catch (launchError) {
    return {
      ...update,
      relaunchError: launchError.message
    };
  }
}

/**
 * Answer a paused worker and resume it: the same attempt, the same Codex thread,
 * the same worktree, on the model and effort the attempt is actually using (a
 * substituted model stays substituted) and the task's own sandbox. The resumed
 * thread receives only the answer; a fallback to a fresh thread receives the
 * full briefing, which carries every answer so far. Each answered round writes
 * its files under `round-<n>/` so earlier rounds stay on disk for audit.
 */
export function answerTaskWorker(
  cwd,
  runId,
  taskId,
  lane,
  { grantScope = [], deny = false, reply = null, userApproved = false, codexCommand = null } = {}
) {
  let answered;
  try {
    answered = answerTask(cwd, runId, taskId, lane, { grantScope, deny, reply, userApproved });
  } catch (error) {
    // The answer reached disk but its event did not: undo it, or the task would
    // sit dispatching with no runner and refuse every later answer.
    if (error instanceof AnswerSavedError) {
      revertTaskAnswer(cwd, runId, taskId, { attemptId: error.attemptId, round: error.round, error: error.message });
    }
    throw error;
  }
  let runner = null;
  try {
    const run = loadRun(cwd, runId);
    const task = run.tasks[taskId];
    const previousRunner = answered.round.answer.previousRunner;
    // Each try at answering a round gets its own directory: a failed try leaves a
    // cancelled status file behind, which a poll must never read for the next.
    const tries = answered.round.failedAnswers?.length ?? 0;
    runner = spawnWorker(
      cwd,
      path.join(
        executionDir(cwd, runId, taskId, answered.attemptId),
        `round-${answered.round.round}${tries ? `-try-${tries + 1}` : ""}`
      ),
      {
        prompt: answered.answerPrompt,
        fallbackPrompt: answered.briefing,
        codexCommand: codexCommand ?? (previousRunner ? launchCommand(previousRunner) : ["codex"]),
        worktreePath: answered.worktree.path,
        model: answered.model,
        reasoningEffort: answered.reasoningEffort,
        kind: task.kind,
        commitMessage: workerCommitMessage(task, answered.attemptId),
        resumeThreadId: answered.resumeThreadId
      }
    );
    runner.inputRound = answered.round.round;
    attachExecution(cwd, runId, taskId, {
      attemptId: answered.attemptId,
      worktree: answered.worktree,
      runner
    });
    return { ...answered, runner };
  } catch (error) {
    // Revert first, so no poll ever sees the task attached to a runner being
    // stopped; then stop a worker spawned before the failure, which would
    // otherwise run untracked.
    try {
      revertTaskAnswer(cwd, runId, taskId, {
        attemptId: answered.attemptId,
        round: answered.round.round,
        error: error.message,
        failedRunnerStatusFile: runner?.statusFile ?? null
      });
    } finally {
      if (runner) {
        try {
          stopTaskWorker({ runner });
        } catch {
          // A worker that cannot be stopped is reported by its own status file.
        }
      }
    }
    throw error;
  }
}

function stopGroup(pid, signal = "SIGTERM", startedAt = null) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return;
  }
  // A live leader that is not the recorded one means the group is long gone
  // (its id could not be reused otherwise): signal nothing.
  if (processAlive(pid) && !sameProcess(pid, startedAt)) {
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    stopPid(pid);
  }
}

function stopPid(pid) {
  if (!pid) {
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    if (error.code !== "ESRCH") {
      throw error;
    }
  }
}

/**
 * Cancel a task (or, with no task id, the whole run) and stop its workers. A
 * launch or answer may attach its worker after the first stop reads the run but
 * before the cancellation is saved; nothing can attach once it is saved, so a
 * second pass stops any worker still live on a cancelled task.
 */
export function cancelWorkers(cwd, runId, taskId, reason) {
  const pick = (run) => (taskId ? [run.tasks[taskId]] : Object.values(run.tasks)).filter(Boolean);
  for (const task of pick(loadRun(cwd, runId))) {
    stopTaskWorker(task.attempts.at(-1));
  }
  try {
    return taskId ? cancelTask(cwd, runId, taskId, reason) : cancelRun(cwd, runId, reason);
  } finally {
    // Also when the cancellation was saved but a later step (its event) failed.
    // Every cancelled attempt, not only the latest: a retry launched since the
    // cancellation was saved hides a worker that attached to the one before.
    for (const task of pick(loadRun(cwd, runId))) {
      for (const attempt of task.attempts) {
        if (attempt.status === "cancelled") {
          stopLiveTaskWorker(attempt);
        }
      }
    }
  }
}

/**
 * Stop the attempt's worker only if its status file says it is still live; a
 * runner already stopped or finished is left alone.
 */
function stopLiveTaskWorker(attempt) {
  const runner = attempt?.runner;
  if (!runner) {
    return false;
  }
  const status = fs.existsSync(runner.statusFile) ? readJson(runner.statusFile)?.status : null;
  if (TERMINAL_RUNNER_STATUSES.has(status)) {
    return false;
  }
  return stopTaskWorker(attempt);
}

export function stopTaskWorker(attempt) {
  const runner = attempt?.runner;
  if (!runner) {
    return false;
  }
  let status = null;
  if (fs.existsSync(runner.statusFile)) {
    status = readJson(runner.statusFile);
  }
  // Codex runs in its own process group, recorded as childPid. A live wrapper
  // is stopped and waited for: it stops its own child, whichever one is
  // current (the probe may have handed over to Codex since the status was
  // read), and escalates to SIGKILL itself. Whatever group the status records
  // once the wrapper is gone, or after the wait, is then killed outright, so
  // nothing is left running when this returns even if the wrapper died
  // midway. A finished runner is not signalled: its pids may since belong to
  // unrelated processes.
  if (!TERMINAL_RUNNER_STATUSES.has(status?.status)) {
    const current = () => (fs.existsSync(runner.statusFile) ? readJson(runner.statusFile) : status);
    if (Number.isInteger(runner.pid) && sameProcess(runner.pid, status?.startedAt ?? runner.launchedAt)) {
      stopPid(runner.pid);
      // Until its final status (written once its child's group is killed) or
      // its exit; an unreaped wrapper still looks alive, the status does not.
      const deadline = Date.now() + 8000;
      while (!TERMINAL_RUNNER_STATUSES.has(current()?.status) && processAlive(runner.pid) &&
        Date.now() < deadline) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
      }
    }
    status = current();
    if (!TERMINAL_RUNNER_STATUSES.has(status?.status)) {
      stopGroup(status?.childPid, "SIGKILL", status?.childStartedAt);
      // A wrapper that ignored SIGTERM this long is stuck (in a git command a
      // worker's file blocks, say): kill it and what it runs, its own group.
      if (Number.isInteger(runner.pid) && sameProcess(runner.pid, status?.startedAt ?? runner.launchedAt)) {
        stopGroup(runner.pid, "SIGKILL", status?.startedAt ?? runner.launchedAt);
      }
    }
  }
  atomicWrite(
    runner.statusFile,
    `${JSON.stringify({
      ...(status ?? {}),
      status: "cancelled",
      pid: runner.pid,
      finishedAt: new Date().toISOString()
    }, null, 2)}\n`
  );
  return true;
}
