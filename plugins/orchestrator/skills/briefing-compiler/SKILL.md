---
name: briefing-compiler
description: How to write the task text handed to Codex so it does not need supervision — use when planning `/orchestrator:run` tasks, writing a lane definition, or when a worker came back out of scope or having re-derived known context
---

# Briefing compiler

Codex executes fast and re-derives everything it was not told. Most of what looks like
"needing a nanny" is a briefing problem, not a capability problem. This skill is about
closing that gap before dispatch instead of correcting after it.

## What a good briefing contains

The runtime (`run launch`) assembles the mechanical parts of every worker prompt: the run
goal, the task objective and kind, scope patterns, lane and task constraints, acceptance
criteria, completed dependency context, the ledger, and the output schema. Your job is the
part it cannot see, and it goes into the task you save with `run plan`.

**Add session context to the objective and constraints.** You know what the user asked five
minutes ago, what was already tried, and what you know is broken. The runtime does not. A
few lines here save an entire exploration cycle.

**State the objective as an outcome, not a procedure.** "Make `run inspect` attribute
renames to a single file" beats "edit git.mjs to handle the R status code". Codex is good
at finding the path; prescribing it wastes that and often picks a worse one.

**Name the things not to do.** Constraints are cheaper than corrections. If a dependency is
off-limits or a file is load-bearing, say so once in the lane rather than in every task.

**Be specific about scope.** A scope glob that matches the whole repo catches nothing.
Worktree inspection is only as useful as the boundary it enforces.

## Antipatterns

- **Restating the ledger.** It is already in the worker prompt. Duplicating it wastes
  budget and creates two versions to disagree with each other.
- **Padding with repository tours.** Codex can read the repo faster than you can describe
  it. Include what is *not* discoverable: intent, history, constraints, dead ends.
- **Burying the objective** under context. Lead with what should be true when it is done.
- **Asking for a plan when you want a change**, or vice versa. Say which, and pick the task
  `kind` to match.
- **Vague acceptance criteria.** "Works correctly" cannot be checked. "`npm test` passes and
  `run inspect` reports the declared files only" can.

## After the run

Read `run inspect` and the worker's structured result before its prose summary. Scope
violations and declared-but-unchanged files are findings about the *briefing* as much as
about the run: work that landed outside scope usually means the scope was drawn wrong, and a
re-derived convention means the ledger has a gap. Fix the task, the lane, or the ledger, not
just the code, before you retry.
