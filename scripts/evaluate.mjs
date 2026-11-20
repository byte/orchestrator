#!/usr/bin/env node
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { executeCheck } from "../plugins/orchestrator/scripts/lib/checks.mjs";
import { execGit } from "../plugins/orchestrator/scripts/lib/exec.mjs";

const self = fileURLToPath(import.meta.url);
const evaluation = path.resolve(path.dirname(self), "../evaluation");
const manifestPath = path.join(evaluation, "cases.json");
const checker = path.join(evaluation, "check.mjs");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const sha = (value) => createHash("sha256").update(value).digest("hex");
const sandboxSources = ["lib/checks.mjs", "lib/exec.mjs", "lib/bounded-log.mjs", "check-child.mjs"]
  .map((file) => path.resolve(evaluation, "../plugins/orchestrator/scripts", file));
const suiteDigest = sha([self, manifestPath, checker, ...sandboxSources].map((file) => fs.readFileSync(file, "utf8")).join("\0"));
const conditionsKeys = ["supervisorModel", "supervisorEffort", "workerModel", "workerEffort", "claudeVersion", "codexVersion", "orchestratorVersion", "timeLimitSeconds"];
const usageKeys = ["inputTokens", "outputTokens", "cachedInputTokens", "costUsd"];
const usageTemplate = () => Object.fromEntries(usageKeys.map((key) => [key, null]));
const metadataTemplate = () => ({
  arm: null, trialKind: null, matchId: null,
  conditions: Object.fromEntries(conditionsKeys.map((key) => [key, null])),
  elapsedSeconds: null, humanInterventions: null,
  usage: { worker: usageTemplate(), supervisor: usageTemplate() }
});

function fail(message) { throw new Error(message); }
function caseById(id) { return manifest.cases.find((entry) => entry.id === id) ?? fail(`Unknown case: ${id}`); }
function json(value) { return JSON.stringify(value, null, 2) + "\n"; }
function writeNew(file, value) { fs.writeFileSync(file, value, { flag: "wx", mode: 0o600 }); }
function readBounded(file, limit = 65536) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > limit) fail(`Expected regular file <= ${limit} bytes: ${file}`);
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    let count;
    while ((count = fs.readSync(fd, buffer, length, buffer.length - length, null))) {
      length += count;
      if (length > limit) fail(`File grew beyond ${limit} bytes: ${file}`);
    }
    return buffer.subarray(0, length);
  } finally { fs.closeSync(fd); }
}
function readJson(file) { return JSON.parse(readBounded(file).toString("utf8")); }
function inside(root, file) {
  const relative = path.relative(root, file);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}
function finiteOrNull(value, label, integer = false) {
  value ??= null;
  if (value !== null && (!Number.isFinite(value) || value < 0 || (integer && !Number.isInteger(value)))) fail(`Invalid ${label}`);
  return value;
}
function textOrNull(value, label) {
  value ??= null;
  if (value !== null && (typeof value !== "string" || !value.trim() || value.length > 200)) fail(`Invalid ${label}`);
  return value;
}
function normalizeMetadata(input, fixture) {
  if (!input || !["claude", "orchestrator"].includes(input.arm)) fail("metadata.arm must be claude or orchestrator");
  if (!["live", "mechanics"].includes(input.trialKind)) fail("metadata.trialKind must be live or mechanics");
  if (fixture.kind === "mechanics" && input.trialKind !== "mechanics") fail("The integration protocol is mechanics, never a live model-quality comparison");
  const result = { arm: input.arm, trialKind: input.trialKind, matchId: textOrNull(input.matchId, "matchId"), conditions: {} };
  for (const key of conditionsKeys) {
    const value = input.conditions?.[key];
    result.conditions[key] = key === "timeLimitSeconds" ? finiteOrNull(value, key) : textOrNull(value, key);
    if (key === "timeLimitSeconds" && value === 0) fail("timeLimitSeconds must be positive or null");
  }
  result.elapsedSeconds = finiteOrNull(input.elapsedSeconds, "elapsedSeconds");
  result.humanInterventions = finiteOrNull(input.humanInterventions, "humanInterventions", true);
  result.usage = {};
  for (const role of ["worker", "supervisor"]) {
    result.usage[role] = Object.fromEntries(usageKeys.map((key) => [key, finiteOrNull(input.usage?.[role]?.[key], `${role}.${key}`, key !== "costUsd")]));
  }
  return result;
}

function prepare(options) {
  const fixture = caseById(options.case);
  let destination;
  if (options.dest) {
    destination = path.resolve(options.dest);
    fs.mkdirSync(destination, { mode: 0o700 }); // Never reuse or overwrite a trial.
    destination = fs.realpathSync(destination);
  } else destination = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "orch-evaluation-"));
  const workspace = path.join(destination, "repo");
  fs.mkdirSync(workspace);
  const writeFiles = (files) => {
    for (const [relative, contents] of Object.entries(files)) {
      const target = path.join(workspace, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, contents);
    }
  };
  writeFiles(fixture.files);
  const git = (args) => execGit(["-c", "core.hooksPath=/dev/null", ...args], {
    cwd: workspace, timeout: 10000,
    env: {
      PATH: process.env.PATH, HOME: destination, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Evaluation", GIT_AUTHOR_EMAIL: "evaluation@example.invalid",
      GIT_COMMITTER_NAME: "Evaluation", GIT_COMMITTER_EMAIL: "evaluation@example.invalid",
      GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z"
    }
  });
  git(["init", "--quiet", "--template=", "--initial-branch=main"]);
  git(["add", "."]);
  git(["-c", "commit.gpgSign=false", "commit", "--quiet", "-m", `Frozen evaluation: ${fixture.id}`]);
  writeFiles(fixture.dirty ?? {});
  const task = path.join(destination, "task.md");
  writeNew(task, `# ${fixture.id}\n\n${fixture.task}\n\nScale: ${fixture.scale}\n\nWork only in ${workspace}. Do not push, use network, or change the evaluation harness. Return the changed paths and checks performed. The deliverable is the files, not a completion claim.\n`);
  const metadata = path.join(destination, "metadata.json");
  writeNew(metadata, json(metadataTemplate()));
  return { schemaVersion: 1, caseId: fixture.id, suiteDigest, workspace, task, metadata, baseline: git(["rev-parse", "HEAD"]).trim(), scale: fixture.scale };
}

// Only declared deliverables enter the sandbox snapshot; candidate .git,
// hooks, test scripts and grader replacements are not copied or executed.
function snapshot(candidate, destination, fixture) {
  const files = {};
  for (const relative of fixture.candidateFiles) {
    const parts = relative.split("/");
    let source = candidate;
    let missing = false;
    for (const [index, part] of parts.entries()) {
      source = path.join(source, part);
      let stat;
      try { stat = fs.lstatSync(source); } catch (error) {
        if (error.code !== "ENOENT") throw error;
        missing = true;
        break;
      }
      if (stat.isSymbolicLink() || (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())) fail(`Candidate path must be regular, without symlinks: ${relative}`);
    }
    if (missing) { files[relative] = null; continue; }
    const data = readBounded(source);
    const target = path.join(destination, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
    files[relative] = sha(data);
  }
  return files;
}

async function grade(options) {
  const fixture = caseById(options.case);
  if (!options.candidate || !options.metadata) fail("grade requires --candidate and --metadata");
  const candidate = fs.realpathSync(options.candidate);
  const metadata = normalizeMetadata(readJson(options.metadata), fixture);
  if (options.out) {
    const output = path.resolve(options.out);
    if (inside(candidate, output)) fail("Receipt --out must be outside the candidate");
    if (fs.existsSync(output)) fail("Receipt --out must be a new file");
  }
  const temporary = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "orch-evaluation-grade-"));
  let preserve = false;
  const listener = net.createServer((socket) => socket.destroy());
  try {
    const files = snapshot(candidate, temporary, fixture);
    const started = Date.now();
    const listening = once(listener, "listening");
    listener.listen({ host: "127.0.0.1", port: 0 });
    await listening;
    const check = executeCheck(temporary, {
      argv: [process.execPath, checker, fixture.id, String(listener.address().port)], timeoutSeconds: 15
    }, { writable: false, network: false });
    preserve = Boolean(check.terminationUncertain);
    let verdict;
    try { verdict = JSON.parse(check.stdout.text); } catch { /* Infrastructure failure, not a candidate verdict. */ }
    const sandboxVerified = verdict?.caseId === fixture.id && verdict.sandboxVerified === true;
    const valid = !check.error && !check.signal && sandboxVerified && typeof verdict.passed === "boolean" && check.exitCode === (verdict.passed ? 0 : 1);
    const outcome = valid ? (verdict.passed ? "passed" : "failed") : "unavailable";
    return {
      schemaVersion: 1, caseId: fixture.id, suiteDigest, caseDigest: sha(JSON.stringify(fixture)),
      candidateDigest: sha(JSON.stringify(files)), files, candidate, outcome,
      scale: fixture.scale, metadata, grader: { nodeVersion: process.version, backend: "codex sandbox (no model)", elapsedSeconds: (Date.now() - started) / 1000 },
      check: {
        startedAt: check.startedAt, finishedAt: check.finishedAt, timeoutSeconds: check.timeoutSeconds,
        exitCode: check.exitCode, signal: check.signal, error: check.error?.slice(0, 512) ?? null,
        sandbox: check.sandbox,
        sandboxVerified,
        stdout: { text: check.stdout.text.slice(-4096), truncated: check.stdout.truncated || check.stdout.text.length > 4096 },
        stderr: { text: check.stderr.text.slice(-4096), truncated: check.stderr.truncated || check.stderr.text.length > 4096 },
        ...(preserve ? { terminationUncertain: true, snapshot: temporary, captureDirectory: check.captureDirectory, processGroup: check.processGroup } : {})
      }
    };
  } finally {
    listener.close();
    if (!preserve) fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function compare(options) {
  if (!options.left || !options.right) fail("compare requires --left and --right receipts");
  const receipts = [readJson(options.left), readJson(options.right)];
  for (const receipt of receipts) {
    if (receipt.schemaVersion !== 1 || !["passed", "failed"].includes(receipt.outcome)) fail("Only completed schemaVersion 1 grades can be compared");
    if (receipt.check?.sandboxVerified !== true) fail("Regrade receipts without a verified sandbox before comparing");
    receipt.metadata = normalizeMetadata(receipt.metadata, caseById(receipt.caseId));
    if (!receipt.metadata.matchId || conditionsKeys.some((key) => receipt.metadata.conditions?.[key] == null)) fail("Matched comparison requires matchId and all declared conditions (unknown stays unknown)");
  }
  const [left, right] = receipts;
  if (left.metadata.arm === right.metadata.arm) fail("Comparison requires different arms");
  for (const key of ["caseId", "suiteDigest", "caseDigest"]) if (!left[key] || left[key] !== right[key]) fail(`Mismatched ${key}`);
  for (const key of ["matchId", "trialKind"]) if (left.metadata[key] !== right.metadata[key]) fail(`Mismatched ${key}`);
  for (const key of conditionsKeys) if (left.metadata.conditions[key] !== right.metadata.conditions[key]) fail(`Mismatched condition: ${key}`);
  if (!left.grader?.nodeVersion || left.grader.nodeVersion !== right.grader?.nodeVersion) fail("Mismatched grader Node version");
  return {
    schemaVersion: 1, caseId: left.caseId, matchId: left.metadata.matchId, trialKind: left.metadata.trialKind,
    conditions: left.metadata.conditions,
    arms: receipts.map(({ outcome, metadata }) => ({ outcome, ...metadata })),
    interpretation: "One descriptive matched pair, not statistical superiority or a causal estimate. Self-reported metadata is not independently verified. Mechanics is not model-quality evidence. No learning records are written."
  };
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const allowed = { list: [], prepare: ["case", "dest"], grade: ["case", "candidate", "metadata", "out"], compare: ["left", "right", "out"] };
  if (!Object.hasOwn(allowed, command)) fail("Usage: evaluate.mjs list | prepare --case ID [--dest NEW_DIR] | grade --case ID --candidate DIR --metadata FILE [--out FILE] | compare --left FILE --right FILE [--out FILE]");
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index].slice(2);
    if (!args[index].startsWith("--") || !allowed[command].includes(key) || Object.hasOwn(options, key) || !args[index + 1] || args[index + 1].startsWith("--")) fail(`Invalid option: ${args[index]}`);
    options[key] = args[index + 1];
  }
  if (options.out) {
    const output = path.resolve(options.out);
    const resolved = path.join(fs.realpathSync(path.dirname(output)), path.basename(output));
    const isLearningPath = (file) => /(?:^|\/)\.orchestrator\/local\/learning(?:\/|$)/i.test(file);
    if (isLearningPath(output) || isLearningPath(resolved)) fail("--out must be outside the learning store");
    options.out = resolved;
  }
  const result = command === "list" ? { schemaVersion: 1, suiteDigest, cases: manifest.cases.map(({ id, kind, scale, rejects }) => ({ id, kind, scale, rejects })) }
    : command === "prepare" ? prepare(options) : command === "grade" ? await grade(options) : compare(options);
  if (options.out) writeNew(options.out, json(result));
  process.stdout.write(json(result));
  if (command === "grade") process.exitCode = result.outcome === "passed" ? 0 : result.outcome === "failed" ? 1 : 2;
}

try { await main(); } catch (error) {
  process.stderr.write(`evaluation: ${error.message}\n`);
  process.exitCode = 2;
}
