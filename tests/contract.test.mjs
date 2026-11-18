import assert from "node:assert/strict";
import { after, test } from "node:test";

import { cleanup, git, makeRepo, runCli, write } from "./helpers.mjs";

const repos = [];
after(() => repos.forEach(cleanup));

function cli(root, args) {
  const result = runCli(root, args);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  return result.stdout;
}

function repo() {
  const root = makeRepo();
  repos.push(root);
  cli(root, ["init"]);
  cli(root, ["lane", "add", "api", "--scope", "src/**", "--scope", "!src/private/**", "--constraint", "Keep the API stable", "--done", "Checks pass"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-qm", "Configure project"]);
  cli(root, ["run", "create", "api", "--id", "work", "--objective", "Improve the API", "--model", "sol", "--effort", "high"]);
  return root;
}

function task(id, scope = [`src/${id}.js`]) {
  return { id, title: id, objective: `Implement ${id}`, scope, acceptance: ["The API returns the expected result"] };
}

function plan(root, tasks, extra = []) {
  const file = write(root, ".orchestrator/local/plan.json", JSON.stringify({ tasks }));
  return runCli(root, ["run", "plan", "work", "--plan-file", file, ...extra, "--json"]);
}

function checkpoint(root) {
  cli(root, ["run", "checkpoint", "work", "--summary", "Reviewed plan and authority"]);
}

test("initial scope and acceptance are enforced against the frozen lane", () => {
  const root = repo();
  assert.match(plan(root, [task("billing", ["billing/**"])]).stderr, /outside lane/);
  assert.match(plan(root, [task("private", ["src/private/a.js"])]).stderr, /outside lane/);
  assert.match(plan(root, [{ ...task("empty"), acceptance: [] }]).stderr, /acceptance criterion/);
  cli(root, ["lane", "add", "api", "--scope", "**", "--constraint", "Changed later", "--done", "Different check"]);
  assert.match(plan(root, [task("billing", ["billing/**"])]).stderr, /outside lane/);
  assert.equal(plan(root, [task("safe")]).code, 0);
  checkpoint(root);
  const dispatch = JSON.parse(cli(root, ["run", "claim", "work", "safe", "--json"]));
  assert.match(dispatch.briefing, /Keep the API stable/);
  assert.doesNotMatch(dispatch.briefing, /Changed later/);
});

test("out-of-lane approval is explicit and bound to the exact task scope", () => {
  const root = repo();
  assert.equal(plan(root, [task("billing", ["billing/a.js"])], ["--user-approved"]).code, 0);
  assert.equal(plan(root, [task("billing", ["billing/a.js"])]).code, 0, "approved scope survives replan");
  assert.match(plan(root, [task("billing", ["billing/b.js"])]).stderr, /outside lane/);
  checkpoint(root);
  assert.equal(JSON.parse(cli(root, ["run", "claim", "work", "billing", "--json"])).taskId, "billing");
});

test("definitely shared writers wait, while disjoint writers stay parallel", () => {
  const root = repo();
  const result = plan(root, [task("first", ["src/shared.js"]), task("second", ["src/shared.js"]), task("independent")]);
  assert.equal(result.code, 0, result.stderr);
  assert.ok(JSON.parse(result.stdout).warnings.length);
  checkpoint(root);
  cli(root, ["run", "claim", "work", "first"]);
  assert.match(runCli(root, ["run", "claim", "work", "second"]).stderr, /already owned/);
  cli(root, ["run", "claim", "work", "independent"]);
  const ready = JSON.parse(cli(root, ["run", "ready", "work", "--json"]));
  assert.equal(ready.blocked[0].id, "second");
  assert.equal(JSON.parse(cli(root, ["run", "show", "work", "--json"])).tasks.second.attempts.length, 0);
});
