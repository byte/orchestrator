---
description: Show or add to the project ledger that gets carried into every Codex briefing
argument-hint: "[show|add] [decisions|conventions|commands|failed approaches] [text]"
allowed-tools: Bash(node:*), AskUserQuestion
---

The ledger is the durable half of the system's memory. It survives context compaction,
session end, and machine restarts, and it is committed so teammates inherit it.

Raw user request:
$ARGUMENTS

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/orch.mjs" ledger show
node "${CLAUDE_PLUGIN_ROOT}/scripts/orch.mjs" ledger add <section> "<text>"
```

Sections: `Decisions`, `Conventions`, `Commands`, `Failed approaches`.

What belongs here:

- **Decisions** — settled choices, so Codex stops re-litigating them.
- **Conventions** — how this codebase does things, where it is not obvious from a quick read.
- **Commands** — the build, test, and lint invocations that actually work here.
- **Failed approaches** — what was tried, and why it did not work. This is the highest-value
  section and the one people forget. It is the difference between Codex exploring and Codex
  re-exploring.

What does not belong: anything already obvious from the code, anything true only for the
current task, and anything that will be stale next week. Every entry is paid for on every
future briefing.

If the ledger has grown past the point of being worth reading in full, say so and offer to
prune the entries that have gone stale. Do not delete entries without confirmation.
