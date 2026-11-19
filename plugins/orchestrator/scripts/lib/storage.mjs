import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { loadRun, taskHistory } from "./runs.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";
import { worktreeGitDir } from "./worktrees.mjs";
import { worktreeGitEnv } from "./git.mjs";
import { SCRATCH_OWNER_FILE } from "./remove-tree.mjs";

const FINISHED = new Set(["completed", "failed", "blocked", "cancelled"]);
const RUN_STATUSES = new Set(["planning", "planned", "running", "blocked", "finalizing", "completed", "cancelled", "failed"]);
const EXECUTORS = new Set(["cli", "codex-plugin"]);
const KINDS = new Set(["artifacts", "worktree", "preview", "scratch"]);
const REASONS = new Set(["no_artifact_cleanup", "state_unavailable", "not_owned", "unavailable", "task_active", "worker_live", "process_uncertain", "pending_integration", "dirty", "git_unknown", "finished_clean", "finished_scratch"]);
const component = (value) => typeof value === "string" && /^[a-z0-9][a-z0-9._-]*$/.test(value) && value !== "." && value !== "..";
const within = (root, target) => target === root || target.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`);

// Reject symlinks in *every* component, not just the leaf. Called before any
// metadata read or directory walk. A missing/unreadable path is not evidence.
function realOwned(root, target) {
  if (!path.isAbsolute(target) || !within(root, target)) return false;
  try {
    return fs.realpathSync(target) === target;
  } catch {
    return false;
  }
}

function readMetadata(root, file, limit = 8 * 1024 * 1024) {
  if (!realOwned(root, file)) throw new Error("metadata unavailable");
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.size > limit) throw new Error("metadata unavailable");
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/** Stat only: never open prompts, transcripts, source files, or logs. */
function measure(root, target) {
  const size = { bytes: 0, files: 0, symlinks: 0, complete: true };
  if (!realOwned(root, target)) return { ...size, complete: false };
  const visit = (file) => {
    try {
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) { size.symlinks += 1; return; }
      if (stat.isDirectory()) {
        for (const name of fs.readdirSync(file)) visit(path.join(file, name));
      } else if (stat.isFile()) {
        size.bytes += stat.size;
        size.files += 1;
      } else size.complete = false;
    } catch { size.complete = false; }
  };
  visit(target);
  return size;
}

function alive(pid, group = false) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(group ? -pid : pid, 0); return true; }
  catch (error) { return error.code !== "ESRCH"; }
}

function uncertain(receipt) {
  return Boolean(receipt?.terminationUncertain &&
    (!Number.isInteger(receipt.processGroup) || receipt.processGroup <= 0 || alive(receipt.processGroup, true)));
}

// More conservative than process-start matching in cleanup: a reused PID is
// retained, never treated as proof that a directory can be removed.
function runnerReason(runner, status) {
  if (alive(runner?.pid) || alive(runner?.pid, true) || alive(status?.pid) ||
      alive(status?.childPid) || alive(status?.childPid, true)) return "worker_live";
  if (status?.groupCleanupPending || status?.terminationUncertain) return "process_uncertain";
  if ((runner || status) && !["completed", "failed", "cancelled"].includes(status?.status)) return "process_uncertain";
  return null;
}

function setupReason(worktree) {
  if (worktree?.setupPending) return alive(worktree.setupPending.launcherPid) ? "worker_live" : "process_uncertain";
  return uncertain(worktree?.setup) ? "process_uncertain" : null;
}

function checkReason(run, target) {
  for (const execution of run.checkExecutions ?? []) {
    if (execution?.path !== target) continue;
    if (execution.status !== "settled") return alive(execution.ownerPid) ? "worker_live" : "process_uncertain";
    if (execution.uncertainGroups?.some((group) => !Number.isInteger(group) || group <= 0 || alive(group, true))) return "process_uncertain";
  }
  return null;
}

function cleanReason(cwd, target) {
  try {
    // Resolve from supervisor Git records, never trust a worker's .git file or
    // an arbitrary gitDir string in saved state. Status cannot refresh indexes.
    const gitDir = worktreeGitDir(cwd, target);
    const probe = spawnSync("git", ["status", "--porcelain", "-z", "--untracked-files=all", "--ignore-submodules=all"], {
      cwd: target, env: { ...worktreeGitEnv(target, gitDir), GIT_OPTIONAL_LOCKS: "0" },
      encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "pipe"]
    });
    if (probe.error || probe.status !== 0) return "git_unknown";
    if (probe.stdout.length) return "dirty";
    // Existing cleanup retains submodule paths even when status ignores them.
    const modules = spawnSync("git", ["ls-files", "--stage", "-z"], {
      cwd: target, env: { ...worktreeGitEnv(target, gitDir), GIT_OPTIONAL_LOCKS: "0" },
      encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "pipe"]
    });
    if (modules.error || modules.status !== 0) return "git_unknown";
    if (modules.stdout.split("\0").some((record) => record.startsWith("160000 "))) return "dirty";
    return "finished_clean";
  } catch { return "git_unknown"; }
}

/**
 * Read-only, advisory snapshot. Cleanup remains `run cleanup`, which rechecks
 * state under its locks. Local inventory contains owned paths; do not share it
 * as diagnostics. Use exportDiagnosticMetadata for an allowlisted projection.
 */
export function inventoryStorage(cwd = process.cwd()) {
  const root = fs.realpathSync(resolveWorkspaceRoot(cwd));
  const local = path.join(root, ".orchestrator", "local");
  const runsRoot = path.join(local, "runs");
  const result = { schemaVersion: 1, advisory: true, entries: [], runs: [], unavailableRuns: 0 };
  const byPath = new Map();
  const scratchTrees = new Map();
  const add = (kind, target, reason, ownerRoot = local) => {
    const owned = typeof target === "string" && realOwned(ownerRoot, target);
    const entry = { kind, ...(owned ? { path: target } : {}),
      ...(owned ? measure(ownerRoot, target) : { bytes: 0, files: 0, symlinks: 0, complete: false }),
      cleanup: { eligible: ["finished_clean", "finished_scratch"].includes(reason), reason } };
    if (!entry.complete && entry.cleanup.eligible) entry.cleanup = { eligible: false, reason: "unavailable" };
    if (owned && byPath.has(target)) {
      // Warm retries share a worktree. Count it once, and any retention wins.
      const previous = byPath.get(target);
      if (!entry.cleanup.eligible) previous.cleanup = entry.cleanup;
      return;
    }
    if (owned) byPath.set(target, entry);
    result.entries.push(entry);
  };
  if (!realOwned(root, runsRoot)) {
    // Absence is empty; a symlink/unreadable local tree is unknown, not empty.
    try { fs.lstatSync(runsRoot); result.unavailableRuns += 1; } catch (error) {
      if (error.code !== "ENOENT") result.unavailableRuns += 1;
    }
    return result;
  }
  let directories;
  try { directories = fs.readdirSync(runsRoot, { withFileTypes: true }); }
  catch { result.unavailableRuns += 1; return result; }
  for (const directory of directories) {
    if (!component(directory.name) || !directory.isDirectory()) {
      result.unavailableRuns += 1;
      continue;
    }
    const runRoot = path.join(runsRoot, directory.name);
    let run;
    try {
      readMetadata(local, path.join(runRoot, "run.json"));
      run = loadRun(root, directory.name);
      if (run.id !== directory.name) throw new Error("state identity mismatch");
      if (taskHistory(run).some((task) => !task || !Array.isArray(task.attempts) ||
          task.attempts.some((attempt) => !attempt || typeof attempt !== "object"))) throw new Error("invalid task history");
      if (run.previews !== undefined && (!Array.isArray(run.previews) ||
          run.previews.some((preview) => !preview || (preview.checks !== undefined &&
            (!Array.isArray(preview.checks) || preview.checks.some((check) => !check)))))) throw new Error("invalid preview history");
      if (run.checkExecutions !== undefined && (!Array.isArray(run.checkExecutions) ||
          run.checkExecutions.some((execution) => !execution || (execution.uncertainGroups !== undefined && !Array.isArray(execution.uncertainGroups))))) throw new Error("invalid check history");
    } catch {
      result.unavailableRuns += 1;
      add("artifacts", runRoot, "state_unavailable");
      continue;
    }
    result.runs.push({ status: RUN_STATUSES.has(run.status) ? run.status : "unknown",
      executor: EXECUTORS.has(run.workerPolicy?.executor) ? run.workerPolicy.executor : "unknown" });
    add("artifacts", runRoot, "no_artifact_cleanup");
    for (const task of taskHistory(run)) {
      const records = [];
      for (const attempt of task.attempts ?? []) {
        if (!component(task.id) || !component(attempt.id)) continue;
        const execution = path.join(runRoot, "workers", task.id, attempt.id);
        const statuses = [];
        // Only status.json files in the known attempt directory (and resume
        // rounds) are opened. Other artifacts are statted, not scanned.
        const visit = (dir) => {
          if (!realOwned(local, dir)) return;
          try {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
              const file = path.join(dir, entry.name);
              if (entry.isDirectory()) visit(file);
              else if (entry.name === "status.json" && entry.isFile()) {
                try { statuses.push({ file, status: readMetadata(local, file) }); }
                catch { statuses.push({ file, status: null }); }
              }
            }
          } catch { statuses.push({ status: null }); }
        };
        visit(execution);
        const current = statuses.find(({ file }) => file === attempt.runner?.statusFile)?.status;
        records.push({ attempt, statuses, reason: runnerReason(attempt.runner, current) ||
          statuses.map(({ status }) => status ? runnerReason(null, status) : "process_uncertain").find(Boolean) });
      }
      const taskReason = run.pendingIntegration ? "pending_integration" :
        (!FINISHED.has(task.status) && !task.retiredPlanRevision) ? "task_active" : records.map((record) => record.reason).find(Boolean);
      for (const { attempt, statuses } of records) {
        const worktree = attempt.worktree;
        const reason = taskReason || setupReason(worktree);
        let treeReason = null;
        if (typeof worktree?.path === "string" && !worktree.inPlace) {
          const target = path.resolve(root, worktree.path);
          const owned = within(path.join(local, "worktrees", directory.name), target) && realOwned(local, target);
          treeReason = owned ? reason || checkReason(run, target) || cleanReason(root, target) : "not_owned";
          add("worktree", owned ? target : null, treeReason);
        }
        for (const { file, status } of statuses) {
          if (typeof status?.scratchDir !== "string") continue;
          const scratch = status.scratchDir;
          let owned = path.isAbsolute(scratch) && path.basename(scratch).startsWith("orch-worker-") && realOwned(path.parse(scratch).root, scratch);
          try {
            const marker = path.join(scratch, SCRATCH_OWNER_FILE);
            owned = owned && fs.lstatSync(scratch).isDirectory() && realOwned(scratch, marker) &&
              fs.lstatSync(marker).isFile() && fs.statSync(marker).size < 65536 &&
              path.resolve(fs.readFileSync(marker, "utf8")) === file;
          } catch { owned = false; }
          // CLI cleanup reaches scratch only after worktree detachment succeeds.
          const retainedTree = treeReason && treeReason !== "finished_clean" ? treeReason : null;
          add("scratch", owned ? scratch : null, owned ? reason || retainedTree || "finished_scratch" : "not_owned", owned ? scratch : local);
          if (owned && typeof worktree?.path === "string") scratchTrees.set(scratch, path.resolve(root, worktree.path));
        }
      }
    }
    for (const preview of run.previews ?? []) {
      if (typeof preview?.worktree?.path !== "string") continue;
      const target = path.resolve(root, preview.worktree.path);
      const owned = within(path.join(local, "previews", directory.name), target) && realOwned(local, target);
      const settled = ["passed", "failed"].includes(preview.status);
      const reason = run.pendingIntegration ? "pending_integration" :
        !settled && alive(preview.owner?.pid) ? "worker_live" :
        !settled || preview.unknownProcess || (preview.mayBeRunning && !(preview.checks ?? []).some((check) => check.terminationUncertain)) ||
          (preview.checks ?? []).some(uncertain) ? "process_uncertain" : setupReason(preview.worktree);
      add("preview", owned ? target : null, owned ? reason || checkReason(run, target) || cleanReason(root, target) : "not_owned");
    }
  }
  for (const [scratch, tree] of scratchTrees) {
    const worktree = byPath.get(tree), entry = byPath.get(scratch);
    if (worktree && !worktree.cleanup.eligible && entry.cleanup.eligible) entry.cleanup = { ...worktree.cleanup };
  }
  return result;
}

/** JSON data only; no writes/uploads, IDs, paths, free text, or raw state. */
export function exportDiagnosticMetadata(cwd = process.cwd()) {
  const inventory = inventoryStorage(cwd);
  const storage = {};
  for (const kind of KINDS) storage[kind] = { entries: 0, bytes: 0, files: 0, symlinks: 0, incomplete: 0, eligible: 0, retained: {} };
  for (const entry of inventory.entries) {
    if (!KINDS.has(entry.kind)) continue;
    const total = storage[entry.kind];
    total.entries += 1;
    total.bytes += entry.bytes;
    total.files += entry.files;
    total.symlinks += entry.symlinks;
    if (!entry.complete) total.incomplete += 1;
    if (entry.cleanup.eligible) total.eligible += 1;
    else {
      const reason = REASONS.has(entry.cleanup.reason) ? entry.cleanup.reason : "unavailable";
      total.retained[reason] = (total.retained[reason] ?? 0) + 1;
    }
  }
  const statuses = {}, executors = {};
  for (const run of inventory.runs) {
    statuses[run.status] = (statuses[run.status] ?? 0) + 1;
    executors[run.executor] = (executors[run.executor] ?? 0) + 1;
  }
  return { schemaVersion: 1, certification: "unknown", nodeVersion: process.versions.node,
    runs: { total: inventory.runs.length, unavailable: inventory.unavailableRuns, statuses, executors }, storage };
}
