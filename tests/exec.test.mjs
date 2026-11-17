import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { resolveExecutable, signalProcessGroup } from "../plugins/orchestrator/scripts/lib/exec.mjs";

test("an executable found on PATH keeps the name it was found under, for multi-call shims", () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "orch-exec-"));
  const saved = process.env.PATH;
  try {
    // Volta's layout: bin/codex is a symlink to one shared shim that reads argv[0].
    fs.mkdirSync(path.join(root, "bin"));
    fs.writeFileSync(path.join(root, "shim"), "#!/bin/sh\n", { mode: 0o755 });
    fs.symlinkSync(path.join(root, "shim"), path.join(root, "bin", "codex"));
    process.env.PATH = ["relative/bin", path.join(root, "bin")].join(path.delimiter);
    assert.equal(resolveExecutable("codex"), path.join(root, "bin", "codex"));
    // Relative PATH entries are still never trusted.
    process.env.PATH = "bin";
    assert.throws(() => resolveExecutable("codex", root), /not found in absolute PATH entries/);
  } finally {
    process.env.PATH = saved;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("signalling a process group reports whether anything was left to signal", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
  await new Promise((resolve) => child.once("spawn", resolve));
  const exited = new Promise((resolve) => child.once("exit", resolve));
  assert.equal(signalProcessGroup(child.pid, "SIGKILL"), true);
  await exited;
  assert.equal(signalProcessGroup(child.pid, "SIGKILL"), false, "a gone group is not an error");
});
