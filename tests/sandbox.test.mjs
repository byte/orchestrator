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
import { assertReadOnlyLaunch, checkpointPlan, cleanup, makeRepo, runCli, assertLockedDown } from "./helpers.mjs";

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

for (const [mode, reason] of [
  ["writable", "checkout_writable"],
  ["fail", "probe_failed"],
  ["ok-exit17", "probe_failed"],
  ["network-on", "network_enabled"]
]) {
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
    assert.ok(launch.argv.includes('approval_policy="never"'), "the fallback may not request escalation either");
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

test("a write worker is not probed, keeps --sandbox workspace-write, and cannot leave it", async () => {
  const root = setup("run-profile-write", "write");
  const calls = logFile();
  launchTaskWorker(root, "run-profile-write", "work", lane, {
    codexCommand: [process.execPath, resumeFixture, `--log=${calls}`, "--sandbox-probe=fail"]
  });
  const task = await settle(root, "run-profile-write");
  const [launch] = readLog(calls);
  assert.equal(launch.argv[launch.argv.indexOf("--sandbox") + 1], "workspace-write");
  // Write workers are locked down too; the wrapper commits for them.
  assertLockedDown(launch.argv);
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

for (const [name, dir] of [["", "tmp-inside"], [" even when its name starts with ..", "..tmp-inside"]]) {
test(`a scratch directory inside the checkout is refused and the worker falls back${name}`, async () => {
  const runId = `run-profile-inside${dir.startsWith("..") ? "-dots" : ""}`;
  const root = setup(runId);
  const calls = logFile();
  const inner = path.join(root, dir);
  fs.mkdirSync(inner);
  const saved = process.env.TMPDIR;
  process.env.TMPDIR = inner;
  try {
    launchTaskWorker(root, runId, "work", lane, {
      codexCommand: [process.execPath, resumeFixture, `--log=${calls}`]
    });
  } finally {
    if (saved === undefined) {
      delete process.env.TMPDIR;
    } else {
      process.env.TMPDIR = saved;
    }
  }
  const task = await settle(root, runId);
  assert.equal(task.attempts[0].sandboxFallback.reason, "scratch_inside_checkout");
  const [launch] = readLog(calls);
  assert.equal(launch.argv[launch.argv.indexOf("--sandbox") + 1], "read-only");
  assert.equal(launch.argv.some((arg) => arg.startsWith("default_permissions=")), false);
  // The fallback keeps the escalation and rule pins.
  assert.ok(launch.argv.includes('approval_policy="never"'));
  assert.ok(launch.argv.includes("--ignore-rules"));
});
}

test("a stopped probe whose launcher left a child holding its pipes still ends the worker", async () => {
  const root = setup("run-profile-stop-child");
  const calls = logFile();
  const pidFile = path.join(path.dirname(calls), "probe-child.pid");
  const launched = launchTaskWorker(root, "run-profile-stop-child", "work", lane, {
    codexCommand: [process.execPath, resumeFixture, `--log=${calls}`, "--sandbox-probe=hang-child", `--sandbox-probe-pid=${pidFile}`]
  });
  const deadline = Date.now() + 10000;
  while (!fs.existsSync(pidFile) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  const childPid = Number(fs.readFileSync(pidFile, "utf8"));
  const scratch = JSON.parse(fs.readFileSync(launched.runner.statusFile, "utf8")).scratchDir;
  stopTaskWorker(loadRun(root, "run-profile-stop-child").tasks.work.attempts[0]);
  try {
    assert.ok(await gone(childPid), `probe child ${childPid} still running`);
    assert.ok(await gone(launched.runner.pid), `wrapper ${launched.runner.pid} still running`);
  } finally {
    try {
      process.kill(childPid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  const status = JSON.parse(fs.readFileSync(launched.runner.statusFile, "utf8"));
  assert.equal(status.status, "cancelled");
  assert.equal(fs.existsSync(scratch), false, "scratch removed after a stop");
});

test("a read worker that leaves an unreadable directory in its scratch still has it removed", async () => {
  const root = setup("run-profile-locked");
  const calls = logFile();
  const launched = launchTaskWorker(root, "run-profile-locked", "work", lane, {
    codexCommand: [process.execPath, resumeFixture, `--log=${calls}`, "--lock-tmpdir"]
  });
  const task = await settle(root, "run-profile-locked");
  assert.equal(task.status, "reported");
  const status = JSON.parse(fs.readFileSync(launched.runner.statusFile, "utf8"));
  assert.ok(status.scratchDir);
  assert.ok(await gone(launched.runner.pid), "the wrapper exits");
  assert.equal(fs.existsSync(status.scratchDir), false, "scratch removed despite a chmod 000 directory");
});

test("run cleanup removes a scratch directory a hard-killed worker left, and nothing else", () => {
  const root = setup("run-profile-leftover");
  const attemptDir = path.join(path.dirname(runFile(root, "run-profile-leftover")), "workers", "work", "work-attempt-1");
  const tmp = fs.realpathSync(os.tmpdir());
  const made = [];
  const scratch = (prefix = "orch-worker-") => {
    const dir = fs.mkdtempSync(path.join(tmp, prefix));
    made.push(dir);
    return dir;
  };
  // A runner directory with a status file; `owner` writes the marker the wrapper writes.
  const runner = (name, status, { owner = true } = {}) => {
    const dir = path.join(attemptDir, name);
    fs.mkdirSync(dir, { recursive: true });
    const statusFile = path.join(dir, "status.json");
    fs.writeFileSync(statusFile, JSON.stringify(status));
    if (owner && status.scratchDir && fs.existsSync(status.scratchDir)) {
      fs.writeFileSync(path.join(status.scratchDir, ".orch-worker-owner"), statusFile);
    }
    return statusFile;
  };
  const leftover = scratch();
  fs.mkdirSync(path.join(leftover, "locked", "deeper"), { recursive: true });
  fs.writeFileSync(path.join(leftover, "locked", "deeper", "file"), "x");
  fs.chmodSync(path.join(leftover, "locked"), 0o000);
  runner(".", { pid: 999999999, status: "running", scratchDir: leftover });
  // An owned scratch directory whose root itself was made unreadable.
  const lockedRoot = scratch();
  runner("locked-root", { pid: 999999999, status: "failed", scratchDir: lockedRoot });
  fs.chmodSync(lockedRoot, 0o000);
  const live = scratch();
  runner("round-1", { pid: process.pid, status: "running", scratchDir: live });
  // Cancelled is written before the processes exit: a live Codex child keeps it.
  const stopping = scratch();
  runner("round-2", { pid: 999999999, childPid: process.pid, status: "cancelled", scratchDir: stopping });
  const unrelated = scratch("not-orch-");
  runner("other", { pid: 999999999, status: "failed", scratchDir: unrelated });
  // Named like a scratch directory but not owned: a forged status file.
  const forged = scratch();
  runner("forged", { pid: 999999999, status: "failed", scratchDir: forged }, { owner: false });
  // Owned by another runner's status file.
  const stolen = scratch();
  fs.writeFileSync(path.join(stolen, ".orch-worker-owner"), path.join(root, "elsewhere", "status.json"));
  runner("stolen", { pid: 999999999, status: "failed", scratchDir: stolen }, { owner: false });
  // A symlink to an owned scratch directory is not followed.
  const target = scratch();
  const link = path.join(tmp, `orch-worker-link-${process.pid}`);
  fs.symlinkSync(target, link);
  made.push(link);
  const linkStatus = runner("link", { pid: 999999999, status: "failed", scratchDir: link }, { owner: false });
  fs.writeFileSync(path.join(target, ".orch-worker-owner"), linkStatus);
  try {
    assert.deepEqual(removeLeftoverScratch(root, "run-profile-leftover", "work", "work-attempt-1").sort(), [leftover, lockedRoot].sort());
    assert.equal(fs.existsSync(leftover), false, "an owned, dead runner's scratch is removed, unreadable parts too");
    assert.equal(fs.existsSync(lockedRoot), false, "an owned scratch whose root was made unreadable is removed");
    assert.equal(fs.existsSync(live), true, "a live worker's scratch is kept");
    assert.equal(fs.existsSync(stopping), true, "a cancelled runner whose child is alive keeps its scratch");
    assert.equal(fs.existsSync(unrelated), true, "a directory not named like a worker scratch is kept");
    assert.equal(fs.existsSync(forged), true, "a directory without the owner file is kept");
    assert.equal(fs.existsSync(stolen), true, "a directory owned by another status file is kept");
    assert.equal(fs.existsSync(target), true, "a symlinked directory is not followed");
  } finally {
    for (const dir of made) {
      try {
        fs.chmodSync(dir, 0o700);
      } catch {
        // Gone or a symlink.
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

