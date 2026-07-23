---
description: Compile a briefing for a lane, delegate it to Codex, then check what came back against the declared scope
argument-hint: "<lane> [--resume] [--background] <what Codex should do>"
allowed-tools: Bash(node:*), Agent, AskUserQuestion
---

Delegate a task to Codex with full lane context, then verify the result.

Run this inline, in the main thread. Do **not** fork a general-purpose subagent to do
it. The whole point of this command is that briefings are compiled by a supervisor that
already has the conversation context; a forked agent would start cold and re-derive the
very thing we are preserving.

Raw user request:
$ARGUMENTS

## Steps

**1. Parse.** The first positional token is the lane name. `--resume`, `--fresh`, and
`--background` are routing flags. Everything else is the task text.

**2. Compile the briefing.**

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/orch.mjs" brief <lane> --task "<task text>" --json
```

This also snapshots the working tree so step 5 can attribute changes to this run.

If it fails because orchestrator is not initialized, tell the user to run `/orch:init` and stop.
If it fails because the lane is unknown, show the known lanes and offer to create it with
`/orch:lanes add`. Do not invent a lane silently.

**3. Enrich the briefing.** You are the supervisor and you have context the CLI cannot see:
what the user just asked for, what was tried earlier this session, what you already know is
broken. Append a short `## Session context` section to the compiled briefing where that
genuinely helps. Keep it to a few lines. Do not restate the ledger — it is already included.

**4. Dispatch.** Invoke the `codex:codex-rescue` subagent via the `Agent` tool
(`subagent_type: "codex:codex-rescue"`), passing the enriched briefing as the prompt,
followed by the routing flags.

- Default to `--fresh`. The briefing carries the context, so a cold thread is cheap.
- Pass `--resume` only if the user asked for it explicitly. The upstream plugin's
  `--resume` means "resume the most recent thread in this Claude session", not "resume
  this lane's thread", so it is only correct when this lane was also the last one run.
- Pass `--background` through when the user asked for it, or when the task looks long.
- Do not add `--model` or `--effort` unless the user named one.

**5. Bind the thread.** If the Codex output includes a session or thread id, record it:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/orch.mjs" lane bind <lane> <thread-id>
```

This is the pointer the upstream plugin discards at `SessionEnd`. Keeping it means the user
can pick the thread back up later with `codex resume <thread-id>`. If no id appears in the
output, skip this step and say so — do not guess an id.

**6. Check the result.** Write Codex's full output to a temporary file **outside the
repository** — a file written inside it would show up as an out-of-scope, undeclared change
in its own report — then run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/orch.mjs" accept <lane> --result-file <path>
```

Exit code 2 means "needs review", not failure. Present the acceptance report alongside
Codex's summary. If files changed outside the lane's scope, or declared files show no
actual change, lead with that — those are the two findings the user most needs.

**7. Offer ledger entries.** If the run settled something durable — a convention, a working
build command, an approach that failed and why — propose it and add it only on confirmation:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/orch.mjs" ledger add <section> "<text>"
```

Propose at most three entries per run. The ledger rides along in every future briefing, so
noise is expensive.

## Rules

- Do not fix Codex's work yourself as part of this command. Report the acceptance findings
  and ask what the user wants done. If the run failed outright, say so and stop — do not
  quietly substitute your own implementation.
- Present Codex's summary substantially as written. You may lead with the acceptance report,
  but do not rewrite Codex's findings into your own words.
- If preflight is failing, run `/orch:init` guidance rather than improvising an auth flow.
