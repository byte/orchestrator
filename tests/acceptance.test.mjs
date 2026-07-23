import assert from "node:assert/strict";
import { test } from "node:test";

import { evaluateRun } from "../plugins/orchestrator/scripts/lib/acceptance.mjs";

const lane = { name: "api", scope: ["src/api/**"] };

function resultBlock(files, extra = {}) {
  return `## RESULT
files_touched: ${files}
decisions: ${extra.decisions ?? "none"}
assumptions: ${extra.assumptions ?? "none"}
blockers: ${extra.blockers ?? "none"}
confidence: ${extra.confidence ?? "high"}`;
}

test("a run inside scope with an accurate result block is clean", () => {
  const evaluation = evaluateRun({
    lane,
    snapshot: { changedFiles: [] },
    changedNow: ["src/api/users.js"],
    resultText: resultBlock("src/api/users.js")
  });
  assert.equal(evaluation.verdict, "clean");
  assert.deepEqual(evaluation.problems, []);
});

test("changes already dirty before dispatch are not attributed to the run", () => {
  const evaluation = evaluateRun({
    lane,
    snapshot: { changedFiles: ["notes.md"] },
    changedNow: ["notes.md", "src/api/users.js"],
    resultText: resultBlock("src/api/users.js")
  });
  assert.deepEqual(evaluation.changed, ["src/api/users.js"]);
  assert.deepEqual(evaluation.preexisting, ["notes.md"]);
  assert.equal(evaluation.verdict, "clean");
});

test("work outside the declared scope is flagged", () => {
  const evaluation = evaluateRun({
    lane,
    snapshot: { changedFiles: [] },
    changedNow: ["src/api/users.js", "src/db/schema.js"],
    resultText: resultBlock("src/api/users.js, src/db/schema.js")
  });
  assert.equal(evaluation.verdict, "review");
  assert.deepEqual(evaluation.outOfScope, ["src/db/schema.js"]);
  assert.match(evaluation.problems.join(" "), /outside the lane's declared scope/);
});

test("files changed but never declared are flagged", () => {
  const evaluation = evaluateRun({
    lane,
    snapshot: { changedFiles: [] },
    changedNow: ["src/api/users.js", "src/api/index.js"],
    resultText: resultBlock("src/api/users.js")
  });
  assert.deepEqual(evaluation.undeclared, ["src/api/index.js"]);
  assert.equal(evaluation.verdict, "review");
});

test("declared files that never changed are flagged as phantom", () => {
  const evaluation = evaluateRun({
    lane,
    snapshot: { changedFiles: [] },
    changedNow: ["src/api/users.js"],
    resultText: resultBlock("src/api/users.js, src/api/never-written.js")
  });
  assert.deepEqual(evaluation.phantom, ["src/api/never-written.js"]);
  assert.match(evaluation.problems.join(" "), /show no actual change/);
});

test("a missing result block cannot be cross-checked and says so", () => {
  const evaluation = evaluateRun({
    lane,
    snapshot: { changedFiles: [] },
    changedNow: ["src/api/users.js"],
    resultText: "All done!"
  });
  assert.equal(evaluation.verdict, "review");
  assert.match(evaluation.problems.join(" "), /no RESULT block/);
  // Without a block there is nothing to compare against, so undeclared is not doubled up.
  assert.deepEqual(evaluation.undeclared, ["src/api/users.js"]);
  assert.doesNotMatch(evaluation.problems.join(" "), /not declared in files_touched/);
});

test("reported blockers and low confidence surface even when the diff is clean", () => {
  const blocked = evaluateRun({
    lane,
    snapshot: { changedFiles: [] },
    changedNow: [],
    resultText: resultBlock("none", { blockers: "needs a schema change outside scope" })
  });
  assert.equal(blocked.verdict, "review");
  assert.match(blocked.problems.join(" "), /reported blockers/);

  const unsure = evaluateRun({
    lane,
    snapshot: { changedFiles: [] },
    changedNow: [],
    resultText: resultBlock("none", { confidence: "low" })
  });
  assert.match(unsure.problems.join(" "), /low confidence/);
});

test("a lane with no scope skips the scope check rather than failing everything", () => {
  const evaluation = evaluateRun({
    lane: { name: "any", scope: [] },
    snapshot: { changedFiles: [] },
    changedNow: ["anywhere.js"],
    resultText: resultBlock("anywhere.js")
  });
  assert.equal(evaluation.verdict, "clean");
  assert.deepEqual(evaluation.outOfScope, []);
});

test("a no-op run that declares nothing is clean", () => {
  const evaluation = evaluateRun({
    lane,
    snapshot: { changedFiles: [] },
    changedNow: [],
    resultText: resultBlock("none")
  });
  assert.equal(evaluation.verdict, "clean");
  assert.deepEqual(evaluation.changed, []);
});
