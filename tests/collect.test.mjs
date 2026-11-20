import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { collectRun, renderCollect } from "../plugins/orchestrator/scripts/lib/collect.mjs";
import { createRun, loadRun, replacePlan } from "../plugins/orchestrator/scripts/lib/runs.mjs";
import { launchTaskWorker } from "../plugins/orchestrator/scripts/lib/workers.mjs";
import { CLI, checkpointPlan, cleanup, makeRepo, runCli } from "./helpers.mjs";

const fastFixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-codex.mjs");
const repos = [];

after(() => {
  for (const root of repos) cleanup(root);
});

function repo() {
  const root = makeRepo();
  repos.push(root);
  runCli(root, ["init"]);
  runCli(root, ["lane", "add", "api", "--scope", "src/**"]);
  return root;
}

function plan(root, id, taskIds) {
  createRun(root, { id, lane: "api", objective: "Collect reports", maxWorkers: 3, workerModel: "sol", reasoningEffort: "high" });
  replacePlan(root, id, taskIds.map((taskId) => ({
    id: taskId,
    title: taskId,
    objective: `Review ${taskId}`,
    kind: "read",
    acceptance: ["the supervisor accepts it"]
  })));
  checkpointPlan(root, id);
}

function runCliAsync(root, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd: root });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("run collect returns each new report compactly, saves the full report, and lists what is left", async () => {
  const root = repo();
  plan(root, "run-collect", ["alpha", "beta", "gamma"]);
  for (const taskId of ["alpha", "beta"]) {
    launchTaskWorker(root, "run-collect", taskId, { constraints: [] }, { codexCommand: [process.execPath, fastFixture] });
  }

  const woke = await runCliAsync(root, ["run", "collect", "run-collect", "--no-watch", "--interval", "0.1", "--timeout", "15"]);
  assert.equal(woke.code, 0, woke.stderr);
  for (const taskId of ["alpha", "beta"]) {
    assert.match(woke.stdout, new RegExp(`### ${taskId} — reported \\(read, `));
  }
  assert.match(woke.stdout, /Fake worker completed\./);
  assert.match(woke.stdout, /Next: record your verdict: `run verify run-collect alpha --verdict pass\|fail/);
  assert.match(woke.stdout, /Running: none/);
  assert.match(woke.stdout, /Dependencies met, not launched: gamma/);
  const file = woke.stdout.match(/Full report: (.+report\.md)/)[1];
  assert.match(fs.readFileSync(file, "utf8"), /^# alpha: alpha\n/);
  assert.equal(path.basename(path.dirname(file)), loadRun(root, "run-collect").tasks.alpha.attempts.at(-1).id);

  // Nothing new and nothing running: it returns at once and says what still awaits a decision.
  const idle = runCli(root, ["run", "collect", "run-collect", "--json"]);
  assert.equal(idle.code, 3);
  const payload = JSON.parse(idle.stdout);
  assert.deepEqual(payload.changed, []);
  assert.deepEqual(payload.awaiting, [{ taskId: "alpha", status: "reported" }, { taskId: "beta", status: "reported" }]);
  assert.deepEqual(payload.ready, ["gamma"]);
  assert.match(runCli(root, ["run", "collect", "run-collect"]).stdout, /Still awaiting your decision: alpha \(reported\), beta \(reported\)/);
});

test("collect clips long findings and keeps their text, with the full list in the file", () => {
  const root = repo();
  plan(root, "run-clip", ["big"]);
  const run = loadRun(root, "run-clip");
  const task = run.tasks.big;
  task.status = "reported";
  task.attempts = [{ id: "big-attempt-1", model: "gpt-6.2-sol", reasoningEffort: "high" }];
  const paths = Array.from({ length: 40 }, (_, index) => `src/file${index}.js:1–9`).join("; ");
  task.result = {
    summary: "Reviewed.",
    structured: {
      summary: "Reviewed.",
      decisions: Array.from({ length: 45 }, (_, index) => `High | PRD:${index} | WRONG | ${paths} | Conclusion ${index} that matters`),
      tests: [{ command: "node check.mjs", outcome: "PASS" }],
      assumptions: [],
      blockers: [],
      files_touched: [],
      confidence: "medium"
    }
  };
  const collected = collectRun(root, run, {
    outcome: "changed", exitCode: 0, message: "changed", updates: [{ taskId: "big", status: "reported", changed: true }]
  });
  const text = renderCollect(collected, ["big\treported"]);
  assert.match(text, /- High \| PRD:0 \| WRONG \| src\/file0\.js:1–9; src\/file1\.js:1–9; src\/f[^|]*… \| Conclusion 0 that matters/);
  assert.match(text, /- … 5 more in the full report/);
  assert.match(text, /test: node check\.mjs — PASS/);
  assert.match(text, /confidence medium · 45 findings\/decisions · 1 tests · 0 blockers/);
  const full = fs.readFileSync(collected.changed[0].reportFile, "utf8");
  assert.match(full, /## Findings and decisions \(45\)/);
  assert.ok(full.includes(`${paths} | Conclusion 44 that matters`));
});

test("collect shows a paused worker's request even when its task is rendered", () => {
  const collected = {
    message: "paused", updates: [{ taskId: "ask", status: "needs_input", changed: true, inputRequest: { kind: "question" } }, { taskId: "run1", status: "running" }],
    changed: [{ taskId: "ask", status: "needs_input", reportFile: null }], awaiting: [], running: ["run1"], ready: [], text: ["### ask — needs_input"]
  };
  const text = renderCollect(collected, ["ask\tneeds_input\trequest 1: which parser?; answer with `run answer`", "run1\trunning"]);
  assert.match(text, /request 1: which parser\?/);
  assert.doesNotMatch(text, /run1\trunning/);
  assert.match(text, /Running: run1/);
});

test("run result prints one task's compact report, and a settled task has no next action", async () => {
  const root = repo();
  plan(root, "run-result", ["solo"]);
  launchTaskWorker(root, "run-result", "solo", { constraints: [] }, { codexCommand: [process.execPath, fastFixture] });
  assert.equal((await runCliAsync(root, ["run", "collect", "run-result", "--no-watch", "--interval", "0.1", "--timeout", "15"])).code, 0);
  const shown = runCli(root, ["run", "result", "run-result", "solo"]);
  assert.equal(shown.code, 0, shown.stderr);
  assert.match(shown.stdout, /^### solo — reported/);
  assert.match(shown.stdout, /Next: record your verdict/);
  runCli(root, ["run", "verify", "run-result", "solo", "--verdict", "pass", "--evidence", "checked"]);
  assert.match(runCli(root, ["run", "result", "run-result", "solo"]).stdout, /Next: none: the task is accepted/);
  assert.match(runCli(root, ["run", "result", "run-result", "nope"]).stderr, /Unknown task "nope"/);
});
