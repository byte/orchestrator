# Changelog

## 0.6.2

Fixes found by a real run on Codex CLI 0.169.0 (every tier, a warm retry, and a three-worker wave):

- Text and glob options keep their commas. `--evidence`, `--decision`, `--risk`, `--next`, `--constraint`, `--scope`, and `--grant-scope` were split at every comma, so evidence such as `f('a b', 9) returned ...` was stored as fragments in run state, checkpoints, and retry briefings, and a brace glob such as `src/{a,b}.mjs` became two broken patterns. Each value is now one entry; repeat the flag for several. Identifier filters (`--run`, `--task`, `--sample`, `--attempt`, `--outcome`, `--include-text`) still accept comma lists.
- A supervisor can reject a reviewed write task. `run verify --verdict fail` now works on a reported write task: the attempt ends as `verification_failed` / `supervisor_verification_failed`, and `run retry --note` resumes the worker's thread in the same worktree with the evidence. `--verdict pass` is still refused, since a write task completes only by integration. Before, the only route was `run decide --outcome integration_failed`, which recorded a failed review as an integration failure, and the `run retry` error suggested the `integration_conflict` reason code.
- `/orchestrator:run` now tells the supervisor to run the lane's definition-of-done check before planning (a check that already fails sends every worker asking for out-of-scope files) and to give `run finalize --verdict pass` only when that check holds.

## 0.6.1

Fixes:

- A worker's wrapper records its real process start time, so on a heavily loaded machine a poll no longer mistakes a live wrapper for a reused process ID and fails its task.
- Redaction no longer leaks a PEM private key or a `Bearer`/`Basic` token written as a credential assignment (`secret: -----BEGIN ...`, `access_token: Bearer ...`); a quote inside a sensitive URL query value no longer exposes the rest of it.
- A torn line in a run's event log no longer blocks publishing an accepted integration's audit event, and while that event is pending the run refuses every other change (claims, plan changes, cancellation, finalize). Interrupted integrations recorded before integration phases existed can be recovered again.
- One worker that cannot be stopped no longer stops a poll from collecting the other tasks or a cancellation from stopping the other workers, and a failed launch or answer reports a worker it could not stop instead of hiding it. Git's own group kill tolerates macOS zombie-only groups. A finished worker's wrapper completes its scratch removal and log flush before publishing its final status, so a poll cannot kill it mid-cleanup.
- Git commands that change a checkout (`worktree add`, the wrapper's `add -A` and commit, cherry-pick) get a ten-minute backstop instead of the 30-second deadline, which could kill them mid-way in a large repository; read-only Git keeps a short (sixty-second) deadline so a worker-planted FIFO still fails fast. A poll that cannot finish every task now still prints the updates it collected. Codex installed through a multi-call shim such as Volta launches again.
- Integration records prepared/started/stopped phases and refuses automatic recovery when a surviving Git child could still mutate the checkout. Fresh integration preserves existing Git operations, and refused cancellation no longer signals workers before its locked decision. Accepted integrations retain an idempotent audit-event obligation until publication succeeds.
- Git uses a trusted absolute executable and bounded, file-backed capture outside the checkout. Process identity checks use bounded `/bin/ps`, not relative PATH lookup. Git's detached group is stopped on every leader return, including a signalled launcher; uncertain termination retains manual-recovery intent. FIFO-blocked inspection/cleanup fails without deleting the worktree, and cancellation/polling stop a dead wrapper's remaining group.
- Removed tasks retain their assignment and attempt history for learning, routes, and cleanup. Recreated task names cannot reuse attempt identities or inherit old reviewed labels. Missing legacy route effort is reported as unknown instead of taken from the current plan.
- Redaction version 4 handles interacting credential/query rules, punctuation-bearing unquoted tokens, and direct YAML credential blocks. Explicit export regressions check the resulting artifact; versions 1–3 remain readable. The bounded syntax and unsupported formats are documented.
- Requirements now explicitly state macOS/Linux support and explain that fresh worktrees do not inherit ignored dependencies or build products; read-worker test execution depends on project setup.
- Interrupted integration now persists inspected intent before cherry-pick and reconciles complete operation-specific Git receipts on `run resume` or repeated integration. Partial operations, unrelated commits, manual edits, and missing receipts remain untouched for manual recovery. Run-state locking protects acceptance from concurrent cancellation; live locks are no longer evicted solely because they are older than 30 seconds.
- Learning freezes each attempt's original assignment metadata and opted-in text, so replanning cannot retroactively relabel historical outcomes. Legacy attempts require corroborating unchanged-plan history rather than guessing their assignment.
- Text-export redaction now recognizes quoted JSON/YAML credential keys and consumes complete quoted values, including escaped quotes and punctuation. Redaction version 3 retains compatibility with older stored records.
- The test command works on the documented Node 18.18 line. A dependency-free Linux/macOS CI matrix covers Node 18.18.2 and Node 22 without launching real model workers.
- Read and verify workers can run tests. `--sandbox read-only` denied every
  write, the system temp directory included, so a reviewer could not run a
  suite that creates temporary files. These workers now get a Codex
  permissions profile that extends `:read-only` with write access to one
  private scratch directory, exported as `TMPDIR` and removed when the worker
  exits. The worktree stays unwritable. Before launch the worker proves the
  profile with `codex sandbox`; if the scratch directory is not writable or
  the worktree is, it falls back to `--sandbox read-only` and records a
  `task.sandbox_fallback` event. The profile name is random for each launch,
  so grants a user's config gives a profile of the same name cannot widen it,
  and a `TMPDIR` inside the checkout is refused. `run cleanup` removes a
  scratch directory a hard-killed worker left. The probe also requires Codex's
  network-disabled marker, so the profile cannot have more network than plain
  `--sandbox read-only`. The wait tests that need file-change events skip,
  with the reason, inside the Codex sandbox (`CODEX_SANDBOX` set) when
  `fs.watch` is not delivering there (it can fail with EMFILE).
- Read and verify workers launch with `approval_policy="never"`. With a Codex
  config such as `approval_policy = "on-request"` and an automatic approvals
  reviewer, a worker could ask to run a command outside its sandbox and have
  it approved, bypassing the read-only boundary. They also launch with
  `--ignore-rules`: a persisted "always allow" execpolicy rule (such as one for
  `node` or `npm test`) ran a matching command outside the sandbox without
  asking, so a read worker could write the checkout and reach the network.
- Write workers launch with the same pins. Their commits only worked through
  that hole: `workspace-write` keeps `.git` read-only, so a worker could commit
  only when a saved `git commit` rule or an approved escalation ran git outside
  the sandbox, and without such a rule it could not commit at all. Workers now
  leave their changes in the worktree and the wrapper commits them, outside the
  sandbox, when Codex finishes (not when it pauses for input). A failed commit
  fails the worker.
- Integration's cherry-pick runs no hooks. Scope matching no longer treats a backslash in a path as a
  separator, so `src\outside.txt` is not inside `src/**`. File names keep
  their exact bytes in inspection (a trailing space is part of the name), and
  a worktree recorded before its git directory was recorded resolves it from
  the supervisor repository instead of the worktree's `.git` file.
- Scope patterns match a newline in a filename like any other character, so
  `!src/private/**` cannot be slipped past with one. A conflicted
  integration's rollback (`cherry-pick --abort`) also runs with fsmonitor off.
  Cleanup of a worker's worktree counts an uncommitted edit to a tracked
  `.orchestrator/` file as a change and refuses, instead of deleting it.
- Every filter driver defined in git config is overridden for git in a
  worker's worktree, so a filter selected by the repository's own
  `.git/info/attributes` cannot run a script the worker wrote either.
- `run poll` fails a worker whose wrapper died without a final status (a hard
  kill, an uncaught error) instead of reporting it running forever, and the
  wrapper reports a commit that throws as a failure.
- After a stop, the wrapper kills whatever is left of Codex's process group
  even when Codex itself exited first, and stopping a silently replaced
  resume uses the same group stop, so a process holding the pipes cannot
  block the relaunch with the full briefing.
- A launch undone after its attach was saved fails the attempt only if it is
  still attached to that launch's runner, so it no longer fails an attempt a
  poll and an answer have already resumed. `run retry` refuses a task in a
  cancelled run, which would otherwise finish while the run still read
  cancelled.
- A warm retry whose worktree is gone fails as `execution_failed /
  worktree_unavailable`; before, recording that failure itself failed and left
  the task dispatching.
- A cancelled worker's whole process group is stopped (Codex runs in its own
  group, killed 5 s after SIGTERM if still there), so a process it started no
  longer survives `run cancel`. A worker attached while a cancellation failed
  after saving is still stopped.
- Every git command the supervisor runs in its own checkout (status checks,
  `worktree add`, integration) runs with hooks and fsmonitor off, so a hook or
  monitor script a worker changed in scope and that was integrated does not run
  at the next status check or the next worker's launch. Integration's
  cherry-pick runs without rename detection, so an edit to a file another task
  moved out of scope conflicts instead of following the move.
- Git in a worker's worktree no longer reads attributes from the empty tree
  (configured filters are already overridden), so a `working-tree-encoding`
  file is committed as the worker wrote it instead of being encoded twice at
  integration; Git 2.42 is no longer required. The wrapper's commit check runs
  no textconv or external diff.
- When Codex exits, the wrapper kills whatever is left of its process group,
  so a process it started that ignores SIGTERM does not outlive a finished
  worker. The group is recorded as soon as Codex starts, a poll that finds the
  wrapper dead kills it, and a cancel with the wrapper gone kills it outright;
  a finished runner's old pids are never signalled.
- A failed answer's rollback undoes only the round it answered, so a rollback
  delayed past the worker's next request keeps the later round's answer.
- Integration replaces every configured merge driver with `false`, so a file
  it would merge conflicts instead of running a driver script a worker changed
  in an earlier commit. It also refuses to overwrite an ignored file in the
  main checkout (a local `.env` at a path the worker added), which git would
  otherwise replace silently.
- A populated nested repository in a worker's worktree counts as a change
  (its own status is never run), so inspection is not ready and cleanup does
  not delete its uncommitted work.
- `run cancel` finishes stopping a worker before it returns, so a worker whose
  wrapper dies during the grace period cannot keep running. The read-profile
  probe's pid is recorded like Codex's, so a probe whose wrapper died is
  stopped by the next poll or cancel.
- `run cleanup` no longer marks worktrees for removal. Under the run lock it
  checks each finished task's worktree and moves a clean one aside in one
  rename, then deletes it outside the lock; a dirty one is kept and reported
  without stopping the others. Concurrent cleanups and warm retries can no
  longer clear each other's marks or delete a running retry's worktree.
- Integration checks the disk instead of git's ignored listing: it refuses
  when a declared path, or any parent of one, exists in the main checkout as
  an untracked or ignored file, or a declared path is a directory there.
- Anything at a submodule's path in a worker's worktree counts as a change,
  not only a nested repository.
- The wrapper kills the rest of Codex's process group as soon as Codex exits,
  so a process still holding its output cannot keep a finished worker
  running. `run cancel` stops the wrapper and waits for its final status,
  then kills whatever group that status records, so a probe that handed over
  to Codex meanwhile is not mistaken for the worker.
- docs/architecture.md states the worker containment properties and their
  non-goals (configured checkout filters and commit signing during
  integration, ignored files inside a worker's worktree).
- `run integrate` runs one integration of a checkout at a time, so two at once
  can no longer record a stale integration head that blocks every later
  launch with branch drift.
- A worker's change under `.orchestrator/local/` is out of scope whatever the
  task's scope, so integration never writes the orchestrator's own state.
- `run cancel` stops the live worker of every cancelled attempt of a task, not
  only the latest, so one that attached just before a retry is not missed.
- The reserved `.orchestrator/local/` check ignores case, as a
  case-insensitive filesystem does.
- `run cleanup` leaves a task alone while any of its workers may still be
  running (a cancelled task whose worker attached late).
- A recorded wrapper or Codex pid is trusted only while it belongs to the
  process started then (`ps` start time), so a reused pid is neither taken
  for a live worker nor signalled. The wrapper kills its running child's
  group whenever it exits, including on an uncaught error.
- Integration refuses a path that reaches `.orchestrator/local/` through a
  case or Unicode alias (checked on the filesystem, not by spelling). The
  filter override runs `/bin/cat`, not `cat` from PATH. A cancel kills a
  wrapper still stuck after its grace period (in a git command a worker's
  FIFO blocks, say) together with what it runs.
- `run retry` on a reported task and `run finalize` with unfinished tasks
  say what to do next: close a conflicted attempt with `run decide` before
  retrying it, and drop an unwanted cancelled task by replanning. Both paths
  are documented in commands/run.md (found running real Codex workers).
- Status writes are numbered, so a poll holding an older snapshot cannot save
  it over a newer one (a discarded thread over the answer's fresh fallback).
- A launch whose briefing cannot be rendered leaves the task pending, and a
  launch whose claim event fails fails its attempt, instead of leaving the task
  dispatching with no worker.
- Git run in a worker's worktree, by the wrapper or by `run inspect`,
  `integrate` and `cleanup`, uses the git directory recorded when the worktree
  was created, never the worktree's `.git` pointer file, with hooks, fsmonitor,
  signing and submodule recursion turned off. A worker could otherwise re-aim
  the pointer, plant a hook, or plant a nested repository, and have its code
  run outside the sandbox by the supervisor's git.
- The probe is killed with its whole process group when the worker is stopped
  or it times out, so a native `codex` child that outlives the npm launcher
  can no longer hang the worker. A `TMPDIR` inside the checkout whose name
  starts with `..` is now refused too. A scratch directory the worker made
  unreadable is still removed.
- `run cleanup` removes a leftover scratch directory only once the wrapper and
  its Codex child have exited (a cancelled status is written before they do),
  only if it is a real `orch-worker-*` directory with no symlink on its path,
  and only if its owner file names the status file that recorded it, so a
  forged `scratchDir` cannot point cleanup at another directory.
- A cancellation that races a launch or an answer stops the worker even when
  the worker was attached after `run cancel` read the run. A launch refused or
  failed after its worktree was created records that worktree, so `run cleanup`
  removes it instead of leaking it and its branch.
- An answer whose briefing cannot be rendered (an unreadable ledger, say) is
  not saved, instead of leaving the task dispatching with no worker.
- Inspection and the warm-retry carry rule count every file any commit
  changed, not only the net difference. A file changed and then restored,
  in scope or not, is still a change the supervisor branch receives when its
  commits are cherry-picked, so it must be in scope and declared.
- A task cancelled while its worker was being launched, or while an answered
  worker was being spawned, stays cancelled and its worker is stopped. Before,
  attaching the worker set the task back to running.
- A `run poll` that loses a race with another poll collecting a paused
  worker's request skips the task instead of failing.
- An answer whose event cannot be written is reverted, instead of leaving the
  task dispatching with no worker and refusing every later answer. Reverting
  an answer also restores the thread the next answer resumes.
- A launch failure after the worker was spawned stops that worker.
- A file carried into a warm retry must have been declared by the attempt that
  last changed it. Before, an earlier attempt's claim could cover a later
  attempt's undeclared change.
- A 0.5.x run's legacy model, once Codex rejects it, is refused at launch and
  listed under `blocked` by `run ready`, instead of being launched again.
- `run wait` no longer wakes on its own lock file. Every poll takes
  `run.json.lock`, and the run-directory watch let that name through, so a wait
  on a quiet worker polled about ten times a second instead of sleeping.
- `run answer` detaches the paused worker's finished runner in the same write
  that reopens the task, so a concurrent `run poll` or `run wait` cannot collect
  the request it already answered a second time. A resumed worker that was
  spawned but could not be attached is stopped instead of left running.
- An answered resume that Codex silently starts as a new thread is relaunched
  with the full briefing, as for a missing thread. Before, the new thread got
  only the answer and worked without its assignment.
- An OVER LIMIT mark from before an answer no longer shows once the resumed
  worker's clock restarts, and route evidence no longer counts the time a
  worker sat paused awaiting an answer as model runtime.
- A warm retry that reuses its predecessor's worktree can integrate when it
  reports only the files it changed itself. Files an earlier attempt in the
  same worktree declared count as declared, instead of failing inspection.
- A `run retry --note` reaches the worker even when no earlier attempt reached
  one (the first launch failed, say). Before, it was stored but never briefed.
- An error naming the model counts as an unavailable-model rejection only when
  it comes before the worker did anything, and never on a resume after `run
  answer`. A temporary mid-run error no longer marks the model unavailable for
  the run and relaunches in a fresh worktree, discarding the work.
- A model fallback never lands a task other tasks depend on on `luna`, matching
  the plan-time leaf rule, unless the run is pinned to luna. With no other rung
  left the task fails for the supervisor to re-route.
- A scope granted through `run answer` stays exclusive. A task that was still
  pending when the grant was made is refused at launch if its scope overlaps
  the grant (or its own grant overlaps an active task), instead of launching a
  second worker onto the same paths. `run ready` lists such a task under
  `blocked`, with the grant it overlaps, instead of offering it for dispatch.
- An error that reads as an outage ("currently unavailable", "try again",
  "overloaded", a 5xx) is an ordinary failure even before any work, so a brief
  outage no longer marks the model unavailable for the rest of the run.
- `run retry` no longer counts warm attempts that never launched toward its
  advice to escalate.
- `run poll` and `run wait` reload the run only for active tasks, not once per
  task on every poll.
- Poll output and the supervisor briefing describe a paused worker's request
  with the same wording.
- A poll that read a worker's files before `run answer` attached a resumed
  worker can no longer apply that stale view: every write it makes is checked
  against the runner it read, so an answered request is never collected twice.
- A replacement thread stopped for the full-briefing relaunch can no longer
  leave its `result.json` behind to be collected for the relaunch.
- A failed `run answer` is reverted even when its attach was already saved,
  and answering again runs in a fresh directory, so the stopped try's
  cancelled status is never read for the new worker.
- A warm retry carries only declarations for files earlier attempts actually
  changed before it started and it did not change again; a file an earlier
  attempt merely claimed is never carried.
- A retry note survives repeated launch failures with no earlier worker.
- A long worker stream whose early work scrolled out of the read window is no
  longer mistaken for a launch rejection.
- A task whose model is known unavailable, with no allowed model below it, is
  refused by `run launch` and listed under `blocked` by `run ready`, instead
  of launching the rejected model again.

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
