import assert from "node:assert/strict";
import { after, test } from "node:test";

import { addLane } from "../plugins/orchestrator/scripts/lib/lanes.mjs";
import { createRun, replacePlan, claimTask, recordTaskResult, runChecks, verifyTask, finalizeRun } from "../plugins/orchestrator/scripts/lib/runs.mjs";
import { checkpointPlan, cleanup, makeRepo, runCli, write } from "./helpers.mjs";

const repos = [];
after(() => repos.forEach(cleanup));
// Protocol fixture only; real Codex sandbox containment is exercised separately.
const codexCommand = [process.execPath, "-e", `const {spawnSync}=require('node:child_process');const a=process.argv.slice(1);const i=a.indexOf('--');const r=spawnSync(a[i+1],a.slice(i+2),{stdio:'inherit'});process.exit(r.status??1);`, "--"];

function reported(argv) {
  const root = makeRepo();
  repos.push(root);
  assert.equal(runCli(root, ["init"]).code, 0);
  addLane(root, "review", { checks: [{ id: "test", argv }] });
  createRun(root, { id: "checks", lane: "review", objective: "Review", workerModel: "sol", reasoningEffort: "high" });
  replacePlan(root, "checks", [{ id: "review", title: "Review", objective: "Review", kind: "read", scope: ["review/**"], acceptance: ["The test passes"] }]);
  checkpointPlan(root, "checks");
  const dispatch = claimTask(root, "checks", "review");
  recordTaskResult(root, "checks", "review", { attemptId: dispatch.attemptId, resultText: JSON.stringify({
    summary: "Reviewed", files_touched: [], tests: [{ command: "invented", outcome: "passed" }],
    decisions: [], assumptions: [], blockers: [], confidence: "high"
  }) });
  return root;
}

test("required receipts cannot be replaced by worker claims and expire on dirty content changes", () => {
  const root = reported([process.execPath, "-e", "console.log('independently checked')"]);
  const accept = () => verifyTask(root, "checks", "review", { verdict: "pass", evidence: ["Reviewed the actual result"] });
  assert.throws(accept, /missing, failed, or stale/);
  const [receipt] = runChecks(root, "checks", "review", { codexCommand });
  assert.equal(receipt.passed, true);
  assert.equal(receipt.provenance, "supervisor-executed");
  assert.match(receipt.stdout.text, /independently checked/);
  write(root, "seed.txt", "new contents, same path\n");
  assert.throws(accept, /stale/);
  runChecks(root, "checks", "review", { codexCommand });
  assert.throws(() => verifyTask(root, "checks", "review", { verdict: "pass", evidence: ["none"] }), /meaningful/);
  accept();
  assert.throws(() => finalizeRun(root, "checks", { verdict: "pass", summary: "Reviewed", evidence: ["Manual review"] }), /missing, failed, or stale/);
  runChecks(root, "checks", null, { codexCommand });
  assert.equal(finalizeRun(root, "checks", { verdict: "pass", summary: "Reviewed", evidence: ["Manual review and executed test"] }).status, "completed");
});

test("nonzero and timed-out checks retain failed execution receipts", () => {
  for (const [code, timeoutSeconds] of [["process.exit(7)", 10], ["setInterval(()=>{},1000)", 0.1]]) {
    const root = reported([process.execPath, "-e", code]);
    // Timeout is part of the frozen definition, not a command supplied by a worker.
    if (timeoutSeconds === 0.1) {
      // A separate run snapshots a short timeout through the supported lane API.
      addLane(root, "timeout", { checks: [{ id: "timeout", argv: [process.execPath, "-e", code], timeoutSeconds }] });
      createRun(root, { id: "timeout", lane: "timeout", objective: "Check timeout", workerModel: "sol", reasoningEffort: "high" });
      replacePlan(root, "timeout", [{ id: "review", title: "Review", objective: "Review", kind: "read", acceptance: ["terminates"] }]);
      checkpointPlan(root, "timeout");
      const d = claimTask(root, "timeout", "review");
      recordTaskResult(root, "timeout", "review", { attemptId: d.attemptId, resultText: JSON.stringify({ summary: "done", files_touched: [], tests: [], decisions: [], assumptions: [], blockers: [], confidence: "high" }) });
    }
    const id = timeoutSeconds === 0.1 ? "timeout" : "checks";
    const [receipt] = runChecks(root, id, "review", { codexCommand });
    assert.equal(receipt.passed, false);
    if (id === "checks") assert.equal(receipt.exitCode, 7);
    else assert.match(receipt.error, /ETIMEDOUT/);
    assert.throws(() => verifyTask(root, id, "review", { verdict: "pass", evidence: ["claimed passed"] }), /missing, failed, or stale/);
  }
});

test("lane check definitions reject shell strings, missing ids, and duplicate ids", () => {
  const root = makeRepo();
  repos.push(root);
  runCli(root, ["init"]);
  for (const checks of [[{ id: "shell", argv: "node test.js" }], [{ argv: ["node"] }], [{ id: "a", argv: ["node"] }, { id: "a", argv: ["node"] }]]) {
    assert.throws(() => addLane(root, "invalid", { checks }), /argv|unique/);
  }
});

test("lane show lists checks and setup, and --clear-checks/--clear-setup remove them", () => {
  const root = makeRepo();
  repos.push(root);
  runCli(root, ["init"]);
  const added = runCli(root, ["lane", "add", "api", "--scope", "src/**",
    "--check", JSON.stringify({ id: "unit", argv: ["node", "--test"], stages: ["task"] }),
    "--setup", JSON.stringify({ argv: ["npm", "ci"], inputs: ["package-lock.json"], network: true })]);
  assert.equal(added.code, 0, added.stderr);
  const shown = runCli(root, ["lane", "show", "api"]).stdout;
  assert.match(shown, /check unit \(task, 300s\): `node --test`/);
  assert.match(shown, /setup \(300s, network enabled\): `npm ci`; inputs package-lock.json/);
  // Re-adding without the options keeps them.
  runCli(root, ["lane", "add", "api", "--done", "Tests pass"]);
  assert.equal(JSON.parse(runCli(root, ["lane", "show", "api", "--json"]).stdout).checks.length, 1);
  assert.equal(runCli(root, ["lane", "add", "api", "--clear-checks", "--clear-setup"]).code, 0);
  const cleared = JSON.parse(runCli(root, ["lane", "show", "api", "--json"]).stdout);
  assert.equal(cleared.checks, undefined);
  assert.equal(cleared.setup, undefined);
  assert.match(runCli(root, ["lane", "add", "api", "--check", "{not json"]).stderr, /--check takes a JSON object/);
});
