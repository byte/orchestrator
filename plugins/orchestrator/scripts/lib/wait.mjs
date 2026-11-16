import fs from "node:fs";
import path from "node:path";

import {
  loadRun,
  runDir,
  taskTimeoutMinutes,
  workerClockStart
} from "./runs.mjs";
import { pollRunWorkers } from "./workers.mjs";

/**
 * Exit codes of `orch run wait`. 1 stays the generic CLI error code.
 *
 * - 0 `changed`: a worker changed state; the output is the `run poll` payload.
 * - 2 `timeout`: nothing changed before `--timeout`; workers are still running.
 * - 3 `idle`: no worker is running or paused, so nothing can change.
 * - 4 `awaiting_answer`: no worker is running, and every remaining one is paused
 *   on a `needs_input` request that only the supervisor can unblock.
 */
export const WAIT_EXIT_CODES = Object.freeze({
  changed: 0,
  timeout: 2,
  idle: 3,
  awaiting_answer: 4
});

export const DEFAULT_WAIT_TIMEOUT_SECONDS = 30 * 60;
// The fallback poll. File events normally wake the wait within DEBOUNCE_MS; this
// interval only bounds how late a wake can be when an event is missed.
export const DEFAULT_WAIT_INTERVAL_SECONDS = 15;
const DEBOUNCE_MS = 100;
// Consecutive failed polls tolerated before the wait gives up with an error. A
// single failure is usually a race with a concurrent `run poll`.
const MAX_POLL_ERRORS = 3;
// Files whose replacement means state may have changed. Both are written by
// rename, so an event may name the temporary file (`<name>.<pid>[.<ms>].tmp`)
// instead. Anything else must not match: every poll takes `run.json.lock`, and
// a filter that let it through woke the wait on its own polling, about ten
// times a second.
const WORKER_FILES = /^(status|result)\.json(\.[\d.]+\.tmp)?$/;
const RUN_FILES = /^run\.json(\.[\d.]+\.tmp)?$/;

function activeTasks(run) {
  return Object.values(run.tasks).filter((task) => ["dispatching", "running"].includes(task.status));
}

function pausedTasks(run) {
  return Object.values(run.tasks).filter((task) => task.status === "needs_input");
}

/** Directories to watch: each active attempt's runner directory, plus the run's own. */
function watchTargets(cwd, run) {
  const targets = new Map([[runDir(cwd, run.id), "run"]]);
  for (const task of activeTasks(run)) {
    const statusFile = task.attempts.at(-1)?.runner?.statusFile;
    if (statusFile) {
      targets.set(path.dirname(statusFile), "worker");
    }
  }
  return targets;
}

/** The earliest moment a running worker crosses its limit and has not been reported yet. */
function nextLimitDeadline(run) {
  let earliest = Infinity;
  for (const task of activeTasks(run)) {
    const attempt = task.attempts.at(-1);
    const clockStart = workerClockStart(attempt);
    const started = clockStart ? Date.parse(clockStart) : NaN;
    if (!Number.isFinite(started) || attempt?.overLimit?.clockStart === clockStart) {
      continue;
    }
    earliest = Math.min(earliest, started + taskTimeoutMinutes(task, attempt) * 60000);
  }
  return earliest;
}

function describeChange(update) {
  if (update.overLimit && !["reported", "failed", "blocked", "cancelled"].includes(update.status)) {
    return `${update.taskId} is over its ${update.overLimit.timeoutMinutes}-minute limit ` +
      `(running ${update.overLimit.elapsedMinutes} min; still running, not stopped)`;
  }
  if (update.status === "running" && update.resumeFallback) {
    return `${update.taskId} resume fell back to a fresh thread (${update.resumeFallback.reason})`;
  }
  return `${update.taskId} ${update.status}`;
}

function finishMessage(runId, outcome, { updates, run, seconds }) {
  if (outcome === "changed") {
    const changes = updates.filter((update) => update.changed).map(describeChange);
    return `run wait: ${runId} changed: ${changes.join("; ")}.`;
  }
  if (outcome === "timeout") {
    const running = activeTasks(run).map((task) => task.id);
    return `run wait: timed out after ${seconds}s with no state change; still running: ` +
      `${running.join(", ") || "none"}. Start another run wait to keep waiting.`;
  }
  if (outcome === "awaiting_answer") {
    return `run wait: no worker is running in ${runId}; ${pausedTasks(run).map((task) => task.id).join(", ")} ` +
      "paused awaiting your answer (run answer). Nothing changes until you answer.";
  }
  return `run wait: no active workers in ${runId}; nothing to wait for.`;
}

/**
 * Block until a worker of the run changes state, then resolve with the same
 * updates `run poll` returns. It polls once immediately, so a change that is
 * already on disk returns at once, and it returns at once when nothing is
 * running. Otherwise it watches each active worker's directory (status files are
 * replaced by rename, so the directory is watched, not the file) and the run
 * directory, which catches launches and answers made while it waits. A slow
 * fallback poll every `intervalMs` covers platforms where `fs.watch` is missing,
 * fails, or drops an event: a missed event only delays the wake by at most one
 * interval. A timer fires at the next wall-clock limit so an over-limit worker is
 * reported on time even when its files are quiet.
 *
 * Resolves with { outcome, exitCode, updates, message, polls, wakeSource }.
 */
export function waitForRunChange(
  cwd,
  runId,
  {
    timeoutMs = DEFAULT_WAIT_TIMEOUT_SECONDS * 1000,
    intervalMs = DEFAULT_WAIT_INTERVAL_SECONDS * 1000,
    watch = true
  } = {}
) {
  // Fail fast on an unknown run instead of watching nothing.
  loadRun(cwd, runId);
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const watchers = new Map();
    let fallbackTimer = null;
    let timeoutTimer = null;
    let debounceTimer = null;
    let deadlineTimer = null;
    let polls = 0;
    let pollErrors = 0;
    let done = false;
    let last = { updates: [], run: null };

    function closeAll() {
      done = true;
      for (const watcher of watchers.values()) {
        watcher.close();
      }
      watchers.clear();
      clearInterval(fallbackTimer);
      clearTimeout(timeoutTimer);
      clearTimeout(debounceTimer);
      clearTimeout(deadlineTimer);
    }

    function finish(outcome, updates, run, wakeSource) {
      closeAll();
      resolve({
        outcome,
        exitCode: WAIT_EXIT_CODES[outcome],
        updates,
        message: finishMessage(runId, outcome, {
          updates,
          run,
          seconds: Math.round((Date.now() - started) / 1000)
        }),
        polls,
        wakeSource
      });
    }

    /** Watch the current targets; returns how many watchers were newly armed. */
    function syncWatchers(run) {
      if (!watch) {
        return 0;
      }
      let armed = 0;
      const targets = watchTargets(cwd, run);
      for (const [directory, watcher] of watchers) {
        if (!targets.has(directory)) {
          watcher.close();
          watchers.delete(directory);
        }
      }
      for (const [directory, kind] of targets) {
        if (watchers.has(directory)) {
          continue;
        }
        try {
          const watcher = fs.watch(directory, { persistent: true }, (_event, filename) => {
            // Some platforms omit the filename; treat that as a possible change.
            const name = filename ? String(filename) : null;
            if (name && !(kind === "run" ? RUN_FILES : WORKER_FILES).test(name)) {
              return;
            }
            schedule("watch");
          });
          // A watcher that errors (directory removed, too many watches) is
          // dropped; the fallback interval keeps the wait correct without it.
          watcher.on("error", () => {
            watcher.close();
            watchers.delete(directory);
          });
          watchers.set(directory, watcher);
          armed += 1;
        } catch {
          // fs.watch is unavailable or the directory does not exist yet; the
          // fallback interval covers it and the next check retries.
        }
      }
      return armed;
    }

    function scheduleDeadline(run) {
      clearTimeout(deadlineTimer);
      const deadline = nextLimitDeadline(run);
      const remaining = started + timeoutMs - Date.now();
      if (Number.isFinite(deadline) && deadline - Date.now() < remaining) {
        deadlineTimer = setTimeout(() => check("limit"), Math.max(0, deadline - Date.now()) + 50);
      }
    }

    function check(source) {
      if (done) {
        return;
      }
      clearTimeout(debounceTimer);
      debounceTimer = null;
      let updates;
      let run;
      try {
        polls += 1;
        updates = pollRunWorkers(cwd, runId);
        run = loadRun(cwd, runId);
        pollErrors = 0;
        last = { updates, run };
      } catch (error) {
        pollErrors += 1;
        if (pollErrors >= MAX_POLL_ERRORS) {
          closeAll();
          reject(error);
        }
        return;
      }
      if (updates.some((update) => update.changed)) {
        return finish("changed", updates, run, source);
      }
      if (!activeTasks(run).length) {
        return finish(pausedTasks(run).length ? "awaiting_answer" : "idle", updates, run, source);
      }
      // A worker can finish between this poll and its watcher being armed, and
      // that event is never delivered. Looking once more after arming closes the
      // gap: anything later fires the watcher, anything earlier is on disk now.
      if (syncWatchers(run)) {
        schedule("rearm");
      }
      scheduleDeadline(run);
    }

    function schedule(source) {
      if (done || debounceTimer) {
        return;
      }
      debounceTimer = setTimeout(() => check(source), DEBOUNCE_MS);
    }

    check("start");
    if (done) {
      return;
    }
    fallbackTimer = setInterval(() => check("interval"), intervalMs);
    timeoutTimer = setTimeout(() => {
      if (done) {
        return;
      }
      // One last look, so a change that raced the timer is not reported as a timeout.
      check("timeout");
      if (!done) {
        finish("timeout", last.updates, last.run ?? loadRun(cwd, runId), "timeout");
      }
    }, timeoutMs);
  });
}
