import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { after, test } from "node:test";

import { updateLocalState } from "../plugins/orchestrator/scripts/lib/state.mjs";
import { CLI, cleanup, git, makeRepo, runCli, write, writeResult } from "./helpers.mjs";

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

test("init creates the state layout and self-ignores local state", () => {
  const root = repo();
  assert.ok(fs.existsSync(path.join(root, ".orchestrator", "lanes.json")));
  assert.ok(fs.existsSync(path.join(root, ".orchestrator", "ledger.md")));
  assert.ok(fs.existsSync(path.join(root, ".orchestrator", "local", "threads.json")));

  const ignore = fs.readFileSync(path.join(root, ".orchestrator", ".gitignore"), "utf8");
  assert.match(ignore, /local\//);

  // The committed half is tracked; the machine-local half is not.
  git(root, ["add", "-A"]);
  const staged = git(root, ["diff", "--cached", "--name-only"]);
  assert.match(staged, /\.orchestrator\/lanes\.json/);
  assert.match(staged, /\.orchestrator\/ledger\.md/);
  assert.doesNotMatch(staged, /threads\.json/);
});

test("init is idempotent and does not clobber existing state", () => {
  const root = repo();
  runCli(root, ["lane", "add", "api", "--scope", "src/api/**"]);
  runCli(root, ["init"]);
  const lanes = JSON.parse(fs.readFileSync(path.join(root, ".orchestrator", "lanes.json"), "utf8"));
  assert.ok(lanes.lanes.api);
});

test("lanes round-trip through the CLI", () => {
  const root = repo();
  runCli(root, [
    "lane",
    "add",
    "api",
    "--description",
    "HTTP layer",
    "--scope",
    "src/api/**",
    "--constraint",
    "No new dependencies",
    "--done",
    "tests pass"
  ]);

  const shown = JSON.parse(runCli(root, ["lane", "show", "api", "--json"]).stdout);
  assert.equal(shown.description, "HTTP layer");
  assert.deepEqual(shown.scope, ["src/api/**"]);
  assert.deepEqual(shown.constraints, ["No new dependencies"]);
  assert.equal(Object.hasOwn(shown, "threadId"), false);
});

test("free-text and glob options keep their commas", () => {
  const root = repo();
  runCli(root, [
    "lane", "add", "api",
    "--scope", "src/{a,b}.mjs",
    "--scope", "test/**",
    "--constraint", "No dependencies, no network"
  ]);
  const lane = JSON.parse(runCli(root, ["lane", "show", "api", "--json"]).stdout);
  assert.deepEqual(lane.scope, ["src/{a,b}.mjs", "test/**"]);
  assert.deepEqual(lane.constraints, ["No dependencies, no network"]);

  runCli(root, [
    "run", "create", "api", "--id", "run-commas", "--objective", "Keep commas",
    "--model", "sol", "--effort", "high"
  ]);
  const planPath = writeResult(JSON.stringify({
    tasks: [{ id: "review", title: "Review", objective: "Review request", kind: "read", acceptance: ["Report findings with evidence"] }]
  }));
  runCli(root, ["run", "plan", "run-commas", "--plan-file", planPath]);
  const checkpoint = JSON.parse(runCli(root, [
    "run", "checkpoint", "run-commas", "--summary", "Ready, with commas",
    "--decision", "Keep a, b, and c together",
    "--decision", "Second decision",
    "--risk", "f(x, y) may change",
    "--next", "Launch, then wait",
    "--json"
  ]).stdout);
  assert.deepEqual(checkpoint.decisions, ["Keep a, b, and c together", "Second decision"]);
  assert.deepEqual(checkpoint.risks, ["f(x, y) may change"]);
  assert.deepEqual(checkpoint.next, ["Launch, then wait"]);

  const dispatch = JSON.parse(runCli(root, ["run", "claim", "run-commas", "review", "--json"]).stdout);
  const resultPath = writeResult(
    "Reviewed.\n\n## RESULT\nfiles_touched: none\ndecisions: none\nassumptions: none\nblockers: none\nconfidence: high\n"
  );
  runCli(root, [
    "run", "report", "run-commas", "review", "--attempt", dispatch.attemptId, "--result-file", resultPath
  ]);
  const verified = JSON.parse(runCli(root, [
    "run", "verify", "run-commas", "review", "--verdict", "fail",
    "--evidence", "wordWrap('a b', 9) returned 'a\\nb', expected 'a b'",
    "--json"
  ]).stdout);
  assert.deepEqual(verified.task.verification.evidence, ["wordWrap('a b', 9) returned 'a\\nb', expected 'a b'"]);
});

test("an unknown lane is an error that lists the known ones", () => {
  const root = repo();
  runCli(root, ["lane", "add", "api", "--scope", "src/**"]);
  const result = runCli(root, ["lane", "show", "nope"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Unknown lane "nope"/);
  assert.match(result.stderr, /Known lanes: api/);
});

test("invalid lane names are rejected", () => {
  const root = repo();
  const result = runCli(root, ["lane", "add", "Not A Lane"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Invalid lane name/);
});

test("removing a lane also drops a thread binding left by an older release", () => {
  const root = repo();
  runCli(root, ["lane", "add", "api", "--scope", "src/**"]);
  updateLocalState(root, (local) => {
    local.threads.api = { threadId: "thread-abc123", updatedAt: "2026-01-01T00:00:00.000Z" };
  });
  runCli(root, ["lane", "remove", "api"]);

  const local = JSON.parse(fs.readFileSync(path.join(root, ".orchestrator", "local", "threads.json"), "utf8"));
  assert.equal(local.threads.api, undefined);
});

test("ledger entries are dated, sectioned, and reach the run briefing", () => {
  const root = repo();
  runCli(root, ["lane", "add", "api", "--scope", "src/**"]);
  runCli(root, ["ledger", "add", "decisions", "Errors are returned, never thrown."]);
  runCli(root, ["ledger", "add", "failed approaches", "Retrying on 4xx made it worse."]);

  const ledger = runCli(root, ["ledger", "show"]).stdout;
  assert.match(ledger, /## Decisions\n\n- \(\d{4}-\d{2}-\d{2}\) Errors are returned, never thrown\./);
  assert.match(ledger, /## Failed approaches\n\n- \(\d{4}-\d{2}-\d{2}\) Retrying on 4xx made it worse\./);

  runCli(root, [
    "run", "create", "api", "--id", "run-ledger", "--objective", "x",
    "--model", "sol", "--effort", "high"
  ]);
  const briefing = runCli(root, ["run", "briefing", "run-ledger"]).stdout;
  assert.match(briefing, /Errors are returned, never thrown\./);
  assert.match(briefing, /Retrying on 4xx made it worse\./);
});

test("an unknown ledger section is rejected with the valid ones", () => {
  const root = repo();
  const result = runCli(root, ["ledger", "add", "musings", "something"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Unknown ledger section/);
});

test("commands refuse to run before init", () => {
  const root = makeRepo();
  repos.push(root);
  const result = runCli(root, ["run", "list"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /not initialized/);
});

test("lane commands refuse to create a partially initialized workspace", () => {
  const root = makeRepo();
  repos.push(root);
  const result = runCli(root, ["lane", "add", "api", "--scope", "src/**"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /not initialized/);
  assert.equal(fs.existsSync(path.join(root, ".orchestrator")), false);
});

test("unknown options are rejected instead of silently weakening a lane", () => {
  const root = repo();
  const result = runCli(root, ["lane", "add", "api", "--scoop", "src/**"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Unknown option --scoop/);
});

test("concurrent lane additions do not lose state", async () => {
  const root = repo();
  const names = Array.from({ length: 8 }, (_, index) => `lane-${index}`);
  await Promise.all(
    names.map(
      (name) =>
        new Promise((resolve, reject) => {
          const child = spawn(process.execPath, [CLI, "lane", "add", name, "--scope", `${name}/**`], {
            cwd: root,
            stdio: ["ignore", "pipe", "pipe"]
          });
          let stderr = "";
          child.stderr.setEncoding("utf8");
          child.stderr.on("data", (chunk) => {
            stderr += chunk;
          });
          child.on("error", reject);
          child.on("exit", (code) => {
            if (code === 0) {
              resolve();
            } else {
              reject(new Error(`lane add exited ${code}: ${stderr}`));
            }
          });
        })
    )
  );
  const lanes = JSON.parse(runCli(root, ["lane", "list", "--json"]).stdout);
  assert.deepEqual(lanes.map((lane) => lane.name), names);
});

test("state written by a newer version is refused rather than misread", () => {
  const root = repo();
  fs.writeFileSync(
    path.join(root, ".orchestrator", "lanes.json"),
    JSON.stringify({ version: 99, lanes: {} }),
    "utf8"
  );
  const result = runCli(root, ["lane", "list"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /newer orchestrator/);
});

test("run commands persist a plan, ready queue, checkpoint, and restart briefing", () => {
  const root = repo();
  runCli(root, [
    "lane",
    "add",
    "api",
    "--scope",
    "src/api/**",
    "--constraint",
    "No new dependencies",
    "--done",
    "tests pass"
  ]);
  const created = JSON.parse(
    runCli(root, [
      "run",
      "create",
      "api",
      "--id",
      "run-cli",
      "--objective",
      "Add cursor pagination",
      "--max-workers",
      "4",
      "--json"
    ]).stdout
  );
  assert.equal(created.workerPolicy.routingMode, "auto");
  assert.equal(created.workerPolicy.model, null);
  assert.equal(created.workerPolicy.reasoningEffort, null);
  assert.equal(created.workerPolicy.maxWorkers, 4);

  const pinned = JSON.parse(
    runCli(root, [
      "run",
      "create",
      "api",
      "--id",
      "run-cli-pinned",
      "--objective",
      "Honor an explicit route",
      "--model",
      "terra",
      "--effort",
      "high",
      "--json"
    ]).stdout
  );
  assert.equal(pinned.workerPolicy.routingMode, "pinned");
  assert.equal(pinned.workerPolicy.model, "gpt-6.1-terra");
  assert.equal(pinned.workerPolicy.reasoningEffort, "high");
  const conflictingPlan = writeResult(
    JSON.stringify({
      tasks: [
        {
          id: "conflict",
          title: "Conflicting task",
          objective: "Try to override the run pin",
          scope: ["src/api/**"],
          model: "sol"
        }
      ]
    })
  );
  const rejectedPin = runCli(root, [
    "run",
    "plan",
    "run-cli-pinned",
    "--plan-file",
    conflictingPlan
  ]);
  assert.equal(rejectedPin.code, 1);
  assert.match(rejectedPin.stderr, /run explicitly pins gpt-6\.1-terra/);

  const planPath = writeResult(
    JSON.stringify({
      tasks: [
        {
          id: "implementation",
          title: "Implement",
          objective: "Add the cursor logic",
          acceptance: ["targeted tests pass"],
          model: "terra",
          effort: "low",
          routingReason: "The implementation is a bounded everyday change."
        },
        {
          id: "review",
          title: "Review",
          objective: "Review the implementation",
          kind: "verify",
          dependsOn: ["implementation"],
          acceptance: ["no P1 findings"],
          model: "astra",
          effort: "high",
          routingReason: "Independent review of sol-or-below work runs on astra."
        }
      ]
    })
  );
  const planned = runCli(root, [
    "run",
    "plan",
    "run-cli",
    "--plan-file",
    planPath,
    "--json"
  ]);
  assert.equal(planned.code, 0);
  assert.equal(JSON.parse(planned.stdout).planRevision, 1);

  const ready = JSON.parse(runCli(root, ["run", "ready", "run-cli", "--json"]).stdout);
  assert.deepEqual(ready.tasks.map((task) => task.id), ["implementation"]);
  assert.equal(ready.checkpoint.current, false);
  assert.equal(ready.checkpoint.stale, true);
  assert.match(ready.checkpoint.reason, /no checkpoint has been recorded/);

  const checkpoint = runCli(root, [
    "run",
    "checkpoint",
    "run-cli",
    "--summary",
    "Plan approved",
    "--decision",
    "Keep cursors opaque",
    "--next",
    "Dispatch implementation"
  ]);
  assert.equal(checkpoint.code, 0);

  const readyAfter = JSON.parse(runCli(root, ["run", "ready", "run-cli", "--json"]).stdout);
  assert.equal(readyAfter.checkpoint.current, true);
  assert.equal(readyAfter.checkpoint.stale, false);

  const briefing = runCli(root, ["run", "briefing", "run-cli"]).stdout;
  assert.match(briefing, /you are the supervisor/);
  assert.match(briefing, /Plan approved/);
  assert.match(briefing, /implementation — Implement/);
  assert.match(briefing, /No new dependencies/);

  const dispatch = JSON.parse(
    runCli(root, ["run", "claim", "run-cli", "implementation", "--json"]).stdout
  );
  assert.equal(dispatch.model, "gpt-6.1-terra");
  assert.equal(dispatch.reasoningEffort, "low");
  assert.deepEqual(dispatch.routingFlags.slice(0, 3), [
    "--fresh",
    "--model",
    "gpt-6.1-terra"
  ]);
  const bound = runCli(root, [
    "run",
    "bind",
    "run-cli",
    "implementation",
    "--attempt",
    dispatch.attemptId,
    "--agent-id",
    "agent-cli",
    "--job-id",
    "job-cli",
    "--thread-id",
    "thread-cli"
  ]);
  assert.equal(bound.code, 0);

  const active = JSON.parse(
    runCli(root, ["run", "recover", "run-cli", "--json"]).stdout
  );
  assert.equal(active[0].jobId, "job-cli");
  assert.equal(active[0].model, "gpt-6.1-terra");
  assert.equal(active[0].reasoningEffort, "low");
  assert.match(active[0].routingReason, /bounded everyday change/);
  const resumed = JSON.parse(
    runCli(root, ["run", "resume", "run-cli", "--json"]).stdout
  );
  assert.equal(resumed.recovery[0].threadId, "thread-cli");
  assert.match(resumed.briefing, /latest worker: thread thread-cli/);

  const resultPath = writeResult(
    "Implemented pagination.\n\n## RESULT\nfiles_touched: src/api/users.js\ndecisions: none\nassumptions: none\nblockers: none\nconfidence: high\n"
  );
  const reported = JSON.parse(
    runCli(root, [
      "run",
      "report",
      "run-cli",
      "implementation",
      "--attempt",
      dispatch.attemptId,
      "--result-file",
      resultPath,
      "--json"
    ]).stdout
  );
  assert.equal(reported.task.status, "reported");

  const verified = JSON.parse(
    runCli(root, [
      "run",
      "verify",
      "run-cli",
      "implementation",
      "--verdict",
      "pass",
      "--evidence",
      "targeted tests passed",
      "--json"
    ]).stdout
  );
  assert.equal(verified.task.status, "completed");
  assert.equal(
    verified.task.attempts.at(-1).outcome.terminalOutcome,
    "accepted"
  );
  assert.deepEqual(verified.ready.map((task) => task.id), ["review"]);

  const reviewDispatch = JSON.parse(
    runCli(root, ["run", "claim", "run-cli", "review", "--json"]).stdout
  );
  const reviewResult = writeResult(
    "Reviewed the implementation.\n\n## RESULT\nfiles_touched: none\ndecisions: none\nassumptions: none\nblockers: none\nconfidence: high\n"
  );
  runCli(root, [
    "run",
    "report",
    "run-cli",
    "review",
    "--attempt",
    reviewDispatch.attemptId,
    "--result-file",
    reviewResult
  ]);
  const reviewVerified = JSON.parse(
    runCli(root, [
      "run",
      "verify",
      "run-cli",
      "review",
      "--verdict",
      "pass",
      "--evidence",
      "review passed",
      "--json"
    ]).stdout
  );
  assert.equal(reviewVerified.runStatus, "finalizing");

  const finalized = JSON.parse(
    runCli(root, [
      "run",
      "finalize",
      "run-cli",
      "--verdict",
      "pass",
      "--summary",
      "Combined checks passed.",
      "--evidence",
      "node --test passed",
      "--json"
    ]).stdout
  );
  assert.equal(finalized.status, "completed");
  assert.equal(finalized.finalization.summary, "Combined checks passed.");
});

test("the run CLI records explicit policy and authority dispositions", () => {
  const root = repo();
  runCli(root, ["lane", "add", "ops"]);
  runCli(root, [
    "run", "create", "ops", "--id", "run-decide", "--objective", "Respect policy",
    "--model", "sol", "--effort", "high"
  ]);
  const planPath = writeResult(JSON.stringify({
    tasks: [{ id: "review", title: "Review", objective: "Review request", kind: "read", acceptance: ["Report findings with evidence"] }]
  }));
  runCli(root, ["run", "plan", "run-decide", "--plan-file", planPath]);
  runCli(root, ["run", "checkpoint", "run-decide", "--summary", "Ready"]);
  const dispatch = JSON.parse(
    runCli(root, ["run", "claim", "run-decide", "review", "--json"]).stdout
  );
  const resultPath = writeResult(
    "Reviewed.\n\n## RESULT\nfiles_touched: none\ndecisions: none\nassumptions: none\nblockers: none\nconfidence: high\n"
  );
  runCli(root, [
    "run", "report", "run-decide", "review", "--attempt", dispatch.attemptId,
    "--result-file", resultPath
  ]);
  const decided = JSON.parse(runCli(root, [
    "run", "decide", "run-decide", "review",
    "--outcome", "policy_refused",
    "--action", "refuse",
    "--reason-code", "policy_boundary",
    "--evidence", "policy applies",
    "--json"
  ]).stdout);
  assert.equal(decided.task.status, "blocked");
  assert.equal(decided.task.attempts.at(-1).outcome.terminalOutcome, "policy_refused");
  assert.equal(decided.task.attempts.at(-1).outcome.provenance, "supervisor");
});

test("the run CLI rejects premature integration and records typed worktree failures", () => {
  const root = repo();
  runCli(root, ["lane", "add", "ops"]);
  runCli(root, [
    "run", "create", "ops", "--id", "run-integrate-guard",
    "--objective", "Guard integration", "--model", "sol", "--effort", "high"
  ]);
  const planPath = writeResult(JSON.stringify({
    tasks: [{ id: "review", title: "Review", objective: "Review request", kind: "read", acceptance: ["Report findings with evidence"] }]
  }));
  runCli(root, ["run", "plan", "run-integrate-guard", "--plan-file", planPath]);

  const premature = runCli(root, ["run", "integrate", "run-integrate-guard", "review"]);
  assert.equal(premature.code, 1);
  assert.match(premature.stderr, /cannot be integrated from status "pending"/);

  runCli(root, ["run", "checkpoint", "run-integrate-guard", "--summary", "Ready"]);
  const dispatch = JSON.parse(
    runCli(root, ["run", "claim", "run-integrate-guard", "review", "--json"]).stdout
  );
  const resultPath = writeResult(
    "Reviewed.\n\n## RESULT\nfiles_touched: none\ndecisions: none\nassumptions: none\nblockers: none\nconfidence: high\n"
  );
  runCli(root, [
    "run", "report", "run-integrate-guard", "review", "--attempt", dispatch.attemptId,
    "--result-file", resultPath
  ]);

  const failed = runCli(root, ["run", "integrate", "run-integrate-guard", "review", "--evidence", "Reviewed report"]);
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /worktree.*unavailable/i);
  const shown = JSON.parse(
    runCli(root, ["run", "show", "run-integrate-guard", "--json"]).stdout
  );
  const attempt = shown.tasks.review.attempts.at(-1);
  assert.equal(shown.tasks.review.status, "reported");
  assert.equal(attempt.outcome, null);
  assert.equal(attempt.diagnostics.at(-1).type, "integration_failed");
  assert.equal(attempt.diagnostics.at(-1).reasonCode, "worktree_unavailable");
});

test("the learn CLI collects, inspects, labels, exports, and completely purges samples", () => {
  const root = repo();
  runCli(root, ["lane", "add", "ops"]);
  runCli(root, [
    "run", "create", "ops", "--id", "run-learn-cli", "--objective", "Learn safely",
    "--model", "sol", "--effort", "high"
  ]);
  const planPath = writeResult(JSON.stringify({
    tasks: [{ id: "review", title: "Review", objective: "Review request", kind: "read", acceptance: ["Report findings with evidence"] }]
  }));
  runCli(root, ["run", "plan", "run-learn-cli", "--plan-file", planPath]);
  runCli(root, ["run", "checkpoint", "run-learn-cli", "--summary", "Ready"]);
  const dispatch = JSON.parse(
    runCli(root, ["run", "claim", "run-learn-cli", "review", "--json"]).stdout
  );
  const resultPath = writeResult(
    "Reviewed.\n\n## RESULT\nfiles_touched: none\ndecisions: none\nassumptions: none\nblockers: none\nconfidence: high\n"
  );
  runCli(root, [
    "run", "report", "run-learn-cli", "review", "--attempt", dispatch.attemptId,
    "--result-file", resultPath
  ]);
  runCli(root, [
    "run", "verify", "run-learn-cli", "review", "--verdict", "pass",
    "--evidence", "reviewed"
  ]);

  const collected = JSON.parse(runCli(root, [
    "learn", "collect", "--run", "run-learn-cli", "--retention-days", "forever", "--json"
  ]).stdout);
  assert.equal(collected.created, 1);
  const listed = JSON.parse(runCli(root, ["learn", "list", "--json"]).stdout);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].outcome.terminalOutcome, "accepted");
  assert.equal(JSON.parse(runCli(root, [
    "learn", "inspect", listed[0].sampleId, "--json"
  ]).stdout).sampleId, listed[0].sampleId);

  const labeled = JSON.parse(runCli(root, [
    "learn", "label", listed[0].sampleId,
    "--outcome", "accepted",
    "--action", "execute",
    "--reason-code", "supervisor_verified",
    "--provenance", "supervisor",
    "--json"
  ]).stdout);
  assert.equal(labeled.created, true);
  const exported = JSON.parse(runCli(root, [
    "learn", "export", "--name", "cli-export", "--json"
  ]).stdout);
  assert.equal(exported.manifest.sampleCount, 1);
  assert.equal(fs.existsSync(exported.manifestFile), true);

  const purged = JSON.parse(runCli(root, [
    "learn", "purge", "--sample", listed[0].sampleId, "--json"
  ]).stdout);
  assert.equal(purged.removedCount, 1);
  assert.equal(purged.labelsRemoved, 1);
  assert.deepEqual(purged.exportsRemoved, ["cli-export"]);
  assert.deepEqual(JSON.parse(runCli(root, ["learn", "list", "--json"]).stdout), []);
});

test("the learn CLI rejects unsafe or ambiguous options", () => {
  const root = repo();
  for (const args of [
    ["learn", "collect", "--upload", "yes"],
    ["learn", "list", "--upload", "yes"],
    ["learn", "inspect", "sample-00000000000000000000000000000000", "--upload", "yes"],
    ["learn", "label", "sample-00000000000000000000000000000000", "--upload", "yes"],
    ["learn", "export", "--upload", "yes"],
    ["learn", "purge", "--upload", "yes"]
  ]) {
    assert.match(runCli(root, args).stderr, /Unknown option --upload/);
  }
  assert.match(runCli(root, ["learn", "telemetry"]).stderr, /Unknown learn action/);
  assert.match(runCli(root, ["learn", "purge"]).stderr,
    /requires a selector/);
  assert.match(runCli(root, ["learn", "purge", "--task", "review"]).stderr,
    /--task requires --run/);
  assert.match(runCli(root, [
    "learn", "export", "--include-text", "taskTitle", "--name", "unsafe"
  ]).stderr, /No learning store|acknowledge-sensitive-export/);
  assert.match(runCli(root, [
    "learn", "export", "--consent", "user", "--name", "meaningless-consent"
  ]).stderr, /require at least one --include-text/);
  assert.match(runCli(root, [
    "learn", "collect", "--retention-days", "1.5"
  ]).stderr, /retention-days/);
});

test("the run guidance CLI enables reviewed advice and supports disable and rollback", () => {
  const root = repo();
  runCli(root, ["lane", "add", "ops"]);
  runCli(root, [
    "run", "create", "ops", "--id", "run-guidance-source",
    "--objective", "SOURCE-GUIDANCE-CANARY", "--model", "sol", "--effort", "high"
  ]);
  const sourcePlan = writeResult(JSON.stringify({
    tasks: [{ id: "review", title: "Review", objective: "Inspect input", kind: "read", acceptance: ["Report missing inputs precisely"] }]
  }));
  runCli(root, ["run", "plan", "run-guidance-source", "--plan-file", sourcePlan]);
  runCli(root, ["run", "checkpoint", "run-guidance-source", "--summary", "Ready"]);
  const sourceDispatch = JSON.parse(runCli(root, [
    "run", "claim", "run-guidance-source", "review", "--json"
  ]).stdout);
  const blockedResult = writeResult(JSON.stringify({
    summary: "Input is missing.",
    files_touched: [],
    tests: [],
    decisions: [],
    assumptions: [],
    blockers: ["missing input"],
    blocker_code: "missing_context",
    confidence: "high"
  }));
  runCli(root, [
    "run", "report", "run-guidance-source", "review", "--attempt",
    sourceDispatch.attemptId, "--result-file", blockedResult
  ]);
  runCli(root, ["learn", "collect", "--run", "run-guidance-source"]);
  const sample = JSON.parse(runCli(root, ["learn", "list", "--json"]).stdout)[0];
  runCli(root, [
    "learn", "label", sample.sampleId, "--outcome", "worker_blocked",
    "--action", "clarify", "--reason-code", "missing_context",
    "--provenance", "supervisor"
  ]);

  runCli(root, [
    "run", "create", "ops", "--id", "run-guided",
    "--objective", "Use reviewed guidance", "--model", "sol", "--effort", "high"
  ]);
  const guidedPlan = writeResult(JSON.stringify({
    tasks: [{ id: "review", title: "Review", objective: "Inspect input", kind: "read", acceptance: ["Report missing inputs precisely"] }]
  }));
  runCli(root, ["run", "plan", "run-guided", "--plan-file", guidedPlan]);
  runCli(root, ["run", "checkpoint", "run-guided", "--summary", "Ready"]);
  const enabled = JSON.parse(runCli(root, [
    "run", "guidance", "run-guided", "--mode", "provisional", "--json"
  ]).stdout);
  assert.equal(enabled.mode, "provisional");
  assert.match(enabled.policy.policyHash, /^guidance-policy-/);
  const stale = JSON.parse(runCli(root, ["run", "ready", "run-guided", "--json"]).stdout);
  assert.match(stale.checkpoint.reason, /guidance revision/);
  runCli(root, ["run", "checkpoint", "run-guided", "--summary", "Guidance reviewed"]);
  const first = JSON.parse(runCli(root, [
    "run", "claim", "run-guided", "review", "--json"
  ]).stdout);
  assert.doesNotMatch(first.briefing, /## Provisional guidance/);
  runCli(root, [
    "run", "report", "run-guided", "review", "--attempt", first.attemptId,
    "--result-file", blockedResult
  ]);
  runCli(root, ["run", "retry", "run-guided", "review"]);
  const retryReady = JSON.parse(runCli(root, [
    "run", "ready", "run-guided", "--json"
  ]).stdout);
  assert.match(retryReady.checkpoint.reason, /guidance revision/);
  runCli(root, [
    "run", "checkpoint", "run-guided", "--summary", "Retry guidance reviewed"
  ]);
  const second = JSON.parse(runCli(root, [
    "run", "claim", "run-guided", "review", "--json"
  ]).stdout);
  assert.match(second.briefing, /## Provisional guidance/);
  assert.match(second.briefing, /structured blocker/);
  assert.doesNotMatch(second.briefing, /SOURCE-GUIDANCE-CANARY/);
  runCli(root, [
    "run", "report", "run-guided", "review", "--attempt", second.attemptId,
    "--result-file", blockedResult
  ]);

  const disabled = JSON.parse(runCli(root, [
    "run", "guidance", "run-guided", "--mode", "off", "--json"
  ]).stdout);
  assert.equal(disabled.mode, "disabled");
  const restored = JSON.parse(runCli(root, [
    "run", "guidance", "run-guided", "--rollback", "--json"
  ]).stdout);
  assert.equal(restored.mode, "provisional");
  assert.equal(restored.policy.policyHash, enabled.policy.policyHash);

  const guidedRunFile = path.join(
    root, ".orchestrator", "local", "runs", "run-guided", "run.json"
  );
  const corrupt = JSON.parse(fs.readFileSync(guidedRunFile, "utf8"));
  corrupt.guidance.policy.entries[0].text = "corrupt active policy";
  fs.writeFileSync(guidedRunFile, `${JSON.stringify(corrupt, null, 2)}\n`);
  const emergencyDisabled = JSON.parse(runCli(root, [
    "run", "guidance", "run-guided", "--mode", "off", "--json"
  ]).stdout);
  assert.equal(emergencyDisabled.mode, "disabled");

  runCli(root, [
    "learn", "label", sample.sampleId, "--outcome", "worker_blocked",
    "--action", "clarify", "--reason-code", "missing_context",
    "--provenance", "user"
  ]);
  const reusedVersion = runCli(root, [
    "run", "guidance", "run-guided", "--mode", "provisional"
  ]);
  assert.equal(reusedVersion.code, 1);
  assert.match(reusedVersion.stderr, /choose a new --policy-version/);
  const newlyVersioned = JSON.parse(runCli(root, [
    "run", "guidance", "run-guided", "--mode", "provisional",
    "--policy-version", "provisional-v2", "--json"
  ]).stdout);
  assert.equal(newlyVersioned.policy.policyVersion, "provisional-v2");

  assert.match(runCli(root, [
    "run", "guidance", "run-guided", "--mode", "off", "--rollback"
  ]).stderr, /cannot be combined/);
  assert.match(runCli(root, [
    "run", "guidance", "run-guided", "--upload", "yes"
  ]).stderr, /Unknown option --upload/);
});

test("run list is one line per run, --open hides closed runs, and short ids resolve", () => {
  const root = repo();
  runCli(root, ["lane", "add", "api", "--scope", "src/**"]);
  for (const id of ["run-20261101000000-aaaa1111", "run-20261102000000-bbbb2222"]) {
    const created = runCli(root, ["run", "create", "api", "--id", id, "--objective", `Objective ${id}`, "--model", "sol", "--effort", "high"]);
    assert.equal(created.code, 0, created.stderr);
  }
  const cancelled = runCli(root, ["run", "cancel", "aaaa1111", "--reason", "stopped"]);
  assert.equal(cancelled.code, 0, cancelled.stderr);

  const all = runCli(root, ["run", "list"]).stdout.trim().split("\n");
  assert.equal(all.length, 2);
  assert.match(all[0], /^run-20261102000000-bbbb2222 +planning .* 0\/0 tasks +api: Objective run-20261102000000-bbbb2222$/);
  assert.match(all[1], /^run-20261101000000-aaaa1111 +cancelled/);
  const open = runCli(root, ["run", "list", "--open"]).stdout.trim().split("\n");
  assert.deepEqual(open.map((line) => line.split(" ")[0]), ["run-20261102000000-bbbb2222"]);
  assert.equal(JSON.parse(runCli(root, ["run", "list", "--open", "--json"]).stdout).length, 1);

  assert.match(runCli(root, ["run", "show", "bbbb2222"]).stdout, /^# Run run-20261102000000-bbbb2222/);
  assert.match(runCli(root, ["run", "show", "latest"]).stdout, /^# Run run-20261102000000-bbbb2222/);
  const ambiguous = runCli(root, ["run", "show", "run-2026110"]);
  assert.equal(ambiguous.code, 1);
  assert.match(ambiguous.stderr, /matches 2 runs; use more of the id:\n- run-20261102000000-bbbb2222 \(planning\)\n- run-20261101000000-aaaa1111 \(cancelled\)/);
  assert.match(runCli(root, ["run", "show", "nopenope"]).stderr, /No run matches "nopenope"/);
  assert.match(runCli(root, ["run", "show", "bbbb"]).stderr, /too short to pick a run/);
  assert.match(runCli(root, ["run", "show"]).stderr, /requires a run id; `orch run list --open`/);
});

test("run list --open says so when nothing is open", () => {
  const root = repo();
  assert.match(runCli(root, ["run", "list", "--open"]).stdout, /No open orchestration runs\./);
  assert.match(runCli(root, ["run", "show", "latest"]).stderr, /no orchestration runs in this repository yet/);
});

test("operator CLI exposes scoped ledger history and read-only storage diagnostics", () => {
  const root = repo();
  const added = runCli(root, ["ledger", "add", "Decisions", "API decision", "--lane", "api", "--source", "reviewed code", "--json"]);
  assert.equal(added.code, 0, added.stderr);
  const { id } = JSON.parse(added.stdout);
  assert.ok(id);
  assert.match(runCli(root, ["ledger", "show", "--lane", "api", "--json"]).stdout, /API decision/);
  assert.doesNotMatch(runCli(root, ["ledger", "show", "--lane", "web", "--json"]).stdout, /API decision/);
  const deprecated = runCli(root, ["ledger", "deprecate", "Decisions", id, "--reason", "Replaced by reviewed v2", "--json"]);
  assert.equal(deprecated.code, 0, deprecated.stderr);
  assert.doesNotMatch(runCli(root, ["ledger", "show", "--lane", "api", "--json"]).stdout, /API decision/);
  assert.match(runCli(root, ["ledger", "show"]).stdout, /API decision/);
  assert.match(runCli(root, ["ledger", "show", "--lane", "api", "--include-deprecated", "--json"]).stdout, /DEPRECATED/);
  const before = git(root, ["status", "--porcelain"]);
  const storage = runCli(root, ["storage", "--json"]), diagnostic = runCli(root, ["diagnostics", "--json"]);
  assert.equal(storage.code, 0, storage.stderr);
  assert.equal(diagnostic.code, 0, diagnostic.stderr);
  assert.equal(JSON.parse(storage.stdout).advisory, true);
  assert.equal(JSON.parse(diagnostic.stdout).certification, "unknown");
  assert.doesNotMatch(diagnostic.stdout, new RegExp(root));
  assert.equal(git(root, ["status", "--porcelain"]), before);
});
