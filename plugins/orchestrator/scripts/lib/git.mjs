import { execFileSync } from "node:child_process";

import { isGitRepository, resolveWorkspaceRoot } from "./workspace.mjs";

function git(cwd, args, gitDir = null) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 32 * 1024 * 1024,
    ...(gitDir ? { env: worktreeGitEnv(cwd, gitDir) } : {})
  });
}

/**
 * The environment for git in a worker's worktree. A worker can rewrite the
 * worktree's `.git` pointer file to aim git at a repository config it wrote
 * (`core.fsmonitor`, say), which would run its code outside the sandbox the
 * next time the supervisor ran git there. With the git directory recorded at
 * creation, the pointer file is never read.
 */
const emptyTrees = new Map();

/** The empty tree of the repository's hash format, so attributes can be read from it. */
function emptyTree(gitDir) {
  if (!emptyTrees.has(gitDir)) {
    const version = execFileSync("git", ["version"], { encoding: "utf8" }).match(/(\d+)\.(\d+)/);
    if (!version || Number(version[1]) < 2 || (Number(version[1]) === 2 && Number(version[2]) < 42)) {
      throw new Error("Git 2.42 or later is required to run git safely in a worker's worktree (GIT_ATTR_SOURCE).");
    }
    emptyTrees.set(gitDir, execFileSync("git", ["hash-object", "-t", "tree", "/dev/null"], {
      encoding: "utf8",
      env: { ...process.env, GIT_DIR: gitDir }
    }).trim());
  }
  return emptyTrees.get(gitDir);
}

export function worktreeGitEnv(worktreePath, gitDir) {
  // A worker can also plant a nested repository with its own config: git would
  // run `git status` inside it for a committed gitlink, and that config's
  // fsmonitor with it. So nothing recurses into submodules, and no fsmonitor or
  // hook runs. Passed as GIT_CONFIG_* so every git command gets them.
  // Attributes come from the empty tree, not from the worktree's .gitattributes,
  // so no clean, smudge or process filter a worker attributed (to a script it
  // can edit) runs either; a global attributes file is ignored too.
  const config = [
    ["core.attributesFile", "/dev/null"],
    ["core.fsmonitor", "false"],
    ["core.hooksPath", "/dev/null"],
    ["diff.ignoreSubmodules", "all"],
    ["submodule.recurse", "false"],
    ["status.submoduleSummary", "false"],
    ["commit.gpgsign", "false"]
  ];
  const env = {
    ...process.env,
    GIT_DIR: gitDir,
    GIT_WORK_TREE: worktreePath,
    GIT_ATTR_SOURCE: emptyTree(gitDir),
    GIT_CONFIG_COUNT: String(config.length)
  };
  config.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  return env;
}

/** `headSha` and `changedFiles` take `{ gitDir }` for a worker's worktree; see worktreeGitEnv. */
export function headSha(cwd, { gitDir = null } = {}) {
  if (gitDir) {
    try {
      return git(cwd, ["rev-parse", "HEAD"], gitDir).trim();
    } catch {
      return null;
    }
  }
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
// writing a ledger entry during a run shows up as a dirty supervisor checkout.
const SELF_STATE = /^\.orchestrator\//;

/**
 * Files that differ from HEAD, including untracked ones. Renames are reported as
 * both paths so a moved file never looks like it vanished from scope.
 */
export function changedFiles(cwd, { gitDir = null } = {}) {
  const root = gitDir ? cwd : resolveWorkspaceRoot(cwd);
  if (!gitDir && !isGitRepository(root)) {
    return [];
  }

  // Deliberately not guarded: if `git status` fails, an empty change list would
  // silently turn a broken acceptance check into a clean verdict.
  const output = git(
    root,
    ["status", "--porcelain", "-z", "--untracked-files=all", ...(gitDir ? ["--ignore-submodules=all"] : [])],
    gitDir
  );
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
