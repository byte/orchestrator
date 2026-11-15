import assert from "node:assert/strict";
import fs from "node:fs";
import { after, test } from "node:test";

import {
  LANES_STATE_SCHEMA,
  LOCAL_STATE_SCHEMA,
  SHARED_STATE_COMPATIBILITY_VERSION,
  SHARED_STATE_SCHEMA_VERSION,
  RUN_STATE_VERSION,
  initWorkspace,
  lanesFile,
  loadLanesState,
  loadLocalState,
  threadsFile,
  updateLanesState,
  updateLocalState
} from "../plugins/orchestrator/scripts/lib/state.mjs";
import { cleanup, makeRepo } from "./helpers.mjs";

const repos = [];

function repo() {
  const root = makeRepo();
  repos.push(root);
  initWorkspace(root);
  return root;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

after(() => {
  for (const root of repos) {
    cleanup(root);
  }
});

test("lane and thread files use schemas independent from run state", () => {
  const root = repo();
  const lanes = readJson(lanesFile(root));
  const local = readJson(threadsFile(root));

  assert.equal(RUN_STATE_VERSION, 6);
  assert.deepEqual(
    {
      version: lanes.version,
      schema: lanes.schema,
      schemaVersion: lanes.schemaVersion
    },
    {
      version: SHARED_STATE_COMPATIBILITY_VERSION,
      schema: LANES_STATE_SCHEMA,
      schemaVersion: SHARED_STATE_SCHEMA_VERSION
    }
  );
  assert.deepEqual(
    {
      version: local.version,
      schema: local.schema,
      schemaVersion: local.schemaVersion
    },
    {
      version: SHARED_STATE_COMPATIBILITY_VERSION,
      schema: LOCAL_STATE_SCHEMA,
      schemaVersion: SHARED_STATE_SCHEMA_VERSION
    }
  );
  assert.ok(lanes.version <= 4, "older builds must accept the lanes compatibility version");
  assert.ok(local.version <= 4, "older builds must accept the local compatibility version");
});

test("unmarked version 3, 4, and 5 shared state migrates without data loss", () => {
  for (const legacyVersion of [3, 4, 5]) {
    const root = repo();
    fs.writeFileSync(lanesFile(root), `${JSON.stringify({
      version: legacyVersion,
      lanes: { legacy: { description: `lanes-v${legacyVersion}` } }
    })}\n`);
    fs.writeFileSync(threadsFile(root), `${JSON.stringify({
      version: legacyVersion,
      threads: { legacy: { threadId: `thread-v${legacyVersion}` } },
      snapshots: { legacy: { head: `head-v${legacyVersion}` } }
    })}\n`);

    assert.equal(loadLanesState(root).lanes.legacy.description, `lanes-v${legacyVersion}`);
    assert.equal(loadLocalState(root).threads.legacy.threadId, `thread-v${legacyVersion}`);
    assert.equal(loadLocalState(root).snapshots.legacy.head, `head-v${legacyVersion}`);

    updateLanesState(root, (state) => {
      state.lanes.added = { description: "new lane" };
    });
    updateLocalState(root, (state) => {
      state.threads.added = { threadId: "thread-new" };
    });

    const migratedLanes = readJson(lanesFile(root));
    const migratedLocal = readJson(threadsFile(root));
    assert.equal(migratedLanes.version, SHARED_STATE_COMPATIBILITY_VERSION);
    assert.equal(migratedLanes.schema, LANES_STATE_SCHEMA);
    assert.equal(migratedLanes.schemaVersion, SHARED_STATE_SCHEMA_VERSION);
    assert.equal(migratedLanes.lanes.legacy.description, `lanes-v${legacyVersion}`);
    assert.equal(migratedLanes.lanes.added.description, "new lane");
    assert.equal(migratedLocal.version, SHARED_STATE_COMPATIBILITY_VERSION);
    assert.equal(migratedLocal.schema, LOCAL_STATE_SCHEMA);
    assert.equal(migratedLocal.schemaVersion, SHARED_STATE_SCHEMA_VERSION);
    assert.equal(migratedLocal.threads.legacy.threadId, `thread-v${legacyVersion}`);
    assert.equal(migratedLocal.threads.added.threadId, "thread-new");
    assert.equal(migratedLocal.snapshots.legacy.head, `head-v${legacyVersion}`);
  }
});

test("future, mismatched, and incomplete marked shared schemas fail closed", () => {
  const cases = [
    {
      file: lanesFile,
      load: loadLanesState,
      value: [],
      message: /must contain a state object/
    },
    {
      file: lanesFile,
      load: loadLanesState,
      value: {
        version: SHARED_STATE_COMPATIBILITY_VERSION,
        schema: LANES_STATE_SCHEMA,
        schemaVersion: SHARED_STATE_SCHEMA_VERSION + 1,
        lanes: {}
      },
      message: /schema version 2/
    },
    {
      file: threadsFile,
      load: loadLocalState,
      value: {
        version: SHARED_STATE_COMPATIBILITY_VERSION,
        schema: LANES_STATE_SCHEMA,
        schemaVersion: SHARED_STATE_SCHEMA_VERSION,
        threads: {},
        snapshots: {}
      },
      message: /expected orchestrator\.local-threads/
    },
    {
      file: lanesFile,
      load: loadLanesState,
      value: {
        version: SHARED_STATE_COMPATIBILITY_VERSION + 1,
        schema: LANES_STATE_SCHEMA,
        schemaVersion: SHARED_STATE_SCHEMA_VERSION,
        lanes: {}
      },
      message: /invalid legacy compatibility version/
    },
    {
      file: lanesFile,
      load: loadLanesState,
      value: {
        version: SHARED_STATE_COMPATIBILITY_VERSION,
        schema: LANES_STATE_SCHEMA,
        lanes: {}
      },
      message: /incomplete state schema marker/
    },
    {
      file: threadsFile,
      load: loadLocalState,
      value: { version: 6, threads: {}, snapshots: {} },
      message: /newer orchestrator/
    }
  ];

  for (const entry of cases) {
    const root = repo();
    fs.writeFileSync(entry.file(root), `${JSON.stringify(entry.value)}\n`);
    assert.throws(() => entry.load(root), entry.message);
  }
});
