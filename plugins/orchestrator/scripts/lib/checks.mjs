import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

import { changedFiles, headSha } from "./git.mjs";
import { resolveExecutable, signalProcessGroup } from "./exec.mjs";

export function normalizeChecks(checks = []) {
  if (!Array.isArray(checks)) throw new Error("Checks must be an array.");
  const ids = new Set();
  return checks.map((check) => {
    if (!check || typeof check.id !== "string" || !/^[a-z0-9][a-z0-9._-]*$/.test(check.id) || ids.has(check.id)) {
      throw new Error("Each check needs a unique lowercase id.");
    }
    ids.add(check.id);
    const stages = check.stages ?? ["task", "final"];
    if (!Array.isArray(stages) || !stages.length || stages.some((stage) => !["task", "final"].includes(stage))) {
      throw new Error(`Check ${check.id} stages must contain task and/or final.`);
    }
    return { id: check.id, ...normalizeCommand(check), stages: [...new Set(stages)] };
  });
}

export function normalizeCommand(command) {
  if (!command || !Array.isArray(command.argv) || !command.argv.length ||
      command.argv.some((arg) => typeof arg !== "string" || arg.includes("\0")) || !command.argv[0].trim()) {
    throw new Error("A command requires a nonempty argv array of strings, not a shell string.");
  }
  const timeoutSeconds = command.timeoutSeconds ?? 300;
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0 || timeoutSeconds > 3600) {
    throw new Error("Command timeoutSeconds must be greater than 0 and at most 3600.");
  }
  return { argv: [...command.argv], timeoutSeconds };
}

/** HEAD plus dirty source contents, never worker prose, staging state, or just path names. */
export function checkoutFingerprint(cwd, { gitDir = null, scope = null } = {}) {
  const hash = createHash("sha256");
  hash.update(headSha(cwd, gitDir ? { gitDir } : {}) ?? "no-head");
  for (const file of changedFiles(cwd, { gitDir })) {
    if (scope && !scope(file)) continue;
    hash.update(JSON.stringify(file));
    const target = path.join(cwd, file);
    let stat;
    try { stat = fs.lstatSync(target); } catch (error) {
      if (error.code !== "ENOENT") throw error;
      hash.update("deleted");
      continue;
    }
    hash.update(String(stat.mode));
    if (stat.isSymbolicLink()) {
      hash.update(fs.readlinkSync(target));
    } else {
      // O_NONBLOCK avoids a FIFO swapped in between lstat and open. Never
      // follow a worker-planted symlink while collecting evidence outside it.
      const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW);
      try {
        if (!fs.fstatSync(fd).isFile()) throw new Error(`Cannot fingerprint non-regular source path ${file}.`);
        const buffer = Buffer.alloc(64 * 1024);
        let bytes;
        while ((bytes = fs.readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, bytes));
      } finally { fs.closeSync(fd); }
    }
  }
  return hash.digest("hex");
}

/** Execute a trusted argv inside Codex's sandbox, without invoking a model. */
export function executeCheck(cwd, definition, { codexCommand = ["codex"], writable = false, network = false } = {}) {
  const command = normalizeCommand(definition);
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "orch-check-")));
  const profile = `orchestrator-check-${randomUUID().replaceAll("-", "")}`;
  const stdout = path.join(directory, "stdout");
  const stderr = path.join(directory, "stderr");
  const scratch = path.join(directory, "scratch");
  fs.mkdirSync(scratch, { mode: 0o700 });
  const filesystem = { [scratch]: "write", ...(writable ? { [fs.realpathSync(cwd)]: "write" } : {}) };
  const descriptors = [fs.openSync(stdout, "wx", 0o600), fs.openSync(stderr, "wx", 0o600)];
  const startedAt = new Date().toISOString();
  try {
    const result = spawnSync(resolveExecutable(codexCommand[0]), [
      ...codexCommand.slice(1), "sandbox",
      "-c", `default_permissions="${profile}"`,
      "-c", `permissions.${profile}.extends=":read-only"`,
      "-c", `permissions.${profile}.filesystem={${Object.entries(filesystem).map(([key, value]) => `${JSON.stringify(key)}=${JSON.stringify(value)}`).join(",")}}`,
      "-c", `permissions.${profile}.network.enabled=${Boolean(network)}`,
      "--", resolveExecutable(command.argv[0], cwd), ...command.argv.slice(1)
    ], {
      cwd, env: { ...process.env, TMPDIR: scratch }, detached: true,
      timeout: command.timeoutSeconds * 1000, killSignal: "SIGKILL", stdio: ["ignore", ...descriptors]
    });
    if (result.pid) {
      let reused = false;
      try { process.kill(result.pid, 0); reused = true; } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
      if (reused) throw new Error("Cannot establish check process-group identity; preserve the checkout for diagnosis.");
      signalProcessGroup(result.pid, "SIGKILL");
    }
    const tail = (file) => {
      const size = fs.statSync(file).size;
      const fd = fs.openSync(file, "r");
      try {
        const buffer = Buffer.alloc(Math.min(size, 32 * 1024));
        fs.readSync(fd, buffer, 0, buffer.length, Math.max(0, size - buffer.length));
        return { text: buffer.toString("utf8"), truncated: size > buffer.length };
      } finally { fs.closeSync(fd); }
    };
    return {
      argv: command.argv, cwd, startedAt, finishedAt: new Date().toISOString(),
      timeoutSeconds: command.timeoutSeconds, exitCode: result.status,
      signal: result.signal, error: result.error?.message ?? null,
      passed: !result.error && result.status === 0,
      sandbox: { writable, network }, stdout: tail(stdout), stderr: tail(stderr)
    };
  } finally {
    descriptors.forEach((fd) => fs.closeSync(fd));
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
