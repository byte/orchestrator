# Planning reference

Read from `/orchestrator:run` when its planning section points here.

## The codex-plugin executor

Append `--executor codex-plugin` only when the user asks for workers to run through the OpenAI
Codex plugin for Claude Code (`codex@openai-codex`) rather than the Codex CLI directly; the default
is `cli`. The plugin path is weaker, and every attempt records how: Codex does not enforce the
output schema (the report is parsed from the final message, and a malformed one is a contract
failure), saved Codex approval rules are not ignored, a read worker has no private writable
`TMPDIR` (recorded as a sandbox fallback, so rerun tests it reports failing), `max` and `ultra`
effort run at `xhigh` (recorded as `effortStepped`), a read task's retry starts a fresh thread, and a cancel interrupts the turn but cannot stop a
command already running in the plugin's shared app-server.
Its jobs also appear in `/codex:status`. A run's executor is fixed when it is created.

## Route evidence and model substitution

`run routes --lane <lane>` is a read-only table over local run state: per actual model and effort, the finished attempts
that reached a worker, first-attempt acceptance, retries, and median duration. A substituted
attempt counts for the model that ran; a launch Codex rejected as unavailable counts for neither
model; answered input requests are part of their attempt, but the time paused awaiting an answer
is not counted in its duration; attempts on retired slugs (`gpt-5.6-sol`,
`gpt-5.6-terra`, `gpt-6-astra`, `gpt-6.1-sol`) are left out unless you pass `--include-legacy`. Every rate sits next to its counts,
and no rate is printed below 5 samples, so a cell with two attempts is an anecdote, not a trend.
`run plan`, `run briefing`, and `run resume` print the same table for the run's lane once it holds
at least 5 counted attempts. Treat it as evidence, not a rule: it says nothing about tasks unlike
the ones that produced it. When it changed a route you would otherwise have chosen, cite it in
`routingReason` (for example, "terra/medium accepted 1/6 first attempts in this lane; routed to
sol").

If Codex rejects a model as unavailable to this account, the runtime does not fail the task. It
relaunches one rung down the ladder `astra` → `sol` → `terra` → `luna`, keeping the effort, and
remembers the model as unavailable for the rest of the run so later launches go straight to the
substitute. The substitution is never silent: it is recorded on the attempt (requested and actual
model), appended as a run event, and shown by `run poll`, `run resume`, and the supervisor
briefing. A substituted user pin is flagged as such; tell the user which model actually ran. If no
rung is left, the task fails with a `model_unavailable` outcome for you to escalate. A task other
tasks depend on never falls to `luna` (the plan-time leaf rule), unless the run is pinned to it
or was saved before automatic routing existed. Once its model is known unavailable and nothing
allowed is left, `run launch` refuses it and `run ready` lists it under `blocked`.
Only a rejection before the worker did anything counts: an error naming the model after work
began, or on a resume after `run answer`, is an ordinary failure, and so is one worded as an outage
("currently unavailable", "try again", "overloaded", a 5xx); retry those rather than re-route.
That split is inferred from wording: only the ChatGPT-account rejection has been observed. Runs saved by
0.5.x that route to `gpt-5.6-sol` or `gpt-5.6-terra`, or by 0.6.0–0.6.4 to `gpt-6-astra` or
`gpt-6.1-sol`, keep those exact slugs and are not substituted; if Codex rejects one, re-route the
task with `run plan`.

## Budgets

If the user sets a run budget, record it with `run budget <run-id> --max-attempts <n>`, `--max-elapsed-minutes <n>`, or `--max-worker-tokens <n>` (combinable). These stop new dispatch, not live work. Attempt limits include retired tasks and setup failures. Token counts are delayed and may be incomplete, so they are not an exact spend cap. Explain a reached budget rather than silently increasing or clearing it; revise limits only after the user agrees.

## Optional provisional guidance

Guidance is off by default. If the local learning store contains a supervisor- or user-reviewed
non-success outcome for this lane, the supervisor may explicitly enable fixed-template retry
guidance:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/orch.mjs" run guidance <run-id> \
  --mode provisional
```

This can only add a bounded advisory block to a retry briefing. It cannot change model or effort,
scope, constraints, task state, policy, or supervisor authority, and it never copies objectives,
evidence, source, or worker prose. Enabling, disabling, or rolling back guidance makes the current
checkpoint stale; review the policy version and hash, then checkpoint before dispatch. Use
`--mode off` as the kill switch and `--rollback` to restore the previous exact policy snapshot.
Leave guidance off when no reviewed typed outcome exists; do not fabricate a source from a worker
self-report. A single explicit supervisor or user review is enough to enable this provisional
mode, but it is not a high-confidence or promoted policy; the supervisor must still review the
policy hash and checkpoint every changed selection before dispatch.

## Warm and cold retries

A retry is warm by default: when the previous attempt reached a result or a supervisor verdict and
left a Codex thread id, the next `run launch` resumes that thread on the attempt's own model,
effort, and sandbox, in the same worktree. Its briefing gains a "Previous attempt" section with the
outcome, your evidence, your note, and the files the attempt changed. The retry starts cold (a new
thread, a new worktree, the same "Previous attempt" section) when the previous attempt crashed,
returned no result, was cancelled, or has no thread id, or when you pass `--fresh`. Use `--fresh`
when the earlier thread is anchored on a wrong approach you want the worker to drop. After an
integration conflict the retry still resumes the thread but in a fresh worktree at the integrated
head, so the worker redoes the change against it. If Codex reports the thread as missing, the
launch falls back to a fresh thread with the same briefing and records `task.resume_fallback`.
A route change in a revised plan does not force a cold start; the resumed thread runs on the new
route. The "Previous attempt" section is ordinary briefing text, separate from the fixed-template
provisional guidance block above, and does not loosen any guidance restriction.
