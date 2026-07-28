import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function json(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"));
}

test("release metadata stays synchronized", () => {
  const packageManifest = json("package.json");
  const pluginManifest = json("plugins/orchestrator/.claude-plugin/plugin.json");
  const marketplace = json(".claude-plugin/marketplace.json");
  assert.equal(packageManifest.version, "0.3.0");
  assert.equal(pluginManifest.version, packageManifest.version);
  assert.equal(marketplace.metadata.version, packageManifest.version);
  assert.equal(marketplace.plugins[0].version, packageManifest.version);
});

test("release documentation describes the supervisor pool and recovery surface", () => {
  const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
  assert.match(readme, /Claude Opus and Claude\s+Fable are both supported/);
  assert.match(readme, /Nothing in the plugin selects or switches the supervising model/);
  assert.match(readme, /gpt-5\.6-sol/);
  assert.match(readme, /gpt-5\.6-terra/);
  assert.match(readme, /gpt-5\.6-luna/);
  assert.match(readme, /account already authenticated in Codex CLI/);
  assert.match(readme, /\/orch:resume/);
  assert.match(readme, /finalizing/);
  assert.match(readme, /fake Codex\s+processes/);
});
