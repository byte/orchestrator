---
description: Have Claude Fable plan and manage a pool of GPT-5.6-sol Codex workers
argument-hint: "<lane> [--max-workers <n>] [--effort <level>] <objective>"
allowed-tools: Read, Grep, Glob, Write, Bash(node:*), Agent, AskUserQuestion
---

Run a complete orchestration loop in the main Claude thread.

You are the supervisor. Plan the work, maintain the task graph and durable checkpoints,
dispatch a bounded pool of Codex workers, verify their evidence, replan when necessary, and
integrate the final result. Do not hand supervisory authority to a subagent.

Raw user request:
$ARGUMENTS

## 1. Parse and inspect

The first positional token is the lane. `--max-workers` and `--effort` configure the pool;
everything else is the objective.

Inspect the relevant repository guidance and implementation before planning. Keep this inspection
in the main thread so the plan benefits from the user's conversation context.

Do not silently create a missing lane or widen its scope. Ask only when an ambiguity would
materially change the result or require new authority.

## 2. Create the durable run

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/orch.mjs" run create <lane> \
  --objective "<objective>" \
  --max-workers <n> \
  --effort <level> \
  --json
```

The run pins every worker to `gpt-5.6-sol`. Keep the returned run id.

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

Prefer 3–5 substantial parallel tasks over many tiny tasks. Separate implementation from
independent verification when risk warrants it. Two tasks must not own the same write surface in
the same wave.

Write `{"tasks": [...]}` to a temporary JSON file outside the tracked tree, then persist it:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/orch.mjs" run plan <run-id> \
  --plan-file <temporary-plan-file> \
  --json
```

Record a checkpoint summarizing the approved plan, important decisions, risks, and first actions.
For normal in-scope implementation work, approve your own plan and continue. Stop for the user only
when the plan requires destructive action, an external write, or material scope expansion.

## 4. Dispatch a wave

Get the ready queue:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/orch.mjs" run ready <run-id> --json
```

Select at most the run's remaining worker capacity. Claim each selected task:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/orch.mjs" run claim <run-id> <task-id> --json
```

Each claim returns the authoritative briefing and routing flags. Invoke one
`codex:codex-rescue` Agent per claim, concurrently, using:

- the returned briefing as the prompt
- `--fresh`
- `--model gpt-5.6-sol`
- the returned `--effort`
- Claude Agent background execution so the main thread remains available

Do not pass the upstream `--background` flag. The Claude Agent is the background container; the
Codex rescue should wait for its Codex result so the supervisor receives the full worker output.

Immediately bind the Claude agent id:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/orch.mjs" run bind <run-id> <task-id> \
  --attempt <attempt-id> \
  --agent-id <agent-id>
```

If the worker later reports an upstream Codex job or thread id, bind those too. Never invent an id.

## 5. Monitor and collect

Remain responsive while workers run. Use the Agent task handles to inspect or steer workers.
Use the durable recovery view after compaction or interruption:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/orch.mjs" run recover <run-id> --json
node "${CLAUDE_PLUGIN_ROOT}/scripts/orch.mjs" run briefing <run-id>
```

When a worker finishes, write its complete output to a temporary file outside the tracked tree and
record it:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/orch.mjs" run report <run-id> <task-id> \
  --attempt <attempt-id> \
  --result-file <worker-output-file> \
  --json
```

A worker report is not completion. It is evidence awaiting supervisor verification.

## 6. Verify

For every reported task:

- inspect the actual diff or read-only evidence
- confirm the task stayed in scope
- run or independently confirm the declared checks
- evaluate every acceptance criterion
- check blockers, assumptions, and confidence

Then record the supervisor verdict:

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

## 7. Continue, replan, and checkpoint

Verified dependencies automatically unlock downstream tasks. Dispatch successive waves until every
task is verified, or until the run is genuinely blocked.

At each major wave boundary, record a compact checkpoint. Preserve decisions and evidence, not raw
logs. If a task reveals that the plan is wrong, stop dispatching dependent work, explain the
conflict, revise the plan deliberately, and checkpoint the change.

Retry transient worker failures once. Repeated failures, scope conflicts, missing authority, or an
unmet prerequisite are blockers; do not loop indefinitely.

## 8. Finish

Before reporting success:

- ensure the run status is `completed`
- run the nearest full repository verification
- inspect the final combined diff
- confirm no worker or temporary orchestration artifact remains in the tracked tree
- update the ledger only with durable, confirmed facts and only when appropriate

Report the objective, task outcomes, important decisions, exact verification evidence, commits if
created, and any residual risk. Distinguish built, verified, and unverified work.

## Hard rules

- Claude Fable is always the planner, scheduler, reviewer, replanner, and integrator.
- All execution workers use `gpt-5.6-sol`; do not silently substitute another model.
- Codex workers never self-assign global work or expand their scope.
- Never run overlapping write tasks in one checkout.
- Never bypass the run state because the manual path seems faster.
- Never continue from memory alone when `run briefing` or `run recover` can restore exact state.
