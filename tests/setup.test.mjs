import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";

import { addLane } from "../plugins/orchestrator/scripts/lib/lanes.mjs";
import { createRun, replacePlan, claimTask, loadRun, retryTask } from "../plugins/orchestrator/scripts/lib/runs.mjs";
import { launchTaskWorker } from "../plugins/orchestrator/scripts/lib/workers.mjs";
import { createTaskWorktree, prepareTaskWorktree, reuseTaskWorktree } from "../plugins/orchestrator/scripts/lib/worktrees.mjs";
import { checkpointPlan, cleanup, git, makeRepo, runCli, write } from "./helpers.mjs";

const repos = [];
after(() => repos.forEach(cleanup));
const codexCommand = [process.execPath, "-e", `const {spawnSync}=require('node:child_process');const a=process.argv.slice(1);const i=a.indexOf('--');const r=spawnSync(a[i+1],a.slice(i+2),{stdio:'inherit'});process.exit(r.status??1);`, "--"];

function planned(script) {
  const root = makeRepo();
  repos.push(root);
  runCli(root, ["init"]);
  write(root, ".gitignore", "node_modules/\n");
  write(root, "prepare.cjs", script);
  write(root, "lock.json", "{}\n");
  addLane(root, "api", { scope: ["src/**"], setup: { argv: [process.execPath, "prepare.cjs"], inputs: ["lock.json", "prepare.cjs"] } });
  git(root, ["add", "-A"]);
  git(root, ["commit", "-qm", "project setup"]);
  createRun(root, { id: "setup", lane: "api", objective: "Implement", workerModel: "sol", reasoningEffort: "high" });
  replacePlan(root, "setup", [{ id: "build", title: "Build", objective: "Build", acceptance: ["works"] }]);
  checkpointPlan(root, "setup");
  return root;
}

test("prepared worktrees reuse matching setup but changed lockfiles cannot execute worker scripts", () => {
  const root = planned("require('fs').mkdirSync('node_modules');console.log('installed');");
  claimTask(root, "setup", "build");
  const run = loadRun(root, "setup");
  const task = run.tasks.build;
  const attempt = task.attempts.at(-1);
  const worktree = createTaskWorktree(root, run, task, attempt);
  attempt.worktree = worktree;
  const first = prepareTaskWorktree(root, run, worktree, { codexCommand });
  assert.equal(first.passed, true);
  assert.equal(fs.existsSync(path.join(root, "node_modules")), false);
  const reused = reuseTaskWorktree(root, run, attempt);
  assert.deepEqual(prepareTaskWorktree(root, run, reused, { codexCommand }), first, "non-idempotent script must not run again");
  write(worktree.path, "lock.json", '{"changed":true}\n');
  write(worktree.path, "prepare.cjs", "throw Error('worker-controlled script was executed')");
  assert.throws(() => prepareTaskWorktree(root, run, reused, { codexCommand }), /never executes worker-modified scripts/);
});

test("failed setup has its own outcome and can retry its worktree without launching a model", () => {
  const root = planned("process.exit(17)");
  assert.throws(() => launchTaskWorker(root, "setup", "build", {}, { codexCommand }), /setup failed/);
  const failed = loadRun(root, "setup").tasks.build.attempts.at(-1);
  assert.equal(failed.outcome.reasonCode, "setup_failed");
  assert.equal(failed.worktree.setup.exitCode, 17);
  assert.equal(failed.runner, undefined);
  retryTask(root, "setup", "build");
  checkpointPlan(root, "setup");
  const retried = claimTask(root, "setup", "build");
  assert.equal(retried.retry.worktree.mode, "reuse");
  assert.equal(retried.retry.worktree.attemptId, failed.id);
});
