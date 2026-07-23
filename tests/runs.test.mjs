import assert from "node:assert/strict";
import fs from "node:fs";
import { after, test } from "node:test";

import {
  DEFAULT_WORKER_MODEL,
  addCheckpoint,
  createRun,
  eventsFile,
  loadRun,
  readyTasks,
  renderSupervisorBriefing,
  replacePlan
} from "../plugins/orchestrator/scripts/lib/runs.mjs";
import { cleanup, makeRepo, runCli } from "./helpers.mjs";

const repos = [];

function repo() {
  const root = makeRepo();
  repos.push(root);
  runCli(root, ["init"]);
  return root;
}

after(() => {
  for (const root of repos) {
    cleanup(root);
  }
});

test("new runs pin GPT-5.6 Sol and start in planning", () => {
  const root = repo();
  const run = createRun(root, {
    id: "run-one",
    lane: "api",
    objective: "Ship pagination"
  });
  assert.equal(run.status, "planning");
  assert.equal(run.workerPolicy.model, DEFAULT_WORKER_MODEL);
  assert.equal(run.workerPolicy.model, "gpt-5.6-sol");
  assert.equal(run.workerPolicy.maxWorkers, 3);
  assert.deepEqual(run.tasks, {});
});

test("plans validate dependencies and expose only unblocked tasks", () => {
  const root = repo();
  createRun(root, { id: "run-dag", lane: "api", objective: "Build the feature" });
  const run = replacePlan(
    root,
    "run-dag",
    [
      {
        id: "implement",
        title: "Implement",
        objective: "Write the module",
        scope: ["src/**"],
        acceptance: ["unit tests pass"]
      },
      {
        id: "verify",
        title: "Verify",
        objective: "Review and test the module",
        kind: "verify",
        dependsOn: ["implement"],
        acceptance: ["report evidence"]
      }
    ],
    { defaultScope: ["src/**"] }
  );
  assert.equal(run.status, "ready");
  assert.equal(run.planRevision, 1);
  assert.deepEqual(readyTasks(run).map((task) => task.id), ["implement"]);
});

test("plans reject missing dependencies and cycles", () => {
  const root = repo();
  createRun(root, { id: "run-invalid", lane: "api", objective: "Build it" });
  assert.throws(
    () =>
      replacePlan(root, "run-invalid", [
        {
          id: "a",
          title: "A",
          objective: "A",
          scope: ["src/**"],
          dependsOn: ["missing"]
        }
      ]),
    /depends on unknown task/
  );
  assert.throws(
    () =>
      replacePlan(root, "run-invalid", [
        {
          id: "a",
          title: "A",
          objective: "A",
          scope: ["src/**"],
          dependsOn: ["b"]
        },
        {
          id: "b",
          title: "B",
          objective: "B",
          scope: ["src/**"],
          dependsOn: ["a"]
        }
      ]),
    /dependency cycle/
  );
});

test("checkpoints and events preserve supervisory state", () => {
  const root = repo();
  createRun(root, { id: "run-memory", lane: "api", objective: "Remember the work" });
  const checkpoint = addCheckpoint(root, "run-memory", {
    summary: "The plan is approved.",
    decisions: ["Use cursor pagination"],
    risks: ["Index migration"],
    next: ["Dispatch implementation"]
  });
  assert.equal(checkpoint.decisions[0], "Use cursor pagination");
  assert.equal(loadRun(root, "run-memory").checkpoints.length, 1);

  const events = fs
    .readFileSync(eventsFile(root, "run-memory"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(events.map((event) => event.type), [
    "run.created",
    "run.checkpoint_added"
  ]);
});

test("the supervisor briefing reconstructs authority, graph, checkpoint, and ledger", () => {
  const root = repo();
  runCli(root, ["ledger", "add", "decisions", "Public IDs remain opaque."]);
  createRun(root, { id: "run-brief", lane: "api", objective: "Add pagination" });
  const run = replacePlan(root, "run-brief", [
    {
      id: "implementation",
      title: "Implement pagination",
      objective: "Add cursor pagination",
      scope: ["src/api/**"],
      acceptance: ["tests pass"]
    }
  ]);
  addCheckpoint(root, "run-brief", {
    summary: "Planning complete.",
    next: ["Dispatch implementation"]
  });
  const briefing = renderSupervisorBriefing(root, loadRun(root, run.id), {
    constraints: ["No new dependencies"],
    done: "All tests pass."
  });
  assert.match(briefing, /You are the Claude supervisor/);
  assert.match(briefing, /gpt-5\.6-sol/);
  assert.match(briefing, /implementation — Implement pagination/);
  assert.match(briefing, /Planning complete/);
  assert.match(briefing, /Public IDs remain opaque/);
});
