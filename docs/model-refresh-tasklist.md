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

- [x] **M1.1** Replace `WORKER_MODELS` in `scripts/lib/runs.mjs:32` with the
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
- [x] **M1.5** Make the unsupported-model error at `runs.mjs:415` list the new
  aliases, and add a specific message when a new plan names a legacy slug.
- [x] **M1.6** Update the worker prompt header at `runs.mjs:1047` so it no
  longer says "GPT-5.6 pool".
- [x] **M1.7** Replace the hardcoded model and effort lists in
  `scripts/lib/learning.mjs:1209` with values derived from `WORKER_MODELS` plus
  the legacy set, so learning examples from old runs still validate.
- [x] **M1.8** Update `--model` help text in `scripts/orch.mjs:88` to
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
- [ ] **M1 gate** `npm test` passes, and one real `/orchestrator:run` completes
  with at least one task on each of `astra`, `sol`, and `terra`. (`npm test`
  part met; the real run is outstanding, see evidence.)

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

Today `retryTask` (`runs.mjs:1832`) clears the result and the verification and
relaunches a fresh `codex exec` with the original prompt. The worker learns
nothing from the failure.

- [ ] **M2.1** Persist the supervisor's failed-verification evidence and the
  integration failure detail on the attempt record before `retryTask` clears
  the task-level fields.
- [ ] **M2.2** Add a `run retry --note "<what to change>"` option that stores a
  supervisor correction on the next attempt.
- [ ] **M2.3** Add a "Previous attempt" section to the worker prompt: outcome,
  supervisor evidence, the retry note, and the files the last attempt changed.
  This is ordinary briefing text, separate from the fixed-template guidance
  block.
- [ ] **M2.4** Add a `resumeThreadId` field to the worker spec and have
  `scripts/worker-child.mjs` call `codex exec resume <id>` when it is set.
- [ ] **M2.5** Default retries to resuming the previous thread when the
  previous attempt reached a result or a verification verdict. Start fresh when
  it crashed, produced no thread id, or the route changed (subject to M0.4).
- [ ] **M2.6** Add `run retry --fresh` to force a cold start.
- [ ] **M2.7** Decide worktree handling on a resumed retry. Recommendation:
  reuse the previous worktree when the supervisor rejected the work, recreate
  it when integration failed on a conflict.
- [ ] **M2.8** Fall back to a fresh launch, with a recorded event, when Codex
  reports the thread as missing or expired.
- [ ] **M2.9** Record `resumedFromAttemptId` on the attempt and surface it in
  `run resume` and the learning features.
- [ ] **M2.10** Lift "Retry transient worker failures once" in `run.md`
  section 7: transient failures retry once cold, verification failures retry
  warm with a note, and two warm failures on the same task escalate one tier.
- [ ] **M2.11** Add a `tests/fixtures/fake-codex-resume.mjs` fixture and tests
  for warm retry, forced fresh retry, missing-thread fallback, and the rendered
  "Previous attempt" section.
- [ ] **M2 gate** In a real run, a deliberately failed verification is retried
  and the worker's second attempt references the supervisor's evidence.

## Milestone 3 — Workers can ask instead of only stopping

Depends on: M2 (uses thread resume).

Today the prompt at `runs.mjs:1076` tells a worker to report a blocker if it
needs any file outside scope, which ends the attempt.

- [ ] **M3.1** Add a `needs_input` terminal state to the worker result schema
  with a typed request: `scope_extension` (paths plus reason) or `question`
  (text plus the options the worker sees). Keep every schema property in
  `required` and nullable, per the 0.5.1 fix.
- [ ] **M3.2** Add `run answer <run-id> <task-id>` with `--grant-scope <glob>`,
  `--deny`, and `--reply <text>`. It resumes the same thread in the same
  worktree with the supervisor's answer.
- [ ] **M3.3** Record a granted extension on the task, not the lane, and have
  `run inspect` and `run integrate` honor it. Lane scope stays unchanged.
- [ ] **M3.4** Refuse a grant that overlaps another active task's write
  surface.
- [ ] **M3.5** Add `needs_input` to `lib/outcomes.mjs` as a non-terminal
  outcome so it does not count as a failed attempt in learning data.
- [ ] **M3.6** Rewrite the "Required behavior" block of the worker prompt:
  request an extension for a necessary adjacent change, and ask when the
  objective admits two materially different readings, instead of guessing or
  stopping.
- [ ] **M3.7** Add a rule to `run.md` section 6: the supervisor may grant an
  extension inside the lane on its own authority, and must ask the user for
  anything outside the lane.
- [ ] **M3.8** Cap `needs_input` round trips per task (recommendation: 3) and
  convert further requests to a blocker.
- [ ] **M3.9** Tests for grant, deny, reply, overlap refusal, the cap, and
  integration with an extended scope.
- [ ] **M3 gate** A real run in which a worker requests one adjacent file,
  receives it, and integrates cleanly without a retry.

## Milestone 4 — The supervisor stops hand-polling

Independent of M2 and M3.

- [ ] **M4.1** Add `run wait <run-id> [--timeout <seconds>]`. It blocks until
  any active worker changes state, then prints the same payload as `run poll`
  and exits.
- [ ] **M4.2** Implement it with `fs.watch` on the status files plus a slow
  fallback interval, so it costs nothing while idle.
- [ ] **M4.3** Exit with a distinct code and message on timeout, and when no
  worker is active.
- [ ] **M4.4** Rewrite `run.md` section 5: after launching a wave, start
  `run wait` as a background command and continue with verification of anything
  already reported; the harness wakes the supervisor when it exits. Remove the
  instruction to poll in a loop.
- [ ] **M4.5** Add a per-task wall-clock limit (plan field `timeoutMinutes`,
  with a default per model tier) and have `run wait` report a worker that
  exceeds it instead of waiting forever.
- [ ] **M4.6** Tests with `fake-codex-slow.mjs` for wake-on-completion,
  timeout, and the over-limit report.
- [ ] **M4 gate** A three-worker wave completes with one `run wait` per state
  change and no polling calls in the transcript.

## Milestone 5 — Routing that uses its own evidence

Depends on: M1. Smaller than the gated shadow-routing work in the continual
learning plan; this only shows the supervisor what already happened.

- [ ] **M5.1** Add `run routes [--lane <lane>]`: per model and effort, the
  count of attempts, first-attempt acceptance rate, retries, and median
  duration, from local run state only.
- [ ] **M5.2** Print the same table for the current lane at the top of
  `run plan` output and in the `run resume` briefing when at least five
  attempts exist.
- [ ] **M5.3** Tell the supervisor in `run.md` section 3 to read it before
  routing and to cite it in `routingReason` when it changed a route.
- [ ] **M5.4** Exclude legacy-slug attempts from the table by default so
  GPT-5.6 history does not bias routes on the new roster.
- [ ] **M5.5** Raise `DEFAULT_MAX_WORKERS` (`runs.mjs:31`) from 3 to 5, and
  replace "Prefer 3–5 substantial parallel tasks" with guidance to size tasks
  by write-surface independence.
- [ ] **M5.6** Tests for the aggregation, the five-attempt threshold, and the
  legacy exclusion.
- [ ] **M5 gate** `run routes` matches a hand count on a fixture of saved runs.

## Milestone 6 — Release 0.6.0

- [ ] **M6.1** Update `skills/briefing-compiler/SKILL.md` for warm retries and
  worker questions: what belongs in a retry note, when to grant scope.
- [ ] **M6.2** Update `skills/orchestrator-runtime/SKILL.md` with `run wait`,
  `run answer`, `run routes`, and the retry options.
- [ ] **M6.3** Add a migration note to `README.md`: alias `sol` and `terra` now
  resolve to GPT-6.1, in-flight 0.5.x runs keep their slugs, and `astra` is
  new.
- [ ] **M6.4** Write the 0.6.0 `CHANGELOG.md` entry.
- [ ] **M6.5** Bump the version in `package.json`, `plugin.json`, and
  `marketplace.json`.
- [ ] **M6.6** Update the project memory file, which still describes the v0.1.0
  compose-over-`/codex:rescue` design.
- [ ] **M6 gate** `npm test` passes; a fresh install from the local checkout
  runs one full `/orchestrator:run` that exercises a warm retry, a scope
  request, and `run wait`.

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
