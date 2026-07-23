---
description: List, create, or edit the workstream lanes that carry context between Codex tasks
argument-hint: "[list|add|show|remove|bind|unbind] [name] [--scope <glob>]... [--constraint <text>]... [--done <text>]"
allowed-tools: Bash(node:*), AskUserQuestion
---

Manage lanes. A lane is a named workstream: a scope, standing constraints, a definition of
done, and — on this machine only — a bound Codex thread id.

Raw user request:
$ARGUMENTS

Forward to the CLI:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/orch.mjs" lane <action> [name] [flags]
```

With no arguments, list lanes.

When creating a lane, help the user make it useful rather than accepting a bare name:

- **scope** should be tight enough that a violation is meaningful. `src/**` on a repo whose
  code all lives in `src/` catches nothing. Prefer the subsystem the lane is actually about.
- **constraints** are the things you would otherwise repeat in every task ("no new
  dependencies", "keep the public API stable").
- **done** is what makes the acceptance check legible to a human later.

Scope patterns support `*`, `**`, `?`, and a leading `!` to exclude. Later patterns win, so
`--scope 'src/**' --scope '!src/generated/**'` reads the way it looks.

If the user is defining a lane for work already under way, offer to seed the ledger with any
decisions already settled in this conversation.
