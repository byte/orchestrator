import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

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

function fingerprint(root, filePath) {
  const absolute = path.join(root, filePath);
  try {
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) {
      return `symlink:${fs.readlinkSync(absolute)}`;
    }
    if (!stat.isFile()) {
      return `${stat.mode}:non-file`;
    }
    const digest = crypto.createHash("sha256").update(fs.readFileSync(absolute)).digest("hex");
    return `file:${stat.mode}:${digest}`;
  } catch (error) {
    if (error.code === "ENOENT") {
      return "missing";
    }
    throw error;
  }
}

function treeChangedFiles(cwd, before, after) {
  if (!before || !after || before === after) {
    return [];
  }
  const output = git(cwd, ["diff", "--name-status", "-z", before, after]);
  const records = output.split("\0").filter(Boolean);
  const files = new Set();
  for (let index = 0; index < records.length; index += 1) {
    const status = records[index];
    const first = records[index + 1];
    if (!first) {
      break;
    }
    files.add(first);
    index += 1;
    if (/^[RC]/.test(status)) {
      const second = records[index + 1];
      if (second) {
        files.add(second);
        index += 1;
      }
    }
  }
  return [...files].filter((filePath) => !SELF_STATE.test(filePath));
}

export function captureGitSnapshot(cwd) {
  const root = resolveWorkspaceRoot(cwd);
  const dirtyFiles = changedFiles(root);
  return {
    head: headSha(root),
    branch: currentBranch(root),
    dirtyFiles,
    fingerprints: Object.fromEntries(
      dirtyFiles.map((filePath) => [filePath, fingerprint(root, filePath)])
    )
  };
}

export function changesSinceSnapshot(cwd, snapshot) {
  const root = resolveWorkspaceRoot(cwd);
  const currentHead = headSha(root);
  const currentBranchName = currentBranch(root);
  const currentDirty = changedFiles(root);
  const beforeDirty = new Set(snapshot?.dirtyFiles ?? snapshot?.changedFiles ?? []);
  const beforeFingerprints = snapshot?.fingerprints ?? {};
  const committed = treeChangedFiles(root, snapshot?.head, currentHead);
  const committedSet = new Set(committed);
  const candidates = new Set([...beforeDirty, ...currentDirty, ...committed]);
  const changed = [];
  const preexisting = [];

  for (const filePath of candidates) {
    if (committedSet.has(filePath)) {
      changed.push(filePath);
      continue;
    }
    if (beforeDirty.has(filePath)) {
      const before = beforeFingerprints[filePath];
      if (before === undefined || before === fingerprint(root, filePath)) {
        preexisting.push(filePath);
      } else {
        changed.push(filePath);
      }
      continue;
    }
    changed.push(filePath);
  }

  return {
    changed: [...new Set(changed)].sort(),
    preexisting: [...new Set(preexisting)].sort(),
    committed: committed.sort(),
    currentHead,
    currentBranch: currentBranchName,
    headChanged: snapshot?.head !== currentHead,
    branchChanged: snapshot?.branch !== currentBranchName
  };
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
