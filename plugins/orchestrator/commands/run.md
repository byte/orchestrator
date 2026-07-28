---
description: Automatically route and manage a GPT-5.6 Codex worker pool from the Claude Code main thread
argument-hint: "<lane> [--max-workers <n>] [--model <auto|sol|terra|luna>] [--effort <auto|level>] <objective>"
allowed-tools: Read, Grep, Glob, Write, Bash(node:*), AskUserQuestion
---

Run a complete orchestration loop in the main Claude thread.

You are the supervisor. Plan the work, maintain the task graph and durable checkpoints,
dispatch a bounded pool of Codex workers, verify their evidence, replan when necessary, and
integrate the final result. Do not hand supervisory authority to a subagent.

Raw user request:
$ARGUMENTS

## 1. Parse and inspect

The first positional token is the lane. `--max-workers`, `--model`, and `--effort` configure the
pool; everything else is the objective. Model and effort both default to `auto`, which means you
must select them per task during planning. Treat explicit values as user pins, not suggestions.

Inspect the relevant repository guidance and implementation before planning. Keep this inspection
in the main thread so the plan benefits from the user's conversation context.

Do not silently create a missing lane or widen its scope. Ask only when an ambiguity would
materially change the result or require new authority.

## 2. Create the durable run

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/orch.mjs" run create <lane> \
  --objective "<objective>" \
  --max-workers <n> \
  --json
```

Append `--model <sol|terra|luna>` or `--effort <level>` only when the user explicitly supplied
that override. Omitted dimensions remain supervisor-routed. Keep the returned run id.

## 3. Plan

Produce a small task DAG. Each task must have:

- `id`: short lower-case identifier
- `title`
- `objective`: one bounded outcome
- `kind`: `write`, `read`, or `verify`
- `scope`: explicit path patterns for write tasks
- `dependsOn`: task ids that must be supervisor-verified first
- `constraints`
- `acceptance`: evidence-based completion criteria
- `model`: `sol`, `terra`, `luna`, or an exact `gpt-5.6-*` slug unless the run pins a model
- `effort`: the selected per-task reasoning effort unless the run pins an effort
- `routingReason`: one concise explanation of why the selected route fits the task whenever either
  dimension is supervisor-routed

Route by the demands of each bounded task:

- use `sol` for the hardest open-ended implementation, security, architecture, debugging, and
  deep verification work
- use `terra` for strong general coding, review, and everyday work where balance matters
- use `luna` for clear, repeatable, high-volume transformations and extraction

Select effort independently: use `low` for routine or latency-sensitive work, `medium` for balanced
everyday work, `high` or `xhigh` only when deeper reasoning should materially improve the result,
and `max` only for the hardest quality-first task. Prefer the lowest effort that should reliably
meet the acceptance criteria.

In automatic mode, omitted task routing is an invalid plan: the runtime will not silently fall
back to Sol or guess an effort. If the user explicitly pins a model, every task uses that model and
a conflicting task model is rejected. The same rule applies to an explicit effort pin. Do not use
a weaker route merely to maximize concurrency. `luna` does not support `ultra`, and the runtime
rejects unknown models or unsupported model-effort combinations.

Prefer 3–5 substantial parallel tasks over many tiny tasks. Separate implementation from
independent verification when risk warrants it. Two tasks must not own the same write surface in
the same wave.

Write `{"tasks": [...]}` to a temporary JSON file outside the tracked tree, then persist it:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/orch.mjs" run plan <run-id> \
  --plan-file <temporary-plan-file> \
  --json
```

Then record a checkpoint summarizing the approved plan, model-routing rationale, important
decisions, risks, and first actions:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/orch.mjs" run checkpoint <run-id> \
  --summary "<what this plan does and why>" \
  --decision "<a choice a future supervisor must not silently reverse>" \
  --risk "<what could invalidate this route>" \
  --next "<the immediate next action>" \
  --json
```

This is not optional bookkeeping. The run record preserves what happened; only the checkpoint
preserves *why*, and it is what you get back after compaction. `run launch` refuses to dispatch
until a checkpoint covers the current plan revision.

For normal in-scope implementation work, approve your own plan and continue. Stop for the user only
when the plan requires destructive action, an external write, or material scope expansion.

## 4. Dispatch a wave

Get the ready queue:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/orch.mjs" run ready <run-id> --json
```

Select at most the run's remaining worker capacity. Launch each selected task:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/orch.mjs" run launch <run-id> <task-id> --json
```

Each launch creates an isolated Git worktree and starts one detached `codex exec` process with the
authoritative briefing, an output schema, the task's exact resolved `--model`, its resolved effort,
and the least sandbox needed for the task. The selected route, PID, files, worktree, and eventual
Codex thread id are stored in run state. Launch independent ready tasks without waiting between
them.

## 5. Monitor and collect

Remain responsive while workers run. Poll without blocking:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/orch.mjs" run poll <run-id> --json
```

Use the durable recovery view after compaction or interruption:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/orch.mjs" run resume <run-id> --json
```

This polls detached workers before returning the complete supervisor briefing, active handles,
results, checkpoints, and memory. Polling collects finished structured output into the task
automatically. A worker report is not completion. It is evidence awaiting supervisor verification.

## 6. Verify

For every reported task:

- inspect the actual diff or read-only evidence
- confirm the task stayed in scope
- run or independently confirm the declared checks
- evaluate every acceptance criterion
- check blockers, assumptions, and confidence

For read and verification tasks, record the supervisor verdict:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/orch.mjs" run verify <run-id> <task-id> \
  --verdict pass \
  --evidence "<specific check and outcome>" \
  --json
```

Use `--verdict fail` when the evidence is insufficient or the implementation is wrong. Retry a
failed or blocked task only after correcting its briefing or plan:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/orch.mjs" run retry <run-id> <task-id>
```

Do not mark a task complete merely because Codex said it was complete.

For write tasks, first inspect the isolated worktree:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/orch.mjs" run inspect <run-id> <task-id> --json
```

Require a clean worktree, at least one worker commit, exact agreement between reported and changed
files, and no out-of-scope paths. After independently confirming tests and acceptance criteria,
integrate it:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/orch.mjs" run integrate <run-id> <task-id> \
  --evidence "<specific check and outcome>" \
  --json
```

Integration cherry-picks the task commits onto the supervisor branch. Conflicts are aborted and
reported; never resolve them by silently discarding another worker's change.

## 7. Continue, replan, and checkpoint

Verified dependencies automatically unlock downstream tasks. Dispatch successive waves until every
task is verified, or until the run is genuinely blocked.

At each major wave boundary, record a compact checkpoint. Preserve decisions and evidence, not raw
logs:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/orch.mjs" run checkpoint <run-id> \
  --summary "<what this wave established>" \
  --decision "<decision made from the evidence>" \
  --risk "<open risk>" \
  --next "<next wave>" \
  --json
```

`run ready` reports the checkpoint as stale once tasks have completed since the last one, and
`run resume` marks a stale checkpoint in the briefing. If a task reveals that the plan is wrong,
stop dispatching dependent work, explain the conflict, revise the plan deliberately, and
checkpoint the change — a new plan revision blocks dispatch until it has its own checkpoint.

Retry transient worker failures once. Repeated failures, scope conflicts, missing authority, or an
unmet prerequisite are blockers; do not loop indefinitely.

## 8. Finish

Before reporting success:

- run the nearest full repository verification
- inspect the final combined diff
- confirm no worker or temporary orchestration artifact remains in the tracked tree
- remove completed isolated worktrees with `run cleanup <run-id>`
- update the ledger only with durable, confirmed facts and only when appropriate

When every task is complete, the run enters `finalizing`. Record the combined supervisor gate:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/orch.mjs" run finalize <run-id> \
  --verdict pass \
  --summary "<combined outcome>" \
  --evidence "<exact command and outcome>" \
  --json
```

Finalization refuses a dirty checkout, the wrong branch, branch drift outside the run, incomplete
tasks, or missing evidence. Use `--verdict fail` when the combined checks fail, then replan or
report the blocker. Only report success after the run status is `completed`.

Report the objective, task outcomes, important decisions, exact verification evidence, commits if
created, and any residual risk. Distinguish built, verified, and unverified work.

## Hard rules

- The Claude model running the main thread is always the planner, scheduler, reviewer, replanner,
  and integrator. Claude Opus and Claude Fable are both supported supervisors; the supervisor is
  whichever model owns this Claude Code session, and supervisory authority never moves to a
  subagent or to a worker.
- Execution workers use only `gpt-5.6-sol`, `gpt-5.6-terra`, or `gpt-5.6-luna`, exactly as
  resolved and persisted by the run plan. Never silently substitute another model or effort.
- Model and effort selection are the supervisor's planning responsibility unless the user
  explicitly pins either dimension. Automatic routing must never mean a hidden runtime fallback.
- Codex workers never self-assign global work or expand their scope.
- Every worker runs in its own isolated worktree.
- Never bypass the run state because the manual path seems faster.
- Never continue from memory alone when `run briefing` or `run recover` can restore exact state.
