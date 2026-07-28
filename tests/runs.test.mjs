import assert from "node:assert/strict";
import fs from "node:fs";
import { after, test } from "node:test";

import {
  DEFAULT_WORKER_MODEL,
  addCheckpoint,
  bindAttempt,
  cancelRun,
  cancelTask,
  checkpointStatus,
  claimTask,
  createRun,
  eventsFile,
  finalizeRun,
  loadRun,
  readyTasks,
  recordTaskResult,
  recoveryReport,
  resolveTaskWorker,
  runFile,
  renderSupervisorBriefing,
  renderWorkerBriefing,
  replacePlan,
  retryTask,
  verifyTask
} from "../plugins/orchestrator/scripts/lib/runs.mjs";
import { checkpointPlan, cleanup, git, makeRepo, runCli, write } from "./helpers.mjs";

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
  assert.match(briefing, /You are the Claude model running the Claude Code main thread, and you are the supervisor/);
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
  checkpointPlan(root, "run-pool");
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
  checkpointPlan(root, "run-life");
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
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
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

test("runs and tasks route across the GPT-5.6 family with exact persisted audit data", () => {
  const root = repo();
  const run = createRun(root, {
    id: "run-tiered",
    lane: "api",
    objective: "Route work by complexity",
    maxWorkers: 3,
    workerModel: "terra",
    reasoningEffort: "medium"
  });
  assert.equal(run.workerPolicy.model, "gpt-5.6-terra");

  const planned = replacePlan(root, "run-tiered", [
    {
      id: "balanced",
      title: "Balanced task",
      objective: "Handle everyday implementation",
      scope: ["src/balanced/**"]
    },
    {
      id: "frontier",
      title: "Frontier task",
      objective: "Solve the difficult subsystem",
      scope: ["src/frontier/**"],
      model: "sol",
      effort: "high"
    },
    {
      id: "volume",
      title: "Volume task",
      objective: "Apply a clear repetitive transform",
      scope: ["src/volume/**"],
      model: "gpt-5.6-luna",
      effort: "low"
    }
  ]);
  assert.deepEqual(resolveTaskWorker(planned, planned.tasks.balanced), {
    model: "gpt-5.6-terra",
    reasoningEffort: "medium"
  });
  assert.equal(planned.tasks.frontier.model, "gpt-5.6-sol");
  assert.equal(planned.tasks.volume.model, "gpt-5.6-luna");

  checkpointPlan(root, "run-tiered");
  const balanced = claimTask(root, "run-tiered", "balanced", { constraints: [] });
  const frontier = claimTask(root, "run-tiered", "frontier", { constraints: [] });
  const volume = claimTask(root, "run-tiered", "volume", { constraints: [] });
  assert.deepEqual(
    [balanced, frontier, volume].map(({ model, reasoningEffort }) => [
      model,
      reasoningEffort
    ]),
    [
      ["gpt-5.6-terra", "medium"],
      ["gpt-5.6-sol", "high"],
      ["gpt-5.6-luna", "low"]
    ]
  );
  assert.match(volume.briefing, /You are one gpt-5\.6-luna worker/);
  assert.match(volume.briefing, /reasoning effort: low/);

  const persisted = loadRun(root, "run-tiered");
  assert.deepEqual(
    Object.values(persisted.tasks).map((task) => {
      const attempt = task.attempts.at(-1);
      return [attempt.model, attempt.reasoningEffort];
    }),
    [
      ["gpt-5.6-terra", "medium"],
      ["gpt-5.6-sol", "high"],
      ["gpt-5.6-luna", "low"]
    ]
  );
});

test("worker routing rejects unsupported models and invalid model-effort combinations", () => {
  const root = repo();
  assert.throws(
    () =>
      createRun(root, {
        id: "run-unknown-model",
        lane: "api",
        objective: "Reject unknown routing",
        workerModel: "gpt-5.6-mars"
      }),
    /Use one of: sol, terra, luna/
  );
  assert.throws(
    () =>
      createRun(root, {
        id: "run-luna-ultra",
        lane: "api",
        objective: "Reject invalid routing",
        workerModel: "luna",
        reasoningEffort: "ultra"
      }),
    /cannot use reasoning effort "ultra" with gpt-5\.6-luna/
  );

  createRun(root, {
    id: "run-inherited-ultra",
    lane: "api",
    objective: "Validate task overrides",
    workerModel: "sol",
    reasoningEffort: "ultra"
  });
  assert.throws(
    () =>
      replacePlan(root, "run-inherited-ultra", [
        {
          id: "too-much",
          title: "Invalid Luna route",
          objective: "Attempt unsupported effort",
          scope: ["src/**"],
          model: "luna"
        }
      ]),
    /Task "too-much" cannot use reasoning effort "ultra" with gpt-5\.6-luna/
  );
});

test("tasks from pre-routing state inherit the run default and can be replanned unchanged", () => {
  const root = repo();
  createRun(root, {
    id: "run-legacy",
    lane: "api",
    objective: "Resume old state",
    workerModel: "terra",
    reasoningEffort: "medium"
  });
  const definition = {
    id: "legacy",
    title: "Legacy task",
    objective: "Complete an old task",
    kind: "read"
  };
  replacePlan(root, "run-legacy", [definition]);

  const file = runFile(root, "run-legacy");
  const legacyState = JSON.parse(fs.readFileSync(file, "utf8"));
  legacyState.version = 2;
  delete legacyState.tasks.legacy.model;
  delete legacyState.tasks.legacy.reasoningEffort;
  fs.writeFileSync(file, `${JSON.stringify(legacyState, null, 2)}\n`);

  checkpointPlan(root, "run-legacy");
  const dispatch = claimTask(root, "run-legacy", "legacy", { constraints: [] });
  assert.equal(dispatch.model, "gpt-5.6-terra");
  assert.equal(dispatch.reasoningEffort, "medium");
  recordTaskResult(root, "run-legacy", "legacy", {
    attemptId: dispatch.attemptId,
    resultText: resultBlock({ files: "none" })
  });
  verifyTask(root, "run-legacy", "legacy", {
    verdict: "pass",
    evidence: ["legacy task reviewed"]
  });

  const replanned = replacePlan(root, "run-legacy", [definition]);
  assert.equal(replanned.tasks.legacy.status, "completed");
});

test("blocked and failed tasks retain attempts and can be retried", () => {
  const root = repo();
  createRun(root, { id: "run-retry", lane: "api", objective: "Recover" });
  replacePlan(root, "run-retry", [
    { id: "work", title: "Work", objective: "Do work", scope: ["src/**"] }
  ]);
  checkpointPlan(root, "run-retry");
  const first = claimTask(root, "run-retry", "work", { constraints: [] });
  const blocked = recordTaskResult(root, "run-retry", "work", {
    attemptId: first.attemptId,
    resultText: resultBlock({ blockers: "needs schema scope" })
  });
  assert.equal(blocked.task.status, "blocked");
  assert.equal(blocked.runStatus, "blocked");

  retryTask(root, "run-retry", "work");
  checkpointPlan(root, "run-retry");
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
  checkpointPlan(root, "run-control");
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
  checkpointPlan(root, "run-replan");
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
  checkpointPlan(root, "run-final");
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

  checkpointPlan(root, "run-final-guard");
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

test("dispatch is gated on a checkpoint that covers the current plan revision", () => {
  const root = repo();
  createRun(root, { id: "run-gate", lane: "api", objective: "Ship safely" });
  replacePlan(root, "run-gate", [
    { id: "build", title: "Build", objective: "Build it", scope: ["src/**"] }
  ]);

  const beforeCheckpoint = checkpointStatus(loadRun(root, "run-gate"));
  assert.equal(beforeCheckpoint.current, false);
  assert.match(beforeCheckpoint.reason, /no checkpoint has been recorded/);
  assert.throws(
    () => claimTask(root, "run-gate", "build", { constraints: [] }),
    /cannot dispatch work because no checkpoint has been recorded/
  );

  addCheckpoint(root, "run-gate", { summary: "Plan approved" });
  const afterCheckpoint = checkpointStatus(loadRun(root, "run-gate"));
  assert.equal(afterCheckpoint.current, true);
  assert.equal(afterCheckpoint.stale, false);
  assert.equal(claimTask(root, "run-gate", "build", { constraints: [] }).taskId, "build");
  cancelTask(root, "run-gate", "build", "superseded");

  // Replanning invalidates the recorded reasoning, so dispatch closes again.
  replacePlan(root, "run-gate", [
    { id: "rework", title: "Rework", objective: "Rework it", scope: ["src/**"] }
  ]);
  const afterReplan = checkpointStatus(loadRun(root, "run-gate"));
  assert.equal(afterReplan.current, false);
  assert.match(afterReplan.reason, /plan revision 1, but the run is on revision 2/);
  assert.throws(
    () => claimTask(root, "run-gate", "rework", { constraints: [] }),
    /orch run checkpoint run-gate --summary/
  );
});

test("a checkpoint goes stale once tasks complete beneath it", () => {
  const root = repo();
  createRun(root, { id: "run-stale", lane: "api", objective: "Ship safely" });
  replacePlan(root, "run-stale", [
    { id: "review", title: "Review", objective: "Review it", kind: "verify" },
    { id: "audit", title: "Audit", objective: "Audit it", kind: "read" }
  ]);
  addCheckpoint(root, "run-stale", { summary: "Plan approved" });

  const dispatch = claimTask(root, "run-stale", "review", { constraints: [] });
  recordTaskResult(root, "run-stale", "review", {
    attemptId: dispatch.attemptId,
    resultText: resultBlock()
  });
  verifyTask(root, "run-stale", "review", { verdict: "pass", evidence: ["checked"] });

  const stale = checkpointStatus(loadRun(root, "run-stale"));
  assert.equal(stale.current, true);
  assert.equal(stale.stale, true);
  assert.equal(stale.completedSinceCheckpoint, 1);
  assert.match(stale.reason, /1 task\(s\) completed since the latest checkpoint/);
  assert.match(
    renderSupervisorBriefing(root, loadRun(root, "run-stale"), { name: "api", constraints: [] }),
    /This checkpoint is stale/
  );

  // Staleness is a prompt, not a block: the next wave still dispatches.
  assert.equal(claimTask(root, "run-stale", "audit", { constraints: [] }).taskId, "audit");

  addCheckpoint(root, "run-stale", { summary: "Wave one verified" });
  assert.equal(checkpointStatus(loadRun(root, "run-stale")).stale, false);
});

test("a worker inherits its dependencies' decisions, not just their summaries", () => {
  const root = repo();
  createRun(root, { id: "run-context", lane: "api", objective: "Ship pagination" });
  replacePlan(root, "run-context", [
    { id: "design", title: "Design", objective: "Choose the cursor format", kind: "read" },
    {
      id: "build",
      title: "Build",
      objective: "Implement the cursor",
      scope: ["src/**"],
      dependsOn: ["design"]
    }
  ]);
  addCheckpoint(root, "run-context", { summary: "Plan approved" });

  const dispatch = claimTask(root, "run-context", "design", { constraints: [] });
  recordTaskResult(root, "run-context", "design", {
    attemptId: dispatch.attemptId,
    resultText: JSON.stringify({
      summary: "Chose an opaque base64 cursor",
      files_touched: ["docs/cursors.md"],
      tests: [],
      decisions: ["Cursors are opaque base64, never a raw offset"],
      assumptions: ["Page size stays at 50"],
      blockers: [],
      confidence: "high"
    })
  });
  verifyTask(root, "run-context", "design", {
    verdict: "pass",
    evidence: ["Read docs/cursors.md and confirmed the format"]
  });

  const briefing = renderWorkerBriefing(
    root,
    loadRun(root, "run-context"),
    loadRun(root, "run-context").tasks.build,
    { name: "api", constraints: [] }
  );
  assert.match(briefing, /### design/);
  assert.match(briefing, /Chose an opaque base64 cursor/);
  assert.match(briefing, /Decisions you must not contradict:\n- Cursors are opaque base64/);
  assert.match(briefing, /Assumptions it made:\n- Page size stays at 50/);
  assert.match(briefing, /Files it changed:\n- docs\/cursors\.md/);
  assert.match(briefing, /Supervisor-verified evidence:\n- Read docs\/cursors\.md/);
});
