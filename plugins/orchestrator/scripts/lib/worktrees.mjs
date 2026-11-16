import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { parseFileList } from "./briefing.mjs";
import { changedFiles, currentBranch, headSha, worktreeGitEnv } from "./git.mjs";
import { partitionByScope } from "./glob.mjs";
import { effectiveTaskScope } from "./runs.mjs";
import { localDir } from "./state.mjs";

function git(cwd, args, gitDir = null) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 32 * 1024 * 1024,
    ...(gitDir ? { env: worktreeGitEnv(cwd, gitDir) } : {})
  }).trim();
}

/**
 * The git directory of a linked worktree, found from the supervisor
 * repository's own records (`<common>/worktrees/*\/gitdir`), which a worker
 * cannot write, never from the worktree's `.git` pointer file, which it can.
 */
export function worktreeGitDir(cwd, worktreePath) {
  const common = path.resolve(cwd, git(cwd, ["rev-parse", "--git-common-dir"]));
  const want = fs.realpathSync(worktreePath);
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
  return {
    path: source.path,
    ...(source.gitDir ? { gitDir: source.gitDir } : {}),
    branch: source.branch,
    baseHead: source.baseHead,
    createdAt: source.createdAt,
    reusedFromAttemptId: previousAttempt.id,
    // The head the earlier attempts left: commits up to here are theirs, commits
    // after it are this attempt's. Inspection carries declarations only for the former.
    reusedHead: headSha(source.path, { gitDir: source.gitDir }),
    reusedAt: new Date().toISOString()
  };
}

/**
 * Every file any commit in before..after changed, not only the net difference:
 * integration cherry-picks each commit, so a file changed and then restored is
 * still a change the supervisor branch receives. Renames count as both paths.
 */
function diffFiles(cwd, before, after, gitDir = null) {
  const output = git(cwd, ["log", "--no-renames", "--name-only", "--format=", "-z", `${before}..${after}`], gitDir);
  return [...new Set(output.split("\0").map((entry) => entry.trim()).filter(Boolean))].sort();
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
function carriedDeclarations(task, attempt, head) {
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
    for (const file of diffFiles(worktree.path, starts[position], ends[position], worktree.gitDir)) {
      lastChangedBy.set(file, earlier);
    }
  });
  const before = new Set(worktree.reusedHead === worktree.baseHead
    ? []
    : diffFiles(worktree.path, worktree.baseHead, worktree.reusedHead, worktree.gitDir));
  const own = new Set(head === worktree.reusedHead ? [] : diffFiles(worktree.path, worktree.reusedHead, head, worktree.gitDir));
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

export function inspectTaskWorktree(task, attempt) {
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
  const head = headSha(worktree.path, { gitDir: worktree.gitDir });
  const commits = head === worktree.baseHead
    ? []
    : git(worktree.path, ["rev-list", "--reverse", `${worktree.baseHead}..${head}`], worktree.gitDir)
        .split("\n")
        .filter(Boolean);
  const files = head === worktree.baseHead ? [] : diffFiles(worktree.path, worktree.baseHead, head, worktree.gitDir);
  const dirty = changedFiles(worktree.path, { gitDir: worktree.gitDir });
  // The planned scope plus what the supervisor granted this task through
  // `run answer`; anything else outside it is still refused.
  const scope = effectiveTaskScope(task);
  const { outOfScope } = scope.length
    ? partitionByScope([...new Set([...files, ...dirty])], scope)
    : { outOfScope: [] };
  const grantedScope = scope.filter((pattern) => !task.scope.includes(pattern));
  const declared = task.result?.structured?.files_touched ??
    parseFileList(task.result?.fields?.files_touched);
  // A warm retry reuses its predecessor's worktree, so the diff from baseHead
  // also holds the earlier attempts' commits. The worker reports only what this
  // attempt changed; files an earlier attempt in the same worktree declared count
  // as declared too, or a retry that fixed one file could never integrate.
  const carried = carriedDeclarations(task, attempt, head);
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

export function integrateTaskWorktree(cwd, run, task, attempt) {
  const inspection = inspectTaskWorktree(task, attempt);
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
  const supervisorHead = headSha(cwd);
  if (supervisorHead !== run.repository.integrationHead) {
    throw new WorktreeOperationError(
      `The supervisor branch advanced outside run "${run.id}"; expected ${run.repository.integrationHead}, found ${supervisorHead}.`,
      { reasonCode: "branch_drift", signals: ["branch_drift"] }
    );
  }
  try {
    git(cwd, ["cherry-pick", ...inspection.commits]);
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

export function cleanupTaskWorktree(cwd, attempt) {
  const worktree = attempt.worktree;
  if (!worktree?.path || !fs.existsSync(worktree.path)) {
    return false;
  }
  if (changedFiles(worktree.path, { gitDir: worktree.gitDir }).length) {
    throw new Error(`Refusing to remove dirty worktree ${worktree.path}.`);
  }
  fs.rmSync(worktree.path, { recursive: true, force: false });
  git(cwd, ["worktree", "prune"]);
  git(cwd, ["branch", "-D", worktree.branch]);
  return true;
}
