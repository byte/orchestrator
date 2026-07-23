---
description: Set up orchestrator in this repository and check that Codex is ready
allowed-tools: Bash(node:*), AskUserQuestion
---

Initialize orchestrator and report whether delegation will actually work.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/orch.mjs" init
```

Present the output, then:

- If any blocking check failed, give the exact remedy command from the report. The Codex
  plugin and Codex login are prerequisites this plugin cannot install for the user — do not
  improvise an alternate auth flow.
- If the repository has no lanes yet, offer to create a first one. A good starting lane is
  narrow: one subsystem, an explicit scope glob, and a definition of done.
- Mention that `.orchestrator/lanes.json` and `.orchestrator/ledger.md` are meant to be
  committed, and that `.orchestrator/local/` is self-ignored because thread bindings only
  mean anything on this machine.

Also note, once: orchestrator compiles briefings in whatever model is running the main
thread. It is worth the overhead when that model is a strong supervising model, and much
less so otherwise.
