import assert from "node:assert/strict";
import { test } from "node:test";

import {
  NEXT_ACTIONS,
  NON_TERMINAL_OUTCOMES,
  OUTCOME_ACTIONS,
  OUTCOME_REASON_CODES,
  OUTCOME_PROVENANCE,
  OUTCOME_SCHEMA_VERSION,
  OUTCOME_SIGNALS,
  REASON_CODES,
  TERMINAL_OUTCOMES,
  TERMINAL_OUTCOME_PRECEDENCE,
  classifyTerminalOutcome,
  isOutcomeRecord,
  isTerminalOutcome,
  normalizeOutcomeRecord,
  validateOutcomeRecord
} from "../plugins/orchestrator/scripts/lib/outcomes.mjs";

function validRecord(overrides = {}) {
  const terminalOutcome = Object.hasOwn(overrides, "terminalOutcome")
    ? overrides.terminalOutcome
    : "accepted";
  return {
    version: OUTCOME_SCHEMA_VERSION,
    terminalOutcome,
    action: overrides.action ?? OUTCOME_ACTIONS[terminalOutcome]?.[0] ?? "execute",
    reasonCode: overrides.reasonCode ?? OUTCOME_REASON_CODES[terminalOutcome]?.[0] ?? "supervisor_verified",
    provenance: "supervisor",
    signals: [],
    ...overrides,
    terminalOutcome
  };
}

test("taxonomy constants are frozen, versioned, and contain no duplicates", () => {
  for (const values of [
    TERMINAL_OUTCOMES,
    NEXT_ACTIONS,
    REASON_CODES,
    OUTCOME_SIGNALS,
    OUTCOME_PROVENANCE,
    TERMINAL_OUTCOME_PRECEDENCE
  ]) {
    assert.equal(Object.isFrozen(values), true);
    assert.equal(new Set(values).size, values.length);
  }
  assert.equal(Object.isFrozen(OUTCOME_ACTIONS), true);
  assert.equal(Object.isFrozen(OUTCOME_REASON_CODES), true);
  for (const values of [
    ...Object.values(OUTCOME_ACTIONS),
    ...Object.values(OUTCOME_REASON_CODES)
  ]) {
    assert.equal(Object.isFrozen(values), true);
  }
  assert.equal(OUTCOME_SCHEMA_VERSION, 1);
  assert.deepEqual(new Set(TERMINAL_OUTCOME_PRECEDENCE), new Set(TERMINAL_OUTCOMES));
});

test("every terminal outcome validates", () => {
  for (const terminalOutcome of TERMINAL_OUTCOMES) {
    assert.equal(
      validateOutcomeRecord(validRecord({ terminalOutcome })).terminalOutcome,
      terminalOutcome
    );
  }
});

test("every next action validates", () => {
  for (const action of NEXT_ACTIONS) {
    const terminalOutcome = TERMINAL_OUTCOMES.find((candidate) =>
      OUTCOME_ACTIONS[candidate].includes(action)
    );
    assert.equal(
      validateOutcomeRecord(validRecord({ terminalOutcome, action })).action,
      action
    );
  }
});

test("terminal outcomes reject incompatible actions", () => {
  assert.throws(
    () => validateOutcomeRecord(validRecord({ terminalOutcome: "accepted", action: "refuse" })),
    /cannot use action/
  );
  assert.throws(
    () => validateOutcomeRecord(validRecord({ terminalOutcome: "cancelled", action: "execute" })),
    /cannot use action/
  );
});

test("terminal outcomes reject incompatible reason codes", () => {
  assert.throws(
    () => validateOutcomeRecord(validRecord({
      terminalOutcome: "accepted",
      reasonCode: "integration_conflict"
    })),
    /cannot use reason code/
  );
  assert.throws(
    () => validateOutcomeRecord(validRecord({
      terminalOutcome: "policy_refused",
      reasonCode: "integration_succeeded"
    })),
    /cannot use reason code/
  );
});

test("every reason, signal, and provenance value validates", () => {
  for (const reasonCode of REASON_CODES) {
    const terminalOutcome = TERMINAL_OUTCOMES.find((candidate) =>
      OUTCOME_REASON_CODES[candidate].includes(reasonCode)
    );
    assert.equal(
      validateOutcomeRecord(validRecord({ terminalOutcome, reasonCode })).reasonCode,
      reasonCode
    );
  }
  for (const signal of OUTCOME_SIGNALS) {
    assert.deepEqual(validateOutcomeRecord(validRecord({ signals: [signal] })).signals, [signal]);
  }
  for (const provenance of OUTCOME_PROVENANCE) {
    assert.equal(validateOutcomeRecord(validRecord({ provenance })).provenance, provenance);
  }
});

test("normalization supplies the version, trims enums, and deduplicates signals", () => {
  assert.deepEqual(
    normalizeOutcomeRecord({
      terminalOutcome: " accepted ",
      action: " execute ",
      reasonCode: " supervisor_verified ",
      provenance: " supervisor ",
      signals: ["retry", " retry ", "test_failed"],
      metadata: { attempt: 2 },
      evidence: ["event:verification", { kind: "test", passed: true }]
    }),
    {
      version: 1,
      terminalOutcome: "accepted",
      action: "execute",
      reasonCode: "supervisor_verified",
      provenance: "supervisor",
      signals: ["retry", "test_failed"],
      metadata: { attempt: 2 },
      evidence: ["event:verification", { kind: "test", passed: true }]
    }
  );
});

test("metadata and evidence accept JSON-safe audit context", () => {
  const record = validRecord({
    metadata: { attemptId: "attempt-1", durationMs: 42, nested: { value: null } },
    evidence: ["event-1", { type: "test", refs: ["test-1"] }]
  });
  assert.equal(validateOutcomeRecord(record), record);
  assert.equal(isOutcomeRecord(record), true);
});

test("classification precedence produces one deterministic terminal outcome", () => {
  assert.equal(classifyTerminalOutcome("accepted"), "accepted");
  assert.equal(
    classifyTerminalOutcome(["execution_failed", "contract_failed", "verification_failed"]),
    "verification_failed"
  );
  assert.equal(
    classifyTerminalOutcome(["accepted", "integration_failed", "policy_refused"]),
    "policy_refused"
  );
  assert.equal(classifyTerminalOutcome(["cancelled", "cancelled"]), "cancelled");
});

test("a terminal outcome is required and conflicting arrays are rejected", () => {
  assert.throws(
    () => validateOutcomeRecord(validRecord({ terminalOutcome: undefined })),
    /Invalid terminal outcome/
  );
  assert.throws(
    () => validateOutcomeRecord(validRecord({ terminalOutcome: ["accepted"] })),
    /Invalid terminal outcome/
  );
  assert.throws(
    () => validateOutcomeRecord(validRecord({ terminalOutcome: ["accepted", "cancelled"] })),
    /Invalid terminal outcome/
  );
});

test("invalid enum members are rejected", () => {
  const cases = [
    ["terminalOutcome", "success", /Invalid terminal outcome/],
    ["action", "retry", /Invalid next action/],
    ["reasonCode", "something_happened", /Invalid reason code/],
    ["provenance", "worker", /Invalid provenance/],
    ["signals", ["unknown_signal"], /Invalid outcome signal/]
  ];
  for (const [field, value, message] of cases) {
    assert.throws(() => validateOutcomeRecord(validRecord({ [field]: value })), message);
  }
});

test("invalid versions and record containers are rejected", () => {
  assert.throws(() => validateOutcomeRecord(null), /must be an object/);
  assert.throws(() => validateOutcomeRecord([]), /must be an object/);
  assert.throws(() => validateOutcomeRecord(validRecord({ version: 2 })), /version must be 1/);
  assert.throws(() => normalizeOutcomeRecord("accepted"), /must be an object/);
});

test("signals must be a duplicate-free array", () => {
  assert.throws(
    () => validateOutcomeRecord(validRecord({ signals: "retry" })),
    /signals must be an array/
  );
  assert.throws(
    () => validateOutcomeRecord(validRecord({ signals: ["retry", "retry"] })),
    /duplicate signal: retry/
  );
});

test("metadata and evidence reject non-JSON and incorrectly shaped values", () => {
  assert.throws(
    () => validateOutcomeRecord(validRecord({ metadata: [] })),
    /metadata must be an object/
  );
  assert.throws(
    () => validateOutcomeRecord(validRecord({ metadata: { value: undefined } })),
    /only JSON values/
  );
  assert.throws(
    () => validateOutcomeRecord(validRecord({ metadata: { value: Number.NaN } })),
    /finite JSON numbers/
  );
  assert.throws(
    () => validateOutcomeRecord(validRecord({ evidence: "event-1" })),
    /evidence must be an array/
  );

  const circular = {};
  circular.self = circular;
  assert.throws(
    () => validateOutcomeRecord(validRecord({ evidence: [circular] })),
    /circular references/
  );
});

test("classification rejects empty and unknown observations", () => {
  assert.throws(() => classifyTerminalOutcome([]), /At least one/);
  assert.throws(() => classifyTerminalOutcome(null), /At least one/);
  assert.throws(() => classifyTerminalOutcome(["accepted", "unknown"]), /Invalid terminal outcome/);
});

test("isOutcomeRecord is a non-throwing predicate", () => {
  assert.equal(isOutcomeRecord(validRecord()), true);
  assert.equal(isOutcomeRecord({}), false);
  assert.equal(isOutcomeRecord(null), false);
});

test("needs_input is a non-terminal state that is never stored as an outcome", () => {
  assert.deepEqual(NON_TERMINAL_OUTCOMES, ["needs_input"]);
  assert.equal(TERMINAL_OUTCOMES.includes("needs_input"), false);
  assert.equal(isTerminalOutcome("needs_input"), false);
  assert.equal(isTerminalOutcome("worker_blocked"), true);
  assert.throws(
    () => normalizeOutcomeRecord({
      terminalOutcome: "needs_input",
      action: "clarify",
      reasonCode: "scope_required",
      provenance: "automatic"
    }),
    /non-terminal attempt state, not a terminal outcome/
  );
});
