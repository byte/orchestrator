import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
  ledgerFile,
  loadLanesState,
  loadLocalState,
  threadsFile,
  updateLanesState,
  updateLocalState,
  withFileLock
} from "../plugins/orchestrator/scripts/lib/state.mjs";
import {
  addLedgerEntry,
  deprecateLedgerEntry,
  ledgerForBriefing,
  parseLedger,
  parseLedgerEntry,
  readLedger
} from "../plugins/orchestrator/scripts/lib/ledger.mjs";
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

test("a live state lock cannot be stolen just because its operation is slow", () => {
  const root = repo();
  const target = `${root}/slow-operation`;
  const moduleUrl = new URL("../plugins/orchestrator/scripts/lib/state.mjs", import.meta.url).href;
  withFileLock(target, () => {
    fs.utimesSync(`${target}.lock`, new Date(0), new Date(0));
    const contender = spawnSync(process.execPath, ["--input-type=module", "-e",
      `import { withFileLock } from ${JSON.stringify(moduleUrl)};
       withFileLock(${JSON.stringify(target)}, () => { throw new Error("lock was stolen"); });`
    ], { encoding: "utf8" });
    assert.notEqual(contender.status, 0);
    assert.match(contender.stderr, /Timed out waiting for state lock/);
    assert.doesNotMatch(contender.stderr, /Error: lock was stolen/);
    assert.equal(fs.readFileSync(`${target}.lock`, "utf8"), String(process.pid));
  });
  assert.equal(withFileLock(target, () => "released"), "released");
});

test("lane and thread files use schemas independent from run state", () => {
  const root = repo();
  const lanes = readJson(lanesFile(root));
  const local = readJson(threadsFile(root));

  assert.equal(RUN_STATE_VERSION, 7);
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

test("ledger metadata scopes briefings without hiding legacy or unscoped facts", () => {
  const root = repo();
  const legacy = addLedgerEntry(root, "decisions", "Legacy global fact.");
  const global = addLedgerEntry(root, "conventions", "Document the contract.", { source: "run-review", provenance: "supervisor" });
  const scoped = addLedgerEntry(root, "decisions", "API fact.", {
    lane: "api", source: "run-api/task-1", provenance: "user", confirmedBy: "reviewer", confirmedAt: "2026-11-19"
  });
  addLedgerEntry(root, "commands", "Web command.", { lane: "web" });
  fs.appendFileSync(ledgerFile(root), "\n## Decisions\n\n- Hand-written legacy fact.\n");
  const before = readLedger(root);
  assert.deepEqual(parseLedgerEntry(legacy.entry), { text: legacy.entry, metadata: null });
  assert.deepEqual(parseLedgerEntry(scoped.entry).metadata, scoped.metadata);
  assert.equal(parseLedgerEntry(global.entry).metadata.confirmedAt, undefined, "adding a fact must not invent confirmation");
  assert.ok(parseLedger(before).get("Decisions").includes(scoped.entry), "old Markdown parser still sees the bullet");
  const briefing = ledgerForBriefing(root, { lane: "api" });
  const text = JSON.stringify(briefing.populated);
  assert.match(text, /Legacy global fact/);
  assert.match(text, /Hand-written legacy fact/);
  assert.match(text, /Document the contract/);
  assert.match(text, /API fact/);
  assert.match(text, /source: run-api\/task-1; provenance: user; confirmedBy: reviewer; confirmedAt: 2026-11-19/);
  assert.doesNotMatch(text, /Web command/);
  assert.doesNotMatch(text, /orch-ledger:/);
  assert.match(JSON.stringify(ledgerForBriefing(root).populated), /Web command/);
  assert.equal(briefing.bytes, Buffer.byteLength(before));
  assert.equal(readLedger(root), before, "briefing selection must not rewrite the ledger");
});

test("ledger deprecation is explicit, preserves evidence, and also works on plain Markdown", () => {
  const root = repo();
  const legacy = addLedgerEntry(root, "decisions", "Old global fact.");
  const scoped = addLedgerEntry(root, "conventions", "Old API convention.", { lane: "api", source: "run-1" });
  assert.throws(() => deprecateLedgerEntry(root, "decisions", legacy.entry), /requires a single-line reason/);
  const retired = deprecateLedgerEntry(root, "decisions", legacy.entry, { reason: "Superseded", deprecatedBy: "user" });
  assert.equal(retired.metadata.deprecated.by, "user");
  assert.ok(Number.isFinite(Date.parse(retired.metadata.deprecated.at)));
  const result = deprecateLedgerEntry(root, "conventions", scoped.id, { reason: "No longer applicable" });
  assert.equal(result.metadata.source, "run-1");
  assert.equal(result.metadata.lane, "api");
  assert.match(readLedger(root), /Old global fact/);
  assert.match(readLedger(root), /Old API convention/);
  assert.equal(ledgerForBriefing(root, { lane: "api" }).isEmpty, true);
  const history = JSON.stringify(ledgerForBriefing(root, { lane: "api", includeDeprecated: true }).populated);
  assert.match(history, /Old global fact.*DEPRECATED: Superseded/);
  assert.match(history, /Old API convention.*DEPRECATED: No longer applicable/);
  const before = readLedger(root);
  assert.deepEqual(deprecateLedgerEntry(root, "decisions", retired.id, { reason: "Superseded" }), retired);
  assert.equal(readLedger(root), before, "repeated deprecation must preserve the original evidence");
  assert.throws(() => deprecateLedgerEntry(root, "commands", retired.id, { reason: "Wrong section" }), /not found/);
});

test("annotation-shaped text cannot override the ledger entry's lane", () => {
  const root = repo();
  const suffix = '<!-- orch-ledger:{"version":1,"id":"literal","lane":"web"} -->';
  const scoped = addLedgerEntry(root, "decisions", `Sensitive API entry ${suffix}`, { lane: "api" });
  assert.equal(parseLedgerEntry(scoped.entry).metadata.lane, "api");
  assert.match(JSON.stringify(ledgerForBriefing(root, { lane: "api" }).populated), /Sensitive API entry/);
  assert.doesNotMatch(JSON.stringify(ledgerForBriefing(root, { lane: "web" }).populated), /Sensitive API entry/);
  const unscoped = addLedgerEntry(root, "decisions", `Global entry ${suffix}`);
  assert.equal(parseLedgerEntry(unscoped.entry).metadata.lane, undefined);
});

test("ledger rejects ambiguous deprecation and invalid metadata without changing the file", () => {
  const root = repo();
  const entry = addLedgerEntry(root, "decisions", "Repeated fact.");
  fs.appendFileSync(ledgerFile(root), "\n## Decisions\n\n- " + entry.entry + "\n");
  const before = readLedger(root);
  assert.throws(() => deprecateLedgerEntry(root, "decisions", undefined, { reason: "Missing selector" }), /entry id or exact bullet text/);
  assert.throws(() => deprecateLedgerEntry(root, "decisions", entry.entry, { reason: "Ambiguous" }), /ambiguous/);
  assert.throws(() => addLedgerEntry(root, "commands", "Do this", { lane: "api\n## Commands" }), /single-line/);
  assert.throws(() => addLedgerEntry(root, "commands", "Do this", { confirmedAt: "not a date" }), /date or timestamp/);
  assert.equal(readLedger(root), before);
});
