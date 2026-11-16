import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { requireLane } from "./lanes.mjs";
import {
  answerTask,
  attachExecution,
  cancelTask,
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
  workerClockStart
} from "./runs.mjs";
import { atomicWrite } from "./state.mjs";
import { createTaskWorktree, reuseTaskWorktree } from "./worktrees.mjs";

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

function streamEvents(filePath) {
  const events = [];
  for (const line of tail(filePath, 64000).split("\n")) {
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
          !/fallback metadata/i.test(message)))) {
      return message;
    }
  }
  return null;
}

function executionDir(cwd, runId, taskId, attemptId) {
  return path.join(cwd, ".orchestrator", "local", "runs", runId, "workers", taskId, attemptId);
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
  { prompt, fallbackPrompt = null, codexCommand, worktreePath, model, reasoningEffort, kind, resumeThreadId = null }
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
  const dispatch = claimTask(cwd, runId, taskId, lane);
  try {
    const run = loadRun(cwd, runId);
    const task = run.tasks[taskId];
    const attempt = task.attempts.find((entry) => entry.id === dispatch.attemptId);
    const retry = attempt.retry ?? null;
    const worktree = retry?.worktree?.mode === "reuse"
      ? reuseTaskWorktree(
          cwd,
          run,
          task.attempts.find((entry) => entry.id === retry.worktree.attemptId)
        )
      : createTaskWorktree(cwd, run, task, attempt);
    const runner = spawnWorker(cwd, executionDir(cwd, runId, taskId, attempt.id), {
      prompt: dispatch.briefing,
      codexCommand,
      worktreePath: worktree.path,
      model: dispatch.model,
      reasoningEffort: dispatch.reasoningEffort,
      kind: task.kind,
      resumeThreadId: attempt.resumedFromAttemptId ? retry?.resumeThreadId ?? null : null
    });
    attachExecution(cwd, runId, taskId, {
      attemptId: attempt.id,
      worktree,
      runner
    });
    return { ...dispatch, worktree, runner };
  } catch (error) {
    const policyRefusal = error.kind === "refused";
    failTaskAttempt(cwd, runId, taskId, {
      attemptId: dispatch.attemptId,
      error: error.message,
      terminalOutcome: policyRefusal ? "policy_refused" : "execution_failed",
      action: policyRefusal ? "refuse" : "execute",
      reasonCode: error.reasonCode ?? "worker_launch_failed",
      signals: error.signals ?? ["worker_launch_error"],
      launchFailed: true
    });
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
    // Re-read each task: a concurrent `run poll` or `run wait` may have collected
    // it since the run was loaded, and collecting it twice would fail.
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
    if (!statusFile || !fs.existsSync(statusFile)) {
      updates.push({
        taskId: task.id,
        status: task.status,
        waiting: true,
        ...overLimitFields(cwd, runId, task, attempt, now)
      });
      continue;
    }
    const status = readJson(statusFile);
    const hadFallback = fallbackRecorded(attempt);
    const synced = syncExecutionStatus(cwd, runId, task.id, {
      attemptId: attempt.id,
      status
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
        { provenance: "automatic" }
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
        resultText: fs.readFileSync(attempt.runner.lastMessageFile, "utf8")
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
      signals: missingResult ? ["missing_result"] : ["worker_process_error"]
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
    error
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
  const answered = answerTask(cwd, runId, taskId, lane, { grantScope, deny, reply, userApproved });
  let runner = null;
  try {
    const run = loadRun(cwd, runId);
    const task = run.tasks[taskId];
    const previousRunner = answered.round.answer.previousRunner;
    runner = spawnWorker(
      cwd,
      path.join(executionDir(cwd, runId, taskId, answered.attemptId), `round-${answered.round.round}`),
      {
        prompt: answered.answerPrompt,
        fallbackPrompt: answered.briefing,
        codexCommand: codexCommand ?? (previousRunner ? launchCommand(previousRunner) : ["codex"]),
        worktreePath: answered.worktree.path,
        model: answered.model,
        reasoningEffort: answered.reasoningEffort,
        kind: task.kind,
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
    // A worker spawned before the failure would run untracked once the answer is
    // reverted; stop it so the task can be answered again cleanly.
    if (runner) {
      stopTaskWorker({ runner });
    }
    revertTaskAnswer(cwd, runId, taskId, { attemptId: answered.attemptId, error: error.message });
    throw error;
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

export function stopTaskWorker(attempt) {
  const runner = attempt?.runner;
  if (!runner) {
    return false;
  }
  let status = null;
  if (fs.existsSync(runner.statusFile)) {
    status = readJson(runner.statusFile);
  }
  stopPid(status?.childPid);
  stopPid(runner.pid);
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
