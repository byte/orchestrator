import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { ledgerForBriefing } from "./ledger.mjs";
import {
  STATE_VERSION,
  atomicWrite,
  localDir,
  nowIso,
  withFileLock
} from "./state.mjs";

export const DEFAULT_WORKER_MODEL = "gpt-5.6-sol";
export const DEFAULT_REASONING_EFFORT = "high";
export const DEFAULT_MAX_WORKERS = 3;

const RUN_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const TASK_ID_PATTERN = RUN_ID_PATTERN;
const TASK_KINDS = new Set(["write", "read", "verify"]);
const REASONING_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max", "ultra"]);

function runsDir(cwd) {
  return path.join(localDir(cwd), "runs");
}

export function runDir(cwd, runId) {
  return path.join(runsDir(cwd), assertId(runId, "run"));
}

export function runFile(cwd, runId) {
  return path.join(runDir(cwd, runId), "run.json");
}

export function eventsFile(cwd, runId) {
  return path.join(runDir(cwd, runId), "events.jsonl");
}

function assertId(value, kind) {
  const id = String(value ?? "").trim();
  const pattern = kind === "task" ? TASK_ID_PATTERN : RUN_ID_PATTERN;
  if (!pattern.test(id)) {
    throw new Error(
      `Invalid ${kind} id "${value}". Use lowercase letters, digits, dot, dash, or underscore.`
    );
  }
  return id;
}

function readRunFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`${filePath} is not valid JSON: ${error.message}`);
  }
  if (Number(parsed?.version ?? 0) > STATE_VERSION) {
    throw new Error(
      `${filePath} was written by a newer orchestrator (state version ${parsed.version}, this build supports ${STATE_VERSION}).`
    );
  }
  return parsed;
}

function appendEvent(cwd, runId, event) {
  const filePath = eventsFile(cwd, runId);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(
    filePath,
    `${JSON.stringify({ at: nowIso(), ...event })}\n`,
    { encoding: "utf8", mode: 0o600 }
  );
}

function writeRun(cwd, run) {
  run.version = STATE_VERSION;
  run.updatedAt = nowIso();
  atomicWrite(runFile(cwd, run.id), `${JSON.stringify(run, null, 2)}\n`);
  return run;
}

export function loadRun(cwd, runId) {
  const id = assertId(runId, "run");
  const run = readRunFile(runFile(cwd, id));
  if (!run) {
    throw new Error(`Unknown run "${id}".`);
  }
  return run;
}

export function listRuns(cwd) {
  const directory = runsDir(cwd);
  if (!fs.existsSync(directory)) {
    return [];
  }
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => readRunFile(path.join(directory, entry.name, "run.json")))
    .filter(Boolean)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function newRunId() {
  const timestamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
  return `run-${timestamp}-${randomUUID().slice(0, 8)}`;
}

function positiveInteger(value, label, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return parsed;
}

export function createRun(
  cwd,
  {
    id = newRunId(),
    lane,
    objective,
    maxWorkers = DEFAULT_MAX_WORKERS,
    reasoningEffort = DEFAULT_REASONING_EFFORT
  }
) {
  const runId = assertId(id, "run");
  const body = String(objective ?? "").trim();
  if (!body) {
    throw new Error("A run objective is required.");
  }
  const effort = String(reasoningEffort).trim().toLowerCase();
  if (!REASONING_EFFORTS.has(effort)) {
    throw new Error(
      `Unsupported reasoning effort "${reasoningEffort}". Use one of: ${[...REASONING_EFFORTS].join(", ")}.`
    );
  }
  const filePath = runFile(cwd, runId);
  return withFileLock(filePath, () => {
    if (fs.existsSync(filePath)) {
      throw new Error(`Run "${runId}" already exists.`);
    }
    const createdAt = nowIso();
    const run = {
      version: STATE_VERSION,
      id: runId,
      lane: String(lane),
      objective: body,
      status: "planning",
      workerPolicy: {
        model: DEFAULT_WORKER_MODEL,
        reasoningEffort: effort,
        maxWorkers: positiveInteger(maxWorkers, "max-workers", DEFAULT_MAX_WORKERS)
      },
      planRevision: 0,
      tasks: {},
      checkpoints: [],
      createdAt,
      updatedAt: createdAt
    };
    writeRun(cwd, run);
    appendEvent(cwd, runId, {
      type: "run.created",
      objective: body,
      lane: run.lane,
      workerPolicy: run.workerPolicy
    });
    return run;
  });
}

function stringList(value, label) {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${label} must be an array of strings.`);
  }
  return value.map((entry) => entry.trim()).filter(Boolean);
}

function normalizeTask(raw, defaultScope) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Every task must be an object.");
  }
  const id = assertId(raw.id, "task");
  const title = String(raw.title ?? "").trim();
  const objective = String(raw.objective ?? "").trim();
  if (!title || !objective) {
    throw new Error(`Task "${id}" requires both title and objective.`);
  }
  const kind = String(raw.kind ?? "write").trim().toLowerCase();
  if (!TASK_KINDS.has(kind)) {
    throw new Error(`Task "${id}" has unsupported kind "${kind}". Use write, read, or verify.`);
  }
  const scope = stringList(raw.scope ?? defaultScope, `Task "${id}" scope`);
  if (kind === "write" && !scope.length) {
    throw new Error(`Write task "${id}" requires at least one scope pattern.`);
  }
  return {
    id,
    title,
    objective,
    kind,
    scope,
    dependsOn: stringList(raw.dependsOn, `Task "${id}" dependsOn`).map((entry) =>
      assertId(entry, "task")
    ),
    constraints: stringList(raw.constraints, `Task "${id}" constraints`),
    acceptance: stringList(raw.acceptance, `Task "${id}" acceptance`),
    status: "pending",
    attempts: [],
    result: null,
    createdAt: nowIso(),
    updatedAt: nowIso()
  };
}

function validateGraph(tasks) {
  const ids = new Set(Object.keys(tasks));
  for (const task of Object.values(tasks)) {
    for (const dependency of task.dependsOn) {
      if (!ids.has(dependency)) {
        throw new Error(`Task "${task.id}" depends on unknown task "${dependency}".`);
      }
    }
  }

  const visiting = new Set();
  const visited = new Set();
  function visit(id, trail) {
    if (visiting.has(id)) {
      throw new Error(`Task dependency cycle: ${[...trail, id].join(" -> ")}.`);
    }
    if (visited.has(id)) {
      return;
    }
    visiting.add(id);
    for (const dependency of tasks[id].dependsOn) {
      visit(dependency, [...trail, id]);
    }
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of ids) {
    visit(id, []);
  }
}

export function replacePlan(cwd, runId, rawTasks, { defaultScope = [] } = {}) {
  if (!Array.isArray(rawTasks) || !rawTasks.length) {
    throw new Error("A run plan requires a non-empty tasks array.");
  }
  const id = assertId(runId, "run");
  const filePath = runFile(cwd, id);
  return withFileLock(filePath, () => {
    const run = loadRun(cwd, id);
    const active = Object.values(run.tasks).filter((task) => task.status !== "pending");
    if (active.length) {
      throw new Error(`Run "${id}" has started; its plan can no longer be replaced.`);
    }
    const tasks = {};
    for (const raw of rawTasks) {
      const task = normalizeTask(raw, defaultScope);
      if (tasks[task.id]) {
        throw new Error(`Duplicate task id "${task.id}".`);
      }
      tasks[task.id] = task;
    }
    validateGraph(tasks);
    run.tasks = tasks;
    run.planRevision += 1;
    run.status = "ready";
    writeRun(cwd, run);
    appendEvent(cwd, id, {
      type: "run.plan_replaced",
      revision: run.planRevision,
      tasks: Object.values(tasks).map((task) => ({
        id: task.id,
        kind: task.kind,
        dependsOn: task.dependsOn
      }))
    });
    return run;
  });
}

export function readyTasks(run) {
  const completed = new Set(
    Object.values(run.tasks)
      .filter((task) => task.status === "completed")
      .map((task) => task.id)
  );
  return Object.values(run.tasks)
    .filter(
      (task) =>
        task.status === "pending" &&
        task.dependsOn.every((dependency) => completed.has(dependency))
    )
    .sort((left, right) => left.id.localeCompare(right.id));
}

export function addCheckpoint(
  cwd,
  runId,
  { summary, decisions = [], risks = [], next = [] }
) {
  const id = assertId(runId, "run");
  const text = String(summary ?? "").trim();
  if (!text) {
    throw new Error("A checkpoint summary is required.");
  }
  const filePath = runFile(cwd, id);
  return withFileLock(filePath, () => {
    const run = loadRun(cwd, id);
    const checkpoint = {
      at: nowIso(),
      summary: text,
      decisions: stringList(decisions, "checkpoint decisions"),
      risks: stringList(risks, "checkpoint risks"),
      next: stringList(next, "checkpoint next actions")
    };
    run.checkpoints.push(checkpoint);
    writeRun(cwd, run);
    appendEvent(cwd, id, { type: "run.checkpoint_added", checkpoint });
    return checkpoint;
  });
}

function renderList(items) {
  return items.length ? items.map((item) => `- ${item}`).join("\n") : "- none";
}

export function renderSupervisorBriefing(cwd, run, lane) {
  const ledger = ledgerForBriefing(cwd);
  const latest = run.checkpoints.at(-1);
  const tasks = Object.values(run.tasks)
    .map((task) => {
      const dependencies = task.dependsOn.length ? task.dependsOn.join(", ") : "none";
      return `### ${task.id} — ${task.title}

- status: ${task.status}
- kind: ${task.kind}
- depends on: ${dependencies}
- scope: ${task.scope.length ? task.scope.join(", ") : "read-only / no write scope"}
- objective: ${task.objective}
- acceptance:
${renderList(task.acceptance)}`;
    })
    .join("\n\n");
  const ledgerText = ledger.populated.length
    ? ledger.populated
        .map(([section, entries]) => `### ${section}\n${renderList(entries)}`)
        .join("\n\n")
    : "No durable project facts have been recorded.";

  return `# Supervisor briefing — ${run.id}

## Authority

You are the Claude supervisor. You own planning, assignment, monitoring, review, replanning, integration, and the final user report. Codex workers execute bounded tasks; they do not redefine the goal or widen scope.

## Goal

${run.objective}

## Run state

- status: ${run.status}
- lane: ${run.lane}
- worker model: ${run.workerPolicy.model}
- worker reasoning: ${run.workerPolicy.reasoningEffort}
- maximum concurrent workers: ${run.workerPolicy.maxWorkers}
- plan revision: ${run.planRevision}

## Lane constraints

${renderList(lane.constraints ?? [])}

## Definition of done

${lane.done || "No lane-level definition of done was recorded."}

## Task graph

${tasks || "No plan has been approved yet."}

## Latest checkpoint

${latest ? `${latest.summary}

Decisions:
${renderList(latest.decisions)}

Risks:
${renderList(latest.risks)}

Next:
${renderList(latest.next)}` : "No checkpoint has been recorded yet."}

## Durable project memory

${ledgerText}
`;
}
