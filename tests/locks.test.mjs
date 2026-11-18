import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { addLane } from "../plugins/orchestrator/scripts/lib/lanes.mjs";
import {
  addCheckpoint,
  claimTask,
  createRun,
  loadRun,
  recordTaskResult,
  replacePlan,
  retryTask,
  runFile,
  takeWorktreesForRemoval
} from "../plugins/orchestrator/scripts/lib/runs.mjs";
import { launchTaskWorker, pollRunWorkers } from "../plugins/orchestrator/scripts/lib/workers.mjs";
import { checkpointPlan, cleanup, git, makeRepo, runCli, write } from "./helpers.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const lib = path.join(here, "..", "plugins", "orchestrator", "scripts", "lib");
const repos = [];
after(() => repos.forEach(cleanup));
// Protocol fixture: runs the argv after `--` directly, as `codex sandbox` would inside its sandbox.
const codexCommand = [process.execPath, "-e", `const {spawnSync}=require('node:child_process');const a=process.argv.slice(1);const i=a.indexOf('--');const r=spawnSync(a[i+1],a.slice(i+2),{stdio:'inherit'});process.exit(r.status??1);`, "--"];

function scratch() {
  return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "orch-lock-"));
}

// A command that announces it started, then waits until the test releases it.
function gated(dir) {
  const started = path.join(dir, "started");
  const release = path.join(dir, "release");
  const argv = [process.execPath, "-e",
    `const fs=require('fs');fs.writeFileSync(${JSON.stringify(started)},'');` +
    `const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){clearInterval(t)}},20)`];
  return { argv, started, release };
}

async function until(predicate, label, ms = 20000) {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

// Run a library call in another process, as a separate CLI invocation would.
function inChild(source) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", source], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const done = new Promise((resolve) => child.on("exit", (code) => resolve({ code, stderr })));
  return { child, done };
}

function readTask(root, runId, taskId) {
  const dispatch = claimTask(root, runId, taskId);
  recordTaskResult(root, runId, taskId, { attemptId: dispatch.attemptId, resultText: JSON.stringify({
    summary: "Reviewed", files_touched: [], tests: [], decisions: [], assumptions: [], blockers: [], confidence: "high"
  }) });
}

test("a long check does not hold the run lock: other commands proceed and the receipt is still saved", async () => {
  const root = makeRepo();
  repos.push(root);
  const dir = scratch();
  repos.push(dir);
  assert.equal(runCli(root, ["init"]).code, 0);
  const gate = gated(dir);
  addLane(root, "review", { checks: [{ id: "slow", argv: gate.argv, timeoutSeconds: 60 }] });
  createRun(root, { id: "lk", lane: "review", objective: "Review", workerModel: "sol", reasoningEffort: "high" });
  replacePlan(root, "lk", [{ id: "r", title: "r", objective: "r", kind: "read", scope: ["docs/**"], acceptance: ["Reviewed"] }]);
  checkpointPlan(root, "lk");
  readTask(root, "lk", "r");
  const { done } = inChild(
    `import { runChecks } from ${JSON.stringify(path.join(lib, "runs.mjs"))};` +
    `runChecks(${JSON.stringify(root)}, "lk", "r", { codexCommand: ${JSON.stringify(codexCommand)} });`
  );
  await until(() => fs.existsSync(gate.started), "the check to start");
  const startedAt = Date.now();
  addCheckpoint(root, "lk", { summary: "Concurrent supervisor command during a check" });
  assert.ok(Date.now() - startedAt < 2000, "the checkpoint did not wait for the check");
  fs.writeFileSync(gate.release, "");
  const result = await done;
  assert.equal(result.code, 0, result.stderr);
  const run = loadRun(root, "lk");
  assert.equal(run.checkReceipts.length, 1);
  assert.equal(run.checkReceipts[0].passed, true);
  assert.equal(run.checkpoints.at(-1).summary, "Concurrent supervisor command during a check");
});

function setupRepo(dir, setupArgv) {
  const root = makeRepo();
  repos.push(root);
  assert.equal(runCli(root, ["init"]).code, 0);
  write(root, ".gitignore", "node_modules/\n");
  write(root, "lock.json", "{}\n");
  addLane(root, "api", { scope: ["src/**"], setup: { argv: setupArgv, inputs: ["lock.json"], timeoutSeconds: 60 } });
  git(root, ["add", "-A"]);
  git(root, ["commit", "-qm", "project setup"]);
  createRun(root, { id: "setup", lane: "api", objective: "Implement", workerModel: "sol", reasoningEffort: "high" });
  replacePlan(root, "setup", [{ id: "build", title: "Build", objective: "Build", acceptance: ["works"] }]);
  checkpointPlan(root, "setup");
  return root;
}

test("worktree setup does not hold the run lock while it runs", async () => {
  const dir = scratch();
  repos.push(dir);
  const gate = gated(dir);
  const root = setupRepo(dir, gate.argv);
  // `codex sandbox ... -- argv` runs argv (setup); any other call is the worker, which just exits.
  const fakeCodex = path.join(dir, "codex.cjs");
  fs.writeFileSync(fakeCodex, "const a=process.argv.slice(2);if(a[0]==='sandbox'){const i=a.indexOf('--');" +
    "const r=require('child_process').spawnSync(a[i+1],a.slice(i+2),{stdio:'inherit'});process.exit(r.status??1)}");
  const { done } = inChild(
    `import { launchTaskWorker } from ${JSON.stringify(path.join(lib, "workers.mjs"))};` +
    `try { launchTaskWorker(${JSON.stringify(root)}, "setup", "build", {}, { codexCommand: ${JSON.stringify([process.execPath, fakeCodex])} }); } catch (e) { console.error(e.message); }`
  );
  await until(() => fs.existsSync(gate.started), "setup to start");
  const during = loadRun(root, "setup").tasks.build.attempts.at(-1).worktree;
  assert.ok(during.setupPending, "the setup intent is saved before setup runs");
  assert.equal(during.setupPending.launcherPid > 0, true);
  const startedAt = Date.now();
  addCheckpoint(root, "setup", { summary: "Concurrent command during setup" });
  assert.ok(Date.now() - startedAt < 2000, "the checkpoint did not wait for setup");
  fs.writeFileSync(gate.release, "");
  await done;
  const worktree = loadRun(root, "setup").tasks.build.attempts.at(-1).worktree;
  assert.equal(worktree.setup.passed, true);
  assert.equal(worktree.setupPending, undefined);
});

test("a launch killed during setup is collected as setup_failed and its worktree is preserved until released", async () => {
  const dir = scratch();
  repos.push(dir);
  const gate = gated(dir);
  const root = setupRepo(dir, gate.argv);
  const { child, done } = inChild(
    `import { launchTaskWorker } from ${JSON.stringify(path.join(lib, "workers.mjs"))};` +
    `launchTaskWorker(${JSON.stringify(root)}, "setup", "build", {}, { codexCommand: ${JSON.stringify(codexCommand)} });`
  );
  await until(() => fs.existsSync(gate.started), "setup to start");
  // A Bash timeout kills the launch; the detached setup command keeps running.
  child.kill("SIGKILL");
  await done;
  assert.equal(loadRun(root, "setup").tasks.build.status, "dispatching");
  const updates = pollRunWorkers(root, "setup");
  assert.equal(updates[0].status, "failed");
  const failed = loadRun(root, "setup").tasks.build.attempts.at(-1);
  assert.equal(failed.outcome.reasonCode, "setup_failed");
  assert.ok(failed.worktree.setupPending, "the interrupted setup stays marked");

  // Retrying into the same worktree would start a second setup over the first.
  retryTask(root, "setup", "build");
  checkpointPlan(root, "setup");
  assert.throws(() => launchTaskWorker(root, "setup", "build", {}, { codexCommand }), /interrupted and may still be running/);

  const detach = () => null;
  const kept = takeWorktreesForRemoval(root, "setup", null, detach);
  assert.equal(kept.taken.length, 0);
  assert.match(kept.refused[0].error, /--release-uncertain/);
  fs.writeFileSync(gate.release, "");
  const released = takeWorktreesForRemoval(root, "setup", null, detach, () => false, { releaseUncertain: true });
  assert.equal(released.refused.length, 0);
  assert.ok(released.taken.length >= 1);
});

test("cleanup settles a preview's uncertain check once its process group is gone, never before", async () => {
  const root = makeRepo();
  repos.push(root);
  assert.equal(runCli(root, ["init"]).code, 0);
  createRun(root, { id: "pv", lane: "api", objective: "Preview", workerModel: "sol", reasoningEffort: "high" });
  const sleeper = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { detached: true, stdio: "ignore" });
  const file = runFile(root, "pv");
  const state = JSON.parse(fs.readFileSync(file, "utf8"));
  state.previews = [
    { id: "preview-a", taskId: "t", status: "failed", mayBeRunning: true, worktree: { path: path.join(root, "nowhere-a") },
      checks: [{ terminationUncertain: true, processGroup: sleeper.pid }] },
    { id: "preview-b", taskId: "t", status: "failed", mayBeRunning: true, unknownProcess: true, worktree: { path: path.join(root, "nowhere-b") }, checks: [] },
    { id: "preview-c", taskId: "t", status: "checking", owner: { pid: 999999 }, worktree: { path: path.join(root, "nowhere-c") }, checks: [] }
  ];
  fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
  const detach = () => null;
  try {
    const first = takeWorktreesForRemoval(root, "pv", null, detach);
    assert.deepEqual(first.refused.map((entry) => entry.attemptId).sort(), ["preview-a", "preview-b", "preview-c"]);
  } finally {
    // Reap the leader: an unreaped zombie still counts as a group member.
    const exited = new Promise((resolve) => sleeper.once("exit", resolve));
    process.kill(-sleeper.pid, "SIGKILL");
    await exited;
  }
  await until(() => { try { process.kill(-sleeper.pid, 0); return false; } catch (error) { return error.code === "ESRCH"; } }, "the group to exit");
  const second = takeWorktreesForRemoval(root, "pv", null, detach);
  assert.deepEqual(second.taken.map((entry) => entry.attempt.id), ["preview-a"]);
  assert.deepEqual(second.refused.map((entry) => entry.attemptId).sort(), ["preview-b", "preview-c"]);
  const third = takeWorktreesForRemoval(root, "pv", null, detach, () => false, { releaseUncertain: true });
  assert.equal(third.refused.length, 0);
});
