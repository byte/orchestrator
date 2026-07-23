import fs from "node:fs";
import path from "node:path";

import { resolveWorkspaceRoot } from "./workspace.mjs";

export const STATE_VERSION = 1;

const ORCH_DIR = ".orchestrator";
const LOCAL_DIR = "local";
const LANES_FILE = "lanes.json";
const LEDGER_FILE = "ledger.md";
const THREADS_FILE = "threads.json";

// Thread ids and snapshots are machine-local: a Codex thread lives in ~/.codex on
// one machine, so committing that binding would hand teammates dangling pointers.
// Lane definitions and the ledger are the shareable half and stay tracked.
const LOCAL_GITIGNORE = `# Machine-local orchestrator state. Thread ids and snapshots
# are meaningless on another machine, so they are never committed.
${LOCAL_DIR}/
`;

export function orchDir(cwd) {
  return path.join(resolveWorkspaceRoot(cwd), ORCH_DIR);
}

export function lanesFile(cwd) {
  return path.join(orchDir(cwd), LANES_FILE);
}

export function ledgerFile(cwd) {
  return path.join(orchDir(cwd), LEDGER_FILE);
}

export function localDir(cwd) {
  return path.join(orchDir(cwd), LOCAL_DIR);
}

export function threadsFile(cwd) {
  return path.join(localDir(cwd), THREADS_FILE);
}

export function isInitialized(cwd) {
  return fs.existsSync(lanesFile(cwd));
}

function readJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`${filePath} is not valid JSON: ${error.message}`);
  }
  const version = Number(parsed?.version ?? 0);
  if (version > STATE_VERSION) {
    throw new Error(
      `${filePath} was written by a newer orchestrator (state version ${version}, this build supports ${STATE_VERSION}). Upgrade the plugin.`
    );
  }
  return parsed;
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return filePath;
}

export function nowIso() {
  return new Date().toISOString();
}

export function initWorkspace(cwd) {
  const root = resolveWorkspaceRoot(cwd);
  const dir = orchDir(root);
  const created = [];

  fs.mkdirSync(path.join(dir, LOCAL_DIR), { recursive: true });

  const gitignorePath = path.join(dir, ".gitignore");
  if (!fs.existsSync(gitignorePath)) {
    fs.writeFileSync(gitignorePath, LOCAL_GITIGNORE, "utf8");
    created.push(gitignorePath);
  }

  if (!fs.existsSync(lanesFile(root))) {
    writeJson(lanesFile(root), { version: STATE_VERSION, lanes: {} });
    created.push(lanesFile(root));
  }

  if (!fs.existsSync(ledgerFile(root))) {
    fs.writeFileSync(ledgerFile(root), defaultLedger(), "utf8");
    created.push(ledgerFile(root));
  }

  if (!fs.existsSync(threadsFile(root))) {
    writeJson(threadsFile(root), { version: STATE_VERSION, threads: {}, snapshots: {} });
    created.push(threadsFile(root));
  }

  return { root, dir, created };
}

export function defaultLedger() {
  return `# Ledger

Durable facts about this project, carried into every delegated task.
Keep entries short and specific. Delete what stops being true.

## Decisions

## Conventions

## Commands

## Failed approaches
`;
}

export function loadLanesState(cwd) {
  const state = readJson(lanesFile(cwd), { version: STATE_VERSION, lanes: {} });
  return {
    version: STATE_VERSION,
    lanes: state.lanes && typeof state.lanes === "object" ? state.lanes : {}
  };
}

export function saveLanesState(cwd, state) {
  return writeJson(lanesFile(cwd), {
    version: STATE_VERSION,
    lanes: state.lanes ?? {}
  });
}

export function loadLocalState(cwd) {
  const state = readJson(threadsFile(cwd), { version: STATE_VERSION, threads: {}, snapshots: {} });
  return {
    version: STATE_VERSION,
    threads: state.threads && typeof state.threads === "object" ? state.threads : {},
    snapshots: state.snapshots && typeof state.snapshots === "object" ? state.snapshots : {}
  };
}

export function saveLocalState(cwd, state) {
  return writeJson(threadsFile(cwd), {
    version: STATE_VERSION,
    threads: state.threads ?? {},
    snapshots: state.snapshots ?? {}
  });
}

export function updateLocalState(cwd, mutate) {
  const state = loadLocalState(cwd);
  mutate(state);
  return saveLocalState(cwd, state);
}
