# Write-task reference

Read from `/orchestrator:run` before the first write launch of a run. Commands are
`node "${CLAUDE_PLUGIN_ROOT}/scripts/orch.mjs" ...`.

## Setup and long-running commands

When the frozen lane has setup, launch provisions the isolated worktree before starting Codex. Inspect a `setup_failed` attempt's worktree receipt, fix the external prerequisite, and use `run retry`; no model call is spent while setup fails. If setup inputs changed after coding, use `run retry --fresh` rather than running the worker's modified script outside its sandbox. Do not copy credentials or dependencies from the user's checkout.

**Long commands run in the background.** A write launch on a lane with setup, `run check`, and
`run preview` execute commands that can take longer than a foreground Bash call allows (10 minutes
at most). Run each of them as a background Bash command (`run_in_background: true`) and read its
output when the harness reports it finished; a Bash timeout would kill the command midway. None of
them holds the run lock while its command runs, so a background `run wait` keeps working
alongside. If a launch was killed during setup anyway, the next `run wait` or `run poll` records the
attempt as `setup_failed`; the setup command may still be running in that worktree, so use
`run retry --fresh`. `run cleanup` preserves such worktrees and previews until it can prove their
processes have exited; `--release-uncertain` removes them, but only after the user confirms
nothing is still running there.

## The launch gate and write workers

A write launch requires a clean checkout on the run's branch with no commits made outside the run.
It checks before claiming the task, so a refusal leaves the task pending and spends no attempt.
If the checkout has uncommitted work that is not the run's (`init` and preflight warn about it),
tell the user and ask them to commit or stash it; read and verify tasks can still launch
meanwhile. Never work around a refusal by running `codex exec` outside the run: the run then
loses its waits, structured evidence, verdicts, and recovery. A file a worker must see has to be
in the checkout for a read task, and committed for a write task, whose worktree contains only
committed files.

A `write` worker has no network, may not ask to leave its sandbox, and cannot run `git commit` (`.git` is read-only in
its sandbox). It leaves its changes in the worktree, and its wrapper commits them under the task
title when it finishes, so the inspection gates still see a commit. A worker that reports
`failed` with `git add failed` or `git commit failed` left a worktree the wrapper could not
commit; inspect it before retrying.

## Review, preview, and integrate

For write tasks, first inspect the isolated worktree:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/orch.mjs" run inspect <run-id> <task-id> --json
```

Require a clean worktree, at least one worker commit, exact agreement between reported and changed
files, and no paths outside the task's planned scope plus any scope you granted it (`grantedScope`
in the inspection). After independently confirming tests and acceptance criteria, run `run preview <run-id> <task-id> --json` to check the combined candidate before integration. It is required when the contract has checks. A failed preview preserves the user's branch; inspect its receipt and fix the candidate rather than bypassing it. A later accepted task or candidate edit invalidates the preview. Candidate changes to setup inputs need separate dependency/setup review, not execution of modified scripts with setup permissions. Then integrate it:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/orch.mjs" run integrate <run-id> <task-id> \
  --evidence "<specific check and outcome>"
```

If review finds the work wrong (a failing check, a missed acceptance criterion, a defect you can
reproduce), reject it instead of integrating:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/orch.mjs" run verify <run-id> <task-id> \
  --verdict fail \
  --evidence "<the input, what it returned, and what was expected>"
```

The attempt ends as `verification_failed`, and `run retry --note` resumes the worker's thread in
the same worktree with your evidence, as for a read task. `--verdict pass` is refused on a write
task: integration is the only way one completes. Keep `run decide` for integration failures and
explicit policy or authority dispositions, not for a failed review.

## Conflicts

Integration cherry-picks the task commits onto the supervisor branch. Conflicts are aborted and
reported; never resolve them by silently discarding another worker's change.

A conflicted task stays `reported`, so the same attempt can still be integrated later (after
reordering, say). To have the worker redo it on the current head instead, close the attempt and
retry; the retry resumes the worker's thread in a fresh worktree at the integration head:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/orch.mjs" run decide <run-id> <task-id> \
  --outcome integration_failed --action replan --reason-code integration_conflict \
  --evidence "<what it conflicted with>"
node "${CLAUDE_PLUGIN_ROOT}/scripts/orch.mjs" run retry <run-id> <task-id> \
  --note "<what changed underneath it>"
```

After a recorded cherry-pick conflict (found by `run integrate`, or first by `run preview` when the lane has checks), `run retry <run-id> <task-id> --conflict --note "<what must change>"` records the conflict disposition and prepares a fresh worktree at the current integration head while retaining warm-thread context. Inspect its recorded paths and preserved commits first. The retry still needs launch, renewed review, checks, and preview; it is not an accepted merge resolution.
