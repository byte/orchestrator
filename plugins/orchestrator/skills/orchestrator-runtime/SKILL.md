---
name: orchestrator-runtime
description: Internal contract for the orchestrator CLI — how Claude supervises durable routed GPT-5.6 worker-pool runs and the legacy single-task bridge
user-invocable: false
---

# Orchestrator runtime

Helper: `node "${CLAUDE_PLUGIN_ROOT}/scripts/orch.mjs" <command>`

Commands: `preflight`, `init`, `lane`, `brief`, `accept`, `ledger`, `learn`, `run`.
All support `--json` where structured output is useful.

## Pool execution rules

- Everything here runs **inline in the main thread**. Never fork a general-purpose subagent
  to plan, manage, or evaluate a pool run. The main thread's existing context is part of the
  supervisor, and the supervisor is whichever Claude model owns the session (Opus or Fable).
- Use `run launch`; it starts detached Codex CLI workers on the task's saved `gpt-5.6-sol`,
  `gpt-5.6-terra`, or `gpt-5.6-luna` route with the saved effort, output schema, least sandbox,
  and isolated worktree. Never substitute a different route during recovery or retry.
- New runs auto-route by default. The supervisor must save an exact model, effort, and concise
  routing reason on each planned task unless the user explicitly pinned that dimension. The
  runtime rejects unresolved automatic routes and conflicts with explicit pins.
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
Run state version 5 stores the active provisional policy plus frozen task and attempt selections;
version-3 and version-4 runs remain readable and default to guidance disabled.

Derived learning records live separately under `.orchestrator/local/learning/`. Use `learn
collect` only after attempt outcomes exist. The base store is metadata-only and HMAC-addressed;
worker prose is never ground truth. `learn export` stays local and managed. Text export requires
named fields, user or supervisor consent, and the explicit sensitive-export acknowledgement.
`learn purge` removes matching samples, label history, and affected exports but never raw runs;
recollection can therefore recreate purged derived data.

## Legacy single-task bridge

`/orch:do` still composes with `codex:codex-rescue`. For that compatibility path:

- Always `brief` before dispatching so `accept` has a pre-dispatch snapshot.
- The upstream plugin's `--resume` is session-relative, not lane-addressed. Default to `--fresh`.
- A lane's bound `threadId` is a handoff pointer for direct `codex resume <thread-id>`.
- `accept` exits 2 for "needs review". That is a signal, not an error.

## Ledger discipline

Propose at most three entries per run, and only for things that will still be true next
month. Every entry is paid for on every future briefing.
