# Worker-request reference

Read from `/orchestrator:run` when a task is `needs_input`.

A worker no longer has to stop when it needs one adjacent file outside its scope or when its
objective admits two materially different readings. It returns `needs_input` with a typed request
instead: a `scope_extension` (exact paths and the reason) or a `question` (the question and the
options it sees). The task is then `needs_input`: paused, not finished, holding its pool slot, with
no outcome recorded. Answer it promptly; a paused worker does no work.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/orch.mjs" run answer <run-id> <task-id> \
  --grant-scope "<glob>" \
  --reply "<optional explanation>"
```

Use exactly one decision: `--grant-scope <glob>` (repeatable, write tasks and scope requests only),
`--deny`, or `--reply <text>`. A `--reply` may accompany a grant or a denial to explain it. The same
attempt resumes on the same Codex thread, in the same worktree, on the model and effort the
attempt is actually using (a substituted model stays substituted) and the task's sandbox. The
resumed thread receives only your answer; if Codex no longer has the thread it falls back to a
fresh thread with the full briefing, which carries every answer so far.

Authority over a grant:

- You may grant an extension inside the lane on your own authority when the change is necessary,
  adjacent, and small. Prefer the narrowest grant that covers the request; a literal path is
  better than a glob.
- You must ask the user before granting anything outside the lane. The runtime refuses such a
  grant until you repeat it with `--user-approved`, which records that the user agreed.
- A grant belongs to the task, not the lane: the lane's scope and the task's planned scope stay
  unchanged, and `run inspect` and `run integrate` accept the granted paths for that task only.
  Everything else out of scope is still refused.
- The runtime refuses a grant that may overlap the write surface of another task that is running,
  paused, or reported but not yet integrated. Deny it, narrow it, or wait for that task. The
  grant stays exclusive afterwards: a task that was pending when it was made cannot launch onto it
  (`run launch` refuses and names the grant) until the granted task is integrated or cancelled.
- Deny when the change belongs to another task or would widen the task's purpose; say in
  `--reply` how the worker should proceed within scope.

Answer a question with `--reply`. Use `--deny` only when you cannot or will not choose; the worker
is then told to finish only what is unambiguous or report a blocker. If the question exposes a
genuinely ambiguous objective that the user must settle, ask the user, then reply.

A round trip is not a failed attempt and does not consume a retry: no new attempt is created, no
outcome is recorded, and learning data later sees the one outcome the attempt ends with. A task
gets at most 3 answered round trips; a further request is recorded as an ordinary blocker
(`worker_blocked` / `scope_required` or `ambiguous_objective`) for you to resolve by retry or
replan.
