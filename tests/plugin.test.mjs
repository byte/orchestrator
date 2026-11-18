import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { createRun, loadRun, replacePlan, retryTask, verifyTask } from "../plugins/orchestrator/scripts/lib/runs.mjs";
import { cancelWorkers, launchTaskWorker, pollRunWorkers } from "../plugins/orchestrator/scripts/lib/workers.mjs";
import { inspectTaskWorktree } from "../plugins/orchestrator/scripts/lib/worktrees.mjs";
import { normalizeExecutor, pluginEffort } from "../plugins/orchestrator/scripts/lib/codex-plugin.mjs";
import { checkpointPlan, cleanup, makeRepo, runCli } from "./helpers.mjs";

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-codex-companion.mjs");
const lane = { constraints: [] };
const repos = [];
const scratch = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "orch-plugin-"));
const log = path.join(scratch, "calls.jsonl");
const saved = {};
for (const [key, value] of Object.entries({
  ORCHESTRATOR_CODEX_COMPANION: fixture,
  ORCHESTRATOR_PLUGIN_POLL_MS: "40",
  FAKE_COMPANION_STATE: path.join(scratch, "jobs"),
  FAKE_COMPANION_LOG: log
})) {
  saved[key] = process.env[key];
  process.env[key] = value;
}

after(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const root of repos) cleanup(root);
  fs.rmSync(scratch, { recursive: true, force: true });
});

function repo(id, tasks, { effort = "high" } = {}) {
  const root = makeRepo();
  repos.push(root);
  runCli(root, ["init"]);
  runCli(root, ["lane", "add", "api", "--scope", "src/**"]);
  createRun(root, { id, lane: "api", objective: "Via plugin", workerModel: "sol", reasoningEffort: effort, executor: "codex-plugin" });
  replacePlan(root, id, tasks);
  checkpointPlan(root, id);
  return root;
}

function calls(command) {
  return fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line))
    .filter((entry) => entry.command === command);
}

async function settle(root, runId, taskId) {
  for (let index = 0; index < 200; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 40));
    pollRunWorkers(root, runId);
    const task = loadRun(root, runId).tasks[taskId];
    if (!["running", "dispatching", "pending"].includes(task.status)) return task;
  }
  throw new Error(`${taskId} did not settle`);
}

test("executor names and the plugin's effort ceiling", () => {
  assert.equal(normalizeExecutor(undefined), "cli");
  assert.equal(normalizeExecutor("Codex-Plugin"), "codex-plugin");
  assert.throws(() => normalizeExecutor("rescue"), /Unknown executor "rescue"/);
  assert.deepEqual(pluginEffort("high"), { effort: "high", stepped: false });
  assert.deepEqual(pluginEffort("ultra"), { effort: "xhigh", stepped: true, requested: "ultra" });
});

test("a read task runs through the plugin's job commands in the checkout and its report is parsed from prose", async () => {
  const root = repo("run-plugin-read", [{ id: "review", title: "Review", objective: "Review", kind: "read" }], { effort: "max" });
  const launched = launchTaskWorker(root, "run-plugin-read", "review", lane);
  assert.equal(launched.worktree.inPlace, true);
  assert.equal(launched.runner.executor, "codex-plugin");
  assert.deepEqual(launched.runner.effortStepped, { requested: "max", ran: "xhigh" });
  assert.ok(launched.runner.executorLimitations.some((entry) => /output schema not enforced/.test(entry)));

  const task = await settle(root, "run-plugin-read", "review");
  assert.equal(task.status, "reported");
  assert.equal(task.result.structured.summary, "Done through the plugin.");
  const attempt = task.attempts.at(-1);
  assert.match(attempt.threadId, /^thread-plugin-job-/);
  assert.equal(attempt.sandboxFallback.reason, "codex_plugin_executor");

  const [queued] = calls("task").filter((entry) => entry.args.includes(fs.realpathSync(root)));
  assert.ok(queued.args.includes("--background"));
  assert.equal(queued.args[queued.args.indexOf("--effort") + 1], "xhigh");
  assert.equal(queued.args[queued.args.indexOf("--model") + 1], "gpt-6.2-sol");
  assert.ok(!queued.args.includes("--write"));
  const prompt = fs.readFileSync(queued.args[queued.args.indexOf("--prompt-file") + 1], "utf8");
  assert.match(prompt, /## Output contract/);
  assert.match(prompt, /"files_touched"/);
  verifyTask(root, "run-plugin-read", "review", { verdict: "pass", evidence: ["reviewed"] });
});

test("a write task runs through the plugin in its worktree, is committed, and a warm retry resumes", async () => {
  const root = repo("run-plugin-write", [{ id: "build", title: "Build", objective: "Build", kind: "write", scope: ["src/**"] }]);
  const launched = launchTaskWorker(root, "run-plugin-write", "build", lane);
  assert.notEqual(launched.worktree.path, fs.realpathSync(root));
  let task = await settle(root, "run-plugin-write", "build");
  assert.equal(task.status, "reported");
  const inspection = inspectTaskWorktree(task, task.attempts.at(-1));
  assert.equal(inspection.ready, true, JSON.stringify(inspection));
  assert.deepEqual(inspection.files, ["src/plugin.js"]);

  verifyTask(root, "run-plugin-write", "build", { verdict: "fail", evidence: ["add a test"] });
  retryTask(root, "run-plugin-write", "build", { note: "Add a test." });
  checkpointPlan(root, "run-plugin-write");
  const second = launchTaskWorker(root, "run-plugin-write", "build", lane);
  assert.equal(second.worktree.path, launched.worktree.path);
  task = await settle(root, "run-plugin-write", "build");
  const resumed = calls("task").filter((entry) => entry.args.includes(launched.worktree.path)).at(-1);
  assert.ok(resumed.args.includes("--resume"));
  assert.ok(resumed.args.includes("--write"));
  const prompt = fs.readFileSync(resumed.args[resumed.args.indexOf("--prompt-file") + 1], "utf8");
  assert.match(prompt, /## Previous attempt/);
  assert.match(prompt, /add a test/);
});

test("a stopped plugin worker cancels its plugin job", async () => {
  process.env.FAKE_COMPANION_MS = "60000";
  try {
    const root = repo("run-plugin-cancel", [{ id: "review", title: "Review", objective: "Review", kind: "read" }]);
    launchTaskWorker(root, "run-plugin-cancel", "review", lane);
    let jobId = null;
    for (let index = 0; index < 100 && !jobId; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 40));
      const runner = loadRun(root, "run-plugin-cancel").tasks.review.attempts.at(-1).runner;
      jobId = JSON.parse(fs.readFileSync(runner.statusFile, "utf8")).pluginJobId ?? null;
    }
    assert.ok(jobId, "the wrapper records the plugin job id");
    cancelWorkers(root, "run-plugin-cancel", "review", "stop");
    for (let index = 0; index < 100 && !calls("cancel").some((entry) => entry.args[0] === jobId); index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    assert.ok(calls("cancel").some((entry) => entry.args[0] === jobId));
  } finally {
    delete process.env.FAKE_COMPANION_MS;
  }
});

test("a run on the plugin executor refuses to launch without the plugin and spends no attempt", () => {
  const root = repo("run-plugin-missing", [{ id: "review", title: "Review", objective: "Review", kind: "read" }]);
  process.env.ORCHESTRATOR_CODEX_COMPANION = path.join(scratch, "missing.mjs");
  try {
    assert.throws(() => launchTaskWorker(root, "run-plugin-missing", "review", lane), /codex@openai-codex plugin is not installed/);
  } finally {
    process.env.ORCHESTRATOR_CODEX_COMPANION = fixture;
  }
  const task = loadRun(root, "run-plugin-missing").tasks.review;
  assert.equal(task.status, "pending");
  assert.equal(task.attempts.length, 0);
});

test("run create records the executor and rejects an unknown one", () => {
  const root = makeRepo();
  repos.push(root);
  runCli(root, ["init"]);
  runCli(root, ["lane", "add", "api", "--scope", "src/**"]);
  const created = JSON.parse(runCli(root, ["run", "create", "api", "--objective", "x", "--executor", "codex-plugin", "--json"]).stdout);
  assert.equal(created.workerPolicy.executor, "codex-plugin");
  const plain = JSON.parse(runCli(root, ["run", "create", "api", "--objective", "y", "--json"]).stdout);
  assert.equal(plain.workerPolicy.executor, "cli");
  const bad = runCli(root, ["run", "create", "api", "--objective", "z", "--executor", "rescue"]);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /Unknown executor/);
});
