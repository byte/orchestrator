import fs from "node:fs";
import { randomUUID } from "node:crypto";

import { defaultLedger, ledgerFile } from "./state.mjs";

export const LEDGER_SECTIONS = ["Decisions", "Conventions", "Commands", "Failed approaches"];

// The ledger rides along in every briefing, so it has to stay small enough to be
// worth reading. Past this, it is a signal to prune rather than a hard failure.
export const LEDGER_SOFT_LIMIT_BYTES = 8 * 1024;

export function readLedger(cwd) {
  const filePath = ledgerFile(cwd);
  if (!fs.existsSync(filePath)) {
    return defaultLedger();
  }
  return fs.readFileSync(filePath, "utf8");
}

export function canonicalSection(name) {
  const wanted = String(name ?? "").trim().toLowerCase();
  const match = LEDGER_SECTIONS.find((section) => section.toLowerCase() === wanted);
  if (!match) {
    throw new Error(`Unknown ledger section "${name}". Use one of: ${LEDGER_SECTIONS.join(", ")}.`);
  }
  return match;
}

export function parseLedger(text) {
  const sections = new Map(LEDGER_SECTIONS.map((section) => [section, []]));
  let current = null;

  for (const line of String(text).split("\n")) {
    const heading = /^##\s+(.*?)\s*$/.exec(line);
    if (heading) {
      const found = LEDGER_SECTIONS.find((section) => section.toLowerCase() === heading[1].toLowerCase());
      current = found ?? null;
      continue;
    }
    const entry = /^\s*-\s+(.*\S)\s*$/.exec(line);
    if (entry && current) {
      sections.get(current).push(entry[1]);
    }
  }

  return sections;
}

// Optional metadata stays on the bullet so old readers still see normal dated
// Markdown, and hand-written entries never need a migration or sidecar store.
export function parseLedgerEntry(entry) {
  const match = /^(.*?)\s+<!-- orch-ledger:(\{.*\}) -->$/.exec(entry);
  if (match) {
    try {
      const metadata = JSON.parse(match[2]);
      if (metadata.version === 1 && typeof metadata.id === "string") {
        return { text: match[1], metadata };
      }
    } catch {
      // A malformed or future annotation is plain text, never silently hidden.
    }
  }
  return { text: entry, metadata: null };
}

function annotatedEntry(text, metadata) {
  if (!metadata) return text;
  const json = JSON.stringify(metadata).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
  return `${text} <!-- orch-ledger:${json} -->`;
}

function metadataOptions(options) {
  const metadata = {};
  for (const key of ["lane", "source", "provenance", "confirmedBy", "confirmedAt"]) {
    if (options[key] === undefined || options[key] === null) continue;
    if (typeof options[key] !== "string" || !options[key].trim() || /[\r\n]/.test(options[key])) {
      throw new Error(`Ledger ${key} must be a non-empty single-line string.`);
    }
    metadata[key] = options[key].trim();
  }
  if (metadata.confirmedAt && !Number.isFinite(Date.parse(metadata.confirmedAt))) {
    throw new Error("Ledger confirmedAt must be a date or timestamp.");
  }
  return Object.keys(metadata).length ? { version: 1, id: randomUUID(), ...metadata } : null;
}

/** Options: lane, source, provenance, confirmedBy, confirmedAt (all optional strings). */
export function addLedgerEntry(cwd, section, text, options = {}) {
  const target = canonicalSection(section);
  const body = String(text ?? "").trim();
  if (!body) {
    throw new Error("A ledger entry needs text.");
  }
  if (/[\r\n]/.test(body)) {
    throw new Error("A ledger entry must be a single line.");
  }

  const metadata = metadataOptions(options);
  const stamped = annotatedEntry(`(${new Date().toISOString().slice(0, 10)}) ${body}`, metadata);
  const result = { section: target, entry: stamped, ...(metadata ? { id: metadata.id, metadata } : {}) };
  const existing = readLedger(cwd);
  const lines = existing.split("\n");
  const headingIndex = lines.findIndex((line) => new RegExp(`^##\\s+${target}\\s*$`, "i").test(line));

  if (headingIndex === -1) {
    const appended = `${existing.replace(/\s*$/, "")}\n\n## ${target}\n\n- ${stamped}\n`;
    fs.writeFileSync(ledgerFile(cwd), appended, "utf8");
    return result;
  }

  // Insert at the end of this section, before the next heading.
  let insertAt = lines.length;
  for (let index = headingIndex + 1; index < lines.length; index += 1) {
    if (/^##\s+/.test(lines[index])) {
      insertAt = index;
      break;
    }
  }
  while (insertAt > headingIndex + 1 && lines[insertAt - 1].trim() === "") {
    insertAt -= 1;
  }

  // Keep the blank line after a heading so the file stays readable markdown.
  const needsSpacer = insertAt === headingIndex + 1;
  lines.splice(insertAt, 0, ...(needsSpacer ? ["", `- ${stamped}`] : [`- ${stamped}`]));
  fs.writeFileSync(ledgerFile(cwd), `${lines.join("\n").replace(/\s*$/, "")}\n`, "utf8");
  return result;
}

/** Explicitly retire one entry by metadata id or exact parsed bullet text.
 * Legacy entries can be selected by their dated text. Nothing is deleted.
 */
export function deprecateLedgerEntry(cwd, section, selector, { reason, deprecatedBy = null } = {}) {
  const target = canonicalSection(section);
  if (typeof selector !== "string" || !selector.trim()) {
    throw new Error("Deprecating a ledger entry requires an entry id or exact bullet text.");
  }
  if (typeof reason !== "string" || !reason.trim() || /[\r\n]/.test(reason)) {
    throw new Error("Deprecating a ledger entry requires a single-line reason.");
  }
  if (deprecatedBy !== null && (typeof deprecatedBy !== "string" || !deprecatedBy.trim() || /[\r\n]/.test(deprecatedBy))) {
    throw new Error("Ledger deprecatedBy must be a non-empty single-line string.");
  }
  const lines = readLedger(cwd).split("\n");
  const matches = [];
  let current = null;
  for (const [index, line] of lines.entries()) {
    const heading = /^##\s+(.*?)\s*$/.exec(line);
    if (heading) current = heading[1].toLowerCase();
    const bullet = /^(\s*-\s+)(.*\S)\s*$/.exec(line);
    if (!bullet || current !== target.toLowerCase()) continue;
    const parsed = parseLedgerEntry(bullet[2]);
    if (selector === parsed.metadata?.id || selector === bullet[2] || selector === parsed.text) {
      matches.push({ index, prefix: bullet[1], ...parsed });
    }
  }
  if (matches.length !== 1) {
    throw new Error(matches.length ? "Ledger selector is ambiguous; use an entry id." : "Ledger entry not found in that section.");
  }
  const selected = matches[0];
  const metadata = selected.metadata ?? { version: 1, id: randomUUID() };
  if (!metadata.deprecated) {
    metadata.deprecated = { at: new Date().toISOString(), reason: reason.trim(), ...(deprecatedBy ? { by: deprecatedBy.trim() } : {}) };
    lines[selected.index] = `${selected.prefix}${annotatedEntry(selected.text, metadata)}`;
    fs.writeFileSync(ledgerFile(cwd), lines.join("\n"), "utf8");
  }
  return { section: target, entry: annotatedEntry(selected.text, metadata), id: metadata.id, metadata };
}

/** No lane means all lanes; a lane includes its facts plus unscoped/legacy facts.
 * Deprecated facts are retained on disk but omitted unless explicitly requested.
 */
export function ledgerForBriefing(cwd, { lane = null, includeDeprecated = false } = {}) {
  const text = readLedger(cwd);
  const sections = parseLedger(text);
  const populated = [...sections.entries()].map(([section, entries]) => [section, entries.flatMap((entry) => {
    const { text: body, metadata } = parseLedgerEntry(entry);
    if (!metadata) return [body];
    if (metadata.deprecated && !includeDeprecated) return [];
    if (lane && metadata.lane && metadata.lane !== lane) return [];
    const details = [
      ...["lane", "source", "provenance", "confirmedBy", "confirmedAt"].filter((key) => metadata[key])
        .map((key) => `${key}: ${metadata[key]}`),
      ...(metadata.deprecated ? [`DEPRECATED: ${metadata.deprecated.reason}`] : [])
    ];
    return [details.length ? `${body} [${details.join("; ")}]` : body];
  })]).filter(([, entries]) => entries.length > 0);
  const bytes = Buffer.byteLength(text, "utf8");

  return {
    populated,
    isEmpty: populated.length === 0,
    bytes,
    oversized: bytes > LEDGER_SOFT_LIMIT_BYTES
  };
}
