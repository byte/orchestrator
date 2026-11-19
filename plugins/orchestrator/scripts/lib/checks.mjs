import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { changedFiles, headSha, SUPERVISOR_GIT_ARGS } from "./git.mjs";
import { execGit, resolveExecutable, signalProcessGroup } from "./exec.mjs";
import { matchesScope } from "./glob.mjs";

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
  if (command.maxOutputBytes !== undefined && (!Number.isInteger(command.maxOutputBytes) || command.maxOutputBytes < 1024 || command.maxOutputBytes > 32 * 1024 * 1024)) {
    throw new Error("Command maxOutputBytes must be an integer between 1024 and 33554432.");
  }
  return { argv: [...command.argv], timeoutSeconds,
    ...(command.maxOutputBytes === undefined ? {} : { maxOutputBytes: command.maxOutputBytes }) };
}

export function normalizeSetup(setup) {
  if (setup === null) return null;
  if (!setup || !Array.isArray(setup.inputs) || !setup.inputs.length || setup.inputs.some((file) =>
    typeof file !== "string" || !file || path.isAbsolute(file) || file.split(/[\\/]/).some((part) => ["..", ".git"].includes(part)) || /[*?\[\]{}\0]/.test(file))) {
    throw new Error("Setup requires explicit repository-relative input files, including its script and dependency manifests/lockfiles.");
  }
  if (setup.network !== undefined && typeof setup.network !== "boolean") throw new Error("Setup network must be true or false.");
  return { ...normalizeCommand(setup), inputs: [...new Set(setup.inputs)].sort(), network: setup.network ?? false };
}

/** HEAD plus dirty source contents, never worker prose, staging state, or just path names. */
/**
 * HEAD plus dirty source contents, never worker prose, staging state, or just
 * path names. With `contents: false` it hashes each file's stat identity
 * (mode, size, mtime, inode) instead of reading it: a cheap first look whose
 * match means "unchanged" in practice, while a mismatch needs the full hash.
 */
export function checkoutFingerprint(cwd, { gitDir = null, scope = null, files = null, contents = true, depth = 0 } = {}) {
  const hash = createHash("sha256");
  if (!files) hash.update(headSha(cwd, gitDir ? { gitDir } : {}) ?? "no-head");
  for (const file of files ?? changedFiles(cwd, { gitDir })) {
    if (scope && !scope(file)) continue;
    hash.update(JSON.stringify(file));
    hashPath(hash, path.join(cwd, file), { contents, depth });
  }
  return hash.digest("hex");
}

function hashPath(hash, target, { contents, depth }) {
  let stat;
  try { stat = fs.lstatSync(target); } catch (error) {
    if (error.code !== "ENOENT") throw error;
    hash.update("deleted");
    return;
  }
  hash.update(String(stat.mode));
  hash.update(`:${stat.size}:`);
  if (stat.isSymbolicLink()) {
    hash.update(fs.readlinkSync(target));
    return;
  }
  if (stat.isDirectory()) {
    // Git lists a submodule (or a nested repository) as one path. Hash its
    // own HEAD and dirty contents; an uninitialized one is an empty directory.
    hash.update(`dir:${nestedRepositoryFingerprint(target, { contents, depth })}`);
    return;
  }
  if (!stat.isFile()) {
    // A FIFO, socket, or device: never open it, only note that it is there.
    hash.update("special");
    return;
  }
  if (!contents) {
    hash.update(`:${stat.mtimeMs}:${stat.ino}`);
    return;
  }
  // O_NONBLOCK avoids blocking on a FIFO swapped in between lstat and open.
  // Never follow a worker-planted symlink while collecting evidence outside it.
  const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW);
  try {
    if (!fs.fstatSync(fd).isFile()) {
      hash.update("swapped");
      return;
    }
    const buffer = Buffer.alloc(64 * 1024);
    let bytes;
    while ((bytes = fs.readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, bytes));
  } finally { fs.closeSync(fd); }
}

function nestedRepositoryFingerprint(target, { contents, depth }) {
  if (!fs.existsSync(path.join(target, ".git"))) return "no-repository";
  // Bounded: a submodule of a submodule is hashed, a deeper chain only by name.
  if (depth >= 3) return "nested-too-deep";
  try {
    return checkoutFingerprint(target, { contents, depth: depth + 1 });
  } catch (error) {
    return `unreadable:${error.message}`;
  }
}

function reviewFiles(cwd, scope) {
  const files = execGit([...SUPERVISOR_GIT_ARGS, "ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd })
    .split("\0").filter((file) => file && !file.startsWith(".orchestrator/") && (!scope.length || matchesScope(file, scope)));
  return [...new Set(files)].sort();
}

/**
 * Identity of the declared review surface, including dirty and untracked
 * files. `contents: false` gives the cheap stat identity (see checkoutFingerprint).
 */
export function reviewFingerprint(cwd, scope = [], { contents = true } = {}) {
  return checkoutFingerprint(cwd, { files: reviewFiles(cwd, scope), contents });
}

/** Execute a trusted argv inside Codex's sandbox, without invoking a model. */
export function executeCheck(cwd, definition, { codexCommand = ["codex"], writable = false, network = false } = {}) {
  const command = normalizeCommand(definition);
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "orch-check-")));
  const profile = `orchestrator-check-${randomUUID().replaceAll("-", "")}`;
  const scratch = path.join(directory, "scratch");
  fs.mkdirSync(scratch, { mode: 0o700 });
  const filesystem = { [scratch]: "write", ...(writable ? { [fs.realpathSync(cwd)]: "write" } : {}) };
  const startedAt = new Date().toISOString();
  const maxOutputBytes = command.maxOutputBytes ?? 8 * 1024 * 1024;
  const stdout = path.join(directory, "stdout"), stderr = path.join(directory, "stderr");
  const resultFile = path.join(directory, "result.json");
  let terminationUncertain = false;
  try {
    let result;
    try {
      const argv = [resolveExecutable(codexCommand[0]),
        ...codexCommand.slice(1), "sandbox",
        "-c", `default_permissions="${profile}"`,
        "-c", `permissions.${profile}.extends=":read-only"`,
        "-c", `permissions.${profile}.filesystem={${Object.entries(filesystem).map(([key, value]) => `${JSON.stringify(key)}=${JSON.stringify(value)}`).join(",")}}`,
        "-c", `permissions.${profile}.network.enabled=${Boolean(network)}`,
        "--", resolveExecutable(command.argv[0], cwd), ...command.argv.slice(1)
      ];
      const specFile = path.join(directory, "command.json");
      fs.writeFileSync(specFile, JSON.stringify({ argv, stdout, stderr, result: resultFile, maxOutputBytes }), { mode: 0o600 });
      result = spawnSync(process.execPath, [fileURLToPath(new URL("../check-child.mjs", import.meta.url)), specFile], {
        cwd, env: { ...process.env, TMPDIR: scratch }, detached: true,
        timeout: command.timeoutSeconds * 1000,
        killSignal: "SIGKILL", stdio: "ignore"
      });
      if (!result.error) {
        const captured = JSON.parse(fs.readFileSync(resultFile, "utf8"));
        result = { ...result, ...captured, error: captured.error ? new Error(captured.error) : null };
      }
    } catch (error) { result = { ...result, status: null, signal: null, error }; }
    if (result.pid) {
      try {
        let reused = false;
        try { process.kill(result.pid, 0); reused = true; } catch (error) {
          if (error.code !== "ESRCH") throw error;
        }
        if (reused) throw new Error("Cannot establish check process-group identity; preserve the checkout for diagnosis.");
        signalProcessGroup(result.pid, "SIGKILL");
      } catch (error) {
        terminationUncertain = true;
        result.error = error;
      }
    }
    const tail = (file, truncated) => {
      let text = "";
      try { text = fs.readFileSync(file, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
      return { text, truncated: Boolean(truncated || text.includes("[orchestrator: output truncated]")) };
    };
    return {
      argv: command.argv, cwd, startedAt, finishedAt: new Date().toISOString(),
      timeoutSeconds: command.timeoutSeconds, maxOutputBytes, exitCode: result.status,
      signal: result.signal, error: result.error?.message ?? null,
      passed: !result.error && result.status === 0,
      ...(terminationUncertain ? { terminationUncertain: true, processGroup: result.pid, captureDirectory: directory } : {}),
      sandbox: { writable, network }, stdout: tail(stdout, result.stdoutTruncated), stderr: tail(stderr, result.stderrTruncated)
    };
  } finally {
    if (!terminationUncertain) fs.rmSync(directory, { recursive: true, force: true });
  }
}
