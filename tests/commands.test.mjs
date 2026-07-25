import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

test("the run command keeps Claude in authority and pins the Codex pool", () => {
  const command = fs.readFileSync(
    path.join(root, "plugins", "orchestrator", "commands", "run.md"),
    "utf8"
  );
  assert.match(
    command,
    /The Claude model running the main thread is always the planner, scheduler, reviewer, replanner,\s+and integrator/
  );
  assert.match(command, /Claude Opus and Claude Fable are both supported supervisors/);
  assert.match(command, /--model gpt-5\.6-sol/);
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
  assert.match(command, /Retry transient worker failures once/);
  assert.match(command, /run checkpoint <run-id>/);
  assert.match(command, /refuses to dispatch\s+until a checkpoint covers the current plan revision/);
  assert.match(command, /Every worker runs in its own isolated worktree/);
});

test("the resume command restores durable state and keeps Claude in authority", () => {
  const command = fs.readFileSync(
    path.join(root, "plugins", "orchestrator", "commands", "resume.md"),
    "utf8"
  );
  assert.match(command, /run resume <run-id> --json/);
  assert.match(command, /Treat it as authoritative over\s+conversation memory/);
  assert.match(
    command,
    /The Claude model running this main thread remains the planner, scheduler, reviewer, replanner,\s+integrator/
  );
  assert.match(command, /whether that is Claude Opus or Claude Fable/);
  assert.match(command, /gpt-5\.6-sol/);
});
