import { createHash, createHmac, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  OUTCOME_SIGNALS,
  REASON_CODES,
  TERMINAL_OUTCOMES,
  normalizeOutcomeRecord,
  validateOutcomeRecord
} from "./outcomes.mjs";
import {
  REDACTION_VERSION,
  SUPPORTED_REDACTION_VERSIONS,
  redactTextFields
} from "./redaction.mjs";
import {
  LEGACY_WORKER_MODELS,
  WORKER_MODELS,
  eventsFile,
  listRuns,
  loadRun,
  snapshotTaskAssignment
} from "./runs.mjs";
import { atomicWrite, localDir, nowIso } from "./state.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";

export const LEARNING_SCHEMA_VERSION = 1;

// Examples derived from 0.5.x runs keep their legacy slugs, so validation accepts
// the current roster plus the legacy set rather than a hardcoded list.
const LEARNING_MODELS = new Set([
  ...Object.keys(WORKER_MODELS),
  ...Object.keys(LEGACY_WORKER_MODELS)
]);
const LEARNING_EFFORTS = new Set(
  [...Object.values(WORKER_MODELS), ...Object.values(LEGACY_WORKER_MODELS)]
    .flatMap((policy) => policy.efforts)
);
export const LEARNING_EXPORT_VERSION = 1;
export const LEARNING_EXPORT_RECORD_VERSION = 1;
export const LEARNING_IDENTITY_VERSION = 1;
export const DEFAULT_RETENTION_DAYS = 365;
export const LEARNING_TEXT_FIELDS = Object.freeze([
  "runObjective",
  "taskTitle",
  "taskObjective",
  "routingReason"
]);

const SAFE_EVENT_TYPE_LIST = Object.freeze([
  "task.reported",
  "task.execution_failed",
  "task.verified",
  "task.verification_failed",
  "task.integrated",
  "task.disposition_recorded",
  "task.integration_refused",
  "task.integration_failed",
  "task.cancelled",
  "task.resume_fallback",
  "task.sandbox_fallback"
]);
const SAFE_EVENT_TYPES = new Set(SAFE_EVENT_TYPE_LIST);
const LABEL_PROVENANCE = new Set(["supervisor", "user", "imported"]);
const TEXT_CONSENT_PROVENANCE = new Set(["supervisor", "user"]);

export function learningDir(cwd) {
  return path.join(localDir(cwd), "learning");
}

export function learningExamplesFile(cwd) {
  return path.join(learningDir(cwd), "examples.jsonl");
}

export function learningIdentityFile(cwd) {
  return path.join(learningDir(cwd), "identity.json");
}

export function learningExportsDir(cwd) {
  return path.join(learningDir(cwd), "exports");
}

/**
 * Return the repository-local opaque reference used to match learning records
 * to a lane. This is read-only: an absent learning identity produces no
 * reference and does not initialize the store.
 */
export function opaqueLearningLaneRef(cwd, lane) {
  const name = String(lane ?? "").trim();
  if (!name) {
    throw new Error("A lane name is required to derive a learning reference.");
  }
  assertManagedAncestors(cwd);
  const identity = readIdentity(cwd);
  return identity
    ? `lane-${hmac(identity, "lane:v1", name).slice(0, 32)}`
    : null;
}

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function assertSafeNode(target, kind) {
  if (!fs.existsSync(target)) {
    return;
  }
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink()) {
    throw new Error(`Learning ${kind} cannot be a symbolic link: ${target}.`);
  }
}

function assertManagedAncestors(cwd) {
  for (const [target, kind] of [
    [path.dirname(localDir(cwd)), "orchestrator directory"],
    [localDir(cwd), "local directory"],
    [learningDir(cwd), "learning directory"]
  ]) {
    if (!fs.existsSync(target)) {
      continue;
    }
    assertSafeNode(target, kind);
    if (!fs.lstatSync(target).isDirectory()) {
      throw new Error(`Learning managed ancestor is not a directory: ${target}.`);
    }
  }
}

function assertPrivateFileMode(filePath) {
  if (fs.existsSync(filePath) && (fs.statSync(filePath).mode & 0o777) !== 0o600) {
    throw new Error(`Learning file permissions must be 0600: ${filePath}.`);
  }
}

function ensureLearningDirectory(cwd) {
  assertManagedAncestors(cwd);
  const directory = learningDir(cwd);
  assertSafeNode(directory, "directory");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!fs.lstatSync(directory).isDirectory()) {
    throw new Error(`Learning path is not a directory: ${directory}.`);
  }
  fs.chmodSync(directory, 0o700);
  return directory;
}

const LEARNING_LOCK_TIMEOUT_MS = 10000;
const LEARNING_STALE_LOCK_MS = 30000;
const LEARNING_LOCK_SLEEP = new Int32Array(new SharedArrayBuffer(4));

function processIsLive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function withLearningLock(cwd, operation) {
  const directory = ensureLearningDirectory(cwd);
  const lockPath = path.join(directory, "store.lock");
  const deadline = Date.now() + LEARNING_LOCK_TIMEOUT_MS;
  while (true) {
    let descriptor;
    try {
      descriptor = fs.openSync(lockPath, "wx", 0o600);
      fs.writeFileSync(descriptor, `${process.pid}\n`, "utf8");
    } catch (error) {
      if (error.code !== "EEXIST") {
        throw error;
      }
      let owner = null;
      let age = 0;
      try {
        assertSafeNode(lockPath, "lock");
        owner = Number(fs.readFileSync(lockPath, "utf8").trim());
        age = Date.now() - fs.statSync(lockPath).mtimeMs;
      } catch (readError) {
        if (readError.code === "ENOENT") {
          continue;
        }
        throw readError;
      }
      if (!processIsLive(owner) && age > LEARNING_STALE_LOCK_MS) {
        fs.unlinkSync(lockPath);
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for learning store lock ${lockPath}.`);
      }
      Atomics.wait(LEARNING_LOCK_SLEEP, 0, 0, 20);
      continue;
    }
    try {
      for (const filePath of [learningIdentityFile(cwd), learningExamplesFile(cwd)]) {
        if (fs.existsSync(filePath)) {
          assertSafeNode(filePath, "store file");
          fs.chmodSync(filePath, 0o600);
        }
      }
      return operation();
    } finally {
      fs.closeSync(descriptor);
      try {
        fs.unlinkSync(lockPath);
      } catch (error) {
        if (error.code !== "ENOENT") {
          throw error;
        }
      }
    }
  }
}

function hmac(identity, domain, ...values) {
  const body = [domain, ...values].map((value) => String(value)).join("\0");
  return createHmac("sha256", Buffer.from(identity.key, "hex")).update(body).digest("hex");
}

function readIdentity(cwd, { create = false } = {}) {
  const filePath = learningIdentityFile(cwd);
  if (!fs.existsSync(filePath)) {
    if (!create) {
      return null;
    }
    const key = randomBytes(32).toString("hex");
    const temporaryIdentity = { key };
    const identity = {
      schemaVersion: LEARNING_IDENTITY_VERSION,
      key,
      repositoryId: `repo-${hmac(
        temporaryIdentity,
        "repo:v1",
        resolveWorkspaceRoot(cwd)
      ).slice(0, 32)}`,
      createdAt: nowIso()
    };
    atomicWrite(filePath, `${JSON.stringify(identity, null, 2)}\n`);
    fs.chmodSync(filePath, 0o600);
    return identity;
  }
  assertSafeNode(filePath, "identity file");
  assertPrivateFileMode(filePath);
  const identity = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (identity.schemaVersion !== LEARNING_IDENTITY_VERSION ||
      !/^[a-f0-9]{64}$/.test(identity.key ?? "") ||
      !/^repo-[a-f0-9]{32}$/.test(identity.repositoryId ?? "")) {
    throw new Error(`${filePath} contains an invalid learning identity.`);
  }
  return identity;
}

function sourceRefs(identity, runId, taskId, attemptId) {
  return {
    runRef: `run-${hmac(identity, "run:v1", runId).slice(0, 32)}`,
    taskRef: `task-${hmac(identity, "task:v1", runId, taskId).slice(0, 32)}`,
    attemptRef: `attempt-${hmac(
      identity,
      "attempt:v1",
      runId,
      taskId,
      attemptId
    ).slice(0, 32)}`
  };
}

function sampleId(identity, refs, outcomeVersion) {
  return `sample-${hmac(
    identity,
    "sample:v1",
    identity.repositoryId,
    refs.runRef,
    refs.taskRef,
    refs.attemptRef,
    outcomeVersion
  ).slice(0, 32)}`;
}

function assertSampleId(value) {
  if (!/^sample-[a-f0-9]{32}$/.test(String(value ?? ""))) {
    throw new Error("Learning sample id is invalid.");
  }
  return value;
}

function validateFilters({ outcomes = [], sampleIds = [] }) {
  for (const outcome of outcomes) {
    if (!TERMINAL_OUTCOMES.includes(outcome)) {
      throw new Error(`Invalid learning outcome filter: ${String(outcome)}.`);
    }
  }
  for (const id of sampleIds) {
    assertSampleId(id);
  }
}

function annotationId(sample, outcome) {
  return `label-${sha256(canonicalJson({
    sampleId: sample.sampleId,
    terminalOutcome: outcome.terminalOutcome,
    action: outcome.action,
    reasonCode: outcome.reasonCode,
    provenance: outcome.provenance
  })).slice(0, 32)}`;
}

function parseTimestamp(value) {
  const time = Date.parse(value ?? "");
  return Number.isFinite(time) ? time : null;
}

function durationMs(attempt) {
  const start = parseTimestamp(attempt.startedAt ?? attempt.claimedAt);
  const end = parseTimestamp(attempt.finishedAt);
  return start === null || end === null ? null : Math.max(0, end - start);
}

function retentionMetadata(collectedAt, days) {
  const number = Number(days);
  if (!Number.isInteger(number) || number < 0 || number > 36500) {
    throw new Error("Retention days must be an integer from 0 through 36500.");
  }
  return number === 0
    ? { policy: "retain_until_purged", days: 0, expiresAt: null }
    : {
        policy: "expire_after_days",
        days: number,
        expiresAt: new Date(Date.parse(collectedAt) + number * 86400000).toISOString()
      };
}

function readAttemptEvents(cwd, runId) {
  const filePath = eventsFile(cwd, runId);
  const byAttempt = new Map();
  if (!fs.existsSync(filePath)) {
    return byAttempt;
  }
  let planRevision = null;
  const lines = fs.readFileSync(filePath, "utf8").split("\n").filter(Boolean);
  for (const [index, line] of lines.entries()) {
    let event;
    try {
      event = JSON.parse(line);
    } catch (error) {
      throw new Error(`${filePath}:${index + 1} is not valid JSON: ${error.message}`);
    }
    if (event.type === "run.plan_replaced") {
      planRevision = Number.isInteger(event.revision) && event.revision > 0
        ? event.revision
        : null;
      continue;
    }
    if ((!SAFE_EVENT_TYPES.has(event.type) && event.type !== "task.claimed") ||
        typeof event.attemptId !== "string") {
      continue;
    }
    const summary = byAttempt.get(event.attemptId) ?? {
      types: [],
      assignmentPlanRevision: null,
      resultContractFound: null,
      missingContractFieldCount: null,
      verificationEvidenceCount: 0
    };
    if (event.type === "task.claimed") {
      summary.assignmentPlanRevision = planRevision;
      byAttempt.set(event.attemptId, summary);
      continue;
    }
    if (!summary.types.includes(event.type)) {
      summary.types.push(event.type);
    }
    if (event.type === "task.reported") {
      summary.resultContractFound = event.result?.contractFound === true;
      summary.missingContractFieldCount = Array.isArray(event.result?.missingFields)
        ? event.result.missingFields.length
        : null;
    }
    if (["task.verified", "task.verification_failed"].includes(event.type)) {
      summary.verificationEvidenceCount = Array.isArray(event.verification?.evidence)
        ? event.verification.evidence.length
        : 0;
    }
    if (event.type === "task.integrated") {
      summary.verificationEvidenceCount = Array.isArray(event.evidence)
        ? event.evidence.length
        : 0;
    }
    summary.types.sort((left, right) =>
      SAFE_EVENT_TYPE_LIST.indexOf(left) - SAFE_EVENT_TYPE_LIST.indexOf(right)
    );
    byAttempt.set(event.attemptId, summary);
  }
  return byAttempt;
}

function safeOutcome(outcome) {
  return normalizeOutcomeRecord({
    version: outcome.version,
    terminalOutcome: outcome.terminalOutcome,
    action: outcome.action,
    reasonCode: outcome.reasonCode,
    provenance: outcome.provenance,
    signals: outcome.signals ?? []
  });
}

function safeDiagnostics(attempt) {
  return (attempt.diagnostics ?? []).map((diagnostic) => ({
    type: diagnostic.type,
    reasonCode: diagnostic.reasonCode,
    signals: [...new Set(diagnostic.signals ?? [])].sort()
  })).sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
}

function assignmentForAttempt(run, task, attempt, eventSummary) {
  let snapshot = attempt.assignmentSnapshot;
  if (!Object.hasOwn(attempt, "assignmentSnapshot")) {
    // Older attempts have no snapshot. Their current definition is historical
    // only when the event history establishes that no replan followed the claim.
    // Do not silently relabel older attempts, or export another assignment's text.
    if (eventSummary?.assignmentPlanRevision !== run.planRevision ||
        !Number.isInteger(run.planRevision) || run.planRevision < 1) {
      throw new Error(
        `Historical assignment for attempt "${attempt.id}" is unavailable; ` +
          "no snapshot or unchanged claimed plan is established."
      );
    }
    snapshot = snapshotTaskAssignment(run, task);
  }
  assertExactKeys(snapshot, [
    "version", "planRevision", "taskKind", "dependencyCount", "constraintCount",
    "scopeEntryCount", "acceptanceCriterionCount", "model", "reasoningEffort",
    "routeSource", "routingReasonPresent", "text"
  ], "Historical assignment snapshot");
  if (snapshot.version !== 1 || !Number.isInteger(snapshot.planRevision) ||
      snapshot.planRevision < 1) {
    throw new Error("Historical assignment snapshot version or plan revision is invalid.");
  }
  assertExactKeys(snapshot.text, LEARNING_TEXT_FIELDS, "Historical assignment text");
  if (LEARNING_TEXT_FIELDS.some((field) => typeof snapshot.text[field] !== "string")) {
    throw new Error("Historical assignment text fields must be strings.");
  }
  return snapshot;
}

function validateTextOptions(
  includeTextFields,
  consentProvenance,
  acknowledgeSensitiveExport = false
) {
  const fields = [...new Set(includeTextFields ?? [])];
  for (const field of fields) {
    if (!LEARNING_TEXT_FIELDS.includes(field)) {
      throw new Error(
        `Unknown learning text field "${field}". Use: ${LEARNING_TEXT_FIELDS.join(", ")}.`
      );
    }
  }
  if (fields.length > 0 &&
      (!TEXT_CONSENT_PROVENANCE.has(consentProvenance) || !acknowledgeSensitiveExport)) {
    throw new Error(
      "Including text requires --consent user|supervisor and --acknowledge-sensitive-export."
    );
  }
  if (fields.length === 0 && (consentProvenance || acknowledgeSensitiveExport)) {
    throw new Error("Text export consent options require at least one --include-text field.");
  }
  return fields;
}

function deriveExample(
  cwd,
  identity,
  run,
  task,
  attempt,
  attemptIndex,
  eventSummary,
  { retentionDays, collectedAt }
) {
  const refs = sourceRefs(identity, run.id, task.id, attempt.id);
  const eventTypes = eventSummary.types;
  const assignment = assignmentForAttempt(run, task, attempt, eventSummary);
  const record = {
    schemaVersion: LEARNING_SCHEMA_VERSION,
    sampleId: sampleId(identity, refs, attempt.outcome.version),
    fingerprint: "",
    repositoryId: identity.repositoryId,
    source: {
      ...refs,
      runStateVersion: Number(run.version ?? 0),
      outcomeVersion: Number(attempt.outcome.version ?? 0),
      attemptNumber: attemptIndex + 1
    },
    features: {
      laneRef: `lane-${hmac(identity, "lane:v1", run.lane).slice(0, 32)}`,
      taskKind: assignment.taskKind,
      planRevision: assignment.planRevision,
      dependencyCount: assignment.dependencyCount,
      constraintCount: assignment.constraintCount,
      scopeEntryCount: assignment.scopeEntryCount,
      acceptanceCriterionCount: assignment.acceptanceCriterionCount,
      retryCount: attemptIndex,
      terminalStatus: attempt.status,
      resultContractFound: eventSummary.resultContractFound,
      missingContractFieldCount: eventSummary.missingContractFieldCount,
      model: attempt.model ?? assignment.model,
      reasoningEffort: attempt.reasoningEffort ?? assignment.reasoningEffort,
      routeSource: assignment.routeSource,
      routingReasonPresent: assignment.routingReasonPresent,
      // True only when the attempt really continued an earlier attempt's Codex
      // thread; a warm retry that fell back to a fresh thread counts as cold.
      warmStart: Boolean(attempt.resumedFromAttemptId) && !attempt.resumeFallback
    },
    outcome: safeOutcome(attempt.outcome),
    diagnostics: safeDiagnostics(attempt),
    eventTypes,
    verificationVerdict: eventTypes.includes("task.verified") ||
        eventTypes.includes("task.integrated")
      ? "pass"
      : eventTypes.includes("task.verification_failed")
        ? "fail"
        : null,
    verificationEvidenceCount: eventSummary.verificationEvidenceCount,
    runFinalizationVerdict: run.finalization?.verdict ?? null,
    finalizationEvidenceCount: run.finalization?.evidence?.length ?? 0,
    timing: {
      durationMs: durationMs(attempt)
    },
    derivation: {
      provenance: "local_run_state",
      collectedAt,
      updatedAt: collectedAt
    },
    consent: {
      mode: "metadata_only",
      provenance: "default_local_policy",
      textFields: [],
      grantedAt: null
    },
    redaction: {
      version: REDACTION_VERSION,
      appliedFields: [],
      findings: {}
    },
    retention: {
      ...retentionMetadata(attempt.finishedAt ?? collectedAt, retentionDays),
      rawAuditManaged: false
    },
    labels: []
  };
  record.fingerprint = `fp-${hmac(identity, "fingerprint:v1", canonicalJson({
    features: record.features,
    outcome: record.outcome,
    diagnostics: record.diagnostics,
    eventTypes: record.eventTypes,
    verificationVerdict: record.verificationVerdict,
    verificationEvidenceCount: record.verificationEvidenceCount,
    runFinalizationVerdict: record.runFinalizationVerdict,
    finalizationEvidenceCount: record.finalizationEvidenceCount,
    timing: record.timing
  })).slice(0, 32)}`;
  validateLearningExample(record);
  return record;
}

function mergeCollectedExample(existing, derived) {
  if (!existing) {
    return { example: derived, changed: true, created: true };
  }
  const next = {
    ...derived,
    derivation: {
      ...derived.derivation,
      collectedAt: existing.derivation.collectedAt
    },
    labels: existing.labels ?? []
  };
  const left = { ...existing, derivation: { ...existing.derivation, updatedAt: null } };
  const right = { ...next, derivation: { ...next.derivation, updatedAt: null } };
  if (canonicalJson(left) === canonicalJson(right)) {
    return { example: existing, changed: false, created: false };
  }
  next.derivation.updatedAt = derived.derivation.updatedAt;
  validateLearningExample(next);
  return { example: next, changed: true, created: false };
}

function loadExamplesFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  assertSafeNode(filePath, "examples file");
  assertPrivateFileMode(filePath);
  const contents = fs.readFileSync(filePath, "utf8");
  const examples = contents.split("\n").filter(Boolean).map((line, index) => {
    let example;
    try {
      example = JSON.parse(line);
    } catch (error) {
      throw new Error(`${filePath}:${index + 1} is not valid JSON: ${error.message}`);
    }
    try {
      validateLearningExample(example);
    } catch (error) {
      throw new Error(`${filePath}:${index + 1} is not a valid learning example: ${error.message}`);
    }
    return example;
  });
  const ids = new Set();
  for (const example of examples) {
    if (ids.has(example.sampleId)) {
      throw new Error(`${filePath} contains duplicate sample id ${example.sampleId}.`);
    }
    ids.add(example.sampleId);
  }
  return examples.sort((left, right) => left.sampleId.localeCompare(right.sampleId));
}

function writeExamplesFile(filePath, examples) {
  const lines = [...examples]
    .sort((left, right) => left.sampleId.localeCompare(right.sampleId))
    .map((example) => {
      validateLearningExample(example);
      return JSON.stringify(example);
    });
  atomicWrite(filePath, lines.length ? `${lines.join("\n")}\n` : "");
  fs.chmodSync(filePath, 0o600);
  return examples;
}

export function loadLearningExamples(cwd) {
  assertManagedAncestors(cwd);
  const directory = learningDir(cwd);
  if (fs.existsSync(directory)) {
    assertSafeNode(directory, "directory");
    if (!fs.lstatSync(directory).isDirectory()) {
      throw new Error(`Learning path is not a directory: ${directory}.`);
    }
    if ((fs.statSync(directory).mode & 0o777) !== 0o700) {
      throw new Error(`Learning directory permissions must be 0700: ${directory}.`);
    }
  }
  return loadExamplesFile(learningExamplesFile(cwd));
}

export function collectLearningExamples(
  cwd,
  {
    runIds = [],
    retentionDays = DEFAULT_RETENTION_DAYS,
    collectedAt = nowIso()
  } = {}
) {
  retentionMetadata(collectedAt, retentionDays);
  const runs = runIds.length
    ? [...new Set(runIds)].map((runId) => loadRun(cwd, runId))
    : listRuns(cwd);
  const filePath = learningExamplesFile(cwd);
  return withLearningLock(cwd, () => {
    if (!fs.existsSync(learningIdentityFile(cwd)) &&
        fs.existsSync(filePath) && fs.statSync(filePath).size > 0) {
      throw new Error(
        "Learning identity is missing while samples still exist; purge by sample or --all before recollecting."
      );
    }
    const identity = readIdentity(cwd, { create: true });
    const existing = loadExamplesFile(filePath);
    const byId = new Map(existing.map((example) => [example.sampleId, example]));
    let scannedAttempts = 0;
    let created = 0;
    let updated = 0;
    let unchanged = 0;
    let skippedWithoutOutcome = 0;
    for (const run of runs) {
      const events = readAttemptEvents(cwd, run.id);
      for (const task of Object.values(run.tasks ?? {})) {
        for (const [attemptIndex, attempt] of (task.attempts ?? []).entries()) {
          scannedAttempts += 1;
          if (!attempt.outcome) {
            skippedWithoutOutcome += 1;
            continue;
          }
          const derived = deriveExample(cwd, identity, run, task, attempt, attemptIndex,
            events.get(attempt.id) ?? {
              types: [],
              resultContractFound: null,
              missingContractFieldCount: null,
              verificationEvidenceCount: 0
            }, {
              retentionDays,
              collectedAt
            });
          const merged = mergeCollectedExample(byId.get(derived.sampleId), derived);
          byId.set(derived.sampleId, merged.example);
          if (merged.created) {
            created += 1;
          } else if (merged.changed) {
            updated += 1;
          } else {
            unchanged += 1;
          }
        }
      }
    }
    const examples = [...byId.values()];
    if (created > 0 || updated > 0 || !fs.existsSync(filePath)) {
      writeExamplesFile(filePath, examples);
    }
    return {
      scannedRuns: runs.length,
      scannedAttempts,
      created,
      updated,
      unchanged,
      skippedWithoutOutcome,
      total: examples.length,
      file: filePath
    };
  });
}

function matchesFilters(example, filters) {
  if (filters.runRefs?.length && !filters.runRefs.includes(example.source.runRef)) {
    return false;
  }
  if (filters.outcomes?.length && !filters.outcomes.includes(example.outcome.terminalOutcome)) {
    return false;
  }
  if (filters.sampleIds?.length && !filters.sampleIds.includes(example.sampleId)) {
    return false;
  }
  return true;
}

export function listLearningExamples(cwd, filters = {}) {
  validateFilters(filters);
  const normalized = { ...filters };
  if (filters.runIds?.length) {
    const identity = readIdentity(cwd);
    if (!identity) {
      return [];
    }
    normalized.runRefs = filters.runIds.map((runId) =>
      `run-${hmac(identity, "run:v1", runId).slice(0, 32)}`
    );
  }
  return loadLearningExamples(cwd).filter((example) => matchesFilters(example, normalized));
}

export function inspectLearningExample(cwd, id) {
  assertSampleId(id);
  const sample = loadLearningExamples(cwd).find((example) => example.sampleId === id);
  if (!sample) {
    throw new Error(`Unknown learning sample "${id}".`);
  }
  return sample;
}

export function labelLearningExample(
  cwd,
  id,
  { terminalOutcome, action, reasonCode, provenance, labeledAt = nowIso() }
) {
  assertSampleId(id);
  if (!LABEL_PROVENANCE.has(provenance)) {
    throw new Error("Learning labels require provenance: supervisor, user, or imported.");
  }
  const outcome = normalizeOutcomeRecord({
    terminalOutcome,
    action,
    reasonCode,
    provenance,
    signals: []
  });
  const filePath = learningExamplesFile(cwd);
  return withLearningLock(cwd, () => {
    const examples = loadExamplesFile(filePath);
    const sample = examples.find((example) => example.sampleId === id);
    if (!sample) {
      throw new Error(`Unknown learning sample "${id}".`);
    }
    const idValue = annotationId(sample, outcome);
    const existing = sample.labels.find((label) => label.labelId === idValue);
    if (existing) {
      return { sample, label: existing, created: false };
    }
    const label = { labelId: idValue, labeledAt, outcome };
    sample.labels.push(label);
    sample.derivation.updatedAt = labeledAt;
    writeExamplesFile(filePath, examples);
    return { sample, label, created: true };
  });
}

function exportName(value, exportedAt) {
  const requested = String(value ?? "").trim();
  const generated = `export-${exportedAt.replace(/\D/g, "").slice(0, 14)}`;
  const name = requested || generated;
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(name)) {
    throw new Error("Learning export names use lowercase letters, digits, dot, dash, or underscore.");
  }
  return name;
}

function sourceTextForExample(cwd, identity, example) {
  for (const run of listRuns(cwd)) {
    for (const task of Object.values(run.tasks ?? {})) {
      for (const attempt of task.attempts ?? []) {
        const refs = sourceRefs(identity, run.id, task.id, attempt.id);
        if (refs.attemptRef === example.source.attemptRef) {
          const summary = Object.hasOwn(attempt, "assignmentSnapshot")
            ? null
            : readAttemptEvents(cwd, run.id).get(attempt.id);
          return assignmentForAttempt(run, task, attempt, summary).text;
        }
      }
    }
  }
  throw new Error(`Raw source for learning sample "${example.sampleId}" is unavailable.`);
}

export function exportLearningExamples(
  cwd,
  {
    name = null,
    runIds = [],
    outcomes = [],
    sampleIds = [],
    includeTextFields = [],
    consentProvenance = null,
    acknowledgeSensitiveExport = false,
    exportedAt = nowIso()
  } = {}
) {
  validateFilters({ outcomes, sampleIds });
  for (const runId of [...new Set(runIds)]) {
    loadRun(cwd, runId);
  }
  const fields = validateTextOptions(
    includeTextFields,
    consentProvenance,
    acknowledgeSensitiveExport
  );
  return withLearningLock(cwd, () => {
    const identity = readIdentity(cwd);
    if (!identity) {
      throw new Error("No learning store exists. Run `orch learn collect` first.");
    }
    const examples = listLearningExamples(cwd, { runIds, outcomes, sampleIds });
    const foundIds = new Set(examples.map((example) => example.sampleId));
    const missingIds = sampleIds.filter((id) => !foundIds.has(id));
    if (missingIds.length) {
      throw new Error("One or more requested learning samples do not exist or match the filters.");
    }
    if ((runIds.length || outcomes.length || sampleIds.length) && examples.length === 0) {
      throw new Error("No learning samples matched the explicit export filters.");
    }
    const exportedExamples = examples.map((example) => {
      if (!fields.length) {
        return { exportRecordVersion: LEARNING_EXPORT_RECORD_VERSION, example };
      }
      const selected = sourceTextForExample(cwd, identity, example);
      const redacted = redactTextFields(selected, fields);
      const boundedText = Object.fromEntries(Object.entries(redacted.text).map(([field, value]) =>
        [field, value.length > 8000 ? `${value.slice(0, 7980)}<truncated>` : value]
      ));
      return {
        exportRecordVersion: LEARNING_EXPORT_RECORD_VERSION,
        example,
        text: boundedText,
        consent: {
          mode: "explicit_text_export",
          provenance: consentProvenance,
          textFields: fields,
          grantedAt: exportedAt,
          grantId: `consent-${hmac(
            identity,
            "consent:v1",
            exportedAt,
            consentProvenance,
            ...fields
          ).slice(0, 32)}`
        },
        redaction: {
          version: REDACTION_VERSION,
          findings: redacted.findings
        }
      };
    });
    const jsonl = exportedExamples.map((example) => JSON.stringify(example)).join("\n") +
      (exportedExamples.length ? "\n" : "");
    const exportId = exportName(name, exportedAt);
    const root = learningExportsDir(cwd);
    assertSafeNode(root, "exports directory");
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    fs.chmodSync(root, 0o700);
    const target = path.join(root, exportId);
    if (fs.existsSync(target)) {
      throw new Error(`Learning export "${exportId}" already exists.`);
    }
    const temporary = path.join(root, `.${exportId}.${process.pid}.${Date.now()}.tmp`);
    fs.mkdirSync(temporary, { mode: 0o700 });
    const manifest = {
      exportVersion: LEARNING_EXPORT_VERSION,
      exportRecordVersion: LEARNING_EXPORT_RECORD_VERSION,
      learningSchemaVersion: LEARNING_SCHEMA_VERSION,
      redactionVersion: REDACTION_VERSION,
      exportId,
      exportedAt,
      sampleCount: exportedExamples.length,
      sampleIds: exportedExamples.map((record) => record.example.sampleId),
      repositoryIds: [...new Set(
        exportedExamples.map((record) => record.example.repositoryId)
      )].sort(),
      filters: {
        runRefs: runIds.map((runId) =>
          `run-${hmac(identity, "run:v1", runId).slice(0, 32)}`
        ).sort(),
        outcomes: [...new Set(outcomes)].sort(),
        sampleIds: [...new Set(sampleIds)].sort()
      },
      consent: fields.length
        ? {
            mode: "explicit_text_export",
            provenance: consentProvenance,
            textFields: fields,
            grantedAt: exportedAt,
            grantId: `consent-${hmac(
              identity,
              "consent:v1",
              exportedAt,
              consentProvenance,
              ...fields
            ).slice(0, 32)}`
          }
        : {
            mode: "metadata_only",
            provenance: "default_local_policy",
            textFields: [],
            grantedAt: null,
            grantId: null
          },
      retention: { rawAuditManaged: false },
      provenance: {
        kind: "derived_local_export",
        source: "managed_learning_store"
      },
      examplesSha256: sha256(jsonl),
      files: { examples: "examples.jsonl" }
    };
    const temporaryExamples = path.join(temporary, "examples.jsonl");
    const temporaryManifest = path.join(temporary, "manifest.json");
    try {
      atomicWrite(temporaryExamples, jsonl);
      atomicWrite(temporaryManifest, `${JSON.stringify(manifest, null, 2)}\n`);
      fs.chmodSync(temporaryExamples, 0o600);
      fs.chmodSync(temporaryManifest, 0o600);
      fs.renameSync(temporary, target);
    } finally {
      if (fs.existsSync(temporary)) {
        fs.rmSync(temporary, { recursive: true });
      }
    }
    const examplesPath = path.join(target, "examples.jsonl");
    const manifestPath = path.join(target, "manifest.json");
    return { directory: target, examplesFile: examplesPath, manifestFile: manifestPath, manifest };
  });
}

function selectorMatches(example, { sampleIds, runRefs, taskRefs, attemptRefs, expired, now }) {
  if (sampleIds.includes(example.sampleId)) {
    return true;
  }
  if (attemptRefs.length && attemptRefs.includes(example.source.attemptRef)) {
    return true;
  }
  if (!attemptRefs.length && taskRefs.length && taskRefs.includes(example.source.taskRef)) {
    return true;
  }
  if (!attemptRefs.length && !taskRefs.length && runRefs.includes(example.source.runRef)) {
    return true;
  }
  return expired && example.retention.expiresAt !== null &&
    Date.parse(example.retention.expiresAt) <= Date.parse(now);
}

function removeAffectedExports(cwd, removedIds, selectors, all) {
  const root = learningExportsDir(cwd);
  if (!fs.existsSync(root)) {
    return [];
  }
  assertSafeNode(root, "exports directory");
  fs.chmodSync(root, 0o700);
  const plans = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    assertSafeNode(target, "export directory");
    if (!entry.isDirectory()) {
      plans.push({ name: entry.name, target, remove: true });
      continue;
    }
    fs.chmodSync(target, 0o700);
    if (all || entry.name.startsWith(".")) {
      plans.push({ name: entry.name, target, remove: true });
      continue;
    }
    const manifestPath = path.join(target, "manifest.json");
    const examplesPath = path.join(target, "examples.jsonl");
    let remove = false;
    try {
      assertSafeNode(manifestPath, "export manifest");
      assertSafeNode(examplesPath, "export examples file");
      const examplesText = fs.readFileSync(examplesPath, "utf8");
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      const actualExamples = examplesText.split("\n").filter(Boolean).map((line) => {
        const record = JSON.parse(line);
        const exportedExample = record?.example;
        const id = exportedExample?.sampleId;
        if (!/^sample-[a-f0-9]{32}$/.test(id ?? "")) {
          throw new Error("invalid sample id");
        }
        return exportedExample;
      });
      const actualIds = actualExamples.map((example) => example.sampleId);
      const manifestIds = manifest.sampleIds;
      if (manifest.exportVersion !== LEARNING_EXPORT_VERSION ||
          manifest.exportRecordVersion !== LEARNING_EXPORT_RECORD_VERSION ||
          manifest.learningSchemaVersion !== LEARNING_SCHEMA_VERSION ||
          !SUPPORTED_REDACTION_VERSIONS.includes(manifest.redactionVersion) ||
          manifest.sampleCount !== actualIds.length ||
          new Set(actualIds).size !== actualIds.length ||
          manifest.provenance?.kind !== "derived_local_export" ||
          !Array.isArray(manifestIds) ||
          canonicalJson([...new Set(manifestIds)].sort()) !==
            canonicalJson([...new Set(actualIds)].sort()) ||
          manifest.examplesSha256 !== sha256(examplesText)) {
        throw new Error("export manifest does not match examples");
      }
      remove = actualExamples.some((example) =>
        removedIds.has(example.sampleId) || selectorMatches(example, selectors)
      );
    } catch {
      // A corrupt or incomplete managed export has unknown membership. Any
      // explicit purge removes it conservatively so derived copies cannot hide
      // outside the canonical sample index.
      remove = true;
    }
    plans.push({ name: entry.name, target, remove });
  }
  const removed = [];
  for (const plan of plans.filter((entry) => entry.remove)) {
    fs.rmSync(plan.target, { recursive: true });
    removed.push(plan.name);
  }
  return removed;
}

export function purgeLearningExamples(
  cwd,
  {
    sampleIds = [],
    runIds = [],
    taskIds = [],
    attemptIds = [],
    expired = false,
    all = false,
    now = nowIso()
  } = {}
) {
  for (const id of sampleIds) {
    assertSampleId(id);
  }
  if (!validIso(now)) {
    throw new Error("Learning purge time must be an ISO timestamp.");
  }
  if (!all && !expired &&
      sampleIds.length + runIds.length + taskIds.length + attemptIds.length === 0) {
    throw new Error("Learning purge requires a selector, --expired, or --all.");
  }
  if (taskIds.length && !runIds.length) {
    throw new Error("Learning purge --task requires --run.");
  }
  if (attemptIds.length && (!runIds.length || !taskIds.length)) {
    throw new Error("Learning purge --attempt requires both --run and --task.");
  }
  if (all && (expired || sampleIds.length || runIds.length || taskIds.length || attemptIds.length)) {
    throw new Error("Learning purge --all cannot be combined with other selectors.");
  }
  if (expired && (sampleIds.length || runIds.length || taskIds.length || attemptIds.length)) {
    throw new Error("Learning purge --expired cannot be combined with source selectors.");
  }
  const filePath = learningExamplesFile(cwd);
  return withLearningLock(cwd, () => {
    const needsIdentity = runIds.length || taskIds.length || attemptIds.length;
    const identity = needsIdentity ? readIdentity(cwd) : null;
    if (needsIdentity && !identity) {
      throw new Error("Learning source purge requires the store identity file.");
    }
    const selectors = {
      sampleIds: [...new Set(sampleIds)],
      runRefs: runIds.map((runId) =>
        `run-${hmac(identity, "run:v1", runId).slice(0, 32)}`
      ),
      taskRefs: runIds.flatMap((runId) => taskIds.map((taskId) =>
        `task-${hmac(identity, "task:v1", runId, taskId).slice(0, 32)}`
      )),
      attemptRefs: runIds.flatMap((runId) => taskIds.flatMap((taskId) =>
        attemptIds.map((attemptId) => `attempt-${hmac(
          identity,
          "attempt:v1",
          runId,
          taskId,
          attemptId
        ).slice(0, 32)}`)
      )),
      expired,
      now
    };
    const examples = loadExamplesFile(filePath);
    const removed = examples.filter((example) => all || selectorMatches(example, selectors));
    const kept = examples.filter((example) => !removed.includes(example));
    const labelsRemoved = removed.reduce((count, example) => count + example.labels.length, 0);
    const exportsRemoved = removeAffectedExports(
      cwd,
      new Set([
        ...removed.map((example) => example.sampleId),
        ...sampleIds
      ]),
      selectors,
      all
    );
    if (removed.length > 0 || !fs.existsSync(filePath)) {
      writeExamplesFile(filePath, kept);
    }
    return {
      removed: removed.map((example) => example.sampleId),
      removedCount: removed.length,
      labelsRemoved,
      exportsRemoved,
      remaining: kept.length
    };
  });
}

export function validateLearningExample(example) {
  if (!example || typeof example !== "object" || Array.isArray(example)) {
    throw new Error("Learning example must be an object.");
  }
  if (example.schemaVersion !== LEARNING_SCHEMA_VERSION) {
    throw new Error(`Learning schema version must be ${LEARNING_SCHEMA_VERSION}.`);
  }
  if (!/^sample-[a-f0-9]{32}$/.test(example.sampleId ?? "")) {
    throw new Error("Learning sample id is invalid.");
  }
  if (!/^repo-[a-f0-9]{32}$/.test(example.repositoryId ?? "")) {
    throw new Error("Learning repository id is invalid.");
  }
  assertExactKeys(example, [
    "schemaVersion",
    "sampleId",
    "fingerprint",
    "repositoryId",
    "source",
    "features",
    "outcome",
    "diagnostics",
    "eventTypes",
    "verificationVerdict",
    "verificationEvidenceCount",
    "runFinalizationVerdict",
    "finalizationEvidenceCount",
    "timing",
    "derivation",
    "consent",
    "redaction",
    "retention",
    "labels"
  ], "learning example");
  if (!/^fp-[a-f0-9]{32}$/.test(example.fingerprint ?? "")) {
    throw new Error("Learning fingerprint is invalid.");
  }
  assertExactKeys(example.source, [
    "runRef",
    "taskRef",
    "attemptRef",
    "runStateVersion",
    "outcomeVersion",
    "attemptNumber"
  ], "learning source");
  for (const field of ["runRef", "taskRef", "attemptRef"]) {
    if (typeof example.source?.[field] !== "string" || !example.source[field]) {
      throw new Error(`Learning source ${field} is required.`);
    }
  }
  if (!/^run-[a-f0-9]{32}$/.test(example.source.runRef) ||
      !/^task-[a-f0-9]{32}$/.test(example.source.taskRef) ||
      !/^attempt-[a-f0-9]{32}$/.test(example.source.attemptRef)) {
    throw new Error("Learning source references are invalid.");
  }
  for (const field of ["runStateVersion", "outcomeVersion", "attemptNumber"]) {
    if (!Number.isInteger(example.source[field]) || example.source[field] < 1) {
      throw new Error(`Learning source ${field} must be a positive integer.`);
    }
  }
  // `warmStart` arrived with warm retries; samples collected earlier lack it and
  // stay valid.
  assertExactKeys(example.features, [
    ...(Object.hasOwn(example.features ?? {}, "warmStart") ? ["warmStart"] : []),
    "laneRef",
    "taskKind",
    "planRevision",
    "dependencyCount",
    "constraintCount",
    "scopeEntryCount",
    "acceptanceCriterionCount",
    "retryCount",
    "terminalStatus",
    "resultContractFound",
    "missingContractFieldCount",
    "model",
    "reasoningEffort",
    "routeSource",
    "routingReasonPresent"
  ], "learning features");
  if (!/^lane-[a-f0-9]{32}$/.test(example.features.laneRef ?? "")) {
    throw new Error("Learning lane reference is invalid.");
  }
  if (!["read", "write", "verify"].includes(example.features.taskKind) ||
      !["completed", "failed", "blocked", "cancelled"].includes(
        example.features.terminalStatus
      ) ||
      !["planned_task", "run_pin"].includes(example.features.routeSource)) {
    throw new Error("Learning features contain an invalid enum value.");
  }
  for (const field of [
    "planRevision",
    "dependencyCount",
    "constraintCount",
    "scopeEntryCount",
    "acceptanceCriterionCount",
    "retryCount"
  ]) {
    if (!Number.isInteger(example.features[field]) || example.features[field] < 0) {
      throw new Error(`Learning feature ${field} must be a non-negative integer.`);
    }
  }
  if (![true, false, null].includes(example.features.resultContractFound) ||
      !(example.features.missingContractFieldCount === null ||
        (Number.isInteger(example.features.missingContractFieldCount) &&
          example.features.missingContractFieldCount >= 0)) ||
      typeof example.features.routingReasonPresent !== "boolean" ||
      !(example.features.warmStart === undefined ||
        typeof example.features.warmStart === "boolean") ||
      !(example.features.model === null || LEARNING_MODELS.has(example.features.model)) ||
      !(example.features.reasoningEffort === null ||
        LEARNING_EFFORTS.has(example.features.reasoningEffort))) {
    throw new Error("Learning route or contract features are invalid.");
  }
  assertExactKeys(example.outcome, [
    "version",
    "terminalOutcome",
    "action",
    "reasonCode",
    "provenance",
    "signals"
  ], "learning outcome");
  validateOutcomeRecord(example.outcome);
  if (!Array.isArray(example.diagnostics)) {
    throw new Error("Learning diagnostics must be an array.");
  }
  for (const diagnostic of example.diagnostics) {
    assertExactKeys(diagnostic, ["type", "reasonCode", "signals"], "learning diagnostic");
    if (!["integration_refused", "integration_failed"].includes(diagnostic.type) ||
        !REASON_CODES.includes(diagnostic.reasonCode) ||
        !Array.isArray(diagnostic.signals) ||
        diagnostic.signals.some((signal) => !OUTCOME_SIGNALS.includes(signal))) {
      throw new Error("Learning diagnostic uses an invalid reason or signal.");
    }
  }
  if (!Array.isArray(example.eventTypes) ||
      example.eventTypes.some((type) => !SAFE_EVENT_TYPES.has(type))) {
    throw new Error("Learning event types must use the safe event allowlist.");
  }
  if (new Set(example.eventTypes).size !== example.eventTypes.length) {
    throw new Error("Learning event types cannot contain duplicates.");
  }
  if (![null, "pass", "fail"].includes(example.verificationVerdict) ||
      ![null, "pass", "fail"].includes(example.runFinalizationVerdict) ||
      !Number.isInteger(example.verificationEvidenceCount) ||
      example.verificationEvidenceCount < 0 ||
      !Number.isInteger(example.finalizationEvidenceCount) ||
      example.finalizationEvidenceCount < 0) {
    throw new Error("Learning verification or finalization metadata is invalid.");
  }
  assertExactKeys(example.timing, ["durationMs"], "learning timing");
  if (!(example.timing.durationMs === null ||
      (Number.isFinite(example.timing.durationMs) && example.timing.durationMs >= 0))) {
    throw new Error("Learning duration must be null or a non-negative finite number.");
  }
  if (!Array.isArray(example.labels)) {
    throw new Error("Learning labels must be an array.");
  }
  const labelIds = new Set();
  for (const label of example.labels) {
    assertExactKeys(label, ["labelId", "labeledAt", "outcome"], "learning label");
    if (!/^label-[a-f0-9]{32}$/.test(label.labelId ?? "")) {
      throw new Error("Learning label id is invalid.");
    }
    if (labelIds.has(label.labelId) || !validIso(label.labeledAt)) {
      throw new Error("Learning labels must have unique ids and valid timestamps.");
    }
    labelIds.add(label.labelId);
    validateOutcomeRecord(label.outcome);
    assertExactKeys(label.outcome, [
      "version",
      "terminalOutcome",
      "action",
      "reasonCode",
      "provenance",
      "signals"
    ], "learning label outcome");
    if (!LABEL_PROVENANCE.has(label.outcome.provenance)) {
      throw new Error("Learning label provenance is invalid.");
    }
  }
  if (!example.consent || !["metadata_only", "explicit_text"].includes(example.consent.mode)) {
    throw new Error("Learning consent mode is invalid.");
  }
  assertExactKeys(
    example.consent,
    ["mode", "provenance", "textFields", "grantedAt"],
    "learning consent"
  );
  const textFields = example.consent.textFields ?? [];
  if (!Array.isArray(textFields) || textFields.some((field) => !LEARNING_TEXT_FIELDS.includes(field))) {
    throw new Error("Learning consent text fields are invalid.");
  }
  if (example.consent.mode === "metadata_only" && textFields.length > 0) {
    throw new Error("Metadata-only learning examples cannot contain text.");
  }
  if (example.consent.mode !== "metadata_only") {
    throw new Error("The base learning store is metadata-only; text is allowed only in exports.");
  }
  if (example.consent.provenance !== "default_local_policy" ||
      example.consent.grantedAt !== null) {
    throw new Error("Metadata-only consent metadata is invalid.");
  }
  assertExactKeys(
    example.redaction,
    ["version", "appliedFields", "findings"],
    "learning redaction"
  );
  if (!SUPPORTED_REDACTION_VERSIONS.includes(example.redaction?.version)) {
    throw new Error(
      `Learning redaction version must be one of: ${SUPPORTED_REDACTION_VERSIONS.join(", ")}.`
    );
  }
  if (example.redaction.appliedFields.length !== 0 ||
      Object.keys(example.redaction.findings).length !== 0) {
    throw new Error("Metadata-only base records cannot contain redaction findings or text fields.");
  }
  if (!example.retention || !["expire_after_days", "retain_until_purged"].includes(
    example.retention.policy
  )) {
    throw new Error("Learning retention policy is invalid.");
  }
  assertExactKeys(
    example.retention,
    ["policy", "days", "expiresAt", "rawAuditManaged"],
    "learning retention"
  );
  if (example.retention.rawAuditManaged !== false) {
    throw new Error("Learning retention must not manage raw run audit data.");
  }
  if (!Number.isInteger(example.retention.days) || example.retention.days < 0 ||
      (example.retention.days === 0
        ? example.retention.policy !== "retain_until_purged" ||
          example.retention.expiresAt !== null
        : example.retention.policy !== "expire_after_days" ||
          !validIso(example.retention.expiresAt))) {
    throw new Error("Learning retention days and expiry are inconsistent.");
  }
  assertExactKeys(
    example.derivation,
    ["provenance", "collectedAt", "updatedAt"],
    "learning derivation"
  );
  if (typeof example.derivation?.collectedAt !== "string" ||
      typeof example.derivation?.updatedAt !== "string" ||
      example.derivation?.provenance !== "local_run_state" ||
      !validIso(example.derivation.collectedAt) ||
      !validIso(example.derivation.updatedAt)) {
    throw new Error("Learning derivation metadata is invalid.");
  }
  return example;
}

function validIso(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) &&
    new Date(Date.parse(value)).toISOString() === value;
}

function assertExactKeys(value, allowed, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
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
