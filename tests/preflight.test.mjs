import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { preflight } from "../plugins/orchestrator/scripts/lib/preflight.mjs";
import { cleanup, git, makeRepo } from "./helpers.mjs";

function environment(t) {
  const root = makeRepo();
  const temporary = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "orch-preflight-"));
  const log = path.join(temporary, "calls");
  fs.writeFileSync(path.join(temporary, "codex"), `#!/bin/sh
case "$*" in
  --version)
    printf '%s\\n' '["--version"]' >> '${log}'
    printf '%s\\n' 'codex-cli 0.0.0-test';;
  'login status')
    printf '%s\\n' '["login","status"]' >> '${log}'
    printf '%s\\n' "\${ORCH_PREFLIGHT_TEST_AUTH:-Logged in using test credentials}" >&2;;
  *) exit 99;;
esac
`, { mode: 0o755 });
  const values = { PATH: `${temporary}${path.delimiter}${process.env.PATH}`, CLAUDE_CONFIG_DIR: temporary,
    ORCHESTRATOR_CODEX_COMPANION: path.join(temporary, "missing"), ORCH_PREFLIGHT_TEST_AUTH: "" };
  const saved = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    cleanup(root); cleanup(temporary);
  });
  return { root, log, temporary };
}

test("preflight discovers versions and executor limitations without a model call or checkout mutation", (t) => {
  const { root, log } = environment(t);
  const index = path.join(root, ".git", "index");
  const before = fs.readFileSync(index);
  const listing = fs.readdirSync(root);
  const report = preflight(root);
  assert.equal(report.ok, true, JSON.stringify(report.blocking));
  assert.equal(report.certification, "unknown");
  assert.equal(report.checks.find((check) => check.id === "node-version").detail, process.version);
  assert.match(report.checks.find((check) => check.id === "git-version").detail, /git version/);
  assert.equal(report.checks.find((check) => check.id === "git-operations").ok, true);
  assert.equal(report.executorCapabilities["codex-plugin"].companionFound, false);
  assert.ok(report.executorCapabilities["codex-plugin"].limitations.some((value) => /no --ignore-rules/.test(value)));
  assert.ok(report.executorCapabilities["codex-plugin"].limitations.some((value) => /until it ends/.test(value)));
  assert.ok(report.executorCapabilities.cli.limitations.some((value) => /fall back/.test(value)));
  assert.deepEqual(fs.readFileSync(log, "utf8").trim().split("\n").map(JSON.parse), [["--version"], ["login", "status"]]);
  assert.deepEqual(fs.readFileSync(index), before);
  assert.deepEqual(fs.readdirSync(root), listing);
});

test("pending operations and dirty checkouts warn without aborting or deleting locks", (t) => {
  const { root } = environment(t);
  const marker = path.join(root, ".git", "CHERRY_PICK_HEAD");
  fs.writeFileSync(marker, git(root, ["rev-parse", "HEAD"]));
  fs.writeFileSync(path.join(root, ".git", "index.lock"), "do not remove");
  fs.writeFileSync(path.join(root, "seed.txt"), "changed\n");
  const report = preflight(root);
  const operations = report.checks.find((check) => check.id === "git-operations");
  assert.equal(operations.ok, false);
  assert.equal(operations.warning, true);
  assert.match(operations.detail, /CHERRY_PICK_HEAD.*index.lock/);
  assert.equal(report.checks.find((check) => check.id === "clean_checkout").ok, false);
  assert.equal(report.ok, true, "warnings do not block read-only work");
  assert.equal(fs.readFileSync(path.join(root, ".git", "index.lock"), "utf8"), "do not remove");
  assert.equal(fs.existsSync(marker), true);
});

test("companion presence is discovery only and auth still requires positive evidence", (t) => {
  const { root, temporary } = environment(t);
  process.env.ORCHESTRATOR_CODEX_COMPANION = path.join(temporary, "companion.mjs");
  fs.writeFileSync(process.env.ORCHESTRATOR_CODEX_COMPANION, 'throw new Error("must not execute");');
  process.env.ORCH_PREFLIGHT_TEST_AUTH = "Not logged in";
  const report = preflight(root);
  assert.equal(report.executorCapabilities["codex-plugin"].companionFound, true);
  assert.equal(report.executorCapabilities["codex-plugin"].certification, "unknown");
  assert.equal(report.ok, false);
  assert.ok(report.blocking.some((check) => check.id === "codex-auth"));
});
