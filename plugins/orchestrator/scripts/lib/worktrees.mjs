import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { parseFileList } from "./briefing.mjs";
import { changedFiles, currentBranch, headSha } from "./git.mjs";
import { partitionByScope } from "./glob.mjs";
import { localDir } from "./state.mjs";

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 32 * 1024 * 1024
  }).trim();
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

export function createTaskWorktree(cwd, run, task, attempt) {
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
  const target = worktreePath(cwd, run, task, attempt);
  const branch = branchName(run, task, attempt);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  git(cwd, ["worktree", "add", "-b", branch, target, baseHead]);
  return { path: target, branch, baseHead, createdAt: new Date().toISOString() };
}

function diffFiles(cwd, before, after) {
  const output = git(cwd, ["diff", "--name-only", "-z", before, after]);
  return output.split("\0").filter(Boolean).sort();
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
  const head = headSha(worktree.path);
  const commits = head === worktree.baseHead
    ? []
    : git(worktree.path, ["rev-list", "--reverse", `${worktree.baseHead}..${head}`])
        .split("\n")
        .filter(Boolean);
  const files = head === worktree.baseHead ? [] : diffFiles(worktree.path, worktree.baseHead, head);
  const dirty = changedFiles(worktree.path);
  const { outOfScope } = task.scope.length
    ? partitionByScope([...new Set([...files, ...dirty])], task.scope)
    : { outOfScope: [] };
  const declared = task.result?.structured?.files_touched ??
    parseFileList(task.result?.fields?.files_touched);
  const fileSet = new Set(files);
  const declaredSet = new Set(declared);
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
    declared,
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
  if (changedFiles(worktree.path).length) {
    throw new Error(`Refusing to remove dirty worktree ${worktree.path}.`);
  }
  fs.rmSync(worktree.path, { recursive: true, force: false });
  git(cwd, ["worktree", "prune"]);
  git(cwd, ["branch", "-D", worktree.branch]);
  return true;
}
