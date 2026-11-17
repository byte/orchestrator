import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** Resolve before changing into a worker tree; relative PATH entries are not trusted. */
export function resolveExecutable(command, cwd = process.cwd()) {
  if (path.isAbsolute(command) || command.includes(path.sep)) {
    return path.resolve(cwd, command);
  }
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!path.isAbsolute(directory)) continue;
    const candidate = path.join(directory, command);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      // The absolute PATH entry is what is trusted; keep the name it was found
      // under. Multi-call shims (Volta, say) pick the tool from argv[0], so
      // following the symlink to the shim itself would break them.
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // Continue to the next absolute PATH entry.
    }
  }
  throw new Error(`Executable "${command}" was not found in absolute PATH entries.`);
}

/** Process-group states from `ps`, retried once: under load it can be slow. */
function groupStates(pgid) {
  let lastError;
  for (const timeout of [5000, 15000]) {
    try {
      return execFileSync("/bin/ps", ["-axo", "pgid=,stat="], {
        encoding: "utf8", timeout, killSignal: "SIGKILL",
        stdio: ["ignore", "pipe", "ignore"]
      }).trim().split("\n").map((line) => line.trim().split(/\s+/))
        .filter(([group]) => Number(group) === pgid).map(([, state]) => state ?? "");
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`could not inspect process group ${pgid}: ${lastError.message}`);
}

/**
 * Signal a whole process group. Returns false when there is nothing left to
 * signal: the group is gone, or (Darwin returns EPERM for this) it holds only
 * unreaped zombies, which cannot mutate anything. A signal refused to any live
 * member throws: the caller still owes that group's termination.
 */
export function signalProcessGroup(pgid, signal) {
  try {
    process.kill(-pgid, signal);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    if (error.code === "EPERM" && process.platform === "darwin" &&
        groupStates(pgid).every((state) => state.startsWith("Z"))) {
      return false;
    }
    throw error;
  }
}

let gitExecutable;

/** Bounded Git with file-backed output: descendants cannot keep a capture pipe open. */
// A backstop for a Git that hangs, not a performance limit: it also bounds
// mutating commands (worktree add, add -A, commit, cherry-pick), and killing
// one of those mid-way leaves a checkout for manual repair.
const GIT_TIMEOUT_MS = 10 * 60 * 1000;

export function execGit(args, { cwd, env = process.env, timeout = GIT_TIMEOUT_MS, detached = true } = {}) {
  gitExecutable ??= resolveExecutable("git");
  // TMPDIR may point inside the inspected checkout. Capture files must never
  // become part of Git's own dirt report (macOS/Linux both provide /tmp).
  const capture = fs.mkdtempSync("/tmp/orch-git-");
  const stdoutPath = path.join(capture, "stdout");
  const stderrPath = path.join(capture, "stderr");
  const descriptors = [];
  try {
    descriptors.push(fs.openSync(stdoutPath, "wx", 0o600));
    descriptors.push(fs.openSync(stderrPath, "wx", 0o600));
    const result = spawnSync(gitExecutable, args, {
      cwd, env, detached, timeout, killSignal: "SIGKILL",
      stdio: ["ignore", ...descriptors]
    });
    if (detached && result.pid) {
      // spawnSync has reaped the leader. A still-live pid is a reused identity;
      // otherwise any remaining members of its group belong to this invocation.
      // Do this on every exit, not just timeout: a signalled launcher can leave
      // a stopped child that has not yet executed the mutating Git command.
      try {
        let reused = false;
        try { process.kill(result.pid, 0); reused = true; } catch (error) {
          if (error.code !== "ESRCH") throw error;
        }
        if (reused) throw new Error("Git process-group identity may have been reused");
        signalProcessGroup(result.pid, "SIGKILL");
      } catch (error) {
        throw Object.assign(new Error(`Cannot establish Git termination; preserve the checkout for manual recovery: ${error.message}`), {
          gitMayBeRunning: true, cause: error
        });
      }
    }
    if ([stdoutPath, stderrPath].some((file) => fs.statSync(file).size > 32 * 1024 * 1024)) {
      throw new Error("Git output exceeded the 32 MiB capture limit; operation failed.");
    }
    const stdout = fs.readFileSync(stdoutPath, "utf8");
    const stderr = fs.readFileSync(stderrPath, "utf8");
    if (result.error || result.status !== 0) {
      const message = result.error?.code === "ETIMEDOUT"
        ? `Git timed out after ${timeout} ms; inspection or operation failed. Preserve the checkout for repair.`
        : `Git ${args[0]} failed: ${stderr.trim() || result.error?.message || result.signal || result.status}`;
      throw Object.assign(new Error(message), {
        code: result.error?.code, status: result.status, signal: result.signal, stdout, stderr
      });
    }
    return stdout;
  } finally {
    for (const descriptor of descriptors) fs.closeSync(descriptor);
    fs.rmSync(capture, { recursive: true, force: true });
  }
}
