import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

test("the run command keeps Claude in authority and routes only within the GPT-5.6 pool", () => {
  const command = fs.readFileSync(
    path.join(root, "plugins", "orchestrator", "commands", "run.md"),
    "utf8"
  );
  assert.match(
    command,
    /The Claude model running the main thread is always the planner, scheduler, reviewer, replanner,\s+and integrator/
  );
  assert.match(command, /Claude Opus and Claude Fable are both supported supervisors/);
  assert.match(command, /--model <auto\|sol\|terra\|luna>/);
  assert.match(command, /use `sol` for the hardest open-ended implementation/);
  assert.match(command, /use `terra` for strong general coding/);
  assert.match(command, /use `luna` for clear, repeatable, high-volume/);
  assert.match(command, /Select effort independently/);
  assert.match(command, /Prefer the lowest effort that should reliably/);
  assert.match(
    command,
    /only `gpt-5\.6-sol`, `gpt-5\.6-terra`, or `gpt-5\.6-luna`/
  );
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
  assert.match(command, /Retry transient worker failures once/);
  assert.match(command, /run checkpoint <run-id>/);
  assert.match(
    command,
    /refuses to dispatch\s+until a checkpoint covers the current plan and provisional-guidance revisions/
  );
  assert.match(command, /run guidance <run-id>/);
  assert.match(command, /bounded advisory block/);
  assert.match(command, /--mode off/);
  assert.match(command, /--rollback/);
  assert.match(command, /Every worker runs in its own isolated worktree/);
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
  assert.match(command, /whether that is Claude Opus or Claude Fable/);
  assert.match(command, /gpt-5\.6-sol/);
  assert.match(command, /gpt-5\.6-terra/);
  assert.match(command, /gpt-5\.6-luna/);
});
