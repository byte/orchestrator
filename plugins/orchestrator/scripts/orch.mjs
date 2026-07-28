#!/usr/bin/env node
import fs from "node:fs";
import process from "node:process";

import { evaluateRun } from "./lib/acceptance.mjs";
import { parseArgs, splitList } from "./lib/args.mjs";
import { briefingLedger, renderBriefing } from "./lib/briefing.mjs";
import { captureGitSnapshot, changesSinceSnapshot } from "./lib/git.mjs";
import { addLedgerEntry, readLedger } from "./lib/ledger.mjs";
import { addLane, bindThread, listLanes, removeLane, requireLane, unbindThread } from "./lib/lanes.mjs";
import { preflight } from "./lib/preflight.mjs";
import { renderAcceptance, renderLanes, renderPreflight } from "./lib/render.mjs";
import {
  addCheckpoint,
  bindAttempt,
  checkpointStatus,
  cancelRun,
  cancelTask,
  claimTask,
  createRun,
  finalizeRun,
  listRuns,
  loadRun,
  readyTasks,
  recordTaskResult,
  recordIntegration,
  recoveryReport,
  renderSupervisorBriefing,
  replacePlan,
  retryTask,
  verifyTask
} from "./lib/runs.mjs";
import { launchTaskWorker, pollRunWorkers, stopTaskWorker } from "./lib/workers.mjs";
import {
  cleanupTaskWorktree,
  inspectTaskWorktree,
  integrateTaskWorktree
} from "./lib/worktrees.mjs";
import {
  initWorkspace,
  isInitialized,
  loadLocalState,
  nowIso,
  orchDir,
  updateLocalState
} from "./lib/state.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

const USAGE = `orchestrator — keep Codex briefed across tasks

Usage:
  orch preflight [--json]
  orch init
  orch lane list [--json]
  orch lane add <name> [--description <text>] [--scope <glob>]... [--constraint <text>]... [--done <text>]
  orch lane remove <name>
  orch lane show <name> [--json]
  orch lane bind <name> <thread-id>
  orch lane unbind <name>
  orch brief <name> [--task <text>] [--no-snapshot] [--json]
  orch accept <name> [--result-file <path>] [--json]
  orch ledger show
  orch ledger add <section> <text>
  orch run list [--json]
  orch run create <lane> --objective <text> [--id <run-id>] [--max-workers <n>] [--model <sol|terra|luna>] [--effort <level>] [--json]
  orch run show <run-id> [--json]
  orch run plan <run-id> --plan-file <path> [--json]
  orch run ready <run-id> [--json]
  orch run briefing <run-id>
  orch run resume <run-id> [--json]
  orch run checkpoint <run-id> --summary <text> [--decision <text>]... [--risk <text>]... [--next <text>]...
  orch run claim <run-id> <task-id> [--json]
  orch run bind <run-id> <task-id> --attempt <id> [--agent-id <id>] [--job-id <id>] [--thread-id <id>]
  orch run report <run-id> <task-id> --attempt <id> --result-file <path> [--json]
  orch run verify <run-id> <task-id> --verdict <pass|fail> [--evidence <text>]... [--json]
  orch run retry <run-id> <task-id> [--json]
  orch run cancel <run-id> [task-id] [--reason <text>] [--json]
  orch run recover <run-id> [--json]
  orch run launch <run-id> <task-id> [--json]
  orch run poll <run-id> [--json]
  orch run inspect <run-id> <task-id> [--json]
  orch run integrate <run-id> <task-id> [--evidence <text>]... [--json]
  orch run finalize <run-id> --verdict <pass|fail> --summary <text> [--evidence <text>]... [--json]
  orch run cleanup <run-id> [task-id] [--json]
`;

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

function emit(text) {
  process.stdout.write(`${text}\n`);
}

function emitJson(payload) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function requireInitialized(cwd) {
  if (!isInitialized(cwd)) {
    throw new Error("Orchestrator is not initialized in this repository. Run /orch:init first.");
  }
}

function readTask(options, positionals) {
  if (options.task) {
    return String(options.task);
  }
  if (options["task-file"]) {
    return fs.readFileSync(options["task-file"], "utf8");
  }
  const inline = positionals.join(" ").trim();
  if (inline) {
    return inline;
  }
  throw new Error("A task description is required. Pass --task, --task-file, or trailing text.");
}

function commandPreflight(argv, cwd) {
  const { options } = parseArgs(argv, { booleanOptions: ["json"] });
  const report = preflight(cwd);
  if (options.json) {
    emitJson(report);
  } else {
    emit(renderPreflight(report));
  }
  if (!report.ok) {
    process.exitCode = 1;
  }
}

function commandInit(cwd) {
  const report = preflight(cwd);
  const { dir, created } = initWorkspace(cwd);

  const lines = [`Initialized orchestrator at ${dir}`, ""];
  lines.push(created.length ? `Created:\n${created.map((file) => `- ${file}`).join("\n")}` : "Nothing to create; already initialized.");
  lines.push("");
  lines.push("`local/` is self-ignored: thread bindings stay on this machine, lanes and the ledger are meant to be committed.");
  lines.push("");
  lines.push(renderPreflight(preflight(cwd)));
  if (!report.ok) {
    lines.push("", "Dispatch will not work until the blocking checks above are fixed.");
  }
  emit(lines.join("\n"));
}

function commandLane(argv, cwd) {
  requireInitialized(cwd);
  const [action = "list", ...rest] = argv;
  const { options, positionals } = parseArgs(rest, {
    booleanOptions: ["json"],
    repeatableOptions: ["scope", "constraint"],
    valueOptions: ["description", "done"]
  });

  if (action === "list") {
    const lanes = listLanes(cwd);
    return options.json ? emitJson(lanes) : emit(renderLanes(lanes));
  }

  const name = positionals[0];
  if (!name) {
    throw new Error(`\`orch lane ${action}\` requires a lane name.`);
  }

  if (action === "add") {
    const lane = addLane(cwd, name, {
      description: options.description ?? "",
      scope: splitList(options.scope),
      constraints: splitList(options.constraint),
      done: options.done ?? ""
    });
    return options.json ? emitJson(lane) : emit(renderLanes([lane]));
  }

  if (action === "remove") {
    const removed = removeLane(cwd, name);
    return emit(removed ? `Removed lane "${name}".` : `No lane named "${name}".`);
  }

  if (action === "show") {
    const lane = requireLane(cwd, name);
    return options.json ? emitJson(lane) : emit(renderLanes([lane]));
  }

  if (action === "bind") {
    requireLane(cwd, name);
    const threadId = positionals[1];
    if (!threadId) {
      throw new Error("`orch lane bind` requires a thread id.");
    }
    const bound = bindThread(cwd, name, threadId);
    return emit(`Bound lane "${bound.lane}" to Codex thread ${bound.threadId}.`);
  }

  if (action === "unbind") {
    unbindThread(cwd, name);
    return emit(`Unbound lane "${name}". The next dispatch starts a fresh Codex thread.`);
  }

  throw new Error(`Unknown lane action "${action}".`);
}

function commandBrief(argv, cwd) {
  requireInitialized(cwd);
  const { options, positionals } = parseArgs(argv, {
    booleanOptions: ["json", "no-snapshot"],
    valueOptions: ["task", "task-file"]
  });
  const name = positionals.shift();
  if (!name) {
    throw new Error("`orch brief` requires a lane name.");
  }

  const lane = requireLane(cwd, name);
  const task = readTask(options, positionals);
  const ledger = briefingLedger(cwd);
  const resuming = Boolean(lane.threadId);
  const text = renderBriefing({ lane, task, ledger, resuming });

  // Snapshot before dispatch so the acceptance check can attribute changes to
  // this run rather than to whatever was already dirty in the tree.
  if (!options["no-snapshot"]) {
    updateLocalState(cwd, (local) => {
      local.snapshots[lane.name] = {
        ...captureGitSnapshot(cwd),
        task,
        takenAt: nowIso()
      };
    });
  }

  if (options.json) {
    return emitJson({
      lane: lane.name,
      resuming,
      threadId: lane.threadId,
      ledgerBytes: ledger.bytes,
      ledgerOversized: ledger.oversized,
      briefing: text
    });
  }

  if (ledger.oversized) {
    process.stderr.write(
      `warning: ledger is ${ledger.bytes} bytes and rides along in every briefing. Consider pruning it.\n`
    );
  }
  emit(text);
}

function commandAccept(argv, cwd) {
  requireInitialized(cwd);
  const { options, positionals } = parseArgs(argv, {
    booleanOptions: ["json"],
    valueOptions: ["result-file"]
  });
  const name = positionals.shift();
  if (!name) {
    throw new Error("`orch accept` requires a lane name.");
  }

  const lane = requireLane(cwd, name);
  const local = loadLocalState(cwd);
  const snapshot = local.snapshots[lane.name];
  if (!snapshot) {
    throw new Error(`No pre-dispatch snapshot for lane "${lane.name}". Run \`orch brief\` before dispatching.`);
  }

  let resultText = "";
  if (options["result-file"]) {
    resultText = fs.readFileSync(options["result-file"], "utf8");
  } else if (positionals.length) {
    resultText = positionals.join(" ");
  }

  const evaluation = evaluateRun({
    lane,
    snapshot,
    changeSet: changesSinceSnapshot(cwd, snapshot),
    resultText
  });

  if (options.json) {
    emitJson({ lane: lane.name, ...evaluation });
  } else {
    emit(renderAcceptance(lane, evaluation));
  }

  if (evaluation.verdict !== "clean") {
    process.exitCode = 2;
  }
}

function commandLedger(argv, cwd) {
  requireInitialized(cwd);
  const [action = "show", ...rest] = argv;

  if (action === "show") {
    return emit(readLedger(cwd).trimEnd());
  }

  if (action === "add") {
    const section = rest.shift();
    const text = rest.join(" ").trim();
    if (!section || !text) {
      throw new Error("`orch ledger add` requires a section and text.");
    }
    const entry = addLedgerEntry(cwd, section, text);
    return emit(`Added to ${entry.section}: ${entry.entry}`);
  }

  throw new Error(`Unknown ledger action "${action}".`);
}

function renderRunSummary(run) {
  const taskCounts = Object.values(run.tasks).reduce((counts, task) => {
    counts[task.status] = (counts[task.status] ?? 0) + 1;
    return counts;
  }, {});
  return [
    `# Run ${run.id}`,
    "",
    run.objective,
    "",
    `- status: ${run.status}`,
    `- lane: ${run.lane}`,
    `- workers: ${run.workerPolicy.maxWorkers} max; default ${run.workerPolicy.model} (${run.workerPolicy.reasoningEffort})`,
    `- plan revision: ${run.planRevision}`,
    `- tasks: ${Object.entries(taskCounts).map(([status, count]) => `${status}=${count}`).join(", ") || "none"}`
  ].join("\n");
}

function commandRun(argv, cwd) {
  requireInitialized(cwd);
  const [action = "list", ...rest] = argv;

  if (action === "list") {
    const { options } = parseArgs(rest, { booleanOptions: ["json"] });
    const runs = listRuns(cwd);
    if (options.json) {
      return emitJson(runs);
    }
    return emit(runs.length ? runs.map(renderRunSummary).join("\n\n") : "No orchestration runs yet.");
  }

  if (action === "create") {
    const { options, positionals } = parseArgs(rest, {
      booleanOptions: ["json"],
      valueOptions: ["objective", "id", "max-workers", "model", "effort"]
    });
    const laneName = positionals[0];
    if (!laneName) {
      throw new Error("`orch run create` requires a lane name.");
    }
    requireLane(cwd, laneName);
    const run = createRun(cwd, {
      id: options.id,
      lane: laneName,
      objective: options.objective,
      maxWorkers: options["max-workers"],
      workerModel: options.model,
      reasoningEffort: options.effort
    });
    return options.json ? emitJson(run) : emit(renderRunSummary(run));
  }

  const { options, positionals } = parseArgs(rest, {
    booleanOptions: ["json"],
    repeatableOptions: ["decision", "risk", "next", "evidence"],
    valueOptions: [
      "plan-file",
      "summary",
      "attempt",
      "agent-id",
      "job-id",
      "thread-id",
      "result-file",
      "verdict",
      "reason"
    ]
  });
  const runId = positionals[0];
  if (!runId) {
    throw new Error(`\`orch run ${action}\` requires a run id.`);
  }

  if (action === "show") {
    const run = loadRun(cwd, runId);
    return options.json ? emitJson(run) : emit(renderRunSummary(run));
  }

  if (action === "plan") {
    if (!options["plan-file"]) {
      throw new Error("`orch run plan` requires --plan-file.");
    }
    const payload = JSON.parse(fs.readFileSync(options["plan-file"], "utf8"));
    const run = loadRun(cwd, runId);
    const lane = requireLane(cwd, run.lane);
    const tasks = Array.isArray(payload) ? payload : payload.tasks;
    const updated = replacePlan(cwd, runId, tasks, { defaultScope: lane.scope });
    return options.json ? emitJson(updated) : emit(renderRunSummary(updated));
  }

  if (action === "ready") {
    const run = loadRun(cwd, runId);
    const tasks = readyTasks(run);
    const checkpoint = checkpointStatus(run);
    if (options.json) {
      return emitJson({ tasks, checkpoint });
    }
    const lines = tasks.length
      ? tasks.map((task) => `${task.id}\t${task.title}`)
      : ["No tasks are ready."];
    if (checkpoint.stale) {
      lines.push(
        `checkpoint: stale — ${checkpoint.reason}`,
        checkpoint.current
          ? "Record one at this wave boundary so the reasoning survives compaction."
          : "Dispatch is blocked until a checkpoint covers the current plan revision."
      );
    }
    return emit(lines.join("\n"));
  }

  if (action === "briefing") {
    const run = loadRun(cwd, runId);
    return emit(renderSupervisorBriefing(cwd, run, requireLane(cwd, run.lane)).trimEnd());
  }

  if (action === "resume") {
    const updates = pollRunWorkers(cwd, runId);
    const run = loadRun(cwd, runId);
    const recovery = recoveryReport(run);
    const briefing = renderSupervisorBriefing(cwd, run, requireLane(cwd, run.lane)).trimEnd();
    return options.json
      ? emitJson({ updates, recovery, run, briefing, checkpoint: checkpointStatus(run) })
      : emit(`${briefing}\n\n## Active worker recovery\n\n${recovery.length ? recovery.map((item) => `- ${item.taskId}: ${item.model} (${item.reasoningEffort}), pid ${item.runnerPid ?? "unknown"}, thread ${item.threadId ?? "pending"}, worktree ${item.worktreePath ?? "unavailable"}`).join("\n") : "- none"}`);
  }

  if (action === "checkpoint") {
    const checkpoint = addCheckpoint(cwd, runId, {
      summary: options.summary,
      decisions: splitList(options.decision),
      risks: splitList(options.risk),
      next: splitList(options.next)
    });
    return options.json ? emitJson(checkpoint) : emit(`Checkpoint recorded for ${runId}: ${checkpoint.summary}`);
  }

  if (action === "claim") {
    const taskId = positionals[1];
    if (!taskId) {
      throw new Error("`orch run claim` requires a task id.");
    }
    const run = loadRun(cwd, runId);
    const dispatch = claimTask(cwd, runId, taskId, requireLane(cwd, run.lane));
    return options.json ? emitJson(dispatch) : emit(dispatch.briefing.trimEnd());
  }

  if (action === "bind") {
    const taskId = positionals[1];
    if (!taskId || !options.attempt) {
      throw new Error("`orch run bind` requires a task id and --attempt.");
    }
    const attempt = bindAttempt(cwd, runId, taskId, {
      attemptId: options.attempt,
      agentId: options["agent-id"],
      jobId: options["job-id"],
      threadId: options["thread-id"]
    });
    return options.json ? emitJson(attempt) : emit(`Bound ${attempt.id}; task is running.`);
  }

  if (action === "report") {
    const taskId = positionals[1];
    if (!taskId || !options.attempt || !options["result-file"]) {
      throw new Error("`orch run report` requires a task id, --attempt, and --result-file.");
    }
    const result = recordTaskResult(cwd, runId, taskId, {
      attemptId: options.attempt,
      resultText: fs.readFileSync(options["result-file"], "utf8")
    });
    return options.json ? emitJson(result) : emit(`Recorded ${result.task.status} result for ${taskId}.`);
  }

  if (action === "verify") {
    const taskId = positionals[1];
    if (!taskId) {
      throw new Error("`orch run verify` requires a task id.");
    }
    const result = verifyTask(cwd, runId, taskId, {
      verdict: options.verdict,
      evidence: splitList(options.evidence)
    });
    return options.json
      ? emitJson(result)
      : emit(`Task ${taskId}: ${result.task.status}; run: ${result.runStatus}.`);
  }

  if (action === "retry") {
    const taskId = positionals[1];
    if (!taskId) {
      throw new Error("`orch run retry` requires a task id.");
    }
    const task = retryTask(cwd, runId, taskId);
    return options.json ? emitJson(task) : emit(`Task ${taskId} is pending retry.`);
  }

  if (action === "cancel") {
    const taskId = positionals[1];
    const activeRun = loadRun(cwd, runId);
    const activeTasks = taskId
      ? [activeRun.tasks[taskId]]
      : Object.values(activeRun.tasks);
    for (const task of activeTasks.filter(Boolean)) {
      stopTaskWorker(task.attempts.at(-1));
    }
    const result = taskId
      ? cancelTask(cwd, runId, taskId, options.reason)
      : cancelRun(cwd, runId, options.reason);
    return options.json ? emitJson(result) : emit(taskId ? `Cancelled task ${taskId}.` : `Cancelled run ${runId}.`);
  }

  if (action === "recover") {
    const report = recoveryReport(loadRun(cwd, runId));
    return options.json
      ? emitJson(report)
      : emit(report.length ? report.map((item) => `${item.taskId}\t${item.attemptStatus}\t${item.model}\t${item.reasoningEffort}\t${item.jobId ?? item.agentId ?? "unbound"}`).join("\n") : "No active workers need recovery.");
  }

  if (action === "launch") {
    const taskId = positionals[1];
    if (!taskId) {
      throw new Error("`orch run launch` requires a task id.");
    }
    const run = loadRun(cwd, runId);
    const launched = launchTaskWorker(cwd, runId, taskId, requireLane(cwd, run.lane));
    return options.json
      ? emitJson(launched)
      : emit(`Launched ${taskId} as PID ${launched.runner.pid} in ${launched.worktree.path}.`);
  }

  if (action === "poll") {
    const updates = pollRunWorkers(cwd, runId);
    return options.json
      ? emitJson(updates)
      : emit(updates.length ? updates.map((update) => `${update.taskId}\t${update.status}`).join("\n") : "No active workers.");
  }

  if (action === "inspect") {
    const run = loadRun(cwd, runId);
    const taskId = positionals[1];
    const task = run.tasks[taskId];
    if (!task) {
      throw new Error(`Unknown task "${taskId}" in run "${runId}".`);
    }
    const inspection = inspectTaskWorktree(task, task.attempts.at(-1));
    return options.json ? emitJson(inspection) : emitJson(inspection);
  }

  if (action === "integrate") {
    const run = loadRun(cwd, runId);
    const taskId = positionals[1];
    const task = run.tasks[taskId];
    if (!task) {
      throw new Error(`Unknown task "${taskId}" in run "${runId}".`);
    }
    const integrated = integrateTaskWorktree(cwd, run, task, task.attempts.at(-1));
    const result = recordIntegration(cwd, runId, taskId, {
      evidence: splitList(options.evidence),
      ...integrated
    });
    return options.json ? emitJson(result) : emit(`Integrated ${taskId}; run: ${result.runStatus}.`);
  }

  if (action === "finalize") {
    const run = finalizeRun(cwd, runId, {
      verdict: options.verdict,
      summary: options.summary,
      evidence: splitList(options.evidence)
    });
    return options.json
      ? emitJson(run)
      : emit(`Run ${runId}: ${run.status}; final verification ${run.finalization.verdict}.`);
  }

  if (action === "cleanup") {
    const run = loadRun(cwd, runId);
    const taskId = positionals[1];
    const tasks = taskId ? [run.tasks[taskId]] : Object.values(run.tasks);
    if (tasks.some((task) => !task)) {
      throw new Error(`Unknown task "${taskId}" in run "${runId}".`);
    }
    const removed = [];
    for (const task of tasks) {
      if (!["completed", "failed", "blocked", "cancelled"].includes(task.status)) {
        continue;
      }
      for (const attempt of task.attempts) {
        if (cleanupTaskWorktree(cwd, attempt)) {
          removed.push(attempt.worktree.path);
        }
      }
    }
    return options.json ? emitJson(removed) : emit(removed.length ? `Removed:\n${removed.map((entry) => `- ${entry}`).join("\n")}` : "No completed worktrees to remove.");
  }

  throw new Error(`Unknown run action "${action}".`);
}

function main() {
  const [, , command = "help", ...argv] = process.argv;
  const cwd = resolveWorkspaceRoot(process.cwd());

  try {
    switch (command) {
      case "preflight":
        return commandPreflight(argv, cwd);
      case "init":
        return commandInit(cwd);
      case "lane":
        return commandLane(argv, cwd);
      case "brief":
        return commandBrief(argv, cwd);
      case "accept":
        return commandAccept(argv, cwd);
      case "ledger":
        return commandLedger(argv, cwd);
      case "run":
        return commandRun(argv, cwd);
      case "where":
        return emit(orchDir(cwd));
      case "help":
      case "--help":
      case "-h":
        return emit(USAGE);
      default:
        return fail(`Unknown command "${command}".\n\n${USAGE}`);
    }
  } catch (error) {
    return fail(`error: ${error.message}`);
  }
}

main();
