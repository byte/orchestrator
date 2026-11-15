export function renderPreflight(report) {
  const lines = ["# Orchestrator preflight", ""];
  for (const check of report.checks) {
    const status = check.ok ? "ok" : check.optional ? "optional" : "MISSING";
    lines.push(`- ${status}  ${check.label} — ${check.detail}`);
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
    return "No lanes yet. Create one with `/orchestrator:lanes add <name> --scope <glob>`.";
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
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}
