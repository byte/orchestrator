#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { parseArgs, splitList } from "./lib/args.mjs";
import {
  createProvisionalGuidancePolicy,
  deriveReviewedGuidanceSources
} from "./lib/guidance.mjs";
import { addLedgerEntry, readLedger } from "./lib/ledger.mjs";
import { addLane, listLanes, removeLane, requireLane } from "./lib/lanes.mjs";
import {
  collectLearningExamples,
  exportLearningExamples,
  inspectLearningExample,
  labelLearningExample,
  listLearningExamples,
  opaqueLearningLaneRef,
  purgeLearningExamples
} from "./lib/learning.mjs";
import { preflight } from "./lib/preflight.mjs";
import { renderLanes, renderPreflight } from "./lib/render.mjs";
import {
  addCheckpoint,
  bindAttempt,
  checkpointStatus,
  claimTask,
  configureRunGuidance,
  createRun,
  finalizeRun,
  integrateRunTask,
  listRuns,
  loadRun,
  takeWorktreesForRemoval,
  readyTasks,
  effectiveTaskRoute,
  grantedSurfaceConflicts,
  summarizeInputRequest,
  recordIntegrationDiagnostic,
  recordTaskResult,
  recordTaskDisposition,
  recoverRunIntegration,
  modelSubstitutionSummary,
  recoveryReport,
  renderSupervisorBriefing,
  replacePlan,
  retryTask,
  verifyTask
} from "./lib/runs.mjs";
import {
  answerTaskWorker,
  attemptLive,
  launchTaskWorker,
  pollRunWorkers,
  cancelWorkers,
  removeLeftoverScratch
} from "./lib/workers.mjs";
import {
  ROUTE_TABLE_MIN_ATTEMPTS,
  renderRouteEvidence,
  routeEvidence
} from "./lib/routes.mjs";
import {
  DEFAULT_WAIT_INTERVAL_SECONDS,
  DEFAULT_WAIT_TIMEOUT_SECONDS,
  waitForRunChange
} from "./lib/wait.mjs";
import {
  detachTaskWorktree,
  finishWorktreeRemoval,
  inspectTaskWorktree,
  WorktreeOperationError
} from "./lib/worktrees.mjs";
import { initWorkspace, isInitialized, orchDir } from "./lib/state.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

const USAGE = `orchestrator — a Claude-supervised Codex worker pool

Usage:
  orch preflight [--json]
  orch init
  orch lane list [--json]
  orch lane add <name> [--description <text>] [--scope <glob>]... [--constraint <text>]... [--done <text>]
  orch lane remove <name>
  orch lane show <name> [--json]
  orch ledger show
  orch ledger add <section> <text>
  orch learn collect [--run <id>]... [--retention-days <n|forever>] [--json]
  orch learn list [--run <id>]... [--outcome <value>]... [--sample <id>]... [--json]
  orch learn inspect <sample-id> [--json]
  orch learn label <sample-id> --outcome <value> --action <value> --reason-code <code> --provenance <supervisor|user|imported> [--json]
  orch learn export [--name <id>] [--run <id>]... [--outcome <value>]... [--sample <id>]... [--include-text <field>]... [--consent <supervisor|user>] [--acknowledge-sensitive-export] [--json]
  orch learn purge [--sample <id>]... [--run <id>]... [--task <id>]... [--attempt <id>]... [--expired|--all] [--json]
  orch run list [--json]
  orch run routes [--lane <lane>] [--include-legacy] [--json]
      per model and effort: attempts, first-attempt acceptance (rate only when n>=5), retries, median duration
  orch run create <lane> --objective <text> [--id <run-id>] [--max-workers <n>] [--model <auto|astra|sol|terra|luna>] [--effort <auto|level>] [--json]
  orch run show <run-id> [--json]
  orch run plan <run-id> --plan-file <path> [--json]
  orch run ready <run-id> [--json]
  orch run briefing <run-id>
  orch run guidance <run-id> (--mode <provisional|off> [--policy-version <id>] | --rollback) [--json]
  orch run resume <run-id> [--json]
  orch run checkpoint <run-id> --summary <text> [--decision <text>]... [--risk <text>]... [--next <text>]...
  orch run claim <run-id> <task-id> [--json]
  orch run bind <run-id> <task-id> --attempt <id> [--agent-id <id>] [--job-id <id>] [--thread-id <id>]
  orch run report <run-id> <task-id> --attempt <id> --result-file <path> [--json]
  orch run verify <run-id> <task-id> --verdict <pass|fail> [--evidence <text>]... [--json]
  orch run decide <run-id> <task-id> --outcome <policy_refused|authority_escalated|integration_failed> --action <refuse|escalate|replan> --reason-code <code> [--evidence <text>]... [--json]
  orch run retry <run-id> <task-id> [--note <what to change>] [--fresh] [--json]
  orch run answer <run-id> <task-id> (--grant-scope <glob>... [--user-approved] | --deny | --reply <text>) [--reply <text>] [--json]
  orch run cancel <run-id> [task-id] [--reason <text>] [--json]
  orch run recover <run-id> [--json]
  orch run launch <run-id> <task-id> [--json]
  orch run poll <run-id> [--json]
  orch run wait <run-id> [--timeout <seconds>] [--interval <seconds>] [--no-watch] [--json]
      exit 0 changed (poll payload), 2 timed out, 3 no active workers, 4 only paused workers awaiting an answer
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
    throw new Error("Orchestrator is not initialized in this repository. Run /orchestrator:init first.");
  }
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
  lines.push("`local/` is self-ignored: run state, worker handles, and worktrees stay on this machine; lanes and the ledger are meant to be committed.");
  lines.push("");
  lines.push(renderPreflight(preflight(cwd)));
  if (!report.ok) {
    lines.push("", "Dispatch will not work until the blocking checks above are fixed.");
  }
  emit(lines.join("\n"));
}

function retentionDays(value) {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (String(value).trim().toLowerCase() === "forever") {
    return 0;
  }
  const days = Number(value);
  if (!Number.isInteger(days) || days < 1 || days > 36500) {
    throw new Error("--retention-days must be an integer from 1 through 36500, or forever.");
  }
  return days;
}

function commandLearn(argv, cwd) {
  requireInitialized(cwd);
  const [action = "list", ...rest] = argv;

  if (action === "collect") {
    const { options, positionals } = parseArgs(rest, {
      booleanOptions: ["json"],
      repeatableOptions: ["run"],
      valueOptions: ["retention-days"]
    });
    if (positionals.length) {
      throw new Error("`orch learn collect` does not accept positional arguments.");
    }
    const days = retentionDays(options["retention-days"]);
    const result = collectLearningExamples(cwd, {
      runIds: splitList(options.run),
      ...(days === undefined ? {} : { retentionDays: days })
    });
    return options.json
      ? emitJson(result)
      : emit(
          `Collected ${result.created} new and ${result.updated} updated samples; ` +
          `${result.unchanged} unchanged, ${result.skippedWithoutOutcome} skipped, ` +
          `${result.total} total.`
        );
  }

  if (action === "list") {
    const { options, positionals } = parseArgs(rest, {
      booleanOptions: ["json"],
      repeatableOptions: ["run", "outcome", "sample"]
    });
    if (positionals.length) {
      throw new Error("`orch learn list` does not accept positional arguments.");
    }
    const examples = listLearningExamples(cwd, {
      runIds: splitList(options.run),
      outcomes: splitList(options.outcome),
      sampleIds: splitList(options.sample)
    });
    return options.json
      ? emitJson(examples)
      : emit(
          examples.length
            ? examples.map((example) =>
                `${example.sampleId}\t${example.outcome.terminalOutcome}\t` +
                `${example.outcome.action}\t${example.features.model ?? "unrouted"}`
              ).join("\n")
            : "No learning samples."
        );
  }

  if (action === "inspect") {
    const { options, positionals } = parseArgs(rest, { booleanOptions: ["json"] });
    if (positionals.length !== 1) {
      throw new Error("`orch learn inspect` requires one sample id.");
    }
    const example = inspectLearningExample(cwd, positionals[0]);
    return options.json ? emitJson(example) : emitJson(example);
  }

  if (action === "label") {
    const { options, positionals } = parseArgs(rest, {
      booleanOptions: ["json"],
      valueOptions: ["outcome", "action", "reason-code", "provenance"]
    });
    if (positionals.length !== 1) {
      throw new Error("`orch learn label` requires one sample id.");
    }
    for (const required of ["outcome", "action", "reason-code", "provenance"]) {
      if (!options[required]) {
        throw new Error(`\`orch learn label\` requires --${required}.`);
      }
    }
    const result = labelLearningExample(cwd, positionals[0], {
      terminalOutcome: options.outcome,
      action: options.action,
      reasonCode: options["reason-code"],
      provenance: options.provenance
    });
    return options.json
      ? emitJson(result)
      : emit(`${result.created ? "Recorded" : "Retained existing"} label ${result.label.labelId}.`);
  }

  if (action === "export") {
    const { options, positionals } = parseArgs(rest, {
      booleanOptions: ["json", "acknowledge-sensitive-export"],
      repeatableOptions: ["run", "outcome", "sample", "include-text"],
      valueOptions: ["name", "consent"]
    });
    if (positionals.length) {
      throw new Error("`orch learn export` does not accept positional arguments.");
    }
    const result = exportLearningExamples(cwd, {
      name: options.name,
      runIds: splitList(options.run),
      outcomes: splitList(options.outcome),
      sampleIds: splitList(options.sample),
      includeTextFields: splitList(options["include-text"]),
      consentProvenance: options.consent ?? null,
      acknowledgeSensitiveExport: Boolean(options["acknowledge-sensitive-export"])
    });
    return options.json
      ? emitJson(result)
      : emit(`Created managed local export ${result.manifest.exportId} with ${result.manifest.sampleCount} samples.`);
  }

  if (action === "purge") {
    const { options, positionals } = parseArgs(rest, {
      booleanOptions: ["json", "expired", "all"],
      repeatableOptions: ["sample", "run", "task", "attempt"]
    });
    if (positionals.length) {
      throw new Error("`orch learn purge` does not accept positional arguments.");
    }
    const result = purgeLearningExamples(cwd, {
      sampleIds: splitList(options.sample),
      runIds: splitList(options.run),
      taskIds: splitList(options.task),
      attemptIds: splitList(options.attempt),
      expired: Boolean(options.expired),
      all: Boolean(options.all)
    });
    return options.json
      ? emitJson(result)
      : emit(
          `Purged ${result.removedCount} samples, ${result.labelsRemoved} labels, and ` +
          `${result.exportsRemoved.length} managed exports. Raw run audit data was not changed.`
        );
  }

  throw new Error(`Unknown learn action "${action}".`);
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

  throw new Error(`Unknown lane action "${action}".`);
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

function renderPollUpdate(update) {
  if (update.overLimit && ["running", "dispatching"].includes(update.status)) {
    return `${update.taskId}\t${update.status}\tOVER LIMIT: running ${update.overLimit.elapsedMinutes} min against a ` +
      `${update.overLimit.timeoutMinutes}-minute limit; still running (not stopped). Keep waiting or \`run cancel\` it.`;
  }
  if (update.inputRequest) {
    const detail = summarizeInputRequest(update.inputRequest);
    return `${update.taskId}\t${update.status}\trequest ${update.round}: ${detail}; answer with \`run answer\``;
  }
  if (update.inputCapReached) {
    return `${update.taskId}\t${update.status}\tinput request cap reached; the further request was recorded as a blocker`;
  }
  if (update.notice) {
    return `${update.taskId}\t${update.status}\t${update.notice} New attempt ${update.nextAttemptId}.`;
  }
  if (update.unavailableModel) {
    const next = update.fallbackModel
      ? `relaunch on ${update.fallbackModel} failed: ${update.relaunchError ?? "unknown error"}`
      : "no model remains on the fallback ladder";
    return `${update.taskId}\t${update.status}\t${update.unavailableModel} unavailable; ${next}`;
  }
  if (update.resumeFallback) {
    return `${update.taskId}\t${update.status}\tresume fell back to a fresh thread (${update.resumeFallback.reason})`;
  }
  return `${update.taskId}\t${update.status}`;
}

function renderRunSummary(run) {
  const taskCounts = Object.values(run.tasks).reduce((counts, task) => {
    counts[task.status] = (counts[task.status] ?? 0) + 1;
    return counts;
  }, {});
  const legacyRouting = !Object.hasOwn(run.workerPolicy, "routingMode");
  const modelRoute = legacyRouting
    ? `legacy default ${run.workerPolicy.model}`
    : run.workerPolicy.model
      ? `pinned ${run.workerPolicy.model}`
      : "supervisor auto";
  const effortRoute = legacyRouting
    ? `legacy default ${run.workerPolicy.reasoningEffort}`
    : run.workerPolicy.reasoningEffort
      ? `pinned ${run.workerPolicy.reasoningEffort}`
      : "supervisor auto";
  return [
    `# Run ${run.id}`,
    "",
    run.objective,
    "",
    `- status: ${run.status}`,
    `- lane: ${run.lane}`,
    `- workers: ${run.workerPolicy.maxWorkers} max; model ${modelRoute}; effort ${effortRoute}`,
    `- guidance: ${run.guidance?.mode ?? "legacy-disabled"}; revision ${run.guidance?.revision ?? 0}`,
    `- plan revision: ${run.planRevision}`,
    `- tasks: ${Object.entries(taskCounts).map(([status, count]) => `${status}=${count}`).join(", ") || "none"}`
  ].join("\n");
}

function seconds(value, label, fallback) {
  if (value === undefined || value === null) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive number of seconds.`);
  }
  return parsed;
}

/**
 * Block until a worker changes state and print the `run poll` payload. Meant to
 * be started as a background command: the harness re-invokes the supervisor when
 * it exits. The one-line reason goes to stderr so stdout stays the poll payload.
 */
async function commandRunWait(cwd, runId, options) {
  const result = await waitForRunChange(cwd, runId, {
    timeoutMs: seconds(options.timeout, "--timeout", DEFAULT_WAIT_TIMEOUT_SECONDS) * 1000,
    intervalMs: seconds(options.interval, "--interval", DEFAULT_WAIT_INTERVAL_SECONDS) * 1000,
    watch: !options["no-watch"]
  });
  if (options.json) {
    emitJson(result.updates);
  } else {
    emit(result.updates.length ? result.updates.map(renderPollUpdate).join("\n") : "No active workers.");
  }
  process.stderr.write(`${result.message} (exit ${result.exitCode})\n`);
  process.exitCode = result.exitCode;
}

/**
 * The route-evidence section for a run's own lane, or null while fewer than
 * ROUTE_TABLE_MIN_ATTEMPTS attempts can be counted there.
 */
function laneRouteEvidence(cwd, run) {
  const evidence = routeEvidence(cwd, { lane: run.lane });
  return {
    evidence,
    text: evidence.attempts >= ROUTE_TABLE_MIN_ATTEMPTS ? renderRouteEvidence(evidence) : null
  };
}

function commandRun(argv, cwd) {
  requireInitialized(cwd);
  const [action = "list", ...rest] = argv;

  if (action === "routes") {
    const { options, positionals } = parseArgs(rest, {
      booleanOptions: ["json", "include-legacy"],
      valueOptions: ["lane"]
    });
    if (positionals.length) {
      throw new Error("`orch run routes` does not accept positional arguments; use --lane <lane>.");
    }
    const evidence = routeEvidence(cwd, {
      lane: options.lane ? String(options.lane) : null,
      includeLegacy: Boolean(options["include-legacy"])
    });
    return options.json ? emitJson(evidence) : emit(renderRouteEvidence(evidence));
  }

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

  if (action === "guidance") {
    const { options, positionals } = parseArgs(rest, {
      booleanOptions: ["json", "rollback"],
      valueOptions: ["mode", "policy-version"]
    });
    const runId = positionals[0];
    if (!runId || positionals.length !== 1) {
      throw new Error("`orch run guidance` requires one run id.");
    }
    if (options.rollback && (options.mode || options["policy-version"])) {
      throw new Error("Guidance rollback cannot be combined with mode or policy-version options.");
    }
    let updated;
    if (options.rollback) {
      updated = configureRunGuidance(cwd, runId, { rollback: true });
    } else {
      const mode = String(options.mode ?? "").trim().toLowerCase();
      if (!mode) {
        throw new Error("`orch run guidance` requires --mode provisional|off or --rollback.");
      }
      if (mode === "provisional") {
        const run = loadRun(cwd, runId);
        const laneRef = opaqueLearningLaneRef(cwd, run.lane);
        const sources = laneRef
          ? deriveReviewedGuidanceSources(listLearningExamples(cwd), laneRef)
          : [];
        if (!sources.length) {
          throw new Error(
            "No supervisor- or user-reviewed non-execute outcomes are available for this lane."
          );
        }
        const policy = createProvisionalGuidancePolicy({
          policyVersion: options["policy-version"] ?? "provisional-v1",
          sources
        });
        updated = configureRunGuidance(cwd, runId, {
          mode,
          policy,
          laneRef
        });
      } else {
        if (options["policy-version"]) {
          throw new Error("Guidance policy-version is only valid with provisional mode.");
        }
        updated = configureRunGuidance(cwd, runId, { mode });
      }
    }
    return options.json
      ? emitJson(updated.guidance)
      : emit(
          `Run ${runId} guidance: ${updated.guidance.mode}; revision ` +
          `${updated.guidance.revision}; policy ` +
          `${updated.guidance.policy?.policyVersion ?? "none"}.`
        );
  }

  const { options, positionals } = parseArgs(rest, {
    booleanOptions: ["json", "fresh", "deny", "user-approved", "no-watch"],
    repeatableOptions: ["decision", "risk", "next", "evidence", "grant-scope"],
    valueOptions: [
      "plan-file",
      "summary",
      "attempt",
      "agent-id",
      "job-id",
      "thread-id",
      "result-file",
      "verdict",
      "reason",
      "outcome",
      "action",
      "reason-code",
      "provenance",
      "note",
      "reply",
      "timeout",
      "interval"
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
    if (options.json) {
      return emitJson(updated);
    }
    const routes = laneRouteEvidence(cwd, updated).text;
    return emit(routes ? `${routes}\n\n${renderRunSummary(updated)}` : renderRunSummary(updated));
  }

  if (action === "ready") {
    const run = loadRun(cwd, runId);
    // A ready task whose scope overlaps another active task's grant is refused by
    // `run launch`, so it is listed apart instead of offered for dispatch.
    const blocked = [];
    const tasks = readyTasks(run).filter((task) => {
      const conflicts = grantedSurfaceConflicts(run, task);
      const route = effectiveTaskRoute(run, task);
      if (route.exhausted) {
        conflicts.push(`${route.model} was rejected as unavailable and no allowed model remains; re-route it`);
      }
      if (conflicts.length) {
        blocked.push({ id: task.id, title: task.title, conflicts });
      }
      return !conflicts.length;
    });
    const checkpoint = checkpointStatus(run);
    if (options.json) {
      return emitJson({ tasks, blocked, checkpoint });
    }
    const lines = tasks.length
      ? tasks.map((task) => `${task.id}\t${task.title}`)
      : ["No tasks are ready."];
    for (const entry of blocked) {
      lines.push(`${entry.id}\tcannot launch: ${entry.conflicts.join("; ")}`);
    }
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
    const routes = laneRouteEvidence(cwd, run).text;
    return emit(renderSupervisorBriefing(cwd, run, requireLane(cwd, run.lane), { routeEvidence: routes }).trimEnd());
  }

  if (action === "resume") {
    const integrationRecovery = recoverRunIntegration(cwd, runId);
    if (integrationRecovery?.auditWarning && !options.json) {
      process.stderr.write(`${integrationRecovery.auditWarning}\n`);
    }
    const updates = pollRunWorkers(cwd, runId);
    const run = loadRun(cwd, runId);
    const recovery = recoveryReport(run);
    const substitutions = modelSubstitutionSummary(run);
    const routes = laneRouteEvidence(cwd, run);
    const briefing = renderSupervisorBriefing(cwd, run, requireLane(cwd, run.lane), {
      routeEvidence: routes.text
    }).trimEnd();
    const substitutedThisPoll = updates.filter((update) => update.notice).map(renderPollUpdate);
    return options.json
      ? emitJson({
          updates,
          integrationRecovery,
          recovery,
          substitutions,
          routes: routes.text ? routes.evidence : null,
          run,
          briefing,
          checkpoint: checkpointStatus(run)
        })
      : emit(`${substitutedThisPoll.length ? `${substitutedThisPoll.join("\n")}\n\n` : ""}${briefing}\n\n## Active worker recovery\n\n${recovery.length ? recovery.map((item) => `- ${item.taskId}: ${item.model} (${item.reasoningEffort})${item.substitution ? `, substituted for ${item.requestedModel}${item.substitution.pinned ? " (user pin overridden)" : ""}` : ""}${item.resumedFromAttemptId ? `, ${item.resumeFallback ? "fresh fallback of a warm retry of" : "warm retry resuming"} ${item.resumedFromAttemptId}` : ""}, pid ${item.runnerPid ?? "unknown"}, thread ${item.threadId ?? "pending"}, worktree ${item.worktreePath ?? "unavailable"}`).join("\n") : "- none"}`);
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

  if (action === "decide") {
    const taskId = positionals[1];
    if (!taskId || !options.outcome || !options.action || !options["reason-code"]) {
      throw new Error(
        "`orch run decide` requires a task id, --outcome, --action, and --reason-code."
      );
    }
    const result = recordTaskDisposition(cwd, runId, taskId, {
      terminalOutcome: options.outcome,
      action: options.action,
      reasonCode: options["reason-code"],
      provenance: options.provenance ?? "supervisor",
      evidence: splitList(options.evidence)
    });
    return options.json
      ? emitJson(result)
      : emit(`Task ${taskId}: ${result.task.status}; ${result.task.disposition.terminalOutcome}.`);
  }

  if (action === "retry") {
    const taskId = positionals[1];
    if (!taskId) {
      throw new Error("`orch run retry` requires a task id.");
    }
    const task = retryTask(cwd, runId, taskId, {
      note: options.note,
      fresh: Boolean(options.fresh)
    });
    const plan = task.retryPlan;
    const how = plan.mode === "warm"
      ? `warm: the next launch resumes the Codex thread of ${plan.previousAttemptId}`
      : `fresh: the next launch starts a new Codex thread (${plan.reason})`;
    const escalation = plan.escalationAdvised
      ? `\n${plan.warmFailures} warm retries of this task have already failed; escalate the route one tier in a revised plan instead of retrying again.`
      : "";
    return options.json
      ? emitJson(task)
      : emit(`Task ${taskId} is pending retry, ${how}; retry note: ${plan.note ? "recorded" : "none"}.${escalation}`);
  }

  if (action === "answer") {
    const taskId = positionals[1];
    if (!taskId) {
      throw new Error("`orch run answer` requires a task id.");
    }
    const run = loadRun(cwd, runId);
    const answered = answerTaskWorker(cwd, runId, taskId, requireLane(cwd, run.lane), {
      grantScope: splitList(options["grant-scope"]),
      deny: Boolean(options.deny),
      reply: options.reply ?? null,
      userApproved: Boolean(options["user-approved"])
    });
    const answer = answered.round.answer;
    const decision = answer.mode === "grant"
      ? `granted ${answer.patterns.join(", ")} to the task (${answer.insideLane ? "inside the lane" : "outside the lane, user-approved"})`
      : answer.mode === "deny" ? "denied" : "replied";
    return options.json
      ? emitJson(answered)
      : emit(
          `Answered request ${answered.round.round} of ${taskId}: ${decision}. Resumed thread ` +
          `${answered.resumeThreadId} on ${answered.model} (${answered.reasoningEffort}) in ` +
          `${answered.worktree.path} as PID ${answered.runner.pid}.`
        );
  }

  if (action === "cancel") {
    const taskId = positionals[1];
    const result = cancelWorkers(cwd, runId, taskId, options.reason);
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
      : emit(updates.length ? updates.map(renderPollUpdate).join("\n") : "No active workers.");
  }

  if (action === "wait") {
    return commandRunWait(cwd, runId, options);
  }

  if (action === "inspect") {
    const run = loadRun(cwd, runId);
    const taskId = positionals[1];
    const task = run.tasks[taskId];
    if (!task) {
      throw new Error(`Unknown task "${taskId}" in run "${runId}".`);
    }
    const inspection = inspectTaskWorktree(task, task.attempts.at(-1), { cwd });
    return options.json ? emitJson(inspection) : emitJson(inspection);
  }

  if (action === "integrate") {
    return integrateCommand(cwd, runId, positionals, options);
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
    const taskId = positionals[1];
    const removed = [];
    const { taken, refused } = takeWorktreesForRemoval(
      cwd, runId, taskId, (attempt) => detachTaskWorktree(cwd, attempt), attemptLive
    );
    for (const { taskId: owner, attempt, trash } of taken) {
      if (trash) {
        finishWorktreeRemoval(cwd, attempt, trash);
        removed.push(attempt.worktree.path);
      }
      removed.push(...removeLeftoverScratch(cwd, runId, owner, attempt.id));
    }
    if (refused.length) {
      throw new Error(
        `${removed.length ? `Removed:\n${removed.map((entry) => `- ${entry}`).join("\n")}\n` : ""}` +
        `Kept:\n${refused.map((entry) => `- ${entry.taskId} (${entry.attemptId}): ${entry.error}`).join("\n")}`
      );
    }
    return options.json ? emitJson(removed) : emit(removed.length ? `Removed:\n${removed.map((entry) => `- ${entry}`).join("\n")}` : "No completed worktrees to remove.");
  }

  throw new Error(`Unknown run action "${action}".`);
}

function integrateCommand(cwd, runId, positionals, options) {
  const taskId = positionals[1];
  let result;
  try {
    result = integrateRunTask(cwd, runId, taskId, { evidence: splitList(options.evidence) });
  } catch (error) {
    if (error instanceof WorktreeOperationError && !loadRun(cwd, runId).pendingIntegration) {
      recordIntegrationDiagnostic(cwd, runId, taskId, {
        kind: error.kind,
        reasonCode: error.reasonCode,
        signals: error.signals,
        error: error.message,
        details: error.details
      });
    }
    throw error;
  }
  return options.json ? emitJson(result) : emit(`Integrated ${taskId}; run: ${result.runStatus}.${result.auditWarning ? `\n${result.auditWarning}` : ""}`);
}

async function main() {
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
      case "ledger":
        return commandLedger(argv, cwd);
      case "learn":
        return commandLearn(argv, cwd);
      case "run":
        // Only `run wait` is asynchronous; awaiting keeps its errors in this catch.
        return await commandRun(argv, cwd);
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
    // A poll that could not finish every task still collected the others; their
    // state is saved, so show it rather than only the failure.
    if (Array.isArray(error.updates) && error.updates.length) {
      process.stdout.write(`${error.updates.map(renderPollUpdate).join("\n")}\n`);
    }
    return fail(`error: ${error.message}`);
  }
}

main();
