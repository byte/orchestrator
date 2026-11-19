---
description: Show, add, or deprecate durable project facts carried into relevant Codex briefings
argument-hint: "[show|add|deprecate] [decisions|conventions|commands|failed approaches] [text]"
allowed-tools: Bash(node:*), AskUserQuestion
---

The ledger is the durable half of the system's memory. It survives context compaction,
session end, and machine restarts, and it is committed so teammates inherit it.

Raw user request:
$ARGUMENTS

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/orch.mjs" ledger show
node "${CLAUDE_PLUGIN_ROOT}/scripts/orch.mjs" ledger add <section> "<text>"
node "${CLAUDE_PLUGIN_ROOT}/scripts/orch.mjs" ledger show --lane <lane> --json
node "${CLAUDE_PLUGIN_ROOT}/scripts/orch.mjs" ledger add <section> "<text>" --lane <lane> --source "<reviewed-source>" --json
node "${CLAUDE_PLUGIN_ROOT}/scripts/orch.mjs" ledger deprecate <section> <entry-id> --reason "<why-outdated>"
```

Sections: `Decisions`, `Conventions`, `Commands`, `Failed approaches`. Text that begins with `--` (a flag the entry is about) goes after a `--` terminator: `ledger add Commands -- "--no-verify is banned"`.

What belongs here:

- **Decisions** — settled choices, so Codex stops re-litigating them.
- **Conventions** — how this codebase does things, where it is not obvious from a quick read.
- **Commands** — the build, test, and lint invocations that actually work here.
- **Failed approaches** — what was tried, and why it did not work. This is the highest-value
  section and the one people forget. It is the difference between Codex exploring and Codex
  re-exploring.

What does not belong: anything already obvious from the code, anything true only for the
current task, and anything that will be stale next week. Unscoped entries appear in every briefing; lane-scoped entries appear only in that lane. Optional `--provenance`, `--confirmed-by`, and `--confirmed-at` record known context; never invent confirmation. Metadata is human-editable context, not authenticated evidence.

If the ledger has grown past the point of being worth reading in full, identify conflicting or stale entries and offer to deprecate them. Deprecation retains history and omits the entry from future briefings; raw `ledger show` still shows everything. Inspect annotated IDs in raw Markdown (or use the exact dated bullet text for a legacy entry). Do not deprecate a settled decision just because a worker disagrees; review the evidence with the user first. Do not delete entries without confirmation.
