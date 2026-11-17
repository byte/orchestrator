import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { parseFileList } from "./briefing.mjs";
import { SUPERVISOR_GIT_ARGS, changedFiles, configuredDrivers, currentBranch, headSha, worktreeGitEnv } from "./git.mjs";
import { partitionByScope } from "./glob.mjs";
import { effectiveTaskScope } from "./runs.mjs";
import { localDir } from "./state.mjs";

const RESERVED = /^\.orchestrator\/local(\/|$)/;

function gitRaw(cwd, args, gitDir = null) {
  return execFileSync("git", gitDir ? args : [...SUPERVISOR_GIT_ARGS, ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 32 * 1024 * 1024,
    ...(gitDir ? { env: worktreeGitEnv(cwd, gitDir) } : {})
  });
}

function git(cwd, args, gitDir = null) {
  return gitRaw(cwd, args, gitDir).trim();
}

/**
 * The git directory of a linked worktree, found from the supervisor
 * repository's own records (`<common>/worktrees/*\/gitdir`), which a worker
 * cannot write, never from the worktree's `.git` pointer file, which it can.
 */
export function worktreeGitDir(cwd, worktreePath) {
  const common = path.resolve(cwd, git(cwd, ["rev-parse", "--git-common-dir"]));
  const want = fs.realpathSync(worktreePath);
  if (want === fs.realpathSync(git(cwd, ["rev-parse", "--show-toplevel"]))) {
    return common;
  }
  const root = path.join(common, "worktrees");
  for (const name of fs.readdirSync(root)) {
    try {
      const pointer = fs.readFileSync(path.join(root, name, "gitdir"), "utf8").trim();
      if (fs.realpathSync(path.dirname(pointer)) === want) {
        return path.join(root, name);
      }
    } catch {
      // A stale or unreadable entry is not this worktree.
    }
  }
  throw new Error(`No git directory is registered for worktree ${worktreePath}.`);
}

/**
 * The git directory to use for a worktree record. Records made before the git
 * directory was recorded resolve it from the supervisor repository; without the
 * supervisor checkout to resolve it from, nothing runs git there.
 */
function trustedGitDir(worktree, cwd) {
  if (worktree.gitDir) {
    return worktree.gitDir;
  }
  if (cwd) {
    return worktreeGitDir(cwd, worktree.path);
  }
  throw new WorktreeOperationError(
    `Worktree ${worktree.path} has no recorded git directory; inspect it through \`run inspect\`.`,
    { reasonCode: "worktree_unavailable", kind: "failed", signals: ["worktree_unavailable"] }
  );
}

export class WorktreeOperationError extends Error {
  constructor(message, { reasonCode, kind = "refused", signals = [], details = {} } = {}) {
    super(message);
    this.name = "WorktreeOperationError";
    this.reasonCode = reasonCode;
    this.kind = kind;
    this.signals = signals;
    this.details = details;
  }
}

function worktreePath(cwd, run, task, attempt) {
  return path.join(localDir(cwd), "worktrees", run.id, `${task.id}-${attempt.id}`);
}

function branchName(run, task, attempt) {
  return `orchestrator/${run.id}/${task.id}/${attempt.id}`;
}

function assertLaunchable(cwd, run) {
  if (!run.repository?.baseHead) {
    throw new WorktreeOperationError(
      "Worker isolation requires a repository with at least one commit.",
      { reasonCode: "worker_launch_failed", kind: "failed", signals: ["worker_launch_error"] }
    );
  }
  if (currentBranch(cwd) !== run.repository.branch) {
    throw new WorktreeOperationError(
      `Run "${run.id}" belongs to branch ${run.repository.branch}; current branch is ${currentBranch(cwd)}.`,
      { reasonCode: "wrong_branch", kind: "failed", signals: ["wrong_branch"] }
    );
  }
  const dirt = changedFiles(cwd);
  if (dirt.length) {
    throw new WorktreeOperationError(
      `The main checkout must be clean before launching isolated workers: ${dirt.join(", ")}.`,
      { reasonCode: "dirty_checkout", kind: "failed", signals: ["dirty_checkout"] }
    );
  }
  const baseHead = headSha(cwd);
  if (baseHead !== run.repository.integrationHead) {
    throw new WorktreeOperationError(
      `The supervisor branch advanced outside run "${run.id}"; expected ${run.repository.integrationHead}, found ${baseHead}.`,
      { reasonCode: "branch_drift", kind: "failed", signals: ["branch_drift"] }
    );
  }
  return baseHead;
}

export function createTaskWorktree(cwd, run, task, attempt) {
  const baseHead = assertLaunchable(cwd, run);
  const target = worktreePath(cwd, run, task, attempt);
  const branch = branchName(run, task, attempt);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  git(cwd, ["worktree", "add", "-b", branch, target, baseHead]);
  return { path: target, gitDir: worktreeGitDir(cwd, target), branch, baseHead, createdAt: new Date().toISOString() };
}

/**
 * A warm retry continues in the previous attempt's worktree, keeping its branch,
 * its original base, its commits, and any uncommitted changes, so inspection and
 * integration see the whole of the task's work. The same launch preconditions as
 * a new worktree apply to the supervisor checkout.
 */
export function reuseTaskWorktree(cwd, run, previousAttempt) {
  assertLaunchable(cwd, run);
  const source = previousAttempt?.worktree;
  if (!source?.path || !fs.existsSync(source.path)) {
    throw new WorktreeOperationError(
      `Worktree of attempt "${previousAttempt?.id}" is gone; retry with --fresh.`,
      { reasonCode: "worktree_unavailable", kind: "failed", signals: ["worktree_unavailable"] }
    );
  }
  const gitDir = trustedGitDir(source, cwd);
  return {
    path: source.path,
    gitDir,
    branch: source.branch,
    baseHead: source.baseHead,
    createdAt: source.createdAt,
    reusedFromAttemptId: previousAttempt.id,
    // The head the earlier attempts left: commits up to here are theirs, commits
    // after it are this attempt's. Inspection carries declarations only for the former.
    reusedHead: headSha(source.path, { gitDir }),
    reusedAt: new Date().toISOString()
  };
}

/**
 * Every file any commit in before..after changed, not only the net difference:
 * integration cherry-picks each commit, so a file changed and then restored is
 * still a change the supervisor branch receives. Renames count as both paths.
 */
function diffFiles(cwd, before, after, gitDir = null) {
  // Per commit with diff-tree -z, so every name is exactly as git stores it: a
  // trailing space or a leading newline in a filename is part of the name.
  const commits = git(cwd, ["rev-list", `${before}..${after}`], gitDir).split("\n").filter(Boolean);
  const files = new Set();
  for (const commit of commits) {
    const output = gitRaw(cwd, ["diff-tree", "--root", "--no-commit-id", "-r", "-m", "--no-renames", "--name-only", "-z", commit], gitDir);
    for (const name of output.split("\0")) {
      if (name !== "") {
        files.add(name);
      }
    }
  }
  return [...files].sort();
}

/**
 * Files earlier attempts in this reused worktree changed and declared before
 * this attempt began, and that this attempt did not change again. Each file is
 * credited to the last earlier attempt whose own commits changed it, and only
 * that attempt's declaration counts: a later undeclared change is never covered
 * by an older declaration, and a file an attempt only claimed (a phantom) is
 * never carried. Anything this attempt committed must be in its own report. A
 * worktree saved before its reuse heads were recorded carries nothing.
 */
function carriedDeclarations(task, attempt, head, gitDir) {
  const worktree = attempt.worktree;
  const index = task.attempts?.findIndex((entry) => entry.id === attempt.id) ?? -1;
  if (index <= 0 || !worktree.reusedHead) {
    return [];
  }
  const chain = task.attempts.slice(0, index).filter((earlier) => earlier.worktree?.path === worktree.path);
  // Each earlier attempt's commits run from where it began (its reuse head, or
  // the worktree's base for the attempt that created it) to where the next began.
  const starts = chain.map((earlier, position) =>
    position === 0 ? earlier.worktree.reusedHead ?? earlier.worktree.baseHead : earlier.worktree.reusedHead);
  if (!chain.length || starts.some((start) => !start)) {
    return [];
  }
  const ends = [...starts.slice(1), worktree.reusedHead];
  const lastChangedBy = new Map();
  chain.forEach((earlier, position) => {
    if (starts[position] === ends[position]) {
      return;
    }
    for (const file of diffFiles(worktree.path, starts[position], ends[position], gitDir)) {
      lastChangedBy.set(file, earlier);
    }
  });
  const before = new Set(worktree.reusedHead === worktree.baseHead
    ? []
    : diffFiles(worktree.path, worktree.baseHead, worktree.reusedHead, gitDir));
  const own = new Set(head === worktree.reusedHead ? [] : diffFiles(worktree.path, worktree.reusedHead, head, gitDir));
  const declaredBy = (earlier) => new Set(
    earlier.review?.result?.structured?.files_touched ??
      parseFileList(earlier.review?.result?.fields?.files_touched) ??
      []
  );
  return [...lastChangedBy]
    .filter(([file, earlier]) => before.has(file) && !own.has(file) && declaredBy(earlier).has(file))
    .map(([file]) => file)
    .sort();
}

export function inspectTaskWorktree(task, attempt, { cwd = null } = {}) {
  const worktree = attempt.worktree;
  if (!worktree?.path || !fs.existsSync(worktree.path)) {
    throw new WorktreeOperationError(
      `Worktree for attempt "${attempt.id}" is unavailable.`,
      {
        reasonCode: "worktree_unavailable",
        kind: "failed",
        signals: ["worktree_unavailable"]
      }
    );
  }
  const gitDir = trustedGitDir(worktree, cwd);
  const head = headSha(worktree.path, { gitDir });
  const commits = head === worktree.baseHead
    ? []
    : git(worktree.path, ["rev-list", "--reverse", `${worktree.baseHead}..${head}`], gitDir)
        .split("\n")
        .filter(Boolean);
  const files = head === worktree.baseHead ? [] : diffFiles(worktree.path, worktree.baseHead, head, gitDir);
  const dirty = changedFiles(worktree.path, { gitDir });
  // The planned scope plus what the supervisor granted this task through
  // `run answer`; anything else outside it is still refused.
  const scope = effectiveTaskScope(task);
  const changed = [...new Set([...files, ...dirty])];
  const { outOfScope: outsideScope } = scope.length
    ? partitionByScope(changed, scope)
    : { outOfScope: [] };
  // The orchestrator's own local state is never a worker's to change, whatever
  // the scope says: integration would write it under a running CLI.
  const outOfScope = [...new Set([...outsideScope, ...changed.filter((file) => RESERVED.test(file))])].sort();
  const grantedScope = scope.filter((pattern) => !task.scope.includes(pattern));
  const declared = task.result?.structured?.files_touched ??
    parseFileList(task.result?.fields?.files_touched);
  // A warm retry reuses its predecessor's worktree, so the diff from baseHead
  // also holds the earlier attempts' commits. The worker reports only what this
  // attempt changed; files an earlier attempt in the same worktree declared count
  // as declared too, or a retry that fixed one file could never integrate.
  const carried = carriedDeclarations(task, attempt, head, gitDir);
  const fileSet = new Set(files);
  const declaredSet = new Set([...declared, ...carried]);
  return {
    path: worktree.path,
    branch: worktree.branch,
    baseHead: worktree.baseHead,
    head,
    clean: dirty.length === 0,
    dirty,
    commits,
    files,
    outOfScope,
    scope,
    grantedScope,
    declared,
    carried,
    undeclared: files.filter((file) => !declaredSet.has(file)),
    phantom: declared.filter((file) => !fileSet.has(file)),
    ready:
      dirty.length === 0 &&
      commits.length > 0 &&
      outOfScope.length === 0 &&
      files.every((file) => declaredSet.has(file)) &&
      declared.every((file) => fileSet.has(file))
  };
}

/**
 * Paths in the main checkout the cherry-pick could replace without git
 * stopping it: git treats ignored files as expendable, so an ignored file at a
 * path a worker adds, or at one of its parent directories, would be lost. Every
 * declared path and each of its parents that exists on disk as anything but a
 * directory must be tracked, and no declared path may be a directory.
 */
function untrackedInTheWay(cwd, files) {
  const candidates = new Set();
  const blocked = [];
  for (const file of files) {
    const parts = file.split("/");
    for (let depth = 1; depth <= parts.length; depth += 1) {
      const relative = parts.slice(0, depth).join("/");
      let stat;
      try {
        stat = fs.lstatSync(path.join(cwd, relative));
      } catch {
        break;
      }
      if (!stat.isDirectory()) {
        candidates.add(relative);
        break;
      }
      if (depth === parts.length) {
        blocked.push(relative);
      }
    }
  }
  if (candidates.size) {
    const tracked = new Set(gitRaw(cwd, ["ls-files", "-z", "--", ...[...candidates].map((entry) => `:(literal)${entry}`)])
      .split("\0").filter((entry) => entry.length));
    blocked.push(...[...candidates].filter((entry) => !tracked.has(entry)));
  }
  return blocked.sort();
}

export function integrateTaskWorktree(cwd, run, task, attempt) {
  const inspection = inspectTaskWorktree(task, attempt, { cwd });
  if (!inspection.ready) {
    const scopeViolation = inspection.outOfScope.length > 0;
    const dirty = !inspection.clean;
    throw new WorktreeOperationError(
      `Worktree for task "${task.id}" did not pass integration inspection.`,
      {
        reasonCode: scopeViolation
          ? "scope_violation"
          : dirty
            ? "dirty_checkout"
            : "integration_inspection_failed",
        signals: [
          "integration_inspection_failed",
          ...(scopeViolation ? ["scope_violation"] : []),
          ...(dirty ? ["dirty_checkout"] : [])
        ],
        details: inspection
      }
    );
  }
  if (currentBranch(cwd) !== run.repository.branch) {
    throw new WorktreeOperationError(
      `Cannot integrate on branch ${currentBranch(cwd)}; expected ${run.repository.branch}.`,
      { reasonCode: "wrong_branch", signals: ["wrong_branch"] }
    );
  }
  const dirt = changedFiles(cwd);
  if (dirt.length) {
    throw new WorktreeOperationError(
      `The main checkout must be clean before integration: ${dirt.join(", ")}.`,
      { reasonCode: "dirty_checkout", signals: ["dirty_checkout"] }
    );
  }
  const unprotected = untrackedInTheWay(cwd, inspection.files);
  if (unprotected.length) {
    throw new WorktreeOperationError(
      `Integration would overwrite untracked or ignored files in the main checkout: ${unprotected.join(", ")}.`,
      { reasonCode: "dirty_checkout", signals: ["dirty_checkout"] }
    );
  }
  const supervisorHead = headSha(cwd);
  if (supervisorHead !== run.repository.integrationHead) {
    throw new WorktreeOperationError(
      `The supervisor branch advanced outside run "${run.id}"; expected ${run.repository.integrationHead}, found ${supervisorHead}.`,
      { reasonCode: "branch_drift", signals: ["branch_drift"] }
    );
  }
  try {
    // No hook or fsmonitor runs (SUPERVISOR_GIT_ARGS). Rename detection is off:
    // with it, a change to a file another task moved would follow the move and
    // land on a path outside this task's inspected scope. It conflicts instead.
    // Every configured merge driver is replaced by `false`, so a file it would
    // merge conflicts instead of running a driver script the worker may have
    // changed in an earlier commit.
    const noDrivers = configuredDrivers("merge", { cwd }).flatMap((name) => ["-c", `merge.${name}.driver=false`]);
    git(cwd, [...noDrivers, "cherry-pick", "--strategy-option=no-renames", ...inspection.commits]);
  } catch (error) {
    try {
      git(cwd, ["cherry-pick", "--abort"]);
    } catch {
      // Preserve the original cherry-pick error; the caller reports manual recovery.
    }
    throw new WorktreeOperationError(
      `Integration conflict for task "${task.id}": ${error.stderr || error.message}`,
      {
        reasonCode: "integration_conflict",
        kind: "failed",
        signals: ["integration_conflict"]
      }
    );
  }
  return {
    inspection,
    commits: inspection.commits,
    integrationHead: headSha(cwd)
  };
}

/**
 * The first half of removing a worktree, run under the run lock (see
 * takeWorktreesForRemoval): refuse one with uncommitted work, then move it
 * aside in one rename. From then on it is gone for a warm retry, so the slow
 * deletion (finishWorktreeRemoval) can run outside the lock. Ignored files
 * (a worker's build output, `node_modules`) are not work and go with it.
 */
export function detachTaskWorktree(cwd, attempt) {
  const worktree = attempt.worktree;
  if (!worktree?.path || !fs.existsSync(worktree.path)) {
    return null;
  }
  if (changedFiles(worktree.path, { gitDir: trustedGitDir(worktree, cwd) }).length) {
    const error = new Error(`Refusing to remove dirty worktree ${worktree.path}.`);
    error.code = "WORKTREE_DIRTY";
    throw error;
  }
  const trash = `${worktree.path}.removing-${process.pid}-${Date.now()}`;
  fs.renameSync(worktree.path, trash);
  return trash;
}

export function finishWorktreeRemoval(cwd, attempt, trash) {
  fs.rmSync(trash, { recursive: true, force: false });
  git(cwd, ["worktree", "prune"]);
  try {
    git(cwd, ["branch", "-D", attempt.worktree.branch]);
  } catch {
    // A branch shared by warm attempts is deleted once.
  }
}

/** Both halves at once, for a caller that holds no run lock to release in between. */
export function cleanupTaskWorktree(cwd, attempt) {
  const trash = detachTaskWorktree(cwd, attempt);
  if (!trash) {
    return false;
  }
  finishWorktreeRemoval(cwd, attempt, trash);
  return true;
}
