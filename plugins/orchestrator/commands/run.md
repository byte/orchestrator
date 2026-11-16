---
description: Automatically route and manage a Codex worker pool from the Claude Code main thread
argument-hint: "<what you want done> [lane] [--max-workers <n>] [--model <auto|astra|sol|terra|luna>] [--effort <auto|level>]"
allowed-tools: Read, Grep, Glob, Write, Bash(node:*), AskUserQuestion
---

Run a complete orchestration loop in the main Claude thread.

You are the supervisor. Plan the work, maintain the task graph and durable checkpoints,
dispatch a bounded pool of Codex workers, verify their evidence, replan when necessary, and
integrate the final result. Do not hand supervisory authority to a subagent.

Raw user request:
$ARGUMENTS

## 1. Parse and inspect

Expect plain language, not flags. Most invocations are a sentence describing an outcome, and the
user may not name a lane, a worker count, or a route at all. Extract what was given and derive the
rest; never answer a conversational request with flag syntax the user must retype.

Parse `--max-workers`, `--model`, and `--effort` with their values independently from the
remaining text. Flags never make the first positional token a lane. Treat the remaining text as
the objective unless the user unambiguously named a lane under the resolution rules below. For
example, in `/orchestrator:run --max-workers 3 add cursor pagination`, the objective is `add cursor
pagination`; `add` is not a lane merely because a pool flag is present. Model and effort both
default to `auto`, which means you must select them per task during planning. Treat explicit values
as user pins, not suggestions.

Inspect the relevant repository guidance and implementation before planning. Keep this inspection
in the main thread so the plan benefits from the user's conversation context.

### Resolving the lane

A lane is a durable write boundary, not a form the user must fill in first. Resolve it in this
order:

1. The user named an existing lane. Use it.
2. The objective clearly belongs to exactly one existing lane. Use it and say which one you chose.
3. No lane fits. Derive one from the objective and the repository: scope from the subsystem the
   work actually touches, standing constraints from the repository's own conventions, and a
   definition of done from how this repository is verified. Show the proposed lane in plain
   language, confirm it once, then create it with `lane add`.

Deriving and confirming a lane is not silent creation. What remains forbidden is creating a lane
the user never saw, widening an existing lane's scope to fit a task, or proceeding past a
confirmation the user declined. If the user rejects the proposal, adjust it — do not fall back to
telling them to run `lane add` themselves.

Ask only when an ambiguity would materially change the result or require new authority. Prefer
proposing a concrete answer to confirm over asking an open question.

## 2. Create the durable run

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/orch.mjs" run create <lane> \
  --objective "<objective>" \
  --max-workers <n> \
  --json
```

Pass `--max-workers` only when the user gave a worker count; the default pool is 5 concurrent
workers. Append `--model <astra|sol|terra|luna>` or `--effort <level>` only when the user explicitly
supplied that override. Omitted dimensions remain supervisor-routed. Keep the returned run id.

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
- `model`: `astra`, `sol`, `terra`, `luna`, or an exact slug (`gpt-6-astra`, `gpt-6.1-sol`,
  `gpt-6.1-terra`, `gpt-5.6-luna`) unless the run pins a model. Family names such as `gpt-6` or
  `gpt-6.1` are rejected because they do not name a tier.
- `effort`: the selected per-task reasoning effort unless the run pins an effort
- `routingReason`: one concise explanation of why the selected route fits the task whenever either
  dimension is supervisor-routed
- `timeoutMinutes` (optional): the task's wall-clock limit when the tier default in section 5 does
  not fit; exceeding it is reported, never enforced

Before routing, read what each route actually did in this repository:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/orch.mjs" run routes --lane <lane>
```

It is a read-only table over local run state: per actual model and effort, the finished attempts
that reached a worker, first-attempt acceptance, retries, and median duration. A substituted
attempt counts for the model that ran; a launch Codex rejected as unavailable counts for neither
model; answered input requests are part of their attempt, but the time paused awaiting an answer
is not counted in its duration; attempts on the retired `gpt-5.6-sol` and
`gpt-5.6-terra` slugs are left out unless you pass `--include-legacy`. Every rate sits next to its counts,
and no rate is printed below 5 samples, so a cell with two attempts is an anecdote, not a trend.
`run plan`, `run briefing`, and `run resume` print the same table for the run's lane once it holds
at least 5 counted attempts. Treat it as evidence, not a rule: it says nothing about tasks unlike
the ones that produced it. When it changed a route you would otherwise have chosen, cite it in
`routingReason` (for example, "terra/medium accepted 1/6 first attempts in this lane; routed to
sol").

Route by the demands of each bounded task:

- use `sol` by default for anything non-trivial: implementation, debugging, architecture, and
  security work
- use `terra` for well-bounded everyday coding and review whose shape is already clear
- use `astra` when a wrong result would be expensive or hard to catch: the hardest open-ended
  work, subtle concurrency or security reasoning, and deep independent verification
- use `luna` only for mechanical work whose acceptance criteria catch a bad result immediately,
  such as a rename the type checker or test suite fully exercises

There is no cap on `astra` tasks, but every `astra` route needs a `routingReason` that says why a
wrong result here would be expensive or hard to catch.

`luna` is a last resort. Its `routingReason` must say explicitly why the acceptance criteria would
catch a bad result immediately. The runtime rejects a `luna` route on any task that another task
depends on, unless the user pinned the whole run to `luna`, because a dependent builds on the
result before anyone can check it.

Select effort independently. Default to `high` on `sol` and `astra`. Go lower only with a stated
reason in `routingReason`, for example a bounded change whose checks are mechanical. Use `xhigh`,
`max`, or `ultra` when deeper reasoning should materially improve a hard result. On `terra` and
`luna`, choose the effort the bounded task needs and say why.

Independent `verify` tasks default to `astra` when the task under verification ran on `sol` or
below, so the check is made by a stronger reviewer than the author. Route a verifier lower only
with a stated reason, such as a purely mechanical check.

Escalate rather than economize when the task is uncertain or expensive to get wrong. Move one tier
up in model, effort, or both when any of these hold:

- the objective is ambiguous enough that a competent worker could reasonably build the wrong thing
- the write scope is broad, touches shared interfaces, or other tasks depend on the result
- the work is novel in this repository rather than a variation on something already present
- the acceptance criteria are hard to check mechanically, so a wrong result may survive review
- a previous attempt at this task already failed verification

The cheapest route is only cheapest when it succeeds. A task that fails verification costs an
entire wave plus the supervisor review that caught it, so a downgrade is worth taking only when
the task is genuinely bounded and its acceptance criteria would catch a bad result immediately.
State the escalation in `routingReason` when it decided the route.

In automatic mode, omitted task routing is an invalid plan: the runtime will not silently fall
back to a default model or guess an effort.
If the user explicitly pins a model, every task uses that model and a conflicting task model is
rejected. The same rule applies to an explicit effort pin. Do not use a weaker route merely to
maximize concurrency. Every model accepts every effort from `low` through `ultra`; the runtime
rejects unknown models and unknown efforts.

If Codex rejects a model as unavailable to this account, the runtime does not fail the task. It
relaunches one rung down the ladder `astra` → `sol` → `terra` → `luna`, keeping the effort, and
remembers the model as unavailable for the rest of the run so later launches go straight to the
substitute. The substitution is never silent: it is recorded on the attempt (requested and actual
model), appended as a run event, and shown by `run poll`, `run resume`, and the supervisor
briefing. A substituted user pin is flagged as such; tell the user which model actually ran. If no
rung is left, the task fails with a `model_unavailable` outcome for you to escalate. A task other
tasks depend on never falls to `luna` (the plan-time leaf rule), unless the run is pinned to it.
Only a rejection before the worker did anything counts: an error naming the model after work
began, or on a resume after `run answer`, is an ordinary failure. Runs saved by
0.5.x that route to `gpt-5.6-sol` or `gpt-5.6-terra` keep those exact slugs and are not substituted.

Size tasks by write-surface independence, not to a target count. Split work into separate tasks
where the pieces own disjoint paths and can be verified on their own; keep it as one task where the
pieces would touch the same files or interfaces, because two tasks must not own the same write
surface in the same wave. Prefer substantial tasks over many tiny ones: each task costs a briefing,
a worktree, and a review. A wave can run as many independent tasks as the pool allows (5 by
default); do not invent parallel tasks to fill it. Separate implementation from independent
verification when risk warrants it.

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
until a checkpoint covers the current plan and provisional-guidance revisions.

### Optional provisional guidance

Guidance is off by default. If the local learning store contains a supervisor- or user-reviewed
non-success outcome for this lane, the supervisor may explicitly enable fixed-template retry
guidance:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/orch.mjs" run guidance <run-id> \
  --mode provisional \
  --json
```

This can only add a bounded advisory block to a retry briefing. It cannot change model or effort,
scope, constraints, task state, policy, or supervisor authority, and it never copies objectives,
evidence, source, or worker prose. Enabling, disabling, or rolling back guidance makes the current
checkpoint stale; review the policy version and hash, then checkpoint before dispatch. Use
`--mode off` as the kill switch and `--rollback` to restore the previous exact policy snapshot.
Leave guidance off when no reviewed typed outcome exists; do not fabricate a source from a worker
self-report. A single explicit supervisor or user review is enough to enable this provisional
mode, but it is not a high-confidence or promoted policy; the supervisor must still review the
policy hash and checkpoint every changed selection before dispatch.

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
them. A launch response whose `substitution` is not null ran on a different model than the plan
named; read its notice.

## 5. Monitor and collect

Do not poll in a loop. After launching a wave, start one blocking wait as a **background** Bash
command (`run_in_background: true`):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/orch.mjs" run wait <run-id> --json
```

Then carry on with anything that does not depend on the running workers: verifying and
integrating work that was already reported, answering requests, checkpointing. Claude Code wakes
you when the background command exits, and `run wait` exits exactly when something needs you. Read
its output; it is the same payload `run poll` returns, so no second call is needed. The exit code
says why it returned:

- `0` — a worker changed state. Act on every update marked `"changed": true`: `reported` or
  `blocked` (review it, section 6), `failed` or `cancelled`, `needs_input` (answer it, section 6),
  `substituted` (read the notice; tell the user if a pin was overridden), a `running` update with
  `resumeFallback` (a warm resume fell back to a fresh thread; nothing to do but note it), or a
  `running` update with `overLimit` (see below). Updates without `changed` are context: workers
  still running, and paused workers still awaiting an answer (`awaitingAnswer: true`).
- `2` — timed out (default 30 minutes, `--timeout <seconds>`) with workers still running and
  nothing changed. Start another `run wait` if you have nothing else to do.
- `3` — no worker is running or paused. Dispatch the next ready wave, or finish.
- `4` — no worker is running and every remaining one is paused on a request. Nothing can change
  until you answer; `run wait` returns at once rather than blocking on you.

After handling a wake, start the next `run wait` whenever workers are still running, including
right after each `run launch` or `run answer`; keep exactly one wait in flight per run. `run wait`
polls once when it starts, so a change that landed while you were busy is returned at once, never
missed. Use `run poll <run-id> --json` only for a one-off look; it does not block.

Every task has a wall-clock limit: the plan's optional `timeoutMinutes`, else the default for the
model the attempt runs on (`astra` 120, `sol` 90, `terra` 60, `luna` 30 minutes). Set
`timeoutMinutes` in the plan for a task you expect to run unusually long or short. A worker past its
limit is reported once with `overLimit`; it is **not** stopped. Decide: keep waiting if the work is
plausibly still progressing (its `events.jsonl` keeps growing), or stop it with
`run cancel <run-id> <task-id> --reason "<why>"` and retry or replan. An answered request starts a
new clock, because time spent waiting for you is not the worker's.

Use the durable recovery view after compaction or interruption:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/orch.mjs" run resume <run-id> --json
```

This polls detached workers before returning the complete supervisor briefing, active handles,
results, checkpoints, provisional-guidance revisions and attempt snapshots, model substitutions,
and memory. After it, start a background `run wait` again if workers are still running; a wait
started before the interruption may have ended unseen. Polling (by `run wait`, `run poll`, or
`run resume`) collects finished structured output into the task automatically, and relaunches
a task whose model Codex rejected as unavailable; a poll update with status `substituted` names
the requested and actual model. A worker report is not completion. It is evidence awaiting
supervisor verification. A poll update with status `needs_input` is neither: the worker paused to
ask you something and is waiting for the answer described in section 6.

## 6. Verify

### Answer worker requests first

A worker no longer has to stop when it needs one adjacent file outside its scope or when its
objective admits two materially different readings. It returns `needs_input` with a typed request
instead: a `scope_extension` (exact paths and the reason) or a `question` (the question and the
options it sees). The task is then `needs_input`: paused, not finished, holding its pool slot, with
no outcome recorded. Answer it promptly; a paused worker does no work.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/orch.mjs" run answer <run-id> <task-id> \
  --grant-scope "<glob>" \
  --reply "<optional explanation>" \
  --json
```

Use exactly one decision: `--grant-scope <glob>` (repeatable, write tasks and scope requests only),
`--deny`, or `--reply <text>`. A `--reply` may accompany a grant or a denial to explain it. The same
attempt resumes on the same Codex thread, in the same worktree, on the model and effort the
attempt is actually using (a substituted model stays substituted) and the task's sandbox. The
resumed thread receives only your answer; if Codex no longer has the thread it falls back to a
fresh thread with the full briefing, which carries every answer so far.

Authority over a grant:

- You may grant an extension inside the lane on your own authority when the change is necessary,
  adjacent, and small. Prefer the narrowest grant that covers the request; a literal path is
  better than a glob.
- You must ask the user before granting anything outside the lane. The runtime refuses such a
  grant until you repeat it with `--user-approved`, which records that the user agreed.
- A grant belongs to the task, not the lane: the lane's scope and the task's planned scope stay
  unchanged, and `run inspect` and `run integrate` accept the granted paths for that task only.
  Everything else out of scope is still refused.
- The runtime refuses a grant that may overlap the write surface of another task that is running,
  paused, or reported but not yet integrated. Deny it, narrow it, or wait for that task.
- Deny when the change belongs to another task or would widen the task's purpose; say in
  `--reply` how the worker should proceed within scope.

Answer a question with `--reply`. Use `--deny` only when you cannot or will not choose; the worker
is then told to finish only what is unambiguous or report a blocker. If the question exposes a
genuinely ambiguous objective that the user must settle, ask the user, then reply.

A round trip is not a failed attempt and does not consume a retry: no new attempt is created, no
outcome is recorded, and learning data later sees the one outcome the attempt ends with. A task
gets at most 3 answered round trips; a further request is recorded as an ordinary blocker
(`worker_blocked` / `scope_required` or `ambiguous_objective`) for you to resolve by retry or
replan.

### Review reported work

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

Use `--verdict fail` when the evidence is insufficient or the implementation is wrong, and make
the evidence specific: it is handed to the worker on retry. Retry a failed or blocked task with a
note saying what to change:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/orch.mjs" run retry <run-id> <task-id> \
  --note "<what the worker must change>"
```

A retry is warm by default: when the previous attempt reached a result or a supervisor verdict and
left a Codex thread id, the next `run launch` resumes that thread on the attempt's own model,
effort, and sandbox, in the same worktree. Its briefing gains a "Previous attempt" section with the
outcome, your evidence, your note, and the files the attempt changed. The retry starts cold (a new
thread, a new worktree, the same "Previous attempt" section) when the previous attempt crashed,
returned no result, was cancelled, or has no thread id, or when you pass `--fresh`. Use `--fresh`
when the earlier thread is anchored on a wrong approach you want the worker to drop. After an
integration conflict the retry still resumes the thread but in a fresh worktree at the integrated
head, so the worker redoes the change against it. If Codex reports the thread as missing, the
launch falls back to a fresh thread with the same briefing and records `task.resume_fallback`.
A route change in a revised plan does not force a cold start; the resumed thread runs on the new
route. The "Previous attempt" section is ordinary briefing text, separate from the fixed-template
provisional guidance block in section 3, and does not loosen any guidance restriction.

Do not mark a task complete merely because Codex said it was complete.

For write tasks, first inspect the isolated worktree:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/orch.mjs" run inspect <run-id> <task-id> --json
```

Require a clean worktree, at least one worker commit, exact agreement between reported and changed
files, and no paths outside the task's planned scope plus any scope you granted it (`grantedScope`
in the inspection). After independently confirming tests and acceptance criteria,
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

Before dispatching the next wave, reconsider the routing of the tasks it will contain. The plan
routed them from the objective alone; a completed wave replaces that estimate with evidence. Re-route
a pending task when the wave showed that:

- the area is more entangled, more novel, or less well covered by tests than the plan assumed
- a dependency landed a design that makes the downstream task harder or easier than planned
- a task at the same tier already failed verification for reasons of depth rather than briefing
- the work turned out to be mechanical, and a lower tier now clearly suffices

Revise routes with the same `run plan` call, resubmitting the full task list with the routes
changed and an updated `routingReason` naming the evidence. The runtime refuses a revision while any
task is active or reported, preserves completed tasks unchanged, and rejects any attempt to redefine
or drop one, so only pending work can move. Re-routing bumps the plan revision and therefore
requires its own checkpoint before the next dispatch.

Do not re-route to work around a bad briefing. If the worker failed because the task was
underspecified, out of scope, or missing context, fix the briefing and retry at the same route; a
higher tier does not repair an unclear objective.

`run ready` reports the checkpoint as stale once tasks have completed since the last one, and
`run resume` marks a stale checkpoint in the briefing. If a task reveals that the plan is wrong,
stop dispatching dependent work, explain the conflict, revise the plan deliberately, and
checkpoint the change — a new plan revision blocks dispatch until it has its own checkpoint.

Retry transient worker failures (a crash, a missing result) once; that retry starts cold. Retry a
failed verification or a rejected integration warm, with a `--note` that names what to change.
When two warm retries of the same task have failed, stop retrying at that route: escalate it one
tier (`luna` → `terra` → `sol` → `astra`) in a revised plan with a `routingReason` that cites the
failures, or treat it as a blocker if the evidence points at the briefing rather than the tier.
`run retry` prints this advice once the count is reached. Answered `needs_input` round trips are
not retries and do not count toward this. Scope conflicts, missing authority, or an unmet
prerequisite are blockers; do not loop indefinitely.

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
  and integrator. Claude Opus 5.5 and Claude Fable 5.2 are the supported supervisors; the
  supervisor is whichever model owns this Claude Code session, the plugin never selects it, and
  supervisory authority never moves to a subagent or to a worker.
- Execution workers use only `gpt-6-astra`, `gpt-6.1-sol`, `gpt-6.1-terra`, or `gpt-5.6-luna`,
  exactly as resolved and persisted by the run plan. Runs saved by 0.5.x keep their persisted
  `gpt-5.6-sol` or `gpt-5.6-terra` slugs. Never substitute a model or effort silently: the only
  substitution is the runtime's recorded fallback when Codex rejects a model as unavailable.
- Model and effort selection are the supervisor's planning responsibility unless the user
  explicitly pins either dimension. Automatic routing must never mean a hidden runtime fallback.
- Routing is a revisable judgment, not a one-time commitment: re-route pending tasks through
  `run plan` when a completed wave contradicts the assumptions the original route was based on.
- Codex workers never self-assign global work or expand their scope. They may ask for a scope
  extension; only the supervisor (inside the lane) or the user (outside it) can grant one, and it
  is granted to that task alone.
- Every task runs in its own isolated worktree; a warm retry continues in that task's previous
  worktree unless integration failed on a conflict.
- Never bypass the run state because the manual path seems faster.
- Wait for workers with one background `run wait`, never with a loop of `run poll` calls or
  sleeps. A worker over its wall-clock limit is stopped only by your explicit `run cancel`.
- Never continue from memory alone when `run briefing` or `run recover` can restore exact state.
