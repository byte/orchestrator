import fs from "node:fs";
import path from "node:path";

import { resolveWorkspaceRoot } from "./workspace.mjs";

// Version 6 routes to the GPT-6 roster and records model substitutions. A 0.5.x
// build refuses it rather than misreading slugs it does not know. Versions 3-5
// still load and keep their exact persisted slugs.
export const RUN_STATE_VERSION = 6;

// `RUN_STATE_VERSION` belongs to durable run state. Lanes and local thread pointers
// have their own stable schemas because their shape did not change when run
// state advanced. Keep the legacy `version` at 1 so older releases can still
// read files written by this release; newer releases use the explicit marker
// and schema version for fail-closed evolution.
export const LANES_STATE_SCHEMA = "orchestrator.lanes";
export const LOCAL_STATE_SCHEMA = "orchestrator.local-threads";
export const SHARED_STATE_SCHEMA_VERSION = 1;
export const SHARED_STATE_COMPATIBILITY_VERSION = 1;

// Releases before the per-file markers wrote the run-state version into these
// files. Version 5 was the last such shared value, so accept those legacy files
// and migrate them on the next mutation. An unmarked higher value remains a
// future-state signal and is rejected.
const MAX_UNMARKED_SHARED_STATE_VERSION = 5;

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
  const dir = orchDir(cwd);
  return [
    path.join(dir, ".gitignore"),
    lanesFile(cwd),
    ledgerFile(cwd)
  ].every((filePath) => fs.existsSync(filePath));
}

function sharedStateEnvelope(schema, payload) {
  return {
    version: SHARED_STATE_COMPATIBILITY_VERSION,
    schema,
    schemaVersion: SHARED_STATE_SCHEMA_VERSION,
    ...payload
  };
}

function validateSharedStateSchema(filePath, parsed, expectedSchema) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${filePath} must contain a state object.`);
  }
  const hasSchema = Object.hasOwn(parsed ?? {}, "schema");
  const hasSchemaVersion = Object.hasOwn(parsed ?? {}, "schemaVersion");
  if (hasSchema || hasSchemaVersion) {
    if (!hasSchema || !hasSchemaVersion) {
      throw new Error(`${filePath} has an incomplete state schema marker.`);
    }
    if (parsed.schema !== expectedSchema) {
      throw new Error(
        `${filePath} has state schema ${String(parsed.schema)}; expected ${expectedSchema}.`
      );
    }
    if (parsed.schemaVersion !== SHARED_STATE_SCHEMA_VERSION) {
      throw new Error(
        `${filePath} was written with ${expectedSchema} schema version ` +
          `${String(parsed.schemaVersion)}; this build supports ` +
          `${SHARED_STATE_SCHEMA_VERSION}. Upgrade the plugin.`
      );
    }
    if (parsed.version !== SHARED_STATE_COMPATIBILITY_VERSION) {
      throw new Error(
        `${filePath} has invalid legacy compatibility version ${String(parsed.version)}.`
      );
    }
    return;
  }

  const version = Number(parsed?.version ?? 0);
  if (!Number.isInteger(version) || version < 0) {
    throw new Error(`${filePath} has invalid legacy state version ${String(parsed?.version)}.`);
  }
  if (version > MAX_UNMARKED_SHARED_STATE_VERSION) {
    throw new Error(
      `${filePath} was written by a newer orchestrator (legacy state version ${version}, ` +
        `this build supports through ${MAX_UNMARKED_SHARED_STATE_VERSION}). Upgrade the plugin.`
    );
  }
}

function readJson(filePath, fallback, expectedSchema) {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`${filePath} is not valid JSON: ${error.message}`);
  }
  validateSharedStateSchema(filePath, parsed, expectedSchema);
  return parsed;
}

export function atomicWrite(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporary, contents, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, filePath);
  } finally {
    if (fs.existsSync(temporary)) {
      fs.unlinkSync(temporary);
    }
  }
  return filePath;
}

function writeJson(filePath, payload) {
  return atomicWrite(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}

const LOCK_TIMEOUT_MS = 5000;
const STALE_LOCK_MS = 30000;
const LOCK_WAIT_MS = 20;
const LOCK_SLEEP = new Int32Array(new SharedArrayBuffer(4));

export function withFileLock(filePath, operation) {
  const lockPath = `${filePath}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  while (true) {
    let descriptor;
    try {
      descriptor = fs.openSync(lockPath, "wx", 0o600);
    } catch (error) {
      if (error.code !== "EEXIST") {
        throw error;
      }

      try {
        const age = Date.now() - fs.statSync(lockPath).mtimeMs;
        if (age > STALE_LOCK_MS) {
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch (statError) {
        if (statError.code === "ENOENT") {
          continue;
        }
        throw statError;
      }

      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for state lock ${lockPath}.`);
      }
      Atomics.wait(LOCK_SLEEP, 0, 0, LOCK_WAIT_MS);
      continue;
    }

    try {
      return operation();
    } finally {
      fs.closeSync(descriptor);
      try {
        fs.unlinkSync(lockPath);
      } catch (error) {
        if (error.code !== "ENOENT") {
          throw error;
        }
      }
    }
  }
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
    atomicWrite(gitignorePath, LOCAL_GITIGNORE);
    created.push(gitignorePath);
  }

  if (!fs.existsSync(lanesFile(root))) {
    writeJson(lanesFile(root), sharedStateEnvelope(LANES_STATE_SCHEMA, { lanes: {} }));
    created.push(lanesFile(root));
  }

  if (!fs.existsSync(ledgerFile(root))) {
    atomicWrite(ledgerFile(root), defaultLedger());
    created.push(ledgerFile(root));
  }

  if (!fs.existsSync(threadsFile(root))) {
    writeJson(
      threadsFile(root),
      sharedStateEnvelope(LOCAL_STATE_SCHEMA, { threads: {}, snapshots: {} })
    );
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
  const state = readJson(
    lanesFile(cwd),
    sharedStateEnvelope(LANES_STATE_SCHEMA, { lanes: {} }),
    LANES_STATE_SCHEMA
  );
  return {
    version: SHARED_STATE_COMPATIBILITY_VERSION,
    schema: LANES_STATE_SCHEMA,
    schemaVersion: SHARED_STATE_SCHEMA_VERSION,
    lanes: state.lanes && typeof state.lanes === "object" ? state.lanes : {}
  };
}

export function saveLanesState(cwd, state) {
  return writeJson(
    lanesFile(cwd),
    sharedStateEnvelope(LANES_STATE_SCHEMA, { lanes: state.lanes ?? {} })
  );
}

export function updateLanesState(cwd, mutate) {
  const filePath = lanesFile(cwd);
  return withFileLock(filePath, () => {
    const state = loadLanesState(cwd);
    mutate(state);
    saveLanesState(cwd, state);
    return state;
  });
}

export function loadLocalState(cwd) {
  const state = readJson(
    threadsFile(cwd),
    sharedStateEnvelope(LOCAL_STATE_SCHEMA, { threads: {}, snapshots: {} }),
    LOCAL_STATE_SCHEMA
  );
  return {
    version: SHARED_STATE_COMPATIBILITY_VERSION,
    schema: LOCAL_STATE_SCHEMA,
    schemaVersion: SHARED_STATE_SCHEMA_VERSION,
    threads: state.threads && typeof state.threads === "object" ? state.threads : {},
    snapshots: state.snapshots && typeof state.snapshots === "object" ? state.snapshots : {}
  };
}

export function saveLocalState(cwd, state) {
  return writeJson(
    threadsFile(cwd),
    sharedStateEnvelope(LOCAL_STATE_SCHEMA, {
      threads: state.threads ?? {},
      snapshots: state.snapshots ?? {}
    })
  );
}

export function updateLocalState(cwd, mutate) {
  const filePath = threadsFile(cwd);
  return withFileLock(filePath, () => {
    const state = loadLocalState(cwd);
    mutate(state);
    saveLocalState(cwd, state);
    return state;
  });
}
