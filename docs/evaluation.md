# Bounded evaluation tooling

This is a six-case frozen smoke benchmark, not evidence that Orchestrator beats Claude. It prepares disposable Git repositories and grades explicitly supplied files with trusted observable checks. It has no dependencies beyond Node, Git and (for grading) a working `codex sandbox` executable on the trusted PATH. There is no daemon, network service, automatic model call, account discovery, transcript scan or learning integration.

## Cases and what a pass means

The versioned seeds, task text and declared deliverable paths live in `evaluation/cases.json`. Assertions live outside candidate trees in `evaluation/check.mjs`. `list` reports their scale and an incorrect approach each case rejects.

| Case | Observable checks | Important limit |
| --- | --- | --- |
| `localized-bug` | Zero, negative values, both bounds, unchanged in-range values and equal bounds | One numeric helper, not a bug hunt across a repository |
| `independent-parts` | Both slug normalization and whitespace-aware initials, including empty inputs | Two tiny independent files, not a parallel speedup measurement |
| `interface-dependent` | Producer's object contract, invalid-input rejection and consumer's aggregate output | One producer and one consumer, not a large API migration |
| `offline-dependency` | Frozen app/vendor preserved, identical regular installed package files and actual package-import output | Tiny offline local copy/bootstrap only; no registry, native build or network coverage |
| `dirty-review` | Dirty tracked and untracked source preserved; two machine-readable counterexamples independently recomputed and executed | Counterexample validity, not subjective review prose or arbitrary repository review |
| `interrupted-integration` | All eight interrupted/conflicting/applied/completed states, no state mutation and duplicate-completion prevention | **Protocol mechanics simulation**, not real Git conflict recovery or a real model-quality comparison |

The focused tests demonstrate every seed failing, a valid implementation passing, and a plausible partial/incorrect implementation failing. A completion claim or worker report cannot cause a pass. The public cases and checks are intentionally visible: this is not a hidden test set or an adversarial anti-cheating benchmark. Freeze a revision before trials; do not tune these cases after seeing one arm's answer.

## CLI

Run from the checkout (or use an absolute script path):

```sh
node scripts/evaluate.mjs list
node scripts/evaluate.mjs prepare --case localized-bug --dest /tmp/eval-claude-01
node scripts/evaluate.mjs prepare --case localized-bug --dest /tmp/eval-orchestrator-01
```

`--dest` must not exist and its parent must exist. Omit it for a fresh OS temporary directory. JSON output names the `repo/` workspace, adjacent `task.md`, adjacent `metadata.json`, baseline commit and suite digest. Preparation commits only the fixture seed in a newly initialized disposable repository; it never commits this checkout. The dirty-review case deliberately modifies a tracked file and adds an untracked file after that baseline commit. No models run during preparation.

Read the generated task and fill in its metadata file. After a candidate has been produced, use the trusted harness from this checkout, **not a candidate copy of the harness**:

```sh
node scripts/evaluate.mjs grade --case localized-bug \
  --candidate /tmp/eval-claude-01/repo \
  --metadata /tmp/eval-claude-01/metadata.json \
  --out /tmp/eval-claude-01/receipt.json

node scripts/evaluate.mjs grade --case localized-bug \
  --candidate /tmp/eval-orchestrator-01/repo \
  --metadata /tmp/eval-orchestrator-01/metadata.json \
  --out /tmp/eval-orchestrator-01/receipt.json

node scripts/evaluate.mjs compare \
  --left /tmp/eval-claude-01/receipt.json \
  --right /tmp/eval-orchestrator-01/receipt.json
```

Grade/compare print JSON; optional `--out` creates a new file and refuses overwrite. A grade receipt must be outside the candidate directory. Exit codes are `0` for pass (or successful prepare/list/compare), `1` for observed candidate failure, and `2` for invalid input or unavailable grading infrastructure. A missing/broken sandbox never falls back to executing candidate code on the host. Keep failed receipts too; a script using `set -e` must explicitly handle grade's expected exit `1`. A receipt records the selected files' content hashes, a candidate digest, case/suite digests, Node version, check timestamps, outcome and bounded sandbox output. The suite digest covers this CLI, the manifest, trusted assertions and the existing checks/exec sandbox modules. Grader duration is separate from the manually recorded trial duration.

Only the manifest's declared deliverable files are copied into a fresh snapshot. Candidate Git configuration, hooks, test commands and replacement grader scripts are not executed. The original candidate is not modified. Extra files are ignored, so a pass is **not** a whole-tree scope audit; inspect the final diff separately. Offline setup's installed files are copied even if Git ignores `node_modules`. Files are limited to 64 KiB each (at most six files), symlinks/special files are rejected, and no candidate Git commands are used during grading. Stop all candidate writers before grading; concurrent path replacement is outside this lightweight tool's threat model.

The existing `executeCheck` runs the trusted Node assertion process under Codex's read-only, network-disabled sandbox with a 15-second timeout and private writable scratch. Its candidate probes have a 2-second timeout and 8 KiB capture limit, and run as separate child processes under that sandbox. The assertion parent compares returned data, so a candidate calling `process.exit(0)` cannot skip the assertions. Receipts retain at most 4,096 characters each of stdout/stderr plus a 512-character infrastructure error. If process-group termination cannot be established, the receipt reports the retained snapshot/capture paths and process group for manual diagnosis instead of deleting potentially live state.

This uses the existing sandbox's guarantees; it is not a separate VM or a security audit of hostile code. A read-only sandbox can still read host-visible files. Candidate probe environments omit account credentials and ambient Node preload options, but do not treat the machine as a secret-isolation boundary. Use a disposable account/machine without secrets for untrusted candidates, keep Node/Git/Codex/PATH and this harness trusted, and review receipts before sharing them. No package lifecycle script is run by the grader.

## Metadata: explicit measurements, not inferred usage

Preparation emits a template with nulls. Set `arm` to `claude` or `orchestrator`, and `trialKind` to `live` only when a person explicitly chose to run a real-model trial. Handwritten/test candidates use `mechanics`. The integration-protocol case requires `mechanics` even if a model wrote its implementation.

Fields:

- `matchId`: a pair/repetition identifier chosen before starting (for example `localized-01`).
- `conditions.supervisorModel`, `supervisorEffort`, `workerModel`, `workerEffort`: exact planned model identifiers and effort settings for the experiment's two-arm lineup. Both arms record the same lineup; direct Claude does not use its declared worker settings. If an arm changes settings during a trial, it is not the same matched condition.
- `conditions.claudeVersion`, `codexVersion`, `orchestratorVersion`: explicitly supplied tool/plugin versions (use a revision/dirty identifier for locally modified tools). Both arms record the full same tool lineup, including tools unused by one arm. No version command or account scan is automatically run.
- `conditions.timeLimitSeconds`: the common declared wall-clock budget, including planning/setup/retries/integration. The human enforces it; the CLI does not supervise a live session. Freeze any additional resource/tool-access constraints in the trial notes before starting.
- `elapsedSeconds`: human-measured time from task handoff to the final frozen candidate or budget expiry, including setup, supervisor work, retries and human repair. This is not grading time.
- `humanInterventions`: count corrections/clarifications/manual repairs after initial handoff. Record details in trial notes outside the candidate; an unknown count stays null.
- `usage.worker` and `usage.supervisor`: separate `{ inputTokens, outputTokens, cachedInputTokens, costUsd }` objects. Each value is a nonnegative number (token counts integers) or null. Manually sum worker usage only when per-worker readings are available. Direct Claude usage belongs under supervisor. Report zero for an unused worker only when that absence is known; missing telemetry is null, not zero. Do not invent cost from token counts, merge unknown and known totals, or double-count cached input as extra input.

Omitted measurements normalize to null. Incomplete metadata is permitted for individual grades; comparison requires a nonempty `matchId` and every condition known. Comparison rejects different arms' mismatched case/suite/case digests, match IDs, trial kinds, model/effort/tool lineup, wall budget or grader Node version, as well as same-arm pairs and unavailable grades. It presents each arm's outcome, elapsed time, intervention count and separate usage without estimating a winner, confidence interval, significance or causal benefit. Metadata and receipts are local, unsigned, self-reported evidence, not independently authenticated telemetry. Unknown outcome measurements remain visible as null and are never used to calculate a fake efficiency score.

## Supported manual live-trial workflow (opt-in)

No live trial has to run to use or test this tooling. The CLI has no automatic launch mode.

1. Choose a frozen harness revision and a small predeclared set of cases/repetitions. Prepare two fresh workspaces per case. Use the same task text (only the workspace path differs), starting files, supervisor model/effort, tool lineup and wall budget. Alternate/randomize arm order and keep sessions independent; do not share one arm's solution with the other. Keep prior results out of the sessions.
2. **Only after explicitly opting into model calls**, start a fresh manual Claude session in the first `repo/`, supply its `task.md`, and complete the direct-Claude arm without Orchestrator worker delegation. Start the timer at handoff. Do not provide trusted checks or reference solutions as task context.
3. In a separate fresh manual Claude session in the other `repo/`, supply its `task.md` and explicitly choose the installed `/orchestrator:run` workflow. Use the declared supervisor/worker models and efforts. The supervisor may decompose independent work or sequence interface-dependent work. Include its planning, worker retries, verification and integration in elapsed time. This document does not prescribe or automatically launch a worker pool.
4. Stop on completion or budget expiry and freeze the actual candidate files. Grade incomplete candidates as they stand. Record model settings, versions, human interventions, elapsed time and whatever worker/supervisor usage is genuinely visible in that trial's UI or explicitly exported readings. Never discover credentials, scrape accounts or scan global transcripts to fill gaps. Leave unavailable readings null.
5. Grade both supplied candidate directories using this trusted checkout. Keep receipts outside candidate trees. Run `compare` only for genuinely matched conditions. Retain failures and unavailable infrastructure results, note order and interventions, and describe results case by case. The mechanics-only protocol case is not included in live model-quality claims. These six tiny visible cases cannot establish general superiority, reliability on real repositories or production cost savings.
6. Dispose of only the generated trial directories after saving desired receipts. The tooling never writes `.orchestrator` learning/outcome records. If manually invoking Orchestrator itself produces synthetic local learning in a disposable trial repo, keep it there and delete it with the trial; never import it into a real repository's learning store.

## Focused offline validation

```sh
node --test tests/evaluate.test.mjs
```

These public CLI tests use a temporary, explicitly labelled sandbox-protocol fixture on PATH and trusted handwritten candidates. They verify preparation, true positive/negative grading, receipt bounds, no host fallback when Codex is missing, metadata preservation and comparison mismatch rejection. They do **not** prove OS sandbox containment, run real models or compare model quality. The production CLI always calls the existing `executeCheck`; there is no host-execution bypass option. Run a separately approved sandbox smoke check on a disposable machine if platform containment needs validation. The full repository suite is a separate end-of-work check.
