import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { after, test } from "node:test";

import { CLI, cleanup, git, makeRepo, runCli, write, writeResult } from "./helpers.mjs";

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
  assert.deepEqual(local.snapshots.api.dirtyFiles, ["already-dirty.txt"]);
  assert.match(local.snapshots.api.fingerprints["already-dirty.txt"], /^file:/);
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

test("lane commands refuse to create a partially initialized workspace", () => {
  const root = makeRepo();
  repos.push(root);
  const result = runCli(root, ["lane", "add", "api", "--scope", "src/**"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /not initialized/);
  assert.equal(fs.existsSync(path.join(root, ".orchestrator")), false);
});

test("unknown options are rejected instead of silently weakening a lane", () => {
  const root = repo();
  const result = runCli(root, ["lane", "add", "api", "--scoop", "src/**"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Unknown option --scoop/);
});

test("accept detects changes made to a file that was already dirty", () => {
  const root = repo();
  runCli(root, ["lane", "add", "api", "--scope", "src/**"]);
  write(root, "src/existing.js", "before dispatch\n");
  runCli(root, ["brief", "api", "--task", "finish the file"]);
  write(root, "src/existing.js", "after dispatch\n");

  const resultPath = writeResult(
    "## RESULT\nfiles_touched: src/existing.js\ndecisions: none\nassumptions: none\nblockers: none\nconfidence: high\n"
  );
  const result = runCli(root, ["accept", "api", "--result-file", resultPath, "--json"]);
  assert.equal(result.code, 0);
  const evaluation = JSON.parse(result.stdout);
  assert.deepEqual(evaluation.changed, ["src/existing.js"]);
  assert.deepEqual(evaluation.preexisting, []);
});

test("accept detects files committed by a worker after the briefing", () => {
  const root = repo();
  runCli(root, ["lane", "add", "api", "--scope", "src/**"]);
  runCli(root, ["brief", "api", "--task", "add a module"]);
  write(root, "src/new.js", "export const value = 1;\n");
  git(root, ["add", "src/new.js"]);
  git(root, ["commit", "--quiet", "-m", "worker change"]);

  const resultPath = writeResult(
    "## RESULT\nfiles_touched: src/new.js\ndecisions: none\nassumptions: none\nblockers: none\nconfidence: high\n"
  );
  const result = runCli(root, ["accept", "api", "--result-file", resultPath, "--json"]);
  assert.equal(result.code, 0);
  const evaluation = JSON.parse(result.stdout);
  assert.deepEqual(evaluation.changed, ["src/new.js"]);
  assert.deepEqual(evaluation.committed, ["src/new.js"]);
  assert.equal(evaluation.headChanged, true);
});

test("accept flags a branch switch after the briefing", () => {
  const root = repo();
  runCli(root, ["lane", "add", "api", "--scope", "src/**"]);
  runCli(root, ["brief", "api", "--task", "inspect"]);
  git(root, ["checkout", "-q", "-b", "other"]);
  const resultPath = writeResult(
    "## RESULT\nfiles_touched: none\ndecisions: none\nassumptions: none\nblockers: none\nconfidence: high\n"
  );
  const result = runCli(root, ["accept", "api", "--result-file", resultPath, "--json"]);
  assert.equal(result.code, 2);
  const evaluation = JSON.parse(result.stdout);
  assert.equal(evaluation.branchChanged, true);
  assert.match(evaluation.problems.join(" "), /branch changed/);
});

test("concurrent lane additions do not lose state", async () => {
  const root = repo();
  const names = Array.from({ length: 8 }, (_, index) => `lane-${index}`);
  await Promise.all(
    names.map(
      (name) =>
        new Promise((resolve, reject) => {
          const child = spawn(process.execPath, [CLI, "lane", "add", name, "--scope", `${name}/**`], {
            cwd: root,
            stdio: ["ignore", "pipe", "pipe"]
          });
          let stderr = "";
          child.stderr.setEncoding("utf8");
          child.stderr.on("data", (chunk) => {
            stderr += chunk;
          });
          child.on("error", reject);
          child.on("exit", (code) => {
            if (code === 0) {
              resolve();
            } else {
              reject(new Error(`lane add exited ${code}: ${stderr}`));
            }
          });
        })
    )
  );
  const lanes = JSON.parse(runCli(root, ["lane", "list", "--json"]).stdout);
  assert.deepEqual(lanes.map((lane) => lane.name), names);
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

test("run commands persist a plan, ready queue, checkpoint, and restart briefing", () => {
  const root = repo();
  runCli(root, [
    "lane",
    "add",
    "api",
    "--scope",
    "src/api/**",
    "--constraint",
    "No new dependencies",
    "--done",
    "tests pass"
  ]);
  const created = JSON.parse(
    runCli(root, [
      "run",
      "create",
      "api",
      "--id",
      "run-cli",
      "--objective",
      "Add cursor pagination",
      "--max-workers",
      "4",
      "--effort",
      "xhigh",
      "--json"
    ]).stdout
  );
  assert.equal(created.workerPolicy.model, "gpt-5.6-sol");
  assert.equal(created.workerPolicy.maxWorkers, 4);

  const planPath = writeResult(
    JSON.stringify({
      tasks: [
        {
          id: "implementation",
          title: "Implement",
          objective: "Add the cursor logic",
          acceptance: ["targeted tests pass"]
        },
        {
          id: "review",
          title: "Review",
          objective: "Review the implementation",
          kind: "verify",
          dependsOn: ["implementation"],
          acceptance: ["no P1 findings"]
        }
      ]
    })
  );
  const planned = runCli(root, [
    "run",
    "plan",
    "run-cli",
    "--plan-file",
    planPath,
    "--json"
  ]);
  assert.equal(planned.code, 0);
  assert.equal(JSON.parse(planned.stdout).planRevision, 1);

  const ready = JSON.parse(runCli(root, ["run", "ready", "run-cli", "--json"]).stdout);
  assert.deepEqual(ready.map((task) => task.id), ["implementation"]);

  const checkpoint = runCli(root, [
    "run",
    "checkpoint",
    "run-cli",
    "--summary",
    "Plan approved",
    "--decision",
    "Keep cursors opaque",
    "--next",
    "Dispatch implementation"
  ]);
  assert.equal(checkpoint.code, 0);

  const briefing = runCli(root, ["run", "briefing", "run-cli"]).stdout;
  assert.match(briefing, /Claude supervisor/);
  assert.match(briefing, /Plan approved/);
  assert.match(briefing, /implementation — Implement/);
  assert.match(briefing, /No new dependencies/);

  const dispatch = JSON.parse(
    runCli(root, ["run", "claim", "run-cli", "implementation", "--json"]).stdout
  );
  assert.equal(dispatch.model, "gpt-5.6-sol");
  assert.deepEqual(dispatch.routingFlags.slice(0, 3), [
    "--fresh",
    "--model",
    "gpt-5.6-sol"
  ]);
  const bound = runCli(root, [
    "run",
    "bind",
    "run-cli",
    "implementation",
    "--attempt",
    dispatch.attemptId,
    "--agent-id",
    "agent-cli",
    "--job-id",
    "job-cli",
    "--thread-id",
    "thread-cli"
  ]);
  assert.equal(bound.code, 0);

  const active = JSON.parse(
    runCli(root, ["run", "recover", "run-cli", "--json"]).stdout
  );
  assert.equal(active[0].jobId, "job-cli");
  const resumed = JSON.parse(
    runCli(root, ["run", "resume", "run-cli", "--json"]).stdout
  );
  assert.equal(resumed.recovery[0].threadId, "thread-cli");
  assert.match(resumed.briefing, /latest worker: thread thread-cli/);

  const resultPath = writeResult(
    "Implemented pagination.\n\n## RESULT\nfiles_touched: src/api/users.js\ndecisions: none\nassumptions: none\nblockers: none\nconfidence: high\n"
  );
  const reported = JSON.parse(
    runCli(root, [
      "run",
      "report",
      "run-cli",
      "implementation",
      "--attempt",
      dispatch.attemptId,
      "--result-file",
      resultPath,
      "--json"
    ]).stdout
  );
  assert.equal(reported.task.status, "reported");

  const verified = JSON.parse(
    runCli(root, [
      "run",
      "verify",
      "run-cli",
      "implementation",
      "--verdict",
      "pass",
      "--evidence",
      "targeted tests passed",
      "--json"
    ]).stdout
  );
  assert.equal(verified.task.status, "completed");
  assert.deepEqual(verified.ready.map((task) => task.id), ["review"]);

  const reviewDispatch = JSON.parse(
    runCli(root, ["run", "claim", "run-cli", "review", "--json"]).stdout
  );
  const reviewResult = writeResult(
    "Reviewed the implementation.\n\n## RESULT\nfiles_touched: none\ndecisions: none\nassumptions: none\nblockers: none\nconfidence: high\n"
  );
  runCli(root, [
    "run",
    "report",
    "run-cli",
    "review",
    "--attempt",
    reviewDispatch.attemptId,
    "--result-file",
    reviewResult
  ]);
  const reviewVerified = JSON.parse(
    runCli(root, [
      "run",
      "verify",
      "run-cli",
      "review",
      "--verdict",
      "pass",
      "--evidence",
      "review passed",
      "--json"
    ]).stdout
  );
  assert.equal(reviewVerified.runStatus, "finalizing");

  const finalized = JSON.parse(
    runCli(root, [
      "run",
      "finalize",
      "run-cli",
      "--verdict",
      "pass",
      "--summary",
      "Combined checks passed.",
      "--evidence",
      "node --test passed",
      "--json"
    ]).stdout
  );
  assert.equal(finalized.status, "completed");
  assert.equal(finalized.finalization.summary, "Combined checks passed.");
});
