# Continual Improvement Implementation Tasklist

This is the execution tracker for
[the implementation plan](./continual-learning-implementation-plan.md). Complete
milestones in dependency order. Milestone 4A is the explicit early exception
and may ship before data-gated Milestone 3. Each major milestone must leave the
repository shippable and pass its exit gate before dependent work begins.

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

Status: data-gated until the learning store contains approximately 200
genuinely reviewed terminal attempts. Fixtures, automatic-only labels, and
worker self-reports do not satisfy this threshold.

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

## Milestone 4 — Refusal and just-in-time guidance

Milestone 4A depends on completed Milestones 1–2 but is exempt from the
reviewed-data threshold and may ship before Milestone 3.
Milestone 4B is data-gated and depends on Milestone 3.

### Phase A — Lightweight provisional guidance

- [x] **M4A.1** Add `lib/guidance.mjs` with versioned guidance-policy and
  guidance-selection schemas.
- [x] **M4A.2** Map `clarify`, `replan`, `escalate`, `refuse`, and `abstain` to
  deterministic advisory behavior.
- [x] **M4A.3** Derive eligibility only from typed Milestone-1 outcome fields
  with explicit supervisor or user provenance. One such explicit review is
  sufficient only for this opt-in provisional phase; it is not promotion
  evidence.
- [x] **M4A.4** Match provisional guidance by opaque lane, task kind, and typed
  prior-attempt outcome/action/reason signature without requiring rubrics or
  datasets.
- [x] **M4A.5** Keep guidance advisory: it may change briefing text but cannot
  mutate task state, dispatch routes, or authority decisions.
- [x] **M4A.6** Render only fixed, compact instructions under character, token,
  and item budgets.
- [x] **M4A.7** Prohibit objectives, prompts, production examples, evidence,
  worker/tool output, source text, ledger text, and free-form instructions.
- [x] **M4A.8** Persist item IDs, policy version/hash, provenance, provisional
  status, and exact attempt snapshots for resume.
- [x] **M4A.9** Add an explicit run-level off switch and exact rollback.
- [x] **M4A.10** Preserve model/effort pins, lane constraints, safety rules,
  scope, and supervisor authority.
- [x] **M4A.11** Add selection, non-match, action-mapping, deterministic
  rendering, and strict-schema tests.
- [x] **M4A.12** Add canary and budget tests proving raw text cannot enter
  guidance or exceed the briefing bounds.
- [x] **M4A.13** Test disable, rollback, corrupt-policy recovery, policy-selection
  membership, version-4 compatibility, checkpoint invalidation, and exact
  resume reconstruction.
- [x] **M4A.14** Run targeted guidance, briefing, run, CLI, and learning tests.
- [x] **M4A.15** Run `npm test`.
- [x] **M4A gate** Confirm provisional guidance is bounded, reversible,
  replayable, advisory only, and based solely on reviewed typed outcomes.

### Milestone 4A evidence

- Built: versioned fixed-template policies, opaque metadata-only source
  selection, bounded retry briefing blocks, state-version-5 policy archives,
  exact task/attempt snapshots, and explicit CLI enable, disable, and rollback.
- Safety and recovery: every changed selection invalidates the current
  checkpoint; routes, pins, scope, constraints, lifecycle, and authority stay
  independent; selections must belong to a retained policy; malformed active
  or unrelated history cannot block the emergency off or valid rollback path.
- Backward compatibility: version-3 and version-4 runs remain readable and
  upgrade to explicit disabled guidance on mutation; version-5 files missing
  guidance or carrying future/malformed guidance fail closed.
- Targeted gate: `node --test --test-reporter=spec tests/guidance.test.mjs
  tests/briefing.test.mjs tests/runs.test.mjs tests/cli.test.mjs
  tests/learning.test.mjs` passed 101 tests with 0 failures on 2026-08-10.
- Full repository gate: `npm test` passed 156 tests with 0 failures on
  2026-08-10.

### Phase B — Validated guidance

Do not start before Milestone 3 and the reviewed-data threshold.

- [ ] **M4B.1** Add optional rubric-aware guidance matching.
- [ ] **M4B.2** Compare enabled and disabled behavior on the frozen holdout.
- [ ] **M4B.3** Measure false refusal, unnecessary escalation, success, and
  verification-escape rates.
- [ ] **M4B.4** Promote guidance from provisional to confirmed only when the
  frozen evaluation improves without a quality or safety regression.
- [ ] **M4B gate** Produce reproducible promotion evidence tied to policy,
  rubric, dataset, and holdout hashes.

## Milestone 5 — Independent judge evaluation

Depends on: Milestone 3 and the reviewed-data threshold.

### Judge protocol

- [ ] **M5.1** Add `lib/judges.mjs` and a versioned N-member judge schema.
- [ ] **M5.2** Record judge identity, resolved route, rubric/prompt hashes,
  evidence references, criterion scores, verdict, category, action, and
  confidence.
- [ ] **M5.3** Start with one configured independent judge plus supervisor
  adjudication; do not hard-code a model family or three-member panel.
- [ ] **M5.4** Render evaluation input as typed, delimited, untrusted input.
- [ ] **M5.5** Preserve every vote and make interrupted evaluation resumable.

### Consensus, CLI, and gate

- [ ] **M5.6** Implement deterministic N=1 and N>1 aggregation with
  non-compensatory safety gates.
- [ ] **M5.7** Route abstention, disagreement, and malformed votes to supervisor
  adjudication.
- [ ] **M5.8** Implement `orch run judge start|status|resolve`.
- [ ] **M5.9** Add N=1/N=3, prompt-injection, interruption, and resume tests.
- [ ] **M5.10** Run targeted judge, worker, run, and CLI tests.
- [ ] **M5.11** Run `npm test`.
- [ ] **M5 gate** Confirm judges cannot bypass supervisor authority and all
  abstention or disagreement safely defers.

Pre-integration N-best candidate experiments remain a separate future
initiative and are not a dependency of this plan.

## Milestone 6 — Shadow routing recommendations

Depends on: Milestone 3 and a sufficient reviewed sample set.

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

## Milestone 7 — Optional external training adapter

Depends on: Explicit user authorization and a concrete trainer and serving
contract. This milestone is not part of the core release.

- [ ] **M7.1** Define a trainer-neutral sanitized export interface.
- [ ] **M7.2** Require explicit configuration and authorization for each export.
- [ ] **M7.3** Record dataset, trainer, base model, recipe, and artifact
  provenance.
- [ ] **M7.4** Exclude hidden reasoning traces.
- [ ] **M7.5** Evaluate trained candidates through the same frozen evaluation
  and promotion gates.
- [ ] **M7.6** Confirm core Orchestrator still has no hosted-service, telemetry,
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
- [ ] Routing remains advisory until promotion criteria pass.
- [ ] Explicit user pins and supervisor authority remain intact.
- [ ] Scope, worktree, checkpoint, integration, and finalization invariants do
  not regress.
- [ ] Privacy, consensus, replay, refusal, routing, recovery, and full repository
  tests pass.
