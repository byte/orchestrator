import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  createRun,
  eventsFile,
  loadRun,
  renderSupervisorBriefing,
  replacePlan,
  runFile
} from "../plugins/orchestrator/scripts/lib/runs.mjs";
import {
  launchTaskWorker,
  pollRunWorkers,
  removeLeftoverScratch,
  stopTaskWorker
} from "../plugins/orchestrator/scripts/lib/workers.mjs";
import { assertReadOnlyLaunch, checkpointPlan, cleanup, makeRepo, runCli } from "./helpers.mjs";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const resumeFixture = path.join(fixtures, "fake-codex-resume.mjs");
const lane = { constraints: [] };
const repos = [];

after(() => {
  for (const root of repos) {
    cleanup(root);
  }
});

function setup(runId, kind = "read") {
  const root = makeRepo();
  repos.push(root);
  runCli(root, ["init"]);
  runCli(root, ["lane", "add", "api", "--scope", "src/**"]);
  createRun(root, { id: runId, lane: "api", objective: "Sandbox", workerModel: "sol", reasoningEffort: "high" });
  replacePlan(root, runId, [{
    id: "work",
    title: "Work",
    objective: "Do the work",
    kind,
    scope: kind === "write" ? ["src/**"] : [],
    acceptance: ["the supervisor accepts it"]
  }]);
  checkpointPlan(root, runId);
  return root;
}

function logFile() {
  return path.join(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "orch-sandbox-log-")), "calls.jsonl");
}

function readLog(file) {
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

async function settle(root, runId) {
  for (let index = 0; index < 150; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 40));
    pollRunWorkers(root, runId);
    const task = loadRun(root, runId).tasks.work;
    if (!["running", "dispatching", "pending"].includes(task.status)) {
      return task;
    }
  }
  throw new Error("worker did not settle");
}

function events(root, runId) {
  return fs.readFileSync(eventsFile(root, runId), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

test("a read worker whose profile holds runs under it and records no fallback", async () => {
  const root = setup("run-profile-ok");
  const calls = logFile();
  launchTaskWorker(root, "run-profile-ok", "work", lane, {
    codexCommand: [process.execPath, resumeFixture, `--log=${calls}`]
  });
  const task = await settle(root, "run-profile-ok");
  assert.equal(task.status, "reported");
  assertReadOnlyLaunch(readLog(calls)[0]);
  assert.equal(task.attempts[0].sandboxFallback, undefined);
  assert.equal(events(root, "run-profile-ok").some((event) => event.type === "task.sandbox_fallback"), false);
});

for (const [mode, reason] of [["writable", "checkout_writable"], ["fail", "probe_failed"], ["ok-exit17", "probe_failed"]]) {
  test(`a read profile that does not hold (${mode}) falls back to --sandbox read-only and says so`, async () => {
    const runId = `run-profile-${mode}`;
    const root = setup(runId);
    const calls = logFile();
    launchTaskWorker(root, runId, "work", lane, {
      codexCommand: [process.execPath, resumeFixture, `--log=${calls}`, `--sandbox-probe=${mode}`]
    });
    const task = await settle(root, runId);
    assert.equal(task.status, "reported");
    const [launch] = readLog(calls);
    assert.equal(launch.argv[launch.argv.indexOf("--sandbox") + 1], "read-only");
    assert.equal(launch.argv.some((arg) => arg.startsWith("default_permissions=")), false);
    const attempt = task.attempts[0];
    assert.equal(attempt.sandboxFallback.reason, reason);
    if (mode === "fail") {
      assert.match(attempt.sandboxFallback.message, /unrecognized subcommand 'sandbox'/);
    }
    const recorded = events(root, runId).filter((event) => event.type === "task.sandbox_fallback");
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].reason, reason);
    // A probe that could write the worktree leaves nothing behind in it.
    assert.deepEqual(fs.readdirSync(launch.cwd).filter((name) => name.startsWith(".orch-sandbox-probe")), []);
    assert.match(renderSupervisorBriefing(root, loadRun(root, runId), lane), new RegExp(`ran under plain --sandbox read-only .*${reason}`));
  });
}

test("a write worker is not probed and keeps --sandbox workspace-write", async () => {
  const root = setup("run-profile-write", "write");
  const calls = logFile();
  launchTaskWorker(root, "run-profile-write", "work", lane, {
    codexCommand: [process.execPath, resumeFixture, `--log=${calls}`, "--sandbox-probe=fail"]
  });
  const task = await settle(root, "run-profile-write");
  const [launch] = readLog(calls);
  assert.equal(launch.argv[launch.argv.indexOf("--sandbox") + 1], "workspace-write");
  assert.equal(task.attempts[0].sandboxFallback, undefined);
});

async function gone(pid, ms = 5000) {
  const alive = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return error.code !== "ESRCH";
    }
  };
  const deadline = Date.now() + ms;
  while (alive() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !alive();
}

test("a worker stopped while proving its profile stops the probe, launches nothing, and removes its scratch", async () => {
  const root = setup("run-profile-stop");
  const calls = logFile();
  const pidFile = path.join(path.dirname(calls), "probe.pid");
  const launched = launchTaskWorker(root, "run-profile-stop", "work", lane, {
    codexCommand: [process.execPath, resumeFixture, `--log=${calls}`, "--sandbox-probe=hang", `--sandbox-probe-pid=${pidFile}`]
  });
  const deadline = Date.now() + 10000;
  while (!fs.existsSync(pidFile) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  const probePid = Number(fs.readFileSync(pidFile, "utf8"));
  const scratch = JSON.parse(fs.readFileSync(launched.runner.statusFile, "utf8")).scratchDir;
  assert.ok(scratch && fs.existsSync(scratch));
  stopTaskWorker(loadRun(root, "run-profile-stop").tasks.work.attempts[0]);
  assert.ok(await gone(probePid), `probe ${probePid} still running`);
  const statusDeadline = Date.now() + 5000;
  let status;
  do {
    await new Promise((resolve) => setTimeout(resolve, 40));
    status = JSON.parse(fs.readFileSync(launched.runner.statusFile, "utf8"));
  } while (status.status === "running" && Date.now() < statusDeadline);
  assert.equal(status.status, "cancelled");
  assert.equal(fs.existsSync(scratch), false, "scratch removed after a stop");
  assert.equal(fs.existsSync(calls), false, "Codex was never launched");
});

test("a scratch directory inside the checkout is refused and the worker falls back", async () => {
  const root = setup("run-profile-inside");
  const calls = logFile();
  const inner = path.join(root, "tmp-inside");
  fs.mkdirSync(inner);
  const saved = process.env.TMPDIR;
  process.env.TMPDIR = inner;
  try {
    launchTaskWorker(root, "run-profile-inside", "work", lane, {
      codexCommand: [process.execPath, resumeFixture, `--log=${calls}`]
    });
  } finally {
    if (saved === undefined) {
      delete process.env.TMPDIR;
    } else {
      process.env.TMPDIR = saved;
    }
  }
  const task = await settle(root, "run-profile-inside");
  assert.equal(task.attempts[0].sandboxFallback.reason, "scratch_inside_checkout");
  const [launch] = readLog(calls);
  assert.equal(launch.argv[launch.argv.indexOf("--sandbox") + 1], "read-only");
  assert.equal(launch.argv.some((arg) => arg.startsWith("default_permissions=")), false);
});

test("run cleanup removes a scratch directory a hard-killed worker left, and nothing else", () => {
  const root = setup("run-profile-leftover");
  const attemptDir = path.join(path.dirname(runFile(root, "run-profile-leftover")), "workers", "work", "work-attempt-1");
  const roundDir = path.join(attemptDir, "round-1");
  fs.mkdirSync(roundDir, { recursive: true });
  const leftover = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "orch-worker-"));
  const live = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "orch-worker-"));
  const unrelated = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "not-orch-"));
  fs.writeFileSync(path.join(attemptDir, "status.json"), JSON.stringify({ pid: 999999999, status: "running", scratchDir: leftover }));
  fs.writeFileSync(path.join(roundDir, "status.json"), JSON.stringify({ pid: process.pid, status: "running", scratchDir: live }));
  const other = path.join(attemptDir, "other");
  fs.mkdirSync(other);
  fs.writeFileSync(path.join(other, "status.json"), JSON.stringify({ pid: 999999999, status: "failed", scratchDir: unrelated }));
  try {
    assert.deepEqual(removeLeftoverScratch(root, "run-profile-leftover", "work", "work-attempt-1"), [leftover]);
    assert.equal(fs.existsSync(leftover), false);
    assert.equal(fs.existsSync(live), true, "a live worker's scratch is kept");
    assert.equal(fs.existsSync(unrelated), true, "a directory not named like a worker scratch is kept");
  } finally {
    fs.rmSync(live, { recursive: true, force: true });
    fs.rmSync(unrelated, { recursive: true, force: true });
  }
});

