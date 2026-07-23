import fs from "node:fs";

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

export function addLedgerEntry(cwd, section, text) {
  const target = canonicalSection(section);
  const body = String(text ?? "").trim();
  if (!body) {
    throw new Error("A ledger entry needs text.");
  }

  const stamped = `(${new Date().toISOString().slice(0, 10)}) ${body}`;
  const existing = readLedger(cwd);
  const lines = existing.split("\n");
  const headingIndex = lines.findIndex((line) => new RegExp(`^##\\s+${target}\\s*$`, "i").test(line));

  if (headingIndex === -1) {
    const appended = `${existing.replace(/\s*$/, "")}\n\n## ${target}\n\n- ${stamped}\n`;
    fs.writeFileSync(ledgerFile(cwd), appended, "utf8");
    return { section: target, entry: stamped };
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
  return { section: target, entry: stamped };
}

export function ledgerForBriefing(cwd) {
  const text = readLedger(cwd);
  const sections = parseLedger(text);
  const populated = [...sections.entries()].filter(([, entries]) => entries.length > 0);
  const bytes = Buffer.byteLength(text, "utf8");

  return {
    populated,
    isEmpty: populated.length === 0,
    bytes,
    oversized: bytes > LEDGER_SOFT_LIMIT_BYTES
  };
}
