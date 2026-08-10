import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";

import {
  collectLearningExamples,
  exportLearningExamples,
  inspectLearningExample,
  labelLearningExample,
  learningDir,
  learningExamplesFile,
  learningExportsDir,
  learningIdentityFile,
  listLearningExamples,
  purgeLearningExamples
} from "../plugins/orchestrator/scripts/lib/learning.mjs";
import {
  addCheckpoint,
  claimTask,
  createRun,
  eventsFile,
  loadRun,
  recordIntegrationDiagnostic,
  recordTaskResult,
  replacePlan,
  retryTask,
  runFile,
  verifyTask
} from "../plugins/orchestrator/scripts/lib/runs.mjs";
import { CLI, cleanup, makeRepo, runCli } from "./helpers.mjs";

const repos = [];

function repo() {
  const root = makeRepo();
  repos.push(root);
  runCli(root, ["init"]);
  return root;
}

function terminalTask(root, runId = "run-private-jane", taskId = "review-private-jane") {
  createRun(root, {
    id: runId,
    lane: "customer-jane",
    objective: "CANARY_RUN_OBJECTIVE alice@example.com",
    workerModel: "sol",
    reasoningEffort: "high"
  });
  replacePlan(root, runId, [{
    id: taskId,
    title: "CANARY_TASK_TITLE sk-1234567890abcdefghijklmnop",
    objective: "CANARY_TASK_OBJECTIVE /Users/alice/private/source.js",
    kind: "read",
    acceptance: ["CANARY_ACCEPTANCE"],
    constraints: ["CANARY_CONSTRAINT"],
    scope: ["CANARY_SCOPE/**"],
    routingReason: "CANARY_ROUTING owner@example.com",
    model: "sol",
    reasoningEffort: "high"
  }]);
  addCheckpoint(root, runId, { summary: "CANARY_CHECKPOINT" });
  const dispatch = claimTask(root, runId, taskId, { constraints: ["CANARY_LANE"] });
  recordTaskResult(root, runId, taskId, {
    attemptId: dispatch.attemptId,
    resultText: JSON.stringify({
      summary: "CANARY_RESULT_SUMMARY",
      files_touched: ["/Users/alice/private/result.js"],
      tests: [{ command: "CANARY_TEST_COMMAND", outcome: "CANARY_TEST_OUTPUT" }],
      decisions: ["CANARY_DECISION"],
      assumptions: ["CANARY_ASSUMPTION"],
      blockers: [],
      confidence: "high"
    })
  });
  recordIntegrationDiagnostic(root, runId, taskId, {
    kind: "failed",
    reasonCode: "integration_conflict",
    signals: ["integration_conflict"],
    error: "CANARY_DIAGNOSTIC_ERROR",
    details: { path: "/Users/alice/private/worktree", secret: "CANARY_DIAGNOSTIC_DETAIL" }
  });
  verifyTask(root, runId, taskId, {
    verdict: "pass",
    evidence: ["CANARY_VERIFICATION_EVIDENCE"]
  });
  return loadRun(root, runId).tasks[taskId].attempts.at(-1);
}

function mode(target) {
  return fs.statSync(target).mode & 0o777;
}

function readTree(directory) {
  if (!fs.existsSync(directory)) {
    return "";
  }
  return fs.readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => {
      const target = path.join(directory, entry.name);
      return entry.isDirectory() ? readTree(target) : fs.readFileSync(target, "utf8");
    })
    .join("\n");
}

function runCliAsync(root, args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: root,
      env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

after(() => {
  for (const root of repos) {
    cleanup(root);
  }
});

test("learning state is lazy and read-only commands do not create it", () => {
  const root = repo();
  assert.equal(fs.existsSync(learningDir(root)), false);
  assert.deepEqual(listLearningExamples(root), []);
  assert.equal(fs.existsSync(learningDir(root)), false);
  assert.throws(() => inspectLearningExample(root, "sample-00000000000000000000000000000000"),
    /Unknown learning sample/);
  assert.equal(fs.existsSync(learningDir(root)), false);
});

test("collection is metadata-only, private, deterministic, and idempotent", () => {
  const root = repo();
  terminalTask(root);
  const first = collectLearningExamples(root, { collectedAt: "2026-08-10T00:00:00.000Z" });
  assert.equal(first.created, 1);
  assert.equal(first.total, 1);
  assert.equal(mode(learningDir(root)), 0o700);
  assert.equal(mode(learningExamplesFile(root)), 0o600);
  assert.equal(mode(learningIdentityFile(root)), 0o600);

  const bytes = fs.readFileSync(learningExamplesFile(root), "utf8");
  const modified = fs.statSync(learningExamplesFile(root)).mtimeMs;
  const forbidden = [
    "run-private-jane",
    "review-private-jane",
    "customer-jane",
    "CANARY_RUN_OBJECTIVE",
    "CANARY_TASK_TITLE",
    "CANARY_TASK_OBJECTIVE",
    "CANARY_ACCEPTANCE",
    "CANARY_CONSTRAINT",
    "CANARY_SCOPE",
    "CANARY_ROUTING",
    "CANARY_RESULT_SUMMARY",
    "CANARY_TEST_COMMAND",
    "CANARY_TEST_OUTPUT",
    "CANARY_DECISION",
    "CANARY_ASSUMPTION",
    "CANARY_DIAGNOSTIC_ERROR",
    "CANARY_DIAGNOSTIC_DETAIL",
    "CANARY_VERIFICATION_EVIDENCE",
    "alice@example.com",
    root
  ];
  for (const value of forbidden) {
    assert.equal(bytes.includes(value), false, `learning store leaked ${value}`);
  }
  const example = listLearningExamples(root)[0];
  assert.match(example.sampleId, /^sample-[a-f0-9]{32}$/);
  assert.match(example.fingerprint, /^fp-[a-f0-9]{32}$/);
  assert.match(example.source.runRef, /^run-[a-f0-9]{32}$/);
  assert.equal(example.outcome.terminalOutcome, "accepted");
  assert.equal(example.features.routeSource, "run_pin");
  assert.deepEqual(example.diagnostics, [{
    type: "integration_failed",
    reasonCode: "integration_conflict",
    signals: ["integration_conflict"]
  }]);
  assert.equal(example.consent.mode, "metadata_only");
  assert.equal(Object.hasOwn(example, "text"), false);

  const second = collectLearningExamples(root, { collectedAt: "2026-08-11T00:00:00.000Z" });
  assert.equal(second.created, 0);
  assert.equal(second.updated, 0);
  assert.equal(second.unchanged, 1);
  assert.equal(fs.readFileSync(learningExamplesFile(root), "utf8"), bytes);
  assert.equal(fs.statSync(learningExamplesFile(root)).mtimeMs, modified);
});

test("route source distinguishes planned task routes from explicit run pins", () => {
  const root = repo();
  createRun(root, { id: "run-auto-learning", lane: "api", objective: "Route automatically" });
  replacePlan(root, "run-auto-learning", [{
    id: "review",
    title: "Review",
    objective: "Review",
    kind: "read",
    model: "sol",
    reasoningEffort: "high",
    routingReason: "bounded review"
  }]);
  addCheckpoint(root, "run-auto-learning", { summary: "Ready" });
  const dispatch = claimTask(root, "run-auto-learning", "review", { constraints: [] });
  recordTaskResult(root, "run-auto-learning", "review", {
    attemptId: dispatch.attemptId,
    resultText: JSON.stringify({
      summary: "Reviewed",
      files_touched: [],
      tests: [],
      decisions: [],
      assumptions: [],
      blockers: [],
      confidence: "high"
    })
  });
  verifyTask(root, "run-auto-learning", "review", { verdict: "pass", evidence: ["done"] });
  collectLearningExamples(root);
  assert.equal(listLearningExamples(root)[0].features.routeSource, "planned_task");
});

test("later finalization upserts one sample and separate repositories use different ids", () => {
  const firstRoot = repo();
  terminalTask(firstRoot, "run-stable-source", "review");
  collectLearningExamples(firstRoot);
  const before = listLearningExamples(firstRoot)[0];
  const sourcePath = runFile(firstRoot, "run-stable-source");
  const source = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
  source.finalization = {
    verdict: "pass",
    summary: "CANARY_FINAL_SUMMARY",
    evidence: ["CANARY_FINAL_EVIDENCE"],
    at: "2026-08-10T03:00:00.000Z"
  };
  fs.writeFileSync(sourcePath, `${JSON.stringify(source, null, 2)}\n`);
  const refreshed = collectLearningExamples(firstRoot);
  assert.equal(refreshed.updated, 1);
  const afterRefresh = listLearningExamples(firstRoot)[0];
  assert.equal(afterRefresh.sampleId, before.sampleId);
  assert.notEqual(afterRefresh.fingerprint, before.fingerprint);
  assert.equal(afterRefresh.runFinalizationVerdict, "pass");
  assert.equal(afterRefresh.finalizationEvidenceCount, 1);
  assert.equal(fs.readFileSync(learningExamplesFile(firstRoot), "utf8").includes("CANARY_FINAL"), false);

  const secondRoot = repo();
  terminalTask(secondRoot, "run-stable-source", "review");
  collectLearningExamples(secondRoot);
  assert.notEqual(listLearningExamples(secondRoot)[0].sampleId, before.sampleId);
});

test("collection skips outcome-less legacy attempts instead of guessing", () => {
  const root = repo();
  const attempt = terminalTask(root, "run-legacy-learning", "legacy");
  const filePath = runFile(root, "run-legacy-learning");
  const run = JSON.parse(fs.readFileSync(filePath, "utf8"));
  delete run.tasks.legacy.attempts.find((entry) => entry.id === attempt.id).outcome;
  fs.writeFileSync(filePath, `${JSON.stringify(run, null, 2)}\n`);
  const result = collectLearningExamples(root);
  assert.equal(result.created, 0);
  assert.equal(result.skippedWithoutOutcome, 1);
  assert.deepEqual(listLearningExamples(root), []);
});

test("concurrent collection uses one store lock without duplicates or lost samples", async () => {
  const root = repo();
  terminalTask(root, "run-concurrent-a", "first");
  terminalTask(root, "run-concurrent-b", "second");
  const results = await Promise.all([
    runCliAsync(root, ["learn", "collect", "--run", "run-concurrent-a", "--json"]),
    runCliAsync(root, ["learn", "collect", "--run", "run-concurrent-b", "--json"]),
    runCliAsync(root, ["learn", "collect", "--run", "run-concurrent-a", "--json"])
  ]);
  for (const result of results) {
    assert.equal(result.code, 0, result.stderr);
  }
  const examples = listLearningExamples(root);
  assert.equal(examples.length, 2);
  assert.equal(new Set(examples.map((example) => example.sampleId)).size, 2);
});

test("labels are validated, provenance-tagged, and idempotent", () => {
  const root = repo();
  terminalTask(root, "run-label", "review");
  collectLearningExamples(root);
  const sample = listLearningExamples(root)[0];
  const first = labelLearningExample(root, sample.sampleId, {
    terminalOutcome: "verification_failed",
    action: "replan",
    reasonCode: "test_failure",
    provenance: "user",
    labeledAt: "2026-08-10T01:00:00.000Z"
  });
  assert.equal(first.created, true);
  assert.equal(first.label.outcome.provenance, "user");
  const repeated = labelLearningExample(root, sample.sampleId, {
    terminalOutcome: "verification_failed",
    action: "replan",
    reasonCode: "test_failure",
    provenance: "user"
  });
  assert.equal(repeated.created, false);
  assert.equal(inspectLearningExample(root, sample.sampleId).labels.length, 1);
  assert.throws(() => labelLearningExample(root, sample.sampleId, {
    terminalOutcome: "accepted",
    action: "refuse",
    reasonCode: "supervisor_verified",
    provenance: "user"
  }), /cannot use action/);
});

test("managed exports have manifests and redact explicitly consented text", () => {
  const root = repo();
  terminalTask(root, "run-export", "review");
  collectLearningExamples(root);
  const result = exportLearningExamples(root, {
    name: "privacy-check",
    includeTextFields: ["taskTitle", "routingReason"],
    consentProvenance: "user",
    acknowledgeSensitiveExport: true,
    exportedAt: "2026-08-10T02:00:00.000Z"
  });
  assert.equal(result.manifest.sampleCount, 1);
  assert.equal(result.manifest.exportVersion, 1);
  assert.equal(result.manifest.exportRecordVersion, 1);
  assert.equal(result.manifest.learningSchemaVersion, 1);
  assert.equal(result.manifest.consent.mode, "explicit_text_export");
  assert.match(result.manifest.consent.grantId, /^consent-[a-f0-9]{32}$/);
  assert.equal(result.manifest.retention.rawAuditManaged, false);
  assert.equal(result.manifest.provenance.kind, "derived_local_export");
  assert.match(result.manifest.sampleIds[0], /^sample-[a-f0-9]{32}$/);
  assert.match(result.manifest.repositoryIds[0], /^repo-[a-f0-9]{32}$/);
  assert.equal(mode(result.directory), 0o700);
  assert.equal(mode(result.examplesFile), 0o600);
  assert.equal(mode(result.manifestFile), 0o600);
  const exported = fs.readFileSync(result.examplesFile, "utf8");
  assert.equal(
    result.manifest.examplesSha256,
    createHash("sha256").update(exported).digest("hex")
  );
  const exportedRecord = JSON.parse(exported.trim());
  assert.equal(exportedRecord.exportRecordVersion, 1);
  assert.equal(exportedRecord.example.sampleId, result.manifest.sampleIds[0]);
  assert.doesNotMatch(exported, /sk-1234567890abcdefghijklmnop|owner@example\.com/);
  assert.match(exported, /<redacted:openai_key>|<redacted:email>/);
  const sourcePath = runFile(root, "run-export");
  const source = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
  source.tasks.review.title = `${"x".repeat(7990)} sk-1234567890abcdefghijklmnop`;
  fs.writeFileSync(sourcePath, `${JSON.stringify(source, null, 2)}\n`);
  const boundary = exportLearningExamples(root, {
    name: "boundary-redaction",
    includeTextFields: ["taskTitle"],
    consentProvenance: "user",
    acknowledgeSensitiveExport: true
  });
  assert.doesNotMatch(
    fs.readFileSync(boundary.examplesFile, "utf8"),
    /sk-1234567890abcdefghijklmnop/
  );
  assert.throws(() => exportLearningExamples(root, {
    name: "missing-consent",
    includeTextFields: ["taskTitle"]
  }), /acknowledge-sensitive-export/);
  assert.throws(() => exportLearningExamples(root, { name: "https://example.com/upload" }),
    /export names/);
});

test("collection and export require no network capability", async () => {
  const root = repo();
  terminalTask(root, "run-offline", "review");
  const preload = path.join(path.dirname(new URL(import.meta.url).pathname), "fixtures", "deny-network.mjs");
  const env = { ...process.env, NODE_OPTIONS: `--import=${preload}` };
  const collected = await runCliAsync(root, [
    "learn", "collect", "--run", "run-offline", "--json"
  ], env);
  assert.equal(collected.code, 0, collected.stderr);
  const exported = await runCliAsync(root, [
    "learn", "export", "--name", "offline", "--json"
  ], env);
  assert.equal(exported.code, 0, exported.stderr);
  assert.equal(JSON.parse(exported.stdout).manifest.sampleCount, 1);
});

test("targeted purge removes samples, labels, and affected exports but not raw audit data", () => {
  const root = repo();
  terminalTask(root, "run-purge", "first");
  terminalTask(root, "run-keep", "second");
  collectLearningExamples(root);
  const first = listLearningExamples(root).find((example) =>
    example.source.runRef !== listLearningExamples(root)[0].source.runRef
  ) ?? listLearningExamples(root)[0];
  labelLearningExample(root, first.sampleId, {
    terminalOutcome: "accepted",
    action: "execute",
    reasonCode: "supervisor_verified",
    provenance: "supervisor"
  });
  const exported = exportLearningExamples(root, { name: "before-purge" });
  const rawRunPath = runFile(root, "run-purge");
  const rawBefore = fs.readFileSync(rawRunPath, "utf8");
  const purged = purgeLearningExamples(root, { runIds: ["run-purge"] });
  assert.equal(purged.removedCount, 1);
  assert.equal(purged.exportsRemoved.length, 1);
  assert.equal(fs.existsSync(exported.directory), false);
  assert.equal(listLearningExamples(root).length, 1);
  assert.equal(fs.readFileSync(rawRunPath, "utf8"), rawBefore);
  assert.equal(fs.existsSync(rawRunPath), true);
});

test("purge deletes corrupt, incomplete, and base-orphaned managed exports", () => {
  const root = repo();
  terminalTask(root, "run-export-corruption", "review");
  collectLearningExamples(root);
  const sample = listLearningExamples(root)[0];
  const corrupt = exportLearningExamples(root, { name: "corrupt-membership" });
  const manifest = JSON.parse(fs.readFileSync(corrupt.manifestFile, "utf8"));
  manifest.sampleIds = [];
  fs.writeFileSync(corrupt.manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  const orphan = path.join(learningExportsDir(root), ".crash-left.tmp");
  fs.mkdirSync(orphan, { mode: 0o700 });
  fs.writeFileSync(path.join(orphan, "examples.jsonl"), "CANARY_ORPHAN_EXPORT\n", {
    mode: 0o600
  });
  const result = purgeLearningExamples(root, { sampleIds: [sample.sampleId] });
  assert.equal(result.removedCount, 1);
  assert.deepEqual(new Set(result.exportsRemoved),
    new Set(["corrupt-membership", ".crash-left.tmp"]));
  assert.equal(fs.existsSync(corrupt.directory), false);
  assert.equal(fs.existsSync(orphan), false);

  collectLearningExamples(root);
  const recreated = listLearningExamples(root)[0];
  const drifted = exportLearningExamples(root, { name: "base-drift" });
  fs.writeFileSync(learningExamplesFile(root), "", { mode: 0o600 });
  const driftPurge = purgeLearningExamples(root, { sampleIds: [recreated.sampleId] });
  assert.equal(driftPurge.removedCount, 0);
  assert.deepEqual(driftPurge.exportsRemoved, ["base-drift"]);
  assert.equal(fs.existsSync(drifted.directory), false);
});

test("sample and all purge remain available when the identity file is missing", () => {
  const root = repo();
  terminalTask(root, "run-identity-loss", "review");
  collectLearningExamples(root);
  const sample = listLearningExamples(root)[0];
  const firstExport = exportLearningExamples(root, { name: "identity-loss-sample" });
  fs.unlinkSync(learningIdentityFile(root));
  const samplePurge = purgeLearningExamples(root, { sampleIds: [sample.sampleId] });
  assert.equal(samplePurge.removedCount, 1);
  assert.equal(fs.existsSync(firstExport.directory), false);

  fs.writeFileSync(learningExamplesFile(root), `${JSON.stringify(sample)}\n`, { mode: 0o600 });
  const orphan = path.join(learningExportsDir(root), ".identity-loss.tmp");
  fs.mkdirSync(orphan, { mode: 0o700 });
  fs.writeFileSync(path.join(orphan, "partial"), "derived", { mode: 0o600 });
  const all = purgeLearningExamples(root, { all: true });
  assert.equal(all.removedCount, 1);
  assert.equal(fs.existsSync(orphan), false);
});

test("attempt and task purge are exact and historical contract facts stay separated", () => {
  const root = repo();
  createRun(root, {
    id: "run-retry-learning",
    lane: "api",
    objective: "Retry safely",
    workerModel: "sol",
    reasoningEffort: "high"
  });
  replacePlan(root, "run-retry-learning", [
    { id: "work", title: "Work", objective: "Work", kind: "read" }
  ]);
  addCheckpoint(root, "run-retry-learning", { summary: "Ready" });
  const first = claimTask(root, "run-retry-learning", "work", { constraints: [] });
  recordTaskResult(root, "run-retry-learning", "work", {
    attemptId: first.attemptId,
    resultText: JSON.stringify({
      summary: "Need context",
      files_touched: [],
      tests: [],
      decisions: [],
      assumptions: [],
      blockers: ["missing fixture"],
      blocker_code: "missing_context",
      confidence: "high"
    })
  });
  retryTask(root, "run-retry-learning", "work");
  addCheckpoint(root, "run-retry-learning", { summary: "Retry" });
  const second = claimTask(root, "run-retry-learning", "work", { constraints: [] });
  recordTaskResult(root, "run-retry-learning", "work", {
    attemptId: second.attemptId,
    resultText: "malformed"
  });
  collectLearningExamples(root);
  const examples = listLearningExamples(root);
  const blocked = examples.find((example) => example.outcome.terminalOutcome === "worker_blocked");
  const malformed = examples.find((example) => example.outcome.terminalOutcome === "contract_failed");
  assert.equal(blocked.features.resultContractFound, true);
  assert.equal(blocked.features.missingContractFieldCount, 0);
  assert.equal(blocked.features.retryCount, 0);
  assert.equal(malformed.features.resultContractFound, false);
  assert.equal(malformed.features.missingContractFieldCount, 5);
  assert.equal(malformed.features.retryCount, 1);

  const attemptPurge = purgeLearningExamples(root, {
    runIds: ["run-retry-learning"],
    taskIds: ["work"],
    attemptIds: [first.attemptId]
  });
  assert.equal(attemptPurge.removedCount, 1);
  assert.equal(listLearningExamples(root)[0].sampleId, malformed.sampleId);
  const taskPurge = purgeLearningExamples(root, {
    runIds: ["run-retry-learning"],
    taskIds: ["work"]
  });
  assert.equal(taskPurge.removedCount, 1);
  assert.deepEqual(listLearningExamples(root), []);
});

test("retention metadata supports expiry purge and forever retention", () => {
  const root = repo();
  terminalTask(root, "run-expiring", "first");
  terminalTask(root, "run-forever", "second");
  collectLearningExamples(root, { runIds: ["run-expiring"], retentionDays: 1 });
  collectLearningExamples(root, { runIds: ["run-forever"], retentionDays: 0 });
  const before = listLearningExamples(root);
  assert.equal(before.find((example) => example.retention.days === 0).retention.expiresAt, null);
  const purged = purgeLearningExamples(root, {
    expired: true,
    now: "2030-01-01T00:00:00.000Z"
  });
  assert.equal(purged.removedCount, 1);
  assert.equal(listLearningExamples(root)[0].retention.policy, "retain_until_purged");
});

test("corrupt learning JSONL fails closed without rewriting bytes", () => {
  const root = repo();
  terminalTask(root, "run-corrupt-store", "review");
  collectLearningExamples(root);
  fs.appendFileSync(learningExamplesFile(root), "{not-json}\n");
  const corrupt = fs.readFileSync(learningExamplesFile(root), "utf8");
  assert.throws(() => collectLearningExamples(root), /is not valid JSON/);
  assert.equal(fs.readFileSync(learningExamplesFile(root), "utf8"), corrupt);
});

test("strict derivation rejects attacker-controlled values in enum-shaped source fields", () => {
  const root = repo();
  terminalTask(root, "run-mutated-enum", "review");
  const sourcePath = runFile(root, "run-mutated-enum");
  const source = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
  source.tasks.review.kind = "CANARY_ARBITRARY_TASK_KIND";
  source.tasks.review.attempts[0].status = "CANARY_ARBITRARY_STATUS";
  fs.writeFileSync(sourcePath, `${JSON.stringify(source, null, 2)}\n`);
  assert.throws(() => collectLearningExamples(root), /invalid enum value/);
  assert.equal(readTree(learningDir(root)).includes("CANARY_ARBITRARY"), false);
});

test("learning storage rejects ancestor symlinks and repairs private modes on mutation", () => {
  const root = repo();
  terminalTask(root, "run-private-modes", "review");
  collectLearningExamples(root);
  fs.chmodSync(learningExamplesFile(root), 0o700);
  fs.chmodSync(learningIdentityFile(root), 0o400);
  assert.throws(() => listLearningExamples(root), /permissions must be 0600/);
  collectLearningExamples(root);
  assert.equal(mode(learningExamplesFile(root)), 0o600);
  assert.equal(mode(learningIdentityFile(root)), 0o600);

  const local = path.join(root, ".orchestrator", "local");
  const preserved = path.join(root, ".orchestrator", "local-preserved");
  const outside = path.join(root, "outside-learning-target");
  fs.renameSync(local, preserved);
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, local);
  assert.throws(() => collectLearningExamples(root), /cannot be a symbolic link/);
  assert.equal(fs.existsSync(path.join(outside, "learning")), false);
});

test("all learning artifacts remain free of raw default-excluded canaries", () => {
  const root = repo();
  const attempt = terminalTask(root, "run-canary-scan", "review-canary");
  fs.appendFileSync(path.join(root, ".orchestrator", "ledger.md"), "\nCANARY_LEDGER_TEXT\n");
  fs.writeFileSync(path.join(root, "CANARY_SOURCE_DIFF.js"), "CANARY_SOURCE_CODE\n");
  const workerDir = path.join(
    root,
    ".orchestrator",
    "local",
    "runs",
    "run-canary-scan",
    "workers",
    "review-canary",
    attempt.id
  );
  fs.mkdirSync(workerDir, { recursive: true });
  for (const [name, value] of [
    ["prompt.md", "CANARY_WORKER_PROMPT"],
    ["stderr.log", "CANARY_WORKER_STDERR"],
    ["events.jsonl", "CANARY_WORKER_TOOL_EVENT"],
    ["result.txt", "CANARY_RAW_WORKER_RESULT"]
  ]) {
    fs.writeFileSync(path.join(workerDir, name), `${value}\n`);
  }
  fs.appendFileSync(eventsFile(root, "run-canary-scan"), `${JSON.stringify({
    type: "task.execution_failed",
    attemptId: attempt.id,
    error: "CANARY_EVENT_TOOL_OUTPUT"
  })}\n`);
  const previousEnvironment = process.env.ORCH_LEARNING_CANARY;
  process.env.ORCH_LEARNING_CANARY = "CANARY_ENVIRONMENT_VALUE";
  try {
    collectLearningExamples(root);
  } finally {
    if (previousEnvironment === undefined) {
      delete process.env.ORCH_LEARNING_CANARY;
    } else {
      process.env.ORCH_LEARNING_CANARY = previousEnvironment;
    }
  }
  labelLearningExample(root, listLearningExamples(root)[0].sampleId, {
    terminalOutcome: "accepted",
    action: "execute",
    reasonCode: "supervisor_verified",
    provenance: "supervisor"
  });
  exportLearningExamples(root, { name: "metadata-only" });
  const artifacts = readTree(learningDir(root));
  for (const canary of [
    "CANARY_RUN_OBJECTIVE",
    "CANARY_TASK_OBJECTIVE",
    "CANARY_RESULT_SUMMARY",
    "CANARY_VERIFICATION_EVIDENCE",
    "CANARY_DIAGNOSTIC_DETAIL",
    "CANARY_LEDGER_TEXT",
    "CANARY_SOURCE_DIFF",
    "CANARY_SOURCE_CODE",
    "CANARY_WORKER_PROMPT",
    "CANARY_WORKER_STDERR",
    "CANARY_WORKER_TOOL_EVENT",
    "CANARY_RAW_WORKER_RESULT",
    "CANARY_EVENT_TOOL_OUTPUT",
    "CANARY_ENVIRONMENT_VALUE"
  ]) {
    assert.equal(artifacts.includes(canary), false);
  }
});
