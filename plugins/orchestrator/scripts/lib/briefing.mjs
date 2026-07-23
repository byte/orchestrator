import { ledgerForBriefing } from "./ledger.mjs";

export const RESULT_HEADING = "## RESULT";

export const RESULT_FIELDS = ["files_touched", "decisions", "assumptions", "blockers", "confidence"];

/**
 * Compile a lane, the ledger, and a task into the prompt text handed to
 * `/codex:rescue`. This is the work the upstream rescue subagent is explicitly
 * forbidden from doing, which is why it happens here instead.
 */
export function renderBriefing({ lane, task, ledger, resuming = false }) {
  const blocks = [];

  blocks.push(
    resuming
      ? `You are continuing the "${lane.name}" workstream in this repository. You have prior context in this thread; the briefing below is the authoritative restatement of the standing constraints. Where it conflicts with your memory, the briefing wins.`
      : `You are picking up the "${lane.name}" workstream in this repository.`
  );

  blocks.push(`## Objective\n\n${String(task).trim()}`);

  if (lane.description) {
    blocks.push(`## Lane\n\n${lane.description}`);
  }

  const constraints = [
    ...(lane.constraints ?? []),
    "Stay inside the declared scope. If the fix requires touching a file outside it, stop and report that in `blockers` instead of widening the change yourself.",
    "Do not revisit anything recorded under Failed approaches below.",
    "If a stated constraint blocks the objective, say so rather than quietly working around it."
  ];
  blocks.push(`## Constraints\n\n${constraints.map((line) => `- ${line}`).join("\n")}`);

  const scope = lane.scope ?? [];
  blocks.push(
    scope.length
      ? `## Scope\n\nYou may modify files matching:\n\n${scope.map((line) => `- \`${line}\``).join("\n")}`
      : "## Scope\n\nNo scope patterns are declared for this lane. Keep the change as narrow as the objective allows and list every file you touch."
  );

  if (lane.done) {
    blocks.push(`## Definition of done\n\n${lane.done}`);
  }

  const ledgerBlock = renderLedger(ledger);
  if (ledgerBlock) {
    blocks.push(ledgerBlock);
  }

  blocks.push(renderResultContract());

  return `${blocks.join("\n\n")}\n`;
}

function renderLedger(ledger) {
  if (!ledger || ledger.isEmpty) {
    return "";
  }
  const body = ledger.populated
    .map(([section, entries]) => `### ${section}\n\n${entries.map((entry) => `- ${entry}`).join("\n")}`)
    .join("\n\n");
  return `## Established project context\n\nThese are settled. Do not re-derive or re-litigate them.\n\n${body}`;
}

function renderResultContract() {
  return `## Required output

End your response with exactly this block, and nothing after it:

${RESULT_HEADING}
files_touched: comma-separated repo-relative paths you modified, or "none"
decisions: choices you made that a reviewer would want to know about, or "none"
assumptions: anything you had to assume because it was not specified, or "none"
blockers: what stopped you, including scope you needed but did not have, or "none"
confidence: high | medium | low

Be literal in \`files_touched\`. It is checked against the actual diff.`;
}

/**
 * Extract the structured tail of a Codex response. The upstream plugin routes
 * task output as prose with no schema, so the contract is enforced by convention
 * here and verified against git in the acceptance check.
 */
export function parseResultBlock(text) {
  const source = String(text ?? "");
  const headingIndex = source.lastIndexOf(RESULT_HEADING);
  if (headingIndex === -1) {
    return { found: false, fields: {}, missing: [...RESULT_FIELDS] };
  }

  const body = source.slice(headingIndex + RESULT_HEADING.length);
  const fields = {};

  for (const line of body.split("\n")) {
    const match = /^\s*([a-z_]+)\s*:\s*(.*)$/.exec(line);
    if (!match) {
      continue;
    }
    const key = match[1];
    if (RESULT_FIELDS.includes(key) && !(key in fields)) {
      fields[key] = match[2].trim();
    }
  }

  return {
    found: true,
    fields,
    missing: RESULT_FIELDS.filter((field) => !(field in fields))
  };
}

const NONE_VALUES = new Set(["", "none", "n/a", "na", "-"]);

export function parseFileList(value) {
  const raw = String(value ?? "").trim();
  if (NONE_VALUES.has(raw.toLowerCase())) {
    return [];
  }
  return raw
    .split(/[,\n]/)
    .map((entry) => entry.trim().replace(/^[`'"]|[`'"]$/g, ""))
    .filter((entry) => entry && !NONE_VALUES.has(entry.toLowerCase()));
}

export function briefingLedger(cwd) {
  return ledgerForBriefing(cwd);
}
