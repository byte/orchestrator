# Changelog

## 0.2.0

Claude Fable can now supervise a durable pool of Codex workers inside Claude Code.

- `/orch:run` plans a task DAG, confirms it, and manages bounded workers pinned to
  `gpt-5.6-sol`
- Detached `codex exec` processes use saved reasoning effort, least-privilege sandboxes,
  required JSON output, durable process/thread handles, and configurable pool capacity
- Every task receives an isolated Git worktree; write integration requires clean commits,
  exact file declarations, in-scope changes, and an unchanged supervisor branch
- Worker reports remain untrusted evidence until Fable verifies read tasks or integrates
  passing write tasks
- `/orch:resume` polls active workers and reconstructs Fable's full managerial context from
  run state, checkpoints, evidence, integration history, lanes, and the ledger
- Completed task graphs enter `finalizing`; a separate clean, branch-consistent combined
  verification record is required before a run becomes `completed`
- Explicit retry, cancellation, replanning, conflict abort, branch-drift refusal, and safe
  worktree cleanup paths preserve history without silently discarding work
- End-to-end tests cover concurrent detached workers and the full write-worker lifecycle
  without consuming model quota

The official Claude Codex bridge is now optional for pooled execution and remains supported
for legacy `/orch:do` dispatch.

## 0.1.0

Initial release.

- `/orch:init` — set up `.orchestrator/` and preflight the Codex toolchain
- `/orch:lanes` — named workstreams with scope patterns, standing constraints, and a
  definition of done
- `/orch:do` — compile a briefing, delegate to Codex via `/codex:rescue`, bind the returned
  thread, and check the result
- `/orch:ledger` — durable project facts carried into every briefing
- `/orch:accept` — re-check a lane's working tree against what Codex reported

Lane definitions and the ledger are committed; thread bindings and pre-dispatch snapshots
stay machine-local under `.orchestrator/local/`.
