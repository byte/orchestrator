import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { inventoryStorage, exportDiagnosticMetadata } from "../plugins/orchestrator/scripts/lib/storage.mjs";
import { createRun, runFile } from "../plugins/orchestrator/scripts/lib/runs.mjs";
import { initWorkspace } from "../plugins/orchestrator/scripts/lib/state.mjs";
import { SCRATCH_OWNER_FILE } from "../plugins/orchestrator/scripts/lib/remove-tree.mjs";
import { cleanup, git, makeRepo, runCli, write } from "./helpers.mjs";

function fixture(t) {
  const root = makeRepo();
  t.after(() => cleanup(root));
  initWorkspace(root);
  const run = createRun(root, { id: "private-run-id", lane: "private-lane", objective: "private objective SECRET" });
  const worktree = path.join(root, ".orchestrator/local/worktrees", run.id, "work-attempt-1");
  fs.mkdirSync(path.dirname(worktree), { recursive: true });
  git(root, ["worktree", "add", "--detach", worktree, "HEAD"]);
  const gitDir = path.resolve(worktree, git(worktree, ["rev-parse", "--git-dir"]).trim());
  const attempt = { id: "private-attempt-id", status: "failed", worktree: {
    path: worktree, gitDir, branch: "HEAD", createdAt: new Date().toISOString()
  } };
  const task = { id: "private-task-id", kind: "write", status: "failed", attempts: [attempt] };
  run.tasks[task.id] = task;
  const save = () => fs.writeFileSync(runFile(root, run.id), JSON.stringify(run));
  save();
  return { root, run, task, attempt, worktree, save };
}

function withScratch(t, fixture, status = {}) {
  const { root, run, task, attempt, save } = fixture;
  const scratch = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "orch-worker-storage-"));
  t.after(() => cleanup(scratch));
  const statusFile = write(root, `.orchestrator/local/runs/${run.id}/workers/${task.id}/${attempt.id}/status.json`, JSON.stringify({
    status: "completed", scratchDir: scratch, ...status
  }));
  fs.writeFileSync(path.join(scratch, SCRATCH_OWNER_FILE), statusFile);
  fs.writeFileSync(path.join(scratch, "payload"), "scratch data");
  attempt.runner = { statusFile };
  save();
  return { scratch, statusFile };
}

const entry = (inventory, kind) => inventory.entries.find((item) => item.kind === kind);

test("inventory stats artifacts, deduplicates warm worktrees, and never deletes or refreshes the index", (t) => {
  const f = fixture(t);
  const { scratch } = withScratch(t, f);
  f.task.attempts.push({ ...f.attempt, id: "warm-attempt", runner: undefined });
  f.save();
  const state = fs.readFileSync(runFile(f.root, f.run.id));
  const index = path.join(f.root, git(f.root, ["rev-parse", "--git-path", "index"]).trim());
  const beforeIndex = fs.readFileSync(index);
  const workerIndex = path.resolve(f.worktree, git(f.worktree, ["rev-parse", "--git-path", "index"]).trim());
  const beforeWorkerIndex = fs.readFileSync(workerIndex);
  const inventory = inventoryStorage(f.root);
  assert.equal(inventory.entries.filter((item) => item.kind === "worktree").length, 1);
  assert.equal(entry(inventory, "worktree").cleanup.reason, "finished_clean");
  assert.equal(entry(inventory, "scratch").cleanup.reason, "finished_scratch");
  assert.ok(entry(inventory, "artifacts").bytes >= state.length);
  assert.equal(entry(inventory, "artifacts").cleanup.eligible, false);
  assert.equal(entry(inventory, "worktree").files, 2, "seed and .git pointer are statted");
  assert.deepEqual(fs.readFileSync(runFile(f.root, f.run.id)), state);
  assert.deepEqual(fs.readFileSync(index), beforeIndex);
  assert.deepEqual(fs.readFileSync(workerIndex), beforeWorkerIndex);
  assert.equal(fs.existsSync(scratch), true);
  assert.equal(fs.existsSync(f.worktree), true);
});

test("dirty, active, live, setup-uncertain, and pending-integration state retain worktrees and scratch", (t) => {
  const f = fixture(t);
  const { statusFile } = withScratch(t, f);
  fs.writeFileSync(path.join(f.worktree, "uncommitted"), "must keep");
  let inventory = inventoryStorage(f.root);
  assert.equal(entry(inventory, "worktree").cleanup.reason, "dirty");
  assert.equal(entry(inventory, "scratch").cleanup.reason, "dirty");
  fs.unlinkSync(path.join(f.worktree, "uncommitted"));
  for (const status of ["running", "dispatching", "needs_input", "reported", "pending"]) {
    f.task.status = status; f.save();
    assert.equal(entry(inventoryStorage(f.root), "worktree").cleanup.reason, "task_active");
  }
  f.task.status = "cancelled";
  fs.writeFileSync(statusFile, JSON.stringify({ status: "cancelled", childPid: process.pid }));
  f.save();
  assert.equal(entry(inventoryStorage(f.root), "worktree").cleanup.reason, "worker_live");
  fs.writeFileSync(statusFile, JSON.stringify({ status: "completed" }));
  f.attempt.worktree.setup = { terminationUncertain: true };
  f.save();
  assert.equal(entry(inventoryStorage(f.root), "worktree").cleanup.reason, "process_uncertain");
  delete f.attempt.worktree.setup;
  f.attempt.worktree.setupPending = { launcherPid: process.pid };
  f.save();
  assert.equal(entry(inventoryStorage(f.root), "worktree").cleanup.reason, "worker_live");
  delete f.attempt.worktree.setupPending;
  f.run.pendingIntegration = { phase: "started", id: "private-operation" }; f.save();
  assert.equal(entry(inventoryStorage(f.root), "worktree").cleanup.reason, "pending_integration");
});

test("symlinks, unowned scratch, and forged outside worktrees are not traversed", (t) => {
  const f = fixture(t);
  const { scratch } = withScratch(t, f);
  const outside = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "orch-outside-"));
  t.after(() => cleanup(outside));
  fs.writeFileSync(path.join(outside, "secret-transcript"), "X".repeat(100000));
  fs.symlinkSync(outside, path.join(f.worktree, "outside"));
  let inventory = inventoryStorage(f.root);
  assert.equal(entry(inventory, "worktree").symlinks, 1);
  assert.ok(entry(inventory, "worktree").bytes < 100000);
  fs.unlinkSync(path.join(scratch, SCRATCH_OWNER_FILE));
  fs.symlinkSync(path.join(outside, "secret-transcript"), path.join(scratch, SCRATCH_OWNER_FILE));
  inventory = inventoryStorage(f.root);
  assert.equal(entry(inventory, "scratch").cleanup.reason, "not_owned");
  assert.equal(entry(inventory, "scratch").bytes, 0);
  f.attempt.worktree.path = outside; f.save();
  inventory = inventoryStorage(f.root);
  assert.equal(entry(inventory, "worktree").cleanup.reason, "not_owned");
  assert.equal(entry(inventory, "worktree").path, undefined);
  const runs = path.join(f.root, ".orchestrator/local/runs");
  fs.symlinkSync(outside, path.join(runs, "external-run"));
  assert.equal(inventoryStorage(f.root).unavailableRuns, 1);
});

test("symlinked ancestors and status files never authorize scratch ownership", (t) => {
  const f = fixture(t);
  const { scratch, statusFile } = withScratch(t, f);
  const alias = path.join(f.root, "scratch-alias");
  fs.symlinkSync(path.dirname(scratch), alias);
  fs.writeFileSync(statusFile, JSON.stringify({ status: "completed", scratchDir: path.join(alias, path.basename(scratch)) }));
  assert.equal(entry(inventoryStorage(f.root), "scratch").cleanup.reason, "not_owned");
  const outsideStatus = path.join(scratch, "outside-status.json");
  fs.writeFileSync(outsideStatus, JSON.stringify({ status: "completed", scratchDir: scratch }));
  fs.unlinkSync(statusFile); fs.symlinkSync(outsideStatus, statusFile);
  const inventory = inventoryStorage(f.root);
  assert.equal(entry(inventory, "scratch"), undefined);
  assert.equal(entry(inventory, "worktree").cleanup.reason, "process_uncertain");
});

test("diagnostic export is an allowlisted aggregate, never raw paths, IDs, free text, source, or transcript content", (t) => {
  const f = fixture(t);
  const { statusFile } = withScratch(t, f, { error: "private error SECRET", threadId: "private-thread-id" });
  write(f.root, `.orchestrator/local/runs/${f.run.id}/prompt.md`, "private prompt SECRET");
  write(f.root, `.orchestrator/local/runs/${f.run.id}/events.jsonl`, "private log SECRET");
  f.attempt.diagnostics = [{ error: "private full error SECRET" }];
  f.run.workerPolicy.executor = "private-executor-SECRET";
  f.run.status = "private-status-SECRET";
  f.save();
  const before = fs.readFileSync(statusFile);
  const reads = [];
  const read = fs.readFileSync;
  let metadata;
  try {
    fs.readFileSync = (file, ...args) => { reads.push(String(file)); return read(file, ...args); };
    metadata = exportDiagnosticMetadata(f.root);
  } finally { fs.readFileSync = read; }
  assert.ok(reads.every((file) =>
    [runFile(f.root, f.run.id), statusFile].includes(file) ||
    (file.startsWith(`${f.root}/.git/worktrees/`) && path.basename(file) === "gitdir") ||
    (file.includes("/orch-worker-storage-") && path.basename(file) === SCRATCH_OWNER_FILE) ||
    /\/orch-git-[^/]+\/(stdout|stderr)$/.test(file)), reads.join("\n"));
  const json = JSON.stringify(metadata);
  for (const forbidden of [f.root, "private-", "private ", "SECRET", "seed.txt", "status.json", "objective", "prompt", "threadId", "error"]) {
    assert.equal(json.includes(forbidden), false, forbidden);
  }
  assert.deepEqual(Object.keys(metadata).sort(), ["certification", "nodeVersion", "runs", "schemaVersion", "storage"]);
  assert.deepEqual(metadata.runs.statuses, { unknown: 1 });
  assert.deepEqual(metadata.runs.executors, { unknown: 1 });
  assert.equal(metadata.storage.scratch.entries, 1);
  assert.deepEqual(fs.readFileSync(statusFile), before);
});

test("unreadable/future saved state is retained and cannot leak parse errors", (t) => {
  const f = fixture(t);
  fs.writeFileSync(runFile(f.root, f.run.id), '{"private secret path":');
  let metadata = exportDiagnosticMetadata(f.root);
  assert.equal(metadata.runs.unavailable, 1);
  assert.equal(metadata.storage.artifacts.retained.state_unavailable, 1);
  assert.equal(JSON.stringify(metadata).includes("private"), false);
  f.run.version = 999; f.save();
  metadata = exportDiagnosticMetadata(f.root);
  assert.equal(metadata.runs.unavailable, 1);
  assert.equal(metadata.storage.worktree.entries, 0, "unknown schema cannot establish worktree ownership");
});

test("retired attempts remain inventoried; unsettled previews and missing runner evidence stay retained", (t) => {
  const f = fixture(t);
  f.task.retiredPlanRevision = 1;
  f.task.status = "pending";
  f.run.retiredTasks = [f.task]; f.run.tasks = {};
  f.attempt.runner = { statusFile: path.join(f.root, "missing") };
  const preview = path.join(f.root, ".orchestrator/local/previews", f.run.id, "preview-1");
  fs.mkdirSync(preview, { recursive: true });
  f.run.previews = [{ id: "private-preview", status: "running", worktree: { path: preview } }];
  f.save();
  const inventory = inventoryStorage(f.root);
  assert.equal(entry(inventory, "worktree").cleanup.reason, "process_uncertain");
  assert.equal(entry(inventory, "preview").cleanup.reason, "process_uncertain");
});

test("saved check ownership and another task's shared setup uncertainty protect the physical tree", (t) => {
  const f = fixture(t);
  withScratch(t, f);
  f.run.checkExecutions = [{ path: f.worktree, status: "running", ownerPid: process.pid }];
  f.save();
  assert.equal(entry(inventoryStorage(f.root), "worktree").cleanup.reason, "worker_live");
  f.run.checkExecutions = [{ path: f.worktree, status: "running" }]; f.save();
  assert.equal(entry(inventoryStorage(f.root), "worktree").cleanup.reason, "process_uncertain");
  f.run.checkExecutions = [{ path: f.worktree, status: "settled", uncertainGroups: [null] }]; f.save();
  assert.equal(entry(inventoryStorage(f.root), "worktree").cleanup.reason, "process_uncertain");
  f.run.checkExecutions = [{ path: f.worktree, status: "settled", uncertainGroups: [] }];
  f.run.retiredTasks = [{ id: "other-task", status: "failed", retiredPlanRevision: 1,
    attempts: [{ id: "other-attempt", worktree: { path: f.worktree, setupPending: {} } }] }];
  f.save();
  const inventory = inventoryStorage(f.root);
  assert.equal(entry(inventory, "worktree").cleanup.reason, "process_uncertain");
  assert.equal(entry(inventory, "scratch").cleanup.reason, "process_uncertain");
});

test("an unreadable owned scratch tree stays incomplete and retained without changing permissions", (t) => {
  const f = fixture(t);
  const { scratch } = withScratch(t, f);
  const permissions = fs.statSync(scratch).mode;
  const readdir = fs.readdirSync;
  let inventory;
  try {
    fs.readdirSync = (directory, ...args) => {
      if (directory === scratch) throw Object.assign(new Error("private diagnostic"), { code: "EACCES" });
      return readdir(directory, ...args);
    };
    inventory = inventoryStorage(f.root);
  } finally { fs.readdirSync = readdir; }
  assert.equal(entry(inventory, "scratch").complete, false);
  assert.deepEqual(entry(inventory, "scratch").cleanup, { eligible: false, reason: "unavailable" });
  assert.equal(fs.statSync(scratch).mode, permissions);
});

test("paths cleanup already removed are left out, not reported as unowned", (t) => {
  const f = fixture(t);
  const { scratch } = withScratch(t, f);
  fs.rmSync(scratch, { recursive: true, force: true });
  fs.rmSync(f.worktree, { recursive: true, force: true });
  const inventory = inventoryStorage(f.root);
  assert.deepEqual(inventory.entries.filter((item) => item.kind !== "artifacts"), []);
  assert.equal(exportDiagnosticMetadata(f.root).storage.worktree.entries, 0);
});

test("a later worktree at a removed path is excluded from owned storage", (t) => {
  const f = fixture(t);
  f.attempt.worktree.createdAt = new Date(Date.now() - 60000).toISOString();
  f.save();
  git(f.root, ["worktree", "remove", f.worktree]);
  git(f.root, ["worktree", "add", "--detach", f.worktree, "HEAD"]);
  const tree = entry(inventoryStorage(f.root), "worktree");
  assert.deepEqual(tree.cleanup, { eligible: false, reason: "not_owned" });
  assert.equal(tree.path, undefined);
  const removal = runCli(f.root, ["run", "cleanup", f.run.id]);
  assert.match(removal.stderr || removal.stdout, /registration|replaced/);
  assert.equal(fs.existsSync(f.worktree), true);
});
