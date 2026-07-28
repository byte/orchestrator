---
name: orchestrator-runtime
description: Internal contract for the orchestrator CLI — how Claude supervises durable routed GPT-5.6 worker-pool runs and the legacy single-task bridge
user-invocable: false
---

# Orchestrator runtime

Helper: `node "${CLAUDE_PLUGIN_ROOT}/scripts/orch.mjs" <command>`

Commands: `preflight`, `init`, `lane`, `brief`, `accept`, `ledger`, `run`.
All support `--json` where structured output is useful.

## Pool execution rules

- Everything here runs **inline in the main thread**. Never fork a general-purpose subagent
  to plan, manage, or evaluate a pool run. The main thread's existing context is part of the
  supervisor, and the supervisor is whichever Claude model owns the session (Opus or Fable).
- Use `run launch`; it starts detached Codex CLI workers on the task's saved `gpt-5.6-sol`,
  `gpt-5.6-terra`, or `gpt-5.6-luna` route with the saved effort, output schema, least sandbox,
  and isolated worktree. Never substitute a different route during recovery or retry.
- Use `run resume` after interruption or compaction. It polls workers and reconstructs the
  briefing from durable state. Never continue from conversation memory alone.
- Use `run checkpoint` after approving a plan and at every wave boundary. `run launch` refuses to
  dispatch until a checkpoint covers the current plan revision, because the run record preserves
  what happened and only the checkpoint preserves why.
- A report is not completion. Verify read tasks directly; inspect and integrate write worktrees.
- The run is not complete when its tasks finish. Run the combined checks and use `run finalize`
  with exact evidence. Finalization is the user-facing success gate.

## Durable state

Run JSON, events, worker status, structured results, PIDs, Codex thread ids, worktree pointers,
checkpoints, verification evidence, and integration commits live under the self-ignored
`.orchestrator/local/runs/`. The committed ledger carries durable project facts across machines.

## Legacy single-task bridge

`/orch:do` still composes with `codex:codex-rescue`. For that compatibility path:

- Always `brief` before dispatching so `accept` has a pre-dispatch snapshot.
- The upstream plugin's `--resume` is session-relative, not lane-addressed. Default to `--fresh`.
- A lane's bound `threadId` is a handoff pointer for direct `codex resume <thread-id>`.
- `accept` exits 2 for "needs review". That is a signal, not an error.

## Ledger discipline

Propose at most three entries per run, and only for things that will still be true next
month. Every entry is paid for on every future briefing.
