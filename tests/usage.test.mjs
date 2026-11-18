import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import {
  bindAttempt,
  claimTask,
  createRun,
  loadRun,
  recordContribution,
  recordTaskResult,
  replacePlan,
  verifyTask
} from "../plugins/orchestrator/scripts/lib/runs.mjs";
import {
  attemptUsage,
  findRollout,
  renderRunCost,
  runUsage,
  usageLine
} from "../plugins/orchestrator/scripts/lib/usage.mjs";
import { checkpointPlan, cleanup, makeRepo, runCli } from "./helpers.mjs";

const dirs = [];
after(() => {
  for (const dir of dirs) cleanup(dir);
});

function codexHome() {
  const home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "orch-codex-"));
  dirs.push(home);
  return home;
}

function dayDir(home, iso) {
  const day = new Date(iso);
  return path.join(
    home,
    "sessions",
    String(day.getFullYear()),
    String(day.getMonth() + 1).padStart(2, "0"),
    String(day.getDate()).padStart(2, "0")
  );
}

function tokenEvent(at, { input, cached = 0, output, weekly = null, plan = "pro" }) {
  return JSON.stringify({
    timestamp: at,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: input,
          cached_input_tokens: cached,
          output_tokens: output,
          reasoning_output_tokens: 0,
          total_tokens: input + output
        }
      },
      rate_limits: weekly === null ? null : {
        primary: { used_percent: weekly, window_minutes: 10080, resets_at: 1 },
        secondary: null,
        plan_type: plan
      }
    }
  });
}

function writeRollout(home, threadId, createdIso, lines) {
  const dir = dayDir(home, createdIso);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-${createdIso.slice(0, 19).replace(/:/g, "-")}-${threadId}.jsonl`);
  fs.writeFileSync(file, [
    JSON.stringify({ timestamp: createdIso, type: "session_meta", payload: { id: threadId } }),
    "not json, a torn line",
    ...lines
  ].join("\n") + "\n");
  return file;
}

test("an attempt's usage is the thread's growth during the attempt, not the thread's total", () => {
  const home = codexHome();
  const thread = "thread-resumed";
  writeRollout(home, thread, "2026-11-10T10:00:00.000Z", [
    // An earlier attempt on the same thread, before a warm retry.
    tokenEvent("2026-11-10T10:05:00.000Z", { input: 1000, cached: 400, output: 50, weekly: 10 }),
    tokenEvent("2026-11-12T09:01:00.000Z", { input: 1500, cached: 900, output: 80, weekly: 12 }),
    tokenEvent("2026-11-12T09:30:00.000Z", { input: 3000, cached: 2000, output: 200, weekly: 14 }),
    // After the attempt and its minute of slack: someone else resumed it.
    tokenEvent("2026-11-12T11:00:00.000Z", { input: 9000, cached: 1, output: 999, weekly: 20 })
  ]);
  const usage = attemptUsage(
    { threadId: thread, startedAt: "2026-11-12T09:00:00.000Z", finishedAt: "2026-11-12T09:30:00.000Z" },
    { home }
  );
  assert.equal(usage.available, true);
  assert.deepEqual(usage.tokens, { input: 2000, cachedInput: 1600, output: 150, reasoningOutput: 0 });
  assert.equal(usage.plan, "pro");
  assert.equal(usage.weeklyFirst.usedPercent, 12);
  assert.equal(usage.weeklyLast.usedPercent, 14);
});

test("a warm retry inside the slack minute is not counted twice", () => {
  const home = codexHome();
  writeRollout(home, "t-warm", "2026-11-12T09:00:00.000Z", [
    tokenEvent("2026-11-12T09:09:00.000Z", { input: 100, output: 10 }),
    tokenEvent("2026-11-12T09:10:20.000Z", { input: 300, output: 30 }),
    tokenEvent("2026-11-12T09:20:00.000Z", { input: 700, output: 70 })
  ]);
  const run = {
    id: "run-warm",
    tasks: {
      a: { id: "a", status: "completed", attempts: [
        { id: "a-1", threadId: "t-warm", startedAt: "2026-11-12T09:00:00.000Z", finishedAt: "2026-11-12T09:10:00.000Z" },
        { id: "a-2", threadId: "t-warm", startedAt: "2026-11-12T09:10:10.000Z", finishedAt: "2026-11-12T09:20:00.000Z" }
      ] }
    }
  };
  const usage = runUsage(run, { home });
  assert.deepEqual(usage.attempts.map((entry) => entry.tokens.input), [100, 600]);
  assert.equal(usage.tokens.input, 700);
});

test("a thread first logged long before the attempt is still found", () => {
  const home = codexHome();
  const file = writeRollout(home, "thread-old", "2026-06-01T10:00:00.000Z", []);
  const at = Date.parse("2026-11-12T09:00:00.000Z");
  assert.equal(findRollout("thread-old", { home, fromMs: at, toMs: at }), file);
  assert.equal(findRollout("thread-missing", { home, fromMs: at, toMs: at }), null);
  assert.equal(findRollout("../escape", { home, fromMs: at, toMs: at }), null);
});

test("missing threads and logs are reported as not measured, never guessed", () => {
  const home = codexHome();
  assert.match(attemptUsage({ startedAt: "2026-11-12T09:00:00.000Z" }, { home }).reason, /no Codex thread/);
  assert.match(
    attemptUsage({ threadId: "gone", startedAt: "2026-11-12T09:00:00.000Z" }, { home }).reason,
    /no Codex session log/
  );
  writeRollout(home, "quiet", "2026-11-12T09:00:00.000Z", []);
  assert.match(
    attemptUsage({ threadId: "quiet", startedAt: "2026-11-12T09:00:00.000Z", finishedAt: "2026-11-12T09:10:00.000Z" }, { home }).reason,
    /no token usage/
  );
});

test("run usage totals measured attempts, retired ones included, and spans the weekly limit", () => {
  const home = codexHome();
  writeRollout(home, "t-a", "2026-11-12T09:00:00.000Z", [
    tokenEvent("2026-11-12T09:10:00.000Z", { input: 1_000_000, cached: 900_000, output: 10_000, weekly: 30 })
  ]);
  writeRollout(home, "t-b", "2026-11-12T09:00:00.000Z", [
    tokenEvent("2026-11-12T09:20:00.000Z", { input: 3_000_000, cached: 2_900_000, output: 20_000, weekly: 33 })
  ]);
  const run = {
    id: "run-x",
    tasks: {
      a: { id: "a", status: "completed", attempts: [{ id: "a-1", model: "gpt-6.2-sol", threadId: "t-a", startedAt: "2026-11-12T09:00:00.000Z", finishedAt: "2026-11-12T09:10:00.000Z" }] },
      c: { id: "c", status: "pending", attempts: [] }
    },
    retiredTasks: [
      { id: "b", status: "cancelled", attempts: [{ id: "b-1", model: "gpt-6.2-astra", threadId: "t-b", startedAt: "2026-11-12T09:00:00.000Z", finishedAt: "2026-11-12T09:20:00.000Z" }] },
      { id: "d", status: "cancelled", attempts: [{ id: "d-1", model: "gpt-6.2-astra", threadId: "t-none", startedAt: "2026-11-12T09:00:00.000Z" }] }
    ]
  };
  const usage = runUsage(run, { home, nowMs: Date.parse("2026-11-12T10:00:00.000Z") });
  assert.equal(usage.measured, 2);
  assert.equal(usage.unmeasured, 1);
  assert.equal(usage.tokens.input, 4_000_000);
  assert.equal(usage.byModel["gpt-6.2-astra"].output, 20_000);
  assert.deepEqual(usage.weekly, { fromPercent: 30, toPercent: 33 });
  assert.equal(usageLine(usage), "2 workers · 4.0M tokens (95% cached input) · weekly Codex limit 30% → 33% (+3, account-wide)");
  const text = renderRunCost(run, usage);
  assert.match(text, /no Codex session log for thread t-none/);
  assert.match(text, /not billed per token/);
  assert.match(text, /\/cost/);
  assert.match(text, /1 accepted first try · 0 accepted after retry · 0 failed or cancelled/);
  assert.match(text, /No contribution tally recorded/);
  assert.equal(usageLine({ ...usage, measured: 0 }), null);
});

function repo() {
  const root = makeRepo();
  dirs.push(root);
  runCli(root, ["init"]);
  return root;
}

test("a tally must be consistent, replaces the last one, and shows in run cost", () => {
  const root = repo();
  createRun(root, { id: "run-tally", lane: "api", objective: "Review", workerModel: "sol", reasoningEffort: "high" });
  for (const [values, pattern] of [
    [{ findings: 3, checked: 4 }, /re-check 4 of 3/],
    [{ findings: 5, checked: 4, held: 3, corrected: 2 }, /cannot exceed the 4 re-checked/],
    [{ findings: 2, workerOnly: 3 }, /cannot exceed all 2/],
    [{ findings: -1 }, /whole number/],
    [{ findings: "2.5" }, /whole number/],
    [{ findings: "" }, /whole number/]
  ]) {
    assert.throws(() => recordContribution(root, "run-tally", values), pattern);
  }
  recordContribution(root, "run-tally", { findings: 1 });
  const partial = runCli(root, ["run", "tally", "run-tally", "--findings", "4"]);
  assert.notEqual(partial.code, 0);
  assert.match(partial.stderr, /requires --checked, --held, --corrected, --worker-only, --supervisor-only; give 0/);
  const tally = runCli(root, ["run", "tally", "run-tally", "--findings", "22", "--checked", "15", "--held", "13",
    "--corrected", "2", "--worker-only", "6", "--supervisor-only", "1", "--note", "re-read 15 citations"]);
  assert.equal(tally.code, 0, tally.stderr);
  const saved = loadRun(root, "run-tally").contribution;
  assert.equal(saved.findings, 22);
  assert.equal(saved.note, "re-read 15 citations");
  const cost = runCli(root, ["run", "cost", "run-tally"]);
  assert.equal(cost.code, 0, cost.stderr);
  assert.match(cost.stdout, /Worker findings: 22 · supervisor re-checked 15 · held 13 · corrected 2/);
  assert.match(cost.stdout, /Only from workers: 6 · supervisor-only: 1/);
  assert.match(cost.stdout, /No worker usage could be read/);
});

test("finalize saves a usage snapshot when the logs can be read", () => {
  const home = codexHome();
  const root = repo();
  createRun(root, { id: "run-snap", lane: "api", objective: "Review", workerModel: "sol", reasoningEffort: "high" });
  replacePlan(root, "run-snap", [{ id: "review", title: "Review", objective: "Inspect", kind: "read" }]);
  checkpointPlan(root, "run-snap");
  const dispatch = claimTask(root, "run-snap", "review", { constraints: [] });
  bindAttempt(root, "run-snap", "review", { attemptId: dispatch.attemptId, threadId: "t-snap" });
  const started = loadRun(root, "run-snap").tasks.review.attempts[0];
  const startedAt = started.startedAt ?? started.claimedAt;
  writeRollout(home, "t-snap", startedAt, [
    tokenEvent(new Date(Date.parse(startedAt) + 1000).toISOString(), { input: 500, cached: 100, output: 20, weekly: 5 })
  ]);
  recordTaskResult(root, "run-snap", "review", {
    attemptId: dispatch.attemptId,
    resultText: "Reviewed.\n\n## RESULT\nfiles_touched: none\ndecisions: none\nassumptions: none\nblockers: none\nconfidence: high"
  });
  verifyTask(root, "run-snap", "review", { verdict: "pass", evidence: ["checked"] });
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  try {
    const finalized = runCli(root, ["run", "finalize", "run-snap", "--verdict", "pass", "--summary", "done", "--evidence", "checked", "--json"]);
    assert.equal(finalized.code, 0, finalized.stderr);
    const usage = JSON.parse(finalized.stdout).finalization.usage;
    assert.equal(usage.measured, 1);
    assert.equal(usage.tokens.input, 500);
    const shown = runCli(root, ["run", "show", "run-snap"]);
    assert.match(shown.stdout, /- usage: 1 worker · 520 tokens \(20% cached input\)/);
    // Once the logs are pruned, run cost falls back to the saved snapshot.
    fs.rmSync(path.join(home, "sessions"), { recursive: true, force: true });
    const cost = runCli(root, ["run", "cost", "run-snap"]);
    assert.match(cost.stdout, /1 worker · 520 tokens \(20% cached input\) .*saved at finalization/);
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
  }
});
