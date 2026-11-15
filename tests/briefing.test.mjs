import assert from "node:assert/strict";
import { test } from "node:test";

import { parseFileList, parseResultBlock } from "../plugins/orchestrator/scripts/lib/briefing.mjs";

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
