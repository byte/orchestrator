import { execFileSync } from "node:child_process";
import path from "node:path";

/**
 * Resolve the repository root for a working directory.
 * Falls back to the directory itself when git is unavailable or this is not a repo,
 * so orchestrator still works in a plain directory.
 */
export function resolveWorkspaceRoot(cwd = process.cwd()) {
  try {
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    return top ? path.resolve(top) : path.resolve(cwd);
  } catch {
    return path.resolve(cwd);
  }
}

export function isGitRepository(cwd = process.cwd()) {
  try {
    execFileSync("git", ["rev-parse", "--git-dir"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
    return true;
  } catch {
    return false;
  }
}
