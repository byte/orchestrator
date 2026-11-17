import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  attachExecution,
  cancelTask,
  claimTask,
  createRun,
  eventsFile,
  finalizeRun,
  loadRun,
  recordIntegration,
  recordTaskResult,
  renderSupervisorBriefing,
  replacePlan,
  retryTask,
  runFile,
  verifyTask
} from "../plugins/orchestrator/scripts/lib/runs.mjs";
import {
  WORKER_RESULT_SCHEMA,
  attemptLive,
  cancelWorkers,
  launchTaskWorker,
  modelUnavailableError,
  pollRunWorkers,
  stopTaskWorker
} from "../plugins/orchestrator/scripts/lib/workers.mjs";
import {
  cleanupTaskWorktree,
  createTaskWorktree,
  inspectTaskWorktree,
  integrateTaskWorktree
} from "../plugins/orchestrator/scripts/lib/worktrees.mjs";
import { changedFiles, worktreeGitEnv } from "../plugins/orchestrator/scripts/lib/git.mjs";
import { CLI, checkpointPlan, cleanup, git, makeRepo, runCli, write } from "./helpers.mjs";

const repos = [];
const fixture = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "fake-codex.mjs"
);
const slowFixture = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "fake-codex-slow.mjs"
);
const writeFixture = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "fake-codex-write.mjs"
);
const noResultFixture = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "fake-codex-no-result.mjs"
);
const failedFixture = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "fake-codex-fail.mjs"
);

function repo() {
  const root = makeRepo();
  repos.push(root);
  runCli(root, ["init"]);
  runCli(root, ["lane", "add", "api", "--scope", "src/**"]);
  return root;
}

after(() => {
  for (const root of repos) {
    cleanup(root);
  }
});

function plan(root, id, { workerModel, taskModel, taskEffort } = {}) {
  const autoRouted = Boolean(taskModel || taskEffort);
  createRun(root, {
    id,
    lane: "api",
    objective: "Build safely",
    workerModel: autoRouted ? undefined : workerModel ?? "sol",
    reasoningEffort: autoRouted ? undefined : "high"
  });
  replacePlan(root, id, [
    {
      id: "build",
      title: "Build",
      objective: "Add the module",
      scope: ["src/**"],
      acceptance: ["tests pass"],
      model: taskModel,
      effort: taskEffort,
      routingReason: autoRouted
        ? "The supervisor selected this route for the bounded task."
        : undefined
    }
  ]);
}

test("write worktrees require committed, clean, declared, in-scope changes before integration", () => {
  const root = repo();
  plan(root, "run-worktree");
  checkpointPlan(root, "run-worktree");
  const dispatch = claimTask(root, "run-worktree", "build", { constraints: [] });
  let run = loadRun(root, "run-worktree");
  let task = run.tasks.build;
  let attempt = task.attempts.at(-1);
  const worktree = createTaskWorktree(root, run, task, attempt);
  attempt.worktree = worktree;
  write(worktree.path, "src/module.js", "export const value = 1;\n");
  git(worktree.path, ["add", "src/module.js"]);
  git(worktree.path, ["commit", "--quiet", "-m", "Add module"]);

  recordTaskResult(root, "run-worktree", "build", {
    attemptId: dispatch.attemptId,
    resultText: JSON.stringify({
      summary: "Added the module.",
      files_touched: ["src/module.js"],
      tests: [{ command: "node --test", outcome: "passed" }],
      decisions: [],
      assumptions: [],
      blockers: [],
      confidence: "high"
    })
  });
  run = loadRun(root, "run-worktree");
  task = run.tasks.build;
  task.attempts.at(-1).worktree = worktree;
  const inspection = inspectTaskWorktree(task, task.attempts.at(-1));
  assert.equal(inspection.ready, true);
  assert.deepEqual(inspection.files, ["src/module.js"]);

  // A stopped empty cherry-pick is clean and has not advanced HEAD, but still
  // belongs to its caller. Integration must neither consume nor abort it.
  assert.throws(() => git(root, ["cherry-pick", "HEAD"]));
  const cherryPickHead = path.join(root, git(root, ["rev-parse", "--git-path", "CHERRY_PICK_HEAD"]).trim());
  assert.ok(fs.existsSync(cherryPickHead));
  assert.throws(() => integrateTaskWorktree(root, run, task, task.attempts.at(-1)), /Git operation/);
  assert.ok(fs.existsSync(cherryPickHead));
  git(root, ["cherry-pick", "--abort"]);

  const integrated = integrateTaskWorktree(root, run, task, task.attempts.at(-1));
  const result = recordIntegration(root, "run-worktree", "build", {
    evidence: ["worker tests passed", "scope inspection passed"],
    ...integrated
  });
  assert.equal(result.task.status, "completed");
  assert.equal(result.task.attempts.at(-1).outcome.terminalOutcome, "accepted");
  assert.equal(fs.readFileSync(path.join(root, "src/module.js"), "utf8"), "export const value = 1;\n");
  assert.equal(cleanupTaskWorktree(root, task.attempts.at(-1)), true);
});

test("inspection does not select a worker-written git through relative PATH entries", () => {
  const root = repo();
  const marker = path.join(root, ".orchestrator", "local", "planted-git-ran");
  const planted = write(root, "git", `#!/bin/sh\necho ran > ${JSON.stringify(marker)}\n`);
  fs.chmodSync(planted, 0o755);
  const saved = process.env.PATH;
  try {
    process.env.PATH = `.:${saved}`;
    const files = changedFiles(root, { gitDir: path.join(root, ".git") });
    assert.equal(fs.existsSync(marker), false);
    assert.ok(files.includes("git"), "the planted program is inspected as a file, not executed");
  } finally {
    process.env.PATH = saved;
  }
});

test("polling does not execute an integrated worker-written ps through relative PATH", async () => {
  const root = repo();
  const id = "run-relative-ps";
  plan(root, id);
  replacePlan(root, id, [loadRun(root, id).tasks.build, {
    id: "waiting", title: "Wait", objective: "Wait", kind: "read", scope: ["src/**"]
  }]);
  checkpointPlan(root, id);
  const dispatch = claimTask(root, id, "build", { constraints: [] });
  const run = loadRun(root, id);
  const worktree = createTaskWorktree(root, run, run.tasks.build, run.tasks.build.attempts.at(-1));
  attachExecution(root, id, "build", { attemptId: dispatch.attemptId, worktree });
  const marker = path.join(root, ".orchestrator", "local", "planted-ps-ran");
  fs.chmodSync(write(worktree.path, "src/ps", `#!/bin/sh\necho ran > ${JSON.stringify(marker)}\nexec /bin/ps "$@"\n`), 0o755);
  git(worktree.path, ["add", "src/ps"]);
  git(worktree.path, ["commit", "--quiet", "-m", "Add ps fixture"]);
  reportFiles(root, id, dispatch.attemptId, ["src/ps"]);
  const second = claimTask(root, id, "waiting", { constraints: [] });
  const idle = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
  const statusFile = path.join(path.dirname(runFile(root, id)), "idle-status.json");
  const startedAt = new Date().toISOString();
  fs.writeFileSync(statusFile, JSON.stringify({ pid: idle.pid, startedAt, status: "running" }));
  attachExecution(root, id, "waiting", { attemptId: second.attemptId, runner: { pid: idle.pid, statusFile, launchedAt: startedAt } });
  try {
    const integrated = runCli(root, ["run", "integrate", id, "build"]);
    assert.equal(integrated.code, 0, integrated.stderr);
    const polled = spawnSync(process.execPath, [CLI, "run", "poll", id], {
      cwd: root, encoding: "utf8", env: { ...process.env, PATH: `src:.:${process.env.PATH}` }
    });
    assert.equal(polled.status, 0, polled.stderr);
    assert.equal(fs.existsSync(marker), false, "process identity checks must use trusted ps, not integrated code");
    assert.equal(loadRun(root, id).tasks.waiting.status, "running");
  } finally {
    process.kill(-idle.pid, "SIGKILL");
    await exited(idle.pid);
  }
});

test("inspection and cleanup bound a Git command blocked on a worker FIFO", () => {
  const root = repo();
  const id = "run-fifo-inspection";
  plan(root, id);
  checkpointPlan(root, id);
  const dispatch = claimTask(root, id, "build", { constraints: [] });
  const run = loadRun(root, id);
  const worktree = createTaskWorktree(root, run, run.tasks.build, run.tasks.build.attempts.at(-1));
  attachExecution(root, id, "build", { attemptId: dispatch.attemptId, worktree, runner: {} });
  cancelTask(root, id, "build");
  fs.mkdirSync(path.join(worktree.path, "src"));
  const fifo = path.join(worktree.path, "src", ".gitignore");
  execFileSync("mkfifo", [fifo]);
  const preload = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "interrupt-integration.mjs");
  try {
    for (const action of ["inspect", "cleanup"]) {
      const result = spawnSync(process.execPath, [CLI, "run", action, id, "build"], {
        cwd: root, encoding: "utf8", detached: true, timeout: 3500, killSignal: "SIGKILL",
        env: { ...process.env, NODE_OPTIONS: `--import=${preload}`, ORCH_TEST_SHORT_GIT_TIMEOUT: "1" }
      });
      if (result.error?.code === "ETIMEDOUT") {
        try { process.kill(-result.pid, "SIGKILL"); } catch { /* Already gone. */ }
      }
      assert.equal(result.status, 1, `${action} must return an explicit failure, not hang`);
      assert.match(result.stderr, /Git timed out/);
      assert.ok(fs.existsSync(worktree.path));
      assert.ok(fs.lstatSync(fifo).isFIFO());
    }
  } finally {
    fs.unlinkSync(fifo);
  }
});

test("integration recovers across process death without accepting partial or foreign work", async () => {
  const preload = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "interrupt-integration.mjs");
  for (const phase of ["before-git", "after-git", "direct-retry", "detached-head", "partial-git", "foreign-git", "dirty-checkout", "missing-receipts", "orphan-git"]) {
    const root = repo();
    const id = `run-recovery-${phase}`;
    if (phase === "detached-head") {
      git(root, ["checkout", "--quiet", "--detach"]);
    }
    plan(root, id);
    checkpointPlan(root, id);
    const dispatch = claimTask(root, id, "build", { constraints: [] });
    let run = loadRun(root, id);
    const worktree = createTaskWorktree(root, run, run.tasks.build, run.tasks.build.attempts.at(-1));
    attachExecution(root, id, "build", { attemptId: dispatch.attemptId, worktree, runner: {} });
    for (const file of ["src/first.js", "src/second.js"]) {
      write(worktree.path, file, `export const value = ${file.includes("first") ? 17 : 29};\n`);
      git(worktree.path, ["add", file]);
      git(worktree.path, ["commit", "--quiet", "-m", `Add ${file}`]);
    }
    recordTaskResult(root, id, "build", {
      attemptId: dispatch.attemptId,
      resultText: JSON.stringify({ summary: "Built", files_touched: ["src/first.js", "src/second.js"],
        tests: [], decisions: [], assumptions: [], blockers: [], confidence: "high" })
    });
    const before = git(root, ["rev-parse", "HEAD"]).trim();
    assert.throws(() => execFileSync(process.execPath, [CLI, "run", "integrate", id, "build", "--evidence", "reviewed both modules"], {
      cwd: root, stdio: "pipe",
      env: { ...process.env, NODE_OPTIONS: `--import=${preload}`,
        ORCH_TEST_GIT_PID: path.join(path.dirname(runFile(root, id)), "git.pid"),
        ORCH_TEST_INTEGRATION_INTERRUPT: ["before-git", "partial-git", "orphan-git"].includes(phase) ? phase : "after-git" }
    }), (error) => error.status === 86);
    run = loadRun(root, id);
    assert.equal(run.tasks.build.status, "reported");
    assert.ok(run.pendingIntegration);
    assert.throws(() => cancelTask(root, id, "build"), /interrupted integration/);
    if (phase === "orphan-git") {
      const pid = Number(fs.readFileSync(path.join(path.dirname(runFile(root, id)), "git.pid"), "utf8"));
      try {
        const deadline = Date.now() + 5000;
        while (!execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).includes("T")) {
          assert.ok(Date.now() < deadline, "the orphan child stopped before recovery");
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        const refused = runCli(root, ["run", "resume", id]);
        assert.equal(refused.code, 1, "a child may still apply the saved operation despite unchanged HEAD");
        assert.match(refused.stderr, /manual recovery/);
        assert.ok(loadRun(root, id).pendingIntegration);
        assert.throws(() => cancelTask(root, id, "build"), /interrupted integration/);
        // Even after application, receipts cannot attest to mutator termination;
        // without the parent's stopped phase this remains manual recovery.
        process.kill(pid, "SIGCONT");
        assert.ok(await exited(pid, 5000), "the orphan Git child finished");
      } finally {
        try { process.kill(-pid, "SIGKILL"); } catch { /* Already gone. */ }
      }
    }
    if (phase === "foreign-git") {
      write(root, "foreign.txt", "unrelated\n");
      git(root, ["add", "foreign.txt"]);
      git(root, ["commit", "--quiet", "-m", "Unrelated supervisor edit"]);
    }
    if (phase === "dirty-checkout") {
      write(root, "src/first.js", "manual work must survive\n");
    }
    if (phase === "missing-receipts") {
      git(root, ["reflog", "expire", "--expire=now", "--all"]);
    }
    const integratedHead = git(root, ["rev-parse", "HEAD"]).trim();
    const resumed = runCli(root, phase === "direct-retry"
      ? ["run", "integrate", id, "build", "--json"]
      : ["run", "resume", id, "--json"]);
    if (["partial-git", "foreign-git", "dirty-checkout", "missing-receipts", "orphan-git"].includes(phase)) {
      assert.equal(resumed.code, 1);
      assert.match(resumed.stderr, /manual recovery/);
      assert.equal(loadRun(root, id).tasks.build.status, "reported");
      assert.ok(loadRun(root, id).pendingIntegration);
      assert.equal(git(root, ["rev-parse", "HEAD"]).trim(), integratedHead);
      if (phase === "dirty-checkout") {
        assert.equal(fs.readFileSync(path.join(root, "src/first.js"), "utf8"), "manual work must survive\n");
      }
      continue;
    }
    assert.equal(resumed.code, 0, resumed.stderr);
    if (phase === "before-git") {
      assert.equal(integratedHead, before);
      assert.equal(loadRun(root, id).tasks.build.status, "reported");
      const integrated = runCli(root, ["run", "integrate", id, "build", "--evidence", "reviewed both modules"]);
      assert.equal(integrated.code, 0, integrated.stderr);
    } else {
      assert.notEqual(integratedHead, before);
      assert.equal(git(root, ["rev-parse", "HEAD"]).trim(), integratedHead, "recovery must not cherry-pick twice");
    }
    run = loadRun(root, id);
    assert.equal(run.tasks.build.status, "completed");
    assert.equal(run.tasks.build.attempts.at(-1).outcome.terminalOutcome, "accepted");
    assert.equal(run.pendingIntegration, undefined);
    assert.deepEqual(run.tasks.build.verification.evidence, ["reviewed both modules"]);
    assert.equal(git(root, ["rev-list", "--count", `${before}..HEAD`]).trim(), "2");
    assert.equal(fs.readFileSync(path.join(root, "src/second.js"), "utf8"), "export const value = 29;\n");
    assert.equal(run.repository.integrationHead, git(root, ["rev-parse", "HEAD"]).trim());
    assert.equal(runCli(root, ["run", "resume", id, "--json"]).code, 0);
  }
});

test("integration reaps a signalled Git launcher's group or retains mutation ownership", async () => {
  const preload = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "interrupt-integration.mjs");
  for (const phase of ["signalled-git", "unreapable-git"]) {
    const root = repo();
    const id = `run-${phase}`;
    plan(root, id);
    checkpointPlan(root, id);
    const dispatch = claimTask(root, id, "build", { constraints: [] });
    const run = loadRun(root, id);
    const worktree = createTaskWorktree(root, run, run.tasks.build, run.tasks.build.attempts.at(-1));
    attachExecution(root, id, "build", { attemptId: dispatch.attemptId, worktree });
    write(worktree.path, "src/module.js", "export const value = 67;\n");
    git(worktree.path, ["add", "src/module.js"]);
    git(worktree.path, ["commit", "--quiet", "-m", "Add module"]);
    reportFiles(root, id, dispatch.attemptId, ["src/module.js"]);
    const pidFile = path.join(path.dirname(runFile(root, id)), "git.pid");
    const head = git(root, ["rev-parse", "HEAD"]).trim();
    const result = spawnSync(process.execPath, [CLI, "run", "integrate", id, "build"], {
      cwd: root, encoding: "utf8",
      env: { ...process.env, NODE_OPTIONS: `--import=${preload}`, ORCH_TEST_INTEGRATION_INTERRUPT: phase,
        ORCH_TEST_GIT_PID: pidFile }
    });
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    try {
      assert.equal(result.status, 1, result.stderr);
      if (phase === "unreapable-git") {
        assert.equal(loadRun(root, id).pendingIntegration.phase, "started");
        assert.equal(runCli(root, ["run", "resume", id]).code, 1);
        assert.equal(runCli(root, ["run", "cancel", id, "build"]).code, 1);
      } else {
        assert.ok(await exited(pid, 2000), "the signalled launcher's stopped child must not survive integration");
        assert.equal(loadRun(root, id).pendingIntegration, undefined);
        assert.equal(runCli(root, ["run", "cancel", id, "build"]).code, 0);
      }
      assert.equal(git(root, ["rev-parse", "HEAD"]).trim(), head);
      assert.equal(fs.existsSync(path.join(root, "src/module.js")), false);
    } finally {
      try { process.kill(pid, "SIGKILL"); } catch { /* Already gone. */ }
    }
  }
});

test("a wrapper's final Git result retains group ownership until poll or cancel reaps descendants", async () => {
  const preload = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "interrupt-integration.mjs");
  for (const [phase, action] of [
    ["wrapper-signalled-git", "poll"], ["wrapper-signalled-git", "cancel"],
    ["wrapper-success-git", "poll"], ["wrapper-delayed-git", "cancel"],
    ["wrapper-signalled-git", "denied"], ["wrapper-delayed-git", "stale"]
  ]) {
    const root = repo();
    const id = `run-${phase}-${action}`;
    plan(root, id);
    checkpointPlan(root, id);
    const pidFile = path.join(path.dirname(runFile(root, id)), "git.pid");
    const saved = { ...process.env };
    let launched;
    try {
      Object.assign(process.env, { NODE_OPTIONS: `--import=${preload}`, ORCH_TEST_INTEGRATION_INTERRUPT: phase, ORCH_TEST_GIT_PID: pidFile });
      launched = launchTaskWorker(root, id, "build", { constraints: [] }, {
        codexCommand: [process.execPath, writeFixture, "--no-commit"]
      });
    } finally {
      for (const key of ["NODE_OPTIONS", "ORCH_TEST_INTEGRATION_INTERRUPT", "ORCH_TEST_GIT_PID"]) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    }
    let child;
    const staleSnapshot = `${pidFile}.stale-status.json`;
    try {
      if (phase === "wrapper-delayed-git") {
        const deadline = Date.now() + 10000;
        while (!fs.existsSync(pidFile) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
        assert.equal(JSON.parse(fs.readFileSync(launched.runner.statusFile, "utf8")).status, "running");
        if (action === "stale") {
          fs.copyFileSync(launched.runner.statusFile, staleSnapshot);
          assert.ok(await exited(launched.runner.pid, 10000));
        }
      } else {
        assert.ok(await exited(launched.runner.pid, 10000), "the wrapper finished its result");
      }
      child = Number(fs.readFileSync(pidFile, "utf8"));
      const attempt = loadRun(root, id).tasks.build.attempts.at(-1);
      const head = git(root, ["rev-parse", "HEAD"]).trim();
      assert.equal(await exited(child, 50), false, "the gated Git child remains for supervisor cleanup");
      assert.equal(attemptLive(attempt), true, "a final result does not release the group's ownership");
      if (action === "cancel" && phase !== "wrapper-delayed-git") {
        cancelTask(root, id, "build", "save cancellation before stopping processes");
        const cleanupResult = runCli(root, ["run", "cleanup", id, "build"]);
        assert.equal(cleanupResult.code, 1);
        assert.match(cleanupResult.stderr, /still running/);
      }
      if (action === "denied") {
        for (const denied of ["poll", "cancel"]) {
          const result = spawnSync(process.execPath, [CLI, "run", denied, id, ...(denied === "cancel" ? ["build"] : [])], {
            cwd: root, encoding: "utf8", env: { ...process.env, NODE_OPTIONS: `--import=${preload}`, ORCH_TEST_DENY_GROUP: String(launched.runner.pid) }
          });
          assert.equal(result.status, 1, `${denied} must report the failed reap`);
          assert.match(result.stderr, /injected group denial/);
          assert.equal(JSON.parse(fs.readFileSync(launched.runner.statusFile, "utf8")).groupCleanupPending, true);
          assert.equal(attemptLive(attempt), true);
          assert.equal(await exited(child, 50), false);
        }
      }
      if (action === "stale") {
        const result = spawnSync(process.execPath, [CLI, "run", "poll", id], {
          cwd: root, encoding: "utf8", env: { ...process.env, NODE_OPTIONS: `--import=${preload}`,
            ORCH_TEST_STALE_STATUS_FILE: launched.runner.statusFile, ORCH_TEST_STALE_STATUS_SNAPSHOT: staleSnapshot }
        });
        assert.equal(result.status, 0, result.stderr);
      } else {
        const command = action === "denied" ? "cancel" : action;
        const result = runCli(root, ["run", command, id, ...(command === "cancel" ? ["build"] : [])]);
        assert.equal(result.code, 0, result.stderr);
      }
      assert.ok(await exited(child, 2000), `${action} reaped the commit descendant`);
      assert.equal(attemptLive(loadRun(root, id).tasks.build.attempts.at(-1)), false);
      assert.equal(git(launched.worktree.path, ["rev-parse", "HEAD"]).trim(), head, "the gated commit never ran");
    } finally {
      for (const pid of [child, launched.runner.pid]) {
        if (pid) try { process.kill(pid, "SIGKILL"); } catch { /* Already gone. */ }
      }
    }
  }
});

test("accepted integration repairs its audit event exactly once after publication or state-write failure", () => {
  const preload = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "interrupt-integration.mjs");
  for (const phase of ["audit-publish", "audit-clear", "audit-crash"]) {
    const root = repo();
    const id = `run-${phase}`;
    plan(root, id);
    checkpointPlan(root, id);
    const dispatch = claimTask(root, id, "build", { constraints: [] });
    let run = loadRun(root, id);
    const worktree = createTaskWorktree(root, run, run.tasks.build, run.tasks.build.attempts.at(-1));
    attachExecution(root, id, "build", { attemptId: dispatch.attemptId, worktree });
    write(worktree.path, "src/module.js", "export const value = 53;\n");
    git(worktree.path, ["add", "src/module.js"]);
    git(worktree.path, ["commit", "--quiet", "-m", "Add module"]);
    reportFiles(root, id, dispatch.attemptId, ["src/module.js"]);
    const result = spawnSync(process.execPath, [CLI, "run", "integrate", id, "build"], {
      cwd: root, encoding: "utf8",
      env: { ...process.env, NODE_OPTIONS: `--import=${preload}`, ORCH_TEST_INTEGRATION_INTERRUPT: phase }
    });
    assert.equal(result.status, phase === "audit-crash" ? 86 : 0, result.stderr);
    if (phase !== "audit-crash") assert.match(result.stdout, /Integration accepted; audit event is pending/);
    run = loadRun(root, id);
    assert.equal(run.tasks.build.status, "completed");
    assert.ok(run.pendingIntegrationEvent);
    const head = git(root, ["rev-parse", "HEAD"]).trim();
    const prior = fs.readFileSync(eventsFile(root, id), "utf8");
    for (const action of [["integrate", id, "build"], ["resume", id], ["resume", id]]) {
      const repaired = runCli(root, ["run", ...action, "--json"]);
      assert.equal(repaired.code, 0, repaired.stderr);
      assert.equal(loadRun(root, id).pendingIntegrationEvent, undefined);
      assert.equal(git(root, ["rev-parse", "HEAD"]).trim(), head, "audit repair never repeats Git integration");
    }
    const text = fs.readFileSync(eventsFile(root, id), "utf8");
    assert.ok(text.startsWith(prior), "existing event bytes are preserved");
    const events = text.trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(events.filter((event) => event.type === "task.integrated").length, 1);
  }
});

function reportedBuild(root, id, extraTasks = []) {
  plan(root, id);
  if (extraTasks.length) replacePlan(root, id, [loadRun(root, id).tasks.build, ...extraTasks]);
  checkpointPlan(root, id);
  const dispatch = claimTask(root, id, "build", { constraints: [] });
  const run = loadRun(root, id);
  const worktree = createTaskWorktree(root, run, run.tasks.build, run.tasks.build.attempts.at(-1));
  attachExecution(root, id, "build", { attemptId: dispatch.attemptId, worktree });
  write(worktree.path, "src/module.js", "export const value = 53;\n");
  git(worktree.path, ["add", "src/module.js"]);
  git(worktree.path, ["commit", "--quiet", "-m", "Add module"]);
  reportFiles(root, id, dispatch.attemptId, ["src/module.js"]);
}

test("a pending audit event holds the run, and a torn log line does not block its publication", () => {
  const preload = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "interrupt-integration.mjs");
  const root = repo();
  const id = "run-audit-held";
  reportedBuild(root, id, [{
    id: "after", title: "After", objective: "After", kind: "read", scope: ["src/**"], dependsOn: ["build"]
  }]);
  const result = spawnSync(process.execPath, [CLI, "run", "integrate", id, "build"], {
    cwd: root, encoding: "utf8",
    env: { ...process.env, NODE_OPTIONS: `--import=${preload}`, ORCH_TEST_INTEGRATION_INTERRUPT: "audit-publish" }
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(loadRun(root, id).pendingIntegrationEvent);
  // Nothing may be recorded ahead of the unpublished acceptance.
  assert.throws(() => claimTask(root, id, "after", { constraints: [] }), /audit event is pending/);
  assert.throws(() => finalizeRun(root, id, { verdict: "pass", summary: "done", evidence: ["checked"] }),
    /audit event is pending/);
  // A crash in some earlier append left a torn last line.
  fs.appendFileSync(eventsFile(root, id), '{"at":"2026-');
  const resumed = runCli(root, ["run", "resume", id, "--json"]);
  assert.equal(resumed.code, 0, resumed.stderr);
  assert.equal(loadRun(root, id).pendingIntegrationEvent, undefined);
  const lines = fs.readFileSync(eventsFile(root, id), "utf8").split("\n");
  assert.equal(lines.filter((line) => line.includes('"type":"task.integrated"')).length, 1);
  assert.doesNotThrow(() => JSON.parse(lines.find((line) => line.includes('"type":"task.integrated"'))));
  claimTask(root, id, "after", { constraints: [] });
});

test("an interrupted integration recorded before phases recovers once Git has released the checkout", () => {
  const preload = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "interrupt-integration.mjs");
  const root = repo();
  const id = "run-legacy-pending";
  reportedBuild(root, id);
  const before = git(root, ["rev-parse", "HEAD"]).trim();
  const result = spawnSync(process.execPath, [CLI, "run", "integrate", id, "build"], {
    cwd: root, encoding: "utf8",
    env: { ...process.env, NODE_OPTIONS: `--import=${preload}`, ORCH_TEST_INTEGRATION_INTERRUPT: "before-git" }
  });
  assert.equal(result.status, 86, result.stderr);
  // Rewrite the record as the previous build wrote it: no phase.
  const file = runFile(root, id);
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  delete saved.pendingIntegration.phase;
  fs.writeFileSync(file, `${JSON.stringify(saved, null, 2)}\n`);
  const lock = path.join(root, ".git", "index.lock");
  fs.writeFileSync(lock, "");
  const refused = runCli(root, ["run", "resume", id]);
  assert.equal(refused.code, 1, "a Git process may still hold the index");
  assert.match(refused.stderr, /manual recovery/);
  fs.rmSync(lock);
  const resumed = runCli(root, ["run", "resume", id, "--json"]);
  assert.equal(resumed.code, 0, resumed.stderr);
  assert.equal(loadRun(root, id).pendingIntegration, undefined);
  assert.equal(git(root, ["rev-parse", "HEAD"]).trim(), before);
  assert.equal(loadRun(root, id).tasks.build.status, "reported");
});

test("a refused run cancellation leaves its still-running worker untouched", async () => {
  const root = repo();
  const id = "run-refused-cancel";
  plan(root, id);
  replacePlan(root, id, [loadRun(root, id).tasks.build, {
    id: "waiting", title: "Wait", objective: "Wait", kind: "read", scope: ["src/**"]
  }]);
  checkpointPlan(root, id);
  const first = claimTask(root, id, "build", { constraints: [] });
  const run = loadRun(root, id);
  const worktree = createTaskWorktree(root, run, run.tasks.build, run.tasks.build.attempts.at(-1));
  attachExecution(root, id, "build", { attemptId: first.attemptId, worktree });
  write(worktree.path, "src/module.js", "export const value = 41;\n");
  git(worktree.path, ["add", "src/module.js"]);
  git(worktree.path, ["commit", "--quiet", "-m", "module"]);
  reportFiles(root, id, first.attemptId, ["src/module.js"]);
  const second = claimTask(root, id, "waiting", { constraints: [] });
  const idle = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
  const statusFile = path.join(path.dirname(runFile(root, id)), "idle-status.json");
  const startedAt = new Date().toISOString();
  fs.writeFileSync(statusFile, JSON.stringify({ pid: idle.pid, startedAt, status: "running" }));
  attachExecution(root, id, "waiting", { attemptId: second.attemptId, runner: { pid: idle.pid, statusFile, launchedAt: startedAt } });
  const preload = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "interrupt-integration.mjs");
  try {
    assert.throws(() => execFileSync(process.execPath, [CLI, "run", "integrate", id, "build"], {
      cwd: root, stdio: "pipe",
      env: { ...process.env, NODE_OPTIONS: `--import=${preload}`, ORCH_TEST_INTEGRATION_INTERRUPT: "before-git" }
    }), (error) => error.status === 86);
    const cancelled = runCli(root, ["run", "cancel", id]);
    assert.equal(cancelled.code, 1);
    assert.match(cancelled.stderr, /interrupted integration/);
    assert.equal(JSON.parse(fs.readFileSync(statusFile, "utf8")).status, "running");
    assert.equal(loadRun(root, id).tasks.waiting.status, "running");
    assert.equal(await exited(idle.pid, 100), false);
    assert.equal(runCli(root, ["run", "resume", id]).code, 0);
    cancelWorkers(root, id, null, "stop after recovery");
    assert.ok(await exited(idle.pid));
  } finally {
    try { process.kill(-idle.pid, "SIGKILL"); } catch { /* Already gone. */ }
  }
});

test("a conflicted integration rolls back without running a worker-changed fsmonitor", () => {
  const root = repo();
  // The repository runs a tracked script as its fsmonitor.
  write(root, "src/mon.sh", "#!/bin/sh\nexit 1\n");
  fs.chmodSync(path.join(root, "src/mon.sh"), 0o755);
  write(root, "src/same.js", "base\n");
  git(root, ["add", "-A"]);
  git(root, ["commit", "--quiet", "-m", "base"]);
  plan(root, "run-conflict");
  checkpointPlan(root, "run-conflict");
  const dispatch = claimTask(root, "run-conflict", "build", { constraints: [] });
  let run = loadRun(root, "run-conflict");
  const worktree = createTaskWorktree(root, run, run.tasks.build, run.tasks.build.attempts.at(-1));
  const marker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "orch-hook-")), "ran");
  repos.push(path.dirname(marker));
  // Worker commit 1 changes the fsmonitor script; commit 2 will conflict.
  write(worktree.path, "src/mon.sh", `#!/bin/sh\necho ran >> ${JSON.stringify(marker)}\nexit 1\n`);
  git(worktree.path, ["commit", "--quiet", "-am", "monitor"]);
  write(worktree.path, "src/same.js", "worker\n");
  git(worktree.path, ["commit", "--quiet", "-am", "same"]);
  recordTaskResult(root, "run-conflict", "build", {
    attemptId: dispatch.attemptId,
    resultText: JSON.stringify({
      summary: "Changed both.",
      files_touched: ["src/mon.sh", "src/same.js"],
      tests: [],
      decisions: [],
      assumptions: [],
      blockers: [],
      confidence: "high"
    })
  });
  // Another integration moved the supervisor branch meanwhile.
  write(root, "src/same.js", "supervisor\n");
  git(root, ["commit", "--quiet", "-am", "other task"]);
  git(root, ["config", "core.fsmonitor", path.join(root, "src/mon.sh")]);
  run = loadRun(root, "run-conflict");
  run.repository.integrationHead = git(root, ["rev-parse", "HEAD"]).trim();
  const task = run.tasks.build;
  task.attempts.at(-1).worktree = worktree;
  fs.writeFileSync(runFile(root, "run-conflict"), `${JSON.stringify(run, null, 2)}\n`);
  const result = runCli(root, ["run", "integrate", "run-conflict", "build"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /integration|cherry-pick|conflict/i);
  assert.equal(loadRun(root, "run-conflict").pendingIntegration, undefined);
  assert.equal(loadRun(root, "run-conflict").tasks.build.status, "reported");
  assert.equal(fs.existsSync(marker) ? fs.readFileSync(marker, "utf8") : "", "", "the worker's fsmonitor did not run");
  assert.equal(fs.readFileSync(path.join(root, "src/mon.sh"), "utf8"), "#!/bin/sh\nexit 1\n", "rolled back");
  git(root, ["config", "--unset", "core.fsmonitor"]);
});

test("supervisor git after an integration runs no hook or fsmonitor the worker changed", () => {
  const root = repo();
  write(root, "src/mon.sh", "#!/bin/sh\nexit 1\n");
  write(root, "src/hooks/post-checkout", "#!/bin/sh\nexit 0\n");
  fs.chmodSync(path.join(root, "src/mon.sh"), 0o755);
  fs.chmodSync(path.join(root, "src/hooks/post-checkout"), 0o755);
  git(root, ["add", "-A"]);
  git(root, ["commit", "--quiet", "-m", "base"]);
  plan(root, "run-supervisor-git");
  checkpointPlan(root, "run-supervisor-git");
  const dispatch = claimTask(root, "run-supervisor-git", "build", { constraints: [] });
  let run = loadRun(root, "run-supervisor-git");
  const worktree = createTaskWorktree(root, run, run.tasks.build, run.tasks.build.attempts.at(-1));
  const marker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "orch-hook-")), "ran");
  repos.push(path.dirname(marker));
  const planted = `#!/bin/sh\necho ran >> ${JSON.stringify(marker)}\nexit 1\n`;
  write(worktree.path, "src/mon.sh", planted);
  write(worktree.path, "src/hooks/post-checkout", planted);
  git(worktree.path, ["commit", "--quiet", "-am", "monitor and hook"]);
  recordTaskResult(root, "run-supervisor-git", "build", {
    attemptId: dispatch.attemptId,
    resultText: JSON.stringify({
      summary: "Changed both.",
      files_touched: ["src/hooks/post-checkout", "src/mon.sh"],
      tests: [],
      decisions: [],
      assumptions: [],
      blockers: [],
      confidence: "high"
    })
  });
  git(root, ["config", "core.fsmonitor", path.join(root, "src/mon.sh")]);
  git(root, ["config", "core.hooksPath", "src/hooks"]);
  try {
    run = loadRun(root, "run-supervisor-git");
    const task = run.tasks.build;
    task.attempts.at(-1).worktree = worktree;
    run.repository.integrationHead = integrateTaskWorktree(root, run, task, task.attempts.at(-1)).integrationHead;
    assert.equal(fs.readFileSync(path.join(root, "src/mon.sh"), "utf8"), planted, "integrated");
    // The supervisor's next status check and the next worker's worktree.
    assert.deepEqual(changedFiles(root), []);
    createTaskWorktree(root, run, task, { ...task.attempts.at(-1), id: "attempt-next" });
    assert.equal(fs.existsSync(marker) ? fs.readFileSync(marker, "utf8") : "", "", "no worker-written script ran");
  } finally {
    execFileSync("git", ["config", "--unset", "core.fsmonitor"], { cwd: root });
    execFileSync("git", ["config", "--unset", "core.hooksPath"], { cwd: root });
  }
});

test("a worker's working-tree-encoded file integrates with the bytes it wrote", () => {
  const root = repo();
  write(root, ".gitattributes", "src/*.txt working-tree-encoding=UTF-16LE\n");
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src/value.txt"), Buffer.from("old\n", "utf16le"));
  git(root, ["add", "-A"]);
  git(root, ["commit", "--quiet", "-m", "encoded"]);
  plan(root, "run-encoding");
  checkpointPlan(root, "run-encoding");
  const dispatch = claimTask(root, "run-encoding", "build", { constraints: [] });
  let run = loadRun(root, "run-encoding");
  const worktree = createTaskWorktree(root, run, run.tasks.build, run.tasks.build.attempts.at(-1));
  const written = Buffer.from("new\n", "utf16le");
  fs.writeFileSync(path.join(worktree.path, "src/value.txt"), written);
  // Committed the way the wrapper commits it.
  const env = worktreeGitEnv(worktree.path, worktree.gitDir);
  execFileSync("git", ["add", "-A"], { cwd: worktree.path, env });
  execFileSync("git", ["commit", "--quiet", "--no-verify", "-m", "value"], { cwd: worktree.path, env });
  recordTaskResult(root, "run-encoding", "build", {
    attemptId: dispatch.attemptId,
    resultText: JSON.stringify({
      summary: "Changed the value.",
      files_touched: ["src/value.txt"],
      tests: [],
      decisions: [],
      assumptions: [],
      blockers: [],
      confidence: "high"
    })
  });
  run = loadRun(root, "run-encoding");
  const task = run.tasks.build;
  task.attempts.at(-1).worktree = worktree;
  integrateTaskWorktree(root, run, task, task.attempts.at(-1));
  assert.deepEqual(fs.readFileSync(path.join(root, "src/value.txt")), written);
});

test("an edit to a file another task moved out of scope conflicts instead of following the move", () => {
  const root = repo();
  write(root, "src/a.txt", "one\ntwo\nthree\n");
  git(root, ["add", "-A"]);
  git(root, ["commit", "--quiet", "-m", "base"]);
  plan(root, "run-rename");
  checkpointPlan(root, "run-rename");
  const dispatch = claimTask(root, "run-rename", "build", { constraints: [] });
  let run = loadRun(root, "run-rename");
  const worktree = createTaskWorktree(root, run, run.tasks.build, run.tasks.build.attempts.at(-1));
  write(worktree.path, "src/a.txt", "one\nTWO\nthree\n");
  git(worktree.path, ["commit", "--quiet", "-am", "edit"]);
  recordTaskResult(root, "run-rename", "build", {
    attemptId: dispatch.attemptId,
    resultText: JSON.stringify({
      summary: "Edited a.",
      files_touched: ["src/a.txt"],
      tests: [],
      decisions: [],
      assumptions: [],
      blockers: [],
      confidence: "high"
    })
  });
  // Another task's integration moved the file outside this task's scope.
  fs.mkdirSync(path.join(root, "lib"), { recursive: true });
  git(root, ["mv", "src/a.txt", "lib/a.txt"]);
  git(root, ["commit", "--quiet", "-m", "move"]);
  run = loadRun(root, "run-rename");
  run.repository.integrationHead = git(root, ["rev-parse", "HEAD"]).trim();
  const task = run.tasks.build;
  task.attempts.at(-1).worktree = worktree;
  assert.equal(inspectTaskWorktree(task, task.attempts.at(-1)).ready, true);
  assert.throws(() => integrateTaskWorktree(root, run, task, task.attempts.at(-1)), /conflict/i);
  assert.equal(fs.readFileSync(path.join(root, "lib/a.txt"), "utf8"), "one\ntwo\nthree\n", "lib/a.txt untouched");
  assert.deepEqual(changedFiles(root), [], "rolled back");
});

function reportFiles(root, runId, attemptId, files) {
  recordTaskResult(root, runId, "build", {
    attemptId,
    resultText: JSON.stringify({
      summary: "Done.",
      files_touched: files,
      tests: [],
      decisions: [],
      assumptions: [],
      blockers: [],
      confidence: "high"
    })
  });
}

test("integration runs no configured merge driver a worker could have changed", () => {
  const root = repo();
  write(root, "src/merge.sh", "#!/bin/sh\nexit 1\n");
  write(root, ".gitattributes", "src/*.dat merge=local\n");
  write(root, "src/x.dat", "a\nb\nc\n");
  git(root, ["add", "-A"]);
  git(root, ["commit", "--quiet", "-m", "base"]);
  git(root, ["config", "merge.local.driver", "sh src/merge.sh %O %A %B"]);
  plan(root, "run-merge-driver");
  checkpointPlan(root, "run-merge-driver");
  const dispatch = claimTask(root, "run-merge-driver", "build", { constraints: [] });
  let run = loadRun(root, "run-merge-driver");
  const worktree = createTaskWorktree(root, run, run.tasks.build, run.tasks.build.attempts.at(-1));
  const marker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "orch-hook-")), "ran");
  repos.push(path.dirname(marker));
  write(worktree.path, "src/merge.sh", `#!/bin/sh\necho ran >> ${JSON.stringify(marker)}\nexit 0\n`);
  git(worktree.path, ["commit", "--quiet", "-am", "driver"]);
  write(worktree.path, "src/x.dat", "A\nb\nc\n");
  git(worktree.path, ["commit", "--quiet", "-am", "data"]);
  reportFiles(root, "run-merge-driver", dispatch.attemptId, ["src/merge.sh", "src/x.dat"]);
  // Another task changed the same file, so the cherry-pick must merge it.
  write(root, "src/x.dat", "a\nb\nC\n");
  git(root, ["commit", "--quiet", "-am", "other task"]);
  run = loadRun(root, "run-merge-driver");
  run.repository.integrationHead = git(root, ["rev-parse", "HEAD"]).trim();
  const task = run.tasks.build;
  task.attempts.at(-1).worktree = worktree;
  assert.throws(() => integrateTaskWorktree(root, run, task, task.attempts.at(-1)), /conflict/i);
  assert.equal(fs.existsSync(marker) ? fs.readFileSync(marker, "utf8") : "", "", "the worker's merge driver did not run");
  assert.equal(fs.readFileSync(path.join(root, "src/merge.sh"), "utf8"), "#!/bin/sh\nexit 1\n", "rolled back");
});

test("integration refuses to overwrite an ignored file in the main checkout", () => {
  const root = repo();
  write(root, "src/.gitignore", "private.txt\n");
  git(root, ["add", "-A"]);
  git(root, ["commit", "--quiet", "-m", "ignore"]);
  write(root, "src/private.txt", "local secret\n");
  plan(root, "run-ignored");
  checkpointPlan(root, "run-ignored");
  const dispatch = claimTask(root, "run-ignored", "build", { constraints: [] });
  let run = loadRun(root, "run-ignored");
  const worktree = createTaskWorktree(root, run, run.tasks.build, run.tasks.build.attempts.at(-1));
  write(worktree.path, "src/.gitignore", "");
  write(worktree.path, "src/private.txt", "worker content\n");
  git(worktree.path, ["add", "-A"]);
  git(worktree.path, ["commit", "--quiet", "-m", "take it"]);
  reportFiles(root, "run-ignored", dispatch.attemptId, ["src/.gitignore", "src/private.txt"]);
  run = loadRun(root, "run-ignored");
  const task = run.tasks.build;
  task.attempts.at(-1).worktree = worktree;
  assert.throws(() => integrateTaskWorktree(root, run, task, task.attempts.at(-1)), /overwrite untracked or ignored files.*src\/private\.txt/);
  assert.equal(fs.readFileSync(path.join(root, "src/private.txt"), "utf8"), "local secret\n");
});

for (const [label, ignored, pattern, added] of [
  ["a parent directory of a path the worker adds", "cache", "cache", "src/cache/item.txt"],
  // .gitignore strips an unescaped trailing space.
  ["a file whose name is a single space", " ", "\\ ", "src/ "]
]) {
test(`integration refuses to overwrite an ignored file at ${label}`, () => {
  const root = repo();
  write(root, "src/.gitignore", `${pattern}\n`);
  git(root, ["add", "-A"]);
  git(root, ["commit", "--quiet", "-m", "ignore"]);
  write(root, `src/${ignored}`, "local data\n");
  plan(root, "run-ignored-parent");
  checkpointPlan(root, "run-ignored-parent");
  const dispatch = claimTask(root, "run-ignored-parent", "build", { constraints: [] });
  let run = loadRun(root, "run-ignored-parent");
  const worktree = createTaskWorktree(root, run, run.tasks.build, run.tasks.build.attempts.at(-1));
  write(worktree.path, "src/.gitignore", "");
  write(worktree.path, added, "worker content\n");
  git(worktree.path, ["add", "-A"]);
  git(worktree.path, ["commit", "--quiet", "-m", "take it"]);
  reportFiles(root, "run-ignored-parent", dispatch.attemptId, ["src/.gitignore", added]);
  run = loadRun(root, "run-ignored-parent");
  const task = run.tasks.build;
  task.attempts.at(-1).worktree = worktree;
  assert.equal(inspectTaskWorktree(task, task.attempts.at(-1)).ready, true);
  assert.throws(() => integrateTaskWorktree(root, run, task, task.attempts.at(-1)), /overwrite untracked or ignored files/);
  assert.equal(fs.readFileSync(path.join(root, "src", ignored), "utf8"), "local data\n");
});
}

test("files at an uninitialized submodule's path in a worker's worktree count as changed", () => {
  const root = repo();
  // A submodule the worker's worktree is created without (an empty directory).
  const sub = makeRepo();
  repos.push(sub);
  git(root, ["-c", "protocol.file.allow=always", "submodule", "add", "--quiet", sub, "src/vendor"]);
  git(root, ["commit", "--quiet", "-m", "submodule"]);
  plan(root, "run-gitlink-files");
  checkpointPlan(root, "run-gitlink-files");
  claimTask(root, "run-gitlink-files", "build", { constraints: [] });
  const run = loadRun(root, "run-gitlink-files");
  const attempt = run.tasks.build.attempts.at(-1);
  const worktree = createTaskWorktree(root, run, run.tasks.build, attempt);
  assert.deepEqual(changedFiles(worktree.path, { gitDir: worktree.gitDir }), [], "an empty submodule directory is no change");
  write(worktree.path, "src/vendor/notes.txt", "only copy\n");
  assert.deepEqual(changedFiles(worktree.path, { gitDir: worktree.gitDir }), ["src/vendor"]);
  assert.throws(() => cleanupTaskWorktree(root, { ...attempt, worktree }), /dirty worktree/);
  assert.equal(fs.readFileSync(path.join(worktree.path, "src/vendor/notes.txt"), "utf8"), "only copy\n");
});

test("a nested repository in a worker's worktree counts as changed, so cleanup keeps it", () => {
  const root = repo();
  plan(root, "run-nested");
  checkpointPlan(root, "run-nested");
  claimTask(root, "run-nested", "build", { constraints: [] });
  const run = loadRun(root, "run-nested");
  const attempt = run.tasks.build.attempts.at(-1);
  const worktree = createTaskWorktree(root, run, run.tasks.build, attempt);
  const nested = path.join(worktree.path, "src", "vendor");
  fs.mkdirSync(nested, { recursive: true });
  git(nested, ["init", "--quiet"]);
  write(nested, "value.txt", "one\n");
  git(nested, ["add", "-A"]);
  git(nested, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", "v"]);
  git(worktree.path, ["add", "-A"]);
  git(worktree.path, ["commit", "--quiet", "-m", "vendor"]);
  write(nested, "value.txt", "uncommitted work\n");
  assert.deepEqual(changedFiles(worktree.path, { gitDir: worktree.gitDir }), ["src/vendor"]);
  assert.throws(() => cleanupTaskWorktree(root, { ...attempt, worktree }), /dirty worktree/);
  assert.equal(fs.readFileSync(path.join(nested, "value.txt"), "utf8"), "uncommitted work\n");
});

for (const reserved of [".orchestrator/local/runs/victim/run.json", ".OrChEsTrAtOr/LOCAL/runs/victim/run.json"]) {
test(`a worker's change to the orchestrator's local state is out of scope even under a scope that covers it (${reserved})`, () => {
  const root = repo();
  plan(root, "run-reserved");
  checkpointPlan(root, "run-reserved");
  const dispatch = claimTask(root, "run-reserved", "build", { constraints: [] });
  let run = loadRun(root, "run-reserved");
  const worktree = createTaskWorktree(root, run, run.tasks.build, run.tasks.build.attempts.at(-1));
  write(worktree.path, reserved, "worker payload\n");
  git(worktree.path, ["add", "-f", reserved]);
  git(worktree.path, ["commit", "--quiet", "-m", "state"]);
  reportFiles(root, "run-reserved", dispatch.attemptId, inspectTaskWorktree(loadRun(root, "run-reserved").tasks.build, { ...loadRun(root, "run-reserved").tasks.build.attempts.at(-1), worktree }).files);
  run = loadRun(root, "run-reserved");
  const task = run.tasks.build;
  task.scope = ["**"];
  task.attempts.at(-1).worktree = worktree;
  const inspection = inspectTaskWorktree(task, task.attempts.at(-1));
  assert.equal(inspection.outOfScope.length, 1);
  assert.equal(inspection.ready, false);
  assert.throws(
    () => integrateTaskWorktree(root, run, task, task.attempts.at(-1)),
    (error) => error.signals?.includes("scope_violation")
  );
});
}

test("run integrate waits for another integration of the same checkout", () => {
  const root = repo();
  plan(root, "run-integrate-lock");
  checkpointPlan(root, "run-integrate-lock");
  const lock = path.join(root, ".orchestrator", "local", "integration.lock");
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, "");
  try {
    const result = runCli(root, ["run", "integrate", "run-integrate-lock", "build", "--evidence", "x"]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /Timed out waiting for state lock .*integration\.lock/);
  } finally {
    fs.rmSync(lock, { force: true });
  }
});

test("cleanup refuses a worker worktree with an uncommitted edit to a tracked .orchestrator file", () => {
  const root = repo();
  write(root, ".orchestrator/notes.md", "tracked\n");
  git(root, ["add", "-f", ".orchestrator/notes.md"]);
  git(root, ["commit", "--quiet", "-m", "notes"]);
  plan(root, "run-cleanup-ledger");
  checkpointPlan(root, "run-cleanup-ledger");
  claimTask(root, "run-cleanup-ledger", "build", { constraints: [] });
  const run = loadRun(root, "run-cleanup-ledger");
  const worktree = createTaskWorktree(root, run, run.tasks.build, run.tasks.build.attempts.at(-1));
  write(worktree.path, ".orchestrator/notes.md", "edited by the worker\n");
  assert.throws(() => cleanupTaskWorktree(root, { worktree }), /Refusing to remove dirty worktree/);
  assert.equal(fs.readFileSync(path.join(worktree.path, ".orchestrator/notes.md"), "utf8"), "edited by the worker\n");
});

test("worktree inspection rejects out-of-scope files", () => {
  const root = repo();
  plan(root, "run-scope");
  checkpointPlan(root, "run-scope");
  const dispatch = claimTask(root, "run-scope", "build", { constraints: [] });
  const run = loadRun(root, "run-scope");
  const task = run.tasks.build;
  const attempt = task.attempts.at(-1);
  attempt.worktree = createTaskWorktree(root, run, task, attempt);
  write(attempt.worktree.path, "docs/oops.md", "outside\n");
  git(attempt.worktree.path, ["add", "docs/oops.md"]);
  git(attempt.worktree.path, ["commit", "--quiet", "-m", "Add outside file"]);
  recordTaskResult(root, "run-scope", "build", {
    attemptId: dispatch.attemptId,
    resultText: JSON.stringify({
      summary: "Changed the wrong file.",
      files_touched: ["docs/oops.md"],
      tests: [],
      decisions: [],
      assumptions: [],
      blockers: [],
      confidence: "high"
    })
  });
  task.result = loadRun(root, "run-scope").tasks.build.result;
  const inspection = inspectTaskWorktree(task, attempt);
  assert.equal(inspection.ready, false);
  assert.deepEqual(inspection.outOfScope, ["docs/oops.md"]);
});

test("worker launch rejects supervisor branch drift outside the run", () => {
  const root = repo();
  plan(root, "run-drift");
  checkpointPlan(root, "run-drift");
  write(root, "src/manual.js", "export const manual = true;\n");
  git(root, ["add", "src/manual.js"]);
  git(root, ["commit", "--quiet", "-m", "Add manual change"]);

  assert.throws(
    () => launchTaskWorker(root, "run-drift", "build", { constraints: [] }, {
      codexCommand: [process.execPath, fixture]
    }),
    /advanced outside run/
  );
  assert.equal(loadRun(root, "run-drift").tasks.build.status, "failed");
  assert.equal(
    loadRun(root, "run-drift").tasks.build.attempts.at(-1).outcome.terminalOutcome,
    "execution_failed"
  );
});

test("detached workers persist status, thread id, and structured results", async () => {
  const root = repo();
  plan(root, "run-worker", { taskModel: "terra", taskEffort: "medium" });
  checkpointPlan(root, "run-worker");
  const launched = launchTaskWorker(root, "run-worker", "build", { constraints: [] }, {
    codexCommand: [process.execPath, fixture]
  });
  assert.equal(launched.model, "gpt-6.1-terra");
  assert.equal(launched.reasoningEffort, "medium");
  assert.ok(launched.runner.pid > 0);
  assert.ok(fs.existsSync(launched.worktree.path));
  const spec = JSON.parse(fs.readFileSync(launched.runner.specFile, "utf8"));
  assert.equal(spec.model, "gpt-6.1-terra");
  assert.equal(spec.reasoningEffort, "medium");

  let update;
  for (let index = 0; index < 50; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    update = pollRunWorkers(root, "run-worker")[0];
    if (update && !["running", "dispatching"].includes(update.status)) {
      break;
    }
  }
  assert.equal(update.status, "reported");
  assert.equal(update.threadId, "thread-fake");
  const task = loadRun(root, "run-worker").tasks.build;
  assert.equal(task.result.structured.summary, "Fake worker completed.");
  assert.equal(task.attempts.at(-1).threadId, "thread-fake");
  assert.equal(task.attempts.at(-1).runner.status, "completed");
  assert.ok(task.attempts.at(-1).runner.childPid > 0);
});

test("worker collection distinguishes missing contracts from execution failures", async () => {
  const root = repo();
  plan(root, "run-no-result");
  checkpointPlan(root, "run-no-result");
  launchTaskWorker(root, "run-no-result", "build", { constraints: [] }, {
    codexCommand: [process.execPath, noResultFixture]
  });
  let noResult;
  for (let index = 0; index < 100; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 30));
    noResult = pollRunWorkers(root, "run-no-result")[0];
    if (noResult && !["running", "dispatching"].includes(noResult.status)) {
      break;
    }
  }
  assert.equal(noResult.status, "failed");
  assert.equal(
    loadRun(root, "run-no-result").tasks.build.attempts.at(-1).outcome.terminalOutcome,
    "contract_failed"
  );

  plan(root, "run-process-fail");
  checkpointPlan(root, "run-process-fail");
  launchTaskWorker(root, "run-process-fail", "build", { constraints: [] }, {
    codexCommand: [process.execPath, failedFixture]
  });
  let processFailure;
  for (let index = 0; index < 100; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 30));
    processFailure = pollRunWorkers(root, "run-process-fail")[0];
    if (processFailure && !["running", "dispatching"].includes(processFailure.status)) {
      break;
    }
  }
  assert.equal(processFailure.status, "failed");
  assert.equal(
    loadRun(root, "run-process-fail").tasks.build.attempts.at(-1).outcome.terminalOutcome,
    "execution_failed"
  );
});

test("the pool runs independent ready tasks in separate detached worktrees", async () => {
  const root = repo();
  createRun(root, {
    id: "run-pool-e2e",
    lane: "api",
    objective: "Inspect in parallel",
    maxWorkers: 2,
    workerModel: "sol",
    reasoningEffort: "high"
  });
  replacePlan(root, "run-pool-e2e", [
    { id: "inspect-a", title: "Inspect A", objective: "Inspect A", kind: "read" },
    { id: "inspect-b", title: "Inspect B", objective: "Inspect B", kind: "read" }
  ]);
  checkpointPlan(root, "run-pool-e2e");
  const first = launchTaskWorker(root, "run-pool-e2e", "inspect-a", { constraints: [] }, {
    codexCommand: [process.execPath, fixture]
  });
  checkpointPlan(root, "run-pool-e2e");
  const second = launchTaskWorker(root, "run-pool-e2e", "inspect-b", { constraints: [] }, {
    codexCommand: [process.execPath, fixture]
  });
  assert.notEqual(first.runner.pid, second.runner.pid);
  assert.notEqual(first.worktree.path, second.worktree.path);

  for (let index = 0; index < 100; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    pollRunWorkers(root, "run-pool-e2e");
    const statuses = Object.values(loadRun(root, "run-pool-e2e").tasks)
      .map((task) => task.status);
    if (statuses.every((status) => status === "reported")) {
      break;
    }
  }
  let run = loadRun(root, "run-pool-e2e");
  assert.deepEqual(
    Object.values(run.tasks).map((task) => task.status),
    ["reported", "reported"]
  );
  for (const task of Object.values(run.tasks)) {
    assert.equal(task.result.structured.summary, "Fake worker completed.");
    verifyTask(root, "run-pool-e2e", task.id, {
      verdict: "pass",
      evidence: [`${task.id} evidence reviewed`]
    });
  }
  run = loadRun(root, "run-pool-e2e");
  assert.equal(run.status, "finalizing");
  for (const task of Object.values(run.tasks)) {
    assert.equal(cleanupTaskWorktree(root, task.attempts.at(-1)), true);
  }
});

/** Wait for a runner's status file to reach a terminal state. */
async function runnerDone(statusFile) {
  for (let index = 0; index < 200; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 40));
    try {
      const status = JSON.parse(fs.readFileSync(statusFile, "utf8"));
      if (["completed", "failed", "cancelled"].includes(status.status)) {
        return status;
      }
    } catch {
      // Not written yet.
    }
  }
  throw new Error("runner did not finish");
}

test("the wrapper commits a locked-down write worker's changes, with no hook from the worktree run", async () => {
  const root = repo();
  // A repository whose hooks live in the tree, as with husky: a worker could edit them.
  git(root, ["config", "core.hooksPath", ".husky"]);
  plan(root, "run-wrapper-commit");
  checkpointPlan(root, "run-wrapper-commit");
  const marker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "orch-hook-")), "ran");
  repos.push(path.dirname(marker));
  const launched = launchTaskWorker(root, "run-wrapper-commit", "build", { constraints: [] }, {
    codexCommand: [process.execPath, writeFixture, "--no-commit", `--hooks=${marker}`]
  });
  const status = await runnerDone(launched.runner.statusFile);
  assert.equal(status.status, "completed");
  assert.equal(fs.existsSync(marker), false, "no hook from the worktree ran outside the sandbox");
  const worktree = launched.worktree.path;
  assert.equal(git(worktree, ["status", "--porcelain"]).trim(), "", "every change is committed");
  assert.equal(git(worktree, ["log", "-1", "--format=%s"]).trim(), "Build");
  assert.match(git(worktree, ["log", "-1", "--format=%b"]), /Orchestrator task build, build-attempt-1\./);
  const files = git(worktree, ["show", "--name-only", "--format=", "HEAD"]).trim().split("\n").sort();
  assert.deepEqual(files, [".husky/commit-msg", ".husky/post-commit", ".husky/pre-commit", "src/generated.js"]);
});

test("a worker that re-aims its worktree's .git pointer cannot run code through the wrapper or inspection", async () => {
  const root = repo();
  plan(root, "run-wrapper-hijack");
  checkpointPlan(root, "run-wrapper-hijack");
  const marker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "orch-hijack-")), "ran");
  repos.push(path.dirname(marker));
  const launched = launchTaskWorker(root, "run-wrapper-hijack", "build", { constraints: [] }, {
    codexCommand: [process.execPath, writeFixture, "--no-commit", `--hijack-git=${marker}`]
  });
  const status = await runnerDone(launched.runner.statusFile);
  assert.equal(status.status, "completed", status.error);
  assert.equal(fs.existsSync(marker) ? fs.readFileSync(marker, "utf8") : "", "", "the wrapper did not run the planted fsmonitor");
  // The commit landed on the worker's real branch, not in the planted repository.
  const branch = launched.worktree.branch;
  assert.equal(git(root, ["log", "-1", "--format=%s", branch]).trim(), "Build");
  const run = loadRun(root, "run-wrapper-hijack");
  const task = run.tasks.build;
  inspectTaskWorktree(task, task.attempts.at(-1));
  assert.equal(fs.existsSync(marker) ? fs.readFileSync(marker, "utf8") : "", "", "inspection did not run the planted fsmonitor");
  // A record from before the git directory was recorded resolves it from the
  // supervisor repository, or refuses without one.
  const legacy = { ...task.attempts.at(-1), worktree: { ...task.attempts.at(-1).worktree, gitDir: undefined } };
  inspectTaskWorktree(task, legacy, { cwd: root });
  assert.equal(fs.existsSync(marker) ? fs.readFileSync(marker, "utf8") : "", "", "a legacy record did not run it either");
  assert.throws(() => inspectTaskWorktree(task, legacy), /no recorded git directory/);
});

test("no filter a worker attributed runs when its changes are committed or inspected", async () => {
  const root = repo();
  // A repository that runs an in-tree script as a filter, which a worker can edit.
  git(root, ["config", "filter.local.clean", "sh filter.sh"]);
  git(root, ["config", "filter.local.smudge", "sh filter.sh"]);
  git(root, ["config", "filter.local.process", "sh filter.sh"]);
  // The repository's own attributes outside the tree select the filter too.
  fs.writeFileSync(path.join(root, ".git", "info", "attributes"), "*.dat filter=local\n");
  plan(root, "run-wrapper-filter");
  checkpointPlan(root, "run-wrapper-filter");
  const marker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "orch-hook-")), "ran");
  repos.push(path.dirname(marker));
  const launched = launchTaskWorker(root, "run-wrapper-filter", "build", { constraints: [] }, {
    codexCommand: [process.execPath, writeFixture, "--no-commit", `--filter=${marker}`]
  });
  const status = await runnerDone(launched.runner.statusFile);
  assert.equal(status.status, "completed", status.error);
  const task = loadRun(root, "run-wrapper-filter").tasks.build;
  inspectTaskWorktree(task, task.attempts.at(-1));
  assert.equal(fs.existsSync(marker) ? fs.readFileSync(marker, "utf8") : "", "", "no worker-attributed filter ran");
});

test("integrating a worker's commits runs no hook it changed", async () => {
  const root = repo();
  git(root, ["config", "core.hooksPath", "src/hooks"]);
  plan(root, "run-integrate-hook");
  checkpointPlan(root, "run-integrate-hook");
  const marker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "orch-hook-")), "ran");
  repos.push(path.dirname(marker));
  const launched = launchTaskWorker(root, "run-integrate-hook", "build", { constraints: [] }, {
    codexCommand: [process.execPath, writeFixture, "--no-commit", `--hooks=${marker}`, "--hooks-dir=src/hooks", "--declare-hooks"]
  });
  await runnerDone(launched.runner.statusFile);
  let update;
  for (let index = 0; index < 100; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    update = pollRunWorkers(root, "run-integrate-hook")[0];
    if (update && !["running", "dispatching"].includes(update.status)) {
      break;
    }
  }
  const run = loadRun(root, "run-integrate-hook");
  const task = run.tasks.build;
  const inspection = inspectTaskWorktree(task, task.attempts.at(-1));
  assert.equal(inspection.ready, true, JSON.stringify(inspection));
  integrateTaskWorktree(root, run, task, task.attempts.at(-1));
  assert.ok(fs.existsSync(path.join(root, "src", "hooks", "post-commit")), "the hook was integrated");
  assert.equal(fs.existsSync(marker) ? fs.readFileSync(marker, "utf8") : "", "", "no integrated hook ran during integration");
});

test("a worker whose wrapper died without a final status is failed by poll, not left running", async () => {
  const root = repo();
  plan(root, "run-dead-wrapper");
  checkpointPlan(root, "run-dead-wrapper");
  const pidFile = path.join(path.dirname(runFile(root, "run-dead-wrapper")), "descendant.pid");
  const launched = launchTaskWorker(root, "run-dead-wrapper", "build", { constraints: [] }, {
    codexCommand: [process.execPath, slowFixture, "--delay=60000", `--descendant=${pidFile}`, "--quiet-descendant"]
  });
  for (let index = 0; index < 100; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 40));
    if (fs.existsSync(launched.runner.statusFile) &&
        JSON.parse(fs.readFileSync(launched.runner.statusFile, "utf8")).childPid) {
      break;
    }
  }
  const { childPid } = JSON.parse(fs.readFileSync(launched.runner.statusFile, "utf8"));
  while (!fs.existsSync(pidFile)) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const descendant = Number(fs.readFileSync(pidFile, "utf8"));
  process.kill(launched.runner.pid, "SIGKILL");
  let update;
  for (let index = 0; index < 100; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 40));
    update = pollRunWorkers(root, "run-dead-wrapper")[0];
    if (update && !["running", "dispatching"].includes(update.status)) {
      break;
    }
  }
  const task = loadRun(root, "run-dead-wrapper").tasks.build;
  try {
    assert.equal(task.status, "failed");
    assert.match(task.attempts[0].error, /exited without a final status/);
    // Its Codex and what Codex started do not keep running in the freed slot.
    assert.ok(await exited(childPid), `Codex ${childPid} outlived its failed task`);
    assert.ok(await exited(descendant), `descendant ${descendant} outlived its failed task`);
  } finally {
    for (const pid of [childPid, descendant]) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }
});

test("cancelling a worker whose wrapper is gone kills what Codex started", async () => {
  const root = repo();
  plan(root, "run-dead-cancel");
  checkpointPlan(root, "run-dead-cancel");
  const pidFile = path.join(path.dirname(runFile(root, "run-dead-cancel")), "descendant.pid");
  const launched = launchTaskWorker(root, "run-dead-cancel", "build", { constraints: [] }, {
    codexCommand: [process.execPath, slowFixture, "--delay=60000", `--descendant=${pidFile}`, "--quiet-descendant"]
  });
  while (!fs.existsSync(pidFile)) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const descendant = Number(fs.readFileSync(pidFile, "utf8"));
  process.kill(launched.runner.pid, "SIGKILL");
  assert.ok(await exited(launched.runner.pid), "wrapper gone");
  try {
    cancelWorkers(root, "run-dead-cancel", "build", "user stopped it");
    // The descendant ignores SIGTERM, and no wrapper is left to escalate.
    assert.ok(await exited(descendant), `descendant ${descendant} survived the cancellation`);
  } finally {
    try {
      process.kill(descendant, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
});

for (const action of ["cancel", "poll"]) {
test(`${action} stops same-group children after their wrapper has died`, async () => {
  const root = repo();
  const id = `run-wrapper-group-${action}`;
  plan(root, id);
  checkpointPlan(root, id);
  const dispatch = claimTask(root, id, "build", { constraints: [] });
  const directory = path.dirname(runFile(root, id));
  const pidFile = path.join(directory, "same-group.pid");
  const wrapper = spawn(process.execPath, ["-e", `
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
    setInterval(() => {}, 1000);
  `], { detached: true, stdio: "ignore" });
  const statusFile = path.join(directory, "wrapper-status.json");
  const startedAt = new Date().toISOString();
  fs.writeFileSync(statusFile, JSON.stringify({ pid: wrapper.pid, startedAt, status: "running" }));
  attachExecution(root, id, "build", { attemptId: dispatch.attemptId, runner: { pid: wrapper.pid, statusFile, launchedAt: startedAt } });
  try {
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(pidFile) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const child = Number(fs.readFileSync(pidFile, "utf8"));
    process.kill(wrapper.pid, "SIGKILL");
    assert.ok(await exited(wrapper.pid));
    if (action === "cancel") cancelWorkers(root, id, "build", "stop it");
    else pollRunWorkers(root, id);
    assert.ok(await exited(child), "the wrapper's child did not survive the freed task slot");
    assert.equal(loadRun(root, id).tasks.build.status, action === "cancel" ? "cancelled" : "failed");
  } finally {
    try { process.kill(-wrapper.pid, "SIGKILL"); } catch { /* Already gone. */ }
  }
});
}

test("a cancel leaves nothing of the worker running once it returns", async () => {
  const root = repo();
  plan(root, "run-cancel-sync");
  checkpointPlan(root, "run-cancel-sync");
  const launched = launchTaskWorker(root, "run-cancel-sync", "build", { constraints: [] }, {
    codexCommand: [process.execPath, slowFixture, "--delay=60000", "--ignore-term"]
  });
  // Codex's own pid: once it reports its thread (a read worker's first
  // recorded child is the profile probe).
  let childPid;
  while (!childPid) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    const status = fs.existsSync(launched.runner.statusFile) &&
      JSON.parse(fs.readFileSync(launched.runner.statusFile, "utf8"));
    childPid = status?.threadId ? status.childPid : null;
  }
  try {
    // Codex ignores SIGTERM. The cancel escalates itself, so a wrapper that
    // dies during the grace period cannot leave Codex running with no one to
    // kill it.
    cancelWorkers(root, "run-cancel-sync", "build", "user stopped it");
    try {
      process.kill(launched.runner.pid, "SIGKILL");
    } catch {
      // Already gone.
    }
    assert.ok(await exited(childPid, 1000), `Codex ${childPid} still running after cancel returned`);
  } finally {
    try {
      process.kill(childPid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
});

test("cancelling stops a cancelled attempt's worker even after a retry launched another", async () => {
  const root = repo();
  plan(root, "run-cancel-hidden");
  checkpointPlan(root, "run-cancel-hidden");
  const first = launchTaskWorker(root, "run-cancel-hidden", "build", { constraints: [] }, {
    codexCommand: [process.execPath, slowFixture, "--delay=60000"]
  });
  // Attempt 1's cancellation is saved while its worker is still attaching, so
  // nothing stops it; then a retry launches attempt 2.
  cancelTask(root, "run-cancel-hidden", "build", "user stopped it");
  retryTask(root, "run-cancel-hidden", "build", { note: "Again.", fresh: true });
  checkpointPlan(root, "run-cancel-hidden");
  const second = launchTaskWorker(root, "run-cancel-hidden", "build", { constraints: [] }, {
    codexCommand: [process.execPath, slowFixture, "--delay=60000"]
  });
  try {
    cancelWorkers(root, "run-cancel-hidden", "build", "user stopped it again");
    assert.ok(await exited(second.runner.pid, 10000), "attempt 2's wrapper stopped");
    assert.ok(await exited(first.runner.pid, 10000), "attempt 1's wrapper stopped too");
  } finally {
    for (const pid of [first.runner.pid, second.runner.pid]) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }
});

test("run cleanup leaves a cancelled task alone while its worker is still running", async () => {
  const root = repo();
  plan(root, "run-cleanup-live");
  checkpointPlan(root, "run-cleanup-live");
  const launched = launchTaskWorker(root, "run-cleanup-live", "build", { constraints: [] }, {
    codexCommand: [process.execPath, slowFixture, "--delay=60000"]
  });
  // Cancelled as the worker attached: nothing has stopped it yet.
  cancelTask(root, "run-cleanup-live", "build", "user stopped it");
  try {
    const result = runCli(root, ["run", "cleanup", "run-cleanup-live"]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /still running/);
    assert.equal(fs.existsSync(launched.worktree.path), true);
  } finally {
    cancelWorkers(root, "run-cleanup-live", "build", "stop it");
  }
  assert.equal(runCli(root, ["run", "cleanup", "run-cleanup-live"]).code, 0);
  assert.equal(fs.existsSync(launched.worktree.path), false);
});

const psWorks = (() => {
  try {
    execFileSync("ps", ["-o", "lstart=", "-p", String(process.pid)], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

test("a recorded pid that now belongs to another process is neither taken for the worker nor signalled", { skip: !psWorks && "ps is not available here" }, async () => {
  const root = repo();
  plan(root, "run-pid-reuse");
  checkpointPlan(root, "run-pid-reuse");
  const launched = launchTaskWorker(root, "run-pid-reuse", "build", { constraints: [] }, {
    codexCommand: [process.execPath, slowFixture, "--delay=60000"]
  });
  let status;
  while (!status?.childPid) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    status = fs.existsSync(launched.runner.statusFile) && JSON.parse(fs.readFileSync(launched.runner.statusFile, "utf8"));
  }
  process.kill(launched.runner.pid, "SIGKILL");
  process.kill(-status.childPid, "SIGKILL");
  // An unrelated process (its own group leader) now has the recorded pids.
  const stranger = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
  try {
    const old = new Date(Date.now() - 3600 * 1000).toISOString();
    fs.writeFileSync(launched.runner.statusFile, JSON.stringify({
      ...status, pid: stranger.pid, startedAt: old, childPid: stranger.pid, childStartedAt: old
    }));
    pollRunWorkers(root, "run-pid-reuse");
    assert.equal(loadRun(root, "run-pid-reuse").tasks.build.status, "failed", "the dead wrapper is noticed");
    assert.ok(!(await exited(stranger.pid, 500)), "the unrelated process was not signalled");
  } finally {
    stranger.kill("SIGKILL");
  }
});

test("a wrapper that dies after starting Codex takes Codex's group with it", async () => {
  const root = repo();
  plan(root, "run-wrapper-crash");
  checkpointPlan(root, "run-wrapper-crash");
  // Codex starts a process that ignores SIGTERM and holds no pipes, so only a
  // group kill ends it; the wrapper's second status write fails (a full disk).
  const pidFile = path.join(path.dirname(runFile(root, "run-wrapper-crash")), "descendant.pid");
  const saved = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = `--import=${path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fail-status-write.mjs")}`;
  let launched;
  try {
    launched = launchTaskWorker(root, "run-wrapper-crash", "build", { constraints: [] }, {
      codexCommand: [process.execPath, slowFixture, "--delay=60000", `--descendant=${pidFile}`, "--quiet-descendant"]
    });
  } finally {
    if (saved === undefined) {
      delete process.env.NODE_OPTIONS;
    } else {
      process.env.NODE_OPTIONS = saved;
    }
  }
  assert.ok(await exited(launched.runner.pid, 5000), "the wrapper died on the failed write");
  assert.equal(JSON.parse(fs.readFileSync(launched.runner.statusFile, "utf8")).childPid, undefined, "Codex was never recorded");
  // Codex is killed with the wrapper, before or after it started its process.
  await new Promise((resolve) => setTimeout(resolve, 2000));
  const descendant = fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, "utf8")) : null;
  try {
    assert.ok(!descendant || await exited(descendant, 1000), `descendant ${descendant} outlived its wrapper`);
  } finally {
    try {
      if (descendant) {
        process.kill(descendant, "SIGKILL");
      }
    } catch {
      // Already gone.
    }
  }
});

test("cancelling a wrapper stuck in its commit kills it and the git it runs", async () => {
  const root = repo();
  plan(root, "run-stuck-commit");
  checkpointPlan(root, "run-stuck-commit");
  const launched = launchTaskWorker(root, "run-stuck-commit", "build", { constraints: [] }, {
    codexCommand: [process.execPath, writeFixture, "--no-commit", "--fifo"]
  });
  // Codex finishes; the wrapper's `git add -A` then blocks reading the FIFO.
  let status;
  for (let index = 0; index < 200 && !status?.threadId; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 40));
    status = fs.existsSync(launched.runner.statusFile) && JSON.parse(fs.readFileSync(launched.runner.statusFile, "utf8"));
  }
  await new Promise((resolve) => setTimeout(resolve, 1000));
  try {
    cancelWorkers(root, "run-stuck-commit", "build", "user stopped it");
    assert.ok(await exited(launched.runner.pid, 2000), "the stuck wrapper was killed");
  } finally {
    try {
      process.kill(-launched.runner.pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
});

for (const alias of [".ORCHESTRATOR/LOCAL", ".orche\u017Ftrator/local"]) {
test(`integration refuses a path that reaches the orchestrator's local state through an alias (${alias})`, (t) => {
  const root = repo();
  fs.mkdirSync(path.join(root, ".orchestrator", "local"), { recursive: true });
  let sameDirectory = false;
  try {
    sameDirectory = fs.statSync(path.join(root, alias)).ino === fs.statSync(path.join(root, ".orchestrator", "local")).ino;
  } catch {
    sameDirectory = false;
  }
  if (!sameDirectory) {
    t.skip("this filesystem does not alias the name");
    return;
  }
  plan(root, "run-alias");
  checkpointPlan(root, "run-alias");
  const dispatch = claimTask(root, "run-alias", "build", { constraints: [] });
  let run = loadRun(root, "run-alias");
  const worktree = createTaskWorktree(root, run, run.tasks.build, run.tasks.build.attempts.at(-1));
  // Committed under the alias spelling, as the wrapper's git add would.
  const file = `${alias}/injected.json`;
  const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: worktree.path, input: "worker payload\n", encoding: "utf8" }).trim();
  git(worktree.path, ["update-index", "--add", "--cacheinfo", `100644,${blob},${file}`]);
  git(worktree.path, ["commit", "--quiet", "-m", "state"]);
  git(worktree.path, ["checkout", "HEAD", "--", file]);
  reportFiles(root, "run-alias", dispatch.attemptId, [file]);
  run = loadRun(root, "run-alias");
  const task = run.tasks.build;
  task.scope = ["**"];
  task.attempts.at(-1).worktree = worktree;
  // The case alias is already out of scope at inspection; the Unicode alias
  // passes inspection and is caught by the filesystem check.
  assert.throws(
    () => integrateTaskWorktree(root, run, task, task.attempts.at(-1)),
    alias.startsWith(".ORCH") ? /did not pass integration inspection/ : /local state through/
  );
  assert.equal(fs.existsSync(path.join(root, ".orchestrator", "local", "injected.json")), false);
});
}

async function exited(pid, ms = 3000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  return false;
}

test("a write worker paused for input keeps its changes uncommitted, and a failed commit fails the worker", async () => {
  const root = repo();
  plan(root, "run-wrapper-pause");
  checkpointPlan(root, "run-wrapper-pause");
  const paused = launchTaskWorker(root, "run-wrapper-pause", "build", { constraints: [] }, {
    codexCommand: [process.execPath, writeFixture, "--no-commit", "--ask"]
  });
  assert.equal((await runnerDone(paused.runner.statusFile)).status, "completed");
  const base = paused.worktree.baseHead;
  assert.equal(git(paused.worktree.path, ["rev-parse", "HEAD"]).trim(), base, "nothing committed at a pause");
  assert.match(git(paused.worktree.path, ["status", "--porcelain"]), /src\//);

  const root2 = repo();
  plan(root2, "run-wrapper-fail");
  checkpointPlan(root2, "run-wrapper-fail");
  const failing = launchTaskWorker(root2, "run-wrapper-fail", "build", { constraints: [] }, {
    codexCommand: [process.execPath, writeFixture, "--no-commit", "--lock-index"]
  });
  const status = await runnerDone(failing.runner.statusFile);
  assert.equal(status.status, "failed");
  assert.match(status.error, /git add failed/);
});

test("a detached write worker completes the full launch, inspect, integrate, finalize, and cleanup lifecycle", async () => {
  const root = repo();
  plan(root, "run-e2e");
  checkpointPlan(root, "run-e2e");
  const launched = launchTaskWorker(root, "run-e2e", "build", { constraints: [] }, {
    codexCommand: [process.execPath, writeFixture]
  });

  let update;
  for (let index = 0; index < 100; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    update = pollRunWorkers(root, "run-e2e")[0];
    if (update && !["running", "dispatching"].includes(update.status)) {
      break;
    }
  }
  assert.equal(update.status, "reported");
  assert.equal(update.threadId, "thread-fake-write");

  let run = loadRun(root, "run-e2e");
  let task = run.tasks.build;
  const attempt = task.attempts.at(-1);
  const inspection = inspectTaskWorktree(task, attempt);
  assert.equal(inspection.ready, true);
  assert.deepEqual(inspection.files, ["src/generated.js"]);

  const integrated = integrateTaskWorktree(root, run, task, attempt);
  const recorded = recordIntegration(root, "run-e2e", "build", {
    evidence: ["worker check passed", "scope and declaration inspection passed"],
    ...integrated
  });
  assert.equal(recorded.runStatus, "finalizing");
  assert.equal(recorded.task.attempts.at(-1).outcome.terminalOutcome, "accepted");
  assert.equal(
    fs.readFileSync(path.join(root, "src", "generated.js"), "utf8"),
    "export const generated = true;\n"
  );

  run = finalizeRun(root, "run-e2e", {
    verdict: "pass",
    summary: "The write-worker lifecycle completed.",
    evidence: ["generated module present after integration"]
  });
  assert.equal(run.status, "completed");
  assert.equal(cleanupTaskWorktree(root, attempt), true);
  assert.equal(fs.existsSync(launched.worktree.path), false);
});

test("detached workers can be stopped without losing their durable handle", async () => {
  const root = repo();
  plan(root, "run-stop");
  checkpointPlan(root, "run-stop");
  launchTaskWorker(root, "run-stop", "build", { constraints: [] }, {
    codexCommand: [process.execPath, slowFixture]
  });
  let attempt;
  for (let index = 0; index < 50; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    attempt = loadRun(root, "run-stop").tasks.build.attempts.at(-1);
    if (fs.existsSync(attempt.runner.statusFile)) {
      break;
    }
  }
  assert.equal(stopTaskWorker(attempt), true);
  const status = JSON.parse(fs.readFileSync(attempt.runner.statusFile, "utf8"));
  assert.equal(status.status, "cancelled");
  assert.equal(status.pid, attempt.runner.pid);
  const update = pollRunWorkers(root, "run-stop")[0];
  assert.equal(update.status, "cancelled");
  const cancelled = loadRun(root, "run-stop").tasks.build.attempts.at(-1);
  assert.equal(cancelled.outcome.terminalOutcome, "cancelled");
});

test("the worker result schema satisfies structured-output requirements", () => {
  // OpenAI structured outputs reject any object schema whose `required` array
  // omits a declared property key. A worker that fails this check exits before
  // reading its briefing, so every run launch breaks identically.
  const visit = (schema, pointer) => {
    if (!schema || typeof schema !== "object") {
      return;
    }
    if (schema.type === "object" || schema.properties) {
      const declared = Object.keys(schema.properties ?? {});
      const required = schema.required ?? [];
      assert.deepEqual(
        declared.filter((key) => !required.includes(key)),
        [],
        `${pointer} declares properties missing from required`
      );
      assert.equal(
        schema.additionalProperties,
        false,
        `${pointer} must set additionalProperties to false`
      );
      for (const [key, child] of Object.entries(schema.properties ?? {})) {
        visit(child, `${pointer}/${key}`);
      }
    }
    if (schema.items) {
      visit(schema.items, `${pointer}/items`);
    }
  };
  visit(WORKER_RESULT_SCHEMA, "#");
});

test("an optional worker field stays expressible as null", () => {
  const blockerCode = WORKER_RESULT_SCHEMA.properties.blocker_code;
  assert.ok(
    blockerCode.type.includes("null"),
    "blocker_code must accept null so a successful worker is not forced to invent a blocker"
  );
  assert.ok(blockerCode.enum.includes(null));
  assert.ok(blockerCode.enum.includes("missing_context"));
});

test("a worker request is a nullable, strict nested object", () => {
  const request = WORKER_RESULT_SCHEMA.properties.needs_input;
  assert.ok(WORKER_RESULT_SCHEMA.required.includes("needs_input"));
  assert.deepEqual(request.type, ["object", "null"]);
  assert.deepEqual(request.properties.kind.enum, ["scope_extension", "question"]);
  assert.deepEqual(request.required, ["kind", "paths", "reason", "question", "options"]);
  assert.equal(request.additionalProperties, false);
  assert.ok(request.properties.question.type.includes("null"));
});

test("an API rejection reported on stdout is surfaced as the failure reason", async () => {
  // Codex writes API-level rejections to the event stream, not stderr. Without
  // reading it back the supervisor records only "Codex exited 1" and the real
  // cause has to be dug out of events.jsonl by hand.
  const root = makeRepo();
  after(() => cleanup(root));
  const apiErrorFixture = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "fixtures",
    "fake-codex-api-error.mjs"
  );
  plan(root, "run-api-error");
  checkpointPlan(root, "run-api-error");
  launchTaskWorker(root, "run-api-error", "build", { constraints: [] }, {
    codexCommand: [process.execPath, apiErrorFixture]
  });
  let update;
  for (let index = 0; index < 100; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 30));
    update = pollRunWorkers(root, "run-api-error")[0];
    if (update && !["running", "dispatching"].includes(update.status)) {
      break;
    }
  }
  assert.equal(update.status, "failed");
  assert.match(update.error, /Invalid schema for response_format/);
  assert.doesNotMatch(update.error, /^Codex exited/);
});

const unavailableFixture = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "fake-codex-model-unavailable.mjs"
);

async function pollUntil(root, runId, done, attempts = 150) {
  const seen = [];
  for (let index = 0; index < attempts; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 30));
    seen.push(...pollRunWorkers(root, runId));
    if (done(loadRun(root, runId))) {
      return seen;
    }
  }
  throw new Error(`Run ${runId} did not settle: ${JSON.stringify(seen)}`);
}

function runEvents(root, runId) {
  return fs.readFileSync(eventsFile(root, runId), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

test("model unavailability is read only from top-level rejections that name the slug", () => {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "orch-events-"));
  after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "events.jsonl");
  const writeEvents = (events) =>
    fs.writeFileSync(file, events.map((event) => JSON.stringify(event)).join("\n"));

  writeEvents([
    { type: "thread.started", thread_id: "t" },
    {
      type: "item.completed",
      item: { type: "error", message: "Model metadata for `gpt-6-astra` not found. Defaulting to fallback metadata." }
    }
  ]);
  assert.equal(modelUnavailableError(file, "gpt-6-astra"), null);

  writeEvents([{ type: "error", message: "The 'gpt-6-astra' model is not supported when using Codex with a ChatGPT account." }]);
  assert.match(modelUnavailableError(file, "gpt-6-astra"), /not supported/);
  assert.equal(modelUnavailableError(file, "gpt-6.1-sol"), null);

  writeEvents([{ type: "error", error: { message: "Invalid schema for response_format 'codex_output_schema'." } }]);
  assert.equal(modelUnavailableError(file, "gpt-6-astra"), null);

  writeEvents([{ type: "turn.failed", error: { code: "model_not_found", message: "The model `gpt-6-astra` does not exist or you do not have access to it." } }]);
  assert.match(modelUnavailableError(file, "gpt-6-astra"), /do not have access/);

  // After the worker has done anything, an error naming the model is a mid-run
  // failure, not a launch rejection.
  writeEvents([
    { type: "thread.started", thread_id: "t" },
    { type: "turn.started" },
    { type: "item.completed", item: { type: "command_execution", command: "git commit -m work" } },
    { type: "error", message: "The model gpt-6-astra is currently unavailable. Please try again later." },
    { type: "turn.failed", error: { message: "The model gpt-6-astra is currently unavailable." } }
  ]);
  assert.equal(modelUnavailableError(file, "gpt-6-astra"), null);
  writeEvents([
    { type: "turn.completed" },
    { type: "error", message: "The 'gpt-6-astra' model is not supported when using Codex with a ChatGPT account." }
  ]);
  assert.equal(modelUnavailableError(file, "gpt-6-astra"), null);

  // An outage before any work is still not an entitlement rejection.
  for (const message of [
    "The model gpt-6-astra is currently unavailable. Please try again later.",
    "gpt-6-astra model is temporarily unavailable (503).",
    "The model gpt-6-astra is overloaded; not available right now due to capacity."
  ]) {
    writeEvents([{ type: "thread.started", thread_id: "t" }, { type: "turn.started" }, { type: "error", message }]);
    assert.equal(modelUnavailableError(file, "gpt-6-astra"), null, message);
  }
  // Work that has scrolled out of the read tail still rules out a rejection.
  writeEvents([
    { type: "thread.started", thread_id: "t" },
    { type: "item.completed", item: { type: "command_execution", command: "git commit -m work" } },
    { type: "item.completed", item: { type: "agent_message", text: "x".repeat(70000) } },
    { type: "error", message: "The 'gpt-6-astra' model is not supported when using Codex with a ChatGPT account." }
  ]);
  assert.equal(modelUnavailableError(file, "gpt-6-astra"), null);

  // Entitlement wording that happens to say "currently" is still a rejection.
  writeEvents([{ type: "error", message: "The model gpt-6-astra is currently not supported on your plan." }]);
  assert.match(modelUnavailableError(file, "gpt-6-astra"), /not supported on your plan/);
});

test("an unavailable supervisor-routed model is substituted down the ladder and recorded", async () => {
  const root = repo();
  plan(root, "run-substitute", { taskModel: "astra", taskEffort: "xhigh" });
  checkpointPlan(root, "run-substitute");
  const launched = launchTaskWorker(root, "run-substitute", "build", { constraints: [] }, {
    codexCommand: [process.execPath, unavailableFixture, "--unavailable=gpt-6-astra"]
  });
  assert.equal(launched.model, "gpt-6-astra");

  const updates = await pollUntil(
    root,
    "run-substitute",
    (run) => run.tasks.build.status === "reported"
  );
  const substituted = updates.find((update) => update.status === "substituted");
  assert.equal(substituted.unavailableModel, "gpt-6-astra");
  assert.equal(substituted.requestedModel, "gpt-6-astra");
  assert.equal(substituted.model, "gpt-6.1-sol");
  assert.equal(substituted.reasoningEffort, "xhigh");
  assert.equal(substituted.pinned, false);
  assert.match(substituted.notice, /^Model substituted: the supervisor routed gpt-6-astra/);

  const run = loadRun(root, "run-substitute");
  assert.equal(run.tasks.build.model, "gpt-6-astra", "the saved route is never rewritten");
  const [rejected, replacement] = run.tasks.build.attempts;
  assert.equal(rejected.model, "gpt-6-astra");
  assert.deepEqual(
    [rejected.outcome.terminalOutcome, rejected.outcome.action, rejected.outcome.reasonCode],
    ["execution_failed", "execute", "model_unavailable"]
  );
  assert.equal(replacement.model, "gpt-6.1-sol");
  assert.equal(replacement.requestedModel, "gpt-6-astra");
  assert.equal(replacement.reasoningEffort, "xhigh");
  assert.equal(replacement.substitution.pinned, false);
  assert.equal(run.tasks.build.result.structured.summary, "Fake worker completed on gpt-6.1-sol.");
  assert.deepEqual(run.unavailableModels.map((entry) => entry.model), ["gpt-6-astra"]);
  const spec = JSON.parse(fs.readFileSync(replacement.runner.specFile, "utf8"));
  assert.equal(spec.model, "gpt-6.1-sol");

  const types = runEvents(root, "run-substitute").map((event) => event.type);
  assert.ok(types.includes("task.model_unavailable"));
  assert.ok(types.includes("task.model_substituted"));

  const briefing = renderSupervisorBriefing(root, run, { constraints: [] });
  assert.match(briefing, /worker route: gpt-6\.1-sol \(xhigh\) — SUBSTITUTED for gpt-6-astra/);
  assert.match(briefing, /unavailable: gpt-6-astra/);
  assert.doesNotMatch(briefing, /Tell the user which model actually ran/);
  const resumed = runCli(root, ["run", "resume", "run-substitute"]);
  assert.equal(resumed.code, 0);
  assert.match(resumed.stdout, /Model substituted: the supervisor routed gpt-6-astra/);
});

test("a user-pinned model is substituted too, but flagged prominently", async () => {
  const root = repo();
  createRun(root, {
    id: "run-pinned-substitute",
    lane: "api",
    objective: "Pinned astra",
    maxWorkers: 2,
    workerModel: "astra",
    reasoningEffort: "high"
  });
  replacePlan(root, "run-pinned-substitute", [
    { id: "first", title: "First", objective: "Inspect one", kind: "read" },
    { id: "second", title: "Second", objective: "Inspect two", kind: "read" }
  ]);
  checkpointPlan(root, "run-pinned-substitute");
  const codexCommand = [process.execPath, unavailableFixture, "--unavailable=gpt-6-astra,gpt-6.1-sol"];
  launchTaskWorker(root, "run-pinned-substitute", "first", { constraints: [] }, { codexCommand });
  await pollUntil(
    root,
    "run-pinned-substitute",
    (run) => run.tasks.first.status === "reported"
  );
  let run = loadRun(root, "run-pinned-substitute");
  assert.deepEqual(
    run.tasks.first.attempts.map((attempt) => attempt.model),
    ["gpt-6-astra", "gpt-6.1-sol", "gpt-6.1-terra"]
  );
  const final = run.tasks.first.attempts.at(-1);
  assert.equal(final.requestedModel, "gpt-6-astra");
  assert.equal(final.substitution.pinned, true);
  assert.deepEqual(final.substitution.unavailableModels, ["gpt-6-astra", "gpt-6.1-sol"]);

  // Later launches in the same run go straight to the substitute without
  // burning another rejected attempt, and still record the substitution.
  const second = launchTaskWorker(root, "run-pinned-substitute", "second", { constraints: [] }, {
    codexCommand
  });
  assert.equal(second.model, "gpt-6.1-terra");
  assert.equal(second.substitution.pinned, true);
  assert.match(second.briefing, /You are one gpt-6\.1-terra worker/);
  await pollUntil(
    root,
    "run-pinned-substitute",
    (current) => current.tasks.second.status === "reported"
  );
  run = loadRun(root, "run-pinned-substitute");
  assert.equal(run.tasks.second.attempts.length, 1);

  const briefing = renderSupervisorBriefing(root, run, { constraints: [] });
  assert.match(briefing, /A user-pinned model was substituted\. Tell the user/);
  assert.match(briefing, /USER-PINNED MODEL SUBSTITUTED: the run pinned gpt-6-astra/);
  assert.match(briefing, /SUBSTITUTED for gpt-6-astra \(user pin overridden\)/);
});

test("an unavailable model with no rung left fails the task for escalation", async () => {
  const root = repo();
  plan(root, "run-ladder-end", { workerModel: "luna" });
  checkpointPlan(root, "run-ladder-end");
  launchTaskWorker(root, "run-ladder-end", "build", { constraints: [] }, {
    codexCommand: [process.execPath, unavailableFixture, "--unavailable=gpt-5.6-luna"]
  });
  const updates = await pollUntil(
    root,
    "run-ladder-end",
    (run) => run.tasks.build.status === "failed"
  );
  assert.equal(updates.at(-1).fallbackModel, null);
  const task = loadRun(root, "run-ladder-end").tasks.build;
  assert.equal(task.attempts.length, 1);
  assert.deepEqual(
    [task.attempts[0].outcome.terminalOutcome, task.attempts[0].outcome.action, task.attempts[0].outcome.reasonCode],
    ["execution_failed", "escalate", "model_unavailable"]
  );
  assert.match(task.result.summary, /No model remains on the fallback ladder below gpt-5\.6-luna/);
});

test("a fallback never lands a task others depend on on luna", async () => {
  const root = repo();
  createRun(root, { id: "run-luna-leaf", lane: "api", objective: "Build safely" });
  const routed = (id, extra = {}) => ({
    id,
    title: id,
    objective: `Do ${id}`,
    scope: [`src/${id}/**`],
    acceptance: ["tests pass"],
    model: "terra",
    effort: "high",
    routingReason: "The supervisor selected this route for the bounded task.",
    ...extra
  });
  replacePlan(root, "run-luna-leaf", [routed("base"), routed("leaf"), routed("next", { dependsOn: ["base"] })]);
  checkpointPlan(root, "run-luna-leaf");
  const command = [process.execPath, unavailableFixture, "--unavailable=gpt-6.1-terra"];
  launchTaskWorker(root, "run-luna-leaf", "base", { constraints: [] }, { codexCommand: command });
  await pollUntil(root, "run-luna-leaf", (run) => run.tasks.base.status !== "running");
  let run = loadRun(root, "run-luna-leaf");
  assert.equal(run.tasks.base.status, "failed");
  assert.equal(run.tasks.base.attempts.length, 1);
  assert.equal(run.tasks.base.attempts[0].modelUnavailable.fallbackModel, null);
  assert.match(run.tasks.base.result.summary, /luna is not used for a task others depend on/);

  // A leaf still falls back to luna.
  const leaf = launchTaskWorker(root, "run-luna-leaf", "leaf", { constraints: [] }, { codexCommand: command });
  assert.equal(leaf.model, "gpt-5.6-luna");
  assert.equal(leaf.substitution.requestedModel, "gpt-6.1-terra");

  // A retry of the depended-on task is refused at launch instead of spending
  // another launch on the model already rejected, and run ready says why.
  retryTask(root, "run-luna-leaf", "base");
  const ready = JSON.parse(runCli(root, ["run", "ready", "run-luna-leaf", "--json"]).stdout);
  assert.deepEqual(ready.blocked.map((task) => task.id), ["base"]);
  assert.match(ready.blocked[0].conflicts[0], /gpt-6\.1-terra was rejected as unavailable/);
  assert.throws(
    () => launchTaskWorker(root, "run-luna-leaf", "base", { constraints: [] }, { codexCommand: command }),
    /no allowed model remains below it \(luna is not used for a task others depend on\)/
  );
  assert.equal(loadRun(root, "run-luna-leaf").tasks.base.attempts.length, 1);
});

test("a poll reloads the run only for tasks that are active", () => {
  const root = repo();
  createRun(root, { id: "run-poll-loads", lane: "api", objective: "Build safely", workerModel: "sol", reasoningEffort: "high" });
  replacePlan(root, "run-poll-loads", ["a", "b", "c", "d", "e"].map((id) => ({
    id, title: id, objective: id, kind: "read", acceptance: ["ok"]
  })));
  const file = runFile(root, "run-poll-loads");
  const original = fs.readFileSync;
  let loads = 0;
  fs.readFileSync = function (target, ...rest) {
    if (String(target) === file) {
      loads += 1;
    }
    return original.call(this, target, ...rest);
  };
  try {
    assert.deepEqual(pollRunWorkers(root, "run-poll-loads"), []);
  } finally {
    fs.readFileSync = original;
  }
  assert.equal(loads, 1);
});

test("a poll's run loads depend on its active tasks, not on how many tasks the run has", async () => {
  const measure = async (runId, taskCount) => {
    const root = repo();
    createRun(root, { id: runId, lane: "api", objective: "Build safely", workerModel: "sol", reasoningEffort: "high" });
    replacePlan(root, runId, Array.from({ length: taskCount }, (_, index) => ({
      id: `t${index}`, title: `t${index}`, objective: `t${index}`, kind: "read", acceptance: ["ok"]
    })));
    checkpointPlan(root, runId);
    const launched = launchTaskWorker(root, runId, "t0", { constraints: [] }, {
      codexCommand: [process.execPath, slowFixture, "--delay=10000"]
    });
    after(() => stopTaskWorker(launched));
    await pollUntil(root, runId, (run) => run.tasks.t0.attempts[0].threadId);
    const file = runFile(root, runId);
    const original = fs.readFileSync;
    let loads = 0;
    fs.readFileSync = function (target, ...rest) {
      if (String(target) === file) {
        loads += 1;
      }
      return original.call(this, target, ...rest);
    };
    let updates;
    try {
      updates = pollRunWorkers(root, runId);
    } finally {
      fs.readFileSync = original;
    }
    // The active task is still collected.
    assert.deepEqual(updates.map((update) => [update.taskId, update.status]), [["t0", "running"]]);
    return loads;
  };
  assert.equal(await measure("run-loads-small", 2), await measure("run-loads-large", 8));
});

test("a rejected legacy slug off the fallback ladder is refused at launch, not relaunched", () => {
  const root = repo();
  createRun(root, { id: "run-legacy-rejected", lane: "api", objective: "Old run", workerModel: "sol", reasoningEffort: "high" });
  replacePlan(root, "run-legacy-rejected", [{ id: "work", title: "work", objective: "work", kind: "read", acceptance: ["ok"] }]);
  checkpointPlan(root, "run-legacy-rejected");
  // A 0.5.x run saved the legacy slug, and Codex has since rejected it.
  const file = runFile(root, "run-legacy-rejected");
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  saved.tasks.work.model = "gpt-5.6-sol";
  saved.unavailableModels = [{ model: "gpt-5.6-sol", at: new Date().toISOString(), message: "model not found" }];
  fs.writeFileSync(file, `${JSON.stringify(saved, null, 2)}\n`);

  const ready = JSON.parse(runCli(root, ["run", "ready", "run-legacy-rejected", "--json"]).stdout);
  assert.deepEqual(ready.tasks.map((task) => task.id), []);
  assert.deepEqual(ready.blocked.map((task) => task.id), ["work"]);
  assert.match(ready.blocked[0].conflicts[0], /gpt-5\.6-sol was rejected as unavailable/);
  assert.throws(
    () => claimTask(root, "run-legacy-rejected", "work", { constraints: [] }),
    /gpt-5\.6-sol, which Codex rejected as unavailable in this run, and it is not on the fallback ladder/
  );
  assert.equal(loadRun(root, "run-legacy-rejected").tasks.work.attempts?.length ?? 0, 0);
});
