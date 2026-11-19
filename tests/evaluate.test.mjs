import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "orch-evaluation-tests-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));
const cli = fileURLToPath(new URL("../scripts/evaluate.mjs", import.meta.url));
const manifest = JSON.parse(fs.readFileSync(new URL("../evaluation/cases.json", import.meta.url), "utf8"));
const bin = path.join(root, "bin");
const log = path.join(root, "sandbox.jsonl");
fs.mkdirSync(bin);
// Protocol fixture ONLY: runs trusted test-written candidates, not hostile code.
// This proves executeCheck argv routing and public CLI grading, NOT OS isolation
// or model quality. There is no CLI bypass flag and no real model invocation.
fs.writeFileSync(path.join(bin, "codex"), `#!${process.execPath}
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
const a = process.argv.slice(2);
if (a[0] !== 'sandbox' || !a.includes('permissions.' + a.find(x => x.startsWith('default_permissions=')).split('"')[1] + '.network.enabled=false')) process.exit(90);
if (!a.some(x => x.endsWith('.extends=":read-only"'))) process.exit(91);
fs.appendFileSync(process.env.EVALUATE_TEST_LOG, JSON.stringify(a) + '\\n');
const i = a.indexOf('--');
const r = spawnSync(a[i+1], a.slice(i+2), {stdio:'inherit'});
process.exit(r.status ?? 92);
`, { mode: 0o700 });
// Extensionless node files are CommonJS outside a package; use explicit ESM.
fs.writeFileSync(path.join(bin, "package.json"), '{"type":"module"}\n');
const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, EVALUATE_TEST_LOG: log };
let counter = 0;
function run(args, environment = env) {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd: root, env: environment, encoding: "utf8", timeout: 30000, maxBuffer: 131072 });
  assert.equal(result.error, undefined);
  return { code: result.status, stdout: result.stdout, stderr: result.stderr, value: result.stdout ? JSON.parse(result.stdout) : null };
}
function prepare(id) {
  const result = run(["prepare", "--case", id, "--dest", path.join(root, `trial-${++counter}`)]);
  assert.equal(result.code, 0, result.stderr);
  return result.value;
}
function write(workspace, relative, data) {
  const target = path.join(workspace, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, data);
}
const conditions = {
  supervisorModel: "fixture-supervisor", supervisorEffort: "high", workerModel: "fixture-worker", workerEffort: "high",
  claudeVersion: "fixture-1", codexVersion: "fixture-2", orchestratorVersion: "fixture-3", timeLimitSeconds: 120
};
function metadata(trial, overrides = {}) {
  const value = { arm: "claude", trialKind: "mechanics", matchId: "pair-1", conditions, elapsedSeconds: 11, humanInterventions: 0, ...overrides };
  fs.writeFileSync(trial.metadata, JSON.stringify(value));
}
function grade(trial, extra = [], environment = env) {
  return run(["grade", "--case", trial.caseId, "--candidate", trial.workspace, "--metadata", trial.metadata, ...extra], environment);
}
const passing = {
  "localized-bug": { "clamp.mjs": "export const clamp = (v, min, max) => Math.min(max, Math.max(min, v));\n" },
  "independent-parts": {
    "slug.mjs": "export const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');\n",
    "initials.mjs": "export const initials = s => s.trim().split(/\\s+/).filter(Boolean).slice(0,2).map(w=>w[0].toUpperCase()).join('');\n"
  },
  "interface-dependent": {
    "price.mjs": "export const parsePrice = s => { if(typeof s !== 'string' || !/^\\d+(?:\\.\\d{2})?$/.test(s)) throw new TypeError(); return {cents:Math.round(Number(s)*100),currency:'USD'}; };\n",
    "receipt.mjs": "import { parsePrice } from './price.mjs'; export const receipt = xs => '$' + (xs.reduce((n,x)=>n+parsePrice(x).cents,0)/100).toFixed(2);\n"
  },
  "offline-dependency": {
    "node_modules/@fixture/words/package.json": manifest.cases.find((entry) => entry.id === "offline-dependency").files["vendor/words/package.json"],
    "node_modules/@fixture/words/index.mjs": manifest.cases.find((entry) => entry.id === "offline-dependency").files["vendor/words/index.mjs"]
  },
  "dirty-review": { "findings.json": JSON.stringify([{ path: "pricing.mjs", line: 1, input: [7, 3], expected: 21 }, { path: "discount.mjs", line: 1, input: [200, 25], expected: 150 }]) },
  "interrupted-integration": { "recover.mjs": "export const recover = s => ({ action:s.phase==='conflict'?'request-resolution':s.completed.length?'noop':s.applied?'record':'retry', integrated:s.completed.length||s.phase==='conflict'||!s.applied?[...s.completed]:['part-a'] });\n" }
};
// Plausible partial/incorrect solutions, not just syntax errors or worker prose.
const incorrect = {
  "localized-bug": { "clamp.mjs": "export const clamp = (v,min,max) => v === 0 ? 0 : v;\n" },
  "independent-parts": { "initials.mjs": "export const initials = s => s.trim()[0]?.toUpperCase() ?? '';\n" },
  "interface-dependent": { "receipt.mjs": manifest.cases.find((entry) => entry.id === "interface-dependent").files["receipt.mjs"] },
  "offline-dependency": { "node_modules/@fixture/words/index.mjs": "export const shout = text => text.toLowerCase();\n" },
  "dirty-review": { "findings.json": JSON.stringify([{ path: "pricing.mjs", line: 1, input: [7, 3], expected: 21 }]) },
  "interrupted-integration": { "recover.mjs": "export const recover = s => ({action:'record',integrated:[...s.completed,'part-a']});\n" }
};

test("public list/prepare creates six frozen disposable Git workspaces, including real dirty/untracked state", () => {
  const listed = run(["list"]);
  assert.equal(listed.code, 0);
  assert.equal(listed.value.cases.length, 6);
  for (const fixture of manifest.cases) {
    const trial = prepare(fixture.id);
    assert.equal(trial.suiteDigest, listed.value.suiteDigest);
    assert.match(trial.baseline, /^[a-f0-9]{40,64}$/);
    const status = execFileSync("git", ["status", "--porcelain"], { cwd: trial.workspace, encoding: "utf8" });
    assert.equal(status, fixture.id === "dirty-review" ? " M pricing.mjs\n?? discount.mjs\n" : "");
    for (const [file, contents] of Object.entries({ ...fixture.files, ...fixture.dirty })) assert.equal(fs.readFileSync(path.join(trial.workspace, file), "utf8"), contents);
    assert.match(fs.readFileSync(trial.task, "utf8"), /deliverable is the files/);
    assert.equal(JSON.parse(fs.readFileSync(trial.metadata)).usage.worker.inputTokens, null);
    assert.equal(run(["prepare", "--case", fixture.id, "--dest", path.dirname(trial.workspace)]).code, 2, "never overwrite a trial");
  }
  assert.equal(run(["prepare", "--case", "unknown"]).code, 2);
  assert.equal(run(["grade", "--case", "localized-bug"]).code, 2);
});

for (const fixture of manifest.cases) test(`public grade: ${fixture.id} rejects seed and plausible wrong solution, accepts observed behavior`, () => {
  const trial = prepare(fixture.id);
  metadata(trial);
  const seed = grade(trial);
  assert.equal(seed.code, 1, seed.stderr || seed.stdout);
  assert.equal(seed.value.outcome, "failed");
  for (const [file, contents] of Object.entries(passing[fixture.id])) write(trial.workspace, file, contents);
  const pass = grade(trial);
  assert.equal(pass.code, 0, pass.stderr || pass.stdout);
  assert.equal(pass.value.outcome, "passed");
  assert.deepEqual(pass.value.check.sandbox, { writable: false, network: false });
  assert.equal(pass.value.metadata.usage.worker.inputTokens, null, "unknown usage is not zero");
  assert.equal(pass.value.metadata.usage.supervisor.costUsd, null);
  assert.equal(pass.value.metadata.elapsedSeconds, 11, "human trial time is separate from grading time");
  assert.ok(pass.value.grader.elapsedSeconds >= 0);
  assert.equal(pass.value.check.timeoutSeconds, 15);
  for (const [file, contents] of Object.entries(incorrect[fixture.id])) write(trial.workspace, file, contents);
  const wrong = grade(trial);
  assert.equal(wrong.code, 1, wrong.stderr || wrong.stdout);
  assert.equal(wrong.value.outcome, "failed");
  assert.notEqual(wrong.value.candidateDigest, pass.value.candidateDigest);
  assert.ok(Buffer.byteLength(wrong.stdout) < 16384, "bounded receipt");
});

test("public grade ignores candidate grader scripts, rejects symlinks/oversize input and early process exit", () => {
  const trial = prepare("localized-bug");
  metadata(trial, { elapsedSeconds: null, humanInterventions: null });
  const marker = path.join(root, "must-not-exist");
  write(trial.workspace, "check.mjs", `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)},'bad');`);
  write(trial.workspace, "clamp.mjs", passing["localized-bug"]["clamp.mjs"]);
  const pass = grade(trial);
  assert.equal(pass.code, 0, pass.stdout || pass.stderr);
  assert.equal(fs.existsSync(marker), false);
  assert.equal(pass.value.metadata.humanInterventions, null);
  assert.equal(pass.value.metadata.elapsedSeconds, null);
  assert.equal(grade(trial, ["--out", path.join(trial.workspace, "receipt.json")]).code, 2);
  const alias = path.join(root, "candidate-alias");
  fs.symlinkSync(trial.workspace, alias);
  assert.equal(grade(trial, ["--out", path.join(alias, "receipt.json")]).code, 2);
  write(trial.workspace, "clamp.mjs", "export const clamp = () => {process.exit(0);};\n");
  assert.equal(grade(trial).code, 1, "exit(0) cannot skip trusted assertions");
  write(trial.workspace, "clamp.mjs", "x".repeat(65537));
  assert.equal(grade(trial).code, 2);
  fs.unlinkSync(path.join(trial.workspace, "clamp.mjs"));
  fs.symlinkSync(path.join(root, "sandbox.jsonl"), path.join(trial.workspace, "clamp.mjs"));
  assert.equal(grade(trial).code, 2);
});

test("public grade reports missing sandbox as unavailable, never falls back to host execution", () => {
  const trial = prepare("localized-bug");
  metadata(trial);
  const marker = path.join(root, "host-fallback-must-not-run");
  write(trial.workspace, "clamp.mjs", `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'bad');\n${passing["localized-bug"]["clamp.mjs"]}`);
  const result = grade(trial, [], { ...env, PATH: bin + "/nonexistent" });
  assert.equal(result.code, 2);
  assert.equal(result.value.outcome, "unavailable");
  assert.match(result.value.check.error, /codex/);
  assert.equal(fs.existsSync(marker), false);
});

test("public compare permits descriptive matched pairs and rejects mismatched/unknown conditions", () => {
  const leftTrial = prepare("localized-bug");
  const rightTrial = prepare("localized-bug");
  metadata(leftTrial, { usage: { supervisor: { inputTokens: 42 }, worker: { inputTokens: 0 } } });
  metadata(rightTrial, { arm: "orchestrator", usage: { worker: { inputTokens: 123 } } });
  write(rightTrial.workspace, "clamp.mjs", passing["localized-bug"]["clamp.mjs"]);
  const leftPath = path.join(root, "left.json");
  const rightPath = path.join(root, "right.json");
  assert.equal(grade(leftTrial, ["--out", leftPath]).code, 1);
  assert.equal(grade(rightTrial, ["--out", rightPath]).code, 0);
  const args = ["compare", "--left", leftPath, "--right", rightPath];
  const compared = run(args);
  assert.equal(compared.code, 0, compared.stderr);
  assert.deepEqual(compared.value.arms.map((arm) => arm.outcome), ["failed", "passed"]);
  assert.equal(compared.value.arms[0].usage.supervisor.inputTokens, 42);
  assert.equal(compared.value.arms[1].usage.worker.inputTokens, 123);
  assert.equal(compared.value.arms[1].usage.supervisor.inputTokens, null);
  assert.match(compared.value.interpretation, /not statistical superiority/);
  assert.match(compared.value.interpretation, /Mechanics is not model-quality/);
  assert.equal(grade(rightTrial, ["--out", rightPath]).code, 2, "no receipt overwrite");
  const original = JSON.parse(fs.readFileSync(rightPath));
  const mutations = [
    r => { r.caseId = "independent-parts"; },
    r => { r.suiteDigest = "other"; },
    r => { r.caseDigest = "other"; },
    r => { r.metadata.arm = "claude"; },
    r => { r.metadata.matchId = "pair-2"; },
    r => { r.metadata.trialKind = "live"; },
    ...Object.keys(conditions).map(key => r => { r.metadata.conditions[key] = key === "timeLimitSeconds" ? 60 : "different"; }),
    r => { r.metadata.conditions.workerModel = null; },
    r => { r.grader.nodeVersion = "v0.0.0"; },
    r => { r.outcome = "unavailable"; }
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(original);
    mutate(changed);
    fs.writeFileSync(rightPath, JSON.stringify(changed));
    assert.equal(run(args).code, 2, "must reject mismatched pair");
  }
  const protocol = prepare("interrupted-integration");
  metadata(protocol, { trialKind: "live" });
  assert.equal(grade(protocol).code, 2, "mechanics cannot be relabeled live");
  const calls = fs.readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
  assert.ok(calls.length > 0);
  assert.ok(calls.every(argv => argv[0] === "sandbox" && argv.includes("--") && argv.some(arg => arg.endsWith("evaluation/check.mjs"))));
  assert.equal(fs.existsSync(path.join(root, ".orchestrator")), false, "no learning writes");
});
