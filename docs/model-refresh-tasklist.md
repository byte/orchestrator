# Model Refresh and Worker Leverage Tasklist

Target release: 0.6.0. Complete milestones in order; M1 and M2 are independent
of each other once M0 is done. Each milestone must leave the repository
shippable and pass `npm test` before dependent work begins.

## Target roster

Supervisor (never selected by the plugin, documented as the supported pair):
Claude Opus 5.5 or Claude Fable 5.2.

| Alias   | Exact slug       | Role                                                        |
| ------- | ---------------- | ----------------------------------------------------------- |
| `astra` | `gpt-6-astra`    | Fable-grade work: hardest open-ended tasks, deep verification |
| `sol`   | `gpt-6.1-sol`    | Default for hard implementation, debugging, architecture    |
| `terra` | `gpt-6.1-terra`  | Everyday coding and review                                  |
| `luna`  | `gpt-5.6-luna`   | Last resort: mechanical, high-volume, immediately checkable |

All four slugs and every effort from `low` through `ultra` were confirmed on
this account with Codex CLI 0.169.0 on 2026-11-15 (M0). `gpt-6.1-sol` is the
default in `~/.codex/config.toml`.

## Working rules

- [ ] Never substitute a model or effort silently; unresolved routes stay rejected.
- [ ] Runs saved by 0.5.x must resume on their original exact slugs.
- [ ] Preserve explicit user model and effort pins. Exception (owner decision,
  2026-11-15): a pinned model Codex rejects as unavailable is substituted down
  the ladder and flagged prominently.
- [ ] Claude stays planner, reviewer, and integrator; no supervisory subagents.
- [ ] No uploads, telemetry, or new runtime dependencies.
- [ ] Run targeted tests after each task and `npm test` at every gate.

## Milestone 0 — Confirm the facts the rest depends on

- [x] **M0.1** Run a trivial read-only `codex exec` against each of the four
  slugs and record which are accepted under the current entitlement.
- [x] **M0.2** For each accepted slug, record the reasoning efforts it accepts
  (`low` through `ultra`), by probing rather than by assumption.
- [x] **M0.3** Confirm `codex exec resume <thread-id> -` accepts `--model`,
  `-c model_reasoning_effort`, `--sandbox`, `--json`, `--output-schema`, and
  `--output-last-message`, and that it can run with `-C` pointed at a worktree
  other than the one the thread started in.
- [x] **M0.4** Confirm whether a resumed thread can change model or effort, or
  whether it is bound to the route it started on.
- [x] **M0.5** Record the findings in `docs/architecture.md` under a dated
  "Verified against Codex CLI <version>" heading.
- [x] **M0 gate** Every slug and effort in the roster table is either confirmed
  or struck from the table. If `gpt-6-astra` or `gpt-6.1-terra` is unavailable,
  stop and decide the fallback roster before M1.

### Milestone 0 evidence

- Probed 2026-11-15 with Codex CLI 0.169.0, ChatGPT-account login, in
  throwaway Git repositories under the session scratchpad; never this checkout.
  Prompts were "Reply with the single word ok." (one resume probe asked for
  `pwd` to confirm the working directory).
- M0.1/M0.2 (run by the owner before this milestone was handed over): all four
  slugs accepted; every slug accepts all six efforts; an invalid effort exits 1.
  `luna` accepting `ultra` contradicts the 0.5.x code, which is corrected in M1.
- Additionally observed: the legacy `gpt-5.6-sol` and `gpt-5.6-terra` slugs are
  still accepted, and a made-up slug is rejected with exit 1, empty stderr, and
  `{"type":"error","message":"The '<slug>' model is not supported when using
  Codex with a ChatGPT account."}` plus `turn.failed` on stdout.
- M0.3: `codex exec resume` accepts `--model`, `-c model_reasoning_effort`,
  `--json`, `--output-schema`, and `--output-last-message` after `resume`, and
  rejects `--sandbox` and `-C` there (exit 2). Both work when placed on `exec`
  before `resume`, and both are applied: a thread started in one repository
  resumed in another, and the sandbox is not inherited from the thread.
- M0.4: a resumed thread can change model and effort (terra/low resumed as
  sol/high, confirmed in the session's recorded turn context); Codex only warns.
  Omitting the flags falls back to the config defaults, not the thread's route.
- M0.5: recorded in `docs/architecture.md` under "Verified against Codex CLI
  0.169.0 (2026-11-15)". Gate: nothing struck from the roster.

## Milestone 1 — Roster refresh

Depends on: M0.

### Runtime

- [x] **M1.1** Replace `WORKER_MODELS` in `scripts/lib/runs.mjs` with the
  four confirmed slugs, aliases `astra`, `sol`, `terra`, `luna`, and the effort
  lists from M0.2.
- [x] **M1.2** Drop the bare `gpt-5.6` alias. Do not add bare `gpt-6` or
  `gpt-6.1` aliases; a family name must not pick a tier.
- [x] **M1.3** Add a separate frozen `LEGACY_WORKER_MODELS` set
  (`gpt-5.6-sol`, `gpt-5.6-terra`) that is valid only when loading or resuming
  an existing run, never when saving a new plan.
- [x] **M1.4** Bump `RUN_STATE_VERSION` to 6 in `scripts/lib/state.mjs` so a
  0.5.x build refuses a run that routes to slugs it does not know. Version-3
  through version-5 runs keep their persisted exact slugs on resume and retry.
- [x] **M1.5** Make the unsupported-model error in `normalizeWorkerModel`
  (`runs.mjs`) list the new aliases, and add a specific message when a new plan
  names a legacy slug.
- [x] **M1.6** Update the worker prompt header in `renderWorkerBriefing`
  (`runs.mjs`) so it no longer says "GPT-5.6 pool".
- [x] **M1.7** Replace the hardcoded model and effort lists in
  `scripts/lib/learning.mjs` (now `LEARNING_MODELS` and `LEARNING_EFFORTS`) with
  values derived from `WORKER_MODELS` plus the legacy set, so learning examples
  from old runs still validate.
- [x] **M1.8** Update `--model` help text in `USAGE` (`scripts/orch.mjs`) to
  `<auto|astra|sol|terra|luna>`.

### Routing guidance

- [x] **M1.9** Rewrite the routing rubric in `commands/run.md` section 3:
  `sol` is the default for anything non-trivial, `terra` for well-bounded
  everyday work, `astra` when a wrong result would be expensive or hard to
  catch, `luna` only for mechanical work whose acceptance criteria catch a bad
  result immediately.
- [x] **M1.10** Remove "Prefer the lowest effort that should reliably meet the
  acceptance criteria". Replace it with a default of `high` on `sol` and
  `astra`, lower only with a stated reason.
- [x] **M1.11** Require `routingReason` to justify any `luna` route explicitly,
  and reject a `luna` route on a task that other tasks depend on unless the run
  pins `luna`.
- [x] **M1.12** Decide and document whether independent `verify` tasks default
  to `astra`. Recommendation: yes, when the task under verification ran on
  `sol` or below.

### Docs and metadata

- [x] **M1.13** Update descriptions in `package.json`,
  `.claude-plugin/plugin.json`, the `run.md` frontmatter, and the
  `orchestrator-runtime` skill so none name a GPT version.
- [x] **M1.14** Update `README.md`, `docs/architecture.md`,
  `commands/resume.md`, and the `run.md` hard rules to the new roster.
- [x] **M1.15** State the supported supervisors as Claude Opus 5.5 and Claude
  Fable 5.2 in `README.md` and `run.md`. Keep the rule that the plugin never
  selects the supervising model.

### Model substitution (owner decision, 2026-11-15)

- [x] **M1.20** Detect an unavailable model from the event stream: a top-level
  `error` or `turn.failed` event that names the attempt's slug with an
  unavailability phrase (shape observed in M0). Ignore `item.completed` warning
  items and messages that do not name the slug.
- [x] **M1.21** On detection, close the attempt as `execution_failed` /
  `model_unavailable`, record the model in `run.unavailableModels`, and relaunch
  one rung down `astra` → `sol` → `terra` → `luna` with the same effort and the
  same Codex command. Fail for escalation when no rung is left.
- [x] **M1.22** Resolve the effective route at claim time so later launches in
  the run skip a known-unavailable model, and record `requestedModel`, the
  actual `model`, and a `substitution` record (with `pinned`) on the attempt.
  Never rewrite the saved plan route.
- [x] **M1.23** Surface every substitution: `task.model_unavailable` and
  `task.model_substituted` events, a `substituted` status with a notice in
  `run poll`, the notice and recovery details in `run resume`, and a "Model
  availability and substitutions" section in the supervisor briefing.
- [x] **M1.24** Substitute user-pinned models too, flagged prominently: the
  notice reads "USER-PINNED MODEL SUBSTITUTED" and the briefing tells the
  supervisor to inform the user.
- [x] **M1.25** Replace "never substitute" wording with "never substitute
  silently" in `run.md`, `resume.md`, the runtime skill, README, and
  architecture docs.
- [x] **M1.26** Fixture `fake-codex-model-unavailable.mjs` reproducing the
  observed rejection, and tests for detection, supervisor-routed and pinned
  substitution, run-wide skipping, and the exhausted ladder.

### Retire `/orchestrator:do` (owner decision, 2026-11-15)

- [x] **M1.27** Remove `commands/do.md` and `commands/accept.md`.
- [x] **M1.28** Remove `orch brief`, `orch accept`, `orch lane bind|unbind`, and
  the code that only they used: `renderBriefing`/`briefingLedger`
  (`briefing.mjs`), `acceptance.mjs`, `renderAcceptance`, the lane `threadId`
  fields and render line, `captureGitSnapshot`/`changesSinceSnapshot` and their
  helpers (`git.mjs`), and the optional Codex-plugin preflight check.
- [x] **M1.29** Keep what the pool path shares: `parseResultBlock` and
  `parseFileList` (used by `run report` and worktree inspection), lanes, the
  ledger, `glob.mjs` scope matching, and the local `threads.json` schema
  (`threads`/`snapshots`) so files written by older releases still load.
- [x] **M1.30** Update the runtime skill, briefing-compiler skill, `init.md`,
  `lanes.md`, README, and tests; delete `tests/acceptance.test.mjs` and the
  `renderBriefing`, `brief`, `accept`, and `lane bind` tests.

### Tests and gate

- [x] **M1.16** Update model assertions in `tests/runs.test.mjs`,
  `tests/workers.test.mjs`, `tests/cli.test.mjs`, `tests/commands.test.mjs`,
  `tests/guidance.test.mjs`, `tests/learning.test.mjs`, and
  `tests/metadata.test.mjs`.
- [x] **M1.17** Add a test that a version-5 run routed to `gpt-5.6-sol` loads,
  resumes, and retries on `gpt-5.6-sol`.
- [x] **M1.18** Add a test that a new plan naming `gpt-5.6-sol`, `gpt-5.6`, or
  a bare family name is rejected with the specific message.
- [x] **M1.19** Add a test for each model's rejected effort combination.
- [x] **M1 gate** `npm test` passes, and one real `/orchestrator:run` completes
  with at least one task on each of `astra`, `sol`, and `terra`. (`npm test`
  part met; real run done, see "Real-run checks".)

### Milestone 1 evidence

- Built: GPT-6 roster with tier-only aliases; frozen `LEGACY_WORKER_MODELS`
  accepted only for slugs a 0.5.x run already persisted (task model, run pin,
  or a task resubmitted under its own id); specific errors for legacy slugs and
  bare family names; `RUN_STATE_VERSION` 6; luna-leaf rule; learning
  validation derived from the roster plus legacy set; recorded fallback ladder
  for unavailable models; `/orchestrator:do` retired.
- Decisions: M1.12 resolved as guidance in `run.md` (verify tasks default to
  `astra` when the work under review ran on `sol` or below), not a runtime rule.
  M1.11 is enforced for the dependency rule; the runtime can only require that a
  luna `routingReason` is present, and `run.md` states what it must say.
- `tests/guidance.test.mjs` and `tests/learning.test.mjs` needed no change: they
  use aliases or a slug (`gpt-5.6-sol`) that learning validation still accepts.
- Not done: the real `/orchestrator:run` in the gate. The implementer could not
  invoke slash commands; the owner must run it.
- Full repository gate: `npm test` passed 154 tests with 0 failures on
  2026-11-15.

## Milestone 2 — Warm retries

Depends on: M0. This is the highest-value change in the list.

Before M2, `retryTask` (`runs.mjs`) cleared the result and the verification and
relaunched a fresh `codex exec` with the original prompt. The worker learned
nothing from the failure.

- [x] **M2.1** Persist the supervisor's failed-verification evidence and the
  integration failure detail on the attempt record before `retryTask` clears
  the task-level fields.
- [x] **M2.2** Add a `run retry --note "<what to change>"` option that stores a
  supervisor correction on the next attempt.
- [x] **M2.3** Add a "Previous attempt" section to the worker prompt: outcome,
  supervisor evidence, the retry note, and the files the last attempt changed.
  This is ordinary briefing text, separate from the fixed-template guidance
  block.
- [x] **M2.4** Add a `resumeThreadId` field to the worker spec and have
  `scripts/worker-child.mjs` call `codex exec resume <id>` when it is set.
- [x] **M2.5** Default retries to resuming the previous thread when the
  previous attempt reached a result or a verification verdict. Start fresh when
  it crashed, produced no thread id, or the route changed (subject to M0.4).
- [x] **M2.6** Add `run retry --fresh` to force a cold start.
- [x] **M2.7** Decide worktree handling on a resumed retry. Recommendation:
  reuse the previous worktree when the supervisor rejected the work, recreate
  it when integration failed on a conflict.
- [x] **M2.8** Fall back to a fresh launch, with a recorded event, when Codex
  reports the thread as missing or expired.
- [x] **M2.9** Record `resumedFromAttemptId` on the attempt and surface it in
  `run resume` and the learning features.
- [x] **M2.10** Lift "Retry transient worker failures once" in `run.md`
  section 7: transient failures retry once cold, verification failures retry
  warm with a note, and two warm failures on the same task escalate one tier.
- [x] **M2.11** Add a `tests/fixtures/fake-codex-resume.mjs` fixture and tests
  for warm retry, forced fresh retry, missing-thread fallback, and the rendered
  "Previous attempt" section.
- [x] **M2 gate** In a real run, a deliberately failed verification is retried
  and the worker's second attempt references the supervisor's evidence.
  (`npm test` part met; real run done, see "Real-run checks".)

### Milestone 2 evidence

- Built (2026-11-15): `run retry --note <text> --fresh`; the task-level result,
  verification, and disposition copied onto the attempt as `review` before they
  are cleared; a pending retry on the task that the next claim turns into
  `attempt.retry` and `attempt.resumedFromAttemptId`; a "Previous attempt"
  briefing section (outcome, supervisor evidence, note, worker summary and
  blockers, changed files, integration findings) rendered for every retry, warm
  or cold, as ordinary text outside the guidance block; `resumeThreadId` in the
  worker spec and a `codex exec -C <dir> --sandbox <mode> resume --model <m> -c
  model_reasoning_effort=... --json --output-schema ... --output-last-message
  ... <id> -` launch in `worker-child.mjs`, always with the attempt's own model,
  effort, and sandbox.
- M2.5: warm when the latest attempt that reached a worker has a thread id and
  ended `verification_failed`, `worker_blocked`, `policy_refused`,
  `authority_escalated`, `integration_failed`, or `contract_failed` with a
  malformed result. Cold for `--fresh`, `execution_failed`, a missing result,
  cancellation, or no thread id. Attempts Codex rejected for an unavailable
  model, and launches that failed before Codex started, are skipped when
  choosing the attempt to resume. Decision: a route change does **not** force a
  cold start, because M0.4 showed a resumed thread accepts a new model and
  effort; the resume runs on the new route.
- M2.7: a warm retry reuses the previous worktree, branch, and base (inspection
  then sees both attempts' commits); after an `integration_conflict` it resumes
  the thread in a fresh worktree at the integration head and tells the worker to
  redo the change there; a missing worktree also gets a fresh one. Cold retries
  always get a fresh worktree.
- M2.8 (observed with a real probe in a scratch repository): resuming a UUID with
  no rollout exits 1, prints nothing on stdout, and writes `Error: thread/resume:
  thread/resume failed: no rollout found for thread id <id> (code -32600)` to
  stderr. The wrapper then relaunches the same prompt as a fresh thread in the
  same worktree and records `resumeFallback` and a `task.resume_fallback` event.
  Also observed: a non-UUID id silently starts a new thread and exits 0; the
  wrapper detects the changed `thread.started` id and records it as
  `thread_replaced`. An expired thread was not observed and is assumed to fail
  like a missing one.
- M2.9: `resumedFromAttemptId` appears in `run resume` (attempt labels,
  pending-retry line, active worker recovery) and as the learning feature
  `warmStart` (true only when the thread really resumed). Older samples without
  the feature still validate.
- M2.10 is guidance in `run.md` plus advice printed by `run retry` after two
  failed warm attempts; the runtime does not escalate a route by itself.
- Model substitution: a warm attempt rejected as unavailable hands its retry to
  the relaunch, which resumes the same thread on the fallback model (tested).
- No state version bump: every new field is optional; a version-5 run retried
  warm in tests.
- Not done: the real-run gate. The implementer could not invoke slash commands;
  the owner must run it.
- Full repository gate: `npm test` passed 163 tests with 0 failures on
  2026-11-15 (9 new in `tests/retry.test.mjs`).

## Milestone 3 — Workers can ask instead of only stopping

Depends on: M2 (uses thread resume).

Before M3, the worker prompt in `renderWorkerBriefing` (`runs.mjs`) told a
worker to report a blocker if it needed any file outside scope, which ended the
attempt.

- [x] **M3.1** Add a `needs_input` terminal state to the worker result schema
  with a typed request: `scope_extension` (paths plus reason) or `question`
  (text plus the options the worker sees). Keep every schema property in
  `required` and nullable, per the 0.5.1 fix.
- [x] **M3.2** Add `run answer <run-id> <task-id>` with `--grant-scope <glob>`,
  `--deny`, and `--reply <text>`. It resumes the same thread in the same
  worktree with the supervisor's answer.
- [x] **M3.3** Record a granted extension on the task, not the lane, and have
  `run inspect` and `run integrate` honor it. Lane scope stays unchanged.
- [x] **M3.4** Refuse a grant that overlaps another active task's write
  surface.
- [x] **M3.5** Add `needs_input` to `lib/outcomes.mjs` as a non-terminal
  outcome so it does not count as a failed attempt in learning data.
- [x] **M3.6** Rewrite the "Required behavior" block of the worker prompt:
  request an extension for a necessary adjacent change, and ask when the
  objective admits two materially different readings, instead of guessing or
  stopping.
- [x] **M3.7** Add a rule to `run.md` section 6: the supervisor may grant an
  extension inside the lane on its own authority, and must ask the user for
  anything outside the lane.
- [x] **M3.8** Cap `needs_input` round trips per task (recommendation: 3) and
  convert further requests to a blocker.
- [x] **M3.9** Tests for grant, deny, reply, overlap refusal, the cap, and
  integration with an extended scope.
- [x] **M3 gate** A real run in which a worker requests one adjacent file,
  receives it, and integrates cleanly without a retry. (`npm test` part met;
  real run done, see "Real-run checks".)

### Milestone 3 evidence

- Built (2026-11-15): a nullable, strict `needs_input` object in the worker
  result schema (`kind` `scope_extension` | `question`, `paths`, `reason`,
  `question`, `options`, all required, no additional properties); a
  `needs_input` task and attempt status that records the request on
  `attempt.inputRequests` with no outcome and a `task.needs_input` event; `run
  answer <run-id> <task-id>` with `--grant-scope <glob>` (repeatable), `--deny`,
  `--reply <text>`, and `--user-approved`; `task.scopeGrants` and
  `effectiveTaskScope`, used by the briefing, `run inspect` (which reports
  `grantedScope`), and `run integrate`; `NON_TERMINAL_OUTCOMES` in
  `lib/outcomes.mjs`; the rewritten "Required behavior" block and a
  "Supervisor answers" briefing section.
- M3.2: `run answer` reuses the M2 resume path in `worker-child.mjs` (`codex
  exec -C <worktree> --sandbox <mode> resume --model ... -c
  model_reasoning_effort=... <thread-id> -`) with the attempt's own model and
  effort, so a substituted model stays substituted, and the task's sandbox. The
  resumed thread gets a short answer message; the spec's new
  `fallbackPromptFile` gives a fresh-thread fallback the full briefing. Each
  round's files live in `workers/<task>/<attempt>/round-<n>/`. A launch failure
  reverts the answer and its grant.
- Decision: an answered task is the **same attempt continuing**, not a linked
  new attempt. Outcomes, retries, `retryCount`, warm-failure escalation, and
  learning samples are all per attempt; a linked attempt would need a terminal
  outcome for the paused one and would count as a retry. Cost: the attempt's
  duration includes the wait for the answer.
- M3.4: a grant is refused when it may overlap the planned-plus-granted scope
  of another write task that is dispatching, running, `needs_input`, or reported
  but not integrated. Glob overlap is conservative (disjoint only when literal
  prefixes or suffixes diverge). M3.7 is also enforced: a grant the lane's
  scope does not provably cover needs `--user-approved`.
- M3.8: at most 3 answered round trips per task, counted across its attempts;
  the next request closes the attempt as `worker_blocked` / `scope_required` or
  `ambiguous_objective` with the request appended to its blockers.
- A paused task holds its pool slot, counts as running for run status, and
  blocks plan and guidance revisions; it cannot be retried, only answered or
  cancelled.
- No state version bump: every new field is optional; version-3 to version-5
  runs load, pause, answer, and retry unchanged (tested with a version-5 run).
  The `needs_input` status is written only by version-6 builds, and no released
  build reads version 6.
- M3.9: `tests/answer.test.mjs` (12 tests, fixture
  `tests/fixtures/fake-codex-ask.mjs`) covers grant with integration, an
  ungranted stray path still refused, deny, reply on a read-only resume,
  overlap refusal, the lane authority rule, the cap, slot holding and
  cancellation, the missing-thread fallback, the substituted model, a
  version-5 run, and a malformed request. Glob, outcome, schema, and docs
  tests were added alongside.
- Not done: the real-run gate. The implementer could not invoke slash commands;
  the owner must run it.
- Full repository gate: `npm test` passed 180 tests with 0 failures on
  2026-11-15.

## Milestone 4 — The supervisor stops hand-polling

Independent of M2 and M3.

- [x] **M4.1** Add `run wait <run-id> [--timeout <seconds>]`. It blocks until
  any active worker changes state, then prints the same payload as `run poll`
  and exits.
- [x] **M4.2** Implement it with `fs.watch` on the status files plus a slow
  fallback interval, so it costs nothing while idle.
- [x] **M4.3** Exit with a distinct code and message on timeout, and when no
  worker is active.
- [x] **M4.4** Rewrite `run.md` section 5: after launching a wave, start
  `run wait` as a background command and continue with verification of anything
  already reported; the harness wakes the supervisor when it exits. Remove the
  instruction to poll in a loop.
- [x] **M4.5** Add a per-task wall-clock limit (plan field `timeoutMinutes`,
  with a default per model tier) and have `run wait` report a worker that
  exceeds it instead of waiting forever.
- [x] **M4.6** Tests with `fake-codex-slow.mjs` for wake-on-completion,
  timeout, and the over-limit report.
- [x] **M4 gate** A three-worker wave completes with one `run wait` per state
  change and no polling calls in the transcript. (`npm test` part
  met; real run done, see "Real-run checks".)

### Milestone 4 evidence

- Built (2026-11-15): `orch run wait <run-id> [--timeout <seconds>] [--interval
  <seconds>] [--no-watch] [--json]` in `scripts/lib/wait.mjs`. It prints the
  `run poll` payload on stdout and a one-line reason on stderr. `pollRunWorkers`
  now marks every update the supervisor must act on with `changed: true`:
  finished (`reported`/`blocked`), `failed`, `cancelled`, `needs_input`,
  `substituted` (M1), a still-running worker whose warm resume newly fell back
  to a fresh thread (M2), and a newly over-limit worker. Paused tasks are listed
  on every poll with `awaitingAnswer: true` until answered.
- M4.3 exit codes: `0` changed, `2` timed out (default 1800 s), `3` no task
  `dispatching`, `running`, or `needs_input`, `4` no worker running and at least
  one paused on a request, `1` error. A paused task holds its slot and counts as
  running for the run, but `run wait` does not wait on it: with only paused
  workers left it returns `4` at once instead of blocking on the supervisor. It
  polls once on start, so a change already on disk returns at once.
- M4.2: it watches each active attempt's runner directory and the run directory
  (directories, because status files are replaced by rename and a file watcher
  goes silent on the old inode), filtered to `status.json`/`result.json`/
  `run.json` and debounced by 100 ms. Every newly armed watcher triggers one
  more poll, closing the gap between a poll and the watcher starting (found by a
  test that intermittently waited 15 s). Correctness never depends on `fs.watch`:
  a fallback poll runs every 15 s (`--interval`), a watcher that errors is
  dropped, and a missed event only delays the wake by at most one interval.
- M4.5: plan field `timeoutMinutes` (positive, at most 1440, fractions allowed),
  else the default for the model the attempt actually runs on: `astra` 120,
  `sol` 90, `terra` 60, `luna` 30 minutes (legacy `gpt-5.6-sol` 90,
  `gpt-5.6-terra` 60). The clock is the current runner's `launchedAt`, so an
  answered round starts a new clock. Over the limit, the poll records
  `attempt.overLimit` and a `task.over_limit` event once per runner and marks
  the update changed; the worker is never stopped, and the briefing shows each
  task's limit and OVER LIMIT. Stopping stays `run cancel`. A timer at the next
  deadline wakes the wait even when the worker's files are quiet.
- M4.4: `run.md` section 5 rewritten around one background `run wait`
  (`run_in_background: true`); the poll-without-blocking instruction is gone and
  `run poll` is described as a one-off check. The `allowed-tools` list is
  unchanged (`run wait` is a `node` command). `resume.md`, the runtime skill,
  README, and `docs/architecture.md` ("Waiting for workers") updated.
- Robustness: `pollRunWorkers` re-reads each task before collecting it, which
  narrows (does not close) the window in which a background wait and a one-off
  `run poll` both try to collect one result; the loser throws, and a wait
  retries a failed poll and gives up only after three in a row.
- No state version bump: `task.timeoutMinutes` and `attempt.overLimit` are
  optional; a version-5 run on `gpt-5.6-sol` waits on its tier default (tested).
- M4.6: `tests/wait.test.mjs` (12 tests). `fake-codex-slow.mjs` gained
  `--delay=<ms>` and `--complete` (defaults unchanged); `fake-codex-resume.mjs`
  gained `--fresh-delay=<ms>`. Covered: wake on completion by file event with a
  60 s fallback (so only the watch can wake it), the fallback path with watching
  off, a change already pending at start, timeout, idle, over-limit reported once
  by the deadline timer (watching off, 60 s fallback) and left running, then
  cancelled, tier defaults and validation, a paused worker
  (wake, listed while another runs, exit 4 when alone), substitution, a resume
  fallback while running, the CLI exit codes and payload, and a version-5 run.
  Doc assertions added to `tests/commands.test.mjs`.
- Not done: the real-run gate. The implementer could not invoke slash commands;
  the owner must run a three-worker wave and check the transcript.
- Full repository gate: `npm test` passed 193 tests with 0 failures on
  2026-11-15, three runs in a row (13 new: 12 in `tests/wait.test.mjs`, 1 in
  `tests/commands.test.mjs`). Wall time 64–67 s against 57 s for the M3 suite
  on the same machine; the new file runs in parallel with the others, and each
  of its tests takes about 2–4 s.

## Milestone 5 — Routing that uses its own evidence

Depends on: M1. Smaller than the gated shadow-routing work in the continual
learning plan; this only shows the supervisor what already happened.

- [x] **M5.1** Add `run routes [--lane <lane>]`: per model and effort, the
  count of attempts, first-attempt acceptance rate, retries, and median
  duration, from local run state only.
- [x] **M5.2** Print the same table for the current lane at the top of
  `run plan` output and in the `run resume` briefing when at least five
  attempts exist.
- [x] **M5.3** Tell the supervisor in `run.md` section 3 to read it before
  routing and to cite it in `routingReason` when it changed a route.
- [x] **M5.4** Exclude legacy-slug attempts from the table by default so
  GPT-5.6 history does not bias routes on the new roster.
- [x] **M5.5** Raise `DEFAULT_MAX_WORKERS` (`runs.mjs`) from 3 to 5, and
  replace "Prefer 3–5 substantial parallel tasks" with guidance to size tasks
  by write-surface independence.
- [x] **M5.6** Tests for the aggregation, the five-attempt threshold, and the
  legacy exclusion.
- [x] **M5 gate** `run routes` matches a hand count on a fixture of saved runs.

### Milestone 5 evidence

- Built (2026-11-15): `orch run routes [--lane <lane>] [--include-legacy] [--json]` in
  `scripts/lib/routes.mjs`, a read-only aggregation over `local/runs/<run-id>/run.json`. It writes
  nothing, does not read the learning store, adds no dependency, and lists a run file it cannot
  load as skipped instead of failing. Per actual model and effort: finished attempts, first-attempt
  acceptance (`accepted/first` and a rate), retries, attempts that ran as a substitute, and median
  duration with its sample size. Everything not counted is listed under "Not counted".
- Counting: attempts are attributed to `attempt.model`, the model that ran. A launch Codex rejected
  as model-unavailable (`modelUnavailable`) and a launch that failed before Codex started
  (`launchFailed`) never reached a worker, so they count for neither model; rejections are listed
  by the rejected slug. `needs_input` rounds are part of their attempt. Open (running or paused) and
  cancelled attempts are not counted. "First attempt" is a task's first attempt that reached a
  worker; later counted attempts, warm or cold, are retries. Attempts saved before outcome records
  are classified from their status.
- Small samples: a first-attempt rate is printed only when at least 5 first attempts back it
  (`ROUTE_RATE_MIN_SAMPLE`); below that the cell shows the counts and `n<5, no rate`. Counts appear
  beside every rate, and the median shows its `n`.
- M5.2: `run plan` (text output, above the run summary), `run briefing`, and `run resume` (briefing
  section and `routes` in `--json`) show the table for the run's lane once it has at least 5
  counted attempts (`ROUTE_TABLE_MIN_ATTEMPTS`). `renderSupervisorBriefing` takes the rendered
  table as an option, so `runs.mjs` still never reads other runs. `run plan --json` is unchanged.
- M5.3: `run.md` section 3 tells the supervisor to run `run routes --lane <lane>` before routing,
  explains the counting and the minimum, and to cite it in `routingReason` when it changed a route.
  `docs/architecture.md` gained a "Route evidence" section.
- M5.4: `gpt-5.6-sol` and `gpt-5.6-terra` attempts are excluded by default and counted with
  `--include-legacy`.
- M5.5: `DEFAULT_MAX_WORKERS` is 5. "Prefer 3–5 substantial parallel tasks" is replaced by sizing
  tasks by write-surface independence without inventing tasks to fill the pool; section 2 states
  the default of 5. Checked for other pool-of-3 assumptions: only `tests/runs.test.mjs` asserted the
  default (now 5). The `--max-workers 3` examples in README and `run.md` are explicit user values,
  the M4 gate's "three-worker wave" is a test scenario, and no help text names a default.
- M5.6 and gate: `tests/routes.test.mjs` (9 tests). A fixture of three saved runs (two in lane
  `api`, one version-5 on `gpt-5.6-sol`; one in lane `web` with an attempt that has no outcome
  record) covers a warm retry with two answered input rounds, an astra launch rejected and
  relaunched on sol, a launch failure, a cancelled first attempt, running and paused attempts, and
  a malformed result; the CLI's JSON equals the hand count written in the test's comment. Also
  covered: withheld and shown rates in the text table, legacy exclusion and `--include-legacy`, all
  lanes, read-only behaviour with an unreadable run, and the five-attempt threshold for `run plan`,
  `run briefing`, and `run resume` (four in the lane: hidden; a fifth in another lane: hidden; a
  fifth in the lane: shown). One doc assertion added to `tests/commands.test.mjs`.
- No state version bump: nothing new is persisted.
- Full repository gate: `npm test` passed 203 tests with 0 failures on 2026-11-15.

## Milestone 6 — Release 0.6.0

- [x] **M6.1** Update `skills/briefing-compiler/SKILL.md` for warm retries and
  worker questions: what belongs in a retry note, when to grant scope.
- [x] **M6.2** Update `skills/orchestrator-runtime/SKILL.md` with `run wait`,
  `run answer`, `run routes`, and the retry options.
- [x] **M6.3** Add a migration note to `README.md`: alias `sol` and `terra` now
  resolve to GPT-6.1, in-flight 0.5.x runs keep their slugs, and `astra` is
  new.
- [x] **M6.4** Write the 0.6.0 `CHANGELOG.md` entry.
- [x] **M6.5** Bump the version in `package.json`, `plugin.json`, and
  `marketplace.json`.
- [ ] **M6.6** Update the project memory file, which still describes the v0.1.0
  compose-over-`/codex:rescue` design. (Skipped here: the file lives outside the
  repository; the owner will update it.)
- [ ] **M6 gate** `npm test` passes; a fresh install from the local checkout
  runs one full `/orchestrator:run` that exercises a warm retry, a scope
  request, and `run wait`. (`npm test` part met; real-run pieces done separately,
  see "Real-run checks".)

### Milestone 6 evidence

- Read end to end on 2026-11-15 against what M1–M5 built: `README.md`,
  `docs/architecture.md`, every file in `plugins/orchestrator/commands/`, both
  skills, and `CHANGELOG.md`.
- M6.1: `briefing-compiler` gained "Retry notes" (say what to change, name the
  decision, keep to the delta, `--fresh` over a longer note, stop after two
  failed warm retries) and "Answering worker requests" (grant the narrowest
  in-lane path, ask the user outside the lane, deny, reply, treat a request as a
  briefing finding); its description names both uses.
- M6.2: the runtime skill already covered `run wait`, `run answer`, and `run
  retry --note/--fresh`; it gained `run routes` and the default pool of 5.
- M6.3: README "Upgrading from 0.5.x": `sol`/`terra` now GPT-6.1, `astra` new,
  bare `gpt-5.6` gone, 0.5.x runs keep their slugs, a mutated old run becomes
  version 6 (which 0.5.x refuses), substitution instead of failure, pool of 5,
  and the removed single-task commands. The README test forbids naming the
  retired slash commands, so the note calls them the `do` and `accept` commands.
- M6.4: 0.6.0 CHANGELOG entry with the breaking changes listed first. It says
  that no real `/orchestrator:run` has exercised the release yet.
- M6.5: version 0.6.0 in `package.json`, `plugin.json`, and both
  `marketplace.json` fields; `tests/metadata.test.mjs` updated.
- Stale or contradictory, and fixed: README "Operational limits" said retries
  start fresh and called a model-unavailable rejection a failed attempt; README
  lacked worker requests, `run wait`, and `run routes` in "What it provides" and
  had a broken line in its intro; `init.md` described the retired
  briefing-and-delegation flow ("report whether delegation will actually work",
  "compiles briefings"); the `orch init` output still said "thread bindings stay
  on this machine"; the `lanes.md` description said lanes "carry context between
  Codex tasks" (that was the lane thread pointer); `resume.md` did not mention
  route evidence; `docs/architecture.md`'s recovery list omitted retry labels,
  paused requests, wall-clock limits, and route evidence, and its failure table
  advised expanding scope for blockers and "retry once" for a malformed result
  (now a warm retry); the tasklist cited line numbers (`runs.mjs:32`, `:415`,
  `:1047`, `:1076`, `:1832`, `:31`, `learning.mjs:1209`, `orch.mjs:88`) that no
  longer match and described M2/M3 "today" behaviour that is gone; they now name
  symbols and use past tense.
- Left as is: the ledger template's "carried into every delegated task"
  (`state.mjs`) is still accurate and only seeds new repositories; the 0.1.0 and
  0.2.0 CHANGELOG entries describe `/orchestrator:do` as history.
- `claude plugin validate .` (Claude Code 2.1.325): "Validation passed" for the
  marketplace manifest. `claude plugin validate plugins/orchestrator`:
  "Validation passed" with one directory warning, `ICON_MISSING` (no plugin
  icon), which does not affect the result.
- Not done: M6.6 (outside the repository) and the real-run gate.
- Full repository gate: `npm test` passed 204 tests with 0 failures on
  2026-11-15.

## Open decisions

1. **Fallback when a tier is unavailable.** Decided 2026-11-15: substitute, do
   not fail. Walk `astra` → `sol` → `terra` → `luna` keeping the effort, and
   never silently (M1.20–M1.26). User pins are substituted too but flagged.
   Legacy 0.5.x slugs are not substituted; they keep their exact slug.
2. **`astra` cost ceiling.** Decided 2026-11-15: no cap; every `astra` route
   requires a `routingReason`.
3. **Legacy `/orchestrator:do`.** Decided 2026-11-15: retired in 0.6.0
   (M1.27–M1.30).
4. **Open: unavailability on API-key logins.** Only the ChatGPT-account
   rejection text was observed. The detector also accepts `model_not_found`,
   which is inferred. Confirm on an API-key login if one is supported.

## Real-run checks

Real runs on Codex CLI 0.169.0 (ChatGPT login) were driven through the
installed plugin's CLI in scratch repositories. Each step of
`/orchestrator:run` was invoked by hand, so the slash command itself has not
been run from a user session.

1. **M1 gate — done** (0.6.1, `945e3d4`, 2026-11-17). One run had tasks on
   `sol`, `terra`, `astra` (an independent verify task), and `luna` (a leaf
   task). There were no substitutions, and each attempt took 0.5 to 1.5 minutes
   at low effort.
2. **M2 gate — done** (same run). A reviewed write task was rejected with
   specific evidence and retried with a note. The retry resumed the same Codex
   thread in the same worktree, its briefing carried the evidence and the note,
   and the worker fixed exactly the reported defect. In 0.6.1 the rejection had
   to go through `run decide --outcome integration_failed`; 0.6.2 makes it
   `run verify --verdict fail`.
3. **M3 gate — done** (`f4784d8`). A `scope_extension` request was granted with
   `run answer --grant-scope`, the task resumed on the same thread, and it
   integrated without a retry. At `945e3d4`, a `question` request was answered
   with `--reply`, and the lane-authority guard refused a grant outside the lane
   without `--user-approved`.
4. **M4 gate — done** (`945e3d4`). Three write workers ran as one wave. Each
   state change came from one background `run wait`, and no `run poll` calls
   were made.
5. **M6 gate — done in parts.** Each piece passed on real Codex: a warm retry, a
   scope request, `run wait`, and the full create → plan → checkpoint → launch
   → inspect → integrate → finalize → cleanup cycle. They were spread across the
   runs above, not done in one run started by the slash command.
6. **Still open:** running `/orchestrator:run` from a session in a user project;
   model-unavailable detection on an API-key login (Open decision 4); any time
   or cost comparison against a single agent doing the same job.

## 0.6.5 roster update (2026-11-18)

`astra` and `sol` now resolve to `gpt-6.2-astra` and `gpt-6.2-sol`. `gpt-6-astra` and
`gpt-6.1-sol` became retired slugs, handled the way the 0.5.x slugs are. Codex CLI 0.169.1
listed both new models. A real `codex exec` accepted each one at `low` and at `ultra`. On real
Codex, one run used the CLI executor and another used the plugin executor. Each ran an `astra`
read and a `sol` write, and Codex's own session logs recorded `gpt-6.2-astra` and `gpt-6.2-sol`.
The CLI run integrated and finalized. In the plugin run, the worker committed a correct change in
its worktree, but integrating it was refused by the branch-drift guard as intended, because the
CLI run had just moved the same branch; that run was cancelled. A new plan that names
`gpt-6.1-sol` is refused with a message naming its replacement. In this repository, `run routes`
now reports 35 attempts on retired slugs and leaves them out unless `--include-legacy` is given.
