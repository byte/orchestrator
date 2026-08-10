# Continual Improvement Implementation Plan

## Purpose

This plan adapts the data-curation and evaluation loop described in Shopify's
[Sidekick continual-learning article](https://shopify.engineering/sidekicks-continual-learning-loop)
to Orchestrator.

Orchestrator can implement continual improvement around evaluation, routing,
prompting, refusal, and escalation behavior. It cannot fine-tune GPT-5.6 model
weights through Codex CLI. Any weight-training workflow remains an optional,
separately authorized external integration.

The implementation must preserve Orchestrator's existing authority and safety
boundaries:

- Claude remains the planner, reviewer, integrator, and final authority.
- Worker reports remain untrusted evidence rather than completion claims.
- Explicit user model and effort pins always win.
- Dispatched attempts never change model or effort silently.
- Scope, cleanliness, declaration, checkpoint, integration, and finalization
  gates remain enforced.
- Raw run data remains local by default and is never silently converted into
  evaluation or training data.

## Data-volume constraint

Shopify's loop is fed by thousands of production sessions. Orchestrator runs on
a single user's machine and will accumulate dozens to low hundreds of attempts
over months. That changes what is credible:

- Statistical apparatus (Cohen's kappa, confusion matrices, train/eval/holdout
  partitions, promotion criteria measured on outcomes) is meaningless until
  enough labeled attempts exist. Build the machinery only when the data
  justifies it.
- The supervisor (Claude) and the user are always present at review time, so
  human adjudication is cheap. Prefer supervisor-plus-single-judge over large
  automated panels.
- The near-term payoff is not model selection statistics; it is turning
  labeled failures into versioned briefing guidance (milestone 4).

Concretely: ship milestones 1–2 now, ship milestone 4's lightweight guidance
path as soon as milestone 1 labels exist, and gate milestones 3 and 5–6 on an
explicit data threshold (at least ~200 labeled terminal attempts, revisited
then).

## Delivery sequence

The work is divided into independently shippable milestones:

1. Normalize outcomes and decisions.
2. Build a privacy-safe learning store.
3. Add rubrics, annotations, and golden evaluations. *(data-gated)*
4. Apply learned refusal and just-in-time guidance (lightweight path first).
5. Implement judge evaluation (single judge first). *(data-gated)*
6. Introduce routing recommendations in shadow mode. *(data-gated)*
7. Optionally integrate an external training system.

Milestones 1–2 form the foundational release and should ship immediately.
Milestone 4's lightweight path depends only on milestone 1. Milestones 3, 5,
and 6 start only after the data threshold above is met.

Pre-integration evaluation of multiple parallel candidate implementations
(N-best sampling with baseline-vs-candidate comparison) is **out of scope** for
this initiative. It is a significant expansion of what Orchestrator does and is
split out into its own future initiative; nothing in this plan may depend on
it.

## 1. Normalize outcomes and decisions

### Objective

Turn free-form failures and blockers into reliable labels without changing the
existing scheduling state machine.

### Tasks

- Define a versioned terminal outcome taxonomy:
  - `accepted`
  - `worker_blocked`
  - `policy_refused`
  - `authority_escalated`
  - `execution_failed`
  - `contract_failed`
  - `verification_failed`
  - `integration_failed`
  - `cancelled`
- Define a separate next-action taxonomy:
  - `execute`
  - `clarify`
  - `replan`
  - `escalate`
  - `refuse`
  - `abstain`
- Add finer `reasonCode` values such as `missing_context`, `scope_required`,
  `ambiguous_objective`, `test_failure`, `branch_drift`, and
  `model_unavailable`.
- Keep learning outcomes separate from task and run lifecycle states.
- Record exactly one terminal outcome per attempt.
- Preserve non-exclusive diagnostic signals separately from the terminal
  category.
- Record classification provenance as automatic, supervisor, user, or imported
  annotation.
- Add typed events for integration refusal and verification failure.
- Preserve outcomes from earlier attempts when a task is retried.
- Maintain backward compatibility with version-4 run state.

### Expected files

- `plugins/orchestrator/scripts/lib/outcomes.mjs` — new
- `plugins/orchestrator/scripts/lib/runs.mjs`
- `plugins/orchestrator/scripts/lib/state.mjs`
- `tests/outcomes.test.mjs` — new
- `tests/runs.test.mjs`

### Verification

- Every terminal path produces exactly one valid outcome.
- Conflicting or invalid classifications are rejected.
- Retried attempts retain their previous outcomes.
- Older run files remain readable.
- Existing lifecycle and retry behavior remains unchanged.

## 2. Build a privacy-safe learning store

### Objective

Derive useful cross-run examples without treating raw transcripts as training
data.

### Tasks

- Define a versioned derived-example schema containing:
  - source run, task, and attempt IDs
  - repository identity hash
  - lane and task kind
  - model, effort, and routing rationale
  - dependency, scope, and acceptance-criterion counts
  - attempt number and duration
  - terminal outcome, action, and reason code
  - verification and finalization result
  - evidence hashes or references
  - redaction, provenance, and consent metadata
- Default-exclude:
  - objectives and user prompts
  - source code and diffs
  - raw model output
  - ledger contents
  - environment variables
  - absolute paths
  - tool output and stderr
- Store derived records under:

  ```text
  .orchestrator/local/learning/
    examples.jsonl
    labels.jsonl
    manifests/
    exports/
  ```

- Use atomic writes, file locking, and file mode `0600`.
- Add deterministic deduplication and source provenance.
- Add configurable retention and targeted purge.
- Add secret and PII redaction before any text-enabled export.
- Require explicit opt-in before including textual fields.
- Add CLI commands:

  ```text
  orch learn collect
  orch learn list
  orch learn inspect <sample-id>
  orch learn label <sample-id>
  orch learn export
  orch learn purge
  ```

### Expected files

- `plugins/orchestrator/scripts/lib/learning.mjs` — new
- `plugins/orchestrator/scripts/lib/redaction.mjs` — new
- `plugins/orchestrator/scripts/orch.mjs`
- `plugins/orchestrator/scripts/lib/state.mjs`
- `tests/learning.test.mjs` — new
- `tests/redaction.test.mjs` — new

### Verification

- Raw prompts and source snippets never enter the default dataset.
- Secret fixtures are redacted before derived artifacts are written.
- Repeated collection is idempotent.
- Purging a source removes all its derived records.
- Exports include schema, filter, redaction-version, provenance, and count
  manifests.
- No command uploads data automatically.

## 3. Add rubrics, annotations, and golden evaluations (data-gated)

Do not start this milestone before the data threshold in
[Data-volume constraint](#data-volume-constraint) is met. Kappa, confusion
matrices, and partitioned holdouts are noise below that volume.

### Objective

Establish trustworthy ground truth before introducing automated judges.

### Tasks

- Define a versioned rubric schema with:
  - criterion ID and description
  - anchored score levels
  - weight
  - required evidence type
  - non-compensatory safety gates
  - rubric version and content hash
- Add criterion-level supervisor results for learning-enabled runs.
- Import reviewed annotations from JSON or JSONL.
- Partition examples into training, evaluation, and frozen holdout sets.
- Prevent source IDs and duplicates from crossing partitions.
- Support balanced random sampling and targeted hard-example sampling.
- Include hard examples from:
  - retries
  - verification failures
  - false blocker or refusal cases
  - route changes
  - scope violations
  - malformed reports
  - final regressions
- Implement evaluation metrics:
  - accuracy
  - precision and recall by action and category
  - false refusal and escalation rate
  - confusion matrix
  - Cohen's kappa
  - success by model and effort
  - retries, duration, and available token usage
- Add CLI commands:

  ```text
  orch eval dataset create
  orch eval dataset add
  orch eval annotate
  orch eval score
  orch eval report
  ```

### Expected files

- `plugins/orchestrator/scripts/lib/rubrics.mjs` — new
- `plugins/orchestrator/scripts/lib/datasets.mjs` — new
- `plugins/orchestrator/scripts/lib/metrics.mjs` — new
- `plugins/orchestrator/scripts/orch.mjs`
- `tests/rubrics.test.mjs` — new
- `tests/metrics.test.mjs` — new
- `tests/datasets.test.mjs` — new

### Verification

- Invalid rubrics and duplicate criterion IDs are rejected.
- Known-value fixtures validate kappa and confusion-matrix calculations.
- Dataset leakage is detected.
- Safety failures cannot be averaged away by high scores elsewhere.
- Reports can be reproduced from a frozen manifest.

## 4. Apply learned refusal and just-in-time guidance

### Objective

Convert labeled outcomes into better runtime briefing and supervisor behavior.
This is the practical, no-weights payoff of the learning loop and should ship
early.

This milestone has two phases:

- **Lightweight path (ships first, depends only on milestone 1):** the
  supervisor injects guidance derived from milestone-1 outcome labels alone.
  Every injected instruction is versioned, provenance-tagged, and reversible.
  No holdout comparison is required — validation is supervisor judgment plus
  the rollback lever.
- **Validated path (data-gated):** once milestone 3 exists, compare
  enabled/disabled guidance against the frozen holdout before promoting
  guidance from provisional to confirmed.

### Tasks

- Map learned actions to supervisor behavior:
  - `clarify` requests a missing material choice
  - `replan` revises task boundaries or dependencies
  - `escalate` requests missing authority or capability
  - `refuse` enforces a policy boundary
  - `abstain` requires supervisor review
- Select guidance by lane, task kind, failure signature, and (when available)
  rubric.
- Inject only compact guidance into worker briefings; mark each item
  provisional or confirmed.
- Give each injected instruction a policy version and provenance.
- Enforce a briefing token budget.
- Never inject raw production examples or untrusted worker prose.
- Roll out initially only for high-confidence refusal and routing cases.

### Expected files

- `plugins/orchestrator/scripts/lib/guidance.mjs` — new
- `plugins/orchestrator/scripts/lib/runs.mjs`
- `plugins/orchestrator/scripts/lib/briefing.mjs`
- `plugins/orchestrator/commands/run.md`
- `tests/guidance.test.mjs` — new
- `tests/briefing.test.mjs`

### Verification

- Only applicable guidance is injected.
- Guidance cannot override user pins, lane constraints, or safety rules.
- Disabling the policy restores the original briefing.
- Resume reconstructs the exact guidance version used.
- (Validated path only) Holdout performance improves without increasing false
  refusals.

## 5. Implement judge evaluation (single judge first, data-gated)

### Objective

Apply judge-based curation to high-risk cases while keeping the supervisor as
the final authority. Because the supervisor and user are present at review
time, v1 is **one independent judge plus supervisor adjudication** — not a
panel. Multi-judge consensus (Shopify-style) is a later extension, adopted
only if single-judge agreement with supervisor labels proves insufficient.

Judges are dispatched over real, configured routes — for example a GPT-5.6
Codex worker at a distinct effort tier, or a Claude judge — resolved from
configuration rather than hard-coded identities.

### Tasks

- Define a strict judge-result schema containing:
  - sample ID
  - judge identity and resolved route
  - rubric version and hash
  - criterion scores
  - terminal category
  - recommended action
  - evidence references
  - `pass`, `fail`, or `abstain`
  - confidence
  - prompt and runner versions
- Add first-class judge state to runs, designed so a single judge is a
  one-member panel (the schema supports N judges; v1 configures one).
- Treat candidate content and worker prose as delimited, untrusted data.
- Aggregation rules (apply identically at N=1 and N>1):
  - all safety gates must pass
  - automatic acceptance requires unanimous action and category
  - any abstention or disagreement requires supervisor review
  - individual votes remain stored after aggregation
- If a multi-judge panel is later enabled: launch judges blinded and in
  parallel, ensuring they cannot see one another's results.
- Persist incomplete judge runs so `/orch:resume` can continue safely.
- Add a supervisor adjudication queue.
- Add CLI commands:

  ```text
  orch run judge start
  orch run judge status
  orch run judge resolve
  ```

### Expected files

- `plugins/orchestrator/scripts/lib/judges.mjs` — new
- `plugins/orchestrator/scripts/lib/runs.mjs`
- `plugins/orchestrator/scripts/lib/workers.mjs`
- `tests/judges.test.mjs` — new
- `tests/workers.test.mjs`

### Verification

- A fixed judge fixture produces deterministic aggregation at N=1 and N=3.
- Disagreement and abstention require supervisor adjudication.
- Prompt-injection text cannot alter judge instructions.
- Interrupted judge runs resume without duplicate votes.
- Individual votes, routes, prompt hashes, and rubric hashes remain auditable.

## 6. Introduce routing recommendations in shadow mode (data-gated)

Do not start this milestone before the data threshold in
[Data-volume constraint](#data-volume-constraint) is met; promotion criteria
below are only meaningful against a credible outcome sample.

### Objective

Use evaluated outcomes to improve model and effort selection without
surrendering supervisor control.

### Tasks

- Extract stable routing features:
  - task kind
  - scope breadth
  - dependency fan-out
  - novelty signal
  - acceptance measurability
  - test-coverage evidence
  - previous attempts and failure causes
  - comparable historical outcomes
- Create a deterministic, versioned routing policy before considering a learned
  model.
- Record:
  - policy version
  - feature snapshot
  - recommended route
  - predicted risk
  - supervisor-selected route
  - override reason
  - actual outcome
- Run recommendations only in shadow mode initially.
- Compare recommendations against supervisor choices and resulting outcomes.
- Gate promotion on:
  - no increase in verification escapes
  - no increase in false refusals or escalations
  - maintained or improved success rate
  - measurable latency or cost benefit
- Never override explicit user model or effort pins.
- Never change an already-dispatched attempt's route.
- Support rollback to a previous policy version.

### Expected files

- `plugins/orchestrator/scripts/lib/routing-policy.mjs` — new
- `plugins/orchestrator/scripts/lib/runs.mjs`
- `plugins/orchestrator/commands/run.md`
- `tests/routing-policy.test.mjs` — new
- `tests/runs.test.mjs`

The existing uncommitted routing additions in
`plugins/orchestrator/commands/run.md` must be preserved and incorporated rather
than overwritten.

### Verification

- Shadow recommendations never affect dispatch.
- User pins always win.
- Policy versions and overrides survive resume.
- Route changes are traceable to evaluated evidence.
- Rollback restores the previous behavior exactly.

## 7. Optional external training adapter

### Objective

Permit separately authorized model training without making hosted training a
core Orchestrator dependency.

### Tasks

- Define an exporter interface for reviewed, sanitized datasets.
- Require explicit trainer configuration and user authorization.
- Record dataset, trainer, base-model, recipe, and artifact provenance.
- Evaluate trained candidates through the same frozen evaluation and promotion
  gates.
- Do not add a hosted service, account, telemetry, or background upload by
  default.
- Never export hidden reasoning traces.

## Documentation and release work

Each milestone must update the relevant operational documentation in the same
change:

- `README.md`
- `docs/architecture.md`
- `plugins/orchestrator/commands/run.md`
- `plugins/orchestrator/commands/resume.md`
- `plugins/orchestrator/skills/orchestrator-runtime/SKILL.md`
- CLI help in `plugins/orchestrator/scripts/orch.mjs`
- release metadata and `CHANGELOG.md` when a milestone is released

Documentation must distinguish:

- raw audit state from curated learning records
- supervisor labels from worker self-reports
- offline evaluation from runtime behavior
- shadow recommendations from active routing policy
- continual improvement from actual model-weight training

## Overall completion criteria

The initiative is complete when:

- Raw run artifacts remain local and are never silently promoted into datasets.
- Every terminal attempt has a machine-readable outcome and provenance.
- Guidance injection is versioned, provenance-tagged, and reversible.
- Golden evaluations, once built, are reproducible and leakage-checked.
- Judge disagreement safely abstains.
- Routing remains advisory until measured promotion criteria pass.
- Data-gated milestones have not started before the data threshold is met.
- Explicit user pins and supervisor authority remain intact.
- Existing scope, worktree, checkpoint, and finalization invariants do not
  regress.
- Existing and new privacy, consensus, replay, refusal, routing, and recovery
  tests pass.

## Baseline evidence

Before implementation, the repository test suite passed:

```text
npm test
86 tests passed, 0 failed
```

The checkout was on `main`. The pre-existing uncommitted change to
`plugins/orchestrator/commands/run.md` was not created by this plan and must be
preserved during implementation.

## Implementation status

- Milestone 0 — plan and tasklist: completed and committed as `57ceb89`.
- Milestone 1 — normalized outcomes: completed on 2026-08-10. The focused
  outcomes/run gate passed 39 tests, the outcomes/run/workers/CLI gate passed
  72 tests, and the full repository gate passed 109 tests. Version-3 and
  version-4 state remains readable without guessed backfills.
- Next: Milestone 2 — privacy-safe learning store.
