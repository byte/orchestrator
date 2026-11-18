import fs from "node:fs";
import path from "node:path";

import { parseFileList } from "./briefing.mjs";
import { checkoutFingerprint, executeCheck, normalizeSetup } from "./checks.mjs";
import { GIT_MUTATION_TIMEOUT_MS, execGit } from "./exec.mjs";
import { SUPERVISOR_GIT_ARGS, changedFiles, configuredDrivers, currentBranch, headSha, worktreeGitEnv } from "./git.mjs";
import { partitionByScope } from "./glob.mjs";
import { effectiveTaskScope } from "./runs.mjs";
import { localDir } from "./state.mjs";

// Case-insensitive: on a case-insensitive filesystem `.ORCHESTRATOR/LOCAL/`
// is the same directory.
const RESERVED = /^\.orchestrator\/local(\/|$)/i;

function gitRaw(cwd, args, gitDir = null, env = process.env, timeout = undefined) {
  return execGit(gitDir ? args : [...SUPERVISOR_GIT_ARGS, ...args], {
    cwd,
    env: gitDir ? worktreeGitEnv(cwd, gitDir) : env,
    timeout
  });
}

function git(cwd, args, gitDir = null, env = process.env, timeout = undefined) {
  return gitRaw(cwd, args, gitDir, env, timeout).trim();
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

/**
 * The supervisor-side preconditions of a write launch: a committed base, the
 * run's branch, a clean checkout, and no drift from the integration head. Exported
 * so a launch can check them before it claims the task and spends an attempt.
 */
export function assertLaunchable(cwd, run) {
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
      `The main checkout must be clean before launching a write worker: ${summarizeFiles(dirt)}. ` +
        "Commit or stash these changes first. Read and verify tasks run in the checkout as it is " +
        "and do not need it clean.",
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

function summarizeFiles(files, limit = 20) {
  return files.length > limit
    ? `${files.slice(0, limit).join(", ")}, and ${files.length - limit} more`
    : files.join(", ");
}

/**
 * Read and verify workers run in the supervisor checkout itself, as it is:
 * uncommitted and untracked files included, so they review what the user sees.
 * Their sandbox cannot write it. No worktree or branch is created, nothing needs
 * cleaning up, and the head and uncommitted files at launch are recorded as
 * evidence of what the worker saw.
 */
export function inPlaceCheckout(cwd, run) {
  if (!run.repository?.baseHead) {
    throw new WorktreeOperationError(
      "Worker launch requires a repository with at least one commit.",
      { reasonCode: "worker_launch_failed", kind: "failed", signals: ["worker_launch_error"] }
    );
  }
  const dirty = changedFiles(cwd);
  return {
    path: fs.realpathSync(cwd),
    inPlace: true,
    branch: currentBranch(cwd),
    baseHead: headSha(cwd),
    dirtyFiles: dirty.slice(0, 200),
    dirtyFileCount: dirty.length,
    createdAt: new Date().toISOString()
  };
}

/** Whether an attempt's recorded worktree is the supervisor checkout itself, never to be removed. */
function isSupervisorCheckout(cwd, worktree) {
  if (worktree?.inPlace) {
    return true;
  }
  if (!worktree?.path) {
    return false;
  }
  const real = (target) => {
    try {
      return fs.realpathSync(target);
    } catch {
      return path.resolve(target);
    }
  };
  return real(worktree.path) === real(cwd);
}

export function createTaskWorktree(cwd, run, task, attempt) {
  const baseHead = assertLaunchable(cwd, run);
  const target = worktreePath(cwd, run, task, attempt);
  const branch = branchName(run, task, attempt);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  git(cwd, ["worktree", "add", "-b", branch, target, baseHead], null, process.env, GIT_MUTATION_TIMEOUT_MS);
  return { path: target, gitDir: worktreeGitDir(cwd, target), branch, baseHead, createdAt: new Date().toISOString() };
}

export function createPreviewWorktree(cwd, run, target) {
  const baseHead = assertLaunchable(cwd, run);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  git(cwd, ["worktree", "add", "--detach", target, baseHead], null, process.env, GIT_MUTATION_TIMEOUT_MS);
  return { path: target, gitDir: worktreeGitDir(cwd, target), branch: "HEAD", baseHead, createdAt: new Date().toISOString() };
}

/** Setup runs only in an isolated, pristine tree, never over worker-modified scripts. */
export function prepareTaskWorktree(cwd, run, worktree, options = {}) {
  const definition = normalizeSetup(run.contract?.setup ?? null);
  if (!definition) return null;
  if (worktree.setup?.terminationUncertain) throw new Error("Previous setup process termination is uncertain; preserve this worktree and retry --fresh.");
  if (isSupervisorCheckout(cwd, worktree)) throw new Error("Setup cannot run in the supervisor checkout.");
  const gitDir = trustedGitDir(worktree, cwd);
  const fingerprint = checkoutFingerprint(worktree.path, { files: definition.inputs });
  if (worktree.setup?.passed && worktree.setup.fingerprint === fingerprint &&
      JSON.stringify(worktree.setup.definition) === JSON.stringify(definition)) return worktree.setup;
  if (headSha(worktree.path, { gitDir }) !== worktree.baseHead || changedFiles(worktree.path, { gitDir }).length) {
    throw new WorktreeOperationError("Setup inputs changed or setup needs rerunning over worker changes. Preserve this worktree and retry --fresh; setup never executes worker-modified scripts.", {
      kind: "failed", reasonCode: "setup_failed"
    });
  }
  const before = checkoutFingerprint(worktree.path, { gitDir });
  const execution = executeCheck(worktree.path, definition, { codexCommand: options.codexCommand, writable: true, network: definition.network });
  const unchanged = before === checkoutFingerprint(worktree.path, { gitDir });
  const receipt = { ...execution, definition, fingerprint, sourceUnchanged: unchanged, passed: execution.passed && unchanged };
  worktree.setup = receipt;
  if (!receipt.passed) {
    throw new WorktreeOperationError(`Worktree setup failed${unchanged ? "" : ": setup modified source instead of ignored dependencies"}. No model worker was started. Inspect the setup receipt and retry, or retry --fresh.`, {
      kind: "failed", reasonCode: "setup_failed", details: receipt
    });
  }
  return receipt;
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
    ...(source.setup ? { setup: source.setup } : {}),
    ...(source.setupPending ? { setupPending: source.setupPending } : {}),
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
 * Declared paths that land in `.orchestrator/local/` through an alias: the
 * filesystem, not the spelling, decides where a path goes, and on a
 * case-insensitive volume a case or Unicode variant (`.orcheſtrator`) is the
 * same directory.
 */
function reachesLocalState(cwd, files) {
  let local;
  try {
    local = fs.statSync(localDir(cwd));
  } catch {
    return [];
  }
  return files.filter((file) => {
    const parts = file.split("/");
    for (let depth = 1; depth < parts.length; depth += 1) {
      let stat;
      try {
        stat = fs.statSync(path.join(cwd, ...parts.slice(0, depth)));
      } catch {
        return false;
      }
      if (stat.dev === local.dev && stat.ino === local.ino) {
        return true;
      }
    }
    return false;
  }).sort();
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

export function gitOperationInProgress(cwd) {
  return ["sequencer", "CHERRY_PICK_HEAD", "MERGE_HEAD", "rebase-merge", "rebase-apply"]
    .some((entry) => fs.existsSync(path.resolve(cwd, git(cwd, ["rev-parse", "--git-path", entry]))));
}

export function integrateTaskWorktree(cwd, run, task, attempt, {
  operationId, beforeApply = () => {}, beforeStart = () => {}, afterStop = () => {}
} = {}) {
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
  if (gitOperationInProgress(cwd)) {
    throw new WorktreeOperationError("A Git operation is already in progress; preserve and finish or abort it before integration.", {
      reasonCode: "integration_inspection_failed", signals: ["integration_inspection_failed"]
    });
  }
  const dirt = changedFiles(cwd);
  if (dirt.length) {
    throw new WorktreeOperationError(
      `The main checkout must be clean before integration: ${dirt.join(", ")}.`,
      { reasonCode: "dirty_checkout", signals: ["dirty_checkout"] }
    );
  }
  const aliased = reachesLocalState(cwd, inspection.files);
  if (aliased.length) {
    throw new WorktreeOperationError(
      `Integration would write the orchestrator's local state through ${aliased.join(", ")}.`,
      { reasonCode: "scope_violation", signals: ["scope_violation"] }
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
  // Persist the inspected intent before Git can move the supervisor branch.
  // The caller holds the checkout and run locks through acceptance.
  beforeApply(inspection);
  const noDrivers = configuredDrivers("merge", { cwd }).flatMap((name) => ["-c", `merge.${name}.driver=false`]);
  beforeStart();
  let stopped = false;
  try {
    // No hook or fsmonitor runs (SUPERVISOR_GIT_ARGS). Rename detection is off:
    // with it, a change to a file another task moved would follow the move and
    // land on a path outside this task's inspected scope. It conflicts instead.
    // Every configured merge driver is replaced by `false`, so a file it would
    // merge conflicts instead of running a driver script the worker may have
    // changed in an earlier commit.
    git(cwd, ["-c", "core.logAllRefUpdates=true", ...noDrivers, "cherry-pick", "--strategy-option=no-renames", ...inspection.commits], null,
      operationId ? { ...process.env, GIT_REFLOG_ACTION: `orchestrator-integrate-${operationId}` } : process.env,
      GIT_MUTATION_TIMEOUT_MS);
    stopped = true;
  } catch (error) {
    // Do not abort or release ownership while the original Git group could
    // still mutate this checkout. Leave the durable phase at started.
    if (error.gitMayBeRunning) throw error;
    stopped = true;
    try {
      git(cwd, ["cherry-pick", "--abort"], null, process.env, GIT_MUTATION_TIMEOUT_MS);
    } catch (abortError) {
      if (abortError.gitMayBeRunning) stopped = false;
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
  } finally {
    if (stopped) afterStop();
  }
  return {
    inspection,
    commits: inspection.commits,
    integrationHead: headSha(cwd)
  };
}

/**
 * Reconcile only a complete integration made by this exact saved operation.
 * Equal patches or commit subjects are not receipts. A partial cherry-pick,
 * manual edits, missing reflog, or foreign commit needs manual recovery.
 */
export function recoverTaskIntegration(cwd, run, pending) {
  const refuse = () => {
    throw new Error(`Integration of task "${pending.taskId}" is interrupted; preserve the checkout and inspect Git state before manual recovery.`);
  };
  // Receipts prove what was applied, not that the original mutator has exited.
  // A process that died during Git cannot attest to that child's termination.
  // A record without a phase predates phases: its writer recorded nothing about
  // the Git child, so accept it on the receipts alone, as that build did, but
  // only once no Git process still holds this checkout's index.
  if (pending.phase === undefined) {
    if (fs.existsSync(path.resolve(cwd, git(cwd, ["rev-parse", "--git-path", "index.lock"])))) refuse();
  } else if (!["prepared", "stopped"].includes(pending.phase)) {
    refuse();
  }
  if (currentBranch(cwd) !== run.repository.branch || changedFiles(cwd).length) {
    refuse();
  }
  if (gitOperationInProgress(cwd)) refuse();
  const head = headSha(cwd);
  if (head === pending.priorHead) {
    return null;
  }
  const chain = git(cwd, ["rev-list", "--reverse", "--parents", `${pending.priorHead}..${head}`])
    .split("\n").filter(Boolean).map((line) => line.split(" "));
  const receipts = new Set(gitRaw(cwd, ["reflog", "show", "--format=%H%x09%gs",
    run.repository.branch === "HEAD" ? "HEAD" : `refs/heads/${run.repository.branch}`])
    .split("\n").filter((line) => line.includes(`\torchestrator-integrate-${pending.id}: `))
    .map((line) => line.split("\t")[0]));
  if (chain.length !== pending.inspection.commits.length || chain.some(([commit, ...parents], index) =>
    parents.length !== 1 || parents[0] !== (index === 0 ? pending.priorHead : chain[index - 1][0]) || !receipts.has(commit))) {
    refuse();
  }
  return { inspection: pending.inspection, commits: pending.inspection.commits, integrationHead: head };
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
  if (!worktree?.path || !fs.existsSync(worktree.path) || isSupervisorCheckout(cwd, worktree)) {
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
  if (isSupervisorCheckout(cwd, attempt.worktree)) {
    throw new Error(`Refusing to remove the supervisor checkout ${attempt.worktree.path}.`);
  }
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
