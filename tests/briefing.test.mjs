import assert from "node:assert/strict";
import { test } from "node:test";

import { parseFileList, parseResultBlock, renderBriefing } from "../plugins/orchestrator/scripts/lib/briefing.mjs";

const lane = {
  name: "api",
  description: "The HTTP layer.",
  scope: ["src/api/**"],
  constraints: ["No new dependencies."],
  done: "npm test passes."
};

const ledger = {
  isEmpty: false,
  bytes: 120,
  oversized: false,
  populated: [
    ["Decisions", ["(2026-01-01) Errors are returned, never thrown."]],
    ["Failed approaches", ["(2026-01-02) Retrying on 4xx made the flakiness worse."]]
  ]
};

test("a briefing carries objective, constraints, scope, and done criteria", () => {
  const text = renderBriefing({ lane, task: "Add pagination to /users.", ledger });
  assert.match(text, /## Objective/);
  assert.match(text, /Add pagination to \/users\./);
  assert.match(text, /No new dependencies\./);
  assert.match(text, /src\/api\/\*\*/);
  assert.match(text, /npm test passes\./);
});

test("the ledger is included and marked as settled", () => {
  const text = renderBriefing({ lane, task: "x", ledger });
  assert.match(text, /Errors are returned, never thrown\./);
  assert.match(text, /Retrying on 4xx made the flakiness worse\./);
  assert.match(text, /Do not re-derive or re-litigate/);
});

test("an empty ledger produces no established-context section", () => {
  const text = renderBriefing({ lane, task: "x", ledger: { isEmpty: true, populated: [] } });
  assert.doesNotMatch(text, /Established project context/);
});

test("a lane with no scope says so instead of silently allowing everything", () => {
  const text = renderBriefing({ lane: { ...lane, scope: [] }, task: "x", ledger });
  assert.match(text, /No scope patterns are declared/);
});

test("resuming changes the framing and asserts briefing precedence", () => {
  const fresh = renderBriefing({ lane, task: "x", ledger, resuming: false });
  const resumed = renderBriefing({ lane, task: "x", ledger, resuming: true });
  assert.match(fresh, /picking up/);
  assert.match(resumed, /continuing/);
  assert.match(resumed, /the briefing wins/);
});

test("every briefing demands the result contract", () => {
  const text = renderBriefing({ lane, task: "x", ledger });
  assert.match(text, /## RESULT/);
  for (const field of ["files_touched", "decisions", "assumptions", "blockers", "confidence"]) {
    assert.match(text, new RegExp(`${field}:`));
  }
});

test("parseResultBlock extracts fields from a well-formed tail", () => {
  const parsed = parseResultBlock(`Prose about the work.

## RESULT
files_touched: src/api/users.js, src/api/index.js
decisions: kept the cursor opaque
assumptions: none
blockers: none
confidence: high`);

  assert.equal(parsed.found, true);
  assert.deepEqual(parsed.missing, []);
  assert.equal(parsed.fields.decisions, "kept the cursor opaque");
  assert.equal(parsed.fields.confidence, "high");
});

test("a missing block is reported rather than guessed at", () => {
  const parsed = parseResultBlock("I did the thing. Trust me.");
  assert.equal(parsed.found, false);
  assert.equal(parsed.missing.length, 5);
});

test("a partial block reports exactly which fields are missing", () => {
  const parsed = parseResultBlock("## RESULT\nfiles_touched: a.js\nconfidence: low");
  assert.equal(parsed.found, true);
  assert.deepEqual(parsed.missing, ["decisions", "assumptions", "blockers"]);
});

test("the last RESULT block wins when Codex echoes the contract", () => {
  const parsed = parseResultBlock(`## RESULT
files_touched: template.js

Now the real one.

## RESULT
files_touched: actual.js
confidence: high`);
  assert.equal(parsed.fields.files_touched, "actual.js");
});

test("parseFileList normalizes separators, quoting, and none-values", () => {
  assert.deepEqual(parseFileList("a.js, `b.js`\n\"c.js\""), ["a.js", "b.js", "c.js"]);
  assert.deepEqual(parseFileList("none"), []);
  assert.deepEqual(parseFileList("N/A"), []);
  assert.deepEqual(parseFileList(""), []);
  assert.deepEqual(parseFileList(undefined), []);
});
