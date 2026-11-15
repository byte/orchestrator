import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function json(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"));
}

test("release descriptions do not name a GPT version", () => {
  const descriptions = [
    json("package.json").description,
    json("plugins/orchestrator/.claude-plugin/plugin.json").description,
    json(".claude-plugin/marketplace.json").metadata.description,
    json(".claude-plugin/marketplace.json").plugins[0].description,
    fs.readFileSync(path.join(root, "plugins", "orchestrator", "commands", "run.md"), "utf8")
      .match(/^description: (.*)$/m)[1],
    fs.readFileSync(
      path.join(root, "plugins", "orchestrator", "skills", "orchestrator-runtime", "SKILL.md"),
      "utf8"
    ).match(/^description: (.*)$/m)[1]
  ];
  for (const description of descriptions) {
    assert.doesNotMatch(description, /GPT|gpt-\d/i, description);
  }
});

test("release metadata stays synchronized", () => {
  const packageManifest = json("package.json");
  const pluginManifest = json("plugins/orchestrator/.claude-plugin/plugin.json");
  const marketplace = json(".claude-plugin/marketplace.json");
  assert.equal(packageManifest.version, "0.5.1");
  assert.equal(pluginManifest.version, packageManifest.version);
  assert.equal(marketplace.metadata.version, packageManifest.version);
  assert.equal(marketplace.plugins[0].version, packageManifest.version);
});

test("release documentation describes the supervisor pool and recovery surface", () => {
  const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
  assert.match(readme, /Claude Opus and Claude\s+Fable are both supported/);
  assert.match(readme, /Nothing in the plugin selects or switches the supervising model/);
  for (const slug of ["gpt-6-astra", "gpt-6.1-sol", "gpt-6.1-terra", "gpt-5.6-luna"]) {
    assert.match(readme, new RegExp(slug.replaceAll(".", "\\.")));
  }
  assert.match(readme, /Claude Opus 5\.5 and Claude Fable 5\.2/);
  assert.match(readme, /substitution is never silent/);
  assert.doesNotMatch(readme, /orchestrator:do|orchestrator:accept/);
  assert.match(readme, /account already authenticated in Codex CLI/);
  assert.match(readme, /Model and effort are automatic by default/);
  assert.match(readme, /rejects an unresolved task/);
  assert.match(readme, /only when you deliberately want to pin the entire pool/);
  assert.match(readme, /\/orchestrator:resume/);
  assert.match(readme, /finalizing/);
  assert.match(readme, /fake Codex\s+processes/);
});
