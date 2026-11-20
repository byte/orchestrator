import fs from "node:fs";
import path from "node:path";

import { execGit } from "./exec.mjs";
import { isGitRepository, resolveWorkspaceRoot } from "./workspace.mjs";

/**
 * Prepended to every git command the supervisor runs in its own checkout.
 * Integration brings worker-written files into that checkout, and a hook kept
 * in the tree (`core.hooksPath=.husky`) or an fsmonitor script would run them
 * outside any sandbox the next time git ran there.
 */
export const SUPERVISOR_GIT_ARGS = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"];

function git(cwd, args, gitDir = null) {
  return execGit(gitDir ? args : [...SUPERVISOR_GIT_ARGS, ...args], {
    cwd,
    env: { ...(gitDir ? worktreeGitEnv(cwd, gitDir) : process.env), GIT_OPTIONAL_LOCKS: "0" }
  });
}

/**
 * The environment for git in a worker's worktree. A worker can rewrite the
 * worktree's `.git` pointer file to aim git at a repository config it wrote
 * (`core.fsmonitor`, say), which would run its code outside the sandbox the
 * next time the supervisor ran git there. With the git directory recorded at
 * creation, the pointer file is never read.
 */
const filterDrivers = new Map();

/**
 * Every filter driver defined in git config. Attributes outside the worktree
 * (`.git/info/attributes`) still select drivers, and a driver may run a script
 * kept in the worktree, so each one is overridden: `cat` for clean and smudge
 * passes content through, and a `cat` process fails git's handshake, so git
 * continues unfiltered (`required` is turned off). An empty value would not
 * override an earlier one.
 */
function definedFilterDrivers(gitDir) {
  if (!filterDrivers.has(gitDir)) {
    filterDrivers.set(gitDir, configuredDrivers("filter", { env: { ...process.env, GIT_DIR: gitDir } }));
  }
  return filterDrivers.get(gitDir);
}

/** The names of every `<section>.<name>.*` driver in git config, read in `cwd` or with `env`. */
export function configuredDrivers(section, { cwd = undefined, env = process.env } = {}) {
  let output = "";
  try {
    output = execGit(["config", "--name-only", "--get-regexp", `^${section}\\.`], { cwd, env });
  } catch (error) {
    // Exit 1: none is configured.
    if (error.status !== 1) throw error;
  }
  const names = new Set();
  for (const key of output.split("\n").filter(Boolean)) {
    const match = key.slice(section.length + 1).match(/^(.+)\.[^.]+$/);
    if (match) {
      names.add(match[1]);
    }
  }
  return [...names];
}

export function worktreeGitEnv(worktreePath, gitDir) {
  // A worker can also plant a nested repository with its own config: git would
  // run `git status` inside it for a committed gitlink, and that config's
  // fsmonitor with it. So nothing recurses into submodules, and no fsmonitor or
  // hook runs. Passed as GIT_CONFIG_* so every git command gets them.
  // Attributes still apply, as they will when the commit is integrated (so a
  // `working-tree-encoding` file is staged the same way), but every configured
  // filter driver is overridden, so a filter a worker attributes to a file runs
  // nothing it wrote.
  const config = [
    ["core.fsmonitor", "false"],
    ["core.hooksPath", "/dev/null"],
    ["diff.ignoreSubmodules", "all"],
    ["submodule.recurse", "false"],
    ["status.submoduleSummary", "false"],
    ["commit.gpgsign", "false"],
    ...definedFilterDrivers(gitDir).flatMap((name) => [
      // An absolute path: a bare `cat` would be looked up on PATH, which may
      // hold a relative entry that finds one the worker wrote.
      [`filter.${name}.clean`, "/bin/cat"],
      [`filter.${name}.smudge`, "/bin/cat"],
      [`filter.${name}.process`, "/bin/cat"],
      [`filter.${name}.required`, "false"]
    ])
  ];
  const env = {
    ...process.env,
    GIT_DIR: gitDir,
    GIT_WORK_TREE: worktreePath,
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
export function changedFiles(cwd, { gitDir = null, ignoreSubmoduleDirt = false } = {}) {
  const root = gitDir ? cwd : resolveWorkspaceRoot(cwd);
  if (!gitDir && !isGitRepository(root)) {
    return [];
  }

  // Deliberately not guarded: if `git status` fails, an empty change list would
  // silently turn a broken acceptance check into a clean verdict.
  const output = git(
    root,
    ["status", "--porcelain", "-z", "--untracked-files=all",
      ...(gitDir ? ["--ignore-submodules=all"] : ignoreSubmoduleDirt ? ["--ignore-submodules=dirty"] : [])],
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

  if (gitDir) {
    // Submodules are ignored above (git would run a nested repository's own
    // config), so anything at a submodule's path counts as changed: what is
    // there is invisible from here (`git add -A` skips it too), and cleanup
    // must not delete it unseen. A worker's worktree is created with every
    // submodule directory empty, so whatever is in one is the worker's.
    for (const gitlink of gitlinks(root, { gitDir }).keys()) {
      try {
        const target = path.join(root, gitlink);
        if (!fs.lstatSync(target).isDirectory() || fs.readdirSync(target).length > 0) files.add(gitlink);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  }

  // Only the supervisor checkout's own bookkeeping is excluded. In a worker's
  // worktree (gitDir given) every change counts: an uncommitted edit to a
  // tracked .orchestrator/ledger.md there is work that cleanup must not delete.
  return [...files].filter((filePath) => gitDir || !SELF_STATE.test(filePath)).sort();
}

export function gitlinks(cwd, { gitDir = null } = {}) {
  const links = new Map();
  let output;
  try {
    output = git(cwd, ["ls-files", "--stage", "-z"], gitDir);
  } catch (error) {
    if (!gitDir && !isGitRepository(cwd)) return links;
    throw error;
  }
  for (const entry of output.split("\0")) {
    const tab = entry.indexOf("\t");
    if (tab < 0 || !entry.startsWith("160000 ")) continue;
    const file = entry.slice(tab + 1);
    links.set(file, (links.get(file) ?? "") + entry.slice(0, tab));
  }
  return links;
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
