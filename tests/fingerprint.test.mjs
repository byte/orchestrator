import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { checkoutFingerprint, reviewFingerprint } from "../plugins/orchestrator/scripts/lib/checks.mjs";
import { claimTask, createRun, loadRun, recordTaskResult, replacePlan, reviewFreshness, runDiagnostics } from "../plugins/orchestrator/scripts/lib/runs.mjs";
import { checkpointPlan, cleanup, git, makeRepo, runCli, write } from "./helpers.mjs";

const repos = [];
after(() => repos.forEach(cleanup));

function repoWithSubmodule() {
  const library = makeRepo();
  const root = makeRepo();
  repos.push(library, root);
  execFileSync("git", ["-c", "protocol.file.allow=always", "submodule", "--quiet", "add", library, "lib"], { cwd: root, stdio: "ignore" });
  git(root, ["commit", "-qm", "add submodule"]);
  return root;
}

test("checkout fingerprinting works in a plain directory", (t) => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "orch-fingerprint-"));
  t.after(() => cleanup(root));
  const fingerprint = checkoutFingerprint(root);
  assert.match(fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(checkoutFingerprint(root), fingerprint);
});

test("a submodule is fingerprinted by its own head and dirty contents instead of refusing the review", () => {
  const root = repoWithSubmodule();
  const first = reviewFingerprint(root, []);
  const scoped = reviewFingerprint(root, ["lib/**"]);
  const excluded = reviewFingerprint(root, ["**", "!lib/**"]);
  assert.equal(reviewFingerprint(root, []), first, "stable");
  write(path.join(root, "lib"), "seed.txt", "edited inside the submodule\n");
  const dirty = reviewFingerprint(root, []);
  assert.notEqual(dirty, first, "dirty submodule contents count");
  assert.notEqual(reviewFingerprint(root, ["lib/**"]), scoped, "directory scope includes its gitlink");
  assert.equal(reviewFingerprint(root, ["**", "!lib/**"]), excluded);
  git(path.join(root, "lib"), ["checkout", "--", "seed.txt"]);
  assert.equal(reviewFingerprint(root, []), first);
  // A modified submodule in the checkout also no longer breaks check receipts.
  write(path.join(root, "lib"), "seed.txt", "edited again\n");
  assert.doesNotThrow(() => checkoutFingerprint(root));
  git(path.join(root, "lib"), ["checkout", "--", "seed.txt"]);
  git(path.join(root, "lib"), ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-qm", "new submodule HEAD"]);
  assert.notEqual(reviewFingerprint(root, ["lib/**"]), scoped, "a submodule HEAD change counts without file changes");
});

test("nested checkout evidence uses files without asking the nested Git index for status", () => {
  const root = makeRepo();
  repos.push(root);
  const nested = path.join(root, "nested");
  fs.mkdirSync(nested);
  git(nested, ["init", "--quiet"]);
  write(nested, "nested.txt", "original source");
  write(nested, ".git/index", "unreadable index");
  const before = reviewFingerprint(root, []);
  write(nested, "nested.txt", "observable source change");
  assert.notEqual(reviewFingerprint(root, []), before);
});

test("dispatch revalidates the precomputed review identity after waiting for the run lock", () => {
  const root = makeRepo(); repos.push(root);
  assert.equal(runCli(root, ["init"]).code, 0);
  createRun(root, { id: "rv", lane: "api", objective: "Review", workerModel: "sol", reasoningEffort: "high" });
  replacePlan(root, "rv", [{ id: "read", kind: "read", title: "Read", objective: "Read", scope: ["seed.txt"], acceptance: ["Reviewed"] }]);
  checkpointPlan(root, "rv");
  const open = fs.openSync;
  let changed = false;
  try {
    fs.openSync = (file, ...args) => {
      if (String(file).endsWith("/rv/run.json.lock") && !changed) {
        changed = true;
        write(root, "seed.txt", "the checkout seen by the new worker\n");
      }
      return open(file, ...args);
    };
    claimTask(root, "rv", "read", { constraints: [] });
  } finally {
    fs.openSync = open;
  }
  assert.equal(changed, true);
  assert.equal(loadRun(root, "rv").tasks.read.attempts.at(-1).readSurface.fingerprint, reviewFingerprint(root, ["seed.txt"]));
});

test("run show leaves the Git index untouched even when stat data needs refreshing", () => {
  const root = makeRepo();
  repos.push(root);
  assert.equal(runCli(root, ["init"]).code, 0);
  createRun(root, { id: "rv", lane: "api", objective: "Review", workerModel: "sol", reasoningEffort: "high" });
  replacePlan(root, "rv", [{ id: "write", title: "Write", objective: "Write", scope: ["seed.txt"], acceptance: ["Reviewed"] }]);
  const index = path.join(root, ".git/index");
  const before = fs.readFileSync(index);
  const future = new Date(Date.now() + 60000);
  fs.utimesSync(path.join(root, "seed.txt"), future, future);
  const show = runCli(root, ["run", "show", "rv"]);
  assert.equal(show.code, 0, show.stderr);
  assert.deepEqual(fs.readFileSync(index), before);
});

test("a FIFO in the review surface is noted, never opened", () => {
  const root = makeRepo();
  repos.push(root);
  execFileSync("mkfifo", [path.join(root, "pipe")]);
  const value = reviewFingerprint(root, []);
  assert.match(value, /^[0-9a-f]{64}$/);
  assert.equal(reviewFingerprint(root, [], { contents: false }).length, 64);
});

test("read review freshness works in a repository with a submodule, and quick looks skip unchanged contents", () => {
  const root = repoWithSubmodule();
  assert.equal(runCli(root, ["init"]).code, 0);
  createRun(root, { id: "rv", lane: "api", objective: "Review", workerModel: "sol", reasoningEffort: "high" });
  replacePlan(root, "rv", [{ id: "review", title: "Review", objective: "Review everything", kind: "read", scope: [], acceptance: ["Reviewed"] }]);
  checkpointPlan(root, "rv");
  const dispatch = claimTask(root, "rv", "review", { constraints: [] });
  recordTaskResult(root, "rv", "review", { attemptId: dispatch.attemptId, resultText: JSON.stringify({
    summary: "Reviewed", files_touched: [], tests: [], decisions: [], assumptions: [], blockers: [], confidence: "high"
  }) });
  const task = loadRun(root, "rv").tasks.review;
  assert.ok(task.result.reviewFreshness.statFingerprint);
  assert.equal(reviewFreshness(root, task, { quick: true }).status, "fresh");
  assert.equal(reviewFreshness(root, task).status, "fresh");
  // Same contents, new mtime: the quick look falls back to contents and stays fresh.
  const file = path.join(root, "seed.txt");
  const future = new Date(Date.now() + 60_000);
  fs.utimesSync(file, future, future);
  assert.equal(reviewFreshness(root, task, { quick: true }).status, "fresh");
  write(root, "seed.txt", "changed\n");
  assert.equal(reviewFreshness(root, task, { quick: true }).status, "stale");
  assert.match(runDiagnostics(root, loadRun(root, "rv")).tasks[0].reason, /changed since dispatch/);
});
