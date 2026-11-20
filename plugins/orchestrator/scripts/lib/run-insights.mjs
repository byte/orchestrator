/** Advisory scheduling and dispatch limits; no state transitions or log reads. */
export function normalizeBudgets(budgets = {}) {
  const result = {};
  for (const [key, value] of Object.entries(budgets)) {
    if (!["maxAttempts", "maxElapsedMinutes", "maxWorkerTokens"].includes(key) || !Number.isSafeInteger(Number(value)) || Number(value) <= 0) {
      throw new Error("Budgets accept positive integers: maxAttempts, maxElapsedMinutes, maxWorkerTokens.");
    }
    result[key] = Number(value);
  }
  return result;
}

export function dispatchBudgetStatus(run, { nowMs = Date.now(), usage = null } = {}) {
  const attempts = [...(run.retiredTasks ?? []), ...Object.values(run.tasks ?? {})]
    .reduce((sum, task) => sum + task.attempts.length, 0);
  const elapsedMinutes = Math.max(0, (nowMs - Date.parse(run.createdAt)) / 60000);
  const workerTokens = usage?.measured ? usage.tokens.input + usage.tokens.output : null;
  const observed = { maxAttempts: attempts, maxElapsedMinutes: elapsedMinutes, maxWorkerTokens: workerTokens };
  const blocked = Object.entries(run.budgets ?? {}).filter(([key, limit]) => observed[key] !== null && observed[key] >= limit)
    .map(([key, limit]) => `${key} reached (${observed[key]} / ${limit}); review and explicitly revise the budget before dispatch`);
  return { limits: run.budgets ?? {}, attempts, elapsedMinutes, workerTokens, blocked,
    usageCoverage: usage ? { measured: usage.measured, missing: usage.unmeasured } : null,
    warning: run.budgets?.maxWorkerTokens ? "Usage is delayed and may be missing; this is a stop-new-dispatch threshold, not an exact spend cap." : null };
}

export function schedulingAdvice(run) {
  const tasks = Object.values(run.tasks);
  const pending = tasks.filter((task) => task.status === "pending");
  const successors = new Map(tasks.map((task) => [task.id, pending.filter((other) => other.dependsOn.includes(task.id))]));
  return pending.filter((task) => task.dependsOn.every((id) => run.tasks[id].status === "completed"))
    .map((task) => {
      const unlocked = new Set([task.id]);
      const visit = (id) => {
        for (const next of successors.get(id) ?? []) {
          if (!unlocked.has(next.id) && next.dependsOn.every((dep) => unlocked.has(dep) || run.tasks[dep].status === "completed")) {
            unlocked.add(next.id);
            visit(next.id);
          }
        }
      };
      visit(task.id);
      return { taskId: task.id, unlocks: unlocked.size - 1 };
    }).sort((left, right) => right.unlocks - left.unlocks || left.taskId.localeCompare(right.taskId));
}

export function attemptProgress(attempt, nowMs = Date.now()) {
  if (!attempt) return null;
  const end = Date.parse(attempt.finishedAt ?? "") || nowMs;
  const start = Date.parse(attempt.startedAt ?? attempt.claimedAt ?? "");
  const pausedMs = (attempt.inputRequests ?? []).reduce((sum, round) => {
    const from = Date.parse(round.requestedAt ?? "");
    const to = Math.min(end, Date.parse(round.answer?.answeredAt ?? "") || end);
    return sum + (Number.isFinite(from) ? Math.max(0, to - from) : 0);
  }, 0);
  return { activeMs: Number.isFinite(start) ? Math.max(0, end - start - pausedMs) : null,
    awaitingAnswerMs: pausedMs, lastOutputAt: attempt.runner?.lastOutputAt ?? null,
    capture: attempt.runner?.capture ?? null };
}

/** Compare exact sequential check receipts, not worker-claimed test strings. */
export function combinedRegression(run, receipt) {
  const earlier = (run.checkReceipts ?? []).filter((entry) => entry.taskId === null && entry.checkId === receipt.checkId && entry.passed &&
    JSON.stringify(entry.definition) === JSON.stringify(receipt.definition) && entry.planRevision === receipt.planRevision &&
    Date.parse(entry.finishedAt) <= Date.parse(receipt.startedAt))
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0)).at(-1);
  if (!earlier || earlier.fingerprint === receipt.fingerprint) return null;
  const changes = (receipt.integratedTasks ?? []).filter((task) =>
    !earlier.integratedTasks?.some((entry) => entry.head === task.head));
  return {
    previousPassingReceiptId: earlier.id,
    candidateTaskIds: changes.map((task) => task.taskId),
    attribution: changes.length === 1 ? "one integration since the last pass; suspected, not proven causal" : "multiple or unrecorded changes; attribution unresolved",
    next: "Inspect the failing receipt and changed code; replan one scoped repair with the original failing check as acceptance. Do not auto-revert or ask every worker to debug the run."
  };
}
