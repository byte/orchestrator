import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

test("the run command keeps Claude in authority and routes only within the worker roster", () => {
  const command = fs.readFileSync(
    path.join(root, "plugins", "orchestrator", "commands", "run.md"),
    "utf8"
  );
  assert.match(
    command,
    /The Claude model running the main thread is always the planner, scheduler, reviewer, replanner,\s+and integrator/
  );
  assert.match(command, /Claude Opus 5\.5 and Claude Fable 5\.2 are the supported supervisors/);
  assert.match(command, /the plugin never selects it/);
  assert.match(command, /--model <auto\|astra\|sol\|terra\|luna>/);
  assert.match(command, /use `sol` by default for anything non-trivial/);
  assert.match(command, /use `terra` for well-bounded everyday coding/);
  assert.match(command, /use `astra` when a wrong result would be expensive or hard to catch/);
  assert.match(command, /use `luna` only for mechanical work whose acceptance criteria catch a bad result\s+immediately/);
  assert.match(command, /Select effort independently\. Default to `high` on `sol` and `astra`/);
  assert.doesNotMatch(command, /Prefer the lowest effort/);
  assert.doesNotMatch(command, /`luna` does not support `ultra`/);
  assert.match(command, /Independent `verify` tasks default to `astra`/);
  assert.match(command, /There is no cap on `astra` tasks/);
  assert.match(command, /rejects a `luna` route on any task that another task\s+depends on/);
  assert.match(command, /Flags never make the first positional token a lane/);
  assert.match(
    command,
    /--max-workers 3 add cursor pagination[\s\S]+objective is `add cursor\s+pagination`/
  );
  assert.doesNotMatch(command, /When flags are present: the first positional token is the lane/);
  assert.match(
    command,
    /only `gpt-6-astra`, `gpt-6\.1-sol`, `gpt-6\.1-terra`, or `gpt-5\.6-luna`/
  );
  assert.match(command, /Never substitute a model or effort silently/);
  assert.match(command, /`astra` → `sol` → `terra` → `luna`/);
  assert.doesNotMatch(command, /GPT-5\.6/);
  assert.match(command, /model-routing rationale/);
  assert.match(command, /omitted task routing is an invalid plan/);
  assert.match(command, /explicitly pins a model, every task uses that model/);
  assert.match(command, /Automatic routing must never mean a hidden runtime fallback/);
  assert.match(command, /detached `codex exec` process/);
  assert.match(command, /worker report is not\s+completion/i);
  assert.match(command, /run recover/);
  assert.match(command, /run briefing/);
  assert.match(command, /run resume/);
  assert.match(command, /run finalize/);
});

test("the run command requires evidence gates and bounded retries", () => {
  const command = fs.readFileSync(
    path.join(root, "plugins", "orchestrator", "commands", "run.md"),
    "utf8"
  );
  assert.match(command, /evaluate every acceptance criterion/);
  assert.match(command, /Retry transient worker failures \(a crash, a missing result\) once; that retry starts cold/);
  assert.match(command, /run retry <run-id> <task-id> \\\n\s+--note/);
  assert.match(command, /A retry is warm by default/);
  assert.match(command, /`--fresh`/);
  assert.match(command, /two warm retries of the same task have failed/);
  assert.match(command, /run checkpoint <run-id>/);
  assert.match(
    command,
    /refuses to dispatch\s+until a checkpoint covers the current plan and provisional-guidance revisions/
  );
  assert.match(command, /run guidance <run-id>/);
  assert.match(command, /bounded advisory block/);
  assert.match(command, /--mode off/);
  assert.match(command, /--rollback/);
  assert.match(command, /Every write task runs in its own isolated worktree/);
});

test("the resume command restores durable state and keeps Claude in authority", () => {
  const command = fs.readFileSync(
    path.join(root, "plugins", "orchestrator", "commands", "resume.md"),
    "utf8"
  );
  assert.match(command, /run resume <run-id> --json/);
  assert.match(command, /Treat it as authoritative over conversation\s+memory/);
  assert.match(command, /persisted attempt\s+selections/);
  assert.match(command, /never reselect it from the current learning\s+store during recovery/);
  assert.match(
    command,
    /The Claude model running this main thread remains the planner, scheduler, reviewer, replanner,\s+integrator/
  );
  assert.match(command, /whether that is Claude Opus 5\.5 or Claude Fable 5\.2/);
  for (const slug of ["gpt-6-astra", "gpt-6.1-sol", "gpt-6.1-terra", "gpt-5.6-luna"]) {
    assert.match(command, new RegExp(slug.replaceAll(".", "\\.")));
  }
  assert.match(command, /persisted `gpt-5\.6-sol` or `gpt-5\.6-terra` slug/);
  assert.match(command, /Model availability and substitutions/);
});

test("the legacy single-task commands are retired", () => {
  const commands = path.join(root, "plugins", "orchestrator", "commands");
  assert.equal(fs.existsSync(path.join(commands, "do.md")), false);
  assert.equal(fs.existsSync(path.join(commands, "accept.md")), false);
  for (const file of fs.readdirSync(commands)) {
    const text = fs.readFileSync(path.join(commands, file), "utf8");
    assert.doesNotMatch(text, /orchestrator:do|orchestrator:accept|codex-rescue/, file);
  }
  for (const skill of ["briefing-compiler", "orchestrator-runtime"]) {
    const text = fs.readFileSync(
      path.join(root, "plugins", "orchestrator", "skills", skill, "SKILL.md"),
      "utf8"
    );
    assert.doesNotMatch(text, /orchestrator:do|orch brief|orch accept|`brief`|`accept`|GPT-5\.6/, skill);
  }
});

test("the run command lets workers ask and limits who may grant scope", () => {
  const read = (...parts) => fs.readFileSync(path.join(root, "plugins", "orchestrator", ...parts), "utf8");
  const command = read("commands", "run.md");
  assert.match(command, /run answer <run-id> <task-id>/);
  assert.match(command, /You may grant an extension inside the lane on your own authority/);
  assert.match(command, /You must ask the user before granting anything outside the lane/);
  assert.match(command, /--user-approved/);
  assert.match(command, /A grant belongs to the task, not the lane/);
  assert.match(command, /at most 3 answered round\s+trips/);
  assert.match(read("commands", "resume.md"), /Workers awaiting your answer/);
  assert.match(read("skills", "orchestrator-runtime", "SKILL.md"), /run answer <run-id> <task-id>/);
});

test("the supervisor waits on a background run wait instead of polling in a loop", () => {
  const read = (...parts) => fs.readFileSync(path.join(root, "plugins", "orchestrator", ...parts), "utf8");
  const command = read("commands", "run.md");
  // `run wait` is a node command, so the existing tool list already allows it.
  assert.match(command, /^allowed-tools: Read, Grep, Glob, Write, Bash\(node:\*\), AskUserQuestion$/m);
  const monitor = command.slice(command.indexOf("## 5. Monitor and collect"), command.indexOf("## 6. Verify"));
  assert.match(monitor, /Do not poll in a loop/);
  assert.match(monitor, /run wait <run-id> --json/);
  assert.match(monitor, /run_in_background: true/);
  assert.doesNotMatch(monitor, /Poll without blocking/);
  for (const code of ["`0`", "`2`", "`3`", "`4`"]) {
    assert.ok(monitor.includes(code), `section 5 documents exit code ${code}`);
  }
  assert.match(monitor, /it is \*\*not\*\* stopped/);
  assert.match(monitor, /run poll <run-id> --json` only for a one-off look/);
  assert.match(command, /`timeoutMinutes` \(optional\)/);
  assert.match(read("commands", "resume.md"), /start one `run wait <run-id> --json` as a background command/);
  const skill = read("skills", "orchestrator-runtime", "SKILL.md");
  assert.match(skill, /never by calling `run poll` in a loop/);
  assert.match(skill, /`0` changed, `2` timed out \(default 1800 s\), `3` no worker running or\s+paused, `4`/);
});

test("the run command routes from its own evidence and sizes waves by write surface", () => {
  const command = fs.readFileSync(path.join(root, "plugins", "orchestrator", "commands", "run.md"), "utf8");
  const plan = command.slice(command.indexOf("## 3. Plan"), command.indexOf("## 4. Dispatch a wave"));
  assert.match(plan, /run routes --lane <lane>/);
  assert.match(plan, /no rate is printed below 5 samples/);
  assert.match(plan, /cite it in\s+`routingReason`/);
  assert.match(plan, /--include-legacy/);
  assert.match(plan, /Size tasks by write-surface independence/);
  assert.doesNotMatch(command, /Prefer 3–5/);
  assert.match(command, /the default pool is 5 concurrent\s+workers/);
});
