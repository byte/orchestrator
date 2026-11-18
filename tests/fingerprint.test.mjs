import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
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

test("a submodule is fingerprinted by its own head and dirty contents instead of refusing the review", () => {
  const root = repoWithSubmodule();
  const first = reviewFingerprint(root, []);
  assert.equal(reviewFingerprint(root, []), first, "stable");
  write(path.join(root, "lib"), "seed.txt", "edited inside the submodule\n");
  const dirty = reviewFingerprint(root, []);
  assert.notEqual(dirty, first, "dirty submodule contents count");
  git(path.join(root, "lib"), ["checkout", "--", "seed.txt"]);
  assert.equal(reviewFingerprint(root, []), first);
  // A modified submodule in the checkout also no longer breaks check receipts.
  write(path.join(root, "lib"), "seed.txt", "edited again\n");
  assert.doesNotThrow(() => checkoutFingerprint(root));
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
