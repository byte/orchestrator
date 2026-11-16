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
It may ask: a typed `needs_input` request for a scope extension or a decision pauses the attempt
until the supervisor answers (see "Worker requests").

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
running -> needs_input -> dispatching -> running (run answer; same attempt, same thread)
needs_input -> cancelled
blocked | failed | cancelled -> pending (explicit retry, warm or fresh)
```

`needs_input` means the worker returned a typed request instead of a result. The attempt stays
open with no outcome, keeps its pool slot, and blocks plan and guidance revisions like a running
worker; for run status it counts as running.

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
verification while preserving every earlier attempt and its outcome; the cleared result,
verification, and disposition are first copied onto the attempt as `review`. Version 3 and version 4 run
files without outcomes remain readable and are shown as unclassified legacy state rather than
being guessed or backfilled.

`needs_input` is deliberately not an outcome. `lib/outcomes.mjs` lists it in
`NON_TERMINAL_OUTCOMES`, and `validateOutcomeRecord` rejects it as a terminal value. A paused
attempt has no outcome, so learning collection skips it like any in-flight attempt; once answered,
the same attempt ends with exactly one outcome, which is the only thing learning data sees.

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

**Missing thread (M2.8, probed 2026-11-15).** Resuming a well-formed UUID that has no rollout on
this machine exits 1 with nothing on stdout and, on stderr, `Error: thread/resume: thread/resume
failed: no rollout found for thread id <id> (code -32600)`. No `thread.started` event is emitted.
An expired thread was not observed; it is assumed to fail the same way, since expiry means the
rollout is gone. A thread id that is not a UUID (probed with `thread-bogus`) is **not** an error:
Codex silently starts a new thread, reports a different id in `thread.started`, and exits 0. A
real resume reports the same thread id it was given.

## Task dispatch

`run launch` performs these steps:

1. Lock and claim a ready task while enforcing `maxWorkers` (default 5), requiring a fully
   resolved exact model and effort, and requiring a checkpoint that covers the current plan and
   guidance revisions.
2. Require a committed, clean supervisor checkout on the run's branch and integration head.
3. Create `.orchestrator/local/worktrees/<run>/<task-attempt>` and a dedicated task branch, or,
   for a warm retry, reuse the previous attempt's worktree and branch (see "Warm retries").
4. Write the prompt, JSON schema, worker specification, output paths, and status path.
5. Spawn a detached Node wrapper.
6. The wrapper invokes:

   ```text
   codex exec -C <worktree> \
     --model <resolved task model> \
     -c model_reasoning_effort="<resolved task effort>" \
     <sandbox arguments> \
     --json \
     --output-schema <schema> \
     --output-last-message <result> -
   ```

   A write task's sandbox arguments are `--sandbox workspace-write`. A read or verify task gets
   no `--sandbox` flag; it gets a permissions profile instead, so it can run the tests it is
   checking:

   ```text
   -c default_permissions="orchestrator-read"
   -c permissions.orchestrator-read.extends=":read-only"
   -c permissions.orchestrator-read.filesystem={"<scratch>"="write"}
   ```

   `<scratch>` is a fresh private directory under the system temp root, exported to Codex as
   `TMPDIR` and removed when the worker exits. Plain `--sandbox read-only` denies every write,
   the temp root included, so a reviewer could not create the temporary repositories a test
   suite needs. The profile keeps the worktree and everything else unwritable. `--sandbox` must
   not be passed alongside it: with both, `--sandbox read-only` wins and the scratch directory is
   denied too. Verified against Codex CLI 0.169.0 on macOS, for a fresh `exec` and for
   `exec ... resume`: a write to the scratch directory succeeded and a write to the worktree
   failed with EPERM.

   For a warm retry it resumes the previous attempt's thread instead, with `-C` and the sandbox
   arguments on `exec` (Codex rejects them after `resume`) and the attempt's own route after it:

   ```text
   codex exec -C <worktree> <sandbox arguments> resume \
     --model <attempt model> -c model_reasoning_effort="<attempt effort>" \
     --json --output-schema <schema> --output-last-message <result> <thread-id> -
   ```

7. Persist the exact model and effort with the attempt (plus the requested model and a
   substitution record when the route was substituted), the wrapper PID immediately, then the
   Codex thread ID when `thread.started` arrives.

The wrapper owns signal forwarding and atomic status updates. Claude never needs to block on a
worker process; it blocks only on `run wait`, run as a background command (see "Waiting for
workers").

## Warm retries

`run retry <run-id> <task-id> [--note <text>] [--fresh]` first copies the task-level result,
verification, and disposition onto the last attempt as `attempt.review`, then clears them and
records a pending retry on the task. The retry is warm when the most recent attempt that reached a
Codex worker (attempts Codex rejected for an unavailable model, or that failed before Codex
started, are skipped) has a thread id and ended with a result or verdict: `verification_failed`,
`worker_blocked`, `policy_refused`, `authority_escalated`, `integration_failed`, or a
`contract_failed` malformed result. It is cold for `--fresh`, a crash (`execution_failed`), a
missing result, a cancellation, or a missing thread id. A route change does not force a cold
start, because a resumed thread accepts a new model and effort.

The next claim turns the request into `attempt.retry` (mode, reason, note, thread id, worktree
decision) and sets `attempt.resumedFromAttemptId` on a warm attempt. The worktree decision is
made then: a warm retry reuses the previous attempt's worktree, branch, and base, so inspection
and integration see the commits of both attempts; after an `integration_conflict` it gets a fresh
worktree at the current integration head instead, and the worker is told to redo the change
there. A cold retry always gets a fresh worktree.

Every retry briefing, warm or cold, carries a "Previous attempt" section: the outcome, the
supervisor's evidence, the retry note, the worker's own summary and blockers (marked unverified),
the files the attempt changed (from integration inspection when available, otherwise as
declared), and any integration findings. It is ordinary briefing text and independent of the
provisional guidance block. Because the whole briefing is resent on resume, it also works when
the resume falls back.

The wrapper falls back to a fresh thread in the same worktree, with the same prompt, when the
resume exits non-zero without a `thread.started` event and stderr reports a missing thread. When
Codex instead starts a different thread than requested (a non-UUID id), the attempt continues.
Either way the status file carries `resumeFallback`, which `run poll` records on the attempt and
as a `task.resume_fallback` event. A warm attempt that Codex rejects for an unavailable model hands
its retry request to the relaunch, which resumes the same thread on the fallback model.

`run resume` and the supervisor briefing label each attempt as a warm resume, a fallback, or a
fresh retry, and show a pending retry's mode and note. Learning samples carry a `warmStart`
feature that is true only for an attempt that actually continued an earlier thread; samples
collected before this feature existed stay valid. `run retry` advises escalating one tier once two
warm retries of the same task have failed. No state version bump was needed: every new field is
optional, and version-3 through version-5 runs retry the same way.

## Worker requests

Before 0.6.0 a worker that needed one file outside its scope, or faced a genuinely ambiguous
objective, could only report a blocker, which ended the attempt and cost a retry. Now the result
schema has a `needs_input` field. It is nullable and, like every property, required: structured
outputs reject a declared property missing from `required`, and its nested object sets
`additionalProperties: false` with all five keys required.

```text
needs_input: null
  | { kind: "scope_extension", paths: [<repo-relative path>...], reason, question: null, options: [] }
  | { kind: "question",        paths: [], reason, question: <text>, options: [<reading>...] }
```

A malformed request (unknown kind, no reason, an absolute or `..` path, a question without text)
fails the result contract. A well-formed one makes `run poll` record the round on
`attempt.inputRequests` (request, thread id, the paused result) and set the task and attempt to
`needs_input`, with a `task.needs_input` event. The worker prompt's "Required behavior" block tells
write workers to request an extension for a necessary adjacent change instead of editing it,
working around it, or stopping, and every worker to ask when the objective admits two materially
different readings instead of guessing, and to report a blocker only when neither would help.

`run answer <run-id> <task-id>` takes exactly one decision: `--grant-scope <glob>` (repeatable;
write tasks answering a scope request only), `--deny`, or `--reply <text>`; a reply may accompany
a grant or denial. It records the answer on the round and a `task.input_answered` event, then
resumes the attempt through the warm-retry path: `codex exec -C <worktree> --sandbox <mode> resume
--model <m> -c model_reasoning_effort=<e> ... <thread-id> -`, with the attempt's own model and
effort (so a substituted model stays substituted) and the task's sandbox, all passed explicitly.
The resumed thread receives a short "Supervisor answer" message; the wrapper's fresh-thread
fallback receives the full briefing instead (`fallbackPromptFile`), whose "Supervisor answers"
section lists every answered round. A fallback is recorded on that round's answer and as a
`task.resume_fallback` event with `inputRound`. Each round's prompt, spec, status, and output live
under `workers/<task>/<attempt>/round-<n>/`; the previous runner is kept on the answer. If the
resume cannot be launched the answer is reverted and the task returns to `needs_input`.

Rules the runtime enforces:

- **A grant belongs to the task.** It is appended to `task.scopeGrants` (patterns, round, attempt,
  the requested paths and reason, whether it lies inside the lane, and user approval). The lane and
  the planned `task.scope` never change. `effectiveTaskScope` (planned scope plus grants) is what
  the briefing shows and what `run inspect` and `run integrate` check; the inspection reports
  `grantedScope`. Every other out-of-scope path is still refused. Grants persist for the task's
  later attempts and survive a plan revision of the task.
- **No shared write surface.** A grant is refused when any of its patterns may overlap the
  planned-plus-granted scope of another write task that is `dispatching`, `running`,
  `needs_input`, or `reported` (not yet integrated). Overlap is exact for literal paths and
  conservative for two globs: they are treated as disjoint only when their literal prefixes or
  literal suffixes diverge, so the check can refuse a grant that was safe but never admits one
  that was not.
- **Authority ends at the lane.** A grant whose patterns the lane's scope does not provably cover
  is refused unless `--user-approved` is passed, which is recorded. The supervisor may grant
  inside the lane on its own authority; outside it, the user decides.
- **Round trips are capped.** A task gets at most 3 answered round trips, counted across all its
  attempts. A further request is recorded on the attempt with `capped: true` and closes it as an
  ordinary blocker: `worker_blocked` with `scope_required` (scope request) or
  `ambiguous_objective` (question), the request appended to the blockers.

**Same attempt, not a new one.** An answered task continues the attempt it paused in rather than
starting a linked attempt. The attempt and outcome model records one outcome per attempt, and
retries, `retryCount`, warm-failure escalation, and learning samples are all attempt-based; a
linked attempt would need a terminal outcome for the paused one (a fake failure, or a new
"needs_input" outcome every consumer would have to exclude) and would count as a retry. Continuing
the attempt keeps one thread, one worktree, one route, and one outcome. The costs are that the
attempt's duration includes the time spent waiting for the answer, and that several runner records
belong to one attempt, which `inputRequests[].answer.previousRunner` and the per-round directories
keep auditable.

**No state version bump.** Every new field (`attempt.inputRequests`, `task.scopeGrants`,
`runner.inputRound`, `runner.fallbackPromptFile`) is optional, and runs saved by versions 3 to 5
load, pause, answer, resume, and retry unchanged. The new `needs_input` status is written only by a
version-6 build; version 6 is itself new in 0.6.0, so no released build reads version-6 state, and
0.5.x already refuses it.

## Waiting for workers

Workers are detached processes that report only through files: the wrapper rewrites
`workers/<task>/<attempt>/status.json` (or `round-<n>/status.json` for an answered round) by
writing a temporary file and renaming it over the old one. Before 0.6.0 the supervisor learned that
a worker had finished only by calling `run poll` again and again. Now it starts one
`run wait <run-id> [--timeout <seconds>] [--interval <seconds>] [--no-watch] [--json]` as a
background Bash command; Claude Code re-invokes the supervisor when a background command exits,
so it is woken exactly when something changed. `run wait` is a `node` command, so `run.md`'s
`Bash(node:*)` tool permission already covers it.

**What wakes it.** `run wait` uses the same collection code as `run poll` (`pollRunWorkers`), which
marks every update the supervisor must act on with `changed: true`:

| Change | How it shows on disk | Update |
| --- | --- | --- |
| Worker finished | status `completed` and `result.json` | `reported` or `blocked`; `failed` for a malformed or missing result |
| Worker paused with a request | completed turn whose result has `needs_input` | `needs_input` with `round` and `inputRequest` |
| Worker failed or was cancelled | status `failed` or `cancelled` | `failed` or `cancelled` |
| Model substituted | status `failed` with an unavailability rejection naming the slug | `substituted` (or `failed`/`pending` when no rung is left or the relaunch failed) |
| Warm resume fell back to a fresh thread | status still `running`, `resumeFallback` newly present | `running` with `resumeFallback` |
| Worker over its wall-clock limit | nothing; detected from the runner's `launchedAt` | `running` (or `dispatching`) with `overLimit` |

A substitution, fallback, or over-limit flag is surfaced once: the poll that records it marks it
changed, later polls list it without the mark. Unchanged running workers and paused workers still
awaiting an answer (`awaitingAnswer: true`, repeated on every poll until answered) are listed for
context. `run wait` prints exactly this payload, so the supervisor never needs a second call, and
writes a one-line reason to stderr.

**Exit codes.**

| Code | Outcome | Meaning |
| --- | --- | --- |
| 0 | `changed` | At least one update has `changed: true`. |
| 1 | error | Unknown run, bad option, or three consecutive failed polls. |
| 2 | `timeout` | `--timeout` elapsed (default 1800 s) and nothing changed; workers are still running. |
| 3 | `idle` | No task is `dispatching`, `running`, or `needs_input`. |
| 4 | `awaiting_answer` | No worker is running, and at least one is paused on a `needs_input` request. |

A paused task holds its pool slot and counts as running for run status, but only the supervisor
can move it, so `run wait` does not count it as something to wait on. With other workers running
it waits for them and lists the paused one as awaiting an answer; with only paused workers left it
returns `4` at once instead of blocking forever on the supervisor.

**How it waits.** It polls once on start, so a change already on disk (a worker that finished
while the supervisor was busy) returns at once. It then watches each active attempt's runner
directory and the run directory with `fs.watch`. Directories, not files, are watched: a file
watcher stays attached to the replaced inode after a rename and goes silent, while a directory
watcher sees the rename. Events are filtered to `status.json`/`result.json` (and `run.json` in the
run directory, which picks up launches, answers, and cancellations made while it waits; a
filename-less event counts) and debounced by 100 ms, so the stream of `events.jsonl` appends from a
busy worker does not cause polls. Every newly armed watcher triggers one more poll, closing the gap
between a poll and its watcher starting. A timer fires at the earliest wall-clock deadline of a
running worker, because an over-limit worker may write nothing.

**Fallback.** `fs.watch` is unavailable on some platforms and file systems (network mounts, some
containers), can error, and can drop or coalesce events. Correctness therefore never depends on
it: a fallback poll runs every `--interval` seconds (default 15), and a watcher that errors is
dropped and left to the fallback. A missed event only delays the wake by at most one interval.
`--no-watch` disables watching entirely. While idle the cost is one cheap poll per interval; while
workers run, polls happen only on their status changes. Polls race safely with a concurrent
`run poll` or `run resume`: each task is re-read before it is collected, and a failed poll is
retried on the next trigger.

**Wall-clock limits.** A plan task may set `timeoutMinutes` (a positive number up to 1440).
Without it the limit is the default for the model the attempt actually runs on, so a substituted
attempt gets its substitute's limit: `gpt-6-astra` 120, `gpt-6.1-sol` 90, `gpt-6.1-terra` 60,
`gpt-5.6-luna` 30 minutes; legacy `gpt-5.6-sol` 90 and `gpt-5.6-terra` 60. The clock starts at the
current runner's `launchedAt`, so an answered `needs_input` round starts a new clock and time spent
waiting for the supervisor never counts. When a running worker passes its limit, the poll records
`attempt.overLimit` (limit, elapsed minutes, clock start, detection time) and a `task.over_limit`
event, once per runner. Nothing is stopped and no status changes: the supervisor decides whether
to keep waiting or `run cancel` the task. The supervisor briefing shows each task's limit and marks
an over-limit worker. `timeoutMinutes` is not part of a completed task's definition, so resubmitting
a completed task with a different limit is not a redefinition.

No state version bump: `task.timeoutMinutes` and `attempt.overLimit` are optional, and runs saved
by versions 3 to 5 wait on their tier defaults (tested with a version-5 run on `gpt-5.6-sol`).

## Route evidence

`orch run routes [--lane <lane>] [--include-legacy] [--json]` (`scripts/lib/routes.mjs`) is a
read-only aggregation over `local/runs/<run-id>/run.json`. It writes nothing, never reads the
learning store, and a run file it cannot load is listed as skipped rather than failing the command.
Per actual model and effort it reports finished attempts, first-attempt acceptance, retries, the
number that ran as a substitute, and the median duration (`startedAt`, else `claimedAt`, to
`finishedAt`). The counting rules:

- An attempt is attributed to `attempt.model`, the model it ran on, never `requestedModel`.
- An attempt with `modelUnavailable` (Codex rejected the launch) or `launchFailed` (Codex never
  started) did not reach a worker. It is not an attempt for either model; rejections are listed
  separately by the rejected model.
- `needs_input` rounds belong to their attempt, so they never add attempts. Attempts with no outcome
  yet (running or paused) and cancelled attempts are listed but not counted.
- A task's first attempt that reached a worker is its first attempt; every later counted attempt,
  warm or cold, is a retry. If that first attempt was cancelled or is still open, the task gives no
  first-attempt sample.
- Attempts saved before outcome records existed are classified from their status (`completed` is
  accepted; `failed` and `blocked` are not).
- Attempts on `gpt-5.6-sol` and `gpt-5.6-terra` are excluded unless `--include-legacy` is given.

Each first-attempt rate is printed beside its counts and only when at least 5 first attempts back
it; below that only the counts appear. `run plan`, `run briefing`, and `run resume` print the table
for the run's own lane, and `run resume --json` returns it as `routes`, once the lane has at least 5
counted attempts. The table is evidence for the supervisor; the runtime never changes a route from
it.

## Collection and integration

`run poll` (and `run wait`, `run resume`) reads status files for active tasks. Successful final
JSON is recorded as task evidence; malformed output, a non-zero exit, or a missing result becomes a
failed attempt.

For write tasks, `run inspect` checks:

- the worktree has no uncommitted changes
- at least one task commit exists
- every changed path matches the task's planned scope plus any scope granted to it through
  `run answer`
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
- worker summaries, checks, blockers, confidence, and attempts, each labelled as a warm resume,
  a resume fallback, or a fresh retry, with any pending retry's mode and note
- workers paused on a `needs_input` request, with the exact `run answer` command, and the scope
  granted to each task
- each worker's wall-clock limit and whether it is over it
- the lane's route evidence table, once the lane has at least 5 counted attempts
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
| Worker reports blockers | Task `blocked`, structured result retained | Resolve the prerequisite, then retry warm with a note, or replan |
| Worker returns `needs_input` | Task and attempt `needs_input`; no outcome; pool slot held | `run answer` with a grant, denial, or reply; the same attempt resumes |
| Worker runs past its wall-clock limit | `attempt.overLimit` and `task.over_limit` recorded; worker keeps running | Keep waiting, or `run cancel` the task and retry or replan |
| `fs.watch` unavailable or drops an event | `run wait` wakes on its fallback poll instead | None; the wake is delayed by at most `--interval` |
| Grant overlaps another active task, or lies outside the lane without `--user-approved` | Grant refused; task stays `needs_input` | Deny, narrow the grant, wait for the other task, or ask the user |
| Fourth request on one task | Attempt `worker_blocked` (`scope_required` or `ambiguous_objective`) | Retry with a note or replan |
| Malformed result | Task `failed` (`contract_failed`) | Retry (warm when a thread id exists); otherwise report |
| Warm retry's thread missing or replaced | Same attempt continues on a fresh thread in the same worktree; `resumeFallback` and `task.resume_fallback` recorded | Review as usual; the briefing was self-contained |
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
