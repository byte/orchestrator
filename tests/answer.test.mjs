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
  answerTask,
  bindAttempt,
  claimTask,
  createRun,
  eventsFile,
  loadRun,
  recordTaskResult,
  renderSupervisorBriefing,
  replacePlan,
  retryTask,
  runFile,
  verifyTask
} from "../plugins/orchestrator/scripts/lib/runs.mjs";
import {
  answerTaskWorker,
  launchTaskWorker,
  pollRunWorkers
} from "../plugins/orchestrator/scripts/lib/workers.mjs";
import { inspectTaskWorktree } from "../plugins/orchestrator/scripts/lib/worktrees.mjs";
import { checkpointPlan, cleanup, makeRepo, runCli } from "./helpers.mjs";

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
    /## Workers awaiting your answer[\s\S]+work \(work-attempt-1, request 1 of at most 3\) asks for lib\/helper\.js/
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
  assert.ok(at("--model") > at("resume") && argv[at("--model") + 1] === "gpt-6.1-sol");
  assert.equal(argv[at("-c") + 1], 'model_reasoning_effort="high"');
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
  const refused = runCli(root, ["run", "integrate", "run-stray", "work"]);
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
  assert.match(answered.stdout, /Answered request 1 of work: denied\. Resumed thread thread-ask-\d+ on gpt-6\.1-sol \(high\)/);
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
  assert.ok(resumed.argv.indexOf("--sandbox") < resumed.argv.indexOf("resume"));
  assert.equal(resumed.argv[resumed.argv.indexOf("--sandbox") + 1], "read-only");
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
    { id: "work", title: "work", objective: "Do work", kind: "write", scope: ["src/**"] },
    { id: "next", title: "next", objective: "Do next", kind: "write", scope: ["lib/**"] }
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
      process.execPath, askFixture, `--log=${calls}`, "--unavailable=gpt-6-astra",
      "--ask=scope:lib/helper.js", "--granted=lib/helper.js"
    ]
  });
  let { task } = await settle(root, "run-answer-substituted");
  assert.equal(task.status, "needs_input");
  assert.equal(task.attempts.length, 2);
  assert.equal(task.attempts[1].model, "gpt-6.1-sol");
  assert.equal(task.attempts[1].substitution.requestedModel, "gpt-6-astra");
  const answered = answerTaskWorker(root, "run-answer-substituted", "work", lane(root), {
    grantScope: ["lib/helper.js"]
  });
  assert.equal(answered.model, "gpt-6.1-sol");
  assert.equal(answered.attemptId, "work-attempt-2");
  ({ task } = await settle(root, "run-answer-substituted"));
  assert.equal(task.status, "reported");
  assert.equal(task.attempts.length, 2);
  const resumed = readLog(calls).at(-1);
  assert.ok(resumed.argv.includes("resume"));
  assert.equal(resumed.argv[resumed.argv.indexOf("--model") + 1], "gpt-6.1-sol");
  assert.equal(resumed.argv[resumed.argv.indexOf("-c") + 1], 'model_reasoning_effort="high"');
  assert.equal(resumed.argv[resumed.argv.indexOf("--sandbox") + 1], "workspace-write");
});

test("runs saved before needs_input existed load, pause, and answer", () => {
  const root = repo();
  plan(root, "run-old-answer");
  const file = runFile(root, "run-old-answer");
  const state = JSON.parse(fs.readFileSync(file, "utf8"));
  state.version = 5;
  fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
  paused(root, "run-old-answer", "work");
  const answered = answerTask(root, "run-old-answer", "work", lane(root), { grantScope: ["lib/helper.js"] });
  assert.equal(answered.round.round, 1);
  assert.equal(loadRun(root, "run-old-answer").version, 6);
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
