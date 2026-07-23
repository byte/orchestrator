# Changelog

## 0.1.0

Initial release.

- `/orch:init` — set up `.orchestrator/` and preflight the Codex toolchain
- `/orch:lanes` — named workstreams with scope patterns, standing constraints, and a
  definition of done
- `/orch:do` — compile a briefing, delegate to Codex via `/codex:rescue`, bind the returned
  thread, and check the result
- `/orch:ledger` — durable project facts carried into every briefing
- `/orch:accept` — re-check a lane's working tree against what Codex reported

Lane definitions and the ledger are committed; thread bindings and pre-dispatch snapshots
stay machine-local under `.orchestrator/local/`.
