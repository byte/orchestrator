---
name: briefing-compiler
description: How to write the task text handed to Codex so it does not need supervision — use when delegating work to Codex, writing a lane definition, or when a delegated run came back out of scope or having re-derived known context
---

# Briefing compiler

Codex executes fast and re-derives everything it was not told. Most of what looks like
"needing a nanny" is a briefing problem, not a capability problem. This skill is about
closing that gap before dispatch instead of correcting after it.

## What a good briefing contains

The CLI (`orch brief`) assembles the mechanical parts: lane description, standing
constraints, scope patterns, definition of done, ledger, and the required result contract.
Your job is the part it cannot see.

**Add session context.** You know what the user asked five minutes ago, what was already
tried, and what you know is broken. The CLI does not. A few lines here saves an entire
exploration cycle.

**State the objective as an outcome, not a procedure.** "Make `orch accept` attribute
renames to a single file" beats "edit git.mjs to handle the R status code". Codex is good
at finding the path; prescribing it wastes that and often picks a worse one.

**Name the things not to do.** Constraints are cheaper than corrections. If a dependency is
off-limits or a file is load-bearing, say so once in the lane rather than every task.

**Be specific about scope.** A scope glob that matches the whole repo catches nothing. The
acceptance check is only as useful as the boundary it enforces.

## Antipatterns

- **Restating the ledger.** It is already in the compiled briefing. Duplicating it wastes
  budget and creates two versions to disagree with each other.
- **Padding with repository tours.** Codex can read the repo faster than you can describe
  it. Include what is *not* discoverable: intent, history, constraints, dead ends.
- **Burying the objective** under context. Lead with what should be true when it is done.
- **Asking for a plan when you want a change**, or vice versa. Say which.
- **Vague done criteria.** "Works correctly" cannot be checked. "`npm test` passes and
  `orch accept` reports clean" can.

## After the run

Read the acceptance report before the prose summary. Scope violations and phantom files are
findings about the *briefing* as much as about the run: work that landed outside scope
usually means the scope was drawn wrong, and a re-derived convention means the ledger has a
gap. Fix the lane or the ledger, not just the code.
