import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_GUIDANCE_BUDGET,
  GUIDANCE_ACTIONS,
  GUIDANCE_ACTION_BEHAVIOR,
  GUIDANCE_PROVENANCE,
  GUIDANCE_SCHEMA_VERSION,
  GUIDANCE_SELECTION_VERSION,
  GUIDANCE_SOURCE_TYPES,
  GUIDANCE_STATUS,
  createFailureSignature,
  createProvisionalGuidancePolicy,
  deriveReviewedGuidanceSources,
  estimateBriefingTokens,
  resolveGuidancePolicy,
  selectGuidance,
  validateGuidancePolicy,
  validateGuidanceSelection
} from "../plugins/orchestrator/scripts/lib/guidance.mjs";

const ids = {
  labelA: `label-${"a".repeat(32)}`,
  labelB: `label-${"b".repeat(32)}`,
  outcome: `outcome-${"c".repeat(32)}`
};

function source(overrides = {}) {
  return {
    sourceType: "curated_label",
    sourceId: ids.labelA,
    provenance: "supervisor",
    lane: "api",
    taskKind: "write",
    terminalOutcome: "worker_blocked",
    action: "clarify",
    reasonCode: "missing_context",
    signals: ["worker_blocker_reported"],
    ...overrides
  };
}

function context(overrides = {}) {
  const outcome = {
    terminalOutcome: "worker_blocked",
    action: "clarify",
    reasonCode: "missing_context",
    signals: ["worker_blocker_reported"],
    ...(overrides.outcome ?? {})
  };
  return {
    lane: "api",
    taskKind: "write",
    ...overrides,
    outcome
  };
}

function policy(version = "guidance-v1", sources = [source()]) {
  return createProvisionalGuidancePolicy({ policyVersion: version, sources });
}

function clone(value) {
  return structuredClone(value);
}

function learningOutcome(overrides = {}) {
  return {
    terminalOutcome: "worker_blocked",
    action: "clarify",
    reasonCode: "missing_context",
    provenance: "automatic",
    signals: ["worker_blocker_reported"],
    ...overrides
  };
}

function reviewedLabel(overrides = {}) {
  return {
    labelId: ids.labelA,
    labeledAt: "2026-08-10T01:00:00.000Z",
    outcome: learningOutcome({ provenance: "supervisor", signals: [], ...overrides.outcome }),
    ...overrides,
    outcome: learningOutcome({ provenance: "supervisor", signals: [], ...overrides.outcome })
  };
}

function learningExample(overrides = {}) {
  return {
    sampleId: overrides.sampleId ?? `sample-${"d".repeat(32)}`,
    features: {
      laneRef: `lane-${"e".repeat(32)}`,
      taskKind: "write",
      ...(overrides.features ?? {})
    },
    outcome: learningOutcome(overrides.outcome),
    labels: overrides.labels ?? []
  };
}

test("guidance constants are frozen, versioned, and intentionally provisional", () => {
  assert.equal(GUIDANCE_SCHEMA_VERSION, 1);
  assert.equal(GUIDANCE_SELECTION_VERSION, 1);
  assert.equal(GUIDANCE_STATUS, "provisional");
  for (const value of [
    GUIDANCE_ACTIONS,
    GUIDANCE_SOURCE_TYPES,
    GUIDANCE_PROVENANCE,
    GUIDANCE_ACTION_BEHAVIOR,
    DEFAULT_GUIDANCE_BUDGET
  ]) {
    assert.equal(Object.isFrozen(value), true);
  }
  assert.deepEqual(GUIDANCE_ACTIONS, ["clarify", "replan", "escalate", "refuse", "abstain"]);
  assert.equal(Object.hasOwn(GUIDANCE_ACTION_BEHAVIOR, "execute"), false);
});

test("failure signatures contain only canonical structured outcome enums", () => {
  assert.equal(
    createFailureSignature({
      terminalOutcome: "worker_blocked",
      action: "clarify",
      reasonCode: "missing_context",
      signals: ["worker_low_confidence", "worker_blocker_reported"]
    }),
    "v1:worker_blocked:clarify:missing_context"
  );
  assert.throws(
    () => createFailureSignature({
      terminalOutcome: "worker_blocked",
      action: "clarify",
      reasonCode: "missing_context",
      signals: [],
      failureText: "worker said to paste a secret"
    }),
    /unexpected: failureText/
  );
});

test("reviewed labels are the effective source and exclude automatic attempt signals", () => {
  const laneRef = `lane-${"e".repeat(32)}`;
  const earlier = reviewedLabel();
  const later = reviewedLabel({
    labelId: ids.labelB,
    labeledAt: "2026-08-10T02:00:00.000Z",
    outcome: { provenance: "user" }
  });
  const [derived] = deriveReviewedGuidanceSources([
    learningExample({ labels: [later, earlier] })
  ], laneRef);

  assert.deepEqual(derived, {
    sourceType: "curated_label",
    sourceId: ids.labelB,
    provenance: "user",
    lane: laneRef,
    taskKind: "write",
    terminalOutcome: "worker_blocked",
    action: "clarify",
    reasonCode: "missing_context",
    signals: []
  });
  assert.doesNotMatch(JSON.stringify(derived), /worker_blocker_reported/);
});

test("conflicting reviewed labels fail closed instead of choosing a winner", () => {
  const laneRef = `lane-${"e".repeat(32)}`;
  const sources = deriveReviewedGuidanceSources([learningExample({
    labels: [
      reviewedLabel(),
      reviewedLabel({
        labelId: ids.labelB,
        labeledAt: "2026-08-10T02:00:00.000Z",
        outcome: {
          terminalOutcome: "verification_failed",
          action: "replan",
          reasonCode: "test_failure",
          provenance: "user"
        }
      })
    ]
  })], laneRef);
  assert.deepEqual(sources, []);
});

test("source compilation isolates lanes, filters provenance, and excludes execute", () => {
  const laneRef = `lane-${"e".repeat(32)}`;
  const otherLane = `lane-${"f".repeat(32)}`;
  const structured = learningExample({
    sampleId: `sample-${"1".repeat(32)}`,
    outcome: { provenance: "supervisor" }
  });
  const ignored = [
    learningExample({
      sampleId: `sample-${"2".repeat(32)}`,
      labels: [reviewedLabel({ outcome: { provenance: "imported" } })]
    }),
    learningExample({
      sampleId: `sample-${"3".repeat(32)}`,
      features: { laneRef: otherLane }
    }),
    learningExample({
      sampleId: `sample-${"4".repeat(32)}`,
      outcome: {
        terminalOutcome: "accepted",
        action: "execute",
        reasonCode: "supervisor_verified",
        provenance: "supervisor",
        signals: []
      }
    })
  ];
  const sources = deriveReviewedGuidanceSources([structured, ...ignored], laneRef);
  assert.equal(sources.length, 1);
  assert.equal(sources[0].sourceType, "structured_outcome");
  assert.equal(sources[0].provenance, "supervisor");
  assert.equal(sources[0].lane, laneRef);
  assert.equal(sources[0].action, "clarify");
});

test("canonical composite ordering uses code units rather than NUL-ignoring collation", () => {
  const built = policy("code-unit-order-v1", [
    source({ sourceId: ids.labelA, lane: "a" }),
    source({ sourceId: ids.labelB, lane: "A", provenance: "user" })
  ]);
  // ICU collation orders these composite `lane\0taskKind` keys differently
  // and can ignore the NUL delimiter. Raw JS relational ordering is stable.
  assert.deepEqual(built.entries.map((entry) => entry.match.lane), ["A", "a"]);
  assert.equal(validateGuidancePolicy(built), built);
});

test("all five eligible actions derive reviewed behavior from valid labels", () => {
  const cases = [
    ["clarify", "worker_blocked", "missing_context"],
    ["replan", "verification_failed", "test_failure"],
    ["escalate", "authority_escalated", "missing_authority"],
    ["refuse", "policy_refused", "policy_boundary"],
    ["abstain", "cancelled", "task_cancelled"]
  ];
  for (const [index, [action, terminalOutcome, reasonCode]] of cases.entries()) {
    const built = policy(`policy-${action}`, [source({
      sourceId: `label-${String(index + 1).repeat(32)}`,
      terminalOutcome,
      action,
      reasonCode,
      signals: []
    })]);
    assert.equal(built.entries[0].action, action);
    assert.equal(built.entries[0].text, GUIDANCE_ACTION_BEHAVIOR[action]);
    assert.equal(built.status, "provisional");
    assert.match(built.policyHash, /^guidance-policy-[a-f0-9]{32}$/);
    assert.equal(validateGuidancePolicy(built), built);
  }
});

test("policy derivation is deterministic, groups provenance, and ignores input order", () => {
  const first = source();
  const second = source({ sourceId: ids.labelB, provenance: "user" });
  const left = policy("deterministic-v1", [first, second, first]);
  const right = policy("deterministic-v1", [second, first]);
  assert.deepEqual(left, right);
  assert.equal(left.entries.length, 1);
  assert.deepEqual(
    left.entries[0].provenance.map((item) => item.provenance),
    ["supervisor", "user"]
  );
  assert.match(left.entries[0].guidanceId, /^guidance-[a-f0-9]{32}$/);
});

test("selection uses lane, task kind, and exact failure signature", () => {
  const built = policy("matching-v1", [
    source({ lane: "*", taskKind: "*" }),
    source({ sourceId: ids.labelB, lane: "api", taskKind: "write", provenance: "user" }),
    source({
      sourceId: ids.outcome,
      sourceType: "structured_outcome",
      provenance: "supervisor",
      lane: "web",
      taskKind: "read"
    })
  ]);
  const selected = selectGuidance(built, context());
  assert.equal(selected.enabled, true);
  assert.equal(selected.policyVersion, "matching-v1");
  assert.equal(selected.policyHash, built.policyHash);
  assert.equal(selected.status, "provisional");
  assert.equal(selected.items.length, 1);
  assert.equal(selected.items[0].match.lane, "api");
  assert.match(selected.briefing, /Policy matching-v1/);
  assert.match(selected.briefing, /\[clarify; user\]/);
  assert.equal(selected.characterCount, selected.briefing.length);
  assert.equal(selected.estimatedTokens, estimateBriefingTokens(selected.briefing));
  assert.deepEqual(selected.budget, DEFAULT_GUIDANCE_BUDGET);

  assert.equal(selectGuidance(built, context({ lane: "other" })).items[0].match.lane, "*");
  assert.equal(selectGuidance(built, context({ taskKind: "verify" })).items[0].match.taskKind, "*");
  assert.equal(selectGuidance(built, context({
    outcome: { signals: ["worker_low_confidence"] }
  })).items.length, 1);
});

test("character, token, and item budgets bound the exact rendered briefing", () => {
  const built = policy();
  const byCharacters = selectGuidance(built, context(), {
    maxCharacters: 20,
    maxTokens: 300,
    maxItems: 5
  });
  assert.equal(byCharacters.briefing, "");
  assert.equal(byCharacters.items.length, 0);
  assert.equal(byCharacters.truncated, true);

  const byTokens = selectGuidance(built, context(), {
    maxCharacters: 1200,
    maxTokens: 1,
    maxItems: 5
  });
  assert.equal(byTokens.briefing, "");
  assert.equal(byTokens.estimatedTokens, 0);
  assert.equal(byTokens.truncated, true);

  const none = selectGuidance(built, context(), {
    maxCharacters: 1200,
    maxTokens: 300,
    maxItems: 0
  });
  assert.equal(none.items.length, 0);
  assert.equal(none.truncated, true);
});

test("the complete disable path restores byte-empty briefing behavior", () => {
  const disabled = resolveGuidancePolicy(
    [{ corrupt: "policy must not block emergency disable" }],
    { enabled: false, activePolicyVersion: null, rollbackPolicyVersion: null }
  );
  assert.equal(disabled, null);
  assert.deepEqual(selectGuidance(disabled, null), {
    schemaVersion: 1,
    enabled: false,
    policyVersion: null,
    policyHash: null,
    status: null,
    items: [],
    briefing: "",
    characterCount: 0,
    estimatedTokens: 0,
    truncated: false,
    budget: DEFAULT_GUIDANCE_BUDGET
  });
});

test("an enabled policy with no prior failure stays enabled but injects nothing", () => {
  const built = policy("new-task-v1");
  assert.deepEqual(selectGuidance(built, null), {
    schemaVersion: 1,
    enabled: true,
    policyVersion: "new-task-v1",
    policyHash: built.policyHash,
    status: "provisional",
    items: [],
    briefing: "",
    characterCount: 0,
    estimatedTokens: 0,
    truncated: false,
    budget: DEFAULT_GUIDANCE_BUDGET
  });
});

test("an explicit rollback selects an earlier exact policy version", () => {
  const oldPolicy = policy("guidance-v1");
  const currentPolicy = policy("guidance-v2", [source({
    terminalOutcome: "policy_refused",
    action: "refuse",
    reasonCode: "policy_boundary",
    signals: []
  })]);
  const corruptCurrent = clone(currentPolicy);
  corruptCurrent.entries[0].text = "corrupt active policy";
  assert.equal(
    resolveGuidancePolicy([corruptCurrent, oldPolicy], {
      enabled: true,
      activePolicyVersion: "guidance-v2",
      rollbackPolicyVersion: "guidance-v1"
    }).policyVersion,
    "guidance-v1"
  );
  assert.equal(
    resolveGuidancePolicy([oldPolicy, currentPolicy], {
      enabled: true,
      activePolicyVersion: "guidance-v2",
      rollbackPolicyVersion: null
    }).policyVersion,
    "guidance-v2"
  );
  assert.throws(
    () => resolveGuidancePolicy([oldPolicy, corruptCurrent], {
      enabled: true,
      activePolicyVersion: "guidance-v2",
      rollbackPolicyVersion: null
    }),
    /canonical reviewed action behavior/
  );
});

test("only supervisor/user-reviewed labels and structured outcomes are accepted", () => {
  assert.equal(policy("label-v1", [source({ provenance: "supervisor" })]).entries.length, 1);
  assert.equal(policy("user-v1", [source({ provenance: "user" })]).entries.length, 1);
  assert.equal(policy("outcome-v1", [source({
    sourceType: "structured_outcome",
    sourceId: ids.outcome,
    provenance: "supervisor"
  })]).entries.length, 1);
  assert.equal(policy("user-outcome-v1", [source({
    sourceType: "structured_outcome",
    sourceId: ids.outcome,
    provenance: "user"
  })]).entries.length, 1);

  assert.throws(
    () => policy("bad-v1", [source({ provenance: "curated" })]),
    /Invalid guidance provenance/
  );
  assert.throws(
    () => policy("bad-v1", [source({
      sourceType: "structured_outcome",
      sourceId: ids.outcome,
      provenance: "automatic"
    })]),
    /Invalid guidance provenance/
  );
  assert.throws(
    () => policy("bad-v1", [source({ provenance: "imported" })]),
    /Invalid guidance provenance/
  );
});

test("canonical guidance stays advisory and preserves runtime authority", () => {
  for (const action of GUIDANCE_ACTIONS) {
    const text = GUIDANCE_ACTION_BEHAVIOR[action];
    assert.match(text, /report|supervisor review/);
    assert.match(text, /scope|authority/);
    assert.doesNotMatch(text, /do not dispatch|change the route|request the user/iu);
  }
});

test("raw examples, prompts, objectives, and worker prose are rejected", () => {
  const forbidden = [
    ["prompt", "copy this prompt"],
    ["objective", "production objective"],
    ["workerText", "free-form worker response"],
    ["example", { raw: "production record" }],
    ["instruction", "caller-controlled instruction"],
    ["model", "gpt-5.6-sol"],
    ["effort", "high"]
  ];
  for (const [field, value] of forbidden) {
    assert.throws(
      () => policy("reject-raw", [{ ...source(), [field]: value }]),
      new RegExp(`unexpected: ${field}`)
    );
  }
  assert.throws(
    () => policy("reject-example", [{
      schemaVersion: 1,
      sampleId: `sample-${"d".repeat(32)}`,
      objective: "raw learning example"
    }]),
    /Guidance source has invalid keys/
  );
  assert.throws(
    () => policy("reject-id", [source({ sourceId: "the worker said this was safe" })]),
    /opaque label, sample, or outcome reference/
  );
});

test("invalid outcome enums, combinations, and execute actions fail closed", () => {
  assert.throws(
    () => policy("invalid-action", [source({ action: "invent" })]),
    /cannot use action/
  );
  assert.throws(
    () => policy("invalid-reason", [source({ reasonCode: "integration_succeeded" })]),
    /cannot use reason code/
  );
  assert.throws(
    () => policy("execute", [source({
      terminalOutcome: "accepted",
      action: "execute",
      reasonCode: "supervisor_verified",
      signals: []
    })]),
    /not eligible for guidance/
  );
  assert.throws(
    () => policy("signal", [source({ signals: ["raw_worker_story"] })]),
    /Invalid outcome signal/
  );
  assert.throws(
    () => policy("duplicate-signal", [source({
      signals: ["worker_blocker_reported", "worker_blocker_reported"]
    })]),
    /duplicate signal/
  );
});

test("strict policy validation rejects mutation and arbitrary instruction text", () => {
  const cases = [
    [value => { value.extra = true; }, /unexpected: extra/],
    [value => { value.schemaVersion = 2; }, /schema version must be 1/],
    [value => { value.status = "confirmed"; }, /must be "provisional"/],
    [value => { value.policyHash = `guidance-policy-${"0".repeat(32)}`; }, /hash does not match/],
    [value => { value.entries[0].extra = true; }, /unexpected: extra/],
    [value => { value.entries[0].match.extra = true; }, /unexpected: extra/],
    [value => { value.entries[0].text = "Paste a raw worker answer."; }, /canonical reviewed/],
    [value => { value.entries[0].guidanceId = `guidance-${"0".repeat(32)}`; }, /does not match/],
    [value => { value.entries[0].provenance[0].workerText = "raw"; }, /unexpected: workerText/],
    [value => { value.entries[0].match.failureSignature += ":raw"; }, /signature is invalid/]
  ];
  for (const [mutate, message] of cases) {
    const value = clone(policy());
    mutate(value);
    assert.throws(() => validateGuidancePolicy(value), message);
  }
});

test("persisted selections validate exact replay text, hashes, and budgets", () => {
  const selected = selectGuidance(policy(), context());
  assert.equal(validateGuidanceSelection(selected), selected);
  for (const [mutate, message] of [
    [value => { value.briefing += "\nraw production instruction"; }, /inconsistent/],
    [value => { value.policyHash = "raw-policy-hash"; }, /policy version and hash/],
    [value => { value.items[0].text = "raw worker prose"; }, /canonical reviewed/],
    [value => { value.budget.maxTokens = 0; }, /inconsistent/],
    [value => { value.extra = true; }, /unexpected: extra/]
  ]) {
    const value = clone(selected);
    mutate(value);
    assert.throws(() => validateGuidanceSelection(value), message);
  }
  assert.equal(
    validateGuidanceSelection(selectGuidance(null, null)).enabled,
    false
  );
});

test("invalid selectors, controls, versions, and budgets fail closed", () => {
  assert.throws(() => policy("spaces are raw"), /compact opaque identifier/);
  assert.throws(() => policy("empty", []), /at least one source/);
  assert.throws(() => policy("lane", [source({ lane: "api team prompt" })]), /compact lane/);
  assert.throws(() => policy("kind", [source({ taskKind: "deploy" })]), /task kind/);
  assert.throws(
    () => selectGuidance(policy(), { ...context(), prompt: "raw" }),
    /unexpected: prompt/
  );
  assert.throws(
    () => selectGuidance(policy(), context(), { maxCharacters: 1, maxTokens: 1, maxItems: 1, raw: 1 }),
    /unexpected keys: raw/
  );
  assert.throws(
    () => selectGuidance(policy(), context(), { maxTokens: -1 }),
    /non-negative integer/
  );
  assert.throws(
    () => resolveGuidancePolicy([policy()], {
      enabled: true,
      activePolicyVersion: "missing-v1",
      rollbackPolicyVersion: null
    }),
    /is unavailable/
  );
  assert.throws(
    () => resolveGuidancePolicy([policy(), policy()], {
      enabled: true,
      activePolicyVersion: "guidance-v1",
      rollbackPolicyVersion: null
    }),
    /Duplicate guidance policy version/
  );
});

test("one opaque source id cannot silently acquire conflicting facts", () => {
  assert.throws(
    () => policy("conflict-v1", [
      source(),
      source({ lane: "web" })
    ]),
    /has conflicting facts/
  );
});
