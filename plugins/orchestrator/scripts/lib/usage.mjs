// What a run's Codex workers consumed, read from Codex's own session logs.
//
// Codex writes every thread to $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<time>-<thread>.jsonl,
// for `codex exec` and for the plugin's app-server alike. Its `token_count`
// events carry the thread's cumulative usage and the account's rate-limit
// windows. A warm retry or an answered question resumes the same thread, so an
// attempt's usage is the cumulative total at its end minus the total before it
// started. Nothing here writes run state; a missing log is reported, not guessed.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";


function taskHistory(run) {
  return [...(run.retiredTasks ?? []), ...Object.values(run.tasks ?? {})];
}

const WEEK_MINUTES = 7 * 24 * 60;
const DAY_MS = 24 * 60 * 60 * 1000;

export function codexHome(env = process.env) {
  return env.CODEX_HOME ? path.resolve(env.CODEX_HOME) : path.join(os.homedir(), ".codex");
}

function dayDirs(sessions, fromMs, toMs) {
  const dirs = [];
  // Codex names day directories in local time; a day either side covers any offset.
  for (let at = fromMs - DAY_MS; at <= toMs + DAY_MS; at += DAY_MS) {
    const day = new Date(at);
    const parts = [
      String(day.getFullYear()),
      String(day.getMonth() + 1).padStart(2, "0"),
      String(day.getDate()).padStart(2, "0")
    ];
    const dir = path.join(sessions, ...parts);
    if (!dirs.includes(dir)) dirs.push(dir);
  }
  return dirs;
}

function matchIn(dir, suffix) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const name = names.find((entry) => entry.startsWith("rollout-") && entry.endsWith(suffix));
  return name ? path.join(dir, name) : null;
}

/**
 * Find the session log for a thread. Days around the attempt are tried first;
 * a thread resumed long after it began lives under its first day, so the rest
 * of the sessions tree is searched as a fallback.
 */
export function findRollout(threadId, { home = codexHome(), fromMs = Date.now(), toMs = fromMs } = {}) {
  if (!threadId || !/^[\w-]+$/.test(threadId)) return null;
  const sessions = path.join(home, "sessions");
  const suffix = `-${threadId}.jsonl`;
  const near = dayDirs(sessions, fromMs, toMs);
  for (const dir of near) {
    const found = matchIn(dir, suffix);
    if (found) return found;
  }
  const list = (dir) => {
    try {
      return fs.readdirSync(dir).filter((entry) => /^\d+$/.test(entry)).sort().reverse();
    } catch {
      return [];
    }
  };
  for (const year of list(sessions)) {
    for (const month of list(path.join(sessions, year))) {
      for (const day of list(path.join(sessions, year, month))) {
        const dir = path.join(sessions, year, month, day);
        if (near.includes(dir)) continue;
        const found = matchIn(dir, suffix);
        if (found) return found;
      }
    }
  }
  return null;
}

function weeklyWindow(limits) {
  for (const window of [limits?.primary, limits?.secondary]) {
    if (window && Number(window.window_minutes) === WEEK_MINUTES && Number.isFinite(Number(window.used_percent))) {
      return { usedPercent: Number(window.used_percent), resetsAt: window.resets_at ?? null };
    }
  }
  return null;
}

/** The token_count events in a session log, in order: { atMs, total, weekly, plan }. */
export function readTokenEvents(file) {
  const events = [];
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return events;
  }
  for (const line of text.split("\n")) {
    if (!line.includes('"token_count"')) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const payload = entry?.payload;
    if (payload?.type !== "token_count") continue;
    const atMs = Date.parse(entry.timestamp);
    if (!Number.isFinite(atMs)) continue;
    events.push({
      atMs,
      total: payload.info?.total_token_usage ?? null,
      weekly: weeklyWindow(payload.rate_limits),
      plan: payload.rate_limits?.plan_type ?? null
    });
  }
  return events;
}

const FIELDS = [
  ["input", "input_tokens"],
  ["cachedInput", "cached_input_tokens"],
  ["output", "output_tokens"],
  ["reasoningOutput", "reasoning_output_tokens"]
];

function tokens(total) {
  const out = {};
  for (const [key, source] of FIELDS) out[key] = Number(total?.[source]) || 0;
  return out;
}

export function emptyTokens() {
  return tokens(null);
}

export function addTokens(sum, add) {
  for (const [key] of FIELDS) sum[key] += add[key];
  return sum;
}

/**
 * One attempt's usage: the thread's cumulative total at the attempt's last
 * event minus its total before the attempt started. Returns { available:false,
 * reason } when there is no thread or no log.
 */
export function attemptUsage(attempt, { home = codexHome(), nowMs = Date.now(), untilMs = Infinity } = {}) {
  const threadId = attempt?.threadId;
  if (!threadId) return { available: false, reason: "no Codex thread recorded" };
  const fromMs = Date.parse(attempt.startedAt ?? attempt.claimedAt ?? "");
  if (!Number.isFinite(fromMs)) return { available: false, reason: "attempt has no start time" };
  const finishedMs = Date.parse(attempt.finishedAt ?? "");
  const toMs = Number.isFinite(finishedMs) ? finishedMs : nowMs;
  const file = findRollout(threadId, { home, fromMs, toMs });
  if (!file) return { available: false, reason: `no Codex session log for thread ${threadId}` };
  const events = readTokenEvents(file);
  // A worker's last token_count can land just after the orchestrator records
  // the attempt as finished; a minute of slack keeps it, but never past the
  // start of the next attempt, which may resume the same thread.
  const endMs = Math.min(toMs + 60_000, untilMs);
  let before = null;
  let last = null;
  const inWindow = [];
  for (const event of events) {
    if (event.atMs < fromMs) {
      if (event.total) before = event.total;
    } else if (event.atMs <= endMs) {
      inWindow.push(event);
      if (event.total) last = event.total;
    }
  }
  if (!last) return { available: false, reason: "no token usage in the session log for this attempt" };
  const start = tokens(before);
  const end = tokens(last);
  const used = {};
  for (const [key] of FIELDS) used[key] = Math.max(0, end[key] - start[key]);
  const weekly = inWindow.filter((event) => event.weekly);
  return {
    available: true,
    threadId,
    tokens: used,
    plan: [...inWindow].reverse().find((event) => event.plan)?.plan ?? null,
    weeklyFirst: weekly[0] ? { atMs: weekly[0].atMs, ...weekly[0].weekly } : null,
    weeklyLast: weekly.at(-1) ? { atMs: weekly.at(-1).atMs, ...weekly.at(-1).weekly } : null
  };
}

/** Usage for every attempt the run has made, retired tasks included. */
export function runUsage(run, { home = codexHome(), nowMs = Date.now() } = {}) {
  const attempts = [];
  const totals = emptyTokens();
  const byModel = {};
  let first = null;
  let last = null;
  let plan = null;
  for (const task of taskHistory(run)) {
    const list = task.attempts ?? [];
    for (const [index, attempt] of list.entries()) {
      if (!attempt.startedAt && !attempt.threadId) continue;
      const next = list.slice(index + 1).map((later) => Date.parse(later.startedAt ?? later.claimedAt ?? ""))
        .find(Number.isFinite);
      const usage = attemptUsage(attempt, { home, nowMs, untilMs: next ?? Infinity });
      attempts.push({
        taskId: task.id,
        attemptId: attempt.id,
        model: attempt.model ?? task.model ?? null,
        effort: attempt.reasoningEffort ?? null,
        status: attempt.status ?? null,
        ...usage
      });
      if (!usage.available) continue;
      addTokens(totals, usage.tokens);
      const model = attempt.model ?? "unknown";
      byModel[model] = addTokens(byModel[model] ?? emptyTokens(), usage.tokens);
      plan = usage.plan ?? plan;
      if (usage.weeklyFirst && (!first || usage.weeklyFirst.atMs < first.atMs)) first = usage.weeklyFirst;
      if (usage.weeklyLast && (!last || usage.weeklyLast.atMs > last.atMs)) last = usage.weeklyLast;
    }
  }
  const measured = attempts.filter((entry) => entry.available).length;
  return {
    runId: run.id,
    attempts,
    workers: new Set(attempts.filter((entry) => entry.available).map((entry) => entry.taskId)).size,
    measured,
    unmeasured: attempts.length - measured,
    tokens: totals,
    byModel,
    plan,
    weekly: first && last ? { fromPercent: first.usedPercent, toPercent: last.usedPercent } : null
  };
}

export function formatTokens(count) {
  if (count >= 1e6) return `${(count / 1e6).toFixed(count >= 1e7 ? 0 : 1)}M`;
  if (count >= 1e3) return `${Math.round(count / 1e3)}K`;
  return String(count);
}

function cachedShare(t) {
  return t.input ? Math.round((t.cachedInput / t.input) * 100) : 0;
}

/** The one-line usage summary, or null when nothing was measured. */
export function usageLine(usage) {
  if (!usage.measured) return null;
  const t = usage.tokens;
  const workers = usage.workers ?? usage.measured;
  const parts = [
    `${workers} worker${workers === 1 ? "" : "s"}`,
    `${formatTokens(t.input + t.output)} tokens (${cachedShare(t)}% cached input)`
  ];
  if (usage.weekly) {
    const delta = Math.max(0, usage.weekly.toPercent - usage.weekly.fromPercent);
    parts.push(`weekly Codex limit ${usage.weekly.fromPercent}% → ${usage.weekly.toPercent}% (+${delta}, account-wide)`);
  }
  return parts.join(" · ");
}

/** The contribution line from a recorded tally plus the run's own outcomes. */
export function contributionLines(run) {
  const lines = [];
  const outcomes = { first: 0, retried: 0, rejected: 0 };
  for (const task of Object.values(run.tasks ?? {})) {
    const attempts = task.attempts ?? [];
    if (task.status === "completed") {
      if (attempts.length <= 1) outcomes.first += 1;
      else outcomes.retried += 1;
    } else if (["failed", "cancelled"].includes(task.status)) {
      outcomes.rejected += 1;
    }
  }
  lines.push(
    `Worker results: ${outcomes.first} accepted first try · ${outcomes.retried} accepted after retry · ${outcomes.rejected} failed or cancelled`
  );
  const tally = run.contribution;
  if (tally) {
    lines.push(
      `Worker findings: ${tally.findings} · supervisor re-checked ${tally.checked} · held ${tally.held} · corrected ${tally.corrected}`
    );
    lines.push(`Only from workers: ${tally.workerOnly} · supervisor-only: ${tally.supervisorOnly}`);
    if (tally.note) lines.push(`Note: ${tally.note}`);
  } else {
    lines.push("No contribution tally recorded (`run tally`).");
  }
  return lines;
}

export function renderRunCost(run, usage) {
  const out = [`# Cost and contribution: ${run.id}`, ""];
  const snapshot = run.finalization?.usage;
  const line = usageLine(usage);
  if (line) {
    out.push(line);
  } else if (snapshot) {
    out.push(`${usageLine(snapshot)} (saved at finalization; the session logs are no longer readable)`);
    usage = { ...usage, plan: usage.plan ?? snapshot.plan };
  } else {
    out.push("No worker usage could be read from Codex session logs.");
  }
  if (usage.plan) out.push(`Codex plan: ${usage.plan}. Subscription plans are not billed per token; the weekly limit is the cost.`);
  out.push("");
  if (usage.attempts.length) {
    out.push("| Task | Attempt | Model | Effort | Fresh input | Cached input | Output |");
    out.push("| --- | --- | --- | --- | --- | --- | --- |");
    for (const entry of usage.attempts) {
      if (entry.available) {
        const t = entry.tokens;
        out.push(`| ${entry.taskId} | ${entry.attemptId} | ${entry.model ?? "?"} | ${entry.effort ?? "?"} | ${formatTokens(t.input - t.cachedInput)} | ${formatTokens(t.cachedInput)} | ${formatTokens(t.output)} |`);
      } else {
        out.push(`| ${entry.taskId} | ${entry.attemptId} | ${entry.model ?? "?"} | ${entry.effort ?? "?"} | — | — | ${entry.reason} |`);
      }
    }
    out.push("");
  }
  if (usage.weekly) {
    out.push("The weekly-limit change is account-wide: it includes any other Codex use during the run.");
  }
  out.push("The supervisor's own Claude usage is not visible here; see `/cost` in Claude Code.");
  out.push("");
  out.push(...contributionLines(run));
  return out.join("\n");
}
