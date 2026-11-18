import fs from "node:fs";
import path from "node:path";

import { LEGACY_WORKER_MODELS, historicalTaskAssignment, loadRun, taskHistory } from "./runs.mjs";
import { localDir } from "./state.mjs";

/**
 * Route evidence: what each model and effort actually did in this repository's
 * saved runs. It is a plain read-only aggregation over `local/runs/<run-id>/run.json`
 * for the supervisor to look at before routing. It never reads the governed
 * learning store, writes nothing, and uploads nothing.
 *
 * Counting rules:
 * - An attempt is attributed to the model it actually ran on (`attempt.model`),
 *   so a substituted attempt counts for the substitute, not the requested model.
 * - A launch Codex rejected as model-unavailable, and a launch that failed before
 *   Codex started, never reached a worker. They are not attempts for any model;
 *   rejections are listed separately by the rejected model.
 * - `needs_input` round trips are part of the attempt that asked; they are never
 *   separate attempts. An attempt still running or paused has no outcome yet and
 *   is not counted.
 * - A cancelled attempt is not evidence about the route (the supervisor or user
 *   stopped it), so it is listed separately and not counted.
 * - "First attempt" is the first attempt of a task that reached a worker. Every
 *   later counted attempt of that task, warm or cold, is a retry. When that first
 *   attempt was cancelled or is still open, the task gives no first-attempt sample.
 * - Attempts on retired slugs (LEGACY_WORKER_MODELS) are excluded unless `includeLegacy` is set.
 */

/** Below this many samples a rate is withheld; only the counts are shown. */
export const ROUTE_RATE_MIN_SAMPLE = 5;
/** `run plan`, `run resume`, and `run briefing` show the table from this many counted attempts. */
export const ROUTE_TABLE_MIN_ATTEMPTS = 5;

function reachedWorker(attempt) {
  if (attempt.modelUnavailable || attempt.launchFailed) {
    return false;
  }
  // Defensive for hand-edited or partially migrated state: a model-unavailable
  // execution failure is by construction a launch Codex rejected.
  return !(attempt.outcome?.terminalOutcome === "execution_failed" &&
    attempt.outcome?.reasonCode === "model_unavailable");
}

/** accepted | failed | cancelled | null (still open), from the outcome or, for old state, the status. */
function attemptResult(attempt) {
  const terminal = attempt.outcome?.terminalOutcome;
  if (terminal) {
    return terminal === "accepted" ? "accepted" : terminal === "cancelled" ? "cancelled" : "failed";
  }
  if (attempt.status === "completed") {
    return "accepted";
  }
  if (attempt.status === "cancelled") {
    return "cancelled";
  }
  return ["failed", "blocked"].includes(attempt.status) ? "failed" : null;
}

function attemptRoute(run, task, attempt) {
  // A current plan is not execution evidence: replanning must not move old
  // results to a different effort. Legacy gaps without a snapshot stay unknown.
  const saved = historicalTaskAssignment(run, task, attempt);
  return {
    model: attempt.model ?? saved?.model ?? "unknown",
    reasoningEffort: attempt.reasoningEffort ?? saved?.reasoningEffort ?? "unknown"
  };
}

/** Time the attempt spent paused on needs_input requests, which is not model runtime. */
function pausedMs(attempt, end) {
  let paused = 0;
  for (const round of attempt.inputRequests ?? []) {
    const from = Date.parse(round.requestedAt ?? "");
    const until = Date.parse(round.answer?.answeredAt ?? "") || end;
    if (Number.isFinite(from) && Number.isFinite(until) && until > from) {
      paused += until - from;
    }
  }
  return paused;
}

function durationMs(attempt) {
  const start = Date.parse(attempt.startedAt ?? attempt.claimedAt ?? "");
  const end = Date.parse(attempt.finishedAt ?? "");
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    return null;
  }
  return Math.max(0, end - start - pausedMs(attempt, end));
}

function median(values) {
  if (!values.length) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

/** Read every saved run, skipping (and counting) any this build cannot load. */
export function loadRunsForRoutes(cwd) {
  const directory = path.join(localDir(cwd), "runs");
  if (!fs.existsSync(directory)) {
    return { runs: [], skipped: [] };
  }
  const runs = [];
  const skipped = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    try {
      runs.push(loadRun(cwd, entry.name));
    } catch (error) {
      skipped.push({ runId: entry.name, error: error.message });
    }
  }
  return { runs, skipped };
}

/** Aggregate attempts per actual model and effort. Pure: takes loaded runs. */
export function aggregateRoutes(runs, { lane = null, includeLegacy = false } = {}) {
  const cells = new Map();
  const excluded = { modelUnavailable: {}, launchFailed: 0, cancelled: 0, inProgress: 0, legacy: 0 };
  let runCount = 0;
  for (const run of runs) {
    if (lane && run.lane !== lane) {
      continue;
    }
    runCount += 1;
    for (const task of taskHistory(run)) {
      let firstSeen = false;
      for (const attempt of task.attempts ?? []) {
        if (!reachedWorker(attempt)) {
          if (attempt.launchFailed) {
            excluded.launchFailed += 1;
          } else {
            const model = attempt.modelUnavailable?.model ?? attempt.model ?? "unknown";
            excluded.modelUnavailable[model] = (excluded.modelUnavailable[model] ?? 0) + 1;
          }
          continue;
        }
        const first = !firstSeen;
        firstSeen = true;
        const result = attemptResult(attempt);
        if (result === null) {
          excluded.inProgress += 1;
          continue;
        }
        if (result === "cancelled") {
          excluded.cancelled += 1;
          continue;
        }
        const route = attemptRoute(run, task, attempt);
        if (!includeLegacy && Object.hasOwn(LEGACY_WORKER_MODELS, route.model)) {
          excluded.legacy += 1;
          continue;
        }
        const key = `${route.model}\u0000${route.reasoningEffort}`;
        if (!cells.has(key)) {
          cells.set(key, {
            model: route.model,
            reasoningEffort: route.reasoningEffort,
            attempts: 0,
            accepted: 0,
            firstAttempts: 0,
            firstAccepted: 0,
            retries: 0,
            substituted: 0,
            durations: []
          });
        }
        const cell = cells.get(key);
        cell.attempts += 1;
        cell.accepted += result === "accepted" ? 1 : 0;
        if (first) {
          cell.firstAttempts += 1;
          cell.firstAccepted += result === "accepted" ? 1 : 0;
        } else {
          cell.retries += 1;
        }
        if (attempt.substitution || (attempt.requestedModel && attempt.requestedModel !== attempt.model)) {
          cell.substituted += 1;
        }
        const duration = durationMs(attempt);
        if (duration !== null) {
          cell.durations.push(duration);
        }
      }
    }
  }
  const rows = [...cells.values()]
    .map(({ durations, ...cell }) => ({
      ...cell,
      firstAttemptAcceptanceRate: cell.firstAttempts >= ROUTE_RATE_MIN_SAMPLE
        ? cell.firstAccepted / cell.firstAttempts
        : null,
      medianDurationMs: median(durations),
      durationSamples: durations.length
    }))
    .sort((left, right) =>
      right.attempts - left.attempts ||
      left.model.localeCompare(right.model) ||
      left.reasoningEffort.localeCompare(right.reasoningEffort)
    );
  return {
    lane,
    includeLegacy,
    minSample: ROUTE_RATE_MIN_SAMPLE,
    runs: runCount,
    attempts: rows.reduce((total, row) => total + row.attempts, 0),
    rows,
    excluded
  };
}

/** Load local runs and aggregate them. Never touches the learning store. */
export function routeEvidence(cwd, options = {}) {
  const { runs, skipped } = loadRunsForRoutes(cwd);
  return { ...aggregateRoutes(runs, options), skippedRuns: skipped };
}

function formatDuration(ms) {
  if (ms === null) {
    return "—";
  }
  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const secondsPart = totalSeconds % 60;
  if (hours) {
    return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  }
  return minutes ? `${minutes}m ${String(secondsPart).padStart(2, "0")}s` : `${secondsPart}s`;
}

function formatFirst(row) {
  const counts = `${row.firstAccepted}/${row.firstAttempts}`;
  return row.firstAttemptAcceptanceRate === null
    ? `${counts} (n<${ROUTE_RATE_MIN_SAMPLE}, no rate)`
    : `${counts} = ${Math.round(row.firstAttemptAcceptanceRate * 100)}%`;
}

function excludedLines(evidence) {
  const lines = [];
  const rejected = Object.entries(evidence.excluded.modelUnavailable);
  if (rejected.length) {
    lines.push(
      `launches Codex rejected as model-unavailable (never reached a worker): ` +
        rejected.map(([model, count]) => `${model} ×${count}`).join(", ")
    );
  }
  if (evidence.excluded.launchFailed) {
    lines.push(`launches that failed before Codex started: ${evidence.excluded.launchFailed}`);
  }
  if (evidence.excluded.cancelled) {
    lines.push(`cancelled attempts: ${evidence.excluded.cancelled}`);
  }
  if (evidence.excluded.inProgress) {
    lines.push(`attempts still running or paused on a request: ${evidence.excluded.inProgress}`);
  }
  if (evidence.excluded.legacy) {
    lines.push(
      `attempts on retired slugs (${Object.keys(LEGACY_WORKER_MODELS).join(", ")}): ${evidence.excluded.legacy} ` +
        "(pass --include-legacy to count them)"
    );
  }
  for (const skipped of evidence.skippedRuns ?? []) {
    lines.push(`run ${skipped.runId} could not be read: ${skipped.error}`);
  }
  return lines;
}

/** Markdown table plus the counting rules and everything left out. */
export function renderRouteEvidence(evidence, { heading = "## Route evidence" } = {}) {
  const scope = evidence.lane ? `lane ${evidence.lane}` : "all lanes";
  const header = `${heading} — ${scope}, ${evidence.runs} local run${evidence.runs === 1 ? "" : "s"}`;
  const rules = "Finished attempts that reached a Codex worker, by the model they actually ran on. " +
    "First-attempt acceptance counts each task's first attempt that reached a worker; later " +
    `attempts are retries. A rate is shown only when its sample is at least ${ROUTE_RATE_MIN_SAMPLE}. ` +
    "Answered input requests are part of their attempt, not attempts.";
  const table = evidence.rows.length
    ? [
        "| model | effort | attempts | first-attempt accepted | retries | substituted in | median duration |",
        "| --- | --- | --- | --- | --- | --- | --- |",
        ...evidence.rows.map((row) =>
          `| ${row.model} | ${row.reasoningEffort} | ${row.attempts} | ${formatFirst(row)} | ` +
          `${row.retries} | ${row.substituted} | ${formatDuration(row.medianDurationMs)} (n=${row.durationSamples}) |`
        )
      ].join("\n")
    : "No finished attempts to count yet.";
  const left = excludedLines(evidence);
  return [
    header,
    "",
    rules,
    "",
    table,
    ...(left.length ? ["", "Not counted:", ...left.map((line) => `- ${line}`)] : [])
  ].join("\n");
}
