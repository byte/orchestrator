# Six ways to use Orchestrator

Use these in Claude Code after [installation](../README.md#install). Replace the example subsystem names with ones in your repository. These are example requests, not claims that any repository has those files or test commands. Claude inspects the code, proposes a bounded lane if needed, and owns the plan, review, and integration. You do not need to fill in a task graph.

## One substantial write task

```text
/orchestrator:run Add cursor pagination to the existing orders endpoint. Keep the current response compatible, cover empty and boundary pages, and use the existing API tests. Keep this as one coherent task if the implementation shares files.
```

A clean committed starting checkout is required for write work. Claude should show the lane boundary once, select a route, independently review the diff, and run trusted checks. A worker saying “tests passed” is not the acceptance gate.

## Independent work in parallel

```text
/orchestrator:run Add the missing input validation for the importer and improve the unrelated CLI help examples. Parallelize only if they own different files; give shared interfaces one owner. Finish with the applicable combined checks.
```

The pool cap is a ceiling, not a utilization target. Ready-task advice favors tasks that unlock dependents, but does not bypass acceptance, checkpoints, or overlapping scope. If work depends on an API decision, the plan can record a few `interfaces` strings; downstream briefings include them and the accepted producer's actual worktree/commits.

## Review the dirty working tree

```text
/orchestrator:run Review my current uncommitted pricing changes, including relevant untracked files. Do not edit them. Look for behavioral defects and give concrete counterexamples, not style advice.
```

Read workers inspect the live checkout, not an immutable copy. Declare the relevant review surface; later observed changes make evidence stale. A changed file needs a renewed review, not just a fresh passing test. Private scratch supports temporary-file tests; tests writing build outputs to the checkout will need a different verification arrangement. Ignored dependencies, external symlink targets, and changes restored between observations are not covered by freshness detection.

## A worker asks for adjacent scope

```text
/orchestrator:run Fix the parser's Unicode handling. Keep writes inside src/parser and its tests; if an adjacent public interface must change, explain why before widening the lane.
```

The worker can pause with a typed scope request. Claude answers in-scope requests, but asks you before a material authority expansion. Only then may it use the owner-approved grant path. Answering resumes the same attempt; it does not spend a retry or make the expanded scope part of the lane forever.

## Resume after interruption

```text
/orchestrator:resume
```

Or name the run's final eight characters. Claude recovers saved checkpoints, active workers, questions, and receipts. This is not autonomous supervision while Claude is absent. Ambiguous Git-process ownership stays stopped: do not remove locks, reset the branch, or globally pick “ours”/“theirs.” A recorded conflict has a deliberate `run retry ... --conflict --note ...` path that preserves commits and prepares a fresh worktree, followed by renewed review and checks.

## A project needing dependencies

```text
/orchestrator:run Implement the validation change in this npm project. First inspect the lockfile and configure repeatable isolated worktree setup with npm ci, lifecycle scripts disabled, and network access only for setup. Do not copy my .env or share writable node_modules. Use the project's existing tests as acceptance.
```

Claude must review the setup command and permissions, configure the lane **before** run creation, and declare every setup input (including any script). See [the npm setup example](../README.md#project-dependencies-and-test-setup). If the project requires lifecycle scripts, decide explicitly whether to permit them. Offline local-package setup has been tested; large registry/native-build projects still need project-specific trials. Worker edits to setup inputs do not authorize running modified setup scripts with setup permissions.

## Operator tools without another platform

From the checkout, `node plugins/orchestrator/scripts/orch.mjs` is the CLI; inside command templates use `${CLAUDE_PLUGIN_ROOT}/scripts/orch.mjs`. There is no required global `orch` installation.

- `preflight --json` identifies the executing plugin copy, versions, pending Git operations, setup, and executor limitations without model calls. Certification remains unknown until separately exercised.
- `run show RUN` explains blocks, questions, review state, active/answer time, and last observed output. Silence alone does not mean a stall.
- `run budget RUN --max-attempts 8 --max-elapsed-minutes 45` limits new dispatch. Add `--max-worker-tokens` only knowing usage is delayed/incomplete. Reaching a budget does not kill current work. Review with the user before explicitly raising or clearing it.
- `run briefing RUN --task TASK --json` includes a byte count and full selected-task authority/acceptance. It omits other task details explicitly; use the full briefing for recovery and run-wide decisions.
- `run check RUN --json` records a baseline or subsequent combined check, not just final verification. A failed sequential check points to earlier passing evidence and intervening integrations as suspects, never proven blame. Preserve the failing receipt in a scoped repair.
- `storage --json` inventories owned resources and advisory cleanup eligibility. It deletes nothing. `run cleanup RUN` rechecks existing cleanup rules; raw run/audit state is retained.
- `diagnostics --json` emits allowlisted aggregate counts/sizes, not raw logs, paths, prompts, or source. Inspect it before sharing; even counts reveal activity. Nothing uploads automatically.
- `ledger add Decisions 'Use the accepted parser interface' --lane api --source 'reviewed commit' --json` records selective durable context. `ledger deprecate Decisions ID --reason 'Replaced by the reviewed v2 interface'` preserves superseded history. Confirmation is never inferred.

Worker stdout/stderr capture retains the first 8 MiB per stream, a visible marker, and the last 64 KiB, so a failing worker's final events survive; huge event lines are skipped while the final report remains separate. Trusted checks/setup retain bounded 32 KiB tails and stop, process group included, on an 8 MiB-per-stream output threshold (trusted `maxOutputBytes` may select 1 KiB–32 MiB). These are capture limits, **not** a filesystem quota for worker-created source, build output, external CLI transcripts, or all run history. Plugin companion response capture is also bounded; an unparseable result is a contract failure, not acceptance.
