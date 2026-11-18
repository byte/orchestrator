import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";

import {
  ROUTE_RATE_MIN_SAMPLE,
  ROUTE_TABLE_MIN_ATTEMPTS,
  aggregateRoutes,
  renderRouteEvidence,
  routeEvidence
} from "../plugins/orchestrator/scripts/lib/routes.mjs";
import { createRun, runFile } from "../plugins/orchestrator/scripts/lib/runs.mjs";
import { cleanup, makeRepo, runCli, write } from "./helpers.mjs";

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

function outcome(terminalOutcome, action, reasonCode) {
  return { version: 1, terminalOutcome, action, reasonCode, provenance: "supervisor", signals: [] };
}

const ACCEPTED = outcome("accepted", "execute", "supervisor_verified");
const VERIFY_FAILED = outcome("verification_failed", "replan", "supervisor_verification_failed");
const UNAVAILABLE = outcome("execution_failed", "execute", "model_unavailable");
const LAUNCH_FAILED = outcome("execution_failed", "execute", "worker_launch_failed");
const CANCELLED = outcome("cancelled", "abstain", "task_cancelled");
const BLOCKED = outcome("worker_blocked", "replan", "worker_reported_blocker");
const MALFORMED = outcome("contract_failed", "replan", "malformed_result_contract");

/** One attempt that ran `minutes` long, starting at a fixed time. */
function attempt(id, model, reasoningEffort, result, minutes, extra = {}) {
  const start = Date.parse("2026-11-15T10:00:00.000Z");
  return {
    id,
    status: result === ACCEPTED ? "completed" : result ? "failed" : "running",
    model,
    reasoningEffort,
    requestedModel: model,
    substitution: null,
    claimedAt: new Date(start - 1000).toISOString(),
    startedAt: new Date(start).toISOString(),
    finishedAt: result ? new Date(start + minutes * 60_000).toISOString() : null,
    outcome: result,
    ...extra
  };
}

function task(id, attempts, extra = {}) {
  return { id, title: id, objective: id, kind: "write", scope: ["src/**"], dependsOn: [], attempts, ...extra };
}

/**
 * Save a run with hand-built tasks. The run is created through the runtime so its
 * guidance state is valid, then its tasks (and optionally its state version) are
 * replaced exactly as an older build would have left them on disk.
 */
function savedRun(root, id, lane, tasks, version = 6) {
  createRun(root, { id, lane, objective: id });
  const file = runFile(root, id);
  const state = JSON.parse(fs.readFileSync(file, "utf8"));
  state.version = version;
  state.status = "running";
  state.tasks = Object.fromEntries(tasks.map((entry) => [entry.id, entry]));
  fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
}

const SUBSTITUTION = {
  requestedModel: "gpt-6.2-astra",
  model: "gpt-6.2-sol",
  reasoningEffort: "high",
  reason: "model_unavailable",
  pinned: false,
  unavailableModels: ["gpt-6.2-astra"],
  at: "2026-11-15T09:59:59.000Z"
};

/**
 * The hand-counted fixture. Lane `api`, current roster, by actual model:
 *
 * gpt-6.2-sol/high: t1a1 accepted 10m; t2a1 failed 5m; t2a2 warm retry accepted
 *   3m (two answered input rounds, same attempt); t3a2 substitute for astra,
 *   accepted 20m; t7a1 accepted 6m; t8a1 malformed 1m.
 *   => 6 attempts; first attempts t1,t2a1,t3a2,t7,t8 = 5, accepted t1,t3,t7 = 3
 *   (60%); 1 retry; 1 substituted in; median of 1,3,5,6,10,20 = 5.5m.
 * gpt-6.1-terra/medium: t4a2 accepted 4m (t4a1 failed to launch, so t4a2 is the
 *   first that reached a worker); t5a2 blocked 2m (t5a1 was cancelled, so t5
 *   gives no first-attempt sample and t5a2 is a retry).
 *   => 2 attempts; first 1/1, rate withheld; 1 retry; median 3m.
 * Not counted: t3a1 astra rejected as unavailable; t4a1 launch failure; t5a1
 * cancelled; t6a1 running and t9a1 paused on a request; run-b's legacy attempt.
 */
function writeFixture(root) {
  savedRun(root, "run-a", "api", [
    task("t1", [attempt("t1-attempt-1", "gpt-6.2-sol", "high", ACCEPTED, 10)]),
    task("t2", [
      attempt("t2-attempt-1", "gpt-6.2-sol", "high", VERIFY_FAILED, 5, { threadId: "thread-t2" }),
      attempt("t2-attempt-2", "gpt-6.2-sol", "high", ACCEPTED, 3, {
        resumedFromAttemptId: "t2-attempt-1",
        retry: { previousAttemptId: "t2-attempt-1", mode: "warm", reason: "verification failed", note: "fix it" },
        inputRequests: [
          { round: 1, request: { kind: "question" }, answer: { reply: "a" } },
          { round: 2, request: { kind: "question" }, answer: { reply: "b" } }
        ]
      })
    ]),
    task("t3", [
      attempt("t3-attempt-1", "gpt-6.2-astra", "high", UNAVAILABLE, 0, {
        modelUnavailable: { model: "gpt-6.2-astra", fallbackModel: "gpt-6.2-sol" }
      }),
      attempt("t3-attempt-2", "gpt-6.2-sol", "high", ACCEPTED, 20, {
        requestedModel: "gpt-6.2-astra",
        substitution: SUBSTITUTION
      })
    ]),
    task("t4", [
      attempt("t4-attempt-1", "gpt-6.1-terra", "medium", LAUNCH_FAILED, 0, { launchFailed: true }),
      attempt("t4-attempt-2", "gpt-6.1-terra", "medium", ACCEPTED, 4)
    ]),
    task("t5", [
      { ...attempt("t5-attempt-1", "gpt-6.1-terra", "medium", CANCELLED, 7), status: "cancelled" },
      attempt("t5-attempt-2", "gpt-6.1-terra", "medium", BLOCKED, 2)
    ]),
    task("t6", [attempt("t6-attempt-1", "gpt-6.2-sol", "high", null, 0)]),
    task("t7", [attempt("t7-attempt-1", "gpt-6.2-sol", "high", ACCEPTED, 6)]),
    task("t8", [attempt("t8-attempt-1", "gpt-6.2-sol", "high", MALFORMED, 1)]),
    task("t9", [{ ...attempt("t9-attempt-1", "gpt-6.2-sol", "medium", null, 0), status: "needs_input" }])
  ]);
  // A run saved by 0.5.x: its attempt predates `reasoningEffort` on attempts, so
  // the effort comes from the saved task route.
  const legacy = attempt("old-attempt-1", "gpt-5.6-sol", "high", ACCEPTED, 8);
  delete legacy.reasoningEffort;
  delete legacy.requestedModel;
  delete legacy.substitution;
  savedRun(root, "run-b", "api", [
    task("old", [legacy], { model: "gpt-5.6-sol", reasoningEffort: "high" })
  ], 5);
  // Another lane, with an attempt from before outcome records existed.
  const unclassified = attempt("web-attempt-1", "gpt-6.1-terra", "low", ACCEPTED, 1);
  delete unclassified.outcome;
  savedRun(root, "run-c", "web", [task("web", [unclassified])]);
}

function row(evidence, model, effort) {
  return evidence.rows.find((entry) => entry.model === model && entry.reasoningEffort === effort);
}

test("run routes matches a hand count on a fixture of saved runs", () => {
  const root = repo();
  writeFixture(root);
  const result = runCli(root, ["run", "routes", "--lane", "api", "--json"]);
  assert.equal(result.code, 0, result.stderr);
  const evidence = JSON.parse(result.stdout);

  assert.equal(evidence.lane, "api");
  assert.equal(evidence.runs, 2);
  assert.equal(evidence.attempts, 8);
  assert.equal(evidence.minSample, 5);
  assert.deepEqual(evidence.rows.map((entry) => `${entry.model}/${entry.reasoningEffort}`), [
    "gpt-6.2-sol/high",
    "gpt-6.1-terra/medium"
  ]);
  assert.deepEqual(row(evidence, "gpt-6.2-sol", "high"), {
    model: "gpt-6.2-sol",
    reasoningEffort: "high",
    attempts: 6,
    accepted: 4,
    firstAttempts: 5,
    firstAccepted: 3,
    retries: 1,
    substituted: 1,
    firstAttemptAcceptanceRate: 0.6,
    medianDurationMs: 5.5 * 60_000,
    durationSamples: 6
  });
  assert.deepEqual(row(evidence, "gpt-6.1-terra", "medium"), {
    model: "gpt-6.1-terra",
    reasoningEffort: "medium",
    attempts: 2,
    accepted: 1,
    firstAttempts: 1,
    firstAccepted: 1,
    retries: 1,
    substituted: 0,
    firstAttemptAcceptanceRate: null,
    medianDurationMs: 3 * 60_000,
    durationSamples: 2
  });
  assert.deepEqual(evidence.excluded, {
    modelUnavailable: { "gpt-6.2-astra": 1 },
    launchFailed: 1,
    cancelled: 1,
    inProgress: 2,
    legacy: 1
  });
  assert.deepEqual(evidence.skippedRuns, []);
});

test("rejected launches never count for either model and substitutes count for the model that ran", () => {
  const root = repo();
  writeFixture(root);
  const evidence = routeEvidence(root, { lane: "api" });
  // The astra launch Codex rejected is neither an astra failure nor a sol attempt.
  assert.equal(row(evidence, "gpt-6.2-astra", "high"), undefined);
  assert.equal(evidence.excluded.modelUnavailable["gpt-6.2-astra"], 1);
  // The substitute launch is sol's, and it is the task's first real attempt.
  assert.equal(row(evidence, "gpt-6.2-sol", "high").substituted, 1);
  assert.equal(row(evidence, "gpt-6.2-sol", "high").firstAccepted, 3);
});

test("the text table shows counts beside every rate and withholds rates below the minimum", () => {
  const root = repo();
  writeFixture(root);
  const result = runCli(root, ["run", "routes", "--lane", "api"]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /## Route evidence — lane api, 2 local runs/);
  assert.match(result.stdout, /at least 5/);
  assert.match(
    result.stdout,
    /\| gpt-6\.2-sol \| high \| 6 \| 3\/5 = 60% \| 1 \| 1 \| 5m 30s \(n=6\) \|/
  );
  assert.match(
    result.stdout,
    /\| gpt-6\.1-terra \| medium \| 2 \| 1\/1 \(n<5, no rate\) \| 1 \| 0 \| 3m 00s \(n=2\) \|/
  );
  assert.doesNotMatch(result.stdout, /100%/);
  assert.match(result.stdout, /model-unavailable \(never reached a worker\): gpt-6.2-astra ×1/);
  assert.match(result.stdout, /failed before Codex started: 1/);
  assert.match(result.stdout, /cancelled attempts: 1/);
  assert.match(result.stdout, /still running or paused on a request: 2/);
  assert.match(result.stdout, /retired slugs \(gpt-5\.6-sol, gpt-5\.6-terra, gpt-6-astra, gpt-6\.1-sol\): 1 \(pass --include-legacy/);
});

test("legacy-slug attempts are excluded by default and counted with --include-legacy", () => {
  const root = repo();
  writeFixture(root);
  const included = JSON.parse(runCli(root, ["run", "routes", "--lane", "api", "--include-legacy", "--json"]).stdout);
  assert.equal(included.attempts, 9);
  assert.equal(included.excluded.legacy, 0);
  assert.deepEqual(
    { attempts: row(included, "gpt-5.6-sol", "unknown").attempts, first: row(included, "gpt-5.6-sol", "unknown").firstAccepted },
    { attempts: 1, first: 1 }
  );
  const excluded = routeEvidence(root, { lane: "api" });
  assert.equal(row(excluded, "gpt-5.6-sol", "high"), undefined);
});

test("without --lane every lane is counted, including attempts saved before outcome records", () => {
  const root = repo();
  writeFixture(root);
  const evidence = routeEvidence(root);
  assert.equal(evidence.lane, null);
  assert.equal(evidence.runs, 3);
  assert.equal(evidence.attempts, 9);
  assert.equal(row(evidence, "gpt-6.1-terra", "low").firstAccepted, 1);
  assert.match(renderRouteEvidence(evidence), /## Route evidence — all lanes, 3 local runs/);
});

test("run routes is read-only and survives a run it cannot load", () => {
  const root = repo();
  writeFixture(root);
  write(root, ".orchestrator/local/runs/run-broken/run.json", "{ not json");
  const local = path.join(root, ".orchestrator", "local");
  const snapshot = () => fs.readdirSync(local, { recursive: true }).sort().map((entry) => {
    const file = path.join(local, entry);
    return fs.statSync(file).isFile() ? `${entry}:${fs.readFileSync(file, "utf8").length}` : entry;
  });
  const before = snapshot();
  const result = runCli(root, ["run", "routes", "--json"]);
  assert.equal(result.code, 0, result.stderr);
  const evidence = JSON.parse(result.stdout);
  assert.deepEqual(evidence.skippedRuns.map((entry) => entry.runId), ["run-broken"]);
  assert.equal(evidence.attempts, 9);
  assert.deepEqual(snapshot(), before);
  assert.match(runCli(root, ["run", "routes"]).stdout, /run run-broken could not be read/);
});

test("legacy route gaps stay unknown across replans while saved assignment facts retain attribution", () => {
  const old = attempt("work-attempt-1", "gpt-6.2-sol", undefined, VERIFY_FAILED, 2);
  const snapshotted = attempt("work-attempt-2", "gpt-6.1-terra", undefined, ACCEPTED, 3, {
    assignmentSnapshot: { version: 1, model: "gpt-6.2-sol", reasoningEffort: "high" }
  });
  const run = { lane: "api", workerPolicy: { model: "gpt-6.2-sol", reasoningEffort: "high" },
    tasks: { work: task("work", [old, snapshotted], { model: "gpt-6.2-sol", reasoningEffort: "high" }) } };
  const before = aggregateRoutes([run]);
  assert.equal(row(before, "gpt-6.2-sol", "unknown").attempts, 1);
  assert.equal(row(before, "gpt-6.1-terra", "high").attempts, 1);
  run.tasks.work.reasoningEffort = "low";
  run.workerPolicy.reasoningEffort = "low";
  assert.deepEqual(aggregateRoutes([run]), before);
});

test("an empty history renders without rates", () => {
  const evidence = aggregateRoutes([], { lane: "api" });
  assert.equal(evidence.attempts, 0);
  assert.match(renderRouteEvidence(evidence), /No finished attempts to count yet\./);
  assert.equal(ROUTE_RATE_MIN_SAMPLE, 5);
  assert.equal(ROUTE_TABLE_MIN_ATTEMPTS, 5);
});

function livePlan(root) {
  const file = path.join(fs.mkdtempSync(path.join(path.dirname(root), "orch-plan-")), "plan.json");
  fs.writeFileSync(file, JSON.stringify({
    tasks: [{
      id: "next",
      title: "Next",
      objective: "Do the next thing",
      scope: ["src/**"],
      model: "sol",
      effort: "high",
      routingReason: "Ordinary implementation."
    }]
  }));
  return file;
}

test("run plan, run briefing, and run resume show the lane table only from five counted attempts", () => {
  const root = repo();
  assert.equal(runCli(root, ["lane", "add", "api", "--scope", "src/**"]).code, 0);
  assert.equal(runCli(root, ["run", "create", "api", "--objective", "Live", "--id", "run-live", "--json"]).code, 0);
  const plan = livePlan(root);

  // Four counted attempts in the lane: below the threshold, so nothing is shown.
  savedRun(root, "run-four", "api", [1, 2, 3, 4].map((n) =>
    task(`f${n}`, [attempt(`f${n}-attempt-1`, "gpt-6.2-sol", "high", ACCEPTED, n)])
  ));
  const quiet = runCli(root, ["run", "plan", "run-live", "--plan-file", plan]);
  assert.equal(quiet.code, 0, quiet.stderr);
  assert.doesNotMatch(quiet.stdout, /Route evidence/);
  assert.doesNotMatch(runCli(root, ["run", "briefing", "run-live"]).stdout, /Route evidence/);
  assert.equal(JSON.parse(runCli(root, ["run", "resume", "run-live", "--json"]).stdout).routes, null);

  // A fifth attempt in another lane does not count toward this lane.
  savedRun(root, "run-other", "web", [task("w", [attempt("w-attempt-1", "gpt-6.2-sol", "high", ACCEPTED, 1)])]);
  assert.doesNotMatch(runCli(root, ["run", "plan", "run-live", "--plan-file", plan]).stdout, /Route evidence/);

  // A fifth in this lane crosses it.
  savedRun(root, "run-five", "api", [task("g", [attempt("g-attempt-1", "gpt-6.2-sol", "high", ACCEPTED, 5)])]);
  const shown = runCli(root, ["run", "plan", "run-live", "--plan-file", plan]);
  assert.equal(shown.code, 0, shown.stderr);
  assert.match(shown.stdout, /^## Route evidence — lane api, 3 local runs/);
  assert.match(shown.stdout, /\| gpt-6\.2-sol \| high \| 5 \| 5\/5 = 100% \|/);
  assert.match(shown.stdout, /# Run run-live/);

  const briefing = runCli(root, ["run", "briefing", "run-live"]).stdout;
  assert.match(briefing, /## Route evidence — lane api/);
  assert.match(briefing, /cite it in `routingReason` when it changed a route/);
  const resumed = JSON.parse(runCli(root, ["run", "resume", "run-live", "--json"]).stdout);
  assert.equal(resumed.routes.lane, "api");
  assert.equal(resumed.routes.attempts, 5);
  assert.match(resumed.briefing, /## Route evidence — lane api/);
});

test("run routes rejects a positional argument", () => {
  const root = repo();
  const result = runCli(root, ["run", "routes", "api"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /--lane <lane>/);
});

test("time paused on a needs_input request is not counted as model runtime", () => {
  const root = repo();
  const at = (minutes) => new Date(Date.parse("2026-11-15T10:00:00.000Z") + minutes * 60_000).toISOString();
  savedRun(root, "run-paused", "api", [
    task("answered", [attempt("answered-attempt-1", "gpt-6.2-sol", "high", ACCEPTED, 195, {
      // Worked 10 minutes, waited 3 hours for the answer, then finished in 5.
      inputRequests: [{ round: 1, requestedAt: at(10), answer: { answeredAt: at(190) } }]
    })]),
    task("cancelled-while-paused", [attempt("cancelled-while-paused-attempt-1", "gpt-6.2-sol", "high", BLOCKED, 70, {
      // Worked 10 minutes, then sat unanswered until it ended.
      inputRequests: [{ round: 1, requestedAt: at(10), answer: null }]
    })])
  ]);
  const evidence = routeEvidence(root, { lane: "api" });
  const sol = row(evidence, "gpt-6.2-sol", "high");
  assert.equal(sol.durationSamples, 2);
  assert.equal(sol.medianDurationMs, 12.5 * 60_000);
});
