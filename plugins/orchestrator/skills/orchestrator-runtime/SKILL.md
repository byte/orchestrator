---
name: orchestrator-runtime
description: Internal contract for the orchestrator CLI — how to compile briefings, dispatch to Codex, bind lane threads, and check results
user-invocable: false
---

# Orchestrator runtime

Helper: `node "${CLAUDE_PLUGIN_ROOT}/scripts/orch.mjs" <command>`

Commands: `preflight`, `init`, `lane`, `brief`, `accept`, `ledger`.
All support `--json` where structured output is useful.

## Execution rules

- Everything here runs **inline in the main thread**. Never fork a general-purpose subagent
  to compile a briefing or evaluate a result. A forked agent starts cold, which is the exact
  failure this plugin exists to prevent.
- The only subagent involved is `codex:codex-rescue`, from the upstream Codex plugin, and it
  is a thin forwarder. Give it the compiled briefing and routing flags; nothing else.
- Always `brief` before dispatching. It writes the pre-dispatch snapshot that `accept`
  needs to attribute changes. Without it, `accept` cannot tell this run's edits from
  whatever was already dirty.
- Never hand-roll `codex exec` calls. Dispatch goes through the upstream plugin.

## Resume semantics

The upstream plugin's `--resume` means "resume the most recent Codex thread in this Claude
session". It is not thread-addressed, so it is only correct when the lane being dispatched
is also the most recently run one. Default to `--fresh` and let the briefing carry the
context.

A lane's bound `threadId` is a durable handoff pointer, not something the plugin can be
told to resume. Its value is that it survives `SessionEnd` — the user can reopen that
thread directly with `codex resume <thread-id>`.

## Result handling

- `accept` exits 2 for "needs review". That is a signal, not an error.
- Lead with scope violations and phantom files.
- Do not repair Codex's work as part of a dispatch. Report and ask.
- If Codex was never successfully invoked, do not substitute your own implementation.
- Preserve Codex's own distinctions between observed fact, inference, and open question.

## Ledger discipline

Propose at most three entries per run, and only for things that will still be true next
month. Every entry is paid for on every future briefing.
