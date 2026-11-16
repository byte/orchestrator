/**
 * Stable, machine-readable classifications for terminal task attempts.
 *
 * These values describe learning/audit outcomes. They are deliberately
 * independent from the task lifecycle state machine in runs.mjs.
 */
export const OUTCOME_SCHEMA_VERSION = 1;

export const TERMINAL_OUTCOMES = Object.freeze([
  "accepted",
  "worker_blocked",
  "policy_refused",
  "authority_escalated",
  "execution_failed",
  "contract_failed",
  "verification_failed",
  "integration_failed",
  "cancelled"
]);

/**
 * States an attempt can pause in without ending. `needs_input` means the worker
 * returned a typed request (a scope extension or a question) and is waiting for
 * the supervisor's answer, after which the same attempt continues on the same
 * Codex thread. It is never stored as an outcome record: an attempt that asked
 * is not a failed attempt, and the outcome it eventually ends with is the only
 * one learning data sees. `validateOutcomeRecord` rejects it as a terminal value.
 */
export const NON_TERMINAL_OUTCOMES = Object.freeze(["needs_input"]);

export function isTerminalOutcome(value) {
  return TERMINAL_OUTCOMES.includes(value);
}

export const NEXT_ACTIONS = Object.freeze([
  "execute",
  "clarify",
  "replan",
  "escalate",
  "refuse",
  "abstain"
]);

export const REASON_CODES = Object.freeze([
  "supervisor_verified",
  "worker_reported_blocker",
  "malformed_result_contract",
  "worker_execution_failed",
  "worker_process_failed",
  "worker_launch_failed",
  "missing_result",
  "supervisor_verification_failed",
  "integration_succeeded",
  "integration_inspection_failed",
  "integration_conflict",
  "worktree_unavailable",
  "wrong_branch",
  "scope_violation",
  "branch_drift",
  "dirty_checkout",
  "missing_context",
  "scope_required",
  "ambiguous_objective",
  "test_failure",
  "model_unavailable",
  "policy_boundary",
  "missing_authority",
  "task_cancelled",
  "run_cancelled"
]);

export const OUTCOME_SIGNALS = Object.freeze([
  "worker_blocker_reported",
  "worker_low_confidence",
  "worker_launch_error",
  "worker_process_error",
  "missing_result",
  "malformed_result",
  "test_failed",
  "verification_failed",
  "integration_conflict",
  "integration_inspection_failed",
  "scope_violation",
  "branch_drift",
  "dirty_checkout",
  "worktree_unavailable",
  "wrong_branch",
  "model_unavailable",
  "retry"
]);

export const OUTCOME_PROVENANCE = Object.freeze([
  "automatic",
  "supervisor",
  "user",
  "imported"
]);

export const OUTCOME_ACTIONS = Object.freeze({
  accepted: Object.freeze(["execute"]),
  worker_blocked: Object.freeze(["clarify", "replan", "escalate"]),
  policy_refused: Object.freeze(["refuse"]),
  authority_escalated: Object.freeze(["escalate"]),
  execution_failed: Object.freeze(["execute", "replan", "escalate"]),
  contract_failed: Object.freeze(["replan"]),
  verification_failed: Object.freeze(["replan"]),
  integration_failed: Object.freeze(["replan"]),
  cancelled: Object.freeze(["abstain"])
});

export const OUTCOME_REASON_CODES = Object.freeze({
  accepted: Object.freeze(["supervisor_verified", "integration_succeeded"]),
  worker_blocked: Object.freeze([
    "worker_reported_blocker",
    "missing_context",
    "scope_required",
    "ambiguous_objective",
    "missing_authority",
    "policy_boundary",
    "model_unavailable"
  ]),
  policy_refused: Object.freeze([
    "policy_boundary",
    "scope_violation"
  ]),
  authority_escalated: Object.freeze([
    "missing_authority",
    "scope_required",
    "model_unavailable"
  ]),
  execution_failed: Object.freeze([
    "worker_execution_failed",
    "worker_process_failed",
    "worker_launch_failed",
    "model_unavailable",
    "worktree_unavailable",
    "branch_drift",
    "wrong_branch",
    "dirty_checkout"
  ]),
  contract_failed: Object.freeze([
    "malformed_result_contract",
    "missing_result"
  ]),
  verification_failed: Object.freeze([
    "supervisor_verification_failed",
    "test_failure"
  ]),
  integration_failed: Object.freeze([
    "integration_inspection_failed",
    "integration_conflict",
    "worktree_unavailable",
    "branch_drift",
    "wrong_branch",
    "dirty_checkout"
  ]),
  cancelled: Object.freeze(["task_cancelled", "run_cancelled"])
});

/**
 * When several failures are observed during one attempt, explicit termination
 * decisions take precedence over stage failures, and later pipeline gates take
 * precedence over earlier ones. The selected value is still exactly one
 * terminal outcome; the remaining observations belong in `signals`.
 */
export const TERMINAL_OUTCOME_PRECEDENCE = Object.freeze([
  "cancelled",
  "policy_refused",
  "authority_escalated",
  "integration_failed",
  "verification_failed",
  "contract_failed",
  "execution_failed",
  "worker_blocked",
  "accepted"
]);

const terminalOutcomeSet = new Set(TERMINAL_OUTCOMES);
const actionSet = new Set(NEXT_ACTIONS);
const reasonCodeSet = new Set(REASON_CODES);
const signalSet = new Set(OUTCOME_SIGNALS);
const provenanceSet = new Set(OUTCOME_PROVENANCE);

/**
 * Resolve multiple observed terminal categories using the documented, stable
 * precedence. This helper does not infer categories from run state.
 */
export function classifyTerminalOutcome(observed) {
  const values = typeof observed === "string" ? [observed] : observed;
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error("At least one terminal outcome observation is required.");
  }

  const unique = new Set();
  for (const value of values) {
    assertEnumValue("terminal outcome", value, terminalOutcomeSet);
    unique.add(value);
  }

  return TERMINAL_OUTCOME_PRECEDENCE.find((value) => unique.has(value));
}

/**
 * Normalize an outcome record into its persisted version-1 representation.
 * Enum strings are trimmed and duplicate signals are removed in input order.
 */
export function normalizeOutcomeRecord(input) {
  if (!isPlainObject(input)) {
    throw new Error("Outcome record must be an object.");
  }

  const version = input.version ?? OUTCOME_SCHEMA_VERSION;
  const terminalOutcome = normalizeEnumString(input.terminalOutcome);
  const action = normalizeEnumString(input.action);
  const reasonCode = normalizeEnumString(input.reasonCode);
  const provenance = normalizeEnumString(input.provenance);
  const rawSignals = input.signals ?? [];

  if (!Array.isArray(rawSignals)) {
    throw new Error("Outcome record signals must be an array.");
  }

  const record = {
    version,
    terminalOutcome,
    action,
    reasonCode,
    provenance,
    signals: [...new Set(rawSignals.map(normalizeEnumString))]
  };

  if (Object.hasOwn(input, "metadata")) {
    record.metadata = input.metadata;
  }
  if (Object.hasOwn(input, "evidence")) {
    record.evidence = input.evidence;
  }

  validateOutcomeRecord(record);
  return record;
}

/**
 * Validate a normalized or persisted outcome record. Returns the input record
 * for convenient use at storage boundaries and throws on invalid data.
 */
export function validateOutcomeRecord(record) {
  if (!isPlainObject(record)) {
    throw new Error("Outcome record must be an object.");
  }
  if (record.version !== OUTCOME_SCHEMA_VERSION) {
    throw new Error(
      `Outcome record version must be ${OUTCOME_SCHEMA_VERSION}; received ${String(record.version)}.`
    );
  }

  // A scalar enum is intentional: arrays would permit conflicting terminal
  // classifications on the same attempt.
  if (NON_TERMINAL_OUTCOMES.includes(record.terminalOutcome)) {
    throw new Error(
      `"${record.terminalOutcome}" is a non-terminal attempt state, not a terminal outcome.`
    );
  }
  assertEnumValue("terminal outcome", record.terminalOutcome, terminalOutcomeSet);
  assertEnumValue("next action", record.action, actionSet);
  assertEnumValue("reason code", record.reasonCode, reasonCodeSet);
  assertEnumValue("provenance", record.provenance, provenanceSet);
  if (!OUTCOME_ACTIONS[record.terminalOutcome].includes(record.action)) {
    throw new Error(
      `Terminal outcome "${record.terminalOutcome}" cannot use action "${record.action}".`
    );
  }
  if (!OUTCOME_REASON_CODES[record.terminalOutcome].includes(record.reasonCode)) {
    throw new Error(
      `Terminal outcome "${record.terminalOutcome}" cannot use reason code "${record.reasonCode}".`
    );
  }

  if (!Array.isArray(record.signals)) {
    throw new Error("Outcome record signals must be an array.");
  }
  const seenSignals = new Set();
  for (const signal of record.signals) {
    assertEnumValue("outcome signal", signal, signalSet);
    if (seenSignals.has(signal)) {
      throw new Error(`Outcome record contains duplicate signal: ${signal}.`);
    }
    seenSignals.add(signal);
  }

  if (Object.hasOwn(record, "metadata")) {
    assertJsonValue(record.metadata, "Outcome record metadata");
    if (!isPlainObject(record.metadata)) {
      throw new Error("Outcome record metadata must be an object.");
    }
  }
  if (Object.hasOwn(record, "evidence")) {
    if (!Array.isArray(record.evidence)) {
      throw new Error("Outcome record evidence must be an array.");
    }
    assertJsonValue(record.evidence, "Outcome record evidence");
  }

  return record;
}

export function isOutcomeRecord(value) {
  try {
    validateOutcomeRecord(value);
    return true;
  } catch {
    return false;
  }
}

function normalizeEnumString(value) {
  return typeof value === "string" ? value.trim() : value;
}

function assertEnumValue(label, value, allowed) {
  if (typeof value !== "string" || !allowed.has(value)) {
    throw new Error(`Invalid ${label}: ${String(value)}.`);
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertJsonValue(value, label, seen = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`${label} must contain only finite JSON numbers.`);
    }
    return;
  }
  if (typeof value !== "object") {
    throw new Error(`${label} must contain only JSON values.`);
  }
  if (seen.has(value)) {
    throw new Error(`${label} must not contain circular references.`);
  }

  seen.add(value);
  if (Array.isArray(value)) {
    for (const entry of value) {
      assertJsonValue(entry, label, seen);
    }
  } else {
    if (!isPlainObject(value)) {
      throw new Error(`${label} must contain only plain objects.`);
    }
    for (const entry of Object.values(value)) {
      assertJsonValue(entry, label, seen);
    }
  }
  seen.delete(value);
}
