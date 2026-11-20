import path from "node:path";

import { readyTasks, runDir } from "./runs.mjs";
import { atomicWrite } from "./state.mjs";

// Tasks whose latest state needs a supervisor decision before the run can move on.
const ATTENTION_STATUSES = new Set(["reported", "blocked", "failed", "needs_input"]);
const ACTIVE_STATUSES = new Set(["dispatching", "running"]);
const ITEM_LIMIT = 280;
const SUMMARY_LIMIT = 900;
const LIST_LIMIT = 40;

function clip(text, limit) {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

// A finding is often "severity | location | verdict | evidence paths | text";
// clip each part on its own so long path lists do not crowd out the text.
function clipItem(text) {
  const parts = String(text ?? "").split(" | ");
  if (parts.length < 3) return clip(text, ITEM_LIMIT);
  const last = parts.length - 1;
  return parts.map((part, index) => clip(part, index === last ? 220 : 60)).join(" | ");
}

function list(value) {
  if (Array.isArray(value)) return value.filter((entry) => entry !== null && entry !== undefined && String(entry).trim() !== "");
  if (typeof value === "string" && value.trim()) return [value];
  return [];
}

function testLine(test) {
  if (test && typeof test === "object") {
    return [test.command, test.outcome].filter(Boolean).join(" — ");
  }
  return String(test);
}

/** The worker's structured report, falling back to the parsed text fields. */
function reportOf(task) {
  const result = task.result;
  if (!result) return null;
  const structured = result.structured && typeof result.structured === "object" ? result.structured : {};
  const fields = result.fields ?? {};
  return {
    summary: structured.summary ?? result.summary ?? "",
    decisions: list(structured.decisions ?? fields.decisions),
    tests: list(structured.tests ?? fields.tests).map(testLine),
    assumptions: list(structured.assumptions ?? fields.assumptions),
    blockers: list(structured.blockers ?? fields.blockers).filter((entry) => !/^none$/i.test(String(entry).trim())),
    files: list(structured.files_touched ?? fields.files_touched),
    confidence: structured.confidence ?? fields.confidence ?? null,
    reviewFreshness: result.reviewFreshness ?? null
  };
}

function safeComponent(value) {
  return String(value).replace(/[^\w.-]/g, "_");
}

export function reportPath(cwd, runId, task) {
  const attempt = task.attempts?.at(-1);
  return path.join(runDir(cwd, runId), "workers", safeComponent(task.id), safeComponent(attempt?.id ?? "attempt"), "report.md");
}

function renderFullReport(run, task, report) {
  const attempt = task.attempts?.at(-1) ?? {};
  const section = (title, items) => (items.length ? [`## ${title} (${items.length})`, "", ...items.map((item) => `- ${item}`), ""] : []);
  return [
    `# ${task.id}: ${task.title}`,
    "",
    `Run ${run.id} · attempt ${attempt.id ?? "?"} · ${attempt.model ?? task.model ?? "?"} (${attempt.reasoningEffort ?? task.reasoningEffort ?? "?"}) · ${task.kind} · status ${task.status} · confidence ${report.confidence ?? "not stated"}`,
    "",
    "## Summary",
    "",
    report.summary || "(none)",
    "",
    ...section("Findings and decisions", report.decisions),
    ...section("Tests", report.tests),
    ...section("Assumptions", report.assumptions),
    ...section("Blockers", report.blockers),
    ...section("Files touched", report.files)
  ].join("\n");
}

function nextStep(runId, task) {
  if (task.status === "completed") return "none: the task is accepted";
  if (task.status === "cancelled") return "none, or drop it from the plan with `run plan` so the run can finalize";
  if (task.status === "pending") return `launch it when ready: \`run launch ${runId} ${task.id}\``;
  if (task.status === "needs_input") return `answer it: \`run answer ${runId} ${task.id} (--grant-scope <glob> | --reply <text> | --deny)\``;
  if (task.status === "reported" && task.kind === "write") {
    return `review it: \`run inspect ${runId} ${task.id}\`, then \`run preview\`/\`run integrate\`, or \`run verify ... --verdict fail\``;
  }
  if (task.status === "reported") return `record your verdict: \`run verify ${runId} ${task.id} --verdict pass|fail --evidence "<what you checked>"\``;
  return `retry or replan: \`run retry ${runId} ${task.id} --note "<what to change>"\``;
}

export function renderTaskBlock(cwd, run, task) {
  const report = reportOf(task);
  const attempt = task.attempts?.at(-1) ?? {};
  const lines = [`### ${task.id} — ${task.status} (${task.kind}, ${attempt.model ?? task.model ?? "?"} ${attempt.reasoningEffort ?? task.reasoningEffort ?? ""})`.trimEnd()];
  if (!report) {
    const outcome = attempt.outcome?.code ?? attempt.outcome?.outcome ?? attempt.status ?? "no result";
    lines.push(`No worker report: ${clip(typeof outcome === "string" ? outcome : JSON.stringify(outcome), ITEM_LIMIT)}.`);
    lines.push(`Next: ${nextStep(run.id, task)}`);
    return { text: lines.join("\n"), reportFile: null };
  }
  const file = atomicWrite(reportPath(cwd, run.id, task), renderFullReport(run, task, report));
  lines.push(clip(report.summary, SUMMARY_LIMIT) || "(no summary)");
  lines.push(`confidence ${report.confidence ?? "not stated"} · ${report.decisions.length} findings/decisions · ${report.tests.length} tests · ${report.blockers.length} blockers` +
    (report.reviewFreshness?.changedDuringReview ? " · reviewed files changed during the review (stale)" : ""));
  for (const blocker of report.blockers.slice(0, 5)) lines.push(`blocker: ${clip(blocker, ITEM_LIMIT)}`);
  if (report.decisions.length) {
    lines.push("Findings (clipped):");
    for (const item of report.decisions.slice(0, LIST_LIMIT)) lines.push(`- ${clipItem(item)}`);
    if (report.decisions.length > LIST_LIMIT) lines.push(`- … ${report.decisions.length - LIST_LIMIT} more in the full report`);
  }
  for (const test of report.tests.slice(0, 8)) lines.push(`test: ${clip(test, 200)}`);
  lines.push(`Full report: ${file}`);
  lines.push(`Next: ${nextStep(run.id, task)}`);
  return { text: lines.join("\n"), reportFile: file };
}

/**
 * Everything the supervisor needs after a wake, in one payload: what changed,
 * a compact report for each task awaiting a decision (the full report goes to a
 * file), what is still running, and what can launch next.
 */
export function collectRun(cwd, run, waitResult) {
  const changedIds = new Set(waitResult.updates.filter((update) => update.changed).map((update) => update.taskId));
  const tasks = Object.values(run.tasks ?? {});
  const attention = tasks.filter((task) => ATTENTION_STATUSES.has(task.status));
  const fresh = attention.filter((task) => changedIds.has(task.id));
  const earlier = attention.filter((task) => !changedIds.has(task.id));
  const running = tasks.filter((task) => ACTIVE_STATUSES.has(task.status)).map((task) => task.id);
  const ready = readyTasks(run).map((task) => task.id);
  const blocks = fresh.map((task) => ({ taskId: task.id, status: task.status, ...renderTaskBlock(cwd, run, task) }));
  return {
    outcome: waitResult.outcome,
    exitCode: waitResult.exitCode,
    message: waitResult.message,
    updates: waitResult.updates,
    changed: blocks.map(({ taskId, status, reportFile }) => ({ taskId, status, reportFile })),
    awaiting: earlier.map((task) => ({ taskId: task.id, status: task.status })),
    running,
    ready,
    text: blocks.map((block) => block.text)
  };
}

export function renderCollect(collected, pollLines) {
  const out = [collected.message];
  // Poll lines carry what a compact report does not: a paused worker's request,
  // an over-limit notice, a substitution, a cancellation.
  const notes = pollLines.filter((_line, index) => {
    const update = collected.updates[index];
    if (!update) return false;
    if (update.inputRequest || update.overLimit) return true;
    return update.changed && !collected.changed.some((entry) => entry.taskId === update.taskId);
  });
  if (notes.length) out.push("", ...notes);
  if (collected.text.length) out.push("", ...collected.text.flatMap((block) => [block, ""]));
  const status = [];
  if (collected.awaiting.length) status.push(`Still awaiting your decision: ${collected.awaiting.map((entry) => `${entry.taskId} (${entry.status})`).join(", ")}`);
  status.push(collected.running.length ? `Running: ${collected.running.join(", ")}` : "Running: none");
  if (collected.ready.length) status.push(`Dependencies met, not launched: ${collected.ready.join(", ")} (\`run ready\` shows capacity and scope conflicts)`);
  if (!collected.running.length && !collected.ready.length && !collected.awaiting.length && !collected.text.length) {
    status.push("Nothing is running, waiting, or ready: run the final check and finalize.");
  }
  out.push(...status);
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}
