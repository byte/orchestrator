# Architecture and recovery

## Authority model

The Claude Code main thread is the control plane. Claude Fable owns:

- goal interpretation and plan approval
- task boundaries, dependencies, priority, and pool capacity
- worker monitoring and cancellation
- evidence review and acceptance decisions
- integration order and conflict response
- replanning, checkpoints, final verification, and the user report

Codex workers are data-plane executors. A worker receives one bounded task, repository context,
completed-dependency summaries, lane constraints, durable ledger facts, and an output schema. It
may not spawn a subordinate pool, widen scope, integrate other work, or alter orchestration state.

## Run and task state machines

The run progresses through:

```text
planning -> ready -> running -> verifying -> ready
                                      \-> blocked | failed
all tasks completed -> finalizing -> completed | failed
any non-completed work -> cancelled
```

A task progresses through:

```text
pending -> dispatching -> running -> reported -> completed
                              \-> blocked | failed | cancelled
blocked | failed | cancelled -> pending (explicit retry)
```

`reported` means a structured worker result exists. It is deliberately separate from
`completed`. Read and verification tasks require a supervisor verdict. Write tasks require
worktree inspection and integration, which records the supervisor verdict and commit evidence
together.

## Task dispatch

`run launch` performs these steps:

1. Lock and claim a ready task while enforcing `maxWorkers`.
2. Require a committed, clean supervisor checkout on the run's branch and integration head.
3. Create `.orchestrator/local/worktrees/<run>/<task-attempt>` and a dedicated task branch.
4. Write the prompt, JSON schema, worker specification, output paths, and status path.
5. Spawn a detached Node wrapper.
6. The wrapper invokes:

   ```text
   codex exec -C <worktree> \
     --model gpt-5.6-sol \
     -c model_reasoning_effort="<saved effort>" \
     --sandbox <read-only|workspace-write> \
     --json \
     --output-schema <schema> \
     --output-last-message <result> -
   ```

7. Persist the wrapper PID immediately, then the Codex thread ID when `thread.started` arrives.

The wrapper owns signal forwarding and atomic status updates. Claude never needs to block on a
worker process.

## Collection and integration

`run poll` reads status files for active tasks. Successful final JSON is recorded as task
evidence; malformed output, a non-zero exit, or a missing result becomes a failed attempt.

For write tasks, `run inspect` checks:

- the worktree has no uncommitted changes
- at least one task commit exists
- every changed path matches task scope
- every changed path was declared by the worker
- every declared path actually changed

`run integrate` repeats the safety checks, confirms the supervisor checkout has not moved, and
cherry-picks the worker commits. A conflict triggers `cherry-pick --abort`; it never resets,
overwrites, or silently chooses a side.

## Finalization

Completing every task moves the run to `finalizing`, not `completed`. `run finalize` requires:

- all planned tasks completed
- an explicit `pass` or `fail` verdict
- a non-empty summary and concrete evidence
- the original supervisor branch
- a clean supervisor checkout
- the exact integration head recorded by the run

A passing record is tied to the current plan revision and head. Replacing the unfinished plan
clears prior finalization.

## Recovery protocol

`run resume` first polls all durable worker handles. It then returns:

- current run and task status
- process, status-file, thread, and worktree handles
- worker summaries, checks, blockers, confidence, and attempts
- supervisor evidence and integrated commits
- repository base and integration head
- latest checkpoint
- lane constraints and done criteria
- durable ledger facts

The generated supervisor briefing explicitly treats stored worker prose as untrusted evidence.
Fable continues the existing run rather than inventing a replacement from conversation memory.

## Failure behavior

| Failure | Durable outcome | Recovery |
| --- | --- | --- |
| Codex process exits non-zero | Task `failed`, stderr tail retained | Inspect, then explicit retry or replan |
| Worker reports blockers | Task `blocked`, structured result retained | Expand authorized scope, resolve prerequisite, or replan |
| Malformed result | Task `failed` | Retry once if transient; otherwise report |
| Scope/declaration mismatch | Integration refused | Reject result and replan; do not cherry-pick |
| Dirty worker checkout | Inspection and cleanup refused | Ask worker/reviewer to resolve or preserve for diagnosis |
| Cherry-pick conflict | Cherry-pick aborted | Replan integration order or create a bounded conflict task |
| Supervisor branch drift | Launch/integration/finalization refused | Reconcile external commit deliberately |
| Claude interruption | Workers and state remain on disk | `/orch:resume <run-id>` |
| User cancellation | Child and wrapper receive termination; state cancelled | Inspect retained artifacts, retry only explicitly |

## Portability and retention

Lane definitions and the ledger are committed. Runs, process handles, worktrees, and raw worker
outputs are local and ignored. This prevents machine-specific paths and model transcripts from
entering Git while keeping stable project knowledge reviewable.

Completed worktrees can be removed with `run cleanup`. The command skips non-terminal tasks and
refuses dirty worktrees. Run JSON, event history, and worker outputs remain available for audit.
