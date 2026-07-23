import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";

import { cleanup, git, makeRepo, runCli, write, writeResult } from "./helpers.mjs";

const repos = [];

function repo() {
  const root = makeRepo();
  repos.push(root);
  runCli(root, ["init"]);
  return root;
}

after(() => {
  for (const root of repos) {
    cleanup(root);
  }
});

test("init creates the state layout and self-ignores local state", () => {
  const root = repo();
  assert.ok(fs.existsSync(path.join(root, ".orchestrator", "lanes.json")));
  assert.ok(fs.existsSync(path.join(root, ".orchestrator", "ledger.md")));
  assert.ok(fs.existsSync(path.join(root, ".orchestrator", "local", "threads.json")));

  const ignore = fs.readFileSync(path.join(root, ".orchestrator", ".gitignore"), "utf8");
  assert.match(ignore, /local\//);

  // The committed half is tracked; the machine-local half is not.
  git(root, ["add", "-A"]);
  const staged = git(root, ["diff", "--cached", "--name-only"]);
  assert.match(staged, /\.orchestrator\/lanes\.json/);
  assert.match(staged, /\.orchestrator\/ledger\.md/);
  assert.doesNotMatch(staged, /threads\.json/);
});

test("init is idempotent and does not clobber existing state", () => {
  const root = repo();
  runCli(root, ["lane", "add", "api", "--scope", "src/api/**"]);
  runCli(root, ["init"]);
  const lanes = JSON.parse(fs.readFileSync(path.join(root, ".orchestrator", "lanes.json"), "utf8"));
  assert.ok(lanes.lanes.api);
});

test("lanes round-trip through the CLI", () => {
  const root = repo();
  runCli(root, [
    "lane",
    "add",
    "api",
    "--description",
    "HTTP layer",
    "--scope",
    "src/api/**",
    "--constraint",
    "No new dependencies",
    "--done",
    "tests pass"
  ]);

  const shown = JSON.parse(runCli(root, ["lane", "show", "api", "--json"]).stdout);
  assert.equal(shown.description, "HTTP layer");
  assert.deepEqual(shown.scope, ["src/api/**"]);
  assert.deepEqual(shown.constraints, ["No new dependencies"]);
  assert.equal(shown.threadId, null);
});

test("an unknown lane is an error that lists the known ones", () => {
  const root = repo();
  runCli(root, ["lane", "add", "api", "--scope", "src/**"]);
  const result = runCli(root, ["lane", "show", "nope"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Unknown lane "nope"/);
  assert.match(result.stderr, /Known lanes: api/);
});

test("invalid lane names are rejected", () => {
  const root = repo();
  const result = runCli(root, ["lane", "add", "Not A Lane"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Invalid lane name/);
});

test("thread bindings survive as machine-local state", () => {
  const root = repo();
  runCli(root, ["lane", "add", "api", "--scope", "src/**"]);
  runCli(root, ["lane", "bind", "api", "thread-abc123"]);

  const shown = JSON.parse(runCli(root, ["lane", "show", "api", "--json"]).stdout);
  assert.equal(shown.threadId, "thread-abc123");

  runCli(root, ["lane", "unbind", "api"]);
  assert.equal(JSON.parse(runCli(root, ["lane", "show", "api", "--json"]).stdout).threadId, null);
});

test("removing a lane also drops its thread binding", () => {
  const root = repo();
  runCli(root, ["lane", "add", "api", "--scope", "src/**"]);
  runCli(root, ["lane", "bind", "api", "thread-abc123"]);
  runCli(root, ["lane", "remove", "api"]);

  const local = JSON.parse(fs.readFileSync(path.join(root, ".orchestrator", "local", "threads.json"), "utf8"));
  assert.equal(local.threads.api, undefined);
});

test("brief compiles a briefing and snapshots the tree", () => {
  const root = repo();
  runCli(root, ["lane", "add", "api", "--scope", "src/api/**"]);
  write(root, "already-dirty.txt", "dirty\n");

  const payload = JSON.parse(runCli(root, ["brief", "api", "--task", "Add pagination", "--json"]).stdout);
  assert.equal(payload.lane, "api");
  assert.equal(payload.resuming, false);
  assert.match(payload.briefing, /Add pagination/);
  assert.match(payload.briefing, /## RESULT/);

  const local = JSON.parse(fs.readFileSync(path.join(root, ".orchestrator", "local", "threads.json"), "utf8"));
  assert.deepEqual(local.snapshots.api.changedFiles, ["already-dirty.txt"]);
});

test("brief marks a bound lane as resuming", () => {
  const root = repo();
  runCli(root, ["lane", "add", "api", "--scope", "src/**"]);
  runCli(root, ["lane", "bind", "api", "thread-abc123"]);
  const payload = JSON.parse(runCli(root, ["brief", "api", "--task", "continue", "--json"]).stdout);
  assert.equal(payload.resuming, true);
  assert.equal(payload.threadId, "thread-abc123");
});

test("accept attributes only post-briefing changes and exits 2 on violations", () => {
  const root = repo();
  runCli(root, ["lane", "add", "api", "--scope", "src/api/**"]);
  write(root, "already-dirty.txt", "dirty\n");
  runCli(root, ["brief", "api", "--task", "Add pagination"]);

  write(root, "src/api/users.js", "export const users = [];\n");
  write(root, "src/db/schema.js", "export const schema = {};\n");

  const resultPath = writeResult(
    "Did the work.\n\n## RESULT\nfiles_touched: src/api/users.js\ndecisions: none\nassumptions: none\nblockers: none\nconfidence: high\n"
  );

  const result = runCli(root, ["accept", "api", "--result-file", resultPath, "--json"]);
  assert.equal(result.code, 2);

  const evaluation = JSON.parse(result.stdout);
  assert.equal(evaluation.verdict, "review");
  assert.ok(!evaluation.changed.includes("already-dirty.txt"));
  assert.ok(evaluation.outOfScope.includes("src/db/schema.js"));
  assert.ok(evaluation.undeclared.includes("src/db/schema.js"));
});

test("accept exits 0 when the run stayed in scope and reported honestly", () => {
  const root = repo();
  runCli(root, ["lane", "add", "api", "--scope", "src/api/**"]);
  runCli(root, ["brief", "api", "--task", "Add pagination"]);
  write(root, "src/api/users.js", "export const users = [];\n");

  const resultPath = writeResult(
    "## RESULT\nfiles_touched: src/api/users.js\ndecisions: none\nassumptions: none\nblockers: none\nconfidence: high\n"
  );

  const result = runCli(root, ["accept", "api", "--result-file", resultPath]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /Verdict: clean/);
});

test("accept refuses to guess when no briefing snapshot exists", () => {
  const root = repo();
  runCli(root, ["lane", "add", "api", "--scope", "src/**"]);
  const result = runCli(root, ["accept", "api"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /No pre-dispatch snapshot/);
});

test("ledger entries are dated, sectioned, and reach the briefing", () => {
  const root = repo();
  runCli(root, ["lane", "add", "api", "--scope", "src/**"]);
  runCli(root, ["ledger", "add", "decisions", "Errors are returned, never thrown."]);
  runCli(root, ["ledger", "add", "failed approaches", "Retrying on 4xx made it worse."]);

  const ledger = runCli(root, ["ledger", "show"]).stdout;
  assert.match(ledger, /## Decisions\n\n- \(\d{4}-\d{2}-\d{2}\) Errors are returned, never thrown\./);
  assert.match(ledger, /## Failed approaches\n\n- \(\d{4}-\d{2}-\d{2}\) Retrying on 4xx made it worse\./);

  const payload = JSON.parse(runCli(root, ["brief", "api", "--task", "x", "--json"]).stdout);
  assert.match(payload.briefing, /Errors are returned, never thrown\./);
  assert.match(payload.briefing, /Retrying on 4xx made it worse\./);
});

test("an unknown ledger section is rejected with the valid ones", () => {
  const root = repo();
  const result = runCli(root, ["ledger", "add", "musings", "something"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Unknown ledger section/);
});

test("commands refuse to run before init", () => {
  const root = makeRepo();
  repos.push(root);
  const result = runCli(root, ["brief", "api", "--task", "x"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /not initialized/);
});

test("state written by a newer version is refused rather than misread", () => {
  const root = repo();
  fs.writeFileSync(
    path.join(root, ".orchestrator", "lanes.json"),
    JSON.stringify({ version: 99, lanes: {} }),
    "utf8"
  );
  const result = runCli(root, ["lane", "list"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /newer orchestrator/);
});
