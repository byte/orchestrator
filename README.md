# orchestrator

A Claude Code supervisor for a pool of Codex workers.

`orchestrator` keeps Claude in the main thread as planner, scheduler, reviewer, replanner,
integrator, and user-facing manager. Bounded execution tasks run in parallel through detached
Codex CLI processes routed to `gpt-6.2-astra`, `gpt-6.2-sol`, `gpt-6.1-terra`, or `gpt-5.6-luna`.
Durable run state, checkpoints, evidence, and project memory let the supervisor recover after
context compaction, interruption, or a new Claude Code session.

The supervisor is whichever Claude model owns the Claude Code session — Claude Opus and Claude
Fable are both supported, specifically Claude Opus 5.5 and Claude Fable 5.2.
Nothing in the plugin selects or switches the supervising model; run
`/orchestrator:run` from the session whose model you want managing the pool. Only the worker
model is selected by the plugin; every resolved worker route is pinned to its attempt.

The important boundary is simple: Codex workers produce scoped work and evidence; Claude decides
what should happen, what is acceptable, what gets integrated, and when the whole run is done.

## What it provides

- A task DAG planned and owned by the supervising Claude model
- A supervisor-routed mixed pool of exact Astra, Sol, Terra, and Luna workers
- Recorded, never-silent fallback down the model ladder when Codex rejects a model as unavailable
- One detached `codex exec` process per task: write tasks in an isolated Git worktree, read and
  verify tasks in your checkout as it is, uncommitted files included
- Read-only sandboxes for analysis/review tasks and workspace-write sandboxes for implementation.
  A read-only worker can run tests that need only a private writable `TMPDIR`, not writes to its checkout.
- JSON-schema-enforced worker reports with files, tests, decisions, assumptions, blockers, and
  confidence
- Versioned terminal attempt outcomes that distinguish execution, contract, verification, policy,
  authority, integration, cancellation, and acceptance decisions
- Scope, cleanliness, declaration, commit, and branch-drift gates before integration
- Supervisor verification for every task and a separate combined final gate
- Durable run JSON, append-only events, worker handles, Codex thread IDs, checkpoints, and evidence
- A private, local-only learning store derived from allowlisted run metadata, with managed exports
  and complete derived-data purge controls
- Opt-in provisional guidance compiled only from reviewed typed outcomes, with fixed templates,
  bounded briefing injection, durable replay, and one-command disable or rollback
- A committed ledger for stable project facts that should survive across machines
- Warm retries that resume the failed worker's Codex thread and tell it what the supervisor found
  wrong, with `--fresh` for a cold start
- Worker questions: a worker that needs an adjacent file or faces an ambiguous objective pauses
  with a typed request, and the supervisor's answer resumes the same attempt
- A blocking `run wait` that wakes the supervisor when a worker changes state, instead of polling
- A read-only route-evidence table (`run routes`) showing how each model and effort actually
  performed in this repository's saved runs
- Deliberate retry, cancellation, replanning, conflict abort, and cleanup paths

## Requirements

- macOS or Linux (POSIX process groups are required; Windows is not supported)
- Claude Code with plugin support
- Node.js 18.18 or newer
- Git, with at least one commit in the repository
- [Codex CLI](https://developers.openai.com/codex/cli/) installed and authenticated

Workers use the account already authenticated in Codex CLI. The plugin does not require its own
OpenAI API key, change your Codex authentication, or grant model access; the selected model must
be available to that account. If it is not, the runtime substitutes the next model down the ladder
and records that it did; see the routing section below.

`/orchestrator:run` invokes Codex CLI directly. No Claude-side Codex plugin is needed.

### Project dependencies and test setup

Read and verify tasks run in your checkout, so they use the dependencies, virtual environments,
and build products already there. They cannot write it; a private `TMPDIR` takes their temporary
files, so tests that write only temporary output can run.

Each write task starts in a fresh Git worktree that contains only committed files. Ignored files
such as `node_modules` are not copied into it. For repeatable provisioning, configure a trusted
setup command before creating a run:

```bash
orch lane add api --setup '{"argv":["npm","ci","--ignore-scripts","--cache",".cache"],"inputs":["package.json","package-lock.json"],"network":true,"timeoutSeconds":600}'
```

Review this command and its network permission before using it. Ignore `.cache/` and dependency
outputs in Git. Setup gets write access only to the isolated worktree and private scratch, never
the supervisor checkout or shared dependency caches. It must leave source unchanged. List its
script, manifests, lockfiles, and other installation inputs explicitly. Nothing copies `.env`
files or credentials. Lifecycle scripts are off in this npm example; enable them only deliberately.

Setup finishes before any model worker starts, and its execution receipt is stored on the
worktree. A failure is `setup_failed`, not a coding failure. `run retry` retries setup in the same
worktree without a model call until setup passes; `--fresh` instead creates a pristine worktree.
Warm retries reuse successful setup only while the declared input contents match. If setup needs
rerunning after worker source changes, preserve the old worktree and use `--fresh`: the supervisor
never executes worker-modified setup scripts. Lanes without setup keep their previous manual
provisioning behavior. An offline npm install with a local dependency has been exercised with the
real Codex sandbox; large dependency graphs and network installs still need project-level trials.

## Install

### From GitHub

In Claude Code:

```text
/plugin marketplace add byte/orchestrator
/plugin install orchestrator@orchestrator
/reload-plugins
/orchestrator:init
```

This installs whatever is on the marketplace repository's default branch, which is not necessarily
the newest local work.

### From a local checkout

Point the marketplace at the working copy instead of GitHub. Use this to run unreleased changes, or
to develop the plugin itself:

```text
/plugin marketplace add /absolute/path/to/orchestrator
/plugin install orchestrator@orchestrator
/reload-plugins
/orchestrator:init
```

The path must be the repository root — the directory holding `.claude-plugin/marketplace.json`,
not `plugins/orchestrator`. Claude Code records it as a `directory` marketplace source.

Installing **copies** the plugin into `~/.claude/plugins/cache/orchestrator/orchestrator/<version>`.
The install is a snapshot, not a live link to the checkout, so editing files in the repository does
not change the installed plugin. After changing plugin sources, refresh the marketplace and
reinstall:

```text
/plugin marketplace update orchestrator
/plugin install orchestrator@orchestrator
/reload-plugins
```

Because the cache path contains the version, a stale install can sit alongside a much newer
checkout. Check what is actually installed:

```bash
cat ~/.claude/plugins/installed_plugins.json
```

If the recorded `version` is behind `plugins/orchestrator/.claude-plugin/plugin.json`, reinstall
before assuming a fix is live.

### Verify

`/orchestrator:init` creates the repository state and reports exact remedies for missing Codex CLI,
authentication, or Git prerequisites. Run it inside the repository you want orchestrated, not
inside this plugin's own checkout.

If `/orchestrator:*` commands do not appear after installing, run `/reload-plugins`, then confirm
the marketplace and plugin are both registered:

```bash
cat ~/.claude/plugins/known_marketplaces.json
```

## Quick start

Tell it what you want done:

```text
/orchestrator:run add cursor pagination to the users API
```

That is the whole interface. Claude reads the repository, works out which subsystem the objective
touches, and proposes a lane — the write boundary, standing constraints, and definition of
done — for you to confirm. You do not have to define one first.

From there Claude proposes a dependency-aware plan, records a checkpoint capturing the reasoning
and model-routing choices behind it, and asks for confirmation when new authority is needed.
Independent ready tasks launch into separate worktrees, up to 5 at a time by default
(`--max-workers` changes it). The supervisor remains responsive: it
starts one background `run wait` that wakes it when a worker changes state, instead of polling,
reviews their structured evidence, integrates passing write tasks, and
replans or retries when evidence invalidates the current route.

Model and effort are automatic by default. During planning, Fable or Opus must assign every task
an exact `model`, `effort`, and concise `routingReason`, after reading `run routes` for what each
route actually achieved in this repository:

| Alias | Exact slug | Use it for |
| --- | --- | --- |
| `astra` | `gpt-6.2-astra` | Work where a wrong result is expensive or hard to catch, and deep verification |
| `sol` | `gpt-6.2-sol` | The default for anything non-trivial: implementation, debugging, architecture |
| `terra` | `gpt-6.1-terra` | Well-bounded everyday coding and review |
| `luna` | `gpt-5.6-luna` | Last resort: mechanical work whose checks catch a bad result immediately |

Every model accepts every effort from `low` through `ultra`. Effort defaults to `high` on `sol` and
`astra`. A `luna` task cannot be one that other tasks depend on unless you pin the run to `luna`.
The runtime rejects an unresolved task instead of silently falling back to a default model, and
rejects family names such as `gpt-6` that do not name a tier.

If Codex rejects a model as unavailable to your account, the task is relaunched on the next model
down `astra` → `sol` → `terra` → `luna` with the same effort, and the rest of the run skips the
unavailable model. The substitution is recorded on the attempt and in the run events, and shown by
`run poll`, `/orchestrator:resume`, and the supervisor briefing; a substituted pin is flagged so
Claude tells you which model actually ran.

### When to use it

It pays off when the work splits into pieces that touch different files and can be checked
separately: several modules, a feature plus an independent review, a fix in one subsystem and its
tests in another. Each task costs a briefing, a worktree, a worker, and a supervisor review, so a
one-file change is usually quicker to ask Claude for directly.

Keep the lane's definition of done passing before you start. Claude runs it before planning,
because workers are told to meet it: a check that already fails sends every worker asking for files
outside its scope.

### When you want exact control

Everything the conversation infers can be stated outright. Name a lane, pin the pool, or define the
write boundary yourself:

```text
/orchestrator:lanes add api \
  --scope 'src/api/**' \
  --scope 'tests/api/**' \
  --constraint 'No new production dependencies' \
  --done 'API tests and the full repository test suite pass'

/orchestrator:run api --max-workers 3 add cursor pagination to the users API
```

Use `--model astra|sol|terra|luna` only when you deliberately want to pin the entire pool to one
model.
Use `--effort <level>` only when you want to pin effort across the run. A conflicting task route is
rejected. Exact resolved routes are saved on the plan and every attempt so resume and audit cannot
silently change them.

Resume the same manager after interruption or compaction:

```text
/orchestrator:resume
/orchestrator:resume 729b948c
```

With no argument it finds the open run itself, or asks which one when there are several. Every run
command also takes the full id, `latest`, or a unique fragment of at least 6 characters such as the id's last 8.
To see the runs, newest first with status, age, and progress:

```text
orch run list [--open]
```

Resume polls workers first and reconstructs the supervisor briefing from disk. It does not create a
replacement run or rely on conversational memory.

### Upgrading to 0.6.5

- `astra` and `sol` now resolve to `gpt-6.2-astra` and `gpt-6.2-sol`; `terra` and `luna` are
  unchanged. New plans and pins cannot name `gpt-6-astra` or `gpt-6.1-sol`.
- Runs saved earlier, including in-flight ones, keep their persisted `gpt-6-astra` or
  `gpt-6.1-sol` slugs on resume and retry, as 0.5.x runs keep theirs. Those slugs are off the
  fallback ladder, so if Codex later rejects one, re-route the task with `run plan`.
- `run routes` reports attempts on the retired slugs separately; pass `--include-legacy` to count
  them.

### Upgrading from 0.5.x

- The aliases `sol` and `terra` now resolve to `gpt-6.2-sol` and `gpt-6.1-terra`, not the GPT-5.6
  models. `astra` (`gpt-6.2-astra`) is new. The bare `gpt-5.6` alias is gone, and family names such
  as `gpt-6` or `gpt-6.1` are rejected because they do not name a tier.
- Runs saved by 0.5.x, including in-flight ones, keep their persisted `gpt-5.6-sol` or
  `gpt-5.6-terra` slugs on resume and retry. New plans cannot select those slugs. Any change to an
  old run rewrites it as state version 6, which 0.5.x refuses to open, so finish or abandon a run
  with one release.
- A model Codex rejects as unavailable is no longer a plain failure: the task relaunches one rung
  down the ladder and the substitution is recorded and shown, including for a pinned model.
- New runs default to 5 concurrent workers instead of 3.
- The legacy single-task `do` and `accept` slash commands are removed, together with
  `orch brief`, `orch accept`, and `orch lane bind|unbind`. Use `/orchestrator:run` for single
  tasks too. Existing
  `.orchestrator/local/threads.json` files still load; nothing writes lane thread pointers any more.

## Lifecycle

1. **Plan.** Claude first runs the lane's definition-of-done check on the current head and settles
   any failure before dispatch. It then turns the objective into bounded `write`, `read`, and `verify` tasks with scope,
   dependencies, constraints, and checkable acceptance criteria, and routes each one using the
   lane's route evidence when there is enough of it.
2. **Launch.** Ready tasks claim pool capacity. A write task gets a fresh worktree (a warm retry
   reuses its task's) and needs a clean checkout; a read or verify task runs in the checkout as
   it is. Each gets an exact model and effort,
   least-privilege sandbox, authoritative briefing, and required result schema.
3. **Monitor.** Detached process IDs, status files, JSONL events, Codex thread IDs, outputs, and
   worktree paths are persisted under `.orchestrator/local/`. A worker that needs one adjacent
   file outside its scope, or faces an objective with two materially different readings, pauses
   as `needs_input` with a typed request instead of stopping. Claude answers with `run answer`,
   and the same attempt continues on the same Codex thread in the same worktree. Claude does not
   poll: one `run wait` runs as a background command and exits when a worker finishes, fails,
   pauses, is substituted, falls back from a missing thread, or exceeds its wall-clock limit, and
   Claude Code wakes the supervisor when it exits.
4. **Review.** Worker output becomes `reported`, never automatically complete. Claude evaluates the
   evidence and acceptance criteria, and runs the checks itself. A read task is passed or failed
   with `run verify`; a write task passes only by integration, and one that fails review is
   rejected with `run verify --verdict fail` and specific evidence for the retry. Terminal attempt outcomes are recorded separately from task
   lifecycle state so retries retain an auditable reason for each earlier result.
5. **Integrate.** A write task must be clean, committed, in scope, and exactly match its declared
   files. Passing commits are cherry-picked. Conflicts abort without discarding either side.
6. **Recover or replan.** Failed, blocked, or cancelled attempts remain in history. Verified work
   is preserved when unfinished tasks are revised. A retry is warm by default: when the previous
   attempt reached a result or verdict, the relaunch resumes its Codex thread (on the attempt's
   own model, effort, and sandbox, in the same worktree) with a "Previous attempt" briefing
   section carrying the outcome, the supervisor's evidence, the retry note, and the files it
   changed. Crashes, missing results, cancellations, attempts without a thread id, and
   `run retry --fresh` start cold; an integration conflict resumes the thread in a fresh worktree;
   a thread Codex no longer has falls back to a fresh thread and is recorded.
7. **Finalize.** Once all tasks pass, the run becomes `finalizing`. Claude runs the combined checks
   and records exact evidence. Only a clean, branch-consistent passing verdict makes the run
   `completed`.

See [Architecture and recovery](docs/architecture.md) for the state machine and failure behavior.

### Executed check receipts

Configure trusted checks on a lane before creating a run; new runs freeze these definitions:

```bash
orch lane add api --check '{"id":"tests","argv":["node","--test"],"timeoutSeconds":300,"stages":["task","final"]}'
orch run check <run-id> <task-id> --json
orch run check <run-id> --json
```

Task checks run on the reported attempt's checkout; final checks run after every task is accepted.
The runner invokes `codex sandbox` without a model call, with a read-only checkout, no network,
and a private writable `TMPDIR`. Check scripts must work within those permissions. Each receipt
records argv, times, timeout, exit status, attempt/plan identity, tested HEAD plus dirty source
contents, and the last 32 KiB of each output stream (with a truncation marker). Ignored dependency
contents are not fingerprinted. Missing, failing, timed-out, or stale required receipts block
acceptance; worker-reported commands never become trusted check definitions. There is no implicit
waiver. Manual supervisor evidence remains required for acceptance on contracted runs, including
criteria that cannot be established by a passing command. Lanes without checks retain manual
verification, and existing runs do not acquire checks retroactively.

### Combined candidate preview

After review and isolated task checks, run `orch run preview <run-id> <task-id> --json`. It creates
a detached scratch worktree at the recorded integration head, provisions its trusted setup,
applies the inspected candidate with the same guarded Git path, and executes every configured
check on that combination. It never advances the supervisor branch. A preview failure returns a
nonzero exit and preserves its receipt, output tails, and scratch checkout for diagnosis.

Runs with configured checks require a passing preview before write integration; invoking preview
also opts that candidate into the gate when no checks are configured. Receipts bind to the exact
target head, candidate commits, attempt, plan revision, and check definitions. Integrating another
task or changing the candidate requires a new preview. Passing it does not skip supervisor review
or the existing crash-safe integration protocol. `run cleanup` removes settled clean previews,
but preserves dirty scratch work and uncertain process-termination obligations.

Setup runs before candidate application, so candidate-modified scripts never gain setup's
permissions. A candidate changing declared setup inputs is refused instead of being tested with
stale dependencies; review dependency/setup changes separately. This first version handles one
candidate at a time, not a batch merge queue.

Checks, setup, and previews do not hold the run's lock while their commands run, so other commands
on the run (a background `run wait`, another launch, a cancellation) keep working. Each receipt is
bound to the attempt, plan revision, and contents it measured, so anything that changes meanwhile
makes it stale rather than wrongly fresh. These commands can run longer than a foreground Claude
Code Bash call allows, so the supervisor runs them in the background. If a launch is killed during
setup, the next poll records the attempt as `setup_failed`; the setup command may still be running
in that worktree, so retry with `--fresh`. `run cleanup` keeps such worktrees and previews until the
recorded process group has exited; when no group was recorded (a killed launch, a Git child), it
keeps them until `run cleanup <run-id> --release-uncertain`, which you should pass only after
confirming nothing is running there.

## Worktrees and your branch

You do not need a branching workflow. Integrated work lands as ordinary commits on the branch the
run started from, `main` included. The worktrees are scratch checkouts under
`.orchestrator/local/worktrees/` that you never switch to, and `run cleanup` removes them.

Every write task gets its own worktree, because:

- **Workers run in parallel.** Several Codex processes in one folder would see each other's
  half-finished edits, their tests would fail on each other's changes, and each wrapper's commit
  would sweep up the others' files.
- **Your checkout is untouched until review passes.** A rejected attempt never reaches your branch;
  rejecting it costs nothing to undo.
- **Scope checks are exact.** A task's changed files are the diff of its own commits, so
  out-of-scope and undeclared edits are caught before integration.
- **Retries build on them.** A warm retry continues in the same worktree; a retry after a
  conflict starts again from the integrated head.

Read and verify tasks get no worktree. They run in your checkout exactly as it is, uncommitted and
untracked files included, under a sandbox that cannot write it, and several can share it at once.
A review of a draft you have not committed sees the draft. Each launch records the commit and the
uncommitted files the worker saw. New read attempts also hash the task scope (the lane default
when omitted, or the whole source tree for explicit `scope: []`), including dirty and untracked contents. Changes detected at result
collection or acceptance block a passing verdict until the review is retried. Unrelated paths
outside an explicit scope do not invalidate it. This detects observed changes, not edits restored
between observations, and is not an atomic filesystem snapshot. A submodule counts by its own commit and
dirty contents, and a FIFO or socket only by being there. Ignored dependencies and symlink
targets outside the declared surface are not covered; narrow scopes must include the actual
dependencies of the review. Legacy attempts without a snapshot remain labelled as unrecorded.

While a run has write tasks to launch or integrate, leave the checkout to it: those steps and
finalization require it to be clean, and a commit made outside the run is refused as branch drift
until you reconcile it. A refused write launch leaves the task pending and spends no attempt, and
`/orchestrator:init` warns when the checkout has uncommitted files.

`run show`, `run ready`, and `run recover` explain running work, unanswered requests, reports awaiting
review, blocked dependencies/routes/scopes, stale checkpoints, and checkout conditions, with next
actions. These diagnostics do not poll workers or change Git/run state. `ready --json` and
`resume --json` include structured diagnostics; `recover --json` retains its worker-handle array.
Pending integration intent names its phase: a `started` operation may still have a live Git child,
so diagnosis does not clear locks, reset branches, or infer safety from HEAD alone. `run resume`
uses the existing operation-specific recovery receipts, and accepted-but-unpublished audit events
are shown separately from an unaccepted integration. Preflight now identifies the executing plugin
path/version, configured setup, and sandbox capabilities explicitly not yet checked.

The cost for write tasks is setup: ignored files such as `node_modules` are not in a fresh
worktree (see [Project dependencies and test setup](#project-dependencies-and-test-setup)), and
there is no mode yet that runs a write worker directly in your checkout.

## Executors

Workers run through the Codex CLI by default (`cli`). A run created with
`/orchestrator:run ... --executor codex-plugin` runs them through the
OpenAI Codex plugin for Claude Code (`codex@openai-codex`)
instead, using its job commands (`task --background`, `status`, `result`, `cancel`), so the jobs
also show in `/codex:status`. Everything else is unchanged: routing, worktrees, review,
integration, and recovery. The plugin must be installed; a launch without it is refused before
the task is claimed.

The plugin path gives weaker guarantees, and each attempt records them:

| | `cli` | `codex-plugin` |
| --- | --- | --- |
| Output schema | Enforced by Codex | Asked for in the briefing; parsed from the final message |
| Saved approval rules | Ignored (`--ignore-rules`) | Not ignored |
| Read worker temp files | Private writable `TMPDIR` | None (recorded as a sandbox fallback) |
| Effort | `low` to `ultra` | Up to `xhigh`; higher routes run at `xhigh`, recorded |
| Warm retry | Resumes the exact thread | Write tasks resume the worktree's latest thread; read tasks start fresh |
| Cancel | Stops the worker's whole process group | Interrupts the turn; a command already running in the plugin's shared app-server keeps running until it ends |

Use `cli` unless you specifically want the plugin's job tracking. Set `ORCHESTRATOR_CODEX_COMPANION`
to point at a `codex-companion.mjs` outside the installed plugin.

## Commands

| Command | Purpose |
| --- | --- |
| `/orchestrator:init` | Create state and preflight Codex CLI, auth, and Git |
| `/orchestrator:lanes` | Define named scope, constraints, and lane-level done criteria |
| `/orchestrator:run` | Plan and manage a new Claude-supervised routed Codex worker pool |
| `/orchestrator:resume` | Recover and continue an existing durable run |
| `/orchestrator:ledger` | Show or add stable project facts carried into future tasks |

The lower-level CLI is available to command definitions and operators:

```text
node plugins/orchestrator/scripts/orch.mjs help
```

Wait for the next worker state change (started by the supervisor as a background command):

```text
orch run wait <run-id> [--timeout <seconds>] [--interval <seconds>] [--no-watch] [--json]
```

It prints the same payload as `run poll`, with `"changed": true` on each update that needs the
supervisor, and exits `0` when a worker changed state, `2` on timeout (default 30 minutes), `3`
when no worker is running or paused, and `4` when every remaining worker is paused awaiting an
answer (`1` is an error). It returns at once when a change is already on disk. It watches worker
status directories with `fs.watch` and also polls every 15 seconds (`--interval`), so a file event
the platform drops, or a watch it refuses (inside the Codex sandbox `fs.watch` can fail with
EMFILE), only delays the wake; `--no-watch` relies on the interval alone. Each task has a
wall-clock limit — the plan's `timeoutMinutes`, else 120 minutes on `astra`, 90 on `sol`, 60 on
`terra`, and 30 on `luna` — and a worker past it is reported once, never stopped; stopping it is
the supervisor's `run cancel`. `run poll` remains for a one-off, non-blocking look.

Show how each model and effort has performed in this repository's saved runs:

```text
orch run routes [--lane <lane>] [--include-legacy] [--json]
```

It reads local run state only and changes nothing. Per actual model and effort it shows finished
attempts, first-attempt acceptance, retries, substitutes, and median duration. An attempt counts
for the model it ran on; a launch Codex rejected as unavailable counts for neither model, answered
worker requests are part of their attempt (the time spent paused awaiting an answer is left out of
its duration), and the retired `gpt-5.6-sol` and `gpt-5.6-terra`
attempts are left out unless `--include-legacy` is passed. Counts sit beside every rate, and no rate
is printed for fewer than 5 samples. `run plan`, `run briefing`, and `run resume` show the table
for the run's lane once it holds at least 5 counted attempts.

### What a run cost and what the workers added

```text
orch run cost <run-id> [--json]
orch run tally <run-id> --findings <n> --checked <n> --held <n> --corrected <n> \
  --worker-only <n> --supervisor-only <n> [--note <text>]
```

`run cost` reads each worker's token usage from Codex's own session logs
(`$CODEX_HOME/sessions`, default `~/.codex`), which both executors write, and prints it per
attempt: fresh input, cached input, and output. A warm retry or answered question continues the
same thread, so each attempt counts only the tokens used between its start and finish. When Codex
reports the account's weekly window, it also shows the weekly Codex limit before and after the run.
That figure is account-wide, so any other Codex use in the same window is included. Nothing is
converted to money: subscription plans are not billed per token. An attempt whose log is missing
is listed as not measured.

It also reports the Claude supervisor's side. Each supervising command (`plan`, `launch`, `wait`,
`verify`, `finalize`, `resume`, and the like; not `show` or `cost`) records the Claude Code session
running it (`CLAUDE_CODE_SESSION_ID`), and `run cost` reads those sessions' transcripts
(`$CLAUDE_CONFIG_DIR/projects`, default `~/.claude`), subagents included, counting each API
response once: input, cache writes, cache reads, and output, per session and model. A session
counts from the start of the turn in which it first supervised the run to the end of the turn in
which the run finished, so anything else it did in that span is included. A run resumed in a new
session lists both. Runs created before 0.6.7 have no recorded session. `run show` adds both
one-line summaries, and `run finalize` saves a
snapshot of it in the finalization record, so it survives if the logs are later pruned.

`run tally` records the supervisor's count of what the workers contributed: worker findings, how
many the supervisor re-checked, how many held or were corrected, findings only the workers
produced, and findings only the supervisor added. The runtime checks only that the numbers are
consistent. `run cost` prints them beside the automatic outcome counts (accepted first try,
accepted after retry, failed or cancelled). A tally is the supervisor's own count, not a
controlled comparison with Claude working alone, so it does not support a claim that the
workers made the result some percentage better.

Reject a reported write task that fails review. `--verdict pass` is refused on a write task,
because it completes only by `run integrate`:

```text
orch run verify <run-id> <task-id> --verdict fail --evidence "<input, what it returned, what was expected>"
```

Retry a failed or blocked task with a correction for the worker:

```text
orch run retry <run-id> <task-id> [--note "<what to change>"] [--fresh]
```

Answer a worker that paused with a `needs_input` request (a scope extension or a question):

```text
orch run answer <run-id> <task-id> (--grant-scope <glob>... [--user-approved] | --deny | --reply "<text>") [--reply "<text>"]
```

The answer resumes the same attempt on the same thread, worktree, model, effort, and sandbox; it
creates no new attempt, records no outcome, and does not count as a retry. A grant is recorded on
the task, never on the lane, and inspection and integration honour it for that task only. The
supervisor may grant inside the lane on its own authority; a grant outside the lane is refused
until the user agrees and `--user-approved` is passed. A grant that may overlap another running,
paused, or unintegrated task's write surface is refused, and a task still pending when the grant
was made cannot launch onto it until the granted task is integrated or cancelled. Each task gets at most 3 answered round
trips; a further request becomes an ordinary blocker.

Supervisors can explicitly stop a reported task at a policy or authority boundary, or terminalize
an unrecoverable integration failure, with `run decide`. The decision records a versioned
`policy_refused`, `authority_escalated`, or `integration_failed` outcome; policy and authority
decisions are never inferred from worker prose. A failed review is not a disposition; use
`run verify --verdict fail`.

Every `--evidence`, `--decision`, `--risk`, `--next`, `--scope`, `--constraint`, and
`--grant-scope` value is one entry, commas included; repeat the flag to give several. Only
identifier filters such as `--run` and `--task` also accept a comma-separated list.

The lower-level `learn` commands derive evaluation-ready metadata without copying prompts,
objectives, source, diffs, worker output, evidence text, ledger text, stderr, tool output,
environment variables, or absolute paths:

```text
orch learn collect [--run <id>] [--retention-days <n|forever>]
orch learn list
orch learn inspect <sample-id>
orch learn label <sample-id> --outcome <value> --action <value> \
  --reason-code <code> --provenance <supervisor|user|imported>
orch learn export [--name <id>]
orch learn purge --sample <id>
```

The base store is permanently metadata-only. A managed export can include one of the documented
text fields only when both `--consent user|supervisor` and
`--acknowledge-sensitive-export` are present; redaction runs before bounded text is written.
Exports stay under the private learning directory so purge can find and remove every managed
copy. There is no upload or network destination. Redaction deliberately favors privacy over
semantic precision: IPv4-shaped dotted quads can be removed even when they resemble a version
number rather than a real network address.

Reviewed non-success outcomes can be compiled into provisional per-run guidance:

```text
orch run guidance <run-id> --mode provisional [--policy-version <id>]
orch run guidance <run-id> --mode off
orch run guidance <run-id> --rollback
```

Enabling guidance requires a supervisor- or user-reviewed outcome for the run's lane. It makes the
current checkpoint stale, so the supervisor must review and checkpoint the policy before dispatch.
Only a retry whose typed prior outcome exactly matches a reviewed failure signature receives an
item. The item is a fixed built-in template: objectives, evidence, worker prose, source text, and
free-form instructions never enter the learned policy or provisional guidance block. This does not
remove the ordinary run objective, assignment, scope, constraints, acceptance criteria,
dependency context, or other established sections of the worker briefing. Guidance is advisory
and cannot change model or effort pins, task state, scope, constraints, safety rules, or supervisor
authority. A policy version name is immutable within a run: if reviewed sources change the policy
hash, enable it under a new `--policy-version` instead of rebinding the old name.

## Context and memory

State is split by portability:

```text
.orchestrator/
  .gitignore
  lanes.json                       # committed: scopes, constraints, done criteria
  ledger.md                        # committed: durable project decisions and facts
  local/                           # self-ignored: machine-specific run state
    threads.json                   # local state file; per-lane thread pointers are no longer written
    runs/<run-id>/
      run.json                     # task graph, attempts, results, evidence, checkpoints
      events.jsonl                 # append-only supervisory event history
      workers/<task>/<attempt>/    # prompt, schema, JSONL output, status, final result
        round-<n>/                 # the same files for each resume after `run answer`
    worktrees/<run-id>/...         # isolated worker checkouts
    learning/                      # private 0700 derived learning state
      identity.json                # local HMAC key and opaque repository identity (0600)
      examples.jsonl               # strict metadata-only samples and label history (0600)
      exports/<export-id>/         # managed local snapshots and manifests (0700/0600)
```

The ledger is intentionally small and stable. Per-run detail stays local because process IDs,
worktree paths, and Codex threads are meaningful only on the machine that owns them.
`/orchestrator:resume`
combines the run record, latest checkpoint, worker evidence, integration history, lane definition,
and ledger into the supervisor's reconstructed context.

All versioned state is read defensively. Run state version 6 adds the GPT-6 roster and model
substitution records, optional warm-retry fields (`review`, `retry`, `resumedFromAttemptId`,
`resumeFallback`), and optional worker-request fields (`inputRequests`, `scopeGrants`, the
`needs_input` status) that older runs simply lack; version 5 added guidance policy and attempt snapshot fields. Version-3
through version-5 runs remain readable and resume and retry on their persisted exact slugs,
including the retired `gpt-5.6-sol` and `gpt-5.6-terra`, which new plans cannot select. A newer
version is refused instead of guessed at, writes are atomic, and shared state updates use file locks.

Learning records default to 365-day retention metadata; `--retention-days forever` records that
they remain until an explicit purge. Retention never deletes raw run audit state. `learn purge`
removes matching samples, their embedded label history, and every affected managed export; corrupt
or incomplete managed exports are removed conservatively. `--all` preserves the private identity
and an empty store. Because raw runs are intentionally separate, a later `learn collect` can
derive a purged sample again until the raw run itself is removed through a separate workflow.

## Safety invariants

- Workers use only `gpt-6.2-astra`, `gpt-6.2-sol`, `gpt-6.1-terra`, or `gpt-5.6-luna` (plus the
  persisted retired slugs of runs saved by an earlier release: `gpt-5.6-sol`, `gpt-5.6-terra`,
  `gpt-6-astra`, `gpt-6.1-sol`); each resolved model
  and effort is persisted before launch, and substitution is never silent.
- Automatic routing is a plan-time supervisor decision, not a hidden runtime fallback. Every
  unpinned task must include an exact model, effort, and routing reason before dispatch.
- A worker cannot widen its assigned scope or self-assign global work. It can only ask; a grant
  applies to that one task, never to the lane, and must not overlap another active task's write
  surface. Grants outside the lane require the user's approval.
- The supervisor checkout must be clean for a write launch, integration, and finalizing a run that
  has a write task. Read and verify workers run in it as it is but cannot write it, cleanup never
  removes it, and a run of only read and verify tasks finalizes on it as it is.
- The supervisor branch and recorded integration head must not drift outside the run.
- Write-task reports must match the actual committed file set exactly.
- No worker can leave its sandbox: every launch pins `approval_policy="never"` and
  `--ignore-rules`, so neither an approved escalation nor a saved "always allow" rule runs a
  command outside it. A write worker cannot commit (`.git` is read-only in its sandbox); the
  wrapper commits its changes when it finishes.
- A resumed Codex thread inherits nothing from its earlier launch; every resume passes the
  attempt's model, effort, and sandbox explicitly, so a read-only task stays read-only.
- Worker prose is untrusted evidence, not instructions to the supervisor.
- Provisional guidance uses only fixed templates selected from reviewed typed outcomes. It is
  opt-in, checkpointed, bounded, replayed from the attempt snapshot, and fully advisory.
- A task report is not a supervisor verdict, and completed tasks are not a completed run.
- Dispatch is refused until a checkpoint covers the current plan revision, so supervisory reasoning
  survives compaction.
- Cancellation terminates the detached process and remains visible in durable state.
- Dirty worktrees are never removed automatically.

## Run contracts and plan checks

New CLI runs freeze their lane's scope, constraints, and definition of done when created. Editing a lane later does not widen an existing run. Initial write scopes outside that boundary require the user's approval and `run plan --user-approved-task <task-id>` for each approved task; the approval is saved against that task's exact scope, never the whole plan or lane. A task that is narrower than the lane only by its own extra exclusions counts as inside it. Every task requires at least one acceptance criterion.

Planning reports potentially overlapping writers. Writers with an identical positive scope pattern cannot hold that surface simultaneously: integrate the first or narrow the assignments. Approximate glob intersections remain warnings, so conservative matching does not unnecessarily serialize independent work. Read tasks can still run together.

State version 7 prevents older releases from ignoring the new contract. Earlier runs retain their legacy behavior; the runtime does not manufacture historical approvals or change saved routes. The lower-level programmatic API can still create an unconfigured legacy run, but CLI creation always requires a lane.

## Development

```sh
npm test
claude plugin validate .
```

The package has no runtime dependencies. Tests use throwaway Git repositories and fake Codex
processes to exercise concurrency, cancellation, structured collection, worktree integration,
finalization, and cleanup without consuming model quota.

Run this suite locally with `npm test`; there is no hosted CI. These are protocol tests, not real-model sandbox certification. Before relying on a new Codex installation or upgrade, separately exercise a write task through integration/finalization, a read task that can write only its scratch directory, warm resume, and cancellation with the authenticated CLI; these opt-in checks consume model quota.

## Operational limits

- Claude drives every decision while the command is active. The only background process on the
  supervisor's side is `run wait`, which collects worker status and exits; there is no daemon that
  can make supervisory decisions without Claude.
- Run state is machine-local by design. Move stable knowledge to the ledger before changing
  machines.
- Every write task runs in its own worktree; there is no in-place write mode. Worktrees do not
  inherit ignored files, so dependency-heavy projects need the setup described under requirements.
  Read and verify tasks run in the checkout and see whatever is in it when they launch, including
  edits made while they run.
- Integration uses cherry-pick. Conflicts abort and require the supervisor to replan or request
  direction.
- If integration is interrupted after Git has returned and its stopped phase is saved, `run resume` reconciles the saved intent and operation-specific receipts without replaying commits. An interruption while Git may still be running requires manual recovery, even if HEAD is unchanged or the expected commits are visible. Partial operations, missing receipts, unrelated commits, or manual edits also require manual recovery; the command preserves them rather than guessing or resetting the checkout. Acceptance-event publication failures are reported separately and retried by resume.
- Retries resume the previous attempt's Codex thread by default. That depends on Codex still
  holding the thread on this machine; when it does not, the retry falls back to a fresh thread with
  the full briefing and records that it did. `run retry --fresh` always starts a new thread.
- The plugin validates supported model names and effort combinations, but actual model entitlement
  belongs to the account authenticated in Codex CLI. A launch Codex rejects as unavailable is
  closed with a `model_unavailable` outcome (it never reached a worker, so route evidence does not
  count it) and the task relaunches on the next model down the ladder; only when no model is left
  does the task fail for the supervisor to escalate, and later launches of it are refused until it
  is re-routed. A task others depend on never falls to luna unless the run is pinned to it or
  predates automatic routing. Only a rejection before the worker did anything counts, and an error
  worded as an outage is an ordinary failure; an explicit `model_not_found` code always counts.
  Only the ChatGPT-account rejection wording has been observed; detection on an API-key login is
  inferred.
- Route evidence is local history, not a benchmark. It covers only this machine's saved runs and
  says nothing about tasks unlike the ones that produced it.
- Automated tests validate the complete process protocol with fake workers. A real authenticated
  Codex smoke test is still the environment-level proof for a particular installation.

## License

Apache-2.0.
