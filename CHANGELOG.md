# Changelog

## 0.6.0

This release changes the worker roster and removes the single-task commands.
Read "Upgrading from 0.5.x" in the README before resuming a 0.5.x run.

Breaking changes:

- The worker roster is now GPT-6 based. `sol` and `terra` resolve to
  `gpt-6.1-sol` and `gpt-6.1-terra`, no longer the GPT-5.6 models. `astra`
  (`gpt-6-astra`) is new, for work where a wrong result is expensive or hard to
  catch, and `luna` stays `gpt-5.6-luna`. Every model accepts every effort from
  `low` through `ultra`, including `luna` with `ultra`, which 0.5.x rejected.
- The bare `gpt-5.6` alias is gone, and family names such as `gpt-6` and
  `gpt-6.1` are rejected because they do not name a tier. New plans cannot
  select the retired `gpt-5.6-sol` or `gpt-5.6-terra` slugs; runs saved by
  0.5.x keep them on resume and retry.
- Run state is now version 6. A 0.5.x build refuses a run this release has
  written, so finish or abandon a run with one release.
- A model Codex rejects as unavailable to your account no longer fails the
  task. The task relaunches one rung down `astra` → `sol` → `terra` → `luna`
  with the same effort, the rest of the run skips that model, and the
  substitution is recorded on the attempt, in the run events, in `run poll`,
  and in the supervisor briefing. A substituted user pin is flagged and Claude
  is told to say which model ran. The task fails only when no rung is left.
- New runs default to 5 concurrent workers instead of 3.
- `/orchestrator:do`, `/orchestrator:accept`, `orch brief`, `orch accept`, and
  `orch lane bind|unbind` are removed, along with lane thread pointers. Use
  `/orchestrator:run` for single tasks as well. Existing `threads.json` files
  still load.

New:

- Retries are warm by default. A failed or blocked task resumes its worker's
  own Codex thread, in its previous worktree, with a "Previous attempt" section
  carrying the outcome, the supervisor's evidence, and the files it changed.
  `run retry --note "<what to change>"` adds a correction for the worker, and
  `--fresh` starts a new thread. If Codex no longer has the thread, the retry
  falls back to a fresh one and records that it did.
- Workers can ask instead of stopping. A worker that needs one adjacent file
  outside its scope, or faces an objective with two readings, pauses with a
  typed `needs_input` request. `run answer` grants scope to that task only,
  denies, or replies, and the same attempt continues on the same thread. Claude
  may grant inside the lane; anything outside it needs the user's approval. A
  task gets at most 3 answered requests, and they do not count as retries.
- `run wait` blocks until a worker changes state and prints the `run poll`
  payload, so the supervisor runs it in the background and is woken instead of
  polling. Each task also has a wall-clock limit (plan field `timeoutMinutes`,
  else 30 to 120 minutes by model) that is reported, never enforced.
- `run routes` shows, per model and effort, how many attempts ran in this
  repository's saved runs, how many first attempts were accepted, retries, and
  median duration. It reads local run state only. Rates are withheld below 5
  samples, rejected launches count for no model, and retired GPT-5.6 attempts
  are excluded unless `--include-legacy` is passed. `run plan`, `run briefing`,
  and `run resume` show the lane's table once it has 5 counted attempts.
- The routing guidance in `/orchestrator:run` was rewritten: `sol` at `high` by
  default for non-trivial work, `astra` for independent verification of work
  done on `sol` or below, `luna` only for mechanical leaf tasks with a stated
  reason, and tasks sized by write-surface independence rather than a target
  count. Claude Opus 5.5 and Claude Fable 5.2 are the supported supervisors.

None of the new behavior has yet been exercised in a real `/orchestrator:run`
against Codex; it is covered by tests with fake Codex processes. The Codex CLI
behavior it relies on (resume flags, model changes on resume, missing-thread
and unavailable-model errors) was probed directly against Codex CLI 0.169.0.

## 0.5.1

- Fixed a defect that made every 0.5.0 worker launch fail. `blocker_code` was
  declared in the worker result schema but omitted from `required`, which
  structured outputs reject outright, so workers exited before reading their
  briefing regardless of task, model, or effort. The field is now nullable and
  required, which satisfies the API while keeping the field optional in
  practice: a worker with nothing to report sends null, and the blocked-attempt
  path continues to fold that into `other`.
- Added regression tests asserting that every declared property of the worker
  result schema appears in `required`, that nested object schemas disallow
  additional properties, and that an optional field stays expressible as null.
- Surfaced API-level rejections in the recorded failure. Codex reports them as
  JSON events on stdout rather than stderr, so a refused request previously left
  an empty stderr log and was recorded only as `Codex exited 1`, forcing whoever
  diagnosed it to read `events.jsonl` by hand. Worker collection now falls back
  to the event stream and records the reported message.
- Corrected every documented command invocation from `/orch:` to
  `/orchestrator:`. Claude Code namespaces plugin commands by plugin name, so
  the previously documented prefix never resolved. This affects the README,
  command and skill docs, architecture notes, and the runtime's own remediation
  messages.
- Reworked the entry path so a run starts from a plain sentence. When no lane
  fits an objective, `/orchestrator:run` now derives one from the repository,
  proposes it, and confirms once, instead of refusing until the user hand-writes
  a lane definition. Explicit lanes, pins, and flags remain available for exact
  control. Pool flags now parse independently of the objective text, so a
  present flag no longer makes the first word of a plain-language request a
  lane name.
- Documented installing from a local checkout alongside the GitHub path,
  including the repository-root marketplace requirement, the versioned install
  cache that makes an install a snapshot rather than a live link, the refresh
  and reinstall cycle after editing plugin sources, and how to check the
  installed version against the checkout.

## 0.5.0

- Added versioned terminal attempt outcomes with separate action, reason,
  diagnostic-signal, and provenance fields. Verification, integration,
  refusal, escalation, cancellation, and retry history remain distinct from
  scheduler lifecycle state and readable from older version-3/version-4 runs.
- Added a private, local-only learning store that derives deterministic,
  metadata-only examples behind opaque keyed references. Reviewed labels,
  retention, hierarchical purge, and managed local exports are auditable;
  textual exports require explicit consent and acknowledgement, run redaction
  before truncation, and never upload automatically.
- Added opt-in provisional guidance for retries. Policies compile only from
  supervisor- or user-reviewed typed outcomes and render closed, bounded
  templates; policy changes invalidate the checkpoint, attempts freeze the
  selected policy, and operators can disable or roll back guidance without
  changing routes, pins, scope, safety rules, or supervisor authority.
- Hardened persisted schemas and recovery. Run state version 5 is decoupled
  from marked lane and local-thread schemas, legacy unmarked version-3 through
  version-5 files migrate without guessed learning data, guidance selections
  must belong to retained policies, policy version names cannot be rebound to
  different hashes, deterministic ordering is locale-neutral, and redaction
  version 2 remains compatible with version-1 derived records.
- Kept rubrics, confirmed guidance, judges, and shadow routing behind explicit
  data-readiness gates. Aggregate attempt count is insufficient without
  repeated eligible signatures, independent sources, meaningful policy
  opportunities, and credible holdout coverage; N-best implementation
  experiments remain out of scope and external training remains separately
  authorized.

## 0.4.0

- New runs default to enforced supervisor routing: Fable or Opus must assign every unpinned task
  an exact model, effort, and concise routing reason during planning
- Removed the hidden Sol/high fallback from new runs; unresolved automatic routes are rejected
  before the plan can be saved
- `--model sol|terra|luna` and `--effort <level>` are now explicit run pins, and conflicting task
  routes are rejected instead of overriding the user's choice
- State version 4 prevents older builds from misreading automatic routes, while version 3 runs
  keep their original fallback-and-task-override behavior when resumed

## 0.3.0

- Runs accept `--model sol|terra|luna`, with Sol remaining the backwards-compatible default
- Planned tasks can override `model` and `effort`; aliases normalize to exact GPT-5.6 model slugs
  and unsupported routes, including Luna with `ultra`, are rejected before dispatch
- Every attempt persists its exact resolved model and effort for recovery, audit, and stable retry
- State version 3 keeps older plugin builds from silently dropping saved per-task routes; version
  2 runs remain readable and inherit their saved run default
- Claude's planning contract now routes hard open-ended work to Sol, balanced general work to
  Terra, and clear high-volume work to Luna

- Documented the supervisor as whichever Claude model owns the Claude Code session. Claude Opus
  and Claude Fable are both supported; the plugin never selects or substitutes a supervising
  model, and only worker routes are selected and pinned
- `run launch` now refuses to dispatch until a checkpoint covers the current plan revision, so
  the reasoning behind a plan or a replan is written down before work leaves the main thread
- `run ready` and the resume briefing report a checkpoint as stale once tasks complete beneath
  it; staleness prompts, a new plan revision blocks
- Worker briefings now carry each completed dependency's decisions, assumptions, changed files,
  and supervisor-verified evidence instead of a single summary line
- `/orchestrator:run` documents the exact `run checkpoint` invocation at plan approval and wave
  boundaries

`orch run ready --json` now returns `{ tasks, checkpoint }` rather than a bare task array.

## 0.2.0

A Claude supervisor can now manage a durable pool of Codex workers inside Claude Code.

- `/orchestrator:run` plans a task DAG, confirms it, and manages bounded workers pinned to
  `gpt-5.6-sol`
- Detached `codex exec` processes use saved reasoning effort, least-privilege sandboxes,
  required JSON output, durable process/thread handles, and configurable pool capacity
- Every task receives an isolated Git worktree; write integration requires clean commits,
  exact file declarations, in-scope changes, and an unchanged supervisor branch
- Worker reports remain untrusted evidence until the supervisor verifies read tasks or
  integrates passing write tasks
- `/orchestrator:resume` polls active workers and reconstructs the supervisor's full managerial
  context from run state, checkpoints, evidence, integration history, lanes, and the ledger
- Completed task graphs enter `finalizing`; a separate clean, branch-consistent combined
  verification record is required before a run becomes `completed`
- Explicit retry, cancellation, replanning, conflict abort, branch-drift refusal, and safe
  worktree cleanup paths preserve history without silently discarding work
- End-to-end tests cover concurrent detached workers and the full write-worker lifecycle
  without consuming model quota

The official Claude Codex bridge is now optional for pooled execution and remains supported
for legacy `/orchestrator:do` dispatch.

## 0.1.0

Initial release.

- `/orchestrator:init` — set up `.orchestrator/` and preflight the Codex toolchain
- `/orchestrator:lanes` — named workstreams with scope patterns, standing constraints, and a
  definition of done
- `/orchestrator:do` — compile a briefing, delegate to Codex via `/codex:rescue`, bind the
  returned thread, and check the result
- `/orchestrator:ledger` — durable project facts carried into every briefing
- `/orchestrator:accept` — re-check a lane's working tree against what Codex reported

Lane definitions and the ledger are committed; thread bindings and pre-dispatch snapshots
stay machine-local under `.orchestrator/local/`.
