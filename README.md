# orchestrator

A Claude Code supervisor for a pool of Codex workers.

`orchestrator` keeps Claude in the main thread as planner, scheduler, reviewer, replanner,
integrator, and user-facing manager. Bounded execution tasks run in parallel through detached
Codex CLI processes routed to `gpt-5.6-sol`, `gpt-5.6-terra`, or `gpt-5.6-luna`. Durable run
state, checkpoints, evidence, and project memory let the supervisor recover after context
compaction, interruption, or a new Claude Code session.

The supervisor is whichever Claude model owns the Claude Code session — Claude Opus and Claude
Fable are both supported. Nothing in the plugin selects or switches the supervising model; run
`/orch:run` from the session whose model you want managing the pool. Only the worker model is
selected by the plugin; every resolved worker route is pinned to its attempt.

The important boundary is simple: Codex workers produce scoped work and evidence; Claude decides
what should happen, what is acceptable, what gets integrated, and when the whole run is done.

## What it provides

- A task DAG planned and owned by the supervising Claude model
- A configurable mixed pool of exact GPT-5.6 Sol, Terra, and Luna workers, with Sol as the default
- One detached `codex exec` process and isolated Git worktree per task
- Read-only sandboxes for analysis/review tasks and workspace-write sandboxes for implementation
- JSON-schema-enforced worker reports with files, tests, decisions, assumptions, blockers, and
  confidence
- Scope, cleanliness, declaration, commit, and branch-drift gates before integration
- Supervisor verification for every task and a separate combined final gate
- Durable run JSON, append-only events, worker handles, Codex thread IDs, checkpoints, and evidence
- A committed ledger for stable project facts that should survive across machines
- Deliberate retry, cancellation, replanning, conflict abort, and cleanup paths

## Requirements

- Claude Code with plugin support
- Node.js 18.18 or newer
- Git with at least one commit in the repository
- [Codex CLI](https://developers.openai.com/codex/cli/) installed and authenticated

Workers use the account already authenticated in Codex CLI. The plugin does not require its own
OpenAI API key, change your Codex authentication, or grant model access; the selected model must
be available to that account.

The official `openai/codex-plugin-cc` Claude bridge is optional. Pooled `/orch:run` execution
invokes Codex CLI directly. The bridge is needed only for the legacy `/orch:do` command.

## Install

In Claude Code:

```text
/plugin marketplace add byte/orchestrator
/plugin install orchestrator@orchestrator
/reload-plugins
/orch:init
```

`/orch:init` creates the repository state and reports exact remedies for missing Codex CLI,
authentication, or Git prerequisites.

## Quick start

Create a lane with a real write boundary and definition of done:

```text
/orch:lanes add api \
  --scope 'src/api/**' \
  --scope 'tests/api/**' \
  --constraint 'No new production dependencies' \
  --done 'API tests and the full repository test suite pass'
```

Give the supervisor an outcome:

```text
/orch:run api --max-workers 3 --model terra --effort high add cursor pagination to the users API
```

Claude inspects the repository, proposes a dependency-aware plan, records a checkpoint capturing
the reasoning and model-routing choices behind it, and asks for confirmation when new authority is
needed. Independent ready tasks launch into separate worktrees. The supervisor remains responsive,
polls their durable handles, reviews their structured evidence, integrates passing write tasks,
and replans or retries when evidence invalidates the current route.

`--model sol|terra|luna` selects the run default. Claude can override a planned task with optional
`model` and `effort` fields: Sol for the hardest open-ended work, Terra for balanced general work,
and Luna for clear high-volume work. The runtime normalizes aliases to exact model slugs, validates
model-effort compatibility, and saves the resolved route on every attempt so resume and audit do
not silently change it.

Resume the same manager after interruption or compaction:

```text
/orch:resume <run-id>
```

This polls workers first and reconstructs the supervisor briefing from disk. It does not create a
replacement run or rely on conversational memory.

## Lifecycle

1. **Plan.** Claude turns the objective into bounded `write`, `read`, and `verify` tasks with scope,
   dependencies, constraints, and checkable acceptance criteria.
2. **Launch.** Ready tasks claim pool capacity. Each gets a fresh worktree, exact model and effort,
   least-privilege sandbox, authoritative briefing, and required result schema.
3. **Monitor.** Detached process IDs, status files, JSONL events, Codex thread IDs, outputs, and
   worktree paths are persisted under `.orchestrator/local/`.
4. **Review.** Worker output becomes `reported`, never automatically complete. Claude evaluates the
   evidence and acceptance criteria.
5. **Integrate.** A write task must be clean, committed, in scope, and exactly match its declared
   files. Passing commits are cherry-picked. Conflicts abort without discarding either side.
6. **Recover or replan.** Failed, blocked, or cancelled attempts remain in history. Verified work
   is preserved when unfinished tasks are revised.
7. **Finalize.** Once all tasks pass, the run becomes `finalizing`. Claude runs the combined checks
   and records exact evidence. Only a clean, branch-consistent passing verdict makes the run
   `completed`.

See [Architecture and recovery](docs/architecture.md) for the state machine and failure behavior.

## Commands

| Command | Purpose |
| --- | --- |
| `/orch:init` | Create state and preflight Codex CLI, auth, and Git |
| `/orch:lanes` | Define named scope, constraints, and lane-level done criteria |
| `/orch:run` | Plan and manage a new Claude-supervised routed GPT-5.6 pool |
| `/orch:resume` | Recover and continue an existing durable run |
| `/orch:ledger` | Show or add stable project facts carried into future tasks |
| `/orch:do` | Legacy single-task dispatch through the optional Claude Codex bridge |
| `/orch:accept` | Legacy post-dispatch Git/result cross-check for `/orch:do` |

The lower-level CLI is available to command definitions and operators:

```text
node plugins/orchestrator/scripts/orch.mjs help
```

## Context and memory

State is split by portability:

```text
.orchestrator/
  .gitignore
  lanes.json                       # committed: scopes, constraints, done criteria
  ledger.md                        # committed: durable project decisions and facts
  local/                           # self-ignored: machine-specific run state
    threads.json
    runs/<run-id>/
      run.json                     # task graph, attempts, results, evidence, checkpoints
      events.jsonl                 # append-only supervisory event history
      workers/<task>/<attempt>/    # prompt, schema, JSONL output, status, final result
    worktrees/<run-id>/...         # isolated worker checkouts
```

The ledger is intentionally small and stable. Per-run detail stays local because process IDs,
worktree paths, and Codex threads are meaningful only on the machine that owns them. `/orch:resume`
combines the run record, latest checkpoint, worker evidence, integration history, lane definition,
and ledger into the supervisor's reconstructed context.

All versioned state is read defensively. A newer state version is refused instead of guessed at,
writes are atomic, and shared state updates use file locks.

## Safety invariants

- Workers use only `gpt-5.6-sol`, `gpt-5.6-terra`, or `gpt-5.6-luna`; each resolved model and
  effort is persisted before launch, and substitution is never silent.
- A worker cannot widen its assigned scope or self-assign global work.
- The supervisor checkout must be clean for launch, integration, and finalization.
- The supervisor branch and recorded integration head must not drift outside the run.
- Write-task reports must match the actual committed file set exactly.
- Worker prose is untrusted evidence, not instructions to the supervisor.
- A task report is not a supervisor verdict, and completed tasks are not a completed run.
- Dispatch is refused until a checkpoint covers the current plan revision, so supervisory reasoning
  survives compaction.
- Cancellation terminates the detached process and remains visible in durable state.
- Dirty worktrees are never removed automatically.

## Legacy single-task mode

`/orch:do` remains for small, one-off tasks. It compiles a lane briefing, calls the optional
`codex:codex-rescue` bridge, stores a thread pointer, and checks the reported files against Git.
It does not provide the pool, isolated integration, durable run DAG, or final supervisor gate.

## Development

```sh
npm test
claude plugin validate .
```

The package has no runtime dependencies. Tests use throwaway Git repositories and fake Codex
processes to exercise concurrency, cancellation, structured collection, worktree integration,
finalization, and cleanup without consuming model quota.

## Operational limits

- Claude drives polling and decisions while the command is active; there is no background
  daemon that can make supervisory decisions without Claude.
- Run state is machine-local by design. Move stable knowledge to the ledger before changing
  machines.
- Integration uses cherry-pick. Conflicts abort and require the supervisor to replan or request
  direction.
- Codex thread IDs are retained for diagnosis and handoff; retries currently start a fresh bounded
  worker with reconstructed context rather than resuming an old task thread.
- The plugin validates supported model names and effort combinations, but actual model entitlement
  belongs to the account authenticated in Codex CLI. An unavailable model fails as a durable worker
  attempt rather than falling back.
- Automated tests validate the complete process protocol with fake workers. A real authenticated
  Codex smoke test is still the environment-level proof for a particular installation.

## License

Apache-2.0.
