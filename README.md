# orchestrator

A boss layer for delegating work from Claude Code to Codex.

Claude supervises well but executes slowly. Codex executes fast but needs a nanny.
`orchestrator` is the nanny: it compiles context before dispatch, keeps Codex threads
addressable across sessions, and checks what came back against what was asked for.

It **composes with** the official [`openai/codex-plugin-cc`](https://github.com/openai/codex-plugin-cc)
plugin rather than replacing it. That plugin already handles the hard parts — the Codex
app-server broker, background job control, auth, cancellation. This one adds the layer above.

## Install

Requires [Codex CLI](https://developers.openai.com/codex/cli/) (authenticated), Node 18.18+,
and the Codex plugin:

```
/plugin marketplace add openai/codex-plugin-cc
/plugin install codex@openai-codex
```

Then:

```
/plugin marketplace add byte/orchestrator
/plugin install orchestrator@orchestrator
/reload-plugins
/orch:init
```

`/orch:init` tells you what is missing and how to fix it. It cannot install or authenticate
Codex for you.

## Use

```
/orch:lanes add api --scope 'src/api/**' --constraint 'No new dependencies' --done 'npm test passes'
/orch:do api add cursor pagination to the /users endpoint
```

`/orch:do` compiles a briefing from the lane and the ledger, delegates it to Codex, records
the thread id, and reports what actually changed:

```
# Acceptance check — api

Verdict: needs review

## Problems

- 1 file(s) changed outside the lane's declared scope
- 1 declared file(s) show no actual change
```

That second line is the one worth having. A file reported as touched that shows no actual
change usually means the run died partway and the summary describes intent, not outcome —
under a `confidence: high` header.

## Commands

| Command | What it does |
| --- | --- |
| `/orch:init` | Create `.orchestrator/`, preflight the toolchain |
| `/orch:lanes` | List, create, edit, bind, or remove lanes |
| `/orch:do` | Brief → delegate → bind thread → check result |
| `/orch:ledger` | Show or add durable project facts |
| `/orch:accept` | Re-check a lane against what Codex reported |

## Why

The upstream plugin's delegation path has four gaps, each of which pushes supervision cost
back onto the human.

**1. The delegating subagent is deliberately blind.** `agents/codex-rescue.md` states it is
"a thin forwarding wrapper" and forbids it from inspecting the repository. Codex receives the
user's raw task text and a filesystem. It re-derives conventions, re-discovers the build
command, and re-litigates decisions settled three tasks ago.

**2. Resume pointers die with the Claude session — but the threads don't.** The plugin
persists named Codex threads and stores each `threadId` on its job record. Resume resolution
filters to jobs from the *current* Claude session, and the `SessionEnd` hook deletes those
jobs. The thread survives on disk with everything it learned about your code; the handle to
it is discarded when you close Claude.

**3. `--resume-last` is a boolean, not an address.** One implicit lane per repository. Two
parallel workstreams collide onto the same thread.

**4. Delegated task output is unverified prose.** Reviews have an output schema; tasks do
not. Nothing checks Codex's claims against the actual diff.

Plugin state also lives in `CLAUDE_PLUGIN_DATA`, falling back to `os.tmpdir()`, capped at 50
jobs — nothing durable, in-repo, or reviewable.

## How it works

Four components, layered on `/codex:rescue`, which passes task text through verbatim. That
pass-through is the seam everything hangs off.

### Briefing compiler

The repository inspection the forwarder is forbidden to do, performed *before* dispatch:
objective, standing constraints, scope, definition of done, ledger, and a required result
contract. Compiled **inline in the main thread**, never in a forked subagent — a forked agent
starts cold, which is the exact problem being solved. The supervising model is whatever is
running your session, so this inherits new models instead of pinning one.

### Lanes

Named workstreams. Scope patterns support `*`, `**`, `?`, and a leading `!` to exclude, with
later patterns winning:

```
--scope 'src/**' --scope '!src/generated/**'
```

### Ledger

Durable facts — decisions, conventions, working build commands, and failed approaches with
reasons. Committed to git, so it is diffable, reviewable in PRs, and inherited by teammates.
It survives context compaction, which is the half of the system's memory Claude cannot keep.

### Acceptance check

`brief` snapshots the working tree; `accept` diffs it afterwards and reports three things:
changes outside the declared scope, changes never declared, and declared files that never
changed. Pre-existing dirt is attributed separately, so a messy tree does not produce noise.
Exit code 2 means "needs review".

## State

```
.orchestrator/
  lanes.json          # committed — lane names, scope, constraints
  ledger.md           # committed — the durable shared artifact
  local/threads.json  # self-ignored — thread bindings and snapshots, this machine only
```

The split is deliberate. A Codex thread lives in `~/.codex` on one machine, so committing
that binding would hand teammates dangling pointers. Lane definitions and accumulated
knowledge travel; machine-local pointers do not. `.orchestrator/.gitignore` handles this
without touching your root `.gitignore`.

Both committed files carry a `version` field. State written by a newer orchestrator is
refused rather than misread.

## Known limitations

**Resume is not thread-addressed.** The upstream plugin's `--resume` means "resume the most
recent thread in this Claude session", not "resume this lane's thread". `/orch:do` therefore
defaults to `--fresh` and lets the briefing carry the context. A lane's bound `threadId` is a
durable handoff pointer — its value is surviving `SessionEnd`, so you can reopen that thread
with `codex resume <thread-id>`. Thread-addressed resume would require driving the Codex app
server directly instead of composing with the plugin.

**Thread ids are scraped from `/codex:result` output.** If that format changes upstream,
binding breaks. Dispatch is isolated behind one seam so this can be swapped.

**Result contract is by convention.** Because dispatch goes through `/codex:rescue`, we
cannot pass `--output-schema`. The `## RESULT` block is requested in the briefing and
verified against git afterwards, rather than enforced by the model runtime.

## Development

```
npm test
```

No dependencies — Node built-ins only. Tests create throwaway git repositories and never
invoke Codex, so the suite costs no quota.

## License

Apache-2.0.
