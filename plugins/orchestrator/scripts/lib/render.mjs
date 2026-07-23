export function renderPreflight(report) {
  const lines = ["# Orchestrator preflight", ""];
  for (const check of report.checks) {
    lines.push(`- ${check.ok ? "ok" : "MISSING"}  ${check.label} — ${check.detail}`);
  }
  if (report.blocking.length) {
    lines.push("", "## Fix these first", "");
    for (const check of report.blocking) {
      lines.push(`- ${check.label}: \`${check.remedy}\``);
    }
  } else {
    lines.push("", "Ready to dispatch.");
  }
  return lines.join("\n");
}

export function renderLanes(lanes) {
  if (!lanes.length) {
    return "No lanes yet. Create one with `/orch:lanes add <name> --scope <glob>`.";
  }
  const lines = ["# Lanes", ""];
  for (const lane of lanes) {
    lines.push(`## ${lane.name}`);
    if (lane.description) {
      lines.push(lane.description);
    }
    lines.push(`- scope: ${lane.scope?.length ? lane.scope.map((s) => `\`${s}\``).join(", ") : "(none declared)"}`);
    if (lane.constraints?.length) {
      lines.push(`- constraints: ${lane.constraints.length}`);
    }
    if (lane.done) {
      lines.push(`- done when: ${lane.done}`);
    }
    lines.push(`- codex thread: ${lane.threadId ? `\`${lane.threadId}\` (bound ${lane.threadBoundAt})` : "unbound — next dispatch starts fresh"}`);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

export function renderAcceptance(lane, evaluation) {
  const lines = [`# Acceptance check — ${lane.name}`, ""];
  lines.push(evaluation.verdict === "clean" ? "Verdict: clean" : "Verdict: needs review");

  if (evaluation.problems.length) {
    lines.push("", "## Problems", "");
    for (const problem of evaluation.problems) {
      lines.push(`- ${problem}`);
    }
  }

  lines.push("", "## Changes attributed to this run", "");
  lines.push(evaluation.changed.length ? evaluation.changed.map((file) => `- ${file}`).join("\n") : "- (none)");

  if (evaluation.outOfScope.length) {
    lines.push("", "## Outside declared scope", "");
    lines.push(evaluation.outOfScope.map((file) => `- ${file}`).join("\n"));
  }
  if (evaluation.undeclared.length) {
    lines.push("", "## Changed but not declared", "");
    lines.push(evaluation.undeclared.map((file) => `- ${file}`).join("\n"));
  }
  if (evaluation.phantom.length) {
    lines.push("", "## Declared but unchanged", "");
    lines.push(evaluation.phantom.map((file) => `- ${file}`).join("\n"));
  }
  if (evaluation.preexisting.length) {
    lines.push("", "## Pre-existing changes (not attributed to this run)", "");
    lines.push(evaluation.preexisting.map((file) => `- ${file}`).join("\n"));
  }
  if (evaluation.committed?.length) {
    lines.push("", "## Changes committed during this run", "");
    lines.push(evaluation.committed.map((file) => `- ${file}`).join("\n"));
  }

  if (evaluation.result.found) {
    const { fields } = evaluation.result;
    lines.push("", "## Reported by Codex", "");
    for (const key of ["decisions", "assumptions", "blockers", "confidence"]) {
      if (fields[key]) {
        lines.push(`- ${key}: ${fields[key]}`);
      }
    }
  }

  return lines.join("\n");
}
