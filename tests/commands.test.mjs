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
  assert.match(command, /Claude Fable is always the planner, scheduler, reviewer, replanner, and integrator/);
  assert.match(command, /--model gpt-5\.6-sol/);
  assert.match(command, /detached `codex exec` process/);
  assert.match(command, /worker report is not\s+completion/i);
  assert.match(command, /run recover/);
  assert.match(command, /run briefing/);
});

test("the run command requires evidence gates and bounded retries", () => {
  const command = fs.readFileSync(
    path.join(root, "plugins", "orchestrator", "commands", "run.md"),
    "utf8"
  );
  assert.match(command, /evaluate every acceptance criterion/);
  assert.match(command, /Retry transient worker failures once/);
  assert.match(command, /Every worker runs in its own isolated worktree/);
});
