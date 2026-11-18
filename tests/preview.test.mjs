import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";

import { addLane } from "../plugins/orchestrator/scripts/lib/lanes.mjs";
import { attachExecution, claimTask, createRun, integrateRunTask, loadRun, previewRunTask, recordTaskResult, replacePlan, runChecks } from "../plugins/orchestrator/scripts/lib/runs.mjs";
import { createTaskWorktree, prepareTaskWorktree } from "../plugins/orchestrator/scripts/lib/worktrees.mjs";
import { checkpointPlan, cleanup, git, makeRepo, runCli, write } from "./helpers.mjs";

const repos = [];
after(() => repos.forEach(cleanup));
const codexCommand = [process.execPath, "-e", `const {spawnSync}=require('node:child_process');const a=process.argv.slice(1);const i=a.indexOf('--');const r=spawnSync(a[i+1],a.slice(i+2),{stdio:'inherit'});process.exit(r.status??1);`, "--"];
const options = { codexCommand };
const evidence = { evidence: ["Reviewed the exact candidate and passing checks"] };

function candidates() {
  const root = makeRepo();
  repos.push(root);
  runCli(root, ["init"]);
  write(root, ".gitignore", "node_modules/\n");
  write(root, "setup.cjs", "const fs=require('fs');fs.mkdirSync('node_modules');fs.writeFileSync('node_modules/ready','ready')");
  for (const id of ["a", "b"]) write(root, `${id}.json`, "1\n");
  addLane(root, "work", { scope: ["*.json"],
    setup: { argv: [process.execPath, "setup.cjs"], inputs: ["setup.cjs"] },
    checks: [{ id: "combined", argv: [process.execPath, "-e", "const fs=require('fs');if(!fs.existsSync('node_modules/ready'))process.exit(8);if(+fs.readFileSync('a.json')===2&&+fs.readFileSync('b.json')===2)process.exit(5)"] }]
  });
  git(root, ["add", "-A"]);
  git(root, ["commit", "-qm", "project"]);
  createRun(root, { id: "preview", lane: "work", objective: "Combine safely", workerModel: "sol", reasoningEffort: "high" });
  replacePlan(root, "preview", ["a", "b"].map((id) => ({ id, title: id, objective: id, scope: [`${id}.json`], acceptance: ["Combined check passes"] })));
  checkpointPlan(root, "preview");
  for (const id of ["a", "b"]) {
    const dispatch = claimTask(root, "preview", id);
    const run = loadRun(root, "preview"), task = run.tasks[id], attempt = task.attempts.at(-1);
    const worktree = createTaskWorktree(root, run, task, attempt);
    prepareTaskWorktree(root, run, worktree, options);
    write(worktree.path, `${id}.json`, "2\n");
    git(worktree.path, ["add", "-A"]);
    git(worktree.path, ["commit", "-qm", `candidate ${id}`]);
    attachExecution(root, "preview", id, { attemptId: dispatch.attemptId, worktree, runner: null });
    recordTaskResult(root, "preview", id, { attemptId: dispatch.attemptId, resultText: JSON.stringify({ summary: "done", files_touched: [`${id}.json`], tests: [], decisions: [], assumptions: [], blockers: [], confidence: "high" }) });
    assert.equal(runChecks(root, "preview", id, options)[0].passed, true);
  }
  return root;
}

test("combined preview catches an interaction before the supervisor branch changes and rejects stale target receipts", () => {
  const root = candidates();
  const head = git(root, ["rev-parse", "HEAD"]);
  assert.throws(() => integrateRunTask(root, "preview", "a", evidence), /preview is missing/);
  assert.equal(previewRunTask(root, "preview", "b", options).passed, true);
  assert.equal(previewRunTask(root, "preview", "a", options).passed, true);
  assert.equal(git(root, ["rev-parse", "HEAD"]), head, "previews cannot advance the supervisor branch");
  assert.equal(fs.existsSync(path.join(root, "node_modules")), false, "preview setup stays isolated");
  integrateRunTask(root, "preview", "a", evidence);
  const acceptedHead = git(root, ["rev-parse", "HEAD"]);
  assert.throws(() => integrateRunTask(root, "preview", "b", evidence), /preview is missing, failed, or stale/);
  const combined = previewRunTask(root, "preview", "b", options);
  assert.equal(combined.passed, false);
  assert.equal(combined.checks[0].exitCode, 5);
  assert.throws(() => integrateRunTask(root, "preview", "b", evidence), /preview is missing, failed, or stale/);
  assert.equal(git(root, ["rev-parse", "HEAD"]), acceptedHead);
  assert.equal(fs.readFileSync(path.join(root, "b.json"), "utf8"), "1\n");
  assert.equal(loadRun(root, "preview").tasks.b.status, "reported");
  const cleaned = runCli(root, ["run", "cleanup", "preview", "--json"]);
  assert.equal(cleaned.code, 0, cleaned.stderr);
  assert.equal(fs.existsSync(combined.worktree.path), false);
});

test("changing the candidate invalidates its preview even after isolated checks pass again", () => {
  const root = candidates();
  assert.equal(previewRunTask(root, "preview", "a", options).passed, true);
  const worktree = loadRun(root, "preview").tasks.a.attempts.at(-1).worktree;
  write(worktree.path, "a.json", "3\n");
  git(worktree.path, ["add", "a.json"]);
  git(worktree.path, ["commit", "-qm", "change candidate"]);
  assert.equal(runChecks(root, "preview", "a", options)[0].passed, true);
  assert.throws(() => integrateRunTask(root, "preview", "a", evidence), /preview is missing, failed, or stale/);
  assert.equal(previewRunTask(root, "preview", "a", options).passed, true);
  integrateRunTask(root, "preview", "a", evidence);
  assert.equal(fs.readFileSync(path.join(root, "a.json"), "utf8"), "3\n");
});
