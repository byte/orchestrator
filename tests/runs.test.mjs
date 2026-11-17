import assert from "node:assert/strict";
import fs from "node:fs";
import { after, test } from "node:test";

import {
  createProvisionalGuidancePolicy,
  selectGuidance
} from "../plugins/orchestrator/scripts/lib/guidance.mjs";
import {
  DEFAULT_WORKER_MODEL,
  addCheckpoint,
  attachExecution,
  bindAttempt,
  cancelRun,
  cancelTask,
  checkpointStatus,
  claimTask,
  configureRunGuidance,
  createRun as createRunState,
  eventsFile,
  failTaskAttempt,
  finalizeRun,
  loadRun,
  readyTasks,
  recordIntegrationDiagnostic,
  recordTaskDisposition,
  recordTaskResult,
  recoveryReport,
  resolveTaskWorker,
  runFile,
  renderSupervisorBriefing,
  renderWorkerBriefing,
  replacePlan,
  retryTask,
  takeWorktreesForRemoval,
  verifyTask
} from "../plugins/orchestrator/scripts/lib/runs.mjs";
import { checkpointPlan, cleanup, git, makeRepo, runCli, write } from "./helpers.mjs";

const repos = [];

function createRun(cwd, options) {
  return createRunState(cwd, {
    workerModel: "sol",
    reasoningEffort: "high",
    ...options
  });
}

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

test("new runs default to enforced supervisor routing and start in planning", () => {
  const root = repo();
  const run = createRunState(root, {
    id: "run-one",
    lane: "api",
    objective: "Ship pagination"
  });
  assert.equal(run.status, "planning");
  assert.equal(run.workerPolicy.model, DEFAULT_WORKER_MODEL);
  assert.equal(run.workerPolicy.model, null);
  assert.equal(run.workerPolicy.reasoningEffort, null);
  assert.equal(run.workerPolicy.routingMode, "auto");
  assert.equal(run.workerPolicy.maxWorkers, 5);
  assert.equal(run.version, 6);
  assert.equal(run.guidance.mode, "disabled");
  assert.equal(run.guidance.revision, 0);
  assert.deepEqual(run.guidance.policies, []);
  assert.deepEqual(run.tasks, {});
});

test("provisional guidance is checkpointed, replayable, advisory, and reversible", () => {
  const root = repo();
  const laneRef = `lane-${"a".repeat(32)}`;
  const policy = createProvisionalGuidancePolicy({
    policyVersion: "provisional-test-v1",
    sources: [{
      sourceType: "curated_label",
      sourceId: `label-${"b".repeat(32)}`,
      provenance: "supervisor",
      lane: laneRef,
      taskKind: "read",
      terminalOutcome: "worker_blocked",
      action: "clarify",
      reasonCode: "missing_context",
      signals: ["worker_blocker_reported"]
    }]
  });
  createRun(root, { id: "run-guidance", lane: "api", objective: "Retry safely" });
  replacePlan(root, "run-guidance", [
    {
      id: "work",
      title: "Inspect",
      objective: "Inspect the bounded input",
      kind: "read",
      constraints: ["Keep the original constraint"],
      acceptance: ["Report evidence"]
    }
  ]);
  checkpointPlan(root, "run-guidance");

  const enabled = configureRunGuidance(root, "run-guidance", {
    mode: "provisional",
    laneRef,
    policy
  });
  assert.equal(enabled.guidance.policy.policyHash, policy.policyHash);
  assert.equal(enabled.tasks.work.guidanceSelection.items.length, 0);
  assert.equal(checkpointStatus(enabled).current, false);
  assert.match(checkpointStatus(enabled).reason, /guidance revision/);
  checkpointPlan(root, "run-guidance");

  const first = claimTask(root, "run-guidance", "work", {
    constraints: ["Lane rule remains authoritative"]
  });
  assert.doesNotMatch(first.briefing, /## Provisional guidance/);
  recordTaskResult(root, "run-guidance", "work", {
    attemptId: first.attemptId,
    resultText: JSON.stringify({
      summary: "A required input was not provided.",
      files_touched: [],
      tests: [],
      decisions: [],
      assumptions: [],
      blockers: ["missing input"],
      blocker_code: "missing_context",
      confidence: "high"
    })
  });
  const retried = retryTask(root, "run-guidance", "work");
  assert.equal(retried.guidanceSelection.items.length, 1);
  assert.equal(retried.guidanceSelection.policyHash, policy.policyHash);
  assert.equal(retried.guidanceSelection.items[0].action, "clarify");
  const pending = loadRun(root, "run-guidance");
  assert.equal(checkpointStatus(pending).current, false);
  const pendingBriefing = renderSupervisorBriefing(root, pending, {
    constraints: ["Lane rule remains authoritative"]
  });
  assert.match(pendingBriefing, new RegExp(retried.guidanceSelection.items[0].guidanceId));
  assert.throws(
    () => claimTask(root, "run-guidance", "work", { constraints: [] }),
    /guidance revision/
  );
  checkpointPlan(root, "run-guidance");

  const second = claimTask(root, "run-guidance", "work", {
    constraints: ["Lane rule remains authoritative"]
  });
  assert.deepEqual(second.routingFlags, first.routingFlags);
  assert.match(second.briefing, /## Provisional guidance/);
  assert.match(second.briefing, /cannot override scope, route, constraints, policy, or authority/);
  assert.match(second.briefing, /Lane rule remains authoritative/);
  assert.throws(
    () => configureRunGuidance(root, "run-guidance", { mode: "off" }),
    /active or awaiting verification/
  );
  const claimed = loadRun(root, "run-guidance");
  assert.deepEqual(
    claimed.tasks.work.attempts[1].guidanceSnapshot,
    claimed.tasks.work.guidanceSelection
  );
  const resumed = renderSupervisorBriefing(root, claimed, {
    constraints: ["Lane rule remains authoritative"]
  });
  assert.match(resumed, new RegExp(policy.policyHash));
  assert.match(resumed, new RegExp(claimed.tasks.work.guidanceSelection.items[0].guidanceId));

  recordTaskResult(root, "run-guidance", "work", {
    attemptId: second.attemptId,
    resultText: JSON.stringify({
      summary: "The input is still unavailable.",
      files_touched: [],
      tests: [],
      decisions: [],
      assumptions: [],
      blockers: ["missing input"],
      blocker_code: "missing_context",
      confidence: "high"
    })
  });
  const disabled = configureRunGuidance(root, "run-guidance", { mode: "off" });
  assert.equal(disabled.guidance.mode, "disabled");
  const restored = configureRunGuidance(root, "run-guidance", { rollback: true });
  assert.equal(restored.guidance.mode, "provisional");
  assert.deepEqual(restored.guidance.policy, policy);
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
  assert.match(briefing, /gpt-6\.1-sol/);
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

test("task claims enforce pool capacity and route explicitly to Sol", () => {
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
  assert.equal(dispatch.model, "gpt-6.1-sol");
  assert.equal(dispatch.reasoningEffort, "xhigh");
  assert.equal(dispatch.substitution, null);
  assert.deepEqual(dispatch.routingFlags, [
    "--fresh",
    "--model",
    "gpt-6.1-sol",
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
      model: "gpt-6.1-sol",
      reasoningEffort: "high",
      requestedModel: "gpt-6.1-sol",
      substitution: null,
      resumedFromAttemptId: null,
      resumeFallback: null,
      routingReason: null,
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
  assert.equal(
    verified.task.attempts.at(-1).outcome.terminalOutcome,
    "accepted"
  );
  assert.equal(verified.task.attempts.at(-1).outcome.provenance, "supervisor");
  assert.equal(verified.runStatus, "ready");
  assert.deepEqual(verified.ready.map((task) => task.id), ["review"]);
});

test("runs and tasks route across the roster with exact persisted audit data", () => {
  const root = repo();
  const run = createRunState(root, {
    id: "run-tiered",
    lane: "api",
    objective: "Route work by complexity",
    maxWorkers: 4
  });
  assert.equal(run.workerPolicy.routingMode, "auto");

  const planned = replacePlan(root, "run-tiered", [
    {
      id: "balanced",
      title: "Balanced task",
      objective: "Handle everyday implementation",
      scope: ["src/balanced/**"],
      model: "terra",
      effort: "medium",
      routingReason: "Balanced everyday implementation fits Terra."
    },
    {
      id: "frontier",
      title: "Frontier task",
      objective: "Solve the difficult subsystem",
      scope: ["src/frontier/**"],
      model: "sol",
      effort: "high",
      routingReason: "Open-ended subsystem work needs frontier capability."
    },
    {
      id: "volume",
      title: "Volume task",
      objective: "Apply a clear repetitive transform",
      scope: ["src/volume/**"],
      model: "gpt-5.6-luna",
      effort: "low",
      routingReason: "The bounded repetitive transform favors efficient throughput."
    },
    {
      id: "hardest",
      title: "Hardest task",
      objective: "Design the concurrency model",
      scope: ["src/hardest/**"],
      model: "astra",
      effort: "ultra",
      routingReason: "A wrong design here is expensive and hard to catch in review."
    }
  ]);
  assert.deepEqual(resolveTaskWorker(planned, planned.tasks.balanced), {
    model: "gpt-6.1-terra",
    reasoningEffort: "medium"
  });
  assert.equal(planned.tasks.frontier.model, "gpt-6.1-sol");
  assert.equal(planned.tasks.volume.model, "gpt-5.6-luna");
  assert.equal(planned.tasks.hardest.model, "gpt-6-astra");
  assert.equal(planned.tasks.hardest.reasoningEffort, "ultra");
  assert.match(planned.tasks.volume.routingReason, /efficient throughput/);

  checkpointPlan(root, "run-tiered");
  const balanced = claimTask(root, "run-tiered", "balanced", { constraints: [] });
  const frontier = claimTask(root, "run-tiered", "frontier", { constraints: [] });
  const volume = claimTask(root, "run-tiered", "volume", { constraints: [] });
  const hardest = claimTask(root, "run-tiered", "hardest", { constraints: [] });
  assert.deepEqual(
    [balanced, frontier, volume, hardest].map(({ model, reasoningEffort }) => [
      model,
      reasoningEffort
    ]),
    [
      ["gpt-6.1-terra", "medium"],
      ["gpt-6.1-sol", "high"],
      ["gpt-5.6-luna", "low"],
      ["gpt-6-astra", "ultra"]
    ]
  );
  assert.match(hardest.briefing, /You are one gpt-6-astra worker in a Codex worker pool/);
  assert.doesNotMatch(hardest.briefing, /GPT-5\.6/);
  assert.match(volume.briefing, /You are one gpt-5\.6-luna worker/);
  assert.match(volume.briefing, /reasoning effort: low/);

  const persisted = loadRun(root, "run-tiered");
  assert.deepEqual(
    Object.values(persisted.tasks).map((task) => {
      const attempt = task.attempts.at(-1);
      return [attempt.model, attempt.reasoningEffort];
    }),
    [
      ["gpt-6.1-terra", "medium"],
      ["gpt-6.1-sol", "high"],
      ["gpt-5.6-luna", "low"],
      ["gpt-6-astra", "ultra"]
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
    /Unsupported worker model "gpt-5\.6-mars"\. Use one of: astra, sol, terra, luna \(exact slugs: gpt-6-astra, gpt-6\.1-sol, gpt-6\.1-terra, gpt-5\.6-luna\)/
  );

  // Every model accepted every effort from low to ultra in the M0 probes, so the
  // only rejected combination for each model is an effort Codex does not know.
  for (const alias of ["astra", "sol", "terra", "luna"]) {
    assert.throws(
      () =>
        createRun(root, {
          id: `run-${alias}-bad-effort`,
          lane: "api",
          objective: "Reject invalid routing",
          workerModel: alias,
          reasoningEffort: "minimal"
        }),
      /Unsupported reasoning effort "minimal"\. Use one of: low, medium, high, xhigh, max, ultra/
    );
    createRunState(root, {
      id: `run-${alias}-task-bad-effort`,
      lane: "api",
      objective: "Validate task routes"
    });
    assert.throws(
      () =>
        replacePlan(root, `run-${alias}-task-bad-effort`, [
          {
            id: "bad-effort",
            title: "Invalid effort",
            objective: "Attempt an unknown effort",
            scope: ["src/**"],
            model: alias,
            effort: "extreme",
            routingReason: "Exercise the effort validator."
          }
        ]),
      /Unsupported reasoning effort "extreme"/
    );
    const ultra = createRun(root, {
      id: `run-${alias}-ultra`,
      lane: "api",
      objective: "Accept the top effort on every tier",
      workerModel: alias,
      reasoningEffort: "ultra"
    });
    assert.equal(ultra.workerPolicy.reasoningEffort, "ultra");
  }
});

test("new plans and pins reject legacy slugs and bare family names with a specific message", () => {
  const root = repo();
  for (const value of ["gpt-5.6-sol", "gpt-5.6-terra"]) {
    assert.throws(
      () => createRun(root, { id: `run-pin-${value}`, lane: "api", objective: "x", workerModel: value }),
      /belongs to the retired GPT-5\.6 Sol\/Terra roster.*only for runs saved by orchestrator 0\.5\.x/
    );
  }
  createRunState(root, { id: "run-new-plan", lane: "api", objective: "Route new work" });
  const planWith = (model) => () =>
    replacePlan(root, "run-new-plan", [
      {
        id: "task",
        title: "Task",
        objective: "Do the work",
        scope: ["src/**"],
        model,
        effort: "high",
        routingReason: "Exercise model validation."
      }
    ]);
  assert.throws(planWith("gpt-5.6-sol"), /retired GPT-5\.6 Sol\/Terra roster/);
  for (const family of ["gpt-5.6", "gpt-6", "gpt-6.1"]) {
    assert.throws(planWith(family), new RegExp(`"${family.replace(".", "\\.")}" is a model family, not a tier`));
  }
  assert.equal(planWith("gpt-6.1-sol")().tasks.task.model, "gpt-6.1-sol");
});

test("luna routes must be leaves unless the run pins luna", () => {
  const root = repo();
  createRunState(root, { id: "run-luna-leaf", lane: "api", objective: "Route luna carefully" });
  const graph = (lunaTask) => [
    {
      id: "transform",
      title: "Transform",
      objective: "Rename a symbol everywhere",
      scope: ["src/**"],
      model: lunaTask,
      effort: "low",
      routingReason: "Mechanical rename; the type checker catches a bad result immediately."
    },
    {
      id: "build-on-it",
      title: "Build on it",
      objective: "Use the renamed symbol",
      scope: ["src/**"],
      dependsOn: ["transform"],
      model: "sol",
      effort: "high",
      routingReason: "Open-ended follow-up work."
    }
  ];
  assert.throws(
    () => replacePlan(root, "run-luna-leaf", graph("luna")),
    /Task "transform" routes to luna, but build-on-it depend\(s\) on it/
  );
  assert.equal(replacePlan(root, "run-luna-leaf", graph("terra")).planRevision, 1);

  createRun(root, {
    id: "run-luna-pinned",
    lane: "api",
    objective: "User pinned luna",
    workerModel: "luna",
    reasoningEffort: "low"
  });
  const pinned = replacePlan(root, "run-luna-pinned", [
    { id: "first", title: "First", objective: "One", scope: ["src/**"] },
    { id: "second", title: "Second", objective: "Two", scope: ["src/**"], dependsOn: ["first"] }
  ]);
  assert.equal(pinned.tasks.first.model, "gpt-5.6-luna");
});

test("a version-5 run routed to gpt-5.6-sol loads, resumes, and retries on gpt-5.6-sol", () => {
  const root = repo();
  createRunState(root, { id: "run-v5-legacy", lane: "api", objective: "Old routed run" });
  replacePlan(root, "run-v5-legacy", [
    {
      id: "legacy",
      title: "Legacy",
      objective: "Saved by 0.5.x",
      scope: ["src/**"],
      model: "sol",
      effort: "high",
      routingReason: "Saved before the roster refresh."
    }
  ]);
  addCheckpoint(root, "run-v5-legacy", { summary: "0.5.x checkpoint" });
  const file = runFile(root, "run-v5-legacy");
  const state = JSON.parse(fs.readFileSync(file, "utf8"));
  state.version = 5;
  state.tasks.legacy.model = "gpt-5.6-sol";
  fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);

  const loaded = loadRun(root, "run-v5-legacy");
  assert.equal(loaded.version, 5);
  assert.deepEqual(resolveTaskWorker(loaded, loaded.tasks.legacy), {
    model: "gpt-5.6-sol",
    reasoningEffort: "high"
  });

  const first = claimTask(root, "run-v5-legacy", "legacy", { constraints: [] });
  assert.equal(first.model, "gpt-5.6-sol");
  assert.equal(first.substitution, null);
  assert.match(first.briefing, /You are one gpt-5\.6-sol worker/);
  assert.equal(loadRun(root, "run-v5-legacy").version, 6);
  assert.equal(recoveryReport(loadRun(root, "run-v5-legacy"))[0].model, "gpt-5.6-sol");
  assert.match(
    renderSupervisorBriefing(root, loadRun(root, "run-v5-legacy"), { constraints: [] }),
    /worker route: gpt-5\.6-sol \(high\)/
  );

  failTaskAttempt(root, "run-v5-legacy", "legacy", {
    attemptId: first.attemptId,
    error: "transient failure"
  });
  retryTask(root, "run-v5-legacy", "legacy");
  // The legacy task can be resubmitted on its exact slug in a plan revision,
  // but a new task cannot adopt that slug.
  replacePlan(root, "run-v5-legacy", [
    {
      id: "legacy",
      title: "Legacy",
      objective: "Saved by 0.5.x",
      scope: ["src/**"],
      model: "gpt-5.6-sol",
      effort: "high",
      routingReason: "Saved before the roster refresh."
    }
  ]);
  assert.throws(
    () =>
      replacePlan(root, "run-v5-legacy", [
        {
          id: "newcomer",
          title: "New",
          objective: "New work",
          scope: ["src/**"],
          model: "gpt-5.6-sol",
          effort: "high",
          routingReason: "Try the legacy slug."
        }
      ]),
    /retired GPT-5\.6 Sol\/Terra roster/
  );
  addCheckpoint(root, "run-v5-legacy", { summary: "Retry the legacy task" });
  const second = claimTask(root, "run-v5-legacy", "legacy", { constraints: [] });
  assert.equal(second.model, "gpt-5.6-sol");
  assert.deepEqual(
    loadRun(root, "run-v5-legacy").tasks.legacy.attempts.map((attempt) => attempt.model),
    ["gpt-5.6-sol", "gpt-5.6-sol"]
  );
});

test("a version-5 run pinned to gpt-5.6-terra keeps the pin for new tasks", () => {
  const root = repo();
  createRun(root, {
    id: "run-v5-pinned",
    lane: "api",
    objective: "Old pinned run",
    workerModel: "terra",
    reasoningEffort: "medium"
  });
  const file = runFile(root, "run-v5-pinned");
  const state = JSON.parse(fs.readFileSync(file, "utf8"));
  state.version = 5;
  state.workerPolicy.model = "gpt-5.6-terra";
  fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
  const planned = replacePlan(root, "run-v5-pinned", [
    { id: "added", title: "Added", objective: "Added after upgrade", scope: ["src/**"] }
  ]);
  assert.equal(planned.tasks.added.model, "gpt-5.6-terra");
  assert.throws(
    () =>
      replacePlan(root, "run-v5-pinned", [
        { id: "added", title: "Added", objective: "x", scope: ["src/**"], model: "sol" }
      ]),
    /run explicitly pins gpt-5\.6-terra/
  );
});

test("a run written by a newer orchestrator is refused", () => {
  const root = repo();
  createRun(root, { id: "run-future", lane: "api", objective: "Future" });
  const file = runFile(root, "run-future");
  const state = JSON.parse(fs.readFileSync(file, "utf8"));
  state.version = 7;
  fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
  assert.throws(() => loadRun(root, "run-future"), /state version 7, this build supports 6/);
});

test("automatic routing rejects unresolved tasks and explicit run pins reject conflicts", () => {
  const root = repo();
  createRunState(root, {
    id: "run-auto-guard",
    lane: "api",
    objective: "Require deliberate routes"
  });
  assert.throws(
    () =>
      replacePlan(root, "run-auto-guard", [
        {
          id: "unrouted",
          title: "Unrouted task",
          objective: "Do not guess",
          scope: ["src/**"]
        }
      ]),
    /requires a model because this run uses automatic model routing/
  );
  assert.throws(
    () =>
      replacePlan(root, "run-auto-guard", [
        {
          id: "no-reason",
          title: "Missing rationale",
          objective: "Route without explaining why",
          scope: ["src/**"],
          model: "terra",
          effort: "medium"
        }
      ]),
    /requires routingReason/
  );

  createRunState(root, {
    id: "run-pinned",
    lane: "api",
    objective: "Force a homogeneous pool",
    workerModel: "terra",
    reasoningEffort: "high"
  });
  assert.throws(
    () =>
      replacePlan(root, "run-pinned", [
        {
          id: "effort-conflict",
          title: "Conflicting effort",
          objective: "Try to override the user",
          scope: ["src/**"],
          effort: "low"
        }
      ]),
    /run explicitly pins "high"/
  );
  assert.throws(
    () =>
      replacePlan(root, "run-pinned", [
        {
          id: "conflict",
          title: "Conflicting route",
          objective: "Try to override the user",
          scope: ["src/**"],
          model: "sol"
        }
      ]),
    /run explicitly pins gpt-6\.1-terra/
  );
  const pinned = replacePlan(root, "run-pinned", [
    {
      id: "inherits",
      title: "Pinned route",
      objective: "Use the explicit run override",
      scope: ["src/**"]
    }
  ]);
  assert.deepEqual(resolveTaskWorker(pinned, pinned.tasks.inherits), {
    model: "gpt-6.1-terra",
    reasoningEffort: "high"
  });
  assert.equal(pinned.tasks.inherits.routingReason, null);
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
  legacyState.version = 3;
  legacyState.workerPolicy.model = "gpt-5.6-terra";
  delete legacyState.guidance;
  delete legacyState.workerPolicy.routingMode;
  delete legacyState.tasks.legacy.model;
  delete legacyState.tasks.legacy.reasoningEffort;
  delete legacyState.tasks.legacy.routingReason;
  delete legacyState.tasks.legacy.guidanceSelection;
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
  assert.equal(replanned.version, 6);
  assert.equal(replanned.guidance.mode, "disabled");

  const terminalState = JSON.parse(fs.readFileSync(file, "utf8"));
  delete terminalState.tasks.legacy.attempts[0].outcome;
  fs.writeFileSync(file, `${JSON.stringify(terminalState, null, 2)}\n`);
  const loadedLegacyOutcome = loadRun(root, "run-legacy");
  assert.equal(loadedLegacyOutcome.tasks.legacy.status, "completed");
  assert.match(
    renderSupervisorBriefing(root, loadedLegacyOutcome, { constraints: [] }),
    /unclassified \(legacy state\)/
  );

  terminalState.tasks.legacy.attempts[0].outcome = {
    version: 99,
    terminalOutcome: "accepted",
    action: "execute",
    reasonCode: "supervisor_verified",
    provenance: "supervisor",
    signals: []
  };
  fs.writeFileSync(file, `${JSON.stringify(terminalState, null, 2)}\n`);
  assert.throws(() => loadRun(root, "run-legacy"), /invalid outcome/);
});

test("version-4 runs without guidance remain readable and upgrade on mutation", () => {
  const root = repo();
  createRun(root, { id: "run-v4-guidance", lane: "api", objective: "Read old state" });
  replacePlan(root, "run-v4-guidance", [
    { id: "legacy", title: "Legacy", objective: "Legacy read", kind: "read" }
  ]);
  addCheckpoint(root, "run-v4-guidance", { summary: "Legacy checkpoint" });
  const file = runFile(root, "run-v4-guidance");
  const state = JSON.parse(fs.readFileSync(file, "utf8"));
  state.version = 4;
  delete state.guidance;
  delete state.tasks.legacy.guidanceSelection;
  delete state.checkpoints[0].guidanceRevision;
  fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
  const loaded = loadRun(root, "run-v4-guidance");
  assert.equal(loaded.version, 4);
  assert.equal(loaded.guidance, undefined);
  assert.equal(checkpointStatus(loaded).current, true);
  assert.equal(checkpointStatus({ ...loaded, guidance: { revision: 1 } }).current, false);
  addCheckpoint(root, "run-v4-guidance", { summary: "Upgrade safely" });
  const upgraded = loadRun(root, "run-v4-guidance");
  assert.equal(upgraded.version, 6);
  assert.equal(upgraded.guidance.mode, "disabled");
  const future = JSON.parse(fs.readFileSync(file, "utf8"));
  future.guidance.schemaVersion = 2;
  fs.writeFileSync(file, `${JSON.stringify(future, null, 2)}\n`);
  assert.throws(() => loadRun(root, "run-v4-guidance"), /invalid guidance metadata/);
});

test("version-5 runs require guidance state and bind selections to retained policies", () => {
  const root = repo();
  const laneRef = `lane-${"c".repeat(32)}`;
  const firstPolicy = createProvisionalGuidancePolicy({
    policyVersion: "membership-v1",
    sources: [{
      sourceType: "curated_label",
      sourceId: `label-${"d".repeat(32)}`,
      provenance: "supervisor",
      lane: laneRef,
      taskKind: "read",
      terminalOutcome: "worker_blocked",
      action: "clarify",
      reasonCode: "missing_context",
      signals: []
    }]
  });
  const secondPolicy = createProvisionalGuidancePolicy({
    policyVersion: "membership-v1",
    sources: [{
      sourceType: "curated_label",
      sourceId: `label-${"e".repeat(32)}`,
      provenance: "user",
      lane: laneRef,
      taskKind: "read",
      terminalOutcome: "verification_failed",
      action: "replan",
      reasonCode: "test_failure",
      signals: []
    }]
  });
  createRun(root, { id: "run-guidance-membership", lane: "api", objective: "Bind guidance" });
  replacePlan(root, "run-guidance-membership", [
    { id: "review", title: "Review", objective: "Review input", kind: "read" }
  ]);
  configureRunGuidance(root, "run-guidance-membership", {
    mode: "provisional",
    laneRef,
    policy: firstPolicy
  });
  const file = runFile(root, "run-guidance-membership");
  const missing = JSON.parse(fs.readFileSync(file, "utf8"));
  delete missing.guidance;
  fs.writeFileSync(file, `${JSON.stringify(missing, null, 2)}\n`);
  assert.throws(
    () => loadRun(root, "run-guidance-membership"),
    /missing required version-5 guidance state/
  );

  missing.guidance = configureRunGuidanceState(firstPolicy, laneRef);
  const foreignSelection = selectGuidance(secondPolicy, {
    lane: laneRef,
    taskKind: "read",
    outcome: {
      terminalOutcome: "verification_failed",
      action: "replan",
      reasonCode: "test_failure",
      signals: []
    }
  });
  foreignSelection.policyHash = firstPolicy.policyHash;
  missing.tasks.review.guidanceSelection = foreignSelection;
  fs.writeFileSync(file, `${JSON.stringify(missing, null, 2)}\n`);
  assert.throws(
    () => loadRun(root, "run-guidance-membership"),
    /item outside its referenced policy/
  );
});

test("guidance policy versions cannot be rebound to a different hash", () => {
  const root = repo();
  const laneRef = `lane-${"9".repeat(32)}`;
  const makePolicy = (sourceId, terminalOutcome, action, reasonCode) =>
    createProvisionalGuidancePolicy({
      policyVersion: "immutable-v1",
      sources: [{
        sourceType: "curated_label",
        sourceId,
        provenance: "supervisor",
        lane: laneRef,
        taskKind: "read",
        terminalOutcome,
        action,
        reasonCode,
        signals: []
      }]
    });
  const first = makePolicy(
    `label-${"7".repeat(32)}`, "worker_blocked", "clarify", "missing_context"
  );
  const replacement = makePolicy(
    `label-${"8".repeat(32)}`, "verification_failed", "replan", "test_failure"
  );
  assert.notEqual(first.policyHash, replacement.policyHash);

  createRun(root, { id: "run-guidance-version", lane: "api", objective: "Version guidance" });
  replacePlan(root, "run-guidance-version", [
    { id: "review", title: "Review", objective: "Review input", kind: "read" }
  ]);
  const enabled = configureRunGuidance(root, "run-guidance-version", {
    mode: "provisional", laneRef, policy: first
  });
  const unchanged = configureRunGuidance(root, "run-guidance-version", {
    mode: "provisional", laneRef, policy: first
  });
  assert.equal(unchanged.guidance.revision, enabled.guidance.revision);
  assert.throws(
    () => configureRunGuidance(root, "run-guidance-version", {
      mode: "provisional", laneRef, policy: replacement
    }),
    /choose a new --policy-version/
  );
  assert.equal(loadRun(root, "run-guidance-version").guidance.policy.policyHash,
    first.policyHash);

  const file = runFile(root, "run-guidance-version");
  const conflicting = JSON.parse(fs.readFileSync(file, "utf8"));
  conflicting.guidance.policy = replacement;
  fs.writeFileSync(file, `${JSON.stringify(conflicting, null, 2)}\n`);
  assert.throws(
    () => loadRun(root, "run-guidance-version"),
    /choose a new --policy-version/
  );
});

test("guidance off and rollback recover from a malformed active policy", () => {
  const root = repo();
  const laneRef = `lane-${"f".repeat(32)}`;
  const makePolicy = (version, sourceId, action, terminalOutcome, reasonCode) =>
    createProvisionalGuidancePolicy({
      policyVersion: version,
      sources: [{
        sourceType: "curated_label",
        sourceId,
        provenance: "supervisor",
        lane: laneRef,
        taskKind: "read",
        terminalOutcome,
        action,
        reasonCode,
        signals: []
      }]
    });
  const first = makePolicy(
    "recovery-v1", `label-${"1".repeat(32)}`, "clarify", "worker_blocked", "missing_context"
  );
  const second = makePolicy(
    "recovery-v2", `label-${"2".repeat(32)}`, "replan", "verification_failed", "test_failure"
  );

  createRun(root, { id: "run-guidance-off-recovery", lane: "api", objective: "Disable safely" });
  replacePlan(root, "run-guidance-off-recovery", [
    { id: "review", title: "Review", objective: "Review input", kind: "read" }
  ]);
  configureRunGuidance(root, "run-guidance-off-recovery", {
    mode: "provisional", laneRef, policy: first
  });
  corruptActiveGuidance(root, "run-guidance-off-recovery");
  const disabled = configureRunGuidance(root, "run-guidance-off-recovery", { mode: "off" });
  assert.equal(disabled.guidance.mode, "disabled");
  assert.equal(disabled.tasks.review.guidanceSelection.enabled, false);
  assert.equal(loadRun(root, "run-guidance-off-recovery").guidance.mode, "disabled");

  createRun(root, { id: "run-guidance-rollback-recovery", lane: "api", objective: "Rollback safely" });
  replacePlan(root, "run-guidance-rollback-recovery", [
    { id: "review", title: "Review", objective: "Review input", kind: "read" }
  ]);
  configureRunGuidance(root, "run-guidance-rollback-recovery", {
    mode: "provisional", laneRef, policy: first
  });
  configureRunGuidance(root, "run-guidance-rollback-recovery", {
    mode: "provisional", laneRef, policy: second
  });
  corruptActiveGuidance(root, "run-guidance-rollback-recovery");
  const rollbackFile = runFile(root, "run-guidance-rollback-recovery");
  const corruptHistory = JSON.parse(fs.readFileSync(rollbackFile, "utf8"));
  corruptHistory.guidance.history.push({
    mode: "provisional",
    laneRef,
    policy: { ...second, status: "corrupt-history" }
  });
  fs.writeFileSync(rollbackFile, `${JSON.stringify(corruptHistory, null, 2)}\n`);
  const restored = configureRunGuidance(root, "run-guidance-rollback-recovery", {
    rollback: true
  });
  assert.equal(restored.guidance.policy.policyHash, first.policyHash);
  assert.equal(restored.tasks.review.guidanceSelection.policyHash, first.policyHash);
  assert.equal(loadRun(root, "run-guidance-rollback-recovery").guidance.policy.policyHash,
    first.policyHash);
});

function configureRunGuidanceState(policy, laneRef) {
  return {
    schemaVersion: 1,
    mode: "provisional",
    revision: 1,
    laneRef,
    policy,
    history: [{ mode: "disabled", laneRef: null, policy: null }],
    policies: [policy]
  };
}

function corruptActiveGuidance(root, runId) {
  const file = runFile(root, runId);
  const state = JSON.parse(fs.readFileSync(file, "utf8"));
  state.guidance.policy.entries[0].text = "corrupt active policy";
  fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
}

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
  assert.equal(
    blocked.task.attempts.at(-1).outcome.terminalOutcome,
    "worker_blocked"
  );

  retryTask(root, "run-retry", "work");
  checkpointPlan(root, "run-retry");
  const second = claimTask(root, "run-retry", "work", { constraints: [] });
  assert.equal(second.attemptId, "work-attempt-2");
  const failed = recordTaskResult(root, "run-retry", "work", {
    attemptId: second.attemptId,
    resultText: "No result contract"
  });
  assert.equal(failed.task.status, "failed");
  assert.equal(failed.task.attempts[0].outcome.terminalOutcome, "worker_blocked");
  assert.equal(failed.task.attempts[1].outcome.terminalOutcome, "contract_failed");
  assert.deepEqual(failed.task.result.missingFields, [
    "files_touched",
    "decisions",
    "assumptions",
    "blockers",
    "confidence"
  ]);
});

test("structured worker blocker codes select an auditable next action", () => {
  const root = repo();
  createRun(root, { id: "run-blocker-code", lane: "api", objective: "Classify blockers" });
  replacePlan(root, "run-blocker-code", [
    { id: "work", title: "Work", objective: "Inspect context", kind: "read" }
  ]);
  checkpointPlan(root, "run-blocker-code");
  const dispatch = claimTask(root, "run-blocker-code", "work", { constraints: [] });
  const blocked = recordTaskResult(root, "run-blocker-code", "work", {
    attemptId: dispatch.attemptId,
    resultText: JSON.stringify({
      summary: "A required input was not provided.",
      files_touched: [],
      tests: [],
      decisions: [],
      assumptions: [],
      blockers: ["missing API response fixture"],
      blocker_code: "missing_context",
      confidence: "high"
    })
  });
  assert.equal(blocked.task.status, "blocked");
  assert.equal(blocked.attempt.outcome.terminalOutcome, "worker_blocked");
  assert.equal(blocked.attempt.outcome.action, "clarify");
  assert.equal(blocked.attempt.outcome.reasonCode, "missing_context");
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
  assert.equal(
    rejected.task.attempts.at(-1).outcome.terminalOutcome,
    "verification_failed"
  );
  assert.equal(
    fs.readFileSync(eventsFile(root, "run-control"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .at(-1).type,
    "task.verification_failed"
  );
  const cancelledTask = cancelTask(root, "run-control", "b", "superseded");
  assert.equal(cancelledTask.status, "cancelled");

  retryTask(root, "run-control", "a");
  const run = cancelRun(root, "run-control", "user stopped the run");
  assert.equal(run.status, "cancelled");
  assert.equal(run.tasks.a.status, "cancelled");
  assert.equal(run.cancelReason, "user stopped the run");
  assert.equal(
    run.tasks.a.attempts.at(-1).outcome.terminalOutcome,
    "verification_failed",
    "run cancellation does not overwrite an earlier terminal outcome"
  );
});

test("reported attempts can be cancelled without overwriting earlier terminal outcomes", () => {
  const root = repo();
  createRun(root, { id: "run-cancel-outcome", lane: "api", objective: "Cancel safely" });
  replacePlan(root, "run-cancel-outcome", [
    { id: "work", title: "Work", objective: "Work", kind: "read" }
  ]);
  checkpointPlan(root, "run-cancel-outcome");
  const dispatch = claimTask(root, "run-cancel-outcome", "work", { constraints: [] });
  recordTaskResult(root, "run-cancel-outcome", "work", {
    attemptId: dispatch.attemptId,
    resultText: resultBlock({ files: "none" })
  });
  const cancelled = cancelTask(root, "run-cancel-outcome", "work", "no longer needed");
  assert.equal(cancelled.attempts.at(-1).status, "cancelled");
  assert.equal(cancelled.attempts.at(-1).outcome.terminalOutcome, "cancelled");

  createRun(root, { id: "run-cancel-terminal", lane: "api", objective: "Preserve failure" });
  replacePlan(root, "run-cancel-terminal", [
    { id: "work", title: "Work", objective: "Work", kind: "read" }
  ]);
  checkpointPlan(root, "run-cancel-terminal");
  const failedDispatch = claimTask(root, "run-cancel-terminal", "work", { constraints: [] });
  recordTaskResult(root, "run-cancel-terminal", "work", {
    attemptId: failedDispatch.attemptId,
    resultText: "malformed"
  });
  const terminal = cancelTask(root, "run-cancel-terminal", "work", "close it");
  assert.equal(terminal.attempts.at(-1).outcome.terminalOutcome, "contract_failed");
});

test("repeated failure collection is idempotent for the same classification", () => {
  const root = repo();
  createRun(root, { id: "run-idempotent-failure", lane: "api", objective: "Collect once" });
  replacePlan(root, "run-idempotent-failure", [
    { id: "work", title: "Work", objective: "Work", kind: "read" }
  ]);
  checkpointPlan(root, "run-idempotent-failure");
  const dispatch = claimTask(root, "run-idempotent-failure", "work", { constraints: [] });
  const first = failTaskAttempt(root, "run-idempotent-failure", "work", {
    attemptId: dispatch.attemptId,
    error: "runner exited"
  });
  const second = failTaskAttempt(root, "run-idempotent-failure", "work", {
    attemptId: dispatch.attemptId,
    error: "runner exited again"
  });
  assert.equal(first.attempts.at(-1).outcome.terminalOutcome, "execution_failed");
  assert.equal(second.attempts.at(-1).outcome.terminalOutcome, "execution_failed");
  const failures = fs
    .readFileSync(eventsFile(root, "run-idempotent-failure"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .filter((event) => event.type === "task.execution_failed");
  assert.equal(failures.length, 1);
});

test("supervisor dispositions and integration diagnostics are structured and retryable", () => {
  const root = repo();
  createRun(root, { id: "run-disposition", lane: "api", objective: "Decide explicitly" });
  replacePlan(root, "run-disposition", [
    { id: "work", title: "Work", objective: "Work", kind: "read" }
  ]);
  checkpointPlan(root, "run-disposition");
  const dispatch = claimTask(root, "run-disposition", "work", { constraints: [] });
  recordTaskResult(root, "run-disposition", "work", {
    attemptId: dispatch.attemptId,
    resultText: resultBlock({ files: "none" })
  });
  const diagnostic = recordIntegrationDiagnostic(root, "run-disposition", "work", {
    reasonCode: "scope_violation",
    signals: ["integration_inspection_failed", "scope_violation"],
    details: { outOfScope: ["docs/oops.md"] }
  });
  assert.equal(diagnostic.task.status, "reported");
  assert.equal(diagnostic.task.attempts.at(-1).outcome, null);
  assert.equal(diagnostic.diagnostic.reasonCode, "scope_violation");
  const diagnosticEvents = fs
    .readFileSync(eventsFile(root, "run-disposition"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(diagnosticEvents.at(-1).type, "task.integration_refused");

  const failedDiagnostic = recordIntegrationDiagnostic(root, "run-disposition", "work", {
    kind: "failed",
    reasonCode: "integration_conflict",
    signals: ["integration_conflict"]
  });
  assert.equal(failedDiagnostic.task.status, "reported");
  assert.equal(failedDiagnostic.task.attempts.at(-1).outcome, null);
  const failedDiagnosticEvents = fs
    .readFileSync(eventsFile(root, "run-disposition"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(failedDiagnosticEvents.at(-1).type, "task.integration_failed");

  const decided = recordTaskDisposition(root, "run-disposition", "work", {
    terminalOutcome: "policy_refused",
    action: "refuse",
    reasonCode: "policy_boundary",
    evidence: ["scope policy applies"]
  });
  assert.equal(decided.task.status, "blocked");
  assert.equal(decided.task.attempts.at(-1).outcome.terminalOutcome, "policy_refused");
  const retried = retryTask(root, "run-disposition", "work");
  assert.equal(retried.disposition, null);
  checkpointPlan(root, "run-disposition");
  const retryDispatch = claimTask(root, "run-disposition", "work", { constraints: [] });
  recordTaskResult(root, "run-disposition", "work", {
    attemptId: retryDispatch.attemptId,
    resultText: resultBlock({ files: "none" })
  });
  const accepted = verifyTask(root, "run-disposition", "work", {
    verdict: "pass",
    evidence: ["policy concern resolved"]
  });
  assert.equal(accepted.task.attempts[0].outcome.terminalOutcome, "policy_refused");
  assert.equal(accepted.task.attempts[1].outcome.terminalOutcome, "accepted");
  assert.equal(accepted.task.disposition, null);

  createRun(root, { id: "run-escalate", lane: "api", objective: "Escalate explicitly" });
  replacePlan(root, "run-escalate", [
    { id: "work", title: "Work", objective: "Work", kind: "read" }
  ]);
  checkpointPlan(root, "run-escalate");
  const escalateDispatch = claimTask(root, "run-escalate", "work", { constraints: [] });
  recordTaskResult(root, "run-escalate", "work", {
    attemptId: escalateDispatch.attemptId,
    resultText: resultBlock({ files: "none" })
  });
  const escalated = recordTaskDisposition(root, "run-escalate", "work", {
    terminalOutcome: "authority_escalated",
    action: "escalate",
    reasonCode: "missing_authority",
    evidence: ["user approval required"]
  });
  assert.equal(escalated.task.attempts.at(-1).outcome.terminalOutcome, "authority_escalated");

  createRun(root, { id: "run-integration-terminal", lane: "api", objective: "Stop conflict" });
  replacePlan(root, "run-integration-terminal", [
    { id: "work", title: "Work", objective: "Work", kind: "read" }
  ]);
  checkpointPlan(root, "run-integration-terminal");
  const conflictDispatch = claimTask(root, "run-integration-terminal", "work", {
    constraints: []
  });
  recordTaskResult(root, "run-integration-terminal", "work", {
    attemptId: conflictDispatch.attemptId,
    resultText: resultBlock({ files: "none" })
  });
  const integrationFailed = recordTaskDisposition(
    root,
    "run-integration-terminal",
    "work",
    {
      terminalOutcome: "integration_failed",
      action: "replan",
      reasonCode: "integration_conflict",
      evidence: ["conflict cannot be retried safely"]
    }
  );
  assert.equal(integrationFailed.task.status, "failed");
  assert.equal(
    integrationFailed.task.attempts.at(-1).outcome.terminalOutcome,
    "integration_failed"
  );
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

test("retired cancelled tasks keep attempt identity and remain reachable for cleanup", () => {
  const root = repo();
  const runId = "run-retired-cleanup";
  createRun(root, { id: runId, lane: "api", objective: "Keep cancelled evidence" });
  const definition = { id: "work", title: "Work", objective: "Original", kind: "read" };
  replacePlan(root, runId, [definition]);
  checkpointPlan(root, runId);
  const first = claimTask(root, runId, "work", { constraints: [] });
  cancelTask(root, runId, "work", "No longer needed");
  // A retry can be pending when the task is retired; its worktree is still audit state.
  retryTask(root, runId, "work");
  replacePlan(root, runId, [{ ...definition, id: "other" }]);
  const removed = loadRun(root, runId);
  assert.equal(removed.tasks.work, undefined);
  assert.equal(removed.retiredTasks[0].attempts[0].id, first.attemptId);
  assert.equal(removed.retiredTasks[0].attempts[0].assignmentSnapshot.text.taskObjective, "Original");
  assert.deepEqual(readyTasks(removed).map((task) => task.id), ["other"]);
  const detach = (attempt) => ({ id: attempt.id });
  const live = takeWorktreesForRemoval(root, runId, "work", detach, () => true);
  assert.equal(live.taken.length, 0);
  assert.equal(live.refused[0].attemptId, first.attemptId);
  assert.deepEqual(takeWorktreesForRemoval(root, runId, "work", detach).taken.map((item) => item.attempt.id),
    [first.attemptId]);
  replacePlan(root, runId, [{ ...definition, objective: "Replacement" }]);
  checkpointPlan(root, runId);
  const second = claimTask(root, runId, "work", { constraints: [] });
  assert.equal(second.attemptId, "work-attempt-2");
  assert.throws(() => attachExecution(root, runId, "work", {
    attemptId: first.attemptId, worktree: { path: "/late-original-worktree" }, runner: {}
  }), /cancelled, not dispatching/);
  assert.equal(loadRun(root, runId).retiredTasks[0].attempts[0].worktree.path, "/late-original-worktree");
  assert.equal(loadRun(root, runId).tasks.work.attempts[0].worktree, undefined);
  // Targeting an ID shared by an active and retired assignment still cleans only the retired one.
  assert.deepEqual(takeWorktreesForRemoval(root, runId, "work", detach).taken.map((item) => item.attempt.id),
    [first.attemptId]);
  cancelTask(root, runId, "work");
  replacePlan(root, runId, [{ ...definition, id: "other" }]);
  replacePlan(root, runId, [definition]);
  checkpointPlan(root, runId);
  assert.equal(claimTask(root, runId, "work", { constraints: [] }).attemptId, "work-attempt-3");
  assert.equal(loadRun(root, runId).retiredTasks.filter((task) => task.id === "work").length, 2);
  failTaskAttempt(root, runId, "work", {
    attemptId: second.attemptId, worktree: { path: "/late-second-worktree" },
    error: "Launch stopped", launchFailed: true
  });
  const retiredSecond = loadRun(root, runId).retiredTasks.find((task) =>
    task.attempts.some((attempt) => attempt.id === second.attemptId));
  assert.equal(retiredSecond.attempts[0].worktree.path, "/late-second-worktree");
  assert.equal(retiredSecond.attempts[0].outcome.terminalOutcome, "cancelled");
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
  assert.match(briefing, /accepted \/ execute \/ supervisor_verified \(supervisor\)/);
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
