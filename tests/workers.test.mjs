import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  claimTask,
  createRun,
  finalizeRun,
  loadRun,
  recordIntegration,
  recordTaskResult,
  replacePlan,
  verifyTask
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
const writeFixture = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "fake-codex-write.mjs"
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
  assert.equal(task.attempts.at(-1).runner.status, "completed");
  assert.ok(task.attempts.at(-1).runner.childPid > 0);
});

test("the pool runs independent ready tasks in separate detached worktrees", async () => {
  const root = repo();
  createRun(root, {
    id: "run-pool-e2e",
    lane: "api",
    objective: "Inspect in parallel",
    maxWorkers: 2
  });
  replacePlan(root, "run-pool-e2e", [
    { id: "inspect-a", title: "Inspect A", objective: "Inspect A", kind: "read" },
    { id: "inspect-b", title: "Inspect B", objective: "Inspect B", kind: "read" }
  ]);
  const first = launchTaskWorker(root, "run-pool-e2e", "inspect-a", { constraints: [] }, {
    codexCommand: [process.execPath, fixture]
  });
  const second = launchTaskWorker(root, "run-pool-e2e", "inspect-b", { constraints: [] }, {
    codexCommand: [process.execPath, fixture]
  });
  assert.notEqual(first.runner.pid, second.runner.pid);
  assert.notEqual(first.worktree.path, second.worktree.path);

  for (let index = 0; index < 100; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    pollRunWorkers(root, "run-pool-e2e");
    const statuses = Object.values(loadRun(root, "run-pool-e2e").tasks)
      .map((task) => task.status);
    if (statuses.every((status) => status === "reported")) {
      break;
    }
  }
  let run = loadRun(root, "run-pool-e2e");
  assert.deepEqual(
    Object.values(run.tasks).map((task) => task.status),
    ["reported", "reported"]
  );
  for (const task of Object.values(run.tasks)) {
    assert.equal(task.result.structured.summary, "Fake worker completed.");
    verifyTask(root, "run-pool-e2e", task.id, {
      verdict: "pass",
      evidence: [`${task.id} evidence reviewed`]
    });
  }
  run = loadRun(root, "run-pool-e2e");
  assert.equal(run.status, "finalizing");
  for (const task of Object.values(run.tasks)) {
    assert.equal(cleanupTaskWorktree(root, task.attempts.at(-1)), true);
  }
});

test("a detached write worker completes the full launch, inspect, integrate, finalize, and cleanup lifecycle", async () => {
  const root = repo();
  plan(root, "run-e2e");
  const launched = launchTaskWorker(root, "run-e2e", "build", { constraints: [] }, {
    codexCommand: [process.execPath, writeFixture]
  });

  let update;
  for (let index = 0; index < 100; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    update = pollRunWorkers(root, "run-e2e")[0];
    if (update && !["running", "dispatching"].includes(update.status)) {
      break;
    }
  }
  assert.equal(update.status, "reported");
  assert.equal(update.threadId, "thread-fake-write");

  let run = loadRun(root, "run-e2e");
  let task = run.tasks.build;
  const attempt = task.attempts.at(-1);
  const inspection = inspectTaskWorktree(task, attempt);
  assert.equal(inspection.ready, true);
  assert.deepEqual(inspection.files, ["src/generated.js"]);

  const integrated = integrateTaskWorktree(root, run, task, attempt);
  const recorded = recordIntegration(root, "run-e2e", "build", {
    evidence: ["worker check passed", "scope and declaration inspection passed"],
    ...integrated
  });
  assert.equal(recorded.runStatus, "finalizing");
  assert.equal(
    fs.readFileSync(path.join(root, "src", "generated.js"), "utf8"),
    "export const generated = true;\n"
  );

  run = finalizeRun(root, "run-e2e", {
    verdict: "pass",
    summary: "The write-worker lifecycle completed.",
    evidence: ["generated module present after integration"]
  });
  assert.equal(run.status, "completed");
  assert.equal(cleanupTaskWorktree(root, attempt), true);
  assert.equal(fs.existsSync(launched.worktree.path), false);
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
