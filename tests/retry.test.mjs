import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { collectLearningExamples, listLearningExamples } from "../plugins/orchestrator/scripts/lib/learning.mjs";
import {
  bindAttempt,
  claimTask,
  createRun,
  eventsFile,
  failTaskAttempt,
  loadRun,
  recordIntegrationDiagnostic,
  recordTaskDisposition,
  recordTaskResult,
  recoveryReport,
  renderSupervisorBriefing,
  replacePlan,
  retryTask,
  runFile,
  verifyTask
} from "../plugins/orchestrator/scripts/lib/runs.mjs";
import { launchTaskWorker, pollRunWorkers } from "../plugins/orchestrator/scripts/lib/workers.mjs";
import { inspectTaskWorktree } from "../plugins/orchestrator/scripts/lib/worktrees.mjs";
import { assertReadOnlyLaunch, checkpointPlan, cleanup, git, makeRepo, runCli, assertLockedDown, configValue } from "./helpers.mjs";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const resumeFixture = path.join(fixtures, "fake-codex-resume.mjs");
const unavailableFixture = path.join(fixtures, "fake-codex-model-unavailable.mjs");
const lane = { constraints: [] };
const repos = [];

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

function plan(root, id, { kind = "read", model = "sol" } = {}) {
  createRun(root, {
    id,
    lane: "api",
    objective: "Retry with context",
    workerModel: model,
    reasoningEffort: "high"
  });
  replacePlan(root, id, [
    {
      id: "work",
      title: "Work",
      objective: "Do the work",
      kind,
      scope: kind === "write" ? ["src/**"] : [],
      acceptance: ["the supervisor accepts it"]
    }
  ]);
  checkpointPlan(root, id);
}

function structuredResult(overrides = {}) {
  return JSON.stringify({
    summary: "Implemented the change.",
    files_touched: ["src/a.js"],
    tests: [{ command: "node --test", outcome: "passed" }],
    decisions: [],
    assumptions: [],
    blockers: [],
    blocker_code: null,
    confidence: "high",
    ...overrides
  });
}

/** Claim, bind a thread, and report, without launching a process. */
function reportedAttempt(root, runId, { threadId = "thread-one", result = structuredResult() } = {}) {
  const claimed = claimTask(root, runId, "work", lane);
  bindAttempt(root, runId, "work", { attemptId: claimed.attemptId, threadId });
  recordTaskResult(root, runId, "work", { attemptId: claimed.attemptId, resultText: result });
  return claimed;
}

function logFile() {
  return path.join(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "orch-resume-log-")), "calls.jsonl");
}

function readLog(file) {
  return fs.existsSync(file)
    ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line))
    : [];
}

async function settle(root, runId) {
  let updates = [];
  for (let index = 0; index < 150; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 40));
    updates = pollRunWorkers(root, runId);
    const task = loadRun(root, runId).tasks.work;
    if (!["running", "dispatching", "pending"].includes(task.status)) {
      return { task, updates };
    }
  }
  throw new Error(`run ${runId} did not settle`);
}

test("a failed verification retries warm by default and briefs the worker on what was wrong", () => {
  const root = repo();
  plan(root, "run-warm");
  const first = reportedAttempt(root, "run-warm");
  verifyTask(root, "run-warm", "work", {
    verdict: "fail",
    evidence: ["src/a.js still returns null for an empty list"]
  });

  const retried = retryTask(root, "run-warm", "work", {
    note: "Handle the empty list before the loop."
  });
  assert.equal(retried.retryPlan.mode, "warm");
  assert.equal(retried.retryPlan.previousAttemptId, first.attemptId);
  assert.equal(retried.verification, null);

  // M2.1: the verdict survives on the attempt after the task-level fields clear.
  let run = loadRun(root, "run-warm");
  const review = run.tasks.work.attempts[0].review;
  assert.equal(review.verification.verdict, "fail");
  assert.deepEqual(review.verification.evidence, ["src/a.js still returns null for an empty list"]);
  assert.equal(review.result.structured.summary, "Implemented the change.");
  assert.match(
    renderSupervisorBriefing(root, run, lane),
    /next launch: warm, resuming the thread of work-attempt-1; retry note: Handle the empty list/
  );

  const second = claimTask(root, "run-warm", "work", lane);
  assert.equal(second.resumedFromAttemptId, first.attemptId);
  assert.equal(second.retry.resumeThreadId, "thread-one");
  assert.equal(second.retry.note, "Handle the empty list before the loop.");
  assert.match(second.briefing, /## Previous attempt/);
  assert.match(second.briefing, /continuing the Codex thread of work-attempt-1/);
  assert.match(second.briefing, /outcome: verification_failed \/ supervisor_verification_failed/);
  assert.match(second.briefing, /Supervisor evidence:\n- src\/a\.js still returns null for an empty list/);
  assert.match(second.briefing, /Supervisor correction for this retry:\nHandle the empty list before the loop\./);
  assert.match(second.briefing, /Files the previous attempt changed \(from your report\):\n- src\/a\.js/);
  // Ordinary briefing text, placed with the assignment, not inside guidance.
  assert.ok(second.briefing.indexOf("## Previous attempt") < second.briefing.indexOf("## Task kind"));
  assert.equal(loadRun(root, "run-warm").tasks.work.pendingRetry, undefined);

  run = loadRun(root, "run-warm");
  assert.match(renderSupervisorBriefing(root, run, lane), /work-attempt-2: pending — warm, resumed from work-attempt-1/);
  assert.equal(recoveryReport(run)[0].resumedFromAttemptId, "work-attempt-1");
});

test("--fresh, crashes, and missing thread ids retry cold but keep the evidence", () => {
  const root = repo();
  plan(root, "run-cold");
  reportedAttempt(root, "run-cold");
  verifyTask(root, "run-cold", "work", { verdict: "fail", evidence: ["wrong output"] });
  const forced = retryTask(root, "run-cold", "work", { fresh: true, note: "Start over." });
  assert.equal(forced.retryPlan.mode, "fresh");
  assert.match(forced.retryPlan.reason, /--fresh/);
  const second = claimTask(root, "run-cold", "work", lane);
  assert.equal(second.resumedFromAttemptId, null);
  assert.match(second.briefing, /starts a fresh Codex thread/);
  assert.match(second.briefing, /Supervisor evidence:\n- wrong output/);
  assert.match(second.briefing, /Start over\./);

  // A crash ends without a result: cold, even with a thread id.
  bindAttempt(root, "run-cold", "work", { attemptId: second.attemptId, threadId: "thread-two" });
  failTaskAttempt(root, "run-cold", "work", { attemptId: second.attemptId, error: "Codex exited 1." });
  const crashed = retryTask(root, "run-cold", "work");
  assert.equal(crashed.retryPlan.mode, "fresh");
  assert.match(crashed.retryPlan.reason, /execution_failed/);
  const third = claimTask(root, "run-cold", "work", lane);
  assert.match(third.briefing, /your summary \(unverified\): Codex exited 1\./);

  // A blocked result with no thread id: cold.
  recordTaskResult(root, "run-cold", "work", {
    attemptId: third.attemptId,
    resultText: structuredResult({ blockers: ["need src/b.js"], blocker_code: "scope_required" })
  });
  const noThread = retryTask(root, "run-cold", "work");
  assert.equal(noThread.retryPlan.mode, "fresh");
  assert.match(noThread.retryPlan.reason, /no thread id/);
  const fourth = claimTask(root, "run-cold", "work", lane);
  assert.match(fourth.briefing, /Blockers you reported:\n- need src\/b\.js/);
});

test("a warm retry after an integration conflict recreates the worktree; otherwise it is reused", () => {
  const root = repo();
  plan(root, "run-conflict", { kind: "write" });
  reportedAttempt(root, "run-conflict");
  recordIntegrationDiagnostic(root, "run-conflict", "work", {
    kind: "failed",
    reasonCode: "integration_conflict",
    signals: ["integration_conflict"],
    error: "CONFLICT (content): Merge conflict in src/a.js"
  });
  recordTaskDisposition(root, "run-conflict", "work", {
    terminalOutcome: "integration_failed",
    action: "replan",
    reasonCode: "integration_conflict",
    evidence: ["cherry-pick conflicted with the integrated head"]
  });
  assert.equal(retryTask(root, "run-conflict", "work").retryPlan.mode, "warm");
  const second = claimTask(root, "run-conflict", "work", lane);
  assert.equal(second.resumedFromAttemptId, "work-attempt-1");
  assert.deepEqual(second.retry.worktree, { mode: "new", reason: "integration_conflict" });
  assert.match(second.briefing, /set aside because its commits conflicted/);
  assert.match(second.briefing, /Integration findings \(integration_conflict\):\n- error: CONFLICT/);
  assert.match(second.briefing, /cherry-pick conflicted with the integrated head/);
});

test("the CLI exposes --note and --fresh on run retry", () => {
  const root = repo();
  plan(root, "run-cli-retry");
  reportedAttempt(root, "run-cli-retry");
  verifyTask(root, "run-cli-retry", "work", { verdict: "fail", evidence: ["missing test"] });
  const warm = runCli(root, ["run", "retry", "run-cli-retry", "work", "--note", "Add the test."]);
  assert.equal(warm.code, 0, warm.stderr);
  assert.match(warm.stdout, /warm: the next launch resumes the Codex thread of work-attempt-1; retry note: recorded/);
  // A task already pending retry cannot be retried again before it relaunches.
  const fresh = runCli(root, ["run", "retry", "run-cli-retry", "work", "--fresh"]);
  assert.equal(fresh.code, 1);
  assert.match(fresh.stderr, /cannot be retried from status "pending"/);
});

test("a warm retry resumes the thread with explicit model, effort, and sandbox in the same worktree", async () => {
  const root = repo();
  plan(root, "run-resume", { kind: "write" });
  const calls = logFile();
  const command = [process.execPath, resumeFixture, `--log=${calls}`, "--write"];
  const first = launchTaskWorker(root, "run-resume", "work", lane, { codexCommand: command });
  let { task } = await settle(root, "run-resume");
  assert.equal(task.status, "reported");
  const threadId = task.attempts[0].threadId;
  assert.match(threadId, /^thread-fresh-/);

  // A write task must pass integration, so the supervisor rejects it by disposition.
  recordTaskDisposition(root, "run-resume", "work", {
    terminalOutcome: "policy_refused",
    action: "refuse",
    reasonCode: "policy_boundary",
    evidence: ["notes must not mention fresh starts"]
  });
  retryTask(root, "run-resume", "work", { note: "Record that you resumed." });
  checkpointPlan(root, "run-resume");
  const second = launchTaskWorker(root, "run-resume", "work", lane, { codexCommand: command });
  assert.equal(second.worktree.path, first.worktree.path);
  assert.equal(second.worktree.reusedFromAttemptId, "work-attempt-1");
  const spec = JSON.parse(fs.readFileSync(second.runner.specFile, "utf8"));
  assert.equal(spec.resumeThreadId, threadId);
  assert.equal(spec.sandbox, "workspace-write");

  ({ task } = await settle(root, "run-resume"));
  assert.equal(task.status, "reported");
  assert.equal(task.result.structured.summary, `Resumed ${threadId}.`);
  const attempt = task.attempts[1];
  assert.equal(attempt.resumedFromAttemptId, "work-attempt-1");
  assert.equal(attempt.threadId, threadId);
  assert.equal(attempt.resumeFallback, undefined);

  const [, resumed] = readLog(calls);
  const argv = resumed.argv;
  const at = (flag) => argv.indexOf(flag);
  assert.ok(at("resume") > 0);
  assert.ok(at("-C") < at("resume") && argv[at("-C") + 1] === first.worktree.path);
  assert.ok(at("--sandbox") < at("resume") && argv[at("--sandbox") + 1] === "workspace-write");
  assert.ok(at("--model") > at("resume") && argv[at("--model") + 1] === "gpt-6.1-sol");
  assert.equal(configValue(argv, "model_reasoning_effort"), 'model_reasoning_effort="high"');
  assertLockedDown(argv);
  assert.deepEqual(argv.slice(-2), [threadId, "-"]);
  assert.match(resumed.prompt, /## Previous attempt/);
  assert.match(resumed.prompt, /notes must not mention fresh starts/);
  assert.match(resumed.prompt, /Record that you resumed\./);

  // Both attempts' commits are in the reused worktree and visible to inspection.
  const inspection = inspectTaskWorktree(task, attempt);
  assert.equal(inspection.commits.length, 2);
  assert.equal(attempt.worktree.baseHead, task.attempts[0].worktree.baseHead);
  assert.ok(attempt.worktree.reusedHead);
  // This attempt changed src/notes.txt again, so it must declare it itself.
  assert.deepEqual(inspection.carried, []);
  assert.deepEqual(inspection.undeclared, []);
  assert.equal(fs.readFileSync(path.join(first.worktree.path, "src", "notes.txt"), "utf8"), "fresh\nresumed\n");
});

test("a resumed read-only task is still launched read-only", async () => {
  const root = repo();
  plan(root, "run-readonly");
  const calls = logFile();
  const command = [process.execPath, resumeFixture, `--log=${calls}`];
  launchTaskWorker(root, "run-readonly", "work", lane, { codexCommand: command });
  await settle(root, "run-readonly");
  verifyTask(root, "run-readonly", "work", { verdict: "fail", evidence: ["too shallow"] });
  retryTask(root, "run-readonly", "work");
  launchTaskWorker(root, "run-readonly", "work", lane, { codexCommand: command });
  await settle(root, "run-readonly");
  const [fresh, resumed] = readLog(calls);
  assert.equal(fresh.argv.includes("resume"), false);
  assert.ok(resumed.argv.includes("resume"));
  // Each launch names its own profile, so no configured profile can contribute grants.
  assert.notEqual(assertReadOnlyLaunch(fresh), assertReadOnlyLaunch(resumed));
  // Each worker gets its own scratch directory, and neither outlives its worker.
  assert.notEqual(fresh.tmpdir, resumed.tmpdir);
  assert.equal(fs.existsSync(fresh.tmpdir), false);
  assert.equal(fs.existsSync(resumed.tmpdir), false);
});

test("a missing thread falls back to a fresh launch with a recorded event", async () => {
  const root = repo();
  plan(root, "run-missing");
  const calls = logFile();
  launchTaskWorker(root, "run-missing", "work", lane, {
    codexCommand: [process.execPath, resumeFixture, `--log=${calls}`]
  });
  let { task } = await settle(root, "run-missing");
  const threadId = task.attempts[0].threadId;
  verifyTask(root, "run-missing", "work", { verdict: "fail", evidence: ["incomplete"] });
  retryTask(root, "run-missing", "work");
  launchTaskWorker(root, "run-missing", "work", lane, {
    codexCommand: [process.execPath, resumeFixture, `--log=${calls}`, `--missing=${threadId}`]
  });
  let updates;
  ({ task, updates } = await settle(root, "run-missing"));
  assert.equal(task.status, "reported");
  assert.equal(task.result.structured.summary, "Started fresh.");
  const attempt = task.attempts[1];
  assert.equal(attempt.resumedFromAttemptId, "work-attempt-1");
  assert.equal(attempt.resumeFallback.reason, "thread_missing");
  assert.match(attempt.resumeFallback.message, /no rollout found for thread id/);
  assert.notEqual(attempt.threadId, threadId);
  assert.equal(updates[0].resumeFallback.reason, "thread_missing");

  const log = readLog(calls);
  assert.equal(log.length, 3);
  assert.ok(log[1].argv.includes("resume"));
  assert.equal(log[2].argv.includes("resume"), false);
  // The fresh fallback receives the same self-contained briefing.
  assert.equal(log[2].prompt, log[1].prompt);
  assertReadOnlyLaunch(log[2]);

  const events = fs.readFileSync(eventsFile(root, "run-missing"), "utf8")
    .split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const fallback = events.find((event) => event.type === "task.resume_fallback");
  assert.equal(fallback.attemptId, "work-attempt-2");
  assert.equal(fallback.resumeThreadId, threadId);
  assert.match(
    renderSupervisorBriefing(root, loadRun(root, "run-missing"), lane),
    /work-attempt-2: .* FELL BACK to a fresh thread \(thread_missing\)/
  );

  verifyTask(root, "run-missing", "work", { verdict: "pass", evidence: ["complete now"] });
  collectLearningExamples(root, { runIds: ["run-missing"] });
  const warmStarts = listLearningExamples(root, { runIds: ["run-missing"] })
    .map((example) => [example.source.attemptNumber, example.features.warmStart])
    .sort();
  assert.deepEqual(warmStarts, [[1, false], [2, false]]);
});

test("a warm retry rejected for an unavailable model relaunches warm on the fallback model", async () => {
  const root = repo();
  plan(root, "run-warm-substitute", { model: "astra" });
  launchTaskWorker(root, "run-warm-substitute", "work", lane, {
    codexCommand: [process.execPath, resumeFixture]
  });
  let { task } = await settle(root, "run-warm-substitute");
  const threadId = task.attempts[0].threadId;
  verifyTask(root, "run-warm-substitute", "work", { verdict: "fail", evidence: ["missed a case"] });
  retryTask(root, "run-warm-substitute", "work", { note: "Cover the missing case." });
  launchTaskWorker(root, "run-warm-substitute", "work", lane, {
    codexCommand: [process.execPath, unavailableFixture, "--unavailable=gpt-6-astra"]
  });
  ({ task } = await settle(root, "run-warm-substitute"));
  assert.equal(task.status, "reported");
  const [, rejected, relaunched] = task.attempts;
  assert.equal(rejected.model, "gpt-6-astra");
  assert.equal(rejected.resumedFromAttemptId, "work-attempt-1");
  assert.ok(rejected.modelUnavailable);
  assert.equal(relaunched.model, "gpt-6.1-sol");
  assert.equal(relaunched.requestedModel, "gpt-6-astra");
  assert.equal(relaunched.resumedFromAttemptId, "work-attempt-1");
  assert.equal(relaunched.retry.resumeThreadId, threadId);
  assert.equal(relaunched.retry.note, "Cover the missing case.");
  const spec = JSON.parse(fs.readFileSync(relaunched.runner.specFile, "utf8"));
  assert.equal(spec.resumeThreadId, threadId);
  assert.equal(spec.model, "gpt-6.1-sol");
  assert.equal(spec.reasoningEffort, "high");
  assert.match(fs.readFileSync(relaunched.runner.promptFile, "utf8"), /You are one gpt-6\.1-sol worker/);

  verifyTask(root, "run-warm-substitute", "work", { verdict: "pass", evidence: ["case covered"] });
  collectLearningExamples(root, { runIds: ["run-warm-substitute"] });
  const third = listLearningExamples(root, { runIds: ["run-warm-substitute"] })
    .find((example) => example.source.attemptNumber === 3);
  assert.equal(third.features.warmStart, true);
});

test("runs saved before warm retries existed still retry, warm when they can", () => {
  const root = repo();
  plan(root, "run-old-state");
  reportedAttempt(root, "run-old-state", { threadId: "thread-old" });
  verifyTask(root, "run-old-state", "work", { verdict: "fail", evidence: ["old evidence"] });
  const file = runFile(root, "run-old-state");
  const state = JSON.parse(fs.readFileSync(file, "utf8"));
  state.version = 5;
  for (const attempt of state.tasks.work.attempts) {
    delete attempt.retry;
    delete attempt.resumedFromAttemptId;
  }
  fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);

  const retried = retryTask(root, "run-old-state", "work");
  assert.equal(retried.retryPlan.mode, "warm");
  const second = claimTask(root, "run-old-state", "work", lane);
  assert.equal(second.retry.resumeThreadId, "thread-old");
  assert.match(second.briefing, /old evidence/);
  assert.equal(loadRun(root, "run-old-state").version, 6);
});

test("a warm retry in a reused worktree integrates without redeclaring its predecessor's files", () => {
  const root = makeRepo();
  repos.push(root);
  const head = () => git(root, ["rev-parse", "HEAD"]).trim();
  const commit = (file, text) => {
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, file), text, "utf8");
    git(root, ["add", file]);
    git(root, ["commit", "--quiet", "-m", text]);
  };
  const baseHead = head();
  // Attempt 1 changed a and b and declared both, plus c, which it never changed.
  commit("src/a.js", "a\n");
  commit("src/b.js", "b\n");
  const reusedHead = head();
  // The warm retry fixes b and also changes c, but reports only b.
  commit("src/b.js", "b fixed\n");
  commit("src/c.js", "c\n");
  const declared = (files) => ({ structured: { files_touched: files } });
  const first = {
    id: "work-attempt-1",
    worktree: { path: root, branch: "main", baseHead },
    review: { result: declared(["src/a.js", "src/b.js", "src/c.js"]) }
  };
  const second = {
    id: "work-attempt-2",
    worktree: { path: root, branch: "main", baseHead, reusedHead, reusedFromAttemptId: first.id },
    resumedFromAttemptId: first.id
  };
  const task = { id: "work", scope: ["src/**"], attempts: [first, second], result: declared(["src/b.js"]) };
  const inspection = inspectTaskWorktree(task, second);
  // a is carried (declared and changed before the reuse); c was only claimed
  // earlier and changed now, so this attempt had to declare it.
  assert.deepEqual(inspection.carried, ["src/a.js"]);
  assert.deepEqual(inspection.undeclared, ["src/c.js"]);
  assert.equal(inspection.ready, false);

  const honest = inspectTaskWorktree({ ...task, result: declared(["src/b.js", "src/c.js"]) }, second);
  assert.deepEqual(honest.undeclared, []);
  assert.equal(honest.ready, true);

  // A worktree saved without a reuse head carries nothing.
  const legacy = { ...second, worktree: { ...second.worktree, reusedHead: undefined } };
  assert.deepEqual(inspectTaskWorktree({ ...task, attempts: [first, legacy] }, legacy).undeclared, ["src/a.js", "src/c.js"]);
});

test("an older declaration does not cover a later attempt's undeclared change", () => {
  const root = makeRepo();
  repos.push(root);
  const head = () => git(root, ["rev-parse", "HEAD"]).trim();
  const commit = (file, text) => {
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, file), text, "utf8");
    git(root, ["add", file]);
    git(root, ["commit", "--quiet", "-m", text]);
  };
  const declared = (files) => ({ structured: { files_touched: files } });
  const baseHead = head();
  // Attempt 1 changes a and declares a and x (x is a phantom).
  commit("src/a.js", "a\n");
  const secondHead = head();
  // Attempt 2 changes x without declaring it, and fails inspection.
  commit("src/x.js", "x\n");
  // Attempt 3 changes a declared file y only.
  const thirdHead = head();
  commit("src/y.js", "y\n");
  const first = {
    id: "work-attempt-1",
    worktree: { path: root, branch: "main", baseHead },
    review: { result: declared(["src/a.js", "src/x.js"]) }
  };
  const second = {
    id: "work-attempt-2",
    worktree: { path: root, branch: "main", baseHead, reusedHead: secondHead, reusedFromAttemptId: first.id },
    review: { result: declared([]) }
  };
  const third = {
    id: "work-attempt-3",
    worktree: { path: root, branch: "main", baseHead, reusedHead: thirdHead, reusedFromAttemptId: second.id }
  };
  const task = { id: "work", scope: ["src/**"], attempts: [first, second, third], result: declared(["src/y.js"]) };
  const inspection = inspectTaskWorktree(task, third);
  // a is still attempt 1's declared change; x was last changed by attempt 2,
  // which did not declare it, so attempt 1's phantom claim does not carry it.
  assert.deepEqual(inspection.carried, ["src/a.js"]);
  assert.deepEqual(inspection.undeclared, ["src/x.js"]);
  assert.equal(inspection.ready, false);


  // The same holds when a later attempt changes a file an earlier one declared:
  // attempt 2 also rewrote a without declaring it, so a is no longer carried.
  const root2 = makeRepo();
  repos.push(root2);
  const head2 = () => git(root2, ["rev-parse", "HEAD"]).trim();
  const commit2 = (file, text) => {
    fs.mkdirSync(path.join(root2, "src"), { recursive: true });
    fs.writeFileSync(path.join(root2, file), text, "utf8");
    git(root2, ["add", file]);
    git(root2, ["commit", "--quiet", "-m", text]);
  };
  const base2 = head2();
  commit2("src/a.js", "a\n");
  const reuse2 = head2();
  commit2("src/a.js", "a rewritten\n");
  const reuse3 = head2();
  commit2("src/y.js", "y\n");
  const at = (extra) => ({ path: root2, branch: "main", baseHead: base2, ...extra });
  const rewritten = {
    id: "work",
    scope: ["src/**"],
    result: declared(["src/y.js"]),
    attempts: [
      { id: "work-attempt-1", worktree: at({}), review: { result: declared(["src/a.js"]) } },
      { id: "work-attempt-2", worktree: at({ reusedHead: reuse2 }), review: { result: declared([]) } },
      { id: "work-attempt-3", worktree: at({ reusedHead: reuse3 }) }
    ]
  };
  const latest = inspectTaskWorktree(rewritten, rewritten.attempts[2]);
  assert.deepEqual(latest.carried, []);
  assert.deepEqual(latest.undeclared, ["src/a.js"]);
});

test("a file changed and restored by commits still counts as changed", () => {
  const root = makeRepo();
  repos.push(root);
  const head = () => git(root, ["rev-parse", "HEAD"]).trim();
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text, "utf8");
    git(root, ["add", file]);
    git(root, ["commit", "--quiet", "-m", `${file}: ${text}`]);
  };
  const declared = (files) => ({ structured: { files_touched: files } });
  const baseHead = head();
  // Attempt 1 changes and declares a.
  write("src/a.js", "a\n");
  const reuse2 = head();
  // Attempt 2 changes a and restores it, declaring nothing.
  write("src/a.js", "tampered\n");
  write("src/a.js", "a\n");
  const reuse3 = head();
  // Attempt 3 changes nothing of its own.
  const at = (extra) => ({ path: root, branch: "main", baseHead, ...extra });
  const task = {
    id: "work",
    scope: ["src/**"],
    result: declared([]),
    attempts: [
      { id: "work-attempt-1", worktree: at({}), review: { result: declared(["src/a.js"]) } },
      { id: "work-attempt-2", worktree: at({ reusedHead: reuse2 }), review: { result: declared([]) } },
      { id: "work-attempt-3", worktree: at({ reusedHead: reuse3 }) }
    ]
  };
  const inspection = inspectTaskWorktree(task, task.attempts[2]);
  assert.deepEqual(inspection.carried, [], "attempt 2 changed a last, and did not declare it");
  assert.deepEqual(inspection.undeclared, ["src/a.js"]);
  assert.equal(inspection.ready, false);

  // A single attempt that changes an out-of-scope file and restores it is still
  // out of scope: integration would cherry-pick both commits.
  const solo = makeRepo();
  repos.push(solo);
  const soloBase = git(solo, ["rev-parse", "HEAD"]).trim();
  for (const [file, text] of [["src/b.js", "b\n"], ["docs/x.md", "x\n"]]) {
    fs.mkdirSync(path.dirname(path.join(solo, file)), { recursive: true });
    fs.writeFileSync(path.join(solo, file), text, "utf8");
    git(solo, ["add", file]);
    git(solo, ["commit", "--quiet", "-m", file]);
  }
  git(solo, ["rm", "--quiet", "docs/x.md"]);
  git(solo, ["commit", "--quiet", "-m", "restore"]);
  const one = {
    id: "work",
    scope: ["src/**"],
    result: declared(["src/b.js"]),
    attempts: [{ id: "work-attempt-1", worktree: { path: solo, branch: "main", baseHead: soloBase } }]
  };
  const single = inspectTaskWorktree(one, one.attempts[0]);
  assert.deepEqual(single.outOfScope, ["docs/x.md"]);
  assert.equal(single.ready, false);
});

test("a retry note reaches the worker when no earlier attempt reached one", () => {
  const root = repo();
  plan(root, "run-note-launch");
  const first = claimTask(root, "run-note-launch", "work", lane);
  failTaskAttempt(root, "run-note-launch", "work", {
    attemptId: first.attemptId,
    error: "spawn codex ENOENT",
    reasonCode: "worker_launch_failed",
    signals: ["worker_launch_error"],
    launchFailed: true
  });
  retryTask(root, "run-note-launch", "work", { note: "Use the v2 API." });
  const second = claimTask(root, "run-note-launch", "work", lane);
  assert.match(second.briefing, /## Supervisor correction for this attempt\n\nUse the v2 API\./);

  // The relaunch fails to launch too; a plain retry keeps the note.
  failTaskAttempt(root, "run-note-launch", "work", {
    attemptId: second.attemptId,
    error: "spawn codex ENOENT",
    reasonCode: "worker_launch_failed",
    signals: ["worker_launch_error"],
    launchFailed: true
  });
  retryTask(root, "run-note-launch", "work");
  const third = claimTask(root, "run-note-launch", "work", lane);
  assert.match(third.briefing, /Use the v2 API\./);
});

test("warm attempts that never launched do not count toward escalation advice", () => {
  const root = repo();
  plan(root, "run-escalate");
  reportedAttempt(root, "run-escalate");
  verifyTask(root, "run-escalate", "work", { verdict: "fail", evidence: ["wrong"] });
  for (let index = 0; index < 2; index += 1) {
    retryTask(root, "run-escalate", "work");
    const claimed = claimTask(root, "run-escalate", "work", lane);
    assert.ok(claimed.resumedFromAttemptId);
    failTaskAttempt(root, "run-escalate", "work", {
      attemptId: claimed.attemptId,
      error: "spawn codex ENOENT",
      reasonCode: "worker_launch_failed",
      signals: ["worker_launch_error"],
      launchFailed: true
    });
  }
  const retried = retryTask(root, "run-escalate", "work");
  assert.equal(retried.retryPlan.warmFailures, 0);
  assert.equal(retried.retryPlan.escalationAdvised, false);
});
