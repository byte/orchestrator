import assert from "node:assert/strict";
import fs from "node:fs";
import { after, test } from "node:test";

import { loadRun, recordTaskResult, runDiagnostics, runFile } from "../plugins/orchestrator/scripts/lib/runs.mjs";
import { cleanup, git, makeRepo, runCli, write } from "./helpers.mjs";

const repos = [];
after(() => repos.forEach(cleanup));

function cli(root, args) {
  const result = runCli(root, args);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  return result.stdout;
}

function repo() {
  const root = makeRepo();
  repos.push(root);
  cli(root, ["init"]);
  cli(root, ["lane", "add", "api", "--scope", "src/**", "--scope", "!src/private/**", "--constraint", "Keep the API stable", "--done", "Checks pass"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-qm", "Configure project"]);
  cli(root, ["run", "create", "api", "--id", "work", "--objective", "Improve the API", "--model", "sol", "--effort", "high"]);
  return root;
}

function task(id, scope = [`src/${id}.js`]) {
  return { id, title: id, objective: `Implement ${id}`, scope, acceptance: ["The API returns the expected result"] };
}

function plan(root, tasks, extra = []) {
  const file = write(root, ".orchestrator/local/plan.json", JSON.stringify({ tasks }));
  return runCli(root, ["run", "plan", "work", "--plan-file", file, ...extra, "--json"]);
}

function checkpoint(root) {
  cli(root, ["run", "checkpoint", "work", "--summary", "Reviewed plan and authority"]);
}

test("initial scope and acceptance are enforced against the frozen lane", () => {
  const root = repo();
  assert.match(plan(root, [task("billing", ["billing/**"])]).stderr, /outside lane/);
  assert.match(plan(root, [task("private", ["src/private/a.js"])]).stderr, /outside lane/);
  assert.match(plan(root, [{ ...task("empty"), acceptance: [] }]).stderr, /acceptance criterion/);
  cli(root, ["lane", "add", "api", "--scope", "**", "--constraint", "Changed later", "--done", "Different check"]);
  assert.match(plan(root, [task("billing", ["billing/**"])]).stderr, /outside lane/);
  assert.equal(plan(root, [task("safe")]).code, 0);
  checkpoint(root);
  const dispatch = JSON.parse(cli(root, ["run", "claim", "work", "safe", "--json"]));
  assert.match(dispatch.briefing, /Keep the API stable/);
  assert.doesNotMatch(dispatch.briefing, /Changed later/);
});

test("out-of-lane approval is explicit and bound to the exact task scope", () => {
  const root = repo();
  assert.equal(plan(root, [task("billing", ["billing/a.js"])], ["--user-approved-task", "billing"]).code, 0);
  assert.equal(plan(root, [task("billing", ["billing/a.js"])]).code, 0, "approved scope survives replan");
  assert.match(plan(root, [task("billing", ["billing/b.js"])]).stderr, /outside lane/);
  checkpoint(root);
  assert.equal(JSON.parse(cli(root, ["run", "claim", "work", "billing", "--json"])).taskId, "billing");
});

test("definitely shared writers wait, while disjoint writers stay parallel", () => {
  const root = repo();
  const result = plan(root, [task("first", ["src/shared.js"]), task("second", ["src/shared.js"]), task("independent")]);
  assert.equal(result.code, 0, result.stderr);
  assert.ok(JSON.parse(result.stdout).warnings.length);
  checkpoint(root);
  cli(root, ["run", "claim", "work", "first"]);
  assert.match(runCli(root, ["run", "claim", "work", "second"]).stderr, /already owned/);
  cli(root, ["run", "claim", "work", "independent"]);
  const ready = JSON.parse(cli(root, ["run", "ready", "work", "--json"]));
  assert.equal(ready.blocked[0].id, "second");
  assert.equal(JSON.parse(cli(root, ["run", "show", "work", "--json"])).tasks.second.attempts.length, 0);
});

test("review freshness distinguishes unrelated edits from changed dirty and untracked review contents", () => {
  const root = repo();
  write(root, "src/review.js", "untracked original\n");
  assert.equal(plan(root, [{ ...task("review", ["src/review.js"]), kind: "read" }]).code, 0);
  checkpoint(root);
  const dispatch = JSON.parse(cli(root, ["run", "claim", "work", "review", "--json"]));
  write(root, "other.txt", "unrelated edit\n");
  const report = () => recordTaskResult(root, "work", "review", { attemptId: dispatch.attemptId, resultText: JSON.stringify({
    summary: "Reviewed original", files_touched: [], tests: [], decisions: [], assumptions: [], blockers: [], confidence: "high"
  }) });
  report();
  const before = fs.readFileSync(runFile(root, "work"), "utf8");
  assert.match(cli(root, ["run", "show", "work"]), /Declared review contents match dispatch/);
  assert.equal(fs.readFileSync(runFile(root, "work"), "utf8"), before, "show must not mutate run state");
  write(root, "src/review.js", "same path, different content\n");
  assert.match(cli(root, ["run", "show", "work"]), /contents changed/);
  assert.match(runCli(root, ["run", "verify", "work", "review", "--verdict", "pass", "--evidence", "Looks right"]).stderr, /stale/);
  cli(root, ["run", "verify", "work", "review", "--verdict", "fail", "--evidence", "Source changed; re-review"]);
  cli(root, ["run", "retry", "work", "review", "--fresh"]);
  checkpoint(root);
  const next = JSON.parse(cli(root, ["run", "claim", "work", "review", "--json"]));
  recordTaskResult(root, "work", "review", { attemptId: next.attemptId, resultText: JSON.stringify({ summary: "Reviewed new", files_touched: [], tests: [], decisions: [], assumptions: [], blockers: [], confidence: "high" }) });
  cli(root, ["run", "verify", "work", "review", "--verdict", "pass", "--evidence", "Rechecked current content"]);
});

test("observation commands do not register the observing Claude session", () => {
  const root = repo();
  assert.equal(plan(root, [task("first")]).code, 0);
  const before = fs.readFileSync(runFile(root, "work"), "utf8");
  const saved = process.env.ORCH_TEST_CLAUDE_SESSION_ID;
  process.env.ORCH_TEST_CLAUDE_SESSION_ID = "observing-session";
  try {
    for (const command of ["show", "ready", "recover"]) {
      cli(root, ["run", command, "work"]);
      assert.equal(fs.readFileSync(runFile(root, "work"), "utf8"), before, command);
    }
  } finally {
    if (saved === undefined) delete process.env.ORCH_TEST_CLAUDE_SESSION_ID;
    else process.env.ORCH_TEST_CLAUDE_SESSION_ID = saved;
  }
});

test("blocked diagnostics name dependencies, stale checkpoints, and ambiguous integration phases without recovery", () => {
  const root = repo();
  assert.equal(plan(root, [task("first"), { ...task("second"), dependsOn: ["first"] }]).code, 0);
  const run = loadRun(root, "work");
  const report = runDiagnostics(root, run);
  assert.match(report.tasks.find((entry) => entry.taskId === "second").reason, /dependency first not accepted/);
  assert.ok(report.alerts.some((entry) => /checkpoint/i.test(entry.reason)));
  run.pendingIntegration = { id: "interrupted", taskId: "first", phase: "started" };
  const preserved = JSON.stringify(run);
  const recovery = runDiagnostics(root, run).alerts.find((entry) => /interrupted/.test(entry.reason));
  assert.match(recovery.next, /Git child may still mutate/);
  assert.equal(JSON.stringify(run), preserved, "diagnosis cannot clear pending intent");
  run.pendingIntegration = null;
  run.pendingIntegrationEvent = { eventId: "accepted-but-unpublished" };
  assert.match(runDiagnostics(root, run).alerts[0].reason, /accepted; audit publication pending/);
});

test("approval names tasks: approving one out-of-lane task never carries another through", () => {
  const root = repo();
  const stray = plan(root, [task("billing", ["billing/a.js"]), task("deploy", ["deploy/x.sh"])], ["--user-approved-task", "billing"]);
  assert.match(stray.stderr, /"deploy" scope is outside lane .*--user-approved-task deploy/);
  assert.match(plan(root, [task("billing", ["billing/a.js"])], ["--user-approved"]).stderr, /--user-approved-task <task-id>/);
  assert.match(plan(root, [task("safe")], ["--user-approved-task", "safe"]).stderr, /does not need scope approval/);
  assert.match(plan(root, [task("safe")], ["--user-approved-task", "ghost"]).stderr, /"ghost", which is not in the plan/);
  assert.equal(plan(root, [task("billing", ["billing/a.js"]), task("deploy", ["deploy/x.sh"])],
    ["--user-approved-task", "billing", "--user-approved-task", "deploy"]).code, 0);
});

test("a task narrower than the lane only by its own extra exclusions is inside it", () => {
  const root = repo();
  // Lane: src/** except src/private/**.
  assert.equal(plan(root, [task("narrow", ["src/**", "!src/private/**", "!src/generated/**"])]).code, 0);
  assert.equal(plan(root, [task("wider", ["src/**", "!src/private/a.js"])]).code === 0, false, "excluding less than the lane is still outside");
  assert.match(plan(root, [task("order", ["!src/private/**", "src/**"])]).stderr, /outside lane/, "an exclusion before the pattern does not carve it");
});
