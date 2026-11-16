import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  claimTask,
  createRun,
  eventsFile,
  finalizeRun,
  loadRun,
  recordIntegration,
  recordTaskResult,
  renderSupervisorBriefing,
  replacePlan,
  runFile,
  verifyTask
} from "../plugins/orchestrator/scripts/lib/runs.mjs";
import {
  WORKER_RESULT_SCHEMA,
  launchTaskWorker,
  modelUnavailableError,
  pollRunWorkers,
  stopTaskWorker
} from "../plugins/orchestrator/scripts/lib/workers.mjs";
import {
  cleanupTaskWorktree,
  createTaskWorktree,
  inspectTaskWorktree,
  integrateTaskWorktree
} from "../plugins/orchestrator/scripts/lib/worktrees.mjs";
import { checkpointPlan, cleanup, git, makeRepo, runCli, write } from "./helpers.mjs";

const repos = [];
const fixture = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "fake-codex.mjs"
);
const slowFixture = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "fake-codex-slow.mjs"
);
const writeFixture = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "fake-codex-write.mjs"
);
const noResultFixture = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "fake-codex-no-result.mjs"
);
const failedFixture = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "fake-codex-fail.mjs"
);

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

function plan(root, id, { workerModel, taskModel, taskEffort } = {}) {
  const autoRouted = Boolean(taskModel || taskEffort);
  createRun(root, {
    id,
    lane: "api",
    objective: "Build safely",
    workerModel: autoRouted ? undefined : workerModel ?? "sol",
    reasoningEffort: autoRouted ? undefined : "high"
  });
  replacePlan(root, id, [
    {
      id: "build",
      title: "Build",
      objective: "Add the module",
      scope: ["src/**"],
      acceptance: ["tests pass"],
      model: taskModel,
      effort: taskEffort,
      routingReason: autoRouted
        ? "The supervisor selected this route for the bounded task."
        : undefined
    }
  ]);
}

test("write worktrees require committed, clean, declared, in-scope changes before integration", () => {
  const root = repo();
  plan(root, "run-worktree");
  checkpointPlan(root, "run-worktree");
  const dispatch = claimTask(root, "run-worktree", "build", { constraints: [] });
  let run = loadRun(root, "run-worktree");
  let task = run.tasks.build;
  let attempt = task.attempts.at(-1);
  const worktree = createTaskWorktree(root, run, task, attempt);
  attempt.worktree = worktree;
  write(worktree.path, "src/module.js", "export const value = 1;\n");
  git(worktree.path, ["add", "src/module.js"]);
  git(worktree.path, ["commit", "--quiet", "-m", "Add module"]);

  recordTaskResult(root, "run-worktree", "build", {
    attemptId: dispatch.attemptId,
    resultText: JSON.stringify({
      summary: "Added the module.",
      files_touched: ["src/module.js"],
      tests: [{ command: "node --test", outcome: "passed" }],
      decisions: [],
      assumptions: [],
      blockers: [],
      confidence: "high"
    })
  });
  run = loadRun(root, "run-worktree");
  task = run.tasks.build;
  task.attempts.at(-1).worktree = worktree;
  const inspection = inspectTaskWorktree(task, task.attempts.at(-1));
  assert.equal(inspection.ready, true);
  assert.deepEqual(inspection.files, ["src/module.js"]);

  const integrated = integrateTaskWorktree(root, run, task, task.attempts.at(-1));
  const result = recordIntegration(root, "run-worktree", "build", {
    evidence: ["worker tests passed", "scope inspection passed"],
    ...integrated
  });
  assert.equal(result.task.status, "completed");
  assert.equal(result.task.attempts.at(-1).outcome.terminalOutcome, "accepted");
  assert.equal(fs.readFileSync(path.join(root, "src/module.js"), "utf8"), "export const value = 1;\n");
  assert.equal(cleanupTaskWorktree(root, task.attempts.at(-1)), true);
});

test("worktree inspection rejects out-of-scope files", () => {
  const root = repo();
  plan(root, "run-scope");
  checkpointPlan(root, "run-scope");
  const dispatch = claimTask(root, "run-scope", "build", { constraints: [] });
  const run = loadRun(root, "run-scope");
  const task = run.tasks.build;
  const attempt = task.attempts.at(-1);
  attempt.worktree = createTaskWorktree(root, run, task, attempt);
  write(attempt.worktree.path, "docs/oops.md", "outside\n");
  git(attempt.worktree.path, ["add", "docs/oops.md"]);
  git(attempt.worktree.path, ["commit", "--quiet", "-m", "Add outside file"]);
  recordTaskResult(root, "run-scope", "build", {
    attemptId: dispatch.attemptId,
    resultText: JSON.stringify({
      summary: "Changed the wrong file.",
      files_touched: ["docs/oops.md"],
      tests: [],
      decisions: [],
      assumptions: [],
      blockers: [],
      confidence: "high"
    })
  });
  task.result = loadRun(root, "run-scope").tasks.build.result;
  const inspection = inspectTaskWorktree(task, attempt);
  assert.equal(inspection.ready, false);
  assert.deepEqual(inspection.outOfScope, ["docs/oops.md"]);
});

test("worker launch rejects supervisor branch drift outside the run", () => {
  const root = repo();
  plan(root, "run-drift");
  checkpointPlan(root, "run-drift");
  write(root, "src/manual.js", "export const manual = true;\n");
  git(root, ["add", "src/manual.js"]);
  git(root, ["commit", "--quiet", "-m", "Add manual change"]);

  assert.throws(
    () => launchTaskWorker(root, "run-drift", "build", { constraints: [] }, {
      codexCommand: [process.execPath, fixture]
    }),
    /advanced outside run/
  );
  assert.equal(loadRun(root, "run-drift").tasks.build.status, "failed");
  assert.equal(
    loadRun(root, "run-drift").tasks.build.attempts.at(-1).outcome.terminalOutcome,
    "execution_failed"
  );
});

test("detached workers persist status, thread id, and structured results", async () => {
  const root = repo();
  plan(root, "run-worker", { taskModel: "terra", taskEffort: "medium" });
  checkpointPlan(root, "run-worker");
  const launched = launchTaskWorker(root, "run-worker", "build", { constraints: [] }, {
    codexCommand: [process.execPath, fixture]
  });
  assert.equal(launched.model, "gpt-6.1-terra");
  assert.equal(launched.reasoningEffort, "medium");
  assert.ok(launched.runner.pid > 0);
  assert.ok(fs.existsSync(launched.worktree.path));
  const spec = JSON.parse(fs.readFileSync(launched.runner.specFile, "utf8"));
  assert.equal(spec.model, "gpt-6.1-terra");
  assert.equal(spec.reasoningEffort, "medium");

  let update;
  for (let index = 0; index < 50; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    update = pollRunWorkers(root, "run-worker")[0];
    if (update && !["running", "dispatching"].includes(update.status)) {
      break;
    }
  }
  assert.equal(update.status, "reported");
  assert.equal(update.threadId, "thread-fake");
  const task = loadRun(root, "run-worker").tasks.build;
  assert.equal(task.result.structured.summary, "Fake worker completed.");
  assert.equal(task.attempts.at(-1).threadId, "thread-fake");
  assert.equal(task.attempts.at(-1).runner.status, "completed");
  assert.ok(task.attempts.at(-1).runner.childPid > 0);
});

test("worker collection distinguishes missing contracts from execution failures", async () => {
  const root = repo();
  plan(root, "run-no-result");
  checkpointPlan(root, "run-no-result");
  launchTaskWorker(root, "run-no-result", "build", { constraints: [] }, {
    codexCommand: [process.execPath, noResultFixture]
  });
  let noResult;
  for (let index = 0; index < 100; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 30));
    noResult = pollRunWorkers(root, "run-no-result")[0];
    if (noResult && !["running", "dispatching"].includes(noResult.status)) {
      break;
    }
  }
  assert.equal(noResult.status, "failed");
  assert.equal(
    loadRun(root, "run-no-result").tasks.build.attempts.at(-1).outcome.terminalOutcome,
    "contract_failed"
  );

  plan(root, "run-process-fail");
  checkpointPlan(root, "run-process-fail");
  launchTaskWorker(root, "run-process-fail", "build", { constraints: [] }, {
    codexCommand: [process.execPath, failedFixture]
  });
  let processFailure;
  for (let index = 0; index < 100; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 30));
    processFailure = pollRunWorkers(root, "run-process-fail")[0];
    if (processFailure && !["running", "dispatching"].includes(processFailure.status)) {
      break;
    }
  }
  assert.equal(processFailure.status, "failed");
  assert.equal(
    loadRun(root, "run-process-fail").tasks.build.attempts.at(-1).outcome.terminalOutcome,
    "execution_failed"
  );
});

test("the pool runs independent ready tasks in separate detached worktrees", async () => {
  const root = repo();
  createRun(root, {
    id: "run-pool-e2e",
    lane: "api",
    objective: "Inspect in parallel",
    maxWorkers: 2,
    workerModel: "sol",
    reasoningEffort: "high"
  });
  replacePlan(root, "run-pool-e2e", [
    { id: "inspect-a", title: "Inspect A", objective: "Inspect A", kind: "read" },
    { id: "inspect-b", title: "Inspect B", objective: "Inspect B", kind: "read" }
  ]);
  checkpointPlan(root, "run-pool-e2e");
  const first = launchTaskWorker(root, "run-pool-e2e", "inspect-a", { constraints: [] }, {
    codexCommand: [process.execPath, fixture]
  });
  checkpointPlan(root, "run-pool-e2e");
  const second = launchTaskWorker(root, "run-pool-e2e", "inspect-b", { constraints: [] }, {
    codexCommand: [process.execPath, fixture]
  });
  assert.notEqual(first.runner.pid, second.runner.pid);
  assert.notEqual(first.worktree.path, second.worktree.path);

  for (let index = 0; index < 100; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    pollRunWorkers(root, "run-pool-e2e");
    const statuses = Object.values(loadRun(root, "run-pool-e2e").tasks)
      .map((task) => task.status);
    if (statuses.every((status) => status === "reported")) {
      break;
    }
  }
  let run = loadRun(root, "run-pool-e2e");
  assert.deepEqual(
    Object.values(run.tasks).map((task) => task.status),
    ["reported", "reported"]
  );
  for (const task of Object.values(run.tasks)) {
    assert.equal(task.result.structured.summary, "Fake worker completed.");
    verifyTask(root, "run-pool-e2e", task.id, {
      verdict: "pass",
      evidence: [`${task.id} evidence reviewed`]
    });
  }
  run = loadRun(root, "run-pool-e2e");
  assert.equal(run.status, "finalizing");
  for (const task of Object.values(run.tasks)) {
    assert.equal(cleanupTaskWorktree(root, task.attempts.at(-1)), true);
  }
});

test("a detached write worker completes the full launch, inspect, integrate, finalize, and cleanup lifecycle", async () => {
  const root = repo();
  plan(root, "run-e2e");
  checkpointPlan(root, "run-e2e");
  const launched = launchTaskWorker(root, "run-e2e", "build", { constraints: [] }, {
    codexCommand: [process.execPath, writeFixture]
  });

  let update;
  for (let index = 0; index < 100; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    update = pollRunWorkers(root, "run-e2e")[0];
    if (update && !["running", "dispatching"].includes(update.status)) {
      break;
    }
  }
  assert.equal(update.status, "reported");
  assert.equal(update.threadId, "thread-fake-write");

  let run = loadRun(root, "run-e2e");
  let task = run.tasks.build;
  const attempt = task.attempts.at(-1);
  const inspection = inspectTaskWorktree(task, attempt);
  assert.equal(inspection.ready, true);
  assert.deepEqual(inspection.files, ["src/generated.js"]);

  const integrated = integrateTaskWorktree(root, run, task, attempt);
  const recorded = recordIntegration(root, "run-e2e", "build", {
    evidence: ["worker check passed", "scope and declaration inspection passed"],
    ...integrated
  });
  assert.equal(recorded.runStatus, "finalizing");
  assert.equal(recorded.task.attempts.at(-1).outcome.terminalOutcome, "accepted");
  assert.equal(
    fs.readFileSync(path.join(root, "src", "generated.js"), "utf8"),
    "export const generated = true;\n"
  );

  run = finalizeRun(root, "run-e2e", {
    verdict: "pass",
    summary: "The write-worker lifecycle completed.",
    evidence: ["generated module present after integration"]
  });
  assert.equal(run.status, "completed");
  assert.equal(cleanupTaskWorktree(root, attempt), true);
  assert.equal(fs.existsSync(launched.worktree.path), false);
});

test("detached workers can be stopped without losing their durable handle", async () => {
  const root = repo();
  plan(root, "run-stop");
  checkpointPlan(root, "run-stop");
  launchTaskWorker(root, "run-stop", "build", { constraints: [] }, {
    codexCommand: [process.execPath, slowFixture]
  });
  let attempt;
  for (let index = 0; index < 50; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    attempt = loadRun(root, "run-stop").tasks.build.attempts.at(-1);
    if (fs.existsSync(attempt.runner.statusFile)) {
      break;
    }
  }
  assert.equal(stopTaskWorker(attempt), true);
  const status = JSON.parse(fs.readFileSync(attempt.runner.statusFile, "utf8"));
  assert.equal(status.status, "cancelled");
  assert.equal(status.pid, attempt.runner.pid);
  const update = pollRunWorkers(root, "run-stop")[0];
  assert.equal(update.status, "cancelled");
  const cancelled = loadRun(root, "run-stop").tasks.build.attempts.at(-1);
  assert.equal(cancelled.outcome.terminalOutcome, "cancelled");
});

test("the worker result schema satisfies structured-output requirements", () => {
  // OpenAI structured outputs reject any object schema whose `required` array
  // omits a declared property key. A worker that fails this check exits before
  // reading its briefing, so every run launch breaks identically.
  const visit = (schema, pointer) => {
    if (!schema || typeof schema !== "object") {
      return;
    }
    if (schema.type === "object" || schema.properties) {
      const declared = Object.keys(schema.properties ?? {});
      const required = schema.required ?? [];
      assert.deepEqual(
        declared.filter((key) => !required.includes(key)),
        [],
        `${pointer} declares properties missing from required`
      );
      assert.equal(
        schema.additionalProperties,
        false,
        `${pointer} must set additionalProperties to false`
      );
      for (const [key, child] of Object.entries(schema.properties ?? {})) {
        visit(child, `${pointer}/${key}`);
      }
    }
    if (schema.items) {
      visit(schema.items, `${pointer}/items`);
    }
  };
  visit(WORKER_RESULT_SCHEMA, "#");
});

test("an optional worker field stays expressible as null", () => {
  const blockerCode = WORKER_RESULT_SCHEMA.properties.blocker_code;
  assert.ok(
    blockerCode.type.includes("null"),
    "blocker_code must accept null so a successful worker is not forced to invent a blocker"
  );
  assert.ok(blockerCode.enum.includes(null));
  assert.ok(blockerCode.enum.includes("missing_context"));
});

test("a worker request is a nullable, strict nested object", () => {
  const request = WORKER_RESULT_SCHEMA.properties.needs_input;
  assert.ok(WORKER_RESULT_SCHEMA.required.includes("needs_input"));
  assert.deepEqual(request.type, ["object", "null"]);
  assert.deepEqual(request.properties.kind.enum, ["scope_extension", "question"]);
  assert.deepEqual(request.required, ["kind", "paths", "reason", "question", "options"]);
  assert.equal(request.additionalProperties, false);
  assert.ok(request.properties.question.type.includes("null"));
});

test("an API rejection reported on stdout is surfaced as the failure reason", async () => {
  // Codex writes API-level rejections to the event stream, not stderr. Without
  // reading it back the supervisor records only "Codex exited 1" and the real
  // cause has to be dug out of events.jsonl by hand.
  const root = makeRepo();
  after(() => cleanup(root));
  const apiErrorFixture = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "fixtures",
    "fake-codex-api-error.mjs"
  );
  plan(root, "run-api-error");
  checkpointPlan(root, "run-api-error");
  launchTaskWorker(root, "run-api-error", "build", { constraints: [] }, {
    codexCommand: [process.execPath, apiErrorFixture]
  });
  let update;
  for (let index = 0; index < 100; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 30));
    update = pollRunWorkers(root, "run-api-error")[0];
    if (update && !["running", "dispatching"].includes(update.status)) {
      break;
    }
  }
  assert.equal(update.status, "failed");
  assert.match(update.error, /Invalid schema for response_format/);
  assert.doesNotMatch(update.error, /^Codex exited/);
});

const unavailableFixture = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "fake-codex-model-unavailable.mjs"
);

async function pollUntil(root, runId, done, attempts = 150) {
  const seen = [];
  for (let index = 0; index < attempts; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 30));
    seen.push(...pollRunWorkers(root, runId));
    if (done(loadRun(root, runId))) {
      return seen;
    }
  }
  throw new Error(`Run ${runId} did not settle: ${JSON.stringify(seen)}`);
}

function runEvents(root, runId) {
  return fs.readFileSync(eventsFile(root, runId), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

test("model unavailability is read only from top-level rejections that name the slug", () => {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "orch-events-"));
  after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "events.jsonl");
  const writeEvents = (events) =>
    fs.writeFileSync(file, events.map((event) => JSON.stringify(event)).join("\n"));

  writeEvents([
    { type: "thread.started", thread_id: "t" },
    {
      type: "item.completed",
      item: { type: "error", message: "Model metadata for `gpt-6-astra` not found. Defaulting to fallback metadata." }
    }
  ]);
  assert.equal(modelUnavailableError(file, "gpt-6-astra"), null);

  writeEvents([{ type: "error", message: "The 'gpt-6-astra' model is not supported when using Codex with a ChatGPT account." }]);
  assert.match(modelUnavailableError(file, "gpt-6-astra"), /not supported/);
  assert.equal(modelUnavailableError(file, "gpt-6.1-sol"), null);

  writeEvents([{ type: "error", error: { message: "Invalid schema for response_format 'codex_output_schema'." } }]);
  assert.equal(modelUnavailableError(file, "gpt-6-astra"), null);

  writeEvents([{ type: "turn.failed", error: { code: "model_not_found", message: "The model `gpt-6-astra` does not exist or you do not have access to it." } }]);
  assert.match(modelUnavailableError(file, "gpt-6-astra"), /do not have access/);

  // After the worker has done anything, an error naming the model is a mid-run
  // failure, not a launch rejection.
  writeEvents([
    { type: "thread.started", thread_id: "t" },
    { type: "turn.started" },
    { type: "item.completed", item: { type: "command_execution", command: "git commit -m work" } },
    { type: "error", message: "The model gpt-6-astra is currently unavailable. Please try again later." },
    { type: "turn.failed", error: { message: "The model gpt-6-astra is currently unavailable." } }
  ]);
  assert.equal(modelUnavailableError(file, "gpt-6-astra"), null);
  writeEvents([
    { type: "turn.completed" },
    { type: "error", message: "The 'gpt-6-astra' model is not supported when using Codex with a ChatGPT account." }
  ]);
  assert.equal(modelUnavailableError(file, "gpt-6-astra"), null);

  // An outage before any work is still not an entitlement rejection.
  for (const message of [
    "The model gpt-6-astra is currently unavailable. Please try again later.",
    "gpt-6-astra model is temporarily unavailable (503).",
    "The model gpt-6-astra is overloaded; not available right now due to capacity."
  ]) {
    writeEvents([{ type: "thread.started", thread_id: "t" }, { type: "turn.started" }, { type: "error", message }]);
    assert.equal(modelUnavailableError(file, "gpt-6-astra"), null, message);
  }
  // Entitlement wording that happens to say "currently" is still a rejection.
  writeEvents([{ type: "error", message: "The model gpt-6-astra is currently not supported on your plan." }]);
  assert.match(modelUnavailableError(file, "gpt-6-astra"), /not supported on your plan/);
});

test("an unavailable supervisor-routed model is substituted down the ladder and recorded", async () => {
  const root = repo();
  plan(root, "run-substitute", { taskModel: "astra", taskEffort: "xhigh" });
  checkpointPlan(root, "run-substitute");
  const launched = launchTaskWorker(root, "run-substitute", "build", { constraints: [] }, {
    codexCommand: [process.execPath, unavailableFixture, "--unavailable=gpt-6-astra"]
  });
  assert.equal(launched.model, "gpt-6-astra");

  const updates = await pollUntil(
    root,
    "run-substitute",
    (run) => run.tasks.build.status === "reported"
  );
  const substituted = updates.find((update) => update.status === "substituted");
  assert.equal(substituted.unavailableModel, "gpt-6-astra");
  assert.equal(substituted.requestedModel, "gpt-6-astra");
  assert.equal(substituted.model, "gpt-6.1-sol");
  assert.equal(substituted.reasoningEffort, "xhigh");
  assert.equal(substituted.pinned, false);
  assert.match(substituted.notice, /^Model substituted: the supervisor routed gpt-6-astra/);

  const run = loadRun(root, "run-substitute");
  assert.equal(run.tasks.build.model, "gpt-6-astra", "the saved route is never rewritten");
  const [rejected, replacement] = run.tasks.build.attempts;
  assert.equal(rejected.model, "gpt-6-astra");
  assert.deepEqual(
    [rejected.outcome.terminalOutcome, rejected.outcome.action, rejected.outcome.reasonCode],
    ["execution_failed", "execute", "model_unavailable"]
  );
  assert.equal(replacement.model, "gpt-6.1-sol");
  assert.equal(replacement.requestedModel, "gpt-6-astra");
  assert.equal(replacement.reasoningEffort, "xhigh");
  assert.equal(replacement.substitution.pinned, false);
  assert.equal(run.tasks.build.result.structured.summary, "Fake worker completed on gpt-6.1-sol.");
  assert.deepEqual(run.unavailableModels.map((entry) => entry.model), ["gpt-6-astra"]);
  const spec = JSON.parse(fs.readFileSync(replacement.runner.specFile, "utf8"));
  assert.equal(spec.model, "gpt-6.1-sol");

  const types = runEvents(root, "run-substitute").map((event) => event.type);
  assert.ok(types.includes("task.model_unavailable"));
  assert.ok(types.includes("task.model_substituted"));

  const briefing = renderSupervisorBriefing(root, run, { constraints: [] });
  assert.match(briefing, /worker route: gpt-6\.1-sol \(xhigh\) — SUBSTITUTED for gpt-6-astra/);
  assert.match(briefing, /unavailable: gpt-6-astra/);
  assert.doesNotMatch(briefing, /Tell the user which model actually ran/);
  const resumed = runCli(root, ["run", "resume", "run-substitute"]);
  assert.equal(resumed.code, 0);
  assert.match(resumed.stdout, /Model substituted: the supervisor routed gpt-6-astra/);
});

test("a user-pinned model is substituted too, but flagged prominently", async () => {
  const root = repo();
  createRun(root, {
    id: "run-pinned-substitute",
    lane: "api",
    objective: "Pinned astra",
    maxWorkers: 2,
    workerModel: "astra",
    reasoningEffort: "high"
  });
  replacePlan(root, "run-pinned-substitute", [
    { id: "first", title: "First", objective: "Inspect one", kind: "read" },
    { id: "second", title: "Second", objective: "Inspect two", kind: "read" }
  ]);
  checkpointPlan(root, "run-pinned-substitute");
  const codexCommand = [process.execPath, unavailableFixture, "--unavailable=gpt-6-astra,gpt-6.1-sol"];
  launchTaskWorker(root, "run-pinned-substitute", "first", { constraints: [] }, { codexCommand });
  await pollUntil(
    root,
    "run-pinned-substitute",
    (run) => run.tasks.first.status === "reported"
  );
  let run = loadRun(root, "run-pinned-substitute");
  assert.deepEqual(
    run.tasks.first.attempts.map((attempt) => attempt.model),
    ["gpt-6-astra", "gpt-6.1-sol", "gpt-6.1-terra"]
  );
  const final = run.tasks.first.attempts.at(-1);
  assert.equal(final.requestedModel, "gpt-6-astra");
  assert.equal(final.substitution.pinned, true);
  assert.deepEqual(final.substitution.unavailableModels, ["gpt-6-astra", "gpt-6.1-sol"]);

  // Later launches in the same run go straight to the substitute without
  // burning another rejected attempt, and still record the substitution.
  const second = launchTaskWorker(root, "run-pinned-substitute", "second", { constraints: [] }, {
    codexCommand
  });
  assert.equal(second.model, "gpt-6.1-terra");
  assert.equal(second.substitution.pinned, true);
  assert.match(second.briefing, /You are one gpt-6\.1-terra worker/);
  await pollUntil(
    root,
    "run-pinned-substitute",
    (current) => current.tasks.second.status === "reported"
  );
  run = loadRun(root, "run-pinned-substitute");
  assert.equal(run.tasks.second.attempts.length, 1);

  const briefing = renderSupervisorBriefing(root, run, { constraints: [] });
  assert.match(briefing, /A user-pinned model was substituted\. Tell the user/);
  assert.match(briefing, /USER-PINNED MODEL SUBSTITUTED: the run pinned gpt-6-astra/);
  assert.match(briefing, /SUBSTITUTED for gpt-6-astra \(user pin overridden\)/);
});

test("an unavailable model with no rung left fails the task for escalation", async () => {
  const root = repo();
  plan(root, "run-ladder-end", { workerModel: "luna" });
  checkpointPlan(root, "run-ladder-end");
  launchTaskWorker(root, "run-ladder-end", "build", { constraints: [] }, {
    codexCommand: [process.execPath, unavailableFixture, "--unavailable=gpt-5.6-luna"]
  });
  const updates = await pollUntil(
    root,
    "run-ladder-end",
    (run) => run.tasks.build.status === "failed"
  );
  assert.equal(updates.at(-1).fallbackModel, null);
  const task = loadRun(root, "run-ladder-end").tasks.build;
  assert.equal(task.attempts.length, 1);
  assert.deepEqual(
    [task.attempts[0].outcome.terminalOutcome, task.attempts[0].outcome.action, task.attempts[0].outcome.reasonCode],
    ["execution_failed", "escalate", "model_unavailable"]
  );
  assert.match(task.result.summary, /No model remains on the fallback ladder below gpt-5\.6-luna/);
});

test("a fallback never lands a task others depend on on luna", async () => {
  const root = repo();
  createRun(root, { id: "run-luna-leaf", lane: "api", objective: "Build safely" });
  const routed = (id, extra = {}) => ({
    id,
    title: id,
    objective: `Do ${id}`,
    scope: [`src/${id}/**`],
    acceptance: ["tests pass"],
    model: "terra",
    effort: "high",
    routingReason: "The supervisor selected this route for the bounded task.",
    ...extra
  });
  replacePlan(root, "run-luna-leaf", [routed("base"), routed("leaf"), routed("next", { dependsOn: ["base"] })]);
  checkpointPlan(root, "run-luna-leaf");
  const command = [process.execPath, unavailableFixture, "--unavailable=gpt-6.1-terra"];
  launchTaskWorker(root, "run-luna-leaf", "base", { constraints: [] }, { codexCommand: command });
  await pollUntil(root, "run-luna-leaf", (run) => run.tasks.base.status !== "running");
  let run = loadRun(root, "run-luna-leaf");
  assert.equal(run.tasks.base.status, "failed");
  assert.equal(run.tasks.base.attempts.length, 1);
  assert.equal(run.tasks.base.attempts[0].modelUnavailable.fallbackModel, null);
  assert.match(run.tasks.base.result.summary, /luna is not used for a task others depend on/);

  // A leaf still falls back to luna.
  const leaf = launchTaskWorker(root, "run-luna-leaf", "leaf", { constraints: [] }, { codexCommand: command });
  assert.equal(leaf.model, "gpt-5.6-luna");
  assert.equal(leaf.substitution.requestedModel, "gpt-6.1-terra");
});

test("a poll reloads the run only for tasks that are active", () => {
  const root = repo();
  createRun(root, { id: "run-poll-loads", lane: "api", objective: "Build safely", workerModel: "sol", reasoningEffort: "high" });
  replacePlan(root, "run-poll-loads", ["a", "b", "c", "d", "e"].map((id) => ({
    id, title: id, objective: id, kind: "read", acceptance: ["ok"]
  })));
  const file = runFile(root, "run-poll-loads");
  const original = fs.readFileSync;
  let loads = 0;
  fs.readFileSync = function (target, ...rest) {
    if (String(target) === file) {
      loads += 1;
    }
    return original.call(this, target, ...rest);
  };
  try {
    assert.deepEqual(pollRunWorkers(root, "run-poll-loads"), []);
  } finally {
    fs.readFileSync = original;
  }
  assert.equal(loads, 1);
});
