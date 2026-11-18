import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_TASK_TIMEOUT_MINUTES,
  createRun,
  eventsFile,
  loadRun,
  renderSupervisorBriefing,
  replacePlan,
  retryTask,
  runFile,
  taskTimeoutMinutes,
  verifyTask
} from "../plugins/orchestrator/scripts/lib/runs.mjs";
import { atomicWrite } from "../plugins/orchestrator/scripts/lib/state.mjs";
import { WAIT_EXIT_CODES, waitForRunChange } from "../plugins/orchestrator/scripts/lib/wait.mjs";
import { launchTaskWorker, pollRunWorkers, stopTaskWorker } from "../plugins/orchestrator/scripts/lib/workers.mjs";
import { CLI, checkpointPlan, cleanup, makeRepo, runCli } from "./helpers.mjs";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const fastFixture = path.join(fixtures, "fake-codex.mjs");
const slowFixture = path.join(fixtures, "fake-codex-slow.mjs");
const askFixture = path.join(fixtures, "fake-codex-ask.mjs");
const resumeFixture = path.join(fixtures, "fake-codex-resume.mjs");
const unavailableFixture = path.join(fixtures, "fake-codex-model-unavailable.mjs");
const lane = { constraints: [] };
const repos = [];
const stragglers = [];

// Long enough that a test passing within it proves the file watch woke the wait,
// short enough that a broken watch still fails the test rather than hanging it.
const NO_FALLBACK_MS = 60000;

/**
 * Whether fs.watch delivers events for a directory under the temp root here.
 * Inside Codex's macOS seatbelt a watch can fail (EMFILE under `codex sandbox`)
 * or deliver nothing, and `run wait` then wakes on its interval instead; in
 * other sandboxed runs it works. The tests that prove a *watch* woke the wait
 * cannot pass where it fails, so inside the sandbox they are skipped, with this
 * reason, only when the probe shows the watch is not delivering.
 */
async function watchDelivers() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "orch-watch-probe-"));
  let watcher = null;
  let writer = null;
  let timer = null;
  try {
    return await new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), 2000);
      try {
        // Only the probe's own file counts: macOS can report a stale event for a
        // directory created a moment ago.
        watcher = fs.watch(directory, (_event, filename) => {
          if (String(filename ?? "") === "probe") {
            resolve(true);
          }
        });
        watcher.on("error", () => resolve(false));
      } catch {
        resolve(false);
        return;
      }
      writer = setTimeout(() => fs.writeFileSync(path.join(directory, "probe"), "x"), 50);
    });
  } finally {
    clearTimeout(timer);
    clearTimeout(writer);
    watcher?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
// Skipped only inside a Codex sandbox (which sets CODEX_SANDBOX): anywhere else a
// watch that delivers nothing is a real failure, not something to skip, and a
// slow probe on a loaded host must not quietly drop these tests.
const WATCH_SKIP = process.env.CODEX_SANDBOX && !(await watchDelivers())
  ? `fs.watch is not delivering file events inside the Codex sandbox (CODEX_SANDBOX=${process.env.CODEX_SANDBOX})`
  : false;

function repo() {
  const root = makeRepo();
  repos.push(root);
  runCli(root, ["init"]);
  runCli(root, ["lane", "add", "api", "--scope", "src/**"]);
  return root;
}

after(() => {
  for (const attempt of stragglers) {
    stopTaskWorker(attempt);
  }
  for (const root of repos) {
    cleanup(root);
  }
});

function plan(root, id, tasks = [{ id: "work" }], { model = "sol" } = {}) {
  createRun(root, { id, lane: "api", objective: "Wait for workers", maxWorkers: 3, workerModel: model, reasoningEffort: "high" });
  replacePlan(root, id, tasks.map((task) => ({
    title: task.id,
    objective: `Do ${task.id}`,
    kind: "read",
    acceptance: ["the supervisor accepts it"],
    ...task
  })));
  checkpointPlan(root, id);
}

function launch(root, runId, taskId, codexCommand) {
  return launchTaskWorker(root, runId, taskId, lane, { codexCommand });
}

/** Stop a still-running worker when the test file ends. */
function reap(root, runId, taskId) {
  stragglers.push(loadRun(root, runId).tasks[taskId].attempts.at(-1));
}

function events(root, runId) {
  return fs.readFileSync(eventsFile(root, runId), "utf8")
    .split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function waitForStatus(statusFile, wanted) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000;
    const tick = () => {
      try {
        if (JSON.parse(fs.readFileSync(statusFile, "utf8")).status === wanted) {
          return resolve();
        }
      } catch {
        // Not written yet.
      }
      return Date.now() > deadline ? reject(new Error(`${statusFile} never became ${wanted}`)) : setTimeout(tick, 20);
    };
    tick();
  });
}

/** Run the CLI asynchronously, so a blocking `run wait` does not freeze the test runner. */
function runCliAsync(root, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd: root });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("run wait wakes on a file event when a slow worker completes, with the poll payload", { skip: WATCH_SKIP }, async () => {
  const root = repo();
  plan(root, "run-wake");
  launch(root, "run-wake", "work", [process.execPath, slowFixture, "--delay=500", "--complete"]);
  const started = Date.now();
  const result = await waitForRunChange(root, "run-wake", { timeoutMs: 15000, intervalMs: NO_FALLBACK_MS });
  assert.equal(result.outcome, "changed");
  assert.equal(result.exitCode, WAIT_EXIT_CODES.changed);
  assert.equal(result.wakeSource, "watch");
  // wakeSource already proves the watch woke it. The bound only has to sit well
  // under the 60-second fallback; a tight one failed under full-suite CPU load.
  assert.ok(Date.now() - started < NO_FALLBACK_MS / 2, "woken by the status file, not a fallback poll");
  const [update] = result.updates;
  assert.equal(update.taskId, "work");
  assert.equal(update.status, "reported");
  assert.equal(update.changed, true);
  assert.equal(update.threadId, "thread-slow");
  assert.match(result.message, /run-wake changed: work reported/);
  // The wait already collected the result, exactly as `run poll` would have.
  assert.match(loadRun(root, "run-wake").tasks.work.result.structured.summary, /Slow worker finished/);
});

test("with no file events, the fallback interval still wakes the wait", async () => {
  const root = repo();
  plan(root, "run-fallback");
  launch(root, "run-fallback", "work", [process.execPath, slowFixture, "--delay=400", "--complete"]);
  const result = await waitForRunChange(root, "run-fallback", { timeoutMs: 15000, intervalMs: 150, watch: false });
  assert.equal(result.outcome, "changed");
  assert.equal(result.wakeSource, "interval");
  assert.ok(result.polls > 1);
  assert.equal(result.updates[0].status, "reported");
});

test("a change already on disk when the wait starts returns at once", async () => {
  const root = repo();
  plan(root, "run-pending");
  const launched = launch(root, "run-pending", "work", [process.execPath, fastFixture]);
  await waitForStatus(launched.runner.statusFile, "completed");
  const result = await waitForRunChange(root, "run-pending", { timeoutMs: 15000, intervalMs: NO_FALLBACK_MS });
  assert.equal(result.outcome, "changed");
  assert.equal(result.wakeSource, "start");
  assert.equal(result.polls, 1);
  assert.equal(result.updates[0].status, "reported");
});

test("run wait times out with its own exit code while a worker keeps running", async () => {
  const root = repo();
  plan(root, "run-timeout");
  launch(root, "run-timeout", "work", [process.execPath, slowFixture, "--delay=10000"]);
  reap(root, "run-timeout", "work");
  const result = await waitForRunChange(root, "run-timeout", { timeoutMs: 400, intervalMs: 100 });
  assert.equal(result.outcome, "timeout");
  assert.equal(result.exitCode, 2);
  assert.match(result.message, /timed out after \d+s with no state change; still running: work/);
  assert.equal(result.updates[0].status, "running");
  assert.equal(result.updates[0].changed, undefined);
  assert.equal(loadRun(root, "run-timeout").tasks.work.status, "running");
});

test("run wait exits at once when nothing is active", async () => {
  const root = repo();
  plan(root, "run-idle");
  const result = await waitForRunChange(root, "run-idle", { timeoutMs: 15000, intervalMs: NO_FALLBACK_MS });
  assert.equal(result.outcome, "idle");
  assert.equal(result.exitCode, 3);
  assert.deepEqual(result.updates, []);
  assert.match(result.message, /no active workers in run-idle/);
});

test("an over-limit worker is reported once and left running", async () => {
  const root = repo();
  // 0.01 minutes is 600 ms.
  plan(root, "run-limit", [{ id: "work", timeoutMinutes: 0.01 }, { id: "other" }]);
  assert.equal(loadRun(root, "run-limit").tasks.work.timeoutMinutes, 0.01);
  const launched = launch(root, "run-limit", "work", [process.execPath, slowFixture, "--delay=10000"]);
  reap(root, "run-limit", "work");
  const deadline = Date.parse(launched.runner.launchedAt) + 0.01 * 60000;
  const beforeDeadline = Date.now() < deadline - 100;

  // No watching and a 60 s fallback: only the deadline timer can wake this wait
  // in time, which is what reports a worker whose files have gone quiet.
  const result = await waitForRunChange(root, "run-limit", {
    timeoutMs: 15000,
    intervalMs: NO_FALLBACK_MS,
    watch: false
  });
  assert.equal(result.outcome, "changed");
  // On a heavily loaded machine the launch can already be past its limit when
  // the wait starts; the first poll then reports it instead of the timer.
  assert.equal(result.wakeSource, beforeDeadline ? "limit" : result.wakeSource);
  assert.ok(["limit", "start"].includes(result.wakeSource));
  const [update] = result.updates;
  assert.equal(update.status, "running");
  assert.equal(update.changed, true);
  assert.equal(update.overLimit.timeoutMinutes, 0.01);
  assert.ok(update.overLimit.elapsedMinutes >= 0.01);
  assert.match(result.message, /work is over its 0\.01-minute limit .*still running, not stopped/);

  // Reported, not killed: the worker and the task are still running.
  const run = loadRun(root, "run-limit");
  const attempt = run.tasks.work.attempts.at(-1);
  assert.equal(run.tasks.work.status, "running");
  assert.equal(attempt.outcome ?? null, null);
  assert.equal(JSON.parse(fs.readFileSync(attempt.runner.statusFile, "utf8")).status, "running");
  assert.doesNotThrow(() => process.kill(attempt.runner.pid, 0));
  assert.equal(events(root, "run-limit").filter((event) => event.type === "task.over_limit").length, 1);
  assert.match(renderSupervisorBriefing(root, run, lane), /wall-clock limit: 0\.01 min \(planned\) — OVER LIMIT/);

  // It is surfaced once: the next wait does not wake for it again, while every
  // poll still shows the flag.
  const again = await waitForRunChange(root, "run-limit", { timeoutMs: 300, intervalMs: 100 });
  assert.equal(again.outcome, "timeout");
  assert.ok(again.updates[0].overLimit);
  const polled = runCli(root, ["run", "poll", "run-limit"]);
  assert.match(polled.stdout, /work\trunning\tOVER LIMIT: running [\d.]+ min against a 0\.01-minute limit/);

  // Killing stays the supervisor's decision, through the existing cancel path.
  assert.equal(runCli(root, ["run", "cancel", "run-limit", "work"]).code, 0);
  assert.equal(loadRun(root, "run-limit").tasks.work.status, "cancelled");
});

test("limits default per model tier and plans validate timeoutMinutes", () => {
  assert.deepEqual(
    ["gpt-6.2-astra", "gpt-6.2-sol", "gpt-6.1-terra", "gpt-5.6-luna"].map((model) => DEFAULT_TASK_TIMEOUT_MINUTES[model]),
    [120, 90, 60, 30]
  );
  // The limit follows the model the attempt actually runs on.
  assert.equal(taskTimeoutMinutes({ model: "gpt-6.2-astra" }, { model: "gpt-6.2-sol" }), 90);
  assert.equal(taskTimeoutMinutes({ model: "gpt-6.2-astra", timeoutMinutes: 15 }, { model: "gpt-6.2-sol" }), 15);
  assert.equal(taskTimeoutMinutes({ model: "gpt-5.6-terra" }), 60);

  const root = repo();
  createRun(root, { id: "run-bad-limit", lane: "api", objective: "x", workerModel: "sol", reasoningEffort: "high" });
  for (const timeoutMinutes of [0, -5, "soon", 100000]) {
    assert.throws(
      () => replacePlan(root, "run-bad-limit", [{ id: "a", title: "a", objective: "a", kind: "read", timeoutMinutes }]),
      /timeoutMinutes must be a positive number of minutes/
    );
  }
  replacePlan(root, "run-bad-limit", [{ id: "a", title: "a", objective: "a", kind: "read", acceptance: ["Report reviewed findings"] }]);
  assert.equal(Object.hasOwn(loadRun(root, "run-bad-limit").tasks.a, "timeoutMinutes"), false);
});

test("a paused worker wakes the wait, and a wait with only paused workers returns at once", async () => {
  const root = repo();
  plan(root, "run-paused", [{ id: "work" }, { id: "slow" }]);
  launch(root, "run-paused", "work", [process.execPath, askFixture, "--ask=question"]);
  launch(root, "run-paused", "slow", [process.execPath, slowFixture, "--delay=800", "--complete"]);

  const paused = await waitForRunChange(root, "run-paused", { timeoutMs: 15000, intervalMs: NO_FALLBACK_MS });
  assert.equal(paused.outcome, "changed");
  const request = paused.updates.find((update) => update.taskId === "work");
  assert.equal(request.status, "needs_input");
  assert.equal(request.changed, true);
  assert.equal(request.inputRequest.kind, "question");

  // Another worker is still running, so the paused one does not end the wait;
  // it is listed as awaiting an answer, and the running worker's completion wakes it.
  const next = await waitForRunChange(root, "run-paused", { timeoutMs: 15000, intervalMs: NO_FALLBACK_MS });
  assert.equal(next.outcome, "changed");
  assert.equal(next.updates.find((update) => update.taskId === "slow").status, "reported");
  const listed = next.updates.find((update) => update.taskId === "work");
  assert.equal(listed.awaitingAnswer, true);
  assert.equal(listed.changed, undefined);

  // Now only the paused worker holds a slot: nothing can change until the
  // supervisor answers, so the wait must not block.
  const blocked = await waitForRunChange(root, "run-paused", { timeoutMs: 15000, intervalMs: NO_FALLBACK_MS });
  assert.equal(blocked.outcome, "awaiting_answer");
  assert.equal(blocked.exitCode, 4);
  assert.equal(blocked.polls, 1);
  assert.equal(blocked.updates[0].round, 1);
  assert.match(blocked.message, /work paused awaiting your answer/);
  assert.equal(loadRun(root, "run-paused").tasks.work.status, "needs_input");
});

test("a model substitution wakes the wait", async () => {
  const root = repo();
  plan(root, "run-sub", [{ id: "work" }], { model: "astra" });
  launch(root, "run-sub", "work", [process.execPath, unavailableFixture, "--unavailable=gpt-6.2-astra"]);
  const result = await waitForRunChange(root, "run-sub", { timeoutMs: 15000, intervalMs: NO_FALLBACK_MS });
  assert.equal(result.outcome, "changed");
  const [update] = result.updates;
  assert.equal(update.status, "substituted");
  assert.equal(update.changed, true);
  assert.equal(update.model, "gpt-6.2-sol");
  assert.match(update.notice, /USER-PINNED MODEL SUBSTITUTED/);
});

test("a resume that falls back to a fresh thread wakes the wait while the worker runs", async () => {
  const root = repo();
  plan(root, "run-fallback-thread");
  launch(root, "run-fallback-thread", "work", [process.execPath, resumeFixture]);
  const first = await waitForRunChange(root, "run-fallback-thread", { timeoutMs: 15000, intervalMs: NO_FALLBACK_MS });
  assert.equal(first.updates[0].status, "reported");
  const threadId = loadRun(root, "run-fallback-thread").tasks.work.attempts[0].threadId;
  verifyTask(root, "run-fallback-thread", "work", { verdict: "fail", evidence: ["incomplete"] });
  retryTask(root, "run-fallback-thread", "work");
  launch(root, "run-fallback-thread", "work", [
    process.execPath, resumeFixture, `--missing=${threadId}`, "--fresh-delay=1500"
  ]);

  const result = await waitForRunChange(root, "run-fallback-thread", { timeoutMs: 15000, intervalMs: NO_FALLBACK_MS });
  assert.equal(result.outcome, "changed");
  const [update] = result.updates;
  assert.equal(update.status, "running");
  assert.equal(update.changed, true);
  assert.equal(update.resumeFallback.reason, "thread_missing");
  assert.match(result.message, /work resume fell back to a fresh thread \(thread_missing\)/);
  // The worker carries on; a later wait collects its result.
  const done = await waitForRunChange(root, "run-fallback-thread", { timeoutMs: 15000, intervalMs: NO_FALLBACK_MS });
  assert.equal(done.updates[0].status, "reported");
});

test("the CLI prints the poll payload and documents each exit code", async () => {
  const root = repo();
  plan(root, "run-cli-wait", [{ id: "work" }, { id: "later" }]);

  const idle = runCli(root, ["run", "wait", "run-cli-wait", "--json"]);
  assert.equal(idle.code, 3);
  assert.deepEqual(JSON.parse(idle.stdout), []);
  assert.match(idle.stderr, /no active workers in run-cli-wait; nothing to wait for\. \(exit 3\)/);

  launch(root, "run-cli-wait", "work", [process.execPath, slowFixture, "--delay=10000"]);
  reap(root, "run-cli-wait", "work");
  const timedOut = await runCliAsync(root, ["run", "wait", "run-cli-wait", "--timeout", "0.3", "--interval", "0.1"]);
  assert.equal(timedOut.code, 2);
  assert.match(timedOut.stdout, /^work\trunning/);
  assert.match(timedOut.stderr, /timed out after \d+s .* \(exit 2\)/);

  runCli(root, ["run", "cancel", "run-cli-wait", "work"]);
  checkpointPlan(root, "run-cli-wait");
  launch(root, "run-cli-wait", "later", [process.execPath, slowFixture, "--delay=300", "--complete"]);
  const woke = await runCliAsync(root, ["run", "wait", "run-cli-wait", "--json", "--no-watch", "--interval", "0.1"]);
  assert.equal(woke.code, 0);
  const payload = JSON.parse(woke.stdout);
  assert.equal(payload[0].taskId, "later");
  assert.equal(payload[0].status, "reported");
  assert.match(woke.stderr, /run-cli-wait changed: later reported\. \(exit 0\)/);

  // The same payload `run poll` gives: a fresh poll now has nothing new to collect.
  assert.deepEqual(JSON.parse(runCli(root, ["run", "poll", "run-cli-wait", "--json"]).stdout), []);
  assert.match(runCli(root, ["run", "wait", "run-cli-wait", "--timeout", "0"]).stderr, /--timeout must be a positive number of seconds/);
});

test("runs saved before wall-clock limits existed load and wait on the tier default", async () => {
  const root = repo();
  plan(root, "run-v5-wait");
  // Rewrite as a version-5 run on a legacy slug, as 0.5.x saved it.
  const file = runFile(root, "run-v5-wait");
  const state = JSON.parse(fs.readFileSync(file, "utf8"));
  state.version = 5;
  state.workerPolicy.model = "gpt-5.6-sol";
  state.tasks.work.model = "gpt-5.6-sol";
  delete state.tasks.work.timeoutMinutes;
  fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
  checkpointPlan(root, "run-v5-wait");
  launch(root, "run-v5-wait", "work", [process.execPath, slowFixture, "--delay=300", "--complete"]);
  const run = loadRun(root, "run-v5-wait");
  assert.equal(taskTimeoutMinutes(run.tasks.work, run.tasks.work.attempts.at(-1)), 90);
  const result = await waitForRunChange(root, "run-v5-wait", { timeoutMs: 15000, intervalMs: NO_FALLBACK_MS });
  assert.equal(result.outcome, "changed");
  assert.equal(result.updates[0].status, "reported");
  assert.equal(pollRunWorkers(root, "run-v5-wait").length, 0);
});

test("a quiet worker does not make the wait poll on its own lock file", { skip: WATCH_SKIP }, async () => {
  const root = repo();
  plan(root, "run-quiet");
  launch(root, "run-quiet", "work", [process.execPath, slowFixture, "--delay=10000"]);
  reap(root, "run-quiet", "work");
  await waitForStatus(loadRun(root, "run-quiet").tasks.work.attempts.at(-1).runner.statusFile, "running");
  const result = await waitForRunChange(root, "run-quiet", { timeoutMs: 3000, intervalMs: NO_FALLBACK_MS });
  assert.equal(result.outcome, "timeout");
  // start, rearm, maybe a watch wake from the worker starting, and the final look.
  assert.ok(result.polls <= 6, `expected a handful of polls, got ${result.polls}`);
});

test("a change to run.json made by another process wakes the wait", { skip: WATCH_SKIP }, async () => {
  const root = repo();
  plan(root, "run-external");
  launch(root, "run-external", "work", [process.execPath, slowFixture, "--delay=10000"]);
  reap(root, "run-external", "work");
  await waitForStatus(loadRun(root, "run-external").tasks.work.attempts.at(-1).runner.statusFile, "running");
  const started = Date.now();
  const waiting = waitForRunChange(root, "run-external", { timeoutMs: 15000, intervalMs: NO_FALLBACK_MS });
  setTimeout(() => {
    const run = JSON.parse(fs.readFileSync(runFile(root, "run-external"), "utf8"));
    run.tasks.work.status = "cancelled";
    atomicWrite(runFile(root, "run-external"), `${JSON.stringify(run, null, 2)}\n`);
  }, 500);
  const result = await waiting;
  assert.equal(result.outcome, "idle");
  assert.equal(result.wakeSource, "watch");
  assert.ok(Date.now() - started < 5000, "woken by the run.json rename, not a fallback poll");
});
