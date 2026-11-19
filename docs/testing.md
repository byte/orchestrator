# Local verification

No dependencies, hosted CI, automatic installation, or model calls are needed for the automated suites. Tests create disposable repositories, worker processes, fake Codex/companion implementations, and sandbox-protocol shims. A protocol pass is not OS sandbox containment or model-quality certification.

Run from the repository root:

```sh
npm run test:fast
npm run test:protocol
npm test
npm run test:repeat
npm run test:repeat -- --load
```

- **fast**: glob, redaction, rendering, release-metadata, and outcome tests. This intentionally small set avoids worker/watcher orchestration; it is not the acceptance gate for a runtime change.
- **protocol**: every other `tests/*.test.mjs` file, including state/Git/check/setup/evaluation tests. New test files enter this set automatically unless explicitly assigned to fast.
- **full** (`npm test`): every file, concurrency 2, unfiltered. Older Node releases lacking `--test-concurrency` (including the runtime baseline 18.18) fall back to one file at a time, with separate TAP summaries. Fast and protocol are complementary subsets of full. The earlier 354-test baseline took 643.5 seconds on Node 22/macOS; use the actual TAP durations for this revision, not that number as a deadline.
- **repeat**: lock, event-wait, and cleanup-race tests, twice. Stops at the first failed iteration; never retries a failed test or summarizes a later success as if the failure disappeared.
- **repeat --load**: the same group while one helper consumes roughly 20 ms of CPU per 50 ms interval. This is modest contention, not a machine-saturation benchmark or a guarantee of zero timing failures everywhere. The helper stops when the runner exits.

The runner prints file counts, exit status, and wall time for each iteration; TAP includes individual durations. Preserve failed logs when diagnosing races. A timeout is an observation, not proof that the timeout should be increased. Use fixture handshakes for lifecycle ordering and controlled inputs at deadline logic boundaries. Capability unavailable/skipped is not passed. Test processes do not inspect your real Codex/Claude sessions unless a test explicitly opts into isolated test fixtures.

For review evidence, store logs under locally excluded `.amp/in/artifacts/`; do not commit machine-local paths or transcripts. For example:

```sh
npm test > .amp/in/artifacts/full-suite.tap 2>&1
```

Create/exclude that directory first if your checkout does not already have it. The command's exit status matters: do not replace it with a successful `tail` or merge selective reruns into a claimed full pass.

## Live verification stays opt-in

[Compatibility recipes](compatibility.md) separate no-model sandbox probes from authenticated worker trials, and require positive controls where appropriate. Record the exact distributed plugin path and revision, executor, OS/CLI versions, fallback, and what was actually exercised. A source-checkout test is not proof that an installed plugin cache is current. No blanket certification flag is inferred from preflight.

[Evaluation tooling](evaluation.md) prepares fixed disposable cases and independently grades selected candidate files. Live Claude-alone versus orchestrated trials consume account usage and require explicit opt-in. Repeated matched trials, including failure/intervention/usage records, are needed before claiming fewer interventions, faster completion, or better correctness. The tiny authored cases do not establish large-repository performance or satisfy learned-routing data gates.
