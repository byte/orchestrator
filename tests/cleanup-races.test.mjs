import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { setTimeout } from "node:timers/promises";

import { addLane } from "../plugins/orchestrator/scripts/lib/lanes.mjs";
import { attachExecution, cancelTask, claimTask, createRun, loadRun, recordTaskResult, replacePlan, retryTask } from "../plugins/orchestrator/scripts/lib/runs.mjs";
import { createTaskWorktree } from "../plugins/orchestrator/scripts/lib/worktrees.mjs";
import { launchTaskWorker } from "../plugins/orchestrator/scripts/lib/workers.mjs";
import { checkpointPlan, cleanup, git, makeRepo, runCli, write } from "./helpers.mjs";

const roots = [];
after(() => roots.forEach(cleanup));
// Protocol-only forwarder, not a claim of sandbox containment.
const codexCommand = [process.execPath, "-e", "const{spawnSync}=require('node:child_process');const a=process.argv.slice(1),i=a.indexOf('--');const r=spawnSync(a[i+1],a.slice(i+2),{stdio:'inherit'});process.exit(r.status??1)", "--"];
const runsUrl = new URL("../plugins/orchestrator/scripts/lib/runs.mjs", import.meta.url).href;
const workersUrl = new URL("../plugins/orchestrator/scripts/lib/workers.mjs", import.meta.url).href;

function fixture() {
  const root = makeRepo(), gate = fs.mkdtempSync(path.join(os.tmpdir(), "orch-gate-"));
  roots.push(root, gate);
  runCli(root, ["init"]);
  const script = `const fs=require('fs'),p=${JSON.stringify(gate)};if(!fs.existsSync(p+'/enabled'))process.exit(17);fs.writeFileSync(p+'/started','');const t=setInterval(()=>{if(fs.existsSync(p+'/release')){clearInterval(t);process.exit(0)}},20)`;
  write(root, "gate.cjs", script);
  git(root, ["add", "gate.cjs"]);
  git(root, ["commit", "-qm", "gate"]);
  return { root, gate, script };
}

function plan(root, options) {
  addLane(root, "work", { scope: ["src/**"], ...options });
  createRun(root, { id: "race", lane: "work", objective: "Keep active evidence", workerModel: "sol", reasoningEffort: "high" });
  replacePlan(root, "race", [{ id: "build", title: "Build", objective: "Build", acceptance: ["checked"] }]);
  checkpointPlan(root, "race");
}

async function gated(gate, source, action) {
  let output = "";
  const child = spawn(process.execPath, ["--input-type=module", "-e", source], { stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const exited = new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", (code) => resolve(code)); });
  try {
    const deadline = Date.now() + 20000;
    while (!fs.existsSync(path.join(gate, "started"))) {
      if (child.exitCode !== null || Date.now() > deadline) throw new Error(`gate did not start: ${output}`);
      await setTimeout(20);
    }
    await action();
  } finally {
    write(gate, "release", "go");
    assert.equal(await exited, 0, output);
  }
}

test("cleanup protects every alias of a cancelled warm retry's running setup", async () => {
  const { root, gate } = fixture();
  plan(root, { setup: { argv: [process.execPath, "gate.cjs"], inputs: ["gate.cjs"] } });
  assert.throws(() => launchTaskWorker(root, "race", "build", {}, { codexCommand }), /setup failed/);
  const worktree = loadRun(root, "race").tasks.build.attempts[0].worktree.path;
  retryTask(root, "race", "build");
  checkpointPlan(root, "race");
  write(gate, "enabled", "go");
  await gated(gate, `import{launchTaskWorker}from${JSON.stringify(workersUrl)};try{launchTaskWorker(${JSON.stringify(root)},'race','build',{},${JSON.stringify({ codexCommand })});process.exitCode=1}catch(e){if(!/no longer dispatching/i.test(e.message))throw e}`, () => {
    cancelTask(root, "race", "build");
    const result = runCli(root, ["run", "cleanup", "race", "--json"]);
    assert.equal(result.code, 1, result.stdout);
    assert.equal(fs.existsSync(worktree), true);
    assert.match(result.stdout + result.stderr, /Setup is still in progress/);
  });
  const attempt = loadRun(root, "race").tasks.build.attempts[1];
  assert.equal(attempt.worktree.setup.passed, true);
  assert.equal(attempt.worktree.setupPending, undefined);
});

test("cancelled checks retain their directory until their receipt is saved", async () => {
  const { root, gate } = fixture();
  plan(root, { checks: [{ id: "gate", argv: [process.execPath, "gate.cjs"] }] });
  write(gate, "enabled", "go");
  const claimed = claimTask(root, "race", "build");
  const run = loadRun(root, "race"), task = run.tasks.build;
  const worktree = createTaskWorktree(root, run, task, task.attempts[0]);
  attachExecution(root, "race", "build", { attemptId: claimed.attemptId, worktree, runner: null });
  recordTaskResult(root, "race", "build", { attemptId: claimed.attemptId, resultText: JSON.stringify({ summary: "Ready", files_touched: [], tests: [], decisions: [], assumptions: [], blockers: [], confidence: "high" }) });
  await gated(gate, `import{runChecks}from${JSON.stringify(runsUrl)};runChecks(${JSON.stringify(root)},'race','build',${JSON.stringify({ codexCommand })})`, () => {
    cancelTask(root, "race", "build");
    const result = runCli(root, ["run", "cleanup", "race", "--json"]);
    assert.equal(result.code, 1, result.stdout);
    assert.equal(fs.existsSync(worktree.path), true);
    assert.match(result.stdout + result.stderr, /Check is still in progress/);
  });
  const saved = loadRun(root, "race");
  assert.equal(saved.checkReceipts.length, 1);
  assert.equal(saved.checkReceipts[0].passed, true);
  assert.equal(runCli(root, ["run", "cleanup", "race"]).code, 0);
  assert.equal(fs.existsSync(worktree.path), false);
});
