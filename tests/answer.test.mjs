import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { requireLane } from "../plugins/orchestrator/scripts/lib/lanes.mjs";
import { collectLearningExamples, listLearningExamples } from "../plugins/orchestrator/scripts/lib/learning.mjs";
import {
  MAX_INPUT_ROUNDS,
  AttachRefusedError,
  answerTask,
  attachExecution,
  bindAttempt,
  cancelTask,
  claimTask,
  createRun,
  eventsFile,
  loadRun,
  recordTaskResult,
  renderSupervisorBriefing,
  replacePlan,
  retryTask,
  revertTaskAnswer,
  runFile,
  StaleRunnerError,
  syncExecutionStatus,
  verifyTask
} from "../plugins/orchestrator/scripts/lib/runs.mjs";
import {
  answerTaskWorker,
  cancelWorkers,
  launchTaskWorker,
  pollRunWorkers,
  stopTaskWorker
} from "../plugins/orchestrator/scripts/lib/workers.mjs";
import { inspectTaskWorktree } from "../plugins/orchestrator/scripts/lib/worktrees.mjs";
import { assertReadOnlyLaunch, checkpointPlan, cleanup, makeRepo, runCli, assertLockedDown, configValue } from "./helpers.mjs";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const askFixture = path.join(fixtures, "fake-codex-ask.mjs");
const unavailableFixture = path.join(fixtures, "fake-codex-model-unavailable.mjs");
const repos = [];

function repo() {
  const root = makeRepo();
  repos.push(root);
  runCli(root, ["init"]);
  runCli(root, ["lane", "add", "api", "--scope", "src/**", "--scope", "lib/**"]);
  return root;
}

after(() => {
  for (const root of repos) {
    cleanup(root);
  }
});

function plan(root, id, tasks = [{ id: "work", kind: "write", scope: ["src/**"] }], { model = "sol" } = {}) {
  createRun(root, {
    id,
    lane: "api",
    objective: "Ask instead of stopping",
    workerModel: model,
    reasoningEffort: "high"
  });
  replacePlan(root, id, tasks.map((task) => ({
    title: task.id,
    objective: `Do ${task.id}`,
    acceptance: ["the supervisor accepts it"],
    ...task
  })));
  checkpointPlan(root, id);
}

function structured(overrides = {}) {
  return JSON.stringify({
    summary: "Paused.",
    files_touched: [],
    tests: [],
    decisions: [],
    assumptions: [],
    blockers: [],
    blocker_code: null,
    needs_input: null,
    confidence: "high",
    ...overrides
  });
}

const scopeRequest = (paths = ["lib/helper.js"]) => ({
  kind: "scope_extension",
  paths,
  reason: "the helper's export must change",
  question: null,
  options: []
});

/** Claim and bind without a process, so runtime rules can be checked directly. */
function paused(root, runId, taskId, request = scopeRequest()) {
  const claimed = claimTask(root, runId, taskId, lane(root));
  bindAttempt(root, runId, taskId, { attemptId: claimed.attemptId, threadId: `thread-${taskId}` });
  recordTaskResult(root, runId, taskId, {
    attemptId: claimed.attemptId,
    resultText: structured({ needs_input: request })
  });
  // answerTask requires a live worktree to resume in; point it at the repo.
  const file = runFile(root, runId);
  const state = JSON.parse(fs.readFileSync(file, "utf8"));
  state.tasks[taskId].attempts.at(-1).worktree = { path: root, branch: "main", baseHead: "x" };
  fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
  return claimed;
}

function lane(root) {
  return requireLane(root, "api");
}

function logFile() {
  return path.join(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "orch-ask-log-")), "calls.jsonl");
}

function readLog(file) {
  return fs.existsSync(file)
    ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line))
    : [];
}

function events(root, runId) {
  return fs.readFileSync(eventsFile(root, runId), "utf8")
    .split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

async function settle(root, runId, taskId = "work") {
  let updates = [];
  for (let index = 0; index < 150; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 40));
    updates = pollRunWorkers(root, runId);
    const task = loadRun(root, runId).tasks[taskId];
    if (!["running", "dispatching", "pending"].includes(task.status)) {
      return { task, updates };
    }
  }
  throw new Error(`run ${runId} did not settle`);
}

test("a granted scope extension resumes the same attempt and integrates with the extended scope", async () => {
  const root = repo();
  plan(root, "run-grant");
  const calls = logFile();
  const command = [
    process.execPath, askFixture, `--log=${calls}`, "--ask=scope:lib/helper.js", "--partial",
    "--write=src/notes.txt", "--granted=lib/helper.js"
  ];
  const launched = launchTaskWorker(root, "run-grant", "work", lane(root), { codexCommand: command });
  let { task, updates } = await settle(root, "run-grant");

  // Paused, not finished: no outcome, no new attempt, the run still running.
  assert.equal(task.status, "needs_input");
  assert.equal(updates[0].status, "needs_input");
  assert.equal(updates[0].round, 1);
  assert.deepEqual(updates[0].inputRequest.paths, ["lib/helper.js"]);
  let attempt = task.attempts[0];
  assert.equal(attempt.status, "needs_input");
  assert.equal(attempt.outcome, null);
  assert.equal(attempt.finishedAt, null);
  assert.equal(loadRun(root, "run-grant").status, "running");
  assert.match(
    renderSupervisorBriefing(root, loadRun(root, "run-grant"), lane(root)),
    /## Workers awaiting your answer[\s\S]+work \(work-attempt-1, request 1 of at most 3\) asks for scope: lib\/helper\.js/
  );
  const threadId = attempt.threadId;

  const answered = answerTaskWorker(root, "run-grant", "work", lane(root), {
    grantScope: ["lib/helper.js"],
    reply: "Keep the old export as an alias."
  });
  assert.equal(answered.attemptId, "work-attempt-1");
  assert.equal(answered.round.answer.insideLane, true);
  assert.deepEqual(answered.scope, ["src/**", "lib/helper.js"]);
  ({ task } = await settle(root, "run-grant"));
  assert.equal(task.status, "reported");
  assert.match(task.result.structured.summary, /granted=true; reply=Keep the old export as an alias\./);

  // The same attempt continued on the same thread; no retry was spent.
  assert.equal(task.attempts.length, 1);
  attempt = task.attempts[0];
  assert.equal(attempt.threadId, threadId);
  assert.equal(attempt.outcome, null);
  assert.equal(attempt.inputRequests.length, 1);
  assert.equal(attempt.inputRequests[0].answer.mode, "grant");
  assert.equal(attempt.runner.inputRound, 1);
  assert.match(attempt.runner.specFile, /work-attempt-1\/round-1\/spec\.json$/);

  // The grant is on the task; the planned scope and the lane are unchanged.
  assert.deepEqual(task.scope, ["src/**"]);
  assert.deepEqual(task.scopeGrants.map((grant) => grant.patterns), [["lib/helper.js"]]);
  assert.deepEqual(lane(root).scope, ["src/**", "lib/**"]);

  // Resume: same thread, same worktree, explicit route and sandbox, short prompt.
  const [first, resumed] = readLog(calls);
  assert.equal(first.argv.includes("resume"), false);
  const argv = resumed.argv;
  const at = (flag) => argv.indexOf(flag);
  assert.ok(at("resume") > 0);
  assert.ok(at("-C") < at("resume") && argv[at("-C") + 1] === launched.worktree.path);
  assert.ok(at("--sandbox") < at("resume") && argv[at("--sandbox") + 1] === "workspace-write");
  assert.ok(at("--model") > at("resume") && argv[at("--model") + 1] === "gpt-6.2-sol");
  assert.equal(configValue(argv, "model_reasoning_effort"), 'model_reasoning_effort="high"');
  assertLockedDown(argv);
  assert.deepEqual(argv.slice(-2), [threadId, "-"]);
  assert.equal(resumed.cwd, launched.worktree.path);
  assert.match(resumed.prompt, /^## Supervisor answer \(request 1 of at most 3\)/);
  assert.match(resumed.prompt, /decision: Granted\. `lib\/helper\.js` is now in scope for this task only/);
  assert.match(resumed.prompt, /`lib\/helper\.js` \(granted by the supervisor after you asked/);
  assert.doesNotMatch(resumed.prompt, /## Assignment/);

  // Inspection and integration honour the grant.
  const inspection = inspectTaskWorktree(task, attempt);
  assert.deepEqual(inspection.grantedScope, ["lib/helper.js"]);
  assert.deepEqual(inspection.outOfScope, []);
  assert.equal(inspection.commits.length, 2);
  assert.equal(inspection.ready, true);
  const integrated = runCli(root, ["run", "integrate", "run-grant", "work", "--evidence", "helper and notes checked"]);
  assert.equal(integrated.code, 0, integrated.stderr);
  task = loadRun(root, "run-grant").tasks.work;
  assert.equal(task.status, "completed");
  assert.equal(task.attempts[0].outcome.terminalOutcome, "accepted");
  assert.ok(fs.existsSync(path.join(root, "lib", "helper.js")));

  const types = events(root, "run-grant").map((event) => event.type);
  assert.ok(types.includes("task.needs_input"));
  assert.ok(types.includes("task.input_answered"));
  assert.equal(types.includes("task.retried"), false);

  // Learning data sees one accepted attempt, not a failure plus a retry.
  collectLearningExamples(root, { runIds: ["run-grant"] });
  const samples = listLearningExamples(root, { runIds: ["run-grant"] });
  assert.equal(samples.length, 1);
  assert.equal(samples[0].outcome.terminalOutcome, "accepted");
  assert.equal(samples[0].features.retryCount, 0);
});

test("everything outside the task's planned and granted scope is still refused", async () => {
  const root = repo();
  plan(root, "run-stray");
  const command = [
    process.execPath, askFixture, "--ask=scope:lib/helper.js", "--write=src/notes.txt",
    "--granted=lib/helper.js", "--stray=lib/other.js"
  ];
  launchTaskWorker(root, "run-stray", "work", lane(root), { codexCommand: command });
  await settle(root, "run-stray");
  answerTaskWorker(root, "run-stray", "work", lane(root), { grantScope: ["lib/helper.js"] });
  const { task } = await settle(root, "run-stray");
  const inspection = inspectTaskWorktree(task, task.attempts[0]);
  assert.deepEqual(inspection.outOfScope, ["lib/other.js"]);
  assert.equal(inspection.ready, false);
  const refused = runCli(root, ["run", "integrate", "run-stray", "work", "--evidence", "Reviewed the candidate paths"]);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /did not pass integration inspection/);
});

test("a denied request resumes with the denial and the worker stays in scope", async () => {
  const root = repo();
  plan(root, "run-deny");
  const calls = logFile();
  launchTaskWorker(root, "run-deny", "work", lane(root), {
    codexCommand: [
      process.execPath, askFixture, `--log=${calls}`, "--ask=scope:lib/helper.js",
      "--write=src/notes.txt", "--granted=lib/helper.js"
    ]
  });
  await settle(root, "run-deny");
  const answered = runCli(root, [
    "run", "answer", "run-deny", "work", "--deny", "--reply", "Duplicate the helper locally instead."
  ]);
  assert.equal(answered.code, 0, answered.stderr);
  assert.match(answered.stdout, /Answered request 1 of work: denied\. Resumed thread thread-ask-\d+ on gpt-6\.2-sol \(high\)/);
  const { task } = await settle(root, "run-deny");
  assert.equal(task.status, "reported");
  assert.match(task.result.structured.summary, /granted=false/);
  assert.equal(task.scopeGrants, undefined);
  const resumed = readLog(calls)[1];
  assert.match(resumed.prompt, /decision: Denied\. Do not modify those paths/);
  assert.match(resumed.prompt, /supervisor reply: Duplicate the helper locally instead\./);
  const inspection = inspectTaskWorktree(task, task.attempts[0]);
  assert.deepEqual(inspection.files, ["src/notes.txt"]);
  assert.equal(inspection.ready, true);
});

test("a question is answered with a reply on a read-only resume", async () => {
  const root = repo();
  plan(root, "run-question", [{ id: "work", kind: "read" }]);
  const calls = logFile();
  launchTaskWorker(root, "run-question", "work", lane(root), {
    codexCommand: [process.execPath, askFixture, `--log=${calls}`, "--ask=question"]
  });
  const { updates } = await settle(root, "run-question");
  assert.equal(updates[0].inputRequest.kind, "question");
  assert.deepEqual(updates[0].inputRequest.options, ["cursor", "offset"]);

  // A question cannot be answered with scope, and a read task cannot get scope.
  assert.throws(
    () => answerTask(root, "run-question", "work", lane(root), { grantScope: ["src/a.js"] }),
    /read-only; it cannot be granted write scope/
  );
  assert.throws(
    () => answerTask(root, "run-question", "work", lane(root), {}),
    /requires --grant-scope <glob>, --deny, or --reply <text>/
  );
  const answered = runCli(root, ["run", "answer", "run-question", "work", "--reply", "Use cursor pagination."]);
  assert.equal(answered.code, 0, answered.stderr);
  const { task } = await settle(root, "run-question");
  assert.equal(task.status, "reported");
  assert.match(task.result.structured.summary, /reply=Use cursor pagination\./);
  const resumed = readLog(calls)[1];
  assertReadOnlyLaunch(resumed);
  assert.ok(resumed.argv.includes("resume"));
  assert.equal(fs.existsSync(resumed.tmpdir), false, "the scratch directory is removed after the worker");
  assert.match(resumed.prompt, /question: Should pagination be cursor-based or offset-based\?/);
  assert.match(resumed.prompt, /decision: Answered\. Proceed on the supervisor's reading below\./);
  verifyTask(root, "run-question", "work", { verdict: "pass", evidence: ["cursor pagination reviewed"] });
  assert.equal(loadRun(root, "run-question").tasks.work.attempts.length, 1);
});

test("a grant that overlaps another active task's write surface is refused", () => {
  const root = repo();
  plan(root, "run-overlap", [
    { id: "work", kind: "write", scope: ["src/**"] },
    { id: "helpers", kind: "write", scope: ["lib/**"] }
  ]);
  const other = claimTask(root, "run-overlap", "helpers", lane(root));
  bindAttempt(root, "run-overlap", "helpers", { attemptId: other.attemptId, threadId: "thread-helpers" });
  paused(root, "run-overlap", "work");

  assert.throws(
    () => answerTask(root, "run-overlap", "work", lane(root), { grantScope: ["lib/helper.js"] }),
    /`lib\/helper\.js` overlaps `lib\/\*\*` of running task "helpers"/
  );
  assert.throws(
    () => answerTask(root, "run-overlap", "work", lane(root), { grantScope: ["lib/*.js"] }),
    /overlaps `lib\/\*\*`/
  );
  // The refused grant left nothing behind; a reported-but-unintegrated task still owns its surface.
  let task = loadRun(root, "run-overlap").tasks.work;
  assert.equal(task.status, "needs_input");
  assert.equal(task.scopeGrants, undefined);
  recordTaskResult(root, "run-overlap", "helpers", { attemptId: other.attemptId, resultText: structured() });
  assert.throws(
    () => answerTask(root, "run-overlap", "work", lane(root), { grantScope: ["lib/helper.js"] }),
    /overlaps `lib\/\*\*` of reported task "helpers"/
  );
  // Once the other task is no longer active, the same grant goes through.
  verifyTask(root, "run-overlap", "helpers", { verdict: "fail", evidence: ["not needed"] });
  const answered = answerTask(root, "run-overlap", "work", lane(root), { grantScope: ["lib/helper.js"] });
  assert.deepEqual(answered.scope, ["src/**", "lib/helper.js"]);
  task = loadRun(root, "run-overlap").tasks.work;
  assert.equal(task.status, "dispatching");
});

test("a grant outside the lane needs the user's approval", () => {
  const root = repo();
  plan(root, "run-lane");
  paused(root, "run-lane", "work", scopeRequest(["docs/api.md"]));
  const refused = runCli(root, ["run", "answer", "run-lane", "work", "--grant-scope", "docs/api.md"]);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /`docs\/api\.md` is not inside lane "api" \(scope: src\/\*\*, lib\/\*\*\)/);
  assert.match(refused.stderr, /Ask the user, then repeat the answer with --user-approved/);
  assert.throws(
    () => answerTask(root, "run-lane", "work", lane(root), { grantScope: ["../outside.js"] }),
    /must be a repo-relative path or glob/
  );
  const answered = answerTask(root, "run-lane", "work", lane(root), {
    grantScope: ["docs/api.md"],
    userApproved: true
  });
  assert.equal(answered.round.answer.insideLane, false);
  assert.equal(answered.round.answer.userApproved, true);
  const run = loadRun(root, "run-lane");
  assert.equal(run.tasks.work.scopeGrants[0].userApproved, true);
  assert.deepEqual(lane(root).scope, ["src/**", "lib/**"]);
  assert.match(
    renderSupervisorBriefing(root, run, lane(root)),
    /scope granted to this task:\n- docs\/api\.md \(request 1 of work-attempt-1; OUTSIDE the lane, user-approved\)/
  );
});

test("round trips are capped per task and a further request becomes an ordinary blocker", () => {
  const root = repo();
  plan(root, "run-cap");
  const claimed = paused(root, "run-cap", "work");
  for (let round = 1; round <= MAX_INPUT_ROUNDS; round += 1) {
    const answered = answerTask(root, "run-cap", "work", lane(root), { reply: `answer ${round}` });
    assert.equal(answered.round.round, round);
    assert.match(
      answered.answerPrompt,
      round < MAX_INPUT_ROUNDS ? new RegExp(`You may ask ${MAX_INPUT_ROUNDS - round} more time`) : /You have no requests left/
    );
    recordTaskResult(root, "run-cap", "work", {
      attemptId: claimed.attemptId,
      resultText: structured({ needs_input: scopeRequest() })
    });
  }
  const run = loadRun(root, "run-cap");
  const task = run.tasks.work;
  assert.equal(task.status, "blocked");
  assert.equal(task.attempts.length, 1);
  const attempt = task.attempts[0];
  assert.equal(attempt.outcome.terminalOutcome, "worker_blocked");
  assert.equal(attempt.outcome.reasonCode, "scope_required");
  assert.equal(attempt.inputRequests.length, MAX_INPUT_ROUNDS + 1);
  assert.equal(attempt.inputRequests.at(-1).capped, true);
  assert.equal(task.result.inputCapReached, true);
  assert.match(task.result.structured.blockers.at(-1), /Input request cap reached \(3 answered round trips/);
  assert.throws(
    () => answerTask(root, "run-cap", "work", lane(root), { reply: "one more" }),
    /is not waiting for input/
  );
  // The blocked attempt retries warm like any blocker, and the cap still applies to the task.
  const retried = retryTask(root, "run-cap", "work");
  assert.equal(retried.retryPlan.mode, "warm");
  const second = claimTask(root, "run-cap", "work", lane(root));
  assert.match(second.briefing, /This task has used all its requests to the supervisor/);
});

test("needs_input holds a pool slot and blocks replanning until answered or cancelled", () => {
  const root = repo();
  createRun(root, { id: "run-slot", lane: "api", objective: "Slots", workerModel: "sol", reasoningEffort: "high", maxWorkers: 1 });
  replacePlan(root, "run-slot", [
    { id: "work", title: "work", objective: "Do work", kind: "write", scope: ["src/**"], acceptance: ["Reported changes satisfy the request"] },
    { id: "next", title: "next", objective: "Do next", kind: "write", scope: ["lib/**"], acceptance: ["Reported changes satisfy the request"] }
  ]);
  checkpointPlan(root, "run-slot");
  paused(root, "run-slot", "work");
  assert.throws(() => claimTask(root, "run-slot", "next", lane(root)), /1-worker concurrency limit/);
  assert.throws(
    () => replacePlan(root, "run-slot", [{ id: "work", title: "w", objective: "o", kind: "write", scope: ["src/**"] }]),
    /active or unverified work/
  );
  assert.throws(() => retryTask(root, "run-slot", "work"), /cannot be retried from status "needs_input"/);
  const cancelled = runCli(root, ["run", "cancel", "run-slot", "work", "--reason", "not needed"]);
  assert.equal(cancelled.code, 0, cancelled.stderr);
  const task = loadRun(root, "run-slot").tasks.work;
  assert.equal(task.status, "cancelled");
  assert.equal(task.attempts[0].outcome.terminalOutcome, "cancelled");
});

test("a missing thread on an answered resume falls back to the full briefing in the same worktree", async () => {
  const root = repo();
  plan(root, "run-answer-missing");
  const calls = logFile();
  launchTaskWorker(root, "run-answer-missing", "work", lane(root), {
    codexCommand: [process.execPath, askFixture, `--log=${calls}`, "--ask=scope:lib/helper.js", "--write=src/notes.txt", "--granted=lib/helper.js"]
  });
  let { task } = await settle(root, "run-answer-missing");
  const threadId = task.attempts[0].threadId;
  answerTaskWorker(root, "run-answer-missing", "work", lane(root), {
    grantScope: ["lib/helper.js"],
    codexCommand: [
      process.execPath, askFixture, `--log=${calls}`, "--ask=scope:lib/helper.js",
      "--write=src/notes.txt", "--granted=lib/helper.js", `--missing=${threadId}`
    ]
  });
  ({ task } = await settle(root, "run-answer-missing"));
  assert.equal(task.status, "reported");
  assert.match(task.result.structured.summary, /granted=true/);
  const attempt = task.attempts[0];
  assert.equal(attempt.inputRequests[0].answer.resumeFallback.reason, "thread_missing");
  assert.equal(attempt.inputRequests[0].answer.resumeFallback.resumeThreadId, threadId);
  assert.equal(attempt.resumeFallback, undefined);
  const log = readLog(calls);
  assert.equal(log.length, 3);
  assert.ok(log[1].argv.includes("resume"));
  assert.equal(log[2].argv.includes("resume"), false);
  assert.equal(log[2].cwd, log[0].cwd);
  assert.match(log[2].prompt, /## Assignment/);
  assert.match(log[2].prompt, /## Supervisor answers[\s\S]+### Request 1[\s\S]+decision: granted `lib\/helper\.js` to this task/);
  const fallback = events(root, "run-answer-missing").find((event) => event.type === "task.resume_fallback");
  assert.equal(fallback.inputRound, 1);
  assert.match(
    renderSupervisorBriefing(root, loadRun(root, "run-answer-missing"), lane(root)),
    /work-attempt-1: pending — 1 answered input request \(same attempt, same thread; 1 resume FELL BACK/
  );
});

test("an answered task continues on the substituted model its attempt is using", async () => {
  const root = repo();
  plan(root, "run-answer-substituted", [{ id: "work", kind: "write", scope: ["src/**"] }], { model: "astra" });
  const calls = logFile();
  launchTaskWorker(root, "run-answer-substituted", "work", lane(root), {
    codexCommand: [
      process.execPath, askFixture, `--log=${calls}`, "--unavailable=gpt-6.2-astra",
      "--ask=scope:lib/helper.js", "--granted=lib/helper.js"
    ]
  });
  let { task } = await settle(root, "run-answer-substituted");
  assert.equal(task.status, "needs_input");
  assert.equal(task.attempts.length, 2);
  assert.equal(task.attempts[1].model, "gpt-6.2-sol");
  assert.equal(task.attempts[1].substitution.requestedModel, "gpt-6.2-astra");
  const answered = answerTaskWorker(root, "run-answer-substituted", "work", lane(root), {
    grantScope: ["lib/helper.js"]
  });
  assert.equal(answered.model, "gpt-6.2-sol");
  assert.equal(answered.attemptId, "work-attempt-2");
  ({ task } = await settle(root, "run-answer-substituted"));
  assert.equal(task.status, "reported");
  assert.equal(task.attempts.length, 2);
  const resumed = readLog(calls).at(-1);
  assert.ok(resumed.argv.includes("resume"));
  assert.equal(resumed.argv[resumed.argv.indexOf("--model") + 1], "gpt-6.2-sol");
  assert.equal(configValue(resumed.argv, "model_reasoning_effort"), 'model_reasoning_effort="high"');
  assert.equal(resumed.argv[resumed.argv.indexOf("--sandbox") + 1], "workspace-write");
});

test("runs saved before needs_input existed load, pause, and answer", () => {
  const root = repo();
  plan(root, "run-old-answer");
  const file = runFile(root, "run-old-answer");
  const state = JSON.parse(fs.readFileSync(file, "utf8"));
  state.version = 5;
  delete state.contract;
  fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
  paused(root, "run-old-answer", "work");
  const answered = answerTask(root, "run-old-answer", "work", lane(root), { grantScope: ["lib/helper.js"] });
  assert.equal(answered.round.round, 1);
  assert.equal(loadRun(root, "run-old-answer").version, 7);
});

test("a malformed needs_input request fails the result contract", () => {
  const root = repo();
  plan(root, "run-malformed-ask");
  const claimed = claimTask(root, "run-malformed-ask", "work", lane(root));
  recordTaskResult(root, "run-malformed-ask", "work", {
    attemptId: claimed.attemptId,
    resultText: structured({ needs_input: { ...scopeRequest(["/etc/passwd"]) } })
  });
  const task = loadRun(root, "run-malformed-ask").tasks.work;
  assert.equal(task.status, "failed");
  assert.deepEqual(task.result.missingFields, ["needs_input"]);
  assert.equal(task.attempts[0].outcome.terminalOutcome, "contract_failed");
});

test("a poll between recording an answer and attaching its worker does not collect the answered request again", async () => {
  const root = repo();
  plan(root, "run-answer-race");
  launchTaskWorker(root, "run-answer-race", "work", lane(root), {
    codexCommand: [process.execPath, askFixture, "--ask=scope:lib/helper.js", "--write=src/notes.txt"]
  });
  await settle(root, "run-answer-race");
  // `run answer` has recorded the answer but not yet attached the resumed worker.
  answerTask(root, "run-answer-race", "work", lane(root), { grantScope: ["lib/helper.js"] });
  const updates = pollRunWorkers(root, "run-answer-race");
  const task = loadRun(root, "run-answer-race").tasks.work;
  assert.equal(task.status, "dispatching");
  assert.equal(task.attempts[0].inputRequests.length, 1);
  assert.equal(updates.some((update) => update.changed), false);
  // If `run answer` died here, the task is dispatching with no worker; the
  // supervisor can cancel it and retry, as for a launch that never attached.
  assert.equal(cancelTask(root, "run-answer-race", "work", "the answer never launched").status, "cancelled");
  assert.equal(retryTask(root, "run-answer-race", "work").status, "pending");
});

test("a resume that Codex silently replaces with a new thread is relaunched with the full briefing", async () => {
  const root = repo();
  plan(root, "run-answer-replaced");
  const calls = logFile();
  launchTaskWorker(root, "run-answer-replaced", "work", lane(root), {
    codexCommand: [process.execPath, askFixture, `--log=${calls}`, "--ask=scope:lib/helper.js", "--write=src/notes.txt", "--granted=lib/helper.js"]
  });
  let { task } = await settle(root, "run-answer-replaced");
  const threadId = task.attempts[0].threadId;
  answerTaskWorker(root, "run-answer-replaced", "work", lane(root), {
    grantScope: ["lib/helper.js"],
    codexCommand: [
      process.execPath, askFixture, `--log=${calls}`, "--ask=scope:lib/helper.js",
      "--write=src/notes.txt", "--granted=lib/helper.js", `--replace=${threadId}`
    ]
  });
  ({ task } = await settle(root, "run-answer-replaced"));
  assert.equal(task.status, "reported");
  assert.match(task.result.structured.summary, /granted=true/);
  assert.equal(task.attempts[0].inputRequests[0].answer.resumeFallback.reason, "thread_replaced");
  const log = readLog(calls);
  assert.equal(log.length, 3);
  assert.ok(log[1].argv.includes("resume"));
  assert.equal(log[2].argv.includes("resume"), false);
  assert.match(log[2].prompt, /## Assignment/);
  assert.match(log[2].prompt, /## Supervisor answers[\s\S]+### Request 1/);
});

test("an over-limit flag from before an answer is not shown once the resumed worker has a new clock", async () => {
  const root = repo();
  plan(root, "run-answer-clock");
  launchTaskWorker(root, "run-answer-clock", "work", lane(root), {
    codexCommand: [process.execPath, askFixture, "--ask=scope:lib/helper.js", "--write=src/notes.txt"]
  });
  await settle(root, "run-answer-clock");
  // The paused worker had gone over its limit before it asked.
  const file = runFile(root, "run-answer-clock");
  const state = JSON.parse(fs.readFileSync(file, "utf8"));
  const first = state.tasks.work.attempts[0];
  first.overLimit = { clockStart: first.runner.launchedAt, detectedAt: first.runner.launchedAt, elapsedMinutes: 99, timeoutMinutes: 1 };
  fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
  answerTask(root, "run-answer-clock", "work", lane(root), { grantScope: ["lib/helper.js"] });
  assert.doesNotMatch(renderSupervisorBriefing(root, loadRun(root, "run-answer-clock"), lane(root)), /OVER LIMIT/);
});

test("a model rejection on an answered resume fails the attempt instead of substituting it", async () => {
  const root = repo();
  plan(root, "run-answer-rejected");
  launchTaskWorker(root, "run-answer-rejected", "work", lane(root), {
    codexCommand: [process.execPath, askFixture, "--ask=scope:lib/helper.js", "--partial"]
  });
  await settle(root, "run-answer-rejected");
  answerTaskWorker(root, "run-answer-rejected", "work", lane(root), {
    grantScope: ["lib/helper.js"],
    codexCommand: [process.execPath, askFixture, "--ask=scope:lib/helper.js", "--partial", "--unavailable=gpt-6.2-sol"]
  });
  const { task } = await settle(root, "run-answer-rejected");
  // The attempt worked before it paused; it is not "never reached a worker".
  assert.equal(task.status, "failed");
  assert.equal(task.attempts.length, 1);
  assert.equal(task.attempts[0].modelUnavailable, undefined);
  assert.deepEqual(loadRun(root, "run-answer-rejected").unavailableModels ?? [], []);
});

test("a pending task cannot launch onto scope granted to an active task", () => {
  const root = repo();
  plan(root, "run-grant-pending", [
    { id: "work", kind: "write", scope: ["src/**"] },
    { id: "helpers", kind: "write", scope: ["lib/**"] },
    { id: "docs", kind: "write", scope: ["src/docs/**"] }
  ]);
  paused(root, "run-grant-pending", "work");
  // helpers is pending, so the grant is not refused when it is made.
  answerTask(root, "run-grant-pending", "work", lane(root), { grantScope: ["lib/helper.js"] });
  assert.throws(
    () => claimTask(root, "run-grant-pending", "helpers", lane(root)),
    /Task "helpers" cannot launch yet: its scope `lib\/\*\*` overlaps `lib\/helper\.js` granted to dispatching task "work"/
  );
  assert.equal(loadRun(root, "run-grant-pending").tasks.helpers.status, "pending");
  // run ready lists it apart instead of offering it for dispatch.
  const ready = JSON.parse(runCli(root, ["run", "ready", "run-grant-pending", "--json"]).stdout);
  assert.deepEqual(ready.tasks.map((task) => task.id), ["docs"]);
  assert.deepEqual(ready.blocked.map((task) => task.id), ["helpers"]);
  assert.match(runCli(root, ["run", "ready", "run-grant-pending"]).stdout, /helpers\tcannot launch: its scope `lib\/\*\*` overlaps/);
  // Planned scopes that overlap each other are still the supervisor's call.
  assert.doesNotThrow(() => claimTask(root, "run-grant-pending", "docs", lane(root)));
});

test("a resumed worker that cannot be attached is stopped and the answer reverted", async () => {
  const root = repo();
  plan(root, "run-answer-orphan");
  launchTaskWorker(root, "run-answer-orphan", "work", lane(root), {
    codexCommand: [process.execPath, askFixture, "--ask=scope:lib/helper.js"]
  });
  await settle(root, "run-answer-orphan");
  // Fail the second run.json write (attachExecution's); the first is answerTask's.
  const file = runFile(root, "run-answer-orphan");
  const original = fs.renameSync;
  let writes = 0;
  fs.renameSync = function (from, to, ...rest) {
    if (String(to) === file && ++writes === 2) {
      throw new Error("disk full");
    }
    return original.call(this, from, to, ...rest);
  };
  try {
    assert.throws(
      () => answerTaskWorker(root, "run-answer-orphan", "work", lane(root), {
        grantScope: ["lib/helper.js"],
        codexCommand: [process.execPath, path.join(fixtures, "fake-codex-slow.mjs"), "--delay=10000"]
      }),
      /disk full/
    );
  } finally {
    fs.renameSync = original;
  }
  const task = loadRun(root, "run-answer-orphan").tasks.work;
  assert.equal(task.status, "needs_input");
  const roundDir = path.join(path.dirname(task.attempts[0].runner.statusFile), "round-1");
  const status = JSON.parse(fs.readFileSync(path.join(roundDir, "status.json"), "utf8"));
  assert.equal(status.status, "cancelled");
  // The process itself is gone, not just marked cancelled.
  const alive = () => {
    try {
      process.kill(status.pid, 0);
      return true;
    } catch (error) {
      return error.code !== "ESRCH";
    }
  };
  const deadline = Date.now() + 5000;
  while (alive() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(alive(), false, `worker ${status.pid} still running`);
});

test("a poll that read a runner since replaced by an answered resume cannot collect from it", async () => {
  const root = repo();
  plan(root, "run-answer-stale");
  launchTaskWorker(root, "run-answer-stale", "work", lane(root), {
    codexCommand: [process.execPath, askFixture, "--ask=scope:lib/helper.js", "--write=src/notes.txt"]
  });
  await settle(root, "run-answer-stale");
  // A slow poll read the paused runner's files before the answer ...
  const stale = loadRun(root, "run-answer-stale").tasks.work.attempts[0].runner;
  answerTaskWorker(root, "run-answer-stale", "work", lane(root), {
    grantScope: ["lib/helper.js"],
    codexCommand: [process.execPath, path.join(fixtures, "fake-codex-slow.mjs"), "--delay=10000"]
  });
  // ... and only now tries to apply what it read.
  assert.throws(
    () => recordTaskResult(root, "run-answer-stale", "work", {
      attemptId: "work-attempt-1",
      resultText: fs.readFileSync(stale.lastMessageFile, "utf8"),
      runnerStatusFile: stale.statusFile
    }),
    StaleRunnerError
  );
  const task = loadRun(root, "run-answer-stale").tasks.work;
  assert.equal(task.status, "running");
  assert.equal(task.attempts[0].inputRequests.length, 1);
  stopTaskWorker(task.attempts[0]);
});

test("a failed attach that was already saved is reverted, and the next answer starts clean", async () => {
  const root = repo();
  plan(root, "run-answer-attach");
  launchTaskWorker(root, "run-answer-attach", "work", lane(root), {
    codexCommand: [process.execPath, askFixture, "--ask=scope:lib/helper.js", "--write=src/notes.txt", "--granted=lib/helper.js"]
  });
  await settle(root, "run-answer-attach");
  // attachExecution saves the run, then its event append fails.
  const events = eventsFile(root, "run-answer-attach");
  const original = fs.appendFileSync;
  fs.appendFileSync = function (target, data, ...rest) {
    if (String(target) === events && String(data).includes("task.execution_started")) {
      throw new Error("disk full");
    }
    return original.call(this, target, data, ...rest);
  };
  try {
    assert.throws(
      () => answerTaskWorker(root, "run-answer-attach", "work", lane(root), {
        grantScope: ["lib/helper.js"],
        codexCommand: [process.execPath, path.join(fixtures, "fake-codex-slow.mjs"), "--delay=10000"]
      }),
      /disk full/
    );
  } finally {
    fs.appendFileSync = original;
  }
  let task = loadRun(root, "run-answer-attach").tasks.work;
  assert.equal(task.status, "needs_input");
  assert.equal(task.attempts[0].inputRequests[0].failedAnswers.length, 1);

  // Answering again runs in a fresh directory: the stopped try's cancelled
  // status file is never read for it.
  const answered = answerTaskWorker(root, "run-answer-attach", "work", lane(root), { grantScope: ["lib/helper.js"] });
  assert.match(answered.runner.statusFile, /round-1-try-2/);
  ({ task } = await settle(root, "run-answer-attach"));
  assert.equal(task.status, "reported");
  assert.match(task.result.structured.summary, /granted=true/);
});

test("a result written by a discarded replacement thread is never collected for the relaunch", async () => {
  const root = repo();
  plan(root, "run-answer-replaced-result");
  launchTaskWorker(root, "run-answer-replaced-result", "work", lane(root), {
    codexCommand: [process.execPath, askFixture, "--ask=scope:lib/helper.js", "--write=src/notes.txt"]
  });
  let { task } = await settle(root, "run-answer-replaced-result");
  const threadId = task.attempts[0].threadId;
  answerTaskWorker(root, "run-answer-replaced-result", "work", lane(root), {
    grantScope: ["lib/helper.js"],
    codexCommand: [
      process.execPath, askFixture, "--ask=scope:lib/helper.js", "--write=src/notes.txt",
      `--replace=${threadId}`, "--replaced-writes", "--fallback-silent"
    ]
  });
  ({ task } = await settle(root, "run-answer-replaced-result"));
  // The relaunch wrote nothing, so the attempt has no result: not the discarded one.
  assert.equal(task.status, "failed");
  assert.equal(task.attempts[0].outcome.reasonCode, "missing_result");
});

test("a poll racing run answer skips the runner it read instead of collecting it again", async () => {
  const root = repo();
  plan(root, "run-answer-interleaved");
  const launched = launchTaskWorker(root, "run-answer-interleaved", "work", lane(root), {
    codexCommand: [process.execPath, askFixture, "--ask=scope:lib/helper.js", "--write=src/notes.txt"]
  });
  const statusFile = launched.runner.statusFile;
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      if (JSON.parse(fs.readFileSync(statusFile, "utf8")).status === "completed") {
        break;
      }
    } catch {
      // Not written yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  // The outer poll reads the finished runner's status; before it acts, another
  // poll collects the request and the supervisor answers it.
  const original = fs.readFileSync;
  let fired = false;
  fs.readFileSync = function (target, ...rest) {
    const content = original.call(this, target, ...rest);
    if (!fired && String(target) === statusFile) {
      fired = true;
      pollRunWorkers(root, "run-answer-interleaved");
      answerTaskWorker(root, "run-answer-interleaved", "work", lane(root), {
        grantScope: ["lib/helper.js"],
        codexCommand: [process.execPath, path.join(fixtures, "fake-codex-slow.mjs"), "--delay=10000"]
      });
    }
    return content;
  };
  let updates;
  try {
    updates = pollRunWorkers(root, "run-answer-interleaved");
  } finally {
    fs.readFileSync = original;
  }
  assert.ok(fired);
  assert.equal(updates.some((update) => update.changed), false);
  const task = loadRun(root, "run-answer-interleaved").tasks.work;
  assert.equal(task.status, "running");
  assert.equal(task.attempts[0].inputRequests.length, 1);
  stopTaskWorker(task.attempts[0]);
});

/** Wait until a process is gone; true if it exited within the deadline. */
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

/** Run `effect` once, the first time a directory matching `pattern` is created. */
function onMkdir(pattern, effect) {
  const original = fs.mkdirSync;
  let fired = false;
  fs.mkdirSync = function (target, ...rest) {
    if (!fired && pattern.test(String(target))) {
      fired = true;
      effect();
    }
    return original.call(this, target, ...rest);
  };
  return { restore: () => { fs.mkdirSync = original; }, fired: () => fired };
}

test("a cancellation while an answered worker is spawned stays cancelled and the worker is stopped", async () => {
  const root = repo();
  plan(root, "run-answer-cancel");
  launchTaskWorker(root, "run-answer-cancel", "work", lane(root), {
    codexCommand: [process.execPath, askFixture, "--ask=scope:lib/helper.js", "--write=src/notes.txt"]
  });
  await settle(root, "run-answer-cancel");
  // The answer is recorded; before its worker is attached, the user cancels.
  const hook = onMkdir(/round-1$/, () => cancelTask(root, "run-answer-cancel", "work", "user stopped it"));
  try {
    assert.throws(
      () => answerTaskWorker(root, "run-answer-cancel", "work", lane(root), {
        grantScope: ["lib/helper.js"],
        codexCommand: [process.execPath, path.join(fixtures, "fake-codex-slow.mjs"), "--delay=10000"]
      }),
      AttachRefusedError
    );
  } finally {
    hook.restore();
  }
  assert.ok(hook.fired());
  const task = loadRun(root, "run-answer-cancel").tasks.work;
  assert.equal(task.status, "cancelled");
  assert.equal(task.attempts[0].status, "cancelled");
  const roundDir = path.join(path.dirname(task.attempts[0].inputRequests[0].answer.previousRunner.statusFile), "round-1");
  const status = JSON.parse(fs.readFileSync(path.join(roundDir, "status.json"), "utf8"));
  assert.ok(await gone(status.pid), `answered worker ${status.pid} still running after cancellation`);
});

test("a cancellation while a worker is launched stays cancelled and the worker is stopped", async () => {
  const root = repo();
  plan(root, "run-launch-cancel");
  const hook = onMkdir(/work-attempt-1$/, () => cancelTask(root, "run-launch-cancel", "work", "user stopped it"));
  try {
    assert.throws(
      () => launchTaskWorker(root, "run-launch-cancel", "work", lane(root), {
        codexCommand: [process.execPath, path.join(fixtures, "fake-codex-slow.mjs"), "--delay=10000"]
      }),
      AttachRefusedError
    );
  } finally {
    hook.restore();
  }
  assert.ok(hook.fired());
  const task = loadRun(root, "run-launch-cancel").tasks.work;
  assert.equal(task.status, "cancelled");
  assert.equal(task.attempts[0].status, "cancelled");
  assert.equal(task.attempts[0].outcome.terminalOutcome, "cancelled");
  const status = JSON.parse(fs.readFileSync(path.join(path.dirname(runFile(root, "run-launch-cancel")), "workers", "work", "work-attempt-1", "status.json"), "utf8"));
  assert.ok(await gone(status.pid), `launched worker ${status.pid} still running after cancellation`);
  // The worktree the refused launch created is recorded, so cleanup removes it.
  const worktree = task.attempts[0].worktree;
  assert.ok(worktree?.path && fs.existsSync(worktree.path), "the refused launch's worktree is recorded");
  const removed = JSON.parse(runCli(root, ["run", "cleanup", "run-launch-cancel", "--json"]).stdout);
  assert.deepEqual(removed.filter((entry) => entry === worktree.path), [worktree.path]);
  assert.equal(fs.existsSync(worktree.path), false);
});

test("a worker attached just before cancellation acquires its lock is still stopped", async () => {
  const root = repo();
  plan(root, "run-cancel-late");
  const file = runFile(root, "run-cancel-late");
  // Attachment can finish before cancellation acquires the lock, not between
  // its locked read and save. The stop pass must see the newly attached worker.
  const original = fs.openSync;
  let fired = false;
  fs.openSync = function (target, ...rest) {
    if (!fired && String(target) === `${file}.lock` && rest[0] === "wx") {
      fired = true;
      fs.openSync = original;
      launchTaskWorker(root, "run-cancel-late", "work", lane(root), {
        codexCommand: [process.execPath, path.join(fixtures, "fake-codex-slow.mjs"), "--delay=10000"]
      });
    }
    return original.call(this, target, ...rest);
  };
  try {
    cancelWorkers(root, "run-cancel-late", "work", "user stopped it");
  } finally {
    fs.openSync = original;
  }
  assert.ok(fired);
  const attempt = loadRun(root, "run-cancel-late").tasks.work.attempts[0];
  assert.equal(attempt.status, "cancelled");
  const status = JSON.parse(fs.readFileSync(attempt.runner.statusFile, "utf8"));
  assert.ok(await gone(attempt.runner.pid), `worker ${attempt.runner.pid} still running after cancellation`);
  assert.equal(status.status, "cancelled");
});

test("two polls racing on a paused worker do not crash the slower one", async () => {
  const root = repo();
  plan(root, "run-poll-race");
  const launched = launchTaskWorker(root, "run-poll-race", "work", lane(root), {
    codexCommand: [process.execPath, askFixture, "--ask=scope:lib/helper.js", "--write=src/notes.txt"]
  });
  const statusFile = launched.runner.statusFile;
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      if (JSON.parse(fs.readFileSync(statusFile, "utf8")).status === "completed") {
        break;
      }
    } catch {
      // Not written yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  // The outer poll reads the finished runner; another poll collects the request
  // before it acts, and no answer replaces the runner in between.
  const original = fs.readFileSync;
  let fired = false;
  let inner;
  fs.readFileSync = function (target, ...rest) {
    const content = original.call(this, target, ...rest);
    if (!fired && String(target) === statusFile) {
      fired = true;
      inner = pollRunWorkers(root, "run-poll-race");
    }
    return content;
  };
  try {
    pollRunWorkers(root, "run-poll-race");
  } finally {
    fs.readFileSync = original;
  }
  assert.ok(fired);
  assert.equal(inner.find((update) => update.taskId === "work").status, "needs_input");
  const task = loadRun(root, "run-poll-race").tasks.work;
  assert.equal(task.status, "needs_input");
  assert.equal(task.attempts[0].inputRequests.length, 1);
});

test("an answer whose event cannot be written is reverted instead of left dispatching", async () => {
  const root = repo();
  plan(root, "run-answer-event");
  launchTaskWorker(root, "run-answer-event", "work", lane(root), {
    codexCommand: [process.execPath, askFixture, "--ask=scope:lib/helper.js", "--write=src/notes.txt", "--granted=lib/helper.js"]
  });
  await settle(root, "run-answer-event");
  const events = eventsFile(root, "run-answer-event");
  const original = fs.appendFileSync;
  fs.appendFileSync = function (target, data, ...rest) {
    if (String(target) === events && String(data).includes("task.input_answered")) {
      throw new Error("disk full");
    }
    return original.call(this, target, data, ...rest);
  };
  try {
    assert.throws(
      () => answerTaskWorker(root, "run-answer-event", "work", lane(root), { grantScope: ["lib/helper.js"] }),
      /disk full/
    );
  } finally {
    fs.appendFileSync = original;
  }
  let task = loadRun(root, "run-answer-event").tasks.work;
  assert.equal(task.status, "needs_input");
  assert.ok(task.attempts[0].runner, "the paused runner is restored");
  assert.equal(task.attempts[0].inputRequests[0].failedAnswers.length, 1);
  assert.deepEqual(task.scopeGrants ?? [], []);

  answerTaskWorker(root, "run-answer-event", "work", lane(root), { grantScope: ["lib/helper.js"] });
  ({ task } = await settle(root, "run-answer-event"));
  assert.equal(task.status, "reported");
  assert.match(task.result.structured.summary, /granted=true/);
});

test("reverting a failed answer restores the thread the next answer resumes", async () => {
  const root = repo();
  plan(root, "run-answer-thread");
  launchTaskWorker(root, "run-answer-thread", "work", lane(root), {
    codexCommand: [process.execPath, askFixture, "--ask=scope:lib/helper.js", "--write=src/notes.txt"]
  });
  const { task: paused } = await settle(root, "run-answer-thread");
  const original = paused.attempts[0].threadId;
  assert.ok(original);
  const answered = answerTask(root, "run-answer-thread", "work", lane(root), { grantScope: ["lib/helper.js"] });
  const failedStatusFile = path.join(path.dirname(runFile(root, "run-answer-thread")), "failed-runner-status.json");
  attachExecution(root, "run-answer-thread", "work", {
    attemptId: answered.attemptId,
    worktree: answered.worktree,
    runner: { pid: null, status: "starting", statusFile: failedStatusFile, inputRound: 1 }
  });
  // A poll syncs the failed runner's replacement thread before the revert.
  syncExecutionStatus(root, "run-answer-thread", "work", {
    attemptId: answered.attemptId,
    status: { status: "running", threadId: "discarded-replacement-thread" },
    runnerStatusFile: failedStatusFile
  });
  revertTaskAnswer(root, "run-answer-thread", "work", {
    attemptId: answered.attemptId,
    round: answered.round.round,
    error: "attach failed",
    failedRunnerStatusFile: failedStatusFile
  });
  assert.equal(loadRun(root, "run-answer-thread").tasks.work.attempts[0].threadId, original);
  const again = answerTask(root, "run-answer-thread", "work", lane(root), { grantScope: ["lib/helper.js"] });
  assert.equal(again.resumeThreadId, original);
});

test("an answer whose briefing cannot be rendered stays waiting for input", async () => {
  const root = repo();
  plan(root, "run-answer-briefing");
  launchTaskWorker(root, "run-answer-briefing", "work", lane(root), {
    codexCommand: [process.execPath, askFixture, "--ask=scope:lib/helper.js", "--write=src/notes.txt", "--granted=lib/helper.js"]
  });
  await settle(root, "run-answer-briefing");
  const ledger = path.join(root, ".orchestrator", "ledger.md");
  assert.ok(fs.existsSync(ledger));
  const original = fs.readFileSync;
  fs.readFileSync = function (target, ...rest) {
    if (String(target) === ledger) {
      throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    }
    return original.call(this, target, ...rest);
  };
  try {
    assert.throws(
      () => answerTaskWorker(root, "run-answer-briefing", "work", lane(root), { grantScope: ["lib/helper.js"] }),
      /EACCES/
    );
  } finally {
    fs.readFileSync = original;
  }
  let task = loadRun(root, "run-answer-briefing").tasks.work;
  assert.equal(task.status, "needs_input");
  assert.ok(task.attempts[0].runner, "the paused runner is kept");
  assert.equal(task.attempts[0].inputRequests[0].answer, null);
  assert.deepEqual(task.scopeGrants ?? [], []);

  answerTaskWorker(root, "run-answer-briefing", "work", lane(root), { grantScope: ["lib/helper.js"] });
  ({ task } = await settle(root, "run-answer-briefing"));
  assert.equal(task.status, "reported");
});

test("a poll holding an older status snapshot cannot overwrite a newer one already synchronized", async () => {
  const root = repo();
  plan(root, "run-stale-snapshot");
  launchTaskWorker(root, "run-stale-snapshot", "work", lane(root), {
    codexCommand: [process.execPath, askFixture, "--ask=scope:lib/helper.js", "--write=src/notes.txt"]
  });
  await settle(root, "run-stale-snapshot");
  const answered = answerTask(root, "run-stale-snapshot", "work", lane(root), { grantScope: ["lib/helper.js"] });
  const statusFile = path.join(path.dirname(runFile(root, "run-stale-snapshot")), "stale-status.json");
  attachExecution(root, "run-stale-snapshot", "work", {
    attemptId: answered.attemptId,
    worktree: answered.worktree,
    runner: { pid: null, status: "starting", statusFile, inputRound: 1 }
  });
  const sync = (seq, threadId) => syncExecutionStatus(root, "run-stale-snapshot", "work", {
    attemptId: answered.attemptId,
    status: { seq, status: "running", threadId },
    runnerStatusFile: statusFile
  });
  // Poll B synchronizes the wrapper's later write; poll A then saves the earlier one it read.
  sync(4, "thread-full-briefing");
  assert.throws(() => sync(2, "thread-discarded-replacement"), StaleRunnerError);
  assert.equal(loadRun(root, "run-stale-snapshot").tasks.work.attempts[0].threadId, "thread-full-briefing");
  // The same snapshot again is harmless.
  sync(4, "thread-full-briefing");
});

test("cancelling a worker also stops the processes it started", async () => {
  const root = repo();
  plan(root, "run-cancel-tree");
  const pidFile = path.join(path.dirname(runFile(root, "run-cancel-tree")), "descendant.pid");
  const launched = launchTaskWorker(root, "run-cancel-tree", "work", lane(root), {
    codexCommand: [process.execPath, path.join(fixtures, "fake-codex-slow.mjs"), "--delay=60000", `--descendant=${pidFile}`]
  });
  const deadline = Date.now() + 10000;
  while (!fs.existsSync(pidFile) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  const descendant = Number(fs.readFileSync(pidFile, "utf8"));
  try {
    cancelWorkers(root, "run-cancel-tree", "work", "user stopped it");
    // The descendant ignores SIGTERM, so it takes the wrapper's SIGKILL after 5 s.
    assert.ok(await gone(descendant, 10000), `descendant ${descendant} still running after cancellation`);
    assert.ok(await gone(launched.runner.pid, 10000), `wrapper ${launched.runner.pid} still running after cancellation`);
  } finally {
    try {
      process.kill(descendant, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  assert.equal(loadRun(root, "run-cancel-tree").tasks.work.status, "cancelled");
});

test("a launch whose briefing cannot be rendered leaves the task launchable", () => {
  const root = repo();
  plan(root, "run-claim-briefing");
  const ledger = path.join(root, ".orchestrator", "ledger.md");
  const original = fs.readFileSync;
  fs.readFileSync = function (target, ...rest) {
    if (String(target) === ledger) {
      throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    }
    return original.call(this, target, ...rest);
  };
  try {
    assert.throws(
      () => launchTaskWorker(root, "run-claim-briefing", "work", lane(root), {
        codexCommand: [process.execPath, path.join(fixtures, "fake-codex-slow.mjs"), "--delay=10000"]
      }),
      /EACCES/
    );
  } finally {
    fs.readFileSync = original;
  }
  const task = loadRun(root, "run-claim-briefing").tasks.work;
  assert.equal(task.status, "pending");
  assert.equal(task.attempts.length, 0);
  const launched = launchTaskWorker(root, "run-claim-briefing", "work", lane(root), {
    codexCommand: [process.execPath, path.join(fixtures, "fake-codex-slow.mjs"), "--delay=10000"]
  });
  stopTaskWorker({ runner: launched.runner });
});

test("a worker attached during a cancellation whose event fails is still stopped", async () => {
  const root = repo();
  plan(root, "run-cancel-event");
  const file = runFile(root, "run-cancel-event");
  const events = eventsFile(root, "run-cancel-event");
  const originalOpen = fs.openSync;
  const originalAppend = fs.appendFileSync;
  let fired = false;
  fs.openSync = function (target, ...rest) {
    if (!fired && String(target) === `${file}.lock` && rest[0] === "wx") {
      fired = true;
      fs.openSync = originalOpen;
      launchTaskWorker(root, "run-cancel-event", "work", lane(root), {
        codexCommand: [process.execPath, path.join(fixtures, "fake-codex-slow.mjs"), "--delay=10000"]
      });
    }
    return originalOpen.call(this, target, ...rest);
  };
  fs.appendFileSync = function (target, data, ...rest) {
    if (String(target) === events && String(data).includes("\"task.cancelled\"")) {
      throw new Error("disk full");
    }
    return originalAppend.call(this, target, data, ...rest);
  };
  try {
    assert.throws(() => cancelWorkers(root, "run-cancel-event", "work", "user stopped it"), /disk full/);
  } finally {
    fs.openSync = originalOpen;
    fs.appendFileSync = originalAppend;
  }
  assert.ok(fired);
  const attempt = loadRun(root, "run-cancel-event").tasks.work.attempts[0];
  assert.equal(attempt.status, "cancelled");
  assert.ok(await gone(attempt.runner.pid), `worker ${attempt.runner.pid} still running after cancellation`);
});

test("cancelling stops a started process even when Codex itself exits first", async () => {
  const root = repo();
  plan(root, "run-cancel-quiet");
  const pidFile = path.join(path.dirname(runFile(root, "run-cancel-quiet")), "descendant.pid");
  const launched = launchTaskWorker(root, "run-cancel-quiet", "work", lane(root), {
    codexCommand: [process.execPath, path.join(fixtures, "fake-codex-slow.mjs"), "--delay=60000", `--descendant=${pidFile}`, "--quiet-descendant"]
  });
  const deadline = Date.now() + 10000;
  while (!fs.existsSync(pidFile) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  const descendant = Number(fs.readFileSync(pidFile, "utf8"));
  try {
    cancelWorkers(root, "run-cancel-quiet", "work", "user stopped it");
    assert.ok(await gone(launched.runner.pid, 10000), "wrapper exits");
    assert.ok(await gone(descendant, 3000), `descendant ${descendant} survived the cancellation`);
  } finally {
    try {
      process.kill(descendant, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
});

test("a replaced resume whose launcher left a process holding its pipes still relaunches with the briefing", async () => {
  const root = repo();
  plan(root, "run-replaced-tree");
  launchTaskWorker(root, "run-replaced-tree", "work", lane(root), {
    codexCommand: [process.execPath, askFixture, "--ask=scope:lib/helper.js", "--write=src/notes.txt", "--granted=lib/helper.js"]
  });
  let { task } = await settle(root, "run-replaced-tree");
  const threadId = task.attempts[0].threadId;
  const pidFile = path.join(path.dirname(runFile(root, "run-replaced-tree")), "replaced-descendant.pid");
  answerTaskWorker(root, "run-replaced-tree", "work", lane(root), {
    grantScope: ["lib/helper.js"],
    codexCommand: [
      process.execPath, askFixture, "--ask=scope:lib/helper.js", "--write=src/notes.txt",
      "--granted=lib/helper.js", `--replace=${threadId}`, `--replaced-descendant=${pidFile}`
    ]
  });
  let descendant = null;
  try {
    for (let index = 0; index < 500; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 40));
      if (descendant === null && fs.existsSync(pidFile)) {
        descendant = Number(fs.readFileSync(pidFile, "utf8"));
      }
      pollRunWorkers(root, "run-replaced-tree");
      task = loadRun(root, "run-replaced-tree").tasks.work;
      if (!["running", "dispatching"].includes(task.status)) {
        break;
      }
    }
    assert.equal(task.status, "reported");
    assert.match(task.result.structured.summary, /granted=true/);
    assert.ok(descendant && await gone(descendant, 3000), "the replaced launcher's process was stopped");
  } finally {
    if (descendant) {
      try {
        process.kill(descendant, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }
});

test("a launch undone after its attach was saved leaves an attempt another process moved on alone", () => {
  const root = repo();
  plan(root, "run-attach-moved");
  const events = eventsFile(root, "run-attach-moved");
  const file = runFile(root, "run-attach-moved");
  const original = fs.appendFileSync;
  fs.appendFileSync = function (target, data, ...rest) {
    if (String(target) === events && String(data).includes("\"task.execution_started\"")) {
      // Before this launch can undo itself, another process collects the worker
      // and attaches a resumed runner.
      const run = JSON.parse(fs.readFileSync(file, "utf8"));
      const attempt = run.tasks.work.attempts.at(-1);
      attempt.runner = { ...attempt.runner, statusFile: path.join(path.dirname(file), "resumed-status.json") };
      fs.writeFileSync(file, JSON.stringify(run, null, 2));
      throw new Error("disk full");
    }
    return original.call(this, target, data, ...rest);
  };
  let launched;
  try {
    assert.throws(() => {
      launched = launchTaskWorker(root, "run-attach-moved", "work", lane(root), {
        codexCommand: [process.execPath, path.join(fixtures, "fake-codex-slow.mjs"), "--delay=10000"]
      });
    }, /disk full/);
  } finally {
    fs.appendFileSync = original;
  }
  const attempt = loadRun(root, "run-attach-moved").tasks.work.attempts.at(-1);
  assert.equal(attempt.status, "running", "the attempt the other process now owns is not failed");
  assert.match(attempt.runner.statusFile, /resumed-status\.json$/);
});

test("a cancelled run's tasks cannot be retried", () => {
  const root = repo();
  plan(root, "run-cancelled-retry");
  runCli(root, ["run", "cancel", "run-cancelled-retry"]);
  assert.throws(() => retryTask(root, "run-cancelled-retry", "work"), /was cancelled; its tasks cannot be retried/);
});

test("a delayed answer rollback leaves a later round's answer alone", () => {
  const root = repo();
  plan(root, "run-answer-rounds");
  const claimed = paused(root, "run-answer-rounds", "work");
  // Process A answers round 1 and attaches its runner, but its event fails.
  const first = answerTask(root, "run-answer-rounds", "work", lane(root), { grantScope: ["lib/helper.js"] });
  const failedStatusFile = path.join(path.dirname(runFile(root, "run-answer-rounds")), "round-1-status.json");
  attachExecution(root, "run-answer-rounds", "work", {
    attemptId: claimed.attemptId,
    worktree: first.worktree,
    runner: { pid: null, status: "starting", statusFile: failedStatusFile, inputRound: 1 }
  });
  // Before A reverts, another poll collects that runner's next request, and
  // process B answers round 2.
  recordTaskResult(root, "run-answer-rounds", "work", {
    attemptId: claimed.attemptId,
    resultText: structured({ needs_input: scopeRequest(["lib/other.js"]) }),
    runnerStatusFile: failedStatusFile
  });
  answerTask(root, "run-answer-rounds", "work", lane(root), { grantScope: ["lib/other.js"] });
  revertTaskAnswer(root, "run-answer-rounds", "work", {
    attemptId: claimed.attemptId,
    round: first.round.round,
    error: "event append failed",
    failedRunnerStatusFile: failedStatusFile
  });
  const task = loadRun(root, "run-answer-rounds").tasks.work;
  assert.equal(task.status, "dispatching");
  assert.equal(task.attempts[0].inputRequests.at(-1).round, 2);
  assert.ok(task.attempts[0].inputRequests.at(-1).answer, "round 2's answer is kept");
  assert.ok(task.scopeGrants.some((grant) => grant.round === 2), "round 2's grant is kept");
});

test("a worker that finishes leaves no process it started running", async () => {
  const root = repo();
  plan(root, "run-finish-quiet");
  const pidFile = path.join(path.dirname(runFile(root, "run-finish-quiet")), "descendant.pid");
  launchTaskWorker(root, "run-finish-quiet", "work", lane(root), {
    codexCommand: [process.execPath, path.join(fixtures, "fake-codex-slow.mjs"), "--delay=300", "--complete", `--descendant=${pidFile}`, "--quiet-descendant"]
  });
  let descendant = null;
  try {
    await settle(root, "run-finish-quiet");
    descendant = Number(fs.readFileSync(pidFile, "utf8"));
    assert.ok(await gone(descendant, 3000), `descendant ${descendant} outlived its finished worker`);
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

test("a worker that finishes while a process it started holds its output still finishes", async () => {
  const root = repo();
  plan(root, "run-finish-holder");
  const pidFile = path.join(path.dirname(runFile(root, "run-finish-holder")), "descendant.pid");
  launchTaskWorker(root, "run-finish-holder", "work", lane(root), {
    codexCommand: [process.execPath, path.join(fixtures, "fake-codex-slow.mjs"), "--delay=300", "--complete", `--descendant=${pidFile}`]
  });
  let descendant = null;
  try {
    const { task } = await settle(root, "run-finish-holder");
    assert.equal(task.status, "reported");
    descendant = Number(fs.readFileSync(pidFile, "utf8"));
    assert.ok(await gone(descendant, 3000), `descendant ${descendant} outlived its finished worker`);
  } finally {
    try {
      descendant ??= Number(fs.readFileSync(pidFile, "utf8"));
      process.kill(descendant, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
});
