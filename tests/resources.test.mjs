import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { BoundedLog } from "../plugins/orchestrator/scripts/lib/bounded-log.mjs";
import { executeCheck } from "../plugins/orchestrator/scripts/lib/checks.mjs";
import { attemptProgress, dispatchBudgetStatus, schedulingAdvice } from "../plugins/orchestrator/scripts/lib/run-insights.mjs";
import { claimTask, createRun, loadRun, replacePlan, verifyTask, recordTaskResult, renderSupervisorBriefing } from "../plugins/orchestrator/scripts/lib/runs.mjs";
import { launchTaskWorker, pollRunWorkers, stopTaskWorker } from "../plugins/orchestrator/scripts/lib/workers.mjs";
import { checkpointPlan, cleanup, makeRepo, runCli } from "./helpers.mjs";

const roots = [];
after(() => roots.forEach(cleanup));
const codexCommand = [process.execPath, "-e", "const{spawnSync}=require('node:child_process');const a=process.argv.slice(1),i=a.indexOf('--');const r=spawnSync(a[i+1],a.slice(i+2),{stdio:'inherit'});process.exit(r.status??1)", "--"];

test("noisy capture stays bounded with visible truncation and the chosen head or tail", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orch-output-"));
  roots.push(root);
  for (const tail of [false, true]) {
    const file = path.join(root, String(tail));
    const capture = new BoundedLog(file, { limitBytes: 1024, tail });
    capture.write("start");
    for (let i = 0; i < 40; i++) capture.write(Buffer.alloc(1000, "x"));
    capture.write("finish");
    await new Promise((resolve) => capture.end(resolve));
    const text = fs.readFileSync(file, "utf8");
    assert.match(text, /output truncated/);
    assert.equal(capture.observedBytes, 40011);
    // Both modes keep the end, where a failing process reports its error.
    assert.ok(text.endsWith("finish"));
    if (tail) { assert.ok(fs.statSync(file).size <= 1024); assert.ok(!text.includes("start")); }
    else { assert.ok(text.startsWith("start")); assert.ok(fs.statSync(file).size <= 1024 + 64 * 1024); }
  }
});

test("trusted checks fail explicitly at output limits and retain a bounded tail below the limit", () => {
  const root = makeRepo(); roots.push(root);
  const argv = [process.execPath, "-e", "process.stdout.write('a'.repeat(200000)+'finish')"];
  const normal = executeCheck(root, { argv, maxOutputBytes: 300000 }, { codexCommand });
  assert.equal(normal.passed, true, normal.error);
  assert.ok(normal.stdout.text.endsWith("finish"));
  assert.equal(normal.stdout.truncated, true);
  assert.ok(Buffer.byteLength(normal.stdout.text) <= 32768);
  const exceeded = executeCheck(root, { argv, maxOutputBytes: 1024 }, { codexCommand });
  assert.equal(exceeded.passed, false);
  assert.match(exceeded.error, /exceeded maxOutputBytes/);
  assert.ok(Buffer.byteLength(exceeded.stdout.text) <= 32768);
  // A descendant holding the pipes open does not keep the check alive until its timeout.
  const started = Date.now();
  const held = executeCheck(root, { argv: ["/bin/sh", "-c", "sleep 30 & yes"], timeoutSeconds: 20, maxOutputBytes: 1024 }, { codexCommand });
  assert.equal(held.passed, false);
  assert.match(held.error, /exceeded maxOutputBytes/);
  assert.ok(Date.now() - started < 10000, `stopped after ${Date.now() - started} ms`);
});

test("a noisy worker drains oversized event lines, retains its final report, and publishes bounded capture", async () => {
  const root = makeRepo(); roots.push(root);
  runCli(root, ["init"]);
  runCli(root, ["lane", "add", "work", "--scope", "src/**"]);
  createRun(root, { id: "noisy", lane: "work", objective: "Capture", workerModel: "sol", reasoningEffort: "high" });
  replacePlan(root, "noisy", [{ id: "task", title: "Task", objective: "Observe", scope: ["src/**"], acceptance: ["Valid final report"] }]);
  checkpointPlan(root, "noisy");
  const fixture = path.join(root, ".orchestrator/local/noisy.mjs");
  fs.writeFileSync(fixture, `import fs from 'node:fs';
process.stdin.resume();
process.stdin.on('end', async () => {
  const chunk = 'x'.repeat(65536);
  for (let i = 0; i < 145; i++) {
    for (const stream of [process.stdout, process.stderr]) {
      if (!stream.write(chunk)) await new Promise(resolve => stream.once('drain', resolve));
    }
  }
  process.stdout.write('\\n'+JSON.stringify({type:'thread.started',thread_id:'thread-after-noise'})+'\\n');
  fs.writeFileSync(process.argv[process.argv.indexOf('--output-last-message')+1], JSON.stringify({
    summary:'Finished after noise',files_touched:[],tests:[],decisions:[],assumptions:[],blockers:[],confidence:'high'
  }));
});`);
  launchTaskWorker(root, "noisy", "task", {}, { codexCommand: [process.execPath, fixture] });
  try {
    const deadline = Date.now() + 30000;
    let update;
    do {
      await new Promise((resolve) => setTimeout(resolve, 50));
      update = pollRunWorkers(root, "noisy")[0];
    } while (Date.now() < deadline && ["dispatching", "running"].includes(update?.status));
    const task = loadRun(root, "noisy").tasks.task;
    assert.equal(task.status, "reported", JSON.stringify(update));
    assert.equal(task.result.structured.summary, "Finished after noise");
    const attempt = task.attempts.at(-1);
    assert.equal(attempt.threadId, "thread-after-noise");
    assert.equal(attempt.runner.capture.stdoutTruncated, true);
    assert.equal(attempt.runner.capture.stderrTruncated, true);
    assert.ok(attempt.runner.capture.observedBytes > 18 * 1024 * 1024);
    assert.ok(attempt.runner.lastOutputAt);
    const spec = JSON.parse(fs.readFileSync(attempt.runner.specFile, "utf8"));
    assert.equal(attempt.runner.capture.limitBytesPerStream, 8 * 1024 * 1024 + 64 * 1024);
    for (const file of [spec.outputFile, spec.errorFile]) {
      assert.equal(fs.statSync(file).size, attempt.runner.capture.limitBytesPerStream);
      assert.match(fs.readFileSync(file, "utf8").slice(-(64 * 1024 + 100)), /output truncated/);
    }
    // The end of the stream survives truncation, so failure diagnosis still sees it.
    assert.match(fs.readFileSync(spec.outputFile, "utf8").slice(-200), /thread-after-noise/);
  } finally { stopTaskWorker(loadRun(root, "noisy").tasks.task.attempts.at(-1)); }
});

test("dispatch budgets count retired attempts, distinguish missing tokens, and enforce boundary equality", () => {
  const run = { createdAt: "2026-01-01T00:00:00Z", tasks: { a: { attempts: [{}] } }, retiredTasks: [{ attempts: [{}] }],
    budgets: { maxAttempts: 3, maxElapsedMinutes: 2, maxWorkerTokens: 100 } };
  const nowMs = Date.parse(run.createdAt) + 119999;
  const below = dispatchBudgetStatus(run, { nowMs, usage: { measured: 1, unmeasured: 1, tokens: { input: 79, output: 20 } } });
  assert.deepEqual(below.blocked, []);
  assert.equal(below.attempts, 2);
  const boundary = dispatchBudgetStatus(run, { nowMs: nowMs + 1, usage: { measured: 1, unmeasured: 1, tokens: { input: 80, output: 20 } } });
  assert.equal(boundary.blocked.length, 2);
  assert.deepEqual(boundary.usageCoverage, { measured: 1, missing: 1 });
  assert.equal(dispatchBudgetStatus(run, { nowMs }).workerTokens, null);
});

test("CLI limits stop claims until explicitly revised; focused briefings preserve selected authority", () => {
  const root = makeRepo(); roots.push(root);
  runCli(root, ["init"]);
  runCli(root, ["lane", "add", "work"]);
  createRun(root, { id: "resources", lane: "work", objective: "Observe", workerModel: "sol", reasoningEffort: "high" });
  replacePlan(root, "resources", ["a", "b"].map((id) => ({ id, title: id, objective: id, kind: "read", scope: [id], acceptance: [`accept ${id}`] })));
  checkpointPlan(root, "resources");
  assert.equal(runCli(root, ["run", "budget", "resources", "--max-attempts", "1"]).code, 0);
  const first = claimTask(root, "resources", "a");
  recordTaskResult(root, "resources", "a", { attemptId: first.attemptId, resultText: JSON.stringify({ summary: "Ready", files_touched: [], tests: [], decisions: [], assumptions: [], blockers: [], confidence: "high" }) });
  verifyTask(root, "resources", "a", { verdict: "pass", evidence: ["Independently reviewed"] });
  assert.throws(() => claimTask(root, "resources", "b"), /Dispatch budget: maxAttempts reached/);
  assert.equal(JSON.parse(runCli(root, ["run", "ready", "resources", "--json"]).stdout).tasks.length, 0);
  const run = loadRun(root, "resources");
  const full = renderSupervisorBriefing(root, run, {});
  const focused = renderSupervisorBriefing(root, run, {}, { taskId: "b" });
  assert.ok(focused.length < full.length);
  assert.match(focused, /accept b/);
  assert.match(focused, /scope: b/);
  assert.match(focused, /other task details omitted, not waived/);
  assert.doesNotMatch(focused, /accept a/);
  assert.equal(runCli(root, ["run", "budget", "resources", "--max-attempts", "2"]).code, 0);
  assert.equal(claimTask(root, "resources", "b").taskId, "b");
});

test("scheduling advice counts shared descendants once without making dependencies ready", () => {
  const tasks = Object.fromEntries([
    ["a-leaf", []], ["z-root", []], ["left", ["z-root"]], ["right", ["z-root"]], ["join", ["left", "right"]]
  ].map(([id, dependsOn]) => [id, { id, dependsOn, status: "pending" }]));
  assert.deepEqual(schedulingAdvice({ tasks }), [{ taskId: "z-root", unlocks: 3 }, { taskId: "a-leaf", unlocks: 0 }]);
});

test("active time excludes answered and outstanding pauses, not quiet work", () => {
  const attempt = { startedAt: "2026-01-01T00:00:00Z", inputRequests: [
    { requestedAt: "2026-01-01T00:00:10Z", answer: { answeredAt: "2026-01-01T00:00:27Z" } },
    { requestedAt: "2026-01-01T00:00:50Z" }
  ] };
  const progress = attemptProgress(attempt, Date.parse("2026-01-01T00:01:00Z"));
  assert.equal(progress.activeMs, 33000);
  assert.equal(progress.awaitingAnswerMs, 27000);
  assert.equal(progress.lastOutputAt, null);
});
