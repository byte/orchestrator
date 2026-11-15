# Architecture and recovery

## Authority model

The Claude Code main thread is the control plane. The Claude model running that thread is the
supervisor — Claude Opus 5.5 and Claude Fable 5.2 are the supported pair, and the plugin never
selects or substitutes a supervising model. The supervisor owns:

- goal interpretation, plan approval, and durable checkpointing
- task boundaries, dependencies, priority, and pool capacity
- worker monitoring and cancellation
- evidence review and acceptance decisions
- integration order and conflict response
- replanning, checkpoints, final verification, and the user report

Codex workers are data-plane executors. A worker receives one bounded task, repository context,
lane constraints, durable ledger facts, and an output schema. For each completed dependency it
also receives that task's summary, decisions, assumptions, changed files, and supervisor-verified
evidence, so it builds on settled choices instead of re-deriving or contradicting them. A worker
may not spawn a subordinate pool, widen scope, integrate other work, or alter orchestration state.

New runs auto-route by default. During planning, the Claude supervisor assigns each task a model,
effort, and routing reason. The aliases `astra`, `sol`, `terra`, and `luna` normalize to the exact
slugs `gpt-6-astra`, `gpt-6.1-sol`, `gpt-6.1-terra`, and `gpt-5.6-luna`. Family names (`gpt-6`,
`gpt-6.1`, `gpt-5.6`) are rejected because they do not name a tier. An unresolved automatic route is
rejected rather than falling back to a default model. A `luna` route on a task that other tasks
depend on is rejected unless the user pinned the run to `luna`.

`gpt-5.6-sol` and `gpt-5.6-terra` are legacy slugs. They are accepted only where they were already
persisted by a 0.5.x run (state versions 3 to 5): a task's saved model, a run-level pin, or a task
resubmitted under its own id in a plan revision. A new plan, a new task, or a new run pin naming
one is rejected with a message that says so. Run state version 6 marks every run this release
writes, so a 0.5.x build refuses it instead of misreading slugs it does not know; any mutation of
an older run upgrades it to version 6 without changing its persisted slugs.

Users may explicitly pin a run-level model, effort, or both. A pinned dimension is inherited by
every task and conflicting task input is rejected. The resolved combination is validated when
planning and persisted again on the attempt before dispatch, making retries and recovery auditable
without silently changing models. Version 3 runs retain their original fallback-and-override
semantics when resumed.

## Model substitution

When Codex rejects a model as unavailable to the authenticated account, the runtime substitutes
rather than failing the task, and never does so silently:

1. `run poll` (and `run resume`, which polls first) finds a failed worker whose event stream
   contains a top-level `error` or `turn.failed` event naming the attempt's model with an
   unavailability phrase. Warning items (`item.completed` of item type `error`) never count, and a
   message that does not name the slug never counts, so an unrelated API error is not mistaken for
   unavailability.
2. The attempt closes as `execution_failed` / `model_unavailable` with signal `model_unavailable`,
   and the model is added to `run.unavailableModels` with the rejection message. Event:
   `task.model_unavailable`.
3. If the ladder `gpt-6-astra` → `gpt-6.1-sol` → `gpt-6.1-terra` → `gpt-5.6-luna` has a model
   below it that is not known unavailable and accepts the same effort, the task returns to
   `pending` and is relaunched immediately with the Codex command the rejected attempt used.
4. Every claim computes the effective route: the saved route, or the first available rung below it.
   A substituted attempt stores `requestedModel`, the actual `model`, and a `substitution` record
   with `pinned` set when the run pinned the model. Event: `task.model_substituted`. Later tasks in
   the same run go straight to the substitute without burning another rejected launch.
5. The poll update has status `substituted` and a notice naming both models. The supervisor
   briefing has a "Model availability and substitutions" section, marks the task route
   `SUBSTITUTED for <requested>`, and, for a substituted pin, tells the supervisor to inform the
   user. The saved plan route is never rewritten.
6. With no rung left the task fails with action `escalate`.

User pins are substituted too, because the owner's rule is "substitute, do not fail" without
qualification; the pin is flagged in every surface instead. Legacy slugs are not on the ladder: a
0.5.x run keeps its exact slug, and if Codex rejected one the task would fail for escalation rather
than silently change generation. A rejected launch never reached a worker, so it is ignored when
matching provisional guidance to the task's prior outcome.

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

## Attempt outcomes and diagnostics

Task lifecycle state answers what the scheduler may do next. A versioned attempt outcome answers
why a terminal attempt ended. New terminal attempts record exactly one of `accepted`,
`worker_blocked`, `policy_refused`, `authority_escalated`, `execution_failed`, `contract_failed`,
`verification_failed`, `integration_failed`, or `cancelled`, together with a compatible next
action, reason code, provenance, signals, and evidence references.

Outcomes live on attempts rather than task results. Retrying clears the current task result and
verification while preserving every earlier attempt and its outcome. Version 3 and version 4 run
files without outcomes remain readable and are shown as unclassified legacy state rather than
being guessed or backfilled.

Worker reports do not create accepted outcomes. Only supervisor verification or successful
integration can record `accepted`. Policy refusal and authority escalation are explicit supervisor
decisions through `run decide`; they are never inferred from free-form worker prose. The same
command can make a retryable integration diagnostic terminal as `integration_failed` when the
supervisor determines that the fixed attempt cannot be integrated safely.

Checkout drift, a dirty supervisor checkout, and a wrong launch branch are classified as
execution precondition failures with their own reason codes. They do not imply that worker code
failed, and they do not become policy refusals without an explicit supervisor decision.

Integration inspection failures and conflicts are initially retryable diagnostics. They append a
typed event and diagnostic signal while the task remains `reported`, leaving the same fixed worker
attempt eligible for a later successful integration. Cancellation closes active or reported
attempts only when they do not already have a terminal outcome.

## Derived learning store

The learning store is a separate local schema from run state. It is created lazily at
`.orchestrator/local/learning/` on the first mutating `learn` command. The
directory is mode `0700`, its identity and JSONL files are mode `0600`, and every mutation uses a
single live-owner-aware store lock plus atomic replacement. Read-only list and inspect operations
do not create the store.

Collection builds each sample field by field from an allowlist. Source run, task, attempt, lane,
and repository identifiers become domain-separated HMAC references using a private persisted key.
Samples retain structural counts, exact route enums, terminal outcome enums, diagnostic enums,
durations, event corroboration, and verification/finalization verdict and evidence counts. Raw
identifiers and low-entropy evidence hashes are omitted to prevent dictionary recovery.

The collector never recursively sanitizes a run or event object. It excludes objectives, titles,
scope and acceptance text, prompts, source, diffs, worker results, evidence prose, checkpoints,
ledger content, worktree and runner data, stderr, tool output, environment variables, and paths.
Outcome-less legacy attempts are counted and skipped rather than labeled by inference. A stable
sample ID identifies the source attempt, while a separate fingerprint changes when safe derived
facts such as finalization change; collection then updates the one sample instead of duplicating
it.

Labels are stored as provenance-tagged, validated outcome records inside the canonical sample.
Keeping sample and label history in the same locked JSONL record makes label, purge, and export
membership atomic without a cross-file orphan state. Conflicting labels remain audit history; a
later rubric/adjudication milestone must abstain until it chooses an active ground truth.

Managed exports use a separate versioned wrapper and carry a manifest with schema and redaction
versions, opaque membership, filters, consent, provenance, counts, and a content digest. Base
records remain metadata-only. Text exists only in an explicitly acknowledged managed export,
only for named allowlisted fields, and only after secret, credential, PII, network-address, and
path redaction. The privacy-first IPv4 matcher intentionally may redact a version-like dotted
quad; avoiding a possible address leak takes precedence over preserving ambiguous dotted text.
Exports have no URL destination and use no network capability.

Retention belongs only to derived learning records. The default is 365 days; `forever` means
retain until explicitly purged. Purge selectors can target a sample, run, task, attempt, expired
records, or the whole derived store. Purge validates actual export contents against manifests and
digests, removes affected exports before canonical records, and deletes corrupt or incomplete
managed exports conservatively. It never deletes `.orchestrator/local/runs/`. `purge --all`
preserves the private identity and empty store, and collection can recreate samples while their
raw source runs still exist.

## Provisional guidance

Run state version 5 adds an optional, run-local provisional guidance policy and frozen task and
attempt selections. Version-3 and version-4 runs remain readable and behave as guidance-disabled;
their next mutation upgrades them without inventing historical guidance.

Guidance is compiled only from metadata-only learning records whose effective outcome has explicit
`supervisor` or `user` provenance. Automatic classifications, imported labels, conflicting label
history, raw run artifacts, managed text exports, objectives, evidence, worker prose, source,
ledger, and free-form instructions are ineligible. The compiler maps typed actions and reason
codes to closed built-in templates and hashes the canonical policy. One explicit supervisor or
user review is sufficient only for this opt-in provisional phase; it is not high-confidence
evidence, a confirmed policy, or evidence that a later promotion gate has passed.

Those exclusions apply to learned policy content and the provisional guidance block, not to the
ordinary worker prompt. The existing runtime still renders the run objective, bounded assignment,
scope, constraints, acceptance criteria, reviewed dependency context, and durable project context
in their established briefing sections.

The operator explicitly enables a policy per run. That change increments a guidance revision and
makes the existing checkpoint stale. New tasks receive an enabled zero-item selection; a retry can
select guidance only when its prior attempt's opaque lane, task kind, terminal outcome, action,
and reason code match the frozen policy. Automatically observed signals are recorded for audit but
do not control the match unless a future reviewed schema makes them explicit. Claiming the task
copies the exact selection—including item
IDs, policy version/hash, provenance, rendered text, and budget—onto the attempt. Worker launch
renders that persisted block. Resume reports the saved version/hash/item IDs and returns the full
snapshot in JSON; neither path queries a mutable learning store.

Within a run, one policy version name identifies one canonical policy hash across the active
configuration and archived policies. Recompiling changed reviewed sources under an existing name
fails closed and requires a new `--policy-version`; exact reapplication of the same version and
hash remains idempotent. Recovery discards conflicting malformed history without weakening the
emergency off path or a valid rollback.

Guidance changes only a bounded briefing block. Route resolution, user model/effort pins, task
state, dependencies, scope, lane constraints, sandboxing, verification, integration, finalization,
and supervisor authority remain structurally independent. `run guidance --mode off` restores the
original no-guidance worker behavior; `--rollback` restores the previous exact policy snapshot.
Policies referenced by frozen selections remain archived in run state, and selections must match
an entry in that retained policy. The emergency off and rollback paths discard malformed active or
unrelated history entries while retaining every valid policy needed to replay prior attempts.
Policy changes are refused while work is active or awaiting verification.

## Verified against Codex CLI 0.169.0 (2026-11-15)

Probed with real, minimal `codex exec` calls ("Reply with the single word ok.") in throwaway Git
repositories, never this checkout. `~/.codex/config.toml` sets `model = "gpt-6.1-sol"` and
`model_reasoning_effort = "high"`.

**Roster and efforts (M0.1, M0.2).** `gpt-6-astra`, `gpt-6.1-sol`, `gpt-6.1-terra`, and
`gpt-5.6-luna` are all accepted on this account. Every one accepts every effort `low`, `medium`,
`high`, `xhigh`, `max`, and `ultra`; an invalid effort exits 1. `gpt-5.6-luna` therefore accepts
`ultra`, which 0.5.x denied. The legacy `gpt-5.6-sol` and `gpt-5.6-terra` slugs are also still
accepted.

**Unavailable model.** A model the account cannot use (probed with a made-up slug) exits 1 with an
empty stderr. stdout carries `thread.started` (a thread id is still issued), a warning item
`{"type":"item.completed","item":{"type":"error","message":"Model metadata for \`<slug>\` not
found. Defaulting to fallback metadata; ..."}}`, `turn.started`, then
`{"type":"error","message":"The '<slug>' model is not supported when using Codex with a ChatGPT
account."}` and `{"type":"turn.failed","error":{"message":"<same text>"}}`. This was observed for a
ChatGPT-account login only; the wording for an API-key login was not observed. The detector also
accepts an `error.code` of `model_not_found`, which is inferred from the OpenAI API, not observed.

**`codex exec resume` (M0.3).** Usage is `codex exec resume [OPTIONS] [SESSION_ID] [PROMPT]`;
`-` reads the prompt from stdin.

| Flag | Placed after `resume` | Placed on `exec`, before `resume` |
| --- | --- | --- |
| `--model` | accepted | not tested |
| `-c model_reasoning_effort=...` | accepted | not tested |
| `--json` | accepted | not tested |
| `--output-schema <file>` | accepted; the final message matched the schema | not tested |
| `--output-last-message <file>` | accepted; file written | not tested |
| `--sandbox <mode>` | **rejected**, exit 2 (unexpected argument) | accepted, and applied |
| `-C <dir>` | **rejected**, exit 2 (unexpected argument) | accepted, and applied |

The working invocation is therefore:

```text
codex exec -C <worktree> --sandbox <mode> resume \
  --model <model> -c model_reasoning_effort="<effort>" \
  --json --output-schema <schema> --output-last-message <result> <thread-id> -
```

A thread started in one repository resumed with `-C` pointed at a different repository: the
resumed turn's recorded `cwd` was the new directory and a `pwd` run by the agent printed it. The
same thread id is reported in `thread.started`.

The sandbox is not inherited from the thread. A resume without `--sandbox` ran with this machine's
default (writable) permission profile even though the thread started `read-only`; with
`--sandbox read-only` before `resume` it was read-only again. Callers must always pass the
sandbox explicitly. Without `-C`, resume runs in the caller's current directory, and fails outside
a Git repository ("Not inside a trusted directory").

**Changing route on resume (M0.4).** A resumed thread is not bound to the route it started on.
Resuming a `gpt-6.1-terra`/`low` thread with `--model gpt-6.1-sol -c
model_reasoning_effort="high"` succeeded, and the session's recorded turn context shows
`gpt-6.1-sol`/`high` for that turn. Codex emits a warning item, not an error:
`This session was recorded with model \`<old>\` but is resuming with \`<new>\`. Consider
switching back to \`<old>\` as it may affect Codex performance.` Resuming with an unavailable model
fails exactly like a fresh launch (same `error` and `turn.failed` events, exit 1), so the same
detector applies.

Omitting `--model` and the effort does **not** keep the thread's route: a `gpt-6.1-terra`/`low`
thread resumed with neither flag ran on `gpt-6.1-sol`/`high`, the config defaults, with the same
"recorded with model" warning. A warm retry must therefore pass model, effort, and sandbox
explicitly on every resume.

## Task dispatch

`run launch` performs these steps:

1. Lock and claim a ready task while enforcing `maxWorkers`, requiring a fully resolved exact
   model and effort, and requiring a checkpoint that covers the current plan and guidance
   revisions.
2. Require a committed, clean supervisor checkout on the run's branch and integration head.
3. Create `.orchestrator/local/worktrees/<run>/<task-attempt>` and a dedicated task branch.
4. Write the prompt, JSON schema, worker specification, output paths, and status path.
5. Spawn a detached Node wrapper.
6. The wrapper invokes:

   ```text
   codex exec -C <worktree> \
     --model <resolved task model> \
     -c model_reasoning_effort="<resolved task effort>" \
     --sandbox <read-only|workspace-write> \
     --json \
     --output-schema <schema> \
     --output-last-message <result> -
   ```

7. Persist the exact model and effort with the attempt (plus the requested model and a
   substitution record when the route was substituted), the wrapper PID immediately, then the
   Codex thread ID when `thread.started` arrives.

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

## Checkpoints

Run JSON records what happened; a checkpoint records why. Because the checkpoint is the only
supervisory reasoning that survives compaction, dispatch is gated on it:

- `run checkpoint` stamps each entry with the plan revision, guidance revision, and completed-task
  count it describes.
- `run launch` refuses to claim a task unless the latest checkpoint covers the current plan
  and guidance revisions, so planning, replanning, or a policy change forces the reasoning to be
  written down.
- `run ready` reports the checkpoint as stale once tasks have completed since it was written, and
  `run resume` marks a stale checkpoint at the top of its briefing section.

Staleness after a completed wave is a prompt, not a block. A plan revision without a checkpoint is
a block.

## Recovery protocol

`run resume` first polls all durable worker handles. It then returns:

- current run and task status
- process, status-file, thread, and worktree handles
- the exact model and effort selected for each active attempt, and the requested model when it
  was substituted
- every model found unavailable during the run and every substituted attempt, user pins first
- the frozen provisional guidance policy hash and item IDs selected for each attempt
- the supervisor's saved routing reason for every automatically routed task
- worker summaries, checks, blockers, confidence, and attempts
- supervisor evidence and integrated commits
- repository base and integration head
- latest checkpoint
- lane constraints and done criteria
- durable ledger facts

The generated supervisor briefing explicitly treats stored worker prose as untrusted evidence.
The supervisor continues the existing run rather than inventing a replacement from conversation
memory.

## Failure behavior

| Failure | Durable outcome | Recovery |
| --- | --- | --- |
| Codex process exits non-zero | Task `failed`, stderr tail or event-stream error retained | Inspect, then explicit retry or replan |
| Codex rejects the model as unavailable | Attempt `execution_failed`/`model_unavailable`; model recorded unavailable | Automatic relaunch one rung down the ladder, recorded and surfaced; escalate when the ladder is exhausted |
| Worker reports blockers | Task `blocked`, structured result retained | Expand authorized scope, resolve prerequisite, or replan |
| Malformed result | Task `failed` | Retry once if transient; otherwise report |
| Scope/declaration mismatch | Integration refused | Reject result and replan; do not cherry-pick |
| Dirty worker checkout | Inspection and cleanup refused | Ask worker/reviewer to resolve or preserve for diagnosis |
| Cherry-pick conflict | Cherry-pick aborted | Replan integration order or create a bounded conflict task |
| Supervisor branch drift | Launch/integration/finalization refused | Reconcile external commit deliberately |
| Claude interruption | Workers and state remain on disk | `/orchestrator:resume <run-id>` |
| Plan revised without a checkpoint | Dispatch refused | Record a checkpoint for the new revision |
| Automatic task omits model, effort, or routing reason | Plan refused | Supervisor classifies the task and saves an exact justified route |
| Task conflicts with an explicit run pin | Plan refused | Honor the user override or create a separate run |
| User cancellation | Child and wrapper receive termination; state cancelled | Inspect retained artifacts, retry only explicitly |

## Portability and retention

Lane definitions and the ledger are committed. Runs, process handles, worktrees, and raw worker
outputs are local and ignored. This prevents machine-specific paths and model transcripts from
entering Git while keeping stable project knowledge reviewable.

Completed worktrees can be removed with `run cleanup`. The command skips non-terminal tasks and
refuses dirty worktrees. Run JSON, event history, and worker outputs remain available for audit.
