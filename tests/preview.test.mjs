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

// With conflict, b also rewrites a.json under an overlapping (not identical) scope.
function candidates({ conflict = false } = {}) {
  const root = makeRepo();
  repos.push(root);
  runCli(root, ["init"]);
  write(root, ".gitignore", "node_modules/\n");
  write(root, "setup.cjs", "const fs=require('fs');fs.mkdirSync('node_modules');fs.writeFileSync('node_modules/ready','ready')");
  for (const id of ["a", "b"]) write(root, `${id}.json`, conflict && id === "a" ? "1\nkeep\nkeep\nlast\n" : "1\n");
  addLane(root, "work", { scope: ["*.json"],
    setup: { argv: [process.execPath, "setup.cjs"], inputs: ["setup.cjs"] },
    checks: [{ id: "combined", argv: [process.execPath, "-e", "const fs=require('fs');if(!fs.existsSync('node_modules/ready'))process.exit(8);if(+fs.readFileSync('a.json')===2&&+fs.readFileSync('b.json')===2)process.exit(5)"] }]
  });
  git(root, ["add", "-A"]);
  git(root, ["commit", "-qm", "project"]);
  createRun(root, { id: "preview", lane: "work", objective: "Combine safely", workerModel: "sol", reasoningEffort: "high" });
  const file = (id) => conflict && id === "b" ? "a.json" : `${id}.json`;
  replacePlan(root, "preview", ["a", "b"].map((id) => ({ id, title: id, objective: id, scope: [conflict && id === "b" ? "?.json" : `${id}.json`], acceptance: ["Combined check passes"] })),
    conflict ? { approvedTasks: ["b"] } : {});
  checkpointPlan(root, "preview");
  for (const id of ["a", "b"]) {
    const dispatch = claimTask(root, "preview", id);
    const run = loadRun(root, "preview"), task = run.tasks[id], attempt = task.attempts.at(-1);
    const worktree = createTaskWorktree(root, run, task, attempt);
    prepareTaskWorktree(root, run, worktree, options);
    const value = id === "b" && conflict ? "3\n" : "2\n";
    write(worktree.path, file(id), conflict ? value + "keep\nkeep\nlast\n" : value);
    git(worktree.path, ["add", "-A"]);
    git(worktree.path, ["commit", "-qm", `candidate ${id}`]);
    attachExecution(root, "preview", id, { attemptId: dispatch.attemptId, worktree, runner: null });
    recordTaskResult(root, "preview", id, { attemptId: dispatch.attemptId, resultText: JSON.stringify({ summary: "done", files_touched: [file(id)], tests: [], decisions: [], assumptions: [], blockers: [], confidence: "high" }) });
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
  assert.equal(combined.regression.candidateTaskId, "b");
  assert.deepEqual(combined.regression.newlyIntegratedTaskIds, ["a"]);
  assert.equal(loadRun(root, "preview").previews.find((entry) => entry.id === combined.regression.previousPassingPreviewId).passed, true);
  assert.throws(() => integrateRunTask(root, "preview", "b", evidence), /preview is missing, failed, or stale/);
  assert.equal(git(root, ["rev-parse", "HEAD"]), acceptedHead);
  assert.equal(fs.readFileSync(path.join(root, "b.json"), "utf8"), "1\n");
  assert.equal(loadRun(root, "preview").tasks.b.status, "reported");
  const cleaned = runCli(root, ["run", "cleanup", "preview", "--json"]);
  assert.equal(cleaned.code, 0, cleaned.stderr);
  assert.equal(fs.existsSync(combined.worktree.path), false);
});

test("sequential combined checks preserve the passing baseline and identify the intervening integration without claiming causality", () => {
  const root = candidates();
  // Provision only the checkout's ignored check prerequisite, as an operator would.
  write(root, "node_modules/ready", "ready");
  const baseline = runChecks(root, "preview", null, options)[0];
  assert.equal(baseline.passed, true);
  previewRunTask(root, "preview", "a", options);
  integrateRunTask(root, "preview", "a", evidence);
  write(root, "b.json", "2\n");
  const suspected = runChecks(root, "preview", null, options)[0];
  assert.equal(suspected.passed, false);
  assert.equal(suspected.regression.previousPassingReceiptId, baseline.id);
  assert.deepEqual(suspected.regression.candidateTaskIds, ["a"]);
  assert.match(suspected.regression.attribution, /suspected, not proven causal/);
  write(root, "b.json", "1\n");
  const passing = runChecks(root, "preview", null, options)[0];
  assert.equal(passing.passed, true);
  // A later dirty edit is not itself an integration and must not be blamed on a worker.
  write(root, "b.json", "2\n");
  const failing = runChecks(root, "preview", null, options)[0];
  assert.equal(failing.passed, false);
  assert.equal(failing.regression.previousPassingReceiptId, passing.id);
  assert.deepEqual(failing.regression.candidateTaskIds, []);
  assert.match(failing.regression.attribution, /unresolved/);
  assert.equal(loadRun(root, "preview").checkReceipts.find((entry) => entry.id === baseline.id).passed, true);
  // A checkout that changes while the check runs (an integration landing
  // meanwhile) fails the receipt but is not attributed to anyone.
  write(root, "b.json", "1\n");
  const mutating = [process.execPath, "-e", `require('fs').writeFileSync('b.json','2\\n');${codexCommand[2]}`, "--"];
  const moved = runChecks(root, "preview", null, { codexCommand: mutating })[0];
  assert.equal(moved.passed, false);
  assert.equal(moved.changedDuringCheck, true);
  assert.equal(moved.regression, undefined);

  // An unreadable Git index prevents the initial fingerprint, before any check runs.
  write(root, ".git/index", "invalid");
  const unavailable = runCli(root, ["run", "check", "preview"]);
  assert.equal(unavailable.code, 1);
  const receipt = loadRun(root, "preview").checkReceipts.at(-1);
  assert.equal(receipt.changedDuringCheck, null);
  assert.equal(receipt.regression, undefined);
  assert.ok(receipt.fingerprintError);
  assert.ok(unavailable.stdout.includes(`could not verify the checkout: ${receipt.fingerprintError}`));
  assert.doesNotMatch(unavailable.stdout, /the checkout changed/);
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

test("a conflict a required preview finds is recorded on the attempt, so a conflict retry carries it", () => {
  const root = candidates({ conflict: true });
  assert.equal(previewRunTask(root, "preview", "a", options).passed, true);
  integrateRunTask(root, "preview", "a", evidence);
  const head = git(root, ["rev-parse", "HEAD"]);
  const preview = previewRunTask(root, "preview", "b", options);
  assert.equal(preview.passed, false);
  assert.equal(preview.reasonCode, "integration_conflict");
  assert.equal(git(root, ["rev-parse", "HEAD"]), head, "a failed preview leaves the supervisor branch alone");
  const diagnostic = loadRun(root, "preview").tasks.b.attempts.at(-1).diagnostics.at(-1);
  assert.equal(diagnostic.reasonCode, "integration_conflict");
  assert.deepEqual(diagnostic.details.conflictingPaths, ["a.json"]);
  assert.equal(diagnostic.details.targetHead, head.trim());
  assert.equal(diagnostic.details.previewId, preview.id);
  const shown = runCli(root, ["run", "show", "preview"]);
  assert.match(shown.stdout, /run retry preview b --conflict/);
  const retried = runCli(root, ["run", "retry", "preview", "b", "--conflict", "--note", "Keep a's value; redo b on the new head", "--json"]);
  assert.equal(retried.code, 0, retried.stderr);
  assert.equal(loadRun(root, "preview").tasks.b.status, "pending");
});

test("a passing candidate with a newer preview cannot be retried on its old conflict", () => {
  const root = candidates({ conflict: true });
  assert.equal(previewRunTask(root, "preview", "a", options).passed, true);
  integrateRunTask(root, "preview", "a", evidence);
  assert.equal(previewRunTask(root, "preview", "b", options).conflictRecorded, true);
  const { path: worktree } = loadRun(root, "preview").tasks.b.attempts.at(-1).worktree;
  write(worktree, "a.json", "1\nkeep\nkeep\nnew last line\n");
  git(worktree, ["add", "a.json"]);
  git(worktree, ["commit", "--amend", "--no-edit", "--quiet"]);
  assert.equal(previewRunTask(root, "preview", "b", options).passed, true);
  const retried = runCli(root, ["run", "retry", "preview", "b", "--conflict", "--note", "Use latest result"]);
  assert.equal(retried.code, 1);
  assert.match(retried.stderr, /preview conflict is stale/);
  assert.equal(loadRun(root, "preview").tasks.b.status, "reported");
});

test("a successful check cannot certify a checkout that rolled back an overlapping integration", () => {
  const root = makeRepo();
  repos.push(root);
  runCli(root, ["init"]);
  addLane(root, "writes", { scope: ["*.txt"] });
  createRun(root, { id: "writes", lane: "writes", objective: "Land changes", workerModel: "sol", reasoningEffort: "high" });
  replacePlan(root, "writes", [
    { id: "first", title: "First", objective: "Edit seed", scope: ["seed.txt"], acceptance: ["Reviewed"] },
    { id: "second", title: "Second", objective: "Edit files", scope: ["*.txt"], acceptance: ["Reviewed"] }
  ]);
  checkpointPlan(root, "writes");
  for (const id of ["first", "second"]) {
    const dispatch = claimTask(root, "writes", id);
    const run = loadRun(root, "writes"), task = run.tasks[id], attempt = task.attempts.at(-1);
    const worktree = createTaskWorktree(root, run, task, attempt);
    if (id === "second") {
      write(worktree.path, "partial.txt", "first commit of the second task");
      git(worktree.path, ["add", "partial.txt"]);
      git(worktree.path, ["commit", "-qm", "first pick"]);
    }
    write(worktree.path, "seed.txt", `different content from ${id}\n`);
    git(worktree.path, ["add", "seed.txt"]);
    git(worktree.path, ["commit", "-qm", "change seed"]);
    attachExecution(root, "writes", id, { attemptId: dispatch.attemptId, worktree, runner: null });
    recordTaskResult(root, "writes", id, { attemptId: dispatch.attemptId, resultText: JSON.stringify({
      summary: "done", files_touched: id === "second" ? ["partial.txt", "seed.txt"] : ["seed.txt"],
      tests: [], decisions: [], assumptions: [], blockers: [], confidence: "high"
    }) });
  }
  integrateRunTask(root, "writes", "first", evidence);
  const head = git(root, ["rev-parse", "HEAD"]);
  const runs = new URL("../plugins/orchestrator/scripts/lib/runs.mjs", import.meta.url).href;
  addLane(root, "observer", { checks: [{ id: "combined", argv: [process.execPath, "--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    import { integrateRunTask } from ${JSON.stringify(runs)};
    assert.throws(() => integrateRunTask(process.cwd(), 'writes', 'second', {evidence:['Reviewed changes']}), /Integration conflict/);
  `] }] });
  createRun(root, { id: "observer", lane: "observer", objective: "Check", workerModel: "sol", reasoningEffort: "high" });
  replacePlan(root, "observer", [{ id: "observe", kind: "read", title: "Observe", objective: "Observe", acceptance: ["Reviewed"] }]);
  const [receipt] = runChecks(root, "observer", null, options);
  assert.equal(receipt.exitCode, 0, receipt.stderr?.text);
  assert.equal(git(root, ["rev-parse", "HEAD"]), head);
  assert.equal(fs.existsSync(path.join(root, "partial.txt")), false);
  assert.equal(receipt.changedDuringCheck, true);
  assert.equal(receipt.passed, false);
});
