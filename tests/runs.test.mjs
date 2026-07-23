import assert from "node:assert/strict";
import fs from "node:fs";
import { after, test } from "node:test";

import {
  DEFAULT_WORKER_MODEL,
  addCheckpoint,
  bindAttempt,
  cancelRun,
  cancelTask,
  claimTask,
  createRun,
  eventsFile,
  finalizeRun,
  loadRun,
  readyTasks,
  recordTaskResult,
  recoveryReport,
  renderSupervisorBriefing,
  replacePlan,
  retryTask,
  verifyTask
} from "../plugins/orchestrator/scripts/lib/runs.mjs";
import { cleanup, git, makeRepo, runCli, write } from "./helpers.mjs";

const repos = [];

function repo() {
  const root = makeRepo();
  repos.push(root);
  runCli(root, ["init"]);
  return root;
}

after(() => {
  for (const root of repos) {
    cleanup(root);
  }
});

test("new runs pin GPT-5.6 Sol and start in planning", () => {
  const root = repo();
  const run = createRun(root, {
    id: "run-one",
    lane: "api",
    objective: "Ship pagination"
  });
  assert.equal(run.status, "planning");
  assert.equal(run.workerPolicy.model, DEFAULT_WORKER_MODEL);
  assert.equal(run.workerPolicy.model, "gpt-5.6-sol");
  assert.equal(run.workerPolicy.maxWorkers, 3);
  assert.deepEqual(run.tasks, {});
});

test("plans validate dependencies and expose only unblocked tasks", () => {
  const root = repo();
  createRun(root, { id: "run-dag", lane: "api", objective: "Build the feature" });
  const run = replacePlan(
    root,
    "run-dag",
    [
      {
        id: "implement",
        title: "Implement",
        objective: "Write the module",
        scope: ["src/**"],
        acceptance: ["unit tests pass"]
      },
      {
        id: "verify",
        title: "Verify",
        objective: "Review and test the module",
        kind: "verify",
        dependsOn: ["implement"],
        acceptance: ["report evidence"]
      }
    ],
    { defaultScope: ["src/**"] }
  );
  assert.equal(run.status, "ready");
  assert.equal(run.planRevision, 1);
  assert.deepEqual(readyTasks(run).map((task) => task.id), ["implement"]);
});

test("plans reject missing dependencies and cycles", () => {
  const root = repo();
  createRun(root, { id: "run-invalid", lane: "api", objective: "Build it" });
  assert.throws(
    () =>
      replacePlan(root, "run-invalid", [
        {
          id: "a",
          title: "A",
          objective: "A",
          scope: ["src/**"],
          dependsOn: ["missing"]
        }
      ]),
    /depends on unknown task/
  );
  assert.throws(
    () =>
      replacePlan(root, "run-invalid", [
        {
          id: "a",
          title: "A",
          objective: "A",
          scope: ["src/**"],
          dependsOn: ["b"]
        },
        {
          id: "b",
          title: "B",
          objective: "B",
          scope: ["src/**"],
          dependsOn: ["a"]
        }
      ]),
    /dependency cycle/
  );
});

test("checkpoints and events preserve supervisory state", () => {
  const root = repo();
  createRun(root, { id: "run-memory", lane: "api", objective: "Remember the work" });
  const checkpoint = addCheckpoint(root, "run-memory", {
    summary: "The plan is approved.",
    decisions: ["Use cursor pagination"],
    risks: ["Index migration"],
    next: ["Dispatch implementation"]
  });
  assert.equal(checkpoint.decisions[0], "Use cursor pagination");
  assert.equal(loadRun(root, "run-memory").checkpoints.length, 1);

  const events = fs
    .readFileSync(eventsFile(root, "run-memory"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(events.map((event) => event.type), [
    "run.created",
    "run.checkpoint_added"
  ]);
});

test("the supervisor briefing reconstructs authority, graph, checkpoint, and ledger", () => {
  const root = repo();
  runCli(root, ["ledger", "add", "decisions", "Public IDs remain opaque."]);
  createRun(root, { id: "run-brief", lane: "api", objective: "Add pagination" });
  const run = replacePlan(root, "run-brief", [
    {
      id: "implementation",
      title: "Implement pagination",
      objective: "Add cursor pagination",
      scope: ["src/api/**"],
      acceptance: ["tests pass"]
    }
  ]);
  addCheckpoint(root, "run-brief", {
    summary: "Planning complete.",
    next: ["Dispatch implementation"]
  });
  const briefing = renderSupervisorBriefing(root, loadRun(root, run.id), {
    constraints: ["No new dependencies"],
    done: "All tests pass."
  });
  assert.match(briefing, /You are the Claude supervisor/);
  assert.match(briefing, /gpt-5\.6-sol/);
  assert.match(briefing, /implementation — Implement pagination/);
  assert.match(briefing, /Planning complete/);
  assert.match(briefing, /Public IDs remain opaque/);
});

function resultBlock({ files = "src/a.js", blockers = "none", confidence = "high" } = {}) {
  return `Implemented the assignment and ran the targeted tests.

## RESULT
files_touched: ${files}
decisions: none
assumptions: none
blockers: ${blockers}
confidence: ${confidence}`;
}

test("task claims enforce pool capacity and route explicitly to GPT-5.6 Sol", () => {
  const root = repo();
  createRun(root, {
    id: "run-pool",
    lane: "api",
    objective: "Build in parallel",
    maxWorkers: 1,
    reasoningEffort: "xhigh"
  });
  replacePlan(root, "run-pool", [
    { id: "a", title: "A", objective: "Implement A", scope: ["src/a/**"] },
    { id: "b", title: "B", objective: "Implement B", scope: ["src/b/**"] }
  ]);
  const dispatch = claimTask(root, "run-pool", "a", { constraints: [] });
  assert.equal(dispatch.model, "gpt-5.6-sol");
  assert.equal(dispatch.reasoningEffort, "xhigh");
  assert.deepEqual(dispatch.routingFlags, [
    "--fresh",
    "--model",
    "gpt-5.6-sol",
    "--effort",
    "xhigh"
  ]);
  assert.match(dispatch.briefing, /Do not redefine the overall goal/);
  assert.match(dispatch.briefing, /do not.*spawn subagents/i);
  assert.throws(
    () => claimTask(root, "run-pool", "b", { constraints: [] }),
    /concurrency limit/
  );
});

test("worker binding, reporting, supervisor verification, and dependencies form a gated lifecycle", () => {
  const root = repo();
  createRun(root, { id: "run-life", lane: "api", objective: "Ship safely" });
  replacePlan(root, "run-life", [
    { id: "build", title: "Build", objective: "Build it", scope: ["src/**"] },
    {
      id: "review",
      title: "Review",
      objective: "Review it",
      kind: "verify",
      dependsOn: ["build"]
    }
  ]);
  const dispatch = claimTask(root, "run-life", "build", { constraints: [] });
  const bound = bindAttempt(root, "run-life", "build", {
    attemptId: dispatch.attemptId,
    agentId: "agent-1",
    jobId: "job-1",
    threadId: "thread-1"
  });
  assert.equal(bound.status, "running");
  assert.deepEqual(recoveryReport(loadRun(root, "run-life")), [
    {
      taskId: "build",
      taskStatus: "running",
      attemptId: dispatch.attemptId,
      attemptStatus: "running",
      agentId: "agent-1",
      jobId: "job-1",
      threadId: "thread-1",
      runnerPid: null,
      runnerStatusFile: null,
      worktreePath: null,
      claimedAt: bound.claimedAt,
      startedAt: bound.startedAt
    }
  ]);

  const reported = recordTaskResult(root, "run-life", "build", {
    attemptId: dispatch.attemptId,
    resultText: resultBlock()
  });
  assert.equal(reported.task.status, "reported");
  assert.equal(reported.runStatus, "verifying");
  assert.deepEqual(readyTasks(loadRun(root, "run-life")), []);

  const verified = verifyTask(root, "run-life", "build", {
    verdict: "pass",
    evidence: ["node --test passed"]
  });
  assert.equal(verified.task.status, "completed");
  assert.equal(verified.runStatus, "ready");
  assert.deepEqual(verified.ready.map((task) => task.id), ["review"]);
});

test("blocked and failed tasks retain attempts and can be retried", () => {
  const root = repo();
  createRun(root, { id: "run-retry", lane: "api", objective: "Recover" });
  replacePlan(root, "run-retry", [
    { id: "work", title: "Work", objective: "Do work", scope: ["src/**"] }
  ]);
  const first = claimTask(root, "run-retry", "work", { constraints: [] });
  const blocked = recordTaskResult(root, "run-retry", "work", {
    attemptId: first.attemptId,
    resultText: resultBlock({ blockers: "needs schema scope" })
  });
  assert.equal(blocked.task.status, "blocked");
  assert.equal(blocked.runStatus, "blocked");

  retryTask(root, "run-retry", "work");
  const second = claimTask(root, "run-retry", "work", { constraints: [] });
  assert.equal(second.attemptId, "work-attempt-2");
  const failed = recordTaskResult(root, "run-retry", "work", {
    attemptId: second.attemptId,
    resultText: "No result contract"
  });
  assert.equal(failed.task.status, "failed");
  assert.deepEqual(failed.task.result.missingFields, [
    "files_touched",
    "decisions",
    "assumptions",
    "blockers",
    "confidence"
  ]);
});

test("supervisor verification can fail a report and cancellation is durable", () => {
  const root = repo();
  createRun(root, { id: "run-control", lane: "api", objective: "Control workers" });
  replacePlan(root, "run-control", [
    { id: "a", title: "A", objective: "A", scope: ["src/a/**"] },
    { id: "b", title: "B", objective: "B", scope: ["src/b/**"] }
  ]);
  const dispatch = claimTask(root, "run-control", "a", { constraints: [] });
  recordTaskResult(root, "run-control", "a", {
    attemptId: dispatch.attemptId,
    resultText: resultBlock()
  });
  const rejected = verifyTask(root, "run-control", "a", {
    verdict: "fail",
    evidence: ["tests failed"]
  });
  assert.equal(rejected.task.status, "failed");
  const cancelledTask = cancelTask(root, "run-control", "b", "superseded");
  assert.equal(cancelledTask.status, "cancelled");

  retryTask(root, "run-control", "a");
  const run = cancelRun(root, "run-control", "user stopped the run");
  assert.equal(run.status, "cancelled");
  assert.equal(run.tasks.a.status, "cancelled");
  assert.equal(run.cancelReason, "user stopped the run");
});

test("replanning preserves verified work while replacing unfinished tasks", () => {
  const root = repo();
  createRun(root, { id: "run-replan", lane: "api", objective: "Adapt the plan" });
  const completedDefinition = {
    id: "discovery",
    title: "Discovery",
    objective: "Map the code",
    kind: "read",
    acceptance: ["return file references"]
  };
  replacePlan(root, "run-replan", [
    completedDefinition,
    { id: "old-fix", title: "Old fix", objective: "Try old fix", scope: ["src/**"], dependsOn: ["discovery"] }
  ]);
  const dispatch = claimTask(root, "run-replan", "discovery", { constraints: [] });
  recordTaskResult(root, "run-replan", "discovery", {
    attemptId: dispatch.attemptId,
    resultText: resultBlock({ files: "none" })
  });
  verifyTask(root, "run-replan", "discovery", {
    verdict: "pass",
    evidence: ["mapped files"]
  });

  const revised = replacePlan(root, "run-replan", [
    completedDefinition,
    {
      id: "new-fix",
      title: "New fix",
      objective: "Apply the corrected approach",
      scope: ["src/**"],
      dependsOn: ["discovery"]
    }
  ]);
  assert.equal(revised.planRevision, 2);
  assert.equal(revised.tasks.discovery.status, "completed");
  assert.equal(revised.tasks["old-fix"], undefined);
  assert.deepEqual(readyTasks(revised).map((task) => task.id), ["new-fix"]);
  assert.throws(
    () =>
      replacePlan(root, "run-replan", [
        { ...completedDefinition, objective: "Rewrite history" }
      ]),
    /cannot be redefined/
  );
});

test("a completed task graph still requires a clean combined final verification gate", () => {
  const root = repo();
  createRun(root, { id: "run-final", lane: "api", objective: "Prove the result" });
  replacePlan(root, "run-final", [
    {
      id: "review",
      title: "Review",
      objective: "Inspect the repository",
      kind: "read",
      acceptance: ["return evidence"]
    }
  ]);
  const dispatch = claimTask(root, "run-final", "review", { constraints: [] });
  recordTaskResult(root, "run-final", "review", {
    attemptId: dispatch.attemptId,
    resultText: resultBlock({ files: "none" })
  });
  const verified = verifyTask(root, "run-final", "review", {
    verdict: "pass",
    evidence: ["review evidence recorded"]
  });
  assert.equal(verified.runStatus, "finalizing");

  const finalized = finalizeRun(root, "run-final", {
    verdict: "pass",
    summary: "The integrated repository passes.",
    evidence: ["node --test: passed"]
  });
  assert.equal(finalized.status, "completed");
  assert.equal(finalized.finalization.planRevision, 1);
  const briefing = renderSupervisorBriefing(root, finalized, {
    constraints: [],
    done: "All tests pass."
  });
  assert.match(briefing, /The integrated repository passes/);
  assert.match(briefing, /review evidence recorded/);
  assert.match(briefing, /node --test: passed/);
});

test("final verification refuses incomplete, dirty, and externally advanced runs", () => {
  const root = repo();
  createRun(root, { id: "run-final-guard", lane: "api", objective: "Guard completion" });
  replacePlan(root, "run-final-guard", [
    {
      id: "review",
      title: "Review",
      objective: "Inspect",
      kind: "read"
    }
  ]);
  assert.throws(
    () => finalizeRun(root, "run-final-guard", {
      verdict: "pass",
      summary: "Too early.",
      evidence: ["premature check passed"]
    }),
    /until every task is completed/
  );

  const dispatch = claimTask(root, "run-final-guard", "review", { constraints: [] });
  recordTaskResult(root, "run-final-guard", "review", {
    attemptId: dispatch.attemptId,
    resultText: resultBlock({ files: "none" })
  });
  verifyTask(root, "run-final-guard", "review", {
    verdict: "pass",
    evidence: ["reviewed"]
  });
  assert.throws(
    () => finalizeRun(root, "run-final-guard", {
      verdict: "pass",
      summary: "No real evidence.",
      evidence: ["none"]
    }),
    /at least one evidence item/
  );
  write(root, "uncommitted.txt", "dirty\n");
  assert.throws(
    () => finalizeRun(root, "run-final-guard", {
      verdict: "pass",
      summary: "Dirty.",
      evidence: ["test passed"]
    }),
    /must be clean/
  );
  git(root, ["add", "uncommitted.txt"]);
  git(root, ["commit", "--quiet", "-m", "Advance outside run"]);
  assert.throws(
    () => finalizeRun(root, "run-final-guard", {
      verdict: "pass",
      summary: "Drifted.",
      evidence: ["test passed"]
    }),
    /advanced outside run/
  );
});
