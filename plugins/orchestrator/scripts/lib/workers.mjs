import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { requireLane } from "./lanes.mjs";
import {
  attachExecution,
  cancelTask,
  claimTask,
  failTaskAttempt,
  loadRun,
  recordModelUnavailable,
  recordTaskResult,
  substitutionNotice,
  syncExecutionStatus
} from "./runs.mjs";
import { atomicWrite } from "./state.mjs";
import { createTaskWorktree } from "./worktrees.mjs";

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
 */
export function modelUnavailableError(filePath, model) {
  const slug = String(model ?? "").toLowerCase();
  if (!slug) {
    return null;
  }
  for (const event of streamEvents(filePath)) {
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
    const worktree = createTaskWorktree(cwd, run, task, attempt);
    const directory = executionDir(cwd, runId, taskId, attempt.id);
    fs.mkdirSync(directory, { recursive: true });
    const files = {
      promptFile: path.join(directory, "prompt.md"),
      schemaFile: path.join(directory, "result.schema.json"),
      outputFile: path.join(directory, "events.jsonl"),
      errorFile: path.join(directory, "stderr.log"),
      lastMessageFile: path.join(directory, "result.json"),
      statusFile: path.join(directory, "status.json"),
      specFile: path.join(directory, "spec.json")
    };
    atomicWrite(files.promptFile, dispatch.briefing);
    atomicWrite(files.schemaFile, `${JSON.stringify(WORKER_RESULT_SCHEMA, null, 2)}\n`);
    const spec = {
      ...files,
      codexCommand,
      worktreePath: worktree.path,
      model: dispatch.model,
      reasoningEffort: dispatch.reasoningEffort,
      sandbox: task.kind === "write" ? "workspace-write" : "read-only"
    };
    atomicWrite(files.specFile, `${JSON.stringify(spec, null, 2)}\n`);
    const child = spawn(process.execPath, [childScript, files.specFile], {
      cwd,
      detached: true,
      stdio: "ignore"
    });
    child.unref();
    const runner = {
      pid: child.pid,
      status: "starting",
      ...files,
      launchedAt: new Date().toISOString()
    };
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
      signals: error.signals ?? ["worker_launch_error"]
    });
    throw error;
  }
}

export function pollRunWorkers(cwd, runId) {
  const run = loadRun(cwd, runId);
  const updates = [];
  for (const task of Object.values(run.tasks)) {
    if (!["dispatching", "running"].includes(task.status)) {
      continue;
    }
    const attempt = task.attempts.at(-1);
    const statusFile = attempt.runner?.statusFile;
    if (!statusFile || !fs.existsSync(statusFile)) {
      updates.push({ taskId: task.id, status: task.status, waiting: true });
      continue;
    }
    const status = readJson(statusFile);
    syncExecutionStatus(cwd, runId, task.id, {
      attemptId: attempt.id,
      status
    });
    if (status.status === "running") {
      updates.push({ taskId: task.id, ...status });
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
        status: recorded.task.status,
        threadId: status.threadId,
        exitCode: status.exitCode
      });
      continue;
    }
    const unavailable = status.status === "failed"
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
      status: failed.status,
      threadId: status.threadId,
      exitCode: status.exitCode,
      error
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
  let codexCommand = ["codex"];
  try {
    codexCommand = readJson(attempt.runner.specFile).codexCommand ?? codexCommand;
  } catch {
    // Fall back to the default command; the spec only records an override.
  }
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
