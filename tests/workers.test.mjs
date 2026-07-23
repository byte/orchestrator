import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  claimTask,
  createRun,
  loadRun,
  recordIntegration,
  recordTaskResult,
  replacePlan
} from "../plugins/orchestrator/scripts/lib/runs.mjs";
import {
  launchTaskWorker,
  pollRunWorkers,
  stopTaskWorker
} from "../plugins/orchestrator/scripts/lib/workers.mjs";
import {
  cleanupTaskWorktree,
  createTaskWorktree,
  inspectTaskWorktree,
  integrateTaskWorktree
} from "../plugins/orchestrator/scripts/lib/worktrees.mjs";
import { cleanup, git, makeRepo, runCli, write } from "./helpers.mjs";

const repos = [];
const fixture = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "fake-codex.mjs"
);
const slowFixture = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "fake-codex-slow.mjs"
);

function repo() {
  const root = makeRepo();
  repos.push(root);
  runCli(root, ["init"]);
  runCli(root, ["lane", "add", "api", "--scope", "src/**"]);
  return root;
}

after(() => {
  for (const root of repos) {
    cleanup(root);
  }
});

function plan(root, id) {
  createRun(root, { id, lane: "api", objective: "Build safely" });
  replacePlan(root, id, [
    {
      id: "build",
      title: "Build",
      objective: "Add the module",
      scope: ["src/**"],
      acceptance: ["tests pass"]
    }
  ]);
}

test("write worktrees require committed, clean, declared, in-scope changes before integration", () => {
  const root = repo();
  plan(root, "run-worktree");
  const dispatch = claimTask(root, "run-worktree", "build", { constraints: [] });
  let run = loadRun(root, "run-worktree");
  let task = run.tasks.build;
  let attempt = task.attempts.at(-1);
  const worktree = createTaskWorktree(root, run, task, attempt);
  attempt.worktree = worktree;
  write(worktree.path, "src/module.js", "export const value = 1;\n");
  git(worktree.path, ["add", "src/module.js"]);
  git(worktree.path, ["commit", "--quiet", "-m", "Add module"]);

  recordTaskResult(root, "run-worktree", "build", {
    attemptId: dispatch.attemptId,
    resultText: JSON.stringify({
      summary: "Added the module.",
      files_touched: ["src/module.js"],
      tests: [{ command: "node --test", outcome: "passed" }],
      decisions: [],
      assumptions: [],
      blockers: [],
      confidence: "high"
    })
  });
  run = loadRun(root, "run-worktree");
  task = run.tasks.build;
  task.attempts.at(-1).worktree = worktree;
  const inspection = inspectTaskWorktree(task, task.attempts.at(-1));
  assert.equal(inspection.ready, true);
  assert.deepEqual(inspection.files, ["src/module.js"]);

  const integrated = integrateTaskWorktree(root, run, task, task.attempts.at(-1));
  const result = recordIntegration(root, "run-worktree", "build", {
    evidence: ["worker tests passed", "scope inspection passed"],
    ...integrated
  });
  assert.equal(result.task.status, "completed");
  assert.equal(fs.readFileSync(path.join(root, "src/module.js"), "utf8"), "export const value = 1;\n");
  assert.equal(cleanupTaskWorktree(root, task.attempts.at(-1)), true);
});

test("worktree inspection rejects out-of-scope files", () => {
  const root = repo();
  plan(root, "run-scope");
  const dispatch = claimTask(root, "run-scope", "build", { constraints: [] });
  const run = loadRun(root, "run-scope");
  const task = run.tasks.build;
  const attempt = task.attempts.at(-1);
  attempt.worktree = createTaskWorktree(root, run, task, attempt);
  write(attempt.worktree.path, "docs/oops.md", "outside\n");
  git(attempt.worktree.path, ["add", "docs/oops.md"]);
  git(attempt.worktree.path, ["commit", "--quiet", "-m", "Add outside file"]);
  recordTaskResult(root, "run-scope", "build", {
    attemptId: dispatch.attemptId,
    resultText: JSON.stringify({
      summary: "Changed the wrong file.",
      files_touched: ["docs/oops.md"],
      tests: [],
      decisions: [],
      assumptions: [],
      blockers: [],
      confidence: "high"
    })
  });
  task.result = loadRun(root, "run-scope").tasks.build.result;
  const inspection = inspectTaskWorktree(task, attempt);
  assert.equal(inspection.ready, false);
  assert.deepEqual(inspection.outOfScope, ["docs/oops.md"]);
});

test("worker launch rejects supervisor branch drift outside the run", () => {
  const root = repo();
  plan(root, "run-drift");
  write(root, "src/manual.js", "export const manual = true;\n");
  git(root, ["add", "src/manual.js"]);
  git(root, ["commit", "--quiet", "-m", "Add manual change"]);

  assert.throws(
    () => launchTaskWorker(root, "run-drift", "build", { constraints: [] }, {
      codexCommand: [process.execPath, fixture]
    }),
    /advanced outside run/
  );
  assert.equal(loadRun(root, "run-drift").tasks.build.status, "failed");
});

test("detached workers persist status, thread id, and structured results", async () => {
  const root = repo();
  plan(root, "run-worker");
  const launched = launchTaskWorker(root, "run-worker", "build", { constraints: [] }, {
    codexCommand: [process.execPath, fixture]
  });
  assert.equal(launched.model, "gpt-5.6-sol");
  assert.ok(launched.runner.pid > 0);
  assert.ok(fs.existsSync(launched.worktree.path));

  let update;
  for (let index = 0; index < 50; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    update = pollRunWorkers(root, "run-worker")[0];
    if (update && !["running", "dispatching"].includes(update.status)) {
      break;
    }
  }
  assert.equal(update.status, "reported");
  assert.equal(update.threadId, "thread-fake");
  const task = loadRun(root, "run-worker").tasks.build;
  assert.equal(task.result.structured.summary, "Fake worker completed.");
  assert.equal(task.attempts.at(-1).threadId, "thread-fake");
});

test("detached workers can be stopped without losing their durable handle", async () => {
  const root = repo();
  plan(root, "run-stop");
  launchTaskWorker(root, "run-stop", "build", { constraints: [] }, {
    codexCommand: [process.execPath, slowFixture]
  });
  let attempt;
  for (let index = 0; index < 50; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    attempt = loadRun(root, "run-stop").tasks.build.attempts.at(-1);
    if (fs.existsSync(attempt.runner.statusFile)) {
      break;
    }
  }
  assert.equal(stopTaskWorker(attempt), true);
  const status = JSON.parse(fs.readFileSync(attempt.runner.statusFile, "utf8"));
  assert.equal(status.status, "cancelled");
  assert.equal(status.pid, attempt.runner.pid);
});
