# Continual Improvement Implementation Tasklist

This is the execution tracker for
[the implementation plan](./continual-learning-implementation-plan.md). Complete
milestones in order unless a dependency is explicitly marked otherwise. Each
major milestone must leave the repository shippable and pass its exit gate
before work begins on the next milestone.

## Working rules

- [ ] Preserve the existing uncommitted changes in
  `plugins/orchestrator/commands/run.md`.
- [ ] Keep raw run artifacts local and self-ignored.
- [ ] Do not add uploads, telemetry, hosted services, or training dependencies.
- [ ] Do not use worker self-reports as ground truth.
- [ ] Keep Claude as final reviewer and integration authority.
- [ ] Preserve explicit user model and effort pins.
- [ ] Maintain backward compatibility with version-4 state.
- [ ] Run targeted tests after each task and `npm test` at every milestone gate.

## Milestone 1 — Normalized outcomes

### Schema and classification

- [x] **M1.1** Add `lib/outcomes.mjs` with terminal outcome, action, reason-code,
  signal, and provenance enums.
- [x] **M1.2** Add validators that require one terminal outcome and reject
  conflicting classifications.
- [x] **M1.3** Define precedence rules for cases with multiple observable
  failures.
- [x] **M1.4** Add an optional versioned outcome record to attempts without
  breaking existing run files.
- [x] **M1.5** Preserve outcome history when `retryTask` clears the current task
  result.

### Runtime integration

- [x] **M1.6** Classify successful supervisor verification as `accepted`.
- [x] **M1.7** Classify worker-declared blockers as `worker_blocked` with a
  structured reason code.
- [x] **M1.8** Distinguish process execution failures from malformed result
  contracts.
- [x] **M1.9** Record supervisor verification failures explicitly.
- [x] **M1.10** Record integration refusal and integration failure events.
- [x] **M1.11** Record policy refusal, authority escalation, and cancellation
  without conflating them with implementation failure.
- [x] **M1.12** Surface attempt outcomes in the supervisor resume briefing.

### Tests and gate

- [x] **M1.13** Add unit tests for every terminal outcome and action.
- [x] **M1.14** Add retry-history and older-state compatibility tests.
- [x] **M1.15** Add negative tests for invalid and conflicting labels.
- [x] **M1.16** Run `node --test tests/outcomes.test.mjs tests/runs.test.mjs`.
- [x] **M1.17** Run `npm test`.
- [x] **M1 gate** Confirm lifecycle behavior is unchanged and all newly recorded terminal
  attempts have exactly one auditable outcome.

### Milestone 1 evidence

- Built: versioned outcome taxonomy, compatible action/reason validation,
  supervisor dispositions, retryable integration diagnostics, structured worker
  blocker codes, and attempt-history briefing output.
- Backward compatibility: version-3 and version-4 runs without outcomes remain
  readable and render an explicit legacy-unclassified marker.
- Targeted gate: `node --test tests/outcomes.test.mjs tests/runs.test.mjs`
  passed 39 tests with 0 failures on 2026-08-10.
- Cross-module gate: `node --test tests/outcomes.test.mjs tests/runs.test.mjs
  tests/workers.test.mjs tests/cli.test.mjs` passed 72 tests with 0 failures on
  2026-08-10.
- Full repository gate: `npm test` passed 109 tests with 0 failures on
  2026-08-10.

## Milestone 2 — Privacy-safe learning store

Depends on: Milestone 1.

### Storage and derivation

- [x] **M2.1** Add `lib/learning.mjs` and define the derived-example schema.
- [x] **M2.2** Create `.orchestrator/local/learning/` lazily on first use.
- [x] **M2.3** Implement deterministic sample IDs and deduplication.
- [x] **M2.4** Derive metadata-only examples from run JSON and typed events.
- [x] **M2.5** Hash repository identity and remove absolute paths.
- [x] **M2.6** Exclude prompts, objectives, source code, diffs, raw output,
  ledger text, stderr, tool output, and environment variables by default.
- [x] **M2.7** Use atomic writes, locks, and mode `0600` for derived artifacts.

### Privacy and lifecycle

- [x] **M2.8** Add `lib/redaction.mjs` with secret and PII fixture coverage.
- [x] **M2.9** Require explicit opt-in before any textual field is included.
- [x] **M2.10** Record consent, provenance, schema version, and redaction version.
- [x] **M2.11** Add configurable retention metadata.
- [x] **M2.12** Implement targeted purge by source run, task, attempt, or sample.
- [x] **M2.13** Ensure raw audit records and derived learning records have
  separate retention behavior.

### CLI

- [x] **M2.14** Implement `orch learn collect`.
- [x] **M2.15** Implement `orch learn list` and `orch learn inspect`.
- [x] **M2.16** Implement `orch learn label` with provenance.
- [x] **M2.17** Implement local-only `orch learn export` with a manifest.
- [x] **M2.18** Implement `orch learn purge`.
- [x] **M2.19** Add CLI help and unknown-option validation.

### Tests and gate

- [x] **M2.20** Test idempotent collection and deterministic IDs.
- [x] **M2.21** Test default exclusion of every sensitive field.
- [x] **M2.22** Test secret and PII redaction before writes.
- [x] **M2.23** Test complete targeted purge.
- [x] **M2.24** Test export manifests and prove no network activity is required.
- [x] **M2.25** Run targeted learning, redaction, CLI, and state tests.
- [x] **M2.26** Run `npm test`.
- [x] **M2 gate** Confirm no raw text enters learning records without explicit
  opt-in and all derived data is traceable and removable.

### Milestone 2 evidence

- Built: strict metadata-only examples with keyed source references,
  deterministic IDs and fingerprints, byte-stable upserts, local label history,
  managed export wrappers/manifests, configurable retention, and hierarchical
  purge.
- Privacy: base records use an explicit allowlist; text exists only in a managed
  export with named fields, user or supervisor consent, an acknowledgement
  receipt, and redaction before truncation and first write.
- Resilience: one live-owner-aware store lock protects every mutation; files and
  directories enforce `0600`/`0700`; symlink ancestors are refused; corrupt and
  incomplete exports are removed conservatively during purge.
- Targeted gate: `node --test --test-reporter=spec tests/learning.test.mjs
  tests/redaction.test.mjs tests/cli.test.mjs` passed 50 tests with 0 failures
  on 2026-08-10; the CLI suite includes state-version compatibility coverage.
- Full repository gate: `npm test` passed 134 tests with 0 failures on
  2026-08-10.

## Milestone 3 — Rubrics and golden evaluations

Depends on: Milestone 2.

### Rubrics and annotations

- [ ] **M3.1** Add `lib/rubrics.mjs` with a versioned rubric schema.
- [ ] **M3.2** Validate unique criterion IDs, anchored scales, score ranges,
  evidence requirements, and safety gates.
- [ ] **M3.3** Record rubric version and hash with every evaluation.
- [ ] **M3.4** Add criterion-level supervisor results for learning-enabled runs.
- [ ] **M3.5** Implement reviewed JSON/JSONL annotation import.
- [ ] **M3.6** Keep imported labels distinct from automatic and supervisor
  labels.

### Dataset management

- [ ] **M3.7** Add `lib/datasets.mjs` and a versioned dataset manifest.
- [ ] **M3.8** Implement train, evaluation, and frozen-holdout partitions.
- [ ] **M3.9** Prevent duplicate or shared source IDs across partitions.
- [ ] **M3.10** Implement balanced random sampling.
- [ ] **M3.11** Implement hard-example sampling for retries, verification
  failures, false refusals, route changes, scope violations, malformed results,
  and final regressions.
- [ ] **M3.12** Require explicit promotion into a golden dataset.

### Metrics and CLI

- [ ] **M3.13** Add `lib/metrics.mjs`.
- [ ] **M3.14** Implement accuracy, precision, recall, false-refusal rate, and
  confusion matrices.
- [ ] **M3.15** Implement Cohen's kappa with known-value fixtures.
- [ ] **M3.16** Report success, retries, duration, and available token usage by
  model and effort.
- [ ] **M3.17** Implement `orch eval dataset create|add`.
- [ ] **M3.18** Implement `orch eval annotate`.
- [ ] **M3.19** Implement `orch eval score|report`.

### Tests and gate

- [ ] **M3.20** Test invalid rubrics, duplicate criteria, and missing anchors.
- [ ] **M3.21** Test non-compensatory safety gates.
- [ ] **M3.22** Test dataset leakage and deterministic partitions.
- [ ] **M3.23** Test metric calculations against fixed expected values.
- [ ] **M3.24** Run targeted rubric, dataset, metric, and CLI tests.
- [ ] **M3.25** Run `npm test`.
- [ ] **M3 gate** Produce a reproducible evaluation report from a frozen,
  leakage-checked manifest.

## Milestone 4 — Independent judge groups

Depends on: Milestone 3.

### Judge protocol

- [ ] **M4.1** Add `lib/judges.mjs` and the versioned judge-result schema.
- [ ] **M4.2** Record judge identity, model, effort, rubric hash, prompt hash,
  evidence references, criterion scores, verdict, category, action, and
  confidence.
- [ ] **M4.3** Add first-class `judgeGroup` state to runs.
- [ ] **M4.4** Launch blinded Sol, Terra, and Luna judges independently.
- [ ] **M4.5** Prevent judges from reading one another's votes.
- [ ] **M4.6** Render candidate data as typed, delimited, untrusted input.

### Consensus and recovery

- [ ] **M4.7** Implement deterministic unanimous category/action consensus.
- [ ] **M4.8** Make any safety-gate failure block automatic acceptance.
- [ ] **M4.9** Route abstention, disagreement, and malformed votes to supervisor
  adjudication.
- [ ] **M4.10** Preserve every individual vote after aggregation.
- [ ] **M4.11** Make panel collection idempotent across polling and resume.
- [ ] **M4.12** Reconstruct pending judges, completed votes, and adjudication
  state in the resume briefing.

### CLI, tests, and gate

- [ ] **M4.13** Implement `orch run judge start|status|resolve`.
- [ ] **M4.14** Add consensus, abstention, disagreement, and malformed-vote
  tests.
- [ ] **M4.15** Add prompt-injection tests for judge and arbiter inputs.
- [ ] **M4.16** Add interruption and resume tests without double-counting.
- [ ] **M4.17** Run targeted judge, worker, run, and CLI tests.
- [ ] **M4.18** Run `npm test`.
- [ ] **M4 gate** Confirm no judge panel can bypass supervisor authority and all
  disagreement safely abstains.

## Milestone 5 — Pre-integration candidate evaluation

Depends on: Milestone 4.

### Candidate lifecycle

- [ ] **M5.1** Add `lib/experiments.mjs`.
- [ ] **M5.2** Add `proposed`, `running`, `candidate_ready`, `evaluating`,
  `accepted`, and `rejected` candidate states.
- [ ] **M5.3** Add `reviewOf` relationships that do not require prior
  integration.
- [ ] **M5.4** Freeze candidate commits while evaluation is active.
- [ ] **M5.5** Record repository SHA, briefing, rubric, dataset, route, runner,
  and Codex CLI versions.

### Comparison and promotion

- [ ] **M5.6** Run baseline and candidate against identical frozen cases.
- [ ] **M5.7** Persist per-criterion deltas and regressions.
- [ ] **M5.8** Require explicit supervisor promotion.
- [ ] **M5.9** Reuse existing scope, declaration, cleanliness, commit, and
  integration gates for the selected candidate.
- [ ] **M5.10** Ensure rejected candidates never alter supervisor `HEAD`.
- [ ] **M5.11** Preserve experiment evidence after worktree cleanup.

### Tests and gate

- [ ] **M5.12** Test immutable candidate review.
- [ ] **M5.13** Test reproducible baseline/candidate comparison.
- [ ] **M5.14** Test rejection without integration-head changes.
- [ ] **M5.15** Test that only the selected candidate can integrate.
- [ ] **M5.16** Run targeted experiment, worktree, worker, and run tests.
- [ ] **M5.17** Run `npm test`.
- [ ] **M5 gate** Demonstrate evaluation and rejection of a candidate without
  changing the supervisor checkout.

## Milestone 6 — Shadow routing recommendations

Depends on: Milestones 3 and 5 plus a sufficient reviewed sample set.

### Policy and features

- [ ] **M6.1** Add `lib/routing-policy.mjs`.
- [ ] **M6.2** Extract task kind, scope breadth, dependency fan-out, novelty,
  acceptance measurability, test evidence, prior failures, and comparable
  outcomes.
- [ ] **M6.3** Define a deterministic versioned routing policy before using a
  learned model.
- [ ] **M6.4** Record feature snapshot, policy version, recommendation,
  predicted risk, selected route, override reason, and actual outcome.
- [ ] **M6.5** Preserve and incorporate the existing `run.md` routing guidance.

### Shadow evaluation and promotion

- [ ] **M6.6** Generate recommendations without affecting dispatch.
- [ ] **M6.7** Compare recommendations with supervisor selections and outcomes.
- [ ] **M6.8** Measure verification escapes, false refusals, success, retries,
  duration, and available token usage.
- [ ] **M6.9** Define evidence thresholds for promoting a policy from shadow
  mode.
- [ ] **M6.10** Guarantee explicit user pins always win.
- [ ] **M6.11** Guarantee dispatched attempts retain their persisted routes.
- [ ] **M6.12** Add version rollback.

### Tests and gate

- [ ] **M6.13** Test that shadow recommendations cannot affect task claims.
- [ ] **M6.14** Test user pins and route persistence.
- [ ] **M6.15** Test policy auditability across resume.
- [ ] **M6.16** Test exact rollback behavior.
- [ ] **M6.17** Run targeted routing, run, and command tests.
- [ ] **M6.18** Run `npm test`.
- [ ] **M6 gate** Keep the policy in shadow mode unless the frozen evaluation
  shows improved efficiency with no quality or safety regression.

## Milestone 7 — Refusal and just-in-time guidance

Depends on: Milestone 6 promotion evidence.

### Runtime behavior

- [ ] **M7.1** Add `lib/guidance.mjs`.
- [ ] **M7.2** Map `clarify`, `replan`, `escalate`, `refuse`, and `abstain` to
  explicit supervisor behavior.
- [ ] **M7.3** Match guidance by lane, task kind, failure signature, and rubric.
- [ ] **M7.4** Inject only evaluated, compact guidance into worker briefings.
- [ ] **M7.5** Record policy version and provenance for every injected item.
- [ ] **M7.6** Enforce a briefing token budget.
- [ ] **M7.7** Prohibit raw production examples and untrusted worker prose from
  guidance.
- [ ] **M7.8** Add a complete policy disable and rollback path.

### Evaluation and gate

- [ ] **M7.9** Compare enabled and disabled behavior on the frozen holdout.
- [ ] **M7.10** Measure false refusal, unnecessary escalation, success, and
  verification escape rates.
- [ ] **M7.11** Test that guidance cannot override user pins, lane constraints,
  or safety rules.
- [ ] **M7.12** Test exact guidance reconstruction after resume.
- [ ] **M7.13** Run targeted guidance, briefing, run, and command tests.
- [ ] **M7.14** Run `npm test`.
- [ ] **M7 gate** Activate only guidance that improves holdout performance
  without increasing refusal or safety errors.

## Milestone 8 — Optional external training adapter

Depends on: Explicit user authorization and a concrete trainer and serving
contract. This milestone is not part of the core release.

- [ ] **M8.1** Define a trainer-neutral sanitized export interface.
- [ ] **M8.2** Require explicit configuration and authorization for each export.
- [ ] **M8.3** Record dataset, trainer, base model, recipe, and artifact
  provenance.
- [ ] **M8.4** Exclude hidden reasoning traces.
- [ ] **M8.5** Evaluate trained candidates through the same frozen evaluation
  and promotion gates.
- [ ] **M8.6** Confirm core Orchestrator still has no hosted-service, telemetry,
  account, or background-upload dependency.

## Documentation and release checklist

Complete the applicable items at every milestone:

- [ ] Update `README.md` for user-visible behavior and commands.
- [ ] Update `docs/architecture.md` for state, recovery, and failure behavior.
- [ ] Update command definitions under `plugins/orchestrator/commands/`.
- [ ] Update `plugins/orchestrator/skills/orchestrator-runtime/SKILL.md`.
- [ ] Update CLI help and examples.
- [ ] Update release metadata and `CHANGELOG.md` when releasing.
- [ ] Distinguish raw audit state, curated examples, offline evaluation, shadow
  policy, active policy, and external training.
- [ ] Inspect the final rendered Markdown and all referenced paths.
- [ ] Run `npm test` and record the exact result.

## Final acceptance checklist

- [ ] Raw artifacts remain local and are never silently promoted.
- [ ] Every terminal attempt has one machine-readable outcome and provenance.
- [ ] Derived records are sanitized, traceable, bounded, and removable.
- [ ] Golden evaluations are frozen, reproducible, and leakage-checked.
- [ ] Judge disagreement and abstention cannot auto-promote work.
- [ ] Candidate evaluation occurs before integration.
- [ ] Rejected candidates do not change supervisor `HEAD`.
- [ ] Routing remains advisory until promotion criteria pass.
- [ ] Explicit user pins and supervisor authority remain intact.
- [ ] Scope, worktree, checkpoint, integration, and finalization invariants do
  not regress.
- [ ] Privacy, consensus, replay, refusal, routing, recovery, and full repository
  tests pass.
