import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  claimTask,
  createRun,
  eventsFile,
  finalizeRun,
  loadRun,
  recordIntegration,
  recordTaskResult,
  renderSupervisorBriefing,
  replacePlan,
  retryTask,
  runFile,
  verifyTask
} from "../plugins/orchestrator/scripts/lib/runs.mjs";
import {
  WORKER_RESULT_SCHEMA,
  cancelWorkers,
  launchTaskWorker,
  modelUnavailableError,
  pollRunWorkers,
  stopTaskWorker
} from "../plugins/orchestrator/scripts/lib/workers.mjs";
import {
  cleanupTaskWorktree,
  createTaskWorktree,
  inspectTaskWorktree,
  integrateTaskWorktree
} from "../plugins/orchestrator/scripts/lib/worktrees.mjs";
import { changedFiles, worktreeGitEnv } from "../plugins/orchestrator/scripts/lib/git.mjs";
import { checkpointPlan, cleanup, git, makeRepo, runCli, write } from "./helpers.mjs";

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
const noResultFixture = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "fake-codex-no-result.mjs"
);
const failedFixture = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "fake-codex-fail.mjs"
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

function plan(root, id, { workerModel, taskModel, taskEffort } = {}) {
  const autoRouted = Boolean(taskModel || taskEffort);
  createRun(root, {
    id,
    lane: "api",
    objective: "Build safely",
    workerModel: autoRouted ? undefined : workerModel ?? "sol",
    reasoningEffort: autoRouted ? undefined : "high"
  });
  replacePlan(root, id, [
    {
      id: "build",
      title: "Build",
      objective: "Add the module",
      scope: ["src/**"],
      acceptance: ["tests pass"],
      model: taskModel,
      effort: taskEffort,
      routingReason: autoRouted
        ? "The supervisor selected this route for the bounded task."
        : undefined
    }
  ]);
}

test("write worktrees require committed, clean, declared, in-scope changes before integration", () => {
  const root = repo();
  plan(root, "run-worktree");
  checkpointPlan(root, "run-worktree");
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
  assert.equal(result.task.attempts.at(-1).outcome.terminalOutcome, "accepted");
  assert.equal(fs.readFileSync(path.join(root, "src/module.js"), "utf8"), "export const value = 1;\n");
  assert.equal(cleanupTaskWorktree(root, task.attempts.at(-1)), true);
});

test("a conflicted integration rolls back without running a worker-changed fsmonitor", () => {
  const root = repo();
  // The repository runs a tracked script as its fsmonitor.
  write(root, "src/mon.sh", "#!/bin/sh\nexit 1\n");
  fs.chmodSync(path.join(root, "src/mon.sh"), 0o755);
  write(root, "src/same.js", "base\n");
  git(root, ["add", "-A"]);
  git(root, ["commit", "--quiet", "-m", "base"]);
  plan(root, "run-conflict");
  checkpointPlan(root, "run-conflict");
  const dispatch = claimTask(root, "run-conflict", "build", { constraints: [] });
  let run = loadRun(root, "run-conflict");
  const worktree = createTaskWorktree(root, run, run.tasks.build, run.tasks.build.attempts.at(-1));
  const marker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "orch-hook-")), "ran");
  repos.push(path.dirname(marker));
  // Worker commit 1 changes the fsmonitor script; commit 2 will conflict.
  write(worktree.path, "src/mon.sh", `#!/bin/sh\necho ran >> ${JSON.stringify(marker)}\nexit 1\n`);
  git(worktree.path, ["commit", "--quiet", "-am", "monitor"]);
  write(worktree.path, "src/same.js", "worker\n");
  git(worktree.path, ["commit", "--quiet", "-am", "same"]);
  recordTaskResult(root, "run-conflict", "build", {
    attemptId: dispatch.attemptId,
    resultText: JSON.stringify({
      summary: "Changed both.",
      files_touched: ["src/mon.sh", "src/same.js"],
      tests: [],
      decisions: [],
      assumptions: [],
      blockers: [],
      confidence: "high"
    })
  });
  // Another integration moved the supervisor branch meanwhile.
  write(root, "src/same.js", "supervisor\n");
  git(root, ["commit", "--quiet", "-am", "other task"]);
  git(root, ["config", "core.fsmonitor", path.join(root, "src/mon.sh")]);
  run = loadRun(root, "run-conflict");
  run.repository.integrationHead = git(root, ["rev-parse", "HEAD"]).trim();
  const task = run.tasks.build;
  task.attempts.at(-1).worktree = worktree;
  assert.throws(() => integrateTaskWorktree(root, run, task, task.attempts.at(-1)), /integration|cherry-pick|conflict/i);
  assert.equal(fs.existsSync(marker) ? fs.readFileSync(marker, "utf8") : "", "", "the worker's fsmonitor did not run");
  assert.equal(fs.readFileSync(path.join(root, "src/mon.sh"), "utf8"), "#!/bin/sh\nexit 1\n", "rolled back");
  git(root, ["config", "--unset", "core.fsmonitor"]);
});

test("supervisor git after an integration runs no hook or fsmonitor the worker changed", () => {
  const root = repo();
  write(root, "src/mon.sh", "#!/bin/sh\nexit 1\n");
  write(root, "src/hooks/post-checkout", "#!/bin/sh\nexit 0\n");
  fs.chmodSync(path.join(root, "src/mon.sh"), 0o755);
  fs.chmodSync(path.join(root, "src/hooks/post-checkout"), 0o755);
  git(root, ["add", "-A"]);
  git(root, ["commit", "--quiet", "-m", "base"]);
  plan(root, "run-supervisor-git");
  checkpointPlan(root, "run-supervisor-git");
  const dispatch = claimTask(root, "run-supervisor-git", "build", { constraints: [] });
  let run = loadRun(root, "run-supervisor-git");
  const worktree = createTaskWorktree(root, run, run.tasks.build, run.tasks.build.attempts.at(-1));
  const marker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "orch-hook-")), "ran");
  repos.push(path.dirname(marker));
  const planted = `#!/bin/sh\necho ran >> ${JSON.stringify(marker)}\nexit 1\n`;
  write(worktree.path, "src/mon.sh", planted);
  write(worktree.path, "src/hooks/post-checkout", planted);
  git(worktree.path, ["commit", "--quiet", "-am", "monitor and hook"]);
  recordTaskResult(root, "run-supervisor-git", "build", {
    attemptId: dispatch.attemptId,
    resultText: JSON.stringify({
      summary: "Changed both.",
      files_touched: ["src/hooks/post-checkout", "src/mon.sh"],
      tests: [],
      decisions: [],
      assumptions: [],
      blockers: [],
      confidence: "high"
    })
  });
  git(root, ["config", "core.fsmonitor", path.join(root, "src/mon.sh")]);
  git(root, ["config", "core.hooksPath", "src/hooks"]);
  try {
    run = loadRun(root, "run-supervisor-git");
    const task = run.tasks.build;
    task.attempts.at(-1).worktree = worktree;
    run.repository.integrationHead = integrateTaskWorktree(root, run, task, task.attempts.at(-1)).integrationHead;
    assert.equal(fs.readFileSync(path.join(root, "src/mon.sh"), "utf8"), planted, "integrated");
    // The supervisor's next status check and the next worker's worktree.
    assert.deepEqual(changedFiles(root), []);
    createTaskWorktree(root, run, task, { ...task.attempts.at(-1), id: "attempt-next" });
    assert.equal(fs.existsSync(marker) ? fs.readFileSync(marker, "utf8") : "", "", "no worker-written script ran");
  } finally {
    execFileSync("git", ["config", "--unset", "core.fsmonitor"], { cwd: root });
    execFileSync("git", ["config", "--unset", "core.hooksPath"], { cwd: root });
  }
});

test("a worker's working-tree-encoded file integrates with the bytes it wrote", () => {
  const root = repo();
  write(root, ".gitattributes", "src/*.txt working-tree-encoding=UTF-16LE\n");
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src/value.txt"), Buffer.from("old\n", "utf16le"));
  git(root, ["add", "-A"]);
  git(root, ["commit", "--quiet", "-m", "encoded"]);
  plan(root, "run-encoding");
  checkpointPlan(root, "run-encoding");
  const dispatch = claimTask(root, "run-encoding", "build", { constraints: [] });
  let run = loadRun(root, "run-encoding");
  const worktree = createTaskWorktree(root, run, run.tasks.build, run.tasks.build.attempts.at(-1));
  const written = Buffer.from("new\n", "utf16le");
  fs.writeFileSync(path.join(worktree.path, "src/value.txt"), written);
  // Committed the way the wrapper commits it.
  const env = worktreeGitEnv(worktree.path, worktree.gitDir);
  execFileSync("git", ["add", "-A"], { cwd: worktree.path, env });
  execFileSync("git", ["commit", "--quiet", "--no-verify", "-m", "value"], { cwd: worktree.path, env });
  recordTaskResult(root, "run-encoding", "build", {
    attemptId: dispatch.attemptId,
    resultText: JSON.stringify({
      summary: "Changed the value.",
      files_touched: ["src/value.txt"],
      tests: [],
      decisions: [],
      assumptions: [],
      blockers: [],
      confidence: "high"
    })
  });
  run = loadRun(root, "run-encoding");
  const task = run.tasks.build;
  task.attempts.at(-1).worktree = worktree;
  integrateTaskWorktree(root, run, task, task.attempts.at(-1));
  assert.deepEqual(fs.readFileSync(path.join(root, "src/value.txt")), written);
});

test("an edit to a file another task moved out of scope conflicts instead of following the move", () => {
  const root = repo();
  write(root, "src/a.txt", "one\ntwo\nthree\n");
  git(root, ["add", "-A"]);
  git(root, ["commit", "--quiet", "-m", "base"]);
  plan(root, "run-rename");
  checkpointPlan(root, "run-rename");
  const dispatch = claimTask(root, "run-rename", "build", { constraints: [] });
  let run = loadRun(root, "run-rename");
  const worktree = createTaskWorktree(root, run, run.tasks.build, run.tasks.build.attempts.at(-1));
  write(worktree.path, "src/a.txt", "one\nTWO\nthree\n");
  git(worktree.path, ["commit", "--quiet", "-am", "edit"]);
  recordTaskResult(root, "run-rename", "build", {
    attemptId: dispatch.attemptId,
    resultText: JSON.stringify({
      summary: "Edited a.",
      files_touched: ["src/a.txt"],
      tests: [],
      decisions: [],
      assumptions: [],
      blockers: [],
      confidence: "high"
    })
  });
  // Another task's integration moved the file outside this task's scope.
  fs.mkdirSync(path.join(root, "lib"), { recursive: true });
  git(root, ["mv", "src/a.txt", "lib/a.txt"]);
  git(root, ["commit", "--quiet", "-m", "move"]);
  run = loadRun(root, "run-rename");
  run.repository.integrationHead = git(root, ["rev-parse", "HEAD"]).trim();
  const task = run.tasks.build;
  task.attempts.at(-1).worktree = worktree;
  assert.equal(inspectTaskWorktree(task, task.attempts.at(-1)).ready, true);
  assert.throws(() => integrateTaskWorktree(root, run, task, task.attempts.at(-1)), /conflict/i);
  assert.equal(fs.readFileSync(path.join(root, "lib/a.txt"), "utf8"), "one\ntwo\nthree\n", "lib/a.txt untouched");
  assert.deepEqual(changedFiles(root), [], "rolled back");
});

function reportFiles(root, runId, attemptId, files) {
  recordTaskResult(root, runId, "build", {
    attemptId,
    resultText: JSON.stringify({
      summary: "Done.",
      files_touched: files,
      tests: [],
      decisions: [],
      assumptions: [],
      blockers: [],
      confidence: "high"
    })
  });
}

test("integration runs no configured merge driver a worker could have changed", () => {
  const root = repo();
  write(root, "src/merge.sh", "#!/bin/sh\nexit 1\n");
  write(root, ".gitattributes", "src/*.dat merge=local\n");
  write(root, "src/x.dat", "a\nb\nc\n");
  git(root, ["add", "-A"]);
  git(root, ["commit", "--quiet", "-m", "base"]);
  git(root, ["config", "merge.local.driver", "sh src/merge.sh %O %A %B"]);
  plan(root, "run-merge-driver");
  checkpointPlan(root, "run-merge-driver");
  const dispatch = claimTask(root, "run-merge-driver", "build", { constraints: [] });
  let run = loadRun(root, "run-merge-driver");
  const worktree = createTaskWorktree(root, run, run.tasks.build, run.tasks.build.attempts.at(-1));
  const marker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "orch-hook-")), "ran");
  repos.push(path.dirname(marker));
  write(worktree.path, "src/merge.sh", `#!/bin/sh\necho ran >> ${JSON.stringify(marker)}\nexit 0\n`);
  git(worktree.path, ["commit", "--quiet", "-am", "driver"]);
  write(worktree.path, "src/x.dat", "A\nb\nc\n");
  git(worktree.path, ["commit", "--quiet", "-am", "data"]);
  reportFiles(root, "run-merge-driver", dispatch.attemptId, ["src/merge.sh", "src/x.dat"]);
  // Another task changed the same file, so the cherry-pick must merge it.
  write(root, "src/x.dat", "a\nb\nC\n");
  git(root, ["commit", "--quiet", "-am", "other task"]);
  run = loadRun(root, "run-merge-driver");
  run.repository.integrationHead = git(root, ["rev-parse", "HEAD"]).trim();
  const task = run.tasks.build;
  task.attempts.at(-1).worktree = worktree;
  assert.throws(() => integrateTaskWorktree(root, run, task, task.attempts.at(-1)), /conflict/i);
  assert.equal(fs.existsSync(marker) ? fs.readFileSync(marker, "utf8") : "", "", "the worker's merge driver did not run");
  assert.equal(fs.readFileSync(path.join(root, "src/merge.sh"), "utf8"), "#!/bin/sh\nexit 1\n", "rolled back");
});

test("integration refuses to overwrite an ignored file in the main checkout", () => {
  const root = repo();
  write(root, "src/.gitignore", "private.txt\n");
  git(root, ["add", "-A"]);
  git(root, ["commit", "--quiet", "-m", "ignore"]);
  write(root, "src/private.txt", "local secret\n");
  plan(root, "run-ignored");
  checkpointPlan(root, "run-ignored");
  const dispatch = claimTask(root, "run-ignored", "build", { constraints: [] });
  let run = loadRun(root, "run-ignored");
  const worktree = createTaskWorktree(root, run, run.tasks.build, run.tasks.build.attempts.at(-1));
  write(worktree.path, "src/.gitignore", "");
  write(worktree.path, "src/private.txt", "worker content\n");
  git(worktree.path, ["add", "-A"]);
  git(worktree.path, ["commit", "--quiet", "-m", "take it"]);
  reportFiles(root, "run-ignored", dispatch.attemptId, ["src/.gitignore", "src/private.txt"]);
  run = loadRun(root, "run-ignored");
  const task = run.tasks.build;
  task.attempts.at(-1).worktree = worktree;
  assert.throws(() => integrateTaskWorktree(root, run, task, task.attempts.at(-1)), /overwrite ignored files.*src\/private\.txt/);
  assert.equal(fs.readFileSync(path.join(root, "src/private.txt"), "utf8"), "local secret\n");
});

test("a nested repository in a worker's worktree counts as changed, so cleanup keeps it", () => {
  const root = repo();
  plan(root, "run-nested");
  checkpointPlan(root, "run-nested");
  claimTask(root, "run-nested", "build", { constraints: [] });
  const run = loadRun(root, "run-nested");
  const attempt = run.tasks.build.attempts.at(-1);
  const worktree = createTaskWorktree(root, run, run.tasks.build, attempt);
  const nested = path.join(worktree.path, "src", "vendor");
  fs.mkdirSync(nested, { recursive: true });
  git(nested, ["init", "--quiet"]);
  write(nested, "value.txt", "one\n");
  git(nested, ["add", "-A"]);
  git(nested, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", "v"]);
  git(worktree.path, ["add", "-A"]);
  git(worktree.path, ["commit", "--quiet", "-m", "vendor"]);
  write(nested, "value.txt", "uncommitted work\n");
  assert.deepEqual(changedFiles(worktree.path, { gitDir: worktree.gitDir }), ["src/vendor"]);
  assert.throws(() => cleanupTaskWorktree(root, { ...attempt, worktree }), /dirty worktree/);
  assert.equal(fs.readFileSync(path.join(nested, "value.txt"), "utf8"), "uncommitted work\n");
});

test("cleanup refuses a worker worktree with an uncommitted edit to a tracked .orchestrator file", () => {
  const root = repo();
  write(root, ".orchestrator/notes.md", "tracked\n");
  git(root, ["add", "-f", ".orchestrator/notes.md"]);
  git(root, ["commit", "--quiet", "-m", "notes"]);
  plan(root, "run-cleanup-ledger");
  checkpointPlan(root, "run-cleanup-ledger");
  claimTask(root, "run-cleanup-ledger", "build", { constraints: [] });
  const run = loadRun(root, "run-cleanup-ledger");
  const worktree = createTaskWorktree(root, run, run.tasks.build, run.tasks.build.attempts.at(-1));
  write(worktree.path, ".orchestrator/notes.md", "edited by the worker\n");
  assert.throws(() => cleanupTaskWorktree(root, { worktree }), /Refusing to remove dirty worktree/);
  assert.equal(fs.readFileSync(path.join(worktree.path, ".orchestrator/notes.md"), "utf8"), "edited by the worker\n");
});

test("worktree inspection rejects out-of-scope files", () => {
  const root = repo();
  plan(root, "run-scope");
  checkpointPlan(root, "run-scope");
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
  checkpointPlan(root, "run-drift");
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
  assert.equal(
    loadRun(root, "run-drift").tasks.build.attempts.at(-1).outcome.terminalOutcome,
    "execution_failed"
  );
});

test("detached workers persist status, thread id, and structured results", async () => {
  const root = repo();
  plan(root, "run-worker", { taskModel: "terra", taskEffort: "medium" });
  checkpointPlan(root, "run-worker");
  const launched = launchTaskWorker(root, "run-worker", "build", { constraints: [] }, {
    codexCommand: [process.execPath, fixture]
  });
  assert.equal(launched.model, "gpt-6.1-terra");
  assert.equal(launched.reasoningEffort, "medium");
  assert.ok(launched.runner.pid > 0);
  assert.ok(fs.existsSync(launched.worktree.path));
  const spec = JSON.parse(fs.readFileSync(launched.runner.specFile, "utf8"));
  assert.equal(spec.model, "gpt-6.1-terra");
  assert.equal(spec.reasoningEffort, "medium");

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

test("worker collection distinguishes missing contracts from execution failures", async () => {
  const root = repo();
  plan(root, "run-no-result");
  checkpointPlan(root, "run-no-result");
  launchTaskWorker(root, "run-no-result", "build", { constraints: [] }, {
    codexCommand: [process.execPath, noResultFixture]
  });
  let noResult;
  for (let index = 0; index < 100; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 30));
    noResult = pollRunWorkers(root, "run-no-result")[0];
    if (noResult && !["running", "dispatching"].includes(noResult.status)) {
      break;
    }
  }
  assert.equal(noResult.status, "failed");
  assert.equal(
    loadRun(root, "run-no-result").tasks.build.attempts.at(-1).outcome.terminalOutcome,
    "contract_failed"
  );

  plan(root, "run-process-fail");
  checkpointPlan(root, "run-process-fail");
  launchTaskWorker(root, "run-process-fail", "build", { constraints: [] }, {
    codexCommand: [process.execPath, failedFixture]
  });
  let processFailure;
  for (let index = 0; index < 100; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 30));
    processFailure = pollRunWorkers(root, "run-process-fail")[0];
    if (processFailure && !["running", "dispatching"].includes(processFailure.status)) {
      break;
    }
  }
  assert.equal(processFailure.status, "failed");
  assert.equal(
    loadRun(root, "run-process-fail").tasks.build.attempts.at(-1).outcome.terminalOutcome,
    "execution_failed"
  );
});

test("the pool runs independent ready tasks in separate detached worktrees", async () => {
  const root = repo();
  createRun(root, {
    id: "run-pool-e2e",
    lane: "api",
    objective: "Inspect in parallel",
    maxWorkers: 2,
    workerModel: "sol",
    reasoningEffort: "high"
  });
  replacePlan(root, "run-pool-e2e", [
    { id: "inspect-a", title: "Inspect A", objective: "Inspect A", kind: "read" },
    { id: "inspect-b", title: "Inspect B", objective: "Inspect B", kind: "read" }
  ]);
  checkpointPlan(root, "run-pool-e2e");
  const first = launchTaskWorker(root, "run-pool-e2e", "inspect-a", { constraints: [] }, {
    codexCommand: [process.execPath, fixture]
  });
  checkpointPlan(root, "run-pool-e2e");
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

/** Wait for a runner's status file to reach a terminal state. */
async function runnerDone(statusFile) {
  for (let index = 0; index < 200; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 40));
    try {
      const status = JSON.parse(fs.readFileSync(statusFile, "utf8"));
      if (["completed", "failed", "cancelled"].includes(status.status)) {
        return status;
      }
    } catch {
      // Not written yet.
    }
  }
  throw new Error("runner did not finish");
}

test("the wrapper commits a locked-down write worker's changes, with no hook from the worktree run", async () => {
  const root = repo();
  // A repository whose hooks live in the tree, as with husky: a worker could edit them.
  git(root, ["config", "core.hooksPath", ".husky"]);
  plan(root, "run-wrapper-commit");
  checkpointPlan(root, "run-wrapper-commit");
  const marker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "orch-hook-")), "ran");
  repos.push(path.dirname(marker));
  const launched = launchTaskWorker(root, "run-wrapper-commit", "build", { constraints: [] }, {
    codexCommand: [process.execPath, writeFixture, "--no-commit", `--hooks=${marker}`]
  });
  const status = await runnerDone(launched.runner.statusFile);
  assert.equal(status.status, "completed");
  assert.equal(fs.existsSync(marker), false, "no hook from the worktree ran outside the sandbox");
  const worktree = launched.worktree.path;
  assert.equal(git(worktree, ["status", "--porcelain"]).trim(), "", "every change is committed");
  assert.equal(git(worktree, ["log", "-1", "--format=%s"]).trim(), "Build");
  assert.match(git(worktree, ["log", "-1", "--format=%b"]), /Orchestrator task build, build-attempt-1\./);
  const files = git(worktree, ["show", "--name-only", "--format=", "HEAD"]).trim().split("\n").sort();
  assert.deepEqual(files, [".husky/commit-msg", ".husky/post-commit", ".husky/pre-commit", "src/generated.js"]);
});

test("a worker that re-aims its worktree's .git pointer cannot run code through the wrapper or inspection", async () => {
  const root = repo();
  plan(root, "run-wrapper-hijack");
  checkpointPlan(root, "run-wrapper-hijack");
  const marker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "orch-hijack-")), "ran");
  repos.push(path.dirname(marker));
  const launched = launchTaskWorker(root, "run-wrapper-hijack", "build", { constraints: [] }, {
    codexCommand: [process.execPath, writeFixture, "--no-commit", `--hijack-git=${marker}`]
  });
  const status = await runnerDone(launched.runner.statusFile);
  assert.equal(status.status, "completed", status.error);
  assert.equal(fs.existsSync(marker) ? fs.readFileSync(marker, "utf8") : "", "", "the wrapper did not run the planted fsmonitor");
  // The commit landed on the worker's real branch, not in the planted repository.
  const branch = launched.worktree.branch;
  assert.equal(git(root, ["log", "-1", "--format=%s", branch]).trim(), "Build");
  const run = loadRun(root, "run-wrapper-hijack");
  const task = run.tasks.build;
  inspectTaskWorktree(task, task.attempts.at(-1));
  assert.equal(fs.existsSync(marker) ? fs.readFileSync(marker, "utf8") : "", "", "inspection did not run the planted fsmonitor");
  // A record from before the git directory was recorded resolves it from the
  // supervisor repository, or refuses without one.
  const legacy = { ...task.attempts.at(-1), worktree: { ...task.attempts.at(-1).worktree, gitDir: undefined } };
  inspectTaskWorktree(task, legacy, { cwd: root });
  assert.equal(fs.existsSync(marker) ? fs.readFileSync(marker, "utf8") : "", "", "a legacy record did not run it either");
  assert.throws(() => inspectTaskWorktree(task, legacy), /no recorded git directory/);
});

test("no filter a worker attributed runs when its changes are committed or inspected", async () => {
  const root = repo();
  // A repository that runs an in-tree script as a filter, which a worker can edit.
  git(root, ["config", "filter.local.clean", "sh filter.sh"]);
  git(root, ["config", "filter.local.smudge", "sh filter.sh"]);
  git(root, ["config", "filter.local.process", "sh filter.sh"]);
  // The repository's own attributes outside the tree select the filter too.
  fs.writeFileSync(path.join(root, ".git", "info", "attributes"), "*.dat filter=local\n");
  plan(root, "run-wrapper-filter");
  checkpointPlan(root, "run-wrapper-filter");
  const marker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "orch-hook-")), "ran");
  repos.push(path.dirname(marker));
  const launched = launchTaskWorker(root, "run-wrapper-filter", "build", { constraints: [] }, {
    codexCommand: [process.execPath, writeFixture, "--no-commit", `--filter=${marker}`]
  });
  const status = await runnerDone(launched.runner.statusFile);
  assert.equal(status.status, "completed", status.error);
  const task = loadRun(root, "run-wrapper-filter").tasks.build;
  inspectTaskWorktree(task, task.attempts.at(-1));
  assert.equal(fs.existsSync(marker) ? fs.readFileSync(marker, "utf8") : "", "", "no worker-attributed filter ran");
});

test("integrating a worker's commits runs no hook it changed", async () => {
  const root = repo();
  git(root, ["config", "core.hooksPath", "src/hooks"]);
  plan(root, "run-integrate-hook");
  checkpointPlan(root, "run-integrate-hook");
  const marker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "orch-hook-")), "ran");
  repos.push(path.dirname(marker));
  const launched = launchTaskWorker(root, "run-integrate-hook", "build", { constraints: [] }, {
    codexCommand: [process.execPath, writeFixture, "--no-commit", `--hooks=${marker}`, "--hooks-dir=src/hooks", "--declare-hooks"]
  });
  await runnerDone(launched.runner.statusFile);
  let update;
  for (let index = 0; index < 100; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    update = pollRunWorkers(root, "run-integrate-hook")[0];
    if (update && !["running", "dispatching"].includes(update.status)) {
      break;
    }
  }
  const run = loadRun(root, "run-integrate-hook");
  const task = run.tasks.build;
  const inspection = inspectTaskWorktree(task, task.attempts.at(-1));
  assert.equal(inspection.ready, true, JSON.stringify(inspection));
  integrateTaskWorktree(root, run, task, task.attempts.at(-1));
  assert.ok(fs.existsSync(path.join(root, "src", "hooks", "post-commit")), "the hook was integrated");
  assert.equal(fs.existsSync(marker) ? fs.readFileSync(marker, "utf8") : "", "", "no integrated hook ran during integration");
});

test("a worker whose wrapper died without a final status is failed by poll, not left running", async () => {
  const root = repo();
  plan(root, "run-dead-wrapper");
  checkpointPlan(root, "run-dead-wrapper");
  const pidFile = path.join(path.dirname(runFile(root, "run-dead-wrapper")), "descendant.pid");
  const launched = launchTaskWorker(root, "run-dead-wrapper", "build", { constraints: [] }, {
    codexCommand: [process.execPath, slowFixture, "--delay=60000", `--descendant=${pidFile}`, "--quiet-descendant"]
  });
  for (let index = 0; index < 100; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 40));
    if (fs.existsSync(launched.runner.statusFile) &&
        JSON.parse(fs.readFileSync(launched.runner.statusFile, "utf8")).childPid) {
      break;
    }
  }
  const { childPid } = JSON.parse(fs.readFileSync(launched.runner.statusFile, "utf8"));
  while (!fs.existsSync(pidFile)) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const descendant = Number(fs.readFileSync(pidFile, "utf8"));
  process.kill(launched.runner.pid, "SIGKILL");
  let update;
  for (let index = 0; index < 100; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 40));
    update = pollRunWorkers(root, "run-dead-wrapper")[0];
    if (update && !["running", "dispatching"].includes(update.status)) {
      break;
    }
  }
  const task = loadRun(root, "run-dead-wrapper").tasks.build;
  try {
    assert.equal(task.status, "failed");
    assert.match(task.attempts[0].error, /exited without a final status/);
    // Its Codex and what Codex started do not keep running in the freed slot.
    assert.ok(await exited(childPid), `Codex ${childPid} outlived its failed task`);
    assert.ok(await exited(descendant), `descendant ${descendant} outlived its failed task`);
  } finally {
    for (const pid of [childPid, descendant]) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }
});

test("cancelling a worker whose wrapper is gone kills what Codex started", async () => {
  const root = repo();
  plan(root, "run-dead-cancel");
  checkpointPlan(root, "run-dead-cancel");
  const pidFile = path.join(path.dirname(runFile(root, "run-dead-cancel")), "descendant.pid");
  const launched = launchTaskWorker(root, "run-dead-cancel", "build", { constraints: [] }, {
    codexCommand: [process.execPath, slowFixture, "--delay=60000", `--descendant=${pidFile}`, "--quiet-descendant"]
  });
  while (!fs.existsSync(pidFile)) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const descendant = Number(fs.readFileSync(pidFile, "utf8"));
  process.kill(launched.runner.pid, "SIGKILL");
  assert.ok(await exited(launched.runner.pid), "wrapper gone");
  try {
    cancelWorkers(root, "run-dead-cancel", "build", "user stopped it");
    // The descendant ignores SIGTERM, and no wrapper is left to escalate.
    assert.ok(await exited(descendant), `descendant ${descendant} survived the cancellation`);
  } finally {
    try {
      process.kill(descendant, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
});

test("a cancel leaves nothing of the worker running once it returns", async () => {
  const root = repo();
  plan(root, "run-cancel-sync");
  checkpointPlan(root, "run-cancel-sync");
  const launched = launchTaskWorker(root, "run-cancel-sync", "build", { constraints: [] }, {
    codexCommand: [process.execPath, slowFixture, "--delay=60000", "--ignore-term"]
  });
  // Codex's own pid: once it reports its thread (a read worker's first
  // recorded child is the profile probe).
  let childPid;
  while (!childPid) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    const status = fs.existsSync(launched.runner.statusFile) &&
      JSON.parse(fs.readFileSync(launched.runner.statusFile, "utf8"));
    childPid = status?.threadId ? status.childPid : null;
  }
  try {
    // Codex ignores SIGTERM. The cancel escalates itself, so a wrapper that
    // dies during the grace period cannot leave Codex running with no one to
    // kill it.
    cancelWorkers(root, "run-cancel-sync", "build", "user stopped it");
    try {
      process.kill(launched.runner.pid, "SIGKILL");
    } catch {
      // Already gone.
    }
    assert.ok(await exited(childPid, 1000), `Codex ${childPid} still running after cancel returned`);
  } finally {
    try {
      process.kill(childPid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
});

async function exited(pid, ms = 3000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  return false;
}

test("a write worker paused for input keeps its changes uncommitted, and a failed commit fails the worker", async () => {
  const root = repo();
  plan(root, "run-wrapper-pause");
  checkpointPlan(root, "run-wrapper-pause");
  const paused = launchTaskWorker(root, "run-wrapper-pause", "build", { constraints: [] }, {
    codexCommand: [process.execPath, writeFixture, "--no-commit", "--ask"]
  });
  assert.equal((await runnerDone(paused.runner.statusFile)).status, "completed");
  const base = paused.worktree.baseHead;
  assert.equal(git(paused.worktree.path, ["rev-parse", "HEAD"]).trim(), base, "nothing committed at a pause");
  assert.match(git(paused.worktree.path, ["status", "--porcelain"]), /src\//);

  const root2 = repo();
  plan(root2, "run-wrapper-fail");
  checkpointPlan(root2, "run-wrapper-fail");
  const failing = launchTaskWorker(root2, "run-wrapper-fail", "build", { constraints: [] }, {
    codexCommand: [process.execPath, writeFixture, "--no-commit", "--lock-index"]
  });
  const status = await runnerDone(failing.runner.statusFile);
  assert.equal(status.status, "failed");
  assert.match(status.error, /git add failed/);
});

test("a detached write worker completes the full launch, inspect, integrate, finalize, and cleanup lifecycle", async () => {
  const root = repo();
  plan(root, "run-e2e");
  checkpointPlan(root, "run-e2e");
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
  assert.equal(recorded.task.attempts.at(-1).outcome.terminalOutcome, "accepted");
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
  checkpointPlan(root, "run-stop");
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
  const update = pollRunWorkers(root, "run-stop")[0];
  assert.equal(update.status, "cancelled");
  const cancelled = loadRun(root, "run-stop").tasks.build.attempts.at(-1);
  assert.equal(cancelled.outcome.terminalOutcome, "cancelled");
});

test("the worker result schema satisfies structured-output requirements", () => {
  // OpenAI structured outputs reject any object schema whose `required` array
  // omits a declared property key. A worker that fails this check exits before
  // reading its briefing, so every run launch breaks identically.
  const visit = (schema, pointer) => {
    if (!schema || typeof schema !== "object") {
      return;
    }
    if (schema.type === "object" || schema.properties) {
      const declared = Object.keys(schema.properties ?? {});
      const required = schema.required ?? [];
      assert.deepEqual(
        declared.filter((key) => !required.includes(key)),
        [],
        `${pointer} declares properties missing from required`
      );
      assert.equal(
        schema.additionalProperties,
        false,
        `${pointer} must set additionalProperties to false`
      );
      for (const [key, child] of Object.entries(schema.properties ?? {})) {
        visit(child, `${pointer}/${key}`);
      }
    }
    if (schema.items) {
      visit(schema.items, `${pointer}/items`);
    }
  };
  visit(WORKER_RESULT_SCHEMA, "#");
});

test("an optional worker field stays expressible as null", () => {
  const blockerCode = WORKER_RESULT_SCHEMA.properties.blocker_code;
  assert.ok(
    blockerCode.type.includes("null"),
    "blocker_code must accept null so a successful worker is not forced to invent a blocker"
  );
  assert.ok(blockerCode.enum.includes(null));
  assert.ok(blockerCode.enum.includes("missing_context"));
});

test("a worker request is a nullable, strict nested object", () => {
  const request = WORKER_RESULT_SCHEMA.properties.needs_input;
  assert.ok(WORKER_RESULT_SCHEMA.required.includes("needs_input"));
  assert.deepEqual(request.type, ["object", "null"]);
  assert.deepEqual(request.properties.kind.enum, ["scope_extension", "question"]);
  assert.deepEqual(request.required, ["kind", "paths", "reason", "question", "options"]);
  assert.equal(request.additionalProperties, false);
  assert.ok(request.properties.question.type.includes("null"));
});

test("an API rejection reported on stdout is surfaced as the failure reason", async () => {
  // Codex writes API-level rejections to the event stream, not stderr. Without
  // reading it back the supervisor records only "Codex exited 1" and the real
  // cause has to be dug out of events.jsonl by hand.
  const root = makeRepo();
  after(() => cleanup(root));
  const apiErrorFixture = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "fixtures",
    "fake-codex-api-error.mjs"
  );
  plan(root, "run-api-error");
  checkpointPlan(root, "run-api-error");
  launchTaskWorker(root, "run-api-error", "build", { constraints: [] }, {
    codexCommand: [process.execPath, apiErrorFixture]
  });
  let update;
  for (let index = 0; index < 100; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 30));
    update = pollRunWorkers(root, "run-api-error")[0];
    if (update && !["running", "dispatching"].includes(update.status)) {
      break;
    }
  }
  assert.equal(update.status, "failed");
  assert.match(update.error, /Invalid schema for response_format/);
  assert.doesNotMatch(update.error, /^Codex exited/);
});

const unavailableFixture = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "fake-codex-model-unavailable.mjs"
);

async function pollUntil(root, runId, done, attempts = 150) {
  const seen = [];
  for (let index = 0; index < attempts; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 30));
    seen.push(...pollRunWorkers(root, runId));
    if (done(loadRun(root, runId))) {
      return seen;
    }
  }
  throw new Error(`Run ${runId} did not settle: ${JSON.stringify(seen)}`);
}

function runEvents(root, runId) {
  return fs.readFileSync(eventsFile(root, runId), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

test("model unavailability is read only from top-level rejections that name the slug", () => {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "orch-events-"));
  after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "events.jsonl");
  const writeEvents = (events) =>
    fs.writeFileSync(file, events.map((event) => JSON.stringify(event)).join("\n"));

  writeEvents([
    { type: "thread.started", thread_id: "t" },
    {
      type: "item.completed",
      item: { type: "error", message: "Model metadata for `gpt-6-astra` not found. Defaulting to fallback metadata." }
    }
  ]);
  assert.equal(modelUnavailableError(file, "gpt-6-astra"), null);

  writeEvents([{ type: "error", message: "The 'gpt-6-astra' model is not supported when using Codex with a ChatGPT account." }]);
  assert.match(modelUnavailableError(file, "gpt-6-astra"), /not supported/);
  assert.equal(modelUnavailableError(file, "gpt-6.1-sol"), null);

  writeEvents([{ type: "error", error: { message: "Invalid schema for response_format 'codex_output_schema'." } }]);
  assert.equal(modelUnavailableError(file, "gpt-6-astra"), null);

  writeEvents([{ type: "turn.failed", error: { code: "model_not_found", message: "The model `gpt-6-astra` does not exist or you do not have access to it." } }]);
  assert.match(modelUnavailableError(file, "gpt-6-astra"), /do not have access/);

  // After the worker has done anything, an error naming the model is a mid-run
  // failure, not a launch rejection.
  writeEvents([
    { type: "thread.started", thread_id: "t" },
    { type: "turn.started" },
    { type: "item.completed", item: { type: "command_execution", command: "git commit -m work" } },
    { type: "error", message: "The model gpt-6-astra is currently unavailable. Please try again later." },
    { type: "turn.failed", error: { message: "The model gpt-6-astra is currently unavailable." } }
  ]);
  assert.equal(modelUnavailableError(file, "gpt-6-astra"), null);
  writeEvents([
    { type: "turn.completed" },
    { type: "error", message: "The 'gpt-6-astra' model is not supported when using Codex with a ChatGPT account." }
  ]);
  assert.equal(modelUnavailableError(file, "gpt-6-astra"), null);

  // An outage before any work is still not an entitlement rejection.
  for (const message of [
    "The model gpt-6-astra is currently unavailable. Please try again later.",
    "gpt-6-astra model is temporarily unavailable (503).",
    "The model gpt-6-astra is overloaded; not available right now due to capacity."
  ]) {
    writeEvents([{ type: "thread.started", thread_id: "t" }, { type: "turn.started" }, { type: "error", message }]);
    assert.equal(modelUnavailableError(file, "gpt-6-astra"), null, message);
  }
  // Work that has scrolled out of the read tail still rules out a rejection.
  writeEvents([
    { type: "thread.started", thread_id: "t" },
    { type: "item.completed", item: { type: "command_execution", command: "git commit -m work" } },
    { type: "item.completed", item: { type: "agent_message", text: "x".repeat(70000) } },
    { type: "error", message: "The 'gpt-6-astra' model is not supported when using Codex with a ChatGPT account." }
  ]);
  assert.equal(modelUnavailableError(file, "gpt-6-astra"), null);

  // Entitlement wording that happens to say "currently" is still a rejection.
  writeEvents([{ type: "error", message: "The model gpt-6-astra is currently not supported on your plan." }]);
  assert.match(modelUnavailableError(file, "gpt-6-astra"), /not supported on your plan/);
});

test("an unavailable supervisor-routed model is substituted down the ladder and recorded", async () => {
  const root = repo();
  plan(root, "run-substitute", { taskModel: "astra", taskEffort: "xhigh" });
  checkpointPlan(root, "run-substitute");
  const launched = launchTaskWorker(root, "run-substitute", "build", { constraints: [] }, {
    codexCommand: [process.execPath, unavailableFixture, "--unavailable=gpt-6-astra"]
  });
  assert.equal(launched.model, "gpt-6-astra");

  const updates = await pollUntil(
    root,
    "run-substitute",
    (run) => run.tasks.build.status === "reported"
  );
  const substituted = updates.find((update) => update.status === "substituted");
  assert.equal(substituted.unavailableModel, "gpt-6-astra");
  assert.equal(substituted.requestedModel, "gpt-6-astra");
  assert.equal(substituted.model, "gpt-6.1-sol");
  assert.equal(substituted.reasoningEffort, "xhigh");
  assert.equal(substituted.pinned, false);
  assert.match(substituted.notice, /^Model substituted: the supervisor routed gpt-6-astra/);

  const run = loadRun(root, "run-substitute");
  assert.equal(run.tasks.build.model, "gpt-6-astra", "the saved route is never rewritten");
  const [rejected, replacement] = run.tasks.build.attempts;
  assert.equal(rejected.model, "gpt-6-astra");
  assert.deepEqual(
    [rejected.outcome.terminalOutcome, rejected.outcome.action, rejected.outcome.reasonCode],
    ["execution_failed", "execute", "model_unavailable"]
  );
  assert.equal(replacement.model, "gpt-6.1-sol");
  assert.equal(replacement.requestedModel, "gpt-6-astra");
  assert.equal(replacement.reasoningEffort, "xhigh");
  assert.equal(replacement.substitution.pinned, false);
  assert.equal(run.tasks.build.result.structured.summary, "Fake worker completed on gpt-6.1-sol.");
  assert.deepEqual(run.unavailableModels.map((entry) => entry.model), ["gpt-6-astra"]);
  const spec = JSON.parse(fs.readFileSync(replacement.runner.specFile, "utf8"));
  assert.equal(spec.model, "gpt-6.1-sol");

  const types = runEvents(root, "run-substitute").map((event) => event.type);
  assert.ok(types.includes("task.model_unavailable"));
  assert.ok(types.includes("task.model_substituted"));

  const briefing = renderSupervisorBriefing(root, run, { constraints: [] });
  assert.match(briefing, /worker route: gpt-6\.1-sol \(xhigh\) — SUBSTITUTED for gpt-6-astra/);
  assert.match(briefing, /unavailable: gpt-6-astra/);
  assert.doesNotMatch(briefing, /Tell the user which model actually ran/);
  const resumed = runCli(root, ["run", "resume", "run-substitute"]);
  assert.equal(resumed.code, 0);
  assert.match(resumed.stdout, /Model substituted: the supervisor routed gpt-6-astra/);
});

test("a user-pinned model is substituted too, but flagged prominently", async () => {
  const root = repo();
  createRun(root, {
    id: "run-pinned-substitute",
    lane: "api",
    objective: "Pinned astra",
    maxWorkers: 2,
    workerModel: "astra",
    reasoningEffort: "high"
  });
  replacePlan(root, "run-pinned-substitute", [
    { id: "first", title: "First", objective: "Inspect one", kind: "read" },
    { id: "second", title: "Second", objective: "Inspect two", kind: "read" }
  ]);
  checkpointPlan(root, "run-pinned-substitute");
  const codexCommand = [process.execPath, unavailableFixture, "--unavailable=gpt-6-astra,gpt-6.1-sol"];
  launchTaskWorker(root, "run-pinned-substitute", "first", { constraints: [] }, { codexCommand });
  await pollUntil(
    root,
    "run-pinned-substitute",
    (run) => run.tasks.first.status === "reported"
  );
  let run = loadRun(root, "run-pinned-substitute");
  assert.deepEqual(
    run.tasks.first.attempts.map((attempt) => attempt.model),
    ["gpt-6-astra", "gpt-6.1-sol", "gpt-6.1-terra"]
  );
  const final = run.tasks.first.attempts.at(-1);
  assert.equal(final.requestedModel, "gpt-6-astra");
  assert.equal(final.substitution.pinned, true);
  assert.deepEqual(final.substitution.unavailableModels, ["gpt-6-astra", "gpt-6.1-sol"]);

  // Later launches in the same run go straight to the substitute without
  // burning another rejected attempt, and still record the substitution.
  const second = launchTaskWorker(root, "run-pinned-substitute", "second", { constraints: [] }, {
    codexCommand
  });
  assert.equal(second.model, "gpt-6.1-terra");
  assert.equal(second.substitution.pinned, true);
  assert.match(second.briefing, /You are one gpt-6\.1-terra worker/);
  await pollUntil(
    root,
    "run-pinned-substitute",
    (current) => current.tasks.second.status === "reported"
  );
  run = loadRun(root, "run-pinned-substitute");
  assert.equal(run.tasks.second.attempts.length, 1);

  const briefing = renderSupervisorBriefing(root, run, { constraints: [] });
  assert.match(briefing, /A user-pinned model was substituted\. Tell the user/);
  assert.match(briefing, /USER-PINNED MODEL SUBSTITUTED: the run pinned gpt-6-astra/);
  assert.match(briefing, /SUBSTITUTED for gpt-6-astra \(user pin overridden\)/);
});

test("an unavailable model with no rung left fails the task for escalation", async () => {
  const root = repo();
  plan(root, "run-ladder-end", { workerModel: "luna" });
  checkpointPlan(root, "run-ladder-end");
  launchTaskWorker(root, "run-ladder-end", "build", { constraints: [] }, {
    codexCommand: [process.execPath, unavailableFixture, "--unavailable=gpt-5.6-luna"]
  });
  const updates = await pollUntil(
    root,
    "run-ladder-end",
    (run) => run.tasks.build.status === "failed"
  );
  assert.equal(updates.at(-1).fallbackModel, null);
  const task = loadRun(root, "run-ladder-end").tasks.build;
  assert.equal(task.attempts.length, 1);
  assert.deepEqual(
    [task.attempts[0].outcome.terminalOutcome, task.attempts[0].outcome.action, task.attempts[0].outcome.reasonCode],
    ["execution_failed", "escalate", "model_unavailable"]
  );
  assert.match(task.result.summary, /No model remains on the fallback ladder below gpt-5\.6-luna/);
});

test("a fallback never lands a task others depend on on luna", async () => {
  const root = repo();
  createRun(root, { id: "run-luna-leaf", lane: "api", objective: "Build safely" });
  const routed = (id, extra = {}) => ({
    id,
    title: id,
    objective: `Do ${id}`,
    scope: [`src/${id}/**`],
    acceptance: ["tests pass"],
    model: "terra",
    effort: "high",
    routingReason: "The supervisor selected this route for the bounded task.",
    ...extra
  });
  replacePlan(root, "run-luna-leaf", [routed("base"), routed("leaf"), routed("next", { dependsOn: ["base"] })]);
  checkpointPlan(root, "run-luna-leaf");
  const command = [process.execPath, unavailableFixture, "--unavailable=gpt-6.1-terra"];
  launchTaskWorker(root, "run-luna-leaf", "base", { constraints: [] }, { codexCommand: command });
  await pollUntil(root, "run-luna-leaf", (run) => run.tasks.base.status !== "running");
  let run = loadRun(root, "run-luna-leaf");
  assert.equal(run.tasks.base.status, "failed");
  assert.equal(run.tasks.base.attempts.length, 1);
  assert.equal(run.tasks.base.attempts[0].modelUnavailable.fallbackModel, null);
  assert.match(run.tasks.base.result.summary, /luna is not used for a task others depend on/);

  // A leaf still falls back to luna.
  const leaf = launchTaskWorker(root, "run-luna-leaf", "leaf", { constraints: [] }, { codexCommand: command });
  assert.equal(leaf.model, "gpt-5.6-luna");
  assert.equal(leaf.substitution.requestedModel, "gpt-6.1-terra");

  // A retry of the depended-on task is refused at launch instead of spending
  // another launch on the model already rejected, and run ready says why.
  retryTask(root, "run-luna-leaf", "base");
  const ready = JSON.parse(runCli(root, ["run", "ready", "run-luna-leaf", "--json"]).stdout);
  assert.deepEqual(ready.blocked.map((task) => task.id), ["base"]);
  assert.match(ready.blocked[0].conflicts[0], /gpt-6\.1-terra was rejected as unavailable/);
  assert.throws(
    () => launchTaskWorker(root, "run-luna-leaf", "base", { constraints: [] }, { codexCommand: command }),
    /no allowed model remains below it \(luna is not used for a task others depend on\)/
  );
  assert.equal(loadRun(root, "run-luna-leaf").tasks.base.attempts.length, 1);
});

test("a poll reloads the run only for tasks that are active", () => {
  const root = repo();
  createRun(root, { id: "run-poll-loads", lane: "api", objective: "Build safely", workerModel: "sol", reasoningEffort: "high" });
  replacePlan(root, "run-poll-loads", ["a", "b", "c", "d", "e"].map((id) => ({
    id, title: id, objective: id, kind: "read", acceptance: ["ok"]
  })));
  const file = runFile(root, "run-poll-loads");
  const original = fs.readFileSync;
  let loads = 0;
  fs.readFileSync = function (target, ...rest) {
    if (String(target) === file) {
      loads += 1;
    }
    return original.call(this, target, ...rest);
  };
  try {
    assert.deepEqual(pollRunWorkers(root, "run-poll-loads"), []);
  } finally {
    fs.readFileSync = original;
  }
  assert.equal(loads, 1);
});

test("a poll's run loads depend on its active tasks, not on how many tasks the run has", async () => {
  const measure = async (runId, taskCount) => {
    const root = repo();
    createRun(root, { id: runId, lane: "api", objective: "Build safely", workerModel: "sol", reasoningEffort: "high" });
    replacePlan(root, runId, Array.from({ length: taskCount }, (_, index) => ({
      id: `t${index}`, title: `t${index}`, objective: `t${index}`, kind: "read", acceptance: ["ok"]
    })));
    checkpointPlan(root, runId);
    const launched = launchTaskWorker(root, runId, "t0", { constraints: [] }, {
      codexCommand: [process.execPath, slowFixture, "--delay=10000"]
    });
    after(() => stopTaskWorker(launched));
    await pollUntil(root, runId, (run) => run.tasks.t0.attempts[0].threadId);
    const file = runFile(root, runId);
    const original = fs.readFileSync;
    let loads = 0;
    fs.readFileSync = function (target, ...rest) {
      if (String(target) === file) {
        loads += 1;
      }
      return original.call(this, target, ...rest);
    };
    let updates;
    try {
      updates = pollRunWorkers(root, runId);
    } finally {
      fs.readFileSync = original;
    }
    // The active task is still collected.
    assert.deepEqual(updates.map((update) => [update.taskId, update.status]), [["t0", "running"]]);
    return loads;
  };
  assert.equal(await measure("run-loads-small", 2), await measure("run-loads-large", 8));
});

test("a rejected legacy slug off the fallback ladder is refused at launch, not relaunched", () => {
  const root = repo();
  createRun(root, { id: "run-legacy-rejected", lane: "api", objective: "Old run", workerModel: "sol", reasoningEffort: "high" });
  replacePlan(root, "run-legacy-rejected", [{ id: "work", title: "work", objective: "work", kind: "read", acceptance: ["ok"] }]);
  checkpointPlan(root, "run-legacy-rejected");
  // A 0.5.x run saved the legacy slug, and Codex has since rejected it.
  const file = runFile(root, "run-legacy-rejected");
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  saved.tasks.work.model = "gpt-5.6-sol";
  saved.unavailableModels = [{ model: "gpt-5.6-sol", at: new Date().toISOString(), message: "model not found" }];
  fs.writeFileSync(file, `${JSON.stringify(saved, null, 2)}\n`);

  const ready = JSON.parse(runCli(root, ["run", "ready", "run-legacy-rejected", "--json"]).stdout);
  assert.deepEqual(ready.tasks.map((task) => task.id), []);
  assert.deepEqual(ready.blocked.map((task) => task.id), ["work"]);
  assert.match(ready.blocked[0].conflicts[0], /gpt-5\.6-sol was rejected as unavailable/);
  assert.throws(
    () => claimTask(root, "run-legacy-rejected", "work", { constraints: [] }),
    /gpt-5\.6-sol, which Codex rejected as unavailable in this run, and it is not on the fallback ladder/
  );
  assert.equal(loadRun(root, "run-legacy-rejected").tasks.work.attempts?.length ?? 0, 0);
});
