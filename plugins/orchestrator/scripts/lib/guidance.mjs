import crypto from "node:crypto";

import {
  OUTCOME_ACTIONS,
  OUTCOME_REASON_CODES,
  OUTCOME_SIGNALS,
  TERMINAL_OUTCOMES
} from "./outcomes.mjs";

export const GUIDANCE_SCHEMA_VERSION = 1;
export const GUIDANCE_SELECTION_VERSION = 1;

export const GUIDANCE_ACTIONS = Object.freeze([
  "clarify",
  "replan",
  "escalate",
  "refuse",
  "abstain"
]);

export const GUIDANCE_STATUS = "provisional";

export const GUIDANCE_SOURCE_TYPES = Object.freeze([
  "curated_label",
  "structured_outcome"
]);

export const GUIDANCE_PROVENANCE = Object.freeze([
  "supervisor",
  "user"
]);

export const GUIDANCE_ACTION_BEHAVIOR = Object.freeze({
  clarify: "When material context is missing, report a structured blocker instead of guessing. Keep the assigned scope, route, and authority unchanged.",
  replan: "When task boundaries or dependencies no longer fit, report the mismatch for supervisor replanning. Keep the assigned scope, route, and authority unchanged.",
  escalate: "When required authority or capability is missing, report a structured blocker for supervisor escalation. Do not assume authority or change scope or route.",
  refuse: "When an existing policy boundary applies, report the boundary and stop the prohibited step. Do not change scope, route, or authority.",
  abstain: "When the applicable action is uncertain, report the uncertainty for supervisor review instead of guessing. Keep the assigned scope, route, and authority unchanged."
});

export const DEFAULT_GUIDANCE_BUDGET = Object.freeze({
  maxCharacters: 1200,
  maxTokens: 300,
  maxItems: 5
});

const taskKinds = new Set(["read", "write", "verify"]);
const terminalOutcomes = new Set(TERMINAL_OUTCOMES);
const guidanceActions = new Set(GUIDANCE_ACTIONS);
const reasonCodes = new Set(Object.values(OUTCOME_REASON_CODES).flat());
const outcomeSignals = new Set(OUTCOME_SIGNALS);
const sourceTypes = new Set(GUIDANCE_SOURCE_TYPES);
const provenanceValues = new Set(GUIDANCE_PROVENANCE);
const policyVersionPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const lanePattern = /^(?:\*|[A-Za-z0-9][A-Za-z0-9._:-]{0,127})$/;
const sourceIdPattern = /^(?:label|sample|outcome)-[a-f0-9]{16,64}$/;

/**
 * Build a stable signature from outcome enums only. Arbitrary failure text is
 * intentionally not accepted by this API.
 */
export function createFailureSignature(input) {
  const normalized = normalizeOutcomeEnums(input, "Guidance failure signature");
  return [
    "v1",
    normalized.terminalOutcome,
    normalized.action,
    normalized.reasonCode
  ].join(":");
}

/**
 * Compile the only learning records eligible to seed provisional guidance.
 * Reviewed labels take precedence over the source attempt classification.
 * Signals are copied only from that effective reviewed outcome; automatic
 * attempt signals are never inherited into a reviewed label.
 */
export function deriveReviewedGuidanceSources(examples, laneRef) {
  if (!Array.isArray(examples)) {
    throw new Error("Guidance learning examples must be an array.");
  }
  assertLane(laneRef, false);
  const sources = [];
  for (const example of examples) {
    if (!isPlainObject(example) || !isPlainObject(example.features) ||
        !isPlainObject(example.outcome) || !Array.isArray(example.labels)) {
      throw new Error("Guidance learning example has invalid structure.");
    }
    if (example.features.laneRef !== laneRef) {
      continue;
    }

    const reviewedLabels = example.labels
      .filter((label) =>
        isPlainObject(label) && isPlainObject(label.outcome) &&
        ["supervisor", "user"].includes(label.outcome.provenance)
      )
      .sort((left, right) =>
        compareCodeUnits(left.labeledAt, right.labeledAt) ||
        compareCodeUnits(left.labelId, right.labelId)
      );

    let sourceType;
    let sourceId;
    let effectiveOutcome;
    if (reviewedLabels.length) {
      const distinct = new Set(reviewedLabels.map((label) =>
        guidanceOutcomeKey(label.outcome)
      ));
      if (distinct.size !== 1) {
        continue;
      }
      const selected = reviewedLabels.at(-1);
      sourceType = "curated_label";
      sourceId = selected.labelId;
      effectiveOutcome = selected.outcome;
    } else if (["supervisor", "user"].includes(example.outcome.provenance)) {
      sourceType = "structured_outcome";
      sourceId = `outcome-${String(example.sampleId ?? "").slice("sample-".length)}`;
      effectiveOutcome = example.outcome;
    } else {
      continue;
    }

    const outcome = normalizeOutcomeEnums({
      terminalOutcome: effectiveOutcome.terminalOutcome,
      action: effectiveOutcome.action,
      reasonCode: effectiveOutcome.reasonCode,
      signals: effectiveOutcome.signals
    }, "Effective guidance outcome");
    if (!guidanceActions.has(outcome.action)) {
      continue;
    }
    const candidate = {
      sourceType,
      sourceId,
      provenance: effectiveOutcome.provenance,
      lane: laneRef,
      taskKind: example.features.taskKind,
      ...outcome
    };
    // Reuse the policy boundary validator so direct callers cannot bypass the
    // opaque-id, task-kind, enum, or provenance contracts.
    normalizeSource(candidate);
    sources.push(candidate);
  }
  return sources;
}

/**
 * Derive a deterministic provisional policy from curated labels or an
 * explicitly structured outcome. No caller-supplied instruction text enters
 * the policy: every action maps to a reviewed, static supervisor behavior.
 */
export function createProvisionalGuidancePolicy({ policyVersion, sources }) {
  assertPolicyVersion(policyVersion);
  if (!Array.isArray(sources) || sources.length === 0) {
    throw new Error("A provisional guidance policy requires at least one source.");
  }

  const seenSources = new Map();
  const groups = new Map();
  for (const source of sources) {
    const normalized = normalizeSource(source);
    const sourceIdentity = stableJson(normalized);
    const prior = seenSources.get(normalized.sourceId);
    if (prior && prior !== sourceIdentity) {
      throw new Error(`Guidance source ${normalized.sourceId} has conflicting facts.`);
    }
    if (prior) {
      continue;
    }
    seenSources.set(normalized.sourceId, sourceIdentity);

    const failureSignature = createFailureSignature(normalized.outcome);
    const key = stableJson({
      lane: normalized.lane,
      taskKind: normalized.taskKind,
      failureSignature,
      action: normalized.outcome.action
    });
    let group = groups.get(key);
    if (!group) {
      group = {
        match: {
          lane: normalized.lane,
          taskKind: normalized.taskKind,
          failureSignature
        },
        action: normalized.outcome.action,
        text: GUIDANCE_ACTION_BEHAVIOR[normalized.outcome.action],
        provenance: []
      };
      groups.set(key, group);
    }
    group.provenance.push({
      sourceType: normalized.sourceType,
      provenance: normalized.provenance,
      sourceId: normalized.sourceId
    });
  }

  const entries = [...groups.values()].map((entry) => {
    entry.provenance.sort(compareProvenance);
    const guidanceId = guidanceIdFor(entry);
    return { guidanceId, ...entry };
  }).sort(compareEntries);

  const policyContent = {
    schemaVersion: GUIDANCE_SCHEMA_VERSION,
    policyVersion,
    status: GUIDANCE_STATUS,
    entries
  };
  const policy = {
    schemaVersion: policyContent.schemaVersion,
    policyVersion: policyContent.policyVersion,
    policyHash: policyHashFor(policyContent),
    status: policyContent.status,
    entries: policyContent.entries
  };
  validateGuidancePolicy(policy);
  return policy;
}

/** Validate the exact persisted policy schema, including canonical IDs. */
export function validateGuidancePolicy(policy) {
  assertExactKeys(
    policy,
    ["schemaVersion", "policyVersion", "policyHash", "status", "entries"],
    "Guidance policy"
  );
  if (policy.schemaVersion !== GUIDANCE_SCHEMA_VERSION) {
    throw new Error(`Guidance policy schema version must be ${GUIDANCE_SCHEMA_VERSION}.`);
  }
  assertPolicyVersion(policy.policyVersion);
  if (policy.status !== GUIDANCE_STATUS) {
    throw new Error('Lightweight guidance policy status must be "provisional".');
  }
  if (!Array.isArray(policy.entries) || policy.entries.length === 0) {
    throw new Error("Guidance policy entries must be a non-empty array.");
  }

  const ids = new Set();
  let previousSortKey = null;
  for (const entry of policy.entries) {
    validateEntry(entry);
    if (ids.has(entry.guidanceId)) {
      throw new Error(`Guidance policy contains duplicate id ${entry.guidanceId}.`);
    }
    ids.add(entry.guidanceId);
    const sortKey = entrySortKey(entry);
    if (previousSortKey !== null && compareCodeUnits(sortKey, previousSortKey) < 0) {
      throw new Error("Guidance policy entries must be in canonical order.");
    }
    previousSortKey = sortKey;
  }
  const expectedHash = policyHashFor({
    schemaVersion: policy.schemaVersion,
    policyVersion: policy.policyVersion,
    status: policy.status,
    entries: policy.entries
  });
  if (policy.policyHash !== expectedHash) {
    throw new Error("Guidance policy hash does not match its canonical content.");
  }
  return policy;
}

/**
 * Resolve the active version, an explicit rollback target, or a full kill
 * switch. Disabled resolution deliberately does not load or validate policy
 * bodies, so a malformed policy cannot prevent emergency rollback to the
 * original briefing behavior.
 */
export function resolveGuidancePolicy(policies, controls) {
  assertExactKeys(
    controls,
    ["enabled", "activePolicyVersion", "rollbackPolicyVersion"],
    "Guidance controls"
  );
  if (typeof controls.enabled !== "boolean") {
    throw new Error("Guidance controls enabled must be boolean.");
  }
  if (!controls.enabled) {
    return null;
  }
  if (!Array.isArray(policies)) {
    throw new Error("Guidance policies must be an array.");
  }
  assertPolicyVersion(controls.activePolicyVersion);
  if (controls.rollbackPolicyVersion !== null) {
    assertPolicyVersion(controls.rollbackPolicyVersion);
  }

  const selectedVersion = controls.rollbackPolicyVersion ?? controls.activePolicyVersion;
  // Validate the selected version rather than every stored version. This lets
  // an operator roll back from a malformed active policy to a known-good one.
  const matches = policies.filter((policy) =>
    isPlainObject(policy) && policy.policyVersion === selectedVersion
  );
  if (matches.length === 0) {
    throw new Error(`Guidance policy version ${selectedVersion} is unavailable.`);
  }
  if (matches.length > 1) {
    throw new Error(`Duplicate guidance policy version ${selectedVersion}.`);
  }
  return validateGuidancePolicy(matches[0]);
}

/**
 * Select the most specific applicable provisional item and render the exact
 * bounded block suitable for briefing integration. Passing a null policy is
 * the complete disable path and yields byte-empty briefing text.
 */
export function selectGuidance(policy, context, budget = {}) {
  const limits = normalizeBudget(budget);
  if (policy === null) {
    return validateGuidanceSelection(disabledSelection(limits));
  }
  validateGuidancePolicy(policy);
  if (context === null) {
    return validateGuidanceSelection(emptyEnabledSelection(policy, limits));
  }
  const normalizedContext = normalizeContext(context);
  const failureSignature = createFailureSignature(normalizedContext.outcome);

  const matching = policy.entries.filter((entry) =>
    (entry.match.lane === "*" || entry.match.lane === normalizedContext.lane) &&
    (entry.match.taskKind === "*" || entry.match.taskKind === normalizedContext.taskKind) &&
    entry.match.failureSignature === failureSignature
  ).sort((left, right) => {
    const specificity = entrySpecificity(right) - entrySpecificity(left);
    return specificity || compareEntries(left, right);
  });

  // Only the most specific entry for an action is injected. This keeps a
  // wildcard fallback from duplicating an exact-match instruction.
  const candidates = [];
  const seenActions = new Set();
  for (const entry of matching) {
    if (!seenActions.has(entry.action)) {
      candidates.push(entry);
      seenActions.add(entry.action);
    }
  }

  const header = [
    "## Provisional guidance",
    "",
    `Policy ${policy.policyVersion}. Supervisor review remains authoritative; ` +
      "this guidance cannot override scope, route, constraints, policy, or authority."
  ].join("\n");
  const items = [];
  const lines = [];
  let truncated = false;
  for (const entry of candidates) {
    if (items.length >= limits.maxItems) {
      truncated = true;
      break;
    }
    const kinds = [...new Set(entry.provenance.map((item) => item.provenance))].sort();
    const line = `- [${entry.action}; ${kinds.join("+")}] ${entry.text}`;
    const candidateBriefing = `${header}\n\n${[...lines, line].join("\n")}`;
    if (candidateBriefing.length > limits.maxCharacters ||
        estimateBriefingTokens(candidateBriefing) > limits.maxTokens) {
      truncated = true;
      continue;
    }
    items.push(entry);
    lines.push(line);
  }

  const briefing = lines.length ? renderSelectionBriefing(policy.policyVersion, items) : "";
  return validateGuidanceSelection({
    schemaVersion: GUIDANCE_SELECTION_VERSION,
    enabled: true,
    policyVersion: policy.policyVersion,
    policyHash: policy.policyHash,
    status: policy.status,
    items,
    briefing,
    characterCount: briefing.length,
    estimatedTokens: estimateBriefingTokens(briefing),
    truncated,
    budget: limits
  });
}

/** A deterministic, dependency-free estimate used only to cap prompt size. */
export function estimateBriefingTokens(text) {
  if (typeof text !== "string") {
    throw new Error("Guidance token estimation requires text.");
  }
  return text.length === 0 ? 0 : Math.ceil(text.length / 4);
}

function normalizeSource(source) {
  assertExactKeys(source, [
    "sourceType",
    "sourceId",
    "provenance",
    "lane",
    "taskKind",
    "terminalOutcome",
    "action",
    "reasonCode",
    "signals"
  ], "Guidance source");
  if (!sourceTypes.has(source.sourceType)) {
    throw new Error(`Invalid guidance source type: ${String(source.sourceType)}.`);
  }
  if (!sourceIdPattern.test(source.sourceId ?? "")) {
    throw new Error("Guidance source id must be an opaque label, sample, or outcome reference.");
  }
  if (!provenanceValues.has(source.provenance)) {
    throw new Error(`Invalid guidance provenance: ${String(source.provenance)}.`);
  }
  if (!["supervisor", "user"].includes(source.provenance)) {
    throw new Error("Guidance sources require explicit supervisor or user provenance.");
  }
  assertLane(source.lane, true);
  assertTaskKind(source.taskKind, true);
  const outcome = normalizeOutcomeEnums({
    terminalOutcome: source.terminalOutcome,
    action: source.action,
    reasonCode: source.reasonCode,
    signals: source.signals
  }, "Guidance source outcome");
  if (!guidanceActions.has(outcome.action)) {
    throw new Error(`Outcome action ${outcome.action} is not eligible for guidance.`);
  }
  return {
    sourceType: source.sourceType,
    sourceId: source.sourceId,
    provenance: source.provenance,
    lane: source.lane,
    taskKind: source.taskKind,
    outcome
  };
}

/** Validate a persisted selection without consulting a mutable policy store. */
export function validateGuidanceSelection(selection) {
  assertExactKeys(selection, [
    "schemaVersion",
    "enabled",
    "policyVersion",
    "policyHash",
    "status",
    "items",
    "briefing",
    "characterCount",
    "estimatedTokens",
    "truncated",
    "budget"
  ], "Guidance selection");
  if (selection.schemaVersion !== GUIDANCE_SELECTION_VERSION ||
      typeof selection.enabled !== "boolean" ||
      !Array.isArray(selection.items) ||
      typeof selection.briefing !== "string" ||
      !Number.isInteger(selection.characterCount) || selection.characterCount < 0 ||
      !Number.isInteger(selection.estimatedTokens) || selection.estimatedTokens < 0 ||
      typeof selection.truncated !== "boolean") {
    throw new Error("Guidance selection has invalid scalar fields.");
  }
  const budget = normalizeBudget(selection.budget);
  if (stableJson(budget) !== stableJson(selection.budget)) {
    throw new Error("Guidance selection budget must contain the exact bounded fields.");
  }
  if (!selection.enabled) {
    if (selection.policyVersion !== null || selection.policyHash !== null ||
        selection.status !== null || selection.items.length !== 0 ||
        selection.briefing !== "" || selection.characterCount !== 0 ||
        selection.estimatedTokens !== 0 || selection.truncated) {
      throw new Error("Disabled guidance selection must be empty.");
    }
    return selection;
  }
  assertPolicyVersion(selection.policyVersion);
  if (!/^guidance-policy-[a-f0-9]{32}$/.test(selection.policyHash ?? "") ||
      selection.status !== GUIDANCE_STATUS) {
    throw new Error("Enabled guidance selection requires a provisional policy version and hash.");
  }
  if (selection.items.length > budget.maxItems) {
    throw new Error("Guidance selection exceeds its item budget.");
  }
  const ids = new Set();
  for (const item of selection.items) {
    validateEntry(item);
    if (ids.has(item.guidanceId)) {
      throw new Error("Guidance selection contains duplicate items.");
    }
    ids.add(item.guidanceId);
  }
  const expectedBriefing = renderSelectionBriefing(
    selection.policyVersion,
    selection.items
  );
  if (selection.briefing !== expectedBriefing ||
      selection.characterCount !== selection.briefing.length ||
      selection.estimatedTokens !== estimateBriefingTokens(selection.briefing) ||
      selection.characterCount > budget.maxCharacters ||
      selection.estimatedTokens > budget.maxTokens) {
    throw new Error("Guidance selection briefing or budget metadata is inconsistent.");
  }
  return selection;
}

function normalizeContext(context) {
  assertExactKeys(context, ["lane", "taskKind", "outcome"], "Guidance context");
  assertLane(context.lane, false);
  assertTaskKind(context.taskKind, false);
  return {
    lane: context.lane,
    taskKind: context.taskKind,
    outcome: normalizeOutcomeEnums(context.outcome, "Guidance context outcome")
  };
}

function normalizeOutcomeEnums(input, label) {
  assertExactKeys(input, ["terminalOutcome", "action", "reasonCode", "signals"], label);
  if (!terminalOutcomes.has(input.terminalOutcome)) {
    throw new Error(`Invalid terminal outcome: ${String(input.terminalOutcome)}.`);
  }
  if (!Object.hasOwn(OUTCOME_ACTIONS, input.terminalOutcome) ||
      !OUTCOME_ACTIONS[input.terminalOutcome].includes(input.action)) {
    throw new Error(
      `Terminal outcome "${input.terminalOutcome}" cannot use action "${String(input.action)}".`
    );
  }
  if (!reasonCodes.has(input.reasonCode) ||
      !OUTCOME_REASON_CODES[input.terminalOutcome].includes(input.reasonCode)) {
    throw new Error(
      `Terminal outcome "${input.terminalOutcome}" cannot use reason code ` +
      `"${String(input.reasonCode)}".`
    );
  }
  if (!Array.isArray(input.signals)) {
    throw new Error(`${label} signals must be an array.`);
  }
  const signals = [...input.signals];
  const unique = new Set();
  for (const signal of signals) {
    if (!outcomeSignals.has(signal)) {
      throw new Error(`Invalid outcome signal: ${String(signal)}.`);
    }
    if (unique.has(signal)) {
      throw new Error(`${label} contains duplicate signal ${signal}.`);
    }
    unique.add(signal);
  }
  signals.sort();
  return {
    terminalOutcome: input.terminalOutcome,
    action: input.action,
    reasonCode: input.reasonCode,
    signals
  };
}

function validateEntry(entry) {
  assertExactKeys(
    entry,
    ["guidanceId", "match", "action", "text", "provenance"],
    "Guidance entry"
  );
  assertExactKeys(
    entry.match,
    ["lane", "taskKind", "failureSignature"],
    "Guidance match"
  );
  assertLane(entry.match.lane, true);
  assertTaskKind(entry.match.taskKind, true);
  const signature = parseFailureSignature(entry.match.failureSignature);
  if (!guidanceActions.has(entry.action) || signature.action !== entry.action) {
    throw new Error("Guidance entry action must match an eligible failure signature action.");
  }
  if (entry.text !== GUIDANCE_ACTION_BEHAVIOR[entry.action]) {
    throw new Error("Guidance entry text must be the canonical reviewed action behavior.");
  }
  if (!Array.isArray(entry.provenance) || entry.provenance.length === 0) {
    throw new Error("Guidance entry provenance must be a non-empty array.");
  }
  const seen = new Set();
  let previous = null;
  for (const item of entry.provenance) {
    validateProvenance(item);
    const key = provenanceSortKey(item);
    if (seen.has(key)) {
      throw new Error("Guidance entry contains duplicate provenance.");
    }
    if (previous !== null && compareCodeUnits(key, previous) < 0) {
      throw new Error("Guidance entry provenance must be in canonical order.");
    }
    previous = key;
    seen.add(key);
  }
  if (entry.guidanceId !== guidanceIdFor({
    match: entry.match,
    action: entry.action,
    text: entry.text,
    provenance: entry.provenance
  })) {
    throw new Error("Guidance entry id does not match its canonical content.");
  }
}

function validateProvenance(item) {
  assertExactKeys(
    item,
    ["sourceType", "provenance", "sourceId"],
    "Guidance provenance"
  );
  if (!sourceTypes.has(item.sourceType) || !provenanceValues.has(item.provenance) ||
      !sourceIdPattern.test(item.sourceId ?? "")) {
    throw new Error("Guidance entry provenance is invalid.");
  }
  if (!["supervisor", "user"].includes(item.provenance)) {
    throw new Error("Guidance entry provenance requires supervisor or user review.");
  }
}

function parseFailureSignature(value) {
  if (typeof value !== "string") {
    throw new Error("Guidance failure signature must be a string.");
  }
  const parts = value.split(":");
  if (parts.length !== 4 || parts[0] !== "v1") {
    throw new Error("Guidance failure signature is invalid.");
  }
  const outcome = normalizeOutcomeEnums({
    terminalOutcome: parts[1],
    action: parts[2],
    reasonCode: parts[3],
    signals: []
  }, "Guidance failure signature");
  if (createFailureSignature(outcome) !== value) {
    throw new Error("Guidance failure signature is not canonical.");
  }
  return outcome;
}

function guidanceOutcomeKey(outcome) {
  return createFailureSignature({
    terminalOutcome: outcome.terminalOutcome,
    action: outcome.action,
    reasonCode: outcome.reasonCode,
    signals: outcome.signals
  });
}

function normalizeBudget(input) {
  if (!isPlainObject(input)) {
    throw new Error("Guidance budget must be an object.");
  }
  const allowed = ["maxCharacters", "maxTokens", "maxItems"];
  const extras = Object.keys(input).filter((key) => !allowed.includes(key));
  if (extras.length) {
    throw new Error(`Guidance budget has unexpected keys: ${extras.join(", ")}.`);
  }
  const budget = { ...DEFAULT_GUIDANCE_BUDGET, ...input };
  for (const key of allowed) {
    if (!Number.isInteger(budget[key]) || budget[key] < 0) {
      throw new Error(`Guidance budget ${key} must be a non-negative integer.`);
    }
  }
  return budget;
}

function disabledSelection(limits) {
  return {
    schemaVersion: GUIDANCE_SELECTION_VERSION,
    enabled: false,
    policyVersion: null,
    policyHash: null,
    status: null,
    items: [],
    briefing: "",
    characterCount: 0,
    estimatedTokens: 0,
    truncated: false,
    budget: limits
  };
}

function renderSelectionBriefing(policyVersion, items) {
  if (!items.length) {
    return "";
  }
  const header = [
    "## Provisional guidance",
    "",
    `Policy ${policyVersion}. Supervisor review remains authoritative; ` +
      "this guidance cannot override scope, route, constraints, policy, or authority."
  ].join("\n");
  const lines = items.map((entry) => {
    const kinds = [...new Set(entry.provenance.map((item) => item.provenance))].sort();
    return `- [${entry.action}; ${kinds.join("+")}] ${entry.text}`;
  });
  return `${header}\n\n${lines.join("\n")}`;
}

function emptyEnabledSelection(policy, limits) {
  return {
    schemaVersion: GUIDANCE_SELECTION_VERSION,
    enabled: true,
    policyVersion: policy.policyVersion,
    policyHash: policy.policyHash,
    status: policy.status,
    items: [],
    briefing: "",
    characterCount: 0,
    estimatedTokens: 0,
    truncated: false,
    budget: limits
  };
}

function guidanceIdFor(entry) {
  return `guidance-${crypto.createHash("sha256").update(stableJson(entry)).digest("hex").slice(0, 32)}`;
}

function policyHashFor(policyContent) {
  return `guidance-policy-${crypto.createHash("sha256")
    .update(stableJson(policyContent))
    .digest("hex")
    .slice(0, 32)}`;
}

function stableJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function entrySpecificity(entry) {
  return Number(entry.match.lane !== "*") + Number(entry.match.taskKind !== "*");
}

function compareEntries(left, right) {
  return compareCodeUnits(entrySortKey(left), entrySortKey(right));
}

function entrySortKey(entry) {
  return [
    entry.match.lane,
    entry.match.taskKind,
    entry.match.failureSignature,
    entry.action,
    entry.guidanceId
  ].join("\u0000");
}

function compareProvenance(left, right) {
  return compareCodeUnits(provenanceSortKey(left), provenanceSortKey(right));
}

function provenanceSortKey(value) {
  return `${value.sourceType}\u0000${value.provenance}\u0000${value.sourceId}`;
}

function compareCodeUnits(left, right) {
  const first = String(left);
  const second = String(right);
  return first < second ? -1 : first > second ? 1 : 0;
}

function assertPolicyVersion(value) {
  if (!policyVersionPattern.test(value ?? "")) {
    throw new Error("Guidance policy version must be a compact opaque identifier.");
  }
}

function assertLane(value, allowWildcard) {
  if (!lanePattern.test(value ?? "") || (!allowWildcard && value === "*")) {
    throw new Error("Guidance lane must be a compact lane identifier.");
  }
}

function assertTaskKind(value, allowWildcard) {
  if ((!allowWildcard && value === "*") || (value !== "*" && !taskKinds.has(value))) {
    throw new Error(`Invalid guidance task kind: ${String(value)}.`);
  }
}

function assertExactKeys(value, allowed, label) {
  if (!isPlainObject(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  const missing = allowed.filter((key) => !Object.hasOwn(value, key));
  if (extras.length || missing.length) {
    throw new Error(
      `${label} has invalid keys (missing: ${missing.join(", ") || "none"}; ` +
      `unexpected: ${extras.join(", ") || "none"}).`
    );
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
