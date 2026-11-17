import path from "node:path";

import { execGit } from "./exec.mjs";

/**
 * Resolve the repository root for a working directory.
 * Falls back to the directory itself when git is unavailable or this is not a repo,
 * so orchestrator still works in a plain directory.
 */
export function resolveWorkspaceRoot(cwd = process.cwd()) {
  try {
    const top = execGit(["rev-parse", "--show-toplevel"], { cwd }).trim();
    return top ? path.resolve(top) : path.resolve(cwd);
  } catch {
    return path.resolve(cwd);
  }
}

export function isGitRepository(cwd = process.cwd()) {
  try {
    execGit(["rev-parse", "--git-dir"], { cwd });
    return true;
  } catch {
    return false;
  }
}
