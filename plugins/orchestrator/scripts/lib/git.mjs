import { execFileSync } from "node:child_process";

import { isGitRepository, resolveWorkspaceRoot } from "./workspace.mjs";

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 32 * 1024 * 1024
  });
}

export function headSha(cwd) {
  const root = resolveWorkspaceRoot(cwd);
  if (!isGitRepository(root)) {
    return null;
  }
  try {
    return git(root, ["rev-parse", "HEAD"]).trim();
  } catch {
    // A repository with no commits yet has no HEAD. That is a valid starting state.
    return null;
  }
}

// Orchestrator's own bookkeeping is never Codex's work product. Without this,
// writing a ledger entry after a briefing shows up as an undeclared change.
const SELF_STATE = /^\.orchestrator\//;

/**
 * Files that differ from HEAD, including untracked ones. Renames are reported as
 * both paths so a moved file never looks like it vanished from scope.
 */
export function changedFiles(cwd) {
  const root = resolveWorkspaceRoot(cwd);
  if (!isGitRepository(root)) {
    return [];
  }

  // Deliberately not guarded: if `git status` fails, an empty change list would
  // silently turn a broken acceptance check into a clean verdict.
  const output = git(root, ["status", "--porcelain", "-z", "--untracked-files=all"]);
  const records = output.split("\0").filter(Boolean);
  const files = new Set();

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record.length < 4) {
      continue;
    }
    const status = record.slice(0, 2);
    const filePath = record.slice(3);
    if (status.includes("R") || status.includes("C")) {
      // Rename/copy entries are followed by the original path as its own record.
      const origin = records[index + 1];
      if (origin) {
        files.add(origin);
        index += 1;
      }
    }
    files.add(filePath);
  }

  return [...files].filter((filePath) => !SELF_STATE.test(filePath)).sort();
}

export function diffStat(cwd) {
  const root = resolveWorkspaceRoot(cwd);
  if (!isGitRepository(root)) {
    return "";
  }
  try {
    return git(root, ["diff", "--stat", "HEAD"]).trim();
  } catch {
    return "";
  }
}

export function currentBranch(cwd) {
  const root = resolveWorkspaceRoot(cwd);
  if (!isGitRepository(root)) {
    return null;
  }
  try {
    return git(root, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
  } catch {
    return null;
  }
}
