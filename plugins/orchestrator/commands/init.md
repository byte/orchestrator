---
description: Set up orchestrator in this repository and check that Codex is ready
allowed-tools: Bash(node:*), AskUserQuestion
---

Initialize orchestrator and report whether Codex workers will actually be able to launch.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/orch.mjs" init
```

Present the output, then:

- If any blocking check failed, give the exact remedy command from the report. The Codex
  CLI and Codex login are prerequisites this plugin cannot install for the user — do not
  improvise an alternate auth flow. `/orchestrator:run` invokes Codex CLI directly; no Claude-side
  Codex plugin is needed.
- If the repository has no lanes yet, offer to create a first one. A good starting lane is
  narrow: one subsystem, an explicit scope glob, and a definition of done.
- Mention that `.orchestrator/lanes.json` and `.orchestrator/ledger.md` are meant to be
  committed, and that `.orchestrator/local/` is self-ignored because run state, worker handles,
  and worktrees only mean anything on this machine.

Also note, once: the model running this main thread is the supervisor that plans, routes,
reviews, and integrates every run, and the plugin never selects it. Claude Opus 5.5 and Claude
Fable 5.2 are the supported supervisors; start `/orchestrator:run` from a session on one of them.
