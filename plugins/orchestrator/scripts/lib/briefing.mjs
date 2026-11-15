// The plain-text result contract. Pool workers return structured JSON through
// an output schema; this parser remains the fallback `run report` uses when a
// result arrives as prose ending in a "## RESULT" block.
export const RESULT_HEADING = "## RESULT";

export const RESULT_FIELDS = ["files_touched", "decisions", "assumptions", "blockers", "confidence"];

/**
 * Extract the structured tail of a prose Codex response.
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
