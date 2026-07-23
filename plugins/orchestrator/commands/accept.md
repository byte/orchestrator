---
description: Check the working tree against what Codex said it did on a lane
argument-hint: "<lane> [--result-file <path>]"
allowed-tools: Bash(node:*)
---

Re-run the acceptance check for a lane. `/orch:do` does this automatically; use this command
to re-check after further edits, or to check a run that was dispatched in the background.

Raw user request:
$ARGUMENTS

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/orch.mjs" accept <lane> --result-file <path>
```

If the user has Codex output to check against, write it to a temporary file **outside the
repository** and pass `--result-file`. A result file written inside the repo becomes an
out-of-scope, undeclared change in its own report.

Without a result file the check still reports scope violations — it just cannot cross-check
declared files against actual ones.

Exit code 2 means "needs review", not "failed".

Lead with scope violations and phantom files. A file declared as touched that shows no
actual change usually means the run died partway and the summary describes intent rather
than outcome — that is worth surfacing before anything else.

Report the findings. Do not fix them as part of this command.
