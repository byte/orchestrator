---
name: orchestrator-runtime
description: Internal contract for the orchestrator CLI — how Claude supervises durable routed Codex worker-pool runs
user-invocable: false
---

# Orchestrator runtime

Helper: `node "${CLAUDE_PLUGIN_ROOT}/scripts/orch.mjs" <command>`

Commands: `preflight`, `init`, `lane`, `ledger`, `learn`, `run`.
All support `--json` where structured output is useful.

## Pool execution rules

- Everything here runs **inline in the main thread**. Never fork a general-purpose subagent
  to plan, manage, or evaluate a pool run. The main thread's existing context is part of the
  supervisor, and the supervisor is whichever Claude model owns the session (Opus or Fable).
- Use `run launch`; it starts detached Codex CLI workers on the task's saved `gpt-6-astra`,
  `gpt-6.1-sol`, `gpt-6.1-terra`, or `gpt-5.6-luna` route (or a 0.5.x run's persisted
  `gpt-5.6-sol`/`gpt-5.6-terra` slug) with the saved effort, output schema, least sandbox, and
  isolated worktree. Never substitute a route yourself during recovery or retry.
- When Codex rejects a model as unavailable to the account, `run poll` and `run resume` relaunch
  the task one rung down `astra` → `sol` → `terra` → `luna` with the same effort and record the
  substitution on the attempt, in the run events, and in the briefing. Substitution is never
  silent. A substituted user pin is flagged; tell the user. An exhausted ladder fails the task
  with a `model_unavailable` outcome.
- `run retry <run-id> <task-id> [--note <text>] [--fresh]` is warm by default: when the previous
  attempt reached a result or verdict and has a thread id, the next `run launch` resumes that
  Codex thread with the attempt's own model, effort, and sandbox, in the previous worktree (a
  fresh worktree after an integration conflict). Crashes, missing results, cancellations, missing
  thread ids, and `--fresh` start cold. Every retry briefing gets a "Previous attempt" section with
  the outcome, supervisor evidence, note, and changed files; it is ordinary briefing text, not
  guidance. A thread Codex no longer has falls back to a fresh thread with a
  `task.resume_fallback` event. After two failed warm retries, escalate one tier instead.
- A worker that needs one adjacent file outside its scope, or faces an objective with two
  materially different readings, returns `needs_input` (a `scope_extension` with paths and a
  reason, or a `question` with the options it sees) instead of stopping. `run poll` reports the
  task as `needs_input`; it is paused, not finished, keeps its pool slot, and has no outcome.
  Answer with `run answer <run-id> <task-id>` and exactly one of `--grant-scope <glob>`
  (repeatable), `--deny`, or `--reply <text>` (a reply may accompany a grant or denial). The same
  attempt resumes on the same Codex thread, in the same worktree, with the attempt's own model,
  effort, and sandbox. A grant belongs to the task, never the lane, and inspection and integration
  honour it; it is refused when it may overlap another running, paused, or unintegrated task's
  write surface. Grant inside the lane on your own authority; a grant outside the lane is refused
  until you ask the user and repeat it with `--user-approved`. A task gets at most 3 answered round
  trips; a further request is recorded as an ordinary blocker.
- Wait for workers with `run wait <run-id> [--timeout <seconds>] --json` started as a background
  Bash command, never by calling `run poll` in a loop. It blocks until a worker changes state —
  finishes, fails, is cancelled, pauses with `needs_input`, is relaunched on a substitute model,
  falls back from a missing thread, or exceeds its wall-clock limit — then prints the `run poll`
  payload (changed updates carry `"changed": true`) and exits; the harness then wakes the
  supervisor. Exit codes: `0` changed, `2` timed out (default 1800 s), `3` no worker running or
  paused, `4` only paused workers awaiting an answer, `1` error. It returns at once when a change is
  already on disk. It watches the worker directories with `fs.watch` and falls back to a poll every
  15 s (`--interval`), so a missed file event only delays the wake. Keep one wait in flight per
  run. `run poll` remains for a one-off, non-blocking look.
- Each task has a wall-clock limit: plan field `timeoutMinutes`, else 120 (`astra`), 90 (`sol`),
  60 (`terra`), or 30 (`luna`) minutes for the model the attempt runs on. An over-limit worker is
  reported once (`overLimit`, `task.over_limit` event, OVER LIMIT in the briefing) and never
  stopped by the runtime; stopping it is the supervisor's call through `run cancel`.
- New runs auto-route by default. The supervisor must save an exact model, effort, and concise
  routing reason on each planned task unless the user explicitly pinned that dimension. The
  runtime rejects unresolved automatic routes and conflicts with explicit pins.
- Before routing, read `run routes [--lane <lane>] [--include-legacy] [--json]`: a read-only
  table over local run state of finished attempts per actual model and effort, with first-attempt
  acceptance, retries, substitutes, and median duration. Attempts count for the model they ran
  on; a launch Codex rejected as unavailable counts for neither model; answered `needs_input`
  rounds are part of their attempt; retired `gpt-5.6-sol`/`gpt-5.6-terra` attempts are excluded
  unless `--include-legacy`. No rate is printed below 5 samples. `run plan`, `run briefing`, and
  `run resume` show the lane's table once it has at least 5 counted attempts. It is evidence, not
  a rule; cite it in `routingReason` when it changed a route. It never reads the learning store.
- New runs default to 5 concurrent workers (`run create --max-workers <n>`). Size tasks by
  write-surface independence; do not invent tasks to fill the pool.
- Use `run resume` after interruption or compaction. It polls workers and reconstructs the
  briefing from durable state. Never continue from conversation memory alone.
- Use `run checkpoint` after approving a plan and at every wave boundary. `run launch` refuses to
  dispatch until a checkpoint covers the current plan and guidance revisions, because the run
  record preserves what happened and only the checkpoint preserves why.
- Provisional guidance is opt-in with `run guidance <run-id> --mode provisional`. Compile it only
  from supervisor- or user-reviewed typed outcomes. One explicit review is sufficient only for
  this provisional mode; it is not confirmed or promotion evidence. Enabling, disabling, rolling
  back, or retry-selecting guidance invalidates the checkpoint; review the selected policy and
  checkpoint it before dispatch.
- A policy version name is immutable within a run. If reviewed sources produce a different policy
  hash, use a new `--policy-version`; never rebind an archived or active version name.
- Guidance is advisory briefing text only. It cannot alter routes, pins, scope, constraints,
  lifecycle state, policy, or supervisor authority. Use `--mode off` as the kill switch and
  `--rollback` to restore the previous exact policy snapshot.
- The learned guidance block accepts only fixed templates and typed metadata. This restriction
  does not remove the run objective, assignment, scope, constraints, acceptance criteria,
  dependency context, or other ordinary sections from the worker briefing.
- A report is not completion. Verify read tasks directly; inspect and integrate write worktrees.
- Newly terminal attempts carry a versioned outcome separate from lifecycle state. Use `run decide`
  for explicit policy refusal, authority escalation, or a terminal integration failure; never infer
  policy or authority boundaries from worker prose.
- The run is not complete when its tasks finish. Run the combined checks and use `run finalize`
  with exact evidence. Finalization is the user-facing success gate.

## Durable state

Run JSON, events, worker status, structured results, PIDs, Codex thread ids, worktree pointers,
checkpoints, terminal attempt outcomes, verification evidence, and integration commits live under the self-ignored
`.orchestrator/local/runs/`. The committed ledger carries durable project facts across machines.
Run state version 6 adds the current model roster, the models found unavailable during the run,
per-attempt substitution records, optional warm-retry fields (`attempt.review`,
`attempt.retry`, `attempt.resumedFromAttemptId`, `attempt.resumeFallback`, `task.pendingRetry`),
optional worker-request fields (`attempt.inputRequests`, `task.scopeGrants`, the
`needs_input` task and attempt status), and optional wall-clock fields (`task.timeoutMinutes`,
`attempt.overLimit`). Version 5 stores the active provisional policy plus frozen
task and attempt selections; version-3 through version-5 runs remain readable, keep their
persisted exact slugs, and version-3 and version-4 runs default to guidance disabled.

Derived learning records live separately under `.orchestrator/local/learning/`. Use `learn
collect` only after attempt outcomes exist. The base store is metadata-only and HMAC-addressed;
worker prose is never ground truth. `learn export` stays local and managed. Text export requires
named fields, user or supervisor consent, and the explicit sensitive-export acknowledgement.
`learn purge` removes matching samples, label history, and affected exports but never raw runs;
recollection can therefore recreate purged derived data.

## Ledger discipline

Propose at most three entries per run, and only for things that will still be true next
month. Every entry is paid for on every future briefing.
