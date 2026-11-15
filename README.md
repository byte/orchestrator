# orchestrator

A Claude Code supervisor for a pool of Codex workers.

`orchestrator` keeps Claude in the main thread as planner, scheduler, reviewer, replanner,
integrator, and user-facing manager. Bounded execution tasks run in parallel through detached
Codex CLI processes routed to `gpt-6-astra`, `gpt-6.1-sol`, `gpt-6.1-terra`, or `gpt-5.6-luna`.
Durable run
state, checkpoints, evidence, and project memory let the supervisor recover after context
compaction, interruption, or a new Claude Code session.

The supervisor is whichever Claude model owns the Claude Code session — Claude Opus and Claude
Fable are both supported, specifically Claude Opus 5.5 and Claude Fable 5.2.
Nothing in the plugin selects or switches the supervising model; run
`/orchestrator:run` from the session whose model you want managing the pool. Only the worker
model is selected by the plugin; every resolved worker route is pinned to its attempt.

The important boundary is simple: Codex workers produce scoped work and evidence; Claude decides
what should happen, what is acceptable, what gets integrated, and when the whole run is done.

## What it provides

- A task DAG planned and owned by the supervising Claude model
- A supervisor-routed mixed pool of exact Astra, Sol, Terra, and Luna workers
- Recorded, never-silent fallback down the model ladder when Codex rejects a model as unavailable
- One detached `codex exec` process and isolated Git worktree per task
- Read-only sandboxes for analysis/review tasks and workspace-write sandboxes for implementation
- JSON-schema-enforced worker reports with files, tests, decisions, assumptions, blockers, and
  confidence
- Versioned terminal attempt outcomes that distinguish execution, contract, verification, policy,
  authority, integration, cancellation, and acceptance decisions
- Scope, cleanliness, declaration, commit, and branch-drift gates before integration
- Supervisor verification for every task and a separate combined final gate
- Durable run JSON, append-only events, worker handles, Codex thread IDs, checkpoints, and evidence
- A private, local-only learning store derived from allowlisted run metadata, with managed exports
  and complete derived-data purge controls
- Opt-in provisional guidance compiled only from reviewed typed outcomes, with fixed templates,
  bounded briefing injection, durable replay, and one-command disable or rollback
- A committed ledger for stable project facts that should survive across machines
- Deliberate retry, cancellation, replanning, conflict abort, and cleanup paths

## Requirements

- Claude Code with plugin support
- Node.js 18.18 or newer
- Git with at least one commit in the repository
- [Codex CLI](https://developers.openai.com/codex/cli/) installed and authenticated

Workers use the account already authenticated in Codex CLI. The plugin does not require its own
OpenAI API key, change your Codex authentication, or grant model access; the selected model must
be available to that account. If it is not, the runtime substitutes the next model down the ladder
and records that it did; see the routing section below.

`/orchestrator:run` invokes Codex CLI directly. No Claude-side Codex plugin is needed.

## Install

### From GitHub

In Claude Code:

```text
/plugin marketplace add byte/orchestrator
/plugin install orchestrator@orchestrator
/reload-plugins
/orchestrator:init
```

This installs whatever is on the marketplace repository's default branch, which is not necessarily
the newest local work.

### From a local checkout

Point the marketplace at the working copy instead of GitHub. Use this to run unreleased changes, or
to develop the plugin itself:

```text
/plugin marketplace add /absolute/path/to/orchestrator
/plugin install orchestrator@orchestrator
/reload-plugins
/orchestrator:init
```

The path must be the repository root — the directory holding `.claude-plugin/marketplace.json`,
not `plugins/orchestrator`. Claude Code records it as a `directory` marketplace source.

Installing **copies** the plugin into `~/.claude/plugins/cache/orchestrator/orchestrator/<version>`.
The install is a snapshot, not a live link to the checkout, so editing files in the repository does
not change the installed plugin. After changing plugin sources, refresh the marketplace and
reinstall:

```text
/plugin marketplace update orchestrator
/plugin install orchestrator@orchestrator
/reload-plugins
```

Because the cache path contains the version, a stale install can sit alongside a much newer
checkout. Check what is actually installed:

```bash
cat ~/.claude/plugins/installed_plugins.json
```

If the recorded `version` is behind `plugins/orchestrator/.claude-plugin/plugin.json`, reinstall
before assuming a fix is live.

### Verify

`/orchestrator:init` creates the repository state and reports exact remedies for missing Codex CLI,
authentication, or Git prerequisites. Run it inside the repository you want orchestrated, not
inside this plugin's own checkout.

If `/orchestrator:*` commands do not appear after installing, run `/reload-plugins`, then confirm
the marketplace and plugin are both registered:

```bash
cat ~/.claude/plugins/known_marketplaces.json
```

## Quick start

Tell it what you want done:

```text
/orchestrator:run add cursor pagination to the users API
```

That is the whole interface. Claude reads the repository, works out which subsystem the objective
touches, and proposes a lane — the write boundary, standing constraints, and definition of
done — for you to confirm. You do not have to define one first.

From there Claude proposes a dependency-aware plan, records a checkpoint capturing the reasoning
and model-routing choices behind it, and asks for confirmation when new authority is needed.
Independent ready tasks launch into separate worktrees. The supervisor remains responsive, polls
their durable handles, reviews their structured evidence, integrates passing write tasks, and
replans or retries when evidence invalidates the current route.

Model and effort are automatic by default. During planning, Fable or Opus must assign every task
an exact `model`, `effort`, and concise `routingReason`:

| Alias | Exact slug | Use it for |
| --- | --- | --- |
| `astra` | `gpt-6-astra` | Work where a wrong result is expensive or hard to catch, and deep verification |
| `sol` | `gpt-6.1-sol` | The default for anything non-trivial: implementation, debugging, architecture |
| `terra` | `gpt-6.1-terra` | Well-bounded everyday coding and review |
| `luna` | `gpt-5.6-luna` | Last resort: mechanical work whose checks catch a bad result immediately |

Every model accepts every effort from `low` through `ultra`. Effort defaults to `high` on `sol` and
`astra`. A `luna` task cannot be one that other tasks depend on unless you pin the run to `luna`.
The runtime rejects an unresolved task instead of silently falling back to a default model, and
rejects family names such as `gpt-6` that do not name a tier.

If Codex rejects a model as unavailable to your account, the task is relaunched on the next model
down `astra` → `sol` → `terra` → `luna` with the same effort, and the rest of the run skips the
unavailable model. The substitution is recorded on the attempt and in the run events, and shown by
`run poll`, `/orchestrator:resume`, and the supervisor briefing; a substituted pin is flagged so
Claude tells you which model actually ran.

### When you want exact control

Everything the conversation infers can be stated outright. Name a lane, pin the pool, or define the
write boundary yourself:

```text
/orchestrator:lanes add api \
  --scope 'src/api/**' \
  --scope 'tests/api/**' \
  --constraint 'No new production dependencies' \
  --done 'API tests and the full repository test suite pass'

/orchestrator:run api --max-workers 3 add cursor pagination to the users API
```

Use `--model astra|sol|terra|luna` only when you deliberately want to pin the entire pool to one
model.
Use `--effort <level>` only when you want to pin effort across the run. A conflicting task route is
rejected. Exact resolved routes are saved on the plan and every attempt so resume and audit cannot
silently change them.

Resume the same manager after interruption or compaction:

```text
/orchestrator:resume <run-id>
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
   evidence and acceptance criteria. Terminal attempt outcomes are recorded separately from task
   lifecycle state so retries retain an auditable reason for each earlier result.
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
| `/orchestrator:init` | Create state and preflight Codex CLI, auth, and Git |
| `/orchestrator:lanes` | Define named scope, constraints, and lane-level done criteria |
| `/orchestrator:run` | Plan and manage a new Claude-supervised routed Codex worker pool |
| `/orchestrator:resume` | Recover and continue an existing durable run |
| `/orchestrator:ledger` | Show or add stable project facts carried into future tasks |

The lower-level CLI is available to command definitions and operators:

```text
node plugins/orchestrator/scripts/orch.mjs help
```

Supervisors can explicitly stop a reported task at a policy or authority boundary, or terminalize
an unrecoverable integration failure, with `run decide`. The decision records a versioned
`policy_refused`, `authority_escalated`, or `integration_failed` outcome; policy and authority
decisions are never inferred from worker prose.

The lower-level `learn` commands derive evaluation-ready metadata without copying prompts,
objectives, source, diffs, worker output, evidence text, ledger text, stderr, tool output,
environment variables, or absolute paths:

```text
orch learn collect [--run <id>] [--retention-days <n|forever>]
orch learn list
orch learn inspect <sample-id>
orch learn label <sample-id> --outcome <value> --action <value> \
  --reason-code <code> --provenance <supervisor|user|imported>
orch learn export [--name <id>]
orch learn purge --sample <id>
```

The base store is permanently metadata-only. A managed export can include one of the documented
text fields only when both `--consent user|supervisor` and
`--acknowledge-sensitive-export` are present; redaction runs before bounded text is written.
Exports stay under the private learning directory so purge can find and remove every managed
copy. There is no upload or network destination. Redaction deliberately favors privacy over
semantic precision: IPv4-shaped dotted quads can be removed even when they resemble a version
number rather than a real network address.

Reviewed non-success outcomes can be compiled into provisional per-run guidance:

```text
orch run guidance <run-id> --mode provisional [--policy-version <id>]
orch run guidance <run-id> --mode off
orch run guidance <run-id> --rollback
```

Enabling guidance requires a supervisor- or user-reviewed outcome for the run's lane. It makes the
current checkpoint stale, so the supervisor must review and checkpoint the policy before dispatch.
Only a retry whose typed prior outcome exactly matches a reviewed failure signature receives an
item. The item is a fixed built-in template: objectives, evidence, worker prose, source text, and
free-form instructions never enter the learned policy or provisional guidance block. This does not
remove the ordinary run objective, assignment, scope, constraints, acceptance criteria,
dependency context, or other established sections of the worker briefing. Guidance is advisory
and cannot change model or effort pins, task state, scope, constraints, safety rules, or supervisor
authority. A policy version name is immutable within a run: if reviewed sources change the policy
hash, enable it under a new `--policy-version` instead of rebinding the old name.

## Context and memory

State is split by portability:

```text
.orchestrator/
  .gitignore
  lanes.json                       # committed: scopes, constraints, done criteria
  ledger.md                        # committed: durable project decisions and facts
  local/                           # self-ignored: machine-specific run state
    threads.json                   # local state file; per-lane thread pointers are no longer written
    runs/<run-id>/
      run.json                     # task graph, attempts, results, evidence, checkpoints
      events.jsonl                 # append-only supervisory event history
      workers/<task>/<attempt>/    # prompt, schema, JSONL output, status, final result
    worktrees/<run-id>/...         # isolated worker checkouts
    learning/                      # private 0700 derived learning state
      identity.json                # local HMAC key and opaque repository identity (0600)
      examples.jsonl               # strict metadata-only samples and label history (0600)
      exports/<export-id>/         # managed local snapshots and manifests (0700/0600)
```

The ledger is intentionally small and stable. Per-run detail stays local because process IDs,
worktree paths, and Codex threads are meaningful only on the machine that owns them.
`/orchestrator:resume`
combines the run record, latest checkpoint, worker evidence, integration history, lane definition,
and ledger into the supervisor's reconstructed context.

All versioned state is read defensively. Run state version 6 adds the GPT-6 roster and model
substitution records; version 5 added guidance policy and attempt snapshot fields. Version-3
through version-5 runs remain readable and resume and retry on their persisted exact slugs,
including the retired `gpt-5.6-sol` and `gpt-5.6-terra`, which new plans cannot select. A newer
version is refused instead of guessed at, writes are atomic, and shared state updates use file locks.

Learning records default to 365-day retention metadata; `--retention-days forever` records that
they remain until an explicit purge. Retention never deletes raw run audit state. `learn purge`
removes matching samples, their embedded label history, and every affected managed export; corrupt
or incomplete managed exports are removed conservatively. `--all` preserves the private identity
and an empty store. Because raw runs are intentionally separate, a later `learn collect` can
derive a purged sample again until the raw run itself is removed through a separate workflow.

## Safety invariants

- Workers use only `gpt-6-astra`, `gpt-6.1-sol`, `gpt-6.1-terra`, or `gpt-5.6-luna` (plus the
  persisted `gpt-5.6-sol` or `gpt-5.6-terra` slugs of runs saved by 0.5.x); each resolved model
  and effort is persisted before launch, and substitution is never silent.
- Automatic routing is a plan-time supervisor decision, not a hidden runtime fallback. Every
  unpinned task must include an exact model, effort, and routing reason before dispatch.
- A worker cannot widen its assigned scope or self-assign global work.
- The supervisor checkout must be clean for launch, integration, and finalization.
- The supervisor branch and recorded integration head must not drift outside the run.
- Write-task reports must match the actual committed file set exactly.
- Worker prose is untrusted evidence, not instructions to the supervisor.
- Provisional guidance uses only fixed templates selected from reviewed typed outcomes. It is
  opt-in, checkpointed, bounded, replayed from the attempt snapshot, and fully advisory.
- A task report is not a supervisor verdict, and completed tasks are not a completed run.
- Dispatch is refused until a checkpoint covers the current plan revision, so supervisory reasoning
  survives compaction.
- Cancellation terminates the detached process and remains visible in durable state.
- Dirty worktrees are never removed automatically.

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
  belongs to the account authenticated in Codex CLI. A model Codex rejects as unavailable is
  recorded as a failed attempt and the task relaunches on the next model down the ladder; only
  when no model is left does the task fail for the supervisor to escalate.
- Automated tests validate the complete process protocol with fake workers. A real authenticated
  Codex smoke test is still the environment-level proof for a particular installation.

## License

Apache-2.0.
